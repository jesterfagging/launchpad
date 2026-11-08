import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { PersistentLifetimeVolume } from '../src/public-lifetime-volume.mjs';

const key = n => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const NOW = Date.parse('2026-09-26T18:00:00Z'), POOL = key(1), MINT = key(2), QUOTE = key(3), OWNER = key(4);
const record = { curve: POOL, mint: MINT, quote: { mint: QUOTE, symbol: 'QUOTE' }, createdAt: NOW - 10 * 86_400_000 };
const trade = (n, { quote = 0.1, time = Math.floor(NOW / 1000) - n, poolId = POOL, ...rest } = {}) => ({
  poolId, txid: '2'.repeat(64) + String.fromCharCode(65 + n % 8) + '123456789ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(n / 8) % 32],
  blockTime: time, side: n % 2 ? 'buy' : 'sell', amountA: n + 1, amountB: quote, owner: OWNER, ...rest,
});
const result = (rows, nextPageKey = null) => new Response(JSON.stringify({ success: true, data: { rows, nextPageKey } }), { status: 200, headers: { 'content-type': 'application/json' } });
function fixture({ pages, saved, ...options } = {}) {
  let at = NOW, state = saved ? structuredClone(saved) : undefined, writes = 0, requests = [], failWrites = 0;
  const store = { async read(name, fallback) { assert.equal(name, 'public-lifetime-volume'); return structuredClone(state ?? fallback); },
    async write(name, next) { assert.equal(name, 'public-lifetime-volume'); writes++; if (failWrites-- > 0) throw Error('disk'); state = structuredClone(next); } };
  const create = extra => new PersistentLifetimeVolume({ store, now: () => at,
    inventory: async () => ({ records: [record], complete: true }), quotePrices: async () => new Map([[QUOTE, { usd: 2, at }]]),
    fetcher: async (url, init) => { requests.push({ url, init }); const cursor = new URL(url).searchParams.get('nextPageKey'); return pages ? pages(cursor, requests.length) : result([trade(1), trade(2)]); }, ...options, ...extra });
  return { create, get state() { return structuredClone(state); }, get requests() { return requests; }, get writes() { return writes; },
    failWrites(n) { failWrites = n; }, advance(ms = 30_000) { at += ms; }, get now() { return at; } };
}

test('backfills all historical pages, decimal totals and daily buckets, never overlapping 24h windows', async () => {
  const old = NOW / 1000 - 5 * 86_400;
  const f = fixture({ pages: cursor => cursor ? result([trade(3, { time: old, quote: 0.2 })]) : result([trade(1), trade(2)], 'older') });
  const reader = f.create(); await reader.tick();
  assert.equal(reader.readPublic().recordedVolumeUsdEstimate, 0.4);
  assert.equal(reader.readPublic().coverage.historyComplete, false);
  f.advance(); await reader.tick(); // Recent scan sees the already durable head.
  f.advance(); await reader.tick(); // Backfill resumes exactly where saved.
  const report = reader.readPublic();
  assert.equal(report.tradeCount, 3); assert.equal(report.quoteTotals[0].amount, 0.4);
  assert.equal(report.recordedVolumeUsdEstimate, 0.8); assert.equal(report.daily.length, 2);
  assert.equal(report.coverage.historyComplete, true); assert.equal(report.coverage.postGraduationIncluded, false);
  assert.equal(new URL(f.requests.at(-1).url).searchParams.get('nextPageKey'), 'older');
  assert.equal(f.state.pools[POOL].totalAtoms, '400000000000000000'); reader.close();
});

test('restart resumes cursor and deduplicates overlapping pages and duplicate events', async () => {
  const f = fixture({ pages: cursor => cursor ? result([trade(2), trade(3)]) : result([trade(1), trade(2), trade(2)], 'next') });
  const first = f.create(); await first.tick(); first.close();
  const second = f.create(); await second.tick(); f.advance(); await second.tick();
  assert.equal(second.readPublic().tradeCount, 3); assert.equal(second.readPublic().quoteTotals[0].amount, 0.3);
  f.advance(); await second.tick(); assert.equal(second.readPublic().tradeCount, 3); second.close();
});

