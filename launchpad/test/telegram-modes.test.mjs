import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { TelegramBot } from '../src/telegram-bot.mjs';
import { TelegramStore } from '../src/telegram-store.mjs';
import { defaults } from '../src/telegram-settings.mjs';
import { createPreset } from '../public/presets.mjs';
import { strategyDefaults } from '../public/strategy-settings.mjs';
import { SOL } from '../src/core.mjs';
import { config, key1, key2, mint, quote } from './fixtures.mjs';

const labels = ['Multiwallet / Copy trading', 'LP Management', 'Market Making'];
const kinds = ['copy', 'liquidity', 'market'];
const tick = () => new Promise(resolve => setImmediate(resolve));
const settings = (extra = {}) => {
  const c = config({ mode: 'live' });
  return {
    ...structuredClone(defaults), ...c, leads: c.leads.join('\n'),
    strategies: {
      market: { ...strategyDefaults(), baseMint: mint },
      liquidity: { ...strategyDefaults(), baseMint: quote },
    }, ...extra,
  };
};

class FakeEngine extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.kind = 'copy'; this.calls = []; this.value = { mode: 'live', positions: [], pending: [], events: [], metrics: {} }; }
  status() { return { ...this.value, kind: this.kind, state: this.state }; }
  async start(raw, kind = 'copy') {
    this.calls.push({ raw, kind }); this.kind = kind; this.value.mode = raw.mode; this.state = 'starting'; this.emit('change');
    await new Promise((resolve, reject) => {
      this.finishStart = () => { this.state = 'running'; this.emit('change'); resolve(); };
      this.failStart = reject;
    });
  }
  async withdraw(wallet, raw) { this.calls.push({ op: 'withdraw', wallet, raw }); this.kind = 'liquidity'; this.state = 'running'; this.emit('change'); return this.status(); }
  async claimFees(wallet, raw) { this.calls.push({ op: 'claimFees', wallet, raw }); this.kind = 'liquidity'; this.state = 'running'; this.emit('change'); return this.status(); }
  async release(id, mode) { this.calls.push({ op: 'release', id, mode }); return this.status(); }
  stop() { this.state = 'stopped'; this.failStart?.(new Error('Run stopped.')); this.emit('change'); }
  async close() { this.stop(); }
}

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'launchpad-telegram-modes-')), master = randomBytes(32), sent = [], calls = [], engines = [];
  const hostStore = new TelegramStore(root, master);
  const api = { async call(method, body) { calls.push({ method, body }); return true; }, async document() { return ''; } };
  const outbox = { send(id, text, keyboard) { sent.push({ id, text, keyboard }); } };
  const bot = await new TelegramBot({ root, master, hostStore, api, outbox, engineFactory: () => { const engine = new FakeEngine(); engines.push(engine); return engine; } }).init();
  t.after(async () => { await bot.close(); await rm(root, { recursive: true, force: true }); });
  let sequence = 0;
  const msg = async (id, text, extra = {}) => bot.dispatch({ update_id: ++sequence, message: { message_id: sequence, date: Math.floor(Date.now() / 1000), chat: { type: 'private', id }, from: { id, is_bot: false }, text, ...extra } });
  const callback = async (id, data) => bot.dispatch({ update_id: ++sequence, callback_query: { id: `cb${sequence}`, data, from: { id }, message: { message_id: sequence, date: Math.floor(Date.now() / 1000), chat: { type: 'private', id }, text: 'Menu' } } });
  const last = id => [...sent].reverse().find(s => s.id === String(id));
  const buttons = id => (last(id)?.keyboard || []).flat();
  const button = (id, label) => { const match = buttons(id).find(b => typeof label === 'string' ? b.text === label : label.test(b.text)); assert.ok(match, `Current menu contains ${label}; found: ${buttons(id).map(b => b.text).join(', ')}`); return match.callback_data; };
  const click = (id, label) => callback(id, button(id, label));
  const choose = async (id, kind) => { await msg(id, '/start'); await click(id, labels[kinds.indexOf(kind)]); };
  const seed = async (id, value = settings()) => { const ctx = await bot.context(String(id)); await bot.save(ctx, value); return ctx; };
  return { root, bot, sent, calls, api, engines, msg, callback, last, buttons, button, click, choose, seed };
}

