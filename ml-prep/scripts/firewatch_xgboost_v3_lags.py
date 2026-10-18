#!/usr/bin/env python3
"""FireWatch V3: causal trailing weather features + native XGBoost.

Uses the EXISTING 2024 joined CSV (no additional downloads).
Only January 31 onward has complete 30-day history in this file.
Never reads future days to construct features. Never uses the test split for tuning.
"""
import argparse
import csv
import json
import math
from collections import defaultdict, deque
from datetime import date, timedelta
from pathlib import Path
import numpy as np
import xgboost as xgb

BASE = ['temp_max_c', 'rh_min_pct', 'wind_mean_ms', 'precip_mm',
        'elevation_mean_m', 'lat', 'lon', 'day_sin', 'day_cos']
LAGS = ['precip_7d_mm', 'precip_30d_mm', 'temp_mean_7d_c',
        'rh_mean_7d_pct', 'dry_days_14d', 'wind_mean_7d_ms']
FEATURES = BASE + LAGS


def evaluate(y, pred):
    err = pred - y
    ss = float(np.sum((y - y.mean())**2))
    return {'n': len(y), 'mae': float(np.mean(np.abs(err))),
            'rmse': float(np.sqrt(np.mean(err * err))),
            'bias': float(np.mean(err)),
            'r2': float(1 - np.sum(err * err) / ss) if ss else None,
            'p95_abs_error': float(np.percentile(np.abs(err), 95)),
            'mean_actual': float(np.mean(y)), 'mean_predicted': float(np.mean(pred))}


