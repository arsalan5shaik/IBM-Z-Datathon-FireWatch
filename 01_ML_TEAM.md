# FireWatch — ML Team Playbook

**Owners:** Ridwan, Eshann, Serena  
**Target:** reproducible, explainable seven-day *relative wildfire-activity risk* estimates for California regions, exposed through a stable predictor function.  
**Scope caveat:** satellite hotspots indicate detected thermal anomalies, not confirmed wildfire perimeters. The prototype is not an operational warning system.

## 1. Ownership and deliverables

| Owner | Primary assignment | First artifact | Handoff |
|---|---|---|---|
| Ridwan | ML/API coordination, contracts, evaluation, integration | `ml/predictor.py`, fixture predictions, smoke tests | Backend receives stable `predict(request)` result |
| Eshann | Historical FIRMS ingestion, temporal-spatial joins, training dataset | `data/processed/training.parquet` or CSV with schema | Model receives documented features and labels |
| Serena | Baselines, training, explanation, model validation | `ml/model.joblib`, evaluation report, top factor contributions | API receives scored regions and explanation fields |

Adjust assignments by preference; retain one named owner for every output.

## 2. Decide the prediction target before training

A **seven-day prediction** requires historical labels for the following seven days. Define a California grid (e.g., 0.25° x 0.25°, or counties for simpler demo) and a decision time `t` at 00:00 UTC. Example target:

`y(cell,t) = 1 if >= 1 qualifying NASA FIRMS hotspot is observed inside the cell during (t, t+7 days], else 0`.

This represents **future satellite-detected activity**, *not* the probability that a particular house burns, fire spread, or emergency response urgency. Be transparent that cloud cover and satellite revisits affect observations. Prefer 7-day grid-cell *activity risk*, not “7-day wildfire ignition probability,” unless a properly defined ignition dataset is used.

## 3. Sources and ingestion

1. **NASA FIRMS:** VIIRS NOAA-20/21; fetch a fixed historical window; choose standard processing (SP) when complete, NRT for latest. Area CSV API uses `/api/area/csv/{MAP_KEY}/{SOURCE}/{west,south,east,north}/{day_range}/{start_date?}` with day range 1–5. Register a MAP_KEY. Never put the key in the frontend. Data include latitude, longitude, acquisition date/time, FRP, confidence; formats and confidence semantics depend on sensor. Source: https://firms.modaps.eosdis.nasa.gov/api/area/
2. **Open-Meteo:** historical reanalysis `/v1/archive` for temperature, RH, wind speed, precipitation. For honest retrospective forecasting, historical forecast/previous-runs weather available *as of decision time* is preferable to reanalysis retrospectively observed over the predicted period. Sources: https://open-meteo.com/en/docs/historical-weather-api and https://open-meteo.com/en/docs/historical-forecast-api
3. **US Census:** Gazetteer for representative city coordinates (not population); get actual population from ACS or decennial census, matching geography IDs and vintages. Source: https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.2025.html
4. **Boundaries:** Census TIGER/Line county geometries or a pre-simplified GeoJSON for mapping.

**Crucial:** Training must NOT use weather measurements recorded after prediction time t, future FIRMS detections, or any look-ahead feature. Decide whether weather features use lagged observed conditions or forecast values available at t; document this choice.

## 4. Suggested feature schema

`region_id:string`, `as_of_date:YYYY-MM-DD`, `latitude:float`, `longitude:float`, `hotspots_7d:int`, `hotspots_30d:int`, `mean_frp_7d:float|null`, `temp_c_lag_24h:float|null`, `humidity_pct_lag_24h:float|null`, `wind_kmh_lag_24h:float|null`, `precip_mm_lag_7d:float|null`, `month:int`, `population:int|null`, `label_hotspot_next_7d:int`.

Population is better as a **separate exposure calculation** than a feature of wildfire activity prediction. `mean_frp` only for detected pixels; if none, explicitly choose a missing-value convention and missing indicator. Normalization should not leak validation/test statistics.

## 5. Evaluation and honest claims

