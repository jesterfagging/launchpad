import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {PumpFundedClientAdapter} from '../src/pump-funded-test-service.mjs';
import {deriveAddresses,PUMP} from '../scripts/pump-private-test.mjs';
import {OWNER,TREASURY,SEEDED_PROGRAM,PINS,GENESIS} from '../src/pump-test-binding.mjs';

// Independent adapter integration: actual client verification and actual shipped
// owner ELF, with read-only RPC account fixtures. No keys or signatures exist.
const ROOT=new URL('../',import.meta.url),LOADER='BPFLoaderUpgradeab1e11111111111111111111111';
const VB=1372346627033820n,CAP=758614557685785n;
// These run against your own owner build (private/pump-owner-test/) and a captured Pump program binary
// (private/pump-mainnet.so); neither is bundled.
const binary=await readFile(new URL('private/pump-owner-test/curve_pump_test_OWNER_REQUIRES_REVIEW.so',ROOT)).catch(()=>null);
const pumpBinary=await readFile(new URL('private/pump-mainnet.so',ROOT)).catch(()=>null);
const rawManifest=binary?JSON.parse(await readFile(new URL('private/pump-owner-test/owner-build-unbound.json',ROOT),'utf8')):null;
const SKIP=binary&&pumpBinary&&rawManifest?false:'the owner build in private/pump-owner-test/ and private/pump-mainnet.so are not present';
const wrap=(data,owner,executable=false,lamports=10000000)=>({owner,executable,lamports,data:[data.toString('base64'),'base64']});
const header=address=>{const b=Buffer.alloc(36);b.writeUInt32LE(2);new PublicKey(address).toBuffer().copy(b,4);return b;};
const pdata=bytes=>{const b=Buffer.alloc(45);b.writeUInt32LE(3);b.writeBigUInt64LE(123n,4);b[12]=1;new PublicKey(OWNER).toBuffer().copy(b,13);return Buffer.concat([b,bytes]);};
async function fixture(t,{phase=1,changedPump=true}={}){
 const dir=await mkdtemp(join(tmpdir(),'launchpad-adapter-security-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const config={schemaVersion:1,cluster:'mainnet-beta',rpcUrl:'https://rpc.invalid/',operator:OWNER,treasury:TREASURY,programId:SEEDED_PROGRAM.programId,expectedProgramSha256:PINS.binarySha256,expectedDeploymentSlot:'123',expectedUpgradeAuthority:OWNER,buildManifest:'owner.json',mintSeed:'adapter-security-fixture',graduationFeeBps:2885,tradeFeeBps:100,migrationRentLamports:'100000000',maxWalletSpendLamports:'3300000000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:1000,solUsdMicros:'150000000',priceObservedAt:new Date().toISOString()};
 await writeFile(join(dir,'owner.json'),JSON.stringify({...rawManifest,programId:config.programId}),{mode:0o600});
 const a=await deriveAddresses(config),programData=PublicKey.findProgramAddressSync([new PublicKey(config.programId).toBuffer()],new PublicKey(LOADER))[0],pumpData=PublicKey.findProgramAddressSync([PUMP.toBuffer()],new PublicKey(LOADER))[0];
 const accounts=new Map([[config.programId,wrap(header(programData),LOADER,true)],[programData.toBase58(),wrap(pdata(binary),LOADER)],[PUMP.toBase58(),wrap(header(pumpData),LOADER,true)],[pumpData.toBase58(),wrap(pdata(changedPump?Buffer.from('different Pump executable'):pumpBinary),LOADER)]]);
 if(phase!==null){
  const state=Buffer.alloc(256);state.write('CRVPTEST');state[8]=phase;new PublicKey(OWNER).toBuffer().copy(state,16);new PublicKey(TREASURY).toBuffer().copy(state,48);a.mint.toBuffer().copy(state,80);
  [VB-CAP,3000000000n,CAP,CAP,2000000000n,890880n,2885n,100n,VB,914897751n].forEach((v,i)=>state.writeBigUInt64LE(v,112+i*8));
  accounts.set(a.state.toBase58(),wrap(state,config.programId));accounts.set(a.authority.toBase58(),wrap(Buffer.alloc(0),'11111111111111111111111111111111',false,2200000000));
  const held=Buffer.alloc(165);a.mint.toBuffer().copy(held,0);new PublicKey(OWNER).toBuffer().copy(held,32);held.writeBigUInt64LE(CAP,64);held[108]=1;accounts.set(a.operatorAta.toBase58(),wrap(held,TOKEN_PROGRAM_ID.toBase58()));
 }
 const calls=[];
 const rpc=async(method,params=[])=>{calls.push(method);switch(method){
  case'getGenesisHash':return GENESIS['mainnet-beta'];
  case'getAccountInfo':return {context:{slot:200},value:accounts.get(params[0])||null};
  case'getLatestBlockhash':return {value:{blockhash:OWNER,lastValidBlockHeight:999}};
  case'getBlockHeight':return 200;
  case'getFeeForMessage':return {value:10000};
  case'getBalance':return {value:5000000000};
  case'simulateTransaction':return {value:{err:null,unitsConsumed:100000}};
  default:assert.fail(`Unexpected RPC ${method}; no network or send is allowed`);
 }};
 return {adapter:new PumpFundedClientAdapter({configPath:join(dir,'unused.json')}),loaded:{config,configDir:dir},rpc,calls,accounts,programData};
}

test('actual adapter keeps funded status and unsigned recovery available after Pump upgrades',{skip:SKIP},async t=>{
 const f=await fixture(t),status=await f.adapter.status(f.loaded,f.rpc);
 assert.equal(status.pumpCompatible,false);assert.equal(status.phase,'bonded');assert.deepEqual(status.actions,['sell-recovery']);assert.match(status.blockers[0],/recovered/);
 const plan=await f.adapter.prepare(f.loaded,f.rpc,'sell-recovery');assert.equal(plan.command,'sell-recovery');assert.equal(plan.transactionVersion,0);assert.match(plan.deployment.pumpCheck,/redemption/);
 assert.ok(!f.calls.includes('sendTransaction'));
});

test('upgraded Pump cannot enable new funding; intact compatibility permits reviewed actions',{skip:SKIP},async t=>{
 const missing=await fixture(t,{phase:null}),status=await missing.adapter.status(missing.loaded,missing.rpc);assert.deepEqual(status.actions,[]);
 await assert.rejects(()=>missing.adapter.prepare(missing.loaded,missing.rpc,'initialize'),/PumpSwap changed/);
 const intact=await fixture(t,{changedPump:false}),ready=await intact.adapter.status(intact.loaded,intact.rpc);assert.equal(ready.pumpCompatible,true);assert.deepEqual(ready.actions,['sell-recovery','migrate']);
});

test('recovery compatibility fallback never bypasses custody-program bytecode verification',{skip:SKIP},async t=>{
 const f=await fixture(t);f.accounts.set(f.programData.toBase58(),wrap(pdata(Buffer.alloc(binary.length,1)),LOADER));
 await assert.rejects(()=>f.adapter.status(f.loaded,f.rpc),/binary does not match/);
 await assert.rejects(()=>f.adapter.prepare(f.loaded,f.rpc,'sell-recovery'),/binary does not match/);
 assert.ok(!f.calls.includes('simulateTransaction'));
});
