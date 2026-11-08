// HTTP-level checks for the vanity address routes: they are launchpad routes;
// reading needs the two-factor platform owner with the session's control token;
// adding and removing also need the password and 2FA code; large solana-keygen
// batches fit; no response ever carries a private key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountApp } from '../src/account-app.mjs';
import { launchpadApi } from '../src/product-mode.mjs';
import { VanityMintPool } from '../src/vanity-pool.mjs';
import { generateWallet } from '../src/pump-classic/service.mjs';
import { base58Decode } from '../src/pump-classic/codec.mjs';

const ADMIN_ID = 'a'.repeat(32), USER_ID = 'b'.repeat(32);
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'launchpad-vanity-http-')), docs = new Map(), audits = [];
  const admin = { id: ADMIN_ID, username: 'owner', role: 'admin', mfaEnabled: true, authType: 'password', banned: false, mainWallet: '' };
  const user = { id: USER_ID, username: 'mira', role: 'user', mfaEnabled: false, authType: 'wallet', banned: false, mainWallet: '' };
  const sessions = { 'admin-session': { account: admin, mfaVerified: true, authType: 'password' }, 'user-session': { account: user, mfaVerified: false, authType: 'wallet', walletVerified: true, walletAddress: 'Xther1111111111111111111111111111111111111' } };
  const accounts = { dir, master: Buffer.alloc(32), hostStore: { read: async () => null, write: async () => {} }, list: async () => [admin, user], get: async id => id === ADMIN_ID ? admin : id === USER_ID ? user : null, registry: async () => ({ accounts: [] }),
    getSession: async token => sessions[token] || null, getSessionWithCsrf: async (token, csrf) => ({ session: sessions[token] || null, csrfValid: csrf === token + '-csrf' }),
    reauthenticate: async (id, password, code) => { if (password !== 'test-password' || code !== '123456') throw Object.assign(Error('Authentication failed.'), { statusCode: 403 }); }, audit: async (id, action) => { audits.push(action); } };
  const pool = new VanityMintPool({ accounts, store: { read: async (key, fallback) => docs.has(key) ? structuredClone(docs.get(key)) : fallback, write: async (key, value) => { docs.set(key, structuredClone(value)); } } });
  const server = createAccountApp({ accounts, runtimes: {}, policy: {}, publicUrl: 'https://launch.example', launchpad: {}, marketData: {}, funding: {}, protocolFees: {}, protocolTreasury: {}, branding: {}, adminPanel: {}, adminRevenue: {}, explore: {}, trading: {}, adminVolume: {}, lifetimeVolume: {}, adminBurnHistory: {}, publicAnalytics: { invalidate() {}, read: async () => ({}) }, vanityPool: pool });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.closeServices(); rmSync(dir, { recursive: true, force: true }); });
  const request = (path, { method = 'GET', session = null, csrf = true, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: { host: 'launch.example', 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.9', origin: 'https://launch.example', ...(session ? { cookie: 'launchpad-session=' + session, 'x-control-token': csrf ? session + '-csrf' : 'wrong' } : {}), 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, text, data: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null }); }); res.on('error', reject);
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { request, docs, audits };
}
const credentials = { password: 'test-password', code: '123456' };

test('vanity routes are launchpad admin routes for the two-factor platform owner', async t => {
  for (const path of ['/api/admin/vanity', '/api/admin/vanity/import', '/api/admin/vanity/remove']) assert.equal(launchpadApi(path), true, path);
  assert.equal(launchpadApi('/api/admin/vanity/export'), false);
  const f = await fixture(t);
  assert.equal((await f.request('/api/admin/vanity')).status, 401);
  assert.equal((await f.request('/api/admin/vanity', { session: 'user-session' })).status, 403);
  assert.equal((await f.request('/api/admin/vanity', { session: 'admin-session', csrf: false })).status >= 401, true);
  const view = await f.request('/api/admin/vanity', { session: 'admin-session' });
  assert.equal(view.status, 200); assert.deepEqual([view.data.counts.available, view.data.pool, view.data.used], [0, [], []]);
  const key = generateWallet();
  assert.equal((await f.request('/api/admin/vanity/import', { method: 'POST', session: 'user-session', body: { entries: [{ name: 'k', text: key.secret }], ...credentials } })).status, 403);
  assert.equal((await f.request('/api/admin/vanity/import', { method: 'POST', session: 'admin-session', body: { entries: [{ name: 'k', text: key.secret }], password: 'wrong', code: '000000' } })).status, 403, 'adding needs the password and 2FA code');
  assert.equal(f.docs.size, 0, 'nothing was stored');
});

test('adding a solana-keygen batch and removing an address; no response carries a key', async t => {
  const f = await fixture(t), keys = Array.from({ length: 1200 }, () => generateWallet());
  const entries = keys.map(k => ({ name: k.address + '.json', text: JSON.stringify([...base58Decode(k.secret)]) }));
  assert.ok(JSON.stringify({ entries }).length > 262144, 'larger than the default request limit');
  const added = await f.request('/api/admin/vanity/import', { method: 'POST', session: 'admin-session', body: { entries, scope: 'pump', ...credentials } });
  assert.equal(added.status, 200); assert.equal(added.data.added.length, 1200); assert.deepEqual(added.data.rejected, []);
  assert.equal(added.data.view.counts.byScope.pump, 1200);
  for (const k of keys.slice(0, 50)) assert.equal(added.text.includes(k.secret), false);
  const again = await f.request('/api/admin/vanity/import', { method: 'POST', session: 'admin-session', body: { entries: [{ name: 'pasted text', text: `address,private_key\n${keys[0].address},${keys[0].secret}\nnot-a-key` }], ...credentials } });
  assert.equal(again.status, 200); assert.deepEqual(again.data.added, []);
  assert.deepEqual(again.data.rejected, [{ where: 'pasted text line 2', reason: 'already in the pool' }, { where: 'pasted text line 3', reason: 'not a private key' }]);
  const removed = await f.request('/api/admin/vanity/remove', { method: 'POST', session: 'admin-session', body: { addresses: [keys[1].address], ...credentials } });
  assert.equal(removed.status, 200); assert.deepEqual(removed.data.removed, [keys[1].address]);
  const view = await f.request('/api/admin/vanity', { session: 'admin-session' });
  assert.equal(view.data.counts.available, 1199);
  for (const k of keys.slice(0, 50)) assert.equal(view.text.includes(k.secret), false);
  assert.deepEqual(f.audits, ['vanity-addresses-added', 'vanity-addresses-added', 'vanity-addresses-removed']);
  const tooBig = await f.request('/api/admin/vanity/import', { method: 'POST', session: 'admin-session', body: { entries: [{ name: 'big', text: 'x'.repeat(1100000) }], ...credentials } });
  assert.equal(tooBig.status, 413);
});

test('the vanity view route pages and filters with query parameters and keeps the full view without them', async t => {
  const f = await fixture(t), keys = Array.from({ length: 30 }, () => generateWallet());
  const added = await f.request('/api/admin/vanity/import', { method: 'POST', session: 'admin-session', body: { entries: keys.map(k => ({ name: k.address + '.json', text: JSON.stringify([...base58Decode(k.secret)]) })), scope: 'all', ...credentials } });
  assert.equal(added.status, 200); assert.equal(added.data.added.length, 30);
  const page = await f.request('/api/admin/vanity?poolOffset=25&poolLimit=25&usedOffset=0&usedLimit=25', { session: 'admin-session' });
  assert.equal(page.status, 200); assert.deepEqual([page.data.pool.length, page.data.poolTotal, page.data.poolMatched, page.data.poolOffset, page.data.poolNextOffset, page.data.usedTotal], [5, 30, 30, 25, null, 0]);
  const found = await f.request('/api/admin/vanity?search=' + encodeURIComponent(keys[3].address.slice(0, 6)) + '&poolOffset=0&poolLimit=25', { session: 'admin-session' });
  assert.equal(found.status, 200); assert.equal(found.data.pool[0].address, keys[3].address);
  const bad = await f.request('/api/admin/vanity?poolOffset=0&poolLimit=25&poolState=nonsense', { session: 'admin-session' });
  assert.equal(bad.status, 400);
  const whole = await f.request('/api/admin/vanity', { session: 'admin-session' });
  assert.equal(whole.data.pool.length, 30);
  for (const k of keys) assert.equal(page.text.includes(k.secret) || found.text.includes(k.secret), false);
});
