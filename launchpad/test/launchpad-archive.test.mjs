import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Launchpad, publicLaunch } from '../src/launchpad.mjs';
import { launchArchiveView, stoppedBeforeToken } from '../src/launchpad-archive.mjs';
import { TelegramStore } from '../src/telegram-store.mjs';
import { newLaunchKeys } from '../src/launchpad-receipts.mjs';

const ownerId='a'.repeat(32),otherId='b'.repeat(32),launchId='1'.repeat(32);
const fixture=(extra={})=>({
  id:launchId,createdAt:1,state:'failed',phase:'failed',error:'Wallet approval was declined.',
  input:{route:'raydium',network:'mainnet-beta',name:'Failed coin',symbol:'FAIL',feeMode:'creator',quoteMint:'So11111111111111111111111111111111111111112'},
  review:{minimumSol:'0.02',quoteDecimals:9},keys:newLaunchKeys(),operations:[],
  autoFees:false,feesRequested:false,credits:{quote:'0',base:'0'},gas:{reserved:'1'},...extra,
});
async function harness(t,launch=fixture()){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-archive-')),books=new Map([[ownerId,{launches:[launch]}],[otherId,{launches:[]}]]),users=new Map([[ownerId,{mainWallet:launch.keys.wallet.address}],[otherId,{mainWallet:'other'}]]);
  let writes=0,kicks=0,chainCalls=0;
  const accounts={get:async id=>structuredClone(users.get(id)),storeFor:id=>({dir:join(dir,id),read:async()=>structuredClone(books.get(id)||{launches:[]}),write:async(_key,value)=>{writes++;books.set(id,structuredClone(value));}})};
  const manager=new Launchpad(accounts,null,{now:()=>12345,chainFactory:async()=>{chainCalls++;throw Error('Recovery RPC unavailable.');}});
  manager.kick=()=>{kicks++;};
  t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
  return{manager,books,users,accounts,get writes(){return writes;},get kicks(){return kicks;},get chainCalls(){return chainCalls;}};
}
const withoutArchive=launch=>{const copy=structuredClone(launch);delete copy.listArchive;delete copy.listArchiveHistory;return copy;};

test('archive eligibility excludes active, created, hidden and legacy launches while allowing stopped requests',()=>{
  for(const state of ['draft','error','failed','stopping'])assert.equal(launchArchiveView(fixture({state})).canArchive,true,state);
  for(const state of ['launching','pending','awaiting_signature','live','paused','unknown'])assert.equal(launchArchiveView(fixture({state})).canArchive,false,state);
  for(const state of ['pending','awaiting_signature'])assert.equal(launchArchiveView(fixture({operations:[{kind:'create',state}]})).canArchive,false);
  for(const kind of ['create','launch-all'])assert.equal(launchArchiveView(fixture({operations:[{kind,state:'confirmed'}],recovery:{status:'checking'}})).canArchive,false);
  assert.equal(launchArchiveView(fixture({curve:'onchain-curve'})).canArchive,false);
  assert.equal(launchArchiveView(fixture({moderation:{hidden:true}})).listArchived,true);
  const legacy=fixture();legacy.input.network='devnet';assert.equal(launchArchiveView(legacy).listArchived,true);assert.equal(launchArchiveView(legacy).canArchive,false);
  assert.equal(launchArchiveView(fixture({state:'pending',recovery:{status:'checking'},operations:[{kind:'setup-refund',state:'pending'}]})).canArchive,true);
  assert.equal(launchArchiveView(fixture({state:'pending',recovery:{status:'not-needed'}})).canArchive,false);
});

