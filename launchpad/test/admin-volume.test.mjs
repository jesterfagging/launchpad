import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AdminVolume, adminVolumeRecord } from '../src/admin-volume.mjs';
import { ray } from '../src/launchpad-chain.mjs';
import { SOL } from '../src/core.mjs';
import { LaunchCurveActivity } from '../src/launch-curve-activity.mjs';
import { createHash } from 'node:crypto';

const admin = 'a'.repeat(32), user = 'b'.repeat(32), NOW = 1790380800000;
const address = () => Keypair.generate().publicKey.toBase58();
const derive = (mint, quote) => ray.getPdaLaunchpadPoolId(ray.LAUNCHPAD_PROGRAM, new PublicKey(mint), new PublicKey(quote)).publicKey.toBase58();
function launch(quoteMint = SOL) {
  const mint = address();
  return { id: 'launch-' + mint, state: 'launched', authorizedAt: NOW - 300000, createdAt: NOW - 300000,
    curve: derive(mint, quoteMint), input: { route: 'raydium', network: 'mainnet-beta', quoteMint, quoteSymbol: 'QUOTE', name: 'Coin', symbol: 'COIN' },
    review: { quoteSymbol: quoteMint === SOL ? 'SOL' : 'QUOTE', configId: address(), quoteDecimals: 9, secret: 'private-review' },
    keys: { mint: { address: mint, secret: 'private-mint' }, wallet: { address: address(), secret: 'private-wallet' } }, operations: [] };
}
function fixture(options = {}) {
  let now = NOW;
  const timers = new Map(); let nextTimer = 0;
  const users = [{ id: admin, role: 'admin', mfaEnabled: true }, { id: user, role: 'user', banned: true }];
  const books = new Map(), activities = new Map(), markets = new Map(), snapshots = new Map();
  const calls = { activity: 0, market: 0, snapshot: 0, books: 0 };
  const accounts = { get: async id => users.find(row => row.id === id), list: async () => users,
    storeFor: id => ({ read: async (key, fallback) => { assert.equal(key, 'launchpad'); calls.books++; return books.get(id) || fallback; }, write: () => assert.fail('read-only report') }) };
  const service = new AdminVolume({ accounts, activity: { read: async curve => { calls.activity++; return activities.get(curve); } },
    marketData: { pools: async (chain, mint) => { assert.equal(chain, 'solana'); calls.market++; return markets.get(mint); } },
    marketSnapshot: async record => { calls.snapshot++; assert(!JSON.stringify(record).includes('private-')); return snapshots.get(record.keys.mint.address); },
    now: () => now, waitMs: 100,
    setTimer: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; }, clearTimer: id => timers.delete(id), ...options });
  function add(l, { volume = 10, price = 2, complete = true, pools = [], stage = 'curve' } = {}) {
    const list = books.get(user) || { launches: [] }; list.launches.push(l); books.set(user, list);
    activities.set(l.curve, { poolId: l.curve, at: now, stale: false, windows: { h24: { quote: volume, complete } } });
    markets.set(l.keys.mint.address, { chain: 'solana', tokenAddress: l.keys.mint.address, at: now, pools });
    snapshots.set(l.keys.mint.address, { mint: l.keys.mint.address, curve: l.curve, at: now, slot: 20, status: stage,
      quote: { mint: l.input.quoteMint, usd: price, at: now, stale: false } });
    return l;
  }
  function touch() { for (const rows of [activities, markets, snapshots]) for (const value of rows.values()) { value.at = now; if (value.quote) value.quote.at = now; } }
  async function advance(ms, beforeTimer = () => {}) {
    const target = now + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); beforeTimer(); next[1].fn(); await Promise.allSettled([service.refreshPending,service.dexRefreshPending]);
    }
    now = target;
  }
  return { service, accounts, users, books, activities, markets, snapshots, calls, timers, add, touch, advance, set now(value) { now = value; }, get now() { return now; } };
}
const pool = (mint, quote, value, extra = {}) => ({ token: mint, address: address(), base: { address: mint }, quote: { address: quote }, volume24h: value, ...extra });

test('includes hidden, archived and banned-owner completed coins; deduplicates mints; excludes failed setup', async () => {
  const f = fixture(), a = f.add(launch()), b = f.add(launch(address()), { volume: 5, price: 3 });
  a.moderation = { hidden: true }; b.listArchive = { archived: true };
  f.books.get(user).launches.push(structuredClone(a), { ...launch(), state: 'failed', curve: null });
  const result = await f.service.read(admin);
  assert.equal(result.volumeUsd, 35); assert.equal(result.observedVolumeUsd, 35); assert.equal(result.lifetimeVolumeUsd, null);
  assert.equal(result.coverage.launches, 2); assert.equal(result.coverage.complete, 2); assert.equal(result.coverage.usdComplete, 2);
  assert(result.coins.some(row => row.hidden)); assert(result.coins.some(row => row.archived));
  assert.equal(result.quoteTotals.length, 2); assert.deepEqual(result.quoteTotals.map(row => row.volume24hQuote).sort((x, y) => x - y), [5, 10]);
  assert(!JSON.stringify(result).includes('private-')); assert.equal(f.calls.activity, 2);
});

