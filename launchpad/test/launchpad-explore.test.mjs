import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PublicKey } from '@solana/web3.js';
import { LaunchpadExplore } from '../src/launchpad-explore.mjs';
import { LaunchChain, ray } from '../src/launchpad-chain.mjs';
import { SOL_MINT, USDC_MINT } from '../public/launchpad-model.mjs';
import { LAUNCH_ASSETS } from '../public/launch-assets.mjs';

const BASE=1_790_000_000_000;
const key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const stock=LAUNCH_ASSETS.find(asset=>asset.category==='stocks');
function launch(n,patch={}) {
  const mint=key(n),quote=patch.input?.quoteMint||SOL_MINT;
  const value={id:('00'+n).padStart(32,'a'),createdAt:BASE-n*1000,authorizedAt:BASE-n*1000,state:'live',curve:ray.getPdaLaunchpadPoolId(ray.LAUNCHPAD_PROGRAM,new PublicKey(mint),new PublicKey(quote)).publicKey.toBase58(),input:{route:'raydium',network:'mainnet-beta',name:'Coin '+n,symbol:'C'+n,quoteMint:quote,feeMode:'holders',taxBps:400,creatorFeeBps:25,imageId:'f'.repeat(64)+'.png',description:'Public description',links:{website:'https://example.com/',twitter:'javascript:alert(1)'},recipient:'PRIVATE-RECIPIENT',externalWallet:'PRIVATE-EXTERNAL',...patch.input},keys:{mint:{address:mint,secret:'PRIVATE-MINT-SECRET'},wallet:{address:key(200),secret:'PRIVATE-FEE-SECRET'},payer:{address:key(201),secret:'PRIVATE-PAYER'},platform:{address:key(202),secret:'PRIVATE-ADMIN'}},review:{configId:key(203),cpConfigId:key(204),supply:'1000000000000000',sell:'800000000000000',raise:'1000000000',virtualBase:'1000000000000000',virtualQuote:'1000000000',quoteDecimals:9,quoteProgram:key(205),quoteSymbol:quote===SOL_MINT?'SOL':quote===USDC_MINT?'USDC':'CUSTOM',price:{usd:999999,source:'https://PRIVATE-RPC/?key=SECRET'}},operations:[{state:'confirmed',kind:'create',signature:'1'.repeat(64),slot:100,createdAt:BASE-n*1000,confirmedAt:BASE-n*1000}],credits:{quote:'PRIVATE-CREDITS'},gas:{reserved:'PRIVATE-GAS'},storage:{key:'PRIVATE-STORAGE'},...patch};
  value.input={route:'raydium',network:'mainnet-beta',name:'Coin '+n,symbol:'C'+n,quoteMint:quote,feeMode:'holders',taxBps:400,creatorFeeBps:25,imageId:'f'.repeat(64)+'.png',description:'Public description',links:{website:'https://example.com/',twitter:'javascript:alert(1)'},recipient:'PRIVATE-RECIPIENT',externalWallet:'PRIVATE-EXTERNAL',...patch.input};
  return value;
}
function harness(t,rows=[launch(1)],extra={}) {
  let now=BASE,calls=0,dexCalls=0,registryReads=0,status='curve',error=false,slot=110,blocking=null;
  const books=new Map([['account-a',{launches:rows}],['account-b',{launches:[]}]]),snapshots=new Map(),dexRows=new Map(),received=[];
  const accounts={list:async()=>{registryReads++;return [...books.keys()].map(id=>({id,username:'public_creator',bio:'Public creator bio',mainWallet:'PRIVATE-MAIN'}));},storeFor:id=>({read:async(name,fallback)=>{assert.equal(name,'launchpad');return structuredClone(books.get(id)||fallback);}})};
  const makeSnapshot=l=>({mint:l.keys.mint.address,curve:l.curve,status,at:now,slot,supply:1e9,priceQuote:.001,fdvQuote:1e6,raisedQuote:40,targetQuote:100,progressPercent:40,quote:{mint:l.input.quoteMint,symbol:'Q',usd:10,at:now,stale:false,source:'https://PRIVATE-PROVIDER'},priceUsd:.01,fdvUsd:1e7,secret:'PRIVATE-CHAIN',...snapshots.get(l.keys.mint.address)});
  const chain={marketSnapshot:async l=>{calls++;received.push(l);if(blocking)await blocking;if(error)throw Error('https://private.provider?key=PRIVATE-RPC');return makeSnapshot(l);},close(){}};
  const marketData={pools:async(_chain,mint)=>{dexCalls++;if(error)throw Error('PRIVATE-DEX');return {tokenAddress:mint,at:now,pools:dexRows.get(mint)||[]};}};
  const history={read:async()=>null,close(){}};
  const service=new LaunchpadExplore({accounts,chainFactory:async()=>chain,marketData,history,activity:{read:async()=>null,close(){}},now:()=>now,listWaitMs:100,...extra});
  t.after(()=>service.close());
  return {service,books,snapshots,dexRows,received,advance(ms){now+=ms;slot++;},set status(v){status=v;},set error(v){error=v;},set blocking(v){blocking=v;},set slot(v){slot=v;},get calls(){return calls;},get dexCalls(){return dexCalls;},get registryReads(){return registryReads;},get now(){return now;}};
}
function pool(l,{volume=500,m5=200,h1=300,...patch}={}){return {address:key(240),token:l.keys.mint.address,base:{address:l.keys.mint.address},quote:{address:l.input.quoteMint},isBase:true,priceUsd:.1,marketCapUsd:1e6,fdvUsd:1.2e6,liquidityUsd:50000,volume24h:volume,priceChange:{h24:3},txns:{m5:{buys:3,sells:2},h24:{buys:42,sells:12}},volume:{m5,h1,h24:volume},url:'javascript:PRIVATE-URL',secret:'PRIVATE-POOL',...patch};}

test('public discovery aggregates confirmed coins across accounts and excludes drafts, legacy and unconfirmed failures',async t=>{
  const h=harness(t,[launch(1),launch(2,{state:'draft'}),launch(3,{curve:null,state:'failed',operations:[]}),launch(4,{input:{network:'devnet'}}),launch(5,{state:'error'})]);
  h.books.get('account-b').launches.push(launch(6));
  const data=await h.service.list();assert.deepEqual(data.coins.map(coin=>coin.symbol),['C1','C5','C6']);assert.equal(data.total,3);assert.equal(data.coins[0].creator.username,'public_creator');assert.equal(data.coins[0].creator.bio,'Public creator bio');
  const json=JSON.stringify(data);assert(!json.includes('PRIVATE'));assert(!json.includes('account-a'));assert(!json.includes('signature'));assert(!json.includes('credits'));assert(!json.includes(key(200)));
  assert.equal(data.coins[0].links.twitter,undefined);assert.equal(data.coins[0].links.website,'https://example.com/');assert.equal(data.coins[0].image,'/token-images/'+'f'.repeat(64)+'.png');
  assert(!JSON.stringify(h.received).includes('PRIVATE'));assert(!JSON.stringify(h.received).includes('account-a'));
});

test('confirmed creation awaiting local verification is discoverable using its deterministic curve',async t=>{
  const row=launch(1,{curve:null,state:'launching'}),h=harness(t,[row]);const data=await h.service.list();assert.equal(data.total,1);assert.equal(data.coins[0].curveStatus,'curve');assert.equal(data.coins[0].curve,launch(1).curve);
});

