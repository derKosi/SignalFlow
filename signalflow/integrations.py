"""External integrations for SignalFlow.

Two optional, sponsor-relevant services are wired in — both degrade gracefully so
the demo always runs offline:

* **Featherless.ai**  (OpenAI-compatible chat completions) powers the
  "Ask SignalFlow" natural-language explainer for controller decisions.
* **ElevenLabs**      (text-to-speech) voices the explanation out loud.

Keys are read from the process environment or a local ``.env`` file. Nothing is
hard-coded and no key ever leaves the server (the browser only sees text/audio).
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"

FEATHERLESS_BASE = os.environ.get("FEATHERLESS_BASE", "https://api.featherless.ai/v1")
FEATHERLESS_MODEL = os.environ.get("FEATHERLESS_MODEL", "Qwen/Qwen2.5-7B-Instruct")
# tried in order if the configured model is unavailable on the account/plan
FEATHERLESS_FALLBACKS = [
    "Qwen/Qwen2.5-7B-Instruct",
    "Qwen/Qwen2.5-14B-Instruct",
    "mistralai/Mistral-7B-Instruct-v0.3",   # note: Llama/Gemma are gated (HF OAuth)
]
ELEVENLABS_BASE = os.environ.get("ELEVENLABS_BASE", "https://api.elevenlabs.io/v1")
ELEVENLABS_VOICE = os.environ.get("ELEVENLABS_VOICE", "21m00Tcm4TlvDq8ikWAM")  # "Rachel"
ELEVENLABS_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_multilingual_v2")


def load_env() -> None:
    """Load KEY=VALUE pairs from .env into os.environ (does not overwrite)."""
    if os.environ.get("SIGNALFLOW_NO_DOTENV", "").lower() in ("1", "true", "yes"):
        return   # explicit opt-out (tests / CI) - ignore the .env file

    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        os.environ.setdefault(k, v)


load_env()


def _key(name: str) -> str | None:
    v = os.environ.get(name, "").strip()
    return v or None


def featherless_available() -> bool:
    return _key("FEATHERLESS_API_KEY") is not None


def elevenlabs_available() -> bool:
    return _key("ELEVENLABS_API_KEY") is not None


USER_AGENT = os.environ.get("SIGNALFLOW_UA", "SignalFlow/0.1 (hackathon)")


def _http_json(url: str, payload: dict, headers: dict, timeout: int = 45) -> dict:
    data = json.dumps(payload).encode("utf-8")
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json", **headers}
    req = urllib.request.Request(url, data=data, headers=hdrs, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


SYSTEM_PROMPT = (
    "You are SignalFlow, an explainable adaptive traffic-signal controller for a "
    "Munich intersection. Answer the operator's question strictly using the "
    "provided simulation context (metrics and recent phase-switch decisions). "
    "Be concise (max ~140 words), cite concrete numbers, and explain the *why* "
    "behind decisions. Never invent data that is not in the context."
    "Answer in the same language as the operator's question (German question means German answer). "
)

SYSTEM_PROMPT_NETWORK = (
    "You are SignalFlow, an explainable adaptive traffic-signal controller "
    "operating on urban road networks (district level, real OpenStreetMap "
    "graphs). Answer the operator's question strictly using the provided "
    "network simulation context (per-policy metrics for the whole district). "
    "Be concise (max ~140 words), cite concrete numbers, and explain the *why* "
    "behind differences between policies. Never invent data that is not in "
    "the context. Answer in the same language as the operator's question "
    "(German question means German answer). "
)


def build_context(payload: dict, question: str) -> str:
    s = payload.get("summary", {})
    f = s.get("fixed", {})
    a = s.get("adaptive", {})
    imp = payload.get("improvement", {})
    decisions = (payload.get("adaptive", {}) or {}).get("decisions", [])[:8]

    lines = [
        f"QUESTION: {question}",
        "",
        "METRICS (fixed-time baseline vs adaptive):",
        f"- avg delay: {f.get('avg_delay_s')}s -> {a.get('avg_delay_s')}s "
        f"({imp.get('avg_delay_pct')}% reduction)",
        f"- throughput: {f.get('throughput_vph')} -> {a.get('throughput_vph')} veh/h "
        f"({imp.get('throughput_pct')}%)",
        f"- max queue: {f.get('max_queue')} -> {a.get('max_queue')} "
        f"({imp.get('max_queue_pct')}%)",
        f"- wasted green: {f.get('wasted_green_s')}s -> {a.get('wasted_green_s')}s",
        f"- CO2 proxy: {f.get('co2_g')}g -> {a.get('co2_g')}g ({imp.get('co2_pct')}%)",
        "",
        "RECENT ADAPTIVE DECISIONS (t, switch, reason, pressures):",
    ]
    for d in decisions:
        lines.append(
            f"- t={d.get('t')}s {d.get('from')}->{d.get('to')}: {d.get('reason')} | "
            f"pressures={d.get('pressures')}"
        )
    return "\n".join(lines)


def build_network_context(payload: dict, question: str) -> str:
    """Context block for district (network) runs — mirrors network_digest's fields."""
    summary = payload.get("summary", {})
    imp = payload.get("improvement", {})
    scenario = payload.get("scenario") or {}
    lines = [
        f"QUESTION: {question}",
        "",
        f"NETWORK: {payload.get('name')} (region '{payload.get('region')}')",
        f"SCENARIO: {scenario.get('label')}",
        "",
        "METRICS PER POLICY (whole district):",
    ]
    for pol, s in summary.items():
        if not isinstance(s, dict):
            continue
        lines.append(
            f"- {pol}: avg delay {s.get('avg_delay_s')}s, throughput "
            f"{s.get('throughput_vph')} veh/h, travel time {s.get('avg_travel_time_s')}s, "
            f"CO2 {s.get('co2_g')}g, served {s.get('served')} trips"
        )
    lines += [
        "",
        "IMPROVEMENT (adaptive vs fixed):",
        f"- avg delay: {imp.get('avg_delay_pct')}%, throughput: {imp.get('throughput_pct')}%, "
        f"travel time: {imp.get('avg_travel_pct')}%, CO2: {imp.get('co2_pct')}%",
    ]
    if isinstance(imp.get("vs_tuned"), dict):
        lines.append(f"- vs tuned fixed plans: {imp['vs_tuned']}")
    if isinstance(imp.get("coordinated"), dict):
        lines.append(f"- coordinated (green wave): {imp['coordinated']}")
    return "\n".join(lines)


