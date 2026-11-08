import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { AdminRevenue } from '../src/admin-revenue.mjs';
import { receiptHash } from '../src/cashback-verifier.mjs';
import { SOL } from '../src/core.mjs';
import { EVM_NATIVE } from '../public/chains.mjs';
const admin='a'.repeat(32),user='b'.repeat(32),address=()=>Keypair.generate().publicKey.toBase58();
function fixture(){
  const users=[{id:admin,role:'admin',mfaEnabled:true},{id:user,role:'user',mfaEnabled:true}],data=new Map(),books=new Map(),host={'fee-policy':{recipient:address()},'robinhood-fee-policy':{recipient:'0x'+'1'.repeat(40)},'launch-protocol-fees':{recipient:address(),recipientScope:'launchpad',creationFeeSol:'0.01'}};
  let reads=0,now=1000;
  const accounts={get:async id=>users.find(u=>u.id===id),list:async()=>users,hostStore:{read:async(name,def)=>host[name]??def},storeFor:id=>({read:async(name,def)=>{reads++;return data.get(id+':'+name)??def;},write:()=>assert.fail('report must be read-only')})};
  const launchpad={book:async id=>books.get(id)||{launches:[]},kick:()=>assert.fail('report cannot trigger transactions')};
  const service=new AdminRevenue({accounts,launchpad,now:()=>now});
  return {service,accounts,launchpad,users,data,books,host,set now(n){now=n;},get reads(){return reads;}};
}
function verified(h,receipt,{ledger='live',chain='solana',account=user}={}){
  const prefix=chain==='solana'?'':'robinhood-',name=account+':'+prefix+ledger,rows=h.data.get(name)||{feeReceipts:[]};rows.feeReceipts.push(receipt);h.data.set(name,rows);
  const key=account+':'+prefix+'cashback-verification',v=h.data.get(key)||{receipts:{}};v.receipts[receipt.signature]={status:'verified',hash:receiptHash(receipt),amount:receipt.amount,cashbackAmount:receipt.cashbackAmount};h.data.set(key,v);
}
const receipt=(extra={})=>({mode:'live',signature:'confirmed',accountId:user,mint:SOL,decimals:9,amount:'1000',cashbackAmount:'250',kind:'copy',at:100,recipient:'old-treasury',evidence:{private:'must-not-leak'},...extra});
const launch=()=>({id:'1'.repeat(32),curve:address(),input:{route:'raydium',network:'mainnet-beta',quoteMint:SOL,quoteSymbol:'SOL',symbol:'TEST',taxBps:0},review:{quoteDecimals:9,quoteSymbol:'SOL',protocolFees:{creationFeeSol:'0.01'}},keys:{mint:{address:address()},wallet:{secret:'must-not-leak'}},operations:[]});
const product=(r,id)=>r.products.find(p=>p.id===id);

test('reports only independently verified actual toolkit receipts, deduplicates journal migrations and separates currencies',async()=>{
  const h=fixture(),r=receipt();verified(h,r);verified(h,r,{ledger:'portfolio-live'});
  verified(h,receipt({signature:'rh',mint:EVM_NATIVE,decimals:18,kind:undefined,amount:'2000',cashbackAmount:'0'}),{chain:'robinhood',ledger:'sniper-live'});
  const result=await h.service.read(admin);assert.equal(product(result,'copy').totals[0].grossAmount,'1000');assert.equal(product(result,'copy').totals[0].netAmount,'750');assert.equal(product(result,'copy').totals[0].cashbackPendingAmount,'250');assert.equal(product(result,'copy').totals[0].paidAmount,'1000');assert.equal(product(result,'copy').totals[0].cashbackPaidAmount,'0');
  assert.equal(product(result,'sniper').totals[0].symbol,'ETH');assert.equal(result.totals.length,2);assert.equal(product(result,'copy').feeLabel,'0.25%');assert.equal(product(result,'lp').feeLabel,'75%');assert.equal(result.wallets.launchpad,h.host['launch-protocol-fees'].recipient);assert.notEqual(result.wallets.launchpad,result.wallets.toolkitSolana);assert(!JSON.stringify(result).includes('must-not-leak'));
});

