"""Tests for the network (district) simulation — pure standard library.

Run: python3 -m unittest discover -s tests -v
"""

import math
import unittest

from signalflow.network import (
    AdaptiveJunction, AdaptiveSplitJunction, Compiled, FixedJunction, Network,
    REGIONS_DIR, assign_link_flow, build_demand, estimate_od, _gateways,
    list_regions, load_network, run_region,
)
from signalflow.network import _simulate as simulate


def grid_network(rows=4, cols=4, lanes=2):
    lat0, lon0 = 48.130, 11.560
    nodes, idx = [], {}
    for r in range(rows):
        for c in range(cols):
            nid = r * cols + c
            nodes.append({"id": nid, "lat": lat0 + r * 0.0027, "lon": lon0 + c * 0.0036,
                          "deg": 0, "signal": True})
            idx[(r, c)] = nid
    links = []
    lid = [0]

    def add(a, b):
        A, B = nodes[a], nodes[b]
        d = math.hypot((B["lat"] - A["lat"]) * 111320,
                       (B["lon"] - A["lon"]) * 111320 * math.cos(math.radians(48.13)))
        for s, t in ((a, b), (b, a)):
            links.append({"id": lid[0], "from": s, "to": t, "length_m": round(d, 1),
                          "lanes": lanes, "speed_kph": 50, "oneway": False,
                          "name": None, "hw": "secondary"})
            lid[0] += 1

    for r in range(rows):
        for c in range(cols):
            if c + 1 < cols:
                add(idx[(r, c)], idx[(r, c + 1)])
            if r + 1 < rows:
                add(idx[(r, c)], idx[(r + 1, c)])
    net = Network("grid", "Grid", [48.128, 11.556, 48.142, 11.578], nodes, links)
    net.node_idx = {n["id"]: i for i, n in enumerate(nodes)}
    net.link_idx = {l["id"]: i for i, l in enumerate(links)}
    return net


BASE = {"duration_min": 10, "seed": 42, "demand_multiplier": 1.0, "demand_profile": "peak"}


class TestCompiled(unittest.TestCase):
    def setUp(self):
        self.c = Compiled(grid_network())

    def test_counts(self):
        self.assertEqual(self.c.n_nodes, 16)
        self.assertEqual(self.c.n_links, 48)
        self.assertEqual(len(self.c.signalized), 16)

    def test_link_attributes_positive(self):
        for i in range(self.c.n_links):
            self.assertGreaterEqual(self.c.tff[i], 1)
            self.assertGreater(self.c.cap[i], 0)
            self.assertGreater(self.c.discharge[i], 0)

    def test_unsignalized_are_always_green(self):
        c = Compiled(grid_network(rows=3, cols=3))
        self.assertEqual(len(c.unsignalized), 0)  # all signalised in the toy grid


class TestDemand(unittest.TestCase):
    def test_entry_rate_sums_to_total(self):
        c = Compiled(grid_network())
        d = build_demand(c, 4000, 42)
        self.assertAlmostEqual(sum(d["entry_rate"].values()), 4000, places=3)
        self.assertGreater(d["n_entries"], 0)
        self.assertGreater(d["n_exits"], 0)

    def test_turning_fractions_normalised(self):
        c = Compiled(grid_network())
        d = build_demand(c, 4000, 42)
        for l, nxt in enumerate(d["fractions"]):
            if nxt:
                self.assertAlmostEqual(sum(f for _, f in nxt), 1.0, places=6)


