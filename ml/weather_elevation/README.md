# FireWatch California data pipeline

Reproducible geographic, historical weather and elevation preparation for IBM's
LinuxONE Datathon. Historical coverage is **2024-01-01 through 2025-12-31**
(731 days). NASA wildfire labels and vegetation features are supplied by teammates.

| Geographic foundation | Validated count/specification |
|---|---|
| California prediction cells | **48,019** |
| Prediction resolution | **3 km x 3 km** |
| Weather sampling anchors | **4,472**, on a separate 10 km lattice |
| Fresno subset | 1,906 cells; 205 anchors |
| Projected CRS and fixed origin | EPSG:3310, meters; `(0, 0)` |
| Grid version | `ca_3km_3310_v1` |

The counts apply to the boundary checksums and grid policy recorded in
[docs/BOUNDARY_SOURCES.json](docs/BOUNDARY_SOURCES.json) and
[docs/GRID_PILOT.md](docs/GRID_PILOT.md). Geographic sampling at 3 km does not
increase the underlying weather model's resolution.

## Runtime and setup

Run commands from the directory containing this README (for example,
`data-pipeline/` inside the team repository). On LinuxONE use **Python 3.12** and
`python3`; on Windows use `python`. Collection, validation, caching and CSV output
use the **Python standard library only**. No pip, database, Docker, conda, sudo or
GIS libraries are required on LinuxONE for these tasks.

```bash
python3 --version
python3 -m unittest discover -s tests -v
python3 scripts/fetch_weather_elevation.py --limit 1 --source historical-weather --dry-run
```

The offline suite uses synthetic responses; it does not contact providers.
Seven geometry tests skip when optional workstation GIS packages are unavailable.

The team has verified the Fresno CSV pilot on LinuxONE s390x: 366 records in
2024, 365 in 2025, no missing values or duplicate dates, and elevation 91 m.
Pandas processing and XGBoost 2.0.3 training, inference and native SHAP explanations
were also team-verified there. ML training code and its package environment are
owned separately; this repository does not install them. The newer batch runner
has been tested locally and still needs its own LinuxONE execution check.

## Reproduce the geographic datasets on a workstation

Generate geography locally, then transfer the plain CSV files to LinuxONE.
The optional GIS environment was validated with CPython **3.13**; some pinned
packages in `requirements-gis.txt` require Python 3.12 or newer. Do not install
these GIS packages on LinuxONE merely to read the exported CSVs.

Linux/macOS workstation setup (package installation requires authorization):

```bash
python3 -m venv .venv-gis
.venv-gis/bin/python -m pip install -r requirements-gis.txt
.venv-gis/bin/python -m unittest discover -s tests -v
```

Windows PowerShell workstation setup:

```powershell
python -m venv .venv-gis
.venv-gis/Scripts/python.exe -m pip install -r requirements-gis.txt
.venv-gis/Scripts/python.exe -m unittest discover -s tests -v
```

First inspect the boundary download plan without network access:

```bash
python3 scripts/download_ca_boundaries.py
```

After authorizing the two official boundary downloads (about 2.7 MB total):

```bash
python3 scripts/download_ca_boundaries.py --download
```

