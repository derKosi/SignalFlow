# HANDOFF — SignalFlow

Everything needed to pick this up cold. **Updated 2026-09-19 (Europe/Berlin).**

* **HEAD:** one clean commit — the 31-commit dev history was squashed before the
  first push (full local history preserved under the git tag `backup-local-history`)
  · **76 tracked files** · **104/104 tests green**
* **Licence:** code = **PolyForm Noncommercial 1.0.0**; OSM-derived data = **ODbL 1.0**
* **Live integration:** Featherless key is set and working (`.env`, gitignored);
  ElevenLabs not yet.
* **Project location:** `/Users/kosi/Documents/Dev/munichtechexpo/SignalFlow`
  (moved out of the agent workspace on 2026-09-18 — see section 8).

Hackathon: **MunichTech EXPO 2026**, challenge *“Smart Cities: Adaptive Traffic Flow”*.
Rules (team-supplied text, section 7): **public GitHub URL required** and the core
solution must be **reviewable by judges**; proprietary/closed components allowed if
disclosed; declare AI usage honestly. **Build window ends 2026-09-20 17:00 CEST**
(the platform API mentioned 2026-09-21 23:30 CEST — aim for the 20th). Public voting
2026-09-20 09:00 to 2026-09-21 17:00; Autumn Edition 20–22 Sep; solo or teams up to 6.
Our track had **0 competitors** in the platform leaderboard.

---

## 1. What it is

An adaptive, **explainable** traffic-signal controller. It simulates the *same*
traffic through a fixed plan and adaptive control and shows the before/after:
(a) one junction with a live animation and four junction types, (b) whole districts on
**real OpenStreetMap** networks (8 regions incl. live-added ones) with five policies,
(c) a decision log you can ask in natural language — answered as text and speech.

## 2. Run it

```bash
cd /Users/kosi/Documents/Dev/munichtechexpo/SignalFlow
./run.sh                       # or: python3 server.py   -> http://127.0.0.1:8000
python3 -m unittest discover -s tests        # 64 tests
python3 tools/precompute.py                  # instant demo (warms the disk cache)
python3 tools/adapt_feed.py IN.csv --out data/adapted.csv   # foreign sensor CSV into our feed format
python3 tools/check_keys.py                  # live probe of the sponsor keys
python3 tools/calibrate.py --duration 20     # model validation report
python3 tools/od_experiment.py               # count-based OD + Webster regional sweep
python3 tools/report.py --html               # weekly traffic report (seeded, LLM summary)
node --check web/app.js && node --check web/network.js
```

Pages: `/` (junction) · `/network.html` (district) · `/writeup.html`.
Docs are served too: `/docs/*.md`, `/README.md`, `/WRITEUP.md`, `/NOTICE.md`, `/LICENSE`, `/HANDOFF.md`.

## 3. Repo map

```
server.py                  stdlib HTTP server: static + JSON API + memory/disk cache
signalflow/
  simulation.py            junction model, junction types, controllers, TSP, scenarios, PCE
  network.py               district model: OSM graph compile, OD routing, link-queue sim
  integrations.py          Featherless + ElevenLabs clients, probes, offline fallback
  feed_adapter.py          third-party sensor CSV into our feed format (+ example generator)
  geofetch.py              live region add: Nominatim to Overpass to graph
web/                       junction + district dashboards, writeup page, SVG/PNG diagram
tools/                     fetch_osm · build_regions · verify_regions · calibrate ·
                           precompute · od_experiment · check_keys · adapt_feed · report
data/regions/              compiled graphs (committed, ODbL)
data/osm/  data/cache/     raw Overpass + result cache (both gitignored)
tests/                     104 stdlib tests (model, controllers, network, API, agent, report)
docs/                      index in docs/README.md (18 files, incl. licensing + rules)
README · WRITEUP · SUBMISSION · DEMO · HANDOFF · NOTICE · LICENSE · reports/ (weekly report)
```

## 4. Model in brief

* **Junction** (`simulation.py`): dt = 1 s queueing model; phases come from a
  **junction-type spec**: `cross4` (protected lefts), `cross4_permissive`
  (permissive lefts, gap factor 0.45), `t3` (3 arms), `roundabout` (yield, capacity
  from `1130*exp(-1e-3*C)`). Controllers: `FixedTimeController`,
  `MaxPressureController`, `RoundaboutController`. Optional **bus priority (TSP)**,
  **demand scenarios** (normal/berufsverkehr/ferien/freizeit), **vehicle mix (PCE)**,
  sensor feed (local file **or http URL**) with `detector_dropout`.
