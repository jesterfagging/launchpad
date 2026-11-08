// X API v2 client for the AI influencer (Launchpad v71.30): OAuth 2.0 user context with PKCE for a
// confidential client, the signed-in user lookup, media upload (one request for images;
// INIT / APPEND / FINALIZE / STATUS for video) and post creation. Pure HTTP: no database, no store,
// no logging. Every call goes through the injected fetcher with a 20 s AbortController timeout and
// fails with an Error whose `code` is one of X_CODES; messages never carry a token (every secret of
// the request is scrubbed) and never more than 200 characters of a response body. Tokens exist here
// only as call arguments; XAccounts keeps them in the encrypted host store.
//
// Request shapes verified on docs.x.com (2026-10-04):
//   https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/user-access-token
//     authorize URL https://x.com/i/oauth2/authorize?response_type=code&client_id&redirect_uri&scope&state&code_challenge&code_challenge_method;
//     POST https://api.x.com/2/oauth2/token form body (code, grant_type=authorization_code, redirect_uri, code_verifier | refresh_token,
//     grant_type=refresh_token) and POST /2/oauth2/revoke (token), all with `Authorization: Basic base64(client_id:client_secret)`
//   https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code
//     scopes tweet.read tweet.write users.read offline.access media.write; code_challenge_method S256; two-hour access tokens
//   https://docs.x.com/x-api/users/get-my-user                 GET /2/users/me -> data.{id,name,username}
//   https://docs.x.com/x-api/media/upload-media                POST /2/media/upload multipart `media` + `media_category` (tweet_image|tweet_video)
//                                                              -> data.{id,media_key,expires_after_secs,processing_info}
//   https://docs.x.com/x-api/media/media-upload-initialize     POST /2/media/upload/initialize JSON {media_type,total_bytes,media_category} -> data.id
//   https://docs.x.com/x-api/media/media-upload-append         POST /2/media/upload/{id}/append multipart `media` + `segment_index`
//   https://docs.x.com/x-api/media/media-upload-finalize       POST /2/media/upload/{id}/finalize -> data.processing_info.{state,check_after_secs}
//   https://docs.x.com/x-api/media/get-media-upload-status     GET /2/media/upload?command=STATUS&media_id= -> data.processing_info (pending|in_progress|succeeded|failed)
//   https://docs.x.com/x-api/media/quickstart/media-upload-chunked   segments at or below 5 MB, indexed from 0; poll with check_after_secs
//   https://docs.x.com/x-api/posts/create-post                 POST /2/tweets {text, media:{media_ids}} -> 201 {data:{id,text}}; errors {title,detail,type,status}
//   https://docs.x.com/x-api/fundamentals/rate-limits          429 with x-rate-limit-reset (Unix seconds)
// Not stated there and therefore isolated in tokenResult() / failure() / processed(): the token response field names
// (access_token, refresh_token, expires_in, scope: RFC 6749), refresh-token rotation (a returned refresh_token replaces
// the stored one; a response without one keeps it), the 403 duplicate-content wording ("duplicate" in the detail),
// the 5 MB one-request image limit and a retry-after header on 429.
import { createHash, randomBytes } from 'node:crypto';

export const X_API = 'https://api.x.com', X_AUTH = 'https://x.com';
export const X_SCOPES = Object.freeze(['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write']);
export const X_CODES = Object.freeze(['X_UNAUTHORIZED', 'X_FORBIDDEN', 'X_RATE_LIMITED', 'X_DUPLICATE', 'X_INVALID', 'X_NETWORK', 'X_PROVIDER']);
export const X_LIMITS = Object.freeze({ timeoutMs: 20000, imageBytes: 5 * 1024 * 1024, videoBytes: 64 * 1024 * 1024, chunkBytes: 4 * 1024 * 1024, statusDeadlineMs: 120000, statusMinWaitMs: 1000, statusMaxWaitMs: 10000, retryDefaultMs: 60000, retryMaxMs: 15 * 60000, detailChars: 200 });
const MEDIA_CATEGORIES = Object.freeze({ image: 'tweet_image', video: 'tweet_video', tweet_image: 'tweet_image', tweet_video: 'tweet_video' });
const DEFAULT_TYPES = Object.freeze({ tweet_image: 'image/png', tweet_video: 'video/mp4' });
const ID = /^[0-9]{1,19}$/;

