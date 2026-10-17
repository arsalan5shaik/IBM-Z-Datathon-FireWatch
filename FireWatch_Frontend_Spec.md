# FireWatch — Frontend Product & Implementation Specification

**Project:** California Wildfire Intelligence Platform  
**Event:** 24-hour datathon · six-person team  
**Platform:** Responsive web application (desktop-first)  
**Design direction:** Apple Maps-inspired simplicity, with Google Maps-like **Default / Terrain** map styles and an independent **2D / 3D** toggle.

> **Amendments by the frontend owner (2026-10-17)** — see the end of this document. In particular the
> bottom timeline is **hourly** (168 hourly steps across seven days), not daily.

## 1. Product goal

Build a clean, map-first California wildfire intelligence web app that combines:

1. **Live fire activity:** NASA FIRMS satellite hotspot detections, plus official incident/perimeter data where available.
2. **Seven-day wildfire risk forecast:** ML-generated, day-by-day geographic risk overlays using forecast weather, vegetation/fuels, terrain, and historical fire information.
3. **Location search:** California city, town, county, and ZIP code searches, with boundary-aware map navigation.
4. **Explainable AI:** SHAP explanations for selected predicted-risk areas.
5. **Contextual AI chatbot:** Questions answered using actual incident, weather, forecast, and SHAP backend data.
6. **Wind layer:** Wind direction and speed, including day-specific forecast wind when available.
7. **Map controls:** Google Maps-like Default/Terrain style selector and separate subtle Apple Maps-like 2D/3D toggle.

**Explicitly out of scope:** Historical playback, population-exposure analysis, dedicated fire-spread simulation, and a permanently visible fire detail card at the top right.

## 2. Overall visual design

- **Full-bleed map:** The map occupies nearly all available space beneath a thin top bar. No large dashboard, permanent left navigation rail, or multi-panel analytics layout.
- **Apple Maps-inspired aesthetic:** Soft, light cartographic colors; readable roads and labels; rounded floating controls; restrained shadows; compact typography; generous map space.
- **Desktop-first web layout:** Primary reference is a wide browser window, **not** a phone mockup. Make responsive adaptations for tablets and phones.
- **Minimal by default:** The only persistent UI is a top bar, a small vertical control stack, a compact risk legend, and a seven-day timeline. Other panels appear **only when invoked**.
- **No permanent top-right Park Fire card.** A fire or risk-zone detail appears only after clicking a map feature and closes on demand.
- **Risk overlay palette:** Orange → Red → Purple, with **purple indicating the highest risk/intensity**. Avoid green/yellow for fire-risk severity. The underlying map remains legible.
- **Separate concepts visually:** Live satellite detections and model-predicted risk are different datasets. Fire radiative power (FRP), when shown, is a hotspot intensity proxy, **not** an ignition probability or official incident severity rating.

## 3. Screen anatomy

```text
┌───────────────────────────────────────────────────────────────────────────────────┐
│ 🔥 FireWatch     [ Search city, town, county, or ZIP…                ]   California │
├───────────────────────────────────────────────────────────────────────────────────┤
│ [2D]                                                                              │
│ [3D]          Full-width interactive California map                               │
│ [Layers]      • City labels, roads, land cover                                     │
│ [Wind]        • Live fire markers and available perimeters                         │
│ [Locate]      • Orange / red / purple wildfire risk overlay                        │
│ [+] [−]       • Wind arrows/streamlines when enabled                               │
│                                                                                   │
│                                        (Optional click-open detail panel)         │
│                                                                                   │
│ [Fire risk:  Orange ───── Red ───── Purple (highest)]                              │
│                  [Live | Day 1 | Day 2 | Day 3 | Day 4 | Day 5 | Day 6 | Day 7]    │
│                                                         [Ask FireWatch AI ✦]      │
└───────────────────────────────────────────────────────────────────────────────────┘
```

This is a layout diagram, not an instruction to add visible borders or labels around the map.

## 4. Every visible button and interaction

### A. Top bar

| Control | Action | Behavior |
|---|---|---|
| **FireWatch logo/name** | Return to California overview | Restores statewide extent; does not erase user preferences unnecessarily. |
| **Search field** | Search California places | Autocomplete city, town, county, and ZIP; choose a result to fly to its boundary. |
| **Search clear (×)** | Clear query | Removes search text and temporary search highlight. |
| **California label** | Show geographic scope | Read-only or compact label; no need for a state selector because app is California-only. |

