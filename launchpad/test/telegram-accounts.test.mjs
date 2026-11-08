import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { TelegramBot, readLegacyExposure } from '../src/telegram-bot.mjs';
import { AccountService } from '../src/accounts.mjs';
import { TelegramStore, userKey } from '../src/telegram-store.mjs';
import { defaults } from '../src/telegram-settings.mjs';
import { config } from './fixtures.mjs';
import { totp } from '../src/totp.mjs';

const password = 'private-passphrase-8365';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-tg-account-')), root = join(dir, 'telegram'), master = randomBytes(32);
  const accounts = await new AccountService(join(dir, 'accounts')).init(), sent = [], apiCalls = [], runtimes = new Map();
  const policy = { version: 'fee-v1', description: 'Copy: 0.25% per swap. Market Making: 0.10% per swap.', liquidityDescription: 'LP: no management fee.', cashbackBps: 0, ready: true };
  class Runtime extends EventEmitter {
    state = 'stopped'; kind = 'copy'; calls = [];
    status() { return { state: this.state, kind: this.kind, mode: 'paper', positions: [], pending: [], events: [], metrics: {} }; }
    async start(raw, kind) { if (raw.agreedFeeVersion !== policy.version) throw new Error('Fee policy changed. Review this run again.'); this.calls.push({ raw, kind }); this.state = 'running'; this.kind = kind; this.emit('change'); }
    stop() { this.state = 'stopped'; this.emit('change'); }
    async close() { this.stop(); }
  }
  const runtimeManager = {
    get(id) { if (!runtimes.has(id)) runtimes.set(id, new Runtime()); return runtimes.get(id); },
    async readSettings(id) { const settings = await accounts.storeFor(id).read('settings', defaults); return { settings, revision: JSON.stringify(settings) }; },
    async saveSettings(id, settings, expected) { if ((await this.readSettings(id)).revision !== expected) throw new Error('Settings changed on another device.'); await accounts.storeFor(id).write('settings', settings); return this.readSettings(id); },
  };
  const hostStore = new TelegramStore(root, master);
  const api = { async call(method, body) { apiCalls.push({ method, body }); return true; } };
  const outbox = { send(id, text, keyboard) { sent.push({ id, text, keyboard }); } };
  const bot = await new TelegramBot({ root, master, hostStore, api, outbox, accounts, runtimeManager, feePolicy: async () => ({ ...policy }), publicUrl: 'https://app.example' }).init();
  t.after(async () => { await bot.close(); await rm(dir, { recursive: true, force: true }); });
  let sequence = 0;
  const msg = (id, text) => bot.dispatch({ message: { message_id: ++sequence, date: Math.floor(Date.now() / 1000), chat: { id, type: 'private' }, from: { id }, text } });
  const cb = (id, data) => bot.dispatch({ callback_query: { id: `cb${++sequence}`, data, from: { id }, message: { message_id: sequence, date: Math.floor(Date.now() / 1000), chat: { type: 'private', id } } } });
  const last = id => [...sent].reverse().find(s => s.id === String(id));
  const button = (id, label) => { const found = last(id)?.keyboard?.flat().find(b => b.text === label); assert.ok(found, `${label}: ${last(id)?.text}`); return found.callback_data; };
  const click = (id, label) => cb(id, button(id, label));
  const account = (username = 'tester') => accounts.register(username, password);
  const link = async (id, value) => { const { code } = await accounts.createLinkCode(value.id); await msg(id, `/link ${code}`); return bot.users.get(String(id)); };
  return { bot, accounts, root, master, policy, runtimeManager, sent, apiCalls, runtimes, msg, cb, last, button, click, account, link };
}

