#!/usr/bin/env bash
# Contact sheet of every route at the current state: ./sheet.sh <tag>
tag=$1; mkdir -p shots/$tag
while IFS='|' read -r path name flags; do node shoot.mjs "$path" shots/$tag/$name.png $flags --full 2>&1 | grep -E "violation|page error|console error|failed request|ERR" | sed "s/^/$name: /"; done <<'ROUTES'
/|home|
/coin?mint=56rHmw6WonvGiumJRwhNPJ659x9tKhGF2utn35kYNVDV|coin|
/launchpad|launchpad|--session=user
/wallet-account|account|--session=user
/launched-tokens|tokens|--session=user
/analytics|analytics|
/agents|agents|
/gotchi|gotchi|
/docs|docs|
/user/mira_builds|creator|
/admin|admin|--session=admin --hash=tokens
/|home-mobile|--mobile
/coin?mint=56rHmw6WonvGiumJRwhNPJ659x9tKhGF2utn35kYNVDV|coin-mobile|--mobile
/launchpad|launchpad-mobile|--session=user --mobile
ROUTES
python3 - "$tag" <<'PY'
import sys
from PIL import Image
tag=sys.argv[1]
names=['home','coin','launchpad','account','tokens','analytics','agents','gotchi','docs','creator','admin']
tiles=[]
for n in names:
    im=Image.open(f'shots/{tag}/{n}.png').convert('RGB'); im=im.crop((0,0,1440,1200)).resize((720,600)); tiles.append(im)
mob=[]
for n in ['home-mobile','coin-mobile','launchpad-mobile']:
    im=Image.open(f'shots/{tag}/{n}.png').convert('RGB'); im=im.crop((0,0,826,1700)).resize((290,600)); mob.append(im)
sheet=Image.new('RGB',(720*4,600*3),(20,20,20))
for i,t in enumerate(tiles): sheet.paste(t,((i%4)*720,(i//4)*600))
x=3*720
for i,m in enumerate(mob): sheet.paste(m,(x+i*240,1200))
sheet.save(f'shots/{tag}/sheet.png'); print('sheet', sheet.size)
PY
