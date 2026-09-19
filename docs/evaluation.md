# Evaluation — SignalFlow, scored 1–100

A candid self-assessment, as if reviewing the project for a jury. Scores are
weighted; the lists are deliberately blunt.

## Score: 83 / 100

| Dimension | Weight | Score | Notes |
|---|---:|---:|---|
| Problem fit & relevance | 15 | **13** | Directly answers the challenge, incl. the sensor-data wording |
| Technical execution | 20 | **17** | Working, tested, deterministic, validated inputs, no crashes |
| Innovation & originality | 15 | **12** | Explainable control + district scale; green waves are solid, not novel |
| Model realism / fidelity | 20 | **14** | Sensible traffic-engineering rules, but mesoscopic & uncalibrated |
| Scalability | 10 | **9** | Hundreds of junctions, multiple cities, selectable regions |
| Explainability | 10 | **9** | Decision log + NL + voice, auditable numbers |
| Presentation / demo-readiness | 10 | **9** | Full docs, writeup (MD+HTML), demo script, submission text |
| **Total** | **100** | **83** | Strong hackathon project; docked for fidelity & unverified UI |

## Top 10 — what is genuinely good

1. **A fair experiment.** Both controllers consume the *identical, seeded* demand
   stream, so the improvement is attributable to control, not to luck. Most
   “AI beats baseline” demos fail exactly here.
2. **Explainability as a product feature.** Every phase switch is logged with the
   pressures behind it; the dashboard shows it live and `/api/explain` (LLM) +
   `/api/tts` (voice) turn it into prose and speech. Auditable, not a black box.
3. **Real scale.** A whole district on real OSM geometry — 58 signals in Riem,
   708 on the Altstadtring — selectable per region.
4. **Green-wave coordination, honestly evaluated.** A real corridor controller
   with cycle + offsets; it *wins* on the clean Riem arterial (−61.9 % vs −49.7 %
   for pure adaptive) and *loses* in the dense Altstadtring grid (−58.4 % vs
   −64.6 %) — and we say so. Negative-but-honest results build credibility.
5. **Future-proof data ingestion.** Sensor-feed mode with `detector_dropout` and
   **remote URL** loading, so a real published detector feed can be plugged in
   later without code changes.
6. **Zero dependencies, one command.** `python3 server.py` — no pip, no npm, no
   build. Runs on any judge's laptop, offline.
7. **Determinism + tests.** 48 passing tests including HTTP-API tests and a
   path-traversal guard; every headline number is reproducible from a seed.
8. **A real engineering narrative.** The ADR log documents four substantive bugs
   (adaptive regression, OD reachability loss, exit-share, deadlock) with the fix
   and the lesson — the sign of a working process.
9. **Reproducible geodata pipeline.** `fetch_osm.py` → `build_regions.py` →
   `verify_regions.py`, with mirror fallback and ODbL attribution.
10. **A complete submission package.** README, writeup (Markdown + rendered HTML),
    2–3 min demo script, Devpost text, architecture diagram.

## Top 10 — what is weak (fix these)

1. **Mesoscopic, not a microsimulation.** Link-queue approximation: no
   car-following, lane-changing, or gap acceptance. Absolute delay values are
   indicative, not validated.
2. **No calibration to measured data.** Parameters are traffic-engineering rules
   of thumb (1800 veh/h/lane, 6 m jam spacing), not fitted to Munich counts.
3. **Synthetic OD at network scale.** The district demand is a gravity model;
   real-feed support exists at the **junction** level, not yet as count-based OD
   estimation for a city.
4. **Single corridor coordinated.** No multi-corridor / network-wide progression
   optimisation; other arterials run uncoordinated.
5. **The baseline is generic.** The fixed plan is plausible but not locally
   optimised, which can *overstate* the improvement. A pre-tuned real plan would
   be the honest comparison.
6. **End-to-end UI unverified in this environment.** The sandbox kills browser
   processes, so the Canvas dashboards were never rendered visually here — a real
   risk for “demo quality”.
7. **Sponsor integrations unproven live.** Featherless and ElevenLabs code paths
   were never exercised with real keys, and those features carry the sponsor
   prizes.
8. **Accessibility & polish.** Canvas-heavy UI, no keyboard/a11y support, no
   guaranteed colour-blind-safe palette, no mobile-first layout.
9. **Performance & payload at city scale.** Altstadtring returns ~3 MB and takes
   seconds per run; not real-time-interactive at full density.
10. **Ops/engineering hygiene gaps.** No CI, no packaging/`pyproject.toml`, no
    LICENSE file, no Dockerfile, in-memory single-user cache, no input fuzzing.

## What would move the score up fastest

1. Calibrate with **one real dataset** (counts) at both junction and network level
   → biggest realism gain (+4–6).
2. Render and verify the dashboards on a real browser, fix any visual bugs → the
   “demo quality” criterion (+2–3).
3. Run the sponsor paths with real keys and record a live demo → unlocks the
   sponsor prizes (+2–4, and out of scope of this rubric).
4. Multi-corridor coordination + a locally optimised baseline → more defensible
   claims (+2).
5. Add CI + LICENSE + packaging → professionalism (+1–2).

Realistic ceiling for a weekend build: **~90/100**. The gap to 100 is validation
against reality, not features.
