import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { mkdtemp,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { VersionedTransaction, Keypair, TransactionInstruction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { Ledger } from '../src/ledger.mjs';
import { Engine } from '../src/engine.mjs';
import { ProviderError, Providers } from '../src/providers.mjs';
import { SOL,JUPITER,PUMP_AMM,validateConfig } from '../src/core.mjs';
import { pumpLogSignal } from '../src/pump-logs.mjs';
import { lead,lead2,mint,key1,key2,config,build,swap,token,event } from './fixtures.mjs';
import packageInfo from '../package.json' with { type: 'json' };

async function harness(options={}) {
  const dir=await mkdtemp(join(tmpdir(),'launchpad-test-'));
  const ledgers={live:await new Ledger(join(dir,'live.json')).load(),paper:await new Ledger(join(dir,'paper.json')).load()};
  let submits=0;const orders=new Map(),receipts=new Map();
  const p={market:new Map([[mint,{price:1,marketCap:100000,symbol:'TEST',receivedAt:Date.now()}]]),knownPrograms:new Set([JUPITER]),jitoTips:[],
    init:async()=>{},subscribe:async()=>{},close:()=>{},balance:async()=>100000000000n,
    markets:async()=>p.market,build:async(order,wallet)=>{orders.set(wallet.publicKey,order);return build(order,wallet);},
    submit:async bytes=>{
      submits++;const tx=VersionedTransaction.deserialize(bytes),sig=bs58.encode(tx.signatures[0]),owner=tx.message.staticAccountKeys[0].toBase58();
      const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),tx.message.staticAccountKeys[0].toBuffer()]),format:'der',type:'spki'});
      const messageBytes=tx.version===1?bytes.slice(0,bytes.length-tx.signatures.length*64):tx.message.serialize();
      assert(verify(null,messageBytes,publicKey,tx.signatures[0]),'mock relay must verify every actual transaction signature');
      const journal=JSON.parse(await readFile(join(dir,'live.json'),'utf8'));assert(journal.pending.some(x=>x.signature===sig),'journal must precede broadcast');
      assert.equal(journal.pending.find(x=>x.signature===sig).signatureVerified,true);
      const order=orders.get(owner);let pre=[],post=[];
      if(order.kind==='buy'){pre=[token(owner,order.outputMint,0)];post=[token(owner,order.outputMint,1000)];}
      else{pre=[token(owner,order.inputMint,10000)];post=[token(owner,order.inputMint,10000n-order.amount)];}
      receipts.set(sig,{transaction:{message:{accountKeys:[{pubkey:owner,signer:true}]}},meta:{err:options.failed?{InstructionError:[1,'test']}:null,preTokenBalances:pre,postTokenBalances:post}});
      if(options.timeout)throw Error('transport timeout');return {route:'mock',signature:sig};
    },
    status:async sig=>options.unresolved?null:receipts.has(sig)?{confirmationStatus:'confirmed',err:options.failed?{InstructionError:[1,'test']}:null}:null,
    transaction:async sig=>receipts.get(sig)||null,height:async()=>100,
    rpc:async()=>({value:{err:null}}),
  };
  p.statuses=async signatures=>Promise.all(signatures.map(sig=>p.status(sig)));
  const engine=new Engine(ledgers,()=>p);engine.receiptWaitMs=options.unresolved?1:2000;engine.receiptIntervalMs=10;
  return {engine,p,ledgers,dir,get submits(){return submits;}};
}
async function drain(e){await Promise.all([...e.queues.values()]);}
async function stop(e){e.stop();await e.stopPromise;}


test('a confirmed push bypasses the polling interval, verifies the fill and never applies it twice',async()=>{
  const h=await harness({unresolved:true}),callbacks=new Map();
  h.p.watchSignature=(sig,fn)=>callbacks.set(sig,fn);h.p.unwatchSignature=sig=>callbacks.delete(sig);
  await h.engine.start(config({mode:'live'}));clearInterval(h.engine.receiptTimer);
  await h.engine.onTransaction(event());await drain(h.engine);
  const pending=h.ledgers.live.data.pending[0],push=callbacks.get(pending.signature);
  h.engine.receiptNextAt=Date.now()+60000;
  h.p.statuses=async()=>assert.fail('push must not wait for another status poll');
  push({confirmationStatus:'confirmed',err:null,slot:124});
  await h.engine.receiptPromise;
  assert.equal(h.engine.status().positions.length,1);assert.equal(h.engine.status().pending.length,0);
  assert.equal(callbacks.size,0);assert.equal(h.engine.metrics.confirmed,1);
  push({confirmationStatus:'confirmed',err:null,slot:124});await delay(10);
  assert.equal(h.engine.metrics.confirmed,1);assert.equal(h.submits,1);
  assert.equal(h.engine.status().events.find(e=>e.level==='confirmed').confirmationSource,'websocket');
  await stop(h.engine);
});

