#!/usr/bin/env python3
"""Audit historical statewide 3-km FireWatch ERC-G inference against gridMET ERC-G.

Uses same nearest gridMET pixel mapping as firewatch_statewide_3km_inference.py.
This is a one-date retrospective ERC reconstruction audit, NOT fire occurrence
or operational forecast validation. No scikit-learn needed.
"""
import argparse
import csv
import json
from collections import defaultdict
from datetime import date
from pathlib import Path

import h5netcdf
import numpy as np


def stats(y, p):
    y=np.asarray(y,dtype=np.float64);p=np.asarray(p,dtype=np.float64)
    if not len(y):return None
    e=p-y
    sst=float(np.sum((y-y.mean())**2))
    return dict(n=len(y),r2=float(1-np.sum(e**2)/sst) if sst>0 else None,
                mae=float(np.mean(np.abs(e))),rmse=float(np.sqrt(np.mean(e**2))),
                bias=float(np.mean(e)),p95_absolute_error=float(np.percentile(np.abs(e),95)),
                observed_mean=float(y.mean()),predicted_mean=float(p.mean()))


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--date', default='2025-07-09')
    ap.add_argument('--root',type=Path,default=Path.home()/'firewatch')
    ap.add_argument('--output',type=Path,default=None)
    args=ap.parse_args()
    day=date.fromisoformat(args.date);root=args.root.expanduser().resolve()
    grid_path=root/'data/raw/california_3km_grid_lookup.csv'
    prediction_path=root/f'data/map_3km/firewatch_erc_3km_{day}.csv'
    erc_path=root/f'data/raw/erc/erc_{day.year}.nc'
    for path in (grid_path,prediction_path,erc_path):
        if not path.exists():raise FileNotFoundError(str(path))

    with grid_path.open(newline='') as f:grid=list(csv.DictReader(f))
    with prediction_path.open(newline='') as f:predict=list(csv.DictReader(f))
    ids=[r['cell_id'] for r in grid];pids=[r['cell_id'] for r in predict]
    if len(ids)!=len(set(ids)) or len(pids)!=len(set(pids)) or set(ids)!=set(pids):
        raise ValueError('Grid and prediction cell IDs do not match exactly')
    by_id={r['cell_id']:r for r in predict}
    ordered=[by_id[i] for i in ids]
    cell_lat=np.array([float(r['center_lat']) for r in grid],dtype=np.float64)
    cell_lon=np.array([float(r['center_lon']) for r in grid],dtype=np.float64)

    with h5netcdf.File(str(erc_path),'r',backend='pyfive') as ds:
        lats=np.asarray(ds.variables['lat'][:]);lons=np.asarray(ds.variables['lon'][:]);days=np.asarray(ds.variables['day'][:])
        units=str(ds.variables['day'].attrs.get('units',''))
        if 'days since 1900-01-01' not in units:raise ValueError('Unexpected ERC day units: '+units)
        required=(day-date(1900,1,1)).days
        matches=np.flatnonzero(days==required)
        if len(matches)!=1:raise ValueError(f'ERC date {day} missing/duplicate')
        match_lon=np.mod(cell_lon,360) if lons.max()>180 else cell_lon
        inside=(cell_lat>=lats.min())&(cell_lat<=lats.max())&(match_lon>=lons.min())&(match_lon<=lons.max())
        ilat=np.abs(lats[:,None]-cell_lat).argmin(axis=0)
        ilon=np.abs(lons[:,None]-match_lon).argmin(axis=0)
        var=ds.variables['energy_release_component-g']
        imin,imax=int(ilat.min()),int(ilat.max())+1
        jmin,jmax=int(ilon.min()),int(ilon.max())+1
        raw=np.asarray(var[int(matches[0]):int(matches[0])+1,imin:imax,jmin:jmax])[0]
        samples=raw[ilat-imin,ilon-jmin].astype(np.float64)
        bad=~np.isfinite(samples)
        for name in ('_FillValue','missing_value'):
            if name in var.attrs:
                for v in np.asarray(var.attrs[name]).reshape(-1):bad|=samples==float(v)
        scale=float(np.asarray(var.attrs.get('scale_factor',1)).reshape(-1)[0])
        offset=float(np.asarray(var.attrs.get('add_offset',0)).reshape(-1)[0])
        actual=samples*scale+offset;actual[bad|~inside]=np.nan

    pred=np.full(len(ids),np.nan,dtype=np.float64)
    statuses=defaultdict(int)
    for i,row in enumerate(ordered):
        statuses[row['data_status']]+=1
        if row['data_status']=='ok':
            pred[i]=float(row['erc_g_raw']) if row['erc_g_raw'] else np.nan
    valid=np.isfinite(actual)&np.isfinite(pred)
    valid_reference=np.isfinite(actual)
    if valid.sum()==0:raise RuntimeError('No predictions matched valid ERC reference pixels')

    def evaluate(mask):return stats(actual[mask&valid],pred[mask&valid])
    results={'date':str(day),'grid_total':len(ids), 'predicted_cells':int(np.isfinite(pred).sum()),
             'reference_valid_cells':int(valid_reference.sum()),'matched_valid_cells':int(valid.sum()),
             'coverage_pct_of_grid':float(100*valid.sum()/len(ids)),
             'source_pixel_count_for_evaluated_cells':len(set(zip(ilat[valid].tolist(),ilon[valid].tolist()))),
             'status_counts':dict(statuses),'overall':evaluate(np.ones(len(ids),dtype=bool)),
             'by_actual_erc':{}, 'notes':[
                 'One historical day only, 2025-07-09 unless overridden; not a forecast skill metric.',
                 'Comparing reconstructed gridMET ERC-G against gridMET ERC-G itself, not wildfire observations.',
                 '3km cell centers map to nearest source gridMET pixels; neighboring cells may share target values.',
                 'Many evaluated locations were not training sample cells; this is geographic extrapolation but not independent geographic-block validation.',
                 'Original 2025 test set has been inspected during model development; treat this as a diagnostic audit.'
             ]}
    for name,mask in [('below_30',actual<30),('30_to_59',(actual>=30)&(actual<60)),
                      ('60_to_89',(actual>=60)&(actual<90)),('90_plus',actual>=90)]:
        results['by_actual_erc'][name]=evaluate(mask)

    # Explicitly compare to known multiyear sampled cells, if available, and complement.
    training_sample=root/'data/processed/erc_weather_2024_lagged_multiyear.csv'
    if training_sample.exists():
        selected=set()
        with training_sample.open(newline='') as f:
            for row in csv.DictReader(f):selected.add(row['cell_id'])
        in_sample=np.array([i in selected for i in ids],dtype=bool)
        results['in_multiyear_sample']=evaluate(in_sample)
        results['outside_multiyear_sample']=evaluate(~in_sample)
        results['multiyear_sample_cell_count']=len(selected)
    else:results['sample_comparison_note']='2024 multiyear lag file not found; sample comparison omitted'

    out=args.output or root/f'data/map_3km/firewatch_erc_3km_{day}_accuracy_audit.json'
    out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(results,indent=2)+'\n')
    def show(label,m):
        if m is None:print(label,'no eligible rows');return
        print(f"{label:24s} n={m['n']:6,d} R2={m['r2']:.4f} MAE={m['mae']:.3f} RMSE={m['rmse']:.3f} BIAS={m['bias']:+.3f} P95AE={m['p95_absolute_error']:.3f}")
    print(f"DATE: {day} | ALL GRID CELLS: {len(ids):,} | VALID MATCHED: {int(valid.sum()):,}")
    print(f"Distinct gridMET pixels among evaluated cells: {results['source_pixel_count_for_evaluated_cells']:,}")
    show('All statewide cells',results['overall'])
    if 'in_multiyear_sample' in results:
        show('Original 600-cell sample',results['in_multiyear_sample'])
        show('Other grid cells',results['outside_multiyear_sample'])
    print('\nERRORS BY REFERENCE ERC BIN:')
    for name,m in results['by_actual_erc'].items():show(name,m)
    print('Report:',out)

if __name__=='__main__':main()
