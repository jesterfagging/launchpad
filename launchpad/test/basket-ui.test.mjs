// Reward baskets (v71.33) on the launch page (the step under the holder-reward minimum, Meteora + Holders only), the request they
// travel in, the coin page's rewards card and the docs. Harness as test/influencer-ui.test.mjs mounts launchpad.js.
import {optimizeLaunchImage} from '../public/launch-image.mjs';
import {createChainSelect,initialLaunchChain,launchChainById} from '../public/launch-chains.mjs';
import * as meteoraUiModule from '../public/meteora-ui.mjs';
import * as dammPumpUiModule from '../public/damm-pump-ui.mjs';
import * as pumpPublicUiModule from '../public/pump-public-ui.mjs';
import * as pumpUiModule from '../public/pump-launch-test-ui.mjs';
import * as pumpClassicUiModule from '../public/pump-classic-ui.mjs';
import * as influencerUiModule from '../public/influencer-ui.mjs';
import * as basketUiModule from '../public/basket-ui.mjs';
import {BASKET_LIMITS,BASKET_RULES,basketLaunchRequest,basketShares,describeBasket} from '../public/basket-catalog.mjs';
import {createCoinRewardsView} from '../public/coin-rewards-view.mjs';
import {PUMP_CLASSIC_MODES,PUMP_CLASSIC_STRATEGY_MODES,PUMP_CLASSIC_MODE_LABELS,PUMP_CLASSIC_MODE_SUMMARIES,PUMP_CLASSIC_LIMITS,PUMP_CLASSIC_FEE_LINK,PUMP_CLASSIC_SOL_ONLY_MODES,PUMP_CLASSIC_CONVERT_MODES,PUMP_CLASSIC_OPTION_MODES} from '../public/pump-classic-catalog.mjs';
import {PUMP_OPTIONS,pumpOptionRequest,describePumpOption} from '../public/pump-option-catalog.mjs';
import {AGENT_PERSONALITIES,AGENT_FUNDING_SUMMARY,AGENT_LIMITS,AGENT_OBJECTIVES,AGENT_OBJECTIVE_GROUPS,objectiveById,normalizeObjectiveSettings,AGENT_RATE_CARD_V2} from '../public/agent-catalog.mjs';
import {GOTCHI_THEMES,gotchiFundingSummary,gotchiTheme} from '../public/gotchi-catalog.mjs';
import {HOOK_GROUPS,HOOK_RULES,HOOK_MAX_RULES,HOOK_LIMITS,HOOK_NOT_OFFERED,HOOK_ROUTES,HOOK_TIMEZONES,WEEKDAYS,hookRuleById,hookRulesConflict,hookSettingApplies,hookLaunchRequest,describeHookRule,hookAppUnavailableText} from '../public/hook-catalog.mjs';
import {createQuoteIcon,createQuoteLabel} from '../public/quote-logos.mjs';
import {CREATOR_FEE_TIERS,creatorFeeForLaunch} from '../public/creator-fee-schedule.mjs';
import {createLaunchpadWallet} from '../public/launchpad-wallet.mjs';
import {launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink,agentLaunchRequest} from '../public/launchpad-model.mjs';
import {LAUNCH_ASSETS} from '../public/launch-assets.mjs';
import {INFLUENCER_TILES,INFLUENCER_LIMITS,INFLUENCER_MEDIA_MODES,INFLUENCER_RULES,influencerLaunchRequest,influencerPrompt,tileGroupsFor,defaultTiles} from '../public/influencer-catalog.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {parseHTML} from 'linkedom';

const ADDRESS='So11111111111111111111111111111111111111112',MINT='GNu1FSuype33KF4RXfow38Dw3ziw9e71FTBLVY5mdrTa';
const SIGN='solana:signTransaction',CHAIN='solana:mainnet';
const X1='a1b2c3d4e5f6a1b2c3d4e5f6',X2='0f0e0d0c0b0a0f0e0d0c0b0a',REFERENCE='c'.repeat(64)+'.png',ORIGIN='http://app.local';
const flush=()=>new Promise(resolve=>setTimeout(resolve,10));
const until=async(check,message)=>{for(let i=0;i<200;i++){if(check())return;await flush();}assert.fail(message);};
const text=node=>String(node?.textContent||'').replace(/\s+/g,' ').trim();
const escapeRegExp=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const PNG=[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,73,72,68,82,0,0,1,0,0,0,1,0,8,6,0,0,0];
const pngBytes=(size=64)=>{const bytes=new Uint8Array(size);bytes.set(PNG.slice(0,Math.min(PNG.length,size)));return bytes;};