test('a receipt push arriving during a status read is not lost and respects rate-limit cooldowns',async()=>{
  const h=await harness({unresolved:true});let push;
  h.p.watchSignature=(_,fn)=>push=fn;
  await h.engine.start(config({mode:'live'}));clearInterval(h.engine.receiptTimer);
  await h.engine.onTransaction(event());await drain(h.engine);
  const old=h.p.transaction;let reads=0;h.p.transaction=async sig=>{reads++;return old(sig);};
  h.engine.receiptFailures=1;h.engine.receiptNextAt=Date.now()+60000;
  push({confirmationStatus:'confirmed',err:null,slot:124});await delay(10);
  assert.equal(reads,0);assert.equal(h.engine.status().pending.length,1);
  h.engine.receiptNextAt=0;await h.engine.reconcileAll();
  assert.equal(reads,1);assert.equal(h.engine.status().positions.length,1);await stop(h.engine);
});

test('a push during an in-flight unconfirmed status response triggers receipt processing once',async()=>{
  const h=await harness({unresolved:true});let push;
  h.p.watchSignature=(_,fn)=>push=fn;
  await h.engine.start(config({mode:'live'}));clearInterval(h.engine.receiptTimer);
  await h.engine.onTransaction(event());await drain(h.engine);
  let release;h.p.statuses=()=>new Promise(r=>release=r);h.engine.receiptNextAt=0;
  const checking=h.engine.reconcileAll();while(!release)await delay(1);
  push({confirmationStatus:'confirmed',err:null,slot:124});release([null]);await checking;
  assert.equal(h.engine.metrics.confirmed,1);assert.equal(h.engine.status().positions.length,1);assert.equal(h.submits,1);
  await stop(h.engine);
});

test('failed startup stops cleanly, permits repeated Stop, and retries with imported keys without a broadcast', async () => {
  const h = await harness(); let tries = 0;
  h.p.init = async () => { if (++tries === 1) throw new ProviderError('RPC getGenesisHash: DNS lookup failed. (ENOTFOUND)'); };
  await assert.rejects(h.engine.start(config({mode:'live'})), /Start failed. Run stopped/);
  assert.equal(h.engine.state, 'stopped'); assert.equal(h.engine.accepting, false);
  assert.match(h.engine.status().startupError, /ENOTFOUND/);
  assert.equal(h.engine.c.wallets[0].keypair, null);
  assert.equal(h.engine.stop().state, 'stopped'); assert.equal(h.engine.stop().state, 'stopped');
  await h.engine.start(config({mode:'live'}));
  assert.equal(h.engine.state, 'running'); assert.equal(h.engine.status().startupError, null);
  assert(h.engine.c.wallets[0].keypair); assert.equal(h.submits, 0); await stop(h.engine);
});

test('Stop during startup cancels the run and leaves Start usable, even if provider cleanup throws', async () => {
  const h = await harness(); let entered;
  const ready = new Promise(r => entered = r);
  h.p.init = signal => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('Stopped.')), {once:true}); entered(); });
  const starting = h.engine.start(config()); await ready;
  h.engine.stop(); h.p.close = () => { throw Error('cleanup failed'); };
  await assert.rejects(starting, /Run stopped/);
  assert.equal(h.engine.state, 'stopped'); assert.equal(h.engine.accepting, false);
  assert.equal(h.engine.status().startupError, null); assert.equal(h.submits, 0);
});

test('Stop during startup reconciliation never opens a stream or re-enables accepting trades', async () => {
  const h = await harness(); let entered, release, subscriptions = 0;
  const ready = new Promise(r => entered = r), held = new Promise(r => release = r);
  h.engine.reconcileAll = async () => { entered(); await held; };
  h.p.subscribe = async () => { subscriptions++; };
  const starting = h.engine.start(config()); await ready; h.engine.stop(); release();
  await assert.rejects(starting, /Run stopped/);
  assert.equal(h.engine.state, 'stopped'); assert.equal(h.engine.accepting, false);
  assert.equal(subscriptions, 0); assert.equal(h.submits, 0);
});