test('curve and graduated AMM volume combine while overlapping curve index and repeated pool rows count once', async () => {
  const f = fixture(), l = launch(), mint = l.keys.mint.address;
  const cpmm = pool(mint, SOL, 75), curve = pool(mint, SOL, 999, { address: l.curve });
  f.add(l, { stage: 'migrated', pools: [cpmm, structuredClone(cpmm), curve] });
  const result = await f.service.read(admin);
  assert.equal(result.volumeUsd, 95); assert.equal(result.coins[0].volume24hUsd, 95); assert.equal(result.quoteTotals[0].volume24hQuote, 10);
  assert.match(result.coins[0].source, /Raydium/); assert.match(result.coins[0].source, /DEX Screener/);
});

test('one AMM pool between two Launchpad coins counts once globally, with honest per-coin overlapping rows', async () => {
  const f = fixture(), a = launch(), b = launch(), shared = address();
  f.add(a, { volume: 1, pools: [pool(a.keys.mint.address, b.keys.mint.address, 100, { address: shared })] });
  f.add(b, { volume: 2, pools: [pool(b.keys.mint.address, a.keys.mint.address, 100, { address: shared })] });
  const result = await f.service.read(admin);
  assert.equal(result.volumeUsd, 106); assert.equal(result.coins.reduce((n, row) => n + row.volume24hUsd, 0), 206);
  assert.match(result.note, /Shared pools count once/);
});

test('missing USD prices preserve quote volume without treating unlike quote assets as a common amount', async () => {
  const f = fixture(); f.add(launch(), { volume: 3, price: null }); f.add(launch(address()), { volume: 7, price: 4 });
  const result = await f.service.read(admin);
  assert.equal(result.volumeUsd, null); assert.equal(result.observedVolumeUsd, 28); assert.equal(result.coverage.complete, 2);
  assert.equal(result.coverage.usdComplete, 1); assert.equal(result.coverage.unpriced, 1);
  assert.equal(result.quoteTotals.length, 2); assert(result.quoteTotals.every(row => row.volume24hQuote !== null));
});

test('incomplete Raydium history is a subtotal and never a full 24h or lifetime claim', async () => {
  const f = fixture(); f.add(launch(), { volume: 700, complete: false });
  const result = await f.service.read(admin);
  assert.equal(result.volumeUsd, null); assert.equal(result.observedVolumeUsd, 1400); assert.equal(result.coverage.partial, 1);
  assert.equal(result.coins[0].volume24hQuote, null); assert.equal(result.coins[0].observedVolumeQuote, 700);
  assert.equal(result.lifetimeVolumeUsd, null); assert.match(result.note, /never added together/);
});

test('DEX complete curve report can fill incomplete or unpriced curve USD without duplicating it', async () => {
  for (const options of [{ complete: false, price: 2 }, { complete: true, price: null }]) {
    const f = fixture(), l = launch(); f.add(l, { ...options, pools: [pool(l.keys.mint.address, SOL, 77, { address: l.curve })] });
    const result = await f.service.read(admin); assert.equal(result.volumeUsd, 77); assert.equal(result.coins[0].source, 'DEX Screener');
  }
});

test('missing graduated pool and capped pool list remain partial even with complete curve history', async () => {
  for (const capped of [false, true]) {
    const f = fixture(), l = launch(); f.add(l, { stage: 'migrated', pools: capped ? Array.from({ length: 20 }, () => pool(l.keys.mint.address, SOL, 2)) : [] });
    const result = await f.service.read(admin); assert.equal(result.volumeUsd, null); assert.equal(result.coverage.partial, 1);
  }
});

test('unknown, stale, mismatched and invalid provider results never appear as fresh complete volume', async () => {
  for (const mutation of [
    f => { f.activities.values().next().value.stale = true; },
    f => { f.activities.values().next().value.windows.h24.quote = Infinity; },
    f => { f.activities.values().next().value.poolId = address(); },
    f => { f.markets.values().next().value.tokenAddress = address(); },
    f => { f.markets.values().next().value.at = NOW - 121000; },
    f => { f.snapshots.values().next().value.quote.mint = address(); },
  ]) {
    const f = fixture(); f.add(launch()); mutation(f); const result = await f.service.read(admin); assert.equal(result.volumeUsd, null);
  }
});

test('shared pool address with conflicting mint identities invalidates the total', async () => {
  const f = fixture(), a = launch(), b = launch(), shared = address();
  f.add(a, { pools: [pool(a.keys.mint.address, SOL, 100, { address: shared })] });
  f.add(b, { pools: [pool(b.keys.mint.address, SOL, 100, { address: shared })] });
  const result = await f.service.read(admin); assert.equal(result.volumeUsd, null); assert.equal(result.complete, false);
});

test('failed inventory reads expose missing coverage and redact provider/store errors', async () => {
  const f = fixture(); f.add(launch()); const original = f.accounts.storeFor;
  f.accounts.storeFor = id => id === admin ? { read: async () => { throw Error('https://private-rpc/key-secret'); } } : original(id);
  const result = await f.service.read(admin);
  assert.equal(result.volumeUsd, null); assert.equal(result.observedVolumeUsd, 20); assert.equal(result.coverage.inventoryComplete, false);
  assert(!JSON.stringify(result).includes('key-secret'));
});

