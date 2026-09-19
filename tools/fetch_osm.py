#!/usr/bin/env python3
"""Fetch real OpenStreetMap road + traffic-signal data for Munich regions.

Stdlib only (urllib, json, time). Queries the Overpass API for:

  * highway ways of the relevant classes (with geometry), and
  * traffic_signal nodes,

for each configured region and stores the raw result to ``data/osm/<id>.json``.

Mirror policy: try the primary mirror, fall back to the secondary, retry with
exponential backoff.  overpass-api.de is intentionally NOT used (returns 406).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data" / "osm"

USER_AGENT = "SignalFlow/0.1 (hackathon)"

MIRRORS = [
    "https://z.overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
]

HIGHWAY_RE = (
    "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|"
    "living_street|motorway_link|trunk_link|primary_link|secondary_link|"
    "tertiary_link)$"
)

# arterial-focused classes (keeps large inner-city extracts tractable and is the
# realistic scope for signal coordination work)
ARTERIAL_RE = (
    "^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|"
    "primary_link|secondary_link|tertiary_link)$"
)

# region id -> (display name, bbox=(south, west, north, east)[, highway regex])
REGIONS = {
    "expo_riem": ("Messe München / ICM Riem", (48.1280, 11.6830, 48.1440, 11.7080)),
    "innenstadt": ("München Innenstadt / Altstadtring", (48.1280, 11.5450, 48.1500, 11.5900)),
    # other German cities (arterial scope) + a university city
    "berlin_mitte": ("Berlin Mitte / Alexanderplatz", (52.5120, 13.3850, 52.5290, 13.4130), ARTERIAL_RE),
    "hamburg_innenstadt": ("Hamburg Innenstadt / Jungfernstieg", (53.5440, 9.9820, 53.5610, 10.0120), ARTERIAL_RE),
    "koeln_innenstadt": ("Köln Innenstadt / Dom & Deutz", (50.9280, 6.9440, 50.9460, 6.9820), ARTERIAL_RE),
    "heidelberg_uni": ("Heidelberg Altstadt / Universität", (49.4040, 8.6780, 49.4210, 8.7180), ARTERIAL_RE),
}


def build_query(bbox: tuple[float, float, float, float], regex: str = HIGHWAY_RE) -> str:
    s, w, n, e = bbox
    bb = f"{s},{w},{n},{e}"
    return (
        "[out:json][timeout:120];"
        "("
        f'way["highway"~"{regex}"]({bb});'
        'node["highway"="traffic_signals"](' + bb + ");"
        ");"
        "out geom;"
    )


def _post(mirror: str, query: str, timeout: int = 180) -> dict:
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    req = urllib.request.Request(
        mirror,
        data=data,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw.decode("utf-8"))


def fetch(query: str, attempts: int = 6) -> tuple[dict, str]:
    """Return (payload, mirror_used).

    Strategy: each attempt queries every mirror and keeps the *richest* response
    (most ``elements``). This is robust to two real-world quirks observed here:

    * ``overpass.osm.ch`` is a Switzerland-only extract, so it answers *200 OK*
      with an **empty** element list for Munich (it silently yields nothing);
    * ``maps.mail.ru`` covers all of OSM but intermittently returns 504.

    Retries with exponential backoff until a non-empty response is obtained or
    the attempt budget is exhausted (in which case an empty result is accepted).
    """
    last_empty: dict = {"elements": []}
    last_empty_mirror = MIRRORS[0]
    last_err: Exception | None = None
    for attempt in range(attempts):
        best: dict | None = None
        best_mirror: str | None = None
        for mirror in MIRRORS:
            try:
                payload = _post(mirror, query)
                if "elements" not in payload:
                    raise ValueError("overpass response missing 'elements'")
                n = len(payload["elements"])
                if best is None or n > len(best.get("elements", [])):
                    best, best_mirror = payload, mirror
            except (urllib.error.URLError, urllib.error.HTTPError, ValueError,
                    TimeoutError, json.JSONDecodeError, OSError) as exc:
                last_err = exc
                sys.stderr.write(f"  ! {mirror} attempt {attempt + 1} failed: {exc!r}\n")
        if best is not None and best.get("elements"):
            return best, best_mirror
        if best is not None:
            last_empty, last_empty_mirror = best, best_mirror
        if attempt < attempts - 1:
            backoff = min(2 ** attempt, 20)
            sys.stderr.write(f"  ... empty/slow; backing off {backoff}s "
                             f"(attempt {attempt + 1}/{attempts})\n")
            time.sleep(backoff)
    if last_err is not None:
        sys.stderr.write(f"  ! exhausted retries; last error {last_err!r}\n")
    return last_empty, last_empty_mirror


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    want = set(sys.argv[1:]) or None       # optional: only fetch selected region ids
    fallback_used = False
    summary = []
    for rid, entry in REGIONS.items():
        if want and rid not in want:
            continue
        name, bbox = entry[0], entry[1]
        regex = entry[2] if len(entry) > 2 else HIGHWAY_RE
        query = build_query(bbox, regex)
        print(f"[fetch] {rid}  bbox={bbox}")
        payload, mirror = fetch(query)
        if mirror != MIRRORS[0]:
            fallback_used = True

        out = {
            "region": rid,
            "name": name,
            "bbox": list(bbox),
            "source": mirror,
            "query": query,
            "elements": payload.get("elements", []),
        }
        dest = DATA_DIR / f"{rid}.json"
        dest.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")

        ways = sum(1 for el in out["elements"] if el.get("type") == "way")
        signals = sum(
            1 for el in out["elements"]
            if el.get("type") == "node" and el.get("tags", {}).get("highway") == "traffic_signals"
        )
        print(f"        -> {dest}  ({ways} ways, {signals} signals)  via {mirror}")
        summary.append((rid, ways, signals, str(dest)))

    print("\n[fetch] done.")
    for rid, ways, signals, dest in summary:
        print(f"  {rid:12s} ways={ways:5d} signals={signals:4d}  {dest}")
    print(f"[fetch] fallback mirror used: {fallback_used}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
