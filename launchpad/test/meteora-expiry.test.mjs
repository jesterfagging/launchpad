import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { proveExpiredAbsence, METEORA_EXPIRY_LIMITS } from '../src/meteora-expiry.mjs';

const hash=()=>bs58.encode(randomBytes(32)),signature=()=>bs58.encode(randomBytes(64));
const row=(slot=99,sig=signature())=>({slot,signature:sig,err:null,memo:null,blockTime:null,confirmationStatus:'finalized'});
function fixture(){
  const payer=Keypair.generate(),blockhash=hash(),message=new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:blockhash,instructions:[SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1n})]}).compileToV0Message();
  const tx=new VersionedTransaction(message),unsignedTransaction=Buffer.from(tx.serialize()).toString('base64');tx.sign([payer]);
  const op={state:'pending',wallet:payer.publicKey.toBase58(),signature:bs58.encode(tx.signatures[0]),signedTransaction:Buffer.from(tx.serialize()).toString('base64'),bundle:{preparedAtSlot:100,blockhash:{blockhash,lastValidBlockHeight:91},lastValidBlockHeight:91,unsignedTransaction}};
  const blocks=new Map();let previous=hash();
  for(let slot=100;slot<=145;slot++){const block={blockHeight:slot-11,parentSlot:slot-1,previousBlockhash:previous,blockhash:hash(),signatures:[signature()],blockTime:1000+slot};blocks.set(slot,block);previous=block.blockhash;}
  const calls=[],history=[[row()]],checkpoints=[{absoluteSlot:200,blockHeight:189},{absoluteSlot:201,blockHeight:190}];let epoch=0,page=0;
  const connection={
    getEpochInfo:async commitment=>{calls.push(['checkpoint',commitment]);return checkpoints[Math.min(epoch++,checkpoints.length-1)];},
    getFirstAvailableBlock:async()=>{calls.push(['retention']);return 1;},
    getSignatureStatuses:async(signatures,options)=>{calls.push(['status',signatures,options]);return {context:{slot:1000000},value:[null]};},
    getTransaction:async(sig,options)=>{calls.push(['transaction',sig,options]);return null;},
    isBlockhashValid:async(value,options)=>{calls.push(['valid',value,options]);return {context:{slot:1000000},value:false};},
    getSignaturesForAddress:async(address,options,commitment)=>{calls.push(['history',address.toBase58(),options,commitment]);const index=page++;return Object.hasOwn(history,index)?history[index]:[];},
    getBlocks:async(start,end,commitment)=>{calls.push(['blocks',start,end,commitment]);return [...blocks.keys()].filter(slot=>slot>=start&&slot<=end);},
    _rpcRequest:async(method,params)=>{calls.push(['block',method,params]);return {jsonrpc:'2.0',id:1,result:blocks.get(params[0])};},
  };
  return {connection,op,blocks,calls,history,checkpoints,run:()=>proveExpiredAbsence(connection,op)};
}

test('expired absence requires complete finalized block coverage and fresh status, receipt and expiry rechecks',async()=>{
  const f=fixture();assert.equal(await f.run(),true);
  assert.equal(f.calls.filter(c=>c[0]==='status').length,2);assert.equal(f.calls.filter(c=>c[0]==='transaction').length,2);assert.equal(f.calls.filter(c=>c[0]==='valid').length,2);
  const reads=f.calls.filter(c=>c[0]==='block');assert(reads.length>=36&&reads.length<=39);assert(reads.every(c=>c[1]==='getBlock'&&c[2][1].commitment==='finalized'&&c[2][1].transactionDetails==='signatures'));
  assert(f.calls.filter(c=>c[0]==='status').every(c=>c[2].searchTransactionHistory===true));
  assert.deepEqual(f.calls.find(c=>c[0]==='history').slice(1),[f.op.wallet,{limit:1000,minContextSlot:200},'finalized']);
});

test('late reconciliation scans the original expiry window, not every block since hours ago',async()=>{
  const f=fixture();f.checkpoints.splice(0,2,{absoluteSlot:500000,blockHeight:499000},{absoluteSlot:500001,blockHeight:499001});
  assert.equal(await f.run(),true);assert.deepEqual(f.calls.find(c=>c[0]==='blocks').slice(1),[100,2148,'finalized']);assert(f.calls.filter(c=>c[0]==='block').length<40);
});

