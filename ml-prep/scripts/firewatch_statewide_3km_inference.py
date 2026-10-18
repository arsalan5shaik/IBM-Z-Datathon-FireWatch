#!/usr/bin/env python3
"""FireWatch statewide ~3x3 km historical ERC-G inference from frozen V6.

Uses 31 days of OBSERVED gridMET weather (date-30 through date), the
canonical EPSG:3310 cell grid, and native XGBoost. This is NOT a forecast or
wildfire probability. Does not modify the frozen model. No sklearn/shap needed.

Run in ~/firewatch with .venv311 activated. The 2024/2025 annual weather
NetCDFs and california_3km_elevation_mean_FILLED.csv must be present.
"""
import argparse
import csv
import json
import math
import os
from collections import Counter
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import h5netcdf
import xgboost as xgb

FEATURES = ['temp_max_c','rh_min_pct','wind_mean_ms','precip_mm',
            'elevation_mean_m','lat','lon','day_sin','day_cos',
            'precip_7d_mm','precip_30d_mm','temp_mean_7d_c',
            'rh_mean_7d_pct','dry_days_14d','wind_mean_7d_ms']
VARS={'tmmx':('weather','air_temperature'),
      'rmin':('weather','relative_humidity'),
      'vs':('weather','wind_speed'),
      'pr':('weather','precipitation_amount')}
OUTPUT_FIELDS=['cell_id','date','center_lat','center_lon','west_m','south_m',
 'east_m','north_m','land_fraction','erc_g_raw','erc_g_display','data_status']

def load_grid(root):
    p=root/'data/raw/california_3km_grid_lookup.csv'
    with p.open(newline='') as f:
        rows=list(csv.DictReader(f))
    if not rows: raise ValueError('Empty grid file')
    ids=[r['cell_id'] for r in rows]
    if len(ids)!=len(set(ids)): raise ValueError('Duplicate grid cell IDs')
    for r in rows:
        w,s,e,n=(float(r[k]) for k in ('west_m','south_m','east_m','north_m'))
        if not(abs(e-w-3000)<0.01 and abs(n-s-3000)<0.01):
            raise ValueError('Not a 3000m x 3000m grid cell: '+r['cell_id'])
    return rows

def elevation_lookup(path):
    with path.open(newline='') as f:
        reader=csv.DictReader(f)
        if not {'cell_id','elevation_mean_m'}.issubset(reader.fieldnames or []):
            raise ValueError('Elevation file missing cell_id/elevation_mean_m')
        z={}
        for r in reader:
            try:z[r['cell_id']]=float(r['elevation_mean_m'])
            except (ValueError,TypeError):pass
    return z

