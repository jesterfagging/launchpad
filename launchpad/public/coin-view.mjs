import {gotchiTheme} from './gotchi-catalog.mjs';
import {coinImage} from './coin-image.mjs';
import {createQuoteLabel} from './quote-logos.mjs';
import {createLaunchAmmBadge} from './amm-branding.mjs';
import { dexScreenerUrl } from './dexscreener-view.mjs';
import { createCoinRewardsView, validCoinRewards } from './coin-rewards-view.mjs';
import { createCoinCreatorEarningsView } from './coin-creator-earnings.mjs';
import { createCoinActivity } from './coin-activity.mjs';
import { createCoinTrade } from './coin-trade.mjs';
import { intervalCandles, curveChartSnapshot } from './launch-curve-chart.mjs';
import { quoteLabel } from './quote-display-identity.mjs';
import { coinBurnPrice } from './burn-valuation.mjs';
import { getLaunchpadWallet } from './launchpad-wallet.mjs';

const address = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const number = value => value != null && value !== '' && ['number','string'].includes(typeof value) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const short = value => typeof value === 'string' ? value.length > 16 ? `${value.slice(0,6)}…${value.slice(-6)}` : value : '—';
const compactMoney=new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:2}),preciseMoney=new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',maximumSignificantDigits:5}),quantityFormat=new Intl.NumberFormat(undefined,{maximumSignificantDigits:6}),compactFormat=new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:2});
const money = value => { const n=number(value); return n===null?'—':(n>=1000?compactMoney:preciseMoney).format(n); };
const quantity = value => { const n=number(value);return n===null?'—':quantityFormat.format(n); };
const compact = value => { const n=number(value);return n===null?'—':compactFormat.format(n); };
const socialUrl = value => { try { const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null; } catch {return null;} };
const rewardLabels={none:'None',creator:'Creator wallet',holders:'Holder rewards',paycheck:'Paycheck · paid out every 15 minutes',buyback:'Agent buyback',gotchi:'Gotchi prize pot',agent:'AI Agent · 30% operations / 70% treasury',market_maker:'Market Maker',lp_manager:'Liquidity Manager'};
// Pump.fun coins: the coin's native creator-fee share goes to the launch option (the platform share is in /docs#revenue).
const pumpClassicRewards={creator:'Creator fee share → creator wallet',holders:'Creator fee share → holder rewards',gotchi:'Creator fee share → Gotchi pot',agent:'Creator fee share → AI agent (30/70)',market_maker:'Creator fee share → Market Maker',lp_manager:'Creator fee share → Liquidity Manager',diamond_hands:'Creator fee share → Diamond Hands holder rewards',earned:'Creator fee share → escrow, earned by probation',insured:'Creator fee share → creator + refund pot'};

