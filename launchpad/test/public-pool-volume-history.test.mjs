import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { PublicPoolVolumeHistory } from '../src/public-pool-volume-history.mjs';
import { PersistentLifetimeVolume } from '../src/public-lifetime-volume.mjs';
import { readFile } from 'node:fs/promises';

const key = n => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const NOW = Date.parse('2026-10-01T10:00:00Z'), DAY = 86400, TODAY = Math.floor(NOW / 86400000) * DAY;
const MINT = key(1), QUOTE = key(2), LAUNCHPAD = key(3), AMM = key(4), SECONDARY = key(5);
const record = { mint: MINT, curve: LAUNCHPAD, createdAt: NOW - 2 * 86400000, quote: { mint: QUOTE, symbol: 'QUOTE', decimals: 9 }, chainRecord: { review: { poolId: AMM } } };
const pool = (id, extra = {}) => ({ address: id, token: MINT, base: { address: MINT }, quote: { address: QUOTE }, createdAt: record.createdAt, volume24h: 100, ...extra });
const response = (volumes = [30, 20, 10], extra = {}) => new Response(JSON.stringify({ data: { attributes: { ohlcv_list: volumes.map((v, i) => [TODAY - i * DAY, 1, 2, 0.5, 1, v]) } }, meta: { base: { address: MINT }, quote: { address: QUOTE } }, ...extra }), { headers: { 'content-type': 'application/json' } });
function fixture(options = {}) {
  let now = NOW, state = options.saved, count = 0, failWrites = false;
  const records = options.records || [record];
  const sources = new Map([[MINT, { dexRaw: { chain: 'solana', tokenAddress: MINT, at: NOW, pools: options.pools || [pool(AMM)] } }]]);
  const store = { read: async (_, fallback) => structuredClone(state || fallback), write: async (_, next) => { if (failWrites) throw Error('disk'); state = structuredClone(next); } };
  const make = () => new PublicPoolVolumeHistory({ store, inventory: async () => ({ records, sources, complete: true }), now: () => now, fetcher: async (...args) => { count++; return options.fetcher ? options.fetcher(...args) : response(); } });
  return { make, sources, records, get state() { return structuredClone(state); }, get count() { return count; }, advance(ms = 300000) { now += ms; }, failWrites(value) { failWrites = value; } };
}

test('sums disjoint UTC days and replaces mutable days across repeated scans and restart', async () => {
  let values = [30, 20, 10]; const f = fixture({ fetcher: async () => response(values) });
  const first = f.make(); await first.tick(); assert.equal(Object.values(first.selection().pools[0].days).reduce((a, b) => a + b), 60);
  f.advance(); values = [40, 20, 10]; await first.tick(); assert.equal(Object.values(first.selection().pools[0].days).reduce((a, b) => a + b), 70);
  first.close(); const second = f.make(); await second.tick(); assert.equal(Object.values(second.selection().pools[0].days).reduce((a, b) => a + b), 70); second.close();
});

test('pool creation-day coverage is required; short late history stays partial', async () => {
  const f = fixture({ fetcher: async () => response([30]) }); const reader = f.make(); await reader.tick();
  assert.equal(reader.selection().pools[0].complete, false); assert.equal(reader.selection().complete, false); reader.close();
});

test('provider outage and failed durable write keep prior published history', async () => {
  let mode = 'ok'; const f = fixture({ fetcher: async () => { if (mode === 'fail') throw Error('offline'); return response(mode === 'new' ? [300, 20, 10] : undefined); } });
  const reader = f.make(); await reader.tick(); const saved = f.state; f.advance(); mode = 'fail'; await reader.tick(); assert.deepEqual(f.state, saved);
  f.advance(); mode = 'new'; f.failWrites(true); await reader.tick(); assert.deepEqual(f.state, saved); assert.equal(reader.selection().pools[0].days[String(TODAY)], 30); reader.close();
});

