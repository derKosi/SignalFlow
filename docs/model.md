# Simulation models

Two models share one idea: **queue at the stop line, discharge when green**.
Both are deterministic given a seed and run at dt = 1 s.

* `signalflow/simulation.py` — one signalised 4-way junction (queueing model).
* `signalflow/network.py` — a district of many junctions (mesoscopic link-queue model).

---

## 1. Junction model (`simulation.py`)

### Geometry & demand
* 4 approaches `{N,E,S,W}` × 3 movements `{L,T,R}` → **12 movements**.
* Protected left turns; phases:

| Phase | Green movements |
|---|---|
| `NS_THRU` | N-T, N-R, S-T, S-R |
| `NS_LEFT` | N-L, S-L |
| `EW_THRU` | E-T, E-R, W-T, W-R |
| `EW_LEFT` | E-L, W-L |

* Demand per movement is a rate in veh/h. Per step, arrivals are
  `Poisson(λ)`, `λ = rate · demand_multiplier · profile(t) / 3600 · dt`.
* `profile(t)`: `flat` → 1.0; `peak` → `0.6 + sin(π·t/(T−1))` (a rush-hour hump).

### Service & queueing
* Saturation flow 1800 veh/h per lane → a green movement serves
  `lanes · 1800/3600 · dt = 0.5 · lanes` veh per second (default `lanes = {T:2, L:1, R:1}`).
* Per step: add arrivals to queues → controller picks the green set → for each
  green movement `served = min(queue, capacity)`.

### Metrics
| Metric | Definition |
|---|---|
| `avg_delay_s` | `Σ(queue)·dt / arrived` — mean stopped delay per vehicle |
| `throughput_vph` | served vehicles per hour of simulated time |
| `wasted_green_s` | green seconds where every green movement had an empty queue |
| `co2_g` | `1.15 g/s · Σ(queue)·dt` — idling emission proxy |
| `stops` | arrivals that joined a non-empty lane |

### Demand scenarios, vehicle mix & bus priority (junction)

* **Scenario** (`demand_scenario`): shapes the within-day demand and scales it.
  | id | multiplier | profile | mean |
  |---|---:|---|---|
  | `normal` | 1.00 | single hump | 1.24× |
  | `berufsverkehr` | 1.70 | two rush peaks (`commute`) | 1.40× |
  | `ferien` | 0.70 | flat | 0.70× |
  | `freizeit` | 0.90 | midday hump (`leisure`) | 0.70× |
  | `custom` | 1.00 | uses `demand_profile` | – |
  Effective demand = `demand × demand_multiplier × scenario_multiplier × profile(t)`.
* **Vehicle mix** (`vehicle_mix`, e.g. `{"car":0.86,"van":0.06,"truck":0.06,"bus":0.02}`):
  each class has a passenger-car equivalent (car 1.0, van 1.3, truck 2.2, bus 2.6);
  the effective saturation flow becomes `1800 / PCE_avg`. Default is `{"car":1.0}`
  (pure cars) so the headline numbers stay identical; heavier mixes reduce capacity.
* **Bus priority / TSP** (`transit_priority`, `bus_headway_s`): buses arrive on the
  highest-demand movements at a mean headway (±25 % jitter), charged their PCE in
  the queue. The adaptive controller then (a) extends green by up to 8 s to clear a
  bus already on green, and (b) preempts — switches to a phase holding a waiting
  bus after min-green. The fixed-time baseline ignores buses. Bus delay is reported
  as `avg_bus_delay_s`.

### Output

### Traffic realism (what is / isn't modelled)

* **Right turns run with the through phase** (N-R, S-R are green in `NS_THRU`, etc.) — as in reality.
* **Left turns are protected**: they have their own phase (`NS_LEFT`, `EW_LEFT`) and never
  run concurrently with the opposing through traffic — so a left-turner always waits
  until the opposing straight traffic has been served. *Permissive* lefts (gap
  acceptance / yield) are **not** modelled; that belongs to the junction-type library.
* On the canvas, vehicles now follow their **true turning path** — straight through,
  a right-hand quarter arc, or a left-hand arc — and are rotated along their direction
  of travel instead of sliding sideways.
