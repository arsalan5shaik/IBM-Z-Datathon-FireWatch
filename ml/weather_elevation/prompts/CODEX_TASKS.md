# Copy/paste these prompts in order (one Codex task at a time)

These are archived kickoff prompts, not current setup instructions. Phases 1–3
now have working implementations; use README.md and docs/GRID_PILOT.md before
starting new work. The implemented generator is scripts/build_prediction_grid.py,
the boundary source is pinned in docs/BOUNDARY_SOURCES.json, and 3 km is official.
The integration phase remains future work.

## Phase 1 — Inspect, test, harden downloader (do FIRST)

You are working on FireWatch's California-only weather/elevation pipeline for a 24-hour IBM LinuxONE s390x datathon. Read AGENTS.md, README.md and docs/*.md first. Inspect scripts/fetch_weather_elevation.py. Run existing OFFLINE tests and fix real issues. Keep Python 3.12 standard-library compatibility. Verify proper date range (2024 + 2025), units, null validation, retry/backoff, CSV schema, caching, and rate limiting. Add a --dry-run mode and safe protection from >20 point WEATHER downloads without explicit acknowledgement. Do not install packages, modify the remote LinuxONE environment, or call a live external API unless I approve. Show exact commands for one-location live test, then ask before running it. Make only Phase 1 changes and report test output.

## Phase 2 — 3 km and 5 km California grid generator

Build scripts/generate_california_grid.py from a California STATE BOUNDARY GeoJSON file I will provide. Do not download a substitute boundary or invent geometry. The CLI must support --grid-km 3 and --grid-km 5, with EPSG:3310 projected kilometer squares (meters internally), actual intersection with California, a documented consistent grid origin, stable IDs with grid_version, centroid WGS84 latitude/longitude, optional clipped polygon geometry, and reproducible outputs. Use shapely/pyproj only in this optional *workstation-only* generator if needed, never require compiled GIS libraries for the LinuxONE downloader. Add synthetic-geometry offline tests and report number of cells and storage size. First generate for a sample county (I will provide boundary); do not run statewide jobs without confirmation.

## Phase 3 — De-duplicate weather queries

Implement weather anchor locations at approximately 10 km resolution or weather-model-native locations and map each risk cell to an anchor. Do not make 2024–2025 API calls for every 3 km/5 km risk cell. Design weather_anchors.csv and cell_weather_mapping.csv per docs/DATA_CONTRACT.md. Demonstrate using 5–10 sample cells and a mocked weather API, and only use live API when I approve. Preserve source model, coordinates, timestamps, timezone and units. Add tests for mapping determinism and no cell left unmatched. Report expected request counts and uncertainty in actual weather resolution.

## Phase 4 — Integration and benchmark

With teammate-provided fire labels and vegetation CSVs, implement a streaming merge of cell grid + static elevation + vegetation + trailing historical weather features + next-7-day fire label. Output a small CSV/Parquet ONLY if compatible on LinuxONE, otherwise CSV. No database. Include strict leakage tests, chronological train/validation/test convention, missing-value reports, and a 3 km vs 5 km comparison on the same small California pilot area: actual CPU time, RAM if measurable, row counts, disk bytes, weather API sample request counts, and coverage. Do not claim a full statewide benchmark unless actually measured. The resulting files must be easy for our XGBoost training script to consume.

## Optional: Accurate historic seven-day weather forecasts

Explore archived Open-Meteo Single Runs or Previous Runs rather than stitched Historical Forecast timeseries. Write a short feasibility note for 2024–2025 ECMWF availability, model run issuance and lead-time cutoff, field list, and expected number of requests. Do not download a full year. Explicitly distinguish historical observed/assimilated weather from information available at prediction time. If historical weather forecasts can't be gathered inside the hackathon budget, fall back to only trailing weather features.
