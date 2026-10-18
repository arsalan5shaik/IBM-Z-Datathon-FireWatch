#!/usr/bin/env python3
"""Native-XGBoost randomized tuning on existing FireWatch 2024 ERC training CSV.
Uses ONLY train and September validation. Never reads the existing test split.
"""
import argparse
import csv
import json
from pathlib import Path
import time
import numpy as np
import xgboost as xgb


def metrics(y, p):
    e = p - y
    return {
        'mae': round(float(np.mean(np.abs(e))), 5),
        'rmse': round(float(np.sqrt(np.mean(e * e))), 5),
        'bias': round(float(np.mean(e)), 5),
        'p95_abs_error': round(float(np.percentile(np.abs(e), 95)), 5),
        'r2': round(float(1 - np.sum(e * e) / np.sum((y - np.mean(y)) ** 2)), 5)
        if len(y) > 1 and np.var(y) > 0 else None,
    }


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path.home() / 'firewatch')
    parser.add_argument('--trials', type=int, default=12)
    parser.add_argument('--rounds', type=int, default=600)
    parser.add_argument('--threads', type=int, default=2)
    args = parser.parse_args()
    if args.trials < 1 or args.rounds < 1:
        parser.error('trials and rounds must be positive')

    root = args.root.expanduser()
    data = root / 'data/processed/erc_weather_2024_full_year_sample.csv'
    original = root / 'models/firewatch_erc_xgboost_2024.json'
    output = root / 'models/tuning_2024'
    output.mkdir(parents=True, exist_ok=True)

    benchmark = xgb.Booster()
    benchmark.load_model(str(original))
    features = benchmark.feature_names
    if not features:
        raise RuntimeError('Original model lacks named features')

    xs, ys = {'train': [], 'validation': []}, {'train': [], 'validation': []}
    with data.open(newline='') as f:
        reader = csv.DictReader(f)
        need = set(features) | {'split', 'target_erc'}
        if not need.issubset(reader.fieldnames or []):
            raise RuntimeError('Missing CSV columns: ' + str(sorted(need - set(reader.fieldnames or []))))
        for row in reader:
            s = row['split']
            if s not in xs:
                continue  # Holdout test is deliberately unread.
            y = float(row['target_erc'])
            x = [float(row[k]) if row[k].strip() else float('nan') for k in features]
            if not np.isfinite(y):
                continue
            xs[s].append(x)
            ys[s].append(y)
    for s in xs:
        xs[s] = np.asarray(xs[s], dtype=np.float32)
        ys[s] = np.asarray(ys[s], dtype=np.float32)
        if len(ys[s]) < 5:
            raise ValueError(f'Not enough {s} rows')
        print(f'{s}: {len(ys[s]):,} rows', flush=True)

    dtrain = xgb.DMatrix(xs['train'], label=ys['train'], feature_names=features)
    dval = xgb.DMatrix(xs['validation'], label=ys['validation'], feature_names=features)

    # Fixed reproducible trial sequence; sampled only from train/validation.
    rng = np.random.default_rng(42)
    configs = []
    for _ in range(args.trials):
        configs.append({
            'max_depth': int(rng.choice([3, 4, 5, 6])),
            'eta': float(rng.choice([0.025, 0.05, 0.075, 0.1])),
            'min_child_weight': int(rng.choice([1, 3, 5, 10, 20])),
            'subsample': float(rng.choice([0.7, 0.85, 1.0])),
            'colsample_bytree': float(rng.choice([0.8, 1.0])),
            'reg_lambda': float(rng.choice([1.0, 5.0, 10.0, 20.0])),
            'reg_alpha': float(rng.choice([0.0, 0.5, 2.0])),
        })
    results = []
    best_model, best_stats = None, None
    for i, config in enumerate(configs, 1):
        params = {
            'objective': 'reg:squarederror', 'eval_metric': 'rmse',
            'tree_method': 'hist', 'nthread': args.threads, 'seed': 42,
            **config,
        }
        start = time.monotonic()
        # save_best physically discards trees after selected iteration.
        callback = xgb.callback.EarlyStopping(
            rounds=40, metric_name='rmse', data_name='validation', save_best=True
        )
        model = xgb.train(
            params=params, dtrain=dtrain, num_boost_round=args.rounds,
            evals=[(dtrain, 'train'), (dval, 'validation')],
            callbacks=[callback], verbose_eval=False
        )
        train_score = metrics(ys['train'], model.predict(dtrain))
        val_score = metrics(ys['validation'], model.predict(dval))
        stat = {
            'trial': i, 'params': config,
            'best_iteration': int(model.best_iteration),
            'train': train_score, 'validation': val_score,
            'duration_seconds': round(time.monotonic() - start, 1),
        }
        results.append(stat)
        print(f"Trial {i:02d}/{len(configs)} | depth={config['max_depth']} "
              f"eta={config['eta']} | val RMSE={val_score['rmse']:.3f} "
              f"MAE={val_score['mae']:.3f} bias={val_score['bias']:+.3f} "
              f"trees={model.num_boosted_rounds()}", flush=True)
        if best_stats is None or (val_score['rmse'], val_score['mae']) < (
                best_stats['validation']['rmse'], best_stats['validation']['mae']):
            best_stats = stat
            best_model = model
            best_model.save_model(str(output / 'xgboost_tuned_best.json'))

    baseline_val = metrics(ys['validation'], benchmark.predict(dval))
    results.sort(key=lambda d: d['validation']['rmse'])
    report = {
        'experiment': '2024 ERC-G XGBoost random search',
        'selection_data': 'September 2024 validation only',
        'test_set_used': False,
        'features': features,
        'sizes': {s: len(ys[s]) for s in xs},
        'original_v1_validation': baseline_val,
        'best_tuned': best_stats,
        'tuned_beats_v1_by_rmse': best_stats['validation']['rmse'] < baseline_val['rmse'],
        'trials': results,
        'limitations': [
            '2024 test was previously examined; use a fresh year for final unbiased evaluation.',
            'Same-day observed weather surrogates ERC-G; this does not validate 7-day forecast performance.',
            'Spatially correlated grid cells; geographically blocked and out-of-year tests remain necessary.',
            'Hyperparameter tuning does not solve missing lagged fuel-moisture features.',
        ],
    }
    with (output / 'tuning_results.json').open('w') as f:
        json.dump(report, f, indent=2)
    with (output / 'tuning_results.csv').open('w', newline='') as f:
        columns = ['trial','max_depth','eta','min_child_weight','subsample',
                   'colsample_bytree','reg_lambda','reg_alpha','best_iteration',
                   'train_rmse','val_rmse','val_mae','val_bias','val_p95_abs_error','duration_seconds']
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        for r in results:
            writer.writerow({
                'trial':r['trial'], **r['params'], 'best_iteration':r['best_iteration'],
                'train_rmse':r['train']['rmse'], 'val_rmse':r['validation']['rmse'],
                'val_mae':r['validation']['mae'], 'val_bias':r['validation']['bias'],
                'val_p95_abs_error':r['validation']['p95_abs_error'],
                'duration_seconds':r['duration_seconds'],
            })
    print('\n=== SUMMARY ===')
    print('Original V1 validation:', baseline_val)
    print('Best tuned validation:', best_stats['validation'])
    print('Best tuned params:', best_stats['params'])
    print('Tuned beats V1 by validation RMSE:', report['tuned_beats_v1_by_rmse'])
    print('Saved model:', output / 'xgboost_tuned_best.json')
    print('Saved report:', output / 'tuning_results.json')
    print('Saved comparison:', output / 'tuning_results.csv')


if __name__ == '__main__':
    run()
