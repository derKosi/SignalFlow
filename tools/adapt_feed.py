#!/usr/bin/env python3
"""CLI: adapt a third-party sensor CSV into SignalFlow's feed format.

    python3 tools/adapt_feed.py IN.csv --out data/adapted.csv
    python3 tools/adapt_feed.py --make-example data/example_sensor_generic.csv
    python3 -m signalflow.feed_adapter IN.csv --json
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from signalflow.feed_adapter import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