// ---- Launch page harness (as test/hook-ui.test.mjs mounts launchpad.js), with the influencer module in place of its lazy import.
function mockWallet({address=ADDRESS}={}){
  const calls={connect:0,sign:[]};let change;
  const account={address,chains:[CHAIN],features:[SIGN],publicKey:new Uint8Array(32)};
  const wallet={name:'Test wallet',chains:[CHAIN],accounts:[],features:{
    'standard:connect':{async connect(){calls.connect++;wallet.accounts=[account];return{accounts:wallet.accounts};}},
    'standard:events':{on(type,fn){change=fn;return()=>{change=null;};}},
    'standard:disconnect':{async disconnect(){wallet.accounts=[];}},
    [SIGN]:{supportedTransactionVersions:[0],async signTransaction(input){calls.sign.push(input);return[{signedTransaction:new Uint8Array([4,5,6])}];}}
  }};
  return{wallet,calls,change(accounts){wallet.accounts=accounts;change?.({accounts});}};
}
const TSLA='XsDoVfqeBukxuZHWhdvWHBhgnNdkqfuBXCS6FbPFS9oG',NVDA='Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',PENDING='4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const pairs=[{mint:SOL_MINT,symbol:'SOL',name:'Solana',decimals:9,category:'crypto',launchReady:true,supported:true},{mint:USDC_MINT,symbol:'USDC',name:'USD Coin',decimals:6,category:'crypto',launchReady:true,supported:true},{mint:TSLA,symbol:'TSLAx',name:'Tesla xStock',decimals:8,category:'stocks',launchReady:true,supported:true},{mint:NVDA,symbol:'NVDAx',name:'NVIDIA xStock',decimals:8,category:'stocks',launchReady:true,supported:true},{mint:PENDING,symbol:'PENDx',name:'Pending Co',decimals:6,category:'stocks',launchReady:false,supported:null}];
const account=(id,handle,over={})=>({id,handle,displayName:handle+' display',state:'connected',stateReason:'',agentMint:null,connectedAt:1700000000000+id.charCodeAt(0),lastPostAt:0,postsToday:0,...over});
function launchServer({influencer={open:true,xOpen:true,mediaOpen:true},accounts=[],basketsEnabled=true}={}){
  const state={prepares:[],accounts:accounts.slice(),connects:[],disconnects:[],references:[],authenticated:true,basketsEnabled};
  state.route=async(path,body)=>{
    const url=new URL(path,'http://app.local');
    if(path==='/api/session')return{authenticated:true,token:'public-csrf',features:{walletOnly:true},account:{id:'public-user',authType:'wallet',mainWallet:ADDRESS}};
    if(url.pathname==='/api/launchpad/agents/catalog')return{intakeOpen:true,models:[{id:'openai/gpt-6-luna',name:'Luna'}],defaultModel:'openai/gpt-6-luna',domainAllowlist:[],...(influencer?{influencer:{intakeOpen:true,dryRun:false,limits:INFLUENCER_LIMITS,featureClipLengths:[10,15,30],rateCard:{version:AGENT_RATE_CARD_V2.version,imageUsd:AGENT_RATE_CARD_V2.imageUsd,editUsd:AGENT_RATE_CARD_V2.editUsd,videoSecondUsd:AGENT_RATE_CARD_V2.videoSecondUsd,videoOverheadUsd:AGENT_RATE_CARD_V2.videoOverheadUsd,mediaCheckUsd:AGENT_RATE_CARD_V2.mediaCheckUsd,xPostUsd:AGENT_RATE_CARD_V2.xPostUsd,xPostLinkUsd:AGENT_RATE_CARD_V2.xPostLinkUsd},rules:INFLUENCER_RULES,...influencer}}:{})};
    if(url.pathname==='/api/launchpad/meteora/status')return{available:true,publicEnabled:true,basketsEnabled:state.basketsEnabled!==false,basketLimits:{maxAssets:3,maxExtras:2}};
    // Pump.fun (v71.35): the same step on a Holders launch; its extra assets come from the verified catalogue (/quotes).
    if(url.pathname==='/api/launchpad/pump-classic/status')return{available:true,venue:'pump-classic',intakeOpen:true,pairsOpen:false,signedIn:true,modes:PUMP_CLASSIC_MODES.map(id=>({id,label:PUMP_CLASSIC_MODE_LABELS[id]})),limits:PUMP_CLASSIC_LIMITS,feeLink:PUMP_CLASSIC_FEE_LINK,quoteTtlMs:600000,solOnlyModes:[...PUMP_CLASSIC_SOL_ONLY_MODES],convertModes:[...PUMP_CLASSIC_CONVERT_MODES],reason:'',basketsEnabled:state.basketsEnabled!==false,basketModes:['holders'],basketLimits:{maxAssets:3,maxExtras:2}};
    if(url.pathname==='/api/launchpad/pump-classic/launches')return{launches:[]};
    if(url.pathname==='/api/launchpad/pump-classic/pairs')return{available:true,pairs:[{mint:SOL_MINT,symbol:'SOL',name:'Solana',issuer:'Native',category:'crypto',decimals:9,kind:'sol',launchReady:true,convertible:true,supportReason:'',maxDevBuy:'25',creatorFee:null,pumpClassic:true}],solOnlyModes:[...PUMP_CLASSIC_SOL_ONLY_MODES],convertModes:[...PUMP_CLASSIC_CONVERT_MODES],pairsOpen:false,stale:false};
    if(url.pathname==='/api/launchpad/pump-classic/quote'){state.prepares.push(body);return{ok:false,status:409,body:{error:'The test stops at the quote.'}};}
    if(url.pathname==='/api/launchpad/quotes')return{assets:pairs.map(a=>({...a,supported:a.launchReady===true})),canViewComingSoon:false};
    if(url.pathname==='/api/launchpad/meteora/pairs')return{pairs};
    if(url.pathname==='/api/launchpad/meteora/operations')return{operations:[]};
    if(url.pathname==='/api/launchpad/meteora/prepare'){state.prepares.push(body);return{operation:{id:'meteora-operation-123',action:'initialize',wallet:ADDRESS,mint:MINT,state:'awaiting_signature',transaction:'AQID',expiresAt:Date.now()+120000,review:{maxWalletDebitLamports:'20000000',firstBuyRaw:'0',quoteMint:SOL_MINT,quoteDecimals:9,quoteSymbol:'SOL',stage:'initialize',stages:2}}};}
    if(url.pathname==='/api/launchpad/x/accounts')return{accounts:state.accounts,available:true,at:Date.now()};
    if(url.pathname==='/api/launchpad/x/connect'){state.connects.push(url.searchParams.get('returnTo'));return{url:'https://x.com/i/oauth2/authorize?response_type=code&client_id=abc&state=s1&code_challenge=c1',expiresAt:Date.now()+600000};}
    if(url.pathname==='/api/launchpad/x/disconnect'){state.disconnects.push(body);state.accounts=state.accounts.filter(row=>row.id!==body.xAccountId);return{accounts:state.accounts};}
    if(url.pathname==='/api/launchpad/agents/influencer/reference'){state.references.push(body);return{referenceId:REFERENCE,bytes:Math.floor(String(body.data).length*3/4),type:'png'};}
    return undefined;
  };
  return state;
}
async function launchPage({route,mock=mockWallet(),href='http://app.local/launchpad'}={}){
  const {document,window}=parseHTML(await readFile(new URL('../public/launchpad.html',import.meta.url),'utf8'));
  Object.defineProperty(window,'location',{value:{href},configurable:true});
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return[...this.options].find(o=>o.selected)?.value||this.options[0]?.value||'';},set(value){for(const o of this.options)o.removeAttribute('selected');[...this.options].find(o=>o.value===String(value))?.setAttribute('selected','');}});
  for(const input of document.querySelectorAll('input[type=radio],input[type=checkbox]'))input.checked=input.hasAttribute('checked');
  const form=document.getElementById('launch-form'),fields={namedItem(name){const rows=[...form.querySelectorAll('[name]')].filter(x=>x.name===name);return rows.length===1?rows[0]:{get value(){return rows.find(x=>x.checked)?.value||'';}};}};
  Object.defineProperty(form,'elements',{value:fields});
  window.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},drawImage(){}});window.HTMLCanvasElement.prototype.toBlob=fn=>fn({size:30});
  window.HTMLElement.prototype.scrollIntoView=function(){};window.HTMLElement.prototype.showModal=function(){this.open=true;};window.HTMLElement.prototype.close=function(){this.open=false;};
  class FileReader{readAsDataURL(){this.result='data:image/webp;base64,AAAA';this.onload();}}
  class FormData{constructor(form){this.form=form;}*[Symbol.iterator](){for(const input of this.form.querySelectorAll('[name]'))if(!input.disabled&&(!['checkbox','radio'].includes(input.type)||input.checked))yield[input.name,input.value];}}
  const calls=[],intervals=new Map(),opened=[];
  Object.defineProperty(window,'open',{value:(url,name,features)=>{opened.push({url,name,features});return opened.blocked?null:{closed:false,close(){}};},configurable:true});
  Object.defineProperty(window,'confirm',{value:()=>true,configurable:true});
  const fetch=async(path,options={})=>{const body=options.body?JSON.parse(options.body):undefined;calls.push({path,body,method:options.method||'GET',headers:options.headers||{}});const data=await route?.(path,body);if(data)return{ok:data.ok!==false,status:data.status||200,json:async()=>data.body??data};return{ok:true,status:200,json:async()=>path.endsWith('/quotes')?{assets:LAUNCH_ASSETS.map(a=>({...a,supported:true})),canViewComingSoon:false}:path.endsWith('/image')?{imageId:'a'.repeat(64)+'.webp'}:{launches:[]}};};
  window.addEventListener('wallet-standard:app-ready',event=>event.detail.register(mock.wallet));
  const source=(await readFile(new URL('../public/launchpad.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'').replace("await import('./pump-launch-test-ui.mjs')",'pumpUiModule').replace("await import('./pump-public-ui.mjs')",'pumpPublicUiModule').replace("await import('./meteora-ui.mjs')",'meteoraUiModule').replace("await import('./damm-pump-ui.mjs')",'dammPumpUiModule').replace("await import('./pump-classic-ui.mjs')",'pumpClassicUiModule').replace("import('./influencer-ui.mjs')",'Promise.resolve(influencerUiModule)').replace("import('./basket-ui.mjs')",'Promise.resolve(basketUiModule)').replace(/bootPage\('launchpad',mountPage\);/,'')+'\nconst pageController=mountPage({document,window:document.defaultView});await pageController.ready;return pageController;';
  const deps={createChainSelect,initialLaunchChain,launchChainById,optimizeLaunchImage,meteoraUiModule,dammPumpUiModule,pumpUiModule,pumpPublicUiModule,pumpClassicUiModule,influencerUiModule,basketUiModule,PUMP_CLASSIC_MODES,PUMP_CLASSIC_STRATEGY_MODES,PUMP_CLASSIC_MODE_LABELS,PUMP_CLASSIC_MODE_SUMMARIES,PUMP_CLASSIC_LIMITS,PUMP_CLASSIC_FEE_LINK,PUMP_CLASSIC_SOL_ONLY_MODES,PUMP_CLASSIC_CONVERT_MODES,PUMP_CLASSIC_OPTION_MODES,PUMP_OPTIONS,pumpOptionRequest,describePumpOption,AGENT_PERSONALITIES,AGENT_FUNDING_SUMMARY,AGENT_LIMITS,AGENT_OBJECTIVES,AGENT_OBJECTIVE_GROUPS,objectiveById,normalizeObjectiveSettings,GOTCHI_THEMES,gotchiFundingSummary,gotchiTheme,HOOK_GROUPS,HOOK_RULES,HOOK_MAX_RULES,HOOK_LIMITS,HOOK_NOT_OFFERED,HOOK_ROUTES,HOOK_TIMEZONES,WEEKDAYS,hookRuleById,hookRulesConflict,hookSettingApplies,hookLaunchRequest,describeHookRule,hookAppUnavailableText,createQuoteIcon,createQuoteLabel,CREATOR_FEE_TIERS,creatorFeeForLaunch,document,fetch,FileReader,createImageBitmap:async()=>({width:8,height:8,close(){}}),crypto:{randomUUID},FormData,requestAnimationFrame:fn=>{setTimeout(fn,0);return 1;},setInterval:(fn,ms)=>{intervals.set(ms,fn);return ms;},clearInterval:ms=>{intervals.delete(ms);},setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,10)),matchMedia:()=>({matches:true}),createWorkspaceShell:()=>{},launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink,LAUNCH_ASSETS,createLaunchpadWallet};
  const controller=await new (Object.getPrototypeOf(async()=>{}).constructor)(...Object.keys(deps),source)(...Object.values(deps));await flush();
  const $=id=>document.getElementById(id);
  const p={controller,document,window,form,$,calls,mock,intervals,opened,
    async meteora(){document.querySelector('[data-launch-venue=meteora]').onclick();await flush();await flush();},
    async pumpClassic(){document.querySelector('[data-launch-venue=pump-classic]').onclick();await flush();await flush();await flush();},
    option(value){for(const radio of form.querySelectorAll('[name=feeMode]'))radio.checked=radio.value===value;form.dispatchEvent(new window.Event('change'));},
    async agent(){p.option('agent');await flush();await flush();await flush();},
    check(id,on=true){const input=$(id);assert(input,id);assert.equal(input.disabled,false,id+' is disabled');input.checked=on;input.dispatchEvent(new window.Event('change',{bubbles:true}));},
    pick(name,value){const radio=form.querySelector('input[name="'+name+'"][value="'+value+'"]');assert(radio,name+'='+value);assert.equal(radio.disabled,false,name+'='+value+' is disabled');radio.checked=true;radio.dispatchEvent(new window.Event('change',{bubbles:true}));},
    type(id,value){const input=$(id);assert(input,id);input.value=String(value);input.dispatchEvent(new window.Event('input',{bubbles:true}));},
    select(id,value){const select=$(id);assert(select,id);select.value=String(value);select.dispatchEvent(new window.Event('change',{bubbles:true}));},
    groups:()=>[...$('launch-influencer-tiles').querySelectorAll('.launch-influencer-group')].filter(group=>!group.hidden).map(group=>group.dataset.group),
    message(data,origin=ORIGIN){window.dispatchEvent(new window.MessageEvent('message',{data,origin}));},
    async image(){Object.defineProperty($('launch-image'),'files',{value:[{type:'image/png',size:30}],configurable:true});await $('launch-image').onchange();},
    async fill(){form.elements.namedItem('name').value='Example';form.elements.namedItem('symbol').value='EXAMPLE';p.type('launch-agent-mission','Tell holders what changed and why.');await this.image();},
    async open(){$('launch-open').onclick();await flush();await flush();},
    async connect(){$('launch-connect').onclick();document.querySelector('#launch-wallet-options button').onclick();await flush();},
    async upload(file){const input=$('launch-influencer-reference-file');Object.defineProperty(input,'files',{value:file?[file]:[],configurable:true});input.dispatchEvent(new window.Event('change',{bubbles:true}));await flush();await flush();await flush();}};
  return p;
}


