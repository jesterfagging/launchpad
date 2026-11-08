import test from 'node:test';
import assert from 'node:assert/strict';
import { HiggsfieldClient, HIGGSFIELD_MODELS, HIGGSFIELD_API, mergeModels, estimateUsd, IMAGE_MAX_BYTES } from '../src/agent/higgsfield.mjs';
import { AGENT_RATE_CARD_V2 } from '../public/agent-catalog.mjs';

const KEY = 'key-id-123:key-secret-abcdef';
const reply = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))) });
/** A scripted fetcher: each call pops the next scripted answer and records the request. */
function scripted(answers) {
  const calls = [];
  const fetcher = async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET', headers: Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v])), body: init.body }); const next = answers.shift(); if (!next) throw Object.assign(Error('no scripted answer for ' + url), { name: 'TypeError' }); if (next instanceof Error) throw next; return next; };
  return { fetcher, calls };
}

test('the model table is verified against the docs: Soul 2 text-to-image, Qwen Image 3 edit, Kling 3.0 Turbo image-to-video', () => {
  assert.equal(HIGGSFIELD_MODELS.image.path, 'higgsfield-ai/soul/v2/standard');
  assert.equal(HIGGSFIELD_MODELS.video.path, 'kling-video/v3.0-turbo/image-to-video');
  assert.equal(HIGGSFIELD_MODELS.edit.path, 'alibaba/qwen-image-3/edit', 'the verified image-to-image model');
  assert.equal(HIGGSFIELD_MODELS.speak.path, '');
  // Soul 2: batch_size is 1 or 4 (there is no 3), seeds are 1..1000000, aspect ratios from the documented enum.
  assert.deepEqual(HIGGSFIELD_MODELS.image.body({ prompt: 'p', aspectRatio: '1:1', resolution: '1080p', batch: 4, seed: 42 }), { prompt: 'p', aspect_ratio: '1:1', resolution: '1080p', batch_size: 4, enhance_prompt: false, seed: 42 });
  assert.deepEqual(HIGGSFIELD_MODELS.image.body({ prompt: 'p', aspectRatio: '5:5', resolution: '4k', batch: 3, seed: 5000000 }), { prompt: 'p', aspect_ratio: '1:1', resolution: '720p', batch_size: 1, enhance_prompt: false, seed: 1000000 });
  assert.deepEqual(HIGGSFIELD_MODELS.image.body({ prompt: 'p', referenceId: 'abc', referenceStrength: 2 }), { prompt: 'p', aspect_ratio: '1:1', resolution: '720p', batch_size: 1, enhance_prompt: false, custom_reference_id: 'abc', custom_reference_strength: 1 });
  assert.deepEqual(HIGGSFIELD_MODELS.edit.body({ prompt: 'same character', imageUrls: ['https://cdn.example/a.png', 'http://insecure/b.png'], aspectRatio: '16:9' }), { prompt: 'same character', image_urls: ['https://cdn.example/a.png'], resolution: '1k', aspect_ratio: '16:9' });
  assert.deepEqual(HIGGSFIELD_MODELS.edit.body({ prompt: 'x', imageUrl: 'https://cdn.example/m.png' }).image_urls, ['https://cdn.example/m.png']);
  assert.deepEqual(HIGGSFIELD_MODELS.video.body({ prompt: 'wave', imageUrl: 'https://cdn.example/a.png', duration: 99, resolution: '1080p' }), { prompt: 'wave', image_url: 'https://cdn.example/a.png', duration: 15, resolution: '1080p' });
  assert.equal(HIGGSFIELD_MODELS.video.body({ prompt: 'wave', imageUrl: 'https://cdn.example/a.png' }).duration, 5);
  // Overrides merge per key and can only set path, output and extra; builders stay code.
  const merged = mergeModels({ edit: { path: '/vendor/other-edit/', extra: { enable_thinking: false }, body: 'not-a-function' }, image: 'junk', bogus: { path: 'x' } });
  assert.equal(merged.edit.path, 'vendor/other-edit'); assert.equal(typeof merged.edit.body, 'function'); assert.deepEqual(merged.edit.extra, { enable_thinking: false }); assert.equal(merged.image.path, HIGGSFIELD_MODELS.image.path); assert.equal(merged.bogus, undefined);
  const client = new HiggsfieldClient({ key: KEY, models: { edit: { path: '', extra: { a: 1 } } } });
  assert.equal(client.modelAvailable('edit'), false, 'an empty path switches a model off'); assert.equal(client.modelAvailable('image'), true); assert.equal(client.modelAvailable('speak'), false);
  assert.deepEqual(new HiggsfieldClient({ key: KEY, models: { image: { extra: { style_strength: 0.5 } } } }).body('image', { prompt: 'p' }), { prompt: 'p', aspect_ratio: '1:1', resolution: '720p', batch_size: 1, enhance_prompt: false, style_strength: 0.5 });
});

