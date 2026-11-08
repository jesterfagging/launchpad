import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { XClient, X_SCOPES, X_LIMITS, pkce } from '../src/agent/x.mjs';

// Every test runs against a scripted fetcher: nothing here touches the network.
const SECRET = 'client-secret-0123456789', TOKEN = 'access-token-ABCDEFGHIJKLMNOP', REFRESH = 'refresh-token-QRSTUVWXYZ012345';
function fakeFetch(handler) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const call = { url: String(url), path: new URL(String(url)).pathname, query: new URL(String(url)).searchParams, method: init.method || 'GET', headers: init.headers || {}, body: init.body, signal: init.signal };
    calls.push(call);
    const result = await handler(call, calls.length);
    if (result instanceof Response) return result;
    const { status = 200, body = {}, headers = {} } = result;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
  return { fetcher, calls };
}
function client(handler, extra = {}) {
  let clock = Date.UTC(2026, 9, 4, 12, 0, 0);
  const { fetcher, calls } = fakeFetch(handler);
  const x = new XClient({ clientId: 'client-id', clientSecret: SECRET, redirectUri: 'https://launchpad.test/api/launchpad/x/callback', fetcher, now: () => clock, sleep: async ms => { clock += ms; }, ...extra });
  return { x, calls, tick: ms => { clock += ms; }, now: () => clock };
}
const tokenBody = (overrides = {}) => ({ token_type: 'bearer', expires_in: 7200, access_token: TOKEN, scope: X_SCOPES.join(' '), refresh_token: REFRESH, ...overrides });

test('pkce pairs and the authorize URL carry every required field', () => {
  const pair = pkce();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43,128}$/); assert.equal(pair.challenge, createHash('sha256').update(pair.verifier).digest('base64url'));
  assert.notEqual(pkce().verifier, pair.verifier);
  const { x } = client(() => ({}));
  assert.deepEqual(x.pkce().verifier.length, 64);
  const url = new URL(x.authorizeUrl({ state: 'st ate/+', challenge: pair.challenge }));
  assert.equal(url.origin + url.pathname, 'https://x.com/i/oauth2/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code'); assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://launchpad.test/api/launchpad/x/callback');
  assert.equal(url.searchParams.get('scope'), 'tweet.read tweet.write users.read offline.access media.write');
  assert.equal(url.searchParams.get('state'), 'st ate/+'); assert.equal(url.searchParams.get('code_challenge'), pair.challenge); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.search.includes('scope=tweet.read%20tweet.write'), 'spaces are percent-encoded, as in the documented example');
  assert.throws(() => x.authorizeUrl({ state: '', challenge: 'c' }), error => error.code === 'X_INVALID');
  assert.throws(() => new XClient({ clientId: '', clientSecret: 's', redirectUri: 'u' }), error => error.code === 'X_INVALID');
});

test('exchangeCode posts the confidential-client form and parses the token response', async () => {
  const { x, calls, now } = client(() => ({ body: tokenBody() }));
  const result = await x.exchangeCode({ code: 'the-code', verifier: 'the-verifier' });
  assert.equal(calls.length, 1); const call = calls[0];
  assert.equal(call.url, 'https://api.x.com/2/oauth2/token'); assert.equal(call.method, 'POST');
  assert.equal(call.headers.authorization, 'Basic ' + Buffer.from('client-id:' + SECRET).toString('base64'));
  assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(call.body);
  assert.equal(form.get('grant_type'), 'authorization_code'); assert.equal(form.get('code'), 'the-code'); assert.equal(form.get('redirect_uri'), 'https://launchpad.test/api/launchpad/x/callback'); assert.equal(form.get('code_verifier'), 'the-verifier'); assert.equal(form.get('client_id'), 'client-id');
  assert.deepEqual(result, { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: now() + 7200000, scopes: [...X_SCOPES] });
  assert.ok(call.signal instanceof AbortSignal, 'every request carries an abort signal');
  await assert.rejects(x.exchangeCode({ code: '', verifier: 'v' }), error => error.code === 'X_INVALID');
});

test('refresh rotates the pair when X returns a new refresh token and keeps the old one otherwise', async () => {
  const responses = [tokenBody({ access_token: 'access-2', refresh_token: 'refresh-2' }), tokenBody({ access_token: 'access-3', refresh_token: undefined }), { status: 400, body: { error: 'invalid_grant', error_description: 'Value passed for the token was invalid.' } }];
  const { x, calls } = client(() => { const next = responses.shift(); return next.status ? next : { body: next }; });
  const first = await x.refresh(REFRESH);
  const form = new URLSearchParams(calls[0].body); assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), REFRESH); assert.equal(form.get('client_id'), 'client-id');
  assert.equal(calls[0].headers.authorization, 'Basic ' + Buffer.from('client-id:' + SECRET).toString('base64'));
  assert.equal(first.accessToken, 'access-2'); assert.equal(first.refreshToken, 'refresh-2');
  const second = await x.refresh('refresh-2'); assert.equal(second.accessToken, 'access-3'); assert.equal(second.refreshToken, 'refresh-2', 'no refresh_token in the answer keeps the stored one');
  // A dead grant is an authorization failure even though the token endpoint answers 400.
  const dead = await x.refresh('refresh-2').catch(error => error);
  assert.equal(dead.code, 'X_UNAUTHORIZED'); assert.equal(dead.status, 400); assert.ok(!dead.message.includes('refresh-2'));
  await assert.rejects(x.refresh(''), error => error.code === 'X_UNAUTHORIZED');
});

