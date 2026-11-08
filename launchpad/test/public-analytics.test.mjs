import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { PublicAnalytics, publicTreasuryAnalytics } from '../src/public-analytics.mjs';
import * as analyticsModule from '../src/public-analytics.mjs';
import { AdminVolume } from '../src/admin-volume.mjs';
import { ray } from '../src/launchpad-chain.mjs';
import { SOL_MINT } from '../public/launchpad-model.mjs';
import { LAUNCHPAD_TREASURY_MINT } from '../src/protocol-treasury.mjs';

const NOW = Date.UTC(2026, 8, 26, 18), address = () => Keypair.generate().publicKey.toBase58();
const sig = n => bs58.encode(Buffer.alloc(64, n));
function launch({ payer = address(), createdAt = NOW - 60000, confirmed = true } = {}) {
  const mint = address(), quote = SOL_MINT;
  return { state: 'live', authorizedAt: createdAt - 1, createdAt,
    input: { route: 'raydium', network: 'mainnet-beta', quoteMint: quote, name: 'HIDDEN_PRIVATE_NAME', symbol: 'SECRET_COIN', feeMode: 'creator' },
    curve: ray.getPdaLaunchpadPoolId(ray.LAUNCHPAD_PROGRAM, new PublicKey(mint), new PublicKey(quote)).publicKey.toBase58(),
    keys: { mint: { address: mint, secret: 'PRIVATE_MINT_KEY' }, payer: { address: payer }, wallet: { address: address(), secret: 'PRIVATE_KEY' } },
    moderation: { hidden: true }, listArchive: { archived: true },
    operations: confirmed ? [{ kind: 'create', state: 'confirmed', slot: 100, signature: sig(1), createdAt, confirmedAt: createdAt, raw: 'SIGNED_BYTES' }] : [], review: { quoteDecimals: 9 } };
}
function fixture({ rows = [], waitMs = 50, ...options } = {}) {
  let now = NOW, storeCalls = 0, marketCalls = 0;
  const users = [{ id: 'PRIVATE_USER', role: 'admin', mfaEnabled: true }], timers = new Map(); let timerId = 0;
  const books = new Map([['PRIVATE_USER', { launches: rows }]]);
  const accounts = { list: async () => users, get: async id => users.find(row => row.id === id),
    storeFor: id => ({ read: async () => { storeCalls++; return books.get(id); }, write: () => assert.fail('public report cannot write') }),
    hostStore: { read: async () => null, write: () => assert.fail('public report cannot write') } };
  const volume = new AdminVolume({ accounts, now: () => now, waitMs,
    activity: { read: async curve => { marketCalls++; return { at: now, poolId: curve, windows: { h24: { quote: 10, complete: true } } }; } },
    marketData: { pools: async (chain, mint) => ({ at: now, chain, tokenAddress: mint, pools: [] }) },
    marketSnapshot: async record => ({ at: now, slot: 10, status: 'curve', mint: record.keys.mint.address, curve: record.curve, quote: { mint: record.input.quoteMint, at: now, usd: 2 } }),
    setTimer: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; }, clearTimer: id => timers.delete(id), ...options });
  const service = new PublicAnalytics({ accounts, volume, now: () => now });
  return { accounts, users, books, volume, service, timers, get storeCalls() { return storeCalls; }, get marketCalls() { return marketCalls; }, get now() { return now; }, set now(value) { now = value; } };
}

function treasury() {
  const value = { version: 1, wallet: { address: address() }, updatedAt: NOW - 10000, curveDecimals: 6,
    totals: { buybackSpent: '2000000000', curveBought: '5000000', curveBurned: '3000000' },
    history: [{ kind: 'buy', state: 'confirmed', signature: sig(2), inputAmount: '2000000000', outputAmount: '5000000', confirmedAt: NOW - 20000 },
      { kind: 'burn', state: 'confirmed', signature: sig(3), inputAmount: '3000000', outputAmount: '0', confirmedAt: NOW - 10000 }] };
  Object.defineProperty(value.wallet, 'secret', { get() { assert.fail('must not access a signing key'); } });
  return value;
}

