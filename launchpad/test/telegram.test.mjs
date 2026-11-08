import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { PassThrough, Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { TelegramStore, TelegramLedger, userKey, loadMasterKey } from '../src/telegram-store.mjs';
import { TelegramBot } from '../src/telegram-bot.mjs';
import { TelegramApi, TelegramOutbox, pollTelegram } from '../src/telegram-api.mjs';
import { TelegramEngine } from '../src/telegram-engine.mjs';
import { defaults, fields, importWallets, importSettings, parseField, validateSettings, redact } from '../src/telegram-settings.mjs';
import { isPublicAddress, publicEndpoint, safeLookup, installTelegramNetworkGuard } from '../src/telegram-network.mjs';
import { settingIds, createPreset } from '../public/presets.mjs';
import { config, key1, key2, lead } from './fixtures.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const preset = (options = {}) => { const c = config({ mode: 'live', ...options }); return { ...structuredClone(defaults), ...c, leads: c.leads.join('\n') }; };
class FakeEngine extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.calls = []; this.value = { state: 'stopped', kind: 'copy', mode: 'live', positions: [], pending: [], events: [], metrics: {} }; }
  status() { return { ...this.value, state: this.state }; }
  async start(raw) { this.calls.push(raw); this.state = 'starting'; this.emit('change'); await new Promise((resolve, reject) => { this.finishStart = () => { this.state = 'running'; this.emit('change'); resolve(); }; this.failStart = reject; }); }
  stop() { this.state = 'stopped'; this.failStart?.(new Error('Run stopped.')); this.emit('change'); }
  async close() { this.stop(); }
}
async function harness(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'launchpad-telegram-test-')), master = randomBytes(32), sent = [], calls = [];
  const hostStore = new TelegramStore(root, master), api = { async call(method, body) { calls.push({ method, body }); return true; }, async document() { return ''; } };
  const engines = [], outbox = { send(id, text, keyboard) { sent.push({ id, text, keyboard }); } };
  const bot = await new TelegramBot({ root, master, hostStore, api, outbox, engineFactory: () => { const engine = new FakeEngine(); engines.push(engine); return engine; }, ...extra }).init();
  t.after(async () => { await bot.close(); await rm(root, { recursive: true, force: true }); });
  let sequence = 0;
  const msg = async (id, text, extras = {}) => bot.dispatch({ update_id: ++sequence, message: { message_id: sequence, date: Math.floor(Date.now()/1000), chat: { type: 'private', id }, from: { id, is_bot: false }, text, ...extras } });
  const callback = async (id, data) => bot.dispatch({ update_id: ++sequence, callback_query: { id: `cb${sequence}`, data, from: { id }, message: { message_id: sequence, date: Math.floor(Date.now()/1000), chat: { type: 'private', id }, text: 'Menu' } } });
  const button = (id, label) => { const match = [...sent].reverse().filter(s => s.id === String(id)).flatMap(s => s.keyboard?.flat() || []).find(b => b.text === label); assert.ok(match, `Button ${label} exists`); return match.callback_data; };
  const seed = async (id, settings = preset()) => { const ctx = await bot.context(String(id)); await bot.save(ctx, settings); ctx.tool = 'copy'; return ctx; };
  return { bot, root, master, hostStore, sent, calls, api, engines, msg, callback, button, seed };
}

test('Telegram exposes every existing setting, uses the same fee rules, and does not clear saved keys during validation', () => {
  assert.deepEqual(Object.keys(fields).sort(), [...settingIds].sort());
  const s = preset({ heliusSol: '0.0003', jitoSol: '0.0003', prioritySol: '0.0003', senderTier: 'swqos' });
  const secret = s.wallets[0].privateKey;
  validateSettings(s); assert.equal(s.wallets[0].privateKey, secret);
  assert.throws(() => validateSettings({ ...s, senderTier: 'max' }), /0.001/);
  assert.equal(parseField('buyAmount', '100'), '100');
  assert.throws(() => parseField('sellPercent', '101'));
  assert.throws(() => parseField('slippagePercent', 'NaN'));
  assert.throws(() => parseField('mode', 'anything'));
});

