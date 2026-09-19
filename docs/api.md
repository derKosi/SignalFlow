# HTTP API

Base URL: `http://127.0.0.1:8000` (override with `SIGNALFLOW_HOST` / `SIGNALFLOW_PORT`).
All responses are JSON unless noted. `Access-Control-Allow-Origin: *` is set.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | junction dashboard (HTML) |
| GET | `/network.html` | district dashboard (HTML) |
| GET | `/api/health` | integration status |
| GET | `/api/config` | default junction config |
| GET | `/api/feed` | preview the sensor-count feed |
| GET | `/api/regions` | available districts + graph stats |
| GET | `/api/scenarios` | demand scenarios + vehicle classes (PCE) |
| POST | `/api/simulate` | run one junction: fixed vs adaptive |
| POST | `/api/simulate_network` | run a district: fixed, tuned (oracle + count-based), adaptive, coordinated |
| POST | `/api/agent` | agentic copilot: LLM runs simulator tools, then answers (`mode:"panel"` = self-checking) |
| POST | `/api/explain` | natural-language explanation of the last run |
| POST | `/api/tts` | ElevenLabs speech (audio/mpeg) |

Error handling: malformed JSON or invalid config → **400** with `{"error": "..."}`;
unknown route → **404**; missing ElevenLabs key → **501**; unexpected error → **500**
(the server never crashes on bad input).

---

## GET /api/health
```json
{ "ok": true, "version": "0.1.0", "featherless": false, "elevenlabs": false }
```

## GET /api/feed
```json
{ "path": "signalflow/data/sample_traffic.csv",
  "columns": ["t_seconds","minute","second","approach","movement","vehicles_count"],
  "rows_total": 43200, "rows": [["0","0","00","N","L","0"], ...] }
```

## GET /api/regions
```json
{ "regions": [
  { "id": "expo_riem", "name": "Messe Muenchen / ICM Riem",
    "bbox": [48.128, 11.683, 48.144, 11.708],
    "stats": { "nodes": 355, "links": 569, "signals": 153, "junctions": 35 } },
  { "id": "innenstadt", "name": "Muenchen Innenstadt / Altstadtring",
    "bbox": [48.128, 11.545, 48.15, 11.59],
    "stats": { "nodes": 2597, "links": 4159, "signals": 1608, "junctions": 191 } } ] }
```

## POST /api/simulate
Request (all fields optional):
```json
{ "duration_min": 30, "seed": 42, "demand_multiplier": 1.0, "demand_profile": "peak",
  "demand_scenario": "normal", "vehicle_mix": {"car":1.0}, "transit_priority": false,
  "bus_headway_s": 240, "arrival_source": "model", "arrival_csv": null, "detector_dropout": 0.0,
  "demand": { "N": {"T":720,"L":140,"R":120}, "E": {...}, "S": {...}, "W": {...} },
  "lanes": { "T": 2, "L": 1, "R": 1 },
  "fixed_greens": [36,10,32,8], "min_green": 24, "max_green": 50,
  "switch_hysteresis": 3.0, "starve_seconds": 120 }
```
`demand_scenario` ∈ {normal, berufsverkehr, ferien, freizeit, custom}. `vehicle_mix`
keys ∈ {car, van, truck, bus}. Invalid scenario / mix key / range → **400**.
GET `/api/scenarios` lists the presets and PCE values.
Response:
```json
{ "config": {...}, "phases": ["NS_THRU","NS_LEFT","EW_THRU","EW_LEFT"],
  "summary": { "fixed": {...}, "adaptive": {...} },
  "improvement": { "avg_delay_pct": 24.5, "throughput_pct": 1.0,
                   "max_queue_pct": 3.8, "co2_pct": 24.5, "wasted_green_pct": 68.4 },
  "fixed": { "frames": [FRAME, ...] },
  "adaptive": { "frames": [FRAME, ...], "decisions": [DEC, ...] },
  "meta": { "steps": 1800, "frame_dt": 4, "arrival_source": "model", "generated": "..." } }
```
`FRAME = {"t":int,"phase":"NS_THRU","kind":"green|yellow|all_red","green":["N-T",...],
"q":{"N-L":0,...},"served":float,"delay_s":float}`
`DEC = {"t":int,"from":"NS_THRU","to":"EW_THRU","reason":"...","pressures":{"NS_THRU":float,...}}`

`arrival_source: "csv"` loads counts from `arrival_csv` (default the sample feed).
`arrival_csv` may be a **local path or an `http(s)://` URL**, so a real published
detector feed can be plugged in later without code changes; missing/unreadable feed
→ 400. `detector_dropout` ∈ [0, 0.9) models missed detections.

## POST /api/simulate_network
Request:
```json
{ "region": "expo_riem", "duration_min": 15, "seed": 42,
  "demand_multiplier": 1.0, "demand_profile": "peak", "total_vph": 3500,
  "od_estimation": true, "webster_cycle": false }
```
`od_estimation` (default **true**) adds a plan tuned purely on simulated stop-line
detector counts; `webster_cycle` (default **false**) lets the adaptive policy
lengthen its cycle with the measured flows — a win on saturated arterials
(Riem, Köln), a loss on short-link grids (Hamburg, Berlin).