test('public totals deduplicate mints and original developers, keep UTC days and exclude private launch data', async () => {
  const payer = address(), a = launch({ payer }), b = launch({ payer, createdAt: NOW - 2 * 86400000 }), c = launch();
  c.state = 'draft'; c.curve = null; c.operations = [];
  const f = fixture({ rows: [a, structuredClone(a), b, c] });
  const result = await f.service.read();
  assert.equal(result.launches.total, 2); assert.equal(result.launches.last24h, 1);
  assert.equal(result.launches.uniqueDevelopers, 1); assert.equal(result.launches.uniqueDevelopers24h, 1);
  assert.equal(result.dailyLaunches.timezone, 'UTC'); assert.deepEqual(result.dailyLaunches.days.map(day=>day.date), ['2026-09-24','2026-09-25','2026-09-26']);
  assert.equal(result.dailyLaunches.days.at(-1).count, 1); assert.equal(result.dailyLaunches.days.at(-3).count, 1);
  assert.equal(result.volume.usd, 40); assert.equal(result.volume.lifetimeUsd, null); assert.equal(result.volume.asOf, NOW);
  assert.equal(result.treasury.status, 'unconfigured'); assert.equal(result.treasury.solSpent, null);
  const serialized = JSON.stringify(result);
  for (const forbidden of ['PRIVATE_', 'SECRET_COIN', 'SIGNED_BYTES', a.keys.mint.address, payer, a.curve, 'chainRecord']) assert(!serialized.includes(forbidden), forbidden);
  assert(!Object.hasOwn(result.volume, 'quoteTotals'));
  assert(!Object.hasOwn(result.volume, 'coins'));
  f.volume.close(); f.service.close();
});

test('daily analytics begins at the platform opening date and retains actual zero days before its first recorded launch',async()=>{
  const f=fixture({rows:[launch()]});
  try {
    const result=await f.service.read();
    assert.deepEqual(result.dailyLaunches.days,[{date:'2026-09-24',count:0,observedCount:0,venues:{raydium:0,meteora:0,'damm-pump':0,'pump-classic':0},observedVenues:{raydium:0,meteora:0,'damm-pump':0,'pump-classic':0}},{date:'2026-09-25',count:0,observedCount:0,venues:{raydium:0,meteora:0,'damm-pump':0,'pump-classic':0},observedVenues:{raydium:0,meteora:0,'damm-pump':0,'pump-classic':0}},{date:'2026-09-26',count:1,observedCount:1,venues:{raydium:1,meteora:0,'damm-pump':0,'pump-classic':0},observedVenues:{raydium:1,meteora:0,'damm-pump':0,'pump-classic':0}}]);
    assert.equal(result.dailyLaunches.complete,true);assert.equal(result.launches.total,1);assert.equal(result.launches.last24h,1);
  } finally { f.volume.close();f.service.close(); }
});

test('the daily date floor never turns incomplete source coverage into complete zeroes',async()=>{
  const f=fixture({rows:[launch()]});f.users.push({id:'unreadable'});
  try {
    const result=await f.service.read();assert.equal(result.dailyLaunches.complete,false);
    assert.deepEqual(result.dailyLaunches.days,[{date:'2026-09-24',count:null,observedCount:0,venues:null,observedVenues:{raydium:0,meteora:0,'damm-pump':0,'pump-classic':0}},{date:'2026-09-25',count:null,observedCount:0,venues:null,observedVenues:{raydium:0,meteora:0,'damm-pump':0,'pump-classic':0}},{date:'2026-09-26',count:null,observedCount:1,venues:null,observedVenues:{raydium:1,meteora:0,'damm-pump':0,'pump-classic':0}}]);
    assert.equal(result.launches.total,null);assert.equal(result.launches.observedTotal,1);assert.equal(result.launches.last24h,null);assert.equal(result.launches.observedLast24h,1);
  } finally { f.volume.close();f.service.close(); }
});

test('daily analytics respects the UTC opening boundary and retains a rolling maximum of thirty days',async()=>{
  for(const [now,expectedFirst,expectedLast,length] of [
    [Date.UTC(2026,8,23,23,59,59),undefined,undefined,0],
    [Date.UTC(2026,8,24), '2026-09-24','2026-09-24',1],
    [Date.UTC(2026,8,24,23,59,59), '2026-09-24','2026-09-24',1],
    [Date.UTC(2026,8,25), '2026-09-24','2026-09-25',2],
    [Date.UTC(2026,9,24), '2026-09-25','2026-10-24',30],
  ]){
    const f=fixture();f.now=now;
    try {
      const result=await f.service.read(),days=result.dailyLaunches.days;assert.equal(days.length,length);assert.equal(days[0]?.date,expectedFirst);assert.equal(days.at(-1)?.date,expectedLast);assert(days.every(day=>day.date>='2026-09-24'&&day.count===0));
    } finally { f.volume.close();f.service.close(); }
  }
});

