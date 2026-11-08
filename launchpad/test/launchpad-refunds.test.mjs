import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, SystemProgram, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { newLaunchKeys } from '../src/launchpad-receipts.mjs';
import { ABANDONED_LAUNCH_MS, recoveryDue, recoveryWakeAt, recoverFailedLaunch, publicRecovery } from '../src/launchpad-recovery-service.mjs';
const address = () => Keypair.generate().publicKey.toBase58();
const NOW = 2000000;
function harness() {
  const keys = newLaunchKeys(); keys.platform = keys.wallet; keys.payer = newLaunchKeys().wallet; keys.wallet = keys.payer;
  const l = {id:'a'.repeat(32),input:{route:'raydium',network:'mainnet-beta'},keys,operations:[],authorizedAt:100,createdAt:100,state:'error',phase:'create',error:'Creation failed',autoFees:true,feesRequested:true};
  const receipts = new Map(), saved = [], broadcasts = [], pool = new PublicKey(address()); let balance=1000000,now=NOW,exists=false,closed=false;
  const c = {addresses:()=>({pool,m:new PublicKey(l.keys.mint.address)}),verifyLaunch:async()=>({curve:pool.toBase58()}),receipt:async op=>receipts.get(op.signature)||null,broadcast:async op=>{assert(saved.at(-1).operations.some(x=>x.signature===op.signature&&x.raw===op.raw));broadcasts.push(op.signature);},c:{
    getBlockHeight:async()=>500, getEpochInfo:async()=>({blockHeight:500,absoluteSlot:1000}),
    getMultipleAccountsInfoAndContext:async()=>({context:{slot:1000},value:exists?[{} , {}]:[null,null]}),
    getAccountInfoAndContext:async()=>({context:{slot:1001},value:balance?{owner:SystemProgram.programId,lamports:balance,data:Buffer.alloc(0),executable:false}:null}),
    getLatestBlockhash:async()=>({blockhash:address(),lastValidBlockHeight:600}),getFeeForMessage:async()=>({value:5000}),getMinimumBalanceForRentExemption:async()=>890880,
    simulateTransaction:async(tx,opts)=>{assert(tx instanceof VersionedTransaction);assert.equal(opts.sigVerify,true);assert.equal(opts.commitment,'finalized');return{value:{err:null}};}
  }};
  function receipt(signature,delta,{from=l.keys.platform.address,to=l.keys.payer.address,fee=5000,err=null}={}) {
    const pre=[10000000,10000000],post=[10000000-delta-fee,10000000+delta];
    return {slot:999,transaction:{signatures:[signature],message:{staticAccountKeys:[new PublicKey(from),new PublicKey(to)]}},meta:{err,fee,preBalances:pre,postBalances:post}};
  }
  function funding(amount=1000000) {const op={operationId:address(),kind:'setup',signature:'fund',state:'confirmed',createdAt:100,lastValidBlockHeight:200};l.operations.push(op);receipts.set('fund',receipt('fund',amount,{from:l.keys.payer.address,to:l.keys.platform.address}));}
  return {l,c,receipts,saved,broadcasts,receipt,funding,run:()=>recoverFailedLaunch({launch:l,chain:c,persist:async()=>saved.push(structuredClone(l)),now,closed:()=>closed}),get now(){return now;},advance:ms=>now+=ms,set balance(v){balance=v;},set exists(v){exists=v;},set closed(v){closed=v;}};
}
test('recovery only stops authorized failures or abandoned attempts; live coins and fresh prompts remain untouched',()=>{
  const h=harness(),l=h.l;assert(recoveryDue(l,NOW));l.state='launching';l.authorizedAt=NOW;assert(!recoveryDue(l,NOW));assert.equal(recoveryWakeAt(l,NOW),NOW+ABANDONED_LAUNCH_MS);
  l.state='awaiting_signature';assert(!recoveryDue(l,NOW));assert(recoveryDue(l,NOW+ABANDONED_LAUNCH_MS));l.authorizedAt=null;assert(!recoveryDue(l,NOW+ABANDONED_LAUNCH_MS));l.authorizedAt=100;l.curve=address();assert(!recoveryDue(l,NOW));
});
test('refund signs only attributable setup SOL to original payer and journals bytes before broadcast',async()=>{
  const h=harness();h.funding();await h.run();const op=h.l.operations.at(-1);
  assert.equal(h.l.state,'failed');assert.equal(h.l.autoFees,false);assert.equal(h.l.feesRequested,false);assert.equal(op.kind,'setup-refund');assert.equal(op.amount,'995000');assert.equal(op.from,h.l.keys.platform.address);assert.equal(op.to,h.l.keys.payer.address);
  const tx=VersionedTransaction.deserialize(Buffer.from(op.raw,'base64'));assert.equal(tx.message.staticAccountKeys[0].toBase58(),h.l.keys.platform.address);assert.deepEqual(h.broadcasts,[op.signature]);assert(!JSON.stringify(publicRecovery(h.l)).includes(h.l.keys.platform.secret));
  h.receipts.set(op.signature,h.receipt(op.signature,995000));h.advance(10001);await h.run();assert.equal(h.l.recovery.status,'complete');assert.equal(h.l.recovery.refundedLamports,'995000');assert.deepEqual(publicRecovery(h.l).signatures,[op.signature]);await h.run();assert.equal(h.broadcasts.length,1);
});
test('an RPC timeout keeps the same refund signature and never creates a replacement',async()=>{
  const h=harness();h.funding();h.c.broadcast=async op=>{h.broadcasts.push(op.signature);throw Error('timeout');};await h.run();const signature=h.l.operations.at(-1).signature;
  h.advance(16001);await h.run();assert.deepEqual(h.broadcasts,[signature,signature]);assert.equal(h.l.operations.filter(x=>x.kind==='setup-refund').length,1);h.c.c.getBlockHeight=async()=>999;h.advance(60000);await h.run();assert.equal(h.l.operations.filter(x=>x.kind==='setup-refund').length,1);assert.equal(h.l.recovery.status,'refunding');
});
test('confirmed creation restores live status instead of failing or refunding the token',async()=>{
  const h=harness();h.funding();h.exists=true;await h.run();assert(h.l.curve);assert.equal(h.l.state,'live');assert.equal(h.l.recovery.status,'not-needed');assert.equal(h.broadcasts.length,0);
});
test('confirmed creation and temporarily missing accounts never release setup funds',async()=>{
  const h=harness();h.funding();h.l.operations.push({kind:'create',signature:'create',state:'confirmed',lastValidBlockHeight:200});h.receipts.set('create',h.receipt('create',0,{from:h.l.keys.payer.address}));await h.run();assert.equal(h.l.recovery.status,'checking');assert.notEqual(h.l.state,'failed');assert.equal(h.broadcasts.length,0);
});
test('wallet requests remain blocked from recovery until their blockhash expires',async()=>{
  const h=harness();h.funding();h.l.operations.push({kind:'create',state:'awaiting_signature',lastValidBlockHeight:700,createdAt:100,needsSignature:true,unsignedRaw:'untrusted bytes'});await h.run();assert.equal(h.l.recovery.status,'checking');assert.equal(h.broadcasts.length,0);assert.equal(h.l.operations.at(-1).state,'awaiting_signature');
  h.c.c.getEpochInfo=async()=>({blockHeight:701,absoluteSlot:1000});h.advance(10001);await h.run();assert.equal(h.l.operations[1].state,'cancelled');assert.equal(h.l.operations[1].unsignedRaw,undefined);assert.equal(h.l.operations.at(-1).kind,'setup-refund');
});
test('missing signed setup receipt cannot authorize a refund even after blockhash expiration',async()=>{
  const h=harness();h.l.operations.push({kind:'setup',state:'pending',signature:'missing',lastValidBlockHeight:200,createdAt:100});await h.run();assert.equal(h.l.recovery.status,'blocked');assert.equal(h.l.state,'failed');assert.equal(h.broadcasts.length,0);assert.match(h.l.recovery.reason,/receipt is unavailable/);
});
test('recovery never sweeps default or connected wallets and never claims unrelated deposited SOL',async()=>{
  const h=harness();h.l.keys.platform=h.l.keys.payer;await h.run();assert.equal(h.l.recovery.status,'complete');assert.equal(h.broadcasts.length,0);
  const x=harness();x.funding(1000000);x.balance=4000000;await x.run();assert.equal(x.l.operations.at(-1).amount,'995000');
  const y=harness();y.balance=4000000;await y.run();assert.equal(y.l.recovery.status,'complete');assert.equal(y.broadcasts.length,0);
});
test('confirmed storage spending and failed platform transaction fees reduce refundable budget',async()=>{
  const h=harness();h.funding(1000000);h.l.operations.push({kind:'storage-fund',signature:'storage',state:'confirmed'},{kind:'platform-setup',signature:'bad',state:'failed'});
  h.receipts.set('storage',h.receipt('storage',100000,{to:address()}));h.receipts.set('bad',h.receipt('bad',0,{to:address(),err:{InstructionError:[0,'failed']}}));h.balance=890000;await h.run();assert.equal(h.l.operations.at(-1).amount,'885000');
});
test('unsafe balances and mismatched refund receipts never mark money returned',async()=>{
  const h=harness();h.funding();await h.run();const op=h.l.operations.at(-1);h.receipts.set(op.signature,h.receipt(op.signature,994999));h.advance(10001);await h.run();assert.equal(h.l.recovery.status,'blocked');assert.equal(h.l.recovery.refundedLamports,'0');assert.equal(op.state,'pending');assert.equal(h.broadcasts.length,1);
  const x=harness();x.funding();x.c.c.getAccountInfoAndContext=async()=>({context:{slot:900},value:null});await x.run();assert.equal(x.l.recovery.status,'blocked');assert.equal(x.broadcasts.length,0);
});
test('failed refund is reconciled and its paid fee deducted before a fresh attempt',async()=>{
  const h=harness();h.funding();await h.run();const first=h.l.operations.at(-1);h.receipts.set(first.signature,h.receipt(first.signature,0,{err:{InstructionError:[0,'failed']}}));h.advance(10001);await h.run();assert.equal(first.state,'failed');assert.equal(h.l.recovery.status,'blocked');h.balance=995000;h.advance(60001);await h.run();const second=h.l.operations.at(-1);assert.equal(second.amount,'990000');assert.notEqual(second.signature,first.signature);
});
test('shutdown after refund persistence prevents broadcasting while preserving exact operation',async()=>{
  const h=harness();h.funding();let stopped=false;await recoverFailedLaunch({launch:h.l,chain:h.c,now:NOW,closed:()=>stopped,persist:async()=>{h.saved.push(structuredClone(h.l));if(h.l.operations.some(x=>x.kind==='setup-refund'))stopped=true;}});assert.equal(h.l.operations.at(-1).state,'pending');assert.equal(h.broadcasts.length,0);
});

