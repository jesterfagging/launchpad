import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AddressLookupTableAccount,ComputeBudgetProgram,Keypair,PublicKey,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {DammPumpService,DAMM_PUMP_DEFAULTS,DAMM_PUMP_SOL,DAMM_PUMP_TREASURY,verifyPublicWalletTransaction} from '../src/damm-pump-service.mjs';
import {dammPumpDiscoveryRecord} from '../src/launchpad-explore.mjs';
import {holderLpVaults} from '../src/public-coin-holders.mjs';
import {addresses as dammAddresses} from '../src/damm-pump-client.mjs';
import {verifySignedTransaction} from '../src/providers.mjs';

const wallet=Keypair.generate(),relayer=Keypair.generate(),program=Keypair.generate().publicKey,quote=Keypair.generate().publicKey.toBase58();
const address=()=>Keypair.generate().publicKey.toBase58();
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-damm-service-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let now=1790000000000,ownerCalls=0,sends=0,savedBeforeSend=false;
  const stores=new Map([['pump-public',{untouched:'legacy'}],['damm-pump',{schemaVersion:1,config:{cluster:'mainnet-beta',programId:program.toBase58(),relayer:relayer.publicKey.toBase58(),treasury:DAMM_PUMP_TREASURY},relayer:{address:relayer.publicKey.toBase58(),secretBase64:Buffer.from(relayer.secretKey).toString('base64')},launches:[],operations:[],enabled:false,migrationCursor:0}]]);
  const accounts={dir,hostStore:{read:async(k,f)=>structuredClone(stores.get(k)??f),write:async(k,v)=>stores.set(k,structuredClone(v))}};
  const adapter={verifyDeployment:async()=>({enabled:true}),balance:async()=>'30000000',deriveMint:async()=>address(),prepare:async(_config,args)=>{
    const needsRelayer=args.action==='initialize',payer=['migrate','protocol-fees'].includes(args.action)?relayer:wallet;
    const ix=new TransactionInstruction({programId:program,keys:[{pubkey:payer.publicKey,isSigner:true,isWritable:true},...(needsRelayer?[{pubkey:relayer.publicKey,isSigner:true,isWritable:false}]:[])],data:Buffer.from([6])});
    const tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:address(),instructions:[ix]}).compileToV0Message());
    return {unsignedTransaction:Buffer.from(tx.serialize()).toString('base64'),needsRelayer,review:{maxWalletDebitLamports:'5000'},lookupTables:args.action==='configure'?[{address:address(),addresses:[address()]}]:args.launch.lookupTables,addresses:{authority:address(),state:address(),dammPool:address()}};
  },send:async(_config,wire)=>{sends++;savedBeforeSend=stores.get('damm-pump').operations.some(o=>o.state==='journaled'&&o.signedTransaction===wire);throw Error('uncertain RPC send');},reconcile:async()=>({state:'pending'})};
  const pair={mint:quote,tokenProgram:TOKEN_PROGRAM_ID.toBase58(),decimals:6,symbol:'Q',name:'Quote',category:'stocks',launchReady:true};
  // These lifecycle tests cover existing coins and the private test route; public
  // new launches closed in v71.18 (see the closed-route test below).
  const service=new DammPumpService({newLaunchesEnabled:true,accounts,adapter,requireOwner:async()=>{ownerCalls++;throw Error('not owner');},quoteEligibility:async()=>pair,listPairs:async()=>[pair],getQuotePrice:async()=>({mint:quote,usd:25,at:now}),publishMetadata:async()=> 'https://launchpad.test/metadata.json',now:()=>now});service.closed=true;
  const session={account:{id:'alice',role:'user'},walletVerified:true,walletAddress:wallet.publicKey.toBase58()},context={sessionToken:'alice-session',authorize:async()=>session};
  const input={action:'initialize',expectedWallet:wallet.publicKey.toBase58(),name:'New token',symbol:'NEW',quoteMint:quote};
  return {service,session,context,input,adapter,stores,pair,get ownerCalls(){return ownerCalls;},get sends(){return sends;},get savedBeforeSend(){return savedBeforeSend;},setNow:v=>{now=v;},sign:operation=>{const tx=VersionedTransaction.deserialize(Buffer.from(operation.transaction,'base64'));tx.sign([wallet]);return Buffer.from(tx.serialize()).toString('base64');}};
}

test('verified deployment is public for a regular verified wallet with independent quote precision and journal',async t=>{
  const f=await fixture(t),status=await f.service.publicStatus();assert.equal(status.available,true);assert.equal(status.capabilities.holderRewards,false);
  const value=await f.service.prepare(f.session,f.input,f.context);assert.equal(value.operation.action,'configure');
  assert.equal(f.ownerCalls,0);assert.equal(value.launch.quoteMint,quote);assert.equal(value.launch.quoteDecimals,6);assert.equal(value.operation.review.quoteUsd,'25');
  assert.equal(f.stores.get('damm-pump').launches[0].priceSnapshot.quoteUsdMicros,'25000000');assert.deepEqual(f.stores.get('pump-public'),{untouched:'legacy'});
  assert(!JSON.stringify(value).includes('secretBase64'));assert(!JSON.stringify(value).includes('sessionHash'));
});
test('incompatible quote, forged quote price and stale reference never prepare a signed operation',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.prepare(f.session,{...f.input,quoteUsdMicros:'1'},f.context),/Unsupported/);
  f.pair.launchReady=false;await assert.rejects(f.service.prepare(f.session,f.input,f.context),/compatible/);
  f.pair.launchReady=true;f.service.getQuotePrice=async()=>({mint:quote,usd:25,at:1789999900000});
  await assert.rejects(f.service.prepare(f.session,f.input,f.context),/fresh USD/);assert.equal(f.stores.get('damm-pump').operations.length,0);
});
test('disabled or unverified controller does not allow public preparation',async t=>{
  const f=await fixture(t);f.adapter.verifyDeployment=async()=>({enabled:false});
  assert.equal((await f.service.publicStatus()).available,false);await assert.rejects(f.service.prepare(f.session,f.input,f.context),/disabled on chain/);
  f.adapter.verifyDeployment=async()=>{throw Error('wrong binary');};await assert.rejects(f.service.prepare(f.session,f.input,f.context),/wrong binary/);
});
test('new launches wait for graduation rent funding rather than accepting only a dust gas balance',async t=>{
  const f=await fixture(t);f.adapter.balance=async()=>'1000000';assert.equal((await f.service.publicStatus()).available,false);
  await assert.rejects(f.service.prepare(f.session,f.input,f.context),/graduation gas funding/);assert.equal(f.stores.get('damm-pump').operations.length,0);
});
test('signed configuration is journaled before a send timeout and retry retains the exact wire',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context),input={operationId:review.operation.id,signedTransaction:f.sign(review.operation)};
  const sent=await f.service.submit(f.session,input,f.context);assert.equal(sent.operation.state,'pending');assert(f.savedBeforeSend);assert.equal(f.sends,1);
  const wire=f.stores.get('damm-pump').operations[0].signedTransaction;
  await f.service.submit(f.session,input,f.context);assert.equal(f.sends,1);assert.equal(f.stores.get('damm-pump').operations[0].signedTransaction,wire);
  await assert.rejects(f.service.cancel(f.session,{operationId:review.operation.id},f.context),/cannot be cancelled/);
});
test('session substitution and message mutation never reach relayer signing',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context),signed=f.sign(review.operation);
  await assert.rejects(f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:signed},{...f.context,sessionToken:'other-session'}),/another session/);
  const tx=VersionedTransaction.deserialize(Buffer.from(signed,'base64'));tx.message.compiledInstructions[0].data[0]=7;tx.sign([wallet]);
  await assert.rejects(f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:Buffer.from(tx.serialize()).toString('base64')},f.context),/changed the reviewed/);
  assert.equal(f.sends,0);assert.equal(f.stores.get('damm-pump').operations[0].signedTransaction,undefined);
});
test('expired review and changed deployment cannot reach a broadcast',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context),input={operationId:review.operation.id,signedTransaction:f.sign(review.operation)};
  f.stores.get('damm-pump').config.programId=address();await assert.rejects(f.service.submit(f.session,input,f.context),/configuration changed/);
  f.setNow(review.operation.expiresAt+1);await assert.rejects(f.service.submit(f.session,input,f.context),/expired/);assert.equal(f.sends,0);
});
test('discovery exposes verified lifecycle and quote metadata without custody journal or false rewards',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context),launch={...review.launch,status:'trading'};
  const projected=dammPumpDiscoveryRecord(launch,1790000000000);assert(projected);assert.equal(projected.coin.quote.mint,quote);assert.equal(projected.coin.feeMode,'none');assert.equal(projected.coin.creatorFeeBps,0);assert.equal(projected.coin.launchMode,'damm-pump');assert.equal(projected.rewardRecord,null);
  assert.equal(dammPumpDiscoveryRecord({...launch,hidden:true},1790000000000),null);assert(dammPumpDiscoveryRecord({...launch,hidden:true},1790000000000,{includeHidden:true}));
  assert.equal(dammPumpDiscoveryRecord({...launch,status:'migrated'},1790000000000),null);
});

test('finalized setup survives restart and continues the same mint with the original first buy and fresh price',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,{...f.input,amountRaw:'123456',slippageBps:200},f.context);
  await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:f.sign(review.operation)},f.context);
  f.adapter.reconcile=async(_config,op)=>({state:'finalized',lookupTables:op.bundle.lookupTables});
  const configured=await f.service.reconcile(f.session,{operationId:review.operation.id},f.context);
  assert.equal(configured.operation.nextAction,'initialize');assert.equal(configured.launch.status,'draft');
  assert.equal((await f.service.operations(f.session,f.context)).operations[0].id,review.operation.id);
  f.service.getQuotePrice=async()=>({mint:quote,usd:30,at:1790000000000});
  const initialized=await f.service.prepare(f.session,{action:'initialize',mint:review.launch.mint,expectedWallet:wallet.publicKey.toBase58()},f.context);
  assert.equal(initialized.operation.action,'initialize');assert.equal(initialized.operation.review.firstBuyRaw,'123456');assert.equal(initialized.operation.review.quoteUsd,'30');assert.equal(initialized.operation.review.configurationCreated,true);assert.equal(initialized.launch.mint,review.launch.mint);
  assert.equal(f.stores.get('damm-pump').launches.length,1);assert.equal((await f.service.operations(f.session,f.context)).operations.length,1);
  const input={operationId:initialized.operation.id,signedTransaction:f.sign(initialized.operation)};
  await f.service.submit(f.session,input,f.context);
  const signed=VersionedTransaction.deserialize(Buffer.from(f.stores.get('damm-pump').operations.at(-1).signedTransaction,'base64'));assert(signed.signatures.every(signature=>signature.some(Boolean)));
});

test('wrong setup table receipt cannot release initialization and expired initialization preserves the paid setup',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context);
  await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:f.sign(review.operation)},f.context);
  f.adapter.reconcile=async()=>({state:'finalized',lookupTables:[{address:address(),addresses:[address()]}]});
  await assert.rejects(f.service.reconcile(f.session,{operationId:review.operation.id},f.context),/differs/);
  assert.equal(f.stores.get('damm-pump').launches[0].setupStatus,undefined);
  f.adapter.reconcile=async(_config,op)=>({state:'finalized',lookupTables:op.bundle.lookupTables});await f.service.reconcile(f.session,{operationId:review.operation.id},f.context);
  await assert.rejects(f.service.prepare(f.session,{action:'initialize',mint:review.launch.mint,expectedWallet:wallet.publicKey.toBase58(),quoteMint:address()},f.context),/different metadata or quote/);
  const initialized=await f.service.prepare(f.session,{action:'initialize',mint:review.launch.mint,expectedWallet:wallet.publicKey.toBase58()},f.context);
  await f.service.submit(f.session,{operationId:initialized.operation.id,signedTransaction:f.sign(initialized.operation)},f.context);
  f.adapter.reconcile=async()=>({state:'expired'});await f.service.reconcile(f.session,{operationId:initialized.operation.id},f.context);
  assert.equal(f.stores.get('damm-pump').launches[0].status,'draft');assert.equal((await f.service.operations(f.session,f.context)).operations[0].action,'configure');
});

test('lookup-table messages require the exact saved address table and bounded indexes',()=>{
  const target=Keypair.generate().publicKey,tableKey=Keypair.generate().publicKey;
  const table=new AddressLookupTableAccount({key:tableKey,state:{deactivationSlot:(1n<<64n)-1n,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,authority:undefined,addresses:[target]}});
  const ix=new TransactionInstruction({programId:program,keys:[{pubkey:wallet.publicKey,isSigner:true,isWritable:true},{pubkey:target,isSigner:false,isWritable:true}],data:Buffer.from([6])});
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:address(),instructions:[ix]}).compileToV0Message([table]));
  const bundle={unsignedTransaction:Buffer.from(tx.serialize()).toString('base64'),needsRelayer:false,addressLookupTables:[{address:tableKey.toBase58(),addresses:[target.toBase58()]}]};
  tx.sign([wallet]);const signed=Buffer.from(tx.serialize()).toString('base64');
  assert.doesNotThrow(()=>verifyPublicWalletTransaction(signed,bundle,wallet.publicKey.toBase58(),relayer.publicKey.toBase58()));
  assert.throws(()=>verifyPublicWalletTransaction(signed,{...bundle,addressLookupTables:[]},wallet.publicKey.toBase58(),relayer.publicKey.toBase58()));
  assert.throws(()=>verifyPublicWalletTransaction(signed,{...bundle,addressLookupTables:[{address:new PublicKey(Buffer.alloc(32,7)).toBase58(),addresses:[target.toBase58()]}]},wallet.publicKey.toBase58(),relayer.publicKey.toBase58()));
});

test('automatic protocol fees require the fresh-price threshold, journal once, and keep migration separate',async t=>{
  const f=await fixture(t);await f.service.prepare(f.session,f.input,f.context);
  const saved=f.stores.get('damm-pump');saved.operations=[];saved.launches[0].status='trading';saved.launches[0].confirmationStatus='finalized';
  f.service.closed=false;t.after(()=>{f.service.closed=true;});f.adapter.balance=async()=>'100000000';f.adapter.state=async()=>({phase:'trading'});
  let ready=false,checks=0;f.adapter.feesReady=async(_config,_launch,_current,options)=>{checks++;assert.equal(options.minimumUsd,20);assert.equal(options.quote.mint,quote);return ready;};
  let snapshot=await f.service.load();await f.service.graduateCandidate(snapshot,snapshot.launches[0]);assert.equal(f.sends,0);assert.equal(checks,1);
  ready=true;snapshot=await f.service.load();await f.service.graduateCandidate(snapshot,snapshot.launches[0]);assert.equal(checks,1,'Fee checks are paced even though graduation still polls');
  f.setNow(1790003600001);snapshot=await f.service.load();await f.service.graduateCandidate(snapshot,snapshot.launches[0]);assert.equal(f.sends,1);assert(f.savedBeforeSend);
  let op=f.stores.get('damm-pump').operations[0];assert.equal(op.action,'protocol-fees');assert.equal(f.stores.get('damm-pump').launches[0].status,'trading');
  snapshot=await f.service.load();await f.service.graduateCandidate(snapshot,snapshot.launches[0]);assert.equal(f.sends,1,'An uncertain saved claim cannot become another claim');
  f.adapter.reconcile=async()=>({state:'finalized',phase:'trading',protocolFee:{quoteRaw:'50000',recipient:DAMM_PUMP_TREASURY}});
  await f.service.receiptOutsideLock(await f.service.load(),op);assert.equal(f.stores.get('damm-pump').launches[0].protocolFeesPaidRaw,'50000');
  f.adapter.state=async()=>({phase:'bonded'});f.adapter.feesReady=async()=>{throw Error('graduation must take priority');};
  f.setNow(1790003620001);snapshot=await f.service.load();await f.service.graduateCandidate(snapshot,snapshot.launches[0]);op=f.stores.get('damm-pump').operations.at(-1);assert.equal(op.action,'migrate');assert.equal(f.sends,2);
});

