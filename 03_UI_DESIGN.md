# FireWatch v4 — React UI / interaction specification

## Design target
California-only, map-first, dark control-panel feel inspired by FireMap.live. Do not copy branding, artwork or source UI. Keep map available at all times; tools float over it. Real basemap and terrain tile sources must be configured with attribution and suitable access terms. Mockup coordinates and demo scores are illustrative.

## Desktop wireframe
```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ 🔥 FIREWATCH   [ Search California: ZIP / town / county ...     ] [2D | 3D] [⟳] │
├───────────────────────────────────────────────────────────────────────────────────┤
│ ┌ Layers ─────────────┐                 CA MAP                  ┌ Location ────────┐│
│ │ ● Current detections│                                           │ Stockton, CA     ││
│ │ ◉ 7-day risk       │      glow points / smoothed risk grid     │ 7-day score      ││
│ │ ◯ Both             │                                           │ factors / weather││
│ │ [intensity opacity]│      ← terrain when 3D is enabled →      │ recent hotspots  ││
│ │ [age: 24h 48h]    │                                           │ [Ask about area] ││
│ │ Legend + timestamps│                                           └──────────────────┘│
│ └─────────────────────┘                                                             │
│ [NASA observation timestamp] [Risk window]   [⚠ not an official perimeter]          │
│                                                                    [💬 Ask FireWatch]│
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Visual style
- Full-viewport realistic map, dark/satellite-style selectable basemap, muted slate glass panels, subdued borders, warm orange/red detections versus amber-to-violet future risk. Keep legend separate. Avoid heavy animations, fake smoke, or real-time claims.
- Top left logo + concise subtitle. Top center search input and suggestions dropdown; top right 2D/3D and refresh status with data age.
- Left floating layer switcher: Observed / Risk / Both, relative opacity, detections within 24 or 48 hours, legend. Both mode disabled if overlapping colors cannot be read clearly.
- Right selected-location inspector appears after click/search. Four sections: current detections; forecast with score type and horizon; explanation factors (+/− raw contributions as bars); nearby weather; Ask AI action.
- Lower-right chat drawer that preserves map selection. Suggested prompts, source times, grounded answers, citations to datasets used; failure-safe if LLM unavailable.
- Mobile: collapsed layer panel, compact top search, bottom-sheet inspector/chat; controls remain keyboard reachable.

## React component tree
```
App
 ├─ DashboardHeader
 │   ├─ PlaceSearch (debounced /places)
 │   ├─ MapModeToggle (pitch + terrain)
 │   └─ FreshnessBadge (/status)
 ├─ FireWatchMap (one persistent MapLibre map)
 │   ├─ CaliforniaBoundaryLayer
 │   ├─ HotspotClusterLayer (fires GeoJSON; low zoom)
 │   ├─ HotspotPointLayer (fires GeoJSON; high zoom)
 │   ├─ InfluenceLayer (coverage GeoJSON; high zoom only)
 │   ├─ RiskHeatmapLayer OR RiskPolygonLayer (risk GeoJSON)
 │   └─ SelectionOutlineLayer
 ├─ LayerControlPanel (view, lookback, opacity, legend)
 ├─ LocationInspector (GET /locations/:id)
 │   ├─ FireObservationSummary
 │   ├─ SevenDayRiskCard
 │   ├─ FeatureContributionBars
 │   └─ WeatherSummary
 ├─ ChatDrawer (POST /chat)
 └─ SafetyDisclaimer