test('failed atomic write never publishes unsaved volume or advances the cursor', async () => {
  const f = fixture(); f.failWrites(2); const reader = f.create(); await reader.tick();
  assert.equal(reader.readPublic().tradeCount, 0); assert.equal(f.state, undefined);
  f.advance(); await reader.tick(); assert.equal(reader.readPublic().tradeCount, 2);
  reader.close(); const restarted = f.create(); await restarted.tick(); assert.equal(restarted.readPublic().tradeCount, 2); restarted.close();
});

test('cache reads are pure and visitor count never starts scans or writes', async () => {
  const f = fixture(), reader = f.create();
  for (let i = 0; i < 100; i++) reader.readPublic();
  assert.equal(f.requests.length, 0); assert.equal(f.writes, 0);
  await Promise.all(Array.from({ length: 20 }, () => reader.tick()));
  assert.equal(f.requests.length, 1);
  for (let i = 0; i < 100; i++) reader.readPublic();
  assert.equal(f.requests.length, 1); assert.equal(f.writes, 1); reader.close();
});

test('incomplete inventory and unavailable quote prices retain useful native lifetime totals', async () => {
  const f = fixture({ inventory: async () => ({ records: [record], complete: false }), quotePrices: async () => new Map() });
  const reader = f.create(); await reader.tick(); const report = reader.readPublic();
  assert.equal(report.recordedVolumeUsdEstimate, null); assert.equal(report.pricedVolumeUsdEstimate, null);
  assert.equal(report.quoteTotals[0].amount, 0.2); assert.equal(report.coverage.unpricedQuotes, 1);
  assert.equal(report.coverage.inventoryComplete, false); assert.equal(report.status, 'partial');
  const publicText = JSON.stringify(report);
  for (const privateValue of [MINT, POOL, QUOTE, OWNER, trade(1).txid]) assert.ok(!publicText.includes(privateValue)); reader.close();
});

test('expired current prices cannot masquerade as live lifetime USD', async () => {
  const f = fixture(), reader = f.create(); await reader.tick(); assert.equal(reader.readPublic().recordedVolumeUsdEstimate, 0.4);
  f.advance(120_001); assert.equal(reader.readPublic().recordedVolumeUsdEstimate, null);
  assert.equal(reader.readPublic().quoteTotals[0].amount, 0.2); reader.close();
});

test('finished historical backfill remains a subtotal after its recent head expires, even with fresh prices', async () => {
  const f = fixture(), reader = f.create(); await reader.tick();
  assert.equal(reader.readPublic().coverage.historyComplete, true);
  f.advance(120001);
  const stale = reader.readPublic({ pricesByMint: new Map([[QUOTE, { usd: 2, at: f.now }]]) });
  assert.equal(stale.recordedVolumeUsdEstimate, 0.4);
  assert.equal(stale.coverage.backfillComplete, true);
  assert.equal(stale.coverage.historyComplete, false);
  assert.equal(stale.coverage.headFreshLaunches, 0);
  assert.equal(stale.coverage.oldestHeadAt, NOW);
  assert.equal(stale.coverage.headFreshnessMaxAgeMs, 120000);
  assert.equal(stale.last24h.historyComplete, false); assert.equal(stale.status, 'partial');
  await reader.tick();
  const caughtUp = reader.readPublic();
  assert.equal(caughtUp.coverage.headFreshLaunches, 1);
  assert.equal(caughtUp.coverage.historyComplete, true);
  assert.equal(caughtUp.recordedVolumeUsdEstimate, 0.4); reader.close();
});

test('refreshing one market never hides an older unsynced market in lifetime coverage', async () => {
  const records = [record, { ...record, curve: key(7), mint: key(8) }];
  const f = fixture({ maxPages: 1, inventory: async () => ({ records, complete: true }), pages: () => result([]) });
  const reader = f.create(); await reader.tick(); f.advance(); await reader.tick(); f.advance(90001);
  const report = reader.readPublic({ pricesByMint: new Map([[QUOTE, { usd: 2, at: f.now }]]) });
  assert.equal(report.coverage.backfilledLaunches, 2);
  assert.equal(report.coverage.backfillComplete, true);
  assert.equal(report.coverage.headFreshLaunches, 1);
  assert.equal(report.coverage.oldestHeadAt, NOW);
  assert.equal(report.updatedAt, NOW + 30000);
  assert.equal(report.coverage.historyComplete, false); assert.equal(report.status, 'partial'); reader.close();
});

