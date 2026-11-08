import {optimizeLaunchImage} from '../public/launch-image.mjs';
import {createChainSelect,initialLaunchChain,launchChainById} from '../public/launch-chains.mjs';
import * as dammPumpUiModule from '../public/damm-pump-ui.mjs';
import * as meteoraUiModule from '../public/meteora-ui.mjs';
import * as pumpPublicUiModule from '../public/pump-public-ui.mjs';
import * as pumpUiModule from '../public/pump-launch-test-ui.mjs';
import {createQuoteIcon,createQuoteLabel,quoteLogoPath} from '../public/quote-logos.mjs';
import { CREATOR_FEE_TIERS, creatorFeeForLaunch } from '../public/creator-fee-schedule.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {Keypair,TransactionMessage,VersionedTransaction,SystemProgram,TransactionInstruction} from '@solana/web3.js';
import {randomUUID} from 'node:crypto';
import {parseHTML} from 'linkedom';
import {createLaunchpadWallet} from '../public/launchpad-wallet.mjs';
import {launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink} from '../public/launchpad-model.mjs';
import {LAUNCH_ASSETS} from '../public/launch-assets.mjs';
const ADDRESS='So11111111111111111111111111111111111111112';
const OTHER='11111111111111111111111111111111';
const SIGN='solana:signTransaction',CHAIN='solana:mainnet';
const flush=()=>new Promise(resolve=>setTimeout(resolve,10));
function mockWallet({address=ADDRESS,reject=false}={}){
  const calls={connect:0,sign:[],disconnect:0};let change;
  const account={address,chains:[CHAIN],features:[SIGN],publicKey:new Uint8Array(32)};
  const wallet={name:'Test wallet',chains:[CHAIN],accounts:[],features:{
    'standard:connect':{async connect(){calls.connect++;wallet.accounts=[account];return{accounts:wallet.accounts};}},
    'standard:events':{on(type,fn){assert.equal(type,'change');change=fn;return()=>{change=null;};}},
    'standard:disconnect':{async disconnect(){calls.disconnect++;wallet.accounts=[];}},
    [SIGN]:{supportedTransactionVersions:[0],async signTransaction(input){calls.sign.push(input);if(reject)throw Error('User rejected the request.');return[{signedTransaction:new Uint8Array([4,5,6])}];}}
  }};
  return{wallet,calls,change(accounts){wallet.accounts=accounts;change?.({accounts});}};
}
function register(window,wallet){let unregister;window.dispatchEvent(new window.CustomEvent('wallet-standard:register-wallet',{detail:api=>{unregister=api.register(wallet);}}));return unregister;}
function pending(){return{operationId:'operation-1',kind:'create',transaction:'AQID',wallet:ADDRESS};}
function launch(state='awaiting_signature',mode='external'){
  return{id:'launch-1',state,walletMode:mode,developerWallet:ADDRESS,wallet:ADDRESS,mint:OTHER,input:{name:'Example',symbol:'EXAMPLE',walletMode:mode,feeMode:'creator',taxBps:0,quoteMint:SOL_MINT},review:{actualUsd:20000,minimumSol:'0.02',lp:'Burned',devBuy:{gross:'0',solBudget:'0'}},reviewHash:'review-1',reviewExpires:Date.now()+180000,operations:[],autoFees:false,managedFees:false,...(state==='awaiting_signature'?{pendingSignature:pending()}:{} )};
}
// New Meteora → PumpSwap launches are closed and the venue has no button; the saved-launch
// deep link (?venue=damm-pump) is the only way in, so every page here starts from it.
async function page({initial=launch(),mock=mockWallet(),route,imageBitmap,href='http://app.local/launchpad?venue=damm-pump',features={walletOnly:false},now=Date.now,dammOptions={}}={}){
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
  const calls=[],intervals=new Map();let record=initial,poll;
  class ClockDate extends Date {static now(){return now();}}
  const fetch=async(path,options={})=>{const body=options.body?JSON.parse(options.body):undefined;calls.push({path,body});const data=await route?.(path,body,{get record(){return record;},set record(value){record=value;}});if(data)return{ok:data.ok!==false,status:data.status||200,json:async()=>data.body??data};return{ok:true,status:200,json:async()=>path==='/api/session'?{authenticated:true,token:'csrf',features,account:{}}:path.endsWith('/quotes')?{assets:LAUNCH_ASSETS.map(a=>({...a,supported:true})),canViewComingSoon:false}:path.endsWith('/image')?{imageId:'a'.repeat(64)+'.webp'}:path.endsWith('/prepare')?{...launch('draft',body.walletMode),prepareId:'prepared-1',review:{...launch().review,minimumSol:'0.03',devBuy:{gross:'100000000',net:'97000000',solBudget:units(String(body.devBuySol||0).replace(/^\./,'0.')).toString()}}}:path.endsWith('/create')?(record=launch('draft',body.walletMode)):path.endsWith('/action')?(record=record.walletMode==='default'?launch('live','default'):launch()):path.endsWith('/review')?(record=launch('draft',record.walletMode)):path.endsWith('/signature')?record:path.endsWith('/sign')?(record={...record,state:'live',pendingSignature:null}):{developerWallet:OTHER,launches:record?[record]:[]}};};
  window.addEventListener('wallet-standard:app-ready',event=>event.detail.register(mock.wallet));
  const source=(await readFile(new URL('../public/launchpad.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'').replace("await import('./pump-launch-test-ui.mjs')",'pumpUiModule').replace("await import('./pump-public-ui.mjs')",'pumpPublicUiModule').replace("await import('./meteora-ui.mjs')",'meteoraUiModule').replace("await import('./damm-pump-ui.mjs')",'dammPumpUiModule').replace(/bootPage\('launchpad',mountPage\);/,'')+'\nconst pageController=mountPage({document,window:document.defaultView});await pageController.ready;return pageController;';
  const deps={createChainSelect,initialLaunchChain,launchChainById,optimizeLaunchImage,dammPumpUiModule:{...dammPumpUiModule,createDammPumpOperation:options=>dammPumpUiModule.createDammPumpOperation({...options,...dammOptions})},meteoraUiModule,pumpUiModule,pumpPublicUiModule,Date:ClockDate,createQuoteIcon,createQuoteLabel,CREATOR_FEE_TIERS,creatorFeeForLaunch,document,fetch,FileReader,createImageBitmap:imageBitmap||(async()=>({width:8,height:8,close(){}})),crypto:{randomUUID},FormData,requestAnimationFrame:fn=>{setTimeout(fn,0);return 1;},setInterval:(fn,ms)=>{intervals.set(ms,fn);if(ms===8000)poll=fn;return ms;},setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,10)),matchMedia:()=>({matches:true}),createWorkspaceShell:()=>{},launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink,LAUNCH_ASSETS,createLaunchpadWallet};
  const controller=await new (Object.getPrototypeOf(async()=>{}).constructor)(...Object.keys(deps),source)(...Object.values(deps));await flush();
  const $=id=>document.getElementById(id);
  return{controller,document,window,form,$,calls,mock,async catalogueTick(){await intervals.get(60000)?.();await flush();},setRecord(value){record=value;},async image(){Object.defineProperty($('launch-image'),'files',{value:[{type:'image/png',size:30}],configurable:true});await $('launch-image').onchange();},poll:async()=>{await poll();await flush();},chooseLaunch(){document.querySelector('#launch-list button').onclick();},async fill(){form.elements.namedItem('name').value='Example';form.elements.namedItem('symbol').value='EXAMPLE';await this.image();},async open(){ $('launch-open').onclick();await flush();await flush();},async connect(){$('launch-connect').onclick();document.querySelector('#launch-wallet-options button').onclick();await flush();}};
}

const venue=(p,name)=>p.document.querySelector('[data-launch-venue='+name+']');
const mint='GNu1FSuype33KF4RXfow38Dw3ziw9e71FTBLVY5mdrTa';
const pairs=[{mint:SOL_MINT,symbol:'SOL',name:'Solana',decimals:9,category:'crypto',launchReady:true,supported:true},{mint:USDC_MINT,symbol:'USDC',name:'USD Coin',decimals:6,category:'crypto',launchReady:true,supported:true},{mint,symbol:'STOCK',name:'Stock test',decimals:6,category:'stocks',launchReady:true,supported:false}];
const route=(extra=()=>undefined)=>async(path,body,state)=>{const custom=await extra(path,body,state);if(custom)return custom;if(path==='/api/session')return{authenticated:true,token:'public-csrf',features:{walletOnly:true},account:{id:'public-user',authType:'wallet',mainWallet:ADDRESS}};if(path==='/api/launchpad/meteora/status')return{available:true,publicEnabled:true};if(path==='/api/launchpad/meteora/pairs')return{pairs};if(path==='/api/launchpad/meteora/operations')return{operations:[]};};
async function meteora(p){venue(p,'meteora').onclick();await flush();await flush();}

const dammRoute=(extra=()=>undefined)=>route(async(path,body,state)=>{
 const result=await extra(path,body,state);if(result)return result;
 if(path==='/api/launchpad/damm-pump/status')return{available:true,publicEnabled:true,fees:{description:'1.25% trading fee. No transfer tax.'}};
 if(path==='/api/launchpad/damm-pump/pairs')return{pairs};
 if(path==='/api/launchpad/damm-pump/operations')return{operations:[]};
});
async function damm(p){assert.equal(venue(p,'damm-pump'),null);assert.equal(p.document.querySelector('.launch-venue').textContent,'PumpSwap');await flush();await flush();}
test('public DAMM launch mode preserves $20k/$50k, removes tax and reward inputs, and retains legacy settings',async()=>{
 const p=await page({initial:null,route:dammRoute()});assert.equal(venue(p,'damm-pump'),null);assert(venue(p,'pump-classic'));for(const radio of p.form.querySelectorAll('[name=feeMode]'))radio.checked=radio.value==='holders';p.form.elements.namedItem('taxPercent').value='3';await damm(p);
 assert.equal(p.$('launch-open').disabled,false);assert.equal(p.$('launch-reward-options').hidden,true);assert.equal(p.form.elements.namedItem('taxPercent').disabled,true);assert.equal(p.$('launch-card-fdv').textContent,'$20,000');assert.match(p.$('launch-curve-summary').textContent,/\$50,000 graduation to PumpSwap/);assert.match(p.$('launch-damm-pump-disclosure').textContent,/1.25%/);
 venue(p,'raydium').onclick();await flush();assert.equal(p.$('launch-reward-options').hidden,false);assert.equal(p.form.elements.namedItem('taxPercent').value,'3');p.controller.destroy();
});
test('DAMM pair catalog offers compatible stock pairs regardless of Raydium support and excludes blocked pairs',async()=>{
 const blocked={...pairs[2],mint:'7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',symbol:'BLOCKED',launchReady:false,supportReason:'Unsupported transfer hook'};
 const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/pairs')?{pairs:[...pairs,blocked]}:undefined)});await damm(p);p.$('launch-asset-open').onclick();const options=[...p.$('launch-asset-results').querySelectorAll('button')];assert(options.some(x=>x.dataset.mint===mint&&!x.disabled));assert(!options.some(x=>x.dataset.mint===blocked.mint));options.find(x=>x.dataset.mint===mint).onclick();assert.equal(p.$('launch-card-pair').dataset.mint,mint);assert.match(p.$('launch-pair-note').textContent,/STOCK/);p.controller.destroy();
});
test('undeployed PumpSwap permits verified SOL, USDC and catalogue pair selection without permitting launch',async t=>{
 let now=100000,ready=false;
 const p=await page({initial:null,now:()=>now,route:dammRoute(path=>path.endsWith('/damm-pump/status')?{available:ready,publicEnabled:ready,blockers:ready?[]:['PumpSwap launch setup is not complete yet.']}:undefined)});t.after(()=>p.controller.destroy());
 await p.connect();await damm(p);await p.fill();
 assert.equal(venue(p,'damm-pump'),null);assert.equal(venue(p,'pump-classic').textContent,'Pump.fun');assert.equal(p.document.querySelector('.launch-venue').textContent,'PumpSwap');assert.match(p.$('launch-asset-count').textContent,/^PumpSwap · 3 pairs/);
 for(const [symbol,selectedMint]of [['USDC',USDC_MINT],['SOL',SOL_MINT]]){
  const button=p.document.querySelector('[data-pair='+symbol+']');assert.equal(button.disabled,false);button.onclick();assert.equal(p.$('launch-card-pair').dataset.mint,selectedMint);assert.equal(p.$('launch-open').disabled,true);
 }
 p.$('launch-asset-open').onclick();const stock=p.$('launch-asset-results').querySelector('[data-mint="'+mint+'"]');assert(stock);assert.equal(stock.disabled,false);assert(!stock.querySelector('.launch-asset-reason'));stock.onclick();assert.equal(p.$('launch-card-pair').dataset.mint,mint);
 assert.equal(p.$('launch-open').disabled,true);assert.equal(p.$('launch-damm-pump-availability').textContent,'PumpSwap launch setup is not complete yet.');
 // Call the handler directly as well: a disabled DOM button is not the safety gate.
 await p.open();assert(!p.$('launch-damm-pump-dialog').open);assert(!p.calls.some(x=>x.path.endsWith('/damm-pump/prepare')));assert.equal(p.mock.calls.sign.length,0);
 ready=true;now+=60001;await p.catalogueTick();assert.equal(p.$('launch-card-pair').dataset.mint,mint);assert.equal(p.$('launch-open').disabled,false);
 await p.open();assert(p.$('launch-damm-pump-dialog').open);assert.equal(p.calls.filter(x=>x.path.endsWith('/damm-pump/prepare')).at(-1)?.body.quoteMint,mint);assert.equal(p.mock.calls.sign.length,0);
});
test('unverified and incompatible PumpSwap quotes cannot be selected before or after setup',async t=>{
 const blocked={...pairs[2],mint:'7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',symbol:'BLOCKED',launchReady:false,supportReason:'Unsupported transfer hook'};
 const unknown={...pairs[2],mint:'HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF',symbol:'UNKNOWN',launchReady:undefined};
 const invalidPrecision={...pairs[2],mint:'9sNtafymXt6ENpr8Z7zhxTMq752AMdkXLq8o6mGJAQ2u',symbol:'PRECISION',decimals:undefined};
 let now=100000,ready=false;
 const p=await page({initial:null,now:()=>now,route:dammRoute(path=>path.endsWith('/damm-pump/status')?{available:ready,publicEnabled:ready}:path.endsWith('/damm-pump/pairs')?{pairs:[{...pairs[0],launchReady:false},pairs[1],blocked,unknown,invalidPrecision]}:undefined)});t.after(()=>p.controller.destroy());await damm(p);
 for(let pass=0;pass<2;pass++){
  const sol=p.document.querySelector('[data-pair=SOL]');assert.equal(sol.disabled,true);p.document.querySelector('[data-pair=USDC]').onclick();assert.equal(p.$('launch-card-pair').dataset.mint,USDC_MINT);sol.onclick();assert.equal(p.$('launch-card-pair').dataset.mint,USDC_MINT);
  p.$('launch-asset-open').onclick();assert.equal(p.$('launch-asset-results').querySelectorAll('button').length,0);p.$('launch-asset-close').onclick();
  assert.equal(p.$('launch-open').disabled,!ready);ready=true;now+=60001;await p.catalogueTick();
 }
 assert(!p.calls.some(x=>x.path.endsWith('/damm-pump/prepare')));assert.equal(p.mock.calls.sign.length,0);
});
test('first buy uses SOL precision for non-SOL pairs and excludes legacy taxes and reward mode',async t=>{
 const p=await page({initial:null,route:dammRoute()});t.after(()=>p.controller.destroy());await p.connect();await damm(p);await p.fill();p.document.querySelector('[data-pair=USDC]').onclick();await p.open();p.$('launch-damm-pump-buy').value='1.234567891';p.$('launch-damm-pump-buy').oninput();await new Promise(resolve=>setTimeout(resolve,500));const calls=p.calls.filter(x=>x.path.endsWith('/damm-pump/prepare'));assert(calls.length);const input=calls.at(-1).body;assert.equal(input.firstBuySolLamports,'1234567891');assert.equal(input.amountRaw,undefined);assert.equal(input.quoteMint,USDC_MINT);assert.equal(p.$('launch-damm-pump-buy-symbol').textContent,'SOL');assert.match(p.$('launch-damm-pump-note').textContent,/automatically converts/);assert.match(p.$('launch-damm-pump-note').textContent,/0.0001 SOL/);assert.equal(input.taxBps,undefined);assert.equal(input.feeMode,undefined);assert.equal(p.mock.calls.sign.length,0);p.controller.destroy();
});
test('submitted DAMM launch recovers its saved operation without preparing a duplicate',async()=>{
 const saved={id:'damm-saved-123',action:'initialize',wallet:ADDRESS,mint,state:'submitted',review:{maxWalletDebitLamports:'20000000',firstBuyRaw:'0',quoteMint:SOL_MINT,quoteDecimals:9,quoteSymbol:'SOL'}};
 const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/operations')?{operations:[saved]}:path.endsWith('/damm-pump/reconcile')?{operation:{...saved,state:'finalized'}}:undefined)});await p.connect();await damm(p);await p.open();assert.match(p.$('launch-damm-pump-operation').textContent,/Your coin is live\. It will graduate to PumpSwap/);assert(!p.calls.some(x=>x.path.endsWith('/damm-pump/prepare')));assert.equal(p.mock.calls.sign.length,0);p.controller.destroy();
});

test('paid DAMM setup survives refresh and resumes its mint without requiring a new image',async()=>{
 const saved={id:'damm-configured-123',action:'configure',wallet:ADDRESS,mint,state:'finalized',review:{maxWalletDebitLamports:'20000000',setupRentLamports:'1000000',totalLaunchMaxDebitLamports:'30000000',firstBuyRaw:'0',quoteMint:SOL_MINT,quoteDecimals:9,quoteSymbol:'SOL'}};
 const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/operations')?{operations:[saved]}:undefined)});await p.connect();await damm(p);await p.open();const button=[...p.$('launch-damm-pump-operation').querySelectorAll('button')].find(x=>x.textContent==='Continue launch');assert(button&&!button.disabled);assert.match(p.$('launch-damm-pump-operation').textContent,/paid launch setup is ready/);assert(!p.calls.some(x=>x.path.endsWith('/damm-pump/prepare')));assert.equal(p.mock.calls.sign.length,0);p.controller.destroy();
});

test('saved SOL-funded launch restores SOL amount independently of quote decimals',async t=>{
 const saved={id:'damm-funded-123',action:'fund-quote',wallet:ADDRESS,mint,state:'finalized',nextAction:'initialize',review:{fundingMode:'sol',firstBuySolLamports:'1234567891',quoteFundingInLamports:'1234567891',quoteFundingMinRaw:'999999',maxWalletDebitLamports:'1240000000',firstBuyRaw:'999998',quoteMint:USDC_MINT,quoteDecimals:6,quoteSymbol:'USDC'}};
 const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/operations')?{operations:[saved]}:undefined)});t.after(()=>p.controller.destroy());await p.connect();await damm(p);p.document.querySelector('[data-pair=USDC]').onclick();await p.open();assert.equal(p.$('launch-damm-pump-buy').value,'1.234567891');assert.equal(p.$('launch-damm-pump-buy-symbol').textContent,'SOL');assert.equal(p.$('launch-damm-pump-buy').disabled,true);assert.match(p.$('launch-damm-pump-operation').textContent,/Your SOL conversion is confirmed/);assert(!p.calls.some(x=>x.path.endsWith('/damm-pump/prepare')));assert.equal(p.mock.calls.sign.length,0);
});
test('legacy paid launch retains its quote-denominated first buy when restored',async t=>{
 const saved={id:'damm-legacy-123',action:'configure',wallet:ADDRESS,mint,state:'finalized',review:{maxWalletDebitLamports:'20000000',firstBuyRaw:'1234567',quoteMint:USDC_MINT,quoteDecimals:6,quoteSymbol:'USDC'}};
 const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/operations')?{operations:[saved]}:undefined)});t.after(()=>p.controller.destroy());await p.connect();await damm(p);p.document.querySelector('[data-pair=USDC]').onclick();await p.open();assert.equal(p.$('launch-damm-pump-buy').value,'1.234567');assert.equal(p.$('launch-damm-pump-buy-symbol').textContent,'USDC');assert.equal(p.$('launch-damm-pump-buy').disabled,true);assert.match(p.$('launch-damm-pump-note').textContent,/saved launch.*1.234567 USDC/);assert(!p.calls.some(x=>x.path.endsWith('/damm-pump/prepare')));assert.equal(p.mock.calls.sign.length,0);
});

test('empty PumpSwap stock and pre-IPO categories show Coming Soon without inventing compatible pairs',async t=>{
 const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/pairs')?{pairs:pairs.slice(0,2)}:undefined)});t.after(()=>p.controller.destroy());await damm(p);p.$('launch-asset-open').onclick();for(const category of ['stocks','preipo']){const button=p.document.querySelector('[data-category='+category+']');assert.equal(button.hidden,false);button.onclick();assert.equal(p.$('launch-asset-results').querySelector('strong')?.textContent,'Coming Soon');assert.equal(p.$('launch-asset-results').querySelector('[role=status]')?.className,'launch-asset-empty');assert.equal(p.$('launch-asset-results').querySelectorAll('button').length,0);}
});
test('compatible PumpSwap category pairs remain selectable and search misses stay search misses',async t=>{
 const preipo={...pairs[2],mint:'7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',category:'preipo',symbol:'PRIVATE'};
 const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/pairs')?{pairs:[...pairs,preipo]}:undefined)});t.after(()=>p.controller.destroy());await damm(p);p.$('launch-asset-open').onclick();for(const category of ['stocks','preipo']){p.document.querySelector('[data-category='+category+']').onclick();assert.equal(p.$('launch-asset-results').querySelectorAll('button').length,1);assert.doesNotMatch(p.$('launch-asset-results').textContent,/Coming Soon/);}p.$('launch-asset-search').value='unmatched';p.$('launch-asset-search').oninput();assert.match(p.$('launch-asset-results').textContent,/No matching assets/);assert.doesNotMatch(p.$('launch-asset-results').textContent,/Coming Soon/);
});
test('PumpSwap category loading and failures do not masquerade as Coming Soon',async t=>{
 let resolve;const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/pairs')?new Promise(done=>resolve=done):undefined)});t.after(()=>p.controller.destroy());await damm(p);p.$('launch-asset-open').onclick();p.document.querySelector('[data-category=stocks]').onclick();assert.match(p.$('launch-asset-results').textContent,/Checking available pairs/);assert.doesNotMatch(p.$('launch-asset-results').textContent,/Coming Soon/);resolve({ok:false,status:503,body:{error:'RPC temporarily unavailable'}});await flush();await flush();assert.match(p.$('launch-asset-results').textContent,/temporarily unavailable/);assert.doesNotMatch(p.$('launch-asset-results').textContent,/Coming Soon/);
});

test('verified incompatible PumpSwap pairs stay visible under Coming Soon with their reason and cannot be selected',async t=>{
 const blocked={...pairs[2],launchReady:false,compatibilityVerified:true,comingSoon:true,availability:'coming-soon',supportReason:'This mint uses an unsupported transfer hook.'};const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/pairs')?{pairs:[...pairs.slice(0,2),blocked]}:undefined)});t.after(()=>p.controller.destroy());await damm(p);p.$('launch-asset-open').onclick();p.document.querySelector('[data-category=stocks]').onclick();assert.equal(p.$('launch-asset-results').querySelector('.launch-asset-empty strong').textContent,'Coming Soon');const row=p.$('launch-asset-results').querySelector('button');assert.equal(row.disabled,true);assert.match(row.textContent,/unsupported transfer hook/);const selected=p.$('launch-card-pair').dataset.mint;row.onclick();assert.equal(p.$('launch-card-pair').dataset.mint,selected);const tab=p.document.querySelector('[data-category=coming]');assert.equal(tab.hidden,false);tab.onclick();assert.equal(p.$('launch-asset-results').querySelectorAll('button').length,1);assert.equal(p.$('launch-asset-results').querySelector('button').disabled,true);
});
test('unverified PumpSwap mint checks are unavailable rather than Coming Soon',async t=>{
 const unknown={...pairs[2],launchReady:false,compatibilityVerified:false,comingSoon:false,availability:'unavailable',supportReason:'Pair verification is temporarily unavailable. Try again shortly.'};const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/pairs')?{pairs:[...pairs.slice(0,2),unknown]}:undefined)});t.after(()=>p.controller.destroy());await damm(p);p.$('launch-asset-open').onclick();p.document.querySelector('[data-category=stocks]').onclick();assert.doesNotMatch(p.$('launch-asset-results').textContent,/Coming Soon/);const row=p.$('launch-asset-results').querySelector('button');assert.equal(row.disabled,true);assert.match(row.textContent,/verification is temporarily unavailable/);assert.equal(p.document.querySelector('[data-category=coming]').hidden,true);
});

for(const stage of ['configure','fund-quote'])test('pending new controller allows saved '+stage+' continuation without a new mint or repeated conversion',async t=>{
 const review={maxWalletDebitLamports:'20000000',firstBuyRaw:'1234567',quoteMint:USDC_MINT,quoteDecimals:6,quoteSymbol:'USDC',...(stage==='fund-quote'?{fundingMode:'sol',firstBuySolLamports:'100000000',quoteFundingInLamports:'100000000',quoteFundingExpectedRaw:'1300000',quoteFundingMinRaw:'1234568',quoteFundingComplete:true}:{})};
 const saved={id:'legacy-paid-'+stage,action:stage,wallet:ADDRESS,mint,state:'finalized',nextAction:'initialize',review};
 const initialized={...saved,id:'legacy-initialize',action:'initialize',state:'awaiting_signature',expiresAt:Date.now()+120000,transaction:'AQID',review:{...review,configurationCreated:true}};
 const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/status')?{available:false,publicEnabled:false,blockers:['New controller setup is pending.']}:path.endsWith('/damm-pump/operations')?{operations:[saved]}:path.endsWith('/damm-pump/prepare')?{operation:initialized}:path.endsWith('/damm-pump/submit')?{operation:{...initialized,state:'finalized'}}:undefined)});t.after(()=>p.controller.destroy());
 await p.connect();await damm(p);assert.equal(p.$('launch-open').disabled,true);assert.equal(p.$('launch-damm-pump-resume').hidden,false);await p.$('launch-damm-pump-resume').onclick();
 assert.equal(p.$('launch-card-pair').dataset.mint,USDC_MINT);assert.equal(p.$('launch-open').disabled,true);const button=[...p.$('launch-damm-pump-operation').querySelectorAll('button')].find(x=>x.textContent==='Continue launch');assert(button&&!button.disabled);assert.equal(p.mock.calls.sign.length,0);
 await button.onclick();await flush();assert.match(p.$('launch-damm-pump-operation').textContent,/Your coin is live/);assert.equal(p.mock.calls.sign.length,1);assert.deepEqual(p.calls.filter(x=>x.path.endsWith('/damm-pump/prepare')).map(x=>x.body),[{action:'initialize',mint,expectedWallet:ADDRESS}]);assert.equal(p.$('launch-damm-pump-resume').hidden,true);assert.equal(p.$('launch-open').disabled,true);
});

test('pending new controller cannot recover a stranger, unsigned fresh draft or missing launch',async t=>{
 for(const candidate of [null,{wallet:OTHER,state:'finalized'},{wallet:ADDRESS,state:'awaiting_signature'}]){
  const saved=candidate?{id:'not-paid-operation',action:'configure',mint,review:{firstBuyRaw:'0',quoteMint:SOL_MINT,quoteDecimals:9},...candidate}:null;
  const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/status')?{available:false,publicEnabled:false,blockers:['New controller setup is pending.']}:path.endsWith('/damm-pump/operations')?{operations:saved?[saved]:[]}:undefined)});t.after(()=>p.controller.destroy());await p.connect();await damm(p);await p.fill();assert.equal(p.$('launch-open').disabled,true);assert.equal(p.$('launch-damm-pump-resume').hidden,true);await p.$('launch-damm-pump-resume').onclick();assert(!p.calls.some(x=>x.path.endsWith('/damm-pump/prepare')));assert.equal(p.mock.calls.sign.length,0);assert.match(p.$('launch-error').textContent,/New controller setup is pending/);
 }
});

test('saved recovery is checked again at click and cleared when the connected wallet changes',async t=>{
 const saved={id:'legacy-paid-stale',action:'configure',wallet:ADDRESS,mint,state:'finalized',review:{firstBuyRaw:'0',quoteMint:SOL_MINT,quoteDecimals:9}};let present=true;
 const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/status')?{available:false,publicEnabled:false,blockers:['New controller setup is pending.']}:path.endsWith('/damm-pump/operations')?{operations:present?[saved]:[]}:undefined)});t.after(()=>p.controller.destroy());await p.connect();await damm(p);assert.equal(p.$('launch-damm-pump-resume').hidden,false);present=false;await p.$('launch-damm-pump-resume').onclick();assert.equal(p.$('launch-damm-pump-dialog').open,false);assert.equal(p.$('launch-damm-pump-resume').hidden,true);assert(!p.calls.some(x=>x.path.endsWith('/damm-pump/prepare')));p.mock.change([]);await flush();assert.equal(p.$('launch-damm-pump-resume').hidden,true);assert.equal(p.mock.calls.sign.length,0);
});

test('public launch restores native account preparation while the new controller is pending',async t=>{
 const review={maxWalletDebitLamports:'2044280',firstBuyRaw:'10000000',firstBuySolLamports:'10000000',fundingMode:'sol',configurationCreated:true,quoteMint:SOL_MINT,quoteDecimals:9,quoteSymbol:'SOL'},saved={id:'native-preparation-done',action:'prepare-buy',wallet:ADDRESS,mint,state:'finalized',nextAction:'initialize',review};
 const initialized={...saved,id:'native-initialize-saved',action:'initialize',state:'awaiting_signature',expiresAt:Date.now()+120000,transaction:'AQID'};
 const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/status')?{available:false,publicEnabled:false,blockers:['New controller setup is pending.']}:path.endsWith('/damm-pump/operations')?{operations:[saved]}:path.endsWith('/damm-pump/prepare')?{operation:initialized}:path.endsWith('/damm-pump/submit')?{operation:{...initialized,state:'finalized'}}:undefined)});t.after(()=>p.controller.destroy());await p.connect();await damm(p);assert.equal(p.$('launch-damm-pump-resume').hidden,false);await p.$('launch-damm-pump-resume').onclick();assert.equal(p.$('launch-damm-pump-buy').value,'0.01');assert.equal(p.$('launch-damm-pump-buy').disabled,true);assert.match(p.$('launch-damm-pump-operation').textContent,/launch account setup is confirmed/);const button=[...p.$('launch-damm-pump-operation').querySelectorAll('button')].find(row=>row.textContent==='Continue launch');await button.onclick();await flush();assert.match(p.$('launch-damm-pump-operation').textContent,/Your coin is live/);assert.equal(p.mock.calls.sign.length,1);assert.deepEqual(p.calls.filter(row=>row.path.endsWith('/damm-pump/prepare')).map(row=>row.body),[{action:'initialize',mint,expectedWallet:ADDRESS}]);
});
test('public paid draft can explicitly start another launch and does not restore the old draft on reopen',async t=>{
 const saved={id:'oversized-native-draft',action:'configure',wallet:ADDRESS,mint,state:'finalized',nextAction:'initialize',review:{maxWalletDebitLamports:'2000000',firstBuyRaw:'410000000',firstBuySolLamports:'410000000',fundingMode:'sol',quoteMint:SOL_MINT,quoteDecimals:9,quoteSymbol:'SOL'}};
 const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/operations')?{operations:[saved]}:undefined)});t.after(()=>p.controller.destroy());await p.connect();await damm(p);await p.fill();await p.open();assert.equal(p.$('launch-damm-pump-buy').value,'0.41');const start=[...p.$('launch-damm-pump-operation').querySelectorAll('button')].find(row=>row.textContent==='Start another launch');assert.equal(start.hidden,false);const before=p.calls.length;start.onclick();assert.equal(p.calls.length,before);assert.equal(p.$('launch-damm-pump-buy').disabled,false);p.$('launch-damm-pump-buy').value='0.01';await p.$('launch-damm-pump-close').onclick();await p.open();assert.equal(p.$('launch-damm-pump-buy').value,'0.01');assert.equal(p.$('launch-damm-pump-buy').disabled,false);assert.equal(saved.review.firstBuySolLamports,'410000000');const fresh=p.calls.filter(row=>row.path.endsWith('/damm-pump/prepare')).at(-1)?.body;assert.equal(fresh?.mint,undefined);assert.equal(fresh?.firstBuySolLamports,'10000000');assert.equal(p.mock.calls.sign.length,0);
});

test('public launch API carries RPC cooldown to confirmation polling without another approval',async t=>{
 let now=100000,tick,receipts=0;const saved={id:'damm-cooldown-123',action:'initialize',wallet:ADDRESS,mint,state:'submitted',review:{maxWalletDebitLamports:'20000000',firstBuyRaw:'0',quoteMint:SOL_MINT,quoteDecimals:9,quoteSymbol:'SOL'}};
 const p=await page({initial:null,now:()=>now,dammOptions:{clock:()=>now,setTimer:fn=>{tick=fn;return 1;},clearTimer:()=>{}},route:dammRoute(path=>path.endsWith('/damm-pump/operations')?{operations:[saved]}:path.endsWith('/damm-pump/reconcile')?(++receipts===1?{ok:false,status:503,body:{error:'RPC capacity is busy',code:'DAMM_RPC_BUSY',retryAfterMs:60000}}:{operation:{...saved,state:'finalized'}}):undefined)});t.after(()=>p.controller.destroy());
 await p.connect();await damm(p);await p.open();assert.equal(receipts,1);assert.equal(p.$('launch-damm-pump-operation').querySelector('.meteora-operation-status').classList.contains('negative'),false);
 now+=30000;tick();await flush();assert.equal(receipts,1);now+=30000;tick();await flush();assert.equal(receipts,2);assert.match(p.$('launch-damm-pump-operation').textContent,/Your coin is live/);assert.equal(p.mock.calls.sign.length,0);assert(!p.calls.some(x=>x.path.endsWith('/damm-pump/prepare')||x.path.endsWith('/damm-pump/submit')));
});

test('the Pump.fun button replaces the Meteora → PumpSwap button and route text; the saved-launch link still resumes',async t=>{
 const p=await page({initial:null,href:'http://app.local/launchpad',route:dammRoute()});t.after(()=>p.controller.destroy());
 const buttons=[...p.document.querySelectorAll('[data-launch-venue]')];assert.deepEqual(buttons.map(b=>b.dataset.launchVenue),['pump-classic','raydium','meteora']);
 assert.equal(venue(p,'pump-classic').textContent,'Pump.fun');assert.equal(venue(p,'pump-classic').querySelector('[data-launch-route]'),null);
 assert.doesNotMatch(p.document.querySelector('.launch-mode-select').innerHTML,/Meteora → PumpSwap/);
 assert.equal(p.document.querySelector('.launch-venue').textContent,'Powered by Raydium');assert(!p.calls.some(x=>x.path.endsWith('/damm-pump/pairs')));
});

test('a closed PumpSwap venue offers no pair as available and its SOL note does not convert SOL to SOL',async t=>{
  const p=await page({initial:null,route:dammRoute(path=>path.endsWith('/damm-pump/status')?{available:false,publicEnabled:false,blockers:['PumpSwap launch setup is not complete yet.']}:undefined)});t.after(()=>p.controller.destroy());await damm(p);
  p.document.querySelector('[data-pair=SOL]').onclick();
  assert.match(p.$('launch-pair-note').textContent,/Your first buy and the pool seed use SOL\./);assert.doesNotMatch(p.$('launch-pair-note').textContent,/converts it to SOL/);
  assert.match(p.$('launch-asset-count').textContent,/^PumpSwap · 3 pairs compatible · new launches are closed/);assert.equal(p.$('launch-card-buy').textContent,'None');
  p.$('launch-asset-open').onclick();const labels=[...p.$('launch-asset-results').querySelectorAll('button')].map(b=>b.lastElementChild.textContent);
  assert.deepEqual(labels,['Compatible']);assert.equal(p.document.querySelector('[data-category=crypto]').hidden,true,'Crypto lists only the SOL and USDC shortcuts here');
});
