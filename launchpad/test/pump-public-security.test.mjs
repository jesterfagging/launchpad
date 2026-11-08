import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { PumpPublicService, PUMP_PUBLIC_TREASURY, verifyPublicWalletTransaction, PUMP_NEW_LAUNCHES_ENABLED } from '../src/pump-public-service.mjs';

const wallet = Keypair.generate(), relay = Keypair.generate(), outsider = Keypair.generate(), program = Keypair.generate().publicKey;
const clone = value => structuredClone(value);
function bundle(payer, needsRelayer = false) {
  const instruction = new TransactionInstruction({programId: program,
    keys:[{pubkey:payer.publicKey,isSigner:true,isWritable:true},...(needsRelayer ? [{pubkey:relay.publicKey,isSigner:true,isWritable:false}] : [])],data:Buffer.from([needsRelayer ? 0 : 1])});
  const tx = new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[instruction]}).compileToV0Message());
  return {unsignedTransaction:Buffer.from(tx.serialize()).toString('base64'),needsRelayer,addresses:{authority:Keypair.generate().publicKey.toBase58()},review:{maxWalletDebitLamports:'10000'}};
}
function signed(review, key = wallet) {
  const tx = VersionedTransaction.deserialize(Buffer.from(review.unsignedTransaction,'base64'));tx.sign([key]);return Buffer.from(tx.serialize()).toString('base64');
}
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(),'launchpad-public-security-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let db={schemaVersion:1,config:{programId:program.toBase58(),relayer:relay.publicKey.toBase58(),treasury:PUMP_PUBLIC_TREASURY,cluster:'mainnet-beta'},relayer:{address:relay.publicKey.toBase58(),secretBase64:Buffer.from(relay.secretKey).toString('base64')},launches:[],operations:[],enabled:true,migrationCursor:0};
  const observed={sends:0,prepares:0,savedBeforeSend:false};let now=1_790_000_000_000;
  const adapter={verifyDeployment:async()=>({enabled:true}),balance:async()=>'10000000',deriveMint:async()=>Keypair.generate().publicKey.toBase58(),
    prepare:async(_cfg,args)=>{observed.prepares++;return bundle(args.action==='migrate'?relay:wallet,args.action==='initialize');},
    send:async(_cfg,encoded)=>{observed.sends++;observed.savedBeforeSend=db.operations.some(op=>op.signedTransaction===encoded&&op.state==='journaled');throw Error('timeout after possible send');},
    reconcile:async()=>({state:'pending'}),...overrides.adapter};
  const accounts={dir,hostStore:{read:async()=>clone(db),write:async(_key,value)=>{db=clone(value);}}};
  const session={account:{id:'alice'},walletVerified:true,walletAddress:wallet.publicKey.toBase58()};
  const context={sessionToken:'alice-session',authorize:async()=>session};
  const service=new PumpPublicService({accounts,requireOwner:async()=>{},adapter,getSolUsdPrice:async()=>({usd:200,at:now,source:'fixture'}),publishMetadata:async()=> 'https://example.test/metadata.json',now:()=>now,...overrides});service.closed=true;
  // Model a launch already created by v63; never bypass the production gate.
  const legacy={id:randomUUID(),mint:Keypair.generate().publicKey.toBase58(),mintSeed:'curve-existing-v63',name:'Legacy Launchpad',symbol:'LEGACY',description:'',image:'',website:'',twitter:'',telegram:'',metadataUri:'https://example.test/metadata.json',creatorWallet:wallet.publicKey.toBase58(),creatorId:session.account.id,publicProgramId:program.toBase58(),createdAt:now-60000,status:'trading',finalizedAt:now-50000,priceSnapshot:{usd:'200',at:now-60000,source:'saved v63 reference',solUsdMicros:'200000000'},custodyAuthority:Keypair.generate().publicKey.toBase58(),stateAddress:Keypair.generate().publicKey.toBase58()};
  db.launches.push(legacy);
  const input={action:'buy',expectedWallet:wallet.publicKey.toBase58(),mint:legacy.mint,amountRaw:'1000'};
  const initializeInput={action:'initialize',expectedWallet:wallet.publicKey.toBase58(),name:'Test Launchpad',symbol:'TEST'};
  function seedSavedInitialize({state='awaiting_signature',ownerPreview=false}={}){
    const prepared=bundle(wallet,true),tx=VersionedTransaction.deserialize(Buffer.from(prepared.unsignedTransaction,'base64'));
    const op={id:randomUUID(),ownerId:session.account.id,sessionHash:createHash('sha256').update(context.sessionToken).digest('hex'),wallet:wallet.publicKey.toBase58(),action:'initialize',ownerPreview,mint:legacy.mint,state,createdAt:now-10000,expiresAt:now+120000,configFingerprint:createHash('sha256').update(JSON.stringify(db.config)).digest('hex'),bundle:prepared,review:prepared.review,messageHash:createHash('sha256').update(tx.message.serialize()).digest('hex')};
    if(state!=='awaiting_signature'){op.walletSignedTransaction=signed(prepared);tx.sign([wallet,relay]);op.signedTransaction=Buffer.from(tx.serialize()).toString('base64');op.signature=bs58.encode(tx.signatures[0]);op.sentAt=now-5000;}
    db.operations.push(op);return op;
  }
  return {service,session,context,input,initializeInput,legacy,seedSavedInitialize,observed,read:()=>db,setNow:n=>{now=n;}};
}

