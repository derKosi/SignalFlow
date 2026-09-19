# Improvements (the five-point plan)

Status of the agreed five improvements, with the honest findings.

| # | Improvement | Status |
|---|---|---|
| 1 | Calibrate & validate against data | **Tool done** (`tools/calibrate.py`); real-data fitting pending |
| 2 | Voice-first operator experience | **Done** (speak result, auto-speak, mic) — needs `ELEVENLABS_API_KEY` |
| 3 | Demo polish (presets, export, cache, animation, live regions) | **Done** |
| 4 | Multi-corridor coordination + fair baseline | **Done** — and it changed our own conclusion (see below) |
| 5 | Ops & accessibility | **Done** (packaging, CI, cache, labels) |

---

## 1. Calibrate & validate

`python3 tools/calibrate.py [--feed file.csv] [--json]` runs two checks on the
junction model:

* **Vehicle conservation** — `arrived ≈ served + in_network_at_end` (measured
  **0.00 %** error), and vehicles are served **only while green**;
* **Sanity** — finite, non-negative delays/queues; plus the configured vs
  PCE-corrected saturation flow.

**Honest limit:** fitting the *saturation flow* to reality needs real
discharge/queue observations. The sensor-feed loader settles **demand**
(`arrival_source=csv`); when a real detector dataset lands, point `--feed` at it.
This is the single biggest credibility gap and the top thing to finish.

## 2. Voice-first

* **`🔊 Ergebnis vorlesen`** speaks a German summary of the current KPIs.
* **Auto-Vorlesen** toggle speaks it automatically after every run.
* The **“Frag SignalFlow”** panel keeps the mic (Web Speech) + voice answer.
* Backed by `/api/tts` (ElevenLabs). Without a key it degrades with a clear hint.

## 3. Demo polish

* **Scenario preset buttons** (Normal / Berufsverkehr / Ferien / Wochenende) — one click.
* **`⤓ Bild`** exports the intersection view as PNG (artifact for the submission/social).
* **Result cache** on the server: repeating an identical run returns instantly
  (no waiting in front of the jury).
* **Animation fixes:** the junction view now **defaults to a watchable 10×**
  (one signal cycle ≈ 10 s; the 0.5/1/2/4 buttons multiply that, with a live `×`
  readout) instead of cramming a 30-min run into 30 s, queue lengths are
  **interpolated** between frames, and vehicles are drawn **driving through the
  junction** on green. A live **`Σ Queue`** readout shows the queue draining
  numerically (e.g. NS-THROUGH 13.5 → 8.0 → 7.5 veh during its green).
  Caveat: at peak the junction is near saturation, so queues stay long even on
  green — realistic, but use *Ferien* or a lower *Last* to see dramatic clearing.
* **Live regions** (previous step): type a place, get a new OSM district.

## 4. Multi-corridor coordination + a fair baseline — and an honest surprise

* Corridors: up to **3 well-separated arterials** are detected and coordinated
  (`/api/simulate_network` now returns `corridors`).
* New baseline **`fixed_tuned`**: fixed-time with green splits proportional to the
  *routed demand* (what a city could reach by tuning a plan to measured demand).

**This changed our own conclusion.** With the fair baseline the max-pressure adaptive
advantage largely disappears — and we improved the district controller in response:
the district now uses **measured-inflow demand-proportional splits** (Webster/SCATS-like)
instead of raw max-pressure.

| Region (15 min, load 1.0) | naive fixed | **tuned fixed** | adaptive (split) | coordinated | adaptive vs tuned | coordinated vs tuned |
|---|---:|---:|---:|---:|---:|---:|
| Riem | 184.8 s | **85.8 s** | 92.7 s | 86.8 s | −8.1 % | **−1.2 %** |
| Altstadtring | 266.5 s | **75.0 s** | 81.0 s | 119.8 s | −7.9 % | −59.7 % |

Progress and its limit, stated plainly: switching from max-pressure to measured-split
improved the gap vs the oracle-tuned plan from **−11.5 % → −8.1 %** (Riem) and
**−25.5 % → −7.9 %** (Altstadtring), and on Riem the **coordinated** policy is
essentially level with the tuned plan (−1.2 %). But **no single policy beats the
demand-oracle baseline across the board**; that needs count-based OD estimation and
calibration (P1.4/P1.5), which is exactly what the literature says
(see [references.md](references.md)).

The tuned plan is an **oracle** (perfect demand knowledge) that a real city must
estimate (e.g. Cascetta 1984). We report both baselines everywhere.

### 4.1 Count-based OD (the oracle, closed — 2026-09-19)

The oracle is now **answered on its own terms**: every district run additionally
derives a plan from **simulated stop-line detector counts** alone
(`fixed_tuned_est`, dashboard row “Tuned\*”):

1. the `fixed` run records stop-line counts (that is what loop detectors see),
2. a Richardson-Lucy estimator recovers the OD matrix on the free-flow route set
   (`signalflow.network.estimate_od`) — inputs: counts + the map, nothing else,
3. a fixed plan is tuned on the **estimate**.

Result: **80–100 % of the oracle's improvement recovered** (Hamburg 99 %,
Heidelberg ~100 %, Altstadtring 97 %, Berlin 95 %, Köln 91 %, Riem 80 %), even
though the OD matrix is *not identifiable* from counts — the per-junction
**split ratios** the plan consumes are (median error 0.0 pp; tested).
Additionally, the opt-in **Webster cycle lengthening** (`webster_cycle:true`,
one-sided: only lengthens under load) lets adaptive **beat the demand-oracle on
Riem (+8.2 %) and Köln (+2.5 %)**; short-link grids (Hamburg, Berlin-Mitte) lose
to spillback with longer cycles, so it stays off by default. Numbers and the
regional sweep: [results.md §3.1–3.2](results.md) · `python3 tools/od_experiment.py`.

## 5. Ops & accessibility

* **`pyproject.toml`** (installable, zero runtime deps) and **`.github/workflows/ci.yml`**
  (unit tests + frontend syntax + server smoke test on every push).
* Server **result cache** (see 3), **licence** (`LICENSE` PolyForm Noncommercial 1.0.0) and **`NOTICE.md`**
  (OSM/ODbL attribution, service terms, AI-assistance disclosure).
* Frontend: `aria-label`s on controls, status `aria-live`, clear error/hints.
* Still open: keyboard shortcuts, reduced-motion support, colour-blind-safe palette,
  and the browser-side visual check of the junction drawing (no browser in this env).

## What to do next (in order)

1. Calibrate with **real data** and both baselines in the writeup.
2. ~~Count-based OD estimation~~ — **done** (§4.1): detector-only tuned plan ships in
   every district payload; Webster cycle-lengthening is opt-in.
3. Junction **type library** (T-junction, roundabout, multi-lane with pedestrians) — built;
   next: more types (roundabout with gap acceptance, multi-lane).

_Update (same session): P1.6 (keyboard/ARIA/reduced-motion) and P1.7 (disk-cache
precompute, instant first load) are done; the district adaptive policy was switched to
the measured-split controller described above._

_Update 2026-09-19: §4.1 — count-based OD implemented and tested (55 tests green,
`tools/od_experiment.py`); detector-tuned plan (`fixed_tuned_est`) is part of every
`/api/simulate_network` response._
