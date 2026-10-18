# FireWatch V6 — Backend Integration Handoff

## Important release state
Core **historical ERC-G model inference** is complete and frozen. A 168-hour ahead forecasting service has **NOT been implemented or verified**. NASA FIRMS active-fire detections are not future weather inputs. Current 3 km map results are for historical observed gridMET weather; **not wildfire occurrence probability**.

This download is a **starter** without the actual binary model, because that model lives on the team’s LinuxONE server. You **must run scripts/assemble_final_handoff.py on LinuxONE** to create `FireWatch_V6_FINAL_LinuxONE_verified.zip` containing exact original model and real archived map files. The bundler verifies the expected SHA256. Do not give your team the starter as if the weights are already included.

Frozen V6 SHA256: `cb124badd47c898448c30500fe13f4827481e1986bd2a776605a0b99308b2e33`.

## What is included
- `scripts/firewatch_statewide_3km_inference.py`: original **historical** statewide pipeline; requires annual gridMET NetCDF archives, grid lookup and elevation files on LinuxONE.
- `scripts/predict_feature_rows.py`: independently runnable predictor consuming **already prepared 15-feature CSV**, can output SHAP per row. Does **not** generate forecasts or validate forecast inputs.
- `scripts/explain_cell.py`: per-selected-cell TreeSHAP output, no external SHAP package required.
- `scripts/firewatch_statewide_accuracy_audit.py` and `scripts/firewatch_release_gate.py`: historical evaluations.
- `charts/user_friendly`: labeled SHAP for UI; `charts/technical`: scientific charts.
- `models/.../FEATURES_EXPECTED.json`: exact ordered feature names. No categorical encoders or fitted scalers were used; temperature conversion, precipitation sums, calendar cyclic encoding and nearest-pixel geospatial mapping are performed by the historical script. Preserve feature computation semantics.

## LinuxONE assembly — IMPORTANT
Copy this ZIP to `linux1` with SCP, `unzip -q FireWatch_V6_Backend_Handoff_STARTER.zip`, then:

```bash
cd ~/FireWatch_V6_Backend_Handoff_STAGING
python scripts/assemble_final_handoff.py
```

This produces `~/FireWatch_V6_FINAL_LinuxONE_verified.zip`. Download using SCP and send that resulting ZIP to teammates. On platforms where unzip is not available, use:

```bash
python -m zipfile -e FireWatch_V6_Backend_Handoff_STARTER.zip .
```

## Precomputed feature inference and SHAP
From extracted final ZIP, using Python with native XGBoost 2.1.4 and NumPy:

```bash
python scripts/predict_feature_rows.py --model models/releases/firewatch_erc_v6_2023_2025/model.json --input my_prepared_features.csv --output predictions.csv --with-shap
python scripts/explain_cell.py --model models/releases/firewatch_erc_v6_2023_2025/model.json --features-csv my_prepared_features.csv --cell-id 'EXACT_CELL_ID' --timestamp '2025-07-09T00:00:00-07:00'
```

Input headers: `cell_id,timestamp,` plus all 15 features in `FEATURES_EXPECTED.json`. Timestamp must identify the time of the supplied features; no false hour precision. Output includes `erc_g_raw`, `erc_g_display`, `risk_category` (BLANK), `data_status`, and `model_version`. `shap_contributions_json` explains raw ERC, not clipped display output. Missing features -> missing status, not zero risk.

## Questions 1–7
1. **Weights:** final LinuxONE bundle includes SHA-verified `model.json`; dependency list and feature contract included. No fitted encoders/scalers known/needed. NetCDF source archives are not bundled; full historical reruns require those large files plus elevation/grid CSV.
2. **168 future hourly predictions:** **NO validated system exists.** V6 is a daily ERC-G model. Feeding 168 hourly weather rows would be 168 repeated/altered daily-feature predictions and must NOT be marketed as 168-hour forecasts. Need archived weather forecast feeds, a forecast-to-15-features transformation with correct issue time, temporal convention, backtesting, and a defined daily/weekly output contract.
3. **Schema:** `cell_id,timestamp,erc_g_raw,erc_g_display,risk_category,data_status,model_version,data_kind`. `risk_category` is null/blank pending scientific calibration. Historical map CSV uses `date` instead of hourly timestamp; do not relabel historical dates as hourly forecast outputs.
4. **Live SHAP:** `explain_cell.py` and `predict_feature_rows.py --with-shap` calculate TreeSHAP for one row or many rows. Requires feature vectors at inference time; historical point GeoJSON alone is insufficient for reconstructing inputs.
5. **Risk categories:** **NOT established or validated** for Low/Moderate/High/Very High/Extreme. Do not invent cutoffs or use ERC as percent wildfire probability.
6. **Forecast validation:** **NO.** Evaluated against historical observed gridMET ERC-G, not archived historical *forecasts*. Prior VIIRS fire-occurrence association was weak (AUROC about 0.556) and this model is not an ignition predictor.
7. **Wind:** both wind columns present in 15-feature model interface and inference calculation, but zero TreeSHAP in the sampled 2025 plots indicates the fitted trees do not use them in those explanations. Verify no splits using wind across the full model using `model.get_score(importance_type='weight')`; missing entry means zero splits. That is plausible for ERC-G because wind matters for spread but is not generally a direct ERC input. Do not imply winds were omitted from raw training without checking the actual training script / split inspection.

## Validated results and key limitations
- Historical Jul–Dec 2025 sampled test: n=110,400, R²=0.9368, MAE=5.684, RMSE=7.065.
- Statewide four historical dates: 46,092 / 46,244 grid cells scored (99.67%) per date; R²=0.8737–0.9431. One-day July bias -4.715 ERC units, October 60–89 ERC bin underestimation -7.212; diagnostics documented; cannot be assumed risk-classification reliable.
- 152 missing feature rows = unavailable (not low danger).
- gridMET ~4 km source raster may repeat across 3 km grid reporting cells, and California boundary is provisional.
- The release gate PASS is **historical engineering integration** only, not permission for operational fire warnings.

## Practical backend implementation
Cache the completed historical CSV/GeoJSON behind an HTTPS endpoint; UI chooses a cell ID and displays numeric ERC-G, observation date, source provenance and SHAP explanation if feature row retained. For future forecasts, build a **separate weather forecast ETL/backtest**, then run feature-row predictor. Keep NASA FIRMS fire detections in their own overlay with observation times.

## Addendum: seven-day weather-driven outlook and prototype danger classes
Included in `scripts/`: `forecast_daily_features.py`, `calibrate_categories.py`, `apply_categories.py`, `backtest_forecasts.py`; `docs/168_HOUR_FORECAST_AND_CATEGORIES.md` explains their contracts and limitations. These are runnable scaffold components, **not evidence that a statewide 168-hour weather feed or forecast backtest has been completed**. V6 gives 7 daily ERC estimates, not 168 trained hourly scores. The five class labels are explicitly PROVISIONAL relative ERC quantiles and cannot be used as validated fire-danger ratings until calibrated and independently tested.
