# Operations

## Requirements

* Python **3.11+** (tested on 3.14). No third-party packages.
* Any modern browser (Chrome/Edge recommended; Canvas + `fetch`).

## Run

```bash
cd signalflow
./run.sh                 # or: python3 server.py
# open http://127.0.0.1:8000        (junction)
#      http://127.0.0.1:8000/network.html  (district)
```

Environment overrides (or put them in `.env`):

| Variable | Default | Meaning |
|---|---|---|
| `SIGNALFLOW_HOST` | `127.0.0.1` | bind address |
| `SIGNALFLOW_PORT` | `8000` | port |
| `FEATHERLESS_API_KEY` | – | enables free-form explanations |
| `FEATHERLESS_MODEL` | `Qwen/Qwen2.5-7B-Instruct` | any Featherless catalogue id |
| `ELEVENLABS_API_KEY` | – | enables voice output |
| `ELEVENLABS_VOICE` | `21m00Tcm4TlvDq8ikWAM` | voice id (default "Rachel") |

Copy `.env.example` to `.env` and fill in what you have. Keys never reach the
browser — the server makes the outbound calls.

## Test

```bash
python3 -m unittest discover -s tests -v          # 55 tests
node --check web/app.js && node --check web/network.js
```

## Rebuild the region data (optional)

```bash
python3 tools/fetch_osm.py        # Overpass -> data/osm/*.json   (network needed)
python3 tools/build_regions.py    # -> data/regions/*.json
python3 tools/verify_regions.py   # sanity checks + stats table
```

Regions are derived from OpenStreetMap (ODbL). Re-running is only needed to change
the bounding boxes or refresh the data.

## Add a region live (demo feature)

```bash
python3 -m signalflow.geofetch "Tübingen Zentrum" --span 0.010
# or via the dashboard: network.html → „Ort hinzufügen“
# or: POST /api/regions_add {"query":"Marienplatz München","span_deg":0.008}
```

Flow: **Nominatim geocode → Overpass fetch → graph build → `data/regions/<id>.json`**;
the new region appears immediately in the selector. Takes a few seconds (network);
`span_deg` is capped at 0.05° (~5 km). Requires internet at demo time.

## Licensing

* Code: **PolyForm Noncommercial 1.0.0** ([LICENSE](../LICENSE)) - source-available, non-commercial.
* OSM-derived data: **ODbL** — attribution + share-alike for the data itself.
* Third-party APIs (Featherless, ElevenLabs): their terms apply.
* See [NOTICE.md](../NOTICE.md) for the AI-assistance disclosure and what to
  verify in the hackathon rules (the Devpost `/rules` page was not fetchable here).

## Configuration

* **Junction:** `duration_min`, `seed`, `demand_multiplier`, `demand_profile`,
  `arrival_source`/`arrival_csv`/`detector_dropout`, per-movement `demand`,
  `lanes`, `fixed_greens`, and the adaptive parameters (`min_green`, `max_green`,
  `switch_hysteresis`, `starve_seconds`).
* **District:** `region`, `duration_min`, `seed`, `demand_multiplier`,
  `demand_profile`, `total_vph`.

See [api.md](api.md) for the full request schemas.

## Tuning the controller

The shipped parameters come from a demand-grid sweep (see
[controllers.md](controllers.md#calibration)). To re-tune:

```bash
python3 - <<'PY'
from signalflow.simulation import Config, build_arrivals, simulate, FixedTimeController, MaxPressureController
grid=[(dm,p) for dm in (0.8,0.9,1.0,1.1) for p in ("flat","peak")]
def score(p):
    vals=[]
    for dm,prof in grid:
        cfg=Config.from_dict({"duration_min":30,"demand_multiplier":dm,"demand_profile":prof,**p})
        a=build_arrivals(cfg)
        f=simulate(cfg,a,FixedTimeController())["summary"]["avg_delay_s"]
        m=simulate(cfg,a,MaxPressureController())["summary"]["avg_delay_s"]
        vals.append((f-m)/f*100)
    return sum(vals)/len(vals)
for p in ({"min_green":20,"switch_hysteresis":2.6},{"min_green":24,"switch_hysteresis":3.0}):
    print(p, round(score(p),1), "%")
PY
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Dashboard shows "Offline-Demo-Modus" | backend not reachable — start `python3 server.py`, open via `http://127.0.0.1:8000`, not `file://` |
| Voice button reports "not configured" | no `ELEVENLABS_API_KEY`; add it to `.env` and restart |
| `/api/explain` returns `"source":"fallback"` | no Featherless key or API error; still answers locally |
| `/api/simulate_network` → 400 *unknown region* | run `tools/fetch_osm.py` + `tools/build_regions.py` |
| Very large `innenstadt` payload | expected (~3 MB); reduce `duration_min` or pick a smaller region |
| Browser tab heavy during district replay | lower the speed or switch to a single controller view |

## Production notes (beyond the demo)

* Bind to `127.0.0.1` by default for safety; put a reverse proxy in front for any
  public exposure.
* The server is single-purpose (static files + JSON); a WASGI/ASGI server is
  unnecessary for the demo but could replace `http.server` for concurrency.
* Keys are read from `.env`/environment; never commit `.env` (it is gitignored).

## Live-check the keys

```bash
# after putting FEATHERLESS_API_KEY / ELEVENLABS_API_KEY in .env
python3 tools/check_keys.py          # live probe, never echoes the key
curl -s localhost:8000/api/keys      # same info over HTTP (no secrets)
```

`/api/explain` returns `"source":"featherless"` (with the model id used) once the
Featherless key is set — otherwise it falls back to the offline explainer. The
districts/junction behaviour is unaffected either way. Featherless models are tried
in order (`FEATHERLESS_MODEL`, then built-in fallbacks) so a model that is not
enabled on the account does not break the demo.