test('empty confirmed inventory reports zero; unloaded/unavailable inventory is not zero', async () => {
  const f = fixture({ inventory: async () => ({ records: [], complete: true }) }), reader = f.create();
  assert.equal(reader.readPublic().recordedVolumeUsdEstimate, null); await reader.tick();
  assert.equal(reader.readPublic().recordedVolumeUsdEstimate, 0); assert.equal(f.requests.length, 0); reader.close();
  const broken = f.create({ inventory: async () => { throw Error('store failed'); } }); await broken.tick();
  assert.equal(broken.readPublic().recordedVolumeUsdEstimate, null); broken.close();
});

test('malformed saved ledger fails closed without resetting or overwriting it', async () => {
  const saved = { version: 99, pools: {}, at: NOW }, f = fixture({ saved }), reader = f.create();
  await reader.tick(); assert.equal(f.writes, 0); assert.equal(f.requests.length, 0);
  assert.deepEqual(f.state, saved); assert.equal(reader.readPublic().recordedVolumeUsdEstimate, null); reader.close();
});

test('stored totals and bucket tampering are detected by the durable event journal', async () => {
  const f = fixture(), first = f.create(); await first.tick(); first.close(); const saved = f.state;
  saved.pools[POOL].totalAtoms = '900000000000000000';
  const secondFixture = fixture({ saved }), second = secondFixture.create(); await second.tick();
  assert.equal(secondFixture.writes, 0); assert.equal(second.readPublic().tradeCount, 0); second.close();
});

for (const [name, modify] of Object.entries({
  wrongPool: row => ({ ...row, poolId: key(9) }), negative: row => ({ ...row, amountB: -1 }),
  future: row => ({ ...row, blockTime: NOW / 1000 + 61 }), signature: row => ({ ...row, txid: '<script>' }),
  owner: row => ({ ...row, owner: '__proto__' }), finePrecision: row => ({ ...row, amountB: 1e-19 }),
})) test(`rejects ${name} without counting a partial page`, async () => {
  const f = fixture({ pages: () => result([trade(1), modify(trade(2))]) }), reader = f.create(); await reader.tick();
  assert.equal(reader.readPublic().tradeCount, 0); assert.equal(reader.readPublic().coverage.historyComplete, false); reader.close();
});

test('cursor loops fail closed but keep already durable subtotal', async () => {
  const f = fixture({ pages: cursor => cursor ? result([trade(3)], 'repeat') : result([trade(1)], 'repeat') }), reader = f.create();
  await reader.tick(); f.advance(); await reader.tick(); f.advance(); await reader.tick();
  assert.equal(reader.readPublic().tradeCount, 1); assert.equal(reader.readPublic().coverage.historyComplete, false); reader.close();
});

test('full page with missing cursor is incomplete, never inferred as all lifetime history', async () => {
  const f = fixture({ pages: () => result(Array.from({ length: 100 }, (_, index) => trade(index + 1))) }), reader = f.create();
  await reader.tick(); assert.equal(reader.readPublic().tradeCount, 100);
  assert.equal(reader.readPublic().coverage.historyComplete, false); reader.close();
});

test('short or empty page with cursor continues instead of stopping history early', async () => {
  const f = fixture({ pages: cursor => cursor ? result([trade(1)]) : result([], 'next') }), reader = f.create();
  await reader.tick(); assert.equal(reader.readPublic().coverage.historyComplete, false);
  f.advance(); await reader.tick(); f.advance(); await reader.tick();
  assert.equal(reader.readPublic().tradeCount, 1); assert.equal(reader.readPublic().coverage.backfillComplete, true);
  assert.equal(reader.readPublic().coverage.historyComplete, false);
  f.advance(); await reader.tick(); assert.equal(reader.readPublic().coverage.historyComplete, true); reader.close();
});

