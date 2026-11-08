import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createAccountApp, RateLimits } from '../src/account-app.mjs';

async function fixture(t, { recoveryFails = false } = {}) {
  const sessions = new Map(), calls = { combined: 0, legacy: 0, recovery: 0 };
  const accounts = {
    master: Buffer.alloc(32),
    async getSessionWithCsrf(token, csrf) {
      calls.combined++;
      const session = sessions.get(token) || null;
      return { session: session ? structuredClone(session) : null, csrfValid: !!session && csrf === session.csrfToken };
    },
    async getSession(token) { calls.legacy++; return structuredClone(sessions.get(token) || null); },
    async verifyCsrf() { throw new Error('HTTP should use the combined verification hook.'); },
    async registry() { return { version: 1, accounts: [], sessions: [], links: [] }; },
  };
  const trading = { discoveryIncomplete: false, async start() { calls.recovery++; if (recoveryFails) throw new Error('fixture secret failure'); }, async close() {} };
  const publicLaunchStatus = { async publicStatus(session, context) {
    if (session) await context.authorize();
    return { available: true, previewAccount: session?.account.id || null };
  } };
  const server = createAccountApp({
    accounts, runtimes: {}, policy: { async get() { return { cashbackBps: 0 }; } },
    launchpad: {}, marketData: {}, funding: {}, protocolFees: {}, branding: {}, adminPanel: {}, adminRevenue: {},
    explore: { async list() { return { coins: [], total: 0 }; } },
    trading, pumpPublic: publicLaunchStatus, meteora: publicLaunchStatus,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.closeServices(); });
  async function request(path, { auth, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path,
        headers: { ...(auth ? { cookie: 'launchpad-session=' + auth.token, 'x-control-token': auth.csrfToken } : {}), ...headers } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString(); let body;
          try { body = JSON.parse(text); } catch {}
          resolve({ status: response.statusCode, headers: response.headers, text, body });
        });
      });
      req.on('error', reject); req.end();
    });
  }
  function auth({ id = randomBytes(16).toString('hex'), role = 'user', mfaEnabled = false, mfaVerified = false, walletVerified = false } = {}) {
    const token = randomBytes(32).toString('base64url'), csrfToken = randomBytes(32).toString('base64url');
    const session = { account: { id, role, authType: 'password', mfaEnabled }, csrfToken, mfaVerified, walletVerified, expiresAt: Date.now() + 60000 };
    sessions.set(token, session); return { token, csrfToken, session };
  }
  return { request, auth, sessions, calls, trading, publicLaunchStatus };
}

test('admin health requires a current admin session, verified MFA and matching CSRF', async t => {
  const h = await fixture(t), path = '/api/admin/health';
  assert.equal((await h.request(path)).status, 401);
  const ordinary = h.auth(); assert.equal((await h.request(path, { auth: ordinary })).status, 403);
  const unprotectedAdmin = h.auth({ role: 'admin' }); assert.equal((await h.request(path, { auth: unprotectedAdmin })).status, 403);
  const unverifiedAdmin = h.auth({ role: 'admin', mfaEnabled: true }); assert.equal((await h.request(path, { auth: unverifiedAdmin })).status, 403);
  const admin = h.auth({ role: 'admin', mfaEnabled: true, mfaVerified: true });
  assert.equal((await h.request(path, { auth: admin, headers: { 'x-control-token': 'wrong' } })).status, 403);
  const before = h.calls.combined, response = await h.request(path, { auth: admin });
  assert.equal(response.status, 200); assert.equal(h.calls.combined - before, 1); assert.equal(h.calls.legacy, 0);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.maxUsers, 1000); assert.ok(response.body.capacity.rpcRequestsPerSecond > 0);
  assert.equal(response.body.services.tradeRecovery, 'running');
  h.trading.discoveryIncomplete = true;
  assert.equal((await h.request(path, { auth: admin })).body.services.tradeRecovery, 'degraded');
  h.trading.discoveryIncomplete = false;
  assert.equal((await h.request(path, { auth: admin })).body.services.tradeRecovery, 'running');
  assert.ok(!response.text.includes(admin.token)); assert.ok(!response.text.includes(admin.csrfToken));
  const linkedAdmin = h.auth({ role: 'admin', mfaEnabled: true, walletVerified: true });
  assert.equal((await h.request(path, { auth: linkedAdmin })).status, 200);
  admin.session.account.role = 'user'; assert.equal((await h.request(path, { auth: admin })).status, 403);
  h.sessions.delete(admin.token); assert.equal((await h.request(path, { auth: admin })).status, 401);
});

