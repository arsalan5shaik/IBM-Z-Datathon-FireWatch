# 3 km vs 5 km — decision before API download

**Phase 2 decision:** 3 km is the official prediction resolution. The implemented
EPSG:3310 grid and pilot are described in [GRID_PILOT.md](GRID_PILOT.md). The earlier
5 km recommendation and approximate counts below are background estimates, not
the current decision. The official source includes administrative water area;
actual statewide retained-cell counts are recorded in generated metadata.

Using 2020 Census California land area ~403,671 km² (155,858.33 mi²):

| Grid | Cell area | Lower-bound approximate land cells | Rows x 731 days |
|---|---:|---:|---:|
| 3 km | 9 km² | 44,852 | 32.79M |
| 5 km | 25 km² | 16,147 | 11.80M |
| 10 km | 100 km² | 4,037 | 2.95M |
| 20 km | 400 km² | 1,009 | 0.738M |

Boundary-clipped grids with partial cells will generally contain more cells than area/size². These are *not* benchmark timings; actual runtimes depend on GIS, network and model.

**Recommendation for 24 hours:** build an end-to-end *5 km working baseline* and keep an experimental 3 km grid generator. Test 3 km vs 5 km on 1-2 counties FIRST; select whichever produces acceptable latency and validation performance. Switch to 10 km for full statewide pipeline if requests become excessive. Use one shared grid origin and IDs to avoid teammates' spatial misalignment.

Important: 3 km is not necessarily meaningful weather resolution. Open-Meteo's 2024–2025 weather source often resolves at 9 km (or coarser). Consider using ~10 km weather anchors and assigning that weather to multiple risk-grid cells; elevation and vegetation can remain at 3/5 km. Do not independently query the same weather model sample for every fine-grid cell.

## Benchmark before scale

- Generate real California-clipped 3 km and 5 km cell counts and measure CSV / GeoJSON size.
- Download 10 weather anchors x two years; measure response time, size, and API errors. Extrapolate cautiously; do not exceed public service limits.
- Check fraction of cells sharing identical/near-identical weather values.
- Train / predict on a small subset with realistic labels, compare actual CPU time, peak RAM, data joins, and predictive quality.
- Keep full California 3 km grid as an **optional** stretch goal, not a dependency for the MVP.
- For frontend display, serve viewport-filtered risk geometries or simplified GeoJSON (not tens of thousands of complex polygons to the browser on each refresh).

## CRS requirement

Use a projected coordinate system such as California Albers `EPSG:3310` (meters) for the square grid, and WGS84 latitude/longitude for API sample coordinates. Creating squares by stepping 0.03 degrees is not a reliable 3 km grid.

Source: https://www.census.gov/quickfacts/fact/table/CA/POP060220


## Proposed reproducible generation procedure (next phase)

1. Obtain an authoritative California polygon, such as the Census state boundary
   filtered to California (state FIPS 06). Agree land/water and island treatment;
   record source URL, release, checksum and geometry policy. No boundary is bundled.
2. On an optional GIS workstation, transform that boundary to EPSG:3310 (meters).
   Agree and freeze a projected origin `(x0, y0)` shared by both grids.
3. For size `s = 3000` or `5000`, enumerate integer row/column squares with
   corners `(x0 + column*s, y0 + row*s)`. Retain positive-area intersections
   with the boundary, including partial coastal and border cells.
4. Derive IDs from grid version, size, integer row and column; never from rounded
   latitude/longitude. Compute clipped area in EPSG:3310 and export square and
   clipped geometry if needed. Record origin, CRS, size, ID algorithm and boundary
   version in a metadata JSON file.
5. Transform each clipped cell centroid to WGS84 for sampling. A concave or
   multipart clipped cell can have an outside centroid: agree whether to use an
   interior representative point instead, record that policy and distinguish that
   sample point from the geometric centroid in the final contract.
6. Export plain CSV for LinuxONE. Generate approximately 10 km weather anchors
   separately and export a deterministic mapping from each fine cell to an anchor,
   with distance and tie-breaking policy. Fetch elevation at each risk-cell sample.

GIS dependencies would be optional workstation tools and require approval before
installation. Neither the grid nor API downloads are implemented in Phase 1.
Validate boundary membership, unique IDs, areas, coordinate transforms and stable
regeneration on a small region before statewide generation. A degree-stepped grid
or bounding-box filter cannot provide these guarantees.