test('owner archive is metadata-only and repeated requests do not append duplicate audit events',async t=>{
  const launch=fixture({authorizedAt:2,recovery:{status:'checking',startedAt:4,nextAt:5,refundedLamports:'0'},operations:[{kind:'setup-refund',state:'pending',signature:'saved-receipt',raw:'saved-signed-bytes'}]}),h=await harness(t,launch);
  const result=await h.manager.archive(ownerId,launchId,{archived:true});
  const saved=h.books.get(ownerId).launches[0];
  assert.deepEqual(withoutArchive(saved),launch);assert.equal(h.kicks,0);assert.equal(h.chainCalls,0);
  assert.deepEqual(saved.listArchive,{archived:true,actorId:ownerId,at:12345});assert.deepEqual(saved.listArchiveHistory,[saved.listArchive]);
  assert.equal(result.listArchived,true);assert.equal(result.archived,false);assert.equal(result.canRestore,true);assert.equal(result.archiveAt,12345);
  assert(!JSON.stringify(result).includes(launch.keys.wallet.secret));assert(!JSON.stringify(result).includes('saved-signed-bytes'));assert(!Object.hasOwn(result,'listArchiveHistory'));
  await h.manager.archive(ownerId,launchId,{archived:true});assert.equal(h.writes,1);
  await h.manager.archive(ownerId,launchId,{archived:false});await h.manager.archive(ownerId,launchId,{archived:false});
  const restored=h.books.get(ownerId).launches[0];assert.equal(h.writes,2);assert.equal(restored.listArchiveHistory.length,2);assert.equal(restored.listArchive.archived,false);assert.deepEqual(withoutArchive(restored),launch);
});

test('archived requests remain in direct owner reads and still schedule recovery',async t=>{
  const launch=fixture({authorizedAt:2,recovery:{status:'checking',nextAt:1}}),h=await harness(t,launch);
  await h.manager.archive(ownerId,launchId,{archived:true});
  const read=await h.manager.read(ownerId);assert.equal(read.launches.length,1);assert.equal(read.launches[0].listArchived,true);assert.equal(read.launches[0].recovery.status,'checking');assert.equal(h.kicks,1);
  assert.equal(h.manager.find(await h.manager.book(ownerId),launchId).id,launchId);
  await h.manager.process(ownerId);assert.equal(h.chainCalls,1);assert.equal(h.books.get(ownerId).launches[0].listArchive.archived,true);
});

test('archive validates identity, account ownership, bans and booleans without writing launch data',async t=>{
  const h=await harness(t),before=structuredClone(h.books.get(ownerId));
  await assert.rejects(h.manager.archive(otherId,launchId,{archived:true}),/not found/);
  await assert.rejects(h.manager.archive('invalid',launchId,{archived:true}),/Invalid/);
  for(const archived of [undefined,null,1,'true'])await assert.rejects(h.manager.archive(ownerId,launchId,{archived}),error=>error.statusCode===400);
  h.users.get(ownerId).banned=true;await assert.rejects(h.manager.archive(ownerId,launchId,{archived:true}),error=>error.statusCode===403);
  h.users.delete(ownerId);await assert.rejects(h.manager.archive(ownerId,launchId,{archived:true}),error=>error.statusCode===404);
  assert.equal(h.writes,0);assert.deepEqual(h.books.get(ownerId),before);
});

test('account bans and a launch becoming active while archive waits for the lock both prevent commit',async t=>{
  for(const change of ['ban','active']){
    const h=await harness(t),locked=h.manager.locked.bind(h.manager);
    h.manager.locked=async(id,fn)=>{if(change==='ban')h.users.get(ownerId).banned=true;else h.books.get(ownerId).launches[0].state='launching';return locked(id,fn);};
    await assert.rejects(h.manager.archive(ownerId,launchId,{archived:true}),error=>error.statusCode===(change==='ban'?403:409));assert.equal(h.writes,0);
  }
});

