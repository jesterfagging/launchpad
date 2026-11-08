import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { AccountService } from '../src/accounts.mjs';
import { createAccountApp } from '../src/account-app.mjs';
import { MeteoraService } from '../src/meteora-service.mjs';
import { totp } from '../src/totp.mjs';

const key = () => Keypair.generate().publicKey.toBase58();
const visibilityPath = '/api/admin/moderation/launch';
const archivePath = '/api/admin/launches/archive';

// Real HTTP authorization, account storage and Meteora moderation methods.
// The isolated journal contains no signers and this fixture has no chain adapter.
async function fixture(t, status = 'trading') {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-meteora-moderation-'));
  const accounts = await new AccountService(dir).init(), password = 'meteora-moderation-test-password-123';
  const adminAccount = await accounts.register('moderation_admin', password);
  await accounts.setAdmin(adminAccount.id);
  const mfa = await accounts.beginMfa(adminAccount.id, password);
  await accounts.enableMfa(adminAccount.id, password, totp(mfa.secret, Date.now()));
  const admin = await accounts.createSession(adminAccount.id, { mfaVerified: true });
  const userAccount = await accounts.register('moderation_creator', password), user = await accounts.createSession(userAccount.id);
  const launch = { id: randomUUID(), mint: key(), creatorId: userAccount.id, creatorWallet: userAccount.mainWallet,
    name: 'Moderation fixture', symbol: 'MOD', status, finalizedAt: status === 'trading' ? Date.now() : null,
    quoteMint: 'So11111111111111111111111111111111111111112', quoteSymbol: 'SOL', quoteDecimals: 9,
    feeMode: 'creator', creatorRecipient: userAccount.mainWallet, creatorAuthority: key(), ledger: { creatorCredit: '0' } };
  let data = { schemaVersion: 1, enabled: false, launches: [launch], operations: [] }, writes = 0, ownerAllowed = true;
  const service = new MeteoraService({ accounts, adapter: {} });
  service.closed = true;
  service.load = async () => structuredClone(data);
  service.save = async value => { writes++; data = structuredClone(value); };
  const explore = { registryLoaded: true, listCache: new Map([['old', true]]) };
  const server = createAccountApp({ accounts, runtimes: {}, policy: {}, meteora: service,
    pumpTest: { requireOwner: async session => { if (!ownerAllowed || session.account.id !== admin.account.id) throw Object.assign(Error('Owner access required.'), { statusCode: 403 }); } },
    launchpad: {}, pumpPublic: {}, dammPump: {}, dammPumpTest: {}, marketData: {}, protocolFees: {},
    protocolTreasury: {}, protocolGasFunding: {}, branding: {}, adminPanel: {}, adminRevenue: {},
    adminRevenueAudit: {}, explore, trading: {}, adminVolume: {}, lifetimeVolume: {}, publicAnalytics: {}, publicBurnSupply: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.closeServices(); await rm(dir, { recursive: true, force: true }); });
  const body = extra => ({ route: 'meteora', accountId: userAccount.id, id: launch.id, mint: launch.mint, ...extra });
  async function request(path, { auth = admin, input, headers = {}, method = 'POST' } = {}) {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json',
      ...(auth ? { cookie: `launchpad-session=${auth.token}`, 'x-control-token': auth.csrfToken } : {}), ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  return { accounts, admin, user, service, explore, body, request, read: () => structuredClone(data), get writes() { return writes; }, set ownerAllowed(value) { ownerAllowed = value; } };
}

test('native Meteora admin hide and restore dispatch to the real service and invalidate discovery', async t => {
  const h = await fixture(t);
  for (const hidden of [true, false]) {
    h.explore.registryLoaded = true; h.explore.listCache.set('old', true);
    const result = await h.request(visibilityPath, { input: h.body({ hidden, reason: 'Reviewed visibility change.' }) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.route, 'meteora'); assert.equal(result.body.hidden, hidden);
    assert.equal(h.read().launches[0].moderation.hidden, hidden);
    assert.equal((await h.service.publicList()).length, hidden ? 0 : 1);
    assert.equal(h.explore.registryLoaded, false); assert.equal(h.explore.listCache.size, 0);
  }
  assert.equal(h.writes, 2); assert.equal(h.read().launches[0].moderationHistory.length, 2);
});

test('native Meteora admin archive and restore retain exact launch identity and reject live coins', async t => {
  const h = await fixture(t, 'draft');
  for (const archived of [true, false]) {
    const result = await h.request(archivePath, { input: h.body({ archived }) });
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.route, 'meteora');
    assert.equal(result.body.launch.id, h.body().id); assert.equal(result.body.launch.mint, h.body().mint);
    assert.equal(result.body.launch.manuallyArchived, archived);
    assert.equal(h.read().launches[0].listArchive.archived, archived);
  }
  assert.equal(h.writes, 2);
  const live = await fixture(t);
  assert.equal((await live.request(archivePath, { input: live.body({ archived: true }) })).status, 409);
  assert.equal(live.writes, 0);
});

test('native Meteora moderation rejects unauthenticated, wrong-role, bad-CSRF, identity and unknown-route requests', async t => {
  const h = await fixture(t, 'draft');
  for (const [path, action] of [[visibilityPath, { hidden: true, reason: 'Reviewed visibility change.' }], [archivePath, { archived: true }]]) {
    const input = h.body(action);
    assert.equal((await h.request(path, { auth: null, input })).status, 401);
    assert.equal((await h.request(path, { auth: h.user, input })).status, 403);
    assert.equal((await h.request(path, { input, headers: { 'x-control-token': 'wrong' } })).status, 403);
    assert.equal((await h.request(path, { input: { ...input, route: 'unknown' } })).status, 400);
    for (const mismatch of [{ id: randomUUID() }, { mint: key() }, { accountId: h.admin.account.id }]) {
      assert.equal((await h.request(path, { input: { ...input, ...mismatch } })).status, 404);
    }
  }
  assert.equal(h.writes, 0);
});

test('native Meteora moderation rechecks admin permission after waiting for journal access', async t => {
  const h = await fixture(t);
  const load = h.service.load.bind(h.service);
  h.service.load = async () => { const data = await load(); await h.accounts.mutate(registry => { registry.accounts.find(row => row.id === h.admin.account.id).role = 'user'; }); return data; };
  const result = await h.request(visibilityPath, { input: h.body({ hidden: true, reason: 'Reviewed visibility change.' }) });
  assert.equal(result.status, 403); assert.equal(h.writes, 0);
});

test('every native Meteora launch HTTP action enforces method, query, session and CSRF before dispatch', async t => {
  const h = await fixture(t), calls = [], methods = { launches: 'listAccount', operations: 'operations', prepare: 'prepare', submit: 'submit', reconcile: 'reconcile', confirm: 'reconcile', cancel: 'cancel', wallet: 'wallet', reroute: 'rerouteCreator' };
  for (const method of new Set(Object.values(methods))) h.service[method] = async (session, ...args) => {
    const context = args.at(-1), current = await context.authorize();
    assert.equal(current.account.id, session.account.id); assert.equal(typeof context.sessionToken, 'string');
    calls.push({ method, id: session.account.id, input: args.length === 2 ? args[0] : null });
    return { dispatched: method, ...(method === 'reconcile' ? { operation: { action: 'initialize', state: 'finalized' } } : {}) };
  };
  for (const [action, method] of Object.entries(methods)) {
    const path = '/api/launchpad/meteora/' + action, read = ['launches', 'operations'].includes(action), args = { auth: h.user, method: read ? 'GET' : 'POST', input: { marker: action } };
    const before = calls.length;
    assert.equal((await h.request(path, { ...args, auth: null })).status, 401, action + ' guest');
    assert.equal((await h.request(path, { ...args, headers: { 'x-control-token': 'wrong' } })).status, 403, action + ' CSRF');
    assert.equal((await h.request(path, { ...args, method: read ? 'POST' : 'GET' })).status, 405, action + ' method');
    assert.equal((await h.request(path + '?ownerId=override', args)).status, 405, action + ' query');
    assert.equal(calls.length, before);
    h.explore.registryLoaded = true;
    const response = await h.request(path, args); assert.equal(response.status, 200, action + JSON.stringify(response.body));
    assert.deepEqual(calls.at(-1), { method, id: h.user.account.id, input: read ? null : { marker: action } });
    if (method === 'reconcile') assert.equal(h.explore.registryLoaded, false);
  }
  assert.equal((await h.request('/api/launchpad/meteora/unknown', { auth: h.user, input: {} })).status, 404);
  for (const suffix of ['status', 'pairs']) {
    h.service.publicStatus = async () => ({ available: true, pairs: [] });
    const path = '/api/launchpad/meteora/' + suffix;
    assert.equal((await h.request(path, { auth: null, method: 'GET' })).status, 200);
    assert.equal((await h.request(path, { auth: null, input: {} })).status, 405);
    assert.equal((await h.request(path + '?override=true', { auth: null, method: 'GET' })).status, 400);
  }
});

test('every native Meteora action suppresses asynchronous results after session revocation', async t => {
  const h = await fixture(t), methods = { launches: 'listAccount', operations: 'operations', prepare: 'prepare', submit: 'submit', reconcile: 'reconcile', confirm: 'reconcile', cancel: 'cancel', wallet: 'wallet', reroute: 'rerouteCreator' };
  for (const [action, method] of Object.entries(methods)) {
    const auth = await h.accounts.createSession(h.user.account.id), read = ['launches', 'operations'].includes(action);
    h.service[method] = async (_session, ...args) => { await args.at(-1).authorize(); await h.accounts.revokeSession(auth.token); return { privateResult: 'must-not-return' }; };
    const response = await h.request('/api/launchpad/meteora/' + action, { auth, method: read ? 'GET' : 'POST', input: {} });
    assert.equal(response.status, 401, action); assert.doesNotMatch(JSON.stringify(response.body), /must-not-return/);
  }
});

test('native Meteora owner controls include pairs and refresh with MFA, ownership, query and method gates', async t => {
  const h = await fixture(t), calls = [];
  for (const method of ['ownerStatus', 'setup', 'setEnabled']) h.service[method] = async (session, ...args) => { await args.at(-1).authorize(); calls.push(method); return { ok: true }; };
  const noFactorAccount = await h.accounts.register('moderation_no_factor', 'meteora-moderation-test-password-123');
  await h.accounts.setAdmin(noFactorAccount.id);
  const noFactor = await h.accounts.createSession(noFactorAccount.id);
  for (const action of ['status', 'pairs', 'refresh-pairs', 'setup', 'configure']) {
    const path = '/api/admin/meteora/' + action, get = ['status', 'pairs'].includes(action), args = { method: get ? 'GET' : 'POST', input: {} };
    assert.equal((await h.request(path, { ...args, auth: null })).status, 401, action + ' guest');
    assert.equal((await h.request(path, { ...args, auth: h.user })).status, 403, action + ' user');
    assert.equal((await h.request(path, { ...args, auth: noFactor })).status, 403, action + ' MFA');
    assert.equal((await h.request(path, { ...args, headers: { 'x-control-token': 'wrong' } })).status, 403, action + ' CSRF');
    assert.equal((await h.request(path, { ...args, method: get ? 'POST' : 'GET' })).status, 405, action + ' method');
    assert.equal((await h.request(path + '?override=true', args)).status, 405, action + ' query');
    h.ownerAllowed = false; assert.equal((await h.request(path, args)).status, 403, action + ' owner'); h.ownerAllowed = true;
    const result = await h.request(path, args); assert.equal(result.status, 200, action + JSON.stringify(result.body));
    if (action === 'pairs') assert.deepEqual(result.body, { assets: [] });
    if (action === 'refresh-pairs') assert.equal(result.body.scheduled, true);
  }
  assert.deepEqual(calls, ['ownerStatus', 'setup', 'setEnabled']);
});
