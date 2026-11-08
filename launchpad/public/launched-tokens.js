import {bootPage} from './navigation.mjs';
import {createMeteoraAccountLaunches} from './meteora-account-ui.mjs';
import {coinImage} from './coin-image.mjs';
import {createQuoteLabel} from './quote-logos.mjs';
import { createPersonalEarnings } from './personal-earnings.mjs';
import { createCoinTrade } from './coin-trade.mjs';
import { createWorkspaceShell } from './workspace-shell.js';
import { createHoldersView } from './holders-view.mjs';
import { createLiveTradesView, updateTradeAges } from './live-trades-view.mjs';
import { QUOTE_DISPLAY_ASSETS as LAUNCH_ASSETS } from './quote-display-assets.mjs';
import { getLaunchpadWallet as createLaunchpadWallet } from './launchpad-wallet.mjs';
import { creatorClaimState, runCreatorClaim } from './creator-claims.mjs';
import { curveChartSnapshot } from './launch-curve-chart.mjs';
import { createCoinRewardsView, validCoinRewards } from './coin-rewards-view.mjs';
import { createHookRulesCard, createHookChip } from './hook-ui.mjs';

const mintAddress = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// A receiving wallet must decode to exactly 32 bytes: length and alphabet alone
// also accept an address that a paste or a typo cut short.
const validWallet = value => {
  if(!mintAddress(value))return false;
  const bytes=[];for(const char of value){let carry=BASE58.indexOf(char);for(let i=0;i<bytes.length;i++){carry+=bytes[i]*58;bytes[i]=carry&255;carry>>=8;}while(carry>0){bytes.push(carry&255);carry>>=8;}}
  for(let i=0;i<value.length&&value[i]==='1';i++)bytes.push(0);
  return bytes.length===32;
};
// Proxies answer outages with HTML and slow requests are aborted: show readable text, never a parser or abort error.
const UNAVAILABLE='Launchpad is temporarily unavailable. Please try again shortly.',SLOW='Launchpad is taking longer than usual to respond. Please try again shortly.',OFFLINE='Launchpad could not be reached. Check your connection and try again.';
const launchId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const mainnetLaunch = launch => !launch?.input?.network || launch.input.network==='mainnet-beta';
const legacyLaunch = launch => !!launch?.archived || !mainnetLaunch(launch);
const launchHasMarket = launch => !legacyLaunch(launch) && launchIsOnchain(launch);
const numeric = value => value != null && value !== '' && ['string','number'].includes(typeof value) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const money = value => { const n=numeric(value);return n===null?'—':new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',...(n>=1000?{notation:'compact',maximumFractionDigits:2}:{maximumSignificantDigits:5})}).format(n); };
const quoteValue = (value,symbol='') => { const n=numeric(value);return n===null?'—':`${n.toLocaleString(undefined,{maximumSignificantDigits:6})}${symbol?' '+symbol:''}`; };
const count = value => { const n=numeric(value);return n===null?'—':new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:2}).format(n); };
const short = value => typeof value==='string'&&value.length>16?`${value.slice(0,6)}…${value.slice(-6)}`:value||'—';
const date = value => { const at=Number(value);return Number.isFinite(at)&&at>0?new Date(at).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'Date unavailable'; };
const modes = {creator:'Creator wallet',holders:'Holder rewards',paycheck:'Paycheck · every 15 minutes',buyback:'Buy back & burn',gotchi:'Gotchi prize pot',agent:'AI Agent · 30% operations / 70% treasury'};
const launchMode = launch => launch?.gotchi ? 'gotchi' : launch?.agent ? 'agent' : launch?.input?.paycheck?.policy ? 'paycheck' : launch?.input?.feeMode;
const pairedAsset = launch => LAUNCH_ASSETS.find(asset=>asset.mint===launch.input?.quoteMint)?.symbol||launch.holderRewards?.quoteSymbol||launch.review?.quoteSymbol||short(launch.input?.quoteMint);
const safeUrl = value => { try { const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null; }catch{return null;} };

export function launchIsOnchain(launch) {
  return mintAddress(launch?.mint) && (!!launch.curve || (launch.operations||[]).some(op=>['create','launch-all'].includes(op.kind)&&op.state==='confirmed'&&typeof op.signature==='string'&&op.signature));
}
export function launchStatus(launch) {
  if(launch?.hidden)return {label:'Hidden',tone:'draft'};
  if(launch?.listArchived||legacyLaunch(launch))return {label:'Archived',tone:'draft'};
  if(launchIsOnchain(launch))return launch.curve?{label:launch.state==='paused'||launch.state==='error'?'Service paused':'Onchain',tone:''}:(['error','paused','failed'].includes(launch.state)||launch.recovery?.status==='blocked')&&!launch.retry?{label:'Verification needs attention',tone:'error'}:{label:'Verifying launch',tone:'pending'};
  if(launch.state==='draft')return {label:'Draft',tone:'draft'};
  if(launch.state==='error'||launch.state==='paused'||launch.state==='failed')return {label:'Needs attention',tone:'error'};
  if(launch.state==='awaiting_signature')return {label:'Approval needed',tone:'pending'};
  return {label:'In progress',tone:'pending'};
}
const category = launch => launch.listArchived||launch.hidden||legacyLaunch(launch)?'archived':launchIsOnchain(launch)?'launched':'drafts';

