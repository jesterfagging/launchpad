import {optimizeLaunchImage} from '../public/launch-image.mjs';
import {createChainSelect,initialLaunchChain,launchChainById} from '../public/launch-chains.mjs';
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
async function page({initial=launch(),mock=mockWallet(),route,imageBitmap,href='http://app.local/launchpad',features={walletOnly:false},now=Date.now,requestTimeoutMs=60000,walletTimeoutMs=120000}={}){
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
  const fetch=async(path,options={})=>{const body=options.body?JSON.parse(options.body):undefined;calls.push({path,body});const data=await route?.(path,body,{get record(){return record;},set record(value){record=value;}});if(data?.rawResponse)return data.rawResponse;if(data)return{ok:data.ok!==false,status:data.status||200,json:async()=>data.body??data};return{ok:true,status:200,json:async()=>path==='/api/session'?{authenticated:true,token:'csrf',features,account:{}}:path.endsWith('/quotes')?{assets:LAUNCH_ASSETS.map(a=>({...a,supported:true})),canViewComingSoon:false}:path.endsWith('/image')?{imageId:'a'.repeat(64)+'.webp'}:path.endsWith('/prepare')?{...launch('draft',body.walletMode),prepareId:'prepared-1',review:{...launch().review,minimumSol:'0.03',devBuy:{gross:'100000000',net:'97000000',solBudget:units(String(body.devBuySol||0).replace(/^\./,'0.')).toString()}}}:path.endsWith('/create')?(record=launch('draft',body.walletMode)):path.endsWith('/action')?(record=record.walletMode==='default'?launch('live','default'):launch()):path.endsWith('/review')?(record=launch('draft',record.walletMode)):path.endsWith('/signature')?record:path.endsWith('/sign')?(record={...record,state:'live',pendingSignature:null}):{developerWallet:OTHER,launches:record?[record]:[]}};};
  window.addEventListener('wallet-standard:app-ready',event=>event.detail.register(mock.wallet));
  const source=(await readFile(new URL('../public/launchpad.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'').replace(/bootPage\('launchpad',mountPage\);/,'')+'\nconst pageController=mountPage({document,window:document.defaultView,requestTimeoutMs,walletTimeoutMs});await pageController.ready;return pageController;';
  const deps={createChainSelect,initialLaunchChain,launchChainById,optimizeLaunchImage,requestTimeoutMs,walletTimeoutMs,Date:ClockDate,createQuoteIcon,createQuoteLabel,CREATOR_FEE_TIERS,creatorFeeForLaunch,document,fetch,FileReader,createImageBitmap:imageBitmap||(async()=>({width:8,height:8,close(){}})),crypto:{randomUUID},FormData,requestAnimationFrame:fn=>{setTimeout(fn,0);return 1;},setInterval:(fn,ms)=>{intervals.set(ms,fn);if(ms===8000)poll=fn;return ms;},setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,10)),matchMedia:()=>({matches:true}),createWorkspaceShell:()=>{},launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink,LAUNCH_ASSETS,createLaunchpadWallet};
  const controller=await new (Object.getPrototypeOf(async()=>{}).constructor)(...Object.keys(deps),source)(...Object.values(deps));await flush();
  const $=id=>document.getElementById(id);
  return{controller,document,window,form,$,calls,mock,async catalogueTick(){await intervals.get(60000)?.();await flush();},setRecord(value){record=value;},async image(){Object.defineProperty($('launch-image'),'files',{value:[{type:'image/png',size:30}],configurable:true});await $('launch-image').onchange();},poll:async()=>{await poll();await flush();},chooseLaunch(){document.querySelector('#launch-list button').onclick();},async fill(){form.elements.namedItem('name').value='Example';form.elements.namedItem('symbol').value='EXAMPLE';await this.image();},async open(){ $('launch-open').onclick();await flush();await flush();},async connect(){$('launch-connect').onclick();document.querySelector('#launch-wallet-options button').onclick();await flush();}};
}
test('Stop unlocks a stalled signature refresh and a late response cannot disturb the resumed launch',async()=>{
  let finishRefresh,finishSign,refreshes=0;const mock=mockWallet();mock.wallet.features[SIGN].signTransaction=input=>{mock.calls.sign.push(input);return new Promise(resolve=>{finishSign=resolve;});};
  const p=await page({mock,route:path=>path.endsWith('/signature')&&++refreshes===1?new Promise(resolve=>{finishRefresh=resolve;}):undefined});await p.connect();p.chooseLaunch();const first=p.$('launch-retry').onclick();await flush();
  assert.match(p.$('launch-status-message').textContent,/Refreshing the wallet request/);assert.equal(mock.calls.sign.length,0);p.$('launch-stop').onclick();await first;
  assert.equal(p.$('launch-retry').disabled,false);assert.equal(p.controller.canLeave(),true);
  const resumed=p.$('launch-retry').onclick();await flush();assert.equal(mock.calls.sign.length,1);finishRefresh({...launch(),pendingSignature:{...pending(),operationId:'stale-operation'}});await flush();
  assert.equal(p.$('launch-stop').hidden,false);assert.match(p.$('launch-status-message').textContent,/Approve the transaction/);assert.equal(p.calls.filter(x=>x.path.endsWith('/sign')).length,0);
  finishSign([{signedTransaction:new Uint8Array([4,5,6])}]);await resumed;assert.equal(p.calls.filter(x=>x.path.endsWith('/sign')).length,1);assert.equal(p.calls.find(x=>x.path.endsWith('/sign')).body.operationId,'operation-1');assert(!p.calls.some(x=>x.path.endsWith('/create')));p.controller.destroy();
});
test('Stop releases an unresolved wallet approval and ignores its late signature after Resume',async()=>{
  const finishes=[],mock=mockWallet();mock.wallet.features[SIGN].signTransaction=input=>{mock.calls.sign.push(input);return new Promise(resolve=>finishes.push(resolve));};const p=await page({mock});await p.connect();p.chooseLaunch();
  const first=p.$('launch-retry').onclick();await flush();assert.equal(finishes.length,1);p.$('launch-stop').onclick();await first;assert.equal(p.$('launch-retry').disabled,false);
  const second=p.$('launch-retry').onclick();await flush();assert.equal(finishes.length,2);finishes[0]([{signedTransaction:new Uint8Array([7])}]);await flush();assert.equal(p.calls.filter(x=>x.path.endsWith('/sign')).length,0);assert.equal(p.$('launch-stop').hidden,false);
  finishes[1]([{signedTransaction:new Uint8Array([8])}]);await second;const submissions=p.calls.filter(x=>x.path.endsWith('/sign'));assert.equal(submissions.length,1);assert.equal(submissions[0].body.transaction,'CA==');assert.equal(p.$('launch-toast').hidden,false);p.controller.destroy();
});
test('signature request deadlines cover stalled fetch and JSON bodies without retrying or signing',async()=>{
  for(const phase of ['fetch','json']){
    let stalled=true;const p=await page({requestTimeoutMs:25,route:path=>path.endsWith('/signature')&&stalled?(phase==='fetch'?new Promise(()=>{}):{rawResponse:{ok:true,status:200,json:()=>new Promise(()=>{})}}):undefined});await p.connect();p.chooseLaunch();await p.$('launch-retry').onclick();
    assert.match(p.$('launch-error').textContent,/outcome may still be processing/);assert.equal(p.calls.filter(x=>x.path.endsWith('/signature')).length,1);assert.equal(p.mock.calls.sign.length,0);assert.equal(p.$('launch-retry').disabled,false);
    stalled=false;await p.$('launch-retry').onclick();assert.equal(p.mock.calls.sign.length,1);assert.equal(p.$('launch-toast').hidden,false);assert(!p.calls.some(x=>x.path.endsWith('/create')));p.controller.destroy();
  }
});
test('an ambiguous signed submission timeout resumes with the exact saved bytes and no second wallet approval',async()=>{
  let submissions=0;const p=await page({requestTimeoutMs:25,route:path=>path.endsWith('/sign')&&++submissions===1?new Promise(()=>{}):undefined});await p.connect();p.chooseLaunch();await p.$('launch-retry').onclick();
  assert.equal(submissions,1);assert.equal(p.mock.calls.sign.length,1);assert.equal(p.$('launch-retry').disabled,false);await p.$('launch-retry').onclick();
  const sends=p.calls.filter(x=>x.path.endsWith('/sign'));assert.equal(sends.length,2);assert.deepEqual(sends[1].body,sends[0].body);assert.equal(p.mock.calls.sign.length,1);assert.equal(p.calls.filter(x=>x.path.endsWith('/signature')).length,1);assert(!p.calls.some(x=>x.path.endsWith('/create')));assert.equal(p.$('launch-toast').hidden,false);p.controller.destroy();
});
test('a wallet approval deadline unlocks the saved launch without submitting or automatically prompting again',async()=>{
  const mock=mockWallet();mock.wallet.features[SIGN].signTransaction=input=>{mock.calls.sign.push(input);return new Promise(()=>{});};const p=await page({mock,walletTimeoutMs:25});await p.connect();p.chooseLaunch();await p.$('launch-retry').onclick();
  assert.match(p.$('launch-error').textContent,/wallet has not returned an approval/);assert.equal(p.$('launch-retry').disabled,false);assert.equal(p.controller.canLeave(),true);assert.equal(p.mock.calls.sign.length,1);assert.equal(p.calls.filter(x=>x.path.endsWith('/sign')).length,0);await p.poll();assert.equal(p.mock.calls.sign.length,1);p.controller.destroy();
});
test('launch modal keeps inclusive launch fees, first buy and total without changing the saved review',async()=>{
  const record=launch('draft','default');record.review={...record.review,creatorFeeRatePpm:2750,creatorFeeBps:27.5,protocolFeeBps:25,platformFeeBps:100,protocolFees:{creationFeeSol:'0.015'},minimumSol:'0.062436252',launchFeesSol:'0.052436252',devBuy:{gross:'100000000',net:'97000000',solBudget:'10000000'},lp:'75% permanently locked platform LP; 25% burned'};const saved=JSON.stringify(record.review),p=await page({initial:record});
  assert.match(p.document.querySelector('.launch-auto-fee').textContent,/Flat 0.50%/);p.chooseLaunch();assert.equal(p.$('launch-budget-fees').textContent,'0.052436252 SOL');assert.equal(p.$('launch-budget-buy').textContent,'0.01 SOL');assert.equal(p.$('launch-budget-total').textContent,'0.062436252 SOL');assert.equal(p.$('launch-budget-creation-row'),null);assert.equal(p.$('launch-reviewed-creator-fee'),null);assert.equal(p.$('launch-reviewed-lp'),null);assert.equal(p.$('launch-budget').querySelectorAll('dt').length,3);assert.equal(p.$('launch-budget-note'),null);assert.equal(p.$('launch-buy-description'),null);assert.equal(p.$('launch-authorization'),null);assert.equal(JSON.stringify(record.review),saved);
});
test('new reward modes show their enforced creator rate and a creator-selected 1–3% tax',async()=>{
  const p=await page({initial:null}),tax=p.form.elements.namedItem('taxPercent');
  assert.equal(tax.getAttribute('min'),'1');assert.equal(tax.getAttribute('max'),'3');assert.equal(tax.value,'2');
  for(const [mode,rate] of [['holders','0%'],['creator','Flat 0.50%'],['holders','0%']]){
    for(const radio of p.form.querySelectorAll('[name=feeMode]'))radio.checked=radio.value===mode;
    p.form.dispatchEvent(new p.window.Event('change'));
    assert.equal(p.$('launch-creator-fee-value').textContent,rate);
    assert.equal(tax.disabled,mode!=='holders');
    assert.match(p.$('launch-creator-fee-description').textContent,/1% Launchpad protocol fee/);
    assert.match(p.$('launch-creator-fee-description').textContent,/After graduation, the pool’s reviewed creator fee applies/);
  }
  for(const percent of ['1','3']){tax.value=percent;p.form.dispatchEvent(new p.window.Event('input'));assert.equal(tax.value,percent);assert.equal(p.$('launch-creator-fee-value').textContent,'0%');}
  assert.match(p.$('launch-fee-note').textContent,/95% of converted transfer taxes/);
});
test('saved holder launch recovery preserves historical tax and confirmed creator fees without repeating them in the cost modal',async()=>{
  for(const confirmed of [5000,0]){
    const record=launch('draft','default');record.input={...record.input,feeMode:'holders',taxBps:500};record.creatorFees={ratePpm:confirmed};record.review={...record.review,creatorFeeRatePpm:5000,protocolFeeBps:25,platformFeeBps:100};const saved=JSON.stringify(record);
    const p=await page({initial:record});p.chooseLaunch();assert.equal(p.$('launch-reviewed-creator-fee'),null);assert.equal(p.$('launch-budget-total').textContent,'0.02 SOL');assert.equal(JSON.stringify(record),saved);
  }
});
test('launch cost arithmetic retains lamport precision with no creation fee or first buy',async()=>{
  for(const [minimumSol,buy,fees,creation] of [['0.000000003','1','0.000000002','0.000000001'],['0.031234567','0','0.031234567','0']]){
    const record=launch('draft','default');record.review={...record.review,minimumSol,devBuy:{gross:'1',net:'1',solBudget:buy},protocolFees:{creationFeeSol:creation}};
    const p=await page({initial:record});p.chooseLaunch();assert.equal(p.$('launch-budget-fees').textContent,fees+' SOL');assert.equal(p.$('launch-budget-buy').textContent,displayUnits(BigInt(buy))+' SOL');assert.equal(p.$('launch-budget-total').textContent,minimumSol+' SOL');assert.equal(units(fees)+BigInt(buy),units(minimumSol));assert.equal(p.$('launch-budget-creation'),null);
  }
});
test('compact inclusive costs submit the same prepared review hash without modifying its budget',async()=>{
  const record={...launch('draft','default'),reviewHash:'inclusive-cost-review',review:{...launch().review,minimumSol:'0.062436252',launchFeesSol:'0.052436252',protocolFees:{creationFeeSol:'0.015'},devBuy:{gross:'100000000',net:'97000000',solBudget:'10000000'}}},saved=JSON.stringify(record.review);
  const p=await page({initial:null,route:(path,body,state)=>{if(path.endsWith('/prepare'))return {...record,prepareId:'prepared-1'};if(path.endsWith('/create')){state.record=record;return record;}}});await p.fill();p.form.elements.namedItem('devBuySol').value='.01';await p.open();assert.equal(p.$('launch-budget-fees').textContent,'0.052436252 SOL');await p.form.onsubmit({preventDefault(){}});assert.equal(p.calls.find(call=>call.path.endsWith('/action')).body.reviewHash,'inclusive-cost-review');assert.equal(p.calls.find(call=>call.path.endsWith('/create')).body.prepareId,'prepared-1');assert.equal(JSON.stringify(record.review),saved);
});
test('Wallet Standard discovers wallets before and after app startup, filters unsupported wallets and unregisters cleanly',async()=>{
  const {window}=parseHTML('<html></html>'),first=mockWallet(),late=mockWallet();late.wallet.name='Second wallet';
  window.addEventListener('wallet-standard:app-ready',e=>e.detail.register(first.wallet));
  const ui=createLaunchpadWallet({window});assert.deepEqual(ui.state().wallets.map(w=>w.name),['Test wallet']);assert.equal(first.calls.connect,0);
  const remove=register(window,late.wallet);register(window,late.wallet);register(window,{...late.wallet,name:'Unsupported',chains:['solana:devnet']});assert.equal(ui.state().wallets.length,2);
  await ui.connect(ui.state().wallets[1].id);assert.equal(ui.state().address,ADDRESS);remove();assert.equal(ui.state().address,'');assert.equal(ui.state().wallets.length,1);ui.dispose();
});
test('Wallet signing verifies the developer address, uses signTransaction only and detects account changes during approval',async()=>{
  const {window}=parseHTML('<html></html>'),mock=mockWallet(),ui=createLaunchpadWallet({window});register(window,mock.wallet);await ui.connect(ui.state().wallets[0].id);
  await assert.rejects(ui.sign({...pending(),wallet:OTHER}),/same developer wallet/);assert.equal(mock.calls.sign.length,0);
  assert.equal(await ui.sign(pending()),'BAUG');assert.equal(mock.calls.sign[0].chain,CHAIN);assert.deepEqual([...mock.calls.sign[0].transaction],[1,2,3]);
  let finish;mock.wallet.features[SIGN].signTransaction=()=>new Promise(r=>{finish=r;});const signing=ui.sign(pending());mock.change([{...mock.wallet.accounts[0],address:OTHER}]);finish([{signedTransaction:new Uint8Array([9])}]);await assert.rejects(signing,/changed while signing/);await ui.disconnect();assert.equal(ui.state().address,'');ui.dispose();
});
test('managed-account opt-in retains reviewed creation with the default wallet',async()=>{
  const p=await page({initial:null});await p.fill();assert.equal(p.mock.calls.connect,0);assert.equal(p.$('launch-wallet-mode-note').textContent,'Using your default Launchpad wallet.');await p.open();
  assert.equal(p.$('launch-buy-dialog').open,true);assert.match(p.$('launch-budget-total').textContent,/0.03 SOL|.03 SOL/);assert.equal(p.calls.filter(c=>c.path.endsWith('/create')||c.path.endsWith('/action')).length,0);assert.equal(p.$('launch-review-button').disabled,false);
  await p.form.onsubmit({preventDefault(){}});assert.equal(p.calls.filter(c=>c.path.endsWith('/create')).length,1);assert.deepEqual(p.calls.find(c=>c.path.endsWith('/action')).body,{id:'launch-1',action:'launch',reviewHash:'review-1',confirm:true});assert.equal(p.mock.calls.sign.length,0);assert.equal(p.$('launch-buy-dialog').open,false);assert.equal(p.$('launch-toast').hidden,false);assert.equal(p.$('launch-toast-link').getAttribute('href'),'/launched-tokens?id=launch-1');assert.equal(p.window.location.href,'http://app.local/launchpad');
  assert.equal(p.$('launch-review'),null);assert.equal(p.$('launch-requote'),null);assert.equal(p.$('launch-submit'),null);assert.equal(p.$('launch-refresh'),null);
});
test('one Create coin action carries the exact preparation into creation and advances both wallet signatures',async()=>{
  let signs=0;const p=await page({initial:null,route:(path,body,state)=>{if(path.endsWith('/sign')){signs++;state.record=signs===1?{...launch(),pendingSignature:{...pending(),operationId:'operation-2'}}:launch('live');return state.record;}}});
  await p.fill();await p.connect();p.form.elements.namedItem('devBuySol').value='.01';await p.open();assert.match(p.$('launch-card-buy').textContent,/~97 tokens/);assert.equal(p.$('launch-dev-summary').hidden,true);await p.form.onsubmit({preventDefault(){}});
  const create=p.calls.find(c=>c.path.endsWith('/create')).body;assert.equal(create.prepareId,'prepared-1');assert.equal(create.walletMode,'external');assert.equal(create.externalWallet,ADDRESS);assert.equal(create.devBuySol,'.01');assert.equal('devBuyPercent' in create,false);assert.equal(p.mock.calls.sign.length,2);assert.equal(p.calls.filter(c=>c.path.endsWith('/action')).length,1);assert.equal(p.$('launch-toast').hidden,false);await p.poll();assert.equal(p.mock.calls.sign.length,2);
});
test('custom pair picker excludes SOL and USDC while reward modes retain the same form controls',async()=>{
  const p=await page({initial:null});p.document.querySelector('[data-pair=USDC]').onclick();assert.equal(p.$('launch-card-pair').textContent,'USDC');assert.equal(p.$('launch-asset-dialog').open,undefined);p.$('launch-asset-open').onclick();const labels=[...p.document.querySelectorAll('#launch-asset-results button strong')].map(x=>x.textContent);assert.equal([...p.document.querySelectorAll('#launch-asset-results .quote-logo')].some(icon=>[SOL_MINT,USDC_MINT].includes(icon.dataset.mint)),false);assert(labels.includes('WBTC'));
  for(const radio of p.form.querySelectorAll('[name=feeMode]'))radio.checked=radio.value==='holders';p.form.dispatchEvent(new p.window.Event('change'));assert.equal(p.$('launch-tax-label').hidden,false);assert.equal(p.$('launch-card-mode').textContent,'Holders');assert.equal(p.form.querySelector('[name=network]'),null);
});
test('saved pending launch does not prompt on load or polls, and explicitly resuming refreshes bytes before signing',async()=>{
  const p=await page({href:'http://app.local/launchpad?id=launch-1'});assert.equal(p.$('launch-buy-dialog').open,true);await p.poll();assert.equal(p.mock.calls.sign.length,0);await p.connect();await p.$('launch-retry').onclick();assert.equal(p.mock.calls.sign.length,1);assert.deepEqual(p.calls.find(c=>c.path.endsWith('/signature')).body,{id:'launch-1',operationId:'operation-1'});assert.deepEqual(p.calls.find(c=>c.path.endsWith('/sign')).body,{id:'launch-1',operationId:'operation-1',transaction:'BAUG'});assert.equal(p.$('launch-toast').hidden,false);
});
test('wallet rejection stops the initiated sequence and polling never opens another prompt',async()=>{
  const p=await page({mock:mockWallet({reject:true})});await p.connect();p.chooseLaunch();await p.$('launch-retry').onclick();assert.match(p.$('launch-error').textContent,/You cancelled the request in your wallet/);assert.equal(p.$('launch-retry').hidden,false);assert.equal(p.calls.filter(c=>c.path.endsWith('/sign')).length,0);await p.poll();assert.equal(p.mock.calls.sign.length,1);p.mock.change([]);await p.$('launch-retry').onclick();assert.match(p.$('launch-error').textContent,/Connect the developer wallet/);assert.equal(p.mock.calls.sign.length,1);
});
test('transient signature submission retries preserve the exact signed bytes and do not open a second wallet prompt',async()=>{
  let attempts=0;const p=await page({route:(path,body,state)=>{if(path.endsWith('/sign')){attempts++;if(attempts===1)throw new TypeError('Failed to fetch');if(attempts===2)return{ok:false,status:503,body:{error:'Try again'}};state.record=launch('live');return state.record;}}});await p.connect();p.chooseLaunch();await p.$('launch-retry').onclick();assert.equal(p.mock.calls.sign.length,1);const requests=p.calls.filter(c=>c.path.endsWith('/sign'));assert.equal(requests.length,3);for(const request of requests)assert.deepEqual(request.body,requests[0].body);assert.equal(p.$('launch-toast').hidden,false);
});
test('repeating Create after confirmed setup opens the original launch without another setup approval',async()=>{
  const saved={...launch(),reviewHash:'paid-review',review:{...launch().review,minimumSol:'0.025'},operations:[{kind:'setup',state:'confirmed',signature:'paid-setup'}]};
  const p=await page({initial:null,route:(path,body,state)=>{if(path.endsWith('/create')){state.record=saved;return saved;}}});
  await p.fill();await p.connect();await p.open();await p.form.onsubmit({preventDefault(){}});
  assert.equal(p.$('launch-buy-dialog').dataset.existing,'true');assert.equal(p.$('launch-review-button').hidden,true);assert.equal(p.$('launch-retry').hidden,false);assert.equal(p.$('launch-retry').textContent,'Resume launch');assert.equal(p.$('launch-budget-total').textContent,'0.025 SOL');assert.match(p.$('launch-status-message').textContent,/earlier launch is saved/);assert.equal(p.$('launch-modal-error').textContent,'');
  assert.equal(p.calls.filter(c=>c.path.endsWith('/action')).length,0);assert.equal(p.mock.calls.sign.length,0);
  await p.$('launch-retry').onclick();
  assert.equal(p.mock.calls.sign.length,1);assert.equal(p.calls.filter(c=>c.path.endsWith('/create')).length,1);assert.equal(p.calls.filter(c=>c.path.endsWith('/action')).length,0);assert.deepEqual(p.calls.find(c=>c.path.endsWith('/signature')).body,{id:saved.id,operationId:saved.pendingSignature.operationId});assert.equal(p.$('launch-toast').hidden,false);
});
test('a different saved draft review needs a separate approval with its displayed cost',async()=>{
  const saved={...launch('draft'),reviewHash:'saved-review',review:{...launch().review,minimumSol:'0.05'}};
  const p=await page({initial:null,route:(path,body,state)=>{if(path.endsWith('/create')){state.record=saved;return saved;}}});
  await p.fill();await p.connect();await p.open();assert.equal(p.$('launch-budget-total').textContent,'0.03 SOL');await p.form.onsubmit({preventDefault(){}});
  assert.equal(p.$('launch-budget-total').textContent,'0.05 SOL');assert.equal(p.$('launch-buy-dialog').dataset.existing,'true');assert.match(p.$('launch-status-message').textContent,/Review it before creating/);assert.equal(p.calls.filter(c=>c.path.endsWith('/action')).length,0);assert.equal(p.mock.calls.sign.length,0);
  await p.$('launch-retry').onclick();assert.deepEqual(p.calls.find(c=>c.path.endsWith('/action')).body,{id:saved.id,action:'launch',reviewHash:'saved-review',confirm:true});
});
test('definite wallet rejection discards only rejected bytes and explicit Resume requests a new signature',async()=>{
  for(const rejection of [{error:'The wallet changed the reviewed transaction. Nothing was submitted.'},{error:'The wallet removed a required Launchpad signature.',code:'WALLET_TRANSACTION_REJECTED'}]){
    let attempts=0,signs=0;const mock=mockWallet();mock.wallet.features[SIGN].signTransaction=async input=>{mock.calls.sign.push(input);return[{signedTransaction:new Uint8Array([++signs])}];};
    const p=await page({mock,route:(path,body,state)=>{if(path.endsWith('/sign')){if(++attempts===1)return{ok:false,status:400,body:rejection};state.record=launch('live');return state.record;}}});
    await p.connect();p.chooseLaunch();await p.$('launch-retry').onclick();assert.equal(mock.calls.sign.length,1);assert.equal(p.$('launch-retry').hidden,false);await p.poll();assert.equal(mock.calls.sign.length,1,'polling must not reopen the wallet');
    await p.$('launch-retry').onclick();const submissions=p.calls.filter(c=>c.path.endsWith('/sign'));assert.equal(submissions.length,2);assert.equal(mock.calls.sign.length,2);assert.equal(p.calls.filter(c=>c.path.endsWith('/signature')).length,2);assert.notEqual(submissions[0].body.transaction,submissions[1].body.transaction);assert.equal(p.$('launch-toast').hidden,false);
  }
});
test('server recovery keeps advancing inside the original user action without a Resume click',async()=>{
  let reads=0;const p=await page({route:(path,body,state)=>{if(path.endsWith('/sign')){state.record={...launch('launching'),pendingSignature:null,retry:{attempt:1,at:Date.now()}};return state.record;}if(path==='/api/launchpad'&&state.record?.retry){reads++;state.record=reads>1?launch('live'):state.record;return{launches:[state.record]};}}});await p.connect();p.chooseLaunch();await p.$('launch-retry').onclick();assert.equal(reads,2);assert.equal(p.mock.calls.sign.length,1);assert.equal(p.$('launch-toast').hidden,false);
});
test('late preparation and changed wallet cannot authorize stale form details',async()=>{
  let resolve;const p=await page({initial:null,route:(path,body)=>path.endsWith('/prepare')?new Promise(r=>{resolve=r;}):null});await p.fill();await p.open();p.form.elements.namedItem('devBuySol').value='.01';p.form.dispatchEvent(new p.window.Event('input'));assert.equal(p.$('launch-review-button').disabled,true);resolve({...launch('draft'),prepareId:'old-prepare'});await flush();assert.equal(p.$('launch-review-button').disabled,true);await p.form.onsubmit({preventDefault(){}});assert.equal(p.calls.filter(c=>c.path.endsWith('/create')).length,0);p.$('launch-buy-close').onclick();
});
test('changing buy amount refreshes a compact total budget and blocks values over the supply cap',async()=>{
  const p=await page({initial:null,route:(path,body)=>path.endsWith('/prepare')&&Number(body.devBuySol)>1?{...launch('draft'),prepareId:'over-cap',review:{...launch().review,devBuy:{gross:'100000000000001',net:'100000000000001',solBudget:'2000000000'}}}:null});await p.fill();await p.open();assert.equal(p.$('launch-budget-fees').textContent,'.03 SOL'.replace(/^\./,'0.'));assert(!p.$('launch-budget').textContent.includes('storage'));p.form.elements.namedItem('devBuySol').value='2';p.form.dispatchEvent(new p.window.Event('input'));await flush();await flush();assert.equal(p.$('launch-review-button').disabled,true);assert.match(p.$('launch-dev-summary').textContent,/100 million tokens/);assert.equal(p.form.elements.namedItem('devBuySol').value,'2');p.$('launch-buy-close').onclick();
});
test('an expired signing operation is refreshed without signing old bytes',async()=>{
  const p=await page({route:(path,body,state)=>{if(path.endsWith('/signature')){state.record={...launch('error'),pendingSignature:null,error:'Launch paused'};return state.record;}}});await p.connect();p.chooseLaunch();await p.$('launch-retry').onclick();assert.equal(p.mock.calls.sign.length,0);assert.equal(p.calls.filter(c=>c.path.endsWith('/sign')).length,0);assert.match(p.$('launch-error').textContent,/Launch paused/);
});
test('an unsubmitted failed launch refreshes its cost before authorizing a new execution plan',async()=>{
  const p=await page({initial:{...launch('error','default'),canReprepare:true,error:'Previous setup failed'}});p.chooseLaunch();await p.$('launch-retry').onclick();assert.equal(p.calls.filter(c=>c.path.endsWith('/review')).length,1);assert.equal(p.calls.filter(c=>c.path.endsWith('/action')).length,0);assert.equal(p.$('launch-retry').textContent,'Create coin');await p.$('launch-retry').onclick();assert.equal(p.calls.find(c=>c.path.endsWith('/action')).body.reviewHash,'review-1');assert.equal(p.$('launch-toast').hidden,false);
});

test('injected Phantom fallback signs actual v0 bytes locally and preserves Launchpad partial signatures without broadcasting',async()=>{
  const {window}=parseHTML('<html></html>'),payer=Keypair.generate(),extra=Keypair.generate(),events=new EventEmitter();let signed=0,sent=0;
  const provider={isPhantom:true,publicKey:payer.publicKey,connect:async()=>({publicKey:payer.publicKey}),disconnect:async()=>{},on:events.on.bind(events),removeListener:events.removeListener.bind(events),async signTransaction(tx){signed++;assert.equal(tx.version,0);tx.sign([payer]);return tx;},async signAndSendTransaction(){sent++;throw Error('Unexpected broadcast');}};
  window.phantom={solana:provider};const ui=createLaunchpadWallet({window});const unsupported=mockWallet();unsupported.wallet.name='Phantom';delete unsupported.wallet.features[SIGN];register(window,unsupported.wallet);
  assert.deepEqual(ui.state().wallets.map(w=>w.name),['Phantom']);await ui.connect(ui.state().wallets[0].id);
  const ix=new TransactionInstruction({programId:SystemProgram.programId,keys:[{pubkey:payer.publicKey,isSigner:true,isWritable:true},{pubkey:extra.publicKey,isSigner:true,isWritable:false}],data:Buffer.alloc(0)}),tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[ix]}).compileToV0Message());tx.sign([extra]);
  const result=await ui.sign({wallet:payer.publicKey.toBase58(),transaction:Buffer.from(tx.serialize()).toString('base64')}),decoded=VersionedTransaction.deserialize(Buffer.from(result,'base64'));assert.deepEqual(decoded.message.serialize(),tx.message.serialize());assert.deepEqual(decoded.signatures[1],tx.signatures[1]);assert(decoded.signatures[0].some(v=>v));assert.equal(signed,1);assert.equal(sent,0);
  events.emit('accountChanged',extra.publicKey);assert.equal(ui.state().address,extra.publicKey.toBase58());events.emit('disconnect');assert.equal(ui.state().address,'');ui.dispose();assert.equal(events.listenerCount('accountChanged'),0);
});
test('compatible Phantom Wallet Standard registration takes precedence over the injected fallback',()=>{
  const {window}=parseHTML('<html></html>'),events=new EventEmitter();window.phantom={solana:{isPhantom:true,connect(){},signTransaction(){},on:events.on.bind(events)}};const ui=createLaunchpadWallet({window}),standard=mockWallet();standard.wallet.name='Phantom';register(window,standard.wallet);assert.equal(ui.state().wallets.length,1);ui.dispose();
});


