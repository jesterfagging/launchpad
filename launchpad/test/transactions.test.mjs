import test from 'node:test';
import assert from 'node:assert/strict';
import { SystemInstruction, SystemProgram, ComputeBudgetInstruction, TransactionMessage, PublicKey, TransactionInstruction, VersionedTransaction, Keypair, AddressLookupTableAccount } from '@solana/web3.js';
import { validateConfig, SOL, SENDER_TIPS } from '../src/core.mjs';
import { makeTransaction, transactionSize, TransactionTooLargeError, prepareTransaction, Providers, ProviderError } from '../src/providers.mjs';
import { config,build,key1,mint,quote,blockhash } from './fixtures.mjs';

test('priority, Jito tip and Helius tip coexist with no automatic fee override',()=>{
  const c=validateConfig(config({prioritySol:'0.001',jitoSol:'0.001',heliusSol:'0.001'}));
  const wallet=c.wallets[0],order={inputMint:SOL,outputMint:mint,amount:50000000n};
  const {tx,chargedPriority}=makeTransaction(build(order,wallet),wallet,c,[quote]);
  const message=TransactionMessage.decompile(tx.message);assert(chargedPriority<=1000000n&&chargedPriority>=999999n);
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(message.instructions[0]).units,1400000);
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitPrice(message.instructions[1]).microLamports,714285n);
  const transfers=message.instructions.filter(ix=>ix.programId.equals(SystemProgram.programId)).map(ix=>SystemInstruction.decodeTransfer(ix));
  assert.equal(transfers.find(t=>t.toPubkey.equals(new PublicKey(quote))&&t.lamports===1000000n).lamports,1000000n);
  assert.equal(transfers.find(t=>SENDER_TIPS.includes(t.toPubkey.toBase58())).lamports,1000000n);
});
test('two legitimate identical-size swaps under the same blockhash have distinct signatures',()=>{
  const c=validateConfig(config({mode:'live'})),wallet=c.wallets[0],b=build({inputMint:SOL,outputMint:mint,amount:1n},wallet);
  const a=makeTransaction(b,wallet,c,[]).tx,z=makeTransaction(b,wallet,c,[]).tx;a.sign([key1]);z.sign([key1]);assert.notDeepEqual(a.signatures[0],z.signatures[0]);
});
test('unexpected required signers are rejected before signing',()=>{
  const c=validateConfig(config()),wallet=c.wallets[0],b=build({inputMint:SOL,outputMint:mint,amount:1n},wallet);
  b.swapInstruction.accounts[1].isSigner=true;assert.throws(()=>makeTransaction(b,wallet,c,[]),/signers/);
});
test('keys never appear in serialized app configuration returned to the UI',()=>{
  const c=validateConfig(config({mode:'live'}));assert.equal(c.wallets[0].publicKey,key1.publicKey.toBase58());
  assert(!Object.hasOwn(c.wallets[0],'privateKey'));
});

function largeRoute(order,wallet,count=40) {
  const addresses=Array.from({length:count},()=>Keypair.generate().publicKey),program=Keypair.generate().publicKey;
  const ix=new TransactionInstruction({programId:program,keys:[{pubkey:new PublicKey(wallet.publicKey),isSigner:true,isWritable:true},...addresses.map((pubkey,i)=>({pubkey,isSigner:false,isWritable:i%2===0}))],data:Buffer.alloc(130,1)});
  return {...build(order,wallet),routeName:'Large test route',nativeInstructions:[ix],addresses};
}

test('oversized messages are detected before the web3.js Uint8Array overflow',()=>{
  const c=validateConfig(config()),wallet=c.wallets[0],route=largeRoute({inputMint:SOL,outputMint:mint,amount:1n},wallet);
  const message=new TransactionMessage({payerKey:new PublicKey(wallet.publicKey),recentBlockhash:blockhash,instructions:route.nativeInstructions}).compileToV0Message();
  assert.throws(()=>new VersionedTransaction(message).serialize(),/encoding overruns Uint8Array/);
  assert(transactionSize(message)>1232);
  assert.throws(()=>makeTransaction(route,wallet,c,[]),error=>error instanceof TransactionTooLargeError&&error.size>1232&&!error.message.includes('Uint8Array'));
});