* **District** (`network.py`): mesoscopic **link-queue** model on OSM graphs.
  Demand = gravity **entry-exit OD** routed with Dijkstra, per-link turning fractions,
  per-link **exit share** for terminating trips, soft storage overflow (x1.35) against
  deadlock. Up to **3 corridors** coordinated. Five policies are compared:
  `fixed`, `fixed_tuned` (demand-proportional splits — an oracle), `fixed_tuned_est`
  ("Tuned*" KPI row, count-based OD estimate), `adaptive` (measured-inflow splits,
  Webster/SCATS-like; optional Webster cycle), `coordinated` (green wave).
* **Detector proxy:** EWMA of measured link inflow (`inflow_hat`, alpha 0.02) is passed
  to the district controller as `flows=` — this is what makes “adaptive” adapt.

## 5. Integrations — live status

| Service | Status | Notes |
|---|---|---|
| **Featherless** | **live** (`/api/health` has `featherless: true`) | key in `.env` (gitignored). Model `Qwen/Qwen2.5-7B-Instruct`; fallbacks `Qwen/Qwen2.5-14B-Instruct`, `mistralai/Mistral-7B-Instruct-v0.3`. Answers in the question's language. |
| **ElevenLabs** | not configured | voice (dashboard read-aloud + auto-speak) stays untested until a key exists. |

Two hard-won details:
* **Featherless sits behind Cloudflare and rejects the default `Python-urllib`
  User-Agent with HTTP 403.** `integrations.py` now sends a real `User-Agent`
  (+ `Accept`). Without this the key *never* works.
* **Some catalogue models are gated** (`meta-llama/Meta-Llama-3.1-8B-Instruct`,
  `google/gemma-2-9b-it` need HuggingFace OAuth) — the fallback chain avoids them.

Verify anytime: `python3 tools/check_keys.py` or `GET /api/keys` (never echoes secrets).

## 6. Licensing (decided)

* Code: **PolyForm Noncommercial 1.0.0** (source-available, non-commercial). Decision,
  options table, dependency inventory and an ODbL-compatibility FAQ:
  [docs/licensing.md](docs/licensing.md). Exactly one licence file ships
  (`LICENSE`); alternative texts live on their project pages.
* Data: **ODbL 1.0** for everything derived from OSM (attribution + share-alike for
  the *database*); the exact credit is in the network-dashboard footer, README,
  NOTICE, docs **and embedded in every `data/regions/*.json`**.
* No third-party code is bundled (stdlib only, `dependencies = []`), so no copyleft
  can attach. Overpass/Nominatim are fair-use OSMF services; provider ToS apply to the
  APIs; keys are never committed.
* Honest caveat: the “no commercial use” restricts **our code**, not the maps — ODbL
  data remains commercially usable by anyone, with attribution.

## 7. Status — done vs open

**Done:** junction sim (4 types, permissive lefts, TSP, scenarios, mix, feed) ·
district sim (8 regions, 5 policies incl. count-based OD estimate + Webster) ·
multi-corridor green wave · live region add · dashboards (animations, turning paths,
right-hand traffic, KPIs, decision log, presets, PNG export, voice readout, keyboard,
reduced-motion) · explanations (Featherless live, offline fallback) ·
**agentic copilot** (`POST /api/agent`, plan §14.A done + live-verified, see below) ·
third-party feed adapter (9 tests) · weekly report tool (+ committed KW-38
artifact) · multi-agent self-check (`mode:"panel"`, §14.B) · 104 tests ·
CI workflow · pyproject · disk cache + precompute · 18 docs incl. writeup,
submission kit, licensing · licence switched · AI disclosure written.

**Open — P0 (human, before the deadline):**
1. **Push the repo publicly** (required): `gh repo create SignalFlow --public --source=. --push`.
2. **Record the 2–3 min demo video** ([docs/submission-kit.md](docs/submission-kit.md) §2;
   voice-over lines are written and need the ElevenLabs key).
3. **Submit on Devpost** (fields pre-written in the submission kit; report **both**
   baselines honestly).
4. **Visual browser check** (junction: turning paths, T-junction, roundabout; district:
   map, presets, live add, the “Tuned*” KPI row). Not possible with our tools — see §8.
6. **Ask the organisers where the sample dataset is** (briefing vs. online) — see §7b;
   not a blocker, the adapter + synthetic feed cover us.
