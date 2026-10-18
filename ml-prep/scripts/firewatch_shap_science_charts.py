#!/usr/bin/env python3
"""Dependency-light FireWatch V6 SHAP science figures; native xgboost, numpy, stdlib.
Creates offline SVG dashboard, CSV, and science interpretation. Does not modify model.
"""
import argparse, csv, html, json, random, math
from pathlib import Path
import numpy as np
import xgboost as xgb

FEATURES=['temp_max_c','rh_min_pct','wind_mean_ms','precip_mm','elevation_mean_m','lat','lon','day_sin','day_cos','precip_7d_mm','precip_30d_mm','temp_mean_7d_c','rh_mean_7d_pct','dry_days_14d','wind_mean_7d_ms']
LABELS={'rh_mean_7d_pct':'7-day mean minimum humidity (%)','rh_min_pct':'Daily minimum humidity (%)','precip_30d_mm':'Trailing 30-day rainfall (mm)','precip_mm':'Daily rainfall (mm)','temp_mean_7d_c':'7-day mean max temperature (°C)','lon':'Longitude (°)','elevation_mean_m':'Elevation (m)','wind_mean_ms':'Daily mean wind (m/s)','wind_mean_7d_ms':'7-day mean wind (m/s)'}
INK='#16243b'; ORANGE='#e57531'; BLUE='#3574bb'; PALE='#eaf0f6'
def e(s): return html.escape(str(s))
def svg_begin(w,h,title): return [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" role="img" aria-label="{e(title)}">',f'<rect width="{w}" height="{h}" fill="white"/>']
def txt(x,y,s,size=13,color=INK,anchor='start',weight='normal'):
 return f'<text x="{x}" y="{y}" font-family="system-ui,Arial" font-size="{size}" text-anchor="{anchor}" fill="{color}" font-weight="{weight}">{e(s)}</text>'
def line(x1,y1,x2,y2,color='#b5c0cc',width=1): return f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{color}" stroke-width="{width}"/>'
def save_svg(path,parts): path.write_text('\n'.join(parts+['</svg>']),encoding='utf-8')
def bar_chart(path, features, imp):
 w,h=980,565; p=svg_begin(w,h,'Mean absolute SHAP feature importance');p.append(txt(30,40,'Global feature importance | mean absolute SHAP',22,weight='bold'))
 order=np.argsort(-imp); mx=max(float(max(imp)),1e-6)
 for rank,j in enumerate(order):
  y=81+rank*30; v=float(imp[j]);width=v/mx*540
  p += [txt(25,y+15,features[j],12),f'<rect x="288" y="{y}" width="540" height="19" rx="3" fill="{PALE}"/>',f'<rect x="288" y="{y}" width="{width:.1f}" height="19" rx="3" fill="{ORANGE}"/>',txt(843,y+15,f'{v:.3f} ERC',12)]
 p.append(txt(25,h-15,'Magnitude is not directional and does not establish causation.',12,'#526174'));save_svg(path,p)
def scatter(path,name,feature_values,shap_values,colour_vals=None):
 w,h=900,440;p=svg_begin(w,h,name);p.append(txt(32,36,name,21,weight='bold'))
 x=np.asarray(feature_values,dtype=float); y=np.asarray(shap_values,dtype=float); good=np.isfinite(x)&np.isfinite(y);x=x[good];y=y[good]
 if not len(x):return
 xlo,xhi=np.percentile(x,[0,100]);ylo,yhi=np.percentile(y,[0,100]);
 if xlo==xhi:xlo-=1;xhi+=1
 if ylo==yhi:ylo-=1;yhi+=1
 pad=(yhi-ylo)*.08;ylo-=pad;yhi+=pad
 left,right,top,bottom=96,865,63,365
 to_x=lambda v:left+(v-xlo)/(xhi-xlo)*(right-left)
 to_y=lambda v:bottom-(v-ylo)/(yhi-ylo)*(bottom-top)
 for f in np.linspace(0,1,5):
  yy=top+f*(bottom-top);value=yhi-f*(yhi-ylo);p.extend([line(left,yy,right,yy,'#e9edf3'),txt(left-12,yy+4,f'{value:.1f}',11,'#536070','end')])
 for f in np.linspace(0,1,6):
  xx=left+f*(right-left);p.append(txt(xx,bottom+20,f'{xlo+f*(xhi-xlo):.1f}',11,'#536070','middle'))
 if ylo<=0<=yhi:p.append(line(left,to_y(0),right,to_y(0),'#728092',1.5))
 for i,(xx,yy) in enumerate(zip(x,y)):
  color=ORANGE if yy>=0 else BLUE
  p.append(f'<circle cx="{to_x(xx):.2f}" cy="{to_y(yy):.2f}" r="2.5" fill="{color}" fill-opacity="0.43"/>')
 p.append(txt((left+right)/2,417,LABELS.get(name,name),13,anchor='middle'));p.append(txt(24,218,'SHAP (ERC)',12,anchor='middle'))
 save_svg(path,p)
def beeswarm(path,features,vals,X):
 w,h=1040,570;p=svg_begin(w,h,'SHAP distribution across observations');p.append(txt(20,36,'Distribution of SHAP contributions | orange = higher feature value',21,weight='bold'))
 order=np.argsort(-np.mean(np.abs(vals),axis=0))[:12]; z=np.max(np.abs(vals[:,order]));z=max(z,1)
 l,r=270,1015;center=(l+r)/2; scale=(r-l)*.43/z
 p.append(line(center,67,center,515,'#62758a',1.3))
 rand=np.random.default_rng(23)
 for t,j in enumerate(order):
  yy=89+t*36;p.append(txt(15,yy+4,features[j],12));f=X[:,j];lo,hi=np.percentile(f,[5,95]);den=max(hi-lo,1e-9)
  ids=rand.choice(len(f),size=min(750,len(f)),replace=False)
  for i in ids:
   c=np.clip((f[i]-lo)/den,0,1); red=int(58+c*170); blue=int(185-c*110); color=f'#{red:02x}68{blue:02x}'
   jitter=rand.uniform(-8,8);p.append(f'<circle cx="{center+vals[i,j]*scale:.1f}" cy="{yy+jitter:.1f}" r="2.1" fill="{color}" fill-opacity="0.58"/>')
 p.append(txt(640,553,'Negative impact  ←   SHAP contribution (ERC points)   →  Positive impact',12,anchor='middle'))
 save_svg(path,p)
def waterfall(path,features,values,base,pred,actual,date,cell,title):
 idx=np.argsort(-np.abs(values));top=idx[:10];other=float(np.sum(values[idx[10:]]));names=[features[j] for j in top]+['Other 5 features'];amounts=[float(values[j]) for j in top]+[other]
 w,h=1010,530;p=svg_begin(w,h,title);p.append(txt(25,36,title,21,weight='bold'));p.append(txt(25,59,f'{date} • {cell} • model={pred:.2f} • observed={actual:.2f} • baseline={base:.2f}',12,'#546478'))
 total=[base];
 for v in amounts:total.append(total[-1]+v)
 lo=min(min(total),actual,pred)-7;hi=max(max(total),actual,pred)+7
 x0,x1=280,976;px=lambda a:x0+(a-lo)/(hi-lo)*(x1-x0)
 for tick in np.linspace(lo,hi,7):p += [line(px(tick),80,px(tick),478,'#eff2f5'),txt(px(tick),497,f'{tick:.0f}',11,'#586779','middle')]
 for i,(name,v) in enumerate(zip(names,amounts)):
  y=88+i*33;left=min(px(total[i]),px(total[i+1]));width=max(abs(px(total[i+1])-px(total[i])),1);color=ORANGE if v>0 else BLUE
  p += [txt(20,y+15,name,12),f'<rect x="{left:.2f}" y="{y}" width="{width:.2f}" height="19" rx="2" fill="{color}"/>',txt(955,y+15,f'{v:+.2f}',11,color,'end')]
 p.append(txt(30,477,'Orange raises ERC; blue lowers ERC. Bars start from cumulative prior contributions.',11,'#57677a'));save_svg(path,p)
def bias_chart(path,pred,actual):
 w,h=900,440;p=svg_begin(w,h,'Prediction errors by actual ERC range');p.append(txt(30,36,'Mean prediction bias by observed ERC range',21,weight='bold'))
 bins=[('ERC < 30',actual<30),('30–59',(actual>=30)&(actual<60)),('60–89',(actual>=60)&(actual<90)),('ERC ≥ 90',actual>=90)]
 mx=max([abs(float(np.mean((pred-actual)[m]))) for _,m in bins if m.any()]+[1]); center=460;scale=300/mx
 p.append(line(center,70,center,350,'#748395',1.5))
 for i,(name,mask) in enumerate(bins):
  if not mask.any():continue
  v=float(np.mean((pred-actual)[mask]));y=90+i*66;x=min(center,center+v*scale);width=max(abs(v*scale),1)
  p += [txt(27,y+20,f'{name} (n={mask.sum():,})',14),f'<rect x="{x:.1f}" y="{y}" width="{width:.1f}" height="31" rx="4" fill="{ORANGE if v>=0 else BLUE}"/>',txt(center+v*scale+(8 if v>=0 else -8),y+20,f'{v:+.2f}',13,ORANGE if v>=0 else BLUE,'start' if v>=0 else 'end')]
 p.append(txt(450,410,'Negative = underprediction • Positive = overprediction',12,'#536478','middle'));save_svg(path,p)
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--model',default='models/firewatch_erc_multiyear_v6/model.json');ap.add_argument('--data',default='data/processed/erc_weather_2025_lagged_multiyear.csv');ap.add_argument('--outdir',default='models/firewatch_erc_multiyear_v6/shap/science');ap.add_argument('--sample',type=int,default=1800);ap.add_argument('--seed',type=int,default=42);ap.add_argument('--threads',type=int,default=2);a=ap.parse_args()
 if a.sample<10:ap.error('--sample must be >=10')
 m=xgb.Booster(params={'nthread':a.threads});m.load_model(a.model);features=m.feature_names or FEATURES
 if len(features)!=15:raise ValueError('Expected 15 features')
 rand=random.Random(a.seed);records=[];seen=0
 with open(a.data,newline='') as f:
  reader=csv.DictReader(f);needed=set(features)|{'date','cell_id','target_erc'}
  if not needed.issubset(reader.fieldnames):raise ValueError(f'Missing {needed-set(reader.fieldnames)}')
  for row in reader:
   if not '2025-07-01' <= row['date'] <= '2025-12-31':continue
   v=np.asarray([float(row[k]) for k in features],dtype=np.float32);target=float(row['target_erc'])
   if not np.isfinite(v).all() or not math.isfinite(target):continue
   record=(row['date'],row['cell_id'],target,v);seen+=1
   if len(records)<a.sample:records.append(record)
   else:
    j=rand.randrange(seen)
    if j<a.sample:records[j]=record
 if len(records)<10:raise ValueError('Too few eligible data rows')
 X=np.stack([r[3] for r in records]);actual=np.array([r[2] for r in records]);dm=xgb.DMatrix(X,feature_names=features)
 pred=m.predict(dm);contrib=m.predict(dm,pred_contribs=True,approx_contribs=False)
 error=float(np.max(np.abs(pred-contrib.sum(axis=1))));assert error<0.002,f'Additivity failure {error}'
 out=Path(a.outdir);out.mkdir(parents=True,exist_ok=True)
 imp=np.mean(np.abs(contrib[:,:-1]),axis=0)
 bar_chart(out/'01_global_importance.svg',features,imp)
 beeswarm(out/'02_shap_distribution.svg',features,contrib[:,:-1],X)
 for num,key in enumerate(['rh_mean_7d_pct','rh_min_pct','precip_30d_mm','temp_mean_7d_c','lon'],3):
  j=features.index(key);scatter(out/f'{num:02d}_dependence_{key}.svg',key,X[:,j],contrib[:,j])
 order=np.argsort(pred);chosen=[('Low',int(order[0])),('Typical',int(order[len(order)//2])),('High',int(order[-1]))]
 for n,(label,i) in enumerate(chosen,8):
  waterfall(out/f'{n:02d}_waterfall_{label.lower()}.svg',features,contrib[i,:-1],float(contrib[i,-1]),float(pred[i]),actual[i],records[i][0],records[i][1],f'{label} ERC prediction | SHAP waterfall')
 bias_chart(out/'11_bias_by_erc_range.svg',pred,actual)
 with (out/'science_shap_sample.csv').open('w',newline='') as f:
  writer=csv.writer(f);writer.writerow(['date','cell_id','observed_erc','predicted_erc','base_erc',*['value_'+z for z in features],*['shap_'+z for z in features]])
  for i,r in enumerate(records):writer.writerow([r[0],r[1],r[2],float(pred[i]),float(contrib[i,-1]),*map(float,X[i]),*map(float,contrib[i,:-1])])
 report={'sample_size':len(records),'eligible_rows':seen,'max_shap_additivity_error':error,'source':'2025 H2 observed-weather ERC-G reconstructions','mean_absolute_shap':{features[j]:float(imp[j]) for j in np.argsort(-imp)},'mean_error':float(np.mean(pred-actual))}
 (out/'science_shap_summary.json').write_text(json.dumps(report,indent=2))
 names=sorted(out.glob('*.svg'))
 doc=['<!doctype html><html><head><meta charset="utf-8"><title>FireWatch | SHAP Science Dashboard</title><style>body{font-family:system-ui;background:#f5f7fa;color:#16243b;max-width:1100px;margin:28px auto;padding:0 22px}section{background:#fff;border-radius:14px;padding:20px;margin:18px 0;box-shadow:0 2px 12px #09192b16}img{width:100%;height:auto}h1{margin-bottom:4px}.note{color:#516275}</style></head><body>',
 '<h1>FireWatch V6 — SHAP & Fire Science</h1>',f'<p class="note">Native TreeSHAP • July–Dec 2025 sample n={len(records):,} • Additivity error {error:.6g} ERC</p>',
 '<p>Interpretation: ERC-G is a fuel-moisture-related potential heat release index, not wildfire ignition probability or spread rate. SHAP indicates model attribution, not causal effects.</p>']
 for item in names:doc.append(f'<section><img src="{e(item.name)}" alt="{e(item.stem)}"></section>')
 doc.append('<section><h2>Science references & cautions</h2><p>NWCG: ERC increases as fuels dry; ERC does not use wind speed directly. The gridMET ERC product uses Fuel Model G. High humidity and recent precipitation generally increase fuel moisture and can reduce ERC.</p><p>Sources: <a href="https://www.nwcg.gov/publications/pms437/fire-danger/nfdrs-system-inputs-and-outputs">NWCG fire danger</a> · <a href="https://www.wildfire.gov/page/energy-release-component-erc">Wildfire.gov ERC</a> · <a href="https://www.climatologylab.org/gridmet.html">gridMET</a> · <a href="https://www-nwcg.fs2c.usda.gov/publications/pms425-1/11-weather-and-fuel-moisture">NWCG weather & fuel moisture</a></p><p>Model SHAP cannot validate wildfire occurrences. Correlated inputs share attribution; longitude may stand in for regional climate/fuel model bias. Audit 2025 forecast-time availability before making 7-day forecast claims.</p></section></body></html>')
 (out/'index.html').write_text('\n'.join(doc))
 print('Sampled:',len(records),'out of eligible:',seen);print('Max SHAP additivity error:',f'{error:.8f}');print('Charts:',len(names),'SVG files');print('Dashboard:',out/'index.html')
 print('Top features:');[print(f' {features[i]:24s} {imp[i]:.3f}') for i in np.argsort(-imp)[:8]]
if __name__=='__main__':main()
