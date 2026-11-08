import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramStore } from '../src/telegram-store.mjs';
import { AdminHolderDistributions } from '../src/admin-holder-distributions.mjs';
import { SOL_MINT } from '../public/launchpad-model.mjs';

const ACTOR='a'.repeat(32),OWNER='b'.repeat(32),REQ='1'.repeat(32),NEXT='2'.repeat(32),NAME='admin-holder-distributions';
const coin=(n=1,route='raydium',mode='holders')=>({account:{id:OWNER},launch:{id:route==='meteora'?'12345678-1234-4234-8234-123456789abc':String(n).padStart(32,'0'),state:'live',curve:'Pool',authorizedAt:1,credits:{quote:'1200'},heldSolInventory:{live:true,credit:'1200',busy:false},input:{route,network:'mainnet-beta',quoteMint:SOL_MINT,feeMode:mode,name:`Coin ${n}`,symbol:`C${n}`},keys:{mint:{address:'PublicMint'},wallet:{secret:'NEVER_EXPOSE'}},operations:[{raw:'PRIVATE_SIGNED_BYTES'}]}});
async function fixture(t,rows=[coin()],options={}){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-holder-bulk-')),hostStore=new TelegramStore(dir,randomBytes(32)),accounts={dir,hostStore};
  const children=new Map(),queued=[];let allowed=true,scanCount=0;
  const worker={queueHeldSolDistribution:async(actor,input)=>{queued.push({...input,actor});if(!children.has(input.requestId))children.set(input.requestId,{state:'queued',reason:'Queued',amountLamports:'1200'});return children.get(input.requestId);},heldSolDistributionStatus:async({requestId})=>children.get(requestId)||null};
  const launchAdmin={requireAdmin:async()=>{if(!allowed)throw Object.assign(Error('Forbidden'),{statusCode:403});return {id:ACTOR};},inventory:async()=>{scanCount++;return {launches:rows};},meteora:worker};
  const create=()=>{const queue=new AdminHolderDistributions({accounts,launchpad:worker,launchAdmin,...options});queue.kick=()=>{};return queue;};const queue=create();
  t.after(async()=>{await queue.close();await rm(dir,{recursive:true,force:true});});
  return {dir,accounts,worker,launchAdmin,queue,children,queued,create,rows,get scans(){return scanCount;},set allowed(value){allowed=value;}};
}

test('enqueue is durable and does no launch inventory or signer work on the request path',async t=>{
  const h=await fixture(t),result=await h.queue.enqueue(ACTOR,{requestId:REQ});
  assert.equal(result.job.state,'queued');assert.equal(result.alreadyRequested,false);assert.equal(h.scans,0);assert.equal(h.queued.length,0);
  const restored=h.create();assert.equal((await restored.read(ACTOR)).job.requestId,REQ);
  await restored.process();assert.equal(h.scans,1);assert.equal((await restored.read(ACTOR)).job.state,'running');assert.equal(h.queued.length,0);
  assert(!JSON.stringify(await restored.read(ACTOR)).includes('NEVER_EXPOSE'));
});

test('same and concurrent new request IDs coalesce globally; terminal replay never queues again',async t=>{
  const h=await fixture(t),results=await Promise.all([h.queue.enqueue(ACTOR,{requestId:REQ}),h.queue.enqueue(ACTOR,{requestId:NEXT})]);
  assert.equal(results.filter(x=>!x.alreadyRequested).length,1);const parent=results[0].job.requestId;
  await h.queue.process();await h.queue.process();assert.equal(h.queued.length,1);
  h.children.set(h.queued[0].requestId,{state:'completed',reason:'Paid',paidLamports:'1200'});await h.queue.process();
  for(const requestId of [REQ,NEXT]){const replay=await h.queue.enqueue(ACTOR,{requestId});assert.equal(replay.alreadyRequested,true);assert.equal(replay.job.requestId,parent);assert.equal(replay.job.state,'completed');}
  assert.equal(h.queued.length,1);
});

test('crash after parent attempted write but before child enqueue recovers exact deterministic ID',async t=>{
  const h=await fixture(t);await h.queue.enqueue(ACTOR,{requestId:REQ});await h.queue.process();
  const job=await h.accounts.hostStore.read(`${NAME}-${REQ}`),child=job.items[0].requestId;job.items[0].attempted=true;job.items[0].state='processing';await h.accounts.hostStore.write(`${NAME}-${REQ}`,job);
  await h.create().process();assert.equal(h.queued.length,1);assert.equal(h.queued[0].requestId,child);assert.equal(h.queued[0].actor,ACTOR);
});

