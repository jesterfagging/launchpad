import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { TelegramStore } from '../src/telegram-store.mjs';
import { AdminFailedLaunchArchive, failedLaunchArchiveEligibility, nativeFailedLaunchArchiveEligibility } from '../src/admin-failed-launch-archive.mjs';
import { launchpadApi } from '../src/product-mode.mjs';

const ACTOR='a'.repeat(32), OWNER='b'.repeat(32), OTHER='c'.repeat(32), REQUEST='1'.repeat(32), STORE='admin-failed-launch-archive';
const coin=(n=1,extra={})=>({id:String(n).padStart(32,'0'),createdAt:1,state:'failed',phase:'failed',input:{route:'raydium',network:'mainnet-beta',name:`Coin ${n}`},keys:{mint:{address:'mint'},wallet:{secret:'DO_NOT_EXPOSE'}},operations:[],credits:{base:'0',quote:'0'},gas:{reserved:'0'},...extra});
async function fixture(t, input=[coin()]) {
  const dir=await mkdtemp(join(tmpdir(),'launchpad-failed-archive-')),hostStore=new TelegramStore(dir,randomBytes(32));
  const books=new Map([[OWNER,{launches:structuredClone(input)}],[OTHER,{launches:[]}]]), extras=[];
  let allowed=true,writes=0,scans=0,beforeLock=()=>{},afterSave=()=>{};
  const accounts={dir,hostStore,get:async id=>id===ACTOR?{id,role:allowed?'admin':'user',mfaEnabled:true}:books.has(id)?{id}:null};
  const launchpad={locked:async(id,fn)=>{await beforeLock(id);return fn(structuredClone(books.get(id)||{launches:[]}));},save:async(id,book)=>{writes++;books.set(id,structuredClone(book));await afterSave(id);}};
  const launchAdmin={requireAdmin:async()=>{if(!allowed)throw Object.assign(Error('Forbidden'),{statusCode:403});},inventory:async()=>{scans++;return {launches:[...books].flatMap(([id,book])=>book.launches.map(launch=>({account:{id},launch:structuredClone(launch)}))).concat(extras)};}};
  const create=options=>new AdminFailedLaunchArchive({accounts,launchpad,launchAdmin,now:()=>1234,...options});
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return{books,extras,accounts,launchpad,launchAdmin,create,service:create(),get writes(){return writes;},get scans(){return scans;},set allowed(value){allowed=value;},set beforeLock(fn){beforeLock=fn;},set afterSave(fn){afterSave=fn;}};
}
const withoutArchive=l=>{const out=structuredClone(l);delete out.listArchive;delete out.listArchiveHistory;return out;};
const NATIVE_MINT='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS';
const nativeCoin=(n=1,extra={})=>({id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,mint:NATIVE_MINT,creatorId:OWNER,status:'error',ledger:{quote:'0',base:'0'},...extra});
function addNative(h,route,launches,operations=[]){
  let current={launches:structuredClone(launches),operations:structuredClone(operations)},writes=0,locks=0,beforeLock=()=>{},afterSave=()=>{};
  const service={locked:async fn=>{locks++;await beforeLock();return fn();},load:async()=>structuredClone(current),save:async data=>{writes++;current=structuredClone(data);await afterSave();}};
  h.launchAdmin[route==='meteora'?'meteora':route==='damm-pump'?'dammPump':'pumpPublic']=service;
  h.extras.push(...launches.map(row=>({account:{id:row.creatorId},launch:{id:row.id,state:row.status,input:{route},keys:{mint:{address:row.mint}}}})));
  return{get data(){return current;},get writes(){return writes;},get locks(){return locks;},set beforeLock(fn){beforeLock=fn;},set afterSave(fn){afterSave=fn;}};
}