test('DAMM group replaces combined ledger only once original and destination histories cover creation', async () => {
  let ready = false; const f = fixture({ records: [{ ...record, platform: 'damm-pump' }], pools: [pool(LAUNCHPAD), pool(AMM), pool(SECONDARY)], fetcher: async url => url.includes(`/${AMM}/`) && !ready ? response([30]) : response() });
  const reader = f.make(); await reader.tick(); let selected = reader.selection(); assert.equal(selected.excluded.size, 0); assert.deepEqual(selected.pools.map(row => row.id), [SECONDARY]);
  ready = true; f.advance(); await reader.tick(); selected = reader.selection(); assert.equal(selected.excluded.has(LAUNCHPAD), true); assert.deepEqual(new Set(selected.pools.map(row => row.id)), new Set([LAUNCHPAD, AMM, SECONDARY])); reader.close();
});

test('wrong token metadata, duplicate dates and negative volumes never publish', async () => {
  for (const bad of [response(undefined, { meta: { base: { address: key(9) }, quote: { address: QUOTE } } }), response([-1]), new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [[TODAY, 1, 2, 1, 1, 1], [TODAY, 1, 2, 1, 1, 2]] } }, meta: { base: { address: MINT }, quote: { address: QUOTE } } }))]) {
    const f = fixture({ fetcher: async () => bad }); const reader = f.make(); await reader.tick(); assert.equal(reader.selection().pools.length, 0); reader.close();
  }
});

test('same pool shared by two launch records contributes once and original Raydium curve is excluded', async () => {
  const f = fixture({ records: [record, { ...record, mint: QUOTE, curve: key(7), quote: { mint: MINT } }], pools: [pool(LAUNCHPAD), pool(AMM)] });
  f.sources.set(QUOTE, { dexRaw: { chain: 'solana', tokenAddress: QUOTE, at: NOW, pools: [pool(AMM, { token: QUOTE })] } });
  const reader = f.make(); await reader.tick(); assert.equal(f.count, 1); assert.deepEqual(reader.selection().pools.map(row => row.id), [AMM]); reader.close();
});

test('eight-request minute budget and global 429 cooldown are enforced', async () => {
  const f = fixture({ pools: Array.from({ length: 12 }, (_, i) => pool(key(10 + i))) }); const reader = f.make();
  await Promise.all(Array.from({ length: 20 }, () => reader.tick())); assert.equal(f.count, 4);
  await reader.tick(); assert.equal(f.count, 8); await reader.tick(); assert.equal(f.count, 8); f.advance(60001); await reader.tick(); assert.equal(f.count, 12); reader.close();
  const g = fixture({ pools: [pool(AMM), pool(SECONDARY)], fetcher: async () => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }) }); const limited = g.make(); await limited.tick(); assert.equal(g.count, 1); g.advance(60001); await limited.tick(); assert.equal(g.count, 1); limited.close();
});

test('unindexed first pool does not starve other pools and reads never trigger requests', async () => {
  const f = fixture({ pools: [pool(AMM), pool(SECONDARY)], fetcher: async url => url.includes(`/${AMM}/`) ? new Response('{}', { status: 404 }) : response() }); const reader = f.make();
  for (let i = 0; i < 100; i++) reader.selection(); assert.equal(f.count, 0); await reader.tick(); assert.equal(f.count, 2); assert.deepEqual(reader.selection().pools.map(row => row.id), [SECONDARY]); reader.close();
});

test('full indexed DAMM group replaces local total while separate Raydium pools supplement it', async () => {
  const localPool = { mint: MINT, quoteMint: QUOTE, symbol: 'QUOTE', events: { ['a'.repeat(64)]: [TODAY + 1, '1000000000000000000'] }, totalAtoms: '1000000000000000000', daily: { '2026-10-01': { atoms: '1000000000000000000', trades: 1 } }, history: { complete: true }, turn: 1, lastSuccessAt: NOW, recentAt: NOW, problem: null };
  const history = { selection: () => ({ excluded: new Set([LAUNCHPAD]), replacementFresh: new Set([LAUNCHPAD]), pools: [{ id: LAUNCHPAD, days: { [TODAY]: 100 }, at: NOW, complete: true }, { id: AMM, days: { [TODAY]: 200 }, at: NOW, complete: true }], expected: 2, complete: true }), close() {} };
  const reader = new PersistentLifetimeVolume({ now: () => NOW, poolHistory: history }); reader.loaded = true; reader.inventoryComplete = true; reader.data = { pools: { [LAUNCHPAD]: localPool } }; reader.records = [record]; reader.prices = new Map([[QUOTE, { usd: 2, at: NOW }]]);
  let result = reader.readPublic(); assert.equal(result.recordedVolumeUsdEstimate, 300); assert.equal(result.tradeCount, 0); assert.equal(result.coverage.historyComplete, true); assert.equal(result.last24h.historyComplete, false);
  history.selection = () => ({ excluded: new Set(), replacementFresh: new Set(), pools: [{ id: AMM, days: { [TODAY]: 200 }, at: NOW, complete: true }], expected: 1, complete: true });
  result = reader.readPublic(); assert.equal(result.recordedVolumeUsdEstimate, 202); assert.equal(result.curveVolumeUsdEstimate, 2); assert.equal(result.daily[0].volumeUsdEstimate, 202); reader.close();
});

