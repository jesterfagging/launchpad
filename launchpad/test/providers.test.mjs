import test from 'node:test';
import assert from 'node:assert/strict';
import { Providers as BaseProviders, ProviderError, jsonFetch, makeTransaction } from '../src/providers.mjs';
import { RequestPacing, requestKey, requestInterval } from '../src/request-pacing.mjs';
// Isolate provider quotas between tests and compress their clock. The shared
// worker transport and production spacing are covered in request-pacing.test.
class Providers extends BaseProviders {
  constructor(...args) { super(...args); const gate = new RequestPacing({ intervalScale: .002 });
    this.jupiterGate = { acquire: (c,s,d) => gate.acquire('jupiter:'+requestKey(c,'jupiter'),null,requestInterval(c,'jupiter'),{signal:s,deadline:d}), cooldown: (c,w) => gate.cooldown('jupiter:'+requestKey(c,'jupiter'),w) };
    this.jitoGate = { acquire: (c,s,d) => gate.acquire('jito:'+requestKey(c,'jito'),null,requestInterval(c,'jito'),{signal:s,deadline:d}), cooldown: (c,w) => gate.cooldown('jito:'+requestKey(c,'jito'),w) }; }
}

test('network failures retain safe DNS, connection and TLS codes without exporting provider credentials', async () => {
  const original = globalThis.fetch;
  try {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EACCES', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      globalThis.fetch = async () => { throw new TypeError('fetch failed', {cause:Object.assign(new Error('https://private.invalid/?api-key=private-secret'), {code})}); };
      await assert.rejects(jsonFetch('https://private.invalid/?api-key=private-secret', {}, 'RPC getGenesisHash'), error => {
        assert.equal(error.networkCode, code); assert(error.message.includes(code));
        assert(!error.message.includes('private-secret') && !error.message.includes('private.invalid'));
        return true;
      });
    }
    const abort = new AbortController(); abort.abort();
    await assert.rejects(jsonFetch('https://private.invalid', {signal:abort.signal}), /Stopped/);
  } finally { globalThis.fetch = original; }
});
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { LaunchRouter } from '../src/launches.mjs';
import { SOL, validateConfig, DirectRouteUnavailableError } from '../src/core.mjs';
import { config, build, mint, blockhash, key1 } from './fixtures.mjs';

const rawTokenAccount = (owner, options = {}) => {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint:new PublicKey(mint), owner:new PublicKey(owner), amount:123456789n,
    delegateOption:0, delegate:PublicKey.default, state:1, isNativeOption:0, isNative:0n,
    delegatedAmount:0n, closeAuthorityOption:0, closeAuthority:PublicKey.default, ...options },data);
  return {lamports:2039280,owner:TOKEN_2022_PROGRAM_ID.toBase58(),data:[data.toString('base64'),'base64'],executable:false,rentEpoch:0};
};
const fastOrder = (sell = false) => ({signalSource:'pump-processed-logs',slot:12345,inputMint:sell?mint:SOL,
  venue:{type:'pump',quoteMint:SOL,baseMint:mint,baseTokenProgram:TOKEN_2022_PROGRAM_ID.toBase58()}});

test('20 fast Pump followers and their pool use one fresh snapshot, including verified sell ATAs', async () => {
  const wallets=Array.from({length:20},()=>({publicKey:Keypair.generate().publicKey.toBase58()}));
  const p=new Providers(validateConfig(config({fastPumpLogs:true})),()=>{}), router=new LaunchRouter(p);
  const native=new Set(wallets.map(w=>w.publicKey)), tokens=new Map(wallets.map(w=>[
    getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(w.publicKey),false,TOKEN_2022_PROGRAM_ID).toBase58(),rawTokenAccount(w.publicKey)]));
  let calls=0;
  p.balance=async()=>{throw Error('separate balance read');};
  p.rpc=async(method,[keys,options])=>{
    calls++;assert.equal(method,'getMultipleAccounts');assert.equal(options.commitment,'processed');assert.equal(options.minContextSlot,12345);
    assert.equal(keys.length,new Set(keys).size);
    return {context:{slot:12345},value:keys.map(k=>tokens.get(k)||{lamports:native.has(k)?1000000000*calls:1,owner:PublicKey.default.toBase58(),data:['','base64']})};
  };
  for(const sell of [false,true]) {
    const jobs=wallets.map(w=>p.executionBalances(fastOrder(sell),w));
    const state=router.accounts([mint,SOL],12345);
    const balances=await Promise.all(jobs);await state;
    assert.equal(calls,sell?2:1);assert(balances.every(b=>b[0]===BigInt(calls)*1000000000n&&b[1]===(sell?123456789n:null)));
  }
});

