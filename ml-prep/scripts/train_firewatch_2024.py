#!/usr/bin/env python3
"""Train real FireWatch ERC-G XGBoost model from full 2024 gridMET HDF5 archives.
Reads data on LinuxONE with h5netcdf + pyfive, avoiding huge full-grid arrays.
"""
import csv, json, math, os, random, hashlib
from pathlib import Path
from datetime import date, timedelta
from collections import Counter
import numpy as np
import h5netcdf

ROOT = Path.home() / 'firewatch'
RAW = ROOT / 'data/raw'
PROCESSED = ROOT / 'data/processed'
MODELS = ROOT / 'models'
PROCESSED.mkdir(parents=True, exist_ok=True)
MODELS.mkdir(parents=True, exist_ok=True)
SEED = 42
# Same representative geographic sample across all 366 days; all source dates included.
MAX_CELLS = int(os.environ.get('FW_TRAIN_CELLS', '1400'))
TRAIN_END = date(2024, 9, 30)
DATASETS = {
    'erc': (RAW / 'erc/erc_2024.nc', 'energy_release_component-g'),
    'temp': (RAW / 'weather/tmmx_2024.nc', 'air_temperature'),
    'rh': (RAW / 'weather/rmin_2024.nc', 'relative_humidity'),
    'wind': (RAW / 'weather/vs_2024.nc', 'wind_speed'),
    'precip': (RAW / 'weather/pr_2024.nc', 'precipitation_amount'),
}
for name,(path,_) in DATASETS.items():
    if not path.exists():
        raise SystemExit(f'Missing {name} archive: {path}')

try:
    import xgboost as xgb
except Exception as e:
    raise SystemExit('XGBoost must be importable in this Python environment first: '+str(e))

# Grid: choose spatially distributed California centers, retain stable IDs.
grid = []
with open(RAW/'california_3km_grid_lookup.csv', newline='') as f:
    for row in csv.DictReader(f):
        lat,lon=float(row['center_lat']),float(row['center_lon'])
        if math.isfinite(lat) and math.isfinite(lon):
            grid.append((row['cell_id'],lat,lon))
rng = random.Random(SEED)
rng.shuffle(grid)
selected = sorted(grid[:MAX_CELLS], key=lambda x:x[0])
print(f'Using {len(selected)} fixed California cells, all 366 dates; grid total {len(grid)}.', flush=True)

# Gather nearest indices from first source; all five should have exactly same grid and time.
with h5netcdf.File(str(DATASETS['erc'][0]), 'r', backend='pyfive') as ds:
    lats = np.asarray(ds.variables['lat'][:],dtype=float)
    lons = np.asarray(ds.variables['lon'][:],dtype=float)
    days = np.asarray(ds.variables['day'][:],dtype=float)
    units=str(ds.variables['day'].attrs.get('units',''))
    assert '1900-01-01' in units, units
    dates=[date(1900,1,1)+timedelta(days=int(d)) for d in days]
    if dates[0] != date(2024,1,1) or dates[-1] != date(2024,12,31) or len(dates)!=366:
        raise ValueError('ERC date coverage is not Jan 1-Dec 31 2024')
    lat_idx=np.abs(lats[:,None]-np.array([v[1] for v in selected])).argmin(axis=0)
    src_lon=np.array([v[2] for v in selected]); src_lon=np.where(lons.max()>180, src_lon%360,src_lon)
    lon_idx=np.abs(lons[:,None]-src_lon).argmin(axis=0)

# Pure-Python HDF5 readers perform better with contiguous read windows than 1400 individual reads.
# Read only California's bounding rectangle, per date/per variable; no full-year cube in RAM.
i0,i1=int(lat_idx.min()),int(lat_idx.max())+1
j0,j1=int(lon_idx.min()),int(lon_idx.max())+1
print(f'Source window: lat[{i0}:{i1}] lon[{j0}:{j1}] = {(i1-i0)*(j1-j0):,} px/day.', flush=True)

