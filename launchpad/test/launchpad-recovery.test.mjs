import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Launchpad } from '../src/launchpad.mjs';
import { LaunchChain, ray, rayCurveAtTarget, decodeRay } from '../src/launchpad-chain.mjs';
import { newLaunchKeys } from '../src/launchpad-receipts.mjs';
import { SOL_MINT, launchInput } from '../public/launchpad-model.mjs';
import { verifySignedTransaction } from '../src/providers.mjs';

const fixture=JSON.parse(await readFile(new URL('./launchpad-accounts.json',import.meta.url),'utf8'));
const config=decodeRay({...fixture.rayConfig.account,owner:new PublicKey(fixture.rayConfig.account.owner),data:Buffer.from(fixture.rayConfig.account.data[0],'base64')},ray.LAUNCHPAD_PROGRAM,ray.LaunchpadConfig,'GlobalConfig');
const contextLag=()=>Object.assign(Error('Minimum context slot has not been reached'),{code:-32016});

// Start after the already confirmed setup: recovery must never repeat funding.
// The Raydium instruction builder, v0 serialization, server partial signature,
// external signature acceptance, durable journal and receipts are all real.
// Only network reads/broadcasts and the final account verification are fixtures.
async function harness(t){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-launch-recovery-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const books=new Map(),external=Keypair.generate(),owner=external.publicKey.toBase58(),keys=newLaunchKeys();
  keys.platform=keys.wallet;keys.payer={address:owner,external:true};keys.wallet=keys.payer;
  let clock=Date.now(),height=100,simulationError=null,simulationFailure=null,receiptError=null,finalized=true;
  const counts={prepare:0,simulate:0,receipt:0,preflight:0,verify:0},broadcasts=[],receipts=new Map(),sleeps=[];
  const input=launchInput({name:'Recovery',symbol:'REC',quoteMint:SOL_MINT,feeMode:'creator',walletMode:'external',externalWallet:owner,devBuySol:'0'});
  const id='a'.repeat(32),launch={id,input,keys,executionPlan:'compact-v2',state:'launching',phase:'create',authorizedAt:clock,createdAt:clock,reviewExpires:clock+180000,reviewHash:'review',uri:'https://gateway.irys.xyz/'+'a'.repeat(43),storage:{budget:'0',items:[]},review:{...rayCurveAtTarget(config,9,'100'),configId:fixture.rayConfig.pubkey,cpConfigId:'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2',quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:9,price:{usd:'100'},minimumSol:'0.06',platformRent:'15000000',storageWalletRent:'890880',serviceReserve:'0',creatorFeeBps:25,protocolFeeBps:25,devBuy:{gross:'0',net:'0',maxQuote:'0',solBudget:'0'}},operations:[{operationId:'b'.repeat(32),kind:'setup',state:'confirmed',signature:'prior-confirmed-setup',createdAt:clock-10000}],credits:{quote:'0',base:'0'},gas:{day:new Date(clock).toISOString().slice(0,10),reserved:'0'},autoFees:false};
  books.set('a:launchpad',{version:1,launches:[launch]});
  const saved=()=>books.get('a:launchpad').launches[0];
  const accounts={dir,get:async()=>({mainWallet:owner}),storeFor:account=>({dir:join(dir,account),read:async(key,fallback)=>structuredClone(books.get(account+':'+key)??fallback),write:async(key,value)=>books.set(account+':'+key,structuredClone(value))})};
  const connection={
    getBalance:async()=>1000000000,
    getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:height+100}),
    getBlockHeight:async()=>height,
    simulateTransaction:async tx=>{
      counts.simulate++;
      assert(tx instanceof VersionedTransaction);
      assert(tx.message.staticAccountKeys[0].equals(external.publicKey));
      assert(tx.message.staticAccountKeys.some(k=>k.toBase58()===keys.mint.address));
      if(simulationError)throw simulationError;
      return {value:{err:simulationFailure,unitsConsumed:120000}};
    },
    sendRawTransaction:async bytes=>{
      const tx=VersionedTransaction.deserialize(bytes),{signature}=verifySignedTransaction(bytes,owner,[keys.mint.address]);
      const op=saved().operations.find(o=>o.signature===signature);
      assert(op,'the exact signed transaction must be saved before broadcast');
      assert.equal(op.raw,Buffer.from(bytes).toString('base64'));assert.equal(op.state,'pending');
      broadcasts.push(signature);
      receipts.set(signature,{slot:150,transaction:{signatures:[signature],message:tx.message},meta:{err:null,fee:12000,preTokenBalances:[],postTokenBalances:[]}});
      return signature;
    },
    getSignatureStatuses:async signatures=>{counts.receipt++;if(receiptError)throw receiptError;return {value:signatures.map(signature=>finalized&&receipts.has(signature)?{confirmationStatus:'finalized'}:null)};},
    // Finalized receipt queries cannot expose the unfinalized fixture.
    getTransaction:async signature=>finalized?receipts.get(signature)||null:null,
  };
  const chain=new LaunchChain({network:'mainnet-beta',connection,sleep:async ms=>{sleeps.push(ms);}});
  const prepare=chain.prepare.bind(chain);chain.prepare=async(...args)=>{counts.prepare++;return prepare(...args);};
  chain.preflightLaunch=async()=>{counts.preflight++;};
  chain.verifyLaunch=async l=>{counts.verify++;return {curve:chain.addresses(l).pool.toBase58()};};
  const manager=new Launchpad(accounts,null,{chainFactory:()=>chain,now:()=>clock});manager.kick=()=>{};
  t.after(()=>manager.close());
  return {manager,chain,counts,broadcasts,sleeps,id,books,external,get saved(){return saved();},get now(){return clock;},advance(ms){clock+=ms;},retryDue(){clock=saved().retry.at;},set height(value){height=value;},set simulationError(value){simulationError=value;},set simulationFailure(value){simulationFailure=value;},set receiptError(value){receiptError=value;},set finalized(value){finalized=value;},
    async approve(){const op=saved().operations.find(o=>o.state==='awaiting_signature');assert(op);const tx=VersionedTransaction.deserialize(Buffer.from(op.unsignedRaw,'base64'));tx.sign([external]);return manager.sign('a',id,op.operationId,Buffer.from(tx.serialize()).toString('base64'));},
  };
}

