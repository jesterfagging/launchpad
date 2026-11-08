import test from 'node:test';
import assert from 'node:assert/strict';
import { LaunchMarketFeed } from '../src/launchpad-market-feed.mjs';
import { Launchpad } from '../src/launchpad.mjs';
import { MarketData } from '../src/market-data.mjs';

const ID='a'.repeat(32),mint='So11111111111111111111111111111111111111112',quote='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',curve='58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const launch=()=>({id:ID,curve,keys:{mint:{address:mint,secret:'DO-NOT-EXPOSE'},wallet:{secret:'PRIVATE'}},input:{route:'raydium',network:'mainnet-beta',quoteMint:quote,symbol:'TEST'}});
function harness(t){
  let now=1700000000000,calls=0,closed=0,slot=100,error=null,deferred=null,price=.00002,quoteStale=false;
  const files=new Map(),scopes=[],writes=[],storeFor=id=>({read:async(name,fallback)=>structuredClone(files.get(id+':'+name)??fallback),write:async(name,value)=>{writes.push([id,name]);files.set(id+':'+name,structuredClone(value));}});
  const quoteRequests=[];
  const chainFor=async id=>{scopes.push(id);return{marketSnapshot:async(_launch,options)=>{calls++;quoteRequests.push(options.quoteReference);if(deferred)await deferred;if(error)throw error;return{mint,curve,status:'curve',at:now,slot,priceQuote:price,fdvQuote:price*1e9,supply:1e9,raisedQuote:2,targetQuote:50,progressPercent:4,quote:{mint:quote,symbol:'USDC',usd:1,at:now,stale:quoteStale,source:'Market reference'},priceUsd:price,fdvUsd:price*1e9,privateKey:'NEVER',warning:''};},close(){closed++;}};};
  const history={read:async()=>null,close(){}};
  const create=()=>new LaunchMarketFeed({storeFor,chainFor,history,activity:{read:async()=>null,close(){}},now:()=>now});const feed=create();t.after(()=>feed.close());
  return{feed,files,writes,storeFor,chainFor,create,scopes,quoteRequests,get now(){return now;},get calls(){return calls;},get closed(){return closed;},set quoteStale(v){quoteStale=v;},set error(e){error=e;},set deferred(d){deferred=d;},set slot(v){slot=v;},set price(v){price=v;},advance(ms){now+=ms;slot++;}};
}
test('first verified snapshot renders a point without DEX/history, caches requests, and never leaks secrets',async t=>{
  const h=harness(t),l=launch(),v=await h.feed.read('account-a',l);
  assert.equal(v.points.length,1);assert.equal(v.points[0].priceQuote,.00002);assert.equal(v.fdvUsd,20000);assert.deepEqual(v.candles,[]);
  assert(!JSON.stringify(v).includes('NEVER'));assert(!JSON.stringify(v).includes('PRIVATE'));assert.equal(h.closed,1);
  v.points[0].priceQuote=99;const again=await h.feed.read('account-a',l);assert.equal(again.points[0].priceQuote,.00002);assert.equal(h.calls,1);
  h.advance(5000);h.price=.00003;assert.equal((await h.feed.read('account-a',l)).points.length,2);assert.equal(h.calls,2);
});
test('concurrent requests share RPC work and different accounts keep independent observations',async t=>{
  const h=harness(t);let resolve;h.deferred=new Promise(r=>resolve=r);
  const a=h.feed.read('a',launch()),b=h.feed.read('a',launch());await new Promise(r=>setImmediate(r));assert.equal(h.calls,1);resolve();await Promise.all([a,b]);
  h.deferred=null;h.price=.00004;const c=await h.feed.read('b',launch());assert.equal(c.points.length,1);assert.equal(c.points[0].priceQuote,.00004);assert.deepEqual(h.scopes,['a','b']);
});
test('RPC failures retain last verified data with cooldown and never append fake points',async t=>{
  const h=harness(t);const first=await h.feed.read('a',launch());h.advance(5000);h.error=Error('https://private-rpc.example/SECRET');
  const stale=await h.feed.read('a',launch());assert.equal(stale.stale,true);assert.equal(stale.at,first.at);assert.equal(stale.points.length,1);assert(!JSON.stringify(stale).includes('SECRET'));
  await h.feed.read('a',launch());assert.equal(h.calls,2);h.advance(16000);h.error=null;assert.equal((await h.feed.read('a',launch())).stale,false);
});
test('startup failure has a retry deadline and does not repeat failing reads on every refresh',async t=>{
  const h=harness(t);h.error=Error('secret');await assert.rejects(h.feed.read('a',launch()),e=>e.statusCode===503&&e.retryAfterMs>0&&!e.message.includes('secret'));
  await assert.rejects(h.feed.read('a',launch()),/temporarily/);assert.equal(h.calls,1);
});
test('persisted observations survive restart while other mints and regressed RPC slots are excluded',async t=>{
  const h=harness(t),first=await h.feed.read('a',launch());assert.equal(h.writes.length,1);h.advance(5000);const next=h.create();t.after(()=>next.close());
  assert.equal((await next.read('a',launch())).points.length,2);
  h.advance(5000);h.slot=50;const old=await next.read('a',launch());assert.equal(old.stale,true);assert.equal(old.points.length,2);assert(old.slot>50);
  const wrong=launch();wrong.id='b'.repeat(32);h.files.set('a:launch-market-'+wrong.id,{mint:'wrong',curve,points:first.points});
  const fresh=h.create();t.after(()=>fresh.close());assert.equal((await fresh.read('a',wrong)).points.length,1);
});
test('owned launch resolution precedes cached market reads and trade context never exposes launch keys',async t=>{
  const h=harness(t),l=launch();h.files.set('a:launchpad',{version:1,launches:[l]});
  const manager=new Launchpad({storeFor:h.storeFor},null,{chainFactory:h.chainFor,now:()=>h.now,quoteCatalogue:{close(){}}});manager.marketFeed=h.feed;t.after(()=>manager.close());
  assert.equal((await manager.market('a',ID)).mint,mint);await assert.rejects(manager.market('b',ID),/not found/);await assert.rejects(manager.marketTradeContext('b',ID),/not found/);
  const context=await manager.marketTradeContext('a',ID);assert.equal(context.launch.mint,mint);assert(!JSON.stringify(context).includes('PRIVATE'));assert(!JSON.stringify(context).includes('DO-NOT-EXPOSE'));
  const market=new MarketData();t.after(()=>market.close());let decoded=false;market.liveFeed.read=async()=>{decoded=true;return{trades:[]};};
  assert.deepEqual((await market.launchTrades(context.launch,context.snapshot)).trades,[]);assert.equal(decoded,true);
  h.files.set('a:launchpad',{version:1,launches:[]});await assert.rejects(manager.market('a',ID),/not found/);
});
test('unconfirmed or legacy devnet launches cannot start a native chart',async t=>{
  const h=harness(t),l=launch();const manager=new Launchpad({storeFor:h.storeFor},null,{chainFactory:h.chainFor,quoteCatalogue:{close(){}}});t.after(()=>manager.close());
  for(const patch of [{curve:null},{input:{...l.input,network:'devnet'}}]){h.files.set('a:launchpad',{version:1,launches:[{...l,...patch}]});await assert.rejects(manager.market('a',ID),/verified mainnet/);}
  assert.equal(h.calls,0);
});
test('failed USD references cool down without delaying native points or preventing a later retry',async t=>{
  const h=harness(t);h.quoteStale=true;const first=await h.feed.read('a',launch());assert.equal(first.priceUsd,null);assert.equal(first.points.length,1);assert.equal(h.quoteRequests[0],undefined);
  for(let n=0;n<5;n++){h.advance(5000);await h.feed.read('a',launch());assert.equal(h.quoteRequests.at(-1),null);}
  h.advance(5000);h.quoteStale=false;const fresh=await h.feed.read('a',launch());assert.equal(h.quoteRequests.at(-1).mint,quote);assert.equal(fresh.priceUsd,.00002);assert.equal(fresh.points.length,7);
});
test('restart rejects an RPC snapshot behind the last stored observation',async t=>{
  const h=harness(t);await h.feed.read('a',launch());h.advance(5000);h.slot=90;const fresh=h.create();t.after(()=>fresh.close());await assert.rejects(fresh.read('a',launch()),/temporarily/);
});

