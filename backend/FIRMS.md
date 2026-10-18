# NASA FIRMS satellite observations

Latest controlled live/provider/API/browser results and deployment blockers:
[LIVE_API_VERIFICATION.md](../docs/LIVE_API_VERIFICATION.md). Historical counts
below describe their original verification time, not current observations.

This feature adds `/api/v1/fires/live` to the existing FastAPI application. It does
not create another app or modify the rolling forecast job. NASA FIRMS detects
**thermal anomalies**, not confirmed wildfires or incident perimeters. Near-real-time
satellite observations are not a continuous live feed or a wildfire probability.

## Run locally, one step at a time

Use the separate `FireWatch-NASA-FIRMS` worktree on `CO_feat/nasa-firms`. Leave the
frontend checkout on its own branch. In a PowerShell terminal at `backend/`:

1. Copy `.env.example` to `.env` if it does not already exist. Edit the ignored
   `.env` locally and set `NASA_FIRMS_MAP_KEY` to your own NASA key. Never paste a
   real key into a command, test, chat, screenshot or Git commit. Process environment
   variables take precedence over `.env`. Get a key from the official
   [NASA registration page](https://firms.modaps.eosdis.nasa.gov/api/map_key/).
   `FIRMS_MAP_KEY` remains supported for the architecture document's earlier name;
   a nonempty `NASA_FIRMS_MAP_KEY` takes precedence.
2. Run one refresh:

   ```powershell
   & '.\.venv\Scripts\python.exe' -m app.jobs.refresh_fires
   ```

   This command contacts both configured NASA products, validates observations,
   and atomically saves one ignored cache under
   `shared/data/provider-cache/firms.json`. It prints safe status categories,
   never key-bearing URLs. Exit 1 means no usable cache; degraded/stale data may
   still be served with HTTP 200. Inspect printed status rather than exit code alone.
3. Start the existing API in another terminal:

   ```powershell
   & '.\.venv\Scripts\python.exe' -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log
   ```

   `--factory` calls the existing app setup function. `--no-access-log` keeps raw
   paths/queries out of Uvicorn logs; the application's safe request logging remains.
4. Open `http://127.0.0.1:8000/docs`, or test in PowerShell:

   ```powershell
   Invoke-RestMethod 'http://127.0.0.1:8000/api/v1/fires/live?bbox=-122.5,37,-121.5,38&hours=24&limit=500'
   Invoke-RestMethod 'http://127.0.0.1:8000/api/v1/status'
   ```

5. For ongoing polling, explicitly start **one** refresh owner:

   ```powershell
   & '.\.venv\Scripts\python.exe' -m app.jobs.refresh_fires --loop
   ```

   Stop it with Ctrl+C. Default check interval is 15 minutes, configurable with
   `FIRMS_REFRESH_MINUTES` (minimum 10). This does not promise a new satellite pass
   every 15 minutes. Persisted attempt times throttle repeated invocations; a file
   lock excludes overlapping refreshes, including across local API/CLI processes.
   `--force` bypasses the interval once, never the lock. Do not routinely force polls.
   API startup and GET requests never start ingestion or inference.

The callable `await FireCache(settings).refresh()` is available for a future shared
scheduler. Do not also run `--loop` if another owner schedules it. This implementation
uses a separate cache and lock; it does not change forecast scheduler ownership.
For LinuxONE, run the owner separately from Uvicorn workers. Multiple hosts/replicas
require a shared filesystem with verified advisory locks and atomic replacement,
or a coordinated external leader. A local lock cannot coordinate independent disks.
LinuxONE operation and deployment filesystem behavior still require verification.

## Components, explained

- `app/schemas/fires.py`: **Pydantic schemas** check the shape and allowed values of
  Python records, including finite measurements and timezone-aware timestamps.
- `app/services/nasa_firms.py`: an **HTTP client** sends requests to NASA's official
  Area CSV API. `async`/`await` lets the process do other work while waiting for
  network responses. Each attempt has a total deadline, read/connect timeouts,
  bounded bytes/rows, at most two simultaneous requests, and no redirects.
- The same service performs **normalization**: CSV strings become consistent typed
  records, `acq_date` plus zero-padded `acq_time` becomes UTC, and repeated records
  receive the same deterministic ID. Validation drops invalid rows with aggregate
  counts; an entirely invalid nonempty dataset is a failure, not an empty success.
- `app/services/fire_cache.py`: **caching** saves one complete, bounded snapshot for
  many map requests. Each satellite keeps its own last-known-good records. Atomic
  replacement prevents readers from seeing half a file. A corrupt snapshot is
  unavailable; it is never interpreted as zero detections.
- `app/jobs/refresh_fires.py`: an independently callable refresh command, optionally
  a single explicit polling owner. HTTP resources close after each refresh.
- `app/api/v1/fires.py`: a **router** connects the URL and query parameters to cache
  reads. It shares the app's CORS, safe errors, request IDs and response conventions.
- `tests/unit/test_nasa_firms.py` and `tests/integration/test_fires.py`: automated
  tests supply controlled, synthetic CSV/HTTP responses and check behavior. They
  never contact NASA or require a real key, and do not publish sample live data.

## Provider contract and limits

Verified against official [Area API documentation](https://firms.modaps.eosdis.nasa.gov/api/area/)
and [VIIRS field descriptions](https://firms.modaps.eosdis.nasa.gov/content/descriptions/FIRMS_VIIRS_Firehotspots.html).
Products are `VIIRS_NOAA20_NRT` and `VIIRS_NOAA21_NRT`. The client requests an explicit
UTC start date and enough calendar days to cover the full rolling window. A 72-hour
lookback can span four calendar dates, rather than three. The API supports up to
five dates per call; this implementation needs at most four.

NASA key-bearing URLs must stay private. HTTPX's normal INFO request logs and
HTTPcore debug messages containing FIRMS URLs are suppressed. Errors retain only
safe categories, not provider text or request objects. No requests follow redirects.
Retries cover 429, 5xx and network failures, with exponential backoff and jitter.
Valid `Retry-After` seconds or HTTP dates take precedence. If the requested wait is
more than 30 seconds, stop the refresh instead of retrying early. Default maximum
is two retries per source. NASA transaction quotas still apply; avoid `--force` loops.
An invalid key returned with HTTP 200 is a failure, not an empty observation set.

Config defaults: 10-second attempt timeout (`REQUEST_TIMEOUT_SECONDS`), 4 MB decoded
CSV per product, 50,000 rows per product, 72-hour retention request, 500 returned
features by default and 2,000 maximum. These are bounded by settings validation.
The base URL can be configured by a trusted deployer, not by API callers; it must
be an HTTPS Area API URL. No new runtime dependencies were introduced.

Deduplication identity is product + exact UTC acquisition time + coordinates
canonicalized to eight decimal places. Conflicting duplicate measurements choose
one lexicographically deterministic normalized record. Nearby detections and
NOAA-20 versus NOAA-21 records remain distinct; no incident clustering is implied.
Unknown CSV fields are ignored for forward compatibility. Missing optional fields
become null; invalid nonempty optional measurements reject the row.

The existing `frontend/public/data/ca-boundary.geojson` is read without modification.
Its build script documents a simplified US Census 2023 California boundary. The
cache records its SHA-256. Coastline simplification can affect edge detections.
An absent boundary permits a clearly labeled California **coverage rectangle**
(-124.6,32.4,-114.0,42.1), which includes areas outside the state. An invalid present
boundary fails refresh safely. Changed geometry with a provider failure preserves
old observations and marks mixed spatial coverage explicitly until a successful refresh.

## API and frontend integration

`GET /api/v1/fires/live` accepts:

| Parameter | Meaning |
| --- | --- |
| `bbox` | Optional WGS84 west,south,east,north; default California coverage rectangle. Must stay within that rectangle; reversed boxes/antimeridian crossing rejected. |
| `hours` | Positive lookback, default 24, at most `FIRMS_MAX_HOURS` (72 by default). |
| `since` | Aware timestamp, converted to UTC, instead of `hours`; preserves the authoritative architecture and current frontend contract. |
| `limit` | Positive integer, default 500; at most `FIRMS_MAX_LIMIT` (2,000 by default). |

Invalid queries return the existing HTTP 422 error envelope. No usable cache returns
HTTP 503 `firms_unavailable` with configured/error information. This does not mean
there are no fires. Success is a GeoJSON FeatureCollection with `[longitude, latitude]`
Point features ordered newest first, then stable ID. `truncated` is true only if
matching records exceed the limit; `matched_count` describes the pre-limit count.
Use a smaller map bbox if truncated; this endpoint does not provide pagination.

Feature properties include `id`, `source="NASA_FIRMS"`, `product`, `satellite`,
`instrument`, `acquired_at` in UTC, categorical `confidence` (`l`, `n`, `h`), `frp`
and compatible alias `frp_mw` (megawatts), `daynight`, `brightness`/`bright_ti5`
(kelvin), `scan`/`track` (kilometers), and provider `version` when available.
Confidence is not a numeric probability. No acreage, containment or incident name
is inferred. Thermal anomalies and forecast grid predictions remain separate.

Metadata includes `last_attempted_refresh`, per-product `fetched_at`, full-product
`last_successful_refresh`/`last_success_at`/`fetched_at` aliases, observation min/max,
cache age, record count, per-product errors/invalid-row/duplicate/outside counts,
`cache_status` (`fresh`, `stale`, `unavailable`), `stale`, `partial_sources`,
`partial_observations`, `partial_boundary_coverage`, `partial_time_coverage`,
coverage/query bounds, and measurement units. Full-product freshness uses the
**oldest** available product fetch; partial failures retain older records and make
staleness explicit. A valid empty CSV is fresh with zero records; missing data is not.
A cached outage can return HTTP 200 with `stale=true`, including zero observations
within the requested time; consumers must display the stale/partial state.

`/api/v1/status.providers.firms` exposes configured state, cache status, last attempt,
last successful fetch, latest acquisition time and a safe error category. Forecast
status and health probes retain their prior meanings; NASA outages do not fail liveness.
The current frontend's `/fires/live?bbox=...&since=...` parser recognizes these
properties and `last_success_at`/`stale` aliases. It currently defaults to 500 features;
its future UI should surface truncation/partial coverage. No frontend files changed.

## Verification and remaining checks

From `backend/`:

```powershell
& '.\.venv\Scripts\python.exe' -m pytest -q
& '.\.venv\Scripts\python.exe' -m ruff check .
& '.\.venv\Scripts\python.exe' -m ruff format --check .
& '.\.venv\Scripts\python.exe' scripts/smoke.py
& '.\.venv\Scripts\python.exe' scripts/smoke.py --fixtures
```

Coverage includes UTC midnight, invalid/missing times, finite/ranged coordinates and
measurements, deduplication, valid empty CSV, malformed CSV, unknown fields, key
errors, timeout/connection/429/5xx retries, Retry-After, source outages, cross-worker
lock exclusion, persisted throttling, atomic-write failure, bbox/time/limit filtering,
GeoJSON and existing frontend aliases, staleness and no network calls on GET.
The smoke server verifies the real HTTP 503 path and graceful shutdown without a key.

A real NASA fetch and loopback HTTP check passed on 2026-10-17 at about 21:38 UTC.
The California-filtered 72-hour cache contained 351 NOAA-20 and 347 NOAA-21 records,
with zero invalid rows. All 698 records had finite nonnegative FRP and valid UTC
acquisition times/coordinates; the latest acquisition was 21:31 UTC. Live GeoJSON,
`since` compatibility, freshness/status, truncation and invalid-query 422 responses
were checked over real local HTTP. These counts are a verification snapshot, not
fixed demo data. The private key and cache remain ignored and are not committed.
LinuxONE deployment still needs independent verification. No key is bundled.
The supplied handoff ends in Section 11 at “No API”; missing security/acceptance
requirements remain a team clarification. The architecture document and explicit
user assignment govern known requirements; the PR must not be merged automatically.
Rollback: stop the FIRMS polling owner, and revert this feature PR through normal
review; the independent ignored FIRMS cache can be retained. Forecast artifacts,
ML and frontend work are unaffected.


## Measured local resource smoke

Run the reproducible synthetic benchmark (temporary storage, no NASA calls):

```powershell
& '.\.venv\Scripts\python.exe' scripts/benchmark_firms.py --records 10000 --requests 20
```

On the participant's Windows/Python 3.12 environment, one run ingested 10,000
synthetic points spread across the coverage rectangle; 4,139 remained after the
existing California boundary filter. Twenty statewide cache GETs, capped at 500
features, measured p50 **53.72 ms**, p95 **95.27 ms** including TestClient/JSON handling
with tracemalloc enabled; maximum response was **216,404 bytes**. Serving peak Python
allocations were **10.46 MiB**. This excludes interpreter, imports and ingestion
memory and is not total process RAM. Cold synthetic ingestion/filtering took
**6.92 seconds**. These are development smoke measurements, not live NASA latency,
LinuxONE results or production guarantees. Recheck under deployment load before
setting an operational latency/memory budget.