test('estimateUsd follows the rate card: per image at 720p/1080p × batch, one edit image, clip seconds plus overhead, one check', () => {
  const card = AGENT_RATE_CARD_V2;
  assert.equal(estimateUsd('image', { resolution: '720p', batch: 1 }), BigInt(card.imageUsd));
  assert.equal(estimateUsd('image', { resolution: '1080p', batch: 4 }), BigInt(card.imageHdUsd) * 4n);
  assert.equal(estimateUsd('edit', {}), BigInt(card.editUsd)); assert.equal(estimateUsd('edit', {}, { imageUsd: 30000 }), BigInt(card.editUsd), 'edits have their own price');
  assert.equal(estimateUsd('video', { duration: 5 }), BigInt(card.videoSecondUsd) * 5n + BigInt(card.videoOverheadUsd));
  assert.equal(estimateUsd('video', {}), 650000n); assert.equal(estimateUsd('check'), BigInt(card.mediaCheckUsd)); assert.equal(estimateUsd('speak'), BigInt(card.speakUsd)); assert.equal(estimateUsd('nope'), 0n);
  assert.equal(estimateUsd('image', {}, { imageUsd: 30000 }), 30000n, 'an operator rate card override is honoured per key');
  assert.equal(new HiggsfieldClient({ key: KEY }).estimateUsd('check'), 10000n);
});

test('submit sends the key header, an Idempotency-Key and the documented body; status normalizes states and output URLs', async () => {
  const { fetcher, calls } = scripted([
    reply(200, { status: 'queued', request_id: 'req-1', status_url: HIGGSFIELD_API + '/requests/req-1/status', cancel_url: HIGGSFIELD_API + '/requests/req-1/cancel' }),
    reply(200, { status: 'queued', request_id: 'req-1' }),
    reply(200, { status: 'in_progress', request_id: 'req-1' }),
    reply(200, { status: 'completed', request_id: 'req-1', images: [{ url: 'https://cdn.higgsfield.ai/a.png' }, { url: 'http://plain/b.png' }, { url: 'https://cdn.higgsfield.ai/c.png' }], error: null }),
    reply(200, { status: 'completed', request_id: 'req-2', video: { url: 'https://cdn.higgsfield.ai/clip.mp4' } }),
    reply(200, { status: 'nsfw', request_id: 'req-3', error: 'flagged' }),
    reply(200, { status: 'mystery', request_id: 'req-4' }),
  ]);
  const client = new HiggsfieldClient({ key: KEY, fetcher });
  assert.equal(client.available(), true); assert.equal(new HiggsfieldClient({ key: 'nocolon', fetcher }).available(), false); assert.equal(new HiggsfieldClient({ key: KEY, fetcher: null }).available(), false);
  const submitted = await client.submit('image', { prompt: 'portrait', resolution: '1080p', batch: 4, seed: 7 }, { idempotencyKey: 'media:job1:image:1' });
  assert.deepEqual(submitted, { requestId: 'req-1', statusUrl: HIGGSFIELD_API + '/requests/req-1/status', cancelUrl: HIGGSFIELD_API + '/requests/req-1/cancel' });
  assert.equal(calls[0].url, HIGGSFIELD_API + '/higgsfield-ai/soul/v2/standard'); assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, 'Key ' + KEY); assert.equal(calls[0].headers['idempotency-key'], 'media:job1:image:1'); assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body), { prompt: 'portrait', aspect_ratio: '1:1', resolution: '1080p', batch_size: 4, enhance_prompt: false, seed: 7 });
  assert.deepEqual(await client.status('req-1'), { state: 'queued', urls: [], error: '' });
  assert.equal(calls[1].url, HIGGSFIELD_API + '/requests/req-1/status'); assert.equal(calls[1].method, 'GET'); assert.equal(calls[1].headers.authorization, 'Key ' + KEY);
  assert.equal((await client.status('req-1')).state, 'running');
  assert.deepEqual(await client.status('req-1'), { state: 'completed', urls: ['https://cdn.higgsfield.ai/a.png', 'https://cdn.higgsfield.ai/c.png'], error: '' }, 'only https outputs are kept');
  assert.deepEqual(await client.status('req-2'), { state: 'completed', urls: ['https://cdn.higgsfield.ai/clip.mp4'], error: '' });
  assert.deepEqual(await client.status('req-3'), { state: 'nsfw', urls: [], error: 'flagged' });
  assert.equal((await client.status('req-4')).state, 'queued', 'an unknown status keeps polling');
  await assert.rejects(client.status('bad id!'), error => error.code === 'HF_INVALID');
  await assert.rejects(client.submit('speak', { prompt: 'x' }), error => error.code === 'HF_INVALID' && /No speak model/.test(error.message));
  await assert.rejects(new HiggsfieldClient({ key: '', fetcher }).submit('image', { prompt: 'x' }), error => error.code === 'HF_UNAUTHORIZED');
});