test('/start always offers four modes and /run cannot launch before selection', async t => {
  const h = await harness(t), id = 9101, ctx = await h.seed(id);
  assert.equal(ctx.tool, null);
  await h.msg(id, '/run');
  assert.deepEqual(h.last(id).keyboard.map(row => row.map(b => b.text)), [...labels, 'Launch Sniping', 'Tutorial · RPCs & API keys'].map(label => [label]));
  assert.equal(h.engines.length, 0);
  await h.click(id, 'Market Making'); assert.equal(ctx.tool, 'market');
  await h.msg(id, '/start');
  assert.deepEqual(h.last(id).keyboard.map(row => row.map(b => b.text)), [...labels, 'Launch Sniping', 'Tutorial · RPCs & API keys'].map(label => [label]));
  assert.equal(ctx.tool, null);
  await h.msg(id, '/run'); assert.equal(h.engines.length, 0);
});

test('each mode has its own menu and portfolio modes do not ask for lead or copy-buy settings', async t => {
  const h = await harness(t), id = 9102; await h.seed(id);
  for (const kind of ['market', 'liquidity']) {
    await h.choose(id, kind);
    const visible = h.buttons(id).map(b => b.text);
    for (const label of ['Wallets', 'Pair & budget', 'Presets', 'Advanced settings', 'Connections', 'Positions', 'Activity', 'Import full setup JSON', 'Forget credentials', '‹ Modes']) assert.ok(visible.includes(label), `${kind}: ${label}`);
    for (const label of ['Target addresses', 'Buy', 'Sell', 'Pairs & limits']) assert.ok(!visible.includes(label), `${kind} hides ${label}`);
  }
  await h.choose(id, 'copy');
  for (const label of ['Target addresses', 'Buy', 'Sell', 'Fees', 'Connections', '‹ Modes']) assert.ok(h.buttons(id).some(b => b.text === label));
});

test('a new portfolio user imports wallets and configures pair, budget and preset entirely through the menu', async t => {
  const h = await harness(t), id = 9103;
  await h.choose(id, 'market'); await h.click(id, 'Wallets'); await h.click(id, 'Import private keys');
  const secret = JSON.stringify([...key1.secretKey]); await h.msg(id, secret);
  const ctx = h.bot.users.get(String(id));
  assert.equal(ctx.settings.leads, ''); assert.equal(ctx.settings.wallets[0].privateKey, secret);
  await h.click(id, 'Pair & budget'); await h.click(id, /^Token mint:/); await h.msg(id, mint);
  await h.msg(id, '/settings'); await h.click(id, 'Pair & budget'); await h.click(id, /^Quote token mint:/); await h.msg(id, quote);
  await h.msg(id, '/settings'); await h.click(id, 'Pair & budget'); await h.click(id, /^Budget per wallet \(SOL\):/); await h.msg(id, '2.5');
  await h.msg(id, '/settings'); await h.click(id, 'Presets');
  for (const name of ['Conservative', 'Balanced', 'Active']) assert.ok(h.buttons(id).some(b => b.text === name));
  await h.click(id, 'Conservative');
  assert.equal(ctx.settings.strategies.market.baseMint, mint); assert.equal(ctx.settings.strategies.market.quoteMint, quote);
  assert.equal(ctx.settings.strategies.market.budgetSol, '2.5'); assert.equal(ctx.settings.strategies.market.preset, 'conservative');
  assert.equal(ctx.settings.strategies.market.advanced, false);
  assert.equal(ctx.settings.strategies.liquidity.baseMint, '');
  await h.msg(id, '/set heliusKey onboarding-helius'); await h.msg(id, '/set jupiterKey onboarding-jupiter');
  await h.msg(id, '/run'); await h.click(id, '▶ Start LIVE'); await tick();
  assert.equal(ctx.engine.calls[0].kind, 'market'); assert.deepEqual(ctx.engine.calls[0].raw.leads, []);
  assert.equal(ctx.engine.calls[0].raw.strategy.budgetSol, '2.5');
  assert.ok(!JSON.stringify(h.sent).includes(secret));
});