test('static ETags allow empty 304 responses while authenticated API responses remain no-store', async t => {
  const h = await fixture(t), page = await h.request('/');
  assert.equal(page.status, 200); assert.match(page.headers.etag, /^"[a-f0-9]{64}"$/);
  assert.match(page.headers['cache-control'], /must-revalidate/); assert.ok(page.text.length > 100);
  const cached = await h.request('/', { headers: { 'if-none-match': page.headers.etag } });
  assert.equal(cached.status, 304); assert.equal(cached.text, ''); assert.equal(cached.headers.etag, page.headers.etag);
  const auth = h.auth(), api = await h.request('/api/session', { auth, headers: { 'if-none-match': page.headers.etag } });
  assert.equal(api.status, 200); assert.equal(api.body.authenticated, true);
  assert.equal(api.headers['cache-control'], 'no-store'); assert.equal(api.headers.etag, undefined);
});

test('forged cookie rotation shares the anonymous IP allowance and verified accounts retain independent NAT allowances', async t => {
  const h = await fixture(t), first = h.auth(), second = h.auth();
  for (let i = 0; i < 120; i++) {
    const cookie = 'launchpad-session=' + randomBytes(32).toString('base64url');
    assert.equal((await h.request('/api/session', { headers: { cookie } })).status, 200);
  }
  const denied = await h.request('/api/session', { headers: { cookie: 'launchpad-session=' + randomBytes(32).toString('base64url') } });
  assert.equal(denied.status, 429); assert.ok(Number(denied.headers['retry-after']) >= 1);
  assert.equal((await h.request('/api/session', { auth: first })).status, 200);
  assert.equal((await h.request('/api/session', { auth: second })).status, 200);
  for (let i = 1; i < 120; i++) assert.equal((await h.request('/api/session', { auth: first })).status, 200);
  // Issuing a second session cannot multiply one account's session-read budget.
  const firstAgain = h.auth({ id: first.session.account.id });
  assert.equal((await h.request('/api/session', { auth: firstAgain })).status, 429);
  assert.equal((await h.request('/api/session', { auth: second })).status, 200);
});

test('Explore assigns rate-limit identities only after verifying viewer cookies', async t => {
  const h = await fixture(t), a = h.auth(), b = h.auth();
  for (let i = 0; i < 120; i++) assert.equal((await h.request('/api/explore', { headers: { cookie: 'launchpad-session=' + randomBytes(32).toString('base64url') } })).status, 200);
  assert.equal((await h.request('/api/explore')).status, 429);
  assert.equal((await h.request('/api/explore', { auth: a })).status, 200);
  assert.equal((await h.request('/api/explore', { auth: b })).status, 200);
});

const publicLaunchStatusPaths = ['/api/launchpad/pump/status', '/api/launchpad/pump/pairs', '/api/launchpad/meteora/status', '/api/launchpad/meteora/pairs'];

test('public launch status and pair reads share an account budget while users behind one IP remain independent', async t => {
  const h = await fixture(t), a = h.auth(), b = h.auth();
  for (let i = 0; i < 60; i++) {
    const response = await h.request(publicLaunchStatusPaths[i % publicLaunchStatusPaths.length], { auth: a });
    assert.equal(response.status, 200); assert.equal(response.body.previewAccount, a.session.account.id);
  }
  for (const path of publicLaunchStatusPaths) {
    const denied = await h.request(path, { auth: a });
    assert.equal(denied.status, 429); assert.ok(Number(denied.headers['retry-after']) >= 1);
    const independent = await h.request(path, { auth: b });
    assert.equal(independent.status, 200); assert.equal(independent.body.previewAccount, b.session.account.id);
    assert.equal((await h.request(path)).status, 200);
  }
  const newSession = h.auth({ id: a.session.account.id });
  assert.equal((await h.request(publicLaunchStatusPaths[0], { auth: newSession })).status, 429);
});

