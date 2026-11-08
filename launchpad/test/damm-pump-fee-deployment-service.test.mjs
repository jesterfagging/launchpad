import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Keypair,PublicKey,SystemProgram,VersionedTransaction} from '@solana/web3.js';
import {DAMM_PUMP_FEE_DEPLOYMENT_POLICY as P} from '../src/damm-pump-fee-deployment.mjs';
import {DAMM_PUMP_DEPLOYMENT_POLICY as LEGACY} from '../src/damm-pump-deployment.mjs';
import {DammPumpFeeDeploymentService,verifyDammPumpFeeDeployment,DAMM_PUMP_FEE_CONFIG_ADDRESS} from '../src/damm-pump-fee-deployment-service.mjs';

// Runs against your own build of the program (build it with the script in contracts/, set its hash in the deployment
// pins, then copy the .so to this path); skipped without it.
const binary=await readFile(new URL('../private/damm-pump-fee/curve_damm_pump_fee.so',import.meta.url)).catch(()=>null);
const SKIP=binary?false:'private/damm-pump-fee/curve_damm_pump_fee.so is not present';
const admin=new PublicKey(P.operator),loader=new PublicKey(P.loader),programId=new PublicKey(P.programId);
const relayer=Keypair.fromSeed(new Uint8Array(32).fill(41)).publicKey.toBase58(),foreignRelayer=Keypair.fromSeed(new Uint8Array(32).fill(42)).publicKey.toBase58();
const session={account:{id:'owner',role:'admin',mfaEnabled:true}},context={sessionToken:'authenticated-public-test-session',authorize:async()=>{}};
function program(){const data=Buffer.alloc(36);data.writeUInt32LE(2);new PublicKey(P.programData).toBuffer().copy(data,4);return{owner:loader,executable:true,data,lamports:1000000};}
function programData(){const data=Buffer.alloc(45+binary.length);data.writeUInt32LE(3);data.writeBigUInt64LE(100n,4);data[12]=1;admin.toBuffer().copy(data,13);binary.copy(data,45);return{owner:loader,executable:false,data,lamports:1000000000};}
function global(enabled=false,address=relayer){const data=Buffer.alloc(128);Buffer.from('CRVPCFG1').copy(data);data[8]=1;data[9]=enabled?1:0;admin.toBuffer().copy(data,16);new PublicKey(P.treasury).toBuffer().copy(data,48);new PublicKey(address).toBuffer().copy(data,80);return{owner:programId,executable:false,data,lamports:1000000};}
function config(){return{schemaVersion:1,cluster:'mainnet-beta',programId:P.programId,expectedProgramSha256:P.binarySha256,expectedDeploymentSlot:'100',expectedUpgradeAuthority:P.operator,treasury:P.treasury,relayer,enabled:false};}
async function fixture(t,{configured=false,enabled=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'public-deployment-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const state={global:configured?global(enabled):null,program:program(),data:programData(),allowed:true,installed:null,installs:0,sends:0,rechecks:0,fullReads:0};
 const connection={getGenesisHash:async()=>P.genesisHash,getMultipleAccountsInfoAndContext:async(keys,options)=>{
  if(options?.dataSlice)state.rechecks++;else state.fullReads++;
  return{context:{slot:210+state.rechecks},value:keys.map(k=>{const a=k.toBase58()===P.programId?state.program:k.toBase58()===P.programData?state.data:k.equals(new PublicKey(DAMM_PUMP_FEE_CONFIG_ADDRESS))?state.global:null;return a&&options?.dataSlice?{...a,data:a.data.subarray(options.dataSlice.offset,options.dataSlice.offset+options.dataSlice.length)}:a;})};
 },getAccountInfoAndContext:async(key)=>{assert.equal(key.toBase58(),DAMM_PUMP_FEE_CONFIG_ADDRESS);return{context:{slot:210+state.rechecks},value:state.global};},getMinimumBalanceForRentExemption:async()=>1000000,
 getBlockHeight:async()=>10,getLatestBlockhash:async()=>({blockhash:PublicKey.default.toBase58(),lastValidBlockHeight:100}),getFeeForMessage:async()=>({value:5000}),getBalance:async()=>10000000000,simulateTransaction:async()=>({value:{err:null}}),sendRawTransaction:async()=>{state.sends++;throw Error('must not send in test');}};
 const service=new DammPumpFeeDeploymentService({accounts:{dir},connection,requireOwner:async()=>{assert.ok(state.allowed,'Forbidden');},ensureRelayer:async()=>({address:relayer}),deploymentConfig:async()=>state.installed,installDeployment:async(c)=>{state.installed=c;state.installs++;}});
 return{dir,state,connection,service};
}
test('loader verification alone does not configure or enable public launches',{skip:SKIP},async t=>{
 const f=await fixture(t),status=await f.service.status(session,context);
 assert.equal(status.stage,'deployed');assert.equal(status.configured,false);assert.equal(status.chainEnabled,false);assert.equal(f.state.installs,0);
 const setup=await f.service.configuration.status(session,context);assert.equal(setup.stage,'configure-disabled');assert.equal(setup.relayer,relayer);
});
test('configuration review fixes admin, treasury policy, relayer and explicit enabled byte',{skip:SKIP},async t=>{
 const f=await fixture(t),plan=await f.service.configuration.prepare(session,{enabled:false,wallet:P.operator},context);
 assert.equal(plan.pendingSignatures.length,1);assert.equal(plan.maxWalletDebitLamports,'1005000');assert.equal(plan.stage,'configure-disabled');
 const tx=VersionedTransaction.deserialize(Buffer.from(plan.pendingSignatures[0].transaction,'base64'));
 assert.equal(tx.message.header.numRequiredSignatures,1);assert.equal(tx.message.staticAccountKeys[0].toBase58(),P.operator);
 const instruction=tx.message.compiledInstructions.at(-1);assert.equal(tx.message.staticAccountKeys[instruction.programIdIndex].toBase58(),P.programId);
 const data=Buffer.from(instruction.data);assert.equal(data[0],4);assert.equal(new PublicKey(data.subarray(1,33)).toBase58(),relayer);assert.equal(data[33],0);
 assert.equal(tx.message.staticAccountKeys[instruction.accountKeyIndexes[1]].toBase58(),DAMM_PUMP_FEE_CONFIG_ADDRESS);assert.equal(f.state.sends,0);
 await assert.rejects(f.service.configuration.prepare(session,{enabled:true},context),/prior configuration/);
 await assert.rejects(f.service.configuration.submit(session,{planId:plan.planId,signedTransactions:plan.pendingSignatures.map(x=>x.transaction)},context),/signature/);
 assert.equal(f.state.sends,0);
});
test('disabled finalized configuration binds once without making server public',{skip:SKIP},async t=>{
 const f=await fixture(t,{configured:true});const first=await f.service.configuration.status(session,context);
 assert.equal(first.configured,true);assert.equal(first.canPrepare,true);assert.equal(first.chainEnabled,false);assert.equal(f.state.installs,1);assert.equal(f.state.installed.enabled,false);
 f.state.installed.enabled=true;await f.service.configuration.status(session,context);assert.equal(f.state.installs,1);assert.equal(f.state.installed.enabled,true);
 const plan=await f.service.configuration.prepare(session,{enabled:true},context);assert.equal(plan.stage,'configure-enabled');assert.equal(plan.maxWalletDebitLamports,'5000');
 const tx=VersionedTransaction.deserialize(Buffer.from(plan.pendingSignatures[0].transaction,'base64'));assert.equal(tx.message.compiledInstructions.at(-1).data[33],1);
});
test('reviewed legacy deployment transitions once with the same graduation wallet',{skip:SKIP},async t=>{
 const f=await fixture(t,{configured:true});
 const prior={...config(),programId:LEGACY.programId,expectedProgramSha256:LEGACY.binarySha256,expectedUpgradeAuthority:LEGACY.operator,treasury:LEGACY.treasury,expectedDeploymentSlot:'88'};
 f.state.installed=prior;
 await f.service.configuration.status(session,context);
 assert.equal(f.state.installs,1);assert.equal(f.state.installed.programId,P.programId);
 assert.equal(f.state.installed.relayer,prior.relayer);assert.equal(prior.programId,LEGACY.programId);
 await f.service.configuration.status(session,context);assert.equal(f.state.installs,1);
});
test('legacy transition rejects unknown code, recipients, or an altered fee binding',{skip:SKIP},async t=>{
 const f=await fixture(t,{configured:true});
 const prior={...config(),programId:LEGACY.programId,expectedProgramSha256:LEGACY.binarySha256,expectedUpgradeAuthority:LEGACY.operator,treasury:LEGACY.treasury};
 for(const changed of [{...prior,expectedProgramSha256:'0'.repeat(64)},{...prior,relayer:foreignRelayer},{...prior,treasury:foreignRelayer},{...prior,expectedDeploymentSlot:'bad'},{...config(),expectedDeploymentSlot:'99'}]){
  f.state.installed=changed;
  await assert.rejects(f.service.configuration.status(session,context),/binding differs/);
  assert.equal(f.state.installs,0);
 }
});
test('wrong config recipients, changed code or slot, and wrong network fail closed',{skip:SKIP},async t=>{
 const f=await fixture(t,{configured:true});const checked=await verifyDammPumpFeeDeployment({connection:f.connection,config:config()});assert.equal(checked.chainEnabled,false);assert.ok(f.state.rechecks>0);
 f.state.global=global(false,foreignRelayer);await assert.rejects(verifyDammPumpFeeDeployment({connection:f.connection,config:config()}),/relayer/);assert.equal(f.state.installs,0);
 f.state.global=global(false);f.state.data.data[100]^=1;await assert.rejects(verifyDammPumpFeeDeployment({connection:{...f.connection},config:config()}),/bytes/);
 f.state.data=programData();await assert.rejects(verifyDammPumpFeeDeployment({connection:f.connection,config:{...config(),expectedDeploymentSlot:'101'}}),/slot/);
 f.connection.getGenesisHash=async()=> 'wrong';await assert.rejects(verifyDammPumpFeeDeployment({connection:f.connection,config:config()}),/mainnet/);
});
test('configuration requires fresh admin auth and rejects parameter injection',{skip:SKIP},async t=>{
 const f=await fixture(t);await assert.rejects(f.service.configuration.prepare(session,{enabled:true,treasury:foreignRelayer},context),/explicit/);
 await assert.rejects(f.service.configuration.prepare(session,{enabled:'true'},context),/explicit/);
 f.state.allowed=false;await assert.rejects(f.service.configuration.status(session,context),/Forbidden/);assert.equal(f.state.installs,0);assert.equal(f.state.sends,0);
});
test('setup journals cannot overwrite legacy and private deployment records',{skip:SKIP},async t=>{
 const f=await fixture(t);await f.service.configuration.prepare(session,{enabled:false},context);
 const journal=JSON.parse(await readFile(join(f.dir,'damm-pump-fee-deployment/configuration/deployment-journal.json'),'utf8'));assert.equal(journal.binarySha256,P.binarySha256);
 await assert.rejects(readFile(join(f.dir,'pump-owner-test/deployment-journal.json')),{code:'ENOENT'});
 await assert.rejects(readFile(join(f.dir,'pump-test-config.json')),{code:'ENOENT'});
 await assert.rejects(readFile(join(f.dir,'damm-pump-deployment/configuration/deployment-journal.json')),{code:'ENOENT'});
 await assert.rejects(readFile(join(f.dir,'damm-pump-test-deployment/configuration/deployment-journal.json')),{code:'ENOENT'});
});

test('unsolicited configuration dust reduces required rent and does not prevent setup',{skip:SKIP},async t=>{
 const f=await fixture(t);f.state.global={owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0),lamports:100};
 const plan=await f.service.configuration.prepare(session,{enabled:false},context);assert.equal(plan.maxWalletDebitLamports,'1004900');assert.equal(f.state.sends,0);
});

test('repeated verification caches ELF but always checks finalized headers and config',{skip:SKIP},async t=>{
 const f=await fixture(t,{configured:true});await verifyDammPumpFeeDeployment({connection:f.connection,config:config()});const reads=f.state.fullReads;
 await verifyDammPumpFeeDeployment({connection:f.connection,config:config()});assert.equal(f.state.fullReads,reads);assert.equal(f.state.rechecks,2);
 f.state.global=global(true);assert.equal((await verifyDammPumpFeeDeployment({connection:f.connection,config:config()})).chainEnabled,true);
 f.state.data.data.writeBigUInt64LE(101n,4);await assert.rejects(verifyDammPumpFeeDeployment({connection:f.connection,config:config()}),/changed during/);
});
