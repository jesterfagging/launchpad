import {createQuoteIcon,createQuoteLabel} from './quote-logos.mjs';
import {createWorkspaceShell} from './workspace-shell.js';
import {bootPage} from './navigation.mjs';
import {launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink} from './launchpad-model.mjs';
import {NATIVE_LAUNCH_ASSETS as LAUNCH_ASSETS} from './quote-display-assets.mjs';
import {creatorFeeForLaunch} from './creator-fee-schedule.mjs';
import {GOTCHI_THEMES,gotchiFundingSummary,gotchiTheme} from './gotchi-catalog.mjs';
import {AGENT_PERSONALITIES,AGENT_FUNDING_SUMMARY,AGENT_LIMITS,AGENT_OBJECTIVES,AGENT_OBJECTIVE_GROUPS,objectiveById,normalizeObjectiveSettings} from './agent-catalog.mjs';
import {getLaunchpadWallet as createLaunchpadWallet} from './launchpad-wallet.mjs';
import {optimizeLaunchImage} from './launch-image.mjs';
import {PUMP_CLASSIC_MODES,PUMP_CLASSIC_STRATEGY_MODES,PUMP_CLASSIC_MODE_LABELS,PUMP_CLASSIC_MODE_SUMMARIES,PUMP_CLASSIC_LIMITS,PUMP_CLASSIC_FEE_LINK,PUMP_CLASSIC_SOL_ONLY_MODES,PUMP_CLASSIC_CONVERT_MODES,PUMP_CLASSIC_OPTION_MODES} from './pump-classic-catalog.mjs';
import {PUMP_OPTIONS,pumpOptionRequest,describePumpOption} from './pump-option-catalog.mjs';
import {createChainSelect,initialLaunchChain,launchChainById} from './launch-chains.mjs';
import {HOOK_GROUPS,HOOK_RULES,HOOK_MAX_RULES,HOOK_LIMITS,HOOK_NOT_OFFERED,HOOK_ROUTES,HOOK_TIMEZONES,WEEKDAYS,hookRuleById,hookRulesConflict,hookSettingApplies,hookLaunchRequest,describeHookRule,hookAppUnavailableText} from './hook-catalog.mjs';
import { modeOnVenue } from './tenant-catalog.mjs';
export function mountPage({document=globalThis.document,window=document.defaultView,requestTimeoutMs=60000,walletTimeoutMs=120000}={}){
let disposed=false,pollTimer,catalogueTimer,catalogueRetryTimer=null,catalogueRetryDelay=5000;const requests=new Set();
const cancelled=()=>Object.assign(Error('This launch page is no longer active.'),{cancelled:true});
// Bound the full response, including its body. An aborted browser request can
// still finish on the server, so callers retain the launch/request identity.
function bounded(promise,{signal,timeoutMs,error}){return new Promise((resolve,reject)=>{
  let finished=false,timer;const finish=(fn,value)=>{if(finished)return;finished=true;window.clearTimeout(timer);signal?.removeEventListener('abort',abort);fn(value);},abort=()=>finish(reject,signal.reason||cancelled());
  timer=window.setTimeout(()=>finish(reject,error),timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  Promise.resolve(promise).then(value=>finish(resolve,value),error=>finish(reject,error));
});}
const pageFetch=async(url,options={})=>{
  if(disposed)throw cancelled();const controller=new AbortController(),parent=options.signal,abort=()=>controller.abort(parent.reason||cancelled());if(parent?.aborted)throw parent.reason||cancelled();parent?.addEventListener('abort',abort,{once:true});requests.add(controller);
  const timeout=Object.assign(Error('The launch request is taking too long. Its outcome may still be processing. Resume this saved launch to check its progress.'),{code:'LAUNCH_REQUEST_TIMEOUT',status:408});
  try{return await bounded((async()=>{const response=await fetch(url,{...options,signal:controller.signal,cache:'no-store'});let data;try{data=await response.json();}catch(error){if(controller.signal.aborted)throw controller.signal.reason;throw Object.assign(Error('The connection was interrupted. Please try again.'),{status:response.status>=400?response.status:503});}if(disposed)throw cancelled();return{ok:response.ok,status:response.status,headers:response.headers,json:async()=>data};})(),{signal:controller.signal,timeoutMs:requestTimeoutMs,error:timeout});}
  catch(error){controller.abort(error);throw error;}finally{parent?.removeEventListener('abort',abort);requests.delete(controller);}
};
createWorkspaceShell({page:'launchpad',chain:'solana'});
const pageElements=new Map([...document.querySelectorAll('[id]')].map(element=>[element.id,element]));
const $=id=>pageElements.get(id),form=$('launch-form'),field=name=>form.elements.namedItem(name);
// The launch panel (step rail, wallet line and Create coin) sits in the side column, next to the live preview.
const launchPanel=document.querySelector('.launch-form-footer'),launchWalletLine=document.querySelector('.launch-wallet-line');
const node=(tag,text='')=>{const e=document.createElement(tag);e.textContent=text;return e;};
const issuerLabel=value=>{const text=String(value||'').trim();return text.toLowerCase().replace(/[ _-]+/g,' ')==='backpack securities'?'Backpack Securities':text.replace(/_/g,' ').replace(/\b\p{Ll}/gu,letter=>letter.toUpperCase());};
const assetSubtitle=a=>{const issuer=issuerLabel(a.issuer),name=String(a.name||'').trim().replace(/\bbackpack[_ -]+securities\b/gi,'Backpack Securities'),label=name&&issuer&&name.toLowerCase().includes(issuer.toLowerCase())?name:[name,issuer].filter(Boolean).join(' · ');return a.wormhole===true&&a.bridgeProtocol==='ntt'?label+' · Wormhole NTT':a.category==='wormhole'&&a.originChain?label+' · From '+issuerLabel(a.originChain):label;};
function assetBadge(a,compact=false){return createQuoteIcon(document,a,{size:compact?30:44,className:'launch-asset-icon launch-ticker-badge'+(compact?' launch-ticker-compact':'')});}
const money=value=>'$'+Number(value).toLocaleString(undefined,{maximumFractionDigits:2});
const modes={creator:'Creator',holders:'Holders',paycheck:'Paycheck',buyback:'Agent buyback',gotchi:'Gotchi',agent:'AI Agent',market_maker:'Market Maker',lp_manager:'Liquidity Manager',diamond_hands:'Diamond Hands',earned:'Earned',insured:'Insured'};
// Launch options that exist only on Pump.fun (mirrors PUMP_CLASSIC_ONLY_MODES; the server enforces it).
const PUMP_ONLY_MODES=Object.freeze(['market_maker','lp_manager','diamond_hands','earned','insured']);
// Paycheck buys and burns the platform token; a host without one marks the page (src/brand.mjs) and does not offer it.
const paycheckOffered=()=>document.body.dataset.platformToken!=='off';
const nativePairMints=Object.freeze({SOL:SOL_MINT,USDC:USDC_MINT}),nativePairs=new Set(Object.values(nativePairMints));
/** The Solana market's SOL | USDC | Custom segments only — never the Robinhood picker's rows, which carry their own data attributes. */
const solanaPairButtons=()=>document.querySelectorAll('.launch-pairs[aria-labelledby="launch-pair-label"]>[data-pair]');
const launchWallet=createLaunchpadWallet({window:document.defaultView});
let cataloguePending=null,catalogueCheckedAt=null;
// A white-label launchpad (LAUNCHPAD_PRODUCT=tenant; <body data-product="tenant">): only the venues and launch modes its owner picked
// (data-venues, data-modes). The server refuses anything else (src/tenant/gate.mjs); this keeps the form on what it offers.
const TENANT=document.body?.dataset.product==='tenant',TENANT_VENUES=TENANT?String(document.body.dataset.venues||'').split(' ').filter(Boolean):[],TENANT_MODES=TENANT?String(document.body.dataset.modes||'').split(' ').filter(Boolean):[];
const tenantModeOk=(mode,venue)=>!TENANT||TENANT_MODES.includes(mode)&&modeOnVenue(mode,venue);
// Starts (Raydium and Meteora): the engine's $20K start, or what a launchpad offers (<body data-starts="raydium:20k,4k meteora:4k">).
// With both offered the creator picks; every start graduates at $50,000.
const START_USD={'20k':20000,'4k':4000},START_NOTES={'20k':'Starts at $20,000: a gentler curve.','4k':'Starts at $4,000: a steeper curve, with more of the supply sold on it.'};
const TENANT_STARTS=TENANT?Object.fromEntries(String(document.body.dataset.starts||'').split(' ').filter(Boolean).map(row=>{const [venue,ids='']=row.split(':');return[venue,ids.split(',').filter(id=>START_USD[id])];})):{};
let chosenStart='20k';
const startsFor=venue=>TENANT&&TENANT_STARTS[venue]?.length?TENANT_STARTS[venue]:['20k'];
const currentStart=()=>{const venue=isMeteora()?'meteora':isRaydium()?'raydium':'';if(!venue)return'20k';const allowed=startsFor(venue);return allowed.includes(chosenStart)?chosenStart:allowed[0];};
let launchVenue='raydium',venueVersion=0,pumpAllowed=false,pumpUi=null,pumpBusy=false,pumpPreviewVersion=0,raydiumSelection=null,pumpFunded=null,pumpPublic=false,pumpPublicController=null,pumpPublicStatus=null;
const isPump=()=>launchVenue==='pumpswap';
let meteoraStatus=null,meteoraController=null,meteoraModule=null,meteoraStatusPending=null,meteoraStatusCheckedAt=null;
const isMeteora=()=>launchVenue==='meteora';
let dammPumpStatus=null,dammPumpController=null,dammPumpStatusPending=null,dammPumpStatusCheckedAt=null,dammPumpSavedOperation=null,dammPumpSavedPending=null;
const dammPumpDeferredLaunchMints=new Set();
const dammPumpResumeButton=node('button','Resume saved PumpSwap launch');dammPumpResumeButton.id='launch-damm-pump-resume';dammPumpResumeButton.type='button';dammPumpResumeButton.className='small-button';dammPumpResumeButton.hidden=true;$('launch-open').after(dammPumpResumeButton);
const isDammPump=()=>launchVenue==='damm-pump';
// Pump.fun: native Pump.fun coins created by Launchpad. Pairs are SOL and the quote
// assets Pump.fun admits for new coins (read live from the server); six launch
// options, of which AI Agent, Market Maker and Liquidity Manager pair with SOL only.
let pumpClassicStatus=null,pumpClassicController=null,pumpClassicStatusPending=null,pumpClassicStatusCheckedAt=null,pumpClassicLaunches=[];
// The live Pump.fun pair list, read once the venue is available and reused when Pump.fun is chosen, so the pair
// buttons appear in their final layout instead of a lone SOL button followed by the full set.
let pumpClassicPairsCache=null,pumpClassicPairsPrefetch=null;
const pumpClassicPairReady=a=>a?.pumpClassic===true&&a.launchReady===true&&Number.isInteger(a.decimals)&&a.decimals>=0&&a.decimals<=12;
// The pair the dev-buy amount was typed for: an amount is never carried over to another pair's unit.
let pumpClassicBuyMint=SOL_MINT;
// Why the selected Pump.fun pair cannot take the chosen option ('' when it can).
// The options the selected non-SOL Pump.fun pair can take: Creator always; Holders and Gotchi only when Launchpad can sell the pair for SOL.
const pumpClassicPairOptions=(a=asset)=>a?.convertible===true?'Creator, Holders, Diamond Hands or Gotchi':'Creator';
const pumpClassicModeBlock=(mode,a=asset)=>!a||a.mint===SOL_MINT?'':PUMP_CLASSIC_SOL_ONLY_MODES.includes(mode)?(PUMP_CLASSIC_MODE_LABELS[mode]||'This option')+' pairs with SOL only on Pump.fun. Choose SOL as the pair, or '+pumpClassicPairOptions(a)+' for '+a.symbol+'.':PUMP_CLASSIC_CONVERT_MODES.includes(mode)&&a.convertible!==true?'Launchpad can’t sell '+a.symbol+' for SOL yet, which Holders, Diamond Hands and Gotchi need, so they are unavailable on this pair. Creator works on it, or choose SOL as the pair.':'';
// The step rail's short form of the same block ('' when the pair takes the option).
const pumpClassicModeTodo=(mode,a=asset)=>!pumpClassicModeBlock(mode,a)?'':PUMP_CLASSIC_SOL_ONLY_MODES.includes(mode)?'choose SOL as the pair ('+(PUMP_CLASSIC_MODE_LABELS[mode]||'this option')+' pairs with SOL only on Pump.fun) or '+pumpClassicPairOptions(a)+' for '+a.symbol:'choose Creator for '+a.symbol+' (Holders, Diamond Hands and Gotchi need a pair Launchpad can sell for SOL) or SOL as the pair';
const isPumpClassic=()=>launchVenue==='pump-classic';
// v71.39 Chain choice: Solana (the venues above) or Robinhood Chain (Launchpad's own contracts; public/robinhood-launch-ui.mjs).
// On Robinhood the Solana market section hides and the Robinhood market block takes its place; the transfer-rules block
// moves with it. The chain is remembered and readable from ?chain=.
let launchChain='solana',chainSelect=null,robinhoodMarket=null,robinhoodMarketPending=null,robinhoodController=null,robinhoodModule=null,evmWallet=null,evmWalletModule=null,robinhoodWalletUnsubscribe=null;
const isRobinhood=()=>launchChain==='robinhood';
const CHAIN_STORAGE='curve.launchChain';
const pumpClassicAllowed=()=>pumpClassicStatus?.available===true&&pumpClassicStatus.intakeOpen===true;
const pumpClassicReason=()=>pumpClassicStatus?.reason||(pumpClassicStatus?'Pump.fun launches are not available right now.':'Checking Pump.fun availability…');
const dammPumpAllowed=()=>dammPumpStatus?.available===true&&dammPumpStatus.publicEnabled!==false;
const dammPumpCompatible=a=>a?.launchReady===true&&Number.isInteger(a.decimals)&&a.decimals>=0&&a.decimals<=18;
const dammPumpCatalogueRow=a=>dammPumpCompatible(a)||a?.launchReady===false&&['coming-soon','unavailable'].includes(a.availability)&&typeof a.supportReason==='string';
const dammPumpComingSoon=a=>a?.launchReady===false&&a?.compatibilityVerified===true&&a?.comingSoon===true&&a?.availability==='coming-soon';
const dammPumpReason=()=>dammPumpStatus?.blockers?.map(x=>typeof x==='string'?x:x?.message).filter(Boolean).join(' ')||dammPumpStatus?.reason||'Launch setup is not ready yet. Check again shortly.';
const dammPumpFeeText=()=>dammPumpStatus?.fees?.description||'1.25% pool trading fee before graduation, including approximately 1% for Launchpad. No transfer tax or creator or holder rewards. PumpSwap pool fees apply after graduation.';
const meteoraAllowed=()=>meteoraStatus?.available===true&&(meteoraStatus.publicEnabled===true||meteoraStatus.ownerPreview===true);
const meteoraCompatible=a=>a?.launchReady===true&&Number.isInteger(a.decimals)&&a.decimals>=0&&a.decimals<=18;
const venueCompatible=a=>isPumpClassic()?pumpClassicPairReady(a):isDammPump()?dammPumpCompatible(a):isMeteora()?meteoraCompatible(a):isPump()?pumpCompatible(a):a?.supported===true;
const pumpTargets=()=>!pumpPublic&&$('launch-pump-preset').value==='micro-test'?{start:100,graduation:500}:{start:20000,graduation:50000};
const pumpCompatible=a=>pumpPublic?a?.mint===SOL_MINT&&a?.launchReady===true:a?.testSelectable===true&&a.poolCompatible===true&&a.mintCompatibility==='supported'&&a.launchReady===false;
const assertRaydium=()=>{if(launchVenue!=='raydium')throw Error('This launch uses a separate venue transaction flow.');};
let adminLaunch=false,canViewComingSoon=false,catalogueReady=false,catalogueFailed=false,launchCatalogueSession='',walletOnly=true,sessionWallet='',lastFeeMode=field('feeMode').value;
// Coin text as each venue's server reads it: one line, where a line break or tab inside (with the spaces around it)
// becomes one space. Names (32) and tickers (Pump.fun 13, other venues 10) are written onchain and limited in UTF-8
// bytes, so emoji and accented letters count as 2 to 4. Descriptions: Raydium and Pump.fun 500 characters, Meteora
// and PumpSwap 1,000 bytes.
const oneLine=value=>String(value??'').replace(/[\x00-\x08\x0e-\x1f\x7f]/g,'').replace(/\s*[\t\n\v\f\r\u0085\u2028\u2029][\s\u0085]*/g,' ').trim();
const isRaydium=()=>!isPumpClassic()&&!isMeteora()&&!isDammPump()&&!isPump();
const utf8Size=text=>new TextEncoder().encode(text).length,BYTES_NOTE='; emoji and accented letters count as 2 to 4 each';
const tickerLimit=()=>isPumpClassic()||isRobinhood()?13:10;
function tickerProblem(value){
  const symbol=oneLine(value).toUpperCase(),max=tickerLimit();
  if(!symbol)return'Enter a ticker.';
  if(isRaydium()&&!isRobinhood())return /^[A-Z0-9_]{1,10}$/.test(symbol)?'':'Raydium tickers use only letters, numbers and _, up to 10 characters.';
  return utf8Size(symbol)>max?'The ticker is too long. Use at most '+max+' characters'+BYTES_NOTE+'.':'';
}
/** The coin's name, ticker and description for the current venue; throws a message naming the field. */
function coinDetails(){
  const bytes=!isRaydium()&&!isPumpClassic()||isRobinhood(),limit=bytes&&!isRobinhood()?1000:500;
  const name=oneLine(field('name').value),symbol=oneLine(field('symbol').value).toUpperCase(),description=oneLine(field('description').value);
  if(!name)throw Error('Enter a coin name.');if(utf8Size(name)>32)throw Error('The coin name is too long. Use at most 32 characters'+BYTES_NOTE+'.');
  const ticker=tickerProblem(symbol);if(ticker)throw Error(ticker);
  if((bytes?utf8Size(description):[...description].length)>limit)throw Error('The description is too long. Use at most '+limit.toLocaleString('en-US')+' characters'+(bytes?BYTES_NOTE:'')+'.');
  return{name,symbol,description};
}
/** Website, X and Telegram as https links ("@name" becomes the profile link); throws a message naming the field. */
const coinLinks=raw=>({website:socialLink('website',raw.website),twitter:socialLink('twitter',raw.twitter),telegram:socialLink('telegram',raw.telegram)});
const validateInput=raw=>{assertRaydium();coinDetails();if(!['creator','holders','gotchi','agent','paycheck'].includes(raw.feeMode))throw Error('Choose Creator, Holders, Paycheck, Gotchi or AI Agent for your new launch. Agent buyback is available only for existing coins.');if(raw.feeMode==='paycheck'&&asset.mint!==SOL_MINT)throw Error('Paycheck launches pair with SOL only. Choose SOL as the pair.');if(raw.feeMode==='gotchi'&&!raw.gotchiId)throw Error('Choose a Gotchi to pair your coin with.');if(raw.feeMode==='agent'){if(agentCatalog&&agentCatalog.intakeOpen===false)throw Error('AI Agent launches are closed right now. Choose another reward option.');if(asset.mint!==SOL_MINT)throw Error('AI Agent launches pair with SOL only.');const influencerIssue=influencerProblem();if(influencerIssue)throw Error(influencerIssue);}if(walletOnly&&(raw.walletMode!=='external'||!raw.externalWallet))throw Error('Connect your wallet to launch.');return launchInput(raw,{marketCapPolicy:adminLaunch?'admin':'public'});};
let csrf='',selected=null,launches=[],assets=[],asset=LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),busy=false,loading=null,imageId='',imageName='',imageBusy=false,creating=false,category='all',requestId=crypto.randomUUID(),listVersion='';
let walletAddress='',walletOptionsVersion='',prepareTimer,prepareVersion=0,prepared=null,prepareError='',preparing=false,flow=null,flowVersion=0,progressNote='',announcedId='',actionJob=null,peekHandle=null,peekVersion=0;
let launchSessionAccount='',launchSessionReady=false,launchPollingStarted=false,sessionGeneration=0,imageGeneration=0,automationBusy=false,launchSession=null;
const accountUpdated=event=>{if(!disposed&&event.detail)activateSession(event.detail).catch(e=>{if(!disposed&&!e.cancelled){error(e.message);$('launch-gate-message').textContent=e.message;}});};document.addEventListener('curve-account-updated',accountUpdated);
const signedRequests=new Map(),startedLaunches=new Set();
const walletMode=()=>walletOnly||launchWallet.state().address?'external':'default';
const shortAddress=address=>address.slice(0,5)+'…'+address.slice(-4);
// Transfer hook rules (v71.28) travel as one object, `hook`, only when at least one rule is chosen on Meteora; the
// rule checkboxes and setting fields (hookRule, hook_<rule>_<key>, hookGateMint, hookBlocklist, hookTitheRecipient,
// hookTradingTimezone) never travel on their own.
const rawInput=()=>{const raw={...Object.fromEntries(new FormData(form)),walletMode:walletMode(),externalWallet:launchWallet.state().address,quoteMint:asset.mint,imageId,requestId};for(const key of ['name','symbol','description'])if(typeof raw[key]==='string')raw[key]=oneLine(raw[key]);if(raw.feeMode!=='gotchi')delete raw.gotchiId;for(const key of Object.keys(raw))if(key.startsWith('agent')||key.startsWith('hook')||key.startsWith('influencer')||key.startsWith('basket'))delete raw[key];if(raw.feeMode==='agent')raw.agent=agentSettings();const hook=hookInput();if(hook)raw.hook=hook;return raw;};
// AI Agent settings travel as one normalized object; the venue is the current launch venue.
let agentCatalog=null,agentCatalogPending=null,agentCatalogAt=0;
const agentSettings=()=>({venue:isMeteora()?'meteora':isPumpClassic()?'pump':'raydium',mission:String(field('agentMission')?.value||'').trim(),personalityPreset:String(field('agentPersonalityPreset')?.value||'analyst'),personality:String(field('agentPersonality')?.value||'').trim(),model:String(field('agentModel')?.value||agentCatalog?.defaultModel||''),domains:String(field('agentDomains')?.value||''),buyback:!!field('agentBuyback')?.checked,rewards:!!field('agentRewards')?.checked,objective:agentObjectiveId(),objectiveSettings:agentObjectiveSettings(),influencer:influencerSettings()});
// The objective (v71.27): one catalogue id, and the creator-set program numbers as typed (the catalogue validates them;
// an empty field takes the default, so only numbers travel).
const agentObjectiveId=()=>{const value=String(field('agentObjective')?.value||'custom');return objectiveById(value)?value:'custom';};
const agentObjectiveSettings=()=>{const item=objectiveById(agentObjectiveId()),out={};for(const setting of item?.settings||[]){const input=field('agentObjective_'+setting.key);const value=String(input?.value??'').trim();if(value!=='')out[setting.key]=Number(value);}return out;};
/** The catalogue's complaint about the typed program numbers ('' when they are valid). */
const agentSettingsProblem=()=>{try{normalizeObjectiveSettings(agentObjectiveId(),agentObjectiveSettings());return'';}catch(e){return e?.message||'Check the program settings.';}};
// AI influencer (v71.30): the optional step lives in influencer-ui.mjs and mounts into #launch-influencer-block when the
// module loads; its influencer* inputs travel only as `agent.influencer`. Without the module the launch carries { enabled: false }.
let influencerStep=null;
// Reward baskets (v71.33): the optional step under the holder-reward minimum, mounted from basket-ui.mjs when the module loads.
// Its choice travels only as `basket: [mint, mint]` inside a Meteora holder-rewards launch request.
let basketStep=null,basketCatalogue=null,basketCataloguePending=null,basketCatalogueAt=null;
// Pump.fun (v71.35): a Holders coin may carry the same basket; its extra assets come from the verified pair catalogue (the
// Raydium list, every asset Launchpad can price and route), read once while the step is open; the server checks each one again.
const basketVenue=()=>isMeteora()?'meteora':isPumpClassic()?'pump-classic':'';
const basketsEnabled=()=>(isMeteora()&&meteoraAllowed()&&meteoraStatus?.basketsEnabled===true||isPumpClassic()&&pumpClassicAllowed()&&pumpClassicStatus?.basketsEnabled===true&&(pumpClassicStatus.basketModes||['holders']).includes(field('feeMode').value))&&field('feeMode').value==='holders';
const basketAssets=()=>isPumpClassic()?(basketCatalogue||[]):assets;
function refreshBasketCatalogue(){
  if(disposed||!csrf||!launchSessionReady||!isPumpClassic()||!basketsEnabled())return Promise.resolve();
  if(basketCataloguePending)return basketCataloguePending;if(basketCatalogueAt!==null&&Date.now()-basketCatalogueAt<300000)return Promise.resolve();
  const generation=sessionGeneration;
  basketCataloguePending=api('/quotes').then(r=>{if(disposed||generation!==sessionGeneration)return;const rows=Array.isArray(r?.assets)?r.assets:[];basketCatalogue=rows.filter(a=>a&&typeof a.mint==='string'&&a.mint!==SOL_MINT&&a.supported===true).map(a=>({mint:a.mint,symbol:a.symbol,name:a.name,decimals:a.decimals,category:a.category,issuer:a.issuer,launchReady:true}));basketCatalogueAt=Date.now();syncForm();}).catch(()=>{basketCatalogueAt=Date.now()-240000;}).finally(()=>{basketCataloguePending=null;});
  return basketCataloguePending;
}
const basketExtras=()=>basketStep?basketStep.extras():[];
const basketProblem=()=>basketStep&&basketStep.extras().length?basketStep.problem():'';
const basketBlocked=()=>!!basketVenue()&&basketExtras().length>0&&(field('feeMode').value!=='holders'||!!basketProblem());
void import('./basket-ui.mjs').then(module=>{if(disposed||basketStep)return;basketStep=module.createBasketStep({document,form,root:$('launch-basket'),assets:basketAssets,main:()=>asset,enabled:basketsEnabled,venue:()=>isPumpClassic()?'Pump.fun':'Meteora',onChange:()=>{if(!disposed)syncForm();}});syncForm();}).catch(()=>{});
const influencerSettings=()=>influencerStep?influencerStep.settings():{enabled:false};
const influencerProblem=()=>influencerStep?influencerStep.problem():'';
void import('./influencer-ui.mjs').then(module=>{if(disposed||influencerStep)return;influencerStep=module.createInfluencerStep({document,window,form,root:$('launch-influencer-block'),fetcher:pageFetch,token:()=>csrf,catalog:()=>agentCatalog,coin:()=>({name:oneLine(field('name').value),symbol:oneLine(field('symbol').value).toUpperCase()}),setTimer:(fn,ms)=>setInterval(fn,ms),clearTimer:id=>clearInterval(id)});syncForm();}).catch(()=>{});
const agentFundingSol=()=>{const value=Number(field('agentFundingSol')?.value||0);return Number.isFinite(value)&&value>0?value:0;};
async function loadAgentCatalog(){
  if(agentCatalog&&Date.now()-agentCatalogAt<300000)return agentCatalog;if(agentCatalogPending)return agentCatalogPending;
  agentCatalogPending=pageFetch('/api/launchpad/agents/catalog',{method:'GET'}).then(async response=>{const data=await response.json();if(!response.ok)throw Object.assign(Error(data?.error||'AI Agent mode is unavailable right now.'),{status:response.status});agentCatalog=data;agentCatalogAt=Date.now();syncAgentSettings(true);syncForm();return data;}).catch(error=>{if(!disposed&&!error.cancelled){agentCatalog={intakeOpen:false,models:[],unavailable:true,reason:error.status===503?'AI Agent mode is not enabled on this host.':error.message};syncAgentSettings(true);syncForm();}return null;}).finally(()=>{agentCatalogPending=null;});
  return agentCatalogPending;
}
// ---- AI Agent settings (v71.27): personality cards, the objective picker with its program settings and capability
// locks, and the model picker grouped by provider. Field names stay agentPersonalityPreset, agentPersonality,
// agentMission, agentObjective (+ agentObjective_<key>), agentModel, agentDomains, agentBuyback and agentRewards.
let agentSettingsBuilt=false,agentModelsBuilt=false,agentModelsOpen=false,agentSettingsFor='';
// What the creator chose for the two financial capabilities, apart from what an objective ticked for them.
const agentCapUser={buyback:null,rewards:null},agentCapAuto={buyback:false,rewards:false};
const AGENT_PROVIDER_NAMES=Object.freeze({openai:'OpenAI',anthropic:'Anthropic',google:'Google','x-ai':'xAI',xai:'xAI',qwen:'Qwen',deepseek:'DeepSeek',mistralai:'Mistral',mistral:'Mistral',moonshotai:'Moonshot','moonshot-ai':'Moonshot',minimax:'MiniMax','z-ai':'Z.ai',zai:'Z.ai','meta-llama':'Meta',meta:'Meta',cohere:'Cohere',perplexity:'Perplexity',amazon:'Amazon',microsoft:'Microsoft',nvidia:'NVIDIA'});
const agentModelProvider=model=>String(model.provider||String(model.id||'').split('/')[0]||'other').toLowerCase();
const agentModelProviderName=model=>model.providerName||AGENT_PROVIDER_NAMES[agentModelProvider(model)]||agentModelProvider(model).replace(/[-_]+/g,' ').replace(/\b\p{Ll}/gu,letter=>letter.toUpperCase());
// A row without the registry's `available` flag counts as available while it is neither unavailable nor stale.
const agentModelAvailable=model=>model.available===undefined?!model.unavailable&&!model.stale:model.available===true;
const agentPrice=value=>{const n=Number(value);if(value==null||value===''||!Number.isFinite(n))return null;return'$'+n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:n>0&&n<0.01?4:2});};
const agentModelPriceText=model=>{const input=agentPrice(model.promptUsdPerMillion),output=agentPrice(model.completionUsdPerMillion);return input&&output?input+' in / '+output+' out per 1M tokens':'Price unavailable';};
const agentContextText=model=>{const n=Number(model.contextLength);return Number.isFinite(n)&&n>0?(n>=1000000?(n/1000000).toLocaleString(undefined,{maximumFractionDigits:1})+'M':Math.round(n/1000)+'k')+' context':'';};
const AGENT_TAG_TITLES=Object.freeze({fast:'Fast: quick, inexpensive runs.',balanced:'Balanced: a good default for research and updates.',deep:'Deep: slower, more thorough reasoning per run.'});
const agentLabel=(tag,text,cls)=>{const e=node(tag,text);if(cls)e.className=cls;return e;};
function agentChoice({name,value,checked,title,titleChip=null,copy,chips=[],extra=''}){
  const label=agentLabel('label',null,'launch-agent-choice'+(extra?' '+extra:''));const input=node('input');input.type='radio';input.setAttribute('name',name);input.name=name;input.value=value;input.checked=!!checked;
  const body=agentLabel('span',null,'launch-agent-choice-copy'),heading=agentLabel('strong',title,'launch-agent-choice-title');if(titleChip){const row=agentLabel('span',null,'launch-agent-choice-head');row.append(heading,titleChip);body.append(row);}else body.append(heading);if(copy)body.append(agentLabel('small',copy,'launch-agent-choice-text'));
  if(chips.length){const row=agentLabel('span',null,'launch-agent-chips');for(const chip of chips)row.append(chip);body.append(row);}
  label.append(input,body);return label;
}
const agentChip=(text,tone='',title='')=>{const chip=agentLabel('span',text,'cv-pill'+(tone?' '+tone:''));if(title)chip.title=title;return chip;};
function buildAgentPersonalities(){
  const host=$('launch-agent-personalities'),current=String(field('agentPersonalityPreset')?.value||'analyst');host.replaceChildren();
  for(const row of AGENT_PERSONALITIES)host.append(agentChoice({name:'agentPersonalityChoice',value:row.id,checked:row.id===current,title:row.name,copy:row.voice,extra:'launch-agent-personality'+(row.id==='custom'?' is-custom':'')}));
}
function buildAgentObjectives(){
  const host=$('launch-agent-objectives'),current=agentObjectiveId();host.replaceChildren();
  for(const group of AGENT_OBJECTIVE_GROUPS){
    const section=agentLabel('div',null,'launch-agent-objective-group');section.dataset.group=group.id;
    const head=agentLabel('div',null,'launch-agent-group-head');head.append(agentLabel('h4',group.name),agentLabel('p',group.summary));
    const grid=agentLabel('div',null,'launch-agent-choices launch-agent-objective-grid');
    for(const item of AGENT_OBJECTIVES.filter(row=>row.group===group.id)){
      const chips=[];
      if(item.program)chips.push(agentChip(item.program.action==='limiter'?'Limiter':'Program','is-accent',item.program.rule));
      chips.push(item.program?.action==='limiter'?agentChip('Model proposes, capped','','The model proposes treasury actions; the limiter allows one at a time and the policy caps each one.'):agentChip(item.spends?'Spends treasury':'No spending',item.spends?'is-warn':'',item.spends?'The program can move treasury SOL, inside every policy cap.':'This objective never moves treasury on its own.'));
      const choice=agentChoice({name:'agentObjectiveChoice',value:item.id,checked:item.id===current,title:item.name,copy:item.summary,chips,extra:'launch-agent-objective'});choice.dataset.objective=item.id;grid.append(choice);
    }
    section.append(head,grid);host.append(section);
  }
}
/** Program settings for the chosen objective: a number field with a slider, or a segmented control for fixed options. Rebuilt only when the objective changes, so typed values survive. */
function buildAgentObjectiveSettings(item){
  const host=$('launch-agent-objective-settings');if(agentSettingsFor===item.id)return;agentSettingsFor=item.id;host.replaceChildren();host.hidden=!item.settings.length;
  for(const setting of item.settings){
    const row=agentLabel('div',null,'launch-agent-setting'),name='agentObjective_'+setting.key;row.dataset.setting=setting.key;
    const head=agentLabel('div',null,'launch-agent-setting-head'),title=agentLabel(setting.options?'span':'label',setting.label,'launch-agent-setting-label');title.id='launch-agent-setting-'+setting.key;head.append(title);
    if(setting.options){
      const hidden=node('input');hidden.type='hidden';hidden.setAttribute('name',name);hidden.name=name;hidden.id=name;hidden.value=String(setting.value);
      const seg=agentLabel('div',null,'cv-segmented launch-agent-segmented');seg.setAttribute('role','group');seg.setAttribute('aria-labelledby',title.id);
      for(const option of setting.options){const button=node('button',option+(setting.unit?' '+setting.unit:''));button.type='button';button.dataset.value=String(option);button.setAttribute('aria-pressed',String(option===setting.value));button.addEventListener('click',()=>{hidden.value=String(option);for(const other of seg.querySelectorAll('button'))other.setAttribute('aria-pressed',String(other===button));hidden.dispatchEvent(new Event('change',{bubbles:true}));});seg.append(button);}
      row.append(head,hidden,seg);
    }else{
      const value=agentLabel('output',setting.value+(setting.unit?' '+setting.unit:''),'launch-agent-setting-value');value.setAttribute('for',name);head.append(value);
      const fieldBox=agentLabel('div',null,'launch-agent-setting-field');
      const range=node('input');range.type='range';range.id=name+'_range';range.min=String(setting.min);range.max=String(setting.max);range.step=String(setting.step);range.value=String(setting.value);range.setAttribute('aria-label',setting.label);
      const number=node('input');number.type='number';number.setAttribute('name',name);number.name=name;number.id=name;title.htmlFor=name;number.min=String(setting.min);number.max=String(setting.max);number.step=String(setting.step);number.value=String(setting.value);number.inputMode='decimal';number.setAttribute('aria-describedby','launch-agent-setting-'+setting.key+'-range');
      const unit=agentLabel('span',setting.unit||'','launch-agent-setting-unit');
      const limits=agentLabel('span',setting.min+'–'+setting.max+(setting.unit?' '+setting.unit:'')+(setting.hint?' · '+setting.hint:''),'launch-agent-setting-range');limits.id='launch-agent-setting-'+setting.key+'-range';
      // The slider and the number field are one value; the slider is the quick way, the field the exact one.
      range.addEventListener('input',()=>{number.value=range.value;value.textContent=range.value+(setting.unit?' '+setting.unit:'');});
      number.addEventListener('input',()=>{if(number.value!=='')range.value=number.value;value.textContent=(number.value||'—')+(setting.unit?' '+setting.unit:'');});
      const box=agentLabel('div',null,'launch-agent-setting-number');box.append(number,unit);fieldBox.append(range,box);row.append(head,fieldBox,limits);
    }
    host.append(row);
  }
}
/** The capability boxes follow the objective: a needed capability is ticked and locked (with the reason), `anyOf` keeps at least one on, and the creator's own choices return when an objective no longer needs them. */
function syncAgentCapabilities(item){
  const needs=item.program?item.needs:[],note=$('launch-agent-capability-note');let changed=false;
  for(const cap of ['buyback','rewards']){
    const input=$('launch-agent-'+cap),label=input.closest('label'),lock=label.querySelector('[data-agent-lock]'),locked=needs.includes(cap)&&!item.anyOf;
    if(locked){if(!input.checked||!input.disabled)changed=true;input.checked=true;input.disabled=true;label.classList.add('is-locked');lock.textContent='Needed by '+item.name+'.';lock.hidden=false;}
    else{
      if(input.disabled){input.disabled=false;input.checked=agentCapUser[cap]===true;changed=true;}
      else if(agentCapAuto[cap]&&!(item.program&&item.anyOf)){input.checked=agentCapUser[cap]===true;agentCapAuto[cap]=false;changed=true;}
      label.classList.remove('is-locked');lock.hidden=true;lock.textContent='';
    }
  }
  if(item.program&&item.anyOf){const first=$('launch-agent-'+item.needs[0]);if(!item.needs.some(cap=>$('launch-agent-'+cap).checked)){first.checked=true;agentCapAuto[item.needs[0]]=true;changed=true;}note.textContent=item.name+' needs '+(item.needs.includes('buyback')&&item.needs.includes('rewards')?'buy-and-burn or holder rewards':item.needs[0]==='buyback'?'buy-and-burn':'holder rewards')+': keep at least one on.';note.hidden=false;}
  else note.hidden=true;
  return changed;
}
const agentProgramText=item=>item.program?item.program.rule+(item.program.action==='limiter'?'':' The platform runs it on its own schedule; the model cannot change it, and every proposal passes the policy caps.'):item.id==='custom'?'Nothing on its own: the model decides within the policy, with no program.':'No program: the agent researches, remembers and posts. It never moves treasury on its own.';
function syncAgentObjective(){
  const item=objectiveById(agentObjectiveId())||objectiveById('custom');
  for(const label of $('launch-agent-objectives').querySelectorAll('.launch-agent-objective'))label.classList.toggle('is-selected',label.dataset.objective===item.id);
  buildAgentObjectiveSettings(item);
  $('launch-agent-objective-rule-text').textContent=agentProgramText(item);$('launch-agent-objective-rule').dataset.kind=item.program?item.program.action==='limiter'?'limiter':'program':'none';
  const problem=agentSettingsProblem(),error=$('launch-agent-objective-error');error.textContent=problem;error.hidden=!problem;
  for(const setting of item.settings){const input=field('agentObjective_'+setting.key);if(input?.setAttribute)input.setAttribute('aria-invalid',String(!!problem&&problem.startsWith(setting.label)));}
  return item;
}
/** The chosen objective's default mission fills an empty mission, or replaces another objective's untouched default; typed text is never replaced. */
function syncAgentMission(item){
  const mission=$('launch-agent-mission'),current=mission.value.trim(),defaults=new Set(AGENT_OBJECTIVES.map(row=>row.mission.trim()).filter(Boolean));
  if(current!==''&&!defaults.has(current))return;
  if(current===item.mission.trim())return;
  mission.value=item.mission;syncAgentMissionCount();
}
function syncAgentMissionCount(){$('launch-agent-mission-count').textContent=$('launch-agent-mission').value.length.toLocaleString()+' / '+AGENT_LIMITS.missionChars.toLocaleString();}
function buildAgentModels(){
  const host=$('launch-agent-models'),hidden=$('launch-agent-model');host.replaceChildren();agentModelsBuilt=!!agentCatalog;
  const all=(agentCatalog?.models||[]).filter(model=>model&&model.id);let rows=all.filter(agentModelAvailable);const fallback=!rows.length&&all.length>0;if(fallback)rows=all;
  const ids=new Set(rows.map(model=>model.id)),preferred=ids.has(agentCatalog?.defaultModel)?agentCatalog.defaultModel:rows[0]?.id||'';
  hidden.value=ids.has(hidden.value)?hidden.value:preferred;
  if(fallback){const note=agentLabel('p','Live pricing is unavailable right now, so prices are not shown. Every listed model can still be chosen; the platform checks it again at launch.','launch-agent-models-note');note.setAttribute('role','status');host.append(note);}
  const groups=new Map();for(const model of rows){const key=agentModelProviderName(model);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(model);}
  for(const [provider,models] of groups){
    const section=agentLabel('section',null,'launch-agent-model-group');section.dataset.provider=provider;section.append(agentLabel('h4',provider,'launch-agent-model-provider'));
    const grid=agentLabel('div',null,'launch-agent-choices launch-agent-model-grid');
    for(const model of models){
      const context=agentContextText(model),priced=!!agentPrice(model.promptUsdPerMillion);
      const choice=agentChoice({name:'agentModelChoice',value:model.id,checked:model.id===hidden.value,title:model.name||model.id,titleChip:model.tag?agentChip(model.tag,'is-accent',AGENT_TAG_TITLES[model.tag]||''):null,copy:agentModelPriceText(model)+(context?' · '+context:''),extra:'launch-agent-model'+(priced?'':' is-unpriced')});choice.dataset.model=model.id;choice.dataset.provider=provider;grid.append(choice);
    }
    section.append(grid);host.append(section);
  }
  if(!rows.length)host.append(agentLabel('p',agentCatalog?'No model is offered on this host right now. The platform owner configures the list.':'Checking the model list…','launch-agent-models-note'));
  syncAgentModelCurrent(rows);
}
function syncAgentModelCurrent(rows){
  const host=$('launch-agent-model-current'),hidden=$('launch-agent-model'),model=rows.find(row=>row.id===hidden.value)||null;host.replaceChildren();
  const copy=agentLabel('div',null,'launch-agent-model-copy');copy.append(agentLabel('span','Selected model','launch-agent-model-eyebrow'));
  if(model){
    const title=agentLabel('div',null,'launch-agent-model-title');title.append(agentLabel('strong',model.name||model.id),agentLabel('span','· '+agentModelProviderName(model),'launch-agent-model-vendor'));if(model.tag)title.append(agentChip(model.tag,'is-accent',AGENT_TAG_TITLES[model.tag]||''));copy.append(title);
    const meta=agentLabel('small',agentModelPriceText(model)+(agentContextText(model)?' · '+agentContextText(model):'')+(model.supportsTools===false?' · no tool calls':''),'launch-agent-model-meta'+(agentPrice(model.promptUsdPerMillion)?'':' is-missing'));copy.append(meta);
  }else copy.append(agentLabel('strong',agentCatalog?'No model available':'Checking the model list…'),agentLabel('small',agentCatalog?'The platform owner configures the model list.':'Models are listed with live prices per 1M tokens.','launch-agent-model-meta'));
  host.append(copy);
  if(rows.length>1||rows.length===1&&agentModelsOpen){const toggle=node('button',agentModelsOpen?'Hide models':'Change model');toggle.type='button';toggle.className='small-button cv-sm launch-agent-model-toggle';toggle.setAttribute('aria-expanded',String(agentModelsOpen));toggle.setAttribute('aria-controls','launch-agent-models');toggle.addEventListener('click',()=>{agentModelsOpen=!agentModelsOpen;$('launch-agent-models').hidden=!agentModelsOpen;syncAgentModelCurrent(rows);if(agentModelsOpen)$('launch-agent-models').querySelector('input:checked')?.focus?.({preventScroll:true});});host.append(toggle);}
  $('launch-agent-models').hidden=!agentModelsOpen||!rows.length;
  for(const label of $('launch-agent-models').querySelectorAll('.launch-agent-model'))label.classList.toggle('is-selected',label.dataset.model===hidden.value);
}
/** Reacts to the picker inputs before the form-wide change handler reads the settings (listeners on the block run first). */
function agentSettingsInput(event){
  const target=event.target;if(!target||!target.name)return;
  if(target.name==='agentPersonalityChoice'&&target.checked){$('launch-agent-preset').value=target.value;$('launch-agent-custom-wrap').hidden=target.value!=='custom';if(target.value==='custom'&&event.type==='change')$('launch-agent-personality').focus?.({preventScroll:true});}
  else if(target.name==='agentObjectiveChoice'&&target.checked){const previous=agentObjectiveId();$('agentObjective').value=target.value;if(target.value!==previous){const item=syncAgentObjective();syncAgentMission(item);syncAgentCapabilities(item);}}
  else if(target.name==='agentModelChoice'&&target.checked){$('launch-agent-model').value=target.value;syncAgentModelCurrent((agentCatalog?.models||[]).filter(agentModelAvailable).length?(agentCatalog.models||[]).filter(agentModelAvailable):agentCatalog?.models||[]);}
  else if(target.name==='agentBuyback'||target.name==='agentRewards'){const cap=target.name==='agentBuyback'?'buyback':'rewards',item=objectiveById(agentObjectiveId());agentCapUser[cap]=target.checked;agentCapAuto[cap]=false;if(item?.program&&item.anyOf&&!item.needs.some(name=>$('launch-agent-'+name).checked)){target.checked=true;agentCapAuto[cap]=true;const note=$('launch-agent-capability-note');note.hidden=false;restartClass(note,'is-nudged',600);}}
  else if(target.name==='agentMission')syncAgentMissionCount();
  if(target.name.startsWith('agentObjective_'))syncAgentObjective();
}
function syncAgentSettings(rebuild=false){
  const wrap=$('launch-agent-settings');if(!wrap)return;
  if(!agentSettingsBuilt){agentSettingsBuilt=true;buildAgentPersonalities();buildAgentObjectives();wrap.addEventListener('input',agentSettingsInput);wrap.addEventListener('change',agentSettingsInput);syncAgentMissionCount();syncAgentCapabilities(syncAgentObjective());}
  if(rebuild||!agentModelsBuilt)buildAgentModels();
  $('launch-agent-custom-wrap').hidden=String(field('agentPersonalityPreset')?.value||'analyst')!=='custom';
  const status=$('launch-agent-status');if(!agentCatalog)status.textContent='Checking AI Agent availability…';else if(agentCatalog.unavailable)status.textContent=agentCatalog.reason||'AI Agent mode is unavailable on this host.';else if(!agentCatalog.intakeOpen)status.textContent='AI Agent launches are closed right now. The platform owner can reopen intake.';else status.textContent=(agentCatalog.dryRun?'Dry-run mode: runs use a mock model and are labelled as such. ':'')+(agentCatalog.domainAllowlist?.length?'Vetted research domains: '+agentCatalog.domainAllowlist.join(', ')+'.':'No research domains are vetted yet; browsing stays off until the owner approves some.');
  status.dataset.state=agentCatalog&&(agentCatalog.unavailable||!agentCatalog.intakeOpen)?'closed':'open';
  // The example domains are the platform's own vetted ones, never a site it may not allow.
  $('launch-agent-domains').placeholder=agentCatalog?.domainAllowlist?.length?agentCatalog.domainAllowlist.slice(0,2).join(', ')+' (max 10)':'Vetted domains only (max 10)';
  $('launch-agent-fee-source').textContent=(isMeteora()?AGENT_FUNDING_SUMMARY.meteora:isPumpClassic()?AGENT_FUNDING_SUMMARY.pump:AGENT_FUNDING_SUMMARY.raydium)+(isPumpClassic()?' The fee-sharing assignment is locked when the coin is created and cannot be redirected.':' The assignment is written into the coin permanently and cannot be redirected.');
}
// ---- Transfer hook rules (v71.28): Meteora only, offered when the host enables them (`hooksEnabled` in the venue
// status). The catalogue's seven groups of rule cards (checkboxes, up to HOOK_MAX_RULES; a catalogue conflict disables
// the other card with the reason; every card carries its route badge, "Trades anywhere" or "Launchpad route only"), the
// chosen rules' settings (slider + exact field, segmented options with their labels, rows that apply only at some level
// or mode, weekday chips, hh:mm and time-zone pickers, the gate token mint, the blocklist and the tithe recipient), a
// live "what the program will enforce" list with the route line, and the catalogue's own validation
// (hookLaunchRequest). Field names stay hookRule, hook_<rule>_<key>, hookGateMint, hookBlocklist and
// hookTitheRecipient; rawInput() folds them into one `hook` object.
let hooksBuilt=false,hookSettingsBuilt=new Map(),hooksOpen=false;
const hooksEnabled=()=>isRobinhood()?robinhoodMarket?.allowed()===true:isMeteora()&&meteoraAllowed()&&meteoraStatus?.hooksEnabled===true;
/** Rules Launchpad's rule engine runs on Robinhood Chain: every catalogue rule but priority-fee / tip caps (Solana fees) and app-only rules. */
// Robinhood Chain (v71.41): the pool is a plain Uniswap v4 pool, so the rules that read a Solana transaction (sniper-fee cap),
// need a Solana app (app-only routes) or ride on an instruction only Launchpad's own route adds (the tithe) are not offered there.
const hookOnChain=item=>!isRobinhood()||item.kind!==21&&item.kind!==25&&item.route!=='app';
const hookSelected=()=>[...form.querySelectorAll('input[name=hookRule]:checked')].map(input=>input.value);
const hookChosen=()=>hooksEnabled()&&hookSelected().length>0;
/** An app-only rule (v71.36) is offered only when the host names that app's mark (`hookApps` in the venue status: { kind, key, index, text } per app, else null). */
const hookAppOffered=item=>item?.route!=='app'||!!(meteoraStatus?.hookApps?.[item.app]&&(typeof meteoraStatus.hookApps[item.app]==='object'?meteoraStatus.hookApps[item.app].key:meteoraStatus.hookApps[item.app]));
/** Every typed number of one rule, by key (an empty field is absent). */
function hookTypedValues(id){
  const item=hookRuleById(id),out={};if(!item)return out;
  for(const setting of item.settings){const input=field('hook_'+id+'_'+setting.key),value=String(input?.value??'').trim();if(value!=='')out[setting.key]=Number(value);}
  return out;
}
/** Whether a setting row applies given the rule's current values (`when`: a level count or 'key:value'); an absent value takes the catalogue default. */
function hookSettingVisible(item,setting,typed){
  if(setting.when===null||setting.when===undefined)return true;
  const values={};for(const row of item.settings)values[row.key]=typed[row.key]??row.value;
  return hookSettingApplies(setting,values);
}
/** The typed numbers of one rule that apply (an empty field takes the catalogue default, so only numbers travel; a row hidden by `when` never travels). */
function hookSettingsFor(id){
  const item=hookRuleById(id),out={};if(!item)return out;const typed=hookTypedValues(id);
  for(const setting of item.settings)if(setting.key in typed&&hookSettingVisible(item,setting,typed))out[setting.key]=typed[setting.key];
  return out;
}
/** The blocklist textarea as addresses: one per line or comma-separated, deduplicated; a line that is not an address stays so the catalogue names it. */
function hookBlocklistEntries(){
  const seen=new Set(),out=[];
  for(const raw of String(field('hookBlocklist')?.value??'').split(/[\s,;]+/)){const line=raw.trim();if(line&&!seen.has(line)){seen.add(line);out.push(line);}}
  return out;
}
/** The creator's hook choice as the server reads it: `{ rules: [{ id, settings }], gateMint?, blocklist?, titheRecipient? }`, or null when no rule is chosen. */
function hookInput(){
  if(!hooksEnabled())return null;const ids=hookSelected();if(!ids.length)return null;
  const input={rules:ids.map(id=>({id,settings:hookSettingsFor(id)}))};
  if(ids.includes('holder_gated'))input.gateMint=String(field('hookGateMint')?.value||'').trim();
  if(ids.includes('blocklist'))input.blocklist=hookBlocklistEntries();
  if(ids.includes('tithe'))input.titheRecipient=String(field('hookTitheRecipient')?.value||'').trim();
  return input;
}
/** The catalogue's complaint about the chosen rules and numbers ('' when they are valid or no rule is chosen). */
function hookProblem(){
  const input=hookInput();if(!input)return '';
  if(isRobinhood()){const off=input.rules.map(r=>hookRuleById(r.id)).find(item=>item&&!hookOnChain(item));if(off)return off.name+' is not available on Robinhood Chain.';}
  try{hookLaunchRequest(input,isRobinhood()?{address:/^0x[0-9a-fA-F]{40}$/}:{});return '';}catch(e){const text=e?.message||'Check the transfer hook rules.';return /Trading hours: (Days must be|choose the days)/.test(text)?'Trading hours: choose at least one day.':text;}
}
const hookBlocked=()=>hookChosen()&&(field('feeMode').value==='agent'||!!hookProblem());
/** A hooked Meteora launch: rules chosen now, or a saved three-approval setup being continued (its first buy is a separate trade either way). */
const hookedMeteoraLaunch=()=>hookChosen()||isMeteora()&&(meteoraController?.operation?.review?.stages===3||meteoraController?.operation?.review?.stage==='hook-setup');
/** The chosen rule a card cannot be combined with (null when it can): the catalogue's conflict pairs decide. */
function hookConflict(item,selected){
  for(const id of selected){if(id!==item.id&&hookRulesConflict(item.id,id))return hookRuleById(id);}
  return null;
}
/** 'app' when a chosen rule locks trades to an outside app, 'curve' when any chosen rule needs accounts (or a payment) only Launchpad adds to a trade, else 'any'. */
const hookRoute=ids=>ids.some(id=>hookRuleById(id)?.route==='app')?'app':ids.some(id=>hookRuleById(id)?.route==='curve')?'curve':'any';
const hookAppRule=ids=>ids.map(id=>hookRuleById(id)).find(item=>item?.route==='app')||null;
/** The route badge of a rule or a rule set, with the catalogue's explanation in its title. */
function hookRouteChip(route){
  const info=HOOK_ROUTES[route]||HOOK_ROUTES.any,chip=agentLabel('span',info.name,'cv-pill launch-hook-route'+(route==='curve'?' is-curve':route==='app'?' is-app':''));chip.dataset.route=info.id;chip.title=info.text;chip.setAttribute('aria-label','Route: '+info.name+'. '+info.text);return chip;
}
/** The route line of the enforce list: what the chosen rules mean for where the coin trades before graduation. */
function hookRouteLine(ids){
  const app=hookAppRule(ids);if(app)return 'Trades only in '+app.appName+' until graduation: '+app.name+' allows pool trades only when the transaction carries the '+app.appName+' app’s mark (its co-signing wallet, or the swap it builds), so Launchpad’s Buy and Sell (and every other route) are off for this coin while it is on the curve. Holders trade it in '+app.appName+'; after graduation it trades anywhere, Launchpad included.';
  const names=ids.map(id=>hookRuleById(id)).filter(item=>item?.route==='curve').map(item=>item.name);
  if(!names.length)return HOOK_ROUTES.any.text;
  return 'Trades on Launchpad only until graduation: '+names.join(', ').replace(/, ([^,]+)$/,' and $1')+' need'+(names.length===1?'s':'')+' an account per wallet or a payment that only Launchpad adds to a trade, so other routers cannot trade it while it is on the curve. Trades anywhere after graduation.';
}
function hookRuleCard(item){
  const label=agentLabel('label',null,'launch-agent-choice launch-hook-rule'),input=node('input');input.type='checkbox';input.setAttribute('name','hookRule');input.name='hookRule';input.value=item.id;label.dataset.rule=item.id;label.dataset.route=item.route;
  const body=agentLabel('span',null,'launch-agent-choice-copy');body.append(agentLabel('strong',item.name,'launch-agent-choice-title'),agentLabel('small',item.summary,'launch-agent-choice-text'));
  const chips=agentLabel('span',null,'launch-agent-chips');chips.append(hookRouteChip(item.route));body.append(chips);
  body.append(agentLabel('small','','launch-hook-rule-block'));label.append(input,body);return label;
}
function buildHookGroups(){
  const host=$('launch-hooks-groups');host.replaceChildren();
  for(const group of HOOK_GROUPS){
    const section=agentLabel('div',null,'launch-agent-objective-group launch-hook-group');section.dataset.group=group.id;
    const head=agentLabel('div',null,'launch-agent-group-head');head.append(agentLabel('h4',group.name),agentLabel('p',group.summary));
    const grid=agentLabel('div',null,'launch-agent-choices launch-hook-grid');grid.setAttribute('role','group');grid.setAttribute('aria-label',group.name);
    for(const item of HOOK_RULES.filter(row=>row.group===group.id))grid.append(hookRuleCard(item));
    section.append(head,grid);host.append(section);
  }
  const anyCount=HOOK_RULES.filter(item=>item.route==='any').length,appCount=HOOK_RULES.filter(item=>item.route==='app').length,curveCount=HOOK_RULES.length-anyCount-appCount;
  $('launch-hooks-hint').textContent='Optional · Meteora only · up to '+HOOK_MAX_RULES+' of '+HOOK_RULES.length+' rules';
  $('launch-hooks-routes').textContent=anyCount+' rules are marked “'+HOOK_ROUTES.any.name+'”: '+HOOK_ROUTES.any.text+' '+curveCount+' are marked “'+HOOK_ROUTES.curve.name+'”: '+HOOK_ROUTES.curve.text+' '+appCount+' are marked “'+HOOK_ROUTES.app.name+'”: '+HOOK_ROUTES.app.text;
  $('launch-hooks-enforce-note').textContent='“'+HOOK_ROUTES.any.name+'” rules read only the coin’s own on-chain records. “'+HOOK_ROUTES.curve.name+'” rules need an account per wallet (or a payment only Launchpad adds), so the coin trades on Launchpad until it graduates. “'+HOOK_ROUTES.app.name+'” rules (FOMO-only, Pump App-only) allow pool trades only when the transaction carries that app’s mark, so Launchpad’s own Buy and Sell are off for the coin until it graduates. The pool, your creator wallet and Launchpad’s fee wallets are never blocked, so fees and graduation always settle.';
  const offered=$('launch-hooks-not-offered-list');offered.replaceChildren();
  for(const row of HOOK_NOT_OFFERED){const item=agentLabel('div',null,'launch-hooks-not-offered-row');item.append(agentLabel('dt',row.name),agentLabel('dd',row.why));offered.append(item);}
}
const hookHhmm=minute=>String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');
const hookTzLabel=zone=>{if(!zone.offset&&!zone.dst)return zone.name;const sign=zone.offset<0?'−':'+',a=Math.abs(zone.offset);return zone.name+' (UTC'+(zone.offset?sign+String(Math.floor(a/60)).padStart(2,'0')+':'+String(a%60).padStart(2,'0'):'')+(zone.dst===1?', US daylight saving':zone.dst===2?', EU daylight saving':'')+')';};
/** A hidden form field carrying one setting's value (segmented controls, day chips and the time-zone picker write it). */
function hookHiddenField(name,value){const hidden=node('input');hidden.type='hidden';hidden.setAttribute('name',name);hidden.name=name;hidden.id=name;hidden.value=String(value);return hidden;}
/** A select listing minutes of the day as hh:mm (Trading hours opens / closes; 24:00 is the end of the day). */
function hookTimeSelect(name,setting){
  const select=node('select');select.setAttribute('name',name);select.name=name;select.id=name;select.className='launch-hook-time';
  for(let minute=setting.min;minute<=setting.max;minute+=setting.step){const option=node('option',hookHhmm(minute));option.value=String(minute);if(minute===setting.value){option.setAttribute('selected','');option.selected=true;}select.append(option);}
  return select;
}
/** One setting as the agent program settings render them: a slider with an exact field, a segmented control for fixed options (with the catalogue's labels), seven day chips for the weekday mask, hh:mm selects for minutes of the day. */
function hookSettingRow(id,setting){
  const row=agentLabel('div',null,'launch-agent-setting launch-hook-setting'),name='hook_'+id+'_'+setting.key;row.dataset.setting=setting.key;if(setting.when!==null&&setting.when!==undefined)row.dataset.when=String(setting.when);
  const head=agentLabel('div',null,'launch-agent-setting-head'),title=agentLabel(setting.options||setting.key==='weekdays'?'span':'label',setting.label,'launch-agent-setting-label');title.id='launch-hook-setting-'+id+'-'+setting.key;head.append(title);
  if(setting.key==='weekdays'){
    const hidden=hookHiddenField(name,setting.value);
    const days=agentLabel('div',null,'launch-hook-days');days.setAttribute('role','group');days.setAttribute('aria-labelledby',title.id);
    const paint=()=>{const mask=Number(hidden.value)||0;for(const button of days.querySelectorAll('button'))button.setAttribute('aria-pressed',String(!!(mask&(1<<Number(button.dataset.day)))));};
    WEEKDAYS.forEach((day,index)=>{const button=node('button',day);button.type='button';button.dataset.day=String(index);button.addEventListener('click',()=>{hidden.value=String((Number(hidden.value)||0)^(1<<index));paint();hidden.dispatchEvent(new Event('change',{bubbles:true}));});days.append(button);});
    paint();row.append(head,hidden,days,agentLabel('span','The days, in the chosen time zone, on which pool trades are allowed.','launch-agent-setting-range'));return row;
  }
  if(setting.unit==='hh:mm'){
    const select=hookTimeSelect(name,setting);title.htmlFor=name;select.setAttribute('aria-describedby',title.id+'-range');
    const limits=agentLabel('span',hookHhmm(setting.min)+'–'+hookHhmm(setting.max)+(setting.hint?' · '+setting.hint:''),'launch-agent-setting-range');limits.id=title.id+'-range';
    row.append(head,select,limits);return row;
  }
  if(setting.options){
    const hidden=hookHiddenField(name,setting.value);
    const seg=agentLabel('div',null,'cv-segmented launch-agent-segmented');seg.setAttribute('role','group');seg.setAttribute('aria-labelledby',title.id);
    setting.options.forEach((option,index)=>{const button=node('button',setting.labels?.[index]??(option+(setting.unit?' '+setting.unit:'')));button.type='button';button.dataset.value=String(option);button.setAttribute('aria-pressed',String(option===setting.value));button.addEventListener('click',()=>{hidden.value=String(option);for(const other of seg.querySelectorAll('button'))other.setAttribute('aria-pressed',String(other===button));hidden.dispatchEvent(new Event('change',{bubbles:true}));});seg.append(button);});
    row.append(head,hidden,seg);if(setting.hint)row.append(agentLabel('span',setting.hint,'launch-agent-setting-range'));return row;
  }
  // A slider only where it can be dragged with meaning (the gate amount spans 0.000001 to a billion: an exact field alone).
  const bound=n=>Number(n).toLocaleString('en-US',{maximumFractionDigits:6}),wide=(setting.max-setting.min)/setting.step>1e6;
  const value=agentLabel('output',setting.value+(setting.unit?' '+setting.unit:''),'launch-agent-setting-value');value.setAttribute('for',name);head.append(value);
  const fieldBox=agentLabel('div',null,'launch-agent-setting-field'+(wide?' is-exact':'')),range=node('input');range.type='range';range.id=name+'_range';range.min=String(setting.min);range.max=String(setting.max);range.step=String(setting.step);range.value=String(setting.value);range.setAttribute('aria-label',setting.label);
  const number=node('input');number.type='number';number.setAttribute('name',name);number.name=name;number.id=name;title.htmlFor=name;number.min=String(setting.min);number.max=String(setting.max);number.step=String(setting.step);number.value=String(setting.value);number.inputMode='decimal';number.setAttribute('aria-describedby',title.id+'-range');
  const unit=agentLabel('span',setting.unit||'','launch-agent-setting-unit'),limits=agentLabel('span',bound(setting.min)+'–'+bound(setting.max)+(setting.unit?' '+setting.unit:'')+(setting.hint?' · '+setting.hint:''),'launch-agent-setting-range');limits.id=title.id+'-range';
  range.addEventListener('input',()=>{number.value=range.value;value.textContent=range.value+(setting.unit?' '+setting.unit:'');});
  number.addEventListener('input',()=>{if(number.value!=='')range.value=number.value;value.textContent=(number.value||'—')+(setting.unit?' '+setting.unit:'');});
  const box=agentLabel('div',null,'launch-agent-setting-number');box.append(number,unit);if(!wide)fieldBox.append(range);fieldBox.append(box);row.append(head,fieldBox,limits);return row;
}
/** Trading hours: one time-zone picker (HOOK_TIMEZONES) writes the raw tzOffset and dst fields, which stay generic hidden settings. */
function hookTimezoneRow(id,offsetSetting,dstSetting){
  const row=agentLabel('div',null,'launch-agent-setting launch-hook-setting launch-hook-timezone');row.dataset.setting='timezone';
  const head=agentLabel('div',null,'launch-agent-setting-head'),title=agentLabel('label','Time zone','launch-agent-setting-label');title.id='launch-hook-setting-'+id+'-timezone';title.htmlFor='launch-hook-trading-timezone';head.append(title);
  const offset=hookHiddenField('hook_'+id+'_'+offsetSetting.key,offsetSetting.value),dst=hookHiddenField('hook_'+id+'_'+dstSetting.key,dstSetting.value);
  const select=node('select');select.setAttribute('name','hookTradingTimezone');select.name='hookTradingTimezone';select.id='launch-hook-trading-timezone';select.className='launch-hook-time launch-hook-zone';
  for(const zone of HOOK_TIMEZONES){const option=node('option',hookTzLabel(zone));option.value=zone.id;if(zone.offset===offsetSetting.value&&zone.dst===dstSetting.value){option.setAttribute('selected','');option.selected=true;}select.append(option);}
  select.addEventListener('change',()=>{const zone=HOOK_TIMEZONES.find(z=>z.id===select.value);if(!zone)return;offset.value=String(zone.offset);dst.value=String(zone.dst);});
  row.append(head,offset,dst,select,agentLabel('span','The hours above are read in this zone; its daylight-saving rule (US or EU) is followed on chain.','launch-agent-setting-range'));return row;
}
/** The gate token mint, the blocklist or the tithe recipient: the one address field a rule's `extra` asks for. */
function hookExtraField(item){
  if(item.extra==='gateMint'){
    const label=agentLabel('label',null,'launch-hook-gate launch-hook-address');label.append(document.createTextNode('Gate token mint'));const input=node('input');input.type='text';input.setAttribute('name','hookGateMint');input.name='hookGateMint';input.id='launch-hook-gate-mint';input.autocomplete='off';input.spellcheck=false;input.setAttribute('autocapitalize','off');input.placeholder='Mint address of the token holders must have (SPL or Token-2022)';input.maxLength=44;label.append(input,agentLabel('span','Receiving wallets must hold the minimum below in this token at the moment of each transfer.','help'));return label;
  }
  if(item.extra==='titheRecipient'){
    const label=agentLabel('label',null,'launch-hook-tithe launch-hook-address');label.append(document.createTextNode('Tithe recipient'));const input=node('input');input.type='text';input.setAttribute('name','hookTitheRecipient');input.name='hookTitheRecipient';input.id='launch-hook-tithe-recipient';input.autocomplete='off';input.spellcheck=false;input.setAttribute('autocapitalize','off');input.placeholder='Wallet address that receives the donation';input.maxLength=44;label.append(input,agentLabel('span','Written on chain at launch and shown on the coin page. Every buy and sell Launchpad builds pays the donation to it in the same transaction.','help'));return label;
  }
  if(item.extra==='blocklist'){
    const label=agentLabel('label',null,'launch-hook-blocklist');label.append(document.createTextNode('Blocked wallets'));const textarea=node('textarea');textarea.setAttribute('name','hookBlocklist');textarea.name='hookBlocklist';textarea.id='launch-hook-blocklist';textarea.rows=4;textarea.spellcheck=false;textarea.setAttribute('autocapitalize','off');textarea.setAttribute('autocomplete','off');textarea.placeholder='One wallet address per line, or separated by commas (1 to '+HOOK_LIMITS.blocklistTotal+')';
    const count=agentLabel('span','0 of '+HOOK_LIMITS.blocklistTotal,'launch-hook-blocklist-count');count.id='launch-hook-blocklist-count';count.setAttribute('role','status');count.setAttribute('aria-live','polite');
    label.append(textarea,count,agentLabel('span','Written on chain in the hook setup and sealed by the first trade: nobody can add or remove a wallet afterwards.','help'));return label;
  }
  return null;
}
/** The live "n of 200" under the blocklist, with the lines that are not wallet addresses counted. */
function syncHookBlocklistCount(){
  const count=document.getElementById('launch-hook-blocklist-count');if(!count)return;const entries=hookBlocklistEntries(),invalid=entries.filter(line=>!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(line)).length,valid=entries.length-invalid;
  count.textContent=valid+' of '+HOOK_LIMITS.blocklistTotal+(invalid?' · '+invalid+(invalid===1?' line is not a wallet address':' lines are not wallet addresses'):'');count.classList.toggle('is-over',valid>HOOK_LIMITS.blocklistTotal);count.classList.toggle('is-invalid',invalid>0);
}
/** The settings block of one chosen rule, built once (typed values survive re-syncs): the rule's sentence, its extra address field, its setting rows and its note. */
function hookSettingsGroup(item){
  if(hookSettingsBuilt.has(item.id))return hookSettingsBuilt.get(item.id);
  const group=agentLabel('div',null,'launch-hook-setting-group');group.dataset.rule=item.id;group.dataset.route=item.route;
  const head=agentLabel('div',null,'launch-hook-setting-head'),titleRow=agentLabel('div',null,'launch-hook-setting-title');titleRow.append(agentLabel('strong',item.name),hookRouteChip(item.route));head.append(titleRow,agentLabel('span',item.rule,'launch-hook-setting-rule'));group.append(head);
  const extra=hookExtraField(item);if(extra)group.append(extra);
  const rows=agentLabel('div',null,'launch-agent-objective-settings launch-hook-setting-rows');
  for(let index=0;index<item.settings.length;index++){
    const setting=item.settings[index];
    // Trading hours: the offset and the daylight-saving rule are one time-zone choice.
    if(item.id==='trading_hours'&&setting.key==='tzOffset'){const dst=item.settings.find(row=>row.key==='dst');if(dst){rows.append(hookTimezoneRow(item.id,setting,dst));continue;}}
    if(item.id==='trading_hours'&&setting.key==='dst'&&item.settings.some(row=>row.key==='tzOffset'))continue;
    rows.append(hookSettingRow(item.id,setting));
  }
  if(item.settings.length)group.append(rows);
  if(item.note)group.append(agentLabel('p',item.note,'help launch-hook-setting-note'));
  hookSettingsBuilt.set(item.id,group);return group;
}
let hooksIntroSolana='';
function syncHookRules(){
  const wrap=$('launch-hooks');if(!wrap)return;const show=hooksEnabled();wrap.hidden=!show;
  const intro=$('launch-hooks-intro');if(intro){if(!hooksIntroSolana)hooksIntroSolana=intro.textContent;intro.textContent=isRobinhood()?'Rules that Launchpad’s rule engine checks on every transfer of your coin while it is on its curve. Graduation switches the rules off, so every rule ends when the coin moves into its Uniswap pool. A rule can stop a transfer; it never takes a fee or moves tokens (a tithe is paid by the buyer with the trade). The rules and their numbers are written on chain at launch and cannot be changed afterwards.':hooksIntroSolana;}
  $('launch-card-hooks-row').hidden=!show;if(!show){$('launch-meteora-hook-note').hidden=true;return;}
  // The rule cards stay folded behind "Add hooks" (v71.37) until the creator asks for them: the form stays short for everyone
  // else. A chosen rule with a problem, or rules on an AI Agent launch, open the fold so the message is in view.
  const mode=field('feeMode').value;
  if(!hooksOpen&&hooksBuilt&&(hookProblem()||(hookSelected().length&&mode==='agent')))hooksOpen=true;
  $('launch-hooks-hint').textContent=isRobinhood()?'Optional · enforced by Launchpad’s rule engine until graduation · up to '+Math.min(HOOK_MAX_RULES,4)+' of '+HOOK_RULES.filter(hookOnChain).length+' rules':'Optional · Meteora only · up to '+HOOK_MAX_RULES+' of '+HOOK_RULES.length+' rules';
  if(hooksOpen&&!hooksBuilt){hooksBuilt=true;buildHookGroups();}
  const selected=hookSelected(),full=selected.length>=HOOK_MAX_RULES;
  $('launch-hooks-body').hidden=!hooksOpen;wrap.classList.toggle('is-collapsed',!hooksOpen);wrap.classList.toggle('has-rules',selected.length>0);
  const toggle=$('launch-hooks-toggle');toggle.textContent=hooksOpen?'Hide rules':selected.length?'Edit rules':'Add hooks';toggle.setAttribute('aria-expanded',String(hooksOpen));
  for(const label of $('launch-hooks-groups').querySelectorAll('.launch-hook-rule')){
    const item=hookRuleById(label.dataset.rule),input=label.querySelector('input'),on=selected.includes(item.id),onChain=hookOnChain(item),offered=hookAppOffered(item)&&onChain,conflict=on?null:hookConflict(item,selected),blocked=!on&&(!offered||!!conflict||full);
    if(!offered&&on)input.checked=false;input.disabled=blocked;label.classList.toggle('is-selected',on&&offered);label.classList.toggle('is-blocked',blocked);label.classList.toggle('is-unavailable',!offered);label.hidden=!onChain;
    const reason=on&&offered?'':!onChain?item.name+' is not available on Robinhood Chain.':!offered?hookAppUnavailableText(item.appName):conflict?'Cannot combine with '+conflict.name:full?'Up to '+HOOK_MAX_RULES+' rules':'';if(reason)label.setAttribute('title',reason);else label.removeAttribute('title');const note=label.querySelector('.launch-hook-rule-block');note.textContent=reason;note.hidden=!reason;
  }
  // Settings for the chosen rules, in catalogue order; a rule that was unchecked keeps its typed values for later.
  const settings=$('launch-hooks-settings'),ordered=HOOK_RULES.filter(item=>selected.includes(item.id)&&(item.settings.length||item.extra));
  for(const child of [...settings.children])if(!ordered.some(item=>item.id===child.dataset.rule))child.remove();
  ordered.forEach((item,index)=>{const group=hookSettingsGroup(item);if(settings.children[index]!==group)settings.insertBefore(group,settings.children[index]||null);});
  settings.hidden=!ordered.length;
  // Rows that apply only at some level count or mode (`when`: sliding caps levels, the rising mode) follow the typed values.
  for(const item of ordered){if(!item.settings.some(setting=>setting.when!==null&&setting.when!==undefined))continue;const typed=hookTypedValues(item.id),group=hookSettingsGroup(item);for(const setting of item.settings){const row=group.querySelector('.launch-hook-setting[data-setting="'+setting.key+'"]');if(row)row.hidden=!hookSettingVisible(item,setting,typed);}}
  if(selected.includes('blocklist'))syncHookBlocklistCount();
  const count=selected.length,route=hookRoute(selected),chosenNames=HOOK_RULES.filter(row=>selected.includes(row.id)).map(row=>row.name);$('launch-hooks-count').textContent=count?count+' of '+HOOK_MAX_RULES+(count===1?' rule chosen':' rules chosen')+(hooksOpen?'':': '+chosenNames.join(', '))+(full?' · that is the most a coin can carry.':'.')+(route==='curve'?' Launchpad route only until graduation.':route==='app'?' Trades only in '+hookAppRule(selected).appName+' until graduation.':''):hooksOpen?'No rules chosen · a plain '+(isRobinhood()?'Robinhood Chain':'Meteora')+' launch.':'No rules · a plain '+(isRobinhood()?'Robinhood Chain':'Meteora')+' launch. Add rules '+(isRobinhood()?'Launchpad’s rule engine':'the hook program')+' enforces on every transfer while the coin is on the curve.';
  $('launch-hooks-agent').hidden=!(count&&mode==='agent');
  const problem=hookProblem(),error=$('launch-hooks-error');error.textContent=problem;error.hidden=!problem;
  const list=$('launch-hooks-enforce-list');list.replaceChildren();
  if(count){const row=agentLabel('li',null,'launch-hooks-enforce-row launch-hooks-enforce-route');row.dataset.route=route;row.append(agentLabel('strong',HOOK_ROUTES[route].name),agentLabel('span',hookRouteLine(selected)));list.append(row);}
  for(const item of HOOK_RULES.filter(row=>selected.includes(row.id))){const row=agentLabel('li',null,'launch-hooks-enforce-row');row.dataset.rule=item.id;let text='',invalid=false;try{text=describeHookRule(item.id,hookSettingsFor(item.id));}catch(e){text=e?.message||'Check this rule’s settings.';invalid=true;}row.classList.toggle('is-invalid',invalid);row.append(agentLabel('strong',item.name),agentLabel('span',text));list.append(row);}
  $('launch-hooks-enforce').hidden=!count;
  for(const input of settings.querySelectorAll('input[name^=hook_],input[name=hookGateMint],input[name=hookTitheRecipient],textarea[name=hookBlocklist],select[name^=hook_]')){const item=hookRuleById(input.closest('.launch-hook-setting-group')?.dataset.rule);input.setAttribute('aria-invalid',String(!!problem&&!!item&&problem.startsWith(item.name)));}
  const names=HOOK_RULES.filter(row=>selected.includes(row.id)).map(row=>row.name);$('launch-card-hooks').textContent=count?count+(count===1?' rule':' rules')+' · '+names.join(', ')+(route==='curve'?' · Launchpad route only':route==='app'?' · '+hookAppRule(selected).appName+' only':''):'None';
  $('launch-meteora-hook-note').hidden=!(count||hookedMeteoraLaunch());
}
/** Leaving Meteora drops the chosen rules: they exist on that venue only. */
function clearHookSelection(){
  for(const input of form.querySelectorAll('input[name=hookRule]')){input.checked=false;input.disabled=false;}
  for(const name of ['hookGateMint','hookTitheRecipient','hookBlocklist']){const input=form.querySelector('[name='+name+']');if(input)input.value='';}
}
const inputKey=()=>JSON.stringify(rawInput());
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function error(message=''){if(disposed)return;for(const id of ['launch-error','launch-modal-error','launch-wallet-error']){$(id).textContent=message;$(id).hidden=!message;}}
function invalidatePrepared(){clearTimeout(prepareTimer);prepareVersion++;prepared=null;prepareError='';preparing=false;}
function stopApprovals(message='Future approvals stopped. Submitted transactions can still confirm.') {flowVersion++;progressNote=message;actionJob?.controller.abort(Object.assign(Error(message),{cancelled:true}));syncProgress();}
function syncWallet(){
  const state=launchWallet.state(),version=JSON.stringify([state.wallets,state.deepLinks||[]]);
  if(version!==walletOptionsVersion){walletOptionsVersion=version;$('launch-wallet-options').replaceChildren();for(const wallet of state.wallets){const button=node('button',wallet.name);button.type='button';button.className='launch-wallet-option';button.onclick=()=>action(async()=>{await launchWallet.connect(wallet.id);if(!csrf||!isPump()&&sessionWallet&&sessionWallet!==launchWallet.state().address)await walletLogin();$('launch-wallet-dialog').close();},button);$('launch-wallet-options').append(button);}if(!state.wallets.length)for(const link of state.deepLinks||[]){const anchor=node('a','Open in '+link.name);anchor.className='launch-wallet-option';anchor.href=link.href;anchor.rel='noopener';anchor.setAttribute('data-wallet-deeplink',link.id);$('launch-wallet-options').append(anchor);}}
  $('launch-connect').textContent=state.address?state.name+' · '+shortAddress(state.address):'Connect wallet';$('launch-disconnect').hidden=!state.address;
  $('launch-wallet-help').textContent=state.wallets.length?'Choose your Solana wallet.':state.deepLinks?.length?'No wallet found in this browser. Open Launchpad in your wallet app to connect.':'Open Launchpad in your Solana wallet’s browser or use a browser with a Solana wallet extension.';
  $('launch-wallet-mode-note').textContent=state.address?'Pay with your connected wallet.':walletOnly?'Connect your wallet to launch.':'Using your default Launchpad wallet.';
}
const unsubscribeWallet=launchWallet.onChange(state=>{if(disposed)return;if(state.address!==walletAddress){walletAddress=state.address;dammPumpSavedOperation=null;dammPumpSavedPending=null;if(isDammPump())void refreshDammPumpSaved();pumpFunded?.walletChanged();pumpPublicController?.reset();meteoraController?.reset();dammPumpController?.reset();if(pumpClassicController&&!pumpClassicController.locked)pumpClassicController.reset();requestId=crypto.randomUUID();invalidatePrepared();if(flow)stopApprovals('Wallet changed. Reconnect the launch wallet to finish.');else schedulePrepare();}syncForm();});
async function api(path='',body,administrator=false){
  if(body&&path!=='/image')assertRaydium();
  const requestVenue=venueVersion;
  const base=administrator||adminLaunch&&['/prepare','/estimate','/create'].includes(path)?'/api/admin/launchpad':'/api/launchpad';
  const generation=sessionGeneration,account=launchSessionAccount,token=csrf;
  const check=()=>{if(disposed||requestVenue!==venueVersion||generation!==sessionGeneration||account!==launchSessionAccount||token!==csrf)throw Object.assign(Error('Your account changed. Review this launch before continuing.'),{cancelled:true});};
  const res=await pageFetch(base+path,{method:body?'POST':'GET',headers:{'x-control-token':token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:actionJob?.controller.signal});check();
  let data;try{data=await res.json();}catch{const e=Error('The connection was interrupted. Please try again.');e.status=res.status||503;throw e;}
  check();if(!res.ok){const e=Error(data.error||'Launch request failed.');e.status=res.status;e.code=data.code;e.retryAfter=Number(res.headers?.get?.('retry-after')||0);throw e;}return data;
}
const retryable=e=>!e.cancelled&&e.code!=='LAUNCH_REQUEST_TIMEOUT'&&(e instanceof TypeError||[408,429,502,503,504].includes(e.status));
async function retryRequest(path,body,check=()=>{}){const job=actionJob;for(let attempt=0;;attempt++){check();if(job?.controller.signal.aborted)throw job.controller.signal.reason;try{return await api(path,body);}catch(e){if(!retryable(e)||attempt>=3)throw e;progressNote='Connection interrupted. Retrying automatically…';syncProgress();await wait(Math.min(5000,Math.max(e.retryAfter*1000||0,800*2**attempt)));}}}
async function action(fn,button){if(disposed||busy)return;const job={controller:new AbortController()};actionJob=job;busy=true;syncNavigationFree();error();if(button)button.disabled=true;try{await fn();}catch(e){if(actionJob===job&&!e.cancelled){error(e.message);if(e.code==='LAUNCH_REQUEST_TIMEOUT'||e.code==='LAUNCH_WALLET_TIMEOUT')progressNote=e.message;}}finally{if(actionJob===job){actionJob=null;busy=false;if(button)button.disabled=false;syncForm();syncProgress();}}}
function currentPreparation(){return prepared&&prepared.key===inputKey()&&Date.now()<prepared.reviewExpires-1000?prepared:null;}
function schedulePrepare(delay=800){
  if(disposed)return;
  invalidatePrepared();if(isPump()||isMeteora()||isDammPump()||isPumpClassic()||busy||!csrf||!$('launch-buy-dialog').open){syncForm();return;}
  // A detail the launch cannot use (such as an amount with too many decimals) is named in the dialog, next to the amount.
  let raw;try{raw=rawInput();if(!imageId)throw Error('Add a coin image first.');if($('launch-dev-buy').validity?.badInput)throw Error('Enter the first buy as a SOL amount, like 0.5.');validateInput(raw);}catch(e){prepareError=e.message||'Check your launch details.';syncForm();return;}
  const key=JSON.stringify(raw),version=prepareVersion;preparing=true;syncForm();
  const check=()=>{if(version!==prepareVersion||key!==inputKey())throw Object.assign(Error('Launch details changed.'),{cancelled:true});};
  prepareTimer=setTimeout(async()=>{try{const value=await retryRequest('/prepare',raw,check);check();const d=value.review?.devBuy;if(d){const gross=BigInt(d.gross),net=BigInt(d.net??d.gross);if(gross>100000000000000n||net<0n||net>gross)throw Error('Developer buys are limited to 100 million tokens (10% of supply).');}if(!value.prepareId||!value.review?.minimumSol||!value.reviewHash||!Number.isFinite(value.reviewExpires))throw Error('The launch cost is unavailable. Try again shortly.');prepared={...value,key};}catch(e){if(version!==prepareVersion||e.cancelled)return;prepareError=e.message;}finally{if(version===prepareVersion){preparing=false;syncForm();}}},delay);
}


function renderCurveSummary(review){
  if(isPumpClassic()){$('launch-curve-summary').textContent='Launches on Pump.fun’s standard bonding curve and graduates to PumpSwap. Launchpad creates the coin from a wallet made only for it; your dev-buy tokens go to the wallet you fund from.';return;}
  if(isDammPump()){$('launch-curve-summary').textContent='$20,000 starting FDV on Meteora → $50,000 graduation to PumpSwap at the launch quote reference. USD values move with the paired asset. All received PumpSwap LP is burned.';return;}
  if(isMeteora()){$('launch-curve-summary').textContent='$20,000 starting FDV → $50,000 graduation at the launch quote reference. USD values move with the paired asset. Graduates to Meteora DAMM v2 with permanently locked liquidity.';return;}
  if(isPump()&&pumpPublic){$('launch-curve-summary').textContent='$20,000 starting FDV → $50,000 graduation at the launch SOL reference. USD values move with SOL. Launchpad creates the PumpSwap pool and burns all received LP automatically.';return;}
  if(isPump()){$('launch-curve-summary').textContent='Private model: '+money(pumpTargets().start)+' starting FDV → '+money(pumpTargets().graduation)+' graduation. Intended destination: PumpSwap with 100% of migration LP burned. This preview does not move funds; verified owner test controls are separate.';return;}
  const valid=value=>(typeof value==='number'||typeof value==='string'&&/^(0|[1-9]\d*)(\.\d+)?$/.test(value))&&Number.isFinite(Number(value))&&Number(value)>0;
  const reference=valid(review?.actualUsd)&&valid(review?.graduationUsd);
  $('launch-curve-summary').textContent=reference?'Reviewed valuation: starts near '+money(review.actualUsd)+' and graduates near '+money(review.graduationUsd)+' at this review’s quote-asset price. USD values move with the paired asset. Migration liquidity is permanently secured in a Raydium pool.':'Launches on a bonding curve. Graduates to a Raydium pool with permanently secured migration liquidity.';
}
function renderBudget(review){
  $('launch-budget').hidden=!review;if(!review)return;
  const total=units(review.minimumSol),buy=BigInt(review.devBuy?.solBudget||0),fees=total-buy;
  $('launch-budget-fees').textContent=displayUnits(fees)+' SOL';$('launch-budget-buy').textContent=displayUnits(buy)+' SOL';$('launch-budget-total').textContent=displayUnits(total)+' SOL';
}

function syncForm(){
  if(disposed)return;
  if(!isPumpClassic()&&PUMP_ONLY_MODES.includes(field('feeMode').value)||(!isRaydium()||!paycheckOffered())&&field('feeMode').value==='paycheck'){for(const radio of form.querySelectorAll('[name=feeMode]'))radio.checked=radio.value==='creator';lastFeeMode='creator';}
  if(TENANT&&!tenantModeOk(field('feeMode').value,launchVenue)){const next=[...form.querySelectorAll('[name=feeMode]')].map(radio=>radio.value).find(value=>tenantModeOk(value,launchVenue));if(next){for(const radio of form.querySelectorAll('[name=feeMode]'))radio.checked=radio.value===next;lastFeeMode=next;}}
  if(isRaydium()&&!adminLaunch)field('targetUsd').value=String(START_USD[currentStart()]);
  const pump=isPump(),meteora=isMeteora(),damm=isDammPump(),pc=isPumpClassic(),mode=field('feeMode').value,fdv=meteora?String(START_USD[currentStart()]):damm?'20000':pump?String(pumpTargets().start):field('targetUsd').value,d=prepared?.review?.devBuy;
  {const venue=meteora?'meteora':isRaydium()&&!adminLaunch?'raydium':'',allowed=venue?startsFor(venue):[],start=currentStart(),choose=allowed.length>1;
    $('launch-start-tiers').hidden=!choose;for(const button of document.querySelectorAll('[data-start-tier]')){button.hidden=!allowed.includes(button.dataset.startTier);button.setAttribute('aria-pressed',String(button.dataset.startTier===start));button.disabled=busy||!!flow||creating;}
    $('launch-start-note').hidden=!venue||!TENANT;$('launch-start-note').textContent=venue?START_NOTES[start]+(venue==='raydium'?' Graduates at $50,000.':''):'';}
  $('launch-tax-label').hidden=pump||meteora||damm||pc||mode!=='holders';field('taxPercent').disabled=pump||meteora||damm||pc||mode!=='holders';
  // The ticker field takes what the venue accepts: Raydium letters, numbers and _ (up to 10); Pump.fun up to 13 bytes,
  // the others up to 10 bytes of any text (the byte limit is checked by tickerProblem).
  const ticker=field('symbol');if(ticker.maxLength!==tickerLimit())ticker.maxLength=tickerLimit();if(isRaydium()!==ticker.hasAttribute('pattern')){if(isRaydium())ticker.setAttribute('pattern','[A-Za-z0-9_]+');else ticker.removeAttribute('pattern');}
  launchWalletLine.hidden=pump&&!pumpPublic;$('launch-card-buy').parentElement.hidden=pump;
  $('launch-reward-options').hidden=pump||damm;for(const radio of form.querySelectorAll('[name=feeMode]'))radio.disabled=pump||damm||!pc&&PUMP_ONLY_MODES.includes(radio.value);for(const label of form.querySelectorAll('[data-pump-only]'))label.hidden=!pc;for(const label of form.querySelectorAll('[data-raydium-only]'))label.hidden=!isRaydium()||!paycheckOffered();$('launch-reward-segments').dataset.count=pc?'9':isRaydium()&&paycheckOffered()?'5':'4';$('launch-rewards-legend').textContent=pc?'Choose a launch option':'Choose rewards';
  $('launch-damm-pump-availability').hidden=!damm;$('launch-damm-pump-target').hidden=!damm;$('launch-damm-pump-disclosure').hidden=!damm;
  $('launch-damm-pump-availability').textContent=dammPumpAllowed()?'Meteora trading from launch · PumpSwap graduation.':dammPumpReason();$('launch-damm-pump-disclosure').textContent=dammPumpFeeText()+' All received PumpSwap LP is burned at graduation.';
  $('launch-pump-classic-availability').hidden=!pc;$('launch-pump-classic-availability').textContent=pumpClassicAllowed()?'Pump.fun bonding curve · graduates to PumpSwap.':pumpClassicReason();$('launch-pump-classic-disclosure').hidden=!pc;
  $('launch-mode-select').hidden=false;$('launch-meteora-availability').hidden=!meteora;
  $('launch-meteora-availability').textContent=meteoraAllowed()?(meteoraStatus.ownerPreview===true&&meteoraStatus.publicEnabled!==true?'Owner preview. Public Meteora launches are closed.':'Meteora DBC · graduates to DAMM v2.'):(meteoraStatus?.blockers?.filter(x=>typeof x==='string').join(' ')||meteoraStatus?.reason||'Meteora launches are not ready yet. Choose Raydium or check again shortly.');
  $('launch-meteora-target').hidden=!meteora;$('launch-meteora-disclosure').hidden=!meteora;$('launch-pump-test').hidden=!pump||pumpPublic;$('launch-pump-rewards-note').hidden=!pump;$('launch-pump-public-disclosure').hidden=!pump||!pumpPublic;$('launch-pump-public-target').hidden=!pump||!pumpPublic;$('launch-pump-public-preview').hidden=!pump||!pumpPublic||pumpPublicStatus?.ownerPreview!==true||pumpPublicStatus?.publicEnabled===true;
  $('launch-fixed-fdv').querySelector('strong').textContent=money(fdv);$('launch-pump-targets').textContent='Starting FDV '+money(pumpTargets().start)+' · graduation FDV '+money(pumpTargets().graduation)+'. Quote prices are entered manually for this model.';
  $('launch-admin-fdv').hidden=pump||meteora||damm||pc||!adminLaunch;$('launch-fixed-fdv').hidden=pc||!pump&&!meteora&&!damm&&adminLaunch;$('launch-fdv-note').hidden=pc;field('targetUsd').disabled=pump||meteora||damm||pc;
  for(const id of ['launch-pump-preset','launch-pump-price','launch-pump-graduation-fee','launch-pump-trade-fee'])$(id).disabled=!pump||pumpBusy;
  for(const button of document.querySelectorAll('[data-launch-venue]')){button.setAttribute('aria-pressed',String(button.dataset.launchVenue===launchVenue));button.disabled=busy||pumpFunded?.busy||pumpPublicController?.busy||meteoraController?.busy||dammPumpController?.busy||pumpClassicController?.busy||!!flow||creating||imageBusy;}
  document.querySelector('.launch-venue').textContent=pc?'Launch on Pump.fun':damm?'PumpSwap':meteora?'Powered by Meteora':pump?(pumpPublic?(pumpPublicStatus?.ownerPreview&&pumpPublicStatus?.publicEnabled!==true?'PumpSwap · Owner preview':'Graduates to PumpSwap'):'PumpSwap · Private preview'):'Powered by Raydium';
  $('launch-asset-description').textContent=pc?'SOL and the pairs Pump.fun admits for new coins: its listed quote and custom pairs.':damm?'Pairs verified for Meteora launch and PumpSwap graduation.':meteora?'Verified Meteora launch pairs. Your first buy uses the selected quote asset.':pump?(pumpPublic?'Available PumpSwap launch pairs.':'Quote assets verified for private PumpSwap testing.'):'Crypto, Wormhole, leveraged tokens, custom tokens, stocks, ETFs and pre-IPO assets';
  $('launch-open').textContent=pc?(pumpClassicController?.locked?'View Pump.fun launch →':pumpClassicAllowed()?'Launch on Pump.fun →':'Pump.fun unavailable'):damm?(dammPumpAllowed()?'Launch →':'Launch unavailable'):meteora?(meteoraAllowed()?'Launch →':'Meteora unavailable'):pump?(pumpPublic?'Launch →':'Preview test launch'):'Create coin →';
  dammPumpResumeButton.hidden=!damm||dammPumpAllowed()||!dammPumpSavedOperation||dammPumpSavedOperation.wallet!==launchWallet.state().address;dammPumpResumeButton.disabled=busy||dammPumpController?.busy||!!dammPumpSavedPending;
  $('launch-footer-hint').textContent=pump&&!pumpPublic?'Private test · no wallet approval or payment.':pc?'Choose an optional dev buy, then fund the launch with one transfer.':hookChosen()?'Launch with your transfer hook rules; your first buy follows as a separate trade.':'Choose an optional first buy, then launch.';
  $('launch-holder-minimum-wrap').hidden=mode!=='holders'||pc;
  syncGotchiPicker(pump||damm?false:mode==='gotchi',meteora?'meteora':'raydium');
  const agent=mode==='agent'&&!pump&&!damm;$('launch-agent-settings').hidden=!agent;if(agent){syncAgentSettings();if(!agentCatalog&&!agentCatalogPending)loadAgentCatalog();}
  const influencerLine=agent&&influencerStep?influencerStep.sync():'';$('launch-card-influencer-row').hidden=!influencerLine;$('launch-card-influencer').textContent=influencerLine||'Off';
  if(isPumpClassic()&&basketsEnabled())void refreshBasketCatalogue();
  const basketLine=basketStep?basketStep.sync():'';$('launch-card-basket-row').hidden=!basketLine||!basketsEnabled();$('launch-card-basket').textContent=basketLine||'Off';
  syncHookRules();const hooked=hookedMeteoraLaunch();$('launch-meteora-buy').disabled=(meteoraController?.inputLocked||false)||hooked;$('launch-meteora-buy-field').hidden=hooked;if(meteora)paintFlow($('launch-meteora-dialog'),meteoraController?.operation);
  if(pc)pumpClassicFeeNote(mode);else $('launch-fee-note').textContent=mode==='agent'?(agent?(asset.mint===SOL_MINT?'After the platform share, your creator entitlement funds the agent: 30% operations, 70% coin treasury. SOL pairs only.':'AI Agent launches pair with SOL only. Choose SOL as the pair.'):'AI Agent launches are available on Raydium, Meteora and Pump.fun only.'):mode==='gotchi'?gotchiFundingSummary(meteora?'meteora':'raydium').text+' The pairing is written into the coin permanently.':meteora?(mode==='holders'?(basketsEnabled()&&basketExtras().length?'Trading fees fund holder rewards paid in every basket asset ('+basketStep.summary()+'), converted at market each round and weighted by eligible token balances. There is no transfer tax.':'Trading fees fund holder rewards in the paired asset, weighted by eligible token balances. There is no transfer tax.'):'Your allocated trading fees go to your creator wallet, during the curve and from your locked liquidity after graduation.'):mode==='paycheck'?'Every 15 minutes the 0.50% creator fee is paid out: 50% to holders by their balance, 35% buys and burns $LAUNCHPAD, 10% to Launchpad and 5% to you. A wallet is paid once its share reaches $0.50; smaller amounts roll over, and selling before the payout forfeits the pending amount to the other holders. SOL pair only.':!['creator','holders'].includes(mode)?'Choose Creator or Holders for this new launch. Existing agent coins keep their current rewards.':mode==='creator'?'Creator rewards are paid to your launch wallet. Launchpad manages fee collection and can redirect payouts for an approved community takeover.':mode==='holders'?'95% of converted transfer taxes fund rewards in the paired asset, weighted by eligible token balances. Launchpad receives the remaining 5% of tax proceeds. New taxed holder launches have no bonding-curve creator fee.':'Launchpad uses creator fees to buy back and burn your coin automatically.';
  $('launch-fee-settings').hidden=pc;
  const creatorFee=creatorFeeForLaunch(mode==='gotchi'?{feeMode:'holders',taxBps:100}:{feeMode:mode==='agent'?'creator':mode,taxBps:mode==='agent'?0:Math.round(Number(field('taxPercent').value)*100)});
  $('launch-creator-fee-value').textContent=meteora?(mode==='gotchi'?'1.008% → Gotchi pot':mode==='agent'?'0.49632% → agent (30/70)':'0.49632%'):mode==='agent'?'Flat 0.50% → agent (30/70)':mode==='paycheck'?'Flat 0.50% → Paycheck':creatorFee.ratePpm===0?'0%':'Flat 0.50%';
  // The venue disclosures quote the fee schedule the selected rewards mode actually uses.
  $('launch-meteora-disclosure').textContent=(mode==='gotchi'?'2.52% trading fee: 1.008% of volume to the Gotchi prize pot and 1.008% to Launchpad. ':'1.88% trading fee. ')+'No transfer tax or additional Launchpad graduation fee. Meteora deducts 0.2% of migration liquidity; the remaining liquidity is permanently locked. '+(mode==='gotchi'?'The Gotchi pot share continues from the locked position’s share of pool fees.':'Creator or holder rewards continue from the locked position’s share of pool fees.');
  $('launch-meteora-terms').textContent='Starts near $20k FDV and graduates near $50k at the launch quote reference. '+(mode==='gotchi'?'2.52% trading fee, with 1.008% allocated to the paired Gotchi’s prize pot during the curve.':'1.88% trading fee, with 0.49632% allocated to your selected rewards during the curve.')+' After graduation, rewards depend on the locked position’s share of pool trading. The first launch requires configuration and coin creation approvals.';
  $('launch-creator-fee-description').textContent=mode==='agent'?(meteora?'The fixed 1.88% trading fee is unchanged: 0.376% to Meteora, 1.00768% to Launchpad and the 0.49632% creator allocation to the agent wallet, split 30% operations / 70% treasury. After graduation the agent share comes from the locked liquidity’s trading fees.':'The flat 0.50% creator fee on bonding-curve buys and sells is paid to the agent wallet (30% operations / 70% treasury). The 1% Launchpad protocol fee and the reviewed Raydium fee remain separate. After graduation, the pool’s reviewed creator fee applies.'):meteora?(mode==='gotchi'?'Gotchi launches use a fixed 2.52% trading fee: 0.504% goes to Meteora, 1.008% to Launchpad and 1.008% to the Gotchi prize pot. After graduation the pot share comes from the locked liquidity’s trading fees.':'The fixed trading fee is 1.88%: 0.376% goes to Meteora, 1.00768% to Launchpad and 0.49632% to '+(mode==='holders'?'holder rewards':'creator rewards')+'. After graduation, rewards come from the locked liquidity’s share of trading fees.'):(mode==='paycheck'?'The flat 0.50% creator fee on bonding-curve buys and sells is the Paycheck pool: holders 50%, $LAUNCHPAD buy-and-burn 35%, Launchpad 10%, creator 5%, paid out every 15 minutes.':creatorFee.ratePpm===0?'No creator fee on bonding-curve buys and sells for taxed holder rewards.':'A fixed creator fee on bonding-curve buys and sells, at every market cap.')+' The 1% Launchpad protocol fee and the reviewed Raydium fee remain separate. After graduation, the pool’s reviewed creator fee applies.';
  $('launch-fdv-value').textContent=money(fdv);$('launch-dev-summary').textContent=prepareError;$('launch-dev-summary').hidden=!prepareError;$('launch-dev-summary').dataset.error=String(!!prepareError);
  $('launch-card-name').textContent=field('name').value.trim()||'Your next idea';$('launch-card-symbol').textContent='$'+(field('symbol').value.trim().toUpperCase()||'TICKER');$('launch-card-initial').textContent=(field('name').value.trim()[0]||'C').toUpperCase();
  $('launch-card-fdv').textContent=money(fdv);$('launch-card-fdv').parentElement.hidden=pc;$('launch-card-mode').parentElement.hidden=pump||damm;$('launch-card-mode').previousElementSibling.textContent=pc?'Launch option':'Rewards';$('launch-card-buy').previousElementSibling.textContent=pc?'Dev buy':'First buy';$('launch-card-mode').textContent=pump?'None':modes[mode]||'Choose rewards';$('launch-card-buy').textContent=pc?pumpClassicCardBuy():damm?amountLabel($('launch-damm-pump-buy').value,$('launch-damm-pump-buy-symbol').textContent||'SOL'):meteora?(hooked?'After launch':amountLabel($('launch-meteora-buy').value,asset.symbol)):pump?'Not included in model':amountLabel(field('devBuySol').value,'SOL')!=='None'?amountLabel(field('devBuySol').value,'SOL')+(d?' · ~'+Number(displayUnits(d.net??d.gross,6)).toLocaleString(undefined,{maximumFractionDigits:0})+' tokens':''):'None';if($('launch-card-pair').dataset.mint!==asset.mint){$('launch-card-pair').dataset.mint=asset.mint;$('launch-card-pair').replaceChildren(createQuoteLabel(document,asset));}
  $('launch-custom-label').textContent=nativePairs.has(asset.mint)?'Custom':asset.symbol;const customButton=$('launch-asset-open'),customBadge=customButton.querySelector('.launch-ticker-badge');if(nativePairs.has(asset.mint))customBadge?.remove();else if(customBadge?.dataset.mint!==asset.mint){const badge=assetBadge(asset,true);badge.dataset.mint=asset.mint;if(customBadge)customBadge.replaceWith(badge);else customButton.prepend(badge);}$('launch-pair-note').textContent=!pc&&!damm&&!meteora&&!pump&&(asset.catalogueFallback===true||!catalogueReady)?'Your coin trades against '+asset.symbol+'. '+(catalogueReady||catalogueFailed?'Pair availability could not be checked just now; retrying automatically. It is verified before launch.':'Checking Raydium’s pair list…'):pc?(pairUnavailable(asset)?asset.supportReason||'This pair is not available for Pump.fun launches right now. Choose another pair.':asset.mint===SOL_MINT?'Your coin trades against SOL on Pump.fun.':'Your coin trades against '+asset.symbol+' on Pump.fun. '+(pumpClassicDevBuyInSol(asset)?(asset.devBuyAvailable===false?'You pay in SOL. A dev buy is not available on '+asset.symbol+' right now because Launchpad cannot buy it with SOL.':'You pay everything in SOL: for a dev buy, Launchpad buys '+asset.symbol+' with your SOL.'):'Your dev buy is paid in '+asset.symbol+' from your wallet; launch costs and reserves are paid in SOL.')+(asset.kind==='custom'&&asset.creatorFee?' You can choose this coin’s creator fee.':'')):damm?(asset.catalogueUnavailable||!dammPumpCompatible(asset)?asset.supportReason||'This pair is not currently available for launch and graduation.':'Your coin trades against '+asset.symbol+' on Meteora, then PumpSwap. '+(asset.mint===SOL_MINT?'Your first buy and the pool seed use SOL.':'Pay in SOL; Launchpad converts it to '+asset.symbol+' automatically for your first buy and pool seed.')):meteora?(asset.catalogueUnavailable||!meteoraCompatible(asset)?asset.supportReason||'Choose a verified Meteora pair.':'Your coin trades against '+asset.symbol+'. Your wallet needs '+asset.symbol+' for an optional first buy, plus SOL for launch fees.'):asset.catalogueUnavailable?asset.supportReason||'This pair could not be verified. Try again shortly.':(pump?!pumpCompatible(asset):asset.supported===false)?'This pair is not available for '+(pump?pumpPublic?'PumpSwap launches':'PumpSwap testing':'Raydium launches')+' yet. Choose another asset.':pump?(pumpPublic?'Your coin trades against '+asset.symbol+'. Graduates to PumpSwap.':'PumpSwap test pair: '+asset.symbol+'. Compatibility does not enable funded launches.'):'Your coin trades against '+asset.symbol+'.';
  // While Pump.fun's live pair list loads, its pair buttons keep their final layout (USDC and Custom disabled), unless only SOL is open.
  const pcPairsLoading=pc&&!catalogueReady&&pumpClassicStatus?.pairsOpen!==false;
  for(const b of solanaPairButtons()){b.hidden=pc?!pcPairsLoading&&(b.dataset.pair==='custom'?!assets.some(a=>a.pumpClassic===true&&!nativePairs.has(a.mint)):b.dataset.pair!=='SOL'&&!assets.some(a=>a.mint===nativePairMints[b.dataset.pair]&&a.pumpClassic===true)):pump&&pumpPublic&&b.dataset.pair!=='SOL';const on=b.dataset.pair==='custom'?!nativePairs.has(asset.mint):nativePairMints[b.dataset.pair]===asset.mint;b.setAttribute('aria-pressed',String(on));if(b.dataset.pair!=='custom'){const nativeAsset=assets.find(a=>a.mint===nativePairMints[b.dataset.pair]);b.disabled=nativeAsset||!raydiumPairFallback()?pairUnavailable(nativeAsset)||!pump&&!meteora&&!damm&&!pc&&!canViewComingSoon&&nativeAsset?.supported!==true:false;}else b.disabled=pcPairsLoading;}
  for(const b of document.querySelectorAll('[data-fdv]'))b.setAttribute('aria-pressed',String(b.dataset.fdv===fdv));
  const agentBlocked=mode==='agent'&&(pump||damm||asset.mint!==SOL_MINT||!agentCatalog||agentCatalog.unavailable||agentCatalog.intakeOpen===false||!!agentSettingsProblem()||!!influencerProblem()),pcBlocked=pc&&!!pumpClassicModeBlock(mode)&&!pumpClassicController?.launch;
  $('launch-open').disabled=busy||pumpBusy||pumpFunded?.busy||pumpPublicController?.busy||meteoraController?.busy||dammPumpController?.busy||pumpClassicController?.busy||imageBusy||(damm&&!dammPumpAllowed())||(pc&&!pumpClassicAllowed()&&!pumpClassicController?.launch)||pairUnavailable(asset)&&!(pc&&pumpClassicController?.launch)||agentBlocked&&!(pc&&pumpClassicController?.launch)||pcBlocked||hookBlocked()||basketBlocked();$('launch-fields').disabled=!!flow||creating;$('launch-buy-fields').disabled=!!flow||creating;
  syncImage();
  const ready=!pump&&!meteora&&!damm&&!pc&&!flow&&!creating&&!pairUnavailable(asset)&&currentPreparation();$('launch-review-button').disabled=busy||imageBusy||!ready;$('launch-review-button').hidden=$('launch-buy-dialog').dataset.existing==='true';$('launch-buy-fields').hidden=$('launch-buy-dialog').dataset.existing==='true';
  // A preparation error is shown once, under the amount (launch-dev-summary); the note below stays for progress.
  $('launch-ready-note').textContent=prepareError?'':(preparing?'Calculating your launch cost…':ready?'':flow?'':creating?'Creating your coin…':selected&&$('launch-buy-dialog').dataset.existing==='true'?'':'Add your coin details and image to see the launch cost.');
  $('launch-ready-note').hidden=!$('launch-ready-note').textContent;
  const existingReview=flow||$('launch-buy-dialog').dataset.existing==='true';renderBudget(existingReview?selected?.review:prepared?.review);renderCurveSummary(existingReview?selected?.review:currentPreparation()?.review);syncWallet();pumpFunded?.render();pumpPublicController?.render();meteoraController?.render();dammPumpController?.render();pumpClassicController?.render();syncPumpClassicDialog();
  syncRobinhood();paintSteps();syncNavigationFree();
}
/**
 * The site router holds the page while a dialog is open unless the dialog is marked data-navigation-free; a page link
 * then closes it and navigates. A launch dialog is free while it is idle, and held while a wallet connection or
 * signature, a quote, a funding step or a launch is in progress. The pair picker never runs anything.
 */
function syncNavigationFree(){
  if(disposed)return;
  const c=pumpClassicController,idle=v=>!v||!v.busy&&!v.pending,launching=$('launch-buy-dialog').dataset.existing==='true'&&['launching','pending','awaiting_signature'].includes(selected?.state);
  const free={'launch-asset-dialog':true,'launch-wallet-dialog':!busy,'launch-buy-dialog':!busy&&!flow&&!creating&&!preparing&&!launching,
    'launch-pump-classic-dialog':!c||!c.busy&&!c.signedPending&&!c.locked,'launch-robinhood-dialog':!robinhoodController||!robinhoodController.busy&&!robinhoodController.locked,'launch-evm-wallet-dialog':true,'launch-meteora-dialog':idle(meteoraController),'launch-damm-pump-dialog':idle(dammPumpController),'launch-pump-public-dialog':idle(pumpPublicController)};
  for(const [id,value] of Object.entries(free)){const dialog=$(id);if(dialog&&dialog.hasAttribute('data-navigation-free')!==value)dialog.toggleAttribute('data-navigation-free',value);}
}
/** A typed first-buy amount for the preview card: "None" unless it is a positive plain amount the venue accepts (".5" is 0.5). */
function amountLabel(value,symbol){const text=String(value??'').trim().replace(/^\./,'0.');return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)&&/[1-9]/.test(text)?text+' '+symbol:'None';}
/** The Pump.fun dev buy on the preview card, in the unit it is paid in (SOL, or the pair asset on a pair paid in that asset). */
function pumpClassicCardBuy(){
  const a=asset,inSol=pumpClassicDevBuyInSol(a);
  if(pumpClassicBuyMint!==a?.mint||inSol&&a.mint!==SOL_MINT&&a.devBuyAvailable===false)return'None';
  let text;try{text=plainAmount($('launch-pump-classic-buy').value,'dev buy');}catch{return'None';}
  return amountLabel(text,inSol?'SOL':a.symbol);
}
/** What the Details step still needs, in the venue's own rules ('' when nothing). */
function detailsTodo(){
  const name=oneLine(field('name')?.value),symbol=oneLine(field('symbol')?.value);
  if(!name)return symbol?'add a name':'add a name and ticker';if(utf8Size(name)>32)return'shorten the coin name';
  if(!symbol)return'add a ticker';if(tickerProblem(symbol))return'fix the ticker';
  try{coinDetails();}catch{return'shorten the description';}
  for(const [key,label] of [['website','website'],['twitter','X'],['telegram','Telegram']])try{socialLink(key,field(key)?.value,{max:isRaydium()?300:200});}catch{return'fix the '+label+' link';}
  return'';
}
/** What the Market step still needs: an available pair, then what the chosen launch option requires ('' when nothing). */
function marketTodo(){
  const mode=field('feeMode').value;
  if(pairUnavailable(asset)||isDammPump()&&!dammPumpAllowed()||isPumpClassic()&&!pumpClassicAllowed())return'choose an available pair';
  if(isPumpClassic()&&pumpClassicModeBlock(mode))return pumpClassicModeTodo(mode);
  if(isPump()||isDammPump())return'';
  if(mode==='gotchi'&&!form.querySelector('input[name=gotchiId]:checked'))return'choose a Gotchi';
  if(hookChosen()){if(mode==='agent')return'choose the AI Agent or the transfer hook rules';if(hookProblem())return'fix the transfer hook rules';}
  if(basketExtras().length&&basketVenue()&&(mode!=='holders'||basketProblem()))return mode!=='holders'?'choose Holders or remove the reward basket':'fix the reward basket';
  if(mode==='paycheck'&&asset.mint!==SOL_MINT)return'choose SOL as the pair';
  if(mode==='agent'){if(asset.mint!==SOL_MINT)return'choose SOL as the pair';if(!agentCatalog)return'wait for AI Agent availability';if(agentCatalog.unavailable||agentCatalog.intakeOpen===false)return'choose another launch option';if(agentSettingsProblem())return'fix the program settings';if(influencerProblem())return'finish the AI influencer settings';if(!String(field('agentMission')?.value||'').trim())return'give your agent a mission';if(!String(field('agentModel')?.value||agentCatalog.defaultModel||''))return'wait for the model list';}
  return'';
}
// Presentation only: mirror the existing launch requirements in the step rail,
// section badges and launch bar. Never gates, validates or submits anything.
function paintSteps(){
  const details=detailsTodo(),market=isRobinhood()?robinhoodTodo():marketTodo(),stepItems=[...document.querySelectorAll('[data-launch-step]')],stepTodo={details:details||'add a name and ticker',image:'add your coin image',market:market||'choose an available pair',launch:'connect your wallet'};
  const done={details:!details,image:!!imageId&&!imageBusy,market:!market,launch:!walletOnly||!!launchWallet.state().address};
  let count=0,next='';
  for(const item of stepItems){const key=item.dataset.launchStep,ok=done[key]===true;if(ok)count++;else if(!next)next=key;item.classList.toggle('is-done',ok);const status=item.querySelector('[data-step-status]');if(status)status.textContent=ok?'done':'to do';document.querySelector('[data-launch-section="'+key+'"]')?.classList.toggle('is-complete',ok);}
  for(const item of stepItems){if(item.dataset.launchStep===next)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');}
  const rail=$('launch-steps'),footer=launchPanel;if(rail)rail.dataset.done=String(count);
  if(footer){footer.dataset.ready=String(count===stepItems.length&&stepItems.length>0);footer.dataset.done=String(count);}
  if($('launch-ready-text'))$('launch-ready-text').textContent=count===stepItems.length?'Ready to launch':count+' of '+stepItems.length+' ready · Next, '+(stepTodo[next]||'review your launch');
}
// Pair choice depends on verified compatibility; deployment gates launch submission.
function pairUnavailable(a){if(isPumpClassic())return !pumpClassicPairReady(a)||a?.catalogueUnavailable===true;if(isDammPump())return !dammPumpCompatible(a)||a?.catalogueUnavailable===true;if(isMeteora())return !meteoraAllowed()||!meteoraCompatible(a)||a.catalogueUnavailable===true;if(isPump())return !pumpAllowed||!pumpCompatible(a)||a.catalogueUnavailable===true;return !a||a.catalogueUnavailable===true||a.supported===false||(['custom','wormhole'].includes(a.category)||a.wormhole===true)&&a.supported!==true;}
function chooseAsset(next){if(pumpFunded?.busy)return;if(!next)return;if(next.catalogueFallback!==true&&(pairUnavailable(next)||!isPump()&&!isMeteora()&&!isDammPump()&&!isPumpClassic()&&!canViewComingSoon&&next.supported!==true))return;if(isPump()&&asset.mint!==next.mint)$('launch-pump-price').value='';if(isPumpClassic()&&asset.mint!==next.mint){$('launch-pump-classic-buy').value='0';$('launch-pump-classic-fee').value='0';pumpClassicBuyMint=next.mint;}asset=next;meteoraController?.reset();dammPumpController?.reset();$('launch-meteora-buy').value='0';$('launch-damm-pump-buy').value='0';pumpFunded?.contextChanged();changed();if(isPump())pumpFunded?.refresh();}
// Gotchi picker: three permanent pairings rendered once; the chosen radio is
// part of the form, so it flows through rawInput like every other field.
let gotchiPickerBuilt=false,gotchiCharacters=null;
function syncGotchiPicker(visible,venue){
  const picker=$('launch-gotchi-picker');if(!picker)return;picker.hidden=!visible;
  if(!visible)return;
  if(!gotchiPickerBuilt){gotchiPickerBuilt=true;const options=$('launch-gotchi-options');options.replaceChildren();
    for(const theme of GOTCHI_THEMES){const label=node('label',null);label.className='launch-gotchi-option';label.dataset.gotchi=theme.id;label.style.setProperty('--gotchi-a',theme.palette.accentA);label.style.setProperty('--gotchi-b',theme.palette.accentB);label.style.setProperty('--gotchi-sky',theme.palette.sky);const input=node('input');input.type='radio';input.name='gotchiId';input.value=theme.id;const stage=node('div',null);stage.className='launch-gotchi-stage';stage.dataset.gotchi=theme.id;const copy=node('div',null);copy.className='launch-gotchi-copy';copy.append(node('strong',theme.name),node('span',theme.tagline));label.append(input,stage,copy);options.append(label);}
    void import('./gotchi-character.mjs').then(module=>{if(disposed)return;gotchiCharacters=[];for(const stage of options.querySelectorAll('.launch-gotchi-stage')){const theme=gotchiTheme(stage.dataset.gotchi);if(!theme)continue;const character=module.createGotchiCharacter({document,window:document.defaultView,theme,stage:1,size:'mini',interactive:true});stage.replaceChildren(character.element);gotchiCharacters.push(character);}}).catch(()=>{});}
  const chosen=form.querySelector('input[name=gotchiId]:checked')?.value||'',theme=gotchiTheme(chosen);
  for(const option of document.querySelectorAll('.launch-gotchi-option'))option.classList.toggle('is-selected',option.dataset.gotchi===chosen);
  $('launch-gotchi-note').textContent=theme?theme.name+' · '+theme.description:'Choose the Gotchi your coin will race for.';
}
/** Chooses the Gotchi launch option with one Gotchi selected, where the current venue offers Gotchi launches. */
function chooseGotchi(id){
  const option=form.querySelector('input[name=feeMode][value=gotchi]');if(!option||option.disabled||flow||creating)return false;
  if(!option.checked){option.checked=true;changed();}
  const choice=[...form.querySelectorAll('input[name=gotchiId]')].find(input=>input.value===id);if(!choice)return false;
  if(!choice.checked){choice.checked=true;changed();}
  return true;
}
// The launch input an edit produced, without the per-attempt request id. A `change` event that only repeats an
// `input` already handled (it fires when a click on Create coin takes focus from the amount field) changes nothing:
// it must not replace the request id or the prepared launch cost, or that first click is lost.
let lastChangeKey='';
const changeKey=()=>{try{const raw=rawInput();delete raw.requestId;return launchVenue+':'+JSON.stringify(raw);}catch{return'';}};
function changed(event){
  if(flow)return;
  const key=changeKey();if(event&&key&&key===lastChangeKey)return;lastChangeKey=key;
  clearPumpPreview();pumpPublicController?.clearUnsigned();if(isMeteora())meteoraController?.schedulePrepare();if(isDammPump())dammPumpController?.schedulePrepare();
  const mode=field('feeMode').value,tax=Number(field('taxPercent').value);
  if(mode!==lastFeeMode&&mode==='holders'&&(!Number.isFinite(tax)||tax<1||tax>3))field('taxPercent').value='2';
  lastFeeMode=mode;requestId=crypto.randomUUID();syncForm();schedulePrepare();
}
form.addEventListener('input',changed);form.addEventListener('change',changed);
for(const b of document.querySelectorAll('[data-fdv]'))b.onclick=()=>{if(!adminLaunch)return;field('targetUsd').value=b.dataset.fdv;changed();};
for(const b of document.querySelectorAll('[data-start-tier]'))b.onclick=()=>{if(b.disabled||!START_USD[b.dataset.startTier])return;chosenStart=b.dataset.startTier;changed();};
for(const b of solanaPairButtons())if(b.dataset.pair!=='custom'){const nativeMint=nativePairMints[b.dataset.pair],nativeAsset=LAUNCH_ASSETS.find(a=>a.mint===nativeMint);if(nativeAsset)b.prepend(createQuoteIcon(document,nativeAsset,{size:24,textFallback:false}));b.onclick=()=>{const live=assets.find(a=>a.mint===nativeMint);chooseAsset(live||(raydiumPairFallback()?nativePairFallback(nativeMint):null));};}
function renderPairCount(){
  const summary=$('launch-asset-count');
  if(!catalogueReady){summary.textContent=catalogueFailed?'Pair count unavailable.':'Checking available pairs…';return;}
  const available=new Set(assets.filter(venueCompatible).map(a=>a.mint));
  const nativeNames=Object.entries(nativePairMints).filter(([,mint])=>available.has(mint)).map(([name])=>name);
  // A closed PumpSwap venue still lists its compatible pairs (a saved launch can finish), but none is offered as available.
  const dammClosed=isDammPump()&&!!dammPumpStatus&&!dammPumpAllowed();
  summary.textContent=(isPumpClassic()?'Pump.fun · ':isDammPump()?'PumpSwap · ':isMeteora()?'Meteora · ':isPump()?(pumpPublic?'PumpSwap · ':'PumpSwap test catalogue · '):'')+available.size.toLocaleString()+' '+(available.size===1?'pair':'pairs')+(isPump()&&!pumpPublic?' compatible for local testing':dammClosed?' compatible · new launches are closed':' available')+(nativeNames.length?' · Includes '+nativeNames.join(' and '):'');
}
/** Whether a pair is listed under a picker category on the current venue (the SOL and USDC shortcuts never are). */
function listedIn(a,c){
  const inCategory=c==='all'||a.category===c||c==='wormhole'&&a.wormhole===true;
  if(isDammPump())return dammPumpCatalogueRow(a)&&!nativePairs.has(a.mint)&&(c==='coming'?dammPumpComingSoon(a):inCategory);
  if(isPump()||isMeteora()||isPumpClassic())return (isPumpClassic()?a.pumpClassic===true:venueCompatible(a))&&!nativePairs.has(a.mint)&&inCategory;
  return (canViewComingSoon||a.supported===true)&&(c==='coming'?a.supported===false:a.supported!==false&&!nativePairs.has(a.mint)&&inCategory);
}
function renderAssets(){
  renderPairCount();const dammComing=isDammPump()&&assets.some(dammPumpComingSoon),comingHidden=isDammPump()?!dammComing:!canViewComingSoon||isPump()||isMeteora()||isPumpClassic();
  // A category is offered only when it lists something. Raydium's Custom tab explains itself when empty, and
  // PumpSwap's Stocks and Pre-IPO tabs say Coming Soon; Raydium waits for its catalogue before hiding any tab.
  const emptyCategory=c=>!['all','coming'].includes(c)&&(isRaydium()?catalogueReady&&c!=='custom':!(isDammPump()&&['stocks','preipo'].includes(c)))&&!assets.some(a=>listedIn(a,c));
  if(category==='coming'&&comingHidden||category!=='coming'&&emptyCategory(category))category='all';
  for(const button of document.querySelectorAll('[data-category]')){const c=button.dataset.category;button.hidden=c==='coming'?comingHidden:emptyCategory(c);button.setAttribute('aria-pressed',String(c===category));}
  const needle=$('launch-asset-search').value.trim().toLowerCase(),root=$('launch-asset-results'),existing=new Map([...root.children].map(child=>[child.dataset.mint,child])),next=[];
  $('launch-coming-note').hidden=category!=='coming';$('launch-leveraged-note').hidden=category!=='leveraged';$('launch-wormhole-note').hidden=category!=='wormhole';
  // Pairs that cannot be chosen go last (Raydium: unsupported; other venues: unavailable for that venue).
  const last=a=>isRaydium()?a.supported===false:pairUnavailable(a);
  const rows=assets.filter(a=>listedIn(a,category)&&`${a.symbol} ${a.name} ${issuerLabel(a.issuer)} ${a.mint}`.toLowerCase().includes(needle)).sort((a,b)=>Number(last(a))-Number(last(b)));
  const categoryRows=assets.filter(a=>a.category===category),comingSoon=isDammPump()&&catalogueReady&&!catalogueFailed&&['stocks','preipo'].includes(category)&&!categoryRows.some(dammPumpCompatible)&&(categoryRows.length===0||categoryRows.every(dammPumpComingSoon));
  if(comingSoon){const empty=node('div');empty.className='launch-asset-empty';empty.setAttribute('role','status');empty.append(node('strong','Coming Soon'),node('p',(category==='stocks'?'Stocks and ETFs':'Pre-IPO pairs')+' are not available for PumpSwap launches yet. Choose another available pair.'));next.push(empty);}
  for(const a of rows){
    const b=existing.get(a.mint)||node('button');existing.delete(a.mint);b.type='button';b.className='launch-asset-option';b.dataset.mint=a.mint;b.disabled=pairUnavailable(a);
    const content=JSON.stringify([a.mint,a.symbol,a.name,a.issuer,a.category,a.wormhole,a.originChain,a.bridgeProtocol,a.launchpadOrigin,a.originVerified,a.logoPath,a.imagePath,a.supported,a.launchReady,a.availability,a.compatibilityVerified,a.comingSoon,a.supportReason,a.kind,a.creatorFee,a.mint===asset.mint,isDammPump()&&!!dammPumpStatus&&!dammPumpAllowed()]);
    if(b.dataset.content!==content){
      const label=node('span');label.append(createQuoteLabel(document,a,{strong:true,icon:false,origin:true}),node('small',assetSubtitle(a)));
      if(['custom','wormhole'].includes(a.category)||a.wormhole===true){const identity=node('small',shortAddress(a.mint));identity.title=a.mint;identity.className='launch-asset-mint';label.append(identity);}
      b.removeAttribute('title');
      if(pairUnavailable(a)){const reason=node('small',a.supportReason||'Pair availability could not be verified. Try again shortly.');reason.className='launch-asset-reason';label.append(reason);b.title=reason.textContent;}
      if(isPumpClassic()&&!pairUnavailable(a)&&a.kind==='custom'){const kind=node('small','Pump.fun custom pair'+(a.creatorFee?' · creator fee you choose':''));kind.className='launch-asset-reason';label.append(kind);}
      b.replaceChildren(assetBadge(a),label,node('small',isPumpClassic()?(pairUnavailable(a)?'Unavailable':a.mint===asset.mint?'Selected':'Available'):isDammPump()?(!dammPumpCompatible(a)?dammPumpComingSoon(a)?'Coming Soon':'Unavailable':a.mint===asset.mint?'Selected':dammPumpStatus&&!dammPumpAllowed()?'Compatible':'Available'):isMeteora()?(a.mint===asset.mint?'Selected':'Available'):isPump()?(a.mint===asset.mint?'Selected':'Test compatible'):a.supported===false?'Not supported yet':a.mint===asset.mint?'Selected':a.supported==null?(['custom','wormhole'].includes(a.category)||a.wormhole===true?'Unable to verify':'Check availability'):isPump()?'Test compatible':'Available'));b.dataset.content=content;
    }
    b.onclick=()=>{if(pairUnavailable(a))return;chooseAsset(a);$('launch-asset-dialog').close();};next.push(b);
  }
  if(!rows.length&&!comingSoon)next.push(node('p',catalogueFailed?'Pair availability is temporarily unavailable. Try again shortly.':!catalogueReady?'Checking available pairs…':category==='coming'?'No unavailable assets match this search.':category==='custom'&&!needle?'Custom pairs will appear here once listed.':'No matching assets. Try a name, ticker or mint address.'));
  // Keep existing buttons mounted so background checks do not discard keyboard
  // focus, image elements or the reader's position in an open pair picker.
  const keep=new Set(next);for(const child of [...root.children])if(!keep.has(child))child.remove();
  next.forEach((child,index)=>{if(root.children[index]!==child)root.insertBefore(child,root.children[index]||null);});
}
function refreshCatalogue({background=false}={}){
  if(disposed||!csrf||!launchSessionReady)return Promise.resolve();
  if(isPumpClassic())return refreshPumpClassicPairs();
  const current=sessionGeneration,venue=venueVersion,pump=isPump(),meteora=isMeteora(),damm=isDammPump();
  if(cataloguePending?.generation===current&&cataloguePending.venue===venue)return cataloguePending.promise;
  // Raydium's pair list is large (about 200 KB): background checks read it every five minutes, or every minute while
  // the pair picker or the launch dialog is open or the last read failed. Other venues' lists are small.
  const ttl=background&&!pump&&!meteora&&!damm&&!catalogueFailed&&!$('launch-asset-dialog').open&&!$('launch-buy-dialog').open?300000:60000;
  if(catalogueCheckedAt!==null&&Date.now()-catalogueCheckedAt<ttl)return Promise.resolve();
  catalogueCheckedAt=Date.now();
  const job={generation:current,venue};
  job.promise=(damm?dammPumpApi('/pairs'):meteora?meteoraApi('/pairs'):pump?(pumpPublic?pumpPublicApi('/pairs'):pumpApi('/pairs')):api('/quotes')).then(r=>{
    if(disposed||venue!==venueVersion||current!==sessionGeneration)return;
    if(pump&&!pumpPublic&&r.mode!=='local-test')throw Error('Private pair catalogue unavailable.');
    const rows=pump||meteora||damm?r.pairs:r.assets;if(!Array.isArray(rows))throw Error('Pair catalogue unavailable.');
    canViewComingSoon=!pump&&!meteora&&!damm&&r.canViewComingSoon===true;catalogueReady=true;catalogueFailed=false;catalogueRetryDelay=5000;clearTimeout(catalogueRetryTimer);catalogueRetryTimer=null;
    assets=rows.filter(a=>a&&typeof a.mint==='string'&&(damm?dammPumpCatalogueRow(a):meteora?meteoraCompatible(a):pump?pumpCompatible(a):canViewComingSoon||a.supported===true));
    // A disappearing/temporarily unverifiable selection stays selected. Never
    // rewrite a draft or a prepared/signed transaction to the native SOL pair.
    const currentAsset=assets.find(a=>a.mint===asset.mint);
    asset=currentAsset?{...currentAsset,catalogueUnavailable:damm?!dammPumpCompatible(currentAsset):meteora?!meteoraCompatible(currentAsset):pump?!pumpCompatible(currentAsset):currentAsset.supported!==true}:{...asset,supported:null,catalogueUnavailable:true,catalogueFallback:false,supportReason:'This pair could not be verified. Try again shortly or choose another asset.'};
    // Raydium's list came back without SOL or USDC (the server could not check availability): keep the native pair chosen so the
    // form stays usable; the launch waits for a list that carries it, and the retry below asks again soon.
    if(!pump&&!meteora&&!damm&&!currentAsset&&nativePairs.has(asset.mint)){asset=nativePairFallback(asset.mint);scheduleCatalogueRetry();}
    $('launch-catalogue-note').textContent=r.notice||(damm?'Only pairs compatible with Meteora and PumpSwap are offered.':meteora?'Only pairs verified for Meteora launch and migration are shown.':pump?(pumpPublic?'Only configured launch pairs are shown.':'Verified separately from Raydium. Local compatibility testing only; funded launches remain disabled.'):'Availability is checked before launch.');
    const results=$('launch-asset-results'),dialog=$('launch-asset-dialog'),scrollTop=results.scrollTop,dialogScrollTop=dialog.scrollTop;
    syncForm();renderAssets();results.scrollTop=scrollTop;dialog.scrollTop=dialogScrollTop;
  }).catch(e=>{
    if(disposed||venue!==venueVersion||current!==sessionGeneration||e.cancelled)return;
    catalogueFailed=true;if(!catalogueReady)scheduleCatalogueRetry();
    if(e.status===401||e.status===403){canViewComingSoon=false;assets=assets.filter(venueCompatible);renderAssets();}
    // Keep the last list and the current draft during a transient read failure.
    // Actual launch preparation still validates the selected pair on-chain.
    renderAssets();
    $('launch-catalogue-note').textContent=catalogueReady?'Showing the last checked pair list. Retrying automatically.':'Pair availability is temporarily unavailable. Retrying automatically.';syncForm();
  }).finally(()=>{if(cataloguePending===job)cataloguePending=null;});
  cataloguePending=job;return job.promise;
}
// A first pair read that failed, or a Raydium list that came back without SOL and USDC, is asked again after 5 s, then 10, 20, 40
// and every minute (the minute timer), instead of waiting for the next timer tick: the launch should not wait a minute because
// one read failed. A failed refresh of a list already shown keeps the last list and waits for the timer, as before.
function scheduleCatalogueRetry(){
  if(disposed||catalogueRetryTimer)return;
  catalogueRetryTimer=setTimeout(()=>{catalogueRetryTimer=null;if(disposed)return;catalogueCheckedAt=null;if(document.hidden)return;catalogueRetryDelay=Math.min(catalogueRetryDelay*2,60000);void refreshCatalogue();},catalogueRetryDelay);
}
// Raydium's native pairs while its list is loading, failed to load, or came back without them: SOL and USDC can be chosen from
// the built-in entries (the launch is prepared only once a list carries the pair, and prepare verifies it on chain again).
const raydiumPairFallback=()=>isRaydium()&&(!catalogueReady||!assets.some(a=>nativePairs.has(a.mint)));
function nativePairFallback(mint){const native=LAUNCH_ASSETS.find(a=>a.mint===mint);return native?{...native,supported:null,catalogueUnavailable:false,catalogueFallback:true,supportReason:''}:null;}
// Pump.fun pairs: SOL plus every quote asset Pump.fun admits for new coins, read
// live by the server (cached there). Unavailable pairs stay listed with why. A
// selection Pump.fun no longer offers falls back to SOL; nothing is signed here.
function applyPumpClassicPairs(r){
  if(r?.available!==true||!Array.isArray(r.pairs))throw Object.assign(Error(r?.reason||'Pump.fun pairs are unavailable.'),{status:503});
  const rows=r.pairs.filter(a=>a&&typeof a.mint==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a.mint)&&a.pumpClassic===true).map(a=>({...a}));
  if(!rows.some(a=>a.mint===SOL_MINT))throw Error('Pump.fun pairs are unavailable.');
  assets=rows;catalogueReady=true;catalogueFailed=r.stale===true;canViewComingSoon=false;
  const previous=asset;asset=assets.find(a=>a.mint===asset.mint&&pumpClassicPairReady(a))||assets.find(a=>a.mint===SOL_MINT);
  if(asset.mint!==previous.mint){$('launch-pump-classic-buy').value='0';$('launch-pump-classic-fee').value='0';pumpClassicBuyMint=asset.mint;if(previous.mint!==SOL_MINT)$('launch-pump-classic-note').textContent=(previous.symbol||'That pair')+' is not offered right now, so the pair is SOL again. Enter the dev buy again.';}
  $('launch-catalogue-note').textContent=r.notice||'Pairs Pump.fun admits for new coins, read live from Pump.fun. Unavailable pairs show why.';
}
/** The pair list read in this session within the last two minutes, if any. */
function cachedPumpClassicPairs(){const c=pumpClassicPairsCache;return c&&c.generation===sessionGeneration&&Date.now()-c.at<120000?c:null;}
/** Reads the pair list ahead of time (once the Pump.fun venue is available), so choosing Pump.fun shows every pair at once. */
function prefetchPumpClassicPairs(){
  if(disposed||!csrf||!launchSessionReady||cachedPumpClassicPairs()||pumpClassicPairsPrefetch||isPumpClassic())return;
  const generation=sessionGeneration;
  pumpClassicPairsPrefetch=pumpClassicApi('/pairs').then(r=>{if(!disposed&&generation===sessionGeneration&&r?.available===true&&Array.isArray(r.pairs))pumpClassicPairsCache={generation,at:Date.now(),result:r};}).catch(()=>{}).finally(()=>{pumpClassicPairsPrefetch=null;});
}
function refreshPumpClassicPairs(){
  const current=sessionGeneration,venue=venueVersion,sol=LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT);
  if(cataloguePending?.generation===current&&cataloguePending.venue===venue)return cataloguePending.promise;
  if(catalogueReady&&catalogueCheckedAt!==null&&Date.now()-catalogueCheckedAt<60000)return Promise.resolve();
  catalogueCheckedAt=Date.now();if(!assets.length){assets=[{...sol,pumpClassic:true,launchReady:true,kind:'sol',convertible:true,maxDevBuy:String(PUMP_CLASSIC_LIMITS.maxDevBuySol)}];asset=assets[0];}
  const job={generation:current,venue};
  job.promise=pumpClassicApi('/pairs').then(r=>{
    if(disposed||venue!==venueVersion||current!==sessionGeneration)return;
    applyPumpClassicPairs(r);pumpClassicPairsCache={generation:current,at:Date.now(),result:r};
    const results=$('launch-asset-results'),dialog=$('launch-asset-dialog'),scrollTop=results.scrollTop,dialogScrollTop=dialog.scrollTop;
    syncForm();renderAssets();results.scrollTop=scrollTop;dialog.scrollTop=dialogScrollTop;
  }).catch(e=>{
    if(disposed||venue!==venueVersion||current!==sessionGeneration||e.cancelled)return;
    catalogueFailed=true;catalogueReady=true;catalogueCheckedAt=Date.now()-45000;
    $('launch-catalogue-note').textContent='Pump.fun pairs could not be loaded. SOL is available; retrying automatically.';syncForm();renderAssets();
  }).finally(()=>{if(cataloguePending===job)cataloguePending=null;});
  cataloguePending=job;return job.promise;
}
const catalogueVisible=()=>{if(!disposed&&!document.hidden)return Promise.all([refreshCatalogue(),refreshMeteoraAccess(),refreshDammPumpAccess(),refreshPumpClassicAccess()]);};document.addEventListener('visibilitychange',catalogueVisible);window.addEventListener('focus',catalogueVisible);
// The minute timer: venue status and small pair lists every minute, Raydium's large list on its longer interval.
const catalogueTick=()=>{if(!disposed&&!document.hidden)return Promise.all([refreshCatalogue({background:true}),refreshMeteoraAccess(),refreshDammPumpAccess(),refreshPumpClassicAccess()]);};
function clearCatalogue(){catalogueCheckedAt=null;cataloguePending=null;canViewComingSoon=false;catalogueReady=false;catalogueFailed=false;assets=[];category='all';if(!nativePairs.has(asset.mint))asset=LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT);$('launch-asset-search').value='';$('launch-catalogue-note').textContent='';renderAssets();}
$('launch-hooks-toggle').onclick=()=>{hooksOpen=!hooksOpen;syncHookRules();if(hooksOpen)$('launch-hooks-body').querySelector('.launch-hook-rule input:not(:disabled)')?.focus?.({preventScroll:true});};
$('launch-asset-open').onclick=()=>{renderAssets();$('launch-asset-dialog').showModal();$('launch-asset-search').focus();refreshCatalogue();};$('launch-asset-close').onclick=()=>$('launch-asset-dialog').close();$('launch-asset-search').oninput=renderAssets;
for(const b of document.querySelectorAll('[data-category]'))b.onclick=()=>{if(b.dataset.category==='coming'&&!(isDammPump()?assets.some(dammPumpComingSoon):canViewComingSoon))return;category=b.dataset.category;for(const c of document.querySelectorAll('[data-category]'))c.setAttribute('aria-pressed',String(c===b));renderAssets();};
async function pumpApi(path='',body){
  const generation=sessionGeneration,venue=venueVersion,account=launchSessionAccount,token=csrf;
  const check=()=>{if(disposed||generation!==sessionGeneration||venue!==venueVersion||account!==launchSessionAccount||token!==csrf)throw Object.assign(Error('Private test cancelled because the account or venue changed.'),{cancelled:true});};
  if(!token)throw Error('Sign in to access private testing.');
  const response=await pageFetch('/api/admin/pump-test'+path,{method:body?'POST':'GET',headers:{'x-control-token':token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});check();const value=await response.json();check();if(!response.ok){if([401,403].includes(response.status)&&pumpAllowed){resetPumpAccess();clearCatalogue();syncForm();refreshCatalogue();}const e=Error(value.error||'Private test unavailable.');e.status=response.status;throw e;}return value;
}
async function pumpPublicApi(path='',body){
  const generation=sessionGeneration,venue=venueVersion,account=launchSessionAccount,token=csrf;
  const check=()=>{if(disposed||generation!==sessionGeneration||venue!==venueVersion||account!==launchSessionAccount||token!==csrf)throw Object.assign(Error('Your account or launch venue changed.'),{cancelled:true});};
  const response=await pageFetch('/api/launchpad/pump'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'x-control-token':token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});check();const result=await response.json();check();if(!response.ok)throw Object.assign(Error(result.error||'PumpSwap is temporarily unavailable.'),{status:response.status,code:result.code,retryAfterMs:result.retryAfterMs});return result;
}
async function dammPumpApi(path='',body){
  const generation=sessionGeneration,venue=venueVersion,account=launchSessionAccount,token=csrf;
  const check=()=>{if(disposed||generation!==sessionGeneration||venue!==venueVersion||account!==launchSessionAccount||token!==csrf)throw Object.assign(Error('Your account or launch venue changed.'),{cancelled:true});};
  const response=await pageFetch('/api/launchpad/damm-pump'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'x-control-token':token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});check();const result=await response.json();check();if(!response.ok)throw Object.assign(Error(result.error||'This launch is temporarily unavailable.'),{status:response.status,code:result.code,retryAfterMs:result.retryAfterMs});return result;
}
function refreshDammPumpAccess({force=false}={}){
  if(disposed||!csrf||!launchSessionReady)return Promise.resolve(false);const generation=sessionGeneration,venue=venueVersion;
  if(dammPumpStatusPending?.generation===generation&&dammPumpStatusPending.venue===venue)return dammPumpStatusPending.promise;
  if(!force&&dammPumpStatusCheckedAt!==null&&Date.now()-dammPumpStatusCheckedAt<60000)return Promise.resolve(dammPumpAllowed());
  dammPumpStatusCheckedAt=Date.now();const job={generation,venue};job.promise=checkDammPumpAccess().catch(error=>{if(!disposed&&generation===sessionGeneration&&venue===venueVersion&&!error.cancelled){dammPumpStatus={available:false,reason:error.message};syncForm();}return false;}).finally(()=>{if(dammPumpStatusPending===job)dammPumpStatusPending=null;});dammPumpStatusPending=job;return job.promise;
}
async function checkDammPumpAccess(){
  const generation=sessionGeneration,venue=venueVersion,status=await dammPumpApi('/status');if(disposed||generation!==sessionGeneration||venue!==venueVersion)return false;
  dammPumpStatus=status;if(dammPumpController){await refreshDammPumpSaved();syncForm();return dammPumpAllowed();}const module=await import('./damm-pump-ui.mjs');if(disposed||generation!==sessionGeneration||venue!==venueVersion)return false;
  const input=()=>{
    const raw=rawInput();if(!dammPumpAllowed())throw Error(dammPumpReason());if(pairUnavailable(asset))throw Error(asset.supportReason||'Choose an available pair.');if(!imageId||imageBusy)throw Error('Add your coin image before continuing.');const details=coinDetails(),links=coinLinks(raw);
    return{action:'initialize',name:details.name,symbol:details.symbol,description:details.description,image:'/token-images/'+imageId,website:links.website,twitter:links.twitter,telegram:links.telegram,quoteMint:asset.mint,firstBuySolLamports:module.dammPumpDecimalRaw($('launch-damm-pump-buy').value||'0',9),slippageBps:100};
  };
  dammPumpController=module.createDammPumpOperation({document,root:$('launch-damm-pump-operation'),request:dammPumpApi,wallet:launchWallet,launchFlow:true,getLaunchInput:input,context:()=>({active:isDammPump()&&$('launch-damm-pump-dialog').open,key:launchSessionAccount+':'+csrf,quoteMint:asset.mint,quoteSymbol:asset.symbol,quoteDecimals:asset.decimals}),onChange:()=>{
    const operation=dammPumpController?.operation,created=operation?.action==='initialize'&&['confirmed','finalized'].includes(operation?.state);if(created){dammPumpSavedOperation=null;dammPumpResumeButton.hidden=true;}$('launch-damm-pump-buy-wrap').hidden=created;$('launch-damm-pump-terms').hidden=created;$('launch-damm-pump-buy').disabled=dammPumpController?.inputLocked||false;if(dammPumpController?.inputLocked&&operation?.review){const sol=operation.review.fundingMode==='sol';$('launch-damm-pump-buy-symbol').textContent=sol?'SOL':operation.review.quoteSymbol||asset.symbol;$('launch-damm-pump-buy').value=module.dammPumpUnits(sol?operation.review.firstBuySolLamports:operation.review.firstBuyRaw,sol?9:operation.review.quoteDecimals);}else $('launch-damm-pump-buy-symbol').textContent='SOL';$('launch-damm-pump-title').textContent=created?'Your coin is live':'Launch with PumpSwap graduation';paintFlow($('launch-damm-pump-dialog'),operation);syncNavigationFree();
  },onStartAnotherLaunch:saved=>{dammPumpDeferredLaunchMints.add(saved.mint);dammPumpSavedOperation=null;dammPumpResumeButton.hidden=true;$('launch-damm-pump-buy').value='0';},onOpenCoin:()=>{$('launch-damm-pump-dialog').close();},onConfirmed:venueStepDone,onFinalized:venueStepDone});
  $('launch-damm-pump-buy').oninput=()=>{dammPumpController.schedulePrepare(400);syncForm();};await refreshDammPumpSaved();syncForm();return dammPumpAllowed();
}
// Presentation only: show the saved operation's stage in the dialog step track.
function paintFlow(dialog,operation){
  const track=dialog?.querySelector('.launch-flow-track');if(!track)return;
  const action=operation?.action,state=operation?.state,live=action==='initialize'&&['confirmed','finalized'].includes(state);
  // A hooked Meteora launch takes three approvals: the track gains a "Hook setup" step between Setup and Create coin
  // (review.stage === 'hook-setup' is that second configure-kind stage; review.stages === 3 marks the first one).
  const hookStep=track.querySelector('[data-flow-step=hooks]'),hookSetup=operation?.review?.stage==='hook-setup',hooked=!!hookStep&&(hookSetup||operation?.review?.stages===3||!operation&&hookChosen());
  if(hookStep){hookStep.hidden=!hooked;track.classList.toggle('is-hooked',hooked);}
  const afterSetup=state==='finalized'&&(operation?.nextAction==='initialize'||action==='configure'&&!operation?.nextAction);
  const current=live?'live':action==='initialize'||afterSetup&&(!hooked||hookSetup)?'create':hooked&&(hookSetup||afterSetup)?'hooks':'setup',order=hooked?['setup','hooks','create','live']:['setup','create','live'];
  track.dataset.flow=current;track.dataset.state=live?'live':['failed','expired'].includes(state)?'error':state==='awaiting_signature'?'approve':operation&&state!=='cancelled'&&state!=='finalized'?'confirming':'idle';
  for(const item of track.querySelectorAll('[data-flow-step]')){const index=order.indexOf(item.dataset.flowStep),at=order.indexOf(current);item.classList.toggle('is-done',live||index<at);if(!live&&index===at)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');}
}
function resetDammPumpAccess(){dammPumpSavedOperation=null;dammPumpSavedPending=null;dammPumpResumeButton.hidden=true;dammPumpController?.destroy();dammPumpController=null;dammPumpStatus=null;dammPumpStatusPending=null;dammPumpStatusCheckedAt=null;$('launch-damm-pump-dialog').close();}
function savedDammPumpOperation(operations,{paidOnly=false}={}){
  return [...(operations||[])].reverse().find(value=>{
    const r=value?.review;if(!value||dammPumpDeferredLaunchMints.has(value.mint)||value.wallet!==launchWallet.state().address||!['configure','prepare-buy','fund-quote','initialize'].includes(value.action)||!['awaiting_signature','submitted','confirmed','pending','journaled','finalized'].includes(value.state)||value.action==='initialize'&&value.state==='finalized'||!/^[a-zA-Z0-9_-]{8,128}$/.test(value.id||'')||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.mint||'')||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r?.quoteMint||'')||!Number.isInteger(r.quoteDecimals)||r.quoteDecimals<0||r.quoteDecimals>18)return false;
    return !paidOnly||value.state!=='awaiting_signature'||value.action!=='configure'&&r.configurationCreated===true;
  });
}
async function refreshDammPumpSaved(){
  if(disposed||!isDammPump()||!csrf||!launchSessionReady||dammPumpAllowed()||!launchWallet.state().address)return;
  const wallet=launchWallet.state().address;if(dammPumpSavedPending?.wallet===wallet)return dammPumpSavedPending.promise;
  const job={wallet};job.promise=(async()=>{try{const saved=await dammPumpApi('/operations');if(dammPumpSavedPending===job&&wallet===launchWallet.state().address)dammPumpSavedOperation=savedDammPumpOperation(saved.operations,{paidOnly:true});}catch(e){if(!e.cancelled&&dammPumpSavedPending===job)dammPumpSavedOperation=null;}finally{if(dammPumpSavedPending===job){dammPumpSavedPending=null;syncForm();}}})();dammPumpSavedPending=job;return job.promise;
}
async function openDammPump({resumeSaved=false}={}){
  error();try{
    if(!dammPumpController)throw Error(dammPumpReason());if(!launchWallet.state().address){openWallets();return;}
    if(!dammPumpAllowed()&&!resumeSaved)throw Error(dammPumpReason());
    const wallet=launchWallet.state().address,saved=await dammPumpApi('/operations');if(wallet!==launchWallet.state().address)throw Object.assign(Error('Wallet changed. Reconnect the launch wallet to continue.'),{cancelled:true});
    const pending=savedDammPumpOperation(saved.operations,{paidOnly:!dammPumpAllowed()});
    if(!dammPumpAllowed()){dammPumpSavedOperation=pending||null;syncForm();}
    if(!dammPumpAllowed()&&!pending)throw Error(dammPumpReason());
    if(resumeSaved&&pending){const r=pending.review;asset={...(assets.find(value=>value.mint===r.quoteMint)||{}),mint:r.quoteMint,symbol:r.quoteSymbol||'quote',name:r.quoteSymbol||'Saved launch pair',decimals:r.quoteDecimals};syncForm();}
    if(!pending&&pairUnavailable(asset))throw Error(asset.supportReason||'Choose an available pair.');
    $('launch-damm-pump-buy-symbol').textContent='SOL';$('launch-damm-pump-note').textContent=asset.mint===SOL_MINT?'Launch fees and your optional first buy use SOL.':'Pay in SOL. Launchpad automatically converts it to '+asset.symbol+' for your first buy and pool seed. With no first buy, the pool seed conversion uses 0.0001 SOL. Unused quote tokens stay in your wallet.';
    $('launch-damm-pump-dialog').showModal();dammPumpController.render();if(dammPumpController.operation)return;
    if(pending){
      if(pending.review?.quoteMint!==asset.mint){$('launch-damm-pump-dialog').close();error('An unfinished launch is saved with '+(pending.review?.quoteSymbol||'another quote asset')+'. Select that pair to resume it before starting another launch.');return;}
      if(dammPumpController.restore(pending)){if(pending.review?.fundingMode!=='sol')$('launch-damm-pump-note').textContent='Resuming your saved launch. Its first buy is '+displayUnits(BigInt(pending.review?.firstBuyRaw||'0'),pending.review?.quoteDecimals)+' '+(pending.review?.quoteSymbol||asset.symbol)+'.';if(pending.state==='awaiting_signature'&&pending.action==='configure'){await dammPumpController.cancelUnsigned();if(dammPumpController.operation?.state==='awaiting_signature')return;}else{if(pending.state!=='awaiting_signature'&&pending.state!=='finalized')await dammPumpController.reconcile();return;}}
    }
    if(!dammPumpAllowed())throw Error(dammPumpReason());if(!imageId||imageBusy)throw Error('Add your coin image before continuing.');coinDetails();coinLinks(rawInput());dammPumpController.schedulePrepare(0);
  }catch(e){if(!e.cancelled){error(e.message);$('launch-damm-pump-note').textContent=e.message;}}
}
dammPumpResumeButton.onclick=()=>openDammPump({resumeSaved:true});
async function closeDammPump(){if(dammPumpController?.busy)return;if(dammPumpController?.operation?.state==='awaiting_signature'){await dammPumpController.cancelUnsigned();if(dammPumpController.operation?.state==='awaiting_signature')return;}$('launch-damm-pump-dialog').close();}
$('launch-damm-pump-close').onclick=closeDammPump;$('launch-damm-pump-dialog').addEventListener('cancel',event=>{event.preventDefault();void closeDammPump();});
// ---- Pump.fun -------------------------------------------------------------
// Native Pump.fun coins created by Launchpad. The server owns the per-coin wallets
// and every chain step; this page collects the launch details, shows the quote
// and asks the connected wallet to sign one funding transfer.
async function pumpClassicApi(path='',body){
  const generation=sessionGeneration,account=launchSessionAccount,token=csrf;
  const check=()=>{if(disposed||generation!==sessionGeneration||account!==launchSessionAccount||token!==csrf)throw Object.assign(Error('Your account changed. Review this launch before continuing.'),{cancelled:true});};
  if(!token)throw Error('Connect your wallet to launch on Pump.fun.');
  let response;
  try{response=await pageFetch('/api/launchpad/pump-classic'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'x-control-token':token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch(e){
    // Readable wording for a dropped connection, a slow answer or a server page that is not the API's reply.
    if(e?.cancelled)throw e;
    if(e instanceof TypeError||e?.name==='TypeError')throw Object.assign(Error('Launchpad could not be reached. Check your connection and try again.'),{status:503,cause:e});
    if(e?.code==='LAUNCH_REQUEST_TIMEOUT')throw Object.assign(Error('Pump.fun is taking too long to answer. Try again in a moment.'),{status:408,code:e.code,cause:e});
    if(e?.status>=500)throw Object.assign(Error('Pump.fun launches are temporarily unavailable. Try again in a moment.'),{status:e.status,cause:e});
    throw e;
  }
  check();let result;try{result=await response.json();}catch{throw Object.assign(Error('Pump.fun launches are temporarily unavailable. Please try again.'),{status:503});}check();if(!response.ok)throw Object.assign(Error(result?.error||'Pump.fun launches are temporarily unavailable.'),{status:response.status,code:result?.code});return result;
}
function refreshPumpClassicAccess({force=false}={}){
  if(disposed||!csrf||!launchSessionReady)return Promise.resolve(false);const generation=sessionGeneration;
  if(pumpClassicStatusPending?.generation===generation)return pumpClassicStatusPending.promise;
  if(!force&&pumpClassicStatusCheckedAt!==null&&Date.now()-pumpClassicStatusCheckedAt<60000)return Promise.resolve(pumpClassicAllowed());
  pumpClassicStatusCheckedAt=Date.now();const job={generation};job.promise=checkPumpClassicAccess().catch(error=>{if(!disposed&&generation===sessionGeneration&&!error.cancelled){pumpClassicStatus={available:false,reason:error.status===404?'Pump.fun launches are not available on this host.':error.message};syncForm();}return false;}).finally(()=>{if(pumpClassicStatusPending===job)pumpClassicStatusPending=null;});pumpClassicStatusPending=job;return job.promise;
}
async function checkPumpClassicAccess(){
  const generation=sessionGeneration,status=await pumpClassicApi('/status');if(disposed||generation!==sessionGeneration)return false;
  pumpClassicStatus=status;if(status?.available===true&&status.pairsOpen!==false)prefetchPumpClassicPairs();
  if(status?.available===true&&!pumpClassicController){
    const module=await import('./pump-classic-ui.mjs');if(disposed||generation!==sessionGeneration||pumpClassicController)return pumpClassicAllowed();
    pumpClassicController=module.createPumpClassicLaunch({document,window,root:$('launch-pump-classic-operation'),request:pumpClassicApi,wallet:launchWallet,getInput:pumpClassicInput,
      context:()=>({active:$('launch-pump-classic-dialog').open}),onChange:pumpClassicChanged,connectWallet:openWallets,
      // The dev buy, seed and fee are fixed while their quote or funding request runs; from then on the request's own
      // status speaks, so a note left from opening the dialog is cleared (it would repeat the same message).
      onBusy:busy=>{for(const id of ['launch-pump-classic-buy','launch-pump-classic-seed','launch-pump-classic-fee'])$(id).disabled=busy;if(busy)$('launch-pump-classic-note').textContent='';syncNavigationFree();},
      coinLink:l=>l.mode==='agent'?'/coin?mint='+encodeURIComponent(l.mint)+(agentFundingSol()>0?'&fund=activity&amount='+encodeURIComponent(String(agentFundingSol())):'')+'#agent':'/coin?mint='+encodeURIComponent(l.mint),
      // Quotes, state changes and cancellations show in "Your coins" at once.
      onUpdate:()=>void loadPumpClassicLaunches(),
      onLive:l=>{$('launch-toast').hidden=false;$('launch-toast-link').href='/coin?mint='+encodeURIComponent(l.mint);clearLaunchedForm({name:l.name,symbol:l.symbol});}});
    // Pick up a launch that is already funded or waiting, so it can be followed after a reload.
    try{await pumpClassicController.restore();}catch{}
    void loadPumpClassicLaunches();
  }
  syncForm();return pumpClassicAllowed();
}
// A quote still being prepared when its dialog was closed is cancelled as soon as it arrives.
let pumpClassicDiscard=false;
function pumpClassicChanged(){
  const c=pumpClassicController;
  if(pumpClassicDiscard&&c&&!c.busy){pumpClassicDiscard=false;if(!$('launch-pump-classic-dialog').open&&c.launch?.state==='awaiting_funding'&&!c.signedPending)void c.startOver();}
  syncForm();
}
let pumpClassicListLoad=null,pumpClassicListAgain=false;
/** Reads this account's Pump.fun launches for "Your coins"; overlapping reads are joined, and one more runs after. */
function loadPumpClassicLaunches(){
  if(disposed||!csrf||!pumpClassicStatus?.available)return Promise.resolve();
  if(pumpClassicListLoad){pumpClassicListAgain=true;return pumpClassicListLoad;}
  const generation=sessionGeneration;
  pumpClassicListLoad=(async()=>{
    try{const result=await pumpClassicApi('/launches');if(disposed||generation!==sessionGeneration)return;pumpClassicLaunches=Array.isArray(result?.launches)?result.launches.filter(l=>/^[a-f0-9]{24}$/.test(l?.id||'')&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(l?.mint||'')):[];renderList();}catch{}
    finally{pumpClassicListLoad=null;if(pumpClassicListAgain&&!disposed){pumpClassicListAgain=false;void loadPumpClassicLaunches();}}
  })();
  return pumpClassicListLoad;
}
function resetPumpClassicAccess(){pumpClassicController?.destroy();pumpClassicController=null;pumpClassicStatus=null;pumpClassicStatusPending=null;pumpClassicStatusCheckedAt=null;pumpClassicLaunches=[];pumpClassicDiscard=false;$('launch-pump-classic-dialog').close();}
function pumpClassicFeeNote(mode){
  const link=node('a','Fees & revenue');link.href=PUMP_CLASSIC_FEE_LINK;link.target='_blank';link.rel='noopener';const block=pumpClassicModeBlock(mode),pair=asset?.mint&&asset.mint!==SOL_MINT?asset.symbol:'';
  const lead=block||(PUMP_CLASSIC_MODE_SUMMARIES[mode]||'Choose a launch option.')+(pair?mode==='creator'?' Your share is paid in '+pair+'.':mode==='holders'?' Rewards are paid in '+pair+'; Launchpad sells only a small part for holders’ new '+pair+' accounts and network fees.':' Fees arrive in '+pair+'; Launchpad converts them to SOL before paying them out.':'');
  $('launch-fee-note').replaceChildren(document.createTextNode(lead+' A platform share of creator fees applies to every Pump.fun option; see '),link,document.createTextNode(' in the docs.'));
}
/** A typed amount as plain decimal text: ".5" is 0.5 and "1." is 1, like the other venues; a decimal comma is refused by name. */
function plainAmount(value,label){const text=String(value??'').trim();if(/,/.test(text))throw Error('Use a dot for decimals in the '+label+', like 1.5.');return text.replace(/^\./,'0.').replace(/^(\d+)\.$/,'$1')||'0';}
const pumpClassicSol=(id,label,max)=>{const text=plainAmount($(id).value,label);if(!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,9})?$/.test(text))throw Error('Enter the '+label+' as a SOL amount with up to 9 decimals.');if(Number(text)>max)throw Error('The '+label+' can be at most '+max+' SOL.');return text;};
/** Whether the selected Pump.fun pair takes its dev buy in SOL (SOL itself, or another pair where Launchpad buys the pair asset). */
/** A policy limit in basis points as a short percentage (the pair row's value, else the given default). */
function pumpClassicPercent(bps,fallback){const value=Number.isSafeInteger(bps)&&bps>=0&&bps<=10000?bps:fallback;return (value/100).toLocaleString('en-US',{maximumFractionDigits:2})+'%';}
const pumpClassicDevBuyInSol=a=>!a||a.mint===SOL_MINT||a.devBuyIn==='SOL';
/** The dev buy as text: SOL for SOL and for pairs Launchpad converts, else the selected pair's units; checked against decimals and the server-published cap. */
function pumpClassicDevBuy(){
  const a=asset,inSol=pumpClassicDevBuyInSol(a),text=plainAmount($('launch-pump-classic-buy').value,'dev buy'),decimals=inSol?9:a.decimals,symbol=inSol?'SOL':a.symbol;
  if(inSol&&a.mint!==SOL_MINT){
    if(!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,9})?$/.test(text))throw Error('Enter the dev buy as a SOL amount with up to 9 decimals.');
    if(compareDecimal(text,'0')>0&&a.devBuyAvailable===false)throw Error('A dev buy is not available on '+a.symbol+' right now because Launchpad cannot buy it with SOL. Launch without a dev buy or choose another pair.');
    const max=String(a.maxDevBuySol||PUMP_CLASSIC_LIMITS.maxDevBuySol);if(compareDecimal(text,max)>0)throw Error('The dev buy can be at most '+max+' SOL.');
    return text;
  }
  if(pumpClassicBuyMint!==a.mint){$('launch-pump-classic-buy').value='0';pumpClassicBuyMint=a.mint;if(!/^0*(?:\.0*)?$/.test(text))throw Error('The pair changed after you entered the dev buy. Enter it again in '+symbol+'.');}
  if(!Number.isInteger(decimals)||decimals<0||decimals>12)throw Error('This pair is not available right now. Choose another pair.');
  const pattern=decimals?new RegExp('^(?:0|[1-9]\\d{0,14})(?:\\.\\d{1,'+decimals+'})?$'):/^(?:0|[1-9]\d{0,14})$/;
  if(!pattern.test(text))throw Error(decimals?'Enter the dev buy as a '+symbol+' amount with up to '+decimals+' decimals.':'Enter the dev buy as a whole number of '+symbol+'.');
  const max=String(a.maxDevBuy||(a.mint===SOL_MINT?PUMP_CLASSIC_LIMITS.maxDevBuySol:'0'));if(compareDecimal(text,max)>0)throw Error('The dev buy can be at most '+max+' '+symbol+'.');
  return text;
}
/** Compares two non-negative decimal strings exactly. */
function compareDecimal(a,b){const [ai,af='']=String(a).split('.'),[bi,bf='']=String(b).split('.'),width=Math.max(af.length,bf.length),x=BigInt(ai+af.padEnd(width,'0')),y=BigInt(bi+bf.padEnd(width,'0'));return x===y?0:x>y?1:-1;}
/** Creator-fee options for a custom pair: Pump.fun's standard fee, then rates up to its live limit. */
function syncPumpClassicFeeOptions(){
  const select=$('launch-pump-classic-fee'),max=asset?.kind==='custom'&&Number.isSafeInteger(asset.creatorFee?.maxBps)?asset.creatorFee.maxBps:0,key=String(max);
  $('launch-pump-classic-fee-wrap').hidden=!(isPumpClassic()&&max>0);if(select.dataset.max===key)return;
  const current=Number(select.value||0),steps=[...new Set([10,25,50,75,100,150,200,250,300,400,500,750,1000].filter(bps=>bps<max).concat(max>0?[max]:[]))];select.dataset.max=key;select.replaceChildren();
  const standard=node('option','Pump.fun standard');standard.value='0';select.append(standard);
  for(const bps of steps){const option=node('option',(bps/100).toFixed(2).replace(/\.?0+$/,'')+'%');option.value=String(bps);select.append(option);}
  select.value=steps.includes(current)?String(current):'0';
}
function pumpClassicInput(){
  const raw=rawInput(),mode=raw.feeMode;
  if(!pumpClassicAllowed())throw Error(pumpClassicReason());
  if(!imageId||imageBusy)throw Error('Add your coin image before continuing.');
  const details=coinDetails(),links=coinLinks(raw);
  if(!PUMP_CLASSIC_MODES.includes(mode))throw Error('Choose a launch option.');
  if(mode==='gotchi'&&!raw.gotchiId)throw Error('Choose a Gotchi to pair your coin with.');
  if(mode==='agent'){if(!agentCatalog||agentCatalog.unavailable||agentCatalog.intakeOpen===false)throw Error(agentCatalog?.reason||'AI Agent launches are closed right now. Choose another launch option.');if(!raw.agent?.mission)throw Error('Give your agent a mission before launching.');const influencerIssue=influencerProblem();if(influencerIssue)throw Error(influencerIssue);}
  const strategy=PUMP_CLASSIC_STRATEGY_MODES.includes(mode);
  if(pairUnavailable(asset))throw Error(asset.supportReason||'This pair is not available for Pump.fun launches right now. Choose another pair.');
  const block=pumpClassicModeBlock(mode);if(block)throw Error(block);
  // Reward baskets (v71.35): Holders only; the shared catalogue and the step's own check run before anything is prepared.
  const basket=basketExtras();if(basket.length){if(mode!=='holders')throw Error('A reward basket is for Holders launches. Choose Holders, or remove the basket.');const problem=basketProblem();if(problem)throw Error(problem);}
  const pair=asset.mint!==SOL_MINT,fee=pair&&asset.kind==='custom'&&asset.creatorFee?Number($('launch-pump-classic-fee').value||0):0;
  return{mode,name:details.name,symbol:details.symbol,description:details.description,image:'/token-images/'+imageId,website:links.website,twitter:links.twitter,telegram:links.telegram,
    ...(pair?{quoteMint:asset.mint,...(pumpClassicDevBuyInSol(asset)?{devBuySol:pumpClassicDevBuy()}:{devBuyAmount:pumpClassicDevBuy()}),...(fee>0?{creatorFeeBps:fee}:{})}:{devBuySol:pumpClassicDevBuy()}),seedSol:strategy&&!pair?pumpClassicSol('launch-pump-classic-seed','seed capital',PUMP_CLASSIC_LIMITS.maxSeedSol):'0',
    ...(mode==='gotchi'?{gotchiId:raw.gotchiId}:{}),...(mode==='agent'?{agent:raw.agent}:{}),...(PUMP_CLASSIC_OPTION_MODES.includes(mode)?{option:pumpClassicOptionInput(mode)}:{}),...(basket.length?{basket}:{})};
}
// ---- Pump.fun launch-option settings (v71.35: Diamond Hands, Earned, Insured) -------------------------------------
// The panels are built from the catalogue (one field per setting, with its range and default) and validated by it, so
// the launch page, the server and the coin page agree on every number. The live line under the fields describes the
// rules with the typed numbers, or names the problem.
const pumpOptionFields=new Map();
function renderPumpOptionPanels(){
  const wrap=$('launch-pump-classic-option-wrap');if(!wrap||wrap.dataset.ready==='true')return;wrap.dataset.ready='true';
  for(const mode of PUMP_CLASSIC_OPTION_MODES){
    const item=PUMP_OPTIONS[mode],fields=new Map(),set=node('fieldset');set.className='launch-pump-option';set.dataset.pumpOption=mode;set.hidden=true;
    set.append(node('legend',item.name+' settings'));
    for(const f of item.settings){
      const id='launch-pc-'+mode.replace(/_/g,'-')+'-'+f.key.toLowerCase(),label=node('label',f.label);label.htmlFor=id;
      let input;
      if(f.options){input=node('select');f.options.forEach((value,i)=>{const option=node('option',f.labels?.[i]||String(value));option.value=String(value);input.append(option);});input.value=String(f.value);}
      else{input=node('input');input.type='number';input.inputMode='decimal';input.min=String(f.min);input.max=String(f.max);input.step=String(f.step);input.value=String(f.value);}
      input.id=id;input.dataset.key=f.key;input.setAttribute('aria-describedby',id+'-hint');fields.set(f.key,input);
      const row=node('div');row.className=f.options?'launch-pump-option-choice':'launch-sol-input';row.append(input);if(!f.options&&f.unit)row.append(node('span',f.unit));
      const hint=node('p',f.hint||'');hint.className='help';hint.id=id+'-hint';if(!f.hint)hint.hidden=true;
      set.append(label,row,hint);
    }
    const help=node('p');help.className='help launch-pump-option-help';help.setAttribute('role','status');set.append(help);
    wrap.append(set);pumpOptionFields.set(mode,fields);
  }
  for(const type of ['input','change'])wrap.addEventListener(type,()=>{$('launch-pump-classic-note').textContent='';syncForm();});
}
/** The settings typed for an option mode, as the catalogue validates them. */
function pumpOptionRaw(mode){const fields=pumpOptionFields.get(mode),out={};for(const [key,input] of fields||[])out[key]=input.value;return out;}
/** The validated option for the launch request (null for modes without settings); throws the catalogue's message. */
function pumpClassicOptionInput(mode){if(!PUMP_CLASSIC_OPTION_MODES.includes(mode))return null;renderPumpOptionPanels();return pumpOptionRequest(mode,{settings:pumpOptionRaw(mode)});}
/** Shows the chosen option's panel (until a quote fixes the settings) with its live description or its problem. */
function syncPumpOptionPanel(mode,locked){
  renderPumpOptionPanels();const wrap=$('launch-pump-classic-option-wrap');if(!wrap)return;const active=PUMP_CLASSIC_OPTION_MODES.includes(mode)&&!locked;wrap.hidden=!active;
  for(const set of wrap.querySelectorAll('[data-pump-option]')){
    const on=active&&set.dataset.pumpOption===mode;set.hidden=!on;if(!on)continue;
    const help=set.querySelector('.launch-pump-option-help');
    try{help.textContent=describePumpOption(mode,pumpOptionRaw(mode));help.dataset.state='ok';}catch(error){help.textContent=error.message;help.dataset.state='problem';}
    for(const input of set.querySelectorAll('input,select'))input.disabled=!!pumpClassicController?.busy;
  }
}
// Presentation only: inputs show until a quote exists; the quote then fixes them.
function syncPumpClassicDialog(){
  if(!isPumpClassic()&&!$('launch-pump-classic-dialog').open)return;
  const launch=pumpClassicController?.launch,mode=launch?.mode||field('feeMode').value,strategy=PUMP_CLASSIC_STRATEGY_MODES.includes(mode);
  $('launch-pump-classic-inputs').hidden=!!launch;$('launch-pump-classic-terms').hidden=!!launch;
  $('launch-pump-classic-seed-wrap').hidden=!strategy;
  syncPumpOptionPanel(mode,!!launch);
  const pairSymbol=launch?.pair?.symbol||(asset?.mint===SOL_MINT?'SOL':asset?.symbol||'SOL');
  $('launch-pump-classic-option').textContent=(PUMP_CLASSIC_MODE_LABELS[mode]||'Launch option')+' · paired with '+pairSymbol+' · '+(launch?.option?.description||PUMP_CLASSIC_MODE_SUMMARIES[mode]||'');
  const solPaid=pairSymbol!=='SOL'&&pumpClassicDevBuyInSol(asset),unavailable=solPaid&&asset?.devBuyAvailable===false;
  $('launch-pump-classic-buy-unit').textContent=pairSymbol==='SOL'||solPaid?'SOL':pairSymbol;
  $('launch-pump-classic-buy-help').textContent=pairSymbol==='SOL'?'Bought in the same transaction that creates the coin. The tokens go to the wallet you fund from.':unavailable?'A dev buy is not available on '+pairSymbol+' right now because Launchpad cannot buy it with SOL. You can still launch without one.':solPaid?'Paid in SOL; you only need SOL. Once your funding settles, Launchpad buys '+pairSymbol+' with it (at most '+pumpClassicPercent(asset?.devBuySlippageBps,100)+' slippage) and makes the dev buy in the transaction that creates the coin. Your tokens arrive a few seconds later, in the wallet you fund from.':'Paid in '+pairSymbol+' from your wallet and bought in the same transaction that creates the coin. The tokens go to the wallet you fund from; unused '+pairSymbol+' is refunded.';
  let buyText='0';try{buyText=plainAmount($('launch-pump-classic-buy').value,'dev buy');}catch{}if(unavailable&&!launch&&/^\d+(?:\.\d+)?$/.test(buyText)&&compareDecimal(buyText,'0')>0)$('launch-pump-classic-buy').value='0';
  syncPumpClassicFeeOptions();
  $('launch-pump-classic-title').textContent=launch?.state==='created'?'Your coin is live':'Launch on Pump.fun';
  for(const id of ['launch-pump-classic-buy','launch-pump-classic-seed','launch-pump-classic-fee'])$(id).disabled=!!pumpClassicController?.busy;
}
/**
 * Opens the Pump.fun launch dialog. With a launch id it shows that saved launch in whatever state it is in
 * (from "Your coins" or a /launchpad?venue=pump-classic&launchId= link). Looking at a launch needs no wallet;
 * only a new quote and funding ask for one.
 */
