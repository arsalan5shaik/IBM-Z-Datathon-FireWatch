# FireWatch LightGBM ERC regression

This directory implements an independent LightGBM regressor for the historical
daily gridMET Energy Release Component, fuel model G (ERC-G). It estimates a
unitless environmental fire-danger index, not wildfire ignition probability.
Seven future daily scores require seven corresponding daily forecast-weather
inputs. Historical observed weather is never an operational forecast.

## Verified sources and spatial alignment

- The numeric California GeoJSON has 48,019 polygon IDs and is the elevation
  file's exact ID domain. The existing min/max elevation CSV has 75 missing
  pairs; those stay NaN. Legitimate zero and negative elevations stay intact.
- `data/input/firewatch_erc_2024_pilot_numeric_grid.csv` contains the seven-day
  2024 pilot. Every nonmissing pilot label was compared with the provider's
  native NetCDF value at its recorded source coordinates: 323,386 exact matches
  and zero mismatches. Values are ERC-G, unitless. The official gridMET product
  is daily, about 4 km, and ERC is based on fuel model G. [gridMET documentation](https://www.climatologylab.org/gridmet.html)
- `data/input/grid_id_mapping.csv` maps all 48,019 numeric IDs to
  `ca_3km_3310_v1_c{ix}_r{iy}`. Its EPSG:3310 lattice indices agree with all
  46,200 numeric IDs in the teammate's verified ERC crosswalk; 44 source
  crosswalk rows have no numeric ID and remain unmapped. The mapping manifest
  records the source hashes.
- Weather and ERC retain gridMET's native approximately 4 km pixels. Each 3 km
  cell uses the source coordinate recorded in the pilot where available; other
  cells use the geometry-derived EPSG:3310 lattice-square center. The nearest
  native pixel is sampled, retaining source resolution rather than inventing
  3 km observations.
- GridMET's daily date is midnight-to-midnight MST (07:00 UTC). Training target
  day D uses weather from D-1 to avoid target-day weather leakage. Temperature
  is converted from K to °C; minimum RH is %, precipitation is mm/day, and the
  daily mean wind speed is m/s. No historical vegetation series is available,
  so the model uses weather, min/max elevation, and calendar features only.

## Extract California training data (Windows PowerShell)

The NCSS probe downloaded a 122 KB one-day California subset. The full
2024-01-01 through 2025-12-31 run includes the one-day weather warm-up on
2023-12-31. The estimate from the measured pilot is about 0.5 GB of bounded
NetCDF downloads and about 25 to 35 minutes; outputs are streamed as gzip CSVs.
No nationwide NetCDF archive is downloaded.

```powershell
$Python = "C:\Users\there\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
& $Python ml/lightgbm/gridmet.py extract-training `
  --start 2024-01-01 --end 2025-12-31 `
  --output ml/lightgbm/data/gridmet_historical `
  --cache ml/lightgbm/data/gridmet/cache
```

The extraction writes `erc_daily.csv.gz`, `weather_daily.csv.gz`, and
`gridmet_training_inputs_manifest.json`. The manifest records request URLs,
bytes, hashes, units, dates, spatial assignment, row counts, and excluded
missing targets.

## Prepared tables and IBM LinuxONE training

The real historical ERC tables are prepared in `artifacts/prepared_2024_2025/` as `train.csv.gz`, `validation.csv.gz`, and `test.csv.gz`. The preparation streams one date at a time to stay within limited workstation memory. To rebuild from the existing historical inputs without downloading or extracting:

```powershell
$Python = "C:\Users\there\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
& $Python ml/lightgbm/pipeline.py prepare-streamed `
  --config ml/lightgbm/config.gridmet.json `
  --output ml/lightgbm/artifacts/prepared_2024_2025
```

Using WinSCP/SFTP, upload these minimum files to `/home/linux1/firewatch/`, keeping the same relative directory structure:

- `ml/lightgbm/pipeline.py`, `spatial.py`, `predict.py`, and `config.gridmet.json`
- `ml/lightgbm/data/input/grid_id_mapping.csv`
- `ml/lightgbm/artifacts/prepared_2024_2025/train.csv.gz`, `validation.csv.gz`, `test.csv.gz`, and `feature_schema.json`

The raw NetCDF, ERC/weather source tables, elevation file, and vegetation data are not needed for fitting. Python 3.12 and LightGBM 4.7.0 are already installed in `~/firewatch-ml-venv`; do not reinstall them. In PuTTY:

```bash
cd /home/linux1/firewatch
source ~/firewatch-ml-venv/bin/activate
python ml/lightgbm/pipeline.py train-partitioned \
  --config ml/lightgbm/config.gridmet.json \
  --prepared ml/lightgbm/artifacts/prepared_2024_2025 \
  --output ml/lightgbm/artifacts/model_2024_2025
```

The split trains on 2024, validates on January-June 2025, and holds July-December 2025 for final test. Evaluation reports MAE, RMSE, R2, training-only cell/global-mean baselines, fit time, and best iteration. The export includes `model.txt`, ordered `feature_schema.json`, `evaluation.json`, split predictions, feature importance, and the grid mapping. Model quality is unknown until the LinuxONE command runs.

For batch inference, provide a CSV or CSV.GZ with `cell_id`, `date`, and every feature in the schema. The script reads feature files in chunks and can export native LightGBM per-feature contributions plus bias. This example uses held-out historical test features to verify inference; it is retrospective, not an operational forecast:

```bash
python ml/lightgbm/predict.py \
  --model-dir ml/lightgbm/artifacts/model_2024_2025 \
  --features ml/lightgbm/artifacts/prepared_2024_2025/test.csv.gz \
  --start-date 2025-07-01 --end-date 2025-07-07 \
  --output ml/lightgbm/artifacts/model_2024_2025/predictions.csv \
  --contributions-output ml/lightgbm/artifacts/model_2024_2025/contributions.csv
```

The example is retrospective. Operational seven-day inference requires corresponding forecast-weather features for each target date and must not use historical observations as current forecast weather. Review the held-out evaluation before using the exported model.

After training, use WinSCP/SFTP to download `/home/linux1/firewatch/ml/lightgbm/artifacts/model_2024_2025/` to `ml/lightgbm/artifacts/model_2024_2025/` on Windows. For operational seven-day predictions, the feature file must contain corresponding forecast weather from D-1 for each target date; historical observed weather is not a current forecast.
