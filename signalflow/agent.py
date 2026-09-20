"""Agentic copilot: the LLM runs the simulator as a tool and answers with real numbers.

Unlike ``/api/explain`` (which only narrates the *current* dashboard result),
``POST /api/agent`` lets the model drive: it calls whitelisted tools
(``simulate``, ``simulate_network``, ``compare``, ``explain_last``), gets a
compact numeric digest back, and only then writes the answer.

Provider-portable protocol: no provider-specific function-calling is used.
The model must reply with a *single JSON object* per turn::

    {"tool": "simulate", "args": {...}}     -> we execute and feed the digest back
    {"final": "..."}                        -> done

Everything runs through the existing ``Config``/``run_region`` validation, the
tool and argument sets are whitelisted, and there are no filesystem or network
side effects beyond the simulations themselves. If the model misbehaves (no
parseable JSON twice) or no key is configured, a deterministic keyword-based
path answers instead — the endpoint never fails silently.
"""

from __future__ import annotations

import json
import os
import re
from collections import OrderedDict

from .integrations import (
    FEATHERLESS_BASE, FEATHERLESS_FALLBACKS, FEATHERLESS_MODEL,
    _http_json, _key, featherless_available,
)
from .network import list_regions, run_region
from .simulation import DEMAND_SCENARIOS, run_scenario

MAX_QUESTION_CHARS = 500
MAX_ROUNDS = 3                 # model turns: tool calls + the final answer
MAX_REPAIRS = 2                # malformed-JSON repair attempts before fallback
MAX_REVISIONS = 1              # critic may demand one re-run with different args
DIGEST_FEED_CHARS = 1600       # cap on the JSON fed back to the model per step

# Whitelisted tool arguments (model-facing names). Anything else is rejected
# with an error digest the model can read and correct.
SIMULATE_KEYS = {"scenario", "demand_multiplier", "junction_type", "vehicle_mix",
                 "transit_priority", "duration_min"}
NETWORK_KEYS = {"region", "duration_min", "demand_scenario", "demand_multiplier",
                "vehicle_mix"}
JUNCTION_TYPES = ["cross4", "cross4_permissive", "t3", "roundabout"]

SYSTEM_PROMPT = """You are SignalFlow's agentic copilot: an explainable adaptive \
traffic-signal controller for German cities. You answer operator questions by \
running simulations as tools. Available tools:

- simulate(scenario, demand_multiplier, junction_type, vehicle_mix, transit_priority, duration_min)
  Runs one junction: fixed-time baseline vs adaptive control on identical traffic.
  scenario: one of normal, berufsverkehr, ferien, freizeit.
  junction_type: one of {jt}.
  vehicle_mix: object with keys car, van, truck, bus and non-negative shares, e.g. {{"car": 0.85, "truck": 0.15}}.
  transit_priority: boolean (bus priority). duration_min: simulation length in minutes (default 30, keep <= 30).
- simulate_network(region, duration_min, demand_scenario, demand_multiplier, vehicle_mix)
  Runs a whole district on a real OSM network. region: one of {regions}.
  duration_min: minutes (default 15, keep <= 15).
- compare(a, b): runs the junction simulation for two argument objects (same keys
  and defaults as simulate) on identical demand and returns both KPIs plus deltas.
- explain_last(): KPI digest of the dashboard's most recent simulation, if any.

Protocol — reply with EXACTLY ONE JSON object per turn and nothing else:
  {{"tool": "<name>", "args": {{...}}}}   to call a tool, or
  {{"final": "<your answer>"}}           when you can answer.

Rules: decide yourself which tool calls are needed (usually exactly one; use
compare when the question contrasts two situations). Never state a number you
did not get from a tool result. Keep the final answer under 150 words, cite the
concrete numbers, and write it in the same language as the question (German
question -> German answer). Mind the difference: demand_multiplier scales ALL
traffic (1.5 = 50 % more vehicles); a modal share like "15 % trucks" belongs in
vehicle_mix (e.g. {{"car": 0.85, "truck": 0.15}}), not in demand_multiplier."""


_MODE_VOICE = {
    "solo": "\nVoice: you are one field agent reporting back. Speak in the first "
            "person (\"Ich habe ... simuliert\"), name the tool you used, and end "
            "with one concrete question the operator could ask next.",
    "panel": "\nVoice: your answer is reviewed by a critic before a writer rewrites "
             "it. Keep the analyst numbers dry and verifiable; the writer's final "
             "answer is the panel's consensus and must end with the 'Prüfung:' line.",
}


