"""Experimental multicell seven-day ERC-G weather forecasts and exact TreeSHAP.

Reuses the original frozen XGBoost model and the validated per-cell Open-Meteo
weather-feature probe. Publishes only complete, verified seven-day cell series.
The latest accepted snapshot is retained when the minimum coverage gate fails.
"""
from __future__ import annotations

import csv
import fcntl
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xgboost as xgb

ROOT = Path(__file__).resolve().parents[2]
GRID_ROOT = Path('/home/linux1/firewatch/data/raw')
GRID = GRID_ROOT / 'california_3km_grid_lookup.csv'
ELEVATION = GRID_ROOT / 'california_3km_elevation_mean_FILLED.csv'
PROBE = Path.home() / 'firewatch_v6_live_starter/stockton_live_v6.py'
DATA = ROOT / 'shared/data/erc-v6'
MODEL_DIR = ROOT / 'ml-prep/models/releases/firewatch_erc_v6_2023_2025'
MODEL = MODEL_DIR / 'model.json'
FEATURES_JSON = MODEL_DIR / 'features.json'
SHA = 'cb124badd47c898448c30500fe13f4827481e1986bd2a776605a0b99308b2e33'
MODEL_VERSION = 'firewatch_erc_v6_2023_2025'
FEATURES = (
    'temp_max_c', 'rh_min_pct', 'wind_mean_ms', 'precip_mm',
    'elevation_mean_m', 'lat', 'lon', 'day_sin', 'day_cos',
    'precip_7d_mm', 'precip_30d_mm', 'temp_mean_7d_c',
    'rh_mean_7d_pct', 'dry_days_14d', 'wind_mean_7d_ms',
)
STOCKTON = 'CA3K_X-0038_Y-0002'
# Representative California geography, not fixed IDs or synthetic scores.
# The closest qualifying canonical land grid cell is located at runtime.
TARGETS = (
    ('Stockton, CA', 37.969042, -121.282320),
    ('San Diego, CA', 32.7157, -117.1611),
    ('Los Angeles, CA', 34.0522, -118.2437),
    ('Santa Barbara, CA', 34.4208, -119.6982),
    ('Palm Springs, CA', 33.8303, -116.5453),
    ('Bakersfield, CA', 35.3733, -119.0187),
    ('Fresno, CA', 36.7378, -119.7871),
    ('Monterey, CA', 36.6002, -121.8947),
    ('San Jose, CA', 37.3382, -121.8863),
    ('Sacramento, CA', 38.5816, -121.4944),
    ('Santa Rosa, CA', 38.4404, -122.7141),
    ('Chico, CA', 39.7285, -121.8375),
    ('Redding, CA', 40.5865, -122.3917),
    ('Eureka, CA', 40.8021, -124.1637),
    ('South Lake Tahoe, CA', 38.9399, -119.9772),
    ('Yreka, CA', 41.7354, -122.6345),
    ('El Centro, CA', 32.792, -115.5631),
    ('San Luis Obispo, CA', 35.2828, -120.6596),
)


def choose_cells():
    with ELEVATION.open(newline='') as f:
        elevations = {
            r['cell_id']: float(r['elevation_mean_m'])
            for r in csv.DictReader(f)
            if r.get('elevation_mean_m')
        }
    cells = []
    with GRID.open(newline='') as f:
        for r in csv.DictReader(f):
            cid = r['cell_id']
            elev = elevations.get(cid)
            if elev is None or not math.isfinite(elev):
                continue
            lat, lon = float(r['center_lat']), float(r['center_lon'])
            if not all(map(math.isfinite, (lat, lon))):
                continue
            cells.append((cid, lat, lon, elev, float(r['land_fraction'])))

    selected = []
    seen = set()
    for name, lat, lon in TARGETS:
        if name.startswith('Stockton'):
            matches = [c for c in cells if c[0] == STOCKTON]
            if not matches:
                raise RuntimeError('Verified Stockton cell is missing from grid/elevation join')
            chosen = matches[0]
        else:
            # Scale longitude into approximate local kilometres before comparing.
            candidates = [c for c in cells if c[4] >= 0.5 and c[0] not in seen]
            chosen = min(
                candidates,
                key=lambda c: ((c[1]-lat)*111)**2 +
                ((c[2]-lon)*111*math.cos(math.radians(lat)))**2,
            )
            distance_km = math.sqrt(
                ((chosen[1]-lat)*111)**2 +
                ((chosen[2]-lon)*111*math.cos(math.radians(lat)))**2
            )
            if distance_km > 30:
                print(f'SKIP {name}: nearest land cell {distance_km:.1f}km away', flush=True)
                continue
        if chosen[0] in seen:
            continue
        seen.add(chosen[0])
        selected.append((name, *chosen[:4]))
    return selected