function delayedReferenceFeed(t){
  let now=1700000000000,closed=0,calls=0,historyWork=null;const waiting=[];
  const chainFor=async()=>({
    referencePrice:()=>{calls++;return new Promise((resolve,reject)=>waiting.push({resolve,reject}));},
    async marketSnapshot(l,options){
      const work=options.quoteReference===null?null:this.referencePrice(l.input,{mint:{decimals:6},extensions:[]});
      // Represent a provider response arriving after the immediate native read.
      // The real snapshot bounds this wait at 1.2s; no real timer is needed here.
      const reference=work?await Promise.race([work,new Promise(resolve=>setImmediate(()=>resolve(null)))]):null;
      return {mint:l.keys.mint.address,curve:l.curve,status:'curve',at:now,slot:100,priceQuote:.00002,fdvQuote:20000,supply:1e9,quote:{mint:quote,symbol:'USDC',usd:reference?.usd??null,at:reference?.at??0,stale:!reference,source:'Market reference'},priceUsd:reference?.usd*.00002||null,fdvUsd:reference?.usd*20000||null,warning:reference?'':'USD pricing is unavailable.'};
    },close(){closed++;},
  });
  const feed=new LaunchMarketFeed({storeFor:()=>({read:async(_name,fallback)=>fallback,write:async()=>{}}),chainFor,history:{read:async()=>historyWork,close(){}},activity:{read:async()=>null,close(){}},now:()=>now});
  t.after(()=>feed.close());
  return {feed,waiting,advance:ms=>{now+=ms;},set historyWork(value){historyWork=value;},get now(){return now;},get calls(){return calls;},get closed(){return closed;}};
}

