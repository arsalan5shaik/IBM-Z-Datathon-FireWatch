# FireWatch — Backend Architecture & Implementation Specification

**Status:** Implementation contract / source of truth  
**Scope:** Backend ownership only, in a shared monorepo  
**Target:** 24-hour datathon, California wildfire intelligence web app  
**Last updated:** 2026-10-17  
**Companion:** `FireWatch_Frontend_Spec.md` (existing frontend UX contract)

> **Non-negotiable:** The ML team owns model training, feature engineering and prediction generation; the frontend team owns UI. Backend owns ingestion, normalization, persistence, scheduling/orchestration, serving, validation, search, explainability transport, and chatbot orchestration. Do not overwrite other teams' files or change their interfaces without agreement.

## 1. Product behavior and explicit boundaries

Backend supports: recent NASA FIRMS thermal detections; official incident/perimeter overlays when a reliable feed is available; weather and wind forecasts; seven-day wildfire risk map and location/cell details; California city/town/county/ZIP/ZCTA lookup and boundaries; SHAP explanations from ML outputs; grounded chatbot; timestamps and operational status. It serves map data for Default/Terrain and 2D/3D, but **does not** implement cartographic style/camera changes itself. It must not add a permanent Park Fire detail card. Fire detections, confirmed incidents, and experimental model risk are distinct data types.

Out of scope: building or retraining XGBoost, constructing ML features, client UI, fire-spread simulation, historical playback, population exposure, official evacuation instructions, elaborate microservices, and unnecessary Kubernetes/Redis/Kafka.

## 2. Canonical technical decisions

| Concern | Decision |
|---|---|
| Monorepo | `frontend/`, `backend/`, `ml/`, `shared/` |
| API | Python 3.11+ FastAPI, Pydantic v2, HTTPX |
| Forecast grid | **3,000 m × 3,000 m**, California, grid generated in **EPSG:3310**; approximately 47k land cells, actual count from source geometry |
| Public map geometry | GeoJSON WGS84 **EPSG:4326**, coordinate order `[longitude, latitude]` |
| ML handoff | Versioned **JSON** forecast artifacts on shared filesystem; no separate ML HTTP service required |
| Time | UTC-aware ISO 8601; forecast windows are **168 hourly slots** aligned to the hour |
| Forecast cache | Sliding 168-hour window; append missing hour(s), retain valid cached hours, invalidate affected data on changes |
| Metadata | SQLite (single-writer discipline); file-backed JSON prediction artifacts; optional derived indexes for performance |
| External sources | NASA FIRMS; a forecast weather provider such as Open-Meteo; official fire perimeters where available; authoritative CA boundaries |
| Chat | LLM API with strictly bounded backend retrieval tools, optional until API key available |
| Deployment | IBM LinuxONE if provided; verify s390x Python/dependency compatibility early |
| Dev | `.env` secrets, typed models, pytest, Ruff, HTTPX mocks, CI |

### 2.1 Scale assumptions

California area / 9 km² gives a **rough** ~47,000-cell planning estimate. Actual clipped-grid count and boundary handling determine the real number. A full 168-hour forecast contains ~7.9 million cell-hour scores. Store geometry **once**, never per-hour; return only requested geographic extent and time. A normal one-hour rollover requires ~47k new predictions if all existing inputs/model versions remain valid. Weather revisions, new features or a model update can require partial/full recomputation. **Sliding window is a cache strategy, not a guarantee that recomputation is always limited to one hour.**

## 3. Proposed repository layout

