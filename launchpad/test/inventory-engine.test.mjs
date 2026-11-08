import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.mjs';
import { Ledger } from '../src/ledger.mjs';
import { SOL } from '../src/core.mjs';
import { config, key1, key2, lead, lead2, mint, quote } from './fixtures.mjs';

const pub = key => key.publicKey.toBase58();
const freshLot = (key = key1, amount = 1000n, extra = {}) => ({ id: randomUUID(), wallet: pub(key), walletLabel: 'Test wallet', lead,
  mint, decimals: 6, remaining: String(amount), original: String(amount), exitMint: SOL, venue: null, mode: 'live', confirmedSlot: 100,
  entryPrice: 1, entryMarketCap: 100000, costBasis: { inputMint: SOL, inputAmount: '10000000', inputDecimals: 9 }, ...extra });

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-inventory-engine-'));
  const ledgers = { live: await new Ledger(join(dir, 'live.json')).load(), paper: await new Ledger(join(dir, 'paper.json')).load() };
  const holdings = new Map(), reads = [], orders = [];
  const p = { market: new Map(), closed: false, init: async () => { p.closed = false; p.direct.discover = async () => null; },
    close: () => { p.closed = true; }, subscribe: async () => {}, markets: async () => p.market,
    trackedBalances: async groups => {
      reads.push(groups);
      return groups.map(group => ({ wallet: group.wallet, mint: group.mint, amount: holdings.get(`${group.wallet}:${group.mint}`) ?? group.tracked,
        slot: Math.max(200, group.minContextSlot), complete: true }));
    }, statuses: async signatures => signatures.map(() => null), height: async () => 100, transaction: async () => null,
  };
  const engine = new Engine(ledgers, () => p);
  engine.execute = async (order, wallet) => { orders.push({ ...order, wallet: wallet.publicKey }); };
  t.after(async () => { engine.stop(); await engine.stopPromise; await rm(dir, { recursive: true, force: true }); });
  return { engine, ledgers, p, dir, reads, orders, holdings, setHolding(key, amount, tokenMint = mint) { holdings.set(`${pub(key)}:${tokenMint}`, amount); } };
}

async function drain(engine) { await Promise.all([...engine.queues.values()]); }
function sellSignal(extra = {}) { return { lead, inputMint: mint, outputMint: SOL, sellNumerator: 1n, sellDenominator: 1n,
  receivedAt: Date.now(), observedAt: performance.now(), signature: randomUUID(), ...extra }; }

test('startup repairs retained balances before enabling trading, preserves history, and persists the adjustment', async t => {
  const h = await harness(t), rows = [freshLot(key1, 300n), freshLot(key1, 600n), freshLot(key2, 500n)];
  h.ledgers.live.data.lots.push(...rows); h.setHolding(key1, 300n); h.setHolding(key2, 0n);
  await h.engine.start(config({ mode: 'live', wallets: [key1, key2] }));
  assert.deepEqual(rows.map(row => row.remaining), ['100', '200', '0']);
  assert.deepEqual(rows.map(row => row.original), ['300', '600', '500']);
  assert(rows.every(row => row.costBasis.inputAmount === '10000000'));
  assert.equal(h.engine.status().positions.length, 2); assert.equal(h.orders.length, 0);
  const saved = JSON.parse(await readFile(join(h.dir, 'live.json')));
  assert.equal(saved.positionAdjustments.length, 2); assert.equal(saved.lots[2].remaining, '0');
  assert.equal(h.engine.status().inventoryRefresh.state, 'idle'); assert(h.engine.status().inventoryRefresh.at > 0);
});

test('manual percentages apply after reconciling all attributed leads and never adopt untracked deposits', async t => {
  const h = await harness(t), rows = [freshLot(key1, 1000n), freshLot(key1, 2000n, { lead: lead2 }), freshLot(key2, 1000n)];
  h.ledgers.live.data.lots.push(...rows); h.setHolding(key1, 1200n); h.setHolding(key2, 5000n);
  await h.engine.manualTrade(config({ mode: 'live', wallets: [key1, key2], leads: [] }), {
    id: randomUUID(), side: 'sell', mint, wallets: [pub(key1), pub(key2)], sellPercent: 50,
  });
  assert.deepEqual(h.orders.map(order => [order.wallet, order.amount]).sort(), [[pub(key1), 600n], [pub(key2), 500n]].sort());
  assert.deepEqual(rows.map(row => row.remaining), ['400', '800', '1000']);
  assert.equal(h.engine.state, 'stopped'); assert.equal(h.engine.metrics.confirmed, 0, 'inventory adjustments are not trades');
});

