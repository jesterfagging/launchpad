import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { LaunchCurveHistory } from '../src/launch-curve-history.mjs';

const NOW = Date.UTC(2026, 8, 24, 12);
const pool = n => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (n + i) % 256)).toBase58();
const POOL = pool(1);
const row = (overrides = {}) => ({ poolId: POOL, t: NOW / 1000 - 120, o: 0.0000002, h: 0.0000004, l: 0.0000001, c: 0.0000003, vA: 1000, vB: 0.0003, vU: 20, ...overrides });
const response = rows => Response.json({ success: true, data: { rows } });

test('history keeps quote prices and quote volume, orders seconds, and calls only the fixed public endpoint', async () => {
  let request;
  const history = new LaunchCurveHistory({ now: () => NOW, fetcher: async (url, options) => {
    request = { url, options };
    return response([row({ t: NOW / 1000 - 60 }), row()]);
  } });
  const result = await history.read(POOL);
  assert.equal(request.url, `https://launch-history-v1.raydium.io/kline?poolId=${POOL}&interval=1m&limit=300`);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(request.options.headers, { accept: 'application/json' });
  assert.equal(result.source, 'Raydium history');
  assert.equal(result.at, NOW);
  assert.deepEqual(result.candles.map(c => c.time), [NOW / 1000 - 120, NOW / 1000 - 60]);
  assert.equal(result.candles[0].close, 0.0000003);
  assert.equal(result.candles[0].volume, 0.0003);
  assert.equal(Object.isFrozen(result.candles[0]), true);
  history.close();
});

test('coalesces concurrent reads and refreshes only after the 30 second cache expires', async () => {
  let now = NOW, calls = 0, release;
  const history = new LaunchCurveHistory({ now: () => now, fetcher: async () => {
    calls++;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    return response([row()]);
  } });
  const one = history.read(POOL), two = history.read(POOL);
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await one, await two);
  now += 29_999;
  assert.ok(await history.read(POOL));
  assert.equal(calls, 1);
  now++;
  await history.read(POOL);
  assert.equal(calls, 2);
  history.close();
});

test('rejects wrong or missing pool identity and malformed history rather than displaying another market', async () => {
  for (const bad of [row({ poolId: pool(2) }), row({ poolId: undefined }), row({ t: NOW }), row({ t: NOW / 1000 + 300 }), row({ t: 1 }), row({ o: '0.2' }), row({ h: 0 }), row({ c: Infinity }), row({ l: 10 }), row({ vB: -1 })]) {
    const history = new LaunchCurveHistory({ now: () => NOW, fetcher: async () => response([bad]) });
    assert.equal(await history.read(POOL), null, JSON.stringify(bad));
    history.close();
  }
});

test('rejects duplicate timestamps, oversized row counts and failed envelopes', async () => {
  for (const value of [response([row(), row()]), response(Array.from({ length: 301 }, () => row())), Response.json({ success: false, data: { rows: [row()] } }), Response.json({ success: true, data: {} })]) {
    const history = new LaunchCurveHistory({ now: () => NOW, fetcher: async () => value });
    assert.equal(await history.read(POOL), null);
    history.close();
  }
});

test('unindexed, invalid JSON, and transient errors are negative-cached without breaking the onchain fallback', async () => {
  for (const result of [() => response([]), () => new Response('broken'), () => new Response('', { status: 503 }), () => { throw new Error('offline'); }]) {
    let calls = 0;
    const history = new LaunchCurveHistory({ now: () => NOW, fetcher: async () => { calls++; return result(); } });
    assert.equal(await history.read(POOL), null);
    assert.equal(await history.read(POOL), null);
    assert.equal(calls, 1);
    history.close();
  }
});

test('limits body size even when the provider omits Content-Length', async () => {
  const history = new LaunchCurveHistory({ now: () => NOW, fetcher: async () => new Response(' '.repeat(256_001)) });
  assert.equal(await history.read(POOL), null);
  history.close();
});