export function createCoinPage({document,window,fetcher=fetch,shell=()=>{},clock=Date.now,setTimer=setInterval,clearTimer=clearInterval,tradeFactory=createCoinTrade,chartFactory=async root=>(await import('./launch-curve-chart.mjs')).createLaunchCurveChart(root),hookFactory=async()=>import('./hook-ui.mjs'),walletFactory=getLaunchpadWallet}={}) {
  const pageRoot=document.querySelector('main'),$=id=>pageRoot.querySelector('[id="'+id+'"]');
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
  const mint=(new URLSearchParams(window.location.search).get('mint')||'').trim();
  let coin=null,market=null,disposed=false,busy=false,nextAt=0,retryAt=0,failures=0,chart=null,chartKey='',chartGeneration=0,chartLoading=false,chartVersion='',chartRetryAt=0,mode='price',interval=60,marketError='',copyTimer=null;
  let rewards=null,rewardsBusy=false,rewardsNext=0,rewardsRetry=0,rewardsFailures=0,rewardsError='';
  let agentView=null,agentLoading=false,session=null,pumpClassicPanel=null,pumpClassicLoading=false;
  // Transfer hook rules (v71.28): the "Rules" card mounts only for coins whose row carries `hook`; its module loads lazily.
  let hookView=null,hookLoading=false;
  let metadataVersion='';const statisticNodes=[];
  const rewardsView=createCoinRewardsView({document,root:$('coin-rewards'),onRefresh:()=>refreshRewards(true,true)});
  const creatorEarningsView=createCoinCreatorEarningsView({document,root:$('coin-creator-earnings')});
  const activityView=createCoinActivity({document,api: path=>api(path),mint,clock});
  const controllers=new Set();
  const tradeView=tradeFactory({document,window,root:$('coin-trade'),fetcher,clock,onConfirmed:()=>Promise.all([refresh(true),activityView.refresh(true)]),setTimer,clearTimer});
  function link(text,href,cls){const a=el('a',text,cls);a.href=href;a.target='_blank';a.rel='noopener noreferrer';return a;}
  // Busy refresh buttons stay focusable (aria-disabled) so keyboard focus is not lost.
  function busyButton(button,value){if(!button)return;if(value)button.setAttribute('aria-disabled','true');else button.removeAttribute('aria-disabled');}
  // A missing coin gets a friendlier empty state: a way back to Explore and (decorative) a Gotchi keeping watch.
  function error(text='',{missing=false}={}){
    const notice=$('coin-error');notice.textContent=text;notice.hidden=!text;notice.classList.toggle('is-missing',!!(text&&missing));
    if(text&&missing){const back=el('a','Explore coins','small-button coin-notice-action');back.href='/';notice.append(back);const motion=window.curveMotion;if(typeof motion?.peek==='function')try{Promise.resolve(motion.peek(notice,{side:'right',height:84})).catch(()=>{});}catch{}}
  }
  async function api(path){
    const controller=new AbortController();controllers.add(controller);const timeout=window.setTimeout(()=>controller.abort(),15000);
    try{const response=await fetcher(path,{method:'GET',credentials:'same-origin',signal:controller.signal});const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'Market information is temporarily unavailable.'),{status:response.status,retryAfterMs:data.retryAfterMs});return data;}
    finally{window.clearTimeout(timeout);controllers.delete(controller);}
  }
  function validCoin(value){return value?.mint===mint&&value.chain==='solana'&&address(value.quote?.mint);}
  function nativeData(){const value=market?.native;return value?.mint===mint&&value.curve===coin?.curve&&value.quote?.mint===coin?.quote?.mint&&['curve','migrating','migrated'].includes(value.status)?curveChartSnapshot(value):null;}
  function poolData(){const pool=market?.pool;return pool?.chain==='solana'&&address(pool.address)&&pool.token===mint&&[pool.base?.address,pool.quote?.address].includes(mint)?pool:null;}
  function nativeVisible(){const native=nativeData(),pool=poolData();return !!native&&(native.points.length>0||native.candles?.length>0)&&(native.status==='curve'||!pool||pool.isBase!==true||(!native.stale&&pool.stale));}
  function setImage(){const root=$('coin-avatar'),symbol=String(coin.symbol||'COIN').slice(0,7);root.replaceChildren(el('span',symbol));const src=coinImage(coin.mint,coin.image);if(src){const img=el('img');img.src=src;img.alt='';root.append(img);root.firstElementChild.hidden=true;img.onerror=()=>{img.remove();root.firstElementChild.hidden=false;};}}
  function renderCoin(){
    const quote=coin.quote||{},creatorInfo=coin.creator||{};
    const version=JSON.stringify([coin.mint,coin.name,coin.symbol,coin.image,coin.stage,coin.curveStatus,coin.curve,coin.platform,coin.launchMode,coin.venue,coin.feeMode,coin.taxBps,coin.createdAt,coin.description,coin.links,creatorInfo.username,creatorInfo.avatar,creatorInfo.bio,quote.mint,quote.symbol,quote.category,quote.name,quote.issuer,quote.logoPath,quote.imagePath]);
    if(version!==metadataVersion){
    document.title=`${coin.symbol||coin.name||'Coin'} — Launchpad`;
    const creator=$('coin-creator');if(creator){creator.replaceChildren();creator.hidden=!coin.creator?.username;if(!creator.hidden){const label=document.createElement('span');label.textContent='Creator';creator.append(label);if(/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(coin.creator.avatar||'')){const image=document.createElement('img');image.src=coin.creator.avatar;image.alt='';image.className='creator-avatar';creator.append(image);}const name=document.createElement('a');name.href='/user/'+encodeURIComponent(coin.creator.username);name.textContent=coin.creator.username;creator.append(name);creator.title=coin.creator.bio||'';}}
    const pairedAsset=quoteLabel(coin.quote?.mint,coin.quote?.symbol),pairBadge=el('span',null,'coin-pair-badge');
    pairBadge.id='coin-pair';pairBadge.title='Paired asset: '+coin.quote.mint;pairBadge.append(el('span','Paired with '),createQuoteLabel(document,coin.quote,{strong:true,size:18}));const pairAmm=createLaunchAmmBadge(document,coin);if(pairAmm)pairBadge.append(pairAmm);
    $('coin-name').textContent=coin.name||'Unnamed coin';$('coin-symbol').replaceChildren(el('span','$'+(coin.symbol||'TOKEN')),pairBadge);setImage();
    const stage=coin.curveStatus==='migrating'?'Graduating':coin.stage==='graduated'?'Graduated':coin.curveStatus==='curve'?'On the curve':'Launched';$('coin-stage').textContent=stage;$('coin-stage').dataset.stage=coin.stage;$('coin-stage').dataset.curveStatus=coin.curveStatus||'';
    $('coin-address').textContent=short(mint);$('coin-address').title=mint;$('coin-address').href='https://solscan.io/token/'+mint;
    const details=$('coin-details');details.replaceChildren();
    const created=number(coin.createdAt),facts=[['Paired with',pairedAsset],['Creator rewards',coin.platform==='pump-classic'?pumpClassicRewards[coin.feeMode]||'—':coin.platform==='damm-pump'?'Not enabled':coin.platform==='pumpswap'?(coin.stage==='graduated'?'Ended at graduation':'0.5% · paid automatically'):coin.platform==='meteora'?(coin.feeMode==='gotchi'?'Creator fee share → Gotchi pot':coin.feeMode==='agent'?'Creator fee share → AI agent (30/70)':coin.feeMode==='holders'?'Creator fee share → holders':'Creator fee share · continues after graduation'):rewardLabels[coin.feeMode]||'—'],['Transfer tax',number(coin.taxBps)===null?'—':quantity(Number(coin.taxBps)/100)+'%'],['Launched',created?new Date(created).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'—']];
    for(const [label,value] of facts){const row=el('div'),detail=el('dd',value);if(label==='Paired with'){detail.className='coin-paired-value';detail.replaceChildren(createQuoteLabel(document,coin.quote));const amm=createLaunchAmmBadge(document,coin,{visibleLabel:true});if(amm)detail.append(amm);}row.append(el('dt',label),detail);details.append(row);}
    if(coin.feeMode==='agent'&&coin.agent?.id){const row=el('div'),value=el('dd'),anchor=el('a','Open the agent ↗');anchor.href='#agent';anchor.className='coin-gotchi-link';anchor.onclick=event=>{event.preventDefault();$('coin-agent')?.scrollIntoView({behavior:'smooth',block:'start'});};value.append(anchor);row.append(el('dt','AI agent'),value);details.append(row);mountAgent();}
    if(coin.feeMode==='gotchi'&&coin.gotchi?.id){const row=el('div'),value=el('dd'),anchor=el('a',(gotchiTheme(coin.gotchi.id)?.name||coin.gotchi.id)+' · open the race ↗');anchor.href='/gotchi?id='+encodeURIComponent(coin.gotchi.id);anchor.className='coin-gotchi-link';value.append(anchor);row.append(el('dt','Gotchi'),value);details.append(row);}
    if(address(coin.curve)){const row=el('div'),value=el('dd');value.append(link(short(coin.curve)+' ↗','https://solscan.io/account/'+coin.curve));row.append(el('dt','Launch curve'),value);details.append(row);}
    $('coin-description').textContent=coin.description||'';$('coin-description').hidden=!coin.description;if($('coin-description-section'))$('coin-description-section').hidden=!coin.description;
    const socials=$('coin-socials');socials.replaceChildren();for(const [key,label] of [['website','Website'],['twitter','X'],['telegram','Telegram']]){const url=socialUrl(coin.links?.[key]);if(url)socials.append(link(label+' ↗',url));}
    $('coin-loading').hidden=true;$('coin-content').hidden=false;metadataVersion=version;
    }
    // Market snapshots still reach trading and reward controls on every update.
    tradeView.setCoin(coin);
    creatorEarningsView.render({coin});
    renderRewards();renderHook();
  }
  // The Rules card: the hook state and route, one row per rule, the gate token and tithe recipient, the read-only blocklist
  // (GET /hook-blocklist) and, for the signed-in creator of an allowlisted coin, the allowlist manager. Allowlist changes
  // travel as the Meteora `hook-allow` action with the session token.
  async function hookRequest(path,body){
    const controller=new AbortController();controllers.add(controller);const timeout=window.setTimeout(()=>controller.abort(),20000);
    try{const response=await fetcher('/api/launchpad/meteora'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:{'x-control-token':session?.token||'',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal});const data=await response.json();if(!response.ok)throw Object.assign(Error(data?.error||'This request could not be completed.'),{status:response.status});return data;}
    finally{window.clearTimeout(timeout);controllers.delete(controller);}
  }
  function renderHook(){
    if(!Array.isArray(coin?.hook?.rules)||!coin.hook.rules.length){hookView?.render({coin,session});return;}
    if(hookView){hookView.render({coin,session});return;}
    if(hookLoading||disposed)return;hookLoading=true;
    let host=$('coin-hook');if(!host){host=el('section',null,'coin-hook');host.id='coin-hook';host.setAttribute('aria-label','Transfer hook rules');($('coin-creator-earnings')||$('coin-trade')).after(host);}
    Promise.resolve().then(()=>hookFactory()).then(module=>{if(disposed)return;hookView=module.createHookRulesCard({document,window,root:host,request:hookRequest,walletFactory,clock,setTimer,clearTimer});hookView.render({coin,session});}).catch(()=>{if(!disposed)host.hidden=true;}).finally(()=>{hookLoading=false;});
  }
  // The AI Agent section is mounted once for agent coins; its modules load lazily so ordinary coins pay nothing for it.
  // A shared #agent link scrolls once the agent has rendered: scrolling to the
  // short loading placeholder let the section's growth push it out of view.
  // Any scroll, tap or key press before then keeps the visitor's position.
  function mountAgent(){
    const host=$('coin-agent');if(!host||agentView||agentLoading)return;agentLoading=true;host.hidden=false;
    // `#agent` may carry the X connection result behind it (`#agent&x-connected=…`, v71.30); the agent section clears that part.
    const agentHash=()=>/^#agent(?:$|[&=])/.test(String(window.location?.hash||''));
    const deepLink=agentHash(),signals=['wheel','touchmove','pointerdown','keydown'];let moved=false;const interacted=()=>{moved=true;};
    const listen=on=>{for(const name of signals)window[on?'addEventListener':'removeEventListener']?.(name,interacted,true);};if(deepLink)listen(true);
    Promise.all([import('./agent-view.mjs'),import('./agent-fund.mjs')]).then(([view,fund])=>{if(disposed)return;agentView=view.createAgentView({document,window,root:host,mint,fetcher,clock,setTimer,clearTimer,fundingFactory:fund.createAgentFunding});agentView.setSession(session);return agentView.refresh();}).then(()=>{if(!disposed&&deepLink&&!moved&&agentHash())host.scrollIntoView?.({block:'start'});},()=>{if(!disposed){host.textContent='The agent section could not be loaded. Refresh to try again.';}}).finally(()=>{agentLoading=false;if(deepLink)listen(false);});
  }
  function removeChart(){chartGeneration++;chart?.remove();chart=null;chartLoading=false;chartVersion='';chartRetryAt=0;}
  function chartFailed(){removeChart();chartRetryAt=clock()+5000;const plot=$('coin-curve-plot');if(plot)plot.textContent='The chart is reconnecting. The confirmed price remains in Market overview.';}
  function chartEmpty(title,description){const key='empty:'+title+description;if(chartKey===key)return;removeChart();chartKey=key;const body=el('div',null,'coin-chart-empty');body.append(el('span','⌁'),el('h3',title),el('p',description));$('coin-chart').replaceChildren(body);}
  function updateNativeChart(){if(!chart||!nativeVisible())return;const native=nativeData(),version=JSON.stringify([native.points,native.candles,native.supply,mode,interval,native.trades]);if(version===chartVersion)return;try{chart.set(interval<60?[]:native.points,{mode,interval,supply:native.supply,candles:intervalCandles(native.candles,native.trades,interval)});chartVersion=version;}catch{chartFailed();}}
  function renderChart(){
    const native=nativeData(),pool=poolData(),showNative=nativeVisible();$('coin-chart-controls').hidden=!showNative;if($('coin-intervals'))$('coin-intervals').hidden=!showNative;
    if(showNative){
      if(chartKey!=='native'){removeChart();chartKey='native';const caption=el('div',null,'coin-curve-caption'),plot=el('div',null,'coin-curve-plot');caption.id='coin-curve-caption';plot.id='coin-curve-plot';$('coin-chart').replaceChildren(caption,plot);}
      $('coin-curve-caption').textContent=`${native.status!=='curve'?'Historical curve':native.candles?.length?coin.platform==='pump-classic'?'Pump.fun trading history':['meteora','damm-pump'].includes(coin.platform)?'Meteora trading history':coin.platform==='pumpswap'?'Launchpad trading history':'Raydium trading history':'Confirmed curve observations'} · ${native.quote.symbol||coin.quote.symbol}${mode==='fdv'?' · FDV uses current supply':''}`;
      if(interval<60)$('coin-curve-caption').textContent=`${interval}s · ${native.quote.symbol||coin.quote.symbol}${mode==='fdv'?' · FDV uses current supply':''} · Recent executed trades only${native.trades?.length?'':' · Waiting for trade history'}`;
      if(interval<60?native.tradesStale:native.historyStale)$('coin-curve-caption').textContent+=' · History delayed';
      // A flat series reads as a steady price rather than a broken chart.
      const levels=native.candles?.length?native.candles.map(c=>c.close):native.points.map(p=>p.priceQuote);if(levels.length>1&&levels.every(v=>v===levels[0]))$('coin-curve-caption').textContent+=' · Price steady';
      updateNativeChart();
      if(!chart&&!chartLoading&&clock()>=chartRetryAt){chartLoading=true;const generation=chartGeneration,plot=$('coin-curve-plot');plot.replaceChildren();Promise.resolve().then(()=>chartFactory(plot)).then(created=>{if(disposed||generation!==chartGeneration){created?.remove();return;}chart=created;chartLoading=false;updateNativeChart();}).catch(()=>{if(disposed||generation!==chartGeneration)return;chartFailed();});}
      return;
    }
    if(pool?.isBase===true){const src=dexScreenerUrl('solana',pool.address,{embed:true});if(src&&chartKey!==src){removeChart();chartKey=src;const frame=el('iframe');frame.title=`${coin.symbol||'Token'} chart from DEX Screener`;frame.src=src;frame.referrerPolicy='strict-origin-when-cross-origin';frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-popups');$('coin-chart').replaceChildren(frame);}return;}
    if(pool){chartEmpty('This chart is not available yet','DEX Screener charts the other token in this pair. The market overview shows this coin’s price and activity.');return;}
    const graduated=coin.stage==='graduated';
    chartEmpty(marketError?'Market data is temporarily unavailable':graduated?'Waiting for pool market data':'Warming up the curve',marketError?'Your coin remains onchain. This page will retry automatically.':graduated?'The chart appears when market data for this coin’s pool is available.':'The first confirmed curve price appears here without waiting for DEX Screener.');
  }
  function renderMarket(){
    const native=nativeData(),pool=poolData(),showNative=nativeVisible(),quote=coin.quote?.symbol||short(coin.quote?.mint),stale=!!(marketError||market?.stale||coin.stale);
    const metricsPool=!pool?.stale||stale?pool:null,currentNative=native?.status==='curve',nativeUsdOK=currentNative&&native.quote?.stale!==true;
    const coinNative=['Raydium onchain','Meteora onchain','Launchpad onchain'].includes(coin.marketSource),coinUsdOK=!coinNative||!native||nativeUsdOK;
    const poolCap=metricsPool?.isBase?number(metricsPool.marketCapUsd):null,cap=poolCap??number(coin.marketCapUsd),nativeFdv=number(nativeUsdOK?native.fdvUsd:null),coinFdv=number(coinUsdOK?coin.fdvUsd:null),poolFdv=metricsPool?.isBase?number(metricsPool.fdvUsd):null;
    const fdv=currentNative?nativeFdv??coinFdv??poolFdv:poolFdv??coinFdv;
    const capLabel=cap!==null?'Market cap':'Fully diluted value';$('coin-cap-label').textContent=capLabel;
    $('coin-cap').textContent=money(cap??fdv);
    const source=showNative?currentNative?(coin.platform==='pump-classic'?'Pump.fun onchain':['meteora','damm-pump'].includes(coin.platform)?'Meteora onchain':coin.platform==='pumpswap'?'Launchpad onchain':'Raydium onchain'):'Historical curve':pool?'DEX Screener':coin.marketSource||'Confirmed launch';$('coin-chart-source').textContent=source;
    const valueSource=cap===null&&fdv===null?'USD pricing unavailable':poolCap!==null||fdv===poolFdv&&nativeFdv===null&&coinFdv===null?'DEX Screener':currentNative&&nativeFdv!==null?(coin.platform==='pump-classic'?'Pump.fun onchain':['meteora','damm-pump'].includes(coin.platform)?'Meteora onchain':coin.platform==='pumpswap'?'Launchpad onchain':'Raydium onchain'):coin.marketSource||source;
    $('coin-cap-source').textContent=[valueSource,stale?'Data delayed':''].filter(Boolean).join(' · ');
    const nativeUsd=number(nativeUsdOK?native.priceUsd:null),coinUsd=number(coinUsdOK?coin.priceUsd:null),nativeQuote=number(currentNative?native.priceQuote:null),poolUsd=number(metricsPool?.priceUsd),usd=currentNative?nativeUsd??coinUsd??poolUsd:poolUsd??coinUsd;
    $('coin-price-label').textContent='Price · USD';$('coin-price').textContent=money(usd);
    $('coin-price-quote').textContent=nativeQuote!==null?quantity(nativeQuote)+' '+quote+' per token':usd===null?'USD pricing unavailable':'';
    const delta=metricsPool?.isBase&&typeof metricsPool.priceChange?.h24==='number'&&Number.isFinite(metricsPool.priceChange.h24)?metricsPool.priceChange.h24:typeof coin.priceChange24h==='number'&&Number.isFinite(coin.priceChange24h)&&!stale?coin.priceChange24h:null;
    const deltaText=delta===null?'':`${delta>0?'+':''}${delta.toLocaleString(undefined,{maximumFractionDigits:2})}% · 24h`,deltaClass=delta>0?'positive':delta<0?'negative':'';
    $('coin-change').textContent=deltaText;$('coin-change').className=deltaClass;
    // The headline stat repeats the 24h move as a chip when the pool reports one.
    const capChange=$('coin-cap-change');if(capChange){capChange.textContent=deltaText;capChange.className='coin-cap-change'+(deltaClass?' '+deltaClass:'');capChange.hidden=!deltaText;}
    const volumeUsd=coin.volume24h??metricsPool?.volume?.h24??metricsPool?.volume24h,volumeQuote=coin.volume24hQuote,partial=volumeUsd==null&&volumeQuote==null&&(coin.volumeObserved!=null||coin.volumeObservedQuote!=null);
    const volumeText=volumeUsd!=null?(coin.volumeUsdEstimate?'≈':'')+money(volumeUsd):volumeQuote!=null?quantity(volumeQuote)+' '+quote:coin.volumeObserved!=null?'≈'+money(coin.volumeObserved):coin.volumeObservedQuote!=null?quantity(coin.volumeObservedQuote)+' '+quote:'—';
    const stats=$('coin-stats');for(const [index,[label,value]] of [[partial?'Observed volume':'24h volume',volumeText],['Pool liquidity',money(metricsPool?.liquidityUsd)],['Token supply',compact(native?.supply??coin.supply)],['Fully diluted value',money(fdv)],['24h buys',compact(coin.buys24h??metricsPool?.txns?.h24?.buys)],['24h sells',compact(coin.sells24h??metricsPool?.txns?.h24?.sells)]].entries()){
      let nodes=statisticNodes[index];if(!nodes){const row=el('div');row.dataset.motionReveal='';nodes={label:el('span'),value:el('strong')};row.append(nodes.label,nodes.value);stats.append(row);statisticNodes[index]=nodes;}
      if(nodes.label.textContent!==label)nodes.label.textContent=label;if(nodes.value.textContent!==value)nodes.value.textContent=value;
    }
    const progress=number(native?.progressPercent??coin.progressPercent),showProgress=coin.stage!=='graduated'&&progress!==null;$('coin-progress-wrap').hidden=!showProgress;
    if(showProgress){const percent=Math.min(100,progress);$('coin-progress').value=percent;$('coin-progress-wrap').style?.setProperty?.('--progress',String(percent));$('coin-progress-wrap').classList.toggle('is-hot',percent>=75);$('coin-progress').setAttribute('aria-valuetext',`${quantity(percent)}% to graduation`);$('coin-progress-label').textContent=percent.toLocaleString(undefined,{maximumFractionDigits:2})+'%';$('coin-progress-raised').textContent=number(native?.raisedQuote)!==null&&number(native?.targetQuote)!==null?`${quantity(native.raisedQuote)} / ${quantity(native.targetQuote)} ${quote} raised`:'';}
    const dex=pool?dexScreenerUrl('solana',pool.address):null;$('coin-dex').hidden=!dex;if(dex)$('coin-dex').href=dex;
    const at=number(native&&showNative?native.at:market?.at??coin.marketAt),note=[at?'Updated '+new Date(at).toLocaleTimeString():'',showNative?`Chart prices are in ${quote}.`:'',showNative&&!currentNative?'Historical curve prices only. Current pool pricing appears when available.':'',stale?'Last available market reading.':'',coin.volumeUsdEstimate?'Volume in USD uses the current '+quote+' price.':'',partial?'Volume covers the retrieved trades; the full 24-hour history is unavailable.':'',marketError,native?.quote?.stale?'USD reference is delayed.':'',showNative&&currentNative&&native?.points?.length===1&&!native.candles?.length?'History builds as confirmed observations arrive.':''];$('coin-market-note').textContent=note.filter(Boolean).join(' ');
    renderChart();
  }
  // Automatic refreshes back off after a failure; a Refresh click (manual) asks again at once.
  async function refresh(force=false,manual=false){
    if(disposed||!coin||busy||!manual&&clock()<retryAt||(!force&&(document.hidden||clock()<nextAt)))return;
    busy=true;busyButton($('coin-refresh'),true);nextAt=clock()+15000;
    try{const data=await api('/api/explore/market?mint='+encodeURIComponent(mint));if(disposed)return;if(!validCoin(data.coin))throw Error('The market response did not match this coin.');coin=data.coin;market=data;marketError='';failures=0;retryAt=0;nextAt=clock()+Math.max(15000,Math.min(120000,Number(data.refreshMs)||15000));renderCoin();renderMarket();}
    catch(e){if(disposed)return;failures++;marketError=e.name==='AbortError'?'Market updates are taking longer than usual.':e.message;retryAt=clock()+Math.max(30000,Math.min(120000,Number(e.retryAfterMs)||15000*2**Math.min(3,failures)));renderMarket();renderRewards();}
    finally{busy=false;if(!disposed)busyButton($('coin-refresh'),false);}
  }
  // Pump.fun coins show their verified recipients, rewards and strategy in their own panel.
  function mountPumpClassic(){
    if(pumpClassicPanel||pumpClassicLoading||disposed)return;pumpClassicLoading=true;
    let host=$('coin-pump-classic');if(!host){host=el('section',null,'card coin-pump-classic');host.id='coin-pump-classic';host.setAttribute('aria-label','Pump.fun details');$('coin-rewards').after(host);}
    import('./pump-classic-coin.mjs').then(module=>{if(disposed)return;pumpClassicPanel=module.createPumpClassicPanel({document,root:host,api,mint,clock});void pumpClassicPanel.refresh(true);}).catch(()=>{if(!disposed)host.hidden=true;}).finally(()=>{pumpClassicLoading=false;});
  }
  function renderRewards(){if(coin?.platform==='pump-classic'){$('coin-rewards').hidden=true;mountPumpClassic();return;}if(['pumpswap','damm-pump'].includes(coin?.platform)){$('coin-rewards').hidden=true;return;}const now=clock();rewardsView.render({coin,data:rewards,busy:rewardsBusy,error:rewardsError,price:marketError?null:coinBurnPrice(coin,market,now),now});}
  async function refreshRewards(force=false,manual=false){
    if(disposed||coin?.platform==='pump-classic'||!['holders','buyback','gotchi','paycheck'].includes(coin?.feeMode)||rewardsBusy||!manual&&clock()<rewardsRetry||(!force&&(document.hidden||clock()<rewardsNext)))return;
    rewardsBusy=true;rewardsNext=clock()+30000;renderRewards();
    try{const data=await api('/api/explore/rewards?mint='+encodeURIComponent(mint));if(disposed)return;if(!validCoinRewards(data,coin))throw Error('The reward response did not match this coin.');rewards=data;rewardsError='';rewardsFailures=0;rewardsRetry=0;rewardsNext=clock()+Math.max(30000,Math.min(120000,Number(data.refreshMs)||30000));}
    catch(e){if(disposed)return;rewardsFailures++;rewardsError=e.name==='AbortError'?'Reward updates are taking longer than usual.':e.message;rewardsRetry=clock()+Math.max(30000,Math.min(120000,Number(e.retryAfterMs)||15000*2**Math.min(3,rewardsFailures)));}
    finally{rewardsBusy=false;if(!disposed)renderRewards();}
  }
  function tick(){if(!disposed&&!document.hidden&&chartKey==='native'&&!chart&&!chartLoading&&clock()>=chartRetryAt)renderChart();return Promise.all([refresh(),refreshRewards(),coin?activityView.refresh():Promise.resolve(),pumpClassicPanel&&!document.hidden?pumpClassicPanel.refresh():Promise.resolve()]);}
  const visibility=()=>{if(!document.hidden)tick();};
  function destroy(){if(disposed)return;disposed=true;clearTimer(timer);window.clearTimeout(copyTimer);window.clearTimeout?.(switchTimer);tradeView.destroy();activityView.destroy();agentView?.destroy();pumpClassicPanel?.destroy();hookView?.destroy();hookView=null;for(const controller of controllers)controller.abort();removeChart();document.removeEventListener('visibilitychange',visibility);window.removeEventListener?.('pagehide',destroy);}
  // Copy feedback shows on the button itself and clears after a few seconds;
  // the polite announcement repeats it for screen readers.
  function copyFeedback(state){
    const button=$('coin-copy');window.clearTimeout(copyTimer);copyTimer=null;button.dataset.copyState=state;
    button.textContent=state==='copied'?'Copied ✓':state==='failed'?'Copy failed':'Copy';
    $('coin-announcement').textContent=state==='copied'?'Token address copied.':state==='failed'?'Copy this address: '+mint:'';
    if(state!=='idle')copyTimer=window.setTimeout(()=>{copyTimer=null;if(!disposed)copyFeedback('idle');},state==='copied'?2500:6000);
  }
  $('coin-copy').onclick=async()=>{if(!coin||disposed)return;try{await window.navigator.clipboard.writeText(mint);if(!disposed)copyFeedback('copied');}catch{if(!disposed)copyFeedback('failed');}};
  $('coin-refresh').onclick=()=>Promise.all([refresh(true,true),refreshRewards(true,true)]);
  // Presentation only: the plot dips for a moment while a new interval or mode is drawn, so the switch reads as a crossfade.
  let switchTimer=null;const switchChart=()=>{const host=$('coin-chart');if(!host?.classList)return;host.classList.add('is-switching');window.clearTimeout?.(switchTimer);switchTimer=window.setTimeout?.(()=>{if(!disposed)host.classList.remove('is-switching');},320);};
  for(const button of document.querySelectorAll('[data-coin-chart]'))button.onclick=()=>{mode=button.dataset.coinChart;for(const other of document.querySelectorAll('[data-coin-chart]'))other.setAttribute('aria-pressed',String(other===button));switchChart();renderChart();};
  for(const button of document.querySelectorAll('[data-coin-interval]'))button.onclick=()=>{interval=Number(button.dataset.coinInterval);for(const other of document.querySelectorAll('[data-coin-interval]'))other.setAttribute('aria-pressed',String(other===button));switchChart();renderChart();};
  shell({chain:'solana',page:'coin'});document.addEventListener('visibilitychange',visibility);window.addEventListener?.('pagehide',destroy);const timer=setTimer(tick,1000);
  const ready=(async()=>{if(!address(mint)){error('Choose a coin from Explore to open its market.',{missing:true});$('coin-loading').hidden=true;return;}try{const data=await api('/api/explore/token?mint='+encodeURIComponent(mint));if(disposed)return;if(!validCoin(data.coin))throw Object.assign(Error('This Launchpad coin could not be found.'),{missing:true});coin=data.coin;renderCoin();renderMarket();await Promise.all([refresh(true),refreshRewards(true),activityView.refresh(true)]);}catch(e){if(disposed)return;if(e.status===404||e.missing)document.title='Coin not found — Launchpad';error(e.status===404?'This coin is not listed on Launchpad.':e.name==='AbortError'?'This coin is taking longer to load. Refresh the page to try again.':e.message,{missing:e.status===404||!!e.missing});$('coin-loading').hidden=true;}})();
  return {ready,refresh,refreshRewards,tick,destroy,canLeave:()=>tradeView.canLeave?.()!==false&&agentView?.canLeave?.()!==false&&hookView?.canLeave?.()!==false,setSession:next=>{session=next;tradeView.setSession(next);agentView?.setSession(next);if(coin)renderHook();}};
}
