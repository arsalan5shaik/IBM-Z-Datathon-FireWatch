# Proposed FireWatch JSON interchange

Location-search integration notice: `/locations/*` serves existing Census data
and `/places/*` remains an alias. All stable IDs are retained except two colliding
Spring Valley/Lake IDs, explicitly corrected in
`backend/LOCATIONS_INTEGRATION.md`. ML grid-cell mapping remains blocked; display
boundaries are not authoritative inference grids or precise area inputs.

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
- Optional `grid_artifact` and `boundary_artifact` reference immutable geometry
  relative to the shared data root, defaulting to `grid.geojson` and
  `california.geojson` for legacy manifests. `validated_cell_count` records the
  publisher's complete-grid validation. Readers validate source metadata as well;
  this count is not a substitute for validation. These additive fields require
  upgrading older strict readers before enabling the new publisher.
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
are loaded, with a bounded 4-hour LRU for legacy files. Backend publication creates
an immutable SQLite score index beside each JSON file before the manifest commit.
Indexed bbox/cell requests select only matching cell IDs; cell history returns
at most 168 records without parsing all 168 full-grid prediction arrays. Indexes
are derived backend caches, not ML inputs or a replacement interchange format.
Missing/damaged indexes fall back to validated JSON and are rebuilt by the next
scheduler run; GET never writes files or invokes inference.

Daily aggregation is max_hourly_risk (default) or mean_hourly_risk, an index,
never an aggregated probability. Report expected/coverage/missing hours and
partial_day; California DST days contain 23 or 25 hours. A rolling UTC window
may overlap eight local calendar dates: the UI chooses seven dates and displays
partial coverage; it must not infer seven complete days. Risk color thresholds
are display conventions: low <0.4 orange, elevated <0.7 red, high >=0.7 purple.
They are not empirical calibration claims. Default/Terrain and 2D/3D remain view
state and never invoke inference.

## Rolling-window handoff (feature 3 integration notice)

Backend scheduling is opt-in: `JOB_ENABLED=true`, `SCHEDULER_OWNER=backend`, and
an ML-owned `FORECAST_GENERATOR_CMD` JSON argv array. With ML-owned scheduling,
leave backend jobs disabled. No real inference entry point is supplied here.
`backend/README.md` defines the CLI request and publication/rollback procedure.
`examples/forecast-revision.example.json` is explicitly a fixture revision, not
weather data or a trained model. The scheduler requests complete grids for missing
hours. Any changed input/model/feature/grid/score/target revision invalidates the
entire affected window because ML has not supplied a finer dependency map.
The PR carrying this change is the ML/frontend integration notice; actual live
handoff agreement remains required before connecting real artifacts.

## Proposed future forecast weather (weather-inference feature)

`weather-sampling.proposed` maps explicit ML-provided anchors to every grid cell;
`weather-inputs.proposed` transports 168 complete hourly normalized partitions.
Both use schema_version=proposed-weather-1, and the input packet explicitly says
model_contract_status=unconfirmed. These are separate from prediction contracts.
They do not assert the trained model expects these fields, daily aggregation,
lag transformations or wind units. The existing ML branch documents historical
daily aggregates in m/s; this transport uses hourly km/h with explicit names.

Weather source/fetch time, grid mode/version, mapping, and partition revisions are
preserved. Hashes exclude fetch time and retain stable overlapping-hour revisions.
Backend does not overwrite prediction input_revision or manifests on weather fetch.
Missing coverage, stale forecasts or mapping mismatches prevent packet generation.
See backend/WEATHER_INTEGRATION.md and backend/README.md for ownership and blockers.
The feature PR is the cross-team proposal notice; real ML integration needs agreement.
