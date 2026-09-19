# SignalFlow — unabhängige Ende-zu-Ende-Verifikation

- **Datum:** 2026-09-18 (Europe/Berlin)
- **Prüfer:** unabhängiger Sub-Agent (Skeptiker-Rolle, nicht Autor)
- **Objekt:** `/Users/kosi/Documents/Dev/munichtechexpo/SignalFlow` (reines Python-Stdlib-Backend + Vanilla-JS-Frontend)
- **Eingeschränkung eingehalten:** Es wurden ausschließlich `tests/test_api.py` und `tests/VERIFICATION.md` neu angelegt. Bestehende Dateien (`server.py`, `signalflow/*`, `web/*`) wurden **nicht** verändert.
- **Umgebung:** Python 3.14.7, Node v26.8.1, macOS (Darwin 22.6.0, x64)
- **Umgebungs-Hinweis:** Auf `127.0.0.1:8000` lief bereits ein fremder `server.py`-Prozess (PID 5148, gestartet 19:58, vor dieser Session). Er wurde **nicht** angefasst; alle Verifikationen nutzten bewusst andere Ports (8123 bzw. einen Ephemeral-Port in den Tests).

**Gesamturteil: FUNKTIONIERT** (für den Demo-Hackathon-Zweck). Alle dokumentierten Endpunkte antworten, die Simulation ist deterministisch und plausibel, das Frontend ist syntaktisch valide und konsistent mit dem Backend. Es gibt **keine blockierenden Bugs**, aber mehrere ehrliche Robustheits-/Kosmetik-Schwächen (unten dokumentiert).

---

## 1) Bestehende Testsuite

```
python3 -m unittest discover -s tests -v
```

Ergebnis vor meinen Ergänzungen: **11 Tests, alle OK** (0.723s).
Nach Ergänzung von `tests/test_api.py`: **30 Tests, alle OK** (~2s).

---

## 2) Simulation — Kennzahlen (Schritt 2)

```
python3 -c "from signalflow.simulation import run_scenario; o=run_scenario({'duration_min':30}); print(o['improvement'])"
```

Zweimal identisch ausgeführt → **deterministisch** (identische `summary` und `improvement`).

`improvement` (30 min, Defaults, peak):
```
{'avg_delay_pct': 24.5, 'throughput_pct': 1.0, 'max_queue_pct': 3.8, 'co2_pct': 24.5, 'wasted_green_pct': 68.4}
```

| Metrik | Fixed | Adaptive |
|---|---|---|
| arrived | 2211 | 2211 (identisch, fairer Vergleich) |
| served | 2182.5 | 2205.0 |
| **Ø Verzögerung (s)** | **53.86** | **40.67** |
| Ø Queue | 66.16 | 49.95 |
| max Queue | 132.0 | 127.0 |
| Durchsatz (veh/h) | 4365.0 | 4410.0 |
| wasted green (s) | 374.0 | 118.0 |
| total delay (veh·s) | 119088.0 | 89912.0 |
| CO₂-Proxy (g) | 136951.2 | 103398.8 |
| links im System | 28.5 | 6.0 |
| Frames / Entscheidungen | 451 | 451 / 96 |

**Plausibilitätsprüfung:** Ja — der adaptive Regler senkt die Ø-Verzögerung real um **24.5 %** (53.86s → 40.67s), senkt kumulierte Verzögerung/CO₂/Leerlaufgrün deutlich und lässt weniger Fahrzeuge im System. Der Vergleich ist fair (identischer Arrival-Stream für beide Controller). Einschränkung: das ist ein **makroskopisches Queueing-Modell** (im Docstring ehrlich so benannt), kein validiertes Mikro-Simulationsmodell und nicht gegen Echtdaten kalibriert — die 24.5 % sind modellintern, nicht empirisch.

**Nuance (kein Bug):** Die Verbesserung ist *nicht* uniform. Im 5-Minuten-Lauf (siehe unten) wird `max_queue_pct` **negativ** (adaptive −16.1 %, also *schlechtere* Max-Queue) bei gleichzeitig besserer Ø-Verzögerung. Kurzfristig/niedrige Nachfrage ⇒ adaptive nicht durchweg überlegen.

---

## 3) Server — Endpunkt-Matrix (Schritt 3)

Server: `cd signalflow && SIGNALFLOW_PORT=8123 python3 server.py` (Hintergrund), danach beendet.

