import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { TelegramStore } from '../src/telegram-store.mjs';
import { TelegramEngine } from '../src/telegram-engine.mjs';
import { SharedRpcGate } from '../src/shared-rpc-gate.mjs';
import { workerRpcGate } from '../src/worker-rpc.mjs';
import { prepareRunJournals, emptyJournal } from '../src/run-journals.mjs';
import { selectedRunSettings } from '../src/run-settings.mjs';
import { importSettings } from '../src/telegram-settings.mjs';
import { createPreset } from '../public/presets.mjs';
import { config, key1, key2, mint } from './fixtures.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function storeFor(t) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-run-journals-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new TelegramStore(dir, randomBytes(32), 'test:concurrent');
}
const allocation = (kind, wallet, id) => ({ kind, wallet, id, tokens: {}, baseMint: mint });

test('upgrade preserves legacy history and splits allocations, pending transactions and receipts exactly once', async t => {
  const store = await storeFor(t), market = allocation('market', key1.publicKey.toBase58(), 'm'), liquidity = allocation('liquidity', key2.publicKey.toBase58(), 'l');
  const legacy = { ...emptyJournal(), lots: [market, liquidity], pending: [{ wallet: market.wallet, signature: 'pending-m' }], trades: 12,
    feeReceipts: [{ kind: 'market', signature: 'fee-m' }, { kind: 'liquidity', signature: 'fee-l' }] };
  await store.write('portfolio-live', legacy); await prepareRunJournals(store);
  const m = await store.read('market-live'), l = await store.read('liquidity-live');
  assert.deepEqual(m.lots, [market]); assert.deepEqual(l.lots, [liquidity]); assert.equal(m.pending.length, 1); assert.equal(l.pending.length, 0);
  assert.deepEqual(m.feeReceipts, [legacy.feeReceipts[0]]); assert.equal(m.legacyTrades, 12); assert.deepEqual(await store.read('portfolio-live'), legacy);
  await store.write('market-live', { ...m, lots: [], pending: [] }); await prepareRunJournals(store);
  assert.deepEqual((await store.read('market-live')).lots, []);
});

test('interrupted migration resumes before workers start and ambiguous pending trades are never discarded', async t => {
  const store = await storeFor(t), row = allocation('market', key1.publicKey.toBase58(), 'm');
  await store.write('portfolio-live', { ...emptyJournal(), lots: [row] });
  const original = store.write.bind(store); let crash = true;
  store.write = async (name, value) => { if (crash && name === 'liquidity-live') throw Error('Test interrupted write'); return original(name, value); };
  await assert.rejects(prepareRunJournals(store), /interrupted/); assert.equal(await store.read('concurrent-runs', null), null);
  crash = false; await prepareRunJournals(store); assert.deepEqual((await store.read('market-live')).lots, [row]);
  const other = await storeFor(t), pending = { wallet: row.wallet, signature: 'unknown' };
  await other.write('portfolio-live', { ...emptyJournal(), pending: [pending] });
  await assert.rejects(prepareRunJournals(other), /cannot be assigned safely/); assert.equal(await other.read('concurrent-runs', null), null);
  assert.deepEqual((await other.read('portfolio-live')).pending, [pending]);
});

test('real workers read and persist independent journals and reject commands for another mode', async t => {
  const store = await storeFor(t); await prepareRunJournals(store);
  for (const kind of ['market', 'liquidity']) await store.write(`${kind}-paper`, { ...emptyJournal(), lots: [allocation(kind, key1.publicKey.toBase58(), kind)] });
  const workers = ['copy', 'market', 'liquidity', 'sniper'].map(journalKind => new TelegramEngine(store, null, { journalKind }));
  t.after(() => Promise.all(workers.map(w => w.close()))); await Promise.all(workers.map(w => w.ready));
  await Promise.all(workers.map(w => w.request('stop')));
  assert.deepEqual(workers[0].status().views.portfolioPaper.positions, []);
  assert.equal(workers[1].status().views.portfolioPaper.positions[0].id, 'market');
  assert.equal(workers[2].status().views.portfolioPaper.positions[0].id, 'liquidity');
  await assert.rejects(workers[1].request('start', config(), { kind: 'copy' }), /another mode/);
  await assert.rejects(workers[1].request('manualTrade', config(), { trade: {} }), /Copytrading/);
  assert.equal(workers[3].status().kind, 'sniper');
  const raw = config({ mode: 'live', rpcUrl: 'https://127.0.0.1/blocked', sniper: { developers: key2.publicKey.toBase58() } });
  await assert.rejects(workers[3].start(raw, 'copy'), /another mode/);
  await assert.rejects(workers[3].manualTrade(raw, { id: 'sniper-manual', side: 'buy', mint, wallets: [key1.publicKey.toBase58()], amountSol: '.05' }), /public/);
  assert.equal(workers[3].state, 'stopped');
  assert.equal((await store.read('sniper-live')).lots.length, 0);
  await workers[1].release('market', 'paper');
  assert.equal((await store.read('market-paper')).lots.length, 0); assert.equal((await store.read('liquidity-paper')).lots.length, 1);
});

