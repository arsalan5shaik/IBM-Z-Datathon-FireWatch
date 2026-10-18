#!/usr/bin/env python3
"""FireWatch: authoritative grid compatibility + real gridMET ERC source gate.

Run on LinuxONE: python3.11 scripts/stage0_erc_gate.py
After manually downloading real erc_2024.nc:
  python3.11 scripts/stage0_erc_gate.py --inspect-erc
Does not train any model or invent ERC values.
"""
import argparse
import csv
import json
import math
import re
import subprocess
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] if Path(__file__).resolve().parent.name == 'scripts' else Path.home() / 'firewatch'
RAW = ROOT / 'data' / 'raw'
PROCESSED = ROOT / 'data' / 'processed'
GRID_PATH = RAW / 'california_3km_grid_lookup.csv'
ELEV_PATH = RAW / 'california_3km_elevation_mean_FILLED.csv'
HOTSPOT_PATH = PROCESSED / 'hotspot_cell_days_2024_2025.csv'
ERC_SOURCE = 'https://www.northwestknowledge.net/metdata/data/erc_2024.nc'
ERC_PATH = RAW / 'erc' / 'erc_2024.nc'


def must_have(path):
    if not path.is_file():
        raise FileNotFoundError(f'Missing required input: {path}')


def audit_local():
    for path in (GRID_PATH, ELEV_PATH, HOTSPOT_PATH):
        must_have(path)
    grid = {}
    bad_grid = []
    with GRID_PATH.open(newline='') as f:
        reader = csv.DictReader(f)
        expected = {'cell_id', 'grid_col', 'grid_row', 'center_lat', 'center_lon',
                    'west_m', 'south_m', 'east_m', 'north_m', 'land_fraction'}
        assert expected <= set(reader.fieldnames or []), f'Grid missing columns {expected-set(reader.fieldnames or [])}'
        for line, r in enumerate(reader, start=2):
            cid = r['cell_id']
            if cid in grid:
                raise ValueError(f'Duplicate grid ID at line {line}: {cid}')
            col, row = int(r['grid_col']), int(r['grid_row'])
            expected_id = f'CA3K_X{col:+05d}_Y{row:+05d}'
            xw, ys = float(r['west_m']), float(r['south_m'])
            xe, yn = float(r['east_m']), float(r['north_m'])
            lat, lon = float(r['center_lat']), float(r['center_lon'])
            lf = float(r['land_fraction'])
            valid = (cid == expected_id and xw == col*3000 and ys == row*3000 and
                     xe-xw == 3000 and yn-ys == 3000 and
                     30 <= lat <= 43 and -126 <= lon <= -113 and 0 <= lf <= 1)
            if not valid:
                bad_grid.append({'line': line, 'cell_id': cid})
            grid[cid] = r
    if bad_grid:
        raise ValueError(f'Invalid grid coordinate/ID/bounds rows: {bad_grid[:5]}')

    elevation = {}
    with ELEV_PATH.open(newline='') as f:
        reader = csv.DictReader(f)
        assert {'cell_id','elevation_mean_m'} <= set(reader.fieldnames or [])
        for r in reader:
            cid = r['cell_id']
            if cid in elevation:
                raise ValueError(f'Duplicate elevation ID: {cid}')
            elevation[cid] = r['elevation_mean_m'].strip()
    grid_ids, elev_ids = set(grid), set(elevation)
    if grid_ids != elev_ids:
        raise ValueError(f'Grid and elevation ID sets differ: grid-only={len(grid_ids-elev_ids)} elev-only={len(elev_ids-grid_ids)}')
    filled = sum(bool(v) for v in elevation.values())

    combined_count = 0
    per_year = Counter()
    distinct_active_cells = set()
    distinct_keys = set()
    bad_elev = 0
    with HOTSPOT_PATH.open(newline='') as f:
        reader = csv.DictReader(f)
        assert {'cell_id','observation_date','hotspot_detected','detection_count','elevation_mean_m'} <= set(reader.fieldnames or [])
        for r in reader:
            cid = r['cell_id']
            d = date.fromisoformat(r['observation_date'])
            if cid not in grid:
                raise ValueError(f'Hotspot references unknown grid ID: {cid}')
            key = (cid, d.isoformat())
            if key in distinct_keys:
                raise ValueError(f'Duplicate cell/day in hotspot history: {key}')
            distinct_keys.add(key)
            if r['hotspot_detected'] != '1' or int(r['detection_count']) < 1:
                raise ValueError(f'Invalid positive-observation row: {key}')
            v = r['elevation_mean_m'].strip()
            expected = elevation[cid]
            if (not v) != (not expected) or (v and expected and not math.isclose(float(v),float(expected),abs_tol=0.01)):
                bad_elev += 1
            combined_count += 1
            per_year[d.year] += 1
            distinct_active_cells.add(cid)
    if bad_elev:
        raise ValueError(f'{bad_elev} hotspot rows disagree with authoritative elevation')

    # Check 3 representative geographic centroid transforms using native PROJ.
    pts = list(grid.values())
    check_rows = [pts[0], pts[len(pts)//2], pts[-1]]
    coord_text = ''.join(f'{r["center_lat"]} {r["center_lon"]}\n' for r in check_rows)
    proj = subprocess.run(['cs2cs','-f','%.3f','EPSG:4326','EPSG:3310'],
                          input=coord_text, text=True, capture_output=True, check=True)
    coord_lines = proj.stdout.strip().splitlines()
    assert len(coord_lines) == len(check_rows), 'PROJ returned wrong number of coordinates'
    max_center_error_m = 0.0
    for r, line in zip(check_rows, coord_lines):
        x, y = (float(n) for n in line.split()[:2])
        center_x = (float(r['west_m']) + float(r['east_m']))/2
        center_y = (float(r['south_m']) + float(r['north_m']))/2
        error = math.hypot(x-center_x,y-center_y)
        max_center_error_m = max(max_center_error_m,error)
    if max_center_error_m > 2.0:
        raise ValueError(f'Sample grid center transformation error {max_center_error_m:.2f} m > 2 m')

    report = {
        'phase': 'compatibility_and_erc_gate',
        'grid': {'projection':'EPSG:3310', 'cell_width_m':3000, 'total_cells':len(grid),
                 'grid_id_format':'CA3K_X{grid_col:+05d}_Y{grid_row:+05d}',
                 'coordinate_check_sample_size':len(check_rows),
                 'max_center_transform_error_m':round(max_center_error_m,3),
                 'boundary':'PROVISIONAL, team approval outstanding'},
        'elevation': {'source':'NOAA ETOPO 2022 (not USGS 3DEP)', 'populated_cells':filled,
                      'missing_cells':len(elevation)-filled, 'join_id_coverage':'complete'},
        'satellite_history': {'positive_cell_days':combined_count, 'by_year':dict(per_year),
                              'unique_active_cells':len(distinct_active_cells),
                              'role_for_ERC_model':'independent retrospective validation only',
                              'satellite_gaps_require_separate_validation': True},
        'erc': {'historical_source':'University of Idaho gridMET ERC (NFDRS fuel model G)',
                'archive_2024':ERC_SOURCE, 'netcdf_inspection':'pending',
                'target_available_locally':ERC_PATH.exists()},
        'training_status':'BLOCKED: no validated daily ERC+weather training table yet',
        'api_status':'REQUIRES_CONTRACT_UPDATE: old hotspot probability != daily ERC danger',
    }
    PROCESSED.mkdir(parents=True,exist_ok=True)
    report_path = PROCESSED/'erc_compatibility_report.json'
    report_path.write_text(json.dumps(report,indent=2)+'\n')
    print('\n=== CANONICAL GRID & CSV COMPATIBILITY ===')
    print(f'Grid cells: {len(grid):,}; elevation populated: {filled:,}; missing: {len(elevation)-filled:,}')
    print(f'Sampled PROJ center error: {max_center_error_m:.3f} m (3 sampled cells)')
    print(f'Positive satellite cell/days: {combined_count:,}; by year: {dict(per_year)}')
    print(f'Unique satellite-active cells: {len(distinct_active_cells):,}')
    print(f'Saved audit: {report_path}')
    print('PASS: Existing hotspot/elevation/grid IDs align. NOT YET VERIFIED: future grid, weather, ERC joining.')
    return report, grid


def decode_days(units, values):
    s = units.decode('utf-8') if isinstance(units,bytes) else str(units)
    m = re.match(r'^days? since (\d{4}-\d{2}-\d{2})', s.strip(), re.I)
    if not m:
        raise ValueError(f'Unexpected time units: {s!r}. Inspect manually.')
    origin = date.fromisoformat(m.group(1))
    return [origin+timedelta(days=float(v)) for v in values]


def inspect_erc(grid):
    must_have(ERC_PATH)
    with ERC_PATH.open('rb') as f:
        magic = f.read(8)
    print('\n=== ERC NETCDF FEASIBILITY GATE ===')
    print('File:', ERC_PATH, 'Size:', f'{ERC_PATH.stat().st_size/1048576:.2f} MiB')
    print('First 8 bytes:', repr(magic))
    if not magic.startswith(b'CDF'):
        print('This may be NetCDF4/HDF5; SciPy native netcdf_file supports classic NetCDF only.')
        print('Inspect with `ncdump -h` or a supported NetCDF4 reader; do NOT fabricate values.')
        return False
    import numpy as np
    from scipy.io import netcdf_file
    with netcdf_file(str(ERC_PATH), mmap=False) as nc:
        print('Dimensions:', nc.dimensions)
        print('Variables:', list(nc.variables))
        required = {'erc','lat','lon','day'}
        if not required <= set(nc.variables):
            print('Expected variables absent:', sorted(required-set(nc.variables)))
            print('Inspect actual metadata and adapt reader before training.')
            return False
        var = nc.variables['erc']
        print('ERC dimensions:',var.dimensions, 'shape:',var.shape)
        print('ERC units:',getattr(var,'units',None))
        print('ERC long_name:',getattr(var,'long_name',None))
        print('ERC scale_factor:',getattr(var,'scale_factor',None), 'add_offset:',getattr(var,'add_offset',None))
        print('ERC _FillValue:',getattr(var,'_FillValue',None))
        print('Day units:',getattr(nc.variables['day'],'units',None))
        if var.dimensions != ('day','lat','lon'):
            print('Dimension order differs; stop until reviewed.')
            return False
        dates = decode_days(getattr(nc.variables['day'],'units',None), nc.variables['day'][:])
        lats = np.asarray(nc.variables['lat'][:],dtype=float)
        lons = np.asarray(nc.variables['lon'][:],dtype=float)
        if lats.ndim != 1 or lons.ndim != 1:
            print('Coordinates are not simple 1D lat/lon; stop and inspect.')
            return False
        day_idx = [i for i,d in enumerate(dates) if date(2024,7,1)<=d<=date(2024,7,30)]
        if len(day_idx) < 10:
            print('Insufficient July 2024 days. Date coverage:',min(dates), max(dates))
            return False
        inland = [r for r in grid.values() if float(r['land_fraction']) >= 0.8 and
                  r['cell_id'] and r['center_lat'] and r['center_lon']]
        if len(inland)<10:
            print('Not enough interior land cells for sample')
            return False
        chosen = [inland[(i*(len(inland)-1))//11] for i in range(12)]
        outfile = PROCESSED/'erc_point_sample_2024.csv'
        factor = float(getattr(var,'scale_factor',1))
        offset = float(getattr(var,'add_offset',0))
        fill = getattr(var,'_FillValue',None)
        good = 0
        missing = 0
        with outfile.open('w',newline='') as out:
            w = csv.writer(out)
            w.writerow(['cell_id','source_day','grid_lat','grid_lon','source_lat','source_lon',
                        'target_erc','erc_source','source_fuel_model'])
            for r in chosen:
                lat, lon = float(r['center_lat']),float(r['center_lon'])
                li,lj = int(np.argmin(np.abs(lats-lat))),int(np.argmin(np.abs(lons-lon)))
                for di in day_idx:
                    raw = float(var[di,li,lj])
                    bad = not np.isfinite(raw) or (fill is not None and raw == float(fill))
                    val = '' if bad else raw*factor+offset
                    good += not bad
                    missing += bad
                    w.writerow([r['cell_id'],dates[di].isoformat(),lat,lon,
                                float(lats[li]),float(lons[lj]),val,
                                'gridMET_erc_2024','G_conifer_forest'])
        print('Source days:',min(dates), 'to',max(dates))
        print('Extracted rows:',good+missing, 'populated:',good, 'missing:',missing)
        print('Sample saved:',outfile)
        return good > 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--inspect-erc', action='store_true',help='Inspect previously downloaded erc_2024.nc and extract a small real sample')
    args = ap.parse_args()
    report, grid = audit_local()
    if args.inspect_erc:
        success = inspect_erc(grid)
        report['erc']['netcdf_inspection'] = 'sample_extracted' if success else 'needs_reader_or_metadata_review'
        (PROCESSED/'erc_compatibility_report.json').write_text(json.dumps(report,indent=2)+'\n')
        print('ERC sample gate:', 'PASS' if success else 'INCOMPLETE')

if __name__ == '__main__':
    main()
