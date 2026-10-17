# California locations and deployment handoff

`JS_feat/location-search` reuses the frontend's existing versioned Census files;
it does not introduce a second geographic dataset or a geocoding provider.

## API

- `GET /api/v1/locations/search?q=Stockton&limit=10`: bounded results plus
  `total`, `limit`, `truncated`. Case/accent insensitive partial matching, exact
  five-digit ZCTA lookup, California suffix and county/co normalization. Exact
  names rank first. Duplicate names retain county context. Queries require 2–120
  characters; limit 1–25. Unknown/out-of-state queries return an empty result.
- `GET /api/v1/locations/{id}/boundary`: GeoJSON Feature with Polygon/MultiPolygon,
  location properties and source/version/CRS/display-simplification metadata.
  Missing IDs/boundaries: 404; invalid/missing datasets: 503. Never substitutes a
  circle. Rings, holes, longitude/latitude coordinates and bbox are validated.
- `/places/search` and `/places/{id}/boundary` remain compatible aliases.
- `GET /api/v1/locations/{id}/cells`: explicit 503
  `ml_grid_mapping_unavailable`. There is no authoritative grid/precise spatial
  mapping contract in main. The elevation CSV and sample frontend grid are not
  substitutes. No inference runs on location/weather GET requests.

Results preserve `id,name,type,county,state,center,bbox,population,approximate` and
add `display_name,latitude,longitude,boundary_available,dataset_source,
dataset_version,dataset_url`. Center/GeoJSON use `[longitude,latitude]`.
Example Stockton ID: `place-ca-stockton`, representative point
`[-121.2881,37.9498]`, bbox `[-121.4188,37.8675,-121.1839,38.0588]`.

The index is loaded once per process; substring postings avoid repeated statewide
scans. Boundary shards use a 32-entry LRU; validated features a 128-entry LRU.
No external service, native geospatial dependency or runtime dataset download is
required. Restart after replacing geography atomically as a complete version.

## Data sources and accuracy

The existing `frontend/scripts/build-geodata.mjs` records these source URLs:

- 2023 California places:
  https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_06_place_500k.zip
- 2023 counties:
  https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_500k.zip
- 2023 state clipping outline:
  https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_state_500k.zip
- 2020 ZCTAs:
  https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip
- Population ranking (Vintage 2024 estimates):
  https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024_6.csv

Coverage: 58 counties, 461 cities, 21 towns, 1,136 census-designated places,
1,802 ZCTAs; 3,478 records. ZCTAs use prefixes 900–961 and are clipped to the
California outline. PO-box and business ZIPs need not have a ZCTA. These are
Census approximations, not USPS delivery boundaries. County context for places
uses the representative point and does not assert single-county containment.

US Census Bureau data is public domain; retain source credit and source/version
metadata. These 1:500,000 cartographic files are already generalized. The existing
pipeline transforms to WGS84 (`-proj wgs84`) and further simplifies display
geometry at 90 m (places), 250 m (counties), 100 m (ZCTAs), keeping shapes.
They are not cadastral/survey data or precise intersection inputs. Future grid
mapping requires original unsimplified boundaries and the agreed EPSG:3310 grid.

This feature repaired 21 export-ring self-intersections with Mapshaper `-clean
allow-overlaps`, preserving feature IDs/properties and all other features. The
generator now repairs rounded output topology before final serialization. All
3,478 shipped boundaries are checked in an automated test, including both geometry
types and holes. No circles or invented statewide geometry are supplied.

Integration contract correction: the old ID `place-ca-spring-valley-lake` collided
between two records. It is replaced with
`place-ca-spring-valley-lake-county-san-bernardino` (Spring Valley Lake) and
`place-ca-spring-valley-lake-county-lake` (Spring Valley). The ambiguous old ID now
returns 404. Other IDs are unchanged. Existing links/recents for that ambiguous ID
must be selected again. This document and feature PR notify frontend/ML consumers.

## Weather and frontend behavior

The existing search UI uses debounced backend suggestions in API mode and the
bundled index in explicit sample mode. It retains keyboard/mouse navigation,
recent places, the existing selected-place state and boundary fill/outline.
Boundary failures are explicit; an old request cannot overwrite a newer selection.

Location selection follows the existing timeline and calls `/weather` at its
representative coordinates and `/wind` within a bounded surrounding region.
Both requests use the same absolute UTC hour and existing backend provider cache.
The existing wind source and panel update together. Old location/hour responses
are rejected. During a location change, old weather is cleared immediately.
Point or wind failure shows an explicit unavailable state, never sample weather.
Refresh/reselection permits recovery. Map panning does not request weather.

The panel displays forecast valid time, provider fetch time, freshness and actual
coarse sampling coordinates. A county warning explains representative-point
weather is not county-wide weather. A 0.5° anchor is not a 3 km weather pixel.
ML risk/sample layers remain separately labeled; weather availability is not
evidence that real model predictions exist. Rolling-window/revision code is reused.

## Hosting and configuration

GitHub Pages is static frontend hosting only. Every push to main triggers
`frontend-pages.yml` with no path filter; feature branches do not deploy Pages.
Existing tests/typecheck/build/upload/deploy permissions and concurrency remain.

No public backend URL was configured in repository Actions variables at inspection.
Public live integration is BLOCKED until a separate reachable HTTPS FastAPI
deployment exists. No infrastructure/accounts are provisioned here.

- Build/Pages repository variable: `VITE_API_BASE_URL=https://<backend>/api/v1`.
  Leaving it empty retains clearly labeled demo mode.
- Runtime: `?api=https://<backend>/api/v1`; `?demo=1` explicitly selects sample mode.
- HTTPS pages reject insecure HTTP API requests with a clear error.
- Backend `CORS_ORIGINS=["https://arsalan5shaik.github.io"]` (plus explicit local
  development origins). Do not use wildcard origins or expose secrets.
- Backend `LOCATIONS_DATA_DIR` defaults to `frontend/public/data` resolved against
  `REPO_ROOT`; package/mount those files in backend deployments. `SHARED_DATA_DIR`
  remains the provider cache location. No changes to scheduler ownership/settings.

Local startup: run `python -m uvicorn app.main:create_app --factory --port 8000`
from `backend/`, and `npm run dev` from `frontend/`; open
`http://localhost:5173/?api=http://127.0.0.1:8000/api/v1` after configuring CORS.
Browser verification script: `node scripts/verify-locations.mjs` in frontend,
with `FIREWATCH_E2E_URL` and `FIREWATCH_E2E_OUTPUT` pointing at a running local app
and an external output directory. It uses installed Chrome and real backend APIs.
