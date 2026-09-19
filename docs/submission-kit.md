# Submission kit

Copy-paste material for the Devpost submission and the demo video. **Video and
voice-over are prepared here but not yet recorded** (the voice-over lines are ready
to be spoken by ElevenLabs once the API key is set).

---

## 1. Devpost fields

**Title**
> SignalFlow — adaptive, explainable traffic-signal control

**Tagline**
> From one junction to a whole city: signal control that beats the fixed plan and explains every decision.

**Elevator pitch (1–2 sentences)**
> SignalFlow replaces fixed-time signal plans with an adaptive, explainable
> controller — and proves the gain on one junction and on six real German districts
> from OpenStreetMap, with a live before/after dashboard, decision log and voice.

**Built with (tags)**
> python, javascript, html5-canvas, simulation, max-pressure-control, openstreetmap,
> overpass-api, nominatim, featherless, elevenlabs, traffic-engineering

**Links**
> Repo: <add public repo URL> · Demo video: <add YouTube/Vimeo URL> · Live: local (`python3 server.py`, no deps)

**Team** — <add names, 1–5 people>

### About the project — long form

**Inspiration.** Munich's junctions near the expo district back up at rush hour
because signal timing is *fixed* — a plan that cannot see the queue in front of it.
We wanted a controller that reacts to live conditions **and** can explain itself.

**What it does.** SignalFlow runs the *same* traffic through a fixed plan and an
adaptive controller and shows the difference frame by frame. Three dashboard modes:
a single junction (with kerb-accurate right-hand traffic, turning paths and a live
`Σ Queue`), a district on real OpenStreetMap street networks (six German regions,
selectable, plus *add any place live*), and an explainable decision log you can ask
in natural language — answered in text and in speech.

**How we built it.** Deterministic discrete-time queueing model (junction) and a
mesoscopic link-queue model (district) — Python standard library only, vanilla JS
canvas front-ends, one command to run. Adaptive control is max-pressure for the
junction and measured-inflow **demand-proportional splits** (Webster/SCATS-like) for
the district, plus green-wave corridor coordination. Every number is reproducible
from a seed; 55 stdlib tests; CI on GitHub Actions.

**Challenges.** Our first adaptive controller was *worse* than fixed-time (it churned
phases and burned green on clearance). Fixing it required instrumenting phase
timings and calibrating on a demand grid. We then found and fixed three district
bugs (OD reachability loss, terminating trips looping, two-way deadlocks). Most
recently, adding a **demand-tuned** baseline showed our adaptive advantage was partly
an artefact of a naive baseline — we now report both baselines honestly, and we
**closed the oracle gap**: a plan tuned purely on detector counts (count-based OD,
Richardson-Lucy) recovers 80–100 % of the oracle's improvement, and with opt-in
Webster cycle-lengthening adaptive beats the oracle on Riem and Köln outright.

**Accomplishments.** −24.5 % delay at the reference junction; −50…−65 % across
districts vs a naive fixed plan; a roundabout/signal trade-off that flips with load;
a detector-count OD pipeline that replaces oracle knowledge with measurements
(80–100 % recovery); and a controller that is within a few percent of a
demand-**oracle** baseline while beating the naive plan by 50–70 %.

**What we learned.** "Adaptive" is not automatically better; you must account for
clearance cost, calibrate, and compare against a strong baseline. Also: honest
negative results (a rigid green wave loses in a dense grid; Webster cycles lose in
short-link grids) are more convincing than cherry-picked wins.

**What's next.** Calibrate with real detector data, close the detector feedback loop
(SCOOT/SCATS-style), iterative OD refinement (estimate → retime → recount),
MAXBAND-optimised green waves, and a
junction-type library beyond T-junctions and roundabouts.

---

## 2. Demo video script (2–3 min)

Record at 1080p. Keep the browser at 100 % zoom, terminal ≥ 16 pt.

| Time | Beat | What to show |
|---|---|---|
| 0:00–0:15 | Problem | “Rush hour near the expo district: signals that cannot see the traffic.” |
| 0:15–0:45 | Junction live | Open `/`; animation at 10×; point at the `Σ Queue` draining on green; toggle **Kreuzungstyp** to *T-Kreuzung* then *Kreisverkehr* |
| 0:45–1:05 | Before/after | Preset **Berufsverkehr** → then **Ferien**; read the KPI deltas |
| 1:05–1:35 | Explainability | Decision log → ask “Warum hast du auf EW_THRU umgeschaltet?” → press **🔊 Ergebnis vorlesen** |
| 1:35–2:10 | District | `/network.html`: pick *München Innenstadt*, press **Simulieren**, show fixed/tuned/adaptive/coordinated; switch to *Riem* for the green wave |
| 2:10–2:35 | Live region add | Type “Tübingen Zentrum” → **Hinzufügen** → it appears and simulates |
| 2:35–2:55 | Engineering + close | Terminal: `python3 -m unittest discover -s tests` (55 OK); “zero dependencies, one command, reproducible from a seed.” |

## 3. Voice-over lines (ready for ElevenLabs TTS)

German narration, one clip per beat — generate later with the ElevenLabs key:

1. „Zur Rush Hour stauen sich Münchens Kreuzungen, weil die Ampeln feste Zeiten haben — sie sehen den Verkehr vor sich nicht."
2. „SignalFlow simuliert eine Kreuzung zweimal: mit festem Signalplan und mit einem adaptiven Regler, auf identischem Verkehr. Rechtsabbieger fahren mit dem Geradeaus-Verkehr, Linksabbieger haben ihre eigene Phase."
3. „Man sieht die Warteschlange abfließen, sobald Grün ist — die Summe der Fahrzeuge sinkt sichtbar."
4. „Im Berufsverkehr ist der Gewinn kleiner, in den Ferien viel größer: weniger Verkehr heißt mehr freie Kapazität für den Regler."
5. „Jede Umschaltung wird mit ihren Druckzahlen protokolliert. Man kann die Kreuzung fragen, warum sie so entschieden hat — und sie antwortet, vorgelesen von ElevenLabs."
6. „Auf Stadtebene laden wir echte OpenStreetMap-Netze: mehrere deutsche Städte, hunderte Kreuzungen gleichzeitig. Der adaptive Regler senkt die Verzögerung um die Hälfte bis zwei Drittel gegenüber dem festen Plan."
7. „Und wir fügen live einen Ort hinzu: Adresse eintippen, OpenStreetMap laden, sofort simulieren."
8. „Alles läuft ohne Abhängigkeiten, mit einem Befehl, deterministisch über einen Seed — und mit fünfzig Tests, die grün sind."

## 4. Pre-submission checklist (P0)

- [ ] Repo public or shared with judges
- [ ] Video recorded (≤ 3:00), uploaded, link in Devpost
- [ ] Both baselines reported in the submission text (naive **and** tuned)
- [x] Licence decided: **PolyForm Noncommercial 1.0.0** + AI disclosure ([NOTICE.md](../NOTICE.md)); rules allow non-commercial (public repo + reviewable core)
- [ ] Sponsor paths tried with real keys (Featherless + ElevenLabs)
- [ ] Dashboards visually checked in a browser (T-junction, roundabout, turning paths)
- [ ] `python3 tools/precompute.py` run so the demo is instant
