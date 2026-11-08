import {optimizeLaunchImage} from '../public/launch-image.mjs';
import {createChainSelect,initialLaunchChain,launchChainById} from '../public/launch-chains.mjs';
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
async function page({initial=launch(),mock=mockWallet(),route,imageBitmap,href='http://app.local/launchpad',features={walletOnly:false},now=Date.now}={}){
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
  const source=(await readFile(new URL('../public/launchpad.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'').replace("await import('./pump-launch-test-ui.mjs')",'pumpUiModule').replace("await import('./pump-public-ui.mjs')",'pumpPublicUiModule').replace("await import('./meteora-ui.mjs')",'meteoraUiModule').replace(/bootPage\('launchpad',mountPage\);/,'')+'\nconst pageController=mountPage({document,window:document.defaultView});await pageController.ready;return pageController;';
  const deps={createChainSelect,initialLaunchChain,launchChainById,optimizeLaunchImage,meteoraUiModule,pumpUiModule,pumpPublicUiModule,Date:ClockDate,createQuoteIcon,createQuoteLabel,CREATOR_FEE_TIERS,creatorFeeForLaunch,document,fetch,FileReader,createImageBitmap:imageBitmap||(async()=>({width:8,height:8,close(){}})),crypto:{randomUUID},FormData,requestAnimationFrame:fn=>{setTimeout(fn,0);return 1;},setInterval:(fn,ms)=>{intervals.set(ms,fn);if(ms===8000)poll=fn;return ms;},setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,10)),matchMedia:()=>({matches:true}),createWorkspaceShell:()=>{},launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink,LAUNCH_ASSETS,createLaunchpadWallet};
  const controller=await new (Object.getPrototypeOf(async()=>{}).constructor)(...Object.keys(deps),source)(...Object.values(deps));await flush();
  const $=id=>document.getElementById(id);
  return{controller,document,window,form,$,calls,mock,async catalogueTick(){await intervals.get(60000)?.();await flush();},setRecord(value){record=value;},async image(){Object.defineProperty($('launch-image'),'files',{value:[{type:'image/png',size:30}],configurable:true});await $('launch-image').onchange();},poll:async()=>{await poll();await flush();},chooseLaunch(){document.querySelector('#launch-list button').onclick();},async fill(){form.elements.namedItem('name').value='Example';form.elements.namedItem('symbol').value='EXAMPLE';await this.image();},async open(){ $('launch-open').onclick();await flush();await flush();},async connect(){$('launch-connect').onclick();document.querySelector('#launch-wallet-options button').onclick();await flush();}};
}

const venue=(p,name)=>p.document.querySelector('[data-launch-venue='+name+']');
const mint='GNu1FSuype33KF4RXfow38Dw3ziw9e71FTBLVY5mdrTa';
const pairs=[{mint:SOL_MINT,symbol:'SOL',name:'Solana',decimals:9,category:'crypto',launchReady:true,supported:true},{mint:USDC_MINT,symbol:'USDC',name:'USD Coin',decimals:6,category:'crypto',launchReady:true,supported:true},{mint,symbol:'STOCK',name:'Stock test',decimals:6,category:'stocks',launchReady:true,supported:false}];
const route=(extra=()=>undefined)=>async(path,body,state)=>{const custom=await extra(path,body,state);if(custom)return custom;if(path==='/api/session')return{authenticated:true,token:'public-csrf',features:{walletOnly:true},account:{id:'public-user',authType:'wallet',mainWallet:ADDRESS}};if(path==='/api/launchpad/meteora/status')return{available:true,publicEnabled:true};if(path==='/api/launchpad/meteora/pairs')return{pairs};if(path==='/api/launchpad/meteora/operations')return{operations:[]};};
async function meteora(p){venue(p,'meteora').onclick();await flush();await flush();}
test('Meteora replaces new Pump launches, supports reward modes and restores Raydium tax settings',async()=>{
 const p=await page({initial:null,route:route()});assert.equal(venue(p,'pumpswap'),null);assert(venue(p,'meteora'));for(const radio of p.form.querySelectorAll('[name=feeMode]'))radio.checked=radio.value==='holders';p.form.elements.namedItem('taxPercent').value='3';p.form.dispatchEvent(new p.window.Event('change'));
 await meteora(p);assert.equal(p.$('launch-reward-options').hidden,false);assert.equal(p.form.elements.namedItem('taxPercent').disabled,true);assert.equal(p.$('launch-tax-label').hidden,true);const radios=[...p.form.querySelectorAll('[name=feeMode]')],pumpOnly=r=>['market_maker','lp_manager','diamond_hands','earned','insured'].includes(r.value);assert(radios.filter(r=>!pumpOnly(r)).every(r=>!r.disabled));assert.equal(radios.filter(pumpOnly).length,5);assert(radios.filter(pumpOnly).every(r=>r.disabled&&r.closest('label').hidden),'Market Maker, Liquidity Manager, Diamond Hands, Earned and Insured are Pump.fun-only');assert.match(p.$('launch-fee-note').textContent,/no transfer tax/);assert.equal(p.$('launch-card-fdv').textContent,'$20,000');assert.match(p.$('launch-curve-summary').textContent,/\$50,000/);assert.equal(p.$('launch-open').textContent,'Launch →');assert(!p.calls.some(x=>x.path.startsWith('/api/admin/pump-test')||/^\/api\/launchpad\/pump(\/|$)/.test(x.path)),'the retired PumpSwap test and public endpoints are never called');
 venue(p,'raydium').onclick();await flush();assert.equal(p.form.elements.namedItem('taxPercent').value,'3');assert.equal(p.form.elements.namedItem('taxPercent').disabled,false);assert.equal(p.$('launch-tax-label').hidden,false);p.controller.destroy();
});
test('Meteora catalogue offers only verified pairs even if Raydium support differs',async()=>{
 const p=await page({initial:null,route:route(path=>path.endsWith('/meteora/pairs')?{pairs:[...pairs,{mint:'HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF',symbol:'WAIT',decimals:9,launchReady:false}]}:undefined)});await meteora(p);p.$('launch-asset-open').onclick();assert.equal(p.$('launch-asset-count').textContent,'Meteora · 3 pairs available · Includes SOL and USDC');assert.equal(p.document.querySelector('[data-category=coming]').hidden,true);const buttons=[...p.$('launch-asset-results').querySelectorAll('button')];assert.equal(buttons.length,1);assert.equal(buttons[0].dataset.mint,mint);assert.equal(buttons[0].disabled,false);buttons[0].onclick();assert.match(p.$('launch-pair-note').textContent,/wallet needs STOCK/);p.controller.destroy();
});
test('disabled or malformed status keeps Meteora launch blocked with clear activation message',async()=>{
 for(const status of [{available:false,publicEnabled:false,blockers:['Configure the migration payer first.']},{available:true,publicEnabled:false},{publicEnabled:true}]){const p=await page({initial:null,route:route(path=>path.endsWith('/meteora/status')?status:undefined)});await meteora(p);assert.equal(p.$('launch-open').disabled,true);assert.equal(p.$('launch-open').textContent,'Meteora unavailable');assert.equal(p.$('launch-meteora-availability').hidden,false);assert(!p.calls.some(x=>x.path.endsWith('/prepare')));p.controller.destroy();}
});
test('owner preview is clearly labelled and does not expose Pump test controls',async()=>{
 const p=await page({initial:null,route:route(path=>path.endsWith('/meteora/status')?{available:true,publicEnabled:false,ownerPreview:true}:undefined)});await meteora(p);assert.match(p.$('launch-meteora-availability').textContent,/Owner preview. Public Meteora launches are closed/);assert.equal(p.$('launch-pump-test').hidden,true);p.controller.destroy();
});
test('late Meteora pairs cannot overwrite Raydium catalogue after switching venues',async()=>{
 let resolve;const pending=new Promise(r=>resolve=r),p=await page({initial:null,route:route(path=>path.endsWith('/meteora/pairs')?pending:undefined)});venue(p,'meteora').onclick();await flush();venue(p,'raydium').onclick();resolve({pairs});await flush();await flush();assert.equal(p.$('launch-card-pair').dataset.mint,SOL_MINT);assert(!p.$('launch-asset-count').textContent.includes('Meteora'));assert.equal(p.$('launch-meteora-target').hidden,true);p.controller.destroy();
});
test('stock launch first buy is atomic quote amount and does not enter Raydium preparation',async()=>{
 const p=await page({initial:null,route:route((path,body)=>path.endsWith('/meteora/prepare')?{operation:{id:'meteora-operation-123',action:'configure',wallet:ADDRESS,mint,state:'awaiting_signature',transaction:'AQID',expiresAt:Date.now()+120000,review:{maxWalletDebitLamports:'20000000',firstBuyRaw:body.amountRaw,quoteMint:body.quoteMint,quoteSymbol:'STOCK',quoteDecimals:6}}}:undefined)});await p.connect();await p.fill();await meteora(p);p.$('launch-asset-open').onclick();p.$('launch-asset-results').querySelector('button').onclick();p.$('launch-meteora-buy').value='1.234567';await p.open();await flush();const request=p.calls.find(x=>x.path.endsWith('/meteora/prepare'));assert.equal(request.body.amountRaw,'1234567');assert.equal(request.body.quoteMint,mint);assert.equal(request.body.feeMode,'creator');assert.equal(request.body.image,'/token-images/'+'a'.repeat(64)+'.webp');assert.equal(request.body.taxPercent,undefined);assert.match(p.$('launch-meteora-operation').textContent,/1.234567 STOCK/);assert.equal(p.mock.calls.sign.length,0);assert(!p.calls.some(x=>x.path==='/api/launchpad/prepare'));p.controller.destroy();
});

test('after reload a paid configuration resumes before requiring new image or form input',async()=>{
 const saved={id:'saved-operation-123',action:'configure',wallet:ADDRESS,mint,state:'finalized',review:{maxWalletDebitLamports:'20000000',firstBuyRaw:'0',quoteMint:SOL_MINT,quoteDecimals:9,quoteSymbol:'SOL'}};
 const p=await page({initial:null,route:route(path=>path.endsWith('/meteora/operations')?{operations:[saved]}:undefined)});await p.connect();await meteora(p);await p.open();assert.equal(p.$('launch-meteora-dialog').open,true);const button=[...p.$('launch-meteora-operation').querySelectorAll('button')].find(x=>x.textContent==='Continue launch');assert(button);assert.equal(button.disabled,false);assert(!p.calls.some(x=>x.path.endsWith('/prepare')));p.controller.destroy();
});

test('selecting Meteora rechecks a recently disabled status without reloading the page',async()=>{
 let enabled=false,statusCalls=0;
 const p=await page({initial:null,route:route(path=>{if(path.endsWith('/meteora/status')){statusCalls++;return{available:enabled,publicEnabled:enabled};}})});
 assert.equal(statusCalls,1);enabled=true;await meteora(p);
 assert.equal(statusCalls,2,'venue selection refreshes even a status checked less than a minute ago');
 assert.equal(p.$('launch-open').disabled,false);assert.equal(p.$('launch-open').textContent,'Launch →');
 p.controller.destroy();
});

test('Meteora status and pair refresh follow focus, visibility and the minute timer without duplicate reads',async()=>{
 let now=Date.now(),enabled=true,statusCalls=0,pairCalls=0,rows=pairs,releaseStatus=null;
 const p=await page({initial:null,now:()=>now,route:route(path=>{
  if(path.endsWith('/meteora/status')){statusCalls++;if(releaseStatus===true)return new Promise(resolve=>{releaseStatus=resolve;});return{available:enabled,publicEnabled:enabled};}
  if(path.endsWith('/meteora/pairs')){pairCalls++;return{pairs:rows};}
 })});await meteora(p);const initialStatusCalls=statusCalls,initialPairCalls=pairCalls;
 p.window.dispatchEvent(new p.window.Event('focus'));await flush();
 assert.equal(statusCalls,initialStatusCalls,'fresh focus shares the existing status');assert.equal(pairCalls,initialPairCalls);
 Object.defineProperty(p.document,'hidden',{value:true,writable:true,configurable:true});now+=60000;
 await p.catalogueTick();p.window.dispatchEvent(new p.window.Event('focus'));await flush();
 assert.equal(statusCalls,initialStatusCalls,'hidden pages do not refresh');assert.equal(pairCalls,initialPairCalls);
 enabled=false;rows=[pairs[0],pairs[2]];releaseStatus=true;p.document.hidden=false;
 p.document.dispatchEvent(new p.window.Event('visibilitychange'));p.window.dispatchEvent(new p.window.Event('focus'));
 const tick=p.catalogueTick();await flush();assert.equal(statusCalls,initialStatusCalls+1,'visible, focus and minute events share one pending status read');
 assert.equal(pairCalls,initialPairCalls+1,'pair reads are also coalesced');
 releaseStatus({available:false,publicEnabled:false});releaseStatus=null;await tick;await flush();
 assert.equal(p.$('launch-open').disabled,true);assert.equal(p.$('launch-open').textContent,'Meteora unavailable');
 assert.equal(p.$('launch-asset-count').textContent,'Meteora · 2 pairs available · Includes SOL');
 enabled=true;now+=60000;p.window.dispatchEvent(new p.window.Event('focus'));await flush();await flush();
 assert.equal(statusCalls,initialStatusCalls+2,'a stale focus refreshes status');assert.equal(pairCalls,initialPairCalls+2);
 assert.equal(p.$('launch-open').disabled,false);
 enabled=false;now+=60000;await p.catalogueTick();assert.equal(statusCalls,initialStatusCalls+3);assert.equal(p.$('launch-open').disabled,true);
 p.controller.destroy();now+=60000;p.window.dispatchEvent(new p.window.Event('focus'));p.document.dispatchEvent(new p.window.Event('visibilitychange'));await p.catalogueTick();
 assert.equal(statusCalls,initialStatusCalls+3,'destroy removes all refresh triggers');assert.equal(pairCalls,initialPairCalls+3);
});

test('Meteora availability refresh preserves the saved configuration and its controller',async()=>{
 let now=Date.now(),enabled=true,rows=pairs;
 const saved={id:'saved-operation-123',action:'configure',wallet:ADDRESS,mint,state:'finalized',review:{maxWalletDebitLamports:'20000000',firstBuyRaw:'1234567',quoteMint:USDC_MINT,quoteDecimals:6,quoteSymbol:'USDC'}};
 const p=await page({initial:null,now:()=>now,route:route(path=>path.endsWith('/meteora/operations')?{operations:[saved]}:path.endsWith('/meteora/status')?{available:enabled,publicEnabled:enabled}:path.endsWith('/meteora/pairs')?{pairs:rows}:undefined)});
 await p.connect();await meteora(p);p.document.querySelector('[data-pair=USDC]').onclick();await p.open();
 const root=p.$('launch-meteora-operation'),button=[...root.querySelectorAll('button')].find(x=>x.textContent==='Continue launch');
 assert(button);assert.equal(p.$('launch-meteora-buy').value,'1.234567');
 const before=root.textContent;enabled=false;rows=[pairs[0],pairs[2]];now+=60000;await p.catalogueTick();
 assert.equal(p.$('launch-meteora-dialog').open,true);assert.equal(p.$('launch-card-pair').dataset.mint,USDC_MINT);
 assert.strictEqual([...root.querySelectorAll('button')].find(x=>x.textContent==='Continue launch'),button,'status changes retain the operation controller');
 assert.equal(root.textContent,before);assert.equal(p.$('launch-meteora-buy').value,'1.234567');
 enabled=true;rows=pairs;now+=60000;p.window.dispatchEvent(new p.window.Event('focus'));await flush();await flush();
 assert.strictEqual([...root.querySelectorAll('button')].find(x=>x.textContent==='Continue launch'),button);
 assert.equal(p.$('launch-meteora-buy').value,'1.234567');assert.equal(p.$('launch-meteora-buy').disabled,true);
 assert.equal(p.calls.filter(x=>x.path.endsWith('/meteora/operations')).length,1);assert(!p.calls.some(x=>x.path.endsWith('/prepare')));
 assert.equal(p.mock.calls.sign.length,0);p.controller.destroy();
});

// v71.25 regressions.
const until=async(check,message)=>{for(let n=0;n<100;n++){if(check())return;await flush();}assert.fail(message);};
test('Your coins lists Meteora and PumpSwap coins; a row of another venue switches to it and opens its launch',async t=>{
  const [LIVE,SETUP,DRAFT,HIDDEN,DAMM]=['HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF','7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS','9sNtafymXt6ENpr8Z7zhxTMq752AMdkXLq8o6mGJAQ2u','J8WRhbSjG3NbcfRWKmVY5fqnETZZfyUR1zrt5QmM9gQP',mint];
  const coin=(platform,symbol,status,address,extra={})=>({platform,mint:address,symbol,name:symbol+' coin',status,image:'/token-images/'+'b'.repeat(64)+'.png',quoteMint:USDC_MINT,quoteSymbol:'USDC',quoteDecimals:6,hidden:false,archived:false,...extra});
  const saved={id:'saved-operation-123',action:'configure',wallet:ADDRESS,mint:SETUP,state:'finalized',review:{maxWalletDebitLamports:'20000000',firstBuyRaw:'1234567',quoteMint:USDC_MINT,quoteDecimals:6,quoteSymbol:'USDC'}};
  const p=await page({route:route(path=>path==='/api/launchpad/meteora/launches'?[coin('meteora','METLIVE','trading',LIVE),coin('meteora','METSETUP','configured',SETUP),coin('meteora','METDRAFT','draft',DRAFT),coin('meteora','METHIDDEN','trading',HIDDEN,{hidden:true})]:path==='/api/launchpad/damm-pump/launches'?{launches:[coin('damm-pump','TRCTR','trading',DAMM)]}:path==='/api/launchpad/meteora/operations'?{operations:[saved]}:undefined)});t.after(()=>p.controller.destroy());
  await until(()=>/TRCTR/.test(p.$('launch-list').textContent),'venue coins were not listed');
  const row=symbol=>[...p.$('launch-list').querySelectorAll('.launch-history-row')].find(r=>r.querySelector('strong').textContent===symbol);
  assert.equal(row('METLIVE').getAttribute('href'),'/coin?mint='+LIVE);assert.match(row('METLIVE').textContent,/Live · Meteora$/);
  assert.equal(row('TRCTR').getAttribute('href'),'/coin?mint='+DAMM);assert.match(row('TRCTR').textContent,/Live · PumpSwap$/);
  assert.equal(row('METSETUP').tagName,'BUTTON');assert.match(row('METSETUP').textContent,/Meteora · Launch pending$/);assert.equal(row('METDRAFT'),undefined);assert.equal(row('METHIDDEN'),undefined);
  // A Raydium row while Meteora is open switches back to Raydium and opens that launch.
  await meteora(p);row('EXAMPLE').onclick();await flush();
  assert.equal(p.document.querySelector('.launch-venue').textContent,'Powered by Raydium');assert.equal(p.$('launch-buy-dialog').open,true);assert.equal(p.$('launch-buy-dialog').dataset.existing,'true');assert.equal(p.$('launch-error').hidden,true);
  p.$('launch-buy-close').onclick();
  // A saved Meteora setup switches to Meteora and its pair, and resumes there.
  await p.connect();row('METSETUP').onclick();await until(()=>p.$('launch-meteora-dialog').open,'the saved setup did not open');await flush();
  assert.equal(p.document.querySelector('.launch-venue').textContent,'Powered by Meteora');assert.equal(p.$('launch-card-pair').dataset.mint,USDC_MINT);
  assert([...p.$('launch-meteora-operation').querySelectorAll('button')].some(b=>b.textContent==='Continue launch'&&!b.hidden));assert.equal(p.mock.calls.sign.length,0);
});
test('switching to Meteora and back reuses the Raydium pair list; it is read again only on its longer interval',async t=>{
  let now=Date.now();const p=await page({initial:null,now:()=>now,route:route()});t.after(()=>p.controller.destroy());
  const quotes=()=>p.calls.filter(c=>c.path.endsWith('/quotes')).length,first=quotes();assert.equal(first,1);
  for(let pass=0;pass<2;pass++){await meteora(p);venue(p,'raydium').onclick();await flush();now+=90000;}
  await p.catalogueTick();assert.equal(quotes(),first,'no new read within five minutes of the last one');
  now+=300000;await p.catalogueTick();assert.equal(quotes(),first+1,'the background read runs every five minutes');
  now+=60000;p.$('launch-asset-open').onclick();await flush();assert.equal(quotes(),first+2,'an open pair picker still reads a minute-old list again');
});
test('Meteora gets coin text it accepts: trimmed one-line text, @handles as links, and field-specific messages',async t=>{
  const p=await page({initial:null,route:route()});t.after(()=>p.controller.destroy());
  await p.connect();await meteora(p);await p.fill();assert.equal(p.$('launch-card-buy').textContent,'None','no first buy reads None, as on the other venues');
  p.form.elements.namedItem('name').value='Café Ünïcödé Rocket Club 🚀';await p.open();
  assert.match(p.$('launch-meteora-note').textContent,/The coin name is too long\. Use at most 32 characters; emoji and accented letters count as 2 to 4 each\./);
  assert(!p.calls.some(c=>c.path.endsWith('/meteora/prepare')));p.$('launch-meteora-close').onclick();await flush();
  p.form.elements.namedItem('name').value=' Rocket Club ';p.form.elements.namedItem('description').value='First line.\nSecond line. ';p.form.elements.namedItem('twitter').value='@examplecoin';p.form.elements.namedItem('website').value='examplecoin';
  await p.open();assert.match(p.$('launch-meteora-note').textContent,/Enter the website as an https:\/\/ address with a domain/);assert(!p.calls.some(c=>c.path.endsWith('/meteora/prepare')));p.$('launch-meteora-close').onclick();await flush();
  p.form.elements.namedItem('website').value='examplecoin.com';await p.open();await until(()=>p.calls.some(c=>c.path.endsWith('/meteora/prepare')),'the launch was not prepared');
  const body=p.calls.find(c=>c.path.endsWith('/meteora/prepare')).body;
  assert.deepEqual([body.name,body.symbol,body.description,body.twitter,body.website,body.telegram],['Rocket Club','EXAMPLE','First line. Second line.','https://x.com/examplecoin','https://examplecoin.com/','']);
});
