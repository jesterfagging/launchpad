// Higgsfield (api.higgsfield.ai) client for the AI influencer's media generation (Launchpad v71.30). Pure HTTP
// over an injected fetcher: no database, no files, no logging. The API key is read once into this object,
// is sent only in the Authorization header of api.higgsfield.ai requests and never appears in an error.
//
// Verified against the public documentation on 2026-10-04 (WebFetch of each page below):
// - https://docs.higgsfield.ai/docs/index.md — header `Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}`.
// - https://docs.higgsfield.ai/docs/concepts/requests.md — POST /{model} answers { status: 'queued', request_id,
//   status_url, cancel_url }; terminal states completed | failed | nsfw | canceled; POST /requests/{id}/cancel
//   (202 while every job is still queued, 400 afterwards); send an `Idempotency-Key` with every submission;
//   output URLs are kept at least seven days.
// - https://docs.higgsfield.ai/docs/api-reference/requests/get-request-status.md — GET /requests/{id}/status →
//   { status: queued|in_progress|nsfw|failed|completed|canceled, request_id, images: [{url}], video: {url},
//   audio: {url}, audios: [{url}], error }.
// - https://docs.higgsfield.ai/docs/concepts/polling.md — poll from 2 s growing to 10 s with jitter; back off on 5xx.
// - https://docs.higgsfield.ai/docs/concepts/file-uploads.md — POST /files/generate-upload-url { content_type } →
//   { public_url, upload_url, upload_headers, content_type }; PUT the bytes to upload_url with upload_headers and
//   no credentials; the upload URL lasts one hour; JPEG/PNG/WebP/GIF, WAV, MP4. Public https URLs are accepted
//   directly as image inputs.
// - https://docs.higgsfield.ai/docs/concepts/errors.md, /docs/concepts/rate-limits.md — envelope { detail }; 400 invalid
//   input or concurrency ("Maximum number of concurrent requests (4) has been reached"), 401 credentials, 403
//   insufficient credits, 404 unknown request/model, 422 validation or an Idempotency-Key reused with other
//   parameters, 423 model blocked, 503 model disabled, 5xx; no Retry-After header; failed and nsfw are not charged.
// - https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md — POST /estimate/{model} with the request body
//   → { credits, usd } (the account's authoritative price; per-model prices are not published in the docs).
// - https://docs.higgsfield.ai/docs/models/soul-2/generate — POST /higgsfield-ai/soul/v2/standard { prompt, aspect_ratio
//   (9:16|16:9|4:3|3:4|1:1|2:3|3:2, default 1:1), resolution (720p|1080p), enhance_prompt (false), seed (1–1000000),
//   batch_size (1 | 4 — there is no 3, so the character pass renders four candidates), custom_reference_id (a Soul ID
//   uuid), custom_reference_strength (0–1), style_id, style_strength } → images[].url.
// - https://docs.higgsfield.ai/docs/models/qwen-image-3/edit — POST /alibaba/qwen-image-3/edit { prompt, image_urls
//   (1–3 ordered public URLs), resolution (1k|2k), aspect_ratio (1:1|2:3|3:2|3:4|4:3|7:9|9:7|9:16|16:9|21:9), seed,
//   enable_thinking, prompt_extend, negative_prompt } → images[].url. The edit model of this release: the master
//   portrait from reference art, the turnaround sheet and consistent post pictures. Its price is not in the docs,
//   so the pipeline asks /estimate before every edit submission and refuses when the answer exceeds its ceiling.
// - https://docs.higgsfield.ai/docs/models/kling-3/turbo-image-to-video — POST /kling-video/v3.0-turbo/image-to-video
//   { prompt (≤ 2500), image_url (public https), duration (3–15, default 5), resolution (720p|1080p) } → video.url.
// - https://docs.higgsfield.ai/docs/models/soul-id/create-character.md — POST /v1/custom-references { name, input_images:
//   [{ type: 'image_url', image_url }], model_version: v1|v2|cinema } → { id, status }; GET /v1/custom-references/{id}
//   (not_ready|queued|in_progress|completed|failed); a completed id goes into Soul's custom_reference_id. Verified but
//   not used by this release (training price and duration are not published); influencers.soul_id is reserved for it.
// - https://docs.higgsfield.ai/docs/openapi.json still describes the older catalogue (soul/standard, kling 2.5) and was
//   not used; https://docs.higgsfield.ai/docs/models/image-generation lists the current image workflows.
import { AGENT_RATE_CARD_V2 } from '../../public/agent-catalog.mjs';