test('Advanced controls edit wallet budgets, tuning and fees without changing the other strategy or copy-buy amounts', async t => {
  const h = await harness(t), id = 9104, ctx = await h.seed(id);
  const originalLiquidity = structuredClone(ctx.settings.strategies.liquidity), originalBuy = ctx.settings.wallets[0].amount;
  await h.choose(id, 'market'); await h.click(id, 'Advanced settings'); await h.click(id, 'Enable Advanced');
  await h.msg(id, '/settings'); await h.click(id, 'Advanced settings');
  for (const label of ['Per-wallet budgets', 'Fees & tips', 'Allocation & limits', 'Execution settings']) assert.ok(h.buttons(id).some(b => b.text === label));
  assert.ok(!h.buttons(id).some(b => b.text === 'Pool settings'));
  await h.click(id, 'Per-wallet budgets'); await h.click(id, /^1\. /); await h.click(id, 'Set wallet budget'); await h.msg(id, '4.2');
  assert.equal(ctx.settings.strategies.market.walletBudgets[0], '4.2'); assert.equal(ctx.settings.wallets[0].amount, originalBuy);
  await h.msg(id, '/settings'); await h.click(id, 'Advanced settings'); await h.click(id, 'Allocation & limits'); await h.click(id, /^Budget deployed %:/); await h.msg(id, '65');
  assert.equal(ctx.settings.strategies.market.tuning.deployPercent, 65);
  await h.msg(id, '/settings'); await h.click(id, 'Advanced settings'); await h.click(id, 'Fees & tips'); await h.click(id, /^Priority fee \(SOL\):/); await h.msg(id, '.0003');
  assert.equal(ctx.settings.prioritySol, '.0003'); assert.deepEqual(ctx.settings.strategies.liquidity, originalLiquidity);
  await h.msg(id, '/settings'); await h.click(id, 'Presets'); await h.click(id, 'Active');
  assert.equal(ctx.settings.strategies.market.preset, 'active'); assert.deepEqual(ctx.settings.strategies.market.tuning, {});
  assert.equal(ctx.settings.strategies.market.walletBudgets[0], '4.2');
});

test('market and liquidity launch the selected strategy with no lead and preserve saved credentials', async t => {
  const h = await harness(t);
  for (const [index, kind] of ['market', 'liquidity'].entries()) {
    const id = 9110 + index, ctx = await h.seed(id, settings({ leads: '' }));
    const original = structuredClone(ctx.settings);
    await h.choose(id, kind); await h.msg(id, '/run');
    await h.click(id, '▶ Start LIVE'); await tick();
    assert.equal(ctx.engine.calls.length, 1);
    assert.equal(ctx.engine.calls[0].kind, kind);
    assert.deepEqual(ctx.engine.calls[0].raw.strategy, original.strategies[kind]);
    assert.equal(ctx.engine.calls[0].raw.wallets[0].privateKey, original.wallets[0].privateKey);
    assert.deepEqual(ctx.settings, original, 'review/start cannot erase saved private keys');
    await h.msg(id, '/stop'); await ctx.startTask;
  }
});

