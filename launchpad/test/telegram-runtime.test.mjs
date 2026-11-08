import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { TelegramRuntime } from '../src/telegram-worker.mjs';
import { TelegramEngine } from '../src/telegram-engine.mjs';
import { TelegramStore, TelegramLedger, userKey } from '../src/telegram-store.mjs';
import { SOL, USDC } from '../src/core.mjs';
import { strategyDefaults } from '../public/strategy-settings.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const freshLedger = () => ({ data: { version: 1, lots: [], pending: [], events: [], seen: [], trades: 0 }, saves: 0, async save() { this.saves++; } });
function config(overrides = {}) {
  const wallet = Keypair.generate();
  return { mode: 'live', wallets: [{ privateKey: JSON.stringify([...wallet.secretKey]), publicKey: wallet.publicKey.toBase58() }],
    leads: [Keypair.generate().publicKey.toBase58()], rpcUrl: 'https://rpc.example', heliusSol: '0', jitoSol: '0', prioritySol: '0.0001', sendRpc: true,
    strategy: { ...strategyDefaults(), baseMint: USDC, quoteMint: SOL, budgetSol: '1' }, ...overrides };
}
class FakeEngine extends EventEmitter {
  constructor() { super(); this.ledgers = { live: freshLedger(), paper: freshLedger() }; this.state = 'stopped'; this.mode = 'paper'; this.calls = []; this.kind = 'copy'; }
  status(mode = this.mode) { return { state: this.state, mode, kind: this.kind, positions: this.ledgers[mode].data.lots, pending: this.ledgers[mode].data.pending, events: [], metrics: {} }; }
  async start(raw, kind = 'copy') { this.calls.push(['start', raw, kind]); this.state = 'running'; this.mode = raw.mode; this.kind = kind; this.emit('change'); }
  async manualTrade(raw, trade) { this.calls.push(['manualTrade', raw, trade]); this.mode = raw.mode; this.emit('change'); }
  stop() { this.state = 'stopped'; this.emit('change'); }
  async withdraw(wallet, raw) { this.calls.push(['withdraw', wallet, raw]); this.state = 'running'; this.mode = 'live'; this.kind = 'liquidity'; this.emit('change'); }
  async release(id, mode) { this.calls.push(['release', id, mode]); this.ledgers[mode].data.lots = this.ledgers[mode].data.lots.filter(r => r.id !== id); await this.ledgers[mode].save(); }
}
const harness = () => { const copy = new FakeEngine(), portfolio = new FakeEngine(); return { copy, portfolio, runtime: new TelegramRuntime(copy, portfolio) }; };
const allocation = (wallet, overrides = {}) => ({ id: 'allocation-test', wallet, kind: 'market', tokens: { [SOL]: '1000000000' }, baseMint: USDC, quoteMint: SOL, budget: '1000000000', ...overrides });
async function storeFor(t, context = 'user:97001', key = randomBytes(32)) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-telegram-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new TelegramStore(dir, key, context);
}

test('runtime selects the requested engine and prevents overlapping runs and release while copytrading', async () => {
  const { runtime, copy, portfolio } = harness(), raw = config();
  for (const kind of ['copy', 'market', 'liquidity']) {
    const result = await runtime.start(structuredClone(raw), kind);
    assert.equal(result.kind, kind); assert.equal(runtime.state, 'running'); assert.equal(result.mode, 'live');
    await assert.rejects(runtime.start(structuredClone(raw), 'market'), /Stop the current/);
    await assert.rejects(runtime.release('allocation-test', 'live'), /Stop the current/);
    runtime.stop(); assert.equal(runtime.state, 'stopped'); assert.equal(runtime.status().kind, kind);
  }
  assert.equal(copy.calls.filter(c => c[0] === 'start').length, 1);
  assert.deepEqual(portfolio.calls.filter(c => c[0] === 'start').map(c => c[2]), ['market', 'liquidity']);
});