**Search details:**
- Resolve a chosen place to a geographic boundary (GeoJSON), highlight its outline, and fit the map to its bounding box.
- Support city/town names, counties, and ZIP/ZCTA approximations. A ZIP code is not always identical to a city or a precise USPS delivery boundary; label approximations appropriately.
- If multiple places share a name, show county context in the suggestions.
- Reject or clearly explain out-of-California searches.
- Search selection should update the detail panel's location context and chatbot context.

### B. Left-side floating map controls

| Button | Action | Behavior |
|---|---|---|
| **2D** | Flat map | Set pitch to 0° and turn off terrain elevation rendering; keep current center, zoom, and data layers. |
| **3D** | Subtle perspective | Animate to roughly 20–30° pitch with natural terrain elevation (1× exaggeration or less); preserve center, zoom, overlays. |
| **Layers** (stack icon) | Open compact popover | Choose **Default** or **Terrain** map style and toggle data overlays. |
| **Wind** (wind icon) | Quick wind toggle | Show/hide wind vectors without opening the full layers popover. |
| **Locate** (navigation arrow) | Recenter to device | Request browser geolocation permission; only recenter if inside California; show an unobtrusive error otherwise. |
| **Zoom + / −** | Zoom map | Same behavior in both 2D and 3D. Mouse wheel, trackpad, drag, and pinch also work. |
| **Compass/reset bearing** (optional) | Reset north | Only display when map bearing differs from north. |

### C. Layers popover — opened on demand

**Map style (single selection):**
- **Default:** Google Maps-like clean standard map — roads, towns, waterways, park/vegetation coloring, and readable labels.
- **Terrain:** Google Maps-like terrain map — shaded relief and topographic context; preserve the same roads, place names, and overlays.

**Important: Map style and camera perspective are independent controls.** All four combinations must work:

| | 2D | 3D |
|---|---|---|
| **Default** | Flat standard map | Slightly tilted standard map; optional subtle building extrusions at close city zoom. |
| **Terrain** | Flat top-down shaded relief | Slightly tilted natural terrain elevation; no dramatic mountains. |

**Data layer switches (independent toggles):**
- **Live Fires:** Satellite hotspot markers, detection timestamps, and optional official incident/perimeter outlines.
- **7-Day Risk:** Forecast risk raster/grid polygons with orange→red→purple fills and zoom-aware boundaries.
- **Wind:** Direction arrows or streamlines and speed on hover/click; use selected forecast day's wind when appropriate.
- **Weather:** Optional temperature, humidity, precipitation summary on click; avoid filling the map with competing weather colors by default.
- **Vegetation:** Optional simplified vegetation/land-cover overlay; should not obscure fire-risk colors.
- **Fire Perimeters:** Official known perimeters where available; distinguish them from model risk contours.

Recommended defaults: **Default** map style, **2D** view, **Live Fires ON**, **7-Day Risk ON** (with clearly indicated forecast day), **Wind OFF**, **Weather OFF**, **Vegetation OFF**, **Perimeters ON** where data exists.

### D. Bottom forecast timeline

- Compact horizontal strip anchored near the bottom center, not a large chart.
- Buttons: **Live / Today / Day 1 / Day 2 / Day 3 / Day 4 / Day 5 / Day 6 / Day 7**; label with actual local dates once the data is available.
- **Live** focuses on current detections; selecting a forecast day changes the predicted risk overlay and forecast wind/weather values. Live fire markers may remain visible if the live layer is toggled on, but must be visually distinguished from predictions.
- **Play / Pause** automatically advances through forecast days; stop at Day 7 or loop only if clearly indicated.
- **Previous / Next** may be handled via keyboard arrows or compact chevrons; no need for extra persistent buttons.
- Display the forecast generation timestamp and distinguish **prediction valid date** from **data updated time** in an accessible tooltip or small info text.
- Changing days must not reset the current map position, style, or 2D/3D mode.

### E. Compact risk legend

- Small bottom-left floating card or pill.
- Gradient: **Orange → Red → Purple**.
- Labels: **Elevated / High / Very High / Extreme** (or calibrated numeric bins if validated).
- Show **“Predicted wildfire risk”** when forecast layer is on; show a different legend for NASA FRP/intensity when that mode is selected. Never imply that hotspot intensity and future risk share one metric.
- Risk polygons should have a gentle glow/highlight around elevated-risk boundaries, particularly as the user zooms in; use restrained opacity to keep roads legible.

### F. Clicking the map — contextual information panel

**There is NO permanent Park Fire card or top-right incident card.** Instead, clicking a hotspot, known incident/perimeter, or predicted risk cell opens a compact right-side slide-over on desktop or bottom sheet on narrow screens.

For an **active fire/hotspot**, show only available verified fields:
- Incident name (if matched to an official incident), location, source, last observation/update time.
- Satellite detection confidence and FRP when available; acreage/containment only if linked to an official incident record.
- “View on map,” “Close,” and “Ask AI about this” actions.