test('unverified, tampered, paper, wrong owner and invalid cashback receipts cannot increase revenue',async()=>{
  const h=fixture(),r=receipt();verified(h,r);r.amount='9000';
  verified(h,receipt({signature:'wrong',accountId:admin}));verified(h,receipt({signature:'cashback',cashbackAmount:'1001'}));
  h.data.get(user+':live').feeReceipts.push(receipt({signature:'pending'}),receipt({signature:'paper',mode:'paper'}));
  const result=await h.service.read(admin);assert.deepEqual(result.totals,[]);assert.equal(product(result,'copy').status,'unavailable');assert.match(product(result,'copy').note,/excluded/);
});

test('curve, LP and creation count receipt amounts once; treasury payouts do not create revenue and do not mix with toolkit SOL',async()=>{
  const h=fixture(),l=launch();verified(h,receipt());l.protocolClaimed='999999';l.protocolPaid='999999';l.review.postGradTradeBps=25;
  l.operations=[{kind:'create',state:'confirmed',signature:'creation',creationFeeReceipt:{mint:SOL,decimals:9,amount:'10000000',recipient:address()}},{kind:'protocol-claim',state:'confirmed',signature:'curve',amount:'999',receipt:{quoteDelta:'100',baseDelta:'0'}},{kind:'protocol-lp-claim',state:'confirmed',signature:'lp',receipt:{quoteDelta:'200',baseDelta:'50'}},{kind:'protocol-lp-payout',state:'confirmed',signature:'payout',amount:'999',receipt:{quoteDelta:'-250',baseDelta:'-40'}},{kind:'protocol-claim',state:'pending',signature:'pending',receipt:{quoteDelta:'999999',baseDelta:'0'}}];
  h.books.set(user,{launches:[l,structuredClone(l)]});const result=await h.service.read(admin);
  assert.match(product(result,'lp').feeBasis,/tiers: 0.25%/);assert.equal(product(result,'curve').totals[0].grossAmount,'100');assert.equal(product(result,'lp').totals.find(a=>a.mint===SOL).grossAmount,'200');assert.equal(product(result,'curve').totals[0].paidAmount,null);
  const quote=result.totals.find(a=>a.scope==='launchpad'&&a.mint===SOL),base=result.totals.find(a=>a.mint===l.keys.mint.address);
  assert.equal(quote.grossAmount,null);assert.equal(quote.knownGrossAmount,'10000300');assert.equal(quote.paidAmount,'10000250');assert.equal(quote.pendingAmount,null);assert.equal(base.grossAmount,'50');assert.equal(base.paidAmount,'40');assert.equal(base.pendingAmount,'10');assert.equal(result.totals.find(a=>a.scope==='toolkit').grossAmount,'1000');
});

test('missing old receipt amounts remain unavailable; requested budgets and cumulative counters are never inferred',async()=>{
  const h=fixture(),l=launch();l.protocolClaimed='1000000';l.operations=[{state:'confirmed',kind:'create',signature:'oldcreate'},{state:'confirmed',kind:'protocol-claim',signature:'oldclaim',amount:'1000000'},{state:'confirmed',kind:'protocol-payout',signature:'paid',receipt:{quoteDelta:'-80',baseDelta:'0'}}];h.books.set(user,{launches:[l]});
  const result=await h.service.read(admin);assert.equal(product(result,'curve').status,'unavailable');assert.equal(product(result,'creation').status,'unavailable');const total=result.totals[0];assert.equal(total.grossAmount,null);assert.equal(total.knownGrossAmount,'0');assert.equal(total.paidAmount,'80');assert.equal(total.pendingAmount,null);
});

test('tax revenue counts reconciled share ledger and rejects inconsistent 5% splits',async()=>{
  const h=fixture(),l=launch();l.input.taxBps=300;l.taxProtocol={policy:'collected-tax-proceeds-v1',shareBps:500,convertedQuote:'2003',holderQuote:'1903',accruedQuote:'100',paidQuote:'80',creditQuote:'20',roundingRemainder:'1500'};h.books.set(user,{launches:[l]});
  let r=await h.service.read(admin);assert.equal(product(r,'tax').totals[0].grossAmount,'100');assert.equal(product(r,'tax').totals[0].paidAmount,'80');assert.equal(product(r,'tax').totals[0].pendingAmount,'20');
  l.taxProtocol.accruedQuote='101';h.now=17000;r=await h.service.read(admin);assert.equal(product(r,'tax').status,'unavailable');assert.deepEqual(product(r,'tax').totals,[]);
});

