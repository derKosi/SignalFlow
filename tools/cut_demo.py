"""Assemble the demo: trim the take per scene, lay the voice-over on top,
concatenate to promo/signalflow-demo.mp4.

Reads shots/demo/take.webm, shots/demo/timestamps.json and
shots/demo/vo/durations.json (from tools/voiceover.py).

Usage:  python tools/cut_demo.py
"""

import json
import pathlib
import shutil
import subprocess

OUT = pathlib.Path("shots/demo")
FINAL = pathlib.Path("promo") / "signalflow-demo.mp4"
SCENES = ["lead-in", "intro", "junction", "toggles", "agent",
          "network", "map", "linger", "thanks"]


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"ffmpeg failed: {' '.join(map(str, cmd[:6]))}…\n{r.stderr[-800:]}")


def main() -> None:
    marks = {m["scene"]: m["start"] for m in
             json.loads((OUT / "timestamps.json").read_text(encoding="utf-8"))}
    vo_dur = json.loads((OUT / "vo" / "durations.json").read_text(encoding="utf-8"))
    end_all = marks["_end"]

    work = OUT / "scenes"
    work.mkdir(parents=True, exist_ok=True)
    list_file = OUT / "concat.txt"
    lines = []
    for i, scene in enumerate(SCENES[:-1] if SCENES[-1] == "_end" else SCENES):
        start = marks[scene]
        end = marks.get(SCENES[SCENES.index(scene) + 1], end_all) \
            if scene != "thanks" else end_all
        length = max(1.0, end - start)

        seg = work / f"{i:02d}-{scene}.mp4"
        vo = OUT / "vo" / f"seg{i:02d}.mp3"          # lead-in has no vo file
        vo_arg = vo if scene != "lead-in" and vo.exists() else None
        if vo_arg:
            length = max(length, vo_dur[f"seg{i:02d}"] + 1.0)

        # video: clone the last frame when the scene is shorter than its voice
        vf = (f"tpad=stop_mode=clone:stop_duration={length + 1:.2f},"
              f"fps=30,format=yuv420p")
        cmd = ["ffmpeg", "-y",
               "-ss", f"{start:.2f}", "-to", f"{end_all if scene == 'thanks' else end:.2f}",
               "-i", str(OUT / "take.webm")]
        if vo_arg:
            cmd += ["-i", str(vo_arg)]
            af = f"adelay=400|400,apad,atrim=0:{length + 0.5:.2f}"
        else:
            # Szenen ohne Voice-over bekommen eine echte stille Tonspur,
            # damit der Concat-Step überall konsistente Audio-Streams sieht.
            cmd += ["-f", "lavfi", "-t", f"{length + 0.5:.2f}",
                    "-i", "anullsrc=r=44100:cl=stereo"]
            af = None
        cmd += ["-map", "0:v:0", "-map", "1:a:0", "-vf", vf]
        if af:
            cmd += ["-af", af]
        cmd += ["-t", f"{length + 0.5:.2f}",
                "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
                "-s", "1920x1080", str(seg)]
        run(cmd)
        lines.append(f"file 'scenes/{seg.name}'\n")   # relativ zur concat.txt

    list_file.write_text("".join(lines), encoding="utf-8")
    FINAL.parent.mkdir(exist_ok=True)
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
         "-c", "copy", str(FINAL)])
    print("final:", FINAL, f"({FINAL.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