test('invalid receipt without verified curve and wrong stored curve cannot be exposed',async t=>{
  const h=harness(t,[launch(1,{curve:null,operations:[{state:'confirmed',kind:'create',signature:'not-real',slot:100}]}),launch(2,{curve:key(250)})]);assert.equal((await h.service.list()).total,0);assert.equal(h.calls,0);
});

test('graduation follows observed migrated status, never a complete progress bar or local live state',async t=>{
  const h=harness(t,[launch(1),launch(2),launch(3)]);h.snapshots.set(key(1),{status:'migrated',progressPercent:100});h.snapshots.set(key(2),{status:'migrating',progressPercent:100});
  const data=await h.service.list();assert.equal(data.counts.graduated,1);assert.equal(data.coins.find(row=>row.mint===key(2)).stage,'new');assert.equal((await h.service.list({stage:'graduated'})).coins[0].mint,key(1));
  h.advance(61_000);h.error=true;const later=await h.service.list({stage:'graduated'});assert.equal(later.total,1);assert.equal(later.coins[0].stageStale,true);assert.equal(later.coins[0].priceUsd,null);
});

test('snapshot regressions do not demote a graduated coin or overwrite a higher slot',async t=>{
  const h=harness(t);h.status='migrated';await h.service.list();h.advance(31_000);h.status='curve';const data=await h.service.list();assert.equal(data.coins[0].stage,'graduated');assert.equal(data.coins[0].stageStale,true);
});

test('all query filters, pagination and missing metric ordering are deterministic',async t=>{
  const h=harness(t,[launch(1),launch(2,{input:{quoteMint:USDC_MINT,feeMode:'creator'}}),launch(3,{input:{quoteMint:stock.mint,feeMode:'buyback'}}),launch(4,{createdAt:BASE-8*86_400_000,operations:[]})]);
  h.snapshots.set(key(1),{fdvUsd:400});h.snapshots.set(key(2),{fdvUsd:500});h.snapshots.set(key(3),{fdvUsd:null,priceUsd:null,quote:{mint:stock.mint,stale:true}});h.snapshots.set(key(4),{fdvUsd:100});
  await h.service.list();
  assert.deepEqual((await h.service.list({sort:'marketCap'})).coins.map(c=>c.symbol),['C2','C1','C4','C3']);
  assert.equal((await h.service.list({category:'stocks'})).coins[0].symbol,'C3');assert.equal((await h.service.list({feeMode:'creator'})).total,1);assert.equal((await h.service.list({quote:'USDC'})).total,1);
  assert.equal((await h.service.list({search:'coin 2'})).total,1);assert.equal((await h.service.list({search:key(3)})).coins[0].symbol,'C3');assert.equal((await h.service.list({age:'7d'})).total,3);assert.equal((await h.service.list({age:'24h'})).total,3);assert.equal((await h.service.list({chain:'robinhood'})).total,0);
  const page=await h.service.list({sort:'oldest',offset:1,limit:2});assert.deepEqual(page.coins.map(c=>c.symbol),['C3','C2']);assert.equal(page.nextOffset,3);
  for(const query of [{limit:1000},{limit:0},{offset:-1},{offset:'no'},{sort:'PRIVATE'},{stage:'draft'},{search:'a'.repeat(101)},{age:'1h'}])await assert.rejects(h.service.list(query),{statusCode:400});
});

test('USD values require a fresh quote; launch reference valuation is never substituted',async t=>{
  const h=harness(t);h.snapshots.set(key(1),{quote:{mint:SOL_MINT,usd:999999,at:BASE,stale:true},fdvUsd:999999,priceUsd:100});
  const coin=(await h.service.list()).coins[0];assert.equal(coin.fdvUsd,null);assert.equal(coin.priceUsd,null);assert.equal(coin.marketCapUsd,null);assert.equal(coin.fdvQuote,1e6);assert.equal(coin.volume24h,null);
});

test('public discovery supplies the operator Jupiter credential and coalesces quote references by exact mint', async t => {
  let supplied, lookups = 0, release;
  const h = harness(t, [launch(1)], { jupiterKey: 'PRIVATE-OPERATOR-JUPITER', chainFactory: async config => {
    supplied = config;
    return { referencePrice: async () => { lookups++; await new Promise(resolve => { release = resolve; }); return { usd: '12', at: h.now, source: 'Live raw-token / USDC quote' }; }, close() {} };
  } });
  const chain = await h.service.chain(); assert.equal(supplied.jupiterKey, 'PRIVATE-OPERATOR-JUPITER');
  assert.equal(supplied.rpcScope, 'public-explore'); assert.equal(supplied.rpcRequestsPerSecond, h.service.rpcRate);
  const info = { mint: { decimals: 9 }, extensions: [] }, input = { quoteMint: stock.mint };
  const first = chain.referencePrice(input, info), second = chain.referencePrice(input, info);
  assert.equal(lookups, 1); release(); assert.deepEqual(await first, await second);
  await chain.referencePrice(input, info); assert.equal(lookups, 1);
  h.advance(60001); const next = chain.referencePrice(input, info); assert.equal(lookups, 2); release(); await next;
  assert(!JSON.stringify(h.service.catalogue()).includes('PRIVATE-OPERATOR-JUPITER'));
});

test('public discovery does not cache failed or stale quote references as current prices', async t => {
  let lookups = 0;
  const h = harness(t, [launch(1)], { chainFactory: async () => ({ referencePrice: async () => { lookups++; return { usd: '999999', at: h.now - 60001, stale: true }; }, close() {} }) });
  const chain = await h.service.chain();
  await chain.referencePrice({ quoteMint: stock.mint }, {}); await chain.referencePrice({ quoteMint: stock.mint }, {});
  assert.equal(lookups, 2); assert.equal(h.service.quoteReferences.size, 0);
});

test('exact mint and quote DEX data enriches discovery; foreign pools and URLs are rejected',async t=>{
  const row=launch(1),h=harness(t,[row]);h.dexRows.set(key(1),[pool(row,{quote:{address:USDC_MINT},marketCapUsd:99999999}),pool(row)]);
  const data=await h.service.market(key(1));assert.equal(data.coin.marketCapUsd,1e6);assert.equal(data.pool.chain,'solana');assert.equal(data.pool.url,'https://dexscreener.com/solana/'+key(240));assert(!JSON.stringify(data).includes('PRIVATE'));assert.equal(data.native.points.length,1);
});

test('moving on up requires fresh 35% progress or corroborated 2x volume acceleration',async t=>{
  const rows=[launch(1),launch(2),launch(3),launch(4)],h=harness(t,rows);h.snapshots.set(key(1),{progressPercent:35});h.snapshots.set(key(2),{progressPercent:10});h.snapshots.set(key(3),{progressPercent:10});h.snapshots.set(key(4),{status:'migrated',progressPercent:100});
  h.dexRows.set(key(2),[pool(rows[1])]);h.dexRows.set(key(3),[pool(rows[2],{m5:99,h1:100})]);h.dexRows.set(key(4),[pool(rows[3])]);
  const data=await h.service.list({stage:'moving'});assert.deepEqual(data.coins.map(c=>c.symbol),['C1','C2']);assert.equal(data.counts.moving,2);assert.equal(data.coins[0].movingReason,'progress');assert.equal(data.coins[1].movingReason,'volume');assert.equal(data.coins[1].volumeAcceleration,22);
  h.advance(121_000);h.error=true;assert.equal((await h.service.list({stage:'moving'})).total,0);
});