test('fresh no-launch inventory gives zero, whereas unavailable inventory never fabricates zero', async () => {
  const f = fixture(); assert.equal((await f.service.read(admin)).volumeUsd, 0);
  const bad = fixture(); bad.accounts.storeFor = () => ({ read: async () => { throw Error('private'); } });
  const result = await bad.service.read(admin); assert.equal(result.volumeUsd, null); assert.equal(result.observedVolumeUsd, null);
});

test('admin plus MFA required on every response including cached data and mid-read revocation', async () => {
  const f = fixture(); f.add(launch()); await assert.rejects(f.service.read(user), error => error.statusCode === 403); assert.equal(f.calls.books, 0);
  f.users[0].mfaEnabled = false; await assert.rejects(f.service.read(admin), error => error.statusCode === 403); assert.equal(f.calls.books, 0);
  f.users[0].mfaEnabled = true; await f.service.read(admin); f.users[0].banned = true;
  await assert.rejects(f.service.read(admin), error => error.statusCode === 403);
  const g = fixture(); g.accounts.list = async () => { g.users[0].role = 'user'; return g.users; };
  await assert.rejects(g.service.read(admin), error => error.statusCode === 403);
});

test('concurrent admin polls coalesce and capped batches rotate without a market request storm', async () => {
  const f = fixture(); for (let i = 0; i < 15; i++) f.add(launch());
  const results = await Promise.all([f.service.read(admin), f.service.read(admin), f.service.read(admin)]);
  assert.equal(f.calls.books, 2); assert.equal(f.calls.activity, 6); assert.equal(f.calls.market, 6); assert.equal(f.calls.snapshot, 6);
  assert.equal(results[0].coverage.launches, 15); assert.equal(results[0].coverage.unavailable, 9);
  await f.service.read(admin); assert.equal(f.calls.activity, 6);
  f.now += 30000; await f.service.read(admin); assert.equal(f.calls.activity, 12);
  f.now += 30000; await f.service.read(admin); assert.equal(f.calls.activity, 18);
  assert.equal((await f.service.read(admin)).coverage.unavailable, 0);
});

test('old cached data ages out and cannot masquerade as the current 24h window', async () => {
  const f = fixture(); f.add(launch()); assert.equal((await f.service.read(admin)).volumeUsd, 20);
  f.now += 121000; const result = await f.service.read(admin);
  assert.equal(result.volumeUsd, null); assert.equal(result.observedVolumeUsd, null); assert.equal(result.coverage.unavailable, 1);
  assert.equal(result.sampledVolumeUsd, 20); assert.equal(result.sampling.oldestAt, NOW);
});

test('background scanning covers 31 coins with an honest sampled total despite minute-long UI polling', async () => {
  const f = fixture(); for (let i = 0; i < 31; i++) f.add(launch());
  const initial = await f.service.read(admin);
  assert.equal(initial.sampledVolumeUsd, null); assert.equal(initial.sampledObservedVolumeUsd, 120); assert.equal(f.calls.activity, 6);
  await f.advance(60000, f.touch); await f.service.read(admin); assert.equal(f.calls.activity, 18);
  await f.advance(60000, f.touch); await f.service.read(admin); assert.equal(f.calls.activity, 30);
  await f.advance(30000, f.touch);
  const result = f.service.report();
  assert.equal(f.calls.activity, 36); assert.equal(result.volumeUsd, null); assert.equal(result.sampledVolumeUsd, 620);
  assert.equal(result.sampling.cachedCoins, 31); assert.equal(result.sampling.oldestAt, NOW); assert.equal(result.sampling.newestAt, NOW + 150000);
  assert.equal(result.sampling.maxAgeMs, 900000); assert.match(result.note, /not one synchronized current window/);
  assert(!JSON.stringify(result).includes('private-')); f.service.close(); assert.equal(f.timers.size, 0);
});

test('active-view timer stops at two minutes, unauthorized polls do not renew it, and close cancels it', async () => {
  const f = fixture(); f.add(launch()); await f.service.read(admin);
  await f.advance(90000, f.touch); const before = f.calls.activity;
  await assert.rejects(f.service.read(user), error => error.statusCode === 403);
  await f.advance(30000, f.touch); assert.equal(f.calls.activity, before); assert.equal(f.timers.size, 0);
  await f.advance(300000, f.touch); assert.equal(f.calls.activity, before);
  f.touch(); await f.service.read(admin); assert.equal(f.calls.activity, before + 1); assert.equal(f.timers.size, 1);
  f.service.close(); await f.advance(60000, f.touch); assert.equal(f.calls.activity, before + 1); assert.equal(f.timers.size, 0);
});

test('refresh workers never exceed three and do not start the remaining batch after the view lease expires', async () => {
  const pending = []; let active = 0, peak = 0;
  const f = fixture({ waitMs: 0, marketSnapshot: () => new Promise(resolve => { active++; peak = Math.max(peak, active); pending.push(() => { active--; resolve(null); }); }) });
  for (let i = 0; i < 12; i++) f.add(launch());
  await f.service.read(admin); assert.equal(pending.length, 3); assert.equal(peak, 3);
  f.now += 120000; pending.splice(0).forEach(resolve => resolve()); await f.service.refreshPending;
  assert.equal(f.calls.activity, 3); assert.equal(f.timers.size, 0); assert.equal(f.service.refreshPending, null);
  f.service.close();
});

