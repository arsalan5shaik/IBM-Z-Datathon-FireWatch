# FireWatch multi-year expansion (IBM LinuxONE / s390x)

## Goal
Add official gridMET ERC-G, tmmx, rmin, vs, pr annual NetCDF archives from **2023 and 2025**, preserving the exact 2024 California 3-km cell lookup and randomly selected 1,400 original cell IDs. All source day/latitude/longitude axes are checked before extraction. Use **600 stable cells** for first multi-year training to fit LinuxONE's 7.3-GiB RAM. We can subsequently scale up if resources permit.

## Files
- `firewatch_expand_gridmet.py`: resume-capable NetCDF download and sampled-cell extraction from gridMET, writing one CSV per added year. Reuses 2024 source CSV.
- `firewatch_build_multiyear_lags.py`: streams 2023–2025 sorted CSVs and constructs previous 7/14/30-day lag features (excluding current date); histories cross December/January.
- `firewatch_train_multiyear.py`: existing native XGBoost final trainer with train 2023–24, validation Jan–Jun 2025, test Jul–Dec 2025. It saves a new model without overwriting the 2024 models. Native XGBoost only, no scikit-learn.

## Commands (run inside LinuxONE SSH terminal after SCP files)

```bash
cd ~/firewatch
source .venv311/bin/activate
python -m py_compile scripts/firewatch_expand_gridmet.py scripts/firewatch_build_multiyear_lags.py scripts/firewatch_train_multiyear.py

# You can download first and extract later if bandwidth or disk space becomes tight.
python scripts/firewatch_expand_gridmet.py --years 2023 2025 --fetch-only
python scripts/firewatch_expand_gridmet.py --years 2023 2025 --extract-only

python scripts/firewatch_build_multiyear_lags.py --cells 600

OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 python scripts/firewatch_train_multiyear.py \
 --mode multi-year --rounds 800 --threads 2 --depth 4 --eta 0.035 \
 --data data/processed/erc_weather_2023_lagged_multiyear.csv \
        data/processed/erc_weather_2024_lagged_multiyear.csv \
        data/processed/erc_weather_2025_lagged_multiyear.csv \
 --outdir models/firewatch_erc_multiyear_2023_2025
```

## Critical caveats
This is *observed-weather ERC-G regression*, not a backtested 7-day fire prediction. Cross-year results cannot be promised in advance; do not force R² to 0.85 or 0.90. Dataset sampling is deterministic and the 2025 second half is held out of training and selection. `firewatch_train_multiyear.py` uses **individual hashed withheld cells**, NOT independent geographic blocks. The full model is not deployment-ready until we audit data leakage, geographic holdout, and forecast-input availability. Download sources and model data are public gridMET, not VIIRS wildfire labels.

Expected additional downloads: about 1 GB for 10 annual CONUS NetCDF files; check with `df -h ~/firewatch`. Depending on source and year, sizes may vary. Sources: https://www.climatologylab.org/gridmet.html and https://www.northwestknowledge.net/metdata/data/ .