test('a definitively expired signature is replaced without consuming a successful transaction approval',async()=>{
  let refreshes=0,signs=0;const p=await page({route:(path,body,state)=>{
    if(path.endsWith('/signature')){refreshes++;if(refreshes===2){state.record={...launch('launching'),pendingSignature:null};return state.record;}return state.record;}
    if(path==='/api/launchpad'&&refreshes===2&&!state.record.pendingSignature){state.record={...launch(),pendingSignature:{...pending(),operationId:'replacement'}};return{launches:[state.record]};}
    if(path.endsWith('/sign')){signs++;if(signs===1)return{ok:false,status:400,body:{error:'This wallet-signing request expired. Refresh it and sign the new transaction.'}};state.record=signs===2?{...launch(),pendingSignature:{...pending(),operationId:'second-stage'}}:launch('live');return state.record;}
  }});await p.connect();p.chooseLaunch();await p.$('launch-retry').onclick();assert.equal(p.mock.calls.sign.length,3);assert.deepEqual(p.calls.filter(c=>c.path.endsWith('/sign')).map(c=>c.body.operationId),['operation-1','replacement','second-stage']);assert.equal(p.$('launch-toast').hidden,false);
});
test('saved launch recovery retains its identity and controls while keeping new form inputs out of the dialog',async()=>{
  const p=await page({href:'http://app.local/launchpad?id=launch-1'});assert.equal(p.$('launch-buy-title').textContent,'EXAMPLE · Launch');assert.equal(p.$('launch-authorization'),null);assert.equal(p.$('launch-buy-fields').hidden,true);assert.equal(p.$('launch-review-button').hidden,true);assert.equal(p.$('launch-retry').hidden,false);assert.equal(p.mock.calls.sign.length,0);
});
test('closing the modal while creating a draft cancels authorization before any launch action',async()=>{
  let finish;const p=await page({initial:null,route:(path,body,state)=>path.endsWith('/create')?new Promise(resolve=>{finish=()=>{state.record=launch('draft','default');resolve(state.record);};}):null});await p.fill();await p.open();const task=p.form.onsubmit({preventDefault(){}});await flush();p.$('launch-buy-close').onclick();finish();await task;assert.equal(p.calls.filter(c=>c.path.endsWith('/action')).length,0);assert.equal(p.$('launch-buy-dialog').open,false);assert.equal(p.$('launch-error').hidden,true);
});
test('connected creators can explicitly claim rewards with wallet approval without a token-created toast',async()=>{
  const live={...launch('live'),curve:{pool:'pool'},feesRequested:false,lastCycle:1,autoFees:false};const p=await page({initial:live,href:'http://app.local/launchpad?id=launch-1',route:(path,body,state)=>{
    if(path.endsWith('/action')&&body.action==='fees'){state.record={...live,state:'awaiting_signature',feesRequested:true,cycle:{stage:'claim'},pendingSignature:{...pending(),kind:'claim'}};return state.record;}
    if(path.endsWith('/sign')){state.record={...live,lastCycle:2};return state.record;}
  }});assert.equal(p.$('launch-rewards-manage').hidden,false);assert.equal(p.$('launch-fees').textContent,'Claim creator fees');assert.equal(p.$('launch-wallet-recovery').hidden,true);assert.equal(p.$('launch-automation').hidden,true);await p.connect();await p.$('launch-fees').onclick();assert.equal(p.mock.calls.sign.length,1);assert.equal(p.$('launch-toast').hidden,true);assert.match(p.$('launch-status-message').textContent,/Reward processing finished/);
});
test('managed rewards preserve pause and resume controls for connected-wallet launches',async()=>{
  const live={...launch('live'),input:{...launch().input,feeMode:'holders'},curve:{pool:'pool'},autoFees:true};const p=await page({initial:live,href:'http://app.local/launchpad?id=launch-1',route:(path,body,state)=>{if(path.endsWith('/action')){state.record={...state.record,autoFees:body.action==='resume',error:body.action==='pause'?'Fee service paused. Pending receipts will still be reconciled.':''};return state.record;}}});assert.equal(p.$('launch-wallet-recovery').hidden,false);assert.equal(p.$('launch-automation').textContent,'Pause rewards');await p.$('launch-automation').onclick();assert.equal(p.$('launch-automation').textContent,'Resume rewards');assert(!p.$('launch-status-message').textContent.includes('Retrying'));await p.$('launch-automation').onclick();assert.equal(p.calls.filter(c=>c.path.endsWith('/action')).at(-1).body.autoFees,true);assert.equal(p.mock.calls.sign.length,0);
});