test('sample cache preserves complete windows through missing history without renewing or accumulating them', async () => {
  const f = fixture(), l = f.add(launch()); await f.service.read(admin);
  f.activities.get(l.curve).windows.h24.complete = false;
  await f.advance(30000, f.touch);
  let result = f.service.report();
  assert.equal(result.volumeUsd, null); assert.equal(result.sampledVolumeUsd, 20); assert.equal(result.sampling.oldestAt, NOW);
  f.activities.clear(); f.markets.clear(); f.snapshots.clear();
  await f.advance(870000); result = f.service.report(); assert.equal(result.sampledVolumeUsd, 20);
  await f.advance(1); result = f.service.report();
  assert.equal(result.sampledVolumeUsd, null); assert.equal(result.sampledObservedVolumeUsd, null); assert.equal(result.sampling.cachedCoins, 0);
  assert.equal(result.coins[0].sampledVolume24hUsd, null); assert.equal(result.lifetimeVolumeUsd, null);
});

test('freshness and sample age include coverage and price inputs, even an empty DEX pool response', async () => {
  for (const older of ['price', 'snapshot', 'dex']) {
    const f = fixture(), l = f.add(launch()), snapshot = f.snapshots.get(l.keys.mint.address);
    if (older === 'price') snapshot.quote.at = NOW - 119000;
    else if (older === 'snapshot') snapshot.at = NOW - 119000;
    else f.markets.get(l.keys.mint.address).at = NOW - 119000;
    assert.equal((await f.service.read(admin)).volumeUsd, 20);
    f.now += 2000;
    const result = f.service.report(); assert.equal(result.volumeUsd, null); assert.equal(result.sampledVolumeUsd, 20);
    assert.equal(result.sampling.oldestAt, NOW - 119000); assert.equal(result.sampling.newestAt, NOW);
  }
});

test('Meteora and Pump recorded USD expire with the exact quote price while native volume remains available', async () => {
  for (const platform of ['meteora', 'pumpswap']) {
    const f = fixture(), l = f.add(launch(), { complete: false }), mint = l.keys.mint.address;
    await f.service.inventory();
    const record = f.service.records[0]; record.platform = platform;
    f.snapshots.get(mint).quote.at = NOW - 119000;
    const source = { activityRaw: f.activities.get(l.curve), dexRaw: f.markets.get(mint), snapshotRaw: f.snapshots.get(mint) };
    f.service.sources.set(mint, source); f.service.project(record, source);
    assert.equal(f.service.report().observedVolumeUsd, 20);
    f.now += 2000;
    const report = f.service.report();
    assert.equal(report.observedVolumeUsd, null);
    assert.equal(report.coins[0].observedVolumeQuote, 10);
    assert.equal(report.volumeUsd, null); f.service.close();
  }
});

test('sampled totals deduplicate the newest shared pool observation without adding successive windows', async () => {
  const f = fixture({ maxRefresh: 1 }), a = launch(), b = launch(), shared = address();
  f.add(a, { volume: 1, pools: [pool(a.keys.mint.address, b.keys.mint.address, 100, { address: shared })] });
  f.add(b, { volume: 2, pools: [pool(b.keys.mint.address, a.keys.mint.address, 100, { address: shared })] });
  await f.service.read(admin);
  for (const market of f.markets.values()) market.pools[0].volume24h = 110;
  await f.advance(30000, f.touch);
  assert.equal(f.service.report().sampledVolumeUsd, 116);
  await f.advance(30000, f.touch); assert.equal(f.service.report().sampledVolumeUsd, 116);
  assert.equal(f.service.report().sampling.cachedCoins, 2);
});

test('conflicting duplicate pool identities cannot seed a complete sample', async () => {
  const f = fixture(), l = launch(), one = pool(l.keys.mint.address, SOL, 100);
  f.add(l, { pools: [one, { ...one, quote: { address: address() } }] });
  const result = await f.service.read(admin);
  assert.equal(result.volumeUsd, null); assert.equal(result.sampledVolumeUsd, null); assert.equal(result.sampledObservedVolumeUsd, null);
});

test('sample coverage follows inventory changes and missing records never become verified zero', async () => {
  const f = fixture(), l = f.add(launch()); await f.service.read(admin);
  f.now += 30000; f.add(launch()); f.activities.clear(); f.markets.clear(); f.snapshots.clear();
  let result = await f.service.read(admin); assert.equal(result.sampledVolumeUsd, null); assert.equal(result.sampledObservedVolumeUsd, 20);
  assert.equal(result.sampling.cachedCoins, 1); assert.equal(result.coverage.launches, 2);
  f.books.get(user).launches = []; f.now += 30000;
  result = await f.service.read(admin); assert.equal(result.sampledVolumeUsd, 0); assert.equal(result.sampling.cachedCoins, 0); assert.equal(f.service.samples.has(l.keys.mint.address), false);
  const bad = fixture(); bad.accounts.storeFor = () => ({ read: async () => { throw Error('private'); } });
  result = await bad.service.read(admin); assert.equal(result.sampledVolumeUsd, null); assert.equal(result.sampledObservedVolumeUsd, null);
});