test('preparation and simulation progress during a slow balance read, but insufficient funds never sign or submit',async()=>{
  const h=await harness();let release,simulate;const held=new Promise(r=>release=r),simulated=new Promise(r=>simulate=r);
  h.p.balance=async()=>{await held;return 0n;};h.p.rpc=async()=>{simulate();return {value:{err:null}};};
  await h.engine.start(config({mode:'live'}));await h.engine.onTransaction(event());await simulated;
  assert.equal(h.submits,0);assert.equal(h.ledgers.live.data.pending.length,0);release();await drain(h.engine);
  assert.equal(h.submits,0);assert(h.ledgers.live.data.events.some(e=>e.message.includes('Insufficient SOL')));await stop(h.engine);
});


test('paper runs never broadcast; duplicate lead events never double-buy',async()=>{
  const h=await harness();await h.engine.start(config());const e=event();await h.engine.onTransaction(e);await drain(h.engine);await h.engine.onTransaction(e);await drain(h.engine);
  assert.equal(h.submits,0);assert.equal(h.ledgers.paper.data.lots.length,1);assert.equal(h.ledgers.live.data.lots.length,0);await stop(h.engine);
});
test('20 followers execute independently and preserve their exact custom buy size',async()=>{
  const h=await harness();const keys=Array.from({length:20},()=>Keypair.generate());const raw=config({wallets:keys,amountMode:'custom'});raw.wallets.forEach((w,i)=>w.amount=`0.${String(i+1).padStart(2,'0')}`);
  await h.engine.start(raw);await h.engine.onTransaction(event());await drain(h.engine);assert.equal(h.ledgers.paper.data.lots.length,20);assert.equal(new Set(h.ledgers.paper.data.lots.map(l=>l.wallet)).size,20);await stop(h.engine);
});
test('partial lead sells affect only that lead’s copied lots across multiple followers',async()=>{
  const h=await harness();await h.engine.start(config({mode:'live',wallets:[key1,key2],leads:[lead,lead2]}));
  await h.engine.onTransaction(event(swap({owner:lead})));await drain(h.engine);
  await h.engine.onTransaction(event(swap({owner:lead2})));await drain(h.engine);
  await h.engine.onTransaction(event(swap({owner:lead,input:mint,output:SOL,before:1000n,sold:500n})));await drain(h.engine);
  const lots=h.ledgers.live.data.lots;assert.equal(lots.length,4);
  assert(lots.filter(l=>l.lead===lead).every(l=>l.remaining==='500'));assert(lots.filter(l=>l.lead===lead2).every(l=>l.remaining==='1000'));
  assert.equal(h.submits,6);assert.equal(h.ledgers.live.data.pending.length,0);await stop(h.engine);
});
test('relay timeouts reconcile the same signature without a replacement transaction',async()=>{
  const h=await harness({timeout:true});await h.engine.start(config({mode:'live'}));await h.engine.onTransaction(event());await drain(h.engine);
  assert.equal(h.submits,1);assert.equal(h.ledgers.live.data.lots.length,1);assert.equal(h.ledgers.live.data.pending.length,0);await stop(h.engine);
});
test('failed on-chain transactions never create positions',async()=>{
  const h=await harness({failed:true});await h.engine.start(config({mode:'live'}));await h.engine.onTransaction(event());await drain(h.engine);
  assert.equal(h.ledgers.live.data.lots.length,0);assert.equal(h.ledgers.live.data.pending.length,0);await stop(h.engine);
});
test('confirmed Pump slippage reports the actual chain amounts, persists trade limits and never retries the buy',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./pump-slippage-fixture.json',import.meta.url),'utf8'));
  const h=await harness({failed:true}),originalStatus=h.p.status;
  h.p.status=async sig=>{const status=await originalStatus(sig);return status?{...status,err:fixture.error}:null;};
  h.p.transaction=async()=>fixture;
  await h.engine.start(config({mode:'live',slippagePercent:7.5}));
  const e=event();
  // Supply Pump route context for the mocked confirmed failure.
  const original=h.p.build;h.p.build=async(order,...args)=>{order.venue={type:'pump',quoteMint:SOL};return original(order,...args);};
  await h.engine.onTransaction(e);await drain(h.engine);
  assert.equal(h.submits,1);assert.equal(h.ledgers.live.data.pending.length,0);assert.equal(h.ledgers.live.data.lots.length,0);
  const failure=h.ledgers.live.data.events.find(e=>e.failure?.name==='TooMuchSolRequired');assert(failure);
  assert.match(failure.message,/0.05041827 SOL; cap 0.05 SOL/);assert.equal(failure.failure.slippageBps,750);
  assert.equal(failure.order.executionLimits.slippageBps,750);assert.equal(h.engine.status().execution.slippagePercent,7.5);
  assert.equal(h.engine.accepting,true);await stop(h.engine);
});
test('unavailable failure diagnostics still clear a confirmed failed trade without creating a fill or replacement',async()=>{
  const h=await harness({failed:true});h.p.transaction=async()=>{throw new ProviderError('rate limited',{rateLimited:true});};
  await h.engine.start(config({mode:'live'}));await h.engine.onTransaction(event());await drain(h.engine);
  assert.equal(h.submits,1);assert.equal(h.ledgers.live.data.pending.length,0);assert.equal(h.ledgers.live.data.lots.length,0);
  assert(h.ledgers.live.data.events.some(e=>e.failure&&e.message.includes('failed on chain')));assert.equal(h.engine.accepting,true);await stop(h.engine);
});
test('unresolved outcomes pause that wallet and survive journal reload',async()=>{
  const h=await harness({unresolved:true,timeout:true});await h.engine.start(config({mode:'live'}));await h.engine.onTransaction(event());await drain(h.engine);
  await h.engine.onTransaction(event());await drain(h.engine);assert.equal(h.submits,1);assert.equal(h.ledgers.live.data.pending.length,1);
  await stop(h.engine);const restored=await new Ledger(join(h.dir,'live.json')).load();assert.equal(restored.data.pending.length,1);
  const text=await readFile(join(h.dir,'live.json'),'utf8');assert(!text.includes(bs58.encode(key1.secretKey)));assert(!text.includes('dummy-test-key'));
});
test('Stop while route is building prevents signing/submission of the queued trade',async()=>{
  const h=await harness();let release,entered;const seen=new Promise(r=>entered=r),hold=new Promise(r=>release=r);const original=h.p.build;
  h.p.build=async(...args)=>{entered();await hold;return original(...args);};
  await h.engine.start(config({mode:'live'}));await h.engine.onTransaction(event());await seen;h.engine.stop();release();await h.engine.stopPromise;
  assert.equal(h.submits,0);assert.equal(h.ledgers.live.data.pending.length,0);assert.equal(h.engine.c.wallets[0].keypair,null);
});
test('ladder crossing does not sell the same threshold twice',async()=>{
  const h=await harness();await h.engine.start(config({sellMode:'percent',percentStep:25,sellPercent:25}));await h.engine.onTransaction(event());await drain(h.engine);
  h.p.market.set(mint,{price:1.5,marketCap:150000,receivedAt:Date.now()});await h.engine.pollMarkets();await drain(h.engine);
  assert.equal(h.ledgers.paper.data.lots[0].remaining,'562');assert.equal(h.ledgers.paper.data.lots[0].lastLevel,2);
  await h.engine.pollMarkets();await drain(h.engine);assert.equal(h.ledgers.paper.data.lots[0].remaining,'562');await stop(h.engine);
});
test('repeated failed ladder orders pause after three submissions without consuming inventory',async()=>{
  const options={failed:false};const h=await harness(options);
  await h.engine.start(config({mode:'live',sellMode:'percent',percentStep:25,sellPercent:25}));
  clearInterval(h.engine.pollTimer);
  await h.engine.onTransaction(event());await drain(h.engine);
  options.failed=true;h.p.market.set(mint,{price:1.5,marketCap:150000,receivedAt:Date.now()});
  for(let i=0;i<5;i++){await h.engine.pollMarkets();await drain(h.engine);}
  assert.equal(h.submits,4);assert.equal(h.ledgers.live.data.lots[0].remaining,'1000');
  assert.equal(h.ledgers.live.data.lots[0].lastLevel,0);assert.equal(h.engine.status().positions[0].ladderPaused,true);
  await stop(h.engine);
});

