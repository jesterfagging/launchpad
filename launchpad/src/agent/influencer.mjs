// AI influencer (Launchpad v71.30): the character pipeline, media jobs and queued X posts of an AI Agent
// launch. The service constructs it unconditionally and calls tick() once per scheduler pass; everything
// stays inert until the influencer flag and the provider credentials are set. Rules that hold everywhere:
// the model supplies words and a picture brief, the platform picks the account, the link, the files and
// the moment; every provider call is reserved from the agent's operating credit first and settled once;
// every candidate picture is checked (consistency, no minors, no real people, no nsfw) before it is kept;
// uncertainty about a cap, a file, an account or a budget means nothing is generated and nothing is posted.
// Provider keys live in the service config only; rows, views and events carry public-safe sentences.
import { createHash, randomInt } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, existsSync, statSync, readFileSync, copyFileSync, unlinkSync, readdirSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { atomicWrite } from '../telegram-store.mjs';
import { influencerPrompt, validatePostText, describeTiles, featureClipPlan, featureClipCostUsd, INFLUENCER_LIMITS, INFLUENCER_STATE_LABELS, INFLUENCER_MEDIA_MODES, INFLUENCER_RULES, POST_STATE_LABELS } from '../../public/influencer-catalog.mjs';
import { AGENT_POLICY_V1, AGENT_RATE_CARD_V2 } from '../../public/agent-catalog.mjs';
import { HiggsfieldClient, estimateUsd, IMAGE_MAX_BYTES, VIDEO_MAX_BYTES } from './higgsfield.mjs';
import { MEDIA_JOB_OPEN_STATES, POST_OPEN_STATES } from './store.mjs';
import { chatCompletion } from './openrouter.mjs';
import { dayKey, dailyBudgetUsd } from './policy.mjs';

const fail = (message, statusCode = 400, code = 'INFLUENCER') => { throw Object.assign(Error(message), { statusCode, code }); };
const toolFail = message => { throw Object.assign(Error(message), { code: 'AGENT_TOOL' }); };
const clip = (value, max) => { const text = String(value ?? ''); return text.length > max ? text.slice(0, max - 1) + '…' : text; };
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const HOUR = 3600000, DAY = 86400000;
export const SCORE_MIN = 70, MASTER_BATCH = 4, POST_TTL_MS = 6 * HOUR, JOB_TTL_MS = 20 * 60000, JOB_MAX_AGE_MS = 90 * 60000, MAX_POLLS = 6, MAX_DELIVERIES = 3, MAX_ACTIVATIONS = 3, MAX_RETRY_MS = 15 * 60000, MAX_ATTEMPTS = 6;
const FILE_NAME = /^(?:master|sheet|reference|[a-f0-9]{24})\.(?:png|jpg|webp|mp4)$/, TEMP_NAME = /^tmp-[a-f0-9]{24}-(?:\d|f\d|s\d|list)\.(?:png|jpg|webp|mp4|txt)$/, REFERENCE_ID = /^[a-f0-9]{64}\.(png|jpg|webp)$/;
const TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4' });
// Public-safe sentences: the only text that reaches rows, views and events.
export const INFLUENCER_TEXT = Object.freeze({
  unavailable: 'The AI influencer option is not available right now.', nsfw: 'The character was refused by the image provider’s safety filter.', refused: 'The picture was refused: it looked like a real person, a minor or unsafe content.', lowScore: 'No candidate picture matched the character closely enough.', postLowScore: 'picture did not match the character; posted as text', providerFailed: 'The media provider could not complete the generation.', canceled: 'The generation was cancelled.', noOutput: 'The media provider returned no file.', expired: 'The generation took too long and was abandoned.', postExpired: 'The post expired before it could be delivered.', mediaUnavailable: 'Media generation is not available on this host right now.', checkUnconfigured: 'The consistency check is not configured on this host.', checkFailed: 'The consistency check could not be completed.', credit: 'Not enough operating credit for this generation.', budget: 'Today’s operating budget is used up.', referenceGuide: 'Reference art is used as a guide only on this host.', revoked: 'X revoked the connection. Reconnect the account from the coin page.', noAccount: 'No X account is connected.', duplicate: 'X refused the post as a duplicate.', rejected: 'X rejected the post.', xFailed: 'X could not be reached; the post was abandoned.', dryRun: '[dry run] not sent', agentGone: 'The agent was archived.', price: 'The media provider’s price for this request exceeds the published rate card; the generation was refused.',
  featureUnavailable: 'The daily feature clip is not available right now.', featureJoinFailed: 'The feature clip could not be assembled on this host.', providerAuth: 'The media provider refused this host’s credentials.', providerFunds: 'The media provider account is out of credit.', providerBusy: 'The media provider is busy.', providerInvalid: 'The media provider rejected the request.', providerDown: 'The media provider is temporarily unavailable.',
});
const PROVIDER_TEXT = Object.freeze({ HF_UNAUTHORIZED: INFLUENCER_TEXT.providerAuth, HF_FUNDS: INFLUENCER_TEXT.providerFunds, HF_CONCURRENCY: INFLUENCER_TEXT.providerBusy, HF_INVALID: INFLUENCER_TEXT.providerInvalid, HF_UNAVAILABLE: INFLUENCER_TEXT.providerDown, HF_NETWORK: INFLUENCER_TEXT.providerDown });
const TRANSIENT = new Set(['HF_CONCURRENCY', 'HF_UNAVAILABLE', 'HF_NETWORK']);
const CHECK_PROMPT = 'Image A is the character\'s master portrait, image B a new picture. Answer with JSON only: {"sameCharacter": 0-100, "appearsMinor": bool, "realPersonLikeness": bool, "nsfw": bool, "hasText": bool}.';

// ---- small pure helpers --------------------------------------------------------------------------
function crc32(bytes) { let crc = 0xffffffff; for (let i = 0; i < bytes.length; i++) { let c = (crc ^ bytes[i]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed)); return Buffer.concat([length, typed, crc]); }
/** A valid 256×256 RGB PNG in one solid colour derived from the seed text (dry-run placeholder media). */
export function placeholderPng(seed = '') {
  const hash = createHash('sha256').update(String(seed)).digest(), [r, g, b] = [hash[0], hash[1], hash[2]], size = 256;
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  const row = Buffer.alloc(1 + size * 3); for (let x = 0; x < size; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
/** Magic-byte inspection of PNG, JPEG and WebP bytes (like src/launchpad-media.mjs inspectLaunchImage); null when it is none of them. */
export function inspectImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24) return null;
  let ext = null, width = 0, height = 0;
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) { if (bytes.length < 57 || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') return null; ext = 'png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
    ext = 'jpg'; let at = 2;
    while (at + 4 <= bytes.length) { if (bytes[at++] !== 255) return null; while (bytes[at] === 255) at++; const marker = bytes[at++]; if (marker === 218 || marker === 217) break; if (marker === 1 || (marker >= 208 && marker <= 215)) continue; const size = bytes.readUInt16BE(at); if (size < 2 || at + size > bytes.length) return null; if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) { if (size < 8) return null; height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); break; } at += size; }
  } else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) return null; ext = 'webp'; const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X' && bytes.length >= 30) { width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1; }
    else if (kind === 'VP8 ' && bytes.length >= 30 && bytes.toString('hex', 23, 26) === '9d012a') { width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383; }
    else if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 47) { const value = bytes.readUInt32LE(21); width = (value & 16383) + 1; height = ((value >>> 14) & 16383) + 1; }
  }
  if (!ext || !(width > 0 && height > 0 && width <= 8192 && height <= 8192)) return null;
  return { ext, type: TYPES[ext], width, height };
}
const isMp4 = bytes => Buffer.isBuffer(bytes) && bytes.length > 64 && bytes.toString('ascii', 4, 8) === 'ftyp';
const extOf = name => String(name).split('.').pop();
/** Defensive parse of the vision verdict: the first flat JSON object in the reply. */
export function parseCheck(reply) {
  const text = String(reply ?? ''); let json = null;
  for (const pattern of [/\{[^{}]*\}/, /\{[\s\S]*\}/]) { const match = pattern.exec(text); if (!match) continue; try { json = JSON.parse(match[0]); break; } catch { json = null; } }
  if (!plainObject(json)) return null;
  const score = Number(json.sameCharacter), bool = value => value === true || value === 'true' || value === 1;
  return { sameCharacter: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0, appearsMinor: bool(json.appearsMinor), realPersonLikeness: bool(json.realPersonLikeness), nsfw: bool(json.nsfw), hasText: bool(json.hasText) };
}
const sanitizeBrief = value => clip(String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/(?:https?:\/\/|www\.)\S+/gi, '').replace(/\s+/g, ' ').trim(), INFLUENCER_LIMITS.briefChars);
const pollDelay = attempts => Math.min(10000, Math.round(2000 * 1.5 ** Math.min(attempts, 6))) + randomInt(0, 500);
const retryDelay = attempts => Math.min(MAX_RETRY_MS, 30000 * 2 ** Math.min(attempts, 5)) + randomInt(0, 5000);
const dirName = id => (/^[A-Za-z0-9_-]{1,64}$/.test(String(id)) ? String(id) : createHash('sha256').update(String(id)).digest('hex').slice(0, 32));

