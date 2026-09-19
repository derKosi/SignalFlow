"""Tests for the agentic copilot (``signalflow/agent.py``, ``POST /api/agent``).

Hermetic by construction: the LLM is a scripted fake callable injected via
``run_agent(..., llm=...)``, so no test ever touches the network. The
Featherless availability flag is patched where the degraded path is exercised.

Run like the rest of the suite::

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import sys
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from signalflow.agent import (  # noqa: E402
    ToolBox, extract_json, run_agent, unsupported_numbers,
)
from signalflow.simulation import run_scenario  # noqa: E402


def _clear_caches() -> None:
    import signalflow.agent as A
    A._TOOL_CACHE.clear()
    A._ANSWER_CACHE.clear()


def _fake_llm(replies: list[str], seen: list[list[dict]] | None = None):
    """Scripted chat model: returns replies in order, records the messages."""
    calls = {"n": 0}

    def llm(messages: list[dict]) -> tuple[str, str]:
        if seen is not None:
            seen.append([dict(m) for m in messages])
        i = calls["n"]
        calls["n"] += 1
        if i >= len(replies):
            raise AssertionError("fake LLM called more often than scripted")
        return replies[i], "fake-model"

    return llm


FINAL_OK = '{"final": "Die adaptive Steuerung ist besser."}'


class ExtractJsonTest(unittest.TestCase):
    def test_plain_object(self):
        self.assertEqual(extract_json('{"final": "ok"}')["final"], "ok")

    def test_fenced_code_block(self):
        text = 'Sure!\n```json\n{"tool": "simulate", "args": {}}\n```\ndone'
        self.assertEqual(extract_json(text)["tool"], "simulate")

    def test_prose_around_object(self):
        obj = extract_json('blah {"a": {"b": "}"} } tail')
        self.assertEqual(obj["a"]["b"], "}")

    def test_no_json(self):
        self.assertIsNone(extract_json("no json here"))
        self.assertIsNone(extract_json(""))
        self.assertIsNone(extract_json("[1, 2, 3]"))  # not an object


class ToolBoxTest(unittest.TestCase):
    def setUp(self):
        _clear_caches()

    def test_simulate_numbers_match_manual_run(self):
        """Acceptance: the tool result equals a manual run_scenario (same seed)."""
        args = {"scenario": "ferien", "demand_multiplier": 1.2,
                "vehicle_mix": {"car": 0.85, "truck": 0.15}, "duration_min": 5}
        digest = ToolBox().execute("simulate", args)
        self.assertTrue(digest["ok"])
        manual = run_scenario({"demand_scenario": "ferien", "demand_multiplier": 1.2,
                               "vehicle_mix": {"car": 0.85, "truck": 0.15},
                               "duration_min": 5})
        self.assertEqual(digest["fixed"], {k: manual["summary"]["fixed"][k]
                                           for k in digest["fixed"]})
        self.assertEqual(digest["adaptive"], {k: manual["summary"]["adaptive"][k]
                                              for k in digest["adaptive"]})

    def test_unknown_argument_rejected(self):
        digest = ToolBox().execute("simulate", {"seed": 7})
        self.assertFalse(digest["ok"])
        self.assertIn("unknown argument", digest["error"])

    def test_invalid_scenario_surfaced_from_config_validation(self):
        digest = ToolBox().execute("simulate", {"scenario": "urlaubstage"})
        self.assertFalse(digest["ok"])
        self.assertIn("demand_scenario", digest["error"])

    def test_network_region_whitelist(self):
        digest = ToolBox().execute("simulate_network", {"region": "atlantis"})
        self.assertFalse(digest["ok"])
        self.assertIn("region must be one of", digest["error"])

    def test_explain_last_without_run(self):
        digest = ToolBox().execute("explain_last", {})
        self.assertFalse(digest["ok"])
        self.assertIn("no simulation", digest["error"])

    def test_explain_last_uses_dashboard_result(self):
        last = {"config": {"demand_scenario": "normal", "duration_min": 30,
                           "seed": 42, "demand_multiplier": 1.0,
                           "junction_type": "cross4", "vehicle_mix": {"car": 1.0},
                           "transit_priority": False},
                "scenario": {"label": "Normal"},
                "summary": {"fixed": {"avg_delay_s": 20.0},
                            "adaptive": {"avg_delay_s": 10.0}},
                "improvement": {"avg_delay_pct": 50.0},
                "adaptive": {"decisions": [{"reason": "queue cleared"}]}}
        digest = ToolBox(last_result=last).execute("explain_last", {})
        self.assertTrue(digest["ok"])
        self.assertEqual(digest["fixed"]["avg_delay_s"], 20.0)
        self.assertEqual(digest["improvement"]["avg_delay_pct"], 50.0)

    def test_explain_last_detects_network_shape(self):
        """A district result must digest as network, not as a junction run."""
        last = {"region": "expo_riem", "name": "Neu-Riem",
                "config": {"duration_min": 20, "seed": 1},
                "scenario": {"name": "normal", "label": "Normal"},
                "summary": {"fixed": {"avg_delay_s": 40.0, "throughput_vph": 3000,
                                      "avg_travel_time_s": 180.0, "co2_g": 90000,
                                      "served": 5000},
                            "adaptive": {"avg_delay_s": 30.0}},
                "improvement": {"avg_delay_pct": 25.0}}
        digest = ToolBox(last_result=last).execute("explain_last", {})
        self.assertTrue(digest["ok"])
        self.assertEqual(digest["region"], "expo_riem")
        self.assertIn("policies", digest)
        self.assertNotIn("fixed", digest)          # junction view would add this
        self.assertNotIn("decisions_sample", digest)

    def test_context_hint_routes_deterministic_path_and_cache(self):
        """The hint carries the on-screen region into the no-key agent path
        and is part of the answer cache key (no cross-context leaks)."""
        _clear_caches()
        q = "Was bringt die adaptive Steuerung im aktuellen Blick?"
        hint = ("Kontext: Netzwerk-Simulation, Region 'expo_riem' (Neu-Riem), "
                "Szenario Normal. Beantworte die Frage für diese Region "
                "(Werkzeug: simulate_network).")
        with unittest.mock.patch("signalflow.agent.featherless_available",
                                 return_value=False):
            out_net = run_agent(q, context_hint=hint)
            out_junction = run_agent(q)            # same text, no hint
        self.assertEqual(out_net["source"], "fallback")
        self.assertEqual(out_net["steps"][0]["tool"], "simulate_network")
        self.assertEqual(out_net["steps"][0]["args"].get("region"), "expo_riem")
        self.assertEqual(out_junction["steps"][0]["tool"], "simulate")
        self.assertFalse(out_net.get("cached"))
        self.assertFalse(out_junction.get("cached"))

    def test_result_cache_marks_second_call(self):
        box = ToolBox()
        first = box.execute("simulate", {"duration_min": 2})
        second = box.execute("simulate", {"duration_min": 2})
        self.assertNotIn("_cached", first)
        self.assertTrue(second.get("_cached"))


class UnsupportedNumbersTest(unittest.TestCase):
    """The deterministic anti-hallucination check (German number formats)."""

    FACTS = {"fix_s": 53.86, "adaptiv_s": 40.67, "pct": 24.5, "fzh": 4410.0,
             "co2": 136951.0, "nested": {"travel_s": 189.1}}

    def test_supported_numbers_pass(self):
        self.assertEqual(unsupported_numbers(
            "Die Verzögerung sinkt von 53,86 s auf 40,67 s (−24,5 %).", self.FACTS), [])
        self.assertEqual(unsupported_numbers(
            "Durchsatz 4410 Fz/h, Reisezeit 189,1 s.", self.FACTS), [])

    def test_thousands_dot_is_understood(self):
        # "44.100" may mean 44.1 or 44100 - neither is 4410, so it must FAIL
        bad = unsupported_numbers("Der Durchsatz liegt bei 44.100 Fz/h.", self.FACTS)
        self.assertTrue(bad)

    def test_injected_false_number_is_caught(self):
        bad = unsupported_numbers("Die Verzögerung sinkt auf 99,9 s.", self.FACTS)
        self.assertEqual(bad, [99.9])

    def test_hallucinated_aggregate_is_caught(self):
        bad = unsupported_numbers("Der Durchsatz steigt auf 9273 Fz/h.", self.FACTS)
        self.assertEqual(bad, [9273.0])


class RunAgentTest(unittest.TestCase):
    def setUp(self):
        _clear_caches()
        # never let a local .env key route a test into the live API
        unittest.mock.patch("signalflow.agent.featherless_available",
                            return_value=False).start()
        self.addCleanup(unittest.mock.patch.stopall)

    def test_happy_path_tool_then_final(self):
        llm = _fake_llm(['```json\n{"tool": "simulate", "args": {"duration_min": 3}}\n```',
                         '{"final": "Delay dropped to 12.3 s."}'])
        out = run_agent("Warum?", llm=llm, use_cache=False)
        self.assertEqual(out["source"], "featherless")
        self.assertEqual(out["model"], "fake-model")
        self.assertEqual(out["answer"], "Delay dropped to 12.3 s.")
        self.assertEqual(len(out["steps"]), 1)
        self.assertTrue(out["steps"][0]["ok"])
        self.assertEqual(out["steps"][0]["tool"], "simulate")

    def test_digest_fed_back_to_model(self):
        seen: list[list[dict]] = []
        llm = _fake_llm(['{"tool": "simulate", "args": {"duration_min": 3}}', FINAL_OK],
                        seen)
        run_agent("Warum?", llm=llm, use_cache=False)
        self.assertGreaterEqual(len(seen), 2)
        third = seen[1]  # system, user, assistant(tool call), user(tool result)
        self.assertEqual(len(third), 4)
        self.assertIn("TOOL RESULT", third[-1]["content"])
        self.assertIn("avg_delay_s", third[-1]["content"])

    def test_unknown_tool_yields_error_digest_then_recovery(self):
        llm = _fake_llm(['{"tool": "weather", "args": {}}', FINAL_OK])
        out = run_agent("Wetter?", llm=llm, use_cache=False)
        self.assertEqual(out["answer"], "Die adaptive Steuerung ist besser.")
        self.assertEqual(len(out["steps"]), 1)
        self.assertFalse(out["steps"][0]["ok"])
        self.assertIn("unknown tool", out["steps"][0]["digest"]["error"])

    def test_malformed_json_repaired_once(self):
        llm = _fake_llm(["I would suggest running a simulation first.", FINAL_OK])
        out = run_agent("Warum?", llm=llm, use_cache=False)
        self.assertEqual(out["source"], "featherless")
        self.assertEqual(out["answer"], "Die adaptive Steuerung ist besser.")
        self.assertEqual(out["steps"], [])

    def test_malformed_json_twice_falls_back(self):
        llm = _fake_llm(["no protocol here", "still no protocol"])
        out = run_agent("Warum wechselt die Phase?", llm=llm, use_cache=False)
        self.assertEqual(out["source"], "fallback")
        self.assertIn("JSON protocol", out["note"])
        self.assertTrue(out["answer"])
        self.assertTrue(out["steps"])   # deterministic path ran a real simulation

    def test_tool_budget_exhausted_falls_back(self):
        tool = '{"tool": "simulate", "args": {"duration_min": 2}}'
        llm = _fake_llm([tool, tool, tool, tool])
        out = run_agent("Was passt du nicht besser?", llm=llm, max_rounds=3,
                        use_cache=False)
        self.assertEqual(out["source"], "fallback")
        self.assertIn("budget", out["note"])
        # the four scripted tool calls ran; the fallback appends its own step
        self.assertEqual([s["tool"] for s in out["steps"][:4]], ["simulate"] * 4)

    def test_llm_failure_degrades_gracefully(self):
        def boom(messages):
            raise RuntimeError("network down")
        out = run_agent("Warum?", llm=boom, use_cache=False)
        self.assertEqual(out["source"], "fallback")
        self.assertIn("LLM call failed", out["note"])

    def test_no_key_deterministic_path(self):
        # featherless_available patched to False in setUp; llm=None
        out = run_agent("Was passiert in den Ferien mit 15 % Lkw?", llm=None,
                        use_cache=False)
        self.assertEqual(out["source"], "fallback")
        self.assertIn("FEATHERLESS_API_KEY", out["note"])
        self.assertTrue(out["steps"])
        self.assertTrue(out["steps"][0]["ok"])
        # the keyword scan picked the ferien scenario and a truck share
        self.assertEqual(out["steps"][0]["args"].get("scenario"), "ferien")

    def test_input_validation(self):
        with self.assertRaises(ValueError):
            run_agent("   ", llm=_fake_llm([]), use_cache=False)
        with self.assertRaises(ValueError):
            run_agent("Frage", max_rounds=9, llm=_fake_llm([]), use_cache=False)

    def test_question_is_truncated(self):
        llm = _fake_llm([FINAL_OK])
        out = run_agent("x" * 5000, llm=llm, use_cache=False)
        self.assertEqual(out["answer"], "Die adaptive Steuerung ist besser.")


class PanelPipelineTest(unittest.TestCase):
    """Analyst -> critic -> writer pipeline (mode='panel').

    Drafts/writer texts without digits pass number tracing; a deliberately
    injected false number (e.g. '99,9') must be caught by the deterministic
    gate - the acceptance case from HANDOFF section 14.B.
    """

    def setUp(self):
        _clear_caches()
        unittest.mock.patch("signalflow.agent.featherless_available",
                            return_value=False).start()
        self.addCleanup(unittest.mock.patch.stopall)

    def test_panel_happy_path(self):
        llm = _fake_llm([
            '{"tool": "simulate", "args": {"duration_min": 2}}',
            '{"final": "Die adaptive Steuerung senkt die Verzögerung deutlich."}',
            '{"verdict": "ok"}',
            '{"final": "Adaptiv ist besser. Prüfung: alle Zahlen aus den Tool-Digests."}',
        ])
        out = run_agent("Warum?", llm=llm, mode="panel", use_cache=False)
        self.assertEqual(out["pipeline"], "panel")
        self.assertEqual(out["revisions"], 0)
        self.assertIn("Prüfung:", out["answer"])
        self.assertEqual([c["stage"] for c in out["checks"]], ["critic", "writer"])
        self.assertEqual(out["checks"][1]["verdict"], "ok")
        self.assertEqual(len(out["steps"]), 1)

    def test_injected_false_number_caught_by_gate(self):
        llm = _fake_llm([
            '{"tool": "simulate", "args": {"duration_min": 2}}',
            '{"final": "Die Verzögerung sinkt auf 99,9 Sekunden."}',   # false number
            '{"final": "Die adaptive Steuerung senkt die Verzögerung spürbar."}',
            '{"verdict": "ok"}',
            '{"final": "Geprüfte Antwort. Prüfung: Zahlen aus den Digests."}',
        ])
        out = run_agent("Warum?", llm=llm, mode="panel", use_cache=False)
        self.assertEqual(out["revisions"], 1)
        self.assertEqual(out["checks"][0]["verdict"], "revise")
        self.assertEqual(out["checks"][0]["untraceable_numbers"], [99.9])
        self.assertNotIn("99,9", out["answer"])

    def test_critic_flags_wrong_premise_and_revision_corrects(self):
        llm = _fake_llm([
            '{"tool": "simulate", "args": {"scenario": "ferien", "duration_min": 2}}',
            '{"final": "Der Durchsatz sinkt in den Ferien, weil die Ampel versagt."}',
            '{"verdict": "revise", "issues": ["premise wrong: total demand drops in '
            'ferien; the per-vehicle delay improves - state the real figure"]}',
            '{"final": "In den Ferien sinkt die Gesamtnachfrage; pro Fahrzeug sinkt '
            'die Verzögerung, der Durchsatz nimmt ab."}',
            '{"verdict": "ok"}',
            '{"final": "Korrigiert: die Nachfrage sinkt, die Ampel nicht. '
            'Prüfung: Digests."}',
        ])
        out = run_agent("Warum sinkt der Durchsatz in den Ferien?", llm=llm,
                        mode="panel", use_cache=False)
        self.assertEqual(out["revisions"], 1)
        self.assertIn("premise wrong", out["checks"][0]["issues"][0])
        self.assertIn("Nachfrage sinkt", out["answer"])

    def test_writer_violation_falls_back_to_draft(self):
        llm = _fake_llm([
            '{"tool": "simulate", "args": {"duration_min": 2}}',
            '{"final": "Die adaptive Steuerung senkt die Verzögerung deutlich."}',
            '{"verdict": "ok"}',
            '{"final": "Nur 0,001 Sekunden Verzögerung! Prüfung: trust me."}',
        ])
        out = run_agent("Warum?", llm=llm, mode="panel", use_cache=False)
        self.assertEqual(out["checks"][-1]["verdict"], "rejected")
        self.assertIn("writer", out["note"])
        self.assertIn("Die adaptive Steuerung senkt die Verzögerung deutlich",
                      out["answer"])
        self.assertIn("Prüfung: Zahlen stammen direkt", out["answer"])

    def test_critic_parse_failure_accepts_draft(self):
        llm = _fake_llm([
            '{"tool": "simulate", "args": {"duration_min": 2}}',
            '{"final": "Die adaptive Steuerung senkt die Verzögerung deutlich."}',
            'no protocol here',
            '{"final": "Geprüft. Prüfung: Digests."}',
        ])
        out = run_agent("Warum?", llm=llm, mode="panel", use_cache=False)
        self.assertEqual(out["revisions"], 0)   # draft accepted despite critic failure
        self.assertIn("Geprüft.", out["answer"])

    def test_unrepairable_draft_uses_safety_net(self):
        llm = _fake_llm([
            '{"tool": "simulate", "args": {"duration_min": 2}}',
            '{"final": "Es gibt 99,9 Sekunden Verzögerung."}',
            '{"final": "Es gibt 77,7 Sekunden Verzögerung."}',       # still untraceable
            '{"final": "Angenommen, das System arbeitet im Normalbetrieb."}',
        ])
        out = run_agent("Warum?", llm=llm, mode="panel", use_cache=False)
        self.assertNotIn("99,9", out["answer"])
        self.assertNotIn("77,7", out["answer"])
        self.assertIn("number tracing", out["note"])

    def test_mode_validation(self):
        with self.assertRaises(ValueError):
            run_agent("Frage", llm=_fake_llm([]), mode="chaos", use_cache=False)


if __name__ == "__main__":
    unittest.main()