test('key import is atomic, supports upgrading paper wallets, preserves per-wallet amounts, and rejects duplicate/oversized batches', () => {
  const a = JSON.stringify([...key1.secretKey]), b = JSON.stringify([...key2.secretKey]);
  const paper = importWallets(key1.publicKey.toBase58(), [], true); paper[0].amount = '0.4';
  const live = importWallets(a, paper); assert.equal(live[0].amount, '0.4'); assert.equal(paper[0].privateKey, '');
  assert.throws(() => importWallets(`${a}\n${a}`, []), /duplicated/);
  assert.throws(() => importWallets(`${b}\ninvalid`, live)); assert.equal(live.length, 1);
  assert.throws(() => importWallets(Array(26).fill(a).join('\n')), /25/);
  assert.equal(importSettings(JSON.stringify(createPreset(preset()))).wallets[0].publicKey, key1.publicKey.toBase58());
});

test('vault encrypts settings and journals, binds ciphertext to user and file, refuses corrupt/missing keys', async t => {
  const h = await harness(t), a = await h.seed(1001), b = await h.seed(1002, preset({ wallets: [key2] }));
  const raw = await readFile(a.store.path('settings'), 'utf8');
  assert.ok(!raw.includes(a.settings.wallets[0].privateKey)); assert.ok(!raw.includes('dummy-jupiter'));
  await writeFile(b.store.path('settings'), raw);
  await assert.rejects(b.store.read('settings'), /cannot be read/);
  await writeFile(a.store.path('live'), raw);
  await assert.rejects(a.store.read('live'), /cannot be read/);
  await assert.rejects(loadMasterKey(h.root), /missing/);
  const c = new TelegramStore(join(h.root, 'serial'), randomBytes(32));
  await Promise.all(Array.from({ length: 15 }, (_, index) => c.write('settings', { index })));
  assert.equal((await c.read('settings')).index, 14);
  const ledger = await new TelegramLedger(c, 'paper').load(); ledger.data.pending.push({ amount: 2n }); await ledger.save();
  assert.equal((await new TelegramLedger(c, 'paper').load()).data.pending[0].amount, '2');
  assert.notDeepEqual(userKey(h.master, 1001), userKey(h.master, 1002));
});

test('old presets become Live without starting; public-address followers need keys and Telegram has no Paper controls', async t => {
  const h = await harness(t), id = 1901, old = preset({ mode: 'paper' });
  const imported = importSettings(JSON.stringify(old));
  assert.equal(imported.mode, 'live'); assert.deepEqual(imported.wallets, old.wallets);
  const addressOnly = { ...old, wallets: [{ publicKey: key1.publicKey.toBase58(), label: 'Old follower' }] };
  const missing = importSettings(JSON.stringify(addressOnly));
  assert.equal(missing.mode, 'live'); assert.equal(missing.wallets[0].publicKey, key1.publicKey.toBase58());
  assert.throws(() => validateSettings(missing), /private key/);
  const ctx = await h.seed(id, old); assert.equal(ctx.settings.mode, 'live');
  await h.msg(id, '/wallets');
  assert.ok(!h.sent.at(-1).keyboard.flat().some(b => /paper/i.test(b.text)));
  await h.bot.group(ctx, 'buy');
  assert.ok(!h.sent.at(-1).keyboard.flat().some(b => /run mode|paper/i.test(b.text)));
  await h.msg(id, '/set mode paper'); assert.equal(ctx.settings.mode, 'live');
  assert.equal(h.engines.length, 0);
});

test('new users complete wallet, lead, API, RPC and fee setup entirely in private chat; responses never echo secrets', async t => {
  const h = await harness(t), id = 2001;
  await h.msg(id, '/start'); assert.equal(h.engines.length, 0);
  await h.callback(id, h.button(id, 'Multiwallet / Copy trading'));
  await h.callback(id, h.button(id, 'Wallets'));
  await h.callback(id, h.button(id, 'Import private keys'));
  const secret = JSON.stringify([...key1.secretKey]); await h.msg(id, secret);
  await h.callback(id, h.button(id, 'Target addresses')); await h.msg(id, lead);
  await h.msg(id, '/set heliusKey my-secret-helius');
  await h.msg(id, '/set jupiterKey my-secret-jupiter');
  await h.msg(id, '/set rpcUrl https://mainnet.helius-rpc.com/?api-key=my-secret-rpc');
  await h.msg(id, '/set senderTier swqos');
  await h.msg(id, '/set heliusSol .0003'); await h.msg(id, '/set jitoSol .0003');
  const ctx = h.bot.users.get(String(id)); validateSettings(ctx.settings);
  assert.equal(ctx.settings.mode, 'live');
  assert.equal(ctx.settings.wallets[0].privateKey, secret);
  assert.ok(h.calls.some(c => c.method === 'deleteMessage'));
  const output = JSON.stringify(h.sent);
  for (const key of [secret, 'my-secret-helius', 'my-secret-jupiter', 'my-secret-rpc']) assert.ok(!output.includes(key));
  await h.msg(id, '/run'); assert.equal(h.engines.length, 0);
  await h.callback(id, h.button(id, '▶ Start LIVE')); await tick(); assert.equal(h.engines.length, 1);
  assert.equal(h.engines[0].calls[0].wallets[0].privateKey, secret);
});