test('public signature validation rejects message mutation, missing user proof and injected platform signature',()=>{
  const review=bundle(wallet,true), valid=signed(review);
  assert.doesNotThrow(()=>verifyPublicWalletTransaction(valid,review,wallet.publicKey.toBase58(),relay.publicKey.toBase58()));
  const mutated=VersionedTransaction.deserialize(Buffer.from(valid,'base64'));mutated.message.compiledInstructions[0].data[0]=255;mutated.sign([wallet]);
  assert.throws(()=>verifyPublicWalletTransaction(Buffer.from(mutated.serialize()).toString('base64'),review,wallet.publicKey.toBase58(),relay.publicKey.toBase58()));
  assert.throws(()=>verifyPublicWalletTransaction(review.unsignedTransaction,review,wallet.publicKey.toBase58(),relay.publicKey.toBase58()));
  const injected=VersionedTransaction.deserialize(Buffer.from(valid,'base64'));injected.sign([relay]);
  assert.throws(()=>verifyPublicWalletTransaction(Buffer.from(injected.serialize()).toString('base64'),review,wallet.publicKey.toBase58(),relay.publicKey.toBase58()));
});
test('retired initialization rejects extra client inputs and stops before any price or transaction work',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.prepare(f.session,{...f.initializeInput,solUsdMicros:'1'},f.context),/Unsupported/);
  let priceReads=0;f.service.getSolUsdPrice=async()=>{priceReads++;return{usd:200,at:1_789_999_000_000};};
  await assert.rejects(f.service.prepare(f.session,f.initializeInput,f.context),/New PumpSwap launches are paused/);
  assert.equal(priceReads,0);assert.equal(f.observed.prepares,0);assert.equal(f.read().operations.length,0);assert.equal(f.read().launches.length,1);
});
test('other account and changed wallet cannot submit a reviewed legacy trade',async t=>{
  const f=await fixture(t), prepared=await f.service.prepare(f.session,f.input,f.context), op=prepared.operation;
  const input={operationId:op.id,signedTransaction:signed(f.read().operations[0].bundle)};
  const bob={account:{id:'bob'},walletVerified:true,walletAddress:wallet.publicKey.toBase58()};
  await assert.rejects(f.service.submit(bob,input,{sessionToken:'bob',authorize:async()=>bob}),/another session/);
  const changed={...f.session,walletAddress:outsider.publicKey.toBase58()};
  await assert.rejects(f.service.submit(changed,input,{...f.context,authorize:async()=>changed}),/wallet/);
  assert.equal(f.observed.sends,0);
});
test('legacy trade signed bytes are durable before first send and retry never creates a second transaction',async t=>{
  const f=await fixture(t), prepared=await f.service.prepare(f.session,f.input,f.context);
  const input={operationId:prepared.operation.id,signedTransaction:signed(f.read().operations[0].bundle)};
  const first=await f.service.submit(f.session,input,f.context);
  assert.equal(first.operation.state,'pending');assert.equal(f.observed.sends,1);assert.equal(f.observed.savedBeforeSend,true);
  const wire=f.read().operations[0].signedTransaction;
  const tx=VersionedTransaction.deserialize(Buffer.from(wire,'base64'));
  assert.ok(tx.signatures.every(s=>s.some(Boolean)));assert.equal(bs58.encode(tx.signatures[0]),first.operation.signature);
  await f.service.submit(f.session,input,f.context);
  assert.equal(f.observed.sends,1);assert.equal(f.read().operations[0].signedTransaction,wire);
});
test('an expired approval or changed deployment cannot reach server signing or broadcasting',async t=>{
  const f=await fixture(t), prepared=await f.service.prepare(f.session,f.input,f.context);
  const input={operationId:prepared.operation.id,signedTransaction:signed(f.read().operations[0].bundle)};
  f.setNow(prepared.operation.expiresAt+1);
  await assert.rejects(f.service.submit(f.session,input,f.context),/expired/);
  assert.equal(f.observed.sends,0);assert.equal(f.read().operations[0].signedTransaction,undefined);
});
test('kernel custody commit lock releases after host process is killed',async t=>{
  const f=await fixture(t), dir=f.service.accounts.dir;
  const moduleUrl=new URL('../src/pump-public-service.mjs',import.meta.url).href;
  const source=`import {PumpPublicService} from ${JSON.stringify(moduleUrl)};const service=new PumpPublicService({accounts:{dir:${JSON.stringify(dir)}}});await service.locked(async()=>{process.stdout.write('LOCKED\\n');await new Promise(()=>{});});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Child did not acquire lock')),10000);child.once('error',reject);child.stdout.on('data',chunk=>{if(String(chunk).includes('LOCKED')){clearTimeout(timer);resolve();}});child.stderr.on('data',chunk=>{clearTimeout(timer);reject(Error(String(chunk)));});});
  await assert.rejects(f.service.locked(async()=>true),/Another Launchpad process/);
  child.kill('SIGKILL');
  await new Promise(resolve=>child.once('exit',resolve));
  let acquired=false;
  for(let i=0;i<20&&!acquired;i++){try{acquired=await f.service.locked(async()=>true);}catch{await delay(25);}}
  assert.equal(acquired,true,'The kernel must release a crashed writer without deleting a stale file.');
});
test('cancel permits a new unsigned review but never cancels a journaled transaction',async t=>{
  const f=await fixture(t), first=await f.service.prepare(f.session,f.input,f.context);
  const cancelled=await f.service.cancel(f.session,{operationId:first.operation.id},f.context);assert.equal(cancelled.operation.state,'cancelled');
  const second=await f.service.prepare(f.session,f.input,f.context);assert.notEqual(second.operation.id,first.operation.id);
  await f.service.submit(f.session,{operationId:second.operation.id,signedTransaction:signed(f.read().operations.at(-1).bundle)},f.context);
  await assert.rejects(f.service.cancel(f.session,{operationId:second.operation.id},f.context),/cannot be cancelled/);
  assert.equal(f.observed.sends,1);
});
test('new Pump launches and re-enabling are blocked for every role, including owner preview',async t=>{
  assert.equal(PUMP_NEW_LAUNCHES_ENABLED,false);
  for(const role of ['user','admin','owner'])for(const enabled of [true,false]){
    const f=await fixture(t);f.read().enabled=enabled;f.session.account.role=role;
    const before=clone(f.read());
    const status=await f.service.publicStatus(f.session,f.context);
    const ownerStatus=await f.service.ownerStatus(f.session,f.context);assert.equal(ownerStatus.canEnable,false);
    assert.equal(status.available,false);assert.equal(status.publicEnabled,false);assert.equal(status.ownerPreview,false);assert.equal(status.newLaunchesHidden,true);assert.deepEqual(status.pairs,[]);
    await assert.rejects(f.service.prepare(f.session,f.initializeInput,f.context),/New PumpSwap launches are paused/);
    await assert.rejects(f.service.setEnabled(f.session,{enabled:true},f.context),/New PumpSwap launches are paused/);
    assert.deepEqual(f.read(),before);assert.equal(f.observed.prepares,0);assert.equal(f.observed.sends,0);
  }
});
test('previously saved unsigned initialize cannot be submitted even as owner, but remains cancellable',async t=>{
  for(const ownerPreview of [false,true]){
    const f=await fixture(t),op=f.seedSavedInitialize({ownerPreview});
    await assert.rejects(f.service.submit(f.session,{operationId:op.id,signedTransaction:signed(op.bundle)},f.context),/New PumpSwap launches are paused/);
    assert.equal(f.observed.sends,0);assert.equal(f.read().operations[0].signedTransaction,undefined);
    const cancelled=await f.service.cancel(f.session,{operationId:op.id},f.context);assert.equal(cancelled.operation.state,'cancelled');
  }
});
test('already journaled legacy initialize reconciles without replacing or resubmitting it',async t=>{
  const f=await fixture(t),op=f.seedSavedInitialize({state:'pending'}),wire=op.signedTransaction;
  f.service.adapter.reconcile=async()=>({state:'finalized',phase:'trading'});
  const result=await f.service.submit(f.session,{operationId:op.id,signedTransaction:op.walletSignedTransaction},f.context);
  assert.equal(result.operation.state,'finalized');assert.equal(result.launch.status,'trading');assert.equal(f.read().operations[0].signedTransaction,wire);assert.equal(f.observed.sends,0);assert.equal(f.observed.prepares,0);
});
test('legacy trades remain available when new-launch activation is paused',async t=>{
  const f=await fixture(t);await f.service.setEnabled(f.session,{enabled:false},f.context);
  const result=await f.service.prepare(f.session,f.input,f.context);assert.equal(result.operation.action,'buy');assert.equal(result.operation.state,'awaiting_signature');assert.equal(f.observed.prepares,1);assert.equal(f.read().enabled,false);
});
test('queued creator payouts settle automatically after graduation without changing custody state',async t=>{
 const f=await fixture(t);
 const launch=f.read().launches[0];launch.status='migrated';launch.creatorFeesPending='500';f.service.closed=false;
 f.service.adapter.state=async()=>({phase:'migrated',creatorFeesPending:'500',creatorFeesPaid:'1000'});
 let ready=false;f.service.adapter.creatorFeesReady=async()=>ready;
 f.service.adapter.prepare=async(_config,args)=>{assert.equal(args.action,'creator-fees');return bundle(relay,false);};
 await f.service.graduateCandidate(clone(f.read()),clone(launch));assert.equal(f.observed.sends,0,'Below-rent credits must not spend relayer gas repeatedly');
 ready=true;await f.service.graduateCandidate(clone(f.read()),clone(launch));
 const op=f.read().operations.find(o=>o.action==='creator-fees');assert.ok(op?.signedTransaction);assert.equal(f.observed.sends,1);
 assert.equal(f.read().launches[0].status,'migrated');assert.equal(f.read().launches[0].migrationSignature,undefined);
 f.service.adapter.reconcile=async()=>({state:'finalized',phase:'migrated',creatorFeesPending:'0',creatorFeesPaid:'1500'});
 await f.service.receiptOutsideLock(clone(f.read()),clone(op));
 assert.equal(f.read().launches[0].creatorFeesPending,'0');assert.equal(f.read().launches[0].creatorFeesPaid,'1500');
 f.service.closed=true;
});

test('changed legacy deployment cannot reach signing or broadcasting',async t=>{
  const f=await fixture(t),prepared=await f.service.prepare(f.session,f.input,f.context);
  const input={operationId:prepared.operation.id,signedTransaction:signed(f.read().operations[0].bundle)};
  f.read().config.programId=Keypair.generate().publicKey.toBase58();
  await assert.rejects(f.service.submit(f.session,input,f.context),/configuration changed/);assert.equal(f.observed.sends,0);assert.equal(f.read().operations[0].signedTransaction,undefined);
});
test('revoked owner access cannot use a saved owner-preview operation as an authorization bypass',async t=>{
  let owner=true;const f=await fixture(t,{requireOwner:async()=>{if(!owner)throw Object.assign(Error('Owner verification required'),{statusCode:403});}}),op=f.seedSavedInitialize({state:'pending',ownerPreview:true});owner=false;
  await assert.rejects(f.service.submit(f.session,{operationId:op.id,signedTransaction:op.walletSignedTransaction},f.context),/Owner verification/);assert.equal(f.observed.sends,0);assert.equal(f.read().operations[0].state,'pending');
});