test('upload asks for a presigned URL, PUTs the bytes without credentials and returns the public URL; cancel and estimate use the documented endpoints', async () => {
  const bytes = Buffer.from('png-bytes');
  const { fetcher, calls } = scripted([
    reply(200, { public_url: 'https://media.higgsfield.ai/pub/x.png', upload_url: 'https://s3.example/upload?sig=1', upload_headers: { 'Content-Type': 'image/png', 'x-amz-tagging': 'ttl=1h', 'bad header!': 'x' }, content_type: 'image/png' }),
    reply(200, ''),
    reply(202, ''),
    reply(400, { detail: 'Request already running' }),
    reply(200, { credits: '1.500', usd: '0.094' }),
    reply(200, { credits: null }),
  ]);
  const client = new HiggsfieldClient({ key: KEY, fetcher });
  assert.equal(await client.upload(bytes, 'image/png'), 'https://media.higgsfield.ai/pub/x.png');
  assert.equal(calls[0].url, HIGGSFIELD_API + '/files/generate-upload-url'); assert.deepEqual(JSON.parse(calls[0].body), { content_type: 'image/png' }); assert.equal(calls[0].headers.authorization, 'Key ' + KEY);
  assert.equal(calls[1].url, 'https://s3.example/upload?sig=1'); assert.equal(calls[1].method, 'PUT'); assert.equal(calls[1].headers.authorization, undefined, 'no credentials go to the storage host'); assert.equal(calls[1].headers['x-amz-tagging'], 'ttl=1h'); assert.equal(calls[1].headers['content-type'], 'image/png'); assert.equal('bad header!' in calls[1].headers, false); assert.ok(Buffer.isBuffer(calls[1].body) && calls[1].body.equals(bytes));
  await assert.rejects(client.upload(bytes, 'text/html'), error => error.code === 'HF_INVALID');
  await assert.rejects(client.upload(Buffer.alloc(0), 'image/png'), error => error.code === 'HF_INVALID');
  assert.equal(await client.cancel('req-1'), true); assert.equal(calls[2].url, HIGGSFIELD_API + '/requests/req-1/cancel'); assert.equal(calls[2].method, 'POST');
  assert.equal(await client.cancel('req-1'), false, 'a running request cannot be cancelled: false, not an error');
  assert.deepEqual(await client.estimate('image', { prompt: 'Editorial portrait' }), { usd: 94000n, credits: '1.500' });
  assert.equal(calls[4].url, HIGGSFIELD_API + '/estimate/higgsfield-ai/soul/v2/standard'); assert.deepEqual(JSON.parse(calls[4].body), client.body('image', { prompt: 'Editorial portrait' }));
  assert.deepEqual(await client.estimate('image', { prompt: 'x' }), { usd: null, credits: null });
});

