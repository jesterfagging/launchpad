import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Engine } from '../src/engine.mjs';
import { PortfolioEngine } from '../src/portfolio.mjs';
import { TelegramRuntime } from '../src/telegram-worker.mjs';
import { RobinhoodEngine } from '../src/robinhood-engine.mjs';
import { RobinhoodExecutor } from '../src/robinhood-executor.mjs';
import { TelegramBot } from '../src/telegram-bot.mjs';
import { RunErrorStop, tradingIssue } from '../src/run-error-stop.mjs';

const ledger = () => ({ data: { lots: [], pending: [], events: [], seen: [], feeReceipts: [], manualRequests: [] }, async save() {}, addEvent(event) { this.data.events.unshift(event); } });
const ledgers = () => ({ live: ledger(), paper: ledger() });
const wallet = { publicKey: '0x1111111111111111111111111111111111111111' };

test('Robinhood first failure synchronously stops queued trades and retains pending receipts and holdings', async t => {
  const book = ledger(), runtime = new RobinhoodEngine(book, {}, 'market');
  t.after(() => clearInterval(runtime.reconcileTimer));
  runtime.abort = new AbortController(); runtime.state = 'running';
  runtime.executor = new RobinhoodExecutor({ client: {} }, book, { signal: runtime.abort.signal });
  book.data.pending.push({ wallet: wallet.publicKey, signature: 'broadcast' });
  book.data.lots.push({ wallet: wallet.publicKey, remaining: '123' });
  const guard = new RunErrorStop(runtime); guard.arm();
  let attempted = 0;
  const jobs = [runtime.enqueue(wallet, async () => { attempted++; throw Error('Insufficient ETH'); }), runtime.enqueue(wallet, async () => { attempted++; })];
  await Promise.allSettled(jobs);
  assert.equal(attempted, 1); assert.equal(runtime.state, 'stopping'); assert.equal(runtime.abort.signal.aborted, true);
  assert.equal(book.data.pending.length, 1); assert.equal(book.data.lots[0].remaining, '123');
  assert.match(guard.status().stopReason.message, /balance and budget/);
  const first = guard.reason;
  runtime.event('error', 'Another wallet failed with code 0x1234');
  assert.equal(guard.reason, first);
});

for (const kind of ['copy', 'market']) test(`Solana ${kind} worker cancels its queue and still reconciles after an error`, async () => {
  const copy = new Engine(ledgers()), portfolio = new PortfolioEngine(ledgers());
  const runtime = new TelegramRuntime(copy, portfolio); runtime.kind = kind;
  const selected = kind === 'copy' ? copy : portfolio;
  selected.c = { mode: 'live', wallets: [] }; selected.ledger = selected.ledgers.live;
  selected.state = 'running'; selected.accepting = true; selected.abort = new AbortController();
  selected.ledger.data.pending.push({ signature: 'broadcast', wallet: 'test', order: { kind: 'buy' } });
  let reconciled = 0, attempted = 0; selected.reconcileAll = async () => { reconciled++; };
  const guard = new RunErrorStop(runtime); guard.arm();
  const jobs = [selected.enqueue(wallet, async () => { attempted++; throw Error('RPC unavailable'); }), selected.enqueue(wallet, async () => { attempted++; })];
  await Promise.allSettled(jobs); await selected.stopPromise;
  assert.equal(attempted, 1); assert.equal(selected.accepting, false); assert.equal(runtime.state, 'stopped');
  assert.equal(reconciled, 1); assert.equal(selected.ledger.data.pending.length, 1);
  assert.match(guard.reason.message, /network connection/);
});

test('old journal errors do not stop a new run; only a deliberate restart rearms the guard', () => {
  const runtime = new EventEmitter();
  runtime.value = { state: 'running', events: [{ id: 'old', at: 1, level: 'error', message: 'old failure' }], views: { paper: { events: [{ id: 'old-paper', level: 'error' }] } } };
  let stops = 0; runtime.status = () => runtime.value;
  runtime.stop = () => { stops++; runtime.value.state = 'stopped'; runtime.emit('change'); };
  const guard = new RunErrorStop(runtime); guard.arm(); runtime.emit('change'); assert.equal(stops, 0);
  runtime.value.events.unshift({ id: 'new', at: 2, level: 'error' }); runtime.emit('change'); assert.equal(stops, 1);
  runtime.emit('change'); assert.equal(stops, 1);
  runtime.value.state = 'running'; guard.arm(); runtime.emit('change'); assert.equal(guard.reason, null); assert.equal(stops, 1);
  runtime.value.events.unshift({ id: 'next', at: 3, level: 'error' }); runtime.emit('change'); assert.equal(stops, 2);
  runtime.value.state = 'stopping'; guard.arm(); guard.disarm();
  runtime.value.events.unshift({ id: 'after-user-stop', level: 'error' }); runtime.emit('change'); assert.equal(stops, 2);
});