files={name:h5netcdf.File(str(path),'r',backend='pyfive') for name,(path,_) in DATASETS.items()}
try:
    arrays={}
    for name,(path,varname) in DATASETS.items():
        ds=files[name]
        if not (np.array_equal(np.asarray(ds.variables['lat'][:]),lats) and
                np.array_equal(np.asarray(ds.variables['lon'][:]),lons) and
                np.array_equal(np.asarray(ds.variables['day'][:]),days)):
            raise ValueError(f'{name} grid/time differs from ERC')
        v=ds.variables[varname]
        if v.dimensions!=('day','lat','lon'):
            raise ValueError(f'{name} unexpected dimension order {v.dimensions}')
        attr=v.attrs
        missing=set()
        for k in ('_FillValue','missing_value'):
            if k in attr:
                missing.update(np.asarray(attr[k]).ravel().astype(float).tolist())
        arrays[name]=(v,float(np.asarray(attr.get('scale_factor',1)).ravel()[0]),
                      float(np.asarray(attr.get('add_offset',0)).ravel()[0]),missing)

    # Each day's row can be dropped if any source is masked; no invented values.
    cols=['cell_id','date','lat','lon','temp_max_c','rh_min_pct','wind_mean_ms',
          'precip_mm','day_sin','day_cos','elevation_mean_m','target_erc','split']
    elev={}
    with open(RAW/'california_3km_elevation_mean_FILLED.csv',newline='') as f:
        for row in csv.DictReader(f):
            try: elev[row['cell_id']]=float(row['elevation_mean_m'])
            except (ValueError,KeyError): pass
    indexes=np.arange(len(selected))
    target_rows=[]; train_X=[]; train_y=[]; test_X=[]; test_y=[]
    feature_names=['temp_max_c','rh_min_pct','wind_mean_ms','precip_mm',
                   'elevation_mean_m','lat','lon','day_sin','day_cos']
    ctr=Counter()
    output=PROCESSED/'erc_weather_2024_full_year_sample.csv'
    with open(output,'w',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=cols);writer.writeheader()
        for t,d in enumerate(dates):
            vals={}
            for name,(v,scale,offset,missing) in arrays.items():
                patch=np.asarray(v[t:t+1,i0:i1,j0:j1])[0]
                raw=patch[lat_idx-i0, lon_idx-j0].astype(float)
                isbad=~np.isfinite(raw)
                for sentinel in missing: isbad |= raw == sentinel
                values=raw*scale+offset
                values[isbad]=np.nan
                vals[name]=values
            # tmmx Kelvin -> Celsius; remaining weather units already %, m/s, mm.
            vals['temp']=vals['temp']-273.15
            day_sin=math.sin(2*math.pi*d.timetuple().tm_yday/366)
            day_cos=math.cos(2*math.pi*d.timetuple().tm_yday/366)
            split='train' if d <= TRAIN_END else 'test'
            for k,(cell,lat,lon) in enumerate(selected):
                ev=elev.get(cell,float('nan'))
                temp,rh,wind,precip,erc=(vals[n][k] for n in ('temp','rh','wind','precip','erc'))
                if not np.all(np.isfinite([ev,temp,rh,wind,precip,erc])):
                    ctr['missing_source_rows']+=1
                    continue
                # Sanity masks for invalid source measurements, not tight physical fire assumptions.
                if not (-80<=temp<=70 and 0<=rh<=100 and wind>=0 and precip>=0 and erc>=0):
                    ctr['out_of_range_rows']+=1; continue
                row={'cell_id':cell,'date':str(d),'lat':lat,'lon':lon,'temp_max_c':round(float(temp),4),
                     'rh_min_pct':round(float(rh),4),'wind_mean_ms':round(float(wind),4),
                     'precip_mm':round(float(precip),4),'day_sin':round(day_sin,6),
                     'day_cos':round(day_cos,6),'elevation_mean_m':round(ev,3),
                     'target_erc':float(erc),'split':split}
                writer.writerow(row)
                X=[float(row[n]) for n in feature_names]
                if split=='train':train_X.append(X);train_y.append(float(erc))
                else:test_X.append(X);test_y.append(float(erc))
                ctr[split+'_rows']+=1
            if (t+1)%30==0 or t==365:
                print(f'Processed {t+1}/366 days | train={ctr["train_rows"]:,} test={ctr["test_rows"]:,}',flush=True)
finally:
    for f in files.values():f.close()

if not train_X or not test_X: raise RuntimeError('Insufficient training/test data')
Xtr=np.asarray(train_X,dtype=np.float32); ytr=np.asarray(train_y,dtype=np.float32)
Xte=np.asarray(test_X,dtype=np.float32); yte=np.asarray(test_y,dtype=np.float32)
print(f'Training XGBoost on {len(ytr):,} observations; testing on {len(yte):,}.',flush=True)
model=xgb.XGBRegressor(objective='reg:squarederror',n_estimators=300,max_depth=5,
    learning_rate=0.07,subsample=.8,colsample_bytree=.8,min_child_weight=8,
    reg_lambda=5,tree_method='hist',n_jobs=2,random_state=SEED)
model.fit(Xtr,ytr,verbose=False)
model_path=MODELS/'firewatch_erc_xgboost_2024.json'
model.save_model(str(model_path))
pred=model.predict(Xte)
mae=float(np.mean(np.abs(yte-pred)))
rmse=float(np.sqrt(np.mean((yte-pred)**2)))
baseline=np.full_like(yte,float(ytr.mean()))
baseline_mae=float(np.mean(np.abs(yte-baseline)))
baseline_rmse=float(np.sqrt(np.mean((yte-baseline)**2)))
metrics={'model':'XGBoost ERC-G regression','training_dates':['2024-01-01',str(TRAIN_END)],
 'test_dates':['2024-10-01','2024-12-31'],'cells_sampled':len(selected),
 'train_rows':len(ytr),'test_rows':len(yte),'features':feature_names,
 'xgboost_mae':mae,'xgboost_rmse':rmse,'mean_baseline_mae':baseline_mae,
 'mean_baseline_rmse':baseline_rmse,'counts':dict(ctr),
 'caveat':'Historical observed same-day weather; this is an ERC surrogate, not real lead-day forecast accuracy. Geographic test overlap; further spatial and multi-year tests required.',
 'libraries':{'xgboost':xgb.__version__}}
metrics_path=MODELS/'firewatch_erc_xgboost_2024_metrics.json'
metrics_path.write_text(json.dumps(metrics,indent=2))
print('\n=== MODEL TRAINING COMPLETE ===',flush=True)
print(f'XGBoost    MAE {mae:.3f} | RMSE {rmse:.3f}',flush=True)
print(f'Mean base  MAE {baseline_mae:.3f} | RMSE {baseline_rmse:.3f}',flush=True)
print('Model:',model_path,flush=True)
print('Metrics:',metrics_path,flush=True)
print('Training CSV:',output,flush=True)
