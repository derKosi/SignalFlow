# SignalFlow — Writeup

**Adaptive, explainable traffic-signal control — from one junction to a whole
Munich district on the real OpenStreetMap network.**

Built for the **MunichTech EXPO 2026** hackathon, challenge *“Smart Cities:
Adaptive Traffic Flow”*.

---

## The problem

Munich’s signals near the expo district back up at rush hour because their timing
is **fixed** — a plan drawn up offline, unable to see the queue in front of it. The
challenge asks for a system that *adapts signal timing to live conditions* and shows
the improvement. There are two traps in that sentence: a system that only *claims*
to adapt, and a system that only works at one intersection.

SignalFlow avoids both. It runs the **same traffic** through a fixed plan and an
adaptive controller side by side, then shows the difference frame by frame — and it
does so at the scale of a whole neighbourhood, not a single crossing.

## The idea, in one paragraph

Replace the fixed plan with a **queue-pressure controller**: at any moment, serve
the phase with the most waiting traffic, hold it long enough not to waste green on
clearance, release it the moment its queue empties, and never starve a minor
movement. Then make every decision **auditable** — the controller records the exact
pressures behind each switch, the dashboard shows them live, and you can *ask the
intersection why it did something* and have it answer out loud.

## What we built

**1. A single-junction simulator and dashboard** (`/`)
A discrete-time queueing model of a signalised 4-way intersection with protected
left turns. Two controllers compete on an identical, seeded arrival stream. The
browser shows a top-view replay, KPI cards with deltas, before/after bars, the delay
timeline, the live decision log, and an agentic "Ask SignalFlow" box — the LLM runs
the simulator as a tool and answers from real numbers (voice included).

**2. A district simulator and dashboard** (`/network.html`)
The real OpenStreetMap street network of **six selectable German areas** — Munich’s
**Messe München / ICM Riem** (the expo venue, 355 nodes / 569 links / 58 signals)
and busy **Altstadtring** (2597 / 4159 / 708), plus **Berlin Mitte**, **Hamburg
Innenstadt**, **Köln** (Dom & Deutz) and the university town **Heidelberg**. Every
signalised junction runs at once under fixed vs adaptive vs **green-wave** control;
the map colours roads by congestion and animates the relief. Adding a city is one
line in the fetch tool.

**3. A sensor-feed mode — ready for a real feed**
The challenge asks for control that reacts to *sensor/camera data*. Set the data
source to a CSV count feed (a **local file or an `http(s)` URL**, so a real
published feed can be plugged in later without code changes) with an optional
`detector_dropout` for missed detections. The briefing’s dataset is not public, so
we ship a synthetic stand-in with the same shape.

**4. A weekly traffic report — a tangible artifact**
`tools/report.py` runs the four demand scenarios plus a district with fixed seeds
and emits a print-ready report (`reports/week-2026-W38.md`/`.html`): before/after
tables, decision-log excerpts and an executive summary written by the LLM — with a
*number gate* in code that rejects any summary citing a figure the runs did not
produce (it did reject real LLM output during development).

## Results

**Single junction** (30 min peak, identical traffic):

| Metric | Fixed | Adaptive | Δ |
|---|---:|---:|---:|
| Average delay / vehicle | 53.9 s | **40.7 s** | **−24.5 %** |
| Throughput | 4365 veh/h | 4410 veh/h | +1.0 % |
| Wasted green | 374 s | 118 s | −68.4 % |
| Idling CO₂ proxy | 136 951 g | 103 399 g | −24.5 % |

Across a demand sweep the mean delay reduction is **39.9 %** (54.8 % when
uncongested, 16 % under oversaturation).

**District** (15 min peak, real OSM network) — three policies:

| Region | Junctions | Fixed | Adaptive | Coordinated (green wave) |
|---|---:|---:|---:|---:|
| München — Messe/ICM Riem | 58 | 184.8 s | 92.9 s | **70.5 s (−61.9 %)** |
| München — Altstadtring | 708 | 266.5 s | **94.2 s (−64.6 %)** | 111.0 s (−58.4 %) |
| Berlin — Mitte | 204 | 189.1 s | **68.9 s (−63.6 %)** | 69.8 s (−63.1 %) |
| Hamburg — Innenstadt | 173 | 109.5 s | 38.4 s | **38.2 s (−65.1 %)** |
| Köln — Innenstadt | 102 | 150.6 s | **47.4 s (−68.5 %)** | 58.0 s (−61.5 %) |
| Heidelberg — Uni | 81 | 236.3 s | **44.5 s (−81.2 %)** | 75.5 s (−68.1 %) |