test('batched processed reads reject incomplete, stale, failed and cancelled snapshots for all callers',async()=>{
  for(const kind of ['incomplete','stale','rpc','stop']) {
    const p=new Providers(validateConfig(config()),()=>{}), abort=new AbortController();let calls=0;
    p.rpc=async(method,[keys])=>{calls++;if(kind==='rpc')throw Error('rate limited');return {context:{slot:kind==='stale'?122:123},value:kind==='incomplete'?[]:keys.map(()=>null)};};
    const jobs=[p.readAccounts([mint],123,abort.signal),p.readAccounts([SOL],123,abort.signal)];
    if(kind==='stop')abort.abort();
    const results=await Promise.allSettled(jobs);assert(results.every(r=>r.status==='rejected'));assert.equal(calls,kind==='stop'?0:1);
  }
});

test('fee account batches preserve commitment, lead slot and cancellation scope without caching completed balances', async () => {
  const p = new Providers(validateConfig(config()), () => {}), calls = [], abort = new AbortController();
  p.rpc = async (method, [keys, options], signal) => {
    assert.equal(method, 'getMultipleAccounts');
    calls.push({ keys, options, signal });
    return { context: { slot: 123 }, value: keys.map(() => ({ lamports: calls.length })) };
  };
  const results = await Promise.all([
    p.readAccounts([mint], 123), p.readAccounts([SOL], 123),
    p.readAccounts([mint], 123, undefined, { commitment: 'confirmed' }),
    p.readAccounts([SOL], 123, undefined, { commitment: 'confirmed' }),
    p.readAccounts([mint], 0, undefined, { commitment: 'confirmed' }),
    p.readAccounts([mint], 123, abort.signal, { commitment: 'confirmed' }),
  ]);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(c => [c.options.commitment, c.options.minContextSlot, c.keys.length]), [
    ['processed', 123, 2], ['confirmed', 123, 2], ['confirmed', undefined, 1], ['confirmed', 123, 1],
  ]);
  assert.equal(results[0].value[0].lamports, results[1].value[0].lamports);
  assert.equal(results[2].value[0].lamports, results[3].value[0].lamports);
  const fresh = await p.readAccounts([mint], 123, undefined, { commitment: 'confirmed' });
  assert.equal(calls.length, 5); assert.equal(fresh.value[0].lamports, 5);
  await assert.rejects(p.readAccounts([mint], 0, undefined, { commitment: 'invalid' }), /commitment/);
});

test('confirmed fee snapshots split at 100 unique accounts and reject incomplete responses for every follower', async () => {
  for (const incomplete of [false, true]) {
    const p = new Providers(validateConfig(config()), () => {}), calls = [];
    const keys = Array.from({ length: 121 }, () => Keypair.generate().publicKey.toBase58());
    p.rpc = async (method, [chunk, options]) => {
      calls.push(chunk); assert.equal(options.commitment, 'confirmed');
      return { context: { slot: 123 }, value: incomplete && calls.length === 2 ? [] : chunk.map(key => ({ key })) };
    };
    const outcomes = await Promise.allSettled(keys.map(key => p.readAccounts([key, mint], 0, undefined, { commitment: 'confirmed' })));
    assert.deepEqual(calls.map(c => c.length), [100, 22]);
    if (incomplete) assert(outcomes.every(r => r.status === 'rejected'));
    else outcomes.forEach((r, i) => {
      assert.equal(r.status, 'fulfilled'); assert.deepEqual(r.value.value.map(a => a.key), [keys[i], mint]);
    });
  }
});

