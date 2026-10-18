# Frontend / backend integration

Verified locally on 2026-10-17 with the NASA integration checkpoint and main `b901d05` (FIRMS, weather, elevation and location-search updates).
The authoritative route contract is `FireWatch_Backend_Architecture.md`; adapters live in `src/api/`.
This feature adds no React app, map instance, dependency or backend source edit; upstream backend changes are preserved.

## Run on Windows (two terminals)

The integration workspace is `C:\Users\Collins\firewatch-env\FireWatch-Integration`.
The original frontend on port 5173 and its uncommitted work are separate and preserved.

Terminal 1, from the integration workspace:

```powershell
cd backend
# Uses this worktree's existing ignored .env; never paste its key into commands/chat.
$env:CORS_ORIGINS='["http://localhost:5174","http://127.0.0.1:5174"]'
.\.venv\Scripts\python.exe -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log
```

Terminal 2, from the integration workspace:

```powershell
cd frontend
$env:FIREWATCH_API_PROXY='http://127.0.0.1:8000'
Remove-Item Env:FIREWATCH_MOCK_API -ErrorAction SilentlyContinue
npm.cmd run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

Open `http://127.0.0.1:5174/?api=/api/v1`. The `?api=` selects real API mode; without configuration,
the existing default remains explicitly labeled sample mode. `?demo=1` deliberately selects samples.
Do not enable `FIREWATCH_MOCK_API` for real-provider verification.
The proxy uses same-origin browser requests. Direct `?api=http://127.0.0.1:8000/api/v1` requests require
an exact matching CORS origin. Both localhost and 127.0.0.1 on 5174 passed preflight; 5175 was rejected.
Production can set `VITE_API_BASE_URL=/api/v1` before building and serve UI/API on one origin.

