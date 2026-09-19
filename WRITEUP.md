# SignalFlow — Writeup (Deutsch, ausführlich)

**Adaptive, erklärbare Ampelsteuerung — von einer Kreuzung bis zum ganzen
Stadtteil auf echten OpenStreetMap-Netzen.**

Geschrieben für den **MunichTech EXPO 2026** Hackathon, Challenge *„Smart
Cities: Adaptive Traffic Flow”*.

> Dieses Writeup gibt es in vier Fassungen:
> **Deutsch ausführlich** (diese Datei) ·
> [Deutsch einfach](WRITEUP.einfach.md) ·
> [English detailed](WRITEUP.en.md) ·
> [English simple](WRITEUP.en-simple.md)
> — im Browser unter <http://127.0.0.1:8000/writeup.html> umschaltbar.

---

## 1. Das Problem

Münchens Ampeln im Expo-Viertel stauen sich zur Rushhour, weil ihre Schaltung
**fest** ist — ein offline gezeichneter Plan, der die Schlange vor sich nicht
sieht. Die Challenge fragt nach einer Steuerung, die sich **live anpasst** und
den Gewinn zeigt. Darin stecken zwei Fallen: ein System, das Anpassung nur
*behauptet*, und eines, das nur an einer einzelnen Kreuzung funktioniert.

SignalFlow umgeht beide: Es schickt den **selben Verkehr** (gleicher Seed)
durch einen festen Plan und einen adaptiven Controller — nebeneinander,
Bild für Bild. Und es skaliert vom Einzelknoten bis auf **sechs echte
deutsche Stadtteilnetze**.

## 2. Die vier Strategien — und wie sie sich unterscheiden

Der Kern der Auswertung ist ein **fairer Vierkampf**. Jede Strategie hat eine
andere Vorstellung davon, was eine Ampel wissen darf:

| Strategie | Kernidee | Was sie über den Verkehr weiß? | Reagiert live? | Typische Stärke | Typische Schwäche |
|---|---|---|:--:|---|---|
| **Fixed-Time** | Fester Phasenplan nach klassischer Handbuch-Logik ([Webster 1958](docs/references.md)) | nichts — nur den Fahrplan | ✗ | planbar, braucht keine Sensorik | verschenkt Grün vor leerer Straße, bricht bei Überraschungen ein |
| **Adaptiv** *(SignalFlow)* | **Max-Pressure**: die Phase mit dem größten Schlangendruck bekommt Grün ([Varaiya 2013](docs/references.md)), plus Min-Grün, Schalthysterese, Früh-Exit bei leerer Schlange | live Warteschlangen aller Richtungen, sekündlich | ✓ | ungleiche & wechselnde Last; −24 bis −81 % Verzögerung | braucht Detektion; im übersättigten Grid begrenzt |
| **Koord. (Grüne Welle)** | gemeinsamer Zyklus + Versatz-Offsets entlang des Korridors (MAXBAND-Idee, [Little et al. 1981](docs/references.md)) | Korridor-Geometrie & Fahrzeiten (statisch) | ✗ | saubere Arteriale (Riem: 70,5 s) | unterlegen im dichten Mehrfluss-Grid (Altstadtring) |
| **Tuned\*** (Detektor-Plan) | fester Plan, aber aus **echten Zählungen** getunt: Stop-Line-Counts → OD-Schätzung ([Cascetta 1984](docs/references.md)) → Grünzeitsplits | historische Detektor-Zählungen | ✗ | schlägt auf kurzmaschigen Grids (Berlin, Hamburg) sogar Adaptiv | starr — eine Baustelle oder Veranstaltung sieht er nicht |

Merksatz: **Adaptiv gewinnt fast überall — aber nicht immer gegen einen Plan,
der aus echten Daten gelernt hat. Und genau das zeigen wir, statt es
wegzulassen.**

## 3. Wie die Simulation grob funktioniert

