#!/usr/bin/env python3
"""Score precomputed EXACT 15-feature rows. This does NOT obtain weather forecasts.
Input CSV must contain cell_id,timestamp and the features in FEATURES_EXPECTED.json.
A timestamp is a valid ISO 8601 date/time with timezone offset for hourly data.
Output has no risk category because none is validated. SHAP additivity is to raw ERC.
"""
import argparse,csv,json,hashlib
from pathlib import Path
import numpy as np
import xgboost as xgb
F=['temp_max_c','rh_min_pct','wind_mean_ms','precip_mm','elevation_mean_m','lat','lon','day_sin','day_cos','precip_7d_mm','precip_30d_mm','temp_mean_7d_c','rh_mean_7d_pct','dry_days_14d','wind_mean_7d_ms']
SHA='cb124badd47c898448c30500fe13f4827481e1986bd2a776605a0b99308b2e33'
p=argparse.ArgumentParser();p.add_argument('--model',required=True);p.add_argument('--input',required=True);p.add_argument('--output',required=True);p.add_argument('--with-shap',action='store_true');a=p.parse_args()
model_path=Path(a.model)
if hashlib.sha256(model_path.read_bytes()).hexdigest()!=SHA:raise RuntimeError('Model SHA256 mismatch: NOT frozen V6')
m=xgb.Booster();m.load_model(str(model_path))
if m.feature_names!=F:raise RuntimeError('Model features or order mismatch')
with open(a.input,newline='') as f:
 r=csv.DictReader(f);needed={'cell_id','timestamp',*F}
 if not needed.issubset(r.fieldnames or []):raise ValueError('Input missing '+str(sorted(needed-set(r.fieldnames or []))))
 rows=list(r)
X=np.array([[float(row[k]) if row[k] else np.nan for k in F] for row in rows],dtype=np.float32)
valid=np.isfinite(X).all(axis=1)
raw=np.full(len(rows),np.nan);contrib=None
if valid.any():
 dm=xgb.DMatrix(X[valid],feature_names=F)
 raw[valid]=m.predict(dm)
 if a.with_shap:
  sv=m.predict(dm,pred_contribs=True,approx_contribs=False)
  if not np.allclose(sv.sum(axis=1),raw[valid],atol=1e-3,rtol=1e-4):raise RuntimeError('SHAP additivity error')
  contrib=np.full((len(rows),len(F)+1),np.nan);contrib[valid]=sv
with open(a.output,'w',newline='') as f:
 fields=['cell_id','timestamp','issued_at_utc','lead_day','forecast_source','erc_g_raw','erc_g_display','risk_category','data_status','model_version','data_kind']
 if a.with_shap:fields+=['shap_base_erc','shap_contributions_json']
 w=csv.DictWriter(f,fieldnames=fields);w.writeheader()
 for i,row in enumerate(rows):
  v=bool(valid[i]);out=dict(cell_id=row['cell_id'],timestamp=row['timestamp'],issued_at_utc=row.get('issued_at_utc',''),lead_day=row.get('lead_day',''),forecast_source=row.get('forecast_source',''),erc_g_raw=(round(float(raw[i]),5) if v else ''),erc_g_display=(round(max(0,float(raw[i])),5) if v else ''),risk_category='',data_status=('ok' if v else 'missing_required_features'),model_version='firewatch_erc_v6_2023_2025',data_kind='provided_feature_rows_unverified_provenance')
  if a.with_shap:out.update(shap_base_erc=round(float(contrib[i,-1]),6) if v else '',shap_contributions_json=json.dumps({k:round(float(contrib[i,j]),6) for j,k in enumerate(F)}) if v else '')
  w.writerow(out)
print(f'Output: {a.output}; total={len(rows)}, scored={int(valid.sum())}. No forecast-source validation performed.')
