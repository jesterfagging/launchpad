import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PumpPublicClientAdapter } from '../src/pump-public-adapter.mjs';
import { PumpPublicService } from '../src/pump-public-service.mjs';
import { PUBLIC_PROGRAM_ID, addresses } from '../src/pump-public-client.mjs';

function fixture() {
  const mint=Keypair.generate().publicKey.toBase58(),creator=Keypair.generate().publicKey.toBase58();
  const config={programId:PUBLIC_PROGRAM_ID},launch={mint,creatorWallet:creator,status:'draft',priceSnapshot:{solUsdMicros:'200000000'}};
  const a=addresses({programId:PUBLIC_PROGRAM_ID,mint}),mintData=Buffer.alloc(82);mintData.writeBigUInt64LE(1000000000000000n,36);
  const op={id:'launch',mint,action:'initialize',state:'pending',signature:'saved-signature',signedTransaction:'saved-wire',bundle:{blockhash:{blockhash:'saved-blockhash',lastValidBlockHeight:200}}};
  let confirmation='confirmed',wire='saved-wire';
  const commitments=[];
  const receipt={slot:100,meta:{err:null,innerInstructions:[{instructions:[{programId:TOKEN_PROGRAM_ID,parsed:{type:'mintTo',info:{mint,account:a.baseAta.toBase58(),amount:'1000000000000000'}}}]}]}};
  const connection={getSignatureStatuses:async()=>({value:[{confirmationStatus:confirmation,err:null}]}),getBlockHeight:async()=>100,
    _rpcRequest:async(_method,[,options])=>{commitments.push(options.commitment);return{result:{meta:{err:null},transaction:[wire,'base64']}};},
    getParsedTransaction:async(_sig,options)=>{commitments.push(options.commitment);return receipt;},
    getAccountInfo:async(_key,options)=>{assert.equal(options.minContextSlot,100);commitments.push(options.commitment);return{owner:TOKEN_PROGRAM_ID,data:mintData};}};
  const adapter=new PumpPublicClientAdapter({connection});adapter.rawState=async(_config,_launch,commitment,minContextSlot)=>{commitments.push(commitment);assert.equal(minContextSlot,100);return{slot:100,state:{phase:0,creatorFeesPending:'0',creatorFeesPaid:'0'}};};
  return{adapter,config,launch,op,receipt,mintData,commitments,setConfirmation:v=>confirmation=v,setWire:v=>wire=v};
}
test('initialization opens after exact confirmed receipt, with no finalized claim',async()=>{
  const f=fixture(),result=await f.adapter.reconcile(f.config,f.op,f.launch);
  assert.equal(result.state,'confirmed');assert.equal(result.phase,'trading');assert.ok(f.commitments.every(v=>v==='confirmed'));
  f.setConfirmation('finalized');f.commitments.length=0;
  assert.equal((await f.adapter.reconcile(f.config,f.op,f.launch)).state,'finalized');assert.ok(f.commitments.every(v=>v==='finalized'));
});
test('confirmed initialization still rejects mutated wire, wrong supply and retained mint authority',async()=>{
  const f=fixture();f.setWire('other-wire');await assert.rejects(f.adapter.reconcile(f.config,f.op,f.launch),/saved signed transaction/);
  f.setWire('saved-wire');f.receipt.meta.innerInstructions[0].instructions[0].parsed.info.amount='1';await assert.rejects(f.adapter.reconcile(f.config,f.op,f.launch),/vault supply/);
  f.receipt.meta.innerInstructions[0].instructions[0].parsed.info.amount='1000000000000000';f.mintData.writeUInt32LE(1,0);await assert.rejects(f.adapter.reconcile(f.config,f.op,f.launch),/revoked authorities/);
});
test('processed initialization and confirmed migration do not bypass finalized burn verification',async()=>{
  const f=fixture();f.setConfirmation('processed');assert.equal((await f.adapter.reconcile(f.config,f.op,f.launch)).state,'pending');
  f.setConfirmation('confirmed');f.op.action='migrate';assert.equal((await f.adapter.reconcile(f.config,f.op,f.launch)).state,'pending');assert.equal(f.commitments.length,0);
});
function serviceFixture() {
  const launch={mint:'mint',status:'draft'},op={id:'init',mint:'mint',action:'initialize',state:'pending',signature:'signature'};
  const db={schemaVersion:1,config:{},relayer:{},launches:[launch],operations:[op],enabled:true,migrationCursor:0};
  const service=new PumpPublicService({accounts:{hostStore:{read:async()=>db}},now:()=>123456});
  return{service,db,launch,op};
}
test('confirmed launch is visible but pending accounting and graduation wait for finality',async()=>{
  const f=serviceFixture();f.service.applyReceipt(f.db,f.op,{state:'confirmed',phase:'trading',trade:{quote:1}});
  assert.equal((await f.service.publicList())[0].confirmationStatus,'confirmed');assert.equal(f.launch.finalizedAt,undefined);assert.equal(f.op.trade,undefined);
  let stateReads=0;f.service.adapter={state:async()=>{stateReads++;throw Error('must not graduate');}};
  await f.service.graduateCandidate(f.db,f.launch);assert.equal(stateReads,0);
  f.service.applyReceipt(f.db,f.op,{state:'pending'});assert.equal(f.op.state,'confirmed','Late pending RPC responses cannot regress confirmed UI');
  f.service.applyReceipt(f.db,f.op,{state:'finalized',phase:'trading',trade:{quote:1}});
  assert.equal(f.launch.confirmationStatus,'finalized');assert.equal(f.launch.finalizedAt,123456);assert.equal(f.op.trade.quote,1);
});
test('orphaned confirmed launch is removed from public discovery and cannot be reported as finalized',async()=>{
  const f=serviceFixture();f.service.applyReceipt(f.db,f.op,{state:'confirmed',phase:'trading'});
  f.service.applyReceipt(f.db,f.op,{state:'expired'});assert.equal((await f.service.publicList()).length,0);assert.equal(f.launch.finalizedAt,undefined);
  assert.throws(()=>f.service.applyReceipt(f.db,{...f.op,action:'migrate'},{state:'confirmed',phase:'migrated'}),/Only initialization/);
});
