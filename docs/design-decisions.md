# Design decisions (ADR log)

Short records of the non-obvious choices. Each one links to the problem it solved.

---

## ADR-1 — Zero dependencies

**Context.** A hackathon demo must run on any judge's laptop, offline, in under a
minute, without a package manager or a build step.
**Decision.** Python **standard library only** on the backend (`http.server`), and
vanilla HTML/CSS/JS + Canvas on the frontend. No pip, no npm, no CDN, no bundler.
**Consequences.** `python3 server.py` is the whole install. We trade away
FastAPI/Django ergonomics and a component framework, and we hand-roll a tiny HTTP
router and a canvas renderer — which the tests and the two dashboards cover.

---

## ADR-2 — Adaptive must account for clearance cost

**Context.** The first adaptive controller was **worse** than fixed-time
(−57 % delay improvement = a regression). Instrumentation showed it spent 245 s in
yellow/all-red versus 92 s for the fixed plan, because it switched phases almost
every cycle.
**Decision.** Add a **minimum green** (24 s), a **switch hysteresis** (competitor
pressure must beat the current phase by ×3.0), and an explicit early-exit only for
*empty* phases. Then **calibrate** the parameters on a demand grid.
**Consequences.** Adaptive now beats fixed by 24.5 % (junction) / 49.7–64.6 %
(district). Lesson: *"adaptive" is not automatically better — it must be tuned
against the cost of switching.*

---

## ADR-3 — Preserve total demand in the OD matrix

**Context.** The first district run delivered only ~40 % of the intended demand and
gridlocked: most gravity OD pairs (entry → exit) were **unreachable** on the
directed graph (one-way streets, disconnected pockets), and that flow was silently
dropped.
**Decision.** Compute only **reachable** pairs, weight them by `lanes · speed`, then
**renormalise to the configured `total_vph`** so total demand is preserved.
**Consequences.** Throughput became realistic and comparable across regions; the
same seed reproduces the same numbers. Reachability is now an explicit concept
rather than a silent leak.

---

## ADR-4 — Soft storage cap against cyclic deadlock

**Context.** With a hard downstream-storage limit, two-way streets produced cyclic
deadlocks: link A full → cannot discharge into B; B full → cannot discharge; both
frozen forever. Delay exploded (1800 s+).
**Decision.** Allow occupancy up to `cap · 1.35` (a **soft** cap) so queues always
have somewhere to bleed off, while still modelling spillback.
**Consequences.** Deadlocks disappear; congestion is still visible and responsive to
control. It is an approximation — real gridlock exists — but it keeps the model
useful and stable.

---

## ADR-5 — Separate terminating trips from through traffic

**Context.** In the first network model, vehicles that reached their destination
link were *not* removed: the link's aggregate turning fractions sent them onward,
so traffic circulated forever and completions were undercounted (served ≪ spawned).
**Decision.** Track, per link, an **exit share** = (veh/h ending here) / (total
veh/h through the link). On discharge, `take · exit_share` leaves the network
(completed trip) and the remainder is split by turning fractions.
**Consequences.** Completions and throughput became correct and the gridlock
disappeared. This is the aggregate multi-commodity approximation: exact per-trip
tracking would be O(commodities × links) and was unnecessary.

---

## ADR-6 — Remove the "detector lookahead" experiment

**Context.** We tried boosting max-pressure with an EWMA of measured inflow
(anticipating platoons within ~18 s).
**Decision.** After a parameter sweep it **hurt** whenever active (down to −1.8 %),
so it defaults to off and was **removed** entirely rather than left as dead code.
**Consequences.** Simpler controller, no misleading claims. The README/DEMO no
longer mention detector lookahead.

---

## ADR-7 — Two dashboards, one server

**Context.** The junction view and the district view need very different
visualisations but should share styling and the same origin.
**Decision.** Two static pages (`/` and `/network.html`) served by the same process,
sharing `styles.css` and the dark "control-room" theme; each talks to the JSON API.
**Consequences.** No CORS, no duplication of the server; the two pages link to each
other from the header.

---

## ADR-8 — Cache the last run for explanations

**Context.** `/api/explain` should explain *the run the operator is looking at*,
without the client having to resend the whole result.
**Decision.** Keep the last simulation payload in server memory (`LAST`) and use it
as LLM context; fall back to a deterministic rule-based explainer when no key is set.
**Consequences.** Explanations are consistent with the visible run and work offline;
the cache is per-process (fine for a single-user demo).
