# FireWatch backend

API foundation for the primary `FireWatch_Backend_Architecture.md` specification.
Status, health and validated JSON forecast read routes are implemented. No real
ML artifacts have been provided. There are no provider calls or inference on GET.

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
| `GET /api/v1/status` | HTTP 200 diagnostic report; `status:degraded`, `data_mode:unavailable`, API healthy after startup, all data subsystems unavailable, 0 valid / 168 missing forecast hours |
| `GET /health/live` | HTTP 200 while the process can answer HTTP |
| `GET /health/ready` | HTTP 200 after API lifespan initialization; HTTP 503 before initialization or during teardown |
| `GET /openapi.json`, `/docs` | Generated response/error schemas and interactive documentation |
| `GET /api/v1/forecasts/risk?hour=...&bbox=w,s,e,n` | Filtered grid GeoJSON; use exactly one hour or California date, optional max_hourly_risk/mean_hourly_risk aggregation |
| `GET /api/v1/forecasts/cell/{cell_id}?start=...&end=...` | Up to 168 hourly values; end exclusive, missing cells/hours explicit |

**Readiness measures API initialization, not forecast availability.** A missing
forecast must not remove a functioning diagnostic API from service. Consumers must
check `/api/v1/status` for data availability. Forecast routes return
`503 forecast_not_ready` until validated data exists, or explicitly labeled stale
last-known-good data. Unknown/unimplemented paths currently return structured 404.
Provider keys do not change availability. No GET or startup invokes a provider,
generator, background scheduler or model. No runtime files are created at startup.

Source timestamps and model/grid/input versions remain null until corresponding
validated artifacts exist. `checked_at` and `started_at` are actual API lifecycle
timestamps in UTC, not evidence of ingestion. Do not label this response as sample
predictions or live fire data; it explicitly describes unavailable data.

Errors use `{"error":{"code":"not_found","message":"Not Found","details":{}}}`.
HTTP 404, 405, 422, 500, 503 and rejected CORS preflight 400 use this envelope.
Validation failures return a count rather than potentially sensitive raw inputs.
Every HTTP response has `X-Request-ID` and `Cache-Control: no-store`.

Frontend migration proposal: this primary contract differs from the older
`02_API_CONTRACT.md` snapshot routes and status shape. In particular, consumers
must handle `data_mode:unavailable` and subsystem statuses instead of assuming
`status:ok` means forecasts exist. See `IMPLEMENTATION_STATUS.md` for all contract
differences. The missing named frontend spec was not fabricated; work resumed
using the existing API/UI documents after the requester's instruction to continue.
No frontend/ML files or shared schemas were modified.

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
`JOB_ENABLED=true` fails validation in this feature; scheduler ownership must be
agreed before enabling generation. `FORECAST_GENERATOR_CMD` is reserved and never
executed. Timeout, cache, retry and refresh settings are bounded and reserved for
subsequent provider features. Secrets use Pydantic secret types and are never
returned by status. Complete names/defaults are in `.env.example`.

## Verification

From `backend/`:

```sh
uv run --no-sync python -m pytest
uv run --no-sync python -m ruff check .
uv run --no-sync python -m ruff format --check .
uv run --no-sync python scripts/smoke.py
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

Rollback: stop the server and redeploy the previous reviewed commit/environment.
Foundation performs no migrations or persistent artifact writes. Do not roll back
by deleting teammate datasets or runtime artifacts.
