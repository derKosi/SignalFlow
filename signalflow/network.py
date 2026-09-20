"""SignalFlow — district / neighbourhood scale simulation.

Builds a mesoscopic network model from an OpenStreetMap-derived region file
(see ``tools/build_regions.py``) and simulates it under two control policies:

* ``fixed``    — every signalised junction runs a fixed 60 s two-phase plan
* ``adaptive`` — max-pressure per junction (queue/lane + starvation bonus)

Model (honest scope): a *link-queue* approximation. Each directed link keeps a
free-flow travel bucket (vehicles in transit) and a stop-line queue that
discharges at saturation flow when green, limited by downstream storage
(spillback). Demand is loaded from a gravity-style entry→exit OD matrix routed
with Dijkstra shortest paths; per-link turning fractions split the flow.

Not a per-vehicle microsimulation — but network-wide, fast and deterministic.

Units: time = s (dt = 1); speed = m/s internally; flow = veh/h in config.
"""

from __future__ import annotations

import heapq
import json
import math
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from .simulation import DEMAND_SCENARIOS, PCE, profile_value, profile_at_clock, parse_hhmm

PROJECT_ROOT = Path(__file__).resolve().parent.parent
REGIONS_DIR = PROJECT_ROOT / "data" / "regions"

SAT_FLOW_VPH_LANE = 1800          # veh/h/lane at the stop line
VEH_LENGTH_M = 6.0                # jam spacing -> storage capacity
CO2_IDLE_G_PER_S = 1.15
MAX_OD = 24                       # gateways per direction kept for the OD matrix
STORAGE_OVERFLOW = 1.35           # soft cap on downstream storage (prevents cyclic deadlock)
# green-wave (corridor coordination) parameters
COORD_CYCLE_S = 100               # common cycle time on the corridor
COORD_MAIN_GREEN_S = 62           # main-axis green inside the cycle
COORD_PROGRESSION = 0.95          # design speed as a fraction of free-flow
CORRIDOR_BONUS = 6.0              # pressure bonus for the corridor (bus) axis under TSP
MAX_CORRIDORS = 3                 # number of arterial corridors to coordinate

DEFAULT_VPH = {"expo_riem": 3500, "innenstadt": 5000}


def _haversine(a_lat, a_lon, b_lat, b_lon) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = math.radians(b_lat - a_lat)
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


# ---------------------------------------------------------------------------
# Region loading
# ---------------------------------------------------------------------------

def list_regions() -> list[dict]:
    out = []
    if not REGIONS_DIR.is_dir():
        return out
    for p in sorted(REGIONS_DIR.glob("*.json")):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            out.append({"id": d["region"], "name": d.get("name", d["region"]),
                        "bbox": d.get("bbox"), "stats": d.get("stats", {})})
        except (ValueError, KeyError):
            continue
    return out


@dataclass
class Network:
    region: str
    name: str
    bbox: list
    nodes: list
    links: list
    node_idx: dict = field(default_factory=dict)
    link_idx: dict = field(default_factory=dict)


def load_network(region_id: str) -> Network:
    path = REGIONS_DIR / f"{region_id}.json"
    if not path.is_file():
        raise ValueError(f"unknown region '{region_id}' (expected {path.name})")
    d = json.loads(path.read_text(encoding="utf-8"))
    net = Network(region=d["region"], name=d.get("name", d["region"]),
                  bbox=d.get("bbox"), nodes=d["nodes"], links=d["links"])
    net.node_idx = {nd["id"]: i for i, nd in enumerate(net.nodes)}
    net.link_idx = {lk["id"]: i for i, lk in enumerate(net.links)}
    return net


# ---------------------------------------------------------------------------
# Compiled network (flat arrays)
# ---------------------------------------------------------------------------

class Compiled:
    def __init__(self, net: Network):
        self.net = net
        self.n_nodes = len(net.nodes)
        self.n_links = len(net.links)
        ni = net.node_idx
        self.frm = [ni.get(l["from"], -1) for l in net.links]
        self.to = [ni.get(l["to"], -1) for l in net.links]
        self.len_m = [float(l["length_m"]) for l in net.links]
        self.lanes = [max(1, int(l.get("lanes") or 1)) for l in net.links]
        self.speed = [max(5.0, float(l.get("speed_kph") or 30)) / 3.6 for l in net.links]
        self.tff = [max(1, int(round(self.len_m[i] / self.speed[i]))) for i in range(self.n_links)]
        self.cap = [max(1.0, self.len_m[i] / VEH_LENGTH_M * self.lanes[i]) for i in range(self.n_links)]
        self.discharge = [SAT_FLOW_VPH_LANE / 3600.0 * self.lanes[i] for i in range(self.n_links)]

        self.incoming: list[list[int]] = [[] for _ in range(self.n_nodes)]
        self.outgoing: list[list[int]] = [[] for _ in range(self.n_nodes)]
        for i in range(self.n_links):
            if self.frm[i] >= 0:
                self.outgoing[self.frm[i]].append(i)
            if self.to[i] >= 0:
                self.incoming[self.to[i]].append(i)

        # signalise junctions and split incoming links into two opposing axes
        self.signalized: list[int] = []
        self.phase_ax: list[tuple[list[int], list[int]]] = []
        for n in range(self.n_nodes):
            nd = net.nodes[n]
            inc = self.incoming[n]
            if (bool(nd.get("signal")) or len(inc) >= 4) and len(inc) >= 2:
                p0, p1 = [], []
                for l in inc:
                    f = self.frm[l]
                    if f < 0:
                        p0.append(l)
                        continue
                    dlat = nd["lat"] - net.nodes[f]["lat"]
                    dlon = (nd["lon"] - net.nodes[f]["lon"]) * math.cos(math.radians(nd["lat"]))
                    (p0 if abs(dlat) >= abs(dlon) else p1).append(l)
                self.signalized.append(n)
                self.phase_ax.append((p0, p1))
        self.is_signal = [False] * self.n_nodes
        for n in self.signalized:
            self.is_signal[n] = True
        self.unsignalized = [n for n in range(self.n_nodes) if not self.is_signal[n]]
        self.axes_by_node = {n: self.phase_ax[k] for k, n in enumerate(self.signalized)}


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

