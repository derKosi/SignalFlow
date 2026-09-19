#!/usr/bin/env python3
"""Count-based OD experiment: does a detector-only tuned plan match the oracle?

For every region (15 min peak, seed 42, defaults):

* run the naive ``fixed`` plan with stop-line detector counts recorded,
* estimate the OD matrix from those counts alone (Richardson-Lucy on the
  free-flow route set — no oracle demand knowledge),
* tune a fixed plan on the *estimate* (``fixed_tuned_est``) and compare it with
  the oracle-tuned plan (``fixed_tuned``, which sees the true routed demand),
* optionally A/B the Webster cycle adaptation of the adaptive policy.

    python3 tools/od_experiment.py                 # default sweep
    python3 tools/od_experiment.py --region riem   # one region
    python3 tools/od_experiment.py --json          # machine-readable
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from signalflow.network import list_regions, run_region  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--region", help="restrict to one region id (substring match)")
    ap.add_argument("--duration", type=int, default=15)
    ap.add_argument("--json", action="store_true", help="print JSON instead of a table")
    args = ap.parse_args()

    regions = [r["id"] for r in list_regions()
               if not args.region or args.region in r["id"]]
    rows = []
    for rid in regions:
        for webster in (False, True):
            t0 = time.time()
            out = run_region(rid, {"duration_min": args.duration, "seed": 42,
                                   "webster_cycle": webster})
            s = out["summary"]
            rows.append({
                "region": rid, "webster": webster, "wall_s": round(time.time() - t0, 1),
                "fixed": s["fixed"]["avg_delay_s"],
                "fixed_tuned": s["fixed_tuned"]["avg_delay_s"],
                "fixed_tuned_est": s.get("fixed_tuned_est", {}).get("avg_delay_s"),
                "adaptive": s["adaptive"]["avg_delay_s"],
                "coordinated": s["coordinated"]["avg_delay_s"],
                "adaptive_vs_tuned_pct": out["improvement"]["vs_tuned"]["avg_delay_pct"],
                "adaptive_vs_tuned_est_pct": out["improvement"].get("vs_tuned_est", {}).get("avg_delay_pct"),
                "od_fit_err_pct": out["meta"].get("od_estimation", {}).get("fit_rel_err_pct"),
            })

    if args.json:
        print(json.dumps(rows, indent=2))
        return 0

    hdr = (f"{'region':22s} {'webster':>7s} {'fixed':>7s} {'tuned':>7s} {'tun_est':>8s} "
           f"{'adap':>7s} {'coord':>7s} {'a-vs-tuned':>10s} {'a-vs-tun_est':>12s} {'odfit%':>7s} {'wall_s':>7s}")
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        te = f"{r['fixed_tuned_est']:.1f}" if r["fixed_tuned_est"] is not None else "-"
        print(f"{r['region']:22s} {('on' if r['webster'] else 'off'):>7s} "
              f"{r['fixed']:7.1f} {r['fixed_tuned']:7.1f} {te:>8s} {r['adaptive']:7.1f} "
              f"{r['coordinated']:7.1f} {r['adaptive_vs_tuned_pct']:>9.1f}% "
              f"{r['adaptive_vs_tuned_est_pct']:>11.1f}% {r['od_fit_err_pct']:>7.1f} "
              f"{r['wall_s']:>7.1f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
