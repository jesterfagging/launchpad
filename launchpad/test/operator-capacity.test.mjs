import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import { operatorCapacity, operatorRpcOptions, operatorJupiterInterval, rpcEndpointHash } from '../src/operator-capacity.mjs';
import { RequestPacing } from '../src/request-pacing.mjs';
import { SharedRpcGate } from '../src/shared-rpc-gate.mjs';
import { TelegramEngine } from '../src/telegram-engine.mjs';
import { workerRpcGate } from '../src/worker-rpc.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const paid = { LAUNCHPAD_PUBLIC_RPC_URL:'https://rpc.example/?api-key=operator', LAUNCHPAD_PUBLIC_RPC_RPS:'40', LAUNCHPAD_PUBLIC_SEND_RPS:'4', LAUNCHPAD_PUBLIC_JUPITER_KEY:'operator-jupiter', LAUNCHPAD_PUBLIC_JUPITER_RPS:'10' };

test('operator paid capacity applies only to the exact configured credential and endpoint', () => {
  assert.equal(operatorCapacity({}, paid).rpcRequestsPerSecond, 40);
  assert.equal(operatorCapacity({rpcUrl:'https://rpc.example/?api-key=customer',jupiterKey:'customer'}, paid).rpcRequestsPerSecond,8);
  assert.equal(operatorCapacity({jupiterKey:'customer'}, paid).jupiterRequestsPerSecond,1);
  assert.equal(operatorCapacity({jupiterKey:''}, paid).jupiterRequestsPerSecond,.5);
  assert.equal(operatorCapacity({jupiterKey:'operator-jupiter'}, paid).jupiterRequestsPerSecond,10);
  assert.equal(operatorJupiterInterval(hash('operator-jupiter'),paid),105);
  assert.equal(operatorJupiterInterval(hash('customer'),paid),1050);
  assert.equal(operatorJupiterInterval(hash('public'),paid),2100);
  assert.equal(operatorRpcOptions(rpcEndpointHash(paid.LAUNCHPAD_PUBLIC_RPC_URL),paid).aggregateRate,40);
  assert.equal(operatorRpcOptions(rpcEndpointHash('https://other.example'),paid).aggregateRate,undefined);
  assert.equal(rpcEndpointHash('https://RPC.EXAMPLE:443'),rpcEndpointHash('https://rpc.example/'));
});

test('capacity settings reject invalid declarations and cannot accelerate keyless Jupiter', () => {
  for (const value of ['-1','0','1.5','1001','NaN','Infinity',' 40','2e2']) assert.throws(()=>operatorCapacity({}, {...paid,LAUNCHPAD_PUBLIC_RPC_RPS:value}),/PUBLIC_RPC_RPS/);
  assert.throws(()=>operatorCapacity({}, {LAUNCHPAD_PUBLIC_JUPITER_RPS:'10'}),/requires LAUNCHPAD_PUBLIC_JUPITER_KEY/);
  assert.throws(()=>operatorCapacity({}, {...paid,LAUNCHPAD_PUBLIC_RPC_QUEUE:'10001'}),/PUBLIC_RPC_QUEUE/);
  assert.throws(()=>operatorCapacity({}, {...paid,LAUNCHPAD_PUBLIC_REQUEST_DEADLINE_MS:'999'}),/PUBLIC_REQUEST_DEADLINE_MS/);
  assert.equal(operatorCapacity({}, {}).rpcRequestsPerSecond,8);
  assert.equal(operatorCapacity({}, {}).jupiterRequestsPerSecond,.5);
});

test('a lower chart cap cannot lower the aggregate operator budget or block admitted trade reads',async t=>{
  let now=0;const gate=new SharedRpcGate({now:()=>now});t.after(()=>gate.close());
  const chart=[],trade=[];
  for(let i=0;i<4;i++)chart.push(gate.acquire('endpoint','charts',3,{aggregateRate:8}).then(()=>true));
  for(let i=0;i<5;i++)trade.push(gate.acquire('endpoint','trades',8,{aggregateRate:8}).then(()=>true));
  assert.equal(gate.buckets.get('endpoint').starts.length,8);
  assert.equal(gate.buckets.get('endpoint').queue.length,1);
  assert.equal((await Promise.all(trade)).length,5);
  now=1001;gate.drain(gate.buckets.get('endpoint'));assert.equal((await Promise.all(chart)).length,4);
});