test('close during inventory cannot repopulate records or start background reads', async () => {
  let release; const f = fixture(); f.add(launch());
  f.accounts.list = () => new Promise(resolve => { release = () => resolve(f.users); });
  const reading = f.service.read(admin); await Promise.resolve(); await Promise.resolve(); f.service.close(); release();
  await assert.rejects(reading, /restarting/); assert.equal(f.calls.activity, 0); assert.equal(f.timers.size, 0); assert.equal(f.service.records.length, 0);
});

test('background refresh has bounded wait and response serialization never returns signing fields', async () => {
  let resolve;
  const f = fixture({ waitMs: 5, marketSnapshot: () => new Promise(done => { resolve = done; }) }); f.add(launch());
  const result = await f.service.read(admin); assert.equal(result.refreshing, true); assert.equal(result.volumeUsd, null);
  assert(!JSON.stringify(result).includes('keys')); resolve(null); await f.service.refreshPending;
  f.service.close(); await assert.rejects(f.service.read(admin), /restarting/);
});

test('record validation accepts confirmed creation recovery and rejects drafts, other networks and curve mismatches', () => {
  const l = launch(); l.curve = null; l.state = 'failed'; l.operations = [{ kind: 'launch-all', state: 'confirmed', slot: 1, signature: '1'.repeat(64), createdAt: NOW - 1000 }];
  assert(adminVolumeRecord(l, NOW)); l.state = 'draft'; assert.equal(adminVolumeRecord(l, NOW), null);
  l.state = 'failed'; l.input.network = 'devnet'; assert.equal(adminVolumeRecord(l, NOW), null);
  l.input.network = 'mainnet-beta'; l.curve = address(); assert.equal(adminVolumeRecord(l, NOW), null);
});

test('quote references completing outside coin snapshots price analytics by exact fresh mint', async () => {
  const refs = new Map(), explore = { quoteReferences: refs, entries: new Map() }, f = fixture({ explore });
  const l = f.add(launch(), { volume: 3, price: null }); refs.set(SOL, { usd: '4', at: NOW, stale: false });
  const result = await f.service.read(admin); assert.equal(result.volumeUsd, 12); assert.equal(f.service.quotePrices().get(SOL).usd, 4);
  refs.set(SOL, { usd: 99, at: NOW, mint: address() }); assert.equal(f.service.quotePrices().get(SOL).usd, 4);
  f.service.entries.clear(); assert.equal(f.service.quotePrices().has(SOL), false);
  refs.set(SOL, { usd: 99, at: NOW - 120001 }); assert.equal(f.service.quotePrices().has(SOL), false);
  explore.entries.set(l.keys.mint.address, { native: { mint: l.keys.mint.address, curve: l.curve, quote: { mint: SOL, usd: 5, at: NOW } } });
  assert.equal(f.service.quotePrices().get(SOL).usd, 5); f.service.close();
});
test('analytics-only visitors share bounded quote warmup without a home-page market fetch', async () => {
  const refs = new Map(), requests = [], explore = { quoteReferences: refs, entries: new Map(), chain: async () => ({
    mintInfo: async mint => ({ decimals: 9, mint }), referencePrice: async input => { requests.push(input.quoteMint); const price = { usd: 7, at: NOW }; refs.set(input.quoteMint, price); return price; },
  }) };
  const f = fixture({ explore }); for (let i = 0; i < 9; i++) f.add(launch(i === 0 ? SOL : address()), { price: null });
  await Promise.all(Array.from({ length: 20 }, () => f.service.readPublic())); await f.service.quoteRefreshPending;
  assert.equal(new Set(requests).size, 6); assert.equal(requests.length, 6);
  assert.equal(f.service.quotePrices().size, 6);
  await f.advance(30_000); await f.service.quoteRefreshPending;
  assert.equal(new Set(requests).size, 9); assert.equal(f.service.quotePrices().size, 9); f.service.close();
});

test('matching 30-second refresh periods consume completed shared activity instead of perpetual stale predecessors', async () => {
  const f = fixture(), l = f.add(launch()); let requests = 0;
  const activity = new LaunchCurveActivity({ now: () => f.now, fetcher: async () => {
    requests++;
    return new Response(JSON.stringify({ success: true, data: { rows: [{ poolId: l.curve,
      txid: '2'.repeat(64), owner: address(), blockTime: Math.floor(f.now / 1000) - 1,
      side: 'buy', amountA: 100, amountB: requests * 10 }], nextPageKey: null } }));
  } });
  f.service.activity = activity;
  try {
    assert.equal((await f.service.read(admin)).volumeUsd, 20);
    await f.advance(30_000, f.touch);
    assert.equal(f.service.report().volumeUsd, 40);
    assert.equal(f.service.report().quoteTotals[0].volume24hQuote, 20);
    await f.advance(30_000, f.touch);
    assert.equal(f.service.report().volumeUsd, 60); assert.equal(requests, 3);
    assert.equal(f.service.sources.get(l.keys.mint.address).activityRaw.trades, undefined);
  } finally { f.service.close(); activity.close(); }
});