test('old live/paused launches missing confirmed creation history are partial, never complete zeros', async () => {
  for (const state of ['live', 'paused']) {
    const coin = launch({ confirmed: false }); coin.state = state;
    const f = fixture({ rows: [coin] }), result = await f.service.read();
    assert.equal(result.launches.total, null); assert.equal(result.launches.observedTotal, 0); assert.equal(result.launches.complete, false);
    assert(result.dailyLaunches.days.every(row => row.count === null));
    assert.equal(result.volume.coverage.launches, 1); assert.equal(result.volume.usd, 20);
    f.volume.close();
  }
});

test('public counts and volume distinguish missing account coverage from no launches', async () => {
  const f = fixture({ rows: [launch()] }); f.users.push({ id: 'unreadable' });
  const result = await f.service.read();
  assert.equal(result.launches.total, null); assert.equal(result.launches.observedTotal, 1);
  assert.equal(result.volume.usd, null); assert.equal(result.volume.observedUsd, 20);
  assert.equal(result.dailyLaunches.days.at(-1).count, null); assert.equal(result.dailyLaunches.days.at(-1).observedCount, 1);
  f.volume.close();
  const empty = fixture(), noLaunches = await empty.service.read();
  assert.equal(noLaunches.launches.total, 0); assert.equal(noLaunches.volume.usd, 0); empty.volume.close();
});

test('all visitors share one cached report and existing bounded admin market scan', async () => {
  const f = fixture({ rows: Array.from({ length: 15 }, () => launch()) });
  const reports = await Promise.all(Array.from({ length: 30 }, () => f.service.read()));
  assert.equal(f.storeCalls, 1); assert.equal(f.marketCalls, 6);
  assert.equal(reports[0].launches.total, 15); assert.equal(reports[0].volume.coverage.unavailable, 9);
  reports[0].launches.total = 9000; assert.equal((await f.service.read()).launches.total, 15);
  await f.volume.read('PRIVATE_USER'); assert.equal(f.marketCalls, 6); assert.equal(f.storeCalls, 1);
  f.now += 60000; await f.service.read(); assert.equal(f.marketCalls, 12); assert.equal(f.storeCalls, 2);
  f.volume.close();
});

test('public interest survives denied admin recheck and expires independently', async () => {
  const f = fixture({ rows: [launch()] }); await f.service.read();
  let checks = 0; f.accounts.get = async () => (++checks === 1 ? { role: 'admin', mfaEnabled: true } : { role: 'user' });
  await assert.rejects(f.volume.read('PRIVATE_USER'), error => error.statusCode === 403);
  assert.equal(f.volume.lastAdminPoll, null); assert.equal(f.volume.active(), true); assert.equal(f.timers.size, 1);
  f.now += 120000; assert.equal(f.volume.active(), false); f.volume.close(); assert.equal(f.timers.size, 0);
});

test('hard source failures are globally cached and never publish provider errors or fake zeros', async () => {
  const f = fixture(); f.accounts.list = async () => { throw Error('https://private.rpc/?api-key=SECRET'); };
  f.accounts.hostStore.read = async () => { throw Error('TREASURY_SECRET'); };
  const result = await f.service.read();
  assert.equal(result.launches.total, null); assert.equal(result.volume.observedUsd, null); assert.equal(result.treasury.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private.rpc|api-key/);
  const at = result.generatedAt; f.now += 1000; assert.equal((await f.service.read()).generatedAt, at);
  f.volume.close();
});

test('reward journal CPU budget fails closed and does not expose truncated counts as complete', async () => {
  const f = fixture({ rows: [launch()], maxOperations: 0 });
  const result = await f.service.read(); assert.equal(result.launches.total, null); assert.equal(result.volume.usd, null); f.volume.close();
});