test('send permits share one endpoint subset across launches and trades while reads can continue',async t=>{
  let now=0;const gate=new SharedRpcGate({now:()=>now});t.after(()=>gate.close());
  await gate.acquire('endpoint','launch',8,{aggregateRate:8,method:'sendTransaction',sendRate:1});
  const queued=gate.acquire('endpoint','trade',8,{aggregateRate:8,method:'sendTransaction',sendRate:1});
  await gate.acquire('endpoint','chart',3,{aggregateRate:8,method:'getAccountInfo',sendRate:1});
  assert.equal(gate.buckets.get('endpoint').sends.length,1);assert.equal(gate.buckets.get('endpoint').starts.length,2);
  now=1001;gate.drain(gate.buckets.get('endpoint'));await queued;
  assert.equal(gate.buckets.get('endpoint').sends.length,1);
});

test('1000 RPC arrivals keep a bounded queue and expire against arrival deadlines without late sends',async()=>{
  let now=0;const gate=new SharedRpcGate({now:()=>now,maxQueue:25,requestDeadlineMs:1500});
  const jobs=Array.from({length:1000},(_,i)=>gate.acquire('endpoint',`client-${i}`,8,{aggregateRate:8}).then(()=>({ok:true}),error=>({ok:false,error})));
  assert.equal(gate.buckets.get('endpoint').starts.length,8);assert.equal(gate.buckets.get('endpoint').queue.length,25);
  now=1600;gate.drain(gate.buckets.get('endpoint'));
  const result=await Promise.all(jobs);assert.equal(result.filter(r=>r.ok).length,8);
  assert.equal(result.filter(r=>!r.ok&&r.error.capacityLimited).length,992);
  assert.equal(gate.buckets.get('endpoint').queue.length,0);gate.close();
});

test('provider admission rejects impossible 1000-job backlog immediately and preserves only eight viable slots',async()=>{
  let now=0;const gate=new RequestPacing({now:()=>now,requestDeadlineMs:15000,maxQueue:100});
  const jobs=Array.from({length:1000},()=>gate.acquire('jupiter','trade',2100).then(()=>true,()=>false));
  assert.equal(gate.buckets.get('jupiter').queue.length,7);
  for(let i=1;i<=7;i++){now=i*2100;gate.drain(gate.buckets.get('jupiter'));}
  assert.equal((await Promise.all(jobs)).filter(Boolean).length,8);gate.close();
});

test('worker method and canonical URL reach the same endpoint quota across different accounts',async t=>{
  const gate=new SharedRpcGate(),channels=[];t.after(()=>{gate.close();for(const p of channels){p.port1.close();p.port2.close();}});
  const brokers=Array.from({length:2},(_,i)=>{const port=new MessageChannel();channels.push(port);const host={rpcGate:gate,rpcScope:`account-${i}`,rpcClient:`worker-${i}`,rpcPending:new Map(),worker:port.port1};port.port1.on('message',m=>TelegramEngine.prototype.rpcMessage.call(host,m));return workerRpcGate(port.port2);});
  const c={rpcUrl:'https://rpc.example',rpcRequestsPerSecond:8};
  await brokers[0].acquire(c,null,Date.now()+1000,'sendTransaction');
  await assert.rejects(brokers[1].acquire({...c,rpcUrl:'https://rpc.example/'},null,Date.now()+40,'sendTransaction'),e=>e.capacityLimited);
  await brokers[1].acquire(c,null,Date.now()+1000,'getAccountInfo');
  assert.equal(gate.buckets.size,1);assert.equal([...gate.buckets.values()][0].sends.length,1);
});