async function atomicBuyFixture(t,{fee=false,atomic=true}={}){
  const f=await fixture(t);await f.service.prepare(f.session,f.input,f.context);
  const data=f.stores.get('damm-pump'),launch=data.launches[0];data.operations=[];
  Object.assign(launch,{status:'trading',confirmationStatus:'finalized',finalizedAt:1790000000000,creatorId:'another-creator',creatorWallet:address(),migrationNotice:'Waiting for endpoint'});
  if(fee)launch.launchDefaults={...DAMM_PUMP_DEFAULTS,graduationFeeNumerator:'322369073',graduationFeeDenominator:'1000000000',graduationFeeBps:3223.69073};
  const pool=address(),lpMint=address(),basePrepare=f.adapter.prepare;
  f.adapter.prepare=async(config,args)=>({...await basePrepare(config,args),...(atomic?{atomicGraduation:true}:{}),addresses:{pool,lpMint},poolIndex:9,trade:{input:args.amountRaw,minimum:'1',venue:'damm'},review:{maxWalletDebitLamports:'25005000',expectedPool:pool}});
  const review=await f.service.prepare(f.session,{action:'buy',mint:launch.mint,expectedWallet:wallet.publicKey.toBase58(),amountRaw:'100000000'},f.context);
  const submitted=await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:f.sign(review.operation)},f.context),op=f.stores.get('damm-pump').operations[0];
  const receipt={state:'finalized',signature:op.signature,phase:'migrated',poolId:pool,lpMint,issuedLpAtoms:'500000',burnedLpAtoms:'500000',retainedLpAtoms:'0',trade:{side:'buy',amountRaw:'12345',quoteRaw:'38942124',venue:'damm'},...(fee?{graduationFee:{verified:true,quoteMint:quote,amountRaw:'322369073',recipient:DAMM_PUMP_TREASURY,signature:op.signature},graduationFeeRaw:'322369073',grossQuoteRaw:'1000000000',poolQuoteRaw:'677630927'}:{})};
  return {...f,review,submitted,receipt,op,launch,wire:op.signedTransaction,get sends(){return f.sends;}};
}

test('a wallet-reviewed final buy records its own finalized migration and trade once without the creator or relayer signing',async t=>{
  const f=await atomicBuyFixture(t,{fee:true});assert.equal(f.ownerCalls,0);
  const tx=VersionedTransaction.deserialize(Buffer.from(f.wire,'base64'));assert.equal(tx.message.header.numRequiredSignatures,1);assert.equal(tx.message.staticAccountKeys[0].toBase58(),wallet.publicKey.toBase58());
  assert.equal(f.op.action,'buy');assert.equal(f.op.ownerId,f.session.account.id);assert.notEqual(f.launch.creatorWallet,f.op.wallet);
  assert(f.savedBeforeSend);assert.equal(f.sends,1);assert.equal(f.submitted.launch.status,'trading');
  f.adapter.reconcile=async()=>f.receipt;
  const complete=await f.service.reconcile(f.session,{operationId:f.op.id},f.context),saved=f.stores.get('damm-pump');
  assert.equal(complete.launch.status,'migrated');assert.equal(complete.launch.poolId,f.receipt.poolId);assert.equal(complete.launch.migrationSignature,f.op.signature);
  assert.deepEqual(saved.launches[0].burnReceipt,f.receipt);assert.equal(saved.launches[0].migrationNotice,null);assert.deepEqual(saved.operations[0].trade,f.receipt.trade);
  const committed=structuredClone(saved);await f.service.reconcile(f.session,{operationId:f.op.id},f.context);assert.deepEqual(f.stores.get('damm-pump'),committed);
  assert.equal((await f.service.analyticsTrades(f.launch.mint)).trades.length,1);assert.equal(f.sends,1);assert.equal(saved.operations.length,1);
});

test('an atomic final buy requires its own complete LP proof before any finalized state is saved',async t=>{
  const f=await atomicBuyFixture(t),before=structuredClone(f.stores.get('damm-pump'));
  for(const patch of [{phase:'bonded'},{signature:'another-signature'},{poolId:address()},{lpMint:address()},{issuedLpAtoms:'0',burnedLpAtoms:'0'},{burnedLpAtoms:'499999'},{retainedLpAtoms:'1'},{trade:{side:'sell'}}]){
    f.adapter.reconcile=async()=>({...f.receipt,...patch});
    await assert.rejects(f.service.reconcile(f.session,{operationId:f.op.id},f.context),/does not prove its reviewed atomic graduation/);
    assert.deepEqual(f.stores.get('damm-pump'),before);
  }
  f.adapter.reconcile=async()=>({...f.receipt,state:'confirmed'});await assert.rejects(f.service.reconcile(f.session,{operationId:f.op.id},f.context),/Only initialization supports early confirmation/);
  assert.deepEqual(f.stores.get('damm-pump'),before);
  f.adapter.reconcile=async()=>f.receipt;await f.service.reconcile(f.session,{operationId:f.op.id},f.context);assert.equal(f.stores.get('damm-pump').launches[0].migrationSignature,f.op.signature);
});

test('an atomic fee-controller final buy rejects missing, redirected, or arithmetically changed graduation fees',async t=>{
  const f=await atomicBuyFixture(t,{fee:true}),before=structuredClone(f.stores.get('damm-pump'));
  const changes=[{graduationFee:undefined},{graduationFee:{...f.receipt.graduationFee,verified:false}},{graduationFee:{...f.receipt.graduationFee,recipient:address()}},{graduationFee:{...f.receipt.graduationFee,quoteMint:address()}},{graduationFee:{...f.receipt.graduationFee,signature:'other'}},{graduationFeeRaw:'1'},{grossQuoteRaw:'999999999'},{poolQuoteRaw:'677630928'}];
  for(const patch of changes){f.adapter.reconcile=async()=>({...f.receipt,...patch});await assert.rejects(f.service.reconcile(f.session,{operationId:f.op.id},f.context),/does not prove its reviewed graduation fee/);assert.deepEqual(f.stores.get('damm-pump'),before);}
});

test('an ordinary buy observing a subsequently migrated pool cannot claim that migration receipt',async t=>{
  const f=await atomicBuyFixture(t,{atomic:false});f.adapter.reconcile=async()=>f.receipt;
  const complete=await f.service.reconcile(f.session,{operationId:f.op.id},f.context),saved=f.stores.get('damm-pump');
  assert.equal(complete.launch.status,'migrated');assert.equal(saved.launches[0].migrationSignature,undefined);assert.equal(saved.launches[0].burnReceipt,undefined);assert.deepEqual(saved.operations[0].trade,f.receipt.trade);
});

test('interrupted atomic final buys retain the exact wallet-signed wire and require the original account for receipt access',async t=>{
  const f=await atomicBuyFixture(t),other={...f.session,account:{id:'other'}};
  await assert.rejects(f.service.reconcile(other,{operationId:f.op.id},{...f.context,authorize:async()=>other}),/Saved transaction not found/);
  f.adapter.reconcile=async()=>({state:'pending',canRebroadcast:true});f.setNow(1790000016000);
  const restarted=new DammPumpService({...f.service});restarted.closed=true;
  await restarted.reconcile(f.session,{operationId:f.op.id},f.context);assert.equal(f.sends,2);assert.equal(f.stores.get('damm-pump').operations[0].signedTransaction,f.wire);assert.equal(f.stores.get('damm-pump').operations.length,1);
  f.adapter.reconcile=async()=>f.receipt;await restarted.reconcile(f.session,{operationId:f.op.id},f.context);assert.equal(f.stores.get('damm-pump').launches[0].migrationSignature,f.op.signature);assert.equal(f.sends,2);
});

test('atomic graduation cannot be substituted into configuration or a sell review',async t=>{
  const f=await fixture(t),base=f.adapter.prepare;f.adapter.prepare=async(...args)=>({...await base(...args),atomicGraduation:true});
  await assert.rejects(f.service.prepare(f.session,f.input,f.context),/Only the requested buy/);assert.equal(f.stores.get('damm-pump').operations.length,0);
  f.adapter.prepare=base;await f.service.prepare(f.session,f.input,f.context);const saved=f.stores.get('damm-pump');saved.operations=[];saved.launches[0].status='trading';
  f.adapter.prepare=async(...args)=>({...await base(...args),atomicGraduation:true});
  await assert.rejects(f.service.prepare(f.session,{action:'sell',mint:saved.launches[0].mint,expectedWallet:wallet.publicKey.toBase58(),amountRaw:'1'},f.context),/Only the requested buy/);assert.equal(saved.operations.length,0);
});

test('a confirmed endpoint only schedules migration and leaves phase and fee accounting for its finalized receipt',async t=>{
  const f=await fixture(t);await f.service.prepare(f.session,f.input,f.context);const saved=f.stores.get('damm-pump');saved.operations=[];
  Object.assign(saved.launches[0],{status:'trading',confirmationStatus:'finalized'});f.service.closed=false;t.after(()=>{f.service.closed=true;});
  f.adapter.state=async()=>({phase:'trading'});f.adapter.graduationReady=async()=>true;
  f.adapter.feesReady=async()=>{throw Error('Endpoint graduation must precede a fee collection');};
  let snapshot=await f.service.load();await f.service.graduateCandidate(snapshot,snapshot.launches[0]);
  let data=f.stores.get('damm-pump'),op=data.operations[0];assert.equal(f.sends,1);assert.equal(op.action,'migrate');assert.equal(data.launches[0].status,'trading');assert.equal(data.launches[0].migrationSignature,undefined);assert.equal(data.launches[0].burnReceipt,undefined);assert.match(data.launches[0].migrationNotice,/waiting for its finalized receipt/);assert(f.savedBeforeSend);
  f.setNow(1790000016000);snapshot=await f.service.load();await f.service.graduateCandidate(snapshot,snapshot.launches[0]);assert.equal(f.sends,1);assert.equal(f.stores.get('damm-pump').operations.length,1,'A pending migration cannot produce another transaction');
  f.adapter.reconcile=async()=>({state:'finalized',signature:op.signature,phase:'migrated',poolId:address()});await f.service.receiptOutsideLock(await f.service.load(),op);
  data=f.stores.get('damm-pump');assert.equal(data.launches[0].status,'migrated');assert.equal(data.launches[0].migrationSignature,op.signature);assert.equal(data.launches[0].migrationNotice,null);
});

test('a confirmed endpoint cannot bypass failed simulation or create an automatic buy',async t=>{
  const f=await fixture(t);await f.service.prepare(f.session,f.input,f.context);const saved=f.stores.get('damm-pump');saved.operations=[];
  Object.assign(saved.launches[0],{status:'trading',confirmationStatus:'finalized'});f.service.closed=false;t.after(()=>{f.service.closed=true;});
  f.adapter.state=async()=>({phase:'trading'});f.adapter.graduationReady=async()=>true;let prepares=0;
  f.adapter.prepare=async(_config,args)=>{prepares++;assert.equal(args.action,'migrate');assert.equal(args.amountRaw,undefined);assert.equal(args.wallet,relayer.publicKey.toBase58());throw Error('The confirmed endpoint rolled back before simulation');};
  const snapshot=await f.service.load();await f.service.graduateCandidate(snapshot,snapshot.launches[0]);
  assert.equal(prepares,1);assert.equal(f.sends,0);assert.equal(f.stores.get('damm-pump').operations.length,0);assert.equal(f.stores.get('damm-pump').launches[0].status,'trading');assert.equal(f.stores.get('damm-pump').launches[0].migrationSignature,undefined);
});

test('only an explicit confirmed endpoint hint triggers early migration and migrated pools never use that hint',async t=>{
  const f=await fixture(t);await f.service.prepare(f.session,f.input,f.context);const saved=f.stores.get('damm-pump');saved.operations=[];
  Object.assign(saved.launches[0],{status:'trading',confirmationStatus:'finalized'});f.service.closed=false;t.after(()=>{f.service.closed=true;});f.adapter.state=async()=>({phase:'trading'});
  let prepares=0,hints=0;f.adapter.prepare=async()=>{prepares++;throw Error('No transaction should be prepared');};
  for(const value of [false,null,{ready:true},'true']){f.adapter.graduationReady=async()=>{hints++;return value;};const snapshot=await f.service.load();await f.service.graduateCandidate(snapshot,snapshot.launches[0]);}
  assert.equal(hints,4);assert.equal(prepares,0);assert.equal(f.sends,0);
  f.adapter.state=async()=>({phase:'migrated',poolId:address()});f.adapter.graduationReady=async()=>{throw Error('Migrated pools must not use the early endpoint hint');};const snapshot=await f.service.load();await f.service.graduateCandidate(snapshot,snapshot.launches[0]);assert.equal(f.stores.get('damm-pump').launches[0].status,'migrated');assert.equal(prepares,0);
});

async function graduationFinishFixture(t){
  const f=await fixture(t);Object.assign(f.pair,{mint:DAMM_PUMP_SOL,decimals:9,symbol:'SOL'});f.service.getQuotePrice=async()=>({mint:DAMM_PUMP_SOL,usd:150,at:f.service.now()});
  await f.service.prepare(f.session,{...f.input,quoteMint:DAMM_PUMP_SOL},f.context);const saved=f.stores.get('damm-pump');saved.operations=[];Object.assign(saved.launches[0],{status:'trading',confirmationStatus:'finalized'});
  f.service.closed=false;t.after(()=>f.service.stop());f.adapter.state=async()=>({phase:'trading'});f.adapter.graduationReady=async()=>false;f.adapter.balance=async()=>'1000000000';
  const plan={amountRaw:'250000000',maxAmountRaw:'250000000',maxFinishSolLamports:'250000000',expectedSpendRaw:'50000000',remainingQuoteRaw:'49375000',expectedQuoteRaw:'200000000000',quoteMint:DAMM_PUMP_SOL,quoteDecimals:9,slot:123};
  f.adapter.graduationFinishQuote=async()=>plan;
  const prepared=[];
  f.adapter.prepare=async(_config,args)=>{
    prepared.push(args);assert.equal(args.action,'buy');assert.equal(args.wallet,relayer.publicKey.toBase58());assert.equal(args.amountRaw,'250000000');
    const ix=new TransactionInstruction({programId:program,keys:[{pubkey:relayer.publicKey,isSigner:true,isWritable:true}],data:Buffer.from([6])}),tx=new VersionedTransaction(new TransactionMessage({payerKey:relayer.publicKey,recentBlockhash:address(),instructions:[ix]}).compileToV0Message());
    return {action:'buy',needsRelayer:false,atomicGraduation:true,unsignedTransaction:Buffer.from(tx.serialize()).toString('base64'),amountRaw:args.amountRaw,trade:{side:'buy',input:args.amountRaw,charged:'50000000'},addresses:{pool:address(),lpMint:address()},review:{maxQuoteDebitRaw:args.amountRaw,expectedQuoteDebitRaw:'50000000',maxWalletDebitLamports:'275000000'}};
  };
  const receipt=op=>({state:'finalized',signature:op.signature,phase:'migrated',poolId:op.bundle.addresses.pool,lpMint:op.bundle.addresses.lpMint,issuedLpAtoms:'12345',burnedLpAtoms:'12345',retainedLpAtoms:'0',trade:{side:'buy',quoteRaw:'50000000',amountRaw:'90000000',venue:'damm-v2'}});
  const run=async()=>{const snapshot=await f.service.load();return f.service.graduateCandidate(snapshot,snapshot.launches[0]);};
  return {...f,plan,prepared,receipt,run,get sends(){return f.sends;},get savedBeforeSend(){return f.savedBeforeSend;}};
}

test('the automatic SOL finisher journals the existing relayer signed atomic buy and records only its finalized migration',async t=>{
  const f=await graduationFinishFixture(t);await f.run();const saved=f.stores.get('damm-pump'),op=saved.operations[0];
  assert(f.savedBeforeSend);assert.equal(f.sends,1);assert.equal(op.action,'buy');assert.equal(op.ownerId,null);assert.equal(op.purpose,'graduation-finish');assert.equal(op.wallet,relayer.publicKey.toBase58());assert.equal(op.finishPlan.maxFinishSolLamports,'250000000');assert.equal(saved.launches[0].status,'trading');
  const wire=op.signedTransaction,tx=VersionedTransaction.deserialize(Buffer.from(wire,'base64'));assert.equal(tx.message.header.numRequiredSignatures,1);assert.equal(tx.message.staticAccountKeys[0].toBase58(),relayer.publicKey.toBase58());assert.notEqual(op.wallet,saved.launches[0].creatorWallet);
  f.adapter.reconcile=async(_config,current)=>f.receipt(current);await f.service.receiptOutsideLock(await f.service.load(),op);
  const complete=f.stores.get('damm-pump');assert.equal(complete.launches[0].status,'migrated');assert.equal(complete.launches[0].migrationSignature,op.signature);assert.equal(complete.operations[0].trade.quoteRaw,'50000000');assert.equal(complete.operations[0].signedTransaction,wire);
  assert.equal((await f.service.analyticsTrades(op.mint)).trades[0].wallet,relayer.publicKey.toBase58());assert.equal(f.prepared.length,1);assert.equal(f.sends,1);
});

