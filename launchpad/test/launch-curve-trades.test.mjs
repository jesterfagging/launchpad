import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { MarketData, AccountMarketData } from '../src/market-data.mjs';
import liquiditySdks from '../src/liquidity-sdks.cjs';

const pk = n => Keypair.fromSeed(Buffer.alloc(32,n)).publicKey.toBase58();
const mint=pk(1), quote=pk(2), curve=pk(3), vaultA=pk(4), vaultB=pk(5), payer=pk(6);
const ray=liquiditySdks.raydium(), program=String(ray.LAUNCHPAD_PROGRAM);
const launch={id:'ab'.repeat(16),mint,curve,input:{network:'mainnet-beta',route:'raydium',symbol:'COIN',quoteMint:quote},review:{price:{usd:999999},devBuy:{gross:'100000000000'}}};
const supply={amount:'1000000000000000',decimals:6};
const json = value => new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function poolData(overrides={}) {
  const layout=ray.LaunchpadPool, data=Buffer.alloc(layout.span);
  createHash('sha256').update('account:PoolState').digest().copy(data,0,0,8);
  for(const [name,value] of Object.entries({mintA:mint,mintB:quote,vaultA,vaultB,...overrides})) new PublicKey(value).toBuffer().copy(data,layout.offsetOf(name));
  return data;
}
function swap(signature='confirmed-swap') {
  const balances=(a,b)=>[{accountIndex:2,mint,uiTokenAmount:{amount:String(a),decimals:6}},{accountIndex:3,mint:quote,uiTokenAmount:{amount:String(b),decimals:8}}];
  return {slot:500,blockTime:1700000000,transaction:{signatures:[signature],message:{accountKeys:[{pubkey:payer,signer:true},{pubkey:curve},vaultA,vaultB],instructions:[{programId:program,accounts:[payer,curve,vaultA,vaultB],data:bs58.encode(Buffer.concat([createHash('sha256').update('global:buy_exact_in').digest().subarray(0,8),Buffer.alloc(16)]))}]}},meta:{err:null,fee:5000,preTokenBalances:balances(1000000000,10000000000),postTokenBalances:balances(900000000,10200000000)}};
}
function fixture(t, {data=poolData(),owner=program,transactions=[swap()],signatures,now=()=>1700000000000}={}) {
  const requests=[];
  const gate={acquire:async()=>{},removeClient:()=>{},cooldown:()=>{}};
  const feed=new MarketData({now,solanaRpcUrl:'https://rpc.example.com/?api-key=private',rpcGate:gate,fetcher:async()=>assert.fail('DEX/other public providers must not be called'),rpcFetcher:async(url,options)=>{
    const {method,params}=JSON.parse(options.body);requests.push({method,params});
    if(method==='getAccountInfo') {assert.equal(params[0],curve);return json({result:{value:{owner,data:[data.toString('base64'),'base64']}}});}
    if(method==='getTokenSupply') {assert.equal(params[0],mint);return json({result:{value:supply}});}
    if(method==='getSignaturesForAddress') {assert.equal(params[0],curve);return json({result:signatures||transactions.map(tx=>({signature:tx.transaction.signatures[0],err:null,confirmationStatus:'confirmed'}))});}
    if(method==='getTransaction')return json({result:transactions.find(tx=>tx.transaction.signatures[0]===params[0])||null});
    assert.fail('Unexpected RPC '+method);
  }});
  t.after(()=>feed.close());return {feed,requests};
}
function snapshot(at=1700000000000,changes={}) {return {launchId:launch.id,mint,curve,status:'curve',at,stale:false,supply:1e9,quote:{mint:quote,symbol:'WBTC',usd:50000,at,stale:false},...changes};}

test('LaunchLab live swaps appear before DEX indexing using the real pool layout and confirmed transactions',async t=>{
  const {feed,requests}=fixture(t),result=await feed.launchTrades(launch,snapshot());
  assert.equal(result.trades.length,1);const trade=result.trades[0];
  assert.equal(trade.side,'buy');assert.equal(trade.tokenAmount,'100');assert.equal(trade.quoteAmount,'2');assert.equal(trade.quoteSymbol,'WBTC');
  assert.equal(trade.amountUsd,100000);assert.equal(trade.priceUsd,1000);assert.equal(trade.fdvUsd,1e12);assert.equal(trade.marketCapUsd,null);
  assert.equal(result.address,curve);assert.equal(result.tokenAddress,mint);assert.equal(result.launchId,launch.id);assert.equal(result.refreshMs,1000);
  for(const {method,params} of requests)assert.equal(params[1].commitment,'confirmed',method);
  assert.equal(requests.filter(row=>row.method==='getTransaction').length,1);
  assert(!JSON.stringify(result).includes('private'));
});

