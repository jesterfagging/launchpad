import {optimizeLaunchImage} from '../public/launch-image.mjs';
import {createChainSelect,initialLaunchChain,launchChainById} from '../public/launch-chains.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {parseHTML} from 'linkedom';
import {createPublicNavigation} from '../public/navigation.mjs';
import * as meteoraUiModule from '../public/meteora-ui.mjs';
import * as pumpUiModule from '../public/pump-launch-test-ui.mjs';
import {createQuoteIcon,createQuoteLabel} from '../public/quote-logos.mjs';
import {creatorFeeForLaunch} from '../public/creator-fee-schedule.mjs';
import {launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink} from '../public/launchpad-model.mjs';
import {LAUNCH_ASSETS} from '../public/launch-assets.mjs';

const WALLET='So11111111111111111111111111111111111111112';
const MINT='GNu1FSuype33KF4RXfow38Dw3ziw9e71FTBLVY5mdrTa';
const ORIGIN='https://launchpad.test';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const operation=(state='awaiting_signature',action='initialize')=>({id:'meteora-operation-'+action,action,wallet:WALLET,mint:MINT,state,transaction:'AQID',expiresAt:Date.now()+120000,signature:state==='awaiting_signature'?null:'1'.repeat(88),review:{maxWalletDebitLamports:'125000000',firstBuyRaw:'100000000',quoteMint:SOL_MINT,quoteSymbol:'SOL',quoteDecimals:9}});
const coinTemplate='<!doctype html><html><head><title>Coin — Launchpad</title><script type="module" src="/coin.js"></script></head><body><header class="app-header">header</header><main id="coin-page">Coin</main><footer class="site-footer">footer</footer></body></html>';
async function until(predicate,message){for(let n=0;n<100;n++){if(predicate())return;await delay(10);}assert.fail(message);}
function visible(element){return !!element&&!element.closest('[hidden]');}
function click(window,element){const event=new window.Event('click',{bubbles:true,cancelable:true});event.button=0;element.dispatchEvent(event);return event;}

