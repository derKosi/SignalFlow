#!/usr/bin/env python3
"""SignalFlow web server — pure Python standard library.

    python3 server.py            # serves http://127.0.0.1:8000

Endpoints
---------
GET  /                dashboard (web/index.html + assets)
GET  /api/health      integration status
GET  /api/config      default scenario configuration
POST /api/simulate    run baseline vs adaptive on identical traffic
POST /api/explain     Featherless (or offline) explanation of the last run
POST /api/agent       agentic copilot: the LLM runs simulator tools, then answers
POST /api/tts         ElevenLabs speech, or 501 when no key is configured
"""

from __future__ import annotations

import json
import os
import sys
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from signalflow import __version__  # noqa: E402
from signalflow.agent import run_agent  # noqa: E402
from signalflow.integrations import (  # noqa: E402
    elevenlabs_available, elevenlabs_probe, elevenlabs_tts, featherless_available,
    featherless_explain, featherless_probe,
)
from signalflow.geofetch import add_region  # noqa: E402
from signalflow.network import list_regions, run_region  # noqa: E402
from signalflow.simulation import (  # noqa: E402
    Config, DEMAND_SCENARIOS, PCE, feed_path, run_scenario,
)

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
ROOT_FILES = {"README.md", "WRITEUP.md", "SUBMISSION.md", "DEMO.md", "NOTICE.md", "LICENSE", "HANDOFF.md"}
CACHE_DIR = ROOT / "data" / "cache"        # disk cache: instant repeated/demo runs


def _cache_key(path: str, payload: dict) -> str:
    import hashlib
    h = hashlib.sha1((path + "|" + json.dumps(payload, sort_keys=True)).encode()).hexdigest()
    return h[:24]


def disk_get(key: str):
    f = CACHE_DIR / (key + ".json")
    if f.is_file():
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return None
    return None


def disk_put(key: str, value: dict) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (CACHE_DIR / (key + ".json")).write_text(json.dumps(value), encoding="utf-8")
    except OSError:
        pass
HOST = os.environ.get("SIGNALFLOW_HOST", "127.0.0.1")
PORT = int(os.environ.get("SIGNALFLOW_PORT", "8000"))

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".csv": "text/csv; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
}

# Last simulation result, used as context for /api/explain.
LAST: dict | None = None
# Last network (district) result — kept separate so junction and network pages
# never flip each other's explain/agent context.
LAST_NETWORK: dict | None = None
# Small result cache so repeated demo clicks (same config) return instantly.
CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
CACHE_MAX = 24


def cache_get(key):
    if key in CACHE:
        CACHE.move_to_end(key)
        return CACHE[key]
    return None


def cache_put(key, value):
    CACHE[key] = value
    CACHE.move_to_end(key)
    while len(CACHE) > CACHE_MAX:
        CACHE.popitem(last=False)


def _agent_context(ctx) -> tuple:
    """Map the client-sent page context to (context_hint, last_result).

    The network page sends ``{kind: "network", region, name, scenario}`` so the
    agent answers for the district currently on screen; anything else keeps the
    junction context.
    """
    if isinstance(ctx, dict) and ctx.get("kind") == "network" and ctx.get("region"):
        name = f" ({ctx['name']})" if ctx.get("name") else ""
        scen = f", Szenario {ctx['scenario']}" if ctx.get("scenario") else ""
        hint = (f"Kontext: Netzwerk-Simulation, Region '{ctx['region']}'{name}{scen}. "
                "Beantworte die Frage für diese Region (Werkzeug: simulate_network).")
        return hint, LAST_NETWORK
    return None, LAST