export const HIGGSFIELD_API = 'https://api.higgsfield.ai';
export const HIGGSFIELD_ERRORS = Object.freeze(['HF_UNAUTHORIZED', 'HF_FUNDS', 'HF_CONCURRENCY', 'HF_INVALID', 'HF_UNAVAILABLE', 'HF_NETWORK']);
const DEFAULT_TIMEOUT_MS = 30000, UPLOAD_TIMEOUT_MS = 60000, DOWNLOAD_TIMEOUT_MS = 30000;
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024, VIDEO_MAX_BYTES = 64 * 1024 * 1024;
const SOUL_ASPECTS = Object.freeze(['9:16', '16:9', '4:3', '3:4', '1:1', '2:3', '3:2']);
const QWEN_ASPECTS = Object.freeze(['1:1', '2:3', '3:2', '3:4', '4:3', '7:9', '9:7', '9:16', '16:9', '21:9']);
const clip = (value, max) => { const text = String(value ?? ''); return text.length > max ? text.slice(0, max - 1) + '…' : text; };
const clamp01 = value => { const n = Number(value); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1; };
const seedOf = value => (Number.isInteger(value) && value > 0 ? Math.min(1000000, value) : null);
const https = value => typeof value === 'string' && /^https:\/\/[^\s]+$/i.test(value) && value.length <= 2083;
const fail = (message, code, extra = {}) => { throw Object.assign(Error(message), { code, ...extra }); };