async function openPumpClassic(id=''){
  error();pumpClassicDiscard=false;try{
    if(!pumpClassicController){await refreshPumpClassicAccess({force:true});if(!pumpClassicController)throw Error(pumpClassicReason());}
    const c=pumpClassicController;
    if(id){await c.open(id);if(disposed||c!==pumpClassicController)return;$('launch-pump-classic-note').textContent='';if(!$('launch-pump-classic-dialog').open)$('launch-pump-classic-dialog').showModal();syncPumpClassicDialog();c.render();return;}
    if(!c.launch&&!launchWallet.state().address){openWallets();return;}
    $('launch-pump-classic-note').textContent='';$('launch-pump-classic-dialog').showModal();syncPumpClassicDialog();c.render();
    if(c.launch)return;
    const open=await c.restore();syncPumpClassicDialog();if(open)return;
    if(!pumpClassicAllowed())throw Error(pumpClassicReason());
    pumpClassicInput();
  }catch(e){if(!e.cancelled){$('launch-pump-classic-note').textContent=e.message;error(e.message);}}
}
/** A "Your coins" row: switches to Pump.fun if needed and shows that launch. */
function openPumpClassicLaunch(id){
  error();if(!isPumpClassic())chooseVenue('pump-classic');
  if(!isPumpClassic()){error('Finish or close the current launch before opening another one.');return;}
  return openPumpClassic(id);
}
async function closePumpClassic(){
  const c=pumpClassicController;
  // A quote still being prepared can be left: the dialog closes now and the quote is cancelled when it arrives.
  // Funding in progress (a wallet approval or submission) keeps the dialog open.
  if(c?.busy){if(!c.launch){pumpClassicDiscard=true;$('launch-pump-classic-dialog').close();syncForm();}return;}
  // An unfunded quote is cancelled on close (as unsigned requests are elsewhere);
  // a launch that is funded or signed keeps running and is resumed on reopen.
  if(c?.launch?.state==='awaiting_funding'&&!c.signedPending)await c.startOver();
  // A finished launch was only being looked at: the page goes back to following the latest unfinished one, if any.
  if(c?.done){c.reset();void c.restore().then(()=>syncForm(),()=>{});}
  $('launch-pump-classic-dialog').close();syncForm();
}
$('launch-pump-classic-close').onclick=()=>void closePumpClassic();
$('launch-pump-classic-dialog').addEventListener('cancel',event=>{event.preventDefault();void closePumpClassic();});
// Enter in the dev-buy or seed field asks for the quote, like the Review launch button.
for(const id of ['launch-pump-classic-buy','launch-pump-classic-seed'])$(id).addEventListener('keydown',event=>{
  if(event.key!=='Enter'||event.isComposing)return;event.preventDefault();const c=pumpClassicController;if(!c||c.launch||c.busy)return;
  $('launch-pump-classic-operation').querySelector('button.primary:not([hidden])')?.focus();void c.quote();
});
for(const id of ['launch-pump-classic-buy','launch-pump-classic-seed','launch-pump-classic-fee'])$(id).addEventListener('input',()=>{if(id==='launch-pump-classic-buy')pumpClassicBuyMint=asset.mint;$('launch-pump-classic-note').textContent='';syncForm();});
$('launch-pump-classic-fee').addEventListener('change',()=>{$('launch-pump-classic-note').textContent='';syncForm();});
async function meteoraApi(path='',body){
  const generation=sessionGeneration,venue=venueVersion,account=launchSessionAccount,token=csrf;
  const check=()=>{if(disposed||generation!==sessionGeneration||venue!==venueVersion||account!==launchSessionAccount||token!==csrf)throw Object.assign(Error('Your account or launch venue changed.'),{cancelled:true});};
  const response=await pageFetch('/api/launchpad/meteora'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'x-control-token':token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});check();let result;try{result=await response.json();}catch{throw Error('Meteora is temporarily unavailable. Please try again.');}check();if(!response.ok)throw Object.assign(Error(result.error||'Meteora is temporarily unavailable.'),{status:response.status});return result;
}
function refreshMeteoraAccess({force=false}={}){
  if(disposed||!csrf||!launchSessionReady)return Promise.resolve(false);const generation=sessionGeneration,venue=venueVersion;
  if(meteoraStatusPending?.generation===generation&&meteoraStatusPending.venue===venue)return meteoraStatusPending.promise;
  if(!force&&meteoraStatusCheckedAt!==null&&Date.now()-meteoraStatusCheckedAt<60000)return Promise.resolve(meteoraAllowed());
  meteoraStatusCheckedAt=Date.now();const job={generation,venue};job.promise=checkMeteoraAccess().catch(error=>{if(!disposed&&generation===sessionGeneration&&venue===venueVersion&&!error.cancelled){meteoraStatus={available:false,reason:error.message};syncForm();}return false;}).finally(()=>{if(meteoraStatusPending===job)meteoraStatusPending=null;});meteoraStatusPending=job;return job.promise;
}
async function checkMeteoraAccess(){
  const generation=sessionGeneration,venue=venueVersion,status=await meteoraApi('/status');if(disposed||generation!==sessionGeneration||venue!==venueVersion)return false;
  meteoraStatus=status;if(!meteoraAllowed()||meteoraController){syncForm();return meteoraAllowed();}const module=await import('./meteora-ui.mjs');if(disposed||generation!==sessionGeneration||venue!==venueVersion)return false;meteoraModule=module;
  const input=()=>{
    const raw=rawInput();if(!meteoraAllowed())throw Error('Meteora launches are not enabled yet.');if(pairUnavailable(asset))throw Error('Choose an available Meteora pair.');if(!imageId||imageBusy)throw Error('Add your coin image before continuing.');const details=coinDetails(),links=coinLinks(raw);if(!['creator','holders','gotchi','agent'].includes(raw.feeMode))throw Error('Choose Creator, Holders, Gotchi or AI Agent.');if(raw.feeMode==='gotchi'&&!raw.gotchiId)throw Error('Choose a Gotchi to pair your coin with.');if(raw.feeMode==='agent'){if(asset.mint!==SOL_MINT)throw Error('AI Agent launches pair with SOL only.');if(!raw.agent?.mission)throw Error('Give your agent a mission before launching.');const influencerIssue=influencerProblem();if(influencerIssue)throw Error(influencerIssue);}
    // Transfer hook rules (v71.28): validated by the shared catalogue before anything is prepared; a hooked coin's first buy
    // is a separate trade after launch, so none travels with the creation.
    const hook=raw.hook||null;if(hook){if(raw.feeMode==='agent')throw Error('An AI Agent launch cannot carry transfer hook rules. Choose the agent or the rules.');const problem=hookProblem();if(problem)throw Error(problem);hookLaunchRequest(hook);}
    // Reward baskets (v71.33): holder rewards only; the shared catalogue and the step's own check run before anything is prepared.
    const basket=basketExtras();if(basket.length){if(raw.feeMode!=='holders')throw Error('A reward basket is for holder rewards. Choose Holders, or remove the basket.');const problem=basketProblem();if(problem)throw Error(problem);}
    return{action:'initialize',name:details.name,symbol:details.symbol,description:details.description,image:'/token-images/'+imageId,website:links.website,twitter:links.twitter,telegram:links.telegram,feeMode:raw.feeMode,...(raw.feeMode==='gotchi'?{gotchiId:raw.gotchiId}:{}),...(raw.feeMode==='agent'?{agent:raw.agent}:{}),...(currentStart()!=='20k'||TENANT?{start:currentStart()}:{}),quoteMint:asset.mint,amountRaw:hook?'0':module.meteoraDecimalRaw($('launch-meteora-buy').value||'0',asset.decimals),slippageBps:100,...(hook?{hook}:{}),...(basket.length?{basket}:{})};
  };
  meteoraController=module.createMeteoraOperation({document,root:$('launch-meteora-operation'),request:meteoraApi,wallet:launchWallet,launchFlow:true,getLaunchInput:input,context:()=>({active:isMeteora()&&$('launch-meteora-dialog').open,key:launchSessionAccount+':'+csrf,quoteMint:asset.mint,quoteSymbol:asset.symbol,quoteDecimals:asset.decimals}),onChange:()=>{
    const operation=meteoraController?.operation,created=operation?.action==='initialize'&&['confirmed','finalized'].includes(operation?.state),hooked=hookedMeteoraLaunch();$('launch-meteora-buy-wrap').hidden=created;$('launch-meteora-terms').hidden=created;$('launch-meteora-buy').disabled=(meteoraController?.inputLocked||false)||hooked;$('launch-meteora-buy-field').hidden=hooked;$('launch-meteora-hook-note').hidden=!hooked;if(meteoraController?.inputLocked&&operation?.review?.firstBuyRaw!=null&&!hooked)$('launch-meteora-buy').value=module.meteoraUnits(operation.review.firstBuyRaw,operation.review.quoteDecimals);$('launch-meteora-title').textContent=created?'Your coin is live':'Launch on Meteora';paintFlow($('launch-meteora-dialog'),operation);syncNavigationFree();
  },onOpenCoin:()=>{$('launch-meteora-dialog').close();},onConfirmed:venueStepDone,onFinalized:venueStepDone});
  $('launch-meteora-buy').oninput=()=>{meteoraController.schedulePrepare(400);syncForm();};syncForm();return meteoraAllowed();
}
function resetMeteoraAccess(){meteoraController?.destroy();meteoraController=null;meteoraModule=null;meteoraStatus=null;meteoraStatusPending=null;meteoraStatusCheckedAt=null;$('launch-meteora-dialog').close();}
async function openMeteora(){
  error();try{
    if(!meteoraAllowed()||!meteoraController)throw Error(meteoraStatus?.reason||'Meteora launches are not ready yet.');if(pairUnavailable(asset))throw Error('Choose an available Meteora pair.');if(!launchWallet.state().address){openWallets();return;}
    $('launch-meteora-buy-symbol').textContent=asset.symbol;$('launch-meteora-note').textContent=hookChosen()?'Launch fees use SOL. The transfer hook rules you chose are written on chain with the coin; your first buy follows as a separate trade.':asset.mint===SOL_MINT?'Launch fees and your optional first buy use SOL.':'Your optional first buy is paid in '+asset.symbol+' from your wallet, which must already hold it: Launchpad does not buy '+asset.symbol+' for a Meteora launch. Its contract address is '+asset.mint+'. Launch fees use SOL.';
    $('launch-meteora-dialog').showModal();meteoraController.render();if(meteoraController.operation)return;
    const saved=await meteoraApi('/operations'),pending=[...(saved.operations||[])].reverse().find(x=>['configure','fund-quote','initialize'].includes(x.action)&&x.wallet===launchWallet.state().address&&!['failed','expired','cancelled'].includes(x.state)&&(['configure','fund-quote'].includes(x.action)||x.state!=='finalized'));
    if(pending){
      if(pending.review?.quoteMint!==asset.mint){$('launch-meteora-dialog').close();error('An unfinished launch is saved with '+(pending.review?.quoteSymbol||'another quote asset')+'. Select that pair to resume it before starting another launch.');return;}
      if(meteoraController.restore(pending)){
        if(pending.state==='awaiting_signature'&&pending.action==='configure'){await meteoraController.cancelUnsigned();if(meteoraController.operation?.state==='awaiting_signature')return;}
        else{if(pending.state!=='awaiting_signature'&&pending.state!=='finalized')await meteoraController.reconcile();return;}
      }
    }
    if(!imageId||imageBusy)throw Error('Add your coin image before continuing.');coinDetails();coinLinks(rawInput());
    // Transfer hook rules are checked with the shared catalogue before anything is prepared, like the coin text above.
    if(hookChosen()){if(field('feeMode').value==='agent')throw Error('An AI Agent launch cannot carry transfer hook rules. Choose the agent or the rules.');const problem=hookProblem();if(problem)throw Error(problem);}
    if(basketExtras().length){if(field('feeMode').value!=='holders')throw Error('A reward basket is for holder rewards. Choose Holders, or remove the basket.');const problem=basketProblem();if(problem)throw Error(problem);}
    meteoraController.schedulePrepare(0);
  }catch(e){if(!e.cancelled){$('launch-meteora-note').textContent=e.message;error(e.message);}}
}
async function closeMeteora(){
  if(meteoraController?.busy)return;if(meteoraController?.operation?.state==='awaiting_signature'||dammPumpController?.operation?.state==='awaiting_signature'){await meteoraController.cancelUnsigned();if(meteoraController.operation?.state==='awaiting_signature')return;}$('launch-meteora-dialog').close();
}
$('launch-meteora-close').onclick=closeMeteora;
$('launch-meteora-dialog').addEventListener('cancel',event=>{event.preventDefault();void closeMeteora();});

