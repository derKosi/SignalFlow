"""Simple Jev spike — typed decisions for SignalFlow strategy selection.

Uses Featherless' "Simple Jev" classifier API (an open implementation of the
Jev concept: https://simple-jev.featherless.ai/). The demo endpoint needs no
API key; if SIMPLE_JEV_BASE points elsewhere (paid tier), SIMPLE_JEV_MODEL and
SIMPLE_JEV_API_KEY are honoured. Degrades gracefully: on any transport error
the caller gets a deterministic fallback decision, so the demo never breaks.

Separate module (not wired into server.py) — this is a feature-branch spike.
"""

from __future__ import annotations

import json
import os
import urllib.request

from .integrations import USER_AGENT, _http_json

DEFAULT_BASE = "https://simple-jev-demo-api.featherless.ai/v1"
DEFAULT_MODEL = "featherless-ai/gemma-4-26B-A4B-classifier"

SIMPLE_JEV_BASE = os.environ.get("SIMPLE_JEV_BASE", DEFAULT_BASE)
SIMPLE_JEV_MODEL = os.environ.get("SIMPLE_JEV_MODEL", DEFAULT_MODEL)
_TIMEOUT = 20  # demo API answers in <1s; 20s covers bad-days headroom

# Strategy choice: which control policy should run at this junction given the
# current demand mix? Maps 1:1 to the POLICY_META keys used by the web UI
# (fixed / adaptive / coordinated / tuned).
_STRATEGIES = ["fixed", "adaptive", "coordinated", "tuned"]


def _cfg() -> dict:
    """Runtime config (env may change in tests)."""
    return {
        "base": os.environ.get("SIMPLE_JEV_BASE", SIMPLE_JEV_BASE),
        "model": os.environ.get("SIMPLE_JEV_MODEL", SIMPLE_JEV_MODEL),
        "key": os.environ.get("SIMPLE_JEV_API_KEY", "").strip() or None,
    }


def _state_for(run_summary: dict) -> dict:
    """Build the compact JSON state for Jev from a simulation summary.

    Note: deliberately structured JSON, not prose — the demo classifier
    produced non-finite logits (HTTP 422) on several prose states during
    the spike, while the equivalent JSON state worked 6/6.
    """
    s = run_summary.get("summary", {})
    scen = run_summary.get("scenario") or {}
    state: dict = {
        "domain": "signal control (traffic junction simulation)",
        "scenario": scen.get("label") or scen.get("name") or "custom",
        "vph_total": scen.get("vph_total") or scen.get("vph"),
    }
    metrics = ("avg_delay_s", "throughput_vph", "max_queue")
    for pol in ("fixed", "adaptive"):
        m = s.get(pol) or {}
        state[pol] = {k: m.get(k) for k in metrics if m.get(k) is not None}
        if not state[pol]:
            del state[pol]
    return state


def _questions() -> dict:
    return {
        "strategy": {
            "type": "choice",
            "instructions": "Which signal control strategy fits this junction best?",
            "criteria": {
                pol: _STRATEGY_HINTS[pol] for pol in _STRATEGIES
            },
        },
        "congestion": {
            "type": "score",
            "instructions": "How congested does this junction look?",
            "criteria": ["free flow", "busy but stable", "oversaturated gridlock"],
        },
        "adaptive_wins": {
            "type": "noul",
            "instructions": "Does adaptive control clearly beat fixed timing here?",
        },
    }


_STRATEGY_HINTS = {
    "fixed": "low or steady demand, predictable daily pattern",
    "adaptive": "fluctuating demand, uneven queue growth across approaches",
    "coordinated": "part of a corridor or network where platoons should progress",
    "tuned": "fixed plan re-timed offline from historical data",
}


def simple_jev_available() -> bool:
    """The demo endpoint needs no key — always 'available' unless disabled."""
    return os.environ.get("SIMPLE_JEV_DISABLED", "").lower() not in ("1", "true", "yes")


def simple_jev_decide(run_summary: dict, timeout: int = _TIMEOUT) -> dict:
    """Ask Simple Jev for a typed strategy decision over a run summary.

    Returns dict with keys: source ('simple-jev' | 'fallback'), answers,
    and on success model/usage. Never raises on transport errors.
    """
    if not simple_jev_available():
        return _fallback(run_summary, note="simple-jev disabled")
    cfg = _cfg()
    payload = {
        "model": cfg["model"],
        "state": _state_for(run_summary),
        "questions": _questions(),
    }
    headers = {"Content-Type": "application/json"}
    if cfg["key"]:
        headers["Authorization"] = f"Bearer {cfg['key']}"
    try:
        out = _http_json(f"{cfg['base']}/classifier", payload, headers, timeout=timeout)
    except Exception as exc:  # noqa: BLE001 — demo must never 500 here
        return _fallback(run_summary, note=f"transport error: {type(exc).__name__}")
    answers = (out or {}).get("answers") or {}
    if "strategy" not in answers:
        return _fallback(run_summary, note="protocol: no strategy answer")
    return {
        "source": "simple-jev",
        "model": out.get("model"),
        "usage": out.get("usage"),
        "answers": answers,
    }


def _fallback(run_summary: dict, note: str) -> dict:
    """Deterministic offline decision: adaptive iff it beat fixed on delay."""
    s = (run_summary or {}).get("summary", {})
    fixed = (s.get("fixed") or {}).get("avg_delay_s")
    adaptive = (s.get("adaptive") or {}).get("avg_delay_s")
    if fixed is not None and adaptive is not None and adaptive < fixed:
        strategy, why = "adaptive", "lower avg delay than fixed"
    else:
        strategy, why = "fixed", "no adaptive advantage measured"
    return {
        "source": "fallback",
        "note": note,
        "answers": {
            "strategy": {"choice": strategy, "why": why},
            "congestion": None,
            "adaptive_wins": None,
        },
    }
