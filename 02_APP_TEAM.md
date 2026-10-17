# FireWatch — Frontend + Backend Team Playbook

**Owners:** 3 other teammates (assign names on kickoff). **Stack:** React + Vite + TypeScript + MapLibre; FastAPI + HTTPX + SQLite (or JSON fixtures) on IBM LinuxONE. **Goal:** useful end-to-end demo that does not depend on the ML team being finished.

## 1. Split the three jobs

| Role | Deliverable | Integration boundary |
|---|---|---|
| Frontend/map | Search, map dots/clusters, map legend, risk detail card, historical slider, scenario controls | Calls `/api/v1/*` only |
| Backend/API | FastAPI routes, Pydantic contracts, health endpoint, errors, CORS, ML adapter | Calls `ml.predictor` using fixed schema |
| Data/platform | NASA + weather ingestion, local cache, Census geography, deployment, LinuxONE validation | Backend reads normalized data from storage |

The UI must **never call NASA with the secret MAP_KEY**. Route upstream traffic through FastAPI/background ingestion. Frontend does not directly invoke the LLM with a secret API token either.

## 2. MVP UX (in this order)

1. Map centered on California with recent hotspots; popup contains satellite, UTC detection time, confidence, FRP and **data freshness**.
2. City/region search through a *local table* of supported Census regions; selecting a location fetches risk and explanation.
3. Relative-risk card with model/baseline tag, date horizon, limitations, and top factors.
4. What-if control for wind multiplier and number of teams; priority/resource allocation marked **simulation only**.
5. Historical timeline (pre-downloaded slices).
6. AI chatbot *only after* fundamentals work; tools retrieve the same backend data, and every answer displays its data basis. If no LLM access, a templated Q&A explorer is a legitimate fallback.

## 3. Backend endpoints (all prefixed `/api/v1`)

| Route | Call | Response | Upstream behavior |
|---|---|---|---|
| `GET /health` | sync, fast | status, app version, model readiness, dataset freshness | no external calls |
| `GET /regions?q=...` | async HTTP, fast DB read | region array with canonical IDs | no external calls |
| `GET /hotspots?bbox=...&from=...&to=...&limit=...` | async HTTP, cached | GeoJSON FeatureCollection | no upstream calls per user request |
| `GET /regions/{id}/risk?as_of=...` | HTTP GET; cached inference | `PredictionResponse` | in-process predictor; no NASA request |
| `POST /scenarios` | HTTP POST, simulated | changed rank + allocation | local compute; optional offline ML |
| `GET /history?region_id=...` | async HTTP | day-level counts | local DB/CSV |
| `POST /chat` | async HTTP, optional | answer + citations/data timestamps | one server-side LLM request, timeout |
| `POST /admin/refresh` | protected, optional | accepted job ID | background job, not public UI |

**Do not implement heavy training or a multi-minute NASA ingest inside a FastAPI request.** A CLI ingestion script is more reliable for the hackathon than a queue system. Frontend fetches are concurrent when independent; backend `async def` is valuable for HTTPX network waits, but CPU-heavy training and synchronous DB/model work should run in a worker/thread/process rather than block the event loop.

## 4. External API request map

### NASA FIRMS — server-only batch GET
`GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/VIIRS_NOAA21_NRT/{west},{south},{east},{north}/1`

- Historical 1–5-day windows can append `/{YYYY-MM-DD}`; split larger ranges.
- Parse **CSV**, not JSON. Convert coordinates and `acq_date` + `acq_time` (HHMM, zero-padded) to UTC timestamps.
- Track sensor and confidence; separate NRT from standard historical products. Cache responses and avoid duplication by sensor/time/coordinate/detection identity; exact duplicates may need careful normalization.
- NASA FIRMS MAP_KEY quotas are transaction-based; requests over wider regions may consume more. Use NOAA-20/21 rather than plan around SNPP whose delivery is slated to stop November 1, 2026.
- Source: https://firms.modaps.eosdis.nasa.gov/api/area/

### Open-Meteo — server-only network GET
`GET https://api.open-meteo.com/v1/forecast?latitude=38.58&longitude=-121.49&hourly=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m&forecast_days=7&timezone=UTC`

`GET https://archive-api.open-meteo.com/v1/archive?latitude=38.58&longitude=-121.49&start_date=2025-07-01&end_date=2025-07-07&hourly=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m&timezone=UTC`