The API reads the cache; its Refresh button does not make a NASA provider request.
For automatic refresh, run ONE backend-owned polling process in a third terminal from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m app.jobs.refresh_fires --loop
```

Check that no other refresh owner is already running. Refresh interval is configured by the existing
backend FIRMS settings; see `backend/README.md`. Cache freshness describes retrieval, not real-time
satellite coverage. Cached detections remain satellite thermal anomalies, not confirmed incidents.

## Implemented routes and UI behavior

| Route under /api/v1 | Current status | UI behavior |
|---|---|---|
| GET /status | Implemented | Actual provider/model status; no synthetic status on API failure |
| GET /fires/live?bbox&since | Implemented, real NOAA-20/21 verified | Existing hotspot layer, clusters, FRP sizing, UTC details and cache status |
| GET /forecasts/risk?bbox&hour | Implemented; currently 503 forecast_not_ready | Explicit unavailable state, no sample substitution |
| GET /forecasts/cell/{cell_id} | Implemented; needs validated artifacts | Only received values; missing values stay missing |
| GET /wind?bbox&hour&density | Implemented by weather PR #4 | Existing arrows/conditions, exact selected hour, provider freshness |
| GET /weather?latitude&longitude&hour | Implemented | Selected-location weather at Census representative coordinates, plus bounded /wind samples |
| GET /locations/search?q&limit | Implemented by PR #8 | Debounced California suggestions; explicit API error without silent static fallback |
| GET /locations/{id}/boundary | Implemented by PR #8 | Selected Census boundary; /places aliases retained |
| GET /fires/incidents?bbox | Not implemented | 404 means no official feed; no fictional incident names |
| GET /explain/{cell_id}?hour | Planned/unavailable | No invented SHAP contributions |
| POST /chat | Implemented; server-side OpenAI key and protected access required | Backend mode shows explicit errors; demo mode is labeled offline |

In API mode, search and boundaries use `/locations/*`, serving the same Census data as the bundled
local context index; explicit sample mode uses bundled files. No new geocoding service was introduced.
Location selection calls `/weather` at Census representative coordinates and `/wind` in a bounded
surrounding region at the same UTC timeline hour. Previous-location weather is cleared immediately;
old boundary/weather requests are cancelled or ignored, including ABA selection changes. County
weather describes a representative point, not every part of the county. No sample weather replaces
an unavailable API response. Source coordinates, forecast hour and provider refresh time are shown.
Dataset sources, two corrected ambiguous place IDs, missing ML mapping and the public HTTPS backend
setup are documented in `backend/LOCATIONS_INTEGRATION.md`. Upstream corrected Census boundaries,
verification scripts and tests are preserved. Pages uses the optional repository Actions variable
`VITE_API_BASE_URL`; the runtime `?api=` override remains supported.

## NASA GeoJSON adapter

`src/api/fires.ts` validates FeatureCollection / Point geometry, [longitude, latitude] ordering,
unique source IDs, aware UTC acquisition timestamps, and nonnegative FRP (MW) or missing values.
Invalid records/responses fail visibly rather than manufacture defaults. IDs and confidence categories
are retained. Responses are bounded to the backend's 5,000-feature limit.

Metadata retained: cache_status, last_successful_refresh, last_attempted_refresh, observation range,
cache age, matched_count, returned_count, truncated, partial source/time/boundary/observation flags,
and sanitized per-source refresh errors. These appear alongside the existing observation legend
and in data status. Selected 6/12/24/48-hour counts are different from the API's full requested count.
A truncated response is explicitly marked; the UI does not silently request unbounded data.

Initial outage -> unavailable; successful empty response -> no matching cached observations;
failed refresh -> retain actual last-known-good observations with a stale warning. Real API mode never
substitutes generated observations, official incidents or model predictions. Explicit sample mode stays
available and labeled. Browser outage/reload/recovery, real hotspot UTC/FRP details, search, 2D/3D,
terrain/default and visibility toggles were checked locally.

## Forecast handoff still required

ML confirms rolling 168 hourly polygon forecasts, modeled wildfire occurrence risk scores out of 100,
not intensity/severity, and no confirmed probability calibration. Thresholds and validated artifacts
are still pending. The API currently returns `503 forecast_not_ready`; no forecast values were fabricated.

**Scale mismatch to resolve:** the current authoritative backend Pydantic schema validates risk_score
in [0, 1]. The frontend converts that documented normalized API representation to a 0-100 display.
It rejects raw out-of-contract values such as 42 instead of guessing a scale. When the ML sample arrives,
ML/backend must agree normalization or revise the contract together before integration is complete.
The UI always labels these as scores, not percentages/probabilities, even if an unsupported calibration
claim appears. Real-data colors form a continuous score ramp, with no low/moderate/high cutoffs.
FRP sizing/age colors apply only to observed hotspots. Existing categorical thresholds remain solely
inside the explicitly labeled sample demonstration.

The existing bounded forecast adapter requests 1 degree by 0.8 degree tiles (at most four requests at
a time), splits 422 response_too_large responses, and asks users to zoom in above 16 visible tiles.
Null scores remain missing. Valid timeline hours come from validated complete-window status or values
actually received; unavailable hours cannot be selected/played. An initial 503 disables forecast playback.
A rolling window resets tile/history caches. Geometry/score/time fields use the existing adapters/types.

SHAP needs real endpoint output and declared output scale; no log-odds assumption or synthetic model
explanation is attached to API risk. LinuxONE deployment remains unverified.

## Validation / review

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

The synchronized frontend has no lint script. During local verification, the already installed Oxlint executable
from the preserved older frontend was used read-only; no lint dependency was added. It reported two
pre-existing warnings (empty spread fallbacks in store.ts and panels/shared.tsx).
Before synchronization, the merged FIRMS/weather backend passed 249 tests, Ruff lint/format, both smoke modes and Linux/Windows CI.
After synchronization, the frontend passed 50 tests, TypeScript/build and lint (the same two existing warnings).
See the PR checks for the synchronized backend suite and smoke results.
The optional legacy location-browser script defaults to teammate-specific ports and assumes a usable forecast-hour control.
It is not a readiness check while validated model forecasts are unavailable; current search/weather behavior was verified directly in the running app.
The frontend integration is isolated on CO_feat/frontend-integration for review; check its PR validation before merging.
# AI assistant update

The existing drawer now calls `/chat` whenever an API URL is configured, including
when risk artifacts are unavailable. Canonical body: `message,location_id,
selected_hour,history`. It retains the map's location/hour, follows explicit
named-location replies in conversation, cancels stale requests, and exposes
retry/clear/loading/error states. API errors never silently become demo summaries.
No browser OpenAI key or direct OpenAI requests exist. Explicit offline mode is
labeled and performs no online research. Returned `sources` distinguish FireWatch
data from verified external research and display real links/timestamps/freshness.
Details, required authenticated public gateway, and live blockers: `backend/CHATBOT.md`.
