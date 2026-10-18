#!/usr/bin/env python3
"""FireWatch conservative ERC-G challenger with temporal and held-out-cell checks.

Default: use the already-built 2024 lagged CSV as a DEVELOPMENT evaluation.
Final: pass --mode multi-year and --data ...2023... ...2024... ...2025...
       (each file has the same lagged feature columns) to enforce 2025 holdouts.
No sklearn required. No target values used as predictors.
"""
import argparse
import csv
import hashlib
import json
import math
from collections import defaultdict
from datetime import date
from pathlib import Path
import numpy as np
import xgboost as xgb

BASE = ['temp_max_c','rh_min_pct','wind_mean_ms','precip_mm','elevation_mean_m','lat','lon','day_sin','day_cos']
HISTORY = ['precip_7d_mm','precip_30d_mm','temp_mean_7d_c','rh_mean_7d_pct','dry_days_14d','wind_mean_7d_ms']
FEATURES = BASE + HISTORY


def metrics(y, pred):
    y = np.asarray(y, dtype=np.float64)
    pred = np.asarray(pred, dtype=np.float64)
    if len(y) == 0:
        return None
    err = pred - y
    sst = np.sum((y-y.mean())**2)
    return {'n':int(len(y)), 'r2':float(1-np.sum(err**2)/sst) if sst else None,
            'mae':float(np.mean(np.abs(err))), 'rmse':float(np.sqrt(np.mean(err**2))),
            'bias':float(err.mean()), 'median_ae':float(np.median(np.abs(err))),
            'p95_ae':float(np.percentile(np.abs(err),95)),
            'actual_mean':float(y.mean()), 'predicted_mean':float(pred.mean()),
            'actual_std':float(y.std()), 'predicted_std':float(pred.std())}


def is_spatial_holdout(cell, fraction):
    value = int.from_bytes(hashlib.sha256(cell.encode('utf-8')).digest()[:8], 'big') / 2**64
    return value < fraction


def load_data(paths, mode, spatial_fraction):
    d = {k:{'X':[], 'y':[], 'dates':[], 'cells':[]} for k in ('train','val','test','spatial')}
    counts=defaultdict(int)
    seen=set()
    for path in paths:
        with path.open(newline='') as f:
            reader=csv.DictReader(f)
            required=set(FEATURES+['cell_id','date','target_erc'])
            missing=required-set(reader.fieldnames or [])
            if missing: raise ValueError(f'{path}: missing {sorted(missing)}')
            for row in reader:
                day=date.fromisoformat(row['date'])
                cell=row['cell_id']
                identity=(day,cell)
                if identity in seen: raise ValueError(f'Duplicate (day,cell): {identity}')
                seen.add(identity)
                yr=day.year
                if mode=='multi-year':
                    if yr in (2023,2024): split='train'
                    elif yr==2025 and day.month<=6: split='val'
                    elif yr==2025 and day.month>=7: split='test'
                    else: raise ValueError(f'Unexpected date for multi-year mode: {day}')
                else:
                    if yr!=2024: raise ValueError('2024 mode accepts only 2024 dates')
                    if day.month<=8: split='train'
                    elif day.month==9: split='val'
                    else: split='test'
                if is_spatial_holdout(cell, spatial_fraction):
                    # Spatial benchmark uses same validation dates, never training cells.
                    if split=='val': split='spatial'
                    elif split=='train':
                        counts['spatial_train_excluded']+=1
                        continue
                x=[float(row[k]) for k in FEATURES]
                target=float(row['target_erc'])
                if not (np.isfinite(x).all() and math.isfinite(target)):
                    counts['nonfinite_skipped']+=1
                    continue
                d[split]['X'].append(x)
                d[split]['y'].append(target)
                d[split]['dates'].append(day.isoformat())
                d[split]['cells'].append(cell)
                counts[split]+=1
    for split in d:
        d[split]['X']=np.asarray(d[split]['X'],dtype=np.float32).reshape(-1,len(FEATURES))
        d[split]['y']=np.asarray(d[split]['y'],dtype=np.float32)
    if not all(len(d[k]['y']) for k in ('train','val','test')):
        raise ValueError('Need train/validation/test rows. Confirm all required year files are present.')
    if mode=='multi-year':
        for year in (2023,2024,2025):
            if not any(d0.year==year for d0,_ in seen):
                raise ValueError(f'Multi-year mode requires calendar year {year}; missing it')
    if set(d['train']['cells']) & set(d['spatial']['cells']):
        raise AssertionError('Spatial holdout leaked into training')
    return d, dict(counts)