test('me returns the signed-in user with a bearer token and never leaks it', async () => {
  const { x, calls } = client(() => ({ body: { data: { id: '12345', name: 'Goat Poster', username: 'goatposter' } } }));
  assert.deepEqual(await x.me(TOKEN), { id: '12345', username: 'goatposter', name: 'Goat Poster' });
  assert.equal(calls[0].url, 'https://api.x.com/2/users/me'); assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].headers.authorization, 'Bearer ' + TOKEN);
  const { x: broken } = client(() => ({ body: { data: {} } }));
  await assert.rejects(broken.me(TOKEN), error => error.code === 'X_PROVIDER');
});

test('an image is uploaded in one multipart request and attached to the post', async () => {
  const { x, calls } = client(call => call.path === '/2/media/upload' ? { body: { data: { id: '7001', media_key: '3_7001', expires_after_secs: 86400 } } } : { status: 201, body: { data: { id: '9001', text: 'hello' } } });
  const bytes = Buffer.alloc(1024, 7);
  const upload = await x.uploadMedia(TOKEN, { bytes, contentType: 'image/png', category: 'tweet_image' });
  assert.deepEqual(upload, { mediaId: '7001' });
  const [first] = calls; assert.equal(first.method, 'POST'); assert.equal(first.headers.authorization, 'Bearer ' + TOKEN); assert.ok(first.body instanceof FormData);
  assert.equal(first.body.get('media_category'), 'tweet_image'); const file = first.body.get('media'); assert.equal(file.size, 1024); assert.equal(file.type, 'image/png');
  assert.equal(first.headers['content-type'], undefined, 'fetch sets the multipart boundary itself');
  const post = await x.createPost(TOKEN, { text: 'hello', mediaIds: [upload.mediaId] });
  assert.deepEqual(post, { id: '9001', url: 'https://x.com/i/web/status/9001' });
  const second = calls[1]; assert.equal(second.url, 'https://api.x.com/2/tweets'); assert.equal(second.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(second.body), { text: 'hello', media: { media_ids: ['7001'] } });
  await x.createPost(TOKEN, { text: 'plain' }); assert.deepEqual(JSON.parse(calls[2].body), { text: 'plain' }, 'no media key without media');
  // The kind alias and the size cap.
  await x.uploadMedia(TOKEN, { bytes, kind: 'image' }); assert.equal(calls.at(-1).body.get('media_category'), 'tweet_image');
  await assert.rejects(x.uploadMedia(TOKEN, { bytes: Buffer.alloc(X_LIMITS.imageBytes + 1), kind: 'image' }), error => error.code === 'X_INVALID' && /5 MB/.test(error.message));
  await assert.rejects(x.uploadMedia(TOKEN, { bytes: Buffer.alloc(0), kind: 'image' }), error => error.code === 'X_INVALID');
  await assert.rejects(x.uploadMedia(TOKEN, { bytes, category: 'dm_image' }), error => error.code === 'X_INVALID');
  await assert.rejects(x.createPost(TOKEN, { text: '   ' }), error => error.code === 'X_INVALID');
});