def _dijkstra(c: Compiled, src_node: int) -> tuple[list[float], list[int]]:
    INF = float("inf")
    dist = [INF] * c.n_nodes
    prev_link = [-1] * c.n_nodes
    dist[src_node] = 0.0
    pq = [(0.0, src_node)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]:
            continue
        for l in c.outgoing[u]:
            v = c.to[l]
            if v < 0:
                continue
            w = d + c.tff[l]
            if w < dist[v]:
                dist[v] = w
                prev_link[v] = l
                heapq.heappush(pq, (w, v))
    return dist, prev_link


def _gateways(c: Compiled) -> tuple[list[int], list[int], dict]:
    """Entry/exit gateway links (highest-capacity first) + Dijkstra cache.

    Shared by demand building and count-based OD estimation so both operate on
    exactly the same, *publicly known* gateways and free-flow route set — no
    oracle knowledge involved.
    """
    net = c.net
    bb = net.bbox

    def outside(i):
        if not bb:
            return False
        s, w, n, e = bb
        nd = net.nodes[i]
        return not (s <= nd["lat"] <= n and w <= nd["lon"] <= e)

    entries_all = [l for l in range(c.n_links)
                   if c.frm[l] >= 0 and (len(c.outgoing[c.frm[l]]) <= 1 or outside(c.frm[l]))]
    exits_all = [l for l in range(c.n_links)
                 if c.to[l] >= 0 and (len(c.incoming[c.to[l]]) <= 1 or outside(c.to[l]))]
    if not entries_all:
        entries_all = list(range(min(8, c.n_links)))
    if not exits_all:
        exits_all = list(range(max(0, c.n_links - 8), c.n_links))

    # Keep the OD problem tractable and realistic: use the highest-capacity
    # gateways (arterials) rather than hundreds of residential dead-ends.
    def cap_of(l):
        return c.lanes[l] * c.speed[l]

    entries = sorted(entries_all, key=cap_of, reverse=True)[:MAX_OD]
    exits = sorted(exits_all, key=cap_of, reverse=True)[:MAX_OD]

    dist_cache: dict[int, tuple] = {}
    for e in entries:
        src = c.to[e]
        if src >= 0 and src not in dist_cache:
            dist_cache[src] = _dijkstra(c, src)
    return entries, exits, dist_cache


def _route_chain(c: Compiled, e: int, x: int, dist, prev) -> list[int]:
    """Link chain of the free-flow shortest path entry ``e`` -> exit ``x``."""
    src = c.to[e]
    dest_node = c.frm[x]
    chain = []
    node = dest_node
    guard = 0
    while node != src and prev[node] != -1 and guard < c.n_nodes:
        l = prev[node]
        chain.append(l)
        node = c.frm[l]
        guard += 1
    chain.reverse()
    return [e] + chain


def build_demand(c: Compiled, total_vph: float, seed: int,
                 od_weights: dict | None = None) -> dict:
    """Build the routed demand.

    ``od_weights`` maps ``(entry_link, exit_link) -> veh/h``. When given, the OD
    matrix is taken from there (count-based estimate) instead of the lanes-based
    gravity prior; it is still filtered by reachability and rescaled so the
    total demand stays ``total_vph``.
    """
    entries, exits, dist_cache = _gateways(c)
    we = {l: c.lanes[l] for l in entries}
    wx = {l: c.lanes[l] for l in exits}
    se = sum(we.values()) or 1
    sx = sum(wx.values()) or 1

    turn: dict[int, dict[int, float]] = {}
    entry_rate = {l: 0.0 for l in entries}
    flow: dict[int, float] = {}
    terminal: dict[int, float] = {}
    reachable: list[tuple[int, int, float, list, list]] = []
    tot_w = 0.0

    for e in entries:
        src = c.to[e]
        if src < 0:
            continue
        dist, prev = dist_cache[src]
        for x in exits:
            dest_node = c.frm[x]
            if dest_node < 0 or dist[dest_node] == float("inf"):
                continue
            if od_weights is not None:
                w = float(od_weights.get((e, x), 0.0))
            else:
                w = we[e] * wx[x]
            if w <= 0:
                continue
            reachable.append((e, x, w, dist, prev))
            tot_w += w

    if tot_w > 0:
        scale = total_vph / tot_w        # keep total demand intact after reachability
        for e, x, w, dist, prev in reachable:
            f = w * scale
            entry_rate[e] += f
            route_links = _route_chain(c, e, x, dist, prev)
            for l in route_links:
                flow[l] = flow.get(l, 0.0) + f
            terminal[route_links[-1]] = terminal.get(route_links[-1], 0.0) + f
            prev_l = e
            for l in route_links[1:]:
                turn.setdefault(prev_l, {})
                turn[prev_l][l] = turn[prev_l].get(l, 0.0) + f
                prev_l = l

    fractions: list[list[tuple[int, float]]] = [[] for _ in range(c.n_links)]
    for l, nxt in turn.items():
        tot = sum(nxt.values())
        if tot > 0:
            fractions[l] = [(b, v / tot) for b, v in nxt.items()]
    exit_share = [0.0] * c.n_links
    for l, t in terminal.items():
        fl = flow.get(l, 0.0)
        if fl > 0:
            exit_share[l] = min(1.0, t / fl)
    corridors = _find_corridors(c, entries, exits, dist_cache)
    return {"entry_rate": entry_rate, "fractions": fractions, "exit_share": exit_share,
            "n_entries": len(entries), "n_exits": len(exits), "total_vph": total_vph,
            "routed_links": sum(1 for x in fractions if x), "corridor": corridors[0],
            "corridors": corridors, "link_flow": flow}


