#!/usr/bin/env python3
"""Convert DAILY forecast weather + at-least-30-day prior weather to V6 feature rows.
Input CSV schema: cell_id,date,source,issued_at_utc,temp_max_c,rh_min_pct,wind_mean_ms,precip_mm,elevation_mean_m,lat,lon
source=observed for prior 30 days, source=forecast for precisely 7 future days.
CRITICAL: observed prior records must be genuinely known at forecast issue time;
forecast dates strictly follow issue DATE in UTC. If issue is not UTC midnight,
this tool is a conservative daily demonstration requiring day-0 available history;
use a daily issue cut-off and matching provider timezone convention.
No network fetching, no hourly ERC model, no invented forecasts.
"""
import argparse,csv,datetime as dt,math,collections
p=argparse.ArgumentParser();p.add_argument('--weather',required=True);p.add_argument('--output',required=True);p.add_argument('--issue-date',required=True,help='UTC YYYY-MM-DD, latest available observed DAILY record');a=p.parse_args()
issue=dt.date.fromisoformat(a.issue_date)
required=['cell_id','date','source','issued_at_utc','temp_max_c','rh_min_pct','wind_mean_ms','precip_mm','elevation_mean_m','lat','lon']
with open(a.weather,newline='') as f:
 r=csv.DictReader(f);assert set(required)<=set(r.fieldnames or []),f'Missing {set(required)-set(r.fieldnames or [])}'
 rows=list(r)
bycell=collections.defaultdict(dict)
for row in rows:
 cell=row['cell_id'];day=dt.date.fromisoformat(row['date']);assert day not in bycell[cell],f'Duplicate {cell} {day}'
 assert row['source'] in ('observed','forecast')
 assert row['source']==('observed' if day<=issue else 'forecast'),f'Invalid source for {day}'
 if row['source']=='forecast':
  ts=dt.datetime.fromisoformat(row['issued_at_utc'].replace('Z','+00:00'))
  assert ts.tzinfo and ts.utcoffset()==dt.timedelta(0) and ts.date()<=issue,'Forecast issue must be UTC and no later than issue date'
 for k in ('temp_max_c','rh_min_pct','wind_mean_ms','precip_mm','elevation_mean_m','lat','lon'):
  row[k]=float(row[k]);assert math.isfinite(row[k]),f'Nonfinite {k}'
 assert 0<=row['rh_min_pct']<=100 and row['precip_mm']>=0 and row['wind_mean_ms']>=0
 bycell[cell][day]=row
features=['temp_max_c','rh_min_pct','wind_mean_ms','precip_mm','elevation_mean_m','lat','lon','day_sin','day_cos','precip_7d_mm','precip_30d_mm','temp_mean_7d_c','rh_mean_7d_pct','dry_days_14d','wind_mean_7d_ms']
written=0
with open(a.output,'w',newline='') as f:
 w=csv.DictWriter(f,fieldnames=['cell_id','timestamp','issued_at_utc','lead_day','forecast_source',*features]);w.writeheader()
 for cell,h in sorted(bycell.items()):
  prior=[issue-dt.timedelta(days=x) for x in range(29,-1,-1)]
  target=[issue+dt.timedelta(days=x) for x in range(1,8)]
  missing=[d for d in prior+target if d not in h]
  if missing:raise ValueError(f'{cell}: missing {len(missing)} daily rows, first {missing[0]}')
  for d in target:
   r=h[d];prev=[h[d-dt.timedelta(days=k)] for k in range(1,31)]
   if any(q['source']=='observed' and dt.date.fromisoformat(q['date'])>issue for q in prev):raise ValueError('Future observed leakage')
   if any(q['source']=='forecast' and dt.date.fromisoformat(q['date'])<=issue for q in prev):raise ValueError('Past forecast overwrite')
   sin=math.sin(2*math.pi*d.timetuple().tm_yday/366);cos=math.cos(2*math.pi*d.timetuple().tm_yday/366)
   vec={'cell_id':cell,'timestamp':d.isoformat()+'T00:00:00Z','issued_at_utc':r['issued_at_utc'],'lead_day':(d-issue).days,'forecast_source':'user_supplied_daily_weather_forecast',
   'temp_max_c':r['temp_max_c'],'rh_min_pct':r['rh_min_pct'],'wind_mean_ms':r['wind_mean_ms'],'precip_mm':r['precip_mm'],
   'elevation_mean_m':r['elevation_mean_m'],'lat':r['lat'],'lon':r['lon'],'day_sin':sin,'day_cos':cos,
   'precip_7d_mm':sum(q['precip_mm'] for q in prev[:7]),'precip_30d_mm':sum(q['precip_mm'] for q in prev),
   'temp_mean_7d_c':sum(q['temp_max_c'] for q in prev[:7])/7,'rh_mean_7d_pct':sum(q['rh_min_pct'] for q in prev[:7])/7,
   'dry_days_14d':sum(q['precip_mm']<1 for q in prev[:14]),'wind_mean_7d_ms':sum(q['wind_mean_ms'] for q in prev[:7])/7}
   w.writerow(vec);written+=1
print(f'Wrote {written} rows, 7 DAILY feature vectors per cell. 168-hour map UI may reference day-specific scores; NOT 168 independently predicted hourly ERC points.')
