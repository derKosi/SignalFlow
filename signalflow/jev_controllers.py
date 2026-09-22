"""Jev-powered controllers and plans for SignalFlow.

Two additions over the built-in policies, both served by Featherless'
"Simple Jev" keyless demo API (open implementation of the Jev concept:
typed decisions — choice / score / noul — with calibrated confidences).

* ``JevAdaptiveController`` (policy key ``jev_adaptive``): at every switch
  point a Jev ``choice`` question picks the next phase from the live queue
  state instead of the hand-crafted pressure heuristic.
* ``hackatron_tuned_counts(csv_path, ...)`` (policy key ``jev_tuned``):
  builds a ``TunedController`` plan from the real Hackatron detector CSV
  instead of the simulation's own arrivals; Jev ``score`` questions fold
  the qualitative columns (weather, rush-hour flag, speed-vs-limit) into a
  calibrated congestion modifier per bucket/approach.

Both degrade gracefully: offline / rate-limited / malformed answers fall
back to deterministic behaviour (pressure order / raw counts), so the demo
never breaks and tests stay reproducible via ``SIMPLE_JEV_DISABLED=1``.
"""

from __future__ import annotations

import csv
import datetime as _dt
import json
import os
from collections import defaultdict
from pathlib import Path

from .integrations import _http_json
from .simple_jev import _cfg, simple_jev_available
from .simulation import (
    TUNED_BUCKETS,
    Config,
    Controller,
    MaxPressureController,
    Movement,
    TunedController,
    _peak_hour_rates,
)

ROOT = Path(__file__).resolve().parent.parent
HACKATRON_CSV = ROOT / "data" / "sample_hackatron.csv"

# -- Hackatron CSV -> approach flow map ------------------------------------- #

_APPROACH_ALIASES = {  # CSV approach letters -> our approach keys
    "N": "N", "E": "E", "S": "S", "W": "W",
}


