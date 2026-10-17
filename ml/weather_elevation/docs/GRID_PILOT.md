# Phase 2: shared 3 km California grid

The official prediction resolution is **3 km**. Grid generation is optional,
workstation-only preprocessing. Reading its CSV files on LinuxONE needs only the
Python standard library. The generator has **no network code** and never fetches
weather, elevation, wildfire labels or vegetation.

## Measured results

| Scope | Prediction cells | Unique weather anchors | Legacy unbatched weather requests, 2024 + 2025 | Elevation batches of 100 |
|---|---:|---:|---:|---:|
| Fresno pilot | 1,906 | 205 | 410 | 20 |
| Statewide | 48,019 | 4,472 | 8,944 | 481 |

These counts are from generated geometry, not area-only estimates. There are
334 county-edge partial selection cells in the pilot and 1,733 state-boundary
partial cells statewide. All 1,906 pilot cells exactly match their statewide IDs,
sampling points, geographic geometries and anchors; only their region selection
fraction differs. Every cell has exactly one exported anchor mapping.

Statewide CSV and GeoJSON sizes are approximately 62 MB and 84 MB; the pilot
files are about 2.5 MB and 3.3 MB. Anchor-based daily weather would produce 149,855
pilot rows or 3,269,032 statewide rows across the 731 historical days, before
joining onto prediction cells. Weather/elevation requests listed above were not
made. Elevation batch counts still represent 1,906 or 48,019 point lookups.
All 20 offline tests passed in the GIS environment, including all 12 existing
weather/elevation tests; the dependency-free interpreter passed 13 tests and
skipped the seven GIS-only tests. Builds also checked the real boundary outputs.

Final verification on 2026-10-17 reran all 20 tests in `.venv-gis`: 20 passed,
zero failed, zero skipped. An additional standard-library artifact check loaded
both CSV/GeoJSON pairs, verified every feature ID and geographic geometry against
its CSV row, confirmed every cell has exactly one valid anchor mapping, and
compared all 1,906 Fresno cells with the statewide export. All checks passed.
The only scope-dependent cell field is `selection_coverage_fraction`.

All generated artifacts are ordinary files saved in this project's
`data/processed/` directory; the source archives and retrieval manifest are in
`data/raw/ca_boundaries/`. They survive closing VS Code and Python. Being ignored
by Git does not delete them, but Git does not back them up. Preserve or copy these
directories with their metadata when sharing or moving the project.
This records the completed grid phase. The later batch extraction pilot and
current quota estimates are documented in [EXTRACTION_PIPELINE.md](EXTRACTION_PIPELINE.md).
No statewide weather or elevation collection has been started.

## Source and reproducibility