// Basket-step helpers on top of the page object.
const basketOf=p=>({
  root:()=>p.$('launch-basket'),chips:()=>[...p.$('launch-basket-chips').querySelectorAll('.launch-basket-chip')].map(chip=>[text(chip.querySelector('strong')),chip.classList.contains('is-pair')]),
  extras:()=>p.$('launch-basket-extras').value,status:()=>text(p.$('launch-basket-status')),error:()=>p.$('launch-basket-error'),
  async add(symbol){const add=p.$('launch-basket-add');if(p.$('launch-basket-picker').hidden){add.onclick();await flush();}const option=[...p.$('launch-basket-list').querySelectorAll('.launch-basket-option')].find(button=>text(button.querySelector('strong'))===symbol);assert(option,symbol+' is offered');option.onclick();await flush();await flush();},
  async remove(symbol){const chip=[...p.$('launch-basket-chips').querySelectorAll('.launch-basket-chip')].find(chip=>text(chip.querySelector('strong'))===symbol);assert(chip,symbol+' is in the basket');chip.querySelector('.launch-basket-remove').onclick();await flush();await flush();},
  options:()=>[...p.$('launch-basket-list').querySelectorAll('.launch-basket-option')].map(button=>text(button.querySelector('strong'))),
  async search(value){const input=p.$('launch-basket-search');input.value=value;input.dispatchEvent(new p.window.Event('input',{bubbles:true}));await flush();},
  async pair(symbol){const a=[...p.document.querySelectorAll('[data-pair]')];if(symbol==='SOL'||symbol==='USDC'){a.find(b=>b.dataset.pair===symbol).onclick();}else{p.$('launch-asset-open').onclick();await flush();const button=[...p.$('launch-asset-dialog').querySelectorAll('button')].find(b=>text(b).includes(symbol));assert(button,'pair '+symbol);button.onclick();}await flush();await flush();},
});