test('mode changes invalidate old Start and edit buttons, clear prompts, and keep mode tokens user-bound', async t => {
  const h = await harness(t), id = 9121, ctx = await h.seed(id);
  await h.choose(id, 'copy');
  const leadEdit = h.button(id, 'Target addresses');
  await h.msg(id, '/run'); const start = h.button(id, '▶ Start LIVE');
  await h.choose(id, 'market');
  await h.callback(id, start); assert.equal(h.engines.length, 0);
  await h.callback(id, leadEdit); assert.equal(ctx.prompt, null);
  await h.choose(id, 'copy'); await h.callback(id, start); assert.equal(h.engines.length, 0, 'returning to a mode must not revive its old Start');
  await h.msg(id, '/settings'); await h.click(id, 'Target addresses'); assert.ok(ctx.prompt);
  await h.choose(id, 'liquidity'); assert.equal(ctx.prompt, null);
  const original = structuredClone(ctx.settings); await h.msg(id, quote); assert.deepEqual(ctx.settings, original);
  await h.msg(id, '/start'); const mode = h.button(id, 'Market Making');
  const other = await h.seed(9122); await h.callback(9122, mode); assert.equal(other.tool, null);
});

test('switching menus preserves the active strategy; edits and a second launch are blocked, and old Stop works globally', async t => {
  const h = await harness(t), id = 9131, ctx = await h.seed(id, settings({ leads: '' }));
  await h.choose(id, 'liquidity'); await h.msg(id, '/run'); await h.click(id, '▶ Start LIVE'); await tick();
  const stop = h.button(id, '⏹ Stop');
  await h.msg(id, '/start'); assert.ok(h.buttons(id).some(b => b.text === '⏹ Stop'));
  await h.click(id, 'Market Making'); assert.equal(ctx.tool, 'market'); assert.equal(ctx.engine.kind, 'liquidity');
  assert.equal(ctx.engine.state, 'starting');
  await h.msg(id, '/set prioritySol .004');
  assert.equal(ctx.settings.prioritySol, '0.0001');
  await h.msg(id, '/run'); assert.equal(ctx.engine.calls.length, 1);
  await h.callback(id, stop); await ctx.startTask;
  assert.equal(ctx.engine.state, 'stopped');
});

test('full setup imports preserve independent strategies and shared credentials without echoing secrets', async t => {
  const h = await harness(t), id = 9141, ctx = await h.seed(id);
  const value = settings({ leads: '', heliusKey: 'test-helius-secret', jupiterKey: 'test-jupiter-secret', rpcUrl: 'https://rpc.example/?api-key=test-rpc-secret' });
  value.strategies.market.preset = 'active'; value.strategies.market.walletBudgets = { 0: '2' };
  value.strategies.liquidity.preset = 'conservative'; value.strategies.liquidity.budgetSol = '3';
  await h.choose(id, 'market'); await h.click(id, 'Import full setup JSON');
  h.api.document = async () => JSON.stringify(createPreset(value));
  await h.msg(id, '', { document: { file_id: 'setup', file_name: 'setup.json', file_size: 4000 } });
  assert.deepEqual(ctx.settings.strategies, value.strategies);
  assert.equal(ctx.settings.wallets[0].privateKey, value.wallets[0].privateKey);
  await h.choose(id, 'liquidity'); await h.click(id, 'Connections');
  const output = JSON.stringify(h.sent);
  for (const secret of [value.wallets[0].privateKey, value.heliusKey, value.jupiterKey, 'test-rpc-secret']) assert.ok(!output.includes(secret));
  assert.ok(h.calls.some(c => c.method === 'deleteMessage'));
});

test('portfolio holdings and pending transactions block wallet removal and imports omitting the wallet in every mode', async t => {
  const h = await harness(t), id = 9151, ctx = await h.seed(id), publicKey = key1.publicKey.toBase58();
  await ctx.store.write('portfolio-live', { lots: [{ id: 'allocated', wallet: publicKey, kind: 'liquidity', baseMint: mint, quoteMint: quote, tokens: { [SOL]: '0' }, decimals: { [SOL]: 9 }, budget: '1000000000', position: { venue: 'pumpswap', id: mint } }], pending: [], events: [], trades: 0 });
  await h.choose(id, 'copy'); await h.click(id, 'Wallets'); await h.click(id, /^1\. /); await h.click(id, 'Remove wallet');
  assert.equal(ctx.settings.wallets.length, 1); assert.equal(ctx.settings.wallets[0].publicKey, publicKey);
  // A pending operation also protects the key when the LP record has not yet
  // been credited. Test this independently of an already-open position.
  await ctx.store.write('portfolio-live', { lots: [], pending: [{ wallet: publicKey, signature: 'unresolved', order: { kind: 'deposit' } }], events: [], trades: 0 });
  await h.choose(id, 'market'); await h.click(id, 'Import full setup JSON');
  h.api.document = async () => JSON.stringify(createPreset(settings({ wallets: config({ mode: 'live', wallets: [key2] }).wallets })));
  await h.msg(id, '', { document: { file_id: 'omitted', file_name: 'setup.json', file_size: 4000 } });
  assert.equal(ctx.settings.wallets[0].publicKey, publicKey);
  assert.ok(h.sent.some(s => /omits a wallet/.test(s.text)));
});

