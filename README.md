# SignalFlow

**Adaptive, explainable traffic-signal control.** SignalFlow replaces a fixed
time-of-day signal plan with a live *queue-pressure* controller and proves the
gain in a before/after dashboard — then explains every decision in plain
language (and out loud).

Built for the **MunichTech EXPO Hackathon 2026** challenge
*“Smart Cities: Adaptive Traffic Flow”* — a Munich intersection whose signal
timing is fixed rather than responsive.

> Zero dependencies. Python 3.11+ standard library only. No `pip install`, no build step.

## 🎬 Live demo

**<https://signalflow.complykit.de>** — hosted, ready to click:

* [Single-junction dashboard](https://signalflow.complykit.de/) — four strategies on identical traffic, decision log, PDF report
* [District simulation](https://signalflow.complykit.de/network.html) — real OSM networks (add your own place live), node drill-down, OSM underlay
* [Writeup](https://signalflow.complykit.de/writeup.html) — switchable DE/EN, simple & detailed, jury view

Both dashboards (junction & OSM network) are fully interactive. The LLM-powered
"explain" panel may fall back to the built-in offline explainer when no API key
is configured on the demo host.

---

## Headline result (default scenario: 30 min, rush-hour peak)

Both controllers face the **identical** arrival stream (same seed), so the
comparison is apples-to-apples:

| Metric | Fixed-time (baseline) | **Adaptive (SignalFlow)** | Change |
|---|---:|---:|---:|
| Average delay / vehicle | 53.9 s | **40.7 s** | **−24.5 %** |
| Throughput | 4365 veh/h | **4410 veh/h** | +1.0 % |
| Wasted green time | 374 s | **118 s** | −68.4 % |
| Max queue | 132 veh | 127 veh | −3.8 % |
| Idling CO₂ proxy | 136 951 g | **103 399 g** | **−24.5 %** |

Across a demand sweep (0.8×–1.1×, flat & peak profiles) the controller delivers a
**39.9 % mean delay reduction** (54.8 % when uncongested, 16 % under
oversaturation). Reproduce: `python3 -m signalflow.simulation`.

---

## Documentation

* **[Writeup](WRITEUP.md)** — the full story (problem → approach → results → limits).
  In four versions: [Deutsch ausführlich](WRITEUP.md) · [Deutsch einfach](WRITEUP.einfach.md) ·
  [English detailed](WRITEUP.en.md) · [English simple](WRITEUP.en-simple.md) —
  also as a rendered, switchable page: **<http://127.0.0.1:8000/writeup.html>**.
* **[Handoff](HANDOFF.md)** — pick this up cold: state, run commands, gotchas, open TODOs.
* **[docs/](docs/README.md)** — architecture, models, controllers, API, data, results,
  design decisions (ADR log), challenge/prize mapping, roadmap, references, submission kit.

---

## Quick start

```bash
cd signalflow
./run.sh                 # or: python3 server.py
# open http://127.0.0.1:8000

# optional: make the demo instant (warm the result cache)
python3 tools/precompute.py
```

Keyboard: **space** = play/pause, **←/→** = scrub, **+/−** = playback speed.
Respects `prefers-reduced-motion`.

Optional keys (the app runs fine without them — see *Getting access* below):

```bash
cp .env.example .env     # then paste FEATHERLESS_API_KEY / ELEVENLABS_API_KEY
```

Run the tests:

```bash
python3 -m unittest discover -s tests -v
```

---

## How it works

```
traffic demand ─┐
                ├─►  identical arrival stream (seeded)  ─┬─► FixedTimeController  ─► metrics
                │                                        └─► MaxPressureController ─► metrics + decision log
                                                                                          │
                          browser dashboard  ◄──  /api/simulate payload (frames + KPIs + reasons)
                          Featherless agent  ◄──  /api/agent   (runs the simulator as a tool)
                          Featherless LLM    ◄──  /api/explain (why? in natural language)
                          ElevenLabs voice   ◄──  /api/tts      (say it out loud)
```

**Model.** A discrete-time (dt = 1 s) queueing model of one signalised 4-way
intersection with protected left turns: 4 approaches × (Left, Through, Right),
Poisson arrivals, saturation-flow service (1800 veh/h/lane; Through has 2 lanes).
It is a macroscopic approximation — honest, fast, and deterministic — not a full
car-following microsimulation (see *Limitations*).

**Controller.** `MaxPressureController` picks the phase with the highest
*pressure* = lane-normalised queue (+ an escalating starvation bonus for
long-waiting movements). It holds a phase until a competing phase clearly beats
it (hysteresis ×3.0), ends a phase early once its queue is empty, and always
respects min-green 24 s / max-green 50 s / yellow 3 s / all-red 1 s.

**Junction types (pick in the dashboard).** The junction model is not a fixed
4-arm cross: choose **Kreuzung (geschützte Linksabbieger)**, **Kreuzung (permissive
Linksabbieger)**, **T-Kreuzung (3 Arme)** or **Kreisverkehr (unsignalisiert)**. For a
roundabout the comparison becomes *Signalanlage vs Kreisverkehr* — and it shows the
real trade-off: the roundabout wins when uncongested and collapses when saturated.
See [docs/model.md](docs/model.md#3-junction-types).

**Demand scenarios, vehicle mix & bus priority.** The junction model ships named
**demand scenarios** — `berufsverkehr` (rush, heavier, two peaks), `ferien`
(holidays, ~30 % less, flatter), `freizeit` (weekend, midday hump) — plus an
optional **vehicle mix** (car/van/truck/bus, PCE-weighted capacity) and **bus
priority (TSP)**. The headline insight: lower demand → much larger *relative* adaptive
gain (Ferien −55 % vs Normal −24 %). See [docs/results.md](docs/results.md#7-season-vehicle-mix--transit-priority-junction).

**Third-party feeds.** A real detector export usually looks different from our
columns, so `tools/adapt_feed.py` auto-detects common shapes (e.g. `timestamp, location, traffic_count`) and normalises them to our feed format — then `arrival_csv` consumes the result unchanged. See [docs/data.md](docs/data.md#1b-adapter-for-third-party-sensor-feeds).

**Explainability.** Every switch is logged with the numbers that caused it, e.g.
`switch NS_THRU→EW_THRU (higher competing pressure): pressure 9.2 vs current 4.1;
worst wait 73 s`. The dashboard lists these; `/api/explain` turns them into prose, and the
**agentic copilot** (`POST /api/agent`) goes further: asked "Was passiert in den
Ferien mit 15 % Lkw?", it *runs the simulator itself* — via a provider-portable,
prompt-based tool protocol with whitelisted arguments — and answers from the real
numbers, showing every tool call in a collapsible step trace.

**Sensor-feed mode.** The challenge asks for control that *“reacts to simulated or
sample sensor/camera feed data”*. Set the data source to **Sensor-Feed (CSV)** in the
dashboard (or `"arrival_source":"csv"` in `/api/simulate`) and the demand comes from
measured detector **counts** instead of the model's own rates. `detector_dropout`
simulates missed detections, so the controller works from a lossy sensor view.
Preview the feed with `GET /api/feed`. The briefing's own dataset is not
redistributable, so we ship a synthetic stand-in with the same shape
(`data/sample_traffic.csv`, regenerate with `data/generate_sample.py`).

### Layout

```
signalflow/
├── server.py                 # stdlib HTTP server + API routing
├── WRITEUP.md · SUBMISSION.md · DEMO.md
├── docs/                     # architecture, model, controllers, api, data, results,
│                             # design-decisions, challenge, operations (index: docs/README.md)
├── signalflow/
│   ├── simulation.py         # single-intersection model, controllers, metrics
│   ├── network.py            # district/network model (OSM link-queue)
│   └── integrations.py       # Featherless + ElevenLabs clients, offline fallback
├── web/                      # dashboards (index.html = junction, network.html = district,
│                             #  writeup.html = rendered writeup)
├── tools/
│   ├── fetch_osm.py          # Overpass download (2 Munich regions)
│   ├── build_regions.py      # raw OSM -> graph JSON
│   ├── verify_regions.py     # sanity checks
│   └── od_experiment.py      # count-based OD + Webster-cycle regional sweep
├── data/
│   ├── generate_sample.py    # synthetic sensor-data generator
│   ├── sample_traffic.csv    # 60 min, 4 315 vehicles, 12 movements
│   ├── osm/                  # raw Overpass responses
│   └── regions/              # compiled graph JSONs (expo_riem, innenstadt)
├── tests/                    # 55 tests (model, controller, feed, network, OD, API)
├── docs/architecture.png     # architecture & control-loop diagram
├── run.sh · .env.example
└── DEMO.md · SUBMISSION.md
```

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | integration status (Featherless / ElevenLabs connected?) |
| GET | `/api/config` | default scenario config |
| GET | `/api/feed` | preview the sensor-count feed (columns + sample rows) |
| GET | `/api/regions` | available districts (OSM graph stats) |
| POST | `/api/simulate` | single junction: baseline vs adaptive → summary, frames, decisions |
| POST | `/api/simulate_network` | district: `{region, duration_min, ...}` → network + summary + frames |
| POST | `/api/agent` | agentic copilot: the LLM runs simulator tools, then answers (with step trace) |
| POST | `/api/explain` | `{"question": "..."}` → natural-language explanation |
| POST | `/api/tts` | `{"text": "..."}` → `audio/mpeg`, or **501** if no key |

### District / neighbourhood simulation (network mode)

Beyond one intersection, SignalFlow simulates a whole **district** on the real
OpenStreetMap street network, selectable per area — six German regions are built in
(Munich ×2, Berlin, Hamburg, Köln and a university city, Heidelberg):

| Region | City / area | nodes | links | signalised junctions |
|---|---|---:|---:|---:|
| `expo_riem` | München — Messe / ICM Riem | 355 | 569 | 58 |
| `innenstadt` | München — Innenstadt / Altstadtring | 2597 | 4159 | 708 |
| `berlin_mitte` | Berlin — Mitte / Alexanderplatz | 846 | 1293 | 204 |
| `hamburg_innenstadt` | Hamburg — Innenstadt / Jungfernstieg | 1136 | 1431 | 173 |
| `koeln_innenstadt` | Köln — Dom & Deutz | 1442 | 1647 | 102 |
| `heidelberg_uni` | Heidelberg — Altstadt / Universität | 609 | 799 | 81 |

City regions use an **arterial scope** (no residential streets) to stay tractable
and focused on signal coordination. Adding a city is one line in
`tools/fetch_osm.py`; all regions appear automatically in the dashboard selector.

**Add a place live.** In the network dashboard, type a place or landmark (e.g.
“Tübingen Zentrum”, “Marienplatz München”) and press *Hinzufügen*: it is geocoded
(Nominatim), fetched from OpenStreetMap and built into a region on the fly, then
simulated. API: `POST /api/regions_add {"query": "…", "span_deg": 0.015}`.

**Licensing:** code is **PolyForm Noncommercial 1.0.0** (source-available,
non-commercial; see [docs/licensing.md](docs/licensing.md) and [LICENSE](LICENSE)).
Map data **© OpenStreetMap contributors, ODbL 1.0** (attribution + share-alike for
the data). Details and the AI-use disclosure in [NOTICE.md](NOTICE.md) —
including a suggested AI-assistance disclosure.

**Model:** mesoscopic *link-queue* approximation. Each directed link has a
free-flow travel bucket and a stop-line queue; discharge is limited by saturation
flow, downstream storage (with a soft overflow to avoid cyclic deadlock) and the
signal phase. Demand is a gravity-style entry→exit OD matrix routed with Dijkstra;
per-link turning fractions split the flow, and each link carries an *exit share*
for terminating trips. Fixed 60 s two-phase plan vs max-pressure, per junction.

**Results** (peak, identical demand for both policies). Four policies are compared:
fixed (50/50), **fixed_tuned** (demand-proportional splits, an oracle), **adaptive**
(district: measured-inflow demand-proportional splits, Webster/SCATS-like), and
**coordinated** (green wave on the longest arterials):

| Region | Fixed delay | Adaptive delay | Coordinated delay |
|---|---:|---:|---:|
| München — Riem | 184.8 s | 92.9 s | **70.5 s (−61.9 %)** |
| München — Altstadtring | 266.5 s | **94.2 s (−64.6 %)** | 111.0 s (−58.4 %) |
| Berlin — Mitte | 189.1 s | **68.9 s (−63.6 %)** | 69.8 s (−63.1 %) |
| Hamburg — Innenstadt | 109.5 s | 38.4 s (−65.0 %) | **38.2 s (−65.1 %)** |
| Köln — Innenstadt | 150.6 s | **47.4 s (−68.5 %)** | 58.0 s (−61.5 %) |
| Heidelberg — Uni | 236.3 s | **44.5 s (−81.2 %)** | 75.5 s (−68.1 %) |

**Green waves are a trade-off, and we say so:** a rigid band on a clean arterial
wins (Riem), while in dense multi-flow grids fully adaptive control wins. Both beat
the fixed plan in every region.

**Fair baseline — an honest surprise.** Against a **demand-tuned** fixed plan
(`fixed_tuned`, splits proportional to routed demand) the adaptive advantage largely
vanishes. We improved the district controller in response (measured-inflow splits):
the gap vs the oracle-tuned plan narrowed from −11.5 %/−25.5 % to **−8.1 %/−7.9 %**
(Riem/Altstadtring, load 1.0), and on Riem the coordinated policy is **level with the
tuned plan (−1.2 %)**.

**From detector counts to a tuned plan — no oracle.** Since the oracle baseline is
unfair to real cities, every district run now also derives a plan from **simulated
stop-line detector counts** (`fixed_tuned_est`, the “Tuned\*” KPI row): counts →
Richardson-Lucy OD estimate → tuned splits. It recovers **80–100 % of the oracle's
improvement** (Hamburg 99 %, Heidelberg ~100 %, Altstadtring 97 %, Riem 80 %) even
though the OD matrix itself is not identifiable from counts — the per-junction
split *ratios* it needs are (median error 0.0 pp). With the opt-in Webster cycle
(`webster_cycle:true`) adaptive then **beats the demand-oracle on Riem (+8.2 %) and
Köln (+2.5 %)** — while short-link grids (Hamburg, Berlin) prefer the base cycle, so
it stays off by default. Reproduce: `python3 tools/od_experiment.py`; details in
[docs/results.md](docs/results.md#31-count-based-od-estimation--the-detector-only-tuned-plan-fixed_tuned_est).

Reproduce the region graphs with `python3 tools/fetch_osm.py && python3 tools/build_regions.py`
(data source: OpenStreetMap via Overpass; the Swiss mirror is CH-only, so the
script uses a reachable mirror). Region data lives in `data/regions/`.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | integration status (Featherless / ElevenLabs connected?) |
| GET | `/api/config` | default scenario config |
| GET | `/api/feed` | preview the sensor-count feed (columns + sample rows) |
| POST | `/api/simulate` | run baseline vs adaptive → summary, frames, decisions |
| POST | `/api/agent` | agentic copilot: the LLM runs simulator tools, then answers (with step trace) |
| POST | `/api/explain` | `{"question": "..."}` → natural-language explanation |
| POST | `/api/tts` | `{"text": "..."}` → `audio/mpeg`, or **501** if no key |

Config knobs: `duration_min`, `seed`, `demand_multiplier`, `demand_profile`
(`peak`/`flat`), `arrival_source` (`model`/`csv`), `detector_dropout`, per-movement
`demand`, `lanes`, `fixed_greens`, and the adaptive controller's `min_green`,
`max_green`, `switch_hysteresis`, `starve_seconds`. District runs additionally take
`od_estimation` (default on) and `webster_cycle` (opt-in, default off — wins on
saturated arterials, loses on short-link grids).

---

## Getting access to the sponsor tools (ElevenLabs & Featherless)

Both are **optional**; SignalFlow degrades gracefully. To unlock the voice layer
and free-form explanations *and* become eligible for the two sponsor prizes:

**ElevenLabs** (powers “🔊 Speak”)
1. Sign in at <https://elevenlabs.io> → **Workspace settings → API Keys → Create API Key**.
2. The API authenticates with the `xi-api-key` header; the free tier includes
   monthly character credits — enough for a demo.
3. Hackathon perk: the brief lists **3 months free Creator** for all participants
   and **6 months Scale** for “Best Project Built with ElevenLabs”. Claim it via
   the organizers' promo link / the MunichTech EXPO sponsor resources
   (Devpost *Updates*, the event Discord, or the sponsor booth) and redeem it on
   your ElevenLabs account.
4. Paste the key into `.env` as `ELEVENLABS_API_KEY`.

**Featherless.ai** (powers “Ask SignalFlow”)
1. Sign up at <https://featherless.ai> → dashboard → **API key**.
2. It is **OpenAI-compatible**: base URL `https://api.featherless.ai/v1`,
   use `Authorization: Bearer <key>`. SignalFlow calls
   `POST /chat/completions` (default model `Qwen/Qwen2.5-7B-Instruct`; change
   `FEATHERLESS_MODEL` to any catalogue id).
3. Hackathon perks: **$300 credits** for “Best Project Built with Featherless”
   and **$25/request credits** for all participants — the brief notes a *private
   setup guide*, so get the code/link from the organizers (same channels as above).
4. Paste the key into `.env` as `FEATHERLESS_API_KEY`.

Without a key the app still works: the explainer falls back to a deterministic
rule-based summary and the voice button reports “not configured”.

---

## Challenge details (verified against the challenge page/API)

*“Smart Cities: Adaptive Traffic Flow”* (slug `smart-cities-traffic-flow-2026`, track
`smart_cities`, owner: MunichTech EXPO Urban Mobility Track)

- **Expected solution:** “A simulation or prototype demonstrating adaptive
  signal-timing logic reacting to simulated or sample sensor/camera feed data, with
  a visual dashboard showing before/after flow improvement.” → covered (see
  *Sensor-feed mode*).
- **Technical requirements:** simulation-based is fine, no real hardware, any stack.
- **Evaluation criteria:** measurable flow improvement in simulation · realism of the
  approach · technical execution · demo quality.
- **Dataset:** “sample open traffic-sensor dataset … provided at the briefing” — not
  publicly downloadable (the `/downloads/...` URLs only return the app shell), hence
  our synthetic stand-in.
- **Team size:** 1–5. **Challenge deadline:** 2026-09-20 (platform submission window
  closes 2026-09-21 23:30 CEST; public voting 2026-09-20 09:00 → 2026-09-21 17:00).

**Challenge criteria → what we built**

| Challenge asks for | SignalFlow delivers |
|---|---|
| “reacts to … simulated or sample sensor/camera feed data” | CSV sensor-count feed (`arrival_source=csv`, `/api/feed`, detector dropout) |
| “Adapt signal timing to live conditions” | queue-pressure controller with starvation guard & clearance-aware holding |
| “Measurable flow improvement in simulation” | seeded A/B vs baseline: **−24.5 % delay**, **−68 % wasted green** |
| “Visual dashboard showing before/after” | canvas intersection replay, KPI deltas, before/after bars, delay timeline |
| “Realism of the approach” | saturation-flow queueing model, min/max green, clearance times, rush-hour ramp, lossy detectors |
| “Technical execution / Demo quality” | zero-dep single-command run, 55 tests, live explain + voice |

## Why this can win

**Also aimed at the sponsor prizes:** the voice layer (ElevenLabs) and the LLM
explainer (Featherless) are first-class features, not add-ons → direct entries for
*Best Project Built with ElevenLabs* and *Best Project Built with Featherless*.

**Devpost judging map:** Problem relevance & impact ✓ (real Munich congestion);
Technical excellence ✓ (tuned controller + tests); Innovation ✓ (explainable
max-pressure + NL interface); Applicability & scalability ✓ (drop-in for any
signalised junction, per-junction config); Presentation ✓ (DEMO.md script).

---

## Limitations (stated honestly)

- Macroscopic queueing model, not microsimulation — no lane-changing, no
  spillback between upstream junctions, no pedestrians/cyclists.
- Single isolated intersection; coordination across a corridor is future work.
- Arrival rates are configurable scenarios; the sample dataset is synthetic
  (see `data/generate_sample.py`) because the briefing dataset is not redistributable.
- CO₂ is an idling-time proxy, not a calibrated emission model.