test('runtime supplies the selected strategy and neutralizes stale copy-only fields without changing saved settings', async () => {
  const { runtime, portfolio } = harness(), raw = config({ leads: ['incomplete-lead'], quoteMints: 'not-a-mint', sellMode: 'unfinished' });
  raw.strategies = { market: { ...strategyDefaults(), baseMint: USDC, budgetSol: '7' } };
  delete raw.strategy;
  const saved = structuredClone(raw); await runtime.start(raw, 'market');
  const received = portfolio.calls[0][1];
  assert.equal(received.strategy.budgetSol, '7'); assert.deepEqual(received.leads, []); assert.equal(received.quoteMints, '');
  assert.equal(received.rpcUrl, saved.rpcUrl); assert.equal(received.wallets[0].privateKey, saved.wallets[0].privateKey);
  assert.deepEqual(raw, saved); runtime.stop();
  const explicit = config({ strategy: { ...strategyDefaults(), baseMint: USDC, budgetSol: '9' }, strategies: raw.strategies });
  await runtime.start(explicit, 'market'); assert.equal(portfolio.calls[1][1].strategy.budgetSol, '9'); runtime.stop();
});

test('runtime rejects unsupported modes before initializing either engine and guards all endpoint fields', async () => {
  const { runtime, copy, portfolio } = harness();
  await assert.rejects(runtime.start(config(), 'typo'), /Unknown trading mode/);
  await assert.rejects(runtime.start(config({ mode: 'devnet' }), 'market'), /Live or Paper/);
  for (const kind of ['copy', 'market', 'liquidity']) for (const field of ['rpcUrl', 'jitoUrl', 'senderUrl', 'wsUrl']) {
    await assert.rejects(runtime.start(config({ [field]: field === 'wsUrl' ? 'wss://127.0.0.1' : 'https://169.254.169.254' }), kind), /public/);
  }
  assert.equal(copy.calls.length + portfolio.calls.length, 0);
  await assert.rejects(runtime.withdraw('unknown', config({ rpcUrl: 'https://127.0.0.1' })), /public/);
});

test('copy start blocks live portfolio allocations and orphaned pending orders, but permits an unrelated wallet', async () => {
  const { runtime, portfolio, copy } = harness(), raw = config(), address = raw.wallets[0].publicKey;
  portfolio.ledgers.live.data.lots.push(allocation(address));
  await assert.rejects(runtime.start(structuredClone(raw)), /portfolio allocation/);
  portfolio.ledgers.live.data.lots = []; portfolio.ledgers.live.data.pending.push({ wallet: address });
  await assert.rejects(runtime.start(structuredClone(raw)), /portfolio allocation/);
  await runtime.start(config()); assert.equal(copy.calls.length, 1); runtime.stop();
  await runtime.start({ ...structuredClone(raw), mode: 'paper' }); assert.equal(copy.calls.length, 2); runtime.stop();
});

test('portfolio start and withdrawal block copied lots or pending orders in the selected wallet', async () => {
  const { runtime, copy, portfolio } = harness(), raw = config(), wallet = raw.wallets[0].publicKey;
  for (const kind of ['market', 'liquidity']) {
    copy.ledgers.live.data.lots = [{ wallet, remaining: '1' }]; copy.ledgers.live.data.pending = [];
    await assert.rejects(runtime.start(structuredClone(raw), kind), /copied positions or pending/);
    await assert.rejects(runtime.withdraw(wallet, structuredClone(raw)), /copied positions or pending/);
    copy.ledgers.live.data.lots = [{ wallet, remaining: '0' }]; copy.ledgers.live.data.pending = [{ wallet }];
    await assert.rejects(runtime.start(structuredClone(raw), kind), /copied positions or pending/);
  }
  copy.ledgers.live.data.pending = [];
  const result = await runtime.withdraw(wallet, structuredClone(raw));
  assert.equal(result.kind, 'liquidity'); assert.equal(result.mode, 'live'); assert.equal(result.state, 'running');
  assert.equal(portfolio.calls.at(-1)[0], 'withdraw'); runtime.stop();
});

test('Stop cancels startup both before dispatch and during an asynchronous engine initialization', async () => {
  const { runtime, portfolio } = harness();
  const early = runtime.start(config(), 'market'); runtime.stop();
  await assert.rejects(early, /stopped/); assert.equal(portfolio.calls.length, 0);
  let rejectStart;
  portfolio.start = async () => { portfolio.state = 'starting'; await new Promise((_, reject) => { rejectStart = reject; }); };
  portfolio.stop = () => { portfolio.state = 'stopped'; rejectStart?.(new Error('Stopped.')); };
  const pending = runtime.start(config(), 'liquidity'); await tick(); assert.equal(runtime.state, 'starting');
  runtime.stop(); await assert.rejects(pending, /Stopped/); assert.equal(runtime.state, 'stopped');
});

