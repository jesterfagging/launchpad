import test from 'node:test';
import assert from 'node:assert/strict';
import { createDammPumpAnalytics } from '../src/damm-pump-analytics.mjs';

const row={platform:'damm-pump',mint:'mint',dammPoolId:'damm',quoteMint:'quote',quoteDecimals:9,quoteSymbol:'SOL',createdAt:1790000000000,confirmationStatus:'finalized',status:'trading'};
function fixture({launches=[row],snapshot=null}={}){
  let advances=0,reads=0,closed=0,records=[],saved=snapshot;
  const legacy={trades:[{signature:'old'}],complete:false};
  const service={analyticsList:async()=>launches,analyticsTrades:async()=>legacy,trades:async()=>legacy.trades};
  const history={sync:async value=>{records=value;},advance:async()=>{advances++;},read:async()=>{reads++;return saved;},close:async()=>{closed++;}};
  const worker=createDammPumpAnalytics({service,history});
  return {service,history,worker,legacy,get records(){return records;},get advances(){return advances;},get closed(){return closed;},get reads(){return reads;},get snapshot(){return saved;},set snapshot(value){saved=value;}};
}

test('analytics worker includes existing finalized hidden launches and binds graduated pools without private fields',async()=>{
  const f=fixture({launches:[{...row,hidden:true,secret:'never',creatorId:'private'}, {...row,mint:'second',status:'migrated',poolId:'pump'}, {...row,mint:'draft',status:'draft'}, {...row,mint:'pending',confirmationStatus:'confirmed'}]});
  await f.worker.tick();
  assert.equal(f.advances,1);assert.equal(f.records.length,2);
  assert.deepEqual(f.records[0],{mint:'mint',curve:'damm',dammPoolId:'damm',poolId:null,createdAt:row.createdAt,baseDecimals:6,quote:{mint:'quote',decimals:9,symbol:'SOL'}});
  assert.equal(f.records[1].poolId,'pump');assert(!JSON.stringify(f.records).includes('private'));assert(!JSON.stringify(f.records).includes('never'));
  await f.worker.close();
});

test('public reads use saved chain history without starting network scans or mixing host duplicates',async()=>{
  const f=fixture();
  assert.deepEqual(await f.service.analyticsTrades('mint'),f.legacy);
  f.snapshot={source:'damm-pump-onchain',trades:[{eventId:'a',signature:'chain',time:1790000000}],complete:false};
  assert.deepEqual(await f.service.analyticsTrades('mint'),f.snapshot);
  assert.deepEqual(await f.service.trades('mint'),f.snapshot.trades);
  assert.equal(f.advances,0);
  f.snapshot={source:'damm-pump-onchain',trades:[],complete:false};
  assert.deepEqual(await f.service.analyticsTrades('mint'),f.legacy);
  f.snapshot={source:'damm-pump-onchain',trades:[],complete:true};
  assert.deepEqual(await f.service.analyticsTrades('mint'),f.snapshot);
  await f.worker.close();
});

test('chain history failure preserves host fallback without affecting the launch worker',async()=>{
  const f=fixture();f.history.read=async()=>{throw Error('provider');};
  assert.deepEqual(await f.service.analyticsTrades('mint'),f.legacy);assert.deepEqual(await f.service.trades('mint'),f.legacy.trades);
  f.history.advance=async()=>{throw Error('provider');};await f.worker.tick();assert.match(f.worker.status().lastError,/syncing/);
  await f.worker.close();assert.equal(f.closed,1);
});

test('concurrent background requests coalesce and close waits for the saved scan',async()=>{
  const f=fixture();let release;const barrier=new Promise(resolve=>{release=resolve;});
  let count=0;f.history.advance=async()=>{count++;await barrier;};
  const first=f.worker.tick(),second=f.worker.tick();assert.equal(first,second);
  await Promise.resolve();await Promise.resolve();
  const closing=f.worker.close();assert.equal(f.closed,1,'Stop scheduling history requests immediately');release();await closing;
  assert.equal(count,1);assert.equal(f.closed,1);await f.worker.tick();assert.equal(count,1);
});

test('recent trade feed caps at 200 and sorts by chain time',async()=>{
  const trades=Array.from({length:240},(_,i)=>({eventId:String(i),time:1790000000+i}));
  const f=fixture({snapshot:{source:'damm-pump-onchain',trades,complete:false}});
  const recent=await f.service.trades('mint');assert.equal(recent.length,200);assert.equal(recent[0].eventId,'239');assert.equal(recent.at(-1).eventId,'40');assert.equal(trades[0].eventId,'0');
  await f.worker.close();
});