test('treasury projection reads no keys and exposes only confirmed cumulative totals and recent public receipts', () => {
  const state = treasury(); state.pending = { raw: 'PRIVATE_SIGNED_BYTES', signature: sig(4), inputAmount: '99' }; state.operatorId = 'PRIVATE_ADMIN'; state.error = 'SECRET_RPC';
  state.history.push({ kind: 'convert', state: 'confirmed', signature: sig(5), inputAmount: '1', outputAmount: '1', confirmedAt: NOW },
    { kind: 'buy', state: 'pending', signature: sig(6), inputAmount: '99', outputAmount: '99', confirmedAt: NOW });
  const result = publicTreasuryAnalytics(state, NOW);
  assert.equal(result.status, 'available'); assert.equal(result.solSpent, '2000000000'); assert.equal(result.curveBurned, '3000000'); assert.equal(result.curveDecimals, 6);
  assert.equal(result.history.length, 2); assert.equal(result.history[0].kind, 'burn'); assert.equal(result.history[0].inputAmount, '3000000');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET|"wallet"|"pending"|"operatorId"|"error"/);
});

test('treasury corrupt amounts, future dates, conflicting signatures and unknown precision never become invented totals', () => {
  for (const mutate of [s => { s.totals.curveBurned = '6000000'; }, s => { s.totals.buybackSpent = '-2'; },
    s => { s.totals.buybackSpent = '1'.repeat(1000); }, s => { s.updatedAt = NOW + 6000; }, s => { s.version = 2; },
    s => { s.history.push({ ...s.history[0], outputAmount: '4' }); }, s => { s.totals.curveBurned = '1'; },
    s => { s.history.push({ ...s.history[0], signature: sig(9) }); }]) {
    const s = treasury(); mutate(s); const result = publicTreasuryAnalytics(s, NOW); assert.equal(result.status, 'unavailable'); assert.equal(result.solSpent, null); assert.deepEqual(result.history, []);
  }
  const state = treasury(); delete state.curveDecimals; const result = publicTreasuryAnalytics(state, NOW);
  assert.equal(result.solSpent, '2000000000'); assert.equal(result.curveBought, null); assert.equal(result.curveBurned, null); assert.equal(result.curveDecimals, null);
});

test('same confirmed receipt is listed once and failed transactions never enter cumulative figures', () => {
  const state = treasury(); state.history.push({ ...state.history[0] }, { kind: 'burn', state: 'failed', signature: sig(7), inputAmount: '1', outputAmount: '0', confirmedAt: NOW });
  const result = publicTreasuryAnalytics(state, NOW); assert.equal(result.history.length, 2); assert.equal(result.curveBurned, '3000000');
});

test('closing while report is pending prevents a response and later requests', async () => {
  let resolve; const service = new PublicAnalytics({ volume: { readPublic: () => new Promise(r => { resolve = r; }) }, accounts: { hostStore: { read: async () => null } } });
  const pending = service.read(); await new Promise(r => setImmediate(r)); service.close(); resolve({});
  await assert.rejects(pending, /restarting/); await assert.rejects(service.read(), /restarting/);
});

test('lifetime and revenue receive refreshed cached prices and share one public report for concurrent visitors', async () => {
  const order = [], prices = new Map();
  const service = new PublicAnalytics({ now: () => NOW,
    accounts: { hostStore: { read: async () => null } },
    volume: { readPublic: async () => { await Promise.resolve(); prices.set(SOL_MINT, { usd: 123, at: NOW }); order.push('market'); return { launches: {}, volume: {} }; }, quotePrices: () => prices,
      tokenPrice(mint) { assert.equal(this.quotePrices(), prices); return prices.get(mint); } },
    lifetime: { readPublic: ({ pricesByMint }) => { order.push('lifetime'); return { recordedVolumeUsdEstimate: pricesByMint.get(SOL_MINT).usd * 2 }; } },
    revenue: { readPublic: ({ pricesByMint, tokenPrice }) => { order.push('revenue'); assert.equal(tokenPrice(SOL_MINT).usd, 123); return {totalUsdEstimate:pricesByMint.get(SOL_MINT).usd * 3}; } },
  });
  const reports = await Promise.all(Array.from({length:20}, () => service.read()));
  assert.equal(reports[0].lifetime.recordedVolumeUsdEstimate, 246); assert.equal(reports[0].revenue.totalUsdEstimate, 369);
  reports[0].revenue.totalUsdEstimate = -1; assert.equal((await service.read()).revenue.totalUsdEstimate, 369);
  assert.deepEqual(order, ['market', 'lifetime', 'revenue']); service.close();
});