test('automatic finishing rejects amounts above 0.25 SOL, non-atomic packets, changed quote budgets and failed simulation without signing',async t=>{
  const f=await graduationFinishFixture(t),launch=(await f.service.load()).launches[0],base=f.adapter.prepare;
  await assert.rejects(f.service.automaticTransaction(await f.service.load(),launch,'buy',{finishQuote:{...f.plan,expectedSpendRaw:'250000001'}}),/0.25 SOL/);assert.equal(f.prepared.length,0);
  for(const patch of [{atomicGraduation:false},{needsRelayer:true},{amountRaw:'250000001'},{review:{maxQuoteDebitRaw:'250000001',expectedQuoteDebitRaw:'50000000',maxWalletDebitLamports:'275000000'}},{review:{maxQuoteDebitRaw:'250000000',expectedQuoteDebitRaw:'250000001',maxWalletDebitLamports:'300000000'}}]){
    f.adapter.prepare=async(...args)=>({...await base(...args),...patch});await assert.rejects(f.service.automaticTransaction(await f.service.load(),launch,'buy',{finishQuote:f.plan}),/bounded atomic/);
  }
  f.adapter.prepare=async()=>{throw Error('Atomic simulation failed');};await assert.rejects(f.service.automaticTransaction(await f.service.load(),launch,'buy',{finishQuote:f.plan}),/simulation failed/);
  assert.equal(f.sends,0);assert.equal(f.stores.get('damm-pump').operations.length,0);assert.equal(f.stores.get('damm-pump').launches[0].status,'trading');
});

test('automatic finishing leaves non-SOL pairs and costs outside the window untouched',async t=>{
  const f=await graduationFinishFixture(t);f.adapter.graduationFinishQuote=async()=>null;await f.run();assert.equal(f.prepared.length,0);assert.equal(f.sends,0);
  const saved=f.stores.get('damm-pump');saved.launches[0].quoteMint=quote;saved.launches[0].quoteDecimals=6;f.adapter.graduationFinishQuote=async()=>{throw Error('Non-SOL pairs cannot use the automatic SOL budget');};await f.run();assert.equal(f.prepared.length,0);assert.equal(f.sends,0);assert.equal(saved.operations.length,0);
});

test('insufficient unreserved SOL leaves the launch trading with a funding notice and can resume after funding',async t=>{
  const f=await graduationFinishFixture(t);f.adapter.balance=async()=>'300000000';await f.run();assert.equal(f.sends,0);assert.equal(f.stores.get('damm-pump').operations.length,0);assert.equal(f.stores.get('damm-pump').launches[0].status,'trading');assert.match(f.stores.get('damm-pump').launches[0].migrationNotice,/0.03 SOL gas reserve/);
  f.adapter.balance=async()=>'1000000000';f.setNow(1790000030001);await f.run();assert.equal(f.sends,1);assert.equal(f.stores.get('damm-pump').operations[0].purpose,'graduation-finish');
});

test('concurrent finish attempts journal once per coin and reserve wallet debits across different coins',async t=>{
  const f=await graduationFinishFixture(t);f.adapter.balance=async()=>'400000000';let snapshot=await f.service.load();await Promise.all([f.service.automaticTransaction(snapshot,snapshot.launches[0],'buy',{finishQuote:f.plan}),f.service.automaticTransaction(snapshot,snapshot.launches[0],'buy',{finishQuote:f.plan})]);assert.equal(f.sends,1);assert.equal(f.stores.get('damm-pump').operations.length,1);
  const saved=f.stores.get('damm-pump');saved.operations=[];saved.launches[0].retryAt=0;saved.launches.push({...structuredClone(saved.launches[0]),id:address(),mint:address()});snapshot=await f.service.load();
  const outcomes=await Promise.all(snapshot.launches.map(launch=>f.service.automaticTransaction(snapshot,launch,'buy',{finishQuote:f.plan})));assert.deepEqual(outcomes.map(row=>row.state).sort(),['requested','skipped']);assert.equal(f.stores.get('damm-pump').operations.length,1);assert.match(outcomes.find(row=>row.state==='skipped').notice,/reserved by other saved transactions/);assert.equal(f.sends,2);
});

test('pending standalone migration and fee claims reserve gas against automatic finishing',async t=>{
  const f=await graduationFinishFixture(t);f.adapter.balance=async()=>'350000000';
  for(const action of ['migrate','protocol-fees']){const saved=f.stores.get('damm-pump');saved.operations=[{id:address(),mint:address(),wallet:relayer.publicKey.toBase58(),action,state:'pending',bundle:{review:{maxWalletDebitLamports:'50000000'}}}];const snapshot=await f.service.load(),result=await f.service.automaticTransaction(snapshot,snapshot.launches[0],'buy',{finishQuote:f.plan});assert.equal(result.state,'skipped');assert.equal(f.sends,0);assert.equal(saved.operations.length,1);}
});

test('a reservation finalized during preparation cannot reuse its stale pre-spend SOL balance',async t=>{
  const f=await graduationFinishFixture(t),saved=f.stores.get('damm-pump'),base=f.adapter.prepare;let finalized=false,balanceReads=0;
  saved.operations=[{id:address(),mint:address(),wallet:relayer.publicKey.toBase58(),action:'migrate',state:'pending',bundle:{review:{maxWalletDebitLamports:'700000000'}}}];
  f.adapter.balance=async()=>{balanceReads++;return finalized?'300000000':'1000000000';};
  f.adapter.prepare=async(...args)=>{const bundle=await base(...args);saved.operations[0].state='finalized';finalized=true;return bundle;};
  const snapshot=await f.service.load(),result=await f.service.automaticTransaction(snapshot,snapshot.launches[0],'buy',{finishQuote:f.plan});assert.equal(result.state,'skipped');assert.equal(balanceReads,2);assert.equal(f.sends,0);assert.equal(f.stores.get('damm-pump').operations.length,1);assert.equal(f.stores.get('damm-pump').operations[0].state,'finalized');
});

test('uncertain automatic finishing retries only its saved signed wire and refuses an over-budget finalized receipt',async t=>{
  const f=await graduationFinishFixture(t);await f.run();const op=f.stores.get('damm-pump').operations[0],wire=op.signedTransaction;f.setNow(1790000016000);f.adapter.reconcile=async()=>({state:'pending',canRebroadcast:true});
  const restarted=new DammPumpService({...f.service});restarted.closed=true;await restarted.receiptOutsideLock(await restarted.load(),op);assert.equal(f.sends,2);assert.equal(f.stores.get('damm-pump').operations[0].signedTransaction,wire);assert.equal(f.prepared.length,1);
  f.adapter.reconcile=async()=>({...f.receipt(op),trade:{side:'buy',amountRaw:'1',quoteRaw:'250000001'}});await assert.rejects(restarted.receiptOutsideLock(await restarted.load(),f.stores.get('damm-pump').operations[0]),/0.25 SOL/);assert.equal(f.stores.get('damm-pump').launches[0].status,'trading');assert.equal(f.stores.get('damm-pump').launches[0].migrationSignature,undefined);
  f.adapter.reconcile=async()=>f.receipt(op);await restarted.receiptOutsideLock(await restarted.load(),f.stores.get('damm-pump').operations[0]);assert.equal(f.stores.get('damm-pump').launches[0].migrationSignature,op.signature);assert.equal(f.prepared.length,1);
});

test('pool hints arriving during a busy worker are retained and coalesced while normal receipt work still runs',async t=>{
  const f=await graduationFinishFixture(t);let onHint,closed=0,synced=[],ticks=0;const tick=f.service.tick.bind(f.service);f.service.tick=async()=>{ticks++;return tick();};f.service.graduationWatcherFactory=options=>{onHint=options.onHint;return {sync:rows=>{synced=rows;},close:async()=>{closed++;}};};
  f.adapter.graduationFinishQuote=async()=>null;f.service.start();await f.service.running;await Promise.resolve();assert.equal(synced.length,1);assert.equal(synced[0].config.programId,program.toBase58());
  f.adapter.graduationFinishQuote=async()=>f.plan;const base=f.adapter.prepare;let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});f.adapter.prepare=async(...args)=>{entered();await gate;return base(...args);};
  const mint=synced[0].launch.mint;onHint({mint,slot:124});await started;
  for(let i=0;i<12;i++)onHint({mint,slot:125+i});assert.deepEqual([...f.service.graduationHints],[mint]);f.service.kick();f.setNow(1790000001001);release();await f.service.running;
  assert.equal(f.prepared.length,1);assert.equal(f.sends,1);assert.equal(f.stores.get('damm-pump').operations.length,1);assert.equal(f.service.graduationHints.size,0);assert.equal(ticks,2,'A requested normal tick runs despite queued hints');
  await f.service.stop();assert.equal(closed,1);assert.equal(f.service.graduationHintTimer,null);onHint({mint,slot:150});assert.equal(f.service.graduationHints.size,0);
});

test('repeated failing pool hints are throttled for a second and stopping clears the retained retry',async t=>{
  const f=await graduationFinishFixture(t),mint=f.stores.get('damm-pump').launches[0].mint;let attempts=0;f.adapter.prepare=async()=>{attempts++;throw Error('Simulation rejected a changed endpoint');};
  f.service.queueGraduationHint({mint,slot:123});await f.service.running;assert.equal(attempts,1);
  for(let i=0;i<10;i++)f.service.queueGraduationHint({mint,slot:124+i});await f.service.running;assert.equal(attempts,1);assert.equal(f.service.graduationHints.size,1);assert(f.service.graduationHintTimer);
  f.setNow(1790000001001);f.service.kick({hintOnly:true});await f.service.running;assert.equal(attempts,2);assert.equal(f.sends,0);assert.equal(f.stores.get('damm-pump').operations.length,0);
  f.service.queueGraduationHint({mint,slot:140});await f.service.running;await f.service.stop();assert.equal(f.service.graduationHints.size,0);assert.equal(f.service.graduationHintTimer,null);
});

test('verified DAMM inventory and reserve custody are classified as liquidity, not an arbitrary holder',()=>{
  const mint=Keypair.generate().publicKey,a=dammAddresses({mint,quoteMint:quote}),record={curve:a.dammPool.toBase58(),input:{route:'damm-pump',network:'mainnet-beta',quoteMint:quote},review:{publicProgramId:a.program.toBase58(),custodyAuthority:a.authority.toBase58(),stateAddress:a.state.toBase58(),quoteProgram:TOKEN_PROGRAM_ID.toBase58(),poolId:a.pool.toBase58()},keys:{mint:{address:mint.toBase58()},wallet:{address:a.authority.toBase58()}}};
  const vaults=holderLpVaults(mint,record);assert.equal(vaults.size,3);assert.equal(vaults.get(a.baseAta.toBase58()).authority,a.authority.toBase58());assert.equal(vaults.get(a.dammBaseVault.toBase58()).authority,a.dammAuthority.toBase58());
  record.keys.wallet.address=address();assert.equal(holderLpVaults(mint,record).size,0);
});


test('restart recovery resends only the exact durable wire when its absent receipt permits retry',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context);
  await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:f.sign(review.operation)},f.context);
  const op=f.stores.get('damm-pump').operations[0],wire=op.signedTransaction;op.state='journaled';
  f.adapter.reconcile=async()=>({state:'pending',canRebroadcast:true});f.setNow(1790000016000);
  const restarted=new DammPumpService({...f.service});restarted.closed=true;
  await restarted.reconcile(f.session,{operationId:op.id},f.context);
  assert.equal(f.sends,2);assert.equal(f.stores.get('damm-pump').operations[0].signedTransaction,wire);
  await restarted.reconcile(f.session,{operationId:op.id},f.context);assert.equal(f.sends,2,'Retries are paced');
  f.setNow(1790000032000);f.adapter.reconcile=async()=>({state:'pending',canRebroadcast:false});
  await restarted.reconcile(f.session,{operationId:op.id},f.context);assert.equal(f.sends,2,'An observed pending confirmation is not rebroadcast');
  f.adapter.reconcile=async()=>({state:'expired'});await restarted.reconcile(f.session,{operationId:op.id},f.context);assert.equal(f.sends,2);
});

test('restart recovery rejects changed signed bytes before any rebroadcast',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context);
  await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:f.sign(review.operation)},f.context);
  const op=f.stores.get('damm-pump').operations[0],tx=VersionedTransaction.deserialize(Buffer.from(op.signedTransaction,'base64'));tx.message.compiledInstructions[0].data[0]=9;tx.sign([wallet]);op.signedTransaction=Buffer.from(tx.serialize()).toString('base64');
  f.adapter.reconcile=async()=>({state:'pending',canRebroadcast:true});f.setNow(1790000016000);
  await assert.rejects(f.service.reconcile(f.session,{operationId:op.id},f.context),/original review/);assert.equal(f.sends,1);
});

test('owner manual fee sweep bypasses amount threshold once and deduplicates uncertain claims',async t=>{
  const f=await fixture(t);await f.service.prepare(f.session,f.input,f.context);
  const saved=f.stores.get('damm-pump');saved.operations=[];saved.launches[0].status='migrated';saved.launches[0].confirmationStatus='finalized';
  f.adapter.state=async()=>({phase:'migrated'});f.adapter.pendingProtocolFees=async()=> '1';f.adapter.feesReady=async()=>{throw Error('Manual claims do not change or depend on the automatic threshold');};f.adapter.balance=async()=>'100000000';
  await assert.rejects(f.service.claimFees(f.session,{},f.context),/not owner/);assert.equal(f.sends,0);
  f.service.requireOwner=async()=>{};
  await assert.rejects(f.service.claimFees(f.session,{minimumUsd:0},f.context),/Unsupported/);
  const first=await f.service.claimFees(f.session,{},f.context);assert.deepEqual([first.scanned,first.requested,first.skipped,first.pending],[1,1,0,0]);assert.equal(f.sends,1);assert.equal(first.operations.length,1);
  const second=await f.service.claimFees(f.session,{},f.context);assert.deepEqual([second.requested,second.pending],[0,1]);assert.equal(f.sends,1);
  assert.equal(f.stores.get('damm-pump').launches[0].nextFeeCheckAt,undefined,'Manual execution does not persist a dust collection policy');
});

test('fee claims preserve graduation gas and skip zero amounts and bonded launch migration',async t=>{
  const f=await fixture(t);await f.service.prepare(f.session,f.input,f.context);
  const saved=f.stores.get('damm-pump');saved.operations=[];saved.launches[0].status='trading';saved.launches[0].confirmationStatus='finalized';
  f.service.requireOwner=async()=>{};f.adapter.state=async()=>({phase:'trading'});f.adapter.pendingProtocolFees=async()=> '1';
  let result=await f.service.claimFees(f.session,{},f.context);assert.equal(result.skipped,1);assert.match(result.notices[0].notice,/gas/);assert.equal(f.sends,0);
  f.adapter.balance=async()=>'30004999';result=await f.service.claimFees(f.session,{},f.context);assert.equal(result.skipped,1);assert.equal(f.sends,0);
  f.adapter.balance=async()=>'100000000';f.adapter.pendingProtocolFees=async()=> '0';result=await f.service.claimFees(f.session,{},f.context);assert.equal(result.skipped,1);assert.equal(f.sends,0);
  f.adapter.state=async()=>({phase:'bonded'});f.adapter.pendingProtocolFees=async()=>{throw Error('Bonded launch must migrate first');};result=await f.service.claimFees(f.session,{},f.context);assert.equal(result.skipped,1);assert.equal(f.sends,0);
});

async function solFixture(t,{fallback=false,solLamports='100000000'}={}){
  const f=await fixture(t),basePrepare=f.adapter.prepare,calls=[];let fallbackMode=fallback,minimumRaw='990001';
  f.adapter.prepare=async(config,args)=>{
    calls.push(structuredClone(args));
    if(args.launch.fundingMode!=='sol'||args.launch.quoteMint==='So11111111111111111111111111111111111111112')return basePrepare(config,args);
    const firstBuy=BigInt(args.launch.firstBuySolLamports)>0n;
    const plan={solLamports:firstBuy?args.launch.firstBuySolLamports:'100000',firstBuyRaw:firstBuy?String(BigInt(minimumRaw)-1n):'0',expectedRaw:String(BigInt(minimumRaw)+1000n),minimumRaw};
    const swapping=args.action==='fund-quote'||args.action==='initialize'&&args.launch.fundingStatus!=='finalized';
    const action=swapping&&fallbackMode?'fund-quote':args.action;
    const bundle=await basePrepare(config,{...args,action});
    bundle.review.maxWalletDebitLamports=args.action==='configure'?'5000':swapping?String(BigInt(plan.solLamports)+7000n):'9000';
    if(args.action==='initialize'&&!swapping)bundle.review.firstBuyRaw=args.amountRaw;
    if(args.action==='configure'||swapping)bundle.fundingPlan=plan;
    if(swapping){bundle.action=action;bundle.atomicQuoteFunding=action==='initialize';}
    return bundle;
  };
  f.adapter.reconcile=async(_config,op)=>op.action==='configure'?{state:'finalized',lookupTables:op.bundle.lookupTables}:op.action==='fund-quote'?{state:'finalized',funding:{...op.bundle.fundingPlan,receivedRaw:op.bundle.fundingPlan.minimumRaw}}:{state:'finalized',phase:'trading',...(op.bundle.atomicQuoteFunding?{funding:{...op.bundle.fundingPlan,receivedRaw:op.bundle.fundingPlan.minimumRaw}}:{})};
  const configured=await f.service.prepare(f.session,{...f.input,firstBuySolLamports:solLamports},f.context);
  const finalize=async review=>{await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:f.sign(review.operation)},f.context);return f.service.reconcile(f.session,{operationId:review.operation.id},f.context);};
  const setup=await finalize(configured);
  return {...f,calls,setup,finalize,next:extra=>f.service.prepare(f.session,{action:'initialize',mint:setup.launch.mint,expectedWallet:wallet.publicKey.toBase58(),...extra},f.context),setMinimum:value=>{minimumRaw=value;},setFallback:value=>{fallbackMode=value;}};
}

