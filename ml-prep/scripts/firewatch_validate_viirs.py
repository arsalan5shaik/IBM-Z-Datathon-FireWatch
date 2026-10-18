#!/usr/bin/env python3
"""FireWatch external association audit: observed VIIRS hotspots vs predicted gridMET ERC-G.
Standard library, numpy, and native xgboost only. No sklearn or shap package.
Absence of VIIRS hotspot is not proof of no fire. This is not an ignition forecast validation.
"""
import argparse, csv, json, math
from collections import Counter, defaultdict
from pathlib import Path
import numpy as np
import xgboost as xgb

BINS = [(0,30,'0–29'),(30,60,'30–59'),(60,90,'60–89'),(90,float('inf'),'90+')]

def read_hotspots(path):
    pos = set()
    counts = Counter()
    for r in csv.DictReader(open(path, newline='')):
        if int(float(r['hotspot_detected'])) == 1:
            key = (r['cell_id'], r['observation_date'])
            pos.add(key)
            counts[key] += int(float(r.get('detection_count') or 1))
    return pos, counts

def get_covered_days(root):
    """Dates with at least one record in original California VIIRS archive.
    This is a conservative presence-of-data proxy, NOT actual satellite coverage verification.
    """
    coverage = set(); details = {}
    for year in (2024, 2025):
        p = root / 'data/raw' / f'FireWatch_california_{year}.csv'
        if not p.exists():
            print(f'WARNING: {p} not found. Skipping coverage proxy for {year}.')
            continue
        with p.open(newline='') as f:
            rd = csv.DictReader(f)
            candidates = rd.fieldnames or []
            date_col = next((c for c in ('acq_date', 'date', 'observation_date') if c in candidates), None)
            if date_col is None:
                print(f'WARNING: No acquisition-date column in {p}: {candidates}')
                continue
            n = 0
            for r in rd:
                d = r[date_col][:10]
                if d.startswith(str(year)):
                    coverage.add(d); n += 1
        details[str(year)] = {'dates_with_records':len([d for d in coverage if d.startswith(str(year))]), 'input_records':n}
    return coverage, details

def metrics(y, score):
    """Rank discrimination, not calibrated probability. Ties get half-credit."""
    y = np.asarray(y, dtype=np.int8)
    score = np.asarray(score, dtype=np.float64)
    n = len(y); npos=int(y.sum()); nneg=n-npos
    out={'n':n,'hotspot_cell_days':npos,'non_detected_cell_days':nneg,
         'hotspot_fraction':float(npos/n) if n else None}
    if not n or not npos or not nneg:
        out['roc_auc']=None; out['average_precision']=None; return out
    order=np.argsort(score,kind='mergesort')
    sorted_s=score[order]
    # AUROC using rank sums with exact average ranks for ties
    starts=np.r_[0, np.flatnonzero(np.diff(sorted_s))+1]
    ends=np.r_[starts[1:], n]
    ranks=np.empty(n,dtype=np.float64)
    for st,en in zip(starts, ends): ranks[st:en]=(st+1+en)/2.0
    rank_sum=ranks[np.argsort(order)][y==1].sum()
    out['roc_auc']=float((rank_sum-npos*(npos+1)/2)/(npos*nneg))
    # Average precision at *distinct thresholds* (tie-safe), sorted descending
    rev_order=np.argsort(-score,kind='mergesort'); ys=y[rev_order]; ss=score[rev_order]
    last=np.r_[np.flatnonzero(np.diff(ss)), n-1]
    tp=np.cumsum(ys)[last]; k=last+1
    recall=tp/npos; precision=tp/k
    out['average_precision']=float(np.sum(np.diff(np.r_[0.0,recall])*precision))
    return out

