// HTTP-level checks for AI Agent mode routes: a disabled host answers 503 and
// never spawns anything, public read models need no session, creator and
// funding writes need a CSRF-bound session, administration needs the
// two-factor platform owner, and flag changes are reauthenticated.
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
  const dir = mkdtempSync(join(tmpdir(), 'launchpad-agents-'));
  const previous = { LAUNCHPAD_AGENTS_ENABLED: process.env.LAUNCHPAD_AGENTS_ENABLED, LAUNCHPAD_AGENTS_DB_PATH: process.env.LAUNCHPAD_AGENTS_DB_PATH, LAUNCHPAD_AGENTS_DRY_RUN: process.env.LAUNCHPAD_AGENTS_DRY_RUN };
  if (enabled) { process.env.LAUNCHPAD_AGENTS_ENABLED = '1'; process.env.LAUNCHPAD_AGENTS_DB_PATH = join(dir, 'agents.sqlite'); process.env.LAUNCHPAD_AGENTS_DRY_RUN = '1'; }
  else { delete process.env.LAUNCHPAD_AGENTS_ENABLED; delete process.env.LAUNCHPAD_AGENTS_DB_PATH; delete process.env.LAUNCHPAD_AGENTS_DRY_RUN; }
  const admin = { id: ADMIN_ID, username: 'owner', role: 'admin', mfaEnabled: true, authType: 'password', banned: false, mainWallet: '' };
  const user = { id: USER_ID, username: 'mira', role: 'user', mfaEnabled: false, authType: 'wallet', banned: false, mainWallet: '' };
  // A second verified administrator who is not the platform owner (the registry lists one admin).
  const otherAdmin = { id: 'c'.repeat(32), username: 'second_admin', role: 'admin', mfaEnabled: true, authType: 'password', banned: false, mainWallet: '' };
  const sessions = { 'admin-session': { account: admin, mfaVerified: true, authType: 'password' }, 'other-admin-session': { account: otherAdmin, mfaVerified: true, authType: 'password' }, 'user-session': { account: user, mfaVerified: false, authType: 'wallet', walletVerified: true, walletAddress: 'Xther1111111111111111111111111111111111111' } };
  let reauth = 0;
  const accounts = { dir, master: Buffer.alloc(32), hostStore: { read: async () => null, write: async () => {} }, list: async () => [admin, user], get: async id => id === ADMIN_ID ? admin : id === USER_ID ? user : null, registry: async () => ({ accounts: [] }),
    getSession: async token => sessions[token] || null, getSessionWithCsrf: async (token, csrf) => ({ session: sessions[token] || null, csrfValid: csrf === token + '-csrf' }),
    reauthenticate: async (id, password, code) => { reauth++; if (password !== 'test-password' || code !== '123456') throw Object.assign(Error('Authentication failed.'), { statusCode: 403 }); }, audit: async () => {} };
  let server;
  try { server = createAccountApp({ accounts, runtimes: {}, policy: {}, publicUrl: 'https://launch.example', launchpad: {}, marketData: {}, funding: {}, protocolFees: {}, protocolTreasury: {}, branding: {}, adminPanel: {}, adminRevenue: {}, explore: {}, trading: {}, adminVolume: {}, lifetimeVolume: {}, adminBurnHistory: {}, publicAnalytics: { invalidate() {}, read: async () => ({}) } }); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); const closing = server.closeServices(); assert.ok(closing.pending instanceof Set, 'v71.37: closeServices names the services still closing'); await closing; assert.equal(closing.pending.size, 0, 'every service settled'); rmSync(dir, { recursive: true, force: true }); });
  const request = (path, { method = 'GET', session = null, csrf = true, body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: { host: 'launch.example', 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.9', origin: 'https://launch.example', ...(session ? { cookie: 'launchpad-session=' + session, 'x-control-token': csrf ? session + '-csrf' : 'wrong' } : {}), 'content-type': 'application/json', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, text, headers: res.headers, data: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null }); }); res.on('error', reject);
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { request, dir, port: () => server.address().port, get reauth() { return reauth; } };
}
const control = (extra = {}) => ({ password: 'test-password', code: '123456', reason: 'Staged rollout step.', ...extra });

test('agent routes are part of launchpad mode and a disabled host answers 503 without side effects', async t => {
  for (const path of ['/api/launchpad/agents', '/api/launchpad/agents/catalog', '/api/launchpad/agents/me', '/api/launchpad/agents/fund/prepare', '/api/admin/agents', '/api/admin/agents/control']) assert.equal(launchpadApi(path), true, path);
  const f = await fixture(t);
  assert.equal((await f.request('/api/launchpad/agents')).status, 503);
  assert.equal((await f.request('/api/launchpad/agents/catalog')).data.error, 'AI Agent mode is not enabled on this host.');
  assert.equal((await f.request('/api/launchpad/agents/agent?mint=x')).status, 503);
  assert.equal((await f.request('/api/launchpad/agents/me', { session: 'user-session' })).status, 503);
  assert.equal((await f.request('/api/launchpad/agents/revise', { method: 'POST', session: 'user-session', body: { mint: 'x' } })).status, 503);
  const admin = await f.request('/api/admin/agents', { session: 'admin-session' });
  assert.equal(admin.status, 200); assert.equal(admin.data.disabled, true); assert.equal(admin.data.effective.master, false);
  assert.equal((await f.request('/api/admin/agents/control', { method: 'POST', session: 'admin-session', body: control({ flags: { intake: true } }) })).status, 503);
  const page = await f.request('/agents'); assert.equal(page.status, 200); assert.match(page.headers['content-type'], /text\/html/);
});

test('public read models need no session; creator and funding writes need a CSRF-bound session', async t => {
  const f = await fixture(t, { enabled: true });
  const list = await f.request('/api/launchpad/agents'); assert.equal(list.status, 200); assert.deepEqual(list.data.agents, []); assert.equal(list.data.intakeOpen, false);
  const catalog = await f.request('/api/launchpad/agents/catalog'); assert.equal(catalog.status, 200); assert.equal(catalog.data.mode, 'agent_v1'); assert.equal(catalog.data.intakeOpen, false); assert.equal(catalog.data.dryRun, true); assert.ok(catalog.data.policy.hash.length === 64);
  assert.equal((await f.request('/api/launchpad/agents/policy')).data.limits.activation, '$2.00');
  assert.equal((await f.request('/api/launchpad/agents/agent?mint=not-a-mint')).status, 404);
  assert.equal((await f.request('/api/launchpad/agents/agent?mint=' + 'X'.repeat(43))).status, 404);
  assert.equal((await f.request('/api/launchpad/agents/screenshot?id=1')).status, 404);
  assert.ok([401, 405].includes((await f.request('/api/launchpad/agents', { method: 'POST', body: {} })).status));
  assert.equal((await f.request('/api/launchpad/agents/me')).status, 401);
  assert.equal((await f.request('/api/launchpad/agents/revise', { method: 'POST', body: { mint: 'x' } })).status, 401);
  assert.equal((await f.request('/api/launchpad/agents/revise', { method: 'POST', session: 'user-session', csrf: false, body: { mint: 'x' } })).status, 403);
  assert.equal((await f.request('/api/launchpad/agents/fund/prepare', { method: 'POST', session: 'user-session', csrf: false, body: {} })).status, 403);
  const me = await f.request('/api/launchpad/agents/me', { session: 'user-session' }); assert.equal(me.status, 200); assert.deepEqual(me.data.agents, []);
  assert.equal((await f.request('/api/launchpad/agents/revise', { method: 'POST', session: 'user-session', body: { mint: 'X'.repeat(43), mission: 'x' } })).status, 404);
  assert.equal((await f.request('/api/launchpad/agents/fund/prepare', { method: 'POST', session: 'user-session', body: { mint: 'X'.repeat(43), purpose: 'activity', amountSol: '0.1' } })).status, 404);
  assert.equal((await f.request('/api/launchpad/agents/fund/prepare', { method: 'POST', session: 'user-session', body: { mint: 'X'.repeat(43), purpose: 'refund', amountSol: '0.1' } })).status, 404);
});

test('administration needs the two-factor owner, flag changes are reauthenticated and audited, and no key material is returned', async t => {
  const f = await fixture(t, { enabled: true });
  assert.equal((await f.request('/api/admin/agents')).status, 401);
  assert.equal((await f.request('/api/admin/agents', { session: 'user-session' })).status, 403);
  const before = await f.request('/api/admin/agents', { session: 'admin-session' });
  assert.equal(before.status, 200); assert.equal(before.data.version, 1); assert.equal(before.data.flags.intake, false); assert.equal(before.data.effective.master, true); assert.equal(before.data.effective.dryRun, true);
  assert.ok(!JSON.stringify(before.data).includes('secret')); assert.deepEqual(Object.keys(before.data.config).sort(), ['backupDir', 'browserConcurrency', 'dbPath', 'defaultModel', 'domainAllowlist', 'globalDailyUsd', 'modelConcurrency', 'models', 'operatorWallet', 'rateCard']);
  assert.ok([401, 403].includes((await f.request('/api/admin/agents', { session: 'admin-session', csrf: false })).status));
  assert.equal((await f.request('/api/admin/agents/control', { method: 'POST', session: 'admin-session', body: { flags: { intake: true }, reason: 'no credentials' } })).status, 403);
  assert.equal((await f.request('/api/admin/agents/control', { method: 'POST', session: 'admin-session', body: control({ flags: { intake: true }, reason: 'x' }) })).status, 400);
  assert.equal((await f.request('/api/admin/agents/control', { method: 'POST', session: 'user-session', body: control({ flags: { intake: true } }) })).status, 403);
  const changed = await f.request('/api/admin/agents/control', { method: 'POST', session: 'admin-session', body: control({ flags: { intake: true, runs: true } }) });
  assert.equal(changed.status, 200, changed.text); assert.equal(changed.data.flags.intake, true); assert.equal(changed.data.flags.runs, true); assert.equal(changed.data.flags.financial, false);
  assert.ok(f.reauth >= 1);
  const after = await f.request('/api/admin/agents', { session: 'admin-session' });
  assert.equal(after.data.flags.intake, true); assert.equal(after.data.audit[0].action, 'control'); assert.equal(after.data.audit[0].reason, 'Staged rollout step.');
  assert.equal((await f.request('/api/launchpad/agents/catalog')).data.intakeOpen, true);
  assert.equal((await f.request('/api/admin/agents/unknown', { method: 'POST', session: 'admin-session', body: control() })).status, 404);
  assert.equal((await f.request('/api/admin/agents/control', { method: 'POST', session: 'admin-session', body: control({ flags: { financial: 'yes' } }) })).status, 400);
  const health = await f.request('/api/admin/agents/health', { session: 'admin-session' });
  assert.equal(health.status, 200); assert.equal(health.data.dryRun, true);
});

test('owner-only reads and actions refuse another verified administrator with code OWNER_ONLY', async t => {
  const f = await fixture(t, { enabled: true });
  for (const path of ['/api/admin/agents', '/api/admin/agents/health', '/api/admin/vanity', '/api/admin/pump-classic', '/api/admin/gotchi']) {
    const refused = await f.request(path, { session: 'other-admin-session' });
    assert.equal(refused.status, 403, path); assert.equal(refused.data.code, 'OWNER_ONLY', path); assert.match(refused.data.error, /owner/, path);
  }
  const write = await f.request('/api/admin/agents/control', { method: 'POST', session: 'other-admin-session', body: control({ flags: { intake: true } }) });
  assert.equal(write.status, 403); assert.equal(write.data.code, 'OWNER_ONLY');
  // Lost or missing administrator access is not an owner-only refusal.
  const user = await f.request('/api/admin/agents', { session: 'user-session' }); assert.equal(user.status, 403); assert.equal(user.data.code, undefined);
  assert.equal((await f.request('/api/admin/agents', { session: 'admin-session' })).status, 200);
});

test('releasing orphan browsers is a reauthenticated POST; GET only reads provider health', async t => {
  const f = await fixture(t, { enabled: true }), path = '/api/admin/agents/health?releaseOrphans=1';
  const get = await f.request(path, { session: 'admin-session' });
  assert.equal(get.status, 405); assert.equal(get.headers.allow, 'POST');
  assert.equal((await f.request('/api/admin/agents/health', { session: 'admin-session' })).status, 200);
  assert.equal((await f.request(path, { method: 'POST', session: 'admin-session', body: {} })).status, 403, 'password and authenticator code are required');
  assert.equal((await f.request(path, { method: 'POST', session: 'admin-session', csrf: false, body: control() })).status, 403);
  assert.equal((await f.request(path, { method: 'POST', session: 'other-admin-session', body: control() })).data.code, 'OWNER_ONLY');
  const reauthBefore = f.reauth, released = await f.request(path, { method: 'POST', session: 'admin-session', body: control() });
  assert.equal(released.status, 200, released.text); assert.equal(released.data.dryRun, true); assert.equal(f.reauth, reauthBefore + 1);
  const audit = (await f.request('/api/admin/agents', { session: 'admin-session' })).data.audit;
  assert.equal(audit[0].action, 'provider-health');
});

test('the administrator action allowance counts confirmed actions and its refusal says when to retry', async t => {
  const f = await fixture(t, { enabled: true }), path = '/api/admin/agents/control';
  // Failed identity checks do not use the ten-action allowance (the account's reauthentication limit bounds them).
  for (let i = 0; i < 12; i++) assert.equal((await f.request(path, { method: 'POST', session: 'admin-session', body: control({ code: '000000', flags: { intake: true } }) })).status, 403);
  for (let i = 0; i < 10; i++) assert.equal((await f.request(path, { method: 'POST', session: 'admin-session', body: control({ flags: { intake: i % 2 === 0 } }) })).status, 200, 'action ' + i);
  const reauthBefore = f.reauth, refused = await f.request(path, { method: 'POST', session: 'admin-session', body: control({ flags: { intake: true } }) });
  assert.equal(refused.status, 429); assert.equal(f.reauth, reauthBefore, 'a used-up allowance is refused before the authenticator code is checked');
  assert.ok(Number.isSafeInteger(refused.data.retryAfterMs) && refused.data.retryAfterMs > 14 * 60000 && refused.data.retryAfterMs <= 15 * 60000, String(refused.data.retryAfterMs));
  assert.equal(refused.headers['retry-after'], String(Math.ceil(refused.data.retryAfterMs / 1000)));
});

test('one viewer holds a bounded number of live agent streams, so it cannot occupy the shared capacity', async t => {
  const f = await fixture(t, { enabled: true });
  const { AgentService, agentConfig } = await import('../src/agent/service.mjs');
  const { AGENT_POLICY_HASH } = await import('../src/agent/policy.mjs');
  const seed = new AgentService({ accounts: { dir: f.dir, hostStore: { read: async () => null, write: async () => {} } }, config: { ...agentConfig({ LAUNCHPAD_AGENTS_ENABLED: '1', LAUNCHPAD_AGENTS_DRY_RUN: '1' }), dbPath: join(f.dir, 'agents.sqlite') } });
  const mint = 'Mint1111111111111111111111111111111111111';
  (await seed.ensure()).createAgent({ mint, route: 'pump', accountId: USER_ID, wallet: 'Wa11et11111111111111111111111111111111111', name: 'A', symbol: 'A', policyHash: AGENT_POLICY_HASH, policyVersion: '1', capabilities: 1, model: 'm', state: 'ready', mission: 'Do things.' });
  await seed.close?.();
  const open = ip => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: f.port(), path: '/api/launchpad/agents/stream?mint=' + mint, headers: { host: 'launch.example', 'x-forwarded-proto': 'https', 'x-forwarded-for': ip } }, res => { res.on('data', () => {}); resolve({ status: res.statusCode, headers: res.headers, close: () => req.destroy() }); });
    req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); }); req.end();
  });
  const streams = [];
  for (let i = 0; i < 6; i++) { const stream = await open('198.51.100.20'); assert.equal(stream.status, 200); streams.push(stream); }
  const refused = await open('198.51.100.20'); assert.equal(refused.status, 429); assert.equal(refused.headers['retry-after'], '15'); refused.close();
  const other = await open('198.51.100.21'); assert.equal(other.status, 200, 'another viewer is unaffected'); other.close();
  streams.shift().close(); await new Promise(resolve => setTimeout(resolve, 100));
  const again = await open('198.51.100.20'); assert.equal(again.status, 200, 'a closed stream frees its slot'); again.close();
  for (const stream of streams) stream.close();
});