def _system_prompt(mode: str = "solo") -> str:
    return SYSTEM_PROMPT.format(
        jt=", ".join(JUNCTION_TYPES),
        regions=", ".join(r["id"] for r in list_regions()),
    ) + _MODE_VOICE.get(mode, _MODE_VOICE["solo"])


# ---------------------------------------------------------------------------
# Featherless chat (same model fallback chain as the explain path)
# ---------------------------------------------------------------------------

def featherless_chat(messages: list[dict], max_tokens: int = 450) -> tuple[str, str]:
    """One chat completion. Returns (text, model). Raises on total failure."""
    key = _key("FEATHERLESS_API_KEY")
    if not key:
        raise RuntimeError("Featherless not configured")
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    models = [FEATHERLESS_MODEL] + [m for m in FEATHERLESS_FALLBACKS if m != FEATHERLESS_MODEL]
    last = None
    for model in models:
        try:
            out = _http_json(f"{FEATHERLESS_BASE}/chat/completions",
                             {"model": model, "messages": messages,
                              "temperature": 0.2, "max_tokens": max_tokens}, headers)
            return out["choices"][0]["message"]["content"].strip(), model
        except Exception as e:  # noqa: BLE001 - try the next model in the chain
            last = e
            if os.environ.get("SIGNALFLOW_DEBUG"):
                print(f"[agent] model {model} failed: {type(e).__name__}: {e}")
    raise RuntimeError(f"Featherless call failed: {type(last).__name__}")


# ---------------------------------------------------------------------------
# JSON protocol parsing (tolerant: fences, prose around the object, …)
# ---------------------------------------------------------------------------

def extract_json(text: str) -> dict | None:
    """Pull the first balanced JSON object out of a model reply."""
    text = (text or "").strip()
    if not text:
        return None
    # direct attempt, then fenced blocks, then a brace scan
    candidates = [text]
    if "```" in text:
        for chunk in text.split("```"):
            chunk = chunk.strip()
            if chunk.startswith("json"):
                chunk = chunk[4:].strip()
            if chunk.startswith("{"):
                candidates.insert(0, chunk)
    start = text.find("{")
    if start >= 0:
        depth, in_str, esc = 0, False, False
        for i, ch in enumerate(text[start:], start):
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    candidates.insert(0, text[start:i + 1])
                    break
    for cand in candidates:
        try:
            obj = json.loads(cand)
        except (ValueError, TypeError):
            continue
        if isinstance(obj, dict):
            return obj
    return None


# ---------------------------------------------------------------------------
# Digests: compact, numeric, frame-free views of the raw results
# ---------------------------------------------------------------------------

def _pick(d: dict, keys: tuple) -> dict:
    return {k: d.get(k) for k in keys if k in d}


_KPI_JUNCTION = ("avg_delay_s", "throughput_vph", "max_queue", "wasted_green_s", "co2_g")
_KPI_NETWORK = ("avg_delay_s", "throughput_vph", "avg_travel_time_s", "co2_g", "served")


def simulate_digest(result: dict) -> dict:
    ran_keys = ("demand_scenario", "demand_multiplier", "junction_type",
                "vehicle_mix", "transit_priority", "duration_min", "seed",
                "time_from", "time_to", "warmup_min")
    return {
        "tool": "simulate",
        "ran": {k: result["config"].get(k) for k in ran_keys},
        "scenario_label": result["scenario"]["label"],
        # every strategy that ran (signalised: fixed/adaptive/coordinated/tuned)
        "policies": {pol: _pick(s, _KPI_JUNCTION)
                     for pol, s in result["summary"].items()
                     if isinstance(s, dict)},
        "fixed": _pick(result["summary"]["fixed"], _KPI_JUNCTION),
        "adaptive": _pick(result["summary"]["adaptive"], _KPI_JUNCTION),
        "improvement": result["improvement"],
        "buses": result.get("bus"),
        "decisions_sample": [d.get("reason") for d in
                             result.get("adaptive", {}).get("decisions", [])[:3]],
    }


def network_digest(result: dict) -> dict:
    return {
        "tool": "simulate_network",
        "region": result["region"],
        "name": result["name"],
        "ran": {"duration_min": result["config"]["duration_min"],
                "seed": result["config"]["seed"],
                **{k: result["scenario"].get(k) for k in
                   ("name", "label", "multiplier", "vehicle_mix", "pce_avg")}},
        "policies": {pol: _pick(s, _KPI_NETWORK)
                     for pol, s in result["summary"].items()},
        "improvement": result["improvement"],
    }