test('removing an unallocated wallet keeps each remaining wallet’s budget attached in both modes', async t => {
  const h = await harness(t), id = 9152;
  const value = settings({ wallets: config({ mode: 'live', wallets: [key1, key2] }).wallets });
  value.strategies.market.walletBudgets = { 0: '1', 1: '4' };
  value.strategies.liquidity.walletBudgets = { 0: '2', 1: '5' };
  const ctx = await h.seed(id, value);
  await h.choose(id, 'copy'); await h.click(id, 'Wallets'); await h.click(id, /^1\. /); await h.click(id, 'Remove wallet');
  assert.deepEqual(ctx.settings.wallets.map(w => w.publicKey), [key2.publicKey.toBase58()]);
  assert.deepEqual(ctx.settings.strategies.market.walletBudgets, { 0: '4' });
  assert.deepEqual(ctx.settings.strategies.liquidity.walletBudgets, { 0: '5' });
});

test('LP withdrawal is reviewed for its wallet and stale cross-mode confirmations cannot submit it', async t => {
  const h = await harness(t), id = 9161, ctx = await h.seed(id);
  const wallet = key1.publicKey.toBase58();
  await ctx.store.write('portfolio-live', {
    lots: [{ id: 'lp-owned', wallet, walletLabel: 'Wallet 1', kind: 'liquidity', baseMint: mint, quoteMint: SOL, budget: '1000000000', tokens: { [SOL]: '300000000' }, decimals: { [SOL]: 9 }, position: { id: quote, venue: 'pumpswap' } }],
    pending: [], events: [], trades: 0,
  });
  await h.choose(id, 'liquidity'); await h.click(id, 'Positions'); await h.click(id, /^1\. Manage /); await h.click(id, 'Withdraw to wallet');
  const stale = h.button(id, 'Confirm withdrawal');
  assert.equal(h.engines.length, 0, 'reviewing does not create a worker or submit a transaction');
  await h.choose(id, 'market'); await h.callback(id, stale); assert.equal(h.engines.length, 0);
  await h.choose(id, 'liquidity'); await h.click(id, 'Positions'); await h.click(id, /^1\. Manage /); await h.click(id, 'Withdraw to wallet'); await h.click(id, 'Confirm withdrawal'); await tick();
  assert.equal(ctx.engine.calls.length, 1); assert.equal(ctx.engine.calls[0].op, 'withdraw');
  assert.deepEqual(ctx.engine.calls[0].wallet, { wallet, id: 'lp-owned' }); assert.equal(ctx.engine.calls[0].raw.wallets[0].privateKey, ctx.settings.wallets[0].privateKey);
});

