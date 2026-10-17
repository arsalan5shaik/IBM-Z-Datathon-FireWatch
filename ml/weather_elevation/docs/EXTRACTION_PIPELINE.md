# Resumable weather and elevation extraction

This phase reuses the existing statewide grid, anchor list and mapping. It does
not regenerate geography. `scripts/extract_statewide_features.py` uses only the
Python standard library, with no installation or database. Default execution is
an offline plan. Only the 10-anchor/20-point live pilot is approved in this phase.

## Why a separate runner

The original `fetch_weather_elevation.py` remains the proven one/five-location
tool. Its weather loop is one location/year at a time, its weather output uses
`cell_id`, its CLI blocks 20 or more points, and it has no persisted quota ledger
or extraction report. Reusing it unchanged for all 4,472 anchors would create
8,944 weather HTTP requests and obscure the difference between cells and anchors.

The new runner reuses its variables, units, validation and Retry-After parsing,
while adding comma-separated coordinate batches, explicit `weather_anchor_id`,
atomic batch caches, resume checkpoints, usage pacing and reports. It keeps
`historical-weather-reconstructed` separate from archived forecast runs.

## Inputs and pilot selection

Read-only input files in `data/processed/`:

```text
california_grid_3km.csv
california_grid_3km_weather_anchors.csv
california_grid_3km_cell_weather_mapping.csv
```

Before requests, the runner validates unique IDs, numeric/range-checked input
coordinates and the complete mapping against the grid and anchor table. It
records SHA-256 input hashes in `run_config.json` and rejects a changed source or
selection in the same output directory. The original mapping is never modified.

The pilot chooses ten evenly spaced entries, in existing file order, among
anchors having at least two mapped cells, then selects two cells per anchor.
That gives statewide geographic coverage without pretending to be a statistical
sample. Output `cell_weather_mapping.csv` preserves those twenty original mapping
rows. The source mapping continues to cover all 48,019 prediction cells.

## Request design and source meaning

The [Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api)
accepts comma-separated coordinates and returns multiple location objects.
This runner requests ten anchors per batch, separately for calendar years 2024
and 2025, with seven existing daily variables, Celsius, mm, m/s and
America/Los_Angeles. `models=best_match` and `cell_selection=land` are explicit.
The exact model blend is provider-selected; retain cached response metadata and
do not present best_match as a fixed single-model dataset or station observations.

Weather variables are daily maximum/minimum temperature, minimum relative
humidity, precipitation sum, maximum wind speed/gusts, and dominant wind direction.
Returned model coordinates may differ from requested anchor coordinates. Both
are retained. Provider location order and any supplied location IDs are checked;
model points over 100 km from their requested anchor fail validation.