5. Optional: run `tools/precompute.py` once more right before the demo.

**Open — P1 (agent-doable, no extra data):**
* Beat the oracle baseline **by default on every region** (Webster only wins on
  saturated arterials; a spillback-aware lengthening rule is the next idea).
* A11y polish (colour-blind-safe palette, focus styles), demo-mode button for precompute.
* Iterative OD refinement (estimate, retime, recount) as practitioners do.

**Open — P2:** MAXBAND-style offsets · roundabout gap acceptance · detector feed as
*feedback* (SCOOT/SCATS-like) · mobile layout · Dockerfile.

## 7b. Submission readiness (2026-09-19)

| Requirement (from the rules) | State |
|---|---|
| Public GitHub URL | **to do** (repo is local, `gh repo create` one-liner) |
| Core solution reviewable by judges | ready (no third-party code bundled, PolyForm Noncommercial code + 18 docs + writeup) |
| Original work / no third-party code bundled | yes (stdlib only, `dependencies = []`) |
| Declare AI tooling | done (`NOTICE.md` section 5) |
| Proprietary/closed parts allowed | we are source-available, so nothing to hide |
| Demo video (2-3 min) | **to do this evening** (script + voice-over lines ready) |
| Devpost submission | **to do** (fields pre-written in `docs/submission-kit.md`) |
| Visual browser check | **to do** (cannot be done by our tools, see section 8) |

Deadline read: the rules say the build window ends **2026-09-20 17:00 CEST**; the
platform API reported the submission window closing **2026-09-21 23:30 CEST**. Treat
the 20th as the real deadline and aim for an evening-of-the-19th submission.

**Oddity worth a question to the organisers:** the challenge says the sample sensor
dataset is "provided at the briefing", but the briefing/on-site days are 20-22 Sep —
*after* the 20 Sep 17:00 build deadline. So either an earlier briefing distributed it,
or it was always meant as a mostly-simulation task. We do not depend on it: synthetic
feed + adapter + OSM networks cover us, and the real file can be dropped in later.

## 8. Environment quirks & gotchas (learned the hard way)

* **The project now lives OUTSIDE the agent workspace** (`~/Documents/Dev/...`), and
  `tools.fs.workspaceOnly` is on, so `read`/`write`/`edit`/`apply_patch` are **blocked**
  for it. Work via `exec` (shell) — proven throughout — or set
  `tools.fs.workspaceOnly=false` (owner decision) to re-enable the file tools.
* **Browser processes are killed here** (exit 137, re-verified with Chromium and
  Playwright 1.51-1.63). No browser automation, no dashboard screenshots, no screen
  capture: the visual check must be done by a human (or a Playwright-capable agent on
  another machine).
* **Tool output masks secrets** (strings like URLs/voice ids show up as `***` or `…`).
  That is display-only; the files on disk are intact. Do not “fix” a file because the
  echoed content looks truncated.
* **Overpass mirrors:** `z.overpass-api.de` works best (429 if hammered);
  `overpass-api.de` returns 406/403; `overpass.osm.ch` is CH-only; `maps.mail.ru`
  works but throws 504s. `tools/fetch_osm.py` handles fallback + backoff.
* **Nominatim** needs a `User-Agent` (set) and low request rates.
* **`.env`, `data/osm/`, `data/cache/` are gitignored.** Delete `data/cache/*` after a
  model change, otherwise stale results are served (the cache is keyed by request hash).
* **Restart the server after changing Python modules** (static JS is re-read per
  request, Python is not). `innenstadt` 15 min: about 9 s cold, 0.3 s warm.
* **Devpost `/rules` → 403** and the site's `/terms` is client-rendered — rules were
  obtained manually (section 7 quote).

## 9. Design decisions worth preserving

See `docs/design-decisions.md`: zero dependencies; adaptive control must account for
clearance cost; OD reachability normalisation; soft storage cap against deadlock;
exit-share for terminating trips; **both baselines reported**; remove dead code rather
than ship it disabled; hermetic tests via `SIGNALFLOW_NO_DOTENV=1`.

## 10. Cheat sheet

```bash
# district table (all five policies + the improvement block)
curl -s -XPOST localhost:8000/api/simulate_network -H 'Content-Type: application/json' \
  -d '{"region":"expo_riem","duration_min":15}' | python3 -m json.tool | head -40

# junction scenario comparison
for s in normal berufsverkehr ferien freizeit; do
  curl -s -XPOST localhost:8000/api/simulate -H 'Content-Type: application/json' \
    -d "{\"duration_min\":30,\"demand_scenario\":\"$s\"}" | \
    python3 -c "import sys,json;d=json.load(sys.stdin);print('$s',d['improvement']['avg_delay_pct'])"
done

# add a district live, and re-warm the cache
python3 -m signalflow.geofetch "Bonn Zentrum" --span 0.012
python3 tools/precompute.py --force
```