test('missing or altered pre-broadcast identity cannot authorize a replacement',async()=>{
  for(const change of [f=>delete f.op.bundle.preparedAtSlot,f=>f.op.bundle.preparedAtSlot=0,f=>f.op.bundle.preparedAtSlot=100.5,f=>f.op.wallet=Keypair.generate().publicKey.toBase58(),f=>f.op.signature=signature(),f=>f.op.bundle.blockhash.blockhash=hash(),f=>f.op.bundle.lastValidBlockHeight=92,f=>f.op.signedTransaction+='\n',f=>f.op.observedSignatureStatus={slot:101}]){
    const f=fixture();change(f);assert.equal(await f.run(),false);assert.equal(f.calls.length,0);
  }
  const f=fixture(),tx=VersionedTransaction.deserialize(Buffer.from(f.op.signedTransaction,'base64'));tx.signatures[0][0]^=1;f.op.signature=bs58.encode(tx.signatures[0]);f.op.signedTransaction=Buffer.from(tx.serialize()).toString('base64');assert.equal(await f.run(),false);assert.equal(f.calls.length,0);
});

test('durable nonce transactions cannot be cleared by a recent-blockhash height limit',async()=>{
  const f=fixture(),payer=Keypair.generate(),message=new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:f.op.bundle.blockhash.blockhash,instructions:[SystemProgram.nonceAdvance({noncePubkey:Keypair.generate().publicKey,authorizedPubkey:payer.publicKey})]}).compileToV0Message(),tx=new VersionedTransaction(message);
  f.op.bundle.unsignedTransaction=Buffer.from(tx.serialize()).toString('base64');tx.sign([payer]);f.op.wallet=payer.publicKey.toBase58();f.op.signature=bs58.encode(tx.signatures[0]);f.op.signedTransaction=Buffer.from(tx.serialize()).toString('base64');
  assert.equal(await f.run(),false);assert.equal(f.calls.length,0);
});

test('wall time or height expiry alone, stale checkpoints and unknown blockhash validity never clear a journal',async()=>{
  for(const change of [f=>f.checkpoints[0].blockHeight=123,f=>f.checkpoints[0].absoluteSlot=99,f=>f.connection.isBlockhashValid=async()=>({context:{slot:200},value:true}),f=>f.connection.isBlockhashValid=async()=>({context:{slot:199},value:false}),f=>f.connection.getFirstAvailableBlock=async()=>101,f=>f.connection.getFirstAvailableBlock=async()=>null]){
    const f=fixture();change(f);assert.equal(await f.run(),false);assert.equal(f.calls.filter(c=>c[0]==='block').length,0);
  }
});

test('any observed signature or transaction keeps the saved operation pending for receipt reconciliation',async()=>{
  for(const status of [{confirmationStatus:'processed',err:null},{confirmationStatus:'confirmed',err:null},{confirmationStatus:'finalized',err:null},{confirmationStatus:'finalized',err:{InstructionError:[0,'Custom']}},undefined]){
    const f=fixture();f.connection.getSignatureStatuses=async()=>({context:{slot:200},value:[status]});assert.equal(await f.run(),false);assert.equal(f.calls.filter(c=>c[0]==='block').length,0);
  }
  for(const receipt of [{slot:101,meta:{err:null}},{slot:101,meta:{err:{InstructionError:[]}}},{},undefined]){
    const f=fixture();f.connection.getTransaction=async()=>receipt;assert.equal(await f.run(),false);
  }
});

test('payer history reads short pages through an older anchor or explicit empty page, never assumes short means complete',async()=>{
  const f=fixture(),a=row(180),b=row(110);f.history.splice(0,1,[a],[b],[]);assert.equal(await f.run(),true);
  const reads=f.calls.filter(c=>c[0]==='history');assert.equal(reads.length,3);assert.equal(reads[1][2].before,a.signature);assert.equal(reads[2][2].before,b.signature);
  const empty=fixture();empty.history.splice(0,1,[]);assert.equal(await empty.run(),true,'empty address index requires independent complete block coverage');
});

test('malformed, duplicated, unordered, partial or nonfinalized payer history is never absence proof',async()=>{
  const duplicated=row(150);
  for(const pages of [[null],[[row(101),row(102)]],[[duplicated],[duplicated]],[[{...row(),confirmationStatus:'confirmed'}]],[[{...row(),err:undefined}]],[[{...row(),signature:'invalid'}]],[[{...row(),slot:NaN}]],Array.from({length:20},()=>[row(150)])]){
    const f=fixture();f.history.splice(0,1,...pages);assert.equal(await f.run(),false);
  }
  const found=fixture();found.history.splice(0,1,[row(105,found.op.signature)]);assert.equal(await found.run(),false);
});

test('a transaction omitted by all address/status indexes is still detected in its finalized block',async()=>{
  const f=fixture();f.blocks.get(110).signatures.push(f.op.signature);assert.equal(await f.run(),false);
});

