"""SignalFlow simulation core.

A deterministic discrete-time (dt = 1 s) queueing model of a single signalised
4-way intersection with protected left turns. Four controllers compete on the
*identical* arrival stream:

* ``FixedTimeController``    — classic time-of-day plan (baseline)
* ``MaxPressureController``  — adaptive, queue-pressure driven, with an
  explainability hook that records *why* every phase switch happened
* ``CoordinatedController``  — green wave: locked to a corridor master cycle
  with splits biased toward the busier axis (honest about being ~fixed at an
  isolated junction — progression gains need neighbours)
* ``TunedController``        — Webster plan derived from stop-line detector
  counts (the junction-level twin of the network model's ``fixed_tuned_est``)

Demand follows a wall-clock time window (``time_from``/``time_to``): the
within-day profile is evaluated at the simulated clock time, so a 07:00–18:00
window reproduces both commute waves. A warm-up period (``warmup_min``) runs
before the recorded window so KPIs start "in traffic", not from empty queues.

The model is intentionally lightweight so it runs in milliseconds and can be
replayed frame-by-frame in a browser dashboard. It is honest about being a
model: it is a macroscopic queueing approximation (saturation-flow service),
not a full car-following microsimulation.

Units
-----
* time            : seconds (dt = 1 s)
* flow / rates    : veh/h in config, converted to veh/step internally
* queue           : vehicles (float)
* delay           : veh-seconds
"""

from __future__ import annotations

import csv
import io
import math
import random
import urllib.request
from dataclasses import dataclass, field, asdict, fields
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

APPROACHES = ("N", "E", "S", "W")
TURN_MOVEMENTS = ("L", "T", "R")

# Movement key = (approach, turn), e.g. ("N", "T").
Movement = tuple[str, str]


def all_movements() -> list[Movement]:
    return [(a, mv) for a in APPROACHES for mv in TURN_MOVEMENTS]


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_DEMAND = {
    # veh/h per movement — a busy-but-plausible Munich intersection peak.
    "N": {"T": 720, "L": 140, "R": 120},
    "E": {"T": 600, "L": 100, "R": 90},
    "S": {"T": 760, "L": 150, "R": 130},
    "W": {"T": 560, "L": 90, "R": 80},
}

# ---------------------------------------------------------------------------
# Demand scenarios (season / day-type) and vehicle mix
# ---------------------------------------------------------------------------

# Passenger-car equivalents per vehicle class (used to reduce effective
# saturation flow for mixed traffic).
PCE = {"car": 1.0, "van": 1.3, "truck": 2.2, "bus": 2.6}

# Named demand scenarios: a base multiplier plus a within-day demand shape.
DEMAND_SCENARIOS = {
    "normal":        {"multiplier": 1.00, "profile": "peak",    "label": "Normal"},
    "berufsverkehr": {"multiplier": 1.70, "profile": "commute", "label": "Berufsverkehr (Rush)"},
    "ferien":        {"multiplier": 0.70, "profile": "flat",    "label": "Ferien"},
    "freizeit":      {"multiplier": 0.90, "profile": "leisure",  "label": "Freizeit / Wochenende"},
    "custom":        {"multiplier": 1.00, "profile": "peak",    "label": "Custom (eigenes Profil)"},
}


def _gauss(x: float, mu: float, sig: float) -> float:
    return math.exp(-0.5 * ((x - mu) / sig) ** 2)


def profile_value(profile: str, t: int, steps: int) -> float:
    """Within-day demand shape in [~0.1, ~1.8] (legacy: stretched over the run).

    Only used when no wall-clock window is configured. With ``time_from`` set,
    :func:`profile_at_clock` evaluates the same shapes at the real clock time.
    """
    n = max(1, steps - 1)
    x = t / n
    if profile == "flat":
        return 1.0
    if profile == "commute":
        return 0.30 + 1.05 * _gauss(x, 0.22, 0.10) + 0.95 * _gauss(x, 0.78, 0.11)
    if profile == "leisure":
        return 0.35 + 0.85 * _gauss(x, 0.55, 0.20)
    # default: single hump
    return 0.6 + 1.0 * math.sin(math.pi * x)


def parse_hhmm(s) -> int | None:
    """Parse ``"HH:MM"`` (or ``"HH:MM:SS"``) into seconds-of-day, else None."""
    if not isinstance(s, str) or ":" not in s:
        return None
    try:
        parts = [int(p) for p in s.strip().split(":")]
        h, m = parts[0], parts[1]
        sec = parts[2] if len(parts) > 2 else 0
    except (ValueError, TypeError):
        return None
    if not (0 <= h <= 24 and 0 <= m < 60 and 0 <= sec < 60):
        return None
    return min(86400, h * 3600 + m * 60 + sec)


def _circ_gauss(h: float, mu: float, sig: float) -> float:
    """Gaussian over the 24 h clock (wraparound, so night windows work)."""
    d = abs(h - mu)
    d = min(d, 24.0 - d)
    return math.exp(-0.5 * (d / sig) ** 2)


def _int_split(vals: list[float], total: float, floor: float = 0.0) -> list[int]:
    """Largest-remainder rounding: integers that sum exactly to ``total``."""
    base = [int(v) for v in vals]
    rem = int(round(total)) - sum(base)
    order = sorted(range(len(vals)), key=lambda i: vals[i] - base[i], reverse=rem > 0)
    k = 0
    while rem != 0 and order and k < 4 * len(vals) + 8:
        i = order[k % len(order)]
        if rem > 0:
            base[i] += 1
            rem -= 1
        elif base[i] > max(1, floor):
            base[i] -= 1
            rem += 1
        k += 1
    return base


# Clock-based within-day shapes (hour-of-day -> multiplier). Peaks are
# calibrated so a rush window sits just below junction capacity (~v/c 0.85–0.9):
# sustained hours of oversaturation would collapse the whole day, which no
# real-world coordinated plan has to survive either.
CLOCK_PROFILES = {
    # Berufsverkehr: morning + evening commute waves, empty midday valley
    "commute": lambda h: 0.05 + 0.57 * _circ_gauss(h, 8.0, 0.85)
                         + 0.50 * _circ_gauss(h, 17.5, 0.95),
    # Normal workday: moderate shoulders, one broad midday peak
    "peak": lambda h: 0.10 + 0.28 * _circ_gauss(h, 8.0, 1.4)
                      + 0.48 * _circ_gauss(h, 13.2, 2.8)
                      + 0.33 * _circ_gauss(h, 17.6, 1.5),
    # Weekend/Freizeit: one broad midday hill, quiet morning
    "leisure": lambda h: 0.08 + 0.70 * _circ_gauss(h, 14.2, 2.3),
    # Ferien: demand exists all day, no sharp rush, quieter night
    "flat": lambda h: 0.55 + 0.25 * _circ_gauss(h, 13.5, 4.5),
}


def profile_at_clock(profile: str, sec_of_day: float) -> float:
    """Within-day demand shape evaluated at a wall-clock second-of-day."""
    h = (sec_of_day % 86400) / 3600.0
    fn = CLOCK_PROFILES.get(profile)
    if fn is None:
        fn = CLOCK_PROFILES["peak"]
    return round(fn(h), 4)