test('close waits for in-flight receipt drainage and saves all four ledgers without restarting anything', async () => {
  const { runtime, copy, portfolio } = harness();
  await runtime.start(config(), 'market');
  let finishReceipt, completed = false;
  portfolio.stop = () => { if (portfolio.state === 'running') { portfolio.state = 'stopping'; finishReceipt = () => { portfolio.state = 'stopped'; portfolio.ledgers.live.data.pending.push({ signature: 'unresolved-kept' }); }; } };
  const closing = runtime.close().then(() => { completed = true; });
  await tick(); assert.equal(completed, false); assert.equal(runtime.state, 'stopping');
  await assert.rejects(runtime.start(config(), 'copy'), /closing/);
  finishReceipt(); await closing;
  assert.equal(runtime.state, 'stopped');
  for (const ledger of [...Object.values(copy.ledgers), ...Object.values(portfolio.ledgers)]) assert.equal(ledger.saves, 1);
  assert.equal(portfolio.ledgers.live.data.pending[0].signature, 'unresolved-kept');
});

test('real worker rejects unknown protocol actions and private portfolio endpoints, and returns authoritative stopped snapshots', async t => {
  const store = await storeFor(t), engine = new TelegramEngine(store);
  t.after(() => engine.close()); await engine.ready;
  await assert.rejects(engine.request('not-an-action'), /Unknown trading action/);
  await assert.rejects(engine.request('start', config(), { kind: 'typo' }), /Unknown trading mode/);
  for (const kind of ['copy', 'market', 'liquidity']) {
    await assert.rejects(engine.start(config({ rpcUrl: 'https://127.0.0.1/private' }), kind), /public/);
    assert.equal(engine.state, 'stopped'); assert.equal(engine.status().pending.length, 0);
  }
  await assert.rejects(engine.start(config({ mode: 'devnet' }), 'market'), /Live or Paper/);
  await assert.rejects(engine.withdraw(Keypair.generate().publicKey.toBase58(), config({ rpcUrl: 'https://127.0.0.1' })), /public/);
  await engine.close();
  for (const name of ['live', 'paper', 'portfolio-live', 'portfolio-paper']) {
    assert.deepEqual((await store.read(name)).pending, []);
    const bytes = await readFile(store.path(name), 'utf8'); assert.equal(bytes.includes('"lots"'), false);
  }
});

test('real worker preserves isolated encrypted portfolio records across recreation and releases only stopped non-LP allocations', async t => {
  const master = randomBytes(32), a = await storeFor(t, 'user:97001', userKey(master, '97001')), b = await storeFor(t, 'user:97002', userKey(master, '97002'));
  const wallet = Keypair.generate().publicKey.toBase58();
  const ledger = await new TelegramLedger(a, 'portfolio-live').load();
  ledger.data.lots = [allocation(wallet), allocation(wallet, { id: 'pool-position', kind: 'liquidity', position: { id: 'managed-pool' } })];
  await ledger.save();
  const engine = new TelegramEngine(a), other = new TelegramEngine(b);
  t.after(async () => { await engine.close(); await other.close(); });
  await Promise.all([engine.ready, other.ready]); assert.equal(engine.state, 'stopped'); assert.equal(other.state, 'stopped');
  await assert.rejects(engine.release('pool-position', 'live'), /Withdraw/);
  await assert.rejects(engine.release('allocation-test', 'devnet'), /Live or Paper/);
  const released = await engine.release('allocation-test', 'live');
  assert.equal(released.kind, 'market'); assert.equal(released.mode, 'live');
  assert.deepEqual(released.positions.map(r => r.id), ['pool-position']);
  await Promise.all([engine.close(), other.close()]);
  assert.deepEqual((await a.read('portfolio-live')).lots.map(r => r.id), ['pool-position']);
  assert.deepEqual((await b.read('portfolio-live')).lots, []);
  const wrongKey = new TelegramStore(a.dir, b.key, b.context);
  await assert.rejects(wrongKey.read('portfolio-live'), /cannot be read/);
  const reopened = new TelegramEngine(a); t.after(() => reopened.close()); await reopened.ready;
  assert.equal(reopened.state, 'stopped'); await assert.rejects(reopened.release('pool-position', 'live'), /Withdraw/);
  assert.equal(reopened.status().positions[0].position.id, 'managed-pool'); await reopened.close();
});

