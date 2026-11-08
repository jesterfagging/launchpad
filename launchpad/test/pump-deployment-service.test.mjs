import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Keypair,PublicKey,SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {PumpDeploymentService} from '../src/pump-deployment-service.mjs';
import {PUMP_TEST_DEPLOYMENT_POLICY as POLICY} from '../src/pump-test-deployment.mjs';

const owner=Keypair.fromSeed(new Uint8Array(32).fill(17)),recipient=Keypair.fromSeed(new Uint8Array(32).fill(18));
const blockhash=Keypair.fromSeed(new Uint8Array(32).fill(19)).publicKey.toBase58();
const binary=Buffer.from('unit-test fixture ELF only'),sha=x=>createHash('sha256').update(x).digest('hex');
const session={account:{id:'owner-account',role:'admin',mfaEnabled:true}},context={sessionToken:'session-token-with-enough-entropy-for-test',authorize:async()=>{}};
function sign(plan,key=owner){return plan.pendingSignatures.map(({transaction})=>{const tx=VersionedTransaction.deserialize(Buffer.from(transaction,'base64'));tx.sign([key]);return Buffer.from(tx.serialize()).toString('base64');});}
async function fixture(t,{stage='write-buffer',count=3,sendError=false,unauthorized=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'pump-deployment-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const state={stage,completed:0,pending:Array.from({length:count},(_,i)=>i),height:10,sent:[],statuses:null,auth:!unauthorized,binds:0,activeSends:0,maxSends:0,sendError};
 const policy={operator:owner.publicKey.toBase58(),treasury:recipient.publicKey.toBase58(),binarySha256:sha(binary),binaryLength:binary.length};
 const inspection=()=>({stage:state.stage,identities:{programId:recipient.publicKey.toBase58(),buffer:recipient.publicKey.toBase58()},chunks:{total:count,completed:state.completed,pendingIndices:[...state.pending]},rent:{remainingRentLamports:'1000'},verifiedDeployment:state.stage==='deployed'?{programId:recipient.publicKey.toBase58(),binarySha256:policy.binarySha256}:null});
 const planner={policy,inspect:async()=>inspection(),build:({blockhash})=>({stage:state.stage,maxWalletDebitLamports:'1000',transactions:(state.stage==='write-buffer'?state.pending:[0]).map(i=>{
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:owner.publicKey,recentBlockhash:blockhash,instructions:[SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:recipient.publicKey,lamports:i+1})]}).compileToV0Message());
  return {id:state.stage==='write-buffer'?`write:${i}`:state.stage,kind:state.stage,chunkIndex:i,transactionBase64:Buffer.from(tx.serialize()).toString('base64')};})})};
 const connection={getBlockHeight:async()=>state.height,getLatestBlockhash:async()=>({blockhash,lastValidBlockHeight:100}),getFeeForMessage:async()=>({value:5000}),getBalance:async()=>10000000000,simulateTransaction:async()=>({value:{err:null}}),
  sendRawTransaction:async(raw)=>{state.activeSends++;state.maxSends=Math.max(state.maxSends,state.activeSends);const saved=JSON.parse(await readFile(join(dir,'pump-owner-test/deployment-journal.json'),'utf8'));assert.ok(saved.batches.at(-1).transactions.every(x=>x.signature&&x.signedTransaction),'All signatures must be durable before any send');await new Promise(r=>setTimeout(r,4));state.activeSends--;state.sent.push(Buffer.from(raw));if(state.sendError)throw Error('RPC failed https://rpc.invalid/?secret=do-not-leak');return bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]);},
  getSignatureStatuses:async signatures=>({context:{slot:500},value:state.statuses??signatures.map(()=>null)}),getTransaction:async()=>null};
 const requireOwner=async()=>{if(!state.auth)throw Object.assign(Error('Forbidden'),{statusCode:403});};
 const service=new PumpDeploymentService({accounts:{dir},requireOwner,connection,planner,loadBinary:async()=>binary,bindDeployment:async()=>{state.binds++;}});
 return {dir,state,connection,service,planner,inspection};
}