More aggressive adaptivity also **completes more trips** (throughput +12…+49 %).

**On green waves (honesty):** rigid corridor coordination wins on a clean arterial
(Riem) and loses to fully adaptive control in dense multi-flow grids — the result
we expected and report as-is.

## How it works

**Junction model.** Four approaches × (left/through/right) = 12 movements, Poisson
arrivals with a rush-hour ramp, saturation-flow service (1800 veh/h/lane), four
protected phases. Delay is `Σ(queue)·dt`; CO₂ is an idling-time proxy.

**District model.** A mesoscopic **link-queue** model on the OSM graph: each
directed link has a free-flow travel bucket and a stop-line queue; discharge is
limited by saturation flow, downstream storage (spillback) and the signal phase.
Demand is a gravity **entry→exit OD matrix** routed with Dijkstra; per-link turning
fractions split the flow, and each link carries an **exit share** for terminating
trips. Fixed 60 s two-phase plan vs max-pressure per junction.

**Controllers.** The adaptive policy is max-pressure with a minimum green, a switch
hysteresis (a competitor must clearly beat the current phase), an early exit for
empty phases, and a starvation guard. A third policy adds **green-wave
coordination**: the longest arterial gets a common cycle and platoon-timed offsets
while all other junctions stay adaptive. Parameters were **calibrated** on a demand
grid, not hand-tuned.

**Explainability.** Every switch is logged with its pressures; `/api/explain` turns
the log into prose (Featherless, OpenAI-compatible), and `/api/tts` speaks it
(ElevenLabs). Both degrade gracefully: without keys, a deterministic offline
explainer answers and voice is simply disabled. Beyond narrating, **`/api/agent`
is agentic**: it plans tool calls (`simulate`, `simulate_network`, `compare`,
`explain_last`) over a provider-portable prompt protocol, executes them against the
real simulator under whitelisted arguments, verifies nothing is stated without a
tool result, and exposes the whole trace in the UI — answers come from runs, not
from the model's imagination. A **three-role self-check** (`mode:"panel"`) goes
further: analyst → critic (verifies numbers *and* the question's premise against
the tool digests, may demand one re-run with different arguments) → writer, with
the anti-hallucination rule enforced in code — a number no tool digest backs is
rejected wherever it appears, and an unrepairable draft is replaced by a fully
verified deterministic answer.

## Where this sits in the literature — **added now**

> Transparency note: the literature grounding below was compiled **now**, after the
> first working version existed. We have cited the work our design leans on, marked
> exactly where we simplify it, and we may **re-tune the model afterwards** where the
> comparison shows we deviate. Our numbers are model output, not
> literature-validated results.

* **Adaptive control** — our queue-pressure controller follows **Varaiya (2013)**,
  *Max pressure control of a network of signalized intersections* (Transportation
  Research Part C 36, 177–195); the cycle-constrained variant echoes **Levin (2019)**.
* **Fixed baseline** — the classical trade-off we compare against goes back to
  **Webster (1958)**, *Traffic Signal Settings* (Road Research Technical Paper 39).
* **Green waves** — progression with offsets is the **MAXBAND** idea (**Little et al.,
  1981**); the practical framing (and its use for cyclists) is visible in **NYC DOT's
  Green Wave** programme. Our offsets are travel-time-based, not bandwidth-optimised.
* **Saturation flow & heavy vehicles** — the **1 900 pc/h/ln** base and the
  passenger-car-equivalent concept come from **FHWA / HCM**; we use 1 800 veh/h/lane
  and an uncalibrated PCE table. That saturation flow is a default and not a
  calibrated value is a known issue (**Tarko et al.**, ~8–10 % prediction error).
* **Roundabouts** — entry capacity falls exponentially with circulating flow
  (**NCHRP 572 / Kimber / ASCE**); we use a rough version of that and explicitly do
  **not** model gap acceptance.