A payload with per-movement `frames` (for the animation), `decisions` (the
adaptive controller's switch log with pressures), summary KPIs for both
controllers, and the improvement deltas.

---

## 3. Junction types

The junction model is not hard-wired to a 4-arm cross; `junction_type` selects a
spec (arms, movement set, phases, capacity model):

| type | arms | movements | control |
|---|---|---:|---|
| `cross4` (default) | N,E,S,W | 12 | 4 phases, **protected** lefts |
| `cross4_permissive` | N,E,S,W | 12 | 2 phases; lefts clear **permissively** (yield, ~45 % of saturation flow while the opposing through has queue) |
| `t3` | E,W,N | 6 | 3 phases (major through, minor, west-left) |
| `roundabout` | N,E,S,W | 12 | **no signals** — yield; entry capacity from an HCM-style formula `c = 1130·exp(−1e−3·C)`, `C` ≈ conflicting flow |

For a roundabout the comparison becomes **Signalanlage vs Kreisverkehr** on the same
demand (`reference_label` / `alternative_label` in the payload).

**Typical result (single junction, 20 min):**

| type | reference | alternative | note |
|---|---:|---:|---|
| cross4 | 43.7 s | 31.3 s adaptive | protected lefts, 4 phases |
| cross4_permissive | 21.4 s | 9.7 s adaptive | fewer clearance losses |
| t3 | 15.9 s | 9.3 s adaptive | 3 arms only |
| roundabout @ Last 0.7 | 34.1 s | **4.6 s** roundabout | roundabout wins when uncongested |
| roundabout @ Last 1.0–1.3 | 43.7 / 74.7 s | **107 / 254 s** roundabout | loses badly when saturated |

That last row is the real-world trade-off: a roundabout beats signals at low flow
and collapses at high flow. **Honest caveat:** the roundabout capacity is a crude
analytic estimate (documented), not a calibrated gap-acceptance model.

## 4. District model (`network.py`)

### Graph (from OpenStreetMap)
Nodes = junctions (coordinates shared by ≥2 ways, way endpoints, or nodes with a
traffic light within 15 m). Directed links carry `length_m`, `lanes`, `speed_kph`,
`oneway`, `hw`, `name`. Reverse links are generated for two-way streets.

### Link parameters
| Quantity | Value |
|---|---|
| Free-flow travel steps | `tff = round(length_m / (speed_kph/3.6))` (≥1) |
| Storage capacity | `cap = length_m / 6.0 · lanes` vehicles (jam spacing 6 m) |
| Discharge (green) | `0.5 · lanes` veh/s (saturation flow) |
| Soft storage cap | `cap · 1.35` — prevents cyclic deadlock (see ADR-4) |

### Demand: gravity OD + Dijkstra
1. **Gateways**: candidate entry/exit links are boundary links (dead-end or
   outside the bbox). The **24 highest-capacity** gateways per direction are kept —
   this both avoids hundreds of residential dead-ends and keeps the OD problem small.
2. **Weights**: `weight = lanes · speed`; OD flow for pair (i,j) is proportional to
   `w_i · w_j`.
3. **Reachability**: only pairs that are actually connected (Dijkstra on the
   *directed* graph) receive flow; the remaining weights are renormalised so the
   **total demand is preserved** (see ADR-3).
4. **Routing**: shortest path by free-flow time; walk each route to accumulate
   per-link **turning fractions**.
5. **Exit share**: for each link, `exit_share = (flow ending here) / (total flow
   through the link)` — the fraction of a link's discharge that *leaves the
   network* rather than continuing (see ADR-5).

### Time step
1. **Spawn** at entries at `rate · demand_multiplier · profile(t)/3600`, limited by
   entry free storage (blocked entries retry next step).
2. **Advance** the delay lines: each link pops one travel bucket into its queue.
3. **Control**: each signalised junction sets its green set.
4. **Discharge**: for each green link, `take = min(queue, discharge, downstream_space)`;
   `take · exit_share` leaves (counted as a completed trip), the rest is split onto
   downstream links by turning fractions (spillback-limited).
5. Only **active** links (carrying vehicles) are stepped — a large speed-up on
   sparse networks. Running totals replace O(links) sums.

### Junction control in the district
* Two phases per junction, derived from the dominant approach axis (N–S vs E–W).
* `FixedJunction`: 60 s cycle, 30 s / 3 s yellow / 30 s / 3 s yellow.
* `AdaptiveJunction`: max-pressure with min 12 s / max 50 s green, 3 s yellow,
  1 s all-red, hysteresis 1.6, early exit for empty phases.

### Metrics
`served` (completed trips), `spawned`, `in_network_at_end`, `throughput_vph`,
`avg_delay_s` (`Σ(queue)/served`), `avg_travel_time_s` (Little's law:
`Σ(in-network)·dt / served`), `corridor_delay_s` (mean queue delay on the
coordination-corridor links), `co2_g`.

**Transit priority (network).** With `transit_priority` the corridor's main axis
gets a pressure bonus at the junctions along the corridor — a corridor-level TSP
abstraction (watch `corridor_delay_s`). The junction model does per-bus TSP instead.

---

## Assumptions & limitations (stated, not hidden)

* **Macroscopic / mesoscopic**, not a per-vehicle microsimulation: no car-following,
  no lane changing, no gap acceptance at unsignalised nodes (they are always green).
* **No inter-junction coordination** (no green waves); every junction is independent.
* **Left turns** are modelled as separate movements at the junction; in the district
  they are folded into the two-axis phase (no protected-left timing).
* **CO₂** is an idling-time proxy, not a calibrated emission model.
* Network demand is a **synthetic gravity OD**; the briefing's real detector data
  would replace it via the sensor-feed loader (see [data.md](data.md)).
* Storage/discharge parameters use standard traffic-engineering rules of thumb
  (6 m jam spacing, 1800 veh/h/lane) rather than calibrated local values.