**Einzelkreuzung.** Ein diskretes Warteschlangenmodell mit 1-Sekunden-Takt:
vier Zufahrten × (links / gerade / rechts) = 12 Bewegungen, Poisson-Ankünfte
mit Tagesgang (Berufsverkehr, Ferien, Wochenende), Abfertigung mit
Sättigungsfluss (1 800 Fz/h/Spur, PCE-gewichtet für Lkw/Bus), vier geschützte
Phasen. Verzögerung = Σ Schlange · dt; der CO₂-Wert ist ein Proxy aus
Standzeit. Beide Controller sehen **dieselbe Ankunftsreihe** — der Vergleich
ist Äpfel mit Äpfeln.

**Stadtteil.** Ein mesoskopisches **Link-Queue-Modell** auf dem echten
OSM-Graphen: Jeder gerichtete Link hat einen Fahrzeit-Bucket und eine
Stop-Line-Schlange; der Abfluss begrenzt Sättigungsfluss, nachgelagerten
Stauraum (Spillback, weiche Kappe) und Signalphase. Die Nachfrage ist eine
Gravitations-OD-Matrix, geroutet mit Dijkstra; Abbiegeanteile und ein
Exit-Share pro Link verteilen und beenden die Fahrten. Grundplan: fester
60-s-Zweiphasenzyklus; Alternative: Max-Pressure **pro Knoten**; die Grüne
Welle legt auf den längsten Korridoren gemeinsamen Zyklus und
Fahrzeit-Offsets (× 0,95). Netzwerke: **Messe/ICM Riem** (355 Knoten / 569
Links / 58 Signale), **Altstadtring** (2597 / 4159 / 708) sowie Berlin Mitte,
Hamburg Innenstadt, Köln und Heidelberg — live per OSM-Overpass
nachladbar.

## 4. Ergebnisse

**Einzelkreuzung** (30 min Peak, identischer Verkehr):

| Kennzahl | Fixed-Time | Adaptiv | Δ |
|---|---:|---:|---:|
| Ø Verzögerung / Fahrzeug | 53,9 s | **40,7 s** | **−24,5 %** |
| Durchsatz | 4 365 Fz/h | 4 410 Fz/h | +1,0 % |
| Verschwendetes Grün | 374 s | 118 s | −68,4 % |
| CO₂-Proxy (Leerlauf) | 136 951 g | 103 399 g | −24,5 % |

Über eine Last-Sweep (0,8–1,1×): mittlere Verzögerungs-Reduktion **39,9 %**
(54,8 % unbelastet, 16 % übersättigt).

**Stadtteil** (15 min Peak, echte OSM-Netze):

| Region | Signale | Fixed | Adaptiv | Koord. (Welle) |
|---|---:|---:|---:|---:|
| München — Messe/ICM Riem | 58 | 184,8 s | 92,9 s | **70,5 s (−61,9 %)** |
| München — Altstadtring | 708 | 266,5 s | **94,2 s (−64,6 %)** | 111,0 s |
| Berlin — Mitte | 204 | 189,1 s | **68,9 s (−63,6 %)** | 69,8 s |
| Hamburg — Innenstadt | 173 | 109,5 s | 38,4 s | **38,2 s (−65,1 %)** |
| Köln — Innenstadt | 102 | 150,6 s | **47,4 s (−68,5 %)** | 58,0 s |
| Heidelberg — Uni | 81 | 236,3 s | **44,5 s (−81,2 %)** | 75,5 s |

**Ehrlichkeits-Kasten.** Der Detektor-Plan **Tuned\*** gewinnt auf
kurzmaschigen Grids (Berlin, Hamburg) sogar gegen Adaptiv; mit zyklusbasiertem
Webster-Ansatz schlägt Adaptiv auf Riem (+8,2 %) und Köln (+2,5 %) erstmals
sogar den Orakel-Plan. Diese Befunde stehen unverändert in
[docs/results.md](docs/results.md) — starke Baselines und gezeigte Niederlagen
gehören zur Ehrlichkeit dazu.

## 5. Erklärbarkeit