test('a failed revenue projection leaves other public metrics available without private errors or false zeroes', async () => {
  const service = new PublicAnalytics({ now: () => NOW,
    accounts: { hostStore: { read: async () => null } },
    volume: { readPublic: async () => ({launches:{total:4},volume:{usd:12}}) },
    revenue: { readPublic: () => { throw Error('SECRET_RPC_TOKEN'); } },
  });
  const report = await service.read();
  assert.equal(report.launches.total, 4); assert.equal(report.volume.usd, 12);
  assert.equal(report.revenue.status, 'unavailable'); assert.equal(report.revenue.totalUsdEstimate, null); assert.equal(report.revenue.pricedUsdEstimate, null);
  assert.doesNotMatch(JSON.stringify(report), /SECRET/); service.close();
});

test('onchain burn total updates independently of cached receipt totals without market fanout', async () => {
  const f=fixture(); let observed={status:'available',mint:LAUNCHPAD_TREASURY_MINT,decimals:6,originalSupply:'1000000000000000',currentSupply:'814000000000000',totalBurned:'186000000000000',burnedPercent:'18.60',slot:452000000,at:NOW,commitment:'finalized',source:'finalized-mint-supply'};
  f.service.burnSupply={readPublic:()=>structuredClone(observed)};
  try {
    const first=await f.service.read(),receipts=structuredClone(first.burns),reads=f.storeCalls;
    assert.equal(first.burnSupply.totalBurned,'186000000000000');
    observed={...observed,status:'stale'};
    const second=await f.service.read();
    assert.equal(second.burnSupply.status,'stale');assert.deepEqual(second.burns,receipts);assert.equal(f.storeCalls,reads);
    assert.deepEqual(second.treasury,first.treasury);
    second.burnSupply.totalBurned='0';assert.equal((await f.service.read()).burnSupply.totalBurned,'186000000000000');
  } finally { f.volume.close();f.service.close(); }
});

test('unavailable mint supply never falls back to receipts as onchain supply', async () => {
  const f=fixture();f.service.burnSupply={readPublic(){throw Error('Unavailable');}};
  try {const result=await f.service.read();assert.equal(result.burnSupply,null);assert(result.burns);assert(result.treasury);}
  finally {f.volume.close();f.service.close();}
});

test('a failed inventory refresh keeps the last verified counts as labelled subtotals instead of blanking them', async () => {
  const f = fixture({ rows: [launch(), launch()] });
  try {
    const first = await f.volume.readPublic(); assert.equal(first.launches.total, 2); assert.equal(first.volume.usd, 40);
    f.accounts.list = async () => { throw Error('SECRET_STORE'); }; f.now += 31000;
    const second = await f.volume.readPublic();
    assert.equal(second.launches.total, null); assert.equal(second.launches.observedTotal, 2); assert.equal(second.dailyLaunches.complete, false);
    assert.equal(second.volume.usd, null); assert.equal(second.volume.complete, false); assert.equal(second.volume.coverage.inventoryComplete, false); assert.doesNotMatch(JSON.stringify(second), /SECRET/);
  } finally { f.volume.close(); }
});

test('an expired report is served briefly while a slow rebuild finishes; too old a report is never served', async () => {
  let now = NOW, release = null, calls = 0;
  const service = new PublicAnalytics({ now: () => now, staleWaitMs: 20, accounts: { hostStore: { read: async () => null } },
    volume: { readPublic: async () => { calls++; if (calls === 2) await new Promise(resolve => { release = resolve; }); return { launches: { total: calls }, volume: { usd: calls } }; } } });
  try {
    const first = await service.read(); assert.equal(first.launches.total, 1); assert.equal(first.refreshMs, 30000); assert.equal(first.servedAt, NOW);
    now += 60000; const stale = await service.read();
    assert.equal(stale.launches.total, 1); assert.equal(stale.generatedAt, NOW); assert.equal(stale.refreshMs, 10000); assert.equal(stale.servedAt, NOW + 60000);
    release(); const fresh = await service.read(); assert.equal(fresh.launches.total, 2); assert.equal(fresh.generatedAt, NOW + 60000);
    now += 400000; assert.equal((await service.read()).launches.total, 3);
  } finally { service.close(); }
});

