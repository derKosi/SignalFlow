# Results

All numbers are reproducible from the committed code and data with the base
config (peak profile, seed 42) and are deterministic.

## 1. Single junction — 30 min, rush-hour peak

Identical arrival stream for both controllers.

| Metric | Fixed-time | **Adaptive** | Change |
|---|---:|---:|---:|
| Average delay / vehicle | 53.86 s | **40.67 s** | **−24.5 %** |
| Throughput | 4365 veh/h | 4410 veh/h | +1.0 % |
| Wasted green time | 374 s | 118 s | −68.4 % |
| Max queue | 132 veh | 127 veh | −3.8 % |
| Idling CO₂ proxy | 136 951 g | 103 399 g | −24.5 % |

Reproduce:
```bash
python3 -c "from signalflow.simulation import run_scenario; import json; \
print(json.dumps(run_scenario({'duration_min':30})['improvement'], indent=2))"
```

### Demand sweep (robustness)
Mean delay reduction over `demand_multiplier ∈ {0.8…1.1}` × `{flat, peak}`:

| | Value |
|---|---:|
| Mean over the grid | **39.9 %** |
| Best (uncongested, ~0.8× flat) | 54.8 % |
| Worst (oversaturated, 1.1× peak) | 16.1 % |

The gain is largest when there is spare capacity and shrinks under oversaturation —
as expected, because under heavy oversaturation all control policies approach the
same discharge bottleneck.

## 2. Sensor-feed mode (junction)

Same controller, demand from measured counts instead of model rates:

| Demand source | Fixed delay | Adaptive delay | Δ |
|---|---:|---:|---:|
| Model (Poisson) | 53.9 s | 40.7 s | −24.5 % |
| Sensor CSV feed | 42.3 s | 34.2 s | −19.2 % |
| Sensor CSV + 15 % detector dropout | 37.5 s | 23.6 s | −37.0 % |

## 3. District — 15 min peak, real OSM network

| Region | Junctions | Fixed delay | **Adaptive** | **Coordinated (green wave)** | Δ adaptive | Δ coordinated |
|---|---:|---:|---:|---:|---:|---:|
| Messe München / ICM Riem | 58 | 184.8 s | 92.9 s | **70.5 s** | −49.7 % | **−61.9 %** |
| Innenstadt / Altstadtring | 708 | 266.5 s | **94.2 s** | 111.0 s | **−64.6 %** | −58.4 % |

Throughput: Riem +16 % (adaptive) / +19 % (coordinated); Altstadtring +25.7 %
(adaptive) / +22.8 % (coordinated). **Read this honestly:** a rigid green wave
helps on a clean arterial (Riem) and can hurt in a dense multi-flow grid
(Altstadtring), where fully adaptive control wins. Both coordinated and adaptive
defeat the fixed plan.

Reproduce:
```bash
curl -s -XPOST localhost:8000/api/simulate_network \
  -d '{"region":"innenstadt","duration_min":15}' -H 'Content-Type: application/json' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['improvement'])"
```

### 3.1 Count-based OD estimation — the detector-only tuned plan (`fixed_tuned_est`)

The `fixed_tuned` baseline is an **oracle** (it sees the true routed demand). Real
cities only have **detector counts**. We now close that loop: the `fixed` run
records stop-line counts, a Richardson-Lucy (EM) estimator recovers the OD matrix
on the free-flow route set (`signalflow.network.estimate_od`), and a plan is tuned
on the **estimate** (`fixed_tuned_est`, in every `/api/simulate_network` payload —
KPI row **“Tuned\*”** in the dashboard). No oracle knowledge involved.

| Region (15 min, load 1.0) | oracle tuned | **tuned from counts** | gap to oracle | OD count-fit err | oracle gain recovered |
|---|---:|---:|---:|---:|---:|
| Hamburg — Innenstadt | 27.6 s | 28.3 s | +2.5 % | 6.9 % | **99 %** |
| Heidelberg — Uni | 40.1 s | 39.9 s | −0.5 % | 12.9 % | **100 %** |
| Berlin — Mitte | 50.8 s | 57.2 s | +12.6 % | 10.0 % | 95 % |
| München — Altstadtring | 75.0 s | 81.4 s | +8.5 % | 17.9 % | 97 % |
| Köln — Innenstadt | 38.7 s | 48.9 s | +26.4 % | 6.8 % | 91 % |
| München — Riem | 85.8 s | 105.7 s | +23.2 % | 6.3 % | 80 % |
| Tübingen — Zentrum (live-add) | 13.7 s | 24.9 s | +81.8 % | 10.4 % | 96 % |

Read this honestly: the **OD matrix itself is not identifiable from counts**
(Cascetta 1984) — our estimate misallocates flow across equivalent routes. But the
**green-split ratio per junction** — the only quantity a tuned plan consumes — is
recovered almost exactly (toy grid: median error **0.0 pp**, p75 1.3 pp, max
10.9 pp; tests assert this). That is why the detector-only plan recovers **80–100 %
of the oracle's improvement** everywhere. Two more honest findings: less-congested
counting runs estimate better (fit err 28.8 % → 13.1 % on Riem), and heavier
congestion in the counting run degrades the estimate (Riem 15 min is the worst case
above). Reproduce: `python3 tools/od_experiment.py`.

### 3.2 Webster cycle lengthening — measured, opt-in