test('prepares owner-only v0 batch with exact fees and rejects unexpected body fields',async t=>{
 const f=await fixture(t);const plan=await f.service.prepare(session,{},context);
 assert.equal(plan.pendingSignatures.length,3);assert.equal(plan.totalNetworkFeeLamports,'15000');assert.equal(plan.maxWalletDebitLamports,'16000');
 assert.equal(plan.pendingSignatures[0].wallet,owner.publicKey.toBase58());assert.equal(f.state.sent.length,0);
 await assert.rejects(f.service.prepare(session,{rpcUrl:'https://attacker.invalid'},context),/Unexpected/);
 await assert.rejects(f.service.prepare(session,{wallet:recipient.publicKey.toBase58()},context),/pinned/);
 await assert.rejects(f.service.prepare(session,{},{}),/authorization/);
 f.state.auth=false;await assert.rejects(f.service.status(session,context),/Forbidden/);
});

test('requires current session and rejects changed messages, missing and invalid signatures',async t=>{
 const f=await fixture(t),plan=await f.service.prepare(session,{},context),good=sign(plan);
 const changed=VersionedTransaction.deserialize(Buffer.from(good[0],'base64'));changed.message.recentBlockhash=recipient.publicKey.toBase58();changed.sign([owner]);
 await assert.rejects(f.service.submit(session,{planId:plan.planId,signedTransactions:[Buffer.from(changed.serialize()).toString('base64'),...good.slice(1)]},context),/changed/);
 await assert.rejects(f.service.submit(session,{planId:plan.planId,signedTransactions:good.slice(1)},context),/count/);
 await assert.rejects(f.service.submit(session,{planId:plan.planId,signedTransactions:plan.pendingSignatures.map(x=>x.transaction)},context),/signature/);
 await assert.rejects(f.service.submit(session,{planId:plan.planId,signedTransactions:good},{...context,sessionToken:'another-authenticated-session-token'}),/different/);
 const mutated=Buffer.from(good[0],'base64');mutated[1]^=1;await assert.rejects(f.service.submit(session,{planId:plan.planId,signedTransactions:[mutated.toString('base64'),...good.slice(1)]},context),/signature/);
 assert.equal(f.state.sent.length,0);
});

test('journals signatures before send, caps concurrency at three and never resends submitted batch',async t=>{
 const f=await fixture(t,{count:25}),plan=await f.service.prepare(session,{},context),signedTransactions=sign(plan);
 const value=await f.service.submit(session,{planId:plan.planId,signedTransactions},context);assert.equal(value.state,'pending');assert.equal(f.state.sent.length,25);assert.ok(f.state.maxSends<=3);
 const repeated=await f.service.submit(session,{planId:plan.planId,signedTransactions},context);assert.equal(repeated.resubmitted,false);assert.equal(f.state.sent.length,25);
 await assert.rejects(f.service.prepare(session,{},context),/unresolved/);
 f.state.statuses=Array.from({length:25},()=>({confirmationStatus:'finalized',err:null,slot:501}));
 const done=await f.service.reconcile(session,{planId:plan.planId},context);assert.equal(done.state,'complete');assert.equal(done.canPrepare,true);
});

test('unknown send outcome stays pending and cannot trigger automatic fresh hashes',async t=>{
 const f=await fixture(t,{sendError:true}),plan=await f.service.prepare(session,{},context),signedTransactions=sign(plan);
 const result=await f.service.submit(session,{planId:plan.planId,signedTransactions},context);
 assert.ok(result.batch.transactions.every(x=>x.state==='submission-unknown'));
 assert.ok(!JSON.stringify(result).includes('do-not-leak'));
 const status=await f.service.reconcile(session,{},context);assert.equal(status.state,'pending');assert.equal(status.canPrepare,false);
 assert.equal(f.state.sent.length,3);await assert.rejects(f.service.prepare(session,{},context),/unresolved/);
});

test('expired unknown rent-funded creation remains blocked without finalized state proof',async t=>{
 const f=await fixture(t,{stage:'create-buffer',count:1,sendError:true}),plan=await f.service.prepare(session,{},context);
 await f.service.submit(session,{planId:plan.planId,signedTransactions:sign(plan)},context);f.state.height=101;
 const status=await f.service.reconcile(session,{},context);assert.equal(status.batch.transactions[0].state,'expired-unconfirmed');assert.equal(status.canPrepare,false);
 await assert.rejects(f.service.prepare(session,{},context),/unresolved/);assert.equal(f.state.sent.length,1);
 f.state.stage='write-buffer';const proved=await f.service.reconcile(session,{},context);assert.equal(proved.batch.transactions[0].state,'state-confirmed');assert.equal(proved.canPrepare,true);
});

