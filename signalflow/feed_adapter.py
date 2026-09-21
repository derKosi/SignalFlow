"""Feed adapter: turn third-party sensor-count CSVs into SignalFlow's feed format.

Real detector exports rarely match our loader's columns. This module auto-detects
common shapes and normalises them to our canonical feed:

    t_seconds,approach,movement,vehicles_count

Recognised inputs
-----------------
* **Canonical** (already ours): ``t_seconds`` (or ``minute``+``second``),
  ``approach``, ``movement``, ``vehicles_count``.
* **Generic sensor export** (e.g. the Kaggle "Smart City Traffic Flow Prediction"
  shape): ``timestamp, device_id|location|zone, traffic_count [, avg_speed, status]``.
  Missing information is reconstructed deterministically:
  - ``approach``: explicit if present, otherwise a stable mapping of the location /
    device keys (sorted, assigned N, E, S, W, N, ...) or a ``--mapping`` JSON file;
  - ``movement``: explicit if present, otherwise split by ``--split L,T,R``
    (default 0.15, 0.70, 0.15) using largest-remainder so totals are preserved;
  - time: parsed from ISO/``HH:MM`` timestamps into seconds from the first sample.

CLI
---
    python3 -m signalflow.feed_adapter IN.csv [--out OUT.csv] [--mapping m.json]
                                             [--split 0.15,0.70,0.15] [--per-second] [--json]
    python3 -m signalflow.feed_adapter --make-example data/example_sensor_generic.csv

The output can be fed straight into the app:
``{"arrival_source":"csv","arrival_csv":"<OUT.csv>"}``.
"""

from __future__ import annotations

import csv
import io
import json
import random
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

APPROACHES = ("N", "E", "S", "W")
MOVES = ("L", "T", "R")
USER_AGENT = "SignalFlow/0.1 (feed adapter)"

TIME_COLS = ("t_seconds", "timestamp", "time", "datetime", "date_time")
APPROACH_COLS = ("approach", "zone", "location", "direction", "corridor", "device_id")
MOVE_COLS = ("movement", "turn", "lane_use")
COUNT_COLS = ("vehicles_count", "traffic_count", "count", "vehicles", "volume", "flow")
# Substring fallback must never match these (e.g. "lane_count" contains "count",
# "vehicle_count_15min" would be found by the exact candidates anyway).
COUNT_SUBSTR_EXCLUDES = ("lane", "signal", "queue", "speed", "phase")


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #

def _pick(fields: list[str], candidates: tuple[str, ...],
          excludes: tuple[str, ...] = ()) -> str | None:
    low = {f.lower().strip(): f for f in fields}
    for c in candidates:
        if c in low:
            return low[c]
    for f in fields:                     # substring fallback
        for c in candidates:
            if c in f.lower() and not any(x in f.lower() for x in excludes):
                return f
    return None


def _parse_time(value: str) -> datetime:
    s = (value or "").strip().replace("Z", "")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S",
                "%Y-%m-%dT%H:%M", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M",
                "%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    raise ValueError(f"unrecognised timestamp: {value!r}")


def _largest_remainder(total: int, weights: list[float]) -> list[int]:
    """Split ``total`` into len(weights) integers proportional to weights."""
    if total <= 0:
        return [0] * len(weights)
    s = sum(weights) or 1.0
    raw = [total * w / s for w in weights]
    out = [int(x) for x in raw]
    rest = total - sum(out)
    order = sorted(range(len(weights)), key=lambda i: (raw[i] - out[i]), reverse=True)
    for i in order[:rest]:
        out[i] += 1
    return out


def _open(path_or_url: str):
    if path_or_url.startswith(("http://", "https://")):
        req = urllib.request.Request(path_or_url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=45) as resp:
            return io.StringIO(resp.read().decode("utf-8", "replace"))
    p = Path(path_or_url)
    if not p.is_file():
        raise ValueError(f"input not found: {p}")
    return p.open(newline="", encoding="utf-8")


# --------------------------------------------------------------------------- #
# adapter
# --------------------------------------------------------------------------- #