test('SOL-funded launch uses one combined conversion and initializer after saved configuration',async t=>{
  const f=await solFixture(t);assert.equal(f.setup.operation.nextAction,'initialize');
  const before=f.stores.get('damm-pump').launches[0];assert.equal(before.fundingMode,'sol');assert.equal(before.firstBuySolLamports,'100000000');assert.equal(before.firstBuyRaw,'990000');assert.equal(before.fundingStatus,undefined);
  f.setMinimum('980001');const launch=await f.next();assert.equal(launch.operation.action,'initialize');assert.equal(launch.operation.review.firstBuyRaw,'980000');assert.equal(launch.operation.review.totalLaunchMaxDebitLamports,'100012000');assert.equal(launch.operation.review.firstBuySolLamports,'100000000');
  const prepared=f.stores.get('damm-pump').operations.at(-1);assert.equal(prepared.bundle.atomicQuoteFunding,true);assert.equal(prepared.bundle.needsRelayer,true);assert.equal(f.stores.get('damm-pump').launches[0].fundingStatus,undefined);
  const complete=await f.finalize(launch);assert.equal(complete.launch.status,'trading');assert.equal(complete.operation.nextAction,undefined);
  const saved=f.stores.get('damm-pump').launches[0];assert.equal(saved.fundingStatus,'finalized');assert.equal(saved.fundingSignature,complete.operation.signature);assert.equal(saved.firstBuyRaw,'980000');assert.equal(saved.quoteFundingDebitLamports,undefined,'Atomic debit is counted once in initialization');assert.equal((await f.service.operations(f.session,f.context)).operations.length,0);
});

test('concrete fallback journals standalone funding once and resumes pure initialization after wallet decline',async t=>{
  const f=await solFixture(t,{fallback:true}),fund=await f.next();assert.equal(fund.operation.action,'fund-quote');assert.equal(f.stores.get('damm-pump').operations.at(-1).bundle.needsRelayer,false);
  const paid=await f.finalize(fund);assert.equal(paid.operation.nextAction,'initialize');assert.equal(paid.launch.status,'draft');
  const replay=await f.service.reconcile(f.session,{operationId:f.setup.operation.id},f.context);assert.equal(replay.operation.nextAction,'initialize','A stale configuration receipt cannot request another conversion');
  assert.equal((await f.service.operations(f.session,f.context)).operations[0].id,fund.operation.id);
  await assert.rejects(f.next({action:'fund-quote'}),/another quote funding/);
  await assert.rejects(f.next({firstBuySolLamports:'200000000'}),/budget cannot be changed/);
  await assert.rejects(f.next({amountRaw:'990001'}),/first buy cannot be changed/);
  const initialized=await f.next();assert.equal(initialized.operation.action,'initialize');assert.equal(f.stores.get('damm-pump').operations.at(-1).bundle.atomicQuoteFunding,undefined);assert.equal(initialized.operation.review.totalLaunchMaxDebitLamports,'100021000');assert.equal(initialized.operation.review.quoteFundingComplete,true);
  await f.service.cancel(f.session,{operationId:initialized.operation.id},f.context);assert.equal((await f.service.operations(f.session,f.context)).operations[0].id,fund.operation.id);
  const resumed=await f.next();await f.finalize(resumed);assert.equal(f.stores.get('damm-pump').operations.filter(o=>o.action==='fund-quote').length,1);assert.equal(f.stores.get('damm-pump').launches.length,1);
});

test('zero first buy funds only the reviewed seed budget while native SOL needs no swap',async t=>{
  const f=await solFixture(t,{solLamports:'0'});assert.equal(f.setup.operation.review.firstBuyRaw,'0');assert.equal(f.setup.operation.review.quoteFundingInLamports,'100000');const launch=await f.next();await f.finalize(launch);assert.equal(f.stores.get('damm-pump').launches[0].firstBuyRaw,'0');
  const native=await fixture(t),mint='So11111111111111111111111111111111111111112';Object.assign(native.pair,{mint,decimals:9,symbol:'SOL'});native.service.getQuotePrice=async()=>({mint,usd:200,at:1790000000000});
  const configured=await native.service.prepare(native.session,{...native.input,quoteMint:mint,firstBuySolLamports:'123456789'},native.context);assert.equal(configured.operation.review.firstBuyRaw,'123456789');assert.equal(configured.operation.review.quoteFundingInLamports,undefined);
  await native.service.submit(native.session,{operationId:configured.operation.id,signedTransaction:native.sign(configured.operation)},native.context);native.adapter.reconcile=async(_config,op)=>({state:'finalized',lookupTables:op.bundle.lookupTables});await native.service.reconcile(native.session,{operationId:configured.operation.id},native.context);
  const initialized=await native.service.prepare(native.session,{action:'initialize',mint:configured.launch.mint,expectedWallet:wallet.publicKey.toBase58()},native.context);assert.equal(initialized.operation.action,'initialize');assert.equal(initialized.operation.review.firstBuyRaw,'123456789');assert.equal(native.stores.get('damm-pump').operations.length,2);
});

test('SOL funding input cannot override trading amounts or use conflicting units',async t=>{
  const f=await fixture(t);
  for(const value of ['-1','01','1.5',1,'18446744073709551616'])await assert.rejects(f.service.prepare(f.session,{...f.input,firstBuySolLamports:value},f.context),/Invalid token/);
  await assert.rejects(f.service.prepare(f.session,{...f.input,firstBuySolLamports:'1',amountRaw:'1'},f.context),/one launch funding amount/);
  await assert.rejects(f.service.prepare(f.session,{action:'buy',mint:address(),expectedWallet:wallet.publicKey.toBase58(),firstBuySolLamports:'1'},f.context),/one launch funding amount/);
  await assert.rejects(f.service.prepare(f.session,{action:'protocol-fees',expectedWallet:wallet.publicKey.toBase58(),firstBuySolLamports:'1'},f.context),/Choose a launch/);
  assert.equal(f.stores.get('damm-pump').operations.length,0);
});

test('standalone conversion cannot be requested without a concrete initializer fallback',async t=>{
  const f=await solFixture(t);await assert.rejects(f.next({action:'fund-quote'}),/combined SOL conversion/);assert.equal(f.stores.get('damm-pump').operations.length,1);
  const prepare=f.adapter.prepare;f.adapter.prepare=async(...args)=>{const bundle=await prepare(...args);delete bundle.atomicQuoteFunding;return bundle;};await assert.rejects(f.next(),/omitted its SOL conversion/);assert.equal(f.stores.get('damm-pump').operations.length,1);
});

test('finalized funding receipt must prove the exact saved plan and minimum received amount',async t=>{
  const f=await solFixture(t,{fallback:true}),fund=await f.next();await f.service.submit(f.session,{operationId:fund.operation.id,signedTransaction:f.sign(fund.operation)},f.context);
  const saved=f.stores.get('damm-pump').operations.at(-1),plan=saved.bundle.fundingPlan;
  for(const funding of [undefined,{...plan,receivedRaw:'1'},{...plan,solLamports:'1',receivedRaw:plan.minimumRaw},{...plan,firstBuyRaw:'1',receivedRaw:plan.minimumRaw}]){
    f.adapter.reconcile=async()=>({state:'finalized',funding});await assert.rejects(f.service.reconcile(f.session,{operationId:fund.operation.id},f.context),/differs from the saved funding plan/);assert.equal(f.stores.get('damm-pump').launches[0].fundingStatus,undefined);assert.equal(f.stores.get('damm-pump').operations.at(-1).state,'pending');
  }
  f.adapter.reconcile=async()=>({state:'confirmed',funding:{...plan,receivedRaw:plan.minimumRaw}});await assert.rejects(f.service.reconcile(f.session,{operationId:fund.operation.id},f.context),/finalized wallet receipt/);
  f.adapter.reconcile=async()=>({state:'finalized',funding:{...plan,receivedRaw:plan.minimumRaw}});await f.service.reconcile(f.session,{operationId:fund.operation.id},f.context);assert.equal(f.stores.get('damm-pump').launches[0].fundingStatus,'finalized');
});

test('failed atomic launch leaves no conversion recorded and resumes the original mint and fixed budget',async t=>{
  const f=await solFixture(t),launch=await f.next();await f.service.submit(f.session,{operationId:launch.operation.id,signedTransaction:f.sign(launch.operation)},f.context);
  f.adapter.reconcile=async()=>({state:'failed'});await f.service.reconcile(f.session,{operationId:launch.operation.id},f.context);
  assert.equal(f.stores.get('damm-pump').launches[0].fundingStatus,undefined);assert.equal(f.stores.get('damm-pump').launches[0].status,'draft');assert.equal((await f.service.operations(f.session,f.context)).operations[0].id,f.setup.operation.id);
  const retry=await f.next();assert.equal(retry.launch.mint,launch.launch.mint);assert.equal(retry.operation.review.firstBuySolLamports,'100000000');assert.equal(f.stores.get('damm-pump').operations.at(-1).bundle.atomicQuoteFunding,true);
});

test('funded launch restores the funding predecessor after an unsigned review expires and after a failed initializer',async t=>{
  const f=await solFixture(t,{fallback:true}),fund=await f.next();await f.finalize(fund);
  const launch=await f.next();f.setNow(launch.operation.expiresAt+1);assert.equal((await f.service.operations(f.session,f.context)).operations[0].id,fund.operation.id);assert.equal(f.stores.get('damm-pump').operations.at(-1).state,'expired');
  f.service.getQuotePrice=async()=>({mint:quote,usd:25,at:launch.operation.expiresAt+1});const retry=await f.next();await f.service.submit(f.session,{operationId:retry.operation.id,signedTransaction:f.sign(retry.operation)},f.context);f.adapter.reconcile=async()=>({state:'failed'});await f.service.reconcile(f.session,{operationId:retry.operation.id},f.context);assert.equal((await f.service.operations(f.session,f.context)).operations[0].id,fund.operation.id);assert.equal(f.stores.get('damm-pump').launches[0].fundingStatus,'finalized');
});

test('restart retries only the exact signed standalone conversion and cannot prepare another swap while uncertain',async t=>{
  const f=await solFixture(t,{fallback:true}),fund=await f.next();await f.service.submit(f.session,{operationId:fund.operation.id,signedTransaction:f.sign(fund.operation)},f.context);const op=f.stores.get('damm-pump').operations.at(-1),wire=op.signedTransaction;
  await assert.rejects(f.next(),/saved transaction/);f.adapter.reconcile=async()=>({state:'pending',canRebroadcast:true});f.setNow(1790000016000);const restarted=new DammPumpService({...f.service});restarted.closed=true;await restarted.reconcile(f.session,{operationId:fund.operation.id},f.context);assert.equal(f.stores.get('damm-pump').operations.at(-1).signedTransaction,wire);assert.equal(f.stores.get('damm-pump').operations.filter(o=>o.action==='fund-quote').length,1);
  await assert.rejects(restarted.submit(f.session,{operationId:fund.operation.id,signedTransaction:f.sign(fund.operation)},{...f.context,sessionToken:'replacement-session'}),/another session/);
});

test('concurrent fallback preparations commit once and reject stale funded launch snapshots',async t=>{
  const f=await solFixture(t,{fallback:true}),prepare=f.adapter.prepare;let entered=0,release;const barrier=new Promise(resolve=>{release=resolve;});
  f.adapter.prepare=async(...args)=>{const value=await prepare(...args);if(++entered===2)release();await barrier;return value;};
  const values=await Promise.allSettled([f.next(),f.next()]);assert.equal(values.filter(value=>value.status==='fulfilled').length,1);assert.equal(values.filter(value=>value.status==='rejected').length,1);assert.equal(f.stores.get('damm-pump').operations.filter(o=>o.action==='fund-quote').length,1);
  const fund=values.find(value=>value.status==='fulfilled').value;await f.service.cancel(f.session,{operationId:fund.operation.id},f.context);
  f.adapter.prepare=async(...args)=>{const value=await prepare(...args);f.stores.get('damm-pump').launches[0].fundingStatus='finalized';return value;};await assert.rejects(f.next(),/changed while preparing/);assert.equal(f.stores.get('damm-pump').operations.filter(o=>o.action==='fund-quote').length,1);
});

test('funding preparation and submission fail closed on changed accounts, launch state and deployment',async t=>{
  const f=await solFixture(t,{fallback:true}),prepare=f.adapter.prepare;
  f.adapter.prepare=async(...args)=>{const value=await prepare(...args);f.stores.get('damm-pump').config.expectedDeploymentSlot='new';return value;};await assert.rejects(f.next(),/[Dd]eployment.*changed/);delete f.stores.get('damm-pump').config.expectedDeploymentSlot;f.adapter.prepare=prepare;
  const fund=await f.next(),wire=f.sign(fund.operation);f.stores.get('damm-pump').launches[0].firstBuyRaw='1';await assert.rejects(f.service.submit(f.session,{operationId:fund.operation.id,signedTransaction:wire},f.context),/saved launch changed/);assert.equal(f.stores.get('damm-pump').operations.at(-1).signedTransaction,undefined);
  const g=await solFixture(t,{fallback:true}),base=g.adapter.prepare;g.adapter.prepare=async(...args)=>{const value=await base(...args);g.context.authorize=async()=>({...g.session,account:{id:'other'}});return value;};await assert.rejects(g.next(),/account changed/);assert.equal(g.stores.get('damm-pump').operations.length,1);
});

test('funding remains gated by new-launch readiness and never enters public fee collection',async t=>{
  const f=await solFixture(t,{fallback:true}),fund=await f.next();f.adapter.verifyDeployment=async()=>({enabled:false});await assert.rejects(f.service.submit(f.session,{operationId:fund.operation.id,signedTransaction:f.sign(fund.operation)},f.context),/disabled on chain/);assert.equal(f.stores.get('damm-pump').operations.at(-1).signedTransaction,undefined);
  f.service.requireOwner=async()=>{};f.adapter.verifyDeployment=async()=>({enabled:true});const sweep=await f.service.claimFees(f.session,{},f.context);assert.equal(sweep.scanned,0);assert.equal(f.stores.get('damm-pump').operations.length,2);
});

test('a new authenticated session replaces only unsigned launch reviews and preserves funded or uncertain conversions',async t=>{
  const f=await solFixture(t,{fallback:true}),fund=await f.next();await f.finalize(fund);const initialized=await f.next();
  const context={...f.context,sessionToken:'new-authenticated-session'};const restored=await f.service.operations(f.session,context);assert.equal(restored.operations.length,1);assert.equal(restored.operations[0].id,fund.operation.id);assert.equal(f.stores.get('damm-pump').operations.find(o=>o.id===initialized.operation.id).state,'cancelled');
  const resumed=await f.service.prepare(f.session,{action:'initialize',mint:fund.launch.mint,expectedWallet:wallet.publicKey.toBase58()},context);assert.equal(resumed.operation.review.quoteFundingComplete,true);assert.equal(f.stores.get('damm-pump').operations.at(-1).bundle.atomicQuoteFunding,undefined);
  const g=await solFixture(t,{fallback:true}),pending=await g.next();await g.service.submit(g.session,{operationId:pending.operation.id,signedTransaction:g.sign(pending.operation)},g.context);g.adapter.reconcile=async()=>({state:'pending'});
  const pendingContext={...g.context,sessionToken:'replacement-session'},operations=await g.service.operations(g.session,pendingContext);assert.equal(operations.operations[0].id,pending.operation.id);assert.equal(operations.operations[0].state,'pending');await g.service.reconcile(g.session,{operationId:pending.operation.id},pendingContext);assert.equal(g.stores.get('damm-pump').operations.at(-1).state,'pending');
});