def run_probe(name, cell_id, lat, lon, elev, folder):
    target = Path(folder) / (cell_id.replace('+', 'p').replace('-', 'm') + '.json')
    cmd = [
        sys.executable, str(PROBE), '--model', str(MODEL),
        '--features-json', str(FEATURES_JSON), '--cell-id', cell_id,
        '--latitude', str(lat), '--longitude', str(lon),
        '--elevation-m', str(elev), '--output', str(target),
    ]
    for attempt in range(2):
        try:
            subprocess.run(cmd, check=True, timeout=180, capture_output=True, text=True)
            data = json.loads(target.read_text())
            if data.get('model_sha256') != SHA or data.get('model_version') != MODEL_VERSION:
                raise ValueError('Wrong frozen model provenance')
            rows = data.get('predictions')
            if not isinstance(rows, list) or len(rows) != 7:
                raise ValueError('Incomplete 7-day forecast')
            if set(r.get('lead_day') for r in rows) != set(range(1, 8)):
                raise ValueError('Missing or duplicate lead days')
            if len({r.get('valid_date') for r in rows}) != 7:
                raise ValueError('Duplicate forecast dates')
            for row in rows:
                feat = row.get('features')
                if (row.get('cell_id') != cell_id or row.get('data_status') != 'ok'
                        or not isinstance(feat, dict) or tuple(feat) != FEATURES):
                    raise ValueError('Invalid source cell/features')
                if any(type(v) not in (float, int) or not math.isfinite(v) for v in feat.values()):
                    raise ValueError('Nonfinite feature')
                if abs(feat['lat']-lat) > 0.001 or abs(feat['lon']-lon) > 0.001:
                    raise ValueError('Probe returned mismatched coordinates')
                if abs(feat['elevation_mean_m']-elev) > 0.05:
                    raise ValueError('Probe returned mismatched elevation')
                if (row.get('erc_g_raw') is None or
                        not math.isfinite(row['erc_g_raw']) or
                        abs(row['erc_g_display']-max(0, row['erc_g_raw'])) > 1e-5):
                    raise ValueError('Nonfinite or invalid ERC-G result')
            print(f'OK {name:<24} {cell_id} (7 days)', flush=True)
            return rows
        except Exception as exc:
            print(f'WARN {name} attempt {attempt+1}: {exc}', flush=True)
            if attempt == 0:
                time.sleep(3)
    return None


