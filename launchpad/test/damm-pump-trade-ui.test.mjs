import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createDammPumpTrade} from '../public/damm-pump-trade-ui.mjs';
import {createPublicPumpTrade} from '../public/pump-public-trade-ui.mjs';
import {createCoinTrade} from '../public/coin-trade.mjs';
import {createLaunchAmmBadge} from '../public/amm-branding.mjs';
const A='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',B='HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF',M='GNu1FSuype33KF4RXfow38Dw3ziw9e71FTBLVY5mdrTa',Q='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const session={authenticated:true,token:'csrf',account:{id:'creator',mainWallet:A},walletVerified:true,walletAddress:A};
const coin={platform:'damm-pump',mint:M,symbol:'COIN',stage:'new',curveStatus:'curve',quote:{mint:Q,symbol:'STOCK',decimals:6},baseDecimals:6};
function fixture(t,{quoteDecimals=6,quote=coin.quote,response}={}){
 const {document}=parseHTML('<html><head></head><body><main></main></body></html>'),root=document.querySelector('main'),calls=[];let address=A,listener;
 const wallet={state:()=>({address,wallets:[]}),onChange:fn=>{listener=fn;return()=>{};},sign:async input=>{calls.push(['sign',input]);return 'signed';}};
 let prepared;const fetcher=async(path,options)=>{const body=options?.body?JSON.parse(options.body):undefined;calls.push([path,body]);let value=response?.(path,body);
  if(value===undefined){if(path.endsWith('/wallet'))value={wallet:A,nativeBalanceLamports:'10000000',quoteBalanceRaw:'2345678',baseBalanceRaw:'9876543'};else if(path.endsWith('/operations'))value={operations:[]};else if(path.endsWith('/prepare'))value={operation:prepared={id:'operation-123',action:body.action,wallet:A,mint:M,state:'awaiting_signature',expiresAt:200000,transaction:'AQID',review:{maxWalletDebitLamports:'5000',quoteMint:Q,quoteDecimals,amountRaw:body.amountRaw,expectedOutputRaw:'2000000',minOutputRaw:'1800000'}}};else if(path.endsWith('/submit'))value={operation:{...prepared,state:'finalized',signature:'2'.repeat(88)}};else throw Error(path);}
  return {ok:true,status:200,json:async()=>value};};
 const controller=createDammPumpTrade({document,window:{setTimeout,clearTimeout},root,fetcher,walletFactory:()=>wallet,clock:()=>100000,setTimer:()=>0,clearTimer:()=>{}});t.after(()=>controller.destroy());controller.setCoin({...coin,quote});controller.setSession(session);
 return {root,calls,controller,get:name=>root.querySelector('[data-mt-'+name+']'),changeWallet(){address=B;listener();}};
}
test('DAMM→PumpSwap buy signs once with exact six-decimal quote units and keeps fee amounts in quote units',async t=>{
 const f=fixture(t);await flush();assert.match(f.get('balance').textContent,/2\.345678/);assert.equal(f.get('unit').textContent,'STOCK');f.get('amount').value='1.234567';await f.get('review').onclick();const prepare=f.calls.find(([path])=>path.endsWith('/prepare'));assert.equal(prepare[1].amountRaw,'1234567');assert.equal(f.calls.filter(([path])=>path==='sign').length,1);assert.equal(f.calls.filter(([path])=>path.endsWith('/submit')).length,1);assert.match(f.root.textContent,/1\.25%/);
});
test('DAMM→PumpSwap buy refuses extra quote decimals and a wrong-decimal review before wallet signing',async t=>{
 const f=fixture(t,{quoteDecimals:9});await flush();f.get('amount').value='1.0000001';await f.get('review').onclick();assert.equal(f.calls.some(([path])=>path.endsWith('/prepare')),false);f.get('amount').value='1.2';await f.get('review').onclick();assert.equal(f.calls.some(([path])=>path==='sign'),false);assert.equal(f.calls.some(([path])=>path.endsWith('/submit')),false);
});
test('graduated DAMM→PumpSwap coins keep the dedicated decimal-aware DAMM trade route',async t=>{
 const f=fixture(t);f.controller.setCoin({...coin,stage:'graduated',curveStatus:'migrated'});await flush();assert.match(f.get('progress').textContent,/PumpSwap/);f.get('sell').onclick();f.get('amount').value='2.5';await f.get('review').onclick();assert.equal(f.calls.find(([path])=>path.endsWith('/prepare'))[1].action,'sell');assert.equal(f.calls.find(([path])=>path.endsWith('/prepare'))[1].amountRaw,'2500000');
});

