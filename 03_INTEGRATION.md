# FireWatch — Integration Contract and Hackathon Runbook

**This file is the team's single source of truth.** Changes to API fields, units, prediction semantics, region IDs or coordinates require an explicit PR reviewed by at least one person from each team. Contract version: **v1**.

## 1. Overall decisions (freeze these first)

| Topic | Contract |
|---|---|
| Geography | California counties (FIPS GEOID string) for MVP; optional finer grid added later |
| Time | All timestamps UTC ISO 8601 with `Z`; calendar dates `YYYY-MM-DD` |
| Coordinates | WGS84; latitude/longitude separately; GeoJSON `[lon, lat]` |
| Risk output | `risk_score` is a **relative index 0–100** unless calibrated probabilities are genuinely validated |
| Observed fire | FIRMS detection point; not verified fire perimeter |
| Prediction horizon | Next 7 days relative to `as_of` |
| Weather units | Celsius, km/h, mm, percentage; specify aggregation windows |
| Population | Clearly named estimate + vintage; not direct measure of households threatened |
| Region key | zero-padded five-character county FIPS string (example Sacramento County `06067`) |
| Model readiness | `ready`, `fallback`, `unavailable` |
| Dataset provenance | sensor, extraction window and `updated_at` required |
| APIs | only backend owns external secrets and vendor calls |

## 2. Canonical JSON contracts

### `GET /api/v1/health`

```json
{
  "status": "ok", "version": "0.1.0", "architecture": "s390x",
  "model_status": "fallback", "dataset_updated_at": "2026-10-15T00:00:00Z"
}
```

`architecture` must be detected at runtime rather than hardcoded. `dataset_updated_at` may be null if not loaded.

### `GET /api/v1/regions?q=Sacramento`

```json
{"regions": [{"id":"06067","name":"Sacramento County","state":"CA","latitude":38.45,"longitude":-121.34}]}
```

Coordinates are examples for contract testing, **not** guaranteed county centroids.

### `GET /api/v1/hotspots?bbox=-124.5,32.5,-114,42&from=2026-10-14&to=2026-10-15&limit=1000`

```json
{
  "type": "FeatureCollection",
  "features": [
    {"type":"Feature","geometry":{"type":"Point","coordinates":[-121.5,38.5]},
     "properties":{"id":"fixture-hotspot-001","detected_at":"2026-10-14T12:30:00Z","satellite":"NOAA-21","frp_mw":14.2,"confidence":"nominal","is_fixture":true}}
  ],
  "metadata":{"source":"NASA FIRMS","sensor":"VIIRS_NOAA21_NRT","updated_at":"2026-10-15T00:00:00Z","is_fixture":true}
}
```

Those values are **synthetic fixtures**, not real NASA observations. Do not demo them as real without replacing them.

### `GET /api/v1/regions/06067/risk?as_of=2026-10-15`

```json
{
  "region_id":"06067", "region_name":"Sacramento County", "as_of":"2026-10-15",
  "horizon_days":7, "risk_score":63, "risk_level":"moderate",
  "score_type":"relative_index", "model_version":"baseline-v0", "model_status":"fallback",
  "factors":[
    {"name":"recent_hotspot_activity","direction":"increases_risk","display":"Recent detections above baseline"},
    {"name":"low_relative_humidity","direction":"increases_risk","display":"Dry conditions in the observation window"}
  ],
  "fire_history":{"hotspots_7d":3,"hotspots_30d":14},
  "exposure":{"population_estimate":1580000,"census_vintage":"fixture","method":"county_total_not_in_fire_perimeter"},
  "data_updated_at":"2026-10-15T00:00:00Z", "is_fixture":true,
  "disclaimer":"Experimental regional screening index; not an evacuation or emergency warning."
}
```

All numeric values above are **invented contract fixtures**. `risk_level` thresholds must be documented in code/config. A population estimate for an entire county is **not** a count of people at risk. If a value is missing, emit JSON `null` and explain gracefully; never generate a believable placeholder silently.

### `POST /api/v1/scenarios`

Request:

```json
{"as_of":"2026-10-15","region_ids":["06067","06001"],"wind_multiplier":1.2,"available_teams":4}
```

Response:

```json
{
 "mode":"illustrative_simulation", "teams_available":4,
 "allocations":[{"region_id":"06067","priority_rank":1,"teams_allocated":3,"priority_score":76},
                {"region_id":"06001","priority_rank":2,"teams_allocated":1,"priority_score":45}],
 "assumptions":["Teams assigned using relative-risk and exposure proxy","No travel time or dispatch constraints modeled"],
 "is_fixture":true
}
```

Allocation is an optimization **toy model**, not an emergency command. Keep total assigned teams <= available teams and every allocation >=0. Define deterministic tie-breaking by region ID.