test('RPC -32016 retries the same fresh snapshot for all followers, with no relaxed slot or duplicate batches', async () => {
  const events=[], p=new Providers(validateConfig(config()),(level,message,details)=>events.push({level,message,...details}));
  const calls=[];
  p.rpc=async(method,params)=>{
    calls.push(structuredClone(params)); assert.equal(method,'getMultipleAccounts');
    if(calls.length===1)throw new ProviderError('Minimum context slot has not been reached',{rpcCode:-32016});
    return {context:{slot:123},value:params[0].map(()=>null)};
  };
  const snapshots=await Promise.all(Array.from({length:20},()=>p.readAccounts([mint,SOL],123)));
  assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0][1].minContextSlot,123);
  assert(snapshots.every(s=>s.context.slot===123));assert.equal(events.length,2);assert.equal(events[1].attempts,2);
});

test('RPC slot catch-up is bounded and never retries rate limits, unrelated errors or reads without a target slot',async()=>{
  for(const kind of ['lag','rate','other','no-slot']) {
    const p=new Providers(validateConfig(config()),()=>{});let calls=0;
    p.rpc=async()=>{calls++;throw new ProviderError(kind,{rpcCode:kind==='rate'?429:kind==='other'?-32602:-32016,rateLimited:kind==='rate'});};
    await assert.rejects(p.readAccounts([mint],kind==='no-slot'?0:123),e=>kind!=='lag'||/retry limit reached.*before signing/.test(e.message));
    assert.equal(calls,kind==='lag'?5:1);
  }
});

test('Stop cancels a lagged snapshot before the retry; retry admission still honors the shared RPC rate budget',async()=>{
  const abort=new AbortController();let calls=0;
  const p=new Providers(validateConfig(config()),()=>abort.abort());
  p.rpc=async()=>{calls++;throw new ProviderError('behind',{rpcCode:-32016});};
  await assert.rejects(p.readAccounts([mint],123,abort.signal),/Stopped/);assert.equal(calls,1);
  const limited=new Providers(validateConfig(config({rpcRequestsPerSecond:1,maxSignalAgeMs:100})),()=>{});let transportCalls=0;
  limited.rpcTransport=async()=>{transportCalls++;throw new ProviderError('behind',{rpcCode:-32016});};
  await assert.rejects(limited.readAccounts([mint],123),/retry limit reached/);assert.equal(transportCalls,1);
});

test('fast sell balances verify token program, account owner, mint and frozen state',async()=>{
  for(const kind of ['program','owner','mint','frozen','truncated']) {
    const p=new Providers(validateConfig(config({fastPumpLogs:true})),()=>{}), wallet={publicKey:key1.publicKey.toBase58()};
    const token=rawTokenAccount(wallet.publicKey,kind==='owner'?{owner:PublicKey.default}:kind==='mint'?{mint:PublicKey.default}:kind==='frozen'?{state:2}:{});
    if(kind==='program')token.owner=PublicKey.default.toBase58();if(kind==='truncated')token.data=['','base64'];
    p.rpc=async()=>({context:{slot:12345},value:[{lamports:1000000000},token]});
    await assert.rejects(p.executionBalances(fastOrder(true),wallet));
  }
});

