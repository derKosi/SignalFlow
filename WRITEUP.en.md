# SignalFlow — Writeup (English, detailed)

**Adaptive, explainable traffic-signal control — from one junction to a whole
district on real OpenStreetMap networks.**

Built for the **MunichTech EXPO 2026** hackathon, challenge *“Smart Cities:
Adaptive Traffic Flow”*.

> This writeup comes in four versions:
> **English detailed** (this file) ·
> [English simple](WRITEUP.en-simple.md) ·
> [Deutsch ausführlich](WRITEUP.md) ·
> [Deutsch einfach](WRITEUP.einfach.md)
> — switchable in the browser at <http://127.0.0.1:8000/writeup.html>.

---

## 1. The problem

Munich's signals near the expo district back up at rush hour because their
timing is **fixed** — a plan drawn up offline, blind to the queue in front of
it. The challenge asks for control that **adapts live** and proves the gain.
Two traps hide in that sentence: a system that merely *claims* to adapt, and
one that works only at a single intersection.

SignalFlow avoids both. It runs the **same traffic** (same seed) through a
fixed plan and an adaptive controller, side by side, frame by frame — and it
scales from one junction to **nine real German district networks** (more
loadable live from OpenStreetMap).

## 2. The four strategies — and how they differ

The heart of the evaluation is a fair four-way contest. Each strategy has a
different idea of what a signal is allowed to know:

| Strategy | Core idea | What it knows about traffic | Reacts live? | Typical strength | Typical weakness |
|---|---|---|:--:|---|---|
| **Fixed-Time** | Fixed phase plan from classical handbook logic ([Webster 1958](docs/references.md)) | nothing but the schedule | ✗ | predictable, needs no sensors | wastes green on empty approaches; breaks on surprises |
| **Adaptive** *(SignalFlow)* | **Max-pressure**: serve the phase with the largest queue pressure ([Varaiya 2013](docs/references.md)), plus min-green, switch hysteresis, early exit for empty queues | live queues of every movement, every second | ✓ | uneven & shifting demand; −24 to −81 % delay | needs detection; limited under oversaturation |
| **Coordinated (green wave)** | common cycle + platoon-timed offsets along the corridor (MAXBAND idea, [Little et al. 1981](docs/references.md)) | corridor geometry & travel times (static) | ✗ | clean arterials (Riem: 70.5 s) | loses in dense multi-flow grids (Altstadtring) |
| **Tuned\*** (detector plan) | fixed plan tuned from **real counts**: stop-line counts → OD estimate ([Cascetta 1984](docs/references.md)) → green splits | historical detector counts | ✗ | beats even adaptive on short-link grids (Berlin, Hamburg) | rigid — a construction site or event is invisible to it |

One-line takeaway: **adaptive wins almost everywhere — but not always against
a plan that has learned from real data. We show exactly that instead of
hiding it.**

## 3. Architecture — from the map to the answer

### 3.1 Components & data flow

SignalFlow is **one Python process (standard library only) plus two static
dashboards** — no install, no build step, no CDN (ADR 1,
[docs/design-decisions.md](docs/design-decisions.md)). Everything runs on a
judge's laptop with a single command:

| Layer | Component | Role |
|---|---|---|
| **Data** | `data/regions/*.json` | compiled OSM graphs (committed, ODbL) — the demo does not depend on a live Overpass |
| **Simulation cores** | `signalflow/simulation.py` · `network.py` | junction vs. district model (§3.3); four and five strategies on identical traffic |
| **API** | `server.py` | static files + JSON endpoints; result cache (RAM + disk, keyed by request hash), `SIM_LOCK` serialises heavy runs (5 concurrent clients tested) |
| **Explainability** | `signalflow/agent.py` · `integrations.py` | explain/agent/TTS with deterministic offline fallbacks and an anti-hallucination gate (§5) |
| **Frontend** | `web/` | two dashboards sharing one visual language: strategy toggles, KPI matrix, time series with clock zoom, decision protocol, junction drilldown |

Data flow at a glance (full diagram:
[docs/architecture.svg](docs/architecture.svg) ·
[docs/architecture.md](docs/architecture.md)):