test('real worker refuses to release an allocation with unresolved transactions and Stop before ready prevents portfolio startup', async t => {
  const store = await storeFor(t), ledger = await new TelegramLedger(store, 'portfolio-live').load();
  ledger.data.lots = [allocation(Keypair.generate().publicKey.toBase58())];
  ledger.data.pending = [{ signature: 'pending-test', wallet: ledger.data.lots[0].wallet, createdAt: Date.now(), order: { kind: 'swap' } }];
  await ledger.save();
  const engine = new TelegramEngine(store); t.after(() => engine.close());
  const starting = engine.start(config(), 'market'); engine.stop();
  await assert.rejects(starting, /stopped/); await engine.ready; await tick();
  await assert.rejects(engine.release('allocation-test', 'live'), /reconcile/);
  assert.equal(engine.status().pending[0].signature, 'pending-test'); await engine.close();
  assert.equal((await store.read('portfolio-live')).pending[0].signature, 'pending-test');
});


test('Stop before the worker is ready cancels release and preserves the encrypted allocation', async t => {
  const store = await storeFor(t), ledger = await new TelegramLedger(store, 'portfolio-live').load();
  ledger.data.lots = [allocation(Keypair.generate().publicKey.toBase58())]; await ledger.save();
  const engine = new TelegramEngine(store); t.after(() => engine.close());
  const release = engine.release('allocation-test', 'live'); engine.stop();
  await assert.rejects(release, /stopped/); await engine.ready; await engine.close();
  assert.equal((await store.read('portfolio-live')).lots[0].id, 'allocation-test');
});


test('failed second-wallet startup persists allocation and error before rejection, retaining the operation gate during saving', async t => {
  const store = await storeFor(t), { runtime, copy, portfolio } = harness();
  const names = ['live', 'paper', 'portfolio-live', 'portfolio-paper'];
  const ledgers = await Promise.all(names.map(name => new TelegramLedger(store, name).load()));
  copy.ledgers = { live: ledgers[0], paper: ledgers[1] }; portfolio.ledgers = { live: ledgers[2], paper: ledgers[3] };
  const raw = config(), second = config().wallets[0]; raw.wallets.push(second);
  const firstWallet = raw.wallets[0].publicKey;
  portfolio.start = async () => {
    portfolio.ledgers.live.data.lots.push(allocation(firstWallet));
    portfolio.ledgers.live.data.events.push({ id: 'second-wallet-failure', level: 'error', message: 'Wallet 2: insufficient SOL.' });
    throw new Error('Wallet 2: insufficient SOL.');
  };
  let finishSave, saving;
  const startedSaving = new Promise(resolve => { saving = resolve; });
  const delaySave = new Promise(resolve => { finishSave = resolve; });
  const originalSave = ledgers[2].save.bind(ledgers[2]);
  ledgers[2].save = async () => { saving(); await delaySave; await originalSave(); };
  let finished = false;
  const failedStart = runtime.start(raw, 'market').then(() => { finished = true; }, error => { finished = true; throw error; });
  const rejected = assert.rejects(failedStart, /Wallet 2/);
  await startedSaving; assert.equal(finished, false);
  await assert.rejects(runtime.start(config(), 'copy'), /current operation/);
  finishSave(); await rejected;
  assert.equal(runtime.operation, null);
  const saved = await store.read('portfolio-live');
  assert.equal(saved.lots[0].wallet, firstWallet); assert.equal(saved.events[0].id, 'second-wallet-failure');
  for (const name of names) assert.equal((await store.read(name)).version, 1);
});