test('admin and MFA are required before reads and rechecked after reads and while serving cached results',async()=>{
  const h=fixture();await assert.rejects(h.service.read(user),e=>e.statusCode===403);assert.equal(h.reads,0);h.users[0].mfaEnabled=false;await assert.rejects(h.service.read(admin),e=>e.statusCode===403);assert.equal(h.reads,0);h.users[0].mfaEnabled=true;
  await h.service.read(admin);const count=h.reads;await h.service.read(admin);assert.equal(h.reads,count);h.users[0].role='user';await assert.rejects(h.service.read(admin),e=>e.statusCode===403);assert.equal(h.reads,count);
  const second=fixture();second.accounts.list=async()=>{second.users[0].role='user';return second.users;};await assert.rejects(second.service.read(admin),e=>e.statusCode===403);
});

test('concurrent polls share one bounded scan, errors exclude private details, future policy enforces 75% while historical records remain unchanged',async()=>{
  const h=fixture();h.host['launch-protocol-fees'].liquidityPolicyVersion=1;h.host['launch-protocol-fees'].lpPolicy='platform_locked';h.host['launch-protocol-fees'].platformLpPercent=60;
  const historical=launch();historical.review.protocolFees.lpPolicy='platform_locked';historical.review.protocolFees.platformLpPercent=60;h.books.set(user,{launches:[historical]});const before=structuredClone(h.books.get(user));
  const responses=await Promise.all([h.service.read(admin),h.service.read(admin),h.service.read(admin)]);assert.equal(h.reads,24);assert.deepEqual(responses[0],responses[1]);assert.equal(product(responses[0],'lp').feeLabel,'75%');assert.deepEqual(h.books.get(user),before);assert.equal(h.host['launch-protocol-fees'].platformLpPercent,60);
  h.service.maxAccounts=1;h.now=17000;await assert.rejects(h.service.read(admin),/scan limit/);
  const broken=fixture();broken.accounts.storeFor=()=>({read:async()=>{throw Error('https://rpc.example/private-secret');}});const result=await broken.service.read(admin);assert.equal(product(result,'copy').status,'unavailable');assert(!JSON.stringify(result).includes('private-secret'));
});

test('a confirmed payout with missing or invalid amounts cannot imply all recorded claims are still pending',async()=>{
  for(const kind of ['protocol-payout','protocol-lp-payout'])for(const invalid of [false,true])for(const hasKnownPayout of [false,true]){
    const h=fixture(),l=launch();l.operations=[{state:'confirmed',kind:'protocol-claim',signature:'claim',receipt:{quoteDelta:'100',baseDelta:'0'}},{state:'confirmed',kind:'protocol-lp-claim',signature:'lpclaim',receipt:{quoteDelta:'0',baseDelta:'50'}},...(hasKnownPayout?[{state:'confirmed',kind:'protocol-payout',signature:'knownpayout',receipt:{quoteDelta:'-20',baseDelta:'0'}}]:[]),{state:'confirmed',kind,signature:'unknownpayout',amount:'999999',...(invalid?{receipt:{quoteDelta:'20',baseDelta:'0'}}:{})}];
    h.books.set(user,{launches:[l]});const result=await h.service.read(admin),quote=result.totals.find(a=>a.mint===SOL),base=result.totals.find(a=>a.mint===l.keys.mint.address);
    assert.equal(quote.grossAmount,'100');assert.equal(quote.paidAmount,null);assert.equal(quote.knownPaidAmount,hasKnownPayout?'20':'0');assert.equal(quote.pendingAmount,null);assert.equal(quote.status,'partial');
    assert.equal(base.paidAmount,kind==='protocol-lp-payout'?null:'0');assert.equal(base.pendingAmount,kind==='protocol-lp-payout'?null:'50');
  }
});

test('Funding lists zero Launchpad markup without counting third-party charges as revenue',async()=>{
  const h=fixture();h.data.set(user+':funding',{orders:[{state:'complete',deposit:{feeAmount:'100',feePercentage:3,networkFee:'10'}}]});
  const result=await h.service.read(admin),funding=product(result,'funding');assert.equal(funding.feeLabel,'0%');assert.equal(funding.noFees,true);assert.equal(funding.status,'available');assert.match(funding.feeBasis,/Third-party provider and network charges/);assert.deepEqual(funding.totals,[]);assert.deepEqual(result.totals,[]);
});

