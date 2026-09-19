# SignalFlow — 2–3 minute demo script

The hackathon requires a short demo video (“screen recording or live
demonstration is sufficient”). Record in 1080p, keep it under 3 minutes.

---

**0:00 – 0:20 · The problem**
> “This is a Munich intersection near the expo district. At rush hour it jams,
> because the signals run on a fixed plan — they can't see the traffic.
> We rebuilt the controller so it reacts to the live queue — and shows its work.”

**0:20 – 0:45 · Live run**
- Start: `./run.sh` → open `http://127.0.0.1:8000`.
- Point at the **intersection canvas**: “Each approach is drawn with its queues;
  the signal heads go green per phase. This is the *adaptive* controller running.”
- Hit **Play**. Let the rush-hour ramp build (the demand profile peaks mid-run).

**0:45 – 1:15 · Before/after proof**
- Point at the **KPI cards**: “Average delay drops from 53.9 to 40.7 seconds —
  minus 24.5 %. Wasted green falls by 68 % because we end phases once their queue
  is cleared. Idling CO₂ proxy falls by the same 24.5 %.”
- Point at the **before/after bars** and the **delay timeline** (two lines,
  fixed vs adaptive diverging as load rises).
- Move the **Load** slider to 0.8× → “Off-peak the gain is even bigger, over 50 %.”

**1:15 – 1:50 · Explainability (the differentiator)**
- Open the **“Why? — Entscheidungsprotokoll”** panel: “Every phase switch is logged
  with the pressure numbers that caused it — no black box.”
- Type in **“Frag SignalFlow”**: *“Why did you switch to EW_THRU just now?”*
  → Featherless explains in plain language, citing the exact pressures.
- Press **🔊 Vorlesen** → ElevenLabs reads it aloud. “So a traffic operator can
  *ask the intersection why it did something* — hands-free.”

**1:50 – 2:20 · Engineering**
- Show the terminal: `python3 -m unittest discover -s tests` → **55 tests pass**.
- “Zero dependencies, one command, deterministic seeds so every number is
  reproducible. The controller was calibrated on a demand grid, not hand-tuned.”

**2:20 – 2:45 · Europe & scale**
- “It's a drop-in controller: any signalised junction, configurable per site.
  Data stays local, and it's built to run on European infrastructure —
  digital sovereignty, not a US cloud dependency.”

**2:45 – 3:00 · Close**
- “SignalFlow: adaptive signal control that shows its work.
  Built in [X] hours for MunichTech EXPO 2026.”

---

## Optional: Netzwerk-Modus (15 s, falls Platz ist)
- Auf **network.html** wechseln (Link im Header).
- Region **Messe München / ICM Riem** vs **Innenstadt / Altstadtring** umschalten —
  “dieselbe Steuerung, jetzt auf dem echten OpenStreetMap-Netz eines ganzen Viertels,
  hunderte Kreuzungen gleichzeitig.”
- Play drücken: die Karte färbt sich nach Stau; adaptiv baut die Staus sichtbar ab.
- Auf die **„Tuned\*“**-KPI-Zeile zeigen: “dieser feste Plan wurde aus reinen
  Detektor-Zählungen abgeleitet — kein Oracle-Wissen — und holt 80–100 % des
  Orakel-Gewinns.”
- Kennzahlen nennen: “Innenstadt: Ø-Verzögerung −65 %, Durchsatz +26 % über das ganze Netz.”

## Recording checklist
- [ ] Terminal font ≥ 16 pt, browser at 100 % zoom, hide bookmarks bar.
- [ ] Run once before recording so data is cached and the UI is warm.
- [ ] Have the two questions ready; type slowly.
- [ ] End on the KPI deltas, frozen on screen.
- [ ] Export ≤ 3:00, upload (YouTube unlisted is fine) and paste the link in Devpost.
