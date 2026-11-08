import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { LaunchTradingChain } from '../src/launchpad-trading-chain.mjs';

const chain=connection=>new LaunchTradingChain({network:'mainnet-beta',connection});
const signature=index=>{const bytes=Buffer.alloc(64);bytes.writeUInt32LE(index+1);return bs58.encode(bytes);};
const operation=index=>({signature:signature(index)});
const receipt=(op,err=null)=>({slot:123,transaction:{signatures:[op.signature]},meta:{err}});

test('1000 trade receipt checks use ten history batches while preserving input order',async()=>{
  const operations=Array.from({length:1000},(_,index)=>operation(index)),calls=[];
  const c=chain({
    getSignatureStatuses:async(signatures,options)=>{calls.push({signatures,options});return {context:{slot:200},value:signatures.map(()=>({slot:123,confirmationStatus:'confirmed',err:null}))};},
    getTransaction:()=>assert.fail('An unfinalized status does not need an archival lookup.'),
  });
  const results=await c.receiptBatch(operations);
  assert.equal(calls.length,10);
  assert(calls.every(call=>call.signatures.length===100&&call.options.searchTransactionHistory===true));
  assert.equal(results.length,1000);
  results.forEach((result,index)=>{
    assert.equal(result.operation,operations[index]);assert.equal(result.receipt,null);assert.equal(result.error,null);
    assert.deepEqual(result.operation.observedSignatureStatus,{confirmationStatus:'confirmed',slot:123});
  });
});

test('duplicate signatures share their status and receipt reads, without dropping output rows',async()=>{
  const op=operation(1),duplicate={...op},calls=[];
  const c=chain({
    getSignatureStatuses:async(signatures)=>{calls.push(['status',signatures]);return {context:{slot:200},value:[{slot:123,confirmationStatus:'finalized',err:null}]};},
    getTransaction:async(sig,options)=>{calls.push(['receipt',sig,options]);return receipt(op);},
  });
  const result=await c.receiptBatch([op,duplicate,op]);
  assert.equal(result.length,3);assert.equal(calls.length,2);assert.deepEqual(calls[0][1],[op.signature]);
  assert.deepEqual(calls[1][2],{commitment:'finalized',maxSupportedTransactionVersion:1});
  assert(result.every(row=>row.receipt===result[0].receipt&&!row.error));
  assert.equal(result[1].operation,duplicate);assert.equal(duplicate.observedSignatureStatus.confirmationStatus,'finalized');
});

test('cache-null fallback recovers finalized receipts, and failed statuses still require full receipts',async()=>{
  const ops=[operation(1),operation(2),operation(3)],failed={InstructionError:[0,'Custom']},reads=[];
  const c=chain({
    getSignatureStatuses:async()=>({context:{slot:200},value:[null,{slot:123,confirmationStatus:'finalized',err:failed},null]}),
    getTransaction:async sig=>{reads.push(sig);return sig===ops[2].signature?null:receipt(ops.find(op=>op.signature===sig),sig===ops[1].signature?failed:null);},
  });
  const result=await c.receiptBatch(ops);
  assert.equal(reads.length,3);assert.equal(result[0].receipt.meta.err,null);assert.deepEqual(result[1].receipt.meta.err,failed);
  assert.equal(result[2].receipt,null);assert.equal(result[2].error,null);assert.equal(ops[2].observedSignatureStatus,undefined);
  assert.equal(ops[0].observedSignatureStatus.confirmationStatus,'finalized');
});

test('positive status observations survive archival errors, subsequent cache misses and weaker status reads',async()=>{
  const op=operation(9);let round=0;
  const c=chain({
    getSignatureStatuses:async()=>({context:{slot:200},value:[round===0?{slot:123,confirmationStatus:'finalized',err:null}:round===1?null:{slot:122,confirmationStatus:'processed',err:null}]}),
    getTransaction:async()=>{if(round===0)throw Error('Archival temporarily unavailable');return null;},
  });
  let result=await c.receiptBatch([op]);assert.match(result[0].error.message,/Archival/);assert.equal(result[0].receipt,null);
  round=1;result=await c.receiptBatch([op]);assert.equal(result[0].error,null);assert.equal(result[0].receipt,null);
  round=2;await c.receiptBatch([op]);assert.deepEqual(op.observedSignatureStatus,{confirmationStatus:'finalized',slot:123});
});

