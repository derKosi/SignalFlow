# Challenge mapping

Challenge: **“Smart Cities: Adaptive Traffic Flow”** — slug
`smart-cities-traffic-flow-2026`, track `smart_cities`, owner *MunichTech EXPO
Urban Mobility Track*. (Verified against the challenge page and its API.)

## What the challenge asks, and where we answer it

| Challenge text | SignalFlow |
|---|---|
| *“Design a system that adapts signal timing to live conditions.”* | Queue-pressure (max-pressure) controller, per junction and network-wide |
| *“…reacting to simulated or sample sensor/camera feed data…”* | Sensor-count feed mode (`arrival_source=csv`, `/api/feed`, detector dropout) |
| *“…with a visual dashboard showing before/after flow improvement.”* | Junction dashboard **and** district map, both with before/after KPIs and animation |
| *“A simulation or prototype…”* | Two simulations + working prototype web app |
| *“Simulation-based solutions are acceptable — no hardware.”* | Fully software; single command |
| *“Any stack.”* | Python stdlib + vanilla JS |

## Evaluation criteria → evidence

| Criterion | Our evidence |
|---|---|
| **Measurable flow improvement in simulation** | Junction −24.5 % delay; district −49.7 % / −64.6 % delay, +16 % / +26 % throughput; all reproducible via seed |
| **Realism of the approach** | Real OSM networks; saturation flow, clearance times, spillback, rush-hour demand, lossy detectors; parameters from traffic-engineering rules of thumb |
| **Technical execution** | 48 passing tests; deterministic; graceful degradation; input validation; path-traversal guard |
| **Demo quality** | Animated junction + district maps, live decision log, natural-language + voice explanation, 2–3 min script |

## Format facts

* **Team size:** 1–5. **Challenge deadline:** 2026-09-20.
  Platform submission window closes **2026-09-21 23:30 CEST**; public voting
  **2026-09-20 09:00 → 2026-09-21 17:00**.
* **Prizes:** 5 non-cash awards (Grand Challenge, Best Applied AI, Best
  Industry/Enterprise, Best Sustainability & Societal Impact, Best
  Student/Early Talent) plus sponsor perks: ElevenLabs (3 mo Creator for all,
  3 mo Pro overall, **6 mo Scale** for *Best Project Built with ElevenLabs*) and
  Featherless ($300 for *Best Project Built with Featherless*, $25 for all).
* **Dataset:** *"sample open traffic-sensor dataset … provided at the briefing"* —
  not publicly downloadable; we ship a synthetic stand-in with the same shape
  (see [data.md](data.md)).

## Prize strategy

1. **Hit the explicit criteria literally.** The rubric names *measurable flow
   improvement*, *realism*, *technical execution*, *demo quality* — each has a
   concrete artifact above.
2. **Double-dip the sponsor prizes.** The **voice layer (ElevenLabs)** and the
   **LLM explainer (Featherless)** are first-class features, not add-ons, so the
   project is a direct entry for both special awards — the most reliably winnable
   prizes because they are sponsor-gated, not jury-gated.
3. **Say "why it matters for Europe" out loud.** Devpost asks for it explicitly;
   the autonomy/sovereignty angle (local-first, EU-hostable, public-infra standards)
   is in the README and submission text.
4. **Show numbers, not adjectives.** Every claim links to a reproducible command.

## Getting the sponsor access

See the README section *"Getting access to the sponsor tools"*. In short:
ElevenLabs key from *Workspace settings → API Keys*; Featherless key from the
dashboard (OpenAI-compatible, base `https://api.featherless.ai/v1`). The hackathon
promo codes/setup guide come from the organisers (Devpost *Updates*, event chat, or
the sponsor booth). Both keys are optional — the app degrades gracefully.