test('a recovered failed launch restores its saved inputs into a fresh draft without authorizing or reusing the old mint',async()=>{
  const quote=LAUNCH_ASSETS.find(a=>a.mint===USDC_MINT),imageId='f'.repeat(64)+'.webp';
  const previous={...launch('failed','default'),canReuseDraft:true,recovery:{status:'complete',reason:'Unused SOL returned.',notice:'Network costs cannot be refunded.'},requestId:'old-request',input:{...launch().input,requestId:'old-request',name:'Saved coin',symbol:'SAVED',description:'Saved description',holderRewardMinimum:'0.7',imageId,quoteMint:quote.mint,feeMode:'holders',creatorFeeBps:35,taxBps:120,devBuySol:'0.01',targetUsd:'5000',links:{website:'https://saved.example/',twitter:'https://x.com/saved',telegram:'https://t.me/saved'}}};
  const p=await page({initial:previous,href:'http://app.local/launchpad?id=launch-1'});assert.equal(p.$('launch-edit-draft').hidden,false);assert.equal(p.$('launch-retry').hidden,true);
  const before=p.calls.length;p.$('launch-edit-draft').onclick();await flush();assert.equal(p.calls.length,before,'restoring details must not prepare, create, sign or spend');assert.equal(p.$('launch-buy-dialog').open,false);assert.equal(p.$('launch-progress').hidden,true);
  for(const [name,value] of Object.entries({name:'Saved coin',symbol:'SAVED',description:'Saved description',website:'https://saved.example/',twitter:'https://x.com/saved',telegram:'https://t.me/saved',targetUsd:'20000',taxPercent:'1.2',devBuySol:'0.01',feeMode:'holders'}))assert.equal(p.form.elements.namedItem(name).value,value);
  assert.equal(p.$('launch-image-preview').getAttribute('src'),'/token-images/'+imageId);assert.equal(p.$('launch-card-pair').textContent,'USDC');assert.equal(p.document.querySelector('.launch-socials').open,true);
  await p.open();const body=p.calls.filter(row=>row.path.endsWith('/prepare')).at(-1).body;assert.equal(body.imageId,imageId);assert.equal(body.quoteMint,quote.mint);assert.equal(body.taxPercent,'1.2');assert.equal(previous.input.taxBps,120);assert.notEqual(body.requestId,'old-request');assert.equal(body.id,undefined);assert.equal(body.mint,undefined);assert.equal(p.calls.filter(row=>row.path.endsWith('/action')||row.path.endsWith('/create')||row.path.endsWith('/sign')).length,0);p.$('launch-buy-close').onclick();
});
test('setup recovery prevents both resume and premature draft reuse, including direct button calls',async()=>{
  for(const status of ['checking','refunding','blocked']){
    const previous={...launch('failed','default'),canReuseDraft:false,recovery:{status,reason:'Original setup signature is unresolved.',notice:'Wait for confirmed recovery.'}};
    const p=await page({initial:previous,href:'http://app.local/launchpad?id=launch-1'});assert.equal(p.$('launch-retry').hidden,true);assert.equal(p.$('launch-edit-draft').hidden,true);assert.match(p.$('launch-status-message').textContent,/Original setup signature is unresolved/);
    p.$('launch-edit-draft').onclick();await p.$('launch-retry').onclick();assert.equal(p.calls.filter(row=>row.path.endsWith('/action')||row.path.endsWith('/prepare')||row.path.endsWith('/review')).length,0);assert.match(p.$('launch-error').textContent,/cannot be resumed/);assert.match(p.$('launch-list').textContent,/Draft/);assert.doesNotMatch(p.$('launch-list').textContent,/In progress/);
  }
});
test('edit-and-try-again link preloads a recovered draft without opening approvals',async()=>{
  const previous={...launch('failed','default'),canReuseDraft:true,recovery:{status:'complete',reason:'Funds remain in your original wallet.'},input:{...launch().input,imageId:'e'.repeat(64)+'.png',name:'Restored by link',symbol:'RESTORED',creatorFeeBps:25,targetUsd:'20000'}};
  const p=await page({initial:previous,href:'http://app.local/launchpad?reuse=launch-1'});assert.equal(p.form.elements.namedItem('name').value,'Restored by link');assert.equal(p.$('launch-buy-dialog').open,false);assert.equal(p.$('launch-image-preview').getAttribute('src'),'/token-images/'+previous.input.imageId);assert.equal(p.mock.calls.sign.length,0);assert.equal(p.calls.filter(row=>row.path.endsWith('/prepare')||row.path.endsWith('/create')||row.path.endsWith('/action')).length,0);
});

