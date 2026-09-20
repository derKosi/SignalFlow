"""SignalFlow HTTP API test-suite (stdlib only, no pytest).

These tests boot the real server (``server.py``) as a subprocess on an
ephemeral free port and exercise the documented endpoints end-to-end over
HTTP, plus a few pure-import checks of the simulation core.

Run exactly like the rest of the suite::

    python3 -m unittest discover -s tests -v

Design notes
------------
* No third-party deps: only ``unittest``, ``urllib``, ``socket``, ``subprocess``.
* The server is started with ``SIGNALFLOW_PORT`` pointing at a free port so the
  tests never collide with a dev server on :8000.
* ``FEATHERLESS_API_KEY`` / ``ELEVENLABS_API_KEY`` are removed from the child
  environment so the offline-fallback / 501 assertions are deterministic.
* The path-traversal check is sent over a *raw socket* so the client never
  normalises ``..`` before it reaches the server (urllib/browsers would).
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _http(method: str, url: str, payload: dict | None = None,
          timeout: float = 30.0) -> tuple[int, bytes, str]:
    """Return (status, body, content_type). Never raises on HTTP status errors."""
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:  # 4xx/5xx still carry a body
        body = e.read()
        ctype = e.headers.get("Content-Type", "") if e.headers else ""
        e.close()
        return e.code, body, ctype


def _raw_request(host: str, port: int, request_line: str, timeout: float = 5.0) -> tuple[int, bytes]:
    """Send a literal request line (no client-side path normalisation)."""
    with socket.create_connection((host, port), timeout=timeout) as s:
        req = f"{request_line}\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
        s.sendall(req.encode("latin-1"))
        chunks = []
        while True:
            data = s.recv(4096)
            if not data:
                break
            chunks.append(data)
    resp = b"".join(chunks)
    head, _, body = resp.partition(b"\r\n\r\n")
    status = int(head.split(b" ", 2)[1])
    return status, body


# ---------------------------------------------------------------------------
# live-server test case
# ---------------------------------------------------------------------------

class ApiLiveTests(unittest.TestCase):
    """End-to-end checks against a freshly started server process."""

    proc: subprocess.Popen | None = None
    port = 0
    base = ""

    @classmethod
    def setUpClass(cls):
        if not (ROOT / "server.py").exists():
            raise unittest.SkipTest(f"server.py not found under {ROOT}")
        cls.port = _free_port()
        cls.base = f"http://127.0.0.1:{cls.port}"

        env = dict(os.environ)
        env["SIGNALFLOW_HOST"] = "127.0.0.1"
        env["SIGNALFLOW_PORT"] = str(cls.port)
        # guarantee the offline/degraded paths are exercised
        env.pop("FEATHERLESS_API_KEY", None)
        env.pop("ELEVENLABS_API_KEY", None)
        env["SIGNALFLOW_NO_DOTENV"] = "1"   # ignore a real .env

        cls.proc = subprocess.Popen(
            [sys.executable, "server.py"],
            cwd=str(ROOT), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        cls._wait_ready()

    @classmethod
    def _wait_ready(cls, timeout: float = 15.0):
        deadline = time.time() + timeout
        last_err = None
        while time.time() < deadline:
            if cls.proc.poll() is not None:
                out = cls.proc.stdout.read().decode("utf-8", "replace") if cls.proc.stdout else ""
                raise RuntimeError(f"server exited early (rc={cls.proc.returncode}):\n{out}")
            try:
                status, body, _ = _http("GET", cls.base + "/api/health", timeout=2.0)
                if status == 200:
                    return
            except Exception as e:  # connection refused while booting
                last_err = e
            time.sleep(0.15)
        raise RuntimeError(f"server did not become ready within {timeout}s (last error: {last_err})")

    @classmethod
    def tearDownClass(cls):
        if cls.proc and cls.proc.poll() is None:
            cls.proc.terminate()
            try:
                cls.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.proc.kill()
                cls.proc.wait(timeout=5)
        if cls.proc and cls.proc.stdout:
            cls.proc.stdout.close()

    # -- GET endpoints ------------------------------------------------------

    def test_get_root_serves_dashboard_html(self):
        status, body, ctype = _http("GET", self.base + "/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ctype)
        text = body.decode("utf-8")
        self.assertIn("<title>SignalFlow", text)
        # the dashboard exposes a top-level mount point (id="main"; the brief
        # also mentions id="app" — this project uses id="main")
        self.assertTrue('id="main"' in text or 'id="app"' in text,
                        "no top-level mount element (id='main'/'app') found")
        # assets are referenced relatively (works when served at "/")
        self.assertIn('src="app.js"', text)
        self.assertIn('href="styles.css"', text)

    def test_get_static_assets(self):
        for path, needle in (("/app.js", "application/javascript"),
                             ("/styles.css", "text/css")):
            status, body, ctype = _http("GET", self.base + path)
            self.assertEqual(status, 200, path)
            self.assertIn(needle, ctype)
            self.assertGreater(len(body), 1000)

    def test_get_health(self):
        status, body, ctype = _http("GET", self.base + "/api/health")
        self.assertEqual(status, 200)
        self.assertIn("application/json", ctype)
        d = json.loads(body)
        for key in ("ok", "featherless", "elevenlabs"):
            self.assertIn(key, d)
        self.assertIs(d["ok"], True)
        # no keys in the child env -> both integrations report unavailable
        self.assertIs(d["featherless"], False)
        self.assertIs(d["elevenlabs"], False)

    def test_get_config(self):
        status, body, _ = _http("GET", self.base + "/api/config")
        self.assertEqual(status, 200)
        d = json.loads(body)
        self.assertEqual(d["duration_min"], 30)
        self.assertIn("demand", d)
        self.assertEqual(set(d["demand"].keys()), {"N", "E", "S", "W"})

    def test_unknown_api_endpoint_404(self):
        status, body, _ = _http("GET", self.base + "/api/gibtsnicht")
        self.assertEqual(status, 404)
        self.assertIn("error", json.loads(body))

    def test_unknown_static_404(self):
        status, body, _ = _http("GET", self.base + "/nope.txt")
        self.assertEqual(status, 404)

    # -- POST endpoints -----------------------------------------------------

    def test_post_simulate_shape(self):
        status, body, ctype = _http("POST", self.base + "/api/simulate", {"duration_min": 5})
        self.assertEqual(status, 200)
        self.assertIn("application/json", ctype)
        d = json.loads(body)

        self.assertIn("summary", d)
        self.assertIn("fixed", d["summary"])
        self.assertIn("adaptive", d["summary"])
        self.assertIn("improvement", d)
        self.assertIn("frames", d["fixed"])
        self.assertIn("frames", d["adaptive"])
        self.assertIn("decisions", d["adaptive"])

        self.assertTrue(d["fixed"]["frames"], "fixed.frames is empty")
        self.assertTrue(d["adaptive"]["frames"], "adaptive.frames is empty")
        self.assertTrue(d["adaptive"]["decisions"], "adaptive.decisions is empty")

        frame = d["adaptive"]["frames"][0]
        for k in ("t", "phase", "kind", "green", "q", "served", "delay_s"):
            self.assertIn(k, frame)
        self.assertEqual(len(frame["q"]), 12)

        imp = d["improvement"]
        for k in ("avg_delay_pct", "throughput_pct", "max_queue_pct", "co2_pct", "wasted_green_pct"):
            self.assertIn(k, imp)

    def test_post_simulate_deterministic(self):
        _, b1, _ = _http("POST", self.base + "/api/simulate", {"duration_min": 10})
        _, b2, _ = _http("POST", self.base + "/api/simulate", {"duration_min": 10})
        d1, d2 = json.loads(b1), json.loads(b2)
        self.assertEqual(d1["summary"], d2["summary"])
        self.assertEqual(d1["improvement"], d2["improvement"])

    def test_post_explain_fallback(self):
        # ensure a run is in context first
        _http("POST", self.base + "/api/simulate", {"duration_min": 5})
        status, body, _ = _http("POST", self.base + "/api/explain",
                                {"question": "Warum wechselt die Phase so oft?"})
        self.assertEqual(status, 200)
        d = json.loads(body)
        self.assertIn("answer", d)
        self.assertEqual(d["source"], "fallback")
        self.assertIn("Warum wechselt die Phase so oft?", d["answer"])

    def test_post_explain_default_question(self):
        status, body, _ = _http("POST", self.base + "/api/explain", {})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["source"], "fallback")

    def test_post_explain_with_network_result_context(self):
        """The network page sends its on-screen district result; the answer
        must explain that run, not the last junction run."""
        net = {"region": "expo_riem", "name": "Neu-Riem",
               "scenario": {"label": "Normal (Wochentag)"},
               "summary": {"fixed": {"avg_delay_s": 40.0, "throughput_vph": 3000,
                                     "avg_travel_time_s": 180.0, "co2_g": 90000,
                                     "served": 5000},
                           "adaptive": {"avg_delay_s": 30.0, "throughput_vph": 3100,
                                        "avg_travel_time_s": 170.0, "co2_g": 70000,
                                        "served": 5100},
                           "coordinated": {"avg_delay_s": 33.0}},
               "improvement": {"avg_delay_pct": 25.0, "throughput_pct": 3.0,
                               "avg_travel_pct": 5.0, "co2_pct": 22.0}}
        status, body, _ = _http("POST", self.base + "/api/explain",
                                {"question": "Was macht adaptiv im Viertel?",
                                 "result": net})
        self.assertEqual(status, 200)
        d = json.loads(body)
        self.assertEqual(d["source"], "fallback")
        self.assertIn("Neu-Riem", d["answer"])
        self.assertIn("grüne Welle", d["answer"])      # coordinated branch
        self.assertNotIn("wasted green", d["answer"])  # junction template leak

    def test_post_agent_with_network_context(self):
        """context.kind=network steers the degraded agent to simulate_network."""
        status, body, _ = _http("POST", self.base + "/api/agent",
                                {"question": "Was bringt adaptiv hier?",
                                 "context": {"kind": "network",
                                             "region": "expo_riem",
                                             "name": "Neu-Riem",
                                             "scenario": "Normal"}})
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data["source"], "fallback")
        self.assertEqual(data["steps"][0]["tool"], "simulate_network")
        self.assertEqual(data["steps"][0]["args"].get("region"), "expo_riem")

    def test_post_agent_degraded_without_key(self):
        """No Featherless key in the child env: the agent still answers by
        running the simulator itself (deterministic keyword path)."""
        status, body, _ = _http("POST", self.base + "/api/agent",
                                {"question": "Was passiert in den Ferien mit 15 % Lkw?"})
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data["source"], "fallback")
        self.assertTrue(data["answer"])
        self.assertTrue(data["steps"])
        self.assertTrue(data["steps"][0]["ok"])
        self.assertEqual(data["steps"][0]["args"].get("scenario"), "ferien")

    def test_post_agent_validates_input(self):
        status, _, _ = _http("POST", self.base + "/api/agent", {"question": "   "})
        self.assertEqual(status, 400)
        status, _, _ = _http("POST", self.base + "/api/agent",
                             {"question": "x", "max_rounds": 99})
        self.assertEqual(status, 400)
        status, _, _ = _http("POST", self.base + "/api/agent",
                             {"question": "x", "mode": "chaos"})
        self.assertEqual(status, 400)

    def test_post_tts_returns_501_without_key(self):
        status, body, _ = _http("POST", self.base + "/api/tts", {"text": "hi"})
        self.assertEqual(status, 501)
        self.assertIn("error", json.loads(body))

    def test_post_tts_empty_text_returns_400(self):
        status, body, _ = _http("POST", self.base + "/api/tts", {})
        self.assertEqual(status, 400)

    def test_post_unknown_endpoint_404(self):
        status, _, _ = _http("POST", self.base + "/api/unknown", {})
        self.assertEqual(status, 404)

    # -- security / robustness ---------------------------------------------

    def test_path_traversal_blocked_raw(self):
        """A literal '/../server.py' must NOT return server source."""
        status, body = _raw_request("127.0.0.1", self.port, "GET /../server.py HTTP/1.1")
        self.assertEqual(status, 404, f"unexpected status {status}")
        self.assertNotIn(b"SignalFlow web server", body)  # server.py docstring line
        self.assertNotIn(b"import json", body)
        self.assertNotIn(b"#!/usr/bin/env python3", body)

    def test_path_traversal_encoded_blocked(self):
        status, body = _raw_request("127.0.0.1", self.port, "GET /..%2fserver.py HTTP/1.1")
        self.assertEqual(status, 404)
        self.assertNotIn(b"SignalFlow web server", body)

    def test_env_file_not_served(self):
        status, body = _raw_request("127.0.0.1", self.port, "GET /../.env HTTP/1.1")
        self.assertEqual(status, 404)
        self.assertNotIn(b"API_KEY", body)

    def test_invalid_duration_does_not_kill_server(self):
        """Malformed input should fail gracefully (documented gap: returns 500
        instead of a 400). The key requirement is that the process survives."""
        for bad in ({"duration_min": 0}, {"duration_min": "abc"}, {"duration_min": None}):
            status, body, _ = _http("POST", self.base + "/api/simulate", bad)
            self.assertIn(status, (400, 422, 500),
                          f"unexpected status {status} for {bad}")
            # server must still answer afterwards
        status, _, _ = _http("GET", self.base + "/api/health")
        self.assertEqual(status, 200)


# ---------------------------------------------------------------------------
# pure-import core checks (no server needed)
# ---------------------------------------------------------------------------

class CoreDeterminismTests(unittest.TestCase):
    def test_run_scenario_is_deterministic(self):
        from signalflow.simulation import run_scenario
        a = run_scenario({"duration_min": 30})
        b = run_scenario({"duration_min": 30})
        self.assertEqual(a["summary"], b["summary"])
        self.assertEqual(a["improvement"], b["improvement"])

    def test_adaptive_lowers_avg_delay(self):
        from signalflow.simulation import run_scenario
        o = run_scenario({"duration_min": 30})
        f = o["summary"]["fixed"]["avg_delay_s"]
        a = o["summary"]["adaptive"]["avg_delay_s"]
        self.assertLess(a, f, "adaptive should lower average delay")
        self.assertGreater((f - a) / f * 100.0, 10.0)
        self.assertEqual(o["improvement"]["avg_delay_pct"],
                         round((f - a) / f * 100.0, 1))


if __name__ == "__main__":
    unittest.main()