test('strict failed eligibility excludes live, active, recovery, signatures and balances',()=>{
  assert.equal(failedLaunchArchiveEligibility(coin()).eligible,true);
  assert.equal(failedLaunchArchiveEligibility(coin(1,{state:'error'})).eligible,true);
  for(const state of ['draft','live','paused','launching','pending','awaiting_signature','stopping','unknown'])assert.equal(failedLaunchArchiveEligibility(coin(1,{state})).eligible,false,state);
  for(const state of ['pending','awaiting_signature','submitted','unknown'])assert.equal(failedLaunchArchiveEligibility(coin(1,{operations:[{kind:'setup',state}]})).code,'pending');
  for(const kind of ['create','launch-all','initialize'])assert.equal(failedLaunchArchiveEligibility(coin(1,{operations:[{kind,state:'confirmed'}]})).code,'created');
  for(const field of ['curve','poolId','dbcPoolId','mintLive','finalizedAt','confirmedAt'])assert.equal(failedLaunchArchiveEligibility(coin(1,{[field]:true})).code,'created');
  for(const status of ['checking','blocked','refunding','not-needed','unknown'])assert.equal(failedLaunchArchiveEligibility(coin(1,{recovery:{status}})).code,'recovery');
  assert.equal(failedLaunchArchiveEligibility(coin(1,{authorizedAt:1})).code,'recovery');
  assert.equal(failedLaunchArchiveEligibility(coin(1,{operations:[{kind:'setup',state:'confirmed'}]})).code,'recovery');
  for(const extra of [{credits:{base:'1',quote:'0'}},{credits:{base:'0',quote:'1'}},{gas:{reserved:'1'}},{cycle:{}},{feesRequested:true},{autoFees:true},{nativeRewardDebts:{payouts:[{amount:'1'}]}},{heldSolDistribution:{state:'queued'}},{heldSolDistribution:{state:'processing'}},{protocolCredit:'1'},{protocolBaseCredit:'1'},{reservedLamports:'1'},{recoveryFunds:'1'}])assert.equal(failedLaunchArchiveEligibility(coin(1,extra)).code,'funds',JSON.stringify(extra));
  for(const reserved of ['1','-1','NaN',{},[]])assert.equal(failedLaunchArchiveEligibility(coin(1,{gas:{reserved}})).eligible,false);
  for(const extra of [{operations:null},{credits:null},{gas:null},{nativeRewardDebts:{payouts:{}}}])assert.equal(failedLaunchArchiveEligibility(coin(1,extra)).code,'invalid');
});

test('completed recovery still excludes nonzero returned-fund remainder',()=>{
  assert.equal(failedLaunchArchiveEligibility(coin(1,{authorizedAt:1,recovery:{status:'complete',refundedLamports:'9000',unreturnedLamports:'0'}})).eligible,true);
  for(const field of ['unreturnedLamports','reservedLamports','remainingLamports','balanceLamports'])assert.equal(failedLaunchArchiveEligibility(coin(1,{recovery:{status:'complete',[field]:'1'}})).code,'funds');
});

test('preview covers every owner and page, and explicitly counts unsupported providers',async t=>{
  const h=await fixture(t,Array.from({length:30},(_,i)=>coin(i+1)));
  h.books.set(OTHER,{launches:[coin(31),coin(32,{state:'live'}),coin(33,{recovery:{status:'checking'}})]});
  h.extras.push(...['meteora','pumpswap'].map(route=>({account:{id:OWNER},launch:coin(90,{id:nativeCoin().id,input:{route},state:'error',keys:{mint:{address:NATIVE_MINT}}})})));
  const preview=await h.service.preview(ACTOR);
  assert.equal(preview.scannedCount,35);assert.equal(preview.failedCount,34);assert.equal(preview.eligibleCount,31);assert.equal(preview.excludedCount,3);
  assert.deepEqual(preview.excludedReasons.map(x=>[x.code,x.count]),[['recovery',1],['unsupported',2]]);assert.equal(h.writes,0);
  assert(!JSON.stringify(preview).includes('DO_NOT_EXPOSE'));
});