test('extension fallback simulates unsigned and never submits a failed or malformed simulation',async()=>{
  for(const value of [{err:{InstructionError:[1,'Custom']}},{}]) {
    const h=await harness(),original=h.p.build;
    h.p.build=async(...args)=>({...await original(...args),requiresSimulation:true});let simulations=0;
    h.p.rpc=async(method,params)=>{
      simulations++;assert.equal(method,'simulateTransaction');assert.equal(params[1].sigVerify,false);
      const tx=VersionedTransaction.deserialize(Buffer.from(params[0],'base64'));
      assert(tx.signatures.every(sig=>sig.every(byte=>byte===0)));return {value};
    };
    await h.engine.start(config({mode:'live'}));await h.engine.onTransaction(event());await drain(h.engine);
    assert.equal(simulations,1);assert.equal(h.submits,0);assert.equal(h.ledgers.live.data.pending.length,0);assert.equal(h.ledgers.live.data.lots.length,0);
    await stop(h.engine);
  }
});

test('successful extension simulation permits one submission; Stop during simulation permits none',async()=>{
  for(const stopDuringSimulation of [false,true]) {
    const h=await harness(),original=h.p.build, notification=event();
    h.p.build=async(...args)=>({...await original(...args),requiresSimulation:true});
    h.p.rpc=async(method,params,signal,deadline)=>{
      assert.equal(method,'simulateTransaction'); assert.equal(signal,h.engine.abort.signal);
      assert.equal(deadline,notification.receivedAt+h.engine.c.maxSignalAgeMs);
      if(stopDuringSimulation)h.engine.stop();return {value:{err:null}};
    };
    await h.engine.start(config({mode:'live'}));await h.engine.onTransaction(notification);await drain(h.engine);
    assert.equal(h.submits,stopDuringSimulation?0:1);
    if(!stopDuringSimulation) {
      assert(Number.isFinite(h.engine.metrics.lastExecution.feePreparationMs));
      assert.equal(h.engine.status().execution.rpcRequestsPerSecond,8);
      assert.equal(h.engine.status().execution.maxSignalAgeMs,5000);
    }
    if(stopDuringSimulation)await h.engine.stopPromise;else await stop(h.engine);
  }
});