test('the reward basket step shows for Meteora + Holders when the host offers baskets: the pair asset is fixed, up to two verified pairs can be added from the picker, the preview card and fee note follow, and nothing travels until a launch',async t=>{
  const s=launchServer(),p=await launchPage({route:s.route});t.after(()=>p.controller.destroy());const b=basketOf(p);
  assert.equal(b.root().hidden,true,'Raydium: no basket');
  await p.meteora();assert.equal(b.root().hidden,true,'Meteora + Creator: no basket');assert.equal(p.$('launch-card-basket-row').hidden,true);
  p.option('holders');await flush();await flush();
  assert.equal(b.root().hidden,false);assert.match(text(p.$('launch-basket').querySelector('legend')),/Reward basket \(optional\)/);assert.match(text(p.$('launch-basket').querySelector('legend')),/your pair asset plus up to 2 more/);
  assert.match(text(p.$('launch-basket-intro')),/split equally across the basket/);assert.match(text(p.$('launch-basket-intro')),/converted at market by Launchpad/);assert.match(text(p.$('launch-basket-intro')),/still trades against your pair asset only/);
  assert.deepEqual(b.chips(),[['SOL',true]]);assert.equal(b.status(),'No extra assets yet. Holders are paid in SOL only.');assert.equal(b.extras(),'');assert.equal(p.$('launch-basket-add').hidden,false);assert.equal(text(p.$('launch-basket-add')),'Add an asset');
  assert.deepEqual([...p.$('launch-basket-rules').querySelectorAll('li')].map(text),[...BASKET_RULES]);
  // The picker lists verified pairs only (no pending pair, not the pair asset itself), searchable.
  p.$('launch-basket-add').onclick();await flush();assert.equal(p.$('launch-basket-picker').hidden,false);assert.deepEqual(b.options(),['USDC','TSLAx','NVDAx']);
  await b.search('xstock');assert.deepEqual(b.options(),['TSLAx','NVDAx']);await b.search('');
  await b.add('TSLAx');
  assert.deepEqual(b.chips(),[['SOL',true],['TSLAx',false]]);assert.equal(b.extras(),TSLA);assert.equal(b.status(),'1 extra asset in the basket · SOL and TSLAx');assert.equal(p.$('launch-basket-picker').hidden,false,'room for one more: the picker stays open');assert.deepEqual(b.options(),['USDC','NVDAx']);
  assert.equal(p.$('launch-card-basket-row').hidden,false);assert.equal(text(p.$('launch-card-basket')),'SOL + TSLAx · equal shares');
  assert.match(text(p.$('launch-fee-note')),/holder rewards paid in every basket asset \(SOL \+ TSLAx · equal shares\), converted at market each round/);
  await b.add('NVDAx');
  assert.deepEqual(b.chips(),[['SOL',true],['TSLAx',false],['NVDAx',false]]);assert.equal(b.extras(),TSLA+','+NVDA);assert.equal(p.$('launch-basket-add').hidden,true,'three assets: nothing more to add');assert.equal(p.$('launch-basket-picker').hidden,true);
  assert.equal(b.status(),'2 extra assets in the basket · SOL, TSLAx and NVDAx');assert.equal(text(p.$('launch-card-basket')),'SOL + TSLAx + NVDAx · equal shares');assert.equal(b.error().hidden,true);
  // The pure helpers agree with the step.
  assert.deepEqual(basketUiModule.basketExtrasOf(p.form),[TSLA,NVDA]);assert.deepEqual(basketLaunchRequest(basketUiModule.basketExtrasOf(p.form),{quoteMint:SOL_MINT}),{version:1,extras:[TSLA,NVDA]});
  assert.equal(basketUiModule.basketSummary([TSLA],{main:{symbol:'SOL'},assets:pairs}),'SOL + TSLAx · equal shares');assert.equal(basketUiModule.basketSummary([],{main:{symbol:'SOL'},assets:pairs}),'');
  assert.equal(describeBasket(['SOL','TSLAx','NVDAx']),'SOL, TSLAx and NVDAx');assert.deepEqual(basketShares('1000000001',3).map(String),['333333335','333333333','333333333']);
  // Removing: the chip's × ; choosing a basket asset as the pair drops it from the basket.
  await b.remove('NVDAx');assert.equal(b.extras(),TSLA);assert.deepEqual(b.chips(),[['SOL',true],['TSLAx',false]]);
  await b.pair('TSLAx');assert.equal(b.extras(),'','the pair asset left the basket');assert.deepEqual(b.chips(),[['TSLAx',true]]);assert.equal(text(p.$('launch-card-basket')),'Off');assert.equal(p.$('launch-card-basket-row').hidden,true);
  await b.pair('SOL');await b.add('USDC');assert.equal(b.extras(),USDC_MINT);
  // Switching to Creator hides the step and the preview row but keeps the choice; the launch is blocked until it is Holders again or the basket is cleared.
  p.option('creator');await flush();await flush();assert.equal(b.root().hidden,false,'a chosen basket stays visible so it can be removed');assert.equal(b.status(),'The basket applies to Meteora launches with holder rewards only.');assert.equal(p.$('launch-basket-add').hidden,true);assert.equal(p.$('launch-card-basket-row').hidden,true);
  assert.equal(b.error().hidden,false);assert.match(text(b.error()),/Reward baskets are for Meteora launches with holder rewards/);assert.equal(p.$('launch-open').disabled,true);
  p.option('holders');await flush();await flush();assert.equal(b.error().hidden,true);assert.equal(p.$('launch-open').disabled,false);
  await p.connect();await p.fill();p.option('creator');await flush();await flush();assert.match(p.$('launch-ready-text').textContent,/choose Holders or remove the reward basket/);p.option('holders');await flush();await flush();
  // Nothing about the basket travels on its own: no basket* field in the launch form data, and the raw launch input drops them.
  assert.deepEqual([...p.form.querySelectorAll('[name^=basket]')].map(node=>node.name),['basketExtras']);
});