test('atomic launch records funding only at finalization and tolerates an earlier confirmed launch state',async t=>{
  const f=await solFixture(t),launch=await f.next();await f.service.submit(f.session,{operationId:launch.operation.id,signedTransaction:f.sign(launch.operation)},f.context);const plan=f.stores.get('damm-pump').operations.at(-1).bundle.fundingPlan;
  f.adapter.reconcile=async()=>({state:'confirmed',phase:'trading'});await f.service.reconcile(f.session,{operationId:launch.operation.id},f.context);assert.equal(f.stores.get('damm-pump').launches[0].status,'trading');assert.equal(f.stores.get('damm-pump').launches[0].fundingStatus,undefined);
  f.adapter.reconcile=async()=>({state:'finalized',phase:'trading',funding:{...plan,receivedRaw:plan.minimumRaw}});await f.service.reconcile(f.session,{operationId:launch.operation.id},f.context);assert.equal(f.stores.get('damm-pump').launches[0].fundingStatus,'finalized');
});

test('a funded fallback can reduce its reviewed first buy after repricing without changing its original conversion or SOL budget',async t=>{
  const f=await solFixture(t,{fallback:true}),fund=await f.next();await f.finalize(fund);
  const funded=structuredClone(f.stores.get('damm-pump').launches[0]),basePrepare=f.adapter.prepare;let cap='900000';
  f.adapter.prepare=async(...args)=>{const bundle=await basePrepare(...args);if(args[1].action==='initialize'){assert.equal(args[1].launch.fundingStatus,'finalized');assert.equal(bundle.atomicQuoteFunding,undefined);bundle.review.firstBuyRaw=cap;}return bundle;};
  f.service.getQuotePrice=async()=>({mint:quote,usd:30,at:1790000000000});const reduced=await f.next();assert.equal(reduced.operation.action,'initialize');assert.equal(reduced.operation.review.firstBuyRaw,'900000');assert.equal(reduced.operation.review.quoteUsd,'30');assert.equal(reduced.operation.review.firstBuySolLamports,'100000000');
  let saved=f.stores.get('damm-pump').launches[0];assert.equal(saved.firstBuyRaw,'900000');assert.deepEqual(saved.fundingPlan,funded.fundingPlan);assert.deepEqual(saved.fundingReceipt,funded.fundingReceipt);assert.equal(saved.fundingSignature,funded.fundingSignature);assert.equal(saved.quoteFundingDebitLamports,funded.quoteFundingDebitLamports);
  await f.service.cancel(f.session,{operationId:reduced.operation.id},f.context);
  cap='950000';await assert.rejects(f.next(),/increased or changed/);assert.equal(f.stores.get('damm-pump').launches[0].firstBuyRaw,'900000','Even a value below the original maximum cannot increase a later reviewed buy');
  cap='850000';const retry=await f.next();await f.finalize(retry);saved=f.stores.get('damm-pump').launches[0];assert.equal(saved.firstBuyRaw,'850000');assert.deepEqual(saved.fundingPlan,funded.fundingPlan);assert.deepEqual(saved.fundingReceipt,funded.fundingReceipt);assert.equal(f.stores.get('damm-pump').operations.filter(o=>o.action==='fund-quote').length,1);
});

const configHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function feeController(f){
  const legacy=structuredClone(f.stores.get('damm-pump').config),next={...legacy,programId:address(),expectedDeploymentSlot:'12345'};
  const defaults={...DAMM_PUMP_DEFAULTS,graduationFeeBps:3223.69073,graduationFeeNumerator:'322369073',graduationFeeDenominator:'1000000000'};
  f.adapter.supportsNewLaunch=config=>config?.programId===next.programId;
  f.adapter.launchTerms=config=>({policyVersion:config?.programId===next.programId?'fee-v2':'legacy-v1',defaults:config?.programId===next.programId?defaults:DAMM_PUMP_DEFAULTS});
  return {legacy,next,defaults};
}

test('fee controller installation preserves exact legacy bindings, operation fingerprints and relayer secrets',async t=>{
  const f=await solFixture(t,{fallback:true});await f.finalize(await f.next());
  // Simulate the pre-upgrade encrypted row: it has no new snapshot fields.
  const original=f.stores.get('damm-pump');for(const key of ['controllerConfig','launchDefaults','feePolicyVersion'])delete original.launches[0][key];
  const init=await f.next(),before=structuredClone(f.stores.get('damm-pump')),{legacy,next}=feeController(f);
  await f.service.installDeployment(next);
  const after=f.stores.get('damm-pump');assert.deepEqual(after.relayer,before.relayer);assert.deepEqual(after.launches,before.launches);assert.deepEqual(after.operations,before.operations);
  assert.deepEqual(after.controllerConfigs[configHash(legacy)],legacy);assert.equal(after.launchBindings[init.launch.mint],configHash(legacy));assert.equal(after.config.programId,next.programId);
  const prepared=[];const oldPrepare=f.adapter.prepare;f.adapter.prepare=async(config,args)=>{prepared.push(config.programId);return oldPrepare(config,args);};
  const complete=await f.finalize(init);assert.equal(complete.launch.status,'trading');assert.equal(complete.launch.graduationFeeBps,0);assert.equal(complete.launch.publicProgramId,legacy.programId);
  assert.equal(f.stores.get('damm-pump').operations.filter(op=>op.action==='fund-quote').length,1);
  assert.deepEqual(f.stores.get('damm-pump').launches[0].fundingReceipt,before.launches[0].fundingReceipt);assert.deepEqual(prepared,[],'An existing review is signed unchanged, without preparing or funding again');
});

test('signed legacy wire reconciles and rebroadcasts only through its archived controller while new setup is unavailable',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context);await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:f.sign(review.operation)},f.context);
  const before=structuredClone(f.stores.get('damm-pump').operations[0]),{legacy,next}=feeController(f);await f.service.installDeployment(next);
  const calls=[];f.adapter.verifyDeployment=async(config)=>{calls.push(['verify',config.programId]);if(config.programId===next.programId)throw Error('new setup unavailable');return {enabled:false};};
  f.adapter.reconcile=async(config)=>{calls.push(['receipt',config.programId]);return {state:'pending',canRebroadcast:true};};
  f.adapter.send=async(config,wire)=>{calls.push(['send',config.programId]);assert.equal(wire,before.signedTransaction);return before.signature;};
  f.setNow(1790000016000);await f.service.tick();
  const saved=f.stores.get('damm-pump').operations[0];assert.equal(saved.state,'submitted');assert.equal(saved.signedTransaction,before.signedTransaction);assert.equal(saved.configFingerprint,before.configFingerprint);
  assert(calls.some(([kind])=>kind==='send'));assert(calls.every(([,id])=>id===legacy.programId));assert.equal((await f.service.publicStatus()).available,false);
  f.stores.get('damm-pump').config=null;f.adapter.reconcile=async(config,op)=>{assert.equal(config.programId,legacy.programId);return {state:'finalized',lookupTables:op.bundle.lookupTables};};
  await f.service.tick();assert.equal(f.stores.get('damm-pump').operations[0].state,'finalized');assert.equal(f.stores.get('damm-pump').launches[0].setupStatus,'finalized');assert.equal((await f.service.publicStatus()).available,false);
});

test('brand-new reviews require the fee controller and discard only unpaid unsigned drafts on replacement',async t=>{
  const f=await fixture(t),unpaid=await f.service.prepare(f.session,f.input,f.context),{legacy,next,defaults}=feeController(f);
  assert.equal((await f.service.publicStatus()).available,false);await assert.rejects(f.service.prepare(f.session,f.input,f.context),/current launch controller setup/);
  await f.service.installDeployment(next);
  const store=f.stores.get('damm-pump');assert.equal(store.operations[0].state,'cancelled');assert.equal(store.launches[0].status,'cancelled');assert.equal(store.launches[0].publicProgramId,legacy.programId);
  await f.service.submit(f.session,{operationId:unpaid.operation.id,signedTransaction:f.sign(unpaid.operation)},f.context);assert.equal(f.sends,0);
  const review=await f.service.prepare(f.session,f.input,f.context),launch=f.stores.get('damm-pump').launches.at(-1);
  assert.equal(review.launch.publicProgramId,next.programId);assert.equal(review.launch.graduationFeeNumerator,'322369073');assert.equal(review.operation.review.feePolicyVersion,'fee-v2');assert.deepEqual(launch.controllerConfig,next);assert.deepEqual(launch.launchDefaults,defaults);
  assert(!JSON.stringify(review).includes('controllerConfig'),'Public response excludes deployment proofs and stored config snapshots');
});

test('configured legacy drafts resume their original initialization when new launches require the fee controller',async t=>{
  const f=await solFixture(t),before=structuredClone(f.stores.get('damm-pump').launches[0]),{legacy,next}=feeController(f);await f.service.installDeployment(next);
  const calls=[],prepare=f.adapter.prepare;f.adapter.prepare=async(config,args)=>{calls.push(config.programId);return prepare(config,args);};
  f.adapter.verifyDeployment=async(config)=>{if(config.programId===next.programId)throw Error('new controller disabled');return {enabled:true};};
  const init=await f.next();assert.equal(init.launch.publicProgramId,legacy.programId);assert.equal(init.operation.review.graduationFeeBps,0);assert.equal(init.launch.mint,before.mint);assert.deepEqual(calls,[legacy.programId]);
  await f.finalize(init);assert.equal(f.stores.get('damm-pump').launches[0].fundingStatus,'finalized');assert.equal(f.stores.get('damm-pump').launches[0].fundingSignature,f.stores.get('damm-pump').operations.at(-1).signature);
});

test('legacy reads, trades, fee claims and worker graduation keep their controller despite an unverified new primary',async t=>{
  const f=await fixture(t);await f.service.prepare(f.session,f.input,f.context);const data=f.stores.get('damm-pump');data.operations=[];data.launches[0].status='trading';data.launches[0].confirmationStatus='finalized';
  const mint=data.launches[0].mint,{legacy,next}=feeController(f);await f.service.installDeployment(next);
  const calls=[],check=(kind,config)=>{assert.equal(config.programId,legacy.programId,kind);calls.push(kind);};
  f.adapter.verifyDeployment=async config=>{check('verify',config);return {enabled:false};};f.adapter.balance=async config=>{check('balance',config);return '100000000';};
  f.adapter.wallet=async config=>{check('wallet',config);return {};};f.adapter.marketSnapshot=async config=>{check('market',config);return {};};
  f.adapter.state=async config=>{check('state',config);return {phase:'trading'};};f.adapter.pendingProtocolFees=async config=>{check('fees',config);return '1';};
  const prepare=f.adapter.prepare;f.adapter.prepare=async(config,args)=>{check(args.action,config);return prepare(config,args);};
  await f.service.wallet(f.session,{mint,expectedWallet:wallet.publicKey.toBase58()},f.context);await f.service.marketSnapshot(mint);
  const buy=await f.service.prepare(f.session,{action:'buy',mint,expectedWallet:wallet.publicKey.toBase58(),amountRaw:'1'},f.context);assert.equal(buy.operation.review.graduationFeeBps,0);await f.service.cancel(f.session,{operationId:buy.operation.id},f.context);
  f.service.requireOwner=async()=>{};const swept=await f.service.claimFees(f.session,{},f.context);assert.equal(swept.requested,1);
  f.adapter.reconcile=async config=>{check('receipt',config);return {state:'finalized',phase:'trading',protocolFee:{quoteRaw:'1'}};};await f.service.receiptOutsideLock(await f.service.load(),f.stores.get('damm-pump').operations.at(-1));
  f.adapter.state=async config=>{check('state',config);return {phase:'bonded'};};f.setNow(1790000016000);f.service.closed=false;t.after(()=>{f.service.closed=true;});await f.service.tick();
  assert(calls.includes('migrate'));assert(calls.includes('protocol-fees'));assert.equal(f.stores.get('damm-pump').operations.at(-1).configFingerprint,configHash(legacy));
});

test('replacement during a legacy review keeps its saved binding while replacement during a new draft cannot commit stale terms',async t=>{
  const f=await solFixture(t),{legacy,next}=feeController(f),prepare=f.adapter.prepare;
  f.adapter.prepare=async(config,args)=>{const bundle=await prepare(config,args);await f.service.installDeployment(next);return bundle;};
  const reviewed=await f.next();assert.equal(reviewed.launch.publicProgramId,legacy.programId);assert.equal(f.stores.get('damm-pump').operations.at(-1).configFingerprint,configHash(legacy));
  const g=await fixture(t),replacement={...g.stores.get('damm-pump').config,programId:address()},base=g.adapter.prepare;
  g.adapter.prepare=async(config,args)=>{const bundle=await base(config,args);await g.service.installDeployment(replacement);return bundle;};
  await assert.rejects(g.service.prepare(g.session,g.input,g.context),/Deployment changed/);assert.equal(g.stores.get('damm-pump').launches.length,0);assert.equal(g.stores.get('damm-pump').operations.length,0);
});

test('a changed same-program proof is archived exactly and cannot overwrite an existing launch binding',async t=>{
  const f=await solFixture(t),old=structuredClone(f.stores.get('damm-pump').config),changed={...old,expectedDeploymentSlot:'99'};await f.service.installDeployment(changed);
  const data=await f.service.load();assert.deepEqual(f.service.configForLaunch(data,data.launches[0]),old);assert.deepEqual(data.controllerConfigs[configHash(old)],old);
  await f.service.installDeployment({...changed,verifiedAt:1790000010000});assert.deepEqual(f.stores.get('damm-pump').config,changed,'A redundant install cannot invalidate fingerprints by refreshing bookkeeping metadata');
  const reviewed=await f.next();assert.equal(f.stores.get('damm-pump').operations.at(-1).configFingerprint,configHash(old));
  const stored=f.stores.get('damm-pump');stored.launchBindings[reviewed.launch.mint]=configHash(changed);
  await assert.rejects(f.service.submit(f.session,{operationId:reviewed.operation.id,signedTransaction:f.sign(reviewed.operation)},f.context),/configuration changed/);
});

test('paused legacy funding cannot prepare, broadcast after journaling, or rebroadcast after switching primary controllers',async t=>{
  const f=await solFixture(t,{fallback:true}),{legacy,next}=feeController(f);await f.service.installDeployment(next);
  const originalPrepare=f.adapter.prepare;let prepares=0,enabled=false;
  f.adapter.prepare=async(...args)=>{prepares++;return originalPrepare(...args);};
  f.adapter.verifyDeployment=async config=>{assert.equal(config.programId,legacy.programId);return {enabled};};
  await assert.rejects(f.next(),/disabled on chain/);assert.equal(prepares,0);
  enabled=true;const fund=await f.next();let sends=0,checks=0;
  f.adapter.send=async()=>{sends++;throw Error('unexpected send while paused');};
  f.adapter.verifyDeployment=async config=>{assert.equal(config.programId,legacy.programId);checks++;return {enabled:checks===1};};
  await assert.rejects(f.service.submit(f.session,{operationId:fund.operation.id,signedTransaction:f.sign(fund.operation)},f.context),/disabled on chain/);
  const journal=f.stores.get('damm-pump').operations.at(-1);assert.equal(journal.state,'journaled');assert(journal.signedTransaction);assert.equal(sends,0);
  const wire=journal.signedTransaction;f.adapter.verifyDeployment=async()=>({enabled:false});f.adapter.reconcile=async()=>({state:'pending',canRebroadcast:true});f.setNow(1790000016000);
  await assert.rejects(f.service.reconcile(f.session,{operationId:fund.operation.id},f.context),/disabled on chain/);assert.equal(sends,0);assert.equal(f.stores.get('damm-pump').operations.at(-1).signedTransaction,wire);
  // A transaction already observed by RPC may still finalize while paused.
  f.adapter.reconcile=async()=>({state:'finalized',funding:{...journal.bundle.fundingPlan,receivedRaw:journal.bundle.fundingPlan.minimumRaw}});
  const settled=await f.service.reconcile(f.session,{operationId:fund.operation.id},f.context);assert.equal(settled.operation.state,'finalized');assert.equal(f.stores.get('damm-pump').launches[0].fundingStatus,'finalized');assert.equal(sends,0);
});