Response (abridged):
```json
{ "region": "expo_riem", "name": "...", "bbox": [48.128, 11.683, 48.144, 11.708],
  "network": { "nodes": [{"id":int,"lat":f,"lon":f,"deg":int,"signal":bool}, ...],
               "links": [{"id":int,"from":int,"to":int,"length_m":f,"lanes":int,
                          "speed_kph":int,"oneway":bool,"name":str|null,"hw":str}, ...],
               "signal_nodes": [nodeId, ...] },
  "demand": { "n_entries": 24, "n_exits": 24, "total_vph": 3500 },
  "scenario": { "name": "normal", "label": "Normal", "multiplier": 1.0,
                "profile": "peak", "vehicle_mix": {...}, "pce_avg": 1.0,
                "transit_priority": false },
  "summary": { "fixed": {...}, "fixed_tuned": {...}, "fixed_tuned_est": {...},
               "adaptive": {...}, "coordinated": {...} },
  "improvement": { "avg_delay_pct": 49.7, "throughput_pct": 16.0,
                   "avg_travel_pct": 35.8, "co2_pct": 41.7,
                   "vs_tuned": {...}, "vs_tuned_est": {...},
                   "coordinated": { "avg_delay_pct": 61.9, "throughput_pct": 19.0,
                                    "avg_travel_pct": 42.7, "co2_pct": 48.9 } },
  "corridor": { "nodes": [...], "links": [...], "offsets": [...], "main_axis": [...],
                "cycle_s": 100, "main_green_s": 62, "length_m": 4041.8, "junctions": 72 },
  "frames": { "fixed": [...], "adaptive": [...], "coordinated": [...] },
  "config": { "duration_min": 15, "seed": 42, "demand_multiplier": 1.0,
              "demand_profile": "peak", "total_vph": 3500, "frame_dt": 10 },
  "meta": { "steps": 900, "frame_dt": 10, "generated": "...",
            "od_estimation": { "pairs": 230, "pairs_active": 230,
                               "iterations": 40, "fit_rel_err_pct": 6.3 } } }
```
District `FRAME = {"t":int,"q":[[link_id,queue],...],"ph":[[node_id,axis],...]}`.
Unknown region / missing `region` / out-of-range values → **400**.

## POST /api/explain
```json
request:  { "question": "Why did you switch to EW_THRU?", "scope": "compare" }
response: { "answer": "…", "source": "featherless", "model": "Qwen/Qwen2.5-7B-Instruct" }
```
Without a Featherless key (or on API error) it returns `"source": "fallback"` with a
deterministic rule-based explanation — the endpoint always answers.

## POST /api/agent
The agentic copilot: instead of only narrating the last run, the model **drives the
simulator**. Protocol is provider-portable, prompt-based tool calling — the model
replies with exactly one JSON object per turn (`{"tool": ..., "args": {...}}` to call
a tool, `{"final": "..."}` to answer), the server executes whitelisted tools and feeds
compact numeric digests back (max 3 rounds + 1 forced final; malformed JSON is repaired
twice, then the deterministic path answers).

```json
request:  { "question": "Was passiert in den Ferien mit 15 % Lkw?", "max_rounds": 3,
            "mode": "solo" }
response: { "answer": "…", "source": "featherless", "model": "Qwen/Qwen2.5-7B-Instruct",
            "steps": [ { "tool": "simulate", "args": { "scenario": "ferien",
                         "vehicle_mix": { "car": 0.85, "truck": 0.15 } },
                         "ok": true, "digest": { … } } ] }
```

Tools (thin wrappers over the simulator, all arguments validated; no filesystem or
network side effects):

| Tool | Arguments | Returns |
|---|---|---|
| `simulate` | `scenario`, `demand_multiplier`, `junction_type`, `vehicle_mix`, `transit_priority`, `duration_min` | fixed vs adaptive KPIs + improvement |
| `simulate_network` | `region`, `duration_min`, `demand_scenario`, `demand_multiplier`, `vehicle_mix` | per-policy KPI table + improvement |
| `compare` | `a`, `b` (simulate-style objects) | both digests + delta, identical demand |
| `explain_last` | — | digest of the dashboard's most recent run |

`mode`: **`"solo"`** (default) is one model planning tool calls and answering.
**`"panel"`** adds a self-check pipeline over the same tool results: a **critic**
verifies every number and the question's premise against the digests and may demand
one revision (with different tool arguments), then a **writer** produces the final
answer in the question's language plus a `Prüfung:` line. The hard anti-hallucination
rule is enforced in *code*, not by trust: `agent.unsupported_numbers()` rejects any
number no tool digest backs — in the draft and in the writer output alike; an
unrepairable draft is replaced by a fully verified deterministic answer. The response
then also carries `pipeline`, `revisions`, `checks[]` and the verified `draft`.

Without a key, after protocol failures, or when the tool budget is exhausted, a
deterministic keyword path runs one real simulation and answers from it — the endpoint
always returns an `answer` plus a `steps` trace. Identical questions are served from a
small answer cache (`"cached": true`).

## POST /api/tts
```json
request:  { "text": "Average delay dropped by 24.5 percent." }
success:  audio/mpeg bytes
no key:   501 { "error": "ElevenLabs API key not configured",
                "hint": "Set ELEVENLABS_API_KEY in .env and restart the server." }
```

## curl examples
```bash
curl -s localhost:8000/api/health
curl -s -XPOST localhost:8000/api/simulate          -d '{"duration_min":30}'   -H 'Content-Type: application/json'
curl -s -XPOST localhost:8000/api/simulate_network  -d '{"region":"expo_riem","duration_min":15}' -H 'Content-Type: application/json'
curl -s -XPOST localhost:8000/api/explain           -d '{"question":"Why?"}'  -H 'Content-Type: application/json'
curl -s -XPOST localhost:8000/api/agent             -d '{"question":"Was passiert in den Ferien mit 15 % Lkw?"}' -H 'Content-Type: application/json'
```
