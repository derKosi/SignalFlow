"""Render the demo voice-over segments with ElevenLabs (female, German).

Uses the VOICEOVER_ELEVENLABS_API_KEY from .env (kept separate from the app
key on purpose — the video must not eat the app's quota). Writes one mp3 per
scene plus durations.json, which tools/record_demo.py reads for pacing.

Usage:  python tools/voiceover.py [--out shots/demo]
"""

import argparse
import json
import pathlib
import time
import urllib.request

VOICE_ID = "Xb7hH8MSUJpSbSDYk0k2"      # "Alice" — premade, multilingual (DE ok)
MODEL_ID = "eleven_flash_v2_5"

SEGMENTS = [
    ("seg01", "Münchens Ampeln schalten blind: ein fester Plan, der den Stau "
              "vor sich nicht sieht. SignalFlow zeigt stattdessen live — auf "
              "echten OpenStreetMap-Netzen — was adaptive Steuerung bringt."),
    ("seg02", "Wir starten an einer einzelnen Kreuzung. Dieselbe Nachfrage "
              "läuft durch einen festen Plan — und durch den adaptiven "
              "Controller. Äpfel mit Äpfeln also."),
    ("seg03", "Nur Fixed gegen Adaptiv. Kumuliert sieht man den CO₂-Vorteil "
              "über die Zeit — genau die Ersparnis, die freie Fahrt ausmacht."),
    ("seg04", "Und weil jede Zahl aus einem echten Simulationslauf stammt, "
              "liest der Agent seine Antwort einfach vor."),
    ("seg05", "Skalierung: München Innenstadt im Berufsverkehr bei hohem "
              "Verkehrsaufkommen — vier Strategien im direkten Vergleich."),
    ("seg06", "Echte Straßen, echte Topologie, echte Einbahnstraßen. Jeder "
              "rote Link ist Stau — ein Klick auf einen Knoten öffnet die "
              "Kreuzung dahinter."),
    ("seg07", "Simulieren heißt: eingreifen, bevor man umbaut. Szenarien "
              "durchspielen — Bus-Priorität, grüne Welle, Laststeuerung — und "
              "die Wirkung sofort sehen."),
    ("seg08", "Gebaut mit echten Karten von OpenStreetMap. Danke an die "
              "Mitwirkenden, an das MunichTech-EXPO-Team und an unsere "
              "Sponsoren. Der Code ist komplett auf GitHub."),
]


def tts(text: str, key: str) -> bytes:
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}",
        data=json.dumps({"text": text, "model_id": MODEL_ID}).encode(),
        headers={"xi-api-key": key, "Content-Type": "application/json",
                 "Accept": "audio/mpeg"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def duration_of(path: pathlib.Path) -> float:
    import subprocess
    out = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="shots/demo")
    args = ap.parse_args()
    out_dir = pathlib.Path(args.out) / "vo"
    out_dir.mkdir(parents=True, exist_ok=True)

    key = ""
    env = pathlib.Path(__file__).resolve().parent.parent / ".env"
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("VOICEOVER_ELEVENLABS_API_KEY="):
            key = line.split("=", 1)[1].strip()

    durations = {}
    for name, text in SEGMENTS:
        target = out_dir / f"{name}.mp3"
        if target.exists():                       # reruns stay quota-friendly
            print("skip (exists):", target.name)
        else:
            for attempt in (1, 2, 3):
                try:
                    target.write_bytes(tts(text, key))
                    break
                except Exception as e:
                    print(f"retry {attempt} {name}: {str(e)[:60]}")
                    time.sleep(2 * attempt)
        durations[name] = round(duration_of(target), 2)
        print(f"{name}: {durations[name]} s")

    (out_dir / "durations.json").write_text(
        json.dumps(durations, indent=1), encoding="utf-8")
    total = sum(durations.values())
    print(f"total voice-over: {total:.1f} s")


if __name__ == "__main__":
    main()