test('ambiguous child enqueue completion reconciles its saved status without new financial request',async t=>{
  const h=await fixture(t);let sends=0;
  h.worker.queueHeldSolDistribution=async(actor,input)=>{sends++;h.children.set(input.requestId,{state:'completed',reason:'Saved payment settled',paidLamports:'42'});throw Error('RPC URL secret exception');};
  await h.queue.enqueue(ACTOR,{requestId:REQ});await h.queue.process();await h.queue.process();
  assert.equal((await h.queue.read(ACTOR)).job.items[0].state,'processing');assert(!JSON.stringify(await h.queue.read(ACTOR)).includes('secret'));
  await h.create().process();const job=(await h.queue.read(ACTOR)).job;assert.equal(job.state,'completed');assert.equal(job.items[0].paidLamports,'42');assert.equal(sends,1);
});

test('both native launch ID formats dispatch correctly, unsupported routes are summarized, no public IDs accepted',async t=>{
  const h=await fixture(t,[coin(),coin(2,'meteora'),coin(3,'pumpswap'),coin(4,'raydium','creator')]);
  await h.queue.enqueue(ACTOR,{requestId:REQ,accountId:'untrusted',ids:['untrusted']});await h.queue.process();await h.queue.process();
  const job=(await h.queue.read(ACTOR)).job;assert.equal(job.scannedLaunches,4);assert.equal(job.items.length,2);assert.equal(job.counts.skipped,0);assert.equal(job.excludedCount,1);assert.match(job.excludedReasons[0].reason,/route/);assert.equal(h.queued.length,2);assert(h.queued.some(row=>row.id.includes('-')));assert(h.queued.every(row=>row.accountId===OWNER));
});

test('work per pass is bounded and polling rotates fairly through active children',async t=>{
  const h=await fixture(t,Array.from({length:10},(_,n)=>coin(n+1)),{batchSize:2});await h.queue.enqueue(ACTOR,{requestId:REQ});await h.queue.process();
  for(let n=1;n<=5;n++){await h.queue.process();assert.equal(h.queued.length,n*2);}
  for(const [id] of h.children)h.children.set(id,{state:'completed',reason:'Settled'});
  for(let n=0;n<5;n++)await h.queue.process();assert.equal((await h.queue.read(ACTOR)).job.counts.completed,10);
});