# ---------------------------------------------------------------------------
# Count-based OD estimation (the detector -> demand loop, Cascetta-style)
# ---------------------------------------------------------------------------

OD_ITERS = 40        # Richardson-Lucy iterations
OD_EPS = 1e-9


def route_table(c: Compiled, entries: list[int], exits: list[int],
                dist_cache: dict) -> list[tuple[int, int, set[int]]]:
    """``(entry, exit, links-on-route)`` for every reachable OD pair.

    The route set comes from free-flow Dijkstra paths — computable from the map
    alone, no demand knowledge required.
    """
    table = []
    for e in entries:
        src = c.to[e]
        if src < 0 or src not in dist_cache:
            continue
        dist, prev = dist_cache[src]
        for x in exits:
            if c.frm[x] < 0 or dist[c.frm[x]] == float("inf"):
                continue
            table.append((e, x, frozenset(_route_chain(c, e, x, dist, prev))))
    return table


def estimate_od(c: Compiled, entries: list[int], exits: list[int], dist_cache: dict,
                counts: list[float], iters: int = OD_ITERS) -> tuple[dict, dict]:
    """Estimate the entry->exit OD matrix from cumulative link counts.

    Multiplicative Richardson-Lucy (EM) fitting on the free-flow route set:
    ``count[l] = sum_p x_p * [l in route(p)]``, solved for ``x >= 0`` starting
    from a uniform prior. Inputs are exactly what a traffic operator has —
    detector counts plus the map; no oracle demand involved. The solution is
    not unique (as in the literature), but the *link flows* it implies are
    well constrained where routes overlap.

    Returns ``(od_weights {(entry, exit): veh}, report)``.
    """
    table = route_table(c, entries, exits, dist_cache)
    if not table:
        return {}, {"pairs": 0, "pairs_active": 0, "iterations": 0, "fit_rel_err_pct": 100.0}
    y = {l: max(0.0, float(v)) for l, v in enumerate(counts)}
    covered = set()
    for _e, _x, links in table:
        covered |= links
    od = {p: 1.0 for p in table}          # uniform prior; total is rescaled later
    for _ in range(iters):
        model = dict.fromkeys(covered, 0.0)
        for p, v in od.items():
            for l in p[2]:
                model[l] += v
        for p in od:
            corr = 0.0
            for l in p[2]:
                m = model[l]
                if m > OD_EPS:
                    corr += y[l] / m
            od[p] = od[p] * corr / len(p[2])
    model = dict.fromkeys(covered, 0.0)
    for p, v in od.items():
        for l in p[2]:
            model[l] += v
    tot_y = sum(y[l] for l in covered)
    err = sum(abs(model[l] - y[l]) for l in covered) / max(tot_y, OD_EPS)
    weights = {(e, x): v for (e, x, _l), v in od.items() if v > 1e-6}
    report = {"pairs": len(table), "pairs_active": len(weights), "iterations": iters,
              "fit_rel_err_pct": round(err * 100.0, 1)}
    return weights, report


def assign_link_flow(c: Compiled, entries: list[int], exits: list[int],
                     dist_cache: dict, od_weights: dict) -> dict[int, float]:
    """Route an (estimated) OD matrix onto the free-flow paths -> link flows."""
    flow: dict[int, float] = {}
    for e in entries:
        src = c.to[e]
        if src < 0 or src not in dist_cache:
            continue
        dist, prev = dist_cache[src]
        for x in exits:
            w = float(od_weights.get((e, x), 0.0))
            if w <= 0:
                continue
            for l in _route_chain(c, e, x, dist, prev):
                flow[l] = flow.get(l, 0.0) + w
    return flow


def _find_corridors(c: Compiled, entries: list[int], exits: list[int],
                    dist_cache: dict, k: int = MAX_CORRIDORS) -> list[dict]:
    """Up to ``k`` well-separated arterial corridors (longest-route heuristic)."""
    cands: list[tuple[float, list[int]]] = []
    for e in entries:
        src = c.to[e]
        if src < 0 or src not in dist_cache:
            continue
        dist, prev = dist_cache[src]
        best_x, best_d = None, -1.0
        for x in exits:
            dn = c.frm[x]
            if dn >= 0 and dist[dn] < float("inf") and dist[dn] > best_d:
                best_d, best_x = dist[dn], x
        if best_x is None:
            continue
        chain, node, guard = [], c.frm[best_x], 0
        while node != src and prev[node] != -1 and guard < c.n_nodes:
            l = prev[node]
            chain.append(l)
            node = c.frm[l]
            guard += 1
        chain.reverse()
        route = [e] + chain
        if len(route) >= 3:
            cands.append((best_d, route))
    cands.sort(key=lambda t: -t[0])

    corridors: list[dict] = []
    used: set[int] = set()
    for _d, route in cands:
        if len(set(route) & used) / max(1, len(set(route))) > 0.5:
            continue
        corridors.append(build_corridor(c, route))
        used |= set(route)
        if len(corridors) >= k:
            break
    if not corridors:
        corridors = [build_corridor(c, [])]
    return corridors


def build_corridor(c: Compiled, route_links: list[int]) -> dict:
    """Turn an ordered route into a coordination corridor with phase offsets.

    Offsets are the cumulative free-flow travel time from the corridor start to
    each junction, scaled by a progression factor (a green wave is designed
    slightly *below* free-flow speed so platoons stay inside the band).
    """
    if not route_links:
        return {"links": [], "nodes": [], "offsets": [], "main_axis": [],
                "cycle_s": COORD_CYCLE_S, "main_green_s": COORD_MAIN_GREEN_S,
                "length_m": 0.0, "junctions": 0}

    nodes, offsets, main_axis = [], [], []
    cum = 0.0
    for l in route_links:
        cum += c.tff[l]                       # seconds to traverse link l
        node = c.to[l]
        if node < 0:
            continue
        axis = None
        for ai, links in enumerate(c.axes_by_node.get(node, ())):
            if l in links:
                axis = ai
                break
        nodes.append(c.net.nodes[node]["id"])
        offsets.append(int(round((cum * COORD_PROGRESSION) % COORD_CYCLE_S)) % COORD_CYCLE_S)
        main_axis.append(0 if axis is None else axis)

    length = sum(c.len_m[l] for l in route_links)
    return {"links": route_links, "nodes": nodes, "offsets": offsets,
            "main_axis": main_axis, "cycle_s": COORD_CYCLE_S,
            "main_green_s": COORD_MAIN_GREEN_S, "length_m": round(length, 1),
            "junctions": len(nodes)}


