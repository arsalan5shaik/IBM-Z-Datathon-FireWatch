#!/usr/bin/env python3
"""Freeze and verify an EXISTING native-XGBoost FireWatch V6 ERC-G model.
Does NOT retrain, tune, modify evaluation metrics, or infer wildfire probability.
Run on IBM LinuxONE inside the existing Python 3.11 venv.
"""
import argparse
import csv
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import xgboost as xgb

FEATURES = ['temp_max_c','rh_min_pct','wind_mean_ms','precip_mm','elevation_mean_m','lat','lon','day_sin','day_cos','precip_7d_mm','precip_30d_mm','temp_mean_7d_c','rh_mean_7d_pct','dry_days_14d','wind_mean_7d_ms']
DISPLAY = {'temp_max_c':'Today’s High Temperature (°C)', 'rh_min_pct':'Today’s Lowest Relative Humidity (%)', 'wind_mean_ms':'Daily Mean Wind Speed (m/s)', 'precip_mm':'Daily Rainfall (mm)', 'elevation_mean_m':'Elevation (m)', 'lat':'Latitude', 'lon':'Longitude', 'day_sin':'Seasonality (sine)', 'day_cos':'Seasonality (cosine)', 'precip_7d_mm':'7-Day Rainfall (mm)', 'precip_30d_mm':'30-Day Rainfall (mm)', 'temp_mean_7d_c':'7-Day Average High Temperature (°C)', 'rh_mean_7d_pct':'7-Day Average Minimum Humidity (%)', 'dry_days_14d':'Dry Days in the Previous 14 Days', 'wind_mean_7d_ms':'7-Day Mean Wind Speed (m/s)'}

def sha256(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for block in iter(lambda: f.read(1024*1024),b''): h.update(block)
    return h.hexdigest()

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',type=Path,default=Path('models/firewatch_erc_multiyear_v6'))
    p.add_argument('--data',type=Path,default=Path('data/processed/erc_weather_2025_lagged_multiyear.csv'))
    p.add_argument('--outdir',type=Path,default=Path('models/releases/firewatch_erc_v6_2023_2025'))
    p.add_argument('--smoke-rows',type=int,default=100)
    p.add_argument('--threads',type=int,default=2)
    args=p.parse_args()
    src=args.source.resolve(); dst=args.outdir.resolve(); data=args.data.resolve()
    if src==dst: raise ValueError('Source and release output directory must differ')
    for name in ('model.json','metrics.json','features.json'):
        if not (src/name).is_file(): raise FileNotFoundError(f'Missing {src/name}')
    if not data.is_file(): raise FileNotFoundError(f'Missing smoke dataset {data}')
    b=xgb.Booster(params={'nthread':args.threads}); b.load_model(str(src/'model.json'))
    if b.feature_names != FEATURES: raise ValueError(f'Model feature order unexpected: {b.feature_names}')
    report=json.loads((src/'metrics.json').read_text())
    settings=json.loads((src/'features.json').read_text())
    if settings.get('features')!=FEATURES: raise ValueError('features.json differs from trained model')
    if report.get('mode')!='multi-year': raise ValueError('Expected multi-year model')
    rows=[]
    with data.open(newline='') as f:
        reader=csv.DictReader(f)
        if not set(FEATURES+['cell_id','date','target_erc']).issubset(reader.fieldnames or []):
            raise ValueError('Smoke-data feature schema mismatch')
        for r in reader:
            if r['date']>='2025-07-01':
                vals=[float(r[k]) for k in FEATURES]
                if np.isfinite(vals).all(): rows.append((r,vals))
                if len(rows)>=args.smoke_rows: break
    if not rows: raise ValueError('No valid July–December 2025 rows in smoke dataset')
    x=np.asarray([v for _,v in rows],dtype=np.float32)
    dm=xgb.DMatrix(x,feature_names=FEATURES)
    preds=b.predict(dm)
    contrib=b.predict(dm,pred_contribs=True)
    delta=np.max(np.abs(contrib.sum(axis=1)-preds))
    if not np.isfinite(preds).all() or not np.isfinite(contrib).all(): raise ValueError('Nonfinite model prediction/SHAP')
    if delta>0.001: raise ValueError(f'SHAP additivity error too high: {delta}')
    if dst.exists() and any(dst.iterdir()):
        raise FileExistsError(f'Release directory already exists and is nonempty: {dst}. Use a new --outdir; never overwrite a frozen release.')
    dst.mkdir(parents=True,exist_ok=True)
    for name in ('model.json','metrics.json','features.json'):
        shutil.copy2(src/name,dst/name)
    extra=src/'viirs_validation'/'validation_report.json'
    if extra.is_file(): shutil.copy2(extra,dst/'viirs_validation_report.json')
    manifest={
        'release_name':'firewatch_erc_v6_2023_2025', 'status':'research_prototype_not_operational',
        'created_utc':datetime.now(timezone.utc).isoformat(), 'xgboost_version':xgb.__version__,
        'target':'gridMET Energy Release Component, Fuel Model G (ERC-G) index',
        'not_a_wildfire_probability':True, 'not_a_seven_day_forecast':True,
        'observed_same_day_weather_required':True,
        'training_years':[2023,2024], 'validation_period':'2025-01 through 2025-06',
        'evaluated_period':'2025-07 through 2025-12 (previously inspected during model selection)',
        'training_data': '600 selected cells, repeated cell-day observations; not statewide grid coverage',
        'feature_order':FEATURES, 'friendly_feature_names':DISPLAY,
        'display_metric':'Estimated Fire-Weather Energy Release Index (ERC-G)',
        'limitations':['Not wildfire ignition probability or expected acres burned',
          '2025 H2 was examined during development, so not a pristine untouched model-selection test',
          'Spatial holdout uses selected cell IDs; neighboring cells may share original raster pixels',
          'Unvalidated seven-day forecast; live predictions need forecast weather and lag-history construction',
          'VIIRS hotspot discrimination was weak in the 600-cell sample (AUROC about 0.556)',
          'Raw ERC estimates may be below zero; handle display separately, never modify stored evaluation metrics',
          'Do not treat ERC-G thresholds as universal California-wide fire-danger categories'],
        'smoke_test':{'rows':len(rows),'min_prediction':float(preds.min()),
                      'max_prediction':float(preds.max()),
                      'max_shap_additivity_error':float(delta)},
        'files_sha256':{name:sha256(dst/name) for name in ('model.json','metrics.json','features.json')},
        'evaluation':{k:v['overall'] for k,v in report.get('results',{}).items()}
    }
    (dst/'manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+'\n')
    with (dst/'smoke_predictions.csv').open('w',newline='') as f:
        w=csv.writer(f);w.writerow(['cell_id','date','actual_gridmet_erc_g','predicted_erc_g'])
        for (r,_),pred in zip(rows,preds):w.writerow([r['cell_id'],r['date'],r['target_erc'],float(pred)])
    print('FROZEN RELEASE:',dst)
    print('MODEL TREES:',b.num_boosted_rounds(),'FEATURES:',len(FEATURES),'SMOKE ROWS:',len(rows))
    print('SHAP ADDITIVITY MAX ERROR:',float(delta))
    print('MODEL SHA256:',manifest['files_sha256']['model.json'])
    for k,v in manifest['evaluation'].items():print(f'{k:8} R2={v["r2"]:.4f} RMSE={v["rmse"]:.3f} MAE={v["mae"]:.3f} BIAS={v["bias"]:+.3f}')
    print('READY FOR HANDOFF AS AN ERC-G RESEARCH PROTOTYPE; NOT A FIRE-IGNITION FORECAST.')

if __name__=='__main__': main()
