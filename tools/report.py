#!/usr/bin/env python3
"""Weekly traffic report - a tangible artifact built from real, seeded runs.

Runs the four demand scenarios on the junction model (plus one district on its
OSM network), collects the KPIs and emits a Markdown report: headline numbers,
before/after tables, decision-log highlights and an executive summary. The
summary is written by Featherless when a key is configured and degrades to a
deterministic template otherwise. Every number is reproducible: fixed seed,
same code paths as the dashboard (``run_scenario`` / ``run_region``).

Usage:
    python3 tools/report.py                          # reports/week-YYYY-WW.md
    python3 tools/report.py --out reports/x.md       # custom path
    python3 tools/report.py --html                   # also write a print-ready HTML
    python3 tools/report.py --region innenstadt      # pick the district
    python3 tools/report.py --duration-min 10 --region-duration-min 5   # quick run

The HTML variant is meant for "Print -> Save as PDF" in a browser (A4, light).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from signalflow.agent import (  # noqa: E402  (model fallback chain + tracing)
    featherless_chat, unsupported_numbers,
)
from signalflow.integrations import featherless_available  # noqa: E402
from signalflow.network import run_region  # noqa: E402
from signalflow.simulation import DEMAND_SCENARIOS, run_scenario  # noqa: E402

SEED = 42                       # same base seed as docs/results.md
SCENARIOS = ["normal", "berufsverkehr", "ferien", "freizeit"]
PCE_LABEL = {"fixed": "Fester Fahrplan", "fixed_tuned": "Tuned (Oracle)",
             "fixed_tuned_est": "Tuned* (Count-Schätzung)",
             "adaptive": "Adaptiv", "coordinated": "Grüne Welle"}


# ---------------------------------------------------------------------------
# data collection
# ---------------------------------------------------------------------------

def collect(duration_min: int, region: str | None, region_duration_min: int) -> dict:
    runs = {}
    for name in SCENARIOS:
        runs[name] = run_scenario({"duration_min": duration_min, "seed": SEED,
                                   "demand_scenario": name})
    district = None
    if region:
        district = run_region(region, {"duration_min": region_duration_min,
                                       "seed": SEED})
    return {"runs": runs, "district": district}


# ---------------------------------------------------------------------------
# deterministic pieces of the report
# ---------------------------------------------------------------------------

def _fmt(x, unit: str = "", nd: int = 1) -> str:
    if x is None:
        return "–"
    if isinstance(x, float):
        x = round(x, nd)
        s = f"{x:,.{nd}f}".replace(",", " ").replace(".", ",")
    else:
        s = str(x)
    return f"{s}{unit}"


def scenario_table(data: dict) -> list[str]:
    lines = [
        "| Szenario | Ø Verzögerung fix | Ø Verzögerung adaptiv | Δ Verzögerung |"
        " Durchsatz adaptiv | CO₂-Proxy Δ |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for name in SCENARIOS:
        r = data["runs"][name]
        f, a, imp = r["summary"]["fixed"], r["summary"]["adaptive"], r["improvement"]
        lines.append(
            f"| {DEMAND_SCENARIOS[name]['label']} | {_fmt(f['avg_delay_s'], ' s')} "
            f"| **{_fmt(a['avg_delay_s'], ' s')}** | **−{_fmt(imp['avg_delay_pct'], ' %')}** "
            f"| {_fmt(a['throughput_vph'], ' Fz/h', 0)} "
            f"| −{_fmt(imp['co2_pct'], ' %')} |")
    return lines


def decision_highlights(runs: dict, per_scenario: int = 2) -> list[str]:
    lines = []
    for name in SCENARIOS:
        dec = runs[name]["adaptive"]["decisions"]
        if not dec:
            continue
        picks = [dec[0], dec[len(dec) // 2]]
        for d in picks[:per_scenario]:
            lines.append(f"- **{DEMAND_SCENARIOS[name]['label']}**, t={_fmt(d.get('t'), ' s', 0)}: "
                         f"{d.get('from')} → {d.get('to')} — {d.get('reason')}")
    return lines


def district_table(data: dict) -> list[str]:
    d = data["district"]
    if not d:
        return []
    lines = [
        f"## Stadtteil „{d['name']}“ (`{d['region']}`)",
        "",
        f"Mesoskopischer Lauf auf dem echten OSM-Netz "
        f"({d['demand']['n_entries']} Zu-/ {d['demand']['n_exits']} Abfahrten, "
        f"{_fmt(d['config']['duration_min'], ' min', 0)}, seed {d['config']['seed']}):",
        "",
        "| Strategie | Ø Verzögerung | Ø Reisezeit | Durchsatz | CO₂-Proxy |",
        "|---|---:|---:|---:|---:|",
    ]
    for pol, label in PCE_LABEL.items():
        s = d["summary"].get(pol)
        if not s:
            continue
        lines.append(
            f"| {label} | {_fmt(s['avg_delay_s'], ' s')} | {_fmt(s['avg_travel_time_s'], ' s')} "
            f"| {_fmt(s['throughput_vph'], ' Fz/h', 0)} | {_fmt(s['co2_g'], ' g', 0)} |")
    lines += ["",
              "Kartendaten: © OpenStreetMap-Mitwirkende, ODbL 1.0 "
              "(openstreetmap.org/copyright)."]
    imp = d["improvement"]
    lines += ["",
              f"Adaptiv gegenüber festem Fahrplan: **−{_fmt(imp['avg_delay_pct'], ' %')} Verzögerung**, "
              f"−{_fmt(imp['avg_travel_pct'], ' %')} Reisezeit, −{_fmt(imp['co2_pct'], ' %')} CO₂-Proxy. "
              f"Die grüne Welle erreicht −{_fmt(imp['coordinated']['avg_delay_pct'], ' %')} "
              f"auf den Korridoren; der count-basierte Tuned*-Vergleich liegt bei "
              f"−{_fmt(imp['vs_tuned_est']['avg_delay_pct'], ' %')} (ohne Oracle-Wissen)."]
    return lines


def deterministic_summary(data: dict) -> str:
    """Template summary used when no Featherless key is configured."""
    n = data["runs"]["normal"]
    b = data["runs"]["berufsverkehr"]
    f_ = data["runs"]["ferien"]
    parts = [
        f"Über alle vier Tagestypen senkt die adaptive Steuerung die mittlere "
        f"Verzögerung je Fahrzeug: Normaltag {_fmt(n['improvement']['avg_delay_pct'])} %, "
        f"Berufsverkehr {_fmt(b['improvement']['avg_delay_pct'])} %, "
        f"Ferien {_fmt(f_['improvement']['avg_delay_pct'])} %.",
        f"Der größte absolute Gewinn entsteht im Berufsverkehr: "
        f"{_fmt(b['summary']['fixed']['avg_delay_s'])} s → "
        f"**{_fmt(b['summary']['adaptive']['avg_delay_s'])} s** je Fahrzeug.",
    ]
    d = data["district"]
    if d:
        parts.append(
            f"Im Stadtteil „{d['name']}“ verbessert sich die Reisezeit um "
            f"{_fmt(d['improvement']['avg_travel_pct'])} % gegenüber dem festen Plan.")
    parts.append("(Deterministische Zusammenfassung — ohne LLM-Schlüssel erzeugt.)")
    return " ".join(parts)


# ---------------------------------------------------------------------------
# LLM executive summary (degrades to the template)
# ---------------------------------------------------------------------------

def llm_summary(data: dict) -> tuple[str, str | None]:
    facts = {
        "dauer_min": data["runs"]["normal"]["config"]["duration_min"],
        "szenarien": {DEMAND_SCENARIOS[n]["label"]: {
            "fix_s": data["runs"][n]["summary"]["fixed"]["avg_delay_s"],
            "adaptiv_s": data["runs"][n]["summary"]["adaptive"]["avg_delay_s"],
            "reduktion_pct": data["runs"][n]["improvement"]["avg_delay_pct"],
            "durchsatz_adaptiv_fzh": data["runs"][n]["summary"]["adaptive"]["throughput_vph"],
        } for n in SCENARIOS},
    }
    if data["district"]:
        d = data["district"]
        facts["stadtteil"] = {
            "name": d["name"],
            "fix_s": d["summary"]["fixed"]["avg_delay_s"],
            "adaptiv_s": d["summary"]["adaptive"]["avg_delay_s"],
            "reduktion_pct": d["improvement"]["avg_delay_pct"],
            "reisezeit_reduktion_pct": d["improvement"]["avg_travel_pct"],
        }
    if not featherless_available():
        return deterministic_summary(data), None
    try:
        text, model = featherless_chat([
            {"role": "system", "content":
                "Du schreibst die Executive Summary eines Verkehrs-Wochenberichts für "
                "eine Stadtverwaltung. Max 110 Wörter, auf Deutsch, sachlich. Verwende "
                "AUSSCHLIESSLICH die gegebenen Zahlen - erfinde nichts und runde nicht. "
                "Nenne den wichtigsten Gewinn und eine klare Empfehlung."},
            {"role": "user", "content": json.dumps(facts, ensure_ascii=False)},
        ])
        # anti-hallucination gate: every number must trace back to the facts
        bad = unsupported_numbers(text, facts)
        if bad:
            return (deterministic_summary(data) +
                    f"\n\n*(LLM-Zusammenfassung verworfen: unbelegte Zahlen "
                    f"{bad}.)*"), model
        return text.strip(), model
    except Exception as e:  # noqa: BLE001 - the report must always be produced
        return (deterministic_summary(data) +
                f"\n\n*(LLM-Zusammenfassung fehlgeschlagen: {type(e).__name__}.)*"), None


# ---------------------------------------------------------------------------
# report assembly
# ---------------------------------------------------------------------------

def build_report(data: dict, out: str, as_html: bool = False,
                 generated: str | None = None) -> str:
    generated = generated or date.today().isoformat()
    n = data["runs"]["normal"]
    i = n["improvement"]
    md = f"""# SignalFlow — Verkehrs-Wochenbericht