def evaluate_slices(y, pred, dates):
    report={'overall':metrics(y,pred),'by_month':{},'by_actual_erc':{}}
    months=sorted(set(s[:7] for s in dates))
    for month in months:
        idx=np.asarray([s.startswith(month) for s in dates])
        report['by_month'][month]=metrics(y[idx],pred[idx])
    groups={'below_30':y<30, '30_to_59':(y>=30)&(y<60),'60_to_89':(y>=60)&(y<90),'90_plus':y>=90}
    for label,idx in groups.items():report['by_actual_erc'][label]=metrics(y[idx],pred[idx])
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,default=Path.home()/'firewatch')
    p.add_argument('--mode',choices=['development-2024','multi-year'],default='development-2024')
    p.add_argument('--data',type=Path,nargs='+',help='Lagged CSV paths; multiple files allowed')
    p.add_argument('--rounds',type=int,default=1200)
    p.add_argument('--threads',type=int,default=2)
    p.add_argument('--depth',type=int,default=4)
    p.add_argument('--eta',type=float,default=0.035)
    p.add_argument('--goal-r2',type=float,default=0.85,help='Reporting threshold only; never used to manipulate predictions')
    p.add_argument('--spatial-fraction',type=float,default=0.15)
    p.add_argument('--outdir',type=Path)
    args=p.parse_args()
    if not 0<args.spatial_fraction<0.4: raise ValueError('spatial fraction must be (0, 0.4)')
    if not 0 < args.goal_r2 < 1: raise ValueError('goal-r2 must be between 0 and 1')
    if args.rounds<1 or args.threads<1: raise ValueError('rounds/threads must be positive')
    paths=args.data or [args.root/'data/processed/erc_weather_2024_lagged.csv']
    paths=[q.expanduser().resolve() for q in paths]
    for path in paths:
        if not path.is_file(): raise FileNotFoundError(path)
    outdir=args.outdir or args.root/'models'/('conservative_erc_multiyear' if args.mode=='multi-year' else 'conservative_erc_2024')
    outdir.mkdir(parents=True,exist_ok=True)
    print('Reading',*[str(q) for q in paths],sep='\n  ',flush=True)
    d,counts=load_data(paths,args.mode,args.spatial_fraction)
    print('Split counts',counts,flush=True)
    matrices={k:xgb.DMatrix(d[k]['X'],label=d[k]['y'],feature_names=FEATURES)
              for k in ('train','val','test','spatial') if len(d[k]['y'])}
    params={'objective':'reg:squarederror','eval_metric':'rmse','tree_method':'hist',
            'max_depth':args.depth,'eta':args.eta,'min_child_weight':8,
            'subsample':0.80,'colsample_bytree':0.85,
            'lambda':12.0,'alpha':1.0,'nthread':args.threads,'seed':42}
    booster=xgb.train(params,matrices['train'],num_boost_round=args.rounds,
                      evals=[(matrices['train'],'train'),(matrices['val'],'validation')],
                      callbacks=[xgb.callback.EarlyStopping(rounds=50,metric_name='rmse',
                                                            data_name='validation',save_best=True)] if args.rounds>50 else [],
                      verbose_eval=max(1,args.rounds//12))
    report={'mode':args.mode,'input_files':[str(q) for q in paths], 'features':FEATURES,
            'parameters':params,'num_trees':booster.num_boosted_rounds(),
            'goal_r2':args.goal_r2,'selection_metric':'validation RMSE (goal R2 is informational only)',
            'split_counts':counts,'spatial_holdout_fraction':args.spatial_fraction,
            'results':{},'caveats':('Same-year development benchmark; 2024 test was previously inspected. '
                                  'Not an independent final result.' if args.mode=='development-2024' else
                                  '2025 held out from training; 2025 H1 selected trees, H2 test remains untrained. '
                                  '2025 target may still have been inspected during prior experiments; check provenance.')}
    for name,mat in matrices.items():
        pred=booster.predict(mat)
        report['results'][name]=evaluate_slices(d[name]['y'],pred,d[name]['dates'])
        r=report['results'][name]['overall']
        print(f'{name:8s} | n={r["n"]:,} R2={r["r2"]:.4f} RMSE={r["rmse"]:.3f} MAE={r["mae"]:.3f} bias={r["bias"]:+.3f}',flush=True)
    val_r2=report['results']['val']['overall']['r2']
    print(f'Validation R2 >= requested goal ({args.goal_r2:.2f}): {val_r2 is not None and val_r2 >= args.goal_r2}',flush=True)
    print('Do not lower model performance to hit a desired score. Compare to prior model on identical partitions.',flush=True)
    booster.save_model(str(outdir/'model.json'))
    (outdir/'metrics.json').write_text(json.dumps(report,indent=2))
    (outdir/'features.json').write_text(json.dumps({'features':FEATURES, 'mode':args.mode,
                                                   'same_day_weather_required':True,
                                                   'target':'gridMET ERC-G index; not wildfire probability'},indent=2))
    print('Saved:',outdir,flush=True)
    if args.mode=='development-2024':
        print('NOTE: DEVELOPMENT ONLY. For final holdout collect lagged 2023/2024/2025 and use --mode multi-year.',flush=True)

if __name__=='__main__':main()