def construct_features(source, output):
    """Stream a date-sorted file; maintain per-cell 30 prior calendar days."""
    histories = defaultdict(lambda: deque(maxlen=30))
    stats = {'input': 0, 'complete': 0, 'incomplete_history': 0, 'nonconsecutive': 0}
    X = {'train': [], 'validation': [], 'test': []}
    y = {'train': [], 'validation': [], 'test': []}
    dates = {'train': set(), 'validation': set(), 'test': set()}
    with source.open(newline='') as f, output.open('w', newline='') as out:
        reader = csv.DictReader(f)
        needed = ['cell_id', 'date', 'split', 'target_erc'] + BASE
        missing = sorted(set(needed) - set(reader.fieldnames or []))
        if missing:
            raise ValueError('Missing CSV fields: ' + ', '.join(missing))
        writer = csv.DictWriter(out, fieldnames=['cell_id', 'date', 'split', 'target_erc'] + FEATURES)
        writer.writeheader()
        previous_day = None
        for row in reader:
            stats['input'] += 1
            day = date.fromisoformat(row['date'])
            if previous_day is not None and day < previous_day:
                raise ValueError('CSV must be ordered by date (2024 trainer is).')
            previous_day = day
            split = row['split']
            if split not in X:
                raise ValueError('Unrecognized split: ' + split)
            cell = row['cell_id']
            hist = histories[cell]
            # History excludes today's measurements; exactly 30 preceding days required.
            full = len(hist) == 30 and all(
                hist[-k][0] == day - timedelta(days=k) for k in range(1, 31)
            )
            if full:
                prior = list(hist)
                values = {
                    'precip_7d_mm': sum(z[1] for z in prior[-7:]),
                    'precip_30d_mm': sum(z[1] for z in prior),
                    'temp_mean_7d_c': sum(z[2] for z in prior[-7:]) / 7,
                    'rh_mean_7d_pct': sum(z[3] for z in prior[-7:]) / 7,
                    'dry_days_14d': sum(z[1] < 1.0 for z in prior[-14:]),
                    'wind_mean_7d_ms': sum(z[4] for z in prior[-7:]) / 7,
                }
                features = [float(row[z]) for z in BASE] + [float(values[z]) for z in LAGS]
                target = float(row['target_erc'])
                if np.isfinite(features).all() and math.isfinite(target):
                    writer.writerow({**{key: row[key] for key in ['cell_id','date','split','target_erc']},
                                     **{key: float(row[key]) for key in BASE}, **values})
                    X[split].append(features)
                    y[split].append(target)
                    dates[split].add(day.isoformat())
                    stats['complete'] += 1
            else:
                stats['incomplete_history'] += 1
                if len(hist) == 30: stats['nonconsecutive'] += 1
            hist.append((day, float(row['precip_mm']), float(row['temp_max_c']),
                         float(row['rh_min_pct']), float(row['wind_mean_ms'])))
    X = {s: np.asarray(v, dtype=np.float32).reshape(-1, len(FEATURES)) for s, v in X.items()}
    y = {s: np.asarray(v, dtype=np.float32) for s, v in y.items()}
    return X, y, stats, {s:sorted(v) for s, v in dates.items()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path.home()/'firewatch')
    parser.add_argument('--rounds', type=int, default=800)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--smoke', action='store_true', help='Short integration smoke test; separate files')
    args = parser.parse_args()
    root = args.root
    source = root/'data/processed/erc_weather_2024_full_year_sample.csv'
    suffix = '_SMOKE' if args.smoke else ''
    output = root/'data/processed'/f'erc_weather_2024_lagged{suffix}.csv'
    model_path = root/'models'/f'firewatch_erc_xgboost_v3_lags{suffix}.json'
    metrics_path = root/'models'/f'firewatch_erc_xgboost_v3_lags_metrics{suffix}.json'
    for p in (output.parent, model_path.parent): p.mkdir(parents=True, exist_ok=True)
    print('Building causal weather history from:', source, flush=True)
    X, y, stats, dates = construct_features(source, output)
    print('Rows:', stats, flush=True)
    for s in X:
        print(f'{s}: {len(y[s]):,} rows; {len(dates[s])} dates',flush=True)
    if len(y['train']) < 50 or len(y['validation']) < 10:
        raise ValueError('Insufficient training/validation rows for a meaningful fit')
    dtr = xgb.DMatrix(X['train'], label=y['train'], feature_names=FEATURES)
    dva = xgb.DMatrix(X['validation'], label=y['validation'], feature_names=FEATURES)
    params = {'objective':'reg:squarederror', 'eval_metric':'rmse', 'tree_method':'hist',
              'max_depth':6, 'eta':0.1, 'min_child_weight':1,
              'subsample':0.85, 'colsample_bytree':0.8, 'lambda':5.0,
              'alpha':0.0, 'nthread':args.threads, 'seed':42}
    rounds = 20 if args.smoke else args.rounds
    booster = xgb.train(params, dtr, num_boost_round=rounds,
                        evals=[(dtr, 'train'), (dva, 'validation')],
                        callbacks=[xgb.callback.EarlyStopping(rounds=40, metric_name='rmse',
                                                              data_name='validation', save_best=True)] if rounds>40 else [],
                        verbose_eval=50 if rounds>40 else False)
    pred_tr = booster.predict(dtr)
    pred_va = booster.predict(dva)
    report = {'features':FEATURES, 'model_params':params, 'best_rounds':booster.num_boosted_rounds(),
              'data_rows':stats, 'date_ranges':{s:[v[0],v[-1]] if v else [] for s,v in dates.items()},
              'train':evaluate(y['train'],pred_tr),
              'validation':evaluate(y['validation'],pred_va),
              'note':'Observed-weather ERC-G surrogate. Split by dates. No test-set use in model selection. Jan 1-30 have incomplete lag history. 2025 independent test required.'}
    # Original models on identical validation rows. This is ONLY a fair same-row comparison.
    for tag, path in [('v1','firewatch_erc_xgboost_2024.json'),
                      ('tuned','tuning_2024/xgboost_tuned_best.json')]:
        oldpath = root/'models'/path
        if oldpath.exists():
            old=xgb.Booster(); old.load_model(str(oldpath))
            oldnames=old.feature_names or BASE
            indices=[FEATURES.index(name) for name in oldnames]
            old_dval=xgb.DMatrix(X['validation'][:,indices],feature_names=oldnames)
            oldpred=old.predict(old_dval)
            report[tag+'_same_validation_rows']=evaluate(y['validation'],oldpred)
    # Test set is deliberately not read by the model; can be examined on a genuinely new year later.
    booster.save_model(str(model_path))
    metrics_path.write_text(json.dumps(report,indent=2))
    print('\n=== V3 RESULTS (SEPTEMBER VALIDATION) ===',flush=True)
    for tag in ['train','validation','v1_same_validation_rows','tuned_same_validation_rows']:
        if tag in report:
            v=report[tag]
            print(f"{tag}: RMSE={v['rmse']:.3f} MAE={v['mae']:.3f} R2={v['r2']:.3f} bias={v['bias']:+.3f}",flush=True)
    print('Model:',model_path,flush=True)
    print('Metrics:',metrics_path,flush=True)
    print('Lagged dataset:',output,flush=True)

if __name__ == '__main__':
    main()