test('native windows survive expired USD coverage and retain explicit sample times without renewing them', async () => {
  const f = fixture(), l = f.add(launch());
  f.snapshots.get(l.keys.mint.address).quote.at = NOW - 119_000;
  await f.service.read(admin); f.now += 2000;
  let report = f.service.report();
  assert.equal(report.volumeUsd, null); assert.equal(report.quoteTotals[0].volume24hQuote, 10);
  assert.equal(report.coins[0].volume24hQuote, 10);
  f.now = NOW + 120_001; report = f.service.report();
  assert.equal(report.quoteTotals[0].volume24hQuote, null);
  assert.equal(report.quoteTotals[0].sampledVolume24hQuote, 10);
  assert.equal(report.quoteTotals[0].sampledObservedVolumeQuote, 10);
  assert.equal(report.quoteTotals[0].sampledComplete, 1); assert.equal(report.quoteTotals[0].sampledCoins, 1);
  assert.equal(report.quoteTotals[0].sampledAt, NOW);
  f.now = NOW + 900_001; report = f.service.report();
  assert.equal(report.quoteTotals[0].sampledObservedVolumeQuote, null);
  assert.equal(report.quoteTotals[0].sampledAt, null); f.service.close();
});

test('rate-queued activity does not relabel its cached predecessor as a newly fresh window', async () => {
  const f = fixture(), l = f.add(launch()), cached = f.activities.get(l.curve);
  const pending = new Promise(() => {}); pending.started = false;
  f.service.activity = { read: async () => ({ ...cached, stale: true }),
    pending: new Map([[l.curve, pending]]), cache: new Map([[l.curve, { value: cached, checkedAt: NOW }]]) };
  const report = await f.service.read(admin);
  assert.equal(report.volumeUsd, null); assert.equal(report.quoteTotals[0].observedVolumeQuote, null);
  assert.equal(report.quoteTotals[0].sampledObservedVolumeQuote, null); f.service.close();
});

test('native unpriced and incomplete windows expose truthful independent sample coverage', async () => {
  const f = fixture(); f.add(launch(), { price: null, volume: 3 }); f.add(launch(), { price: null, volume: 7, complete: false });
  let report = await f.service.read(admin);
  assert.equal(report.volumeUsd, null); assert.equal(report.sampledObservedVolumeUsd, null);
  assert.equal(report.quoteTotals[0].observedVolumeQuote, 10); assert.equal(report.quoteTotals[0].complete, 1);
  assert.equal(report.quoteTotals[0].volume24hQuote, null);
  f.now += 121_000; report = f.service.report();
  assert.equal(report.quoteTotals[0].observedVolumeQuote, null);
  assert.equal(report.quoteTotals[0].sampledObservedVolumeQuote, 10);
  assert.equal(report.quoteTotals[0].sampledVolume24hQuote, null);
  assert.equal(report.quoteTotals[0].sampledComplete, 1); assert.equal(report.quoteTotals[0].sampledCoins, 2); f.service.close();
});

test('late quote completion revalues existing native observations without another pool or history request', async () => {
  let finish; const explore = { entries: new Map(), chain: async () => ({
    mintInfo: async () => ({}), referencePrice: () => new Promise(resolve => { finish = resolve; }),
  }) };
  const f = fixture({ explore, waitMs: 0 }); f.add(launch(), { price: null, volume: 3 }); f.add(launch(), { price: null, volume: 7 });
  await f.service.read(admin); await f.service.refreshPending;
  assert.equal(f.service.report().volumeUsd, null); const calls = { ...f.calls };
  finish({ usd: '4', at: f.now, mint: SOL }); await f.service.quoteRefreshPending;
  const report = f.service.report(); assert.equal(report.volumeUsd, 40); assert.equal(report.coverage.usdComplete, 2);
  assert.equal(report.sampledVolumeUsd, 40); assert.deepEqual(f.calls, calls);
  // The exact same cached price is available to the persistent lifetime ledger.
  let sharedPrices;
  f.service.lifetime = { readPublic: ({ pricesByMint }) => { sharedPrices = pricesByMint; return { period: 'lifetime', marker: 'shared-ledger' }; } };
  assert.equal((await f.service.read(admin)).lifetime.marker, 'shared-ledger'); assert.equal(sharedPrices.get(SOL).usd, 4);
  f.service.close();
});

test('new shared prices supersede older snapshot prices but never revive expired native windows', async () => {
  const refs = new Map(), f = fixture({ explore: { quoteReferences: refs, entries: new Map() } }); f.add(launch(), { price: 2 });
  await f.service.read(admin); f.now += 1000; refs.set(SOL, { usd: 3, at: f.now });
  assert.equal(f.service.report().volumeUsd, 30); assert.equal(f.service.report().quoteTotals[0].volume24hQuote, 10);
  f.now += 120_000; refs.set(SOL, { usd: 4, at: f.now });
  const report = f.service.report(); assert.equal(report.volumeUsd, null); assert.equal(report.quoteTotals[0].volume24hQuote, null);
  assert.equal(report.sampledVolumeUsd, 30); assert.equal(report.sampling.oldestAt, NOW); f.service.close();
});