test('unindexed launch swaps never use the launch review USD reference and revalue cached rows only with a fresh matching reference',async t=>{
  const {feed,requests}=fixture(t);
  const bare=await feed.launchTrades(launch);assert.equal(bare.trades[0].amountUsd,null);assert.equal(bare.trades[0].fdvUsd,null);
  const priced=await feed.launchTrades(launch,snapshot());assert.equal(priced.trades[0].amountUsd,100000);assert.equal(priced.trades[0].quoteSymbol,'WBTC');
  const changed=await feed.launchTrades(launch,snapshot(undefined,{quote:{mint:quote,symbol:'WBTC',usd:25000,at:1700000000000,stale:false}}));assert.equal(changed.trades[0].amountUsd,50000);
  for(const change of [
    {launchId:'cd'.repeat(16)}, {mint:pk(7)}, {curve:pk(7)}, {at:1700000000001}, {at:1700000000000-15001}, {stale:true},
    {quote:{mint:pk(7),usd:50000,at:1700000000000}}, {quote:{mint:quote,usd:50000,at:1700000000001}},
    {quote:{mint:quote,usd:50000,at:1700000000000-60001}}, {quote:{mint:quote,usd:50000,at:1700000000000,stale:true}},
    {quote:{mint:quote,usd:Infinity,at:1700000000000}},
  ]) {const result=await feed.launchTrades(launch,snapshot(undefined,change));assert.equal(result.quoteUsd,null);assert.equal(result.trades[0].amountUsd,null);assert.equal(result.trades[0].priceUsd,null);assert.equal(result.trades[0].fdvUsd,null);}
  assert.equal(requests.filter(row=>row.method==='getTransaction').length,1,'the cached native trade can be safely valued without another RPC call');
});

test('wrong mint, wrong pool discriminator and unrelated program cannot become launch trades',async t=>{
  const invalidDiscriminator=poolData();invalidDiscriminator[0]^=1;
  for(const options of [{data:poolData({mintA:pk(7)})},{data:poolData({mintB:pk(7)})},{data:invalidDiscriminator},{owner:pk(7)}]) {
    const {feed,requests}=fixture(t,options),result=await feed.launchTrades(launch);
    assert.equal(result.unsupported,true);assert.deepEqual(result.trades,[]);assert(!requests.some(row=>row.method==='getTransaction'));
  }
});

test('nonmainnet, missing and malformed launch descriptors are rejected before RPC reads',async t=>{
  const {feed,requests}=fixture(t);
  for(const bad of [null,{...launch,id:'x'},{...launch,curve:null},{...launch,curve:mint},{...launch,mint:'bad'},{...launch,input:{...launch.input,network:'devnet'}},{...launch,input:{...launch.input,route:'pumpswap'}},{...launch,input:{...launch.input,quoteMint:mint}}]) {
    await assert.rejects(feed.launchTrades(bad),error=>error.statusCode===400);
  }
  assert.deepEqual(requests,[]);
});

test('failed swaps and an empty launch history never synthesize the developer buy from review data',async t=>{
  const failed=swap('failed');failed.meta.err={InstructionError:[0,'failure']};
  const {feed}=fixture(t,{transactions:[failed]}),result=await feed.launchTrades(launch,snapshot());assert.deepEqual(result.trades,[]);
  const empty=fixture(t,{transactions:[]});assert.deepEqual((await empty.feed.launchTrades(launch,snapshot())).trades,[]);
  const erroredSignature=fixture(t,{signatures:[{signature:'failed',err:{InstructionError:[0,'failure']},confirmationStatus:'confirmed'}]});
  assert.deepEqual((await erroredSignature.feed.launchTrades(launch)).trades,[]);assert(!erroredSignature.requests.some(row=>row.method==='getTransaction'));
});

test('account launch trade feeds isolate credentials and caches while budgeting by endpoint',async t=>{
  const requests=[],scopes=[],gate={acquire:async scope=>scopes.push(scope),removeClient:()=>{},cooldown:()=>{}};
  const connections={market:{readSettings:async id=>({revision:id,settings:{}})},solana:{rpcGate:gate,readSettings:async id=>({settings:{rpcUrl:`https://rpc.example.com/?api-key=${id}`,rpcRequestsPerSecond:'8'}})}};
  const service=new AccountMarketData(connections,{fetcher:async()=>assert.fail('No shared DEX or host credentials'),rpcFetcher:async(url,options)=>{
    const account=new URL(url).searchParams.get('api-key'),{method}=JSON.parse(options.body);requests.push([account,method]);
    if(method==='getAccountInfo')return json({result:{value:{owner:program,data:[poolData().toString('base64'),'base64']}}});
    if(method==='getTokenSupply')return json({result:{value:supply}});
    if(method==='getSignaturesForAddress')return json({result:[{signature:`swap-${account}`,err:null,confirmationStatus:'confirmed'}]});
    if(method==='getTransaction')return json({result:swap(`swap-${account}`)});
    assert.fail(method);
  }});t.after(()=>service.close());
  const a=await service.launchTrades('alice',launch),b=await service.launchTrades('bob',launch);
  assert.equal(a.trades[0].signature,'swap-alice');assert.equal(b.trades[0].signature,'swap-bob');
  assert.equal(requests.filter(([id,method])=>id==='alice'&&method==='getTransaction').length,1);assert.equal(requests.filter(([id,method])=>id==='bob'&&method==='getTransaction').length,1);
  const endpointScope=id=>'rpc:'+createHash('sha256').update(new URL(`https://rpc.example.com/?api-key=${id}`).href).digest('hex');
  assert.deepEqual(new Set(scopes),new Set([endpointScope('alice'),endpointScope('bob')]));
  assert(!scopes.some(scope=>scope.includes('alice')||scope.includes('bob')||scope.includes('api-key')));
  await service.launchTrades('alice',launch);assert.equal(requests.filter(([,method])=>method==='getTransaction').length,2);
  assert(!JSON.stringify([a,b]).includes('api-key'));
});