**KW {date.today().isocalendar()[1]} / {date.today().year}** · generiert {generated} ·
seed {SEED} · reproduzierbar aus dem Repository (Befehle unten).

## Kernaussagen

{{SUMMARY_PLACEHOLDER}}

## Einzelknoten — Szenarien im Wochenvergleich

Vier Tagestypen, je {_fmt(n['config']['duration_min'], ' min', 0)} Simulation mit
identischem Reisendenstrom pro Vergleich (Poisson-Modell, seed {SEED}):

{chr(10).join(scenario_table(data))}

Auf dem Normaltag: {_fmt(n['summary']['fixed']['avg_delay_s'])} s →
**{_fmt(n['summary']['adaptive']['avg_delay_s'])} s** mittlere Verzögerung
(−{_fmt(i['avg_delay_pct'])} %), weggeworfene Grünzeit
{_fmt(n['summary']['fixed']['wasted_green_s'], ' s', 0)} →
{_fmt(n['summary']['adaptive']['wasted_green_s'], ' s', 0)}.

## Entscheidungen im Log (Auszug)

Jede Phasenschaltung ist mit ihren Drücken protokolliert — Auszüge:

{chr(10).join(decision_highlights(data["runs"]))}

{chr(10).join(district_table(data))}

## Methodik & Reproduktion