test('archives only eligible failures, keeps every financial field, and persists per-coin audit',async t=>{
  const original=coin(),h=await fixture(t,[original,coin(2,{state:'draft'}),coin(3,{curve:'live'})]);
  const result=await h.service.archive(ACTOR,{requestId:REQUEST,ids:['injected'],accountId:OTHER});
  assert.equal(result.status,'completed');assert.equal(result.archivedCount,1);assert.equal(result.excludedCount,1);assert.equal(h.writes,1);
  const saved=h.books.get(OWNER).launches[0];assert.deepEqual(withoutArchive(saved),original);
  assert.deepEqual(saved.listArchive,{archived:true,actorId:ACTOR,at:1234,bulkRequestId:REQUEST});assert.deepEqual(saved.listArchiveHistory,[saved.listArchive]);
  assert(!JSON.stringify(result).includes('DO_NOT_EXPOSE'));assert.equal(h.books.get(OWNER).launches[1].listArchive,undefined);
});

test('restart and same ID replay retain the original snapshot and do not archive newly failed requests',async t=>{
  const h=await fixture(t);await h.service.archive(ACTOR,{requestId:REQUEST});
  h.books.get(OWNER).launches.push(coin(2));h.books.get(OWNER).launches[0].listArchive={archived:false,actorId:ACTOR,at:2000};
  const replay=await h.create().archive(ACTOR,{requestId:REQUEST});
  assert.equal(replay.alreadyRequested,true);assert.equal(replay.archivedCount,1);assert.equal(h.writes,1);assert.equal(h.scans,1);
  assert.equal(h.books.get(OWNER).launches[0].listArchive.archived,false);assert.equal(h.books.get(OWNER).launches[1].listArchive,undefined);
});

test('concurrent IDs recheck current archive state under owner lock',async t=>{
  const h=await fixture(t),out=await Promise.all([h.service.archive(ACTOR,{requestId:REQUEST}),h.create().archive(ACTOR,{requestId:'2'.repeat(32)})]);
  assert.equal(out.reduce((n,x)=>n+x.archivedCount,0),1);assert.equal(h.writes,1);assert.equal(h.books.get(OWNER).launches[0].listArchiveHistory.length,1);
});

test('state changes after discovery skip the launch under its owner lock',async t=>{
  const h=await fixture(t);h.beforeLock=()=>{h.books.get(OWNER).launches[0].operations.push({kind:'setup',state:'pending'});};
  const out=await h.service.archive(ACTOR,{requestId:REQUEST});assert.equal(out.archivedCount,0);assert.equal(out.skippedCount,1);assert.equal(out.excludedReasons[0].code,'pending');assert.equal(h.writes,0);
});

test('crash after owner save reconciles per-coin audit without duplicate metadata writes',async t=>{
  const h=await fixture(t);h.afterSave=()=>{throw Error('private filesystem path');};
  const first=await h.service.archive(ACTOR,{requestId:REQUEST});assert.equal(first.status,'partial');assert.equal(first.archivedCount,0);assert.equal(first.remainingCount,1);assert.doesNotMatch(JSON.stringify(first),/private filesystem/);
  h.afterSave=()=>{};h.books.get(OWNER).launches.push(coin(2));
  const next=await h.create().archive(ACTOR,{requestId:REQUEST});assert.equal(next.status,'completed');assert.equal(next.archivedCount,1);assert.equal(h.writes,1);assert.equal(h.books.get(OWNER).launches[1].listArchive,undefined);
});

test('revoked role between owners stops immediately and exact snapshot resumes after reauthorization',async t=>{
  const h=await fixture(t);h.books.set(OTHER,{launches:[coin(2)]});h.afterSave=()=>{h.allowed=false;};
  await assert.rejects(h.service.archive(ACTOR,{requestId:REQUEST}),{statusCode:403});assert.equal(h.writes,1);assert.equal(h.books.get(OTHER).launches[0].listArchive,undefined);
  h.allowed=true;h.afterSave=()=>{};h.books.get(OTHER).launches.push(coin(3));
  const out=await h.create().archive(ACTOR,{requestId:REQUEST});assert.equal(out.archivedCount,2);assert.equal(h.writes,2);assert.equal(h.books.get(OTHER).launches[1].listArchive,undefined);
});

