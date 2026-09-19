# References & literature grounding

> **Status note.** This literature grounding was compiled **now**, i.e. after the
> first working version of SignalFlow existed. We cite the work our design leans on,
> mark exactly where we **simplify** it, and we will **re-tune the model afterwards**
> where the comparison shows we deviate. Treat the numbers as model output, not as
> literature-validated results.
> Searched 2026-09-18 via the configured web search.

## 1. Design choice → source

| SignalFlow design choice | Source | What we take | How we simplify / deviate |
|---|---|---|---|
| **Reserve capacity** (traffic light controlling flow) | [Road Research Laboratory, *Traffic Signal Settings*, Road Research Technical Paper No. 39, HMSO, 1958](https://trid.trb.org/) (F. V. Webster) | the idea of cycle/split design and delay-vs-capacity trade-off | we use a fixed 4-phase plan (junction) / 60 s two-phase plan (district) instead of Webster-optimised splits |
| **Adaptive controller** = pressure/queue-driven phase selection | [P. Varaiya, *Max pressure control of a network of signalized intersections*, Transportation Research Part C 36, 177–195, 2013](https://www.sciencedirect.com/) | "max pressure": pick the stage with the largest queue pressure | we use lane-normalised **queues** (no downstream free-flow weighting), plus hysteresis, min/max green and an empty-phase early exit |
| **Cycle-constrained / coordinated max-pressure** | [M. W. Levin, *Max-pressure signal control with cyclical phase structure*, 2019](https://limos.engin.umich.edu/) | max-pressure can be constrained to a signal cycle | our green-wave mode constrains corridor junctions to a common cycle + offsets; off-corridor junctions stay free-running |
| **Green wave / progression on an arterial** | [J. D. C. Little et al., *MAXBAND: a program for setting signals on arteries and triangular networks*, 1981](https://www.semanticscholar.org/) | bandwidth/progression design with offsets | we place offsets = travel time × 0.95 (not an optimised bandwidth LP); one to three corridors, not a triangular network |
| **Green wave, practical framing** | [NYC DOT: Green Wave signal timing](https://www.nyc.gov/) | green waves are used in practice for progression (here also for cyclists) | we target motor traffic only |
| **Arterial coordination beyond a single corridor** | [J. Zhang et al., *An integrated arterial coordinated control model*, 2020](https://www.sciencedirect.com/) | integrated arterial coordination | we coordinate up to 3 corridors greedily (longest-path heuristic), not a joint optimisation |
| **Deployed adaptive systems (detector-based)** | SCOOT (Hunt et al., 1982) and SCATS — see [FHWA, *Balancing Safety and Capacity in an Adaptive Signal Control*](https://www.fhwa.dot.gov/publications/research/safety/10038/001.cfm) and [Caltrans ATMS report](https://dot.ca.gov/) | real systems adapt timing from **stop-line detector** data | we model detectors only as a **demand source** (counts feed); we do not (yet) model detectors in the feedback loop |
| **Saturation flow of a signalised lane** | FHWA / HCM: base saturation flow **1 900 pc/h/ln** — [FHWA capacity procedures](https://www.fhwa.dot.gov/), [HCM ch.16 summary](https://content.civicplus.com/) | order of magnitude for lane capacity | we use **1 800 veh/h/lane** and scale it by passenger-car equivalents |
| **Heavy vehicles / passenger-car equivalents** | same HCM sources (heavy-vehicle adjustment, truck ≈ 2 pc) | PCE concept for a mixed vehicle stream | our PCE table (car 1.0, van 1.3, truck 2.2, bus 2.6) is a plausible, uncalibrated choice |
| **Why calibration matters** | [A. Tarko et al., *Uncertainty in Saturation Flow Predictions*, TRB](https://trb.org/) | saturation-flow prediction error is ~8–10 % even in practice | motivates `tools/calibrate.py` and the honest statement that our saturation flow is a default, not a calibrated value |
| **Roundabout capacity** | NCHRP Report 572 single-lane capacity model, c vs **conflicting flow** — [FHWA/USDOT](https://highways.dot.gov/); [TRL: *The traffic capacity at roundabouts* (Kimber)](https://www.trl.co.uk/); [ASCE, *Models of Roundabout Lane Capacity*](https://ascelibrary.org/) | entry capacity falls **exponentially** with circulating flow | we use `c = 1130·exp(−1e−3·C)` with `C` estimated as 50 % of through+left demand on the other arms — a rough estimate, **not** a geometry-based formula |
| **Roundabout modelling depth (future)** | [Y. Song et al., *A merging state transition-based modeling approach*, 2022](https://www.sciencedirect.com/) | proper gap-acceptance/merging models exist | we do **not** model gap acceptance; the roundabout is a capacity-limited yield node |
| **OD demand from counts** | [E. Cascetta, *Estimation of trip matrices from link traffic counts and survey data: a generalized least squares estimator*, Transp. Res. Part B, 1984](https://ascelibrary.org/); [Cascetta & Nguyen, *A unified framework for estimating or updating OD matrices from traffic counts*, 1988](https://www.sciencedirect.com/) | how to estimate an OD matrix from link counts | **implemented 2026-09-19**: stop-line counts → Richardson-Lucy OD estimate → detector-tuned plan `fixed_tuned_est` (recovers 80–100 % of the oracle's gain; the OD itself stays non-identifiable, split ratios are recovered — see [results.md §3.1](results.md)). District *demand generation* is still the synthetic gravity OD |
| **OD estimation, practical validation** | [S. Dey et al., *Origin–Destination Flow Estimation from Link Count Data*, MDPI, 2020](https://www.mdpi.com/) | OD flows can be estimated from link counts alone | shows a path to replacing our synthetic OD |

## 2. Where our model is deliberately simpler

* **Junction:** a deterministic queueing model (dt = 1 s) with protected lefts; a
  permissive-left option approximates gap acceptance with a fixed 45 % capacity
  factor instead of a gap-acceptance distribution.
* **District:** a mesoscopic link-queue model with gravity OD + Dijkstra, not a
  microsimulation and not an OD *estimation*.
* **Control:** max-pressure with hand-of-engineering guards (min/max green,
  hysteresis, starvation), calibrated on a demand grid — not the full theoretical MP
  formulation with downstream weighting and stability proofs.

## 3. Follow-up queue (what the literature says we should do next)

1. **Calibrate** saturation flow & PCE with measured discharge data (Tarko et al.).
2. **Estimate the OD matrix** from the detector counts (Cascetta 1984; Dey 2020)
   instead of using a synthetic gravity model.
3. **Beef up roundabout capacity** with a geometry-based / gap-acceptance model
   (Kimber; Song et al. 2022).
4. **Close the loop on detectors** — use the feed as *feedback* (as SCOOT/SCATS do),
   not only as a demand source.
5. **Optimise the green wave** (MAXBAND-style) instead of fixed travel-time offsets.

_All sources were located via the configured search on 2026-09-18; links point to
the publisher/aggregator page seen in the results._