test('lead and ladder exits compute their amounts after an outside balance reduction', async t => {
  const h = await harness(t), row = freshLot(key1, 1000n); h.ledgers.live.data.lots.push(row);
  await h.engine.start(config({ mode: 'live', mirrorFraction: true }));
  h.setHolding(key1, 400n);
  await h.engine.enqueue(h.engine.c.wallets[0], () => h.engine.mirrorSell(sellSignal({ sellNumerator: 1n, sellDenominator: 2n }), h.engine.c.wallets[0]));
  assert.equal(h.orders[0].amount, 200n); assert.equal(row.remaining, '400');
  h.setHolding(key1, 100n); h.engine.c.sellMode = 'percent'; h.engine.c.percentStep = 25; h.engine.c.sellPercent = 50;
  h.p.market.set(mint, { price: 1.25, marketCap: 125000, receivedAt: Date.now() });
  await h.engine.pollMarkets(); await drain(h.engine);
  assert.equal(h.orders[1].amount, 50n); assert.equal(row.remaining, '100');
});

test('a confirmed zero holding clears the position without building an empty sell', async t => {
  const h = await harness(t); h.ledgers.live.data.lots.push(freshLot());
  await h.engine.start(config({ mode: 'live' })); h.setHolding(key1, 0n);
  const result = await h.engine.manualTrade(config({ mode: 'live' }), { id: randomUUID(), side: 'sell', mint, wallets: [pub(key1)], sellPercent: 100 });
  assert.equal(result.positions.length, 0); assert.equal(h.orders.length, 0);
  assert.equal(result.manualResult.outcomes[0].status, 'skipped'); assert.equal(h.ledgers.live.data.positionAdjustments.length, 1);
});

test('stopped read-only refresh selects the live ledger without private keys or an automatic run', async t => {
  const h = await harness(t); h.ledgers.live.data.lots.push(freshLot()); h.setHolding(key1, 0n);
  h.engine.viewMode = 'live'; const controller = new AbortController();
  const result = await h.engine.refreshInventory({ provider: h.p, signal: controller.signal, mode: 'live', source: 'wallet-refresh' });
  assert.equal(result.changed, 1); assert.equal(h.engine.state, 'stopped'); assert.equal(h.engine.c, undefined); assert.equal(h.engine.p, undefined);
  assert.equal(h.engine.status().mode, 'live'); assert.equal(h.engine.status().positions.length, 0);
  assert.equal(h.engine.status().events[0].source, 'wallet-refresh');
});

test('pending and active wallets are excluded, and a newly pending or changed wallet invalidates an in-flight snapshot', async t => {
  const h = await harness(t), row = freshLot(); h.ledgers.live.data.lots.push(row);
  const provider = { trackedBalances: async () => assert.fail('pending wallet must not be queried') };
  h.ledgers.live.data.pending.push({ wallet: pub(key1) });
  await h.engine.refreshInventory({ provider, mode: 'live' });
  h.ledgers.live.data.pending = []; h.engine.queueDepth.set(pub(key1), 1);
  await h.engine.refreshInventory({ provider, mode: 'live' }); h.engine.queueDepth.clear();
  for (const changed of ['position', 'pending']) {
    h.engine.inventoryRefresh.at = 123;
    let release; const provider = { trackedBalances: groups => new Promise(resolve => { release = () => resolve(groups.map(group => ({ ...group, amount: 0n, slot: 200, complete: true }))); }) };
    const refreshing = h.engine.refreshInventory({ provider, mode: 'live' });
    if (changed === 'position') row.remaining = '800'; else h.ledgers.live.data.pending.push({ wallet: pub(key1) });
    release(); const result = await refreshing;
    assert.equal(result.changed, 0); assert.equal(result.skipped, 1); assert.equal(row.remaining, '800');
    assert.equal(result.checked, 0); assert.equal(h.engine.inventoryRefresh.at, 123, 'discarded reads cannot claim fresh holdings');
    h.ledgers.live.data.pending = [];
  }
  assert.equal(h.ledgers.live.data.positionAdjustments, undefined);
});

test('inventory persistence shares one barrier and includes mutations arriving during its write', async t => {
  const h = await harness(t), row = freshLot(); h.ledgers.live.data.lots.push(row);
  let release, writes = 0; const snapshots = [];
  h.ledgers.live.save = async () => { writes++; snapshots.push(row.remaining); if (writes === 1) await new Promise(resolve => { release = resolve; }); };
  const first = h.engine.persistInventory(h.ledgers.live, true);
  assert.equal(h.engine.persistInventory(h.ledgers.live, false), first);
  await Promise.resolve(); row.remaining = '500';
  assert.equal(h.engine.persistInventory(h.ledgers.live, true), first);
  release(); await first;
  assert.equal(writes, 2); assert.deepEqual(snapshots, ['1000', '500']); assert.equal(h.engine.inventorySaves.size, 0);
});

