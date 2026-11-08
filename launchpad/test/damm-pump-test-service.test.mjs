import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { DammPumpService, DAMM_PUMP_DEFAULTS, DAMM_PUMP_SOL, DAMM_PUMP_TREASURY } from '../src/damm-pump-service.mjs';
import { DammPumpTestService, DAMM_PUMP_TEST_OWNER } from '../src/damm-pump-test-service.mjs';

const address=()=>Keypair.generate().publicKey.toBase58();
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-damm-test-service-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const production={schemaVersion:1,config:{programId:address()},relayer:{address:address(),secretBase64:'production-secret'},launches:[{mint:address(),creatorId:'owner',status:'trading'}],operations:[{id:'production-op'}]};
  const stores=new Map([['damm-pump',structuredClone(production)]]),accounts={dir,hostStore:{read:async(key,fallback)=>structuredClone(stores.get(key)??fallback),write:async(key,value)=>stores.set(key,structuredClone(value))}};
  let now=1790000000000,preparations=0,ownerChecks=0;
  const program=Keypair.generate().publicKey,adapter={verifyDeployment:async()=>({enabled:true}),balance:async()=>'30000000',deriveMint:async(wallet,seed)=>(await PublicKey.createWithSeed(new PublicKey(wallet),seed,TOKEN_PROGRAM_ID)).toBase58(),prepare:async(_config,args)=>{
    preparations++;const owner=new PublicKey(args.wallet),needsRelayer=args.action==='initialize';const ix=new TransactionInstruction({programId:program,keys:[{pubkey:owner,isSigner:true,isWritable:true},...(needsRelayer?[{pubkey:new PublicKey(args.relayer),isSigner:true,isWritable:false}]:[])],data:Buffer.from([6])});
    const tx=new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:address(),instructions:[ix]}).compileToV0Message());
    return {unsignedTransaction:Buffer.from(tx.serialize()).toString('base64'),needsRelayer,review:{initialFdvUsd:20000,graduationFdvUsd:50000,maxWalletDebitLamports:'5000'},lookupTables:args.action==='configure'?[{address:address(),addresses:[address()]}]:args.launch.lookupTables,addresses:{authority:address(),state:address(),dammPool:address()}};
  }};
  const pair={mint:DAMM_PUMP_SOL,decimals:9,tokenProgram:TOKEN_PROGRAM_ID.toBase58(),launchReady:true,symbol:'SOL',name:'Solana'};
  const options={accounts,adapter,requireOwner:async session=>{ownerChecks++;if(session.account.id!=='owner')throw Object.assign(Error('Not configured owner'),{statusCode:403});},listPairs:async()=>[pair],quoteEligibility:async()=>pair,getQuotePrice:async()=>({mint:DAMM_PUMP_SOL,usd:200,at:now}),publishMetadata:async()=> 'https://launchpad.test/metadata.json',now:()=>now};
  const service=new DammPumpTestService(options);service.closed=true;
  const session={account:{id:'owner',role:'admin',mfaEnabled:true},mfaVerified:true,walletVerified:false,walletAddress:address()},context={sessionToken:'owner-mfa-session',authorize:async()=>session};
  const input={action:'configure',expectedWallet:DAMM_PUMP_TEST_OWNER,name:'Launchpad graduation test',symbol:'CTEST',quoteMint:DAMM_PUMP_SOL,firstBuySolLamports:'1000000'};
  await service.setup(session,{},context);const relayer=stores.get('damm-pump-test').relayer.address;await service.installDeployment({schemaVersion:1,cluster:'mainnet-beta',programId:program.toBase58(),relayer,treasury:DAMM_PUMP_TREASURY});
  return {service,options,session,context,input,adapter,accounts,stores,production,get preparations(){return preparations;},get ownerChecks(){return ownerChecks;},setNow:value=>{now=value;}};
}

test('private micro launch uses separate keys, config, history and fixed $50/$100 defaults without changing production',async t=>{
  const f=await fixture(t),status=await f.service.ownerStatus(f.session,f.context);assert.equal(status.ownerWallet,DAMM_PUMP_TEST_OWNER);assert.equal(status.defaults.initialFdvUsd,50);assert.equal(status.defaults.graduationFdvUsd,100);assert.equal(status.creationFeeLamports,'0');assert.equal(status.adminTest,true);
  assert.notEqual(f.stores.get('damm-pump-test').relayer.address,f.production.relayer.address);assert.notEqual(f.stores.get('damm-pump-test').config.programId,f.production.config.programId);
  const prepared=await f.service.prepare(f.session,f.input,f.context);assert.equal(prepared.operation.review.initialFdvUsd,50);assert.equal(prepared.operation.review.graduationFdvUsd,100);assert.equal(prepared.launch.platform,'damm-pump-test');assert.equal(prepared.launch.initialFdvUsd,50);assert.equal(prepared.launch.image,'/brand-icon.svg');
  const launch=f.stores.get('damm-pump-test').launches[0];assert.match(launch.mintSeed,/^c[A-Za-z0-9_-]{16}$/);assert.equal(launch.creationFee.lamports,'0');assert.equal(launch.creatorWallet,DAMM_PUMP_TEST_OWNER);assert.deepEqual(f.stores.get('damm-pump'),f.production);
  const publicService=new DammPumpService(f.options);assert.equal(publicService.storeName,'damm-pump');assert.strictEqual(publicService.defaults,DAMM_PUMP_DEFAULTS);assert.equal(publicService.defaults.initialFdvUsd,20000);assert.equal(publicService.defaults.graduationFdvUsd,50000);
  assert.equal((await f.service.listAccount(f.session,f.context)).length,1);assert.deepEqual(await f.service.publicList(),[]);assert.deepEqual(await f.service.analyticsList(),[]);assert.equal(await f.service.publicDetail(prepared.launch.mint),null);assert.deepEqual(await f.service.analyticsTrades(prepared.launch.mint),{trades:[],complete:false});
});

