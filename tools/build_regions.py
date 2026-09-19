#!/usr/bin/env python3
"""Convert raw Overpass dumps into clean SignalFlow region graphs.

Input  : data/osm/<id>.json   ({"region","bbox","elements":[...]})
Output : data/regions/<id>.json with this schema

    {
      "region": "<id>", "name": "<display name>", "bbox": [s,w,n,e],
      "nodes": [{"id","lat","lon","deg","signal"}, ...],
      "links": [{"id","from","to","length_m","lanes","speed_kph",
                 "oneway","name","hw"}, ...],
      "stats": {"nodes","links","signals","junctions"}
    }

Graph definition
----------------
* A **graph node** is an OSM node id that either
    - occurs in >= 2 ways (a shared vertex), or
    - is a way endpoint, or
    - lies within <= 15 m of a ``highway=traffic_signals`` node.
* An **edge/link** connects two consecutive graph nodes along one way; its
  ``length_m`` is the Haversine sum over the intermediate geometry points.
* ``deg``  = number of distinct adjacent graph nodes (undirected degree).
* ``signal`` = a signal node is within <= 15 m  OR  deg >= 4.
* ``junctions`` = graph nodes with deg >= 4.

Stdlib only (json, math, re).
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OSM_DIR = PROJECT_ROOT / "data" / "osm"
OUT_DIR = PROJECT_ROOT / "data" / "regions"

SIGNAL_RADIUS_M = 15.0

# Class defaults -------------------------------------------------------------
LANES_DEFAULT = {
    "motorway": 3, "trunk": 3,
    "primary": 2, "secondary": 2, "tertiary": 1,
    "residential": 1, "unclassified": 1, "living_street": 1,
    "motorway_link": 1, "trunk_link": 1, "primary_link": 1,
    "secondary_link": 1, "tertiary_link": 1,
}
SPEED_DEFAULT = {
    "motorway": 120, "trunk": 100,
    "primary": 50, "secondary": 50, "tertiary": 50,
    "residential": 30, "unclassified": 30, "living_street": 10,
    "motorway_link": 40, "trunk_link": 40, "primary_link": 40,
    "secondary_link": 40, "tertiary_link": 40,
}
ONEWAY_TRUE = {"yes", "true", "1", "-1"}

_EARTH_R = 6371008.8  # mean Earth radius, metres


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * _EARTH_R * math.asin(min(1.0, math.sqrt(a)))


# Tag parsing ----------------------------------------------------------------
_NUM_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*$")
_KMH_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*km/?h\s*$", re.IGNORECASE)


def parse_lanes(tags: dict) -> int:
    raw = (tags.get("lanes") or "").strip()
    if raw:
        first = raw.split(";")[0].strip()
        try:
            return max(1, int(float(first)))
        except ValueError:
            pass
    return int(LANES_DEFAULT.get(tags.get("highway", ""), 1))


def parse_speed(tags: dict) -> int:
    raw = (tags.get("maxspeed") or "").strip()
    if raw:
        low = raw.lower()
        if low in ("walk", "walking"):
            return 10
        m = _NUM_RE.match(raw) or _KMH_RE.match(raw)
        if m:
            try:
                v = int(round(float(m.group(1))))
                if v > 0:
                    return v
            except ValueError:
                pass
    return int(SPEED_DEFAULT.get(tags.get("highway", ""), 50))


def is_oneway(tags: dict) -> tuple[bool, bool]:
    """Return (oneway, reverse_only)."""
    ow = (tags.get("oneway") or "").strip().lower()
    hw = tags.get("highway", "")
    if ow == "-1":
        return True, True
    if ow in ONEWAY_TRUE or tags.get("junction") == "roundabout" or hw == "motorway":
        return True, False
    return False, False


# Geometry helpers -----------------------------------------------------------
def way_points(el: dict) -> list[tuple]:
    """Return ordered (key, lat, lon) for a way element.

    Prefers real OSM node ids (``nodes`` + ``geometry`` are aligned); falls back
    to rounded coordinates if node ids are absent.
    """
    geom = el.get("geometry") or []
    ids = el.get("nodes") or []
    pts = []
    if ids and len(ids) == len(geom):
        for nid, g in zip(ids, geom):
            pts.append((("n", int(nid)), float(g["lat"]), float(g["lon"])))
    else:
        for g in geom:
            lat, lon = float(g["lat"]), float(g["lon"])
            pts.append((("c", round(lat, 7), round(lon, 7)), lat, lon))
    return pts


class SignalIndex:
    """Tiny lat/lon grid for 'is there a signal within R metres of P?'."""

    CELL = 0.0005  # ~ 55 m in latitude

    def __init__(self, signals: list[tuple[float, float]], radius_m: float):
        self.radius = radius_m
        self.by_cell: dict[tuple[int, int], list[tuple[float, float]]] = {}
        for lat, lon in signals:
            self.by_cell.setdefault(self._cell(lat, lon), []).append((lat, lon))

    def _cell(self, lat: float, lon: float) -> tuple[int, int]:
        return (math.floor(lat / self.CELL), math.floor(lon / self.CELL))

    def near(self, lat: float, lon: float) -> bool:
        ci, cj = self._cell(lat, lon)
        span = math.ceil(self.radius / (self.CELL * 111_320.0)) + 1
        for di in range(-span, span + 1):
            for dj in range(-span, span + 1):
                for slat, slon in self.by_cell.get((ci + di, cj + dj), ()):  # noqa: E501
                    if haversine(lat, lon, slat, slon) <= self.radius:
                        return True
        return False


def build_region(raw: dict) -> dict:
    rid = raw["region"]
    name = raw.get("name", rid)
    bbox = raw.get("bbox", [None, None, None, None])
    elements = raw.get("elements", [])

    ways = [e for e in elements if e.get("type") == "way" and e.get("geometry")]
    signals = [(float(e["lat"]), float(e["lon"]))
               for e in elements
               if e.get("type") == "node"
               and (e.get("tags") or {}).get("highway") == "traffic_signals"]
    signal_index = SignalIndex(signals, SIGNAL_RADIUS_M)

    # --- pass 1: way counts + endpoints ------------------------------------
    way_points_cache: dict[int, list[tuple]] = {}
    node_way_count: dict[tuple, set] = {}
    endpoints: set[tuple] = set()
    coords: dict[tuple, tuple[float, float]] = {}

    for el in ways:
        pts = way_points(el)
        if len(pts) < 2:
            continue
        way_points_cache[el["id"]] = pts
        for key, lat, lon in pts:
            coords[key] = (lat, lon)
            node_way_count.setdefault(key, set()).add(el["id"])
        endpoints.add(pts[0][0])
        endpoints.add(pts[-1][0])

    # --- graph node set -----------------------------------------------------
    graph_keys: set[tuple] = {
        k for k, ws in node_way_count.items() if len(ws) >= 2 or k in endpoints
    }
    # promote coordinates that sit on a signal to graph nodes
    for key, (lat, lon) in coords.items():
        if key in graph_keys:
            continue
        if signal_index.near(lat, lon):
            graph_keys.add(key)

    nodes: dict[tuple, dict] = {}
    for key in graph_keys:
        lat, lon = coords[key]
        nodes[key] = {
            "id": key[1] if key[0] == "n" else _synth_id(key),
            "lat": lat,
            "lon": lon,
            "deg": 0,
            "signal": False,
        }

    # --- pass 2: split ways into links -------------------------------------
    links: list[dict] = []
    next_link_id = 1
    for el in ways:
        pts = way_points_cache.get(el["id"])
        if not pts:
            continue
        tags = el.get("tags") or {}
        hw = tags.get("highway", "")
        lanes = parse_lanes(tags)
        speed = parse_speed(tags)
        ow, rev_only = is_oneway(tags)
        nm = tags.get("name") or None

        idxs = [i for i, (key, _, _) in enumerate(pts) if key in nodes]
        for a, b in zip(idxs, idxs[1:]):
            if b <= a:
                continue
            seg = pts[a:b + 1]
            length = sum(
                haversine(seg[k][1], seg[k][2], seg[k + 1][1], seg[k + 1][2])
                for k in range(len(seg) - 1)
            )
            from_key, to_key = pts[a][0], pts[b][0]
            if from_key == to_key:
                continue
            base = {
                "length_m": round(length, 2),
                "lanes": lanes,
                "speed_kph": speed,
                "name": nm,
                "hw": hw,
            }
            if rev_only:
                links.append({"id": next_link_id, "from": nodes[to_key]["id"],
                              "to": nodes[from_key]["id"], "oneway": True, **base})
                next_link_id += 1
            elif ow:
                links.append({"id": next_link_id, "from": nodes[from_key]["id"],
                              "to": nodes[to_key]["id"], "oneway": True, **base})
                next_link_id += 1
            else:
                links.append({"id": next_link_id, "from": nodes[from_key]["id"],
                              "to": nodes[to_key]["id"], "oneway": False, **base})
                next_link_id += 1
                links.append({"id": next_link_id, "from": nodes[to_key]["id"],
                              "to": nodes[from_key]["id"], "oneway": False, **base})
                next_link_id += 1

    # --- pass 3: degree + signal flags -------------------------------------
    # ``deg`` = number of DISTINCT adjacent graph nodes (undirected degree).
    # Rationale: the spec pairs ``deg >= 4`` with "junction"/"signal", and that
    # threshold only carries meaning if a plain mid-block node on a two-way
    # street counts 2 and a real 4-way crossing counts 4. Counting *directed*
    # links would double every two-way segment and make every mid-block node hit
    # 4, which would defeat the purpose. Reverse links are still emitted in the
    # ``links`` list exactly as required.
    by_id = {nd["id"]: nd for nd in nodes.values()}
    neighbours: dict[int, set] = {nid: set() for nid in by_id}
    for lk in links:
        neighbours[lk["from"]].add(lk["to"])
        neighbours[lk["to"]].add(lk["from"])
    for nid, nd in by_id.items():
        nd["deg"] = len(neighbours[nid])

    for key, nd in nodes.items():
        lat, lon = nd["lat"], nd["lon"]
        nd["signal"] = bool(nd["deg"] >= 4 or signal_index.near(lat, lon))

    node_list = sorted(nodes.values(), key=lambda n: n["id"])
    links.sort(key=lambda l: l["id"])

    stats = {
        "nodes": len(node_list),
        "links": len(links),
        "signals": sum(1 for n in node_list if n["signal"]),
        "junctions": sum(1 for n in node_list if n["deg"] >= 4),
    }
    return {
        "region": rid,
        "name": name,
        "bbox": list(bbox),
        "nodes": node_list,
        "links": links,
        "stats": stats,
        # ODbL: the credit travels with the database, not only with the repo docs
        "licence": "ODbL 1.0",
        "attribution": "© OpenStreetMap contributors",
    }


_synth_counter = [0]
_synth_map: dict[tuple, int] = {}


def _synth_id(key: tuple) -> int:
    """Synthetic negative id for fallback (coordinate-keyed) nodes."""
    if key not in _synth_map:
        _synth_counter[0] += 1
        _synth_map[key] = -_synth_counter[0]
    return _synth_map[key]


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(OSM_DIR.glob("*.json"))
    if not files:
        raise SystemExit(f"no raw dumps in {OSM_DIR} — run tools/fetch_osm.py first")
    for path in files:
        raw = json.loads(path.read_text(encoding="utf-8"))
        region = build_region(raw)
        dest = OUT_DIR / f"{region['region']}.json"
        dest.write_text(json.dumps(region, ensure_ascii=False), encoding="utf-8")
        st = region["stats"]
        print(f"[build] {region['region']:12s} -> {dest}")
        print(f"        nodes={st['nodes']} links={st['links']} "
              f"signals={st['signals']} junctions={st['junctions']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
