// HTTP-level checks for the admin Cleanup routes (v71.26): reading the list needs
// a two-factor administrator with the session's control token; "archive all"
// also needs the password and 2FA code and a saved request id; the paged
// account search keeps the full list without parameters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountApp } from '../src/account-app.mjs';
import { launchpadApi } from '../src/product-mode.mjs';

const ADMIN_ID = 'a'.repeat(32), USER_ID = 'b'.repeat(32), NOW = 1790668800000;
const failedLaunch = { id: 'c'.repeat(32), state: 'failed', createdAt: NOW - 3 * 86400000, input: { route: 'raydium', network: 'mainnet-beta', name: 'Broken Coin', symbol: 'BRK', quoteMint: 'So11111111111111111111111111111111111111112' }, review: { quoteDecimals: 9, quoteSymbol: 'SOL' }, keys: { mint: { address: 'Ax7vB1Fhk3bQ6Yw2NNhtWT2ofZtrTmqP3Lhwz9LDpump' }, wallet: { secret: 'NEVER_PRINTED' } }, operations: [{ kind: 'create', state: 'failed' }], credits: { quote: '0', base: '0' }, gas: { reserved: '0' }, error: 'The launch transaction expired before it executed.' };
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'launchpad-cleanup-http-')), docs = new Map(), audits = [];
  const admin = { id: ADMIN_ID, username: 'owner', role: 'admin', mfaEnabled: true, authType: 'password', banned: false, mainWallet: '' };
  const user = { id: USER_ID, username: 'mira', role: 'user', mfaEnabled: false, authType: 'wallet', banned: false, mainWallet: 'Xther1111111111111111111111111111111111111' };
  const extra = Array.from({ length: 30 }, (_, i) => ({ id: (i + 10).toString(16).padStart(32, '0'), username: 'maker_' + i, role: 'user', mfaEnabled: false, authType: i % 2 ? 'wallet' : 'password', banned: false, mainWallet: '' }));
  const sessions = { 'admin-session': { account: admin, mfaVerified: true, authType: 'password' }, 'user-session': { account: user, mfaVerified: false, authType: 'wallet', walletVerified: true, walletAddress: user.mainWallet } };
  const hostStore = { read: async (key, fallback) => docs.has(key) ? structuredClone(docs.get(key)) : fallback, write: async (key, value) => { docs.set(key, structuredClone(value)); } };
  const accounts = { dir, master: Buffer.alloc(32), hostStore, list: async () => [admin, user, ...extra], get: async id => [admin, user, ...extra].find(a => a.id === id) || null, registry: async () => ({ accounts: [] }),
    getSession: async token => sessions[token] || null, getSessionWithCsrf: async (token, csrf) => ({ session: sessions[token] || null, csrfValid: csrf === token + '-csrf' }),
    reauthenticate: async (id, password, code) => { if (password !== 'test-password' || code !== '123456') throw Object.assign(Error('Authentication failed.'), { statusCode: 403 }); }, audit: async (id, action) => { audits.push(action); } };
  const books = new Map([[USER_ID, { launches: [failedLaunch] }]]);
  const launchpad = { book: async id => structuredClone(books.get(id) || { launches: [] }), locked: async (id, fn) => { const book = structuredClone(books.get(id) || { launches: [] }); const result = await fn(book); return result; }, save: async (id, book) => { books.set(id, structuredClone(book)); }, find: (book, id) => book.launches.find(l => l.id === id), known: new Set(), kick() {}, start() {}, close: async () => {} };
  const server = createAccountApp({ accounts, runtimes: {}, policy: {}, publicUrl: 'https://launch.example', launchpad, marketData: {}, funding: {}, protocolFees: {}, protocolTreasury: {}, branding: {}, adminPanel: {}, adminRevenue: {}, explore: {}, trading: {}, adminVolume: {}, lifetimeVolume: {}, adminBurnHistory: {}, publicAnalytics: { invalidate() {}, read: async () => ({}) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.closeServices(); rmSync(dir, { recursive: true, force: true }); });
  const request = (path, { method = 'GET', session = null, csrf = true, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: { host: 'launch.example', 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.9', origin: 'https://launch.example', ...(session ? { cookie: 'launchpad-session=' + session, 'x-control-token': csrf ? session + '-csrf' : 'wrong' } : {}), 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, text, data: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null }); }); res.on('error', reject);
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { request, docs, audits, books };
}
const credentials = { password: 'test-password', code: '123456' };

test('the cleanup list is an admin launchpad route: session, role and control token are checked; keys never leave', async t => {
  for (const path of ['/api/admin/cleanup', '/api/admin/cleanup/archive-all']) assert.equal(launchpadApi(path), true, path);
  const f = await fixture(t);
  assert.equal((await f.request('/api/admin/cleanup')).status, 401);
  assert.equal((await f.request('/api/admin/cleanup', { session: 'user-session' })).status, 403);
  assert.equal((await f.request('/api/admin/cleanup', { session: 'admin-session', csrf: false })).status >= 401, true);
  const list = await f.request('/api/admin/cleanup?limit=25&offset=0', { session: 'admin-session' });
  assert.equal(list.status, 200);
  assert.deepEqual([list.data.total, list.data.rows.length, list.data.rows[0].route, list.data.rows[0].kind, list.data.rows[0].actions, list.data.counts.failed], [1, 1, 'raydium', 'failed', ['archive'], 1]);
  assert.equal(list.text.includes('NEVER_PRINTED'), false);
  assert.equal((await f.request('/api/admin/cleanup?limit=5000', { session: 'admin-session' })).status, 400);
  assert.deepEqual((await f.request('/api/admin/cleanup?venue=meteora', { session: 'admin-session' })).data.rows, []);
});

test('archive all needs the password, 2FA code and a request id; it reports the bulk archive and the Pump.fun part', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/admin/cleanup/archive-all', { method: 'POST', session: 'user-session', body: { requestId: '1'.repeat(32), ...credentials } })).status, 403);
  assert.equal((await f.request('/api/admin/cleanup/archive-all', { method: 'POST', session: 'admin-session', body: { requestId: '1'.repeat(32), password: 'wrong', code: '000000' } })).status, 403);
  assert.equal((await f.request('/api/admin/cleanup/archive-all', { method: 'POST', session: 'admin-session', body: { requestId: 'nope', ...credentials } })).status, 400);
  const done = await f.request('/api/admin/cleanup/archive-all', { method: 'POST', session: 'admin-session', body: { requestId: '1'.repeat(32), reason: 'Archive all finished failures from the admin panel.', ...credentials } });
  assert.equal(done.status, 200);
  assert.deepEqual([done.data.requestId, done.data.status, done.data.archivedCount, done.data.pumpFun], ['1'.repeat(32), 'completed', 1, { skipped: 'unavailable', archived: 0 }], 'the settled Raydium failure is archived; Pump.fun is off on this host');
  assert.equal(f.books.get(USER_ID).launches[0].listArchive?.archived, true);
  const after = await f.request('/api/admin/cleanup', { session: 'admin-session' });
  assert.deepEqual([after.data.rows, after.data.counts.archived], [[], 1], 'archived rows leave the default list');
  assert.equal((await f.request('/api/admin/cleanup?kind=archived&archived=1', { session: 'admin-session' })).data.rows[0].actions[0], 'restore');
});

test('the account list pages and searches only when asked', async t => {
  const f = await fixture(t);
  const whole = await f.request('/api/admin/accounts', { session: 'admin-session' });
  assert.equal(whole.status, 200); assert.equal(whole.data.accounts.length, 32); assert.equal(whole.data.total, undefined);
  const page = await f.request('/api/admin/accounts?search=maker_1&limit=5', { session: 'admin-session' });
  assert.deepEqual([page.data.total, page.data.accounts.length, page.data.nextOffset, page.data.totalAll], [11, 5, 5, 32]);
  assert.equal((await f.request('/api/admin/accounts?limit=500', { session: 'admin-session' })).status, 400);
  assert.equal((await f.request('/api/admin/accounts?search=x', { session: 'user-session' })).status, 403);
});