test('wallet selections survive presets, preserve budget indices, and never substitute a removed wallet', () => {
  const raw = { ...config({ mode: 'live', wallets: [key1, key2] }), leads: config().leads.join('\n'),
    runWallets: { market: [key2.publicKey.toBase58()], copy: [], liquidity: null },
    strategies: { market: { walletBudgets: { 0: '2', 1: '7' } } } };
  const selected = selectedRunSettings(raw, 'market');
  assert.deepEqual(selected.wallets.map(w => w.publicKey), [key2.publicKey.toBase58()]); assert.deepEqual(selected.strategies.market.walletBudgets, { 0: '7' });
  assert.equal(selected.runWallets, undefined); assert.equal(raw.wallets.length, 2);
  assert.throws(() => selectedRunSettings(raw, 'copy'), /at least one/);
  assert.throws(() => selectedRunSettings({ ...raw, wallets: [raw.wallets[0]] }, 'market'), /no longer imported/);
  assert.deepEqual(importSettings(JSON.stringify(createPreset(raw))).runWallets, { ...raw.runWallets, sniper: null });
});

test('three workers share one rolling RPC budget; separate accounts and endpoints remain independent', async t => {
  const gate = new SharedRpcGate(); t.after(() => gate.close()); let admitted = 0;
  const work = [0, 1, 2].map(i => gate.acquire('account:endpoint', `worker-${i}`, 2).then(() => { admitted++; }));
  await tick(); assert.equal(admitted, 2);
  await gate.acquire('other-account:endpoint', 'worker-other', 2); await gate.acquire('account:other-endpoint', 'worker-other', 2);
  await Promise.all(work); assert.equal(admitted, 3);
});

test('shared RPC gate cancels waiting work, respects signal deadlines and propagates cooldowns', async t => {
  const gate = new SharedRpcGate(); t.after(() => gate.close());
  await gate.acquire('rpc', 'copy', 1); const abort = new AbortController();
  const cancelled = gate.acquire('rpc', 'lp', 1, { signal: abort.signal }); abort.abort(); await assert.rejects(cancelled, /abort/i);
  await assert.rejects(gate.acquire('rpc', 'mm', 1, { deadline: Date.now() + 10 }), /Maximum signal age/);
  gate.cooldown('rpc', 3000);
  await assert.rejects(gate.acquire('rpc', 'lp', 1), e => e.rateLimited && e.retryAfterMs > 0);
  await gate.acquire('separate', 'copy', 1);
});

test('worker teardown removes its RPC rate cap and queued requests without forgetting recent sends', async t => {
  const gate = new SharedRpcGate(); t.after(() => gate.close());
  await gate.acquire('rpc', 'old-worker', 1);
  const blocked = gate.acquire('rpc', 'old-worker', 1); gate.removeClient('old-worker'); await assert.rejects(blocked, /worker closed/);
  await gate.acquire('rpc', 'new-worker', 2);
  await assert.rejects(gate.acquire('rpc', 'new-worker', 2, { deadline: Date.now() + 10 }), /Maximum signal age/);
});

test('worker/host RPC messages enforce a shared limit and preserve deadline and cooldown errors', async t => {
  const rpcGate = new SharedRpcGate(), channels = [], brokers = [];
  t.after(() => { rpcGate.close(); for (const { port1, port2 } of channels) { port1.close(); port2.close(); } });
  for (let i = 0; i < 3; i++) {
    const channel = new MessageChannel(); channels.push(channel);
    const host = { rpcGate, rpcScope: 'same-account', rpcClient: `worker-${i}`, rpcPending: new Map(), worker: channel.port1 };
    channel.port1.on('message', message => TelegramEngine.prototype.rpcMessage.call(host, message));
    brokers.push(workerRpcGate(channel.port2));
  }
  const config = { rpcUrl: 'https://rpc.example/', rpcRequestsPerSecond: 2 };
  const result = await Promise.allSettled(brokers.map(b => b.acquire(config, null, Date.now() + 50)));
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 2);
  assert.match(result.find(r => r.status === 'rejected').reason.message, /Maximum signal age/);
  const notified = once(channels[0].port1, 'message'); brokers[0].cooldown(config, 3000); await notified;
  await assert.rejects(brokers[1].acquire(config, null, Infinity), e => e.rateLimited === true && e.retryAfterMs > 0);
});
