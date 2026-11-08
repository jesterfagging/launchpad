// AI influencer (v71.30): the X accounts creators connect. Persistence and policy around XClient
// (src/agent/x.mjs): the x_oauth_states and x_accounts tables (agents DB migration v4, through
// store.db), the token records in the encrypted host store ('x-token-<id>' = { version: 1,
// accessToken, refreshToken, expiresAt, scopes, updatedAt }; a disconnected account keeps
// { version: 1, revoked: true }, which reads as absent), the cross-account rule (one X user per Launchpad
// account), the per-account 60 s spacing, the per-account UTC day counter and the platform-wide daily
// ceiling (config.xGlobalDailyPosts, counted from x_posts rows posted today). Trust boundary: callers
// pass account ids the HTTP layer authenticated or agent ids the influencer pipeline owns; nothing here
// reads model output, and no method returns, stores in SQLite, logs or throws a token. Dry run
// (service.config.dryRun) touches no network: callback creates a fake @dryrun_<6hex> account and
// postAs answers { postId: 'dry-…', url: '', dryRun: true }.
import { randomBytes } from 'node:crypto';
import { XClient, X_SCOPES, pkce, xError } from './x.mjs';
import { row, newId } from './store.mjs';

const fail = (message, statusCode = 400, code = 'X_ACCOUNT') => { throw Object.assign(Error(message), { statusCode, code }); };
export const X_REVOKED_REASON = 'X revoked the connection. Reconnect the account from the coin page.';
export const X_OTHER_ACCOUNT = 'This X account is connected to another Launchpad account. Disconnect it there first.';
export const X_STATE_EXPIRED = 'This X connection link expired. Start again from the launch page.';
export const X_CLAIM_REFUSED = 'Connect the X account the agent will post to.';
export const X_ACCOUNT_LIMITS = Object.freeze({ accounts: 5, stateTtlMs: 600000, openStates: 20, postSpacingMs: 60000, refreshAheadMs: 300000, textChars: 1000, revokeWaitMs: 5000, defaultDailyPosts: 500 });
const TOKEN_PREFIX = 'x-token-', RETURN_TO = /^coin:[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const validAccountId = value => typeof value === 'string' && value.length > 0 && value.length <= 80;
/** UTC day key 'YYYY-MM-DD' of a timestamp and the start of that day in ms. */
export const utcDayKey = ms => new Date(ms).toISOString().slice(0, 10);
export const utcDayStart = ms => Date.parse(utcDayKey(ms) + 'T00:00:00.000Z');
const normalizeReturnTo = value => { const text = value === undefined || value === null || value === '' ? 'launchpad' : String(value); if (text === 'launchpad' || RETURN_TO.test(text)) return text; return fail('Choose where to return after connecting X.', 400); };
const ACCOUNT_SELECT = 'SELECT x.*, a.mint AS agent_mint FROM x_accounts x LEFT JOIN agents a ON a.id = x.agent_id';

export class XAccounts {
  constructor({ service, fetcher = globalThis.fetch?.bind(globalThis), now = null } = {}) { this.service = service; this.fetcher = fetcher; this.now = now || (() => service.now()); this.xClient = null; this.refreshing = new Map(); }
  get config() { return this.service.config || {}; }
  db() { return this.service.store().db; }
  vault() { return this.service.accounts.hostStore; }
  dry() { return this.config.dryRun === true; }
  /** Whether X posting can work on this host (flag on and credentials present, or dry run). */
  available() { return !!this.service?.effective?.().xOpen; }
  /** The HTTP client, built lazily from the configuration (503 without credentials). */
  client() {
    const { xClientId, xClientSecret, xCallbackUrl } = this.config;
    if (!xClientId || !xClientSecret || !xCallbackUrl) fail('X account connection is not available on this host.', 503, 'X_UNAVAILABLE');
    if (!this.xClient || this.xClient.clientId !== xClientId || this.xClient.clientSecret !== xClientSecret || this.xClient.redirectUri !== xCallbackUrl) this.xClient = new XClient({ clientId: xClientId, clientSecret: xClientSecret, redirectUri: xCallbackUrl, fetcher: this.fetcher, now: this.now });
    return this.xClient;
  }
  revokedError() { return xError(X_REVOKED_REASON, 'X_UNAUTHORIZED', { statusCode: 409 }); }
  // ---- connection flow ----------------------------------------------------------------------
  /** Starts a connection: stores the PKCE state (10 minutes, single use) and returns the authorize URL. */
  async connectUrl({ accountId, returnTo = 'launchpad' } = {}) {
    if (!this.available()) fail('X account connection is not available right now.', 503, 'X_UNAVAILABLE');
    if (!validAccountId(accountId)) fail('Sign in before connecting an X account.', 401);
    const target = normalizeReturnTo(returnTo), db = this.db(), now = this.now();
    this.prune();
    if (this.connectedCount(accountId) >= X_ACCOUNT_LIMITS.accounts) fail(`You can connect up to ${X_ACCOUNT_LIMITS.accounts} X accounts. Disconnect one first.`, 409, 'X_ACCOUNT_LIMIT');
    if (Number(db.get('SELECT COUNT(*) AS n FROM x_oauth_states WHERE account_id = ?', accountId)?.n || 0) >= X_ACCOUNT_LIMITS.openStates) fail('Too many X connection attempts are open. Try again in a few minutes.', 429, 'X_STATE_LIMIT');
    const { verifier, challenge } = pkce(), state = randomBytes(32).toString('base64url'), expiresAt = now + X_ACCOUNT_LIMITS.stateTtlMs;
    // Dry run: the popup lands straight on our own callback, which creates the fake account without X.
    const url = this.dry() ? `${this.config.xCallbackUrl || (this.config.publicUrl ? String(this.config.publicUrl).replace(/\/+$/, '') + '/api/launchpad/x/callback' : '/api/launchpad/x/callback')}?code=dryrun&state=${encodeURIComponent(state)}` : this.client().authorizeUrl({ state, challenge, scopes: X_SCOPES });
    db.run('INSERT INTO x_oauth_states(state, account_id, code_verifier, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', state, accountId, verifier, target, now, expiresAt);
    return { url, expiresAt };
  }
  /** The pending connection a state belongs to, not consumed: { accountId, returnTo } or null when unknown or expired. */
  peekState(state) {
    if (typeof state !== 'string' || !state || state.length > 200) return null;
    const pending = this.db().get('SELECT account_id, return_to, expires_at FROM x_oauth_states WHERE state = ?', state);
    return pending && pending.expires_at > this.now() ? { accountId: pending.account_id, returnTo: pending.return_to } : null;
  }
  /** Deletes a state row (single use) and returns { accountId, verifier, returnTo }, or null when unknown or expired. */
  consumeState(state) {
    if (typeof state !== 'string' || !state || state.length > 200) return null;
    const db = this.db();
    return db.transaction(() => {
      const pending = db.get('SELECT * FROM x_oauth_states WHERE state = ?', state); if (!pending) return null;
      db.run('DELETE FROM x_oauth_states WHERE state = ?', state);
      return pending.expires_at > this.now() ? { accountId: pending.account_id, verifier: pending.code_verifier, returnTo: pending.return_to } : null;
    });
  }
  /** Finishes a connection: consumes the state, exchanges the code, looks the user up and upserts the account. */
  async callback({ code, state } = {}) {
    if (!this.available()) fail('X account connection is not available right now.', 503, 'X_UNAVAILABLE');
    const pending = this.consumeState(state); if (!pending) fail(X_STATE_EXPIRED, 400, 'X_STATE');
    if (typeof code !== 'string' || !code || code.length > 2048) fail('X did not return an authorization code. Start again from the launch page.', 400, 'X_STATE');
    const { accountId, verifier, returnTo } = pending; let tokens, user;
    if (this.dry()) { user = { id: 'dry' + randomBytes(8).toString('hex'), username: 'dryrun_' + randomBytes(3).toString('hex'), name: 'Dry run account' }; tokens = { accessToken: 'dry-run-access', refreshToken: 'dry-run-refresh', expiresAt: this.now() + 7200000, scopes: [...X_SCOPES] }; }
    else {
      const client = this.client();
      try { tokens = await client.exchangeCode({ code, verifier }); user = await client.me(tokens.accessToken); }
      catch (error) {
        const transient = error.code === 'X_NETWORK' || error.code === 'X_PROVIDER' || error.code === 'X_RATE_LIMITED';
        fail(transient ? 'X did not answer. Try connecting again in a moment.' : 'X did not accept the authorization. Start again from the launch page.', transient ? 503 : 400, error.code || 'X_PROVIDER');
      }
    }
    const handle = String(user.username).slice(0, 50), displayName = String(user.name || '').slice(0, 100), xUserId = String(user.id), scopes = (tokens.scopes?.length ? tokens.scopes : X_SCOPES).join(' ');
    const db = this.db(), now = this.now();
    const id = db.transaction(() => {
      if (db.get("SELECT id FROM x_accounts WHERE x_user_id = ? AND account_id != ? AND state != 'disconnected' LIMIT 1", xUserId, accountId)) fail(X_OTHER_ACCOUNT, 409, 'X_OTHER_ACCOUNT');
      const existing = db.get('SELECT id FROM x_accounts WHERE account_id = ? AND x_user_id = ? ORDER BY created_at DESC LIMIT 1', accountId, xUserId);
      if (existing) { db.run("UPDATE x_accounts SET handle = ?, display_name = ?, scopes = ?, token_expires_at = ?, state = 'connected', state_reason = '', updated_at = ? WHERE id = ?", handle, displayName, scopes, tokens.expiresAt, now, existing.id); return existing.id; }
      const created = newId();
      db.run("INSERT INTO x_accounts(id, account_id, agent_id, x_user_id, handle, display_name, scopes, token_expires_at, state, state_reason, posts_day_key, posts_today, last_post_at, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'connected', '', '', 0, 0, ?, ?)", created, accountId, xUserId, handle, displayName, scopes, tokens.expiresAt, now, now);
      return created;
    });
    try { await this.vault().write(TOKEN_PREFIX + id, { version: 1, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || '', expiresAt: tokens.expiresAt, scopes: scopes.split(' '), updatedAt: now }); }
    catch (error) { db.run("UPDATE x_accounts SET state = 'revoked', state_reason = 'The connection could not be stored. Reconnect the account.', updated_at = ? WHERE id = ?", this.now(), id); throw error; }
    return { xAccountId: id, handle, returnTo };
  }
  /** Owner-checked disconnect: revokes best effort, drops the token record, keeps the row (and its agent_id) for history. */
  async disconnect({ accountId, xAccountId } = {}) {
    const account = this.rowById(xAccountId); if (!account || account.accountId !== accountId) fail('X account not found.', 404);
    if (account.state !== 'disconnected') {
      const record = await this.readToken(account.id);
      if (record && !this.dry()) {
        try { const client = this.client(), revokes = Promise.allSettled([client.revoke(record.refreshToken), client.revoke(record.accessToken)]); await Promise.race([revokes, new Promise(resolve => { const timer = setTimeout(resolve, X_ACCOUNT_LIMITS.revokeWaitMs); timer.unref?.(); })]); }
        catch { /* Best effort: the record is dropped either way. */ }
      }
      await this.vault().write(TOKEN_PREFIX + account.id, { version: 1, revoked: true, updatedAt: this.now() });
      this.db().run("UPDATE x_accounts SET state = 'disconnected', state_reason = 'Disconnected by the creator.', updated_at = ? WHERE id = ?", this.now(), account.id);
    }
    return this.list(accountId);
  }
  // ---- views and agent binding ---------------------------------------------------------------
  rowById(id) { if (!validId(id)) return null; return row(this.db().get(ACCOUNT_SELECT + ' WHERE x.id = ?', id)); }
  /** The account's connected and revoked X accounts (disconnected ones are history), newest first. Never tokens. */
  list(accountId) { if (!validAccountId(accountId)) return []; return this.db().all(ACCOUNT_SELECT + " WHERE x.account_id = ? AND x.state != 'disconnected' ORDER BY x.created_at DESC, x.id DESC", accountId).map(item => this.accountView(row(item))); }
  accountView(item) {
    if (!item) return null;
    return { id: item.id, handle: item.handle, displayName: item.displayName || '', state: item.state, stateReason: item.stateReason || '', agentMint: item.agentMint || null, free: !item.agentId, connectedAt: item.createdAt, lastPostAt: item.lastPostAt || 0, postsToday: item.postsDayKey === utcDayKey(this.now()) ? item.postsToday || 0 : 0 };
  }
  /** The connected row bound to an agent, or null (revoked and disconnected rows read as absent). */
  forAgent(agentId) { if (!validId(agentId)) return null; return row(this.db().get("SELECT * FROM x_accounts WHERE agent_id = ? AND state = 'connected'", agentId)); }
  /** Binds a connected account of the creator to an agent (a draft may re-claim its own account; another agent's account is refused). */
  claimForAgent({ xAccountId, accountId, agentId } = {}) {
    if (!validId(agentId)) fail('Invalid agent id.', 400);
    const db = this.db();
    return db.transaction(() => {
      const account = this.rowById(xAccountId);
      if (!account || account.accountId !== accountId || account.state !== 'connected' || (account.agentId && account.agentId !== agentId)) fail(X_CLAIM_REFUSED, 400, 'X_CLAIM');
      const now = this.now();
      db.run('UPDATE x_accounts SET agent_id = NULL, updated_at = ? WHERE agent_id = ? AND id != ?', now, agentId, account.id);
      db.run('UPDATE x_accounts SET agent_id = ?, updated_at = ? WHERE id = ?', agentId, now, account.id);
      return this.rowById(account.id);
    });
  }
  /** Frees whatever account an agent held (archived drafts, failed launches, detach). Returns the number of rows changed. */
  release(agentId) { if (!validId(agentId)) return 0; return Number(this.db().run('UPDATE x_accounts SET agent_id = NULL, updated_at = ? WHERE agent_id = ?', this.now(), agentId).changes || 0); }
  // ---- tokens ------------------------------------------------------------------------------------
  async readToken(id) { const record = await this.vault().read(TOKEN_PREFIX + id, null); return record && record.version === 1 && record.revoked !== true && typeof record.accessToken === 'string' && record.accessToken ? record : null; }
  markRevoked(xAccountId, reason = X_REVOKED_REASON) { if (!validId(xAccountId)) return; this.db().run("UPDATE x_accounts SET state = 'revoked', state_reason = ?, updated_at = ? WHERE id = ? AND state = 'connected'", String(reason).slice(0, 300), this.now(), xAccountId); }
  /** A usable access token for a connected account; refreshes (and stores the rotated pair) when it expires within 5 minutes. */
  async tokenFor(xAccountId) {
    const account = this.rowById(xAccountId); if (!account || account.state !== 'connected') throw this.revokedError();
    if (this.dry()) return 'dry-run-access';
    const record = await this.readToken(account.id); if (!record) { this.markRevoked(account.id); throw this.revokedError(); }
    if (record.expiresAt - this.now() >= X_ACCOUNT_LIMITS.refreshAheadMs) return record.accessToken;
    return this.refreshNow(account.id, record);
  }
  /** Rotates the pair (one refresh in flight per account). The new pair is stored before the token is returned; a dead grant marks the account revoked. */
  refreshNow(xAccountId, record = null) {
    const inflight = this.refreshing.get(xAccountId); if (inflight) return inflight;
    const run = async () => {
      const current = record || await this.readToken(xAccountId); if (!current?.refreshToken) { this.markRevoked(xAccountId); throw this.revokedError(); }
      let next; try { next = await this.client().refresh(current.refreshToken); } catch (error) { if (error.code === 'X_UNAUTHORIZED') { this.markRevoked(xAccountId); throw this.revokedError(); } throw error; }
      const now = this.now(), stored = { version: 1, accessToken: next.accessToken, refreshToken: next.refreshToken || current.refreshToken, expiresAt: next.expiresAt, scopes: next.scopes?.length ? next.scopes : current.scopes || [], updatedAt: now };
      await this.vault().write(TOKEN_PREFIX + xAccountId, stored);
      this.db().run('UPDATE x_accounts SET token_expires_at = ?, updated_at = ? WHERE id = ?', next.expiresAt, now, xAccountId);
      return stored.accessToken;
    };
    let job; job = run().finally(() => { if (this.refreshing.get(xAccountId) === job) this.refreshing.delete(xAccountId); });
    this.refreshing.set(xAccountId, job);
    return job;
  }
  // ---- posting -----------------------------------------------------------------------------------
  /** Posts as a connected account: spacing and ceiling checks, media upload, one refresh-and-retry on 401 -> { postId, url }. */
  async postAs(xAccountId, { text, media = null } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > X_ACCOUNT_LIMITS.textChars) fail(`A post needs text of at most ${X_ACCOUNT_LIMITS.textChars} characters.`, 400, 'X_INVALID');
    if (media !== null && (!media || typeof media !== 'object' || !['image', 'video'].includes(media.kind) || !(media.bytes instanceof Uint8Array) || !media.bytes.length)) fail('Media must be { bytes, contentType, kind: image | video }.', 400, 'X_INVALID');
    const account = this.rowById(xAccountId); if (!account || account.state !== 'connected') throw this.revokedError();
    const now = this.now(), elapsed = now - (account.lastPostAt || 0);
    if (account.lastPostAt && elapsed < X_ACCOUNT_LIMITS.postSpacingMs) throw xError('This X account posted less than a minute ago.', 'X_RATE_LIMITED', { statusCode: 429, retryAfterMs: X_ACCOUNT_LIMITS.postSpacingMs - elapsed });
    const ceiling = this.config.xGlobalDailyPosts === undefined ? X_ACCOUNT_LIMITS.defaultDailyPosts : Number(this.config.xGlobalDailyPosts);
    if (!Number.isFinite(ceiling) || this.postedToday(now) >= ceiling) throw xError('The platform-wide daily X post limit is reached.', 'X_RATE_LIMITED', { statusCode: 429, retryAfterMs: Math.max(60000, utcDayStart(now) + 86400000 - now) });
    if (this.dry()) { this.bump(account.id, now); return { postId: 'dry-' + randomBytes(6).toString('hex'), url: '', dryRun: true }; }
    const client = this.client();
    const attempt = async token => { const mediaIds = media ? [(await client.uploadMedia(token, { bytes: media.bytes, contentType: media.contentType || '', kind: media.kind })).mediaId] : []; return client.createPost(token, { text, mediaIds }); };
    let result;
    try { result = await attempt(await this.tokenFor(account.id)); }
    catch (error) {
      if (error.code !== 'X_UNAUTHORIZED' || this.rowById(account.id)?.state !== 'connected') throw error;
      // X refused a token that looked valid: one refresh, one retry; a second refusal means the user revoked the app.
      const fresh = await this.refreshNow(account.id);
      try { result = await attempt(fresh); }
      catch (again) { if (again.code === 'X_UNAUTHORIZED' || again.code === 'X_FORBIDDEN') { this.markRevoked(account.id); throw this.revokedError(); } throw again; }
    }
    this.bump(account.id, this.now());
    return { postId: result.id, url: result.url };
  }
  /** Counts a post for the account: posts_today restarts on a new UTC day. */
  bump(id, now) { const key = utcDayKey(now); this.db().run('UPDATE x_accounts SET posts_today = CASE WHEN posts_day_key = ? THEN posts_today + 1 ELSE 1 END, posts_day_key = ?, last_post_at = ?, updated_at = ? WHERE id = ?', key, key, now, now, id); }
  postedToday(now = this.now()) { return Number(this.db().get("SELECT COUNT(*) AS n FROM x_posts WHERE state = 'posted' AND posted_at >= ?", utcDayStart(now))?.n || 0); }
  connectedCount(accountId) { return Number(this.db().get("SELECT COUNT(*) AS n FROM x_accounts WHERE account_id = ? AND state = 'connected'", accountId)?.n || 0); }
  /** Drops expired connection states (harmless before migration v4 exists). */
  prune() { try { this.db().run('DELETE FROM x_oauth_states WHERE expires_at <= ?', this.now()); } catch { /* No table yet, or the service is still starting. */ } }
}