test('failed inventory persistence stops trading before subsequent orders can execute', async t => {
  const h = await harness(t); h.ledgers.live.data.lots.push(freshLot()); await h.engine.start(config({ mode: 'live' }));
  h.setHolding(key1, 0n); const originalSave = h.ledgers.live.save.bind(h.ledgers.live);
  h.ledgers.live.save = async () => { throw new Error('disk write failed'); };
  await assert.rejects(h.engine.refreshInventory(), /disk write failed/); await h.engine.stopPromise;
  assert.equal(h.engine.accepting, false); assert.equal(h.engine.state, 'stopped'); assert.equal(h.orders.length, 0);
  h.ledgers.live.save = originalSave;
});

test('empty read-only inventory leaves no false refreshing indicator or invented check timestamp', async t => {
  const h = await harness(t); h.engine.inventoryRefresh = { state: 'refreshing', at: null, mode: 'live' };
  const report = await h.engine.refreshInventory({ provider: h.p, mode: 'live' });
  assert.equal(report.checked, 0); assert.equal(h.engine.inventoryRefresh.state, 'idle'); assert.equal(h.engine.inventoryRefresh.at, null);
  assert.equal(h.reads.length, 0);
});

test('stale, incomplete, failing, and cancelled reads never erase holdings', async t => {
  const h = await harness(t), row = freshLot(); h.ledgers.live.data.lots.push(row);
  for (const result of [{ amount: 0n, slot: 99, complete: true }, { amount: 0n, slot: 200, complete: false }]) {
    await assert.rejects(h.engine.refreshInventory({ mode: 'live', provider: { trackedBalances: async () => [{ wallet: pub(key1), mint, ...result }] } }), /incomplete or stale/);
    assert.equal(row.remaining, '1000');
  }
  await assert.rejects(h.engine.refreshInventory({ mode: 'live', provider: { trackedBalances: async () => { throw new Error('429 cooling down'); } } }), /429/);
  assert.equal(h.engine.status('live').inventoryRefresh.state, 'error');
  const controller = new AbortController(); let release;
  const refreshing = h.engine.refreshInventory({ mode: 'live', signal: controller.signal, provider: { trackedBalances: groups => new Promise(resolve => { release = () => resolve(groups.map(group => ({ ...group, amount: 0n, slot: 200, complete: true }))); }) } });
  controller.abort(); release(); await refreshing;
  assert.equal(row.remaining, '1000'); assert.equal(h.engine.inventoryRefresh.state, 'idle');
});

test('a new confirmed fill invalidates an earlier snapshot, and new lot records retain their confirmed slot', async t => {
  const h = await harness(t), row = freshLot(); h.ledgers.live.data.lots.push(row);
  await h.engine.start(config({ mode: 'live' })); let release;
  h.p.trackedBalances = groups => new Promise(resolve => { release = () => resolve(groups.map(group => ({ ...group, amount: 0n, slot: 200, complete: true }))); });
  const refreshing = h.engine.refreshInventory();
  const pending = { signature: randomUUID(), wallet: pub(key1), walletLabel: 'Wallet 1', confirmedSlot: 250, createdAt: Date.now(),
    order: { kind: 'buy', lead, inputMint: SOL, outputMint: mint, outputDecimals: 6, exitMint: SOL, amount: '10000000' } };
  h.ledgers.live.data.pending.push(pending); await Engine.prototype.applyFill.call(h.engine, pending, 500n, 10000000n);
  release(); const result = await refreshing;
  assert.equal(result.changed, 0); assert.equal(h.ledgers.live.data.lots[1].confirmedSlot, 250); assert.equal(row.remaining, '1000');
});

test('queuing a trade cancels background balance reads before they can apply or delay execution', async t => {
  const h = await harness(t); h.ledgers.live.data.lots.push(freshLot()); await h.engine.start(config({ mode: 'live' }));
  let observedSignal;
  h.p.trackedBalances = (_groups, signal) => new Promise((_resolve, reject) => { observedSignal = signal; signal.addEventListener('abort', () => reject(new Error('Stopped.')), { once: true }); });
  const refreshing = h.engine.pollInventory(); assert(observedSignal);
  let ran = false; await h.engine.enqueue(h.engine.c.wallets[0], async () => { ran = true; }); await refreshing;
  assert(observedSignal.aborted); assert(ran); assert.equal(h.engine.inventoryRefresh.state, 'idle');
  assert.equal(h.ledgers.live.data.lots[0].remaining, '1000');
});