test('session authorization is rechecked immediately before each archive save',async t=>{
  const h=await fixture(t);let inside=false;h.beforeLock=()=>{inside=true;};
  await assert.rejects(h.service.archive(ACTOR,{requestId:REQUEST},{authorize:async()=>{if(inside)throw Object.assign(Error('Session revoked'),{statusCode:401});}}),{statusCode:401});assert.equal(h.writes,0);
});

test('unknown request state, missing durable snapshot and request capacity fail closed',async t=>{
  const h=await fixture(t);
  await assert.rejects(h.service.archive(ACTOR,{requestId:'bad'}),{statusCode:400});
  await assert.rejects(h.create({maxTargets:0}).archive(ACTOR,{requestId:REQUEST}),/not truncated/);
  await h.accounts.hostStore.write(STORE,{version:1,requests:{[REQUEST]:ACTOR}});
  await assert.rejects(h.service.archive(ACTOR,{requestId:REQUEST}),/snapshot is unavailable/);
  await assert.rejects(h.create({maxRequests:1}).archive(ACTOR,{requestId:'2'.repeat(32)}),/journal is full/);assert.equal(h.writes,0);
});

test('the production API allowlist admits only the exact archive route',()=>{
  assert.equal(launchpadApi('/api/admin/failed-launch-archive'),true);
  for(const suffix of ['/','/private','-all'])assert.equal(launchpadApi('/api/admin/failed-launch-archive'+suffix),false);
});

test('native failed requests require settled receipts and no live mint, fee debt, config funding or reserved ledger',()=>{
  for(const route of ['meteora','pumpswap']){
    const launch=nativeCoin();assert.equal(nativeFailedLaunchArchiveEligibility(launch,[],route).eligible,true);
    const op={mint:launch.mint,action:'initialize',state:'failed',signature:'receipt',signedTransaction:'saved bytes',result:{state:'failed'}};
    assert.equal(nativeFailedLaunchArchiveEligibility(launch,[op],route).eligible,true);
    for(const state of ['prepared','pending','submitted','confirmed','cancelled','unknown'])assert.equal(nativeFailedLaunchArchiveEligibility(launch,[{...op,state}],route).eligible,false,state);
    assert.equal(nativeFailedLaunchArchiveEligibility(launch,[{...op,result:{state:'pending'}}],route).code,'pending');
    for(const field of ['poolId','dbcPoolId','mintLive','finalizedAt','confirmedAt','migrationSignature','burnReceipt'])assert.equal(nativeFailedLaunchArchiveEligibility({...launch,[field]:true},[],route).code,'created',field);
    for(const extra of [{ledger:{quote:'1'}},{ledger:{base:'NaN'}},{configSignature:'receipt'},{creatorFeesPending:'1'},{creatorFeesPaid:'1'},{rewards:{debts:[{amount:'1'}]}},{rewards:{cycle:{}}},{heldSolDistribution:{state:'processing'}},{reservedLamports:'1'}])assert.equal(nativeFailedLaunchArchiveEligibility({...launch,...extra},[],route).code,'funds',JSON.stringify(extra));
    assert.equal(nativeFailedLaunchArchiveEligibility({...launch,rewards:{debts:{}}},[],route).code,'invalid');
    assert.equal(nativeFailedLaunchArchiveEligibility({...launch,recovery:{status:'checking'}},[],route).code,'recovery');
    assert.equal(nativeFailedLaunchArchiveEligibility({...launch,status:'draft'},[],route).code,'not_failed');
    assert.equal(nativeFailedLaunchArchiveEligibility(launch,[{...op,state:'finalized',result:{state:'finalized'}}],route).code,'created');
  }
});

test('bulk archive covers Raydium, Meteora and PumpSwap through each authoritative store without modifying financial data',async t=>{
  const h=await fixture(t),a=nativeCoin(1),b=nativeCoin(2),meteora=addNative(h,'meteora',[a]),pump=addNative(h,'pumpswap',[b]);
  assert.equal((await h.service.preview(ACTOR)).eligibleCount,3);
  const out=await h.service.archive(ACTOR,{requestId:REQUEST});assert.equal(out.archivedCount,3);assert.equal(out.status,'completed');assert.equal(h.writes,1);assert.equal(meteora.writes,1);assert.equal(pump.writes,1);
  assert.deepEqual(withoutArchive(meteora.data.launches[0]),a);assert.deepEqual(withoutArchive(pump.data.launches[0]),b);
  for(const native of [meteora,pump])assert.equal(native.data.launches[0].listArchiveHistory[0].bulkRequestId,REQUEST);
});