For a **predicted risk zone**, show:
- Selected place/grid cell, forecast date, model risk score and category.
- Temperature, humidity, wind speed/direction, precipitation, and vegetation/fuel context if available.
- **Why this risk?** button revealing SHAP feature contribution bars (positive/negative contributions and a plain-English explanation).
- **Ask AI about this area** button opening chatbot with the selected location/day prefilled as context.
- **Close (×)** to return to an unobstructed map.

Do not invent incident status, containment, evacuation orders, or SHAP values. If missing, show “Unavailable.”

### G. AI chatbot

- Small floating **Ask FireWatch AI** button at bottom-right.
- Opens a dismissible compact drawer; **not** an always-visible sidebar.
- Input box, **Send** button, **Close** button, optional suggested questions.
- Example prompts: “Why is Stockton high risk on Day 4?”, “What live fires are near Sacramento?”, “How is wind affecting this area?”, “What contributed most to this prediction?”
- Backend retrieves the actual selected location, model output, SHAP explanation, forecast weather, and available incident data. Show data timestamps/sources; answer “not available” instead of hallucinating.
- Do not provide unsupported real-time evacuation guidance; link users to official emergency sources when safety decisions are involved.

## 5. Map appearance and zoom behavior

### At California-wide zoom
- Clear city names and major roads, sparse hotspot icons, broad orange/red/purple risk regions, no excessive text or cards.
- Aggregate dense hotspot points into clusters or simplify marker display.

### At city/county zoom
- More local roads, neighborhoods, land cover, fire-risk cell boundaries, wind arrows at an appropriate density.
- Show searched boundary outline with subtle highlight; click an individual risk zone for details.

### At street/neighborhood zoom
- Road and block-level cartographic detail where provided by map tiles; optional simple 3D building extrusions in 3D mode.
- **Do not fabricate street-level ML precision:** forecast grid resolution remains the actual model resolution even as map tiles get sharper. Zoom may reveal polygon edges, but must not invent finer predictions.
- Risk boundary glow should scale visually with zoom without shifting away from its geographic polygon.

### Subtle 3D requirements
- One map instance and one shared set of GeoJSON/vector/raster sources for both perspectives.
- Camera pitch default **25°** in 3D; bearing stays north unless user rotates.
- Natural terrain elevation (approximately 1× vertical exaggeration or less); no dramatic Flyover-style cinematic effect.
- Use terrain-aware map rendering so risk polygons, hotspot markers, wind vectors, and perimeter outlines remain geographically aligned in 3D.
- Keep labels readable at tilted angles; test mountain slopes and close-up city views.
- Transition with a short smooth animation (~600–900 ms).

## 6. ML and data integration requirements

### Inputs
- **NASA FIRMS**: Near-real-time satellite thermal anomaly/hotspot observations, including observation times and FRP where available.
- **Official incident/perimeter feeds**: CAL FIRE and/or other official fire datasets as available; perimeters may lag current activity.
- **Weather forecasts**: Temperature, humidity, wind speed/direction, precipitation, and derived dryness features for each forecast day.
- **Environment**: Tree/shrub/grass land cover, vegetation density or fuels, drought/fuel moisture proxies, slope, aspect, and elevation.
- **Historical fire observations**: Used for model training/validation, not as a historical playback frontend feature.

### ML output
- XGBoost baseline predicts **future ignition/occurrence risk per geographic cell and day**, not physical spread of an existing fire.
- Seven forecast-day layers (one forecast per valid date), each with `cell_id`, geometry, risk score, category, forecast date, and data/model version.
- SHAP contributions for selected cell/day; precompute or cache to keep clicks responsive.
- Chronological and geographic validation; avoid leakage from future hotspot observations. Calibrate probability outputs before labeling them as probabilities.
- Clearly label the model experimental and distinguish risk categories from official fire warnings.

### Suggested API contracts

```text
GET /api/places/search?q=Stockton
GET /api/places/{place_id}/boundary
GET /api/fires/live?bbox=...
GET /api/fires/perimeters?bbox=...
GET /api/forecast/risk?date=YYYY-MM-DD&bbox=...
GET /api/forecast/wind?date=YYYY-MM-DD&bbox=...
GET /api/forecast/cell/{cell_id}?date=YYYY-MM-DD
GET /api/explain/{cell_id}?date=YYYY-MM-DD
POST /api/chat   {message, place_id?, cell_id?, date?, incident_id?}
GET /api/status  (dataset update times and health)
```

