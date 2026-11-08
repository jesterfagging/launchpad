import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { AdminRevenue } from '../src/admin-revenue.mjs';
import { publicRevenueAnalytics } from '../src/public-revenue-analytics.mjs';
import { SOL } from '../src/core.mjs';

const now=1800000000000,admin='a'.repeat(32),user='b'.repeat(32),address=()=>Keypair.generate().publicKey.toBase58();
const asset=(mint,decimals,grossAmount)=>({scope:'launchpad',chain:'solana',mint,decimals,symbol:'PRIVATE-HIDDEN-SYMBOL',grossAmount,paidAmount:'9999999999999',pendingAmount:'9999999999999'});
const product=(id,totals=[],revenueComplete=true)=>({id,scope:'launchpad',revenueComplete,totals,status:'partial',note:'SECRET-ADMIN-INFORMATION'});
const report=products=>({at:now,products,wallets:{launchpad:'PRIVATE-TREASURY-ADDRESS'},totals:[asset(SOL,9,'999999999999999999')]});
const prices=()=>new Map([[SOL,{usd:150,at:now}]]);
function fixture(){
  const users=[{id:admin,role:'admin',mfaEnabled:true},{id:user,role:'user'}],books=new Map(),host={'launch-protocol-fees':{recipient:address(),recipientScope:'launchpad',creationFeeSol:'0.01'}};
  const h={users,books,host,scans:0,bookReads:0,clock:now,sourceRows:[]};
  const accounts={get:async id=>users.find(row=>row.id===id),list:async()=>{h.scans++;return users;},hostStore:{read:async(name,fallback)=>host[name]??fallback,write:()=>assert.fail('public revenue is read-only')},storeFor:()=>assert.fail('inactive toolkit is not scanned')};
  const launchpad={book:async id=>{h.bookReads++;if(h.bookError&&id===user)throw Error('private-password');return books.get(id)||{launches:[]};}};
  h.service=new AdminRevenue({accounts,launchpad,now:()=>h.clock,toolkit:false,meteoraSources:async()=>h.sourceRows});
  return h;
}
const launch=()=>({id:'1'.repeat(32),curve:address(),input:{route:'raydium',network:'mainnet-beta',quoteMint:SOL,quoteSymbol:'SOL',symbol:'PRIVATE-HIDDEN-SYMBOL',taxBps:0},review:{quoteDecimals:9,quoteSymbol:'SOL',protocolFees:{creationFeeSol:'0.01'}},keys:{mint:{address:address()},wallet:{secret:'private-wallet-key'}},operations:[]});

test('public projection values only earned launchpad gross once and reveals no asset identities or administrative fields',()=>{
  const input=report([product('curve',[asset(SOL,9,'1000000000')]),product('lp',[asset(SOL,9,'2000000000')]),{...product('copy',[asset(SOL,9,'999999999999')]),scope:'toolkit'}]),before=structuredClone(input);
  const out=publicRevenueAnalytics(input,{pricesByMint:prices(),now});assert.equal(out.totalUsdEstimate,450);assert.equal(out.pricedUsdEstimate,450);assert.equal(out.status,'available');assert.equal(out.complete,true);assert.equal(out.coverage.assetCount,1);
  assert.deepEqual(input,before);assert(!JSON.stringify(out).includes('PRIVATE'));assert(!JSON.stringify(out).includes('SECRET'));assert(!JSON.stringify(out).includes(SOL));assert(!('byAsset' in out));assert(!('wallets' in out));assert(!('products' in out));
});

test('base-token LP revenue is priced from cached tokenPrice and missing prices yield an explicit USD subtotal',()=>{
  const mint=address(),input=report([product('lp',[asset(SOL,9,'1000000000'),asset(mint,6,'2500000')])]);let calls=0;
  let out=publicRevenueAnalytics(input,{pricesByMint:prices(),tokenPrice:key=>{calls++;return key===mint?{mint,usd:'2',at:now}:null;},now});assert.equal(out.totalUsdEstimate,155);assert.equal(calls,1);assert.equal(out.coverage.pricedAssets,2);
  out=publicRevenueAnalytics(input,{pricesByMint:prices(),now});assert.equal(out.totalUsdEstimate,null);assert.equal(out.pricedUsdEstimate,150);assert.equal(out.status,'partial');assert.equal(out.historyComplete,true);assert.equal(out.pricingComplete,false);assert.equal(out.coverage.unpricedAssets,1);
  out=publicRevenueAnalytics(input,{now});assert.equal(out.totalUsdEstimate,null);assert.equal(out.pricedUsdEstimate,null);assert.equal(out.coverage.unpricedAssets,2);
});