- Start with a **no-ML baseline**: recent hotspot counts + weather thresholds. Validate its usefulness.
- Split chronologically: train on earlier months, validate on later months, test on the latest untouched interval. To reduce overlapping-label leakage, leave a seven-day gap between train/test boundaries; consider hold-out counties as a harder generalization test.
- Report PR-AUC, ROC-AUC when appropriate, recall/precision at a selected alert threshold, confusion matrix, positive prevalence, and Brier score/calibration for probabilities.
- Extreme imbalance means accuracy alone is misleading. Calibrate if claiming probabilities; otherwise label `risk_score` as a **relative score** (0–100), not a probability.
- For interpretability, start with feature contributions or permutation importance. **SHAP is optional**, only if it installs and produces correct explanations on the target or is calculated offline. Do not imply explanation equals causality.

## 6. LinuxONE native dependency strategy

The LinuxONE host is `s390x`. Prefer Python 3.11 and a light, tested requirements file. **Do not assume** binary wheels from PyPI for NumPy, pandas, SciPy, scikit-learn, SHAP, XGBoost or pyarrow are present for s390x; validate each on the actual image.

Priority A: use the host distro's supported scientific packages or the provided IBM LinuxONE ML notebook image, subject to hackathon rules and image availability. Priority B: build validated packages from source (time-consuming, compiler/BLAS/OpenMP concerns). Priority C: train offline on laptops and export a platform-independent coefficient/decision-rule JSON artifact to run with pure Python on LinuxONE. A plain `joblib`/`pickle` scikit-learn model may require scikit-learn at serving time and can be unsafe when loading untrusted files; versions must match.

**XGBoost:** current public PyPI release lists x86_64 and aarch64 Linux wheels but not s390x. Treat native s390x XGBoost as an *unverified source-build project*, not an MVP assumption. **SHAP:** compiled dependencies can also make it fragile. **RandomForest scikit-learn:** technically feasible only if scikit-learn and its dependencies successfully install on that LinuxONE environment.

### Commands to run on the real LinuxONE VM

```bash
uname -m
cat /etc/os-release
python3 --version
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip debug --verbose | sed -n '1,100p'
# Inspect resolution without installing (may fail due to missing s390x wheels)
python -m pip download --only-binary=:all: --dest /tmp/fw-wheels numpy pandas scipy scikit-learn shap xgboost pyarrow
# Test minimal API stack separately
python -m pip install fastapi 'uvicorn[standard]' httpx pydantic
python -c 'import fastapi, httpx, pydantic; print("API imports OK")'
```

Record package versions, installation source, architecture, and errors in `docs/compatibility-results.md`. `uvicorn[standard]` may bring native extras: fall back to `pip install uvicorn` if it fails. Test `httpx`, `numpy`, `pandas`, `sklearn`, and `shap` one at a time. On x86 workstations, run the same tests only as a *local convenience*, not as proof of LinuxONE compatibility.

## 7. Predictor interface — stable boundary

The ML team exposes a **Python function**, not its own web server:

```python
from typing import Any

def predict_region(region_id: str, as_of_date: str, scenario: dict | None = None) -> dict[str, Any]:
    """Return the JSON-compatible PredictionResponse documented in 03_INTEGRATION.md."""
    ...
```

`scenario` adjustments (wind speed, team count) should be clearly marked as **simulated sensitivity analysis**; team availability affects resource allocation, *not* the underlying physical fire probability. Do not silently rerun an ML model with feature inputs outside the training distribution.

## 8. First 24-hour implementation sequence

- **Hour 0–2:** validate LinuxONE host and Python dependency gate; freeze prediction JSON fixture and one geographic unit.
- **Hour 2–6:** clean a curated California FIRMS CSV, derive grid and last-7/30-day counts; build simple rules baseline.
- **Hour 6–11:** create historical labels and weather joins; train optional scikit-learn classifier only if dependencies work.
- **Hour 11–15:** evaluate on untouched chronological holdout, create explanations (or deterministic reason codes).
- **Hour 15–19:** plug into backend; compare live JSON to contract; cache model and data in process.
- **Hour 19–24:** end-to-end demo, edge-case tests, performance fixes, backup offline dataset and screenshots.

## 9. Definition of done

- [ ] Dataset provenance, time range, sensor, filters and license recorded.
- [ ] Fixed 3–5 city fixture results work without external APIs.
- [ ] Prediction JSON passes contract tests (including `as_of`, model version, provenance).
- [ ] Model or baseline evaluation is recorded; no unsupported forecasting claims.
- [ ] LinuxONE inference path is proven or a portable fallback is activated.
- [ ] One person can explain the model in under 60 seconds.