The source is the official [California Geographic Boundaries dataset](https://data.ca.gov/dataset/ca-geographic-boundaries).
The downloader verifies pinned archive checksums and saves the archives plus a
retrieval manifest in `data/raw/ca_boundaries/`. Changed upstream files cause a
visible failure; review source/version changes rather than bypassing that check.

Build Fresno first, then statewide geometry, using cached boundaries only:

```bash
.venv-gis/bin/python scripts/build_prediction_grid.py --scope fresno
.venv-gis/bin/python scripts/build_prediction_grid.py --scope california
```

On Windows substitute `.venv-gis/Scripts/python.exe` for `.venv-gis/bin/python`.
These generation commands have no network calls. The 5 km fallback is available
with `--size-m 5000`; the official prediction grid remains 3 km.

Outputs in `data/processed/`:

```text
california_grid_3km.csv
california_grid_3km.geojson
california_grid_3km.metadata.json
california_grid_3km_weather_anchors.csv
california_grid_3km_cell_weather_mapping.csv
fresno_grid_pilot.csv
fresno_grid_pilot.geojson
fresno_grid_pilot.metadata.json
fresno_grid_pilot_weather_anchors.csv
fresno_grid_pilot_cell_weather_mapping.csv
```

Full squares are exactly 3,000 x 3,000 projected meters. Retained geometries are
intersected with the state polygon; Fresno selects a subset without redefining
the statewide cells. IDs use signed lattice indices, for example
`ca_3km_3310_v1_c-10_r-20`. WGS84 sampling coordinates and geographic geometry
are exported alongside projected bounds and coverage fractions. Administrative
boundary coverage includes water; exact `land_coverage_fraction` remains missing
until a spatial land/water mask is supplied.

## Weather and elevation extraction

The legacy one-location sample uses `data/sample_california_cells.csv`, a small
hand-authored city-coordinate fixture, not generated grid data. After authorizing
three logical uncached requests, run:

```bash
python3 scripts/fetch_weather_elevation.py --limit 1 --source historical-weather --out output/one_location
```

For the resumable 10-anchor/20-cell pilot, first generate or obtain the statewide
CSV inputs above. Both commands below are **offline plans**, not downloads:

```bash
python3 scripts/extract_statewide_features.py
python3 scripts/extract_statewide_features.py --scope statewide
```

After authorizing the small pilot, run or resume it with:

```bash
python3 scripts/extract_statewide_features.py --live
```

This selects ten anchors and two mapped cells per anchor from existing geography.
Successful batches are validated and cached; rerunning does not repeat them.
Run one extraction writer at a time. Preserve `output/open_meteo_usage.json` and
the batch caches across restarts; they track local usage and completed requests.

Results are saved under `output/extraction_pilot/`: `weather_2024.csv`,
`weather_2025.csv`, `elevation.csv`, `selected_weather_anchors.csv`,
`cell_weather_mapping.csv`, configuration, checkpoints, reports and caches.
The completed pilot produced 7,310 weather rows and 20 elevations with no missing
values or duplicate keys. Its cache-only repeat made zero HTTP requests.

Statewide extraction has **not** been run. The plan estimates 896 batched weather
HTTP requests and 481 elevation requests before retries. HTTP request count is
not quota usage: long historical requests are weighted, so the free service is
not suitable for this entire extraction in a single datathon day. Full live mode
is separately gated. See [docs/EXTRACTION_PIPELINE.md](docs/EXTRACTION_PIPELINE.md)
for dated usage limits, measured pilot sizes/timings, estimates and approval rules.

Other utilities are `scripts/estimate_grid.py` (offline area-based estimates,
not the measured cell counts) and `scripts/inspect_archived_7day_forecast.py`
(dry-run by default; live exploration requires separate approval).

## Shared data contract and ML joins

See [docs/DATA_CONTRACT.md](docs/DATA_CONTRACT.md) and
[docs/GRID_PILOT.md](docs/GRID_PILOT.md) for exact headers and spatial joins.

- Static features join on `(grid_version, cell_id)`.
- Weather joins on `(weather_anchor_id, date)` through the cell-to-anchor mapping.
  Many 3 km cells share one weather anchor; permanent IDs do not contain dates.
- The batch runner uses `weather_anchor_id` directly. The legacy downloader's
  anchor `cell_id` alias must be renamed explicitly before an anchor-based join.
- Weather units are Celsius, humidity percent, precipitation mm/day, wind m/s and
  wind direction degrees; elevation is meters. Nulls stay missing, never zero.
- Preserve provider provenance and America/Los_Angeles date interpretation;
  reconcile NASA UTC timestamps and the documented provider DST limitation.
- Reconstructed historical weather is distinct from an archived forecast issued
  on a prediction date. Do not use realized weather after a prediction cutoff
  for its future seven-day fire target. Use chronological, horizon-safe splits.

## GitHub contents

Commit source code, tests, documentation, the optional GIS requirements and the
five-row sample fixture. Generated grids, downloaded responses, archives, usage
ledgers, virtual environments, models and local secrets stay out of Git.
`.gitignore` excludes these artifacts, including CSV/GeoJSON output in custom
locations, while allowing `data/sample_california_cells.csv`.

All paths in source are resolved from the project or supplied with CLI options;
no workstation home directory is required. Generated files remain on local disk
after closing VS Code, but Git does not back them up. Reproduce them from scripts
or share them separately with their metadata and source checksums.

See [docs/GITHUB_HANDOFF.md](docs/GITHUB_HANDOFF.md) for the exact source manifest,
review checks and feature-branch commands. No project software license is
asserted here; use the team's repository policy. Provider data attribution and
usage terms still apply, independently of source-code licensing.
