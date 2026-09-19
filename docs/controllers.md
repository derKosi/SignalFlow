# Controllers

Two policies are always run on the **same** demand so the comparison is fair.

## Fixed-time baseline

* **Junction** (`FixedTimeController`): a repeating cycle of the four phases
  `[NS_THRU 36 s, NS_LEFT 10 s, EW_THRU 32 s, EW_LEFT 8 s]`, each followed by
  3 s yellow + 1 s all-red. Cycle time ≈ 102 s.
* **District** (`FixedJunction`): every signalised junction runs a fixed 60 s
  two-phase plan (30 s axis A / 3 s yellow / 30 s axis B / 3 s yellow).

This is the honest "what exists today" reference: fixed or lightly time-of-day
adjusted plans that cannot react to the current queue.

## Adaptive controller (max-pressure)

The adaptive policy picks the phase with the highest **pressure**, with guards.

### Pressure (junction, 4 phases)
```
pressure(phase) = Σ over its movements  queue[m] / lanes[m]
                + starvation bonus if a movement has waited > starve_seconds
```
The starvation bonus is `6.0 + 0.25·(wait − starve_seconds)` and prevents a loaded
minor movement (e.g. a left turn) from being served out.

### Pressure (district, 2 axes)
Same idea per junction, summed over the axis' incoming links.

### Switching rules (junction defaults)
| Parameter | Value | Purpose |
|---|---|---|
| `min_green` | 24 s | don't churn green time |
| `max_green` | 50 s | bound worst-case wait |
| `switch_hysteresis` | 3.0 | competitor pressure must clearly beat current |
| `empty_exit_green` | 5 s | leave a fully-served (empty) phase early |
| `starve_seconds` | 120 s | starvation guard |
| yellow / all-red | 3 s / 1 s | clearance |

District defaults: `min_green 12`, `max_green 50`, `hysteresis 1.6`, `empty_exit 5`.

## Green-wave coordination

A third policy, `CoordinatedJunction`, adds **corridor coordination** on top of
max-pressure (the district model reports all three: `fixed`, `adaptive`,
`coordinated`).

* **Corridor detection:** the route with the longest free-flow time in the loaded
  OD set is taken as the arterial; its ordered links form the corridor.
* **Offsets:** each corridor junction gets `offset = cumulative free-flow time from
  the corridor start × progression factor` (default 0.95), modulo a common cycle
  `C = 100 s`.
* **Band:** the main axis is green while `((t − offset) mod C) < main_green`
  (default 62 s); the cross street is green for the rest of the cycle.
* **Adaptivity retained:** if the main axis is empty during its band and the cross
  street is waiting, it leaves early (no wasted green) and returns to the band next
  cycle; **all non-corridor junctions keep pure max-pressure.**

**Result (15 min peak):** coordination *wins* on a clean arterial and *loses* in a
dense grid — an honest, expected trade-off:

| Region | Fixed | Adaptive | Coordinated (green wave) |
|---|---:|---:|---:|
| Messe/ICM Riem (clean arterial, 72 corridor signals) | 184.8 s | 92.9 s | **70.5 s (−61.9 %)** |
| Altstadtring (dense grid, 134 corridor signals) | 266.5 s | **94.2 s (−64.6 %)** | 111.0 s (−58.4 %) |

Parameters (`COORD_CYCLE_S`, `COORD_MAIN_GREEN_S`, `COORD_PROGRESSION`) were swept;
longer main green and near-free-flow progression were best on Riem. In the dense
Altstadtring the rigid band loses to full adaptivity because the corridor is only
one of many competing flows.

> Why hysteresis + min-green matter: our **first** adaptive version was *worse*
> than fixed-time. It switched so often that clearance time (yellow + all-red)
> ate the green budget — 245 s of clearance vs 92 s for the fixed plan. See
> [design-decisions.md](design-decisions.md#adr-2-adaptive-must-account-for-clearance-cost).

## Calibration

The controller parameters were **not** hand-tuned. They came from a grid search
scored on the **mean delay reduction across a demand grid** (0.8×–1.1×, flat and
peak profiles) to avoid overfitting a single scenario:

| Rank | min_green | max_green | hysteresis | mean delay reduction |
|---|---:|---:|---:|---:|
| 1 | 24 | 50 | 3.0 | **39.9 %** |
| 2 | 24 | 50 | 2.4 | 39.4 % |
| 3 | 20 | 50 | 2.8 | 39.3 % |

An experimental "detector lookahead" term (EWMA of measured inflow) was tested and
**removed** — it hurt whenever it was active (see ADR-6).

## Explainability

* The controller records, for every switch, the numbers that caused it:
  `switch NS_THRU→EW_THRU (higher competing pressure): pressure 9.2 vs current 4.1;
  worst wait 73 s`.
* The dashboard lists these live, and `/api/explain` turns them into prose via
  Featherless (or a deterministic offline explainer).
* Pressures per phase are exposed every switch, so the "why" is auditable, not a
  black box.

## Fair comparison guarantees

* One pre-generated arrival stream, consumed by both controllers (identical demand).
* Same seeds, same network, same link parameters.
* Only the control policy differs — so the measured improvement is attributable to
  control.
