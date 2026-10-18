#!/usr/bin/env python3
"""Run ON LinuxONE after uploading/extracting this starter to embed the authentic frozen model and representative historical exports."""
from pathlib import Path
import hashlib,json,zipfile,sys
base=Path(__file__).resolve().parents[1];root=Path.home()/'firewatch'
model=root/'models/releases/firewatch_erc_v6_2023_2025/model.json'
expected='cb124badd47c898448c30500fe13f4827481e1986bd2a776605a0b99308b2e33'
if not model.exists():sys.exit('Missing frozen model: '+str(model))
if hashlib.sha256(model.read_bytes()).hexdigest()!=expected:sys.exit('STOP: frozen model SHA256 mismatch')
files={f'{base.name}/models/releases/firewatch_erc_v6_2023_2025/model.json':model}
for fn in ['features.json','metrics.json','manifest.json','smoke_predictions.csv']:
 p=model.parent/fn
 if p.exists():files[f'{base.name}/models/releases/firewatch_erc_v6_2023_2025/{fn}']=p
p=root/'data/map_3km/firewatch_erc_3km_2025-07-09.csv'
if p.exists():files[f'{base.name}/samples/HISTORICAL_2025-07-09_statewide.csv']=p
p=root/'data/map_3km/firewatch_erc_3km_2025-07-09_points.geojson'
if p.exists():files[f'{base.name}/samples/HISTORICAL_2025-07-09_points.geojson']=p
out=base.parent/'FireWatch_V6_FINAL_LinuxONE_verified.zip'
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for p in base.rglob('*'):
  if p.is_file():z.write(p,arcname=f'{base.name}/{p.relative_to(base)}')
 for arc,p in files.items():z.write(p,arcname=arc)
print('CREATED',out,'SIZE',out.stat().st_size,'MODEL SHA256 VERIFIED',expected)