test('late USD lookup survives native snapshot completion and updates the next owner read without another RPC snapshot',async t=>{
  const h=delayedReferenceFeed(t),l=launch();
  assert.equal((await h.feed.read('a',l)).fdvUsd,null);assert.equal(h.closed,0);
  h.waiting[0].resolve({usd:'1.01',at:h.now,source:'Raw-token reference'});
  await new Promise(resolve=>setImmediate(resolve));
  const value=await h.feed.read('a',l);
  assert.equal(value.fdvUsd,20200);assert.equal(value.priceUsd,.00002*1.01);assert.equal(value.quote.stale,false);assert.equal(value.warning,'');assert.equal(h.closed,1);assert.equal(h.calls,1);
});

test('owner quote work is shared for the same raw mint and account while separate accounts stay isolated',async t=>{
  const h=delayedReferenceFeed(t),a=launch(),b={...launch(),id:'b'.repeat(32)};
  await Promise.all([h.feed.read('a',a),h.feed.read('a',b),h.feed.read('b',a)]);
  assert.equal(h.calls,2);assert.equal(h.closed,0);
  h.waiting[0].resolve({usd:'1.01',at:h.now});h.waiting[1].resolve({usd:'.99',at:h.now});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.feed.peek('a',a.id).fdvUsd,20200);assert.equal(h.feed.peek('a',b.id).fdvUsd,20200);assert.equal(h.feed.peek('b',a.id).fdvUsd,19800);assert.equal(h.closed,3);
  const c={...a,id:'c'.repeat(32)};assert.equal((await h.feed.read('a',c)).fdvUsd,20200);assert.equal(h.calls,2);
});

test('late reference failures release the connection and never turn stale, mismatched or invalid references into dollars',async t=>{
  for(const patch of [{mint:mint},{at:1700000060000},{at:1699999939999},{stale:true},{usd:'0'},{usd:true},{usd:'Infinity'}]){
    const h=delayedReferenceFeed(t),l=launch();await h.feed.read('a',l);
    h.waiting[0].resolve({usd:'1',at:h.now,...patch});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.feed.peek('a',l.id).fdvUsd,null);assert.equal(h.feed.quoteReferences.size,0);assert.equal(h.closed,1);
  }
  const h=delayedReferenceFeed(t),l=launch();await h.feed.read('a',l);h.waiting[0].reject(Error('private provider details'));await new Promise(resolve=>setImmediate(resolve));
  const value=h.feed.peek('a',l.id);assert.equal(value.fdvUsd,null);assert(!JSON.stringify(value).includes('private'));assert.equal(h.closed,1);
});

test('late prices do not reprice expired or graduated curve snapshots',async t=>{
  for(const status of ['expired','migrated']){
    const h=delayedReferenceFeed(t),l=launch();await h.feed.read('a',l);
    if(status==='expired')h.advance(15001);else h.feed.entries.get(h.feed.key('a',l.id)).value.status='migrated';
    h.waiting[0].resolve({usd:'1',at:h.now});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.feed.peek('a',l.id).fdvUsd,null);assert.equal(h.closed,1);
  }
});

test('a quote finishing between native timeout and history completion is applied to the newly installed snapshot',async t=>{
  const h=delayedReferenceFeed(t),l=launch();let release;
  h.historyWork=new Promise(resolve=>{release=resolve;});const work=h.feed.read('a',l);
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  h.waiting[0].resolve({usd:'1.02',at:h.now});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.feed.peek('a',l.id),null);release(null);
  assert.equal((await work).fdvUsd,20400);assert.equal(h.feed.peek('a',l.id).fdvUsd,20400);
});

test('a late quote received after old reserves expire is consumed by the next verified snapshot during quote cooldown',async t=>{
  const h=delayedReferenceFeed(t),l=launch();await h.feed.read('a',l);h.advance(15001);
  h.waiting[0].resolve({usd:'1.02',at:h.now});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.feed.peek('a',l.id).fdvUsd,null);
  assert.equal((await h.feed.read('a',l)).fdvUsd,20400);assert.equal(h.calls,1);
});
