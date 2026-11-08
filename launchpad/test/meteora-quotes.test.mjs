import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey,Keypair} from '@solana/web3.js';
import {MintLayout,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,NATIVE_MINT_2022,ExtensionType,TransferFeeConfigLayout,TransferHookLayout} from '@solana/spl-token';
import {inspectMeteoraQuoteMint,validMeteoraTokenBadge,meteoraTokenBadgeAddress,METEORA_DBC_PROGRAM,MeteoraQuoteCatalogue} from '../src/meteora-quotes.mjs';
const mint=Keypair.generate().publicKey,authority=Keypair.generate().publicKey;
const token=(extensions=[])=>{
  const data=Buffer.alloc(extensions.length?166+extensions.reduce((sum,x)=>sum+4+x.data.length,0):82);
  MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1000000000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},data);
  if(extensions.length){data[165]=1;let at=166;for(const e of extensions){data.writeUInt16LE(e.type,at);data.writeUInt16LE(e.data.length,at+2);e.data.copy(data,at+4);at+=4+e.data.length;}}
  return {data,owner:extensions.length?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,executable:false,lamports:1};
};
const badge=(address=mint)=>({owner:METEORA_DBC_PROGRAM,executable:false,lamports:1,data:Buffer.concat([Buffer.from([116,219,204,229,249,116,255,150]),address.toBuffer(),Buffer.alloc(128)])});
const fee=(older,newer,epoch=10n)=>{const data=Buffer.alloc(TransferFeeConfigLayout.span);TransferFeeConfigLayout.encode({transferFeeConfigAuthority:authority,withdrawWithheldAuthority:authority,withheldAmount:0n,olderTransferFee:{epoch:0n,maximumFee:1000n,transferFeeBasisPoints:older},newerTransferFee:{epoch,maximumFee:1000n,transferFeeBasisPoints:newer}},data);return {type:ExtensionType.TransferFeeConfig,data};};
const hook=(programId,auth=authority)=>{const data=Buffer.alloc(TransferHookLayout.span);TransferHookLayout.encode({programId,authority:auth},data);return{type:ExtensionType.TransferHook,data};};
test('legacy SPL accepted regardless of a pump-like mint suffix; invalid mint owners fail',()=>{
  assert.equal(inspectMeteoraQuoteMint(mint,token()).supported,true);
  assert.equal(inspectMeteoraQuoteMint(mint,{...token(),owner:PublicKey.default}).supported,false);
  assert.equal(inspectMeteoraQuoteMint(NATIVE_MINT_2022,{...token(),owner:TOKEN_2022_PROGRAM_ID}).code,'native_token_2022');
});
test('token badges are exact mint, exact owner and account discriminator proofs',()=>{
  assert.equal(validMeteoraTokenBadge(mint,badge()),true);
  assert.equal(validMeteoraTokenBadge(mint,badge(authority)),false);
  assert.equal(validMeteoraTokenBadge(mint,{...badge(),owner:TOKEN_PROGRAM_ID}),false);
  assert.equal(validMeteoraTokenBadge(mint,{...badge(),data:Buffer.alloc(168)}),false);
  assert.equal(meteoraTokenBadgeAddress(mint).equals(PublicKey.findProgramAddressSync([Buffer.from('token_badge'),mint.toBuffer()],METEORA_DBC_PROGRAM)[0]),true);
});
test('both stored transfer tax schedules must be zero, matching the launch adapter',()=>{
  assert.equal(inspectMeteoraQuoteMint(mint,token([fee(0,100)]),{epoch:9,tokenBadge:badge()}).code,'quote_transfer_fee');
  assert.equal(inspectMeteoraQuoteMint(mint,token([fee(100,0)]),{epoch:9,tokenBadge:badge()}).code,'quote_transfer_fee');
  assert.equal(inspectMeteoraQuoteMint(mint,token([fee(100,0)]),{epoch:10,tokenBadge:badge()}).code,'quote_transfer_fee');
  assert.equal(inspectMeteoraQuoteMint(mint,token([fee(0,0)]),{epoch:10,tokenBadge:badge()}).supported,true);
  assert.equal(inspectMeteoraQuoteMint(mint,token([fee(0,0)]),{epoch:10}).code,'dbc_badge_missing');
});
test('dormant hook with retained authority can pass badge checks; an executing hook cannot',()=>{
  assert.equal(inspectMeteoraQuoteMint(mint,token([hook(authority)]),{epoch:10,tokenBadge:badge()}).code,'active_transfer_hook');
  const dormant=inspectMeteoraQuoteMint(mint,token([hook(PublicKey.default)]),{epoch:10,tokenBadge:badge()});
  assert.equal(dormant.supported,true);assert.equal(dormant.requiresTokenBadge,true);assert.equal(dormant.transferHookAuthorityRetained,true);
  assert.equal(inspectMeteoraQuoteMint(mint,token([hook(PublicKey.default)]),{epoch:10}).code,'dbc_badge_missing');
});
function fixture(options={}){
  let now=1000000,priceCalls=0,batchCalls=0,state=null;const asset={mint:mint.toBase58(),name:'Test',symbol:'TEST',category:'custom'};
  const connection={getEpochInfo:async()=>({epoch:10}),getAccountInfo:async()=>token(),getMultipleAccountsInfo:async keys=>{batchCalls++;return keys.map(()=>token());}};
  const catalogue=new MeteoraQuoteCatalogue({catalogue:{read:async()=>({assets:[asset,asset]})},customAssets:async()=>[],extraAssets:[],connection,price:async()=>{priceCalls++;return{usd:'1',at:now,source:'raw unit quote'};},migrationCheck:async()=>({supported:true,config:authority.toBase58()}),curveCheck:()=>({valid:true}),now:()=>now,store:{read:async()=>state,write:async(k,v)=>{state=v;}},...options});
  return{catalogue,asset,setNow:value=>{now=value;},priceCalls:()=>priceCalls,batchCalls:()=>batchCalls,saved:()=>state};
}
test('catalogue is hidden until the full sweep and persists deduped, verified results',async()=>{
  const f=fixture();assert.equal((await f.catalogue.list()).assets.length,0);
  const complete=await f.catalogue.fullSweep();assert.equal(complete.ready,true);assert.equal(complete.total,1);assert.equal(f.batchCalls(),1);
  const list=await f.catalogue.list();assert.equal(list.assets.length,1);assert.equal(list.assets[0].decimals,6);assert.equal(list.assets[0].launchReady,true);assert.equal(f.saved().sweep.complete,true);
  const count=f.priceCalls();await f.catalogue.status(mint.toBase58(),{fresh:true});assert.equal(f.priceCalls(),count+1,'launch preparation must request fresh proof');
});
test('price/migration failures remain unavailable and never expose credentials in reasons',async()=>{
  const price=fixture({price:async()=>({usd:'1',at:1})});await price.catalogue.fullSweep();assert.equal((await price.catalogue.list()).assets.length,0);assert.equal((await price.catalogue.list({includeUnavailable:true})).assets[0].code,'price_unavailable');
  const migration=fixture({migrationCheck:async()=>({supported:false,reason:'private endpoint'})});await migration.catalogue.fullSweep();assert.equal((await migration.catalogue.list({includeUnavailable:true})).assets[0].code,'migration_unverified');
  const thrown=fixture({price:async()=>{throw Error('https://private.example/?secret=secret');}});await thrown.catalogue.fullSweep();assert.doesNotMatch(JSON.stringify(await thrown.catalogue.list({includeUnavailable:true})),/private|secret/);
});
test('expiry and a changed exact-mint catalogue invalidate public launch readiness',async()=>{
  const f=fixture();await f.catalogue.fullSweep();f.setNow(1000000+21600001);assert.equal((await f.catalogue.list()).ready,false);assert.equal((await f.catalogue.list()).assets.length,0);
  const changed=fixture();await changed.catalogue.fullSweep();changed.catalogue.extraAssets=[{name:'Other',symbol:'OTHER',mint:authority.toBase58()}];assert.equal((await changed.catalogue.list()).ready,false);assert.equal((await changed.catalogue.list()).assets.length,1,'new unverified candidates do not remove individually valid pairs');
});