/** An Error with an X_* code (and optional extras such as status, statusCode, retryAfterMs). */
export const xError = (message, code, extra = {}) => Object.assign(Error(message), { code, ...extra });
const brief = (value, max = X_LIMITS.detailChars) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** Removes every given secret from a message (X never echoes tokens, but a proxy or a mistaken body might). */
const scrub = (message, secrets) => secrets.filter(secret => typeof secret === 'string' && secret.length >= 8).reduce((out, secret) => out.split(secret).join('[token]'), String(message));
const toBuffer = value => Buffer.isBuffer(value) ? value : value instanceof ArrayBuffer ? Buffer.from(value) : value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.alloc(0);
// Bounded waits (poll pacing, request timeouts) keep the process alive on purpose: they are cleared or resolved within seconds.
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** The human-readable part of an X problem document (detail first) or an OAuth error body. */
const problemText = json => { if (!json || typeof json !== 'object') return ''; const first = [json.detail, json.error_description, json.title, json.error, ...(Array.isArray(json.errors) ? json.errors.map(item => item?.detail || item?.message || item?.title) : [])].find(value => typeof value === 'string' && value.trim()); return first || ''; };
const mediaIdOf = (json, fallback = '') => { const id = String(json?.data?.id ?? json?.data?.media_id ?? fallback ?? ''); if (!ID.test(id)) throw xError('X returned no media id.', 'X_PROVIDER'); return id; };

/** PKCE pair: a 64-character base64url verifier and its S256 challenge. */
export function pkce() { const verifier = randomBytes(48).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; }