test('fast balance batching preserves confirmed checks for other sources and pairs',async()=>{
  const p=new Providers(validateConfig(config({fastPumpLogs:true})),()=>{}),wallet={publicKey:key1.publicKey.toBase58()};let calls=0;
  p.balance=async()=>{calls++;return 999n;};p.readAccounts=async()=>{throw Error('must retain confirmed path');};
  for(const order of [{...fastOrder(),signalSource:'full-transaction'},{...fastOrder(),signalSource:'pump-confirmed-logs'},
    {...fastOrder(),venue:{...fastOrder().venue,quoteMint:mint}}])assert.deepEqual(await p.executionBalances(order,wallet),[999n,null]);
  assert.equal(calls,3);
});

test('20 fee-paying SPL input balances use a fresh confirmed batch for ordinary routes', async () => {
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const p = new Providers(validateConfig(config()), () => {}), wallets = Array.from({ length: 20 }, () => ({ publicKey: Keypair.generate().publicKey.toBase58() }));
    const accounts = new Map(), orders = wallets.map(wallet => {
      const source = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(wallet.publicKey), false, program).toBase58();
      accounts.set(wallet.publicKey, { lamports: 1000000000 });
      accounts.set(source, { ...rawTokenAccount(wallet.publicKey), owner: program.toBase58() });
      return { inputMint: mint, signalSource: 'manual', platformFee: { mint, wallet: wallet.publicKey, source, program: program.toBase58() } };
    });
    let calls = 0;
    p.balance = async () => assert.fail('per-wallet reads must not consume the manual sell window');
    p.rpc = async (method, [keys, options]) => {
      calls++; assert.equal(method, 'getMultipleAccounts'); assert.equal(options.commitment, 'confirmed');
      assert.equal(options.minContextSlot, undefined); assert.equal(keys.length, 40);
      return { context: { slot: 123 }, value: keys.map(key => accounts.get(key)) };
    };
    const balances = await Promise.all(wallets.map((wallet, i) => p.executionBalances(orders[i], wallet)));
    assert.equal(calls, 1); assert(balances.every(row => row[0] === 1000000000n && row[1] === 123456789n));
    await assert.rejects(p.executionBalances({ ...orders[0], platformFee: { ...orders[0].platformFee, source: mint } }, wallets[0]), /source differs/);
  }
});

test('20 simultaneous SOL balance checks use one fresh RPC read and do not reuse stale balances', async () => {
  const p = new Providers(validateConfig(config()), () => {}); let calls = 0;
  p.rpc = async (method, params) => {
    calls++; assert.equal(method,'getMultipleAccounts'); assert.equal(params[1].commitment,'confirmed');
    assert.deepEqual(params[1].dataSlice,{offset:0,length:0});
    return {value:params[0].map((_,i)=>i===19?null:{lamports:1000*calls+i})};
  };
  const amounts = await Promise.all(Array.from({length:20},()=>p.balance(mint,SOL)));
  assert.equal(calls,1); assert.equal(amounts[0],1000n); assert.equal(amounts[18],1018n); assert.equal(amounts[19],0n);
  assert.equal(await p.balance(mint,SOL),2000n); assert.equal(calls,2);
});

test('incomplete balance batches, failed RPC reads and Stop reject every affected follower', async () => {
  for (const kind of ['incomplete','rpc','stop']) {
    const p = new Providers(validateConfig(config()), () => {}); let calls=0;
    p.rpc=async()=>{calls++;if(kind==='rpc')throw Error('rate limited');return {value:[]};};
    const abort=new AbortController();
    const jobs=Array.from({length:20},()=>p.balance(mint,SOL,abort.signal));
    if(kind==='stop')abort.abort();
    const results=await Promise.allSettled(jobs);assert(results.every(r=>r.status==='rejected'));
    assert.equal(calls,kind==='stop'?0:1);
  }
});

test('startup accepts the complete genesis hash returned by the public Solana mainnet RPC', async () => {
  const p = new Providers(validateConfig(config()), () => {}), calls = [];
  p.rpc = async method => {
    calls.push(method);
    if (method === 'getGenesisHash') return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
    if (method === 'getLatestBlockhash') return { value: { blockhash, lastValidBlockHeight: 1000 } };
    throw Error(`Unexpected method ${method}`);
  };
  p.loadPrograms = async () => {};
  try {
    await p.init(); assert.equal(p.blockhash.blockhash, blockhash);
    assert.deepEqual(calls, ['getGenesisHash', 'getLatestBlockhash']);
  } finally { p.close(); }
});