test('omitted produced blocks and broken parent, hash or height continuity cannot appear complete',async()=>{
  for(const change of [f=>f.blocks.delete(100),f=>f.connection.getBlocks=async()=>[...f.blocks.keys()].filter(slot=>slot!==110),f=>f.blocks.get(110).parentSlot=108,f=>f.blocks.get(110).previousBlockhash=hash(),f=>f.blocks.get(110).blockHeight++,f=>f.blocks.get(100).blockHeight=92,f=>f.blocks.get(110).blockhash=f.blocks.get(110).previousBlockhash]){
    const f=fixture();change(f);assert.equal(await f.run(),false);
  }
});

test('unavailable, malformed, duplicate-signature and unsupported block payloads retain the journal',async()=>{
  for(const change of [f=>f.blocks.set(110,null),f=>delete f.blocks.get(110).blockHeight,f=>f.blocks.get(110).signatures=null,f=>f.blocks.get(110).signatures.push('bad'),f=>f.blocks.get(110).signatures.push(f.blocks.get(109).signatures[0]),f=>f.connection._rpcRequest=async()=>({jsonrpc:'2.0',error:{code:-32601,message:'not available'}}),f=>f.connection.getBlocks=async()=>[100,100],f=>f.connection.getBlocks=async()=>[100,10000]]){
    const f=fixture();change(f);assert.equal(await f.run(),false);
  }
});

test('a skipped slot is safe only when the next produced block points directly to its retained predecessor',async()=>{
  const f=fixture(),rows=[...f.blocks.values()];f.blocks.clear();for(let i=0;i<rows.length;i++){const slot=100+i*2;f.blocks.set(slot,{...rows[i],parentSlot:i?slot-2:99});}
  assert.equal(await f.run(),true);
});

test('fresh final checks catch a late-indexed transaction, pruned retention or regressing finalized head',async()=>{
  for(const kind of ['status','receipt','retention','checkpoint','blockhash']){
    const f=fixture();let n=0;
    if(kind==='status')f.connection.getSignatureStatuses=async()=>({context:{slot:1000},value:[++n===1?null:{confirmationStatus:'finalized',err:null}]});
    if(kind==='receipt')f.connection.getTransaction=async()=>++n===1?null:{slot:110,meta:{err:null}};
    if(kind==='retention')f.connection.getFirstAvailableBlock=async()=>++n===1?1:101;
    if(kind==='checkpoint')f.checkpoints[1]={absoluteSlot:199,blockHeight:188};
    if(kind==='blockhash')f.connection.isBlockhashValid=async()=>({context:{slot:1000},value:++n!==1});
    assert.equal(await f.run(),false,kind);
  }
});

test('bounded block coverage and elapsed work never authorize incomplete absence',async t=>{
  const limited=fixture();limited.op.bundle.blockhash.lastValidBlockHeight=99999;limited.op.bundle.lastValidBlockHeight=99999;limited.checkpoints.splice(0,2,{absoluteSlot:200000,blockHeight:199999});assert.equal(await limited.run(),false);
  const short=fixture();for(const slot of [...short.blocks.keys()])if(slot>120)short.blocks.delete(slot);assert.equal(await short.run(),false);
  const timeout=fixture();let now=1000;t.mock.method(Date,'now',()=>now);const original=timeout.connection.getBlocks;timeout.connection.getBlocks=async(...args)=>{const value=await original(...args);now+=METEORA_EXPIRY_LIMITS.deadlineMs;return value;};assert.equal(await timeout.run(),false);assert.equal(timeout.calls.filter(c=>c[0]==='block').length,0);
});

test('block proof never exceeds its fixed 512 produced-block budget',async()=>{
  const f=fixture();f.op.bundle.blockhash.lastValidBlockHeight=600;f.op.bundle.lastValidBlockHeight=600;f.checkpoints.splice(0,2,{absoluteSlot:1500,blockHeight:1200});f.blocks.clear();let previous=hash();
  for(let slot=100;slot<800;slot++){const block={blockHeight:slot-11,parentSlot:slot-1,previousBlockhash:previous,blockhash:hash(),signatures:[],blockTime:0};f.blocks.set(slot,block);previous=block.blockhash;}
  assert.equal(await f.run(),false);assert.equal(f.calls.filter(c=>c[0]==='block').length,METEORA_EXPIRY_LIMITS.maxBlocks);
});

test('RPC exceptions return false without exposing payloads or mutating durable operations',async()=>{
  const f=fixture(),before=structuredClone(f.op);f.connection.getEpochInfo=async()=>{throw Error('provider URL with secret');};assert.equal(await f.run(),false);assert.deepEqual(f.op,before);
});