async function nativeBuyRepairFixture(t,{firstBuyRaw='10000000',legacy=false}={}){
  const f=await fixture(t);Object.assign(f.pair,{mint:DAMM_PUMP_SOL,decimals:9,symbol:'SOL'});
  f.service.getQuotePrice=async()=>({mint:DAMM_PUMP_SOL,usd:200,at:1790000000000});
  const basePrepare=f.adapter.prepare;let accountPrepared=false;
  f.adapter.prepare=async(config,args)=>{
    if(args.action!=='initialize'||accountPrepared)return basePrepare(config,args);
    const bundle=await basePrepare(config,{...args,action:'prepare-buy'});
    return {...bundle,action:'prepare-buy',amountRaw:args.amountRaw,review:{...bundle.review,stage:'prepare-buy',firstBuyRaw:args.amountRaw,totalLaunchMaxDebitLamports:String(15000n+BigInt(args.launch.nativeBuySetupDebitLamports||'0'))}};
  };
  const nativeBuyAccount=getAssociatedTokenAddressSync(new PublicKey(DAMM_PUMP_SOL),wallet.publicKey).toBase58();
  f.adapter.reconcile=async(_config,op)=>{
    if(op.action==='configure')return {state:'finalized',lookupTables:op.bundle.lookupTables};
    if(op.action==='prepare-buy'){accountPrepared=true;return {state:'finalized',nextAction:'initialize',nativeBuyAccount};}
    return {state:'finalized',phase:'trading'};
  };
  f.finalize=async review=>{await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:f.sign(review.operation)},f.context);return f.service.reconcile(f.session,{operationId:review.operation.id},f.context);};
  f.setup=await f.service.prepare(f.session,{...f.input,quoteMint:DAMM_PUMP_SOL,...(legacy?{amountRaw:firstBuyRaw}:{firstBuySolLamports:firstBuyRaw})},f.context);
  await f.finalize(f.setup);
  f.next=overrides=>f.service.prepare(f.session,{action:'initialize',mint:f.setup.launch.mint,expectedWallet:wallet.publicKey.toBase58(),...overrides},f.context);
  f.nativeBuyAccount=nativeBuyAccount;
  f.closeNativeAccount=()=>{accountPrepared=false;};
  return f;
}

test('saved native SOL configure repairs only the wallet ATA then initializes the same mint and first buy',async t=>{
  const f=await nativeBuyRepairFixture(t),before=structuredClone(f.stores.get('damm-pump').launches[0]),repair=await f.next();
  assert.equal(repair.operation.action,'prepare-buy');assert.equal(repair.operation.review.firstBuyRaw,'10000000');assert.equal(repair.operation.review.configurationCreated,true);
  assert.equal(repair.operation.review.totalLaunchMaxDebitLamports,'15000');
  const tx=VersionedTransaction.deserialize(Buffer.from(repair.operation.transaction,'base64'));assert.equal(tx.message.header.numRequiredSignatures,1);
  const savedOp=f.stores.get('damm-pump').operations.at(-1);assert.equal(savedOp.bundle.needsRelayer,false);assert(savedOp.launchFingerprint);
  const signed=f.sign(repair.operation);await f.service.submit(f.session,{operationId:repair.operation.id,signedTransaction:signed},f.context);
  const wire=f.stores.get('damm-pump').operations.at(-1).signedTransaction;assert.equal(wire,signed);assert(f.savedBeforeSend);
  await assert.rejects(f.next(),/saved transaction/);
  f.service=new DammPumpService({...f.service});f.service.closed=true;
  const done=await f.service.reconcile(f.session,{operationId:repair.operation.id},f.context);
  assert.equal(done.operation.nextAction,'initialize');assert.equal(done.launch.status,'draft');
  const saved=f.stores.get('damm-pump').launches[0];
  for(const field of ['mint','mintSeed','firstBuyRaw','firstBuySolLamports','custodyAuthority','stateAddress','dammPoolId','lookupTables','setupSignature'])assert.deepEqual(saved[field],before[field],field);
  assert.equal(saved.fundingStatus,undefined);assert.equal(saved.nativeBuySetupDebitLamports,'5000');assert.equal(saved.nativeBuySetupSignature,done.operation.signature);
  assert.equal((await f.service.operations(f.session,f.context)).operations[0].id,repair.operation.id);
  await f.service.reconcile(f.session,{operationId:repair.operation.id},f.context);assert.equal(f.stores.get('damm-pump').launches[0].nativeBuySetupDebitLamports,'5000');
  const init=await f.next();assert.equal(init.operation.action,'initialize');assert.equal(init.operation.review.totalLaunchMaxDebitLamports,'15000');assert.equal(init.operation.review.firstBuyRaw,'10000000');
  const live=await f.finalize(init);assert.equal(live.launch.status,'trading');assert.equal(f.stores.get('damm-pump').launches.length,1);
  assert.deepEqual(f.stores.get('damm-pump').operations.map(op=>op.action),['configure','prepare-buy','initialize']);
});

test('native ATA repair is internal only and cannot bypass saved configuration or change legacy first-buy amounts',async t=>{
  const f=await nativeBuyRepairFixture(t,{legacy:true});
  await assert.rejects(f.next({action:'prepare-buy'}),/Choose a launch/);
  await assert.rejects(f.next({amountRaw:'20000000'}),/cannot change the saved first buy/);
  assert.equal(f.stores.get('damm-pump').operations.length,1);
  const saved=f.stores.get('damm-pump').launches[0];delete saved.setupStatus;
  await assert.rejects(f.next(),/Complete the saved launch configuration/);
  assert.equal(f.stores.get('damm-pump').operations.length,1);
  const zero=await nativeBuyRepairFixture(t,{firstBuyRaw:'0'});await assert.rejects(zero.next(),/changed the requested launch action/);
  const nonnative=await fixture(t),configured=await nonnative.service.prepare(nonnative.session,{...nonnative.input,amountRaw:'1000'},nonnative.context);
  await nonnative.service.submit(nonnative.session,{operationId:configured.operation.id,signedTransaction:nonnative.sign(configured.operation)},nonnative.context);
  nonnative.adapter.reconcile=async(_config,op)=>({state:'finalized',lookupTables:op.bundle.lookupTables});await nonnative.service.reconcile(nonnative.session,{operationId:configured.operation.id},nonnative.context);
  const prepare=nonnative.adapter.prepare;nonnative.adapter.prepare=async(config,args)=>({...await prepare(config,{...args,action:'prepare-buy'}),action:'prepare-buy'});
  await assert.rejects(nonnative.service.prepare(nonnative.session,{action:'initialize',mint:configured.launch.mint,expectedWallet:wallet.publicKey.toBase58()},nonnative.context),/changed the requested launch action/);
});

test('native ATA repair rejects modified review amounts, lookup identity, relayer signers and noncanonical receipt',async t=>{
  const f=await nativeBuyRepairFixture(t),prepare=f.adapter.prepare;
  f.adapter.prepare=async(...args)=>{const bundle=await prepare(...args);bundle.review.firstBuyRaw='1';return bundle;};await assert.rejects(f.next(),/cannot change the saved first buy/);
  f.adapter.prepare=async(...args)=>({...await prepare(...args),lookupTables:[{address:address(),addresses:[address()]}]});await assert.rejects(f.next(),/changed the saved lookup table/);
  f.adapter.prepare=async(...args)=>({...await prepare(...args),atomicQuoteFunding:true});await assert.rejects(f.next(),/cannot change the saved first buy/);
  f.adapter.prepare=async(...args)=>({...await prepare(...args),needsRelayer:true});await assert.rejects(f.next(),/unexpected signers/);
  f.adapter.prepare=prepare;const repair=await f.next();
  await f.service.submit(f.session,{operationId:repair.operation.id,signedTransaction:f.sign(repair.operation)},f.context);
  f.adapter.reconcile=async()=>({state:'confirmed'});await assert.rejects(f.service.reconcile(f.session,{operationId:repair.operation.id},f.context),/finalized wallet receipt/);
  f.adapter.reconcile=async()=>({state:'finalized',nextAction:'initialize',nativeBuyAccount:address()});await assert.rejects(f.service.reconcile(f.session,{operationId:repair.operation.id},f.context),/differs from the saved launch/);
  assert.equal(f.stores.get('damm-pump').launches[0].nativeBuySetupDebitLamports,undefined);
  assert.equal(f.stores.get('damm-pump').launches[0].status,'draft');
});

test('native repair predecessor survives a new session, declined initializer and failed initializer without another repair',async t=>{
  const f=await nativeBuyRepairFixture(t),repair=await f.next();await f.finalize(repair);
  const init=await f.next();f.context.sessionToken='reconnected-session';
  let resumed=await f.service.operations(f.session,f.context);assert.equal(resumed.operations.length,1);assert.equal(resumed.operations[0].id,repair.operation.id);assert.equal(resumed.operations[0].nextAction,'initialize');
  assert.equal(f.stores.get('damm-pump').operations.find(op=>op.id===init.operation.id).state,'cancelled');
  const retry=await f.next();await f.service.cancel(f.session,{operationId:retry.operation.id},f.context);
  resumed=await f.service.operations(f.session,f.context);assert.equal(resumed.operations[0].id,repair.operation.id);
  const failed=await f.next();await f.service.submit(f.session,{operationId:failed.operation.id,signedTransaction:f.sign(failed.operation)},f.context);
  f.adapter.reconcile=async()=>({state:'failed'});await f.service.reconcile(f.session,{operationId:failed.operation.id},f.context);
  resumed=await f.service.operations(f.session,f.context);assert.equal(resumed.operations[0].id,repair.operation.id);
  const last=await f.next();assert.equal(last.operation.action,'initialize');assert.equal(last.operation.review.firstBuyRaw,'10000000');assert.equal(f.stores.get('damm-pump').operations.filter(op=>op.action==='prepare-buy').length,1);
});

test('native repair rechecks launch fingerprints and launch availability before signing or replaying saved wire',async t=>{
  const f=await nativeBuyRepairFixture(t),repair=await f.next(),input={operationId:repair.operation.id,signedTransaction:f.sign(repair.operation)};
  f.stores.get('damm-pump').launches[0].firstBuyRaw='1';await assert.rejects(f.service.submit(f.session,input,f.context),/saved launch changed/);
  f.stores.get('damm-pump').launches[0].firstBuyRaw='10000000';f.adapter.verifyDeployment=async()=>({enabled:false});await assert.rejects(f.service.submit(f.session,input,f.context),/disabled on chain/);
  assert.equal(f.stores.get('damm-pump').operations.at(-1).signedTransaction,undefined);
  f.adapter.verifyDeployment=async()=>({enabled:true});await f.service.submit(f.session,input,f.context);const wire=f.stores.get('damm-pump').operations.at(-1).signedTransaction;
  f.adapter.reconcile=async()=>({state:'pending',canRebroadcast:true});f.setNow(1790000016000);await f.service.reconcile(f.session,{operationId:repair.operation.id},f.context);
  assert.equal(f.stores.get('damm-pump').operations.at(-1).signedTransaction,wire);assert.equal(f.sends,3);
  f.adapter.verifyDeployment=async()=>({enabled:false});f.setNow(1790000032000);await assert.rejects(f.service.reconcile(f.session,{operationId:repair.operation.id},f.context),/disabled on chain/);assert.equal(f.sends,3);
});

test('failed repair preserves setup and repeated finalized native account repairs accumulate once without spending first-buy funds',async t=>{
  const f=await nativeBuyRepairFixture(t),reconcile=f.adapter.reconcile,failed=await f.next();
  await f.service.submit(f.session,{operationId:failed.operation.id,signedTransaction:f.sign(failed.operation)},f.context);
  f.adapter.reconcile=async()=>({state:'expired'});await f.service.reconcile(f.session,{operationId:failed.operation.id},f.context);
  assert.equal((await f.service.operations(f.session,f.context)).operations[0].id,f.setup.operation.id);
  assert.equal(f.stores.get('damm-pump').launches[0].nativeBuySetupDebitLamports,undefined);
  f.adapter.reconcile=reconcile;const first=await f.next();await f.finalize(first);f.closeNativeAccount();
  const second=await f.next();assert.equal(second.operation.action,'prepare-buy');assert.equal(second.operation.review.totalLaunchMaxDebitLamports,'20000');await f.finalize(second);
  await f.service.reconcile(f.session,{operationId:first.operation.id},f.context);
  await f.service.reconcile(f.session,{operationId:second.operation.id},f.context);
  const saved=f.stores.get('damm-pump').launches[0];assert.equal(saved.nativeBuySetupDebitLamports,'10000');assert.equal(saved.firstBuyRaw,'10000000');assert.equal(saved.firstBuySolLamports,'10000000');assert.equal(saved.fundingStatus,undefined);
  assert.equal((await f.service.operations(f.session,f.context)).operations[0].id,second.operation.id);
  const init=await f.next();assert.equal(init.operation.action,'initialize');assert.equal(init.operation.review.totalLaunchMaxDebitLamports,'20000');
});

test('reconcile expires an unsigned review at its deadline without an RPC receipt or losing saved launch progress',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context);let receipts=0;
  f.adapter.reconcile=async()=>{receipts++;throw Error('Unsigned reviews have no chain receipt');};
  f.setNow(review.operation.expiresAt-1);assert.equal((await f.service.reconcile(f.session,{operationId:review.operation.id},f.context)).operation.state,'awaiting_signature');
  f.setNow(review.operation.expiresAt);const expired=await f.service.reconcile(f.session,{operationId:review.operation.id},f.context);
  assert.equal(expired.operation.state,'expired');assert.equal(expired.operation.transaction,undefined);assert.equal(receipts,0);assert.equal(f.sends,0);
  const n=await nativeBuyRepairFixture(t),repair=await n.next(),before=structuredClone(n.stores.get('damm-pump').launches[0]);
  n.setNow(repair.operation.expiresAt);assert.equal((await n.service.reconcile(n.session,{operationId:repair.operation.id},n.context)).operation.state,'expired');
  assert.deepEqual(n.stores.get('damm-pump').launches[0],before);assert.equal((await n.service.operations(n.session,n.context)).operations[0].id,n.setup.operation.id);
  const g=await solFixture(t,{fallback:true}),fund=await g.next();await g.finalize(fund);const init=await g.next(),funded=structuredClone(g.stores.get('damm-pump').launches[0]);
  g.setNow(init.operation.expiresAt);assert.equal((await g.service.reconcile(g.session,{operationId:init.operation.id},g.context)).operation.state,'expired');
  assert.deepEqual(g.stores.get('damm-pump').launches[0],funded);assert.equal((await g.service.operations(g.session,g.context)).operations[0].id,fund.operation.id);
  g.service.getQuotePrice=async()=>({mint:quote,usd:25,at:init.operation.expiresAt});const retry=await g.next();assert.equal(retry.operation.action,'initialize');assert.equal(retry.launch.mint,init.launch.mint);assert.equal(retry.operation.review.quoteFundingComplete,true);assert.equal(g.stores.get('damm-pump').operations.at(-1).bundle.atomicQuoteFunding,undefined);
});

test('reconcile and operations never expire or cancel reviews carrying any saved signature evidence',async t=>{
  for(const field of ['signedTransaction','walletSignedTransaction','signature']){
    const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context),op=f.stores.get('damm-pump').operations[0];
    op[field]=field==='signature'?'2'.repeat(88):f.sign(review.operation);const before=structuredClone(op);f.setNow(review.operation.expiresAt+1);
    f.adapter.reconcile=async()=>{throw Error('No replacement or receipt route may erase inconsistent signature evidence');};
    assert.equal((await f.service.reconcile(f.session,{operationId:review.operation.id},f.context)).operation.state,'awaiting_signature');
    const list=await f.service.operations(f.session,{...f.context,sessionToken:'replacement-session'});assert.equal(list.operations[0].state,'awaiting_signature');assert.deepEqual(f.stores.get('damm-pump').operations[0],before);assert.equal(f.sends,0);
  }
});

test('unsigned expiry rechecks the journal under lock when a concurrent submission won after its stale read',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context),stale=await f.service.load();
  await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:f.sign(review.operation)},f.context);
  const wire=f.stores.get('damm-pump').operations[0].signedTransaction,load=f.service.load.bind(f.service);let first=true,receipts=0;
  f.service.load=async()=>{if(first){first=false;return structuredClone(stale);}return load();};
  f.adapter.reconcile=async(_config,op)=>{receipts++;assert.equal(op.signedTransaction,wire);return {state:'pending',canRebroadcast:false};};f.setNow(review.operation.expiresAt+1);
  const response=await f.service.reconcile(f.session,{operationId:review.operation.id},f.context);assert.equal(response.operation.state,'pending');assert.equal(receipts,1);assert.equal(f.stores.get('damm-pump').operations[0].signedTransaction,wire);assert.equal(f.sends,1);
});

test('unsigned expiry reauthorizes before mutation and preserves a finalized or confirmed concurrent submission',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context);f.setNow(review.operation.expiresAt+1);let authorizations=0;
  const context={...f.context,authorize:async()=>++authorizations===1?f.session:{...f.session,account:{id:'other'}}};
  await assert.rejects(f.service.reconcile(f.session,{operationId:review.operation.id},context),/account changed/);assert.equal(f.stores.get('damm-pump').operations[0].state,'awaiting_signature');
  for(const state of ['submitted','journaled','confirmed','finalized']){
    const g=await fixture(t),draft=await g.service.prepare(g.session,g.input,g.context);await g.service.submit(g.session,{operationId:draft.operation.id,signedTransaction:g.sign(draft.operation)},g.context);
    const op=g.stores.get('damm-pump').operations[0];op.state=state;const before=structuredClone(op);g.setNow(draft.operation.expiresAt+1);
    // Receipt processing is a separate responsibility; expiry must send durable
    // operations to that path and must never synthesize an expired result.
    g.service.receiptOutsideLock=async(data,seen)=>{assert.equal(seen.state,state);return g.service.response(data,seen);};
    assert.equal((await g.service.reconcile(g.session,{operationId:draft.operation.id},g.context)).operation.state,state);assert.deepEqual(g.stores.get('damm-pump').operations[0],before);
  }
});