```
 OpenStreetMap (Overpass) ──► data/regions/*.json ──► network.py ──┐
 Demand: Poisson model or sensor CSV ──► simulation.py ────────────┤
                                                                   ▼
        ┌──────────────────────── server.py ────────────────────────┐
        │  cache (RAM + disk) · SIM_LOCK · LAST / LAST_NETWORK      │
        └───────────────────────────────────────────────────────────┘
          ▲                    ▲                    ▲
   POST /api/simulate   POST /api/simulate_network   POST /api/agent
   GET  /api/config     GET  /api/regions            POST /api/explain · /api/tts
          ▲                    ▲                    ▲
    junction dashboard    district dashboard    Featherless (LLM) · ElevenLabs (TTS)
```

Two details that matter in the demo moment: the dashboards are **static
files** calling relative URLs — no build/CORS issues; and the server keeps
the last result per page (`LAST` / `LAST_NETWORK`) separately, so the LLM
agent always explains **the run currently on screen**, even with both pages
open.

### 3.2 Fair comparison as an architectural principle

The four-way contest from §2 is not a presentation choice — it is baked into
the core: `run_scenario` (junction) and `run_region` (district) generate
**one** arrival stream from the seed and run every strategy against it, so
KPI differences can only come from the control. Both are pure functions of
`(config, seed)`: running twice yields identical numbers (asserted in the
test suite). The disk cache makes repeated demo runs instant; warm-up before
the time window (15 min junction / 5 min district) is excluded from all KPIs.

### 3.3 The two simulation cores

**Single junction.** A discrete-time queueing model at a 1-second step: four
approaches × (left / through / right) = 12 movements, Poisson arrivals with a
time-of-day profile (rush hour, holidays, weekend), saturation-flow service
(1 800 veh/h/lane, PCE-weighted for trucks/buses), four protected phases.
Delay = Σ queue · dt; CO₂ is an idling-time proxy.

**District.** A mesoscopic **link-queue model** on the real OSM graph: every
directed link carries a free-flow travel bucket and a stop-line queue;
discharge is limited by saturation flow, downstream storage (spillback, soft
cap) and the signal phase. Demand is a gravity OD matrix routed with
Dijkstra; turning fractions and a per-link exit share distribute and
terminate trips. Baseline: a fixed 60 s two-phase cycle; alternative:
max-pressure **per junction**; the green wave puts a common cycle and
travel-time offsets (× 0.95) on the longest corridors; Tuned\* retimes the
splits from counts (§4). Networks: **Messe/ICM Riem** (355 nodes / 569
links / 58 signals), **Altstadtring** (2597 / 4159 / 708), plus Berlin
Mitte, Hamburg Innenstadt, Köln, Heidelberg and more — further regions
loadable live via OSM Overpass.

## 4. Results

**Single junction** (30 min peak, identical traffic):

| Metric | Fixed-Time | Adaptive | Δ |
|---|---:|---:|---:|
| Average delay / vehicle | 53.9 s | **40.7 s** | **−24.5 %** |
| Throughput | 4 365 veh/h | 4 410 veh/h | +1.0 % |
| Wasted green | 374 s | 118 s | −68.4 % |
| Idling CO₂ proxy | 136 951 g | 103 399 g | −24.5 % |

Across a demand sweep (0.8–1.1×): mean delay reduction **39.9 %** (54.8 %
uncongested, 16 % oversaturated).

**District** (15 min peak, real OSM networks; the Tuned\* column is the
count-based variant, [docs/results.md](docs/results.md) §3.1):

| Region | Signals | Fixed | Adaptive | Coordinated | Tuned\* (from counts) |
|---|---:|---:|---:|---:|---:|
| München — Messe/ICM Riem | 58 | 184.8 s | 92.9 s | **70.5 s (−61.9 %)** | 105.7 s (−42.8 %) |
| München — Altstadtring | 708 | 266.5 s | 94.2 s (−64.6 %) | 111.0 s | **81.4 s (−69.5 %)** |
| Berlin — Mitte | 204 | 189.1 s | 68.9 s (−63.6 %) | 69.8 s | **57.2 s (−69.8 %)** |
| Hamburg — Innenstadt | 173 | 109.5 s | 38.4 s | 38.2 s (−65.1 %) | **28.3 s (−74.2 %)** |
| Köln — Innenstadt | 102 | 150.6 s | **47.4 s (−68.5 %)** | 58.0 s | 48.9 s (−67.5 %) |
| Heidelberg — Uni | 81 | 236.3 s | 44.5 s (−81.2 %) | 75.5 s | **39.9 s (−83.1 %)** |

