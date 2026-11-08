import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createPersonalEarnings, earningsAmount, earningsWallet } from '../public/personal-earnings.mjs';

const WALLET='11111111111111111111111111111111',OTHER='So11111111111111111111111111111111111111112',MINT='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const section=patch=>({quoteTotals:[{mint:MINT,symbol:'USDC',decimals:6,amountUnits:'123456789',amount:'123.456789',usdEstimate:123.456789,priceAt:1700000000000}],usdEstimate:123.456789,observedUsdEstimate:123.456789,historyComplete:true,valuationComplete:true,valuationBasis:'current_quote_prices',paymentCount:3,lastPaymentAt:1700000000000,...patch});
const snapshot=patch=>({wallet:WALLET,requiresWalletSignIn:false,updatedAt:1700000000000,refreshMs:60000,stale:false,scope:'confirmed_curve_payments',creator:section(),holders:section(),...patch});
const session=(wallet=WALLET)=>({authenticated:true,account:{id:'a'.repeat(32),mainWallet:wallet}});
function view({respond=async()=>snapshot()}={}){
  const {document}=parseHTML('<html><body><section id="earnings"></section></body></html>');Object.defineProperty(document,'hidden',{value:false,writable:true});
  const root=document.getElementById('earnings'),calls=[];let now=1700000000000,visible=true;
  const ui=createPersonalEarnings({document,root,clock:()=>now,visible:()=>visible,api:async path=>{calls.push(path);return respond(path);}});ui.setSession(session());
  return{ui,root,document,calls,advance:ms=>{now+=ms;},visible:value=>{visible=value;}};
}

test('personal earnings render two distinct private received totals with exact native units and current USD labels',async()=>{
  const p=view();await p.ui.load();assert.deepEqual(p.calls,['/api/launchpad/earnings']);
  assert.equal(p.root.querySelectorAll('[data-earnings]').length,2);assert.match(p.root.textContent,/Creator rewards received/);assert.match(p.root.textContent,/Holder rewards received/);
  assert.match(p.root.querySelector('[data-earnings="creator"] .personal-earnings-value').textContent,/123\.46/);assert.match(p.root.textContent,/123\.456789/);assert.match(p.root.textContent,/Estimated current value/);assert.match(p.root.textContent,/3 confirmed payments/);assert.match(p.root.textContent,/Private to you/);assert.match(p.root.textContent,/including assigned creator fees/);
  assert.equal(earningsAmount('900719925474099312345678',9),'900,719,925,474,099.312345678');p.ui.destroy();
});

test('missing prices and incomplete history preserve native amounts without pretending to show a full USD total',async()=>{
  const p=view({respond:async()=>snapshot({creator:section({usdEstimate:null,observedUsdEstimate:null,valuationComplete:false}),holders:section({historyComplete:false,usdEstimate:123.456789,observedUsdEstimate:100})})});await p.ui.load();
  const creator=p.root.querySelector('[data-earnings="creator"]'),holders=p.root.querySelector('[data-earnings="holders"]');
  assert.equal(creator.querySelector('.personal-earnings-value').textContent,'123.456789 USDC');assert.match(creator.textContent,/USD pricing is incomplete/);assert(!creator.textContent.includes('$0'));
  assert.equal(holders.querySelector('.personal-earnings-value').textContent,'123.456789 USDC');assert.match(holders.textContent,/Recorded payments/);assert.match(holders.textContent,/Priced subtotal/);assert.match(holders.textContent,/Some earlier payments may be unavailable/);p.ui.destroy();
});

test('empty complete receipt history differs from unavailable earlier history',async()=>{
  const p=view({respond:async()=>snapshot({creator:section({quoteTotals:[],usdEstimate:0,observedUsdEstimate:0,paymentCount:0,lastPaymentAt:null}),holders:section({quoteTotals:[],usdEstimate:null,observedUsdEstimate:null,historyComplete:false,paymentCount:0,lastPaymentAt:null})})});await p.ui.load();
  assert.match(p.root.querySelector('[data-earnings="creator"] .personal-earnings-value').textContent,/0\.00/);
  assert.equal(p.root.querySelector('[data-earnings="holders"] .personal-earnings-value').textContent,'—');assert.match(p.root.textContent,/Earlier payout history is incomplete/);p.ui.destroy();
});