test('user IDs isolate menus, keys, engines and stop actions; groups and forwarded commands are ignored', async t => {
  const h = await harness(t), a = await h.seed(3001), b = await h.seed(3002, preset({ wallets: [key2] }));
  await h.msg(3001, '/run'); const token = h.button(3001, '▶ Start LIVE');
  await h.callback(3002, token); assert.equal(h.engines.length, 0);
  await h.callback(3001, token); await tick();
  await h.msg(3002, '/run'); await h.callback(3002, h.button(3002, '▶ Start LIVE')); await tick();
  assert.notEqual(a.engine, b.engine); assert.equal(a.engine.state, 'starting');
  await h.msg(3002, '/stop'); assert.equal(a.engine.state, 'starting'); assert.equal(b.engine.state, 'stopped');
  await h.msg(3001, '/stop', { chat: { type: 'group', id: -3001 } }); assert.equal(a.engine.state, 'starting');
  await h.msg(3001, '/stop', { forward_origin: { type: 'user' } }); assert.equal(a.engine.state, 'starting');
  await h.callback(3001, token); assert.equal(a.engine.calls.length, 1);
  await h.msg(3001, '/stop'); assert.equal(a.engine.state, 'stopped');
});

test('Stop interrupts startup and bypasses a blocked credential-delete request; settings cannot change during a run', async t => {
  const h = await harness(t), ctx = await h.seed(4001);
  await h.msg(4001, '/run'); await h.callback(4001, h.button(4001, '▶ Start LIVE')); await tick();
  let unblock; h.api.call = (method) => method === 'deleteMessage' ? new Promise(resolve => { unblock = resolve; }) : Promise.resolve(true);
  const blocked = h.msg(4001, '/set buyAmount .9'); await tick();
  await h.msg(4001, '/stop'); assert.equal(ctx.engine.state, 'stopped');
  unblock(); await blocked; await ctx.startTask;
  // The update was explicitly submitted before Stop; after stopping it may save for the next run.
  assert.equal(ctx.engine.calls.length, 1);
  await h.msg(4001, '/run'); await h.callback(4001, h.button(4001, '▶ Start LIVE')); await tick();
  h.api.call = async () => true;
  const before = ctx.settings.buyAmount; await h.msg(4001, '/set buyAmount 1'); assert.equal(ctx.settings.buyAmount, before);
});

test('stale messages and stale Start buttons cannot start runs; a stale Stop remains useful', async t => {
  const h = await harness(t), ctx = await h.seed(5001);
  await h.msg(5001, '/set buyAmount 9', { date: Math.floor(Date.now()/1000) - 600 }); assert.equal(ctx.settings.buyAmount, '0.05');
  await h.msg(5001, '/run'); const token = h.button(5001, '▶ Start LIVE');
  await h.msg(5001, '/set buyAmount .02'); await h.callback(5001, token); assert.equal(h.engines.length, 0);
  await h.msg(5001, '/run'); await h.callback(5001, h.button(5001, '▶ Start LIVE')); await tick();
  await h.msg(5001, '/stop', { date: 1 }); assert.equal(ctx.engine.state, 'stopped');
});

test('a startup completion arriving with Stop does not send a false running notification', async t => {
  const h = await harness(t), ctx = await h.seed(5101);
  await h.msg(5101, '/run'); await h.callback(5101, h.button(5101, '▶ Start LIVE')); await tick();
  ctx.engine.finishStart(); h.bot.stop(ctx); await ctx.startTask;
  assert.ok(!h.sent.some(s => s.text.includes('trading is running.')));
});