test('a quote with price and migration proof still fails closed when the exact curve cannot fit',async()=>{
  const f=fixture({curveCheck:()=>{throw Error('Not enough liquidity');}});await f.catalogue.fullSweep();const row=(await f.catalogue.list({includeUnavailable:true})).assets[0];assert.equal(row.launchReady,false);assert.equal(row.code,'curve_configuration_unavailable');
});
test('batch missing-market proof avoids per-mint Jupiter requests during full sweep',async()=>{
  const f=fixture({priceBatch:async assets=>new Map(assets.map(a=>[a.mint,null]))});await f.catalogue.fullSweep();assert.equal(f.priceCalls(),0);assert.equal((await f.catalogue.list({includeUnavailable:true})).assets[0].code,'price_unavailable');
  const scaled=fixture({priceBatch:async assets=>new Map(assets.map(a=>[a.mint,{requiresRawPrice:true}]))});await scaled.catalogue.fullSweep();assert.equal(scaled.priceCalls(),1);assert.equal((await scaled.catalogue.list()).assets.length,1);
});
test('a background recheck preserves the last complete set of individually valid pairs',async()=>{
  const f=fixture();await f.catalogue.fullSweep();let release,started;const began=new Promise(r=>{started=r;});
  f.catalogue.priceBatch=async()=>{started();return new Promise(r=>{release=r;});};
  const pending=f.catalogue.fullSweep({force:true});await began;
  const during=await f.catalogue.list();assert.equal(during.assets.length,1);assert.equal(during.running,true);assert.equal(during.counts.available,1);
  release(new Map([[mint.toBase58(),null]]));await pending;assert.equal((await f.catalogue.list()).assets.length,0);
});