const holderLaunch=(patch={})=>({...launch('live','default'),curve:OTHER,input:{...launch().input,walletMode:'default',feeMode:'holders'},autoFees:true,review:{...launch().review,quoteDecimals:9},holderRewards:{intervalMinutes:60,minimumQuote:'0.01',quoteSymbol:'SOL',pendingQuote:'0.005',nextCheckAt:Date.now()+3600000,lastDistributionAt:null,lastDistributionQuote:null},...patch});
test('automatic reward backoff shows its retry time without claiming a check is running',async()=>{
  const at=Date.now()+3600000,row=holderLaunch({feesRequested:true,cycle:{stage:'route'},rewardRetry:{at,attempt:2,kind:'sell',reason:'RPC timeout'}}),p=await page({initial:row,href:'http://app.local/launchpad?id=launch-1'});
  for(const id of ['launch-rewards-status','launch-holder-next','launch-status-message'])assert.match(p.$(id).textContent,/Rewards will retry automatically at/);
  assert.doesNotMatch(p.$('launch-holder-next').textContent,/in progress/);assert.equal(p.$('launch-automation').disabled,false);assert.equal(p.$('launch-automation').textContent,'Pause rewards');
  p.setRecord({...row,autoFees:false});await p.poll();assert.equal(p.$('launch-rewards-status').textContent,'Automatic rewards are paused.');assert.equal(p.$('launch-holder-next').textContent,'Automatic rewards are paused.');
});
test('pause stays usable while the owner is watching a pending managed reward receipt',async()=>{
  const row={...holderLaunch(),input:{...holderLaunch().input,feeMode:'buyback'}},p=await page({initial:row,href:'http://app.local/launchpad?id=launch-1',route:(path,body,state)=>{
    if(path.endsWith('/action')&&body.action==='fees'){state.record={...state.record,feesRequested:true,cycle:{stage:'claim'},operations:[{kind:'claim',state:'pending',signature:'saved-signature'}]};return state.record;}
    if(path.endsWith('/action')&&body.action==='pause'){state.record={...state.record,autoFees:false};return state.record;}
  }});
  const processing=p.$('launch-fees').onclick();await flush();assert.equal(p.$('launch-fees').disabled,true);assert.equal(p.$('launch-automation').disabled,false);
  await p.$('launch-automation').onclick();await processing;
  assert.equal(p.calls.filter(c=>c.body?.action==='pause').length,1);assert.equal(p.$('launch-automation').textContent,'Resume rewards');assert.match(p.$('launch-status-message').textContent,/Submitted transactions will still be checked/);assert.equal(p.mock.calls.sign.length,0);
});
test('automation cannot be changed for archived, unlaunched or externally controlled creator coins',async()=>{
  for(const row of [holderLaunch({archived:true}),holderLaunch({curve:null}),{...launch('live'),curve:OTHER,autoFees:true}]){
    const p=await page({initial:row,href:'http://app.local/launchpad?id=launch-1'});assert.equal(p.$('launch-automation').disabled,true);await p.$('launch-automation').onclick();assert.equal(p.calls.filter(c=>c.path.endsWith('/action')).length,0);
  }
});
test('holder launch controls show the fixed $100 policy without developer minimum inputs',async()=>{
  const p=await page({initial:null});assert.equal(p.$('launch-holder-minimum-wrap').hidden,true);assert.equal(p.form.querySelector('[name=holderRewardMinimum]'),null);
  for(const radio of p.document.querySelectorAll('input[name=feeMode]'))radio.checked=radio.value==='holders';p.form.dispatchEvent(new p.window.Event('change'));
  assert.equal(p.$('launch-holder-minimum-wrap').hidden,false);assert.match(p.$('launch-holder-minimum-wrap').textContent,/\$100/);
  p.document.querySelector('[data-pair="USDC"]').onclick();assert.match(p.$('launch-holder-minimum-wrap').textContent,/\$100/);
  await p.fill();await p.open();assert.equal(p.calls.find(row=>row.path.endsWith('/prepare')).body.holderRewardMinimum,undefined);p.$('launch-buy-close').onclick();
});
test('existing holder coins expose the fixed schedule and balances without editing or manual actions',async()=>{
  const existing=holderLaunch({autoFees:false}),p=await page({initial:existing,href:'http://app.local/launchpad?id=launch-1'});
  assert.equal(p.$('launch-holder-settings').hidden,false);assert.match(p.$('launch-holder-schedule').textContent,/Every hour when at least \$100 in SOL/);assert.equal(p.$('launch-holder-pending').textContent,'0.005 SOL');
  assert.equal(p.$('launch-holder-edit'),null);assert.equal(p.$('launch-holder-save'),null);assert.equal(p.$('launch-fees').hidden,true);
  await p.poll();assert.equal(p.calls.some(c=>c.body?.action==='rewards-settings'||c.path.endsWith('/prepare')||c.path.endsWith('/create')),false);assert.equal(existing.input.taxBps,0);assert.match(p.$('launch-holder-next').textContent,/paused/);
});
test('creator coins retain their creator claim action and hide holder-only settings',async()=>{
  const p=await page({initial:launch('live','default'),href:'http://app.local/launchpad?id=launch-1'});assert.equal(p.$('launch-holder-settings').hidden,true);assert.equal(p.$('launch-fees').hidden,false);
});