test('launchpad-only reports avoid all inactive history scans and preserve retained records for a future upgrade',async()=>{
  const h=fixture(),l=launch();verified(h,receipt());verified(h,receipt({signature:'rh-retained',mint:EVM_NATIVE,decimals:18}),{chain:'robinhood'});
  l.operations=[{kind:'protocol-claim',state:'confirmed',signature:'curve-active',receipt:{quoteDelta:'100',baseDelta:'0'}}];h.books.set(user,{launches:[l]});
  const before=structuredClone({data:h.data,books:h.books,host:h.host}),hostReads=[];
  const read=h.accounts.hostStore.read;h.accounts.hostStore.read=async(...args)=>{hostReads.push(args[0]);return read(...args);};
  const storeFor=h.accounts.storeFor;h.accounts.storeFor=()=>assert.fail('inactive toolkit account stores must not be scanned');
  const service=new AdminRevenue({accounts:h.accounts,launchpad:h.launchpad,toolkit:false,now:()=>1000});
  const result=await service.read(admin);
  assert.deepEqual(hostReads,['launch-protocol-fees']);assert.deepEqual(result.products.map(p=>p.id),['creation','curve','lp','tax']);
  assert(result.products.every(p=>p.scope==='launchpad'));assert(result.totals.every(row=>row.scope==='launchpad'));assert.equal(result.totals[0].grossAmount,'100');
  assert.deepEqual(result.wallets,{launchpad:h.host['launch-protocol-fees'].recipient});assert(!/cashback|toolkit|robinhood/i.test(JSON.stringify(result)));
  assert.deepEqual({data:h.data,books:h.books,host:h.host},before);assert.equal(h.reads,0);
  h.accounts.storeFor=storeFor;const restored=await h.service.read(admin);assert.equal(product(restored,'copy').totals.length,2);assert.equal(restored.totals.find(row=>row.scope==='toolkit'&&row.chain==='solana').grossAmount,'1000');
});

test('public revenue keeps the last confirmed snapshot through a failed refresh for a bounded time, never as a false unavailable',async()=>{
  let now=1000,fail=false;const mint=address(),prices=new Map();
  const service=new AdminRevenue({accounts:{},launchpad:{},now:()=>now,toolkit:false});
  service.snapshot=async()=>{if(fail)throw Error('SECRET_RPC');return {at:now,products:[{id:'creation',scope:'launchpad',revenueComplete:true,totals:[{scope:'launchpad',chain:'solana',mint,decimals:9,grossAmount:'2000000000'}]}]};};
  prices.set(mint,{usd:150,at:now});assert.equal((await service.readPublic({pricesByMint:prices})).totalUsdEstimate,300);
  fail=true;now+=20000;prices.set(mint,{usd:150,at:now});
  const kept=await service.readPublic({pricesByMint:prices});assert.equal(kept.totalUsdEstimate,300);assert.equal(kept.status,'available');assert.doesNotMatch(JSON.stringify(kept),/SECRET/);
  now+=600001;prices.set(mint,{usd:150,at:now});assert.equal((await service.readPublic({pricesByMint:prices})).status,'unavailable');
});

test('revenue history covers more than 1,000 accounts up to the registry ceiling',async()=>{
  const users=n=>[{id:admin,role:'admin',mfaEnabled:true},...Array.from({length:n},(_,i)=>({id:(i+1).toString(16).padStart(32,'0'),role:'user',authType:'wallet'}))];
  const accountsFor=n=>{const list=users(n);return {list:async()=>list,get:async id=>list.find(row=>row.id===id),storeFor:()=>({read:async(_,fallback)=>fallback}),hostStore:{read:async(_,fallback)=>fallback}};};
  const launchpad={book:async()=>({launches:[]})};
  const report=await new AdminRevenue({accounts:accountsFor(1500),launchpad,toolkit:false,now:()=>1000}).read(admin);
  assert.deepEqual(report.products.map(p=>p.id),['creation','curve','lp','tax']);
  await assert.rejects(new AdminRevenue({accounts:accountsFor(10000),launchpad,toolkit:false,now:()=>1000}).snapshot(),/scan limit/);
});
