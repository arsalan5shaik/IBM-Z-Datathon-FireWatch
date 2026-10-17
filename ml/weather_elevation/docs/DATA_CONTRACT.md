# FireWatch shared data contract (proposal — finalize with team)

## Phase 2 implemented static contract

The shared grid is now `ca_3km_3310_v1`, with fixed EPSG:3310 origin `(0,0)`.
See [GRID_PILOT.md](GRID_PILOT.md) for exact output headers, permanent ID rules,
point/polygon joins and source checksums. `california_grid_3km.csv` and its GeoJSON
are statewide; `fresno_grid_pilot.csv` is the corresponding county-intersecting
subset. Cell geometry is always state-clipped, including in county subsets.

The implemented grid uses `latitude,longitude` for the interior sampling point,
with `x_m,y_m` and `sample_method`; these are **not** aliases of geometric centroid
coordinates. Do not assume the proposal's `centroid_latitude` fields below exist.
Full projected square bounds, state-clipped area, boundary/selection fractions,
and WGS84 geometry are supplied. Exact dry-land fraction is missing pending a
land/water mask. Grid-wide elevation has not been fetched.

Static feature joins use `(grid_version,cell_id)`. Grid-specific mapping files use
`grid_version,cell_id,weather_anchor_id,distance_km`. Anchor files include a `cell_id`
alias for compatibility with the existing pilot downloader. When using that
downloader's anchor weather output, explicitly rename `cell_id` to
`weather_anchor_id` before joining. No automatic bulk weather extraction is added.
The remaining sections describe the earlier proposal and historical handoff rules.

## Static grid file: `california_cells.csv`

`grid_version,cell_id,grid_km,centroid_latitude,centroid_longitude,cell_area_km2`

- Every row is a cell intersecting CA; store geometry in a separate GeoJSON if needed.
- `grid_version` locks origin, CRS and size, e.g. `ca_5km_v1`. Never mix rows from different versions.
- `cell_area_km2` is actual clipped area, not always exactly 9 or 25.

## Weather anchors: `weather_anchors.csv`

`weather_anchor_id,latitude,longitude,weather_source,weather_model`

- One anchor can serve multiple fine-grid cells; create `cell_weather_mapping.csv`:
  `grid_version,cell_id,weather_anchor_id,distance_km`.
- Log that a weather anchor's grid resolution differs from the target cell resolution.

## Daily weather: `weather_2024.csv`, `weather_2025.csv`

`weather_anchor_id,date,temperature_2m_max,temperature_2m_min,relative_humidity_2m_min,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant`

- Units: Celsius, percent, mm/day, m/s, m/s, degrees from north (wind **from** direction).
- Dates use America/Los_Angeles local-day boundaries; reconcile with NASA UTC timestamps.
- Store nulls, do not silently replace nulls with zero.
- Source label must indicate historical-weather vs stitched historical-forecast vs historical individual run.

## Elevation: `elevation.csv`

`grid_version,cell_id,latitude,longitude,elevation_m`

- Elevation is a one-time static point estimate, not a per-date variable.
- For slope, aspect, roughness, or relief, a single centroid elevation is insufficient; postpone these features unless an elevation raster or multiple samples are available.

## ML handoff

Merge features by `grid_version` + `cell_id`, and by `date` for temporal features. A final training row represents one cell at one valid prediction cutoff date. Teammates supply fire labels for (t+1 ... t+7) using an agreed exact definition. Do not use future outcomes or future realized weather as predictive features. Keep a time-based test year and evaluate calibration, PR-AUC and top-risk-cell recall rather than accuracy alone.

IMPORTANT: The bundled `fetch_weather_elevation.py` uses an earlier `cell_id`-based sample schema to help you test APIs today. Codex should refactor it in phases to the new anchor + cell schema after the team approves the grid. Do not silently merge both incompatible schemas.
