#!/usr/bin/env python3
"""Generate a synthetic, anonymised traffic-sensor sample.

The challenge brief references a "sample open traffic-sensor dataset" provided at
the briefing; as that file is not redistributable here we ship a *synthetic*
equivalent with the same shape so the model and dashboard are self-contained.

Output: data/sample_traffic.csv
Columns: timestamp, approach (N/E/S/W), movement (L/T/R), vehicles_count
The counts are Poisson-distributed around the DEFAULT_DEMAND peak rates with a
rush-hour ramp, i.e. exactly the process the simulator samples internally.
"""

from __future__ import annotations

import csv
import math
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from signalflow.simulation import APPROACHES, DEFAULT_DEMAND, TURN_MOVEMENTS  # noqa: E402

OUT = Path(__file__).resolve().parent / "sample_traffic.csv"


def main(seed: int = 1234, minutes: int = 60) -> None:
    rng = random.Random(seed)
    rows = []
    for t in range(minutes * 60):
        ramp = 0.6 + 1.0 * math.sin(math.pi * t / (minutes * 60 - 1))
        for a in APPROACHES:
            for mv in TURN_MOVEMENTS:
                rate = DEFAULT_DEMAND[a][mv] * ramp / 3600.0
                count = 0 if rate <= 0 else _poisson(rng, rate)
                rows.append((t, t // 60, f"{t % 60:02d}", a, mv, count))
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["t_seconds", "minute", "second", "approach", "movement",
                    "vehicles_count"])
        for r in rows:
            w.writerow(r)
    total = sum(r[5] for r in rows)
    print(f"wrote {OUT} — {len(rows)} rows, {total} vehicles over {minutes} min")


def _poisson(rng: random.Random, lam: float) -> int:
    limit, k, p = math.exp(-lam), 0, 1.0
    while True:
        k += 1
        p *= rng.random()
        if p <= limit:
            return k - 1


if __name__ == "__main__":
    main()