```text
firewatch/
├── frontend/                       # Owned by frontend team — do not modify casually
├── ml/                             # Owned by ML team — do not modify casually
├── backend/
│   ├── app/
│   │   ├── main.py                 # FastAPI factory, lifespan, router wiring
│   │   ├── config.py               # pydantic-settings/env
│   │   ├── dependencies.py
│   │   ├── api/v1/
│   │   │   ├── fires.py
│   │   │   ├── forecasts.py
│   │   │   ├── weather.py
│   │   │   ├── wind.py
│   │   │   ├── places.py
│   │   │   ├── explain.py
│   │   │   ├── chat.py
│   │   │   └── status.py
│   │   ├── schemas/                # Pydantic request/response models
│   │   ├── services/
│   │   │   ├── firms.py
│   │   │   ├── incidents.py
│   │   │   ├── weather.py
│   │   │   ├── grid.py
│   │   │   ├── forecast_store.py
│   │   │   ├── prediction_adapter.py
│   │   │   ├── places.py
│   │   │   ├── explanations.py
│   │   │   └── chat_tools.py
│   │   ├── jobs/
│   │   │   ├── roll_window.py
│   │   │   ├── refresh_fires.py
│   │   │   └── refresh_weather.py
│   │   └── persistence/
│   │       ├── sqlite.py
│   │       └── manifests.py
│   ├── tests/{unit,integration,contracts}/
│   ├── scripts/
│   ├── pyproject.toml
│   ├── Dockerfile
│   └── .env.example
├── shared/
│   ├── schemas/
│   │   ├── forecast-hour.v1.schema.json
│   │   ├── forecast-manifest.v1.schema.json
│   │   └── explanation.v1.schema.json
│   ├── examples/
│   │   ├── forecast-hour.example.json
│   │   └── explanation.example.json
│   └── data/
│       ├── grid.geojson            # Stable cell_id geometry, generated by designated owner
│       ├── predictions/            # Runtime artifacts; gitignored except examples
│       ├── explanations/           # ML-produced or derived explanation artifacts
│       └── provider-cache/         # Runtime artifacts; gitignored
├── .github/workflows/backend-ci.yml
└── README.md
```

Use existing repo layout if it differs; **inspect before creating or moving files**. Resolve `shared/` paths from a configured repository root, not from the process's current working directory.

## 4. Cross-team interfaces and ownership

**ML team must provide:** (1) authoritative grid geometry with stable `cell_id`; (2) hourly prediction JSON or documented daily-to-hourly limitation; (3) callable generation entry point/CLI for missing forecast hours (if backend owns scheduling); (4) `model_version`, `feature_version`, weather/input revision IDs; (5) `score_type` (`relative_risk` vs `calibrated_probability`), target definition and validation notes; (6) SHAP JSON keyed by `cell_id` and forecast timestamp; (7) explicit readiness signal via atomic file publish/manifest. Backend must not invent SHAP or model results.

**Frontend team must receive:** OpenAPI endpoint descriptions, response fixtures, errors, coordinate convention, bbox format, selected-hour and selected-day semantics, source/valid timestamps, no permanent incident card requirement, and risk color semantics (orange → red → purple; purple highest). 2D/3D and Default/Terrain are purely frontend view state and must not trigger ML recomputation.

**Ownership rule:** Only one process owns the forecast schedule and publication. Preferred: backend schedules and calls a documented `ml/predict.py` CLI; ML code computes and atomically publishes outputs. If ML owns its scheduler, backend is read-only consumer and never triggers inference. Decide and record in README; do not allow two writers.

## 5. JSON data contracts

### 5.1 Hourly prediction artifact

Filename: `shared/data/predictions/YYYYMMDDTHH00Z.json`. Example:

```json
{
  "schema_version": "1.0",
  "forecast_hour": "2026-10-20T14:00:00Z",
  "generated_at": "2026-10-17T18:00:00Z",
  "model_version": "xgb-v1",
  "feature_version": "features-v1",
  "input_revision": "weather-run-20261017T1200Z",
  "grid_version": "ca-grid-3km-v1",
  "grid_resolution_m": 3000,
  "score_type": "relative_risk",
  "target_type": "fire_activity",
  "predictions": [
    {"cell_id": "CA_004821", "risk_score": 0.72},
    {"cell_id": "CA_004822", "risk_score": 0.38}
  ]
}
```

Example scores are **fixtures, not forecasts**. Validate required fields, unique cell IDs, recognized grid IDs, `0 <= risk_score <= 1` for normalized scores, valid timezone-aware timestamps, expected hour alignment, no NaN/Infinity, model and input versions, and sensible record counts. Missing cells must be reported as incomplete, not silently treated as zero risk. Scores are **not** probabilities unless `score_type=calibrated_probability` is justified by ML team.

### 5.2 Forecast manifest

```json
{
  "schema_version": "1.0",
  "active_window_start": "2026-10-17T19:00:00Z",
  "active_window_end_exclusive": "2026-10-24T19:00:00Z",
  "grid_version": "ca-grid-3km-v1",
  "model_version": "xgb-v1",
  "input_revision": "weather-run-20261017T1200Z",
  "hours": ["2026-10-17T19:00:00Z"],
  "published_at": "2026-10-17T18:59:00Z"
}
```