test('packet measurements include signatures, tips, lookup tables and long instruction data',()=>{
  const c=validateConfig(config({jitoSol:'0.001',heliusSol:'0.001'})),wallet=c.wallets[0],order={inputMint:SOL,outputMint:mint,amount:1n};
  const route=largeRoute(order,wallet),table=Keypair.generate().publicKey.toBase58();
  route.addressesByLookupTableAddress={[table]:route.addresses.map(String)};
  const prepared=makeTransaction(route,wallet,c,[quote]);
  assert.equal(prepared.size,prepared.tx.serialize().length);assert(prepared.size<=1232);
  prepared.tx.sign([key1]);assert.equal(prepared.size,prepared.tx.serialize().length);
});

test('oversized direct instructions fit v1 without requoting while preserving every instruction and both tips',async()=>{
  const c=validateConfig(config({jitoSol:'0.001',heliusSol:'0.001'})),wallet=c.wallets[0],order={inputMint:SOL,outputMint:mint,amount:1n,receivedAt:Date.now()};
  const route=largeRoute(order,wallet),table=Keypair.generate().publicKey,lookups={[table.toBase58()]:route.addresses.map(String)};let requests=0;
  const p={jitoTips:[quote],jupiterBuild:async(o,w,signal,limit)=>{requests++;assert.equal(o,order);assert.equal(w,wallet);assert.equal(limit,32);return {...build(o,w),addressesByLookupTableAddress:lookups};}};
  const result=await prepareTransaction(route,order,wallet,c,p);
  assert.equal(requests,0);assert.equal(result.build.routeName,'Large test route');assert.equal(result.build.requiresSimulation,true);
  assert.equal(result.transaction.tx.version,1);
  assert.equal(result.transaction.size,result.transaction.tx.serialize().length);assert(result.transaction.size>1232&&result.transaction.size<=4096);
  const instructions=TransactionMessage.decompile(result.transaction.tx.message).instructions;
  const swap=instructions.find(ix=>ix.programId.equals(route.nativeInstructions[0].programId));
  assert.deepEqual(swap,route.nativeInstructions[0]);
  const tips=instructions.filter(ix=>ix.programId.equals(SystemProgram.programId)).map(ix=>SystemInstruction.decodeTransfer(ix));
  assert.equal(tips.length,2);assert(tips.every(t=>t.lamports===1000000n));
});

test('compact rerouting is bounded, retains validation, and sends nothing during preparation',async()=>{
  const c=validateConfig(config()),wallet=c.wallets[0],order={inputMint:SOL,outputMint:mint,amount:1n,receivedAt:Date.now()},route=largeRoute(order,wallet,70);
  const p=new Providers(c,()=>{}),limits=[];
  p.fetch=async url=>{const q=new URL(url).searchParams;limits.push(Number(q.get('maxAccounts')));assert.equal(q.get('amount'),'1');return {...route,nativeInstructions:undefined,swapInstruction:{programId:route.nativeInstructions[0].programId.toBase58(),accounts:route.nativeInstructions[0].keys.map(k=>({pubkey:k.pubkey.toBase58(),isSigner:k.isSigner,isWritable:k.isWritable})),data:route.nativeInstructions[0].data.toString('base64')}};};
  await assert.rejects(prepareTransaction(route,order,wallet,c,p),/No compact route fit/);assert.deepEqual(limits,[32,24,16]);
  p.fetch=async()=>({...build(order,wallet),inAmount:'2'});
  await assert.rejects(prepareTransaction(route,order,wallet,c,p),/different swap/);
  const stop=new AbortController();stop.abort();let requests=0;p.fetch=async()=>{requests++;return build(order,wallet);};
  await assert.rejects(prepareTransaction(route,order,wallet,c,p,stop.signal),/Stopped/);assert.equal(requests,0);
});