test('anonymous launch status reads, forged cookies and incorrect CSRF share one bounded IP allowance', async t => {
  const h = await fixture(t), valid = h.auth();
  for (let i = 0; i < 60; i++) {
    const args = i % 3 === 0 ? {} : i % 3 === 1
      ? { headers: { cookie: 'launchpad-session=' + randomBytes(32).toString('base64url'), 'x-control-token': randomBytes(32).toString('base64url') } }
      : { auth: h.auth(), headers: { 'x-control-token': 'wrong' } };
    const response = await h.request(publicLaunchStatusPaths[i % publicLaunchStatusPaths.length], args);
    assert.equal(response.status, 200); assert.equal(response.body.previewAccount, null);
  }
  for (const path of publicLaunchStatusPaths) {
    assert.equal((await h.request(path)).status, 429);
    assert.equal((await h.request(path, { headers: { cookie: 'launchpad-session=' + randomBytes(32).toString('base64url') } })).status, 429);
    assert.equal((await h.request(path, { auth: valid, headers: { 'x-control-token': 'wrong' } })).status, 429);
    assert.equal((await h.request(path, { auth: valid })).status, 200);
  }
  h.sessions.delete(valid.token);
  assert.equal((await h.request(publicLaunchStatusPaths[0], { auth: valid })).status, 429);
});

test('admin health attributes launch 429 and 503 responses without retaining query strings or credentials', async t => {
  const h = await fixture(t), admin = h.auth({ role: 'admin', mfaEnabled: true, mfaVerified: true });
  h.publicLaunchStatus.publicStatus = async () => { throw Object.assign(new Error('fixture-provider-secret'), { statusCode: 503 }); };
  assert.equal((await h.request('/api/launchpad/meteora/status')).status, 503);
  h.publicLaunchStatus.publicStatus = async () => ({ available: true });
  for (let i = 1; i < 60; i++) assert.equal((await h.request('/api/launchpad/meteora/pairs')).status, 200);
  assert.equal((await h.request('/api/launchpad/meteora/status')).status, 429);
  assert.equal((await h.request('/api/session?secret=fixture-query-secret')).status, 200);
  const response = await h.request('/api/admin/health', { auth: admin });
  assert.equal(response.status, 200);
  const row = response.body.routes.meteoraStatus;
  assert.equal(row.completed, 61); assert.equal(row.failed, 2); assert.equal(row.rateLimited, 1); assert.equal(row.unavailable, 1); assert.equal(row.sampleSize, 61);
  assert.ok(Number.isFinite(row.p95Ms)); assert.equal(response.body.routes.session.completed, 1);
  assert.doesNotMatch(response.text, /fixture-provider-secret|fixture-query-secret|\/api\//);
  assert.ok(!response.text.includes(admin.token)); assert.ok(!response.text.includes(admin.csrfToken));
});

test('trade recovery startup failures are visible to administrators without exposing exception details', async t => {
  const h = await fixture(t, { recoveryFails: true }), auth = h.auth({ role: 'admin', mfaEnabled: true, mfaVerified: true });
  const response = await h.request('/api/admin/health', { auth });
  assert.equal(response.status, 200); assert.equal(response.body.services.tradeRecovery, 'unavailable');
  assert.equal(h.calls.recovery, 1); assert.ok(!response.text.includes('fixture secret'));
});

test('a full rate-limit table forgets idle windows instead of refusing every new caller', () => {
  let now = 1_000_000;
  const limits = new RateLimits({ maxBuckets: 100, now: () => now });
  // A caller over its limit keeps being refused while the table churns.
  for (let i = 0; i < 2; i++) limits.check('login:abuser', 2, 15 * 60000);
  assert.throws(() => limits.check('login:abuser', 2, 15 * 60000), error => error.statusCode === 429);
  // Thousands of distinct one-off keys (many visitors, or a flood) never lock out a brand-new visitor.
  for (let i = 0; i < 5000; i++) limits.check('explore:ip:' + i, 120);
  assert.ok(limits.buckets.size <= 100);
  assert.doesNotThrow(() => limits.check('session-read:ip:fresh-visitor', 120));
  const refused = (() => { try { limits.check('login:abuser', 2, 15 * 60000); } catch (error) { return error; } })();
  assert.equal(refused?.statusCode, 429, 'the refusing window survived the churn');
  assert.equal(refused.retryAfterMs, 15 * 60000); assert.equal(refused.rateWindow, true);
  // peek refuses a used-up window without counting; a fresh window is untouched.
  assert.throws(() => limits.peek('login:abuser', 2), error => error.statusCode === 429 && error.retryAfterMs > 0);
  limits.peek('admin:someone', 10); assert.equal(limits.buckets.has('admin:someone'), false);
  now += 15 * 60000; assert.doesNotThrow(() => limits.check('login:abuser', 2, 15 * 60000));
});
