# FireWatch backend

API foundation for the primary `FireWatch_Backend_Architecture.md` specification.
Status, health, validated JSON forecast reads, cached NASA FIRMS observations,
and forecast weather routes are implemented. No real ML artifacts have been provided.
Forecast GETs never invoke inference; FIRMS GETs only read the shared cache.
Weather GETs can fetch Open-Meteo forecasts on a bounded cache miss.


## Setup and startup

Python 3.11+ is required. Python 3.11 and 3.12 are the CI targets. From the
repository root, with a supported Python on PATH:

```sh
python -m pip install uv==0.13.1
cd backend
uv sync --locked --python 3.11
```

If no supported Python is installed, `uv python install 3.11` installs an isolated
managed interpreter; then repeat `uv sync`. The committed `uv.lock` pins resolved
dependencies. To install without uv, `python -m pip install .` works from this
directory but does not reproduce the exact lock and does not install test tools.

Optionally copy `.env.example` to `.env` (`Copy-Item .env.example .env` in
PowerShell, `cp .env.example .env` on Linux/macOS). No keys are needed for the
foundation. `.env` is read from the source-tree `backend/` directory, independent
of the current working directory. Process environment overrides `.env`.

```sh
uv run --no-sync uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log
```

Open `http://127.0.0.1:8000/docs` for OpenAPI and examples, or request
`http://127.0.0.1:8000/api/v1/status`. Stop with Ctrl+C.
Binding beyond loopback is a deployment decision; no public listener is created
by the setup or smoke commands. `--no-access-log` prevents Uvicorn from logging
raw paths and query strings. FireWatch writes JSON request logs with server-issued
request IDs, route templates, status and elapsed time; it omits bodies, query
strings, client request IDs, raw exception messages and credentials.

## API contract

| Endpoint | Behavior |
| --- | --- |
| `GET /api/v1/status` | Forecast completeness, timestamps, revisions, scheduler state and cached FIRMS provider health |
| `GET /api/v1/fires/live?bbox=w,s,e,n&hours=24&limit=500` | Cached NOAA-20/21 satellite hotspots with explicit freshness; also accepts `since` instead of `hours`; see [FIRMS setup](FIRMS.md) |
| `GET /health/live` | HTTP 200 while the process can answer HTTP |
| `GET /health/ready` | HTTP 200 after API lifespan initialization; HTTP 503 before initialization or during teardown |
| `GET /openapi.json`, `/docs` | Generated response/error schemas and interactive documentation |
| `GET /api/v1/forecasts/risk?hour=...&bbox=w,s,e,n` | Filtered grid GeoJSON; use exactly one hour or California date, optional max_hourly_risk/mean_hourly_risk aggregation |
| `GET /api/v1/forecasts/cell/{cell_id}?start=...&end=...` | Up to 168 hourly values; end exclusive, missing cells/hours explicit |
| `GET /api/v1/weather?latitude=...&longitude=...&hour=...` | Normalized hourly forecast at the nearest display anchor; cell_id may replace coordinates |
| `GET /api/v1/wind?bbox=...&hour=...&density=medium` | Forecast GeoJSON samples, units/source/fetch time, cache state and explicit gaps |

**Readiness measures API initialization, not forecast availability.** A missing
forecast must not remove a functioning diagnostic API from service. Consumers must
check `/api/v1/status` for data availability. Forecast routes return
`503 forecast_not_ready` until validated data exists, or explicitly labeled stale
last-known-good data. Unknown/unimplemented paths currently return structured 404.
Provider keys do not change availability. Startup and forecast GETs never invoke
a provider, generator, background scheduler or model. Weather routes refresh the
cache when required; no runtime files are created at startup.

Source timestamps and model/grid/input versions remain null until corresponding
validated artifacts exist. `checked_at` and `started_at` are actual API lifecycle
timestamps in UTC, not evidence of ingestion. These lifecycle timestamps are not sample predictions or evidence of fire ingestion.
Forecast data mode remains unavailable until validated forecast artifacts exist;
`providers.firms` separately reports cached satellite observation availability.

Errors use `{"error":{"code":"not_found","message":"Not Found","details":{}}}`.
HTTP 404, 405, 422, 500, 503 and rejected CORS preflight 400 use this envelope.
Validation failures return a count rather than potentially sensitive raw inputs.
Every HTTP response has `X-Request-ID` and `Cache-Control: no-store`.

Frontend consumers must check `data_mode` and individual subsystem statuses.
`frontend/API_INTEGRATION.md` records the existing forecast client. This feature
populates status from validated forecasts and improves indexed cell history;
it does not change frontend risk categories or add a statewide overview endpoint.

## Configuration