`hours` is illustrative and truncated; production manifest contains exactly the validated available hours, ideally all 168. Manifest is **published last** using atomic replacement; readers only trust manifest-referenced complete files. On process crash, ignore orphan temporary files. Never delete the last known-good forecast merely because a new run failed.

### 5.3 Grid geometry

Stable `FeatureCollection` of California 3 km cells with `properties.cell_id`, `grid_version`, and polygon/multipolygon coordinates in WGS84. Validate uniqueness, California intersection, nonempty valid geometry, and grid version consistency. Use bounding-box/spatial indexing; no full grid JSON response on normal requests.

### 5.4 SHAP/explanation JSON

Key by `cell_id`, `forecast_hour`, `model_version`, and `feature_version`; include `base_value`, `output_scale` (e.g. log-odds), signed per-feature contributions and human-readable feature names. Missing explanation -> `404` or explicit `unavailable`, **never fabricate**. If `output_scale=log_odds`, do not call values percentage-point effects.

## 6. Rolling 168-hour scheduler: exact semantics

**Window:** At each run, compute `start = ceil_to_next_UTC_hour(now)` and `end_exclusive = start + 168 hours`. The window contains slots `start, start+1h, ..., start+167h`. Align with frontend team on whether a current partial hour is shown as Live; do not mix partial-hour observations into future forecasts.

**Bootstrap:** Detect missing hours, request initial full 168-hour generation, validate, and publish manifest. Until ready, API returns `503 forecast_not_ready` (or last-known-good marked stale); never return fake production predictions.

**Normal hourly rollover:** Acquire process-safe lock; load manifest; compute desired timestamps; reuse valid matching artifacts; request only missing hours from ML entry point; validate output; atomically publish files then manifest; prune expired artifacts only after success and optional retention grace period; release lock. Idempotent when run twice.

**Invalidation:** On `model_version`, `feature_version`, `grid_version`, input weather revision, or other feature dependencies changing, recompute affected cells/hours or full window if dependency map unavailable. If weather changes at hour H and lagged precipitation features are used, subsequent hours may be affected. Do not assume only H changes. Live NASA hotspots refresh independently unless ML explicitly uses them as model inputs.

**Failure handling:** Retries with exponential backoff and bounded timeout; no overlapping runs; crash recovery; disk-space safeguards; stale-but-labeled responses; `last_success_at`, `next_run_at`, `last_error`, `missing_hour_count`, and per-source freshness in status. Use a single worker or external cron/systemd timer; avoid FastAPI startup schedulers running once per Uvicorn worker. Scheduler must not depend on user traffic.

**Performance:** ~47k predictions per hour file and ~7.9M across window. Index geometry once. Read only requested hour and matching cell IDs; optional SQLite/Parquet derived index if JSON parsing latency is excessive. Cache `(forecast_hour, bbox_tile_or_grid_partition, model/input_version)` with bounded size. Do not store duplicated geometry in each forecast file. Pagination/zoom-aware simplification or vector tiles may be needed at statewide scale.

**Day aggregation:** UI shows Live and seven daily selections. Agree on a documented daily summary (`max_hourly_risk` or `mean_hourly_risk` as **risk index**, not daily probability); aggregate in `America/Los_Angeles` and handle DST days of 23/25 hours. A sliding 168-hour horizon is not always seven *complete* California calendar days. Expose `coverage_hours` and `partial_day` metadata; do not extrapolate beyond available hours. Do not use `1-product(1-p)` without defensible independence assumptions and calibrated hourly probabilities.

## 7. API surface (prefix `/api/v1`)

| Method / path | Inputs | Output / semantics |
|---|---|---|
| `GET /status` | none | Service health, forecast completeness, provider timestamps, model/grid version, stale flags |
| `GET /fires/live` | `bbox`, optional `since` | GeoJSON `Point` features for recent NASA FIRMS detections; source, UTC acquisition time, satellite, FRP, confidence where available |
| `GET /fires/incidents` | `bbox` | Official named incidents/perimeters if configured; source and update time; distinguish from hotspots |
| `GET /forecasts/risk` | `hour` **or** `date`, `bbox`, optional `aggregation` | GeoJSON clipped/filtered 3 km grid features with risk score/category, coverage, model metadata |
| `GET /forecasts/cell/{cell_id}` | optional `start`, `end` | Up to 168 hourly values, missing intervals explicitly marked |
| `GET /weather` | `lat,lon` or `cell_id`, optional `hour` | Cached forecast weather, provider/issued/valid timestamps |
| `GET /wind` | `bbox`, `hour`, optional `density` | GeoJSON sampled vectors or JSON grid, speed units, meteorological direction convention |
| `GET /places/search` | `q`, `limit` | CA city/town/county/ZIP/ZCTA suggestions, stable IDs, label, bbox, geometry type |
| `GET /places/{place_id}/boundary` | place ID | GeoJSON geometry, boundary source, ZIP/ZCTA approximation label |
| `GET /explain/{cell_id}` | `hour` | ML-produced SHAP factors and output scale, provenance |
| `POST /chat` | `{message, context?: {cell_id, place_id, hour, incident_id}}` | Answer with citations to tool-provided sources and timestamps; clear limitations |