test('private test accepts a password plus MFA owner session but fixes the transaction wallet and rejects all access downgrades',async t=>{
  const f=await fixture(t);assert.equal(f.session.walletVerified,false);assert.notEqual(f.session.walletAddress,DAMM_PUMP_TEST_OWNER);
  await assert.rejects(f.service.prepare(f.session,{...f.input,expectedWallet:f.session.walletAddress},f.context),/fixed owner wallet/);assert.equal(f.preparations,0);
  for(const changed of [{account:{...f.session.account,role:'user'}},{account:{...f.session.account,mfaEnabled:false}},{account:{...f.session.account,banned:true}},{mfaVerified:false,walletVerified:false}]){
    const session={...f.session,...changed},context={...f.context,authorize:async()=>session};await assert.rejects(f.service.prepare(session,f.input,context),/administrator with two-factor/);await assert.rejects(f.service.listAccount(session,context),/administrator with two-factor/);
  }
  const other={...f.session,account:{...f.session.account,id:'other-owner'}};await assert.rejects(f.service.ownerStatus(other,{...f.context,authorize:async()=>other}),/Not configured owner/);
  await assert.rejects(f.service.operations(f.session,{...f.context,authorize:async()=>other}),/owner session changed/);
  const prepared=await f.service.prepare(f.session,f.input,f.context);assert.equal(prepared.operation.wallet,DAMM_PUMP_TEST_OWNER);assert(f.ownerChecks>3);
});

test('test economics, storage and controller cannot be selected from launch request input',async t=>{
  const f=await fixture(t);
  for(const extra of [{initialFdvUsd:1},{graduationFdvUsd:2},{storeName:'damm-pump'},{programId:f.production.config.programId},{relayer:f.production.relayer.address},{testMode:false},{defaults:{initialFdvUsd:20000}}])await assert.rejects(f.service.prepare(f.session,{...f.input,...extra},f.context),/Unsupported/);
  assert.equal(f.preparations,0);assert.deepEqual(f.stores.get('damm-pump'),f.production);
});

test('private market inspection returns finalized migration deposits and LP receipt without exposing relayer secrets',async t=>{
  const f=await fixture(t),prepared=await f.service.prepare(f.session,f.input,f.context),stored=f.stores.get('damm-pump-test'),launch=stored.launches[0];launch.status='migrated';launch.migrationSignature='migration-signature';launch.burnReceipt={state:'finalized',phase:'migrated',issuedLpAtoms:'123',burnedLpAtoms:'123',retainedLpAtoms:'0',poolId:address()};
  f.adapter.marketSnapshot=async()=>({phase:'migrated',progressPercent:100,fdvUsd:100});f.adapter.state=async()=>({phase:'migrated',baseMigrated:'8000000',quoteMigrated:'100000',burnedLp:'123',poolId:launch.burnReceipt.poolId,quoteUsdMicros:'200000000'});
  const result=await f.service.market(f.session,{mint:prepared.launch.mint},f.context);assert.equal(result.market.progressPercent,100);assert.equal(result.migration.baseMigratedRaw,'8000000');assert.equal(result.migration.quoteMigratedRaw,'100000');assert.equal(result.burnReceipt.issuedLpAtoms,result.burnReceipt.burnedLpAtoms);assert.equal(result.burnReceipt.retainedLpAtoms,'0');assert.equal(result.migrationSignature,'migration-signature');assert.equal(result.priceReference.usd,'200');assert.doesNotMatch(JSON.stringify(result),/secretBase64|production-secret|sessionHash|signedTransaction/);
  await assert.rejects(f.service.market(f.session,{mint:f.production.launches[0].mint},f.context),/not found/);assert.deepEqual(f.stores.get('damm-pump'),f.production);
});

test('private test preparation reauthorizes after network work and cannot commit after owner revocation',async t=>{
  const f=await fixture(t),prepare=f.adapter.prepare;f.adapter.prepare=async(...args)=>{const bundle=await prepare(...args);f.context.authorize=async()=>({...f.session,account:{...f.session.account,role:'user'}});return bundle;};await assert.rejects(f.service.prepare(f.session,f.input,f.context),/administrator with two-factor/);assert.equal(f.stores.get('damm-pump-test').operations.length,0);assert.equal(f.stores.get('damm-pump-test').launches.length,0);
});