test('startup rejects non-mainnet hashes and shortened or malformed responses before routing', async () => {
  for (const hash of ['4NucTHyRvBSvbEkYcTTiqoaMQC6p7uBg5cjKPpwv51zo', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', null, {}]) {
    const p = new Providers(validateConfig(config()), () => {}); let calls = 0;
    p.rpc = async method => { calls++; assert.equal(method, 'getGenesisHash'); return hash; };
    await assert.rejects(p.init(), /network other than Solana mainnet/); assert.equal(calls, 1);
    assert.equal(p.warmTimer, null);
  }
});

test('paper and live configurations accept no Jupiter key; routed builds omit the auth header', async () => {
  for (const mode of ['paper', 'live']) {
    const c = validateConfig(config({ mode, jupiterKey: '' }));
    const p = new Providers(c, () => {}), wallet = c.wallets[0];
    const order = { inputMint: SOL, outputMint: mint, amount: 50000000n, receivedAt: Date.now() };
    let calls = 0;
    p.fetch = async (url, options) => { calls++; assert.match(url, /api\.jup\.ag\/swap\/v2\/build/); assert(!('x-api-key' in options.headers)); return build(order, wallet); };
    const result = await p.build(order, wallet);
    assert.equal(result.routeName, 'Jupiter'); assert.equal(calls, 1);
  }
});

test('public registry and concurrent swap builds share a paced queue and skip stale signals', async () => {
  const c = validateConfig(config({ jupiterKey: '' })), p = new Providers(c, () => {}), wallet = c.wallets[0];
  const gate = new RequestPacing(), key = 'public';
  p.jupiterGate = { acquire: (c,s,d) => gate.acquire(key,null,2100,{signal:s,deadline:d}), cooldown: (c,w) => gate.cooldown(key,w) };
  const order = { inputMint: SOL, outputMint: mint, amount: 1n, receivedAt: Date.now() - c.maxSignalAgeMs + 100 };
  let calls = 0;
  p.fetch = async url => { calls++; return url.includes('program-id-to-label') ? {} : build(order, wallet); };
  await p.loadPrograms();
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => p.build(order, wallet)));
  assert.equal(calls, 1); assert.equal(results.filter(r => r.status === 'fulfilled').length, 0);
  const failure = results.find(r => r.status === 'rejected'); assert.match(failure.reason.message, /capacity/); gate.close();
});

test('Stop cancels a waiting public request without a network call', async () => {
  const p = new Providers(validateConfig(config({ jupiterKey: '' })), () => {}), controller = new AbortController();
  p.jupiterGate.cooldown(p.c, 1000); let calls = 0;
  p.fetch = async () => { calls++; return {}; };
  const waiting = p.jupiterRequest('/swap/v1/program-id-to-label', 'Registry', controller.signal);
  controller.abort(); await assert.rejects(waiting, { name: 'AbortError' }); assert.equal(calls, 0);
});

test('a supplied Jupiter key is forwarded and direct routes bypass public quota', async () => {
  const c = validateConfig(config()), p = new Providers(c, () => {}), wallet = c.wallets[0];
  const order = { inputMint: SOL, outputMint: mint, amount: 1n };
  let calls = 0;
  p.fetch = async (url, options) => { calls++; assert.equal(options.headers['x-api-key'], 'dummy-jupiter'); return build(order, wallet); };
  await p.build(order, wallet); assert.equal(calls, 1);
  p.c.jupiterKey = ''; p.direct = { build: async () => ({ routeName: 'Direct test' }) };
  assert.equal((await p.build({ ...order, venue: { type: 'pump' } }, wallet)).routeName, 'Direct test'); assert.equal(calls, 1);
});

