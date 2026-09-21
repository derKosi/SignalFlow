#!/usr/bin/env python3
"""Build the Hackatron expo-district region from the official sample CSV.

The official sample (munichtechexpo.com, Smart Cities challenge) provides 6
fictional expo-district intersections with coordinates, per-approach lane
counts, signal timings and 15-minute vehicle counts — but no link topology.
This tool derives a defensible network from that data:

* nodes: the 6 intersections at their real sample coordinates, all signalised;
* topology: nearest-neighbour ring around the district centroid (the natural
  order of the 6 points) plus the two shortest chords through the expo block —
  DECLARED ASSUMPTION, the sample names no edges;
* lanes: per directed link, the lane_count of the from-intersection's approach
  pointing toward the neighbour (dominant compass axis);
* gateways: one stub node per intersection just outside the bbox so demand can
  enter/leave the district (same pattern as the OSM extracts, where boundary
  links are cut at the bbox);
* calibration: total network vph is measured from the sample counts for the
  requested windows (vehicles at all approaches / window hours).

Usage:
    python3 tools/build_expo_region.py PATH_TO_CSV [--out data/regions/expo_hackatron.json]
                                        [--window DAY,HH:MM,HH:MM ...] [--json]
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DEFAULT = ROOT / "data" / "regions" / "expo_hackatron.json"
WINDOWS_DEFAULT = ["2026-09-14,07:00,09:00", "2026-09-14,11:00,13:00",
                   "2026-09-14,16:00,18:00"]

STUB_LEN_M = 120.0          # gateway stub length (assumed, like a cut approach)
STUB_OFFSET_DEG = 0.0045    # ~500 m outside the bbox
OPPOSITE = {"N": "S", "E": "W", "S": "N", "W": "E"}


def haversine(a, b) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a["lat"]), math.radians(b["lat"])
    dp = math.radians(b["lat"] - a["lat"])
    dl = math.radians(b["lon"] - a["lon"])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def bearing_axis(a, b) -> str:
    """Dominant compass direction from a to b (N/E/S/W)."""
    dlat = b["lat"] - a["lat"]
    dlon = (b["lon"] - a["lon"]) * math.cos(math.radians(a["lat"]))
    if abs(dlat) >= abs(dlon):
        return "N" if dlat >= 0 else "S"
    return "E" if dlon >= 0 else "W"


def load_sample(path: Path) -> dict:
    rows = list(csv.DictReader(path.open(encoding="utf-8")))
    if not rows:
        raise ValueError(f"no data rows in {path}")
    ints: dict[str, dict] = {}
    for r in rows:
        iid = r["intersection_id"]
        d = ints.setdefault(iid, {
            "name": r["intersection_name"], "lat": float(r["lat"]),
            "lon": float(r["lon"]), "lanes": {}, "green": defaultdict(list),
            "red": defaultdict(list)})
        d["lanes"][r["approach"]] = int(r["lane_count"])
        d["green"][r["approach"]].append(int(r["signal_phase_sec_green"]))
        d["red"][r["approach"]].append(int(r["signal_phase_sec_red"]))
    return {"ints": ints, "rows": rows}


def ring_order(ints: dict) -> list[str]:
    """Angular order around the district centroid (= walkable ring)."""
    lat = sum(d["lat"] for d in ints.values()) / len(ints)
    lon = sum(d["lon"] for d in ints.values()) / len(ints)

    def angle(iid):
        d = ints[iid]
        return math.atan2(d["lon"] - lon, d["lat"] - lat)
    return sorted(ints, key=angle)


def count_window(rows, day: str, t_from: str, t_to: str) -> int:
    return sum(int(r["vehicle_count_15min"]) for r in rows
               if r["timestamp_utc"].startswith(day)
               and t_from <= r["timestamp_utc"][11:16] < t_to)


def build(csv_path: Path, windows: list[str]) -> tuple[dict, dict]:
    sample = load_sample(csv_path)
    ints, rows = sample["ints"], sample["rows"]
    ring = ring_order(ints)

    # chords: shortest non-ring pairs inside the expo quad (crossing the block)
    quad = [i for i in ring if i.startswith("INT-EXPO")]
    ring_pairs = {frozenset((ring[i], ring[(i + 1) % len(ring)])) for i in range(len(ring))}
    chords = [(quad[i], quad[j]) for i in range(len(quad)) for j in range(i + 1, len(quad))
              if frozenset((quad[i], quad[j])) not in ring_pairs]
    chords = sorted(chords, key=lambda p: haversine(ints[p[0]], ints[p[1]]))[:2]

    nodes: list[dict] = []
    id_of: dict[str, int] = {}
    for iid in ring:
        id_of[iid] = 100 + len(nodes)
        nodes.append({"id": id_of[iid], "lat": ints[iid]["lat"],
                      "lon": ints[iid]["lon"], "deg": 0, "signal": True})

    edges = [(ring[i], ring[(i + 1) % len(ring)]) for i in range(len(ring))] + chords
    links: list[dict] = []
    lid = 0

    def add_dir(a_iid: str, b_iid: str, a_pos: int, b_pos: int, length: float,
                lanes: int, name: str) -> None:
        nonlocal lid
        links.append({"id": lid, "from": a_pos, "to": b_pos, "oneway": False,
                      "length_m": round(length, 1), "lanes": max(1, lanes),
                      "speed_kph": 50, "name": name, "hw": "secondary"})
        lid += 1

    # interior edges: lanes from the from-intersection's approach toward target
    for a, b in edges:
        ia, ib = ints[a], ints[b]
        d = haversine(ia, ib)
        nm = f"{a.replace('INT-', '')}-{b.replace('INT-', '')}"
        add_dir(a, b, id_of[a], id_of[b], d,
                ia["lanes"].get(bearing_axis(ia, ib), 1), nm)
        add_dir(b, a, id_of[b], id_of[a], d,
                ib["lanes"].get(bearing_axis(ib, ia), 1), nm)

    # gateway stubs: outbound lanes = intersection's outward approach,
    # inbound lanes = the approach facing the incoming direction
    clat = sum(d["lat"] for d in ints.values()) / len(ints)
    clon = sum(d["lon"] for d in ints.values()) / len(ints)
    centre = {"lat": clat, "lon": clon}
    for iid in ring:
        d = ints[iid]
        out_axis = bearing_axis(centre, d)           # centroid -> intersection
        off = {"N": (STUB_OFFSET_DEG, 0.0), "E": (0.0, STUB_OFFSET_DEG),
               "S": (-STUB_OFFSET_DEG, 0.0), "W": (0.0, -STUB_OFFSET_DEG)}[out_axis]
        stub_pos = len(nodes)
        stub_id = 200 + stub_pos
        nodes.append({"id": stub_id, "lat": d["lat"] + off[0],
                      "lon": d["lon"] + off[1], "deg": 1, "signal": False})
        nm = f"Gateway {iid.replace('INT-', '')}"
        add_dir(iid, iid, id_of[iid], stub_id, STUB_LEN_M,
                d["lanes"].get(out_axis, 1), nm)                  # outbound
        add_dir(iid, iid, stub_id, id_of[iid], STUB_LEN_M,
                d["lanes"].get(OPPOSITE[out_axis], 1), nm)        # inbound

    # link endpoints reference node IDs (OSM convention); degree keyed by ID
    deg = Counter()
    for l in links:
        deg[l["from"]] += 1
        deg[l["to"]] += 1
    for n in nodes:
        n["deg"] = deg[n["id"]]

    lats = [d["lat"] for d in ints.values()]
    lons = [d["lon"] for d in ints.values()]
    bbox = [round(min(lats) - STUB_OFFSET_DEG, 4), round(min(lons) - STUB_OFFSET_DEG, 4),
            round(max(lats) + STUB_OFFSET_DEG, 4), round(max(lons) + STUB_OFFSET_DEG, 4)]

    greens = [g for d in ints.values() for v in d["green"].values() for g in v]
    reds = [g for d in ints.values() for v in d["red"].values() for g in v]
    cycle_s = round(sum(greens) / len(greens) + sum(reds) / len(reds))

    region = {
        "region": "expo_hackatron",
        "name": "Hackatron Expo-District (Offizielles Sample)",
        "bbox": bbox,
        "nodes": nodes,
        "links": links,
        "stats": {
            "nodes": len(nodes), "links": len(links), "signals": len(ints),
            "junctions": len(ints), "sample_cycle_s": cycle_s,
            "source": "MunichTech EXPO Autumn 2026 - Smart Cities sample feed "
                      "(synthetic/anonymized)",
            "source_short": "Offizielles Expo-Sample (synthetisch, anonymisiert)",
            "default_vph": 2500,
            "default_window": ["07:00", "09:00"],
            "default_scenario": "custom",
            "assumptions": [
                "Topologie: Nachbar-Ring um den Bezirks-Centroid + 2 kuerzeste "
                "Sehnen durchs Expo-Viereck (Sample nennt keine Kanten)",
                "Lanes je Richtung aus dem lane_count des jeweiligen Approach",
                "Gateway-Stubs ausserhalb des bbox (wie OSM-Extrakte)",
                "Turn-Split/OD-Prior wie im Netzwerk-Modell (Lanes-Gravity)",
            ],
        },
        "licence": "Sample (c) MunichTech EXPO 2026 - simulation/prototype use",
        "attribution": "MunichTech EXPO Smart Cities: Adaptive Traffic Flow "
                       "challenge sample dataset (synthetic, anonymized)",
        "links_meta": {
            "challenge": "https://munichtechexpo.com/hackathons/challenges/"
                         "smart-cities-traffic-flow-2026",
        },
    }

    calibration = {}
    for w in windows:
        day, t_from, t_to = w.split(",")
        veh = count_window(rows, day, t_from, t_to)
        hours = ((int(t_to[:2]) * 60 + int(t_to[3:])) -
                 (int(t_from[:2]) * 60 + int(t_from[3:]))) / 60.0
        calibration[w] = {"vehicles": veh, "total_vph": round(veh / hours)}
    return region, calibration


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Build the expo_hackatron region from the official sample CSV")
    ap.add_argument("csv", type=Path, help="official sample CSV")
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    ap.add_argument("--window", action="append", default=None,
                    help="DAY,HH:MM,HH:MM calibration window (repeatable)")
    ap.add_argument("--json", action="store_true", help="JSON stats to stdout")
    args = ap.parse_args(argv)

    region, calib = build(args.csv, args.window or WINDOWS_DEFAULT)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(region, indent=1, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    sig = {"region": region["region"], "nodes": len(region["nodes"]),
           "links": len(region["links"]), "bbox": region["bbox"],
           "sample_cycle_s": region["stats"]["sample_cycle_s"],
           "calibration": calib, "out": str(args.out)}
    print(json.dumps(sig, indent=2, ensure_ascii=False) if args.json else sig)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