test('holder tax defaults to 2%, preserves valid selections and is omitted for other reward modes',async()=>{
  const p=await page({initial:null});
  const tax=p.form.elements.namedItem('taxPercent');
  const choose=mode=>{for(const radio of p.form.querySelectorAll('[name=feeMode]'))radio.checked=radio.value===mode;p.form.dispatchEvent(new p.window.Event('change'));};
  choose('holders');assert.equal(tax.value,'2');assert.equal(tax.getAttribute('min'),'1');assert.equal(tax.getAttribute('max'),'3');assert.equal(tax.hasAttribute('required'),true);
  await p.fill();await p.open();assert.equal(p.calls.filter(call=>call.path.endsWith('/prepare')).at(-1).body.taxPercent,'2');p.$('launch-buy-close').onclick();
  tax.value='2.5';choose('creator');assert.equal(tax.disabled,true);await p.open();assert.equal(p.calls.filter(call=>call.path.endsWith('/prepare')).at(-1).body.taxPercent,undefined);p.$('launch-buy-close').onclick();
  choose('holders');assert.equal(tax.value,'2.5');choose('buyback');assert.equal(tax.disabled,true);await p.open();assert.equal(p.calls.filter(call=>call.path.endsWith('/prepare')).at(-1).body.taxPercent,undefined);p.$('launch-buy-close').onclick();
  choose('holders');assert.equal(tax.value,'2.5');tax.value='0.5';choose('creator');choose('holders');assert.equal(tax.value,'2');
});

test('holder tax below 1% or above 3% cannot request a launch preparation',async()=>{
  const p=await page({initial:null});
  for(const radio of p.form.querySelectorAll('[name=feeMode]'))radio.checked=radio.value==='holders';p.form.dispatchEvent(new p.window.Event('change'));
  await p.fill();const tax=p.form.elements.namedItem('taxPercent');
  for(const value of ['0','0.5','0.9','3.1','5']){tax.value=value;p.form.dispatchEvent(new p.window.Event('input'));await p.open();assert.equal(p.$('launch-buy-dialog').open||false,false);assert.equal(p.calls.filter(call=>call.path.endsWith('/prepare')).length,0);assert.match(p.$('launch-error').textContent,/1.*3/);assert.equal(tax.value,value);}
});

test('holder creation keeps the selected transfer tax and explains gradual conversion separately from hourly payouts',async()=>{
  const p=await page({initial:null});
  for(const radio of p.form.querySelectorAll('[name=feeMode]'))radio.checked=radio.value==='holders';p.form.dispatchEvent(new p.window.Event('change'));
  p.form.elements.namedItem('taxPercent').value='3';await p.fill();await p.open();
  assert.equal(p.calls.find(call=>call.path.endsWith('/prepare')).body.taxPercent,'3');assert.equal(p.$('launch-tax-label').hidden,false);assert.match(p.$('launch-tax-label').textContent,/wallet-to-wallet transfers/);assert.match(p.$('launch-tax-label').textContent,/at least 5 minutes between small sales/);assert.match(p.$('launch-holder-minimum-wrap').textContent,/checked hourly/);p.$('launch-buy-close').onclick();
});

test('holder management separates the next small conversion from the payout schedule and respects paused automation',async()=>{
  const row=holderLaunch();row.input.taxBps=400;row.holderRewards.taxConversion={intervalMinutes:5,nextAt:Date.now()+300000};
  const p=await page({initial:row,href:'http://app.local/launchpad?id=launch-1'});
  assert.equal(p.$('launch-holder-conversion').hidden,false);assert.match(p.$('launch-holder-conversion').textContent,/at least 5 minutes apart/);assert.match(p.$('launch-holder-conversion').textContent,/Next conversion eligible/);assert.match(p.$('launch-holder-schedule').textContent,/Every hour/);
  p.setRecord({...row,autoFees:false});await p.poll();assert.match(p.$('launch-holder-conversion').textContent,/conversions are paused/);assert.doesNotMatch(p.$('launch-holder-conversion').textContent,/Next conversion eligible/);assert.equal(row.input.taxBps,400);
});

test('official tax-burn management shows burns instead of sales and respects paused automatic rewards',async()=>{
  const row=holderLaunch();row.input.taxBps=200;row.input.symbol='LAUNCHPAD';row.holderRewards.taxBurn={selected:true,enabled:true,paused:false,tokensBurned:'5',pendingTaxTokens:'15',initialInventory:{status:'authorized',approvedTokens:'41234567.890123'}};
  const p=await page({initial:row,href:'http://app.local/launchpad?id=launch-1'});
  assert.match(p.$('launch-holder-conversion').textContent,/burned directly/);assert.match(p.$('launch-holder-conversion').textContent,/41234567.890123 LAUNCHPAD initial inventory approved/);assert.doesNotMatch(p.$('launch-holder-conversion').textContent,/sold in small amounts/);
  p.setRecord({...row,autoFees:false});await p.poll();assert.match(p.$('launch-holder-conversion').textContent,/Tax burns are paused/);assert.doesNotMatch(p.$('launch-holder-conversion').textContent,/Tax burns run automatically/);
});


test('public launch UI fixes the starting cap and a manually entered admin URL cannot reveal the slider',async()=>{
  const publicPage=await page({initial:null});
  assert.equal(publicPage.$('launch-fixed-fdv').hidden,false);
  assert.equal(publicPage.$('launch-admin-fdv').hidden,true);
  assert.equal(publicPage.form.elements.namedItem('targetUsd').type,'hidden');
  await publicPage.fill();await publicPage.open();
  assert.equal(publicPage.calls.find(call=>call.path.endsWith('/prepare')).body.targetUsd,'20000');
  assert.equal(publicPage.calls.some(call=>call.path.startsWith('/api/admin/')),false);
  publicPage.$('launch-buy-close').onclick();
  const denied=await page({initial:null,href:'http://app.local/launchpad?admin=1',route:path=>path==='/api/admin/launchpad/capabilities'?{ok:false,status:403,body:{error:'Administrator access required.'}}:null});
  assert.equal(denied.$('launch-main').hidden,true);
  assert.equal(denied.$('launch-admin-fdv').hidden,true);
  assert.match(denied.$('launch-gate-message').textContent,/Administrator access required/);
});

test('verified administrator entry enables the 20k–100k slider and uses administrator preparation and creation',async()=>{
  const p=await page({initial:null,href:'http://app.local/launchpad?admin=1',route:path=>path==='/api/admin/launchpad/capabilities'?{adjustableMarketCap:true,minUsd:20000,maxUsd:100000,defaultUsd:20000}:null});
  assert.equal(p.$('launch-admin-fdv').hidden,false);assert.equal(p.$('launch-fixed-fdv').hidden,true);
  assert.equal(p.form.elements.namedItem('targetUsd').type,'range');
  assert.equal(p.form.elements.namedItem('targetUsd').getAttribute('min'),'20000');
  assert.equal(p.form.elements.namedItem('targetUsd').getAttribute('max'),'100000');
  await p.fill();p.form.elements.namedItem('targetUsd').value='100000';await p.open();
  assert.equal(p.calls.find(call=>call.path==='/api/admin/launchpad/prepare').body.targetUsd,'100000');
  await p.form.onsubmit({preventDefault(){}});
  assert.equal(p.calls.find(call=>call.path==='/api/admin/launchpad/create').body.targetUsd,'100000');
  assert.equal(p.calls.some(call=>call.path==='/api/launchpad/create'),false);
});

test('an old account poll cannot replace the new account launches or clear its pending request',async()=>{
  let held=false,releaseOld,releaseNew,newReads=0;
  const p=await page({route:(path)=>{
    if(path!=='/api/launchpad'||!held)return;
    if(!releaseOld)return new Promise(resolve=>{releaseOld=resolve;});
    newReads++;return new Promise(resolve=>{releaseNew=resolve;});
  }});
  held=true;const oldPoll=p.poll();await flush();
  p.document.dispatchEvent(new p.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'new-session',account:{id:'new-user'}}}));await flush();
  assert.equal(newReads,1);assert.doesNotMatch(p.$('launch-list').textContent,/EXAMPLE/);
  releaseOld({launches:[launch()]});await oldPoll;
  assert.doesNotMatch(p.$('launch-list').textContent,/EXAMPLE/);
  const nextPoll=p.poll();await flush();assert.equal(newReads,1,'old request must not clear the new account request');
  releaseNew({launches:[{...launch(),id:'new-launch',input:{...launch().input,name:'New account coin',symbol:'NEWACCOUNT'}}]});await nextPoll;await flush();
  assert.match(p.$('launch-list').textContent,/NEWACCOUNT/);assert.doesNotMatch(p.$('launch-list').textContent,/EXAMPLE/);
});