test('Telegram batch generation fills each tool cap and keeps private keys out of chat', async t => {
  const h = await harness(t), account = await h.account('batch_wallets'), id = 9421, ctx = await h.link(id, account);
  for (const [label, kind, count, cap] of [['Multiwallet / Copy trading','copy',24,25],['LP Management','liquidity',9,10],['Market Making','market',4,5]]) {
    await h.msg(id, '/start'); await h.click(id, label); await h.click(id, 'Wallets'); await h.click(id, 'Generate wallets'); await h.msg(id,String(count));
    assert.equal(ctx.settings.wallets.filter(w=>w.tool===kind).length, cap);
    await h.click(id, 'Funding addresses'); assert.match(h.last(id).text, /Funding addresses/);
    await h.msg(id, '/wallets'); await h.click(id, 'Generate wallets'); assert.match(h.last(id).text,/Maximum/);
  }
  const saved=(await h.runtimeManager.readSettings(account.id)).settings;
  assert.equal(saved.wallets.length,40); assert.equal(new Set(saved.wallets.map(w=>w.publicKey)).size,40);
  for(const wallet of saved.wallets) assert(!JSON.stringify(h.sent).includes(wallet.privateKey));
  assert(!saved.wallets.some(w=>w.publicKey===account.mainWallet));
  await h.msg(id,'/start'); await h.click(id,'Multiwallet / Copy trading'); await h.click(id,'Wallets'); await h.click(id,'Choose wallets for this mode'); await h.click(id,'Clear');
  const last = saved.wallets.filter(w=>w.tool==='copy').at(-1); const btn=h.last(id).keyboard.flat().find(b=>b.text.includes(last.label));
  assert(btn); await h.cb(id,btn.callback_data); assert.deepEqual(ctx.settings.runWallets.copy,[last.publicKey]);
});

test('Telegram custom batch counts are bounded and cannot erase concurrent web changes', async t => {
  const h=await harness(t), account=await h.account('custom_batch'), id=9452, ctx=await h.link(id,account);
  await h.click(id,'Multiwallet / Copy trading'); await h.click(id,'Wallets'); await h.click(id,'Generate wallets');
  await h.msg(id,'25'); assert.equal(ctx.settings.wallets.length,3);
  await h.msg(id,'2.5'); assert.equal(ctx.settings.wallets.length,3);
  await h.msg(id,'3'); assert.equal(ctx.settings.wallets.length,6);
  await h.click(id,'Generate wallets'); await h.accounts.storeFor(account.id).write('settings',{...ctx.settings,buyAmount:'0.987'});
  await h.msg(id,'5'); assert.equal(ctx.settings.wallets.length,6); assert.equal(ctx.settings.buyAmount,'0.987');
});

test('Telegram cannot bypass web MFA, deletes both credential messages, and accepts a one-use recovery code', async t => {
  const h = await harness(t), account = await h.account('telegram_mfa'), id = 9341;
  const setup = await h.accounts.beginMfa(account.id, password);
  const recovery = await h.accounts.enableMfa(account.id, password, totp(setup.secret));
  await h.msg(id, '/login'); await h.msg(id, account.username); await h.msg(id, password);
  const ctx = h.bot.users.get(String(id));
  assert.equal(ctx.account, null); assert.equal(ctx.prompt.stage, 'password-mfa');
  assert.ok(!JSON.stringify(ctx.prompt).includes(password)); assert.match(h.last(id).text, /Two-factor/);
  await h.msg(id, `${password}\n${recovery.recoveryCodes[0]}`);
  assert.equal(ctx.account.id, account.id);
  assert.equal((await h.accounts.get(account.id)).recoveryCodesRemaining, 9);
  assert.ok(!JSON.stringify(h.sent).includes(password)); assert.ok(!JSON.stringify(h.sent).includes(recovery.recoveryCodes[0]));
  assert.ok(h.apiCalls.filter(c => c.method === 'deleteMessage').length >= 4);
  await h.msg(id, '/logout');
  await h.msg(id, '/login'); await h.msg(id, account.username); await h.msg(id, password);
  await h.msg(id, `${password}\n${recovery.recoveryCodes[0]}`); assert.equal(ctx.account, null);
});

test('Telegram requires an account before setup and creates a separate main wallet and three trading defaults', async t => {
  const h = await harness(t), id = 9201;
  const register = h.accounts.register.bind(h.accounts); let registrationLimit;
  h.accounts.register = (username, secret, options) => { registrationLimit = options?.maxUsers; return register(username, secret, options); };
  await h.msg(id, '/start');
  assert.match(h.last(id).text, /Create an account/);
  await h.msg(id, '/run'); assert.equal(h.runtimes.size, 0);
  await h.click(id, 'Create account'); await h.msg(id, 'newuser'); await h.msg(id, password);
  const ctx = h.bot.users.get(String(id));
  assert.equal(ctx.account.username, 'newuser'); assert.equal(ctx.settings.wallets.length, 3); assert.equal(ctx.settings.leads, '');
  assert.equal(registrationLimit, 100);
  assert.ok(ctx.account.mainWallet); assert.equal(ctx.account.role, 'user');
  await h.msg(id, '/account'); assert.match(h.last(id).text, /Cashback wallet/); assert.ok(h.last(id).text.includes(ctx.account.mainWallet));
  const destination=ctx.settings.wallets[0].publicKey,session=await h.accounts.createSession(ctx.account.id);
  await h.accounts.setCashbackWallet(ctx.account.id,{address:destination,password},{token:session.token,origin:'https://app.example'});
  await h.msg(id,'/account');assert(h.last(id).text.includes(destination));assert(!h.last(id).text.includes(ctx.account.mainWallet));
  assert.ok(!JSON.stringify(h.sent).includes(password));
  assert.ok(h.apiCalls.filter(c => c.method === 'deleteMessage').length >= 2);
});