test('background lifetime price warming is shared, bounded, independent of a viewer and cannot repopulate after close', async () => {
  const requests = [], releases = [], explore = { chain: async () => ({
    mintInfo: async mint => ({ mint }), referencePrice: async input => { requests.push(input.quoteMint); return { usd: 5, at: NOW }; },
  }) };
  const f = fixture({ explore }); for (let i = 0; i < 9; i++) f.add(launch(address()), { price: null });
  await f.service.inventory(); assert.equal(f.service.active(), false); assert.equal(f.service.refreshQuotePrices(), null);
  await Promise.all(Array.from({ length: 20 }, () => f.service.refreshQuotePrices({ background: true })));
  assert.equal(requests.length, 6); assert.equal(f.calls.snapshot, 0); assert.equal(f.calls.activity, 0);
  f.now += 30_000; await f.service.refreshQuotePrices({ background: true }); assert.equal(requests.length, 9);
  f.service.close(); assert.equal(f.service.quoteReferences.size, 0);
  const slow = fixture({ explore: { chain: async () => ({ mintInfo: async () => ({}), referencePrice: () => new Promise(resolve => releases.push(resolve)) }) } });
  slow.add(launch()); await slow.service.inventory(); const work = slow.service.refreshQuotePrices({ background: true });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(releases.length, 1);
  slow.service.close(); releases[0]({ usd: 5, at: NOW }); await work;
  assert.equal(slow.service.quoteReferences.size, 0); assert.equal(slow.service.entries.size, 0);
});

async function dammFixture({indexed=[],complete=true}={}) {
  const f=fixture(),l=f.add(launch(),{stage:'migrated',pools:indexed}),destination=address();
  await f.service.inventory();const record=f.service.records[0];record.platform='damm-pump';record.chainRecord.review.poolId=destination;
  const rows=Array.from({length:501},(_,i)=>({eventId:createHash('sha256').update(String(i)).digest('hex'),poolId:i<301?record.curve:destination,venue:i<301?'damm':'pumpswap',side:i%2?'buy':'sell',time:Math.floor(NOW/1000)-10,quote:1}));
  f.service.explore={dammPump:{marketSnapshot:async()=>f.snapshots.get(record.mint),analyticsTrades:async()=>({source:'damm-pump-onchain',mint:record.mint,poolId:record.curve,trades:rows,at:f.now,recentComplete:complete})},nativeActivity:()=>assert.fail('Analytics must not use the 200-row UI trade feed.')};
  return {...f,record,rows,destination,original:f};
}

test('PumpSwap analytics uses all local trades and keeps each actual pool separate',async()=>{
  const f=await dammFixture();
  f.rows.push({...f.rows[0]}, {...f.rows[0],eventId:'f'.repeat(64),time:Math.floor(NOW/1000)-86401});
  await f.service.observe(f.record);const report=f.service.report(),source=f.service.sources.get(f.record.mint).activityRaw;
  assert.equal(report.observedVolumeUsd,1002);assert.equal(report.coins[0].observedVolumeQuote,501);
  assert.deepEqual(source.pools.map(p=>p.quote),[301,200]);assert.equal(source.trades,undefined);
  assert.equal(report.volumeUsd,1002);f.service.close();
});

test('PumpSwap DEX pools replace only matching onchain pools and retain external markets',async()=>{
  const f=await dammFixture(),mint=f.record.mint;
  f.markets.get(mint).pools=[pool(mint,SOL,100,{address:f.destination}),pool(mint,SOL,7)];
  await f.service.observe(f.record);assert.equal(f.service.report().observedVolumeUsd,709);
  f.markets.get(mint).pools.push(pool(mint,SOL,500,{address:f.record.curve}));
  await f.service.observe(f.record);const report=f.service.report();assert.equal(report.observedVolumeUsd,607);
  assert.equal(report.coins[0].source,'DEX Screener');assert.equal(report.quoteTotals[0].volume24hQuote,501);f.service.close();
});

test('incomplete or invalid PumpSwap history cannot claim complete markets or price unknown pools',async()=>{
  const f=await dammFixture({complete:false});
  f.rows.push({...f.rows[0],eventId:'e'.repeat(64),poolId:address(),quote:1e9});
  await f.service.observe(f.record);let report=f.service.report();assert.equal(report.observedVolumeUsd,1002);assert.equal(report.volumeUsd,null);
  f.service.explore.dammPump.analyticsTrades=async()=>({source:'damm-pump-onchain',mint:address(),poolId:f.record.curve,trades:f.rows,at:NOW,recentComplete:true});
  await f.service.observe(f.record);report=f.service.report();assert.equal(report.observedVolumeUsd,null);f.service.close();
});

test('a known zero-volume PumpSwap pool does not require a missing price reference',async()=>{
  const f=await dammFixture();f.rows.splice(301);f.snapshots.get(f.record.mint).quote.usd=null;
  await f.service.observe(f.record);const report=f.service.report();
  assert.equal(report.volumeUsd,null);assert.equal(report.coins[0].observedVolumeQuote,301);
  assert.equal(report.coins[0].status,'unpriced');f.service.close();
});

test('sixty launched markets refresh DEX coverage within one minute without accelerating RPC history work',async()=>{
  const f=fixture();for(let i=0;i<60;i++){const l=launch();f.add(l,{stage:'migrated',complete:false,pools:[pool(l.keys.mint.address,SOL,100)]});}
  await f.service.readPublic();assert.equal(f.calls.activity,6);
  await f.advance(50_000,f.touch);let report=f.service.report();
  assert.equal(report.coins.filter(row=>row.observedVolumeUsd!==null).length,60);
  assert(report.observedVolumeUsd>=6000);assert.equal(f.calls.activity,12);assert.equal(f.calls.snapshot,12);
  await f.service.readPublic();await f.advance(60_000,f.touch);await f.service.readPublic();await f.advance(30_000,f.touch);
  report=f.service.report();assert.equal(report.coins.filter(row=>row.observedVolumeUsd!==null).length,60);assert(report.observedVolumeUsd>=6000);
  assert(f.calls.activity<=30);f.service.close();assert.equal(f.timers.size,0);
});