test('native asset breakdowns remain compact, safe as text, and never coerce invalid amounts',async()=>{
  const rows=[WALLET,OTHER,MINT,'7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc'].map((mint,index)=>({mint,symbol:index?'ASSET':'<img src=x onerror=bad()>',decimals:9,amountUnits:'900719925474099312345678'}));
  const p=view({respond:async()=>snapshot({creator:section({quoteTotals:rows,usdEstimate:null,observedUsdEstimate:null,valuationComplete:false})})});await p.ui.load();
  assert.equal(p.root.querySelector('script,img'),null);assert.match(p.root.textContent,/<img src=x/);assert(p.root.querySelector('[data-earnings="creator"] details'));assert.match(p.root.textContent,/View 4 assets/);assert.match(p.root.textContent,/900,719,925,474,099\.312345678/);p.ui.destroy();
  for(const bad of ['-1','1e9','1.25',1,null])assert.equal(earningsAmount(bad,9),'—');
});

test('polls coalesce, remain bounded at 60 seconds, and stop on hidden pages or inactive view',async()=>{
  let finish;const p=view({respond:()=>new Promise(resolve=>{finish=resolve;})});const read=p.ui.load();await p.ui.load();assert.equal(p.calls.length,1);finish(snapshot({refreshMs:1}));await read;
  p.advance(59999);await p.ui.load();assert.equal(p.calls.length,1);p.advance(1);p.document.hidden=true;await p.ui.load();assert.equal(p.calls.length,1);p.document.hidden=false;p.visible(false);await p.ui.load();assert.equal(p.calls.length,1);
  p.visible(true);const second=p.ui.load();assert.equal(p.calls.length,2);finish(snapshot());await second;p.ui.destroy();p.advance(60000);await p.ui.load();assert.equal(p.calls.length,2);
});

test('account switch clears private amounts immediately and discards late old-wallet responses',async()=>{
  let finish;const p=view({respond:()=>new Promise(resolve=>{finish=resolve;})});const old=p.ui.load();p.ui.setSession(session(OTHER));assert(!p.root.textContent.includes('123.456789'));finish(snapshot());await old;assert(!p.root.textContent.includes('123.456789'));
  const latest=p.ui.load();finish(snapshot({wallet:OTHER,creator:section({amount:'irrelevant'})}));await latest;assert.match(p.root.textContent,/123\.456789/);
  p.ui.setSession({authenticated:false});assert.equal(p.root.hidden,true);assert.equal(p.root.textContent,'Your rewards');p.ui.destroy();
});

test('permission errors clear saved totals, raw RPC errors stay private and old responses cannot repopulate after clear',async()=>{
  let response=snapshot();const p=view({respond:async()=>{if(response instanceof Error)throw response;return response;}});await p.ui.load();
  response=Object.assign(Error('RPC https://secret-api.invalid/key'),{statusCode:503});p.advance(60000);await p.ui.load();assert.match(p.root.textContent,/123\.456789/);assert.match(p.root.textContent,/Update delayed/);assert(!p.root.textContent.includes('secret-api'));
  response=Object.assign(Error('forbidden'),{statusCode:403});p.advance(60000);await p.ui.load();assert(!p.root.textContent.includes('123.456789'));p.ui.destroy();
  let finish;const late=view({respond:()=>new Promise(resolve=>{finish=resolve;})});const pending=late.ui.load();late.ui.clear();finish(snapshot());await pending;assert.equal(late.root.hidden,true);assert(!late.root.textContent.includes('123.456789'));
});

test('wrong-wallet and invalid snapshots never display a private payout and no-wallet sessions do not fetch',async()=>{
  for(const response of [snapshot({wallet:OTHER}),snapshot({scope:'public'}),snapshot({creator:section({quoteTotals:[{mint:MINT,symbol:'USD',decimals:6,amountUnits:'-1'}]})})]){
    const p=view({respond:async()=>response});await p.ui.load();assert(!p.root.textContent.includes('123.456789'));assert.match(p.root.textContent,/temporarily unavailable/);p.ui.destroy();
  }
  const p=view();p.ui.setSession({authenticated:true,account:{id:'legacy'}});await p.ui.load();assert.equal(p.calls.length,0);assert.match(p.root.textContent,/Connect your receiving wallet/);p.ui.destroy();
  assert.equal(earningsWallet({authenticated:true,authMethod:'wallet',walletAddress:OTHER,account:{mainWallet:WALLET}}),OTHER);
  assert.equal(earningsWallet({authenticated:true,account:{signInWallet:OTHER,mainWallet:WALLET}}),OTHER);
});

test('server wallet-verification requirement removes cached totals and gives a reconnect instruction',async()=>{
  let response=snapshot();const p=view({respond:async()=>response});await p.ui.load();assert.match(p.root.textContent,/123\.456789/);
  response={scope:'confirmed_curve_payments',wallet:null,requiresWalletSignIn:true};p.advance(60000);await p.ui.load();assert(!p.root.textContent.includes('123.456789'));assert.match(p.root.textContent,/Connect your receiving wallet/);assert.match(p.root.textContent,/Wallet required/);p.ui.destroy();
});