test('expired partial write batch reconciles exact finalized byte progress and only missing writes resume',async t=>{
 const f=await fixture(t,{sendError:true}),plan=await f.service.prepare(session,{},context);await f.service.submit(session,{planId:plan.planId,signedTransactions:sign(plan)},context);
 f.state.height=101;f.state.pending=[1];f.state.completed=2;
 const result=await f.service.reconcile(session,{},context);assert.equal(result.state,'resumable');assert.deepEqual(result.batch.transactions.map(x=>x.state),['state-confirmed','resumable-write','state-confirmed']);assert.equal(result.canPrepare,true);
 const resumed=await f.service.prepare(session,{},context);assert.equal(resumed.pendingSignatures.length,1);assert.equal(resumed.pendingSignatures[0].transactionId,'write:1');assert.equal(f.state.sent.length,3,'No automatic resubmission');
});

test('unsigned expired plans can be replaced by a fresh authenticated owner session',async t=>{
 const f=await fixture(t),old=await f.service.prepare(session,{},context),nextContext={...context,sessionToken:'new-authenticated-owner-session-token'};
 await assert.rejects(f.service.prepare(session,{},nextContext),/different/);f.state.height=101;
 const next=await f.service.prepare(session,{},nextContext);assert.notEqual(next.planId,old.planId);assert.equal(f.state.sent.length,0);
});

test('RPC receipt absence cannot replay final program deployment',async t=>{
 const f=await fixture(t,{stage:'deploy-program',count:1,sendError:true}),plan=await f.service.prepare(session,{},context);await f.service.submit(session,{planId:plan.planId,signedTransactions:sign(plan)},context);f.state.height=101;
 let result=await f.service.reconcile(session,{},context);assert.equal(result.batch.transactions[0].state,'expired-unconfirmed');
 f.state.stage='deployed';result=await f.service.reconcile(session,{},context);assert.equal(result.batch.transactions[0].state,'state-confirmed');assert.equal(result.canPrepare,false);assert.equal(f.state.binds,1);
});

test('restores durable unknown batches after service restart and refuses binary/journal tampering',async t=>{
 const f=await fixture(t,{sendError:true}),plan=await f.service.prepare(session,{},context);await f.service.submit(session,{planId:plan.planId,signedTransactions:sign(plan)},context);
 const restart=new PumpDeploymentService({accounts:{dir:f.dir},requireOwner:async()=>{},connection:f.connection,planner:f.planner,loadBinary:async()=>binary,bindDeployment:async()=>{}});
 assert.equal((await restart.status(session,context)).pendingBatch.planId,plan.planId);await assert.rejects(restart.prepare(session,{},context),/unresolved/);
 const bad=new PumpDeploymentService({accounts:{dir:f.dir},requireOwner:async()=>{},connection:f.connection,planner:f.planner,loadBinary:async()=>Buffer.from('wrong')});await assert.rejects(bad.status(session,context),/binary/);
 const path=join(f.dir,'pump-owner-test/deployment-journal.json'),journal=JSON.parse(await readFile(path,'utf8'));journal.batches[0].transactions[0].signature=bs58.encode(new Uint8Array(64));await writeFile(path,JSON.stringify(journal));await assert.rejects(restart.status(session,context),/signature/);
});