Return geographic data as GeoJSON or suitable tiled/vector formats, with bounding-box filters and caching. Dates are California-local calendar dates; store canonical timestamps in UTC.

## 7. Suggested stack for the 24-hour build

- **Frontend:** Next.js + TypeScript + Tailwind CSS.
- **Map:** Mapbox GL JS (map styles, terrain elevation, camera pitch, building extrusions, GeoJSON/raster layers); check token, pricing, and attribution requirements.
- **Backend:** FastAPI (Python).
- **ML:** XGBoost + scikit-learn + SHAP.
- **Geospatial:** GeoPandas/Shapely; PostGIS if already available, otherwise pre-generated GeoJSON/tiles for MVP.
- **Wind:** Sampled wind vectors rendered as map-native arrows/lines; particle animation is optional polish.
- **Chatbot:** LLM API grounded in backend function responses.
- **Hosting:** Deploy in the datathon's IBM LinuxONE environment if required; verify runtime compatibility early.

## 8. 24-hour MVP acceptance checklist

- [ ] Web app opens to a clean California overview with **no permanent fire detail card**.
- [ ] Search resolves California city, town, county, and ZIP with a visible selected boundary.
- [ ] **Default ↔ Terrain** changes map style without resetting map position.
- [ ] **2D ↔ subtle 3D** changes pitch/elevation without resetting map position.
- [ ] All four combinations (Default 2D, Default 3D, Terrain 2D, Terrain 3D) work.
- [ ] Live NASA hotspots display with timestamps and source; official perimeters shown where available.
- [ ] Seven-day timeline switches model forecast overlays for all seven days.
- [ ] Fire-risk colors follow **orange → red → purple (highest)** with a correct legend.
- [ ] Risk polygons have restrained glow, remain aligned in 2D/3D, and remain consistent when zoomed.
- [ ] Wind quick-toggle shows directional indicators and speed; selected day changes forecast wind data.
- [ ] Layers popover toggles fire, risk, wind, weather, vegetation, and perimeters independently.
- [ ] Clicking a risk area opens a dismissible details panel with model score, weather, and SHAP explanation.
- [ ] Clicking a fire opens details only on demand; no invented containment/acreage.
- [ ] AI button opens a compact contextual chat and can explain the selected location/day.
- [ ] Panels close easily; no clutter or permanently open analytics dashboards.
- [ ] Loading/error/empty states and source update timestamps are visible when relevant.
- [ ] Responsive desktop and mobile layouts; mouse, touch, and keyboard interactions work.
- [ ] Demo works with cached fallback data if a live API fails, clearly labeled as cached/demo data.

## 9. Scope guardrails

**Must build:** Map, two map styles, 2D/3D toggle, search, live detections, 7-day risk, wind, clickable zone details, SHAP, chatbot, legend, timeline.  
**Only if time remains:** Richer weather/vegetation visual layers, animated wind streamlines, detailed 3D buildings, advanced marker clustering and transitions.  
**Do not build:** Historical playback, population exposure, fire-spread simulation, permanent Park Fire card, giant analytics dashboard, or separate 3D rendering engine.

## 10. Primary user journey

1. Open FireWatch → see a clean California map with live fire markers and risk overlays.
2. Search “Stockton” → map smoothly zooms to the area and outlines the location.
3. Toggle **Default / Terrain** and **2D / 3D** independently.
4. Enable wind → see wind direction and speed indicators.
5. Select **Day 4** → risk overlay and forecast wind update, using orange/red/purple severity colors.
6. Click a purple risk cell → details panel explains forecast conditions and SHAP factors.
7. Click **Ask AI about this area** → chatbot answers using that cell/day's actual backend data.
8. Close panels → return to a mostly unobstructed map.

**Design principle:** The map is the product. All intelligence should be one click away, never permanently in the way.

---

## Amendments (frontend owner, 2026-10-17)

1. **Hourly timeline.** The bottom slider steps **hourly** across the 168-hour forecast window (with day labels,
   Live, play/pause, ±1 h / ±1 day and a day/hour picker) instead of seven daily buttons. This matches the
   backend's 168 hourly artifacts. Day-level summaries (e.g. "Day 4") are answered from the hourly data.
2. **Stack as built.** Vite + React + TypeScript + **MapLibre GL JS** (keyless OpenFreeMap basemap and AWS Terrain
   Tiles) instead of Next.js/Mapbox, so the static build can be served by the Python backend on LinuxONE and by
   GitHub Pages without tokens. Implementation: `frontend/`.
3. **API routes.** The frontend calls the routes in `FireWatch_Backend_Architecture.md` §7 under `/api/v1`
   (superseding §6's suggested paths above). Details and open items: `frontend/API_INTEGRATION.md`.