async function page(t,{saved=null,confirmation='confirmed',holdConfirmation=false}={}){
  const {document,window}=parseHTML(await readFile(new URL('../public/launchpad.html',import.meta.url),'utf8'));
  const calls=[],signs=[],events=[],fallbacks=[],routeFetches=[];
  const historyRows=[{url:ORIGIN+'/launchpad',state:null}];let cursor=0,resolveReceipt,stage='configure';
  const location={get href(){return historyRows[cursor].url;},get origin(){return ORIGIN;},get pathname(){return new URL(this.href).pathname;},get search(){return new URL(this.href).search;}};
  const history={get state(){return historyRows[cursor].state;},replaceState(state,_,url){historyRows[cursor]={state,url:new URL(url,location.href).href};},pushState(state,_,url){events.push('history');historyRows.push({state,url:new URL(url,location.href).href});cursor++;}};
  Object.defineProperty(window,'location',{value:location,configurable:true});Object.defineProperty(window,'history',{value:history,configurable:true});window.scrollTo=()=>{};
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return[...this.options].find(o=>o.selected)?.value||this.options[0]?.value||'';},set(value){for(const o of this.options)o.removeAttribute('selected');[...this.options].find(o=>o.value===String(value))?.setAttribute('selected','');}});
  for(const input of document.querySelectorAll('input[type=radio],input[type=checkbox]'))input.checked=input.hasAttribute('checked');
  for(const dialog of document.querySelectorAll('dialog')){
    Object.defineProperty(dialog,'open',{configurable:true,get(){return this.hasAttribute('open');},set(value){value?this.setAttribute('open',''):this.removeAttribute('open');}});
    dialog.showModal=function(){this.open=true;};dialog.close=function(){if(this.open)events.push('close:'+this.id);this.open=false;};
  }
  window.HTMLElement.prototype.scrollIntoView=function(){};
  window.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},drawImage(){}});window.HTMLCanvasElement.prototype.toBlob=fn=>fn({size:30});
  const form=document.getElementById('launch-form');
  Object.defineProperty(form,'elements',{value:{namedItem(name){const rows=[...form.querySelectorAll('[name]')].filter(x=>x.name===name);return rows.length===1?rows[0]:{get value(){return rows.find(x=>x.checked)?.value||'';}};}}});
  class FileReader{readAsDataURL(){this.result='data:image/webp;base64,AAAA';this.onload();}}
  class FormData{constructor(form){this.form=form;}*[Symbol.iterator](){for(const input of this.form.querySelectorAll('[name]'))if(!input.disabled&&(!['checkbox','radio'].includes(input.type)||input.checked))yield[input.name,input.value];}}
  const launchWallet={state:()=>({address:WALLET,name:'Test wallet',wallets:[]}),onChange:()=>()=>{},sign:async payload=>{signs.push(payload);return'BAUG';}};
  const fetcher=async(path,options={})=>{
    const body=options.body?JSON.parse(options.body):undefined;calls.push({path,body});let data;
    if(path==='/api/session')data={authenticated:true,token:'csrf',features:{walletOnly:true},account:{id:'user',authType:'wallet',mainWallet:WALLET}};
    else if(path==='/api/launchpad/meteora/status')data={available:true,publicEnabled:true};
    else if(path==='/api/launchpad/meteora/pairs')data={pairs:[{mint:SOL_MINT,symbol:'SOL',name:'Solana',decimals:9,launchReady:true,supported:true}]};
    else if(path==='/api/launchpad/meteora/operations')data={operations:saved?[saved]:[]};
    else if(path==='/api/launchpad/meteora/prepare'){stage=body.mint?'initialize':'configure';data={operation:operation('awaiting_signature',stage)};}
    else if(path==='/api/launchpad/meteora/submit')data={operation:operation(stage==='configure'?'finalized':confirmation,stage),...(stage==='configure'?{nextAction:'initialize'}:{})};
    else if(path==='/api/launchpad/meteora/reconcile'){if(holdConfirmation)await new Promise(resolve=>{resolveReceipt=resolve;});data={operation:operation(confirmation)};}
    else if(path==='/api/launchpad/quotes')data={assets:LAUNCH_ASSETS.map(a=>({...a,supported:true})),canViewComingSoon:false};
    else if(path==='/api/launchpad/image')data={imageId:'a'.repeat(64)+'.webp'};
    else if(path==='/api/launchpad')data={launches:[]};
    else throw Error('Unexpected API '+path);
    return{ok:true,status:200,json:async()=>data};
  };
  const source=(await readFile(new URL('../public/launchpad.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'').replace("await import('./pump-launch-test-ui.mjs')",'pumpUiModule').replace("await import('./meteora-ui.mjs')",'meteoraUiModule').replace(/bootPage\('launchpad',mountPage\);/,'')+'\nreturn mountPage;';
  const deps={createChainSelect,initialLaunchChain,launchChainById,optimizeLaunchImage,pumpUiModule,meteoraUiModule,createQuoteIcon,createQuoteLabel,creatorFeeForLaunch,fetch:fetcher,FileReader,createImageBitmap:async()=>({width:8,height:8,close(){}}),crypto:{randomUUID},FormData,requestAnimationFrame:fn=>setTimeout(fn,0),setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout,matchMedia:()=>({matches:true}),createWorkspaceShell:()=>{},launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink,LAUNCH_ASSETS,createLaunchpadWallet:()=>launchWallet};
  const mount=new Function(...Object.keys(deps),source)(...Object.values(deps));
  let coinMounts=0;
  const router=createPublicNavigation({document,window,fallback:url=>fallbacks.push(url),fetcher:async path=>{routeFetches.push(path);if(path==='/coin'){assert.equal(document.querySelector('dialog[open]'),null,'dialog must close before router fetch');events.push('fetch:coin');}return{ok:true,headers:new Headers({'content-type':'text/html'}),text:async()=>coinTemplate};},importer:async()=>({mountPage:()=>{coinMounts++;return{canLeave:()=>true,destroy(){}};}})});
  const controller=router.start(mount);t.after(()=>router.destroy());await controller.ready;
  const $=id=>document.getElementById(id);
  form.elements.namedItem('name').value='Navigation test';form.elements.namedItem('symbol').value='NAV';
  Object.defineProperty($('launch-image'),'files',{value:[{type:'image/png',size:30}],configurable:true});await $('launch-image').onchange();
  document.querySelector('[data-launch-venue=meteora]').onclick();await until(()=>!$('launch-meteora-disclosure').hidden,'Meteora mode did not load');
  await until(()=>!$('launch-open').disabled,'Pair was not ready');
  return{document,window,controller,router,location,calls,signs,events,fallbacks,routeFetches,$,get coinMounts(){return coinMounts;},get resolveReceipt(){return resolveReceipt;},open:()=>$('launch-open').onclick()};
}

for(const confirmation of ['confirmed','finalized'])test('Open coin closes the '+confirmation+' launch dialog before same-document navigation',async t=>{
  const p=await page(t,{saved:operation('submitted'),confirmation});await p.open();
  await until(()=>p.$('launch-meteora-operation').querySelector('a[href="/coin?mint='+MINT+'"]')&&!p.$('launch-meteora-operation').querySelector('a[href="/coin?mint='+MINT+'"]').hidden,'Confirmed coin link not shown');
  const dialog=p.$('launch-meteora-dialog'),root=p.$('launch-meteora-operation');assert.equal(dialog.open,true);
  assert.equal(visible(root.querySelector('.meteora-operation-facts')),false,'completed launch must not keep fee review visible');
  assert.equal([...dialog.querySelectorAll('button')].some(button=>visible(button)&&/^(Review launch cost|Create coin)$/.test(button.textContent)),false,'completed launch must not offer review or another create');
  assert.equal(p.calls.filter(row=>row.path.endsWith('/prepare')||row.path.endsWith('/submit')||row.path.endsWith('/cancel')).length,0);assert.equal(p.signs.length,0);
  const originalHeader=p.document.querySelector('.app-header'),link=root.querySelector('a[href="/coin?mint='+MINT+'"]');
  const event=click(p.window,link);await until(()=>p.location.pathname==='/coin','Open coin did not navigate');
  assert.equal(event.defaultPrevented,true,'real SPA router must intercept the click');assert.equal(dialog.open,false);assert.equal(p.location.search,'?mint='+MINT);assert.equal(p.coinMounts,1);assert.equal(p.document.querySelector('.app-header'),originalHeader);assert.equal(p.document.querySelector('main').id,'coin-page');assert.deepEqual(p.fallbacks,[]);
  assert(p.events.indexOf('close:launch-meteora-dialog')<p.events.indexOf('fetch:coin'));assert(p.events.indexOf('fetch:coin')<p.events.indexOf('history'));
  assert.equal(p.calls.filter(row=>row.path.endsWith('/prepare')||row.path.endsWith('/submit')||row.path.endsWith('/cancel')).length,0);assert.equal(p.signs.length,0);
});

test('Meteora public launch uses one Create action for configuration and coin approvals without another review action',async t=>{
  const p=await page(t);await p.open();
  await until(()=>p.calls.some(row=>row.path==='/api/launchpad/meteora/prepare'),'Opening launch did not automatically prepare costs');
  const dialog=p.$('launch-meteora-dialog'),root=p.$('launch-meteora-operation');
  assert.equal([...dialog.querySelectorAll('button')].some(button=>visible(button)&&button.textContent==='Review launch cost'),false);
  await until(()=>[...root.querySelectorAll('button')].some(button=>visible(button)&&button.textContent==='Create coin'&&!button.disabled),'Create coin was not ready');
  const create=[...root.querySelectorAll('button')].find(button=>visible(button)&&button.textContent==='Create coin');await create.onclick();await until(()=>p.signs.length===2&&visible(root.querySelector('a[href="/coin?mint='+MINT+'"]')),'Configuration did not continue to coin approval');
  assert.equal(p.signs.length,2);assert.equal(p.calls.filter(row=>row.path==='/api/launchpad/meteora/prepare').length,2);assert.equal(p.calls.filter(row=>row.path==='/api/launchpad/meteora/submit').length,2);
  assert.equal(visible(root.querySelector('.meteora-operation-facts')),false);assert.equal([...dialog.querySelectorAll('button')].some(button=>visible(button)&&button.textContent==='Create coin'),false);
  click(p.window,root.querySelector('a[href="/coin?mint='+MINT+'"]'));await until(()=>p.location.pathname==='/coin','Coin did not open after the two launch approvals');assert.equal(p.signs.length,2);
});

test('a confirmed launch can open its coin while a background receipt read is slow',async t=>{
  const p=await page(t,{saved:operation('confirmed'),holdConfirmation:true});const opening=p.open();
  await until(()=>!!p.resolveReceipt,'Receipt read did not start');
  const dialog=p.$('launch-meteora-dialog'),link=p.$('launch-meteora-operation').querySelector('a[href="/coin?mint='+MINT+'"]');assert(link&&!link.hidden);
  click(p.window,link);await until(()=>p.location.pathname==='/coin','Background receipt read blocked the confirmed coin link');
  assert.equal(dialog.open,false);assert.equal(p.coinMounts,1);assert.deepEqual(p.fallbacks,[]);
  p.resolveReceipt();await opening;await delay(0);assert.equal(p.coinMounts,1);assert.equal(p.document.querySelector('main').id,'coin-page');
  assert.equal(p.calls.filter(row=>row.path.endsWith('/prepare')||row.path.endsWith('/submit')||row.path.endsWith('/cancel')).length,0);assert.equal(p.signs.length,0);
});