test('web linking loads only that account settings and never migrates legacy Telegram keys', async t => {
  const h = await harness(t), id = 9202, account = await h.account();
  const legacy = new TelegramStore(join(h.root, 'users', String(id)), userKey(h.master, String(id)), `user:${id}`);
  await legacy.write('settings', { ...defaults, heliusKey: 'old-user-secret' });
  await h.accounts.storeFor(account.id).write('settings', { ...defaults, buyAmount: '0.2' });
  const ctx = await h.link(id, account);
  assert.equal(ctx.settings.buyAmount, '0.2'); assert.equal(ctx.settings.heliusKey, '');
  assert.equal(ctx.engine, h.runtimeManager.get(account.id));
  assert.equal((await legacy.read('settings')).heliusKey, 'old-user-secret');
  assert.equal((await h.accounts.getTelegramAccount(String(id))).id, account.id);
});

test('Telegram Stop controls a run started on the web; logout requires the run stopped', async t => {
  const h = await harness(t), id = 9203, account = await h.account();
  const ctx = await h.link(id, account), runtime = h.runtimeManager.get(account.id);
  runtime.state = 'running';
  await h.msg(id, '/logout'); assert.equal(ctx.account.id, account.id); assert.match(h.last(id).text, /Press Stop/);
  await h.msg(id, '/stop'); assert.equal(runtime.state, 'stopped');
  await h.msg(id, '/logout'); assert.equal(ctx.account, null); assert.equal(ctx.engine, null);
  assert.equal(await h.accounts.getTelegramAccount(String(id)), null);
  assert.equal((await h.accounts.get(account.id)).mainWallet, account.mainWallet);
});

test('logging out and switching accounts clears callbacks, settings, wallet state and notifications', async t => {
  const h = await harness(t), id = 9204, first = await h.account('first'), second = await h.account('second');
  const ctx = await h.link(id, first);
  await h.click(id, 'Multiwallet / Copy trading'); const old = h.button(id, 'Wallets');
  ctx.notices.push('private old activity');
  await h.msg(id, '/logout'); await h.link(id, second);
  await h.cb(id, old); assert.match(h.last(id).text, /expired/);
  assert.equal(ctx.account.id, second.id); assert.deepEqual(ctx.notices, []);
  assert.notEqual(ctx.engine, h.runtimeManager.get(first.id));
});

test('copy run review discloses fees and binds consent to the reviewed fee version', async t => {
  const h = await harness(t), id = 9205, account = await h.account();
  const raw = config({ mode: 'live' }); await h.accounts.storeFor(account.id).write('settings', { ...defaults, ...raw, leads: raw.leads.join('\n') });
  const ctx = await h.link(id, account);
  await h.click(id, 'Multiwallet / Copy trading'); await h.msg(id, '/run');
  assert.match(h.last(id).text, /0\.25% per swap/); assert.match(h.last(id).text, /Cashback: 0%/);
  assert.match(h.last(id).text, /LP: no management fee/); assert.match(h.last(id).text, /accrued for your selected cashback wallet/);
  const oldStart = h.button(id, '▶ Start LIVE'); h.policy.version = 'fee-v2';
  await h.cb(id, oldStart); await ctx.startTask;
  assert.equal(ctx.engine.calls.length, 0); assert.match(h.last(id).text, /Fee policy changed/);
  await h.msg(id, '/run'); await h.click(id, '▶ Start LIVE'); await ctx.startTask;
  assert.equal(ctx.engine.calls[0].raw.agreedFeeVersion, 'fee-v2');
});