test('LAUNCHPAD CPMM and EXAMPLE original plus destination historical candles recover missing external volume', async () => {
  const captured = JSON.parse(await readFile(new URL('./fixtures/public-pool-volume-golden.json', import.meta.url), 'utf8'));
  const [cpmm, original, destination] = Object.keys(captured.pools), native = 'So11111111111111111111111111111111111111112';
  const curve = { mint: captured.pools[cpmm].meta.base.address, curve: key(90), quote: { mint: native }, createdAt: Date.parse('2026-09-24T00:00:00Z') };
  const pill = { mint: captured.pools[original].meta.base.address, curve: original, platform: 'damm-pump', quote: { mint: native }, createdAt: 1790838751000, chainRecord: { review: { poolId: destination } } };
  const sources = new Map([[curve.mint, { dexRaw: { chain: 'solana', tokenAddress: curve.mint, at: NOW, pools: [pool(cpmm, { token: curve.mint, base: { address: curve.mint }, quote: { address: native }, createdAt: 1790644357000 })] } }], [pill.mint, { dexRaw: { chain: 'solana', tokenAddress: pill.mint, at: NOW, pools: [pool(original, { token: pill.mint, base: { address: pill.mint }, quote: { address: native }, createdAt: pill.createdAt }), pool(destination, { token: pill.mint, base: { address: pill.mint }, quote: { address: native }, createdAt: 1790843582000 })] } }]]);
  const reader = new PublicPoolVolumeHistory({ store: { read: async (_, fallback) => fallback, write: async () => {} }, now: () => NOW, inventory: async () => ({ records: [curve, pill], sources, complete: true }), fetcher: async url => new Response(JSON.stringify(captured.pools[new URL(url).pathname.split('/')[6]])) });
  await reader.tick(); const selected = reader.selection(); assert.equal(selected.excluded.has(original), true); assert.equal(selected.pools.length, 3); assert.equal(selected.complete, true);
  const values = Object.fromEntries(selected.pools.map(row => [row.id, Object.values(row.days).reduce((a, b) => a + b, 0)]));
  assert.equal(values[cpmm], 1852581.9991551335); assert.equal(values[original] + values[destination], 72650.20721039141); reader.close();
});

test('global launch-curve exclusion prevents a pool appearing through another launch from duplicating ledger volume', async () => {
  const f = fixture({ records: [record, { ...record, mint: QUOTE, curve: key(7), quote: { mint: MINT } }], pools: [pool(AMM)] });
  f.sources.set(QUOTE, { dexRaw: { chain: 'solana', tokenAddress: QUOTE, at: NOW, pools: [pool(LAUNCHPAD, { token: QUOTE })] } });
  const reader = f.make(); await reader.tick(); assert.deepEqual(reader.selection().pools.map(row => row.id), [AMM]); reader.close();
});

test('empty, old-headed or gapped refresh cannot mark old history freshly complete', async () => {
  let bad = null; const f = fixture({ fetcher: async () => bad ? new Response(JSON.stringify(bad)) : response() }); const reader = f.make(); await reader.tick(); const saved = f.state;
  const meta = { base: { address: MINT }, quote: { address: QUOTE } };
  for (const bars of [[], [[TODAY - DAY, 1, 2, 1, 1, 40]], [[TODAY, 1, 2, 1, 1, 40], [TODAY - 2 * DAY, 1, 2, 1, 1, 10]]]) {
    f.advance(); bad = { data: { attributes: { ohlcv_list: bars } }, meta }; await reader.tick(); assert.deepEqual(f.state, saved);
  }
  reader.close();
});