/** Model table: path = the POST path under the API base, body = request builder from camelCase params, output = the result field. */
export const HIGGSFIELD_MODELS = Object.freeze({
  // Soul 2 text-to-image: $0.0032 @720p, $0.0057 @1080p list price (rate card: imageUsd / imageHdUsd, rounded up per image).
  image: Object.freeze({ path: 'higgsfield-ai/soul/v2/standard', output: 'images', body: ({ prompt, aspectRatio = '1:1', resolution = '720p', batch = 1, seed = null, referenceId = null, referenceStrength = 1 } = {}) => ({ prompt: String(prompt ?? ''), aspect_ratio: SOUL_ASPECTS.includes(aspectRatio) ? aspectRatio : '1:1', resolution: resolution === '1080p' ? '1080p' : '720p', batch_size: Number(batch) >= 4 ? 4 : 1, enhance_prompt: false, ...(seedOf(seed) ? { seed: seedOf(seed) } : {}), ...(referenceId ? { custom_reference_id: String(referenceId), custom_reference_strength: clamp01(referenceStrength) } : {}) }) }),
  // Qwen Image 3 edit: image-to-image from one to three reference pictures and an instruction; one image per call (rate card: editUsd, or the provider’s quote when higher).
  edit: Object.freeze({ path: 'alibaba/qwen-image-3/edit', output: 'images', body: ({ prompt, imageUrl = null, imageUrls = null, aspectRatio = '1:1', seed = null } = {}) => ({ prompt: String(prompt ?? ''), image_urls: (Array.isArray(imageUrls) ? imageUrls : [imageUrl]).filter(https).slice(0, 3), resolution: '1k', aspect_ratio: QWEN_ASPECTS.includes(aspectRatio) ? aspectRatio : '1:1', ...(seedOf(seed) ? { seed: seedOf(seed) } : {}) }) }),
  // Kling 3.0 Turbo image-to-video: 5-second clips at 720p (rate card: videoSecondUsd × duration + videoOverheadUsd).
  video: Object.freeze({ path: 'kling-video/v3.0-turbo/image-to-video', output: 'video', body: ({ prompt, imageUrl, duration = 5, resolution = '720p' } = {}) => ({ prompt: clip(prompt, 2500), image_url: String(imageUrl ?? ''), duration: Math.max(3, Math.min(15, (Number(duration) | 0) || 5)), resolution: resolution === '1080p' ? '1080p' : '720p' }) }),
  // Reserved; off.
  speak: Object.freeze({ path: '', output: 'audio', body: null }),
});
/** The built-in table with an operator override (LAUNCHPAD_AGENTS_HIGGSFIELD_MODELS JSON) merged per key: only `path`, `output` and `extra` (merged into the request body) can be overridden; builders stay code. */
export function mergeModels(overrides = null) {
  const out = {};
  for (const [kind, base] of Object.entries(HIGGSFIELD_MODELS)) {
    const given = overrides && typeof overrides === 'object' && overrides[kind] && typeof overrides[kind] === 'object' && !Array.isArray(overrides[kind]) ? overrides[kind] : null;
    out[kind] = Object.freeze({ ...base, ...(given && typeof given.path === 'string' ? { path: given.path.replace(/^\/+|\/+$/g, '').slice(0, 200) } : {}), ...(given && typeof given.output === 'string' && ['images', 'video', 'audio'].includes(given.output) ? { output: given.output } : {}), ...(given && given.extra && typeof given.extra === 'object' && !Array.isArray(given.extra) ? { extra: Object.freeze({ ...given.extra }) } : {}) });
  }
  return Object.freeze(out);
}
/** Worst-case charge of one generation at the published rate card (USD micro, BigInt). */
export function estimateUsd(kind, params = {}, rateCard = AGENT_RATE_CARD_V2) {
  const card = rateCard && typeof rateCard === 'object' ? rateCard : AGENT_RATE_CARD_V2, n = key => BigInt(Math.max(0, Number(card[key] ?? AGENT_RATE_CARD_V2[key] ?? 0) | 0));
  switch (kind) {
    case 'image': return (params.resolution === '1080p' ? n('imageHdUsd') : n('imageUsd')) * (Number(params.batch) >= 4 ? 4n : 1n);
    case 'edit': return n('editUsd') || n('imageUsd');
    case 'video': return n('videoSecondUsd') * BigInt(Math.max(3, Math.min(15, (Number(params.duration) | 0) || 5))) + n('videoOverheadUsd');
    case 'check': return n('mediaCheckUsd');
    case 'speak': return n('speakUsd');
    default: return 0n;
  }
}
function mapStatus(status, detail) {
  if (status === 401) return 'HF_UNAUTHORIZED';
  if (status === 403) return 'HF_FUNDS';
  if (status === 400) return /concurrent requests/i.test(detail) ? 'HF_CONCURRENCY' : 'HF_INVALID';
  if (status === 404 || status === 422) return 'HF_INVALID';
  if (status === 423 || status === 429 || status >= 500) return 'HF_UNAVAILABLE';
  return 'HF_INVALID';
}
const usdMicro = value => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? BigInt(Math.ceil(n * 1e6)) : null; };

