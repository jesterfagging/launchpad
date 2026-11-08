import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Keypair,PublicKey,Transaction,VersionedTransaction,TransactionMessage,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {sha256,validateConfig,deriveAddresses,verifyDeployment,buildOperation,prepare,executePrepared,reconcileReceipt,verifyJournal,PUMP,createRpc,submitSignedPlan,inspectTransaction,verifyWebConfigBinding} from '../scripts/pump-private-test.mjs';
import {createSeededBinding,OWNER,TREASURY,SEEDED_PROGRAM,PINS} from '../src/pump-test-binding.mjs';
const ROOT=new URL('../',import.meta.url),LOADER='BPFLoaderUpgradeab1e11111111111111111111111';
const SUPPLY=1000000000000000n,VB=1372346627033820n,CAP=758614557685785n;
const source=await readFile(new URL('contracts/curve-pump-test/src/lib.rs',ROOT)),lock=await readFile(new URL('contracts/curve-pump-test/Cargo.lock',ROOT)),build=await readFile(new URL('contracts/curve-pump-test/build.rs',ROOT));
// Pump's mainnet program binary is third-party code and is not bundled; put a captured copy at private/pump-mainnet.so.
const pumpBinary=await readFile(new URL('private/pump-mainnet.so',ROOT)).catch(()=>null);
const SKIP=pumpBinary?false:'private/pump-mainnet.so (a captured Pump program binary) is not present';
const owner=Keypair.generate(),treasury=Keypair.generate(),program=Keypair.generate(),programData=Keypair.generate(),pumpData=Keypair.generate();
const binary=Buffer.from('mock reviewed owner program');
const config={schemaVersion:1,cluster:'mainnet-beta',rpcUrl:'https://api.mainnet-beta.solana.com',operator:owner.publicKey.toBase58(),treasury:treasury.publicKey.toBase58(),programId:program.publicKey.toBase58(),expectedProgramSha256:sha256(binary),expectedDeploymentSlot:'123',expectedUpgradeAuthority:owner.publicKey.toBase58(),buildManifest:'owner.json',mintSeed:'private-test-001',graduationFeeBps:2885,tradeFeeBps:100,migrationRentLamports:'100000000',maxWalletSpendLamports:'3300000000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:1000,solUsdMicros:'150000000',priceObservedAt:new Date().toISOString()};
const manifest={schemaVersion:1,feature:'owner-test',fixtureKeys:false,operator:config.operator,programId:config.programId,binarySha256:sha256(binary),binaryLength:binary.length,sourceSha256:sha256(source),cargoLockSha256:sha256(lock),buildScriptSha256:sha256(build)};
const wrap=(data,owner,executable=false,lamports=10000000)=>({owner,executable,lamports,data:[data.toString('base64'),'base64']});
const header=(address)=>{const b=Buffer.alloc(36);b.writeUInt32LE(2);address.toBuffer().copy(b,4);return b;};
const pdata=(bytes)=>{const b=Buffer.alloc(45);b.writeUInt32LE(3);b.writeBigUInt64LE(123n,4);b[12]=1;owner.publicKey.toBuffer().copy(b,13);return Buffer.concat([b,bytes]);};
async function fixture({phase=null,simulationError=null,sendFails=false}={}){
 const a=await deriveAddresses(config),accounts=new Map([[config.programId,wrap(header(programData.publicKey),LOADER,true)],[programData.publicKey.toBase58(),wrap(pdata(binary),LOADER)],[PUMP.toBase58(),wrap(header(pumpData.publicKey),LOADER,true)],[pumpData.publicKey.toBase58(),wrap(pdata(pumpBinary),LOADER)]]);
 if(phase!==null){const d=Buffer.alloc(256);d.write('CRVPTEST');d[8]=phase;owner.publicKey.toBuffer().copy(d,16);treasury.publicKey.toBuffer().copy(d,48);a.mint.toBuffer().copy(d,80);const values=[phase?VB-CAP:VB,phase?3000000000n:914897751n,CAP,phase?CAP:0n,phase?2000000000n:0n,890880n,2885n,100n,VB,914897751n];values.forEach((v,i)=>d.writeBigUInt64LE(v,112+i*8));accounts.set(a.state.toBase58(),wrap(d,config.programId));accounts.set(a.authority.toBase58(),wrap(Buffer.alloc(0),'11111111111111111111111111111111',false,2200000000));}
 const calls=[],store={value:null,writeCount:0,read:async()=>store.value,write:async value=>{store.value=structuredClone(value);store.writeCount++;}};
 let signatures=null,receipt=null,wire=null;
 const rpc=async(method,params=[])=>{calls.push(method);switch(method){case'getGenesisHash':return'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';case'getAccountInfo':return{value:accounts.get(params[0])||null};case'getMinimumBalanceForRentExemption':return 1000000;case'getBalance':return{value:5000000000};case'getLatestBlockhash':return{value:{blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:999}};case'getBlockHeight':return 100;case'getFeeForMessage':return{value:10000};case'simulateTransaction':return{value:{err:simulationError,unitsConsumed:200000}};case'getSignatureStatuses':return{value:[signatures]};case'getTransaction':return params[1].encoding==='base64'?wire:receipt;case'sendTransaction':assert.ok(store.writeCount>0,'journal persisted before send');if(sendFails)throw Error('timeout');return store.value.entries.at(-1).signature;default:throw Error(method);}};
 const read=async(path,...args)=>String(path).endsWith('owner.json')?JSON.stringify(manifest):readFile(path,...args);
 return{a,accounts,calls,store,rpc,read,setReceipt(s,r,w){signatures=s;receipt=r;wire=w;}};
}

test('default configuration has strict network, economics, price, budget and fixture gates',{skip:SKIP},()=>{
 assert.equal(validateConfig(config).cluster,'mainnet-beta');
 for(const patch of [{cluster:undefined},{operator:Keypair.fromSeed(new Uint8Array(32).fill(99)).publicKey.toBase58()},{operator:Keypair.fromSeed(new Uint8Array(32).fill(71)).publicKey.toBase58()},{treasury:config.operator},{graduationFeeBps:100},{tradeFeeBps:0},{migrationRentLamports:'100000001'},{maxWalletSpendLamports:'4000000000'},{rpcUrl:'http://evil.example'},{expectedUpgradeAuthority:treasury.publicKey.toBase58()}])assert.throws(()=>validateConfig({...config,...patch}));
 assert.throws(()=>validateConfig({...config,priceObservedAt:new Date(0).toISOString()},{requirePrice:true}),/snapshot/);
 assert.throws(()=>validateConfig({...config,solUsdMicros:'1000000'},{requirePrice:true}),/3 SOL/);
});

test('deployment verifies genesis, build mode, source/build script, exact deployed bytes and Pump fingerprint',{skip:SKIP},async()=>{
 const f=await fixture();await verifyDeployment(config,f.rpc,{read:f.read});assert.ok(!f.calls.includes('sendTransaction'));
 const badGenesis=async(m,p)=>m==='getGenesisHash'?'wrong':f.rpc(m,p);await assert.rejects(verifyDeployment(config,badGenesis,{read:f.read}),/genesis/);
 for(const patch of [{feature:'local-test'},{fixtureKeys:true},{buildScriptSha256:'0'.repeat(64)},{binarySha256:'0'.repeat(64)}])await assert.rejects(verifyDeployment(config,f.rpc,{read:async(p,...a)=>String(p).endsWith('owner.json')?JSON.stringify({...manifest,...patch}):f.read(p,...a)}));
 const own=f.accounts.get(programData.publicKey.toBase58());f.accounts.set(programData.publicKey.toBase58(),wrap(pdata(Buffer.from('wrong program')),LOADER));await assert.rejects(verifyDeployment(config,f.rpc,{read:f.read}),/ProgramData|binary/);f.accounts.set(programData.publicKey.toBase58(),own);
});

test('prepare initialize atomically creates seeded mint and custody with no private mint key or send',{skip:SKIP},async()=>{
 const f=await fixture(),bundle=await prepare(config,f.rpc,'initialize',{read:f.read});const tx=Transaction.from(Buffer.from(bundle.unsignedTransaction,'base64'));
 assert.equal(tx.instructions.length,5);assert.equal(tx.instructions.at(-1).data[0],0);assert.equal(tx.instructions.at(-1).keys[2].pubkey.toBase58(),bundle.addresses.authority);assert.equal(tx.signatures.length,1);assert.equal(tx.signatures[0].publicKey.toBase58(),config.operator);
 assert.equal(bundle.details.startingFdvUsd,'100');assert.equal(bundle.details.graduationFdvUsd,'500');assert.ok(!f.calls.includes('sendTransaction'));
 const failed=await fixture({simulationError:{InstructionError:[1,'Error']}});await assert.rejects(prepare(config,failed.rpc,'initialize',{read:failed.read}),/Simulation failed/);
});

test('buy and migration instructions use exact cap, pinned recipients, and indexed pool addresses',{skip:SKIP},async()=>{
 const f=await fixture({phase:0}),buy=await buildOperation(config,f.rpc,'buy-to-bond');const ix=buy.instructions.at(-1);assert.equal(ix.data[0],1);assert.equal(ix.data.readBigUInt64LE(9),CAP);assert.equal(ix.keys[6].pubkey.toBase58(),config.treasury);
 const ready=await fixture({phase:1}),a7=await deriveAddresses(config,7),migration=await buildOperation(config,ready.rpc,'migrate',{poolIndex:7});assert.equal(migration.instructions[0].data.readUInt16LE(1),7);assert.ok(migration.instructions[0].keys[7].pubkey.equals(a7.pool));assert.equal(migration.details.graduationFeeLamports,'577000000');
 ready.accounts.set(a7.pool.toBase58(),wrap(Buffer.alloc(1),PUMP.toBase58()));await assert.rejects(buildOperation(config,ready.rpc,'migrate',{poolIndex:7}),/occupied/);
});

test('execute requires explicit acknowledgement and matching wallet, with journal-before-send',{skip:SKIP},async()=>{
 const f=await fixture(),bundle=await prepare(config,f.rpc,'initialize',{read:f.read});const args={config,rpc:f.rpc,bundle,keypairBytes:[...owner.secretKey],journalStore:f.store,read:f.read};
 await assert.rejects(executePrepared(args),/acknowledgement/);await assert.rejects(executePrepared({...args,acknowledgement:'I_ACCEPT_REAL_SOL_PRIVATE_TEST',keypairBytes:[...treasury.secretKey]}),/operator/);
 const result=await executePrepared({...args,acknowledgement:'I_ACCEPT_REAL_SOL_PRIVATE_TEST'});assert.equal(result.state,'submitted');assert.equal(f.calls.filter(x=>x==='sendTransaction').length,1);await verifyJournal(f.store.value.entries[0],config);
 const tampered=structuredClone(f.store.value.entries[0]);tampered.command='migrate';await assert.rejects(verifyJournal(tampered,config),/operation/);
});

test('timeout persists unknown outcome and a retry sends identical signed bytes only',{skip:SKIP},async()=>{
 const f=await fixture({sendFails:true}),bundle=await prepare(config,f.rpc,'initialize',{read:f.read});const args={config,rpc:f.rpc,bundle,keypairBytes:[...owner.secretKey],journalStore:f.store,read:f.read,acknowledgement:'I_ACCEPT_REAL_SOL_PRIVATE_TEST'};
 await assert.rejects(executePrepared(args),/outcome unknown/);assert.equal(f.store.value.entries[0].state,'submission-unknown');
 const bytes=f.store.value.entries[0].signedTransaction;await assert.rejects(executePrepared({...args,bundle:{...bundle,transactionSha256:'bad'}}));
 const retryRpc=async(m,p)=>m==='sendTransaction'?(assert.equal(p[0],bytes),f.store.value.entries[0].signature):f.rpc(m,p);
 const retried=await executePrepared({...args,rpc:retryRpc});assert.equal(retried.state,'submitted');assert.equal(f.store.value.entries.length,1);
});

test('RPC client cannot issue arbitrary methods; missing receipt never becomes success',{skip:SKIP},async()=>{
 const client=createRpc(config,{fetcher:async()=>{throw Error('unexpected network')}});await assert.rejects(client('requestAirdrop'),/not allowed/);
 const f=await fixture(),bundle=await prepare(config,f.rpc,'initialize',{read:f.read});await executePrepared({config,rpc:f.rpc,bundle,keypairBytes:[...owner.secretKey],journalStore:f.store,read:f.read,acknowledgement:'I_ACCEPT_REAL_SOL_PRIVATE_TEST'});
 const r=await reconcileReceipt(config,f.rpc,f.store.value.entries[0]);assert.equal(r.state,'pending');
 f.setReceipt({confirmationStatus:'finalized',err:null},{meta:{err:null}}, {meta:{err:null},transaction:['wrong','base64']});await assert.rejects(reconcileReceipt(config,f.rpc,f.store.value.entries[0]),/differs from/);
});

test('nonfinalized errors stay unresolved; finalized errors are terminal',{skip:SKIP},async()=>{
 const f=await fixture(),bundle=await prepare(config,f.rpc,'initialize',{read:f.read});await executePrepared({config,rpc:f.rpc,bundle,keypairBytes:[...owner.secretKey],journalStore:f.store,read:f.read,acknowledgement:'I_ACCEPT_REAL_SOL_PRIVATE_TEST'});const journal=f.store.value.entries[0];
 f.setReceipt({confirmationStatus:'processed',err:{InstructionError:[1,'Error']}},null,null);assert.equal((await reconcileReceipt(config,f.rpc,journal)).state,'pending');
 f.setReceipt({confirmationStatus:'confirmed',err:{InstructionError:[1,'Error']}},null,null);assert.equal((await reconcileReceipt(config,f.rpc,journal)).state,'pending');
 f.setReceipt({confirmationStatus:'finalized',err:{InstructionError:[1,'Error']}},null,null);assert.equal((await reconcileReceipt(config,f.rpc,journal)).state,'failed');
});

test('Pump upgrade blocks migration but cannot block pre-migration sell recovery',{skip:SKIP},async()=>{
 const f=await fixture({phase:1});f.accounts.set(pumpData.publicKey.toBase58(),wrap(pdata(Buffer.from('new Pump program')),LOADER));
 await assert.rejects(prepare(config,f.rpc,'migrate',{read:f.read}),/PumpSwap changed/);
 const token=Buffer.alloc(165);f.a.mint.toBuffer().copy(token,0);owner.publicKey.toBuffer().copy(token,32);token.writeBigUInt64LE(CAP,64);token[108]=1;f.accounts.set(f.a.operatorAta.toBase58(),wrap(token,TOKEN_PROGRAM_ID.toBase58()));
 const recovery=await prepare(config,f.rpc,'sell-recovery',{read:f.read});assert.equal(recovery.deployment.pumpCheck,'skipped-for-pre-migration-redemption');assert.equal(recovery.command,'sell-recovery');
});

test('receipt proves exact LP burn while allowing later third-party liquidity or LP donations',{skip:SKIP},async()=>{
 const f=await fixture({phase:1}),bundle=await prepare(config,f.rpc,'migrate',{read:f.read});await executePrepared({config,rpc:f.rpc,bundle,keypairBytes:[...owner.secretKey],journalStore:f.store,read:f.read,acknowledgement:'I_ACCEPT_REAL_SOL_PRIVATE_TEST'});const journal=f.store.value.entries[0],a=f.a;
 const state=Buffer.from(f.accounts.get(a.state.toBase58()).data[0],'base64');state[8]=2;state.writeBigUInt64LE(0n,144);state.writeBigUInt64LE(123456n,192);state.writeBigUInt64LE(577000000n,200);a.pool.toBuffer().copy(state,208);f.accounts.set(a.state.toBase58(),wrap(state,config.programId));
 const mint=Buffer.alloc(82);mint.writeBigUInt64LE(999n,36);f.accounts.set(a.lpMint.toBase58(),wrap(mint,TOKEN_2022_PROGRAM_ID.toBase58()));
 const ata=Buffer.alloc(165);a.lpMint.toBuffer().copy(ata,0);a.authority.toBuffer().copy(ata,32);ata.writeBigUInt64LE(50n,64);f.accounts.set(a.authorityLp.toBase58(),wrap(ata,TOKEN_2022_PROGRAM_ID.toBase58()));
 const parsed={transaction:{message:{accountKeys:[{pubkey:a.authorityLp.toBase58()}]}},meta:{err:null,postTokenBalances:[{accountIndex:0,mint:a.lpMint.toBase58(),owner:a.authority.toBase58(),uiTokenAmount:{amount:'0'}}],innerInstructions:[{index:2,instructions:[{programId:TOKEN_2022_PROGRAM_ID.toBase58(),parsed:{type:'mintTo',info:{mint:a.lpMint.toBase58(),amount:'123456'}}},{programId:TOKEN_2022_PROGRAM_ID.toBase58(),parsed:{type:'burn',info:{mint:a.lpMint.toBase58(),authority:a.authority.toBase58(),amount:'123456'}}}]}]}};
 f.setReceipt({confirmationStatus:'finalized',err:null},parsed,{meta:{err:null},transaction:[journal.signedTransaction,'base64']});
 const result=await reconcileReceipt(config,f.rpc,journal);assert.equal(result.state,'finalized');assert.equal(result.lpMintSupplyAtCheck,'999');assert.equal(result.authorityLpBalanceAtCheck,'50');assert.equal(result.authorityLpBalanceAtReceipt,'0');assert.equal(result.burnedLpAtoms,'123456');
 parsed.meta.innerInstructions[0].instructions[1].parsed.info.mint=owner.publicKey.toBase58();await assert.rejects(reconcileReceipt(config,f.rpc,journal),/expected LP burn/);
});

test('tampered journal cannot change treasury, pool index, config or signed transaction for retries',{skip:SKIP},async()=>{
 const f=await fixture({phase:1}),bundle=await prepare(config,f.rpc,'migrate',{read:f.read});await executePrepared({config,rpc:f.rpc,bundle,keypairBytes:[...owner.secretKey],journalStore:f.store,read:f.read,acknowledgement:'I_ACCEPT_REAL_SOL_PRIVATE_TEST'});const journal=f.store.value.entries[0];
 for(const patch of [{treasury:config.operator},{poolIndex:8},{cluster:'devnet'},{configSha256:'0'.repeat(64)},{signature:'invalid'}])await assert.rejects(verifyJournal({...journal,...patch},config));
 const corrupted=Buffer.from(journal.signedTransaction,'base64');corrupted[5]^=1;await assert.rejects(verifyJournal({...journal,signedTransaction:corrupted.toString('base64')},config));
});

test('a finalized buy is reconcilable after Pump upgrades, before preparing a recovery sale',{skip:SKIP},async()=>{
 const f=await fixture({phase:0}),bundle=await prepare(config,f.rpc,'buy-to-bond',{read:f.read});await executePrepared({config,rpc:f.rpc,bundle,keypairBytes:[...owner.secretKey],journalStore:f.store,read:f.read,acknowledgement:'I_ACCEPT_REAL_SOL_PRIVATE_TEST'});const journal=f.store.value.entries[0];
 f.accounts.set(pumpData.publicKey.toBase58(),wrap(pdata(Buffer.from('upgraded Pump')),LOADER));
 f.setReceipt({confirmationStatus:'finalized',err:null},{meta:{err:null}},{meta:{err:null},transaction:[journal.signedTransaction,'base64']});
 const dep=await verifyDeployment(config,f.rpc,{read:f.read,operation:'receipt-reconciliation'});assert.equal(dep.pumpCheck,'skipped-for-receipt-reconciliation');
 const result=await executePrepared({config,rpc:f.rpc,bundle,keypairBytes:[...owner.secretKey],journalStore:f.store,read:f.read,acknowledgement:'I_ACCEPT_REAL_SOL_PRIVATE_TEST'});assert.equal(result.state,'finalized');assert.equal(f.calls.filter(x=>x==='sendTransaction').length,1);
});

test('journal write failure prevents submission; expired unknown signature never gets a new blockhash',{skip:SKIP},async()=>{
 const f=await fixture(),bundle=await prepare(config,f.rpc,'initialize',{read:f.read});const broken={read:async()=>null,write:async()=>{throw Error('disk full')}};
 await assert.rejects(executePrepared({config,rpc:f.rpc,bundle,keypairBytes:[...owner.secretKey],journalStore:broken,read:f.read,acknowledgement:'I_ACCEPT_REAL_SOL_PRIVATE_TEST'}),/disk full/);assert.equal(f.calls.includes('sendTransaction'),false);
 await executePrepared({config,rpc:f.rpc,bundle,keypairBytes:[...owner.secretKey],journalStore:f.store,read:f.read,acknowledgement:'I_ACCEPT_REAL_SOL_PRIVATE_TEST'});
 const count=f.calls.filter(x=>x==='getLatestBlockhash').length,expired=async(m,p)=>m==='getBlockHeight'?1000:f.rpc(m,p);
 const result=await executePrepared({config,rpc:expired,bundle,keypairBytes:[...owner.secretKey],journalStore:f.store,read:f.read,acknowledgement:'I_ACCEPT_REAL_SOL_PRIVATE_TEST'});assert.equal(result.state,'expired-unconfirmed');assert.equal(f.calls.filter(x=>x==='getLatestBlockhash').length,count);assert.equal(f.calls.filter(x=>x==='sendTransaction').length,1);
});

test('full official genesis hashes work; shortened chain IDs fail for both networks',{skip:SKIP},async()=>{
 const f=await fixture();
 const observed={ 'mainnet-beta':'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',devnet:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'};
 for(const [cluster,genesis]of Object.entries(observed)){
  await verifyDeployment({...config,cluster},async(m,p)=>m==='getGenesisHash'?genesis:f.rpc(m,p),{read:f.read});
  for(const truncated of ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','EtWTRABZaYq6iMfeYKouRu166VU2xqa1'])await assert.rejects(verifyDeployment({...config,cluster},async(m,p)=>m==='getGenesisHash'?truncated:f.rpc(m,p),{read:f.read}),/genesis/);
 }
});
const signV0=(bundle,key=owner)=>{const tx=VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction,'base64'));tx.sign([key]);return Buffer.from(tx.serialize()).toString('base64');};
const walletArgs=(f,bundle,signedTransaction=signV0(bundle))=>({config,rpc:f.rpc,bundle,signedTransaction,journalStore:f.store,read:f.read,acknowledgement:'I_ACCEPT_REAL_SOL_PRIVATE_TEST'});

test('wallet v0 preparation and submission preserve reviewed message and persist before send',{skip:SKIP},async()=>{
 const f=await fixture(),bundle=await prepare(config,f.rpc,'initialize',{read:f.read,transactionVersion:0});assert.equal(bundle.transactionVersion,0);assert.equal(inspectTransaction(bundle.unsignedTransaction,config.operator).version,0);
 let checks=0;const result=await submitSignedPlan({...walletArgs(f,bundle),beforeSend:async()=>{checks++;assert.equal(f.store.value.entries.length,1);assert.equal(f.calls.includes('sendTransaction'),false);}});
 assert.equal(result.state,'submitted');assert.equal(checks,1);assert.equal(f.store.value.entries.length,1);await verifyJournal(f.store.value.entries[0],config);
});

test('wallet cannot change recipient, amount, compute budget or blockhash, and cannot return missing/bad signature',{skip:SKIP},async()=>{
 const f=await fixture(),bundle=await prepare(config,f.rpc,'initialize',{read:f.read,transactionVersion:0});
 await assert.rejects(submitSignedPlan(walletArgs(f,bundle,bundle.unsignedTransaction)),/signature/);
 const corrupt=Buffer.from(signV0(bundle),'base64');corrupt[4]^=1;await assert.rejects(submitSignedPlan(walletArgs(f,bundle,corrupt.toString('base64'))),/signature/);
 for(const mutate of [m=>{m.recentBlockhash=treasury.publicKey.toBase58();},m=>{m.instructions[0].data[1]^=1;},m=>{m.instructions.at(-1).keys[5].pubkey=owner.publicKey;},m=>{m.instructions.push(SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:treasury.publicKey,lamports:1}));}]){
  const original=VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction,'base64')),message=TransactionMessage.decompile(original.message);mutate(message);const tx=new VersionedTransaction(message.compileToV0Message());tx.sign([owner]);await assert.rejects(submitSignedPlan(walletArgs(f,bundle,Buffer.from(tx.serialize()).toString('base64'))),/changed the reviewed/);
 }
 assert.equal(f.calls.includes('sendTransaction'),false);assert.equal(f.store.value,null);
});