- For supervised historical evaluation, respect as-of timestamps; current weather != historical forecast.
- Cache location/day combinations and fetch sparse representative grid centroids instead of every fire pixel.
- Validate licensing and rate limits for the event, especially if use is classified commercial.
- Sources: https://open-meteo.com/en/docs and https://open-meteo.com/en/docs/historical-weather-api

### Census — batch file preferred
- Gazetteer `INTPTLAT`/`INTPTLONG` are representative coordinates; **not** population. Join Census/ACS population by GEOID.
- Download static county/place boundaries and population before demo. Do not call Census per click.
- Prefer county search for MVP; ZIP Code Tabulation Areas differ from postal delivery ZIP codes.
- Source: https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.2025.html

### LLM — optional server-only POST
- Use a provider/API allowed by hackathon policy. Backend retrieves structured risk data, sends minimal context to model, and validates response; provider endpoint/schema depends on provider choice.
- Never permit chatbot to improvise evacuation orders or treat its text as an official alert. Include source timestamp.

## 5. Synchronous vs asynchronous: team-wide rule

| Work | Pattern | Why |
|---|---|---|
| UI risk lookup | `await fetch` / FastAPI response | interactivity; load cache |
| Parallel UI risk + history | `Promise.all` (JS) | independent requests |
| NASA + Open-Meteo refresh | asynchronous `httpx.AsyncClient`, scheduled/CLI | network-bound; parallel limited with semaphore |
| SQLite select | synchronous local operation in regular `def` route, or controlled thread | no need for async database dependency at hackathon scale |
| ML inference | local synchronous callable, offload if slow | CPU-bound, avoid event-loop stalls |
| Model training | offline CLI subprocess/job | expensive, unpredictable latency |
| LLM call | await network request with timeout | high latency; not block other requests |
| Map rendering | client-side map, network GET GeoJSON | smooth interaction |

Set upstream timeouts (e.g. 10–20 seconds), bounded retries with exponential backoff for 429/5xx, rate-limit concurrency, and return cached/stale results with explicit timestamps during outages. Do not retry non-idempotent POST operations blindly.

## 6. Frontend contract and mapping details

- Base URL from `VITE_API_BASE_URL`, e.g. `http://localhost:8000/api/v1` in dev. Vite `VITE_*` env vars are exposed publicly: **no secrets**.
- Backend permits only configured frontend origins via CORSMiddleware. `localhost:5173` and production URL are different origins.
- GeoJSON coordinates use `[longitude, latitude]`; camera centers in MapLibre also use `[lon,lat]`.
- Ensure CSS imports for MapLibre, source layer IDs, stable map init, cleanup on unmount, and bounded number of points (or clustering).
- Distinguish **observed detections** (points) from **predicted relative-risk regions** (polygon/heatmap); separate legend and dates.
- Debounce search, abort stale requests (`AbortController`), show loading/error/empty states and mock mode.

## 7. LinuxONE deployment and checks

`uname -m` should show `s390x`. Use s390x-capable official Python container or direct Python install on LinuxONE; never deploy an x86-only binary image. Official Python Docker imagery publishes architecture-specific s390x variants. Confirm Docker/Podman availability and hackathon outbound network, firewall rules, ports and allowed inbound access.

Suggested bootstrap:

```bash
python3 -m venv .venv && source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install fastapi uvicorn httpx pydantic python-dotenv
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
curl -fsS http://127.0.0.1:8000/api/v1/health
```

**Important:** This is a candidate install, not a verified s390x pass. Test it on the actual event image. Prefer React production build as static files served by a simple reverse proxy or FastAPI StaticFiles; build JS assets on a regular laptop if permitted and deploy compiled static output. CORS is unnecessary if proxy serves frontend/API from same origin. Configure TLS/auth before public exposure.

## 8. Definition of done

- [ ] `GET /health` responds from the LinuxONE VM.
- [ ] Frontend loads and maps seeded hotspots with **no NASA key** in browser.
- [ ] Clicking a region calls `/risk` using the agreed region ID and renders fixture/explanation.
- [ ] Demo works with upstream internet disabled using checked-in or cached data.
- [ ] Model errors produce valid fallback + warning, not a white screen.
- [ ] Integration tests validate GeoJSON coordinate order and all required fields.