test('simultaneous anonymous reads coalesce registry and market requests',async t=>{
  const h=harness(t);const [a,b,c]=await Promise.all([h.service.list(),h.service.list(),h.service.token(key(1))]);assert.equal(a.total,1);assert.equal(b.total,1);assert.equal(c.coin.symbol,'C1');assert.equal(h.calls,1);assert.equal(h.dexCalls,1);assert.equal(h.registryReads,1);await h.service.list();assert.equal(h.calls,1);
});

test('missing and malformed tokens fail generically without looking up private connection settings',async t=>{
  const h=harness(t);await assert.rejects(h.service.token('bad'),{statusCode:400});await assert.rejects(h.service.market(key(20)),{statusCode:404});assert.equal(h.calls,0);
});

test('catalogue storage failures are flagged and do not retain deleted account records',async t=>{
  const h=harness(t);await h.service.list();h.advance(11_000);h.books.clear();const next=await h.service.list();assert.equal(next.total,0);await assert.rejects(h.service.token(key(1)),{statusCode:404});
});

test('public catalogue responds within its wait budget while provider reads remain coalesced',async t=>{
  const h=harness(t,[launch(1)],{listWaitMs:10});let release;h.blocking=new Promise(resolve=>{release=resolve;});
  const start=Date.now(),data=await h.service.list();assert(Date.now()-start<150);assert.equal(data.coins[0].curveStatus,null);assert.equal(data.coins[0].fdvUsd,null);assert.equal(h.calls,1);await h.service.list();assert.equal(h.calls,1);release();h.blocking=null;await h.service.market(key(1));
});

test('image paths and social links cannot become arbitrary public fetch URLs',async t=>{
  const h=harness(t,[launch(1,{input:{imageId:'https://private.example/key.png',links:{website:'https://user:pass@private.example',telegram:'data:text/plain,PRIVATE'}}})]);const coin=(await h.service.token(key(1))).coin;assert.equal(coin.image,null);assert.deepEqual(coin.links,{});
});

test('graduated evidence survives service restart using only public host cache fields',async t=>{
  const files=new Map(),hostStore={read:async(name,fallback)=>structuredClone(files.get(name)||fallback),write:async(name,data)=>{files.set(name,structuredClone(data));}};
  const first=harness(t);first.service.accounts.hostStore=hostStore;first.status='migrated';await first.service.list();await first.service.stageWrite;
  const saved=files.get('launch-explore-stages');assert.equal(saved.coins[0].status,'migrated');assert.deepEqual(Object.keys(saved.coins[0]).sort(),['at','curve','mint','slot','status']);assert(!JSON.stringify(saved).includes('PRIVATE'));
  const next=harness(t);next.service.accounts.hostStore=hostStore;next.error=true;const data=await next.service.list({stage:'graduated'});assert.equal(data.total,1);assert.equal(data.coins[0].stage,'graduated');assert.equal(data.coins[0].stageStale,true);assert.equal(data.coins[0].fdvUsd,null);
});

test('public refresh bursts stay inside one host-wide market budget',async t=>{
  const h=harness(t,Array.from({length:100},(_,index)=>launch(index+1)));
  for(let offset=0;offset<100;offset+=10)await h.service.list({offset,limit:10});
  assert(h.calls<=60);assert(h.dexCalls<=60);assert(h.service.entries.size<=1000);assert.equal(h.registryReads,1);
});

test('mismatched, future and stale snapshots never become live public metrics',async t=>{
  const h=harness(t,[launch(1),launch(2),launch(3)]);h.snapshots.set(key(1),{mint:key(99)});h.snapshots.set(key(2),{at:BASE+60_000});h.snapshots.set(key(3),{at:BASE-60_001});
  const data=await h.service.list();assert(data.coins.every(coin=>coin.fdvUsd===null&&coin.priceUsd===null&&coin.curveStatus===null));assert.equal(data.coverage.observed,0);
});

test('DEX reverse pairs retain price and chart but cannot attribute other-token cap or change',async t=>{
  const row=launch(1),h=harness(t,[row]);h.status='migrated';h.dexRows.set(key(1),[pool(row,{base:{address:SOL_MINT},quote:{address:key(1)},isBase:false,marketCapUsd:999999,fdvUsd:999999})]);
  const data=await h.service.market(key(1));assert.equal(data.pool.isBase,false);assert.equal(data.pool.marketCapUsd,null);assert.equal(data.pool.priceChange.h24,null);assert.equal(data.pool.priceUsd,.1);assert.equal(data.coin.priceUsd,.1);assert.equal(data.coin.marketCapUsd,null);assert.equal(data.pool.txns.h24.buys,12);assert.equal(data.pool.txns.h24.sells,42);
});

test('public rewards resolve only published managed launches and forward sanitized evidence',async t=>{
  const h=harness(t,[launch(1),launch(2,{input:{feeMode:'creator'}}),launch(3,{state:'draft'})]);let seen;
  h.service.rewardView={read:async(record,coin)=>{seen=record;return {mint:coin.mint,mode:coin.feeMode};},close(){}};
  assert.equal((await h.service.rewards(key(1))).mode,'holders');assert(!JSON.stringify(seen).includes('PRIVATE'));assert.equal(seen.keys.wallet.secret,undefined);
  assert.deepEqual(await h.service.rewards(key(2)),{mint:key(2),mode:'creator',holder:null,buyback:null,refreshMs:30_000});await assert.rejects(h.service.rewards(key(3)),{statusCode:404});
});

test('launch type and paired asset sorts are actual deterministic server-side rankings',async t=>{
  const h=harness(t,[launch(1,{input:{feeMode:'holders',quoteMint:USDC_MINT}}),launch(2,{input:{feeMode:'creator'}}),launch(3,{input:{feeMode:'buyback'}})]);
  assert.deepEqual((await h.service.list({sort:'launchType'})).coins.map(coin=>coin.feeMode),['buyback','creator','holders']);assert.deepEqual((await h.service.list({sort:'quote'})).coins.map(coin=>coin.quote.symbol),['SOL','SOL','USDC']);
});

test('a delayed DEX response cannot block the native chart, homepage valuation or moving progress',async t=>{
  let releaseDex;const dexWait=new Promise(resolve=>{releaseDex=resolve;});
  const h=harness(t,[launch(1)],{marketData:{pools:async()=>{await dexWait;throw Error('PRIVATE-DEX');}},marketWaitMs:100});
  const start=Date.now();
  try{
    const data=await h.service.market(key(1));assert(Date.now()-start<250);assert.equal(data.native.points.length,1);assert.equal(data.coin.fdvUsd,1e7);assert.equal(data.coin.movingReason,'progress');assert.equal(data.pool,null);
    const list=await h.service.list({stage:'moving'});assert.equal(list.coins[0].progressPercent,40);assert.equal(h.calls,1);assert.equal(h.service.dexPending.size,1);
  }finally{releaseDex();}
});

test('native quote chart remains immediate when both USD and DEX indexing are absent',async t=>{
  const h=harness(t);h.snapshots.set(key(1),{quote:{mint:SOL_MINT,usd:null,at:null,stale:true},priceUsd:null,fdvUsd:null});
  const data=await h.service.market(key(1));assert.equal(data.native.points.length,1);assert.equal(data.native.points[0].priceQuote,.001);assert.equal(data.native.candles.length,0);assert.equal(data.coin.fdvQuote,1e6);assert.equal(data.coin.fdvUsd,null);assert.equal(data.coin.progressPercent,40);assert.equal(data.pool,null);
});