test('HTTP 429 backs off without stopping the run, losing the journal, or submitting another buy',async()=>{
  const options={unresolved:true};const h=await harness(options),e=h.engine;
  await e.start(config({mode:'live'}));clearInterval(e.receiptTimer);
  await e.onTransaction(event());await drain(e);
  const sig=e.status().pending[0].signature,normal=h.p.statuses;let calls=0;
  h.p.statuses=async()=>{calls++;throw new ProviderError('RPC getSignatureStatuses returned HTTP 429 (rate limited).',{httpStatus:429,retryable:true,rateLimited:true,retryAfterMs:10000});};
  e.receiptNextAt=0;
  await Promise.all(Array.from({length:20},()=>e.reconcileAll()));
  await Promise.all(Array.from({length:20},()=>e.reconcileAll()));
  assert.equal(calls,1);assert.equal(e.state,'running');assert.equal(e.accepting,true);
  assert(e.receiptNextAt>=Date.now()+9900);assert.equal(e.status().followers[0].blocked,true);
  await e.onTransaction(event());await drain(e);assert.equal(h.submits,1);
  const persisted=await new Ledger(join(h.dir,'live.json')).load();assert.equal(persisted.data.pending[0].signature,sig);
  options.unresolved=false;h.p.statuses=normal;e.receiptNextAt=0;await e.reconcileAll();
  assert.equal(e.status().pending.length,0);assert.equal(e.status().followers[0].blocked,false);
  assert.equal(h.ledgers.live.data.lots.length,1);assert.equal(h.submits,1);assert.equal(e.state,'running');
  assert(e.status().events.some(x=>x.message.includes('confirmation checks recovered')));await stop(e);
});

test('20 pending wallets share one status batch and a cached block-height read',async()=>{
  const h=await harness(),e=h.engine;await e.start(config({mode:'live'}));clearInterval(e.receiptTimer);
  h.ledgers.live.data.pending=Array.from({length:20},()=>({signature:bs58.encode(Buffer.concat([Keypair.generate().secretKey])),wallet:Keypair.generate().publicKey.toBase58(),order:{kind:'buy',receivedAt:0},lastValidBlockHeight:1000}));
  let statuses=0,heights=0;
  h.p.statuses=async signatures=>{statuses++;assert.equal(signatures.length,20);return signatures.map(()=>null);};
  h.p.height=async()=>{heights++;return 100;};
  e.receiptIntervalMs=1500;await Promise.all(Array.from({length:20},()=>e.reconcileAll()));
  assert.equal(statuses,1);assert.equal(heights,1);
  e.receiptNextAt=0;await e.reconcileAll();assert.equal(statuses,2);assert.equal(heights,1);
  assert.equal(e.status().pending.length,20);assert.equal(h.submits,0);await stop(e);
});

