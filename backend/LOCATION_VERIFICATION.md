# Location-search verification, 2026-10-17

Worktree: `C:/Users/jsora/AppData/Local/Temp/firewatch-location-worktree`,
branch `JS_feat/location-search`, based on main `0b97c15` (includes PR #6).

## Commands and results

Backend working directory `backend/`:

```powershell
$py='C:/Users/jsora/OneDrive/Desktop/IBM-Z-Datathon-FireWatch/backend/.venv/Scripts/python.exe'
$env:PYTHONPATH=(Get-Location).Path
& $py -m pytest -q
& $py -m ruff check .
& $py -m ruff format --check .
& $py scripts/smoke.py
& $py scripts/smoke.py --fixtures
```

PASS: 285 tests, no failures/errors/skips; 108.08 seconds. Ruff lint and format
PASS (69 files). Both process/HTTP smoke modes PASS. One existing upstream
Starlette TestClient deprecation warning. Automated providers are mocked, no CI
internet dependency. Catalog test validates all 3,478 real bundled geometries,
holes, multipolygons, coordinate ordering, bbox consistency and bounded caches.
Scheduler/weather revision regression tests are included in the full suite.

Frontend working directory `frontend/`:

```powershell
npm.cmd ci --no-audit --no-fund
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

PASS: 34 tests, TypeScript, production build. Existing Vite config-loader warning
about the mock plugin's extension remains. No dependency/lockfile changes.

## Real backend and browser

Separate backend PowerShell session (same `$py` and `PYTHONPATH` as above):

```powershell
$env:SHARED_DATA_DIR=Join-Path $env:TEMP 'firewatch-location-live-data'
$env:SQLITE_PATH=Join-Path $env:SHARED_DATA_DIR 'jobs.sqlite3'
$env:JOB_ENABLED='false'
$env:ALLOW_FIXTURE_DATA='false'
$env:FORECAST_GENERATOR_CMD=''
$env:CORS_ORIGINS='["http://127.0.0.1:5175"]'
& $py -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8002 --no-access-log
```

Separate frontend sessions:

```powershell
npm.cmd run dev -- --host 127.0.0.1 --port 5175 --strictPort
node scripts/verify-locations.mjs
# After stopping this owned dev server, verify the actual production build:
npm.cmd run preview -- --host 127.0.0.1 --port 5175 --strictPort
```

Chrome/Playwright live test uses no route/provider mocks. PASS:

- Stockton suggestions, keyboard selection, real boundary, camera, weather/wind.
- Next forecast hour updates both APIs and existing map source at the same UTC hour.
- Sacramento replaces boundary/camera/weather, preserves hour; keyboard arrows
  select city/county suggestions correctly.
- 95202 real ZCTA, approximation label, live weather/wind and sampling coordinates.
- San Joaquin County boundary/representative weather and county limitation.
- Tablet 820x1180 and mobile 390x844 viewport/search/no horizontal overflow.
- Browser offline clears weather, explicit error, no demo fallback; online recovers.
- All successful weather/wind responses match requested UTC hour, Open-Meteo
  provenance and correct CORS origin. No JavaScript exceptions.

The cold real backend logged nine successful batched Open-Meteo requests (eight
50-location batches and one 40-location batch); 440 real display anchors. Selected
location requests reused valid provider cache. Stockton represents
`37.9498,-121.2881` and explicitly displays sample `38.0000,-121.5000`.
At `2026-10-17T22:00:00Z`, fetched `22:49:27Z`, provider data included 31.1 C,
17% relative humidity and 8 km/h wind FROM 291 degrees. These are timestamped
smoke observations, not fixed application data or guarantees about later forecasts.

An additional Chrome check against production preview confirmed: no API requests
in default labeled demo mode, and real Stockton point/weather/wind calls when
opening `http://127.0.0.1:5175/?api=http%3A%2F%2F127.0.0.1%3A8002%2Fapi%2Fv1`.
The configured runtime host was used; no hardcoded localhost backend was called.
HTTPS mixed-content rejection is separately covered by the frontend tests.

## Artifacts and external blockers

Local evidence (outside Git): OS temp `firewatch-location-verification/` contains
`results.json`, `production-results.json`, `stockton-desktop.png`, `zip-tablet.png`,
`zip-mobile.png`, `recovered-mobile.png`, `production-demo.png`, and
`production-live-stockton.png`. The committed live browser script reproduces the
main test against running local services, with configurable URL/output directory.

FIRMS returns 503 without its configured provider cache/key; real ML risk returns
503 without artifacts. Those independent layers remain labeled samples, while
weather stays actual API data or explicit unavailable. Offline requests deliberately
fail during the recovery test; aborted browser/map requests are not successful API
claims. No statewide inference, model training, ML code changes or fabricated
geographic grid is involved. Public live integration remains BLOCKED pending a
separately hosted HTTPS backend; LinuxONE deployment is not verified here.