test('slow background inventory does not hold the request journal lock or block status',async t=>{
  const h=await fixture(t);await h.queue.enqueue(ACTOR,{requestId:REQ});let release,entered;const ready=new Promise(r=>{entered=r;});h.launchAdmin.inventory=async()=>{entered();await new Promise(r=>{release=r;});return {launches:h.rows};};
  const work=h.queue.process();await ready;
  try{const result=await Promise.race([h.queue.enqueue(ACTOR,{requestId:NEXT}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Request blocked on inventory')),1000))]);assert.equal(result.alreadyRequested,true);assert.equal((await h.queue.read(ACTOR)).job.state,'queued');}finally{release();await work;}
});

test('admin/session revocation before durable enqueue and before each child prevents new work',async t=>{
  const h=await fixture(t,[coin(),coin(2)]);let calls=0;
  await assert.rejects(h.queue.enqueue(ACTOR,{requestId:REQ},{authorize:async()=>{if(++calls===2)throw Error('Session revoked');}}),/Session revoked/);assert.equal((await h.queue.read(ACTOR)).job,null);
  await h.queue.enqueue(ACTOR,{requestId:REQ});await h.queue.process();h.allowed=false;await h.queue.process();h.allowed=true;
  assert.equal(h.queued.length,0);assert.equal((await h.queue.read(ACTOR)).job.counts.skipped,2);
});

test('revocation does not abandon an already recorded child or release another active parent',async t=>{
  const h=await fixture(t,[coin(),coin(2)],{batchSize:1});await h.queue.enqueue(ACTOR,{requestId:REQ});await h.queue.process();await h.queue.process();h.allowed=false;
  await h.queue.process();await h.queue.process();assert.equal(h.queued.length,1);h.children.set(h.queued[0].requestId,{state:'completed',reason:'Saved payment reconciled'});await h.queue.process();h.allowed=true;
  const job=(await h.queue.read(ACTOR)).job;assert.equal(job.state,'completed');assert.equal(job.counts.completed,1);assert.equal(job.counts.skipped,1);
});

test('inventory errors and capacity bounds fail closed without pretending a partial scan succeeded',async t=>{
  for(const kind of ['error','limit','invalid']){
    const h=await fixture(t,[coin(),coin(2)],{maxTargets:1});if(kind==='error')h.launchAdmin.inventory=async()=>{throw Error('private inventory error');};if(kind==='invalid')h.rows[0].launch.id='wrong';
    await h.queue.enqueue(ACTOR,{requestId:REQ});await h.queue.process();const job=(await h.queue.read(ACTOR)).job;assert.equal(job.state,'blocked');assert.equal(job.discovered,false);assert.equal(h.queued.length,0);assert(job.reason.includes('Nothing was queued'));assert(!job.reason.includes('private'));
  }
});

test('request journal capacity preserves old idempotency records instead of evicting them',async t=>{
  const h=await fixture(t,[],{maxRequests:1});await h.queue.enqueue(ACTOR,{requestId:REQ});await h.queue.process();await assert.rejects(h.queue.enqueue(ACTOR,{requestId:NEXT}),/journal is full/);assert.equal((await h.queue.enqueue(ACTOR,{requestId:REQ})).alreadyRequested,true);
});

test('paid and deferred amounts stay separate; missing route service cannot abandon an attempted child',async t=>{
  const h=await fixture(t,[coin(1,'meteora')]);await h.queue.enqueue(ACTOR,{requestId:REQ});await h.queue.process();await h.queue.process();h.launchAdmin.meteora=null;await h.queue.process();assert.equal((await h.queue.read(ACTOR)).job.state,'running');
  h.launchAdmin.meteora=h.worker;h.children.set(h.queued[0].requestId,{state:'completed',reason:'Some holder payments remain deferred for rent.',amountLamports:'1200',paidLamports:'1000',deferredLamports:'200'});await h.queue.process();const item=(await h.queue.read(ACTOR)).job.items[0];assert.equal(item.paidLamports,'1000');assert.equal(item.deferredLamports,'200');assert.match(item.reason,/deferred/);
});

test('cross-account shared, personal or exported Ray service scopes skip before enqueue',async t=>{
  const rows=[coin(),coin(2),coin(3),coin(4)];rows[2].launch.feeWalletExportedAt=1;const h=await fixture(t,rows);
  h.launchAdmin.inventory=async()=>({launches:rows,context:launch=>({shared:launch.id===rows[0].launch.id,mainWallet:launch.id===rows[1].launch.id})});
  await h.queue.enqueue(ACTOR,{requestId:REQ});await h.queue.process();await h.queue.process();const job=(await h.queue.read(ACTOR)).job;assert.equal(job.counts.skipped,3);assert.equal(h.queued.length,1);assert.equal(h.queued[0].id,rows[3].launch.id);
});

test('invalid IDs, foreign request replay and failed durable storage never authorize child work',async t=>{
  const h=await fixture(t);await assert.rejects(h.queue.enqueue(ACTOR,{requestId:'invalid'}),e=>e.statusCode===400);
  const write=h.accounts.hostStore.write.bind(h.accounts.hostStore);h.accounts.hostStore.write=async()=>{throw Error('Disk unavailable');};
  await assert.rejects(h.queue.enqueue(ACTOR,{requestId:REQ}),/Disk unavailable/);assert.equal(h.queued.length,0);assert.equal(h.scans,0);
  h.accounts.hostStore.write=write;assert.equal((await h.queue.read(ACTOR)).job,null);await h.queue.enqueue(ACTOR,{requestId:REQ});
  await assert.rejects(h.queue.enqueue('c'.repeat(32),{requestId:REQ}),/another administrator/);assert.equal(h.queued.length,0);
});

test('session revoked during prepared job write cannot publish that intent for background execution',async t=>{
  const h=await fixture(t);let valid=true;const write=h.accounts.hostStore.write.bind(h.accounts.hostStore);
  h.accounts.hostStore.write=async(name,value)=>{await write(name,value);if(name===`${NAME}-${REQ}`)valid=false;};
  await assert.rejects(h.queue.enqueue(ACTOR,{requestId:REQ},{authorize:async()=>{if(!valid)throw Error('Session revoked');}}),/Session revoked/);
  assert.equal((await h.queue.read(ACTOR)).job,null);await h.create().process();assert.equal(h.queued.length,0);assert.equal(h.scans,0);
});

test('discovery summarizes ineligible inventory and retains active cycles even before claim credits arrive',async t=>{
  const rows=Array.from({length:7},(_,n)=>coin(n+1));
  rows[1].launch.input.quoteMint='DifferentAsset';rows[2].launch.state='launching';rows[3].launch.credits.quote='0';
  rows[4].launch.cycle={stage:'claim'};rows[4].launch.credits.quote='0';
  rows[5]=coin(6,'meteora');rows[5].launch.heldSolInventory.live=false;
  rows[6].launch.input.network='devnet';
  const h=await fixture(t,rows);await h.queue.enqueue(ACTOR,{requestId:REQ});await h.queue.process();await h.queue.process();
  const job=(await h.queue.read(ACTOR)).job;assert.equal(job.scannedLaunches,7);assert.equal(job.excludedCount,5);assert.equal(job.excludedReasons.reduce((sum,row)=>sum+row.count,0),5);assert.equal(job.items.length,2);assert.equal(h.queued.length,2);assert(h.queued.some(row=>row.id===rows[4].launch.id));
});

test('waiting intent survives restart and resumes the exact child ID after the saved cycle ends',async t=>{
  let now=1000,busy=true;const h=await fixture(t,[coin()],{now:()=>now});
  h.worker.queueHeldSolDistribution=async(actor,input)=>{h.queued.push({...input,actor});if(busy)return {state:'waiting',reason:'Waiting for the existing reward cycle.'};const result={state:'queued',amountLamports:'99'};h.children.set(input.requestId,result);return result;};
  await h.queue.enqueue(ACTOR,{requestId:REQ});await h.queue.process();await h.queue.process();
  let job=(await h.queue.read(ACTOR)).job;assert.equal(job.state,'running');assert.equal(job.counts.waiting,1);assert.equal(h.queued.length,1);const child=h.queued[0].requestId;
  const restored=h.create();await restored.process();assert.equal(h.queued.length,1);busy=false;now+=15000;await restored.process();assert.equal(h.queued.length,2);assert.equal(h.queued[1].requestId,child);
  h.children.set(child,{state:'completed',paidLamports:'90',remainingLamports:'9',deferredLamports:'8'});await restored.process();job=(await restored.read(ACTOR)).job;assert.equal(job.state,'completed');assert.equal(job.counts.completed,1);assert.equal(job.items[0].remainingLamports,'9');assert.equal(job.items[0].deferredLamports,'8');assert.equal(h.queued.length,2);
});

test('waiting for a cycle never bypasses reauthorization when starting the child later',async t=>{
  let now=1000;const h=await fixture(t,[coin()],{now:()=>now});h.worker.queueHeldSolDistribution=async()=>({state:'waiting',reason:'Saved cycle pending'});
  await h.queue.enqueue(ACTOR,{requestId:REQ});await h.queue.process();await h.queue.process();h.allowed=false;now+=15000;await h.queue.process();h.allowed=true;
  const job=(await h.queue.read(ACTOR)).job;assert.equal(job.state,'completed');assert.equal(job.counts.skipped,1);assert.match(job.items[0].reason,/authorization was revoked/);assert.equal(h.children.size,0);
});

test('SOL-paired Pump.fun Holders coins are paid through the Pump.fun service; a coin on another pair is left to Sell & distribute all',async t=>{
  const pump=(n,quoteMint=SOL_MINT,state='created')=>({account:{id:OWNER},launch:{id:String(n).padStart(24,'0'),state,input:{route:'pump-classic',network:'mainnet-beta',quoteMint,feeMode:'holders',name:`Pump ${n}`,symbol:`P${n}`},keys:{mint:{address:'PumpMint'+n},wallet:{address:'LaunchWallet'}}}});
  const h=await fixture(t,[pump(1),pump(2,'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),pump(3,SOL_MINT,'failed')]);
  const sent=[],children=new Map();let kicks=0;
  h.launchAdmin.pumpClassic={queueHeldSolDistribution:async(actor,input)=>{sent.push({...input,actor});children.set(input.requestId,{state:'processing',reason:'Collecting this coin’s creator fees.'});return children.get(input.requestId);},heldSolDistributionStatus:async({requestId})=>children.get(requestId)||{state:'missing'},kick(){kicks++;}};
  await h.queue.enqueue(ACTOR,{requestId:REQ});await h.queue.process();await h.queue.process();
  let job=(await h.queue.read(ACTOR)).job;
  assert.equal(job.items.length,1);assert.equal(job.items[0].route,'pump-classic');assert.equal(job.excludedCount,2);
  assert.deepEqual(job.excludedReasons.map(row=>row.reason).sort(),['The launch is not ready for a holder payout.','The reward asset is not SOL.']);
  assert.equal(sent.length,1);assert.equal(sent[0].id,'1'.padStart(24,'0'));assert.equal(sent[0].actor,ACTOR);assert.equal(job.items[0].state,'processing');assert.equal(kicks,1);
  children.set(sent[0].requestId,{state:'completed',reason:'Paid 0.5 SOL to 3 holders.',paidLamports:'500000000',remainingLamports:'0'});
  await h.queue.process();job=(await h.queue.read(ACTOR)).job;
  assert.deepEqual([job.state,job.items[0].state,job.items[0].paidLamports,job.items[0].remainingLamports],['completed','completed','500000000','0']);assert.equal(sent.length,1);
});