Source: [California Geographic Boundaries](https://data.ca.gov/dataset/ca-geographic-boundaries),
published by the California Department of Technology. The catalog describes 2023
Census MAF/TIGER state and county boundaries, generally effective January 1, 2023,
with no restrictions on public use. The catalog's 2026 update date is not a 2026
wildfire dataset. We retrieved only its state and county ZIPs, about 2.7 MB total.

`docs/BOUNDARY_SOURCES.json` pins resource URLs and SHA-256 checksums. The downloader
and builder refuse changed archives. `data/raw/ca_boundaries/manifest.json` adds
the actual retrieval time. Archive contents are read in memory, without extraction.
The shapefiles have Web Mercator `.prj` files; the builder reads their definitions
and transforms each to EPSG:3310. It does not assume source coordinates are WGS84.
It selects California by STATEFP `06` and Fresno County by GEOID `06019`.

## Fixed spatial contract

- Projected CRS: EPSG:3310, California Albers, meters. Geographic export: EPSG:4326.
- Fixed statewide origin: **x=0, y=0 meters**. No county-specific origin or extent.
- Cell southwest corner: `(column*3000, row*3000)`. Each full square is exactly
  3,000 by 3,000 projected meters, with area 9,000,000 square meters. This describes
  map-plane dimensions, rather than exact ground-distance measurements everywhere.
- Grid version: `ca_3km_3310_v1`. ID: `ca_3km_3310_v1_c{column}_r{row}`, including
  signed integer indices, for example `ca_3km_3310_v1_c-10_r-20`.
- Keep a cell only if its overlap with the selected California region has positive
  area. Mere boundary contact is excluded. All authoritative cell geometries are
  clipped to the **state** polygon. Holes and islands are preserved.
- A Fresno pilot cell has positive-area overlap with Fresno County. Its geometry
  remains the state-clipped statewide cell; it is not cut off at the county line.
  This prevents two counties from publishing different versions of one cell.
- `selection_coverage_fraction` describes the fraction inside the selected region
  (Fresno or California). This is the only per-cell field that changes by scope.
- `boundary_coverage_fraction` is state-clipped area / full square area. All Fresno
  cells lie inside the state, so their state fractions are 1 even at county edges.
- **Land/water limitation:** the source is an administrative polygon and includes
  water. It supplies ALAND/AWATER totals, not per-cell water geometry. Therefore
  `land_coverage_fraction` is blank/null. Do not substitute the boundary fraction
  or proportionally distribute statewide ALAND. Exact dry-land coverage requires
  an additional versioned spatial land/water mask, still outstanding.
- API sampling point: centroid of the state-clipped cell when strictly inside;
  otherwise a point on its interior. `sample_method` records the choice. Sample
  points and anchors are independent of county scope. A county-selected cell's
  statewide sampling point can be outside that county.
- GeoJSON uses `[longitude, latitude]`. Projected polygon edges are densified at
  at most 500 m before transformation, without boundary simplification. Full
  squares can be reconstructed exactly from their projected bounds.

The lattice origin, size and ID convention are now fixed for this implementation.
Share the metadata and source lock with teammates before training. Changing the
origin, CRS, size, boundary interpretation or sample policy requires an explicit
versioning decision. Changing CRS operation/library versions can also affect
coordinates: the metadata records Python, PROJ and package versions.

## Files and headers

The requested outputs are in `data/processed/`:

- `fresno_grid_pilot.csv` and `.geojson`: Fresno-intersecting subset.
- `california_grid_3km.csv` and `.geojson`: statewide geometry; no API features.
- Each grid has `.metadata.json`, `_weather_anchors.csv` and
  `_cell_weather_mapping.csv` companions.

Grid CSV header:

```text
grid_version,cell_id,grid_km,column,row,latitude,longitude,x_m,y_m,sample_method,square_min_x_m,square_min_y_m,square_max_x_m,square_max_y_m,square_center_x_m,square_center_y_m,full_square_area_m2,cell_area_km2,boundary_coverage_fraction,selection_coverage_fraction,land_coverage_fraction,weather_anchor_id,weather_anchor_distance_m,geometry_wgs84
```

`x_m,y_m` locate the sampling point in EPSG:3310. `latitude,longitude` locate
that same point in WGS84 decimal degrees. These are not always geometric centroids.
`cell_area_km2` is state-clipped area; a county-edge cell may extend into an adjacent
county. `geometry_wgs84` is a CSV-quoted JSON Polygon/MultiPolygon. The GeoJSON's
feature IDs match CSV `cell_id`, and its properties carry the same attributes.
No elevation column is populated because elevation has not been fetched for these
new points. The earlier Fresno city elevation is not valid for every grid cell.

Anchor header:

```text
weather_anchor_id,cell_id,latitude,longitude,x_m,y_m
```

Mapping header:

```text
grid_version,cell_id,weather_anchor_id,distance_km
```

Generated CSVs, GeoJSONs and archives are ignored by Git. Distribute the artifacts
and their metadata together rather than committing them. The source lock, scripts,
tests and documentation are source-controlled material.

## Weather anchors and pipeline compatibility

Anchors sit at the centers of a separate 10,000 m projected lattice, with origin
`(0,0)`. Anchor ID: `ca_w10km_3310_v1_c{column}_r{row}`. Assign each cell's sampling
point to the nearest anchor by Euclidean EPSG:3310 distance; ties use lowest
column, then lowest row. The largest possible distance is approximately 7,071 m.
Anchors are not clipped or moved at county/state borders, so assignments remain
stable statewide. Some coastal anchors may lie outside California. These are
weather sampling points, not prediction cells or a claim of 10 km model resolution.

Export only unique used anchors and query each `(anchor, source, parameters, year)`
once, reusing the existing cache. Nearby anchors may still resolve to the same
provider model grid point; deduplicating those needs provider response information.

The existing downloader accepts the grid CSV directly because it contains
`cell_id,latitude,longitude`. Use it for **cell elevation**. Use the anchor CSV for
**weather**, with `--weather-only`; its `cell_id` is an explicit alias of
`weather_anchor_id` for the earlier downloader. In weather outputs rename that
column to `weather_anchor_id` before joining through the mapping. Do not confuse
an anchor alias with a prediction-cell ID. The downloader's fewer-than-20-points
guard remains in force; this phase does not enable a bulk downloader.

## Integration with NASA and vegetation teams

For point detections, transform WGS84 longitude/latitude to EPSG:3310, then assign:

```python
column = math.floor(x_m / 3000)
row = math.floor(y_m / 3000)
cell_id = f"ca_3km_3310_v1_c{column}_r{row}"
```

Use half-open square ownership: west/south included, east/north excluded. This
avoids double-counting a point on a shared edge. Check the point against the state
polygon and ensure its ID is in the grid; ID membership alone does not exclude
an outside-California point in a partially clipped cell. The standard-library
`point_cell_id()` helper in `scripts/build_prediction_grid.py` accepts already
projected coordinates without loading GIS dependencies.

For vegetation polygons or fire perimeters, intersect them with the state-clipped
cells in EPSG:3310 and aggregate by area. For rasters, agree pixel overlap,
nodata and category weighting with the vegetation team; a sample point alone is
not a cell-wide vegetation summary. Join static features on `(grid_version,cell_id)`;
join weather via `(weather_anchor_id,date)` and the mapping. Keep NASA timestamp
conversion to America/Los_Angeles and seven-day label horizons explicit. Dates do
not belong in permanent geographic IDs. Elevation at one point is not terrain slope.

## Reproduce and test

The current local environment is `.venv-gis`, created with CPython 3.13 on Windows;
LinuxONE Python 3.12/s390x execution is not tested here. GIS is optional and the
collection scripts still use the standard library.

```powershell
# Local GIS tests: all geometry checks run in this environment.
.venv-gis/Scripts/python.exe -m unittest discover -s tests -v

# Rebuild from cached boundaries; no network.
.venv-gis/Scripts/python.exe scripts/build_prediction_grid.py --scope fresno
.venv-gis/Scripts/python.exe scripts/build_prediction_grid.py --scope california

# Standard-library regression suite; GIS-only tests skip when unavailable.
python -m unittest discover -s tests -v

# Existing pipeline compatibility checks; no requests or output writes.
python scripts/fetch_weather_elevation.py --cells data/processed/fresno_grid_pilot.csv --limit 1 --elevation-only --dry-run
python scripts/fetch_weather_elevation.py --cells data/processed/fresno_grid_pilot_weather_anchors.csv --limit 1 --weather-only --source historical-weather --dry-run
```

To set up another authorized workstation, create a venv using its normal CPython
and install `requirements-gis.txt` there. On Linux/macOS use `.venv-gis/bin/python`
instead of `.venv-gis/Scripts/python.exe`. Do not install these packages on
LinuxONE merely to read CSVs. Boundary download planning is offline by default:

```text
python scripts/download_ca_boundaries.py
python scripts/download_ca_boundaries.py --download
```

The second command makes two boundary downloads when uncached and needs network
authorization. Both commands are unrelated to Open-Meteo. Fresh archives must
match the locked checksums. The generator supports `--size-m 5000` without changing
the algorithm, but 3 km remains official. A 5 km Fresno pilot uses a different
output basename so it cannot overwrite the official pilot.

Each build verifies unique IDs, full square sizes, positive California overlap,
positive region overlap, total region coverage, valid polygon geometry, sample
point membership and geographic coordinates, transformation round trips within
1 cm, deterministic ID reconstruction, and CSV readability by the existing
pipeline. Offline tests cover negative indices, half-open edge ownership, 5 km
fallback, county/state consistency, holes, disconnected geometry, interior-point
fallback, nearest-anchor ties and invalid dimensions, plus the original weather
and elevation regression suite. These checks do not validate live API responses
for the new grid points.

Request estimates in the metadata are logical HTTP requests before retries,
assuming one weather request per anchor per year and 100 elevations per batch.
Provider quota accounting can weight large date/variable requests differently;
the counts are not API-credit estimates. Actual weather timing and storage need
a separately approved small benchmark before statewide extraction.
