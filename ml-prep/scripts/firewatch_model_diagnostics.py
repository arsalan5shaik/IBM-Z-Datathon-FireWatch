#!/usr/bin/env python3
"""Evaluate the already-trained FireWatch ERC-G model; no retraining or sklearn."""
import csv, json
from pathlib import Path
from collections import defaultdict
import numpy as np
import xgboost as xgb

ROOT=Path.home()/'firewatch'
DATA=ROOT/'data/processed/erc_weather_2024_full_year_sample.csv'
MODEL=ROOT/'models/firewatch_erc_xgboost_2024.json'
META=ROOT/'models/firewatch_erc_xgboost_2024_metrics.json'
DEST=ROOT/'models/firewatch_erc_xgboost_2024_diagnostics.json'
FEATURES=['temp_max_c','rh_min_pct','wind_mean_ms','precip_mm','elevation_mean_m','lat','lon','day_sin','day_cos']

if not (DATA.is_file() and MODEL.is_file() and META.is_file()):
    raise SystemExit('Missing model, metadata, or CSV. Verify full-year training completed.')
meta=json.loads(META.read_text())
assert meta['features']==FEATURES, 'Feature-order mismatch'
rows=defaultdict(lambda: {'X': [], 'y': [], 'months': []})
with DATA.open(newline='') as f:
    reader=csv.DictReader(f)
    for required in FEATURES+['target_erc','date','split']:
        if required not in reader.fieldnames: raise ValueError(f'Missing column: {required}')
    for r in reader:
        split=r['split']
        if split not in ('train','validation','test'): raise ValueError(f'Unexpected split: {split}')
        rows[split]['X'].append([float(r[k]) for k in FEATURES])
        rows[split]['y'].append(float(r['target_erc']))
        rows[split]['months'].append(r['date'][:7])

model=xgb.Booster()
model.load_model(str(MODEL))
try:
    iteration_end=int(meta['best_iteration'])+1
except (KeyError, ValueError):
    raise SystemExit('Cannot identify best iteration from training metadata')
if iteration_end>model.num_boosted_rounds():
    raise RuntimeError('Best iteration exceeds saved model rounds')

# The train-only global mean is a leakage-safe expected-value baseline.
train_mean=float(np.mean(np.asarray(rows['train']['y'],dtype=np.float64)))

def stats(y,p):
    y=np.asarray(y,dtype=np.float64); p=np.asarray(p,dtype=np.float64)
    err=p-y; a=np.abs(err)
    sse=float(np.sum(err**2)); tss=float(np.sum((y-y.mean())**2))
    return {'n':int(y.size),'actual_mean':float(y.mean()),'actual_median':float(np.median(y)),
            'actual_std':float(np.std(y)),'pred_mean':float(p.mean()),
            'pred_median':float(np.median(p)),'pred_std':float(np.std(p)),
            'MAE':float(a.mean()),'RMSE':float(np.sqrt(np.mean(err**2))),
            'median_abs_error':float(np.median(a)),'p90_abs_error':float(np.percentile(a,90)),
            'p95_abs_error':float(np.percentile(a,95)),
            'mean_error_bias_pred_minus_actual':float(err.mean()),
            'R2':float(1-sse/tss) if tss>0 else None,
            'actual_min':float(y.min()),'actual_max':float(y.max()),
            'pred_min':float(p.min()),'pred_max':float(p.max())}

report={'model_path':str(MODEL),'best_iteration_used':int(meta['best_iteration']),
        'train_only_expected_ERC_mean':train_mean,
        'note':'Train/validation/test are chronological but use the same sampled cells. This is not a spatial holdout or true archived-forecast evaluation.',
        'splits':{},'test_months':{}}

for split in ('train','validation','test'):
    X=np.asarray(rows[split]['X'],dtype=np.float32)
    y=np.asarray(rows[split]['y'],dtype=np.float32)
    d=xgb.DMatrix(X,feature_names=FEATURES)
    pred=model.predict(d, iteration_range=(0,iteration_end))
    m=stats(y,pred)
    m['mean_baseline']=stats(y,np.full(y.size,train_mean,dtype=np.float64))
    report['splits'][split]=m
    print(f"{split:10s} n={m['n']:7,d} | E[ERC]={m['actual_mean']:7.2f} | pred mean={m['pred_mean']:7.2f} | MAE={m['MAE']:7.3f} | RMSE={m['RMSE']:7.3f} | R2={m['R2']:7.3f} | bias={m['mean_error_bias_pred_minus_actual']:+7.3f}")
    print(f"{'':10s} medianAE={m['median_abs_error']:.3f} | p90AE={m['p90_abs_error']:.3f} | p95AE={m['p95_abs_error']:.3f} | actual std={m['actual_std']:.3f}")
    if split=='test':
        months=np.asarray(rows[split]['months'])
        for month in sorted(set(months)):
            ix=(months==month)
            report['test_months'][month]=stats(y[ix],pred[ix])

print('\nTest performance by month:')
for month,m in report['test_months'].items():
    print(f"  {month} | n={m['n']:6,d} | MAE={m['MAE']:7.3f} | RMSE={m['RMSE']:7.3f} | bias={m['mean_error_bias_pred_minus_actual']:+7.3f} | R2={m['R2']:7.3f}")

tr=report['splits']['train']; va=report['splits']['validation']; te=report['splits']['test']
report['generalization']={'validation_to_train_RMSE_ratio':va['RMSE']/tr['RMSE'],
 'test_to_train_RMSE_ratio':te['RMSE']/tr['RMSE'],
 'test_MAE_vs_train_mean_baseline_reduction_percent':100*(1-te['MAE']/te['mean_baseline']['MAE'])}
print('\nGeneralization gap: validation/train RMSE ratio =',round(report['generalization']['validation_to_train_RMSE_ratio'],2))
print('Test mean-baseline MAE improvement =',round(report['generalization']['test_MAE_vs_train_mean_baseline_reduction_percent'],2),'%')
DEST.write_text(json.dumps(report,indent=2))
print('Saved:',DEST)