test('event capacity preserves prior counters and keys without double-counting or false completion', async () => {
  const f = fixture({ maxEvents: 2, pages: cursor => cursor ? result([trade(3)]) : result([trade(1), trade(2)], 'next') }), reader = f.create();
  await reader.tick(); f.advance(); await reader.tick(); f.advance(); await reader.tick();
  assert.equal(reader.readPublic().tradeCount, 2); assert.equal(f.state.pools[POOL].problem, 'capacity');
  assert.equal(reader.readPublic().coverage.historyComplete, false); reader.close();
});

test('fixed endpoint and encoded cursors prevent provider-controlled requests', async () => {
  const cursor = 'https://evil.invalid/?secret=1&poolId=other', f = fixture({ pages: value => value ? result([trade(2)]) : result([trade(1)], cursor) });
  const reader = f.create(); await reader.tick(); f.advance(); await reader.tick(); f.advance(); await reader.tick();
  for (const request of f.requests) { const url = new URL(request.url); assert.equal(url.origin, 'https://launch-history-v1.raydium.io'); assert.equal(url.searchParams.get('poolId'), POOL); assert.equal(request.init.redirect, 'error'); }
  assert.equal(new URL(f.requests.at(-1).url).searchParams.get('nextPageKey'), cursor); reader.close();
});

test('network errors back off and automatically retry without manual operator action', async () => {
  let calls = 0;
  const f = fixture({ pages: () => { if (++calls === 1) throw Error('transient RPC secret'); return result([trade(1)]); } });
  const reader = f.create(); await reader.tick(); assert.equal(reader.readPublic().tradeCount, 0);
  assert.equal(reader.readPublic().recordedVolumeUsdEstimate, null);
  await reader.tick(); assert.equal(calls, 1); f.advance(); await reader.tick();
  assert.equal(reader.readPublic().tradeCount, 1); assert.ok(!JSON.stringify(reader.readPublic()).includes('secret')); reader.close();
});

test('429 honors bounded cooldown instead of retrying once for every visitor', async () => {
  const f = fixture({ fetcher: async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }) }), reader = f.create();
  await reader.tick(); assert.equal(reader.retryUntil, NOW + 120_000);
  f.advance(); await reader.tick(); assert.equal(reader.requests.length, 1); reader.close();
});

test('global page budget bounds work regardless of launch inventory size', async () => {
  const records = Array.from({ length: 20 }, (_, index) => ({ ...record, curve: key(index + 10), mint: key(index + 60) }));
  let requests = 0;
  const f = fixture({ inventory: async () => ({ records, complete: true }), fetcher: async () => { requests++; return result([]); } });
  const reader = f.create(); await reader.tick(); assert.equal(requests, 6);
  f.advance(); await reader.tick(); assert.equal(requests, 12); assert.equal(reader.readPublic().coverage.launches, 20); reader.close();
});

test('removed or archived inventory never erases previously recorded lifetime volume', async () => {
  let records = [record]; const f = fixture({ inventory: async () => ({ records, complete: true }) }), reader = f.create();
  await reader.tick(); records = []; f.advance(); await reader.tick();
  assert.equal(reader.readPublic().tradeCount, 2); assert.equal(reader.readPublic().coverage.launches, 1); reader.close();
});

test('persisted daily totals and event keys survive a restart with no current prices', async () => {
  const f = fixture(), first = f.create(); await first.tick(); first.close();
  const second = f.create({ quotePrices: async () => new Map(), fetcher: async () => { throw Error('offline'); } });
  await second.tick(); const report = second.readPublic();
  assert.equal(report.tradeCount, 2); assert.equal(report.quoteTotals[0].amount, 0.2);
  assert.equal(report.daily[0].tradeCount, 2); assert.equal(report.recordedVolumeUsdEstimate, null); second.close();
});

test('current prices revalue the saved native total without incrementing traded volume', async () => {
  let price = 2;
  const f = fixture({ quotePrices: async () => new Map([[QUOTE, { usd: price, at: f.now }]]) }), reader = f.create();
  await reader.tick(); assert.equal(reader.readPublic().recordedVolumeUsdEstimate, 0.4);
  price = 3; f.advance(); await reader.tick(); assert.ok(Math.abs(reader.readPublic().recordedVolumeUsdEstimate - 0.6) < 1e-12);
  assert.equal(reader.readPublic().tradeCount, 2); assert.equal(reader.readPublic().quoteTotals[0].amount, 0.2); reader.close();
});