test('an upload finishing after account change cannot overwrite the new account image',async()=>{
  let releaseOld,uploads=0;
  const p=await page({initial:null,route:path=>{if(!path.endsWith('/image'))return;uploads++;if(uploads===1)return new Promise(resolve=>{releaseOld=resolve;});return{imageId:'b'.repeat(64)+'.webp'};}});
  const old=p.image();await flush();
  p.document.dispatchEvent(new p.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'new-csrf',features:{walletOnly:false},account:{id:'new-owner'}}}));await flush();
  assert.equal(p.$('launch-image-preview').hidden,true);await p.fill();
  releaseOld({imageId:'a'.repeat(64)+'.webp'});await old;await p.open();
  assert.equal(p.calls.filter(call=>call.path.endsWith('/prepare')).at(-1).body.imageId,'b'.repeat(64)+'.webp');
  assert.equal(p.$('launch-image-status').textContent,'Coin image ready.');p.$('launch-buy-close').onclick();
});

test('account switch during image optimization prevents upload to the replacement account',async()=>{
  let release;
  const p=await page({initial:null,imageBitmap:()=>new Promise(resolve=>{release=resolve;})});
  const image=p.image();await flush();
  p.document.dispatchEvent(new p.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'new-csrf',features:{walletOnly:false},account:{id:'new-owner'}}}));await flush();
  release({width:8,height:8,close(){}});await image;
  assert.equal(p.calls.filter(call=>call.path.endsWith('/image')).length,0);assert.equal(p.$('launch-image-preview').hidden,true);
});

test('signing out while an image is uploading clears it and ignores the pending response',async()=>{
  let release;
  const p=await page({initial:null,route:path=>path.endsWith('/image')?new Promise(resolve=>{release=resolve;}):undefined});
  const image=p.image();await flush();p.document.dispatchEvent(new p.window.CustomEvent('curve-account-updated',{detail:{authenticated:false}}));await flush();
  release({imageId:'a'.repeat(64)+'.webp'});await image;
  assert.equal(p.$('launch-gate').hidden,false);assert.equal(p.$('launch-main').hidden,true);assert.equal(p.$('launch-image-preview').hidden,true);
});

test('a busy review retries automatically with the same request details and never creates a launch',async()=>{
  let attempts=0;const p=await page({initial:null,route:path=>{if(path.endsWith('/prepare')&&++attempts===1)return{ok:false,status:503,body:{error:'Launch reviews are busy. Retrying shortly.'}};}});
  await p.fill();await p.open();await flush();await flush();
  const reviews=p.calls.filter(call=>call.path.endsWith('/prepare'));assert.equal(reviews.length,2);assert.deepEqual(reviews[0].body,reviews[1].body);assert.equal(p.$('launch-review-button').disabled,false);assert.equal(p.calls.filter(call=>call.path.endsWith('/create')).length,0);p.$('launch-buy-close').onclick();
});

test('wallet-only launches require a connected wallet by default and never prepare a managed launch',async()=>{
  const p=await page({initial:null,features:{}});await p.fill();await p.open();assert.equal(p.$('launch-wallet-dialog').open,true);assert.match(p.$('launch-error').textContent,/Connect your wallet/);assert.equal(p.calls.some(call=>call.path.endsWith('/prepare')||call.path.endsWith('/create')),false);assert.equal(p.$('launch-authorization'),null);
  await p.connect();await p.open();assert.equal(p.$('launch-review-button').disabled,false);await p.form.onsubmit({preventDefault(){}});
  const requests=p.calls.filter(call=>call.path.endsWith('/prepare')||call.path.endsWith('/create'));assert(requests.length>=2);assert(requests.every(call=>call.body.walletMode==='external'&&call.body.externalWallet===ADDRESS));assert.equal(p.mock.calls.sign.length,1);
});

test('changing to wallet-only mode cancels an existing managed launch review before creation',async()=>{
  const p=await page({initial:null});await p.fill();await p.open();assert.equal(p.$('launch-review-button').disabled,false);
  p.document.dispatchEvent(new p.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'csrf',features:{walletOnly:true},account:{}}}));await flush();assert.equal(p.$('launch-review-button').disabled,true);await p.form.onsubmit({preventDefault(){}});assert.equal(p.calls.some(call=>call.path.endsWith('/create')||call.path.endsWith('/action')),false);
});

test('wallet-only mode does not resume an old managed-wallet draft',async()=>{
  const p=await page({initial:launch('draft','default'),features:{walletOnly:true}});p.chooseLaunch();await p.$('launch-retry').onclick();assert.match(p.$('launch-error').textContent,/Create a new launch with your connected wallet/);assert.equal(p.calls.some(call=>call.path.endsWith('/review')||call.path.endsWith('/action')),false);
});


test('route teardown ignores late create responses and cannot approve an abandoned launch',async()=>{
  let finishCreate;const p=await page({initial:null,route:path=>path.endsWith('/create')?new Promise(resolve=>{finishCreate=resolve;}):undefined});await p.fill();await p.open();
  const creating=p.form.onsubmit({preventDefault(){}});await flush();assert.equal(p.controller.canLeave(),false);p.controller.destroy();finishCreate(launch('draft','default'));await creating;
  assert.equal(p.calls.filter(call=>call.path.endsWith('/action')).length,0);assert.equal(p.mock.calls.sign.length,0);
  const before=p.calls.length;p.document.dispatchEvent(new p.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'new',account:{id:'different'}}}));await flush();assert.equal(p.calls.length,before);
});

test('new launches have Creator/Holders only and recovered agent drafts require an explicit new choice',async()=>{
  const record={...launch('failed','default'),canReuseDraft:true,recovery:{status:'complete'}};record.input.feeMode='buyback';record.input.taxBps=0;const p=await page({initial:record,href:'http://app.local/launchpad?reuse=launch-1'});
  assert.equal(p.form.querySelector('[name=feeMode][value=buyback]'),null);assert.equal(p.form.elements.namedItem('feeMode').value,'');assert.match(p.$('launch-error').textContent,/Choose Creator or Holders/);
  p.form.elements.namedItem('name').value='Example';p.form.elements.namedItem('symbol').value='EXAMPLE';await p.image();await p.open();assert.equal(p.calls.filter(call=>call.path.endsWith('/prepare')||call.path.endsWith('/create')).length,0);
  for(const radio of p.form.querySelectorAll('[name=feeMode]'))radio.checked=radio.value==='creator';p.form.dispatchEvent(new p.window.Event('change'));await p.open();assert.equal(p.calls.filter(call=>call.path.endsWith('/prepare')).length,1);
});


test('preview describes reviewed new and historical curve valuations without rewriting them or inventing missing values',async()=>{
  for(const graduationUsd of ['75000','320000']){
    const record=launch('draft','default');record.review={...record.review,actualUsd:'20000',graduationUsd};const saved=JSON.stringify(record.review),p=await page({initial:record});p.chooseLaunch();
    assert.match(p.$('launch-curve-summary').textContent,/starts near \$20,000/);assert(p.$('launch-curve-summary').textContent.includes('graduates near $'+Number(graduationUsd).toLocaleString()));assert.match(p.$('launch-curve-summary').textContent,/USD values move with the paired asset/);assert.equal(JSON.stringify(record.review),saved);p.controller.destroy();
  }
  const p=await page({initial:null,route:(path,body)=>path.endsWith('/prepare')?{...launch('draft',body.walletMode),prepareId:'prepared-reference',review:{...launch().review,actualUsd:'20000',graduationUsd:'75000',minimumSol:'0.03',devBuy:{gross:'0',net:'0',solBudget:'0'}}}:undefined});
  assert.doesNotMatch(p.$('launch-curve-summary').textContent,/75,000/);await p.fill();await p.open();assert.match(p.$('launch-curve-summary').textContent,/graduates near \$75,000/);
  p.form.elements.namedItem('name').value='Changed idea';p.form.dispatchEvent(new p.window.Event('input'));assert.doesNotMatch(p.$('launch-curve-summary').textContent,/75,000/);p.controller.destroy();
});

test('public pair picker starts empty until a checked catalogue arrives and hides unsupported or unknown rows',async()=>{
 let resolveQuotes;const available={mint:'2'.repeat(32),symbol:'LIVE',name:'Live pair',category:'custom',supported:true},blocked={mint:'3'.repeat(32),symbol:'BLOCKED',name:'Blocked pair',category:'stocks',supported:false},unknown={mint:'4'.repeat(32),symbol:'UNKNOWNPAIR',name:'Unknown pair',category:'custom',supported:null};
 const p=await page({initial:null,route:path=>path.endsWith('/quotes')?new Promise(resolve=>{resolveQuotes=resolve;}):undefined});p.$('launch-asset-open').onclick();assert.equal(p.document.querySelector('[data-category=coming]').hidden,true);assert.equal(p.$('launch-asset-results').querySelectorAll('button').length,0);assert.match(p.$('launch-asset-results').textContent,/Checking available pairs/);
 resolveQuotes({assets:[available,blocked,unknown],canViewComingSoon:false});await flush();assert.equal(p.$('launch-asset-results').querySelectorAll('button').length,1);assert.match(p.$('launch-asset-results').textContent,/LIVE/);assert.doesNotMatch(p.$('launch-asset-results').textContent,/BLOCKED|UNKNOWNPAIR/);p.document.querySelector('[data-category=coming]').onclick();assert.equal(p.document.querySelector('[data-category=all]').getAttribute('aria-pressed'),'true');assert.equal(p.$('launch-coming-note').hidden,true);assert.doesNotMatch(p.$('launch-asset-results').textContent,/BLOCKED|UNKNOWNPAIR/);p.controller.destroy();
});
test('Coming Soon is enabled by the server flag on a normal administrator launch page and revoked on role change',async()=>{
 const admin={id:'owner',role:'admin',mfaEnabled:true},blocked={mint:'3'.repeat(32),symbol:'BLOCKED',name:'Blocked pair',category:'stocks',supported:false},available={mint:'2'.repeat(32),symbol:'LIVE',name:'Live pair',category:'custom',supported:true};let allowed=true,resolveNext;
 const p=await page({initial:null,route:path=>path==='/api/session'?{authenticated:true,token:'csrf',features:{walletOnly:false},account:admin,monitorAllowed:true}:path.endsWith('/quotes')?allowed?{assets:[blocked,available],canViewComingSoon:true}:new Promise(resolve=>{resolveNext=resolve;}):undefined});p.$('launch-asset-open').onclick();const tab=p.document.querySelector('[data-category=coming]');assert.equal(tab.hidden,false);assert.equal(p.calls.some(c=>c.path.includes('/capabilities')),false);tab.onclick();assert.match(p.$('launch-asset-results').textContent,/BLOCKED/);assert.equal(p.$('launch-asset-results').querySelector('button').disabled,true);
 allowed=false;p.document.dispatchEvent(new p.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'new',features:{walletOnly:false},account:{...admin,role:'user'},monitorAllowed:false}}));assert.equal(tab.hidden,true);assert.equal(p.$('launch-asset-results').querySelectorAll('button').length,0);assert.equal(p.document.querySelector('[data-category=all]').getAttribute('aria-pressed'),'true');assert.equal(p.$('launch-coming-note').hidden,true);await flush();resolveNext({assets:[available,blocked],canViewComingSoon:false});await flush();assert.match(p.$('launch-asset-results').textContent,/LIVE/);assert.doesNotMatch(p.$('launch-asset-results').textContent,/BLOCKED/);p.controller.destroy();
});
test('late administrator catalogue cannot restore Coming Soon after account switching or logout',async()=>{
 for(const logout of [false,true]){let finish;const p=await page({initial:null,route:path=>path==='/api/session'?{authenticated:true,token:'csrf',account:{id:'old',role:'admin',mfaEnabled:true},monitorAllowed:true}:path.endsWith('/quotes')?new Promise(resolve=>{finish=resolve;}):undefined});p.$('launch-asset-open').onclick();p.document.dispatchEvent(new p.window.CustomEvent('curve-account-updated',{detail:logout?{authenticated:false}:{authenticated:true,token:'new',account:{id:'next',role:'user'}}}));finish({assets:[{mint:'3'.repeat(32),symbol:'PRIVATEWAIT',name:'Waiting',category:'custom',supported:false}],canViewComingSoon:true});await flush();assert.equal(p.document.querySelector('[data-category=coming]').hidden,true);assert.doesNotMatch(p.$('launch-asset-results').textContent,/PRIVATEWAIT/);p.controller.destroy();}
});
test('missing or truthy nonboolean Coming Soon flags never reveal unsupported rows',async()=>{
 for(const capability of [undefined,'true',1]){const p=await page({initial:null,route:path=>path.endsWith('/quotes')?{canViewComingSoon:capability,assets:[{mint:'3'.repeat(32),symbol:'BLOCKED',category:'stocks',supported:false},{mint:'4'.repeat(32),symbol:'UNKNOWNPAIR',category:'stocks',supported:null}]}:undefined});p.$('launch-asset-open').onclick();assert.equal(p.document.querySelector('[data-category=coming]').hidden,true);assert.equal(p.$('launch-asset-results').querySelectorAll('button').length,0);p.controller.destroy();}
});