@dataclass
class Config:
    duration_min: int = 30
    seed: int = 42
    dt: int = 1
    demand_multiplier: float = 1.0
    demand_profile: str = "peak"          # "peak" | "flat"
    # how demand is sourced: "model" (Poisson from rates) or "csv" (sensor counts)
    arrival_source: str = "model"
    arrival_csv: str | None = None        # path relative to project root when not absolute
    detector_dropout: float = 0.0         # fraction of sensor counts lost (sensor realism)
    saturation_flow_vph_lane: int = 1800  # veh/h/lane
    co2_idle_g_per_s: float = 1.15        # idling emission proxy
    # season / day-type demand scenario (shape + base multiplier)
    demand_scenario: str = "normal"        # normal|berufsverkehr|ferien|freizeit|custom
    # wall-clock window ("HH:MM") — demand follows the real clock inside it.
    # duration_min should equal the window span (the dashboards send it that way).
    time_from: str | None = None
    time_to: str | None = None
    warmup_min: int = 0                   # simulated before 'from' without KPI counting
    # heterogeneous traffic: vehicle-class shares (values need not sum to 1)
    vehicle_mix: dict = field(default_factory=lambda: {"car": 1.0})
    # bus-actuated signal priority (transit signal priority, TSP)
    transit_priority: bool = False
    bus_headway_s: int = 240              # mean bus headway on the priority stream
    # junction geometry / control type
    junction_type: str = "cross4"          # cross4 | cross4_permissive | t3 | roundabout
    permissive_left: bool = False
    demand: dict = field(default_factory=lambda: {a: dict(DEFAULT_DEMAND[a]) for a in APPROACHES})
    lanes: dict = field(default_factory=lambda: {"T": 2, "L": 1, "R": 1})
    # fixed-time plan (baseline): green seconds per phase, in PHASE order
    fixed_greens: list = field(default_factory=lambda: [36, 10, 32, 8])
    fixed_yellow: int = 3
    fixed_all_red: int = 1
    # adaptive controller
    min_green: int = 24
    max_green: int = 50
    yellow: int = 3
    all_red: int = 1
    starve_seconds: int = 120        # waiting this long forces a service bonus
    switch_hysteresis: float = 3.0   # pressure must beat current by this factor
    empty_exit_green: int = 5        # allow leaving an empty phase after this long
    # coordinated (green wave) plan: corridor master cycle / progression offset
    coord_cycle_s: int = 90
    coord_offset_s: int = 12
    coord_bias: float = 1.25         # green-share bias toward the busier axis

    @property
    def steps(self) -> int:
        return int(self.duration_min * 60)

    @property
    def total_steps(self) -> int:
        """Simulated seconds including the un-recorded warm-up."""
        return self.steps + int(self.warmup_min) * 60

    @property
    def from_sec(self) -> int | None:
        return parse_hhmm(self.time_from)

    @property
    def to_sec(self) -> int | None:
        return parse_hhmm(self.time_to)

    @property
    def has_window(self) -> bool:
        return self.from_sec is not None

    def clock_at(self, t: int) -> int:
        """Wall-clock second-of-day at simulation second ``t`` (t=0 is 'from')."""
        f = self.from_sec or 0
        return (f + int(t)) % 86400

    @property
    def scenario(self) -> dict:
        return DEMAND_SCENARIOS.get(self.demand_scenario, DEMAND_SCENARIOS["normal"])

    def spec(self) -> dict:
        return junction_spec(self.junction_type, self.permissive_left)

    def arms(self) -> list:
        return self.spec()["arms"]

    def movements(self) -> list:
        spec = self.spec()
        return [(a, mv) for a in spec["arms"] for mv in spec["movements"][a]]

    def phases(self) -> list:
        return self.spec()["phases"]

    def phase_names(self) -> list:
        return [p[0] for p in self.phases()]

    @property
    def signalized(self) -> bool:
        return bool(self.spec()["signalized"])

    def fixed_greens_effective(self) -> list:
        spec = self.spec()
        greens = spec.get("fixed_greens") or []
        n = len(spec["phases"])
        if len(greens) == n and n:
            return list(greens)
        # fall back to an even split
        return [max(6, 60 // max(1, n))] * n

    def roundabout_capacity(self) -> dict:
        """Simplified single-lane roundabout entry capacity (veh/h per movement).

        HCM-style: ``c = 1130 · exp(−1.0e−3 · C)`` with ``C`` the conflicting
        (circulating) flow in veh/h, estimated as 60 % of the demand from the other
        arms. This is an approximation, documented as such.
        """
        mv = self.movements()
        cap = {}
        for a, turn in mv:
            # conflicting flow ≈ through + left traffic from the *other* arms
            others = sum(self.rate(a2, t2) for (a2, t2) in mv
                         if a2 != a and t2 in ("T", "L"))
            circ = 0.5 * others * self.demand_multiplier
            c = 1130.0 * math.exp(-1.0e-3 * circ)
            cap[(a, turn)] = max(120.0, c) * max(1, self.lanes[turn])
        return cap

    def profile_name(self) -> str:
        return self.demand_profile if self.demand_scenario == "custom" else self.scenario["profile"]

    @property
    def scenario_multiplier(self) -> float:
        return float(self.scenario["multiplier"])

    @property
    def pce_avg(self) -> float:
        mix = self.vehicle_mix or {"car": 1.0}
        tot = sum(float(v) for v in mix.values()) or 1.0
        return sum(float(v) * PCE.get(k, 1.0) for k, v in mix.items()) / tot

    @property
    def sat_flow_effective(self) -> float:
        """Saturation flow reduced by heavy-vehicle equivalents (mixed traffic)."""
        return self.saturation_flow_vph_lane / max(1e-9, self.pce_avg)

    def rate(self, approach: str, turn: str) -> float:
        return float(self.demand[approach][turn])

    def profile_multiplier(self, t: int) -> float:
        """Demand shape over time.

        With a wall-clock window the within-day shape is evaluated at the real
        clock time (so a 07:00–18:00 run shows both commute waves); without one
        the legacy behaviour stretches the shape over the run length.
        """
        if self.has_window:
            return profile_at_clock(self.profile_name(), self.clock_at(t))
        return profile_value(self.profile_name(), t, self.steps)

    @classmethod
    def from_dict(cls, d: dict | None) -> "Config":
        if d is not None and not isinstance(d, dict):
            raise ValueError("configuration must be a JSON object")
        d = dict(d or {})
        cfg = cls()
        settable = {f.name for f in fields(cls)}
        for k, v in d.items():
            if k == "demand":
                merged = {a: dict(DEFAULT_DEMAND[a]) for a in APPROACHES}
                for a, mv in (v or {}).items():
                    if a in merged:
                        merged[a].update({m: float(x) for m, x in mv.items()})
                cfg.demand = merged
            elif k == "lanes":
                merged = {"T": 2, "L": 1, "R": 1}
                merged.update({m: int(x) for m, x in (v or {}).items()})
                cfg.lanes = merged
            elif k == "vehicle_mix":
                cfg.vehicle_mix = {str(kk): float(vv) for kk, vv in (v or {}).items()}
            elif k in settable:
                setattr(cfg, k, v)
        # An explicit demand_profile implies the legacy custom profile.
        if "demand_profile" in d and "demand_scenario" not in d:
            cfg.demand_scenario = "custom"
        # A wall-clock window implies its span as the simulated duration
        # (callers may still pin duration_min explicitly).
        if cfg.time_from is not None and "duration_min" not in d:
            f_s = parse_hhmm(cfg.time_from) or 0
            t_s = parse_hhmm(cfg.time_to)
            if t_s is not None:
                span = (t_s - f_s) % 86400
                if span >= 60:
                    cfg.duration_min = min(1440, span // 60)
        cfg._validate()
        return cfg

    def _validate(self) -> None:
        """Reject malformed configurations with a clear ValueError (→ HTTP 400)."""
        if isinstance(self.duration_min, bool) or not isinstance(self.duration_min, (int, float)):
            raise ValueError("duration_min must be a number")
        self.duration_min = int(self.duration_min)
        if not (1 <= self.duration_min <= 1440):
            raise ValueError("duration_min must be between 1 and 1440")
        if isinstance(self.seed, bool) or not isinstance(self.seed, (int, float)):
            raise ValueError("seed must be an integer")
        self.seed = int(self.seed)
        if isinstance(self.dt, bool) or not isinstance(self.dt, (int, float)):
            raise ValueError("dt must be a number")
        self.dt = int(self.dt)
        if self.dt < 1:
            raise ValueError("dt must be >= 1")
        if not isinstance(self.demand_multiplier, (int, float)) or isinstance(self.demand_multiplier, bool):
            raise ValueError("demand_multiplier must be a number")
        if not (0 < float(self.demand_multiplier) <= 5):
            raise ValueError("demand_multiplier must be in (0, 5]")
        if self.demand_profile not in ("peak", "flat", "commute", "leisure"):
            raise ValueError("demand_profile must be one of peak, flat, commute, leisure")
        if self.demand_scenario not in DEMAND_SCENARIOS:
            raise ValueError("demand_scenario must be one of " + ", ".join(DEMAND_SCENARIOS))
        if self.time_from is not None and parse_hhmm(self.time_from) is None:
            raise ValueError("time_from must be 'HH:MM'")
        if self.time_to is not None and parse_hhmm(self.time_to) is None:
            raise ValueError("time_to must be 'HH:MM'")
        if isinstance(self.warmup_min, bool) or not isinstance(self.warmup_min, (int, float)):
            raise ValueError("warmup_min must be a number")
        self.warmup_min = max(0, min(180, int(self.warmup_min)))
        for nm in ("coord_cycle_s", "coord_offset_s"):
            val = getattr(self, nm)
            if isinstance(val, bool) or not isinstance(val, (int, float)) or val < 0:
                raise ValueError(f"{nm} must be a non-negative integer")
            setattr(self, nm, int(val))
        if self.coord_cycle_s < 30:
            raise ValueError("coord_cycle_s must be >= 30")
        if isinstance(self.coord_bias, bool) or not isinstance(self.coord_bias, (int, float)):
            raise ValueError("coord_bias must be a number")
        self.coord_bias = min(2.0, max(1.0, float(self.coord_bias)))
        mix = self.vehicle_mix or {}
        if not isinstance(mix, dict) or not mix:
            raise ValueError("vehicle_mix must be a non-empty object")
        for kk, vv in mix.items():
            if kk not in PCE:
                raise ValueError(f"vehicle_mix keys must be in {sorted(PCE)}")
            if isinstance(vv, bool) or not isinstance(vv, (int, float)) or vv < 0:
                raise ValueError("vehicle_mix values must be non-negative numbers")
        if sum(float(v) for v in mix.values()) <= 0:
            raise ValueError("vehicle_mix must have a positive total")
        if self.transit_priority is not None and not isinstance(self.transit_priority, bool):
            raise ValueError("transit_priority must be a boolean")
        if self.junction_type not in JUNCTION_TYPES:
            raise ValueError("junction_type must be one of " + ", ".join(sorted(JUNCTION_TYPES)))
        if not isinstance(self.permissive_left, bool):
            raise ValueError("permissive_left must be a boolean")
        if isinstance(self.bus_headway_s, bool) or not isinstance(self.bus_headway_s, (int, float)):
            raise ValueError("bus_headway_s must be a number")
        self.bus_headway_s = int(self.bus_headway_s)
        if not (30 <= self.bus_headway_s <= 3600):
            raise ValueError("bus_headway_s must be between 30 and 3600")
        if self.arrival_source not in ("model", "csv"):
            raise ValueError("arrival_source must be 'model' or 'csv'")
        if not isinstance(self.detector_dropout, (int, float)) or isinstance(self.detector_dropout, bool):
            raise ValueError("detector_dropout must be a number")
        if not (0 <= float(self.detector_dropout) < 0.9):
            raise ValueError("detector_dropout must be in [0, 0.9)")
        self.detector_dropout = float(self.detector_dropout)
        if self.arrival_csv is not None and not isinstance(self.arrival_csv, str):
            raise ValueError("arrival_csv must be a path string")
        for a in APPROACHES:
            for mv in TURN_MOVEMENTS:
                r = self.demand[a][mv]
                if isinstance(r, bool) or not isinstance(r, (int, float)) or r < 0:
                    raise ValueError(f"demand[{a}][{mv}] must be a non-negative number")
        for name in ("min_green", "max_green", "yellow", "all_red", "fixed_yellow",
                     "fixed_all_red", "empty_exit_green", "starve_seconds",
                     "saturation_flow_vph_lane"):
            val = getattr(self, name)
            if isinstance(val, bool) or not isinstance(val, (int, float)) or val < 0:
                raise ValueError(f"{name} must be a non-negative integer")
            setattr(self, name, int(val))
        if self.min_green < 1:
            raise ValueError("min_green must be >= 1")
        if self.max_green < self.min_green:
            raise ValueError("max_green must be >= min_green")
        if not isinstance(self.fixed_greens, list) or len(self.fixed_greens) != len(PHASES):
            raise ValueError(f"fixed_greens must be a list of {len(PHASES)} integers")
        self.fixed_greens = [int(x) for x in self.fixed_greens]

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Signal phases
# ---------------------------------------------------------------------------

PHASES = [
    ("NS_THRU", {("N", "T"), ("N", "R"), ("S", "T"), ("S", "R")}),
    ("NS_LEFT", {("N", "L"), ("S", "L")}),
    ("EW_THRU", {("E", "T"), ("E", "R"), ("W", "T"), ("W", "R")}),
    ("EW_LEFT", {("E", "L"), ("W", "L")}),
]
PHASE_NAMES = [p[0] for p in PHASES]


# ---------------------------------------------------------------------------
# Junction types
# ---------------------------------------------------------------------------

def _cross4_spec(permissive: bool) -> dict:
    arms = ["N", "E", "S", "W"]
    moves = {a: ["L", "T", "R"] for a in arms}
    if permissive:
        phases = [
            ("NS", {("N", t) for t in ("L", "T", "R")} | {("S", t) for t in ("L", "T", "R")}),
            ("EW", {("E", t) for t in ("L", "T", "R")} | {("W", t) for t in ("L", "T", "R")}),
        ]
        return {"label": "Kreuzung · permissive Linksabbieger", "arms": arms,
                "movements": moves, "phases": phases, "fixed_greens": [50, 50],
                "signalized": True, "capacity": "signal",
                "permissive": {("N", "L"), ("S", "L"), ("E", "L"), ("W", "L")}}
    return {"label": "Kreuzung (4 Arme, geschützte Linksabbieger)", "arms": arms,
            "movements": moves, "phases": list(PHASES), "fixed_greens": [36, 10, 32, 12],
            "signalized": True, "capacity": "signal", "permissive": set()}


def _t3_spec(permissive: bool) -> dict:
    # T-junction: major road E-W, minor road from the north; no south leg.
    arms = ["E", "W", "N"]
    moves = {"N": ["L", "R"], "E": ["T", "R"], "W": ["T", "L"]}
    phases = [
        ("EW_THRU", {("E", "T"), ("E", "R"), ("W", "T")}),
        ("N_MINOR", {("N", "L"), ("N", "R")}),
        ("W_LEFT", {("W", "L")}),
    ]
    permissive_set = {("W", "L")} if permissive else set()
    return {"label": "T-Kreuzung (3 Arme)", "arms": arms, "movements": moves,
            "phases": phases, "fixed_greens": [34, 12, 10], "signalized": True,
            "capacity": "signal", "permissive": permissive_set}


def _roundabout_spec(permissive: bool) -> dict:
    arms = ["N", "E", "S", "W"]
    moves = {a: ["L", "T", "R"] for a in arms}
    return {"label": "Kreisverkehr (unsignalisiert, Yield)", "arms": arms,
            "movements": moves, "phases": [], "fixed_greens": [],
            "signalized": False, "capacity": "roundabout", "permissive": set()}


JUNCTION_TYPES = {
    "cross4": _cross4_spec,
    "cross4_permissive": lambda p=False: _cross4_spec(True),
    "t3": _t3_spec,
    "roundabout": _roundabout_spec,
}


def junction_spec(junction_type: str, permissive_left: bool = False) -> dict:
    fn = JUNCTION_TYPES.get(junction_type)
    if fn is None:
        raise ValueError("junction_type must be one of " + ", ".join(sorted(JUNCTION_TYPES)))
    return fn(permissive_left)


# ---------------------------------------------------------------------------
# Arrival generation (shared, identical for both controllers)
# ---------------------------------------------------------------------------

def _poisson(rng: random.Random, lam: float) -> int:
    if lam <= 0:
        return 0
    # Knuth's algorithm — fine for small lambda (≈ <= 1 veh/step here).
    limit = math.exp(-lam)
    k, p = 0, 1.0
    while True:
        k += 1
        p *= rng.random()
        if p <= limit:
            return k - 1


def feed_path(cfg: Config) -> Path:
    """Resolve the sensor-feed CSV path (relative to the project root)."""
    p = Path(cfg.arrival_csv or "data/sample_traffic.csv")
    return p if p.is_absolute() else PROJECT_ROOT / p


def open_feed(cfg: Config):
    """Open the sensor feed for reading. Accepts a local path **or an http(s) URL**,
    so a live/published real detector feed can be plugged in later without code
    changes:  { "arrival_source": "csv", "arrival_csv": "https://…/counts.csv" }.
    """
    src = (cfg.arrival_csv or "data/sample_traffic.csv").strip()
    if src.startswith("http://") or src.startswith("https://"):
        req = urllib.request.Request(src, headers={"User-Agent": "SignalFlow/0.1"})
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = resp.read().decode("utf-8", "replace")
        return io.StringIO(data), src
    path = feed_path(cfg)
    if not path.is_file():
        raise ValueError(f"sensor feed not found: {path}")
    return path.open(newline="", encoding="utf-8"), str(path)


def build_arrivals_from_csv(cfg: Config) -> list[dict[Movement, int]]:
    """Build the arrival stream from a sensor-count feed (CSV of detector counts).

    This is the 'reacting to sensor/camera data' path: the demand is *measured*
    counts, not the generator's own rates. A ``detector_dropout`` fraction can be
    applied to model missed detections, making the controller work from a slightly
    lossy sensor view. The feed may be a local file or a remote URL.
    """
    fh, _src = open_feed(cfg)

    buckets: list[dict[Movement, float]] = [dict() for _ in range(cfg.total_steps)]
    feed_seconds = 0
    rows = csv.DictReader(fh)
    for row in rows:
        try:
            if row.get("t_seconds") not in (None, ""):
                sec = int(float(row["t_seconds"]))
            else:
                sec = int(float(row.get("minute", 0))) * 60 + int(float(row.get("second", 0)))
            approach = (row.get("approach") or "").strip().upper()
            turn = (row.get("movement") or row.get("turn") or "").strip().upper()
            count = float(row.get("vehicles_count") or row.get("count") or 0)
        except (ValueError, TypeError):
            continue
        if (approach, turn) not in {(a, m) for a in APPROACHES for m in TURN_MOVEMENTS}:
            continue
        feed_seconds = max(feed_seconds, sec + 1)
        if sec < cfg.total_steps:
            idx = sec
        elif feed_seconds <= cfg.total_steps:
            idx = sec % cfg.total_steps    # tile a shorter feed
        else:
            continue                        # ignore feed beyond the horizon
        b = buckets[idx]
        b[(approach, turn)] = b.get((approach, turn), 0.0) + count
    fh.close()

    if feed_seconds == 0:
        raise ValueError("sensor feed has no usable rows")

    rng = random.Random(cfg.seed + 1)
    keep = 1.0 - cfg.detector_dropout
    arrivals: list[dict[Movement, int]] = []
    for b in buckets:
        # (a warm-up prefix may exist; simulate() simply skips it when counting)
        row: dict[Movement, int] = {}
        for m, c in b.items():
            v = c * cfg.demand_multiplier * keep
            n = int(v) + (1 if rng.random() < (v - int(v)) else 0)
            row[m] = n
        arrivals.append(row)
    return arrivals


def build_arrivals(cfg: Config) -> list[dict[Movement, int]]:
    """Pre-generate the arrival stream so every controller faces it identically
    (including the un-recorded warm-up prefix)."""
    if cfg.arrival_source == "csv":
        return build_arrivals_from_csv(cfg)
    rng = random.Random(cfg.seed)
    steps = cfg.total_steps
    out: list[dict[Movement, int]] = []
    for t in range(steps):
        mult = cfg.profile_multiplier(t)
        row: dict[Movement, int] = {}
        for a, mv in cfg.movements():
            rate = cfg.rate(a, mv) * cfg.demand_multiplier * cfg.scenario_multiplier * mult
            lam = rate / 3600.0 * cfg.dt
            row[(a, mv)] = _poisson(rng, lam)
        out.append(row)
    return out


def build_bus_arrivals(cfg: Config) -> list[tuple[int, Movement]]:
    """Bus arrival stream for transit signal priority (TSP).

    Buses arrive at a mean headway ``bus_headway_s`` (± 25 % jitter) on the
    highest-demand movements (through-heavy), i.e. a plausible bus route crossing
    the junction. Each bus is charged its PCE in the queue and, when
    ``transit_priority`` is on, the controller gives it green (see
    ``MaxPressureController``).
    """
    if not cfg.transit_priority:
        return []
    rng = random.Random(cfg.seed + 7)
    weights = [(a, mv, cfg.rate(a, mv)) for (a, mv) in cfg.movements()
               if mv in ("T", "L") and cfg.rate(a, mv) > 0]
    total = sum(w for _, _, w in weights) or 1.0
    cum, acc = [], 0.0
    for a, mv, w in weights:
        acc += w / total
        cum.append((acc, (a, mv)))

    def pick() -> Movement:
        r = rng.random()
        for c, m in cum:
            if r <= c:
                return m
        return cum[-1][1]

    events: list[tuple[int, Movement]] = []
    t = rng.randint(20, cfg.bus_headway_s)
    while t < cfg.total_steps:
        events.append((t, pick()))
        t += max(30, int(cfg.bus_headway_s * (0.75 + 0.5 * rng.random())))
    return events


BUS_BONUS = 10.0        # pressure bonus for a phase holding a waiting bus
BUS_EXTEND_S = 8        # extra green seconds to clear a bus already on green


# ---------------------------------------------------------------------------
# Controllers
# ---------------------------------------------------------------------------

class Controller:
    name = "controller"

    def reset(self, cfg: Config) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def step(self, t: int, q: dict[Movement, float], cfg: Config,
             buses: dict | None = None, flows: dict | None = None) -> dict:
        raise NotImplementedError


class FixedTimeController(Controller):
    """Baseline: a fixed cycle plan, identical every cycle (no adaptivity)."""

    name = "fixed"

    def reset(self, cfg: Config) -> None:
        self.plan: list[tuple[str, frozenset, str, int]] = []
        phases = cfg.phases()
        greens = cfg.fixed_greens_effective()
        if not phases:
            self.plan.append(("none", frozenset(), "green", 60))
        for (pname, pmoves), g in zip(phases, greens):
            self.plan.append((pname, frozenset(pmoves), "green", int(g)))
            self.plan.append((pname, frozenset(), "yellow", int(cfg.fixed_yellow)))
            self.plan.append((pname, frozenset(), "all_red", int(cfg.fixed_all_red)))
        self.pos = 0
        self.remaining = self.plan[0][3]
        self.plan_info = {
            "cycle_s": sum(e[3] for e in self.plan),
            "greens": [int(g) for g in greens],
            "source": "fester Tagesplan (Konfiguration, Webster-Splits)",
        }

    def green_set(self) -> frozenset:
        return self.plan[self.pos][1]

    def step(self, t, q, cfg, buses=None, flows=None) -> dict:
        pname, gre, kind, _ = self.plan[self.pos]
        dec = {"phase": pname if kind != "all_red" else pname, "kind": kind,
               "green": set(gre), "switch": False}
        self.remaining -= 1
        if self.remaining <= 0:
            self.pos = (self.pos + 1) % len(self.plan)
            self.remaining = self.plan[self.pos][3]
        return dec


class RoundaboutController(Controller):
    """Signal-free (yield) control: every entry may discharge, limited by the
    roundabout entry capacity computed in ``Config.roundabout_capacity``."""
    name = "roundabout"

    def reset(self, cfg: Config) -> None:
        self.phase = 0

    def step(self, t, q, cfg, buses=None, flows=None) -> dict:
        return {"phase": "roundabout", "kind": "green",
                "green": set(cfg.movements()), "switch": False,
                "reason": "yield (unsignalised roundabout)"}


class MaxPressureController(Controller):
    """Adaptive controller.

    Chooses the phase with the highest *pressure* = weighted queue on the phases'
    movements, plus a starvation bonus for movements that have been waiting too
    long. Enforces min/max green, yellow and all-red clearance. Records a
    human-readable rationale for every decision so the dashboard/LLM can explain
    it (the challenge explicitly rewards explainability).
    """

    name = "adaptive"

    def reset(self, cfg: Config) -> None:
        self.cfg = cfg
        self.phases = cfg.phases() or PHASES
        self.phase_names = [p[0] for p in self.phases]
        self.cur = 0
        self.elapsed = 0
        self.mode = "green"           # green | yellow | all_red
        self.pending = 0
        self.last_green_t = {m: 0 for m in all_movements()}
        self.last_pressure: dict[str, float] = {n: 0.0 for n in self.phase_names}

    # -- pressure -----------------------------------------------------------
    def _pressures(self, t: int, q: dict[Movement, float],
                   buses: dict | None = None) -> tuple[list[float], list[float]]:
        cfg = self.cfg
        buses = buses or {}
        pres, waits = [], []
        for _, pmoves in self.phases:
            p = 0.0
            wmax = 0.0
            for m in pmoves:
                lanes = max(1, cfg.lanes[m[1]])
                p += q[m] / lanes                     # normalise by lane count
                wmax = max(wmax, t - self.last_green_t[m])
                # transit priority: a waiting bus makes its phase attractive
                if buses.get(m, 0) > 0:
                    p += BUS_BONUS
            # Starvation guard: a movement starved too long gets an escalating bias.
            if wmax > cfg.starve_seconds:
                p += 6.0 + (wmax - cfg.starve_seconds) * 0.25
            pres.append(round(p, 3))
            waits.append(round(wmax, 1))
        return pres, waits

    def step(self, t, q, cfg, buses=None, flows=None) -> dict:
        buses = buses or {}
        pres, waits = self._pressures(t, q, buses)
        self.last_pressure = dict(zip(self.phase_names, pres))
        cur_name = self.phase_names[self.cur]
        cur_green = set(self.phases[self.cur][1]) if self.mode == "green" else set()

        decision = {"phase": cur_name, "kind": self.mode, "green": cur_green,
                    "switch": False, "pressures": dict(zip(self.phase_names, pres)),
                    "waits": dict(zip(self.phase_names, waits))}

        if self.mode == "green":
            self.elapsed += 1
            best = max(range(len(self.phases)), key=lambda i: pres[i])
            cur_p = pres[self.cur]
            # Which competing phases actually have unmet demand to serve?
            funded = [i for i in range(len(self.phases))
                      if i != self.cur and pres[i] > 0.6]
            best_funded = max(funded, key=lambda i: pres[i]) if funded else None
            beat = (best_funded is not None
                    and pres[best_funded] > cur_p * cfg.switch_hysteresis + 0.5)
            can_switch = self.elapsed >= cfg.min_green
            bus_here = any(buses.get(m, 0) > 0 for m in self.phases[self.cur][1])
            must_switch = self.elapsed >= cfg.max_green + (BUS_EXTEND_S if bus_here else 0)
            # End a fully-served (empty) phase early instead of wasting green.
            empty_done = (self.elapsed >= cfg.empty_exit_green and cur_p < 0.5
                          and best_funded is not None)
            # transit priority preemption: a phase holding a waiting bus wins
            bus_phase = next((i for i in range(len(self.phases))
                              if i != self.cur and any(buses.get(m, 0) > 0
                                                       for m in self.phases[i][1])), None)
            preempt = bus_phase is not None and not bus_here
            if must_switch or (can_switch and beat) or empty_done or (can_switch and preempt):
                if can_switch and preempt:
                    target = bus_phase
                else:
                    target = best if best_funded is None else best_funded
                if target == self.cur:
                    # Nothing better to serve (e.g. empty intersection): hold the
                    # current phase instead of a phantom switch (no wasted clearance).
                    decision["reason"] = (
                        f"hold {cur_name}: no funded competing phase, green {self.elapsed}s")
                    return decision
                if can_switch and preempt:
                    why = "bus priority (TSP)"
                elif must_switch and not (can_switch and beat) and not empty_done:
                    why = "max green reached"
                elif empty_done and not (can_switch and beat):
                    why = "phase served out (empty queue)"
                else:
                    why = "higher competing pressure"
                decision["switch"] = True
                self.pending = target
                self.mode = "yellow"
                self.elapsed = 0
                decision["kind"] = "yellow"
                decision["green"] = set()
                decision["reason"] = (
                    f"switch {cur_name}->{self.phase_names[target]} ({why}): "
                    f"pressure {pres[target]:.1f} vs current {cur_p:.1f}; "
                    f"worst wait {waits[target]:.0f}s")
                decision["to"] = self.phase_names[target]
            else:
                decision["reason"] = (
                    f"hold {cur_name}: highest current pressure {cur_p:.1f}, "
                    f"competitor {pres[best]:.1f}, green {self.elapsed}s")
        elif self.mode == "yellow":
            self.elapsed += 1
            decision["green"] = set()
            if self.elapsed >= cfg.yellow:
                self.mode = "all_red"
                self.elapsed = 0
        elif self.mode == "all_red":
            self.elapsed += 1
            decision["green"] = set()
            if self.elapsed >= cfg.all_red:
                self.cur = self.pending
                self.mode = "green"
                self.elapsed = 0
                for m in self.phases[self.cur][1]:
                    self.last_green_t[m] = t
                decision["phase"] = self.phase_names[self.cur]

        return decision


class CoordinatedController(FixedTimeController):
    """Green-wave coordination (corridor plan) applied to a single junction.

    Real coordination binds a junction to its neighbours via a *shared cycle
    length* and *progression offsets*; splits favour the main (coordinated)
    axis at the expense of the side street. This controller reproduces exactly
    that: the junction may not choose its Webster optimum but must run the
    corridor master cycle (:pyattr:`Config.coord_cycle_s`, typically 90 s),
    starts at the corridor offset, and gives the busier axis a green-share
    bias (``coord_bias``).

    Honest expectation at an *isolated* node: roughly fixed-time performance
    (sometimes slightly worse) — with Poisson arrivals there are no platoons,
    so the progression benefit of coordination cannot materialise here. It
    does materialise in the district model (see ``network.py``), which is the
    whole point of the corridor plan.
    """

    name = "coordinated"

    def __init__(self, cycle: int = 90, offset: int = 12, bias: float = 1.25):
        self.cycle = int(cycle)
        self.offset = int(offset)
        self.bias = float(bias)
        self.plan_info: dict = {}

    def reset(self, cfg: Config) -> None:
        phases = cfg.phases()
        if not phases:
            self.plan = [("none", frozenset(), "green", 60)]
            self.pos = 0
            self.remaining = 60
            return
        yellow, all_red = int(cfg.fixed_yellow), int(cfg.fixed_all_red)
        lost = len(phases) * (yellow + all_red)
        available = max(len(phases) * MIN_GREEN_S, self.cycle - lost)

        # axis demand (veh/h): which axis carries the corridor?
        def axis_of(pmoves) -> str:
            return "NS" if any(m[0] in ("N", "S") for m in pmoves) else "EW"
        ns = sum(cfg.rate(a, mv) for (a, mv) in cfg.movements() if a in ("N", "S"))
        ew = sum(cfg.rate(a, mv) for (a, mv) in cfg.movements() if a in ("E", "W"))
        main_axis = "NS" if ns >= ew else "EW"

        # phase demand, biased toward the coordinated axis, normalised to the
        # cycle; every phase keeps its realistic minimum green
        dem = [sum(cfg.rate(a, mv) for (a, mv) in pmoves) for _, pmoves in phases]
        biased = [d * (self.bias if axis_of(pm) == main_axis else 1.0 / self.bias)
                  for d, (_, pm) in zip(dem, phases)]
        total = sum(biased) or 1.0
        greens = _int_split([max(float(MIN_GREEN_S), available * b / total)
                             for b in biased], available, floor=MIN_GREEN_S)

        self.plan = []
        for (pname, pmoves), g in zip(phases, greens):
            self.plan.append((pname, frozenset(pmoves), "green", int(g)))
            self.plan.append((pname, frozenset(), "yellow", yellow))
            self.plan.append((pname, frozenset(), "all_red", all_red))
        self.pos = 0
        self.remaining = self.plan[0][3]
        # progression offset: enter the plan mid-cycle, as the corridor dictates
        off = self.offset % sum(e[3] for e in self.plan)
        while off >= self.plan[self.pos][3]:
            off -= self.plan[self.pos][3]
            self.pos = (self.pos + 1) % len(self.plan)
        self.remaining = self.plan[self.pos][3] - off
        self.plan_info = {"cycle_s": sum(e[3] for e in self.plan),
                          "target_cycle_s": self.cycle,
                          "offset_s": self.offset,
                          "main_axis": main_axis, "bias": self.bias,
                          "greens": list(greens),
                          "source": f"Korridor-Takt {self.cycle}s, Offset {self.offset}s"}


# Tuned* time-of-day buckets (clock hours): real practice is a multi-period
# plan ("Mehrfahrzeitenplan"), not one daily average — counts of each bucket
# produce their own Webster plan, switched by the clock.
TUNED_BUCKETS = ((6, 10), (10, 15), (15, 21))

# Realistic minimum green for every phase. RiLSA 2015 (still the valid German
# rule set): vehicle streams need at least 10 s green; pedestrians get >= 5 s
# plus clearance time (separate pedestrian phases are not modelled — disclosed).
# Computed plans may never go below this, even under coordination bias.
MIN_GREEN_S = 10
# RiLSA cycle range: 30-90 s usual, at most 120 s — Webster cycles are clamped
MAX_CYCLE_S = 120


def _tuned_bucket(h: float) -> int:
    if 6 <= h < 10:
        return 0
    if 10 <= h < 15:
        return 1
    if 15 <= h < 21:
        return 2
    return 0 if h < 6 else 2


def _peak_hour_rates(secs: list[dict[Movement, float]]) -> dict[Movement, float]:
    """Flow rates (veh/h) of the busiest hour inside a bucket.

    Signal plans are designed for the peak hour, not the bucket mean — Webster
    on diluted means undersizes the cycle and collapses at rush.
    """
    n = len(secs)
    if n == 0:
        return {}
    moves = list(secs[0].keys())
    prefix = {m: [0.0] * (n + 1) for m in moves}
    for i, row in enumerate(secs):
        for m in moves:
            prefix[m][i + 1] = prefix[m][i] + row.get(m, 0.0)
    span = min(3600, n)
    best_t, best_v = 0, -1.0
    for s in range(0, n - span + 1):
        v = sum(prefix[m][s + span] - prefix[m][s] for m in moves)
        if v > best_v:
            best_v, best_t = v, s
    return {m: (prefix[m][best_t + span] - prefix[m][best_t]) / span * 3600.0
            for m in moves}


class TunedController(FixedTimeController):
    """Webster plans *derived from stop-line detector counts*.

    The junction-level twin of the district model's ``fixed_tuned_est``
    ("Tuned*"): real detectors count arriving vehicles per movement; from those
    counts the controller computes critical flow ratios and Webster-optimal
    cycle/green splits — one plan per time-of-day bucket (morning, midday,
    evening), switched by the clock. In the simulation the counts are the
    PCE-weighted arrivals of the shared stream — exactly what a stop-line
    counter would have measured. No adaptivity mid-bucket: the plan is fixed.
    """

    name = "tuned"

    def __init__(self, bucket_counts: list[dict[Movement, float]] | None = None,
                 buckets: tuple = TUNED_BUCKETS):
        self.bucket_counts = bucket_counts or []
        self.buckets = buckets
        self.plan_info: dict = {}

    def _webster(self, cfg: Config, counts: dict[Movement, float]) -> tuple[list, dict]:
        phases = cfg.phases()
        yellow, all_red = int(cfg.fixed_yellow), int(cfg.fixed_all_red)
        lost = len(phases) * (yellow + all_red)
        sat = cfg.sat_flow_effective
        # Webster: per phase the *critical* (max) movement flow ratio v/s
        y = []
        for _, pmoves in phases:
            ratios = [counts.get(m, 0.0) / (max(1, cfg.lanes[m[1]]) * sat)
                      for m in pmoves]
            y.append(max(ratios) if ratios else 0.0)
        Y = sum(y)
        if Y <= 1e-6:
            equal = max(len(phases) * MIN_GREEN_S, 60 - lost) / len(phases)
            greens = [int(round(equal))] * len(phases)
        else:
            cycle = int(min(MAX_CYCLE_S, max(40, (1.5 * lost + 5) / (1.0 - min(0.95, Y)))))
            available = max(len(phases) * MIN_GREEN_S, cycle - lost)
            greens = _int_split([max(float(MIN_GREEN_S), available * yi / Y)
                                 for yi in y], available, floor=MIN_GREEN_S)
        plan = []
        for (pname, pmoves), g in zip(phases, greens):
            plan.append((pname, frozenset(pmoves), "green", int(g)))
            plan.append((pname, frozenset(), "yellow", yellow))
            plan.append((pname, frozenset(), "all_red", all_red))
        info = {"cycle_s": sum(e[3] for e in plan), "greens": list(greens),
                "flow_ratios": [round(v, 3) for v in y],
                "y_total": round(Y, 3)}
        return plan, info

    def reset(self, cfg: Config) -> None:
        self.plans: list[tuple[list, dict]] = []
        for counts in self.bucket_counts:
            self.plans.append(self._webster(cfg, counts))
        if not self.plans:
            plan, info = self._webster(cfg, {})
            self.plans = [(plan, info)]
        # empty buckets fall back to the busiest bucket's plan
        nonempty = [i for i, (_, inf) in enumerate(self.plans) if inf["y_total"] > 1e-6]
        self.fallback_idx = nonempty[0] if nonempty else 0
        self.active = None
        self.plan = self.plans[self.fallback_idx][0]
        self.pos = 0
        self.remaining = self.plan[0][3]
        self.plan_info = {
            "buckets": [{"from_h": b[0], "to_h": b[1], **inf}
                        for b, (_, inf) in zip(self.buckets, self.plans)],
            "source": "Stopp-Linien-Zählungen je Tageszeit, Webster-Zyklus und -Splits",
        }

    def step(self, t, q, cfg, buses=None, flows=None) -> dict:
        if self.plans:
            idx = _tuned_bucket(cfg.clock_at(t) / 3600.0) if cfg.has_window else 0
            _, info = self.plans[idx]
            if info["y_total"] <= 1e-6:
                idx = self.fallback_idx
            if idx != self.active:
                self.active = idx
                self.plan = self.plans[idx][0]
                self.pos = 0
                self.remaining = self.plan[0][3]
        return super().step(t, q, cfg, buses, flows)


# ---------------------------------------------------------------------------
# Simulation harness
# ---------------------------------------------------------------------------

def _opposite_through(m: Movement) -> Movement | None:
    a, turn = m
    opp = {"N": "S", "S": "N", "E": "W", "W": "E"}.get(a)
    return (opp, "T") if opp else None


def simulate(cfg: Config, arrivals: list[dict[Movement, int]], controller: Controller,
             frame_target: int = 400, warmup: int = 0) -> dict:
    """Run one controller over the shared arrival stream.

    ``warmup`` skips the first N seconds when accumulating KPIs (the system
    starts "in traffic" instead of empty); frames/decisions also cover only the
    recorded span, with frame ``t`` rebased to 0 at the end of the warm-up.
    """
    moves = cfg.movements()
    q: dict[Movement, float] = {m: 0.0 for m in moves}
    # effective saturation flow is reduced by the heavy-vehicle mix (PCE)
    sat_eff = cfg.sat_flow_effective
    if cfg.spec()["capacity"] == "roundabout":
        cap = cfg.roundabout_capacity()
        svc = {m: cap[m] / 3600.0 * cfg.dt for m in moves}
    else:
        svc = {m: cfg.lanes[m[1]] * sat_eff * cfg.dt / 3600.0 for m in moves}
    permissive = set(cfg.spec().get("permissive") or ())
    controller.reset(cfg)

    # buses (transit signal priority)
    bus_events = build_bus_arrivals(cfg)
    bidx = 0
    bus_queue: dict[Movement, int] = {m: 0 for m in moves}
    buses_arrived = 0
    bus_delay = 0.0

    arrived = served = 0
    delay = 0.0
    wasted = 0.0
    max_q = 0.0
    q_sum = 0.0
    rec_steps = 0
    stops = 0
    decisions: list[dict] = []

    sample_every = max(1, cfg.steps // max(1, frame_target))
    frames: list[dict] = []

    for t_raw, row in enumerate(arrivals):
        rec = t_raw >= warmup            # warm-up runs, but is not counted
        t = t_raw - warmup               # recorded clock (0 = window start)
        # 1) arrivals
        for m, n in row.items():
            if n:
                q[m] += n
                if rec:
                    arrived += n
                    if q[m] - n >= 0.5:
                        stops += n       # arrived into a non-empty lane -> slowed

        # 1b) buses arriving this second (charged their PCE in the queue)
        while bidx < len(bus_events) and bus_events[bidx][0] == t_raw:
            bm = bus_events[bidx][1]
            q[bm] += PCE["bus"]
            bus_queue[bm] += 1
            if rec:
                buses_arrived += 1
            bidx += 1

        # 2) controller decision
        dec = controller.step(t, q, cfg, buses=bus_queue)
        green = dec["green"]

        # 3) serve
        step_served = 0
        for m in green:
            if m not in svc:
                continue
            eff = svc[m]
            # permissive left: yields to the opposing through flow (gap acceptance)
            if m in permissive:
                opp = _opposite_through(m)
                if opp is not None and q.get(opp, 0.0) > 1.0:
                    eff *= 0.45
            s = min(q[m], eff)
            q[m] -= s
            step_served += s
        served += step_served

        # 3b) a bus leaves once its movement has cleared
        for m in green:
            if bus_queue[m] and q[m] < 0.5:
                bus_queue[m] = 0

        # 4) metrics (recorded span only)
        if rec:
            q_now = sum(q.values())
            q_sum += q_now
            rec_steps += 1
            max_q = max(max_q, q_now)
            delay += q_now * cfg.dt
            bus_delay += sum(bus_queue.values()) * cfg.dt
            if green and all(q[m] < 0.5 for m in green):
                wasted += cfg.dt

            if dec.get("switch"):
                decisions.append({
                    "t": t,
                    "from": dec.get("phase"),
                    "to": dec.get("to"),
                    "reason": dec.get("reason"),
                    "pressures": dec.get("pressures"),
                })

            if t % sample_every == 0 or t_raw == len(arrivals) - 1:
                frames.append({
                    "t": t,
                    "phase": dec["phase"],
                    "kind": dec["kind"],
                    "green": sorted(f"{a}-{mv}" for a, mv in green),
                    "q": {f"{a}-{mv}": round(q[(a, mv)], 2) for (a, mv) in moves},
                    "served": round(step_served, 2),
                    "delay_s": round(delay, 1),
                })

    summary = {
        "controller": controller.name,
        "arrived": arrived,
        "served": served,
        "avg_delay_s": round(delay / max(1, arrived), 2),
        "avg_queue": round(q_sum / max(1, rec_steps), 3),
        "max_queue": round(max_q, 2),
        "throughput_vph": round(served / (cfg.steps / 3600.0), 1),
        "stops": stops,
        "wasted_green_s": round(wasted, 1),
        "buses_arrived": buses_arrived,
        "avg_bus_delay_s": round(bus_delay / max(1, buses_arrived), 2) if buses_arrived else 0.0,
        "total_delay_vehsec": round(delay, 1),
        "co2_g": round(delay * cfg.co2_idle_g_per_s, 1),
        "left_in_system": round(sum(q.values()), 2),
    }
    return {"summary": summary, "frames": frames, "decisions": decisions,
            "frame_dt": sample_every}


def run_scenario(cfg_dict: dict | None = None, frame_target: int = 400) -> dict:
    """Run every controller on identical arrivals and return a full payload.

    Signalised junctions compare **four** strategies (Fixed, Adaptive,
    Coordinated, Tuned); a roundabout compares the signalised reference against
    unsignalised yield control. The wall-clock window (``time_from``/``time_to``)
    drives the within-day demand and ``warmup_min`` is simulated un-recorded.
    """
    cfg = Config.from_dict(cfg_dict)
    warmup = int(cfg.warmup_min) * 60
    arrivals = build_arrivals(cfg)

    if cfg.signalized:
        # stop-line detector counts per time-of-day bucket (PCE-weighted):
        # what a counter at the stop line would have measured in the window;
        # each bucket yields the rates of its own busiest hour (peak-hour design)
        nb = len(TUNED_BUCKETS)
        b_secs: list[list[dict[Movement, float]]] = [[] for _ in range(nb)]
        for i, row in enumerate(arrivals[warmup:]):
            idx = _tuned_bucket(cfg.clock_at(i) / 3600.0) if cfg.has_window else 1
            b_secs[idx].append({m: n * cfg.pce_avg for m, n in row.items()})
        bucket_counts = [_peak_hour_rates(secs) for secs in b_secs]
        controllers = {
            "fixed": FixedTimeController(),
            "adaptive": MaxPressureController(),
            "coordinated": CoordinatedController(cfg.coord_cycle_s, cfg.coord_offset_s,
                                                 cfg.coord_bias),
            "tuned": TunedController(bucket_counts),
        }
        runs = {k: simulate(cfg, arrivals, c, frame_target, warmup)
                for k, c in controllers.items()}
        ref_label, alt_label = "Fixed-Time", "Adaptiv"
    else:
        # roundabout: compare a signalised reference (cross4 plan on the same arms)
        # against the unsignalised roundabout on identical demand
        sig = Config.from_dict({**cfg.to_dict(), "junction_type": "cross4",
                                "permissive_left": False})
        sig.fixed_greens = [36, 10, 32, 12]
        controllers = {"fixed": FixedTimeController(), "adaptive": RoundaboutController()}
        runs = {k: simulate(sig if k == "fixed" else cfg, arrivals, c, frame_target, warmup)
                for k, c in controllers.items()}
        ref_label, alt_label = "Signalanlage", "Kreisverkehr"

    f, a = runs["fixed"]["summary"], runs["adaptive"]["summary"]

    def pct_reduction(base: float, new: float) -> float:
        return round((base - new) / base * 100.0, 1) if base else 0.0

    improvement = {
        "avg_delay_pct": pct_reduction(f["avg_delay_s"], a["avg_delay_s"]),
        "throughput_pct": (round((a["throughput_vph"] - f["throughput_vph"]) /
                                 f["throughput_vph"] * 100.0, 1) if f["throughput_vph"] else 0.0),
        "max_queue_pct": pct_reduction(f["max_queue"], a["max_queue"]),
        "co2_pct": pct_reduction(f["co2_g"], a["co2_g"]),
        "wasted_green_pct": pct_reduction(f["wasted_green_s"], a["wasted_green_s"]),
    }

    def plan_of(key: str) -> dict | None:
        ctrl = controllers.get(key)
        return getattr(ctrl, "plan_info", None)

    out = {
        "config": cfg.to_dict(),
        "phases": cfg.phase_names(),
        "junction": {"type": cfg.junction_type, "label": cfg.spec()["label"],
                     "arms": cfg.arms(), "movements": [f"{a2}-{mv}" for a2, mv in cfg.movements()],
                     "signalized": cfg.signalized, "permissive_left": cfg.permissive_left,
                     "reference_label": ref_label, "alternative_label": alt_label},
        "scenario": {"name": cfg.demand_scenario, "label": cfg.scenario["label"],
                     "multiplier": cfg.scenario_multiplier, "profile": cfg.profile_name(),
                     "vehicle_mix": dict(cfg.vehicle_mix), "pce_avg": round(cfg.pce_avg, 3),
                     "transit_priority": cfg.transit_priority,
                     "time_from": cfg.time_from, "time_to": cfg.time_to,
                     "warmup_min": cfg.warmup_min, "clock": cfg.has_window},
        "summary": {"fixed": f, "adaptive": a},
        "improvement": improvement,
        "bus": {"arrived": f.get("buses_arrived", 0),
                "avg_delay_fixed_s": f.get("avg_bus_delay_s", 0.0),
                "avg_delay_adaptive_s": a.get("avg_bus_delay_s", 0.0)},
        "fixed": {"frames": runs["fixed"]["frames"], "plan": plan_of("fixed")},
        "adaptive": {"frames": runs["adaptive"]["frames"],
                     "decisions": runs["adaptive"]["decisions"][:200]},
        "meta": {
            "steps": cfg.steps,
            "frame_dt": runs["fixed"]["frame_dt"],
            "arrival_source": cfg.arrival_source,
            "time_from": cfg.time_from, "time_to": cfg.time_to,
            "warmup_min": cfg.warmup_min, "clock": cfg.has_window,
            "generated": "SignalFlow v0.1 (queueing model, dt=1s)",
        },
    }
    if cfg.signalized:
        out["summary"]["coordinated"] = runs["coordinated"]["summary"]
        out["summary"]["tuned"] = runs["tuned"]["summary"]
        out["coordinated"] = {"frames": runs["coordinated"]["frames"],
                              "plan": plan_of("coordinated")}
        out["tuned"] = {"frames": runs["tuned"]["frames"], "plan": plan_of("tuned")}
        out["junction"]["policies"] = [
            {"key": "fixed", "label": "Fixed"},
            {"key": "adaptive", "label": "Adaptiv"},
            {"key": "coordinated", "label": "Koord."},
            {"key": "tuned", "label": "Tuned*"},
        ]
    return out


if __name__ == "__main__":  # tiny CLI smoke test
    import json
    out = run_scenario({"duration_min": 10})
    print(json.dumps({"fixed": out["summary"]["fixed"],
                      "adaptive": out["summary"]["adaptive"],
                      "improvement": out["improvement"]}, indent=2))