test('Telegram sends one plain-language stop notice per failed tool while healthy tools keep running', t => {
  const now = Date.now(), sent = [], states = Object.fromEntries(['copy', 'market', 'liquidity', 'sniper'].map(kind => [kind, { kind, state: 'stopped', events: [] }]));
  states.copy.state = 'running'; states.market.state = 'stopping';
  const reason = { id: 'error-1', at: now, message: tradingIssue('RPC code 0x1234') };
  states.market.stopReason = reason;
  states.market.events = Array.from({ length: 5 }, (_, i) => ({ id: `error-${i}`, at: now, level: 'error', message: 'RPC code 0x1234', wallet: `wallet${i}` }));
  const ctx = { id: 'test', chain: 'robinhood', tool: 'market', engine: { status: kind => kind ? states[kind] : { concurrent: true, state: states.copy.state } }, seen: new Set(), notices: [{ kind: 'market', text: 'old error' }], actions: new Map(), lastState: 'running' };
  const bot = { now: () => now, say: (_, text) => sent.push(text), homeButton: () => ({}), notifyRunFailure: TelegramBot.prototype.notifyRunFailure };
  t.after(() => clearTimeout(ctx.noticeTimer));
  TelegramBot.prototype.changed.call(bot, ctx);
  assert.equal(sent.length, 1); assert.match(sent[0], /Market Making stopped new trades/); assert.doesNotMatch(sent[0], /0x1234|wallet[0-9]/);
  assert.equal(states.copy.state, 'running'); assert.equal(ctx.notices.length, 0);
  states.market.state = 'stopped';
  states.market.events.unshift({ id: 'later-error', at: now, level: 'error', message: 'Same failure' });
  TelegramBot.prototype.changed.call(bot, ctx); assert.equal(sent.length, 1);
  // A fresh run can fail with the same cause and must still receive its notice.
  states.market.stopReason = { ...reason, id: 'second-run-error' };
  TelegramBot.prototype.changed.call(bot, ctx); assert.equal(sent.length, 2);
  states.copy.state = 'stopped'; TelegramBot.prototype.changed.call(bot, ctx);
  assert.equal(sent.length, 2, 'No duplicate generic Stopped notification');
});

test('repeated wallet warnings are batched once and public failure text never echoes diagnostic payloads', t => {
  const now = Date.now(), status = { kind: 'copy', state: 'running', events: [] };
  const ctx = { id: 'test', tool: 'copy', engine: { status: () => status }, seen: new Set(), notices: [], actions: new Map(), lastState: 'running' };
  const bot = { now: () => now, say: () => {}, homeButton: () => ({}), notifyRunFailure: TelegramBot.prototype.notifyRunFailure };
  t.after(() => clearTimeout(ctx.noticeTimer));
  for (let i = 0; i < 5; i++) status.events.push({ id: `warn-${i}`, at: now, level: 'warn', message: 'Wallet paused while a previous transaction outcome is unresolved.', wallet: `wallet${i}` });
  TelegramBot.prototype.changed.call(bot, ctx); assert.equal(ctx.notices.length, 1);
  status.events.push({ id: 'warn-new-id', at: now, level: 'warn', message: status.events[0].message });
  TelegramBot.prototype.changed.call(bot, ctx); assert.equal(ctx.notices.length, 1);
  assert.doesNotMatch(tradingIssue('execution reverted: 0x1234 https://rpc.example/key-secret'), /0x1234|key-secret|rpc\.example/);
});

test('opening Telegram does not replay recent historical errors from the account journal', () => {
  const now = Date.now(), status = { kind: 'market', state: 'stopped', events: [{ id: 'old', at: now - 1, level: 'error', message: 'old failure' }] };
  const ctx = { id: 'test', engine: { status: () => status }, seen: new Set(), notices: [], actions: new Map(), lastState: null };
  const bot = { now: () => now, say: () => assert.fail('Historical errors must not be replayed'), homeButton: () => ({}), notifyRunFailure: TelegramBot.prototype.notifyRunFailure };
  TelegramBot.prototype.changed.call(bot, ctx); TelegramBot.prototype.changed.call(bot, ctx);
  assert.equal(ctx.notices.length, 0); assert.equal(ctx.noticeTimer, undefined);
});