// Runs against your own owner build (private/pump-owner-test/); skipped without it.
const OWNER_BUILD=await readFile(new URL('../private/pump-owner-test/curve_pump_test_OWNER_REQUIRES_REVIEW.so',import.meta.url)).catch(()=>null);
test('actual asynchronous seeded binding writes a verified funded config only after finalized byte checks',{skip:OWNER_BUILD?false:'private/pump-owner-test/ owner build is not present'},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pump-binding-integration-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const code=OWNER_BUILD;
 const program=Buffer.alloc(36);program.writeUInt32LE(2);new PublicKey(POLICY.programData).toBuffer().copy(program,4);
 const data=Buffer.alloc(45+code.length);data.writeUInt32LE(3);data.writeBigUInt64LE(12000n,4);data[12]=1;new PublicKey(POLICY.operator).toBuffer().copy(data,13);code.copy(data,45);
 let calls=0,authorized=true;
 const rpc=async(method,params)=>{
  if(method==='getGenesisHash')return POLICY.genesisHash;
  assert.equal(method,'getAccountInfo');calls++;const full=params[0]===POLICY.programId?program:data;
  const slice=params[1]?.dataSlice,bytes=slice?full.subarray(slice.offset,slice.offset+slice.length):full;
  return {context:{slot:13000+calls},value:{owner:POLICY.loader,executable:params[0]===POLICY.programId,data:[bytes.toString('base64'),'base64']}};
 };
 const connection={getGenesisHash:async()=>POLICY.genesisHash,getMultipleAccountsInfoAndContext:async()=>({context:{slot:13000},value:[{owner:new PublicKey(POLICY.loader),executable:true,data:program,lamports:1000},{owner:new PublicKey(POLICY.loader),executable:false,data,lamports:1000},null]}),getMinimumBalanceForRentExemption:async()=>1000000};
 const service=new PumpDeploymentService({accounts:{dir},requireOwner:async()=>{assert.ok(authorized);},connection,bindingRpc:rpc});
 const status=await service.status(session,context);assert.equal(status.stage,'deployed');assert.ok(calls>=4);
 const config=JSON.parse(await readFile(join(dir,'pump-test-config.json'),'utf8'));assert.equal(config.programId,POLICY.programId);assert.equal(config.expectedProgramSha256,POLICY.binarySha256);assert.equal(config.expectedDeploymentSlot,'12000');assert.equal(config.expectedUpgradeAuthority,POLICY.operator);assert.equal(config.solUsdMicros,null);assert.equal(config.migrationRentLamports,'20000000');
 const manifest=JSON.parse(await readFile(config.buildManifest,'utf8'));assert.equal(manifest.deployed,true);assert.equal(manifest.binding.seededProgram.programId,POLICY.programId);
 const original=await readFile(join(dir,'pump-test-config.json'),'utf8');await service.status(session,context);assert.equal(await readFile(join(dir,'pump-test-config.json'),'utf8'),original);
});


test('revoked authorization after durable submission marker prevents the RPC send',async t=>{
 const f=await fixture(t,{count:1}),plan=await f.service.prepare(session,{},context);
 const revoking={...context,authorize:async()=>{
  const saved=JSON.parse(await readFile(join(f.dir,'pump-owner-test/deployment-journal.json'),'utf8'));
  if(saved.batches.at(-1).transactions.some(x=>x.state==='submission-started')){f.state.auth=false;throw Error('Session revoked');}
 }};
 await assert.rejects(f.service.submit(session,{planId:plan.planId,signedTransactions:sign(plan)},revoking),/Forbidden/);
 assert.equal(f.state.sent.length,0);
 const journal=JSON.parse(await readFile(join(f.dir,'pump-owner-test/deployment-journal.json'),'utf8'));
 assert.equal(journal.batches.at(-1).state,'pending');assert.equal(journal.batches.at(-1).transactions[0].state,'submission-unknown');
 assert.ok(journal.batches.at(-1).transactions[0].signature);
 f.state.auth=true;await assert.rejects(f.service.prepare(session,{},context),/unresolved/);
});

test('exclusive deployment lock fails closed even for a nonexistent PID and releases after normal errors',async t=>{
 const f=await fixture(t);await f.service.directory();const lock=join(f.dir,'pump-owner-test/deployment.lock');
 await writeFile(lock,JSON.stringify({pid:2147483647,createdAt:0}),{mode:0o600});
 await assert.rejects(f.service.prepare(session,{},context),/locked/);assert.ok(await readFile(lock));
 await rm(lock);f.connection.getLatestBlockhash=async()=>{throw Error('Unavailable');};
 await assert.rejects(f.service.prepare(session,{},context),/Unavailable/);
 await assert.rejects(readFile(lock),{code:'ENOENT'});
});