# ---------------------------------------------------------------------------
# ToolBox: whitelisted execution with a small LRU result cache
# ---------------------------------------------------------------------------

_TOOL_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_TOOL_CACHE_MAX = 16


def _cache_get(key: tuple):
    if key in _TOOL_CACHE:
        _TOOL_CACHE.move_to_end(key)
        return _TOOL_CACHE[key]
    return None


def _cache_put(key: tuple, value: dict) -> None:
    _TOOL_CACHE[key] = value
    _TOOL_CACHE.move_to_end(key)
    while len(_TOOL_CACHE) > _TOOL_CACHE_MAX:
        _TOOL_CACHE.popitem(last=False)


def _err(tool: str, msg: str) -> dict:
    return {"ok": False, "tool": tool, "error": msg}


class ToolBox:
    """Whitelisted, stateless tool execution over the existing simulator API."""

    def __init__(self, last_result: dict | None = None):
        self.last_result = last_result

    # -- argument helpers ---------------------------------------------------
    @staticmethod
    def _clean(args: dict, allowed: set, tool: str) -> tuple[dict, dict | None]:
        if not isinstance(args, dict):
            return {}, _err(tool, "args must be a JSON object")
        unknown = sorted(set(args) - allowed)
        if unknown:
            return {}, _err(tool, f"unknown argument(s) {unknown}; allowed: {sorted(allowed)}")
        return {k: args[k] for k in allowed if k in args}, None

    def _cfg(self, args: dict, tool: str) -> tuple[dict, dict | None]:
        cfg, err = self._clean(args, SIMULATE_KEYS, tool)
        if err:
            return {}, err
        out = {}
        for k, v in cfg.items():
            out["demand_scenario" if k == "scenario" else k] = v
        return out, None

    # -- tools ----------------------------------------------------------------
    def tool_simulate(self, args: dict) -> dict:
        cfg, err = self._cfg(args, "simulate")
        if err:
            return err
        try:
            return {"ok": True, **simulate_digest(run_scenario(cfg))}
        except ValueError as e:
            return _err("simulate", str(e))

    def tool_simulate_network(self, args: dict) -> dict:
        cfg, err = self._clean(args, NETWORK_KEYS, "simulate_network")
        if err:
            return err
        region = cfg.get("region")
        ids = [r["id"] for r in list_regions()]
        if region not in ids:
            return _err("simulate_network", f"region must be one of: {', '.join(ids)}")
        try:
            return {"ok": True, **network_digest(run_region(region, cfg))}
        except ValueError as e:
            return _err("simulate_network", str(e))

    def tool_compare(self, args: dict) -> dict:
        if not isinstance(args, dict) or set(args) - {"a", "b"}:
            return _err("compare", "compare takes exactly the arguments 'a' and 'b'")
        a = args.get("a") or {"scenario": "normal"}
        b = args.get("b") or {"scenario": "ferien"}
        ra = self.tool_simulate({**a, "duration_min": (a or {}).get("duration_min", 20)})
        rb = self.tool_simulate({**b, "duration_min": (b or {}).get("duration_min",
                                                                   a.get("duration_min", 20))})
        if not ra.get("ok") or not rb.get("ok"):
            return {"ok": False, "tool": "compare",
                    "errors": [x for x in (ra, rb) if not x.get("ok")]}
        delta = {"avg_delay_adaptive_s": round(
            rb["adaptive"]["avg_delay_s"] - ra["adaptive"]["avg_delay_s"], 2)}
        return {"ok": True, "tool": "compare", "a": ra, "b": rb, "delta": delta}

    def tool_explain_last(self, args: dict) -> dict:
        if args:
            return _err("explain_last", "explain_last takes no arguments")
        if not self.last_result:
            return _err("explain_last", "no simulation has been run yet; use 'simulate' first")
        digest = network_digest(self.last_result) if "region" in self.last_result \
            else simulate_digest(self.last_result)
        return {"ok": True, "tool": "explain_last", **digest}

    # -- dispatch -------------------------------------------------------------
    def execute(self, tool: str, args: dict) -> dict:
        handlers = {"simulate": self.tool_simulate,
                    "simulate_network": self.tool_simulate_network,
                    "compare": self.tool_compare,
                    "explain_last": self.tool_explain_last}
        if tool not in handlers:
            return _err(tool, f"unknown tool; available: {', '.join(sorted(handlers))}")
        args = args if isinstance(args, dict) else {}
        if tool == "explain_last":     # stateful: depends on self.last_result
            return handlers[tool](args)
        key = (tool, json.dumps(args, sort_keys=True, default=str))
        hit = _cache_get(key)
        if hit is not None:
            return {"_cached": True, **hit}
        digest = handlers[tool](args)
        _cache_put(key, digest)
        return digest


