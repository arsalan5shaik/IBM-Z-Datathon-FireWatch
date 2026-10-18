# FireWatch — frontend

Map-first California wildfire intelligence UI: live NASA satellite hotspots, an **hourly** 7-day
experimental risk forecast, wind and weather, place search, SHAP-style explanations and a grounded
AI assistant. Vite + React + TypeScript + MapLibre GL JS (one map instance for 2D/3D and Default/Terrain).

**Live demo (sample data):** https://arsalan5shaik.github.io/IBM-Z-Datathon-FireWatch/

## Quick start

```bash
cd frontend
npm.cmd ci
npm.cmd run dev        # http://localhost:5173 — runs on built-in SAMPLE data
npm.cmd test           # unit tests (vitest)
npm.cmd run build      # type-check + production build → dist/
```

Node 20+ (CI uses 24). No API keys are needed: the basemap (OpenFreeMap), terrain (AWS Terrain Tiles)
and boundaries (US Census, bundled) are all keyless.

For the real FastAPI connection on Windows, use the two-terminal instructions in
[API_INTEGRATION.md](API_INTEGRATION.md). The local integration preview uses port 5174.
Validated ML artifacts are pending; API forecast unavailability is shown explicitly.

## Data modes

| Mode | How | What you see |
|---|---|---|
| **Sample** (default) | no configuration, or `?demo=1` | Everything generated in the browser relative to the current hour; badge **SAMPLE DATA** |
| **Backend** | build with `VITE_API_BASE_URL=/api/v1`, or open `?api=https://host/api/v1` | Data from the FireWatch API; badge **API** / actual availability |
| **Unavailable API data** | backend configured but observations or forecasts fail | Explicit unavailable state; a failed refresh retains labeled stale last-good data. No synthetic replacements. |

The client follows the backend routes in `FireWatch_Backend_Architecture.md` §7 (`/forecasts/risk` bbox+hour tiles,
`/forecasts/cell`, `/fires/live`, `/wind`, `/explain`, `/chat`). Endpoints, fields, fallbacks and open items are in
**[API_INTEGRATION.md](API_INTEGRATION.md)**. In backend mode the 3 km risk grid loads for the visible area, so
the statewide view asks you to zoom in.

Mock backend for development (serves the API contract from the sample generator):

```bash
FIREWATCH_MOCK_API=1 npm run dev     # then open http://localhost:5173/?api=/api/v1
FIREWATCH_MOCK_ONLY=forecasts ...     # only the routes backend/ implements today; the rest 404
FIREWATCH_MOCK_CHAT=503 ...           # make /chat fail to exercise the offline-assistant fallback
```

Proxy a real backend during development: `FIREWATCH_API_PROXY=http://localhost:8000 npm run dev` and open `?api=/api/v1`.

## What's in the UI

- **Top bar** — logo (California overview), search (city / town / CDP / county / ZIP, typo tolerant, coordinates,
  out-of-state and street-address handling), map-centre weather, data-status pill (opens data sources & timestamps).
- **Left controls** — 2D / subtle 3D (25° pitch, 1× terrain), Layers popover (Default/Terrain, Live fires,
  7-day risk, perimeters, wind, weather, vegetation, hotspot lookback, risk opacity, units), wind quick toggle,
  locate me (California only), zoom, compass when rotated. Default/Terrain is also top-right.
- **Hourly timeline** — Live + 168 forecast hours, day labels in California time, play/pause (1×–16×) with a
  gliding playhead, ±1 h / ±1 day, wheel/trackpad scrubbing, hover previews, night bands, a moving "now" marker,
  calendar jump (incl. statewide peak), risk-trend sparkline (statewide or selected area), backend buffer bar
  (playback waits for the next hour's tiles), valid-time vs model-run vs data-update times.
- **Map** — continuous score colors for API risk (sample mode retains its demonstration categories), flame markers for hotspot clusters,
  FRP-sized / age-coloured detections, official perimeters (solid) vs illustrative hotspot influence
  (dashed), wind arrows pointing downwind plus animated wind-flow streaks, weather labels, fuel types,
  California mask, search outline, optional day/night shading and 3D risk skyline.
- **Motion** — risk colours morph between hours, overlays fade, the statewide view is a smoothed surface that
  hands over to model cells as you zoom in, flame markers cluster and split with zoom, fresh hotspots pulse,
  hotspot replay (last 24/48 h, event-paced), pull-back intro, panels slide in/out, values count to new
  numbers. `prefers-reduced-motion` (or *Layers → Smooth motion*) turns animation off; heavy derived data
  runs in a Web Worker (`src/workers/`).
- **Details panel** (on click only; draggable bottom sheet on phones) — forecast cell, place, hotspot, incident or
  hotspot cluster: risk score/category, hourly 7-day chart (click to jump), conditions, *Why this risk?*
  SHAP bars, nearby fire activity, Ask AI.
- **FireWatch AI** — contextual chat (selected place/cell/hour), backend LLM when available, otherwise an
  offline assistant that answers only from loaded data and never gives evacuation advice.
- Shareable URL (camera, style, 2D/3D, layers, hour, selection), keyboard shortcuts (`?`), offline/stale/error
  states, reduced-motion support.

## Project layout

```
src/
  api/        provider interface, backend client (remote.ts), static geography loaders, fetch helper
  mock/       SAMPLE generator: scenario weather, additive log-odds model (exact SHAP), fires, perimeters
  state/      zustand store, data loading/polling/fallback, lookups, URL state, chat, keyboard
  map/        MapLibre setup, style patching (terrain/hillshade), layers, store→map sync, interactions, markers
  components/ top bar, search, controls, legend, timeline, panels, charts, chat, dialogs
  lib/        time (California), geo, search ranking, risk scale, formatting, contours, offline assistant
public/data/  Census boundaries + search index, sample forecast grid (generated, see below)
mock-api/     dev-only Vite middleware that speaks the backend contract
scripts/      data builders
```

Sample-only categories: `src/config.ts` (`RISK_LEVELS`, `RISK_RAMP`). Real API scores use a continuous 0–100 display; ML category thresholds are pending.

## Regenerating static data

```bash
npm run data:geo    # Census state/county/place/ZCTA boundaries + search index → public/data/
npm run data:grid   # SAMPLE hex grid with DEM terrain, historical FIRMS counts (repo CSVs), heuristic fuels
```

Both cache downloads in `scripts/.cache/` (or `CENSUS_DIR` / `DEM_DIR`). The sample grid is demo
scaffolding only — production geometry comes from the ML grid via the API.

## Deploying

- **GitHub Pages:** `.github/workflows/frontend-pages.yml` builds, tests and deploys on pushes to `main`; its optional `VITE_API_BASE_URL` repository variable selects a deployed backend.
- **With the Python backend:** `npm run build` and serve `frontend/dist/` as static files on the same origin as
  `/api/v1` (the build uses relative asset paths). Build with `VITE_API_BASE_URL=/api/v1` to make it the default.

## Honesty rules the UI enforces

Hotspots ≠ perimeters; FRP ≠ fire size or risk; risk is a modeled occurrence-risk score out of 100, with calibration unverified; illustrative influence shapes are never reported as burned area; missing values show
“Unavailable”; sample data is always labelled; no evacuation advice — links to official sources instead.