class Handler(BaseHTTPRequestHandler):
    server_version = f"SignalFlow/{__version__}"

    # -- helpers ------------------------------------------------------------
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            raise ValueError(f"invalid JSON body: {e}")

    def _feed_preview(self, limit: int = 12) -> None:
        """Preview the configured sensor-count feed (stand-in for briefing data)."""
        import csv as _csv
        path = feed_path(Config())
        if not path.is_file():
            self._json(404, {"error": "no sensor feed", "path": str(path)})
            return
        with path.open(newline="", encoding="utf-8") as fh:
            reader = _csv.reader(fh)
            rows = list(reader)
        header, body = (rows[0], rows[1:]) if rows else ([], [])
        self._json(200, {
            "path": str(path.relative_to(ROOT.parent) if str(path).startswith(str(ROOT.parent)) else path),
            "columns": header,
            "rows_total": len(body),
            "rows": body[:limit],
        })

    def _serve_static(self, rel: str) -> None:
        rel = rel.lstrip("/") or "index.html"
        if rel in ("", "/"):
            rel = "index.html"
        target = (WEB / rel).resolve()
        web_root = str(WEB.resolve())
        inside = str(target) == web_root or str(target).startswith(web_root + os.sep)
        if not inside or not target.is_file():
            # second, whitelisted root: docs/ and the top-level markdown files
            first = rel.split("/", 1)[0]
            if first == "docs" or rel in ROOT_FILES:
                alt = (ROOT / rel).resolve()
                alt_root = str(ROOT.resolve())
                inside2 = str(alt) == alt_root or str(alt).startswith(alt_root + os.sep)
                if inside2 and alt.is_file():
                    target = alt
                else:
                    self._json(404, {"error": "not found", "path": rel})
                    return
            else:
                self._json(404, {"error": "not found", "path": rel})
                return
        ctype = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        self._send(200, target.read_bytes(), ctype)

    # -- routing ------------------------------------------------------------
    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            self._json(200, {
                "ok": True,
                "version": __version__,
                "featherless": featherless_available(),
                "elevenlabs": elevenlabs_available(),
            })
        elif path == "/api/config":
            self._json(200, Config().to_dict())
        elif path == "/api/feed":
            self._feed_preview()
        elif path == "/api/keys":
            self._json(200, {"featherless": featherless_probe(),
                              "elevenlabs": elevenlabs_probe()})
        elif path == "/api/regions":
            self._json(200, {"regions": list_regions()})
        elif path == "/api/scenarios":
            self._json(200, {
                "scenarios": [{"id": k, "label": v["label"],
                               "multiplier": v["multiplier"], "profile": v["profile"]}
                              for k, v in DEMAND_SCENARIOS.items()],
                "vehicle_classes": sorted(PCE),
                "pce": PCE,
            })
        elif path.startswith("/api/"):
            self._json(404, {"error": "unknown endpoint", "path": path})
        else:
            self._serve_static(path)

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self) -> None:
        global LAST, LAST_NETWORK
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/simulate":
                cfg = self._read_json()
                key = _cache_key(path, cfg)
                result = cache_get(key) or disk_get(key)
                if result is None:
                    result = run_scenario(cfg)
                    disk_put(key, result)
                cache_put(key, result)
                LAST = result
                self._json(200, result)
            elif path == "/api/simulate_network":
                body = self._read_json()
                region = body.pop("region", None)
                if not region:
                    raise ValueError("'region' is required (see /api/regions)")
                key = _cache_key(path + "|" + str(region), body)
                result = cache_get(key) or disk_get(key)
                if result is None:
                    result = run_region(region, body)
                    disk_put(key, result)
                cache_put(key, result)
                LAST_NETWORK = result
                self._json(200, result)
            elif path == "/api/regions_add":
                body = self._read_json()
                info = add_region(
                    query=body.get("query"), bbox=body.get("bbox"),
                    name=body.get("name"),
                    span_deg=float(body.get("span_deg") or 0.015),
                    region_id=body.get("region_id"))
                self._json(200, {"region": info, "regions": list_regions()})
            elif path == "/api/explain":
                body = self._read_json()
                question = (body.get("question") or "Explain the controller's behaviour.").strip()
                # The network page sends its on-screen result as context;
                # junction flows keep using the server-side LAST run.
                sent = body.get("result")
                ctx = sent if isinstance(sent, dict) and sent.get("summary") \
                    else (LAST or run_scenario({}))
                self._json(200, featherless_explain(ctx, question))
            elif path == "/api/agent":
                body = self._read_json()
                hint, last = _agent_context(body.get("context"))
                result = run_agent(body.get("question"),
                                   max_rounds=body.get("max_rounds", 3),
                                   mode=body.get("mode", "solo"),
                                   last_result=last,
                                   context_hint=hint)
                self._json(200, result)
            elif path == "/api/tts":
                body = self._read_json()
                text = (body.get("text") or "").strip()
                if not text:
                    self._json(400, {"error": "empty text"})
                    return
                if not elevenlabs_available():
                    self._json(501, {
                        "error": "ElevenLabs API key not configured",
                        "hint": "Set ELEVENLABS_API_KEY in .env and restart the server.",
                    })
                    return
                audio, ctype = elevenlabs_tts(text)
                self._send(200, audio, ctype)
            else:
                self._json(404, {"error": "unknown endpoint", "path": path})
        except RuntimeError as e:  # e.g. missing key
            self._json(501, {"error": str(e)})
        except ValueError as e:  # invalid client input
            self._json(400, {"error": str(e)})
        except Exception as e:  # keep the demo alive
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("  %s\n" % (fmt % args))


def main() -> None:
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"SignalFlow {__version__}  ->  http://{HOST}:{PORT}")
    print(f"  Featherless: {'connected' if featherless_available() else 'offline fallback'}")
    print(f"  ElevenLabs : {'connected' if elevenlabs_available() else 'offline (no voice)'}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
        srv.shutdown()


if __name__ == "__main__":
    main()