test('an expired signature is cleared only after successful historical checks, including across restart',async()=>{
  const h=await harness({unresolved:true}),e=h.engine;await e.start(config({mode:'live'}));clearInterval(e.receiptTimer);
  await e.onTransaction(event());await drain(e);await stop(e);
  const restored=await new Ledger(join(h.dir,'live.json')).load();assert.equal(restored.data.pending.length,1);
  const restarted=new Engine({live:restored,paper:h.ledgers.paper},()=>h.p);
  h.p.height=async()=>2000;h.p.statuses=async signatures=>signatures.map(()=>null);
  h.p.transaction=async()=>{throw new ProviderError('RPC history rate limited.',{retryable:true,httpStatus:429,retryAfterMs:5000});};
  await restarted.start(config({mode:'live'}));clearInterval(restarted.receiptTimer);
  assert.equal(restarted.state,'running');assert.equal(restarted.status().pending.length,1);assert.equal(restarted.status().followers[0].blocked,true);
  h.p.transaction=async()=>null;restarted.receiptNextAt=0;await restarted.reconcileAll();
  assert.equal(restarted.status().pending.length,0);assert.equal(restarted.status().followers[0].blocked,false);
  assert.equal(restored.data.lots.length,0);assert.equal(h.submits,1);await stop(restarted);
});

test('relay acknowledgment, not a local signature, increments submitted and supplies export diagnostics',async()=>{
  const h=await harness({unresolved:true}),e=h.engine,original=h.p.submit;
  let release;const held=new Promise(resolve=>release=resolve);
  h.p.submit=async bytes=>{const result=await original(bytes);await held;return result;};
  await e.start(config({mode:'live'}));clearInterval(e.receiptTimer);
  await e.onTransaction(event());await drain(e);
  assert.equal(e.metrics.submitted,0);assert(!e.status().events.some(x=>x.level==='sent'));
  const pending=h.ledgers.live.data.pending[0],sending=e.transmissions.get(pending.signature);
  release();await sending.promise;
  assert.equal(e.metrics.submitted,1);assert(e.status().events.some(x=>x.level==='sent'&&x.message.includes('awaiting on-chain confirmation')));
  const exported=e.status();assert.equal(exported.pending[0].relayAttempts[0].accepted,true);
  assert.equal(exported.pending[0].lastValidBlockHeight,1000);assert.equal(exported.pending[0].order.amount,'50000000');
  const json=JSON.stringify(exported);assert(!json.includes(bs58.encode(key1.secretKey)));assert(!json.includes('dummy-jupiter'));assert(!json.includes('dummy-test-key'));
  await stop(e);
});

test('bounded rebroadcasts use identical bytes and signature and respect signal age and Stop',async()=>{
  const h=await harness({unresolved:true}),e=h.engine,original=h.p.submit,bytes=[];
  h.p.submit=async raw=>{bytes.push(Buffer.from(raw));return original(raw);};
  await e.start(config({mode:'live'}));clearInterval(e.receiptTimer);
  await e.onTransaction(event());await drain(e);
  const pending=h.ledgers.live.data.pending[0],sending=e.transmissions.get(pending.signature);
  await sending.promise;sending.lastSentAt=Date.now()-2001;
  pending.order.receivedAt=Date.now()-e.c.maxSignalAgeMs-1;e.rebroadcastPending(pending);assert.equal(bytes.length,1);
  pending.order.receivedAt=Date.now();e.accepting=false;e.rebroadcastPending(pending);assert.equal(bytes.length,1);e.accepting=true;
  for(let i=0;i<5;i++){sending.lastSentAt=Date.now()-2001;e.rebroadcastPending(pending);await sending.promise;}
  assert.equal(bytes.length,3);assert(bytes.every(b=>b.equals(bytes[0])));assert.equal(e.metrics.submitted,1);
  assert.equal(h.ledgers.live.data.pending.length,1);assert.equal(h.ledgers.live.data.lots.length,0);await stop(e);
});

test('ordinary live routes simulate by default, expose program errors, and respect an explicit simulation opt-out',async()=>{
  for(const simulateBeforeSend of [undefined,false]) {
    const h=await harness(),e=h.engine;let simulations=0;
    h.p.rpc=async()=>{simulations++;return {value:{err:{InstructionError:[3,{Custom:6002}]},logs:['Program log: slippage exceeded']}};};
    await e.start(config({mode:'live',simulateBeforeSend}));await e.onTransaction(event());await drain(e);
    assert.equal(h.submits,simulateBeforeSend===false?1:0);assert.equal(simulations,simulateBeforeSend===false?0:1);
    if(simulateBeforeSend!==false)assert(e.status().events.some(x=>x.programLogs?.includes('Program log: slippage exceeded')));
    await stop(e);
  }
});