test('custom SOL and USDC tickers retain their own mint while native shortcuts always select canonical assets',async()=>{
 const customUsdc={mint:'C5nG72gUFJz6wewcgTPjcBmpSq4BwFLHy5j8heo9d7rZ',symbol:'USDC',name:'Upside Down Cat',category:'custom',supported:true},customSol={mint:'7'.repeat(32),symbol:'SOL',name:'Different SOL token',category:'custom',supported:true};
 const canonical=[SOL_MINT,USDC_MINT].map(mint=>({...LAUNCH_ASSETS.find(a=>a.mint===mint),supported:true}));
 for(const custom of [customUsdc,customSol]){
  const p=await page({initial:null,route:path=>path.endsWith('/quotes')?{assets:[customUsdc,customSol,...canonical],canViewComingSoon:false}:undefined});p.$('launch-asset-open').onclick();p.document.querySelector('[data-category=custom]').onclick();const rows=[...p.$('launch-asset-results').querySelectorAll('button')];assert.equal(rows.length,2);const row=rows.find(r=>r.querySelector('.quote-logo').dataset.mint===custom.mint);assert(row);row.onclick();
  assert.equal(p.$('launch-card-pair').dataset.mint,custom.mint);assert.equal(p.$('launch-asset-open').getAttribute('aria-pressed'),'true');assert.equal(p.document.querySelector('[data-pair='+custom.symbol+']').getAttribute('aria-pressed'),'false');assert.equal(p.$('launch-asset-open').querySelector('.quote-logo').dataset.mint,custom.mint);
  await p.fill();await p.open();assert.equal(p.calls.filter(c=>c.path.endsWith('/prepare')).at(-1).body.quoteMint,custom.mint);
  const shortcut=p.document.querySelector('[data-pair='+custom.symbol+']'),canonicalMint=custom.symbol==='SOL'?SOL_MINT:USDC_MINT;assert.equal(shortcut.querySelector('.quote-logo').dataset.mint,canonicalMint);shortcut.onclick();assert.equal(p.$('launch-card-pair').dataset.mint,canonicalMint);assert.equal(shortcut.getAttribute('aria-pressed'),'true');assert.equal(p.$('launch-asset-open').getAttribute('aria-pressed'),'false');assert.equal(p.$('launch-asset-open').querySelector('.quote-logo'),null);await p.open();assert.equal(p.calls.filter(c=>c.path.endsWith('/prepare')).at(-1).body.quoteMint,canonicalMint);p.controller.destroy();
 }
});
test('a supported custom USDC cannot enable or replace an unavailable canonical USDC shortcut',async()=>{
 const custom={mint:'C5nG72gUFJz6wewcgTPjcBmpSq4BwFLHy5j8heo9d7rZ',symbol:'USDC',name:'Upside Down Cat',category:'custom',supported:true};
 const p=await page({initial:null,route:path=>path.endsWith('/quotes')?{assets:[custom,{...LAUNCH_ASSETS.find(a=>a.mint===USDC_MINT),supported:false},{...LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),supported:true}],canViewComingSoon:true}:undefined});const shortcut=p.document.querySelector('[data-pair=USDC]');assert.equal(shortcut.disabled,true);p.$('launch-asset-open').onclick();p.document.querySelector('[data-category=custom]').onclick();p.$('launch-asset-results').querySelector('button').onclick();assert.equal(p.$('launch-card-pair').dataset.mint,custom.mint);shortcut.onclick();assert.equal(p.$('launch-card-pair').dataset.mint,custom.mint,'blocked native click cannot silently select its same-symbol custom asset');p.controller.destroy();
});

test('stale picker opens and minute ticks coalesce while preserving selection, filters, rows and draft',async()=>{
 let now=Date.now(),release,quoteCalls=0;
 const sol={...LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),supported:true},pair={...LAUNCH_ASSETS.find(a=>a.symbol==='WBTC'),supported:true},added={mint:'2'.repeat(32),symbol:'FRESH',name:'Fresh crypto',category:pair.category,supported:true};
 const p=await page({initial:null,now:()=>now,route:path=>path.endsWith('/quotes')?++quoteCalls===1?{assets:[sol,pair]}:new Promise(resolve=>{release=resolve;}):undefined});
 p.$('launch-asset-open').onclick();p.document.querySelector('[data-category='+pair.category+']').onclick();p.$('launch-asset-results').querySelector('button').onclick();await p.fill();
 p.$('launch-asset-open').onclick();const row=p.$('launch-asset-results').querySelector('button'),image=row.querySelector('img');
 p.$('launch-asset-search').value='wbtc';p.$('launch-asset-search').oninput();p.$('launch-asset-results').scrollTop=83;p.$('launch-asset-dialog').scrollTop=21;
 now+=60000;p.$('launch-asset-open').onclick();const tick=p.catalogueTick();await flush();p.$('launch-asset-open').onclick();assert.equal(quoteCalls,2,'open and tick share the pending catalogue request');
 release({assets:[sol,{...pair,checkedAt:now},added]});await tick;await flush();
 assert.equal(p.$('launch-card-pair').dataset.mint,pair.mint);assert.equal(p.form.elements.namedItem('name').value,'Example');assert.equal(p.$('launch-asset-search').value,'wbtc');assert.equal(p.document.querySelector('[data-category='+pair.category+']').getAttribute('aria-pressed'),'true');
 assert.equal(p.$('launch-asset-results').querySelector('button'),row,'the focused row stays mounted');assert.equal(row.querySelector('img'),image,'the loaded image stays mounted');assert.equal(p.$('launch-asset-results').scrollTop,83);assert.equal(p.$('launch-asset-dialog').scrollTop,21);assert.equal(p.$('launch-asset-dialog').open,true);
 p.$('launch-asset-search').value='fresh';p.$('launch-asset-search').oninput();assert.match(p.$('launch-asset-results').textContent,/FRESH/);assert.equal(quoteCalls,2);assert.equal(p.calls.filter(c=>c.path.endsWith('/create')).length,0);p.controller.destroy();
});

test('pair polling pauses when hidden and refreshes on visibility return without reopening dialogs',async()=>{
 let now=Date.now(),quoteCalls=0;const p=await page({initial:null,now:()=>now,route:path=>path.endsWith('/quotes')?(quoteCalls++,{assets:[{...LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),supported:true}]}):undefined});
 Object.defineProperty(p.document,'hidden',{value:true,writable:true,configurable:true});now+=60000;await p.catalogueTick();assert.equal(quoteCalls,1);
 p.document.hidden=false;p.document.dispatchEvent(new p.window.Event('visibilitychange'));await flush();assert.equal(quoteCalls,2);assert.notEqual(p.$('launch-asset-dialog').open,true);
 await p.catalogueTick();assert.equal(quoteCalls,2,'fresh visibility check is shared with the minute tick');p.controller.destroy();now+=60000;await p.catalogueTick();p.document.dispatchEvent(new p.window.Event('visibilitychange'));await flush();assert.equal(quoteCalls,2,'unmounted pages do not poll');
});

test('a missing selected pair never becomes SOL and recovery retains its prepared launch',async()=>{
 let now=Date.now(),available=true;const sol={...LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),supported:true},pair={...LAUNCH_ASSETS.find(a=>a.symbol==='WBTC'),supported:true};
 const p=await page({initial:null,now:()=>now,route:path=>path.endsWith('/quotes')?{assets:available?[sol,pair]:[sol]}:undefined});p.$('launch-asset-open').onclick();p.$('launch-asset-results').querySelector('button').onclick();await p.fill();await p.open();
 const prepared=p.calls.filter(c=>c.path.endsWith('/prepare')).at(-1),budget=p.$('launch-budget-total').textContent;assert.equal(prepared.body.quoteMint,pair.mint);assert.equal(p.$('launch-review-button').disabled,false);
 available=false;now+=60000;await p.catalogueTick();assert.equal(p.$('launch-card-pair').dataset.mint,pair.mint);assert.equal(p.$('launch-custom-label').textContent,'WBTC');assert.equal(p.$('launch-review-button').disabled,true);assert.equal(p.$('launch-open').disabled,true);assert.equal(p.$('launch-budget-total').textContent,budget);assert.match(p.$('launch-pair-note').textContent,/could not be verified/);
 await p.form.onsubmit({preventDefault(){}});assert.equal(p.calls.filter(c=>c.path.endsWith('/create')).length,0);assert.equal(p.calls.filter(c=>c.path.endsWith('/prepare')).length,1,'background catalogue changes do not reprepare the draft');
 available=true;now+=60000;await p.catalogueTick();assert.equal(p.$('launch-review-button').disabled,false);assert.equal(p.$('launch-budget-total').textContent,budget);await p.form.onsubmit({preventDefault(){}});
 const creation=p.calls.find(c=>c.path.endsWith('/create'));assert.equal(creation.body.quoteMint,pair.mint);assert.equal(creation.body.prepareId,'prepared-1');assert.equal(p.calls.filter(c=>c.path.endsWith('/prepare')).length,1);p.controller.destroy();
});

test('failed catalogue refresh retains the draft and last checked list, then retries automatically',async()=>{
 let now=Date.now(),broken=false,calls=0;const pair={...LAUNCH_ASSETS.find(a=>a.symbol==='WBTC'),supported:true};
 const p=await page({initial:null,now:()=>now,route:path=>{if(path.endsWith('/quotes')){calls++;if(broken)throw Error('Provider interrupted');return{assets:[{...LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),supported:true},pair]};}}});p.$('launch-asset-open').onclick();p.$('launch-asset-results').querySelector('button').onclick();await p.fill();p.$('launch-asset-open').onclick();const row=p.$('launch-asset-results').querySelector('button');
 broken=true;now+=60000;await p.catalogueTick();assert.equal(p.$('launch-card-pair').dataset.mint,pair.mint);assert.equal(p.form.elements.namedItem('name').value,'Example');assert.equal(p.$('launch-asset-results').querySelector('button'),row);assert.match(p.$('launch-catalogue-note').textContent,/last checked pair list/);assert.equal(calls,2);
 broken=false;now+=60000;await p.catalogueTick();assert.equal(calls,3);assert.equal(p.$('launch-catalogue-note').textContent,'Availability is checked before launch.');p.controller.destroy();
});

