#!/usr/bin/env python3
"""Warm the disk cache with the dashboards' default requests.

After this, the first dashboard load is instant (no waiting in front of the jury).
Keys are computed with the *same* function the server uses (imported from
``server.py``), so the warmed entries match real requests exactly.

    python3 tools/precompute.py            # junction default + every region @ 15 min
    python3 tools/precompute.py --force    # recompute even if cached
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import server as S  # noqa: E402  (gives us the identical cache key/hash)
from signalflow.network import list_regions  # noqa: E402

# the junction dashboard sends only these (all equal to model defaults)
JUNCTION_BODY: dict = {}


def network_body(region: str, vph: int = 6500) -> dict:
    # mirrors web/network.html defaults
    return {"duration_min": 15, "demand_multiplier": 1.0, "demand_scenario": "normal",
            "vehicle_mix": {"car": 1.0}, "transit_priority": False, "seed": 42,
            "total_vph": vph, "region": region}


def main() -> int:
    force = "--force" in sys.argv
    jobs = [("junction", None, dict(JUNCTION_BODY))]
    for r in list_regions():
        jobs.append(("network", r["id"], network_body(r["id"])))

    total = 0.0
    for kind, region, body in jobs:
        b = dict(body)
        if kind == "network":
            reg = b.pop("region")
            key = S._cache_key("/api/simulate_network|" + reg, b)
        else:
            reg = None
            key = S._cache_key("/api/simulate", b)
        if not force and S.disk_get(key) is not None:
            print(f"  cached   {kind:9s} {reg or ''}")
            continue
        t0 = time.time()
        res = S.run_scenario(b) if kind == "junction" else S.run_region(reg, b)
        S.disk_put(key, res)
        dt = time.time() - t0
        total += dt
        print(f"  computed {kind:9s} {reg or '':22s} {dt:5.1f}s")
    print(f"precompute done in {total:.1f}s -> {S.CACHE_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
