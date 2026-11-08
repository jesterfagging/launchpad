import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LaunchChain } from '../src/launchpad-chain.mjs';
const fixture = (t, gate) => {
  const calls=[];
  t.mock.method(https,'request',(_url,_options,callback)=>{
    const request=new EventEmitter();request.setTimeout=()=>request;
    request.end=body=>queueMicrotask(()=>{const call=JSON.parse(body);calls.push(call);const response=new PassThrough();response.statusCode=200;response.headers={'content-type':'application/json'};callback(response);response.end(JSON.stringify({jsonrpc:'2.0',id:call.id,result:'fixture-signature'}));});
    return request;
  });
  const chain=new LaunchChain({network:'mainnet-beta',rpcUrl:'https://rpc.example.test/',rpcGate:{...gate,removeClient(){},cooldown(){}}});t.after(()=>chain.close());return{chain,calls};
};

test('real web3 send reaches method-specific quota and final authorization runs after its permit',async t=>{
  let release,queued;const ready=new Promise(r=>queued=r),order=[];
  const {chain,calls}=fixture(t,{acquire:async(_key,_client,_rate,options)=>{assert.equal(options.method,'sendTransaction');order.push('permit requested');queued();await new Promise(r=>release=r);order.push('permit granted');}});
  const submission=chain.withRpcContext({deadline:Date.now()+5000,authorizeBeforeSend:async()=>{order.push('authorization');throw Error('session revoked');}},()=>chain.c.sendRawTransaction(Buffer.from([1,2,3]),{skipPreflight:true,maxRetries:0}));
  await ready;assert.equal(calls.length,0);release();await assert.rejects(submission,/session revoked/);
  assert.deepEqual(order,['permit requested','permit granted','authorization']);assert.equal(calls.length,0,'authorization failure must not reach HTTP');
});

test('nested RPC contexts cannot extend an arrival deadline and expired work never reaches HTTP',async t=>{
  const {chain,calls}=fixture(t,{acquire:async()=>{throw Error('already expired work must not acquire');}});
  await assert.rejects(chain.withRpcContext({deadline:Date.now()-1},()=>chain.withRpcContext({deadline:Date.now()+60000},()=>chain.c.sendRawTransaction(Buffer.from([1,2,3])))),/deadline expired/);
  assert.equal(calls.length,0);
});

test('cashback reconciliation waits for the shared endpoint gate and releases its client',async()=>{
  const {CashbackVerifier}=await import('../src/cashback-verifier.mjs');const events=[];
  const verifier=new CashbackVerifier({}, {rpcUrl:'https://rpc.example.test',rpcGate:{acquire:async(key,_client,_rate,options)=>{assert.match(key,/^rpc:/);assert.equal(options.method,'getTransaction');events.push('gate');},removeClient:()=>events.push('release')},rpc:async()=>{events.push('read');return null;}});
  assert.equal(await verifier.rpc('https://rpc.example.test','getTransaction',[],new AbortController().signal),null);
  verifier.close();assert.deepEqual(events,['gate','read','release']);
});

test('wallet balance workers request a host permit before their first network call',async t=>{
  const {WalletBalances}=await import('../src/wallet-balances.mjs');const {Keypair}=await import('@solana/web3.js');const methods=[],released=[];
  const balances=new WalletBalances({rpcGate:{requests:{},acquire:async(_key,_client,_rate,options)=>{methods.push(options.method);throw Error('fixture rejects before network');},removeClient:id=>released.push(id)}});t.after(()=>balances.close());
  await assert.rejects(balances.read('account',{rpcUrl:'https://rpc.example.test/',rpcRequestsPerSecond:8,wallets:[{publicKey:Keypair.generate().publicKey.toBase58()}]}),/SOL balances unavailable/);
  assert.deepEqual(methods,['getGenesisHash']);assert.equal(released.length,1);assert.equal(balances.brokers.size,0);
});
