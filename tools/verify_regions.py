#!/usr/bin/env python3
"""Validate data/regions/*.json and print a per-region summary table.

Checks
------
* every file parses as JSON and has the required top-level keys;
* node ids are unique; link ids are unique;
* every link's ``from`` and ``to`` reference an existing node id;
* recompute ``deg`` from links and compare with the stored value;
* bbox / count sanity.

Prints: region, nodes, links, signals, junctions, max degree, avg link length.
Exit code is non-zero if any hard check fails.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
REGION_DIR = PROJECT_ROOT / "data" / "regions"

REQUIRED_TOP = {"region", "name", "bbox", "nodes", "links", "stats"}


def check(region: dict) -> list[str]:
    errs: list[str] = []
    rid = region.get("region", "?")

    missing = REQUIRED_TOP - set(region)
    if missing:
        errs.append(f"{rid}: missing keys {sorted(missing)}")
        return errs

    nodes = region["nodes"]
    links = region["links"]

    node_ids = [n["id"] for n in nodes]
    if len(node_ids) != len(set(node_ids)):
        errs.append(f"{rid}: duplicate node ids")
    idset = set(node_ids)

    link_ids = [l["id"] for l in links]
    if len(link_ids) != len(set(link_ids)):
        errs.append(f"{rid}: duplicate link ids")

    for l in links:
        if l["from"] not in idset or l["to"] not in idset:
            errs.append(f"{rid}: link {l['id']} references missing node "
                        f"({l['from']}->{l['to']})")
            break
        if l["from"] == l["to"]:
            errs.append(f"{rid}: link {l['id']} is a self-loop")
            break
        if l["length_m"] <= 0:
            errs.append(f"{rid}: link {l['id']} has non-positive length")
            break

    # recompute degree (distinct neighbours) and compare
    neigh = {nid: set() for nid in idset}
    for l in links:
        neigh[l["from"]].add(l["to"])
        neigh[l["to"]].add(l["from"])
    stored = {n["id"]: n["deg"] for n in nodes}
    for nid in idset:
        if len(neigh[nid]) != stored[nid]:
            errs.append(f"{rid}: node {nid} deg mismatch "
                        f"(stored {stored[nid]}, recomputed {len(neigh[nid])})")
            break

    st = region["stats"]
    if st["nodes"] != len(nodes):
        errs.append(f"{rid}: stats.nodes {st['nodes']} != {len(nodes)}")
    if st["links"] != len(links):
        errs.append(f"{rid}: stats.links {st['links']} != {len(links)}")
    if st["signals"] != sum(1 for n in nodes if n["signal"]):
        errs.append(f"{rid}: stats.signals mismatch")
    if st["junctions"] != sum(1 for n in nodes if n["deg"] >= 4):
        errs.append(f"{rid}: stats.junctions mismatch")

    return errs


def main() -> int:
    files = sorted(REGION_DIR.glob("*.json"))
    if not files:
        raise SystemExit(f"no region files in {REGION_DIR} — run tools/build_regions.py")

    header = ("region", "nodes", "links", "signals", "junctions", "max_deg", "avg_link_m")
    rows = []
    all_errs: list[str] = []
    for path in files:
        region = json.loads(path.read_text(encoding="utf-8"))
        all_errs += check(region)
        nodes, links = region["nodes"], region["links"]
        max_deg = max((n["deg"] for n in nodes), default=0)
        avg_len = (sum(l["length_m"] for l in links) / len(links)) if links else 0.0
        rows.append((region["region"], len(nodes), len(links),
                     sum(1 for n in nodes if n["signal"]),
                     sum(1 for n in nodes if n["deg"] >= 4),
                     max_deg, round(avg_len, 1)))

    widths = [max(len(str(r[i])) for r in [header] + rows) for i in range(len(header))]
    def fmt(r):  # noqa: E306
        return "  ".join(str(v).rjust(widths[i]) for i, v in enumerate(r))
    print(fmt(header))
    print("  ".join("-" * w for w in widths))
    for r in rows:
        print(fmt(r))

    print()
    if all_errs:
        print(f"FAILED — {len(all_errs)} problem(s):")
        for e in all_errs:
            print("  -", e)
        return 1
    print(f"OK — all {len(rows)} region file(s) valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