test('a queued cold market returns loading immediately and keeps its place without increasing concurrency',async t=>{
  const rows=[launch(1),launch(2),launch(3),launch(4)],h=harness(t,rows,{marketWaitMs:200});let release;
  h.blocking=new Promise(resolve=>{release=resolve;});await h.service.inventory();
  const busy=rows.slice(0,3).map(row=>h.service.observe(h.service.records.get(row.keys.mint.address)));
  const focused=h.service.market(key(4));await new Promise(resolve=>setTimeout(resolve,5));assert.equal(h.calls,3);assert.equal(h.service.nativeQueue.active,3);assert.equal(h.service.pending.size,4);
  const queued=await focused;assert.equal(queued.native,null);assert.equal(queued.refreshing,true);
  h.blocking=null;release();await Promise.all(busy);await Promise.all(h.service.pending.values());const data=await h.service.market(key(4));assert.equal(h.calls,4);assert.equal(data.native.points.length,1);assert.equal(data.coin.mint,key(4));
});

test('focused provider timeout returns a bounded empty read and retains one coalesced background request',async t=>{
  const h=harness(t,[launch(1)],{marketWaitMs:10});let release;h.blocking=new Promise(resolve=>{release=resolve;});
  try{
    const start=Date.now(),data=await h.service.market(key(1));assert(Date.now()-start<150);assert.equal(data.native,null);assert.equal(h.calls,1);assert.equal(h.service.pending.size,1);
    await h.service.market(key(1));assert.equal(h.calls,1);
  }finally{h.blocking=null;release();}
  const recovered=await h.service.market(key(1));assert.equal(recovered.native.points.length,1);assert.equal(h.calls,1);
});

test('native failures expose only fixed diagnostic codes, never provider URLs or launch secrets',async t=>{
  const h=harness(t);h.error=true;const failed=await h.service.market(key(1));assert.equal(failed.nativeError,'rpc_unavailable');assert(!JSON.stringify(failed).includes('PRIVATE'));
  h.error=false;h.advance(31_000);h.snapshots.set(key(1),{mint:key(99)});const invalid=await h.service.market(key(1));assert.equal(invalid.nativeError,'curve_verification_failed');assert.equal(invalid.native,null);
});


test('a focused coin is not dropped when catalogue workers refill a newly available native slot',async t=>{
  const rows=Array.from({length:10},(_,i)=>launch(i+1)),h=harness(t,rows,{marketWaitMs:200});let release;
  h.blocking=new Promise(resolve=>{release=resolve;});await h.service.inventory();await h.service.warm([...h.service.records.values()].slice(0,9),{wait:0,max:9});
  const focused=h.service.market(key(10));await new Promise(resolve=>setTimeout(resolve,5));assert.equal(h.service.nativeQueue.active,3);assert.equal(h.service.pending.size,10);
  const queued=await focused;assert.equal(queued.refreshing,true);h.blocking=null;release();await Promise.all(h.service.pending.values());const result=await h.service.market(key(10));assert.equal(result.native.points.length,1);assert.equal(result.coin.mint,key(10));assert.equal(h.calls,10);
});

test('public creator fee metrics use only the confirmed effective rate and retain fractional basis points',async t=>{
  const row=launch(1,{creatorFees:{ratePpm:2750,status:'active',confirmedAt:BASE-1000},operations:[...launch(1).operations,{kind:'creator-fee-update',state:'pending',creatorFeeDecision:{ratePpm:5000}}]});
  row.review.creatorFeeRatePpm=3000;row.review.postGradCreatorBps=5;const h=harness(t,[row]),data=await h.service.token(key(1));
  assert.equal(data.coin.creatorFeeBps,27.5);assert.equal(data.coin.postGradCreatorFeeBps,5);assert(!JSON.stringify(data).includes('creatorFeeDecision'));
});

const curveActivity=(l,at,patch={})=>({poolId:l.curve,at,windows:{m5:{quote:20,buys:3,sells:2,complete:true},h1:{quote:30,buys:5,sells:3,complete:true},h24:{quote:6809.554541,buys:20,sells:11,complete:true},...patch}});
test('native launch volume and momentum are available without DEX indexing',async t=>{
  const l=launch(1),h=harness(t,[l],{activity:{read:async()=>curveActivity(l,BASE),close(){}}});h.snapshots.set(key(1),{progressPercent:1});
  await h.service.list();await Promise.all(h.service.activityPending.values());const coin=(await h.service.list()).coins[0];
  assert.equal(coin.volume24hQuote,6809.554541);assert.equal(coin.volume24h,68095.54541);assert.equal(coin.volumeSource,'Raydium trade history');assert.equal(coin.volumeUsdEstimate,true);assert.equal(coin.buys24h,20);assert.equal(coin.sells24h,11);assert.equal(coin.movingReason,'volume');assert.equal(coin.volumeAcceleration,22);
  h.advance(61_000);h.error=true;const stale=(await h.service.list()).coins[0];assert.equal(stale.volume24h,null);assert.equal(stale.movingReason,null);
});
test('quote volume survives a missing USD reference without inventing a dollar total',async t=>{
  const l=launch(1),h=harness(t,[l],{activity:{read:async()=>curveActivity(l,BASE),close(){}}});h.snapshots.set(key(1),{quote:{mint:SOL_MINT,usd:null,at:BASE,stale:true}});
  await h.service.list();await Promise.all(h.service.activityPending.values());const coin=(await h.service.token(key(1))).coin;assert.equal(coin.volume24h,null);assert.equal(coin.volume24hQuote,6809.554541);assert.equal(coin.volumeUsdEstimate,false);
});
test('incomplete trade coverage is explicitly observed volume rather than a 24-hour total',async t=>{
  const l=launch(1),h=harness(t,[l],{activity:{read:async()=>curveActivity(l,BASE,{h24:{quote:30,buys:2,sells:1,complete:false}}),close(){}}});
  await h.service.list();await Promise.all(h.service.activityPending.values());const coin=(await h.service.token(key(1))).coin;assert.equal(coin.volume24h,null);assert.equal(coin.volumeObserved,300);assert.equal(coin.volumeComplete,false);
});
test('custom-pair candle prices remain available when Raydium omits volume',async t=>{
  const h=harness(t,undefined,{history:{read:async()=>({candles:[{time:Math.floor(BASE/1000)-60,open:.001,high:.002,low:.001,close:.002,volume:null}]}),close(){}}});const data=await h.service.market(key(1));assert.equal(data.native.candles.length,1);assert.equal(data.native.candles[0].volume,null);
});

test('public creator pages whitelist profile data, expose only confirmed coins, and label peaks as tracked rather than complete ATH',async t=>{
 const h=harness(t,[launch(1),launch(2,{state:'draft'})]);const data=await h.service.creator('public_creator');assert.equal(data.total,1);assert.equal(data.profile.username,'public_creator');assert.equal(data.coins[0].athComplete,false);assert.equal(data.coins[0].trackedAthFdvUsd,data.coins[0].fdvUsd);
 const old=data.coins[0].trackedAthFdvUsd;h.snapshots.set(key(1),{fdvUsd:old/2});h.advance(61000);const later=await h.service.creator('public_creator');assert.equal(later.coins[0].trackedAthFdvUsd,old);assert(!JSON.stringify(later).includes('PRIVATE'));await assert.rejects(h.service.creator('../private'),/not found/);
});

test('hidden launches are excluded from discovery, creator profiles and direct token lookups',async t=>{
 const hidden=launch(1,{moderation:{hidden:true}}),h=harness(t,[hidden,launch(2)]);
 assert.equal((await h.service.list()).total,1);await assert.rejects(h.service.find(hidden.keys.mint.address),/not found/);
 await assert.rejects(h.service.trades(hidden.keys.mint.address),/not found/);await assert.rejects(h.service.holders(hidden.keys.mint.address),/not found/);
 assert.equal((await h.service.creator('public_creator')).coins.some(c=>c.mint===hidden.keys.mint.address),false);
});