export function createLaunchedTokensPage({document,window,fetcher=fetch,clock=Date.now,setTimer=setInterval,clearTimer=clearInterval,walletFactory=createLaunchpadWallet,claimWait=ms=>new Promise(resolve=>window.setTimeout(resolve,ms)),shell=createWorkspaceShell,tradeFactory=createCoinTrade,chartFactory=async container=>(await import('./launch-curve-chart.mjs')).createLaunchCurveChart(container)}={}) {
  shell({page:'launched-tokens',chain:'solana'});
  const $=id=>document.getElementById(id);
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
  const params=new URLSearchParams(window.location.search),requested=params.get('id');
  const earnings=createPersonalEarnings({document,root:$('personal-earnings'),api,clock,visible:()=>!requested});
  let csrf='',launches=[],selected=null,filter=params.get('view')==='archived'?'archived':'launched',tab='trades',disposed=false,authenticated=false;
  let archiveBusy='',listRevision=0,redirectBusy=false,redirectDraft=null,redirectWallet='';
  let assignedFees=[],assignedWallet='',assignedLoading=false,assignedNext=0,assignedRetry=0,assignedRevision=0,assignedClaimBusy='',assignedError='',assignedLoaded=false,assignedNeedsWallet=false;
  const assignedClaims=new Map();
  let sessionGeneration=0,accountIdentity='',sessionReceived=false,assignedSessionIdentity='',sessionExpired=false,sessionLoading=false,sessionFailures=0,sessionRetryAt=0;
  const accountUpdated=event=>{if(event.detail)void activateSession(event.detail);};document.addEventListener('curve-account-updated',accountUpdated);
  let activated=false,listBusy=false,listVersion='',detailVersion='',listNext=0,marketBusy=false,marketNext=0,marketRetry=0,marketRefresh=60000;
  let pools=[],pair=null,marketData=null,marketError='',chartKey='',activityVersion='',epoch=0,holders=null,holderError='',holderBusy=false,holderNext=0,holderRetry=0;
  let live=null,liveError='',liveBusy=false,liveNext=0,liveFailures=0,activityVisible=true;
  let curveData=null,curveError='',curveBusy=false,curveNext=0,curveRetry=0,curveChart=null,curveChartGeneration=0,curveMode='price',curveRenderedVersion='',curveLoading=false,curveRenderRetry=0;
  const dexReady=()=>!!pair&&pair.base?.address===selected?.mint&&!marketError&&!marketData?.stale;
  const nativeAvailable=()=>curveData&&Array.isArray(curveData.points)&&(curveData.points.length||curveData.candles?.length);
  const showingCurve=()=>!!nativeAvailable()&&(curveData.status==='curve'||!dexReady());
  const tradeMarket=()=>pair?.address||(mintAddress(selected?.curve)?selected.curve:null);
  const histories=new Map(),controllers=new Set(),claimItems=new Map();
  let rewardsData=null,rewardsBusy=false,rewardsNext=0,rewardsRetry=0,rewardsError='';
  let buybackData=null,buybackBusy=false,buybackNext=0,buybackRetry=0,buybackError='',buybackKey='',buybackEpoch=0,buybackController=null;
  const tradeView=tradeFactory({document,window,root:$('token-trade'),fetcher,clock,walletFactory,setTimer,clearTimer,onConfirmed:()=>Promise.all([refreshMarket(true),refreshCurve(true),refreshTrades(true),refreshHolders(true)])});
  const buybackView=createCoinRewardsView({document,root:$('token-buyback'),onRefresh:()=>refreshBuyback(true)});
  let claimsBusy=false,claimsSummary='',wallet=null,walletUnsubscribe=null,walletResolve=null,walletReject=null,expectedWallet='';
  const meteoraRoot=el('section');meteoraRoot.id='tokens-meteora';$('tokens-list').after(meteoraRoot);
  const pumpClassicRoot=el('section');pumpClassicRoot.id='tokens-pump-classic';pumpClassicRoot.hidden=true;meteoraRoot.before(pumpClassicRoot);let pumpClassicRows=[];
  // v71.39: Robinhood Chain launches (Launchpad's own contracts), listed before the Solana venues.
  const robinhoodRoot=el('section');robinhoodRoot.id='tokens-robinhood';robinhoodRoot.hidden=true;pumpClassicRoot.before(robinhoodRoot);let robinhoodRows=[];
  // Transfer hook rules (v71.28): hooked coins' launch rows carry `hook` ({ rules, route, gateMint, titheRecipient,
  // blocklistCount, active, ended, allowlist }). Their Meteora cards get a "Hooked" chip (with a "Launchpad route" marker when
  // the coin trades on Launchpad only until graduation) and the shared Rules card with the blocklist viewer and the allowlist
  // manager (hook-ui.mjs). The rows are read as they pass to the Meteora section (no second request); the cards are
  // decorated whenever that section renders, and a card's panel is kept per mint so typed wallets and an in-flight
  // transaction survive re-renders.
  const hookedRows=new Map(),hookPanels=new Map();let hookSession=null,hookDecorating=false,hookDecorationPending=false,hookObserver=null;
  const meteoraApi=(path,body)=>api(path,body).then(data=>{if(path==='/api/launchpad/meteora/launches')captureHookedRows(data);return data;});
  const meteoraLaunches=createMeteoraAccountLaunches({document,window,root:meteoraRoot,api:meteoraApi,clock,walletFactory,setTimer,clearTimer});meteoraLaunches.setFilter(filter);
  function captureHookedRows(data){
    const rows=Array.isArray(data)?data:Array.isArray(data?.launches)?data.launches:[];hookedRows.clear();
    for(const row of rows)if(mintAddress(row?.mint)&&Array.isArray(row.hook?.rules)&&row.hook.rules.length)hookedRows.set(row.mint,row);
    scheduleHookDecoration();
  }
  const hookRequest=(path,body)=>api('/api/launchpad/meteora'+path,body);
  function hookPanel(mint){
    if(hookPanels.has(mint))return hookPanels.get(mint);
    const root=el('div',null,'token-hook-rules'),panel=createHookRulesCard({document,window,root,request:hookRequest,walletFactory,clock,setTimer,clearTimer,heading:'Transfer hook rules'});
    const entry={root,panel};hookPanels.set(mint,entry);return entry;
  }
  function scheduleHookDecoration(){if(disposed||hookDecorationPending)return;hookDecorationPending=true;(typeof window.setTimeout==='function'?window.setTimeout:setTimeout)(()=>{hookDecorationPending=false;decorateHookedCards();},0);}
  function decorateHookedCards(){
    if(disposed||hookDecorating)return;hookDecorating=true;
    try{
      for(const card of meteoraRoot.querySelectorAll('article.token-card')){
        const href=card.querySelector('a.token-card-open')?.getAttribute('href')||'',mint=/^\/coin\?mint=([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(href)?.[1],row=mint?hookedRows.get(mint):null;if(!row)continue;
        const state=card.querySelector('.token-card-state'),body=card.querySelector('.token-card-body');
        if(state&&!state.querySelector('.token-hook-chip')){const chip=createHookChip(document,row.hook,{className:'token-status token-hook-chip'});if(chip)state.append(chip);}
        if(!body)continue;const {root,panel}=hookPanel(mint);if(root.parentElement!==body)body.append(root);
        panel.render({coin:{mint:row.mint,symbol:row.symbol,name:row.name,stage:row.stage,curveStatus:row.curveStatus,hook:row.hook,creator:row.creator},session:hookSession,owner:row.creatorId===undefined||row.creatorId===hookSession?.account?.id});
      }
    }finally{hookDecorating=false;}
  }
  function clearHookPanels(){hookedRows.clear();for(const {panel,root} of hookPanels.values()){panel.destroy();root.remove();}hookPanels.clear();}
  // Only the Meteora section's own re-renders (cards replaced inside its grid) trigger a decoration pass; mutations inside a
  // card, such as the allowlist manager redrawing its list, are ours and must not start another pass.
  try{const Observer=typeof window.MutationObserver==='function'?window.MutationObserver:document.defaultView?.MutationObserver;if(typeof Observer==='function'){hookObserver=new Observer(mutations=>{if(hookedRows.size&&mutations.some(mutation=>mutation.target===meteoraRoot||mutation.target.classList?.contains('tokens-grid')))scheduleHookDecoration();});hookObserver.observe(meteoraRoot,{childList:true,subtree:true});}}catch{hookObserver=null;}
  function error(message=''){$('tokens-error').textContent=message;$('tokens-error').hidden=!message;}
  // Empty states: a short friendly line and, where the page has room for whimsy, a Gotchi peeking in.
  // The character module is loaded only when an empty state shows; it is decorative and never required.
  const GOTCHI_PEEK={launched:['pumpgotchi','Pumpgotchi is keeping the seat warm.'],drafts:['fomogotchi','Fomogotchi checked twice. Nothing is waiting.'],archived:['pumpgotchi','Pumpgotchi keeps the archive tidy.'],missing:['fomogotchi','Fomogotchi looked everywhere.']};
  const gotchis=new Set();let gotchiModule=null;
  function clearGotchis(root){for(const entry of gotchis){if(!root||root.contains(entry.element)||!entry.element.isConnected){entry.destroy();gotchis.delete(entry);}}}
  function peekGotchi(box,theme){
    if(typeof window?.matchMedia!=='function'||typeof window.setTimeout!=='function'||typeof document.createElementNS!=='function')return;
    const host=el('div',null,'tokens-empty-gotchi');host.setAttribute('aria-hidden','true');box.prepend(host);
    (gotchiModule||=Promise.resolve().then(()=>import('./gotchi-character.mjs'))).then(({createGotchiCharacter})=>{
      if(disposed||!host.isConnected)return;const entry=createGotchiCharacter({document,window,theme,stage:1,size:'mini',interactive:false});gotchis.add(entry);host.replaceChildren(entry.element);
    }).catch(()=>{host.remove();});
  }
  // Presentation only: a sliding indicator under the selected launch filter, and
  // the private reward totals handed to the shared motion layer (curve-motion)
  // through data-motion-number, which counts a first value up and flashes a
  // change. The rendered text is never altered; it only gets its own element.
  const filterNav=document.querySelector('.tokens-filters');
  function paintFilters(){const active=filterNav?.querySelector('[aria-pressed="true"]');if(!active||typeof filterNav.style?.setProperty!=='function'||!Number.isFinite(active.offsetLeft)||!active.offsetWidth)return;filterNav.style.setProperty('--tab-x',active.offsetLeft+'px');filterNav.style.setProperty('--tab-w',String(active.offsetWidth));filterNav.classList.add('has-indicator');}
  const filterObserver=filterNav&&typeof window.ResizeObserver==='function'?new window.ResizeObserver(()=>paintFilters()):null;filterObserver?.observe(filterNav);
  const earningsRoot=$('personal-earnings');
  function paintEarnings(){if(disposed)return;for(const value of earningsRoot.querySelectorAll('.personal-earnings-value')){if(value.querySelector('[data-motion-number]')||!/\d/.test(value.textContent))continue;const digits=el('span',value.textContent);digits.dataset.motionNumber='';value.replaceChildren(digits);}}
  // Wrapped in a separate task: the motion layer scans the freshly rendered
  // card in its own microtask, and a number element must arrive after that scan
  // to be treated as a new value.
  const earningsObserver=earningsRoot&&typeof window.MutationObserver==='function'?new window.MutationObserver(()=>{(typeof window.setTimeout==='function'?window.setTimeout:setTimeout)(paintEarnings,0);}):null;
  earningsObserver?.observe(earningsRoot,{childList:true,subtree:true});
  function expire(message){document.getElementById('tokens-pumpswap')?.remove();document.getElementById('tokens-damm-pump')?.remove();meteoraLaunches.clear();clearHookPanels();clearPumpClassic();clearRobinhood();
    authenticated=false;resetFeeRedirect();clearAssignedFees();earnings.clear();$('tokens-main').hidden=true;$('tokens-gate').hidden=false;
    $('tokens-gate-message').textContent=message||(sessionExpired?'Your session expired. Connect your wallet to view your launches.':'Connect your wallet to view your launches.');
    const signIn=$('tokens-gate').querySelector('a');if(signIn)signIn.hidden=false;
    if(!$('tokens-gate').querySelector('.tokens-empty-gotchi'))peekGotchi($('tokens-gate'),'fomogotchi');
  }
  // A 401 means the server ended this session: sign the header (and every
  // other listener, including this page) out instead of leaving it signed in.
  function sessionEnded(){
    if(disposed||!authenticated)return;sessionExpired=true;expire();
    const View=document.defaultView||window;if(typeof View?.CustomEvent==='function')document.dispatchEvent(new View.CustomEvent('curve-account-updated',{detail:{authenticated:false,account:null,token:''}}));
  }
  async function api(path,body) {
    const generation=sessionGeneration,controller=new AbortController();controllers.add(controller);
    const cancelled=()=>Object.assign(Error('Your account changed.'),{cancelled:true});
    const timer=window.setTimeout(()=>controller.abort(),15000);
    try{
      let response;
      try{response=await fetcher(path,{method:body===undefined?'GET':'POST',headers:{'x-control-token':csrf,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal,credentials:'same-origin'});}
      catch(e){if(disposed||generation!==sessionGeneration)throw cancelled();throw Error(controller.signal.aborted||e?.name==='AbortError'?SLOW:OFFLINE);}
      const data=await response.json().catch(()=>null);
      if(disposed||generation!==sessionGeneration)throw cancelled();
      if(!response.ok){if(response.status===401)sessionEnded();throw Object.assign(Error(typeof data?.error==='string'&&data.error?data.error:response.status>=500||!data?UNAVAILABLE:'This information could not be loaded.'),{statusCode:response.status,retryAfterMs:data?.retryAfterMs});}
      if(!data||typeof data!=='object')throw Error(controller.signal.aborted?SLOW:UNAVAILABLE);
      return data;
    }finally{window.clearTimeout(timer);controllers.delete(controller);}
  }
  function link(text,href,cls,external=false){const a=el('a',text,cls);a.href=href;if(external){a.target='_blank';a.rel='noopener noreferrer';}return a;}
  const assignedKey=row=>row.ownerAccountId+':'+row.id;
  function clearAssignedFees(){
    assignedRevision++;assignedFees=[];assignedWallet='';assignedLoading=false;assignedNext=0;assignedRetry=0;assignedClaimBusy='';assignedError='';assignedLoaded=false;assignedNeedsWallet=false;assignedClaims.clear();
    $('assigned-fees').hidden=true;$('assigned-fees-list').replaceChildren();$('assigned-fees-status').textContent='';$('assigned-fees-refresh').disabled=true;
  }
  function assignedRow(value,wallet=assignedWallet){
    if(!value||!launchId(value.ownerAccountId)||!launchId(value.id)||!mintAddress(value.mint)||!mintAddress(wallet)||value.recipient!==wallet||value.ownerAccountId===accountIdentity)return null;
    return {ownerAccountId:value.ownerAccountId,id:value.id,mint:value.mint,name:typeof value.name==='string'?value.name.slice(0,100):'Token',symbol:typeof value.symbol==='string'?value.symbol.slice(0,30):'Token',image:coinImage(value.mint,value.image)||'',quote:{mint:value.quote?.mint,symbol:typeof value.quote?.symbol==='string'?value.quote.symbol.slice(0,30):''},recipient:value.recipient,claim:{available:value.claim?.available===true,busy:value.claim?.busy===true,status:value.claim?.status,reason:typeof value.claim?.reason==='string'?value.claim.reason.slice(0,500):''},collectedDisplay:typeof value.collectedDisplay==='string'&&/^\d{1,80}(\.\d{1,18})?$/.test(value.collectedDisplay)?value.collectedDisplay:null,lastCycle:Number.isSafeInteger(value.lastCycle)&&value.lastCycle>=0?value.lastCycle:0,lastClaimAt:Number.isSafeInteger(value.lastClaimAt)&&value.lastClaimAt>0?value.lastClaimAt:0,lastClaimResult:['claimed','empty'].includes(value.lastClaimResult)?value.lastClaimResult:null,operations:(Array.isArray(value.operations)?value.operations:[]).filter(op=>['confirmed','pending'].includes(op.state)&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(op.signature||'')).slice(-10).map(op=>({state:op.state,signature:op.signature}))};
  }
  function acceptAssignedProgress(row){
    const state=assignedClaims.get(assignedKey(row));if(!state)return;
    if(row.claim.busy){state.state='queued';state.text='Claim queued. Launchpad is processing the saved operation.';}
    else if(row.lastCycle>state.lastCycle||row.lastClaimAt>state.lastClaimAt){state.state='complete';state.requestId='';state.text=row.lastClaimResult==='empty'?'No unclaimed fees were available.':'Claim processing completed. Confirmed transactions appear below.';}
    else if(row.claim.status==='paused'){state.state='paused';state.requestId='';state.text=row.claim.reason||'This fee claim is paused. Retry assigned fees to continue the saved payout.';}
    else if(!row.claim.available){state.state='unavailable';state.text=row.claim.reason||'This assigned fee claim is not available right now.';}
    else if(['paused','unavailable'].includes(state.state)){assignedClaims.delete(assignedKey(row));}
  }
  function renderAssignedFees(){
    const section=$('assigned-fees');if(disposed||!authenticated||requested){section.hidden=true;return;}section.hidden=false;
    const refresh=$('assigned-fees-refresh');refresh.disabled=assignedLoading||!!assignedClaimBusy||clock()<assignedRetry;
    const status=$('assigned-fees-status');status.textContent=assignedError||(!assignedLoaded?'Loading fees assigned to your wallet…':assignedNeedsWallet?'Connect the wallet assigned to receive creator fees to view them here.':'Fees are paid to the receiving wallet shown on each coin.');status.classList.toggle('negative',!!assignedError);
    const list=$('assigned-fees-list');list.replaceChildren();
    if(!assignedFees.length){if(assignedLoaded&&!assignedError&&!assignedNeedsWallet)list.append(el('p','No creator fees are currently assigned to your wallet.','tokens-empty'));return;}
    for(const row of assignedFees){
      const key=assignedKey(row),state=assignedClaims.get(key),card=el('article',null,'assigned-fee-card');card.dataset.feeAssignment=key;card.dataset.motionReveal='';
      const top=el('div',null,'token-launch-card-top'),picture=el('div',null,'token-avatar'),identity=el('div',null,'token-card-identity');picture.append(el('span',(row.symbol||row.name||'T').slice(0,1).toUpperCase()));
      if(row.image){const image=el('img');image.alt='';image.loading='lazy';image.src=row.image;picture.firstElementChild.hidden=true;picture.append(image);image.onerror=()=>{image.remove();picture.firstElementChild.hidden=false;};}
      identity.append(el('h3',row.name),el('p',row.symbol));top.append(picture,identity);card.append(top);
      const quoteSymbol=LAUNCH_ASSETS.find(asset=>asset.mint===row.quote.mint)?.symbol||row.quote.symbol||short(row.quote.mint),meta=el('div',null,'token-card-meta');
      for(const [label,value]of [['Paired with',quoteSymbol],['Collected awaiting payout',row.collectedDisplay===null?'—':row.collectedDisplay+' '+quoteSymbol]]){const item=el('div');item.append(el('span',label),el('strong',value));meta.append(item);}
      const receiving=el('div');receiving.append(el('span','Receiving wallet'),link(row.recipient,'https://solscan.io/account/'+row.recipient,'',true));meta.append(receiving);card.append(meta,link('Open token ↗','/coin?mint='+encodeURIComponent(row.mint),'token-card-link'));
      const actions=el('div',null,'assigned-fee-actions'),claim=el('button',assignedClaimBusy===key?'Checking claim…':row.claim.busy?'Claim processing…':state?.state==='uncertain'?'Check claim':row.claim.status==='paused'?'Retry assigned fees':'Claim assigned fees','small-button token-claim-button');claim.type='button';claim.dataset.assignedClaim=key;claim.disabled=assignedLoading||!!assignedClaimBusy||!!assignedError||row.claim.busy||!row.claim.available;claim.onclick=()=>claimAssignedFees(row.ownerAccountId,row.id);
      const note=el('p',state?.text||row.claim.reason||(row.claim.busy?'Launchpad is processing this claim.':'Launchpad sends available creator fees to your receiving wallet.'),'token-claim-note'+(state?.state==='uncertain'?' negative':''));note.setAttribute('role','status');actions.append(claim,note);
      for(const operation of row.operations)actions.append(link(operation.state==='confirmed'?'View confirmed transaction ↗':'View pending transaction ↗','https://solscan.io/tx/'+operation.signature,'token-claim-receipt',true));card.append(actions);list.append(card);
    }
  }
  async function refreshAssignedFees(force=false){
    if(disposed||!authenticated||requested||document.hidden||assignedLoading||assignedClaimBusy||clock()<assignedRetry||(!force&&clock()<assignedNext))return;
    const generation=sessionGeneration,revision=assignedRevision;assignedLoading=true;renderAssignedFees();
    try{
      const data=await api('/api/launchpad/fee-assignments');if(disposed||!authenticated||generation!==sessionGeneration||revision!==assignedRevision)return;
      if(!Array.isArray(data.assignments)||(!mintAddress(data.wallet)&&data.wallet!==null))throw Error('Fee assignment response unavailable.');
      assignedWallet=data.wallet||'';assignedNeedsWallet=data.requiresWalletSignIn===true;assignedFees=assignedNeedsWallet?[]:data.assignments.map(row=>assignedRow(row)).filter(Boolean).filter((row,index,all)=>all.findIndex(other=>assignedKey(other)===assignedKey(row))===index);
      const keys=new Set(assignedFees.map(assignedKey));for(const key of assignedClaims.keys())if(!keys.has(key))assignedClaims.delete(key);for(const row of assignedFees)acceptAssignedProgress(row);
      const processing=assignedFees.some(row=>row.claim.busy)||[...assignedClaims.values()].some(state=>['working','queued','uncertain'].includes(state.state));
      assignedLoaded=true;assignedError='';assignedRetry=0;assignedNext=clock()+Math.max(processing?5000:30000,Math.min(60000,Number(data.refreshMs)||(processing?5000:30000)));
    }catch(e){
      if(disposed||!authenticated||generation!==sessionGeneration||revision!==assignedRevision)return;
      if([403,404].includes(e.statusCode)){assignedFees=[];assignedWallet='';assignedClaims.clear();assignedError='Fee assignments are unavailable for this session. Connect your receiving wallet and refresh.';}
      else assignedError=assignedLoaded?'Fee assignments could not be refreshed. Refresh fees before claiming.':'Fee assignments are temporarily unavailable. Use Refresh fees to try again.';
      assignedRetry=Number(e.retryAfterMs)>0?clock()+Math.max(5000,Math.min(300000,Number(e.retryAfterMs))):0;assignedNext=Math.max(assignedRetry,clock()+30000);
    }finally{if(generation===sessionGeneration&&revision===assignedRevision){assignedLoading=false;renderAssignedFees();}}
  }
  async function claimAssignedFees(ownerAccountId,id){
    const key=ownerAccountId+':'+id,row=assignedFees.find(item=>assignedKey(item)===key);
    if(disposed||!authenticated||requested||assignedLoading||assignedClaimBusy||assignedError||!row?.claim.available||row.claim.busy)return;
    const generation=sessionGeneration,revision=++assignedRevision;assignedClaimBusy=key;
    const previous=assignedClaims.get(key),state=previous?.requestId?previous:{requestId:globalThis.crypto.randomUUID(),lastCycle:row.lastCycle,lastClaimAt:row.lastClaimAt};state.state='working';state.text='Queueing your fee claim…';assignedClaims.set(key,state);renderAssignedFees();
    try{
      const data=await api('/api/launchpad/fee-assignments/claim',{ownerAccountId,id,requestId:state.requestId});if(disposed||!authenticated||generation!==sessionGeneration||revision!==assignedRevision)return;
      const next=assignedRow(data.assignment);if(!next||assignedKey(next)!==key)throw Object.assign(Error('The assignment changed.'),{statusCode:403});
      assignedFees=assignedFees.map(item=>assignedKey(item)===key?next:item);state.state=next.claim.busy?'queued':'complete';state.text=data.alreadyRequested?'This claim was already received. Launchpad is checking its progress.':next.claim.busy?'Claim queued. Launchpad is processing the saved operation.':'Fee claim request received. Refreshing its status…';state.requestId='';acceptAssignedProgress(next);assignedNext=clock()+5000;
    }catch(e){
      if(disposed||!authenticated||generation!==sessionGeneration||revision!==assignedRevision)return;
      if([403,404].includes(e.statusCode)){assignedFees=assignedFees.filter(item=>assignedKey(item)!==key);assignedClaims.delete(key);assignedError='This fee assignment is no longer available to your wallet. Refresh fees to check your current assignments.';}
      else{state.state='uncertain';state.text='This claim could not be confirmed. Use Check claim to retry the same request safely.';}
      assignedNext=clock()+5000;
    }finally{if(generation===sessionGeneration&&revision===assignedRevision){assignedClaimBusy='';renderAssignedFees();}}
  }
  function avatar(launch,root=el('div',null,'token-avatar')){
    root.replaceChildren();const initial=(launch.input?.name||launch.input?.symbol||'R').slice(0,1).toUpperCase();root.append(el('span',initial));
    const imageId=launch.input?.imageId,url=coinImage(launch.mint,typeof imageId==='string'&&/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(imageId)?'/token-images/'+imageId:null);
    if(url){const image=el('img');image.alt='';image.loading='lazy';image.src=url;root.append(image);root.firstElementChild.hidden=true;image.onerror=()=>{image.remove();root.firstElementChild.hidden=false;};}
    return root;
  }
  const statusSlug=label=>String(label||'').toLowerCase().replace(/[^a-z]+/g,'-').replace(/^-|-$/g,'');
  function status(launch){const value=launchStatus(launch),chip=el('span',value.label,`token-status ${value.tone}`.trim());chip.dataset.status=statusSlug(value.label);return chip;}
  function recoveryText(recovery){
    if(recovery.status==='complete'){const amount=Number(recovery.refundedLamports||0)/1e9;return amount>0?`${quoteValue(amount,'SOL')} returned to ${short(recovery.refundWallet)}.`:recovery.reason||'Setup recovery is complete.';}
    return recovery.status==='refunding'?'Returning unused setup SOL…':recovery.status==='checking'?'Checking unused setup funds…':recovery.reason||'Setup recovery needs attention.';
  }
  function renderArchiveControl(root,launch){
    root.replaceChildren();
    const archived=category(launch)==='archived',restore=!!launch.canRestore&&!launch.hidden&&!legacyLaunch(launch),canArchive=!!launch.canArchive&&!archived;
    if(legacyLaunch(launch))root.append(el('p','Earlier launch record · '+(launch.input?.network||'mainnet-beta'),'token-archive-note'));
    if(archived)root.append(el('p',launch.hidden?'Hidden from public listings. Only an administrator can change its visibility.':'Archived from your active launches.','token-archive-note'));
    if(archived||canArchive)root.append(el('p',launchIsOnchain(launch)?'Saved details and transaction history remain available. Reward settings are unchanged.':'Saved details and transaction history remain available. Any setup recovery continues in the background.','token-archive-note'));
    if(root.id==='token-archive-detail'&&launch.recovery)root.append(el('p',recoveryText(launch.recovery),'token-recovery-note'));
    if(canArchive||restore){
      const button=el('button',archiveBusy===launch.id?'Saving…':restore?'Restore':'Archive request','small-button token-archive-button');button.type='button';button.disabled=!!archiveBusy||claimsBusy||redirectBusy;
      button.dataset.archiveFor=launch.id;button.onclick=()=>archiveLaunch(launch.id,!restore);root.append(button);
    }
    root.hidden=!root.childNodes.length;
  }
  function renderArchiveControls(){
    for(const root of document.querySelectorAll('[data-archive-control]')){const launch=launches.find(row=>row.id===root.dataset.archiveControl);if(launch)renderArchiveControl(root,launch);}
    const detail=$('token-archive-detail');if(selected)renderArchiveControl(detail,selected);else detail.hidden=true;
  }
  function renderHistory(launch){
    const root=$('token-launch-history'),rows=Array.isArray(launch.operations)?launch.operations:[];root.replaceChildren(el('summary','Launch history'));
    if(!rows.length){root.append(el('p','No saved transactions yet.','token-archive-note'));return;}
    const list=el('ul');
    for(const operation of rows){
      const item=el('li'),label=String(operation.kind||'Transaction').replaceAll('-',' ');item.append(el('span',label+' · '+String(operation.state||'saved')));
      if(typeof operation.signature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(operation.signature))item.append(link('View transaction ↗','https://solscan.io/tx/'+operation.signature+(['devnet','testnet'].includes(launch.input?.network)?'?cluster='+launch.input.network:''),null,true));
      if(operation.error)item.append(el('p',operation.error,'token-archive-note'));list.append(item);
    }
    root.append(list);
  }
  async function archiveLaunch(id,archived){
    if(disposed||!authenticated||archiveBusy||claimsBusy||redirectBusy||typeof archived!=='boolean')return;
    const current=launches.find(row=>row.id===id);if(!current||legacyLaunch(current)||(archived?!current.canArchive:!current.canRestore||current.hidden))return;
    const generation=sessionGeneration;archiveBusy=id;listRevision++;renderArchiveControls();renderClaims();error();
    try{
      const updated=await api('/api/launchpad/archive',{id,archived});
      if(generation!==sessionGeneration||disposed)return;
      if(updated?.id!==id)throw Error('The archive response could not be read. Refresh to check this launch.');
      acceptLaunch(updated);renderList();
    }catch(e){if(generation===sessionGeneration&&!disposed)error(e.message);}
    finally{if(generation===sessionGeneration){archiveBusy='';listRevision++;if(!disposed){renderArchiveControls();renderClaims();}}}
  }
  function renderClaimControl(root,launch){
    const state=creatorClaimState(launch),item=claimItems.get(launch.id);root.replaceChildren();
    const button=el('button',item?.state==='working'?'Claiming…':state.busy?'Continue claim':'Claim creator fees','small-button token-claim-button');button.type='button';button.disabled=claimsBusy||redirectBusy||!!archiveBusy||!state.available;button.onclick=()=>claimFees(launch.id);
    const note=el('p',item?.text||state.reason||(state.requiresSignature?'Approve with your connected wallet.':'Launchpad processes this claim automatically.'),'token-claim-note'+(item?.state==='error'?' negative':''));note.setAttribute('role','status');root.append(button,note);if(state.available&&mintAddress(state.recipient))root.append(link('Receiving wallet · '+short(state.recipient),'https://solscan.io/account/'+state.recipient,'token-claim-receipt',true));if(state.available&&state.scope==='wallet_quote')root.append(el('small','Includes unclaimed fees from this creator’s other coins paired with '+pairedAsset(launch)+'.','token-claim-scope'));
    for(const signature of item?.signatures||[])if(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature))root.append(link('View confirmed transaction ↗','https://solscan.io/tx/'+signature,'token-claim-receipt',true));
  }
  function renderClaims(){
    const eligible=launches.filter(row=>!legacyLaunch(row)&&launchId(row.id)&&creatorClaimState(row).available);
    $('tokens-claim-all').disabled=claimsBusy||redirectBusy||!!archiveBusy||!eligible.length;$('tokens-claim-all').textContent=claimsBusy?'Claiming creator fees…':'Claim fees from your launches';
    $('tokens-claim-summary').textContent=claimsSummary;$('tokens-claim-summary').hidden=!claimsSummary;
    for(const root of document.querySelectorAll('[data-claim-for]')){const launch=launches.find(row=>row.id===root.dataset.claimFor);if(launch)renderClaimControl(root,launch);}
    const detail=$('token-claim-detail');detail.hidden=!launchHasMarket(selected)||selected.input?.feeMode!=='creator';if(!detail.hidden)renderClaimControl(detail,selected);
  }
  function resetFeeRedirect(){
    redirectDraft=null;redirectBusy=false;$('tokens-fee-redirect-dialog').close();$('tokens-fee-redirect-address').value='';$('tokens-fee-redirect-confirm').checked=false;$('tokens-fee-redirect-status').textContent='';
  }
  function feeRedirectAllowed(launch){return authenticated&&!legacyLaunch(launch)&&launch?.feeRedirect?.allowed===true&&launch.feeRedirect.used!==true&&mintAddress(redirectWallet)&&redirectWallet===launch.feeRedirect.originalWallet;}
  function renderFeeRedirectControl(root,launch){
    root.replaceChildren();root.hidden=!launch?.feeRedirect||launch.input?.feeMode!=='creator';if(root.hidden)return;
    const state=launch.feeRedirect;
    if(mintAddress(state.recipient))root.append(link('Fee recipient · '+short(state.recipient),'https://solscan.io/account/'+state.recipient,'token-claim-receipt',true));
    if(state.used===true){root.append(el('p','Fee recipient locked. This coin’s one-time redirect has been used.','token-claim-note'));return;}
    const allowed=feeRedirectAllowed(launch),button=el('button','Redirect creator fees','small-button');button.type='button';button.dataset.redirectFor=launch.id;button.disabled=!allowed||redirectBusy||claimsBusy||!!archiveBusy;button.onclick=()=>openFeeRedirect(launch.id);
    const reason=state.allowed===true&&!allowed?'Sign in with the original launch wallet to redirect fees.':state.reason||'One recipient change per coin. The original creator keeps this launch on their profile.';
    root.append(button,el('p',reason,'token-claim-note'));
  }
  function renderFeeRedirects(){
    for(const root of document.querySelectorAll('[data-fee-redirect]')){const launch=launches.find(row=>row.id===root.dataset.feeRedirect);if(launch)renderFeeRedirectControl(root,launch);}
    const detail=$('token-fee-redirect-detail');if(selected)renderFeeRedirectControl(detail,selected);else detail.hidden=true;
  }
  function renderFeeRedirectDialog(){
    const draft=redirectDraft;if(!draft)return;const address=$('tokens-fee-redirect-address'),confirm=$('tokens-fee-redirect-confirm'),button=$('tokens-fee-redirect-submit'),locked=!!draft.payload;
    address.disabled=redirectBusy||locked;confirm.disabled=redirectBusy||locked;$('tokens-fee-redirect-close').disabled=redirectBusy;
    const next=address.value.trim();$('tokens-fee-redirect-preview').textContent=validWallet(next)?next:'';button.disabled=redirectBusy||!confirm.checked||!validWallet(next)||next===draft.expectedRecipient;button.textContent=redirectBusy?'Saving fee recipient…':locked?'Check saved redirect':'Confirm one-time redirect';
  }
  function openFeeRedirect(id){
    const launch=launches.find(row=>row.id===id);if(disposed||redirectBusy||claimsBusy||archiveBusy||!feeRedirectAllowed(launch))return;
    if(redirectDraft?.payload){$('tokens-fee-redirect-dialog').showModal();return;}
    redirectDraft={id,expectedRecipient:launch.feeRedirect.recipient,originalWallet:launch.feeRedirect.originalWallet};
    $('tokens-fee-redirect-title').textContent='Redirect '+(launch.input?.symbol||'coin')+' creator fees';$('tokens-fee-redirect-current').textContent=launch.feeRedirect.recipient;
    $('tokens-fee-redirect-address').value='';$('tokens-fee-redirect-confirm').checked=false;$('tokens-fee-redirect-status').textContent='';renderFeeRedirectDialog();$('tokens-fee-redirect-dialog').showModal();$('tokens-fee-redirect-address').focus();
  }
  async function redirectCreatorFees(event){
    event?.preventDefault();const draft=redirectDraft,launch=launches.find(row=>row.id===draft?.id);if(disposed||redirectBusy||claimsBusy||archiveBusy||!draft||!feeRedirectAllowed(launch))return;
    const recipient=$('tokens-fee-redirect-address').value.trim();if(!$('tokens-fee-redirect-confirm').checked||!validWallet(recipient)||recipient===draft.expectedRecipient)return;
    draft.payload||={id:draft.id,recipient,expectedRecipient:draft.expectedRecipient,requestId:globalThis.crypto.randomUUID()};
    const generation=sessionGeneration;redirectBusy=true;listRevision++;renderFeeRedirectDialog();renderFeeRedirects();renderClaims();renderArchiveControls();$('tokens-fee-redirect-status').textContent='Saving the one-time fee recipient change…';
    try{
      const result=await api('/api/launchpad/fee-assignments/redirect',draft.payload);if(disposed||generation!==sessionGeneration||redirectDraft!==draft)return;
      const updated=result.launch||result;if(updated.id!==draft.id||updated.feeRedirect?.used!==true||updated.feeRedirect?.recipient!==draft.payload.recipient)throw Error('The saved recipient could not be verified. Check this same request before making another change.');
      redirectBusy=false;resetFeeRedirect();acceptLaunch(updated);renderFeeRedirects();error();
    }catch(e){
      if(disposed||generation!==sessionGeneration||redirectDraft!==draft)return;
      if(e.statusCode>=400&&e.statusCode<500){draft.payload=null;$('tokens-fee-redirect-status').textContent=e.message;}else $('tokens-fee-redirect-status').textContent='The result could not be confirmed. Check saved redirect to retry this exact request safely.';
    }finally{if(generation===sessionGeneration&&!disposed){redirectBusy=false;listRevision++;renderFeeRedirectDialog();renderFeeRedirects();renderClaims();renderArchiveControls();}}
  }
  $('tokens-fee-redirect-form').onsubmit=redirectCreatorFees;
  $('tokens-fee-redirect-address').oninput=renderFeeRedirectDialog;$('tokens-fee-redirect-confirm').onchange=renderFeeRedirectDialog;
  $('tokens-fee-redirect-close').onclick=()=>{if(!redirectBusy){$('tokens-fee-redirect-dialog').close();if(!redirectDraft?.payload)resetFeeRedirect();}};
  $('tokens-fee-redirect-dialog').addEventListener('cancel',event=>{event.preventDefault();$('tokens-fee-redirect-close').onclick();});
  function acceptLaunch(launch){
    const index=launches.findIndex(row=>row.id===launch.id);if(index>=0)launches[index]=launch;
    if(selected?.id===launch.id){selected=launch;renderLaunch();}else renderList();
  }
  function closeWallets(){
    $('tokens-wallet-dialog').close();const reject=walletReject;walletResolve=null;walletReject=null;expectedWallet='';reject?.(Object.assign(Error('Wallet connection cancelled. Submitted claims can still confirm.'),{cancelled:true}));
  }
  function renderWallets(){
    if(!wallet)return;const state=wallet.state(),root=$('tokens-wallet-options');root.replaceChildren();
    $('tokens-wallet-help').textContent=(expectedWallet?`Use the wallet that receives these creator fees: ${short(expectedWallet)}. `:'')+(state.wallets.length?'Choose your Solana wallet.':'Open Launchpad in your wallet browser or install a Solana wallet extension.');
    for(const option of state.wallets){const button=el('button',option.name,'small-button');button.type='button';button.onclick=async()=>{
      button.disabled=true;$('tokens-wallet-error').hidden=true;
      try{const next=await wallet.connect(option.id);if(next.address!==expectedWallet)throw Error('This account does not receive these fees. Switch to '+short(expectedWallet)+' in your wallet and connect again.');const resolve=walletResolve;walletResolve=null;walletReject=null;expectedWallet='';$('tokens-wallet-dialog').close();resolve?.();}
      catch(e){$('tokens-wallet-error').textContent=e.message;$('tokens-wallet-error').hidden=false;}finally{button.disabled=false;}
    };root.append(button);}
  }
  async function ensureWallet(address){
    if(!wallet){wallet=walletFactory({window});walletUnsubscribe=wallet.onChange(()=>renderWallets());}
    if(wallet.state().address===address)return;
    expectedWallet=address;renderWallets();$('tokens-wallet-error').hidden=true;
    const pending=new Promise((resolve,reject)=>{walletResolve=resolve;walletReject=reject;});$('tokens-wallet-dialog').showModal();await pending;
    if(wallet.state().address!==address)throw Error('The connected fee wallet changed. Reconnect before claiming.');
  }
  async function claimFees(id){
    const sessionVersion=sessionGeneration;const checkAccount=()=>{if(disposed||!authenticated||sessionVersion!==sessionGeneration)throw Object.assign(Error('Claim monitoring stopped because your account changed.'),{cancelled:true});};
    if(disposed||!authenticated||claimsBusy||archiveBusy||redirectBusy)return;const initial=id?launches.filter(row=>row.id===id):launches.filter(row=>!legacyLaunch(row)&&creatorClaimState(row).available);
    if(!initial.length||initial.some(row=>legacyLaunch(row)||!creatorClaimState(row).available))return;
    claimsBusy=true;claimsSummary='Preparing creator fee claims…';renderClaims();renderArchiveControls();let completed=0,failed=0,queued=[];
    try{
      if(id){const baseline=initial[0],state=creatorClaimState(baseline);if(state.requiresSignature)await ensureWallet(state.wallet);checkAccount();
        const launch=await api('/api/launchpad/action',{id,action:'fees'});queued=[{launch,baseline}];acceptLaunch(launch);
      }else{
        const response=await api('/api/launchpad/fees/claim-all',{}),ids=new Set([...(response.queued||[]),...(response.active||[])]);
        if(!Array.isArray(response.launches))throw Error('The claim response could not be read. Refresh to check saved claims.');
        launches=response.launches;queued=launches.filter(row=>ids.has(row.id)).map(launch=>({launch,baseline:initial.find(row=>row.id===launch.id)||launch}));renderList();
        if(!queued.length)claimsSummary='No creator fee claims are ready.';
      }
      for(const [index,{launch,baseline}] of queued.entries()){
        if(disposed||!authenticated||sessionVersion!==sessionGeneration)break;claimsSummary=`Claiming ${index+1} of ${queued.length} · ${launch.input?.symbol||'token'}`;
        const progress=text=>{if(sessionVersion!==sessionGeneration)return;claimItems.set(launch.id,{state:'working',text});renderClaims();};progress('Checking creator fees…');
        try{
          const result=await runCreatorClaim({launch,baseline,request:(path,body)=>{checkAccount();return api('/api/launchpad'+path,body);},wait:claimWait,check:checkAccount,onUpdate:launch=>{checkAccount();acceptLaunch(launch);},onProgress:progress,sign:async pending=>{checkAccount();await ensureWallet(pending.wallet);checkAccount();try{const signed=await wallet.sign(pending);checkAccount();return signed;}catch(e){if(e.code===4001||/reject|cancel|denied/i.test(e.message))e.cancelled=true;throw e;}}});
          checkAccount();completed++;claimItems.set(launch.id,{state:'complete',text:result.launch.lastFeeClaim?.result==='empty'?'No unclaimed creator fees.':'Claim complete.',signatures:result.receipts.map(op=>op.signature)});
        }catch(e){if(sessionVersion!==sessionGeneration)return;failed++;claimItems.set(launch.id,{state:'error',text:e.message});if(e.cancelled){claimsSummary='Approvals stopped. Submitted claims can still confirm.';break;}}
        renderClaims();
      }
      if(queued.length&&completed+failed===queued.length)claimsSummary=`${completed} claim${completed===1?'':'s'} complete${failed?` · ${failed} need${failed===1?'s':''} attention`:''}.`;
      // A clean sweep earns a little confetti (the shared motion layer listens; decorative only).
      if(completed&&!failed&&!disposed){const View=document.defaultView||window;if(typeof View?.CustomEvent==='function')document.dispatchEvent(new View.CustomEvent('curve-celebrate'));}
    }catch(e){if(sessionVersion!==sessionGeneration)return;claimsSummary=e.message;if(id)claimItems.set(id,{state:'error',text:e.message});}
    finally{if(sessionVersion===sessionGeneration){claimsBusy=false;if(!disposed){renderClaims();renderArchiveControls();}}}
  }
  const rewardDate=value=>{const at=Number(value);return at>0&&Number.isFinite(at)?new Date(at).toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';};
  // A Gotchi launch has no holder distribution (its fees fill the Gotchi's prize pot), even though it is saved in holders mode.
  const holderRewardsLaunch=launch=>launch?.input?.feeMode==='holders'&&!launch.gotchi&&launchHasMarket(launch);
  function renderRewards(){
    const visible=holderRewardsLaunch(selected);$('token-rewards').hidden=!visible;if(!visible)return;
    const data=rewardsData,schedule=selected.holderRewards||data?.schedule,symbol=schedule?.quoteSymbol||data?.wallet?.quoteSymbol||pairedAsset(selected),processing=!!selected.cycle||!!selected.feesRequested;
    $('token-rewards-total').textContent=quoteValue(schedule?.totalDistributedQuote??data?.totals?.distributedQuote,symbol);
    const payments=schedule?.totalPayments??data?.totals?.payments;$('token-rewards-payments').textContent=payments!=null?`${count(payments)} confirmed holder payments`:'Confirmed payment history';
    $('token-rewards-curve-fees').textContent=quoteValue(data?.unclaimedCreatorQuote,symbol);$('token-rewards-curve-fees-note').textContent=[data?.stale?'Last observed LaunchLab curve fees.':'LaunchLab curve fees only.','Post-graduation pool fees are not included.',data?.unclaimedCreatorShared?'This wallet and paired asset can share a fee vault with other launches.':''].filter(Boolean).join(' ');
    $('token-rewards-collected').textContent=quoteValue(schedule?.pendingQuote??data?.earned?.quote,symbol);
    const taxBurn=schedule?.taxBurn?.selected===true?schedule.taxBurn:null;
    $('token-rewards-unconverted').textContent=quoteValue(taxBurn?taxBurn.pendingTaxTokens:schedule?.unconvertedTaxTokens??data?.earned?.unconvertedTaxTokens,selected.input.symbol);
    $('token-rewards-unconverted').parentElement.querySelector('span').textContent=taxBurn?'Collected tax awaiting burn':'Awaiting conversion';
    const conversion=schedule?.taxConversion,nextConversion=conversion?.nextAt??conversion?.nextCheckAt,impact=conversion?.maxPriceImpactBps!=null?Number(conversion.maxPriceImpactBps)/100:conversion?.maximumPriceImpactPercent;
    const cap=conversion?.maxTokens!=null?`Up to ${quoteValue(conversion.maxTokens,selected.input.symbol)} per sale.`:conversion?.maximumSupplyPercent!=null?`Up to ${conversion.maximumSupplyPercent}% of supply per sale.`:'';
    $('token-rewards-conversion-note').textContent=taxBurn?[`Collected ${selected.input.symbol} transfer tax is burned directly.`,taxBurn.tokensBurned!=null?`${quoteValue(taxBurn.tokensBurned,selected.input.symbol)} burned directly in ${count(taxBurn.completedBurns)} confirmed burns.`:'Tax-burn amounts are unavailable.',taxBurn.initialInventory?.status==='authorized'?`${quoteValue(taxBurn.initialInventory.approvedTokens,selected.input.symbol)} initial inventory approved for one burn, including the collected tax shown here.`:Number(taxBurn.unattributedTokens)>0?`${quoteValue(taxBurn.unattributedTokens,selected.input.symbol)} other token credit remains reserved.`:'','Separately accrued creator-fee SOL still funds holder rewards; existing owed SOL remains payable.'].filter(Boolean).join(' '):[`Normal automatic sales run at least ${conversion?.intervalMinutes||5} minutes apart.`,cap,impact!=null?`Normal-sale estimated price impact capped at ${impact}%.`:'',`At ${quoteValue(conversion?.backlogThresholdTokens||'10000000',selected.input.symbol)} or more awaiting conversion, automatic processing sells exact ${quoteValue(conversion?.backlogSellTokens||'10000000',selected.input.symbol)} batches without that wait, subject to a ${conversion?.backlogMaximumPriceImpactPercent??5}% estimated price-impact limit.`, 'Admin sell-and-distribute requests skip the automatic wait and payout minimum. Liquidity and account checks still apply.'].filter(Boolean).join(' ');
    const conversionNext=$('token-rewards-conversion-next');conversionNext.hidden=!(taxBurn||Number(selected.input.taxBps)>0||Number(schedule?.unconvertedTaxTokens??data?.earned?.unconvertedTaxTokens)>0);conversionNext.textContent=taxBurn?taxBurn.enabled&&!taxBurn.paused&&selected.autoFees?taxBurn.manual===true?'Collected tax is kept in the rewards wallet until the team burns it; it is never sold.':'Collected tax burns automatically after collection confirms.':'Tax burns are paused; collected tax stays reserved and is not sold.':!selected.autoFees?'Automatic tax conversions paused.':conversion?.backlogActive?'A 10,000,000-token backlog sale is eligible when a route meets its liquidity and price-impact limits.':nextConversion?'Next conversion eligible · '+rewardDate(nextConversion):'Normal tax conversions wait for their schedule and a route within the sale limits.';
    if(taxBurn&&typeof taxBurn.lastBurnSignature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(taxBurn.lastBurnSignature)){const link=document.createElement('a');link.textContent=' Latest tax burn ↗';link.href='https://solscan.io/tx/'+taxBurn.lastBurnSignature;link.target='_blank';link.rel='noopener noreferrer';conversionNext.append(link);}
    $('token-rewards-withheld').textContent=quoteValue(data?.taxes?.withheldTokens,selected.input.symbol);$('token-rewards-withheld-note').textContent=[data?.taxes?.stale?'Last observed amount':data?.taxes?.withheldTokens!=null?'Observed across token accounts':'Amount not available',data?.taxes?.asOf?'Checked '+rewardDate(data.taxes.asOf):'',data?.taxes?.error,data?.taxes?.claimableNow===true?'Ready to collect':data?.taxes?.claimableNow===false?'Waiting for withdrawal authority':'Withdrawal availability not verified'].filter(Boolean).join(' · ');
    $('token-rewards-balance').textContent=quoteValue(data?.wallet?.quoteBalance,symbol);
    const separateRewards=data?.wallet?.role==='reward_conversion';$('token-rewards-wallet-label').textContent=separateRewards?taxBurn?'Tax burn and payout wallet balance':'Reward conversion wallet balance':'Distribution wallet balance';$('token-rewards-wallet-note').textContent=separateRewards?taxBurn?'Launchpad-managed collected-tax burns and SOL payouts. The separately approved initial inventory is burned once; later deposits are not automatically treated as tax.':'Launchpad-managed conversions and payouts. Creator fee collection keeps its original wallet; only confirmed earned credits are forwarded.':'May include deposits; only earned rewards are distributed.';
    const walletAddress=data?.wallet?.address,anchor=$('token-rewards-wallet');anchor.hidden=!mintAddress(walletAddress);if(!anchor.hidden){anchor.textContent=short(walletAddress)+' ↗';anchor.href='https://solscan.io/account/'+walletAddress;}
    const paycheck=schedule?.paycheck||null;
    // A Paycheck launch has no transfer tax: its conversion and withheld-tax rows do not apply, and the title names the mode.
    $('token-rewards-title').textContent=paycheck?'Paycheck':'Holder rewards';$('token-rewards-total').parentElement.querySelector('span').textContent=paycheck?'Total paid out (holders, creator, Launchpad, burn)':'Total distributed';
    $('token-rewards-unconverted').parentElement.hidden=!!paycheck;$('token-rewards-withheld').parentElement.hidden=!!paycheck;if(paycheck)conversionNext.hidden=true;
    $('token-rewards-collected').parentElement.querySelector('span').textContent=paycheck?'Accruing to holders':'Collected awaiting payout';$('token-rewards-collected').parentElement.querySelector('small').textContent=paycheck?'Pending shares below the $0.50 payout line':'Earned rewards ready for distribution';
    if(paycheck)$('token-rewards-collected').textContent=quoteValue(paycheck.accruing,symbol);
    $('token-rewards-schedule').textContent=selected.autoFees?(paycheck?'Every 15 minutes':'Every hour'):'Automatic payouts paused';
    const lastAt=schedule?.lastDistributionAt??data?.totals?.lastDistributionAt,lastQuote=schedule?.lastDistributionQuote??data?.totals?.lastDistributionQuote;
    $('token-rewards-last').textContent=lastAt?`${selected.cycle?'Latest confirmed payout':'Last distribution'} · ${quoteValue(lastQuote,symbol)} · ${rewardDate(lastAt)}`:'No confirmed distribution recorded yet.';
    $('token-rewards-next').textContent=[paycheck?'Paycheck · holders 50% · $LAUNCHPAD buy-and-burn 35% · Launchpad 10% · creator 5% · $0.50 per wallet, sellers forfeit':'Hourly minimum · $100',processing?'A reward check is in progress.':selected.autoFees&&schedule?.nextCheckAt?'Next check · '+rewardDate(schedule.nextCheckAt):''].filter(Boolean).join(' · ');
    $('token-rewards-data-note').textContent=[rewardsError||data?.error,schedule?.thresholdNote,data?.asOf?`${data.stale?'Last confirmed wallet balance':'Wallet balance checked'} · ${rewardDate(data.asOf)}`:rewardsBusy?'Reading the distribution wallet…':'',data?.taxes?.note].filter(Boolean).join(' ');
    $('token-rewards-refresh').disabled=rewardsBusy;
  }
  async function refreshRewards(force=false){
    const sessionVersion=sessionGeneration;
    if(sessionVersion!==sessionGeneration||disposed||!authenticated||!holderRewardsLaunch(selected)||rewardsBusy||clock()<rewardsRetry||(!force&&(document.hidden||clock()<rewardsNext)))return;
    const id=selected.id,mint=selected.mint;rewardsBusy=true;rewardsNext=clock()+30000;renderRewards();
    try{const data=await api('/api/launchpad/rewards?id='+encodeURIComponent(id));if(sessionVersion!==sessionGeneration||disposed||selected?.id!==id)return;if(data.launchId!==id||data.mint!==mint)throw Error('The rewards response does not match this token.');rewardsData=data;rewardsError='';if(data.schedule)selected={...selected,holderRewards:data.schedule};rewardsNext=clock()+Math.max(30000,Number(data.refreshMs)||30000);if(data.stale)rewardsRetry=rewardsNext;}
    catch(e){if(sessionVersion!==sessionGeneration||disposed||selected?.id!==id)return;rewardsError=e.message;rewardsRetry=clock()+Math.max(30000,Number(e.retryAfterMs)||30000);}
    finally{if(sessionVersion===sessionGeneration)rewardsBusy=false;if(sessionVersion===sessionGeneration&&!disposed)renderRewards();}
  }
  function renderBuyback(){
    const visible=selected?.input?.feeMode==='buyback'&&launchHasMarket(selected),key=visible?selected.id+':'+selected.mint:'';
    if(key!==buybackKey){buybackKey=key;buybackEpoch++;buybackController?.abort();buybackController=null;buybackData=null;buybackBusy=false;buybackNext=0;buybackRetry=0;buybackError='';}
    $('token-buyback').hidden=!visible;
    if(!visible)return null;
    const coin={mint:selected.mint,symbol:selected.input.symbol,feeMode:'buyback',quote:{mint:selected.input.quoteMint,symbol:pairedAsset(selected)},taxBps:selected.input.taxBps};
    buybackView.render({coin,data:buybackData,busy:buybackBusy,error:buybackError});return coin;
  }
  async function refreshBuyback(force=false){
    if(disposed||!authenticated)return;const coin=renderBuyback();
    if(!coin||buybackBusy||document.hidden||clock()<buybackRetry||(!force&&clock()<buybackNext))return;
    const generation=buybackEpoch,key=buybackKey,controller=new AbortController();buybackController=controller;controllers.add(controller);
    const timeout=window.setTimeout(()=>controller.abort(),15000);buybackBusy=true;buybackNext=clock()+30000;renderBuyback();
    try{
      const response=await fetcher('/api/explore/rewards?mint='+encodeURIComponent(coin.mint),{method:'GET',credentials:'omit',headers:{accept:'application/json'},signal:controller.signal});
      const data=await response.json();if(disposed||!authenticated||generation!==buybackEpoch||key!==buybackKey)return;
      if(!response.ok)throw Object.assign(Error(data?.error||'Buyback information is temporarily unavailable.'),{retryAfterMs:data?.retryAfterMs});
      if(!validCoinRewards(data,coin))throw Error('The buyback response does not match this token.');
      buybackData=data;buybackError='';buybackNext=clock()+Math.max(30000,Math.min(300000,Number(data.refreshMs)||30000));buybackRetry=data.stale?buybackNext:0;
    }catch(e){if(disposed||generation!==buybackEpoch||key!==buybackKey)return;buybackError=e.name==='AbortError'?'Buyback information is taking longer than expected. It will retry automatically.':e.message;buybackNext=clock()+Math.max(30000,Math.min(300000,Number(e.retryAfterMs)||30000));buybackRetry=buybackNext;}
    finally{window.clearTimeout(timeout);controllers.delete(controller);if(generation===buybackEpoch){buybackController=null;buybackBusy=false;if(!disposed)renderBuyback();}}
  }
  function empty(root,title,message,action,peek){const box=el('div',null,'tokens-empty');clearGotchis(root);box.append(el('h2',title),el('p',message));if(peek&&GOTCHI_PEEK[peek])box.append(el('p',GOTCHI_PEEK[peek][1],'tokens-empty-hint'));if(action)box.append(link(action.text,action.href,'small-button'));if(peek&&GOTCHI_PEEK[peek])peekGotchi(box,GOTCHI_PEEK[peek][0]);root.replaceChildren(box);}
  function renderList(){
    const valid=launches.filter(row=>launchId(row.id));
    for(const key of ['launched','drafts','archived'])$('tokens-count-'+key).textContent=String(valid.filter(row=>category(row)===key).length);
    const claimHint=$('tokens-claim-hint');if(claimHint)claimHint.hidden=filter!=='launched';
    const version=JSON.stringify([filter,valid]);if(version===listVersion){renderClaims();renderFeeRedirects();return;}listVersion=version;
    for(const button of document.querySelectorAll('[data-launch-filter]'))button.setAttribute('aria-pressed',String(button.dataset.launchFilter===filter));paintFilters();
    const root=$('tokens-list'),rows=valid.filter(row=>category(row)===filter).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));root.replaceChildren();
    if(!rows.length){renderClaims();const copy=filter==='launched'?['Your first token starts here.','Tokens appear here once their creation is confirmed onchain.',{text:'Launch a coin →',href:'/launchpad'}]:filter==='drafts'?['No saved drafts.','Unfinished and failed launches appear here with their saved details.',null]:['No archived tokens.','Archived requests and hidden coins appear here with their saved details.',null];empty(root,...copy,filter);return;}
    for(const launch of rows){
      const card=el('article',null,'token-launch-card');card.dataset.launchId=launch.id;
      const top=el('div',null,'token-launch-card-top'),identity=el('div',null,'token-card-identity');identity.append(el('h2',launch.input?.name||'Unnamed token'),el('p','$'+(launch.input?.symbol||'TOKEN')));top.append(avatar(launch),identity,status(launch));
      const meta=el('div',null,'token-card-meta');for(const [label,value] of [['Paired with',pairedAsset(launch)],['Creator fees',modes[launchMode(launch)]||'—'],['Starting valuation',money(launch.review?.actualUsd??launch.input?.targetUsd)],['Created',date(launch.createdAt)]]){const cell=el('div'),detail=el('strong',value);if(label==='Paired with')detail.replaceChildren(createQuoteLabel(document,{mint:launch.input?.quoteMint,symbol:value}));cell.append(el('span',label),detail);meta.append(cell);}
      const bottom=el('div',null,'token-card-bottom');bottom.append(el('span',launchIsOnchain(launch)?short(launch.mint):'Not launched onchain'),link(category(launch)==='archived'?'View details →':launchIsOnchain(launch)?'View market →':'View draft →',`/launched-tokens?id=${encodeURIComponent(launch.id)}`,'token-card-link'));card.append(top,meta);
      // Claim, archive and redirect controls share one actions group, so their buttons sit in a row with the notes below.
      const actions=el('div',null,'token-card-actions');
      if(launchHasMarket(launch)){const claim=el('div',null,'token-card-claim');claim.dataset.claimFor=launch.id;actions.append(claim);if(!launch.curve&&(launch.error||launch.recovery?.reason))actions.append(el('p',launch.error||launch.recovery.reason,'token-draft-note'));}else{const note=launch.recovery?.notice||launch.error||(legacyLaunch(launch)?'Saved launch details.':launch.state==='draft'?'Saved and ready to review.':'This launch is unfinished. Your details are saved.');actions.append(el('p',note,'token-draft-note'));if(launch.recovery){const recovery=el('p',recoveryText(launch.recovery),'token-recovery-note');actions.append(recovery);}}
      if(!legacyLaunch(launch)&&!launchIsOnchain(launch)&&launch.canReuseDraft)bottom.append(link('Edit and try again',`/launchpad?reuse=${encodeURIComponent(launch.id)}`,'token-card-link'));
      const archive=el('div',null,'token-archive-control');archive.dataset.archiveControl=launch.id;renderArchiveControl(archive,launch);actions.append(archive);
      const redirect=el('div',null,'token-fee-redirect');redirect.dataset.feeRedirect=launch.id;renderFeeRedirectControl(redirect,launch);actions.append(redirect);card.append(actions,bottom);root.append(card);
    }
    renderClaims();
  }
  function renderLaunch(){
    if(!selected)return;const version=JSON.stringify(selected);if(version===detailVersion){renderClaims();renderFeeRedirects();renderRewards();renderBuyback();return;}detailVersion=version;
    const onchain=launchIsOnchain(selected),legacy=legacyLaunch(selected);document.title=`${selected.input?.symbol||'Token'} — Launchpad`;
    const archived=category(selected)==='archived';$('token-back').href=archived?'/launched-tokens?view=archived':'/launched-tokens';$('token-back').textContent=archived?'← Archived tokens':'← Your launches';$('token-network').textContent='● Solana '+(mainnetLaunch(selected)?'mainnet':selected.input.network);
    $('token-name').textContent=selected.input?.name||'Unnamed token';$('token-symbol').textContent='$'+(selected.input?.symbol||'TOKEN');avatar(selected,$('token-avatar'));
    const state=launchStatus(selected);$('token-launch-state').textContent=state.label;$('token-launch-state').className=`token-status ${state.tone}`.trim();$('token-launch-state').dataset.status=statusSlug(state.label);
    $('token-manage').href=`/launchpad?id=${encodeURIComponent(selected.id)}`;$('token-manage').textContent=legacy?'View launch history':selected.curve?'Manage rewards':'Manage launch';
    $('token-address').textContent=onchain?short(selected.mint):'Token creation not confirmed';$('token-address').title=onchain?selected.mint:'';
    if(onchain)$('token-address').href=`https://solscan.io/token/${selected.mint}${['devnet','testnet'].includes(selected.input?.network)?'?cluster='+selected.input.network:''}`;else $('token-address').removeAttribute('href');$('token-copy').hidden=!onchain;
    tradeView.setCoin(onchain&&!legacy?{mint:selected.mint,symbol:selected.input?.symbol,quote:{mint:selected.input?.quoteMint,symbol:pairedAsset(selected)}}:null);
    const notice=legacy?'Earlier '+(selected.input?.network||'mainnet-beta')+' launch record. Saved details remain available.':!onchain?(selected.state==='draft'?'This is a saved draft. Review and launch it from the launchpad.':selected.error||'Token creation has not been confirmed. Continue this launch from the launchpad.'):
      !selected.curve?'Token creation is confirmed. '+(selected.error||selected.recovery?.reason?(selected.error||selected.recovery.reason)+(selected.retry?' Launchpad is retrying verification automatically.':''):'Launchpad is verifying the launch curve.') :selected.error?'The token is onchain. '+selected.error:'';
    $('token-launch-note').textContent=notice;$('token-launch-note').hidden=!notice;
    const details=$('token-details');details.replaceChildren();
    const facts=[['Network',selected.input?.network||'mainnet-beta'],['Paired with',pairedAsset(selected)],['Creator fees',modes[launchMode(selected)]||'—'],...(selected.gotchi?[['Gotchi',selected.gotchi.theme+' · '+selected.gotchi.vault.slice(0,4)+'…'+selected.gotchi.vault.slice(-4)]]:[]),...(selected.agent?[['AI agent',selected.agent.model+' · wallet '+selected.agent.wallet.slice(0,4)+'…'+selected.agent.wallet.slice(-4)]]:[]),['Starting valuation',money(selected.review?.actualUsd??selected.input?.targetUsd)],['Transfer tax',numeric(selected.input?.taxBps)===null?'—':Number(selected.input.taxBps)/100+'%'],['Launch date',date(selected.createdAt)]];
    if(selected.input?.feeMode==='holders'&&!selected.gotchi&&selected.holderRewards){const rewards=selected.holderRewards,symbol=rewards.quoteSymbol||pairedAsset(selected),paycheck=rewards.paycheck;facts.push([paycheck?'Paycheck':'Holder rewards',paycheck?`${selected.autoFees?'Every 15 minutes':'Paused'} · $0.50 per wallet`:`${selected.autoFees?'Hourly':'Paused'} · minimum $100`],[paycheck?'Accruing to holders':'Collected rewards',paycheck?`${paycheck.accruing??'0'} ${symbol} · ${paycheck.accruingWallets??0} wallets`:`${rewards.pendingQuote??'0'} ${symbol}`]);if(paycheck)facts.push(['Paid to holders',`${paycheck.paidToHolders??'0'} ${symbol}`],['Forfeited by sellers',`${paycheck.forfeited??'0'} ${symbol}`]);if(selected.autoFees&&rewards.nextCheckAt&&!selected.cycle&&!selected.feesRequested)facts.push(['Next reward check',new Date(rewards.nextCheckAt).toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})]);}
    for(const [label,value] of facts){const row=el('div'),detail=el('dd',value);if(label==='Paired with')detail.replaceChildren(createQuoteLabel(document,{mint:selected.input?.quoteMint,symbol:value}));row.append(el('dt',label),detail);details.append(row);}
    if(typeof selected.gotchi?.id==='string'&&selected.gotchi.id){const row=el('div'),value=el('dd');value.append(link('Open the Gotchi race →','/gotchi?id='+encodeURIComponent(selected.gotchi.id)));row.append(el('dt','Prize pot'),value);details.append(row);}
    if(!legacy&&mintAddress(selected.curve)){const row=el('div'),value=el('dd');value.append(link(short(selected.curve),`https://solscan.io/account/${selected.curve}`,null,true));row.append(el('dt','Launch curve'),value);details.append(row);}
    const description=selected.input?.description||'';$('token-description').textContent=description;$('token-description').hidden=!description;$('token-description-section').hidden=!description;
    const socials=$('token-socials');socials.replaceChildren();for(const [field,label] of [['website','Website ↗'],['twitter','X ↗'],['telegram','Telegram ↗']]){const url=safeUrl(selected.input?.[field]);if(url)socials.append(link(label,url,null,true));}
    renderClaims();renderFeeRedirects();renderRewards();renderBuyback();renderArchiveControls();renderHistory(selected);
    if(legacy){showChartEmpty('Saved launch record','Market feeds are unavailable for earlier launch formats and test networks.');renderActivity();}else if(!onchain){showChartEmpty('Not onchain yet','Once your launch is confirmed, its chart and market activity will appear here.');renderActivity();}
  }
  function removeCurveChart(){curveChartGeneration++;curveChart?.remove();curveChart=null;curveLoading=false;curveRenderedVersion='';curveRenderRetry=0;}
  function curveChartFailed(){removeCurveChart();curveRenderRetry=clock()+5000;const plot=$('token-curve-plot');if(plot)plot.textContent='The chart is reconnecting. The confirmed price remains in Market overview.';}
  function showChartEmpty(title,message){const key='empty:'+title+message;if(chartKey===key)return;removeCurveChart();chartKey=key;const root=$('token-chart'),box=el('div',null,'token-chart-empty');box.append(el('span','⌁','token-chart-symbol'),el('h3',title),el('p',message));root.replaceChildren(box);}
  function nativeChartOptions(){return {mode:curveMode,supply:curveData.supply,candles:curveData.candles||[]};}
  function updateNativeChart(){
    if(!curveChart||!showingCurve())return;
    const version=JSON.stringify([curveData.points,curveData.candles,curveMode,curveData.supply]);
    if(version===curveRenderedVersion)return;try{curveChart.set(curveData.points,nativeChartOptions());curveRenderedVersion=version;}catch{curveChartFailed();}
  }
  function renderCurveChart(){
    const key='curve:'+selected.id;
    if(chartKey!==key){
      removeCurveChart();chartKey=key;const root=$('token-chart'),body=el('div',null,'token-curve-body'),plot=el('div',null,'token-curve-plot');plot.id='token-curve-plot';
      const caption=el('div',null,'token-curve-caption');caption.id='token-curve-caption';body.append(caption,plot);root.replaceChildren(body);
    }
    const hasCandles=Array.isArray(curveData.candles)&&curveData.candles.length>0,points=curveData.points||[];
    $('token-curve-caption').textContent=(curveData.status!=='curve'?'Historical curve · '+curveData.quote.symbol:hasCandles?'Raydium trading history · '+curveData.quote.symbol:points.length<2?'First confirmed curve price · history builds as Launchpad observes this market.':'Launchpad prices observed by Launchpad · '+curveData.quote.symbol)+(curveMode==='fdv'?' · FDV uses the current supply.':'');
    updateNativeChart();
    if(!curveChart&&!curveLoading&&clock()>=curveRenderRetry){
      curveLoading=true;const generation=curveChartGeneration,plot=$('token-curve-plot');plot.replaceChildren();
      Promise.resolve().then(()=>chartFactory(plot)).then(chart=>{
        if(disposed||generation!==curveChartGeneration){chart?.remove();return;}curveChart=chart;curveLoading=false;updateNativeChart();
      }).catch(()=>{if(disposed||generation!==curveChartGeneration)return;curveChartFailed();});
    }
  }
  function renderMarket(){
    const native=showingCurve(),quote=curveData?.quote?.symbol||pairedAsset(selected),delayed=curveError||curveData?.stale;
    const nativeUsdOK=native&&curveData.status==='curve'&&curveData.quote?.stale===false;
    const metricsPair=!native||!marketError&&!marketData?.stale&&pair?.stale!==true?pair:null,poolBase=metricsPair?.base?.address===selected?.mint;
    const nativeFdv=numeric(nativeUsdOK?curveData.fdvUsd:null),fdv=nativeFdv??numeric(poolBase?metricsPair.fdvUsd:null),cap=native?null:numeric(poolBase?metricsPair.marketCapUsd:null);
    const priceUsd=numeric(nativeUsdOK?curveData.priceUsd:null)??numeric(metricsPair?.priceUsd),priceQuote=numeric(native&&curveData.status==='curve'?curveData.priceQuote:null);
    $('token-chart-controls').hidden=!native;
    $('token-chart-source').textContent=native?curveData.status==='curve'?'Raydium onchain':'Historical curve':pair?'DEX Screener':curveLoading||curveBusy?'Reading launch curve':'Raydium';
    $('token-market-cap-label').textContent=cap!==null?'Market cap':'Fully diluted value';
    $('token-price-label').textContent='Price · USD';
    $('token-market-cap').textContent=money(cap??fdv);
    $('token-market-reference').textContent=[cap===null&&fdv===null?'USD pricing unavailable':nativeFdv!==null?'Raydium onchain':'DEX Screener',native?delayed?'Data delayed':'':marketError||marketData?.stale?'Data delayed':''].filter(Boolean).join(' · ');
    $('token-price').textContent=money(priceUsd);
    $('token-price-usd').hidden=priceQuote===null;$('token-price-usd').textContent=priceQuote!==null?quoteValue(priceQuote,quote)+' per token':'';
    const delta=pair?.priceChange?.h24,change=$('token-price-change');change.textContent=native?(delayed?'Data delayed':'Onchain'):(delta!=null&&Number.isFinite(Number(delta))?`${Number(delta)>0?'+':''}${Number(delta).toLocaleString(undefined,{maximumFractionDigits:2})}% · 24h`:'24h change —');change.className='token-change'+(!native&&Number(delta)>0?' positive':!native&&Number(delta)<0?' negative':'');
    const volFull=curveData?.volume24h!=null||curveData?.volume24hQuote!=null,volUsd=volFull?curveData?.volume24h:curveData?.volumeObserved,volQuote=volFull?curveData?.volume24hQuote:curveData?.volumeObservedQuote,volumeText=volUsd!=null?(curveData.volumeUsdEstimate?'≈':'')+money(volUsd):quoteValue(volQuote,quote);
    const rows=native?[[volFull||volUsd==null&&volQuote==null?'24h volume':'Observed volume',volumeText],['24h buys',count(curveData.buys24h)],['24h sells',count(curveData.sells24h)],['Quote asset',quote],['Token supply',count(curveData.supply)],['FDV',money(fdv)],['Market',curveData.status==='curve'?'Bonding curve':curveData.status==='migrating'?'Graduating':'Graduated']]:[['Liquidity',money(pair?.liquidityUsd)],['24h volume',money(pair?.volume24h)],['FDV',money(fdv)],['24h buys',count(pair?.txns?.h24?.buys)],['24h sells',count(pair?.txns?.h24?.sells)],['DEX',pair?.dex||'—']];
    const stats=$('token-stats');stats.replaceChildren();for(const [label,value] of rows){const cell=el('div');cell.append(el('span',label),el('strong',value));stats.append(cell);}
    $('token-curve-progress').hidden=!native;
    if(native){
      const progress=numeric(curveData.progressPercent),bar=$('token-graduation-progress');bar.value=Math.min(100,progress||0);bar.setAttribute('aria-label',`${quoteValue(progress)}% toward graduation`);
      $('token-graduation-percent').textContent=progress===null?'—':`${Math.min(100,progress).toLocaleString(undefined,{maximumFractionDigits:2})}%`;
      $('token-graduation-amount').textContent=`${quoteValue(curveData.raisedQuote)} / ${quoteValue(curveData.targetQuote,quote)} raised`;
      const observed=Number(curveData.at)>0?new Date(curveData.at).toLocaleTimeString():'';
      $('token-market-note').textContent=[`${curveData.candles?.length?'Raydium history and confirmed curve state':'Confirmed Raydium curve · Launchpad observations'}${observed?' · updated '+observed:''}.`,curveError||curveData.warning,curveData.quote.stale?'USD reference is delayed.':curveData.priceUsd!=null?'USD amounts are current estimates; the chart stays in the quote asset.':'',marketError?'DEX Screener is unavailable; the onchain chart remains active.':''].filter(Boolean).join(' ');
      renderCurveChart();
    }else{
      $('token-market-note').textContent=marketError||marketData?.warning||curveError||(!pair?'Reading the confirmed launch curve while DEX Screener discovers this market.':`DEX Screener · updated ${new Date(marketData.at||clock()).toLocaleTimeString()}`);
    }
    const select=$('token-pool-select'),options=JSON.stringify(pools.map(row=>[row.address,row.pair]));
    if(select.dataset.options!==options){select.replaceChildren();for(const row of pools){const option=el('option',`${row.pair} · ${short(row.address)}`);option.value=row.address;option.selected=row.address===pair?.address;select.append(option);}select.dataset.options=options;}
    for(const option of select.options)option.selected=option.value===pair?.address;$('token-pool-control').hidden=pools.length<2;
    $('token-dex').hidden=!pair;if(pair)$('token-dex').href=`https://dexscreener.com/solana/${pair.address}`;
    if(!native&&pair?.base?.address===selected?.mint){
      const url=`https://dexscreener.com/solana/${pair.address}`;
      if(chartKey!==pair.address){removeCurveChart();chartKey=pair.address;const iframe=el('iframe');iframe.title=`${selected.input?.symbol||'Token'} price chart from DEX Screener`;iframe.src=`${url}?embed=1&theme=dark&info=0&trades=0`;iframe.referrerPolicy='strict-origin-when-cross-origin';iframe.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-popups');$('token-chart').replaceChildren(iframe);}
    }else if(!native)showChartEmpty(curveError?'Launchpad data temporarily unavailable':marketError?'Market data unavailable':'Reading your launch curve',curveError||marketError||(pair?'DEX Screener charts the other token in this pair. Launchpad is reading this token’s confirmed curve.':'The first confirmed price appears here directly from Raydium, without waiting for DEX Screener.'));
  }
  async function refreshCurve(force=false){
    const sessionVersion=sessionGeneration;
    if(sessionVersion!==sessionGeneration||disposed||!authenticated||!launchHasMarket(selected)||!mintAddress(selected.curve)||(dexReady()&&curveData?.status==='migrated')||curveBusy||clock()<curveRetry||(!force&&(document.hidden||marketRefresh===0||clock()<curveNext)))return;
    curveBusy=true;curveNext=clock()+5000;
    try{
      const data=await api(`/api/launchpad/market?id=${encodeURIComponent(selected.id)}`);if(sessionVersion!==sessionGeneration||disposed)return;
      if(data.launchId!==selected.id||data.mint!==selected.mint||data.curve!==selected.curve||data.quote?.mint!==selected.input?.quoteMint)throw Error('The curve response does not match this launch.');
      if(!['curve','migrating','migrated'].includes(data.status)||(data.priceQuote!=null&&numeric(data.priceQuote)===null))throw Error('The current curve price is unavailable.');
      curveData=curveChartSnapshot(data);curveError='';curveRetry=data.stale?(Number(data.retryAt)||clock()+15000):0;curveNext=clock()+Math.max(5000,Number(data.refreshMs)||5000);renderMarket();if(tab==='holders')renderActivity();
    }catch(e){if(sessionVersion!==sessionGeneration||disposed)return;curveError=e.message;curveRetry=clock()+Math.max(5000,Number(e.retryAfterMs)||15000);renderMarket();}
    finally{if(sessionVersion===sessionGeneration)curveBusy=false;}
  }
  function validPools(data){return Array.isArray(data?.pools)?data.pools.filter(row=>mintAddress(row.address)&&[row.base?.address,row.quote?.address].includes(selected.mint)&&row.token===selected.mint):[];}
  async function refreshMarket(force=false){
    const sessionVersion=sessionGeneration;
    if(sessionVersion!==sessionGeneration||disposed||!authenticated||!launchHasMarket(selected)||marketBusy||clock()<marketRetry||(!force&&(marketRefresh===0||clock()<marketNext)))return;
    marketBusy=true;marketNext=clock()+60000;
    try{
      const data=await api(`/api/launchpad/market/pools?id=${encodeURIComponent(selected.id)}${pair?`&pair=${encodeURIComponent(pair.address)}`:''}`);if(sessionVersion!==sessionGeneration||disposed)return;
      if(data.tokenAddress!==selected.mint||data.chain!=='solana')throw Error('The market response does not match this token.');
      const previous=pair?.address;marketData=data;pools=validPools(data);pair=pools.find(row=>row.address===previous)||pools[0]||null;marketError='';
      if(Number.isFinite(data.refreshMs))marketRefresh=Math.max(0,data.refreshMs);marketNext=clock()+Math.max(15000,marketRefresh);marketRetry=data.stale?(Number(data.retryAt)||clock()+15000):0;
      if(previous!==pair?.address){epoch++;live=null;liveError='';liveNext=0;liveFailures=0;activityVersion='';}
      renderMarket();renderActivity();refreshCurve();if(activityVisible){if(tab==='trades')refreshTrades(true);else refreshHolders();}
    }catch(e){if(sessionVersion!==sessionGeneration||disposed)return;marketError=e.message;marketRetry=clock()+Math.max(5000,Number(e.retryAfterMs)||15000);renderMarket();refreshCurve();}
    finally{if(sessionVersion===sessionGeneration)marketBusy=false;}
  }
  function renderActivity(){
    const root=$('token-activity-body');if(!launchHasMarket(selected)){empty(root,legacyLaunch(selected)?'Saved launch record':'Activity follows your launch.',legacyLaunch(selected)?'Open launch history to review the saved transactions.':'Continue from the launchpad to create this token.');$('token-activity-note').textContent='';return;}
    if(tab==='trades'){
      if(!tradeMarket()){empty(root,'Verifying your launch curve.','Confirmed swaps will appear once the launch curve is available.');$('token-activity-note').textContent='';return;}
      const version=JSON.stringify([tab,tradeMarket(),live?.trades,live?.source,live?.indexed,live?.stale,live?.warning,live?.unsupported,live?.unavailable,live?.rpcUnavailable,live?.connectionRequired,live?.backlog,liveError,liveBusy&&!live]);if(version===activityVersion){updateTradeAges(root,clock());return;}activityVersion=version;
      const previous=root.querySelector('.live-trades-view'),scroll=root.querySelector('.live-trades-scroll'),position=scroll?{left:scroll.scrollLeft,top:scroll.scrollTop}:null;
      const view=createLiveTradesView({document,chain:'solana',symbol:selected.input?.symbol||'tokens',data:live,loading:liveBusy&&!live,error:liveError,now:clock(),previous});root.replaceChildren(view);
      const next=root.querySelector('.live-trades-scroll');if(next&&position){next.scrollLeft=position.left;next.scrollTop=position.top;}
      $('token-activity-note').textContent=live?.at?`${live.source||'Market swaps'} · checked ${new Date(live.at).toLocaleTimeString()}`:'Swaps are read from confirmed market activity.';
    }else{
      const version=JSON.stringify([tab,holders?.rows,holders?.supply,holders?.listedSupplyPercent,holders?.historyAvailable,holders?.warning,holderError,pair?.priceUsd??curveData?.priceUsd,[...histories]]);if(version!==activityVersion){activityVersion=version;
        if(!holders){empty(root,holderError?'Holder data unavailable':'Loading holders…',holderError||'Reading confirmed token balances.');}
        else root.replaceChildren(createHoldersView({document,chain:'solana',token:selected.mint,symbol:selected.input?.symbol||'tokens',priceUsd:pair?.priceUsd??curveData?.priceUsd,data:holders,histories,onHistory:loadHistory}));
      }
      $('token-activity-note').textContent=holderError||holders?.warning||(holders?`${holders.source} · ${holders.note||'Supply percentages use total minted supply.'}`:'');
    }
  }
  async function refreshTrades(force=false){
    const sessionVersion=sessionGeneration;
    if(sessionVersion!==sessionGeneration||disposed||!authenticated||tab!=='trades'||!tradeMarket()||!launchHasMarket(selected)||liveBusy||clock()<liveNext||(!force&&marketRefresh===0))return;
    const address=pair?.address,generation=epoch;liveBusy=true;liveNext=clock()+1000;renderActivity();
    try{
      const data=await api(address?`/api/launchpad/market/live-trades?id=${encodeURIComponent(selected.id)}&pair=${encodeURIComponent(address)}`:`/api/launchpad/trades?id=${encodeURIComponent(selected.id)}`);if(sessionVersion!==sessionGeneration||disposed||generation!==epoch)return;
      live=data;liveError='';liveFailures=0;liveNext=clock()+Math.max(1000,Number(data.refreshMs)||1000,Number(data.retryAt)>clock()?Number(data.retryAt)-clock():0);if(data.stale)liveError=data.warning||'Showing the last available swaps.';
    }catch(e){if(sessionVersion!==sessionGeneration||disposed||generation!==epoch)return;liveFailures++;liveError=e.message;liveNext=clock()+Math.max(1000,Number(e.retryAfterMs)||Math.min(60000,2000*2**Math.min(liveFailures-1,5)));}
    finally{if(sessionVersion===sessionGeneration)liveBusy=false;if(sessionVersion===sessionGeneration&&!disposed&&tab==='trades'){renderActivity();if(generation!==epoch)refreshTrades(true);}}
  }
  async function refreshHolders(force=false){
    const sessionVersion=sessionGeneration;
    if(sessionVersion!==sessionGeneration||disposed||!authenticated||tab!=='holders'||!launchHasMarket(selected)||holderBusy||clock()<holderRetry||(!force&&clock()<holderNext))return;
    holderBusy=true;holderNext=clock()+15000;
    try{const data=await api(`/api/launchpad/market/holders?id=${encodeURIComponent(selected.id)}`);if(sessionVersion!==sessionGeneration||disposed)return;holders=data;holderError='';holderRetry=data.stale?(Number(data.retryAt)||clock()+15000):0;holderNext=Math.max(holderNext,holderRetry);}
    catch(e){if(sessionVersion!==sessionGeneration||disposed)return;holderError=e.message;holderRetry=clock()+Math.max(15000,Number(e.retryAfterMs)||15000);holderNext=holderRetry;}
    finally{if(sessionVersion===sessionGeneration)holderBusy=false;if(sessionVersion===sessionGeneration&&!disposed&&tab==='holders')renderActivity();}
  }
  async function loadHistory(wallet){
    const sessionVersion=sessionGeneration;
    if(sessionVersion!==sessionGeneration||disposed||tab!=='holders'||!holders?.rows?.some(row=>row.address===wallet)||histories.get(wallet)?.loading)return;
    const state={...histories.get(wallet),loading:true,expanded:true,error:''};histories.delete(wallet);histories.set(wallet,state);while(histories.size>60)histories.delete(histories.keys().next().value);renderActivity();
    try{state.data=await api(`/api/launchpad/market/holder-history?id=${encodeURIComponent(selected.id)}&wallet=${encodeURIComponent(wallet)}`);}
    catch(e){if(sessionVersion===sessionGeneration)state.error=e.message;}finally{state.loading=false;if(sessionVersion===sessionGeneration&&!disposed&&tab==='holders')renderActivity();}
  }
  // Presentation helpers shared by the venue-specific launch lists.
  function venueSection(section,title,subtitle){section.className='tokens-venue-section';const head=el('div',null,'tokens-venue-heading'),copy=el('div');copy.append(el('h2',title),el('p',subtitle));head.append(copy);section.append(head);const grid=el('div',null,'tokens-grid');section.append(grid);return grid;}
  // Notes and actions each get one wrapper, so every venue card lays out as heading · state · notes · actions.
  function venueCardLayout(card){const body=el('div',null,'token-card-body'),actions=el('div',null,'token-card-actions');for(const node of [...card.children]){if(node.matches('.token-card-heading,.token-card-state'))continue;(node.matches('a,button')?actions:body).append(node);}if(body.childNodes.length)card.append(body);card.append(actions);return card;}
  function venueCardTop(item,stateText,tone){const top=el('div',null,'token-card-heading'),picture=el('div',null,'token-avatar'),identity=el('div',null,'token-card-identity');picture.append(el('span',(item.symbol||item.name||'T').slice(0,1).toUpperCase()));const url=coinImage(item.mint,typeof item.image==='string'?item.image:null);if(url){const image=el('img');image.alt='';image.loading='lazy';image.src=url;picture.firstElementChild.hidden=true;picture.append(image);image.onerror=()=>{image.remove();picture.firstElementChild.hidden=false;};}identity.append(el('h3',item.name||item.symbol||'Coin'),el('span','$'+(item.symbol||'TOKEN')));top.append(picture,identity);const state=el('div',null,'token-card-state'),chip=el('span',stateText,('token-status '+tone).trim());chip.dataset.status=statusSlug(stateText);state.append(chip);const fragment=document.createDocumentFragment();fragment.append(top,state);return fragment;}
  async function refreshPumpLaunches(version){
    let section=document.getElementById('tokens-pumpswap');
    try{const data=await api('/api/launchpad/pump/launches');if(disposed||version!==sessionGeneration||!authenticated)return;
      const rows=(Array.isArray(data)?data:data.launches||[]).filter(x=>/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x.mint||''));
      if(!section){section=el('section');section.id='tokens-pumpswap';$('tokens-list').after(section);}section.hidden=!rows.length||filter!=='launched';section.replaceChildren();if(!rows.length)return;
      // This list is the retained earlier PumpSwap version that used Launchpad's own bonding curve.
      const grid=venueSection(section,'Earlier PumpSwap launches','Launchpad bonding curve · graduates to PumpSwap · creator fees paid automatically');
      for(const item of rows){const card=el('article',null,'token-card'),stateText=item.status==='migrated'?'Graduated to PumpSwap · LP burned':item.status==='bonded'?'Graduation in progress':item.status==='trading'?'On the Launchpad bonding curve':'Launch pending';
        card.append(venueCardTop(item,stateText,item.status==='migrated'||item.status==='trading'?'':'pending'));
        card.append(el('p','0.5% bonding-curve creator fees are paid automatically to your launch wallet. No claim is needed.','help'));card.append(el('p','The fee recipient is fixed at launch for this PumpSwap version.','help'));
        if(BigInt(item.creatorFeesPending||'0')>0n)card.append(el('p','A small creator payout is queued until your wallet can receive it; Launchpad retries automatically.','help'));
        const link=el('a','Open coin →','small-button token-card-open');link.href='/coin?mint='+encodeURIComponent(item.mint);card.append(link);grid.append(venueCardLayout(card));
      }
    }catch{if(section)section.hidden=true;}
  }
  async function refreshDammPumpLaunches(version){
    let section=document.getElementById('tokens-damm-pump');
    try{const data=await api('/api/launchpad/damm-pump/launches');if(disposed||version!==sessionGeneration||!authenticated)return;
      const rows=(Array.isArray(data)?data:data.launches||[]).filter(x=>mintAddress(x.mint)&&(x.archived||x.hidden?filter==='archived':['trading','bonded','migrated'].includes(x.status)?filter==='launched':filter==='drafts'));
      if(!section){section=el('section');section.id='tokens-damm-pump';$('tokens-list').after(section);}section.hidden=!rows.length;section.replaceChildren();if(!rows.length)return;
      // Current PumpSwap mode: trades on Meteora first, then graduates to PumpSwap. Rows follow the selected tab.
      const grid=venueSection(section,filter==='archived'?'Archived PumpSwap launches':filter==='drafts'?'PumpSwap launches in progress':'Your PumpSwap launches','Trades on Meteora from launch · graduates to PumpSwap');
      for(const item of rows){const card=el('article',null,'token-card');
        const migrated=item.status==='migrated'||item.stage==='graduated',moving=['bonded','migrating'].includes(item.status)||item.curveStatus==='migrating',stateText=migrated?'Graduated to PumpSwap · LP burned':moving?'Graduation to PumpSwap in progress':item.status==='trading'||item.curveStatus==='curve'?'Trading on Meteora':'Launch pending';
        card.append(venueCardTop(item,stateText,migrated||stateText==='Trading on Meteora'?'':'pending'));
        if(item.quoteSymbol||item.quote?.symbol)card.append(el('p','Paired with '+(item.quoteSymbol||item.quote.symbol),'help'));
        const live=['trading','bonded','migrated'].includes(item.status),link=el('a',live?'Open coin →':'Resume launch →','small-button token-card-open');link.href=live?'/coin?mint='+encodeURIComponent(item.mint):'/launchpad?venue=damm-pump';card.append(link);grid.append(venueCardLayout(card));
      }
    }catch{if(section)section.hidden=true;}
  }
  // Native Pump.fun launches. Live coins open their coin page; unfinished,
  // refunding and ended requests open their status view on the launch page.
  const pumpClassicCategory=row=>row.state==='created'?'launched':['cancelled','expired','refunded'].includes(row.state)||row.state==='failed'&&row.dimensions?.refund!=='pending'?'archived':'drafts';
  function pumpClassicState(row){
    if(row.state==='created')return row.dimensions?.venue==='amm'?['Graduated to PumpSwap','']:['Live on Pump.fun',''];
    if(row.state==='failed')return row.dimensions?.refund==='pending'?['Refunding','pending']:['Failed','error'];
    if(['cancelled','expired','refunded','draft'].includes(row.state))return [typeof row.stateLabel==='string'&&row.stateLabel?row.stateLabel:'Ended','draft'];
    return [typeof row.stateLabel==='string'&&row.stateLabel?row.stateLabel:'In progress','pending'];
  }
  function clearPumpClassic(){pumpClassicRows=[];pumpClassicRoot.hidden=true;pumpClassicRoot.replaceChildren();}
  function renderPumpClassic(){
    const rows=pumpClassicRows.filter(row=>pumpClassicCategory(row)===filter);pumpClassicRoot.replaceChildren();pumpClassicRoot.hidden=!authenticated||!!requested||!rows.length;if(pumpClassicRoot.hidden)return;
    const grid=venueSection(pumpClassicRoot,filter==='archived'?'Ended Pump.fun launches':filter==='drafts'?'Pump.fun launches in progress':'Your Pump.fun launches','Created on Pump.fun from a Launchpad launch wallet · graduates to PumpSwap');
    for(const item of rows){
      const card=el('article',null,'token-card'),[stateText,tone]=pumpClassicState(item);card.dataset.pumpClassicLaunch=item.id;card.append(venueCardTop(item,stateText,tone));
      if(typeof item.pair?.symbol==='string'&&item.pair.symbol)card.append(el('p','Paired with '+item.pair.symbol,'help'));
      if(typeof item.modeLabel==='string'&&item.modeLabel)card.append(el('p','Fee option · '+item.modeLabel,'help'));
      if(item.state!=='created'&&typeof item.reason==='string'&&item.reason)card.append(el('p',item.reason.slice(0,300),'help'));
      const refunded=[Number(item.refundedSol)>0?item.refundedSol+' SOL':'',Number(item.refundedPair)>0&&item.pair?.symbol?item.refundedPair+' '+item.pair.symbol:''].filter(Boolean);if(refunded.length)card.append(el('p','Refunded '+refunded.join(' and ')+'.','help'));
      const live=item.state==='created'&&mintAddress(item.mint),open=el('a',live?'Open coin →':['awaiting_funding','draft'].includes(item.state)?'Resume launch →':'View launch →','small-button token-card-open');
      open.href=live?'/coin?mint='+encodeURIComponent(item.mint):'/launchpad?venue=pump-classic&launchId='+encodeURIComponent(item.id);card.append(open);grid.append(venueCardLayout(card));
    }
  }
  // Robinhood Chain launches: live coins open their coin page (?chain=robinhood); the rest open the launch page's dialog.
  const robinhoodCategory=row=>row.state==='created'?'launched':['cancelled','expired','refunded'].includes(row.state)||row.state==='failed'&&row.dimensions?.refund!=='pending'?'archived':'drafts';
  function robinhoodState(row){
    if(row.state==='created')return row.venueState==='graduated'?['Graduated · trading continues in the pool','']:['Live on Robinhood Chain',''];
    if(row.state==='failed')return row.dimensions?.refund==='pending'?['Refunding','pending']:['Failed','error'];
    if(['cancelled','expired','refunded','draft'].includes(row.state))return [typeof row.stateLabel==='string'&&row.stateLabel?row.stateLabel:'Ended','draft'];
    return [typeof row.stateLabel==='string'&&row.stateLabel?row.stateLabel:'In progress','pending'];
  }
  function clearRobinhood(){robinhoodRows=[];robinhoodRoot.hidden=true;robinhoodRoot.replaceChildren();}
  function renderRobinhood(){
    const rows=robinhoodRows.filter(row=>robinhoodCategory(row)===filter);robinhoodRoot.replaceChildren();robinhoodRoot.hidden=!authenticated||!!requested||!rows.length;if(robinhoodRoot.hidden)return;
    const grid=venueSection(robinhoodRoot,filter==='archived'?'Ended Robinhood Chain launches':filter==='drafts'?'Robinhood Chain launches in progress':'Your Robinhood Chain coins','Created by Launchpad’s own launch contracts on Robinhood Chain · a locked Uniswap v4 pool from the first block');
    for(const item of rows){
      const card=el('article',null,'token-card'),[stateText,tone]=robinhoodState(item);card.dataset.robinhoodLaunch=item.id;card.append(venueCardTop({...item,mint:item.token||item.predictedToken||''},stateText,tone));
      if(typeof item.pair?.symbol==='string'&&item.pair.symbol)card.append(el('p','Paired with '+item.pair.symbol+(item.tier?.label?' · '+item.tier.label:''),'help'));
      if(typeof item.modeLabel==='string'&&item.modeLabel)card.append(el('p','Rewards · '+item.modeLabel+(Number(item.taxBps)>0?' · '+(Number(item.taxBps)/100)+'% holder tax':item.fees?' · 0.5% creator fee':''),'help'));
      if(item.state!=='created'&&typeof item.reason==='string'&&item.reason)card.append(el('p',item.reason.slice(0,300),'help'));
      if(Number(item.refundedEth)>0)card.append(el('p','Refunded '+item.refundedEth+' ETH.','help'));
      const live=item.state==='created'&&/^0x[0-9a-fA-F]{40}$/.test(item.token||''),open=el('a',live?'Open coin →':['awaiting_funding','draft'].includes(item.state)?'Resume launch →':'View launch →','small-button token-card-open');
      open.href=live?'/coin?mint='+encodeURIComponent(item.token)+'&chain=robinhood':'/launchpad?chain=robinhood&launchId='+encodeURIComponent(item.id);card.append(open);grid.append(venueCardLayout(card));
    }
  }
  async function refreshRobinhoodLaunches(version){
    if(document.body?.dataset?.robinhood==='off'){robinhoodRoot.hidden=true;return;} // v71.43: Robinhood Chain is off this host
    try{const data=await api('/api/launchpad/robinhood/launches');if(disposed||version!==sessionGeneration||!authenticated)return;
      robinhoodRows=(Array.isArray(data?.launches)?data.launches:[]).filter(row=>row&&typeof row==='object'&&typeof row.id==='string'&&/^[a-f0-9]{24}$/.test(row.id)&&typeof row.state==='string');renderRobinhood();
    }catch{if(!disposed&&version===sessionGeneration)robinhoodRoot.hidden=true;}
  }
  async function refreshPumpClassicLaunches(version){
    try{const data=await api('/api/launchpad/pump-classic/launches');if(disposed||version!==sessionGeneration||!authenticated)return;
      pumpClassicRows=(Array.isArray(data?.launches)?data.launches:[]).filter(row=>row&&typeof row==='object'&&typeof row.id==='string'&&/^[A-Za-z0-9_-]{6,64}$/.test(row.id)&&typeof row.state==='string');renderPumpClassic();
    }catch{if(!disposed&&version===sessionGeneration)pumpClassicRoot.hidden=true;}
  }
  async function refreshList(force=false){
    const sessionVersion=sessionGeneration,revision=listRevision;
    if(sessionVersion!==sessionGeneration||disposed||!authenticated||listBusy||archiveBusy||redirectBusy||(!force&&clock()<listNext))return;listBusy=true;listNext=clock()+30000;
    try{
      const data=await api('/api/launchpad');if(sessionVersion!==sessionGeneration||revision!==listRevision||disposed)return;if(!Array.isArray(data.launches))throw Error('Your launch list could not be loaded.');launches=data.launches;if(redirectDraft?.payload){const saved=launches.find(row=>row.id===redirectDraft.id)?.feeRedirect;if(saved?.used===true&&saved.recipient===redirectDraft.payload.recipient)resetFeeRedirect();}
      // The other venues' lists are shown only in the list view; a launch detail page never reads them.
      if(!requested){void refreshPumpLaunches(sessionVersion);void refreshDammPumpLaunches(sessionVersion);void refreshPumpClassicLaunches(sessionVersion);void refreshRobinhoodLaunches(sessionVersion);void meteoraLaunches.load();}
      if(requested){
        selected=launchId(requested)?launches.find(row=>row.id===requested):null;
        if(!selected){renderBuyback();$('tokens-detail-view').hidden=true;$('tokens-list-view').hidden=false;empty($('tokens-list'),'Launch not found.','This launch is not available in your account.',{text:'Back to your launches',href:'/launched-tokens'},'missing');return;}
        $('tokens-list-view').hidden=true;$('tokens-detail-view').hidden=false;renderLaunch();refreshRewards();refreshBuyback();if(launchHasMarket(selected)&&!activated){activated=true;refreshMarket(true);refreshCurve(true);if(tab==='trades')refreshTrades(true);}
      }else renderList();error();
    }catch(e){if(sessionVersion===sessionGeneration&&revision===listRevision&&!disposed)error(e.message);}finally{if(sessionVersion===sessionGeneration)listBusy=false;}
  }
  for(const button of document.querySelectorAll('[data-launch-filter]'))button.onclick=()=>{filter=button.dataset.launchFilter;meteoraLaunches.setFilter(filter);const pump=document.getElementById('tokens-pumpswap');if(pump)pump.hidden=filter!=='launched'||!pump.querySelector('article');void refreshDammPumpLaunches(sessionGeneration);renderPumpClassic();renderRobinhood();renderList();};
  for(const button of document.querySelectorAll('[data-token-tab]'))button.onclick=()=>{tab=button.dataset.tokenTab;activityVersion='';for(const other of document.querySelectorAll('[data-token-tab]'))other.setAttribute('aria-pressed',String(other===button));renderActivity();if(tab==='trades')refreshTrades(true);else refreshHolders();};
  $('tokens-list-refresh').onclick=()=>Promise.all([refreshList(true),refreshAssignedFees(true),earnings.load()]);$('tokens-claim-all').onclick=()=>claimFees();$('assigned-fees-refresh').onclick=()=>refreshAssignedFees(true);
  $('tokens-wallet-close').onclick=()=>closeWallets();$('tokens-wallet-dialog').addEventListener('cancel',event=>{event.preventDefault();closeWallets();});$('token-market-refresh').onclick=()=>{refreshMarket(true);refreshCurve(true);};
  for(const button of document.querySelectorAll('[data-curve-mode]'))button.onclick=()=>{curveMode=button.dataset.curveMode;for(const other of document.querySelectorAll('[data-curve-mode]'))other.setAttribute('aria-pressed',String(other===button));if(showingCurve())renderCurveChart();};
  $('token-rewards-refresh').onclick=()=>refreshRewards(true);
  $('token-activity-refresh').onclick=()=>tab==='trades'?refreshTrades(true):refreshHolders(true);
  $('token-pool-select').onchange=()=>{const next=pools.find(row=>row.address===$('token-pool-select').value);if(!next||next.address===pair?.address)return;pair=next;epoch++;live=null;liveError='';liveNext=0;activityVersion='';renderMarket();renderActivity();refreshTrades(true);};
  $('token-copy').onclick=async()=>{if(!launchIsOnchain(selected))return;try{await window.navigator.clipboard.writeText(selected.mint);$('token-copy').textContent='Copied';window.setTimeout(()=>{if(!disposed)$('token-copy').textContent='Copy';},1800);}catch{$('token-copy').textContent='Select address';$('token-address').textContent=selected.mint;}};
  async function tick(){
    if(disposed||document.hidden)return;
    if(!sessionReceived){if(!sessionLoading&&clock()>=sessionRetryAt)void loadSession();return;}
    if(!authenticated)return;refreshList();refreshAssignedFees();earnings.load();if(!selected||!launchHasMarket(selected))return;if(showingCurve()&&!curveChart&&!curveLoading&&clock()>=curveRenderRetry)renderCurveChart();refreshRewards();refreshBuyback();if(marketRefresh){refreshMarket();refreshCurve();}
    // Swaps and holders poll only while their panel is on screen (or near it).
    if(tab==='trades'){updateTradeAges($('token-activity-body'),clock());if(activityVisible)refreshTrades();}else if(marketRefresh&&activityVisible)refreshHolders();
  }
  const interval=setTimer(tick,1000);
  const onVisibility=()=>{if(!document.hidden)tick();};document.addEventListener('visibilitychange',onVisibility);
  const activityObserver=typeof window.IntersectionObserver==='function'&&$('token-activity')?new window.IntersectionObserver(entries=>{const visible=entries.some(entry=>entry.isIntersecting);if(visible===activityVisible)return;activityVisible=visible;if(visible&&!disposed&&!document.hidden)void tick();},{rootMargin:'300px 0px'}):null;activityObserver?.observe($('token-activity'));
  function destroy(){if(disposed)return;disposed=true;clearGotchis();filterObserver?.disconnect();earningsObserver?.disconnect();activityObserver?.disconnect();hookObserver?.disconnect();clearHookPanels();sessionGeneration++;buybackEpoch++;buybackController?.abort();window.removeEventListener('pagehide',onPageHide);resetFeeRedirect();clearAssignedFees();earnings.destroy();meteoraLaunches.destroy();tradeView.destroy();document.removeEventListener('curve-account-updated',accountUpdated);walletReject?.(Error('Page closed. Submitted claims can still confirm.'));walletUnsubscribe?.();removeCurveChart();clearTimer(interval);for(const controller of controllers)controller.abort();document.removeEventListener('visibilitychange',onVisibility);}
  const onPageHide=event=>{if(!event.persisted)destroy();};window.addEventListener('pagehide',onPageHide);
  function resetAccount(){
    meteoraLaunches.clear();clearHookPanels();document.getElementById('tokens-damm-pump')?.remove();clearPumpClassic();clearRobinhood();sessionGeneration++;epoch++;buybackEpoch++;listRevision++;archiveBusy='';resetFeeRedirect();redirectWallet='';clearAssignedFees();earnings.clear();
    for(const controller of controllers)controller.abort();buybackController?.abort();
    walletReject?.(Object.assign(Error('Your account changed. Reconnect to continue.'),{cancelled:true}));walletResolve=null;walletReject=null;expectedWallet='';$('tokens-wallet-dialog').close();
    tradeView.setCoin(null);launches=[];selected=null;activated=false;listBusy=false;listVersion='';detailVersion='';listNext=0;
    pools=[];pair=null;marketData=null;marketError='';marketBusy=false;marketNext=0;marketRetry=0;marketRefresh=60000;
    holders=null;holderError='';holderBusy=false;holderNext=0;holderRetry=0;histories.clear();activityVersion='';
    live=null;liveError='';liveBusy=false;liveNext=0;liveFailures=0;
    curveData=null;curveError='';curveBusy=false;curveNext=0;curveRetry=0;chartKey='';removeCurveChart();
    rewardsData=null;rewardsBusy=false;rewardsNext=0;rewardsRetry=0;rewardsError='';
    buybackData=null;buybackBusy=false;buybackNext=0;buybackRetry=0;buybackError='';buybackKey='';
    claimsBusy=false;claimsSummary='';claimItems.clear();
    clearGotchis();for(const id of ['tokens-list','token-chart','token-activity-body','token-creator','token-details','token-socials','token-claim-detail','token-archive-detail','token-launch-history'])$(id)?.replaceChildren();
    for(const id of ['token-name','token-symbol','token-address','token-description','tokens-claim-summary'])$(id).textContent='';
    $('token-creator').hidden=true;$('tokens-main').hidden=true;$('tokens-detail-view').hidden=true;$('tokens-list-view').hidden=false;error();
  }
  async function activateSession(session){
    if(disposed)return;sessionReceived=true;
    const nextIdentity=session.authenticated?(session.account?.id||session.account?.mainWallet||session.account?.username||'authenticated'):'';
    const nextAssignedIdentity=session.authenticated?JSON.stringify([nextIdentity,session.authMethod||'',session.walletAddress||'',session.account?.authType||'',session.account?.mainWallet||'',session.account?.signInWallet||'']):'';
    const assignedChanged=nextAssignedIdentity!==assignedSessionIdentity;
    const changed=nextIdentity!==accountIdentity||(!!session.authenticated&&!authenticated);
    if(changed){resetAccount();accountIdentity=nextIdentity;}
    else if(assignedChanged){clearAssignedFees();resetFeeRedirect();}assignedSessionIdentity=nextAssignedIdentity;redirectWallet=session.authenticated&&session.authMethod==='wallet'&&session.walletVerified===true?session.walletAddress||'':'';
    csrf=session.token||'';authenticated=!!session.authenticated;if(authenticated)sessionExpired=false;hookSession=session;tradeView.setSession(session);earnings.setSession(session);meteoraLaunches.setSession(session);if(hookedRows.size)scheduleHookDecoration();
    shell({session,page:'launched-tokens',chain:'solana'});
    if(!authenticated){expire();return;}
    const creator=$('token-creator');if(creator){creator.replaceChildren();creator.hidden=!session.account?.username;if(!creator.hidden){const label=document.createElement('span');label.textContent='Creator';creator.append(label);if(/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(session.account.avatar||'')){const image=document.createElement('img');image.src=session.account.avatar;image.alt='';image.className='creator-avatar';creator.append(image);}const name=document.createElement('a');name.href='/user/'+encodeURIComponent(session.account.username);name.textContent=session.account.username;creator.append(name);creator.title=session.account.bio||'';}}
    // The hero greets the signed-in creator by name (presentation only; the default headline stays for accounts without a username).
    const hero=document.querySelector('#tokens-list-view>.terminal-heading h1'),username=session.account?.username;
    if(hero){if(typeof username==='string'&&/^[A-Za-z0-9_][A-Za-z0-9_-]{2,31}$/.test(username))hero.replaceChildren('Welcome back, ',el('span',username,'tokens-hero-name'),'.');else hero.textContent='Ideas, onchain.';}
    $('tokens-gate').hidden=true;$('tokens-main').hidden=false;
    if(changed)await Promise.all([refreshList(true),refreshAssignedFees(true),earnings.load()]);else if(assignedChanged)await Promise.all([refreshAssignedFees(true),earnings.load()]);renderFeeRedirects();
  }
  const gateSignIn=$('tokens-gate')?.querySelector('a');if(gateSignIn)gateSignIn.onclick=event=>{event.preventDefault();document.querySelector('[data-account-link]')?.click();};
  // A failed session check (outage, proxy error page, timeout) says so and retries;
  // it never tells a signed-in visitor to connect a wallet.
  async function loadSession(){
    if(disposed||sessionReceived||sessionLoading)return;sessionLoading=true;
    try{const session=await api('/api/session');if(!sessionReceived)await activateSession(session);}
    catch{
      if(disposed||sessionReceived)return;sessionFailures++;sessionRetryAt=clock()+Math.min(60000,5000*2**Math.min(sessionFailures-1,4));
      $('tokens-main').hidden=true;$('tokens-gate').hidden=false;$('tokens-gate-message').textContent='Your Launchpad account could not be checked right now. Retrying automatically.';const signIn=$('tokens-gate').querySelector('a');if(signIn)signIn.hidden=true;
    }finally{sessionLoading=false;}
  }
  const ready=loadSession();
  return {ready,destroy,canLeave:()=>!claimsBusy&&!archiveBusy&&!redirectBusy&&!assignedClaimBusy&&!walletResolve&&!walletReject&&meteoraLaunches.canLeave()&&tradeView.canLeave?.()!==false&&[...hookPanels.values()].every(({panel})=>panel.canLeave()),tick,refreshList,refreshMarket,refreshCurve,refreshTrades,refreshHolders,refreshRewards,refreshBuyback,claimFees,archiveLaunch,refreshAssignedFees,claimAssignedFees};
}

export function mountPage({document=globalThis.document,window=document.defaultView}={}){return createLaunchedTokensPage({document,window});}
bootPage('launched-tokens',mountPage);