const barrier=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
test('concurrent status requests share only their in-flight deployment proof and always read balances freshly',async t=>{
  const f=await fixture(t),gate=barrier();let checks=0,balances=0;
  f.adapter.verifyDeployment=async()=>{checks++;await gate.promise;return {enabled:true};};f.adapter.balance=async()=>{balances++;return '30000000';};
  const requests=Array.from({length:12},()=>f.service.publicStatus());await new Promise(resolve=>setImmediate(resolve));assert.equal(checks,1);gate.release();
  const results=await Promise.all(requests);assert(results.every(result=>result.available));assert.equal(balances,12);assert.equal(f.service.deploymentChecks.size,0);
  f.adapter.balance=async()=>{balances++;return '0';};assert.equal((await f.service.publicStatus()).available,false);assert.equal(checks,2);assert.equal(balances,13);
});

test('deployment proof sharing separates controller pins and recovery mode and never caches a failure',async t=>{
  const f=await fixture(t),snapshot=await f.service.load(),changed=structuredClone(snapshot),gate=barrier();changed.config.expectedDeploymentSlot='another-slot';let checks=0;
  f.adapter.verifyDeployment=async()=>{checks++;await gate.promise;return {enabled:true};};
  const requests=[f.service.binding(snapshot,{newLaunch:true}),f.service.binding(snapshot,{newLaunch:true}),f.service.binding(snapshot),f.service.binding(changed,{newLaunch:true})];
  await new Promise(resolve=>setImmediate(resolve));assert.equal(checks,3);gate.release();await Promise.all(requests);assert.equal(f.service.deploymentChecks.size,0);
  const failedGate=barrier();f.adapter.verifyDeployment=async()=>{checks++;await failedGate.promise;throw Error('verification unavailable');};
  const failed=Promise.allSettled([f.service.binding(snapshot),f.service.binding(snapshot)]);await new Promise(resolve=>setImmediate(resolve));assert.equal(checks,4);failedGate.release();assert((await failed).every(result=>result.status==='rejected'));assert.equal(f.service.deploymentChecks.size,0);
  f.adapter.verifyDeployment=async()=>{checks++;return {enabled:true};};await f.service.binding(snapshot);assert.equal(checks,5);
});

test('concurrent signed-operation polls share one proof, receipt and commit while every later poll reads again',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context);await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:f.sign(review.operation)},f.context);
  const gate=barrier(),load=f.service.load.bind(f.service),save=f.service.save.bind(f.service);let proofs=0,receipts=0,loads=0,commits=0;
  f.service.load=async()=>{loads++;return load();};f.service.save=async data=>{commits++;return save(data);};f.adapter.verifyDeployment=async()=>{proofs++;return {enabled:true};};f.adapter.reconcile=async()=>{receipts++;await gate.promise;return {state:'pending',canRebroadcast:false};};
  const requests=Array.from({length:12},()=>f.service.reconcile(f.session,{operationId:review.operation.id},f.context));await new Promise(resolve=>setImmediate(resolve));assert.equal(receipts,1);gate.release();
  const results=await Promise.all(requests);assert.equal(proofs,1);assert.equal(receipts,1);assert.equal(commits,1);assert.equal(loads,13);assert.equal(f.service.receiptChecks.size,0);assert.equal(f.sends,1);
  results[0].operation.review.maxWalletDebitLamports='1';assert.equal(results[1].operation.review.maxWalletDebitLamports,'5000');assert.equal(f.stores.get('damm-pump').operations[0].review.maxWalletDebitLamports,'5000');
  await f.service.reconcile(f.session,{operationId:review.operation.id},f.context);assert.equal(proofs,2);assert.equal(receipts,2);assert.equal(commits,2);
});

test('receipt sharing keeps caller authorization independent and failures do not block the next read',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context);await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:f.sign(review.operation)},f.context);
  const gate=barrier();let receipts=0,badCalls=0;
  f.adapter.reconcile=async()=>{receipts++;await gate.promise;return {state:'pending',canRebroadcast:false};};
  const badContext={...f.context,authorize:async()=>++badCalls===1?f.session:{...f.session,account:{id:'other'}}};
  const responses=Promise.allSettled([f.service.reconcile(f.session,{operationId:review.operation.id},f.context),f.service.reconcile(f.session,{operationId:review.operation.id},badContext)]);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(receipts,1);gate.release();const [good,bad]=await responses;assert.equal(good.status,'fulfilled');assert.equal(bad.status,'rejected');assert.match(bad.reason.message,/account changed/);
  f.adapter.reconcile=async()=>{receipts++;throw Error('receipt unavailable');};const failures=await Promise.allSettled([f.service.reconcile(f.session,{operationId:review.operation.id},f.context),f.service.reconcile(f.session,{operationId:review.operation.id},f.context)]);assert(failures.every(result=>result.status==='rejected'));assert.equal(receipts,2);assert.equal(f.service.receiptChecks.size,0);
  f.adapter.reconcile=async()=>{receipts++;return {state:'pending',canRebroadcast:false};};await f.service.reconcile(f.session,{operationId:review.operation.id},f.context);assert.equal(receipts,3);
});

test('receipt sharing never joins a different signed wire or a changed immutable launch binding',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context);await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:f.sign(review.operation)},f.context);
  const snapshot=await f.service.load(),op=snapshot.operations[0],gate=barrier();let receipts=0;
  f.adapter.reconcile=async(_config,seen)=>{receipts++;await gate.promise;if(seen.signedTransaction!==op.signedTransaction)throw Error('The finalized receipt differs from the saved signed transaction.');return {state:'pending',canRebroadcast:false};};
  const changed=structuredClone(snapshot);changed.launches[0].priceSnapshot.at++;
  const requests=[f.service.receiptOutsideLock(snapshot,op),f.service.receiptOutsideLock(snapshot,{...op,signedTransaction:op.signedTransaction+'changed'}),f.service.receiptOutsideLock(changed,op)];
  const finished=Promise.allSettled(requests);await new Promise(resolve=>setImmediate(resolve));assert.equal(receipts,3);gate.release();const results=await finished;assert.deepEqual(results.map(result=>result.status),['fulfilled','rejected','fulfilled']);assert.match(results[1].reason.message,/differs from the saved signed transaction/);assert.equal(f.service.receiptChecks.size,0);
  const wrong=structuredClone(snapshot);wrong.config.programId=address();await assert.rejects(f.service.receiptOutsideLock(wrong,op),/configuration changed/);assert.equal(receipts,3);
});

function signedWithGuard(operation, {change, missingSignature=false, target=wallet.publicKey, tables=[]}={}) {
  const original=VersionedTransaction.deserialize(Buffer.from(operation.transaction,'base64'));
  const builder=TransactionMessage.decompile(original.message,{addressLookupTableAccounts:tables});
  // Source-verified Lighthouse AccountInfo::Lamports >= 0 assertion.
  const guard=new TransactionInstruction({programId:new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),keys:[{pubkey:target,isSigner:false,isWritable:false}],data:Buffer.concat([Buffer.from([5,0,0]),Buffer.alloc(8),Buffer.from([4])])});
  builder.instructions.push(guard);if(change)change(builder);
  const tx=new VersionedTransaction(builder.compileToV0Message(tables));if(!missingSignature)tx.sign([wallet]);
  return Buffer.from(tx.serialize()).toString('base64');
}

function addReviewedReadonlyAccounts(f){
 const prepare=f.adapter.prepare;
 f.adapter.prepare=async(...args)=>{
  const bundle=await prepare(...args),original=VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction,'base64')),builder=TransactionMessage.decompile(original.message);
  builder.instructions[0].keys.push(...[0,1].map(()=>({pubkey:Keypair.generate().publicKey,isSigner:false,isWritable:false})));
  bundle.unsignedTransaction=Buffer.from(new VersionedTransaction(builder.compileToV0Message()).serialize()).toString('base64');return bundle;
 };
}
function signedWithEquivalentLayout(operation){
 const tx=VersionedTransaction.deserialize(Buffer.from(operation.transaction,'base64')),message=tx.message;
 const readonly=message.staticAccountKeys.map((_,index)=>index).filter(index=>!message.isAccountSigner(index)&&!message.isAccountWritable(index));assert(readonly.length>=2);
 const [a,b]=readonly;[message.staticAccountKeys[a],message.staticAccountKeys[b]]=[message.staticAccountKeys[b],message.staticAccountKeys[a]];
 const remap=index=>index===a?b:index===b?a:index;
 for(const ix of message.compiledInstructions){ix.programIdIndex=remap(ix.programIdIndex);ix.accountKeyIndexes=ix.accountKeyIndexes.map(remap);}
 tx.sign([wallet]);return Buffer.from(tx.serialize()).toString('base64');
}

test('equivalent wallet account layouts receive complete signature simulation and preserve exact replay bytes',async t=>{
 const f=await fixture(t);addReviewedReadonlyAccounts(f);
 const review=await f.service.prepare(f.session,f.input,f.context),wire=signedWithEquivalentLayout(review.operation),before=structuredClone(f.stores.get('damm-pump'));let simulations=0;
 f.adapter.verifyWalletGuardProgram=()=>assert.fail('No Lighthouse instruction was added');
 f.adapter.simulateWalletGuardTransaction=async tx=>{simulations++;verifySignedTransaction(Buffer.from(tx.serialize()),wallet.publicKey.toBase58(),[]);assert.deepEqual(f.stores.get('damm-pump'),before);};
 await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:wire},f.context);
 const saved=f.stores.get('damm-pump').operations[0];assert.equal(saved.walletGuardCount,undefined);assert.equal(saved.walletMessageChanged,true);assert.equal(saved.walletSignedTransaction,wire);assert.equal(saved.signedTransaction,wire);assert.equal(simulations,1);assert.equal(f.sends,1);
 await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:wire},f.context);assert.equal(simulations,1);assert.equal(f.sends,1);
 f.setNow(1790000020000);await f.service.rebroadcastSaved(saved.id);assert.equal(f.sends,2);assert.equal(f.stores.get('damm-pump').operations[0].signedTransaction,wire);
 delete f.stores.get('damm-pump').operations[0].walletMessageChanged;f.setNow(1790000040000);await assert.rejects(f.service.rebroadcastSaved(saved.id),error=>error.statusCode===409&&error.code!=='WALLET_TRANSACTION_REJECTED');assert.equal(f.sends,2);
});

test('equivalent initialize layout is co-signed only after wallet verification and before full simulation',async t=>{
 const f=await fixture(t);addReviewedReadonlyAccounts(f);
 const setup=await f.service.prepare(f.session,f.input,f.context);await f.service.submit(f.session,{operationId:setup.operation.id,signedTransaction:f.sign(setup.operation)},f.context);
 f.adapter.reconcile=async(_config,op)=>({state:'finalized',lookupTables:op.bundle.lookupTables});await f.service.reconcile(f.session,{operationId:setup.operation.id},f.context);
 const review=await f.service.prepare(f.session,{action:'initialize',mint:setup.launch.mint,expectedWallet:wallet.publicKey.toBase58()},f.context),wire=signedWithEquivalentLayout(review.operation),external=VersionedTransaction.deserialize(Buffer.from(wire,'base64')).signatures[0];let simulations=0;
 f.adapter.verifyWalletGuardProgram=()=>assert.fail('Equivalent layout does not add a safety program');
 f.adapter.simulateWalletGuardTransaction=async tx=>{simulations++;assert.deepEqual(tx.signatures[0],external);verifySignedTransaction(Buffer.from(tx.serialize()),wallet.publicKey.toBase58(),[relayer.publicKey.toBase58()]);assert.equal(f.stores.get('damm-pump').operations.at(-1).signedTransaction,undefined);};
 await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:wire},f.context);
 const saved=f.stores.get('damm-pump').operations.at(-1);assert.equal(simulations,1);assert.equal(saved.walletSignedTransaction,wire);assert.equal(saved.walletMessageChanged,true);assert.equal(saved.walletGuardCount,undefined);assert.deepEqual(VersionedTransaction.deserialize(Buffer.from(saved.signedTransaction,'base64')).signatures[0],external);
});

test('equivalent layout simulation uncertainty retains the original review with no journal or broadcast',async t=>{
 const f=await fixture(t);addReviewedReadonlyAccounts(f);const review=await f.service.prepare(f.session,f.input,f.context),wire=signedWithEquivalentLayout(review.operation),before=structuredClone(f.stores.get('damm-pump'));
 f.adapter.simulateWalletGuardTransaction=async()=>{throw Object.assign(Error('temporary RPC'),{statusCode:503,code:'DAMM_WALLET_GUARD_RPC'});};
 await assert.rejects(f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:wire},f.context),error=>error.code==='DAMM_WALLET_GUARD_RPC');assert.deepEqual(f.stores.get('damm-pump'),before);assert.equal(f.sends,0);
 f.adapter.simulateWalletGuardTransaction=async()=>{};await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:wire},f.context);assert.equal(f.sends,1);
});

test('Pump wallet may retain a subset of known lookup tables but cannot introduce another table',()=>{
 const targets=[Keypair.generate().publicKey,Keypair.generate().publicKey],tables=targets.map(target=>new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:{deactivationSlot:(1n<<64n)-1n,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,authority:undefined,addresses:[target]}}));
 const ix=new TransactionInstruction({programId:program,keys:[{pubkey:wallet.publicKey,isSigner:true,isWritable:true},...targets.map(pubkey=>({pubkey,isSigner:false,isWritable:true}))],data:Buffer.from([6])}),builder=new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:address(),instructions:[ix]});
 const original=new VersionedTransaction(builder.compileToV0Message(tables)),bundle={unsignedTransaction:Buffer.from(original.serialize()).toString('base64'),needsRelayer:false,addressLookupTables:tables.map(table=>({address:table.key.toBase58(),addresses:table.state.addresses.map(String)}))};
 assert.equal(original.message.addressTableLookups.length,2);
 for(const subset of [tables.slice(0,1),tables.slice(1),[]]){
  const tx=new VersionedTransaction(builder.compileToV0Message(subset));tx.sign([wallet]);const wire=Buffer.from(tx.serialize()).toString('base64');assert.equal(Buffer.from(verifyPublicWalletTransaction(wire,bundle,wallet.publicKey.toBase58(),relayer.publicKey.toBase58()).serialize()).toString('base64'),wire);
 }
 const unknown=new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:tables[0].state}),tx=new VersionedTransaction(builder.compileToV0Message([unknown]));tx.sign([wallet]);
 assert.throws(()=>verifyPublicWalletTransaction(Buffer.from(tx.serialize()).toString('base64'),bundle,wallet.publicKey.toBase58(),relayer.publicKey.toBase58()),error=>error.code==='WALLET_TRANSACTION_REJECTED'&&error.walletValidationReason==='lookup review mismatch');
});

test('a wallet using a saved unused lookup snapshot still needs chain verification before co-signing',async t=>{
 const f=await fixture(t),setup=await f.service.prepare(f.session,f.input,f.context);await f.service.submit(f.session,{operationId:setup.operation.id,signedTransaction:f.sign(setup.operation)},f.context);
 f.adapter.reconcile=async(_config,op)=>({state:'finalized',lookupTables:op.bundle.lookupTables});await f.service.reconcile(f.session,{operationId:setup.operation.id},f.context);
 const prepare=f.adapter.prepare,target=Keypair.generate().publicKey,table=new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:{deactivationSlot:(1n<<64n)-1n,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,authority:undefined,addresses:[target]}});
 f.adapter.prepare=async(...args)=>{const bundle=await prepare(...args),original=VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction,'base64')),builder=TransactionMessage.decompile(original.message);builder.instructions[0].keys.push({pubkey:target,isSigner:false,isWritable:false});bundle.unsignedTransaction=Buffer.from(new VersionedTransaction(builder.compileToV0Message()).serialize()).toString('base64');bundle.addressLookupTables=[{address:String(table.key),addresses:[String(target)]}];return bundle;};
 const review=await f.service.prepare(f.session,{action:'initialize',mint:setup.launch.mint,expectedWallet:wallet.publicKey.toBase58()},f.context),original=VersionedTransaction.deserialize(Buffer.from(review.operation.transaction,'base64')),builder=TransactionMessage.decompile(original.message),tx=new VersionedTransaction(builder.compileToV0Message([table]));tx.sign([wallet]);
 assert.equal(original.message.addressTableLookups.length,0);assert.equal(tx.message.addressTableLookups.length,1);
 const input={operationId:review.operation.id,signedTransaction:Buffer.from(tx.serialize()).toString('base64')},before=structuredClone(f.stores.get('damm-pump'));let verified=false,signs=0,simulations=0;const signer=f.service.signer.bind(f.service);f.service.signer=data=>{assert(verified);signs++;return signer(data);};
 f.adapter.verifyLookupTables=async()=>{throw Object.assign(Error('lookup RPC unavailable'),{statusCode:503,code:'DAMM_WALLET_GUARD_RPC'});};f.adapter.simulateWalletGuardTransaction=async()=>{assert(verified);simulations++;};
 await assert.rejects(f.service.submit(f.session,input,f.context),error=>error.code==='DAMM_WALLET_GUARD_RPC');assert.equal(signs,0);assert.equal(simulations,0);assert.deepEqual(f.stores.get('damm-pump'),before);assert.equal(f.sends,1);
 f.adapter.verifyLookupTables=async()=>{verified=true;};await f.service.submit(f.session,input,f.context);assert.equal(signs,1);assert.equal(simulations,1);assert.equal(f.sends,2);
});

