# SignalFlow — Writeup (Deutsch, einfache Sprache)

**Eine Ampel, die schaut, wo Autos warten.**

> Es gibt dieses Writeup in vier Fassungen:
> **Deutsch einfach** (diese Datei) ·
> [Deutsch ausführlich](WRITEUP.md) ·
> [English simple](WRITEUP.en-simple.md) ·
> [English detailed](WRITEUP.en.md)

---

## Was ist das Problem?

Viele Ampeln haben einen festen Plan. Der Plan sagt: Erst 30 Sekunden grün
für die Straße von Norden. Dann 30 Sekunden für die Straße von Osten. Immer
gleich, den ganzen Tag.

Das Problem: Manchmal wartet keine Autos vor Rot. Dann leuchtet das Grün
einfach so ins Leere. Und die Autos auf der anderen Straße müssen trotzdem
warten. Das nervt und kostet Zeit und Benzin.

## Was macht SignalFlow?

SignalFlow ist eine Ampel-Steuerung, die **schaut**. Sie zählt jede Sekunde,
vor welcher Richtung wie viele Autos warten. Dann gibt sie der Richtung
grün, vor der der größte Stau steht. Ist eine Schlange leer, wird die
Ampel schneller wieder umschalten. Das nennt man **adaptiv**.

## Wie wissen wir, dass es besser ist?

Wir lassen zwei Ampeln gegeneinander antreten: eine mit festem Plan, eine
mit SignalFlow. **Beide bekommen genau dieselben Autos.** Dann vergleichen
wir.

Das Ergebnis an einer Münchner Kreuzung (30 Minuten Hauptverkehrszeit):

* Die Autos warten **etwa ein Viertel kürzer** (53,9 statt 40,7 Sekunden
  pro Auto — 24,5 % weniger).
* **68 % weniger grüne Zeit ins Leere.**
* Weniger Abgas, weil weniger Autos im Leerlauf stehen (etwa 24 % weniger).

Das Gleiche testen wir für ganze Stadtteile — mit echten Straßen von
OpenStreetMap: München, Berlin, Hamburg, Köln und Heidelberg. Dort warten
die Autos **60 bis 80 % kürzer**.

## Vier Ampel-Typen im Vergleich

1. **Feste Ampel:** Sie hat einen Plan und schaut nicht. Einfach, aber sie
   verschenkt Zeit.
2. **Adaptive Ampel (SignalFlow):** Sie schaut live und gibt dem Stau den
   Vortritt. Gewinnt fast immer.
3. **Grüne Welle:** Alle Ampeln einer großen Straße schalten im Gleichtakt.
   Auf einer langen, freien Straße toll. Im dichten Innenstadt-Gewirr
   schlechter.
4. **Gelernte feste Ampel (Tuned\*):** Sie hat einen festen Plan – aber der
   Plan wurde aus echten Zählungen von Zählschleifen errechnet. In manchen
   Innenstadt-Netzen schlägt sie sogar die adaptive Ampel!

**Wir sind ehrlich:** Nicht immer gewinnt die adaptive Ampel. Das zeigen
wir trotzdem. Nur so kann man dem Ergebnis vertrauen.

## Wer hat das gebaut?

Ein kleines Team beim **MunichTech EXPO 2026** Hackathon. Mit Unterstützung
von KI (Claude Code) — aber jede Zahl kommt aus echten Simulations-Läufen,
und eine automatische Prüfung verwirft Antworten mit erfundenen Zahlen.

## Weiterlesen

* [Das ganze Projekt auf GitHub](https://github.com/derKosi/SignalFlow)
* [Die lange Version zum Lesen](WRITEUP.md) — für alle Details
* [Live ausprobieren](https://github.com/derKosi/SignalFlow#readme) — so
  startest du die Demo auf deinem eigenen Computer

*Code-Lizenz: PolyForm Noncommercial · Kartendaten: © OpenStreetMap*