test('the Meteora launch request carries the basket as the extra mints when Holders is chosen; a host without baskets hides the step; the pure check names a pair that is no longer verified',async t=>{
  const s=launchServer(),p=await launchPage({route:s.route});t.after(()=>p.controller.destroy());const b=basketOf(p);
  await p.connect();await p.meteora();await p.fill();p.option('holders');await flush();await flush();
  await b.add('TSLAx');await b.add('USDC');assert.equal(b.extras(),TSLA+','+USDC_MINT);
  await p.open();await until(()=>s.prepares.length===1,'the launch was not prepared');
  const body=s.prepares[0];assert.equal(body.feeMode,'holders');assert.equal(body.quoteMint,SOL_MINT);assert.deepEqual(body.basket,[TSLA,USDC_MINT]);assert.deepEqual(Object.keys(body).filter(key=>/^basket/i.test(key)),['basket']);
  // Without extras no basket key travels at all.
  const q=await launchPage({route:launchServer().route});t.after(()=>q.controller.destroy());await q.connect();await q.meteora();await q.fill();q.option('holders');await flush();await q.open();
  const plainServer=s;await until(()=>plainServer.prepares.length>=1,'prepared');
  // A host that does not offer baskets (older server, or no route builder) never shows the step.
  const off=await launchPage({route:launchServer({basketsEnabled:false}).route});t.after(()=>off.controller.destroy());await off.meteora();off.option('holders');await flush();await flush();
  assert.equal(off.$('launch-basket').hidden,true);assert.equal(off.$('launch-card-basket-row').hidden,true);
  // Pure checks.
  assert.equal(basketUiModule.basketProblem([TSLA],{quoteMint:SOL_MINT,assets:pairs}),'');
  assert.equal(basketUiModule.basketProblem([PENDING],{quoteMint:SOL_MINT,assets:pairs}),'PENDx in your basket is not available for Meteora launches right now. Remove it or choose another.');
  assert.equal(basketUiModule.basketProblem([SOL_MINT],{quoteMint:SOL_MINT,assets:pairs}),'Your pair asset is already in the basket; add a different asset.');
  assert.equal(basketUiModule.basketProblem([TSLA,NVDA,USDC_MINT],{quoteMint:SOL_MINT,assets:pairs}),'A reward basket holds at most 3 assets: your pair asset plus 2 more.');
  assert.equal(basketUiModule.basketProblem([TSLA],{quoteMint:SOL_MINT,assets:pairs,enabled:false}),'Reward baskets are for Meteora launches with holder rewards. Choose Holders on Meteora, or remove the basket.');
  assert.equal(basketUiModule.basketProblem([],{quoteMint:SOL_MINT,assets:pairs,enabled:false}),'');
  assert.equal(BASKET_LIMITS.maxExtras,2);assert.equal(basketLaunchRequest(undefined),null);assert.equal(basketLaunchRequest([]),null);assert.throws(()=>basketLaunchRequest(['not a mint']),/mint address/);assert.throws(()=>basketLaunchRequest({extras:[TSLA,TSLA]}),/each asset once/);
});

