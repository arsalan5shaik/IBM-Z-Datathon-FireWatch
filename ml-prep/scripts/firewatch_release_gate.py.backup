#!/usr/bin/env python3
"""FireWatch historical statewide map integration gate; no retraining/calibration.

Invokes existing verified statewide inference and gridMET ERC audit scripts for
multiple historical dates, validates output schema/coverage, and writes a report.
Does not claim wildfire probability or seven-day forecast accuracy.
"""
import argparse, csv, hashlib, json, math, subprocess, sys
from datetime import date
from pathlib import Path

FIELDS={'cell_id','date','center_lat','center_lon','west_m','south_m','east_m','north_m','erc_g_raw','erc_g_display','data_status'}

def run(args):
    print('RUN:', ' '.join(map(str,args)),flush=True)
    subprocess.run(args,check=True)

def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

def validate_map(csv_path, expected_date, expected_grid, report):
    ids=set(); ok=missing=clipped=0
    with csv_path.open(newline='') as f:
        reader=csv.DictReader(f)
        if not FIELDS.issubset(reader.fieldnames or []):raise ValueError('Missing map CSV columns')
        for r in reader:
            ident=r['cell_id']
            if ident in ids:raise ValueError(f'Duplicate cell ID: {ident}')
            ids.add(ident)
            if r['date']!=expected_date:raise ValueError('Date inconsistency')
            for key in ['center_lat','center_lon','west_m','south_m','east_m','north_m']:
                if not math.isfinite(float(r[key])):raise ValueError(f'Invalid {key} for {ident}')
            if abs(float(r['east_m'])-float(r['west_m'])-3000)>0.02 or abs(float(r['north_m'])-float(r['south_m'])-3000)>0.02:
                raise ValueError(f'Cell not 3km square: {ident}')
            if r['data_status']=='ok':
                ok+=1
                raw=float(r['erc_g_raw']);display=float(r['erc_g_display'])
                if not (math.isfinite(raw) and math.isfinite(display)):raise ValueError('Non-finite prediction')
                if abs(display-max(0.,raw))>0.00002:raise ValueError('Display clipping inconsistent')
                clipped+=raw<0
            else:
                missing+=1
                if r['erc_g_display'] or r['erc_g_raw']:raise ValueError('Missing cell has a numeric score')
    if len(ids)!=expected_grid or ok!=report['valid_cells'] or missing!=report['excluded_cells']:
        raise ValueError('Map CSV and metadata counts disagree')
    if clipped!=report['negative_predictions_clipped_for_display']:
        raise ValueError('Clipping metadata disagrees')
    return {'grid_cells':len(ids),'scored':ok,'missing':missing,'clipped':clipped,'coverage':ok/len(ids), 'sha256':sha(csv_path)}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,default=Path.home()/'firewatch')
    p.add_argument('--dates',nargs='+',default=['2025-04-15','2025-07-09','2025-10-15','2025-12-15'])
    p.add_argument('--threads',type=int,default=2)
    p.add_argument('--min-coverage',type=float,default=0.99)
    p.add_argument('--min-r2',type=float,default=0.80,help='Diagnostic gate for individual historical day, not operational safety threshold')
    p.add_argument('--max-mae',type=float,default=9.0)
    p.add_argument('--max-abs-high-erc-bias',type=float,default=8.0)
    p.add_argument('--skip-generation',action='store_true',help='Audit preexisting map artifacts')
    a=p.parse_args();root=a.root.expanduser().resolve()
    model=root/'models/releases/firewatch_erc_v6_2023_2025/model.json'
    if not model.exists():raise FileNotFoundError(model)
    source=root/'scripts'; outdir=root/'data/map_3km';outdir.mkdir(parents=True,exist_ok=True)
    audits=[];errors=[]
    for d in a.dates:
        date.fromisoformat(d)
        print('\n=== DATE',d,'===',flush=True)
        if not a.skip_generation:
            run([sys.executable,str(source/'firewatch_statewide_3km_inference.py'),'--date',d,'--threads',str(a.threads)])
        report_path=outdir/f'firewatch_erc_3km_{d}_report.json'
        if not report_path.exists():raise FileNotFoundError(report_path)
        report=json.loads(report_path.read_text())
        if report.get('date')!=d or report.get('data_kind')!='historical_observed_weather_ERC_G_reconstruction':
            raise ValueError('Unexpected data provenance')
        file_report=validate_map(outdir/f'firewatch_erc_3km_{d}.csv',d,report['grid_cells_total'],report)
        run([sys.executable,str(source/'firewatch_statewide_accuracy_audit.py'),'--date',d])
        ajson=json.loads((outdir/f'firewatch_erc_3km_{d}_accuracy_audit.json').read_text())
        metric=ajson['overall'];high=ajson['by_actual_erc'].get('90_plus')
        checks={
          'coverage':file_report['coverage']>=a.min_coverage,
          'daily_r2':metric.get('r2') is not None and metric['r2']>=a.min_r2,
          'daily_mae':metric['mae']<=a.max_mae,
          'high_erc_bias':high is not None and abs(high['bias'])<=a.max_abs_high_erc_bias,
          'matching_evaluation':ajson['matched_valid_cells']==file_report['scored'],
        }
        for k,v in checks.items():
            if not v:errors.append(f'{d}: {k} check failed')
        audits.append({'date':d,'map_file':file_report,'erc_reconstruction':metric,
                       'erc_90_plus':high,'checks':checks,
                       'distinct_gridmet_pixels':ajson['source_pixel_count_for_evaluated_cells']})
        print('GATE:',checks,flush=True)
    final={
      'name':'firewatch_v6_statewide_historical_integration_gate',
      'model_sha256':sha(model),
      'model_kind':'ERC-G index reconstruction',
      'data_provenance':'historical observed weather (NOT a forecast)',
      'audits':audits,'passed_diagnostic_checks':not errors,'failed_checks':errors,
      'map_ready_for_historical_research_demo':not errors,
      'map_ready_for_live_seven_day_forecast':False,
      'danger_color_calibration_ready':False,
      'critical_limits':[
        'Do not label ERC-G as wildfire likelihood, ignition probability, or fire spread rate.',
        'Red/orange danger thresholds are NOT calibrated; map may display numeric ERC-G only.',
        '3 km cells are reporting geometry; gridMET pixels are coarser; grid boundary is provisional.',
        'Unscored cells must remain unknown (not safe).',
        'Accuracy measured against gridMET ERC-G (derived index), not wildfire occurrence.',
        'Near-zero aggregate bias can hide underprediction in high ERC bins.',
        '2025 results were examined during model iteration; not a pristine independent test.',
        'Archive weather is observed, not information known for a future forecast date.'
      ]}
    report_path=outdir/'firewatch_statewide_release_gate.json'
    report_path.write_text(json.dumps(final,indent=2)+'\n')
    print('\nHISTORICAL INTEGRATION GATE:', 'PASS' if not errors else 'REVIEW REQUIRED')
    print('LIVE FORECAST / RED DANGER DOTS: NOT APPROVED')
    print('REPORT:',report_path)
    if errors:
        print('FAILED:',*errors,sep='\n - ')
        raise SystemExit(2)

if __name__=='__main__':main()