def main():
    a=argparse.ArgumentParser()
    a.add_argument('--root',default=str(Path.home()/'firewatch'))
    a.add_argument('--model',default='models/firewatch_erc_multiyear_v6/model.json')
    a.add_argument('--hotspots',default='data/processed/hotspot_cell_days_2024_2025.csv')
    a.add_argument('--data',nargs='+',default=['data/processed/erc_weather_2024_lagged_multiyear.csv','data/processed/erc_weather_2025_lagged_multiyear.csv'])
    a.add_argument('--outdir',default='models/firewatch_erc_multiyear_v6/viirs_validation')
    a.add_argument('--threads',type=int,default=2)
    a.add_argument('--no-coverage-proxy',action='store_true',help='Include all days even when no raw VIIRS records exist (not recommended)')
    args=a.parse_args()
    root=Path(args.root)
    def absp(p):
        path=Path(p);return path if path.is_absolute() else root/path
    out=absp(args.outdir);out.mkdir(parents=True,exist_ok=True)
    pos,_=read_hotspots(absp(args.hotspots))
    observed_dates,coverage_details=get_covered_days(root)
    print('Positive VIIRS cell-days in source:',len(pos),flush=True)
    if not observed_dates and not args.no_coverage_proxy:
        raise SystemExit('No VIIRS raw acquisition dates found. Aborting: refusing to silently treat unavailable satellite days as no-detection days. Use --no-coverage-proxy only if coverage has been independently verified.')
    booster=xgb.Booster(params={'nthread':args.threads});booster.load_model(str(absp(args.model)))
    feats=booster.feature_names
    if not feats:raise SystemExit('Saved model has no feature_names; cannot safely align feature columns.')
    print('Model features:',feats,flush=True)
    rows=[]; skip=Counter(); seen_cell_dates=set()
    for p in args.data:
        fp=absp(p)
        with fp.open(newline='') as f:
            reader=csv.DictReader(f)
            needed=['cell_id','date','target_erc']+feats
            missing=[x for x in needed if x not in (reader.fieldnames or [])]
            if missing:raise SystemExit(f'{fp} missing {missing}')
            for r in reader:
                date=r['date']; cell=r['cell_id']
                if (cell,date) in seen_cell_dates:
                    raise SystemExit(f'Duplicate cell-date observation detected: {cell} {date}; aborting to avoid inflated metrics.')
                seen_cell_dates.add((cell,date))
                if not args.no_coverage_proxy and date not in observed_dates:
                    skip['day_without_raw_VIIRS_records']+=1;continue
                try:
                    values=[float(r[x]) for x in feats]
                    target=float(r['target_erc'])
                    if not np.isfinite(values).all() or not math.isfinite(target):raise ValueError('nonfinite')
                except (ValueError,TypeError):skip['invalid_features']+=1;continue
                rows.append((cell,date,target,values, int((cell,date) in pos)))
        print('Read',fp.name,'total eligible rows so far:',len(rows),flush=True)
    if not rows:raise SystemExit('Zero eligible observations. Check file paths and date coverage.')
    X=np.asarray([r[3] for r in rows],dtype=np.float32)
    pred=booster.predict(xgb.DMatrix(X,feature_names=feats))
    target=np.array([r[2] for r in rows],dtype=np.float32)
    label=np.array([r[4] for r in rows],dtype=np.int8)
    # descriptive only: exclude computed negatives on days without any statewide detections; raw-data presence remains an imperfect proxy.
    report={'method':'Retrospective association of predicted ERC-G with observed VIIRS active-fire detection; NOT ignition probability, causal effect, or seven-day forecast skill',
            'model':str(absp(args.model)),'features':feats,'source_hotspot_positive_cell_days':len(pos),
            'coverage_proxy':coverage_details,'excluded':dict(skip), 'eligible_rows':len(rows),
            'overlap_positive_cell_days':int(label.sum()),'unmatched_positive_cell_days':len(pos)-int(label.sum()),
            'observed_erc':metrics(label,target),'predicted_erc':metrics(label,pred)}
    print('\n=== EXTERNAL ASSOCIATION AUDIT ===',flush=True)
    print('Eligible:',len(rows),'with VIIRS detections:',int(label.sum()),'observed-positive fraction:',f'{label.mean():.4%}')
    print('Predicted ERC AUROC:',report['predicted_erc']['roc_auc'],'average precision:',report['predicted_erc']['average_precision'])
    print('Reference ERC AUROC:',report['observed_erc']['roc_auc'],'average precision:',report['observed_erc']['average_precision'])
    print('Skipped:',dict(skip))
    bybin=[]
    for lo,hi,name in BINS:
        mask=(pred>=lo)&(pred<hi)
        cnt=int(mask.sum()); num=int(label[mask].sum());rate=num/cnt if cnt else None
        bybin.append({'predicted_ERC_range':name,'cell_days':cnt,'VIIRS_detected_cell_days':num,'detected_fraction':rate})
        print(f'{name:6s} | n={cnt:7,d} VIIRS+={num:5,d} detection fraction={rate:.4%}' if rate is not None else f'{name} empty')
    report['by_predicted_erc_range']=bybin
    with (out/'detection_rate_by_erc.csv').open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=list(bybin[0]));w.writeheader();w.writerows(bybin)
    # Month-level stratification; helps expose season-only confounding
    bymonth=defaultdict(list)
    for i,r in enumerate(rows):bymonth[r[1][:7]].append(i)
    monthrows=[]
    for m,ii in sorted(bymonth.items()):
        ix=np.array(ii,dtype=np.int32); met=metrics(label[ix],pred[ix]);
        monthrows.append({'month':m,**met})
    with (out/'association_by_month.csv').open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=list(monthrows[0]));w.writeheader();w.writerows(monthrows)
    # Same cell + year-month controls for positives and negative observations: observational matched contrast.
    groups=defaultdict(lambda:[[],[]])
    for i,(cell,date,*_) in enumerate(rows):groups[(cell,date[:7])][int(label[i])].append(i)
    matched=[]; nmatched_positive=0
    for key, (negative,positive) in groups.items():
        if not negative or not positive:continue
        ip=np.array(positive);inn=np.array(negative)
        nmatched_positive+=len(ip)
        matched.append((len(ip),float(np.mean(pred[ip])-np.mean(pred[inn])),float(np.mean(target[ip])-np.mean(target[inn]))))
    report['same_cell_same_month_contrast']={'number_of_strata':len(matched),'positive_cell_days_in_strata':nmatched_positive,
        'weighted_predicted_ERC_difference_detected_minus_nondetected':float(np.average([z[1] for z in matched],weights=[z[0] for z in matched])) if matched else None,
        'weighted_reference_ERC_difference_detected_minus_nondetected':float(np.average([z[2] for z in matched],weights=[z[0] for z in matched])) if matched else None,
        'interpretation':'Observational within-location/month association; NOT causal and can be affected by persistent fires and satellite detectability.'}
    print('Same cell-month matched strata:',len(matched),'positive cell-days:',nmatched_positive)
    print('Matched predicted ERC difference:',report['same_cell_same_month_contrast']['weighted_predicted_ERC_difference_detected_minus_nondetected'])
    (out/'validation_report.json').write_text(json.dumps(report,indent=2,allow_nan=False))
    print('Saved:',out/'validation_report.json',out/'detection_rate_by_erc.csv',out/'association_by_month.csv',sep='\n')

if __name__=='__main__':main()