test('conflicting records never reinsert a pool after rejecting its identity', async () => {
  const f = fixture({ inventory: async () => ({ records: [record, { ...record, mint: key(9) }, record], complete: true }) }), reader = f.create();
  await reader.tick(); assert.equal(f.requests.length, 0); assert.equal(reader.readPublic().coverage.inventoryComplete, false); reader.close();
});

test('a fetcher ignoring abort is bounded by the worker deadline', async () => {
  const f = fixture({ timeoutMs: 5, fetcher: async () => new Promise(() => {}) }), reader = f.create();
  await reader.tick(); assert.equal(reader.readPublic().tradeCount, 0); assert.equal(reader.readPublic().recordedVolumeUsdEstimate, null); reader.close();
});

test('oversized provider payload does not store or count any part of the response', async () => {
  const f = fixture({ fetcher: async () => new Response('x'.repeat(256_001)) }), reader = f.create();
  await reader.tick(); assert.equal(reader.readPublic().tradeCount, 0); assert.equal(reader.readPublic().coverage.historyComplete, false); reader.close();
});

test('fresh head trades are added after backfill without recounting old swaps', async () => {
  let newer = false;
  const f = fixture({ pages: () => result(newer ? [trade(3, { time: NOW / 1000 + 20 }), trade(1), trade(2)] : [trade(1), trade(2)]) }), reader = f.create();
  await reader.tick(); assert.equal(reader.readPublic().tradeCount, 2);
  newer = true; f.advance(); await reader.tick(); assert.equal(reader.readPublic().tradeCount, 3);
  f.advance(); await reader.tick(); assert.equal(reader.readPublic().tradeCount, 3); reader.close();
});

test('current shared quote references value saved history immediately without rescanning trades', async () => {
  const f = fixture({ quotePrices: async () => new Map() }), reader = f.create(); await reader.tick();
  assert.equal(reader.readPublic().recordedVolumeUsdEstimate, null);
  const before = f.requests.length, pricesByMint = new Map([[QUOTE, { usd: 5, at: f.now }]]);
  assert.equal(reader.readPublic({ pricesByMint }).recordedVolumeUsdEstimate, 1);
  assert.equal(f.requests.length, before); assert.equal(reader.readPublic().recordedVolumeUsdEstimate, null);
  for (const invalid of [{ usd: 5, at: f.now, stale: true }, { usd: 5, at: f.now + 6000 }, { usd: 5, at: f.now - 120001 }, { mint: MINT, usd: 5, at: f.now }]) assert.equal(reader.readPublic({ pricesByMint: new Map([[QUOTE, invalid]]) }).recordedVolumeUsdEstimate, null);
  reader.close();
});

