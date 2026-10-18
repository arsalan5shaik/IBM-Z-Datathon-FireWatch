#!/usr/bin/env python3
"""FireWatch V6 reproducibility / integration preflight. Run in extracted final handoff on LinuxONE.
Synthetic data tests are software smoke tests ONLY, not scientific forecast validation.
"""
import csv, datetime as dt, hashlib, json, math, os, pathlib, subprocess, sys, tempfile, zipfile

ROOT = pathlib.Path(__file__).resolve().parents[0]
MODEL = ROOT / 'models/releases/firewatch_erc_v6_2023_2025/model.json'
SCRIPTS = ROOT / 'scripts'
EXPECTED = 'cb124badd47c898448c30500fe13f4827481e1986bd2a776605a0b99308b2e33'
F = ['temp_max_c','rh_min_pct','wind_mean_ms','precip_mm','elevation_mean_m','lat','lon','day_sin','day_cos','precip_7d_mm','precip_30d_mm','temp_mean_7d_c','rh_mean_7d_pct','dry_days_14d','wind_mean_7d_ms']
results=[]
def check(name, fn):
    try:
        msg=fn()
        results.append((name,'PASS',msg or ''))
        print('PASS',name,':',msg or '')
    except Exception as e:
        results.append((name,'FAIL',str(e)))
        print('FAIL',name,':',e)

def run(*args):
    result=subprocess.run([sys.executable, str(SCRIPTS/args[0]), *map(str,args[1:])],capture_output=True,text=True)
    if result.returncode: raise RuntimeError((result.stdout+'\n'+result.stderr)[-1500:])
    return result.stdout.strip()

def readcsv(path):
    with open(path,newline='') as f:return list(csv.DictReader(f))

def artifact():
    assert MODEL.is_file(), 'Final weights absent. Run assembler on LinuxONE and extract final ZIP.'
    digest=hashlib.sha256(MODEL.read_bytes()).hexdigest()
    assert digest==EXPECTED, f'Model fingerprint mismatch: {digest}'
    for s in ('forecast_daily_features.py','predict_feature_rows.py','explain_cell.py','calibrate_categories.py','apply_categories.py','backtest_forecasts.py'):
        assert (SCRIPTS/s).is_file(), 'Script missing: '+s
    return 'verified model SHA256 and six pipeline scripts'
check('Release files and V6 fingerprint',artifact)

def model_check():
    import xgboost as xgb
    m=xgb.Booster();m.load_model(str(MODEL))
    assert m.feature_names==F, f'Unexpected feature order: {m.feature_names}'
    splits=m.get_score(importance_type='weight')
    return f'XGBoost {xgb.__version__}; {len(F)} ordered inputs; wind split counts: daily={splits.get("wind_mean_ms",0)}, 7-day={splits.get("wind_mean_7d_ms",0)}'
check('Model loads / feature order / wind splits',model_check)

