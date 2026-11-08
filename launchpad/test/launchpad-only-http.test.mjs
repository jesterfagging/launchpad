import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrivateKey, sign } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { AccountService } from '../src/accounts.mjs';
import { createAccountApp } from '../src/account-app.mjs';
import { totp } from '../src/totp.mjs';

const password = 'launchpad-mode-test-password-123';
const expectedFeatures = { toolkit: false, telegram: false, walletOnly: true };
const retiredFields = ['cashbackBps', 'cashbackWallet', 'cashbackWalletUpdatedAt', 'cashbackWalletUpdatedBy', 'cashbackWalletVerified', 'telegramId'];
const assertProjection = account => { for (const field of retiredFields) assert.equal(Object.hasOwn(account, field), false, field); };

// Real identity/session/CSRF/MFA storage; isolated launch/provider spies. No RPC,
// quotes, transaction signatures or funded chain operations leave this fixture.
async function fixture(t, { marketData, readSettings, adminVolume, adminRevenueAudit, adminPanel, meteora, pumpTest } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-launchpad-only-'));
  const accounts = await new AccountService(dir).init();
  const blocked = [], launchCalls = [], marketCalls = [], tradeCalls = [], owned = new Map();
  const forbidden = name => async () => { blocked.push(name); throw Error(`Retired service invoked: ${name}`); };
  const runtimes = { readSettings: readSettings || forbidden('runtime.readSettings'), get: forbidden('runtime.get'), view: forbidden('runtime.view'), snapshot: forbidden('runtime.snapshot'), updateSettings: forbidden('runtime.updateSettings') };
  const policy = { get: forbidden('policy.get'), setRecipient: forbidden('policy.setRecipient') };
  const launchpad = { start() {}, close() {}, async marketTradeContext(id, launchId) {
    const launch = owned.get(launchId);
    if (!launch || launch.ownerId !== id) throw Object.assign(Error('Launch not found.'), { statusCode: 404 });
    return { launch: { mint: launch.mint }, snapshot: null };
  } };
  for (const action of ['read', 'quotes', 'balance', 'market', 'rewards', 'prepare', 'estimate', 'create', 'refresh', 'signature', 'sign', 'action', 'claimAll', 'uploadImage', 'archive']) {
    launchpad[action] = async (...args) => { launchCalls.push({ action, args }); return { ok: true, action, ...(action === 'quotes' ? { assets: [] } : {}) }; };
  }
  const feed = Object.fromEntries(['pools', 'liveTrades', 'holders', 'holderHistory'].map(action => [action, async (...args) => { marketCalls.push({ action, args }); return { action, rows: [], updatedAt: 123 }; }]));
  const discovery = { close() {}, list: async () => ({ coins: [], updatedAt: 123 }), token: async mint => ({ mint }), creator: async username => ({ username, coins: [] }), market: async () => ({ candles: [] }), trades: async () => ({ trades: [] }), holders: async () => ({ holders: [] }), rewards: async () => ({}) };
  const trading = { start() {}, close() {} };
  for (const action of ['wallet', 'quote', 'prepare', 'submit', 'status', 'cancel']) trading[action] = async (id, body, context) => {
    const authorized = await context.authorize();
    tradeCalls.push({ action, id, body, authorizedId: authorized.account.id });
    return { ok: true, action };
  };
  const server = createAccountApp({ accounts, runtimes, policy, launchpad, trading, explore: discovery,
    ...(meteora ? {meteora} : {}), ...(pumpTest ? {pumpTest} : {}),
    marketData: marketData === undefined ? { forAccount: async id => { marketCalls.push({ action: 'forAccount', id }); return feed; }, close() {} } : marketData,
    funding: { overview: forbidden('funding.overview'), create: forbidden('funding.create'), close: forbidden('funding.close') },
    adminPanel: adminPanel || { overview: async () => ({ cards: [] }) }, adminRevenue: { read: async () => ({ products: [] }) }, protocolFees: { read: async () => ({ products: [] }), coins: async () => ({ coins: [] }) },
    adminVolume: adminVolume || { read: async () => ({ period: '24h', coins: [] }) },
    adminRevenueAudit: adminRevenueAudit || { read: async () => ({ evidence: 'saved-records', liveChainVerified: false, totals: [] }) },
    // Deliberately omit features: this verifies the shipped default, not only
    // the constructor's explicit feature override used by older toolkit tests.
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.closeServices(); await rm(dir, { recursive: true, force: true }); });
  async function request(path, { auth, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { ...(auth ? { cookie: `launchpad-session=${auth.token}`, 'x-control-token': auth.csrfToken } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text();
    return { code: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(raw) : raw };
  }
  async function user(username) { const account = await accounts.register(username, password); return { account, ...await accounts.createSession(account.id) }; }
  async function walletLogin(wallet = Keypair.generate()) {
    const challenge = await request('/api/wallet/challenge', { body: { address: wallet.publicKey.toBase58() }, headers: { origin: base } });
    assert.equal(challenge.code, 200);
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(wallet.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' });
    const signature = sign(null, Buffer.from(challenge.body.message), privateKey).toString('base64');
    const result = await request('/api/wallet/verify', { body: { nonce: challenge.body.nonce, signature }, headers: { origin: base, cookie: challenge.headers.get('set-cookie').split(';')[0] } });
    assert.equal(result.code, 200);
    return { wallet, account: result.body.account, csrfToken: result.body.token, token: result.headers.get('set-cookie').match(/launchpad-session=([^;]+)/)[1], result };
  }
  return { accounts, server, base, request, user, walletLogin, blocked, launchCalls, tradeCalls, marketCalls, owned, feed };
}

test('default-off toolkit API gates run before authentication and never invoke retired services', async t => {
  const h = await fixture(t), auth = await h.user('gated_user');
  const paths = ['/api/status', '/api/start', '/api/stop', '/api/sniper/status', '/api/portfolio/start', '/api/account/settings', '/api/account/settings-export', '/api/account/connections', '/api/account/wallets/generate', '/api/account/cashback-wallet', '/api/account/telegram-link', '/api/account/telegram-unlink', '/api/funding', '/api/funding/create', '/api/robinhood/status', '/api/market/holders', '/api/admin/sessions'];
  for (const path of paths) {
    assert.equal((await h.request(path)).code, 404, path + ' guest');
    assert.equal((await h.request(path + '?toolkit=true&LAUNCHPAD_ENABLE_TOOLKIT=1', { auth, body: { features: { toolkit: true, telegram: true, walletOnly: false }, accountId: auth.account.id } })).code, 404, path + ' body override');
  }
  assert.deepEqual(h.blocked, []); assert.deepEqual(h.launchCalls, []); assert.deepEqual(h.tradeCalls, []);
  assert.deepEqual((await h.request('/api/session?toolkit=1', { auth })).body.features, expectedFeatures);
});

test('legacy tool bookmarks redirect into the launchpad and account settings retain Explore underneath', async t => {
  const h = await fixture(t), mint = Keypair.generate().publicKey.toBase58();
  for (const path of ['/trade', '/robinhood', '/sessions', '/funding', '/tutorial', '/connections', '/?tool=copy', '/?chain=solana']) {
    const result = await h.request(path); assert.equal(result.code, 303, path); assert.equal(result.headers.get('location'), '/', path);
  }
  assert.equal((await h.request('/trade?account=overview')).headers.get('location'), '/?account=overview');
  assert.equal((await h.request('/?connections=1')).headers.get('location'), '/?account=overview');
  assert.equal((await h.request('/trade?token=' + mint)).headers.get('location'), '/coin?mint=' + mint);
  const accountPage = await h.request('/?account=overview'); assert.equal(accountPage.code, 200); assert.match(accountPage.body, /Launchpad — Discover coins/);
  assert.deepEqual(h.blocked, []);
});

test('session and account projections retain identity and Main wallet while omitting retired metadata without deleting it', async t => {
  const h = await fixture(t), auth = await h.user('projection_user');
  await h.accounts.mutate(registry => Object.assign(registry.accounts.find(row => row.id === auth.account.id), { cashbackBps: 500, cashbackWallet: Keypair.generate().publicKey.toBase58(), cashbackWalletUpdatedAt: 123, cashbackWalletUpdatedBy: auth.account.id, cashbackWalletVerified: true, telegramId: '12345' }));
  const guest = await h.request('/api/session'); assert.equal(guest.code, 200); assert.equal(guest.body.authenticated, false); assert.deepEqual(guest.body.features, expectedFeatures);
  for (const path of ['/api/session', '/api/account']) {
    const result = await h.request(path, { auth }); assert.equal(result.code, 200); assert.deepEqual(result.body.features, expectedFeatures); assertProjection(result.body.account);
    assert.equal(result.body.account.mainWallet, auth.account.mainWallet); assert.equal(result.body.account.username, auth.account.username);
    assert.equal(Object.hasOwn(result.body, 'fees'), false); assert.equal(Object.hasOwn(result.body, 'cashback'), false);
  }
  const stored = (await h.accounts.registry()).accounts.find(row => row.id === auth.account.id);
  assert.equal(stored.cashbackBps, 500); assert.equal(stored.telegramId, '12345');
  assert.equal((await h.accounts.storeFor(auth.account.id).read('main-wallet')).publicKey, auth.account.mainWallet);
  assert.deepEqual(h.blocked, []);
});

test('public registration cannot generate managed wallets; signed wallet login creates and restores the same passwordless identity', async t => {
  const h = await fixture(t);
  let registrations = 0; const originalRegister = h.accounts.register.bind(h.accounts);
  h.accounts.register = async (...args) => { registrations++; return originalRegister(...args); };
  for (const path of ['/api/account/register', '/api/account/register?walletOnly=false&LAUNCHPAD_ENABLE_MANAGED_ACCOUNTS=1']) {
    const result = await h.request(path, { body: { username: 'must_not_exist', password, features: { walletOnly: false }, managedAccounts: true } });
    assert.equal(result.code, 403); assert.match(result.body.error, /Connect your wallet/);
  }
  assert.equal(registrations, 0); assert.equal((await h.accounts.registry()).accounts.length, 0);
  assert.equal((await h.request('/api/wallet/challenge', { body: { address: Keypair.generate().publicKey.toBase58() } })).code, 403);
  assert.equal((await h.request('/api/wallet/verify', { body: { nonce: 'forged', signature: 'forged' }, headers: { origin: h.base } })).code, 403);
  const auth = await h.walletLogin(); assertProjection(auth.account); assert.deepEqual(auth.result.body.features, expectedFeatures);
  assert.equal(auth.account.mainWallet, auth.wallet.publicKey.toBase58()); assert.equal(auth.account.authType, 'wallet'); assert.match(auth.account.username, /^[a-z0-9_-]{3,32}$/i);
  assert.equal(await h.accounts.storeFor(auth.account.id).read('main-wallet', null), null);
  const record = (await h.accounts.registry()).accounts.find(row => row.id === auth.account.id); assert.equal(record.password?.salt, undefined);
  assert.equal((await h.request('/api/account/login', { body: { username: auth.account.username, password } })).code, 400);
  assert.equal((await h.request('/api/launchpad', { auth })).code, 200);
  const archiveBody={id:'a'.repeat(32),archived:true,accountId:'b'.repeat(32)};
  assert.equal((await h.request('/api/launchpad/archive',{auth,body:archiveBody,headers:{'x-control-token':'wrong'}})).code,403);
  assert.equal((await h.request('/api/launchpad/archive',{auth,body:archiveBody})).code,200);
  assert.deepEqual(h.launchCalls.at(-1),{action:'archive',args:[auth.account.id,archiveBody.id,{archived:true}]});
  assert.equal((await h.request('/api/admin/launches/archive',{auth,body:archiveBody})).code,403);
  assert.equal((await h.request('/api/account/export', { auth, body: { password } })).code, 403);
  assert.equal((await h.request('/api/admin/accounts', { auth })).code, 403);
  const again = await h.walletLogin(auth.wallet); assert.equal(again.account.id, auth.account.id); assert.equal(again.account.username, auth.account.username);
  assert.equal((await h.accounts.registry()).accounts.length, 1); assert.equal(registrations, 0); assert.deepEqual(h.blocked, []);
});

test('existing password accounts retain login and freshly authenticated key recovery without reopening toolkit', async t => {
  const h = await fixture(t), legacy = await h.user('legacy_recovery');
  const login = await h.request('/api/account/login', { body: { username: legacy.account.username, password } });
  assert.equal(login.code, 200); assertProjection(login.body.account);
  const auth = { token: login.headers.get('set-cookie').match(/launchpad-session=([^;]+)/)[1], csrfToken: login.body.token };
  assert.equal((await h.request('/api/account/export', { body: { password } })).code, 401);
  assert.equal((await h.request('/api/account/export', { auth, body: { password }, headers: { 'x-control-token': 'wrong' } })).code, 403);
  const wrong = await h.request('/api/account/export', { auth, body: { password: 'incorrect' } }); assert.equal(wrong.code, 400); assert.equal(wrong.body.privateKey, undefined);
  const exported = await h.request('/api/account/export', { auth, body: { password } }); assert.equal(exported.code, 200); assert.equal(exported.body.publicKey, legacy.account.mainWallet); assert.equal(typeof exported.body.privateKey, 'string');
  const setup = await h.accounts.beginMfa(legacy.account.id, password);
  const enabled = await h.accounts.enableMfa(legacy.account.id, password, totp(setup.secret, Date.now()));
  const secured = await h.accounts.createSession(legacy.account.id, { mfaVerified: true });
  const missingFactor = await h.request('/api/account/export', { auth: secured, body: { password } }); assert.equal(missingFactor.code, 400); assert.equal(missingFactor.body.privateKey, undefined);
  const recovered = await h.request('/api/account/export', { auth: secured, body: { password, code: enabled.recoveryCodes[0] } }); assert.equal(recovered.code, 200); assert.equal(recovered.body.publicKey, legacy.account.mainWallet);
  assert.equal((await h.request('/api/account/settings-export', { auth: secured, body: { password } })).code, 404); assert.deepEqual(h.blocked, []);
});

test('launch management and inline trading keep authentication, CSRF and account scoping in launchpad-only mode', async t => {
  const h = await fixture(t), auth = await h.user('launch_owner'), other = await h.user('launch_other');
  for (const path of ['/api/launchpad', '/api/launchpad/quotes']) {
    assert.equal((await h.request(path)).code, 401);
    assert.equal((await h.request(path, { auth, headers: { 'x-control-token': 'wrong' } })).code, 403);
    assert.equal((await h.request(path, { auth })).code, 200);
  }
  for (const path of ['/api/launchpad/prepare', '/api/launchpad/fees/claim-all', '/api/launchpad/trading/quote']) {
    const body = { id: 'fixture', mint: Keypair.generate().publicKey.toBase58(), accountId: other.account.id };
    assert.equal((await h.request(path, { body })).code, 401);
    assert.equal((await h.request(path, { auth, body, headers: { 'x-control-token': 'wrong' } })).code, 403);
    assert.equal((await h.request(path, { auth, body })).code, 200);
  }
  for (const call of h.launchCalls) assert.equal(call.args[0], auth.account.id);
  assert.equal(h.tradeCalls.length, 1); assert.equal(h.tradeCalls[0].id, auth.account.id); assert.equal(h.tradeCalls[0].authorizedId, auth.account.id);
  assert.equal((await h.request('/api/launchpad/action', { auth, body: { action: 'holder-distribute' } })).code, 403);
  assert.equal((await h.request('/api/explore')).code, 200); assert.equal((await h.request('/api/explore', { body: {} })).code, 405); assert.deepEqual(h.blocked, []);
});

test('launchpad administration remains owner-role and MFA protected and sanitizes account lists', async t => {
  const h = await fixture(t), user = await h.user('operator_account');
  const paths = ['/api/admin/accounts', '/api/admin/overview', '/api/admin/revenue', '/api/admin/revenue-audit', '/api/admin/volume', '/api/admin/protocol-fees', '/api/admin/launchpad/capabilities'];
  for (const path of paths) { assert.equal((await h.request(path)).code, 401); assert.equal((await h.request(path, { auth: user })).code, 403); }
  await h.accounts.setAdmin(user.account.id);
  for (const path of paths) assert.equal((await h.request(path, { auth: user })).code, 403);
  const setup = await h.accounts.beginMfa(user.account.id, password); await h.accounts.enableMfa(user.account.id, password, totp(setup.secret, Date.now()));
  const auth = await h.accounts.createSession(user.account.id, { mfaVerified: true });
  for (const path of paths) {
    assert.equal((await h.request(path, { auth, headers: { 'x-control-token': 'wrong' } })).code, 403);
    const result = await h.request(path, { auth }); assert.equal(result.code, 200, path);
    if (path.endsWith('/accounts')) for (const account of result.body.accounts) assertProjection(account);
  }
  assert.equal((await h.request('/api/admin/sessions', { auth })).code, 404);
  await h.accounts.setAdmin(user.account.id, false);
  assert.equal((await h.request('/api/admin/accounts', { auth })).code, 403); assert.deepEqual(h.blocked, []);
});

test('launchpad-only bulk and individual holder routes retain admin, MFA, CSRF and fresh-authentication gates', async t => {
  const calls = [], path = '/api/admin/holder-distributions', individual = '/api/admin/launches/action';
  const adminPanel = {
    readHolderDistributions: async actor => { calls.push(['read', actor]); return { job: null }; },
    distributeAllHolders: async (actor, input, context) => { await context.authorize(); calls.push(['bulk', actor, input]); return { job: { requestId: input.requestId, state: 'queued' }, alreadyRequested: false }; },
    launchAction: async (actor, body) => { calls.push(['individual', actor, body]); return { status: 'queued', requestId: body.requestId }; },
  };
  const h = await fixture(t, { adminPanel }), owner = await h.user('distribution_admin'), other = await h.user('distribution_user');
  assert.deepEqual((await h.request('/api/session', { auth: owner })).body.features, expectedFeatures);
  const requests = [{ path }, { path, body: { requestId: '1'.repeat(32) } }, { path: individual, body: { accountId: other.account.id, id: 'a'.repeat(32), requestId: '2'.repeat(32), action: 'distribute' } }];
  for (const { path: url, ...options } of requests) {
    assert.equal((await h.request(url, options)).code, 401, url);
    assert.equal((await h.request(url, { ...options, auth: other })).code, 403, url);
  }
  await h.accounts.setAdmin(owner.account.id);
  for (const { path: url, ...options } of requests) assert.equal((await h.request(url, { ...options, auth: owner })).code, 403, 'MFA must be enabled');
  let now = Date.now(); h.accounts.now = () => now;
  const setup = await h.accounts.beginMfa(owner.account.id, password);
  await h.accounts.enableMfa(owner.account.id, password, totp(setup.secret, now));
  const auth = await h.accounts.createSession(owner.account.id, { mfaVerified: true });
  for (const { path: url, ...options } of requests) {
    assert.equal((await h.request(url, { ...options, auth: owner })).code, 401, 'The old session must not bypass new MFA requirements');
    assert.equal((await h.request(url, { ...options, auth, headers: { 'x-control-token': 'invalid' } })).code, 403, 'CSRF must remain enforced');
  }
  assert.deepEqual(calls, []);
  const status = await h.request(path + '?accountId=' + other.account.id, { auth });
  assert.equal(status.code, 200); assert.equal(status.headers.get('cache-control'), 'no-store'); assert.deepEqual(status.body, { job: null });
  assert.deepEqual(calls, [['read', owner.account.id]]);
  for (const { path: url, body } of requests.filter(item => item.body)) {
    assert.equal((await h.request(url, { auth, body: { ...body, password: 'incorrect-password', code: 'invalid' } })).code, 400);
    assert.equal((await h.request(url, { auth, body: { ...body, password, code: 'invalid' } })).code, 400);
  }
  assert.equal(calls.length, 1);
  now += 30000;
  const bulkBody = { requestId: '1'.repeat(32), password, code: totp(setup.secret, now), accountId: other.account.id, ids: ['injected'], route: 'pumpswap' };
  const queued = await h.request(path, { auth, body: bulkBody });
  assert.equal(queued.code, 202); assert.equal(queued.body.job.state, 'queued');
  assert.deepEqual(calls.at(-1), ['bulk', owner.account.id, { requestId: bulkBody.requestId }]);
  now += 30000;
  const body = { ...requests[2].body, password, code: totp(setup.secret, now) };
  assert.equal((await h.request(individual, { auth, body })).code, 200);
  assert.deepEqual(calls.at(-1), ['individual', owner.account.id, body]);
  await h.accounts.setAdmin(owner.account.id, false);
  for (const { path: url, ...options } of requests) assert.equal((await h.request(url, { ...options, auth })).code, 403);
  assert.equal(calls.length, 3);
  for (const url of [path + '/private', path + '-extra', '/api/admin/sessions', '/api/account/telegram-link']) assert.equal((await h.request(url, { auth })).code, 404);
  assert.deepEqual(h.blocked, []);
});

test('launchpad-only holder enqueue routes reject session or role revoked during fresh authentication', async t => {
  const calls = [], adminPanel = { distributeAllRewardSweeps: async()=>{calls.push('sweep');return{};},distributeAllHolders: async () => { calls.push('bulk'); return {}; }, launchAction: async () => { calls.push('individual'); return {}; } };
  const h = await fixture(t, { adminPanel }), owner = await h.user('distribution_revoked');
  await h.accounts.setAdmin(owner.account.id);
  let now = Date.now(); h.accounts.now = () => now;
  const setup = await h.accounts.beginMfa(owner.account.id, password); await h.accounts.enableMfa(owner.account.id, password, totp(setup.secret, now));
  const reauthenticate = h.accounts.reauthenticate.bind(h.accounts);
  for (const path of ['/api/admin/holder-distributions', '/api/admin/launches/action', '/api/admin/reward-sweeps']) {
    for (const kind of ['session', 'role']) {
      await h.accounts.setAdmin(owner.account.id, true);
      const auth = await h.accounts.createSession(owner.account.id, { mfaVerified: true }); now += 30000;
      h.accounts.reauthenticate = async (...args) => { const result = await reauthenticate(...args); if (kind === 'session') await h.accounts.revokeSession(auth.token); else await h.accounts.setAdmin(owner.account.id, false); return result; };
      const response = await h.request(path, { auth, body: { requestId: '1'.repeat(32), accountId: owner.account.id, id: 'a'.repeat(32), action: 'distribute', password, code: totp(setup.secret, now) } });
      assert([401, 403].includes(response.code), `${path} ${kind}: ${response.code}`);
    }
  }
  assert.deepEqual(calls, []); assert.deepEqual(h.blocked, []);
});

test('launchpad-only holder status suppresses a read after the current session is revoked', async t => {
  let revoke = async () => {}, reads = 0;
  const h = await fixture(t, { adminPanel: { readHolderDistributions: async () => { reads++; await revoke(); return { job: { requestId: 'private-request' } }; } } }), owner = await h.user('distribution_read_revoked');
  await h.accounts.setAdmin(owner.account.id);
  const setup = await h.accounts.beginMfa(owner.account.id, password); await h.accounts.enableMfa(owner.account.id, password, totp(setup.secret, Date.now()));
  const auth = await h.accounts.createSession(owner.account.id, { mfaVerified: true });
  revoke = () => h.accounts.revokeSession(auth.token);
  const result = await h.request('/api/admin/holder-distributions', { auth });
  assert.equal(result.code, 401); assert.equal(reads, 1); assert.doesNotMatch(JSON.stringify(result.body), /private-request/);
  assert.deepEqual(h.blocked, []);
});

test('owned launch market reads use the persisted mint and Solana chain before invoking providers', async t => {
  const h = await fixture(t), auth = await h.user('market_owner'), other = await h.user('market_other');
  const mint = Keypair.generate().publicKey.toBase58(), foreignMint = Keypair.generate().publicKey.toBase58(), wallet = Keypair.generate().publicKey.toBase58();
  h.owned.set('owned', { ownerId: auth.account.id, mint }); h.owned.set('foreign', { ownerId: other.account.id, mint: foreignMint });
  const actions = ['pools', 'live-trades', 'holders', 'holder-history'];
  for (const action of actions) {
    const path = `/api/launchpad/market/${action}?id=owned&chain=robinhood&mint=${foreignMint}&address=${foreignMint}&accountId=${other.account.id}&pair=chosen-pair&wallet=${wallet}`;
    assert.equal((await h.request(path)).code, 401);
    assert.equal((await h.request(path, { auth, headers: { 'x-control-token': 'wrong' } })).code, 403);
    assert.equal((await h.request(path, { auth })).code, 200);
    assert.equal((await h.request(path.replace('id=owned', 'id=foreign'), { auth })).code, 404);
    assert.equal((await h.request(path, { auth, body: {} })).code, 405);
  }
  assert.equal((await h.request('/api/launchpad/market/unsupported?id=owned', { auth })).code, 404);
  assert.equal(h.marketCalls.length, 8);
  for (const call of h.marketCalls.filter(row => row.action === 'forAccount')) assert.equal(call.id, auth.account.id);
  const reads = h.marketCalls.filter(row => row.args);
  assert.deepEqual(reads.map(row => row.args), [['solana', mint, 'chosen-pair'], ['solana', mint, 'chosen-pair'], ['solana', mint], ['solana', mint, wallet]]);
  assert.deepEqual(h.blocked, []);
});

test('launch market provider errors and status text never ask visitors to configure toolkit connections', async t => {
  const h = await fixture(t), auth = await h.user('market_unavailable'); h.owned.set('owned', { ownerId: auth.account.id, mint: Keypair.generate().publicKey.toBase58() });
  h.feed.holders = async () => { throw Object.assign(Error('Add your Helius API key in Account → Connections.'), { connectionRequired: true }); };
  const unavailable = await h.request('/api/launchpad/market/holders?id=owned', { auth });
  assert.equal(unavailable.code, 503); assert.equal(Object.hasOwn(unavailable.body, 'connectionRequired'), false); assert(unavailable.body.retryAfterMs > 0); assert.doesNotMatch(unavailable.body.error, /key|connections/i);
  h.feed.holders = async () => ({ holders: [{ wallet: 'fixture', amount: 42 }], updatedAt: 123, source: 'Your Solana RPC', note: 'Add your API key in Connections.', warning: 'Trading runs need a Helius key.', historyNote: 'Configure Account → Connections', connectionRequired: true });
  const result = await h.request('/api/launchpad/market/holders?id=owned', { auth }); assert.equal(result.code, 200);
  assert.deepEqual(result.body.holders, [{ wallet: 'fixture', amount: 42 }]); assert.equal(result.body.updatedAt, 123); assert.equal(result.body.source, 'Solana onchain');
  assert.equal(Object.hasOwn(result.body, 'connectionRequired'), false);
  for (const field of ['note', 'warning', 'historyNote']) assert.doesNotMatch(result.body[field], /key|connections|trading runs/i);
});

test('default market data ignores saved toolkit keys when the operator has no Solana RPC', async t => {
  const reads = [], h = await fixture(t, { marketData: null, readSettings: async id => { reads.push(id); return { settings: { rpcUrl: '', heliusKey: '', rpcRequestsPerSecond: 8 }, revision: 'fixture' }; } });
  const auth = await h.user('no_operator_rpc'); h.owned.set('owned', { ownerId: auth.account.id, mint: Keypair.generate().publicKey.toBase58() });
  const store = h.accounts.storeFor(auth.account.id); await store.write('market-connections', { coingeckoKey: 'fixture-must-not-be-used', blockscoutKey: 'fixture-must-not-be-used' });
  const originalRead = store.read.bind(store); store.read = async (name, ...args) => { assert.notEqual(name, 'market-connections', 'launchpad must not read retired per-user provider credentials'); return originalRead(name, ...args); };
  const result = await h.request('/api/launchpad/market/holders?id=owned', { auth }); assert.equal(result.code, 503); assert.doesNotMatch(result.body.error, /key|connections/i); assert.equal(Object.hasOwn(result.body, 'connectionRequired'), false); assert.deepEqual(reads, [auth.account.id]);
});


test('the versioned platform logo supports public GET and HEAD in launchpad-only mode',async t=>{
  const h=await fixture(t),headers={origin:'https://raydium.io','sec-fetch-site':'cross-site'};
  const path='/brand-avatar.png?v=sunrise-1';
  const get=await fetch(h.base+path,{headers});assert.equal(get.status,200);assert.equal(get.headers.get('access-control-allow-origin'),'*');assert.match(get.headers.get('content-type'),/^image\/png/);
  const bytes=Buffer.from(await get.arrayBuffer());assert(bytes.length>100);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const head=await fetch(h.base+path,{method:'HEAD',headers});assert.equal(head.status,200);assert.equal(head.headers.get('access-control-allow-origin'),'*');assert.equal(head.headers.get('etag'),get.headers.get('etag'));assert.equal(head.headers.get('content-length'),String(bytes.length));assert.equal(await head.text(),'');
  const cached=await fetch(h.base+path,{method:'HEAD',headers:{...headers,'if-none-match':get.headers.get('etag')}});assert.equal(cached.status,304);
  assert.equal((await fetch(h.base+'/api/account',{method:'HEAD',headers})).status,403);
  assert.equal((await fetch(h.base+path,{method:'POST',headers})).status,403);
  assert.deepEqual(h.blocked,[]);
});


test('admin volume and revenue reports recheck the session after asynchronous collection', async t => {
  for (const path of ['/api/admin/volume', '/api/admin/revenue-audit']) {
    for (const revoke of ['session', 'role']) {
      await t.test(path + ' ' + revoke, async t => {
        let entered, finish;
        const started = new Promise(resolve => { entered = resolve; });
        const waiting = new Promise(resolve => { finish = resolve; });
        const seen = [], service = { read: async id => { seen.push(id); entered(); await waiting; return { privateReport: 'must-not-be-returned' }; } };
        const h = await fixture(t, { adminVolume: service, adminRevenueAudit: service });
        const owner = await h.user('report_owner'); await h.accounts.setAdmin(owner.account.id);
        const setup = await h.accounts.beginMfa(owner.account.id, password);
        await h.accounts.enableMfa(owner.account.id, password, totp(setup.secret, Date.now()));
        const auth = await h.accounts.createSession(owner.account.id, { mfaVerified: true });
        const pending = h.request(path + '?accountId=forged', { auth });
        await started;
        if (revoke === 'session') await h.accounts.revokeSession(auth.token);
        else await h.accounts.setAdmin(owner.account.id, false);
        finish();
        const result = await pending;
        assert([401, 403].includes(result.code));
        assert.deepEqual(seen, [owner.account.id]);
        assert.equal(JSON.stringify(result.body).includes('must-not-be-returned'), false);
      });
    }
  }
});

test('Meteora public discovery, owner setup, private module and wallet actions keep separate HTTP access gates', async t => {
  let ownerId = '', calls = [];
  const meteora = {
    start() {}, stop() {}, treasurySources:async()=>[], analyticsTrades:async()=>[],
    publicStatus:async()=>({available:true,publicEnabled:true,pairs:[]}),
    ownerStatus:async(session,context)=>{await context.authorize();calls.push(['status',session.account.id]);return {configured:true};},
    setup:async(session,input,context)=>{await context.authorize();calls.push(['setup',session.account.id,input]);return {configured:true};},
    setEnabled:async(session,input,context)=>{await context.authorize();calls.push(['enabled',session.account.id,input]);return {enabled:input.enabled};},
    prepare:async(session,input,context)=>{await context.authorize();calls.push(['prepare',session.account.id,input]);return {ok:true};},
    listAccount:async()=>({launches:[]}), operations:async()=>({operations:[]}),
  };
  const pumpTest = {requireOwner:async session=>{if(session.account.id!==ownerId)throw Object.assign(Error('Owner required.'),{statusCode:403});}};
  const h=await fixture(t,{meteora,pumpTest}), regular=await h.user('meteora_regular'), owner=await h.user('meteora_owner');
  ownerId=owner.account.id;
  assert.equal((await h.request('/api/launchpad/meteora/status')).body.publicEnabled,true);
  assert.equal((await h.request('/api/admin/meteora/status')).code,401);
  assert.equal((await h.request('/admin-meteora-ui.mjs')).code,401);
  assert.equal((await h.request('/api/admin/meteora/setup',{auth:regular,body:{}})).code,403);
  assert.equal((await h.request('/api/launchpad/meteora/prepare',{auth:regular,body:{action:'initialize'},headers:{'x-control-token':'wrong'}})).code,403);
  assert.equal((await h.request('/api/launchpad/meteora/prepare',{auth:regular,body:{action:'initialize'}})).code,200);
  assert.equal(calls.at(-1)[1],regular.account.id);
  await h.accounts.setAdmin(ownerId);
  assert.equal((await h.request('/api/admin/meteora/status',{auth:owner})).code,403);
  const setup=await h.accounts.beginMfa(ownerId,password);await h.accounts.enableMfa(ownerId,password,totp(setup.secret,Date.now()));
  const auth=await h.accounts.createSession(ownerId,{mfaVerified:true});
  assert.equal((await h.request('/api/admin/meteora/status',{auth})).code,200);
  assert.equal((await h.request('/admin-meteora-ui.mjs',{auth})).code,200);
  assert.equal((await h.request('/api/admin/meteora/setup',{auth,body:{}})).code,200);
  assert.equal((await h.request('/api/admin/meteora/configure',{auth,body:{enabled:true}})).body.enabled,true);
  assert.equal((await h.request('/api/admin/meteora/setup',{auth})).code,405);
  assert.equal((await h.request('/api/admin/meteora/status?accountId=another',{auth})).code,405);
  assert.equal((await h.request('/api/admin/meteora/configure',{auth,body:{enabled:true},headers:{'x-control-token':'wrong'}})).code,403);
  for(const path of ['/meteora-ui.mjs','/meteora-account.css','/meteora-trade-ui.mjs'])assert.equal((await h.request(path)).code,200,path);
  ownerId='different-owner';
  assert.equal((await h.request('/api/admin/meteora/status',{auth})).code,403);
  assert.equal((await h.request('/admin-meteora-ui.mjs',{auth})).code,403);
});


test('global reward sweeps retain admin MFA CSRF and fresh proof while accepting only a global request identity',async t=>{
  const calls=[],path='/api/admin/reward-sweeps',adminPanel={readRewardSweeps:async actor=>{calls.push(['read',actor]);return{job:null};},distributeAllRewardSweeps:async(actor,body,context)=>{await context.authorize();calls.push(['sweep',actor,body]);return{job:{requestId:body.requestId,state:'queued'}};}};
  const h=await fixture(t,{adminPanel}),owner=await h.user('reward_sweep_admin'),other=await h.user('reward_sweep_user');
  assert.equal((await h.request(path)).code,401);assert.equal((await h.request(path,{auth:other})).code,403);
  assert.equal((await h.request(path,{auth:other,body:{requestId:'a'.repeat(32)}})).code,403);
  await h.accounts.setAdmin(owner.account.id);assert.equal((await h.request(path,{auth:owner})).code,403);
  let now=Date.now();h.accounts.now=()=>now;const setup=await h.accounts.beginMfa(owner.account.id,password);await h.accounts.enableMfa(owner.account.id,password,totp(setup.secret,now));const auth=await h.accounts.createSession(owner.account.id,{mfaVerified:true});
  for(const body of [undefined,{requestId:'a'.repeat(32)}])assert.equal((await h.request(path,{auth,body,headers:{'x-control-token':'wrong'}})).code,403);
  assert.deepEqual(calls,[]);const read=await h.request(path,{auth});assert.equal(read.code,200);assert.deepEqual(read.body,{job:null});assert.equal(read.headers.get('cache-control'),'no-store');
  assert.equal((await h.request(path,{auth,body:{requestId:'a'.repeat(32),password:'wrong',code:'invalid'}})).code,400);assert.equal(calls.length,1);
  now+=30000;const response=await h.request(path,{auth,body:{requestId:'a'.repeat(32),password,code:totp(setup.secret,now),accountId:other.account.id,ids:['do-not-filter'],quoteMint:'do-not-filter'}});
  assert.equal(response.code,202);assert.deepEqual(calls.at(-1),['sweep',owner.account.id,{requestId:'a'.repeat(32)}]);
  await h.accounts.setAdmin(owner.account.id,false);assert.equal((await h.request(path,{auth})).code,403);
  for(const suffix of ['/private','-extra','/'])assert.equal((await h.request(path+suffix,{auth})).code,404);assert.deepEqual(h.blocked,[]);
});

test('global sweep status cannot disclose a response after session revocation',async t=>{
  let revoke=async()=>{};const h=await fixture(t,{adminPanel:{readRewardSweeps:async()=>{await revoke();return{job:{requestId:'private-sweep'}};}}}),owner=await h.user('sweep_read_revoked');
  await h.accounts.setAdmin(owner.account.id);const setup=await h.accounts.beginMfa(owner.account.id,password);await h.accounts.enableMfa(owner.account.id,password,totp(setup.secret,Date.now()));const auth=await h.accounts.createSession(owner.account.id,{mfaVerified:true});
  revoke=()=>h.accounts.revokeSession(auth.token);const result=await h.request('/api/admin/reward-sweeps',{auth});assert.equal(result.code,401);assert.doesNotMatch(JSON.stringify(result.body),/private-sweep/);
});