test('download accepts https only, caps the size for images and clips, and never sends the key', async () => {
  const big = Buffer.alloc(IMAGE_MAX_BYTES + 1, 1), small = Buffer.from('small');
  const { fetcher, calls } = scripted([reply(200, small, { 'content-type': 'image/png; charset=binary', 'content-length': String(small.length) }), reply(200, big, { 'content-type': 'image/png' }), reply(200, small, { 'content-type': 'image/png', 'content-length': String(IMAGE_MAX_BYTES + 5) }), reply(404, 'missing')]);
  const client = new HiggsfieldClient({ key: KEY, fetcher });
  assert.deepEqual(await client.download('https://cdn.higgsfield.ai/a.png'), { bytes: small, contentType: 'image/png' });
  assert.equal(calls[0].headers.authorization, undefined);
  await assert.rejects(client.download('https://cdn.higgsfield.ai/big.png'), error => error.code === 'HF_INVALID' && /larger/.test(error.message));
  await assert.rejects(client.download('https://cdn.higgsfield.ai/declared.png'), error => error.code === 'HF_INVALID');
  await assert.rejects(client.download('https://cdn.higgsfield.ai/missing.png'), error => error.code === 'HF_INVALID' && error.status === 404);
  await assert.rejects(client.download('http://cdn.higgsfield.ai/a.png'), error => error.code === 'HF_INVALID' && /https/.test(error.message));
  await assert.rejects(client.download('file:///etc/passwd'), error => error.code === 'HF_INVALID');
  // Streaming bodies are read with the same cap.
  const chunks = [Buffer.alloc(IMAGE_MAX_BYTES / 2 + 1, 2), Buffer.alloc(IMAGE_MAX_BYTES / 2 + 1, 3)]; let cancelled = false;
  const streamed = { ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }), cancel: async () => { cancelled = true; } }) } };
  await assert.rejects(new HiggsfieldClient({ key: KEY, fetcher: async () => streamed }).download('https://cdn.higgsfield.ai/stream.png'), error => error.code === 'HF_INVALID');
  assert.equal(cancelled, true);
});

test('HTTP errors map to codes (400 concurrency vs invalid, 401, 403 funds, 404/422 invalid, 423/503/5xx unavailable, network) and never carry the key', async () => {
  const cases = [
    [reply(400, { detail: 'Maximum number of concurrent requests (4) has been reached' }), 'HF_CONCURRENCY'],
    [reply(400, { detail: 'prompt is required' }), 'HF_INVALID'],
    [reply(401, { detail: 'Invalid credentials for key-id-123:key-secret-abcdef' }), 'HF_UNAUTHORIZED'],
    [reply(403, { detail: 'Insufficient credits' }), 'HF_FUNDS'],
    [reply(404, { detail: 'Model not found' }), 'HF_INVALID'],
    [reply(422, { detail: [{ loc: ['body', 'prompt'], msg: 'field required' }] }), 'HF_INVALID'],
    [reply(423, { detail: 'Model is temporarily blocked' }), 'HF_UNAVAILABLE'],
    [reply(429, { detail: 'slow down' }), 'HF_UNAVAILABLE'],
    [reply(503, { detail: 'Model is disabled' }), 'HF_UNAVAILABLE'],
    [reply(500, '<html>boom</html>'), 'HF_UNAVAILABLE'],
    [Object.assign(Error('socket hang up'), { name: 'TypeError' }), 'HF_NETWORK'],
    [Object.assign(Error('aborted'), { name: 'AbortError' }), 'HF_NETWORK'],
  ];
  for (const [answer, code] of cases) {
    const { fetcher } = scripted([answer]), client = new HiggsfieldClient({ key: KEY, fetcher });
    await assert.rejects(client.submit('image', { prompt: 'x' }), error => { assert.equal(error.code, code, error.message); assert.doesNotMatch(error.message, /key-secret-abcdef/); assert.doesNotMatch(error.message, /key-id-123/); return true; });
  }
  const { fetcher } = scripted([reply(400, { detail: 'x'.repeat(1000) })]);
  await assert.rejects(new HiggsfieldClient({ key: KEY, fetcher }).submit('image', { prompt: 'x' }), error => error.message.length < 260);
  const noId = scripted([reply(200, { status: 'queued' })]);
  await assert.rejects(new HiggsfieldClient({ key: KEY, fetcher: noId.fetcher }).submit('image', { prompt: 'x' }), error => error.code === 'HF_UNAVAILABLE');
});
