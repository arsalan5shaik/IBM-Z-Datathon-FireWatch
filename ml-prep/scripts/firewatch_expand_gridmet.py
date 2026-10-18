#!/usr/bin/env python3
"""Expand FireWatch to consistent 2023-2025 daily gridMET sampled cell data.
Uses existing 2024 raw CSV and extracts 2023,2025 NetCDF archives natively on s390x.
No sklearn. Does not train, shuffle dates, or change grid-cell selection.
"""
import argparse,csv,hashlib,json,math,random,urllib.request,time
from pathlib import Path
from datetime import date,timedelta
import numpy as np
import h5netcdf

VARS={'erc':('erc','energy_release_component-g'), 'tmmx':('weather','air_temperature'),
      'rmin':('weather','relative_humidity'),'vs':('weather','wind_speed'),
      'pr':('weather','precipitation_amount')}
FIELDS=['cell_id','date','lat','lon','temp_max_c','rh_min_pct','wind_mean_ms','precip_mm','day_sin','day_cos','elevation_mean_m','target_erc','split']
HOSTS=['https://www.northwestknowledge.net/metdata/data',
       'https://www.reacchpna.org/thredds/fileServer/MET']

def download(url,out):
    temp=out.with_suffix(out.suffix+'.part')
    # Resume large transfers when supported; fail if the server ignores range.
    start=temp.stat().st_size if temp.exists() else 0
    headers={'User-Agent':'FireWatch-gridMET-research/1.0'}
    if start: headers['Range']=f'bytes={start}-'
    with urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=120) as response:
        status=getattr(response,'status',200)
        if start and status!=206:
            start=0
        mode='ab' if start else 'wb'
        with temp.open(mode) as f:
            while True:
                chunk=response.read(1024*1024)
                if not chunk:break
                f.write(chunk)
    with temp.open('rb') as f:
        signature=f.read(8)
    if signature!=b'\x89HDF\r\n\x1a\n' and not signature.startswith(b'CDF'):
        raise ValueError('Download is not NetCDF/HDF5; inspect URL: '+url)
    temp.replace(out)

def fetch(root,years):
    for year in years:
        for key,(folder,_) in VARS.items():
            out=root/'data/raw'/folder/f'{key}_{year}.nc'
            out.parent.mkdir(parents=True,exist_ok=True)
            if out.exists() and out.stat().st_size>1024*1024:
                print('Existing',out,flush=True);continue
            errors=[]
            urls=[f'{HOSTS[0]}/{key}_{year}.nc',f'{HOSTS[1]}/{key}/{key}_{year}.nc']
            for url in urls:
                try:
                    print('Downloading',url,flush=True)
                    download(url,out)
                    print('Saved',out,out.stat().st_size,'bytes',flush=True)
                    break
                except Exception as e:
                    errors.append(str(e));print('Source failed:',str(e)[:180],flush=True)
            else: raise RuntimeError(f'Could not download {key} {year}: '+str(errors))


def grid_sample(root, n=1400, seed=42):
    """Reuse the exact cell IDs from the existing 2024 dataset."""
    reference = root / "data/processed/erc_weather_2024_full_year_sample.csv"
    lookup = root / "data/raw/california_3km_grid_lookup.csv"

    with reference.open(newline="") as f:
        cell_ids = {r["cell_id"] for r in csv.DictReader(f)}

    selected = []

    with lookup.open(newline="") as f:
        for r in csv.DictReader(f):
            if r["cell_id"] in cell_ids:
                selected.append((
                    r["cell_id"],
                    float(r["center_lat"]),
                    float(r["center_lon"])
                ))

    selected.sort(key=lambda x: x[0])

    if len(selected) != len(cell_ids):
        raise ValueError(
            f"Grid lookup mismatch: expected {len(cell_ids)}, "
            f"found {len(selected)}"
        )

    print(
        f"Reusing {len(selected)} original 2024 cells",
        flush=True
    )

    return selected


def decode_days(ds):
    v=ds.variables['day']
    units=str(v.attrs.get('units',''))
    if 'days since 1900-01-01' not in units:raise ValueError('Unexpected day units: '+units)
    return [date(1900,1,1)+timedelta(days=int(a)) for a in np.asarray(v[:])]