test('journal persistence failure stops both engines and returns a credential-free error before allowing any restart', async () => {
  const { runtime, copy, portfolio } = harness();
  let copyStops = 0, portfolioStops = 0;
  copy.stop = () => { copyStops++; copy.state = 'stopped'; };
  portfolio.stop = () => { portfolioStops++; portfolio.state = 'stopped'; };
  portfolio.start = async () => { portfolio.state = 'running'; throw new Error('startup failed'); };
  portfolio.ledgers.live.save = async () => { throw new Error('storage failure with private-secret'); };
  await assert.rejects(runtime.start(config(), 'market'), error => /encrypted journals could not be saved/.test(error.message) && !error.message.includes('private-secret'));
  assert.equal(copyStops, 1); assert.equal(portfolioStops, 1); assert.equal(runtime.state, 'stopped');
  assert.equal(copy.ledgers.live.saves, 1); assert.equal(copy.ledgers.paper.saves, 1); assert.equal(portfolio.ledgers.paper.saves, 1);
  await assert.rejects(runtime.start(config(), 'copy'), /Check host storage/);
  assert.equal(copy.calls.length, 0);
});

test('manual copy actions select imported wallets, guard portfolio allocations and retain active run settings', async () => {
  const { runtime, copy, portfolio } = harness(), raw = config(), address = raw.wallets[0].publicKey;
  const trade = { id: 'manual-runtime-test', side: 'sell', mint: USDC, wallets: [address], sellPercent: '100' };
  await runtime.manualTrade(raw, trade);
  assert.equal(copy.calls.at(-1)[0], 'manualTrade'); assert.equal(runtime.state, 'stopped');
  await assert.rejects(runtime.manualTrade(raw, { ...trade, wallets: [Keypair.generate().publicKey.toBase58()] }), /imported follower/);
  portfolio.ledgers.live.data.lots.push(allocation(address));
  await assert.rejects(runtime.manualTrade(raw, trade), /portfolio allocations/);
  portfolio.ledgers.live.data.lots = []; portfolio.ledgers.live.data.pending = [{ wallet: address }];
  await assert.rejects(runtime.manualTrade(raw, trade), /portfolio allocations/);
  portfolio.ledgers.live.data.pending = [];
  await runtime.start(raw, 'copy');
  await assert.rejects(runtime.manualTrade({ ...raw, mode: 'paper' }, trade), /run mode changed/);
  await runtime.manualTrade({ ...raw, prioritySol: '1', rpcUrl: 'https://127.0.0.1' }, trade);
  assert.equal(copy.calls.at(-1)[1].mode, 'live'); assert.equal(copy.calls.at(-1)[1].prioritySol, raw.prioritySol);
  runtime.stop(); await runtime.start(config(), 'market');
  await assert.rejects(runtime.manualTrade(raw, trade), /portfolio strategy/); runtime.stop();
});

test('manual mutations retain the operation gate and Stop remains available during dispatch', async () => {
  const { runtime, copy } = harness(), raw = config();
  let finish;
  copy.manualTrade = async () => { copy.state = 'running'; await new Promise(resolve => { finish = resolve; }); };
  const trade = { id: 'manual-stop', side: 'sell', mint: USDC, wallets: [raw.wallets[0].publicKey], sellPercent: '100' };
  const pending = runtime.manualTrade(raw, trade); await tick();
  await assert.rejects(runtime.start(raw), /current operation/);
  await assert.rejects(runtime.manualTrade(raw, { ...trade, id: 'second' }), /current operation/);
  runtime.stop(); assert.equal(runtime.state, 'stopped'); finish(); await pending;
  assert.equal(runtime.operation, null);
});

test('worker protocol exposes manual trading without bypassing public endpoint protection or Stop-before-ready', async t => {
  const store = await storeFor(t), engine = new TelegramEngine(store); t.after(() => engine.close());
  const raw = config({ rpcUrl: 'https://127.0.0.1/private' }), trade = { id: 'guarded-manual', side: 'sell', mint: USDC, wallets: [raw.wallets[0].publicKey], sellPercent: '100' };
  const early = engine.manualTrade(raw, trade); engine.stop(); await assert.rejects(early, /stopped/);
  await engine.ready; await tick();
  await assert.rejects(engine.manualTrade(raw, { ...trade, id: 'guarded-ready' }), /public/);
  assert.equal(engine.state, 'stopped');
  await assert.rejects(engine.manualTrade(raw, { ...trade, id: 'old-review', expectedRunId: 'outdated' }), /run changed/);
});