def adapt(source: str, out_path: str | None = None,
          mapping: dict | None = None, split: tuple[float, float, float] = (0.15, 0.70, 0.15),
          per_second: bool = False) -> dict:
    """Normalise ``source`` (path or URL) and optionally write the canonical CSV."""
    fh = _open(source)
    rows = list(csv.DictReader(fh))
    fh.close()
    if not rows:
        raise ValueError("input has no data rows")

    fields = list(rows[0].keys())
    t_col = _pick(fields, TIME_COLS)
    a_col = _pick(fields, APPROACH_COLS)
    m_col = _pick(fields, MOVE_COLS)
    c_col = _pick(fields, COUNT_COLS, COUNT_SUBSTR_EXCLUDES)
    if c_col is None:
        raise ValueError(f"no count column found in {fields}")

    canonical = t_col == "t_seconds" and a_col == "approach" and m_col == "movement"

    # time base
    times: list[float] = []
    if t_col and t_col != "t_seconds":
        parsed = [_parse_time(r.get(t_col, "")) for r in rows]
        base = min(parsed)
        times = [(p - base).total_seconds() for p in parsed]
    elif t_col == "t_seconds":
        times = [float(r.get("t_seconds") or i) for i, r in enumerate(rows)]
    else:
        times = [float(i) for i in range(len(rows))]

    gaps = [b - a for a, b in zip(sorted(set(times)), sorted(set(times))[1:]) if b > a]
    resolution = int(min(gaps)) if gaps else 1
    resolution = max(1, resolution)

    # stable location -> approach mapping
    if a_col and a_col != "approach":
        keys = sorted({(r.get(a_col) or "").strip() for r in rows})
        auto = {k: APPROACHES[i % len(APPROACHES)] for i, k in enumerate(keys)}
        auto.update({k: v for k, v in (mapping or {}).items()})
    else:
        auto = dict(mapping or {})

    out_rows: list[tuple[int, str, str, int]] = []
    dropped = 0
    for r, t in zip(rows, times):
        try:
            count = float(str(r.get(c_col, "0")).replace(",", ".") or 0)
        except ValueError:
            dropped += 1
            continue
        if count < 0:
            count = 0
        approach = (r.get(a_col) if a_col else None) or auto.get("", "")
        approach = (approach or "").strip().upper()[:1]
        if approach not in APPROACHES:
            approach = auto.get((r.get(a_col) or "").strip()) if a_col else None
        if approach not in APPROACHES:
            approach = APPROACHES[0]
        turn = (r.get(m_col) or "").strip().upper()[:1] if m_col else ""
        slots = max(1, resolution) if per_second else 1
        per_slot = _largest_remainder(int(round(count)), [1.0] * slots)
        for k, piece in enumerate(per_slot):
            if piece <= 0:
                continue
            t_i = int(t) + k
            if turn in MOVES:
                out_rows.append((t_i, approach, turn, piece))
            else:
                for mv, piece2 in zip(MOVES, _largest_remainder(piece, list(split))):
                    if piece2:
                        out_rows.append((t_i, approach, mv, piece2))

    out_rows.sort(key=lambda x: (x[0], x[1], x[2]))
    stats = {
        "input": source,
        "format": "canonical" if canonical else "generic",
        "columns": {"time": t_col, "approach": a_col, "movement": m_col, "count": c_col},
        "rows_in": len(rows),
        "rows_dropped": dropped,
        "rows_out": len(out_rows),
        "resolution_s": resolution,
        "per_second": bool(per_second),
        "approaches": sorted({r[1] for r in out_rows}),
        "total_vehicles": sum(r[3] for r in out_rows),
        "duration_s": (max((r[0] for r in out_rows), default=0) + 1),
        "mapping": auto,
    }

    if out_path:
        p = Path(out_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("w", newline="", encoding="utf-8") as fh2:
            w = csv.writer(fh2)
            w.writerow(["t_seconds", "approach", "movement", "vehicles_count"])
            w.writerows(out_rows)
        stats["out"] = str(p)
    return stats


def make_example(path: str, minutes: int = 30, seed: int = 7, zones: int = 4) -> dict:
    """Write a *generic-format* example CSV (mimics a detector export)."""
    rng = random.Random(seed)
    names = ["Zone_A", "Zone_B", "Zone_C", "Zone_D", "Zone_E", "Zone_F"][:zones]
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["timestamp", "device_id", "location", "traffic_count", "avg_speed", "status"])
        for m in range(minutes):
            ramp = 0.5 + 0.9 * (m / max(1, minutes - 1))
            for i, z in enumerate(names):
                count = max(0, int(round(rng.gauss(12.0 * ramp, 2.5))))
                w.writerow([f"2026-01-01 08:{m:02d}", f"TS_{i + 1:03d}", z, count,
                            int(round(rng.gauss(30, 4))), "OK"])
    return {"example": str(p), "rows": minutes * zones, "zones": names}


def main(argv: list[str] | None = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    if "--make-example" in args:
        i = args.index("--make-example")
        target = args[i + 1] if len(args) > i + 1 else "data/example_sensor_generic.csv"
        print(json.dumps(make_example(target), indent=2))
        return 0
    if not args:
        print(__doc__)
        return 2
    src = args[0]
    out = None
    mapping = None
    split = (0.15, 0.70, 0.15)
    per_second = "--per-second" in args
    if "--out" in args:
        out = args[args.index("--out") + 1]
    if "--mapping" in args:
        mapping = json.loads(Path(args[args.index("--mapping") + 1]).read_text(encoding="utf-8"))
    if "--split" in args:
        split = tuple(float(x) for x in args[args.index("--split") + 1].split(","))
    stats = adapt(src, out, mapping, split, per_second)
    print(json.dumps(stats, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