### `GET /api/v1/history?region_id=06067&from=2026-09-01&to=2026-10-15`

```json
{"region_id":"06067","resolution":"day","series":[{"date":"2026-10-14","hotspot_count":3}],"updated_at":"2026-10-15T00:00:00Z","is_fixture":true}
```

### `POST /api/v1/chat` (stretch)

```json
{"region_id":"06067","question":"Why is the risk score elevated?"}
```

Response includes `answer`, `sources` (e.g. `model_version`, `data_updated_at`, source URLs), `model_status`, `disclaimer`; never pretend to have a source or authorize evacuation advice. UI must disclose LLM output.

## 3. Error contract

HTTP 400 (malformed bbox/date or limits), 404 (unknown region), 422 (Pydantic validation), 429 (throttled), 503 (temporarily unavailable). Use consistent error body:

```json
{"error":{"code":"DATA_NOT_READY","message":"Dataset currently unavailable","retryable":true}}
```

Backend can return last known cached response with an explicit stale flag; frontend must never quietly show stale data as fresh. `GET` endpoints must be idempotent. API consumers should timeout and surface retry options.

## 4. Repository layout

```text
firewatch/
├── README.md
├── docs/
│   ├── 01_ML_TEAM.md
│   ├── 02_APP_TEAM.md
│   ├── 03_INTEGRATION.md
│   ├── 04_ARCHITECTURE.md
│   └── compatibility-results.md
├── backend/
│   ├── app/main.py
│   ├── app/routes/{health,regions,hotspots,risk,scenarios,history,chat}.py
│   ├── app/schemas.py
│   ├── app/services/{predictor_adapter,firm_ingest,weather_ingest}.py
│   ├── requirements-minimal.txt
│   └── tests/test_contract.py
├── ml/
│   ├── predictor.py
│   ├── features.py
│   ├── train.py
│   ├── evaluate.py
│   └── artifacts/README.md
├── frontend/
│   ├── src/api/client.ts
│   ├── src/components/{FireMap,RiskPanel,ScenarioPanel,HistorySlider}.tsx
│   ├── src/types/api.ts
│   └── package.json
├── data/
│   ├── fixtures/{hotspots.geojson,regions.json,predictions.json}
│   └── processed/.gitkeep
├── scripts/{check_s390x.sh,refresh_data.py,smoke_test.sh}
├── .env.example
└── .gitignore
```

No actual secrets, huge model files or unlicensed downloaded raw datasets in Git. For pre-hackathon preparation versus competition development, check the event rules on allowed starting code/artifacts.

## 5. Integration checkpoints

**Checkpoint A — before hackathon:** publish fixture schemas and a working `/health`; frontend renders fixtures; decide if team may prebuild under rules.

**Checkpoint B — hour 2:** LinuxONE environment validated (hostname/architecture/Python/network/ports), sample backend running there, dependency failure log circulated.

**Checkpoint C — hour 6:** clean historical CSV -> normalized points -> backend GeoJSON -> React map. One real data point visible with source + timestamp.

**Checkpoint D — hour 12:** ML team drops function with exact response schema; backend switches fixture -> baseline/model using `MODEL_MODE=fixture|baseline|model`.

**Checkpoint E — hour 18:** one-click recorded demo flow: search county -> see fires -> see score/explanation -> change scenario -> inspect historical graph.

**Checkpoint F — final 3–4 hours:** freeze features; bugfix, screenshots, recorded backup demo, presentation, evaluation, and IBM LinuxONE explanation.

## 6. Hard contract tests

- [ ] Every route returns the documented JSON type and required keys.
- [ ] County FIPS remains a **string** with leading zero.
- [ ] `risk_score` in [0,100], horizon exactly 7, and `model_status` honest.
- [ ] `as_of` and `updated_at` are visible and UTC-correct.
- [ ] GeoJSON coordinates order is [lon,lat] and within Earth bounds.
- [ ] Never return keys/tokens to frontend or logs.
- [ ] `teams_allocated` sums to at most requested team count.
- [ ] Upstream timeouts display stale/fallback states; no silent fake live predictions.
- [ ] All fixture data clearly marked `is_fixture:true`.
- [ ] Actual LinuxONE test outputs saved to `compatibility-results.md`.

## 7. Environment contract

`.env.example` (do not commit real values):

```dotenv
NASA_FIRMS_MAP_KEY=
MODEL_MODE=fixture
DATA_DIR=./data
DATABASE_URL=sqlite:///./firewatch.db
ALLOWED_ORIGINS=http://localhost:5173
LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL=
```

Frontend `.env.example`:

```dotenv
VITE_API_BASE_URL=http://localhost:8000/api/v1
```

## 8. Kickoff questions for IBM organizers

1. Which LinuxONE OS, distro/version, Python version, and `s390x` VM/container image will be issued?
2. Is outbound HTTPS permitted to NASA, Open-Meteo, Census, container registries and approved LLM APIs?
3. Can we use Docker/Podman, install `apt`/`dnf` packages, build native wheels, and bind ports? Is root/sudo available?
4. Are there RAM, CPU, storage, time, or network quotas, and will VM state persist through judging?
5. Is the evaluation required to **run** inference on IBM LinuxONE, or is serving a portable model there acceptable if trained elsewhere?
6. Which supported s390x scientific/ML images and preinstalled packages are provided? Is scikit-learn available?
7. Is TLS/public ingress allowed, or should we use an SSH tunnel / local-only demo?
8. Are prewritten code, preprocessed data, external model training and paid model APIs allowed under hackathon rules?
9. Is IBM watsonx required, available, or simply optional? What credentials and entitlement are provided?
10. What proof of IBM platform use will judges expect (SSH `uname -m`, server logs, architecture diagram, metrics)?

## 9. Ready-to-paste development prompts

### Prompt A — ML team

> You are the ML lead for FireWatch, a 24-hour datathon wildfire activity risk prototype on IBM LinuxONE s390x. Read `docs/03_INTEGRATION.md` first and do not change API fields. Implement a time-safe seven-day satellite-hotspot activity baseline for California counties using historical NASA FIRMS VIIRS NOAA-20/21 and lagged Open-Meteo weather. Avoid future-data leakage; explicitly distinguish risk score from calibrated probability. Give reproducible scripts, schema checks, chrono holdout metrics, missing-data handling, and a `predict_region(region_id, as_of_date, scenario=None)` adapter. First verify s390x dependencies; if compiled ML libraries fail, produce a portable pure-Python scoring artifact. Mark every synthetic example as fixture. Work incrementally with runnable tests and list files changed.

### Prompt B — backend/data team

> You are implementing FireWatch FastAPI on IBM LinuxONE s390x. Read `docs/03_INTEGRATION.md` and follow its exact routes, JSON schemas and error contract. Build a minimal `backend/` app with `/api/v1/health`, `/regions`, `/hotspots`, `/regions/{id}/risk`, `/history`, `/scenarios`; stub risk predictions from checked-in JSON until ML integration. Write a NASA FIRMS CSV ingestion CLI (NOAA-20/21) and Open-Meteo HTTPX requests with timeouts, caching, safe retries, secret env vars, and SQLite persistence. Avoid unnecessary native extensions and heavy work in requests. Provide actual commands to start server and curl contract tests. Include explicit stale, fixture, and model status metadata. Never expose NASA key to frontend.

### Prompt C — frontend team

> Build FireWatch's React + Vite + TypeScript + MapLibre California dashboard using the REST contract in `docs/03_INTEGRATION.md`. Implement county search, clustered FIRMS hotspot map, separate forecast-risk layer, explanation panel, historical date slider, scenario controls and responsive loading/error/empty/fixture badges. All API calls go through `src/api/client.ts` using `VITE_API_BASE_URL`; no secret keys in client. Build against fixture JSON so the UI works before backend/ML are ready. Enforce GeoJSON [longitude,latitude] and never present demo fixtures as live data. Output runnable components, folder structure, and test steps. Prioritize one polished clickable demo flow over feature breadth.

### Prompt D — integration lead

> Act as FireWatch's integration engineer. Inspect `docs/01_ML_TEAM.md`, `docs/02_APP_TEAM.md`, and `docs/03_INTEGRATION.md`. Audit interface compatibility, schema types, API path consistency, payload keys, timestamp and coordinate conventions, frontend/backend env variables, s390x package/image compatibility, secret handling, model fallback, real versus fixture data, and potential async event loop blocking. Produce an actionable prioritized defect list and implement minimal smoke tests. Do not expand scope. First priority is an end-to-end working route on IBM LinuxONE with a React map using fixed fixtures; replace components only after contract tests pass.

### Prompt E — competition demo/rehearsal

> Help us prepare a 3-minute FireWatch IBM Datathon demo. We have 6 people, ML team Ridwan/Eshann/Serena and a 3-person app team. Frame the problem, real NASA FIRMS provenance, historical activity/risk methodology, useful community-exposure context, explainability, illustrative resource allocation, and proof that the backend runs on IBM LinuxONE s390x. Use only verified functions and measured outcomes; do not call the prototype a certified hazard forecast. Make a one-click demo script, likely judge questions, answers about model validation and data leakage, architecture overview, failure-proof backup path, and the minimum final screenshots.