test('stored conflicting mint identity cannot activate grouped replacement', async () => {
  const f = fixture({ records: [{ ...record, platform: 'damm-pump' }], pools: [pool(LAUNCHPAD), pool(AMM)] }); const reader = f.make(); await reader.tick(); assert.equal(reader.selection().excluded.has(LAUNCHPAD), true);
  f.sources.get(MINT).dexRaw.pools[0].quote.address = key(99); reader.sync({ records: f.records, sources: f.sources, complete: true }); assert.equal(reader.selection().excluded.has(LAUNCHPAD), false); assert.equal(reader.selection().complete, false); reader.close();
});

test('an unresponsive provider that ignores abort cannot hold the worker or write late history', async () => {
  let writes = 0, resolve;
  const reader = new PublicPoolVolumeHistory({ store: { read: async (_, fallback) => fallback, write: async () => { writes++; } }, now: () => NOW,
    setTimer: callback => setTimeout(callback, 5), clearTimer: clearTimeout,
    inventory: async () => ({ records: [record], sources: new Map([[MINT, { dexRaw: { chain: 'solana', tokenAddress: MINT, at: NOW, pools: [pool(AMM)] } }]]), complete: true }),
    fetcher: async () => new Promise(done => { resolve = done; }) });
  await reader.tick(); assert.equal(writes, 0); resolve(response()); await new Promise(done => setTimeout(done, 1)); assert.equal(writes, 0); reader.close();
});

test('verified market creation day overrides older paid setup time and high-volume canonical pools retain priority', async () => {
  const requested = [], recent = NOW - 1000;
  const f = fixture({ records: [{ ...record, platform: 'damm-pump', createdAt: NOW - 10 * 86400000 }], pools: [pool(LAUNCHPAD, { createdAt: recent, volume24h: 999999 }), pool(AMM, { createdAt: recent, volume24h: 100 }), ...Array.from({ length: 5 }, (_, i) => pool(key(30 + i), { createdAt: recent, volume24h: 1 }))], fetcher: async url => { requested.push(new URL(url).pathname.split('/')[6]); return response([20]); } });
  const reader = f.make(); await reader.tick(); assert.equal(requested[0], LAUNCHPAD); assert.equal(reader.selection().excluded.has(LAUNCHPAD), true); assert.equal(f.state.pools[LAUNCHPAD].createdAt, recent); reader.close();
});

test('new authoritative pool creation day rechecks old incomplete saved history without waiting five minutes', async () => {
  const f = fixture({ records: [{ ...record, platform: 'damm-pump' }], pools: [pool(LAUNCHPAD), pool(AMM)], fetcher: async () => response([20]) }); const reader = f.make();
  await reader.tick(); assert.equal(reader.selection().excluded.has(LAUNCHPAD), false); assert.equal(f.count, 2);
  for (const row of f.sources.get(MINT).dexRaw.pools) row.createdAt = NOW - 1000;
  await reader.tick(); assert.equal(f.count, 4); assert.equal(reader.selection().excluded.has(LAUNCHPAD), true); reader.close();
});

test('a Pump.fun bonding curve and its PumpSwap pool replace the local trade ledger only as a complete group, never on top of it', async () => {
  let ready = false; const f = fixture({ records: [{ ...record, platform: 'pump-classic' }], pools: [pool(LAUNCHPAD), pool(AMM), pool(SECONDARY)], fetcher: async url => url.includes(`/${AMM}/`) && !ready ? response([30]) : response() });
  const reader = f.make(); await reader.tick(); let selected = reader.selection();
  // Incomplete PumpSwap history: the curve and pool stay out of the indexed sum (the ledger already has those trades).
  assert.equal(selected.excluded.size, 0); assert.deepEqual(selected.pools.map(row => row.id), [SECONDARY]);
  ready = true; f.advance(); await reader.tick(); selected = reader.selection();
  assert.equal(selected.excluded.has(LAUNCHPAD), true); assert.deepEqual(new Set(selected.pools.map(row => row.id)), new Set([LAUNCHPAD, AMM, SECONDARY])); reader.close();
});
