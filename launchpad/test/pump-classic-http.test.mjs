// HTTP-level checks for Pump.fun launch routes: they belong to launchpad mode; a
// disabled host reports Pump.fun as unavailable and answers 503 to launch and
// admin writes; public reads need no session; launch actions need the right
// method and a CSRF-bound session, checked before anything is provisioned;
// administration needs the two-factor platform owner plus reauthentication and
// never returns key material.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountApp } from '../src/account-app.mjs';
import { launchpadApi } from '../src/product-mode.mjs';

const ADMIN_ID = 'a'.repeat(32), USER_ID = 'b'.repeat(32);
async function fixture(t, { enabled = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'launchpad-pump-classic-'));
  const keys = ['LAUNCHPAD_PUMP_CLASSIC_ENABLED', 'LAUNCHPAD_PUMP_CLASSIC_DB_PATH'], previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  if (enabled) { process.env.LAUNCHPAD_PUMP_CLASSIC_ENABLED = '1'; process.env.LAUNCHPAD_PUMP_CLASSIC_DB_PATH = join(dir, 'pump-classic.sqlite'); }
  else for (const key of keys) delete process.env[key];
  const admin = { id: ADMIN_ID, username: 'owner', role: 'admin', mfaEnabled: true, authType: 'password', banned: false, mainWallet: '' };
  const user = { id: USER_ID, username: 'mira', role: 'user', mfaEnabled: false, authType: 'wallet', banned: false, mainWallet: '' };
  const sessions = { 'admin-session': { account: admin, mfaVerified: true, authType: 'password' }, 'user-session': { account: user, mfaVerified: false, authType: 'wallet', walletVerified: true, walletAddress: 'Xther1111111111111111111111111111111111111' } };
  const writes = [];
  const accounts = { dir, master: Buffer.alloc(32), hostStore: { read: async () => null, write: async name => { writes.push(name); } }, list: async () => [admin, user], get: async id => id === ADMIN_ID ? admin : id === USER_ID ? user : null, registry: async () => ({ accounts: [] }),
    getSession: async token => sessions[token] || null, getSessionWithCsrf: async (token, csrf) => ({ session: sessions[token] || null, csrfValid: csrf === token + '-csrf' }),
    reauthenticate: async (id, password, code) => { if (password !== 'test-password' || code !== '123456') throw Object.assign(Error('Authentication failed.'), { statusCode: 403 }); }, audit: async () => {} };
  let server;
  try { server = createAccountApp({ accounts, runtimes: {}, policy: {}, publicUrl: 'https://launch.example', launchpad: {}, marketData: {}, funding: {}, protocolFees: {}, protocolTreasury: {}, branding: {}, adminPanel: {}, adminRevenue: {}, explore: {}, trading: {}, adminVolume: {}, lifetimeVolume: {}, adminBurnHistory: {}, publicAnalytics: { invalidate() {}, read: async () => ({}) } }); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.closeServices(); rmSync(dir, { recursive: true, force: true }); });
  const request = (path, { method = 'GET', session = null, csrf = true, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: { host: 'launch.example', 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.9', origin: 'https://launch.example', ...(session ? { cookie: 'launchpad-session=' + session, 'x-control-token': csrf ? session + '-csrf' : 'wrong' } : {}), 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, text, data: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null }); }); res.on('error', reject);
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { request, writes };
}
const control = (extra = {}) => ({ password: 'test-password', code: '123456', reason: 'Staged rollout step.', ...extra });
const MINT = 'X'.repeat(43);

test('Pump.fun routes are launchpad routes; a disabled host reports unavailable and refuses writes', async t => {
  for (const path of ['/api/launchpad/pump-classic/status', '/api/launchpad/pump-classic/quote', '/api/launchpad/pump-classic/coin', '/api/admin/pump-classic', '/api/admin/pump-classic/control']) assert.equal(launchpadApi(path), true, path);
  const f = await fixture(t);
  const status = await f.request('/api/launchpad/pump-classic/status');
  assert.equal(status.status, 200); assert.equal(status.data.available, false); assert.match(status.data.reason, /not enabled/);
  const pairs = await f.request('/api/launchpad/pump-classic/pairs');
  assert.equal(pairs.status, 200); assert.equal(pairs.data.available, false); assert.deepEqual(pairs.data.pairs, [], 'a disabled host offers no pairs and reads nothing onchain');
  assert.equal((await f.request('/api/launchpad/pump-classic/pairs', { method: 'POST', session: 'user-session', body: {} })).status === 200, false, 'the pair list is read-only');
  assert.equal((await f.request('/api/launchpad/pump-classic/coin?mint=' + MINT)).status, 404);
  assert.equal((await f.request('/api/launchpad/pump-classic/launches', { session: 'user-session' })).status, 503);
  assert.equal((await f.request('/api/launchpad/pump-classic/quote', { method: 'POST', session: 'user-session', body: {} })).status, 503);
  const admin = await f.request('/api/admin/pump-classic', { session: 'admin-session' });
  assert.equal(admin.status, 200); assert.equal(admin.data.available, false); assert.match(admin.data.reason, /LAUNCHPAD_PUMP_CLASSIC_ENABLED=1/);
  assert.equal((await f.request('/api/admin/pump-classic/control', { method: 'POST', session: 'admin-session', body: control({ flags: { intake: true } }) })).status, 503);
  assert.deepEqual(f.writes, []);
});

test('public reads need no session; launch actions need the right method and a CSRF-bound session before anything is provisioned', async t => {
  const f = await fixture(t, { enabled: true });
  const status = await f.request('/api/launchpad/pump-classic/status');
  assert.equal(status.status, 200); assert.equal(status.data.available, true); assert.equal(status.data.intakeOpen, false); assert.equal(status.data.feeLink, '/docs#revenue');
  assert.deepEqual(status.data.modes.map(m => m.id), ['creator', 'holders', 'gotchi', 'agent', 'market_maker', 'lp_manager', 'diamond_hands', 'earned', 'insured']);
  assert.doesNotMatch(status.text, /shareBps|platformShare|secret/i, 'no platform-share numbers or key material in the public status');
  const pairs = await f.request('/api/launchpad/pump-classic/pairs');
  assert.equal(pairs.status, 200); assert.equal(pairs.data.pairsOpen, false); assert.deepEqual(pairs.data.pairs.map(p => p.mint), ['So11111111111111111111111111111111111111112'], 'with the pairs flag off the public list is SOL only and nothing is read onchain');
  assert.equal((await f.request('/api/launchpad/pump-classic/pairs', { session: 'user-session' })).data.ownerPreview, false, 'a signed-in user is not the owner');
  assert.equal((await f.request('/api/launchpad/pump-classic/coin?mint=not-a-mint')).status, 404);
  assert.equal((await f.request('/api/launchpad/pump-classic/coin?mint=' + MINT)).status, 404);
  assert.equal((await f.request('/api/launchpad/pump-classic/launches')).status, 401);
  assert.equal((await f.request('/api/launchpad/pump-classic/launches', { session: 'user-session', csrf: false })).status, 403);
  const mine = await f.request('/api/launchpad/pump-classic/launches', { session: 'user-session' }); assert.equal(mine.status, 200); assert.deepEqual(mine.data.launches, []);
  assert.equal((await f.request('/api/launchpad/pump-classic/launches', { method: 'POST', session: 'user-session', body: {} })).status, 405);
  assert.equal((await f.request('/api/launchpad/pump-classic/quote', { session: 'user-session' })).status, 405);
  assert.equal((await f.request('/api/launchpad/pump-classic/unknown', { method: 'POST', session: 'user-session', body: {} })).status, 404);
  assert.equal((await f.request('/api/launchpad/pump-classic/quote', { method: 'POST', session: 'user-session', body: {} })).status, 409, 'intake is closed by default');
  assert.equal((await f.request('/api/launchpad/pump-classic/cancel', { method: 'POST', session: 'user-session', csrf: false, body: { launchId: 'c'.repeat(24) } })).status, 403);
  assert.equal((await f.request('/api/launchpad/pump-classic/cancel', { method: 'POST', session: 'user-session', body: { launchId: 'c'.repeat(24) } })).status, 404);
  assert.equal((await f.request('/api/launchpad/pump-classic/fund/prepare', { method: 'POST', session: 'user-session', csrf: false, body: { launchId: 'c'.repeat(24) } })).status, 403);
  assert.equal((await f.request('/api/launchpad/pump-classic/fund/prepare', { method: 'POST', session: 'user-session', body: { launchId: 'c'.repeat(24) } })).status, 404);
  assert.equal((await f.request('/api/launchpad/pump-classic/fund/submit', { method: 'POST', session: 'user-session', csrf: false, body: { launchId: 'c'.repeat(24) } })).status, 403);
  // Open intake, then a cross-site quote (valid cookie, wrong CSRF token) is refused before any wallet is provisioned.
  assert.equal((await f.request('/api/admin/pump-classic/control', { method: 'POST', session: 'admin-session', body: control({ flags: { intake: true } }) })).status, 200);
  assert.equal((await f.request('/api/launchpad/pump-classic/status')).data.intakeOpen, true);
  const quote = { requestKey: 'r'.repeat(20), mode: 'creator', name: 'Orbit', symbol: 'ORBIT', image: '/token-images/' + 'c'.repeat(64) + '.png', wallet: 'Xther1111111111111111111111111111111111111', devBuySol: '0.01' };
  assert.equal((await f.request('/api/launchpad/pump-classic/quote', { method: 'POST', session: 'user-session', csrf: false, body: quote })).status, 403);
  assert.equal((await f.request('/api/launchpad/pump-classic/quote', { method: 'POST', session: 'user-session', body: { ...quote, requestKey: 'short' } })).status, 400);
  assert.deepEqual(f.writes, [], 'no launch keys were written');
});

test('administration needs the two-factor owner, changes are reauthenticated and no key material is returned', async t => {
  const f = await fixture(t, { enabled: true });
  assert.equal((await f.request('/api/admin/pump-classic')).status, 401);
  assert.equal((await f.request('/api/admin/pump-classic', { session: 'user-session' })).status, 403);
  assert.ok([401, 403].includes((await f.request('/api/admin/pump-classic', { session: 'admin-session', csrf: false })).status));
  const before = await f.request('/api/admin/pump-classic', { session: 'admin-session' });
  assert.equal(before.status, 200); assert.equal(before.data.available, true); assert.equal(before.data.effective.master, true);
  assert.deepEqual(Object.keys(before.data.flagLabels), ['intake', 'pairs', 'collection', 'routing', 'holders', 'strategies'], 'pairs other than SOL have their own flag (v71.19)');
  // v71.24: collection, sweeps and holder payouts run unless switched off; new launches, other pairs and strategy trading start off.
  assert.deepEqual(before.data.flags, { intake: false, pairs: false, collection: true, routing: true, holders: true, strategies: false }, 'operating flags start on, launch and trading flags start off'); assert.deepEqual(before.data.launches, []); assert.equal(before.data.database.ok, true);
  assert.doesNotMatch(before.text, /secret/i);
  assert.equal((await f.request('/api/admin/pump-classic/control', { method: 'POST', session: 'admin-session', body: { flags: { intake: true }, reason: 'no credentials' } })).status, 403);
  assert.equal((await f.request('/api/admin/pump-classic/control', { method: 'POST', session: 'user-session', body: control({ flags: { intake: true } }) })).status, 403);
  assert.ok([401, 403].includes((await f.request('/api/admin/pump-classic/control', { method: 'POST', session: 'admin-session', csrf: false, body: control({ flags: { intake: true } }) })).status));
  assert.equal((await f.request('/api/admin/pump-classic/control', { method: 'POST', session: 'admin-session', body: control({ flags: { intake: true }, reason: 'x' }) })).status, 400);
  assert.equal((await f.request('/api/admin/pump-classic/control', { method: 'POST', session: 'admin-session', body: control({ flags: { bogus: true } }) })).status, 400);
  const changed = await f.request('/api/admin/pump-classic/control', { method: 'POST', session: 'admin-session', body: control({ flags: { collection: false } }) });
  assert.equal(changed.status, 200, changed.text);
  const after = await f.request('/api/admin/pump-classic', { session: 'admin-session' });
  assert.equal(after.data.flags.collection, false, 'a saved choice wins over the default'); assert.equal(after.data.effective.collection, false); assert.equal(after.data.flags.intake, false);
  const verify = await f.request('/api/admin/pump-classic/keys/verify', { method: 'POST', session: 'admin-session', body: control() });
  assert.equal(verify.status, 200); assert.equal(verify.data.ok, true); assert.equal(verify.data.checked, 0);
  assert.equal((await f.request('/api/admin/pump-classic/unknown', { method: 'POST', session: 'admin-session', body: control() })).status, 404);
  // Returning a retired strategy's SOL goes through the same reauthenticated control route (v71.22).
  assert.equal((await f.request('/api/admin/pump-classic/control', { method: 'POST', session: 'admin-session', body: { launchId: 'ab'.repeat(12), action: 'withdraw-strategy-sol', reason: 'Owner test coin' } })).status, 403, 'no password or code, no money moves');
  const missing = await f.request('/api/admin/pump-classic/control', { method: 'POST', session: 'admin-session', body: control({ launchId: 'ab'.repeat(12), action: 'withdraw-strategy-sol' }) });
  assert.equal(missing.status, 404, missing.text);
  // Pump.fun coins in the shared Token moderation tab: visibility only, admins only (v71.22).
  const coin = { accountId: USER_ID, id: 'ab'.repeat(12), route: 'pump-classic', mint: MINT, hidden: true, reason: 'Administrator hid this coin from public pages.' };
  assert.equal((await f.request('/api/admin/moderation/launch', { method: 'POST', session: 'user-session', body: coin })).status, 403);
  const hide = await f.request('/api/admin/moderation/launch', { method: 'POST', session: 'admin-session', body: coin });
  assert.equal(hide.status, 404, hide.text); assert.match(hide.data.error, /Pump\.fun coin was not found/);
  const archive = await f.request('/api/admin/launches/archive', { method: 'POST', session: 'admin-session', body: { ...control(), accountId: USER_ID, id: 'ab'.repeat(12), route: 'pump-classic', mint: MINT, archived: true } });
  assert.equal(archive.status, 409); assert.match(archive.data.error, /managed in the Pump\.fun tab/);
});