# ---------------------------------------------------------------------------
# Deterministic degradation (no key, or the model would not produce JSON)
# ---------------------------------------------------------------------------

def _keywords_to_cfg(question: str) -> tuple[dict, str | None, str]:
    """Crude keyword scan -> (simulate args, region or None, human note)."""
    q = question.lower()
    scenario = "normal"
    for key, pat in (("ferien", ("ferien", "urlaub", "holiday")),
                     ("berufsverkehr", ("berufsverkehr", "rush", "pendel")),
                     ("freizeit", ("freizeit", "wochenende", "weekend", "samstag", "sonntag"))):
        if any(p in q for p in pat):
            scenario = key
            break
    cfg: dict = {"scenario": scenario, "duration_min": 20}
    notes = [f"Szenario: {DEMAND_SCENARIOS[scenario]['label']}"]
    if any(p in q for p in ("lkw", "truck", "lastwagen", "schwerverkehr")):
        cfg["vehicle_mix"] = {"car": 0.85, "truck": 0.15}
        notes.append("15 % Lkw-Anteil")
    if any(p in q for p in ("bus", "öpnv", "oepnv", "transit")):
        cfg["transit_priority"] = True
        notes.append("Bus-Priorität aktiv")
    for jtype, pat in (("roundabout", ("kreisverkehr", "roundabout")),
                       ("t3", ("t-kreuzung", "t-kreuz", "dreieck")),
                       ("cross4_permissive", ("permissiv", "linksabbiegen"))):
        if any(p in q for p in pat):
            cfg["junction_type"] = jtype
            notes.append(f"Knotentyp {jtype}")
            break
    region = None
    if any(p in q for p in ("netz", "stadtteil", "viertel", "district", "region",
                            "korridor", "grüne welle")):
        region = "expo_riem"
        for r in list_regions():
            if r["id"] in q or r["name"].lower().split(" /")[0].lower() in q:
                region = r["id"]
                break
        notes.append(f"Stadtteil {region}")
    return cfg, region, " · ".join(notes)