* **OD demand** — estimating a matrix from link counts is a solved problem
  (**Cascetta 1984**; **Cascetta & Nguyen 1988**; **Dey et al. 2020**). **We now do
  this**: the district comparison includes a plan tuned on a **count-based OD
  estimate** (`fixed_tuned_est`) — stop-line counts → Richardson-Lucy → splits —
  which recovers 80–100 % of the oracle plan's improvement even though the OD matrix
  itself is not identifiable from counts (the split *ratios* are). The demand
  *generator* is still the synthetic gravity OD.
* **Deployed adaptive systems** — **SCOOT/SCATS** adapt from stop-line detectors; we use
  the feed as a *demand source* rather than as feedback yet.

Full table with links and the follow-up queue: [docs/references.md](docs/references.md).

## The engineering story (what actually took the time)

The interesting part was not writing a controller — it was discovering, with
measurements, why the obvious versions were wrong.

1. **The first adaptive controller was *worse* than fixed.** Delay regressed by
   57 %. Instrumenting phase timings showed the cause: it switched so often that
   clearance time (yellow + all-red) ate the green budget — 245 s vs 92 s. Fix:
   minimum green, switch hysteresis, early-exit only for *empty* phases, and a
   demand-grid calibration. Lesson: *"adaptive" is not automatically better.*

2. **The OD matrix silently lost most of its demand.** Only ~40 % of vehicles were
   ever loaded, and the network gridlocked. Cause: many gravity entry→exit pairs are
   **unreachable** on the directed graph (one-way streets), and that flow was
   dropped. Fix: keep only reachable pairs and **renormalise to the configured
   total demand**.

3. **Vehicles that reached their destination kept driving.** The link’s aggregate
   turning fractions sent terminating trips onward, so traffic circulated forever
   and completions were undercounted. Fix: an explicit **exit share** per link — the
   fraction of discharge that leaves the network. (An aggregate multi-commodity
   approximation; exact per-trip tracking was unnecessary.)

4. **Two-way streets deadlocked.** With a hard downstream-storage limit, pairs of
   links could block each other permanently (delay exploded past 1800 s). Fix: a
   **soft** storage cap (`×1.35`) that still models spillback but lets queues bleed.

5. **An aliasing bug that hid behind a lucky test.** The network compiler resolved
   node ids with the *link*-id map. On the tiny self-test grid the two id spaces
   happened to overlap, so it “worked”; on real data every junction vanished.
   Fixing it turned a silent zero into a real simulation.

Each of these is captured as an ADR in
[`docs/design-decisions.md`](docs/design-decisions.md), because the reasoning is
more valuable than the diff.

## Honest limitations

* Macroscopic/mesoscopic, not a per-vehicle microsimulation — no car-following,
  lane-changing, or gap acceptance at unsignalised nodes.
* No inter-junction coordination yet (no green waves); junctions are independent.
* The fixed baseline is a plausible generic plan, not a locally optimised one.
* CO₂ is an idling-time proxy; the district OD demand is synthetic.
* The briefing’s real detector dataset would replace the synthetic feed via
  `arrival_csv` — no code change.

## What’s next

Corridor coordination (green waves), transit-signal priority, real detector/GTFS
ingestion, per-junction auto-calibration as a service, and a digital-twin export so
municipal planners can replay *their* intersections.

## Run it

```bash
cd signalflow
./run.sh         # or: python3 server.py
```
* Junction dashboard → <http://127.0.0.1:8000>
* District dashboard → <http://127.0.0.1:8000/network.html>

Tests: `python3 -m unittest discover -s tests` → **48 passing**.

## Where to read more

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | system design & data flow |
| [docs/model.md](docs/model.md) | the models, units, assumptions |
| [docs/controllers.md](docs/controllers.md) | controllers & calibration |
| [docs/api.md](docs/api.md) | HTTP API reference |
| [docs/data.md](docs/data.md) | OSM pipeline & sensor feed |
| [docs/results.md](docs/results.md) | numbers & reproduction |
| [docs/design-decisions.md](docs/design-decisions.md) | the ADR log |
| [docs/challenge.md](docs/challenge.md) | challenge & prize mapping |
