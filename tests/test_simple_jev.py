"""Tests for the Simple Jev spike (typed decisions for strategy choice).

Network tests hit the real, keyless demo API and are skipped when the VM is
offline. All other tests are pure logic / fallback behaviour.
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

from signalflow import simple_jev


class TestStateAndQuestions(unittest.TestCase):
    def test_state_renders_summary(self):
        run = {
            "scenario": {"label": "Evening Peak", "vph": 1800},
            "summary": {
                "fixed": {"avg_delay_s": 42.1, "throughput_vph": 1500, "max_queue": 18},
                "adaptive": {"avg_delay_s": 31.7, "throughput_vph": 1650, "max_queue": 9},
            },
        }
        state = simple_jev._state_for(run)
        self.assertEqual(state["scenario"], "Evening Peak")
        self.assertEqual(state["vph_total"], 1800)
        self.assertEqual(state["fixed"]["avg_delay_s"], 42.1)
        self.assertEqual(state["adaptive"]["max_queue"], 9)

    def test_state_tolerates_empty_run(self):
        state = simple_jev._state_for({})
        self.assertEqual(state["scenario"], "custom")
        self.assertNotIn("fixed", state)

    def test_questions_cover_all_policy_keys(self):
        q = simple_jev._questions()
        self.assertEqual(q["strategy"]["type"], "choice")
        self.assertEqual(
            set(q["strategy"]["criteria"].keys()),
            {"fixed", "adaptive", "coordinated", "tuned"},
        )
        self.assertEqual(q["congestion"]["type"], "score")
        self.assertEqual(q["adaptive_wins"]["type"], "noul")


class TestFallback(unittest.TestCase):
    def setUp(self):
        self.run_summary = {
            "summary": {
                "fixed": {"avg_delay_s": 40.0},
                "adaptive": {"avg_delay_s": 30.0},
            }
        }

    def test_fallback_on_transport_error(self):
        with mock.patch.object(simple_jev, "_http_json", side_effect=OSError("down")):
            out = simple_jev.simple_jev_decide(self.run_summary)
        self.assertEqual(out["source"], "fallback")
        self.assertEqual(out["answers"]["strategy"]["choice"], "adaptive")

    def test_fallback_prefers_fixed_without_advantage(self):
        run = {
            "summary": {
                "fixed": {"avg_delay_s": 30.0},
                "adaptive": {"avg_delay_s": 35.0},
            }
        }
        with mock.patch.object(simple_jev, "_http_json", side_effect=OSError("down")):
            out = simple_jev.simple_jev_decide(run)
        self.assertEqual(out["answers"]["strategy"]["choice"], "fixed")

    def test_disabled_returns_fallback(self):
        with mock.patch.dict(os.environ, {"SIMPLE_JEV_DISABLED": "1"}):
            out = simple_jev.simple_jev_decide(self.run_summary)
        self.assertEqual(out["source"], "fallback")
        self.assertIn("disabled", out["note"])


class TestLiveDemoAPI(unittest.TestCase):
    """Hits the real keyless demo endpoint — skipped when offline."""

    def test_live_decision(self):
        run = {
            "scenario": {"label": "Evening Peak", "vph": 1800},
            "summary": {
                "fixed": {"avg_delay_s": 42.1, "throughput_vph": 1500, "max_queue": 18},
                "adaptive": {"avg_delay_s": 31.7, "throughput_vph": 1650, "max_queue": 9},
            },
        }
        try:
            out = simple_jev.simple_jev_decide(run, timeout=25)
        except Exception:  # pragma: no cover
            self.skipTest("demo API unreachable")
        if out["source"] == "fallback":
            self.skipTest(f"demo API unavailable: {out.get('note')}")
        self.assertEqual(out["source"], "simple-jev")
        strategy = out["answers"]["strategy"]
        self.assertIn(strategy.get("choice") or strategy.get("selected"),
                      {"fixed", "adaptive", "coordinated", "tuned"})


if __name__ == "__main__":
    unittest.main()