test('a transient real-SDK create simulation resumes automatically without repeating confirmed setup',async t=>{
  const h=await harness(t),mint=h.saved.keys.mint.address;
  h.simulationError=contextLag();await h.manager.process('a');
  assert.equal(h.saved.state,'launching');assert.equal(h.saved.retry.at,h.now+1000);assert.equal(h.saved.retry.attempt,1);
  assert.equal(h.saved.operations.length,1);assert.equal(h.broadcasts.length,0);
  assert.deepEqual((await h.manager.read('a')).launches[0].retry,h.saved.retry);
  const attempts=h.counts.prepare;await h.manager.process('a');h.advance(999);await h.manager.process('a');assert.equal(h.counts.prepare,attempts,'polling before the deadline must not hit RPC');
  h.simulationError=null;h.retryDue();await h.manager.process('a');
  assert.equal(h.saved.state,'awaiting_signature');assert.equal(h.saved.retry,undefined);assert.equal(h.saved.pendingSignature,undefined);
  assert.equal(h.saved.keys.mint.address,mint);assert.deepEqual(h.saved.operations.map(o=>o.kind),['setup','create']);
  assert.equal(h.broadcasts.length,0,'preparation does not submit without the wallet');
  const request=(await h.manager.read('a')).launches[0].pendingSignature;
  assert.equal(request.kind,'create');assert.equal(request.wallet,h.external.publicKey.toBase58());
  await h.approve();assert.equal(h.broadcasts.length,1);
  await h.manager.process('a');assert.equal(h.saved.phase,'verify');assert.equal(h.saved.operations[1].state,'confirmed');
  await h.manager.process('a');assert.equal(h.saved.state,'live');assert.equal(h.saved.retry,undefined);assert.equal(h.counts.verify,1);
  assert.equal(h.saved.operations.filter(o=>o.kind==='setup').length,1);assert.equal(h.counts.prepare,2);
});

test('retryable RPC failures use a capped cooldown and stop after eight failed attempts',async t=>{
  const h=await harness(t);h.simulationError=Object.assign(Error('RPC temporarily unavailable'),{status:503});
  for(let attempt=1;attempt<=8;attempt++){
    const before=h.now;await h.manager.process('a');assert.equal(h.counts.prepare,attempt);
    if(attempt<8){assert.equal(h.saved.state,'launching');assert.equal(h.saved.retry.attempt,attempt);assert.equal(h.saved.retry.at-before,Math.min(8000,1000*2**(attempt-1)));await h.manager.process('a');assert.equal(h.counts.prepare,attempt);h.retryDue();}
  }
  assert.equal(h.saved.state,'error');assert.equal(h.saved.operations.length,1);assert.equal(h.broadcasts.length,0);
  h.advance(60000);await h.manager.process('a');assert.equal(h.counts.prepare,8,'exhaustion requires an explicit resume');
});