test('trading lookup bypasses the public cache after a launch is hidden',async t=>{
 const row=launch(1),h=harness(t,[row]);await h.service.find(row.keys.mint.address);
 h.books.get('account-a').launches[0].moderation={hidden:true};
 assert.equal((await h.service.find(row.keys.mint.address)).coin.mint,row.keys.mint.address);
 await assert.rejects(h.service.findForTrade(row.keys.mint.address),/not found/);
});

test('trading lookup fails closed when the current inventory cannot be verified',async t=>{
 const row=launch(1),h=harness(t,[row]);await h.service.find(row.keys.mint.address);
 h.service.accounts.list=async()=>{throw Error('Storage unavailable');};
 await assert.rejects(h.service.findForTrade(row.keys.mint.address),/temporarily unavailable/);
});

test('one thousand identical listings share one catalogue calculation and cached response without aliasing callers',async t=>{
  const h=harness(t,Array.from({length:100},(_,i)=>launch(i+1)));let builds=0;
  const build=h.service.buildList.bind(h.service);h.service.buildList=async filters=>{builds++;return build(filters);};
  const rows=await Promise.all(Array.from({length:1000},()=>h.service.list({stage:'new',limit:10})));
  assert.equal(builds,1);assert.equal(h.registryReads,1);assert(rows.every(row=>row.total===100&&row.coins.length===10));
  rows[0].coins[0].name='caller mutation';assert.notEqual(rows[1].coins[0].name,'caller mutation');
  assert.notEqual((await h.service.list({stage:'new',limit:10})).coins[0].name,'caller mutation');assert.equal(builds,1);
  h.books.get('account-a').launches[0].moderation={hidden:true};h.service.registryLoaded=false;
  const hidden=await h.service.list({stage:'new',limit:10});assert.equal(hidden.total,99);assert.equal(builds,2);
});
test('fresh trade moderation checks only the indexed owner journal and rejects a newly banned creator',async t=>{
  const h=harness(t,[launch(1)]);await h.service.inventory();const reads=[],storeFor=h.service.accounts.storeFor;
  let banned=false;h.service.accounts.get=async id=>({id,username:'public_creator',banned});
  h.service.accounts.storeFor=id=>({read:async(...args)=>{reads.push(id);return storeFor(id).read(...args);}});
  await Promise.all(Array.from({length:50},()=>h.service.findForTrade(key(1))));
  assert.equal(h.registryReads,1);assert.equal(reads.length,50);assert(reads.every(id=>id==='account-a'));
  banned=true;await assert.rejects(h.service.findForTrade(key(1)),{statusCode:403});
  banned=false;h.books.get('account-a').launches[0].moderation={hidden:true};await assert.rejects(h.service.findForTrade(key(1)),{statusCode:404});
});
test('stale executed trades remain chartable without becoming fresh volume or momentum',async t=>{
  const l=launch(1);let failed=false;const trades=[{time:Math.floor(BASE/1000)-30,side:'buy',quote:2,amount:4,wallet:key(5),signature:'1'.repeat(64)}];
  const h=harness(t,[l],{activity:{read:async()=>{if(failed)throw Error('offline');return {...curveActivity(l,BASE),trades};},close(){}}});
  const first=await h.service.market(key(1));await Promise.all(h.service.activityPending.values());assert.equal(first.native.trades.length,1);
  h.advance(31000);failed=true;await h.service.market(key(1));await Promise.all(h.service.pending.values());await Promise.all(h.service.activityPending.values());const stale=await h.service.market(key(1));
  assert.equal(stale.native.tradesStale,true);assert.deepEqual(stale.native.trades,trades);assert.equal(stale.coin.volume24h,null);assert.notEqual(stale.coin.movingReason,'volume');
});

test('catalogue observations enqueue distinct trade histories instead of dropping them behind three slow reads',async t=>{
  let release,reads=0;const gate=new Promise(resolve=>{release=resolve;}),rows=Array.from({length:20},(_,i)=>launch(i+1));
  const h=harness(t,rows,{activity:{read:async()=>{reads++;await gate;return null;},close(){}}});
  try{await h.service.inventory();await h.service.warm([...h.service.records.values()],{max:20,wait:100});assert.equal(reads,20);assert.equal(h.service.activityPending.size,20);}
  finally{release();await Promise.all(h.service.activityPending.values());}
});

test('known market and token data return immediately while slow native and history refreshes continue',async t=>{
  let release,blocked=false;const gate=new Promise(resolve=>{release=resolve;});
  const history={read:async()=>{if(blocked)await gate;return {at:BASE,candles:[{time:BASE/1000-60,open:1,high:1,low:1,close:1,volume:0}]};},close(){}};
  const h=harness(t,[launch(1)],{history});const original=await h.service.market(key(1));h.advance(31000);blocked=true;h.blocking=gate;
  let timer;
  try{
    const responses=await Promise.race([Promise.all([h.service.market(key(1)),h.service.token(key(1))]),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),200);})]);
    assert(responses,'last-good responses must not wait for a provider');const [market,token]=responses;
    assert.equal(market.native.at,original.native.at);assert.equal(market.native.stale,false);assert.equal(market.native.historyAt,original.native.historyAt);assert.equal(market.native.historyStale,true);assert.equal(market.refreshing,true);assert.equal(token.coin.stale,false);assert.equal(token.refreshing,true);
    assert.equal(market.coin.fdvUsd,original.coin.fdvUsd,'a background refresh keeps a still-fresh USD price visible');
    h.advance(30000);assert.equal((await h.service.market(key(1))).coin.fdvUsd,null,'expired curve data must still be withheld');
  }finally{clearTimeout(timer);h.blocking=null;blocked=false;release();await Promise.all(h.service.pending.values());await Promise.all([...h.service.entries.values()].map(entry=>entry.historyPending).filter(Boolean));}
});

test('late shared USD references immediately enrich every fresh matching curve without advancing its observation time',async t=>{
  let release;
  const rows=[launch(1),launch(2),launch(3,{input:{quoteMint:stock.mint}})],h=harness(t,rows);
  for(const row of rows)h.snapshots.set(row.keys.mint.address,{quote:{mint:row.input.quoteMint,usd:null,at:null,stale:true},priceUsd:null,fdvUsd:null});
  await h.service.list();
  const initialAt=h.service.entries.get(key(1)).native.at;
  const oldChain=await h.service.chain();h.service.chainPromise=null;
  h.service.chainFactory=async()=>({...oldChain,referencePrice:async()=>{await new Promise(resolve=>{release=resolve;});return {usd:'125',at:h.now,source:'https://PRIVATE-KEY'};}});
  const chain=await h.service.chain(),job=chain.referencePrice({quoteMint:SOL_MINT},{});
  h.advance(2000);release();await job;
  const coins=(await h.service.list()).coins;
  assert.equal(coins.find(c=>c.mint===key(1)).fdvUsd,125e6);assert.equal(coins.find(c=>c.mint===key(2)).priceUsd,.125);
  assert.equal(coins.find(c=>c.mint===key(3)).fdvUsd,null);assert.equal(h.service.entries.get(key(1)).native.at,initialAt);
  assert(!JSON.stringify(await h.service.market(key(1))).includes('PRIVATE-KEY'));
});