test('unsupported direct extensions use the same swap through Jupiter and require simulation', async () => {
  const c=validateConfig(config()),events=[],p=new Providers(c,(level,message)=>events.push(message)),wallet=c.wallets[0];
  const order={inputMint:SOL,outputMint:mint,amount:1n,venue:{type:'pump'}};
  p.direct={build:async()=>{throw new DirectRouteUnavailableError('Active transfer hook.');}};
  let calls=0;p.fetch=async()=>{calls++;return build(order,wallet);};
  const result=await p.build(order,wallet);
  assert.equal(result.routeName,'Jupiter');assert.equal(result.requiresSimulation,true);assert.equal(calls,1);
  assert(events.some(x=>x.includes('Trying Jupiter')));
});

test('direct route limit and integrity failures do not trigger fallback or bypass Jupiter validation', async () => {
  const c=validateConfig(config()),p=new Providers(c,()=>{}),wallet=c.wallets[0],order={inputMint:SOL,outputMint:mint,amount:1n,venue:{type:'pump'}};
  let calls=0;p.fetch=async()=>{calls++;return {...build(order,wallet),slippageBps:c.slippageBps+1};};
  for(const message of ['Pump curve exceeds your price-impact limit.','Launchpad quote mint differs from the observed pair.']) {
    p.direct={build:async()=>{throw Error(message);}};
    await assert.rejects(p.build(order,wallet),e=>e.message===message);
  }
  assert.equal(calls,0);
  p.direct={build:async()=>{throw new DirectRouteUnavailableError('Active transfer hook.');}};
  await assert.rejects(p.build(order,wallet),/exceeded slippage/);assert.equal(calls,1);
});

async function localProvider(t,handler) {
  const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP and JSON-RPC throttling retain retry metadata; provider messages redact credentials',async t=>{
  const url=await localProvider(t,(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url.startsWith('/http')) {res.writeHead(429,{'retry-after':'12'});res.end('{}');}
    else if(req.url.startsWith('/rpc')) res.end(JSON.stringify({error:{code:-32005,message:'Too many requests'}}));
    else res.end(JSON.stringify({error:{code:-32002,message:'Simulation failed: tip mismatch. secret-query-value secret-auth-value https://rpc.example/?api-key=secret-query-value'}}));
  });
  await assert.rejects(jsonFetch(url+'/http'),e=>e instanceof ProviderError&&e.httpStatus===429&&e.rateLimited&&e.retryable&&e.retryAfterMs===12000);
  await assert.rejects(jsonFetch(url+'/rpc'),e=>e instanceof ProviderError&&e.rpcCode===-32005&&e.rateLimited&&e.retryable);
  await assert.rejects(jsonFetch(url+'/?api-key=secret-query-value',{headers:{'x-api-key':'secret-auth-value'}}),e=>{
    assert(!e.message.includes('secret-query-value'));assert(!e.message.includes('secret-auth-value'));assert(!e.message.includes('https://rpc.example'));
    return e.rpcCode===-32002&&!e.retryable&&e.message.includes('tip mismatch');
  });
});

test('HTTP route errors expose the reason without credentials and distinguish unavailable routes from other errors',async t=>{
  const url=await localProvider(t,(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url.startsWith('/auth')){res.writeHead(401);res.end(JSON.stringify({message:'Invalid API key: secret-auth-value'}));}
    else if(req.url.startsWith('/limit')){res.writeHead(429,{'retry-after':'2'});res.end(JSON.stringify({error:'Too many requests secret-query-value'}));}
    else {res.writeHead(400);res.end(JSON.stringify({error:'No routes found. secret-query-value secret-auth-value',errorCode:'COULD_NOT_FIND_ANY_ROUTE'}));}
  });
  for(const path of ['/route','/auth','/limit']){
    await assert.rejects(jsonFetch(url+path+'?api-key=secret-query-value',{headers:{'x-api-key':'secret-auth-value'}},'Jupiter route'),e=>{
      assert(!e.message.includes('secret-query-value'));assert(!e.message.includes('secret-auth-value'));
      assert.equal(e.routeUnavailable,path==='/route');
      if(path==='/route')assert.match(e.message,/HTTP 400: No routes found/);
      if(path==='/limit'){assert(e.rateLimited);assert.equal(e.retryAfterMs,2000);}
      return true;
    });
  }
});