Jeder Phasenwechsel wird mit seinen Drücken protokolliert; `/api/explain`
macht das Protokoll zu Prosa (Featherless, OpenAI-kompatibel), `/api/tts`
liest es vor (ElevenLabs) — ohne Keys antwortet ein deterministischer
Offline-Erklärer und die Stimme bleibt aus. Darüber hinaus ist **`/api/agent`
agentic**: Er plant Tool-Aufrufe (`simulate`, `simulate_network`, `compare`,
`explain_last`) über ein provider-portables Protokoll, führt sie gegen den
echten Simulator aus und zeigt die komplette Spur in der UI — Antworten
kommen aus Läufen, nicht aus der Phantasie des Modells. Ein
**Drei-Rollen-Selbstcheck** (`mode:"panel"`) geht weiter: Analyst → Kritiker
(prüft Zahlen *und* die Prämissen der Frage) → Writer, mit einer
Anti-Halluzinations-Regel, die im Code durchgesetzt wird.

## 6. Die Engineering-Story (was wirklich Zeit gekostet hat)

1. **Der erste adaptive Controller war schlechter als Fixed** (+57 %
   Verzögerung): zu häufiges Schalten fraß das Grünbudget durch
   Räumzeit (245 s vs 92 s). Fix: Min-Grün, Hysterese, Früh-Exit nur für
   leere Phasen, Kalibrierung auf einem Lastgitter. Lektion: *„adaptiv" ist
   nicht automatisch besser.*
2. **Die OD-Matrix verlor lautlos 60 % der Nachfrage** — unerreichbare
   Ein-/Ausfahrt-Paare auf dem gerichteten Graphen wurden verworfen. Fix:
   nur erreichbare Paare, Renormierung auf die Ziel-Nachfrage.
3. **Angekommene Fahrzeuge fuhren weiter** — Abbiegeanteile schickten
   beendete Trips im Kreis. Fix: expliziter Exit-Share pro Link.
4. **Zweiseitige Streets verkeilten sich** — harte Stauraumgrenzen
   verklemmten Linkpaare dauerhaft. Fix: weiche Kappe (× 1,35).
5. **Ein Alias-Bug versteckte sich hinter einem Glückstest** — der
   Netzcompiler löste Knoten-IDs über die Link-ID-Map; auf dem Testgitter
   überlappten beide Räume zufällig. Auf echten Daten verschwanden alle
   Knoten.

Jedes davon ist ein ADR in [docs/design-decisions.md](docs/design-decisions.md).

## 7. Ehrliche Grenzen

* Mesoskopisch, keine Mikrosimulation: kein Car-Following, kein
  Spurwechsel, keine Gap-Acceptance.
* CO₂ ist ein Standzeit-Proxy; Sättigungsfluss (1 800) und PCE-Tabelle sind
  Plausibilitätswerte, nicht kalibriert (vgl. Tarko et al., ~8–10 % Fehler
  auch in der Praxis).
* Der Detektor-Feed ist Modellannahme (Zählungen als *Datenquelle*); die
  Rückkopplung im Regelkreis (SCOOT/SCATS-artig) folgt.
* Der OD-*Generator* bleibt synthetisch (Gravitation); die OD-*Schätzung* aus
  Zählungen ist implementiert (Tuned\*).
* Fuß- und Radverkehr sind nicht modelliert.

## Datenbasis — was echt ist und was Annahme

Für eine Simulation ist jede dieser Annahmen ordnungsgemäß — wir legen sie offen:

| Baustein | Status | Quelle / Umgang |
|---|---|---|
| Straßennetze (6+ Regionen) | **real** | OpenStreetMap via Overpass (ODbL); weitere Orte live nachladbar |
| Fahrzeug-Nachfrage | **Annahme** | synthetisch: Gravitations-OD bzw. Poisson-Raten mit Tagesgang — Plausibilitätsregeln, keine Messreihe |
| Signalpläne (Fixed-Baseline) | **Annahme** | generischer Handbuch-Plan (36/10/32/8 s bzw. 60-s-Zweiphasen-Takt), **nicht** die echten Münchner Pläne |
| Sättigungsfluss & PCE | **Regelwert** | 1 800 Fz/h/Spur (HCM-Größenordnung 1 900), unkalibrierte PCE-Tabelle; auch real ±8–10 % (Tarko et al.) |
| Sensor-Feed | **Synthetik** | Briefing-Datensatz nicht öffentlich → Stand-in gleicher Form; Adapter für echte Exporte (`arrival_csv`) |
| Vergleiche | **fair** | identischer Seed und Ankünfte — Unterschiede entstehen nur durch die Steuerung |

