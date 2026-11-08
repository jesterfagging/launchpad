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
import { config, key1, key2, mint } from './fixtures.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
class ManualEngine extends EventEmitter {
  constructor() {
    super(); this.state = 'stopped'; this.calls = []; this.runId = null;
    this.value = { state: 'stopped', kind: 'copy', mode: 'live', positions: [], pending: [], events: [], metrics: {} };
  }
  status() { return { ...this.value, state: this.state, runId: this.runId }; }
  async manualTrade(raw, trade) {
    this.calls.push({ raw, trade });
    if (this.block) {
      this.state = 'starting'; this.emit('change');
      await new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    }
    return { ...this.status(), manualResult: { id: trade.id, side: trade.side, outcomes: trade.wallets.map((wallet, index) => ({ wallet, status: index ? 'pending' : 'confirmed' })) } };
  }
  stop() { this.state = 'stopped'; this.reject?.(new Error('Operation stopped.')); this.emit('change'); }
  async close() { this.stop(); }
}
async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'launchpad-telegram-manual-')), master = randomBytes(32), sent = [], engines = [];
  const bot = await new TelegramBot({ root, master, hostStore: new TelegramStore(root, master), api: { call: async () => true },
    outbox: { send(id, text, keyboard) { sent.push({ id, text, keyboard }); } }, engineFactory: () => { const e = new ManualEngine(); engines.push(e); return e; } }).init();
  t.after(async () => { await bot.close(); await rm(root, { recursive: true, force: true }); });
  let seq = 0;
  const msg = (id, text) => bot.dispatch({ message: { message_id: ++seq, date: Math.floor(Date.now() / 1000), chat: { type: 'private', id }, from: { id }, text } });
  const click = (id, data) => bot.dispatch({ callback_query: { id: String(++seq), data, from: { id }, message: { message_id: seq, chat: { type: 'private', id }, text: 'menu' } } });
  const button = (id, name) => {
    const b = sent.toReversed().filter(s => s.id === String(id)).flatMap(s => s.keyboard?.flat() || []).find(b => typeof name === 'function' ? name(b.text) : b.text === name);
    assert.ok(b, `Button ${name} exists`); return b.callback_data;
  };
  const seed = async (id, extra = {}) => {
    const ctx = await bot.context(String(id)), settings = { ...structuredClone(defaults), ...config({ mode: 'live', wallets: [key1, key2] }), leads: '', ...extra };
    await bot.save(ctx, settings); ctx.tool = 'copy'; await bot.home(ctx); return ctx;
  };
  const open = async (id, side) => { await click(id, button(id, 'Manual buy/sell')); await click(id, button(id, side)); await msg(id, mint); };
  return { bot, sent, engines, seed, click, button, msg, open };
}

test('Telegram manual buy selects all imported wallets without leads or auto-start and reports pending separately', async t => {
  const h = await harness(t), id = 11001, ctx = await h.seed(id);
  await h.open(id, 'Buy'); await h.click(id, h.button(id, 'Select all')); await h.click(id, h.button(id, 'Continue')); await h.msg(id, '.05');
  assert.equal(h.engines.length, 0);
  assert.match(h.sent.at(-1).text, /2 wallets selected[\s\S]*0.05 SOL per wallet · 0.1 SOL total input/);
  const confirm = h.button(id, 'Confirm LIVE BUY');
  await h.click(id, confirm); await ctx.startTask;
  assert.equal(h.engines.length, 1); assert.equal(ctx.engine.calls.length, 1);
  const { raw, trade } = ctx.engine.calls[0];
  assert.equal(raw.leads, ''); assert.equal(trade.side, 'buy'); assert.equal(trade.mint, mint); assert.equal(trade.amountSol, '0.05');
  assert.deepEqual(trade.wallets, [key1.publicKey.toBase58(), key2.publicKey.toBase58()]);
  assert.match(h.sent.at(-1).text, /1 confirmed · 1 pending/); assert.match(h.sent.at(-1).text, /Pending is not confirmed/);
  await h.click(id, confirm); assert.equal(ctx.engine.calls.length, 1);
  assert.ok(!JSON.stringify(h.sent).includes(ctx.settings.wallets[0].privateKey));
});