`REPO_ROOT` must be absolute when supplied; otherwise it is derived from this
source checkout. Relative `SHARED_DATA_DIR` and `SQLITE_PATH` resolve against it,
never cwd. Installed deployments outside the source tree should explicitly set
`REPO_ROOT`. The foundation validates paths without creating files or a database.

`CORS_ORIGINS` is a JSON list of exact HTTP(S) origins. Default `[]` permits only
same-origin browser use; the example allows the local Vite port. Wildcards,
credentials, paths, query strings and malformed ports are rejected. Cookies are
not enabled. CORS is a browser access policy, not authentication.

`FORECAST_HOURS=168` and `GRID_RESOLUTION_M=3000` are fixed contract values.
`JOB_ENABLED=true` requires `SCHEDULER_OWNER=backend`. The default is disabled and
unassigned. `SCHEDULER_OWNER=ml` leaves this API a read-only consumer; never enable
two publishers. Generator argv and secrets are omitted from status and job logs.
Complete names/defaults are in `.env.example`.

## Verification

From `backend/`:

```sh
uv run --no-sync python -m pytest
uv run --no-sync python -m ruff check .
uv run --no-sync python -m ruff format --check .
uv run --no-sync python scripts/smoke.py
uv run --no-sync python scripts/smoke.py --fixtures
```

Tests isolate environment settings and reject real HTTP provider transports.
The smoke script starts an isolated loopback server in a temporary cwd, ignores
developer credentials/`.env`, checks HTTP status/errors/CORS/OpenAPI and requests
graceful shutdown. It does not leave a server running. CI runs these same checks
on Linux Python 3.11/3.12 and Windows Python 3.11. A Starlette deprecation warning
about its HTTPX TestClient compatibility is currently emitted; tests still pass.

LinuxONE/s390x compatibility is **not yet verified**. The foundation does not add
native geospatial or ML packages. Pydantic's native core still needs testing on the
actual target runtime; Windows/x86 Linux results do not prove s390x support.
Later features must verify geometry dependencies before adopting them.

## Rolling 168-hour publication

Run the external job from `backend/`, using the same SHARED_DATA_DIR as the API:

```sh
uv run --no-sync python -m app.jobs.roll_window --revision /absolute/path/to/revision.json
```

The revision JSON has `data_mode`, `model_version`, `feature_version`,
`grid_version`, `input_revision`, `score_type`, and `target_type`. ML owns these
values, geometry and prediction generation. A mock example is in
`shared/examples/forecast-revision.example.json`; no production generator or
model is included. Fixtures additionally require `ALLOW_FIXTURE_DATA=true`.

`FORECAST_GENERATOR_CMD` is a JSON argv array, evaluated without a shell. Backend
appends `--request /private/staging/request.json`. The request is:

```json
{
  "schema_version": "1.0",
  "hours": ["2026-03-08T08:00:00Z"],
  "revision": {
    "data_mode": "fixture", "grid_version": "mock-ca-grid-3km-v1",
    "model_version": "mock-model-v1", "feature_version": "mock-features-v1",
    "input_revision": "mock-weather-v1", "score_type": "relative_risk",
    "target_type": "mock_fire_activity"
  },
  "output_dir": "/private/staging"
}
```

The CLI must exit successfully and write one schema-valid complete-grid
`YYYYMMDDTHH00Z.json` for every requested hour inside output_dir. It must not
publish the shared manifest itself. Failed/timeout attempts have bounded retries
and exponential backoff; invalid JSON aborts publication. Partial retry outputs
are discarded. Agree this adapter contract with ML before setting a real command.

Use exactly one external cron/systemd owner on the filesystem holding the store.
For cron, an hourly entry such as the following invokes the one-shot job:

```cron
0 * * * * cd /srv/firewatch/backend && /srv/firewatch/backend/.venv/bin/python -m app.jobs.roll_window --revision /srv/firewatch/shared/data/revision.json
```

Configure that account's environment or backend/.env explicitly. Publish revision
JSON atomically when upstream inputs change; rerun the same job immediately after
a revision change if necessary. A process-safe nonblocking lock prevents overlap,
including separate processes. OS process death releases the lock. FastAPI startup
and GET never start a schedule. Local Windows and POSIX locking are implemented;
network filesystem locking and actual LinuxONE deployment remain unverified.

Each run targets the **strictly next UTC hour**, including when called exactly on
an hour, followed by 167 slots. Calendar/DST changes never alter this count.
Unchanged revisions reuse matching files: normal rollover is 167+1; missed runs
append all missing hours. A changed revision conservatively regenerates the full
window because no cell/hour dependency map is supplied. This covers lagged weather
features without incorrectly assuming only one hour changes.

Publication copies geometry once into content-addressed `grids/`, validates all
generated hours, fsyncs immutable JSON and derived SQLite indexes, saves the prior
good manifest, then atomically replaces `manifest.json` **last**. Before-commit
failures leave the old snapshot usable; after-commit failures leave the complete
new snapshot usable. Invalid current manifest/grid references fall back to
`manifest.previous.json`, labeled recovered/stale. Invalid hourly files return
503 and are repaired on the next run; they never become zero scores.