test('PumpSwap badge uses the public mode name and preserves graduation state',()=>{
 const {document}=parseHTML('<html><head></head><body></body></html>');const launch=createLaunchAmmBadge(document,{...coin,launchMode:'damm-pump'}),graduated=createLaunchAmmBadge(document,{...coin,launchMode:'damm-pump',stage:'graduated'});assert.equal(launch.title,'PumpSwap');assert.equal(graduated.title,'Graduated to PumpSwap');
});
test('coin trade dispatcher retains the DAMM→PumpSwap endpoint through graduation',async t=>{
 const {document}=parseHTML('<html><head></head><body><main></main></body></html>'),root=document.querySelector('main'),paths=[],wallet={state:()=>({address:A,wallets:[]}),onChange:()=>()=>{},sign:async()=>{throw Error('No automatic signing');}};
 const controller=createCoinTrade({document,window:{setTimeout,clearTimeout},root,walletFactory:()=>wallet,setTimer:()=>0,clearTimer:()=>{},fetcher:async path=>{paths.push(path);return{ok:true,json:async()=>path.endsWith('/operations')?{operations:[]}:{nativeBalanceLamports:'1',quoteBalanceRaw:'1',baseBalanceRaw:'1'}};}});t.after(()=>controller.destroy());controller.setSession(session);controller.setCoin(coin);await flush();controller.setCoin({...coin,stage:'graduated',curveStatus:'migrated'});await controller.refresh();await flush();assert(paths.length>0);assert(paths.every(path=>path.startsWith('/api/launchpad/damm-pump/')));assert.match(root.textContent,/Trading on PumpSwap/);
});

const atomicReview=extra=>({atomicGraduation:true,budgetIncludesAccountRent:true,quoteMint:Q,quoteDecimals:6,quoteSymbol:'STOCK',inputRaw:'1000000',chargedRaw:'250000',maxQuoteDebitRaw:'1000000',expectedQuoteDebitRaw:'250000',unusedQuoteBudgetRaw:'750000',expectedWalletDebitLamports:'50005000',maxWalletDebitLamports:'50005000',networkFeeLamports:'5000',accountSetupLamports:'50000000',expectedOutputRaw:'2000000',minOutputRaw:'1800000',...extra});
const atomicOperation=review=>({id:'atomic-operation-123',action:'buy',wallet:A,mint:M,state:'awaiting_signature',expiresAt:200000,transaction:'AQID',review:review||atomicReview()});
const approveAtomic=f=>[...f.root.querySelectorAll('button')].find(button=>button.textContent==='Approve buy + graduation');
test('atomic final buy reviews partial quote spend and graduation costs before its single wallet approval',async t=>{
 const saved=atomicOperation(),f=fixture(t,{response:path=>path.endsWith('/prepare')?{operation:saved}:path.endsWith('/submit')?{operation:{...saved,state:'finalized',signature:'2'.repeat(88)}}:undefined});await flush();f.get('amount').value='1';await f.get('review').onclick();
 assert.equal(f.calls.filter(([path])=>path==='sign').length,0);assert.equal(f.calls.filter(([path])=>path.endsWith('/submit')).length,0);assert.match(f.root.textContent,/Buy budget \(max\)1 STOCK/);assert.match(f.root.textContent,/Expected buy spend0.25 STOCK/);assert.match(f.root.textContent,/Expected unused budget0.75 STOCK/);assert.match(f.root.textContent,/Network fee \(included\)0.000005 SOL/);assert.match(f.root.textContent,/Account setup, including graduation0.05 SOL/);assert.match(f.root.textContent,/Maximum SOL debit \(costs\)0.050005 SOL/);assert.match(f.root.textContent,/Unspent buy funds stay in your wallet/);assert.doesNotMatch(f.root.textContent,/You pay1 STOCK/);
 await approveAtomic(f).onclick();assert.equal(f.calls.filter(([path])=>path==='sign').length,1);assert.equal(f.calls.filter(([path])=>path.endsWith('/submit')).length,1);assert.equal(f.calls.find(([path])=>path==='sign')[1].kind,'curve-damm-pump-buy');
});
test('native final buy separates the requested SOL budget from expected spend and total maximum debit',async t=>{
 const sol='So11111111111111111111111111111111111111112',saved=atomicOperation(atomicReview({quoteMint:sol,quoteDecimals:9,quoteSymbol:'SOL',inputRaw:'1000000000',maxQuoteDebitRaw:'1000000000',chargedRaw:'100000000',expectedQuoteDebitRaw:'100000000',unusedQuoteBudgetRaw:'900000000',expectedWalletDebitLamports:'150005000',maxWalletDebitLamports:'1050005000'})),f=fixture(t,{quoteDecimals:9,quote:{mint:sol,symbol:'SOL',decimals:9},response:path=>path.endsWith('/prepare')?{operation:saved}:undefined});await flush();f.get('amount').value='1';await f.get('review').onclick();
 assert.match(f.root.textContent,/Buy budget \(max\)1 SOL/);assert.match(f.root.textContent,/Expected buy spend0.1 SOL/);assert.match(f.root.textContent,/Expected unused budget0.9 SOL/);assert.match(f.root.textContent,/Maximum SOL debit \(buy \+ costs\)1.050005 SOL/);assert.equal(f.calls.filter(([path])=>path==='sign').length,0);assert(approveAtomic(f));
});
test('incomplete or inconsistent atomic graduation reviews never reach wallet approval',async t=>{
 for(const extra of [{accountSetupLamports:undefined},{budgetIncludesAccountRent:false},{chargedRaw:'1000001',expectedQuoteDebitRaw:'1000001'},{unusedQuoteBudgetRaw:'0'},{maxQuoteDebitRaw:'2000000'},{expectedQuoteDebitRaw:'1'},{expectedWalletDebitLamports:'60000000'},{networkFeeLamports:'-1'},{minOutputRaw:'3000000'},{atomicGraduation:'true'}]){
  const f=fixture(t,{response:path=>path.endsWith('/prepare')?{operation:atomicOperation(atomicReview(extra))}:undefined});await flush();f.get('amount').value='1';await f.get('review').onclick();assert.equal(f.calls.some(([path])=>path==='sign'||path.endsWith('/submit')),false);assert.match(f.root.textContent,/incomplete or invalid/);
 }
});
test('wallet changes invalidate an unapproved final-buy graduation review',async t=>{
 const f=fixture(t,{response:path=>path.endsWith('/prepare')?{operation:atomicOperation()}:undefined});await flush();f.get('amount').value='1';await f.get('review').onclick();const approve=approveAtomic(f);assert(approve);f.changeWallet();await approve.onclick();assert.equal(f.calls.some(([path])=>path==='sign'||path.endsWith('/submit')),false);
});