test('provider error classification preserves HTTP status and nested network codes through adapters',async t=>{
  const h=await harness(t);
  const errors=[
    Object.assign(Error('request rejected'),{statusCode:429}),
    Object.assign(Error('gateway unavailable'),{status:502}),
    Object.assign(Error('upstream unavailable'),{code:'SERVER_ERROR',status:503}),
    Object.assign(Error('gateway timeout'),{status:504}),
    Object.assign(Error('request interrupted'),{code:'ETIMEDOUT'}),
    Object.assign(Error('transport unavailable'),{code:'RPC_ERROR',cause:{code:'ECONNRESET'}}),
    Error('fetch failed'),
  ];
  for(const error of errors){
    await h.manager.action('a',h.id,'resume');h.simulationError=error;await h.manager.process('a');
    assert.equal(h.saved.state,'launching',error.message);assert.equal(h.saved.retry?.attempt,1,error.message);
    assert.equal(h.saved.operations.length,1);assert.equal(h.broadcasts.length,0);
  }
});

test('onchain simulation program failures stop immediately and are never treated as provider retries',async t=>{
  const h=await harness(t);h.simulationFailure={InstructionError:[2,{Custom:6001}]};
  await h.manager.process('a');assert.equal(h.saved.state,'error');assert.equal(h.saved.retry,undefined);assert.match(h.saved.error,/simulation failed/i);
  h.advance(60000);await h.manager.process('a');assert.equal(h.counts.prepare,1);assert.equal(h.saved.operations.length,1);assert.equal(h.broadcasts.length,0);
});

test('a pending signed transaction only reconciles through provider outages and never requests replacement signatures',async t=>{
  const h=await harness(t);await h.manager.process('a');await h.approve();
  const op=h.saved.operations[1],signature=op.signature,raw=op.raw;
  h.receiptError=Object.assign(Error('connection reset'),{code:'ECONNRESET'});await h.manager.process('a');
  assert.equal(h.saved.state,'launching');assert.equal(h.saved.retry.at,h.now+1000);assert.equal(h.saved.operations[1].state,'pending');
  const reads=h.counts.receipt;await h.manager.process('a');assert.equal(h.counts.receipt,reads);
  h.height=1000;h.advance(240000);await h.manager.action('a',h.id,'resume');await h.manager.process('a');
  assert.equal(h.counts.prepare,1);assert.equal(h.saved.operations.length,2);assert.equal(h.saved.operations[1].raw,raw);assert.equal(h.saved.operations[1].signature,signature);assert.equal(h.broadcasts.length,1);
  h.receiptError=null;h.finalized=false;h.retryDue();await h.manager.process('a');
  assert.equal(h.saved.operations[1].state,'pending');assert.match(h.saved.error,/unresolved/i);assert.equal(h.counts.prepare,1);
  h.finalized=true;await h.manager.process('a');assert.equal(h.saved.operations[1].state,'confirmed');assert.equal(h.saved.retry,undefined);
  await h.manager.process('a');assert.equal(h.saved.state,'live');assert.equal(h.broadcasts.length,1);
});

test('an unsigned expired wallet request is refreshed explicitly without repeating setup or reusing its signed message',async t=>{
  const h=await harness(t);await h.manager.process('a');const first=structuredClone(h.saved.operations[1]);
  h.height=first.lastValidBlockHeight+1;await h.manager.process('a');assert.equal(h.counts.prepare,1,'background polling never opens another wallet prompt');
  const view=await h.manager.signature('a',h.id,first.operationId);assert.equal(view.state,'launching');assert.equal(view.pendingSignature,null);
  assert.equal(h.saved.operations[1].state,'expired');assert.equal(h.saved.operations[1].unsignedRaw,undefined);assert.equal(h.saved.operations[1].messageHash,undefined);
  await h.manager.process('a');const next=h.saved.operations[2];assert.equal(next.state,'awaiting_signature');assert.notEqual(next.operationId,first.operationId);assert.notEqual(next.unsignedRaw,first.unsignedRaw);assert.equal(h.saved.operations.filter(o=>o.kind==='setup').length,1);
  await assert.rejects(h.manager.sign('a',h.id,first.operationId,first.unsignedRaw),/no longer active/);
  await h.approve();await h.manager.process('a');await h.manager.process('a');assert.equal(h.saved.state,'live');assert.equal(h.broadcasts.length,1);
});

test('fee-service provider errors pause the service instead of automatically retrying spending',async t=>{
  const h=await harness(t),book=await h.manager.book('a'),l=book.launches[0];
  l.state='live';l.curve='already-live';l.feesRequested=true;l.autoFees=true;await h.manager.save('a',book);
  let reads=0;h.chain.claimInstructions=async()=>{reads++;throw Object.assign(Error('RPC temporarily unavailable'),{status:503});};
  await h.manager.process('a');assert.equal(h.saved.state,'paused');assert.equal(h.saved.retry,undefined);assert.equal(h.saved.autoFees,false);assert.equal(h.saved.feesRequested,false);
  h.advance(60000);await h.manager.process('a');assert.equal(reads,1);assert.equal(h.counts.prepare,0);assert.equal(h.broadcasts.length,0);
});
