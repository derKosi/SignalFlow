"""Tests for the third-party feed adapter (pure stdlib)."""

import csv
import tempfile
import unittest
from pathlib import Path

from signalflow import feed_adapter as fa
from signalflow.simulation import Config, build_arrivals

GENERIC = """timestamp,device_id,location,traffic_count,avg_speed,status
2026-01-01 08:00,TS_001,Zone_A,15,32,OK
2026-01-01 08:00,TS_002,Zone_B,12,28,OK
2026-01-01 08:01,TS_001,Zone_A,18,30,OK
2026-01-01 08:01,TS_002,Zone_B,9,29,OK
"""


class TestFeedAdapter(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.src = self.dir / "generic.csv"
        self.src.write_text(GENERIC, encoding="utf-8")
        self.out = self.dir / "adapted.csv"

    def tearDown(self):
        self.tmp.cleanup()

    def test_detects_generic_and_writes_canonical(self):
        st = fa.adapt(str(self.src), str(self.out))
        self.assertEqual(st["format"], "generic")
        self.assertEqual(st["rows_in"], 4)
        self.assertTrue(self.out.is_file())
        rows = list(csv.DictReader(self.out.open(encoding="utf-8")))
        self.assertTrue(all(r["movement"] in ("L", "T", "R") for r in rows))
        self.assertTrue(all(r["approach"] in ("N", "E", "S", "W") for r in rows))
        self.assertEqual(sum(int(r["vehicles_count"]) for r in rows), 15 + 12 + 18 + 9)

    def test_totals_preserved_for_any_split(self):
        st = fa.adapt(str(self.src), str(self.out), split=(0.0, 1.0, 0.0))
        rows = list(csv.DictReader(self.out.open(encoding="utf-8")))
        self.assertTrue(all(r["movement"] == "T" for r in rows))
        self.assertEqual(sum(int(r["vehicles_count"]) for r in rows), 54)

    def test_mapping_is_stable_and_overridable(self):
        st = fa.adapt(str(self.src))
        self.assertEqual(st["mapping"], {"Zone_A": "N", "Zone_B": "E"})
        st2 = fa.adapt(str(self.src), mapping={"Zone_A": "W"})
        self.assertEqual(st2["mapping"]["Zone_A"], "W")

    def test_deterministic(self):
        a, b = fa.adapt(str(self.src)), fa.adapt(str(self.src))
        self.assertEqual(a["total_vehicles"], b["total_vehicles"])
        self.assertEqual(a["rows_out"], b["rows_out"])

    def test_per_second_spreading(self):
        st = fa.adapt(str(self.src), per_second=True)
        self.assertGreater(st["rows_out"], 4)
        self.assertEqual(st["total_vehicles"], 54)      # totals still preserved

    def test_loader_consumes_the_output(self):
        ex = self.dir / "ex.csv"
        fa.make_example(str(ex), minutes=3, zones=3)
        st = fa.adapt(str(ex), str(self.out))
        cfg = Config.from_dict({"arrival_source": "csv", "arrival_csv": str(self.out),
                                "duration_min": 3})
        arr = build_arrivals(cfg)
        self.assertEqual(len(arr), cfg.steps)
        self.assertEqual(sum(sum(r.values()) for r in arr), st["total_vehicles"])

    def test_example_generator_shape(self):
        ex = self.dir / "ex.csv"
        info = fa.make_example(str(ex), minutes=10, zones=4)
        self.assertEqual(info["rows"], 40)
        st = fa.adapt(str(ex))
        self.assertEqual(st["format"], "generic")
        self.assertGreater(st["total_vehicles"], 0)
        self.assertEqual(len(st["approaches"]), 4)

    def test_rejects_missing_count_column(self):
        bad = self.dir / "bad.csv"
        bad.write_text("a,b\n1,2\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            fa.adapt(str(bad))

    def test_rejects_empty_input(self):
        empty = self.dir / "empty.csv"
        empty.write_text("", encoding="utf-8")
        with self.assertRaises(ValueError):
            fa.adapt(str(empty))


if __name__ == "__main__":
    unittest.main()