**Honesty box.** The table shows it live: the detector-tuned plan **Tuned\***
wins four of six networks (Altstadtring, Berlin, Hamburg, Heidelberg) — and
it does so from an **estimate**, not the true demand: 80–100 % of the
oracle's improvement is recovered from pure counts
([docs/results.md](docs/results.md) §3.1). With the opt-in Webster cycle,
adaptive beats the oracle plan on Riem (+8.2 %) and Köln (+2.5 %) for the
first time (§3.2 there). Strong baselines and visible losses are part of
being honest — adaptive wins on average, but not always and not everywhere.

## 5. Explainability

Explainability starts in the dashboard, not at the LLM: the junction logs
every phase switch with its reasoning and pressures; the district protocol
shows the top congested links (click opens the junction view) and each
strategy's plan — the fixed plan, the green-wave corridor offsets, the fit
quality of the OD estimate behind Tuned\*. The KPI matrix shows every
improvement *and* every loss against Fixed.

Beyond that, `/api/explain` turns the log
into prose (Featherless, OpenAI-compatible) and `/api/tts` speaks it
(ElevenLabs) — without keys a deterministic offline explainer answers and
voice is disabled. Beyond narration, **`/api/agent` is agentic**: it plans
tool calls (`simulate`, `simulate_network`, `compare`, `explain_last`) over a
provider-portable protocol, executes them against the real simulator and
shows the full trace in the UI — answers come from runs, not from the
model's imagination. A **three-role self-check** (`mode:"panel"`) goes
further: analyst → critic (verifies numbers *and* the question's premise) →
writer, with an anti-hallucination rule enforced in code.

## 6. The engineering story (what actually took the time)

1. **The first adaptive controller was worse than fixed** (+57 % delay): it
   switched so often that clearance time ate the green budget (245 s vs
   92 s). Fix: min-green, hysteresis, early exit only for empty phases,
   calibration on a demand grid. Lesson: *“adaptive” is not automatically
   better.*
2. **The OD matrix silently lost 60 % of demand** — unreachable entry→exit
   pairs on the directed graph were dropped. Fix: keep reachable pairs,
   renormalise to the target demand.
3. **Arrived vehicles kept driving** — aggregate turning fractions sent
   terminating trips in circles. Fix: an explicit exit share per link.
4. **Two-way streets deadlocked** — hard storage limits jammed link pairs
   permanently. Fix: a soft cap (× 1.35).
5. **An aliasing bug hid behind a lucky test** — the compiler resolved node
   ids via the link-id map; the test grid's id spaces overlapped by chance.
   On real data every junction vanished.

Each is an ADR in [docs/design-decisions.md](docs/design-decisions.md).

## 7. Honest limitations

* Mesoscopic, not microsimulation: no car-following, lane-changing or gap
  acceptance.
* CO₂ is an idling proxy; saturation flow (1 800) and the PCE table are
  plausible defaults, not calibrated (cf. Tarko et al., ~8–10 % error in
  practice).
* The detector feed is a modelling assumption (counts as a *demand source*);
  closed-loop feedback (SCOOT/SCATS-style) is future work.
* The OD *generator* stays synthetic (gravity); OD *estimation* from counts
  is implemented (Tuned\*).
* Pedestrians and cyclists are not modelled.
* The district model is fully deterministic (flow-based, no stochastic
  arrivals) — the seed only affects the junction model; stochastic
  network arrivals are follow-up work.

## Data basis — what is real and what is assumption

Every one of these assumptions is proper for a simulation — we state them openly:

| Ingredient | Status | Source / handling |
|---|---|---|
| Street networks (6+ regions) | **real** | OpenStreetMap via Overpass (ODbL); more places loadable live |
| Vehicle demand | **assumption** | synthetic: gravity OD / Poisson rates with time-of-day profiles — plausibility rules, no measured series |
| Signal plans (fixed baseline) | **assumption** | generic handbook plan (36/10/32/8 s / 60 s two-phase), **not** Munich's real plans |
| Saturation flow & PCE | **rule of thumb** | 1 800 veh/h/lane (HCM ballpark 1 900), uncalibrated PCE table; ±8–10 % even in practice (Tarko et al.) |
| Sensor feed | **synthetic** | briefing dataset not public → same-shape stand-in; adapter for real exports (`arrival_csv`) |
| Comparisons | **fair** | identical seed and arrivals — differences come only from the control policy |

## Outlook — time-, day- and traffic-dependent control

First step built — and considerably extended: the **time-of-day window** in
both dashboards sets scenario and span (the scenario proposes the window,
everything stays editable), and the **demand follows the real clock** inside
it — a 07:00–18:00 rush window now reproduces both commute waves. A **warm-up**
period (15 min junction / 5 min district) runs before the window and is
excluded from the KPIs: the simulation starts "in traffic", not empty. The
junction comparison now runs **all four strategies** on identical arrivals;
Tuned derives a Webster plan per time-of-day bucket (a multi-period plan, as
in real practice). The research question behind it: control that reacts not
only to *traffic* but to **time and day of week** — our measurements suggest
adaptive wins on the day average and at rush on an isolated junction, the
green wave on corridors (district view), tuned plans in quiet off-peak. Open
questions: stochastic time-series arrivals in the district model (today
flow-based deterministic), per-junction strategy selection over the day with
switching hysteresis, and calibration against real count series. The signal
timers are the easy part — the control logic is the research object. A natural
next step in the UI: a **week view** (Mon–Sun profile, one day type each), from
which the per-day strategy choice could be read off directly.

## 8. References

> Transparency: this literature grounding was compiled **after** the first
> working version. We cite what the design leans on and mark where we
> simplify. Our numbers are model output, not literature-validated results.
> Full table: [docs/references.md](docs/references.md).

* **Varaiya, P. (2013).** *Max pressure control of a network of signalized
  intersections.* Transportation Research Part C, 36, 177–195. — basis of the
  adaptive controller (ours: lane-normalised queues instead of downstream
  weighting, plus hysteresis/min-green).
* **Webster, F. V. (1958).** *Traffic Signal Settings.* Road Research
  Technical Paper No. 39, HMSO. — the classical fixed-time logic of our
  baseline.
* **Little, J. D. C. et al. (1981).** *MAXBAND.* — progression/green wave;
  our offsets are travel-time-based (× 0.95), not a bandwidth LP.
* **Levin, M. W. (2019).** *Max-pressure signal control with cyclical phase
  structure.* — inspiration for the cycle-constrained variant.
* **Cascetta, E. (1984); Cascetta & Nguyen (1988); Dey et al. (2020).** OD
  estimation from link counts — basis of the detector plan (Tuned\*).
* **Hunt et al. (1982, SCOOT); SCATS** — deployed adaptive systems (stop-line
  detectors); our feed is a demand source, not yet feedback.
* **FHWA / HCM** — saturation flow (1 900 pc/h/ln) & PCE concept; we use 1 800
  veh/h/lane and an uncalibrated PCE table. **Tarko et al.** on prediction
  uncertainty.
* **NCHRP Report 572; Kimber (TRL); Song et al. (2022)** — roundabout
  capacity & gap acceptance (deliberately approximated here).


## Tools & thanks

**AI disclosure.** Development was agent-assisted: Claude Code harness (models
**GLM-5.3** and **GLM-5.3-flash**), plus **Pi Harness** and **AutoClaw Harness**. Every number in
this writeup comes from simulator runs; in-code number gates reject unsupported
claims.

**Thanks** to the **OpenStreetMap contributors** (ODbL) for the real street
networks, to **Featherless** (LLM API for explanations & the agent) and
**ElevenLabs** (voice), and to the MunichTech EXPO team.

## 9. Run it & read more

```bash
python3 server.py        # or ./run.sh  →  http://127.0.0.1:8000
python3 -m unittest discover -s tests     # 116/116 green
```

| Where? | What you'll find |
|---|---|
| [GitHub: derKosi/SignalFlow](https://github.com/derKosi/SignalFlow) | the whole repository |
| [README](README.md) | quickstart & headline numbers |
| [docs/architecture.md](docs/architecture.md) | system design & data flow |
| [docs/model.md](docs/model.md) | models, units, assumptions |
| [docs/controllers.md](docs/controllers.md) | controllers & calibration |
| [docs/results.md](docs/results.md) | all numbers & reproduction |
| [docs/references.md](docs/references.md) | literature table (with links) |
| [docs/design-decisions.md](docs/design-decisions.md) | the ADR log |
| [DEMO.md](DEMO.md) · [SUBMISSION.md](SUBMISSION.md) | demo script · submission texts |

*Code licence: PolyForm Noncommercial 1.0.0 · OSM data: ODbL 1.0
(© OpenStreetMap contributors).*
