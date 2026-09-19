"""Add a new region on the fly — geocode a place name, fetch OSM, build the graph.

Enables the live-demo flow "type a city / landmark and it appears in the region
selector". Reuses the existing pipeline (``tools/fetch_osm.py`` +
``tools/build_regions.py``) and Nominatim for geocoding.

Network is required (Nominatim + Overpass). Everything is stdlib only.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TOOLS = PROJECT_ROOT / "tools"
REGIONS_DIR = PROJECT_ROOT / "data" / "regions"

if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import build_regions  # noqa: E402
import fetch_osm  # noqa: E402

USER_AGENT = "SignalFlow/0.1 (hackathon; live region add)"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
MAX_SPAN_DEG = 0.05          # ~5 km half-span — keep Overpass responses sane
DEFAULT_SPAN_DEG = 0.015     # ~1.7 km half-span


def slugify(name: str, limit: int = 40) -> str:
    s = (name or "").lower()
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        s = s.replace(a, b)
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return (s or "region")[:limit]


def geocode(query: str) -> dict:
    """Resolve a free-text place to lat/lon + display name via Nominatim."""
    q = (query or "").strip()
    if not q:
        raise ValueError("query must not be empty")
    url = NOMINATIM + "?" + urllib.parse.urlencode(
        {"format": "json", "limit": 1, "q": q})
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                               "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        raise ValueError(f"geocoding failed: {type(e).__name__}") from e
    if not data:
        raise ValueError(f"place not found: {q!r}")
    hit = data[0]
    return {"lat": float(hit["lat"]), "lon": float(hit["lon"]),
            "display_name": hit.get("display_name", q)}


def bbox_from_point(lat: float, lon: float, span: float) -> list[float]:
    """(south, west, north, east) box of ±span degrees around a point."""
    span = max(0.004, min(MAX_SPAN_DEG, float(span)))
    return [round(lat - span, 6), round(lon - span, 6),
            round(lat + span, 6), round(lon + span, 6)]


def unique_region_id(base: str) -> str:
    rid, i = base, 2
    while (REGIONS_DIR / f"{rid}.json").exists():
        rid = f"{base}_{i}"
        i += 1
    return rid


def add_region(query: str | None = None, bbox: list | None = None,
               name: str | None = None, span_deg: float = DEFAULT_SPAN_DEG,
               region_id: str | None = None) -> dict:
    """Geocode/fetch/build a new region and persist it to data/regions/.

    Returns the new region's metadata (same shape as ``/api/regions`` entries).
    """
    geocoded = None
    if bbox is None:
        if not query:
            raise ValueError("provide 'query' or 'bbox'")
        geocoded = geocode(query)
        bbox = bbox_from_point(geocoded["lat"], geocoded["lon"], span_deg)
    if not (isinstance(bbox, (list, tuple)) and len(bbox) == 4):
        raise ValueError("bbox must be [south, west, north, east]")
    s, w, n, e = (float(x) for x in bbox)
    if not (-90 <= s < n <= 90 and -180 <= w < e <= 180):
        raise ValueError("invalid bbox ordering/range")
    if (n - s) > 2 * MAX_SPAN_DEG or (e - w) > 2 * MAX_SPAN_DEG:
        raise ValueError(f"bbox too large (max ±{MAX_SPAN_DEG}°)")

    label = name or (geocoded["display_name"].split(",")[0].strip() if geocoded
                     else "Custom region")
    rid = unique_region_id(region_id or slugify(label))

    query_str = fetch_osm.build_query(tuple(bbox), fetch_osm.ARTERIAL_RE)
    payload, mirror = fetch_osm.fetch(query_str, attempts=3)
    elements = payload.get("elements", [])
    if not elements:
        raise ValueError("Overpass returned no road data for this area")

    raw = {"region": rid, "name": label, "bbox": list(bbox),
           "source": mirror, "elements": elements}
    region = build_regions.build_region(raw)
    REGIONS_DIR.mkdir(parents=True, exist_ok=True)
    (REGIONS_DIR / f"{rid}.json").write_text(
        json.dumps(region, ensure_ascii=False), encoding="utf-8")

    return {"id": rid, "name": label, "bbox": list(bbox),
            "stats": region.get("stats", {}), "source": mirror,
            "geocoded_as": geocoded["display_name"] if geocoded else None}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Add a SignalFlow region live")
    ap.add_argument("query", help="place name, e.g. 'Tübingen Zentrum'")
    ap.add_argument("--span", type=float, default=DEFAULT_SPAN_DEG)
    a = ap.parse_args()
    print(json.dumps(add_region(a.query, span_deg=a.span), indent=2, ensure_ascii=False))