test('wallet v0 authorization rejection and journal failure both prevent any send',{skip:SKIP},async()=>{
 const f=await fixture(),bundle=await prepare(config,f.rpc,'initialize',{read:f.read,transactionVersion:0});
 await assert.rejects(submitSignedPlan({...walletArgs(f,bundle),journalStore:{read:async()=>null,write:async()=>{throw Error('disk full')}}}),/disk full/);assert.equal(f.calls.includes('sendTransaction'),false);
 await assert.rejects(submitSignedPlan({...walletArgs(f,bundle),beforeSend:async()=>{throw Error('session revoked')}}),/session revoked/);assert.equal(f.calls.includes('sendTransaction'),false);assert.equal(f.store.value.entries[0].state,'prepared-for-send');
});

test('wallet v0 lost send response retries only identical saved signed bytes after fresh authorization',{skip:SKIP},async()=>{
 const f=await fixture({sendFails:true}),bundle=await prepare(config,f.rpc,'initialize',{read:f.read,transactionVersion:0}),args=walletArgs(f,bundle);
 await assert.rejects(submitSignedPlan(args),/outcome unknown/);assert.equal(f.store.value.entries[0].state,'submission-unknown');
 const before=f.calls.filter(x=>x==='sendTransaction').length;await assert.rejects(submitSignedPlan({...args,beforeSend:async()=>{throw Error('session revoked')}}),/session revoked/);assert.equal(f.calls.filter(x=>x==='sendTransaction').length,before);
 let retried=false;const result=await submitSignedPlan({...args,rpc:async(m,p)=>m==='sendTransaction'?(assert.equal(p[0],args.signedTransaction),retried=true,f.store.value.entries[0].signature):f.rpc(m,p)});assert.equal(result.state,'submitted');assert.ok(retried);assert.equal(f.store.value.entries.length,1);
});

