import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PublicKey,VersionedTransaction,SystemProgram} from '@solana/web3.js';
import {DAMM_PUMP_TEST_DEPLOYMENT_POLICY as P,deriveDammPumpTestDeployment,validateDammPumpTestDeploymentBinary,inspectDammPumpTestDeployment,buildDammPumpTestDeploymentBatch} from '../src/damm-pump-test-deployment.mjs';
// Runs against your own build of the program (build it with the script in contracts/, set its hash in the deployment
// pins, then copy the .so to this path); skipped without it.
const binary=await readFile(new URL('../private/damm-pump-admin-test/curve_damm_pump_admin_test.so',import.meta.url)).catch(()=>null);
const SKIP=binary?false:'private/damm-pump-admin-test/curve_damm_pump_admin_test.so is not present';
const loader=new PublicKey(P.loader),operator=new PublicKey(P.operator),blockhash=PublicKey.default.toBase58();
const rent={buffer:862650040,program:833120,data:862690680};
function buffer(code=Buffer.alloc(P.binaryLength)) {const data=Buffer.alloc(37+code.length);data.writeUInt32LE(1);data[4]=1;operator.toBuffer().copy(data,5);code.copy(data,37);return{owner:loader,executable:false,data,lamports:rent.buffer};}
function program(){const data=Buffer.alloc(36);data.writeUInt32LE(2);new PublicKey(P.programData).toBuffer().copy(data,4);return{owner:loader,executable:true,data,lamports:rent.program};}
function programData(){const data=Buffer.alloc(45+P.binaryLength);data.writeUInt32LE(3);data.writeBigUInt64LE(100n,4);data[12]=1;operator.toBuffer().copy(data,13);binary.copy(data,45);return{owner:loader,executable:false,data,lamports:rent.data};}
function rpc(accounts=[null,null,null],options={}){return{getGenesisHash:async()=>options.genesis||P.genesisHash,getMultipleAccountsInfoAndContext:async()=>({context:{slot:200},value:accounts}),getMinimumBalanceForRentExemption:async size=>options.rent??(size===36?rent.program:size===37+P.binaryLength?options.bufferRent??rent.buffer:rent.data)};}
const inspect=(accounts,options)=>inspectDammPumpTestDeployment({connection:rpc(accounts,options),binary});
const build=inspection=>buildDammPumpTestDeploymentBatch({binary,inspection,blockhash,lastValidBlockHeight:1000});
const decoded=t=>VersionedTransaction.deserialize(Buffer.from(t.transactionBase64,'base64'));