test('read-only inventory refresh validates mainnet and uses only an RPC provider without trading initialization', async () => {
  const { copy, portfolio } = harness(); const configs = [], rpcMethods = []; let checks = 0;
  copy.refreshInventory = async options => {
    checks++; assert.equal(options.mode, 'live'); assert.equal(options.source, 'wallet-refresh'); assert.equal(options.signal.aborted, false);
    copy.inventoryRefresh = { state: 'idle', at: 123, mode: 'live' }; return { changed: 1, adjustments: [], skipped: 0 };
  };
  const runtime = new TelegramRuntime(copy, portfolio, { inventoryProviderFactory: config => {
    configs.push(config); return { async rpc(method) { rpcMethods.push(method); return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'; }, close() { this.closed = true; } };
  } });
  const first = await runtime.refreshInventory({ rpcUrl: 'https://rpc.example/?api-key=saved', rpcRequestsPerSecond: '8', privateKey: 'must-not-forward', leads: ['ignored'] });
  assert.equal(first.state, 'stopped'); assert.equal(first.mode, 'live'); assert.equal(first.views.copy.mode, 'live');
  await runtime.refreshInventory({ rpcUrl: 'https://rpc.example/?api-key=saved', rpcRequestsPerSecond: '8' });
  assert.equal(configs.length, 1); assert.deepEqual(configs[0], { rpcUrl: 'https://rpc.example/?api-key=saved', rpcRequestsPerSecond: 8, maxSignalAgeMs: 5000 });
  assert.deepEqual(rpcMethods, ['getGenesisHash']); assert.equal(checks, 2); assert.equal(copy.calls.length + portfolio.calls.length, 0);
  await runtime.close();
});

test('Stop and Start abort read-only RPC checks without blocking controls or applying inventory changes', async () => {
  const { copy, portfolio } = harness(); let rpcEntered, updates = 0;
  const entering = new Promise(resolve => { rpcEntered = resolve; });
  copy.refreshInventory = async () => { updates++; };
  const runtime = new TelegramRuntime(copy, portfolio, { inventoryProviderFactory: () => ({
    rpc(method, params, signal) { rpcEntered(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped.')), { once: true })); }, close() { this.closed = true; },
  }) });
  const refresh = runtime.refreshInventory({ rpcUrl: 'https://rpc.example' });
  const rejected = assert.rejects(refresh, /Stopped/); await entering;
  assert.equal(runtime.status().state, 'stopped'); runtime.stop(); assert.equal(runtime.status().state, 'stopped');
  await rejected; assert.equal(updates, 0); assert.equal(copy.inventoryRefresh.state, 'idle'); assert.equal(copy.inventoryRefresh.error, undefined);
  const second = runtime.refreshInventory({ rpcUrl: 'https://rpc.example' }), secondRejected = assert.rejects(second, /Stopped/); await tick();
  await runtime.start(config({ mode: 'paper' })); await secondRejected;
  assert.equal(runtime.state, 'running'); assert.equal(updates, 0); runtime.stop(); await runtime.close();
});

test('read-only refresh rejects private endpoints and non-mainnet RPC responses while preserving the previous success time', async () => {
  const { copy, portfolio } = harness(); copy.inventoryRefresh = { state: 'idle', at: 321, mode: 'live' }; let created = 0;
  const runtime = new TelegramRuntime(copy, portfolio, { inventoryProviderFactory: () => { created++; return { async rpc() { return 'devnet-hash'; }, close() {} }; } });
  await assert.rejects(runtime.refreshInventory({ rpcUrl: 'https://127.0.0.1/private' }), /public/); assert.equal(created, 0);
  await assert.rejects(runtime.refreshInventory({ rpcUrl: 'https://rpc.example' }), /other than Solana mainnet/);
  assert.equal(copy.inventoryRefresh.state, 'error'); assert.equal(copy.inventoryRefresh.at, 321); assert.equal(copy.calls.length, 0);
  await runtime.close();
});

test('cancelling a refresh before worker readiness prevents a delayed RPC command from starting afterward', async t => {
  const store = await storeFor(t), engine = new TelegramEngine(store); t.after(() => engine.close());
  const refreshing = engine.refreshInventory({ rpcUrl: 'https://127.0.0.1/should-never-be-used' });
  await engine.cancelInventoryRefresh(); await refreshing;
  assert.equal(engine.state, 'stopped'); assert.equal(engine.status().inventoryRefresh?.error, undefined);
  assert.equal(engine.status().positions.length, 0);
});
