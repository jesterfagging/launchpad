import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicKey, verify } from 'node:crypto';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, SystemProgram, SystemInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { getTransactionDecoder } from '@solana/transactions';
import bs58 from 'bs58';
import { deserializeTransaction, TransactionCapacityError } from '../src/transactions-v1.mjs';
import { makeTransaction, prepareTransaction, transactionSize, TransactionTooLargeError, verifySignedTransaction } from '../src/providers.mjs';
import { validateConfig, SOL, PUMP, SENDER_TIPS, parseWallet } from '../src/core.mjs';
import { config, build, mint, quote, key1, key2 } from './fixtures.mjs';

function route(c, count=40, dataLength=130) {
  const wallet=c.wallets[0],order={inputMint:SOL,outputMint:mint,amount:50000000n,receivedAt:Date.now()};
  const instruction=new TransactionInstruction({programId:new PublicKey(mint),data:Buffer.alloc(dataLength,7),
    keys:[{pubkey:new PublicKey(wallet.publicKey),isSigner:true,isWritable:true},
      ...Array.from({length:count},()=>({pubkey:Keypair.generate().publicKey,isSigner:false,isWritable:true}))]});
  return {order,wallet,build:{...build(order,wallet),nativeInstructions:[instruction]}};
}



test('v1 signs imported keys, retains total priority fee and reflects replacement blockhashes',()=>{
  const c=validateConfig(config({prioritySol:'0.001',jitoSol:'0.001',heliusSol:'0.001'})),r=route(c);
  const formats=[bs58.encode(key1.secretKey),JSON.stringify([...key1.secretKey]),'seed:'+bs58.encode(key1.secretKey.slice(0,32)),'seed:'+JSON.stringify([...key1.secretKey.slice(0,32)])];
  for(const privateKey of formats){
    const wallet=parseWallet({privateKey},0,'live'),{tx,size,chargedPriority}=makeTransaction(r.build,wallet,c,[quote],1);
    assert.equal(chargedPriority,1000000n);assert.deepEqual(tx.message.transactionConfig,{computeUnitLimit:1400000,heapSize:null,loadedAccountsDataSizeLimit:67108864,priorityFee:1000000});
    tx.message.recentBlockhash=key2.publicKey.toBase58();tx.sign([wallet.keypair]);
    const bytes=tx.serialize(),decoded=VersionedTransaction.deserialize(bytes);
    assert.equal(decoded.message.recentBlockhash,key2.publicKey.toBase58());assert.equal(size,bytes.length);assert.equal(transactionSize(tx.message),size);
    assert.equal(verifySignedTransaction(bytes,wallet.publicKey).signature,bs58.encode(tx.signatures[0]));
    const kit=getTransactionDecoder().decode(bytes);assert.deepEqual(Buffer.from(kit.messageBytes),Buffer.from(tx.message.serialize()));
    assert.equal(Buffer.from(bytes).subarray(-64).toString('hex'),Buffer.from(tx.signatures[0]).toString('hex'));
    assert(!TransactionMessage.decompile(tx.message).instructions.some(i=>i.programId.equals(ComputeBudgetProgram.programId)));
  }
});

test('v1 rejects unsigned, corrupted, post-signing edits, wrong payer, trailing bytes and invalid config flags',()=>{
  const c=validateConfig(config()),r=route(c),{tx}=makeTransaction(r.build,r.wallet,c,[],1);
  assert.throws(()=>verifySignedTransaction(tx.serialize()),/signature verification failed/);
  tx.sign([key1]);const bytes=tx.serialize();
  const changed=deserializeTransaction(bytes);changed.message.transactionConfig.priorityFee++;
  const instruction=deserializeTransaction(bytes);instruction.message.compiledInstructions[0].data[0]^=1;
  const signature=Buffer.from(bytes);signature[signature.length-1]^=1;
  const flag=Buffer.from(bytes);flag[4]|=32;
  const truncatedFlag=Buffer.from(bytes);truncatedFlag[4]&=~1;
  for(const bad of [changed.serialize(),instruction.serialize(),signature,flag,truncatedFlag,Buffer.concat([bytes,Buffer.from([0])]),bytes.slice(0,-1)])
    assert.throws(()=>verifySignedTransaction(bad),/signature verification failed/);
  assert.throws(()=>verifySignedTransaction(bytes,key2.publicKey.toBase58()),/signature verification failed/);
});

test('v1 enforces 4096 bytes, account/instruction limits and a single expected signer',()=>{
  const c=validateConfig(config()),r=route(c,2,1);
  const initial=makeTransaction(r.build,r.wallet,c,[],1).size;
  r.build.nativeInstructions[0].data=Buffer.alloc(4096-initial+1);
  const exact=makeTransaction(r.build,r.wallet,c,[],1);assert.equal(exact.size,4096);exact.tx.sign([key1]);assert.doesNotThrow(()=>verifySignedTransaction(exact.tx.serialize()));
  r.build.nativeInstructions[0].data=Buffer.alloc(4096-initial+2);
  assert.throws(()=>makeTransaction(r.build,r.wallet,c,[],1),e=>e instanceof TransactionTooLargeError&&e.limit===4096&&e.size===4097);
  const many=route(c,64);assert.throws(()=>makeTransaction(many.build,many.wallet,c,[],1),TransactionCapacityError);
  const instructions=route(c,1);instructions.build.nativeInstructions=Array.from({length:64},()=>instructions.build.nativeInstructions[0]);
  assert.throws(()=>makeTransaction(instructions.build,instructions.wallet,c,[],1),TransactionCapacityError);
  const extraSigner=route(c,2);extraSigner.build.nativeInstructions[0].keys[1].isSigner=true;
  assert.throws(()=>makeTransaction(extraSigner.build,extraSigner.wallet,c,[],1),/Unexpected swap signers/);
});

test('v1 recovery respects Stop and signal age and small routes retain the v0 path without mandatory simulation',async()=>{
  const c=validateConfig(config()),r=route(c),p={jitoTips:[],jupiterBuild:async()=>assert.fail('No new quote needed')};
  const stopped=new AbortController();stopped.abort();await assert.rejects(prepareTransaction(r.build,r.order,r.wallet,c,p,stopped.signal),/Stopped/);
  await assert.rejects(prepareTransaction(r.build,{...r.order,receivedAt:Date.now()-c.maxSignalAgeMs-1},r.wallet,c,p),/maximum signal age/);
  const small=await prepareTransaction(build(r.order,r.wallet),r.order,r.wallet,c,p);
  assert.equal(small.transaction.tx.version,0);assert(!small.build.requiresSimulation);
});