| Request | Status | Beobachtung |
|---|---|---|
| `GET /` | **200** | `text/html`, 7850 B, enthält `id="main"` (nicht `id="app"` — Brief erlaubt „ähnliche Struktur"), `<title>SignalFlow`, `src="app.js"` |
| `GET /styles.css` | **200** | `text/css`, 14420 B |
| `GET /app.js` | **200** | `application/javascript`, 43473 B |
| `HEAD /` | **200** | kein Body (korrekt) |
| `OPTIONS /api/simulate` | **204** | CORS-Header gesetzt |
| `GET /api/health` | **200** | `{"ok":true,"version":"0.1.0","featherless":false,"elevenlabs":false}` |
| `GET /api/config` | **200** | vollständige Default-Config (duration_min=30, demand N/E/S/W …) |
| `GET /api/gibtsnicht` | **404** | `{"error":"unknown endpoint", …}` |
| `GET /nope.txt` | **404** | `{"error":"not found", …}` |
| `GET /../server.py` (path-as-is) | **404** | serviert **nicht** server.py ✅ |
| `GET /..%2fserver.py` | **404** | ✅ |
| `GET /../.env` (raw socket) | **404** | `.env` wird nicht ausgeliefert ✅ |
| `POST /api/simulate {"duration_min":5}` | **200** | valides JSON: `summary.fixed`, `summary.adaptive`, `improvement`, `fixed.frames`(300), `adaptive.frames`(300), `adaptive.decisions`(15); Frame-Keys `t,phase,kind,green,q,served,delay_s`; `q` mit 12 Movements |
| `POST /api/explain {"question":"…"}` | **200** | `{"answer":…,"source":"fallback","model":null}` (ohne Key) ✅ |
| `POST /api/tts {"text":"hi"}` | **501** | `{"error":"ElevenLabs API key not configured", "hint":…}` ✅ |
| `POST /api/tts {}` | **400** | `{"error":"empty text"}` |
| `POST /api/unknown` | **404** | `{"error":"unknown endpoint", …}` |

5-Min-Lauf-Kennzahlen: `{'avg_delay_pct': 16.2, 'throughput_pct': 5.1, 'max_queue_pct': -16.1, 'co2_pct': 16.2, 'wasted_green_pct': 78.4}` → Ø-Verzögerung besser, Max-Queue schlechter (siehe Nuance oben).

---

## 4) Frontend-Statik (Schritt 4)

- `node --check web/app.js` → **SYNTAX OK**.
- **fetch-Pfade vs. Server-Routen:** app.js ruft genau `/api/health`, `/api/config` (GET) und `/api/simulate`, `/api/explain`, `/api/tts` (POST). Der Server routet exakt diese fünf. **Keine verwaisten Pfade** in beide Richtungen.
- **IDs:** Alle 32 in app.js referenzierten IDs (`$('…')`, `getElementById`, `setBadge`) existieren in `index.html`; die 15 KPI-IDs (`kpi-<key>-{fixed,adaptive,delta}`) werden zur Laufzeit von `buildKpiCards()` erzeugt. Umgekehrt existieren `cell-main`, `cell-alt`, `main` in HTML, werden aber nicht per `$()` referenziert — `cell-main`/`cell-alt` sind in `styles.css` verwendet, `main` ist der Mount-Punkt. **Keine fehlenden IDs, keine toten Referenzen.** ✅

---

## 5) Automatisierte Tests (`tests/test_api.py`)

Stdlib-only (`unittest`, `urllib`, `socket`, `subprocess`), **kein pytest**. Startet `server.py` als Subprozess auf einem **freien Ephemeral-Port** (`SIGNALFLOW_PORT`), entfernt `FEATHERLESS_/ELEVENLABS_API_KEY` aus der Child-Env für deterministische Fallback-Checks, wartet per Health-Poll auf Bereitschaft und beendet den Server im `tearDownClass`. Path-Traversal wird über einen **Raw-Socket** getestet (kein Client-seitiges Normalisieren von `..`).

Lauf: `python3 -m unittest discover -s tests -v` → **30 Tests OK** (11 alt + 19 neu).

---

## 6) Gefundene Bugs / Unstimmigkeiten

### B1 — Fehlende Eingabevalidierung: `POST /api/simulate` antwortet mit HTTP 500 *(Schweregrad: mittel-niedrig)*
Ungültige Eingaben werden ungeprüft in `Config.from_dict()` gesetzt und crashen erst später; der generische `except Exception` in `server.py` (Z. 149-150) macht daraus 500 statt 400.

Repro (Server läuft):
```
curl -s -X POST -H 'Content-Type: application/json' -d '{"duration_min":0}'   .../api/simulate   # → 500 ZeroDivisionError
curl -s -X POST -H 'Content-Type: application/json' -d '{"duration_min":"abc"}' .../api/simulate # → 500 ValueError (int('abcabc…'))
curl -s -X POST -H 'Content-Type: application/json' -d '{"duration_min":null}'  .../api/simulate # → 500 TypeError
curl -s -X POST -H 'Content-Type: application/json' -d '{"demand":{"N":{"T":"x"}}}' .../api/simulate # → 500 ValueError float
```
- Erwartet: `400 Bad Request` mit Validierungsfehler.
- Tatsächlich: `500` mit Python-Fehlermeldung an den Client.
- Ursache `duration_min=0`: `cfg.steps == 0` → Division durch 0 in `signalflow/simulation.py` Z. 406 (`served / (cfg.steps / 3600.0)`). `Config.steps` (Z. 80-82) / `from_dict` (Z. 95-112) validieren nicht.
- Schweregrad *mittel-niedrig*: Der Prozess bleibt am Leben (kein Crash des Servers, weitere Requests funktionieren), und die UI sendet nur legitime Werte (Slider 5–60). Der offene Endpunkt ist aber ungeschützt.
- **Nicht selbst gefixt** (Auflage).

### B2 — Path-Prefix-Prüfung ist nicht pfad-bewusst *(Schweregrad: niedrig / latent)*
`server.py` Z. 84:
```python
if not str(target).startswith(str(WEB.resolve())) or not target.is_file():
```
Es wird auf **String-Präfix** geprüft, nicht auf Pfadgrenzen. Ein Geschwisterverzeichnis, dessen Name mit `web` beginnt (z. B. `web2/`, `webX/`), würde als „innerhalb web/“ akzeptiert und wäre auslieferbar. Isolierte Demonstration (nur Logik, keine Datei angelegt):
```
rel='../web2/secret' → resolved=…/signalflow/web2/secret → allowed_by_check=True
rel='../webX/any'    → resolved=…/signalflow/webX/any    → allowed_by_check=True
rel='../server.py'   → allowed_by_check=False  (korrekt blockiert)
rel='../.env'        → allowed_by_check=False  (korrekt blockiert)
```
- Erwartet: pfadbewusste Prüfung (z. B. `WEB.resolve() in target.parents` bzw. `os.path.commonpath`).
- Tatsächlich: aktuell **nicht ausnutzbar**, da kein Geschwisterordner mit `web`-Präfix existiert. Traversal aus `web/` heraus (`../server.py`, `../.env`) ist real blockiert ✅.
- Empfehlung: `Path.is_relative_to()` (Py3.9+) verwenden.

### B3 — Adaptive kann auf sich selbst „umschalten“ (from == to) *(Schweregrad: niedrig / kosmetisch)*
In `MaxPressureController.step`, `signalflow/simulation.py` Z. 283-301: Erreicht der Green die `max_green`-Grenze, während **keine** konkurrierende Phase Druck > 0.6 hat (`best_funded is None`), wird `target = best`; ist `best == cur`, schaltet „auf sich selbst“ → unnötiger Gelb+All-Rot-Zyklus (−4 s verlorene Grünzeit) und ein `from == to`-Eintrag im Entscheidungsprotokoll.
Beobachtet (reine Simulation):
```
demand_multiplier=0.0 → decisions=57, davon 2× from==to
demand_multiplier=0.1 → decisions=108, davon 1× from==to
demand_multiplier=1.0 → 0
Beispiel: {'t':49,'from':'NS_THRU','to':'NS_THRU','reason':'switch NS_THRU->NS_THRU (max green reached): pressure 0.0 vs current 0.0; worst wait 49s'}
```
Bei Default-Nachfrage (1.0) **tritt es nicht** auf. Reine Modell-/Anzeigekosmetik, kein Absturz.

### B4 — Default-Werte weichen zwischen Frontend und Backend ab *(Schweregrad: informativ)*
`web/app.js` Z. 45-55 (`DEFAULT_CONFIG`) setzt `min_green: 20, switch_hysteresis: 2.0`; Backend-Default ist `min_green: 24, switch_hysteresis: 3.0`. Zur Laufzeit überschreibt `loadConfig()` die Frontend-Defaults mit der Server-Config, daher **nur im Offline-Demo-Modus** (`runDemo`) relevant. Kein Funktionsfehler.

### B5 — „Detector-Lookahead“ ist per Default wirkungslos und sogar schädlich *(Schweregrad: informativ)*
`lookahead_weight` ist werksseitig `0.0` (Config Z. 79), d. h. der in sich selbst so kommentierte „detector-based demand anticipation horizon“ (Z. 77-78, Z. 246-248) trägt **nichts** bei; `_update_rate`/`rate_hat` werden berechnet, aber nie gewichtet genutzt. Wird das Feature aktiviert, verschlechtert es das Ergebnis:
```
lookahead_weight=0.0 → avg_delay_pct = 28.4
lookahead_weight=1.0 → avg_delay_pct = -1.8  (adaptive wäre schlechter als fixed)
```
Also toter/fehl-getunter Code, der den (selbst formulierten) Anspruch „detector-based anticipation“ nicht einlöst.

### B6 — Ungültiger JSON-Body wird still ignoriert *(Schweregrad: informativ)*
`POST /api/simulate` mit Body `not-json` → **200** und Default-Lauf (`duration_min=30`). `_read_json()` (Z. 70-77) fängt `ValueError` ab und liefert `{}`. Graceful, aber ohne Fehlersignal an den Client.

---

## 7) Restrisiken / Nicht geprüft

- **Externe Integrationen** (Featherless-Chat, ElevenLabs-TTS) wurden **ohne Keys** geprüft: nur der Fallback-Pfad (`source: "fallback"`) bzw. `501` sind verifiziert. Der echte Erfolgspfad (HTTP-Call, Audio-Bytes) ist **nicht** getestet, da keine Keys vorliegen.
- **Browser-Rendering** (Canvas-Zeichnung, tatsächliche Animation, SpeechRecognition) wurde nur statisch geprüft (`node --check`, ID-/Pfad-Abgleich), **nicht** in einem echten Browser ausgeführt.
- **Modelltreue:** Validität der 24.5 % gegenüber realem Verkehr ist nicht belegt (Modell, kein Feldtest) — ehrlich als Modell gekennzeichnet.
- **Nebenläufigkeit:** Der Server nutzt `ThreadingHTTPServer`; die globale `LAST`-Variable (`server.py` Z. 50) ist nicht threadsicher. Bei parallelen Requests könnte `/api/explain` den Kontext eines anderen Laufs sehen. Im Single-User-Demo unkritisch, nicht fokussiert getestet.
- Der Domain-Fall `duration_min < 0` liefert kein Crash, aber `meta.steps` negativ (unsinnig) — Teil von B1.

---

## 8) Fazit

**FUNKTIONIERT.** Die Kernbehauptungen des Projekts halten der Prüfung stand: Der Server liefert das Dashboard und alle fünf API-Routen korrekt aus; die Simulation ist deterministisch (2× identisch) und der adaptive Regler senkt die Ø-Verzögerung reproduzierbar um **24.5 %** (30 min); Path-Traversal aus `web/` heraus ist blockiert; das Frontend ist syntaktisch valide und vollständig mit dem Backend konsistent; die gesamte Testsuite (30 Tests) ist grün.

Abstriche betreffen **Robustheit und Kosmetik**, nicht die Funktion: fehlende Eingabevalidierung (500 statt 400, B1), eine latente (nicht ausnutzbare) Prefix-Schwäche im Pfadcheck (B2), der Selbst-Umschalt-Fall bei Null-Nachfrage (B3) sowie divergierende Offline-Defaults und toter Lookahead-Code (B4/B5). Keine dieser Punkte verhindert den Demo-Betrieb.

---

## Nachtrag: Nachbesserung durch Parent (nach Verifikation)

Die vom Verifier gemeldeten Punkte wurden behoben und erneut geprüft:

- **B1 (behoben):** `Config.from_dict` validiert jetzt alle Felder und wirft `ValueError`;
  `server.py` fängt das und liefert **HTTP 400**. Live geprüft: `duration_min=0` → 400
  (`duration_min must be between 1 and 1440`), kaputtes JSON → 400.
- **B2 (behoben):** Pfadprüfung in `server.py` ist jetzt pfadbewusst
  (`== web_root or startswith(web_root + os.sep)`). Live: `/../server.py` und
  `/../web2/x.css` → 404.
- **B3 (behoben):** Bei fehlender „funded" Konkurrenz-Phase hält der adaptive Regler
  die aktuelle Phase, statt auf sich selbst zu schalten (keine Phantom-Räumzeit mehr).
- **B5 (behoben):** Experimenteller Detektor-Lookahead entfernt (war bei Aktivierung
  schädlich und standardmäßig inaktiv). README entsprechend korrigiert.
- **B4 (behoben):** Offline-Demo-Defaults im Frontend an das Backend angeglichen
  (`min_green` 24, `switch_hysteresis` 3.0).

**Re-Check nach Fix:** `python3 -m unittest discover -s tests` → **30/30 grün**;
Referenzszenario unverändert: Ø-Delay 53.86s → 40.67s (**−24.5 %**), Leerlaufgrün −68.4 %.