def extract_year(root,year,selected):
    fpaths={key:root/'data/raw'/folder/f'{key}_{year}.nc' for key,(folder,var) in VARS.items()}
    for p in fpaths.values():
        if not p.exists():raise FileNotFoundError(p)
    files={k:h5netcdf.File(str(p),'r',backend='pyfive') for k,p in fpaths.items()}
    try:
        base=files['erc'];lats=np.asarray(base.variables['lat'][:]);lons=np.asarray(base.variables['lon'][:]);days=np.asarray(base.variables['day'][:]);dates=decode_days(base)
        if len(dates) not in (365,366) or dates[0]!=date(year,1,1) or dates[-1]!=date(year,12,31):raise ValueError(f'Wrong date coverage for {year}: {dates[0]} to {dates[-1]}')
        for key,ds in files.items():
            if not (np.array_equal(ds.variables['day'][:],days) and np.array_equal(ds.variables['lat'][:],lats) and np.array_equal(ds.variables['lon'][:],lons)):
                raise ValueError(f'{year}/{key}: grid/time mismatch')
        la_idx=np.abs(lats[:,None]-np.array([x[1] for x in selected])).argmin(axis=0)
        lo_vals=np.array([x[2] for x in selected]);lo_vals=np.mod(lo_vals,360) if lons.max()>180 else lo_vals
        lo_idx=np.abs(lons[:,None]-lo_vals).argmin(axis=0)
        i0,i1=int(la_idx.min()),int(la_idx.max())+1;j0,j1=int(lo_idx.min()),int(lo_idx.max())+1
        variables={}
        for key,(folder,varname) in VARS.items():
            v=files[key].variables[varname];attrs=v.attrs
            if tuple(v.dimensions)!=('day','lat','lon'):raise ValueError(f'{key}: wrong dimension order')
            missing=set()
            for m in ('_FillValue','missing_value'):
                if m in attrs:missing.update(np.asarray(attrs[m]).ravel().astype(float).tolist())
            variables[key]=(v,float(np.asarray(attrs.get('scale_factor',1)).ravel()[0]),float(np.asarray(attrs.get('add_offset',0)).ravel()[0]),missing)
        elevations={}
        with (root/'data/raw/california_3km_elevation_mean_FILLED.csv').open(newline='') as f:
            for r in csv.DictReader(f):
                try:elevations[r['cell_id']]=float(r['elevation_mean_m'])
                except (ValueError,KeyError):pass
        out=root/'data/processed'/f'erc_weather_{year}_full_year_sample.csv';out.parent.mkdir(parents=True,exist_ok=True)
        counts={'valid':0,'invalid':0}
        with out.open('w',newline='') as f:
            w=csv.DictWriter(f,fieldnames=FIELDS);w.writeheader()
            for t,d in enumerate(dates):
                values={}
                for key,(v,scale,offset,missing) in variables.items():
                    patch=np.asarray(v[t:t+1,i0:i1,j0:j1])[0]
                    raw=patch[la_idx-i0,lo_idx-j0].astype(float)
                    bad=~np.isfinite(raw)
                    for missing_value in missing:bad|=raw==missing_value
                    vals=raw*scale+offset;vals[bad]=np.nan;values[key]=vals
                values['tmmx']-=273.15
                for k,(cell,lat,lon) in enumerate(selected):
                    temp,rh,wind,pr,erc=(values[key][k] for key in ('tmmx','rmin','vs','pr','erc'))
                    elev=elevations.get(cell,float('nan'))
                    if not np.all(np.isfinite([temp,rh,wind,pr,erc,elev])) or not(-80<=temp<=70 and 0<=rh<=100 and wind>=0 and pr>=0 and erc>=0):
                        counts['invalid']+=1;continue
                    # 366 denominator deliberately matches original 2024 feature formula.
                    a=2*math.pi*d.timetuple().tm_yday/366
                    w.writerow({'cell_id':cell,'date':str(d),'lat':lat,'lon':lon,
                        'temp_max_c':round(float(temp),4),'rh_min_pct':round(float(rh),4),'wind_mean_ms':round(float(wind),4),
                        'precip_mm':round(float(pr),4),'day_sin':round(math.sin(a),6),'day_cos':round(math.cos(a),6),
                        'elevation_mean_m':round(float(elev),3),'target_erc':float(erc),
                        'split':'train' if year<2025 else ('validation' if d.month<=6 else 'test')})
                    counts['valid']+=1
                if (t+1)%60==0 or t+1==len(dates):print(f'{year}: days {t+1}/{len(dates)}, valid {counts["valid"]:,}',flush=True)
        print('Extracted',out,counts,flush=True)
        return out
    finally:
        for f in files.values():f.close()

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=Path.home()/'firewatch')
    p.add_argument('--years',type=int,nargs='+',default=[2023,2025]);p.add_argument('--fetch-only',action='store_true');p.add_argument('--extract-only',action='store_true');args=p.parse_args()
    if args.fetch_only and args.extract_only:p.error('Choose only one of --fetch-only/--extract-only')
    years=args.years
    if not args.extract_only:fetch(args.root,years)
    if not args.fetch_only:
        selected=grid_sample(args.root)
        # Validate sampled IDs against 2024 CSV before concatenating independently generated years.
        reference=args.root/'data/processed/erc_weather_2024_full_year_sample.csv'
        if not reference.exists():raise FileNotFoundError(reference)
        with reference.open(newline='') as f:
            old=set()
            for row in csv.DictReader(f):old.add(row['cell_id'])
        expected={x[0] for x in selected}
        if old!=expected:raise ValueError(f'2024 sampled cell IDs mismatch: existing={len(old)}, generated={len(expected)}. STOP: do not combine grids.')
        for yr in years:extract_year(args.root,yr,selected)
if __name__=='__main__':main()
