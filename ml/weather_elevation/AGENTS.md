# FireWatch — Codex repository instructions

## Project / team constraints
- This is a 24-hour IBM datathon project, California only.
- The deliverable in this repository is a simple, reproducible 2024–2025 weather-and-elevation data pipeline, to integrate with NASA fire labels and vegetation features supplied by teammates.
- LinuxONE is the target runtime: Ubuntu Linux on s390x, Python 3.12.3 observed. Do not assume x86_64 wheels, sudo access, Docker, conda, pip, or a database.
- Prefer Python standard library for data collection. If GIS libraries are needed for ONE-TIME grid generation, keep that script optional and usable on a developer's workstation; export plain CSV for LinuxONE. Ask before adding native dependencies.
- Avoid databases, microservices, schedulers, or complex cloud products. Plain CSV, JSON, and GeoJSON files are preferred.

## Spatial plan
- The official prediction grid is 3 km x 3 km; retain 5 km x 5 km as a configurable fallback without modifying business logic. See docs/GRID_PILOT.md for the implemented origin and ID convention.
- Grids must be defined in a projected coordinate system with meter units (e.g. EPSG:3310), then convert cell centroid to WGS84 latitude/longitude for API calls.
- Clip/intersect against an authoritative California boundary; a California bounding box alone is NOT adequate.
- Keep stable `cell_id` distinct from a human-readable latitude/longitude. Record grid size and CRS in metadata.
- Coordinate with teammates on grid origin, dates, and IDs before creating final training data.
- Weather is coarser than a 3 km grid. Support weather-anchor lookup at roughly 10 km (or model-native resolution), then join to 3/5 km risk cells. Do not claim the coarser weather is truly 3 km resolution.
- Elevation is a static numeric feature in meters; latitude/longitude are independent numeric features. One elevation at a centroid is not terrain slope.

## Dataset rules
- Primary historical timeframe: 2024-01-01 through 2025-12-31 inclusive (731 days).
- Future target: next-seven-day fire occurrence/activity label comes from teammates' fire-source contract, NEVER future information in a current-date feature.
- Separate historical reconstructed weather / stitched early-model forecasts from genuine seven-day weather forecasts issued on a historical prediction date.
- For validation, use chronological splits and do not let a target's +7-day horizon cross a split boundary.
- Preserve provenance, units, timezone (America/Los_Angeles), missing values, dataset source, API params, and extraction time.
- Do not invent missing API responses, DEM values, validation metrics, or wildfires.
- API data may be missing or null; handle explicitly. Wind direction is circular; encode sin/cos for models.

## Safety and execution
- IMPORTANT: Do not download a statewide 3/5 km grid worth of API data, install packages on LinuxONE, or connect to the hackathon server without explicit permission and an estimate of requests, time, storage, and the provider's usage terms.
- Default to dry runs, cached responses, one-cell/five-cell examples, bounded sample (<20 points), and synthetic fixtures for tests.
- Respect HTTP 429 and Retry-After, bounded retries/backoff, timeouts, and safe caching. Avoid unbounded concurrency.
- No API secrets in Git or logs. Do not commit downloaded archives or generated CSVs.
- Do not silently substitute 2026 perimeters for 2024/2025 training labels.

## Definition of done for each task
- Explain the proposed files and approach briefly, implement only the requested phase, run offline tests, and report exactly what was tested and what needs live verification.
- Keep scripts runnable with `python3` on LinuxONE, unless a script is explicitly marked as workstation-only.
- Document CLI usage and expected headers. Minimize changes to files owned by teammates.