test('RPC requests share a rate budget, and cancellation prevents queued network requests',async t=>{
  // Admission and the transport continuation occupy different microtasks.
  // A busy host can delay the first transport after its permit, so comparing
  // wall-clock transport timestamps does not measure the admission window.
  // Control the admission clock and check that queued calls remain blocked.
  t.mock.timers.enable({apis:['Date','setTimeout'],now:10000});
  const flush=()=>new Promise(setImmediate);
  const p=new Providers(validateConfig(config({rpcRequestsPerSecond:2})),()=>{}),starts=[];
  p.rpcTransport=async()=>{starts.push(Date.now());return 1;};
  const batch=Promise.all([p.rpc('getBalance'),p.rpc('getBlockHeight'),p.rpc('getLatestBlockhash')]);
  await flush();assert.deepEqual(starts,[10000,10000]);
  t.mock.timers.tick(999);await flush();assert.equal(starts.length,2);
  t.mock.timers.tick(2);await batch;assert.deepEqual(starts,[10000,10000,11001]);
  await p.rpc('getBalance');const abort=new AbortController();
  const waiting=p.rpc('getBalance',[],abort.signal);abort.abort();
  await assert.rejects(waiting,{name:'AbortError'});assert.equal(starts.length,4);
  await assert.rejects(p.rpc('sendTransaction',[],undefined,Date.now()-1),/signal age exceeded/);assert.equal(starts.length,4);
});

test('one rate limit cools down every RPC reader and resumes after the backoff',async()=>{
  const p=new Providers(validateConfig(config()),()=>{});let calls=0;
  p.rpcTransport=async()=>{calls++;throw new ProviderError('HTTP 429',{rateLimited:true,retryable:true,retryAfterMs:8000});};
  await assert.rejects(p.rpc('getSignatureStatuses'),e=>e.retryAfterMs>=7900);
  const results=await Promise.allSettled(Array.from({length:20},()=>p.rpc('getBalance')));
  assert(results.every(r=>r.status==='rejected'&&r.reason.retryable));assert.equal(calls,1);
  p.rpcBlockedUntil=Date.now()-1;p.rpcTransport=async()=>{calls++;return 42;};
  assert.equal(await p.rpc('getBlockHeight'),42);assert.equal(calls,2);assert.equal(p.rpcFailures,0);
});

test('signature status batching rejects missing outcomes instead of treating them as expired',async()=>{
  const p=new Providers(validateConfig(config()),()=>{}),signatures=Array.from({length:20},(_,i)=>String(i));let calls=0;
  p.rpc=async(method,params)=>{calls++;assert.equal(method,'getSignatureStatuses');assert.deepEqual(params,[signatures,{searchTransactionHistory:true}]);return {value:signatures.map(()=>null)};};
  assert.equal((await p.statuses(signatures)).length,20);assert.equal(calls,1);
  for(const value of [[],Array(20).fill(undefined),Array(20).fill({})]) {
    p.rpc=async()=>({value});await assert.rejects(p.statuses(signatures),e=>e instanceof ProviderError&&e.retryable);
  }
});