# ---------------------------------------------------------------------------
# Junction controllers
# ---------------------------------------------------------------------------

class FixedJunction:
    """60 s cycle: 30 s axis-A, 3 s yellow, 30 s axis-B, 3 s yellow."""
    name = "fixed"

    def __init__(self, c: Compiled):
        self.n = len(c.signalized)
        # segment ids: 0=A green, 1=yellowA, 2=B green, 3=yellowB
        self.seg = [0] * self.n
        self.rem = [30] * self.n
        self.phase = [0] * self.n
        self._dur = {0: 30, 1: 3, 2: 30, 3: 3}

    def step(self, c: Compiled, t: int, queue, green_out: dict, buses=None, flows=None):
        for k, node in enumerate(c.signalized):
            s = self.seg[k]
            if s == 0:
                green_out[node] = c.phase_ax[k][0]
                self.phase[k] = 0
            elif s == 2:
                green_out[node] = c.phase_ax[k][1]
                self.phase[k] = 1
            else:
                green_out[node] = []
            self.rem[k] -= 1
            if self.rem[k] <= 0:
                self.seg[k] = (s + 1) % 4
                self.rem[k] = self._dur[self.seg[k]]


class FixedTunedJunction:
    """Fixed plan with demand-proportional green splits — a *fairer* baseline.

    Splits each junction's cycle between its two axes in proportion to the routed
    flow on those axes (from the OD assignment) instead of a uniform 50/50 — i.e.
    what a city could reach by tuning a fixed plan to its measured demand.
    """
    name = "fixed_tuned"

    def __init__(self, c: Compiled, link_flow: dict | None = None, cycle: int = 60,
                 min_green: int = 8, yellow: int = 3, all_red: int = 1):
        n = len(c.signalized)
        flow = link_flow or {}
        self.seg = [0] * n
        self.rem = [0] * n
        self.phase = [0] * n
        self.yellow = yellow
        self.g = []
        eff = max(2 * min_green, cycle - 2 * (yellow + all_red))
        for k in range(n):
            a0, a1 = c.phase_ax[k]
            w0 = sum(flow.get(l, 0.0) for l in a0) or 1.0
            w1 = sum(flow.get(l, 0.0) for l in a1) or 1.0
            g0 = int(round(eff * w0 / (w0 + w1)))
            g0 = max(min_green, min(eff - min_green, g0))
            self.g.append([g0, eff - g0])
            self.rem[k] = g0

    def step(self, c, t, queue, green_out, buses=None, flows=None):
        yellow = self.yellow
        for k, node in enumerate(c.signalized):
            s = self.seg[k]
            if s == 0:
                green_out[node] = c.phase_ax[k][0]
                self.phase[k] = 0
            elif s == 2:
                green_out[node] = c.phase_ax[k][1]
                self.phase[k] = 1
            else:
                green_out[node] = []
            self.rem[k] -= 1
            if self.rem[k] <= 0:
                s = (s + 1) % 4
                self.seg[k] = s
                self.rem[k] = [self.g[k][0], yellow, self.g[k][1], yellow][s]