```bash
python3 tools/report.py --out {out}
# identische Zahlen, direkt aus der Simulation:
python3 -c "from signalflow.simulation import run_scenario; import json; \\
print(json.dumps(run_scenario({{'duration_min': {n['config']['duration_min']}}})['improvement'], indent=2))"
```

Modellgrenzen (ehrlich): mesoskopisches Warteschlangenmodell, keine validierte
Mikrosimulation; Sättigungsfluss/PCE sind Defaults; Bezugsgrößen sind synthetische
Nachfrage-Szenarien; die Stadtteil-Matrix ist gravitätsbasiert bzw. count-geschätzt.
"""
    summary, model = llm_summary(data)
    if model:
        summary += f"\n\n*(Zusammenfassung: Featherless, {model}.)*"
    md = md.replace("{SUMMARY_PLACEHOLDER}", summary)
    return _html_wrap(md, generated) if as_html else md


def _html_wrap(md: str, generated: str) -> str:
    """Minimal print-friendly HTML (browser: Print -> Save as PDF)."""
    import html as _html
    body = (md.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    # very small md->html: headings, bold, tables, code, lists, paragraphs
    import re
    body = re.sub(r"^# (.*)$", r"<h1>\1</h1>", body, flags=re.M)
    body = re.sub(r"^## (.*)$", r"<h2>\1</h2>", body, flags=re.M)
    body = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", body)
    body = re.sub(r"```(?:\w*)\n(.*?)```", r"<pre>\1</pre>", body, flags=re.S)
    body = re.sub(r"^```(?:\w*)$", "", body, flags=re.M)
    lines, out, in_tbl = body.split("\n"), [], False
    for ln in lines:
        if ln.startswith("|"):
            cells = [c.strip() for c in ln.strip("|").split("|")]
            if set("".join(cells)) <= set("-: "):
                continue
            if not in_tbl:
                out.append("<table>"); in_tbl = True
            out.append("<tr>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>")
            continue
        if in_tbl:
            out.append("</table>"); in_tbl = False
        if ln.startswith("- "):
            out.append(f"<li>{ln[2:]}</li>")
        elif ln.strip():
            out.append(f"<p>{ln}</p>")
    if in_tbl:
        out.append("</table>")
    return ("<!doctype html><meta charset='utf-8'>"
            "<title>SignalFlow Wochenbericht</title><style>"
            "body{font:12pt/1.5 Georgia,serif;max-width:19cm;margin:2cm auto;color:#111}"
            "h1{font-size:20pt;margin:0}h2{font-size:14pt;margin:1.2em 0 .3em;"
            "border-bottom:1px solid #ccc}table{border-collapse:collapse;width:100%;"
            "margin:.6em 0}td{border:1px solid #bbb;padding:4pt 6pt}td:first-child{text-align:left}"
            "pre{background:#f4f4f4;padding:8pt;font-size:9pt}li{margin:.2em 0}"
            "</style>" + _html.escape(generated) + "<hr>" + "\n".join(out))


def default_out() -> str:
    iso = date.today().isocalendar()
    return f"reports/week-{iso[0]}-W{iso[1]:02d}.md"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=None, help="output .md path (default: %(default)s)")
    ap.add_argument("--html", action="store_true", help="also write a print-ready .html")
    ap.add_argument("--region", default="expo_riem",
                    help="district to include ('' to skip, default: %(default)s)")
    ap.add_argument("--duration-min", type=int, default=30, help="junction minutes")
    ap.add_argument("--region-duration-min", type=int, default=15, help="district minutes")
    ap.add_argument("--stdout", action="store_true", help="print instead of writing")
    args = ap.parse_args()

    out = args.out or default_out()
    region = args.region or None
    data = collect(args.duration_min, region, args.region_duration_min)
    md = build_report(data, out, as_html=False)

    if args.stdout:
        print(md)
    else:
        path = ROOT / out
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(md, encoding="utf-8")
        print(f"geschrieben: {path}")
        if args.html:
            hp = path.with_suffix(".html")
            hp.write_text(build_report(data, out, as_html=True), encoding="utf-8")
            print(f"geschrieben: {hp}  (Browser: Drucken -> als PDF sichern)")
    summary_src = "LLM" if featherless_available() else "deterministisch (kein Key)"
    print(f"Executive Summary: {summary_src}")


if __name__ == "__main__":
    main()
