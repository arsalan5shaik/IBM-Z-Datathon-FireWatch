#!/usr/bin/env python3
"""Generate PROVISIONAL regional/monthly ERC-G quintile boundaries from an independent historical REFERENCE CSV.
Input columns: region,month,erc_g_reference (one row per independent source-pixel/day, deduplicate upstream).
NOT official NFDRS adjective classes; DO NOT LABEL AS VALIDATED. Calibration must be fit on historical calibration period, never on test labels or upcoming forecasts.
"""
import argparse,csv,json,collections,statistics,datetime as dt
p=argparse.ArgumentParser();p.add_argument('--reference',required=True);p.add_argument('--output',required=True);p.add_argument('--min-rows',type=int,default=1000);p.add_argument('--label',default='EXPERIMENTAL_RELATIVE_ERC_QUINTILES');a=p.parse_args()
groups=collections.defaultdict(list)
with open(a.reference,newline='') as f:
 for r in csv.DictReader(f):
  key=(r['region'],int(r['month']));v=float(r['erc_g_reference']);groups[key].append(v)
def quantile(x,p):
 x=sorted(x);k=(len(x)-1)*p;j=int(k);t=k-j;return x[j]*(1-t)+x[min(j+1,len(x)-1)]*t
out={'status':'PROVISIONAL_NOT_VALIDATED','name':a.label,'definition':'Relative quintiles of historical reference ERC-G, not official fire danger/adjective ratings or fire probabilities','generated_utc':dt.datetime.now(dt.timezone.utc).isoformat(),'training_source':a.reference,'thresholds':{}}
for (region,month),values in sorted(groups.items()):
 if len(values)<a.min_rows:continue
 out['thresholds'][f'{region}|{month:02d}']={'n':len(values),'cutoffs':[quantile(values,q) for q in (.2,.4,.6,.8)]}
with open(a.output,'w') as f:json.dump(out,f,indent=2)
print('Wrote',len(out['thresholds']),'UNVALIDATED monthly region calibrations to',a.output)
