#!/usr/bin/env python3
"""Native XGBoost TreeSHAP for FireWatch V6 (no shap/sklearn installation).

Samples held-out July--December 2025 observations without training or modifying
any model. Produces global mean absolute SHAP and per-row explanations.
"""
import argparse
import csv
import json
import math
import random
from pathlib import Path

import numpy as np
import xgboost as xgb

DEFAULT_FEATURES = [
    'temp_max_c', 'rh_min_pct', 'wind_mean_ms', 'precip_mm',
    'elevation_mean_m', 'lat', 'lon', 'day_sin', 'day_cos',
    'precip_7d_mm', 'precip_30d_mm', 'temp_mean_7d_c',
    'rh_mean_7d_pct', 'dry_days_14d', 'wind_mean_7d_ms'
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, default=Path('models/firewatch_erc_multiyear_v6/model.json'))
    parser.add_argument('--data', type=Path, default=Path('data/processed/erc_weather_2025_lagged_multiyear.csv'))
    parser.add_argument('--outdir', type=Path, default=Path('models/firewatch_erc_multiyear_v6/shap'))
    parser.add_argument('--sample', type=int, default=1200)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()

    if args.sample < 1 or args.threads < 1:
        parser.error('--sample and --threads must be positive')
    if not args.model.is_file() or not args.data.is_file():
        parser.error(f'Missing model or data: {args.model} / {args.data}')

    model = xgb.Booster(params={'nthread': args.threads})
    model.load_model(str(args.model))
    features = model.feature_names or DEFAULT_FEATURES
    if len(features) != 15:
        raise ValueError(f'Expected 15 V6 features, found {len(features)}: {features}')

    rng = random.Random(args.seed)
    sampled = []
    eligible = 0
    with args.data.open(newline='') as f:
        reader = csv.DictReader(f)
        required = set(features) | {'cell_id', 'date', 'target_erc'}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f'Missing CSV columns: {sorted(missing)}')
        for row in reader:
            # Match the 2025 H2 temporal-test dates, not 2025 H1 validation.
            day = row['date']
            if not ('2025-07-01' <= day <= '2025-12-31'):
                continue
            vals = [float(row[k]) for k in features]
            target = float(row['target_erc'])
            if not (np.isfinite(vals).all() and math.isfinite(target)):
                continue
            eligible += 1
            record = (day, row['cell_id'], target, vals)
            if len(sampled) < args.sample:
                sampled.append(record)
            else:
                idx = rng.randrange(eligible)
                if idx < args.sample:
                    sampled[idx] = record
    if not sampled:
        raise RuntimeError('No eligible July--December 2025 rows')

    X = np.asarray([r[3] for r in sampled], dtype=np.float32)
    dm = xgb.DMatrix(X, feature_names=list(features))
    predictions = model.predict(dm)
    contributions = model.predict(dm, pred_contribs=True, approx_contribs=False)
    if contributions.shape != (len(sampled), len(features) + 1):
        raise RuntimeError(f'Unexpected SHAP shape {contributions.shape}')
    reconstructed = contributions.sum(axis=1)
    discrepancy = float(np.max(np.abs(predictions - reconstructed)))
    if not np.allclose(predictions, reconstructed, rtol=1e-4, atol=1e-3):
        raise AssertionError(f'SHAP additivity failed: max difference {discrepancy}')

    args.outdir.mkdir(parents=True, exist_ok=True)
    importance = np.mean(np.abs(contributions[:, :-1]), axis=0)
    signed = np.mean(contributions[:, :-1], axis=0)
    ordering = np.argsort(-importance)
    with (args.outdir / 'global_shap_importance.csv').open('w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['feature', 'mean_abs_shap_erc', 'mean_signed_shap_erc'])
        for idx in ordering:
            writer.writerow([features[idx], f'{importance[idx]:.6f}', f'{signed[idx]:.6f}'])

    with (args.outdir / 'sample_shap_explanations.csv').open('w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['date', 'cell_id', 'actual_erc', 'predicted_erc', 'base_value_erc',
                         *[f'shap_{name}' for name in features]])
        for i, (day, cell, actual, _) in enumerate(sampled):
            writer.writerow([day, cell, f'{actual:.6f}', f'{predictions[i]:.6f}',
                             f'{contributions[i,-1]:.6f}',
                             *[f'{v:.6f}' for v in contributions[i,:-1]]])

    # Write simple portable HTML chart with no JS/CDN/network/dependency.
    max_imp = float(max(importance)) or 1.0
    lines = ['<!doctype html><html><head><meta charset="utf-8"><title>FireWatch V6 Native SHAP</title>',
             '<style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:0 18px}',
             '.r{display:grid;grid-template-columns:210px 1fr 90px;align-items:center;gap:12px;margin:10px 0}',
             '.bar{height:18px;background:#eef0f2;border-radius:4px;overflow:hidden}',
             '.fill{height:100%;background:#e77532}small{color:#666}</style></head><body>',
             '<h1>FireWatch V6 — Native SHAP Importance</h1>',
             f'<p>Held-out July–December 2025 sample, n={len(sampled):,}. Units: ERC-G index points.</p>',
             '<p><small>Mean absolute SHAP indicates magnitude of model contribution, not causality.</small></p>']
    import html
    for idx in ordering:
        width = 100.0 * float(importance[idx]) / max_imp
        lines.append(f'<div class="r"><span>{html.escape(features[idx])}</span><div class="bar"><div class="fill" style="width:{width:.2f}%"></div></div><strong>{importance[idx]:.2f}</strong></div>')
    lines.append('</body></html>')
    (args.outdir / 'shap_importance.html').write_text('\n'.join(lines))

    # Explain examples from low, medium, and high model outputs (prediction bins).
    sorted_ids = np.argsort(predictions)
    chosen = list(dict.fromkeys([int(sorted_ids[0]), int(sorted_ids[len(sorted_ids)//2]), int(sorted_ids[-1])]))
    explanations = []
    for i in chosen:
        top = np.argsort(-np.abs(contributions[i, :-1]))[:5]
        explanations.append({
            'date': sampled[i][0], 'cell_id': sampled[i][1],
            'actual_erc': float(sampled[i][2]), 'predicted_erc': float(predictions[i]),
            'base_value': float(contributions[i,-1]),
            'top_5_contributions': [{'feature': features[j], 'shap_erc': float(contributions[i,j]),
                                     'feature_value': float(X[i,j])} for j in top]
        })
    summary = {'model': str(args.model), 'data': str(args.data),
               'source_period': '2025-07-01 through 2025-12-31',
               'eligible_rows': eligible, 'sample_size': len(sampled), 'seed': args.seed,
               'features': list(features), 'shap_additivity_max_absolute_error': discrepancy,
               'mean_predicted_erc': float(predictions.mean()),
               'mean_actual_erc': float(np.mean([r[2] for r in sampled])),
               'examples': explanations,
               'caveats': ['Explains ERC-G regression, not wildfire ignition probability.',
                           'TreeSHAP attribution is not proof of causality.',
                           'Data is retrospective observed-weather evaluation, not 7-day forecast verification.',
                           '2025 H2 has previously been inspected; not a pristine holdout.']}
    (args.outdir / 'shap_summary.json').write_text(json.dumps(summary, indent=2))

    print(f'Model: {args.model}')
    print(f'2025 H2 eligible: {eligible:,}; sampled: {len(sampled):,}')
    print(f'SHAP additivity max error: {discrepancy:.7f} ERC units')
    print('GLOBAL SHAP RANKING (mean |SHAP|, ERC-G units):')
    for idx in ordering:
        print(f'  {features[idx]:24s} {importance[idx]:8.3f}')
    print('\nExamples (SHAP values add to the prediction):')
    for ex in explanations:
        print(f"  {ex['date']} {ex['cell_id']} prediction={ex['predicted_erc']:.2f}, actual={ex['actual_erc']:.2f}, baseline={ex['base_value']:.2f}")
        for entry in ex['top_5_contributions']:
            print(f"    {entry['feature']:24s} {entry['shap_erc']:+8.2f}")
    print(f'Files saved in: {args.outdir}')


if __name__ == '__main__':
    main()