test('the coin page rewards card of a basket coin names every asset, shows each extra asset’s distributed and collecting amounts, the round in progress and the last round, and reads a round with a skipped conversion',async()=>{
  const {document}=parseHTML('<!doctype html><html><body><section id="rewards"></section></body></html>');
  const root=document.getElementById('rewards'),view=createCoinRewardsView({document,root});
  const coin={mint:MINT,feeMode:'holders',platform:'meteora',symbol:'EXAMPLE',quote:{mint:SOL_MINT,symbol:'SOL'},taxBps:0};
  const basket={version:1,shares:'equal',count:3,assets:[{mint:SOL_MINT,symbol:'SOL',decimals:9},{mint:TSLA,symbol:'TSLAx',decimals:8},{mint:USDC_MINT,symbol:'USDC',decimals:6}],description:'SOL, TSLAx and USDC'};
  const data={mint:MINT,mode:'holders',quote:{mint:SOL_MINT,symbol:'SOL'},enabled:true,status:'ready',taxBps:0,asOf:1_790_000_000_000,basket,holder:{distributedQuote:'1.5',pendingQuote:'0.2',payments:12,unclaimedCreatorQuote:null,unclaimedScope:'curve_and_pool',intervalMinutes:60,historyComplete:true,lastDistributionAt:1_789_999_000_000,stage:'convert',basket:[{mint:SOL_MINT,symbol:'SOL',decimals:9,pending:'0.2',distributed:'1.5'},{mint:TSLA,symbol:'TSLAx',decimals:8,pending:'0.01',distributed:'0.4',convertedRaw:'40000000',payments:8},{mint:USDC_MINT,symbol:'USDC',decimals:6,pending:'0',distributed:'120',convertedRaw:'120000000',payments:8}],rounds:[{id:'r1',at:1_789_999_000_000,assets:[{mint:SOL_MINT,symbol:'SOL',decimals:9,amountRaw:'500000000',amount:'0.5',recipients:4},{mint:TSLA,symbol:'TSLAx',decimals:8,amountRaw:'20000000',amount:'0.2',recipients:4}],skipped:[{mint:USDC_MINT,note:'No conversion route is available right now.'}]}]}};
  view.render({coin,data,now:1_790_000_000_000});
  assert.equal(root.hidden,false);assert.equal(text(root.querySelector('.coin-rewards-description')),'The creator share of Meteora trading fees funds holder rewards. Rewards are paid in SOL, TSLAx and USDC (equal shares; the extra shares are converted at market each round), weighted by eligible token balances.');
  const metrics=Object.fromEntries([...root.querySelectorAll('[data-reward-metric]')].map(node=>[node.dataset.rewardMetric,text(node)]));
  assert.match(metrics.distributed,/Distributed1\.5SOL/);assert.match(metrics['basket-tslax'],/0\.4TSLAxDistributed in TSLAx/);assert.match(metrics['basket-pending-tslax'],/0\.01TSLAxCollecting in TSLAx/);assert.match(metrics['basket-usdc'],/120USDCDistributed in USDC/);assert.equal(metrics['basket-stage'],'ConvertingCurrent round');
  assert.match(text(root.querySelector('.coin-rewards-latest')),/^Last round · 0\.5 SOL · 0\.2 TSLAx to 4 holders · .+ · USDC paid in SOL \(no conversion route\)$/);
  // A plain holder coin reads as before.
  view.render({coin,data:{...data,basket:null,holder:{...data.holder,basket:undefined,rounds:undefined,stage:null}},now:1_790_000_000_000});
  assert.equal(text(root.querySelector('.coin-rewards-description')),'The creator share of Meteora trading fees funds holder rewards. Rewards are paid in SOL, weighted by eligible token balances.');
  assert.equal(root.querySelector('[data-reward-metric="basket-tslax"]'),null);assert.match(text(root.querySelector('.coin-rewards-latest')),/^Last distributed/);
  assert.equal(basketUiModule.basketRewardSentence({assets:[{symbol:'SOL'}]}),'');
});