test('archival receipt work has at most two concurrent RPC reads',async()=>{
  const ops=Array.from({length:17},(_,index)=>operation(index));let active=0,peak=0,count=0;
  const c=chain({
    getSignatureStatuses:async signatures=>({context:{slot:200},value:signatures.map(()=>null)}),
    getTransaction:async()=>{active++;peak=Math.max(peak,active);await setImmediate();count++;active--;return null;},
  });
  const result=await c.receiptBatch(ops);
  assert.equal(count,17);assert.equal(peak,2);assert(result.every(row=>!row.receipt&&!row.error));
});

test('a capped receipt cycle observes all 100 statuses but reads only its first eight finalized receipts',async()=>{
  const ops=Array.from({length:100},(_,index)=>operation(index)),reads=[];let statusCalls=0;
  const c=chain({
    getSignatureStatuses:async signatures=>{statusCalls++;return {context:{slot:200},value:signatures.map(()=>({slot:123,confirmationStatus:'finalized',err:null}))};},
    getTransaction:async sig=>{reads.push(sig);return receipt(ops.find(op=>op.signature===sig));},
  });
  const result=await c.receiptBatch(ops,{maxReceiptReads:8});
  assert.equal(statusCalls,1);assert.deepEqual(reads,ops.slice(0,8).map(op=>op.signature));
  assert(result.every(row=>!row.error&&row.operation.observedSignatureStatus.confirmationStatus==='finalized'));
  assert(result.slice(0,8).every(row=>row.receipt));assert(result.slice(8).every(row=>row.receipt===null));
});

test('the receipt read cap applies across status batches and zero permits status-only observation',async()=>{
  const ops=Array.from({length:205},(_,index)=>operation(index)),reads=[];let statusCalls=0;
  const c=chain({
    getSignatureStatuses:async signatures=>{statusCalls++;return {context:{slot:200},value:signatures.map(()=>({slot:123,confirmationStatus:'finalized',err:null}))};},
    getTransaction:async sig=>{reads.push(sig);return null;},
  });
  await c.receiptBatch(ops,{maxReceiptReads:103});assert.equal(statusCalls,3);assert.deepEqual(reads,ops.slice(0,103).map(op=>op.signature));
  reads.length=0;const result=await c.receiptBatch(ops,{maxReceiptReads:0});assert.equal(statusCalls,6);assert.equal(reads.length,0);
  assert(result.every(row=>!row.error&&!row.receipt&&row.operation.observedSignatureStatus.confirmationStatus==='finalized'));
  for(const maxReceiptReads of [-1,1001,1.5,'8',null,NaN])await assert.rejects(c.receiptBatch(ops,{maxReceiptReads}),/read limit/);
  assert.equal(statusCalls,6);
});

test('invalid signatures and individual receipt errors cannot classify other trades as failed',async()=>{
  const ops=[{signature:'invalid'},operation(2),operation(3),{signature:bs58.encode(Buffer.alloc(64))}],queried=[];
  const c=chain({
    getSignatureStatuses:async signatures=>{queried.push(...signatures);return {context:{slot:200},value:signatures.map(()=>({slot:123,confirmationStatus:'finalized',err:null}))};},
    getTransaction:async sig=>sig===ops[1].signature?receipt(ops[2]):receipt(ops[2]),
  });
  const result=await c.receiptBatch(ops);
  assert.deepEqual(queried,[ops[1].signature,ops[2].signature]);assert(result[0].error);assert(result[3].error);
  assert.match(result[1].error.message,/signature mismatch/);assert.equal(result[1].receipt,null);
  assert.equal(result[2].receipt.transaction.signatures[0],ops[2].signature);assert.equal(result[2].error,null);
  assert.equal(ops[1].observedSignatureStatus.confirmationStatus,'finalized');
});

test('missing status entries and incomplete receipts remain unresolved',async()=>{
  const op=operation(1);let round=0;
  const c=chain({
    getSignatureStatuses:async()=>({context:{slot:200},value:round===0?[]:[null]}),
    getTransaction:async()=>({slot:123,transaction:{signatures:[op.signature]}}),
  });
  let result=await c.receiptBatch([op]);assert.match(result[0].error.message,/incomplete trade status/);assert.equal(result[0].receipt,null);
  round=1;result=await c.receiptBatch([op]);assert.match(result[0].error.message,/incomplete trade receipt/);assert.equal(result[0].receipt,null);
  assert.equal(op.observedSignatureStatus.confirmationStatus,'finalized');
});

function signedOperation(key=Keypair.generate(),lamports=1) {
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:key.publicKey,recentBlockhash:SystemProgram.programId.toBase58(),instructions:[SystemProgram.transfer({fromPubkey:key.publicKey,toPubkey:Keypair.generate().publicKey,lamports})]}).compileToV0Message());
  tx.sign([key]);const bytes=Buffer.from(tx.serialize());
  return {key,tx,op:{raw:bytes.toString('base64'),signature:bs58.encode(tx.signatures[0]),blockhash:tx.message.recentBlockhash,broadcastRawHash:createHash('sha256').update(bytes).digest('hex')}};
}