def atomic_json(path, obj):
    fd, temp = tempfile.mkstemp(prefix='.pending-', suffix='.json', dir=DATA)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(obj, f, allow_nan=False, separators=(',', ':'))
            f.flush()
            os.fsync(f.fileno())
        os.chmod(temp, 0o644)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def main():
    if hashlib.sha256(MODEL.read_bytes()).hexdigest() != SHA:
        raise RuntimeError('Frozen model digest mismatch')
    selected = choose_cells()
    print(f'Forecast targets: {len(selected)} canonical California cells', flush=True)
    rows, names, failed = [], {}, []
    with tempfile.TemporaryDirectory(prefix='fw-v6-multicell-') as folder:
        for name, cell_id, lat, lon, elev in selected:
            predictions = run_probe(name, cell_id, lat, lon, elev, folder)
            if predictions is None:
                failed.append(name)
            else:
                names[cell_id] = name
                rows.extend(predictions)
            time.sleep(1.2)  # Be considerate of public Open-Meteo endpoints.

    if STOCKTON not in names or len(names) < 5:
        raise RuntimeError(
            f'Coverage gate failed ({len(names)} successful cells, Stockton required). '
            'Existing published forecast left untouched.'
        )
    rows.sort(key=lambda r: (r['cell_id'], r['lead_day']))

    booster = xgb.Booster()
    booster.load_model(str(MODEL))
    values = np.array([[r['features'][k] for k in FEATURES] for r in rows], dtype=np.float32)
    dm = xgb.DMatrix(values, feature_names=list(FEATURES))
    predictions = booster.predict(dm)
    contributions = booster.predict(dm, pred_contribs=True)
    explanations = []
    for row, predicted, contrib in zip(rows, predictions, contributions):
        predicted = float(predicted)
        baseline = float(contrib[-1])
        shap = [float(v) for v in contrib[:-1]]
        err = abs(baseline + sum(shap) - predicted)
        if err > 1e-3 or abs(predicted-row['erc_g_raw']) > 1e-3:
            raise RuntimeError(f'Model/SHAP verification failed: {row["cell_id"]} {row["valid_date"]}')
        explanations.append({
            'cell_id': row['cell_id'], 'valid_date': row['valid_date'],
            'metric': 'ERC-G', 'model_version': MODEL_VERSION,
            'prediction_raw': predicted, 'prediction_display': max(0, predicted),
            'baseline': baseline,
            'features': [{'name': k, 'value': row['features'][k], 'shap_value': shap[i]}
                         for i, k in enumerate(FEATURES)],
            'additivity_error': err, 'data_status': 'ok',
            'explanation_type': 'TreeSHAP', 'forecast_skill_validated': False,
        })

    now = datetime.now(timezone.utc).isoformat()
    digest = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()[:16]
    snapshot_id = f'multicell-v6-{digest}'
    snapshot = {
        'snapshot_id': snapshot_id,
        'kind': 'experimental_multicell_weather_driven_erc_g_probe',
        'model_version': MODEL_VERSION, 'model_sha256': SHA,
        'provider': 'Open-Meteo forecast + archive',
        'provider_issue_time_utc': None,
        'retrieved_at_utc': now,
        'temporal_resolution': 'daily', 'metric': 'ERC-G',
        'publication_mode': 'automated_multicell_snapshot',
        'forecast_skill_validated': False, 'official_danger_categories': False,
        'cell_names': names, 'failed_targets': failed,
        'predictions': rows,
    }
    explanation_bundle = {
        'snapshot_id': snapshot_id, 'model_sha256': SHA,
        'explanations': [{**e, 'snapshot_id': snapshot_id} for e in explanations],
    }
    DATA.mkdir(parents=True, exist_ok=True)
    DATA.chmod(0o755)
    # Versioned immutable archives, then publish explanations BEFORE forecast pointer.
    # A reader may temporarily receive 503 rather than a mismatched explanation.
    atomic_json(DATA / f'snapshot-{digest}.json', snapshot)
    atomic_json(DATA / f'shap-{digest}.json', explanation_bundle)
    atomic_json(DATA / 'explanations-current.json', explanation_bundle)
    atomic_json(DATA / 'current.json', snapshot)
    print(f'PUBLISHED: {len(names)} cells / {len(rows)} forecasts / '
          f'{len(explanations)} TreeSHAP explanations', flush=True)
    print(f'SNAPSHOT: {snapshot_id}', flush=True)
    if failed:
        print('UNAVAILABLE: ' + ', '.join(failed), flush=True)


if __name__ == '__main__':
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        with (DATA / '.multicell.lock').open('a+') as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('Another multicell refresh is already running') from None
            main()
    except Exception as exc:
        print(f'MULTICELL REFRESH FAILED: {exc}', file=sys.stderr, flush=True)
        sys.exit(1)