## 8. Literatur

> Transparenz: Diese Literaturverankerung entstand **nach** der ersten
> funktionierenden Version. Wir zitieren, worauf unser Design sich stützt, und
> markieren, wo wir vereinfachen. Unsere Zahlen sind Modellausgaben, keine
> literaturvalidierten Ergebnisse. Vollständige Tabelle:
> [docs/references.md](docs/references.md).

* **Varaiya, P. (2013).** *Max pressure control of a network of signalized
  intersections.* Transportation Research Part C, 36, 177–195. — Grundlage des
  adaptiven Controllers (wir: spurnormalisierte Schlangen statt
  Downstream-Gewichtung, plus Hysterese/Min-Grün).
* **Webster, F. V. (1958).** *Traffic Signal Settings.* Road Research
  Technical Paper No. 39, HMSO. — die klassische Fixed-Time-Logik unserer
  Baseline.
* **Little, J. D. C. et al. (1981).** *MAXBAND.* — Progression/Grüne Welle;
  unsere Offsets sind fahrzeitbasiert (× 0,95), kein Bandbreiten-LP.
* **Levin, M. W. (2019).** *Max-pressure signal control with cyclical phase
  structure.* — Anregung für die zyklusgebundene Variante.
* **Cascetta, E. (1984); Cascetta & Nguyen (1988); Dey et al. (2020).**
  OD-Schätzung aus Link-Zählungen — Basis unseres Detektor-Plans (Tuned\*).
* **Hunt et al. (1982, SCOOT); SCATS** — real eingesetzte adaptive Systeme
  (Stop-Line-Detektoren); bei uns ist der Feed bisher Datenquelle, nicht
  Rückkopplung.
* **FHWA / HCM** — Sättigungsfluss (1 900 pc/h/ln) & PCE-Konzept; wir nutzen
  1 800 Fz/h/Spur und eine unkalibrierte PCE-Tabelle. **Tarko et al.** zur
  Vorhersage-Unsicherheit.
* **NCHRP Report 572; Kimber (TRL); Song et al. (2022)** — Kreisverkehr-
  Kapazität & Gap-Acceptance (bei uns bewusst nur Näherung).


## Werkzeuge & Danke

**AI-Disclosure.** Die Entwicklung erfolgte agentisch unterstützt: Claude-Code-Harness
(Modell **GLM-5.3-flash**), daneben **Pi Harness** und **AutoClaw Harness**. Jede Zahl
dieses Writeups stammt aus Simulator-Läufen; die Zahlengate im Code verwerfen
nicht gedeckte Angaben.

**Dank** an die **OpenStreetMap-Mitwirkenden** (ODbL) für die echten Straßennetze,
an **Featherless** (LLM-API für Erklärungen & Agent) und **ElevenLabs** (Stimme)
sowie an das MunichTech-EXPO-Team.

## 9. Ausführen & Weiterlesen

```bash
python3 server.py        # oder ./run.sh  →  http://127.0.0.1:8000
python3 -m unittest discover -s tests     # 108/108 grün
```

| Wohin? | Was du dort findest |
|---|---|
| [GitHub: derKosi/SignalFlow](https://github.com/derKosi/SignalFlow) | das ganze Repository |
| [README](README.md) | Quickstart & Kernzahlen |
| [docs/architecture.md](docs/architecture.md) | Systemdesign & Datenfluss |
| [docs/model.md](docs/model.md) | Modelle, Einheiten, Annahmen |
| [docs/controllers.md](docs/controllers.md) | Controller & Kalibrierung |
| [docs/results.md](docs/results.md) | alle Zahlen & Reproduktion |
| [docs/references.md](docs/references.md) | Literaturtabelle (mit Links) |
| [docs/design-decisions.md](docs/design-decisions.md) | das ADR-Log |
| [DEMO.md](DEMO.md) · [SUBMISSION.md](SUBMISSION.md) | Demo-Drehbuch · Abgabe-Texte |

*Code-Lizenz: PolyForm Noncommercial 1.0.0 · OSM-Daten: ODbL 1.0
(© OpenStreetMap-Mitwirkende).*
