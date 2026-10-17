# Frontend ↔ backend integration

How the FireWatch frontend uses the API in `FireWatch_Backend_Architecture.md` §7 (prefix `/api/v1`),
what it needs from each route, and what happens until a route exists. Verified on 2026-10-17 against
`backend/` at `f2b0233` running fixture data, and against the dev mock in `mock-api/plugin.ts`.

## Connecting

- Build-time default: `VITE_API_BASE_URL=/api/v1 npm run build` (same-origin, e.g. backend serving `frontend/dist`).
- Run-time override: open the app with `?api=https://host/api/v1` (handy for the GitHub Pages build).
  The backend must allow that origin in `CORS_ORIGINS` (e.g. `["https://arsalan5shaik.github.io"]`), and must be
  HTTPS when the page is HTTPS (browsers block mixed content).
- `?demo=1` forces the built-in sample data.

Every dataset is loaded independently. If a route fails (404 because it isn't built yet, 503, network), only that
layer switches to **sample data**, the status pill reads *Live + sample layers* and a banner says so.
A refresh failure after a successful load keeps the last good data and marks it stale.
Weather is an exception to automatic sample fallback when an API is configured:
unavailable hours show an explicit error, and a previous frame is never reused at
a different valid hour. Explicit demo mode still uses labeled sample weather.

## Routes

| Route | In `backend/` today | Frontend use | If unavailable |
|---|---|---|---|
| `GET /status` | ✅ | status pill, About → Data status, polling | sample status |
| `GET /forecasts/risk?bbox&hour` | ✅ | risk layer, place/cell panels, assistant | sample forecast (labelled) |
| `GET /forecasts/cell/{cell_id}` | ✅ | 168-hour chart, peak-hour answers | chart shows loaded hours only |
| `GET /fires/live?bbox&since` | planned | hotspots, flame markers, influence outlines | sample hotspots |
| `GET /fires/incidents?bbox` | planned | official perimeters, incident panel | 404 → *no official feed* (empty) |
| `GET /wind?bbox&hour&density` | implemented | existing wind arrows, weather labels/chip, panel conditions | explicit unavailable/stale state |
| `GET /weather?latitude&longitude&hour` | implemented | optional point/cell API; map/panels reuse the statewide wind samples | 404 for unavailable hour; 503 for no usable cache |
| `GET /explain/{cell_id}?hour` | planned | *Why this risk?* SHAP bars | “factors not provided yet” — never invented |
| `POST /chat` | planned | FireWatch AI | offline assistant over loaded data |
| places search / boundaries | not needed | bundled Census data (`public/data/`) | — |

### `GET /status` (implemented)
Reads `status`, `runtime_arch`, `data_mode`, `forecast.{active_window_start, model_version, last_success_at}`,
`providers.{firms,weather}.{source_observed_at,last_success_at}`. When the snapshot timestamps change, the
matching dataset is reloaded (polled every 60 s).
**Ask:** `forecast` currently stays at its defaults (`unavailable`, 0 valid hours) even while `/forecasts/*` serve
validated artifacts. Populating it from the forecast store lets the UI show the window and freshness.

### `GET /forecasts/risk?bbox=w,s,e,n&hour=ISO` (implemented)
The 3 km grid can't be fetched statewide (≈47k cells; `MAX_RESPONSE_CELLS` = 2,000), so the client:

- splits the visible map into fixed **1° × 0.8° tiles** (≈900 cells each) and requests each tile for the selected
  UTC hour — at most 4 at a time, cached per tile + hour (`src/api/forecastTiles.ts`);
- on `422 response_too_large` splits that tile into quadrants (never accepts truncation);
- on `404 forecast_hour_unavailable` shows the hour as missing; `risk_score: null` cells are drawn as gaps, never 0;
- on `503 forecast_not_ready` at startup, uses labelled sample data;
- stops at more than 16 tiles in view and asks the user to zoom in (≈ zoom 8 on a laptop).

Fields read: `features[].id | properties.cell_id`, `geometry`, `properties.risk_score`, `score_type`, `target_type`;
`metadata.active_window_start`, `model_version`, `grid_version`, `published_at`, `generated_at_max`, `source`.
The timeline spans the 168-hour window from `active_window_start` (California local time on screen, UTC on the wire).

### `GET /forecasts/cell/{cell_id}` (implemented)
Fills the selected cell's 168 hourly values (`hours[].forecast_hour`, `risk_score`, `missing`).
**Observed latency:** ~11 s with 168 fixture artifacts of ~1,800 cells, because each request re-reads every
artifact through the 4-hour cache. At 47k cells per artifact this needs a per-cell index or cache. The client
waits up to 90 s and shows loaded hours meanwhile.

### Planned routes — fields the client accepts
Parsing is lenient so the first implementation should just work; the first name listed is preferred.

- **`/fires/live`** — GeoJSON `Point`s. `id` (feature id, `id`, `detection_id`); `acquired_at` (`acquisition_time`,
  `acq_datetime`, `observed_at`); `satellite` (`sensor`, `source`); `frp` (`frp_mw`); `confidence`; `daynight`;
  `incident_id`. Metadata: `source`, `generated_at`, `stale`. Requested with the California bbox and `since` = now − 48 h.
- **`/fires/incidents`** — Features with `Polygon`/`MultiPolygon` or null geometry: `incident_id`, `name`, `acres`,
  `containment_pct`, `updated_at`, `status`, `url`, optional `center`. Acreage/containment are shown only if present.
- **`/wind`** — GeoJSON `Point`s for one hour: `wind_speed_kmh` (or `wind_speed_ms`), `wind_direction_deg`
  (meteorological, *from*), `wind_gust_kmh`; optional `temperature_c`, `relative_humidity_pct`, `precipitation_mm`.
  Called with the California bbox, `hour`, `density=medium`; re-requested (debounced) as the timeline moves.
- **`/explain/{cell_id}?hour=`** — `drivers` (or `contributions`): `{feature, label, value, unit, contribution}`;
  `base_value`, `raw_score`, `risk_score`, `output_scale` (default `log_odds`), `model_version`; optional
  `conditions` with the model inputs (temperature, humidity, wind, gusts, precipitation, fuel moisture,
  days since rain, fuel type, vegetation density, elevation, slope).
- **`POST /chat`** — request is exactly `{message, context?: {cell_id, place_id, hour, incident_id}}` (only keys
  that are set). Response: `answer`, `citations` (or `grounding`) `[{dataset, as_of}]`, `disclaimer`.
  Errors including `503 chatbot_unavailable` fall back to the offline assistant with a notice.
- **Places** — the frontend ships Census boundaries and a search index (`public/data/places.json`, IDs
  `place-ca-<name>`, `county-ca-<name>`, `zip-<ZIP>`). If `/places/*` is built, reusing that file keeps `place_id`
  values identical between search and chat.

## Open items for the backend / ML teams

Weather feature update: `/wind` returns normalized C, percent, mm, km/h and
meteorological degrees **from** north, UTC `forecast_hour`, source/fetch timestamps,
cache freshness and coverage. The client adds 180 degrees to draw arrows toward
flow. Existing location selection and the risk timeline drive weather lookup; no
second timeline or new map layers were added. Hour responses are cached for at
most one minute in the client; old requests cannot overwrite a newer selection.
The API batches/caches forecasts at stable 0.5-degree display anchors. This is a
coarse display sample and not a 3 km weather grid. Forecast retrieval times are
shown; Open-Meteo issue time is unknown. A new model forecast is not inferred from
weather availability. See `backend/WEATHER_INTEGRATION.md` for ML blockers.

Rolling-window PR #3 has resolved status completeness and indexed cell-history
reads described as open issues in the original notes above. Real ML handoff and
statewide overview/risk-category agreement remain separate work.

1. **Statewide overview.** The frontend spec wants broad risk regions at California zoom; bbox slices can't
   provide that. Suggested: a cacheable geometry-once grid (`GET /forecasts/grid` or vector tiles) plus a
   geometry-free `GET /forecasts/scores?hour=` (`[cell_id…]`, `[score…]`). The client can switch to it quickly.
2. **Status completeness** (see `/status` above) and **cell-history latency**.
3. **Risk categories.** The frontend spec labels Elevated / High / Very High / Extreme (thresholds 0.2 / 0.4 / 0.6 /
   0.8 in `src/config.ts`); `backend` metadata proposes low / elevated / high at 0.4 / 0.7. Colours already agree
   (orange → red → purple, purple highest). Agree one set and update `RISK_LEVELS`.
4. **Explanations** need per-cell, per-hour ML output (`shared/schemas/explanation.v1` in the architecture plan).

## Testing locally

```bash
# 1. Mock of the whole contract (sample data behind the API shapes)
FIREWATCH_MOCK_API=1 npm run dev                       # open /?api=/api/v1
FIREWATCH_MOCK_API=1 FIREWATCH_MOCK_ONLY=forecasts npm run dev   # only the routes backend/ has today

# 2. The real backend with fixture artifacts in SHARED_DATA_DIR (grid.geojson + predictions/)
cd backend && SHARED_DATA_DIR=/path/to/fixtures ALLOW_FIXTURE_DATA=true \
  CORS_ORIGINS='["http://localhost:5173"]' uv run --no-sync uvicorn app.main:create_app --factory --port 8000
# then open http://localhost:5173/?api=http://127.0.0.1:8000/api/v1#map=9.2/39.75/-121.6/0/0
```

`npm test` includes `src/api/forecastTiles.test.ts`, which runs the tile loader against a stand-in for
`backend/app/api/v1/forecasts.py` (cell cap, 422 split, missing hours, null scores, cell history).