test('same-byte rebroadcast verification accepts only the saved signed v0 transaction and payer',()=>{
  const c=chain({}),{op,key}=signedOperation(),wallet=key.publicKey.toBase58();
  assert.equal(c.verifyBroadcastOperation(op,wallet),true);
  const other=signedOperation(key,2);
  for(const mutation of [{signature:signature(123)},{broadcastRawHash:'0'.repeat(64)},{broadcastRawHash:undefined},{blockhash:Keypair.generate().publicKey.toBase58()},{needsSignature:true},{raw:op.raw+'\n'},{raw:other.op.raw,signature:other.op.signature}])assert.throws(()=>c.verifyBroadcastOperation({...op,...mutation},wallet));
  assert.throws(()=>c.verifyBroadcastOperation(op,Keypair.generate().publicKey.toBase58()));
  assert.throws(()=>c.verifyBroadcastOperation(op,''));
});

test('a matching raw hash cannot make an invalid cryptographic signature valid',()=>{
  const c=chain({}),{op,key,tx}=signedOperation();tx.signatures[0][0]^=1;
  const bytes=Buffer.from(tx.serialize()),tampered={...op,raw:bytes.toString('base64'),signature:bs58.encode(tx.signatures[0]),broadcastRawHash:createHash('sha256').update(bytes).digest('hex')};
  assert.throws(()=>c.verifyBroadcastOperation(tampered,key.publicKey.toBase58()),/signature verification/);
});

test('same-byte rebroadcast verification rejects additional signers and legacy messages',()=>{
  const c=chain({}),key=Keypair.generate(),other=Keypair.generate();
  const builder=new TransactionMessage({payerKey:key.publicKey,recentBlockhash:SystemProgram.programId.toBase58(),instructions:[SystemProgram.transfer({fromPubkey:other.publicKey,toPubkey:key.publicKey,lamports:1})]});
  for(const message of [builder.compileToV0Message(),builder.compileToLegacyMessage()]){
    const tx=new VersionedTransaction(message);tx.sign([key,other]);const bytes=Buffer.from(tx.serialize());
    const op={raw:bytes.toString('base64'),signature:bs58.encode(tx.signatures[0]),blockhash:message.recentBlockhash,broadcastRawHash:createHash('sha256').update(bytes).digest('hex')};
    assert.throws(()=>c.verifyBroadcastOperation(op,key.publicKey.toBase58()));
  }
});

test('broadcast blocks an expired deadline or denied authorization before calling an injected RPC',async()=>{
  const {op}=signedOperation();let sends=0,authorizations=0;
  const c=chain({sendRawTransaction:async()=>{sends++;return op.signature;}});
  await assert.rejects(c.broadcast(op,{deadline:Date.now()-1,authorize:async()=>{authorizations++;}}),/deadline expired/);
  assert.equal(authorizations,0);assert.equal(sends,0);
  await assert.rejects(c.broadcast(op,{deadline:Date.now()+10000,authorize:async()=>{authorizations++;throw Error('Session revoked');}}),/Session revoked/);
  assert.equal(authorizations,1);assert.equal(sends,0);
});

test('broadcast rechecks its deadline after authorization yields',async t=>{
  const {op}=signedOperation();let now=1000,sends=0;
  t.mock.method(Date,'now',()=>now);
  const c=chain({sendRawTransaction:async()=>{sends++;return op.signature;}});
  await assert.rejects(c.broadcast(op,{deadline:1010,authorize:async()=>{now=1011;}}),/deadline expired/);
  assert.equal(sends,0);
});

test('broadcast passes its deadline and a fresh authorization hook to the paced RPC context',async()=>{
  const {op}=signedOperation();let context,authorizations=0,sends=0;
  const deadline=Date.now()+10000,c=chain({sendRawTransaction:async()=>{await context.authorizeBeforeSend();sends++;return op.signature;}});
  c.withRpcContext=async(options,task)=>{context=options;return task();};
  await c.broadcast(op,{deadline,authorize:async()=>{authorizations++;}});
  assert.equal(context.deadline,deadline);assert.equal(typeof context.authorizeBeforeSend,'function');
  assert.equal(authorizations,2);assert.equal(sends,1);
  await assert.rejects(c.broadcast(op,{deadline,authorize:'invalid'}),/authorization callback/);
});
