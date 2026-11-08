import {coinImage} from './coin-image.mjs';
import {createQuoteLabel} from './quote-logos.mjs';
import {createLaunchAmmBadge} from './amm-branding.mjs';
import { bootPage } from './navigation.mjs';
import { createWorkspaceShell } from './workspace-shell.js';
import { createExploreSearch } from './explore-search.mjs';
import { createExploreCard, exploreCardVersion, exploreAge, exploreFilters, exploreMoney, exploreNumber, isRobinhood, robinhoodPairLabel } from './explore-view.mjs';

const FEED_REFRESH_MS=60000, LAUNCH_CHECK_MS=10000;
// Only public discovery data survives same-document navigation, for two minutes.
// Wallet/session data and transaction state never enter this snapshot.
const publicSnapshots=new WeakMap(),SNAPSHOT_MS=120000;
const STAGES=['graduated','moving','new','all'];
// The fallback avatar for the centerfold, the bouncing list and the biggest racks.
const FALLBACK_ICON='/brand-icon.svg?v=54';
const MODES=['new','moving','graduated','oldest','volume','recentBuys','all'];
const TITLES={graduated:'graduated coins',moving:'coins moving on up',new:'new launches',all:'coins'};
const DEFAULTS={search:'',category:'all',launchMode:'all',age:'all',chain:'all'};
const CHAIN_KEY='curve.explore.chain';
const feedFilters=raw=>{const parsed=exploreFilters(new URLSearchParams(raw));return {search:parsed.search,category:parsed.category,launchMode:parsed.launchMode,age:parsed.age,chain:parsed.chain};};
/** The viewer's last chain choice (Solana | Robinhood | All) comes back on the next visit unless the URL says otherwise. */
const rememberedChain=win=>{try{const v=win?.localStorage?.getItem(CHAIN_KEY);return ['all','solana','robinhood'].includes(v)?v:null;}catch{return null;}};
const rememberChain=(win,chain)=>{try{if(chain&&chain!=='all')win?.localStorage?.setItem(CHAIN_KEY,chain);else win?.localStorage?.removeItem(CHAIN_KEY);}catch{/* a convenience */}};
// A page fills whole grid rows: 24 cards for the 4-, 3-, 2- and 1-column layouts (≥1200, ≥900, ≥560,
// phones), 20 for the 5-column band at ≥1560 (explore.css). The server accepts 1–40; the size is chosen
// once per page view.
export const explorePageSize=width=>Number.isFinite(width)&&width>=1560?20:24;
// Empty states: a Gotchi peeks in (lazy module; decorative) with a short line of copy per cohort.
const EMPTY_GOTCHI={new:['fomogotchi',1,'Fomogotchi is refreshing the feed.'],moving:['pumpgotchi',2,'Pumpgotchi is warming up the curve.'],graduated:['pumpgotchi',3,'Pumpgotchi is polishing the diplomas.'],all:['fomogotchi',2,'Fomogotchi is refreshing the feed.'],error:['fomogotchi',1,'Fomogotchi is checking the wires.']};
// Compact price text for chart labels: 3 significant digits below 1, up to 2 decimals above.
// Narrow charts write tiny prices in the usual DEX shorthand (0.0₆342 = 0.000000342) so the axis stays slim.
const SUBSCRIPT='₀₁₂₃₄₅₆₇₈₉';
const compactPrice=(value,tight=false)=>{const n=Number(value);if(!Number.isFinite(n))return '—';const abs=Math.abs(n),sign=n<0?'-':'';if(abs===0)return '0';if(abs>=1000)return n.toLocaleString('en-US',{maximumFractionDigits:0});if(abs>=1)return n.toLocaleString('en-US',{maximumFractionDigits:abs>=100?1:2});const zeros=-Math.floor(Math.log10(abs))-1;if(tight&&zeros>=4)return sign+'0.0'+String(zeros).replace(/\d/g,d=>SUBSCRIPT[d])+String(Math.round(abs*10**(zeros+3))).slice(0,3);if(abs<1e-6)return Number(n.toPrecision(3)).toFixed(Math.min(14,zeros+3)).replace(/0+$/,'');return String(Number(n.toPrecision(3)));};
const timeLabel=(ms,span)=>{const date=new Date(Number(ms));if(Number.isNaN(date.getTime()))return '';try{return span<=36*3600000?date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):date.toLocaleDateString([],{month:'short',day:'numeric'});}catch{return '';}};
const niceStep=raw=>{if(!(raw>0))return 0;const power=10**Math.floor(Math.log10(raw)),unit=raw/power;return (unit<1.5?1:unit<3?2:unit<7?5:10)*power;};