test('native authoritative state overrides an eligible inventory projection and mutation rechecks under its provider lock',async t=>{
  const h=await fixture(t,[]),native=addNative(h,'meteora',[nativeCoin()]);
  native.data.launches[0].ledger.quote='100';assert.equal((await h.service.preview(ACTOR)).eligibleCount,0);
  native.data.launches[0].ledger.quote='0';let locks=0;native.beforeLock=()=>{if(++locks===2)native.data.operations.push({mint:NATIVE_MINT,action:'initialize',state:'pending'});};
  const out=await h.service.archive(ACTOR,{requestId:REQUEST});assert.equal(out.archivedCount,0);assert.equal(out.skippedCount,1);assert.equal(out.excludedReasons[0].code,'pending');assert.equal(native.writes,0);
});

test('native save crash retries its original snapshot and per-launch audit without archiving new failures',async t=>{
  const h=await fixture(t,[]),native=addNative(h,'pumpswap',[nativeCoin()]);native.afterSave=()=>{throw Error('private native storage');};
  const out=await h.service.archive(ACTOR,{requestId:REQUEST});assert.equal(out.status,'partial');assert.equal(native.writes,1);
  native.afterSave=()=>{};native.data.launches.push(nativeCoin(2));
  const replay=await h.create().archive(ACTOR,{requestId:REQUEST});assert.equal(replay.archivedCount,1);assert.equal(replay.status,'completed');assert.equal(native.writes,1);assert.equal(native.data.launches[1].listArchive,undefined);
});

test('Damm failed draft cleanup distinguishes prepared addresses and estimates from funded setup',()=>{
  const launch=nativeCoin(1,{status:'draft',stateAddress:'planned-state',dammPoolId:'planned-pool',lookupTables:[{address:'planned-table'}],lookupSetupDebitLamports:'2000000',lookupSetupRentLamports:'1500000',firstBuySolLamports:'10000000'});
  const op={mint:launch.mint,action:'configure',state:'failed',signature:'failed-receipt',signedTransaction:'saved bytes',walletSignedTransaction:'wallet bytes',result:{state:'failed'}};
  assert.equal(nativeFailedLaunchArchiveEligibility(launch,[],'damm-pump').code,'not_failed');
  assert.equal(nativeFailedLaunchArchiveEligibility(launch,[{...op,state:'awaiting_signature'}],'damm-pump').code,'not_failed');
  assert.equal(nativeFailedLaunchArchiveEligibility(launch,[op],'damm-pump').eligible,true);
  for(const status of ['failed','error'])assert.equal(nativeFailedLaunchArchiveEligibility({...launch,status},[op],'damm-pump').eligible,true);
  for(const status of ['trading','bonded','migrated','cancelled'])assert.equal(nativeFailedLaunchArchiveEligibility({...launch,status},[op],'damm-pump').eligible,false);
  for(const field of ['setupSignature','fundingSignature','fundingReceipt','nativeBuySetupSignature'])assert.equal(nativeFailedLaunchArchiveEligibility({...launch,[field]:'evidence'},[op],'damm-pump').code,'funds',field);
  for(const field of ['setupStatus','fundingStatus','nativeBuySetupStatus'])for(const value of ['finalized','confirmed','pending','unknown'])assert.equal(nativeFailedLaunchArchiveEligibility({...launch,[field]:value},[op],'damm-pump').code,'funds',field+value);
  for(const field of ['quoteFundingDebitLamports','nativeBuySetupDebitLamports'])for(const value of ['1','invalid'])assert.equal(nativeFailedLaunchArchiveEligibility({...launch,[field]:value},[op],'damm-pump').code,'funds',field+value);
  for(const patch of [{state:'confirmed',result:{state:'confirmed'}},{state:'pending'},{state:'cancelled',result:{state:'cancelled'}},{state:'expired',result:{state:'pending'}},{state:'expired',result:{state:'expired'},observedSignatureStatus:{confirmationStatus:'processed',slot:1}}])assert.equal(nativeFailedLaunchArchiveEligibility({...launch,status:'error'},[{...op,...patch}],'damm-pump').code,'pending',JSON.stringify(patch));
  const onlyWallet={mint:launch.mint,action:'configure',state:'cancelled',walletSignedTransaction:'wallet bytes',result:{state:'cancelled'}};
  assert.equal(nativeFailedLaunchArchiveEligibility(launch,[onlyWallet],'damm-pump').code,'pending');
  assert.equal(nativeFailedLaunchArchiveEligibility({...launch,confirmationStatus:'confirmed'},[op],'damm-pump').code,'created');
  assert.equal(nativeFailedLaunchArchiveEligibility(launch,[op,{mint:launch.mint,action:'configure',state:'finalized',result:{state:'finalized'}}],'damm-pump').code,'funds');
});