test('wallet rejection reports the saved stage and bounded mismatch without exposing or saving approval bytes',async t=>{
 const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context),before=structuredClone(f.stores.get('damm-pump'));
 // An inserted transfer is an economic change, unlike a wallet priority fee.
 const wire=signedWithGuard(review.operation,{change:builder=>builder.instructions.unshift(SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:relayer.publicKey,lamports:1}))});
 await assert.rejects(f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:wire},f.context),error=>{
  assert.equal(error.code,'WALLET_TRANSACTION_REJECTED');assert.equal(error.statusCode,400);assert.equal(error.walletValidationReason,'original instructions changed');
  assert.equal(error.walletValidationAction,'configure');assert.equal(error.walletValidationDetail,'ix0 program other>system; n1>3');
  assert.match(error.message,/\[configure: ix0 program other>system; n1>3\]/);assert(error.message.length<300);
  const original=VersionedTransaction.deserialize(Buffer.from(review.operation.transaction,'base64')),returned=VersionedTransaction.deserialize(Buffer.from(wire,'base64'));
  for(const value of [wire,review.operation.transaction,...original.message.staticAccountKeys.map(String),...returned.message.staticAccountKeys.map(String),...returned.signatures.map(signature=>Buffer.from(signature).toString('base64'))])assert(!error.message.includes(value));
  return true;
 });
 assert.deepEqual(f.stores.get('damm-pump'),before);assert.equal(f.sends,0);
 const bundle={...before.operations[0].bundle,action:wallet.publicKey.toBase58()};
 assert.throws(()=>verifyPublicWalletTransaction(wire,bundle,wallet.publicKey.toBase58(),relayer.publicKey.toBase58()),error=>error.walletValidationAction==='wallet'&&!error.message.includes(wallet.publicKey.toBase58()));
});

test('rejected excessive wallet fee augmentation expires safely and a fresh setup can be submitted once',async t=>{
  const f=await fixture(t),legacy=await f.service.prepare(f.session,f.input,f.context);
  // 1.4M CU at 10 lamports/CU is 0.014 SOL, above the 0.01 SOL wallet fee cap.
  const wire=signedWithGuard(legacy.operation,{change:builder=>builder.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),
    ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000000})
  )});
  await assert.rejects(f.service.submit(f.session,{operationId:legacy.operation.id,signedTransaction:wire},f.context),error=>error.code==='WALLET_TRANSACTION_REJECTED'&&/wallet priority fee above limit/.test(error.message));
  const old=f.stores.get('damm-pump').operations[0];
  assert.equal(f.sends,0);assert.equal(old.signedTransaction,undefined);assert.equal(old.walletSignedTransaction,undefined);assert.equal(old.signature,undefined);
  f.setNow(legacy.operation.expiresAt+1);
  assert.deepEqual((await f.service.operations(f.session,f.context)).operations,[]);
  assert.equal(f.stores.get('damm-pump').operations[0].state,'expired');
  const prepare=f.adapter.prepare;
  f.adapter.prepare=async(...args)=>{
    const bundle=await prepare(...args),tx=VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction,'base64'));
    const builder=TransactionMessage.decompile(tx.message);
    builder.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:500000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:0}));
    bundle.unsignedTransaction=Buffer.from(new VersionedTransaction(builder.compileToV0Message()).serialize()).toString('base64');
    return bundle;
  };
  f.adapter.verifyWalletGuardProgram=async()=>{};
  f.adapter.simulateWalletGuardTransaction=async()=>{};
  const fresh=await f.service.prepare(f.session,f.input,f.context),input={operationId:fresh.operation.id,signedTransaction:signedWithGuard(fresh.operation)};
  assert.notEqual(fresh.operation.id,legacy.operation.id);
  assert.equal((await f.service.submit(f.session,input,f.context)).operation.state,'pending');
  assert.equal(f.sends,1);assert(f.savedBeforeSend);
  await f.service.submit(f.session,input,f.context);
  assert.equal(f.sends,1);
  f.setNow(fresh.operation.expiresAt+1);
  assert.equal((await f.service.operations(f.session,f.context)).operations[0].id,fresh.operation.id);
  assert.equal(f.stores.get('damm-pump').operations.at(-1).state,'pending');
});

test('Lighthouse wallet assertions are preserved, proved and simulated before setup journal and broadcast',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context),before=structuredClone(f.stores.get('damm-pump').operations[0]);let proof=0,simulations=0;
  f.adapter.verifyWalletGuardProgram=async()=>{proof++;assert.equal(f.sends,proof-1);};
  f.adapter.simulateWalletGuardTransaction=async tx=>{simulations++;assert.equal(proof,1);assert.equal(tx.signatures.length,1);assert(tx.signatures[0].some(Boolean));assert.deepEqual(f.stores.get('damm-pump').operations[0],before);};
  const wire=signedWithGuard(review.operation),input={operationId:review.operation.id,signedTransaction:wire};
  const result=await f.service.submit(f.session,input,f.context),saved=f.stores.get('damm-pump').operations[0];
  assert.equal(result.operation.state,'pending');assert.equal(proof,1);assert.equal(simulations,1);assert.equal(saved.walletGuardCount,1);assert.equal(saved.signedTransaction,wire);assert.equal(saved.walletSignedTransaction,wire);assert(f.savedBeforeSend);
  await f.service.submit(f.session,input,f.context);assert.equal(simulations,1);assert.equal(f.sends,1);
  f.setNow(1790000020000);await f.service.rebroadcastSaved(review.operation.id);assert.equal(f.sends,2);assert.equal(proof,2);assert.equal(f.stores.get('damm-pump').operations[0].signedTransaction,wire);
});

test('Phantom/Solflare bounded priority fee and compute-limit edits are simulated, journaled and broadcast once',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context);let proof=0,simulations=0;
  f.adapter.verifyWalletGuardProgram=async()=>{proof++;};
  f.adapter.simulateWalletGuardTransaction=async tx=>{simulations++;assert(tx.signatures[0].some(Boolean));assert.equal(f.stores.get('damm-pump').operations[0].signedTransaction,undefined);};
  // Solflare-style: priority fee and compute limit only, no assertions.
  const original=VersionedTransaction.deserialize(Buffer.from(review.operation.transaction,'base64')),builder=TransactionMessage.decompile(original.message);
  builder.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({microLamports:250000}),ComputeBudgetProgram.setComputeUnitLimit({units:400000}));
  const tx=new VersionedTransaction(builder.compileToV0Message());tx.sign([wallet]);
  const wire=Buffer.from(tx.serialize()).toString('base64'),input={operationId:review.operation.id,signedTransaction:wire};
  const result=await f.service.submit(f.session,input,f.context),saved=f.stores.get('damm-pump').operations[0];
  assert.equal(result.operation.state,'pending');assert.equal(proof,0);assert.equal(simulations,1);assert.equal(saved.walletMessageChanged,true);assert.equal(saved.walletGuardCount,undefined);assert.equal(saved.signedTransaction,wire);assert(f.savedBeforeSend);
  await f.service.submit(f.session,input,f.context);assert.equal(simulations,1);assert.equal(f.sends,1);
  f.setNow(1790000020000);await f.service.rebroadcastSaved(review.operation.id);assert.equal(f.sends,2);assert.equal(f.stores.get('damm-pump').operations[0].signedTransaction,wire);
  // Phantom-style: fee edit plus Lighthouse assertions on a second review.
  const g=await fixture(t),second=await g.service.prepare(g.session,g.input,g.context);let guarded=0;
  g.adapter.verifyWalletGuardProgram=async()=>{guarded++;};g.adapter.simulateWalletGuardTransaction=async()=>{};
  const phantom=signedWithGuard(second.operation,{change:builder=>builder.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:600000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:100000}))});
  assert.equal((await g.service.submit(g.session,{operationId:second.operation.id,signedTransaction:phantom},g.context)).operation.state,'pending');
  assert.equal(guarded,1);assert.equal(g.stores.get('damm-pump').operations[0].walletGuardCount,1);
});

test('wallet guards co-sign only the original initialize relayer and preserve the external signature',async t=>{
  const f=await fixture(t),setup=await f.service.prepare(f.session,f.input,f.context);
  await f.service.submit(f.session,{operationId:setup.operation.id,signedTransaction:f.sign(setup.operation)},f.context);
  f.adapter.reconcile=async(_config,op)=>({state:'finalized',lookupTables:op.bundle.lookupTables});await f.service.reconcile(f.session,{operationId:setup.operation.id},f.context);
  const review=await f.service.prepare(f.session,{action:'initialize',mint:setup.launch.mint,expectedWallet:wallet.publicKey.toBase58()},f.context),wire=signedWithGuard(review.operation),external=VersionedTransaction.deserialize(Buffer.from(wire,'base64')).signatures[0];
  let proof=false,simulated=false;f.adapter.verifyWalletGuardProgram=async()=>{proof=true;};
  f.adapter.simulateWalletGuardTransaction=async tx=>{assert(proof);assert.equal(tx.signatures.length,2);assert(tx.signatures.every(signature=>signature.some(Boolean)));assert.deepEqual(tx.signatures[0],external);assert.equal(f.stores.get('damm-pump').operations.at(-1).signedTransaction,undefined);simulated=true;};
  await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:wire},f.context);assert(simulated);
  const saved=f.stores.get('damm-pump').operations.at(-1),tx=VersionedTransaction.deserialize(Buffer.from(saved.signedTransaction,'base64'));
  assert.deepEqual(tx.signatures[0],external);assert.equal(saved.walletSignedTransaction,wire);assert.equal(saved.walletGuardCount,1);assert(tx.signatures[1].some(Boolean));
});

test('guard rejection is definitive before signing or persistence; RPC verification retains the original review',async t=>{
  const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context),before=structuredClone(f.stores.get('damm-pump'));let proof=0,sim=0;
  f.adapter.verifyWalletGuardProgram=async()=>{proof++;throw Object.assign(Error('temporary RPC'),{statusCode:503,code:'DAMM_WALLET_GUARD_RPC'});};
  f.adapter.simulateWalletGuardTransaction=async()=>{sim++;};
  for(const options of [{missingSignature:true},{target:Keypair.generate().publicKey},{change:builder=>{builder.instructions[0].data[0]^=1;}},{change:builder=>{builder.recentBlockhash=address();}}]) {
    await assert.rejects(f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:signedWithGuard(review.operation,options)},f.context),error=>error.statusCode===400&&error.code==='WALLET_TRANSACTION_REJECTED');
    assert.deepEqual(f.stores.get('damm-pump'),before);
  }
  assert.equal(proof,0);assert.equal(sim,0);assert.equal(f.sends,0);
  const wire=signedWithGuard(review.operation);await assert.rejects(f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:wire},f.context),error=>error.statusCode===503&&error.code==='DAMM_WALLET_GUARD_RPC');
  assert.equal(proof,1);assert.equal(sim,0);assert.deepEqual(f.stores.get('damm-pump'),before);
  f.adapter.verifyWalletGuardProgram=async()=>{};await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:wire},f.context);assert.equal(sim,1);assert.equal(f.sends,1);
});

test('Lighthouse assertions resolve frozen lookup accounts without permitting new tables or altered instruction keys',()=>{
  const target=Keypair.generate().publicKey,table=new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:{deactivationSlot:(1n<<64n)-1n,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,authority:undefined,addresses:[target]}});
  const ix=new TransactionInstruction({programId:program,keys:[{pubkey:wallet.publicKey,isSigner:true,isWritable:true},{pubkey:target,isSigner:false,isWritable:true}],data:Buffer.from([6])});
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:address(),instructions:[ix]}).compileToV0Message([table]));
  const bundle={unsignedTransaction:Buffer.from(tx.serialize()).toString('base64'),needsRelayer:false,addressLookupTables:[{address:table.key.toBase58(),addresses:[target.toBase58()]}]},operation={transaction:bundle.unsignedTransaction};
  const wire=signedWithGuard(operation,{target,tables:[table]});assert.doesNotThrow(()=>verifyPublicWalletTransaction(wire,bundle,wallet.publicKey.toBase58(),relayer.publicKey.toBase58()));
  const wrong={...bundle,addressLookupTables:[{address:address(),addresses:[target.toBase58()]}]};assert.throws(()=>verifyPublicWalletTransaction(wire,wrong,wallet.publicKey.toBase58(),relayer.publicKey.toBase58()),error=>error.code==='WALLET_TRANSACTION_REJECTED');
});


test('a corrupted journal with guard metadata never exposes a discard-safe wallet rejection',async t=>{
 const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context);f.adapter.verifyWalletGuardProgram=async()=>{};f.adapter.simulateWalletGuardTransaction=async()=>{};
 await f.service.submit(f.session,{operationId:review.operation.id,signedTransaction:signedWithGuard(review.operation)},f.context);
 const saved=f.stores.get('damm-pump').operations[0],tx=VersionedTransaction.deserialize(Buffer.from(saved.signedTransaction,'base64'));tx.message.compiledInstructions[0].data[0]^=1;saved.signedTransaction=Buffer.from(tx.serialize()).toString('base64');f.setNow(1790000020000);
 await assert.rejects(f.service.rebroadcastSaved(review.operation.id),error=>error.statusCode===409&&error.code!=='WALLET_TRANSACTION_REJECTED');assert.equal(f.sends,1);
});


test('a concurrent guarded submit committed during simulation is reconciled instead of reported unsent',async t=>{
 const f=await fixture(t),review=await f.service.prepare(f.session,f.input,f.context),input={operationId:review.operation.id,signedTransaction:signedWithGuard(review.operation)};
 f.adapter.verifyWalletGuardProgram=async()=>{};let failedSimulation,entered;const ready=new Promise(resolve=>{entered=resolve;});
 f.adapter.simulateWalletGuardTransaction=()=>new Promise((_,reject)=>{failedSimulation=reject;entered();});
 const laterFailure=f.service.submit(f.session,input,f.context);await ready;
 f.adapter.simulateWalletGuardTransaction=async()=>{};const accepted=await f.service.submit(f.session,input,f.context);assert.equal(accepted.operation.state,'pending');
 failedSimulation(Object.assign(Error('already initialized'),{statusCode:400,code:'WALLET_TRANSACTION_REJECTED'}));
 const reconciled=await laterFailure;assert.equal(reconciled.operation.state,'pending');assert.equal(f.sends,1);assert.equal(f.stores.get('damm-pump').operations[0].walletSignedTransaction,input.signedTransaction);
});

test('v71.18 closes new public Meteora → PumpSwap launches but keeps existing coins and paid drafts', async () => {
  const { DammPumpService: Service, DAMM_PUMP_NEW_LAUNCHES_ENABLED, DAMM_PUMP_CLOSED_REASON } = await import('../src/damm-pump-service.mjs');
  assert.equal(DAMM_PUMP_NEW_LAUNCHES_ENABLED, false);
  const docs = new Map([['damm-pump', { schemaVersion: 1, launches: [], operations: [] }]]);
  const service = new Service({ accounts: { hostStore: { read: async (name, fallback) => docs.get(name) ?? fallback, write: async (name, value) => docs.set(name, value) } }, adapter: {} });
  const status = await service.publicStatus();
  assert.equal(status.available, false); assert.equal(status.publicEnabled, false); assert.equal(status.newLaunchesClosed, true);
  assert.match(status.blockers[0], /closed/); assert.equal(status.blockers[0], DAMM_PUMP_CLOSED_REASON);
  await assert.rejects(service.prepare({ account: { id: 'a' } }, { action: 'initialize', expectedWallet: '11111111111111111111111111111111', name: 'x', symbol: 'x', amountRaw: '0', quoteMint: 'So11111111111111111111111111111111111111112' }, {}), /closed/);
});