test('a video goes through INIT, 4 MB APPEND chunks, FINALIZE and STATUS polling', async () => {
  const statuses = [{ state: 'pending', check_after_secs: 5 }, { state: 'in_progress', check_after_secs: 2, progress_percent: 50 }, { state: 'succeeded', progress_percent: 100 }];
  const { x, calls, now } = client(call => {
    if (call.path === '/2/media/upload/initialize') return { body: { data: { id: '8001', media_key: '7_8001', expires_after_secs: 3600 } } };
    if (/^\/2\/media\/upload\/8001\/append$/.test(call.path)) return { body: { data: { expires_at: Math.floor(now() / 1000) + 3600 } } };
    if (call.path === '/2/media/upload/8001/finalize') return { body: { data: { id: '8001', media_key: '7_8001', processing_info: { state: 'pending', check_after_secs: 1 } } } };
    if (call.path === '/2/media/upload' && call.query.get('command') === 'STATUS') return { body: { data: { id: '8001', processing_info: statuses.shift() } } };
    throw Error('unexpected ' + call.url);
  });
  const bytes = Buffer.alloc(9 * 1024 * 1024 + 5, 1);
  const started = now();
  assert.deepEqual(await x.uploadMedia(TOKEN, { bytes, contentType: 'video/mp4', kind: 'video' }), { mediaId: '8001' });
  const init = calls[0]; assert.equal(init.method, 'POST'); assert.equal(init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { media_type: 'video/mp4', total_bytes: bytes.length, media_category: 'tweet_video' });
  const appends = calls.filter(call => call.path.endsWith('/append'));
  assert.equal(appends.length, 3); assert.deepEqual(appends.map(call => call.body.get('segment_index')), ['0', '1', '2']);
  assert.deepEqual(appends.map(call => call.body.get('media').size), [4 * 1024 * 1024, 4 * 1024 * 1024, 1024 * 1024 + 5]);
  assert.equal(calls[4].path, '/2/media/upload/8001/finalize'); assert.equal(calls[4].method, 'POST');
  const polls = calls.filter(call => call.query.get('command') === 'STATUS');
  assert.equal(polls.length, 3); assert.equal(polls[0].method, 'GET'); assert.equal(polls[0].query.get('media_id'), '8001'); assert.equal(polls[0].headers.authorization, 'Bearer ' + TOKEN);
  assert.equal(now() - started, 1000 + 5000 + 2000, 'the client waits check_after_secs between polls (1 s floor)');
  for (const call of calls) assert.ok(!JSON.stringify(call.url).includes(TOKEN));
});

test('media processing failures and the 120 s deadline are reported with codes', async () => {
  const failing = client(call => call.path.endsWith('/finalize') ? { body: { data: { id: '8002', processing_info: { state: 'failed', error: { code: 1, message: 'InvalidMedia: Unsupported video format' } } } } } : call.path.endsWith('/initialize') ? { body: { data: { id: '8002' } } } : { body: { data: {} } });
  const failed = await failing.x.uploadMedia(TOKEN, { bytes: Buffer.alloc(10), kind: 'video' }).catch(error => error);
  assert.equal(failed.code, 'X_INVALID'); assert.match(failed.message, /Unsupported video format/);
  const slow = client(call => call.path.endsWith('/initialize') ? { body: { data: { id: '8003' } } } : call.path.endsWith('/finalize') || call.query.get('command') === 'STATUS' ? { body: { data: { id: '8003', processing_info: { state: 'in_progress', check_after_secs: 30 } } } } : { body: { data: {} } });
  const stuck = await slow.x.uploadMedia(TOKEN, { bytes: Buffer.alloc(10), kind: 'video' }).catch(error => error);
  assert.equal(stuck.code, 'X_PROVIDER'); assert.match(stuck.message, /120 s/);
  const polls = slow.calls.filter(call => call.query.get('command') === 'STATUS').length;
  assert.ok(polls >= 12 && polls <= 13, `polls are capped at 10 s apart (${polls})`);
  const noId = client(call => call.path.endsWith('/initialize') ? { body: { data: {} } } : { body: {} });
  await assert.rejects(noId.x.uploadMedia(TOKEN, { bytes: Buffer.alloc(10), kind: 'video' }), error => error.code === 'X_PROVIDER');
  await assert.rejects(noId.x.uploadMedia(TOKEN, { bytes: Buffer.alloc(X_LIMITS.videoBytes + 1), kind: 'video' }), error => error.code === 'X_INVALID');
});