test('expiry of an older native source does not discard a still fresh indexed pool',async()=>{
  const f=fixture(),l=launch();f.add(l,{stage:'migrated',pools:[pool(l.keys.mint.address,SOL,100)]});
  await f.service.read(admin);f.now=NOW+119000;
  const source=f.service.sources.get(l.keys.mint.address);source.dexRaw={...source.dexRaw,at:f.now};f.service.project(f.service.records[0],source);
  assert.equal(f.service.report().observedVolumeUsd,120);
  f.now+=2000;assert.equal(f.service.report().observedVolumeUsd,100);assert.equal(f.service.report().volumeUsd,null);f.service.close();
});

test('DEX-only work remains shared and bounded and late responses cannot repopulate a closed report',async()=>{
  const f=fixture({waitMs:0});for(let i=0;i<20;i++)f.add(launch());await f.service.readPublic();await f.service.refreshPending;
  const pending=[];let active=0,peak=0,calls=0;
  f.service.marketData={pools:async(chain,mint)=>{calls++;active++;peak=Math.max(peak,active);return new Promise(resolve=>pending.push(()=>{active--;resolve({...f.markets.get(mint),at:f.now});}));}};
  f.now+=5000;const work=f.service.refreshDex();assert.equal(f.service.refreshDex(),work);assert.equal(calls,3);assert.equal(peak,3);
  f.service.close();pending.splice(0).forEach(resolve=>resolve());await work;
  assert.equal(calls,3);assert.equal(f.service.sources.size,0);assert.equal(f.service.entries.size,0);assert.equal(f.timers.size,0);
});

test('Pump.fun coins count as launches and use their own market snapshot and onchain trade paths', async () => {
  const creator = { id: 'c'.repeat(32), role: 'user', authType: 'wallet', mainWallet: address() }, operator = { id: 'd'.repeat(32), role: 'admin', authType: 'password', mainWallet: address() };
  const coins = [creator, operator].map((owner, index) => ({ platform: 'pump-classic', status: 'trading', id: String(index).repeat(24), creatorId: owner.id, mint: address(), bondingCurve: address(), createdAt: NOW - 60000, mode: 'creator', name: 'Classic', symbol: 'CLS' + index, quoteMint: SOL, quoteDecimals: 9 }));
  let snapshots = 0, activity = 0, lists = 0;
  const explore = {
    pumpClassic: { publicList: async () => { lists++; return coins; }, marketSnapshot: async mint => { snapshots++; const coin = coins.find(row => row.mint === mint); return { mint, curve: coin.bondingCurve, status: 'curve', slot: 20, at: f.now, supply: 1e9, quote: { mint: SOL, usd: 2, at: f.now, stale: false } }; } },
    nativeActivity: async ({ coin }) => { activity++; assert.equal(coin.platform, 'pump-classic'); return { poolId: coin.curve, at: f.now, stale: false, windows: { h24: { quote: 5, complete: false } } }; },
  };
  const f = fixture({ explore }); f.users.push(creator, operator);
  await f.service.inventory();
  assert.equal(lists, 1); assert.equal(f.service.inventoryComplete, true);
  const record = f.service.records.find(row => row.mint === coins[0].mint);
  assert.equal(record.platform, 'pump-classic'); assert.equal(record.curve, coins[0].bondingCurve); assert.equal(record.quote.mint, SOL);
  // A wallet account can only fund from its own wallet; any other creator counts once by account.
  assert.deepEqual(f.service.launchFacts.map(row => row.developer).sort(), [creator.mainWallet, 'account:' + operator.id].sort());
  await f.service.observe(record);
  assert.equal(snapshots, 1); assert.equal(activity, 1);
  const coin = f.service.report().coins.find(row => row.mint === record.mint);
  assert.equal(coin.observedVolumeQuote, 5); assert.equal(coin.observedVolumeUsd, 10); assert.equal(coin.source, 'Pump.fun onchain trades');
  const analytics = await f.service.readPublic();
  assert.equal(analytics.launches.total, 2); assert.equal(analytics.launches.uniqueDevelopers, 2);
  f.service.close();
});

test('reporting covers more than 1,000 accounts up to the registry ceiling', async () => {
  const f = fixture(), launches = [f.add(launch()), f.add(launch())];
  for (let i = 0; i < 1500; i++) f.users.push({ id: i.toString(16).padStart(32, '0'), role: 'user', authType: 'wallet' });
  await f.service.inventory();
  assert.equal(f.service.inventoryComplete, true); assert.equal(f.service.records.length, launches.length);
  assert.equal((await f.service.readPublic()).volume.coverage.inventoryComplete, true);
  f.service.close();
  const over = fixture(); for (let i = 0; i < 10001; i++) over.users.push({ id: i.toString(16).padStart(32, '0'), role: 'user' });
  await assert.rejects(over.service.inventory(), /reporting scan limit/); over.service.close();
});