test('quote enrichment rejects wrong mint, expired and future references and never revives stale reserves',async t=>{
  const h=harness(t);h.snapshots.set(key(1),{quote:{mint:SOL_MINT,stale:true},fdvUsd:null,priceUsd:null});await h.service.list();
  for(const ref of [{mint:stock.mint,usd:100,at:h.now},{usd:100,at:h.now-60001},{usd:100,at:h.now+1},{usd:Infinity,at:h.now},{usd:true,at:h.now},{usd:100,at:h.now,stale:true}])h.service.applyQuoteReference(SOL_MINT,ref);
  assert.equal(h.service.entries.get(key(1)).native.fdvUsd,null);
  h.advance(61000);h.service.applyQuoteReference(SOL_MINT,{usd:100,at:h.now});assert.equal(h.service.entries.get(key(1)).native.fdvUsd,null);
});

test('a fresh exact-pair DEX USD value can price a verified curve while its quote reference is unavailable',async t=>{
  const row=launch(1),h=harness(t,[row]);h.snapshots.set(key(1),{quote:{mint:SOL_MINT,stale:true},fdvUsd:null,priceUsd:null});h.dexRows.set(key(1),[pool(row)]);
  const coin=(await h.service.list()).coins[0];assert.equal(coin.fdvUsd,1.2e6);assert.equal(coin.priceUsd,.1);assert.equal(coin.fdvQuote,1e6);assert.equal(coin.marketSource,'DEX Screener');assert.equal(coin.marketAt,h.now);
  h.advance(121000);h.error=true;assert.equal((await h.service.list()).coins[0].fdvUsd,null);
});

test('a quote reference expires separately from a newer curve observation',async t=>{
  const h=harness(t);h.snapshots.set(key(1),{quote:{mint:SOL_MINT,usd:10,at:BASE-50000,stale:false}});await h.service.list();h.advance(11000);
  const coin=h.service.coin(h.service.records.get(key(1)));assert.equal(coin.fdvUsd,null);assert.equal(coin.priceUsd,null);assert.equal(coin.fdvQuote,1e6);
});

test('a cold catalogue requests short follow-up polling until queued snapshots complete',async t=>{
  const h=harness(t);let release;h.blocking=new Promise(resolve=>{release=resolve;});
  try{const loading=await h.service.list();assert.equal(loading.refreshing,true);assert.equal(loading.refreshMs,3000);}
  finally{h.blocking=null;release();await Promise.all(h.service.pending.values());}
  h.advance(2100);const ready=await h.service.list();assert.equal(ready.refreshing,false);assert.equal(ready.refreshMs,30000);
});

test('a late shared activity result updates volume without waiting for another curve refresh',async t=>{
  let release;const pending=new Map(),row=launch(1),job=new Promise(resolve=>{release=resolve;});pending.set(row.curve,job);
  const h=harness(t,[row],{activity:{pending,read:async()=>null,close(){}}});
  try{
    assert.equal((await h.service.list()).coins[0].volume24h,null);
    const windows=Object.fromEntries(['m5','h1','h24'].map(key=>[key,{quote:12,buys:1,sells:0,complete:true}]));
    release({poolId:row.curve,at:h.now,windows,trades:[],stale:false});await Promise.all(h.service.activityPending.values());
    assert.equal(h.service.coin(h.service.records.get(key(1))).volume24h,120);
    assert.equal(h.calls,1);
  }finally{release(null);pending.clear();}
});

test('user search matches only public usernames and counts only visible launched coins',async t=>{
  const h=harness(t,[launch(1),launch(2,{moderation:{hidden:true}}),launch(3,{state:'draft'}),launch(4,{listArchive:{archived:true}})]);
  const users=[{id:'account-a',username:'sunrise',bio:'Public bio\u0000',avatar:'/token-images/'+'a'.repeat(64)+'.png',mainWallet:'PRIVATE-WALLET',email:'PRIVATE-EMAIL',apiKey:'PRIVATE-API'}, {id:'account-b',username:'rising_sun',bio:'Also public',avatar:'https://private.invalid/image',banned:false}, {id:'account-c',username:'sun_banned',bio:'PRIVATE-BANNED',banned:true}, {id:'account-d',username:'invalid profile',bio:'PRIVATE-INVALID'}];
  h.service.accounts.list=async()=>users;
  const result=await h.service.users({search:' @SUN ',limit:1});
  assert.equal(result.total,2);assert.equal(result.nextOffset,1);assert.deepEqual(result.users,[{username:'sunrise',bio:'Public bio',avatar:'/token-images/'+'a'.repeat(64)+'.png',launchCount:1}]);
  const next=await h.service.users({search:'sun',offset:1,limit:1});assert.equal(next.users[0].username,'rising_sun');assert.equal(next.users[0].launchCount,0);assert.equal(next.users[0].avatar,null);assert.equal(next.nextOffset,null);
  assert(!JSON.stringify(result).includes('PRIVATE'));assert(!JSON.stringify(result).includes('account-a'));assert.equal(h.calls,0,'search should not request market RPC data');
  for(const query of ['PRIVATE','account-a','Public bio','PRIVATE-WALLET','PRIVATE-EMAIL'])assert.equal((await h.service.users({search:query})).total,0);
  assert.deepEqual((await h.service.creator('sunrise')).coins.map(coin=>coin.symbol),['C1']);
  await assert.rejects(h.service.creator('sun_banned'),{statusCode:404});
});

test('user search returns current public profile fields, sorts exact and prefix matches, and validates pages',async t=>{
  const h=harness(t,[]),profiles=[{id:'account-a',username:'sunset'}, {id:'account-b',username:'the_sun'}, {id:'account-c',username:'sun'}];h.service.accounts.list=async()=>profiles;
  const found=await h.service.users({search:'sun'});assert.deepEqual(found.users.map(row=>row.username),['sun','sunset','the_sun']);
  profiles[0].username='new_sunset';profiles[0].banned=true;
  assert.deepEqual((await h.service.users({search:'sun'})).users.map(row=>row.username),['sun','the_sun']);
  for(const query of [{search:'a'.repeat(101)},{search:3},{offset:-1},{offset:10001},{offset:'nan'},{limit:21},{limit:0},{limit:1.5}])await assert.rejects(h.service.users(query),{statusCode:400});
  assert.deepEqual(await h.service.users({search:' @ '}),{users:[],total:0,offset:0,limit:12,nextOffset:null});
});

test('banned creators and archived records do not appear in public discovery or profile lookups',async t=>{
  const h=harness(t,[launch(1)]);h.books.get('account-b').launches.push(launch(2));
  h.service.accounts.list=async()=>[{id:'account-a',username:'banned_creator',banned:true},{id:'account-b',username:'active_creator',banned:false}];
  assert.deepEqual((await h.service.list()).coins.map(row=>row.symbol),['C2']);
  await assert.rejects(h.service.creator('banned_creator'),{statusCode:404});
  const profile=await h.service.creator('active_creator');assert.equal(profile.total,1);assert.equal(profile.coins[0].symbol,'C2');
});

test('public fee DTO preserves confirmed zero holder creator fees and their mode policy without changing graduated fees',async t=>{
  const row=launch(1,{creatorFees:{policy:'taxed-holders-0-v3',ratePpm:0,status:'active',confirmedAt:BASE-1000}});row.input.feeMode='holders';row.input.taxBps=500;row.review.creatorFeeRatePpm=5000;row.review.creatorFeePolicy='flat-0.5-v2';row.review.postGradCreatorBps=5;
  const h=harness(t,[row]),data=await h.service.token(key(1));assert.equal(data.coin.creatorFeeBps,0);assert.equal(data.coin.creatorFeePolicy,'taxed-holders-0-v3');assert.equal(data.coin.postGradCreatorFeeBps,5);assert.equal(data.coin.taxBps,500);
});

