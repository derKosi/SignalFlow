"""Jev district controller for the network (OSM region) simulation.

Design: **quantised-state decision cache** instead of a live API call per
step. Switch candidates are described by a compact quantised state
(current axis, green-elapsed bucket, queue-pressure buckets per axis);
Jev is asked once per *distinct* quantised state (noul question, bundled —
dozens of states per call, validated during the spike), answers are cached.
Real runs produce only a few dozen distinct states, so a whole district
run costs a handful of API calls and stays deterministic on re-runs.

Falls back to pure max-pressure when Jev is disabled/unreachable: identical
decisions, no API calls.
"""

from __future__ import annotations

import os
import time

from .integrations import _http_json
from .network import AdaptiveJunction
from .simple_jev import _cfg, simple_jev_available


def _jev_enabled() -> bool:
    return (os.environ.get("SIGNALFLOW_JEV_POLICIES", "").lower()
            in ("1", "true", "yes")) and simple_jev_available()


def _bucket(v: float, step: float) -> int:
    return int(min(9, v // step))


class JevDistrictJunction(AdaptiveJunction):
    """Max-pressure network controller with a Jev layer on switch decisions.

    The base class runs untouched; when it arms a yellow (switch proposal)
    the candidate is mapped to a quantised state key. Jev confirms
    (``noul >= threshold``) or withdraws the switch. Distinct keys are
    resolved against a cache; misses are fetched in *one* bundled API call
    per step (usually only the first few steps miss at all).
    """

    name = "jev_adaptive"

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.threshold = float(os.environ.get("SIGNALFLOW_JEV_THRESHOLD", "0.5"))
        self.cache: dict[tuple, bool] = {}
        self.jev_calls = 0
        self.jev_confirms = 0
        self.jev_holds = 0
        self.jev_fallbacks = 0

    # -- quantised state ---------------------------------------------------- #
    def _state_key(self, c, k, queue, t) -> tuple:
        axes = c.phase_ax[k]
        cur = self.cur[k]
        def p(links):
            return round(sum(queue[l] / max(1, c.lanes[l]) for l in links), 1) if links else 0.0
        cur_p, other_p = p(axes[cur]), p(axes[1 - cur])
        # der Vorschlag kommt von der Gegenseite (Switch zur Other-Axis)
        return (cur, _bucket(self.elapsed[k], 10.0),
                _bucket(cur_p, 1.0), _bucket(other_p, 1.0))

    def _state_desc(self, key: tuple) -> dict:
        cur, eb, cp, op = key
        return {"current_axis": cur,
                "green_elapsed_bucket": eb,          # 10s-Raster
                "current_pressure_bucket": cp,       # 1 veh/lane-Raster
                "other_pressure_bucket": op}

    # -- Jev bundle fetch ---------------------------------------------------- #
    def _fetch(self, keys: list[tuple]) -> dict[tuple, bool]:
        state = {"domain": "district signal control (OSM region), switch decision",
                 "semantics": {
                     "current_axis": "0/1 axis index the junction currently greens",
                     "green_elapsed_bucket": "seconds in green, 10s buckets",
                     "current_pressure_bucket": "queue vehicles/lane on green axis, 1.0 buckets",
                     "other_pressure_bucket": "queue vehicles/lane on the other axis"},
                 "candidates": {f"c{i}": self._state_desc(kk) for i, kk in enumerate(keys)}}
        questions = {f"c{i}": {
            "type": "noul",
            "instructions": (
                "Should this junction end its current green and switch to the "
                "other axis now (rather than extending the green)?")}
            for i in range(len(keys))}
        cfg = _cfg()
        payload = {"model": cfg["model"], "state": state, "questions": questions}
        headers = {"Content-Type": "application/json"}
        if cfg["key"]:
            headers["Authorization"] = f"Bearer {cfg['key']}"
        self.jev_calls += 1
        try:
            out = _http_json(f"{cfg['base']}/classifier", payload, headers,
                             timeout=15)
            answers = (out or {}).get("answers", {})
        except Exception:  # noqa: BLE001 — never break the sim
            self.jev_fallbacks += 1
            return {kk: True for kk in keys}
        res: dict[tuple, bool] = {}
        for i, kk in enumerate(keys):
            try:
                res[kk] = float(answers.get(f"c{i}", {}).get("noul", 1.0)) >= self.threshold
            except (TypeError, ValueError):
                res[kk] = True
        time.sleep(0.3)  # demo endpoint: stay under 4 RPS
        return res

    # -- step ---------------------------------------------------------------- #
    def step(self, c, t, queue, green_out, buses=None, flows=None):
        before = list(self.mode)
        super().step(c, t, queue, green_out, buses=buses, flows=flows)
        if not _jev_enabled():
            return
        cands = [k for k in range(len(self.mode))
                 if before[k] == "green" and self.mode[k] == "yellow"]
        if not cands:
            return
        keys = [self._state_key(c, k, queue, t) for k in cands]
        missing = list({kk for kk in keys if kk not in self.cache})
        if missing:
            self.cache.update(self._fetch(missing))
        for k, kk in zip(cands, keys):
            if self.cache.get(kk, True):
                self.jev_confirms += 1
            else:
                # Jev sagt halten: Yellow zurueckrollen, Gruen bleibt
                self.mode[k] = "green"
                self.elapsed[k] = max(1, self.elapsed[k] - 1)
                self.pending[k] = self.cur[k]
                green_out[c.signalized[k]] = c.phase_ax[k][self.cur[k]]
                self.jev_holds += 1
