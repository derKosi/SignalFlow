# Architecture

## Goals

1. **Prove** that adaptive, queue-responsive signal control beats a fixed plan —
   with a fair, reproducible comparison (identical traffic for both policies).
2. **Scale** from one junction to a whole district on real street geometry.
3. **Explain** every decision, in numbers and in natural language.
4. **Run anywhere** with zero dependencies and one command.

## Components

```
signalflow/
├── server.py                 # stdlib HTTP server: static files + JSON API
├── signalflow/
│   ├── simulation.py         # single-junction model, controllers, metrics, scenario runner
│   ├── network.py            # district model: OSM graph compile, OD routing, link-queue sim
│   └── integrations.py       # Featherless (LLM) + ElevenLabs (TTS) clients, offline fallback
├── web/
│   ├── index.html / app.js / styles.css        # junction dashboard
│   └── network.html / network.js / network.css # district dashboard
├── tools/                    # fetch_osm.py, build_regions.py, verify_regions.py
├── data/                     # regions/*.json (graphs), osm/*.json (raw), sample_traffic.csv
└── tests/                    # 48 unit/API tests (stdlib unittest)
```

Everything is Python standard library + vanilla browser JS. No `pip install`, no
build step, no CDN. Rationale in [design-decisions.md](design-decisions.md#adr-1-zero-dependencies).

## Data flow

```
                       ┌───────────────────────── server.py ─────────────────────────┐
 demand source         │                                                            │
 ├─ model (Poisson)  ──┼─► simulation.run_scenario ─► {summary, frames, decisions}  │──► GET  /            (junction UI)
 ├─ sensor feed CSV  ──┼─► simulation.run_scenario ─► …                              │──► GET  /network.html (district UI)
 └─ OSM region graph ──┴─► network.run_region      ─► {network, summary, frames}    │
                                                                                     │
 POST /api/agent   ──► agent.run_agent(question) ──► tool loop (simulate / simulate_network /
                       compare / explain_last) ──► {answer, steps[]}  (fallback: keyword scan +
                       one deterministic run; protocol = single-JSON-object tool calling)
 POST /api/explain ──► integrations.featherless_explain(last_result, question) ──► text  (fallback: rule-based)
 POST /api/tts     ──► integrations.elevenlabs_tts(text) ──► audio/mpeg  (503/501 if no key)
```

* Both dashboards are **static** files served by the same process; they call the
  JSON API with relative URLs, so there is no CORS/build problem.
* The last simulation result is cached in memory (`LAST`) and used as context for
  `/api/explain`, so the LLM explains *the run you are looking at*.

## The control loop (both models)

```
   vehicles ─► queue at stop line ─► CONTROLLER decides green ─► discharge at saturation flow
                       ▲                          │                    │
                       └──── travel-time delay ◄──┴──── downstream storage (spillback) ◄─┘
```

1. Demand enters (Poisson tickets or measured counts; network: routed OD flows).
2. Each step the controller grants green to a phase (junction: 4 phases; district: 2 axes per junction).
3. Green links discharge at saturation flow, limited by downstream storage.
4. Discharged vehicles travel the link (free-flow) and join the next stop-line queue.
5. Metrics accumulate: delay = Σ(queue)·dt, completions = trips leaving the network.

## Tech choices (short)

| Choice | Why |
|---|---|
| Python stdlib `http.server` | demo runs with one command on any machine, no install |
| Vanilla JS + Canvas | no framework/build; canvas handles hundreds of animated links |
| Discrete time (dt = 1 s) | simple, deterministic, fast enough for interactive sliders |
| Deterministic seeds | every number is reproducible and auditable |
| Graceful API fallbacks | judges/teammates without sponsor keys still get a full demo |

## Reproducibility & determinism

* Demand is pre-generated from a seed; both controllers consume the **same**
  arrival stream, so differences are attributable to control only.
* `run_region` and `run_scenario` are pure functions of `(config, seed)` — running
  twice yields identical numbers (asserted in the test suite).
* Region graphs are committed as JSON (`data/regions/`), so results do not depend
  on a live OSM query at demo time.