test('simulation replacement blockhash and expiry are signed and journaled together',async()=>{
  const h=await harness(),e=h.engine,original=h.p.submit,replacement=Keypair.generate().publicKey.toBase58();
  h.p.rpc=async()=>({value:{err:null,replacementBlockhash:{blockhash:replacement,lastValidBlockHeight:2000}}});
  h.p.submit=async bytes=>{
    const tx=VersionedTransaction.deserialize(bytes);assert.equal(tx.message.recentBlockhash,replacement);
    const journal=JSON.parse(await readFile(join(h.dir,'live.json'),'utf8'));
    assert.equal(journal.pending[0].lastValidBlockHeight,2000);return original(bytes);
  };
  await e.start(config({mode:'live'}));await e.onTransaction(event());await drain(e);
  assert.equal(h.submits,1);assert.equal(h.ledgers.live.data.lots.length,1);await stop(e);
});

test('oversized v1 buys and sells require unsigned simulation even with fast setup, then sign and journal the replacement blockhash',async()=>{
  for(const scenario of ['success','failure','unsupported','stop']){
    const h=await harness(),e=h.engine,originalBuild=h.p.build,originalSubmit=h.p.submit,replacement=Keypair.generate().publicKey.toBase58();let simulations=0;
    h.p.build=async(order,wallet)=>({...await originalBuild(order,wallet),nativeInstructions:[new TransactionInstruction({programId:new PublicKey(JUPITER),data:Buffer.alloc(100),
      keys:[{pubkey:new PublicKey(wallet.publicKey),isSigner:true,isWritable:true},...Array.from({length:40},()=>({pubkey:Keypair.generate().publicKey,isSigner:false,isWritable:true}))]})]});
    h.p.rpc=async(method,[wire,options])=>{
      simulations++;assert.equal(method,'simulateTransaction');assert.equal(options.sigVerify,false);
      const tx=VersionedTransaction.deserialize(Buffer.from(wire,'base64'));assert.equal(tx.version,1);assert(tx.signatures.every(s=>s.every(b=>b===0)));
      if(scenario==='unsupported')throw new ProviderError('RPC does not support this transaction version',{rpcCode:-32015});
      if(scenario==='stop')e.stop();
      return {value:{err:scenario==='failure'?{InstructionError:[0,{Custom:6002}]}:null,logs:[],replacementBlockhash:{blockhash:replacement,lastValidBlockHeight:2000}}};
    };
    h.p.submit=async bytes=>{
      const tx=VersionedTransaction.deserialize(bytes),journal=JSON.parse(await readFile(join(h.dir,'live.json'),'utf8'));
      assert.equal(tx.version,1);assert.equal(tx.message.recentBlockhash,replacement);
      assert.equal(journal.pending[0].lastValidBlockHeight,2000);assert.equal(journal.pending[0].order.transactionVersion,1);
      return originalSubmit(bytes);
    };
    await e.start(config({mode:'live',simulateBeforeSend:false}));await e.onTransaction(event());await drain(e);
    if(scenario==='success'){
      assert.equal(h.submits,1);assert.equal(e.metrics.lastExecution.simulationPerformed,true);
      await e.onTransaction(event(swap({input:mint,output:SOL,before:1000n,sold:1000n})));await drain(e);
      assert.equal(h.submits,2);assert.equal(simulations,2);assert.equal(h.ledgers.live.data.lots[0].remaining,'0');
    }else{assert.equal(h.submits,0);assert.equal(simulations,1);assert.equal(h.ledgers.live.data.pending.length,0);assert.equal(h.ledgers.live.data.lots.length,0);}
    await stop(e);
  }
});

test('a confirmed historical fill is recovered once even when signature statuses are missing',async()=>{
  const h=await harness({unresolved:true}),e=h.engine;
  await e.start(config({mode:'live'}));clearInterval(e.receiptTimer);await e.onTransaction(event());await drain(e);
  assert.equal(h.ledgers.live.data.pending.length,1);
  h.p.height=async()=>2000;e.receiptHeight=null;e.receiptNextAt=0;
  await e.reconcileAll();await e.reconcileAll();
  assert.equal(h.ledgers.live.data.pending.length,0);assert.equal(h.ledgers.live.data.lots.length,1);
  assert.equal(e.metrics.confirmed,1);assert.equal(h.submits,1);await stop(e);
});

