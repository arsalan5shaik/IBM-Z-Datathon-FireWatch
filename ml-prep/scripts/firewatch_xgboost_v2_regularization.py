import csv, json, os
from pathlib import Path
import numpy as np
import xgboost as xgb

ROOT=Path.home()/"firewatch"
DATA=ROOT/"data/processed/erc_weather_2024_full_year_sample.csv"
MODELS=ROOT/"models"
MODELS.mkdir(exist_ok=True)
OLD=MODELS/"firewatch_erc_xgboost_2024.json"
old=xgb.Booster(); old.load_model(str(OLD))
FEATURES=old.feature_names
if not FEATURES:
    raise RuntimeError("Saved model contains no feature names; inspect training script")
print("Features:",FEATURES,flush=True)
Xs={s:[] for s in ('train','validation')}; Ys={s:[] for s in Xs}
with DATA.open(newline='') as f:
    reader=csv.DictReader(f)
    required=set(FEATURES)|{'split','target_erc'}
    missing=required-set(reader.fieldnames or [])
    if missing: raise ValueError(f"CSV missing columns: {sorted(missing)}")
    for row in reader:
        split=row['split']
        if split not in Xs: continue
        try:
            values=[float(row[k]) if row[k].strip() else float('nan') for k in FEATURES]
            target=float(row['target_erc'])
        except ValueError: continue
        if not np.isfinite(target): continue
        Xs[split].append(values); Ys[split].append(target)
for s in Xs:
    Xs[s]=np.asarray(Xs[s],dtype=np.float32)
    Ys[s]=np.asarray(Ys[s],dtype=np.float32)
    print(s,Xs[s].shape,flush=True)
    if not len(Ys[s]): raise ValueError(f"No {s} rows")
tr=xgb.DMatrix(Xs['train'],label=Ys['train'],feature_names=FEATURES)
va=xgb.DMatrix(Xs['validation'],label=Ys['validation'],feature_names=FEATURES)

variants={
 'shallow_depth3': {'max_depth':3,'min_child_weight':8,'reg_lambda':10,'reg_alpha':1,'subsample':0.8,'colsample_bytree':0.8},
 'regularized_depth4':{'max_depth':4,'min_child_weight':15,'reg_lambda':20,'reg_alpha':2,'subsample':0.75,'colsample_bytree':0.8},
 'conservative_depth3':{'max_depth':3,'min_child_weight':25,'reg_lambda':30,'reg_alpha':3,'subsample':0.75,'colsample_bytree':0.7},
}
results=[]
for name,variant in variants.items():
    params={'objective':'reg:squarederror','tree_method':'hist','eval_metric':'rmse',
            'eta':0.04,'nthread':2,'seed':42,**variant}
    model=xgb.train(params,tr,num_boost_round=900,evals=[(va,'validation')],
                    early_stopping_rounds=40,verbose_eval=False)
    pred=model.predict(va,iteration_range=(0,model.best_iteration+1))
    err=pred-Ys['validation']
    stats={'name':name,'best_iteration':int(model.best_iteration),'val_mae':float(np.mean(np.abs(err))),
           'val_rmse':float(np.sqrt(np.mean(err**2))),'val_bias':float(np.mean(err)),
           'val_p95_absolute_error':float(np.percentile(np.abs(err),95))}
    results.append(stats)
    print(stats,flush=True)
    model.save_model(str(MODELS/f'firewatch_erc_xgb_v2_{name}.json'))
results.sort(key=lambda r:r['val_rmse'])
with (MODELS/'firewatch_xgb_v2_validation_comparison.json').open('w') as f:
    json.dump({'dataset':str(DATA),'selection_split':'validation (September 2024)',
               'test_used_for_selection':False,'features':FEATURES,'models':results},f,indent=2)
print('\nBest variant by validation RMSE:',results[0]['name'])
print('WARNING: This does NOT fix missing lagged fuel moisture or establish 2025 performance.')