export class HiggsfieldClient {
  constructor({ key = '', baseUrl = HIGGSFIELD_API, fetcher = globalThis.fetch?.bind(globalThis), now = Date.now, models = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const text = String(key || '').trim(), at = text.indexOf(':');
    this.keyId = at > 0 ? text.slice(0, at) : ''; this.keySecret = at > 0 ? text.slice(at + 1) : '';
    this.baseUrl = String(baseUrl || HIGGSFIELD_API).replace(/\/+$/, ''); this.fetcher = fetcher; this.now = now; this.timeoutMs = timeoutMs;
    this.models = mergeModels(models);
  }
  available() { return !!(this.keyId && this.keySecret && typeof this.fetcher === 'function'); }
  model(kind) { return this.models[kind] || null; }
  modelAvailable(kind) { const model = this.model(kind); return !!(model && model.path && typeof model.body === 'function'); }
  /** Request body for a kind from camelCase params (what `submit` sends; exposed for the estimate call and tests). */
  body(kind, params = {}) { const model = this.model(kind); if (!this.modelAvailable(kind)) fail(`No ${kind} model is configured on this host.`, 'HF_INVALID'); return { ...model.body(params || {}), ...(model.extra || {}) }; }
  estimateUsd(kind, params = {}, rateCard = AGENT_RATE_CARD_V2) { return estimateUsd(kind, params, rateCard); }
  headers(json = true) { return { authorization: `Key ${this.keyId}:${this.keySecret}`, accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) }; }
  /** Error text never carries the credentials, whatever the provider echoed. */
  redact(text) { let out = String(text ?? ''); for (const secret of [this.keySecret, this.keyId]) if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]'); return out; }
  async request(method, url, { body, headers = null, idempotencyKey = null, timeoutMs = this.timeoutMs, auth = true } = {}) {
    if (auth && !this.available()) fail('Higgsfield is not configured on this host.', 'HF_UNAUTHORIZED');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    let response;
    try { response = await this.fetcher(url, { method, headers: { ...(auth ? this.headers(body !== undefined) : {}), ...(idempotencyKey ? { 'idempotency-key': String(idempotencyKey).slice(0, 120) } : {}), ...(headers || {}) }, ...(body !== undefined ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}), signal: controller.signal }); }
    catch (error) { fail(error?.name === 'AbortError' ? 'The media provider did not answer in time.' : 'The media provider could not be reached.', 'HF_NETWORK'); }
    finally { clearTimeout(timer); }
    const text = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!response.ok) {
      const detail = typeof json?.detail === 'string' ? json.detail : Array.isArray(json?.detail) ? json.detail.map(item => item?.msg || '').filter(Boolean).join('; ') : json?.error || text;
      fail(`Higgsfield HTTP ${response.status}: ${this.redact(clip(detail || 'no detail', 200))}`, mapStatus(response.status, String(detail || '')), { status: response.status });
    }
    return json;
  }
  /** Submits one generation. Returns { requestId, statusUrl, cancelUrl }. The Idempotency-Key makes a retry after an ambiguous timeout safe. */
  async submit(kind, params = {}, { idempotencyKey = null } = {}) {
    const model = this.model(kind); if (!this.modelAvailable(kind)) fail(`No ${kind} model is configured on this host.`, 'HF_INVALID');
    const json = await this.request('POST', `${this.baseUrl}/${model.path}`, { body: this.body(kind, params), idempotencyKey });
    if (!json || typeof json.request_id !== 'string' || !json.request_id) fail('The media provider returned no request id.', 'HF_UNAVAILABLE');
    return { requestId: json.request_id, statusUrl: https(json.status_url) ? json.status_url : `${this.baseUrl}/requests/${encodeURIComponent(json.request_id)}/status`, cancelUrl: https(json.cancel_url) ? json.cancel_url : `${this.baseUrl}/requests/${encodeURIComponent(json.request_id)}/cancel` };
  }
  validId(requestId) { if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{3,120}$/.test(requestId)) fail('Invalid media request id.', 'HF_INVALID'); return requestId; }
  /** Normalized status: { state: queued|running|completed|failed|nsfw|canceled, urls, error }. Unknown statuses keep polling. */
  async status(requestId) {
    const json = await this.request('GET', `${this.baseUrl}/requests/${encodeURIComponent(this.validId(requestId))}/status`);
    const map = { queued: 'queued', in_progress: 'running', completed: 'completed', failed: 'failed', nsfw: 'nsfw', canceled: 'canceled', cancelled: 'canceled' };
    const state = map[json?.status] || 'queued';
    const urls = [...(Array.isArray(json?.images) ? json.images.map(item => item?.url) : []), json?.video?.url, json?.audio?.url, ...(Array.isArray(json?.audios) ? json.audios.map(item => item?.url) : [])].filter(https);
    return { state, urls, error: json?.error ? this.redact(clip(json.error, 200)) : '' };
  }
  /** Best effort: true when the provider accepted the cancellation (only while queued), false when it was already running. */
  async cancel(requestId) {
    try { await this.request('POST', `${this.baseUrl}/requests/${encodeURIComponent(this.validId(requestId))}/cancel`, { body: {} }); return true; }
    catch (error) { if (error?.status === 400 || error?.status === 404) return false; throw error; }
  }
  /** Uploads bytes through a presigned URL and returns the public https URL the models accept. Credentials go to the grant request only. */
  async upload(bytes, contentType) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) fail('Nothing to upload.', 'HF_INVALID');
    if (!/^(?:image\/(?:png|jpeg|webp|gif)|video\/mp4|audio\/wav)$/.test(String(contentType))) fail('Unsupported upload type.', 'HF_INVALID');
    const grant = await this.request('POST', `${this.baseUrl}/files/generate-upload-url`, { body: { content_type: contentType } });
    if (!https(grant?.upload_url) || !https(grant?.public_url)) fail('The media provider returned no upload URL.', 'HF_UNAVAILABLE');
    const headers = { 'content-type': contentType }; for (const [key, value] of Object.entries(grant.upload_headers && typeof grant.upload_headers === 'object' ? grant.upload_headers : {})) if (typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(key)) headers[key.toLowerCase()] = value;
    await this.request('PUT', grant.upload_url, { body: bytes, headers, auth: false, timeoutMs: UPLOAD_TIMEOUT_MS });
    return grant.public_url;
  }
  /** Downloads a generated file (https only, size-capped, 30 s). No credentials are sent. */
  async download(url, { maxBytes = IMAGE_MAX_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
    if (!https(url)) fail('Media downloads must use https.', 'HF_INVALID');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    let response;
    try { response = await this.fetcher(url, { method: 'GET', signal: controller.signal }); }
    catch (error) { clearTimeout(timer); fail(error?.name === 'AbortError' ? 'The media download timed out.' : 'The media file could not be downloaded.', 'HF_NETWORK'); }
    try {
      if (!response.ok) fail(`The media download failed (HTTP ${response.status}).`, mapStatus(response.status, ''), { status: response.status });
      const declared = Number(response.headers?.get?.('content-length') || 0); if (declared > maxBytes) fail('The media file is larger than allowed.', 'HF_INVALID');
      let bytes;
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader(), chunks = []; let total = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > maxBytes) { await reader.cancel().catch(() => {}); fail('The media file is larger than allowed.', 'HF_INVALID'); } chunks.push(Buffer.from(value)); }
        bytes = Buffer.concat(chunks);
      } else { bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > maxBytes) fail('The media file is larger than allowed.', 'HF_INVALID'); }
      if (!bytes.length) fail('The media file is empty.', 'HF_INVALID');
      return { bytes, contentType: String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase() };
    } finally { clearTimeout(timer); }
  }
  /** The account's own price for a request, from the estimate endpoint: { usd (micro BigInt or null), credits }. */
  async estimate(kind, params = {}) {
    const model = this.model(kind); if (!this.modelAvailable(kind)) fail(`No ${kind} model is configured on this host.`, 'HF_INVALID');
    const json = await this.request('POST', `${this.baseUrl}/estimate/${model.path}`, { body: this.body(kind, params) });
    return { usd: usdMicro(json?.usd), credits: json?.credits === undefined || json?.credits === null ? null : String(json.credits).slice(0, 40) };
  }
}