class Weather:
    def __init__(self,root):self.root=root;self.handles={};self.grids={}
    def close(self):
        for ds in self.handles.values():ds.close()
    def get(self,key,day,lat_idx,lon_idx,reference_lat,reference_lon):
        year=day.year;folder,varname=VARS[key];pair=(key,year)
        if pair not in self.handles:
            path=self.root/'data/raw'/folder/f'{key}_{year}.nc'
            if not path.is_file():raise FileNotFoundError(f'Need complete annual archive: {path}')
            ds=h5netcdf.File(str(path),'r',backend='pyfive')
            la=np.asarray(ds.variables['lat'][:]);lo=np.asarray(ds.variables['lon'][:]);times=np.asarray(ds.variables['day'][:])
            units=str(ds.variables['day'].attrs.get('units',''))
            if 'days since 1900-01-01' not in units:raise ValueError('Unexpected time units '+units)
            if not(np.array_equal(la,reference_lat) and np.array_equal(lo,reference_lon)):
                raise ValueError('Archive geographic grid mismatch: '+str(path))
            self.handles[pair]=ds
            self.grids[pair]=(times,ds.variables[varname])
        times,var=self.grids[pair]
        wanted=(day-date(1900,1,1)).days
        match=np.flatnonzero(times==wanted)
        if len(match)!=1:raise ValueError(f'Date {day} missing/duplicate in {pair}')
        i0,i1=int(lat_idx.min()),int(lat_idx.max())+1
        j0,j1=int(lon_idx.min()),int(lon_idx.max())+1
        raw=np.asarray(var[int(match[0]):int(match[0])+1,i0:i1,j0:j1])[0]
        samples=raw[lat_idx-i0,lon_idx-j0].astype(np.float64)
        bad=~np.isfinite(samples)
        for k in ('_FillValue','missing_value'):
            if k in var.attrs:
                for fv in np.asarray(var.attrs[k]).reshape(-1):bad|=samples==float(fv)
        scale=float(np.asarray(var.attrs.get('scale_factor',1)).reshape(-1)[0]);offset=float(np.asarray(var.attrs.get('add_offset',0)).reshape(-1)[0])
        values=samples*scale+offset;values[bad]=np.nan
        if key=='tmmx':values-=273.15
        return values

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--date',required=True,help='Historical observation date, YYYY-MM-DD')
    p.add_argument('--root',type=Path,default=Path.home()/'firewatch')
    p.add_argument('--model',type=Path,default=Path('models/releases/firewatch_erc_v6_2023_2025/model.json'))
    p.add_argument('--outdir',type=Path,default=Path('data/map_3km'))
    p.add_argument('--threads',type=int,default=2)
    p.add_argument('--min-land-fraction',type=float,default=0.0,help='Eligibility cutoff, not risk threshold')
    p.add_argument('--geojson',action='store_true',help='Also export marker point GeoJSON (can be large)')
    args=p.parse_args();root=args.root.resolve();day=date.fromisoformat(args.date)
    if not 0<=args.min_land_fraction<=1:raise ValueError('min-land-fraction must be 0..1')
    mp=args.model if args.model.is_absolute() else root/args.model
    op=args.outdir if args.outdir.is_absolute() else root/args.outdir
    model=xgb.Booster(params={'nthread':args.threads});model.load_model(str(mp))
    if model.feature_names!=FEATURES:raise ValueError('Frozen model feature order mismatch')
    grid=load_grid(root);N=len(grid)
    elev=elevation_lookup(root/'data/raw/california_3km_elevation_mean_FILLED.csv')
    lat=np.array([float(r['center_lat']) for r in grid]);lon=np.array([float(r['center_lon']) for r in grid]);
    land=np.array([float(r['land_fraction']) for r in grid]);height=np.array([elev.get(r['cell_id'],np.nan) for r in grid])
    if np.any(~np.isfinite(lat)) or np.any(~np.isfinite(lon)):raise ValueError('Bad grid centers')
    ref_path=root/'data/raw/weather'/f'tmmx_{day.year}.nc'
    if not ref_path.exists():raise FileNotFoundError(ref_path)
    with h5netcdf.File(str(ref_path),'r',backend='pyfive') as ds:
        lats=np.asarray(ds.variables['lat'][:]);lons=np.asarray(ds.variables['lon'][:])
    lat_idx=np.abs(lats[:,None]-lat).argmin(axis=0)
    lon_match=np.mod(lon,360) if lons.max()>180 else lon
    lon_idx=np.abs(lons[:,None]-lon_match).argmin(axis=0)
    if np.any((lat<lats.min())|(lat>lats.max())|(lon_match<lons.min())|(lon_match>lons.max())):
        raise ValueError('At least one center lies outside source grid extent')
    met=Weather(root);history={k:[] for k in VARS}
    try:
        for offset in range(30,-1,-1):
            d=day-timedelta(days=offset)
            for key in VARS:
                history[key].append(met.get(key,d,lat_idx,lon_idx,lats,lons))
            if offset%10==0:print('Weather history:',d,flush=True)
    finally:met.close()
    hist={k:np.vstack(v) for k,v in history.items()}
    pr=hist['pr'];t=hist['tmmx'];rh=hist['rmin'];wind=hist['vs']
    angle=2*math.pi*day.timetuple().tm_yday/366
    arrays={
      'temp_max_c':t[-1],'rh_min_pct':rh[-1],'wind_mean_ms':wind[-1],
      'precip_mm':pr[-1], 'elevation_mean_m':height,'lat':lat,'lon':lon,
      'day_sin':np.full(N,math.sin(angle)),'day_cos':np.full(N,math.cos(angle)),
      'precip_7d_mm':np.sum(pr[-8:-1],axis=0),
      'precip_30d_mm':np.sum(pr[:-1],axis=0),
      'temp_mean_7d_c':np.mean(t[-8:-1],axis=0),
      'rh_mean_7d_pct':np.mean(rh[-8:-1],axis=0),
      'dry_days_14d':np.sum(pr[-15:-1]<1,axis=0).astype(float),
      'wind_mean_7d_ms':np.mean(wind[-8:-1],axis=0)
    }
    # Using sum/mean with normal NumPy operations enforces complete history.
    # For dry_days, explicitly require all 14 prior days finite.
    X=np.column_stack([arrays[k] for k in FEATURES]).astype(np.float32)
    valid=np.all(np.isfinite(X),axis=1)&np.all(np.isfinite(pr[-15:-1]),axis=0)
    valid &= (land>=args.min_land_fraction)&(land>0)&(rh[-1]>=0)&(rh[-1]<=100)&(pr[-1]>=0)&(wind[-1]>=0)
    reason=Counter();raw=np.full(N,np.nan);view=np.full(N,np.nan)
    if np.any(valid):
        dm=xgb.DMatrix(X[valid],feature_names=FEATURES)
        raw[valid]=model.predict(dm)
        view[valid]=np.maximum(raw[valid],0)
    if not np.isfinite(raw[valid]).all():raise ValueError('Model returned nonfinite values')
    op.mkdir(parents=True,exist_ok=True)
    path=op/f'firewatch_erc_3km_{day.isoformat()}.csv';tmp=path.with_suffix('.csv.part')
    with tmp.open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=OUTPUT_FIELDS);w.writeheader()
        for i,r in enumerate(grid):
            status='ok' if valid[i] else ('excluded_low_land_fraction' if land[i]<args.min_land_fraction or land[i]<=0 else 'missing_required_features')
            w.writerow({'cell_id':r['cell_id'],'date':str(day),'center_lat':r['center_lat'],
                'center_lon':r['center_lon'],'west_m':r['west_m'],'south_m':r['south_m'],
                'east_m':r['east_m'],'north_m':r['north_m'],'land_fraction':r['land_fraction'],
                'erc_g_raw':round(float(raw[i]),5) if valid[i] else '',
                'erc_g_display':round(float(view[i]),5) if valid[i] else '', 'data_status':status})
            reason[status]+=1
    os.replace(tmp,path)
    report={'date':str(day),'grid_cells_total':N,'cell_dimension_m':[3000,3000],
            'valid_cells':int(valid.sum()),'excluded_cells':int((~valid).sum()),
            'coverage_pct':float(valid.mean()*100), 'negative_predictions_clipped_for_display':int(np.sum(raw[valid]<0)),
            'status_counts':dict(reason),'map_csv':str(path),
            'model':str(mp),'data_kind':'historical_observed_weather_ERC_G_reconstruction',
            'NOT_wildfire_probability':True,'NOT_future_forecast':True,
            'warnings':['Source gridMET weather is coarser than the 3 km display grid',
                        '3 km boundary is provisional/simplified and must be approved before production',
                        'Training used only 600 cells; other cells are out-of-sample geography',
                        'No red/amber/green categories are calibrated; do not interpret ERC as percent risk',
                        'Clipped display estimates are not original model predictions']}
    meta=op/f'firewatch_erc_3km_{day.isoformat()}_report.json';meta.write_text(json.dumps(report,indent=2)+'\n')
    if args.geojson:
        out=op/f'firewatch_erc_3km_{day.isoformat()}_points.geojson';part=out.with_suffix('.geojson.part')
        with part.open('w') as f:
            f.write('{"type":"FeatureCollection","features":[')
            first=True
            for i,r in enumerate(grid):
                if not valid[i]:continue
                item={'type':'Feature','geometry':{'type':'Point','coordinates':[float(r['center_lon']),float(r['center_lat'])]},
                    'properties':{'cell_id':r['cell_id'],'erc_g':round(float(view[i]),4),
                                  'date':str(day),'metric':'ERC-G','observed_weather':True}}
                if not first:f.write(',')
                f.write(json.dumps(item,separators=(',',':')));first=False
            f.write(']}')
        os.replace(part,out);print('Point GeoJSON:',out)
    print('GRID:',N,'VALID:',int(valid.sum()),'COVERAGE:',f'{valid.mean()*100:.2f}%',flush=True)
    print('STATUS:',dict(reason),'NEGATIVE RAW PREDICTIONS:',report['negative_predictions_clipped_for_display'],flush=True)
    print('CSV:',path,'REPORT:',meta,flush=True)
    if valid.mean()<0.95: print('WARNING: Less than 95% of grid eligible; review report before map handoff.',flush=True)

if __name__=='__main__':main()