The adaptive policy can additionally adapt its **cycle length** to the measured
flows (one-sided Webster: only lengthen under load, cap 120 s; `webster_cycle:true`).
It is **not** the default because the regional sweep (`tools/od_experiment.py`) shows
a clean split: on saturated arterial networks it is a large win — on **Riem** and
**Köln** adaptive then *beats the demand-oracle plan for the first time* — while on
short-link grids (Hamburg, Berlin-Mitte) longer cycles feed spillback and hurt:

| Region | adaptive base | adaptive + Webster | vs oracle tuned (base → Webster) |
|---|---:|---:|---:|
| München — Riem | 92.7 s | **78.8 s** | −8.1 % → **+8.2 %** |
| Köln — Innenstadt | 41.3 s | **37.8 s** | −6.7 % → **+2.5 %** |
| München — Altstadtring | 81.0 s | 78.7 s | −7.9 % → −4.9 % |
| Heidelberg — Uni | 40.4 s | 40.4 s | unchanged (clamp holds base cycle) |
| Hamburg — Innenstadt | 30.6 s | 36.9 s | −11.0 % → −33.9 % |
| Berlin — Mitte | 107.4 s | 109.2 s | −111 % → −115 % (spillback-bound either way) |

## 4. Performance

| Workload | Runtime | Payload |
|---|---:|---:|
| Junction 30 min | < 0.1 s | ~0.5 MB |
| District `expo_riem` 15 min | ~1.4 s | ~0.3 MB |
| District `innenstadt` 15 min | ~12 s | ~3.2 MB |

(The district runtime is dominated by stepping ~1100–4200 links × 2 controllers;
the active-link optimisation cut it from ~13 s to ~2.5 s for the 10-min case.)

## 5. Quality gates

* `python3 -m unittest discover -s tests` → **55 tests, all green**
  (model, controllers, sensor feed, district model, count-based OD, HTTP API).
* `node --check web/app.js` and `node --check web/network.js` → clean.

## 6. Multi-city regions

Beyond Munich, the same pipeline captures other German cities and a university
town (arterial scope):

| Region | Fixed | Adaptive | Coordinated |
|---|---:|---:|---:|
| Berlin — Mitte | 189.1 s | **68.9 s (−63.6 %)** | 69.8 s (−63.1 %) |
| Hamburg — Innenstadt | 109.5 s | 38.4 s (−65.0 %) | **38.2 s (−65.1 %)** |
| Köln — Innenstadt | 150.6 s | **47.4 s (−68.5 %)** | 58.0 s (−61.5 %) |
| Heidelberg — Uni | 236.3 s | **44.5 s (−81.2 %)** | 75.5 s (−68.1 %) |

All six regions appear automatically in the dashboard selector via `/api/regions`;
see [data.md](data.md#region-graphs) for the graph table and how to add a city.

## 7. Season, vehicle mix & transit priority (junction)

Same intersection, 30 min. **Demand scenarios** (holiday vs commuter):

| Scenario | Arrived | Fixed delay | Adaptive delay | Δ delay |
|---|---:|---:|---:|---:|
| Normal | 2211 | 53.9 s | 40.7 s | −24.5 % |
| Berufsverkehr (rush) | 2483 | 66.6 s | 57.9 s | −13.1 % |
| Ferien (holidays) | 1259 | 28.6 s | 12.8 s | **−55.2 %** |
| Freizeit / weekend | 1234 | 29.8 s | 15.8 s | −47.1 % |

The pattern is the interesting part: **lower demand → much larger *relative* gain**.
Under rush the junction is near capacity, so both policies converge; in the holidays
the fixed plan still makes every car wait for its slot, while the adaptive
controller finds empty queues and serves them almost immediately.

**Vehicle mix** (PCE lowers effective saturation flow):

| Mix | PCE avg | Fixed delay | Adaptive delay | Δ delay |
|---|---:|---:|---:|---:|
| Pure cars | 1.00 | 53.9 s | 40.7 s | −24.5 % |
| 15 % trucks | 1.20 | 95.2 s | 76.1 s | −20.1 % |

Heavy traffic cuts capacity and eats into the adaptive advantage (the bottleneck,
not the control, starts to dominate).

**Bus priority (TSP)** — 30 min, 8 buses:

| | Fixed | Adaptive + TSP |
|---|---:|---:|
| Avg car delay | 53.9 s | 41.1 s |
| **Avg bus delay** | 332.6 s | **192.5 s** |

The honest trade-off: prioritising buses slightly *raises* average car delay
(40.7 → 41.1 s) while roughly halving bus delay — exactly the kind of choice a
city has to make deliberately.

## 8. Network: transit priority (corridor)

Riem, 8 min. `transit_priority` biases the corridor's main axis at its junctions
(a corridor-level TSP analogue): TSP off → adaptive delay 60.9 s / corridor 44.6 s;
**TSP on → 56.2 s / corridor 35.2 s (−21 %)**. The green-wave policy is unaffected
(it already prioritises the corridor). This is a *corridor* abstraction — the
junction model does explicit per-bus priority.

## How to read these numbers honestly

* The comparison is **control-only**: same demand, same network, same seeds.
* The fixed plan is a *plausible but generic* time-of-day plan, not a locally
  optimised one; a real city could pre-tune splits better. The realistic claim is
  that **demand-responsive control beats a static plan**, and the district results
  show that at scale.
* District delay is `Σ(queue)/completed trips`; more aggressive adaptivity also
  completes **more** trips (+16 % … +26 %), which is the more robust headline than
  delay alone.