test('owners cannot restore hidden coins or legacy records through archive controls',async t=>{
  for(const kind of ['hidden','legacy']){
    const launch=fixture({listArchive:{archived:true,actorId:ownerId,at:12}});
    if(kind==='hidden')launch.moderation={hidden:true,actorId:otherId,reason:'Review',at:13};else launch.input.network='devnet';
    const h=await harness(t,launch),before=structuredClone(launch);
    assert.equal(publicLaunch(launch).canRestore,false);
    await assert.rejects(h.manager.archive(ownerId,launchId,{archived:false}),error=>error.statusCode===409);
    assert.equal(h.writes,0);assert.deepEqual(h.books.get(ownerId).launches[0],before);
  }
});

test('concurrent owner archive requests serialize to a single metadata update',async t=>{
  const h=await harness(t);
  const results=await Promise.all(Array.from({length:3},()=>h.manager.archive(ownerId,launchId,{archived:true})));
  assert(results.every(result=>result.listArchived));assert.equal(h.writes,1);assert.equal(h.books.get(ownerId).launches[0].listArchiveHistory.length,1);
});

test('archive public timestamps and reasons never expose untrusted metadata',()=>{
  const view=launchArchiveView(fixture({listArchive:{archived:true,actorId:'private-actor',at:{secret:'private-time'},reason:'private-reason'}}));
  assert.equal(view.archiveAt,null);assert(!JSON.stringify(view).includes('private-'));
});

test('requests that stopped before creating a token do not use the saved-launch allowance',()=>{
  for(const state of ['draft','error','failed'])assert.equal(stoppedBeforeToken(fixture({state})),true,state);
  for(const state of ['launching','pending','awaiting_signature','live','paused','stopping','archived'])assert.equal(stoppedBeforeToken(fixture({state})),false,state);
  assert.equal(stoppedBeforeToken(fixture({curve:'onchain-curve'})),false);
  for(const kind of ['create','launch-all'])assert.equal(stoppedBeforeToken(fixture({operations:[{kind,state:'confirmed'}]})),false,kind);
  for(const state of ['pending','awaiting_signature'])assert.equal(stoppedBeforeToken(fixture({operations:[{kind:'setup',state}]})),false,state);
  assert.equal(stoppedBeforeToken(fixture({recovery:{status:'checking'}})),false);
  assert.equal(stoppedBeforeToken(fixture({recovery:{status:'not-needed'}})),true);
  assert.equal(stoppedBeforeToken(fixture({listArchive:{archived:true}})),true);
});

test('image ownership allows 100 new images per 30 days and never removes an owned image',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'launchpad-images-'));let now=1_800_000_000_000;const stores=new Map();
  const accounts={dir,get:async()=>({}),storeFor:id=>{if(!stores.has(id))stores.set(id,new TelegramStore(join(dir,'users',id),Buffer.alloc(32,7),'account:'+id));return stores.get(id);}};
  const manager=new Launchpad(accounts,null,{now:()=>now,chainFactory:async()=>{throw Error('offline');}});manager.kick=()=>{};
  t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
  const base=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=','base64');
  const png=n=>{const bytes=Buffer.from(base);bytes.writeUInt32BE(n,16);return bytes.toString('base64');};
  // An older account already owns 100 images saved before upload times were recorded.
  const legacy=Array.from({length:100},(_,i)=>i.toString(16).padStart(64,'0')+'.png');
  await accounts.storeFor(ownerId).write('launch-images',{ids:legacy});
  const uploaded=[];for(let n=1;n<=100;n++)uploaded.push((await manager.uploadImage(ownerId,png(n))).imageId);
  await assert.rejects(manager.uploadImage(ownerId,png(101)),/100 new images in the last 30 days/);
  assert.equal((await manager.uploadImage(ownerId,png(5))).imageId,uploaded[4],'an owned image can always be used again');
  now+=30*86400000;
  assert.match((await manager.uploadImage(ownerId,png(101))).imageId,/^[a-f0-9]{64}\.png$/);
  const saved=await accounts.storeFor(ownerId).read('launch-images');
  assert.equal(saved.ids.length,201);assert.ok(legacy.every(id=>saved.ids.includes(id)),'nothing owned is removed');
});