class TestSimulation(unittest.TestCase):
    def setUp(self):
        self.c = Compiled(grid_network())

    def test_deterministic(self):
        d = build_demand(self.c, 4000, 7)
        s1, _ = simulate(self.c, d, FixedJunction(self.c), BASE, 4)
        s2, _ = simulate(self.c, d, FixedJunction(self.c), BASE, 4)
        self.assertEqual(s1, s2)

    def test_adaptive_beats_fixed(self):
        d = build_demand(self.c, 5000, 42)
        f, _ = simulate(self.c, d, FixedJunction(self.c), BASE, 4)
        a, _ = simulate(self.c, d, AdaptiveJunction(self.c), BASE, 4)
        self.assertLess(a["avg_delay_s"], f["avg_delay_s"])
        self.assertGreater(a["throughput_vph"], 0)

    def test_throughput_not_inflated(self):
        """Served trips must be on the order of the injected demand, not 4x."""
        d = build_demand(self.c, 4000, 42)
        f, _ = simulate(self.c, d, FixedJunction(self.c), BASE, 4)
        # 4000 veh/h over 10 min = ~667 trips; allow generous headroom
        self.assertLess(f["served"], 2 * 4000 * 10 / 60.0)

    def test_frames_shape(self):
        d = build_demand(self.c, 4000, 42)
        _, frames = simulate(self.c, d, AdaptiveJunction(self.c), BASE, 4)
        self.assertTrue(frames)
        fr = frames[0]
        self.assertIn("t", fr)
        self.assertIn("q", fr)
        self.assertIn("ph", fr)
        self.assertEqual(len(fr["ph"]), len(self.c.signalized))


class TestRegions(unittest.TestCase):
    def test_run_region_unknown_raises(self):
        with self.assertRaises(ValueError):
            run_region("does_not_exist", {"duration_min": 5})

    def test_run_region_invalid_cfg(self):
        regions = list_regions()
        if not regions:
            self.skipTest("no region data yet")
        with self.assertRaises(ValueError):
            run_region(regions[0]["id"], {"duration_min": 0})

    def test_real_region_payload_if_present(self):
        regions = list_regions()
        if not regions:
            self.skipTest("no region data yet (run tools/fetch_osm.py)")
        rid = regions[0]["id"]
        out = run_region(rid, {"duration_min": 5, "seed": 1})
        for key in ("region", "network", "summary", "improvement", "frames", "meta"):
            self.assertIn(key, out)
        self.assertTrue(out["network"]["nodes"])
        self.assertTrue(out["network"]["links"])
        self.assertIn("fixed", out["summary"])
        self.assertIn("adaptive", out["summary"])


class TestCoordination(unittest.TestCase):
    """Green-wave corridor + coordinated policy."""

    def test_corridor_offsets_align_with_nodes(self):
        from signalflow.network import build_corridor, DEFAULT_VPH
        regions = list_regions()
        if not regions:
            self.skipTest("no region data yet")
        rid = regions[0]["id"]
        net = load_network(rid)
        c = Compiled(net)
        dem = build_demand(c, DEFAULT_VPH.get(rid, 4000), 42)
        cor = dem["corridor"]
        self.assertEqual(len(cor["nodes"]), len(cor["offsets"]))
        self.assertEqual(len(cor["nodes"]), len(cor["main_axis"]))
        self.assertGreater(cor["cycle_s"], 0)
        self.assertTrue(all(0 <= o < cor["cycle_s"] for o in cor["offsets"]))

    def test_run_region_reports_three_policies(self):
        regions = list_regions()
        if not regions:
            self.skipTest("no region data yet")
        out = run_region(regions[0]["id"], {"duration_min": 5, "seed": 1})
        for key in ("fixed", "adaptive", "coordinated"):
            self.assertIn(key, out["summary"])
            self.assertIn(key, out["frames"])
        self.assertIn("coordinated", out["improvement"])
        self.assertIn("corridor", out)


