# FireWatch frontend - milestones 1 and 2

React + TypeScript + Vite + MapLibre GL JS. All implementation changes live in `frontend/`.

## Run locally (Windows PowerShell)

From this folder:

```powershell
npm.cmd ci
npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Use `npm.cmd ci` after cloning to install the exact versions in `package-lock.json`.
Open http://127.0.0.1:5173/. Stop your server with Ctrl+C in its terminal.
If it is already running, use the existing server rather than starting a second one.

```powershell
npm.cmd run build
npm.cmd run lint
python scripts/prepare_hotspots.py --check
```

The build checks TypeScript and writes static output to `dist/`. Neither `dist/` nor `node_modules/` belongs in Git.

## Files to learn first

- `src/App.tsx`: assembles the page and prototype notices.
- `src/components/FireMap.tsx`: creates/cleans up MapLibre, preserves California reset/zoom/pan, draws a GeoJSON circle layer, and opens one observation popup at a time.
- `src/components/HotspotControls.tsx`: a React component (a reusable piece of UI) for date, visibility, opacity, legend, and data status. The parent passes its current settings and change callbacks as props.
- `src/api/client.ts`: fetches and validates local historical snapshots. This adapter is the future backend integration boundary; components do not read CSVs or contact NASA.
- `src/types/hotspots.ts`: TypeScript descriptions of hotspot records and local snapshot metadata, preserving shared API field names.
- `src/types/frp.ts`: shared legend colors/thresholds so map colors and labels agree.
- `scripts/prepare_hotspots.py`: standard-library Python conversion from team CSVs to bounded GeoJSON files.
- `public/data/historical/`: generated real observations and their manifest (a small list of available snapshots).
- `src/App.css` / `src/index.css`: layout, map height, controls, and popup styling.
- `src/main.tsx` and `index.html`: mount React in the browser.
- `package.json` / `package-lock.json`: commands, dependencies, and exact installed versions.

## Historical data coverage and provenance

| Source CSV in repository root | Source rows | UTC snapshot date | Snapshot rows | Approximate JSON size |
| --- | ---: | --- | ---: | ---: |
| FireWatch_California_VIIRS_SNPP_2024_StateBoundary.csv | 38,377 | 2024-09-10 | 1,626 | 0.69 MB |
| FireWatch_California_VIIRS_SNPP_2025.csv | 36,442 | 2025-09-07 | 1,081 | 0.45 MB |

Each snapshot includes **every row on the busiest date** in its source file (earliest date breaks ties). This deliberately activity-heavy selection demonstrates the layer; it is not a representative sample, trend estimate, full-year view, or count of separate wildfires. The UI offers these two dates only. No rows were invented, deduplicated, or filtered by confidence/type. Overlapping observations may hide one another on the map.

The repository CSVs have FIRMS VIIRS fields; original download provenance was supplied by the team and has not been independently audited. Their complete date ranges are 2024-01-01 through 2024-12-31 and 2025-01-01 through 2025-12-30. The 2025 CSV does not include December 31. Both contain satellite code N (Suomi NPP), instrument VIIRS, and product version 2. Do not relabel them as NOAA-21 or current NRT detections.

Each output records source filename, SHA-256, original row count, selected date, and CSV line numbers. Original download/refresh time is absent, so local `metadata.updated_at` is null. This local snapshot metadata is not a change to the shared backend contract. Data is `is_fixture: false` because these are actual source rows rather than synthetic contract fixtures.

Coordinates become GeoJSON `[longitude, latitude]`. Acquisition time is zero-padded to HHMM and combined with acquisition date as UTC `detected_at`. Original FRP, confidence, I4/I5 brightness temperatures, scan/track, day/night, inferred type, and version are retained. Invalid selected-row coordinates/times/non-finite measurements stop conversion rather than generate believable substitutes. Optional empty measurements become null. IDs derive from source filename and line, without rounding coordinates.

To regenerate after an intentional source update:

```powershell
python scripts/prepare_hotspots.py
```

This reads the two original files without modifying them and writes only `public/data/historical/`. If inputs change, the chosen busiest dates can change; review the manifest and remove any obsolete output deliberately. `--check` is read-only and compares generated contents against the current source files.

## FRP legend

NASA defines FRP as pixel-integrated fire radiative power, measured in MW. Display colors are:

- 0 to <10 MW: yellow
- 10 to <50 MW: orange
- 50 to <100 MW: red
- 100+ MW: magenta
- Missing FRP: gray

These are application display bins, **not validated fire intensity/severity classes**, future risk, burned area, or official alert categories. Confidence l/n/h means low/nominal/high detection quality, not wildfire probability. Brightness temperature is in Kelvin; scan/track are pixel dimensions, not fire perimeters. Inferred source type includes vegetation, volcano, static land sources, or offshore detections; preserve the source classification and do not treat it as incident confirmation. Measurements and source line are available in a text-safe, scrollable popup.

Reference: https://firms.modaps.eosdis.nasa.gov/content/descriptions/FIRMS_VIIRS_Firehotspots.html

## Responsiveness and integration boundary

Only one small snapshot (at most 1,626 points) is fetched and drawn at a time. GeoJSON is processed in a MapLibre worker and rendered by one circle layer, rather than creating an HTML marker per point. Visibility/opacity adjust layer properties without downloading data or rebuilding React/map instances. Date changes abort stale fetches and clear the previous data/popup during loading. Loading, missing-data, invalid-data, and retry UI are present. This bounded design is intended for a student laptop; no formal RAM/frame-rate benchmark has been performed.

MapLibre v6 requires explicit Vite worker configuration:

```ts
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
setWorkerUrl(workerUrl)
```

This is needed even when the raster basemap alone appears to work. See https://maplibre.org/maplibre-gl-js/docs/#installation.

The authoritative API contract remains `../03_INTEGRATION.md`, including `/api/v1/regions`, `/api/v1/hotspots`, and `/api/v1/regions/{id}/risk`. The point layer consumes contract-named fields (`detected_at`, `satellite`, `frp_mw`, `confidence`, `is_fixture`). Local provenance and extra measurements are explicitly separate extensions. A future backend adapter can normalize the documented GeoJSON response for the same map source without changing the shared contract. Backend mode is not implemented in this milestone. The risk contract provides one seven-day aggregate score, not daily forecasts or forecast polygons. No model outputs or LinuxONE integration are claimed here.

The basemap uses public OpenStreetMap raster tiles. Internet and WebGL2 are required. Attribution stays visible. Respect https://operations.osmfoundation.org/policies/tiles/; do not bulk-download or prefetch tiles. Historical point files are local, but that does not make the basemap offline-capable.

## Manual verification

1. Open the app. Default date should be 2025-09-07 with 1,081 loaded observations.
2. Confirm colored points appear over California and compare colors with the FRP legend.
3. Uncheck Show hotspots. Points should disappear; basemap navigation should still work.
4. Recheck it; change opacity to 0%, then 50%, then 100%. Only the observation layer should change. Zero-opacity points should not open popups.
5. Choose 2024-09-10. The count should change to 1,626 and popups should use that date. Quickly switching dates must not leave old data under a new date.
6. Click a colored point. Verify UTC time, coordinates, FRP, confidence, brightness temperatures, source type, source filename/line, and historical disclaimer. Zoom in when points overlap.
7. Verify zoom buttons, drag/keyboard pan, and Reset California view still work, with hotspots staying geographically aligned.
8. Try a narrow browser window; controls should wrap and popup details should scroll.
9. If a local data file cannot load, the error/retry UI should appear without fabricating observations. Recovered files should load on Retry.

## Competition rules status

Implementation was prepared with AI assistance. Whether AI-generated implementation code is allowed has NOT been verified with the event organizers. Confirm the policy and disclosure requirements before submission. No eligibility claim is made here. No commit, push, merge, or PR is performed automatically.
