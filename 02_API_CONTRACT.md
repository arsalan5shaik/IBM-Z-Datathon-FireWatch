# FireWatch v4 — Frozen API / GeoJSON contract

**Rules:** all public endpoints prefixed `/api/v1`; JSON UTC timestamps ISO-8601 (`Z`); longitude before latitude in GeoJSON; California only; errors `{ "error": { "code": "...", "message": "..." } }`; no breaking shape changes without approval from both teams. All numerical examples below are *fixtures*, not actual fire readings or risk forecasts.

## Endpoints
| Endpoint | Purpose | Owner |
|---|---|---|
| `GET /api/v1/status` | service / snapshot health and model version | App |
| `GET /api/v1/fires?days=1` | newest NASA detections as GeoJSON | App/data |
| `GET /api/v1/coverage?days=1` | *illustrative* hotspot influence polygons | App/data |
| `GET /api/v1/risk?horizon_days=7` | cell forecasts as GeoJSON | ML produces, App serves |
| `GET /api/v1/places?q=Fresno` | search California city/town/county/ZIP | App |
| `GET /api/v1/locations/{id}` | panel: nearby fire observations, risk, SHAP-style factors | App + ML |
| `POST /api/v1/chat` | constrained data-grounded Q&A | App |

For hackathon simplest path: return entire California snapshots as GeoJSON (cacheable) instead of arbitrary geographic bbox queries; if large, later add optional `bbox=w,s,e,n` and apply server-side clip. Frontend should accept empty feature collections.

## Standard GeoJSON FeatureCollection wrapper
External GeoJSON readers permit foreign members, so put metadata alongside canonical `type` and `features`:

```json
{
  "type": "FeatureCollection",
  "metadata": {"generated_at":"2026-10-17T10:00:00Z","source":"demo_fixture","stale":false,"scope":"California"},
  "features": []
}
```

### GET `/fires` — point GeoJSON
```json
{
 "type":"FeatureCollection",
 "metadata":{"source":"NASA FIRMS (fixture)","generated_at":"2026-10-17T10:00:00Z","stale":false,"observation_type":"thermal_anomaly","not_fire_perimeter":true},
 "features":[{"type":"Feature","id":"noaa21-20261017-1","geometry":{"type":"Point","coordinates":[-119.78,36.74]},"properties":{"acquired_at":"2026-10-17T07:42:00Z","sensor":"VIIRS_NOAA21_NRT","frp_mw":12.3,"confidence":"nominal","display_weight":0.55}}]
}
```
`display_weight` is visual normalization 0–1, not affected acreage; FRP is fire radiative power, not fire size. Source acquisition time must be preserved; never label all observations as live fire incidents.

### GET `/coverage` — illustrative areas only
```json
{
 "type":"FeatureCollection",
 "metadata":{"generated_at":"2026-10-17T10:00:00Z","method":"illustrative_hotspot_influence","official_perimeter":false,"not_burned_area":true},
 "features":[{"type":"Feature","id":"visual-1","geometry":{"type":"Polygon","coordinates":[[[-119.85,36.70],[-119.75,36.70],[-119.75,36.80],[-119.85,36.80],[-119.85,36.70]]]},"properties":{"source_detection_ids":["noaa21-20261017-1"],"visual_intensity":0.6,"visualized_coverage_km2":87,"illustrative_only":true}}]
}
```
`visualized_coverage_km2` is the size of **the illustrative drawn shape**, not land burned/affected. Prefer omitting this number in consumer-facing UI. The screenshot must say **“Hotspot influence visualization — not an official fire perimeter.”**

### GET `/risk?horizon_days=7` — grid cell forecast polygons
```json
{
 "type":"FeatureCollection",
 "metadata":{"generated_at":"2026-10-17T10:00:00Z","model_version":"demo-v0","forecast_start":"2026-10-17","forecast_end":"2026-10-24","target":">=1 qualifying NASA FIRMS hotspot within cell over next 7 days","calibrated":false,"not_fire_spread_prediction":true},
 "features":[{"type":"Feature","id":"ca-cell-001","geometry":{"type":"Polygon","coordinates":[[[-119.90,36.60],[-119.60,36.60],[-119.60,36.90],[-119.90,36.90],[-119.90,36.60]]]},"properties":{"cell_id":"ca-cell-001","risk_score":0.78,"risk_level":"high","score_type":"uncalibrated_model_score","explanation_available":true}}]
}
```
If evaluated and calibrated, change `score_type` to `calibrated_probability` and prove calibration on held-out time periods. Risk class thresholds configurable and included in metrics file. Do **not** claim that every colored cell will burn.

