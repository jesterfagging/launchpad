import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Launchpad } from '../src/launchpad.mjs';
import { SharedRpcGate } from '../src/shared-rpc-gate.mjs';
import { defaults } from '../src/telegram-settings.mjs';
import { Connection, Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { LaunchChain } from '../src/launchpad-chain.mjs';

function harness(t, rate) {
  const gate = new SharedRpcGate();
  const runtime = { rpcGate: gate, readSettings: async () => ({ settings: { ...defaults, rpcRequestsPerSecond: rate } }) };
  const launchpad = new Launchpad({}, runtime, { metadataStorage: {}, quoteCatalogue: {} });
  t.after(async () => { await launchpad.close(); gate.close(); });
  return { gate, launchpad };
}

test('saved string RPC limits and legacy defaults pass real launch initialization through the shared scheduler', async t => {
  const methods = [];
  // Intercept HTTPS only. Exercise the account factory, web3 Connection, and
  // shared limiter exactly as production does, with no live RPC or signing.
  t.mock.method(https, 'request', (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.end = body => queueMicrotask(() => {
      const input = JSON.parse(body);
      methods.push(input.method);
      assert.equal(input.method, 'getGenesisHash');
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      callback(response);
      response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' }));
    });
    return request;
  });
  assert.equal(typeof defaults.rpcRequestsPerSecond, 'string');
  const cases = [[defaults.rpcRequestsPerSecond, 8], [undefined, 8], [null, 8], ['', 8], ['  ', 8], ['25', 25], ['8.0', 8], [1, 1], ['1000', 1000]];
  for (const [input, expected] of cases) {
    const { gate, launchpad } = harness(t, input);
    const chain = await launchpad.chain('account', 'mainnet-beta');
    try {
      assert.deepEqual([...gate.buckets.values()].flatMap(bucket => [...bucket.clients.values()]), [expected]);
    } finally { chain.close(); }
    assert([...gate.buckets.values()].every(bucket => bucket.clients.size === 0), 'closing a launch releases its RPC client');
  }
  assert.equal(methods.length, cases.length);
});

test('an explicitly invalid launch RPC limit is rejected before networking instead of silently resetting it', async t => {
  let requests = 0;
  t.mock.method(https, 'request', () => { requests++; throw Error('Network must not be reached'); });
  for (const input of [0, '0', -1, '1.5', 1001, '1001', 'invalid', true, false, [], {}, NaN, Infinity]) {
    const { gate, launchpad } = harness(t, input);
    await assert.rejects(launchpad.chain('account', 'mainnet-beta'), /whole number from 1 to 1000/);
    assert.equal(gate.buckets.size, 0);
  }
  assert.equal(requests, 0);
});

test('real web3 RPC context-lag errors retry the same serialized simulation with its minimum slot intact',async()=>{
  const requests=[],waits=[];let simulations=0;
  const connection=new Connection('https://rpc.example.test',{commitment:'finalized',fetch:async(_url,options)=>{
    const call=JSON.parse(options.body);requests.push(call);
    if(call.method==='getBlockHeight')return new Response(JSON.stringify({jsonrpc:'2.0',id:call.id,result:90}));
    assert.equal(call.method,'simulateTransaction','No sendTransaction or wallet funding may occur while retrying');simulations++;
    if(simulations<3)return new Response(JSON.stringify({jsonrpc:'2.0',id:call.id,error:{code:-32016,message:'Minimum context slot has not been reached',data:{contextSlot:54}}}));
    return new Response(JSON.stringify({jsonrpc:'2.0',id:call.id,result:{context:{slot:55},value:{err:null,logs:[],accounts:null,unitsConsumed:1000}}}));
  }});
  const chain=new LaunchChain({network:'mainnet-beta',connection,sleep:async ms=>waits.push(ms)}),payer=Keypair.generate();
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1})]}).compileToV0Message());
  const result=await chain.simulatePrepared(tx,{commitment:'finalized',sigVerify:false,minContextSlot:55},100);
  assert.equal(result.context.slot,55);assert.deepEqual(waits,[250,750]);
  const calls=requests.filter(call=>call.method==='simulateTransaction');assert.equal(calls.length,3);
  assert(calls.every(call=>call.params[0]===calls[0].params[0]));
  for(const call of calls)assert.deepEqual(call.params[1],{encoding:'base64',commitment:'finalized',sigVerify:false,minContextSlot:55});
});