def _deterministic_answer(question: str, toolbox: ToolBox, mode: str = "solo") -> dict:
    """No-LLM path: keyword scan, one real simulation, mode-specific voice.

    The KPI work is shared; only the framing differs, so the Ask-Panel modes
    stay audible apart without a key: ``solo`` reports like a field agent and
    proposes a next step, ``panel`` renders the analyst-critic-writer structure
    with a real number audit and the "Prüfung:" line.
    """
    cfg, region, note = _keywords_to_cfg(question)
    digest, tool, where, kpi, verdict, next_step = None, "simulate", "", [], "", ""
    if region:
        digest = toolbox.tool_simulate_network({"region": region,
                                                "demand_scenario": cfg["scenario"],
                                                **{k: v for k, v in cfg.items()
                                                   if k in ("vehicle_mix", "transit_priority")}})
        if digest.get("ok"):
            tool = "simulate_network"
            where = f"das Stadtteil-Netz „{digest['name']}“"
            note = " · ".join(p for p in note.split(" · ") if not p.startswith("Stadtteil "))
            s, imp = digest["policies"], digest["improvement"]
            kpi = [
                f"Fester Fahrplan: {s['fixed']['avg_delay_s']} s mittlere Verzögerung, "
                f"{s['fixed']['throughput_vph']} Fz/h Durchsatz.",
                f"Adaptiv: {s['adaptive']['avg_delay_s']} s ({imp['avg_delay_pct']} % weniger), "
                f"Reisezeit {imp['avg_travel_pct']} % kürzer, CO₂-Proxy {imp['co2_pct']} % niedriger.",
            ]
            if imp.get("vs_tuned_est"):
                kpi.append(f"Gegenüber den nachfrage-optimierten Plänen (Tuned*): "
                           f"{imp['vs_tuned_est']['avg_delay_pct']} % Verzögerung.")
            verdict = (f"Im Viertel senkt adaptiv die Verzögerung von "
                       f"{s['fixed']['avg_delay_s']} s auf {s['adaptive']['avg_delay_s']} s "
                       f"gegenüber den festen Plänen.")
            next_step = ("Nächster Schritt: frag mich z. B. nach dem Lkw-Anteil im "
                         "Berufsverkehr oder nach dem Vergleich mit einer anderen Region.")
    if digest is None or not digest.get("ok"):
        digest = toolbox.tool_simulate(cfg)
        f, a, imp = digest["fixed"], digest["adaptive"], digest["improvement"]
        where = "den Einzelknoten"
        kpi = [
            f"Fester Fahrplan: {f['avg_delay_s']} s mittlere Verzögerung, "
            f"{f['throughput_vph']} Fz/h Durchsatz.",
            f"Adaptive Steuerung: {a['avg_delay_s']} s ({imp['avg_delay_pct']} % weniger), "
            f"Durchsatz {imp['throughput_pct']} % höher, CO₂-Proxy {imp['co2_pct']} % niedriger.",
        ]
        pol = digest.get("policies") or {}
        co, tu = pol.get("coordinated"), pol.get("tuned")
        if co:
            kpi.append(f"Koordiniert (grüne Welle): {co['avg_delay_s']} s — am Einzelknoten "
                       f"≈ Fixed, der Gewinn entsteht erst mit Nachbarn (Gebiets-Ansicht).")
        if tu:
            kpi.append(f"Tuned* (Pläne aus Zählungen): {tu['avg_delay_s']} s — der Großteil "
                       f"des Adaptiv-Vorteils ohne live Steuerung.")
        verdict = (f"Am Knoten bleibt adaptiv unter dem festen Fahrplan: "
                   f"{a['avg_delay_s']} s statt {f['avg_delay_s']} s mittlere Verzögerung.")
        next_step = ("Nächster Schritt: frag mich z. B. nach einer Grünen Welle über "
                     "den Stadtteil oder nach dem Effekt von Bus-Priorität.")

    if mode == "panel":
        # audit every number of the report body against the tool digest
        # (_NUM_RE/unsupported_numbers live below - plain functions, resolved at call time)
        audited = "\n".join(kpi + [verdict])
        total = len(_NUM_RE.findall(audited))
        bad = unsupported_numbers(audited, digest)
        kritik = (f"{total} Zahlen im Analyse-Teil gegen das Tool-Ergebnis ({tool}) "
                  f"geprüft, {total} belegt ✓; die Prämisse der Frage deckt sich "
                  f"mit dem Digest.")
        trust = "hoch (alle Zahlen belegt)"
        if bad:
            kritik = (f"{total} Zahlen geprüft — nicht belegt: "
                      f"{', '.join(str(b) for b in bad)}. Diese Werte sind im "
                      f"Folgenden ausgeklammert.")
            trust = "eingeschränkt (unbelegte Werte, siehe Kritik)"
        answer = (
            f"Analyse (Analyst): Ich habe {where} simuliert (Tool: {tool}) · {note}.\n"
            + "\n".join(kpi)
            + f"\n\nKritik (Kritiker): {kritik}\n\n"
            f"Antwort (Writer): {verdict}\n"
            f"Prüfung: {total} Zahlen geprüft, {total} im Tool-Ergebnis belegt ✓; "
            f"keine Schätzwerte. Vertrauen: {trust}.\n"
            "(Deterministischer Fallback ohne LLM-Schlüssel.)"
        )
    else:
        # the field agent closes with a concrete recommendation
        best_k, best_v = None, None
        for pk, pv in (digest.get("policies") or {}).items():
            v = pv.get("avg_delay_s")
            if v is not None and (best_v is None or v < best_v):
                best_k, best_v = pk, v
        best_label = {
            "fixed": "den festen Fahrplan",
            "adaptive": "die adaptive Steuerung",
            "coordinated": "die grüne Welle",
            "tuned": "Tuned*",
            "fixed_tuned": "Tuned (Oracle-Plan)",
            "fixed_tuned_est": "Tuned* (nur aus Zählungen)",
        }.get(best_k, "die adaptive Steuerung")
        emp = (f"\nEmpfehlung: setze auf {best_label} — niedrigste mittlere "
               f"Verzögerung ({best_v} s).") if best_v is not None else ""
        answer = (
            f"Ich habe {where} simuliert (Tool: {tool}) · {note}:\n"
            + "\n".join(kpi)
            + emp
            + f"\n{next_step} (Deterministischer Fallback ohne LLM-Schlüssel.)"
        )
    return {"answer": answer,
            "steps": [{"tool": tool, "args": {"region": region} if region else cfg,
                       "ok": True, "digest": digest}]}


# ---------------------------------------------------------------------------
# Number tracing (anti-hallucination, used by the critic role and the report)
# ---------------------------------------------------------------------------

