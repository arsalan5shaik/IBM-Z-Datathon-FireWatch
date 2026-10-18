# FireWatch 168-hour forecast and five-category deployment contract

## Correct scientific framing
The **source weather forecast** can have 168 hourly timesteps. Frozen XGBoost V6 estimates **daily ERC-G** based on daily maxima/minima and lagged daily weather. It produces **seven daily ERC-G predictions for each 3 km cell**, not 168 independently trained or validated hourly ERC predictions. An hourly frontend timeline may show the same explicitly day-scoped ERC-G score in each of the corresponding 24 hours, clearly marked `resolution: daily_repeated_in_hourly_ui`; never suggest it changes hourly. The start/end of local days and provider UTC calendar-day aggregation must be declared and consistent with training.

## Required genuine weather feed
For EVERY grid cell: at least 30 past daily weather records known at issue time + 7 days of daily forecast meteorology (max temperature °C, min RH %, mean wind m/s, daily precipitation mm); static cell elevation, lat/lon; metadata source/issued UTC. Forecast provider hourly feed may be aggregated to daily, using timezone-aligned days. Historical gridMET weather and forecast model weather are different distributions; evaluate transfer bias explicitly. No missing-feature substitution; 152 existing missing cells remain missing. Keep original `cell_id` strings.

See `scripts/forecast_daily_features.py`: accepts already aggregated DAILY `weather` CSV, reconstructs same 15 V6 features including *prior days only* (no look-ahead), outputs 7 daily feature rows per cell. Feed into `scripts/predict_feature_rows.py` for actual model predictions. **The script does not fetch forecasts or guarantee operational correctness of source provenance.** End-to-end statewide live ingestion/throughput has not been built or tested.

Input CSV `cell_id,date,source,issued_at_utc,temp_max_c,rh_min_pct,wind_mean_ms,precip_mm,elevation_mean_m,lat,lon`. `source=observed` for 30 prior days and `source=forecast` for the future seven days. `issued_at_utc` should be an actual provider timestamp for each forecast row. This starter assumes issue-date last observed day and next seven complete UTC days—an intentional constraint, not a general real-time interface.

Example:
```
python scripts/forecast_daily_features.py --weather weather_daily_37days.csv --issue-date 2026-10-17 --output forecast_features.csv
python scripts/predict_feature_rows.py --model models/releases/firewatch_erc_v6_2023_2025/model.json --input forecast_features.csv --output seven_daily_erc.csv --with-shap
```
The predictor currently drops `lead_day`/`forecast_source` fields from output, so join them by `(cell_id,timestamp)` and preserve the source manifest for evaluation.

## Five levels (prototype only)
The NWCG National Fire Danger Adjective Rating is a broader area-specific designation, not simply a universal numeric ERC-G cutoff. **Do not pass five arbitrary ERC cutoffs off as NWCG or validated wildfire-risk categories.** An optional **experimental** region-and-month percentile calibration is implemented in `scripts/calibrate_categories.py` and `scripts/apply_categories.py`. It divides a region/month's historical reference ERC-G distribution into five 20-percentile bins. This is a *relative ERC condition class*, not verified ignition/spread risk, and is only emitted if `--allow-provisional` is explicitly passed. Separate region definitions (e.g., predictive service areas) and historical calibration dataset are required. Source pixel/day deduplication and multi-year coverage necessary. Hold back subsequent years to evaluate high-class misses, temporal stability, and false alarm/recall. No thresholds have yet been calibrated in the actual project.

Required reference schema: `region,month,erc_g_reference`; prediction schema for optional categorization: `region,timestamp,erc_g_display,data_status` with date/month preserving provider timezone convention.

## Archived forecast validation
`backtest_forecasts.py` accepts **real issued-forecast** model predictions and **subsequently observed gridMET ERC-G** reference for matching cell+valid time and calculates metrics for forecast lead-days 1–7. Requires source manifest with provider, archived run id, actual issue time and retrieval details. This validation has **NOT** been executed against genuine archived forecast data in our environment; any result claiming otherwise would be misleading. In particular, the existing 2025 state-wide R² figures use observed weather inputs and are *not* forecast-skill estimates. Validating a forecast also requires checking whether its **30-day lagged inputs were actually available at issuance**.

Possible forecast archives: Open-Meteo [Previous Runs](https://open-meteo.com/en/docs/previous-runs-api) for fixed 1–7-day lead times and [Single Runs](https://open-meteo.com/en/docs/historical-forecast-api) / corresponding run archive for a complete issue-time forecast. A continuous historical forecast series *stitched from successive runs* is NOT the same as a single issued seven-day outlook. Forecast archive access and license must be checked for the team's use case.

## Five-category criteria before activation
1. Define each region/month, baseline years, source-pixel deduplication, sample sufficiency; version calibrations.
2. Fit only on historical **reference** ERC-G in calibration years, with temporally held-out reference observations for verification.
3. Evaluate expected category frequencies, confusion matrix, Extreme and Very High missed-class rates, cross-region/month robustness, forecast lead-day deterioration, and calibration drift.
4. Compare predicted versus reference ERC; document underprediction on high ERC from July/October audits; do not use same dates to tweak thresholds and report a final unbiased score.
5. Until verified, frontend categories either **hidden** or clearly **Experimental relative ERC**. NEVER position as official agency wildfire alerts.

## Frontend API contracts
```
{
  "cell_id":"<existing grid ID>",
  "issued_at_utc":"2026-10-17T00:00:00Z",
  "valid_date":"2026-10-18",
  "lead_day":1,
  "temporal_resolution":"daily",
  "metric":"ERC-G",
  "erc_g_raw":null,
  "erc_g_display":null,
  "relative_erc_category":null,
  "category_status":"not_calibrated",
  "data_status":"missing_until_real_forecast_ingested",
  "model_version":"firewatch_erc_v6_2023_2025",
  "weather_provenance":"no_forecast_source_connected"
}
```
The example contains NULL estimates intentionally, not fabricated future predictions.