test('late periodic administrator response cannot restore private pairs after logout',async()=>{
 let now=Date.now(),finish,calls=0;const p=await page({initial:null,now:()=>now,route:path=>path==='/api/session'?{authenticated:true,token:'admin-token',features:{walletOnly:false},account:{id:'owner',role:'admin',mfaEnabled:true},monitorAllowed:true}:path.endsWith('/quotes')?++calls===1?{assets:[{...LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),supported:true}],canViewComingSoon:true}:new Promise(resolve=>{finish=resolve;}):undefined});
 // The background read of the large Raydium pair list runs every five minutes while no picker or launch dialog is open.
 now+=300000;const tick=p.catalogueTick();await flush();p.document.dispatchEvent(new p.window.CustomEvent('curve-account-updated',{detail:{authenticated:false}}));finish({assets:[{mint:'3'.repeat(32),symbol:'PRIVATEWAIT',category:'stocks',supported:false}],canViewComingSoon:true});await tick;await flush();
 assert.equal(p.document.querySelector('[data-category=coming]').hidden,true);assert.doesNotMatch(p.$('launch-asset-results').textContent,/PRIVATEWAIT/);now+=300000;await p.catalogueTick();assert.equal(calls,2);p.controller.destroy();
});

test('catalogue changes during wallet approval do not alter the transaction or reopen approval',async()=>{
 let now=Date.now(),available=true,finishSigning;const mock=mockWallet();
 mock.wallet.features[SIGN].signTransaction=input=>{mock.calls.sign.push(input);return new Promise(resolve=>{finishSigning=resolve;});};
 const p=await page({initial:null,mock,now:()=>now,route:path=>path.endsWith('/quotes')?{assets:available?[{...LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),supported:true}]:[]}:undefined});await p.fill();await p.connect();await p.open();
 const submitting=p.form.onsubmit({preventDefault(){}});await flush();assert.equal(mock.calls.sign.length,1);assert.equal(typeof finishSigning,'function');
 const bytes=[...mock.calls.sign[0].transaction],budget=p.$('launch-budget-total').textContent,create=p.calls.find(c=>c.path.endsWith('/create')).body;
 available=false;now+=60000;await p.catalogueTick();assert.equal(p.$('launch-card-pair').dataset.mint,SOL_MINT);assert.equal(p.$('launch-budget-total').textContent,budget);assert.equal(p.$('launch-buy-dialog').open,true);assert.equal(mock.calls.sign.length,1);assert.deepEqual([...mock.calls.sign[0].transaction],bytes);
 finishSigning([{signedTransaction:new Uint8Array([4,5,6])}]);await submitting;assert.equal(mock.calls.sign.length,1);assert.equal(p.calls.filter(c=>c.path.endsWith('/create')).length,1);assert.deepEqual(p.calls.find(c=>c.path.endsWith('/create')).body,create);assert.equal(p.calls.find(c=>c.path.endsWith('/sign')).body.transaction,'BAUG');assert.equal(p.$('launch-toast').hidden,false);p.controller.destroy();
});

test('authorization failure drops Coming Soon immediately without erasing entered coin details',async()=>{
 let now=Date.now(),authorized=true;const p=await page({initial:null,now:()=>now,route:path=>path.endsWith('/quotes')?authorized?{canViewComingSoon:true,assets:[{...LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),supported:true},{mint:'3'.repeat(32),name:'Private waiting pair',symbol:'PRIVATEWAIT',category:'stocks',supported:false}]}:{ok:false,status:403,body:{error:'Refresh this page to reconnect.'}}:undefined});await p.fill();p.$('launch-asset-open').onclick();p.document.querySelector('[data-category=coming]').onclick();assert.match(p.$('launch-asset-results').textContent,/PRIVATEWAIT/);
 authorized=false;now+=60000;await p.catalogueTick();assert.equal(p.document.querySelector('[data-category=coming]').hidden,true);assert.doesNotMatch(p.$('launch-asset-results').textContent,/PRIVATEWAIT/);assert.equal(p.form.elements.namedItem('name').value,'Example');p.controller.destroy();
});

// v71.25 regressions.
const waitFor=async(check,message)=>{for(let n=0;n<100;n++){if(check())return;await flush();}assert.fail(message);};
test('a change event that only repeats a typed first buy keeps the prepared cost, so the first Create coin click goes through',async()=>{
  const p=await page({initial:null});await p.fill();await p.connect();await p.open();
  const prepares=()=>p.calls.filter(c=>c.path.endsWith('/prepare'));
  p.form.elements.namedItem('devBuySol').value='0.25';p.form.dispatchEvent(new p.window.Event('input'));
  await waitFor(()=>!p.$('launch-review-button').disabled&&prepares().at(-1)?.body.devBuySol==='0.25','the typed first buy was not prepared');
  const count=prepares().length,requestId=prepares().at(-1).body.requestId;
  // A click on Create coin takes focus from the amount field, whose change event arrives before the click.
  p.form.dispatchEvent(new p.window.Event('change'));
  assert.equal(p.$('launch-review-button').disabled,false,'the button under the pointer stays enabled');assert.notEqual(p.$('launch-ready-note').textContent,'Calculating your launch cost…');
  await p.form.onsubmit({preventDefault(){}});
  assert.equal(prepares().length,count,'no second preparation');const create=p.calls.find(c=>c.path.endsWith('/create')).body;
  assert.deepEqual([create.prepareId,create.requestId,create.devBuySol],['prepared-1',requestId,'0.25']);assert.equal(p.$('launch-toast').hidden,false);
  // The launched coin leaves the form, so the same click cannot create it twice.
  assert.equal(p.form.elements.namedItem('name').value,'');assert.equal(p.form.elements.namedItem('symbol').value,'');assert.equal(p.$('launch-image-preview').hidden,true);
  await p.open();assert.notEqual(p.$('launch-buy-dialog').open,true);assert.match(p.$('launch-error').textContent,/Add a coin image first|Enter a coin name/);assert.equal(p.calls.filter(c=>c.path.endsWith('/create')).length,1);
});
test('an invalid first buy is named next to the amount, and Create coin reopens the dialog to fix it',async()=>{
  const p=await page({initial:null});await p.fill();await p.connect();await p.open();
  const prepares=()=>p.calls.filter(c=>c.path.endsWith('/prepare')).length,amount=p.form.elements.namedItem('devBuySol');
  for(const [value,message] of [['0.0000000001',/at most 9 decimal places/],['-1',/plain positive decimal/],['99999999999',/too large/]]){
    amount.value=value;p.form.dispatchEvent(new p.window.Event('input'));await flush();
    assert.match(p.$('launch-dev-summary').textContent,message,value);assert.equal(p.$('launch-dev-summary').hidden,false);
    assert.equal(p.$('launch-ready-note').hidden,true,'the message is shown once, not with the generic details hint');assert.equal(p.$('launch-review-button').disabled,true);
  }
  const before=prepares();p.$('launch-buy-close').onclick();assert.equal(p.$('launch-buy-dialog').open,false);
  await p.open();assert.equal(p.$('launch-buy-dialog').open,true,'the dialog reopens with the amount to fix');assert.equal(p.$('launch-error').hidden,true);assert.match(p.$('launch-dev-summary').textContent,/too large/);
  assert.equal(prepares(),before,'an invalid amount is never prepared');
  amount.value='0.5';p.form.dispatchEvent(new p.window.Event('input'));await waitFor(()=>!p.$('launch-review-button').disabled,'a fixed amount was not prepared');assert.equal(p.$('launch-dev-summary').hidden,true);
});
test('an untouched saved draft says it waits for Create coin instead of claiming to work',async()=>{
  const p=await page({initial:launch('draft'),href:'http://app.local/launchpad?id=launch-1'});
  assert.equal(p.$('launch-buy-dialog').open,true);assert.equal(p.$('launch-progress-title').textContent,'Ready to launch');
  assert.match(p.$('launch-status-message').textContent,/Nothing happens until you select Create coin/);assert.doesNotMatch(p.$('launch-status-message').textContent,/Preparing and confirming/);
  p.setRecord({...launch('draft'),reviewExpires:Date.now()-1});await p.poll();assert.match(p.$('launch-status-message').textContent,/saved launch cost has expired/);p.controller.destroy();
});
test('an idle page reads its launches less and less often and not at all while hidden; a launch in progress is followed every tick',async()=>{
  const reads=p=>p.calls.filter(c=>c.path==='/api/launchpad').length;
  const idle=await page({initial:{...launch('live'),curve:OTHER}}),start=reads(idle);
  for(let tick=1;tick<=8;tick++)await idle.poll();
  assert.equal(reads(idle)-start,3,'ticks 1, 3 and 7 read the list');
  Object.defineProperty(idle.document,'hidden',{value:true,writable:true,configurable:true});for(let tick=0;tick<40;tick++)await idle.poll();assert.equal(reads(idle)-start,3,'a hidden tab reads nothing');
  idle.document.hidden=false;idle.document.dispatchEvent(new idle.window.Event('visibilitychange'));await idle.poll();assert.equal(reads(idle)-start,4,'one read when the tab is shown again');idle.controller.destroy();
  const busy=await page({initial:{...launch('launching'),walletMode:'default'}}),first=reads(busy);for(let tick=0;tick<3;tick++)await busy.poll();assert.equal(reads(busy)-first,3);busy.controller.destroy();
});
// The site router holds the page while a dialog is open unless it is marked data-navigation-free.
test('the Raydium launch dialog lets the site navigate while idle and holds it while its cost is calculated or the coin is created',async()=>{
  const gates={};let held='';
  const p=await page({initial:null,route:async path=>{if(held&&path.endsWith('/'+held)){const name=held;held='';await new Promise(resolve=>{gates[name]=resolve;});}return undefined;}});
  const dialog=p.$('launch-buy-dialog'),free=()=>dialog.hasAttribute('data-navigation-free');
  await p.fill();await p.connect();
  assert.equal(p.$('launch-wallet-dialog').hasAttribute('data-navigation-free'),true,'the wallet chooser holds nothing while no wallet request runs');
  held='prepare';await p.open();await waitFor(()=>gates.prepare,'the cost was not requested');
  assert.equal(dialog.open,true);assert.equal(free(),false,'calculating the launch cost holds navigation');
  gates.prepare();await waitFor(()=>!p.$('launch-review-button').disabled,'the cost was not prepared');assert.equal(free(),true,'an idle launch dialog lets the site navigate');
  held='create';const creating=p.form.onsubmit({preventDefault(){}});await waitFor(()=>gates.create,'the coin was not created');
  assert.equal(free(),false,'creating the coin holds navigation');
  gates.create();await creating;assert.equal(p.$('launch-toast').hidden,false);p.controller.destroy();
});
