"""Prepare two bounded, real CSV snapshots; never alter the source datasets.

Run from frontend: python scripts/prepare_hotspots.py
Read-only verification: python scripts/prepare_hotspots.py --check
"""
import argparse
import collections
import csv
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

FRONTEND = Path(__file__).resolve().parents[1]
OUTPUT = FRONTEND / 'public' / 'data' / 'historical'
SOURCES = [
    'FireWatch_California_VIIRS_SNPP_2024_StateBoundary.csv',
    'FireWatch_California_VIIRS_SNPP_2025.csv',
]


def number(value):
    if value is None or not value.strip():
        return None
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('Non-finite measurement')
    return result


def make_snapshot(path):
    with path.open(encoding='utf-8-sig', newline='') as stream:
        rows = list(csv.DictReader(stream))
    counts = collections.Counter(row['acq_date'] for row in rows)
    # Highest count, earliest date on a tie: reproducible and documented selection.
    selected_date = min(counts, key=lambda day: (-counts[day], day))
    features = []
    for source_row, row in enumerate(rows, start=2):
        if row['acq_date'] != selected_date:
            continue
        lat, lon = number(row['latitude']), number(row['longitude'])
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError(f'Invalid coordinates: {path.name}:{source_row}')
        raw_time = row['acq_time'].strip()
        if not raw_time.isdigit() or len(raw_time) > 4:
            raise ValueError(f'Invalid acquisition time: {path.name}:{source_row}')
        clock = raw_time.zfill(4)
        observed = datetime.strptime(f'{selected_date} {clock}', '%Y-%m-%d %H%M').replace(tzinfo=timezone.utc)
        frp = number(row.get('frp'))
        if frp is not None and frp < 0:
            raise ValueError(f'Negative FRP: {path.name}:{source_row}')
        features.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
            'properties': {
                'id': f'{path.stem}:{source_row}',
                'detected_at': observed.isoformat(timespec='seconds').replace('+00:00', 'Z'),
                'satellite': row['satellite'],
                'instrument': row['instrument'],
                'frp_mw': frp,
                'confidence': row.get('confidence') or None,
                'is_fixture': False,
                'bright_ti4_k': number(row.get('bright_ti4')),
                'bright_ti5_k': number(row.get('bright_ti5')),
                'scan_km': number(row.get('scan')),
                'track_km': number(row.get('track')),
                'daynight': row.get('daynight') or None,
                'source_type': row.get('type') or None,
                'version': row.get('version') or None,
                'source_row': source_row,
            },
        })
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {
        'type': 'FeatureCollection',
        'features': features,
        'metadata': {
            'source': 'NASA FIRMS (team-supplied CSV)',
            'sensor': 'VIIRS_SNPP',
            # Original download/refresh time is absent from the CSV. Do not invent it.
            'updated_at': None,
            'is_fixture': False,
            'source_file': path.name,
            'source_sha256': digest,
            'source_rows': len(rows),
            'selected_date': selected_date,
            'feature_count': len(features),
            'selection': 'All observations on the busiest UTC date in this source file; earliest date breaks ties. No observation-type filtering or deduplication.',
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Verify committed outputs without writing anything')
    args = parser.parse_args()
    outputs = {}
    snapshots = []
    for filename in SOURCES:
        snapshot = make_snapshot(FRONTEND.parent / filename)
        metadata = snapshot['metadata']
        date = metadata['selected_date']
        output_name = f'viirs-snpp-{date}.geojson'
        outputs[output_name] = snapshot
        snapshots.append({
            'date': date,
            'file': output_name,
            'count': metadata['feature_count'],
            'source_file': filename,
            'source_sha256': metadata['source_sha256'],
        })
        print(f"{date}: {metadata['feature_count']} of {metadata['source_rows']} source rows; all rows on selected date")
    outputs['manifest.json'] = {'snapshots': snapshots}
    for name, value in outputs.items():
        content = json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False) + '\n'
        path = OUTPUT / name
        if args.check:
            if not path.is_file() or path.read_text(encoding='utf-8') != content:
                raise SystemExit(f'Generated output mismatch: {path}')
            print(f'VERIFIED {name}: {len(content.encode())} bytes')
        else:
            OUTPUT.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding='utf-8', newline='\n')
            print(f'WROTE {name}: {len(content.encode())} bytes')


if __name__ == '__main__':
    main()