test('conflicting cached quote identity cannot price history or displace a valid exact-mint reference', async () => {
  const f = fixture({ quotePrices: async () => new Map([[QUOTE, { mint: MINT, usd: 99, at: NOW + 1000 }]]) });
  const reader = f.create(); await reader.tick();
  const invalid = reader.readPublic();
  assert.equal(invalid.recordedVolumeUsdEstimate, null);
  assert.equal(invalid.last24h.recordedVolumeUsdEstimate, null);
  const valid = reader.readPublic({ pricesByMint: new Map([[QUOTE, { mint: QUOTE, usd: 2, at: NOW }]]) });
  assert.equal(valid.recordedVolumeUsdEstimate, 0.4);
  assert.equal(valid.last24h.recordedVolumeUsdEstimate, 0.4); reader.close();
});
test('rolling 24h fallback uses exact saved trade timestamps and never overlaps daily or lifetime totals', async () => {
  const f = fixture({ pages: () => result([trade(1, { quote: 2, time: NOW / 1000 - 1 }), trade(2, { quote: 3, time: NOW / 1000 - 86400 }), trade(3, { quote: 7, time: NOW / 1000 - 86401 })]) });
  const reader = f.create(); await reader.tick(); const report = reader.readPublic();
  assert.equal(report.recordedVolumeUsdEstimate, 24); assert.equal(report.last24h.recordedVolumeUsdEstimate, 10);
  assert.equal(report.last24h.tradeCount, 2); assert.equal(report.last24h.historyComplete, true);
  assert.equal(report.last24h.scope, 'launch-curves'); assert.equal(report.last24h.postGraduationIncluded, false);
  assert.deepEqual(report.last24h.quoteTotals, [{ symbol: 'QUOTE', amount: 5, usdEstimate: 10, priced: true }]);
  assert.equal(report.quoteTotals[0].amount, 12);
  f.advance(1000); assert.equal(reader.readPublic().last24h.recordedVolumeUsdEstimate, 4); reader.close();
});
test('unpriced or stale history remains partial in the rolling 24h fallback', async () => {
  const f = fixture({ quotePrices: async () => new Map() }), reader = f.create(); await reader.tick();
  assert.equal(reader.readPublic().last24h.recordedVolumeUsdEstimate, null);
  assert.deepEqual(reader.readPublic().last24h.quoteTotals, [{ symbol: 'QUOTE', amount: 0.2, usdEstimate: null, priced: false }]);
  f.advance(120001); assert.equal(reader.readPublic().last24h.historyComplete, false); reader.close();
});

const dammRecord = { ...record, platform: 'damm-pump', quote: { ...record.quote, decimals: 9 } };
const chainTrade = (n, extra = {}) => ({
  eventId: n.toString(16).padStart(64, '0'), poolId: POOL, signature: trade(n).txid,
  wallet: OWNER, side: n % 2 ? 'buy' : 'sell', time: NOW / 1000 - n,
  amount: n + 1, baseRaw: String((n + 1) * 1000000), quote: n,
  quoteRaw: String(n * 1000000000), ...extra,
});
const chainSnapshot = (trades, extra = {}) => ({ source: 'damm-pump-onchain', poolId: POOL,
  trades, complete: true, historyComplete: true, recentComplete: true, at: NOW,
  postGraduationIncluded: true, ...extra });

test('PumpSwap chain history replaces legacy host receipts once and includes both verified venues', async () => {
  const rows = [chainTrade(1), chainTrade(2, { poolId: key(9) })];
  let response = { trades: [chainTrade(1)] };
  const f = fixture({ inventory: async () => ({ records: [dammRecord], complete: true }), dammPumpTrades: async () => response });
  const reader = f.create(); await reader.tick(); assert.equal(reader.readPublic().recordedVolumeUsdEstimate, 2);
  response = chainSnapshot(rows); f.advance(); await reader.tick();
  const report = reader.readPublic();
  assert.equal(report.tradeCount, 2); assert.equal(report.recordedVolumeUsdEstimate, 6);
  assert.equal(report.last24h.recordedVolumeUsdEstimate, 6); assert.equal(report.coverage.historyComplete, true);
  assert.equal(report.scope, 'launch-curves-and-pumpswap'); assert.equal(report.last24h.postGraduationIncluded, true);
  assert.equal(f.state.pools[POOL].source, 'damm-pump-onchain'); reader.close();
  const restarted = f.create(); await restarted.tick();
  assert.equal(restarted.readPublic().tradeCount, 2); assert.equal(restarted.readPublic().recordedVolumeUsdEstimate, 6); restarted.close();
});

test('full onchain snapshots deduplicate repeated events and reject missing or changed saved events', async () => {
  let response = chainSnapshot([chainTrade(1), chainTrade(1), chainTrade(2)]);
  const f = fixture({ inventory: async () => ({ records: [dammRecord], complete: true }), dammPumpTrades: async () => response });
  const reader = f.create(); await reader.tick(); assert.equal(reader.readPublic().tradeCount, 2);
  for (const rows of [[chainTrade(2)], [chainTrade(1, { quoteRaw: '99' }), chainTrade(2)]]) {
    response = chainSnapshot(rows); f.advance(); await reader.tick();
    assert.equal(reader.readPublic().recordedVolumeUsdEstimate, 6); assert.equal(reader.readPublic().coverage.historyComplete, false);
    assert.equal(f.state.pools[POOL].problem, 'history');
  }
  response = chainSnapshot([chainTrade(1), chainTrade(2), chainTrade(3)]); f.advance(); await reader.tick();
  assert.equal(reader.readPublic().recordedVolumeUsdEstimate, 12); assert.equal(reader.readPublic().tradeCount, 3); reader.close();
});