class AdaptiveSplitJunction:
    """Adaptive **Webster-style** control from measured inflow.

    Every cycle each junction recomputes its green split from the *observed*
    (EWMA) link inflows — a detector proxy. With ``webster_cycle=True`` it also
    recomputes the **cycle length** with the classical Webster relation
    `C = (1.5·L + 5)/(1 − Y)` (`Y` = summed critical flow ratios), one-sided:
    the cycle only *lengthens* under load (cap 120 s), never drops below the
    base 60 s. Measured trade-off: big wins on saturated arterials
    (München-Riem, Köln — where adaptive then beats the demand-oracle plan),
    but short-link city grids (Hamburg, Berlin-Mitte) lose to spillback, so it
    is opt-in (``webster_cycle`` in the config), not the default policy.
    """
    name = "adaptive"

    def __init__(self, c: Compiled, cycle: int = 60, min_green: int = 8, yellow: int = 3,
                 all_red: int = 1, webster_cycle: bool = False):
        n = len(c.signalized)
        self.eff = max(2 * min_green, cycle - 2 * (yellow + all_red))
        self.min_green = min_green
        self.yellow, self.all_red = yellow, all_red
        self.webster_cycle = bool(webster_cycle)
        self.seg = [0] * n
        self.phase = [0] * n
        self.g = [[self.eff // 2, self.eff - self.eff // 2] for _ in range(n)]
        self.rem = [self.g[k][0] for k in range(n)]

    def _recompute(self, k, fl, c):
        a0, a1 = self.phase_ax_ref[k]
        w0 = sum(fl[l] for l in a0)
        w1 = sum(fl[l] for l in a1)
        eff = self.eff
        if self.webster_cycle:
            # Webster cycle time from the *measured* flows: Y = summed critical
            # flow ratios (worst movement per axis, capacity = saturation flow
            # x lanes), C = (1.5L + 5)/(1 - Y). One-sided adaptation: the cycle
            # only *lengthens* under load (cap 120 s) and never drops below the
            # base cycle — Webster's optimum is shallow at low Y, and short
            # cycles only add lost time when demand is light.
            L = 2 * self.yellow
            y0 = max((fl[l] / c.discharge[l] for l in a0), default=0.0)
            y1 = max((fl[l] / c.discharge[l] for l in a1), default=0.0)
            y = min(0.95, y0 + y1)
            base_cyc = float(self.eff + 2 * self.yellow)
            cyc = max(base_cyc, min(120.0, (1.5 * L + 5.0) / max(1e-3, 1.0 - y)))
            eff = max(2 * self.min_green, int(round(cyc)) - 2 * self.yellow)
        if w0 + w1 > 1e-9:
            g0 = int(round(eff * w0 / (w0 + w1)))
        else:
            g0 = eff // 2
        g0 = max(self.min_green, min(eff - self.min_green, g0))
        self.g[k] = [g0, eff - g0]

    def step(self, c, t, queue, green_out, buses=None, flows=None):
        if not hasattr(self, "phase_ax_ref"):
            self.phase_ax_ref = c.phase_ax
        fl = flows
        for k, node in enumerate(c.signalized):
            s = self.seg[k]
            if s == 0:
                green_out[node] = c.phase_ax[k][0]
                self.phase[k] = 0
            elif s == 2:
                green_out[node] = c.phase_ax[k][1]
                self.phase[k] = 1
            else:
                green_out[node] = []
            self.rem[k] -= 1
            if self.rem[k] <= 0:
                s = (s + 1) % 4
                self.seg[k] = s
                if s == 0 and fl:
                    self._recompute(k, fl, c)
                self.rem[k] = [self.g[k][0], self.yellow, self.g[k][1], self.yellow][s]


class AdaptiveJunction:
    """Max-pressure per junction, 2 phases, min/max green + clearance.

    With ``transit_priority`` the corridor's main axis gets a pressure bonus at
    the junctions along the (bus) corridor — a corridor-level transit-priority
    abstraction.
    """
    name = "adaptive"

    def __init__(self, c: Compiled, min_green=12, max_green=50, yellow=3,
                 all_red=1, hysteresis=1.6, empty_exit=5, corridor=None,
                 corridors=None, transit_priority=False):
        n = len(c.signalized)
        self.mode = ["green"] * n
        self.elapsed = [0] * n
        self.cur = [0] * n
        self.pending = [0] * n
        self.phase = [0] * n
        self.min_green, self.max_green = min_green, max_green
        self.yellow, self.all_red = yellow, all_red
        self.hyst, self.empty_exit = hysteresis, empty_exit
        self.transit_priority = bool(transit_priority)
        # corridor priority: which axes are (bus) corridor axes at each junction
        self.corr_axes = [set() for _ in range(n)]
        if self.transit_priority:
            cors = corridors or ([corridor] if corridor else [])
            for cor in cors:
                if not cor:
                    continue
                for i, nid in enumerate(cor.get("nodes", [])):
                    ax = cor["main_axis"][i] % 2
                    for k, node in enumerate(c.signalized):
                        if c.net.nodes[node]["id"] == nid:
                            self.corr_axes[k].add(ax)
                            break

    def step(self, c: Compiled, t: int, queue, green_out: dict, buses=None, flows=None):
        for k, node in enumerate(c.signalized):
            axes = c.phase_ax[k]
            cur = self.cur[k]
            cur_links = axes[cur]
            cur_p = sum(queue[l] / c.lanes[l] for l in cur_links) if cur_links else 0.0
            other = 1 - cur
            other_links = axes[other]
            other_p = sum(queue[l] / c.lanes[l] for l in other_links) if other_links else 0.0
            # corridor (bus) priority: bias toward the corridor's main axis/axes
            if self.corr_axes[k]:
                if cur in self.corr_axes[k]:
                    cur_p += CORRIDOR_BONUS
                else:
                    other_p += CORRIDOR_BONUS

            if self.mode[k] == "green":
                green_out[node] = cur_links
                self.phase[k] = cur
                self.elapsed[k] += 1
                beat = bool(other_links) and other_p > cur_p * self.hyst + 0.5
                empty = self.elapsed[k] >= self.empty_exit and cur_p < 0.5 and bool(other_links)
                if self.elapsed[k] >= self.max_green or (self.elapsed[k] >= self.min_green and beat) or empty:
                    self.mode[k] = "yellow"
                    self.elapsed[k] = 0
                    self.pending[k] = other
                    green_out[node] = []
                    continue
            elif self.mode[k] == "yellow":
                green_out[node] = []
                self.elapsed[k] += 1
                if self.elapsed[k] >= self.yellow:
                    self.mode[k] = "all_red"
                    self.elapsed[k] = 0
            else:  # all_red
                green_out[node] = []
                self.elapsed[k] += 1
                if self.elapsed[k] >= self.all_red:
                    self.cur[k] = self.pending[k]
                    self.mode[k] = "green"
                    self.elapsed[k] = 0


class CoordinatedJunction:
    """Green-wave coordination on a corridor, adaptivity everywhere else.

    Runs the same max-pressure policy for every junction, then **overrides the
    junctions on the corridor**: each corridor junction gets a common cycle and an
    offset equal to the platoon's free-flow travel time from the corridor start, so
    the main axis goes green just as the platoon arrives. The main axis may leave
    early if it is empty and the cross street is waiting (no wasted green), and it
    returns to the band on the next cycle.
    """
    name = "coordinated"

    def __init__(self, c: Compiled, corridors=None, corridor: dict | None = None,
                 min_green: int = 8, yellow: int = 3, all_red: int = 1,
                 empty_exit: int = 6):
        self.base = AdaptiveJunction(c)          # max-pressure for all junctions
        n = len(c.signalized)
        cors = corridors or ([corridor] if corridor else [])
        self.C = int((cors[0] if cors else {}).get("cycle_s") or COORD_CYCLE_S)
        self.MG = int((cors[0] if cors else {}).get("main_green_s") or COORD_MAIN_GREEN_S)
        node_off, node_axis = {}, {}
        for cor in cors:                          # first corridor wins per node
            if not cor:
                continue
            for i, nid in enumerate(cor.get("nodes", [])):
                node_off.setdefault(nid, cor["offsets"][i])
                node_axis.setdefault(nid, cor["main_axis"][i])
        self.off = [None] * n
        self.main = [None] * n
        for k, node in enumerate(c.signalized):
            nid = c.net.nodes[node]["id"]
            if nid in node_off:
                self.off[k] = node_off[nid]
                self.main[k] = node_axis[nid] % 2
        self.mode = ["green"] * n
        self.cur = [0] * n
        self.elapsed = [0] * n
        self.pending = [0] * n
        self.phase = [0] * n
        self.band = [None] * n
        self.early = [False] * n
        self.min_green, self.yellow, self.all_red, self.empty_exit = \
            min_green, yellow, all_red, empty_exit

    def step(self, c: Compiled, t: int, queue, green_out: dict, buses=None, flows=None):
        self.base.step(c, t, queue, green_out, buses=buses, flows=flows)   # adaptive baseline
        for k, node in enumerate(c.signalized):
            off = self.off[k]
            if off is None:
                continue
            axes = c.phase_ax[k]
            idx = (t - off) // self.C
            in_band = ((t - off) % self.C) < self.MG
            if self.band[k] != idx:
                self.band[k] = idx
                self.early[k] = False
            main = self.main[k] or 0
            cross = 1 - main
            cur = self.cur[k]
            cur_links = axes[cur]
            other_links = axes[1 - cur]
            cur_p = sum(queue[l] / c.lanes[l] for l in cur_links) if cur_links else 0.0
            other_p = sum(queue[l] / c.lanes[l] for l in other_links) if other_links else 0.0
            desired = cross if (self.early[k] or not in_band) else main

            if self.mode[k] == "green":
                green_out[node] = cur_links
                self.phase[k] = cur
                self.elapsed[k] += 1
                if (in_band and cur == main and not self.early[k]
                        and self.elapsed[k] >= self.empty_exit
                        and cur_p < 0.5 and other_p > 1.0):
                    self.early[k] = True
                    desired = cross
                if cur != desired and self.elapsed[k] >= self.min_green \
                        and axes[desired]:
                    self.mode[k] = "yellow"
                    self.elapsed[k] = 0
                    self.pending[k] = desired
                    green_out[node] = []
            elif self.mode[k] == "yellow":
                green_out[node] = []
                self.elapsed[k] += 1
                if self.elapsed[k] >= self.yellow:
                    self.mode[k] = "all_red"
                    self.elapsed[k] = 0
            else:  # all_red
                green_out[node] = []
                self.elapsed[k] += 1
                if self.elapsed[k] >= self.all_red:
                    self.cur[k] = self.pending[k]
                    self.mode[k] = "green"
                    self.elapsed[k] = 0


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------

def _simulate(c: Compiled, demand: dict, controller, cfg: dict, frame_dt: int,
              corr_links: list | None = None, counts: list[float] | None = None):
    """Mesoscopic link-queue run over the shared demand.

    Wall-clock window semantics (``time_from``/``time_to``): the within-day
    demand *shape* is evaluated at the window clock. Spans longer than the
    simulated steps run as an explicit time-lapse — the clock sweeps the window
    faster, but **volumes stay 1:1** (scaling inflow with the lapse factor would
    collapse the queue physics); the day's shape appears compressed, the KPI
    magnitudes stay honest. ``warmup_min`` runs un-recorded so the network
    starts "in traffic" instead of empty.
    """
    n_l = c.n_links
    sched = [deque([0.0] * c.tff[l]) for l in range(n_l)]
    in_transit = [0.0] * n_l
    queue = [0.0] * n_l
    frac = demand["fractions"]
    exit_share = demand["exit_share"]
    spawn_acc = {l: 0.0 for l in demand["entry_rate"]}
    entry_items = list(demand["entry_rate"].items())
    pce = max(1e-9, float(cfg.get("pce", 1.0)))

    steps = int(cfg["duration_min"] * 60)
    warmup = int(cfg.get("warmup_min", 0)) * 60
    mult = cfg["demand_multiplier"]
    profile = cfg.get("demand_profile", "peak")
    from_sec = parse_hhmm(cfg.get("time_from")) if cfg.get("time_from") else None
    span_sec = float(cfg.get("span_sec") or steps)
    clock_rate = max(1.0, span_sec / max(1, steps))   # wall-s per sim-s (>= 1)

    total_delay = 0.0
    served = 0.0
    spawned = 0.0
    in_net_sum = 0.0
    corr_delay = 0.0
    corr_links = corr_links or []
    frames = []
    green: dict[int, list[int]] = {}
    unsign = c.unsignalized
    # only links that currently carry vehicles are stepped (big speed-up on
    # large networks where most links are empty at any instant)
    active: set[int] = set()
    q_total = 0.0
    t_total = 0.0
    ov = STORAGE_OVERFLOW
    inflow_hat = [0.0] * n_l        # EWMA of measured link inflow (detector proxy)
    ALPHA = 0.02

    for t_raw in range(steps + warmup):
        rec = t_raw >= warmup
        t = t_raw - warmup
        if from_sec is not None:
            # clock sweeps the window during the recorded span (time-lapse > 1x)
            pm = float(profile_at_clock(profile, from_sec + t * clock_rate))
        else:
            pm = float(profile_value(profile, t, steps))
        step_in: dict[int, float] = {}

        for l, r in entry_items:
            spawn_acc[l] += r * mult * pm / 3600.0
            room = c.cap[l] * ov - (queue[l] + in_transit[l])
            n = min(int(spawn_acc[l]), max(0, int(room)))
            if n:
                spawn_acc[l] -= n
                sched[l][-1] += n
                in_transit[l] += n
                t_total += n
                spawned += n
                active.add(l)
                step_in[l] = step_in.get(l, 0.0) + n
            elif spawn_acc[l] >= 1:
                spawn_acc[l] = min(spawn_acc[l], 50.0)

        for l in list(active):
            b = sched[l].popleft()
            if b:
                queue[l] += b
                q_total += b
                in_transit[l] -= b
                t_total -= b
            sched[l].append(0.0)
            if queue[l] <= 0.0 and in_transit[l] <= 0.0:
                active.discard(l)

        green.clear()
        controller.step(c, t, queue, green, flows=inflow_hat)
        for n in unsign:
            inc = c.incoming[n]
            if inc:
                green[n] = inc

        for n, gl in green.items():
            if not gl:
                continue
            for l in gl:
                if queue[l] <= 0:
                    continue
                q0 = queue[l]
                want = min(queue[l], c.discharge[l] / pce)
                if want > 0:
                    nxt = frac[l]
                    if not nxt:
                        queue[l] -= want
                        q_total -= want
                        served += want
                    else:
                        space = 0.0
                        for b, _ in nxt:
                            occ = queue[b] + in_transit[b]
                            space += max(0.0, c.cap[b] * ov - occ)
                        if space > 0:
                            take = min(want, space)
                            leave = take * exit_share[l]
                            cont = take - leave
                            placed = 0.0
                            if cont > 0:
                                for b, f in nxt:
                                    occ = queue[b] + in_transit[b]
                                    room = max(0.0, c.cap[b] * ov - occ)
                                    put = min(cont * f, room)
                                    if put:
                                        sched[b][-1] += put
                                        in_transit[b] += put
                                        t_total += put
                                        placed += put
                                        active.add(b)
                                        step_in[b] = step_in.get(b, 0.0) + put
                            served += leave
                            queue[l] -= (leave + placed)
                            q_total -= (leave + placed)
                if counts is not None and rec:
                    counts[l] += q0 - queue[l]   # stop-line detector count

        in_net = q_total + t_total
        for l, v in step_in.items():
            inflow_hat[l] = (1 - ALPHA) * inflow_hat[l] + ALPHA * v
        if rec:
            in_net_sum += in_net
            total_delay += q_total
            if corr_links:
                corr_delay += sum(queue[l] for l in corr_links)

        if rec and (t % frame_dt == 0 or t == steps - 1):
            frames.append({
                "t": t,
                "q": [[l, round(queue[l], 2)] for l in active if queue[l] >= 0.5],
                "ph": [[c.net.nodes[n]["id"], controller.phase[k]]
                       for k, n in enumerate(c.signalized)],
            })

    wall_hours = max(1e-9, steps / 3600.0)
    summary = {
        "controller": controller.name,
        "served": round(served, 1),
        "spawned": round(spawned, 1),
        "in_network_at_end": round(q_total + t_total, 1),
        "throughput_vph": round(served / wall_hours, 1),
        "avg_delay_s": round(total_delay / max(1.0, served), 2),
        "avg_travel_time_s": round((in_net_sum / served) if served else 0.0, 2),
        "total_delay_vehsec": round(total_delay, 1),
        "corridor_delay_s": round(corr_delay / served, 2) if served else 0.0,
        "co2_g": round(total_delay * CO2_IDLE_G_PER_S, 1),
        "links": n_l,
        "junctions": len(c.signalized),
    }
    return summary, frames


def run_region(region_id: str, cfg: dict | None = None) -> dict:
    cfg = dict(cfg or {})
    duration_min = int(cfg.get("duration_min", 15))
    seed = int(cfg.get("seed", 42))
    # wall-clock window ("HH:MM"): demand follows the real clock; spans longer
    # than the simulated span run as an explicit time-lapse (clock_rate > 1)
    time_from = cfg.get("time_from") or None
    time_to = cfg.get("time_to") or None
    from_sec = parse_hhmm(time_from) if time_from else None
    to_sec = parse_hhmm(time_to) if time_to else None
    if time_from and from_sec is None:
        raise ValueError("time_from must be 'HH:MM'")
    if time_to and to_sec is None:
        raise ValueError("time_to must be 'HH:MM'")
    span_min = None
    if from_sec is not None and to_sec is not None:
        span_min = ((to_sec - from_sec) % 86400) // 60
    warmup_min = max(0, min(60, int(cfg.get("warmup_min", 5))))
    if "duration_min" not in cfg and span_min:
        duration_min = max(15, min(120, span_min))
    span_sec = float(span_min * 60) if span_min else float(duration_min * 60)
    scenario_name = cfg.get("demand_scenario") or ("custom" if "demand_profile" in cfg else "normal")
    if scenario_name not in DEMAND_SCENARIOS:
        raise ValueError("demand_scenario must be one of " + ", ".join(DEMAND_SCENARIOS))
    scen = DEMAND_SCENARIOS[scenario_name]
    profile = cfg.get("demand_profile") if scenario_name == "custom" else scen["profile"]
    if profile not in ("peak", "flat", "commute", "leisure"):
        raise ValueError("demand_profile must be one of peak, flat, commute, leisure")
    mult = float(cfg.get("demand_multiplier", 1.0)) * float(scen["multiplier"])
    mix = cfg.get("vehicle_mix") or {"car": 1.0}
    if not isinstance(mix, dict) or not mix:
        raise ValueError("vehicle_mix must be a non-empty object")
    for kk, vv in mix.items():
        if kk not in PCE:
            raise ValueError(f"vehicle_mix keys must be in {sorted(PCE)}")
        if isinstance(vv, bool) or not isinstance(vv, (int, float)) or vv < 0:
            raise ValueError("vehicle_mix values must be non-negative numbers")
    _tot = sum(float(v) for v in mix.values())
    if _tot <= 0:
        raise ValueError("vehicle_mix must have a positive total")
    pce = sum(float(vv) * PCE.get(kk, 1.0) for kk, vv in mix.items()) / _tot
    if not (1 <= duration_min <= 180):
        raise ValueError("duration_min must be between 1 and 180")
    if not (0 < mult <= 5):
        raise ValueError("demand_multiplier must be in (0, 5]")
    total_vph = float(cfg.get("total_vph") or DEFAULT_VPH.get(region_id, 5000))

    net = load_network(region_id)
    c = Compiled(net)
    demand = build_demand(c, total_vph, seed)
    corr_links = demand["corridor"].get("links", [])
    tsp = bool(cfg.get("transit_priority", False))

    base = {"duration_min": duration_min, "seed": seed, "demand_multiplier": mult,
            "demand_profile": profile, "pce": pce, "warmup_min": warmup_min,
            "time_from": time_from, "time_to": time_to, "span_sec": span_sec}
    frame_dt = max(1, (duration_min * 60) // 90)

    counts = [0.0] * c.n_links
    fixed = _simulate(c, demand, FixedJunction(c), base, frame_dt, corr_links, counts=counts)
    tuned = _simulate(c, demand, FixedTunedJunction(c, demand.get("link_flow")),
                      base, frame_dt, corr_links)
    kind = cfg.get("adaptive_kind", "split")
    # Webster cycle *lengthening* under load: wins on saturated arterials
    # (Riem, Köln) but hurts short-link grids where spillback dominates
    # (Hamburg, Berlin-Mitte) — measured, see tools/od_experiment.py — so it
    # is opt-in via config rather than the default policy.
    webster = bool(cfg.get("webster_cycle", False))
    if kind == "pressure" or tsp:
        adaptive = _simulate(c, demand, AdaptiveJunction(
            c, corridors=demand["corridors"], transit_priority=tsp),
            base, frame_dt, corr_links)
    else:
        adaptive = _simulate(c, demand, AdaptiveSplitJunction(c, webster_cycle=webster),
                             base, frame_dt, corr_links)
    coordinated = _simulate(c, demand, CoordinatedJunction(c, demand["corridors"]),
                            base, frame_dt, corr_links)

    # Count-based OD estimation: treat the *fixed* run as the city's detector
    # logs (stop-line counts), estimate the OD matrix from them and tune a plan
    # on the estimate — no oracle demand knowledge involved.
    tuned_est = None
    od_meta = {}
    if cfg.get("od_estimation", True):
        entries, exits, dist_cache = _gateways(c)
        od_w, od_meta = estimate_od(c, entries, exits, dist_cache, counts)
        est_flow = assign_link_flow(c, entries, exits, dist_cache, od_w)
        if est_flow:
            tuned_est = _simulate(c, demand, FixedTunedJunction(c, est_flow),
                                  base, frame_dt, corr_links)
    f, t_, a, k = fixed[0], tuned[0], adaptive[0], coordinated[0]

    def red(b, n):
        return round((b - n) / b * 100.0, 1) if b else 0.0

    def gain(b, n):
        return round((n - b) / b * 100.0, 1) if b else 0.0

    improvement = {
        "avg_delay_pct": red(f["avg_delay_s"], a["avg_delay_s"]),
        "throughput_pct": gain(f["throughput_vph"], a["throughput_vph"]),
        "avg_travel_pct": red(f["avg_travel_time_s"], a["avg_travel_time_s"]),
        "co2_pct": red(f["co2_g"], a["co2_g"]),
        "vs_tuned": {
            "avg_delay_pct": red(t_["avg_delay_s"], a["avg_delay_s"]),
            "throughput_pct": gain(t_["throughput_vph"], a["throughput_vph"]),
            "avg_travel_pct": red(t_["avg_travel_time_s"], a["avg_travel_time_s"]),
            "co2_pct": red(t_["co2_g"], a["co2_g"]),
        },
        "coordinated": {
            "avg_delay_pct": red(f["avg_delay_s"], k["avg_delay_s"]),
            "throughput_pct": gain(f["throughput_vph"], k["throughput_vph"]),
            "avg_travel_pct": red(f["avg_travel_time_s"], k["avg_travel_time_s"]),
            "co2_pct": red(f["co2_g"], k["co2_g"]),
        },
    }
    if tuned_est is not None:
        te = tuned_est[0]
        improvement["vs_tuned_est"] = {
            "avg_delay_pct": red(te["avg_delay_s"], a["avg_delay_s"]),
            "throughput_pct": gain(te["throughput_vph"], a["throughput_vph"]),
            "avg_travel_pct": red(te["avg_travel_time_s"], a["avg_travel_time_s"]),
            "co2_pct": red(te["co2_g"], a["co2_g"]),
        }

    return {
        "region": region_id,
        "name": net.name,
        "bbox": net.bbox,
        "network": {
            "nodes": net.nodes,
            "links": net.links,
            "signal_nodes": [net.nodes[n]["id"] for n in c.signalized],
        },
        "corridor": demand["corridor"],
        "corridors": demand["corridors"],
        "demand": {"n_entries": demand["n_entries"], "n_exits": demand["n_exits"],
                   "total_vph": total_vph},
        "scenario": {"name": scenario_name, "label": scen["label"],
                     "multiplier": round(mult, 3), "profile": profile,
                     "vehicle_mix": dict(mix), "pce_avg": round(pce, 3),
                     "transit_priority": tsp,
                     "time_from": time_from, "time_to": time_to,
                     "warmup_min": warmup_min, "clock": from_sec is not None},
        "summary": {"fixed": f, "fixed_tuned": t_, "adaptive": a, "coordinated": k,
                    **({"fixed_tuned_est": tuned_est[0]} if tuned_est else {})},
        "improvement": improvement,
        "frames": {"fixed": fixed[1], "adaptive": adaptive[1], "coordinated": coordinated[1]},
        "config": {**base, "total_vph": total_vph, "frame_dt": frame_dt},
        "meta": {"steps": duration_min * 60, "frame_dt": frame_dt,
                 "clock": from_sec is not None,
                 "clock_rate": round(span_sec / (duration_min * 60), 3),
                 "span_min": round(span_sec / 60), "warmup_min": warmup_min,
                 "time_from": time_from, "time_to": time_to,
                 "generated": "SignalFlow network v0.4 (OSM link-queue + green wave "
                              "+ count-based OD)",
                 **({"od_estimation": od_meta} if od_meta else {})},
    }


if __name__ == "__main__":
    print(json.dumps(list_regions(), indent=2, ensure_ascii=False))