test('JSON preset imports stay isolated, reject omission of wallets with holdings, and deletion failures are reported', async t => {
  const h = await harness(t), ctx = await h.seed(6001);
  await ctx.store.write('live', { lots: [{ wallet: key1.publicKey.toBase58(), remaining: '12', decimals: 6 }], pending: [], events: [] });
  await h.msg(6001, '/start'); await h.callback(6001, h.button(6001, 'Multiwallet / Copy trading')); await h.callback(6001, h.button(6001, 'Import full setup JSON'));
  h.api.document = async () => JSON.stringify(createPreset(preset({ wallets: [key2] })));
  h.api.call = async method => { if (method === 'deleteMessage') throw new Error('no'); return true; };
  await h.msg(6001, '', { document: { file_id: 'file1', file_name: 'setup.json', file_size: 2000 } });
  assert.equal(ctx.settings.wallets[0].publicKey, key1.publicKey.toBase58());
  assert.ok(h.sent.some(s => s.text.includes('delete it from this chat')));
  assert.ok(h.sent.some(s => s.text.includes('omits a wallet')));
});

test('resource limits and invited-user mode are enforced without sharing another user’s state', async t => {
  const h = await harness(t, { maxUsers: 2, maxActive: 1, allowedUsers: ['7001','7002','7003'] });
  await h.msg(7999, '/start'); assert.equal(h.bot.users.size, 0);
  await h.seed(7001); await h.seed(7002, preset({ wallets: [key2] }));
  await h.msg(7001, '/run'); await h.callback(7001, h.button(7001, '▶ Start LIVE')); await tick();
  await h.msg(7002, '/run'); await h.callback(7002, h.button(7002, '▶ Start LIVE')); assert.equal(h.engines.length, 1);
  await h.msg(7003, '/start'); assert.equal(h.bot.users.size, 2);
  assert.ok(h.sent.some(s => s.text.includes('slots are busy')));
});

test('API transport redacts token failures, uses POST and refuses redirects; update offsets commit before commands', async () => {
  const token = '123456789:abcdefghijklmnopqrstuvwxyz123456789'; let options;
  const api = new TelegramApi(token, async (_, opts) => { options = opts; throw new Error(`failed at https://api.telegram.org/bot${token}/getMe`); });
  await assert.rejects(api.call('getMe'), error => !error.message.includes(token));
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  const abort = new AbortController(), applied = [], writes = [];
  await pollTelegram({ call: async () => [{ update_id: 8 }, { update_id: 8 }, { update_id: 9 }] },
    { read: async () => ({ offset: 8 }), write: async (_, state) => writes.push(state.offset) },
    { dispatch: update => { assert.equal(writes.at(-1), update.update_id + 1); applied.push(update.update_id); if (update.update_id === 9) abort.abort(); } }, abort.signal);
  assert.deepEqual(applied, [8, 9]); assert.deepEqual(writes, [9, 10]);
  let dispatched = false;
  await assert.rejects(pollTelegram({ call: async () => [{ update_id: 1 }] }, { read: async () => ({ offset: 0 }), write: async () => { throw new Error('disk'); } }, { dispatch: () => { dispatched = true; } }, new AbortController().signal), /disk/);
  assert.equal(dispatched, false);
});

test('outgoing notification backlog is bounded and one slow chat does not block a different chat', async () => {
  let release; const sends = [];
  const outbox = new TelegramOutbox({ call: (_, body) => { sends.push(body.chat_id); return body.chat_id === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(); } });
  try {
    for (let i = 0; i < 100; i++) outbox.send('1', `notice ${i}`, undefined, { notification: true });
    outbox.send('2', 'Stopped.'); assert.equal(outbox.chats.get('1').items.length, 16);
    outbox.tick(); outbox.globalNext = 0; outbox.tick(); assert.deepEqual(sends, [1,2]); release(); await tick();
  } finally { outbox.close(); }
});