**Query standards:** `bbox=minLon,minLat,maxLon,maxLat`, all in WGS84; reject reversed/invalid/out-of-range boxes, unreasonable area and excessive output size; canonical UTC `hour` ISO 8601 and `date=YYYY-MM-DD` interpreted in California local time. Require exactly one of hour/date for risk. `limit` bounded. Stable error JSON: `{"error":{"code":"...","message":"...","details":{}}}` with appropriate HTTP 400/404/422/429/502/503.

**GeoJSON response:** valid `FeatureCollection`, features with stable `cell_id`, `risk_score`, `risk_category`, `score_type`, `forecast_hour` or `forecast_date`, and metadata outside features for freshness, source, model, coverage and partial-day flags. For very large statewide responses, cap output or use simplified/partitioned delivery; never silently truncate without metadata.

**Security:** CORS allowlist from environment, secrets never in responses/logs/git, provider timeout/retry, user query validation, optional rate limiting, no SSRF through user-provided URLs, avoid open-ended bbox fetches, redact chatbot PII, structured request IDs, no unsupported evacuation advice.

## 8. Provider ingestion

### NASA FIRMS

Use official NASA FIRMS area API with `FIRMS_MAP_KEY` (document onboarding, never commit key). Select a suitable VIIRS source based on API availability. Query California coverage, normalize coordinates and timestamps, FRP and confidence fields; dedupe by stable source/observation identity; keep ingestion timestamp separate from satellite acquisition timestamp; retain raw source metadata when possible. Poll ~10–15 minutes **as an API check**, not as a claim of 10-minute satellite coverage. Use provider-friendly retries, quotas and caching. Return an empty valid collection when there are legitimately no detections, but surface provider failure/staleness distinctly.

### Official incidents and perimeters

Optional but desired: ingest from authoritative CAL FIRE / NIFC / other official feed if usable within event; keep `incident_id`, name, perimeter, acreage/containment **only if provided by that official source**, and `updated_at`. Never infer named incident from nearest hotspot without explicit matching logic and caveats. Perimeters may lag actual conditions.

### Weather and wind

Integrate provider adapter (Open-Meteo is an option), sample at sensible native weather-grid resolution, batch/cache by provider issuance/run and location tile. Normalize temperature °C, humidity %, precipitation mm, wind speed m/s or km/h (pick one and document), direction degrees **from** north (meteorological) and vector conversion for map arrows. Expose issued/valid timestamps, provider, source spatial resolution, and missing-value flags. Do not issue 47k provider calls per hour. Store weather revisions for ML cache invalidation and coordinate feature handoff with ML team.

### Location search

Use authoritative CA city/town/county boundaries and Census ZCTAs or geocoding adapter. Search is case-insensitive, handles duplicate names with county, includes bbox and optional geometry, never accepts out-of-CA result silently. ZIP/ZCTA is an approximation, not guaranteed USPS delivery boundary. Keep lookup local/cached for reliability.

## 9. Chatbot: grounded retrieval only

`POST /chat` resolves user context to permitted backend functions: `get_cell_forecast`, `get_location_forecast`, `get_recent_fires`, `get_weather`, `get_explanation`, `get_official_incident`. Use strict tool schemas, max tool-call count, per-request timeout, and allowlisted backend functions. LLM is **not** allowed to invent risk numbers, fire names, acreage, containment, wind readings, or SHAP effects. Include source and observation/forecast timestamps. If model/LLM key unavailable, return clear `503 chatbot_unavailable` while other endpoints remain functional. For evacuation/emergency advice, direct users to official emergency alerts and local authorities; never imply FireWatch is an official warning service.

## 10. Test strategy and acceptance criteria