test('stale, future, conflicting, zero and invalid prices never become zero-valued revenue',()=>{
  const input=report([product('curve',[asset(SOL,9,'1000000000')])]);
  for(const price of [{mint:address(),usd:150,at:now},{usd:150,at:now-120001},{usd:150,at:now+5001},{usd:0,at:now},{usd:Infinity,at:now},{usd:'NaN',at:now},{usd:150,at:now,stale:true}]){
    const out=publicRevenueAnalytics(input,{pricesByMint:new Map([[SOL,price]]),now});assert.equal(out.totalUsdEstimate,null);assert.equal(out.pricedUsdEstimate,null);assert.equal(out.pricingComplete,false);
  }
});

test('partial history prevents a full total while known recorded amounts remain a priced subtotal; complete empty history is a real zero',()=>{
  const input=report([product('curve',[asset(SOL,9,'1000000000')],false),product('lp')]);
  let out=publicRevenueAnalytics(input,{pricesByMint:prices(),now});assert.equal(out.totalUsdEstimate,null);assert.equal(out.pricedUsdEstimate,150);assert.equal(out.historyComplete,false);assert.equal(out.pricingComplete,true);
  out=publicRevenueAnalytics(report([product('curve')]),{now});assert.equal(out.totalUsdEstimate,0);assert.equal(out.complete,true);
  out=publicRevenueAnalytics(report([product('curve',[],false)]),{now});assert.equal(out.totalUsdEstimate,null);assert.equal(out.pricedUsdEstimate,null);assert.equal(out.status,'unavailable');
  for(const invalid of [null,{at:now,products:[]},{at:now+6000,products:[product('curve')]},report([product('curve',[asset(SOL,9,'-1')])])])assert.equal(publicRevenueAnalytics(invalid,{pricesByMint:prices(),now}).totalUsdEstimate,null);
});

test('shared cached report includes confirmed platform and LP claims once, excludes payouts, buybacks, contributions and holder rewards',async()=>{
  const h=fixture(),l=launch();
  l.operations=[
    {kind:'create',state:'confirmed',signature:'create',creationFeeReceipt:{mint:SOL,decimals:9,amount:'10000000',recipient:address()}},
    {kind:'protocol-claim',state:'confirmed',signature:'claim',receipt:{quoteDelta:'1000000000',baseDelta:'0'}},
    {kind:'protocol-lp-claim',state:'confirmed',signature:'lp',receipt:{quoteDelta:'2000000000',baseDelta:'5000000'}},
    {kind:'protocol-lp-payout',state:'confirmed',signature:'forward',receipt:{quoteDelta:'-3000000000',baseDelta:'-5000000'}},
    ...['payout','buy','burn','claim','tax','external-contribution'].map((kind,index)=>({kind,state:'confirmed',signature:`excluded-${index}`,amount:'999999999999999',receipt:{quoteDelta:'999999999999999',baseDelta:'999999999999999'}})),
    {kind:'protocol-claim',state:'pending',signature:'pending',receipt:{quoteDelta:'999999999999999',baseDelta:'0'}},
  ];
  l.taxProtocol={policy:'collected-tax-proceeds-v1',shareBps:500,convertedQuote:'2000000000',holderQuote:'1900000000',accruedQuote:'100000000',paidQuote:'80000000',creditQuote:'20000000',roundingRemainder:'0'};
  h.books.set(user,{launches:[l,structuredClone(l)]});h.host['protocol-treasury']={totals:{receivedSol:'999999999999999',buybackSpent:'999999999999999'}};
  const priceOptions={pricesByMint:prices(),tokenPrice:mint=>mint===l.keys.mint.address?{mint,usd:2,at:now}:null};
  const [out,adminView,parallel]=await Promise.all([h.service.readPublic(priceOptions),h.service.read(admin),h.service.readPublic(priceOptions)]);
  assert.equal(h.scans,1);assert.equal(h.bookReads,2);assert.deepEqual(out,parallel);assert.equal(out.totalUsdEstimate,476.5);assert.equal(out.complete,true);
  assert.equal(adminView.products.find(p=>p.id==='lp').status,'partial');assert.equal(adminView.products.find(p=>p.id==='lp').revenueComplete,true);
  const text=JSON.stringify(out);for(const privateValue of ['private-wallet-key','PRIVATE-HIDDEN-SYMBOL',l.keys.mint.address,admin,user])assert(!text.includes(privateValue));
  await h.service.readPublic(priceOptions);assert.equal(h.scans,1);
});