for(const version of [0,1]) test(`v${version}: all relay results are reported, identical bytes are sent, and a throttled relay honors cooldown`,async t=>{
  const requests=[];
  const url=await localProvider(t,async(req,res)=>{
    const body=[];for await(const part of req)body.push(part);
    requests.push({path:req.url,body:JSON.parse(Buffer.concat(body))});
    res.setHeader('content-type','application/json');
    if(req.url==='/jito'){res.writeHead(429,{'retry-after':'30'});res.end('{}');}
    else res.end(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32002,message:'Simulation failed: tip missing'}}));
  });
  const c=validateConfig(config({jitoSol:'0.001',heliusSol:'0.001',jitoUrl:url+'/jito',senderUrl:url+'/helius'})),p=new Providers(c,()=>{});
  const order={inputMint:SOL,outputMint:mint,amount:50000000n},built=makeTransaction(build(order,c.wallets[0]),c.wallets[0],c,[mint],version);
  built.tx.sign([key1]);const bytes=built.tx.serialize(),signature=bs58.encode(built.tx.signatures[0]);
  let rpcCalls=0;p.rpc=async(method,params)=>{rpcCalls++;assert.equal(method,'sendTransaction');assert.equal(params[0],Buffer.from(bytes).toString('base64'));return signature;};
  const outcomes=[];let done;const reported=new Promise(resolve=>done=resolve);
  const result=await p.submit(bytes,r=>{outcomes.push(r);if(outcomes.length===3)done();});
  await reported;
  assert.equal(result.route,'RPC');assert.equal(result.signature,signature);assert.equal(rpcCalls,1);
  assert.equal(requests.length,2);assert(requests.every(r=>r.body.params[0]===Buffer.from(bytes).toString('base64')));
  assert(outcomes.some(r=>r.route==='Jito'&&!r.accepted&&r.httpStatus===429&&r.retryAfterMs===30000));
  assert(outcomes.some(r=>r.route==='Helius'&&!r.accepted&&r.rpcCode===-32002));
  const again=[];let againDone;const reportedAgain=new Promise(resolve=>againDone=resolve);
  await p.submit(bytes,r=>{again.push(r);if(again.length===3)againDone();});await reportedAgain;
  assert.equal(requests.filter(r=>r.path==='/jito').length,1);assert(again.some(r=>r.route==='Jito'&&r.error.includes('cooling down')));
});

test('an unrelated returned signature is not accepted, and Stop cancels a queued RPC submission',async()=>{
  const c=validateConfig(config({rpcRequestsPerSecond:1})),p=new Providers(c,()=>{}),order={inputMint:SOL,outputMint:mint,amount:1n};
  const {tx}=makeTransaction(build(order,c.wallets[0]),c.wallets[0],c,[]);tx.sign([key1]);const bytes=tx.serialize();
  p.rpcTransport=async()=> 'wrong-signature';const reports=[];
  await assert.rejects(p.submit(bytes,r=>reports.push(r)),AggregateError);
  assert.equal(reports.length,1);assert.equal(reports[0].accepted,false);assert.match(reports[0].error,/different signature/);
  let calls=0;p.rpcTransport=async()=>{calls++;return bs58.encode(tx.signatures[0]);};
  const abort=new AbortController(),queued=p.submit(bytes,()=>{},abort.signal);await delay(5);abort.abort();p.close();
  await assert.rejects(queued,AggregateError);assert.equal(calls,0);
});

for(const version of [0,1]) test(`v${version}: invalid wire signatures are rejected before any RPC, Jito or Helius request`,async t=>{
  let calls=0;const url=await localProvider(t,(req,res)=>{calls++;res.end('{}');});
  const c=validateConfig(config({mode:'live',jitoSol:'0.001',heliusSol:'0.001',jitoUrl:url,senderUrl:url})),p=new Providers(c,()=>{});
  p.rpc=async()=>{calls++;return 'unexpected';};
  const {tx}=makeTransaction(build({inputMint:SOL,outputMint:mint,amount:1n},c.wallets[0]),c.wallets[0],c,[mint],version);
  await assert.rejects(p.submit(tx.serialize()),/signature verification failed/);
  tx.sign([c.wallets[0].keypair]);tx.signatures[0][0]^=1;
  await assert.rejects(p.submit(tx.serialize()),/signature verification failed/);assert.equal(calls,0);
});
