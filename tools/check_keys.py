#!/usr/bin/env python3
"""Live-check the sponsor keys (Featherless, ElevenLabs) without echoing secrets.

    python3 tools/check_keys.py           # human-readable
    python3 tools/check_keys.py --json    # machine-readable

Reads .env / environment. Never prints the key itself.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from signalflow.integrations import (  # noqa: E402
    featherless_probe, elevenlabs_probe, featherless_available, elevenlabs_available,
)


def main() -> int:
    fl = featherless_probe()
    el = elevenlabs_probe()
    if "--json" in sys.argv:
        print(json.dumps({"featherless": fl, "elevenlabs": el}, indent=2))
        return 0
    print("SignalFlow key check")
    print(f"  Featherless  configured={featherless_available()}  {fl}")
    print(f"  ElevenLabs   configured={elevenlabs_available()}  {el}")
    ok = (fl.get("ok") or not fl.get("configured")) and (el.get("ok") or not el.get("configured"))
    print("  verdict      " + ("OK" if ok else "CHECK (see errors above)"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
