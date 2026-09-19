"""Tests for the weekly report tool (``tools/report.py``).

Hermetic and fast: the report is built from 1-minute junction runs with the
district skipped, and ``featherless_available`` is patched so no test touches
the live API. The LLM number-tracing gate is exercised with a scripted chat
model instead.

Run like the rest of the suite::

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location("signalflow_report",
                                               ROOT / "tools" / "report.py")
report = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(report)

from signalflow.simulation import run_scenario  # noqa: E402


class ReportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 1-minute junction runs only, no district: fast and deterministic
        cls.data = report.collect(duration_min=1, region=None, region_duration_min=0)

    def setUp(self):
        # never let a local .env key route a test into the live API
        patcher = unittest.mock.patch.object(report, "featherless_available",
                                             return_value=False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_numbers_match_direct_run_scenario(self):
        direct = run_scenario({"duration_min": 1, "seed": 42,
                               "demand_scenario": "normal"})
        fixed = direct["summary"]["fixed"]["avg_delay_s"]
        adapt = direct["summary"]["adaptive"]["avg_delay_s"]
        md = report.build_report(self.data, "reports/test.md")
        # German decimal comma in the report
        self.assertIn(f"{fixed:.1f}".replace(".", ","), md)
        self.assertIn(f"{adapt:.1f}".replace(".", ","), md)
        self.assertIn(f"{direct['improvement']['avg_delay_pct']:.1f}"
                      .replace(".", ","), md)

    def test_contains_all_four_scenarios_and_repro_command(self):
        md = report.build_report(self.data, "reports/test.md")
        for label in ("Normal", "Berufsverkehr", "Ferien", "Freizeit"):
            self.assertIn(label, md)
        self.assertIn("python3 tools/report.py", md)
        self.assertIn("Modellgrenzen", md)

    def test_deterministic_summary_without_key(self):
        md = report.build_report(self.data, "reports/test.md")
        self.assertIn("Deterministische Zusammenfassung", md)


class LlmSummaryGateTest(unittest.TestCase):
    """The executive summary must only contain traceable numbers."""

    @classmethod
    def setUpClass(cls):
        cls.data = report.collect(duration_min=1, region=None, region_duration_min=0)

    def _with_llm(self, text: str, model: str = "fake-model"):
        patcher = unittest.mock.patch.object(
            report, "featherless_available", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        chat = unittest.mock.patch.object(
            report, "featherless_chat", return_value=(text, model))
        chat.start()
        self.addCleanup(chat.stop)

    def test_truthful_summary_is_kept(self):
        n = self.data["runs"]["normal"]
        text = (f"Die Verzögerung sinkt von "
                f"{n['summary']['fixed']['avg_delay_s']:.1f}".replace(".", ",") + " s auf " +
                f"{n['summary']['adaptive']['avg_delay_s']:.1f}".replace(".", ",") +
                " s. Empfehlung: adaptiv.")
        self._with_llm(text)
        summary, model = report.llm_summary(self.data)
        self.assertEqual(model, "fake-model")
        self.assertIn("Empfehlung", summary)
        self.assertNotIn("unbelegte Zahlen", summary)

    def test_hallucinated_number_triggers_fallback(self):
        self._with_llm("Der Durchsatz steigt auf 9273 Fz/h. Sehr gut.")
        summary, _model = report.llm_summary(self.data)
        self.assertIn("unbelegte Zahlen", summary)
        self.assertIn("9273", summary)

    def test_llm_failure_degrades(self):
        patcher = unittest.mock.patch.object(
            report, "featherless_available", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

        def boom(messages):
            raise RuntimeError("down")

        chat = unittest.mock.patch.object(report, "featherless_chat", side_effect=boom)
        chat.start()
        self.addCleanup(chat.stop)
        summary, model = report.llm_summary(self.data)
        self.assertIsNone(model)
        self.assertIn("fehlgeschlagen", summary)


if __name__ == "__main__":
    unittest.main()
