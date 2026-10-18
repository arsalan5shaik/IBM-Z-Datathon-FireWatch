# FireWatch V6 — integration handoff and release gate

## Status
- **Frozen model:** `models/releases/firewatch_erc_v6_2023_2025/model.json` (do not retrain or modify).
- **Model SHA-256:** `cb124badd47c898448c30500fe13f4827481e1986bd2a776605a0b99308b2e33`.
- **Output:** Retrospective *ERC-G index estimate*, **not** fire probability, wildfire detection, or future seven-day forecast.
- **3 km cells:** EPSG:3310 3000×3000 m **reporting units**, not independent 3 km meteorological observations.
- **Current one-day statewide audit (2025-07-09):** 46,092 / 46,244 scored (99.67%); R² 0.8896; MAE 6.118; RMSE 7.246; bias −4.715 ERC units; ERC 90+ bias −5.870. This is one date only.
- **Current limitations:** simplified/provisional California boundary; 152 unavailable cells; regional/seasonal color cutoffs **not calibrated**; 2025 reference has been used during development; seven-day forecasting **not validated**.

## On Mac
Download `firewatch_release_gate.py` then:

```bash
scp -i ~/Downloads/whoosh_key.pem ~/Downloads/firewatch_release_gate.py linux1@148.100.78.101:/home/linux1/firewatch/scripts/
```

## On LinuxONE
The audit uses the existing verified `firewatch_statewide_3km_inference.py` and `firewatch_statewide_accuracy_audit.py` installed under `scripts/`.

```bash
cd ~/firewatch
source .venv311/bin/activate
python -m py_compile scripts/firewatch_release_gate.py
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 python scripts/firewatch_release_gate.py --threads 2
```

The script processes April 15, July 9, October 15, and December 15, 2025 using full prior 30-day weather history; exports per-day CSV and audits for the **complete** defined grid, not only 600 cells. May take time; 4 day-level weather loading operations. Run one date first using `--dates 2025-07-09` to validate setup, then the default dates. Existing artifacts for a matching date may be reused with `--skip-generation`.

Diagnostic gates: coverage ≥ 99%, day R² ≥ 0.8, MAE ≤ 9 ERC points, and |mean bias on ERC≥90| ≤ 8 points. **These thresholds are engineering tripwires, not scientific safety cutoffs or proof of geographic validity.** Failing checks do not permit blanket bias offsets or fabricated scores; analyze them, especially high-ERC underprediction.

Output `data/map_3km/firewatch_statewide_release_gate.json`, plus dated CSVs and accuracy audit JSON files. If there is a failure, the script exits nonzero.

## Frontend/backend minimum contract
- `cell_id`, `date`, `center_lat`, `center_lon`, `erc_g_display`, `erc_g_raw`, `data_status`, `model_version`, `data_kind`.
- For `data_status != "ok"`, show **No estimate**, not green/zero.
- `erc_g_raw` is kept for evaluation; `erc_g_display = max(0, erc_g_raw)` is a postprocessing display transform. SHAP contributions add to **raw**, not clipped, model output.
- No red/yellow/green categories until reference distribution and seasonal/regional percentile calibration have been computed, reviewed and validated for missed high-danger conditions. For prototype maps use neutral point markers and a numeric ERC-G legend labeled "Historical estimate".
- The `*_points.geojson` from the existing script contains only valid point centers; a polygon-grid overlay requires correctly transformed and validated cell polygons.
- `model_version="firewatch_erc_v6_2023_2025"`; `data_kind="historical_observed_weather_ERC_G_reconstruction"`.
- Need a **separate** pipeline and retrospective forecast-issuance backtest to claim future seven-day fire-weather forecasts. Existing probability API must not reuse ERC-G values as percentages.

## Data-quality follow-up
- Examine missing feature/elevation gaps for 152 cells; do not fill from arbitrary neighboring values without geospatial provenance and checks.
- Replace/verify provisional California land polygon before production.
- Test full-grid performance for several dates and regions; distinguish nearest gridMET pixel duplicates from independent samples.
- Validate seasonal/region-specific calibration before danger colors.
- Compare VIIRS detections separately as external context (observed association AUROC ~0.556 on sampled cells), not a claim of ignition prediction.