test('PumpSwap trade cards name the slippage field in slippage errors, and switching Buy/Sell clears earlier messages',async t=>{
 const f=fixture(t);await flush();f.get('amount').value='1';
 for(const value of ['','abc','0.001','101']){f.get('slippage').value=value;await f.get('review').onclick();assert.equal(f.get('status').textContent,'Enter slippage from 0% to 100%, with up to two decimal places.',JSON.stringify(value));}
 assert.equal(f.calls.some(([path])=>path.endsWith('/prepare')),false);f.get('sell').onclick();assert.equal(f.get('status').textContent,'');
 f.get('buy').onclick();f.get('amount').value='1';f.get('slippage').value='1';await f.get('review').onclick();await flush();assert.equal(f.get('operation').hidden,false);f.get('sell').onclick();assert.equal(f.get('operation').hidden,true);
 // The legacy Launchpad→PumpSwap curve card shares the same slippage wording and side behaviour.
 const {document}=parseHTML('<html><head></head><body><main></main></body></html>'),root=document.querySelector('main'),calls=[];
 const wallet={state:()=>({address:A,wallets:[]}),onChange:()=>()=>{},sign:async()=>'signed'};
 const fetcher=async(path,options)=>{calls.push(path);const value=path.endsWith('/wallet')?{wallet:A,nativeBalanceLamports:'10000000',baseBalanceRaw:'9876543'}:path.endsWith('/operations')?{operations:[]}:{};return {ok:true,status:200,json:async()=>value};};
 const legacy=createPublicPumpTrade({document,window:{setTimeout,clearTimeout},root,fetcher,walletFactory:()=>wallet,clock:()=>100000,setTimer:()=>0,clearTimer:()=>{}});t.after(()=>legacy.destroy());
 legacy.setCoin({platform:'pumpswap',mint:M,symbol:'COIN',stage:'new',curveStatus:'curve'});legacy.setSession(session);await flush();
 const pp=name=>root.querySelector('[data-pp-'+name+']');pp('amount').value='1';pp('slippage').value='abc';await pp('review').onclick();assert.equal(pp('status').textContent,'Enter slippage from 0% to 100%, with up to two decimal places.');assert(!calls.some(path=>path.endsWith('/prepare')));
 pp('sell').onclick();assert.equal(pp('status').textContent,'');assert.equal(pp('sell').getAttribute('aria-pressed'),'true');
});