async function checkPublicPumpAccess(){
  const generation=sessionGeneration,status=await pumpPublicApi('/status');
  if(status.available!==true||status.publicEnabled!==true&&status.ownerPreview!==true)return false;
  const module=await import('./pump-public-ui.mjs');if(disposed||generation!==sessionGeneration)return false;
  pumpPublicStatus=status;pumpPublic=true;pumpAllowed=true;pumpFunded?.destroy();pumpFunded=null;
  const publicLaunchInput=()=>{const amountRaw=module.pumpDecimalRaw($('launch-pump-public-buy').value||'0'),raw=rawInput();if(pairUnavailable(asset)||!imageId||imageBusy)throw Error('Check your coin image and available pair before continuing.');const details=coinDetails(),links=coinLinks(raw);return{action:'initialize',name:details.name,symbol:details.symbol,description:details.description,image:'/token-images/'+imageId,website:links.website,twitter:links.twitter,telegram:links.telegram,amountRaw};};
  pumpPublicController=module.createPublicPumpOperation({document,root:$('launch-pump-public-operation'),request:pumpPublicApi,wallet:launchWallet,launchFlow:true,getLaunchInput:publicLaunchInput,context:()=>({active:isPump()&&pumpPublic&&$('launch-pump-public-dialog').open,key:launchSessionAccount+':'+csrf}),onChange:()=>{const created=['confirmed','finalized'].includes(pumpPublicController?.operation?.state);$('launch-pump-public-buy-wrap').hidden=created;$('launch-pump-public-terms').hidden=created;$('launch-pump-public-buy').disabled=pumpPublicController?.inputLocked||false;$('launch-pump-public-title').textContent=created?'Your coin is live':'Launch on PumpSwap';syncNavigationFree();},onOpenCoin:()=>{$('launch-pump-public-dialog').close();},onConfirmed:venueStepDone,onFinalized:venueStepDone});
  $('launch-pump-public-buy').oninput=()=>pumpPublicController.schedulePrepare(400);
  syncForm();return true;
}
async function openPublicPump(){
  error();try{
    if(pairUnavailable(asset))throw Error('Choose an available PumpSwap pair.');
    if(!launchWallet.state().address){openWallets();return;}
    if(!imageId||imageBusy)throw Error('Add your coin image before continuing.');
    coinDetails();coinLinks(rawInput());
    $('launch-pump-public-note').textContent='';$('launch-pump-public-dialog').showModal();pumpPublicController.render();
    if(['confirmed','finalized'].includes(pumpPublicController.operation?.state))return;
    const saved=await pumpPublicApi('/operations'),pending=(saved.operations||[]).find(x=>x.action==='initialize'&&x.wallet===launchWallet.state().address);
    if(pending&&pumpPublicController.restore(pending)){
      if(pending.state==='awaiting_signature'){await pumpPublicController.cancelUnsigned();if(pumpPublicController.operation?.state==='awaiting_signature')return;}
      else{await pumpPublicController.reconcile();return;}
    }
    pumpPublicController.schedulePrepare(0);
  }catch(e){error(e.message);}
}
async function closePublicPump(){if(pumpPublicController?.busy)return;if(pumpPublicController?.operation?.state==='awaiting_signature'){await pumpPublicController.cancelUnsigned();if(pumpPublicController.operation?.state==='awaiting_signature')return;}$('launch-pump-public-dialog').close();}
$('launch-pump-public-close').onclick=closePublicPump;
$('launch-pump-public-dialog').addEventListener('cancel',e=>{e.preventDefault();void closePublicPump();});
async function checkPumpAccess(){
  const generation=sessionGeneration,capability=await pumpApi();
  if(capability.enabled!==true||capability.mode!=='local-test'||capability.fundedLaunchEnabled!==false||capability.publicLaunchEnabled!==false)return;
  const module=await import('./pump-launch-test-ui.mjs');
  if(disposed||generation!==sessionGeneration)return;pumpUi=module;pumpAllowed=true;pumpFunded?.destroy();pumpFunded=module.createPumpFundedTestUi({document,request:pumpApi,wallet:launchWallet,context:()=>({active:isPump()&&pumpAllowed,quoteMint:asset.mint}),openWallets,onChange:syncForm});syncForm();
}
function clearPumpPreview(){pumpPreviewVersion++;pumpBusy=false;$('launch-pump-result').hidden=true;$('launch-pump-result').replaceChildren();$('launch-pump-status').textContent='';}
function resetPumpAccess(){pumpPublicController?.destroy();pumpPublicController=null;pumpPublic=false;pumpPublicStatus=null;$('launch-pump-public-dialog').close();$('launch-pump-public-disclosure').hidden=true;pumpFunded?.destroy();pumpFunded=null;launchVenue='raydium';venueVersion++;pumpAllowed=false;pumpUi=null;raydiumSelection=null;for(const id of ['launch-pump-price','launch-pump-trade-fee'])$(id).value='';$('launch-pump-graduation-fee').value='28.85';$('launch-pump-preset').value='standard';clearPumpPreview();$('launch-mode-select').hidden=true;$('launch-pump-test').hidden=true;$('launch-pump-rewards-note').hidden=true;}
function chooseVenue(next){
  // 'damm-pump' stays reachable only through ?venue=damm-pump so paid Meteora → PumpSwap drafts can finish; it has no button.
  if(!['raydium','meteora','pump-classic','damm-pump'].includes(next)){error('This venue is not available for new launches.');return;}
  if(TENANT&&!TENANT_VENUES.includes(next))return;
  if(next===launchVenue||busy||meteoraController?.busy||dammPumpController?.busy||pumpPublicController?.busy||pumpClassicController?.busy||flow||creating||imageBusy)return;
  if(meteoraController?.operation?.state==='awaiting_signature'){error('Close the launch window before switching venues.');return;}
  // Raydium's pair list (about 200 KB) is kept while another venue is open and reused on return while it is fresh.
  if(launchVenue==='raydium')raydiumSelection={asset,assets,category,canViewComingSoon,catalogueReady,catalogueFailed,catalogueCheckedAt};
  invalidatePrepared();clearPumpPreview();meteoraController?.reset();dammPumpController?.reset();$('launch-meteora-dialog').close();$('launch-damm-pump-dialog').close();$('launch-pump-classic-dialog').close();
  // Market Maker and Liquidity Manager exist only on Pump.fun; other venues fall back to Creator.
  if(next!=='pump-classic'&&PUMP_ONLY_MODES.includes(field('feeMode').value)){for(const radio of form.querySelectorAll('[name=feeMode]'))radio.checked=radio.value==='creator';lastFeeMode='creator';}
  // Transfer hook rules exist on Meteora only; another venue starts without them.
  if(next!=='meteora')clearHookSelection();dammPumpSavedOperation=null;dammPumpSavedPending=null;venueVersion++;launchVenue=next;requestId=crypto.randomUUID();cataloguePending=null;catalogueCheckedAt=null;
  $('launch-buy-dialog').close();$('launch-asset-dialog').close();$('launch-asset-search').value='';error();
  if(isPumpClassic()){
    const sol=LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),cached=cachedPumpClassicPairs();assets=[{...sol,pumpClassic:true,launchReady:true,kind:'sol',convertible:true,maxDevBuy:String(PUMP_CLASSIC_LIMITS.maxDevBuySol)}];category='all';canViewComingSoon=false;catalogueReady=false;catalogueFailed=false;asset=assets[0];$('launch-pump-classic-buy').value='0';$('launch-pump-classic-fee').value='0';pumpClassicBuyMint=SOL_MINT;
    // A list read moments ago is shown at once; it is read again after a minute like any other.
    if(cached){try{applyPumpClassicPairs(cached.result);catalogueCheckedAt=cached.at;}catch{catalogueReady=false;}}
  }
  else if(isDammPump()){assets=[];category='all';canViewComingSoon=false;catalogueReady=false;catalogueFailed=false;asset={...LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),catalogueUnavailable:true,supportReason:'Checking launch pairs…'};$('launch-damm-pump-buy').value='0';}
  else if(isMeteora()){assets=[];category='all';canViewComingSoon=false;catalogueReady=false;catalogueFailed=false;asset={...LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),supported:null,catalogueUnavailable:true,supportReason:'Checking Meteora pairs…'};$('launch-meteora-buy').value='0';}
  else if(raydiumSelection){({asset,assets,category,canViewComingSoon,catalogueReady,catalogueFailed,catalogueCheckedAt}=raydiumSelection);raydiumSelection=null;}
  syncForm();renderAssets();refreshCatalogue({background:true});if(isMeteora())void refreshMeteoraAccess({force:true});if(isDammPump())void refreshDammPumpAccess({force:true});if(isPumpClassic())void refreshPumpClassicAccess({force:true});
}
for(const button of document.querySelectorAll('[data-launch-venue]'))button.onclick=()=>chooseVenue(button.dataset.launchVenue);
for(const id of ['launch-pump-price','launch-pump-graduation-fee','launch-pump-trade-fee'])$(id).addEventListener('input',()=>{clearPumpPreview();syncForm();});
$('launch-pump-preset').addEventListener('change',()=>{clearPumpPreview();syncForm();});
async function previewPump(){
  if(!isPump()||!pumpAllowed||!pumpUi||pumpBusy)return;
  error();let body;
  try{if(pairUnavailable(asset))throw Error('Choose a verified PumpSwap test pair.');body=pumpUi.pumpPreviewInput({asset,preset:$('launch-pump-preset').value,quoteUsd:$('launch-pump-price').value,graduationPercent:$('launch-pump-graduation-fee').value,tradePercent:$('launch-pump-trade-fee').value});}
  catch(e){$('launch-pump-config').open=true;error(e.message);return;}
  const version=++pumpPreviewVersion;pumpBusy=true;$('launch-pump-result').hidden=true;$('launch-pump-status').textContent='Checking the local launch model…';syncForm();
  try{const result=await pumpApi('/preview',body);if(version!==pumpPreviewVersion||!isPump())return;if(!pumpUi.validPumpPreview(result,body.preset))throw Error('The private preview returned an invalid result. No funds moved.');
    const facts=[['Quote collected',result.estimate.quoteCollectedUsd],['Graduation allocation to Launchpad',result.estimate.graduationFeeUsd],['Quote in pool',result.estimate.lpQuoteUsd],['Token value in pool',result.estimate.lpTokenValueUsd],['Total pool liquidity',result.estimate.lpTotalUsd],['Pool opening FDV',result.estimate.poolOpeningFdvUsd]];
    $('launch-pump-result').replaceChildren(...facts.map(([label,value])=>{const row=node('div');row.append(node('dt',label),node('dd',money(value)));return row;}));$('launch-pump-result').hidden=false;$('launch-pump-status').textContent='Model preview complete. No funds moved, no tokens were minted and no LP was burned.';
  }catch(e){if(version===pumpPreviewVersion&&!e.cancelled){error(e.message);$('launch-pump-status').textContent='Preview unavailable. No funds moved.';}}
  finally{if(version===pumpPreviewVersion){pumpBusy=false;syncForm();}}
}
async function optimizeImage(file){
  return optimizeLaunchImage(file,{document,createImageBitmap:typeof createImageBitmap==='function'?createImageBitmap:undefined,FileReader,URL:window.URL});
}
function syncImage(){
  $('launch-image-upload').setAttribute('aria-busy',String(imageBusy));
  $('launch-image-choose').disabled=imageBusy||busy||!!flow||creating;
  $('launch-image-choose').textContent=imageBusy?'Preparing…':imageId?'Replace image':'Choose image';
  $('launch-image-label').textContent=imageId?'Your coin image':'Give your coin a face';
  $('launch-image-help').textContent=imageName||'Choose a square image up to 10 MB.';
  $('launch-image-help').title=imageName;
}
$('launch-image-choose').onclick=()=>{if(!imageBusy&&!busy&&!flow&&!creating)$('launch-image').click();};
function resetImage(){imageGeneration++;imageId='';imageName='';imageBusy=false;$('launch-image').value='';for(const id of ['launch-image-preview','launch-card-image']){$(id).hidden=true;$(id).removeAttribute('src');}$('launch-image-placeholder').hidden=false;$('launch-card-initial').hidden=false;$('launch-image-status').textContent='Add a coin image to continue.';}
$('launch-image').onchange=async()=>{
  const file=$('launch-image').files[0];if(!file||imageBusy||busy||flow||creating)return;
  const version=++imageGeneration,generation=sessionGeneration,account=launchSessionAccount,token=csrf;
  const check=()=>{if(disposed||version!==imageGeneration||generation!==sessionGeneration||account!==launchSessionAccount||token!==csrf)throw Object.assign(Error('Image upload cancelled because your account changed.'),{cancelled:true});};
  imageBusy=true;invalidatePrepared();syncForm();error();$('launch-image-status').textContent='Preparing your image.';
  try{const data=await optimizeImage(file);check();const saved=await retryRequest('/image',{data:data.split(',')[1]},check);check();imageId=saved.imageId;imageName=file.name||'Image ready';for(const id of ['launch-image-preview','launch-card-image']){$(id).src=data;$(id).hidden=false;}$('launch-image-placeholder').hidden=true;$('launch-card-initial').hidden=true;requestId=crypto.randomUUID();$('launch-image-status').textContent='Coin image ready.';}
  catch(e){if(!e.cancelled&&version===imageGeneration){error(e.message);$('launch-image-status').textContent='Image upload failed. '+e.message;}}
  finally{if(version===imageGeneration){imageBusy=false;$('launch-image').value='';schedulePrepare();syncForm();}}
};
// Decorative feedback only: preview pulses, image pop and a drop target that
// hands a dropped file to the same image input handler.
const restartClass=(target,name,ms)=>{if(!target)return;target.classList.remove(name);void target.offsetWidth;target.classList.add(name);if(ms)setTimeout(()=>target.classList.remove(name),ms);};
const previewCard=document.querySelector('.launch-token-card');
form.addEventListener('input',event=>{if(['name','symbol','description'].includes(event.target?.name))restartClass(previewCard,'is-updating',720);});
// Decorative cross-fades: the market section's content below the venue cards when the venue has changed, and the
// detail block under the launch options when another option is chosen. Both run after the real handlers above.
const marketSection=document.querySelector('.launch-market-section'),rewardOptions=$('launch-reward-options');let paintedVenue=launchVenue;
for(const button of document.querySelectorAll('[data-launch-venue]'))button.addEventListener('click',()=>{if(launchVenue!==paintedVenue){paintedVenue=launchVenue;restartClass(marketSection,'is-switching',520);}});
form.addEventListener('change',event=>{if(event.target?.name==='feeMode')restartClass(rewardOptions,'is-switching',520);});
// Layout only: the side column's height, so the stylesheet can stick it by its bottom edge when it is taller than
// the viewport (the Create coin panel then stays reachable). Without ResizeObserver it sticks by its top edge.
const sideColumn=document.querySelector('.launch-side');let sideSizer=null;
try{if(sideColumn&&typeof window.ResizeObserver==='function'){sideSizer=new window.ResizeObserver(entries=>{const height=entries[entries.length-1]?.contentRect?.height;if(height>0)sideColumn.style.setProperty('--lp-side-h',Math.ceil(height)+'px');});sideSizer.observe(sideColumn);}}catch{sideSizer=null;}
for(const id of ['launch-card-image','launch-image-preview'])$(id)?.addEventListener('load',()=>{if(!$(id).hidden)restartClass($(id).parentElement,'is-popped',700);});
const dropZone=$('launch-image-upload'),dropFiles=event=>[...(event.dataTransfer?.types||[])].includes('Files'),dropOpen=()=>!$('launch-image-choose').disabled;
const dragOver=event=>{if(!dropFiles(event))return;event.preventDefault();const open=dropOpen();dropZone.dataset.drop=open?'over':'blocked';if(event.dataTransfer)event.dataTransfer.dropEffect=open?'copy':'none';};
dropZone?.addEventListener('dragenter',dragOver);dropZone?.addEventListener('dragover',dragOver);
dropZone?.addEventListener('dragleave',event=>{if(!dropZone.contains(event.relatedTarget))dropZone.dataset.drop='idle';});
dropZone?.addEventListener('drop',event=>{if(!dropFiles(event))return;event.preventDefault();dropZone.dataset.drop='idle';const file=event.dataTransfer?.files?.[0];if(!file||!dropOpen())return;try{const transfer=new window.DataTransfer();transfer.items.add(file);$('launch-image').files=transfer.files;}catch{return;}$('launch-image').onchange?.();});
dropZone?.querySelector('.launch-upload-art')?.addEventListener('click',()=>{if(!$('launch-image-choose').disabled)$('launch-image-choose').click();});
const coinLink=id=>'/launched-tokens?id='+encodeURIComponent(id);
const externalFeeSigner=l=>l.feeClaim?.requiresSignature??((l.walletMode||l.input.walletMode)==='external'&&l.input.feeMode==='creator'&&l.feeCustody!=='relay');
// "Your coins": Pump.fun launches first (finished and failed ones too, with what happened to their funding), then
// Raydium, then Meteora and PumpSwap. A row opens its coin, or switches to its venue and shows that launch.
const PUMP_CLASSIC_ROWS=['created','funding_pending','funded','creating','refunding','failed','refunded'];
const pumpClassicListed=()=>pumpClassicLaunches.filter(l=>PUMP_CLASSIC_ROWS.includes(l.state)||l.state==='awaiting_funding'&&l.canFund===true);
function pumpClassicRowState(l){
  if(l.state==='created')return['Live · Pump.fun','live'];
  const refund=l.dimensions?.refund;
  if(l.state==='failed')return['Pump.fun · '+(['pending','released'].includes(refund)?'Refunding':refund==='complete'?'Refunded':'Failed'),'error'];
  if(['refunding','refunded'].includes(l.state))return['Pump.fun · '+(l.state==='refunded'?'Refunded':'Refunding'),'error'];
  return['Pump.fun · '+(l.stateLabel||'Launching'),'draft'];
}
function historyRow(root,{href,onclick,symbol,image,state,tone}){
  const b=node(href?'a':'button');if(href)b.href=href;else{b.type='button';b.onclick=onclick;}
  b.className='launch-history-row';const badge=node('span',String(symbol||'?').slice(0,1).toUpperCase());badge.className='launch-history-avatar';badge.setAttribute('aria-hidden','true');
  if(/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(image||'')){const picture=node('img');picture.alt='';picture.loading='lazy';picture.src=image;picture.onerror=()=>picture.remove();badge.append(picture);}
  const label=node('small',state);label.className='launch-history-state is-'+tone;b.append(badge,node('strong',symbol||'?'),label);root.append(b);
}
function renderPumpClassicRows(root){
  for(const l of pumpClassicListed().slice(0,5)){const [state,tone]=pumpClassicRowState(l),live=l.state==='created';historyRow(root,{href:live?'/coin?mint='+encodeURIComponent(l.mint):'',onclick:()=>void openPumpClassicLaunch(l.id),symbol:l.symbol,image:l.image,state,tone});}
}
// Meteora and PumpSwap launches of this account: live coins, and setups that were paid for and can be finished.
let venueLaunches=[],venueListLoad=null;
const VENUE_LIVE=['trading','bonded','migrated'],VENUE_NAMES={meteora:'Meteora','damm-pump':'PumpSwap'};
const venueListed=()=>venueLaunches.filter(r=>!r.hidden&&!r.archived&&(VENUE_LIVE.includes(r.status)||r.venue==='meteora'&&r.status==='configured'||r.venue==='damm-pump'&&r.status==='draft'));
function loadVenueLaunches(){
  if(disposed||!csrf||!launchSessionReady)return Promise.resolve();if(venueListLoad)return venueListLoad;
  const generation=sessionGeneration,read=venue=>accountList('/api/launchpad/'+venue+'/launches').then(data=>(Array.isArray(data)?data:data?.launches||[]).filter(r=>r&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.mint||'')&&typeof r.status==='string'&&(!r.platform||r.platform===venue)).map(r=>({...r,venue})),()=>null);
  venueListLoad=Promise.all([read('meteora'),read('damm-pump')]).then(([meteora,damm])=>{if(disposed||generation!==sessionGeneration)return;venueLaunches=[...(meteora||venueLaunches.filter(r=>r.venue==='meteora')),...(damm||venueLaunches.filter(r=>r.venue==='damm-pump'))];renderList();}).finally(()=>{venueListLoad=null;});
  return venueListLoad;
}
function renderVenueRows(root){
  for(const r of venueListed().slice(0,5)){const live=VENUE_LIVE.includes(r.status);historyRow(root,{href:live?'/coin?mint='+encodeURIComponent(r.mint):'',onclick:()=>void resumeVenueLaunch(r),symbol:r.symbol,image:r.image,state:live?'Live · '+VENUE_NAMES[r.venue]:VENUE_NAMES[r.venue]+' · Launch pending',tone:live?'live':'draft'});}
}
/** A saved Meteora or PumpSwap setup: switches to its venue and pair, then resumes it in the launch dialog. */
async function resumeVenueLaunch(r){
  error();if(launchVenue!==r.venue)chooseVenue(r.venue);
  if(launchVenue!==r.venue){error('Finish or close the current launch before switching venues.');return;}
  if(r.venue==='damm-pump'){await refreshDammPumpAccess();if(!disposed&&isDammPump())await openDammPump({resumeSaved:true});return;}
  await Promise.all([refreshMeteoraAccess(),refreshCatalogue()]);if(disposed||!isMeteora())return;
  const pair=assets.find(a=>a.mint===r.quoteMint);if(pair&&!pairUnavailable(pair)&&pair.mint!==asset.mint)chooseAsset(pair);
  await openMeteora();
}
/** A Raydium row: switches to Raydium if needed and opens that launch. */
function openRaydiumLaunch(id,fallback){
  const l=launches.find(current=>current.id===id)||fallback;if(!l)return;
  error();if(!isRaydium())chooseVenue('raydium');
  if(!isRaydium()){error('Finish or close the current launch before switching to Raydium.');return;}
  select(l,true);
}
function renderList(){
  const venueRows=venueListed(),version=JSON.stringify([launches.map(l=>[l.id,l.state,l.input.symbol,l.input.imageId,l.curve,l.recovery?.status,l.listArchived,l.hidden,l.archived]),pumpClassicListed().map(l=>[l.id,l.state,l.stateLabel,l.symbol,l.image,l.dimensions?.refund]),venueRows.map(r=>[r.venue,r.mint,r.status,r.symbol,r.image])]);if(listVersion===version)return;listVersion=version;
  const root=$('launch-list');root.replaceChildren();peekAway();const visible=launches.filter(l=>!l.listArchived&&!l.hidden),archived=launches.length-visible.length;$('launch-archived-link').textContent='Archived tokens'+(archived?' · '+archived:'');
  if(!visible.length&&!pumpClassicListed().length&&!venueRows.length){root.append(node('p',archived?'Your saved records are in Archived tokens.':'Your first coin starts here.'));peekInto(root);return;}
  renderPumpClassicRows(root);
  for(const l of visible.slice(0,5)){const live=!!l.curve||l.state==='live';historyRow(root,{href:live?coinLink(l.id):'',onclick:()=>openRaydiumLaunch(l.id,l),symbol:l.input.symbol,image:/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(l.input.imageId||'')?'/token-images/'+l.input.imageId:'',state:l.archived?'Archived':live?'Live':l.state==='failed'?'Draft · Launch stopped':l.state==='error'?'Draft · Needs attention':'Draft',tone:l.archived?'archived':live?'live':['failed','error'].includes(l.state)?'error':'draft'});}
  renderVenueRows(root);
}
function announceSuccess(l){if(announcedId===l.id)return;announcedId=l.id;for(const [key,value] of signedRequests)if(value.id===l.id)signedRequests.delete(key);$('launch-toast').hidden=false;$('launch-toast-link').href=coinLink(l.id);$('launch-buy-dialog').close();try{document.dispatchEvent(new document.defaultView.CustomEvent('curve-celebrate',{detail:{target:$('launch-toast')}}));}catch{}clearLaunchedForm({name:l.input?.name,symbol:l.input?.symbol});}
// Decorative: a Gotchi peeks into the empty "Your coins" state through the motion layer (window.curveMotion.peek); nothing
// here is required for the list to render, and the peek is removed whenever the list is drawn again.
function peekAway(){peekVersion++;try{peekHandle?.remove();}catch{}peekHandle=null;$('launch-list').classList.remove('has-peek');}
function peekInto(root){const peek=document.defaultView?.curveMotion?.peek;if(typeof peek!=='function')return;const version=peekVersion;root.classList.add('has-peek');Promise.resolve().then(()=>peek(root,{side:'right',height:96})).then(handle=>{if(disposed||version!==peekVersion){try{handle?.remove();}catch{}return;}peekHandle=handle||null;if(!handle)root.classList.remove('has-peek');}).catch(()=>{if(version===peekVersion)root.classList.remove('has-peek');});}
/**
 * After a coin goes live, clears the details it was launched with while the form still holds them, so one more click
 * cannot launch the same coin twice. Venue, pair, launch option and agent settings stay as they were.
 */