def is_network_payload(payload: dict) -> bool:
    """District results carry a top-level 'region'; junction runs do not."""
    return isinstance(payload, dict) and "region" in payload


def featherless_explain(payload: dict, question: str) -> dict:
    key = _key("FEATHERLESS_API_KEY")
    if not key:
        return {"answer": fallback_explain(payload, question), "source": "fallback",
                "model": None}

    network = is_network_payload(payload)
    body = {
        "messages": [
            {"role": "system",
             "content": SYSTEM_PROMPT_NETWORK if network else SYSTEM_PROMPT},
            {"role": "user",
             "content": (build_network_context if network else build_context)(payload, question)},
        ],
        "temperature": 0.3,
        "max_tokens": 400,
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    models = [FEATHERLESS_MODEL] + [m for m in FEATHERLESS_FALLBACKS if m != FEATHERLESS_MODEL]
    tried, last = [], None
    for model in models:
        tried.append(model)
        try:
            out = _http_json(f"{FEATHERLESS_BASE}/chat/completions",
                             {**body, "model": model}, headers)
            text = out["choices"][0]["message"]["content"].strip()
            return {"answer": text, "source": "featherless", "model": model}
        except (urllib.error.URLError, urllib.error.HTTPError, KeyError,
                TimeoutError, json.JSONDecodeError) as e:
            last = e
    return {"answer": fallback_explain(payload, question), "source": "fallback",
            "model": None,
            "note": (f"Featherless call failed ({type(last).__name__}); tried {tried}; "
                     "used local explainer.")}


def featherless_probe(timeout: int = 30) -> dict:
    """Tiny live key check (used by tools/check_keys.py and GET /api/keys)."""
    key = _key("FEATHERLESS_API_KEY")
    if not key:
        return {"configured": False}
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    info = {"configured": True, "base": FEATHERLESS_BASE, "model": FEATHERLESS_MODEL}
    try:
        r = _http_json(f"{FEATHERLESS_BASE}/chat/completions",
                       {"model": FEATHERLESS_MODEL, "max_tokens": 8, "temperature": 0,
                        "messages": [{"role": "user", "content": "ping"}]}, headers, timeout)
        info["ok"] = bool(r.get("choices"))
    except Exception as e:  # noqa: BLE001 - report, never raise
        info["ok"] = False
        info["error"] = f"{type(e).__name__}: {e}"
    return info


def fallback_explain(payload: dict, question: str) -> str:
    """Deterministic, dependency-free explainer used when Featherless is absent."""
    if is_network_payload(payload):
        return _fallback_explain_network(payload, question)
    s = payload.get("summary", {})
    f, a = s.get("fixed", {}), s.get("adaptive", {})
    imp = payload.get("improvement", {})
    dec = (payload.get("adaptive", {}) or {}).get("decisions", [])
    d0 = dec[len(dec) // 2] if dec else None

    parts = [
        f"Q: {question}".strip(),
        "",
        f"SignalFlow adapts phase timing to live queue pressure. Against the fixed-time "
        f"plan over the same traffic, it cut average delay from {f.get('avg_delay_s')}s to "
        f"{a.get('avg_delay_s')}s ({imp.get('avg_delay_pct')}%), raised throughput to "
        f"{a.get('throughput_vph')} veh/h ({imp.get('throughput_pct')}% vs baseline), and "
        f"reduced wasted green from {f.get('wasted_green_s')}s to {a.get('wasted_green_s')}s "
        f"by terminating phases whose queue is already cleared.",
    ]
    if d0:
        parts.append(
            f"Example decision (t={d0.get('t')}s): {d0.get('reason')}. "
            f"The choice only fires when a competing phase's pressure exceeds the current "
            f"phase by the hysteresis margin, which prevents green-time churn."
        )
    parts.append(
        f"Net effect: about {imp.get('co2_pct')}% less idling-related CO2 proxy. "
        f"(Offline explainer — set FEATHERLESS_API_KEY for free-form answers.)"
    )
    return "\n".join(parts)


def _fallback_explain_network(payload: dict, question: str) -> str:
    """Deterministic district-level explainer (mirrors the junction template)."""
    s = payload.get("summary", {})
    f, a = s.get("fixed", {}), s.get("adaptive", {})
    imp = payload.get("improvement", {})
    parts = [
        f"Q: {question}".strip(),
        "",
        f"District '{payload.get('name')}' (region {payload.get('region')}): adaptive "
        f"signals cut the network-wide average delay from {f.get('avg_delay_s')}s to "
        f"{a.get('avg_delay_s')}s ({imp.get('avg_delay_pct')}%), shorten average travel "
        f"time by {imp.get('avg_travel_pct')}% and lower the CO2 proxy by "
        f"{imp.get('co2_pct')}% versus the fixed-time plans.",
    ]
    co = s.get("coordinated")
    if isinstance(co, dict) and co.get("avg_delay_s") is not None:
        parts.append(
            f"The coordinated policy (green wave) reaches {co.get('avg_delay_s')}s average "
            f"delay — strong on the main corridor, but it follows a fixed offset plan, "
            f"while the adaptive controller reacts to live queues at every junction."
        )
    parts.append(
        "(Offline explainer — set FEATHERLESS_API_KEY for free-form answers.)"
    )
    return "\n".join(parts)


def elevenlabs_tts(text: str) -> tuple[bytes, str]:
    """Return (audio_bytes, content_type). Raises RuntimeError if not configured."""
    key = _key("ELEVENLABS_API_KEY")
    if not key:
        raise RuntimeError("ElevenLabs not configured")
    voice = ELEVENLABS_VOICE
    url = f"{ELEVENLABS_BASE}/text-to-speech/{voice}?output_format=mp3_44100_128"
    body = {
        "text": text[:2500],
        "model_id": ELEVENLABS_MODEL,
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"xi-api-key": key, "Content-Type": "application/json",
                 "Accept": "audio/mpeg", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read(), "audio/mpeg"


def elevenlabs_probe(timeout: int = 30) -> dict:
    """Tiny live key check (used by tools/check_keys.py and GET /api/keys)."""
    key = _key("ELEVENLABS_API_KEY")
    if not key:
        return {"configured": False}
    info = {"configured": True, "base": ELEVENLABS_BASE, "voice": ELEVENLABS_VOICE}
    try:
        req = urllib.request.Request(f"{ELEVENLABS_BASE}/voices",
                                     headers={"xi-api-key": key, "Accept": "application/json",
                                              "User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        info["ok"] = True
        info["voices"] = len(data.get("voices", []))
    except Exception as e:  # noqa: BLE001
        info["ok"] = False
        info["error"] = f"{type(e).__name__}: {e}"
    return info
