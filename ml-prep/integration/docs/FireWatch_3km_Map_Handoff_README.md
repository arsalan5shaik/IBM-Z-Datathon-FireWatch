# FireWatch 3 km × 3 km statewide map — V6 handoff

## What this fixes

The existing V6 training/evaluation used 600 sampled California cells; the canonical provisional EPSG:3310 lookup contains 46,244 cells. A statewide map needs **features and predictions for every eligible cell for each date**. `firewatch_statewide_3km_inference.py` performs that inference with the frozen native XGBoost model. It does **not** train or change model artifacts.

The input weather is historical observed gridMET (native resolution approximately 4 km). Therefore the first artifact is a **historical ERC-G map for a chosen day**, NOT a present-day forecast or a validated seven-day wildfire-warning map. The 3 km spacing describes display cells, not measurement precision.

## Transfer

Mac:

```bash
scp -i ~/Downloads/whoosh_key.pem ~/Downloads/firewatch_statewide_3km_inference.py linux1@148.100.78.101:/home/linux1/firewatch/scripts/
```

LinuxONE:

```bash
cd ~/firewatch
source .venv311/bin/activate
python -m py_compile scripts/firewatch_statewide_3km_inference.py
ls -lh data/raw/california_3km_grid_lookup.csv data/raw/california_3km_elevation_mean_FILLED.csv models/releases/firewatch_erc_v6_2023_2025/model.json
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 python scripts/firewatch_statewide_3km_inference.py --date 2025-07-09 --threads 2 --geojson
```

Run once with `--date 2025-07-09` because the annual 2025 and 2024 NetCDF archives are already downloaded. The script requires day-30 through day of observed weather. For Jan 2025 it reads Dec 2024, and aborts if a needed archive is missing. It reads only California's bounding window from each daily raster, not whole-year matrices.

Outputs (under `data/map_3km`):

- `firewatch_erc_3km_2025-07-09.csv`: a row for **every canonical grid cell** with `cell_id`, EPSG:3310 3,000 m bounds, WGS84 center latitude/longitude, raw and nonnegative-display ERC-G estimates, missing-data status, and land fraction.
- `firewatch_erc_3km_2025-07-09_points.geojson`: GeoJSON WGS84 point markers for **eligible** cells, when `--geojson` is enabled.
- `firewatch_erc_3km_2025-07-09_report.json`: coverage audit, missing cells, model path, and explicit limitations.

Verify the printed total is **46,244** and investigate missing cells. Some missing elevations or near-ocean cells may be invalid; the script never silently invents missing predictors. All geometry remains provisional until the team validates the state's true coastline/boundaries.

Mac: fetch only the results when the output is verified:

```bash
mkdir -p ~/Downloads/FireWatch_3km_Map
scp -i ~/Downloads/whoosh_key.pem 'linux1@148.100.78.101:/home/linux1/firewatch/data/map_3km/firewatch_erc_3km_2025-07-09*' ~/Downloads/FireWatch_3km_Map/
```

## Backend/frontend contract recommendations

- Frontend joins by **stable `cell_id`** and uses `center_lon`, `center_lat` for WGS84 points. For polygon/cell overlays, convert EPSG:3310 3,000 m square corners to WGS84 **server-side**; center points alone are not square boundaries in lat/lon.
- Values are **ERC-G index points**, not wildfire ignition percentages. `erc_g_raw` is scientific output and `erc_g_display = max(raw,0)` is nonnegative display value; record this distinction.
- **Do not color dots red based on uncalibrated universal ERC cutoffs**. Before coloring red/yellow/green, the team needs to agree upon contextual thresholds (ideally locally/seasonally calibrated percentiles or official fire danger guidance) and label what they represent. Otherwise use a neutral continuous ERC-G color scale with transparent legend.
- The archived output is an **observed-weather ERC-G reconstruction** for the selected historical date. Do not present it as a live or 7-day forecast. Future weather forecast ingestion, 30-day history state management, and real forecast backtests are separate required projects.
- Explanation endpoint can use native SHAP `pred_contribs=True` for selected prediction rows; reuse the **exact feature vector and model** used to generate the cell's score. Existing static 2025 SHAP charts are for the Model Insights page, not automatically the current cell's explanation.
- Geographic domain shift: only 600 cells were used for multi-year training. Test statewide inference quality on excluded geographic blocks before trusting unsampled regions. The canonical 46,244-cell grid has a simplified California boundary and should be ratified before production.

## Validation gates

1. All square widths/heights equal exactly 3,000 m in EPSG:3310; unique `cell_id` for each row.
2. Every row carries valid WGS84 center and `land_fraction`.
3. Finite predictors for every cell marked `ok` and nonfinite/absent feature cells marked unavailable.
4. Number of `ok` rows, negative raw predictions, and no-data cells reported, never hidden.
5. Model checksum can be cross-verified with frozen V6: `cb124badd47c898448c30500fe13f4827481e1986bd2a776605a0b99308b2e33`.
6. Validate raster-to-grid nearest pixel mapping, especially coastal areas, by spot-checking representative cells.
7. **Separate true future forecasts** and their validation from historical ERC reconstruction.
