# SignalFlow — Documentation

Adaptive, explainable traffic-signal control. From a single junction to a whole
Munich district on the real OpenStreetMap network.

> New here? Start with the [project README](../README.md), then the
> [Writeup](../WRITEUP.md) for the story, then this index for details.

## Contents

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | System design: components, data flow, the control loop, tech choices |
| [model.md](model.md) | The simulation models (junction queueing + district link-queue), assumptions, units, limitations |
| [controllers.md](controllers.md) | Fixed-time baseline, max-pressure adaptive controller, calibration, explainability hooks |
| [api.md](api.md) | HTTP API reference with request/response schemas |
| [data.md](data.md) | OSM pipeline, region graphs, sensor-count feed, sample data |
| [results.md](results.md) | Benchmark numbers and how to reproduce them |
| [design-decisions.md](design-decisions.md) | ADR-style log of the non-obvious choices (and the bugs they fixed) |
| [operations.md](operations.md) | Run, configure, test, troubleshoot, integrate the sponsor APIs |
| [challenge.md](challenge.md) | Mapping to the MunichTech EXPO challenge, judging criteria and prize strategy |
| [evaluation.md](evaluation.md) | Candid self-assessment: score 1–100, top 10 strengths, top 10 weaknesses |
| [improvements.md](improvements.md) | The five-point improvement plan: status + honest findings (incl. the tuned-baseline surprise) |
| [references.md](references.md) | Literature grounding with sources, mapped to each design choice (added after the first version; may trigger re-tuning) |
| [todo.md](todo.md) | Consolidated roadmap: P0 (before submission), P1, P2 + known limitations |
| `reports/` | generated weekly traffic reports (`tools/report.py`; seeded, reproducible) |
| [licensing.md](licensing.md) | Challenge-rules evidence, licence options + recommendation, dependency/attribution inventory |
| [submission-kit.md](submission-kit.md) | Devpost fields, demo-video script, TTS voice-over lines, pre-submission checklist |

## 30-second overview

```
scenario / OSM network ─► demand (seeded) ─► two controllers on identical traffic
                                              ├─ FixedTime / FixedJunction   (baseline)
                                              └─ MaxPressure / AdaptiveJunction (adaptive)
                                             └─► metrics + frames + decision log
                                                     │
                  browser dashboards  ◄──────────────┤  /  (junction)  ·  /network.html (district)
                  Featherless (LLM)   ◄── /api/explain
                  ElevenLabs (voice)  ◄── /api/tts
```

Run it: `./run.sh` → <http://127.0.0.1:8000>. Tests: `python3 -m unittest discover -s tests`.