test('Telegram LP fee claims preserve the selected position and are single-use; auto-compound settings persist', async t => {
  const h = await harness(t), id = 9181, ctx = await h.seed(id), wallet = key1.publicKey.toBase58();
  const position = { id: quote, venue: 'Meteora DLMM', position: mint };
  await ctx.store.write('portfolio-live', { lots: [{ id: 'claim-owned', wallet, walletLabel: 'Wallet 1', kind: 'liquidity', baseMint: mint, quoteMint: SOL, budget: '1000000000', tokens: { [SOL]: '300000000' }, decimals: { [SOL]: 9 }, position }], pending: [], events: [], trades: 0 });
  await h.choose(id, 'liquidity'); await h.click(id, 'Pair & budget'); await h.click(id, /^Auto-compound/); await h.msg(id, 'true');
  assert.equal(ctx.settings.strategies.liquidity.autoCompoundFees, true);
  await h.msg(id, '/settings'); await h.click(id, 'Positions'); await h.click(id, /^1\. Manage /); await h.click(id, 'Claim fees to wallet');
  assert.equal(h.engines.length, 0); assert.match(h.last(id).text, /position stays open/);
  const confirm = h.button(id, 'Confirm fee claim'); await h.callback(id, confirm); await tick(); await h.callback(id, confirm); await tick();
  assert.equal(ctx.engine.calls.length, 1); assert.equal(ctx.engine.calls[0].op, 'claimFees'); assert.deepEqual(ctx.engine.calls[0].wallet, { wallet, id: 'claim-owned' });
  assert.deepEqual((await ctx.store.read('portfolio-live')).lots[0].position, position);
});

test('release targets the reviewed allocation and mode; a new pending transaction invalidates the confirmation', async t => {
  const h = await harness(t), id = 9162, ctx = await h.seed(id), wallet = key1.publicKey.toBase58();
  const book = { lots: [{ id: 'market-owned', wallet, kind: 'market', baseMint: mint, quoteMint: SOL, budget: '1000000000', tokens: { [SOL]: '1000000000' }, decimals: { [SOL]: 9 } }], pending: [], events: [], trades: 0 };
  await ctx.store.write('portfolio-live', book);
  await h.choose(id, 'market'); await h.click(id, 'Positions'); await h.click(id, /^1\. Manage /); await h.click(id, 'Release allocation');
  const stale = h.button(id, 'Confirm release');
  book.pending.push({ wallet, signature: 'pending-now', order: { kind: 'rebalance' } }); await ctx.store.write('portfolio-live', book);
  await h.callback(id, stale); assert.equal(h.engines.length, 0);
  book.pending = []; await ctx.store.write('portfolio-live', book);
  await h.msg(id, '/settings'); await h.click(id, 'Positions'); await h.click(id, /^1\. Manage /); await h.click(id, 'Release allocation'); await h.click(id, 'Confirm release'); await tick();
  assert.deepEqual(ctx.engine.calls, [{ op: 'release', id: 'market-owned', mode: 'live' }]);
});

for (const operation of ['withdrawal', 'release']) {
  test(`Stop while ${operation} confirmation reads its allocation prevents the operation from restarting`, async t => {
    const h = await harness(t), id = operation === 'withdrawal' ? 9171 : 9172;
    const ctx = await h.seed(id), wallet = key1.publicKey.toBase58(), kind = operation === 'withdrawal' ? 'liquidity' : 'market';
    await ctx.store.write('portfolio-live', {
      lots: [{ id: 'stop-race', wallet, kind, baseMint: mint, quoteMint: SOL, budget: '1000000000', tokens: { [SOL]: '300000000' }, decimals: { [SOL]: 9 },
        ...(operation === 'withdrawal' ? { position: { id: quote, venue: 'pumpswap' } } : {}) }],
      pending: [], events: [], trades: 0,
    });
    await h.choose(id, kind); await h.click(id, 'Positions'); await h.click(id, /^1\. Manage /);
    await h.click(id, operation === 'withdrawal' ? 'Withdraw to wallet' : 'Release allocation');
    const confirmation = h.button(id, operation === 'withdrawal' ? 'Confirm withdrawal' : 'Confirm release');
    const originalRead = ctx.store.read.bind(ctx.store);
    let enteredRead, releaseRead;
    const reading = new Promise(resolve => { enteredRead = resolve; });
    const heldRead = new Promise(resolve => { releaseRead = resolve; });
    ctx.store.read = async (name, ...args) => {
      if (name === 'portfolio-live') { enteredRead(); await heldRead; }
      return originalRead(name, ...args);
    };
    const confirming = h.callback(id, confirmation);
    await reading;
    try {
      await h.msg(id, '/stop');
      assert.equal(h.engines.length, 0);
    } finally { releaseRead(); }
    await confirming; await tick();
    assert.equal(h.engines.length, 0, 'a metadata read completing after Stop must not create a trading worker');
    assert.equal(ctx.startTask, null);
    assert.ok(!h.sent.some(s => /Preparing withdrawal|Releasing the allocation/.test(s.text)));
  });
}

