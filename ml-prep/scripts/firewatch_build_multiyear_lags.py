#!/usr/bin/env python3
"""Build continuous 2023-2025 causal lag features; streaming and memory-efficient.
Outputs one lagged CSV per year. 2025 remains held out for validation/test.
"""
import argparse,csv,hashlib,math
from pathlib import Path
from datetime import date,timedelta
from collections import defaultdict,deque,Counter
BASE=['temp_max_c','rh_min_pct','wind_mean_ms','precip_mm','elevation_mean_m','lat','lon','day_sin','day_cos']
LAGS=['precip_7d_mm','precip_30d_mm','temp_mean_7d_c','rh_mean_7d_pct','dry_days_14d','wind_mean_7d_ms']
FIELDS=['cell_id','date','split','target_erc']+BASE+LAGS

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=Path.home()/'firewatch');p.add_argument('--cells',type=int,default=600);args=p.parse_args()
    root=args.root;src={y:root/'data/processed'/f'erc_weather_{y}_full_year_sample.csv' for y in (2023,2024,2025)}
    for path in src.values():
        if not path.is_file():raise FileNotFoundError(path)
    # Select a stable, geographically well-distributed hash subset of the 2024 cells.
    with src[2024].open(newline='') as f:
        cells={r['cell_id'] for r in csv.DictReader(f)}
    if args.cells<10 or args.cells>len(cells):raise ValueError('Requested cells outside available sample')
    selected=set(sorted(cells,key=lambda s:hashlib.sha256(s.encode()).hexdigest())[:args.cells])
    print('Using',len(selected),'cells, same IDs for every year',flush=True)
    hist=defaultdict(lambda:deque(maxlen=30))
    totals=Counter()
    manifest={'cells':len(selected),'rows':{},'input_files':{str(y):str(q) for y,q in src.items()},'lag_rule':'exactly the preceding 30 calendar days, excluding current day; cross-year continuity','years':[2023,2024,2025]}
    out_dir=root/'data/processed';out_dir.mkdir(exist_ok=True,parents=True)
    prev_global_day=None
    for year in (2023,2024,2025):
        out=out_dir/f'erc_weather_{year}_lagged_multiyear.csv'
        with src[year].open(newline='') as fin,out.open('w',newline='') as fout:
            r=csv.DictReader(fin);required={'cell_id','date','target_erc',*BASE}
            if not required.issubset(r.fieldnames or []):raise ValueError(f'{src[year]} missing {required-set(r.fieldnames or [])}')
            w=csv.DictWriter(fout,fieldnames=FIELDS);w.writeheader()
            last_day=None;written=0;skipped=0;selected_rows=0
            for row in r:
                if row['cell_id'] not in selected:continue
                selected_rows+=1
                day=date.fromisoformat(row['date'])
                if last_day and day<last_day:raise ValueError(f'Rows are not date-sorted in {src[year]}')
                last_day=day
                h=hist[row['cell_id']]
                contiguous=len(h)==30 and all(h[-k][0]==day-timedelta(days=k) for k in range(1,31))
                if contiguous:
                    prior=list(h)
                    lag={'precip_7d_mm':sum(x[1] for x in prior[-7:]),
                         'precip_30d_mm':sum(x[1] for x in prior),
                         'temp_mean_7d_c':sum(x[2] for x in prior[-7:])/7,
                         'rh_mean_7d_pct':sum(x[3] for x in prior[-7:])/7,
                         'dry_days_14d':sum(x[1]<1 for x in prior[-14:]),
                         'wind_mean_7d_ms':sum(x[4] for x in prior[-7:])/7}
                    spl='train' if year<2025 else ('validation' if day.month<=6 else 'test')
                    w.writerow({'cell_id':row['cell_id'],'date':row['date'],'split':spl,'target_erc':row['target_erc'],**{k:row[k] for k in BASE},**lag})
                    written+=1
                else:skipped+=1
                h.append((day,float(row['precip_mm']),float(row['temp_max_c']),float(row['rh_min_pct']),float(row['wind_mean_ms'])))
        manifest['rows'][str(year)]={'selected_raw':selected_rows,'lagged_complete':written,'incomplete':skipped,'path':str(out)}
        print(year,manifest['rows'][str(year)],flush=True)
    import json
    manifest_file=out_dir/'firewatch_multiyear_manifest.json';manifest_file.write_text(json.dumps(manifest,indent=2));print('Manifest:',manifest_file)
if __name__=='__main__':main()