test('web settings changes invalidate a Telegram prompt rather than overwriting newer values', async t => {
  const h = await harness(t), id = 9206, account = await h.account();
  const ctx = await h.link(id, account); await h.click(id, 'Multiwallet / Copy trading');
  await h.msg(id, '/set buyAmount 0.1'); await h.msg(id, '/settings'); await h.click(id, 'Buy');
  const amountButton = h.last(id).keyboard.flat().find(b => b.text.startsWith('Fixed buy amount:'));
  assert.ok(amountButton); await h.cb(id, amountButton.callback_data);
  const current = await h.runtimeManager.readSettings(account.id);
  await h.runtimeManager.saveSettings(account.id, { ...current.settings, buyAmount: '0.9' }, current.revision);
  await h.msg(id, '0.3'); assert.match(h.last(id).text, /Choose what to import/);
  assert.equal(ctx.settings.buyAmount, '0.9'); assert.equal((await h.runtimeManager.readSettings(account.id)).settings.buyAmount, '0.9');
});

test('password attempts are bounded and slash-prefixed passwords are deleted without being echoed', async t => {
  const h = await harness(t), id = 9207;
  await h.msg(id, '/login'); await h.msg(id, 'unknown');
  for (let i = 0; i < 6; i++) await h.msg(id, '/not-a-command-secret');
  assert.match(h.last(id).text, /Too many account attempts/);
  assert.equal(h.bot.users.get(String(id)).account, null);
  assert.ok(!JSON.stringify(h.sent).includes('/not-a-command-secret'));
  assert.ok(h.apiCalls.filter(c => c.method === 'deleteMessage').length >= 7);
});

test('Stop during slow authentication prevents account binding from reviving the cancelled flow', async t => {
  const h = await harness(t), id = 9208, account = await h.account();
  let resolveAuth; h.accounts.authenticate = () => new Promise(resolve => { resolveAuth = resolve; });
  await h.msg(id, '/login'); await h.msg(id, account.username);
  const pending = h.msg(id, password); while (!resolveAuth) await tick();
  await h.msg(id, '/stop'); resolveAuth(account); await pending;
  assert.equal(h.bot.users.get(String(id)).account, null);
  assert.equal(await h.accounts.getTelegramAccount(String(id)), null);
});

test('revoked Telegram linking cannot keep controlling its former account', async t => {
  const h = await harness(t), id = 9209, account = await h.account();
  const ctx = await h.link(id, account), runtime = h.runtimeManager.get(account.id);
  runtime.state = 'running';
  await h.accounts.unlinkTelegram(String(id), account.id);
  await h.msg(id, '/stop');
  assert.equal(runtime.state, 'running'); assert.equal(ctx.account, null); assert.equal(ctx.engine, null);
  await h.msg(id, '/settings'); assert.match(h.last(id).text, /Create an account/);
});

test('linked accounts with old live positions receive an upgrade notice and cannot start until their old exposure is resolved', async t => {
  const h = await harness(t), id = 9210, account = await h.account();
  const raw = config({ mode: 'live' });
  await h.accounts.storeFor(account.id).write('settings', { ...defaults, ...raw, leads: raw.leads.join('\n') });
  const legacy = new TelegramStore(join(h.root, 'users', String(id)), userKey(h.master, String(id)), `user:${id}`);
  const oldBook = { version: 1, lots: [{ wallet: raw.wallets[0].publicKey, remaining: '100' }], pending: [], events: [], seen: [] };
  await legacy.write('live', oldBook);
  const ctx = await h.link(id, account);
  assert.match(h.last(id).text, /Previous Telegram data found/);
  assert.match(h.last(id).text, /1 open copied positions/);
  assert.equal((await readLegacyExposure(h.root, h.master, String(id))).blocked, true);
  await h.click(id, 'Multiwallet / Copy trading'); await h.msg(id, '/run');
  assert.match(h.last(id).text, /Previous Telegram positions have not been imported/);
  assert.equal(ctx.engine.calls.length, 0);
  await h.msg(id, '/set mode paper'); assert.equal(ctx.settings.mode, 'live'); await h.msg(id, '/run');
  assert.equal(ctx.engine.calls.length, 0); assert.match(h.last(id).text, /Previous Telegram positions have not been imported/);
  assert.deepEqual(await legacy.read('live'), oldBook);
  assert.equal(await h.accounts.storeFor(account.id).read('live'), null);
});