test('fixed seeded identities and binary integrity',{skip:SKIP},async()=>{
 assert.equal((await deriveDammPumpTestDeployment()).programId,P.programId);assert.deepEqual(validateDammPumpTestDeploymentBinary(binary),binary);
 const changed=Buffer.from(binary);changed[100]^=1;assert.throws(()=>validateDammPumpTestDeploymentBinary(changed),/reviewed/);assert.throws(()=>validateDammPumpTestDeploymentBinary(binary.subarray(1)),/reviewed/);
});
test('create-buffer is atomic, one signer, bounded rent, v0',{skip:SKIP},async()=>{
 const s=await inspect();assert.equal(s.stage,'create-buffer');assert.equal(s.rent.retainedLamports,'863523800');
 const b=build(s);assert.equal(b.transactions.length,1);assert.equal(b.maxWalletDebitLamports,'862650040');
 const tx=decoded(b.transactions[0]);assert.equal(tx.version,0);assert.equal(tx.message.header.numRequiredSignatures,1);assert.equal(tx.message.staticAccountKeys[0].toBase58(),P.operator);assert.equal(tx.message.compiledInstructions.length,3);assert.ok(tx.signatures.every(sig=>sig.every(x=>x===0)));assert.ok(b.transactions[0].serializedBytes<=1232);
});
test('resume checks every uploaded byte, skips complete chunks, caps 25 transactions',{skip:SKIP},async()=>{
 const a=buffer();binary.subarray(0,900).copy(a.data,37);const s=await inspect([null,null,a]);assert.equal(s.stage,'write-buffer');assert.ok(!s.chunks.pendingIndices.includes(0));
 const b=build(s);assert.equal(b.transactions.length,25);assert.equal(b.maxWalletDebitLamports,'0');
 for(const t of b.transactions){assert.equal(t.kind,'write-buffer');assert.ok(t.serializedBytes<=1232);const tx=decoded(t);assert.equal(tx.message.header.numRequiredSignatures,1);assert.equal(tx.message.compiledInstructions.length,2);const ix=Buffer.from(tx.message.compiledInstructions[1].data);assert.equal(ix.readUInt32LE(0),1);assert.equal(ix.readUInt32LE(4),t.offset);assert.equal(ix.readBigUInt64LE(8),BigInt(t.dataLength));assert.deepEqual(ix.subarray(16),binary.subarray(t.offset,t.offset+t.dataLength));}
});
test('full upload permits atomic create-program/deploy; buffer rent reused',{skip:SKIP},async()=>{
 const s=await inspect([null,null,buffer(binary)]);assert.equal(s.stage,'deploy-program');assert.equal(s.rent.remainingRentLamports,'873760');const b=build(s);assert.equal(b.maxWalletDebitLamports,'873760');
 const tx=decoded(b.transactions[0]);assert.equal(tx.message.compiledInstructions.length,3);const ix=Buffer.from(tx.message.compiledInstructions[2].data);assert.equal(ix.readUInt32LE(),2);assert.equal(ix.readBigUInt64LE(4),BigInt(binary.length));assert.equal(tx.message.header.numRequiredSignatures,1);
});
test('verified deployed code returns no transactions; later buffer donation irrelevant',{skip:SKIP},async()=>{
 const s=await inspect([program(),programData(),{owner:SystemProgram.programId,data:Buffer.alloc(0),lamports:1,executable:false}]);assert.equal(s.stage,'deployed');assert.equal(s.verifiedDeployment.slot,100);assert.equal(s.rent.remainingRentLamports,'0');assert.equal(build(s).transactions.length,0);
});
test('wrong network, excessive rent and malformed costs fail closed',{skip:SKIP},async()=>{
 await assert.rejects(inspect(undefined,{genesis:'wrong'}),/mainnet/);await assert.rejects(inspect(undefined,{rent:3000000001}),/rent/);await assert.rejects(inspect(undefined,{rent:NaN}),/rent/);await assert.rejects(inspect(undefined,{bufferRent:3000000001}),/rent/);
});
test('public prefunding/occupied program, ProgramData and buffer fail closed',{skip:SKIP},async()=>{
 const dust={owner:SystemProgram.programId,data:Buffer.alloc(0),lamports:1,executable:false};
 await assert.rejects(inspect([dust,null,null]),/ProgramData/);await assert.rejects(inspect([null,dust,null]),/occupied/);await assert.rejects(inspect([null,null,dust]),/unexpected owner/);
});
test('buffer owner, authority, length and partial corruption rejected',{skip:SKIP},async()=>{
 const cases=[a=>{a.owner=SystemProgram.programId;},a=>{a.data[5]^=1;},a=>{a.data=a.data.subarray(1);},a=>{a.data[37+901]=255;}];
 for(const mutate of cases){const a=buffer();mutate(a);await assert.rejects(inspect([null,null,a]));}
});
test('deployed code/authority/identity changes rejected',{skip:SKIP},async()=>{
 const p=program();p.data[5]^=1;await assert.rejects(inspect([p,programData(),null]),/expected executable/);
 for(const mutate of[d=>{d.data[13]^=1;},d=>{d.data[100]^=1;},d=>{d.data.writeBigUInt64LE(201n,4);},d=>{d.data=Buffer.concat([d.data,Buffer.from([1])]);}]){const d=programData();mutate(d);await assert.rejects(inspect([program(),d,null]));}
});
test('forged JSON inspection, binary substitution and invalid batches cannot build',{skip:SKIP},async()=>{
 const s=await inspect();assert.throws(()=>build(JSON.parse(JSON.stringify(s))),/in-process/);assert.throws(()=>{s.stage='deploy-program';},TypeError);
 const base={binary,inspection:s,blockhash,lastValidBlockHeight:1000};
 for(const maxTransactions of[0,26,1.5])assert.throws(()=>buildDammPumpTestDeploymentBatch({...base,maxTransactions}),/batch/);
 assert.throws(()=>buildDammPumpTestDeploymentBatch({...base,lastValidBlockHeight:-1}),/height/);assert.throws(()=>buildDammPumpTestDeploymentBatch({...base,blockhash:'not a hash'}));
 const changed=Buffer.from(binary);changed[100]^=1;assert.throws(()=>buildDammPumpTestDeploymentBatch({...base,binary:changed}),/reviewed/);
});
