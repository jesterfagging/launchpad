// Pump.fun on the launch page: the venue replaces Meteora → PumpSwap, offers six
// launch options (Market Maker and Liquidity Manager only here), keeps fee
// percentages out of the launch flow and funds a launch with exactly one
// wallet-signed transfer that is checked against the reviewed total.
import {optimizeLaunchImage} from '../public/launch-image.mjs';
import {createChainSelect,initialLaunchChain,launchChainById} from '../public/launch-chains.mjs';
import * as meteoraUiModule from '../public/meteora-ui.mjs';
import * as dammPumpUiModule from '../public/damm-pump-ui.mjs';
import * as pumpPublicUiModule from '../public/pump-public-ui.mjs';
import * as pumpUiModule from '../public/pump-launch-test-ui.mjs';
import * as pumpClassicUi from '../public/pump-classic-ui.mjs';
import {PUMP_CLASSIC_MODES,PUMP_CLASSIC_STRATEGY_MODES,PUMP_CLASSIC_MODE_LABELS,PUMP_CLASSIC_MODE_SUMMARIES,PUMP_CLASSIC_LIMITS,PUMP_CLASSIC_FEE_LINK,PUMP_CLASSIC_SOL_ONLY_MODES,PUMP_CLASSIC_CONVERT_MODES,PUMP_CLASSIC_OPTION_MODES,pumpClassicDisclosure} from '../public/pump-classic-catalog.mjs';
import {PUMP_OPTIONS,pumpOptionRequest,describePumpOption} from '../public/pump-option-catalog.mjs';
import {HOOK_GROUPS,HOOK_RULES,HOOK_MAX_RULES,HOOK_LIMITS,HOOK_NOT_OFFERED,HOOK_ROUTES,HOOK_TIMEZONES,WEEKDAYS,hookRuleById,hookRulesConflict,hookSettingApplies,hookLaunchRequest,describeHookRule,hookAppUnavailableText} from '../public/hook-catalog.mjs';
import {AGENT_PERSONALITIES,AGENT_FUNDING_SUMMARY,AGENT_LIMITS,AGENT_OBJECTIVES,AGENT_OBJECTIVE_GROUPS,objectiveById,normalizeObjectiveSettings} from '../public/agent-catalog.mjs';
import {GOTCHI_THEMES,gotchiFundingSummary,gotchiTheme} from '../public/gotchi-catalog.mjs';
import {createQuoteIcon,createQuoteLabel} from '../public/quote-logos.mjs';
import {CREATOR_FEE_TIERS,creatorFeeForLaunch} from '../public/creator-fee-schedule.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {parseHTML} from 'linkedom';
import {createLaunchpadWallet} from '../public/launchpad-wallet.mjs';
import {launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink,agentLaunchRequest} from '../public/launchpad-model.mjs';
import {LAUNCH_ASSETS} from '../public/launch-assets.mjs';
const ADDRESS='So11111111111111111111111111111111111111112',OTHER='11111111111111111111111111111111';
const MINT='PumpMint11111111111111111111111111111111111',LAUNCH_WALLET='LaunchWa11et1111111111111111111111111111111',LAUNCH_ID='ab'.repeat(12),FUNDING_SIG='5'.repeat(88),CREATE_SIG='6'.repeat(88);
const SIGN='solana:signTransaction',CHAIN='solana:mainnet';
const flush=()=>new Promise(resolve=>setTimeout(resolve,10));
const until=async(check,message)=>{for(let i=0;i<200;i++){if(check())return;await flush();}assert.fail(message);};
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
function view(over={}){
  const mode=over.mode||'market_maker';
  return{id:LAUNCH_ID,state:'awaiting_funding',stateLabel:'Waiting for funding',reason:'',mode,modeLabel:PUMP_CLASSIC_MODE_LABELS[mode],venueLabel:'Pump.fun',name:'Example',symbol:'EXAMPLE',image:'/token-images/'+'a'.repeat(64)+'.webp',mint:MINT,pumpUrl:'https://pump.fun/coin/'+MINT,coinUrl:'/coin?mint='+MINT,
    dimensions:{launch:'awaiting_funding',delivery:'pending',fees:'pending',venue:'curve',refund:'none'},signatures:{funding:null,create:null,refund:null},devTokens:'0',refundedSol:'0',createdAt:1,liveAt:null,disclosure:pumpClassicDisclosure(mode),feeLink:'/docs#revenue',
    developerWallet:ADDRESS,launchWallet:LAUNCH_WALLET,quote:{devBuySol:'0.5',expectedTokens:'17000000000000',setupBudgetSol:'0.05',operatingReserveSol:'0.025',seedSol:'1',totalSol:'1.575',totalLamports:'1575000000',expiresAt:Date.now()+600000},memo:'pump-launch:'+LAUNCH_ID,canCancel:true,canFund:true,...over};
}
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',XSTOCK='XsExamp1eStock111111111111111111111111111111',ODD='DdAsset1111111111111111111111111111111111111',HOOK='HookPair11111111111111111111111111111111111';
const PAIRS=[
  {mint:ADDRESS,symbol:'SOL',name:'Solana',issuer:'Native',category:'crypto',decimals:9,kind:'sol',launchReady:true,convertible:true,supportReason:'',maxDevBuy:'25',creatorFee:null,pumpClassic:true},
  {mint:USDC,symbol:'USDC',name:'USD Coin',issuer:'Circle',category:'crypto',decimals:6,kind:'listed',launchReady:true,convertible:true,supportReason:'',maxDevBuy:'3750',creatorFee:null,pumpClassic:true},
  {mint:XSTOCK,symbol:'EXMx',name:'Example xStock',issuer:'',category:'custom',decimals:8,kind:'custom',launchReady:true,convertible:true,supportReason:'',maxDevBuy:'1000',creatorFee:{maxBps:500},pumpClassic:true},
  {mint:ODD,symbol:'ODD',name:'Odd Asset',issuer:'',category:'custom',decimals:8,kind:'custom',launchReady:true,convertible:false,supportReason:'',maxDevBuy:'750',creatorFee:{maxBps:500},pumpClassic:true},
  {mint:HOOK,symbol:'HOOK',name:'Hooked',issuer:'',category:'custom',decimals:6,kind:'custom',launchReady:false,convertible:false,supportReason:'This pair’s token runs a transfer hook program.',maxDevBuy:'0',creatorFee:{maxBps:500},pumpClassic:true},
];
function server({intakeOpen=true,saved=[],prepared={},pairs=null}={}){
  const state={launch:null,saved,quotes:[],submits:[],cancels:[],pairs};
  state.route=async(path,body)=>{
    if(path==='/api/session')return{authenticated:true,token:'public-csrf',features:{walletOnly:true},account:{id:'public-user',authType:'wallet',mainWallet:ADDRESS}};
    if(path==='/api/launchpad/agents/catalog')return{intakeOpen:true,models:[{id:'openai/gpt-6-luna',name:'Luna'}],defaultModel:'openai/gpt-6-luna',domainAllowlist:[]};
    if(!path.startsWith('/api/launchpad/pump-classic/'))return undefined;
    const action=path.slice('/api/launchpad/pump-classic/'.length);
    if(action==='status')return{available:true,venue:'pump-classic',intakeOpen,reason:intakeOpen?'':'Pump.fun launches are paused right now. The platform owner can reopen them.'};
    if(action==='launches')return{launches:state.launch?[state.launch]:state.saved};
    if(action==='pairs')return state.pairs?{available:true,pairs:state.pairs,solOnlyModes:['agent','market_maker','lp_manager'],convertModes:['holders','gotchi'],stale:false}:{ok:false,status:404,body:{error:'Not found.'}};
    if(action==='quote'){state.quotes.push(body);const pair=PAIRS.find(x=>x.mint===(body.quoteMint||ADDRESS)),listed=(state.pairs||[]).find(x=>x.mint===body.quoteMint);
      // From v71.22 the server lists pairs with devBuyIn 'SOL': the dev buy is entered and funded in SOL and Launchpad buys the pair asset.
      if(listed?.devBuyIn==='SOL'){const none=body.devBuySol==='0';state.launch=view({mode:body.mode,pair:{mint:pair.mint,symbol:pair.symbol,decimals:pair.decimals,kind:pair.kind},creatorFeeBps:body.creatorFeeBps||0,disclosure:pumpClassicDisclosure(body.mode,{pair:pair.symbol,devBuyInSol:true}),
        quote:{...view().quote,devBuySol:body.devBuySol,devBuyPaidIn:'SOL',devBuy:none?'0':'73.5075',devBuyRaw:none?'0':'73507500',devBuySymbol:pair.symbol,pairAmount:'0',pairAmountRaw:'0',pairExpected:none?null:'75',pairMinimum:none?null:'73.5075',pairBought:null,expectedTokens:none?'0':'17000000000000',minimumTokens:none?'0':'16600000000000',seedSol:'0',setupBudgetSol:'0.035',estimatedSetupSol:'0.024',conversionBudgetSol:none?null:'0.005',operatingReserveSol:'0.007',totalSol:none?'0.042':'0.547',totalLamports:none?'42000000':'547000000'}});return state.launch;}
      state.launch=body.quoteMint?view({mode:body.mode,pair:{mint:pair.mint,symbol:pair.symbol,decimals:pair.decimals,kind:pair.kind},creatorFeeBps:body.creatorFeeBps||0,quote:{...view().quote,devBuySol:'0',devBuy:body.devBuyAmount,devBuyRaw:body.devBuyAmount==='0'?'0':'25000000',devBuySymbol:pair.symbol,pairAmount:body.devBuyAmount,pairAmountRaw:body.devBuyAmount==='0'?'0':'25000000',seedSol:'0',setupBudgetSol:'0.06',operatingReserveSol:'0.012',totalSol:'0.072',totalLamports:'72000000'}}):view({mode:body.mode,quote:{...view().quote,devBuySol:body.devBuySol,seedSol:body.seedSol}});return state.launch;}
    if(action==='fund/prepare'){const q=state.launch.quote,pair=state.launch.pair;return{operationId:'op-1',transaction:'AQID',messageHash:'f'.repeat(64),amountLamports:q.totalLamports,amountSol:q.totalSol,memo:'pump-launch:'+LAUNCH_ID,wallet:ADDRESS,...(pair?{pairAmountRaw:q.pairAmountRaw,pairAmount:q.pairAmount,pairSymbol:pair.symbol,pairMint:pair.mint}:{}),launch:state.launch,...prepared};}
    if(action==='fund/submit'){state.submits.push(body);state.launch={...state.launch,state:'funding_pending',stateLabel:'Confirming funding',canFund:false,signatures:{funding:FUNDING_SIG,create:null,refund:null}};return state.launch;}
    // A submitted launch finalizes on the next status read; a saved one once the test releases it.
    // Saved launches other than the default one are returned as saved, by their id.
    if(action.startsWith('launch?')){const id=new URLSearchParams(action.slice('launch?'.length)).get('launchId'),other=state.saved.find(l=>l.id===id&&l.id!==LAUNCH_ID);if(other)return other;const current=state.launch||state.saved[0];if(current?.state==='funding_pending'&&(state.launch||state.release))state.launch={...current,state:'created',stateLabel:'Live on Pump.fun',devTokens:'17000000000000',liveAt:2,signatures:{funding:FUNDING_SIG,create:CREATE_SIG,refund:null}};return state.launch||current;}
    if(action==='cancel'){state.cancels.push(body);const other=state.saved.find(l=>l.id===body.launchId&&l.id!==LAUNCH_ID);if(other)return Object.assign(other,{state:'cancelled',stateLabel:'Cancelled',canFund:false});state.launch={...state.launch,state:'cancelled',stateLabel:'Cancelled',canFund:false};return state.launch;}
    return{ok:false,status:404,body:{error:'Not found.'}};
  };
  return state;
}
async function page({route,mock=mockWallet(),href='http://app.local/launchpad'}={}){
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
  const calls=[],intervals=new Map();
  const fetch=async(path,options={})=>{const body=options.body?JSON.parse(options.body):undefined;calls.push({path,body,method:options.method||'GET'});const data=await route?.(path,body);if(data)return{ok:data.ok!==false,status:data.status||200,json:async()=>data.body??data};return{ok:true,status:200,json:async()=>path.endsWith('/quotes')?{assets:LAUNCH_ASSETS.map(a=>({...a,supported:true})),canViewComingSoon:false}:path.endsWith('/image')?{imageId:'a'.repeat(64)+'.webp'}:{launches:[]}};};
  window.addEventListener('wallet-standard:app-ready',event=>event.detail.register(mock.wallet));
  const source=(await readFile(new URL('../public/launchpad.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'').replace("await import('./pump-launch-test-ui.mjs')",'pumpUiModule').replace("await import('./pump-public-ui.mjs')",'pumpPublicUiModule').replace("await import('./meteora-ui.mjs')",'meteoraUiModule').replace("await import('./damm-pump-ui.mjs')",'dammPumpUiModule').replace("await import('./pump-classic-ui.mjs')",'pumpClassicUiModule').replace(/bootPage\('launchpad',mountPage\);/,'')+'\nconst pageController=mountPage({document,window:document.defaultView});await pageController.ready;return pageController;';
  // Status polls run on a short timer here; the 1 s quote countdown keeps its real cadence.
  const pumpClassicUiModule={...pumpClassicUi,createPumpClassicLaunch:options=>pumpClassicUi.createPumpClassicLaunch({...options,setTimer:(fn,ms)=>setTimeout(fn,ms===1000?ms:5),clearTimer:id=>clearTimeout(id)})};
  const deps={createChainSelect,initialLaunchChain,launchChainById,optimizeLaunchImage,meteoraUiModule,dammPumpUiModule,pumpUiModule,pumpPublicUiModule,pumpClassicUiModule,PUMP_CLASSIC_MODES,PUMP_CLASSIC_STRATEGY_MODES,PUMP_CLASSIC_MODE_LABELS,PUMP_CLASSIC_MODE_SUMMARIES,PUMP_CLASSIC_LIMITS,PUMP_CLASSIC_FEE_LINK,PUMP_CLASSIC_SOL_ONLY_MODES,PUMP_CLASSIC_CONVERT_MODES,PUMP_CLASSIC_OPTION_MODES,PUMP_OPTIONS,pumpOptionRequest,describePumpOption,AGENT_PERSONALITIES,AGENT_FUNDING_SUMMARY,AGENT_LIMITS,AGENT_OBJECTIVES,AGENT_OBJECTIVE_GROUPS,objectiveById,normalizeObjectiveSettings,GOTCHI_THEMES,gotchiFundingSummary,gotchiTheme,HOOK_GROUPS,HOOK_RULES,HOOK_MAX_RULES,HOOK_LIMITS,HOOK_NOT_OFFERED,HOOK_ROUTES,HOOK_TIMEZONES,WEEKDAYS,hookRuleById,hookRulesConflict,hookSettingApplies,hookLaunchRequest,describeHookRule,hookAppUnavailableText,createQuoteIcon,createQuoteLabel,CREATOR_FEE_TIERS,creatorFeeForLaunch,document,fetch,FileReader,createImageBitmap:async()=>({width:8,height:8,close(){}}),crypto:{randomUUID},FormData,requestAnimationFrame:fn=>{setTimeout(fn,0);return 1;},setInterval:(fn,ms)=>{intervals.set(ms,fn);return ms;},clearInterval:()=>{},setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,10)),matchMedia:()=>({matches:true}),createWorkspaceShell:()=>{},launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink,LAUNCH_ASSETS,createLaunchpadWallet};
  const controller=await new (Object.getPrototypeOf(async()=>{}).constructor)(...Object.keys(deps),source)(...Object.values(deps));await flush();
  const $=id=>document.getElementById(id);
  return{controller,document,window,form,$,calls,mock,intervals,
    venue:name=>document.querySelector('[data-launch-venue='+name+']'),
    async pump(){document.querySelector('[data-launch-venue=pump-classic]').onclick();await flush();await flush();},
    option(value){for(const radio of form.querySelectorAll('[name=feeMode]'))radio.checked=radio.value===value;form.dispatchEvent(new window.Event('change'));},
    labels:()=>[...form.querySelectorAll('.launch-rewards>label')].filter(label=>!label.hidden).map(label=>label.textContent),
    button:text=>[...$('launch-pump-classic-operation').querySelectorAll('button')].find(b=>b.textContent===text),
    async image(){Object.defineProperty($('launch-image'),'files',{value:[{type:'image/png',size:30}],configurable:true});await $('launch-image').onchange();},
    async fill(){form.elements.namedItem('name').value='Example';form.elements.namedItem('symbol').value='EXAMPLE';await this.image();},
    async open(){$('launch-open').onclick();await flush();await flush();},
    async connect(){$('launch-connect').onclick();document.querySelector('#launch-wallet-options button').onclick();await flush();}};
}

test('Pump.fun offers nine launch options; the five Pump.fun-only ones exist only there',async t=>{
  const s=server(),p=await page({route:s.route});t.after(()=>p.controller.destroy());
  assert.equal(p.venue('pump-classic').textContent,'Pump.fun');assert.equal(p.venue('damm-pump'),null);
  assert.deepEqual(p.labels(),['Creator','Holders','Gotchi','AI Agent']);
  await p.pump();
  assert.deepEqual(p.labels(),['Creator','Holders','Gotchi','AI Agent','Market Maker','Liquidity Manager','Diamond Hands','Earned','Insured']);
  assert.equal(p.$('launch-reward-segments').dataset.count,'9');assert.equal(p.$('launch-rewards-legend').textContent,'Choose a launch option');
  assert.equal(p.document.querySelector('.launch-venue').textContent,'Launch on Pump.fun');assert.equal(p.$('launch-open').textContent,'Launch on Pump.fun →');assert.equal(p.$('launch-open').disabled,false);
  // Without Pump.fun's live pair list (unreachable here) only SOL is offered; no Launchpad market cap, transfer tax or Launchpad fee schedule.
  for(const pair of ['USDC','custom'])assert.equal(p.document.querySelector('[data-pair='+pair+']').hidden,true);
  assert.equal(p.document.querySelector('[data-pair=SOL]').hidden,false);assert.equal(p.$('launch-card-pair').dataset.mint,SOL_MINT);
  for(const id of ['launch-fixed-fdv','launch-fdv-note','launch-tax-label','launch-fee-settings','launch-holder-minimum-wrap'])assert.equal(p.$(id).hidden,true,id);
  p.option('market_maker');
  assert.equal(p.$('launch-card-mode').textContent,'Market Maker');assert.equal(p.$('launch-card-mode').previousElementSibling.textContent,'Launch option');
  assert.match(p.$('launch-fee-note').textContent,/own wallet/);assert.match(p.$('launch-fee-note').textContent,/platform share/);assert.equal(p.$('launch-fee-note').querySelector('a').getAttribute('href'),'/docs#revenue');
  // Fee shares are stated only in the docs.
  for(const id of ['launch-fee-note','launch-pump-classic-availability','launch-pump-classic-disclosure','launch-pump-classic-terms','launch-curve-summary','launch-pump-classic-option'])assert.doesNotMatch(p.$(id).textContent,/\d\s*%/,id);
  // Leaving Pump.fun falls back to Creator and hides the Pump.fun-only options again.
  p.venue('raydium').onclick();await flush();
  assert.equal(p.form.querySelector('[name=feeMode]:checked').value,'creator');assert.deepEqual(p.labels(),['Creator','Holders','Gotchi','AI Agent']);
  assert(['market_maker','lp_manager'].every(value=>p.form.querySelector('[name=feeMode][value='+value+']').disabled));
  p.venue('meteora').onclick();await flush();assert.deepEqual(p.labels(),['Creator','Holders','Gotchi','AI Agent']);
});

test('a Pump.fun launch is quoted, funded by one wallet-signed transfer and followed until live',async t=>{
  const s=server(),p=await page({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.pump();await p.fill();p.option('market_maker');
  await p.open();assert.equal(p.$('launch-pump-classic-dialog').open,true);
  assert.equal(p.$('launch-pump-classic-seed-wrap').hidden,false,'strategies can be seeded');assert.match(p.$('launch-pump-classic-option').textContent,/^Market Maker · /);
  p.$('launch-pump-classic-buy').value='0.5';p.$('launch-pump-classic-seed').value='1';
  await p.button('Review launch').onclick();
  assert.equal(s.quotes.length,1);const quote=s.quotes[0];
  assert.equal(quote.mode,'market_maker');assert.equal(quote.devBuySol,'0.5');assert.equal(quote.seedSol,'1');assert.equal(quote.wallet,ADDRESS);assert.equal(quote.image,'/token-images/'+'a'.repeat(64)+'.webp');assert.equal(quote.name,'Example');assert.equal(quote.symbol,'EXAMPLE');assert.match(quote.requestKey,/^[a-f0-9]{32}$/);assert.equal(quote.agent,undefined);
  const text=()=>p.$('launch-pump-classic-operation').textContent;
  assert.match(text(),/Total from your wallet1\.575 SOL/);assert.match(text(),/Strategy seed capital1 SOL/);assert.match(text(),/separate from the wallet that creates the coin/);assert.doesNotMatch(text(),/\d\s*%/);
  assert.equal(p.$('launch-pump-classic-inputs').hidden,true,'the quote fixes the inputs');assert.equal(p.mock.calls.sign.length,0);
  await p.button('Fund and launch').onclick();
  assert.equal(p.mock.calls.sign.length,1);assert.equal(s.submits.length,1);assert.deepEqual(s.submits[0],{launchId:LAUNCH_ID,operationId:'op-1',signedTransaction:'BAUG'});
  await until(()=>s.launch.state==='created'&&/Your coin is live on Pump\.fun/.test(text()),'the launch did not reach live');
  const coin=[...p.$('launch-pump-classic-operation').querySelectorAll('a')].find(a=>a.textContent==='Open coin →');assert(coin&&!coin.hidden);assert.equal(coin.getAttribute('href'),'/coin?mint='+MINT);
  assert.equal(p.$('launch-pump-classic-title').textContent,'Your coin is live');assert.equal(p.$('launch-toast').hidden,false);assert.equal(p.mock.calls.sign.length,1,'nothing else needs a signature');
  assert(!p.calls.some(x=>/\/api\/launchpad\/(prepare|create|action)/.test(x.path)),'the Raydium launch flow is not used');
});

test('closed intake, an unfunded close and a mismatched transfer never reach the wallet',async t=>{
  const closed=server({intakeOpen:false}),a=await page({route:closed.route});t.after(()=>a.controller.destroy());
  await a.connect();await a.pump();await a.fill();
  assert.equal(a.$('launch-open').disabled,true);assert.equal(a.$('launch-open').textContent,'Pump.fun unavailable');assert.match(a.$('launch-pump-classic-availability').textContent,/paused/);
  await a.open();assert.equal(closed.quotes.length,0);assert.match(a.$('launch-pump-classic-note').textContent,/paused/);
  // Closing an unfunded quote cancels it.
  const open=server(),b=await page({route:open.route});t.after(()=>b.controller.destroy());
  await b.connect();await b.pump();await b.fill();await b.open();await b.button('Review launch').onclick();assert.equal(open.quotes.length,1);
  await b.$('launch-pump-classic-close').onclick();await flush();
  assert.deepEqual(open.cancels,[{launchId:LAUNCH_ID}]);assert.equal(b.$('launch-pump-classic-dialog').open,false);
  open.launch=null;await b.open();assert.equal(b.$('launch-pump-classic-inputs').hidden,false,'a fresh launch starts from the inputs');
  // A prepared transfer must match the reviewed total before the wallet is asked.
  const wrong=server({prepared:{amountLamports:'9999999999',amountSol:'9.999999999'}}),c=await page({route:wrong.route});t.after(()=>c.controller.destroy());
  await c.connect();await c.pump();await c.fill();await c.open();await c.button('Review launch').onclick();await c.button('Fund and launch').onclick();
  assert.equal(c.mock.calls.sign.length,0);assert.equal(wrong.submits.length,0);assert.match(c.$('launch-pump-classic-operation').textContent,/does not match the reviewed total/);
  for(const p of [a,b,c])assert.equal(p.mock.calls.sign.length,0);
});

test('a funded launch is listed and resumed after a reload without a new quote',async t=>{
  const saved=view({state:'funding_pending',stateLabel:'Confirming funding',canFund:false,signatures:{funding:FUNDING_SIG,create:null,refund:null}});
  const s=server({saved:[saved]}),p=await page({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await flush();
  const row=[...p.$('launch-list').querySelectorAll('.launch-history-row')].find(r=>/EXAMPLE/.test(r.textContent));assert(row);assert.match(row.textContent,/Pump\.fun · Confirming funding/);
  row.onclick();await flush();await flush();
  assert.equal(p.$('launch-pump-classic-dialog').open,true);assert.match(p.$('launch-pump-classic-operation').textContent,/Funding transaction ↗/);
  assert.equal(s.quotes.length,0);assert.equal(p.mock.calls.sign.length,0);
  s.release=true;await until(()=>/Your coin is live on Pump\.fun/.test(p.$('launch-pump-classic-operation').textContent),'the restored launch did not finish');
});

test('AI Agent and Gotchi settings travel with a Pump.fun quote; Pump.fun agents use the Pump.fun fee summary',async t=>{
  const s=server(),p=await page({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.pump();await p.fill();p.option('agent');await flush();await flush();
  assert.equal(p.$('launch-agent-settings').hidden,false);assert.match(p.$('launch-agent-fee-source').textContent,/^Pump\.fun agent launches/);
  p.form.elements.namedItem('agentMission').value='Track the market.';
  await p.open();assert.equal(p.$('launch-pump-classic-seed-wrap').hidden,true,'seed capital is only for the strategies');await p.button('Review launch').onclick();
  assert.equal(s.quotes[0].mode,'agent');assert.equal(s.quotes[0].agent.venue,'pump');assert.equal(s.quotes[0].agent.mission,'Track the market.');assert.equal(s.quotes[0].seedSol,'0');
  await p.$('launch-pump-classic-close').onclick();await flush();s.launch=null;
  p.option('gotchi');await p.open();await p.button('Review launch').onclick();assert.equal(s.quotes.length,1,'a Gotchi must be chosen first');assert.match(p.$('launch-pump-classic-operation').textContent,/Choose a Gotchi/);
});

test('Pump.fun pairs: the live list, the dev buy in the pair, SOL-only options and the creator fee on custom pairs',async t=>{
  const s=server({pairs:PAIRS}),p=await page({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.pump();await p.fill();
  await until(()=>p.calls.some(x=>x.path==='/api/launchpad/pump-classic/pairs')&&!p.document.querySelector('[data-pair=USDC]').hidden,'the pair list did not load');
  assert.equal(p.document.querySelector('[data-pair=custom]').hidden,false,'custom pairs are offered');
  assert.match(p.$('launch-catalogue-note').textContent,/Pairs Pump\.fun admits/);
  // The listed USDC pair: dev buy in USDC, launch costs in SOL.
  p.document.querySelector('[data-pair=USDC]').onclick();await flush();
  assert.equal(p.$('launch-card-pair').dataset.mint,USDC);assert.match(p.$('launch-pair-note').textContent,/against USDC on Pump\.fun\. Your dev buy is paid in USDC/);
  p.option('agent');await flush();
  assert.equal(p.$('launch-open').disabled,true,'AI Agent pairs with SOL only');assert.match(p.$('launch-fee-note').textContent,/AI Agent pairs with SOL only on Pump\.fun\. Choose SOL as the pair, or Creator, Holders, Diamond Hands or Gotchi for USDC\./);
  assert.match(p.$('launch-ready-text').textContent,/Next, choose SOL as the pair \(AI Agent pairs with SOL only on Pump\.fun\) or Creator, Holders, Diamond Hands or Gotchi for USDC/,'the step rail names the way out');
  p.option('market_maker');assert.equal(p.$('launch-open').disabled,true);assert.match(p.$('launch-fee-note').textContent,/Market Maker pairs with SOL only/);assert.match(p.$('launch-ready-text').textContent,/Market Maker pairs with SOL only/);
  p.option('creator');assert.equal(p.$('launch-open').disabled,false);assert.match(p.$('launch-fee-note').textContent,/Your share is paid in USDC/);
  await p.open();
  assert.equal(p.$('launch-pump-classic-buy-unit').textContent,'USDC');assert.match(p.$('launch-pump-classic-option').textContent,/paired with USDC/);assert.equal(p.$('launch-pump-classic-fee-wrap').hidden,true,'a listed pair keeps Pump.fun’s standard creator fee');
  p.$('launch-pump-classic-buy').value='3750.000001';await p.button('Review launch').onclick();assert.equal(s.quotes.length,0);assert.match(p.$('launch-pump-classic-operation').textContent,/at most 3750 USDC/);
  p.$('launch-pump-classic-buy').value='25';await p.button('Review launch').onclick();
  assert.equal(s.quotes.length,1);const quote=s.quotes[0];
  assert.deepEqual([quote.quoteMint,quote.devBuyAmount,quote.devBuySol,quote.creatorFeeBps,quote.seedSol],[USDC,'25',undefined,undefined,'0']);
  const text=()=>p.$('launch-pump-classic-operation').textContent;
  assert.match(text(),/PairUSDC/);assert.match(text(),/Dev buy \(maximum\)25 USDC/);assert.match(text(),/Total from your wallet0\.072 SOL \+ 25 USDC/);
  await p.button('Fund and launch').onclick();
  assert.equal(p.mock.calls.sign.length,1,'one wallet approval covers the SOL and the USDC');assert.equal(s.submits.length,1);
  // A prepared transfer with a different pair amount never reaches the wallet.
  const wrong=server({pairs:PAIRS,prepared:{pairAmountRaw:'1'}}),w=await page({route:wrong.route});t.after(()=>w.controller.destroy());
  await w.connect();await w.pump();await w.fill();await until(()=>!w.document.querySelector('[data-pair=USDC]').hidden,'no pairs');
  w.document.querySelector('[data-pair=USDC]').onclick();await flush();await w.open();w.$('launch-pump-classic-buy').value='25';await w.button('Review launch').onclick();await w.button('Fund and launch').onclick();
  assert.equal(w.mock.calls.sign.length,0);assert.match(w.$('launch-pump-classic-operation').textContent,/does not match the reviewed total/);
});

test('Pump.fun pairs paid only in SOL: the dev buy is entered in SOL, Launchpad buys the pair asset and the review shows the minimums',async t=>{
  const SOL_PAID=PAIRS.map(x=>x.kind==='sol'?x:{...x,devBuyIn:'SOL',maxDevBuySol:'25',devBuyAvailable:x.convertible===true,devBuySlippageBps:200,devBuyDriftBps:500});
  const s=server({pairs:SOL_PAID}),p=await page({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.pump();await p.fill();
  await until(()=>!p.document.querySelector('[data-pair=USDC]').hidden,'the pair list did not load');
  p.document.querySelector('[data-pair=USDC]').onclick();await flush();
  assert.match(p.$('launch-pair-note').textContent,/against USDC on Pump\.fun\. You pay everything in SOL: for a dev buy, Launchpad buys USDC with your SOL/);
  assert.doesNotMatch(p.$('launch-pair-note').textContent,/paid in USDC from your wallet/);
  p.option('creator');await p.open();
  assert.equal(p.$('launch-pump-classic-buy-unit').textContent,'SOL','the dev buy is entered in SOL');assert.match(p.$('launch-pump-classic-buy-help').textContent,/you only need SOL/);assert.match(p.$('launch-pump-classic-buy-help').textContent,/at most 2% slippage/,'the pair row carries the policy slippage');
  p.$('launch-pump-classic-buy').value='25.1';await p.button('Review launch').onclick();assert.equal(s.quotes.length,0);assert.match(p.$('launch-pump-classic-operation').textContent,/at most 25 SOL/);
  p.$('launch-pump-classic-buy').value='0.5';await p.button('Review launch').onclick();
  assert.equal(s.quotes.length,1);const quote=s.quotes[0];
  assert.deepEqual([quote.quoteMint,quote.devBuySol,quote.devBuyAmount],[USDC,'0.5',undefined],'the quote asks for a SOL dev buy');
  const text=()=>p.$('launch-pump-classic-operation').textContent;
  assert.match(text(),/Dev buy0\.5 SOL/);assert.match(text(),/Converted toat least 73\.5075 USDC \(about 75\)/);assert.match(text(),/Tokens you receive~17,000,000 \(at least 16,600,000\)/);
  assert.match(text(),/Launch costsabout 0\.024 SOL \(up to 0\.035; the rest comes back after launch\)/);assert.match(text(),/Conversion costsup to 0\.005 SOL/);
  assert.match(text(),/Total from your wallet0\.547 SOL/);assert.doesNotMatch(text(),/\+ .*USDC/,'nothing but SOL leaves the wallet');
  assert.match(text(),/You fund everything in SOL/);
  await p.button('Fund and launch').onclick();
  assert.equal(p.mock.calls.sign.length,1,'one SOL transfer');assert.equal(s.submits.length,1);
  // A pair Launchpad cannot buy: the dev buy is unavailable, a launch without one still works.
  const q=server({pairs:SOL_PAID}),o=await page({route:q.route});t.after(()=>o.controller.destroy());
  await o.connect();await o.pump();await o.fill();await until(()=>!o.document.querySelector('[data-pair=custom]').hidden,'no pairs');
  o.$('launch-asset-open').onclick();await flush();[...o.$('launch-asset-results').querySelectorAll('button')].find(b=>b.dataset.mint===ODD).onclick();await flush();
  assert.match(o.$('launch-pair-note').textContent,/A dev buy is not available on ODD right now/);
  o.option('creator');await o.open();
  o.$('launch-pump-classic-buy').value='1';await o.button('Review launch').onclick();assert.equal(q.quotes.length,0);assert.match(o.$('launch-pump-classic-operation').textContent,/not available on ODD/);
  o.$('launch-pump-classic-buy').value='0';await o.button('Review launch').onclick();assert.equal(q.quotes.length,1);assert.deepEqual([q.quotes[0].quoteMint,q.quotes[0].devBuySol],[ODD,'0']);
});

test('Pump.fun custom pairs: creator-chosen fee within Pump.fun’s limit, convertibility and unavailable pairs',async t=>{
  const s=server({pairs:PAIRS}),p=await page({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.pump();await p.fill();
  await until(()=>!p.document.querySelector('[data-pair=custom]').hidden,'the pair list did not load');
  p.$('launch-asset-open').onclick();await flush();
  const row=mint=>[...p.$('launch-asset-results').querySelectorAll('button')].find(b=>b.dataset.mint===mint);
  assert(row(XSTOCK)&&row(ODD)&&row(HOOK),'every Pump.fun pair is listed');assert.equal(row(HOOK).disabled,true);assert.match(row(HOOK).textContent,/transfer hook/);assert.match(row(XSTOCK).textContent,/creator fee you choose/);
  row(HOOK).onclick();assert.notEqual(p.$('launch-card-pair').dataset.mint,HOOK,'an unavailable pair cannot be chosen');
  row(ODD).onclick();await flush();
  p.option('holders');await flush();assert.equal(p.$('launch-open').disabled,true);assert.match(p.$('launch-fee-note').textContent,/can’t sell ODD for SOL yet, which Holders, Diamond Hands and Gotchi need, so they are unavailable on this pair\. Creator works on it, or choose SOL as the pair\./);
  assert.match(p.$('launch-ready-text').textContent,/Next, choose Creator for ODD \(Holders, Diamond Hands and Gotchi need a pair Launchpad can sell for SOL\) or SOL as the pair/,'the step rail names the way out');
  p.option('agent');await flush();assert.match(p.$('launch-fee-note').textContent,/AI Agent pairs with SOL only on Pump\.fun\. Choose SOL as the pair, or Creator for ODD\./,'a pair Launchpad cannot sell offers Creator only');assert.match(p.$('launch-ready-text').textContent,/or Creator for ODD$/);
  p.option('creator');assert.equal(p.$('launch-open').disabled,false,'Creator works on a pair Launchpad cannot convert yet');
  p.$('launch-asset-open').onclick();await flush();row(XSTOCK).onclick();await flush();
  p.option('holders');assert.equal(p.$('launch-open').disabled,false);
  await p.open();
  assert.equal(p.$('launch-pump-classic-fee-wrap').hidden,false);
  const options=[...p.$('launch-pump-classic-fee').options].map(o=>o.textContent);
  assert.deepEqual(options,['Pump.fun standard','0.1%','0.25%','0.5%','0.75%','1%','1.5%','2%','2.5%','3%','4%','5%'],'rates stop at Pump.fun’s live limit');
  p.$('launch-pump-classic-fee').value='250';p.$('launch-pump-classic-buy').value='0';await p.button('Review launch').onclick();
  assert.equal(s.quotes.length,1);assert.deepEqual([s.quotes[0].quoteMint,s.quotes[0].creatorFeeBps,s.quotes[0].devBuyAmount,s.quotes[0].mode],[XSTOCK,250,'0','holders']);
  assert.match(p.$('launch-pump-classic-operation').textContent,/Creator fee \(your choice\)2\.5%/);
});

test('when a chosen Pump.fun pair stops being offered the page returns to SOL and never reuses the amount in SOL',async t=>{
  const s=server({pairs:PAIRS}),p=await page({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.pump();await p.fill();
  await until(()=>!p.document.querySelector('[data-pair=USDC]').hidden,'the pair list did not load');
  p.document.querySelector('[data-pair=USDC]').onclick();await flush();
  p.$('launch-pump-classic-buy').value='10';p.$('launch-pump-classic-buy').dispatchEvent(new p.window.Event('input'));
  s.pairs=[PAIRS[0]];const now=Date.now;Date.now=()=>now()+120000;
  try{await p.intervals.get(60000)();await flush();await flush();}finally{Date.now=now;}
  await until(()=>p.$('launch-card-pair').dataset.mint===ADDRESS,'the page did not return to SOL');
  assert.equal(p.$('launch-pump-classic-buy').value,'0','a USDC amount is never reused as SOL');assert.match(p.$('launch-pump-classic-note').textContent,/USDC is not offered right now/);
  assert.equal(p.document.querySelector('[data-pair=USDC]').hidden,true);
});

// v71.25 regressions.
const IDS=['a1'.repeat(12),'b2'.repeat(12),'c3'.repeat(12),'d4'.repeat(12)];
test('each saved Pump.fun row opens its own launch, with what happened to its funding, without a wallet; the list follows a cancel',async t=>{
  const saved=[view({id:IDS[0],symbol:'FIRST',state:'funding_pending',stateLabel:'Confirming funding',canFund:false,signatures:{funding:FUNDING_SIG,create:null,refund:null}}),view({id:IDS[1],symbol:'SECOND'}),
    view({id:IDS[2],symbol:'THIRD',state:'failed',stateLabel:'Failed',reason:'Pump.fun rejected the creation transaction.',canFund:false,refundedSol:'0.15',dimensions:{launch:'failed',delivery:'none',fees:'none',venue:'curve',refund:'complete'},signatures:{funding:FUNDING_SIG,create:null,refund:CREATE_SIG}}),
    view({id:IDS[3],symbol:'FOURTH',state:'failed',stateLabel:'Failed',reason:'The pair accounts could not be created.',canFund:false,dimensions:{launch:'failed',delivery:'none',fees:'none',venue:'curve',refund:'pending'}})];
  const s=server({saved}),p=await page({route:s.route});t.after(()=>p.controller.destroy());
  await until(()=>p.$('launch-list').querySelectorAll('.launch-history-row').length===4,'the saved launches were not listed');
  const row=symbol=>[...p.$('launch-list').querySelectorAll('.launch-history-row')].find(r=>r.querySelector('strong').textContent===symbol),text=()=>p.$('launch-pump-classic-operation').textContent;
  assert.match(row('THIRD').textContent,/Pump\.fun · Refunded$/,'a failed launch whose funding came back says so');assert.match(row('FOURTH').textContent,/Pump\.fun · Refunding$/);
  assert.match(row('SECOND').textContent,/Pump\.fun · Waiting for funding$/);assert.match(row('FIRST').textContent,/Pump\.fun · Confirming funding$/);
  for(const [symbol,id] of [['THIRD',IDS[2]],['FOURTH',IDS[3]],['FIRST',IDS[0]],['SECOND',IDS[1]]]){
    row(symbol).onclick();await until(()=>p.$('launch-pump-classic-dialog').open,symbol+' did not open');await flush();
    assert.match(text(),new RegExp('Example · \\$'+symbol),symbol+' opens its own launch');assert(p.calls.some(c=>c.path==='/api/launchpad/pump-classic/launch?launchId='+id));
    assert.equal(p.document.querySelector('.launch-venue').textContent,'Launch on Pump.fun');
    if(symbol==='THIRD'){assert.match(text(),/rejected the creation transaction\. Your unused funding was refunded\./);assert.match(text(),/Refunded0\.15 SOL/);assert.match(text(),/Refund transaction ↗/);}
    if(symbol==='FOURTH')assert.match(text(),/Your funding is being refunded automatically\./);
    if(symbol==='FIRST')assert.match(text(),/Funding transaction ↗/);
    if(symbol==='SECOND'){assert.match(text(),/Your saved quote is still valid/);break;}
    await p.$('launch-pump-classic-close').onclick();await flush();assert.equal(p.$('launch-pump-classic-dialog').open,false);
  }
  assert.equal(p.mock.calls.connect,0,'looking at saved launches needs no wallet');assert.notEqual(p.$('launch-wallet-dialog').open,true);assert.equal(s.quotes.length,0);
  // Closing a saved quote cancels it, and its row leaves "Your coins" without a reload.
  await p.$('launch-pump-classic-close').onclick();await flush();assert.deepEqual(s.cancels,[{launchId:IDS[1]}]);
  await until(()=>!row('SECOND'),'the cancelled quote stayed listed');assert(row('FIRST')&&row('THIRD'));
});

test('a /launchpad?venue=pump-classic&launchId= link opens that launch after sign-in, without a wallet or a celebration',async t=>{
  const live=view({id:IDS[3],symbol:'LINKED',state:'created',stateLabel:'Live on Pump.fun',canFund:false,devTokens:'17000000000000',dimensions:{launch:'created',delivery:'complete',fees:'verified',venue:'curve',refund:'complete'},signatures:{funding:FUNDING_SIG,create:CREATE_SIG,refund:null}});
  const s=server({saved:[live]}),p=await page({route:s.route,href:'http://app.local/launchpad?venue=pump-classic&launchId='+IDS[3]});t.after(()=>p.controller.destroy());
  await until(()=>p.$('launch-pump-classic-dialog').open,'the linked launch did not open');
  const text=p.$('launch-pump-classic-operation').textContent;
  assert.equal(p.document.querySelector('.launch-venue').textContent,'Launch on Pump.fun');assert.match(text,/Example · \$LINKED/);assert.match(text,/Your coin is live on Pump\.fun/);
  assert.match(text,/Dev buy0\.5 SOL/);assert.doesNotMatch(text,/Dev buy \(maximum\)/,'a live coin shows the dev buy it made');
  assert.equal(p.$('launch-toast').hidden,true,'an already live coin is not announced again');assert.equal(p.mock.calls.connect,0);assert.equal(s.quotes.length,0);
  // A malformed id is ignored.
  const q=server(),bad=await page({route:q.route,href:'http://app.local/launchpad?venue=pump-classic&launchId=../../admin'});t.after(()=>bad.controller.destroy());await flush();await flush();
  assert.notEqual(bad.$('launch-pump-classic-dialog').open,true);assert(!bad.calls.some(c=>c.path.includes('/pump-classic/launch?')));assert.equal(bad.document.querySelector('.launch-venue').textContent,'Launch on Pump.fun');
});

test('after a Pump.fun coin goes live its details are cleared, so one more click cannot launch the same coin twice',async t=>{
  const s=server(),p=await page({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.pump();await p.fill();p.form.elements.namedItem('description').value='  Line one.\nLine two.  ';p.form.elements.namedItem('twitter').value='@examplecoin';p.form.elements.namedItem('telegram').value='examplecoin';
  await p.open();p.$('launch-pump-classic-buy').value='1,5';await p.button('Review launch').onclick();
  assert.equal(s.quotes.length,0);assert.match(p.$('launch-pump-classic-operation').textContent,/Use a dot for decimals in the dev buy, like 1\.5\./);
  p.$('launch-pump-classic-buy').value='.5';await p.button('Review launch').onclick();
  assert.equal(s.quotes.length,1);const quote=s.quotes[0];
  assert.deepEqual([quote.devBuySol,quote.name,quote.symbol,quote.description,quote.twitter,quote.telegram,quote.website],['0.5','Example','EXAMPLE','Line one. Line two.','https://x.com/examplecoin','https://t.me/examplecoin','']);
  await p.button('Fund and launch').onclick();await until(()=>s.launch.state==='created'&&p.form.elements.namedItem('name').value==='','the launched coin stayed in the form');
  assert.equal(p.form.elements.namedItem('symbol').value,'');assert.equal(p.form.elements.namedItem('description').value,'');assert.equal(p.form.elements.namedItem('twitter').value,'');assert.equal(p.$('launch-image-preview').hidden,true);
  assert.equal(p.$('launch-toast').hidden,false);assert.equal(p.document.querySelector('.launch-venue').textContent,'Launch on Pump.fun','the venue stays');
  await p.$('launch-pump-classic-close').onclick();await flush();await p.open();
  assert.equal(s.quotes.length,1,'no second quote');assert.match(p.$('launch-pump-classic-note').textContent,/Add your coin image/);
  // ".5" and "1." read as amounts, like on the other venues.
  p.$('launch-pump-classic-buy').value='1.';assert.doesNotMatch(p.$('launch-card-buy').textContent,/1\./);
});

test('an expired Pump.fun quote says so and shows an error track; a quote left while it is prepared is cancelled when it arrives',async t=>{
  const {document,window}=parseHTML('<!doctype html><div id="root"></div>');let now=1000;
  const root=document.getElementById('root'),quoted=view({mode:'creator',quote:{...view().quote,expiresAt:5000}});
  const ui=pumpClassicUi.createPumpClassicLaunch({document,window,root,request:async()=>quoted,wallet:{state:()=>({address:ADDRESS})},getInput:()=>({mode:'creator'}),clock:()=>now,setTimer:()=>0,clearTimer:()=>{}});t.after(()=>ui.destroy());
  await ui.quote();const status=()=>root.querySelector('.pump-classic-status');assert.match(status().textContent,/Review the quote/);
  now=6000;ui.render();
  assert.equal(status().textContent,'This quote expired before funding. Start over for a fresh quote.');assert(status().classList.contains('negative'));
  assert.equal(root.querySelector('.pump-classic-track').dataset.state,'error');assert.equal([...root.querySelectorAll('button')].find(b=>b.textContent==='Fund and launch').hidden,true);
  // On the page: the dialog closes at once while the quote is prepared, the inputs are locked meanwhile, and the quote is cancelled on arrival.
  let release;const s=server(),route=s.route;s.route=async(path,body)=>{if(path.endsWith('/pump-classic/quote')){await new Promise(resolve=>{release=resolve;});}return route(path,body);};
  const p=await page({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.pump();await p.fill();await p.open();p.$('launch-pump-classic-buy').value='0.5';
  const quoting=p.button('Review launch').onclick();await flush();
  assert.equal(p.$('launch-pump-classic-buy').disabled,true,'the dev buy is fixed while its quote is prepared');
  await p.$('launch-pump-classic-close').onclick();assert.equal(p.$('launch-pump-classic-dialog').open,false,'the dialog closes while the quote is prepared');
  release();await quoting;await until(()=>s.cancels.length===1,'the late quote was not cancelled');await until(()=>!p.$('launch-pump-classic-buy').disabled,'the dev buy stayed locked');
  assert.equal(p.$('launch-pump-classic-dialog').open,false);assert.equal(p.mock.calls.sign.length,0);
});

test('Pump.fun readable request errors, its step rail ticker rule, option needs and categories that list something',async t=>{
  const s=server({pairs:PAIRS}),route=s.route;let fail='';s.route=async(path,body)=>{if(fail&&path.endsWith('/pump-classic/quote')){if(fail==='network')throw new TypeError('Failed to fetch');return{ok:false,status:502,body:'<html>Bad gateway</html>'};}return route(path,body);};
  const p=await page({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.pump();await p.fill();await until(()=>!p.document.querySelector('[data-pair=custom]').hidden,'the pair list did not load');
  for(const [mode,message] of [['network',/Launchpad could not be reached/],['html',/temporarily unavailable/]]){
    fail=mode;await p.open();await p.button('Review launch').onclick();const text=p.$('launch-pump-classic-operation').textContent;assert.match(text,message,mode);assert.doesNotMatch(text,/Failed to fetch|connection was interrupted/);
    await p.$('launch-pump-classic-close').onclick();await flush();
  }
  fail='';
  // Pump.fun takes tickers Raydium does not; the rail follows the venue.
  p.form.elements.namedItem('symbol').value='PEPE-2';p.form.dispatchEvent(new p.window.Event('input'));
  assert.equal(p.document.querySelector('[data-launch-step=details]').classList.contains('is-done'),true);
  p.option('gotchi');assert.match(p.$('launch-ready-text').textContent,/Next, choose a Gotchi/);assert.equal(p.document.querySelector('[data-launch-step=market]').classList.contains('is-done'),false);
  p.option('agent');await flush();await flush();assert.match(p.$('launch-ready-text').textContent,/Next, give your agent a mission/);
  assert.equal(p.$('launch-agent-domains').placeholder,'Vetted domains only (max 10)','no domain is suggested that the platform has not vetted');
  p.option('creator');
  // Crypto lists only SOL and USDC here, which have their own buttons: its tab is hidden. Unavailable pairs go last.
  p.$('launch-asset-open').onclick();await flush();
  assert.equal(p.document.querySelector('[data-category=crypto]').hidden,true);assert.equal(p.document.querySelector('[data-category=custom]').hidden,false);
  const mints=[...p.$('launch-asset-results').querySelectorAll('button')].map(b=>b.dataset.mint);assert.equal(mints.at(-1),HOOK,'the unavailable pair is listed last');
  p.$('launch-asset-dialog').close();p.venue('raydium').onclick();await flush();
  assert.equal(p.document.querySelector('[data-launch-step=details]').classList.contains('is-done'),false);assert.match(p.$('launch-ready-text').textContent,/Next, fix the ticker/);
});

test('the Pump.fun preview card shows the dev buy in the unit it is paid in, None where a pair cannot take one, and Enter asks for the quote',async t=>{
  const SOL_PAID=PAIRS.map(x=>x.kind==='sol'?x:{...x,devBuyIn:'SOL',maxDevBuySol:'25',devBuyAvailable:x.convertible===true,devBuySlippageBps:200});
  const s=server({pairs:SOL_PAID}),p=await page({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.pump();await p.fill();await until(()=>!p.document.querySelector('[data-pair=USDC]').hidden,'no pairs');
  const type=value=>{p.$('launch-pump-classic-buy').value=value;p.$('launch-pump-classic-buy').dispatchEvent(new p.window.Event('input'));};
  // The card reads amounts as the dev buy field does: ".5" and "1." are amounts, "00.5" and "1,5" are not.
  for(const [value,label] of [['.5','0.5 SOL'],['1.','1 SOL'],['00.5','None'],['1,5','None']]){type(value);assert.equal(p.$('launch-card-buy').textContent,label,value);}
  p.document.querySelector('[data-pair=USDC]').onclick();await flush();type('0.5');
  assert.equal(p.$('launch-card-buy').textContent,'0.5 SOL','a USDC pair paid in SOL shows SOL');
  p.$('launch-asset-open').onclick();await flush();[...p.$('launch-asset-results').querySelectorAll('button')].find(b=>b.dataset.mint===ODD).onclick();await flush();type('1');
  assert.equal(p.$('launch-card-buy').textContent,'None','a pair Launchpad cannot buy takes no dev buy');
  const q=server({pairs:PAIRS}),o=await page({route:q.route});t.after(()=>o.controller.destroy());
  await o.connect();await o.pump();await o.fill();await until(()=>!o.document.querySelector('[data-pair=USDC]').hidden,'no pairs');
  o.document.querySelector('[data-pair=USDC]').onclick();await flush();o.$('launch-pump-classic-buy').value='25';o.$('launch-pump-classic-buy').dispatchEvent(new o.window.Event('input'));
  assert.equal(o.$('launch-card-buy').textContent,'25 USDC','a pair paid in its own asset shows that asset');
  await o.open();const enter=new o.window.Event('keydown');Object.defineProperty(enter,'key',{value:'Enter'});o.$('launch-pump-classic-buy').dispatchEvent(enter);
  await until(()=>q.quotes.length===1,'Enter in the dev buy did not ask for the quote');assert.equal(q.quotes[0].devBuyAmount,'25');
});

// v71.25: the Pump.fun server limits names to 32 and tickers to 13 UTF-8 bytes (emoji and accented letters count 2 to
// 4), so the page counts bytes too. An idle launch dialog is marked data-navigation-free for the site router; a quote
// in progress, or one waiting for funding, holds navigation.
test('Pump.fun counts names and tickers in bytes like its server, and its dialog holds navigation only while a quote is in progress',async t=>{
  let hold=false,release=()=>{};const s=server(),route=s.route;
  s.route=async(path,body)=>{if(hold&&path.endsWith('/pump-classic/quote'))await new Promise(resolve=>{release=resolve;});return route(path,body);};
  const p=await page({route:s.route});t.after(()=>p.controller.destroy());
  const name=p.form.elements.namedItem('name'),symbol=p.form.elements.namedItem('symbol'),dialog=p.$('launch-pump-classic-dialog'),free=()=>dialog.hasAttribute('data-navigation-free');
  await p.connect();
  assert.equal(symbol.maxLength,10);assert.equal(symbol.getAttribute('pattern'),'[A-Za-z0-9_]+','Raydium tickers use letters, numbers and _');
  await p.pump();await p.fill();
  assert.equal(symbol.maxLength,13);assert.equal(symbol.hasAttribute('pattern'),false,'Pump.fun takes any ticker text up to 13 bytes');
  assert.equal(p.$('launch-asset-dialog').hasAttribute('data-navigation-free'),true,'the pair picker never holds navigation');
  name.value='Café Ünïcödé Rocket Club 🚀';await p.open();assert.equal(dialog.open,true);assert.equal(free(),true,'an idle launch dialog lets the site navigate');
  const review=async()=>{await p.button('Review launch').onclick();return p.$('launch-pump-classic-operation').textContent;};
  assert.match(p.$('launch-pump-classic-note').textContent,/The coin name is too long/,'26 characters, 34 bytes');
  assert.match(await review(),/The coin name is too long\. Use at most 32 characters; emoji and accented letters count as 2 to 4 each\./);
  assert.equal(p.$('launch-pump-classic-note').textContent,'','the message is not repeated under the dev buy');
  name.value='Café Rocket';symbol.value='ÜBERCOINS🚀';
  assert.match(await review(),/The ticker is too long\. Use at most 13 characters; emoji and accented letters count as 2 to 4 each\./,'10 characters, 14 bytes');
  assert.equal(s.quotes.length,0);
  symbol.value='pepe-2026-abc';hold=true;const quoting=p.button('Review launch').onclick();await flush();
  assert.equal(free(),false,'a quote in progress holds navigation');
  release();await quoting;
  assert.equal(s.quotes.length,1);assert.deepEqual([s.quotes[0].name,s.quotes[0].symbol],['Café Rocket','PEPE-2026-ABC']);
  assert.equal(free(),false,'a quote waiting for funding holds navigation');
  await p.button('Start over').onclick();await flush();assert.equal(free(),true);
});

// v71.25: a Gotchi page's "Launch one →" links to /launchpad?gotchi=<id>, and My Tokens links an unfinished Meteora
// launch to /launchpad?venue=meteora.
test('a /launchpad?gotchi= link starts a launch paired with that Gotchi, and ?venue=meteora selects Meteora',async t=>{
  const chosen=p=>[p.document.querySelector('.launch-venue').textContent,p.form.querySelector('[name=feeMode]:checked')?.value,p.form.querySelector('[name=gotchiId]:checked')?.value||''];
  const s=server(),p=await page({route:s.route,href:'http://app.local/launchpad?gotchi=pumpgotchi'});t.after(()=>p.controller.destroy());await flush();
  assert.deepEqual(chosen(p),['Powered by Raydium','gotchi','pumpgotchi']);
  assert.equal(p.$('launch-gotchi-picker').hidden,false);assert.match(p.$('launch-gotchi-note').textContent,/^Pumpgotchi · /);assert.equal(p.$('launch-card-mode').textContent,'Gotchi');
  const m=server(),meteora=await page({route:m.route,href:'http://app.local/launchpad?venue=meteora&gotchi=pumpgotchi'});t.after(()=>meteora.controller.destroy());await flush();await flush();
  assert.deepEqual(chosen(meteora),['Powered by Meteora','gotchi','pumpgotchi']);
  const f=server(),pump=await page({route:f.route,href:'http://app.local/launchpad?venue=pump-classic&gotchi=fomogotchi'});t.after(()=>pump.controller.destroy());await flush();await flush();
  assert.deepEqual(chosen(pump),['Launch on Pump.fun','gotchi','fomogotchi']);
  // An unknown Gotchi changes nothing.
  const b=server(),bad=await page({route:b.route,href:'http://app.local/launchpad?gotchi=..%2Fadmin'});t.after(()=>bad.controller.destroy());await flush();
  assert.deepEqual(chosen(bad),['Powered by Raydium','creator','']);
});

// v71.25: Review hid itself under the keyboard focus, which then fell back to <body>. (The hidden test documents
// cannot take real focus, so focus is recorded through a stub.)
test('when Review hides itself after a quote, focus moves to the status message, never to <body> or onto Fund',async t=>{
  const {document,window}=parseHTML('<!doctype html><div id="root"></div>');let active=null;
  Object.defineProperty(document,'activeElement',{configurable:true,get:()=>active||document.body});
  window.HTMLElement.prototype.focus=function(){active=this;};
  const root=document.getElementById('root'),quoted=view({mode:'creator'});
  const ui=pumpClassicUi.createPumpClassicLaunch({document,window,root,request:async()=>quoted,wallet:{state:()=>({address:ADDRESS})},getInput:()=>({mode:'creator'}),setTimer:()=>0,clearTimer:()=>{}});t.after(()=>ui.destroy());
  const button=text=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);
  button('Review launch').focus();await ui.quote();
  assert.equal(button('Review launch').hidden,true);assert.equal(button('Fund and launch').hidden,false);
  assert.equal(active,root.querySelector('.pump-classic-status'),'focus moves to the status message');assert.match(active.textContent,/Review the quote/);
});

// ---- v71.27: AI Agent objectives, program settings and the model picker ----------------------------------------
const choose=(p,name,value)=>{const input=[...p.form.querySelectorAll('input[name='+name+']')].find(x=>x.value===value);assert(input,name+'='+value);for(const other of p.form.querySelectorAll('input[name='+name+']'))other.checked=other===input;input.dispatchEvent(new p.window.Event('change',{bubbles:true}));};
test('AI Agent objectives: every personality and objective is offered, a program locks the capability it needs, fills the mission and writes its settings',async t=>{
  const s=server(),p=await page({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.fill();p.option('agent');await flush();await flush();
  assert.equal(p.document.querySelectorAll('#launch-agent-personalities .launch-agent-choice').length,AGENT_PERSONALITIES.length);
  assert.equal(p.document.querySelectorAll('#launch-agent-objectives .launch-agent-objective').length,AGENT_OBJECTIVES.length);
  assert.deepEqual([...p.document.querySelectorAll('#launch-agent-objectives .launch-agent-objective-group')].map(group=>group.dataset.group),AGENT_OBJECTIVE_GROUPS.map(group=>group.id));
  assert.equal(p.form.elements.namedItem('agentObjective').value,'custom');assert.equal(p.$('launch-agent-objective-settings').hidden,true);
  assert.match(p.$('launch-agent-objective-rule-text').textContent,/Nothing on its own/);assert.equal(p.$('launch-agent-buyback').disabled,false);
  // Metronome needs buy-and-burn: the box is ticked and locked with the reason, the settings appear with their defaults, the empty mission takes the objective's default.
  choose(p,'agentObjectiveChoice','metronome');await flush();
  assert.equal(p.form.elements.namedItem('agentObjective').value,'metronome');
  assert.equal(p.$('launch-agent-buyback').checked,true);assert.equal(p.$('launch-agent-buyback').disabled,true);
  assert.match(p.$('launch-agent-buyback').closest('label').querySelector('[data-agent-lock]').textContent,/Needed by Metronome/);
  assert.equal(p.$('launch-agent-rewards').disabled,false,'rewards stay the creator’s choice');
  assert.equal(p.$('launch-agent-objective-settings').hidden,false);assert.equal(p.$('agentObjective_sharePct').value,'2');assert.equal(p.$('agentObjective_intervalHours').value,'12');
  assert.equal(p.$('launch-agent-mission').value,objectiveById('metronome').mission);assert.match(p.$('launch-agent-objective-rule-text').textContent,/every 6, 12 or 24 hours/);
  assert.match(p.$('launch-agent-objective-rule-text').textContent,/The platform runs it on its own schedule/);
  // The segmented interval writes the hidden value; a typed share travels as a number.
  [...p.$('launch-agent-objective-settings').querySelectorAll('button')].find(b=>b.dataset.value==='6').click();assert.equal(p.$('agentObjective_intervalHours').value,'6');
  p.$('agentObjective_sharePct').value='2.5';p.$('agentObjective_sharePct').dispatchEvent(new p.window.Event('input',{bubbles:true}));
  assert.equal(p.$('launch-agent-objective-error').hidden,true);
  // Out-of-range numbers show the catalogue's message and keep the launch from opening; a valid value clears it.
  p.$('agentObjective_sharePct').value='9';p.$('agentObjective_sharePct').dispatchEvent(new p.window.Event('input',{bubbles:true}));await flush();
  assert.equal(p.$('launch-agent-objective-error').hidden,false);assert.match(p.$('launch-agent-objective-error').textContent,/Treasury share per tick must be between 1 and 3/);
  assert.match(p.$('launch-ready-text').textContent,/fix the program settings/);assert.equal(p.$('launch-open').disabled,true);
  p.$('agentObjective_sharePct').value='3';p.$('agentObjective_sharePct').dispatchEvent(new p.window.Event('input',{bubbles:true}));await flush();
  assert.equal(p.$('launch-agent-objective-error').hidden,true);assert.equal(p.$('launch-open').disabled,false);
  // A typed mission is never replaced when the objective changes; a default one follows the new objective.
  choose(p,'agentObjectiveChoice','dip_buyer');await flush();assert.equal(p.$('launch-agent-mission').value,objectiveById('dip_buyer').mission);assert.equal(p.$('agentObjective_dropPct').value,'15');
  p.$('launch-agent-mission').value='My own words.';choose(p,'agentObjectiveChoice','survivor');await flush();
  assert.equal(p.$('launch-agent-mission').value,'My own words.');assert.equal(p.$('launch-agent-objective-settings').hidden,true);
  // A voice objective returns the box to the creator (it was only ticked by the program), and the rule says there is no program.
  assert.equal(p.$('launch-agent-buyback').disabled,false);assert.equal(p.$('launch-agent-buyback').checked,false);assert.match(p.$('launch-agent-objective-rule-text').textContent,/No program/);
  // anyOf: Milestones needs buy-and-burn or holder rewards; one is kept on.
  choose(p,'agentObjectiveChoice','milestones');await flush();
  assert.equal(p.$('launch-agent-buyback').checked||p.$('launch-agent-rewards').checked,true);assert.equal(p.$('launch-agent-capability-note').hidden,false);assert.match(p.$('launch-agent-capability-note').textContent,/Milestones needs buy-and-burn or holder rewards/);
  // What the form sends: the normalized request carries the objective and only the numbers that were typed.
  choose(p,'agentObjectiveChoice','metronome');await flush();p.$('agentObjective_sharePct').value='1.5';p.$('agentObjective_sharePct').dispatchEvent(new p.window.Event('input',{bubbles:true}));
  const sent=agentLaunchRequest({venue:'raydium',mission:p.$('launch-agent-mission').value,personalityPreset:p.form.elements.namedItem('agentPersonalityPreset').value,model:'openai/gpt-6-luna',buyback:p.$('launch-agent-buyback').checked,rewards:p.$('launch-agent-rewards').checked,objective:p.form.elements.namedItem('agentObjective').value,objectiveSettings:{sharePct:Number(p.$('agentObjective_sharePct').value),intervalHours:Number(p.$('agentObjective_intervalHours').value)}});
  assert.equal(sent.objective,'metronome');assert.deepEqual(sent.objectiveSettings,{sharePct:1.5,intervalHours:12},'settings start from the defaults again after the objective changed');
});

test('AI Agent model picker: models are grouped by provider with prices, only available ones are offered, and an unpriced catalogue falls back to the whole list',async t=>{
  const models=[{id:'openai/gpt-6-luna',name:'GPT-6 Luna',provider:'openai',providerName:'OpenAI',tag:'deep',available:true,promptUsdPerMillion:2.5,completionUsdPerMillion:10,contextLength:1000000,supportsTools:true},{id:'anthropic/claude-haiku-4.5',name:'Claude Haiku 4.5',provider:'anthropic',providerName:'Anthropic',tag:'fast',available:true,promptUsdPerMillion:1,completionUsdPerMillion:5,contextLength:200000,supportsTools:true},{id:'minimax/minimax-m2.1',name:'minimax/minimax-m2.1',provider:'minimax',providerName:'MiniMax',tag:null,available:false,unavailableReason:'not in the live catalog',unavailable:true,stale:true}];
  const s=server();const base=s.route;s.route=async(path,body)=>path==='/api/launchpad/agents/catalog'?{intakeOpen:true,models,defaultModel:'openai/gpt-6-luna',domainAllowlist:[]}:base(path,body);
  const p=await page({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.fill();p.option('agent');await flush();await flush();
  assert.equal(p.form.elements.namedItem('agentModel').value,'openai/gpt-6-luna');assert.match(p.$('launch-agent-model-current').textContent,/GPT-6 Luna/);assert.match(p.$('launch-agent-model-current').textContent,/\$2\.50 in \/ \$10\.00 out per 1M tokens/);
  assert.equal(p.$('launch-agent-models').hidden,true);p.document.querySelector('.launch-agent-model-toggle').click();await flush();
  assert.equal(p.$('launch-agent-models').hidden,false);
  assert.deepEqual([...p.$('launch-agent-models').querySelectorAll('.launch-agent-model-group')].map(group=>group.dataset.provider),['OpenAI','Anthropic'],'the unavailable model is not offered');
  assert.deepEqual([...p.$('launch-agent-models').querySelectorAll('.launch-agent-model')].map(label=>label.dataset.model),['openai/gpt-6-luna','anthropic/claude-haiku-4.5']);
  assert.match(p.document.querySelector('.launch-agent-model[data-model="anthropic/claude-haiku-4.5"]').textContent,/fast/);
  choose(p,'agentModelChoice','anthropic/claude-haiku-4.5');await flush();
  assert.equal(p.form.elements.namedItem('agentModel').value,'anthropic/claude-haiku-4.5');assert.match(p.$('launch-agent-model-current').textContent,/Claude Haiku 4\.5/);
  // No live pricing at all: every model is listed, priced "unavailable", and still selectable; the server decides at launch.
  const unpriced=models.map(model=>({...model,available:false,unavailable:true,stale:true,promptUsdPerMillion:undefined,completionUsdPerMillion:undefined}));
  s.route=async(path,body)=>path==='/api/launchpad/agents/catalog'?{intakeOpen:true,models:unpriced,defaultModel:'openai/gpt-6-luna',domainAllowlist:[]}:base(path,body);
  const q=await page({route:s.route});t.after(()=>q.controller.destroy());
  await q.connect();await q.fill();q.option('agent');await flush();await flush();
  assert.match(q.$('launch-agent-models').textContent,/Live pricing is unavailable right now/);assert.equal(q.$('launch-agent-models').querySelectorAll('.launch-agent-model').length,3);
  assert.equal(q.form.elements.namedItem('agentModel').value,'openai/gpt-6-luna');assert.match(q.$('launch-agent-model-current').textContent,/Price unavailable/);
});

test('Diamond Hands, Earned and Insured: the settings panel comes from the catalogue, describes the rules live, travels with the quote and is fixed by it',async t=>{
  const s=server(),p=await page({route:s.route});t.after(()=>p.controller.destroy());
  await p.connect();await p.pump();await p.fill();
  // No panel for options without settings.
  p.option('creator');await p.open();assert.equal(p.$('launch-pump-classic-option-wrap').hidden,true);p.$('launch-pump-classic-close').onclick?.();p.$('launch-pump-classic-dialog').close?.();
  for(const mode of PUMP_CLASSIC_OPTION_MODES){
    p.option(mode);await flush();await p.open();
    const wrap=p.$('launch-pump-classic-option-wrap'),panel=wrap.querySelector('[data-pump-option="'+mode+'"]');
    assert.equal(wrap.hidden,false,mode+' shows its panel');assert.ok(panel&&!panel.hidden,mode+' panel visible');
    for(const other of wrap.querySelectorAll('[data-pump-option]'))if(other!==panel)assert.equal(other.hidden,true,'only the chosen option’s panel shows');
    const fields=PUMP_OPTIONS[mode].settings,inputs=[...panel.querySelectorAll('input,select')];
    assert.deepEqual(inputs.map(i=>i.dataset.key),fields.map(f=>f.key),mode+' has one field per setting');
    for(const f of fields){const input=panel.querySelector('[data-key="'+f.key+'"]');assert.equal(input.value,String(f.value),f.key+' starts at its default');if(!f.options){assert.equal(input.min,String(f.min));assert.equal(input.max,String(f.max));assert.equal(input.step,String(f.step));}}
    assert.equal(panel.querySelector('.launch-pump-option-help').textContent,describePumpOption(mode,{}),'the live line describes the defaults');
    assert.match(p.$('launch-pump-classic-option').textContent,new RegExp('^'+PUMP_CLASSIC_MODE_LABELS[mode]+' · '));
    p.$('launch-pump-classic-close').onclick?.();p.$('launch-pump-classic-dialog').close?.();
  }
  // Typed numbers show in the description; an out-of-range number names the problem and blocks the quote.
  p.option('insured');await flush();await p.open();
  const panel=p.$('launch-pump-classic-option-wrap').querySelector('[data-pump-option=insured]'),set=(key,value)=>{const input=panel.querySelector('[data-key="'+key+'"]');input.value=String(value);input.dispatchEvent(new p.document.defaultView.Event('input',{bubbles:true}));};
  set('coveragePercent',40);set('deadlineDays',14);const target=panel.querySelector('[data-key=onGraduation]');target.value='1';target.dispatchEvent(new p.document.defaultView.Event('change',{bubbles:true}));await flush();
  assert.match(panel.querySelector('.launch-pump-option-help').textContent,/^40% of the creator’s fee share is kept as a refund pot.*within 14 days.*paid to holders as a bonus/);
  set('deadlineDays',3);await flush();
  assert.match(panel.querySelector('.launch-pump-option-help').textContent,/Graduation deadline must be between 7 and 90 days/);assert.equal(panel.querySelector('.launch-pump-option-help').dataset.state,'problem');
  await p.button('Review launch').onclick();await flush();
  assert.equal(s.quotes.length,0,'an invalid setting never reaches the server');assert.match(p.$('launch-pump-classic-operation').textContent,/Graduation deadline must be between 7 and 90 days/);
  set('deadlineDays',14);await flush();
  await p.button('Review launch').onclick();
  assert.equal(s.quotes.length,1);assert.equal(s.quotes[0].mode,'insured');assert.deepEqual(s.quotes[0].option,{version:1,kind:'insured',settings:{coveragePercent:40,deadlineDays:14,onGraduation:1}});
  assert.equal(p.$('launch-pump-classic-option-wrap').hidden,true,'the quote fixes the settings');
  assert.match(p.$('launch-pump-classic-option').textContent,/Insured · paired with SOL · /);
});

test('the docs and terms describe Diamond Hands, Earned and Insured (v71.35): the option table rows, the subsection with every setting’s range, the pairs rule, the revenue share and the terms clause',async()=>{
  const plain=node=>String(node?.textContent||'').replace(/\s+/g,' ').trim(),escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const {document}=parseHTML(await readFile(new URL('../public/docs.html',import.meta.url),'utf8'));
  const section=document.getElementById('pump-fun');assert(section);
  const rows=Object.fromEntries([...section.querySelectorAll('.documentation-table tbody tr')].map(row=>[plain(row.querySelector('td')),plain(row.querySelectorAll('td')[1])]).filter(([k])=>k));
  for(const mode of PUMP_CLASSIC_OPTION_MODES)assert.ok(rows[PUMP_CLASSIC_MODE_LABELS[mode]],mode+' has a row in the option table');
  assert.match(rows['Diamond Hands'],/skips any wallet whose balance dropped since its last payout/);assert.match(rows['Earned'],/escrow/);assert.match(rows['Insured'],/refund pot/);
  const heading=document.getElementById('pump-fun-options');assert(heading);assert.equal(heading.tagName,'H3');assert.equal(plain(heading),'Diamond Hands, Earned and Insured');
  const copy=plain(heading.nextElementSibling)+' '+plain(heading.nextElementSibling.nextElementSibling)+' '+plain(heading.nextElementSibling.nextElementSibling.nextElementSibling);
  for(const mode of PUMP_CLASSIC_OPTION_MODES)for(const setting of PUMP_OPTIONS[mode].settings){
    if(setting.options){continue;}
    assert.match(copy,new RegExp(escape(setting.min+'–'+setting.max)),mode+' '+setting.key+' range');assert.match(copy,new RegExp('default '+escape(String(setting.value))),mode+' '+setting.key+' default');
  }
  for(const phrase of ['written on the launch when the coin is created and never change','top 100 holders','streak starts over','baseline','escrow','refund pot','checked every hour','pairs with SOL only','Nothing in them promises','a Holders option only'])assert.match(copy,new RegExp(escape(phrase)),phrase);
  assert.doesNotMatch(copy,/guarantee|will (rise|pump|moon)/i,'no promised outcomes');
  const pairs=plain(document.getElementById('pump-fun-pairs')?.parentElement||section);assert.match(pairs,/Holders, Diamond Hands and Gotchi need a pair Launchpad can sell for SOL/);assert.match(pairs,/Liquidity Manager, Earned and Insured pair with SOL only/);
  assert.match(plain(document.getElementById('revenue')),/10% for Creator, Holders, Gotchi, Diamond Hands, Earned and Insured coins/);
  assert.match(plain(document.getElementById('rewards')),/Market Maker, Liquidity Manager, Diamond Hands, Earned and Insured, which are available only on Pump\.fun/);
  const terms=parseHTML(await readFile(new URL('../public/terms.html',import.meta.url),'utf8')).document,clause=[...terms.querySelectorAll('p')].find(p=>/^Diamond Hands, Earned and Insured/.test(plain(p)));
  assert(clause,'the terms carry the options clause');const words=plain(clause);
  for(const phrase of ['cannot be changed afterwards','skipped for that payout','escrow','not yours','refund pot','deadline','None of these options is insurance','a promise of any price, graduation, refund amount or return','see the docs'])assert.match(words,new RegExp(escape(phrase),'i'),phrase);
  assert.equal(clause.querySelector('a[href="/docs#pump-fun-options"]')!==null,true);
});