```

## Required state
```ts
type LayerMode = 'observed' | 'risk' | 'both';
type MapMode = '2d' | '3d';
type DataState = 'loading' | 'ready' | 'stale' | 'error';
type UIState = {
  layerMode: LayerMode;
  mapMode: MapMode;
  firesOpacity: number;
  riskOpacity: number;
  lookbackHours: 24 | 48;
  selectedPlaceId: string | null;
  searchQuery: string;
  chatOpen: boolean;
};
```

## Key interactions / precise behavior
1. **Initial load:** create one MapLibre map centered `[-119.5, 37.2]`, zoom ~5.3; California boundary mask and 2D basemap; fetch `/fires`, `/risk`, `/status` concurrently. Show real timestamps and stale/error states. Do not fetch NASA directly in browser.
2. **Zoom 4–8:** clustered points and/or MapLibre heatmap from FRP normalized `display_weight`; risk translucent cell heatmap, no individual pseudo-perimeters. Hover shows confidence/source/time, click selects nearest location.
3. **Zoom ≥ 8:** reduce overview glow, show detected points + separate *illustrative influence* layer from `/coverage`. Use feathered style/fills; warn prominently. Never calculate burned acreage from these shapes. If no coverage geometry available, keep only dots rather than inventing fire extents.
4. **Forecast:** risk values fill grid polygons. Tooltip: seven-day hotspot risk score, target/uncalibrated label, forecast start/end; exact point selection maps to cell ID. Feature explanations come from selected location response, not on each mousemove.
5. **Search:** debounce 300 ms to `/places`, keyboard navigation, display city/county/ZIP labels and CA-only results, `fitBounds` selected bbox, show inspector; if user searches an address, clarify that only place/ZIP/county supported.
6. **2D ⇄ 3D:** *never unmount/recreate map*. 2D `map.easeTo({pitch:0,bearing:0})` and turn off terrain; 3D `map.setTerrain({source:'terrain',exaggeration:1})` when DEM source loaded, `map.easeTo({pitch:60})`; keep all GeoJSON layers unchanged. If terrain unavailable use pitched basemap with label `3D terrain unavailable` and keep map functional. Test overlay appearance at oblique camera angles.
7. **Chat:** button opens drawer and sends question with selected location id. UI appends dataset provenance and data date. Never imply chatbot knows live evacuation instructions.
8. **Refresh:** button requests backend refresh status only; backend refresh runs as scheduled/manual command. No client-driven expensive third-party calls.
9. **Loading/empty:** skeletons/spinners in panels, not replacing map; timestamps after last successful refresh, empty detections is valid.

## MapLibre technical decisions
- One source per data family: `fires-source`, `coverage-source`, `risk-source`, `california-boundary`; no map recreation on toggle.
- Circles / clusters are geo-positioned in both 2D and terrain mode. Native MapLibre `circle` and `heatmap` styling differs visually at pitch; test combinations and prefer polygons over heatmap when zoomed in. Terrain DEM from licensed tile source; 3D should convey elevation, not simulated smoke physics.
- Overlay filter uses layer visibility and `minzoom`/`maxzoom` instead of refetching on each zoom. Use `setPaintProperty` for opacity and `setLayoutProperty` for visibility. On style change, rebuild sources/layers only after `style.load`; preserve UI state.
- Clip California datasets upstream. Bounding box clamp is an interface convenience; real CA border is not rectangular.

## Acceptance criteria
- [ ] Real map tiles and California outline, proper attribution, 2D/3D controls operational.
- [ ] Both overlay families render from mocked endpoint fixtures without ML completion.
- [ ] Zoom changes dots to influence shapes without calling them fire boundaries.
- [ ] Observed vs forecast legend, provenance and dates visible in screenshots.
- [ ] City/town/county/ZIP search and selected-location inspection work.
- [ ] A working chat drawer receives backend response; provider failure doesn't crash app.
- [ ] Region selection remains unchanged after 2D/3D switch.
- [ ] Responsive 1366px desktop and narrow mobile layouts.
- [ ] No request to NASA or LLM API directly from browser.

## Handoff from application frontend to ML
For every grid cell: `cell_id`, polygon, risk score, level, model version, target definition, forecast window. For inspector: ordered feature drivers with contribution directions, feature names and values. ML does **not** write React or MapLibre code, and UI does **not** infer science from radiative power.