const turn=()=>new Promise(resolve=>setImmediate(resolve));
function queuedFixture(t,options={}){
  const assets=Array.from({length:12},(_,i)=>({mint:Keypair.generate().publicKey.toBase58(),name:'Queue '+i,symbol:'Q'+i}));
  const started=[],reads=[],held=[];let automatic=false;
  const price=async asset=>{
    started.push(asset.mint);
    if(!automatic)await new Promise(resolve=>held.push({mint:asset.mint,resolve}));
    return {usd:'1',at:Date.now(),source:'fresh quote'};
  };
  const catalogue=new MeteoraQuoteCatalogue({catalogue:{read:async()=>({assets})},extraAssets:[],connection:{getAccountInfo:async key=>{reads.push(key.toBase58());return token();},getEpochInfo:async()=>({epoch:10}),getMultipleAccountsInfo:async keys=>keys.map(()=>token())},price,migrationCheck:async()=>({supported:true,config:authority.toBase58()}),curveCheck:()=>({}),...options});
  const release=address=>{const i=held.findIndex(item=>item.mint===address);assert.notEqual(i,-1,'expected a running check');held.splice(i,1)[0].resolve();};
  const releaseAll=()=>{automatic=true;for(const item of held.splice(0))item.resolve();};
  const check=(index,extra={})=>catalogue.status(assets[index].mint,{asset:assets[index],fresh:true,...extra});
  t.after(async()=>{releaseAll();await catalogue.close();});
  return {catalogue,assets,started,reads,release,releaseAll,check};
}

test('four running sweep checks let foreground launches wait and take the next slot',async t=>{
  const f=queuedFixture(t),sweep=f.catalogue.fullSweep();await turn();
  assert.equal(f.started.length,4);assert.equal(f.catalogue.activeChecks,4);
  const launch=f.check(4),duplicate=f.check(4);await turn();
  assert.equal(f.started.length,4,'waiting does not exceed the four-check bound');
  assert.equal(f.catalogue.waiting.length,1,'same-mint foreground callers coalesce');
  f.release(f.assets[0].mint);await turn();
  assert.equal(f.started[4],f.assets[4].mint,'foreground gets the freed sweep slot');
  assert.equal(f.reads.filter(mint=>mint===f.assets[4].mint).length,1,'foreground performs fresh chain reads');
  f.release(f.assets[4].mint);assert.equal((await launch).launchReady,true);assert.equal((await duplicate).launchReady,true);
  f.releaseAll();await sweep;await turn();assert.equal(f.catalogue.activeChecks,0);assert.equal(f.catalogue.pending.size,0);
});

test('waiting capacity stays bounded while duplicate requests still coalesce',async t=>{
  const f=queuedFixture(t,{maxConcurrent:1,maxWaiting:1}),active=f.check(0);await turn();
  const first=f.check(1),duplicate=f.check(1),busy=await f.check(2);
  assert.equal(busy.code,'verification_busy');assert.equal(busy.retryable,true);assert.equal(busy.supported,null);
  assert.equal(f.catalogue.waiting.length,1);assert.equal(f.catalogue.current(f.assets[2].mint).code,'verification_pending','capacity errors never become cached incompatibility');
  f.releaseAll();assert.equal((await first).launchReady,true);assert.equal((await duplicate).launchReady,true);await active;
  assert.equal(f.started.filter(mint=>mint===f.assets[1].mint).length,1);
});

test('waiting timeout removes the job without caching a failure or blocking a fresh retry',async t=>{
  const f=queuedFixture(t,{maxConcurrent:1,waitMs:20}),active=f.check(0);await turn();
  const waiting=f.check(1);await new Promise(resolve=>setTimeout(resolve,35));
  const result=await waiting;assert.equal(result.code,'verification_busy');assert.equal(result.retryable,true);
  assert.equal(f.catalogue.waiting.length,0);assert.equal(f.catalogue.pending.size,1);
  assert.equal(f.catalogue.current(f.assets[1].mint).code,'verification_pending');
  const retry=f.check(1);f.releaseAll();assert.equal((await retry).launchReady,true);await active;await turn();
  assert.equal(f.catalogue.pending.size,0);assert.equal(f.catalogue.activeChecks,0);
});