### GET `/places?q=Stockton`
```json
{"query":"Stockton","results":[{"id":"place-ca-stockton","name":"Stockton","type":"city","county":"San Joaquin","state":"CA","center":[-121.29,37.96],"bbox":[-121.45,37.85,-121.15,38.08]}]}
```
IDs are stable lookup keys. ZIPs are **approximate centroids/bounds** and not addresses. Return no results outside California. Empty query may return `results:[]`; cap results at 20. Debounce frontend search 250–350 ms.

### GET `/locations/place-ca-stockton`
```json
{
 "id":"place-ca-stockton","name":"Stockton, CA","center":[-121.29,37.96],
 "updated_at":"2026-10-17T10:00:00Z",
 "observed":{"nearby_hotspot_count":4,"lookback_hours":24,"latest_observation_at":"2026-10-17T07:42:00Z","source":"NASA FIRMS","count_is_incidents":false},
 "forecast":{"horizon_days":7,"risk_score":0.64,"risk_level":"elevated","score_type":"uncalibrated_model_score","model_version":"demo-v0","grid_cell_id":"ca-cell-015","start_date":"2026-10-17","end_date":"2026-10-24","drivers":[{"feature":"wind_speed_10m","label":"Wind speed","contribution_raw":0.41,"direction":"increase"},{"feature":"relative_humidity_2m","label":"Relative humidity","contribution_raw":-0.28,"direction":"decrease"}]},
 "weather":{"source":"Open-Meteo","forecast_window":"7-day","max_wind_kmh":25,"mean_relative_humidity_pct":34},
 "disclaimer":"Experimental risk score; not for emergency decisions."
}
```
`drivers` are native XGBoost contributions **in raw log-odds/margin**, not additive percent effects; add bias term + raw score if debugging, and show direction/importance in UI.

### POST `/chat`
Request:
```json
{"message":"Why is Stockton elevated?","location_id":"place-ca-stockton","conversation":[{"role":"user","content":"What is happening around Stockton?"}]}
```
Response:
```json
{"answer":"In this demo fixture, the selected grid cell has an elevated score. Wind speed raises the model output, while humidity lowers it. These are explanatory associations, not evidence of a currently spreading fire.","grounding":[{"dataset":"risk","as_of":"2026-10-17T10:00:00Z"},{"dataset":"weather","as_of":"2026-10-17T10:00:00Z"}],"location_id":"place-ca-stockton","disclaimer":"Not an emergency advice service."}
```
Limit conversation length and input length. Generate a compact, allowlisted context *server-side* from existing snapshots. The LLM **must not execute arbitrary user-specified tools**, fabricate coordinates/numbers, or advise evacuations. If LLM provider unavailable, return 503 gracefully with a fixed UI fallback; core map/risk still works.

### GET `/status`
```json
{"status":"ok","runtime_arch":"s390x","model_version":"demo-v0","snapshots":{"fires_at":"2026-10-17T10:00:00Z","risk_at":"2026-10-17T10:00:00Z"},"data_mode":"fixture"}
```
Never announce `data_mode:live` until API-derived data have been successfully fetched and timestamped. For demo fixture labels, display **SAMPLE DATA** prominently.

## Handoff schema and versioning
ML writes `models/risk_model.json`, `models/features.json` (ordered columns, units, preprocessing), `models/metrics.json` (split, PR-AUC/recall/Brier as appropriate), and `data/public/risk.geojson`. App writes data-normalization code, `fires.geojson`, `coverage.geojson`, `places.json`, and location/Chat APIs. Jointly own risk shape and all contract tests. Set `API_CONTRACT_VERSION=1`.

## Minimum cross-team tests
- JSON endpoints respond with correct `type`, data types, coordinates and timestamps; California-only clipping.
- Empty and stale snapshots render without crashes; malformed snapshots never replace valid ones.
- Mapped `cell_id` resolves to explanation with feature name and model version; score belongs to `[0,1]` even if uncalibrated.
- 2D ↔ 3D preserves sources, overlay visibility, selected place, source times and labels.
- No API keys in browser responses, source, commits or logs; user question cannot leak secrets through chatbot.
