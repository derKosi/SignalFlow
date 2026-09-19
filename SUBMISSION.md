# SignalFlow — Devpost submission text (copy/paste ready)

## Inspiration
Munich's intersections near the expo district clog at rush hour because their
signal timing is *fixed* — the signals cannot see the traffic. We asked a simple
question: what if the junction could **respond to the live queue and explain its
own decisions**? That is the Smart Cities challenge, and it is also where
explainable AI meets daily civic infrastructure.

## What it does
SignalFlow runs a signalised intersection twice — once under a classic
fixed-time plan, once under our **queue-pressure adaptive controller** — on the
**identical** traffic stream. It then shows the before/after dashboard: average
delay, throughput, wasted green, queues and a CO₂ proxy, plus a frame-by-frame
replay of the junction and the live list of *why* each phase changed.

It also scales up: the **district mode** loads the real OpenStreetMap street
network of a whole Munich neighbourhood (two selectable areas — Messe/ICM Riem
and the Altstadtring) and runs every junction at once, comparing fixed vs
adaptive control network-wide.

Ask the controller a question (“Why did you switch to EW_THRU?”) and it answers
in plain language (Featherless open models) and speaks it aloud (ElevenLabs) —
a hands-free interface for a traffic operator.

## How we built it
- **Model:** discrete-time queueing simulation (dt = 1 s) of 4 approaches ×
  (L/T/R), Poisson arrivals, saturation-flow service, protected left turns,
  rush-hour demand ramp. Deterministic via seeds.
- **Sensor feed:** the same pipeline also runs on a **sensor-count CSV feed**
  (`arrival_source=csv`) with optional detector dropout, so the controller reacts
  to *measured* counts, not just the model's own rates.
- **Controller:** max-pressure with lane-normalised queues, a starvation guard,
  switch hysteresis (×3.0) to prevent green-time churn, and an early-exit for
  already-cleared phases. Min-green 24 s / max-green 50 s / yellow 3 s / all-red 1 s.
- **Calibration:** parameters were fitted on a demand grid (0.8×–1.1×, flat &
  peak) — not hand-tuned — then frozen.
- **Network:** district-scale mesoscopic link-queue model built from real
  OpenStreetMap data (6 German regions + add-any-place-live via Nominatim/Overpass),
  gravity OD assignment + Dijkstra routing, green-wave corridors, and a
  **count-based OD pipeline**: a plan tuned purely on simulated stop-line detector
  counts (Richardson-Lucy estimation) recovers 80–100 % of what an oracle with
  perfect demand knowledge achieves.
- **Stack:** Python 3 standard library (same-origin HTTP server) + vanilla-JS
  Canvas dashboard. Zero third-party dependencies, one command to run.
- **Integrations:** Featherless.ai (OpenAI-compatible chat completions) for the
  explainer; ElevenLabs for speech. Both degrade gracefully offline.

## Results
At a single junction (default 30-min peak scenario, identical traffic for both
controllers):

| Metric | Fixed-time | Adaptive | Δ |
|---|---:|---:|---:|
| Avg delay / vehicle | 53.9 s | **40.7 s** | **−24.5 %** |
| Throughput | 4365 veh/h | 4410 veh/h | +1.0 % |
| Wasted green | 374 s | 118 s | −68.4 % |
| Idling CO₂ proxy | 136 951 g | 103 399 g | −24.5 % |

Over a demand sweep the controller delivers a **39.9 % mean delay reduction**
(54.8 % when uncongested; 16 % under oversaturation).

At **district scale** (15-min peak, identical demand), over the real OSM network:

| Region | Fixed delay | Adaptive delay | Δ delay | Δ throughput |
|---|---:|---:|---:|---:|
| Messe München / ICM Riem (355 nodes, 58 signals) | 184.8 s | **92.9 s** | **−49.7 %** | +16 % |
| Innenstadt / Altstadtring (2597 nodes, 708 signals) | 266.5 s | **94.2 s** | **−64.6 %** | +26 % |

**Fair baselines, reported honestly.** Against a *demand-tuned* fixed plan (an oracle
with perfect knowledge of routed demand) the adaptive advantage narrows to −8 % — so
we also derive a plan **purely from detector counts** (`fixed_tuned_est`): it recovers
80–100 % of the oracle's improvement, and with opt-in Webster cycle-lengthening the
adaptive controller **beats the demand-oracle on Riem (+8.2 %) and Köln (+2.5 %)**.

## Challenges we ran into
Our first adaptive version was *worse* than fixed-time (−57 % delay improvement
= a regression!): it switched phases so often that clearance times ate the green
budget (245 s vs 92 s of yellow/all-red). Instrumenting phase timings exposed it,
and a parameter sweep fixed it — a reminder that “adaptive” is not automatically
better, it must be *calibrated*. Later, the demand-tuned baseline forced us to
replace raw max-pressure with measured-split control — and to build the
detector-count OD pipeline instead of celebrating oracle-relative numbers.

## What's next
Iterative OD refinement (estimate → retime → recount) on real detector data,
spillback-aware cycle lengthening, roundabout gap-acceptance modelling, and a
per-junction auto-calibration service.

## Built with
python · javascript · html5-canvas · simulation · reinforcement-learning-adjacent
control · featherless · elevenlabs · digital-sovereignty

## Licence

Code: **PolyForm Noncommercial 1.0.0** (source-available, non-commercial — the repo is
public and fully reviewable; see `LICENSE`). OpenStreetMap-derived data: **ODbL 1.0**
(attribution + share-alike for the database). AI tooling is disclosed in `NOTICE.md`.
