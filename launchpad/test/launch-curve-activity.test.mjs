import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { LaunchCurveActivity } from '../src/launch-curve-activity.mjs';
const NOW=Date.UTC(2026,8,24,12),POOL=new PublicKey(Buffer.alloc(32,1)).toBase58(),OWNER=new PublicKey(Buffer.alloc(32,2)).toBase58();
const row=(n,patch={})=>({poolId:POOL,owner:OWNER,txid:String(n).padStart(64,'1'),side:n%2?'buy':'sell',blockTime:NOW/1000-n*60,amountA:1000,amountB:2,...patch});
const response=(rows,nextPageKey)=>Response.json({success:true,data:{rows,...(nextPageKey?{nextPageKey}:{})}});
test('launch activity sums quote trades over actual time windows, deduplicates pages and caches reads',async()=>{
  let requests=0;const activity=new LaunchCurveActivity({now:()=>NOW,fetcher:async(url,options)=>{requests++;assert.equal(new URL(url).origin,'https://launch-history-v1.raydium.io');assert.equal(options.redirect,'error');return requests===1?response([row(1),row(2)],'next'):response([row(2),row(3),row(4,{blockTime:NOW/1000-4000})]);}});
  const [value,same]=await Promise.all([activity.read(POOL),activity.read(POOL)]);assert.deepEqual(same,value);assert.equal(requests,2);assert.equal(value.complete,true);assert.deepEqual(value.windows.m5,{quote:6,buys:2,sells:1,complete:true});assert.equal(value.windows.h24.quote,8);await activity.read(POOL);assert.equal(requests,2);activity.close();
});
test('the rolling day excludes old trades and counts real zero activity',async()=>{
  const activity=new LaunchCurveActivity({now:()=>NOW,fetcher:async()=>response([row(1),row(2,{blockTime:NOW/1000-86401})],'unused')});const value=await activity.read(POOL);assert.equal(value.windows.h24.quote,2);assert.equal(value.complete,true);activity.close();
  const empty=new LaunchCurveActivity({now:()=>NOW,fetcher:async()=>response([])});assert.equal((await empty.read(POOL)).windows.h24.quote,0);empty.close();
});
test('malformed or unrelated markets cannot supply public volume',async()=>{
  for(const patch of [{poolId:OWNER},{owner:'bad'},{side:'transfer'},{amountB:-1},{amountB:'2'},{amountA:0},{txid:'bad'},{blockTime:NOW}]){
    const activity=new LaunchCurveActivity({now:()=>NOW,fetcher:async()=>response([row(1,patch)])});assert.equal(await activity.read(POOL),null);activity.close();
  }
});
test('full pages without a cursor and bounded large histories report partial totals',async()=>{
  const rows=Array.from({length:100},(_,n)=>row(n+1,{txid:'2'.repeat(63)+('3456789ABCDEFGHJKLMNPQRSTUVWXYZ'[n%29]),blockTime:NOW/1000-n,amountB:n+1}));
  const activity=new LaunchCurveActivity({now:()=>NOW,fetcher:async()=>response(rows)});const value=await activity.read(POOL);assert.equal(value.complete,false);assert.equal(value.windows.h24.complete,false);assert.equal(value.windows.h24.quote,5050);activity.close();
});
test('cooldowns and deadlines do not block a native market snapshot',async()=>{
  let calls=0;const activity=new LaunchCurveActivity({now:()=>NOW,fetcher:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}});}});assert.equal(await activity.read(POOL),null);assert.equal(activity.retryUntil,NOW+120000);assert.equal(await activity.read(OWNER),null);assert.equal(calls,1);activity.close();
  let signal;const hung=new LaunchCurveActivity({timeoutMs:10,fetcher:async(_,options)=>{signal=options.signal;return new Promise(()=>{});}});assert.equal(await hung.read(POOL),null);assert.equal(signal.aborted,true);assert.equal(hung.pending.size,0);hung.close();
});

test('provider failure retains dated trades but marks the volume snapshot stale',async()=>{
  let now=NOW,failed=false;
  const activity=new LaunchCurveActivity({now:()=>now,fetcher:async()=>failed?new Response('',{status:503}):response([row(1)])});
  try{
    const original=await activity.read(POOL);now+=31000;failed=true;const stale=await activity.read(POOL);
    assert.equal(stale.stale,true);assert.equal(stale.at,original.at);assert.deepEqual(stale.trades,original.trades);
    now+=16*60000;assert.equal(await activity.read(POOL),null);
  }finally{activity.close();}
});