The [Elevation API](https://open-meteo.com/en/docs/elevation-api) supports up to
100 points per request, returning an elevation array based on Copernicus GLO-90.
The pilot sends twenty prediction-cell points in one request, preserving each
`grid_version,cell_id` and its sampling coordinates. These are numeric meters;
they are not weather-model elevations or terrain slope.

Reconstructed historical daily weather is not a forecast available on a historical
prediction date. No Single Runs or Historical Forecast requests are made here.
For a t+7 label, realized weather after cutoff t must not enter the features.
The provider supplies the daily aggregation; this runner checks its timezone
metadata but does not rebuild days from hourly timestamps. The current archive
documentation describes fixed offsets across a response, so exact DST-aware
day-boundary alignment with NASA timestamps needs separate review before training.

## Resume, validation and missing data

Successful batches are validated and atomically saved under `cache/`, keyed by
endpoint, every request parameter and the ordered permanent IDs. On a restart,
validated caches are reused and only missing batches are requested. The cache is
the authoritative resume state; `checkpoint.json` is a readable progress summary.
CSV aggregation restarts from cached data and uses temporary files followed by
atomic replacement, preventing partial final CSVs and duplicate appends.

Validation requires the exact complete, ordered 2024/2025 date sequence for every
unique anchor, every required variable, matching lengths and units, finite numeric
values or explicit nulls, humidity/direction ranges and nonnegative rain/wind.
Elevation values must be finite numeric values or nulls; negative heights are
valid. Nulls remain empty CSV fields and are counted in the quality report.
Do not interpret a structurally complete file as zero missing values: inspect
`run_report.json`. Missing values are not imputed or fabricated.

Invalid API payloads never enter the success cache. Corrupt cached data stops the
run visibly; review it before removing a cache file, since removal may cause a
new request. A crash between response arrival and atomic cache replacement can
require that uncommitted batch to be fetched again. No distributed scheduler or
cross-process locking is provided: run **one writer per output directory and
usage ledger**, without simultaneous extraction processes.

## Rate limits, retries and cost planning

Checked on 2026-10-17: [Open-Meteo pricing](https://open-meteo.com/en/pricing) lists
free limits of 600/minute, 5,000/hour, 10,000/day and 300,000/month. Its call
accounting increases with locations, duration beyond fourteen days and more than
ten variables. Batching saves HTTP overhead, not quota. This plan estimates
weather call units as `locations * days / 14` for seven variables and one model
selection. These are estimates, not measured provider billing. Elevation budgeting
conservatively reserves one unit per point; verify actual elevation accounting
before bulk execution.

The shared `output/open_meteo_usage.json` ledger reserves estimated units before
every attempt, including retries, and persists across restarts. Conservative caps
are 500/minute, 4,000/hour, 8,000/day and 240,000/rolling thirty days. Minute caps
pause briefly; larger caps stop the process for a later resume. The ledger covers
this runner only: other users on the same public IP and the old pilot downloader
also consume provider quota. Do not clear it to bypass limits.

Requests are serial, use a 90-second timeout and one-second success pause, and
retry temporary network failures and HTTP 429/500/502/503/504 at most three times
after the first attempt. Retry-After seconds or HTTP dates take precedence over
2/4/8-second backoff; waits exceeding five minutes stop for later resume.

| Scope | Weather HTTP requests | Elevation HTTP requests | Weather rows | Weather call units | Conservative elevation units |
|---|---:|---:|---:|---:|---:|
| Approved pilot | 2 | 1 | 7,310 | 522.14 | 20 |
| Statewide plan only | 896 | 481 | 3,269,032 | 233,502.29 | 48,019 |

At published daily limits, weather alone needs at least 24 daily quota windows;
combined conservative weather/elevation budgeting needs at least 29. The runner's
8,000/day safety cap increases the combined minimum to 36 windows, and retries,
monthly caps, shared-IP usage and provider restrictions can extend it. This is not
a one-day free-tier workload, even though it uses only 1,377 HTTP requests.

The [terms](https://open-meteo.com/en/terms) restrict free service to non-commercial
use and require attribution. If the datathon use qualifies, monetary API cost is
zero when paced within limits. Commercial or faster collection needs an approved
paid arrangement; the pricing page specifies Professional or higher for historical
weather. An exact subscription price was not verified, and no subscription or
paid endpoint was configured. This runner currently targets public endpoints only.

## Outputs and commands

### Measured pilot results (2026-10-17)

The authorized live pilot returned 3,660 weather rows for 2024, 3,650 for 2025,
and twenty elevation rows. Every variable and elevation was present; independent
CSV checks found no missing values or duplicate anchor/date or cell keys.
Requested coordinates, IDs, provider units/dates, cached values and the original
grid/mapping input hashes were verified. Multi-coordinate weather requests worked
for the selected variables in both years.

| Measurement | Observed |
|---|---:|
| Successful HTTP requests | 3 (two weather, one elevation) |
| Retries during the network-enabled run | 0 |
| Total runtime | 93.30 seconds |
| Local quota pacing within runtime | 82.69 seconds |
| Response bodies downloaded, compressed | 81,398 bytes |
| Weather CSV bytes, both years | 1,488,663 |
| Elevation CSV bytes | 2,413 |
| Cached JSON bytes | 1,038,066 |
| Estimated reserved units in live run | 542.14 |
| Cache-only repeat | 1.72 seconds, 3 cache hits, zero HTTP attempts |

An initial sandboxed network attempt was stopped after a network failure; its
conservative pre-request reservation was retained in the shared ledger. It
contributed to the initial wait during the later network-enabled run. The 93.30
seconds measures the successful invocation, not setup or the earlier failure.
No extra locations were requested. The initial successful report is preserved in
`pilot_benchmark.json` and `run_history/initial_live_pilot.json`; `run_report.json`
now describes the cache-only verification. Independent checks are recorded in
`artifact_validation.json`.

`statewide_projection.json` extrapolates this small pilot: approximately 666 MB
of weather CSV, 5.8 MB of elevation CSV, 468 MB of JSON caches, and about 36 MB of
compressed response bodies. Allow roughly 1.2 GB for features and caches, plus
temporary CSV replacement space and the existing geography files; 2 GB of free
space is a prudent planning allowance. Repeated row metadata makes CSVs larger
than compressed network responses. Actual values, string lengths and compression
will vary by terrain and provider response.

Removing quota waits and scaling the pilot by anchor count gives about 79 minutes
of active network/processing time, **not** a completion-time promise: this is a
local small-sample extrapolation that also approximates elevation batching.
The free-tier wall-clock schedule is governed by the many daily quota windows
above, not that active-time estimate. The new runner has not been benchmarked on
LinuxONE; it uses Python syntax and standard-library features compatible with
Python 3.12. No additional packages were installed in this phase.

Offline tests cover interrupted resume, zero-request cache reuse, null preservation,
invalid payload rejection, location order/count/coordinates, dates and units,
persisted quota budgets, bounded retries and the statewide approval guard. The
existing weather/elevation and optional grid tests remain part of the suite.
Final results: all 28 tests passed in the existing GIS environment. The ordinary
standard-library interpreter passed 21 tests and skipped seven optional GIS
checks, with zero failures. No LinuxONE connection was made.

Default output: `output/extraction_pilot/`:

```text
weather_2024.csv
weather_2025.csv
elevation.csv
selected_weather_anchors.csv
cell_weather_mapping.csv
run_config.json
checkpoint.json
run_report.json
run_history/*.json
cache/*.json
pilot_benchmark.json
statewide_projection.json
artifact_validation.json
```

Weather header:

```text
weather_anchor_id,latitude,longitude,date,model_latitude,model_longitude,weather_source,model_selection,extracted_at_utc,temperature_2m_max,temperature_2m_min,relative_humidity_2m_min,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant
```

Elevation header:

```text
grid_version,cell_id,latitude,longitude,elevation_m,extracted_at_utc
```

From the repository root, with `python3` on LinuxONE or `python` on Windows:

```bash
# Offline pilot plan; no files or network.
python3 scripts/extract_statewide_features.py

# Approved small pilot; rerunning resumes from successful batches.
python3 scripts/extract_statewide_features.py --live

# Statewide estimate only; no network.
python3 scripts/extract_statewide_features.py --scope statewide

# Offline tests; optional GIS tests skip without workstation packages.
python3 -m unittest discover -s tests -v
```

Statewide live mode additionally requires `--approve-statewide`, which must only
be supplied after user approval of the full estimate and provider usage plan.
It was not invoked in this phase. Do not run the current full extraction as a
single uninterrupted 24-hour free-tier job.

`run_report.json` records runtime, successful-response body bytes (after HTTP
transfer decoding, before optional gzip decompression), output/cache sizes,
null counts, cache hits, retries and estimated reserved units for that invocation.
Each invocation report is retained in `run_history/`, including interrupted runs.
Cache-only verification has zero HTTP attempts. These standard-library CSV files
require no GIS or pandas to read; local verification is not an assertion that the
new runner itself was executed on LinuxONE. Outputs are saved locally and ignored
by Git; preserve the caches, metadata and reports alongside the CSVs.