test('a failed source reuses its last value with a short refresh instead of publishing dashes, within a bounded age', async () => {
  let now = NOW, fail = false;
  const service = new PublicAnalytics({ now: () => now, accounts: { hostStore: { read: async () => null } },
    volume: { readPublic: async () => { if (fail) throw Error('SECRET_PROVIDER'); return { launches: { total: 7, complete: true }, volume: { usd: 99, observedUsd: 99, refreshing: false } }; } },
    lifetime: { readPublic: () => { if (fail) throw Error('SECRET_LEDGER'); return { status: 'partial', recordedVolumeUsdEstimate: 1234 }; } } });
  try {
    assert.equal((await service.read()).refreshMs, 30000);
    fail = true; now += 60000; const second = await service.read();
    assert.equal(second.launches.total, 7); assert.equal(second.volume.usd, 99); assert.equal(second.volume.refreshing, true); assert.equal(second.lifetime.recordedVolumeUsdEstimate, 1234);
    assert.equal(second.refreshMs, 10000); assert.doesNotMatch(JSON.stringify(second), /SECRET/);
    now += 10000; fail = false; const third = await service.read(); assert.equal(third.refreshMs, 30000); assert.equal(third.volume.refreshing, false);
    // Past the reuse window the sections are unavailable (never reused
    // indefinitely); an ongoing outage keeps the normal polling interval.
    fail = true; now += 400000; const fourth = await service.read(); assert.equal(fourth.launches.total, null); assert.equal(fourth.lifetime, null); assert.equal(fourth.refreshMs, 30000);
  } finally { service.close(); }
});

test('a warming lifetime ledger asks visitors to return sooner than the normal interval', async () => {
  let status = 'loading';
  const service = new PublicAnalytics({ now: () => NOW, accounts: { hostStore: { read: async () => null } }, volume: { readPublic: async () => ({ launches: {}, volume: { observedUsd: 1 } }) }, lifetime: { readPublic: () => ({ status }) } });
  try { assert.equal((await service.read()).refreshMs, 10000); status = 'partial'; service.invalidate(); assert.equal((await service.read()).refreshMs, 30000); }
  finally { service.close(); }
});

test('a report retired by invalidate() during the stale wait is never served; a failed rebuild keeps serving the previous report briefly', async () => {
  let now = NOW, release = null, calls = 0, failBuild = false;
  const service = new PublicAnalytics({ now: () => now, staleWaitMs: 20, accounts: { hostStore: { read: async () => null } },
    volume: { readPublic: async () => { calls++; if (calls === 2) await new Promise(resolve => { release = resolve; }); return { launches: { total: calls }, volume: { usd: calls } }; } } });
  const build = service.build.bind(service); service.build = () => failBuild ? Promise.reject(Error('SECRET_REBUILD')) : build();
  try {
    assert.equal((await service.read()).launches.total, 1);
    now += 60000; const reading = service.read(); service.invalidate();
    const current = await reading; assert.equal(current.launches.total, 3); assert.equal(current.generatedAt, now);
    release(); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal((await service.read()).launches.total, 3);
    failBuild = true; now += 60000;
    const kept = await service.read(); assert.equal(kept.launches.total, 3); assert.equal(kept.generatedAt, now - 60000); assert.equal(kept.refreshMs, 10000);
    now += 300000; await assert.rejects(service.read(), /SECRET_REBUILD/);
  } finally { service.close(); }
});

test('a failed source is reused only while it is younger than the visitors\' two-minute freshness label', async () => {
  let now = NOW, fail = false;
  const service = new PublicAnalytics({ now: () => now, accounts: { hostStore: { read: async () => null } },
    volume: { readPublic: async () => { if (fail) throw Error('SECRET_PROVIDER'); return { launches: { total: 7, complete: true }, volume: { usd: 99, observedUsd: 99, refreshing: false } }; } } });
  try {
    await service.read(); fail = true;
    now += 119000; assert.equal((await service.read()).launches.total, 7);
    now += 11000; const expired = await service.read(); assert.equal(expired.launches.total, null); assert.equal(expired.volume.usd, null); assert.equal(expired.refreshMs, 30000);
  } finally { service.close(); }
});

