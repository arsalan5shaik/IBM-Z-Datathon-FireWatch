#!/usr/bin/env python3
"""Apply experimental quintile category to prediction CSV. ONLY if --allow-provisional is passed.
Required columns: region,timestamp,erc_g_display,data_status; retain all original columns.
"""
import argparse,csv,json,datetime as dt
p=argparse.ArgumentParser();p.add_argument('--predictions',required=True);p.add_argument('--calibration',required=True);p.add_argument('--output',required=True);p.add_argument('--allow-provisional',action='store_true');a=p.parse_args()
if not a.allow_provisional:raise SystemExit('Refusing unvalidated danger class labels; pass --allow-provisional for clearly marked experimental UI only')
cal=json.load(open(a.calibration));assert cal['status']=='PROVISIONAL_NOT_VALIDATED'
labels=['Low','Moderate','High','Very High','Extreme']
with open(a.predictions,newline='') as f:
 r=csv.DictReader(f);fields=list(r.fieldnames or []);assert {'region','timestamp','erc_g_display','data_status'}<=set(fields)
 rows=list(r)
for name in ('risk_category','risk_category_status'):
 if name not in fields:fields.append(name)
for r in rows:
 r['risk_category']='';r['risk_category_status']='unavailable'
 if r['data_status']!='ok' or not r['erc_g_display']:continue
 key=r['region']+'|'+r['timestamp'][5:7];group=cal['thresholds'].get(key)
 if group is None:continue
 value=float(r['erc_g_display']);r['risk_category']=labels[sum(value>=t for t in group['cutoffs'])];r['risk_category_status']='EXPERIMENTAL_NOT_VALIDATED'
with open(a.output,'w',newline='') as f:
 w=csv.DictWriter(f,fieldnames=fields);w.writeheader();w.writerows(rows)
print('Provisional category output:',a.output,'DO NOT PRESENT AS VALIDATED FIRE WARNINGS')