test('empty initial crawl and provider failure retain legacy volume, then host fallback cannot reenter chain history', async () => {
  let response = { trades: [chainTrade(1)] }, failed = false;
  const f = fixture({ inventory: async () => ({ records: [dammRecord], complete: true }), dammPumpTrades: async () => { if (failed) throw Error('RPC'); return response; } });
  const reader = f.create(); await reader.tick();
  response = chainSnapshot([], { complete: false, historyComplete: false, recentComplete: false, at: null });
  f.advance(); await reader.tick(); assert.equal(reader.readPublic().recordedVolumeUsdEstimate, 2); assert.equal(f.state.pools[POOL].source, undefined);
  failed = true; f.advance(); await reader.tick(); assert.equal(reader.readPublic().recordedVolumeUsdEstimate, 2);
  failed = false; response = chainSnapshot([chainTrade(1), chainTrade(2)]); f.advance(); await reader.tick();
  response = { trades: [chainTrade(1), chainTrade(2), chainTrade(3)] }; f.advance(); await reader.tick();
  assert.equal(reader.readPublic().recordedVolumeUsdEstimate, 6); assert.equal(reader.readPublic().tradeCount, 2); reader.close();
});

test('onchain backfill completion and head freshness are independently required for complete history', async () => {
  let response = chainSnapshot([chainTrade(1)], { complete: false, recentComplete: false, at: null });
  const f = fixture({ inventory: async () => ({ records: [dammRecord], complete: true }), dammPumpTrades: async () => response });
  const reader = f.create(); await reader.tick();
  assert.equal(reader.readPublic().coverage.backfillComplete, true); assert.equal(reader.readPublic().coverage.headFreshLaunches, 0);
  assert.equal(reader.readPublic().coverage.historyComplete, false);
  response = chainSnapshot([chainTrade(1)]); f.advance(); await reader.tick(); assert.equal(reader.readPublic().coverage.historyComplete, true);
  f.advance(120001); await reader.tick();
  assert.equal(reader.readPublic().coverage.historyComplete, false); assert.equal(reader.readPublic().recordedVolumeUsdEstimate, 2); reader.close();
});

test('onchain replacement requires valid full snapshot identity and consistent completeness metadata', async () => {
  for (const change of [{ poolId: key(8) }, { complete: false }, { at: NOW + 6000 }, { postGraduationIncluded: false }, { trades: [chainTrade(1, { eventId: 'bad' })] }, { trades: [chainTrade(1, { baseRaw: '0' })] }]) {
    const f = fixture({ inventory: async () => ({ records: [dammRecord], complete: true }), dammPumpTrades: async () => chainSnapshot([chainTrade(1)], change) });
    const reader = f.create(); await reader.tick(); assert.equal(reader.readPublic().tradeCount, 0); assert.equal(reader.readPublic().recordedVolumeUsdEstimate, null); reader.close();
  }
});

test('failed onchain replacement write preserves the prior durable legacy subtotal', async () => {
  let response = { trades: [chainTrade(1)] };
  const f = fixture({ inventory: async () => ({ records: [dammRecord], complete: true }), dammPumpTrades: async () => response });
  const reader = f.create(); await reader.tick(); response = chainSnapshot([chainTrade(1), chainTrade(2)]);
  f.failWrites(1); f.advance(); await reader.tick();
  assert.equal(reader.readPublic().recordedVolumeUsdEstimate, 2); assert.equal(f.state.pools[POOL].source, undefined);
  f.advance(); await reader.tick(); assert.equal(reader.readPublic().recordedVolumeUsdEstimate, 6); reader.close();
});

