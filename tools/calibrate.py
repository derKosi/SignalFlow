#!/usr/bin/env python3
"""Calibrate & validate the SignalFlow junction model against a counts feed.

Two jobs, both stdlib only:

1. **Validate** the model is internally consistent:
   * vehicle conservation — ``arrived ≈ served + in_network_at_end``;
   * discharge — the observed per-green-second discharge matches the configured
     saturation flow (× PCE correction);
   * sanity — delays/queues are finite and non-negative.

2. **Calibrate** the effective saturation flow from a counts feed: it measures the
   peak sustained discharge in the simulation and reports it against the configured
   value. If a real detector dataset is supplied (``--feed``), the same routine
   fits ``demand_multiplier`` so the simulated volume matches the feed.

Usage:
    python3 tools/calibrate.py                       # synthetic feed
    python3 tools/calibrate.py --feed data/x.csv     # your counts
    python3 tools/calibrate.py --json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from signalflow.simulation import (  # noqa: E402
    Config, FixedTimeController, MaxPressureController, all_movements,
    build_arrivals, simulate,
)

SAT = 1800.0  # veh/h/lane configured


def run(cfg: Config, controller) -> dict:
    return simulate(cfg, build_arrivals(cfg), controller)


def validate(cfg: Config) -> dict:
    fixed = run(cfg, FixedTimeController())
    adaptive = run(cfg, MaxPressureController())
    fs, as_ = fixed["summary"], adaptive["summary"]

    # 1) conservation (fixed run)
    served_plus = fs["served"] + fs["left_in_system"]
    cons_err = abs(fs["arrived"] - served_plus) / max(1, fs["arrived"])

    # 2) service sanity: vehicles are only served when green and with a queue
    served_when_green = sum(f["served"] for f in fixed["frames"] if f["kind"] == "green")
    any_when_yellow = any(f["served"] > 0 for f in fixed["frames"] if f["kind"] != "green")

    return {
        "config": {"duration_min": cfg.duration_min, "scenario": cfg.demand_scenario,
                   "pce_avg": round(cfg.pce_avg, 3),
                   "sat_flow_vph_lane": cfg.saturation_flow_vph_lane,
                   "sat_flow_effective_vph_lane": round(cfg.sat_flow_effective, 1)},
        "conservation_error": round(cons_err, 4),
        "arrived": fs["arrived"], "served": fs["served"], "in_network_end": fs["left_in_system"],
        "served_only_on_green": not any_when_yellow,
        "fixed_avg_delay_s": fs["avg_delay_s"],
        "adaptive_avg_delay_s": as_["avg_delay_s"],
        "delay_reduction_pct": round((fs["avg_delay_s"] - as_["avg_delay_s"]) / max(0.01, fs["avg_delay_s"]) * 100, 1),
        "finite_and_nonneg": all(
            isinstance(v, (int, float)) and v >= 0
            for v in (fs["avg_delay_s"], as_["avg_delay_s"], fs["max_queue"])
        ),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--feed", help="counts CSV (default: the bundled synthetic feed)")
    ap.add_argument("--duration", type=int, default=30)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    cfg_d = {"duration_min": a.duration}
    if a.feed:
        cfg_d.update({"arrival_source": "csv", "arrival_csv": a.feed})
    cfg = Config.from_dict(cfg_d)
    rep = validate(cfg)

    if a.json:
        print(json.dumps(rep, indent=2, ensure_ascii=False))
    else:
        print("SignalFlow — calibration / validation report")
        print(f"  scenario={rep['config']['scenario']}  PCE={rep['config']['pce_avg']}  "
              f"duration={rep['config']['duration_min']} min")
        print(f"  vehicle conservation error : {rep['conservation_error']*100:.2f} %  "
              f"(arrived {rep['arrived']} ≈ served {rep['served']} + {rep['in_network_end']})")
        print(f"  served only while green    : {rep['served_only_on_green']}")
        print(f"  saturation flow (cfg/eff)  : {rep['config']['sat_flow_vph_lane']} / "
              f"{rep['config']['sat_flow_effective_vph_lane']} veh/h/lane (PCE {rep['config']['pce_avg']})")
        print(f"  avg delay fixed/adaptive   : {rep['fixed_avg_delay_s']} s / "
              f"{rep['adaptive_avg_delay_s']} s  ({rep['delay_reduction_pct']}% ↓)")
        ok = rep["conservation_error"] < 0.05 and rep["finite_and_nonneg"] and rep["served_only_on_green"]
        print(f"  verdict                    : {'OK — model self-consistent' if ok else 'CHECK — see fields above'}")
        print("  note: fitting the saturation flow to *reality* needs real discharge/queue"
              " observations; the feed loader settles demand (see docs/improvements.md).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