test('notification service rotates across chats and prioritizes Stop over stale queued messages', async () => {
  const sent = [], outbox = new TelegramOutbox({ call: async (_, body) => { sent.push(body); } });
  try {
    for (const id of ['1','2','3']) for (let i = 0; i < 5; i++) outbox.send(id, `old ${i}`);
    for (let i = 0; i < 3; i++) { outbox.globalNext = 0; for (const q of outbox.chats.values()) q.next = 0; outbox.tick(); await tick(); }
    assert.deepEqual(sent.map(s => s.chat_id), [1,2,3]);
    outbox.send('1', 'Stopped.', undefined, { urgent: true, replaceQueue: true });
    assert.deepEqual(outbox.chats.get('1').items.map(s => s.body.text), ['Stopped.']);
  } finally { outbox.close(); }
});

test('hosted provider endpoints reject private networks and DNS rebinding at connection lookup', async () => {
  for (const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.0.2','192.168.1.1','100.64.0.1','0.0.0.0','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1','2002:7f00:1::']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  for (const url of ['http://rpc.example','https://127.1','https://2130706433','https://[::1]/','https://localhost','https://user:pass@rpc.example']) assert.throws(() => publicEndpoint(url), /public/);
  let attempt = 0;
  const lookup = safeLookup((host, opts, callback) => callback(null, [{ address: ++attempt === 1 ? '1.1.1.1' : '127.0.0.1', family: 4 }]));
  const resolve = () => new Promise((yes, no) => lookup('rpc.example', {}, (error, ip) => error ? no(error) : yes(ip)));
  assert.equal(await resolve(), '1.1.1.1'); await assert.rejects(resolve(), /non-public/);
});

test('redaction removes keys, provider URLs and standalone credential query values', () => {
  const s = preset({ rpcUrl: 'https://provider.example/rpc?api-key=token-secret' });
  assert.equal(redact(`failed ${s.wallets[0].privateKey} ${s.jupiterKey} token-secret ${s.rpcUrl}`, s).includes('token-secret'), false);
});

test('guarded worker HTTP preserves RPC request bodies and handles compressed provider JSON without following redirects', async () => {
  const original = https.request, restore = installTelegramNetworkGuard(); let status = 200, count = 0, posted = '';
  https.request = (url, options, callback) => {
    count++; assert.equal(url.hostname, 'rpc.example'); assert.equal(options.method, 'POST'); assert.equal(options.headers['x-api-key'], 'test-only-key');
    const req = new Writable({ write(chunk, _, done) { posted += chunk.toString(); done(); } }); req.setTimeout = () => {};
    req.on('finish', () => { const res = new PassThrough(); res.statusCode = status; res.headers = { 'content-encoding': 'gzip', 'content-type': 'application/json' }; callback(res); res.end(gzipSync(JSON.stringify({ result: 123 }))); });
    return req;
  };
  try {
    const body = JSON.stringify({ method: 'getSlot', params: [] });
    assert.deepEqual(await (await fetch('https://rpc.example/?api-key=test-only-query', { method: 'POST', headers: { 'x-api-key': 'test-only-key' }, body })).json(), { result: 123 });
    assert.equal(posted, body);
    status = 302;
    await assert.rejects(fetch('https://rpc.example', { method: 'POST', headers: { 'x-api-key': 'test-only-key' } }), /redirects/);
    await assert.rejects(fetch('https://127.0.0.1'), /public/); assert.equal(count, 2);
    status = 600;
    await assert.rejects(fetch('https://rpc.example', { method: 'POST', headers: { 'x-api-key': 'test-only-key' } }), /invalid HTTP status/);
    status = 200;
    assert.deepEqual(await (await fetch('https://rpc.example', { method: 'POST', headers: { 'x-api-key': 'test-only-key' } })).json(), {result:123});
  } finally { https.request = original; restore(); }
});

test('real Telegram trading worker boots with encrypted ledgers and stops during startup without any RPC or live transaction', async t => {
  const root = await mkdtemp(join(tmpdir(), 'launchpad-worker-test-')), store = new TelegramStore(root, randomBytes(32), 'user:8001');
  const engine = new TelegramEngine(store);
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const starting = engine.start(preset()); engine.stop();
  await assert.rejects(starting, /stopped/);
  await engine.ready; await tick();
  // Worker-side validation independently rejects a private RPC before provider initialization.
  await assert.rejects(engine.start(preset({ rpcUrl: 'https://127.0.0.1' })), /public/);
  await engine.close();
  const ledger = await store.read('live'); assert.deepEqual(ledger.pending, []);
  assert.equal(ledger.trades, 0);
});