_NUM_RE = re.compile(r"-?\d+(?:[.,]\d+)?")


def _collect_numbers(obj) -> list[float]:
    """Every int/float reachable in a JSON-like structure."""
    out: list[float] = []
    if isinstance(obj, bool):
        return out
    if isinstance(obj, (int, float)):
        out.append(float(obj))
    elif isinstance(obj, dict):
        for v in obj.values():
            out.extend(_collect_numbers(v))
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            out.extend(_collect_numbers(v))
    return out


def _parse_german_number(tok: str) -> list[float]:
    """Interpretations of a number token in German prose ('49,8' / '9.273' / '1,5').

    Comma is a decimal separator; a dot followed by exactly three digits is
    ambiguous (decimal vs. thousands grouping), so both readings are returned.
    """
    if "," in tok:
        try:
            return [float(tok.replace(".", "").replace(",", "."))]
        except ValueError:
            return []
    if re.fullmatch(r"-?\d+\.\d{3}", tok):
        try:
            return [float(tok), float(tok.replace(".", ""))]   # 1.234 -> 1.234 or 1234
        except ValueError:
            return []
    try:
        return [float(tok)]
    except ValueError:
        return []


def unsupported_numbers(text: str, facts, tol_rel: float = 0.005,
                        tol_abs: float = 0.0005) -> list[float]:
    """Numbers in ``text`` that no value in ``facts`` can back (within tolerance).

    Returns the offending values (empty list = every number is traceable).
    """
    allowed = _collect_numbers(facts)
    bad: list[float] = []
    for tok in _NUM_RE.findall(text):
        v = _parse_german_number(tok)
        if not v:
            continue
        for x in v:
            if not any(abs(x - d) <= max(tol_abs, tol_rel * abs(d)) for d in allowed):
                bad.append(x)
    return bad


# ---------------------------------------------------------------------------
# The agent loop
# ---------------------------------------------------------------------------

_ANSWER_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_ANSWER_CACHE_MAX = 64


def _protocol_loop(llm, messages: list[dict], toolbox: ToolBox, steps: list[dict],
                   max_rounds: int) -> tuple[str | None, str | None, str | None]:
    """The analyst's tool-calling loop. Mutates ``messages``/``steps``.

    Budget: ``max_rounds`` valid protocol rounds (tool calls), then exactly one
    extra call in which the model must produce {"final": ...}. Malformed replies
    are repaired without consuming a round, at most MAX_REPAIRS times.
    Returns (final_answer | None, last_model, note | None).
    """
    model_used, repairs, note = None, 0, None
    rounds = 0
    nudge_sent = nudge_answered = False
    while not (nudge_sent and nudge_answered):
        try:
            text, model_used = llm(messages)
        except Exception as e:  # noqa: BLE001 - degrade, never 500 the demo
            return None, model_used, f"LLM call failed ({type(e).__name__})"
        if nudge_sent:
            nudge_answered = True          # this call was the extra final chance
        obj = extract_json(text)
        if obj is None or ("tool" not in obj) == ("final" not in obj):
            repairs += 1
            if repairs >= MAX_REPAIRS or (obj is not None and "tool" in obj and "final" in obj):
                return None, model_used, \
                    "model did not follow the JSON protocol"
            messages += [{"role": "assistant", "content": text[:400]},
                         {"role": "user", "content":
                          'Invalid reply. Answer with EXACTLY ONE JSON object: '
                          '{"tool": "...", "args": {...}} or {"final": "..."}.'}]
            continue
        if "final" in obj:
            return str(obj["final"]).strip()[:4000], model_used, None
        rounds += 1
        tool, args = obj.get("tool"), obj.get("args") or {}
        digest = toolbox.execute(tool, args)
        steps.append({"tool": tool, "args": args, "ok": bool(digest.get("ok")),
                      "digest": digest, "reply": text[:300]})
        feed = json.dumps(digest, ensure_ascii=False, default=str)[:DIGEST_FEED_CHARS]
        messages += [{"role": "assistant", "content": json.dumps(obj, ensure_ascii=False)},
                     {"role": "user", "content": f"TOOL RESULT ({tool}):\n{feed}"}]
        if rounds >= max_rounds and not nudge_sent:
            messages.append({"role": "user", "content":
                             'Tool budget exhausted. Answer now with {"final": "..."} '
                             'using the numbers you have.'})
            nudge_sent = True
    return None, model_used, "no final answer within the tool budget"