class TestODEstimation(unittest.TestCase):
    """Count-based OD estimation: detector counts -> OD -> detector-tuned plan."""

    def _counts(self, c, d):
        counts = [0.0] * c.n_links
        simulate(c, d, FixedJunction(c), BASE, 4, counts=counts)
        return counts

    def test_counts_accumulate_and_are_deterministic(self):
        c = Compiled(grid_network())
        d = build_demand(c, 4000, 42)
        c1 = self._counts(c, d)
        c2 = self._counts(c, d)
        self.assertGreater(sum(c1), 0)
        self.assertEqual(c1, c2)

    def test_estimate_od_report_and_counts_fit(self):
        c = Compiled(grid_network())
        d = build_demand(c, 4000, 42)
        counts = self._counts(c, d)
        entries, exits, dc = _gateways(c)
        od, rep = estimate_od(c, entries, exits, dc, counts)
        self.assertGreater(rep["pairs"], 0)
        self.assertEqual(rep["pairs_active"], rep["pairs"])
        # the estimated assignment reproduces the *measured counts* well
        self.assertLess(rep["fit_rel_err_pct"], 30.0)
        est = assign_link_flow(c, entries, exits, dc, od)
        self.assertTrue(est)

    def test_split_ratios_recovered_even_though_od_is_not_identifiable(self):
        """Counts do not identify the OD matrix (Cascetta) — but the green-split
        ratio per junction, the only thing a tuned plan consumes, is recovered."""
        c = Compiled(grid_network())
        d = build_demand(c, 4000, 42)
        counts = self._counts(c, d)
        entries, exits, dc = _gateways(c)
        od, _rep = estimate_od(c, entries, exits, dc, counts)
        est = assign_link_flow(c, entries, exits, dc, od)
        errs = []
        for a0, a1 in c.phase_ax:
            t0 = sum(d["link_flow"].get(l, 0.0) for l in a0)
            t1 = sum(d["link_flow"].get(l, 0.0) for l in a1)
            s0 = sum(est.get(l, 0.0) for l in a0)
            s1 = sum(est.get(l, 0.0) for l in a1)
            if t0 + t1 >= 1.0:
                tr = t0 / (t0 + t1)
                sr = s0 / (s0 + s1) if s0 + s1 > 0 else 0.5
                errs.append(abs(sr - tr))
        self.assertTrue(errs)
        errs.sort()
        median = errs[len(errs) // 2]
        self.assertLessEqual(median, 0.03)     # median split error ≤ 3 pp
        self.assertLessEqual(errs[-1], 0.20)   # worst junction ≤ 20 pp

    def test_webster_cycle_only_lengthens(self):
        c = Compiled(grid_network())
        ctrl = AdaptiveSplitJunction(c, webster_cycle=True)
        base = ctrl.g[0][0] + ctrl.g[0][1]
        ctrl.phase_ax_ref = c.phase_ax
        ctrl._recompute(0, [0.0] * c.n_links, c)
        self.assertEqual(ctrl.g[0][0] + ctrl.g[0][1], base)      # no load -> base cycle
        hot = [0.6 * c.discharge[l] for l in range(c.n_links)]   # near saturation
        ctrl._recompute(0, hot, c)
        self.assertGreater(ctrl.g[0][0] + ctrl.g[0][1], base)    # lengthens
        ctrl2 = AdaptiveSplitJunction(c, webster_cycle=False)
        ctrl2.phase_ax_ref = c.phase_ax
        ctrl2._recompute(0, hot, c)
        self.assertEqual(ctrl2.g[0][0] + ctrl2.g[0][1], base)    # off -> base cycle

    def test_run_region_reports_detector_tuned_plan(self):
        regions = list_regions()
        if not regions:
            self.skipTest("no region data yet")
        out = run_region(regions[0]["id"], {"duration_min": 5, "seed": 1})
        self.assertIn("fixed_tuned_est", out["summary"])
        self.assertIn("vs_tuned_est", out["improvement"])
        od = out["meta"].get("od_estimation")
        self.assertIsInstance(od, dict)
        self.assertIn("fit_rel_err_pct", od)
        # deterministic
        out2 = run_region(regions[0]["id"], {"duration_min": 5, "seed": 1})
        self.assertEqual(out["summary"]["fixed_tuned_est"],
                         out2["summary"]["fixed_tuned_est"])


if __name__ == "__main__":
    unittest.main()
