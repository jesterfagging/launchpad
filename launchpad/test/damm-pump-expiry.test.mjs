import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressLookupTableAccount, Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { proveExpiredDammPumpAbsence } from '../src/damm-pump-expiry.mjs';
import { DammPumpClientAdapter } from '../src/damm-pump-chain.mjs';
import { DammPumpService } from '../src/damm-pump-service.mjs';

const hash=()=>bs58.encode(randomBytes(32)),signature=()=>bs58.encode(randomBytes(64));
function fixture(){
  const payer=Keypair.generate(),recipient=Keypair.generate().publicKey,table=new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:{deactivationSlot:(1n<<64n)-1n,lastExtendedSlot:90,lastExtendedSlotStartIndex:0,authority:undefined,addresses:[recipient]}});
  const blockhash=hash(),tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:blockhash,instructions:[SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:recipient,lamports:1n})]}).compileToV0Message([table]));
  const unsignedTransaction=Buffer.from(tx.serialize()).toString('base64');tx.sign([payer]);
  const op={wallet:payer.publicKey.toBase58(),signature:bs58.encode(tx.signatures[0]),signedTransaction:Buffer.from(tx.serialize()).toString('base64'),bundle:{preparedAtSlot:100,blockhash:{blockhash,lastValidBlockHeight:91},unsignedTransaction,addressLookupTables:[{address:table.key.toBase58(),addresses:[recipient.toBase58()]}]}};
  const blocks=new Map();let previous=hash();
  for(let slot=100;slot<=145;slot++){const block={blockHeight:slot-11,parentSlot:slot-1,previousBlockhash:previous,blockhash:hash(),signatures:[signature()]};blocks.set(slot,block);previous=block.blockhash;}
  const connection={
    getEpochInfo:async()=>({absoluteSlot:200,blockHeight:189}),getBlockHeight:async()=>189,getFirstAvailableBlock:async()=>1,
    getSignatureStatuses:async()=>({context:{slot:200},value:[null]}),getTransaction:async()=>null,
    isBlockhashValid:async()=>({context:{slot:200},value:false}),getSignaturesForAddress:async()=>[],
    getBlocks:async(start,end)=>[...blocks.keys()].filter(slot=>slot>=start&&slot<=end),
    _rpcRequest:async(_method,params)=>({jsonrpc:'2.0',id:1,result:blocks.get(params[0])}),
  };
  return {payer,tx,op,connection,blocks,run:()=>proveExpiredDammPumpAbsence(connection,op)};
}

test('a genuinely absent signed v0 packet with an ALT can expire after full finalized block proof',async()=>{
  const f=fixture();assert.equal(f.tx.message.addressTableLookups.length,1);assert.equal(await f.run(),true);
  const adapter=new DammPumpClientAdapter({connection:f.connection});
  assert.equal((await adapter.reconcile({},f.op,{})).state,'expired');
});

test('null signature indexes cannot clear a trade whose signature exists in a finalized block',async()=>{
  const f=fixture();f.blocks.get(110).signatures.push(f.op.signature);assert.equal(await f.run(),false);
  const result=await new DammPumpClientAdapter({connection:f.connection}).reconcile({},f.op,{});
  assert.equal(result.state,'pending');assert.equal(result.canRebroadcast,false);
});

test('a historical finalized receipt recovers an outcome when the signature index is missing',async()=>{
  const f=fixture();f.connection.getTransaction=async()=>({slot:110,transaction:{signatures:[f.op.signature]},meta:{err:{InstructionError:[0,'InsufficientFunds']}}});
  const result=await new DammPumpClientAdapter({connection:f.connection}).reconcile({},f.op,{});
  assert.equal(result.state,'failed');assert.equal(result.observedSignatureStatus.confirmationStatus,'finalized');assert.equal(result.observedSignatureStatus.slot,110);
});

test('old journals, malformed lookup snapshots and altered reviewed instructions never authorize replacement',async()=>{
  for(const change of [f=>delete f.op.bundle.preparedAtSlot,f=>f.op.bundle.addressLookupTables=[],f=>f.op.observedSignatureStatus={confirmationStatus:'confirmed',slot:110},f=>{
    const tx=VersionedTransaction.deserialize(Buffer.from(f.op.signedTransaction,'base64'));tx.message.compiledInstructions[0].data[4]=2;tx.sign([f.payer]);f.op.signedTransaction=Buffer.from(tx.serialize()).toString('base64');f.op.signature=bs58.encode(tx.signatures[0]);
  }]){const f=fixture();change(f);assert.equal(await f.run(),false);}
});

test('a previously observed signature stays pending when all indexes temporarily lose it',async()=>{
  const f=fixture();f.op.observedSignatureStatus={confirmationStatus:'confirmed',slot:110};
  const result=await new DammPumpClientAdapter({connection:f.connection}).reconcile({},f.op,{});
  assert.equal(result.state,'pending');assert.equal(result.canRebroadcast,false);assert.deepEqual(result.observedSignatureStatus,f.op.observedSignatureStatus);
});

test('legacy signed journals clearly request administrator receipt recovery instead of implying an automatic retry',async()=>{
  const f=fixture();delete f.op.bundle.preparedAtSlot;
  const result=await new DammPumpClientAdapter({connection:f.connection}).reconcile({},f.op,{});
  assert.equal(result.state,'pending');assert.equal(result.canRebroadcast,false);assert.match(result.notice,/administrator must recover its on-chain receipt/);
});

test('an observed finalized status is retained while its exact receipt is still indexing',async()=>{
  const f=fixture();f.connection.getSignatureStatuses=async()=>({value:[{confirmationStatus:'finalized',slot:110,err:null}]});f.connection._rpcRequest=async()=>({result:null});
  const result=await new DammPumpClientAdapter({connection:f.connection}).reconcile({},f.op,{});
  assert.equal(result.state,'pending');assert.equal(result.canRebroadcast,false);assert.equal(result.observedSignatureStatus.confirmationStatus,'finalized');
});

test('signature observations persist monotonically and block an inconsistent expired service result',()=>{
  const op={mint:'saved',action:'fund-quote',state:'pending'},data={launches:[{mint:'saved'}]},service={now:()=>1};
  const apply=result=>DammPumpService.prototype.applyReceipt.call(service,data,op,result);
  apply({state:'pending',observedSignatureStatus:{confirmationStatus:'confirmed',slot:110}});
  apply({state:'pending',observedSignatureStatus:{confirmationStatus:'processed',slot:109}});
  assert.deepEqual(op.observedSignatureStatus,{confirmationStatus:'confirmed',slot:110});
  assert.throws(()=>apply({state:'expired'}),/previously observed/);assert.equal(op.state,'pending');
});
