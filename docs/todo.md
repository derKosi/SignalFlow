# Roadmap / open TODOs

Consolidated status and next steps. Updated 2026-09-19 (55/55 tests green, server runs
with zero runtime dependencies).

## Timeline (verified against the platform API)

| | |
|---|---|
| Now | 2026-09-18 |
| **Challenge deadline** | 2026-09-20 |
| **Submission window closes** | **2026-09-21 23:30 CEST** |
| Public voting | 2026-09-20 09:00 → 2026-09-21 17:00 CEST |
| Competing submissions in our track (Smart Cities) | **0** (3 total on the board, all Digital Health) |

→ The critical path is **submitting a polished, working demo**, not more features.

---

## P0 — must happen before submission

| # | Task | Who | Effort | Done when |
|---|---|---|---|---|
| P0.1 | **Record the 2–3 min demo video** from [DEMO.md](../DEMO.md) | human | 1–2 h | video uploaded, link ready |
| P0.2 | **Submit on Devpost** using [SUBMISSION.md](../SUBMISSION.md) (paste, add links, add both baseline numbers) | human | 30 min | submission confirmed |
| P0.3 | **Visual smoke-test the dashboards in a browser** (junction: right-hand traffic, turning paths, T-junction, roundabout; district: map, presets, live-add) | human | 20 min | no layout/logic bugs, or bugs logged |
| P0.4 | **Decide the licence** against the real rules (the `/rules` page was not fetchable here) — see [NOTICE.md](../NOTICE.md) | human | 15 min | licence + AI-disclosure wording confirmed |
| P0.5 | **Verify repo is public/accessible to judges** (submission requires judge access) | human | 10 min | repo/demo link works for a stranger |
| P0.6 | Fix any bug P0.3 finds (drawing/geometry/labels) | agent | 1–3 h | re-tested by human |
| P0.7 | **Optional: live demo** — the stdlib server deploys anywhere Python runs (Render/Fly.io free tier, or a VPS + subdomain e.g. demo.kosit.de). Keys optional (offline fallback works); precompute cache before going live. Decide 2026-09-20 morning: live link lowers the voter barrier (voting starts 09:00) — but video + GitHub + writeup is sufficient per the rules | human + agent | 30–60 min | live URL reachable, or decision documented |

## P1 — high value, do if time remains before the deadline

| # | Task | Status |
|---|---|---|
| P1.1 | **Make adaptive beat `fixed_tuned`** | **partial → mostly closed** — measured-split narrowed the gap to −8.1 %/−7.9 %; count-based OD (P1.5) now recovers 80–100 % of the oracle's gain *from detectors alone*; opt-in Webster cycle lets adaptive **beat the oracle on Riem (+8.2 %) and Köln (+2.5 %)**. Remaining: adaptive beating the oracle *by default* on every region |
| P1.2 | **Live test sponsor paths with real keys** | open (needs keys) |
| P1.3 | **Claim sponsor promo codes** | open (human) |
| P1.4 | **Calibrate with real data** | open (needs a dataset) |
| P1.5 | **OD-based demand from counts** | **done** — stop-line counts → Richardson-Lucy OD → `fixed_tuned_est` in every district payload (+ “Tuned\*” dashboard row, `tools/od_experiment.py`, 5 tests). OD itself stays non-identifiable; split ratios are what matters (median err 0.0 pp) |
| P1.6 | **A11y quick wins** | **done** — keyboard (space/arrows/+−), `prefers-reduced-motion` (no moving-vehicle animation), ARIA on the play button |
| P1.7 | **Precompute demo results** | **done** — disk cache + `tools/precompute.py`; first district load went from ~8.8 s to **0.3 s** |

## P2 — after the hackathon

* **Network → junction drilldown**: *built* — clicking a signalised node on the
  district map opens a junction close-up (true bearings, link queues, real
  phase colours, synced to playback). Possible upgrades: per-node KPIs and
  turn-level movements in the drilldown.
* MAXBAND-style green-wave optimisation instead of fixed travel-time offsets.
* Roundabout: geometry-based capacity + gap acceptance (Kimber, Song et al.).
* Close the detector loop (feed as feedback, SCOOT/SCATS-style).
* Mobile/responsive pass; i18n strings; Dockerfile; PyPI-style release.
* Multi-corridor joint optimisation + transit routes (bus lines as entities).

---

## Known limitations we explicitly do NOT hide

1. Mesoscopic/macroscopic model, not a validated microsimulation.
2. Saturation flow / PCE are defaults, not calibrated (Tarko: ~8–10 % error).
3. District demand is still a synthetic gravity model; what counts deliver is the
   **tuned plan** (`fixed_tuned_est`) — the demand *generator* itself remains synthetic.
4. Roundabout capacity is a rough analytic estimate; no gap acceptance.
5. Adaptive **beats the demand-oracle only with opt-in Webster** (Riem, Köln) — the
   default policy stays −8 %/−5 % behind (P1.1 residual).
6. The dashboards were **never rendered in a real browser** (sandbox/macOS kills
   browser processes — re-verified 2026-09-19, Playwright *and* raw Chromium) —
   that is what P0.3 is for.
7. Sponsor integrations are unproven without keys (P1.2).
8. The OD-estimation pipeline is demonstrated *inside* the simulation (counts from
   the fixed run); no real-world detector dataset has touched it yet (P1.4).

## Definition of done for the hackathon

- [ ] P0.1–P0.5 complete, P0.6 bugs fixed
- [ ] Submission text reports **both** baselines (naive fixed *and* tuned) honestly
- [ ] Video shows: junction animation → scenario switch (Ferien vs Berufsverkehr) →
      district coordination → live region add → voice explanation
- [ ] Repo, licence and AI-disclosure are in place

## P3 — LLM upgrade (planned, see HANDOFF section 14)

1. **A. Agentic copilot with tool use** — **done** (2026-09-19): `POST /api/agent`,
   prompt-based tool protocol (`simulate`, `simulate_network`, `compare`,
   `explain_last`), guardrails + deterministic degradation, step trace in the
   "Frag SignalFlow" panel; 21 unit tests + 2 API tests.
2. **C. Weekly report artifact** — **done** (2026-09-19): `tools/report.py`
   (+ `--html` for print-to-PDF), first report committed in `reports/`;
   LLM summary gated by number tracing (`unsupported_numbers`).
3. **B. Multi-agent check** — **done** (2026-09-19): `mode:"panel"` on
   `/api/agent` — analyst → critic → writer; number tracing is enforced in code
   (`agent.unsupported_numbers`), wrong premises are flagged by the critic, the
   writer must add a "Prüfung:" line; safety net replaces unrepairable drafts.

Decided against a second, independent hackathon project (time, rules, judging axes).