**Required for every feature branch:** unit tests; integration tests for API/storage where relevant; schema/contract fixtures; mocked external HTTP tests (no network needed in CI); error-path tests; lint/type checks where configured; manual smoke test documented in PR. Aim for meaningful coverage of critical services; avoid chasing a percentage at the expense of core cases.

**Essential test cases:**

1. GeoJSON valid WGS84 coordinate order; 3 km grid and stable IDs; bbox intersection and boundary edges.
2. Invalid bbox, out-of-CA search, malformed timestamp, duplicate IDs, NaN score, invalid model/grid version all rejected appropriately.
3. First-run bootstrap; normal 167-reuse + 1-append; 2+ missed hours; idempotent rerun; duplicate scheduler lock; midnight UTC; DST in California.
4. Atomic publication: readers never see partial JSON; crash before manifest update retains previous good manifest; corrupt artifact detected; stale-but-labeled behavior.
5. Model/weather/grid version invalidation; dependent future hours recomputed as needed; expired-hour cleanup after successful publish only.
6. No model inference triggered by GET requests, frontend style switches, map zoom, or search.
7. NASA FIRMS provider success/empty/timeout/429/5xx, deduplication, acquisition vs fetch timestamp, FRP semantics.
8. Weather units, wind-direction convention, provider caching, rate-limit handling, missing values and forecast revisions.
9. Search city/county/ZCTA ambiguity and out-of-state rejection.
10. SHAP missing/wrong-model/output-scale cases; chatbot grounded tool citations, hallucination-resistant no-data response, rate limits and injection-resistant handling.
11. Performance smoke test for a statewide dataset fixture and representative bbox; document p50/p95 response times and memory, set measured budgets rather than inventing benchmarks.
12. LinuxONE deployment smoke test and architecture compatibility; startup, health, graceful shutdown, persisted files and scheduler single ownership.

**Definition of done (DoD):** code + tests + documented contracts + local test run + CI green + example request/response + logs/errors + safe rollback + reviewer approval (if team policy) + feature branch pushed + PR merged to main + post-merge smoke test. Do not claim done when tests are failing or when remote push/merge was not confirmed.

## 11. Git branch / commit / push / merge protocol (mandatory)

Branch pattern: `JS_feat/{feature}`; use short lowercase kebab-case feature slugs, e.g. `JS_feat/api-foundation`, `JS_feat/forecast-contracts`, `JS_feat/rolling-window`, `JS_feat/nasa-firms`, `JS_feat/weather-wind`, `JS_feat/location-search`, `JS_feat/shap-api`, `JS_feat/chatbot`, `JS_feat/deployment-ci`.

**One feature per branch, sequential workflow:**

1. Inspect `git status`, active branch, remote, team changes, and relevant repo files. Never discard teammates' uncommitted changes.
2. Fetch latest `origin/main`; start from up-to-date `main` only when working tree clean. Create `git switch -c JS_feat/<feature>`.
3. Implement smallest coherent increments; commit after scaffolding, contract/tests, implementation, integration, fixes (typically every 30–60 minutes or meaningful milestone). Use descriptive conventional messages, e.g. `feat(api): add forecast GeoJSON endpoint`, `test(cache): cover rollover recovery`.
4. Run focused tests on each increment; run full relevant backend tests, lint and contract checks before declaring complete. Fix failures; do not skip tests.
5. Push branch early and after each meaningful commit: `git push -u origin JS_feat/<feature>` first time, then `git push`. Confirm remote success; never claim push if credentials/network fail.
6. Re-fetch/rebase or merge latest main safely; resolve conflicts without overwriting teammate changes; rerun tests.
7. Open a PR targeting `main`, attach feature summary, tests, screenshots/logs where appropriate, and explicit cross-team contract changes. Respect branch protections and required reviews/checks.
8. **Only after CI passes and required approval is obtained**, merge PR to `main` using repository policy (squash or merge). **Never force-push `main`, bypass protection, or merge with failing checks.** If autonomous merge permission is not clearly available, stop and request approval instead of assuming.
9. Verify merge exists on remote `main`, run post-merge smoke tests, then sync local main and create next `JS_feat/<feature>` branch. Delete merged feature branch only if team policy permits.
10. If no remote/auth/PR capability, finish locally, report exact blocker, provide commands/PR instructions, and **do not falsely claim remote operations succeeded**.

**Safety:** Never `git reset --hard`, `git clean -fd`, force-push, delete unrelated branches, or auto-commit teammates' unrelated files. Stage explicit paths, inspect `git diff --cached`, never include `.env`, keys, generated prediction artifacts or large datasets. Before merge check whether teammates are concurrently changing main; integrate latest and communicate shared-contract changes.