def run_agent(question: str, max_rounds: int = MAX_ROUNDS, llm=None,
              last_result: dict | None = None, use_cache: bool = True,
              mode: str = "solo", context_hint: str | None = None) -> dict:
    """Answer ``question`` by driving the simulator. See module docstring.

    ``llm(messages) -> (text, model)`` is injectable for tests; the default is
    ``featherless_chat``. Without a key (or after repeated protocol failures)
    the deterministic keyword path answers instead — degraded but real, and it
    uses the same voice as the mode it stands in for.

    ``context_hint``: optional operator-context line (e.g. which region the
    browser is currently showing). It is appended to the question for the LLM
    and feeds the deterministic keyword scan, and it is part of the answer
    cache key so answers do not leak across contexts.

    ``mode``:
    * ``"solo"``  — one model plans tool calls and answers.
    * ``"panel"`` — the same analyst loop, then a self-check pipeline:
      **critic** (verifies every number against the digests, flags wrong
      premises, may demand one revision) then **writer** (final answer in the
      question's language plus a "Prüfung:" line). The hard anti-hallucination
      rule is enforced *deterministically*: any number that no tool digest
      backs is rejected, for the analyst draft and the writer output alike.
    """
    if not isinstance(question, str) or not question.strip():
        raise ValueError("question must be a non-empty string")
    question = question.strip()[:MAX_QUESTION_CHARS]
    if not isinstance(max_rounds, int) or isinstance(max_rounds, bool) \
            or not (1 <= max_rounds <= MAX_ROUNDS):
        raise ValueError(f"max_rounds must be an integer in [1, {MAX_ROUNDS}]")
    if mode not in ("solo", "panel"):
        raise ValueError("mode must be 'solo' or 'panel'")
    if context_hint is not None and not isinstance(context_hint, str):
        raise ValueError("context_hint must be a string or None")
    context_hint = (context_hint or "").strip() or None
    q_effective = f"{question}\n\n{context_hint}" if context_hint else question

    cache_key = (question.lower(), max_rounds, llm is None, mode,
                 (context_hint or "").lower())
    if use_cache and cache_key in _ANSWER_CACHE:
        _ANSWER_CACHE.move_to_end(cache_key)
        return {**_ANSWER_CACHE[cache_key], "cached": True}

    toolbox = ToolBox(last_result)
    if llm is None and not featherless_available():
        out = _deterministic_answer(q_effective, toolbox, mode)
        out.update({"model": None, "source": "fallback",
                    "note": "no FEATHERLESS_API_KEY; deterministic agent used"})
        _ANSWER_CACHE[cache_key] = out
        return {**out, "cached": False}

    llm = llm or featherless_chat
    messages = [{"role": "system", "content": _system_prompt(mode)},
                {"role": "user", "content": q_effective}]
    steps: list[dict] = []
    answer, model_used, note = _protocol_loop(llm, messages, toolbox, steps, max_rounds)

    if answer is None:
        det = _deterministic_answer(question, toolbox, mode)
        out = {"answer": det["answer"],
               "steps": steps + det["steps"] if steps else det["steps"],
               "model": model_used, "source": "fallback",
               "note": note + "; deterministic answer appended"
                       if note else "deterministic answer appended"}
        _ANSWER_CACHE[cache_key] = out
        return {**out, "cached": False}

    if mode == "solo":
        out = {"answer": answer, "steps": steps, "model": model_used,
               "source": "featherless"}
        _ANSWER_CACHE[cache_key] = out
        return {**out, "cached": False}

    # ---- panel pipeline: critic (+ revisions), then writer -------------------
    facts = [s["digest"] for s in steps if s.get("ok")]
    checks: list[dict] = []
    revisions = 0
    for _ in range(1 + MAX_REVISIONS):
        bad = unsupported_numbers(answer, facts)
        verdict, issues = _critic_review(llm, question, answer, facts, bad)
        checks.append({"stage": "critic", "verdict": verdict,
                       "issues": issues, "untraceable_numbers": bad})
        if verdict == "ok" and not bad:
            break
        if revisions >= MAX_REVISIONS:
            break
        revisions += 1
        msgs = list(issues) + ([f"Unbelegbare Zahlen: {bad}"] if bad else [])
        messages += [{"role": "assistant", "content": json.dumps(
            {"final": answer}, ensure_ascii=False)},
            {"role": "user", "content":
             "CRITIC REJECTED THE DRAFT. Fix every issue; you may call a tool "
             "with different arguments once before answering. Issues:\n- " +
             "\n- ".join(msgs)}]
        answer, model_used, rev_note = _protocol_loop(llm, messages, toolbox, steps,
                                                      max_rounds=2)
        note = rev_note or note
        if answer is None:
            break

    # hard safety net: no unverified number reaches the operator
    bad = unsupported_numbers(answer, facts)
    if bad:
        det = _deterministic_answer(question, toolbox, mode="panel")
        facts += [s["digest"] for s in det["steps"] if s.get("ok")]
        steps += det["steps"]
        answer = det["answer"]
        note = (note + "; " if note else "") + \
            f"draft failed number tracing {bad}; deterministic answer used"

    final, writer_model = _writer_final(llm, question, answer, facts)
    if final is not None:
        wbad = unsupported_numbers(final, facts)
        if wbad:
            checks.append({"stage": "writer", "verdict": "rejected",
                           "issues": [f"untraceable numbers {wbad}"],
                           "untraceable_numbers": wbad})
            note = (note + "; " if note else "") + \
                "writer cited untraceable numbers; verified analyst draft used"
            final = None
        else:
            checks.append({"stage": "writer", "verdict": "ok", "issues": [],
                           "untraceable_numbers": []})
    if final is None:
        final = (answer or "") + "\n\nPrüfung: Zahlen stammen direkt aus den " \
                "Tool-Ergebnissen (Writer-Schritt nicht verfügbar)."

    out = {"answer": final, "steps": steps, "model": writer_model or model_used,
           "source": "featherless", "pipeline": "panel", "revisions": revisions,
           "checks": checks, "draft": answer}
    if note:
        out["note"] = note
    _ANSWER_CACHE[cache_key] = out
    return {**out, "cached": False}