def _read_hackatron_rows(csv_path: str | Path = HACKATRON_CSV) -> list[dict]:
    with open(csv_path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def _hhmm_bucket(ts: str) -> int | None:
    """Map a CSV timestamp to the TunedController bucket index (or None)."""
    try:
        t = _dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _bucket_of_hour(t.hour + t.minute / 60.0)


def _bucket_of_hour(h: float) -> int:
    for i, (lo, hi) in enumerate(TUNED_BUCKETS):
        if lo <= h < hi:
            return i
    return len(TUNED_BUCKETS) - 1


# -- policy 5: Jev adaptive controller -------------------------------------- #

class JevAdaptiveController(MaxPressureController):
    """Max-pressure controller whose switch decision is confirmed by Jev.

    The pressure heuristic proposes the next phase exactly as in
    ``MaxPressureController.step``; before actually committing the switch we
    ask Jev (choice over the phases) whether to follow the proposal. This
    keeps the demo's explainability story (pressures stay in the decision
    log) while adding the calibrated-model layer on top.
    """

    name = "jev_adaptive"

    def reset(self, cfg: Config) -> None:
        super().reset(cfg)
        self.jev_calls = 0
        self.jev_fallbacks = 0
        self.plan_info = {
            "source": "Max-Pressure-Vorschlag + Jev-Bestätigung (Simple Jev, "
                      "Featherless Demo-API)",
        }

    def _jev_confirm(self, proposal: int, t, q, cfg) -> tuple[bool, dict]:
        """Ask Jev: given the queues, switch to the proposed phase? (noul)"""
        phase_names = [p[0] for p in self.phases]
        state = {
            "domain": "signal control switch decision",
            "elapsed_in_phase_s": int(self.elapsed),
            "proposed_phase": phase_names[proposal],
            "proposed_phase_pressure": round(self.last_pressure.get(phase_names[proposal], 0.0), 2),
            "current_phase": phase_names[self.cur],
            "current_phase_pressure": round(self.last_pressure.get(phase_names[self.cur], 0.0), 2),
            "queues_veh_per_lane": {
                f"{m[0]}-{m[1]}": round(q.get(m, 0.0) / max(1, cfg.lanes[m[1]]), 2)
                for m in sorted(q)
            },
        }
        questions = {
            "confirm_switch": {
                "type": "noul",
                "instructions": (
                    "Given the queue state, should the signal switch to the "
                    "proposed phase now (rather than extending the current green)?"
                ),
            }
        }
        c = _cfg()
        payload = {"model": c["model"], "state": state, "questions": questions}
        headers = {"Content-Type": "application/json"}
        if c["key"]:
            headers["Authorization"] = f"Bearer {c['key']}"
        self.jev_calls += 1
        try:
            out = _http_json(f"{c['base']}/classifier", payload, headers, timeout=12)
            ans = (out or {}).get("answers", {}).get("confirm_switch", {})
            val = float(ans.get("noul", 0.5))
            return val >= 0.5, {"jev": ans}
        except Exception:  # noqa: BLE001 — never break the sim
            self.jev_fallbacks += 1
            return True, {"jev_fallback": True}

    def step(self, t, q, cfg, buses=None, flows=None) -> dict:
        dec = super().step(t, q, cfg, buses, flows)
        if not dec.get("switch"):
            return dec
        # super() already queued the yellow transition toward `self.pending`;
        # ask Jev whether to keep it. On "no" we roll back to green hold.
        target = getattr(self, "pending", None)
        if target is None or target == self.cur:
            return dec
        if not simple_jev_available():
            self.jev_fallbacks += 1
            dec["jev"] = "disabled — heuristic switch kept"
            return dec
        ok, meta = self._jev_confirm(target, t, q, cfg)
        dec["jev"] = meta
        if not ok:
            # Jev says hold: revert the yellow we just armed
            self.mode = "green"
            self.elapsed = max(1, int(self.elapsed) or 1)
            self.pending = 0
            dec["switch"] = False
            dec["kind"] = " "  # stays green
            dec["kind"] = "green"
            dec["green"] = {m for _, pmoves in [self.phases[self.cur]]
                            for m in pmoves}
            dec["reason"] = f"Jev: hold {self.phase_names[self.cur]} " \
                            f"(noul<0.5) — pressure proposal ignored"
        return dec


# -- policy 6: Hackatron-tuned plan (Jev congestion scores) ------------------ #

# speed considered "free flow" on the expo corridor (km/h) — used to derive a
# speed-deficit ratio the Jev score question can calibrate on top of
_FREE_FLOW_KMH = 50.0


def hackatron_tuned_counts(csv_path: str | Path = HACKATRON_CSV,
                           intersection: str = "INT-EXPO-N",
                           use_jev: bool = True) -> tuple[list[dict], dict]:
    """Aggregate the Hackatron detector CSV into TunedController bucket counts.

    Returns ``(bucket_counts, info)`` where ``bucket_counts`` mirrors what
    ``run_scenario`` builds from its own arrivals (one movement->rate map per
    TUNED_BUCKETS bucket) and ``info`` documents provenance + Jev usage.

    Jev's role: one ``score`` question per bucket folds weather, rush-hour
    share and speed deficit into a calibrated headroom factor that scales the
    measured counts (rain + slow speeds -> plan for more demand headroom).
    With Jev unavailable the raw counts pass through unchanged.
    """
    rows = _read_hackatron_rows(csv_path)
    # 15-min slots per (bucket, approach) -> vehicle counts
    per_ba: dict[tuple[int, str], list[float]] = defaultdict(list)
    weather_seen: dict[int, set] = defaultdict(set)
    rush_slots: dict[int, int] = defaultdict(int)
    total_slots: dict[int, int] = defaultdict(int)

    for r in rows:
        if r.get("intersection_id") != intersection:
            continue
        approach = _APPROACH_ALIASES.get(r.get("approach", "").strip().upper())
        if not approach:
            continue
        b = _hhmm_bucket(r.get("timestamp_utc", ""))
        if b is None:
            continue
        try:
            cnt = float(r["vehicle_count_15min"])
        except (KeyError, ValueError):
            continue
        per_ba[(b, approach)].append(cnt)
        weather_seen[b].add(r.get("weather", "unknown"))
        total_slots[b] += 1
        if str(r.get("is_rush_hour", "0")).strip() in ("1", "true", "True"):
            rush_slots[b] += 1

    nb = len(TUNED_BUCKETS)
    info = {
        "source": f"Hackatron detector CSV ({Path(csv_path).name}, {intersection})",
        "slots": {i: total_slots[i] for i in range(nb)},
        "jev": "disabled" if not (use_jev and simple_jev_available()) else "score",
        "per_bucket": [],
    }

    # per-approach hourly rate per bucket (mean over slots, 4 slots/h)
    rate: dict[tuple[int, str], float] = {}
    for (b, approach), vals in per_ba.items():
        rate[(b, approach)] = (sum(vals) / len(vals)) * 4.0  # 15min -> veh/h

    # speed deficit per bucket (0 = free flow, ~1 = standstill)
    speed_deficit: dict[int, float] = {}
    for b in range(nb):
        speeds = [float(r.get("avg_speed_kmh") or 0.0)
                  for r in rows
                  if r.get("intersection_id") == intersection
                  and _hhmm_bucket(r.get("timestamp_utc", "")) == b
                  and r.get("avg_speed_kmh")]
        speed_deficit[b] = 1.0 - (sum(speeds) / len(speeds) / _FREE_FLOW_KMH) if speeds else 0.0

    jev_factors = {b: 1.0 for b in range(nb)}
    if use_jev and simple_jev_available():
        import time
        for b in range(nb):
            weather = sorted(weather_seen[b]) or ["unknown"]
            state = {
                "domain": "detector data aggregation for signal plan tuning",
                "bucket_hours": list(TUNED_BUCKETS[b]),
                "approach_rates_vph": {
                    a: round(rate.get((b, a), 0.0), 1) for a in "NESW"
                },
                "rush_hour_share": round(rush_slots[b] / total_slots[b], 2)
                if total_slots[b] else 0.0,
                "avg_speed_deficit": round(speed_deficit[b], 2),
                "weather_observed": weather,
            }
            questions = {
                "demand_headroom": {
                    "type": "score",
                    "instructions": (
                        "How much demand headroom should the green-time plan "
                        "reserve for this bucket (0 = none, 4 = a lot)?"
                    ),
                    "criteria": ["none", "little", "moderate", "considerable", "a lot"],
                }
            }
            c = _cfg()
            payload = {"model": c["model"], "state": state, "questions": questions}
            headers = {"Content-Type": "application/json"}
            if c["key"]:
                headers["Authorization"] = f"Bearer {c['key']}"
            try:
                out = _http_json(f"{c['base']}/classifier", payload, headers, timeout=12)
                ans = (out or {}).get("answers", {}).get("demand_headroom", {})
                lvl = ans.get("score")
                if lvl is None:
                    raise ValueError("no score in answer")
                jev_factors[b] = 1.0 + 0.05 * float(lvl)  # up to +20% headroom
                info["jev"] = "score"
            except Exception:  # noqa: BLE001
                jev_factors[b] = 1.0
                info["jev"] = "fallback (raw counts)"
            time.sleep(0.35)  # stay under the demo endpoint's 4 RPS

    # rates -> movement split (same L/T/R shares the feed adapter defaults to)
    SPLIT = (0.15, 0.70, 0.15)
    counts: list[dict] = []
    for b in range(nb):
        mv: dict[str, float] = {}
        for a in "NESW":
            vph = rate.get((b, a), 0.0) * jev_factors[b]
            for turn, share in zip("LTR", SPLIT):
                mv[f"{a}-{turn}"] = round(vph * share, 2)
        counts.append(mv)
        info["per_bucket"].append({
            "hours": list(TUNED_BUCKETS[b]),
            "jev_headroom_factor": round(jev_factors[b], 3),
            "approach_vph_raw": {a: round(rate.get((b, a), 0.0), 1) for a in "NESW"},
        })
    return counts, info


class JevTunedController(TunedController):
    """TunedController, dessen plan_info die Hackatron/Jev-Provenance behält
    (TunedController.reset() überschreibt plan_info sonst mit dem Default)."""

    name = "jev_tuned"

    def __init__(self, bucket_counts, provenance: dict):
        super().__init__(bucket_counts)
        self._provenance = provenance

    def reset(self, cfg: Config) -> None:
        super().reset(cfg)
        self.plan_info = {**self.plan_info, **self._provenance}


def build_jev_controllers(cfg: Config) -> dict[str, Controller]:
    """Build the two Jev policies for a signalised run (5 and 6)."""
    counts, info = hackatron_tuned_counts()
    tuned = JevTunedController(counts, provenance={
        "source": info["source"] + " — Jev-calibrierte Kopfreserve je Bucket",
        "jev": info["jev"],
        "per_bucket": info["per_bucket"],
    })
    return {
        "jev_adaptive": JevAdaptiveController(),
        "jev_tuned": tuned,
    }