test('running copy manual sell uses active wallets, run ID, fees and mode instead of stale saved settings', async t => {
  const h = await harness(t), id = 11002, ctx = await h.seed(id, { mode: 'paper', prioritySol: '0.9' });
  h.bot.ensureEngine(ctx); const engine = ctx.engine;
  engine.state = 'running'; engine.runId = 'active-run'; engine.value = { ...engine.value, mode: 'live', followers: [{ publicKey: key1.publicKey.toBase58(), label: 'First' }, { publicKey: key2.publicKey.toBase58(), label: 'Second' }], fees: { priority: '0.0003', jito: '0.0002', helius: '0' }, platformFees: { version: 'fee-v1', copyPpm: 2500 }, positions: [{ wallet: key1.publicKey.toBase58(), mint, remaining: '1000', balance: '0.001' }] };
  await h.open(id, 'Sell');
  const toggle = h.button(id, text => text.startsWith('☐ 2.'));
  await h.click(id, toggle); await h.click(id, h.button(id, 'Continue')); await h.click(id, h.button(id, '100%'));
  assert.match(h.sent.at(-1).text, /Review manual SELL · LIVE/);
  assert.match(h.sent.at(-1).text, /Priority 0.0003 · Jito 0.0002/); assert.match(h.sent.at(-1).text, /Platform fee: 0.25%/);
  await h.click(id, h.button(id, 'Confirm LIVE SELL')); await ctx.startTask;
  assert.equal(engine.calls.length, 1); assert.equal(engine.calls[0].raw.mode, 'live'); assert.equal(ctx.settings.mode, 'live'); assert.equal(engine.calls[0].trade.expectedRunId, 'active-run');
  assert.equal(engine.calls[0].trade.sellPercent, 100); assert.deepEqual(engine.calls[0].trade.wallets, [key2.publicKey.toBase58()]);
});

test('manual callbacks stay user-bound, cannot be replayed, and Stop invalidates the reviewed trade', async t => {
  const h = await harness(t), id = 11003, ctx = await h.seed(id), other = await h.seed(11004);
  await h.open(id, 'Buy');
  const toggle = h.button(id, text => text.startsWith('☐ 1.'));
  await h.click(id, toggle); await h.click(id, toggle);
  assert.equal(ctx.manualDraft.wallets.length, 1);
  await h.click(id, h.button(id, 'Continue')); await h.msg(id, '.001');
  const confirm = h.button(id, 'Confirm LIVE BUY');
  await h.click(11004, confirm); assert.equal(other.engine, null);
  await h.msg(id, '/stop'); await h.click(id, confirm);
  assert.equal(h.engines.length, 0); assert.equal(ctx.manualDraft, null);
});

test('settings edits and web run replacement invalidate manual confirmations before any submission', async t => {
  const h = await harness(t), id = 11005, ctx = await h.seed(id);
  await h.open(id, 'Buy'); await h.click(id, h.button(id, 'Select all')); await h.click(id, h.button(id, 'Continue')); await h.msg(id, '.02');
  const old = h.button(id, 'Confirm LIVE BUY');
  await h.msg(id, '/set prioritySol .0004'); await h.click(id, old); assert.equal(h.engines.length, 0);
  await h.bot.home(ctx); h.bot.ensureEngine(ctx); ctx.engine.state = 'running'; ctx.engine.runId = 'run-before';
  ctx.engine.value = { ...ctx.engine.value, followers: ctx.settings.wallets, fees: { priority: '.0004', jito: '0', helius: '0' } };
  await h.open(id, 'Buy'); await h.click(id, h.button(id, 'Select all')); await h.click(id, h.button(id, 'Continue')); await h.msg(id, '.02');
  ctx.engine.runId = 'run-after'; await h.click(id, h.button(id, 'Confirm LIVE BUY'));
  assert.equal(ctx.engine.calls.length, 0); assert.match(h.sent.at(-1).text, /run, wallets or fees changed/);
});

test('Stop bypasses an in-flight manual request and suppresses a false completion notice', async t => {
  const h = await harness(t), id = 11006, ctx = await h.seed(id);
  h.bot.ensureEngine(ctx); ctx.engine.block = true;
  await h.open(id, 'Buy'); await h.click(id, h.button(id, 'Select all')); await h.click(id, h.button(id, 'Continue')); await h.msg(id, '.01');
  await h.click(id, h.button(id, 'Confirm LIVE BUY')); await tick();
  assert.equal(ctx.engine.state, 'starting'); const task = ctx.startTask;
  await h.msg(id, '/stop'); await task;
  assert.equal(ctx.engine.state, 'stopped'); assert.equal(ctx.startTask, null);
  assert.ok(!h.sent.some(s => /\d confirmed · \d pending/.test(s.text)));
});

test('manual size validation rejects empty selection, invalid SOL amounts and invalid sell percentages', async t => {
  const h = await harness(t), id = 11007, ctx = await h.seed(id);
  await h.open(id, 'Buy'); await h.click(id, h.button(id, 'Continue')); assert.match(h.sent.at(-1).text, /Select at least one wallet/);
  await h.click(id, h.button(id, 'Select all')); await h.click(id, h.button(id, 'Continue'));
  for (const value of ['0', '-1', '1e9', '.0000000001', 'bad']) { await h.msg(id, value); assert.equal(ctx.manualDraft.amountSol, undefined); }
  assert.equal(h.engines.length, 0);
  await h.bot.home(ctx); await h.open(id, 'Sell'); await h.click(id, h.button(id, 'Select all')); await h.click(id, h.button(id, 'Continue'));
  for (const value of ['0', '100.1', '50.123', '-1', 'no']) { await h.msg(id, value); assert.equal(ctx.manualDraft.sellPercent, undefined); }
  await h.msg(id, '12.5'); assert.match(h.sent.at(-1).text, /12.5% of each selected wallet/);
});
