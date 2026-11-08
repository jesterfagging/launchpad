import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { RequestPacing, requestInterval } from '../src/request-pacing.mjs';
import { SharedRpcGate } from '../src/shared-rpc-gate.mjs';
import { workerRpcGate } from '../src/worker-rpc.mjs';
import { TelegramEngine } from '../src/telegram-engine.mjs';
import { Providers, ProviderError, jsonFetch } from '../src/providers.mjs';
import { config, build, mint } from './fixtures.mjs';
import { validateConfig, SOL } from '../src/core.mjs';

test('20 wallets share evenly spaced permits; abort cancels queued work and restart preserves cooldown', async t => {
  const gate = new RequestPacing(); t.after(()=>gate.close()); const times=[];
  await Promise.all(Array.from({length:20},()=>gate.acquire('key','worker',3).then(()=>times.push(Date.now()))));
  assert(times.at(-1)-times[0]>=50); assert.equal(requestInterval({jupiterKey:'key'},'jupiter'),1050); assert.equal(requestInterval({},'jupiter'),2100);
  gate.cooldown('key',5000); const ctrl=new AbortController(); const waiting=gate.acquire('key','worker',3,{signal:ctrl.signal}); ctrl.abort(); await assert.rejects(waiting,{name:'AbortError'});
  gate.removeClient('worker'); await assert.rejects(gate.acquire('key','new-worker',3,{deadline:Date.now()+50}),/capacity/);
});
test('workers in different accounts sharing a Jupiter key share quota; service reply IDs cannot collide', async t => {
  const rpcGate=new SharedRpcGate(), ports=[]; t.after(()=>{rpcGate.close();ports.forEach(p=>{p.port1.close();p.port2.close();});});
  const brokers=[];for(let i=0;i<2;i++){const ch=new MessageChannel();ports.push(ch);const host={rpcGate,rpcScope:`account-${i}`,rpcClient:`worker-${i}`,rpcPending:new Map(),worker:ch.port1};ch.port1.on('message',m=>TelegramEngine.prototype.rpcMessage.call(host,m));brokers.push({rpc:workerRpcGate(ch.port2),jup:workerRpcGate(ch.port2,'jupiter')});}
  const c={jupiterKey:'same-key',rpcUrl:'https://rpc.example',rpcRequestsPerSecond:2};
  await Promise.all([brokers[0].jup.acquire(c,null,Infinity),brokers[0].rpc.acquire(c,null,Infinity)]);
  await assert.rejects(brokers[1].jup.acquire(c,null,Date.now()+30),/capacity/);
  const notification=once(ports[0].port1,'message');brokers[0].jup.cooldown(c,60000);await notification;
  await assert.rejects(brokers[1].jup.acquire(c,null,Date.now()+1500),/capacity/);
});
test('429 recovers before signing, keeps exact requested trade and caps retries; authentication is never retried', async () => {
  const c=validateConfig(config()),p=new Providers(c,()=>{}),wallet=c.wallets[0], waits=[];
  p.jupiterGate={acquire:async()=>{},cooldown:(c,ms)=>waits.push(ms)};
  const order={inputMint:SOL,outputMint:mint,amount:123n,receivedAt:Date.now(),signalSource:'manual'}; let calls=0;
  p.fetch=async()=>{if(++calls===1)throw new ProviderError('429',{rateLimited:true,retryAfterMs:60000});return build(order,wallet);};
  const result=await p.build(order,wallet);assert.equal(result.inAmount,'123');assert.equal(calls,2);assert.deepEqual(waits,[60000]);
  calls=0;p.fetch=async()=>{calls++;throw new ProviderError('auth',{httpStatus:401});};await assert.rejects(p.build(order,wallet),/auth/);assert.equal(calls,1);
  calls=0;p.fetch=async()=>{calls++;throw new ProviderError('429',{rateLimited:true});};await assert.rejects(p.build(order,wallet),/capacity/);assert.equal(calls,4);
});
test('Jupiter Unix reset header and Retry-After both constrain recovery without exposing keys', async () => {
  const original=globalThis.fetch;try{globalThis.fetch=async()=>new Response(JSON.stringify({message:'limit'}),{status:429,headers:{'x-ratelimit-reset':String(Math.ceil(Date.now()/1000)+60),'retry-after':'2'}});
    await assert.rejects(jsonFetch('https://api.jup.ag/swap/v2/build'),e=>e.rateLimited&&e.retryAfterMs>=60000&&e.retryAfterMs<=61000);
  }finally{globalThis.fetch=original;}
});

test('a queued provider deadline keeps the same retryable classification as immediate capacity rejection',async t=>{
 let now=100000;const gate=new RequestPacing({now:()=>now});t.after(()=>gate.close());await gate.acquire('provider','first',1000);
 const queued=gate.acquire('provider','queued',1000,{deadline:now+1500});gate.cooldown('provider',3000);
 const check=error=>error.retryable===true&&error.capacityLimited===true&&error.retryAfterMs===3000&&/Nothing new was submitted/.test(error.message);
 await assert.rejects(queued,check);await assert.rejects(gate.acquire('provider','immediate',1000,{deadline:now+1500}),check);assert.equal(gate.bucket('provider').queue.length,0);
 now+=3000;await gate.acquire('provider','ready',1000);const expires=gate.acquire('provider','expired',1000,{deadline:now+1500});now+=1501;gate.drain(gate.bucket('provider'));
 await assert.rejects(expires,error=>error.retryable===true&&error.capacityLimited===true&&error.retryAfterMs===1000);assert.equal(gate.bucket('provider').queue.length,0);
});