test('application binding gate refuses arbitrary operator/program/build and accepts only shipped verified owner artifacts',{skip:SKIP},async()=>{
 const unbound=JSON.parse(await readFile(new URL('private/pump-owner-test/owner-build-unbound.json',ROOT),'utf8'));
 const binding=await createSeededBinding({manifest:unbound,cluster:'mainnet-beta',PublicKey});
 const c={...config,operator:OWNER,treasury:TREASURY,programId:SEEDED_PROGRAM.programId,expectedProgramSha256:PINS.binarySha256,expectedUpgradeAuthority:OWNER};
 const m={...binding,deployed:true,verification:{readOnly:true,cluster:c.cluster,genesisHash:binding.binding.genesisHash,programId:c.programId,operator:OWNER,treasury:TREASURY,binarySha256:PINS.binarySha256,deploymentSlot:c.expectedDeploymentSlot,upgradeAuthority:OWNER}};
 const read=async(p,...args)=>String(p).endsWith('owner.json')?JSON.stringify(m):readFile(p,...args);
 assert.equal((await verifyWebConfigBinding(c,{read})).programId,SEEDED_PROGRAM.programId);
 for(const patch of [{operator:config.operator},{treasury:config.treasury},{programId:config.programId},{expectedProgramSha256:'0'.repeat(64)},{expectedDeploymentSlot:'124'}])await assert.rejects(verifyWebConfigBinding({...c,...patch},{read}));
 for(const patch of [{feature:'local-test'},{fixtureKeys:true},{bound:false},{deployed:false},{sourceSha256:'0'.repeat(64)},{graduationFeeBps:0}])await assert.rejects(verifyWebConfigBinding(c,{read:async(p,...args)=>String(p).endsWith('owner.json')?JSON.stringify({...m,...patch}):readFile(p,...args)}));
 await assert.rejects(verifyWebConfigBinding(c,{read:async(p,...args)=>String(p).endsWith('.so')?Buffer.from('wrong ELF'):read(p,...args)}),/bytes differ/);
});
