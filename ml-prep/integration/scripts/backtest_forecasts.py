#!/usr/bin/env python3
"""Audits genuine archived issued-forecast model predictions against later-observed ERC-G reference.
Predictions CSV schema: cell_id,issued_at_utc,timestamp,lead_day,erc_g_raw,forecast_source
Reference CSV schema: cell_id,timestamp,erc_g_reference
STRICT: evidence of forecast provenance is caller-supplied; this script cannot verify provider archive itself.
Outputs per lead-day 1..7 R2 MAE RMSE signed bias + optional classification recall if threshold supplied.
"""
import argparse,csv,json,math,collections,datetime as dt
p=argparse.ArgumentParser();p.add_argument('--predictions',required=True);p.add_argument('--reference',required=True);p.add_argument('--output',required=True);p.add_argument('--high-reference-cutoff',type=float);p.add_argument('--source-manifest',required=True,help='JSON with provider, archived_run_id, issue_time_utc, retrieval_details and provenance');a=p.parse_args()
manifest=json.load(open(a.source_manifest))
for k in ('provider','archived_run_id','issue_time_utc','retrieval_details'):
 if not manifest.get(k):raise SystemExit('Missing forecast provenance: '+k)
ref={}
with open(a.reference,newline='') as f:
 for r in csv.DictReader(f):
  key=(r['cell_id'],r['timestamp']);assert key not in ref,'Reference duplicate';ref[key]=float(r['erc_g_reference'])
buckets=collections.defaultdict(list);count=0
with open(a.predictions,newline='') as f:
 for r in csv.DictReader(f):
  assert r.get('forecast_source') and r['forecast_source'] not in ('observed','historical_observed'), 'Missing forecast source'
  issue=dt.datetime.fromisoformat(r['issued_at_utc'].replace('Z','+00:00'));valid=dt.datetime.fromisoformat(r['timestamp'].replace('Z','+00:00'))
  assert issue.tzinfo and valid.tzinfo and valid>issue,'Non-future or timezone-naive data detected'
  lead=int(r['lead_day']);assert 1<=lead<=7
  if not r['erc_g_raw']:continue
  key=(r['cell_id'],r['timestamp'])
  if key not in ref:continue
  buckets[lead].append((float(r['erc_g_raw']),ref[key]));count+=1
report={'status':'COMPUTED_METRICS_NOT_CERTIFIED','forecast_provenance':manifest,'note':'Independence and issue-time leakage require separately documented dataset audit','per_lead_day':{},'matched_total':count}
for day in range(1,8):
 pairs=buckets[day]
 if not pairs:report['per_lead_day'][str(day)]={'n':0,'status':'missing_no_validation'};continue
 e=[x-y for x,y in pairs];n=len(e);mae=sum(abs(x) for x in e)/n;rmse=(sum(x*x for x in e)/n)**.5;bias=sum(e)/n;mean=sum(y for x,y in pairs)/n;den=sum((y-mean)**2 for x,y in pairs);r2=1-sum(x*x for x in e)/den if den else None
 item={'n':n,'r2':r2,'mae':mae,'rmse':rmse,'bias':bias}
 if a.high_reference_cutoff is not None:
  pos=[(x,y) for x,y in pairs if y>=a.high_reference_cutoff];item['high_reference_count']=len(pos);item['high_recall']=sum(x>=a.high_reference_cutoff for x,y in pos)/len(pos) if pos else None
 report['per_lead_day'][str(day)]=item
with open(a.output,'w') as f:json.dump(report,f,indent=2)
print('Wrote backtest:',a.output,'matched:',count,'days:',sorted(buckets))