test('a missing signature-cache entry still loads an available finalized receipt',async()=>{
  const signature='saved-signature',receipt={slot:55,transaction:{signatures:[signature]},meta:{err:null}};
  let fetched=0;
  const chain=new LaunchChain({network:'mainnet-beta',connection:{getSignatureStatuses:async()=>({value:[null]}),getTransaction:async(sig,config)=>{fetched++;assert.equal(sig,signature);assert.equal(config.commitment,'finalized');return receipt;}}});
  assert.equal(await chain.receipt({signature}),receipt);assert.equal(fetched,1);
  chain.c.getTransaction=async()=>({...receipt,transaction:{signatures:['different-signature']}});
  await assert.rejects(chain.receipt({signature}),/signature mismatch/);
});

test('pending transaction expiry requires retained history, a fresh absent signature and a finalized invalid blockhash',async()=>{
  const payer=Keypair.generate(),hash=Keypair.generate().publicKey.toBase58();
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:hash,instructions:[SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1})]}).compileToV0Message());tx.sign([payer]);
  const {default:bs58}=await import('bs58');
  const op={signature:bs58.encode(tx.signatures[0]),raw:Buffer.from(tx.serialize()).toString('base64'),blockhash:hash,lastValidBlockHeight:200,preparedSlot:300};
  let height=220,slot=340,history=1,status=null,context=340,receipt=null,valid=false;
  const chain=new LaunchChain({network:'mainnet-beta',connection:{
    getEpochInfo:async commitment=>{assert.equal(commitment,'finalized');return{blockHeight:height,absoluteSlot:slot};},
    getFirstAvailableBlock:async()=>history,
    getSignatureStatuses:async(signatures,config)=>{assert.deepEqual(signatures,[op.signature]);assert.equal(config.searchTransactionHistory,true);return{context:{slot:context},value:[status]};},
    getTransaction:async()=>receipt,
    isBlockhashValid:async(value,config)=>{assert.equal(value,hash);assert.deepEqual(config,{commitment:'finalized',minContextSlot:slot});return{context:{slot:context},value:valid};}
  }});
  assert.deepEqual(await chain.pendingTransactionState(op),{state:'expired',signature:op.signature,checkpoint:{height:220,slot:340},historyFromSlot:1});
  height=200;assert.equal((await chain.pendingTransactionState(op)).state,'pending');height=220;
  history=301;assert.equal((await chain.pendingTransactionState(op)).state,'unknown');history=1;
  context=339;assert.equal((await chain.pendingTransactionState(op)).state,'unknown');context=340;
  for(const seen of [{confirmationStatus:'processed'},{confirmationStatus:'confirmed'},{confirmationStatus:'finalized',err:null}]){status=seen;assert.equal((await chain.pendingTransactionState(op)).state,'pending');delete op.observedSignatureStatus;}status=null;
  op.observedSignatureStatus={confirmationStatus:'confirmed',slot:301};assert.equal((await chain.pendingTransactionState(op)).state,'pending','previous positive signature evidence cannot be erased by later missing RPC history');delete op.observedSignatureStatus;
  receipt={transaction:{signatures:[op.signature]}};assert.equal((await chain.pendingTransactionState(op)).state,'pending');receipt=null;delete op.observedSignatureStatus;
  valid=true;assert.equal((await chain.pendingTransactionState(op)).state,'unknown');valid=false;
  assert.equal((await chain.pendingTransactionState({...op,signature:'different'})).state,'unknown');
  const legacy={...op};delete legacy.preparedSlot;history=50;
  assert.equal((await chain.pendingTransactionState(legacy)).state,'unknown','old journals require deeper history than the safe height lower bound');
  history=0;assert.equal((await chain.pendingTransactionState(legacy)).state,'expired');
  chain.c.getSignatureStatuses=async()=>{throw Error('RPC unavailable');};await assert.rejects(chain.pendingTransactionState(op),/RPC unavailable/);
});