test('bulk Damm archive includes failed setup drafts and replays without archiving new or active requests',async t=>{
  const h=await fixture(t,[]),failed=nativeCoin(1,{status:'draft'}),fresh=nativeCoin(2,{mint:'So11111111111111111111111111111111111111112',status:'draft'});
  const operation={mint:failed.mint,action:'configure',state:'failed',signature:'failed-receipt',signedTransaction:'saved bytes',result:{state:'failed'}};
  const native=addNative(h,'damm-pump',[failed,fresh],[operation]);
  const preview=await h.service.preview(ACTOR);assert.equal(preview.scannedCount,2);assert.equal(preview.failedCount,1);assert.equal(preview.eligibleCount,1);assert.equal(preview.excludedCount,0);
  const result=await h.service.archive(ACTOR,{requestId:REQUEST});assert.equal(result.archivedCount,1);assert.equal(native.writes,1);assert.equal(native.data.launches[1].listArchive,undefined);
  assert.deepEqual(withoutArchive(native.data.launches[0]),failed);assert.deepEqual(native.data.operations,[operation]);
  native.data.launches[0].listArchive={archived:false,actorId:ACTOR,at:2345};native.data.launches.push(nativeCoin(3));
  const replay=await h.create().archive(ACTOR,{requestId:REQUEST});assert.equal(replay.alreadyRequested,true);assert.equal(replay.archivedCount,1);assert.equal(native.writes,1);assert.equal(native.data.launches[0].listArchive.archived,false);assert.equal(native.data.launches[2].listArchive,undefined);
});

test('Damm archive rechecks funding under provider lock and preserves newly finalized setup',async t=>{
  const h=await fixture(t,[]),launch=nativeCoin(),native=addNative(h,'damm-pump',[launch]);let locks=0;
  native.beforeLock=()=>{if(++locks===2){native.data.launches[0].setupStatus='finalized';native.data.launches[0].setupSignature='finalized-setup';}};
  const result=await h.service.archive(ACTOR,{requestId:REQUEST});assert.equal(result.archivedCount,0);assert.equal(result.skippedCount,1);assert.equal(result.excludedReasons[0].code,'funds');assert.equal(native.writes,0);assert.equal(native.data.launches[0].listArchive,undefined);
});

test('Damm partial-save recovery keeps the original cleanup scope and completed audit',async t=>{
  const h=await fixture(t,[]),native=addNative(h,'damm-pump',[nativeCoin()]);native.afterSave=()=>{throw Error('Unavailable storage');};
  const result=await h.service.archive(ACTOR,{requestId:REQUEST});assert.equal(result.status,'partial');assert.equal(native.writes,1);
  native.afterSave=()=>{};native.data.launches.push(nativeCoin(2));
  const replay=await h.create().archive(ACTOR,{requestId:REQUEST});assert.equal(replay.archivedCount,1);assert.equal(replay.status,'completed');assert.equal(native.writes,1);assert.equal(native.data.launches[1].listArchive,undefined);
});