function clearLaunchedForm({name,symbol}={}){
  if(disposed||!name||oneLine(field('name').value)!==oneLine(name)||oneLine(field('symbol').value).toUpperCase()!==oneLine(symbol).toUpperCase())return;
  for(const key of ['name','symbol','description','website','twitter','telegram'])field(key).value='';
  for(const id of ['launch-dev-buy','launch-pump-classic-buy','launch-pump-classic-seed','launch-meteora-buy','launch-damm-pump-buy','launch-pump-public-buy'])if($(id)&&!$(id).disabled)$(id).value='0';
  resetImage();requestId=crypto.randomUUID();lastChangeKey='';invalidatePrepared();syncForm();
}
/** A Meteora, PumpSwap or legacy PumpSwap step confirmed: refreshes "Your coins" and, once the coin exists, clears its details. */
function venueStepDone(result){
  load().catch(()=>{});void loadVenueLaunches();
  if(result?.operation?.action==='initialize'&&['confirmed','finalized'].includes(result.operation.state))clearLaunchedForm({name:result.launch?.name,symbol:result.launch?.symbol});
}
function select(l,open=false){if((isPump()||isMeteora()||isDammPump()||isPumpClassic())&&open){error('Switch to Raydium to manage an existing launch.');return;}selected=l;if(open){$('launch-buy-dialog').dataset.existing='true';$('launch-buy-dialog').showModal();progressNote='';}syncProgress();if(l.state==='live'&&startedLaunches.has(l.id)&&flow?.purpose!=='fees')announceSuccess(l);syncForm();}
function rewardTime(value){const at=Number(value);return at>0&&Number.isFinite(at)?new Date(at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';}
const rewardRetryNotice=l=>l.autoFees&&Number.isSafeInteger(l.rewardRetry?.at)&&l.rewardRetry.at>Date.now()&&l.rewardRetry.at<=8640000000000000?'Rewards will retry automatically at '+rewardTime(l.rewardRetry.at)+'.':'';
const canManageAutomation=l=>!!l?.curve&&!l.archived&&l.state!=='archived'&&!externalFeeSigner(l);
function syncHolderSettings(l){
  const rewards=l.holderRewards,visible=l.input.feeMode==='holders'&&!!rewards;const root=$('launch-holder-settings');root.hidden=!visible;
  if(!visible)return;const symbol=rewards.quoteSymbol||'quote tokens',paycheck=rewards.paycheck||null;
  $('launch-holder-schedule').textContent=paycheck?'Every 15 minutes: holders 50% · $LAUNCHPAD buy-and-burn 35% · Launchpad 10% · you 5%. Each wallet is paid at $0.50 in '+symbol+'; selling before a payout forfeits the pending amount.':'Every hour when at least $100 in '+symbol+' is ready.';
  $('launch-holder-pending').textContent=paycheck?(paycheck.accruing??'0')+' '+symbol+' accruing to '+(paycheck.accruingWallets??0)+' wallets · '+(paycheck.paidToHolders??'0')+' '+symbol+' paid to holders · '+(paycheck.forfeited??'0')+' '+symbol+' forfeited by sellers':(rewards.pendingQuote??'0')+' '+symbol;
  const retryNotice=rewardRetryNotice(l),conversion=rewards.taxConversion,nextConversion=conversion?.nextAt??conversion?.nextCheckAt,taxBurn=rewards.taxBurn?.selected===true?rewards.taxBurn:null;const conversionNote=$('launch-holder-conversion');conversionNote.hidden=!(taxBurn||Number(l.input.taxBps)>0||Number(rewards.unconvertedTaxTokens)>0);conversionNote.textContent=taxBurn?[`Collected ${l.input.symbol} transfer tax is burned directly. Separately accrued creator fees in ${symbol} still fund holder rewards; existing owed rewards stay reserved.`,taxBurn.enabled&&!taxBurn.paused&&l.autoFees?taxBurn.manual===true?'Collected tax is kept in the rewards wallet until the team burns it.':'Tax burns run automatically after collection confirms.':'Tax burns are paused; collected tax is not sold.',taxBurn.tokensBurned!=null?`${taxBurn.tokensBurned} ${l.input.symbol} burned directly.`:'Tax-burn amounts are unavailable.',taxBurn.initialInventory?.status==='authorized'?`${taxBurn.initialInventory.approvedTokens} ${l.input.symbol} initial inventory approved for one burn.`:''].join(' '):[`Automatic tax sales normally use up to 1,000,000 tokens, at least ${conversion?.intervalMinutes||5} minutes apart. At 10,000,000 or more reward tokens awaiting conversion, automatic processing sells exact 10,000,000-token batches without that wait when liquidity permits. Admin sell-and-distribute requests also skip the automatic wait.`,!l.autoFees?'Automatic conversions are paused.':retryNotice|| (nextConversion?'Next conversion eligible · '+rewardTime(nextConversion):'Pool limits may reduce or delay a sale.')].filter(Boolean).join(' ');
  $('launch-holder-next').textContent=!l.autoFees?'Automatic rewards are paused.':retryNotice||(l.cycle||l.feesRequested?'Reward check in progress…':rewards.nextCheckAt?'Next check · '+rewardTime(rewards.nextCheckAt):paycheck?'The next 15-minute check is being scheduled.':'The next hourly check is being scheduled.');
}
function syncProgress(){
  if(disposed)return;
  const l=selected;$('launch-progress').hidden=!l;if(!l)return;
  const active=!!flow&&flow.version===flowVersion,fees=flow?.purpose==='fees',external=(l.walletMode||l.input.walletMode)==='external',live=l.state==='live';const manualFees=externalFeeSigner(l),retryNotice=rewardRetryNotice(l),recovering=!l.curve&&(!!l.recovery||l.state==='failed');$('launch-buy-title').textContent=$('launch-buy-dialog').dataset.existing==='true'?l.input.symbol+(l.curve||live?' · Rewards':' · Launch'):'Buy at launch';
  $('launch-progress').dataset.state=live?'complete':recovering?'error':active?'active':l.state==='error'?'error':'waiting';
  $('launch-progress-title').textContent=fees?(retryNotice?'Rewards are waiting to retry':'Processing your rewards'):live?'Your coin is live':l.pendingSignature?(l.pendingSignature.kind==='create'?'Create your coin':'Prepare your launch'):l.retry?'Reconnecting…':l.state==='error'?'Launch needs attention':l.state==='draft'?'Ready to launch':'Creating your coin';
  $('launch-status-message').textContent=progressNote||retryNotice||(fees?'Preparing and confirming reward transactions.':live?'Your coin is confirmed on Solana.':l.retry?'Retrying automatically. Your launch progress is saved.':l.pendingSignature?(active?'Preparing your wallet request…':'Connect the launch wallet and resume when you’re ready.'):l.state==='draft'&&!active?(Date.now()>=l.reviewExpires?'This saved launch cost has expired. Select Create coin to see an updated cost first.':'Your launch details are saved. Nothing happens until you select Create coin.'):'Preparing and confirming your launch. This can take a little time.');
  // Show errors only when recovery actually stopped; transient retry metadata
  // stays progress, without asking the user to repeat already completed steps.
  if(l.state==='error'&&!progressNote)$('launch-status-message').textContent=l.error||'Your progress is saved. Resume when you’re ready.';
  $('launch-retry').hidden=recovering||active||live||l.archived||!['draft','error','paused','awaiting_signature','launching','pending'].includes(l.state);$('launch-retry').disabled=busy;$('launch-retry').textContent=l.state==='draft'?'Create coin':'Resume launch';
  $('launch-edit-draft').hidden=!l.canReuseDraft||!!l.curve||l.state!=='failed'||l.recovery?.status!=='complete';$('launch-edit-draft').disabled=busy||active;
  if(recovering){const recovery=l.recovery;$('launch-progress-title').textContent=recovery?.status==='refunding'?'Returning unused setup funds':recovery?.status==='checking'?'Checking setup funds':'Launch stopped';$('launch-status-message').textContent=[recovery?.reason||l.error||'The launch stopped. Your coin details are saved.',recovery?.notice].filter(Boolean).join(' ');}
  $('launch-rewards-manage').hidden=!(l.curve||live)||l.archived;$('launch-rewards-status').textContent=manualFees?'Creator fees belong to your connected wallet. Approve claims in that wallet.':!l.autoFees?'Automatic rewards are paused.':retryNotice||'Rewards are processed automatically.';$('launch-fees').textContent=l.input.feeMode==='holders'?'Check rewards now':manualFees?'Claim creator fees':'Process earned fees';$('launch-fees').disabled=busy||!live;$('launch-fees').hidden=l.input.feeMode==='holders';$('launch-automation').hidden=manualFees;$('launch-automation').disabled=!canManageAutomation(l)||automationBusy||busy&&!(l.autoFees&&fees);$('launch-automation').textContent=l.autoFees?'Pause rewards':'Resume rewards';$('launch-wallet-recovery').hidden=walletOnly||manualFees||l.feeCustody==='relay';syncHolderSettings(l);
  $('launch-stop').hidden=!active||!external;$('launch-success').hidden=!live;$('launch-success').href=coinLink(l.id);$('launch-manage').hidden=live;$('launch-manage').href=coinLink(l.id);$('launch-buy-close').disabled=false;
  // AI Agent launches hand off to the coin page: the optional activity deposit is a separate signature once the coin is live.
  if(l.agent&&live){$('launch-success').textContent='Open your agent →';$('launch-success').href='/coin?mint='+encodeURIComponent(l.mint)+(agentFundingSol()>0?'&fund=activity&amount='+encodeURIComponent(String(agentFundingSol())):'')+'#agent';if(!progressNote)$('launch-status-message').textContent=(agentFundingSol()>0?'Your coin is live. Sign the optional '+agentFundingSol()+' SOL activity deposit from the coin page; it is separate from your launch cost. ':'Your coin is live. ')+'The agent activates once $2 of backed operating credit is available.';}
}
async function load(){
  if(loading)return loading;
  const generation=sessionGeneration,account=launchSessionAccount;
  const pending=(async()=>{const r=await api();if(generation!==sessionGeneration||account!==launchSessionAccount)return null;launches=r.launches;renderList();if(selected){const l=launches.find(x=>x.id===selected.id);if(l)select(l);}return r;})();
  loading=pending;try{return await pending;}finally{if(loading===pending)loading=null;}
}
function restoreDraft(l){
  if(!isRaydium())chooseVenue('raydium');
  if(!isRaydium()){error('Finish or close the current launch before switching to Raydium.');return;}
  if(busy||flow||creating)return;
  if(!l?.canReuseDraft||l.curve||l.state!=='failed'||l.recovery?.status!=='complete'){error('Wait for setup recovery to finish before reusing this draft.');return;}
  const input=l.input||{};invalidatePrepared();requestId=crypto.randomUUID();
  for(const name of ['name','symbol','description'])field(name).value=input[name]||'';
  for(const name of ['website','twitter','telegram'])field(name).value=input.links?.[name]||input[name]||'';
  const savedMode=input.paycheck?.policy?'paycheck':input.feeMode||'creator';
  for(const radio of form.querySelectorAll('input[name="feeMode"]'))radio.checked=radio.value===savedMode;
  if(!adminLaunch&&Number(input.targetUsd)===4000&&startsFor('raydium').includes('4k'))chosenStart='4k';else if(!adminLaunch)chosenStart='20k';
  field('targetUsd').value=adminLaunch?String(Math.min(100000,Math.max(20000,Number(input.targetUsd)||20000))):String(START_USD[startsFor('raydium').includes(chosenStart)?chosenStart:startsFor('raydium')[0]]);
  const savedTax=Number(input.taxBps||0)/100;
  field('taxPercent').value=input.feeMode==='holders'&&(!Number.isFinite(savedTax)||savedTax<1||savedTax>3)?'2':String(savedTax);
  lastFeeMode=field('feeMode').value;
  field('devBuySol').value=input.devBuySol??displayUnits(input.devBuyLamports||l.review?.devBuy?.solBudget||'0');
  asset=assets.find(row=>row.mint===input.quoteMint)||{mint:input.quoteMint,symbol:l.review?.quoteSymbol||'Saved pair',supported:false};
  imageId=/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(input.imageId||'')?input.imageId:'';imageName=imageId?'Saved coin image':'';
  for(const id of ['launch-image-preview','launch-card-image']){const image=$(id);image.hidden=!imageId;if(imageId)image.src='/token-images/'+imageId;else image.removeAttribute('src');}
  $('launch-image-placeholder').hidden=!!imageId;$('launch-card-initial').hidden=!!imageId;$('launch-image-status').textContent=imageId?'Saved coin image restored.':'Add a coin image to continue.';
  const socials=form.querySelector('.launch-socials');if(socials)socials.open=['website','twitter','telegram'].some(name=>field(name).value);
  startedLaunches.delete(l.id);for(const [key,value] of signedRequests)if(value.id===l.id)signedRequests.delete(key);
  selected=null;progressNote='';$('launch-buy-dialog').close();$('launch-buy-dialog').dataset.existing='false';$('launch-toast').hidden=true;
  document.defaultView.history?.replaceState?.(document.defaultView.history.state,'','/launchpad');error(input.feeMode==='buyback'?'Agent buyback is no longer offered for new launches. Choose Creator or Holders before continuing.':'');syncProgress();syncForm();field('name').focus();form.scrollIntoView({block:'start',behavior:'auto'});
}
$('launch-edit-draft').onclick=()=>restoreDraft(selected);
// ---- Robinhood Chain (v71.39) -------------------------------------------------------------------------------------
// The chain segment sits above the market section. On Robinhood the Solana market card hides, the Robinhood market
// block (pairs, start, rewards, creator fee, first buy) shows, and the transfer-rules block moves under it. The launch
// runs in its own dialog: connect an EVM wallet → quote → fund from that wallet → the worker creates the coin.
const robinhoodSection=document.querySelector('[data-launch-section="robinhood"]'),solanaMarketSection=document.querySelector('[data-launch-section="market"]');
const hooksHome={parent:$('launch-hooks')?.parentNode||null,next:$('launch-hooks')?.nextSibling||null};
async function robinhoodApi(path='',options={}){
  const generation=sessionGeneration,account=launchSessionAccount,token=csrf,body=options.method==='POST'?options.body||{}:undefined;
  const check=()=>{if(disposed||generation!==sessionGeneration||account!==launchSessionAccount||token!==csrf)throw Object.assign(Error('Your account changed. Review this launch before continuing.'),{cancelled:true});};
  if(!token)throw Error('Sign in to launch on Robinhood Chain.');
  let response;
  try{response=await pageFetch('/api/launchpad/robinhood'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'x-control-token':token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch(e){
    if(e?.cancelled)throw e;
    if(e instanceof TypeError||e?.name==='TypeError')throw Object.assign(Error('Launchpad could not be reached. Check your connection and try again.'),{status:503,cause:e});
    if(e?.code==='LAUNCH_REQUEST_TIMEOUT')throw Object.assign(Error('Robinhood Chain is taking too long to answer. Try again in a moment.'),{status:408,code:e.code,cause:e});
    if(e?.status>=500)throw Object.assign(Error('Robinhood launches are temporarily unavailable. Try again in a moment.'),{status:e.status,cause:e});
    throw e;
  }
  check();let result;try{result=await response.json();}catch{throw Object.assign(Error('Robinhood launches are temporarily unavailable. Please try again.'),{status:503});}check();if(!response.ok)throw Object.assign(Error(result?.error||'Robinhood launches are temporarily unavailable.'),{status:response.status,code:result?.code});return result;
}
function robinhoodTodo(){
  if(!robinhoodMarket)return'wait for Robinhood Chain availability';
  const problem=robinhoodMarket.problem();if(problem)return robinhoodMarket.allowed()?problem.replace(/\.$/,''):'wait for Robinhood Chain availability';
  if(hookChosen()&&hookProblem())return'fix the transfer rules';
  return'';
}
/** The quote body: the coin's details and links, the market block's choices and the transfer rules; throws the first problem. */
function robinhoodInput(){
  if(!robinhoodMarket)throw Error('Robinhood Chain is still loading.');
  if(!imageId||imageBusy)throw Error('Add your coin image before continuing.');
  const details=coinDetails(),raw=rawInput(),links=coinLinks(raw),market=robinhoodMarket.input();
  const hook=hookInput();if(hook){const problem=hookProblem();if(problem)throw Error(problem);}
  return{...details,...links,image:'/token-images/'+imageId,...market,hooks:hook||undefined};
}
async function ensureRobinhoodModules(){
  if(!robinhoodModule)robinhoodModule=await import('./robinhood-launch-ui.mjs');
  if(!evmWalletModule)evmWalletModule=await import('./evm-wallet.mjs');
  if(!evmWallet){evmWallet=evmWalletModule.createEvmWallet({window});robinhoodWalletUnsubscribe=evmWallet.onChange(()=>{if(!disposed)syncForm();});void evmWallet.resume();}
  return robinhoodModule;
}
async function ensureRobinhoodMarket(){
  if(robinhoodMarket||disposed)return robinhoodMarket;
  const module=await ensureRobinhoodModules();if(disposed||robinhoodMarket)return robinhoodMarket;
  robinhoodMarket=module.createRobinhoodMarket({document,root:$('launch-robinhood-market'),request:path=>robinhoodApi(path),onChange:()=>{if(!disposed)syncForm();}});
  robinhoodMarket.setActive(isRobinhood());
  return robinhoodMarket;
}
function setLaunchChain(id,{silent=false}={}){
  const chain=launchChainById(id);if(!chain?.available)return;if(chain.id==='robinhood'&&document.body?.dataset?.robinhood==='off')return;
  launchChain=chain.id;try{window.localStorage?.setItem(CHAIN_STORAGE,launchChain);}catch{}
  document.dispatchEvent(new CustomEvent('curve-chain-applied',{detail:{chain:launchChain}})); // the header's toggle follows the chain step
  try{const url=new URL(window.location.href);if(launchChain==='solana')url.searchParams.delete('chain');else url.searchParams.set('chain',launchChain);window.history.replaceState(window.history.state,'',url);}catch{}
  if(chainSelect)chainSelect.set(launchChain,{silent:true});
  const robinhood=isRobinhood();
  if(solanaMarketSection)solanaMarketSection.hidden=robinhood;if(robinhoodSection)robinhoodSection.hidden=!robinhood;
  const hooks=$('launch-hooks');
  if(hooks){if(robinhood)robinhoodSection?.append(hooks);else if(hooksHome.parent&&hooks.parentNode!==hooksHome.parent)hooksHome.parent.insertBefore(hooks,hooksHome.next&&hooksHome.next.parentNode===hooksHome.parent?hooksHome.next:null);}
  // v71.42: no venue sentence under the chain choice on Robinhood (the docs describe the pool); Solana keeps its one line.
  const chainNote=$('launch-chain-note');chainNote.hidden=robinhood;chainNote.textContent=robinhood?'':'Solana launches on Pump.fun, Raydium or Meteora.';
  if(robinhood){if(launchSessionReady&&csrf)void ensureRobinhoodMarket().then(()=>{robinhoodMarket?.setActive(true);syncForm();});}
  else{robinhoodMarket?.setActive(false);$('launch-connect').disabled=false;}
  if(!silent)syncForm();
}
/** The preview card's "Trading fee" row (made once, before the First buy row; hidden on Solana). */
function robinhoodFeeRow(){
  let row=document.getElementById('launch-card-fee-row');
  if(!row){row=document.createElement('div');row.id='launch-card-fee-row';row.hidden=true;const dt=document.createElement('dt');dt.textContent='Trading fee';const dd=document.createElement('dd');dd.id='launch-card-fee';row.append(dt,dd);const buy=$('launch-card-buy')?.parentElement;if(buy&&buy.parentElement)buy.parentElement.insertBefore(row,buy);else document.querySelector('.launch-preview-facts')?.append(row);}
  return row;
}
/** The Robinhood share of syncForm: the launch button, the footer hint, the preview card and the wallet line. */
function syncRobinhood(){
  const subtitle=document.querySelector('.launch-heading .subtitle'),badge=document.querySelector('.launch-token-card .mainnet-badge');
  if(subtitle)subtitle.textContent=isRobinhood()?'Your idea. Your market. Ready for Robinhood Chain.':'Your idea. Your market. Ready for Solana.';
  if(badge)badge.textContent=isRobinhood()?'Robinhood Chain':'Solana';
  // The preview card's fee row (v71.42): the proposed fees of the chosen option, on Robinhood only.
  const feeRow=robinhoodFeeRow();feeRow.hidden=!isRobinhood();
  if(!isRobinhood())return;
  if(!robinhoodMarket&&launchSessionReady&&csrf&&!robinhoodMarketPending){robinhoodMarketPending=ensureRobinhoodMarket().then(()=>{robinhoodMarketPending=null;if(!disposed)syncForm();},()=>{robinhoodMarketPending=null;});}
  document.querySelector('.launch-venue').textContent='Launchpad contracts · Uniswap v4';
  feeRow.querySelector('dd').textContent=robinhoodMarket?.feeText||'1.75% on the curve · 0.5% after graduation';
  $('launch-curve-summary').textContent='Graduates at about $50,000 into its Uniswap v4 pool. Liquidity locked for good.';
  const market=robinhoodMarket,allowed=market?.allowed()===true,locked=!!robinhoodController?.locked,open=$('launch-open');
  open.textContent=locked?'View Robinhood launch →':allowed?'Launch on Robinhood →':market?.status?'Robinhood unavailable':'Checking Robinhood Chain…';
  open.disabled=busy||imageBusy||!allowed&&!locked;
  $('launch-footer-hint').textContent=allowed?'Connect an EVM wallet, review the quote, then fund the launch from that wallet.':market?.reason()||'Checking Robinhood Chain availability…';
  // The footer's wallet line is the EVM wallet on Robinhood (the Solana wallet line comes back with the Solana venues).
  const evm=evmWallet?.state()||{address:'',wallet:'',connecting:false},linked=String(launchSession?.account?.evmWallet||''),evmAddress=evm.address||'';
  $('launch-connect').textContent=evmAddress?(evm.wallet?evm.wallet+' · ':'')+evmAddress.slice(0,6)+'…'+evmAddress.slice(-4):'Connect EVM wallet';$('launch-connect').disabled=busy||!!evm.connecting;
  $('launch-disconnect').hidden=!evmAddress;
  $('launch-wallet-mode-note').textContent=evmAddress?'Your coin launches from this EVM wallet.'+(/^0x[0-9a-fA-F]{40}$/.test(linked)?(linked.toLowerCase()===evmAddress.toLowerCase()?' Linked to your account ✓':' Not the wallet linked to your account ('+linked.slice(0,6)+'…'+linked.slice(-4)+').'):''):(/^0x[0-9a-fA-F]{40}$/.test(linked)?'Connect your linked wallet '+linked.slice(0,6)+'…'+linked.slice(-4)+' (MetaMask, Rabby or another EVM wallet) to launch.':'Connect an EVM wallet (MetaMask, Rabby or another wallet extension) to launch on Robinhood Chain.');
  for(const id of ['launch-pump-classic-disclosure','launch-damm-pump-disclosure','launch-meteora-disclosure','launch-pump-public-disclosure','launch-pump-rewards-note'])$(id).hidden=true;
  if(market?.pair){const pair=market.pair;$('launch-card-fdv').textContent=market.tier==='4k'?'$4,000':'$20,000';$('launch-card-fdv').parentElement.hidden=false;$('launch-card-mode').textContent=(market.mode in modes?modes[market.mode]:market.mode);$('launch-card-mode').parentElement.hidden=false;const card=$('launch-card-pair');if(card&&card.dataset.mint!=='rh:'+pair.address){card.dataset.mint='rh:'+pair.address;card.replaceChildren();if(pair.logo&&/^(?:\/robinhood-pairs\/logo\/0x[0-9a-fA-F]{40}(?:\?v=\d+)?|https:\/\/\S+)$/.test(pair.logo)){const img=document.createElement('img');img.src=pair.logo;img.width=18;img.height=18;img.alt='';img.className='launch-card-pair-logo';img.addEventListener('error',()=>img.remove());card.append(img);}card.append(document.createTextNode(pair.symbol));}$('launch-card-buy').textContent=amountLabel(document.getElementById('rh-dev-buy')?.value,pair.symbol);}
  if(robinhoodMarket&&!robinhoodMarket.status&&launchSessionReady&&csrf)void robinhoodMarket.refresh();
}
function resetRobinhoodAccess(){robinhoodController?.dispose();robinhoodController=null;robinhoodMarket?.dispose();robinhoodMarket=null;$('launch-robinhood-dialog')?.close();}
async function openRobinhood(id=''){
  error();
  try{
    if(!csrf||!launchSessionReady)throw Error('Sign in to launch on Robinhood Chain.');
    const module=await ensureRobinhoodModules();await ensureRobinhoodMarket();if(disposed)return;
    if(!robinhoodController){
      robinhoodController=module.createRobinhoodLaunch({document,window,root:$('launch-robinhood-operation'),request:robinhoodApi,wallet:evmWallet,getInput:robinhoodInput,context:()=>({active:$('launch-robinhood-dialog').open}),connectWallet:openEvmWallets,linkedWallet:()=>launchSession?.account?.evmWallet||'',onChange:()=>{if(!disposed)syncForm();},onLive:launch=>{if(disposed)return;$('launch-toast').hidden=false;$('launch-toast-link').href=launch.coinUrl||'/coin?mint='+encodeURIComponent(launch.token||'')+'&chain=robinhood';clearLaunchedForm({name:launch.name,symbol:launch.symbol});}});
    }
    else if(!robinhoodController.locked&&!id)robinhoodController.reset();
    $('launch-robinhood-note').textContent='';
    if(!$('launch-robinhood-dialog').open)$('launch-robinhood-dialog').showModal();
    if(id)await robinhoodController.open(id);else await robinhoodController.start();
    syncForm();
  }catch(e){if(e?.cancelled)return;error(e.message||'Robinhood Chain is not available right now.');}
}
// The header's Solana | Robinhood toggle (workspace-shell.js) picks the chain step here instead of leaving the page.
document.addEventListener('curve-chain-selected',event=>{const chain=event.detail?.chain;if(chain!=='solana'&&chain!=='robinhood')return;event.preventDefault();setLaunchChain(chain);});
$('launch-robinhood-close').onclick=()=>{$('launch-robinhood-dialog').close();robinhoodController?.stop();syncForm();};
$('launch-robinhood-dialog').addEventListener('close',()=>{robinhoodController?.stop();syncForm();});
/** The EVM wallet picker: every wallet the browser announces (EIP-6963) and the injected one; a single wallet connects at once. */
function openEvmWallets(){
  return new Promise(resolve=>{
    const dialog=$('launch-evm-wallet-dialog'),options=$('launch-evm-wallet-options'),errorLine=$('launch-evm-wallet-error');
    const list=evmWallet.list();errorLine.hidden=true;errorLine.textContent='';
    const finish=()=>{dialog.removeEventListener('close',finish);resolve(evmWallet.state());};
    if(!list.length){errorLine.textContent='No EVM wallet was found in this browser. Install MetaMask, Rabby or another EVM wallet and reload.';errorLine.hidden=false;options.replaceChildren();}
    else if(list.length===1){evmWallet.connect(list[0].uuid).then(()=>{dialog.close();},e=>{errorLine.textContent=evmWalletModule.walletErrorText(e);errorLine.hidden=false;});}
    options.replaceChildren();
    for(const entry of list){
      const button=node('button');button.type='button';button.className='launch-wallet-option';
      if(entry.icon){const img=document.createElement('img');img.src=entry.icon;img.width=24;img.height=24;img.alt='';button.append(img);}
      button.append(node('span',entry.name));
      button.onclick=()=>{errorLine.hidden=true;button.disabled=true;evmWallet.connect(entry.uuid).then(()=>dialog.close(),e=>{button.disabled=false;errorLine.textContent=evmWalletModule.walletErrorText(e);errorLine.hidden=false;});};
      options.append(button);
    }
    dialog.addEventListener('close',finish);if(!dialog.open)dialog.showModal();
  });
}
$('launch-evm-wallet-close').onclick=()=>$('launch-evm-wallet-dialog').close();
// v71.43: a host with Robinhood Chain off lists Solana alone (the chain step hides, see curve-theme.css) and never opens on Robinhood.
const robinhoodOn=document.body?.dataset?.robinhood!=='off';
chainSelect=createChainSelect({document,root:$('launch-chain-select'),value:'solana',onChange:id=>setLaunchChain(id),hidden:robinhoodOn?[]:['robinhood']});
{let remembered='';try{remembered=window.localStorage?.getItem(CHAIN_STORAGE)||'';}catch{}const initial=initialLaunchChain({search:window.location?.search||'',remembered});setLaunchChain(robinhoodOn||initial!=='robinhood'?initial:'solana',{silent:true});}
function openCreate(){if(isRobinhood())return openRobinhood();if(isPumpClassic())return openPumpClassic();if(isDammPump())return openDammPump();if(isMeteora())return openMeteora();if(isPump())return pumpPublic?openPublicPump():previewPump();error();try{if(pairUnavailable(asset))throw Error('This pairing asset is unavailable. Choose an available pair or wait for it to be verified.');if(walletOnly&&!launchWallet.state().address){openWallets();throw Error('Connect your wallet to launch.');}if(imageBusy)throw Error('Wait for the image upload to finish.');if(!imageId)throw Error('Add a coin image first.');validateInput({...rawInput(),devBuySol:'0'});/* the first-buy amount is entered and checked in the dialog */selected=null;progressNote='';$('launch-buy-dialog').dataset.existing='false';$('launch-buy-dialog').showModal();syncProgress();schedulePrepare(0);}catch(e){error(e.message);}}
$('launch-open').onclick=openCreate;
function closeCreate(){if(flow||creating)stopApprovals(flow&&!flow.external?'Your launch continues in the background. Check Launched tokens for progress.':'Future approvals stopped. Submitted transactions can still confirm.');$('launch-buy-dialog').close();invalidatePrepared();syncForm();}
$('launch-buy-close').onclick=closeCreate;$('launch-buy-dialog').addEventListener('cancel',()=>{if(flow||creating)stopApprovals(flow&&!flow.external?'Your launch continues in the background. Check Launched tokens for progress.':'Future approvals stopped. Submitted transactions can still confirm.');invalidatePrepared();});
$('launch-toast-close').onclick=()=>$('launch-toast').hidden=true;
function checkFlow(token){assertRaydium();if(disposed||!flow||token!==flowVersion)throw Object.assign(Error(progressNote||'Approvals stopped.'),{cancelled:true});if(flow.external&&launchWallet.state().address!==flow.wallet)throw Error('Connect the developer wallet for this launch.');}
async function runLaunch(l,{fees=false}={}){
  assertRaydium();
  if(walletOnly&&!fees&&(l.walletMode||l.input.walletMode)!=='external')throw Error('Connect your wallet to create a new launch.');
  const token=++flowVersion;flow={version:token,id:l.id,purpose:fees?'fees':'launch',wallet:fees?(l.feeClaim?.wallet||l.wallet):(l.developerWallet||l.wallet),external:fees?externalFeeSigner(l):(l.walletMode||l.input.walletMode)==='external'};progressNote='';if(!fees)startedLaunches.add(l.id);select(l);const deadline=Date.now()+5*60*1000,submitted=new Set();let approvals=0,replacements=0;
  const maxApprovals=fees?2:Math.max(1,Number(l.review?.approvals)||2);
  try{while(Date.now()<deadline){checkFlow(token);let current=selected;if(current.id!==l.id)throw Error('Launch selection changed.');if(current.state==='live'&&(!fees||current.feesRequested===false&&!current.cycle&&!current.pendingSignature)){if(fees){progressNote='Reward processing finished.';syncProgress();}else announceSuccess(current);return;}if(!current.curve&&(current.recovery||current.state==='failed')){progressNote='';syncProgress();return;}if(['error','paused'].includes(current.state)){if(current.retry){await wait(1200);await retryRequest('',undefined,()=>checkFlow(token)).then(r=>{launches=r.launches;const latest=launches.find(x=>x.id===l.id);if(latest)select(latest);});continue;}throw Error(current.error||'Your launch is paused. Its progress is saved.');}
      if(flow.external&&current.pendingSignature&&!submitted.has(current.pendingSignature.operationId)){
        const old=current.pendingSignature,stored=signedRequests.get(old.operationId);let pending=old;
        if(!stored){progressNote='Refreshing the wallet request…';syncProgress();current=await retryRequest('/signature',{id:l.id,operationId:old.operationId},()=>checkFlow(token));checkFlow(token);select(current);if(!current.pendingSignature)continue;pending=current.pendingSignature;if(approvals>=maxApprovals)throw Error('Another wallet approval is needed. Your progress is saved; resume when ready.');progressNote='Approve the transaction in your wallet.';syncProgress();const transaction=await bounded(launchWallet.sign(pending),{signal:actionJob?.controller.signal,timeoutMs:walletTimeoutMs,error:Object.assign(Error('Your wallet has not returned an approval. Open your connected wallet, dismiss any old request, then resume this saved launch.'),{code:'LAUNCH_WALLET_TIMEOUT'})});checkFlow(token);signedRequests.set(pending.operationId,{id:l.id,operationId:pending.operationId,transaction});}
        const body=signedRequests.get(pending.operationId);progressNote='Confirming your transaction…';syncProgress();let result;
        try{result=await retryRequest('/sign',body,()=>checkFlow(token));}
        catch(e){
          // The server rejects changed message bytes before submission. A later
          // explicit Resume must ask the wallet again, not replay rejected bytes.
          if(e.code==='WALLET_TRANSACTION_REJECTED'||e.message==='The wallet changed the reviewed transaction. Nothing was submitted.')signedRequests.delete(pending.operationId);
          // Only a definite pre-submission expiry permits replacement. Network
          // failures keep the same signed bytes so retries cannot spend twice.
          if(/wallet-signing request expired/i.test(e.message)&&replacements<3){const refreshed=await retryRequest('/signature',{id:l.id,operationId:pending.operationId},()=>checkFlow(token));checkFlow(token);if(refreshed.pendingSignature?.operationId!==pending.operationId){signedRequests.delete(pending.operationId);replacements++;progressNote='Refreshing the wallet request…';select(refreshed);continue;}}
          throw e;
        }
        checkFlow(token);approvals++;submitted.add(pending.operationId);signedRequests.delete(pending.operationId);progressNote='';select(result);continue;
      }
      await wait(1200);checkFlow(token);const result=await retryRequest('',undefined,()=>checkFlow(token));launches=result.launches;renderList();const latest=launches.find(x=>x.id===l.id);if(latest)select(latest);
    }progressNote='Your launch is still processing. Progress is saved; you can return to your coin page.';
  }finally{if(flow?.version===token)flow=null;syncForm();syncProgress();}
}
form.onsubmit=e=>{e.preventDefault();if(isPumpClassic())return openPumpClassic();if(isPump())return pumpPublic?openPublicPump():previewPump();if(!$('launch-buy-dialog').open){openCreate();return;}return action(async()=>{
  if(pairUnavailable(asset))throw Error('This pairing asset is unavailable. Choose an available pair or wait for it to be verified.');
  const plan=currentPreparation();if(!plan)throw Error('Wait for the current launch cost before creating your coin.');const raw=rawInput(),version=prepareVersion,creationVersion=flowVersion;validateInput(raw);creating=true;syncForm();
  try{const draft=await retryRequest('/create',{...raw,prepareId:plan.prepareId});selected=draft;
    if(creationVersion!==flowVersion)throw Object.assign(Error('Launch stopped before approval. Your draft is saved.'),{cancelled:true});
    if(version!==prepareVersion)throw Error('Launch details changed. Check the updated cost before launching.');
    if(draft.reviewHash!==plan.reviewHash){
      // Create is idempotent: after an interrupted launch, the same request
      // returns its saved record even if Prepare produced a newer review.
      // Show that record for a separate approval; never authorize a different
      // review or create another launch to work around the mismatch.
      invalidatePrepared();select(draft,true);
      if(!draft.recovery&&draft.state!=='failed')progressNote=draft.state==='draft'?'Your saved launch cost is shown above. Review it before creating your coin.':draft.state==='live'?'Your coin is already live.':'Your earlier launch is saved. Resume it below to continue from its saved progress.';
      syncProgress();return;
    }
    $('launch-buy-dialog').dataset.existing='true';renderBudget(draft.review);const launch=await retryRequest('/action',{id:draft.id,action:'launch',reviewHash:draft.reviewHash,confirm:true});creating=false;startedLaunches.add(launch.id);select(launch);
    if(creationVersion!==flowVersion)return;await runLaunch(launch);
  }finally{creating=false;}
},$('launch-review-button'));};
$('launch-retry').onclick=()=>action(async()=>{assertRaydium();let l=selected;if(!l||l.archived||!l.curve&&(l.recovery||l.state==='failed'))throw Error('This launch cannot be resumed. Once setup recovery finishes, edit the saved details to create a new launch.');const external=(l.walletMode||l.input.walletMode)==='external';if(walletOnly&&!l.curve&&!external)throw Error('This draft requires a managed wallet. Create a new launch with your connected wallet.');if(external&&(!l.curve||externalFeeSigner(l))&&launchWallet.state().address!==(l.developerWallet||l.wallet)){openWallets();throw Error('Connect the developer wallet for this launch.');}progressNote='';
  if(l.canReprepare&&l.state==='error'||l.state==='draft'&&Date.now()>=l.reviewExpires){select(await api('/review',{id:l.id}));progressNote='Your updated launch cost is shown above.';syncProgress();return;}
  if(l.state==='draft')l=await api('/action',{id:l.id,action:'launch',reviewHash:l.reviewHash,confirm:true});else if(['error','paused'].includes(l.state))l=await api('/action',{id:l.id,action:'resume'});await runLaunch(l,{fees:!!l.curve});
},$('launch-retry'));
$('launch-fees').onclick=()=>action(async()=>{const l=selected;if(externalFeeSigner(l)&&launchWallet.state().address!==(l.feeClaim?.wallet||l.wallet)){openWallets();throw Error('Connect the developer wallet to claim creator fees.');}await runLaunch(await api('/action',{id:l.id,action:'fees'}),{fees:true});},$('launch-fees'));
$('launch-automation').onclick=async()=>{
  const l=selected;if(!canManageAutomation(l)||automationBusy||busy&&!(l.autoFees&&flow?.purpose==='fees'))return;
  if(!l.autoFees)return action(async()=>{select(await api('/action',{id:l.id,action:'resume',autoFees:true}));},$('launch-automation'));
  // A receipt wait must not prevent the owner from stopping future reward work.
  automationBusy=true;error();syncProgress();
  try{const updated=await api('/action',{id:l.id,action:'pause',autoFees:false});if(flow?.purpose==='fees'&&flow.id===l.id)stopApprovals('Automatic rewards are paused. Submitted transactions will still be checked.');else progressNote='';if(selected?.id===l.id)select(updated);}
  catch(e){if(!e.cancelled)error(e.message);}
  finally{automationBusy=false;syncProgress();}
};
$('launch-export').onclick=()=>action(async()=>{try{const data=await api('/export',{id:selected.id,password:$('launch-password').value,code:$('launch-code').value});const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=node('a');a.href=url;a.download=`launch-wallet-${selected.input.symbol}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}finally{$('launch-password').value='';$('launch-code').value='';}},$('launch-export'));
$('launch-stop').onclick=()=>stopApprovals();
async function walletLogin(){
  const request=async(path,body)=>{const r=await pageFetch('/api/wallet/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(disposed)throw cancelled();if(!r.ok)throw Error(data.error||'Wallet connection failed.');return data;};
  const challenge=await request('challenge',{address:launchWallet.state().address});
  const signature=await launchWallet.signMessage(challenge.message);
  const session=await request('verify',{nonce:challenge.nonce,signature});
  if(disposed)throw cancelled();await activateSession(session);
  if(disposed)throw cancelled();document.dispatchEvent(new document.defaultView.CustomEvent('curve-account-updated',{detail:session}));
}
$('launch-gate-connect').onclick=openWallets;
function openWallets(){syncWallet();$('launch-wallet-dialog').showModal();}
// On Robinhood the footer's Connect / Disconnect work the EVM wallet; on the Solana venues, the Solana wallet.
async function connectEvmFromFooter(){error();try{if(!csrf||!launchSessionReady)throw Error('Sign in to launch on Robinhood Chain.');await ensureRobinhoodModules();if(disposed)return;await openEvmWallets();}catch(e){if(!disposed)error(e.message);}finally{if(!disposed)syncForm();}}
$('launch-connect').onclick=()=>isRobinhood()?void connectEvmFromFooter():openWallets();$('launch-wallet-close').onclick=()=>$('launch-wallet-dialog').close();$('launch-disconnect').onclick=()=>isRobinhood()?(evmWallet?.disconnect(),syncForm()):action(()=>launchWallet.disconnect(),$('launch-disconnect'));
syncForm();
async function activateSession(session){
  if(disposed)return;
  launchSession=session;
  const nextWalletOnly=session.features?.walletOnly!==false||session.account?.authType==='wallet';if(nextWalletOnly!==walletOnly){walletOnly=nextWalletOnly;invalidatePrepared();stopApprovals('Wallet requirements changed. Review your launch again.');}
  createWorkspaceShell({session,page:'launchpad',chain:'solana'});
  const legacySignIn=document.querySelector('.launch-welcome-signin');if(legacySignIn)legacySignIn.hidden=walletOnly;
  if(!session.authenticated){resetMeteoraAccess();resetDammPumpAccess();resetPumpClassicAccess();resetRobinhoodAccess();resetPumpAccess();clearCatalogue();launchCatalogueSession='';sessionGeneration++;csrf='';launchSessionAccount='';launchSessionReady=false;selected=null;launches=[];venueLaunches=[];loading=null;resetImage();invalidatePrepared();stopApprovals('You signed out. Connect your wallet before continuing.');$('launch-buy-dialog').close();$('launch-gate').hidden=false;$('launch-main').hidden=true;$('launch-gate-message').textContent='Connect your Solana wallet to create a coin. No separate signup needed.';return;}
  csrf=session.token;sessionWallet=session.account?.authType==='wallet'?session.account.mainWallet:'';
  const identity=session.account?.id||session.account?.mainWallet||session.account?.username||'authenticated',catalogueSession=JSON.stringify([session.account?.role||'',session.account?.mfaEnabled===true,session.monitorAllowed===true]);if(identity===launchSessionAccount&&launchSessionReady&&catalogueSession===launchCatalogueSession){syncForm();return;}
  resetMeteoraAccess();resetDammPumpAccess();resetPumpClassicAccess();resetPumpAccess();clearCatalogue();launchCatalogueSession=catalogueSession;invalidatePrepared();
  const current=++sessionGeneration;
  if(launchSessionAccount&&identity!==launchSessionAccount){selected=null;launches=[];venueLaunches=[];loading=null;listVersion='';renderList();resetImage();requestId=crypto.randomUUID();invalidatePrepared();stopApprovals('Your account changed. Review this launch before continuing.');$('launch-buy-dialog').close();}
  launchSessionAccount=identity;launchSessionReady=false;adminLaunch=false;idleSkip=0;idleWait=0;$('launch-admin-fdv').hidden=true;$('launch-fixed-fdv').hidden=false;field('targetUsd').type='hidden';field('targetUsd').value='20000';
  const query=new URL(document.defaultView.location?.href||'http://localhost/launchpad').searchParams,adminRequested=query.get('admin')==='1';
  if(adminRequested){const capability=await api('/capabilities',undefined,true);if(current!==sessionGeneration)return;if(capability.adjustableMarketCap!==true)throw Error('Administrator launch access is unavailable.');adminLaunch=true;$('launch-admin-fdv').hidden=false;$('launch-fixed-fdv').hidden=true;field('targetUsd').type='range';document.querySelector('.terminal-heading .eyebrow').textContent='Launchpad / Administrator launch';}
  syncForm();$('launch-gate').hidden=true;$('launch-main').hidden=false;await load();if(current!==sessionGeneration)return;launchSessionReady=true;
  const requested=query.get('id')||query.get('reuse');if(requested){const l=launches.find(x=>x.id===requested);if(l){if(query.has('reuse')&&l.canReuseDraft)restoreDraft(l);else select(l,true);}}
  refreshCatalogue();void loadVenueLaunches();
  await Promise.all([refreshMeteoraAccess({force:true}),refreshDammPumpAccess({force:true}),refreshPumpClassicAccess({force:true})]);if(current!==sessionGeneration)return;
  const requestedVenue=query.get('venue'),requestedLaunch=query.get('launchId'),requestedGotchi=query.get('gotchi');
  if(TENANT&&!TENANT_VENUES.includes(launchVenue)){const first=['raydium','pump-classic','meteora'].find(venue=>TENANT_VENUES.includes(venue));if(first)chooseVenue(first);}
  else if(['damm-pump','meteora'].includes(requestedVenue))chooseVenue(requestedVenue);
  else if(['pump','pumpfun','pump-classic'].includes(requestedVenue)){
    chooseVenue('pump-classic');
    // /launchpad?venue=pump-classic&launchId=<id> (linked from My Tokens) opens that launch's status once signed in.
    if(/^[a-f0-9]{24}$/.test(requestedLaunch||'')&&!deepLinkShown){deepLinkShown=true;void openPumpClassic(requestedLaunch);}
  }
  // v71.39: /launchpad?chain=robinhood&launchId=<id> (linked from My Tokens) opens that Robinhood launch's status once signed in.
  if(isRobinhood()&&/^[a-f0-9]{24}$/.test(requestedLaunch||'')&&!deepLinkShown){deepLinkShown=true;void openRobinhood(requestedLaunch);}
  // /launchpad?gotchi=<id> (a Gotchi page's "Launch one →") starts a launch paired with that Gotchi, once per visit.
  if(requestedGotchi&&!gotchiLinkShown&&!query.has('reuse')&&gotchiTheme(requestedGotchi)){gotchiLinkShown=true;chooseGotchi(requestedGotchi);}
  if(!launchPollingStarted){launchPollingStarted=true;catalogueTimer=setInterval(catalogueTick,60000);pollTimer=setInterval(pollTick,8000);}
}
// Saved launches are read every 8 s while one is in progress or open in the launch dialog. An idle page reads them
// after 1, 3, 7, 15… ticks (at most about every five minutes) and once more when its tab is shown again; a hidden
// tab reads nothing.
let idleSkip=0,idleWait=0,deepLinkShown=false,gotchiLinkShown=false;
const PUMP_CLASSIC_MOVING=['funding_pending','funded','creating','refunding'];
const raydiumInProgress=l=>!l.archived&&!l.hidden&&!l.listArchived&&(['launching','pending','awaiting_signature'].includes(l.state)||['error','paused'].includes(l.state)&&!!l.retry||!l.curve&&!!l.recovery&&!['complete','not-needed'].includes(l.recovery.status)||!!l.feesRequested||!!l.cycle);
// The launch the Pump.fun dialog follows is read by its own poll, and "Your coins" reloads when it changes state.
const pumpClassicInProgress=()=>pumpClassicLaunches.some(l=>l.id!==pumpClassicController?.launch?.id&&(PUMP_CLASSIC_MOVING.includes(l.state)||l.state==='failed'&&['pending','released'].includes(l.dimensions?.refund)||l.state==='created'&&l.dimensions?.delivery==='pending'));
function pollTick(){
  if(disposed||document.hidden||busy||imageBusy)return;
  pumpFunded?.poll();
  if($('launch-buy-dialog').open&&$('launch-buy-dialog').dataset.existing!=='true'&&(!prepared||prepared.reviewExpires-Date.now()<15000)&&!preparing)schedulePrepare();
  const watching=$('launch-buy-dialog').open&&$('launch-buy-dialog').dataset.existing==='true',raydiumMoving=watching||launches.some(raydiumInProgress),pumpMoving=pumpClassicInProgress();
  if(raydiumMoving||pumpMoving){idleSkip=0;idleWait=0;if(raydiumMoving)load().catch(()=>{});if(pumpMoving)void loadPumpClassicLaunches();return;}
  if(idleSkip>0){idleSkip--;return;}
  idleWait=Math.min(idleWait*2+1,37);idleSkip=idleWait;
  load().catch(()=>{});void loadPumpClassicLaunches();void loadVenueLaunches();
}
const pageShown=()=>{if(!document.hidden)idleSkip=0;};document.addEventListener('visibilitychange',pageShown);
/** A read of this account's launch list on another venue: bound to the session, not to the venue on screen. */
async function accountList(path){
  const generation=sessionGeneration,account=launchSessionAccount,token=csrf;
  const response=await pageFetch(path,{method:'GET',credentials:'same-origin',headers:{'x-control-token':token}}),data=await response.json();
  if(disposed||generation!==sessionGeneration||account!==launchSessionAccount||token!==csrf)throw Object.assign(Error('Your account changed.'),{cancelled:true});
  if(!response.ok)throw Object.assign(Error(data?.error||'This list is unavailable right now.'),{status:response.status});
  return data;
}
const manualSignIn=document.querySelector('.launch-welcome-signin a');if(manualSignIn)manualSignIn.onclick=event=>{event.preventDefault();document.querySelector('[data-account-link]')?.click();};
const ready=(async()=>{try{const initial=await(await pageFetch('/api/session')).json();if(!disposed&&!launchSessionAccount)await activateSession(initial);}catch(e){if(!disposed){$('launch-gate-message').textContent=e.message;error(e.message);}}})();
return {ready,canLeave:()=>!busy&&!pumpBusy&&!pumpFunded?.busy&&pumpPublicController?.canLeave()!==false&&meteoraController?.canLeave()!==false&&dammPumpController?.canLeave()!==false&&pumpClassicController?.busy!==true&&pumpClassicController?.signedPending!==true&&!creating&&!flow&&!imageBusy&&!automationBusy,destroy(){if(disposed)return;disposed=true;sideSizer?.disconnect();peekAway();for(const character of gotchiCharacters||[])character.destroy();gotchiCharacters=null;actionJob?.controller.abort(cancelled());influencerStep?.destroy();influencerStep=null;basketStep?.destroy();basketStep=null;meteoraController?.destroy();dammPumpController?.destroy();pumpClassicController?.destroy();pumpPublicController?.destroy();pumpFunded?.destroy();pumpFunded=null;pumpPreviewVersion++;venueVersion++;sessionGeneration++;flowVersion++;imageGeneration++;invalidatePrepared();clearInterval(pollTimer);clearInterval(catalogueTimer);clearTimeout(catalogueRetryTimer);catalogueRetryTimer=null;document.removeEventListener('visibilitychange',catalogueVisible);document.removeEventListener('visibilitychange',pageShown);window.removeEventListener('focus',catalogueVisible);unsubscribeWallet?.();document.removeEventListener('curve-account-updated',accountUpdated);for(const controller of requests)controller.abort(cancelled());requests.clear();signedRequests.clear();}};
}
bootPage('launchpad',mountPage);