test('onchain raw decimals and trade timestamps feed the same USD lifetime and rolling day history', async () => {
  const alternate = { ...dammRecord, quote: { ...dammRecord.quote, decimals: 6 } };
  const rows = [chainTrade(1, { quoteRaw: '1234567', quote: 999, time: NOW / 1000 - 90000 }), chainTrade(2, { quoteRaw: '7654321', quote: 999 })];
  const f = fixture({ inventory: async () => ({ records: [alternate], complete: true }), dammPumpTrades: async () => chainSnapshot(rows) });
  const reader = f.create(); await reader.tick(); const report = reader.readPublic();
  assert.equal(report.quoteTotals[0].amount, 8.888888); assert.equal(report.last24h.quoteTotals[0].amount, 7.654321);
  assert.equal(report.recordedVolumeUsdEstimate, 17.777776); assert.equal(report.last24h.recordedVolumeUsdEstimate, 15.308642);
  assert.equal(report.last24h.tradeCount, 1); assert.equal(report.tradeCount, 2); reader.close();
});

test('bounded local PumpSwap snapshots refresh independently without starving remote history', async () => {
  const remote = Array.from({ length: 12 }, (_, n) => ({ ...record, curve: key(n + 10), mint: key(n + 30) }));
  const local = Array.from({ length: 7 }, (_, n) => ({ ...dammRecord, curve: key(n + 60), mint: key(n + 80) }));
  const remoteCalls = [], localCalls = [];
  const f = fixture({ inventory: async () => ({ records: [...remote, ...local], complete: true }),
    fetcher: async url => { remoteCalls.push(new URL(url).searchParams.get('poolId')); return result([]); },
    dammPumpTrades: async mint => { localCalls.push(mint); const row = local.find(r => r.mint === mint); return chainSnapshot([chainTrade(1, { poolId: row.curve })], { poolId: row.curve }); } });
  const reader = f.create(); await reader.tick();
  assert.equal(remoteCalls.length, 6); assert.equal(localCalls.length, 6);
  f.advance(); await reader.tick();
  assert.equal(remoteCalls.length, 12); assert.equal(new Set(remoteCalls).size, 12);
  assert.equal(localCalls.length, 12); assert.equal(new Set(localCalls).size, 7);
  assert.equal(reader.readPublic().tradeCount, 7); reader.close();
});

test('remote provider cooldown cannot suppress a newly saved PumpSwap trade', async () => {
  let remoteCalls = 0, localCalls = 0;
  const local = { ...dammRecord, curve: key(8), mint: key(9) };
  const f = fixture({ inventory: async () => ({ records: [record, local], complete: true }),
    fetcher: async () => { remoteCalls++; return new Response('', { status: 429, headers: { 'retry-after': '600' } }); },
    dammPumpTrades: async () => { localCalls++; return chainSnapshot(Array.from({ length: localCalls }, (_, n) => chainTrade(n + 1, { poolId: local.curve })), { poolId: local.curve }); } });
  const reader = f.create(); await reader.tick(); assert.equal(reader.readPublic().tradeCount, 1);
  f.advance(); await reader.tick();
  assert.equal(remoteCalls, 1); assert.equal(localCalls, 2); assert.equal(reader.readPublic().tradeCount, 2); reader.close();
});

test('Pump.fun coins record their onchain trades through the Pump.fun service, never the Raydium history API', async () => {
  const classic = { ...record, platform: 'pump-classic', quote: { ...record.quote, decimals: 9 } };
  const rows = [1, 2].map(n => ({ time: Math.floor(NOW / 1000) - n, side: n % 2 ? 'buy' : 'sell', quote: 0.5 * n, amount: 1000 * n, wallet: OWNER, signature: trade(n).txid, venue: 'curve' }));
  let calls = 0;
  const f = fixture({ inventory: async () => ({ records: [classic], complete: true }), pumpClassicTrades: async mint => { calls++; assert.equal(mint, MINT); return rows; } });
  const reader = f.create(); await reader.tick();
  assert.equal(calls, 1); assert.equal(f.requests.length, 0, 'no Raydium launch-history request');
  assert.equal(reader.readPublic().tradeCount, 2); assert.equal(reader.readPublic().recordedVolumeUsdEstimate, 3);
  // The same trades seen again are not counted twice.
  f.advance(); await reader.tick(); assert.equal(calls, 2); assert.equal(reader.readPublic().tradeCount, 2);
});