## 11. Later ideas (recorded, not started)

* **Publish to GitHub, then a second opinion from Codex.** Push with `gh repo create
  SignalFlow --public --source=. --push` (CI in `.github/workflows/ci.yml` runs), then
  hand the repo to Codex for an independent review: model correctness, the
  adaptive-vs-tuned-baseline claim, test gaps. Treat findings as a review list, not as
  accepted changes.
* **Promo video route.** (a) Recording here via remote browser control is **not
  possible** (browsers killed, see §8). (b) Use a Playwright-capable agent on the fast
  machine to drive Chrome and screen-record, or record manually (QuickTime) following
  `docs/submission-kit.md` §2. Voice-over text exists; needs the ElevenLabs key.

## 12. Known limitations we do NOT hide

Mesoscopic, not a validated microsimulation · saturation flow/PCE are defaults, not
calibrated · district OD is synthetic or a rough count-based estimate · roundabout
capacity is analytic and gap acceptance is not modelled · adaptive does not beat the
demand **oracle** baseline everywhere · ElevenLabs path untested without a key ·
dashboards never rendered in a real browser in this environment.

## 14. Planned: LLM upgrade of SignalFlow (decided 2026-09-19)

**Decision.** Do **not** start a second, independent hackathon project. Instead spend
the same hours making the LLM layer of SignalFlow genuinely *agentic*. Rationale:

* **Time.** About 26 h remained when this was decided, and the existing entry still
  needs the human last mile (public repo, demo video, Devpost, browser check). A second
  build competes for exactly those hours.
* **Rules.** Dual entry is only allowed for **independent** projects and each team
  competes with one hackathon entry per track; a second *traffic* product would not be
  independent, and a rushed unrelated one would be weaker on the open track's judging
  axes (originality, **technical difficulty**, execution quality, demo & pitch quality).