export function createExplorePage({document,window,fetcher=fetch,clock=Date.now,setTimer=setInterval,clearTimer=clearInterval,shell=createWorkspaceShell,random=Math.random,pageSize=explorePageSize(Number(window?.innerWidth))}={}) {
  const pageRoot=document.querySelector('main'),$=id=>pageRoot.querySelector('[id="'+id+'"]'),el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined&&text!==null)node.textContent=String(text);if(cls)node.className=cls;return node;};
  let filters=feedFilters(window.location.search),disposed=false,generation=0,totalCoins=null,selectedStage='new';
  if(!new URLSearchParams(window.location.search).has('chain')){const chain=rememberedChain(window);if(chain)filters={...filters,chain};}
  // v71.43: with Robinhood Chain off this host, the feed is Solana's whatever the URL or the memory says.
  const robinhoodOn=document.body?.dataset?.robinhood!=='off';if(!robinhoodOn)filters={...filters,chain:'solana'};
  const saved=publicSnapshots.get(document),snapshot=saved&&clock()-saved.at>=0&&clock()-saved.at<SNAPSHOT_MS&&JSON.stringify(saved.filters)===JSON.stringify(filters)?saved:null;
  const pageLimit=Number.isInteger(pageSize)&&pageSize>=1&&pageSize<=40?pageSize:24,controllers=new Set(),sections=Object.fromEntries(STAGES.map(stage=>[stage,{offset:0,limit:pageLimit,total:0,nextOffset:null,busy:false,promise:null,controller:null,request:0,next:0,warmups:0,version:'',cards:new Map(),data:null,error:''}]));
  const cardVersions=new WeakMap(),gotchis=new Set(),charts=new WeakMap();let indicatorObserver=null,chartObserver=null,swapTimer=null;
  const changed=()=>Object.keys(DEFAULTS).some(key=>filters[key]!==DEFAULTS[key]);
  const visibleStages=()=>[['oldest','volume','recentBuys','all'].includes(selectedStage)?'all':selectedStage];
  const sort=()=>['oldest','volume','recentBuys'].includes(selectedStage)?selectedStage:'newest';
  const refreshDelay=(data,warmups=0)=>{if(data?.refreshing!==true||warmups>=6)return FEED_REFRESH_MS;const delay=Math.min(15000,Math.max(3000,Number(data?.refreshMs)||3000)*2**warmups);return delay+Math.floor(Math.max(0,Math.min(1,Number(random())||0))*Math.min(3000,delay/4));};
  const api=async(path,controller)=>{
    const timeout=window.setTimeout(()=>controller.abort(),15000);
    try{const response=await fetcher(path,{method:'GET',credentials:'same-origin',signal:controller.signal});const data=await response.json();if(!response.ok)throw Object.assign(Error('Coin data is temporarily unavailable.'),{status:response.status,retryAfterMs:Number(data?.retryAfterMs)||30000});return data;}finally{window.clearTimeout(timeout);}
  };
  let highlightsNext=0,highlightsBusy=false,highlightWarmups=0,updatesNext=0,updatesBusy=false,updatesVersion=null,launchRefreshPending=false;
  // The detector reads a host-wide cached public catalogue, never token RPCs.
  // Prices still refresh every minute if there are no catalogue changes.
  async function detectLaunches(){
    if(disposed||document.hidden||search.isOpen()||updatesBusy||clock()<updatesNext)return;
    updatesBusy=true;updatesNext=clock()+LAUNCH_CHECK_MS;const controller=new AbortController();controllers.add(controller);
    try{const data=await api('/api/explore/updates',controller);if(disposed)return;
      if(data?.stale===true)return;
      if(typeof data?.version!=='string'||!/^[a-f0-9]{64}$/.test(data.version))throw Error('Invalid launch update');
      if(updatesVersion!==null&&data.version!==updatesVersion)launchRefreshPending=true;
      updatesVersion=data.version;updatesNext=clock()+LAUNCH_CHECK_MS;
    }catch{updatesNext=clock()+FEED_REFRESH_MS;}
    finally{controllers.delete(controller);updatesBusy=false;if(!disposed)await refreshDetectedLaunches();}
  }
  function refreshDetectedLaunches(){
    if(!launchRefreshPending||disposed||document.hidden||search.isOpen()||visibleStages().some(stage=>sections[stage].busy))return;
    launchRefreshPending=false;for(const state of Object.values(sections))state.next=0;highlightsNext=0;
    return Promise.allSettled([highlights(true),...visibleStages().map(stage=>load(stage,true))]);
  }
  function replaceIfChanged(root,nodes){
    if(root.childNodes.length===nodes.length&&nodes.every((node,index)=>root.childNodes[index].isEqualNode(node)))return;
    const focused=document.activeElement,href=root.contains(focused)?focused?.getAttribute('href'):null;
    root.replaceChildren(...nodes);
    if(href)Array.from(root.querySelectorAll('a[href]')).find(node=>node.getAttribute('href')===href)?.focus({preventScroll:true});
  }
  function reconcileCards(stage,coins){
    const state=sections[stage],grid=$(`explore-${stage}-grid`),next=new Map(),focused=document.activeElement,focusedMint=grid.contains(focused)?focused?.dataset?.mint:null;
    for(const coin of coins){
      const version=exploreCardVersion(coin,{stage});if(!version||next.has(coin.mint))continue;
      const old=state.cards.get(coin.mint);
      if(old&&cardVersions.get(old)===version){next.set(coin.mint,old);continue;}
      const fresh=createExploreCard(document,coin,{stage,now:clock()}),node=old||fresh;
      if(old&&!old.isEqualNode(fresh)){
        // Preserve the focused card anchor and its loaded avatar during price updates.
        const avatar=old.querySelector('.explore-coin-image>img'),newAvatar=fresh.querySelector('.explore-coin-image>img');
        if(avatar&&newAvatar&&avatar.getAttribute('src')===newAvatar.getAttribute('src')){const fallback=fresh.querySelector('.explore-coin-image>span');avatar.onerror=()=>{avatar.remove();if(fallback)fallback.hidden=false;};newAvatar.replaceWith(avatar);}
        old.replaceChildren(...fresh.childNodes);old.setAttribute('aria-label',fresh.getAttribute('aria-label'));
      }
      cardVersions.set(node,version);next.set(coin.mint,node);
    }
    if(!next.size)replaceIfChanged(grid,[empty(stage)]);
    else{
      let cursor=grid.firstElementChild;
      for(const node of next.values()){if(cursor===node){cursor=cursor.nextElementSibling;continue;}grid.insertBefore(node,cursor);}
      while(cursor){const remove=cursor;cursor=cursor.nextElementSibling;remove.remove();}
    }
    state.cards=next;if(focusedMint&&next.has(focusedMint)&&document.activeElement!==next.get(focusedMint))next.get(focusedMint).focus({preventScroll:true});
  }
  const coinLink=coin=>{const a=el('a',null,'explore-mini-coin');a.href=typeof coin.coinUrl==='string'&&coin.coinUrl.startsWith('/coin?')?coin.coinUrl:'/coin?mint='+encodeURIComponent(coin.mint)+(coin.chain==='robinhood'?'&chain=robinhood':'');return a;};
  function avatar(coin){const image=el('img');image.alt='';image.src=coinImage(coin.mint,coin.image)||FALLBACK_ICON;image.onerror=()=>{image.onerror=null;image.src=FALLBACK_ICON;};return image;}
  // Presentation hooks: rank medals, a live-number value and a small progress meter.
  function meter(value,cls){const progress=exploreNumber(value);if(progress===null)return null;const node=el('span',null,cls);node.setAttribute('aria-hidden','true');node.style?.setProperty?.('--progress',String(Math.min(100,progress)));node.append(el('i'));return node;}
  function mini(coin,index){const a=coinLink(coin),name=el('div');if(index!==undefined){a.dataset.rank=String(index+1);a.append(el('span',index+1,'explore-rank'));}const identity=el('span',null,'explore-mini-identity'),amm=createLaunchAmmBadge(document,coin);identity.append(el('strong',coin.symbol?'$'+coin.symbol:coin.name));if(amm)identity.append(amm);name.append(identity,el('small',coin.name));const metric=el('div',null,'explore-mini-value'),value=el('strong',exploreMoney(coin.marketCapUsd??coin.fdvUsd));value.dataset.motionNumber='';metric.append(value,el('small',index===undefined?(coin.marketCapUsd!=null?'Market cap':'FDV'):(exploreNumber(coin.progressPercent)!==null?Number(coin.progressPercent).toFixed(1)+'% bonded':'Progress unavailable')));const bar=index===undefined?null:meter(coin.progressPercent,'explore-mini-meter');if(bar)metric.append(bar);a.append(avatar(coin),name,metric,el('span','↗','explore-mini-arrow'));return a;}
  // ---- Featured price chart: area + line on soft gridlines, high/low/latest labels, a time axis, a
  // crosshair readout (pointer and keyboard) and a draw-in on first view. Geometry is measured from the
  // container so text never stretches; a resize redraws. A flat series is padded to sit mid-height. ----
  const NS='http://www.w3.org/2000/svg',svgEl=(tag,attributes)=>{const node=document.createElementNS(NS,tag);for(const [key,value]of Object.entries(attributes))node.setAttribute(key,String(value));return node;};
  function drawChart(graph,series,{animate=false}={}){
    const {points,symbol}=series,W=Math.max(240,Math.round(Number(graph.clientWidth)||700)),H=Math.max(140,Math.round(Number(graph.clientHeight)||240));
    const values=points.map(p=>p.value),rawLo=Math.min(...values),rawHi=Math.max(...values),first=points[0].time,last=points.at(-1).time,span=Math.max(1,last-first);
    const pad=rawHi===rawLo?(Math.abs(rawHi)*.08||1):(rawHi-rawLo)*.12,lo=rawLo-pad,hi=rawHi+pad;
    let ticks=[];const step=niceStep((hi-lo)/3);if(step>0){for(let v=Math.ceil(lo/step)*step;v<=hi+step*1e-9;v+=step)ticks.push(v);}
    if(ticks.length<3||ticks.length>5)ticks=[0,1,2,3].map(i=>lo+(hi-lo)*i/3);
    const tight=W<520,price=v=>compactPrice(v,tight),labels=ticks.map(price),gutter=Math.min(96,Math.max(44,Math.max(...labels.map(text=>text.length))*7+14));
    const left=4,right=W-gutter-8,top=14,bottom=H-26,x=t=>left+(t-first)/span*(right-left),y=v=>bottom-(v-lo)/(hi-lo||1)*(bottom-top);
    const coords=points.map(p=>[x(p.time),y(p.value)]),linePath=coords.map(([cx,cy],i)=>(i?'L':'M')+cx.toFixed(1)+','+cy.toFixed(1)).join(' ');
    const svg=svgEl('svg',{viewBox:`0 0 ${W} ${H}`,width:'100%',height:H,preserveAspectRatio:'none',role:'img','aria-label':`Confirmed recent price in ${symbol||'the paired token'}: ${compactPrice(values.at(-1))} now, high ${compactPrice(rawHi)}, low ${compactPrice(rawLo)}`});
    const defs=svgEl('defs',{}),gradient=svgEl('linearGradient',{id:'explore-spark-fill',x1:0,y1:0,x2:0,y2:1});for(const [offset,opacity]of [['0','.3'],['1','0']])gradient.append(svgEl('stop',{offset,'stop-color':'#8b5cff','stop-opacity':opacity}));defs.append(gradient);svg.append(defs);
    const endY=y(values.at(-1));
    for(const [i,v]of ticks.entries()){const gy=y(v);svg.append(svgEl('line',{class:'explore-chart-grid',x1:left,x2:right,y1:gy.toFixed(1),y2:gy.toFixed(1)}));if(Math.abs(gy-endY)<15)continue;const label=svgEl('text',{class:'explore-chart-axis is-y',x:W-2,y:(gy+4).toFixed(1)});label.textContent=labels[i];svg.append(label);}
    const tickCount=Math.max(2,Math.min(4,Math.floor((right-left)/96)+1)),timeTicks=Array.from({length:tickCount},(_,i)=>first+span*i/(tickCount-1));for(const [i,t]of timeTicks.entries()){const text=timeLabel(t,span);if(!text)continue;const label=svgEl('text',{class:'explore-chart-axis is-x'+(i===0?' is-first':i===tickCount-1?' is-last':''),x:x(t).toFixed(1),y:H-6});label.textContent=text;svg.append(label);}
    svg.append(svgEl('path',{class:'explore-spark-area',d:`${linePath} L${coords.at(-1)[0].toFixed(1)},${bottom} L${coords[0][0].toFixed(1)},${bottom} Z`}),svgEl('path',{class:'explore-spark-line',pathLength:1,d:linePath}));
    // High and low readings (skipped when they are the latest point, which carries its own label).
    const hiIndex=values.indexOf(rawHi),loIndex=values.lastIndexOf(rawLo),lastIndex=points.length-1;
    if(!series.flat)for(const [index,kind]of [[hiIndex,'high'],[loIndex,'low']]){if(index===lastIndex)continue;const [cx,cy]=coords[index],text=(kind==='high'?'High ':'Low ')+price(values[index]),width=text.length*6.6+4,leftSide=cx+8+width>right;svg.append(svgEl('circle',{class:'explore-chart-extreme',cx:cx.toFixed(1),cy:cy.toFixed(1),r:3.5}));const label=svgEl('text',{class:'explore-chart-extreme-label is-'+kind,x:(leftSide?Math.max(left+width,cx-8):cx+8).toFixed(1),y:(kind==='high'?Math.max(top-2,cy-9):Math.min(bottom+4,cy+15)).toFixed(1),'text-anchor':leftSide?'end':'start'});label.textContent=text;svg.append(label);}
    // The latest reading is a price tag on the right axis, level with the line's end.
    const [ex,ey]=coords[lastIndex],latest=price(values[lastIndex]),lx=right+5,latestWidth=W-4-lx,ly=Math.max(0,Math.min(H-22,ey-11));
    svg.append(svgEl('rect',{class:'explore-chart-latest-bg',x:lx.toFixed(1),y:ly.toFixed(1),width:latestWidth.toFixed(1),height:22,rx:7}));const latestLabel=svgEl('text',{class:'explore-chart-latest',x:(W-6).toFixed(1),y:(ly+15).toFixed(1),'text-anchor':'end'});latestLabel.textContent=latest;svg.append(latestLabel);
    const dot=el('span',null,'explore-spark-dot');dot.setAttribute('aria-hidden','true');dot.style?.setProperty?.('--spark-x',(ex/W*100).toFixed(2)+'%');dot.style?.setProperty?.('--spark-y',(ey/H*100).toFixed(2)+'%');
    const crosshair=el('span',null,'explore-chart-crosshair'),tip=el('span',null,'explore-chart-tip');crosshair.setAttribute('aria-hidden','true');tip.setAttribute('aria-hidden','true');for(const node of [crosshair,tip]){node.style?.setProperty?.('--spark-top',top+'px');node.style?.setProperty?.('--spark-bottom',(H-bottom)+'px');}
    if(animate){svg.classList.add('is-drawing');dot.classList.add('is-drawing');const drawn=event=>{if(event?.animationName&&event.animationName!=='explore-draw')return;svg.removeEventListener?.('animationend',drawn);svg.classList.remove('is-drawing');dot.classList.remove('is-drawing');};svg.addEventListener?.('animationend',drawn);}
    graph.replaceChildren(svg,crosshair,tip,dot);graph.tabIndex=0;graph.setAttribute('aria-label','Price chart. Use the arrow keys to read values.');
    let probe=-1;const show=index=>{probe=Math.max(0,Math.min(lastIndex,index));const [cx,cy]=coords[probe],leftEdge=cx<W*.22,rightEdge=cx>W*.78;for(const node of [crosshair,tip])node.style?.setProperty?.('--spark-cx',(cx/W*100).toFixed(2)+'%');crosshair.style?.setProperty?.('--spark-cy',(cy-top).toFixed(1)+'px');tip.classList.toggle('is-left',leftEdge);tip.classList.toggle('is-right',rightEdge);tip.replaceChildren(document.createTextNode(compactPrice(values[probe])+(symbol?' '+symbol:'')),el('small',timeLabel(points[probe].time,0)+(span>36*3600000?' · '+timeLabel(points[probe].time,span):'')));graph.classList.add('is-probing');};
    const hide=()=>{probe=-1;graph.classList.remove('is-probing');};
    graph.onpointermove=event=>{const rect=graph.getBoundingClientRect?.();if(!rect?.width)return;const px=(event.clientX-rect.left)/rect.width*W;let nearest=0;for(let i=1;i<coords.length;i++)if(Math.abs(coords[i][0]-px)<Math.abs(coords[nearest][0]-px))nearest=i;show(nearest);};
    graph.onpointerleave=hide;graph.onfocus=()=>show(lastIndex);graph.onblur=hide;
    graph.onkeydown=event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();show((probe<0?lastIndex:probe)+(event.key==='ArrowLeft'?-1:1));}else if(event.key==='Home'){event.preventDefault();show(0);}else if(event.key==='End'){event.preventDefault();show(lastIndex);}else if(event.key==='Escape')hide();};
    try{const Observer=globalThis.ResizeObserver;if(Observer){chartObserver??=new Observer(entries=>{for(const entry of entries){const live=charts.get(entry.target);if(live&&entry.target.isConnected&&Math.abs(Math.round(entry.contentRect.width)-live.width)>1)drawChart(entry.target,live);}});chartObserver.observe(graph);}}catch{}
    series.width=W;
  }
  async function highlights(force=false){
    if(!$('explore-featured')||disposed||document.hidden||highlightsBusy||!force&&clock()<highlightsNext)return;
    highlightsBusy=true;highlightsNext=clock()+refreshDelay();const controller=new AbortController();controllers.add(controller);let completedHighlight=null;
    try{
      const chainParam=filters.chain&&filters.chain!=='all'?'&chain='+encodeURIComponent(filters.chain):'';
      const [near,top]=await Promise.all([api('/api/explore?stage=new&sort=progress&limit=6'+chainParam,controller),api('/api/explore?stage=all&sort=marketCap&limit=4'+chainParam,controller)]);if(disposed)return;
      const pending=near.refreshing===true||top.refreshing===true;highlightsNext=clock()+refreshDelay(pending?(near.refreshing?near:top):near,highlightWarmups);highlightWarmups=pending?highlightWarmups+1:0;
      const valid=rows=>(Array.isArray(rows)?rows:[]).filter(c=>/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c?.mint)||/^0x[0-9a-fA-F]{40}$/.test(c?.mint));
      const candidates=valid(near.coins),leaders=valid(top.coins),coin=candidates[0],root=el('div');completedHighlight=root;root.append(el('p','ON THE HORIZON','eyebrow'));
      replaceIfChanged($('explore-leaders-list'),leaders.length?leaders.map(c=>mini(c)):[el('p','Market leaders appear as confirmed data arrives.','help')]);$('explore-leaders-list').setAttribute('aria-busy','false');
      replaceIfChanged($('explore-contenders-list'),candidates.slice(1).length?candidates.slice(1).map((c,i)=>mini(c,i)):[el('p','Coins approaching graduation will appear here.','help')]);
      if(!coin){root.append(el('h2','The next idea starts here.'),el('p','New launches will rise toward graduation here.','help'));return;}
      const heading=el('div',null,'explore-feature-heading'),identity=coinLink(coin),text=el('div');text.append(el('h2','$'+coin.symbol),el('span',coin.name));identity.append(avatar(coin),text);const valuation=el('div',null,'explore-feature-value'),headline=el('strong',exploreMoney(coin.marketCapUsd??coin.fdvUsd));headline.dataset.motionNumber='';valuation.append(headline,el('small',coin.marketCapUsd!=null?'Market cap':'Fully diluted value'));heading.append(identity,valuation);root.append(heading);
      let chart=el('div',null,'explore-feature-chart');chart.append(el('p','Recent price · '+(coin.quote?.symbol||'paired token'),'help'));const previousSpark=$('explore-featured').dataset.mint===coin.mint?$('explore-featured').querySelector('.explore-spark'):null,previousGraph=previousSpark?.querySelector('svg')||null;let graph=el('div','Loading confirmed price history…','explore-spark');if(previousGraph){graph.replaceChildren(...[...previousSpark.childNodes].map(node=>node.cloneNode(true)));const note=previousSpark.parentElement?.querySelector('.explore-chart-note');if(note)chart.append(note.cloneNode(true));}chart.append(graph);root.append(chart);
      const stats=el('div',null,'explore-feature-stats');for(const [label,value]of [['24h volume',exploreMoney(coin.volume24h)],['Bond progress',exploreNumber(coin.progressPercent)!==null?Number(coin.progressPercent).toFixed(1)+'%':'—'],['Paired with',coin.quote?.symbol||'—']]){const item=el('div'),detail=el('strong',value);if(label==='Paired with'){detail.className='explore-feature-pair';detail.replaceChildren(isRobinhood(coin)?robinhoodPairLabel(document,coin.quote):createQuoteLabel(document,coin.quote));const amm=createLaunchAmmBadge(document,coin);if(amm)detail.append(amm);}item.append(el('span',label),detail);if(label==='Bond progress'){const bar=meter(coin.progressPercent,'explore-feature-meter');if(bar)item.append(bar);}stats.append(item);}root.append(stats);if(coin.stale||near.stale)root.append(el('small','Last available market reading','help'));
      // The chart is an independent, slower request: show the coin immediately.
      $('explore-featured').dataset.mint=coin.mint;replaceIfChanged($('explore-featured'),[...root.childNodes]);completedHighlight=null;chart=$('explore-featured').querySelector('.explore-feature-chart');graph=chart.querySelector('.explore-spark');let staleNote=false;
      try{
        let rows=[];
        if(isRobinhood(coin)){
          // v71.41: a Robinhood coin's history is its pool's price after each recorded swap (the venue's coin view), in pair units per coin.
          const view=await api('/api/launchpad/robinhood/coin?mint='+encodeURIComponent(coin.mint),controller);if(disposed)return;const scale=10**(Number.isInteger(view?.pair?.decimals)?view.pair.decimals:18);
          rows=view?.token?.toLowerCase()===coin.mint.toLowerCase()&&Array.isArray(view.priceHistory)?view.priceHistory.map(p=>({time:p.at,value:Number(p.price)/scale})):[];
        }else{
          const market=await api('/api/explore/market?mint='+encodeURIComponent(coin.mint),controller);if(disposed)return;const native=market.native;
          rows=native?.mint===coin.mint&&native?.curve===coin.curve&&native?.quote?.mint===coin.quote?.mint?(native.candles?.length?native.candles.map(p=>({time:p.time,value:p.close})):native.points?.map(p=>({time:p.time,value:p.priceQuote}))||[]):[];
          if(native?.stale)staleNote=true;
        }
        const points=rows.filter(p=>Number.isFinite(Number(p.time))&&exploreNumber(p.value)>0).sort((a,b)=>a.time-b.time).slice(-100).map(p=>({time:Number(p.time)<1e11?Number(p.time)*1000:Number(p.time),value:Number(p.value)}));
        if(points.length<2){graph.textContent='Price history builds as trades arrive.';return;}
        chart.querySelector('.explore-chart-note')?.remove();chart.querySelectorAll(':scope>small.help').forEach(node=>node.remove());
        const series={points,symbol:coin.quote?.symbol||'',flat:points.every(p=>p.value===points[0].value)};charts.set(graph,series);drawChart(graph,series,{animate:!previousGraph});
        if(series.flat)chart.append(el('small','Price steady · no change across the confirmed readings','explore-chart-note'));
        if(staleNote)chart.append(el('small','Historical prices · latest reading delayed','help'));
      }catch{graph.textContent='Price history is temporarily unavailable.';}
    }catch{if(!$('explore-featured').querySelector('.explore-feature-heading'))$('explore-featured').replaceChildren(el('p','ON THE HORIZON','eyebrow'),el('h2','Markets are catching up.'),el('p','We’ll refresh the latest launches shortly.','help'));}
    finally{controllers.delete(controller);highlightsBusy=false;if(!disposed&&completedHighlight)replaceIfChanged($('explore-featured'),[...completedHighlight.childNodes]);}
  }
  function selectStage(stage){if(!MODES.includes(stage))return;const previousSort=sort();selectedStage=stage;if(previousSort!==sort()){const state=sections.all;state.controller?.abort();state.request++;state.busy=false;state.promise=null;state.offset=0;state.next=0;state.data=null;state.version='';state.error='';}pageRoot.dataset.exploreStage=stage;$('explore-coins').dataset.exploreStage=stage;for(const name of STAGES)$('explore-'+name).hidden=!visibleStages().includes(name);for(const button of document.querySelectorAll('button[data-explore-stage]'))button.setAttribute('aria-pressed',String(button.dataset.exploreStage===stage));placeIndicators();}
  for(const button of document.querySelectorAll('button[data-explore-stage]'))button.onclick=()=>{selectStage(button.dataset.exploreStage);return Promise.allSettled(visibleStages().map(stage=>load(stage)));};
  for(const button of document.querySelectorAll('[data-explore-view]'))button.onclick=()=>{const changedView=document.body.classList.contains('explore-list-view')!==(button.dataset.exploreView==='list');document.body.classList.toggle('explore-list-view',button.dataset.exploreView==='list');for(const other of document.querySelectorAll('[data-explore-view]'))other.setAttribute('aria-pressed',String(other===button));placeIndicators();if(changedView)swapGrids();};
  // Sliding indicators for the pressed tab/pill in each control group (presentation only).
  for(const group of pageRoot.querySelectorAll('.explore-stage-tabs,.explore-categories,.explore-view-switch,.explore-amm-options,.explore-age-options')){if([...group.children].some(node=>node.classList.contains('explore-indicator')))continue;const mark=el('span',null,'explore-indicator');mark.setAttribute('aria-hidden','true');group.classList.add('has-slider');group.append(mark);}
  try{const Observer=globalThis.ResizeObserver;if(Observer){indicatorObserver=new Observer(()=>placeIndicators());for(const node of pageRoot.querySelectorAll('.has-slider,.has-slider>button'))indicatorObserver.observe(node);}document.fonts?.ready?.then(()=>{if(!disposed)placeIndicators();});}catch{}
  if($('explore-featured'))selectStage(snapshot?.selectedStage||'new');
  const search=createExploreSearch({document,window,fetcher,initialQuery:filters.search});
  // A text filter (old /explore?search= links) is shown as a chip that clears it.
  let searchChip=pageRoot.querySelector('[data-explore-search-chip]');
  if(!searchChip&&$('explore-status')){searchChip=el('button',null,'explore-search-chip');searchChip.type='button';searchChip.dataset.exploreSearchChip='';searchChip.hidden=true;$('explore-status').after(searchChip);}
  if(searchChip)searchChip.onclick=()=>{const cleared=apply({search:''});pageRoot.querySelector('[data-explore-category][aria-pressed="true"]')?.focus({preventScroll:true});return cleared;};
  function syncControls(){
    for(const button of document.querySelectorAll('[data-explore-category]'))button.setAttribute('aria-pressed',String(button.dataset.exploreCategory===filters.category));
    for(const button of document.querySelectorAll('[data-explore-chain]'))button.setAttribute('aria-pressed',String(button.dataset.exploreChain===filters.chain));
    const EventType=window.CustomEvent||globalThis.CustomEvent;if(typeof EventType==='function')document.dispatchEvent(new EventType('curve-chain-applied',{detail:{chain:filters.chain}}));
    // The Solana AMM chips mean nothing on Robinhood Chain (every coin there is a Uniswap v4 pool).
    const ammRow=document.querySelector('.explore-amm-options');if(ammRow)ammRow.hidden=filters.chain==='robinhood';
    for(const button of document.querySelectorAll('[data-explore-launch-mode]'))button.setAttribute('aria-pressed',String(button.dataset.exploreLaunchMode===filters.launchMode));
    for(const button of document.querySelectorAll('[data-explore-age]'))button.setAttribute('aria-pressed',String(button.dataset.exploreAge===filters.age));
    if(searchChip){searchChip.hidden=!filters.search;if(filters.search){searchChip.replaceChildren(el('span','Search:'),el('strong',filters.search),el('span','✕','explore-search-chip-clear'));searchChip.querySelector('.explore-search-chip-clear').setAttribute('aria-hidden','true');searchChip.setAttribute('aria-label','Clear the search filter “'+filters.search+'”');searchChip.title='Clear this search filter';}else searchChip.replaceChildren();}
    placeIndicators();
  }
  function placeIndicators(){
    for(const group of pageRoot.querySelectorAll('.has-slider')){
      const children=[...group.children],mark=children.find(node=>node.classList.contains('explore-indicator')),active=children.find(node=>node.tagName==='BUTTON'&&node.getAttribute('aria-pressed')==='true'),width=Number(active?.offsetWidth)||0;
      if(!mark||!width){group.classList.remove('has-indicator');continue;}
      mark.style.setProperty('--indicator-x',active.offsetLeft+'px');mark.style.setProperty('--indicator-y',active.offsetTop+'px');mark.style.setProperty('--indicator-w',width+'px');mark.style.setProperty('--indicator-h',active.offsetHeight+'px');
      if(!group.classList.contains('has-indicator')){group.classList.add('has-indicator');window.requestAnimationFrame?.(()=>group.classList.add('indicator-ready'));}
    }
  }
  function swapGrids(){for(const grid of pageRoot.querySelectorAll('.explore-grid')){grid.classList.remove('is-swapping');void grid.offsetWidth;grid.classList.add('is-swapping');}clearTimeout(swapTimer);swapTimer=setTimeout(()=>{for(const grid of pageRoot.querySelectorAll('.explore-grid.is-swapping'))grid.classList.remove('is-swapping');},900);}
  function updateUrl(){
    const params=new URLSearchParams();for(const [key,value]of Object.entries(filters))if(value!==DEFAULTS[key]&&!(key==='chain'&&!robinhoodOn))params.set(key,value);
    try{window.history?.replaceState(window.history.state,'',params.size?'/explore?'+params.toString():'/');}catch{}
  }
  function updateStatus(){
    const values=visibleStages().map(stage=>sections[stage]),loading=values.some(row=>row.busy),failed=values.some(row=>row.error),stale=values.some(row=>row.data?.stale);
    const status=$('explore-status');status.dataset.error=String(failed||stale);
    if(failed)status.textContent='Some coin data is delayed. Retrying automatically.';
    else if(stale)status.textContent='Showing the latest available data. Some markets are still updating.';
    else if(loading&&!values.some(row=>row.data))status.textContent='Discovering Launchpad launches…';
    else if(loading&&snapshot)status.textContent='Showing last available coins · Updating…';
    else if(totalCoins!==null)status.textContent=`${Number(totalCoins).toLocaleString()} Launchpad ${Number(totalCoins)===1?'coin':'coins'}${changed()?' · Filters applied':''}${loading?' · Updating…':''}`;
    else status.textContent=loading?'Updating coins…':'Explore coins launched on Launchpad.';
  }
  function skeleton(stage){const grid=$(`explore-${stage}-grid`);if(sections[stage].data)return;const cards=[];for(let i=0;i<8;i++){const card=el('div',null,'explore-coin explore-skeleton');card.setAttribute('aria-hidden','true');const body=el('div',null,'explore-coin-body');body.append(el('div',null,'explore-skeleton-line'),el('div',null,'explore-skeleton-line'));card.append(el('div',null,'explore-coin-image'),body);cards.push(card);}grid.replaceChildren(...cards);}
  function empty(stage,failed=false){
    const root=el('div',null,'explore-empty'+(failed?' is-error':''));root.append(el('span',failed?'⌁':stage==='graduated'?'✦':stage==='moving'?'↗':'◈'));
    root.append(el('strong',failed?'Couldn’t load these coins':changed()?'No matching '+TITLES[stage]:stage==='graduated'?'The next chapter is ahead':stage==='moving'?'Room for the next mover':'The next idea starts here'));
    root.append(el('p',failed?'Please try again in a moment.':changed()?(filters.search?'Clear the search, or try All coins, all AMMs or a different time range.':'Try All coins, all AMMs or a different time range.'):stage==='graduated'?'Coins appear here after their graduation is confirmed.':stage==='moving'?'Coins appear as volume accelerates or their curve reaches 35%.':'New coins appear here once their launch is confirmed.'));
    const [theme,stageNumber,aside]=EMPTY_GOTCHI[failed?'error':stage]||EMPTY_GOTCHI.new;root.append(el('p',aside,'explore-empty-aside'));
    const peek=el('div',null,'explore-empty-gotchi');peek.setAttribute('aria-hidden','true');root.append(peek);
    import('./gotchi-character.mjs').then(({createGotchiCharacter})=>{if(disposed||!peek.isConnected)return;const gotchi=createGotchiCharacter({document,window,theme,stage:stageNumber,size:'mini',interactive:false});gotchis.add(gotchi);peek.append(gotchi.element);if(failed)gotchi.react('dizzy');else gotchi.react('happy');}).catch(()=>{});
    return root;
  }
  // Unavailable page buttons stay focusable (aria-disabled), so keyboard focus
  // remains on Next/Previous while the page loads and after the last page.
  const unavailable=(button,value)=>{if(value)button.setAttribute('aria-disabled','true');else button.removeAttribute('aria-disabled');};
  function pagination(stage){
    const state=sections[stage],root=$(`explore-${stage}-pagination`);if(state.total<=state.limit){if(root.childNodes.length)root.replaceChildren();return;}
    if(!root.children.length){const previous=el('button','‹'),next=el('button','›');previous.type=next.type='button';previous.setAttribute('aria-label','Previous '+TITLES[stage]+' page');next.setAttribute('aria-label','Next '+TITLES[stage]+' page');previous.onclick=()=>{if(!state.busy&&state.offset>0)return page(stage,Math.max(0,state.offset-state.limit));};next.onclick=()=>{if(!state.busy&&state.nextOffset!==null)return page(stage,state.nextOffset);};root.append(previous,el('span'),next);}
    const [previous,label,next]=root.children;unavailable(previous,state.busy||state.offset===0);unavailable(next,state.busy||state.nextOffset===null);const text=`Page ${Math.floor(state.offset/state.limit)+1} of ${Math.max(1,Math.ceil(state.total/state.limit))}`;if(label.textContent!==text)label.textContent=text;
  }
  function render(stage){
    const state=sections[stage],grid=$(`explore-${stage}-grid`),message=$(`explore-${stage}-message`);message.replaceChildren();grid.setAttribute('aria-busy',String(state.busy));
    if(state.error){if(!state.data)grid.replaceChildren(empty(stage,true));message.append(el('p',state.data?'Couldn’t refresh this section. Showing the last available coins.':'This section will retry automatically.'));const retry=el('button','Try again','small-button');retry.type='button';retry.onclick=()=>load(stage,true);message.append(retry);}
    else if(state.data){const coins=Array.isArray(state.data.coins)?state.data.coins:[],version=JSON.stringify([coins.map(coin=>exploreCardVersion(coin,{stage})),state.offset]);if(version!==state.version){state.version=version;reconcileCards(stage,coins);}$(`explore-${stage}-count`).textContent=Number(state.total).toLocaleString();}
    pagination(stage);updateStatus();
  }
  async function load(stage,force=false){
    if(disposed||document.hidden)return;if(sections[stage].busy)return sections[stage].promise;
    const state=sections[stage];if(!force&&clock()<state.next)return;
    const epoch=generation,request=++state.request,controller=new AbortController();controllers.add(controller);state.controller=controller;state.busy=true;skeleton(stage);$(`explore-${stage}-grid`).setAttribute('aria-busy','true');pagination(stage);updateStatus();
    const params=new URLSearchParams({stage,offset:String(state.offset),limit:String(state.limit),...filters,sort:sort()});
    const pending=(async()=>{let correctedOffset=null;try{
      const data=await api('/api/explore?'+params.toString(),controller);if(disposed||epoch!==generation||request!==state.request)return;
      if(!Array.isArray(data?.coins)||!Number.isFinite(Number(data.total)))throw Error('Invalid coin data');
      state.data=data;state.error='';state.total=Math.max(0,Math.floor(Number(data.total)));state.nextOffset=Number.isInteger(data.nextOffset)&&data.nextOffset>state.offset?data.nextOffset:null;state.next=clock()+refreshDelay(data,state.warmups);state.warmups=data.refreshing===true?state.warmups+1:0;
      if(data.stale!==true&&state.offset>0&&state.offset>=state.total)correctedOffset=state.total>0?Math.floor((state.total-1)/state.limit)*state.limit:0;
      if(data.counts&&Number.isFinite(Number(data.counts.all))){totalCoins=Math.max(0,Number(data.counts.all));for(const name of STAGES)if(Number.isFinite(Number(data.counts[name])))$(`explore-${name}-count`).textContent=Number(data.counts[name]).toLocaleString();}
    }catch(error){if(disposed||epoch!==generation||request!==state.request)return;state.error=error.message||'Coin data is unavailable';state.next=clock()+Math.max(FEED_REFRESH_MS,Math.min(300000,Number(error.retryAfterMs)||FEED_REFRESH_MS));}
    finally{controllers.delete(controller);if(epoch===generation&&request===state.request){state.busy=false;state.controller=null;state.promise=null;if(correctedOffset!==null)return page(stage,correctedOffset);render(stage);}}
    })();state.promise=pending;return pending;
  }
  function page(stage,offset){const state=sections[stage];if(state.busy||disposed)return;state.offset=offset;state.data=null;state.version='';state.error='';return load(stage,true);}
  function apply(next){
    if(disposed)return;const merged=feedFilters({...filters,...next});if(JSON.stringify(merged)===JSON.stringify(filters))return;const before=filters.chain;filters=merged;totalCoins=null;generation++;
    for(const state of Object.values(sections)){state.controller?.abort();state.request++;state.busy=false;state.promise=null;state.offset=0;state.next=0;state.warmups=0;state.data=null;state.error='';state.version='';state.nextOffset=null;}
    syncControls();updateUrl();
    // A chain change (v71.42) redraws the horizon, the leaders and the contenders at once, not at the next refresh.
    const chainChanged=Object.hasOwn(next,'chain')&&next.chain!==before;
    return Promise.allSettled([...visibleStages().map(stage=>load(stage,true)),...(chainChanged?[highlights(true)]:[])]);
  }
  function tick(){
    if(disposed||document.hidden||search.isOpen())return;
    for(const node of pageRoot.querySelectorAll('[data-created-at]')){const age=exploreAge(node.dataset.createdAt,clock());if(node.textContent!==age)node.textContent=age;const card=node.closest('.explore-coin'),sinceLaunch=clock()-Number(node.dataset.createdAt),fresh=sinceLaunch>=0&&sinceLaunch<600000;if(card&&card.classList.contains('is-fresh')!==fresh)card.classList.toggle('is-fresh',fresh);}
    return Promise.allSettled([detectLaunches(),refreshDetectedLaunches(),highlights(),...visibleStages().map(stage=>load(stage))]);
  }
  for(const button of document.querySelectorAll('[data-explore-category]'))button.onclick=()=>apply({category:button.dataset.exploreCategory});
  const chooseChain=chain=>{if(!robinhoodOn)chain='solana';if(robinhoodOn)rememberChain(window,chain);return apply({chain,...(chain==='robinhood'?{launchMode:'all'}:{})});};
  for(const button of document.querySelectorAll('[data-explore-chain]'))button.onclick=()=>chooseChain(button.dataset.exploreChain);
  // The header's Solana | Robinhood toggle (workspace-shell.js) drives the same filter on this page.
  const onChainSelected=event=>{const chain=event.detail?.chain;if(chain!=='solana'&&chain!=='robinhood')return;event.preventDefault();void chooseChain(chain);};
  document.addEventListener('curve-chain-selected',onChainSelected);
  for(const button of document.querySelectorAll('[data-explore-launch-mode]'))button.onclick=()=>apply({launchMode:button.dataset.exploreLaunchMode});
  for(const button of document.querySelectorAll('[data-explore-age]'))button.onclick=()=>apply({age:button.dataset.exploreAge});
  const visibility=()=>{if(!document.hidden)tick();};document.addEventListener('visibilitychange',visibility);
  if(snapshot){
    totalCoins=snapshot.totalCoins;
    for(const stage of STAGES){const old=snapshot.sections[stage];if(old?.data){Object.assign(sections[stage],{offset:old.offset,total:old.total,nextOffset:old.nextOffset,data:old.data});render(stage);}}
    for(const [id,node]of snapshot.highlights){const target=$(id);if(target){target.replaceChildren(...[...node.childNodes].map(child=>child.cloneNode(true)));if(node.dataset.mint)target.dataset.mint=node.dataset.mint;}}
    document.body.classList.toggle('explore-list-view',snapshot.listView);
    for(const button of document.querySelectorAll('[data-explore-view]'))button.setAttribute('aria-pressed',String((button.dataset.exploreView==='list')===snapshot.listView));
  }
  syncControls();shell({page:'explore'});void highlights(true);
  const sessionController=new AbortController();controllers.add(sessionController);
  api('/api/session',sessionController).then(session=>{if(disposed)return;shell({page:'explore',session});}).catch(()=>{}).finally(()=>controllers.delete(sessionController));
  const ready=Promise.allSettled([detectLaunches(),...visibleStages().map(stage=>load(stage,true))]),timer=setTimer(tick,1000);
  function destroy(){if(disposed)return;
    if(Object.values(sections).some(state=>state.data))publicSnapshots.set(document,{at:clock(),filters:{...filters},selectedStage,totalCoins,listView:document.body.classList.contains('explore-list-view'),sections:Object.fromEntries(STAGES.map(stage=>{const {offset,total,nextOffset,data}=sections[stage];return[stage,{offset,total,nextOffset,data}];})),highlights:['explore-featured','explore-contenders-list','explore-leaders-list'].map(id=>[id,$(id)?.cloneNode(true)]).filter(([,node])=>node)});
    disposed=true;generation++;clearTimer(timer);indicatorObserver?.disconnect();chartObserver?.disconnect();for(const gotchi of gotchis)gotchi.destroy();gotchis.clear();clearTimeout(swapTimer);for(const controller of controllers)controller.abort();controllers.clear();document.removeEventListener('visibilitychange',visibility);document.removeEventListener('curve-chain-selected',onChainSelected);window.removeEventListener?.('pagehide',pagehide);search.close();}
  const pagehide=event=>{if(!event.persisted)destroy();};window.addEventListener?.('pagehide',pagehide);
  return {ready,tick,apply,page,search,refresh:()=>Promise.allSettled(visibleStages().map(stage=>load(stage,true))),destroy};
}

export function mountPage({document=globalThis.document,window=document.defaultView}={}){return createExplorePage({document,window});}
bootPage('explore',mountPage);