// ---- Docs and terms ---------------------------------------------------------------------------------------------
test('the docs describe reward baskets (Meteora, holders only, up to 3 assets, equal shares, Jupiter conversion with the 1% / 2% guard, the pair-asset fallback, no change after launch), the Pump.fun version (v71.35), and the terms carry the clause',async()=>{
  const {document}=parseHTML(await readFile(new URL('../public/docs.html',import.meta.url),'utf8'));
  const heading=document.getElementById('baskets');assert(heading,'a #baskets heading');assert.equal(heading.tagName,'H3');assert.equal(text(heading),'Reward baskets');
  let node=heading,copy='';for(let i=0;i<3;i++){node=node.nextElementSibling;assert.equal(node?.tagName,'P');copy+=' '+text(node);}assert.equal(document.querySelector('.documentation-jump a[href="#baskets"]')?.textContent,'Reward baskets');
  for(const phrase of ['holder rewards','three assets','equal','Jupiter','1% slippage','2% price impact','pair asset','three attempts','cannot change','x7'])assert.match(copy,new RegExp(escapeRegExp(phrase),'i'),phrase);
  assert.doesNotMatch(copy,/guaranteed return|will (rise|pump|moon)/i,'no promised outcomes');
  // The Pump.fun version (v71.35): a fourth paragraph, Holders only, bought from the rewards wallet, the minimum share, the payout order, no basket for the other options.
  const pump=heading.nextElementSibling.nextElementSibling.nextElementSibling.nextElementSibling;assert.equal(pump?.tagName,'P');const pumpCopy=text(pump);assert.match(pumpCopy,/^Pump\.fun baskets \(v71\.35\)\./);
  for(const phrase of ['Holders','up to two extra assets','rewards wallet','split equally','1% slippage','2% price impact','three attempts','0.005 SOL','top 100 holders','extra assets first and the pair asset last','Diamond Hands, Earned and Insured do not take a basket'])assert.match(pumpCopy,new RegExp(escapeRegExp(phrase)),phrase);
  assert.doesNotMatch(pumpCopy,/guaranteed return|will (rise|pump|moon)/i);
  const terms=parseHTML(await readFile(new URL('../public/terms.html',import.meta.url),'utf8')).document,clause=[...terms.querySelectorAll('p')].find(p=>/^Reward baskets\./.test(text(p)));
  assert(clause,'the terms carry a reward basket clause');const words=text(clause);
  for(const phrase of ['Meteora','Pump.fun launch with the Holders option','holder rewards','converted','market','route','pair asset','below the published minimum','no guarantee'])assert.match(words,new RegExp(escapeRegExp(phrase),'i'),phrase);
  assert.equal(clause.querySelector('a[href="/docs#baskets"]')!==null,true);
});