test('compact-route recovery requires simulation before live signing even when ordinary simulation is off',async()=>{
  for(const simulationFails of [false,true]) {
    const h=await harness(),e=h.engine,original=h.p.build;let searches=0,simulations=0;
    h.p.build=async(order,wallet)=>({...await original(order,wallet),nativeInstructions:[new TransactionInstruction({programId:new PublicKey(JUPITER),keys:Array.from({length:70},()=>({pubkey:Keypair.generate().publicKey,isSigner:false,isWritable:true})),data:Buffer.alloc(150)})]});
    h.p.jupiterBuild=async(order,wallet)=>{searches++;return build(order,wallet);};
    h.p.rpc=async(method,params)=>{
      simulations++;assert.equal(method,'simulateTransaction');
      const tx=VersionedTransaction.deserialize(Buffer.from(params[0],'base64'));
      assert(tx.signatures.every(sig=>sig.every(byte=>byte===0)));
      return {value:{err:simulationFails?{InstructionError:[3,'test']}:null}};
    };
    await e.start(config({mode:'live',simulateBeforeSend:false}));await e.onTransaction(event());await drain(e);
    assert.equal(searches,1);assert.equal(simulations,1);assert.equal(h.submits,simulationFails?0:1);
    assert.equal(h.ledgers.live.data.pending.length,0);await stop(e);
  }
});

test('a failed build exports its exact public order and app version without credentials',async t=>{
  const h=await harness(),e=h.engine;
  t.after(() => stop(e));
  h.p.build=async()=>{throw new Error('Test route unavailable');};
  const raw=config({mode:'live',buyAmount:'0.17'}),secret=raw.wallets[0].privateKey;
  await e.start(raw);const signal=event();await e.onTransaction(signal);await drain(e);
  const status=e.status(),order=status.events.find(x=>x.order)?.order;
  assert.equal(status.version,packageInfo.version);assert(order);
  assert.equal(order.amount,'170000000');assert.equal(order.inputMint,SOL);assert.equal(order.outputMint,mint);
  assert.equal(order.leadSignature,signal.signature);assert.equal(h.submits,0);
  const text=JSON.stringify(status);assert(!text.includes(secret));assert(!text.includes('dummy-test-key'));assert(!text.includes('dummy-jupiter'));
  await stop(e);
});

test('20 live followers sign valid transactions after full key import and a simulation blockhash replacement',async()=>{
  const h=await harness(),e=h.engine,keys=Array.from({length:20},()=>Keypair.generate()),replacement=Keypair.generate().publicKey.toBase58();
  const raw=config({mode:'live',wallets:keys});
  raw.wallets.forEach((w,i)=>{if(i%2===0)w.privateKey=bs58.encode(keys[i].secretKey);});
  h.p.rpc=async()=>({value:{err:null,replacementBlockhash:{blockhash:replacement,lastValidBlockHeight:2000}}});
  const submit=h.p.submit;
  h.p.submit=async bytes=>{assert.equal(VersionedTransaction.deserialize(bytes).message.recentBlockhash,replacement);return submit(bytes);};
  await e.start(raw);await e.onTransaction(event());await drain(e);
  assert.equal(h.submits,20);assert.equal(e.metrics.confirmed,20);assert.equal(h.ledgers.live.data.lots.length,20);
  assert.equal(h.ledgers.live.data.pending.length,0);await stop(e);
});

test('invalid signatures never reach the journal or relay, even when unsigned simulation succeeds',async()=>{
  const h=await harness(),e=h.engine;await e.start(config({mode:'live'}));
  const wallet=e.c.wallets[0],valid=wallet.keypair;
  wallet.keypair=new Keypair({publicKey:valid.publicKey.toBytes(),secretKey:new Uint8Array(64)});
  await e.onTransaction(event());await drain(e);
  assert.equal(h.submits,0);assert.equal(h.ledgers.live.data.pending.length,0);assert.equal(h.ledgers.live.data.lots.length,0);
  assert(e.status().events.some(x=>x.message.includes('Local transaction signature verification failed')));
  wallet.keypair=valid;await e.onTransaction(event());await drain(e);
  assert.equal(h.submits,1);assert(e.status().events.some(x=>x.signatureVerified===true));await stop(e);
});