test('HTTP failures map to X_* codes with bounded, token-free messages', async () => {
  const cases = [
    [{ status: 401, body: { title: 'Unauthorized', detail: 'Unauthorized', type: 'about:blank', status: 401 } }, 'X_UNAUTHORIZED'],
    [{ status: 403, body: { title: 'Forbidden', detail: 'You are not allowed to create a Tweet with duplicate content.', type: 'about:blank', status: 403 } }, 'X_DUPLICATE'],
    [{ status: 403, body: { title: 'Forbidden', detail: 'This user is not allowed to post a video longer than 20 minutes.', type: 'about:blank', status: 403 } }, 'X_FORBIDDEN'],
    [{ status: 429, body: { title: 'Too Many Requests', detail: 'Rate limit exceeded', status: 429 }, headers: { 'x-rate-limit-reset': String(Math.floor(Date.UTC(2026, 9, 4, 12, 0, 0) / 1000) + 90) } }, 'X_RATE_LIMITED'],
    [{ status: 400, body: { errors: [{ message: 'Invalid Request: One or more parameters to your request was invalid.' }], title: 'Invalid Request' } }, 'X_INVALID'],
    [{ status: 422, body: { detail: 'unprocessable' } }, 'X_INVALID'],
    [{ status: 503, body: '<html>Service Unavailable</html>' }, 'X_PROVIDER'],
    [{ status: 500, body: { detail: 'Internal error' } }, 'X_PROVIDER'],
  ];
  for (const [response, code] of cases) {
    const { x } = client(() => response);
    const error = await x.createPost(TOKEN, { text: 'hi' }).catch(error => error);
    assert.equal(error.code, code, `HTTP ${response.status} -> ${code}`); assert.equal(error.status, response.status);
    assert.ok(!error.message.includes(TOKEN)); assert.ok(error.message.length <= 260, error.message);
    assert.match(error.message, new RegExp(`X post failed \\(HTTP ${response.status}\\)`));
  }
  const limited = client(() => cases[3][0]);
  const rate = await limited.x.createPost(TOKEN, { text: 'hi' }).catch(error => error);
  assert.equal(rate.retryAfterMs, 90000, 'x-rate-limit-reset is a Unix timestamp in seconds');
  const header = client(() => ({ status: 429, body: {}, headers: { 'retry-after': '7' } }));
  assert.equal((await header.x.createPost(TOKEN, { text: 'hi' }).catch(error => error)).retryAfterMs, 7000);
  const bare = client(() => ({ status: 429, body: {} }));
  assert.equal((await bare.x.createPost(TOKEN, { text: 'hi' }).catch(error => error)).retryAfterMs, X_LIMITS.retryDefaultMs);
  const stale = client(() => ({ status: 429, body: {}, headers: { 'x-rate-limit-reset': '1' } }));
  assert.equal((await stale.x.createPost(TOKEN, { text: 'hi' }).catch(error => error)).retryAfterMs, 1000, 'a reset in the past waits one second');
});

test('network failures and timeouts are X_NETWORK; secrets and long bodies never reach messages', async () => {
  const down = client(() => { throw Error('getaddrinfo ENOTFOUND api.x.com ' + TOKEN); });
  const unreachable = await down.x.me(TOKEN).catch(error => error);
  assert.equal(unreachable.code, 'X_NETWORK'); assert.ok(!unreachable.message.includes(TOKEN)); assert.match(unreachable.message, /could not be reached/);
  const hanging = client(call => new Promise((_, reject) => call.signal.addEventListener('abort', () => reject(Object.assign(Error('This operation was aborted'), { name: 'AbortError' })))), { timeoutMs: 20 });
  const timeout = await hanging.x.me(TOKEN).catch(error => error);
  assert.equal(timeout.code, 'X_NETWORK'); assert.match(timeout.message, /timed out/);
  // A body that echoes the request's secrets (client secret, authorization code) is scrubbed and truncated.
  const code = 'authorization-code-0123456789';
  const echo = client(() => ({ status: 400, body: { detail: `bad request for ${code} with ${SECRET} ` + 'x'.repeat(2000) } }));
  const error = await echo.x.exchangeCode({ code, verifier: 'v' }).catch(error => error);
  assert.equal(error.code, 'X_INVALID'); assert.ok(!error.message.includes(code) && !error.message.includes(SECRET)); assert.ok(error.message.length < 300);
  const tokenEcho = client(() => ({ status: 500, body: { detail: 'refresh ' + REFRESH + ' rejected' } }));
  const refreshError = await tokenEcho.x.refresh(REFRESH).catch(error => error);
  assert.ok(!refreshError.message.includes(REFRESH)); assert.ok(refreshError.message.includes('[token]'));
  const bearerEcho = client(() => ({ status: 400, body: { detail: 'token ' + TOKEN + ' is malformed' } }));
  const bearerError = await bearerEcho.x.createPost(TOKEN, { text: 'hi' }).catch(error => error);
  assert.ok(!bearerError.message.includes(TOKEN)); assert.match(bearerError.message, /\[token\] is malformed/);
  const nonJson = client(() => ({ status: 200, body: 'not json' }));
  await assert.rejects(nonJson.x.me(TOKEN), error => error.code === 'X_PROVIDER');
});

test('revoke is best effort and never throws', async () => {
  const ok = client(() => ({ body: { revoked: true } }));
  assert.equal(await ok.x.revoke(REFRESH), true);
  const form = new URLSearchParams(ok.calls[0].body); assert.equal(form.get('token'), REFRESH); assert.equal(form.get('client_id'), 'client-id');
  assert.equal(ok.calls[0].url, 'https://api.x.com/2/oauth2/revoke'); assert.equal(ok.calls[0].headers.authorization, 'Basic ' + Buffer.from('client-id:' + SECRET).toString('base64'));
  const failing = client(() => ({ status: 500, body: {} }));
  assert.equal(await failing.x.revoke(REFRESH), false);
  const down = client(() => { throw Error('offline'); });
  assert.equal(await down.x.revoke(REFRESH), false);
  assert.equal(await down.x.revoke(''), false);
});