test('Pump.fun (v71.35): the same basket step shows for Holders, offers the verified catalogue, travels as the extra mints in the quote and is refused for other options', async t => {
  const s = launchServer(), p = await launchPage({ route: s.route }); t.after(() => p.controller.destroy()); const b = basketOf(p);
  await p.connect(); await p.pumpClassic(); await until(() => p.calls.some(x => x.path === '/api/launchpad/pump-classic/status'), 'the Pump.fun status was not read');
  await p.fill(); p.option('creator'); await flush(); await flush();
  assert.equal(b.root().hidden, true, 'Pump.fun + Creator: no basket');
  p.option('holders'); await flush(); await flush();
  await until(() => p.calls.some(x => x.path === '/api/launchpad/quotes'), 'the verified catalogue was not read for the basket');
  await flush(); await flush();
  assert.equal(b.root().hidden, false, 'Pump.fun + Holders: the step shows'); assert.deepEqual(b.chips(), [['SOL', true]]);
  assert.match(b.status(), /^No extra assets yet\. Holders are paid in SOL only\.$/);
  await b.add('TSLAx'); await b.add('NVDAx'); assert.equal(b.extras(), TSLA + ',' + NVDA);
  assert.deepEqual(b.chips(), [['SOL', true], ['TSLAx', false], ['NVDAx', false]]); assert.equal(b.error().hidden, true);
  assert.equal(p.$('launch-card-basket-row').hidden, false); assert.equal(text(p.$('launch-card-basket')), 'SOL + TSLAx + NVDAx · equal shares');
  await p.open(); assert.equal(p.$('launch-pump-classic-dialog').open, true, 'the Pump.fun launch dialog opens');
  const review = [...p.$('launch-pump-classic-operation').querySelectorAll('button')].find(b => b.textContent === 'Review launch'); assert(review, 'the review button');
  await review.onclick(); await until(() => s.prepares.length === 1, 'the launch was not quoted');
  const body = s.prepares[0]; assert.equal(body.mode, 'holders'); assert.deepEqual(body.basket, [TSLA, NVDA]); assert.equal(body.quoteMint, undefined, 'a SOL coin');
  p.$('launch-pump-classic-close').onclick(); await flush();
  // Another option with a basket still chosen: the step stays visible to remove it and the launch is blocked in words.
  p.option('creator'); await flush(); await flush();
  assert.equal(b.root().hidden, false); assert.equal(b.status(), 'The basket applies to Pump.fun launches with holder rewards only.');
  assert.match(text(b.error()), /^Reward baskets are for Pump\.fun launches with holder rewards\. Choose Holders on Pump\.fun, or remove the basket\.$/); assert.equal(p.$('launch-open').disabled, true);
  await b.remove('TSLAx'); await b.remove('NVDAx'); await flush(); assert.equal(b.root().hidden, true); assert.equal(p.$('launch-open').disabled, false);
  // A host whose Pump.fun service predates baskets never shows the step there.
  const off = await launchPage({ route: launchServer({ basketsEnabled: false }).route }); t.after(() => off.controller.destroy()); await off.pumpClassic(); off.option('holders'); await flush(); await flush();
  assert.equal(off.$('launch-basket').hidden, true);
  assert.equal(basketUiModule.basketProblem([PENDING], { quoteMint: SOL_MINT, assets: pairs, venue: 'Pump.fun' }), 'PENDx in your basket is not available for Pump.fun launches right now. Remove it or choose another.');
});