async function managerHarness(t,h){
  const [{Launchpad},{mkdtemp,rm},{tmpdir},{join}]=await Promise.all([import('../src/launchpad.mjs'),import('node:fs/promises'),import('node:os'),import('node:path')]);
  const dir=await mkdtemp(join(tmpdir(),'launchpad-refund-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  h.l.review={minimumSol:'0.01'};h.l.gas={reserved:'0'};h.l.credits={quote:'0',base:'0'};let book={version:1,launches:[structuredClone(h.l)]},kicks=0;
  const store={dir,read:async(key,fallback)=>key==='launchpad'?structuredClone(book):fallback,write:async(key,value)=>{if(key==='launchpad'){book=structuredClone(value);h.saved.push(structuredClone(value.launches[0]));}}};
  const manager=new Launchpad({dir,storeFor:()=>store,get:async()=>({mainWallet:h.l.keys.payer.address})},null,{chainFactory:async()=>h.c,now:()=>h.now});manager.kick=()=>{kicks++;};t.after(()=>manager.close());
  return{manager,get launch(){return book.launches[0];},get kicks(){return kicks;}};
}
test('manager recovers stale wallet prompts before its normal signature skip and blocks resuming or signing stopped launches',async t=>{
  const h=harness();h.funding();h.l.state='awaiting_signature';h.l.operations.push({operationId:'wait',kind:'create',state:'awaiting_signature',lastValidBlockHeight:700,createdAt:100,needsSignature:true,unsignedRaw:'old-partial-bytes'});
  const m=await managerHarness(t,h);await m.manager.process('owner');assert.equal(m.launch.recovery.status,'checking');assert.equal(m.launch.state,'stopping');assert.equal(m.manager.wakeAt.get('owner'),h.now+10000);
  const view=(await m.manager.read('owner')).launches[0];assert.equal(view.pendingSignature,null);assert.equal(view.canReprepare,false);assert.equal(view.canReuseDraft,false);
  await assert.rejects(m.manager.action('owner',h.l.id,'resume'),/stopped/);await assert.rejects(m.manager.action('owner',h.l.id,'launch'),/stopped/);await assert.rejects(m.manager.refresh('owner',h.l.id),/submitted transaction/);await assert.rejects(m.manager.sign('owner',h.l.id,'wait','signed'),/stopped/);await assert.rejects(m.manager.signature('owner',h.l.id,'wait'),/no longer active/);
  h.c.c.getEpochInfo=async()=>({blockHeight:701,absoluteSlot:1000});h.advance(10001);await m.manager.process('owner');assert.equal(m.launch.recovery.status,'refunding');const refund=m.launch.operations.at(-1);h.receipts.set(refund.signature,h.receipt(refund.signature,995000));h.advance(10001);await m.manager.process('owner');assert.equal(m.launch.state,'failed');assert.equal(m.launch.recovery.status,'complete');assert.equal((await m.manager.read('owner')).launches[0].canReuseDraft,true);assert.equal(m.manager.wakeAt.get('owner'),Infinity);
});
test('manager read schedules abandoned launch cleanup but never cancels an active launch',async t=>{
  const h=harness();h.l.state='launching';h.l.authorizedAt=h.now;h.l.operations=[];const m=await managerHarness(t,h);await m.manager.read('owner');assert.equal(m.kicks,0);h.advance(ABANDONED_LAUNCH_MS+1);await m.manager.read('owner');assert.equal(m.kicks,1);
});