test('Telegram sniping edits and fee previews stay separate from copy settings', async t => {
  const h = await harness(t), id = 9190, ctx = await h.seed(id);
  await h.msg(id, '/start'); await h.click(id, 'Launch Sniping');
  assert.equal(ctx.tool, 'sniper'); assert(h.buttons(id).some(b => b.text.startsWith('Developer wallets')));
  await h.msg(id, '/set leads ' + key2.publicKey.toBase58());
  await h.msg(id, '/set buyAmount 0.2'); await h.msg(id, '/set prioritySol 0.0007');
  assert.equal(ctx.settings.sniper.developers, key2.publicKey.toBase58()); assert.equal(ctx.settings.sniper.buyAmount, '0.2');
  assert.equal(ctx.settings.buyAmount, '0.05'); assert.notEqual(ctx.settings.leads, key2.publicKey.toBase58());
  assert.equal(h.bot.manualContext(ctx).fees.priority, '0.0007');
  await h.msg(id, '/run'); assert.match(h.last(id).text, /0\.2 SOL/);
  await h.click(id, '▶ Start LIVE'); await tick();
  assert.equal(ctx.engine.calls[0].kind, 'sniper'); assert.equal(ctx.engine.calls[0].raw.sniper.buyAmount, '0.2');
  await h.msg(id, '/stop'); await ctx.startTask;
  await h.choose(id, 'copy'); assert.equal(h.bot.manualContext(ctx).fees.priority, ctx.settings.prioritySol);
});

test('Telegram LP setups persist separate budgets and cannot be changed by duplicate or stale buttons', async t => {
  const h = await harness(t), id = 9191, ctx = await h.seed(id);
  await h.choose(id, 'liquidity'); await h.click(id, 'LP position setups');
  const add = h.button(id, '+ Add LP position'); await h.callback(id, add); const first = ctx.lpEditId;
  assert.equal(ctx.settings.liquidityPlans.length, 1);
  await h.callback(id, add); assert.equal(ctx.settings.liquidityPlans.length, 1); assert.match(h.last(id).text, /expired/);
  await h.choose(id, 'liquidity'); const oldRemove = h.button(id, 'Remove setup');
  await h.bot.action(ctx, 'strategySet', { key: 'budgetSol', value: '2' });
  assert.equal(ctx.settings.liquidityPlans[0].strategy.budgetSol, '2');
  await h.bot.action(ctx, 'lpSetups'); await h.click(id, '+ Add LP position'); const second = ctx.lpEditId;
  assert.notEqual(first, second); assert.equal(ctx.settings.liquidityPlans.length, 2);
  await h.callback(id, oldRemove); assert.equal(ctx.settings.liquidityPlans.length, 2);
  ctx.lpEditId = undefined; await h.choose(id, 'liquidity'); assert.equal(ctx.lpEditId, first);
  await h.click(id, 'LP position setups'); await h.click(id, /LP position 2/); assert.equal(ctx.lpEditId, second);
  await h.bot.action(ctx, 'strategySet', { key: 'baseMint', value: mint });
  assert.equal(ctx.settings.liquidityPlans[0].strategy.baseMint, quote); assert.equal(ctx.settings.liquidityPlans[1].strategy.baseMint, mint);
  await h.bot.action(ctx, 'wallet', { index: 0 }); assert.match(h.last(id).text, /2 LP setups · 3 SOL/);
  assert(!h.buttons(id).some(b => b.text === 'Set wallet budget'));
});