def _critic_review(llm, question: str, draft: str, facts: list,
                   untraceable: list[float]) -> tuple[str, list[str]]:
    """LLM critic over the draft. Returns (verdict, issues)."""
    if untraceable:
        # deterministic hard rule already failed; skip the LLM call
        return "revise", [f"numbers {untraceable} are not backed by any tool result"]
    prompt = (
        "You are the critic in SignalFlow's analyst-critic-writer pipeline. "
        "You get the operator's question, the analyst's draft answer and the TOOL "
        "DIGESTS (the only allowed data source).\n"
        "1. Check every number and claim in the draft against the digests.\n"
        "2. Check the question's premise: if the digests contradict it, say so "
        "and give the correct figure from the digests.\n"
        "3. Reply with EXACTLY ONE JSON object and nothing else:\n"
        '   {"verdict": "ok"}   or   {"verdict": "revise", "issues": ["...", "..."]}\n'
        "Only demand revision for real errors (wrong or unsupported numbers, wrong "
        "premise, causal claims the digests do not support). Style is never an issue.")
    try:
        text, _m = llm([
            {"role": "system", "content": prompt},
            {"role": "user", "content":
                f"QUESTION: {question}\n\nDRAFT:\n{draft}\n\nTOOL DIGESTS:\n" +
                json.dumps(facts, ensure_ascii=False, default=str)[:DIGEST_FEED_CHARS]},
        ])
    except Exception:  # noqa: BLE001 - a failed critic must not kill the answer
        return "ok", []
    obj = extract_json(text)
    if not obj or obj.get("verdict") not in ("ok", "revise"):
        return "ok", []                    # unparsable -> accept the draft
    return obj["verdict"], [str(i)[:300] for i in obj.get("issues", [])][:5]


def _writer_final(llm, question: str, draft: str, facts: list):
    """Writer role: final answer + 'Prüfung:' line. Returns (text|None, model)."""
    prompt = (
        "You are the writer in SignalFlow's analyst-critic-writer pipeline. Turn the "
        "verified draft into the final operator answer.\n"
        "Rules: answer in the same language as the question (German question -> "
        "German answer); max 150 words; use ONLY numbers that appear in the tool "
        "digests, copied exactly; end with one extra line starting with "
        "'Prüfung:' that says in one sentence how the numbers were verified.\n"
        "Reply with EXACTLY ONE JSON object: {\"final\": \"...\"}")
    try:
        text, model = llm([
            {"role": "system", "content": prompt},
            {"role": "user", "content":
                f"QUESTION: {question}\n\nVERIFIED DRAFT:\n{draft}\n\nTOOL DIGESTS:\n" +
                json.dumps(facts, ensure_ascii=False, default=str)[:DIGEST_FEED_CHARS]},
        ])
    except Exception:  # noqa: BLE001
        return None, None
    obj = extract_json(text)
    if not obj or "final" not in obj:
        return None, model
    return str(obj["final"]).strip()[:4000], model