test('cancellation detaches one waiter and removes a queued job only after its last waiter leaves',async t=>{
  const f=queuedFixture(t,{maxConcurrent:1,maxWaiting:2}),active=f.check(0);await turn();
  const controller=new AbortController(),cancelled=f.check(1,{signal:controller.signal}),shared=f.check(1);
  controller.abort();assert.equal((await cancelled).code,'verification_cancelled');assert.equal(f.catalogue.waiting.length,1);
  const alone=new AbortController(),lone=f.check(2,{signal:alone.signal});alone.abort();
  assert.equal((await lone).retryable,true);assert.equal(f.catalogue.waiting.length,1,'unobserved queued work releases its slot');
  f.releaseAll();assert.equal((await shared).launchReady,true);await active;
  assert.equal(f.started.includes(f.assets[2].mint),false);
});

test('foreground priority gives an oldest background check a turn after four foreground starts',async t=>{
  const f=queuedFixture(t,{maxConcurrent:1}),active=f.check(0);await turn();
  const background=f.check(1,{background:true}),foreground=[2,3,4,5,6].map(index=>f.check(index));
  f.release(f.assets[0].mint);await turn();
  for(const index of [2,3,4,5]){assert.equal(f.started.at(-1),f.assets[index].mint);f.release(f.assets[index].mint);await turn();}
  assert.equal(f.started.at(-1),f.assets[1].mint,'continuous foreground traffic cannot starve background work');
  f.releaseAll();await Promise.all([active,background,...foreground]);
});

test('foreground promotion discards queued sweep evidence and runs fresh validation',async t=>{
  const f=queuedFixture(t,{maxConcurrent:1}),active=f.check(0);await turn();
  const background=f.check(1,{background:true,mintEvidence:{account:null,epoch:10,batchPrice:{usd:'99',at:Date.now()-600000}}});
  const foreground=f.check(1);assert.equal(f.catalogue.waiting.length,1);assert.equal(f.catalogue.waiting[0].background,false);
  f.releaseAll();const result=await foreground;await Promise.all([active,background]);
  assert.equal(result.launchReady,true);assert.equal(result.price.usd,'1');assert.equal(f.reads.filter(mint=>mint===f.assets[1].mint).length,1);
});

test('a foreground request does not reuse an active sweep proof with earlier bulk evidence',async t=>{
  const f=queuedFixture(t,{maxConcurrent:1});
  const background=f.check(1,{background:true,mintEvidence:{account:token(),epoch:10,batchPrice:{requiresRawPrice:true}}});await turn();
  const foreground=f.check(1),duplicate=f.check(1);assert.equal(f.catalogue.waiting.length,1);
  f.release(f.assets[1].mint);await background;await turn();
  assert.equal(f.reads.filter(mint=>mint===f.assets[1].mint).length,1,'live follow-up reads the mint again');
  assert.equal(f.started.filter(mint=>mint===f.assets[1].mint).length,2);
  f.releaseAll();assert.equal((await foreground).launchReady,true);assert.equal((await duplicate).launchReady,true);
});

test('close settles queued work immediately and allows active checks to finish',async t=>{
  const f=queuedFixture(t,{maxConcurrent:1}),active=f.check(0);await turn();const queued=f.check(1),closing=f.catalogue.close();
  assert.equal((await queued).code,'verification_cancelled');assert.equal(f.catalogue.waiting.length,0);
  f.releaseAll();await Promise.all([active,closing]);await turn();assert.equal(f.catalogue.pending.size,0);
});

test('older sweep failure cannot overwrite a completed fresh live proof',async t=>{
  let calls=0,releaseOld;const started=new Promise(resolve=>{releaseOld={started:resolve};});
  const f=queuedFixture(t,{maxConcurrent:2,price:async()=>{
    if(++calls===1){releaseOld.started();await new Promise(resolve=>{releaseOld.finish=resolve;});return null;}
    return {usd:'1',at:Date.now(),source:'fresh live proof'};
  }});
  const background=f.check(1,{background:true,mintEvidence:{account:token(),epoch:10,batchPrice:{requiresRawPrice:true}}});await started;
  const fresh=await f.check(1);assert.equal(fresh.launchReady,true);
  releaseOld.finish();assert.equal((await background).code,'price_unavailable');
  const cached=f.catalogue.current(f.assets[1].mint);assert.equal(cached.launchReady,true);assert.equal(cached.price.source,'fresh live proof');assert.equal(cached.checkedAt,fresh.checkedAt);
});