export class InfluencerService {
  constructor({ service, higgsfield = null, vision = null, now = null, fetcher = null, ffmpeg = undefined } = {}) { this.service = service; this.higgsfield = higgsfield; this.vision = vision; this.fetcher = fetcher; this.now = now || (() => service.now()); this.closed = false; this.passes = 0; this.ffmpegState = ffmpeg === undefined ? null : { ok: !!ffmpeg, at: Infinity, tool: typeof ffmpeg === 'function' ? ffmpeg : null }; }
  get config() { return this.service?.config || {}; }
  get dryRun() { return !!this.config.dryRun; }
  get rateCard() { return this.config.rateCard && typeof this.config.rateCard === 'object' && this.config.rateCard.xPostUsd !== undefined ? this.config.rateCard : AGENT_RATE_CARD_V2; }
  card(key) { return BigInt(Math.max(0, Number(this.rateCard[key] ?? AGENT_RATE_CARD_V2[key] ?? 0) | 0)); }
  available() { try { return !!this.service?.effective?.().influencerOpen; } catch { return false; } }
  effective() { try { return this.service.effective(); } catch { return {}; } }
  /** The Higgsfield client, built from the config on first use (tests inject a fake). */
  hf() { if (!this.higgsfield) this.higgsfield = new HiggsfieldClient({ key: this.config.higgsfieldKey || '', baseUrl: this.config.higgsfieldUrl || undefined, models: this.config.higgsfieldModels || null, now: this.now, ...(this.fetcher ? { fetcher: this.fetcher } : {}) }); return this.higgsfield; }
  editAvailable() { try { return this.hf().modelAvailable('edit'); } catch { return false; } }
  // ---- ffmpeg (joins the segments of a 30-second feature clip; probed once, re-probed every 10 minutes while absent) -------
  ffmpegReady() { return !!this.ffmpegState?.ok; }
  async probeFfmpeg() {
    if (this.ffmpegState?.tool || (this.ffmpegState && (this.ffmpegState.ok || this.now() - this.ffmpegState.at < 600000))) return this.ffmpegReady();
    const ok = await new Promise(resolve => { try { const child = execFile(this.config.ffmpegPath || 'ffmpeg', ['-version'], { timeout: 8000 }, error => resolve(!error)); child.on?.('error', () => resolve(false)); } catch { resolve(false); } });
    this.ffmpegState = { ok, at: this.now(), tool: null }; return ok;
  }
  /** Runs ffmpeg with the given arguments (tests inject a tool). Rejects with code FFMPEG on any failure. */
  ffmpeg(args, { timeout = 240000 } = {}) {
    if (this.ffmpegState?.tool) return this.ffmpegState.tool(args);
    return new Promise((resolve, reject) => { try { execFile(this.config.ffmpegPath || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { timeout, maxBuffer: 1 << 20 }, error => error ? reject(Object.assign(Error(INFLUENCER_TEXT.featureJoinFailed), { code: 'FFMPEG' })) : resolve()); } catch { reject(Object.assign(Error(INFLUENCER_TEXT.featureJoinFailed), { code: 'FFMPEG' })); } });
  }
  /** The feature clip lengths this host can make: the catalogue's, minus the joined ones when ffmpeg is absent. */
  featureClipLengths() { return INFLUENCER_LIMITS.featureClipSeconds.filter(seconds => !featureClipPlan(seconds)?.joined || this.ffmpegReady()); }
  featureClipCosts() { return Object.fromEntries(INFLUENCER_LIMITS.featureClipSeconds.map(seconds => [seconds, featureClipCostUsd(seconds, this.rateCard).toString()])); }
  /** The daily budget allowance an agent gets for its feature clip (0n without one): the clip's rate-card cost, so the policy cap does not refuse it. */
  dailyAllowanceUsd(agent) { try { const inf = agent?.id ? this.service.store().influencer(agent.id) : null, seconds = Number(inf?.spec?.featureClipSeconds) || 0; return seconds && inf.state !== 'disabled' ? BigInt(featureClipCostUsd(seconds, this.rateCard)) : 0n; } catch { return 0n; } }
  // ---- files -----------------------------------------------------------------------------------------
  mediaDir() { const configured = typeof this.config.mediaDir === 'string' && this.config.mediaDir ? this.config.mediaDir : null; const base = this.service?.accounts?.dir; if (!configured && typeof base !== 'string') fail('Media storage is not configured.', 503); return configured || join(base, 'influencer'); }
  agentDir(agentId, create = true) { if (!/^[a-f0-9]{24}$/.test(String(agentId))) fail('Invalid agent id.', 404); const dir = join(this.mediaDir(), agentId); if (create) mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
  uploadsDir(accountId, create = true) { const dir = join(this.mediaDir(), 'uploads', dirName(accountId)); if (create) mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
  /** Absolute path of a public media file of an agent (null for anything but the fixed names). */
  mediaPath(agentId, file) { if (!/^[a-f0-9]{24}$/.test(String(agentId)) || !FILE_NAME.test(String(file)) || String(file).startsWith('reference.')) return null; try { const path = join(this.agentDir(agentId, false), file); return existsSync(path) && statSync(path).isFile() ? path : null; } catch { return null; } }
  readFile(agentId, name) { if (!FILE_NAME.test(String(name)) && !TEMP_NAME.test(String(name))) return null; try { return readFileSync(join(this.agentDir(agentId, false), name)); } catch { return null; } }
  async writeFile(agentId, name, bytes) { await atomicWrite(join(this.agentDir(agentId), name), bytes); return name; }
  removeFile(agentId, name) { if (!name || (!FILE_NAME.test(String(name)) && !TEMP_NAME.test(String(name)))) return; try { unlinkSync(join(this.agentDir(agentId, false), name)); } catch { /* Already gone. */ } }
  mediaUrl(agentId, file) { return file && FILE_NAME.test(file) && !String(file).startsWith('reference.') ? `/influencer-media/${agentId}/${file}` : null; }
  /** Stores a creator's reference upload (base64 PNG/JPEG/WebP ≤ INFLUENCER_LIMITS.referenceBytes) and returns its id. */
  async storeReference(accountId, data) {
    if (!accountId) fail('Sign in first.', 401);
    const max = INFLUENCER_LIMITS.referenceBytes;
    if (typeof data !== 'string' || data.length > Math.ceil(max / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail('Choose a PNG, JPEG or WebP image of at most 1.5 MB.');
    const bytes = Buffer.from(data, 'base64'); if (!bytes.length || bytes.length > max) fail('Choose a PNG, JPEG or WebP image of at most 1.5 MB.');
    const image = inspectImage(bytes); if (!image || image.width < 256 || image.height < 256) fail('Choose a PNG, JPEG or WebP image of at least 256 × 256 pixels.');
    const dir = this.uploadsDir(accountId); let pending = 0; try { pending = readdirSync(dir).length; } catch { pending = 0; }
    if (pending >= 20) fail('Too many pending reference uploads. Launch with one of them first.', 429);
    const referenceId = createHash('sha256').update(bytes).digest('hex') + '.' + image.ext;
    await atomicWrite(join(dir, referenceId), bytes);
    return { referenceId, bytes: bytes.length, type: image.type, width: image.width, height: image.height };
  }
  // ---- launch integration --------------------------------------------------------------------------------
  /** Validates a normalized influencer request against this host before an agent is provisioned (400 when the option is not open). */
  validate(request, effective = this.effective()) {
    if (!request) return null;
    if (!plainObject(request)) fail(INFLUENCER_TEXT.unavailable);
    if (!effective.influencerOpen || (request.postToX && !effective.xOpen) || (request.character && !effective.mediaOpen)) fail(INFLUENCER_TEXT.unavailable);
    if (!request.postToX && !request.character) fail(INFLUENCER_TEXT.unavailable);
    if (request.character && request.source === 'reference' && !REFERENCE_ID.test(String(request.referenceId || ''))) fail('Upload the reference image first.');
    if (request.featureClipSeconds && !this.featureClipLengths().includes(Number(request.featureClipSeconds))) fail(`A ${request.featureClipSeconds}-second feature clip is not available on this host; choose ${this.featureClipLengths().join(' or ') || 'off'}.`);
    return request;
  }
  /** The attachment fields of an agent's influencer (null when it has none). */
  attachmentOf(agent) { try { const inf = this.service.store().influencer(agent.id); if (!inf) return null; const spec = inf.spec || {}; return { postToX: !!spec.postToX, character: !!spec.character, media: spec.media || 'text' }; } catch { return null; } }
  /** Attaches the influencer record to a freshly provisioned agent (AgentService.launchTarget, inside its lock). */
  async attach(agent, request, { accountId } = {}) {
    const store = this.service.store(), spec = this.validate(request); if (!spec) return null;
    if (store.influencer(agent.id)) return this.attachmentOf(agent);
    let referenceFile = '';
    if (spec.character && spec.source === 'reference') {
      const source = join(this.uploadsDir(accountId, false), spec.referenceId);
      if (!existsSync(source)) fail('Upload the reference image again.');
      referenceFile = 'reference.' + extOf(spec.referenceId); copyFileSync(source, join(this.agentDir(agent.id), referenceFile));
    }
    if (spec.postToX) await this.service.xAccounts.claimForAgent({ xAccountId: spec.xAccountId, accountId, agentId: agent.id });
    const prompt = spec.character ? influencerPrompt(spec.tiles, { name: agent.name, symbol: agent.symbol }) : '';
    store.createInfluencer(agent.id, { spec: { ...spec, name: agent.name, symbol: agent.symbol, seed: randomInt(1, 1000000) }, prompt, state: 'pending' });
    if (referenceFile) store.updateInfluencer(agent.id, { referenceFile });
    return this.attachmentOf(agent);
  }
  /** Archived draft or failed launch: the X account is freed, open work refunded and the record disabled. */
  async release(agentId, reason = INFLUENCER_TEXT.agentGone) {
    const store = this.service.store(), inf = store.influencer(agentId); if (!inf) return;
    try { await this.service.xAccounts?.release?.(agentId); } catch { /* The account row keeps its agent until X's layer frees it. */ }
    this.abandonOpenWork(store, agentId, reason);
    if (inf.state !== 'disabled') store.updateInfluencer(agentId, { state: 'disabled', stateReason: reason });
  }
  /** Fails every open post and job of an agent with one reason; a submitted generation is charged (the provider may have finished it) and cancelled best effort. */
  abandonOpenWork(store, agentId, reason) {
    const now = this.now();
    for (const post of store.xPosts(agentId, { limit: 100, states: [...POST_OPEN_STATES] })) this.finishPost(store, post, 'failed', reason, now);
    for (const job of store.mediaJobs(agentId, { limit: 100 })) {
      if (!MEDIA_JOB_OPEN_STATES.includes(job.state)) continue;
      if (job.state === 'submitted' && job.providerRequestId && !this.dryRun) this.hf().cancel(job.providerRequestId).catch(() => {});
      this.closeJob(store, job, 'failed', reason, job.state === 'queued' ? 0n : this.stageCharge(job.request), now);
    }
  }
  // ---- scheduler ---------------------------------------------------------------------------------------
  async tick() {
    const service = this.service; if (this.closed || !service?.available?.()) return;
    let store; try { store = service.store(); } catch { return; }
    const effective = service.effective(), now = this.now(); this.passes++;
    await this.probeFfmpeg();
    await this.expireJobs(store, now); this.expirePosts(store, now);
    if (effective.influencerOpen && !store.openAlerts().some(alert => alert.scope === 'global' && alert.code === 'ledger')) {
      await this.activate(store, effective, now); if (this.closed) return;
      await this.advanceJobs(store, effective, now); if (this.closed) return;
      await this.advancePosts(store, effective, now);
    }
    this.housekeeping(store, now);
  }
  async close() { this.closed = true; }
  event(agent, { kind, title, body = '', data = {}, isPublic = true, runId = null }) { const store = this.service.store(); store.addEvent({ agentId: agent.id, runId, kind, title: (this.dryRun ? '[dry run] ' : '') + title, body, data, isPublic }); if (isPublic) this.service.emit?.(agent.id, { kind, title }); }
  /** pending → generating (character) or ready (X only) once the coin is live; generating without an open master job starts one. */
  async activate(store, effective, now) {
    let started = 0;
    for (const inf of store.influencers({ states: ['pending', 'generating'] })) {
      if (started >= MAX_ACTIVATIONS || this.closed) break;
      const agent = store.agent(inf.agentId);
      if (!agent || agent.archived) { await this.release(inf.agentId); continue; }
      if (agent.launchState !== 'live') continue;
      const spec = inf.spec || {};
      if (inf.state === 'pending' && !spec.character) { store.updateInfluencer(agent.id, { state: this.xRevoked(agent, inf) ? 'paused' : 'ready', stateReason: this.xRevoked(agent, inf) ? INFLUENCER_TEXT.noAccount : '' }); this.event(agent, { kind: 'influencer', title: 'Influencer ready', body: 'Posts to X start with the next eligible run, within the creator’s caps.' }); continue; }
      if (!effective.mediaOpen) { if (inf.stateReason !== INFLUENCER_TEXT.mediaUnavailable) store.updateInfluencer(agent.id, { stateReason: INFLUENCER_TEXT.mediaUnavailable }); continue; }
      const masters = store.mediaJobs(agent.id, { limit: 20, kinds: ['master'] });
      if (masters.some(job => MEDIA_JOB_OPEN_STATES.includes(job.state))) continue;
      started++;
      // A round is counted when it starts (here, or by a creator regenerate); a round interrupted by a crash or a credit shortage continues where it stopped.
      if (inf.state === 'pending') store.updateInfluencer(agent.id, { state: 'generating', stateReason: '', generations: (inf.generations || 0) + 1 });
      const fresh = store.influencer(agent.id), latest = masters.find(job => job.request?.round === fresh.generations) || null;
      if (!latest) await this.startMaster(store, agent, fresh, now, { attempt: 1 });
      else if ((Number(latest.request?.attempt) || 1) < 2 && latest.error !== INFLUENCER_TEXT.refused && latest.error !== INFLUENCER_TEXT.nsfw && latest.error !== INFLUENCER_TEXT.checkUnconfigured) await this.startMaster(store, agent, fresh, now, { attempt: (Number(latest.request?.attempt) || 1) + 1 });
      else { store.updateInfluencer(agent.id, { state: 'failed', stateReason: latest.error || INFLUENCER_TEXT.lowScore }); this.event(agent, { kind: 'character', title: 'Character failed', body: latest.error || INFLUENCER_TEXT.lowScore }); }
    }
  }
  xRevoked(agent, inf) { const spec = inf.spec || {}; if (!spec.postToX) return false; const account = this.service.xAccounts?.forAgent?.(agent.id); return !account || account.state !== 'connected'; }
  /** The character pass: four Soul 2 candidates at 1080p from the tiles prompt, or one edit from the creator's reference art when the edit model is available. */
  async startMaster(store, agent, inf, now, { attempt = 1 } = {}) {
    const spec = inf.spec || {}, useEdit = spec.source === 'reference' && !!inf.referenceFile && this.editAvailable();
    if (spec.source === 'reference' && !useEdit && inf.stateReason !== INFLUENCER_TEXT.referenceGuide) store.updateInfluencer(agent.id, { stateReason: INFLUENCER_TEXT.referenceGuide });
    const model = useEdit ? 'edit' : 'image';
    const params = useEdit ? { prompt: this.referencePrompt(inf), aspectRatio: '1:1' } : { prompt: inf.prompt, aspectRatio: '1:1', resolution: INFLUENCER_LIMITS.imageResolution, batch: MASTER_BATCH, seed: randomInt(1, 1000000) };
    const batch = useEdit ? 1 : MASTER_BATCH, reserve = this.estimate(model, params) + this.card('mediaCheckUsd') * BigInt(batch);
    const created = this.createJob(store, agent, { kind: 'master', model, params, uploads: useEdit ? [inf.referenceFile] : [], batch, reserve, attempt, round: inf.generations || 0, now });
    if (!created.job) { store.updateInfluencer(agent.id, { stateReason: created.reason }); return null; }
    return created.job;
  }
  referencePrompt(inf) { const spec = inf.spec || {}; return `Studio portrait of the exact same original fictional adult character as in the reference art: same face, hair, outfit and colours, centred, looking at the camera, clean background, consistent rendering style${spec.name ? `, the face of the coin ${clip(spec.name, 40)}` : ''}. Not a real person, not a celebrity, not a child; no text, logos, watermarks or captions.`; }
  estimate(model, params) { return estimateUsd(model, params, this.rateCard); }
  /** What a finished generation stage costs the agent: the rate card, or the provider's own quote for that request (rounded up to a cent) when higher. Never above what was reserved for the stage (the quote was checked against it before submission). */
  stageCharge(request) { const card = this.estimate(request?.model, request?.params || {}); let quoted = 0n; try { quoted = BigInt(request?.quotedUsd || '0'); } catch { quoted = 0n; } if (quoted <= 0n) return card; const cents = (quoted + 9999n) / 10000n * 10000n; return cents > card ? cents : card; }
  /** The part of a job's reservation that belongs to the generation stage being submitted: the whole reservation minus the checks of a picture stage and minus what earlier stages already cost. */
  stageReserve(job) { const request = job.request || {}; let reserve = 0n, spentSoFar = 0n; try { reserve = BigInt(request.reserve || '0'); spentSoFar = BigInt(request.spentSoFar || '0'); } catch { return 0n; } const checks = job.stage === 'video' ? 0n : this.card('mediaCheckUsd') * BigInt(Math.max(1, Math.min(MASTER_BATCH, Number(request.batch) || 1))); const left = reserve - spentSoFar - checks; return left > 0n ? left : 0n; }
  /** Daily budget bookkeeping, as the runner keeps it: the first touch of a UTC day fixes the budget and resets the spend. */
  dayBudget(store, agent, now) {
    const today = dayKey(now);
    if (agent.dayKey !== today) { const backed = BigInt(store.agentBalances(agent.id).usd.backed), budget = this.dryRun ? BigInt(AGENT_POLICY_V1.budget.agentDailyCapUsd) + this.dailyAllowanceUsd(agent) : dailyBudgetUsd(backed, AGENT_POLICY_V1, this.dailyAllowanceUsd(agent)); store.updateAgent(agent.id, { dayKey: today, dayBudgetUsd: budget.toString(), daySpentUsd: '0' }); return { dayBudget: budget, daySpent: 0n }; }
    return { dayBudget: BigInt(agent.dayBudgetUsd || '0'), daySpent: BigInt(agent.daySpentUsd || '0') };
  }
  chargeDay(store, agentId, amount) { if (amount <= 0n) return; const agent = store.agent(agentId); if (agent) store.updateAgent(agentId, { daySpentUsd: (BigInt(agent.daySpentUsd || '0') + amount).toString() }); }
  refundDay(store, agentId, refund) { if (refund <= 0n) return; const agent = store.agent(agentId); if (!agent) return; const spent = BigInt(agent.daySpentUsd || '0'); store.updateAgent(agentId, { daySpentUsd: (spent > refund ? spent - refund : 0n).toString() }); }
  /** Creates and reserves a media job (nothing is reserved in dry run). Returns { job } or { job: null, reason } when credit or budget is short. */
  createJob(store, agent, { kind, model, params, uploads = [], batch = 1, reserve, attempt = 1, round = 0, runId = null, postId = null, brief = '', now }) {
    const amount = this.dryRun ? 0n : reserve;
    if (!this.dryRun) {
      const backed = BigInt(store.agentBalances(agent.id).usd.backed); if (backed < amount) return { job: null, reason: INFLUENCER_TEXT.credit };
      const { dayBudget, daySpent } = this.dayBudget(store, store.agent(agent.id), now); if (daySpent + amount > dayBudget) return { job: null, reason: INFLUENCER_TEXT.budget };
    }
    const path = this.dryRun ? 'dry-run' : this.hf().model(model)?.path || model;
    const job = store.transaction(() => {
      const row = store.createMediaJob({ agentId: agent.id, runId, postId, kind, stage: model, provider: this.dryRun ? 'dry-run' : 'higgsfield', model: path, request: { model, params, uploads, batch, attempt, round, brief, reserve: reserve.toString() }, state: 'queued' });
      store.reserveMedia(row.id, amount.toString()); this.chargeDay(store, agent.id, amount);
      return store.mediaJob(row.id);
    });
    if (runId && !this.dryRun) { try { store.recordUsage({ runId, agentId: agent.id, provider: 'higgsfield', requestId: 'media:' + job.id, kind: kind === 'video' ? 'video' : 'image', model: path, estimatedUsd: amount.toString(), state: 'estimated' }); } catch { /* Usage rows are informational. */ } }
    return { job };
  }
  // ---- media jobs ------------------------------------------------------------------------------------------
  async advanceJobs(store, effective, now) {
    const concurrency = Math.max(1, Math.min(4, Number(this.config.mediaConcurrency) || 2));
    let inFlight = store.allOpenMediaJobs().filter(job => job.state === 'submitted').length, polls = 0;
    for (const first of store.openMediaJobs(40)) {
      if (this.closed) return;
      let job = first;
      for (let step = 0; step < 3 && job && MEDIA_JOB_OPEN_STATES.includes(job.state) && job.nextCheckAt <= now; step++) {
        const agent = store.agent(job.agentId); if (!agent) { this.closeJob(store, job, 'failed', INFLUENCER_TEXT.agentGone, 0n, now); break; }
        const before = job.state + ':' + job.stage;
        try {
          if (job.state === 'queued') { if (inFlight >= concurrency) break; await this.submitJob(store, agent, job, now); if (!this.dryRun) inFlight++; }
          else if (job.state === 'submitted') { if (polls >= MAX_POLLS) break; polls++; await this.pollJob(store, agent, job, now); }
          else if (job.state === 'downloaded' || job.state === 'checking') await this.checkJob(store, agent, job, now);
        } catch (error) { await this.jobError(store, agent, job, error, now); break; }
        job = store.mediaJob(job.id);
        if (!job || job.state === 'submitted' || before === job.state + ':' + job.stage) break;
      }
    }
  }
  async submitJob(store, agent, job, now) {
    const request = job.request || {}, model = request.model, params = { ...(request.params || {}) };
    if (this.dryRun) {
      // No provider: a labelled placeholder stands in for every picture; a clip stage keeps its checked poster as the media file.
      if (job.stage === 'video') return this.finishVideo(store, agent, job, request.poster || '', now);
      const files = [];
      for (let index = 0; index < Math.max(1, Math.min(MASTER_BATCH, Number(request.batch) || 1)); index++) files.push(await this.writeFile(agent.id, `tmp-${job.id}-${index}.png`, placeholderPng(`${params.prompt}:${job.id}:${index}`)));
      store.updateMediaJob(job.id, { state: 'downloaded', attempts: job.attempts + 1, request: { ...request, files, submittedAt: now } });
      return;
    }
    const hf = this.hf(); if (!hf.available() || !hf.modelAvailable(model)) throw Object.assign(Error('No media model is configured.'), { code: 'HF_INVALID' });
    if (Array.isArray(request.uploads) && request.uploads.length) {
      params.imageUrls = [];
      for (const name of request.uploads.slice(0, 3)) { const bytes = this.readFile(agent.id, name); if (!bytes) throw Object.assign(Error('A source picture is missing.'), { code: 'HF_INVALID' }); params.imageUrls.push(await hf.upload(bytes, TYPES[extOf(name)] || 'image/png')); }
      if (model === 'video') params.imageUrl = params.imageUrls[0];
    }
    // Every generation is quoted by the provider first (its own price for this exact request). A quote above the amount
    // reserved for this stage is refused before anything is submitted, so the agent is never charged less than the
    // provider charges the operator; the quote is kept and settled when the generation succeeds (stageCharge).
    let quotedUsd = '';
    if (typeof hf.estimate === 'function') {
      let quoted = null; try { quoted = (await hf.estimate(model, params))?.usd ?? null; } catch { quoted = null; }
      if (quoted !== null && quoted !== undefined) {
        const quote = BigInt(quoted), reserve = this.stageReserve(job);
        if (quote > reserve) { store.raiseAlert({ scope: 'provider', code: 'media-price', message: `Higgsfield quotes ${(Number(quote) / 1e6).toFixed(4)} USD for a ${model} generation; the rate card reserves ${(Number(reserve) / 1e6).toFixed(4)} USD. Raise the rate card (LAUNCHPAD_AGENTS_RATE_CARD) or change the model table; such generations are refused.` }); throw Object.assign(Error(INFLUENCER_TEXT.price), { code: 'HF_PRICE' }); }
        quotedUsd = quote.toString();
      }
    }
    const { requestId } = await hf.submit(model, params, { idempotencyKey: `media:${job.id}:${job.stage}:${job.attempts + 1}` });
    store.updateMediaJob(job.id, { state: 'submitted', providerRequestId: requestId, attempts: job.attempts + 1, nextCheckAt: now + 3000, request: { ...request, submittedAt: now, quotedUsd } });
  }
  async pollJob(store, agent, job, now) {
    const request = job.request || {}, status = await this.hf().status(job.providerRequestId);
    if (status.state === 'queued' || status.state === 'running') { store.updateMediaJob(job.id, { attempts: job.attempts + 1, nextCheckAt: now + pollDelay(job.attempts) }); return; }
    if (status.state === 'nsfw') return this.failJob(store, agent, job, INFLUENCER_TEXT.nsfw, 0n, now, { refused: true });
    if (status.state !== 'completed') return this.failJob(store, agent, job, status.state === 'canceled' ? INFLUENCER_TEXT.canceled : INFLUENCER_TEXT.providerFailed, 0n, now, { retry: true });
    const urls = status.urls.slice(0, job.stage === 'video' ? 1 : Math.max(1, Math.min(MASTER_BATCH, Number(request.batch) || 1)));
    if (!urls.length) return this.failJob(store, agent, job, INFLUENCER_TEXT.noOutput, 0n, now, { retry: true });
    const files = [];
    for (const [index, url] of urls.entries()) {
      const { bytes } = await this.hf().download(url, { maxBytes: job.stage === 'video' ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES });
      if (job.stage === 'video') { if (!isMp4(bytes)) throw Object.assign(Error('The clip is not an MP4 file.'), { code: 'HF_INVALID', charged: true }); files.push(await this.writeFile(agent.id, request.feature ? `tmp-${job.id}-s${Number(request.segmentIndex) || 0}.mp4` : `${job.postId}.mp4`, bytes)); }
      else { const image = inspectImage(bytes); if (!image) throw Object.assign(Error('The picture is not a PNG, JPEG or WebP file.'), { code: 'HF_INVALID', charged: true }); files.push(await this.writeFile(agent.id, `tmp-${job.id}-${index}.${image.ext}`, bytes)); }
    }
    if (job.stage === 'video') return this.finishVideo(store, agent, job, files[0], now);
    store.updateMediaJob(job.id, { state: 'downloaded', sourceUrl: clip(urls[0], 500), request: { ...request, files } });
  }
  /** Every candidate goes through the vision check; the best one at or above SCORE_MIN is kept, the rest deleted. */
  async checkJob(store, agent, job, now) {
    const request = job.request || {}, files = Array.isArray(request.files) ? request.files.filter(name => TEMP_NAME.test(name)) : [];
    if (job.stage === 'video') return this.finishVideo(store, agent, job, request.poster || '', now);
    if (!files.length) return this.failJob(store, agent, job, INFLUENCER_TEXT.noOutput, 0n, now, { retry: true });
    store.updateMediaJob(job.id, { state: 'checking' });
    const inf = store.influencer(agent.id) || {}, master = job.kind !== 'master' && inf.masterFile ? this.readFile(agent.id, inf.masterFile) : null, reference = job.kind === 'master' && inf.referenceFile ? this.readFile(agent.id, inf.referenceFile) : null;
    const results = [];
    for (const file of files) {
      const bytes = this.readFile(agent.id, file); if (!bytes) { results.push({ file, score: 0, skipped: true }); continue; }
      const verdict = await this.runCheck({ master, reference, candidate: bytes, prompt: inf.prompt || '', kind: job.kind });
      store.createMediaJob({ agentId: agent.id, runId: job.runId, postId: job.postId, kind: 'check', stage: job.kind, provider: this.dryRun ? 'dry-run' : 'openrouter', model: this.dryRun ? 'dry-run' : this.config.visionModel || 'openai/gpt-5-mini', request: { parent: job.id, file, verdict: verdict.flags }, state: verdict.error ? 'failed' : 'succeeded' });
      if (verdict.blocked) this.removeFile(agent.id, file);
      results.push({ file, ...verdict });
    }
    const checks = results.filter(result => !result.skipped).length, imageCost = this.stageCharge(request), checkCost = this.card('mediaCheckUsd') * BigInt(checks);
    const best = results.filter(result => !result.blocked && result.score >= SCORE_MIN).sort((a, b) => b.score - a.score)[0] || null;
    if (!best) { for (const result of results) this.removeFile(agent.id, result.file); const refused = results.some(result => result.blocked), unconfigured = results.some(result => result.error === INFLUENCER_TEXT.checkUnconfigured); return this.failJob(store, agent, job, unconfigured ? INFLUENCER_TEXT.checkUnconfigured : refused ? INFLUENCER_TEXT.refused : INFLUENCER_TEXT.lowScore, imageCost + checkCost, now, { retry: !unconfigured, refused }); }
    for (const result of results) if (result.file !== best.file) this.removeFile(agent.id, result.file);
    await this.finalizeJob(store, agent, job, best, imageCost + checkCost, now);
  }
  /** One vision call per candidate: { score, blocked, flags, error }. Dry run answers 90 without a call; a missing or unreadable answer scores 0. */
  async runCheck({ master, reference, candidate, prompt, kind }) {
    if (this.dryRun) return { score: 90, blocked: false, flags: { sameCharacter: 90, appearsMinor: false, realPersonLikeness: false, nsfw: false, hasText: false }, error: '' };
    const image = inspectImage(candidate); if (!image) return { score: 0, blocked: false, flags: null, error: INFLUENCER_TEXT.checkFailed };
    const images = [], typed = bytes => ({ bytes, type: inspectImage(bytes)?.type || 'image/png' });
    let text;
    if (master) { images.push(typed(master), { bytes: candidate, type: image.type }); text = CHECK_PROMPT; }
    else if (reference) { images.push({ bytes: candidate, type: image.type }, typed(reference)); text = `Image A is a new picture of an original fictional adult character, image B the creator's reference art of that character. Describe nothing; rate how closely A shows the same character as B. Answer with JSON only: {"sameCharacter": 0-100, "appearsMinor": bool, "realPersonLikeness": bool, "nsfw": bool, "hasText": bool}.`; }
    else { images.push({ bytes: candidate, type: image.type }); text = `Image A is a new picture meant to show this character: ${clip(prompt, 600)} Rate how closely the picture matches that description as sameCharacter (0-100). Answer with JSON only: {"sameCharacter": 0-100, "appearsMinor": bool, "realPersonLikeness": bool, "nsfw": bool, "hasText": bool}.`; }
    let reply;
    try { reply = await (this.vision || this.defaultVision.bind(this))({ text, images, kind }); }
    catch (error) { if (error?.code === 'CHECK_UNCONFIGURED') return { score: 0, blocked: false, flags: null, error: INFLUENCER_TEXT.checkUnconfigured }; throw Object.assign(Error(INFLUENCER_TEXT.checkFailed), { code: 'CHECK_FAILED', transient: true }); }
    const flags = parseCheck(reply); if (!flags) return { score: 0, blocked: false, flags: null, error: INFLUENCER_TEXT.checkFailed };
    const blocked = flags.appearsMinor || flags.realPersonLikeness || flags.nsfw;
    return { score: blocked ? 0 : flags.sameCharacter, blocked, flags, error: '' };
  }
  async defaultVision({ text, images }) {
    const config = this.config; if (!config.openrouterKey) throw Object.assign(Error(INFLUENCER_TEXT.checkUnconfigured), { code: 'CHECK_UNCONFIGURED' });
    const content = [{ type: 'text', text }, ...images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.type};base64,${image.bytes.toString('base64')}` } }))];
    const response = await chatCompletion({ apiKey: config.openrouterKey, model: config.visionModel || 'openai/gpt-5-mini', messages: [{ role: 'user', content }], maxTokens: 300, temperature: 0, signal: AbortSignal.timeout(45000), ...(this.fetcher ? { fetcher: this.fetcher } : {}) });
    const message = response?.message?.content; return typeof message === 'string' ? message : Array.isArray(message) ? message.map(part => part?.text || '').join('') : '';
  }
  /** A kept candidate: the master portrait, the sheet, a post picture or the poster of a clip (which then queues the video stage). */
  async finalizeJob(store, agent, job, best, spent, now) {
    const request = job.request || {}, ext = extOf(best.file), dir = this.agentDir(agent.id);
    if (job.kind === 'master') {
      const name = 'master.' + ext; renameSync(join(dir, best.file), join(dir, name));
      const inf = store.influencer(agent.id) || {}; if (inf.masterFile && inf.masterFile !== name) this.removeFile(agent.id, inf.masterFile);
      if (inf.sheetFile) { this.removeFile(agent.id, inf.sheetFile); }
      store.transaction(() => { this.closeJob(store, job, 'succeeded', '', spent, now, { file: name, score: best.score }); store.updateInfluencer(agent.id, { masterFile: name, sheetFile: '', consistency: best.score, state: this.xRevoked(agent, inf) ? 'paused' : 'ready', stateReason: this.xRevoked(agent, inf) ? INFLUENCER_TEXT.revoked : (inf.stateReason === INFLUENCER_TEXT.referenceGuide ? inf.stateReason : '') }); });
      this.event(agent, { kind: 'character', title: 'Character ready', body: `The character portrait passed its consistency check (score ${best.score}).${describeTiles(inf.spec?.tiles) ? ' ' + describeTiles(inf.spec.tiles) + '.' : ''}`, data: { avatarUrl: this.mediaUrl(agent.id, name), score: best.score } });
      if (this.editAvailable() && !this.dryRun) this.createJob(store, agent, { kind: 'sheet', model: 'edit', params: { prompt: 'Character turnaround sheet of the exact same character as in the reference picture: three full-body views side by side (front, three-quarter and profile), identical face, hair and outfit, plain neutral background. Not a real person, not a child; no text, logos, watermarks or captions.', aspectRatio: '16:9' }, uploads: [name], batch: 1, reserve: this.estimate('edit', {}) + this.card('mediaCheckUsd'), now });
      return;
    }
    if (job.kind === 'sheet') { const name = 'sheet.' + ext; renameSync(join(dir, best.file), join(dir, name)); store.transaction(() => { this.closeJob(store, job, 'succeeded', '', spent, now, { file: name, score: best.score }); store.updateInfluencer(agent.id, { sheetFile: name }); }); return; }
    const name = `${job.postId}.${ext}`; renameSync(join(dir, best.file), join(dir, name));
    if (job.kind === 'image') { this.closeJob(store, job, 'succeeded', '', spent, now, { file: name, score: best.score }); return; }
    // video: the checked picture becomes the clip's first frame; the clip itself is not checked again. A feature clip renders
    // its segments one after another (each from the previous segment's last frame) and is joined on the host at the end.
    const brief = clip(request.brief || '', INFLUENCER_LIMITS.briefChars), feature = request.feature || null;
    const duration = feature ? feature.segments[0] : INFLUENCER_LIMITS.videoSeconds;
    store.updateMediaJob(job.id, { state: 'queued', stage: 'video', score: best.score, nextCheckAt: 0, request: { ...request, files: [], poster: name, model: 'video', uploads: [name], batch: 1, segmentIndex: 0, segments: [], spentSoFar: spent.toString(), quotedUsd: '', params: { prompt: `The same character, ${brief || 'a calm moment'}; subtle natural motion, steady camera, consistent appearance, no text or captions.`, duration, resolution: INFLUENCER_LIMITS.postImageResolution } } });
  }
  /** The clip stage finished (its generation price adds to what the picture stage already cost): the post can go out, or the next feature segment starts. */
  async finishVideo(store, agent, job, file, now) {
    if (!file) return this.failJob(store, agent, job, INFLUENCER_TEXT.noOutput, 0n, now, { retry: true });
    const request = job.request || {}, feature = request.feature || null;
    if (!feature || this.dryRun) return this.closeJob(store, job, 'succeeded', '', this.dryRun ? 0n : this.stageCharge(request), now, { file, score: job.score ?? null });
    const segments = [...(Array.isArray(request.segments) ? request.segments : []), file], index = Number(request.segmentIndex) || 0, charge = this.stageCharge(request), spentSoFar = (BigInt(request.spentSoFar || '0') + charge).toString();
    if (index + 1 < feature.segments.length) {
      // Next segment: its first frame is this segment's last frame, so the shot continues without a cut.
      const frame = `tmp-${job.id}-f${index}.png`, dir = this.agentDir(agent.id);
      try { await this.ffmpeg(['-y', '-sseof', '-0.2', '-i', join(dir, file), '-frames:v', '1', join(dir, frame)]); if (!this.readFile(agent.id, frame)) throw Error('no frame'); }
      catch { return this.failJob(store, agent, job, INFLUENCER_TEXT.featureJoinFailed, charge, now, { retry: false }); }
      store.updateMediaJob(job.id, { state: 'queued', stage: 'video', nextCheckAt: 0, request: { ...request, files: [], segments, segmentIndex: index + 1, uploads: [frame], spentSoFar, quotedUsd: '', params: { ...request.params, prompt: `Continue the same shot without a cut: the same character, setting and lighting, ${clip(request.brief || 'a calm moment', INFLUENCER_LIMITS.briefChars)}; subtle natural motion, steady camera, consistent appearance, no text or captions.`, duration: feature.segments[index + 1] } } });
      return;
    }
    const out = `${job.postId}.mp4`, dir = this.agentDir(agent.id);
    if (segments.length > 1) {
      const list = `tmp-${job.id}-list.txt`;
      try { writeFileSync(join(dir, list), segments.map(name => `file '${join(dir, name).replace(/'/g, "'\\''")}'`).join('\n') + '\n'); await this.ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', join(dir, list), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', join(dir, out)]); if (!isMp4(this.readFile(agent.id, out) || Buffer.alloc(0))) throw Error('no output'); }
      catch { this.removeFile(agent.id, list); for (const name of segments) this.removeFile(agent.id, name); return this.failJob(store, agent, job, INFLUENCER_TEXT.featureJoinFailed, charge, now, { retry: false }); }
      this.removeFile(agent.id, list); for (const name of segments) this.removeFile(agent.id, name); for (let i = 0; i < segments.length; i++) this.removeFile(agent.id, `tmp-${job.id}-f${i}.png`);
    } else renameSync(join(dir, file), join(dir, out));
    this.closeJob(store, job, 'succeeded', '', charge, now, { file: out, score: job.score ?? null, request: { ...request, files: [], segments: [], spentSoFar: request.spentSoFar || '0' } });
  }
  /** Terminal bookkeeping of a job: settle once (what earlier stages cost plus this stage's charge is spent, the rest returns to backed and to the daily budget), record the outcome. */
  closeJob(store, job, state, error, spent, now, extra = {}) {
    store.transaction(() => {
      const fresh = store.mediaJob(job.id); if (!fresh || !MEDIA_JOB_OPEN_STATES.includes(fresh.state)) return;
      const reserved = BigInt(fresh.reservedUsd || '0'), total = spent + BigInt(fresh.request?.spentSoFar || '0'), charged = total > reserved ? reserved : total;
      store.settleMedia(job.id, { spentUsd: charged.toString() }); this.refundDay(store, fresh.agentId, reserved - charged);
      store.updateMediaJob(job.id, { state, error, finishedAt: now, ...extra });
    });
    const files = Array.isArray(job.request?.files) ? job.request.files : [];
    if (state !== 'succeeded') for (const name of files) this.removeFile(job.agentId, name);
  }
  /** A failed generation: refund what the provider did not charge, then let the kind decide (master retries once per round; posts decide in advancePosts). */
  async failJob(store, agent, job, reason, spent, now, { retry = false, refused = false } = {}) {
    this.closeJob(store, job, 'failed', reason, spent, now);
    await this.afterJobFailed(store, agent, store.mediaJob(job.id) || job, reason, now, { retry, refused });
  }
  async afterJobFailed(store, agent, job, reason, now, { retry = false, refused = false } = {}) {
    const request = job.request || {};
    if (job.kind === 'master') {
      const inf = store.influencer(agent.id); if (!inf || inf.state !== 'generating') return;
      if (retry && !refused && (Number(request.attempt) || 1) < 2) { this.event(agent, { kind: 'character', title: 'Character retry', body: reason, isPublic: false }); await this.startMaster(store, agent, inf, now, { attempt: (Number(request.attempt) || 1) + 1 }); return; }
      store.updateInfluencer(agent.id, { state: 'failed', stateReason: reason });
      this.event(agent, { kind: 'character', title: 'Character failed', body: reason });
      return;
    }
    if (job.kind === 'sheet') this.event(agent, { kind: 'character', title: 'Turnaround sheet skipped', body: reason, isPublic: false });
  }
  /** Provider and check errors by code: transient ones wait and retry (bounded), the rest fail the job; operator problems raise alerts. */
  async jobError(store, agent, job, error, now) {
    const code = error?.code || '', request = job.request || {}, errors = (Number(request.errors) || 0) + 1, text = PROVIDER_TEXT[code] || (code === 'CHECK_FAILED' ? INFLUENCER_TEXT.checkFailed : code === 'HF_PRICE' ? INFLUENCER_TEXT.price : INFLUENCER_TEXT.providerFailed);
    const generated = job.state !== 'queued' || error?.charged === true, spent = generated ? this.stageCharge(request) : 0n;
    if (code === 'HF_FUNDS') store.raiseAlert({ scope: 'provider', code: 'media-funds', message: 'Higgsfield reports insufficient credit; media generation fails until the account is topped up.' });
    if (code === 'HF_UNAUTHORIZED') store.raiseAlert({ scope: 'provider', code: 'media-auth', message: 'Higgsfield refused the configured key; media generation fails until LAUNCHPAD_AGENTS_HIGGSFIELD_KEY is fixed.' });
    if ((TRANSIENT.has(code) || error?.transient === true) && errors < MAX_ATTEMPTS) {
      // A submitted job keeps polling (its generation may still finish); a queued one resubmits later; a check retries later. Polls do not count as errors.
      store.updateMediaJob(job.id, { attempts: job.attempts + 1, nextCheckAt: now + retryDelay(errors), error: text, state: job.state === 'checking' ? 'downloaded' : job.state, request: { ...request, errors } });
      return;
    }
    await this.failJob(store, agent, job, text, spent, now, { retry: TRANSIENT.has(code) || error?.transient === true });
  }
  /** Jobs submitted more than 20 minutes ago are cancelled (best effort) and abandoned; nothing stays open longer than JOB_MAX_AGE_MS. */
  async expireJobs(store, now) {
    for (const job of store.allOpenMediaJobs()) {
      const submittedAt = Number(job.request?.submittedAt) || job.updatedAt, stuck = job.state === 'submitted' && now - submittedAt > JOB_TTL_MS, ancient = now - job.createdAt > JOB_MAX_AGE_MS;
      if (!stuck && !ancient) continue;
      if (job.state === 'submitted' && job.providerRequestId && !this.dryRun) { try { await this.hf().cancel(job.providerRequestId); } catch { /* Best effort. */ } }
      const agent = store.agent(job.agentId);
      // The provider may still have finished and charged: a submitted job is settled at its generation price, fail closed.
      this.closeJob(store, job, 'expired', INFLUENCER_TEXT.expired, job.state === 'submitted' ? this.stageCharge(job.request) : 0n, now);
      if (agent) await this.afterJobFailed(store, agent, store.mediaJob(job.id) || job, INFLUENCER_TEXT.expired, now, { retry: true });
    }
  }
  // ---- posts ----------------------------------------------------------------------------------------------------
  /** The media plan of a post: edit from the master when the edit model is available, else Soul 2 from the fixed prompt and the stored seed. */
  planPostMedia(inf, media, brief) {
    const spec = inf.spec || {}, scene = brief || 'a candid moment in their usual setting';
    const edit = this.editAvailable() && !this.dryRun, feature = media === 'feature' ? featureClipPlan(spec.featureClipSeconds) : null;
    const params = edit ? { prompt: `Keep the exact same character as in the reference picture (face, hair, outfit, colours and rendering style). New scene: ${scene}. Not a real person, not a child; no text, logos, watermarks or captions.`, aspectRatio: feature ? '16:9' : '1:1' } : { prompt: `${inf.prompt} Scene: ${scene}.`, aspectRatio: feature ? '16:9' : '1:1', resolution: INFLUENCER_LIMITS.postImageResolution, batch: 1, seed: Number(spec.seed) || undefined };
    const model = edit ? 'edit' : 'image';
    const video = feature ? feature.segments.reduce((sum, length) => sum + this.estimate('video', { duration: length }), 0n) : media === 'video' ? this.estimate('video', { duration: INFLUENCER_LIMITS.videoSeconds }) : 0n;
    const reserve = this.estimate(model, params) + this.card('mediaCheckUsd') + video;
    return { kind: feature ? 'video' : media, model, params, uploads: edit ? [inf.masterFile] : [], batch: 1, reserve, brief, ...(feature ? { feature: { seconds: feature.seconds, segments: feature.segments, joined: feature.joined } } : {}) };
  }
  async advancePosts(store, effective, now) {
    let delivered = 0;
    for (const post of store.openXPosts(60)) {
      if (this.closed || delivered >= MAX_DELIVERIES) break;
      if (post.nextAttemptAt > now) continue;
      const agent = store.agent(post.agentId), inf = agent ? store.influencer(agent.id) : null;
      if (!agent || !inf || agent.archived) { this.finishPost(store, post, 'failed', INFLUENCER_TEXT.agentGone, now); continue; }
      try {
        if (post.kind !== 'text' && ['generating', 'checking', 'queued'].includes(post.state)) {
          const job = post.mediaJobId ? store.mediaJob(post.mediaJobId) : null;
          if (!job || ['failed', 'expired'].includes(job.state)) { const outcome = this.replanPost(store, agent, inf, post, job, now); if (outcome !== 'text') continue; }
          else if (job.state !== 'succeeded') { const state = ['downloaded', 'checking'].includes(job.state) ? 'checking' : 'generating'; if (state !== post.state) store.updateXPost(post.id, { state }); continue; }
        }
        delivered++;
        await this.deliver(store, agent, inf, store.xPost(post.id), effective, now);
      } catch (error) { this.postError(store, agent, inf, post, error, now); }
    }
  }
  /** A failed picture: one regeneration with the same brief, then the post goes out as text with a note. Returns 'text' when the post is ready to deliver as text. */
  replanPost(store, agent, inf, post, job, now) {
    const attempts = store.mediaJobs(agent.id, { limit: 20, kinds: ['image', 'video'] }).filter(item => item.postId === post.id).length;
    if (job && attempts < 2 && inf.masterFile && this.effective().mediaOpen) {
      const plan = this.planPostMedia(inf, post.kind, job.request?.brief || ''), created = this.createJob(store, agent, { ...plan, runId: post.runId, postId: post.id, attempt: attempts + 1, now });
      if (created.job) { store.updateXPost(post.id, { mediaJobId: created.job.id, state: 'generating', error: '' }); return 'regenerated'; }
    }
    store.updateXPost(post.id, { kind: 'text', state: 'queued', error: job?.error === INFLUENCER_TEXT.lowScore || job?.error === INFLUENCER_TEXT.refused ? INFLUENCER_TEXT.postLowScore : 'media could not be generated; posted as text' });
    return 'text';
  }
  async deliver(store, agent, inf, post, effective, now) {
    const spec = inf.spec || {};
    if (inf.state !== 'ready' || inf.postingPaused || inf.adminPaused || !effective.xOpen) { store.updateXPost(post.id, { nextAttemptAt: now + 5 * 60000 }); return; }
    const account = this.service.xAccounts?.forAgent?.(agent.id);
    if (!account || account.state !== 'connected') { this.finishPost(store, post, 'failed', INFLUENCER_TEXT.noAccount, now); return; }
    if (this.dryRun) { this.finishPost(store, post, 'skipped', INFLUENCER_TEXT.dryRun, now); this.event(agent, { kind: 'post', title: 'Post not sent', body: post.text, data: { kind: post.kind }, isPublic: false, runId: post.runId }); return; }
    let media = null;
    if (post.kind !== 'text') {
      const job = store.mediaJob(post.mediaJobId), bytes = job?.file ? this.readFile(agent.id, job.file) : null;
      if (!bytes) { store.updateXPost(post.id, { kind: 'text', error: 'media file missing; posted as text' }); post = store.xPost(post.id); }
      else media = { bytes, contentType: TYPES[extOf(job.file)] || 'application/octet-stream', kind: post.kind, file: job.file };
    }
    store.updateXPost(post.id, { state: 'uploading', attempts: post.attempts + 1, xAccountId: account.id });
    const result = await this.service.xAccounts.postAs(account.id, { text: post.text + (post.link ? '\n' + post.link : ''), media: media ? { bytes: media.bytes, contentType: media.contentType, kind: media.kind } : null });
    // Charged by what went out: a post that carries the coin link costs X's link price whatever the creator's setting is now.
    const spent = post.link ? this.card('xPostLinkUsd') : this.card('xPostUsd');
    store.transaction(() => {
      const fresh = store.xPost(post.id), reserved = BigInt(fresh.reservedUsd || '0'), charged = spent > reserved ? reserved : spent;
      store.settlePost(post.id, { spentUsd: charged.toString() }); this.refundDay(store, agent.id, reserved - charged);
      store.updateXPost(post.id, { state: 'posted', xPostId: clip(result?.postId || '', 80), url: /^https:\/\/(?:x|twitter)\.com\//.test(result?.url || '') ? result.url : '', postedAt: now });
      store.updateInfluencer(agent.id, { lastPostAt: now });
    });
    const mediaUrl = media ? this.mediaUrl(agent.id, media.file) : null;
    this.event(agent, { kind: 'post', title: 'Posted to X', body: post.text, data: { url: store.xPost(post.id).url, kind: post.kind, ...(mediaUrl ? { mediaUrl } : {}) }, runId: post.runId });
  }
  /** Terminal bookkeeping of a post: settle once (the unused reservation returns), fail its open media job, record the outcome. */
  finishPost(store, post, state, error, now) {
    store.transaction(() => {
      const fresh = store.xPost(post.id); if (!fresh || !POST_OPEN_STATES.includes(fresh.state)) return;
      const reserved = BigInt(fresh.reservedUsd || '0'); store.settlePost(post.id, { spentUsd: '0' }); this.refundDay(store, fresh.agentId, reserved);
      store.updateXPost(post.id, { state, error, ...(state === 'posted' ? {} : { nextAttemptAt: 0 }) });
    });
    const job = post.mediaJobId ? store.mediaJob(post.mediaJobId) : null;
    if (job && MEDIA_JOB_OPEN_STATES.includes(job.state)) { if (job.state === 'submitted' && job.providerRequestId && !this.dryRun) this.hf().cancel(job.providerRequestId).catch(() => {}); this.closeJob(store, job, 'failed', error, job.state === 'submitted' ? this.stageCharge(job.request) : 0n, now); }
  }
  postError(store, agent, inf, post, error, now) {
    const code = error?.code || '';
    if (code === 'X_RATE_LIMITED') { store.updateXPost(post.id, { nextAttemptAt: now + Math.min(MAX_RETRY_MS, Math.max(60000, Number(error.retryAfterMs) || 60000)) }); return; }
    if (code === 'X_UNAUTHORIZED') { this.pauseForRevocation(store, agent, inf, now); return; }
    if (code === 'X_DUPLICATE') { this.finishPost(store, post, 'skipped', INFLUENCER_TEXT.duplicate, now); return; }
    if (code === 'X_INVALID' || code === 'X_FORBIDDEN') { this.finishPost(store, post, 'failed', INFLUENCER_TEXT.rejected, now); return; }
    if (error?.statusCode === 503 || code === 'X_UNAVAILABLE') { store.updateXPost(post.id, { nextAttemptAt: now + 5 * 60000 }); return; }
    if (post.attempts + 1 >= 5) { this.finishPost(store, post, 'failed', INFLUENCER_TEXT.xFailed, now); return; }
    store.updateXPost(post.id, { nextAttemptAt: now + retryDelay(post.attempts + 1) });
  }
  /** X revoked the connection: posting pauses, every open post of the agent is refunded, the creator is told where to reconnect. */
  pauseForRevocation(store, agent, inf, now) {
    this.abandonOpenWork(store, agent.id, INFLUENCER_TEXT.revoked);
    store.updateInfluencer(agent.id, { state: 'paused', stateReason: INFLUENCER_TEXT.revoked });
    store.raiseAlert({ scope: 'agent:' + agent.id, code: 'x-revoked', message: INFLUENCER_TEXT.revoked });
    this.event(agent, { kind: 'influencer', title: 'Posting paused', body: INFLUENCER_TEXT.revoked });
  }
  expirePosts(store, now) { for (const post of store.openXPosts(200)) if (now - post.createdAt > POST_TTL_MS) this.finishPost(store, post, 'failed', INFLUENCER_TEXT.postExpired, now); }
  // ---- housekeeping -------------------------------------------------------------------------------------------
  housekeeping(store, now) {
    if (this.passes % 15 === 1) { try { const root = join(this.mediaDir(), 'uploads'); for (const account of existsSync(root) ? readdirSync(root) : []) { const dir = join(root, account); for (const name of readdirSync(dir)) { const path = join(dir, name); try { if (statSync(path).mtimeMs < now - DAY) unlinkSync(path); } catch { /* best effort */ } } } } catch { /* best effort */ } }
    if (this.passes % 60 === 1) { try { for (const agent of store.allAgents({ includeArchived: true })) { if (!agent.archived || agent.updatedAt > now - 30 * DAY) continue; const dir = join(this.mediaDir(), agent.id); if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } } catch { /* best effort */ } }
  }
  // ---- runner integration ----------------------------------------------------------------------------------
  counters(inf, now) { const today = dayKey(now); return inf.dayKey === today ? { postsToday: inf.postsToday || 0, imagesToday: inf.imagesToday || 0, videosToday: inf.videosToday || 0, featureToday: inf.featureToday || 0 } : { postsToday: 0, imagesToday: 0, videosToday: 0, featureToday: 0 }; }
  /** Whether the daily feature clip can still be made today: enabled, master ready, length available on this host, not used yet. */
  featureAvailable(inf, counters) { const seconds = Number(inf?.spec?.featureClipSeconds) || 0; return !!seconds && !!inf.masterFile && inf.spec?.media === 'video' && this.featureClipLengths().includes(seconds) && counters.featureToday < INFLUENCER_LIMITS.featureClipPerDay; }
  /** Whether post_to_x may be offered to this agent in a run starting now: everything about the account, the state and the caps must be known good. */
  postingAllowed(agent, now = this.now()) {
    try {
      const effective = this.effective(); if (!effective.influencerOpen || !effective.xOpen) return false;
      if (!agent || agent.archived || agent.launchState !== 'live') return false;
      const store = this.service.store(), inf = store.influencer(agent.id); if (!inf) return false;
      const spec = inf.spec || {}; if (!spec.postToX || inf.state !== 'ready' || inf.postingPaused || inf.adminPaused) return false;
      const account = this.service.xAccounts?.forAgent?.(agent.id); if (!account || account.state !== 'connected') return false;
      if ((inf.nextPostAt || 0) > now) return false;
      if (this.counters(inf, now).postsToday >= (Number(spec.dailyPosts) || 0)) return false;
      if (store.openAlerts().some(alert => alert.scope === 'global' && alert.code === 'ledger')) return false;
      return true;
    } catch { return false; }
  }
  /** Context for the prompts (null when the agent has no influencer). */
  promptContext(agent) {
    try {
      const store = this.service.store(), inf = store.influencer(agent.id); if (!inf) return null;
      const spec = inf.spec || {}, now = this.now(), counters = this.counters(inf, now), account = spec.postToX ? this.service.xAccounts?.forAgent?.(agent.id) : null;
      return { character: inf.prompt || '', characterReady: !!inf.masterFile, handle: account?.state === 'connected' ? String(account.handle || '') : '', media: spec.character ? spec.media || 'text' : 'text', postsLeftToday: Math.max(0, (Number(spec.dailyPosts) || 0) - counters.postsToday), imagesLeftToday: Math.max(0, (Number(spec.dailyImages) || 0) - counters.imagesToday), videosLeftToday: Math.max(0, (Number(spec.dailyVideos) || 0) - counters.videosToday), featureClipSeconds: Number(spec.featureClipSeconds) || 0, featureAvailableToday: this.featureAvailable(inf, counters), nextPostAt: inf.nextPostAt || null, coinLink: !!spec.coinLink, canPost: this.postingAllowed(agent, now), recentPosts: store.xPosts(agent.id, { limit: 3 }).map(post => ({ text: clip(post.text, 280), at: post.createdAt, state: post.state })) };
    } catch { return null; }
  }
  /** The post_to_x handler: re-checks everything, validates the words, decides the media within the caps and the budget, reserves and queues. */
  async requestPost(agent, runId, args = {}) {
    const store = this.service.store(), now = this.now(), inf = store.influencer(agent.id);
    if (!inf || !this.postingAllowed(agent, now)) toolFail('Posting to X is not available this run.');
    if (runId && store.xPosts(agent.id, { limit: 1, runId }).length) toolFail('You already queued a post this run: at most one post per run.');
    const checked = validatePostText(args?.text); if (!checked.ok) toolFail(checked.error);
    const spec = inf.spec || {}, counters = this.counters(inf, now), effective = this.effective(), notes = [];
    let media = ['image', 'video', 'feature'].includes(args?.media) ? args.media : 'none';
    if (media !== 'none') {
      if (!spec.character || !inf.masterFile) { media = 'none'; notes.push('No character picture is available yet; the post goes out as text.'); }
      else if (spec.media === 'text') { media = 'none'; notes.push('The creator allows text-only posts.'); }
      else if (!effective.mediaOpen || (!this.dryRun && !this.hf().available())) { media = 'none'; notes.push('Media generation is unavailable right now; the post goes out as text.'); }
      else {
        if (media === 'feature' && !this.featureAvailable(inf, counters)) { media = 'video'; notes.push(Number(spec.featureClipSeconds) ? 'Today’s feature clip is already used or unavailable; a 5-second clip is attached instead.' : 'The creator has not enabled a daily feature clip; a 5-second clip is attached instead.'); }
        if (media === 'video' && (spec.media !== 'video' || counters.videosToday >= (Number(spec.dailyVideos) || 0))) { media = 'image'; notes.push(spec.media !== 'video' ? 'Clips are not enabled; a picture is attached instead.' : 'Today’s clip allowance is used; a picture is attached instead.'); }
        if (media === 'image' && counters.imagesToday >= (Number(spec.dailyImages) || 0)) { media = 'none'; notes.push('Today’s picture allowance is used; the post goes out as text.'); }
      }
    }
    const brief = sanitizeBrief(args?.mediaBrief), postReserve = spec.coinLink ? this.card('xPostLinkUsd') : this.card('xPostUsd');
    let plan = media === 'none' ? null : this.planPostMedia(inf, media, brief), total = postReserve + (plan?.reserve || 0n);
    if (!this.dryRun) {
      const backed = BigInt(store.agentBalances(agent.id).usd.backed), { dayBudget, daySpent } = this.dayBudget(store, store.agent(agent.id), now);
      if (backed < postReserve || daySpent + postReserve > dayBudget) toolFail('Not enough operating credit or daily budget for a post right now.');
      if (plan && (backed < total || daySpent + total > dayBudget)) { notes.push(media === 'feature' ? 'Not enough operating credit for today’s feature clip; the post goes out as text.' : 'Not enough operating credit for media today; the post goes out as text.'); plan = null; media = 'none'; total = postReserve; }
    }
    const publicUrl = String(this.config.publicUrl || '').replace(/\/+$/, ''), link = spec.coinLink && agent.mint && /^https:\/\//.test(publicUrl) ? `${publicUrl}/coin?mint=${agent.mint}` : '';
    const account = this.service.xAccounts?.forAgent?.(agent.id);
    const { post, job } = store.transaction(() => {
      const post = store.createXPost({ agentId: agent.id, runId, xAccountId: account?.id || null, kind: media === 'none' ? 'text' : media === 'feature' ? 'video' : media, text: checked.text, link, state: 'queued' });
      store.reservePost(post.id, this.dryRun ? '0' : postReserve.toString());
      let job = null;
      if (plan) { const path = this.dryRun ? 'dry-run' : this.hf().model(plan.model)?.path || plan.model; job = store.createMediaJob({ agentId: agent.id, runId, postId: post.id, kind: plan.kind, stage: plan.model, provider: this.dryRun ? 'dry-run' : 'higgsfield', model: path, request: { model: plan.model, params: plan.params, uploads: plan.uploads, batch: 1, attempt: 1, brief, reserve: plan.reserve.toString(), ...(plan.feature ? { feature: plan.feature } : {}) }, state: 'queued' }); store.reserveMedia(job.id, this.dryRun ? '0' : plan.reserve.toString()); store.updateXPost(post.id, { state: 'generating', mediaJobId: job.id }); }
      if (!this.dryRun) this.chargeDay(store, agent.id, total);
      store.updateInfluencer(agent.id, { dayKey: dayKey(now), postsToday: counters.postsToday + 1, imagesToday: counters.imagesToday + (media !== 'none' ? 1 : 0), videosToday: counters.videosToday + (media === 'video' ? 1 : 0), featureToday: counters.featureToday + (media === 'feature' ? 1 : 0), nextPostAt: now + Math.max(1, Number(spec.cadenceHours) || INFLUENCER_LIMITS.cadenceDefault) * HOUR });
      return { post: store.xPost(post.id), job };
    });
    if (runId && !this.dryRun) { try { store.recordUsage({ runId, agentId: agent.id, provider: 'x', requestId: 'post:' + post.id, kind: 'post', estimatedUsd: postReserve.toString(), state: 'estimated' }); if (job) store.recordUsage({ runId, agentId: agent.id, provider: 'higgsfield', requestId: 'media:' + job.id, kind: plan.kind === 'video' ? 'video' : 'image', model: job.model, estimatedUsd: plan.reserve.toString(), state: 'estimated', detail: plan.feature ? `feature clip ${plan.feature.seconds} s` : '' }); } catch { /* Usage rows are informational. */ } }
    this.event(agent, { kind: 'post', title: 'Post queued', body: checked.text, data: { postId: post.id, media }, isPublic: false, runId });
    return { queued: true, postId: post.id, deliversWithin: media === 'feature' ? 'about an hour' : 'minutes', media, ...(media === 'feature' ? { featureClipSeconds: Number(spec.featureClipSeconds) || 0 } : {}), ...(notes.length ? { note: notes.join(' ') } : {}) };
  }
  // ---- views and controls ---------------------------------------------------------------------------------
  /** Public card for the coin page and the directory (null when the agent has no influencer): no file paths, request ids, tokens or raw provider text. */
  view(agent) {
    let store; try { store = this.service.store(); } catch { return null; }
    const inf = agent?.id ? store.influencer(agent.id) : null; if (!inf) return null;
    const spec = inf.spec || {}, now = this.now(), counters = this.counters(inf, now), account = spec.postToX ? this.service.xAccounts?.forAgent?.(agent.id) : null, connected = !!account && account.state === 'connected';
    const state = inf.state === 'ready' && (inf.postingPaused || inf.adminPaused) ? 'paused' : inf.state;
    const posts = store.xPosts(agent.id, { limit: INFLUENCER_LIMITS.postsShown }).map(post => { const job = post.mediaJobId ? store.mediaJob(post.mediaJobId) : null; return { id: post.id, kind: post.kind, text: post.text, state: post.state, stateLabel: POST_STATE_LABELS[post.state] || post.state, url: post.url || null, mediaUrl: job?.state === 'succeeded' ? this.mediaUrl(agent.id, job.file) : null, seconds: post.kind === 'video' ? Number(job?.request?.feature?.seconds) || INFLUENCER_LIMITS.videoSeconds : 0, feature: !!job?.request?.feature, note: post.error || '', at: post.createdAt, postedAt: post.postedAt || null }; });
    return { enabled: inf.state !== 'disabled', character: !!spec.character, postToX: !!spec.postToX, state, stateLabel: INFLUENCER_STATE_LABELS[state] || state, stateReason: inf.adminPaused ? (inf.adminPauseReason || 'Paused by the platform.') : inf.postingPaused && state === 'paused' ? 'Paused by the creator.' : inf.stateReason || '', handle: connected ? String(account.handle || '') : null, xUrl: connected && account.handle ? 'https://x.com/' + encodeURIComponent(String(account.handle).replace(/^@/, '')) : null, xConnected: connected, avatarUrl: inf.masterFile && ['ready', 'paused', 'generating'].includes(state) ? this.mediaUrl(agent.id, inf.masterFile) : null, sheetUrl: inf.sheetFile ? this.mediaUrl(agent.id, inf.sheetFile) : null, tiles: spec.character ? describeTiles(spec.tiles) : '', source: spec.source || 'none', media: spec.character ? spec.media || 'text' : 'text', caps: { dailyPosts: Number(spec.dailyPosts) || 0, dailyImages: Number(spec.dailyImages) || 0, dailyVideos: Number(spec.dailyVideos) || 0 }, cadenceHours: Number(spec.cadenceHours) || INFLUENCER_LIMITS.cadenceDefault, coinLink: !!spec.coinLink, today: { posts: counters.postsToday, images: counters.imagesToday, videos: counters.videosToday, feature: counters.featureToday }, featureClip: { seconds: Number(spec.featureClipSeconds) || 0, usedToday: counters.featureToday > 0, available: this.featureAvailable(inf, counters), lengths: this.featureClipLengths(), costsUsd: this.featureClipCosts() }, nextPostAt: inf.nextPostAt || null, lastPostAt: inf.lastPostAt || null, consistency: inf.consistency ?? null, generations: inf.generations || 0, regenerationsLeft: Math.max(0, INFLUENCER_LIMITS.regenerations - Math.max(0, (inf.generations || 0) - 1)), pausedByCreator: !!inf.postingPaused, pausedByPlatform: !!inf.adminPaused, posts, rules: INFLUENCER_RULES, dryRun: this.dryRun, at: now };
  }
  /** Creator controls (ownership through service.requireCreator): pause, caps, cadence, link, media mode, regenerate, X account. */
  async control(session, body = {}, context) {
    const service = this.service, store = service.store(), { agent, current } = await service.requireCreator(session, body?.mint, context);
    const inf = store.influencer(agent.id); if (!inf) fail('This agent has no influencer.', 404);
    if (inf.state === 'disabled') fail('This influencer is switched off.', 409);
    const spec = { ...(inf.spec || {}) }, patch = {}, changes = {}, bool = value => value === true || value === false;
    const integer = (value, min, max, label) => { const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) fail(`${label} must be a whole number between ${min} and ${max}.`); return n; };
    if (body.pausePosting !== undefined) { if (!bool(body.pausePosting)) fail('Choose pause or resume.'); if (!!inf.postingPaused !== body.pausePosting) { patch.postingPaused = body.pausePosting; changes.pausePosting = body.pausePosting; } }
    if (body.cadenceHours !== undefined) { const hours = integer(body.cadenceHours, 1, 24, 'Posting cadence'); if (!INFLUENCER_LIMITS.cadenceHours.includes(hours)) fail(`Posting cadence must be one of ${INFLUENCER_LIMITS.cadenceHours.join(', ')} hours.`); if (hours !== spec.cadenceHours) { spec.cadenceHours = hours; changes.cadenceHours = hours; } }
    if (body.dailyPosts !== undefined) { const n = integer(body.dailyPosts, INFLUENCER_LIMITS.dailyPostsMin, INFLUENCER_LIMITS.dailyPostsMax, 'Daily posts'); if (n !== spec.dailyPosts) { spec.dailyPosts = n; changes.dailyPosts = n; } }
    if (body.coinLink !== undefined) { if (!bool(body.coinLink)) fail('Choose whether posts carry the coin link.'); if (body.coinLink !== !!spec.coinLink) { spec.coinLink = body.coinLink; changes.coinLink = body.coinLink; } }
    if (body.media !== undefined) { if (!spec.character) fail('This influencer has no character, so posts are text only.'); if (!INFLUENCER_MEDIA_MODES.some(mode => mode.id === body.media)) fail('Choose text only, pictures, or pictures and clips.'); if (body.media !== spec.media) { spec.media = body.media; changes.media = body.media; } }
    if (body.dailyImages !== undefined) { if (!spec.character) fail('This influencer has no character.'); const n = integer(body.dailyImages, 0, INFLUENCER_LIMITS.dailyImagesMax, 'Daily pictures'); if (n !== spec.dailyImages) { spec.dailyImages = n; changes.dailyImages = n; } }
    if (body.dailyVideos !== undefined) { if (!spec.character) fail('This influencer has no character.'); const n = integer(body.dailyVideos, 0, INFLUENCER_LIMITS.dailyVideosMax, 'Daily clips'); if (n !== spec.dailyVideos) { spec.dailyVideos = n; changes.dailyVideos = n; } }
    if (body.featureClipSeconds !== undefined) { if (!spec.character) fail('This influencer has no character.'); const n = integer(body.featureClipSeconds, 0, 60, 'Daily feature clip'); if (n !== 0 && !INFLUENCER_LIMITS.featureClipSeconds.includes(n)) fail(`The daily feature clip must be off or ${INFLUENCER_LIMITS.featureClipSeconds.join(', ')} seconds.`); if (n !== 0 && !this.featureClipLengths().includes(n)) fail(`A ${n}-second feature clip is not available on this host; choose ${this.featureClipLengths().join(' or ') || 'off'}.`); if (n !== (Number(spec.featureClipSeconds) || 0)) { spec.featureClipSeconds = n; changes.featureClipSeconds = n; } }
    if (spec.character) { if (spec.media === 'text') { spec.dailyImages = 0; spec.dailyVideos = 0; } else if (spec.media === 'images') spec.dailyVideos = 0; if (spec.media !== 'video') spec.featureClipSeconds = 0; if (spec.media !== 'text' && !spec.dailyImages && !spec.dailyVideos) fail('Allow at least one picture or clip a day, or choose text only.'); }
    if (body.xAccountId !== undefined) {
      if (typeof body.xAccountId !== 'string' || !/^[a-f0-9]{24}$/.test(body.xAccountId)) fail('Connect the X account the agent will post to.');
      if (!this.effective().xOpen) fail(INFLUENCER_TEXT.unavailable);
      // A refused claim (400) changes nothing; a constraint failure (x_accounts holds one row per agent) frees the old row and claims again.
      const claim = () => service.xAccounts.claimForAgent({ xAccountId: body.xAccountId, accountId: current.account.id, agentId: agent.id });
      try { await claim(); } catch (error) { if (error?.statusCode) throw error; try { await service.xAccounts.release(agent.id); } catch { /* Nothing to free. */ } await claim(); }
      spec.postToX = true; spec.xAccountId = body.xAccountId; changes.xAccountId = body.xAccountId;
      if (inf.state === 'paused' && [INFLUENCER_TEXT.revoked, INFLUENCER_TEXT.noAccount].includes(inf.stateReason)) { patch.state = spec.character && !inf.masterFile ? 'generating' : 'ready'; patch.stateReason = ''; }
    }
    if (body.detachX === true) {
      try { await service.xAccounts.release(agent.id); } catch { /* Nothing to free. */ }
      if (spec.postToX) { spec.postToX = false; spec.xAccountId = ''; changes.detachX = true; }
      this.abandonOpenWork(store, agent.id, INFLUENCER_TEXT.noAccount);
      if (!spec.character) { patch.state = 'paused'; patch.stateReason = INFLUENCER_TEXT.noAccount; }
    }
    if (body.regenerate === true) {
      if (!spec.character) fail('This influencer has no character to regenerate.');
      if (!['ready', 'failed'].includes(inf.state)) fail('The character can be regenerated once it is ready or has failed.', 409);
      if (Math.max(0, (inf.generations || 0) - 1) >= INFLUENCER_LIMITS.regenerations) fail(`The character can be regenerated at most ${INFLUENCER_LIMITS.regenerations} times.`, 409);
      if (!this.effective().mediaOpen) fail(INFLUENCER_TEXT.mediaUnavailable, 409);
      patch.state = 'generating'; patch.stateReason = ''; patch.generations = (inf.generations || 0) + 1; changes.regenerate = true;
    }
    if (!Object.keys(changes).length) return this.view(agent);
    store.transaction(() => {
      store.updateInfluencer(agent.id, { ...patch, spec });
      const revision = store.addRevision(agent.id, { actor: 'creator:' + current.account.id, kind: 'influencer', changes });
      store.addEvent({ agentId: agent.id, kind: 'revision', title: `Influencer settings revised (r${revision})`, body: Object.keys(changes).map(key => key === 'pausePosting' ? (changes.pausePosting ? 'Posting paused by the creator.' : 'Posting resumed by the creator.') : key === 'regenerate' ? 'Character regeneration requested.' : key === 'xAccountId' ? 'X account attached.' : key === 'detachX' ? 'X account detached.' : `${key} updated.`).join(' '), data: { revision, fields: Object.keys(changes) }, isPublic: false });
    });
    return this.view(store.agent(agent.id));
  }
}