* **Leverage.** The upgrade compounds on a working, tested system, and it lands on the
  wording of the challenge itself ("reacting to simulated or sample sensor/camera feed
  data" + explainability). It also strengthens the two sponsor angles: Featherless
  (live) and the agentic-AI mentors on the open track (Lyzr AI, Meta).
* **Non-goals:** no second submission, no model rewrite, no new dependencies
  (standard library only), no new infrastructure.

### A. Agentic copilot with tool use (core, do first)

**Goal.** A free-text question ("Was passiert in den Ferien mit 15 % Lkw?") is answered
by an agent that **actually runs the simulator** as a tool and returns real numbers.

**Design.**
* Endpoint `POST /api/agent` with `{question, max_rounds<=3}` returning
  `{answer, model, source, steps:[{tool, args, digest}]}`.
* **Tools** (thin wrappers over existing code, nothing new underneath):
  `simulate(scenario, demand_multiplier, junction_type, vehicle_mix, transit_priority)`,
  `simulate_network(region, duration_min, ...)`, `compare(presetA, presetB)`,
  `explain_last()`.
* **Protocol:** provider-portable, prompt-based tool calling -- the model must answer
  with a single JSON object `{"tool": ..., "args": {...}}` or `{"final": "..."}`. We
  parse, validate, execute, feed the digest back, and loop (max 3 rounds). This avoids
  depending on model-specific function-calling support on Featherless.
* **Guardrails:** whitelist of tools and argument keys; every run goes through the
  existing `Config` validation (so bad args become a 400-style tool error the model can
  correct); no filesystem/network side effects from the agent; token cap; if JSON parsing
  fails twice, fall back to the existing rule-based explainer and say so.
* **UI:** extend the "Frag SignalFlow" panel with a collapsible **step trace**
  (which tool, which args, the digest) above the answer. Voice read-aloud keeps working.

**Acceptance.** For "Ferien + 15 % Lkw" the returned numbers equal a manual
`run_scenario(...)` call (same seed), the trace shows both the model turn and the tool
call, the endpoint still answers (degraded) with no key, and `python3 -m unittest`
stays green.

**Effort:** about 3-4 h. **Risk:** malformed JSON from the model -> repair/retry, then
fallback; latency -> cache by question hash.

### B. Multi-agent check: analyst, critic, writer

**Goal.** Self-checked answers and an honest "agent" story for the pitch.

**Design.** Same endpoint, three roles as separate prompts over the same tool results:
1. **Analyst** proposes the answer and the tool calls it needs.
2. **Critic** verifies every number against the tool digests, rejects unsupported
   claims, and can demand one re-run with different arguments.
3. **Writer** produces the final German answer plus a one-line "how I checked this".

**Hard rule (anti-hallucination):** the Writer may only cite numbers present in tool
results; the Critic fails any number it cannot trace. Max 2 revision rounds.

**Acceptance.** For a question with a wrong premise ("Warum sinkt der Durchsatz in den
Ferien?") the Critic flags the premise and the final answer corrects it with the real
figure; a deliberately injected false number in a tool stub is caught in a test.

**Effort:** about 2 h on top of A. **Risk:** 3x model latency/cost -> cache + spinner.

### C. Weekly report as a tangible artifact

**Goal.** A pitch-ready "traffic-control weekly report" built from real runs.

**Design.** `tools/report.py [--out reports/week-YYYY-WW.md] [--region expo_riem]`:
runs the four demand scenarios (plus one district) with fixed seeds, collects the KPIs,
and emits Markdown with headline numbers, a before/after table, highlights from the
adaptive decision log, and an executive summary written by Featherless (deterministic
summary if no key). An HTML variant prints to PDF from the browser; the `pdf` skill can
render it properly if a real PDF is wanted.

**Acceptance.** Running it produces a report whose numbers match `docs/results.md` for
the same seeds; the LLM summary appears with the key and degrades gracefully without it.

**Effort:** about 2 h. **Risk:** none material; keep it seeded and reproducible.

### Order of work and budget

1. **A** first (largest effect on the pitch, enables B). — **DONE 2026-09-19**
   (commit `f257180`, ahead of the 3-4 h estimate). Details:
   * `signalflow/agent.py` + `POST /api/agent`; tools `simulate`,
     `simulate_network`, `compare`, `explain_last`; single-JSON-object protocol,
     3 rounds + 1 forced final, 2 repairs, then deterministic keyword path
     (no key, protocol failure, or budget exhaustion) — the endpoint always
     answers with `{answer, model, source, steps[], note?, cached?}`.
   * UI: "Frag SignalFlow" panel has a two-mode switch — 🤖 **Agent** (default,
     runs tools, collapsible step trace with model turn/args/digest) and
     💬 **Erklären** (fast narrate of the on-screen run via `/api/explain`);
     voice + mic work in both. Answer cache + tool LRU for demo latency.
   * Live-verified on Qwen2.5-7B: "Ferien + 15 % Lkw" numbers equal a manual
     `run_scenario` (same seed); explain_last uses the dashboard's LAST run;
     one question chained simulate×2 + compare. Latency ~8-14 s first answer,
     instant on cache hit.
   * Bonus fix: `Config.from_dict` no longer AttributeErrors (500) when a
     client posts a read-only property name such as `"scenario"`.
   * 21 unit tests (scripted fake LLM, hermetic) + 2 API tests → 87 total.
2. **C** next (fast, gives a non-code artifact for the video/slides). —
   **DONE 2026-09-19**: `tools/report.py` (KW-38 report committed under
   `reports/`), four scenarios + district, LLM executive summary **gated by
   number tracing** — the live model's first two summaries contained an
   untraceable "9273 Fz/h" and were rejected in favour of the deterministic
   summary (audit note included). 10 tests (report + tracing).
3. **B** last (quality polish on top of A). — **DONE 2026-09-19**: `mode:"panel"`
   on `/api/agent` — analyst (the solo tool loop) → **critic** (checks numbers +
   premise against the digests, may demand one revision with different args) →
   **writer** (final answer + "Prüfung:" line). The hard anti-hallucination rule
   is enforced **deterministically** (`agent.unsupported_numbers`, German number
   formats incl. the 9.273 ambiguity): an untraceable number in the draft or in
   the writer output is rejected; an unrepairable draft falls back to a fully
   verified deterministic answer. Live-run: the analyst twice cited an
   untraceable figure, the gate rejected it, the safety net held — no fake
   number reached the answer. 7 pipeline tests; 104 total.

Total about 6-8 h. Everything stays in the existing stack; tests must stay green after
each step, and the demo path (`/api/explain`, dashboards, precompute) must keep working
unchanged while the new endpoint is added beside it.