### Feature sequencing / dependencies

| Order | Branch | Deliverable | Required checks |
|---|---|---|---|
| 1 | `JS_feat/api-foundation` | FastAPI app factory, config, CORS, errors, health, CI basics | startup, `/status`, env validation, pytest/Ruff |
| 2 | `JS_feat/forecast-contracts` | Shared JSON schemas, fixtures, grid loader, spatial lookup, forecast GET APIs | schema, bbox, GeoJSON, malformed JSON, performance smoke |
| 3 | `JS_feat/rolling-window` | Manifest, atomic publish, scheduler ownership, invalidation, recovery | rollover, concurrency, crash, missed-hour, revision tests |
| 4 | `JS_feat/nasa-firms` | Hotspot ingestion/cache/API | mocked API, dedup, freshness, 429/timeout |
| 5 | `JS_feat/weather-wind` | Forecast provider, caching, weather/wind APIs | units, timestamps, revisions, bbox, provider failures |
| 6 | `JS_feat/location-search` | California places and boundaries | city/county/ZCTA, duplicate names, CA-only |
| 7 | `JS_feat/shap-api` | Explanation JSON reader/API | versions, scale, missing data, schema |
| 8 | `JS_feat/chatbot` | LLM grounding + tool calls | fake data prevention, missing data, timeout, safety |
| 9 | `JS_feat/deployment-ci` | LinuxONE-ready deployment, scripts, operational docs | container/arch check, smoke, CI, rollback |

Adjust order if frontend integration or provider access makes another dependency urgent. **Do not wait for ML:** use clearly marked fixture data for contract tests and switch to real JSON only after validation.

## 12. Observability and runtime operations

`GET /api/v1/status` includes status per subsystem (`healthy`, `degraded`, `unavailable`), last successful ingestion, source observation time, forecast window start/end, number of valid hours, missing hours, model/grid version, and provider error summary (without secrets). Structured logs with request ID, job ID, elapsed time, source, and outcome. Add `/health/live` and `/health/ready` if deployment needs separate probes. Bound disk retention, rotate provider caches, and ensure file locks work on chosen filesystem. Ensure background jobs use explicit single-owner deployment semantics.

## 13. Configuration

Document `.env.example` without secrets: `FIRMS_MAP_KEY`, `WEATHER_PROVIDER`, `LLM_API_KEY` (optional), `CORS_ORIGINS`, `REPO_ROOT`, `SHARED_DATA_DIR`, `SQLITE_PATH`, `FORECAST_GENERATOR_CMD` (if backend owns invocation), `JOB_ENABLED`, `LOG_LEVEL`, `FIRMS_REFRESH_MINUTES`, `WEATHER_REFRESH_MINUTES`, `FORECAST_HOURS=168`, `GRID_RESOLUTION_M=3000`, request timeouts, cache size, provider limits. Use secure defaults, don't assume LinuxONE internet access, and ensure app works in fixture mode for tests.

## 14. Integration handoff checklist

- [ ] Frontend and backend agree on API prefix, bbox format, dates vs hours, GeoJSON, empty/error states.
- [ ] ML and backend agree on grid owner, `cell_id`, geometry version, JSON schemas, target/score semantics, inference invocation, scheduler ownership, and SHAP schema.
- [ ] Grid version and model/input revisions propagate through API and cache.
- [ ] Day aggregation documented and partial-day coverage surfaced.
- [ ] NASA hotspots and official incidents are visibly distinct from predicted risk.
- [ ] Four map view combinations require **zero** prediction recomputation.
- [ ] Provider keys and generated data excluded from Git.
- [ ] All required tests and CI checks pass before each merge.
- [ ] Each feature is committed/pushed to its own `JS_feat/*` branch, PR-merged to main, and next branch starts from updated main.
- [ ] IBM LinuxONE runtime/dependency compatibility tested, not assumed.

## 15. Definition of success

A frontend teammate can run the app and request California risk for a selected hour/day and bounding box, see real cached model JSON (or explicitly labeled fixtures before integration), click a cell for an honest SHAP explanation, inspect recent satellite fire detections, search places, view weather/wind, and ask grounded questions. A scheduled worker advances the 168-hour forecast without recalculating unchanged hours, safely responds to model/weather revisions, and survives failures. All features are tested, committed, pushed and merged using the branch protocol above.