test('overlapping lookup tables compact without changing instruction accounts, order, data or tips',()=>{
  const c=validateConfig(config({jitoSol:'0.001',heliusSol:'0.001'})),wallet=c.wallets[0];
  const route=largeRoute({inputMint:SOL,outputMint:mint,amount:50000000n},wallet);
  const narrow=Keypair.generate().publicKey,broad=Keypair.generate().publicKey;
  route.addressesByLookupTableAddress={[narrow]:route.addresses.slice(0,3).map(String),[broad]:route.addresses.map(String)};
  const tables=Object.entries(route.addressesByLookupTableAddress).map(([key,addresses])=>new AddressLookupTableAccount({key:new PublicKey(key),state:{deactivationSlot:18446744073709551615n,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,addresses:addresses.map(a=>new PublicKey(a))}}));
  const {tx,size}=makeTransaction(route,wallet,c,[quote]);
  assert.equal(tx.message.addressTableLookups.length,1);assert(tx.message.addressTableLookups[0].accountKey.equals(broad));
  const expanded=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:tables});
  assert.deepEqual(expanded.instructions[2],route.nativeInstructions[0]);
  const previous=expanded.compileToV0Message(tables);
  assert.equal(transactionSize(previous)-size,34);assert.equal(size,tx.serialize().length);
  assert(tx.message.staticAccountKeys.some(k=>k.equals(new PublicKey(quote))),'Jito destination stays static');
  const tips=expanded.instructions.filter(ix=>ix.programId.equals(SystemProgram.programId)).map(ix=>SystemInstruction.decodeTransfer(ix));
  assert.equal(tips.length,2);assert(tips.every(t=>t.lamports===1000000n));
});

test('oversized funded launches rebuild the funding leg instead of asking Jupiter for the launch token',async()=>{
  const c=validateConfig(config({jitoSol:'0.001',heliusSol:'0.001'})),wallet=c.wallets[0];
  const order={inputMint:SOL,outputMint:mint,amount:50000000n,receivedAt:Date.now(),venue:{type:'pump',baseMint:mint,quoteMint:quote}};
  const route={...largeRoute(order,wallet,70),fundingLeg:{inputMint:SOL,outputMint:quote}},limits=[];
  const p={jitoTips:[quote],jupiterBuild:async()=>assert.fail('Must retain the direct launch route'),direct:{build:async(o,w,s,limit)=>{
    assert.equal(o,order);assert.equal(w,wallet);limits.push(limit);
    if(limit===32)throw new ProviderError('Jupiter route returned HTTP 400: No routes found',{routeUnavailable:true});
    return {...build(o,w),routeName:'Jupiter → Pump curve',fundingLeg:{inputMint:SOL,outputMint:quote,minimumOutput:'800'}};
  }}};
  const result=await prepareTransaction(route,order,wallet,c,p);
  assert.deepEqual(limits,[32,24]);assert.equal(result.build.routeName,'Jupiter → Pump curve');
  assert.equal(result.build.fundingLeg.minimumOutput,'800');assert.equal(result.build.inAmount,'50000000');
  assert(result.build.requiresSimulation);assert(result.transaction.tx.signatures.every(s=>s.every(b=>b===0)));
  assert(result.transaction.size<=1232);
});

test('funding compaction stops on integrity, credentials, throttling, cancellation and stale signals',async()=>{
  const c=validateConfig(config()),wallet=c.wallets[0],order={inputMint:SOL,outputMint:mint,amount:1n,receivedAt:Date.now()};
  const route={...largeRoute(order,wallet,70),fundingLeg:{inputMint:SOL,outputMint:quote}};
  for(const failure of [new Error('Pump curve exceeds your price-impact limit.'),new ProviderError('HTTP 401',{httpStatus:401}),new ProviderError('HTTP 429',{rateLimited:true})]){
    let calls=0;const p={jitoTips:[],direct:{build:async()=>{calls++;throw failure;}}};
    await assert.rejects(prepareTransaction(route,order,wallet,c,p),e=>e===failure);assert.equal(calls,1);
  }
  for(const expired of [false,true]){
    const stop=new AbortController();const o={...order,receivedAt:Date.now()-(expired?c.maxSignalAgeMs+1:0)};let calls=0;
    const p={jitoTips:[],direct:{build:async()=>{calls++;stop.abort();return build(o,wallet);}}};
    await assert.rejects(prepareTransaction(route,o,wallet,c,p,stop.signal),expired?/maximum signal age/:/Stopped/);
    assert.equal(calls,expired?0:1);
  }
});
