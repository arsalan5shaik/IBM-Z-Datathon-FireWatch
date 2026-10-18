#!/usr/bin/env python3
"""Explain one cell/timestamp row of a prepared feature CSV; contributions sum to RAW prediction."""
import argparse,csv,hashlib,json
from pathlib import Path
import numpy as np,xgboost as xgb
F=['temp_max_c','rh_min_pct','wind_mean_ms','precip_mm','elevation_mean_m','lat','lon','day_sin','day_cos','precip_7d_mm','precip_30d_mm','temp_mean_7d_c','rh_mean_7d_pct','dry_days_14d','wind_mean_7d_ms']
SHA='cb124badd47c898448c30500fe13f4827481e1986bd2a776605a0b99308b2e33'
a=argparse.ArgumentParser();a.add_argument('--model',required=True);a.add_argument('--features-csv',required=True);a.add_argument('--cell-id',required=True);a.add_argument('--timestamp',required=True);z=a.parse_args()
if hashlib.sha256(Path(z.model).read_bytes()).hexdigest()!=SHA:raise RuntimeError('Model checksum mismatch')
m=xgb.Booster();m.load_model(z.model)
if m.feature_names!=F:raise RuntimeError('Unexpected model feature order')
with open(z.features_csv,newline='') as f:
 r=csv.DictReader(f);matches=[row for row in r if row['cell_id']==z.cell_id and row['timestamp']==z.timestamp]
if len(matches)!=1:raise ValueError(f'Expected exactly one matching row; found {len(matches)}')
x=np.array([[float(matches[0][k]) for k in F]],dtype=np.float32)
if not np.isfinite(x).all():raise ValueError('Incomplete features')
d=xgb.DMatrix(x,feature_names=F)
raw=float(m.predict(d)[0]);c=m.predict(d,pred_contribs=True)[0]
if abs(float(sum(c))-raw)>0.001:raise RuntimeError('SHAP contributions not additive')
items=sorted([{'feature':k,'value':float(matches[0][k]),'shap_erc':float(c[i])} for i,k in enumerate(F)],key=lambda x:abs(x['shap_erc']),reverse=True)
print(json.dumps({'cell_id':z.cell_id,'timestamp':z.timestamp,'raw_erc_g':raw,'display_erc_g':max(0,raw),'baseline_erc_g':float(c[-1]),'top_contributors':items[:5],'all_contributors':items,'note':'SHAP explains ERC-G raw score, not ignition probability; no calibrated risk category'},indent=2))
