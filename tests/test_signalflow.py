"""SignalFlow test-suite — pure standard library (``python3 -m unittest``).

Run:  python3 -m unittest discover -s tests -v
"""

import unittest

from signalflow.simulation import (
    Config, FixedTimeController, MaxPressureController, PHASE_NAMES,
    all_movements, build_arrivals, run_scenario, simulate,
)


class TestArrivals(unittest.TestCase):
    def test_deterministic_for_same_seed(self):
        a = build_arrivals(Config(seed=7, duration_min=3))
        b = build_arrivals(Config(seed=7, duration_min=3))
        self.assertEqual(a, b)

    def test_seed_changes_stream(self):
        a = build_arrivals(Config(seed=1, duration_min=3))
        b = build_arrivals(Config(seed=2, duration_min=3))
        self.assertNotEqual(a, b)

    def test_flat_profile_is_stationary(self):
        cfg = Config.from_dict({"demand_profile": "flat", "duration_min": 5})
        self.assertEqual(cfg.demand_scenario, "custom")
        self.assertAlmostEqual(cfg.profile_multiplier(10), 1.0)
        self.assertAlmostEqual(cfg.profile_multiplier(200), 1.0)

    def test_peak_profile_rises_then_falls(self):
        cfg = Config(demand_profile="peak", duration_min=10)
        mid = cfg.profile_multiplier(cfg.steps // 2)
        self.assertGreater(mid, cfg.profile_multiplier(0))
        self.assertGreater(mid, cfg.profile_multiplier(cfg.steps - 1))


class TestControllers(unittest.TestCase):
    def setUp(self):
        self.cfg = Config(duration_min=5)

    def test_fixed_control_respects_max_green(self):
        """Fixed plan never exceeds its programmed green time."""
        cfg = Config(duration_min=10)
        c = FixedTimeController(); c.reset(cfg)
        q = {m: 5.0 for m in all_movements()}
        run = 0
        for t in range(cfg.steps):
            dec = c.step(t, q, cfg)
            if dec["kind"] == "green":
                run += 1
            else:
                self.assertLessEqual(run, max(cfg.fixed_greens))
                run = 0

    def test_adaptive_min_green_enforced(self):
        """With demand present, a pressure-driven switch waits for min_green;
        green is never held past max_green."""
        cfg = Config(duration_min=15, demand_multiplier=1.2)
        c = MaxPressureController(); c.reset(cfg)
        # saturate every movement so the 'empty queue' early-exit never fires
        q = {m: 50.0 for m in all_movements()}
        run = 0
        runs = []
        for t in range(cfg.steps):
            dec = c.step(t, q, cfg)
            if dec["kind"] == "green":
                run += 1
            elif dec["kind"] == "yellow":
                if run:
                    runs.append(run)
                run = 0
        self.assertTrue(runs)
        for r in runs:
            self.assertGreaterEqual(r, cfg.min_green)
            self.assertLessEqual(r, cfg.max_green)

    def test_adaptive_green_never_exceeds_max(self):
        cfg = Config(duration_min=20, demand_multiplier=1.3)
        out = simulate(cfg, build_arrivals(cfg), MaxPressureController())
        # switch timestamps respect min_green only when not exiting an empty phase;
        # the strict, always-true bound is max_green + clearance.
        times = [d["t"] for d in out["decisions"]]
        bound = cfg.max_green + cfg.yellow + cfg.all_red + 1
        for a, b in zip(times, times[1:]):
            self.assertLessEqual(b - a, bound)

    def test_adaptive_reduces_delay_vs_fixed(self):
        cfg = Config(duration_min=30)
        arrivals = build_arrivals(cfg)
        f = simulate(cfg, arrivals, FixedTimeController())["summary"]
        a = simulate(cfg, arrivals, MaxPressureController())["summary"]
        self.assertLess(a["avg_delay_s"], f["avg_delay_s"],
                        "adaptive controller should lower average delay")
        self.assertGreater((f["avg_delay_s"] - a["avg_delay_s"]) / f["avg_delay_s"], 0.10)

    def test_adaptive_wastes_less_green(self):
        cfg = Config(duration_min=30)
        arrivals = build_arrivals(cfg)
        f = simulate(cfg, arrivals, FixedTimeController())["summary"]
        a = simulate(cfg, arrivals, MaxPressureController())["summary"]
        self.assertLess(a["wasted_green_s"], f["wasted_green_s"])

    def test_adaptive_decisions_have_reasons(self):
        out = simulate(self.cfg, build_arrivals(self.cfg), MaxPressureController())
        self.assertTrue(out["decisions"])
        for d in out["decisions"]:
            self.assertTrue(d["reason"])
            self.assertIn(d["to"], PHASE_NAMES)


class TestScenarioPayload(unittest.TestCase):
    def test_payload_shape(self):
        out = run_scenario({"duration_min": 5})
        for key in ("config", "phases", "summary", "improvement",
                    "fixed", "adaptive", "meta"):
            self.assertIn(key, out)
        self.assertIn("fixed", out["summary"])
        self.assertIn("adaptive", out["summary"])
        self.assertTrue(out["fixed"]["frames"])
        self.assertTrue(out["adaptive"]["frames"])
        frame = out["adaptive"]["frames"][0]
        for k in ("t", "phase", "kind", "green", "q", "served", "delay_s"):
            self.assertIn(k, frame)
        self.assertEqual(len(frame["q"]), 12)  # 4 approaches x (L,T,R)


class TestSensorFeed(unittest.TestCase):
    """The 'reacting to sensor data' path: arrivals sourced from a count feed."""

    def test_csv_arrivals_shape_and_determinism(self):
        cfg = Config(arrival_source="csv", duration_min=5)
        a = build_arrivals(cfg)
        b = build_arrivals(cfg)
        self.assertEqual(len(a), cfg.steps)
        self.assertEqual(a, b)
        for row in a:
            for m, n in row.items():
                self.assertIsInstance(n, int)
                self.assertGreaterEqual(n, 0)

    def test_csv_totals_match_feed_scale(self):
        cfg = Config(arrival_source="csv", duration_min=60)
        total = sum(sum(r.values()) for r in build_arrivals(cfg))
        # the sample feed has ~4300 vehicles over 60 min; allow generous slack
        self.assertGreater(total, 3000)
        self.assertLess(total, 6000)

    def test_detector_dropout_reduces_volume(self):
        base = Config(arrival_source="csv", duration_min=20)
        drop = Config(arrival_source="csv", duration_min=20, detector_dropout=0.3)
        vb = sum(sum(r.values()) for r in build_arrivals(base))
        vd = sum(sum(r.values()) for r in build_arrivals(drop))
        self.assertLess(vd, vb)

    def test_missing_feed_raises(self):
        cfg = Config(arrival_source="csv", arrival_csv="data/does-not-exist.csv")
        with self.assertRaises(ValueError):
            build_arrivals(cfg)

    def test_invalid_source_rejected(self):
        with self.assertRaises(ValueError):
            Config.from_dict({"arrival_source": "nope"})
        with self.assertRaises(ValueError):
            Config.from_dict({"detector_dropout": 3})

    def test_csv_mode_still_adapts_better(self):
        cfg = Config(arrival_source="csv", duration_min=30)
        arrivals = build_arrivals(cfg)
        f = simulate(cfg, arrivals, FixedTimeController())["summary"]
        a = simulate(cfg, arrivals, MaxPressureController())["summary"]
        self.assertLess(a["avg_delay_s"], f["avg_delay_s"])


if __name__ == "__main__":
    unittest.main()
