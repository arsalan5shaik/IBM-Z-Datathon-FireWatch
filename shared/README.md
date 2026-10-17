# Proposed FireWatch JSON interchange

These new contracts implement the primary backend architecture. No pre-existing
shared schemas were found or overwritten. ML owns authoritative grid geometry,
stable cell IDs, model/feature versions, score/target semantics, inference and SHAP.
Backend owns validation and transport. Frontend consumes the versioned OpenAPI.
The feature PR is the integration notice: ML must review this proposed handoff
before connecting real artifacts; no ML code or existing frozen document changes.

`schemas/` is exported from backend Pydantic models by
`python backend/scripts/export_schemas.py` in the installed backend environment.
`examples/` is explicitly mock fixture data, never an actual model forecast.
Fixture ingestion also requires `ALLOW_FIXTURE_DATA=true` (default false).

Contract additions to the architecture's illustrative JSON:

- Required `data_mode:fixture|live` on grid, manifest and hourly artifacts prevents
  fixture data from masquerading as real predictions. All three must agree.
- Manifest additionally requires `feature_version`; version consistency is checked
  for every artifact, not inferred from a filename.
- Optional manifest `artifacts` maps canonical UTC hours to relative JSON paths
  under predictions/. This supports immutable versioned files and manifest-last
  revision publication. Absolute/outside-directory references are rejected.
- Grid FeatureCollection `metadata` includes `grid_version`, `grid_resolution_m:3000`,
  `source_epsg:3310`, and `data_mode`. Features carry cell_id and grid_version.
  Geometry is EPSG:4326 `[longitude,latitude]`; generated 3,000 m cells must originate
  in EPSG:3310. Do not substitute longitude-degree squares as a production grid.
- Live grid validation requires `shared/data/california.geojson`, a GeoJSON Feature
  with authoritative CA Polygon/MultiPolygon geometry. The grid loader verifies
  California intersection; grid clipping/generation and provenance remain ML's job.
  The bounding-box-only fixture path is expressly not an authoritative CA boundary.

Runtime layout (not checked in): `data/grid.geojson`, `data/california.geojson`,
`data/predictions/manifest.json`, `data/predictions/YYYYMMDDTHH00Z.json` or immutable
manifest-referenced revision paths. Configure SHARED_DATA_DIR to relocate it.
Missing/invalid/mismatched data returns 503, not invented values. Artifacts may
contain fewer than all grid cells: missing cells are surfaced as null/missing,
never zero. Unknown cell IDs, duplicate keys/IDs, nonfinite or out-of-range scores,
naive/non-hour-aligned times, and version mismatches are rejected.

Manifest hours are sorted unique available slots inside a 168-hour UTC window;
end is exclusive. Risk requires exactly one UTC `hour` or California `date` plus
WGS84 `bbox=w,s,e,n`. Default response cap is 2,000 cells, exceeded requests return
422 without truncation. Geometry is stored once. Only selected hourly artifacts
are loaded, with a bounded 4-hour LRU; cell history returns at most 168 records.

Daily aggregation is max_hourly_risk (default) or mean_hourly_risk, an index,
never an aggregated probability. Report expected/coverage/missing hours and
partial_day; California DST days contain 23 or 25 hours. A rolling UTC window
may overlap eight local calendar dates: the UI chooses seven dates and displays
partial coverage; it must not infer seven complete days. Risk color thresholds
are display conventions: low <0.4 orange, elevated <0.7 red, high >=0.7 purple.
They are not empirical calibration claims. Default/Terrain and 2D/3D remain view
state and never invoke inference.