test('launch detector shares the inventory TTL, is order-stable and never warms RPC or markets',async t=>{
  const h=harness(t,[launch(1),launch(2)]),first=await h.service.updates();
  assert.deepEqual(Object.keys(first).sort(),['refreshMs','stale','total','version']);
  assert.match(first.version,/^[a-f0-9]{64}$/);assert.equal(first.total,2);assert.equal(first.stale,false);assert.equal(first.refreshMs,10000);
  const checks=await Promise.all(Array.from({length:50},()=>h.service.updates()));
  assert(checks.every(row=>row.version===first.version));assert.equal(h.registryReads,1);
  h.books.get('account-a').launches.reverse();h.advance(10000);
  assert.deepEqual(await h.service.updates(),first);assert.equal(h.registryReads,2);
  h.books.get('account-a').launches[0].credits.quote='Changed private bookkeeping';h.advance(10000);
  assert.deepEqual(await h.service.updates(),first);
  assert.equal(h.calls,0);assert.equal(h.dexCalls,0);assert.equal(h.service.chainPromise,undefined);assert.equal(h.service.activityPending.size,0);
});

test('launch detector changes for public additions and confirmed removals, excluding private and banned records',async t=>{
  const h=harness(t,[launch(1)]),first=await h.service.updates();
  h.books.get('account-a').launches.push(launch(2),launch(3,{state:'draft'}),launch(4,{moderation:{hidden:true}}),launch(5,{listArchive:{archived:true}}),launch(6,{curve:null,state:'failed',operations:[]}));
  h.advance(10000);const added=await h.service.updates();assert.equal(added.total,2);assert.notEqual(added.version,first.version);
  h.books.get('account-a').launches[1].moderation={hidden:true};h.advance(10000);
  assert.deepEqual(await h.service.updates(),first);
  h.books.get('account-b').launches.push(launch(7));
  h.service.accounts.list=async()=>[{id:'account-a',username:'public_creator'},{id:'account-b',username:'banned_creator',banned:true}];h.advance(10000);
  assert.deepEqual(await h.service.updates(),first);
  h.books.get('account-a').launches[0].listArchive={archived:true};h.advance(10000);
  const empty=await h.service.updates();assert.equal(empty.total,0);assert.notEqual(empty.version,first.version);
  const json=JSON.stringify(empty);assert(!json.includes('PRIVATE'));assert(!json.includes('account-a'));assert(!json.includes(key(200)));
});

test('launch detector preserves its complete baseline during partial, malformed and failed reads',async t=>{
  const h=harness(t,[launch(1)]);h.books.get('account-b').launches.push(launch(2));
  const complete=await h.service.updates(),storeFor=h.service.accounts.storeFor,list=h.service.accounts.list;
  h.service.accounts.storeFor=id=>id==='account-b'?{read:async()=>{throw Error('PRIVATE storage details');}}:storeFor(id);
  h.advance(10000);const partial=await h.service.updates();assert.deepEqual(partial,{...complete,stale:true});assert.equal(h.service.records.size,1);
  h.service.accounts.storeFor=id=>id==='account-b'?{read:async()=>({invalid:true})}:storeFor(id);
  h.advance(10000);assert.deepEqual(await h.service.updates(),partial);
  h.service.accounts.list=async()=>{throw Error('PRIVATE registry details');};h.advance(10000);
  assert.deepEqual(await h.service.updates(),partial);
  h.service.accounts.list=list;h.service.accounts.storeFor=storeFor;
  h.books.get('account-b').launches[0].moderation={hidden:true};h.advance(10000);
  const recovered=await h.service.updates();assert.equal(recovered.stale,false);assert.equal(recovered.total,1);assert.notEqual(recovered.version,complete.version);
  assert.equal(h.calls,0);assert.equal(h.dexCalls,0);
});

test('launch detector fails closed before any complete public inventory exists',async t=>{
  const h=harness(t),storeFor=h.service.accounts.storeFor;
  h.service.accounts.storeFor=()=>({read:async()=>{throw Error('PRIVATE storage details');}});
  await assert.rejects(h.service.updates(),{statusCode:503,message:'Coin discovery is temporarily unavailable.'});
  h.service.accounts.storeFor=storeFor;h.advance(10000);
  assert.equal((await h.service.updates()).total,1);assert.equal(h.calls,0);assert.equal(h.dexCalls,0);
});

test('recent buys sorts by verified per-curve buys and never by a sell, launch date or foreign pool',async t=>{
  const rows=Array.from({length:6},(_,index)=>launch(index+1)),seconds=Math.floor(BASE/1000);
  const byCurve=new Map(rows.map(row=>[row.curve,{...curveActivity(row,BASE),trades:[]}]));
  byCurve.get(rows[0].curve).trades=[{side:'buy',time:seconds-50},{side:'sell',time:seconds}];
  byCurve.get(rows[1].curve).trades=[{side:'buy',time:seconds-10}];
  byCurve.get(rows[2].curve).trades=[{side:'sell',time:seconds}];
  byCurve.set(rows[3].curve,{...curveActivity(rows[0],BASE),trades:[{side:'buy',time:seconds}]});
  byCurve.get(rows[4].curve).trades=[{side:'buy',time:seconds}];byCurve.get(rows[4].curve).stale=true;
  byCurve.get(rows[5].curve).trades=[{side:'buy',time:seconds+61},{side:'buy',time:seconds-86401},{side:'buy',time:seconds-.5},{side:'buy',time:'1790000000'}];
  const h=harness(t,rows,{activity:{read:async curve=>byCurve.get(curve),close(){}}});
  await h.service.list({sort:'recentBuys'});await Promise.all(h.service.activityPending.values());h.service.listCache.clear();
  const result=await h.service.list({sort:'recentBuys'});
  assert.deepEqual(result.coins.map(coin=>coin.symbol),['C2','C1','C3','C4','C5','C6']);
  assert.equal(result.coins[0].lastBuyAt,(seconds-10)*1000);assert.equal(result.coins[1].lastBuyAt,(seconds-50)*1000);
  assert(result.coins.slice(2).every(coin=>coin.lastBuyAt===null));
  h.advance(61000);h.error=true;h.service.activity.read=async()=>{throw Error('unavailable');};
  await h.service.list({sort:'recentBuys'});await Promise.all(h.service.activityPending.values());h.service.listCache.clear();
  assert((await h.service.list({sort:'recentBuys'})).coins.every(coin=>coin.lastBuyAt===null));
});

test('a ticker typed as it is displayed ($C1) finds the same coins as the plain ticker',async t=>{
  const h=harness(t,[launch(1),launch(2)]);
  const plain=await h.service.list({search:'C1'}),dollar=await h.service.list({search:'$C1'}),spaced=await h.service.list({search:' $c1 '});
  assert.ok(dollar.coins.some(coin=>coin.symbol==='C1'));assert.deepEqual(dollar.coins.map(coin=>coin.mint),plain.coins.map(coin=>coin.mint));assert.deepEqual(spaced.coins.map(coin=>coin.mint),plain.coins.map(coin=>coin.mint));
  assert.equal((await h.service.list({search:'$'})).total,2);
});

