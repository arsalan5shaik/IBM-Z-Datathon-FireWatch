# FireWatch frontend - first milestone

React + TypeScript + Vite + MapLibre GL JS. All files for this milestone live in `frontend/`.

## Run locally (Windows PowerShell)

From this folder:

```powershell
npm.cmd ci
npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Use `npm.cmd ci` after cloning to install the exact versions in `package-lock.json`.
Open http://127.0.0.1:5173/. Stop the server with Ctrl+C in its terminal.

```powershell
npm.cmd run build
npm.cmd run lint
```

The build checks TypeScript and writes static output to `dist/`. Neither `dist/` nor `node_modules/` belongs in Git.

## Files to learn first

- `index.html`: the page containing React's root element.
- `src/main.tsx`: mounts the React application with development StrictMode checks.
- `src/App.tsx`: page header, map component, and prototype notice.
- `src/components/FireMap.tsx`: creates MapLibre once per mount and removes it on cleanup; fits California's bounds, adds zoom/scale controls, and handles map errors.
- `src/App.css` and `src/index.css`: layout and global styles, including an explicit map height.
- `package.json`: dependencies and dev/build/lint commands.
- `package-lock.json`: exact dependency versions for reproducible installs.
- `vite.config.ts` and `tsconfig*.json`: Vite and TypeScript configuration.

## Verify manually

1. California should be visible with a labeled basemap and attribution.
2. Click + / - or scroll to zoom. The zoom readout should change.
3. Drag the map, or focus the map and use arrow keys, to pan.
4. Click Reset California view to return to the overview.
5. Try a narrow window: the controls and map should still fit.

## Scope and integration

This milestone displays only a basemap. There are no hotspots, model results, mock predictions, API calls, or LinuxONE integration.

The authoritative API contract is currently `../03_INTEGRATION.md`, including `/api/v1/regions`, `/api/v1/hotspots`, and `/api/v1/regions/{id}/risk`. Its risk result is one seven-day aggregate score; it does not provide seven daily forecasts or forecast polygons. Frontend development must not invent these values or silently change the contract. Future API integration belongs in `src/api/client.ts` when implemented.

The basemap uses public OpenStreetMap raster tiles. An internet connection and WebGL-capable browser are required. Attribution is displayed by MapLibre. This is a development/demo basemap, not an offline tile bundle or a production hosting commitment. Respect https://operations.osmfoundation.org/policies/tiles/ when using these tiles; do not bulk-download or prefetch them.

References: https://vite.dev/guide/ and https://maplibre.org/maplibre-gl-js/docs/.

## Competition rules status

This implementation was prepared with AI assistance. Whether AI-generated implementation code is allowed has NOT been verified with the event organizers. Confirm the event's policy and any disclosure requirements before submission. No eligibility claim is made here.