`/status` counts complete validated hours in the published window (not just listed
filenames), reports publication success, next schedule time and safe job errors.
A forecast is stale if its window no longer starts at the strictly next UTC hour,
coverage is incomplete, recovery was used, or the last job failed. Overall service
status remains degraded while the other providers are unavailable. The response
always distinguishes fixtures from live ML output.

JSON remains authoritative. Per-artifact SQLite indexes store metadata and scores
keyed by cell ID; bbox requests query selected IDs and cell history selects one ID
per hour. A source fingerprint invalidates an index if its JSON changes. Legacy or
damaged indexes fall back to JSON validation; the scheduler rebuilds them. Runtime
indexes/database/artifacts are ignored by Git. Full-state production latency and
memory still require measurement with the ML team's actual grid and artifacts.

Retention only removes unreferenced backend objects, indexes, versioned grids and
expired private staging directories after successful publication and the retention
grace. Both current and previous manifest references are protected. Source ML grid
files and unrelated data are never pruned. Disk-space checks reject a run before
publication; write failures preserve the prior manifest. Operators must monitor
free space during unusually large generations.

Rollback: disable the external scheduler first, preserve the runtime store, and
deploy a reviewed reader compatible with the optional manifest fields. The prior
snapshot remains referenced by `manifest.previous.json`; a deliberate restore must
use the same scheduler lock and atomic replacement. Do not simply deploy an older
strict reader that rejects new fields, delete runtime datasets, or run two writers.

## NASA FIRMS observations

See [FIRMS.md](FIRMS.md) for key setup, the separate refresh owner, query limits,
GeoJSON and frontend compatibility, failure semantics, tests and known limitations.
No frontend, ML or rolling-forecast implementation is changed by this feature.

## Live forecast weather

See [WEATHER_INTEGRATION.md](WEATHER_INTEGRATION.md) for sampling, contracts and
limitations, and https://open-meteo.com/en/docs for provider definitions. An async
client batches up to WEATHER_BATCH_SIZE anchors, uses bounded timeouts/retries,
and requests 169 UTC hourly slots so the next 168 slots can be validated exactly.
No terminal hour is duplicated or extrapolated. C/percent/mm/km/h are normalized;
wind direction is FROM north. Precipitation describes the preceding-hour amount.
Provider model issue time is unknown; fetched_at is retrieval time.

Weather refresh is cache-first, at WEATHER_REFRESH_MINUTES. A shared process lock
and async lock prevent overlapping refreshes; unchanged disk snapshots are not
reparsed. Persistent cache is atomically replaced only after all batches validate,
bounded by WEATHER_MAX_ANCHORS and 32 MB. Existing good inputs survive partial
refreshes, outages and cancellation. Stale fallback is bounded by
WEATHER_STALE_HOURS; missing hours return 404, unusable caches return 503. Cache
status and provider last_success_at appear in /status without triggering a fetch.
Watch provider quotas: coordinate count as well as HTTP batch count matters.

Display sampling is explicitly coarse (0.5-degree lattice), and covers only a
California bounding extent, not an authoritative state boundary. It is independent
of 3 km risk geometry. The existing frontend uses its location selection and
timeline, renders provider/freshness labels, and clears unavailable weather frames.
Use frontend/.env.example or ?api=http://127.0.0.1:8000/api/v1 with appropriate CORS.

ML integration is **proposed, not a trained-model adapter**. With an agreed mapping
file matching every authoritative grid ID, a separate command can export complete,
fresh 168-hour normalized weather inputs:

```sh
python -m app.jobs.refresh_weather --mapping /absolute/path/to/weather-sampling.json
```

It writes only `shared/data/weather-inputs/proposed.json`, using a process lock
and atomic replacement. It refuses missing/stale hours and mismatched grids.
The example mapping under shared/examples is fixture-only; live grid/boundary and
the actual model's names/units/transforms/lag features remain external dependencies.
Mappings must fit the configured cache budget; this exporter does not claim
statewide support for the ML branch's larger, unmerged anchor set.

Partition revisions hash normalized anchor/hour inputs and mapping, excluding
fetch times. Overlapping hours retain their revisions as the window rolls.
No automatic global input_revision or production prediction manifest is changed.
The existing publisher supports full-window invalidation; connect these revisions
only after the ML team agrees the inference dependency contract. No training or
FIRMS integration is changed by this feature.

Weather verification uses mock provider HTTP in CI. A separate manual provider
check on 2026-10-17T20:48:38Z returned 169 records and all 168 future slots for one
Sacramento-area coordinate. That is not a statewide availability guarantee.