test('unknown old receipts and unreadable account books are partial without inferring revenue from requested amounts or transfers',async()=>{
  const h=fixture(),l=launch();l.operations=[{kind:'protocol-claim',state:'confirmed',signature:'known',receipt:{quoteDelta:'1000000000',baseDelta:'0'}},{kind:'protocol-lp-claim',state:'confirmed',signature:'unknown',amount:'999999999999'}];h.books.set(user,{launches:[l]});
  let out=await h.service.readPublic({pricesByMint:prices()});assert.equal(out.totalUsdEstimate,null);assert.equal(out.pricedUsdEstimate,150);assert.equal(out.historyComplete,false);
  h.clock+=15000;h.bookError=true;out=await h.service.readPublic({pricesByMint:prices()});assert.equal(out.totalUsdEstimate,null);assert.equal(out.pricedUsdEstimate,null);assert(!JSON.stringify(out).includes('private-password'));
});

test('creation self-payments are excluded and historical payouts without matching claims cannot hide behind another launch income',async()=>{
  const h=fixture(),first=launch(),second=launch();
  first.operations=[{kind:'create',state:'confirmed',signature:'self',creationFeeReceipt:{mint:SOL,decimals:9,amount:'10000000',recipient:address(),selfPayment:true}},{kind:'protocol-claim',state:'confirmed',signature:'first-claim',receipt:{quoteDelta:'1000000000',baseDelta:'0'}}];
  second.operations=[{kind:'protocol-payout',state:'confirmed',signature:'older-payout',receipt:{quoteDelta:'-500000000',baseDelta:'0'}}];
  h.books.set(user,{launches:[first,second]});const out=await h.service.readPublic({pricesByMint:prices()});assert.equal(out.totalUsdEstimate,null);assert.equal(out.pricedUsdEstimate,150);assert.equal(out.historyComplete,false);
});

test('Meteora finalized source receipts join launchpad revenue once and source errors produce partial coverage',async()=>{
  const h=fixture(),mint=address(),source={kind:'meteora-partner-payout',signature:bs58Signature(),mint:SOL,decimals:9,symbol:'SOL',amount:'2000000000',wallet:address(),sourceWallet:address(),launchMint:mint};
  h.sourceRows=[source,{...source}];let out=await h.service.readPublic({pricesByMint:prices()});assert.equal(out.totalUsdEstimate,300);assert.equal(out.complete,true);
  h.clock+=15000;h.service.meteoraSources=async()=>{throw Error('private-provider-key');};out=await h.service.readPublic({pricesByMint:prices()});assert.equal(out.totalUsdEstimate,null);assert.equal(out.historyComplete,false);assert(!JSON.stringify(out).includes('private-provider-key'));
});

function bs58Signature(){return '5'.repeat(88);}

test('truncated operation history and cumulative claims only downgrade coverage, never create earned revenue',async()=>{
  for(const patch of [{historyTruncated:true},{operationsTruncated:true},{protocolClaimed:'10000000000'},{protocolBaseClaimed:'1000000'},{protocolClaimed:'invalid'}]){
    const h=fixture(),l=launch();Object.assign(l,patch);l.operations=[{kind:'protocol-claim',state:'confirmed',signature:'retained',receipt:{quoteDelta:'1000000000',baseDelta:'0'}}];h.books.set(user,{launches:[l]});
    const out=await h.service.readPublic({pricesByMint:prices()});assert.equal(out.complete,false,JSON.stringify(patch));assert.equal(out.historyComplete,false);assert.equal(out.totalUsdEstimate,null);assert.equal(out.pricedUsdEstimate,150);assert.equal(out.status,'partial');
    const snapshot=await h.service.read(admin);assert.equal(snapshot.products.find(row=>row.id==='curve').totals[0].grossAmount,'1000000000');
  }
});

test('fully represented quote and base cumulative claims remain complete after receipt deduplication',async()=>{
  const h=fixture(),l=launch();l.protocolClaimed='3000000000';l.protocolBaseClaimed='5000000';
  l.operations=[{kind:'protocol-claim',state:'confirmed',signature:'curve',receipt:{quoteDelta:'1000000000',baseDelta:'0'}},{kind:'protocol-lp-claim',state:'confirmed',signature:'lp',receipt:{quoteDelta:'2000000000',baseDelta:'5000000'}}];l.operations.push({...l.operations[1]});h.books.set(user,{launches:[l]});
  const out=await h.service.readPublic({pricesByMint:prices(),tokenPrice:mint=>mint===l.keys.mint.address?{mint,usd:2,at:now}:null});assert.equal(out.complete,true);assert.equal(out.totalUsdEstimate,460);
});