// The public page charts buybacks and burns by day. The series must count each
// receipt once across every source, never invent activity outside the window,
// and stay a labelled subtotal while any source is incomplete.
test('receipt daily series deduplicates receipts across sources, buckets by UTC day and stays bounded to the window', () => {
  const { receiptDailySeries } = analyticsModule;
  const day = n => NOW - n * 86400000;
  const buy = { kind: 'buy', signature: sig(11), inputAmount: '1000000000', outputAmount: '500000', confirmedAt: day(1), state: 'confirmed' };
  const burn = { kind: 'burn', signature: sig(12), inputAmount: '400000', outputAmount: '0', confirmedAt: day(1) + 60000, state: 'confirmed' };
  const old = { kind: 'burn', signature: sig(13), inputAmount: '7', outputAmount: '0', confirmedAt: day(40), state: 'confirmed' };
  const future = { kind: 'buy', signature: sig(14), inputAmount: '9', outputAmount: '9', confirmedAt: NOW + 60000, state: 'confirmed' };
  const direct = { kind: 'burn', source: 'direct', signature: sig(15), inputAmount: '250000', outputAmount: '0', confirmedAt: day(3) };
  const imported = { kind: 'burn', source: 'admin', signature: sig(16), inputAmount: '100000', outputAmount: '0', confirmedAt: day(3) + 1000 };
  const treasury = { status: 'available', complete: true, managedStatus: 'available', history: [buy, burn, { kind: 'buy', signature: 'javascript:bad', inputAmount: '1', outputAmount: '1', confirmedAt: day(2) }] };
  const burns = { status: 'available', complete: true, history: [burn, direct] };
  const series = receiptDailySeries({ treasury, burns, direct: { status: 'available', complete: true, history: [direct] }, knownTreasuryReceipts: [buy, burn, old, future, { ...burn, state: 'pending' }], imported: { status: 'available', complete: true, history: [imported, { ...imported }] }, now: NOW });
  assert.equal(series.timezone, 'UTC'); assert.equal(series.complete, true); assert.equal(series.days, 30);
  assert.deepEqual(series.rows, [
    { date: new Date(day(3)).toISOString().slice(0, 10), solSpent: '0', curveBurned: '350000', buys: 0, burns: 2 },
    { date: new Date(day(1)).toISOString().slice(0, 10), solSpent: '1000000000', curveBurned: '400000', buys: 1, burns: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(series), /javascript|pending|signature/);
  // Partial or unavailable sources keep the days they can prove, as a subtotal.
  const partial = receiptDailySeries({ treasury: { ...treasury, status: 'partial', complete: false, amountsAreSubtotals: true }, burns: { ...burns, status: 'partial', complete: false }, direct: { status: 'partial', complete: false, history: [direct] }, knownTreasuryReceipts: [buy, burn], imported: { status: 'unavailable', complete: false, history: [] }, now: NOW });
  assert.equal(partial.complete, false); assert.equal(partial.rows.length, 2);
  const unavailable = receiptDailySeries({ treasury: { status: 'unavailable', history: [buy] }, burns: { status: 'unavailable', history: [burn] }, now: NOW });
  assert.deepEqual(unavailable.rows, []); assert.equal(unavailable.complete, false);
  const empty = receiptDailySeries({ treasury: { status: 'unconfigured', complete: false, history: [] }, burns: { status: 'available', complete: true, history: [] }, now: NOW });
  assert.deepEqual(empty.rows, []); assert.equal(empty.complete, true);
});

test('the public report carries the daily receipt series next to totals and keeps it harmless when it cannot be built', async () => {
  const f = fixture(); f.accounts.hostStore.read = async () => treasury();
  try {
    const result = await f.service.read(), expectedDay = new Date(NOW - 10000).toISOString().slice(0, 10);
    assert.equal(result.treasury.solSpent, '2000000000');
    assert.deepEqual(result.burns.daily.rows, [{ date: expectedDay, solSpent: '2000000000', curveBurned: '3000000', buys: 1, burns: 1 }]);
    assert.equal(result.burns.daily.timezone, 'UTC'); assert.equal(typeof result.burns.daily.complete, 'boolean');
    assert.doesNotMatch(JSON.stringify(result.burns.daily), /PRIVATE|SECRET|wallet/);
  } finally { f.volume.close(); f.service.close(); }
});