with tempfile.TemporaryDirectory(prefix='fw-preflight-') as d:
    tmp=pathlib.Path(d)
    weather=tmp/'daily_weather.csv'
    cols=['cell_id','date','source','issued_at_utc','temp_max_c','rh_min_pct','wind_mean_ms','precip_mm','elevation_mean_m','lat','lon']
    issue=dt.date(2025,7,1)
    with weather.open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=cols);w.writeheader()
        for cell,lat,lon in [('CELL_A',37.0,-120.0),('CELL_B',38.0,-119.0)]:
            for j in range(-29,8):
                day=issue+dt.timedelta(days=j)
                w.writerow({'cell_id':cell,'date':day.isoformat(),'source':'observed' if j<=0 else 'forecast',
                    'issued_at_utc':'2025-07-01T00:00:00Z' if j>0 else '',
                    'temp_max_c':26+j*.1,'rh_min_pct':25+abs(j)%20,'wind_mean_ms':3.,'precip_mm':0.2 if j%6 else 2.,
                    'elevation_mean_m':400,'lat':lat,'lon':lon})
    features=tmp/'forecast_features.csv'; preds=tmp/'predictions.csv'; calref=tmp/'cal_ref.csv'; calfile=tmp/'calibration.json'; categories=tmp/'categories.csv'; ref=tmp/'reference.csv'; manifest=tmp/'forecast_manifest.json'; backtest=tmp/'backtest.json'
    def feat_check():
        run('forecast_daily_features.py','--weather',weather,'--output',features,'--issue-date',issue.isoformat())
        rows=readcsv(features)
        assert len(rows)==14, f'Expected 14 rows, got {len(rows)}'
        assert set(int(r['lead_day']) for r in rows)==set(range(1,8))
        assert set(F)<=set(rows[0]);assert all(r['issued_at_utc'] for r in rows)
        return '2 synthetic cells x 7 daily leads; all features present; no hourly claim'
    check('Seven-day weather feature engineering',feat_check)
    def predict_check():
        run('predict_feature_rows.py','--model',MODEL,'--input',features,'--output',preds,'--with-shap')
        rows=readcsv(preds)
        assert len(rows)==14 and all(r['data_status']=='ok' for r in rows)
        for r in rows:
            assert math.isfinite(float(r['erc_g_raw']))
            assert float(r['erc_g_display'])>=0
            c=json.loads(r['shap_contributions_json'])
            assert abs(sum(c.values())+float(r['shap_base_erc'])-float(r['erc_g_raw']))<.005
        return '14 V6 predictions, no NaN, display clipping, SHAP additivity'
    check('Frozen model inference and row-level SHAP',predict_check)
    def click_check():
        out=run('explain_cell.py','--model',MODEL,'--features-csv',features,'--cell-id','CELL_A','--timestamp','2025-07-02T00:00:00Z')
        result=json.loads(out); assert result['cell_id']=='CELL_A' and len(result['top_contributors'])==5
        assert math.isfinite(result['raw_erc_g'])
        return 'selected cell/date returns top 5 drivers and baseline'
    check('Click-to-explain dynamic SHAP',click_check)
    def calibration_check():
        with calref.open('w',newline='') as f:
            w=csv.DictWriter(f,fieldnames=['region','month','erc_g_reference']);w.writeheader()
            for i in range(100):w.writerow({'region':'CA_TEST','month':7,'erc_g_reference':i+1})
        run('calibrate_categories.py','--reference',calref,'--output',calfile,'--min-rows',50)
        cal=json.loads(calfile.read_text())
        assert cal['status']=='PROVISIONAL_NOT_VALIDATED' and len(cal['thresholds']['CA_TEST|07']['cutoffs'])==4
        return 'five experimental quantile categories; correctly marked UNVALIDATED'
    check('Category calibration',calibration_check)
    def category_apply_check():
        source=tmp/'categorize_input.csv'
        with source.open('w',newline='') as f:
            rows=readcsv(preds);fields=list(rows[0]);fields.append('region')
            w=csv.DictWriter(f,fieldnames=fields);w.writeheader()
            for r in rows:r['region']='CA_TEST';w.writerow(r)
        run('apply_categories.py','--predictions',source,'--calibration',calfile,'--output',categories,'--allow-provisional')
        rows=readcsv(categories)
        assert len(rows)==14 and all(r['risk_category'] in ['Low','Moderate','High','Very High','Extreme'] for r in rows)
        assert all(r['risk_category_status']=='EXPERIMENTAL_NOT_VALIDATED' for r in rows)
        return 'all 14 categorized as experimental (NOT validated fire warnings)'
    check('Apply five experimental labels',category_apply_check)
    def forecast_contract_check():
        rows=readcsv(preds); needed={'issued_at_utc','lead_day','forecast_source'}
        missing=needed-set(rows[0].keys())
        assert not missing, 'Predictor dropped provenance columns needed by backtest: '+', '.join(sorted(missing))
        return 'prediction output retains issue time, forecast source, lead day'
    check('Prediction-to-backtest contract',forecast_contract_check)
    def backtest_check():
        rows=readcsv(preds); bykey={(r['cell_id'],r['timestamp']):r for r in rows}
        p=tmp/'archived_simulated_forecast_predictions.csv'
        with p.open('w',newline='') as f:
            fields=['cell_id','timestamp','issued_at_utc','lead_day','forecast_source','erc_g_raw']
            w=csv.DictWriter(f,fieldnames=fields);w.writeheader()
            for r in rows:
                w.writerow({'cell_id':r['cell_id'],'timestamp':r['timestamp'],'issued_at_utc':'2025-07-01T00:00:00Z',
                    'lead_day':(dt.date.fromisoformat(r['timestamp'][:10])-issue).days,'forecast_source':'SYNTHETIC_SMOKE_ONLY','erc_g_raw':r['erc_g_raw']})
        with ref.open('w',newline='') as f:
            w=csv.DictWriter(f,fieldnames=['cell_id','timestamp','erc_g_reference']);w.writeheader()
            for r in rows:w.writerow({'cell_id':r['cell_id'],'timestamp':r['timestamp'],'erc_g_reference':float(r['erc_g_raw'])+3})
        manifest.write_text(json.dumps({'provider':'SYNTHETIC_SMOKE_ONLY','archived_run_id':'FAKE_TEST_NOT_EVIDENCE','issue_time_utc':'2025-07-01T00:00:00Z','retrieval_details':'Generated test fixtures, NOT actual archived forecasts'}))
        run('backtest_forecasts.py','--predictions',p,'--reference',ref,'--source-manifest',manifest,'--output',backtest)
        data=json.loads(backtest.read_text())
        assert data['matched_total']==14 and set(data['per_lead_day'])==set(map(str,range(1,8)))
        return '7 lead-day metric reports, SYNTHETIC TEST ONLY, not actual forecast validation'
    check('Forecast backtest software logic',backtest_check)

report={'status':'SOFTWARE_PREFLIGHT_ONLY_NOT_FORECAST_VALIDATION','checks':[{'test':n,'status':s,'detail':m} for n,s,m in results], 'passed':sum(s=='PASS' for _,s,_ in results),'failed':sum(s!='PASS' for _,s,_ in results),'scientific_forecast_validation':'NOT COMPLETED','danger_category_validation':'NOT COMPLETED'}
out=ROOT/'firewatch_preflight_results.json'
out.write_text(json.dumps(report,indent=2)+'\n')
print('\nPREFLIGHT:',report['passed'],'PASS,',report['failed'],'FAIL; report:',out)
sys.exit(1 if report['failed'] else 0)