test('request deadline returns a fallback even when a provider does not settle', async () => {
  let signal;
  const history = new LaunchCurveHistory({ now: () => NOW, timeoutMs: 15, fetcher: (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  assert.equal(await history.read(POOL), null);
  assert.equal(signal.aborted, true);
  assert.equal(history.pending.size, 0);
  history.close();
});

test('429 cooldown applies to every pool and honors both Retry-After formats', async () => {
  for (const header of ['120', new Date(NOW + 120_000).toUTCString()]) {
    let now = NOW, calls = 0;
    const history = new LaunchCurveHistory({ now: () => now, fetcher: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': header } }); } });
    assert.equal(await history.read(POOL), null);
    now += 119_999;
    assert.equal(await history.read(pool(2)), null);
    assert.equal(calls, 1);
    now++;
    await history.read(pool(2));
    assert.equal(calls, 2);
    history.close();
  }
});

test('invalid Retry-After receives a one minute cooldown', async () => {
  const history = new LaunchCurveHistory({ now: () => NOW, fetcher: async () => new Response('', { status: 429, headers: { 'retry-after': 'invalid' } }) });
  await history.read(POOL);
  assert.equal(history.retryUntil, NOW + 60_000);
  history.close();
});

test('queues distinct history reads fairly behind the active cap and clears cache on close', async () => {
  let calls = 0;
  const releases = [];
  const history = new LaunchCurveHistory({ now: () => NOW,waitMs:10, fetcher: async () => { calls++; await new Promise(resolve => releases.push(resolve)); return response([]); } });
  const reads = Array.from({ length: 8 }, (_, i) => history.read(pool(i + 1)));
  assert.equal(await history.read(pool(20)), null);
  assert.equal(calls, 8);
  assert.equal(history.pending.size,9);
  releases.forEach(resolve => resolve());
  await Promise.all(reads);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,9);releases.at(-1)();await Promise.all(history.pending.values());
  assert.equal(history.cache.size, 9);
  history.close();
  assert.equal(history.cache.size, 0);
  assert.equal(await history.read(POOL), null);
  assert.equal(calls, 9);
});

test('cache and per-minute budgets stay bounded when many valid pools are requested', async () => {
  let now = NOW, calls = 0;
  const history = new LaunchCurveHistory({ now: () => now, fetcher: async () => { calls++; return response([]); } });
  for (let i = 1; i <= 61; i++) await history.read(pool(i));
  assert.equal(calls, 60);
  now += 60_001;
  for (let i = 61; i <= 120; i++) await history.read(pool(i));
  assert.equal(history.cache.size, 120);
  assert(history.cache.has(pool(1)));
  assert.equal(history.requests.length, 60);
  history.close();
});

test('invalid curve identifiers are rejected before fetching', async () => {
  let calls = 0;
  const history = new LaunchCurveHistory({ fetcher: async () => { calls++; return response([]); } });
  for (const value of ['https://example.com', '', '0'.repeat(44), null, undefined]) await assert.rejects(history.read(value), { statusCode: 400 });
  assert.equal(calls, 0);
  history.close();
});

test('custom quote candles render without optional volume and include the carried opening price',async()=>{
  const history=new LaunchCurveHistory({now:()=>NOW,fetcher:async()=>response([row({o:0.000059561895651391175,h:0.00005922383236879368,l:0.00005922383236879368,c:0.00005922383236879368,vB:undefined})])});
  const result=await history.read(POOL);assert.equal(result.candles.length,1);assert.equal(result.candles[0].volume,null);assert.equal(result.candles[0].high,result.candles[0].open);history.close();
});

test('a failed candle refresh preserves verified candles and their original timestamp with a stale label',async()=>{
  let now=NOW,failed=false;
  const history=new LaunchCurveHistory({now:()=>now,fetcher:async()=>failed?new Response('',{status:503}):response([row()])});
  try{
    const original=await history.read(POOL);now+=31000;failed=true;const stale=await history.read(POOL);
    assert.equal(stale.stale,true);assert.equal(stale.at,original.at);assert.deepEqual(stale.candles,original.candles);
    now+=16*60000;assert.equal(await history.read(POOL),null);
  }finally{history.close();}
});
