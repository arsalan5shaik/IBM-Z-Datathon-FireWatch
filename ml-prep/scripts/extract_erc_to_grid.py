import argparse
import csv
import json
import re
from datetime import date
from pathlib import Path

import h5netcdf
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('--start', default='2024-07-20')
parser.add_argument('--end', default='2024-07-26')
parser.add_argument('--erc-file', default='data/raw/erc/erc_2024.nc')
parser.add_argument('--output', default='data/processed/erc_grid_2024_pilot.csv')
args = parser.parse_args()
start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
if end < start:
    raise ValueError('End date must be on or after start date')

def nearest(axis, values):
    reverse = axis[0] > axis[-1]
    ordered = axis[::-1] if reverse else axis
    if not np.all(np.diff(ordered) > 0):
        raise ValueError('Source coordinate axis is not strictly monotonic')
    right = np.searchsorted(ordered, values)
    high = np.clip(right, 0, len(ordered)-1)
    low = np.clip(right-1, 0, len(ordered)-1)
    picked = np.where(abs(ordered[low]-values) <= abs(ordered[high]-values),low,high)
    return (len(axis)-1-picked) if reverse else picked

raw = Path('data/raw')
with (raw/'california_3km_grid_lookup.csv').open(newline='') as f:
    cells = list(csv.DictReader(f))
assert len({r['cell_id'] for r in cells}) == len(cells), 'Duplicate grid IDs'
with (raw/'california_3km_elevation_mean_FILLED.csv').open(newline='') as f:
    elevations = {r['cell_id']:r['elevation_mean_m'] for r in csv.DictReader(f)}

lat = np.array([float(r['center_lat']) for r in cells])
lon = np.array([float(r['center_lon']) for r in cells])
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)

with h5netcdf.File(args.erc_file, 'r', backend='pyfive') as ds:
    var = ds.variables['energy_release_component-g']
    assert var.dimensions == ('day', 'lat', 'lon'), var.dimensions
    source_lats = np.asarray(ds.variables['lat'][:], dtype=float)
    source_lons = np.asarray(ds.variables['lon'][:], dtype=float)
    grid_lon = lon + 360 if source_lons.min() >= 0 and source_lons.max() > 180 else lon
    i = nearest(source_lats, lat)
    j = nearest(source_lons, grid_lon)
    # Don't silently snap cells outside the NetCDF's geographical extent.
    in_domain = ((lat >= source_lats.min()) & (lat <= source_lats.max()) &
                 (grid_lon >= source_lons.min()) & (grid_lon <= source_lons.max()))

    time_units = str(ds.variables['day'].attrs['units'])
    found = re.search(r'since\s+(\d{4}-\d{2}-\d{2})', time_units)
    if not found:
        raise ValueError('Unsupported date units: '+time_units)
    origin = date.fromisoformat(found.group(1))
    day_coords = np.asarray(ds.variables['day'][:], dtype=float)
    fill = [float(np.asarray(var.attrs[k]).flat[0]) for k in
            ('_FillValue', 'missing_value') if k in var.attrs]
    scale = float(np.asarray(var.attrs.get('scale_factor',1)).flat[0])
    offset = float(np.asarray(var.attrs.get('add_offset',0)).flat[0])
    print('Original grid cells:',len(cells))
    print('Distinct matched ERC raster pixels:',len(set(zip(i[in_domain],j[in_domain]))))
    print('Grid centers outside source extent:',int((~in_domain).sum()))
    total_valid = total_missing = days = 0
    with output.open('w',newline='') as f:
        writer=csv.writer(f)
        writer.writerow(['cell_id','local_date','center_lat','center_lon',
                         'elevation_mean_m','target_erc','erc_source_lat','erc_source_lon'])
        current=start
        from datetime import timedelta
        while current<=end:
            delta=(current-origin).days
            matching=np.flatnonzero(np.isclose(day_coords, delta, atol=1e-5,rtol=0))
            if len(matching)!=1:
                raise ValueError('Missing/ambiguous ERC date: '+str(current))
            t=int(matching[0])
            ii=i[in_domain]; jj=j[in_domain]
            i0,i1=int(ii.min()),int(ii.max())+1
            j0,j1=int(jj.min()),int(jj.max())+1
            tile=np.asarray(var[t,i0:i1,j0:j1])
            raw_values=tile[i[in_domain]-i0,j[in_domain]-j0]
            decoded=raw_values.astype(float)*scale+offset
            missing=~np.isfinite(decoded)
            for bad in fill:
                missing |= raw_values == bad
            full_values=np.full(len(cells), np.nan)
            full_values[in_domain]=np.where(missing,np.nan,decoded)
            for k,r in enumerate(cells):
                val=full_values[k]
                writer.writerow([r['cell_id'],current.isoformat(),r['center_lat'],
                    r['center_lon'],elevations.get(r['cell_id'],'') ,
                    '' if np.isnan(val) else f'{val:.4f}',
                    f'{source_lats[i[k]]:.6f}' if in_domain[k] else '',
                    f'{source_lons[j[k]]:.6f}' if in_domain[k] else ''])
            valid=int(np.isfinite(full_values).sum())
            total_valid+=valid
            total_missing+=len(cells)-valid
            days+=1
            print(current,'valid:',valid,'missing:',len(cells)-valid,
                'ERC min/max:',
                (round(float(np.nanmin(full_values)),2),round(float(np.nanmax(full_values)),2))
                if valid else 'none')
            current+=timedelta(days=1)

metadata={'erc_file':str(args.erc_file),'variable':'energy_release_component-g',
          'fuel_model':'G','grid_file':str(raw/'california_3km_grid_lookup.csv'),
          'sample_method':'nearest source raster pixel at canonical cell centroid',
          'date_start':str(start),'date_end':str(end),
          'cells_per_day':len(cells),'days':days,
          'rows_with_target':total_valid,'rows_missing_target':total_missing,
          'raw_fill_values':fill,'scale_factor':scale,'add_offset':offset}
output.with_suffix('.metadata.json').write_text(json.dumps(metadata,indent=2))
print('Saved:',output)
print('Total valid target rows:',total_valid,'missing:',total_missing)
