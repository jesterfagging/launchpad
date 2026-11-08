import test from 'node:test';
import assert from 'node:assert/strict';
import { openAgentDatabase } from '../src/agent/db.mjs';
import { AgentStore, newId } from '../src/agent/store.mjs';
import { AGENT_POLICY_HASH } from '../src/agent/policy.mjs';
import { AGENT_POLICY_V1, AGENT_RATE_CARD_V1, capabilityMask } from '../public/agent-catalog.mjs';
import { XAccounts, X_REVOKED_REASON, X_OTHER_ACCOUNT, X_STATE_EXPIRED, X_CLAIM_REFUSED, X_ACCOUNT_LIMITS, utcDayKey } from '../src/agent/x-accounts.mjs';
import { handleXRoutes, xReturnLocation, X_HTTP_GENERIC } from '../src/agent/x-http.mjs';

// Migration v4 (INFLUENCER-BRIEF §3). Until it lands in src/agent/db.mjs the fixture creates the tables itself,
// so these tests run on their own; once it is there the SQL is skipped (x_accounts already exists).
const V4_SQL = `
CREATE TABLE x_oauth_states (state TEXT PRIMARY KEY, account_id TEXT NOT NULL, code_verifier TEXT NOT NULL, return_to TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX x_oauth_states_expiry ON x_oauth_states(expires_at);
CREATE TABLE x_accounts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, agent_id TEXT REFERENCES agents(id), x_user_id TEXT NOT NULL, handle TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', scopes TEXT NOT NULL DEFAULT '', token_expires_at INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, state_reason TEXT NOT NULL DEFAULT '', posts_day_key TEXT NOT NULL DEFAULT '', posts_today INTEGER NOT NULL DEFAULT 0, last_post_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(agent_id));
CREATE INDEX x_accounts_account ON x_accounts(account_id, created_at);
CREATE INDEX x_accounts_user ON x_accounts(x_user_id);
CREATE TABLE influencers (agent_id TEXT PRIMARY KEY REFERENCES agents(id), version INTEGER NOT NULL DEFAULT 1, spec TEXT NOT NULL DEFAULT '{}', prompt TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, state_reason TEXT NOT NULL DEFAULT '', master_file TEXT NOT NULL DEFAULT '', sheet_file TEXT NOT NULL DEFAULT '', reference_file TEXT NOT NULL DEFAULT '', soul_id TEXT NOT NULL DEFAULT '', consistency INTEGER, generations INTEGER NOT NULL DEFAULT 0, posting_paused INTEGER NOT NULL DEFAULT 0, admin_paused INTEGER NOT NULL DEFAULT 0, admin_pause_reason TEXT NOT NULL DEFAULT '', day_key TEXT NOT NULL DEFAULT '', posts_today INTEGER NOT NULL DEFAULT 0, images_today INTEGER NOT NULL DEFAULT 0, videos_today INTEGER NOT NULL DEFAULT 0, next_post_at INTEGER NOT NULL DEFAULT 0, last_post_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX influencers_state ON influencers(state, updated_at);
CREATE TABLE media_jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), run_id TEXT, post_id TEXT, kind TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', provider_request_id TEXT NOT NULL DEFAULT '', request TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL, file TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '', reserved_usd TEXT NOT NULL DEFAULT '0', cost_usd TEXT NOT NULL DEFAULT '0', score INTEGER, error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, next_check_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER);
CREATE INDEX media_jobs_open ON media_jobs(state, next_check_at);
CREATE INDEX media_jobs_agent ON media_jobs(agent_id, created_at);
CREATE TABLE x_posts (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), run_id TEXT, x_account_id TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, link TEXT NOT NULL DEFAULT '', media_job_id TEXT, state TEXT NOT NULL, x_post_id TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', reserved_usd TEXT NOT NULL DEFAULT '0', cost_usd TEXT NOT NULL DEFAULT '0', error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, posted_at INTEGER);
CREATE INDEX x_posts_agent ON x_posts(agent_id, created_at);
CREATE INDEX x_posts_open ON x_posts(state, next_attempt_at);`;
const ensureInfluencerTables = db => { if (!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'x_accounts'")) db.db.exec(V4_SQL); };

const MINT = 'GoatCoin1111111111111111111111111111111111', WALLET = 'AgentWa11et111111111111111111111111111111', MINT2 = 'GoatCoin2222222222222222222222222222222222';
const MIN = 60000, HOUR = 3600000, DAY = 86400000, CALLBACK = 'https://launchpad.test/api/launchpad/x/callback';
const SCOPE = 'tweet.read tweet.write users.read offline.access media.write';
class FakeStore { constructor() { this.docs = new Map(); this.writes = []; } async read(name, fallback = null) { if (!/^[a-z][a-z0-9-]*$/.test(name)) throw Error('Invalid storage name.'); return this.docs.has(name) ? JSON.parse(this.docs.get(name)) : fallback; } async write(name, value) { if (!/^[a-z][a-z0-9-]*$/.test(name)) throw Error('Invalid storage name.'); this.docs.set(name, JSON.stringify(value)); this.writes.push({ name, value }); } }
/** A scripted X: queues per endpoint (an entry may be { status, body } or a body), default answers otherwise, every call recorded. */
function fakeX() {
  const x = { calls: [], queue: { token: [], me: [], post: [], upload: [], revoke: [] }, counter: 0, user: { id: '12345', username: 'goatposter', name: 'Goat Poster' } };
  const answer = (name, fallback) => { const next = x.queue[name].shift(); const value = next === undefined ? fallback() : typeof next === 'function' ? next() : next; return value && typeof value === 'object' && 'status' in value && 'body' in value ? value : { status: 200, body: value }; };
  x.fetcher = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(String(url)), method = init.method || 'GET', call = { path: pathname, query: searchParams, method, headers: init.headers || {}, body: init.body };
    x.calls.push(call);
    let out;
    if (pathname === '/2/oauth2/token') { call.form = Object.fromEntries(new URLSearchParams(init.body)); out = answer('token', () => { x.counter++; return { token_type: 'bearer', expires_in: 7200, access_token: 'access-' + x.counter, refresh_token: 'refresh-' + x.counter, scope: SCOPE }; }); }
    else if (pathname === '/2/oauth2/revoke') { call.form = Object.fromEntries(new URLSearchParams(init.body)); out = answer('revoke', () => ({ revoked: true })); }
    else if (pathname === '/2/users/me') out = answer('me', () => ({ data: { ...x.user } }));
    else if (pathname === '/2/tweets') { call.json = JSON.parse(init.body); out = answer('post', () => ({ status: 201, body: { data: { id: String(1000 + x.calls.length), text: call.json.text } } })); }
    else if (pathname === '/2/media/upload') out = answer('upload', () => ({ data: { id: '7001', media_key: '3_7001', expires_after_secs: 86400 } }));
    else out = { status: 404, body: { title: 'Not Found' } };
    return new Response(JSON.stringify(out.body), { status: out.status, headers: out.headers || {} });
  };
  x.tokenCalls = () => x.calls.filter(call => call.path === '/2/oauth2/token');
  x.postCalls = () => x.calls.filter(call => call.path === '/2/tweets');
  return x;
}
async function fixture({ dryRun = false, config = {}, xOpen = true } = {}) {
  let clock = Date.UTC(2026, 9, 4, 12, 0, 0); const now = () => clock, tick = ms => { clock += ms; };
  const db = await openAgentDatabase(':memory:', { now }); ensureInfluencerTables(db);
  const store = new AgentStore(db, { now });
  store.savePolicy({ hash: AGENT_POLICY_HASH, version: AGENT_POLICY_V1.version, document: AGENT_POLICY_V1, rateCard: AGENT_RATE_CARD_V1 });
  const agent = store.createAgent({ mint: MINT, route: 'raydium', launchId: 'launch-1', accountId: 'acct-1', wallet: WALLET, name: 'Goat', symbol: 'GOAT', policyHash: AGENT_POLICY_HASH, policyVersion: AGENT_POLICY_V1.version, capabilities: capabilityMask({ buyback: true }), model: 'openai/gpt-6-luna', mission: 'Research goats.' });
  const hostStore = new FakeStore(), x = fakeX();
  const service = { now, config: { enabled: true, dryRun, xClientId: 'client-id', xClientSecret: 'client-secret-0123456789', xCallbackUrl: CALLBACK, xGlobalDailyPosts: 500, publicUrl: 'https://launchpad.test', ...config }, accounts: { hostStore }, store: () => store, available: () => true, ensure: async () => store, effective: () => ({ xOpen }) };
  const xAccounts = new XAccounts({ service, fetcher: x.fetcher, now });
  service.xAccounts = xAccounts;
  const connect = async (accountId = 'acct-1', returnTo = 'launchpad') => { const { url } = await xAccounts.connectUrl({ accountId, returnTo }); const state = new URL(url, 'https://launchpad.test').searchParams.get('state'); return { state, ...(await xAccounts.callback({ code: 'code-' + state.slice(0, 6), state })) }; };
  return { db, store, agent, hostStore, x, service, xAccounts, now, tick, connect };
}
const tokenRecord = (hostStore, id) => JSON.parse(hostStore.docs.get('x-token-' + id));

test('connect, callback, list, claim, post and disconnect', async () => {
  const { db, store, agent, hostStore, x, xAccounts, now, tick } = await fixture();
  const started = await xAccounts.connectUrl({ accountId: 'acct-1', returnTo: 'launchpad' });
  const url = new URL(started.url);
  assert.equal(url.origin + url.pathname, 'https://x.com/i/oauth2/authorize'); assert.equal(url.searchParams.get('client_id'), 'client-id'); assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('scope'), SCOPE);
  const state = url.searchParams.get('state'); assert.match(state, /^[A-Za-z0-9_-]{43}$/); assert.equal(started.expiresAt, now() + 10 * MIN);
  const pending = db.get('SELECT * FROM x_oauth_states WHERE state = ?', state);
  assert.equal(pending.account_id, 'acct-1'); assert.equal(pending.return_to, 'launchpad'); assert.match(pending.code_verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.deepEqual(xAccounts.peekState(state), { accountId: 'acct-1', returnTo: 'launchpad' }); assert.equal(xAccounts.peekState('nope'), null);
  assert.equal(x.calls.length, 0, 'starting a connection makes no request');
  const done = await xAccounts.callback({ code: 'code-1', state });
  assert.match(done.xAccountId, /^[a-f0-9]{24}$/); assert.equal(done.handle, 'goatposter'); assert.equal(done.returnTo, 'launchpad');
  assert.deepEqual(x.calls.map(call => call.path), ['/2/oauth2/token', '/2/users/me']);
  assert.equal(x.calls[0].form.grant_type, 'authorization_code'); assert.equal(x.calls[0].form.code, 'code-1'); assert.equal(x.calls[0].form.code_verifier, pending.code_verifier); assert.equal(x.calls[0].form.redirect_uri, CALLBACK);
  assert.equal(x.calls[1].headers.authorization, 'Bearer access-1');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM x_oauth_states').n, 0, 'the state is single use');
  await assert.rejects(xAccounts.callback({ code: 'code-1', state }), error => error.statusCode === 400 && error.message === X_STATE_EXPIRED);
  // Tokens live in the host store only.
  assert.deepEqual(tokenRecord(hostStore, done.xAccountId), { version: 1, accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: now() + 7200000, scopes: SCOPE.split(' '), updatedAt: now() });
  const stored = db.get('SELECT * FROM x_accounts WHERE id = ?', done.xAccountId);
  assert.equal(stored.account_id, 'acct-1'); assert.equal(stored.x_user_id, '12345'); assert.equal(stored.handle, 'goatposter'); assert.equal(stored.display_name, 'Goat Poster'); assert.equal(stored.state, 'connected'); assert.equal(stored.scopes, SCOPE); assert.equal(stored.token_expires_at, now() + 7200000);
  assert.ok(!JSON.stringify(stored).includes('access-1') && !JSON.stringify(stored).includes('refresh-1'));
  const list = xAccounts.list('acct-1');
  assert.deepEqual(list, [{ id: done.xAccountId, handle: 'goatposter', displayName: 'Goat Poster', state: 'connected', stateReason: '', agentMint: null, free: true, connectedAt: now(), lastPostAt: 0, postsToday: 0 }]);
  assert.deepEqual(xAccounts.list('acct-2'), []); assert.deepEqual(xAccounts.list(''), []);
  // Claim for the agent: the row must belong to the creator, be connected and be free (or already this agent's).
  assert.throws(() => xAccounts.claimForAgent({ xAccountId: done.xAccountId, accountId: 'acct-2', agentId: agent.id }), error => error.statusCode === 400 && error.message === X_CLAIM_REFUSED);
  assert.throws(() => xAccounts.claimForAgent({ xAccountId: newId(), accountId: 'acct-1', agentId: agent.id }), error => error.message === X_CLAIM_REFUSED);
  assert.equal(xAccounts.forAgent(agent.id), null);
  const claimed = xAccounts.claimForAgent({ xAccountId: done.xAccountId, accountId: 'acct-1', agentId: agent.id });
  assert.equal(claimed.agentId, agent.id); assert.equal(xAccounts.forAgent(agent.id).id, done.xAccountId); assert.equal(xAccounts.forAgent(agent.id).accessToken, undefined);
  assert.equal(xAccounts.claimForAgent({ xAccountId: done.xAccountId, accountId: 'acct-1', agentId: agent.id }).agentId, agent.id, 'a draft re-claims its own account');
  const other = store.createAgent({ mint: MINT2, route: 'raydium', launchId: 'launch-2', accountId: 'acct-1', wallet: 'Xther' + WALLET.slice(5), name: 'Two', symbol: 'TWO', policyHash: AGENT_POLICY_HASH, policyVersion: AGENT_POLICY_V1.version, capabilities: 0, model: 'm', mission: 'x' });
  assert.throws(() => xAccounts.claimForAgent({ xAccountId: done.xAccountId, accountId: 'acct-1', agentId: other.id }), error => error.message === X_CLAIM_REFUSED, 'another agent cannot take a claimed account');
  assert.equal(xAccounts.list('acct-1')[0].agentMint, MINT); assert.equal(xAccounts.list('acct-1')[0].free, false);
  // Post: bearer token, the text as given, counters bumped.
  const posted = await xAccounts.postAs(done.xAccountId, { text: 'hello goats' });
  assert.deepEqual(posted, { postId: '1003', url: 'https://x.com/i/web/status/1003' });
  assert.equal(x.postCalls().length, 1); assert.deepEqual(x.postCalls()[0].json, { text: 'hello goats' }); assert.equal(x.postCalls()[0].headers.authorization, 'Bearer access-1');
  let row = db.get('SELECT * FROM x_accounts WHERE id = ?', done.xAccountId);
  assert.equal(row.posts_today, 1); assert.equal(row.posts_day_key, utcDayKey(now())); assert.equal(row.last_post_at, now());
  assert.equal(xAccounts.list('acct-1')[0].postsToday, 1); assert.equal(xAccounts.list('acct-1')[0].lastPostAt, now());
  // Spacing: one post per account per minute, no sleeping.
  tick(20000);
  const limited = await xAccounts.postAs(done.xAccountId, { text: 'again' }).catch(error => error);
  assert.equal(limited.code, 'X_RATE_LIMITED'); assert.equal(limited.statusCode, 429); assert.equal(limited.retryAfterMs, 40000); assert.equal(x.postCalls().length, 1);
  tick(40000);
  const withImage = await xAccounts.postAs(done.xAccountId, { text: 'with a picture', media: { bytes: Buffer.alloc(2048, 3), contentType: 'image/png', kind: 'image' } });
  assert.equal(withImage.url, 'https://x.com/i/web/status/' + withImage.postId);
  const upload = x.calls.find(call => call.path === '/2/media/upload');
  assert.ok(upload.body instanceof FormData); assert.equal(upload.body.get('media_category'), 'tweet_image'); assert.equal(upload.body.get('media').size, 2048); assert.equal(upload.headers.authorization, 'Bearer access-1');
  assert.deepEqual(x.postCalls()[1].json, { text: 'with a picture', media: { media_ids: ['7001'] } });
  assert.equal(db.get('SELECT posts_today FROM x_accounts WHERE id = ?', done.xAccountId).posts_today, 2);
  await assert.rejects(xAccounts.postAs(done.xAccountId, { text: '' }), error => error.code === 'X_INVALID' && error.statusCode === 400);
  await assert.rejects(xAccounts.postAs(done.xAccountId, { text: 'x', media: { bytes: 'nope', kind: 'image' } }), error => error.code === 'X_INVALID');
  await assert.rejects(xAccounts.postAs(newId(), { text: 'x' }), error => error.code === 'X_UNAUTHORIZED' && error.statusCode === 409);
  // Disconnect: owner check, best-effort revoke, token record replaced, row kept for history.
  await assert.rejects(xAccounts.disconnect({ accountId: 'acct-2', xAccountId: done.xAccountId }), error => error.statusCode === 404);
  const after = await xAccounts.disconnect({ accountId: 'acct-1', xAccountId: done.xAccountId });
  assert.deepEqual(after, []);
  const revokes = x.calls.filter(call => call.path === '/2/oauth2/revoke');
  assert.deepEqual(revokes.map(call => call.form.token).sort(), ['access-1', 'refresh-1']);
  assert.deepEqual(tokenRecord(hostStore, done.xAccountId), { version: 1, revoked: true, updatedAt: now() });
  row = db.get('SELECT * FROM x_accounts WHERE id = ?', done.xAccountId);
  assert.equal(row.state, 'disconnected'); assert.equal(row.agent_id, agent.id, 'history keeps the agent');
  assert.equal(xAccounts.forAgent(agent.id), null);
  await assert.rejects(xAccounts.postAs(done.xAccountId, { text: 'after' }), error => error.code === 'X_UNAUTHORIZED');
  assert.deepEqual(await xAccounts.disconnect({ accountId: 'acct-1', xAccountId: done.xAccountId }), [], 'disconnecting twice is idempotent');
  assert.equal(xAccounts.release(agent.id), 1); assert.equal(db.get('SELECT agent_id FROM x_accounts WHERE id = ?', done.xAccountId).agent_id, null); assert.equal(xAccounts.release(agent.id), 0);
  for (const value of hostStore.writes) assert.ok(value.name.startsWith('x-token-'));
  db.close();
});

test('connection states expire after ten minutes and are pruned; availability and account caps are enforced', async () => {
  const { db, x, xAccounts, service, tick, connect, now } = await fixture();
  const { url } = await xAccounts.connectUrl({ accountId: 'acct-1', returnTo: 'coin:' + MINT });
  const state = new URL(url).searchParams.get('state');
  assert.deepEqual(xAccounts.peekState(state), { accountId: 'acct-1', returnTo: 'coin:' + MINT });
  tick(10 * MIN + 1);
  assert.equal(xAccounts.peekState(state), null);
  await assert.rejects(xAccounts.callback({ code: 'late', state }), error => error.statusCode === 400 && error.code === 'X_STATE' && error.message === X_STATE_EXPIRED);
  assert.equal(x.calls.length, 0, 'an expired state is refused before any request');
  await xAccounts.connectUrl({ accountId: 'acct-1' });
  xAccounts.prune(); assert.equal(db.get('SELECT COUNT(*) AS n FROM x_oauth_states').n, 1, 'only the live state survives pruning');
  await assert.rejects(xAccounts.callback({ code: 'x', state: 'unknown-state' }), error => error.message === X_STATE_EXPIRED);
  await assert.rejects(xAccounts.callback({ code: '', state: (await xAccounts.connectUrl({ accountId: 'acct-1' })).url.match(/state=([^&]+)/)[1] }), error => error.statusCode === 400 && /authorization code/.test(error.message));
  await assert.rejects(xAccounts.connectUrl({ accountId: 'acct-1', returnTo: 'https://evil.example' }), error => error.statusCode === 400);
  await assert.rejects(xAccounts.connectUrl({ accountId: '' }), error => error.statusCode === 401);
  // Five connected accounts per Launchpad account.
  for (let index = 0; index < 5; index++) { x.user = { id: String(100 + index), username: 'user' + index, name: 'User ' + index }; await connect('acct-1'); }
  assert.equal(xAccounts.list('acct-1').length, 5);
  await assert.rejects(xAccounts.connectUrl({ accountId: 'acct-1' }), error => error.statusCode === 409 && /up to 5/.test(error.message));
  // The flag off (or credentials missing) closes the flow with 503.
  service.effective = () => ({ xOpen: false });
  await assert.rejects(xAccounts.connectUrl({ accountId: 'acct-2' }), error => error.statusCode === 503 && error.code === 'X_UNAVAILABLE');
  await assert.rejects(xAccounts.callback({ code: 'c', state: 's' }), error => error.statusCode === 503);
  assert.equal(xAccounts.available(), false);
  // X failing during the exchange is reported with a public sentence and no detail.
  service.effective = () => ({ xOpen: true }); x.user = { id: '999', username: 'late', name: 'Late' };
  const started = await xAccounts.connectUrl({ accountId: 'acct-2' }); const pending = new URL(started.url).searchParams.get('state');
  x.queue.token.push({ status: 400, body: { error: 'invalid_grant', error_description: 'Value passed for the authorization code was invalid.' } });
  const refused = await xAccounts.callback({ code: 'bad', state: pending }).catch(error => error);
  assert.equal(refused.statusCode, 400); assert.match(refused.message, /did not accept the authorization/); assert.ok(!refused.message.includes('bad'));
  const again = await xAccounts.connectUrl({ accountId: 'acct-2' }); x.queue.token.push({ status: 503, body: { title: 'Service Unavailable' } });
  const down = await xAccounts.callback({ code: 'c', state: new URL(again.url).searchParams.get('state') }).catch(error => error);
  assert.equal(down.statusCode, 503); assert.match(down.message, /did not answer/);
  assert.equal(now() > 0, true);
  db.close();
});

test('an X user connected by another Launchpad account is refused until it is disconnected there; reconnecting updates the row', async () => {
  const { db, hostStore, x, xAccounts, connect, tick, now } = await fixture();
  const first = await connect('acct-1');
  const refused = await connect('acct-2').catch(error => error);
  assert.equal(refused.statusCode, 409); assert.equal(refused.code, 'X_OTHER_ACCOUNT'); assert.equal(refused.message, X_OTHER_ACCOUNT);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM x_accounts').n, 1); assert.equal(hostStore.docs.size, 1, 'no token record is written for a refused connection');
  // Re-connecting the same X user from the same Launchpad account updates the row and the tokens in place.
  tick(HOUR); x.user = { ...x.user, name: 'Goat Poster II' };
  const again = await connect('acct-1');
  assert.equal(again.xAccountId, first.xAccountId);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM x_accounts').n, 1);
  const row = db.get('SELECT * FROM x_accounts WHERE id = ?', first.xAccountId);
  assert.equal(row.display_name, 'Goat Poster II'); assert.equal(row.updated_at, now()); assert.equal(row.state, 'connected');
  assert.equal(tokenRecord(hostStore, first.xAccountId).accessToken, 'access-3', 'the newest token pair replaces the old one');
  // A revoked row still blocks another Launchpad account; a disconnected one does not.
  xAccounts.markRevoked(first.xAccountId);
  await assert.rejects(connect('acct-2'), error => error.code === 'X_OTHER_ACCOUNT');
  await xAccounts.disconnect({ accountId: 'acct-1', xAccountId: first.xAccountId });
  const moved = await connect('acct-2');
  assert.notEqual(moved.xAccountId, first.xAccountId); assert.equal(xAccounts.list('acct-2')[0].handle, 'goatposter'); assert.deepEqual(xAccounts.list('acct-1'), []);
  // The old owner reconnecting is now the one refused.
  await assert.rejects(connect('acct-1'), error => error.code === 'X_OTHER_ACCOUNT');
  db.close();
});

test('tokens are refreshed before expiry with the rotated pair stored first; a dead grant marks the account revoked', async () => {
  const { db, hostStore, x, xAccounts, agent, connect, tick, now } = await fixture();
  const { xAccountId } = await connect();
  xAccounts.claimForAgent({ xAccountId, accountId: 'acct-1', agentId: agent.id });
  assert.equal(await xAccounts.tokenFor(xAccountId), 'access-1'); assert.equal(x.tokenCalls().length, 1, 'a fresh token is used as is');
  tick(2 * HOUR - 4 * MIN);
  const refreshed = await xAccounts.tokenFor(xAccountId);
  assert.equal(refreshed, 'access-2'); assert.equal(x.tokenCalls().length, 2);
  assert.equal(x.tokenCalls()[1].form.grant_type, 'refresh_token'); assert.equal(x.tokenCalls()[1].form.refresh_token, 'refresh-1');
  assert.deepEqual(tokenRecord(hostStore, xAccountId), { version: 1, accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: now() + 7200000, scopes: SCOPE.split(' '), updatedAt: now() });
  assert.equal(db.get('SELECT token_expires_at FROM x_accounts WHERE id = ?', xAccountId).token_expires_at, now() + 7200000);
  // Concurrent callers share one refresh.
  tick(2 * HOUR - MIN);
  const [a, b] = await Promise.all([xAccounts.tokenFor(xAccountId), xAccounts.tokenFor(xAccountId)]);
  assert.equal(a, 'access-3'); assert.equal(b, 'access-3'); assert.equal(x.tokenCalls().length, 3);
  // A refresh answer without a new refresh token keeps the stored one.
  tick(2 * HOUR); x.queue.token.push({ token_type: 'bearer', expires_in: 7200, access_token: 'access-only', scope: SCOPE });
  assert.equal(await xAccounts.tokenFor(xAccountId), 'access-only'); assert.equal(tokenRecord(hostStore, xAccountId).refreshToken, 'refresh-3');
  // The user revoked the app: the refresh answers invalid_grant.
  tick(2 * HOUR); x.queue.token.push({ status: 400, body: { error: 'invalid_grant', error_description: 'Value passed for the token was invalid.' } });
  const dead = await xAccounts.tokenFor(xAccountId).catch(error => error);
  assert.equal(dead.code, 'X_UNAUTHORIZED'); assert.equal(dead.statusCode, 409); assert.equal(dead.message, X_REVOKED_REASON);
  const row = db.get('SELECT * FROM x_accounts WHERE id = ?', xAccountId);
  assert.equal(row.state, 'revoked'); assert.equal(row.state_reason, X_REVOKED_REASON);
  assert.equal(xAccounts.forAgent(agent.id), null, 'the influencer sees no account to post with');
  assert.equal(xAccounts.list('acct-1')[0].state, 'revoked'); assert.equal(xAccounts.list('acct-1')[0].stateReason, X_REVOKED_REASON);
  await assert.rejects(xAccounts.tokenFor(xAccountId), error => error.code === 'X_UNAUTHORIZED');
  // Reconnecting from the coin page reactivates the same row for the same agent.
  const back = await connect('acct-1', 'coin:' + MINT);
  assert.equal(back.xAccountId, xAccountId); assert.equal(back.returnTo, 'coin:' + MINT); assert.equal(xAccounts.forAgent(agent.id).id, xAccountId); assert.equal(db.get('SELECT state_reason FROM x_accounts WHERE id = ?', xAccountId).state_reason, '');
  // A refresh that fails for another reason (X down) does not revoke anything.
  tick(2 * HOUR); x.queue.token.push({ status: 503, body: { title: 'Service Unavailable' } });
  await assert.rejects(xAccounts.tokenFor(xAccountId), error => error.code === 'X_PROVIDER');
  assert.equal(db.get('SELECT state FROM x_accounts WHERE id = ?', xAccountId).state, 'connected');
  // A missing token record cannot be used: the account is marked revoked.
  hostStore.docs.delete('x-token-' + xAccountId);
  await assert.rejects(xAccounts.tokenFor(xAccountId), error => error.code === 'X_UNAUTHORIZED');
  assert.equal(db.get('SELECT state FROM x_accounts WHERE id = ?', xAccountId).state, 'revoked');
  db.close();
});

test('a 401 on posting gets one refresh and one retry; a second refusal revokes the account', async () => {
  const { db, hostStore, x, xAccounts, connect, tick } = await fixture();
  const { xAccountId } = await connect();
  // First post: X refuses the token once, the refreshed token works.
  x.queue.post.push({ status: 401, body: { title: 'Unauthorized', detail: 'Unauthorized', status: 401 } });
  const posted = await xAccounts.postAs(xAccountId, { text: 'first' });
  assert.equal(posted.url, 'https://x.com/i/web/status/' + posted.postId);
  assert.equal(x.postCalls().length, 2); assert.equal(x.postCalls()[0].headers.authorization, 'Bearer access-1'); assert.equal(x.postCalls()[1].headers.authorization, 'Bearer access-2');
  assert.equal(x.tokenCalls().at(-1).form.grant_type, 'refresh_token');
  assert.equal(tokenRecord(hostStore, xAccountId).accessToken, 'access-2', 'the rotated pair was stored');
  assert.equal(hostStore.writes.length, 2); assert.equal(db.get('SELECT posts_today FROM x_accounts WHERE id = ?', xAccountId).posts_today, 1);
  // Second post a minute later: 401, refresh, 401 again -> revoked.
  tick(MIN);
  x.queue.post.push({ status: 401, body: { title: 'Unauthorized' } }, { status: 401, body: { title: 'Unauthorized' } });
  const revoked = await xAccounts.postAs(xAccountId, { text: 'second' }).catch(error => error);
  assert.equal(revoked.code, 'X_UNAUTHORIZED'); assert.equal(revoked.message, X_REVOKED_REASON); assert.equal(revoked.statusCode, 409);
  assert.equal(x.postCalls().length, 4); assert.equal(x.postCalls()[3].headers.authorization, 'Bearer access-3');
  const row = db.get('SELECT * FROM x_accounts WHERE id = ?', xAccountId);
  assert.equal(row.state, 'revoked'); assert.equal(row.state_reason, X_REVOKED_REASON); assert.equal(row.posts_today, 1, 'a failed post is not counted');
  await assert.rejects(xAccounts.postAs(xAccountId, { text: 'third' }), error => error.code === 'X_UNAUTHORIZED');
  assert.equal(x.postCalls().length, 4, 'a revoked account makes no request');
  // Reconnect, then: 401, refresh fails with invalid_grant -> revoked without a retry.
  const back = await connect(); tick(MIN);
  x.queue.post.push({ status: 401, body: { title: 'Unauthorized' } }); x.queue.token.push({ status: 400, body: { error: 'invalid_grant' } });
  await assert.rejects(xAccounts.postAs(back.xAccountId, { text: 'fourth' }), error => error.code === 'X_UNAUTHORIZED' && error.message === X_REVOKED_REASON);
  assert.equal(db.get('SELECT state FROM x_accounts WHERE id = ?', back.xAccountId).state, 'revoked');
  // Reconnect, then: 401, refresh OK, 403 -> revoked. A 403 on the first attempt (duplicate) is reported as is.
  const third = await connect(); tick(MIN);
  x.queue.post.push({ status: 403, body: { title: 'Forbidden', detail: 'You are not allowed to create a Tweet with duplicate content.' } });
  await assert.rejects(xAccounts.postAs(third.xAccountId, { text: 'dup' }), error => error.code === 'X_DUPLICATE');
  assert.equal(db.get('SELECT state FROM x_accounts WHERE id = ?', third.xAccountId).state, 'connected');
  x.queue.post.push({ status: 401, body: { title: 'Unauthorized' } }, { status: 403, body: { title: 'Forbidden', detail: 'Your client app is not configured with the appropriate oauth1 app permissions for this endpoint.' } });
  await assert.rejects(xAccounts.postAs(third.xAccountId, { text: 'perm' }), error => error.code === 'X_UNAUTHORIZED');
  assert.equal(db.get('SELECT state FROM x_accounts WHERE id = ?', third.xAccountId).state, 'revoked');
  // Other failures pass through with their codes and leave the account connected.
  const fourth = await connect(); tick(MIN);
  x.queue.post.push({ status: 429, body: { title: 'Too Many Requests' }, headers: { 'x-rate-limit-reset': String(Math.floor(xAccounts.now() / 1000) + 120) } });
  const limited = await xAccounts.postAs(fourth.xAccountId, { text: 'busy' }).catch(error => error);
  assert.equal(limited.code, 'X_RATE_LIMITED'); assert.equal(limited.retryAfterMs, 120000);
  x.queue.post.push({ status: 500, body: { title: 'Internal Server Error' } });
  await assert.rejects(xAccounts.postAs(fourth.xAccountId, { text: 'down' }), error => error.code === 'X_PROVIDER');
  assert.equal(db.get('SELECT state FROM x_accounts WHERE id = ?', fourth.xAccountId).state, 'connected');
  db.close();
});

test('per-account day counters reset on a new UTC day and the platform ceiling counts posts made today', async () => {
  const { db, agent, x, xAccounts, connect, tick, now, service } = await fixture({ config: { xGlobalDailyPosts: 2 } });
  const { xAccountId } = await connect();
  await xAccounts.postAs(xAccountId, { text: 'one' }); tick(MIN); await xAccounts.postAs(xAccountId, { text: 'two' });
  assert.equal(db.get('SELECT posts_today FROM x_accounts WHERE id = ?', xAccountId).posts_today, 2); assert.equal(xAccounts.list('acct-1')[0].postsToday, 2);
  // The next UTC day: the view already reads 0, the first post restarts the counter at 1.
  const untilMidnight = Date.UTC(2026, 9, 5) - now(); tick(untilMidnight + 1);
  assert.equal(xAccounts.list('acct-1')[0].postsToday, 0, 'yesterday’s count does not carry over');
  assert.equal(db.get('SELECT posts_today FROM x_accounts WHERE id = ?', xAccountId).posts_today, 2, 'the row is rewritten lazily');
  await xAccounts.postAs(xAccountId, { text: 'three' });
  const row = db.get('SELECT * FROM x_accounts WHERE id = ?', xAccountId);
  assert.equal(row.posts_today, 1); assert.equal(row.posts_day_key, '2026-10-05'); assert.equal(xAccounts.list('acct-1')[0].postsToday, 1);
  // Platform ceiling: x_posts rows posted today across all agents (a row from yesterday and a failed one do not count).
  tick(5 * MIN);
  const insert = (id, postedAt, state = 'posted') => db.run("INSERT INTO x_posts(id, agent_id, x_account_id, kind, text, state, created_at, updated_at, posted_at) VALUES (?, ?, ?, 'text', 't', ?, ?, ?, ?)", id, agent.id, xAccountId, state, postedAt, postedAt, state === 'posted' ? postedAt : null);
  insert(newId(), now() - DAY, 'posted'); insert(newId(), now() - MIN, 'posted'); insert(newId(), now() - MIN, 'failed');
  assert.equal(xAccounts.postedToday(), 1);
  tick(MIN); await xAccounts.postAs(xAccountId, { text: 'four' }); insert(newId(), now(), 'posted');
  assert.equal(xAccounts.postedToday(), 2);
  tick(MIN);
  const capped = await xAccounts.postAs(xAccountId, { text: 'five' }).catch(error => error);
  assert.equal(capped.code, 'X_RATE_LIMITED'); assert.equal(capped.statusCode, 429); assert.match(capped.message, /platform-wide/);
  assert.equal(capped.retryAfterMs, Date.UTC(2026, 9, 6) - now(), 'retry at the next UTC midnight'); assert.equal(x.postCalls().length, 4);
  // Yesterday’s rows stop counting after midnight; an undefined ceiling falls back to 500.
  tick(Date.UTC(2026, 9, 6) - now() + 1); assert.equal(xAccounts.postedToday(), 0);
  service.config = { ...service.config, xGlobalDailyPosts: undefined }; await xAccounts.postAs(xAccountId, { text: 'six' });
  service.config = { ...service.config, xGlobalDailyPosts: 0 };
  await assert.rejects(xAccounts.postAs(xAccountId, { text: 'seven' }), error => error.code === 'X_RATE_LIMITED');
  db.close();
});

test('dry run connects a fake account and posts without any request', async () => {
  const { db, hostStore, x, xAccounts, agent, now } = await fixture({ dryRun: true, config: { xClientId: '', xClientSecret: '' } });
  const started = await xAccounts.connectUrl({ accountId: 'acct-1', returnTo: 'launchpad' });
  const url = new URL(started.url); assert.equal(url.origin + url.pathname, CALLBACK); assert.equal(url.searchParams.get('code'), 'dryrun');
  const done = await xAccounts.callback({ code: 'dryrun', state: url.searchParams.get('state') });
  assert.match(done.handle, /^dryrun_[a-f0-9]{6}$/); assert.equal(xAccounts.list('acct-1')[0].handle, done.handle);
  assert.equal(JSON.parse(hostStore.docs.get('x-token-' + done.xAccountId)).version, 1);
  xAccounts.claimForAgent({ xAccountId: done.xAccountId, accountId: 'acct-1', agentId: agent.id });
  const posted = await xAccounts.postAs(done.xAccountId, { text: 'dry', media: { bytes: Buffer.alloc(10), contentType: 'image/png', kind: 'image' } });
  assert.match(posted.postId, /^dry-[a-f0-9]{12}$/); assert.equal(posted.url, ''); assert.equal(posted.dryRun, true);
  assert.equal(db.get('SELECT posts_today FROM x_accounts WHERE id = ?', done.xAccountId).posts_today, 1, 'caps are exercised in dry run too');
  await assert.rejects(xAccounts.postAs(done.xAccountId, { text: 'dry again' }), error => error.code === 'X_RATE_LIMITED');
  assert.equal(await xAccounts.tokenFor(done.xAccountId), 'dry-run-access');
  assert.deepEqual(await xAccounts.disconnect({ accountId: 'acct-1', xAccountId: done.xAccountId }), []);
  assert.equal(x.calls.length, 0, 'dry run never touches the network');
  assert.equal(now() > 0, true);
  db.close();
});

// ---- HTTP routes with a fake ctx -----------------------------------------------------------------------------
function fakeCtx({ method = 'GET', path, query = '', session = null, csrfValid = true, body = null, agents, headers = {} } = {}) {
  const sent = [], redirects = [], bodies = [], headersSet = {}, req = { method, headers: { cookie: session ? 'launchpad-session=tok' : '', 'x-control-token': csrfValid ? 'csrf' : '', ...headers } };
  const res = { writeHead: (code, head) => { redirects.push(head?.location ? { code, location: head.location } : { code, headers: head }); }, end: body => { if (body !== undefined) bodies.push(String(body)); }, setHeader: (name, value) => { headersSet[name] = value; }, headersSent: false };
  const limits = { calls: [], check(key, limit) { this.calls.push([key, limit]); if (key.startsWith('x-') && this.block) throw Object.assign(Error('Too many attempts. Try again shortly.'), { statusCode: 429, retryAfterMs: 15000, rateWindow: true }); } };
  const ctx = { req, res, path, url: new URL('https://launchpad.test' + path + query), ip: '10.0.0.1', send: (code, value) => sent.push({ code, value }), limits, accounts: {}, cookieToken: request => String(request.headers.cookie || '').startsWith('launchpad-session=') ? 'tok' : '', csrfSession: async (token, csrf) => ({ session: token === 'tok' ? session : null, csrfValid: !!session && csrf === 'csrf' }), bodyJson: async () => { if (body === null) throw Object.assign(Error('Expected JSON.'), { statusCode: 415 }); return body; }, agents, origin: 'https://launchpad.test', configured: null };
  return { ctx, sent, redirects, bodies, headersSet, limits };
}
const SESSION = { account: { id: 'acct-1', username: 'mira' }, csrfToken: 'csrf' };

test('routes: session and CSRF rules, redirects with the outcome in the hash, nothing echoed', async () => {
  const { db, x, xAccounts, service, hostStore } = await fixture();
  const agents = service;
  assert.equal(await handleXRoutes(fakeCtx({ path: '/api/launchpad/agents/catalog', agents }).ctx), false, 'other paths are left to the server');
  const unknown = fakeCtx({ path: '/api/launchpad/x/nope', agents });
  assert.equal(await handleXRoutes(unknown.ctx), true); assert.deepEqual(unknown.sent, [{ code: 404, value: { error: 'Not found.' } }]);
  const wrongMethod = fakeCtx({ method: 'POST', path: '/api/launchpad/x/connect', session: SESSION, agents });
  await handleXRoutes(wrongMethod.ctx); assert.equal(wrongMethod.sent[0].code, 405);
  const anonymous = fakeCtx({ path: '/api/launchpad/x/connect', query: '?returnTo=launchpad', agents });
  await handleXRoutes(anonymous.ctx); assert.equal(anonymous.sent[0].code, 401); assert.deepEqual(anonymous.limits.calls, [['x-connect:ip:10.0.0.1', 10]]);
  const noCsrf = fakeCtx({ path: '/api/launchpad/x/connect', query: '?returnTo=launchpad', session: SESSION, csrfValid: false, agents });
  await handleXRoutes(noCsrf.ctx); assert.equal(noCsrf.sent[0].code, 403); assert.deepEqual(noCsrf.limits.calls, [['x-connect:account:acct-1', 10]]);
  const connect = fakeCtx({ path: '/api/launchpad/x/connect', query: '?returnTo=coin:' + MINT, session: SESSION, agents });
  assert.equal(await handleXRoutes(connect.ctx), true);
  assert.equal(connect.sent[0].code, 200); assert.match(connect.sent[0].value.url, /^https:\/\/x\.com\/i\/oauth2\/authorize\?/); assert.equal(typeof connect.sent[0].value.expiresAt, 'number');
  const state = new URL(connect.sent[0].value.url).searchParams.get('state');
  const badReturn = fakeCtx({ path: '/api/launchpad/x/connect', query: '?returnTo=javascript:alert(1)', session: SESSION, agents });
  await handleXRoutes(badReturn.ctx); assert.equal(badReturn.sent[0].code, 400); assert.match(badReturn.sent[0].value.error, /where to return/);
  // The empty account list before the callback; the list is readable without the CSRF header (fetch polling).
  const empty = fakeCtx({ path: '/api/launchpad/x/accounts', session: SESSION, csrfValid: false, agents });
  await handleXRoutes(empty.ctx); assert.equal(empty.sent[0].code, 200); assert.deepEqual(empty.sent[0].value.accounts, []); assert.equal(empty.sent[0].value.available, true); assert.deepEqual(empty.limits.calls, [['x-accounts:account:acct-1', 60]]);
  const anonymousList = fakeCtx({ path: '/api/launchpad/x/accounts', agents }); await handleXRoutes(anonymousList.ctx); assert.equal(anonymousList.sent[0].code, 401);
  // Callback, first hop: the cross-site navigation from X carries no SameSite=Strict cookie; a static page re-requests the URL same-origin.
  const hop = fakeCtx({ path: '/api/launchpad/x/callback', query: `?code=secret-code&state=${encodeURIComponent(state)}`, csrfValid: false, agents });
  assert.equal(await handleXRoutes(hop.ctx), true);
  assert.equal(hop.sent.length, 0); assert.equal(hop.redirects[0].code, 200); assert.equal(hop.redirects[0].headers['content-type'], 'text/html; charset=utf-8'); assert.equal(hop.redirects[0].headers['cache-control'], 'no-store');
  assert.equal(hop.bodies.length, 1); assert.match(hop.bodies[0], /<meta http-equiv="refresh" content="0;url=\/api\/launchpad\/x\/callback\?code=secret-code&amp;state=[^"]+&amp;hop=1">/);
  assert.ok(!/<script|style=/.test(hop.bodies[0]), 'the hop page needs no script and no inline style under the CSP');
  assert.equal(xAccounts.peekState(state)?.accountId, 'acct-1', 'the hop consumes nothing'); assert.equal(x.calls.length, 0, 'and exchanges nothing');
  const noSession = fakeCtx({ path: '/api/launchpad/x/callback', query: `?code=secret-code&state=${encodeURIComponent(state)}&hop=1`, csrfValid: false, agents });
  await handleXRoutes(noSession.ctx); assert.equal(noSession.bodies.length, 0); assert.equal(noSession.redirects[0].code, 302); assert.match(noSession.redirects[0].location, /#agent&x-error=Sign%20in%20to%20the%20Launchpad%20account/);
  const unknownHop = fakeCtx({ path: '/api/launchpad/x/callback', query: '?code=c&state=unknown', csrfValid: false, agents });
  await handleXRoutes(unknownHop.ctx); assert.equal(unknownHop.redirects[0].location, '/launchpad#x-error=' + encodeURIComponent(X_STATE_EXPIRED), 'an unknown state is not worth a hop');
  // Second hop: the cookie session must be the account that started the connection.
  const stranger = fakeCtx({ path: '/api/launchpad/x/callback', query: `?code=secret-code&state=${encodeURIComponent(state)}`, session: { account: { id: 'acct-2' } }, csrfValid: false, agents });
  await handleXRoutes(stranger.ctx);
  assert.equal(stranger.sent.length, 0); assert.equal(stranger.redirects[0].code, 302); assert.match(stranger.redirects[0].location, /^\/coin\?mint=GoatCoin1111111111111111111111111111111111#agent&x-error=Sign%20in%20to%20the%20Launchpad%20account/);
  assert.ok(!stranger.redirects[0].location.includes('secret-code')); assert.equal(xAccounts.peekState(state)?.accountId, 'acct-1', 'a stranger does not consume the state');
  const callback = fakeCtx({ path: '/api/launchpad/x/callback', query: `?code=secret-code&state=${encodeURIComponent(state)}`, session: SESSION, csrfValid: false, agents });
  assert.equal(await handleXRoutes(callback.ctx), true);
  const [connected] = xAccounts.list('acct-1');
  assert.deepEqual(callback.redirects, [{ code: 302, location: `/coin?mint=${MINT}#agent&x-connected=${connected.id}` }]); assert.equal(callback.sent.length, 0);
  assert.deepEqual(callback.limits.calls, [['x-callback:10.0.0.1', 20]]);
  assert.equal(x.calls.find(call => call.path === '/2/oauth2/token').form.code, 'secret-code');
  const list = fakeCtx({ path: '/api/launchpad/x/accounts', session: SESSION, agents });
  await handleXRoutes(list.ctx); assert.equal(list.sent[0].value.accounts.length, 1); assert.equal(list.sent[0].value.accounts[0].handle, 'goatposter');
  assert.ok(!JSON.stringify(list.sent[0].value).includes('access-'), 'the account list carries no token');
  // Denied on X, expired or unknown states, and failures all redirect with #x-error.
  const second = fakeCtx({ path: '/api/launchpad/x/connect', query: '?returnTo=launchpad', session: SESSION, agents }); await handleXRoutes(second.ctx);
  const state2 = new URL(second.sent[0].value.url).searchParams.get('state');
  const denied = fakeCtx({ path: '/api/launchpad/x/callback', query: `?error=access_denied&state=${encodeURIComponent(state2)}`, session: SESSION, csrfValid: false, agents });
  await handleXRoutes(denied.ctx); assert.equal(denied.redirects[0].location, '/launchpad#x-error=' + encodeURIComponent('You declined the connection on X.'));
  assert.equal(xAccounts.peekState(state2), null, 'a denied state is consumed');
  const expired = fakeCtx({ path: '/api/launchpad/x/callback', query: `?code=c&state=unknown`, session: SESSION, csrfValid: false, agents });
  await handleXRoutes(expired.ctx); assert.equal(expired.redirects[0].location, '/launchpad#x-error=' + encodeURIComponent(X_STATE_EXPIRED));
  const third = fakeCtx({ path: '/api/launchpad/x/connect', query: '?returnTo=launchpad', session: SESSION, agents }); await handleXRoutes(third.ctx);
  const state3 = new URL(third.sent[0].value.url).searchParams.get('state');
  x.queue.token.push({ status: 500, body: { title: 'Internal Server Error', detail: 'stack trace with code=' + 'leaky-code' } });
  const failed = fakeCtx({ path: '/api/launchpad/x/callback', query: `?code=leaky-code&state=${encodeURIComponent(state3)}`, session: SESSION, csrfValid: false, agents });
  await handleXRoutes(failed.ctx);
  assert.equal(failed.redirects[0].location, '/launchpad#x-error=' + encodeURIComponent('X did not answer. Try connecting again in a moment.'));
  assert.ok(!failed.redirects[0].location.includes('leaky'));
  // Disconnect: POST with CSRF; the token record is dropped.
  const noBody = fakeCtx({ method: 'POST', path: '/api/launchpad/x/disconnect', session: SESSION, agents });
  await handleXRoutes(noBody.ctx); assert.equal(noBody.sent[0].code, 415);
  const forged = fakeCtx({ method: 'POST', path: '/api/launchpad/x/disconnect', session: SESSION, csrfValid: false, body: { xAccountId: connected.id }, agents });
  await handleXRoutes(forged.ctx); assert.equal(forged.sent[0].code, 403); assert.equal(xAccounts.list('acct-1').length, 1);
  const missing = fakeCtx({ method: 'POST', path: '/api/launchpad/x/disconnect', session: SESSION, body: { xAccountId: newId() }, agents });
  await handleXRoutes(missing.ctx); assert.equal(missing.sent[0].code, 404); assert.equal(missing.sent[0].value.error, 'X account not found.');
  const disconnect = fakeCtx({ method: 'POST', path: '/api/launchpad/x/disconnect', session: SESSION, body: { xAccountId: connected.id }, agents });
  await handleXRoutes(disconnect.ctx); assert.deepEqual(disconnect.sent, [{ code: 200, value: { accounts: [] } }]);
  assert.equal(JSON.parse(hostStore.docs.get('x-token-' + connected.id)).revoked, true);
  // Our own rate window answers 429 with the wait; unexpected failures become one generic sentence.
  const busy = fakeCtx({ path: '/api/launchpad/x/accounts', session: SESSION, agents }); busy.limits.block = true;
  await handleXRoutes(busy.ctx); assert.equal(busy.sent[0].code, 429); assert.equal(busy.sent[0].value.retryAfterMs, 15000); assert.equal(busy.headersSet['retry-after'], '15');
  const broken = fakeCtx({ path: '/api/launchpad/x/accounts', session: SESSION, agents: { ...service, xAccounts: { available: () => true, list: () => { throw Error('SQLITE_BUSY: database is locked'); } } } });
  await handleXRoutes(broken.ctx); assert.deepEqual(broken.sent, [{ code: 500, value: { error: X_HTTP_GENERIC } }]);
  const off = fakeCtx({ path: '/api/launchpad/x/accounts', session: SESSION, agents: { ...service, available: () => false } });
  await handleXRoutes(off.ctx); assert.equal(off.sent[0].code, 200); assert.deepEqual(off.sent[0].value.accounts, []); assert.equal(off.sent[0].value.available, false);
  const noLayer = fakeCtx({ path: '/api/launchpad/x/accounts', session: SESSION, agents: {} });
  await handleXRoutes(noLayer.ctx); assert.equal(noLayer.sent[0].code, 503);
  db.close();
});

test('return locations put the outcome in the hash of the launch page or the coin page', () => {
  assert.equal(xReturnLocation('launchpad', { connected: 'abc' }), '/launchpad#x-connected=abc');
  assert.equal(xReturnLocation('coin:' + MINT, { connected: 'abc' }), `/coin?mint=${MINT}#agent&x-connected=abc`);
  assert.equal(xReturnLocation('coin:' + MINT, { error: 'Nope & no' }), `/coin?mint=${MINT}#agent&x-error=Nope%20%26%20no`);
  assert.equal(xReturnLocation('coin:not-a-mint', { connected: 'abc' }), '/launchpad#x-connected=abc', 'an invalid target falls back to the launch page');
  assert.equal(xReturnLocation('', {}), '/launchpad#x-error=' + encodeURIComponent(X_HTTP_GENERIC));
  assert.ok(xReturnLocation('launchpad', { error: 'x'.repeat(500) }).length < 200);
  assert.equal(X_ACCOUNT_LIMITS.postSpacingMs, 60000);
});