export class XClient {
  constructor({ clientId, clientSecret, redirectUri, fetcher = globalThis.fetch?.bind(globalThis), now = Date.now, apiBase = X_API, authBase = X_AUTH, timeoutMs = X_LIMITS.timeoutMs, sleep = defaultSleep } = {}) {
    if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret || typeof redirectUri !== 'string' || !redirectUri) throw xError('The X client needs a client id, a client secret and a redirect URI.', 'X_INVALID');
    Object.assign(this, { clientId, clientSecret, redirectUri, fetcher, now, apiBase: apiBase.replace(/\/+$/, ''), authBase: authBase.replace(/\/+$/, ''), timeoutMs, sleep });
  }
  pkce() { return pkce(); }
  basic() { return 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64'); }
  authorizeUrl({ state, challenge, scopes = X_SCOPES } = {}) {
    if (typeof state !== 'string' || !state || typeof challenge !== 'string' || !challenge) throw xError('An authorize URL needs a state and a code challenge.', 'X_INVALID');
    const enc = encodeURIComponent;
    return `${this.authBase}/i/oauth2/authorize?response_type=code&client_id=${enc(this.clientId)}&redirect_uri=${enc(this.redirectUri)}&scope=${enc(scopes.join(' '))}&state=${enc(state)}&code_challenge=${enc(challenge)}&code_challenge_method=S256`;
  }
  // ---- transport ----------------------------------------------------------------------------
  /** One HTTP request with the 20 s timeout; returns the parsed JSON body (null when empty) or throws a coded error. */
  async request(url, { method = 'GET', headers = {}, body, token = '', label = 'request', secrets = [] } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs), hide = [token, ...secrets];
    let response, raw = '';
    try {
      response = await this.fetcher(url, { method, headers: { accept: 'application/json', 'user-agent': 'Launchpad AI Agent', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body, signal: controller.signal });
      try { raw = await response.text(); } catch { raw = ''; }
    } catch (error) {
      throw xError(controller.signal.aborted ? `X ${label} timed out after ${Math.round(this.timeoutMs / 1000)} s.` : `X ${label} could not be reached: ${scrub(brief(error?.message, 120) || 'network error', hide)}`, 'X_NETWORK');
    } finally { clearTimeout(timer); }
    let json = null; if (raw) { try { json = JSON.parse(raw); } catch { json = null; } }
    if (!response.ok) throw this.failure(response, json, raw, label, hide);
    return json;
  }
  /** Maps an HTTP failure to an X_* error; the message keeps at most 200 characters of the body, with secrets removed. */
  failure(response, json, raw, label, secrets = []) {
    const status = Number(response.status) || 0, detail = brief(problemText(json) || (json ? '' : raw)), oauthError = typeof json?.error === 'string' ? json.error : '';
    const message = scrub(`X ${label} failed (HTTP ${status})${detail ? ': ' + detail : '.'}`, secrets);
    if (status === 401 || oauthError === 'invalid_grant') return xError(message, 'X_UNAUTHORIZED', { status });
    if (status === 429) return xError(message, 'X_RATE_LIMITED', { status, retryAfterMs: this.retryAfter(response) });
    if (status === 403) return xError(message, /duplicate/i.test(brief(JSON.stringify(json ?? raw ?? ''), 2000)) ? 'X_DUPLICATE' : 'X_FORBIDDEN', { status });
    if (status >= 500) return xError(message, 'X_PROVIDER', { status });
    return xError(message, 'X_INVALID', { status });
  }
  /** Milliseconds to wait after a 429: retry-after (seconds), else x-rate-limit-reset (Unix seconds), else one minute; 1 s to 15 min. */
  retryAfter(response) {
    const header = name => { try { return response.headers?.get?.(name) ?? null; } catch { return null; } };
    const after = Number(header('retry-after')), reset = Number(header('x-rate-limit-reset'));
    const ms = Number.isFinite(after) && after > 0 ? after * 1000 : Number.isFinite(reset) && reset > 0 ? reset * 1000 - this.now() : X_LIMITS.retryDefaultMs;
    return Math.max(1000, Math.min(X_LIMITS.retryMaxMs, Math.round(ms)));
  }
  // ---- OAuth 2.0 ---------------------------------------------------------------------------
  async token(params, label) {
    const json = await this.request(this.apiBase + '/2/oauth2/token', { method: 'POST', headers: { authorization: this.basic(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...params, client_id: this.clientId }).toString(), label, secrets: [this.clientSecret, params.refresh_token, params.code] });
    return this.tokenResult(json, label);
  }
  /** RFC 6749 token response -> { accessToken, refreshToken ('' when none), expiresAt, scopes }. */
  tokenResult(json, label) {
    if (typeof json?.access_token !== 'string' || !json.access_token) throw xError(`X ${label} returned no access token.`, 'X_PROVIDER');
    const seconds = Number(json.expires_in);
    return { accessToken: json.access_token, refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : '', expiresAt: this.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 7200) * 1000, scopes: String(json.scope || '').split(/\s+/).filter(Boolean) };
  }
  async exchangeCode({ code, verifier } = {}) {
    if (typeof code !== 'string' || !code || typeof verifier !== 'string' || !verifier) throw xError('The code exchange needs the authorization code and its verifier.', 'X_INVALID');
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: verifier }, 'token exchange');
  }
  /** Rotated pair: the returned refresh token replaces the given one when X sends a new one. */
  async refresh(refreshToken) {
    if (typeof refreshToken !== 'string' || !refreshToken) throw xError('A refresh needs the stored refresh token.', 'X_UNAUTHORIZED');
    const result = await this.token({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'token refresh');
    return { ...result, refreshToken: result.refreshToken || refreshToken };
  }
  /** Best effort: true when X accepted the revocation, false otherwise. Never throws. */
  async revoke(token) {
    if (typeof token !== 'string' || !token) return false;
    try { await this.request(this.apiBase + '/2/oauth2/revoke', { method: 'POST', headers: { authorization: this.basic(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, client_id: this.clientId }).toString(), label: 'token revoke', secrets: [token, this.clientSecret] }); return true; } catch { return false; }
  }
  // ---- users, media, posts ----------------------------------------------------------------
  async me(accessToken) {
    const json = await this.request(this.apiBase + '/2/users/me', { token: accessToken, label: 'user lookup' }), user = json?.data;
    const id = String(user?.id ?? ''); if (!user || !/^[0-9]{1,20}$/.test(id) || typeof user.username !== 'string' || !user.username) throw xError('X returned no user.', 'X_PROVIDER');
    return { id, username: user.username, name: typeof user.name === 'string' ? user.name : '' };
  }
  /** Uploads one image (<= 5 MB, one request) or one video (chunked, then STATUS until processed) -> { mediaId }. */
  async uploadMedia(accessToken, { bytes, contentType = '', category = '', kind = '' } = {}) {
    const mediaCategory = MEDIA_CATEGORIES[category || kind]; if (!mediaCategory) throw xError('Choose tweet_image or tweet_video as the media category.', 'X_INVALID');
    const data = toBuffer(bytes); if (!data.length) throw xError('The media is empty.', 'X_INVALID');
    const type = contentType || DEFAULT_TYPES[mediaCategory];
    if (mediaCategory === 'tweet_image') {
      if (data.length > X_LIMITS.imageBytes) throw xError('Images must be 5 MB or smaller.', 'X_INVALID');
      const form = new FormData(); form.append('media', new Blob([data], { type }), 'media'); form.append('media_category', mediaCategory);
      return this.processed(accessToken, await this.request(`${this.apiBase}/2/media/upload`, { method: 'POST', body: form, token: accessToken, label: 'media upload' }));
    }
    if (data.length > X_LIMITS.videoBytes) throw xError('Videos must be 64 MB or smaller.', 'X_INVALID');
    const init = await this.request(`${this.apiBase}/2/media/upload/initialize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_type: type, total_bytes: data.length, media_category: mediaCategory }), token: accessToken, label: 'media upload INIT' });
    const id = mediaIdOf(init);
    for (let index = 0, offset = 0; offset < data.length; index++, offset += X_LIMITS.chunkBytes) {
      const form = new FormData(); form.append('media', new Blob([data.subarray(offset, offset + X_LIMITS.chunkBytes)], { type }), 'chunk'); form.append('segment_index', String(index));
      await this.request(`${this.apiBase}/2/media/upload/${encodeURIComponent(id)}/append`, { method: 'POST', body: form, token: accessToken, label: 'media upload APPEND' });
    }
    return this.processed(accessToken, await this.request(`${this.apiBase}/2/media/upload/${encodeURIComponent(id)}/finalize`, { method: 'POST', token: accessToken, label: 'media upload FINALIZE' }), id);
  }
  /** Waits for processing_info to reach `succeeded` (STATUS polls paced by check_after_secs, 120 s deadline). */
  async processed(accessToken, json, fallbackId = '') {
    const id = mediaIdOf(json, fallbackId), deadline = this.now() + X_LIMITS.statusDeadlineMs; let info = json?.data?.processing_info || null;
    while (info && ['pending', 'in_progress'].includes(info.state)) {
      if (this.now() >= deadline) throw xError('X did not finish processing the media within 120 s.', 'X_PROVIDER');
      const seconds = Number(info.check_after_secs); await this.sleep(Math.max(X_LIMITS.statusMinWaitMs, Math.min(X_LIMITS.statusMaxWaitMs, (Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000)));
      const status = await this.request(`${this.apiBase}/2/media/upload?command=STATUS&media_id=${encodeURIComponent(id)}`, { token: accessToken, label: 'media upload STATUS' });
      info = status?.data?.processing_info || { state: 'succeeded' };
    }
    if (info && info.state !== 'succeeded') throw xError(`X did not accept the media${info.error?.message ? ': ' + brief(info.error.message, 120) : '.'}`, 'X_INVALID');
    return { mediaId: id };
  }
  async createPost(accessToken, { text, mediaIds = [] } = {}) {
    const ids = (Array.isArray(mediaIds) ? mediaIds : []).map(String).filter(id => ID.test(id)).slice(0, 4);
    if (typeof text !== 'string' || (!text.trim() && !ids.length)) throw xError('A post needs text or media.', 'X_INVALID');
    const json = await this.request(`${this.apiBase}/2/tweets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, ...(ids.length ? { media: { media_ids: ids } } : {}) }), token: accessToken, label: 'post' });
    const id = String(json?.data?.id ?? ''); if (!ID.test(id)) throw xError('X returned no post id.', 'X_PROVIDER');
    return { id, url: `https://x.com/i/web/status/${id}` };
  }
}