test('a contract address matches from its start or in full; a single letter does not match every coin by its address',async t=>{
  const h=harness(t,[launch(1),launch(2)]);
  const all=await h.service.list({}),[first]=all.coins;
  const byPrefix=await h.service.list({search:first.mint.slice(0,6)}),byFull=await h.service.list({search:first.mint});
  assert.ok(byPrefix.coins.some(coin=>coin.mint===first.mint));assert.deepEqual(byFull.coins.map(coin=>coin.mint),[first.mint]);
  const middle=first.mint.slice(10,16),inside=await h.service.list({search:middle});
  assert.ok(!inside.coins.some(coin=>coin.mint===first.mint&&!coin.name.toLowerCase().includes(middle.toLowerCase())&&!coin.symbol.toLowerCase().includes(middle.toLowerCase())),'a fragment from the middle of an address does not match by address');
});

test('administrator usernames are not listed by the public user search',async t=>{
  const h=harness(t,[]);h.service.accounts.list=async()=>[{id:'account-a',username:'owner',role:'admin'},{id:'account-b',username:'owner_fan',role:'user'},{id:'account-c',username:'owner_two'}];
  const found=await h.service.users({search:'owner'});
  assert.deepEqual(found.users.map(row=>row.username),['owner_fan','owner_two']);assert.equal(found.total,2);
});

test('launch books are decrypted again only when their file changes, and accounts without a book are never decrypted',async t=>{
  const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{randomBytes}=await import('node:crypto'),{TelegramStore}=await import('../src/telegram-store.mjs');
  const dir=mkdtempSync(join(tmpdir(),'explore-books-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const stores=new Map(),reads=new Map();
  const storeFor=id=>{if(!stores.has(id)){const store=new TelegramStore(join(dir,id),randomBytes(32),'account:'+id),read=store.read.bind(store);store.read=async(...args)=>{reads.set(id,(reads.get(id)||0)+1);return read(...args);};stores.set(id,store);}return stores.get(id);};
  await storeFor('creator').write('launchpad',{launches:[launch(1)]});
  let now=BASE;
  const service=new LaunchpadExplore({accounts:{list:async()=>[{id:'creator',username:'public_creator'},{id:'visitor',username:'wallet_visitor'}],storeFor},chainFactory:async()=>({close(){}}),marketData:{pools:async()=>null},history:{read:async()=>null,close(){}},activity:{read:async()=>null,close(){}},now:()=>now,listWaitMs:0});
  t.after(()=>service.close());
  await service.inventory();assert.equal(service.records.size,1);assert.equal(reads.get('creator'),1);
  now+=11_000;await service.inventory();assert.equal(reads.get('creator'),1,'an unchanged book reuses its projection');assert.equal(service.records.size,1);
  // Each pass gets its own copy: one pass's adjustments never leak into the next.
  service.records.get(key(1)).rewardRecord.feeCustody='adjusted';
  now+=11_000;await service.inventory();assert.notEqual(service.records.get(key(1)).rewardRecord.feeCustody,'adjusted');
  await storeFor('creator').write('launchpad',{launches:[launch(1),launch(2)]});
  now+=11_000;await service.inventory();assert.equal(reads.get('creator'),2,'a rewritten book is read at once');assert.equal(service.records.size,2);
  now+=300_000;await service.inventory();assert.equal(reads.get('creator'),3,'and at least every five minutes');
  assert.equal(reads.get('visitor'),undefined);
});

test('Robinhood Chain coins (v71.41) join discovery from the venue service: chain and AMM filters, live numbers, no Solana reads',async t=>{
  const h=harness(t,[launch(1)]);
  const token='0x5321d3645F2EC860a9986b9906885C054C61b50D',nvda='0x000000000000000000000000000000000000AB12';
  const row=(extra={})=>({platform:'robinhood',chain:'robinhood',status:'trading',id:'rh-1',creatorId:'account-a',mint:token,token,venue:'0x8366a39CC670B4001A1121B8F6A443A643e40951',name:'Orbit Garden',symbol:'ORBIT',description:'A garden',image:'/token-images/'+'c'.repeat(64)+'.png',createdAt:BASE-5000,mode:'holders',poolId:'0x'+'7a'.repeat(32),tradeLinks:[{id:'gmgn',label:'GMGN',url:'https://gmgn.ai/robinhood/token/'+token}],
    quoteMint:nvda,quoteSymbol:'NVDA',quoteDecimals:18,quoteName:'NVIDIA',quoteCategory:'stock',quoteLogo:'/robinhood-pairs/logo/'+nvda,creatorFeeBps:0,taxBps:200,postGradCreatorFeeBps:0,tier:'4k',rules:0,coinUrl:'/coin?mint='+token+'&chain=robinhood',explorer:'https://robinhoodchain.blockscout.com/address/'+token,
    live:{priceUsd:0.0000061,marketCapUsd:6100,priceQuote:0.0000000033,progressPercent:12.5,graduated:false,volume24hQuote:3.2,volume24hUsd:580,buys24h:4,sells24h:1,lastBuyAt:BASE-60000,holders:5,marketAt:BASE-20000,quoteUsd:'181.4'},...extra});
  h.service.robinhoodLaunch={publicList:async()=>[row()]};
  const all=await h.service.list({});
  assert.equal(all.coins.length,2,'the Solana coin and the Robinhood coin');
  const rh=all.coins.find(c=>c.mint===token);
  assert.equal(rh.chain,'robinhood');assert.equal(rh.launchMode,'robinhood');assert.equal(rh.quote.symbol,'NVDA');assert.equal(rh.quote.category,'stocks');assert.equal(rh.quote.logo,'/robinhood-pairs/logo/'+nvda);
  assert.equal(rh.marketCapUsd,6100);assert.equal(rh.priceUsd,0.0000061);assert.equal(rh.progressPercent,12.5);assert.equal(rh.volume24h,580);assert.equal(rh.buys24h,4);assert.equal(rh.lastBuyAt,BASE-60000);assert.equal(rh.holders,5);
  assert.equal(rh.creatorFeeBps,0);assert.equal(rh.taxBps,200,'a holder-reward coin carries its tax (v71.41)');assert.equal(rh.stage,'new');assert.equal(rh.curveStatus,'curve');assert.equal(rh.marketSource,'Uniswap v4 pool');assert.equal(rh.coinUrl,'/coin?mint='+token+'&chain=robinhood');assert.equal(rh.tradeLinks[0].label,'GMGN');
  assert.equal(h.received.some(l=>l.keys?.mint?.address===token),false,'no Solana market read for a Robinhood coin');
  assert.deepEqual((await h.service.list({chain:'robinhood'})).coins.map(c=>c.mint),[token],'the chain filter');
  assert.deepEqual((await h.service.list({chain:'solana'})).coins.map(c=>c.chain),['solana']);
  assert.deepEqual((await h.service.list({launchMode:'robinhood'})).coins.map(c=>c.mint),[token],'the AMM filter');
  assert.deepEqual((await h.service.list({category:'stocks'})).coins.map(c=>c.mint),[token],'paired with a stock');
  // Graduated: the stage follows the venue; a hidden row never lists; a malformed row is dropped.
  h.service.robinhoodLaunch={publicList:async()=>[row({status:'graduated',live:{...row().live,graduated:true,progressPercent:100}}),row({id:'rh-2',mint:'0x'+'1'.repeat(40),token:'0x'+'1'.repeat(40),hidden:true}),row({id:'rh-3',mint:'not-an-address',token:'not-an-address'})]};
  h.advance(60000);
  const later=await h.service.list({chain:'robinhood',stage:'all'});
  assert.deepEqual(later.coins.map(c=>[c.mint,c.stage,c.progressPercent]),[[token,'graduated',100]]);
});
