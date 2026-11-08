import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { Keypair } from '@solana/web3.js';
import { AgentService } from '../src/agent/service.mjs';
import { InlineWorker } from '../src/agent/runner.mjs';
import { dryRunModel } from '../src/agent/loop.mjs';
import { ModelRegistry } from '../src/agent/openrouter.mjs';
import { MIGRATIONS, AGENT_SCHEMA_VERSION, openAgentDatabase } from '../src/agent/db.mjs';
import { AgentStore } from '../src/agent/store.mjs';
import { ASSET, EXTERNAL, agentOwner } from '../src/agent/ledger.mjs';
import { estimateUsd, mergeModels } from '../src/agent/higgsfield.mjs';
import { InfluencerService, placeholderPng, inspectImage, parseCheck, INFLUENCER_TEXT } from '../src/agent/influencer.mjs';
import { handleInfluencerRoutes } from '../src/agent/influencer-http.mjs';
import { influencerLaunchRequest, INFLUENCER_LIMITS, INFLUENCER_RULES } from '../public/influencer-catalog.mjs';
import { AGENT_MODE, AGENT_POLICY_V1, AGENT_RATE_CARD_V1, AGENT_RATE_CARD_V2, capabilityMask } from '../public/agent-catalog.mjs';
import { AGENT_POLICY_HASH, AGENT_POLICY_V2, AGENT_POLICY_V2_HASH } from '../src/agent/policy.mjs';

const MIN = 60000, HOUR = 3600000, DAY = 86400000, MODEL = 'openai/gpt-6-luna', CARD = AGENT_RATE_CARD_V2;
const wallet = () => Keypair.generate().publicKey.toBase58();
const CATALOG = [{ id: MODEL, name: 'GPT-6 Luna', pricing: { prompt: '0.0000001', completion: '0.0000005', request: '0' }, context_length: 1050000, top_provider: { max_completion_tokens: 128000 }, supported_parameters: ['tools'] }];
const X_ID = 'a'.repeat(24), X_ID_2 = 'b'.repeat(24), OTHER_X = 'c'.repeat(24);
class FakeStore { constructor() { this.docs = new Map(); } async read(name, fallback = null) { return this.docs.has(name) ? JSON.parse(this.docs.get(name)) : fallback; } async write(name, value) { this.docs.set(name, JSON.stringify(value)); } }
class FakeChain { async solUsd() { return { usd: 200, at: Date.now(), source: 'test' }; } async incomingReceipt() { return null; } async close() {} }
/** XAccounts by the brief's method names: rows in memory, postAs records every delivery and can be told to fail once. */
class FakeX {
  constructor() { this.rows = new Map(); this.posts = []; this.released = []; this.failNext = null; }
  available() { return true; }
  add(id, { accountId, handle, state = 'connected', agentId = null }) { this.rows.set(id, { id, accountId, handle, state, agentId, xUserId: 'u-' + id.slice(0, 4) }); return this.rows.get(id); }
  forAgent(agentId) { for (const row of this.rows.values()) if (row.agentId === agentId && row.state === 'connected') return { ...row }; return null; }
  claimForAgent({ xAccountId, accountId, agentId }) { const row = this.rows.get(xAccountId); if (!row || row.accountId !== accountId || row.state !== 'connected' || (row.agentId && row.agentId !== agentId)) throw Object.assign(Error('Connect the X account the agent will post to.'), { statusCode: 400 }); row.agentId = agentId; return { ...row }; }
  release(agentId) { for (const row of this.rows.values()) if (row.agentId === agentId) row.agentId = null; this.released.push(agentId); }
  async postAs(xAccountId, { text, media = null }) { this.posts.push({ xAccountId, text, media: media ? { kind: media.kind, contentType: media.contentType, bytes: media.bytes.length } : null }); if (this.failNext) { const error = this.failNext; this.failNext = null; if (error.code === 'X_UNAUTHORIZED') this.rows.get(xAccountId).state = 'revoked'; throw error; } return { postId: 'x-' + this.posts.length, url: 'https://x.com/i/web/status/' + this.posts.length }; }
}
const fakeMp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(120, 7)]);
const isMp4Buffer = bytes => Buffer.isBuffer(bytes) && bytes.length > 64 && bytes.toString('ascii', 4, 8) === 'ftyp';
/** The Higgsfield client surface the pipeline uses, scripted: every request completes after one poll unless an outcome is queued. */
class FakeHiggsfield {
  constructor() { this.requests = new Map(); this.submits = []; this.uploads = []; this.cancelled = []; this.outcomes = []; this.failNext = null; this.editEnabled = true; this.models = mergeModels(); }
  available() { return true; }
  model(kind) { return this.models[kind]; }
  modelAvailable(kind) { return !!this.models[kind]?.path && (kind !== 'edit' || this.editEnabled); }
  estimateUsd(kind, params) { return estimateUsd(kind, params); }
  async submit(kind, params, { idempotencyKey } = {}) { if (this.failNext) { const error = this.failNext; this.failNext = null; throw error; } const id = 'req-' + (this.submits.length + 1); this.submits.push({ id, kind, params: { ...params }, idempotencyKey }); this.requests.set(id, { kind, params, polls: 0 }); return { requestId: id, statusUrl: '', cancelUrl: '' }; }
  async status(id) { const request = this.requests.get(id); request.polls++; if (request.polls < 2) return { state: 'running', urls: [], error: '' }; const outcome = this.outcomes.length ? this.outcomes.shift() : 'completed'; if (outcome !== 'completed') return { state: outcome, urls: [], error: outcome === 'failed' ? 'provider said no: internal-secret-detail' : '' }; const count = request.kind === 'video' ? 1 : Number(request.params.batch) || 1; return { state: 'completed', urls: Array.from({ length: count }, (_, index) => `https://cdn.test/${id}-${index}.${request.kind === 'video' ? 'mp4' : 'png'}`), error: '' }; }
  async cancel(id) { this.cancelled.push(id); return true; }
  async upload(bytes, type) { this.uploads.push({ bytes: bytes.length, type }); return `https://media.test/up-${this.uploads.length}.png`; }
  async download(url) { return url.endsWith('.mp4') ? { bytes: fakeMp4(), contentType: 'video/mp4' } : { bytes: placeholderPng(url), contentType: 'image/png' }; }
}
/** Vision verdicts in order (numbers = sameCharacter, objects = flags, strings = raw replies); 90 when the script runs out. */
function fakeVision(script = []) { const calls = []; const vision = async ({ text, images, kind }) => { calls.push({ text, images: images.length, kind }); const next = script.length ? script.shift() : 90; if (typeof next === 'string') return next; const flags = typeof next === 'number' ? { sameCharacter: next } : next; return 'Sure! ' + JSON.stringify({ sameCharacter: 90, appearsMinor: false, realPersonLikeness: false, nsfw: false, hasText: false, ...flags }); }; vision.calls = calls; return vision; }

async function fixture({ flags = {}, dryRun = false, config: extra = {}, vision = fakeVision() } = {}) {
  let clock = Date.UTC(2026, 9, 4, 12, 0, 0); const now = () => clock, tick = ms => { clock += ms; };
  const dir = await mkdtemp(join(tmpdir(), 'influencer-'));
  const accountsList = [{ id: 'acct-1', username: 'mira', role: 'admin', mfaEnabled: true, banned: false, mainWallet: null }, { id: 'acct-2', username: 'bob', role: 'user', mfaEnabled: false, banned: false, mainWallet: null }, { id: 'acct-3', username: 'eve', role: 'user', mfaEnabled: false, banned: false, mainWallet: null }];
  const accounts = { dir, hostStore: new FakeStore(), list: async () => accountsList, get: async id => accountsList.find(a => a.id === id) || null, getSession: async token => (token === 'tok-bob' ? { account: accountsList[1], walletVerified: false } : token === 'tok-eve' ? { account: accountsList[2], walletVerified: false } : null) };
  const config = { enabled: true, dryRun, dbPath: join(dir, 'agents.sqlite'), backupDir: '', openrouterKey: 'or-key', models: [MODEL], defaultModel: MODEL, browserbaseKey: '', browserbaseProject: '', browserbaseRegion: '', operatorWallet: wallet(), globalDailyUsd: 10000000n, modelConcurrency: 2, browserConcurrency: 1, domainAllowlist: [], rateCard: CARD, workerPath: '',
    higgsfieldKey: 'hf-id:hf-secret-value', higgsfieldUrl: 'https://api.higgsfield.ai', higgsfieldModels: null, mediaConcurrency: 2, visionModel: 'openai/gpt-4o-mini', mediaDir: join(dir, 'media'), xClientId: 'x-client', xClientSecret: 'x-secret-value', xCallbackUrl: 'https://launchpad.test/api/launchpad/x/callback', xGlobalDailyPosts: 500, publicUrl: 'https://launchpad.test', ...extra };
  const registry = new ModelRegistry({ allowlist: [MODEL], now, catalog: CATALOG, fetcher: async () => ({ ok: true, json: async () => ({ data: CATALOG }) }) });
  const books = new Map();
  const service = new AgentService({ accounts, launchpad: { book: async id => ({ launches: books.get(id) || [] }) }, discovery: null, chainFactory: async () => new FakeChain(), config, now, registry, worker: new InlineWorker({ model: dryRunModel() }) });
  const store = await service.ensure();
  store.setSetting('flags', { intake: true, runs: true, model: true, financial: false, settlement: false, browser: false, influencer: true, ...flags }, 'test');
  const x = new FakeX(), hf = new FakeHiggsfield();
  x.add(X_ID, { accountId: 'acct-2', handle: 'goat_agent' }); x.add(X_ID_2, { accountId: 'acct-2', handle: 'second_goat' }); x.add(OTHER_X, { accountId: 'acct-3', handle: 'eve_x' });
  service.xAccounts = x; service.influencer.higgsfield = hf; service.influencer.vision = vision;
  // No ffmpeg unless a test installs a fake tool (the 30-second feature clip needs it); never probe the host from here.
  service.influencer.ffmpegState = { ok: false, at: Infinity, tool: null };
  return { service, store, dir, now, tick, x, hf, vision, books, config };
}
const launchRequest = (over = {}) => ({ mode: AGENT_MODE, venue: 'raydium', mission: 'Research goat markets and publish honest updates.', personalityPreset: 'analyst', personality: '', model: MODEL, domains: [], buyback: false, rewards: false, capabilities: capabilityMask({ buyback: true }), objective: 'custom', objectiveSettings: {}, ...over });
const influencerRequest = (over = {}) => influencerLaunchRequest({ enabled: true, postToX: true, xAccountId: X_ID, cadenceHours: 6, dailyPosts: 4, coinLink: true, character: true, source: 'tiles', kind: 'person', tiles: { presentsAs: 'woman', age: '30s', hair: 'curly', style: 'anime' }, media: 'images', dailyImages: 2, dailyVideos: 0, ...over });
/** A live agent with an attached influencer, created directly (the launch path has its own test). */
async function liveAgent(f, { influencer = influencerRequest(), fund = 10000000n, accountId = 'acct-2' } = {}) {
  const { service, store } = f, mint = wallet();
  const agent = store.createAgent({ mint, route: 'raydium', launchId: 'l-' + mint.slice(0, 5), accountId, wallet: wallet(), name: 'Granite Goat', symbol: 'GOAT', policyHash: AGENT_POLICY_V2_HASH, policyVersion: AGENT_POLICY_V2.version, capabilities: capabilityMask({ buyback: true }), model: MODEL, mission: 'Research goats.', state: 'ready', launchState: 'live' });
  if (fund > 0n) store.ledger.post({ kind: 'backing', sourceKey: 'test:fund:' + agent.id, agentId: agent.id, entries: [{ owner: EXTERNAL.provider, asset: ASSET.USD, bucket: 'main', delta: -fund }, { owner: agentOwner(agent.id), asset: ASSET.USD, bucket: 'operating_backed', delta: fund }] });
  if (influencer) await service.influencer.attach(agent, influencer, { accountId });
  return store.agent(agent.id);
}
const usd = (store, agentId) => { const b = store.agentBalances(agentId).usd; return { backed: BigInt(b.backed), reserved: BigInt(b.reserved), spent: BigInt(b.spent) }; };
/** Runs scheduler passes with the clock moving so poll back-offs elapse. */
async function passes(f, count, step = 15000) { for (let i = 0; i < count; i++) { f.tick(step); await f.service.influencer.tick(); } }
/** A finished run row, so usage events have a run to point at (one post per run is keyed by its id). */
const runFor = (store, agent) => { const run = store.createRun({ agentId: agent.id, trigger: 'test', policyHash: agent.policyHash, model: agent.model, revision: agent.revision }); return store.updateRun(run.id, { state: 'completed', finishedAt: store.now() }); };

test('migration v4 adds the influencer tables to a v3 database; spec and request are JSON columns; rows round-trip', async () => {
  assert.equal(AGENT_SCHEMA_VERSION, 6); assert.equal(MIGRATIONS[3].name, 'influencer'); assert.equal(MIGRATIONS[4].name, 'influencer-feature-clip'); assert.equal(MIGRATIONS[5].name, 'agent-moderation');
  const dir = await mkdtemp(join(tmpdir(), 'influencer-migrate-')), path = join(dir, 'agents.sqlite'), NOW = Date.UTC(2026, 9, 4);
  const legacy = new DatabaseSync(path);
  legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  for (const migration of MIGRATIONS.slice(0, 3)) { legacy.exec(migration.sql); legacy.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, NOW - DAY); }
  legacy.prepare('INSERT INTO agent_policies(hash, version, document, rate_card, created_at) VALUES (?, ?, ?, ?, ?)').run(AGENT_POLICY_HASH, AGENT_POLICY_V1.version, '{}', '{}', NOW - DAY);
  const MINT = 'GoatCoin1111111111111111111111111111111111', WALLET = 'AgentWa11et111111111111111111111111111111';
  legacy.prepare(`INSERT INTO agents(id, chain, mint, route, launch_id, account_id, wallet, name, symbol, policy_hash, policy_version, capabilities, model, state, mission, created_at, updated_at) VALUES (?, 'solana', ?, 'raydium', 'l1', 'acct-1', ?, 'Old', 'OLD', ?, ?, 7, 'm', 'ready', 'Old mission.', ?, ?)`).run('d'.repeat(24), MINT, WALLET, AGENT_POLICY_HASH, AGENT_POLICY_V1.version, NOW - DAY, NOW - DAY);
  legacy.close();
  const db = await openAgentDatabase(path, { now: () => NOW });
  assert.equal(db.version(), 6); assert.ok(db.all("PRAGMA table_info(influencers)").some(column => column.name === "feature_today"), "v5 adds the feature clip counter");
  assert.deepEqual(db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('x_oauth_states', 'x_accounts', 'influencers', 'media_jobs', 'x_posts') ORDER BY name").map(row => row.name), ['influencers', 'media_jobs', 'x_accounts', 'x_oauth_states', 'x_posts']);
  const store = new AgentStore(db, { now: () => NOW }), id = 'd'.repeat(24);
  assert.equal(store.influencer(id), null);
  const inf = store.createInfluencer(id, { spec: { postToX: true, dailyPosts: 4, tiles: { kind: 'person' } }, prompt: 'The same original character', state: 'pending' });
  assert.equal(inf.agentId, id); assert.equal(inf.version, 1); assert.deepEqual(inf.spec, { postToX: true, dailyPosts: 4, tiles: { kind: 'person' } }); assert.equal(inf.state, 'pending'); assert.equal(inf.postsToday, 0);
  assert.throws(() => store.createInfluencer(id, { spec: {}, state: 'pending' }), /already has an influencer/);
  assert.throws(() => store.updateInfluencer(id, { state: 'bogus' }), /Invalid influencer state/);
  assert.throws(() => store.updateInfluencer(id, { agentId: 'e'.repeat(24) }), /cannot be updated/);
  assert.throws(() => store.updateInfluencer(id, { spec: 'text' }), /must be an object/);
  assert.equal(store.updateInfluencer(id, { state: 'ready', postingPaused: true, consistency: 88, nextPostAt: NOW + HOUR }).postingPaused, 1);
  db.run('UPDATE influencers SET spec = ? WHERE agent_id = ?', '{broken', id); assert.deepEqual(store.influencer(id).spec, {}, 'a damaged spec reads as an object');
  assert.equal(store.influencers({ states: ['ready'] }).length, 1); assert.equal(store.influencers({ states: ['pending'] }).length, 0); assert.equal(store.influencers().length, 1);
  // Media jobs and posts: JSON request, bounded states, reservations that settle once.
  const job = store.createMediaJob({ agentId: id, kind: 'image', stage: 'edit', model: 'alibaba/qwen-image-3/edit', request: { params: { prompt: 'p' }, batch: 1 } });
  assert.deepEqual(job.request, { params: { prompt: 'p' }, batch: 1 }); assert.equal(job.state, 'queued'); assert.equal(job.provider, 'higgsfield');
  assert.throws(() => store.createMediaJob({ agentId: id, kind: 'gif' }), /Unsupported media job kind/);
  assert.throws(() => store.updateMediaJob(job.id, { state: 'done' }), /Invalid media job state/);
  assert.throws(() => store.updateMediaJob(job.id, { agentId: id }), /cannot be updated/);
  assert.equal(store.openMediaJobs(10).length, 1); assert.equal(store.allOpenMediaJobs().length, 1); assert.equal(store.mediaJobs(id, { kinds: ['image'] }).length, 1); assert.equal(store.mediaJobs(id, { kinds: ['video'] }).length, 0);
  store.ledger.post({ kind: 'backing', sourceKey: 'test:fund', agentId: id, entries: [{ owner: EXTERNAL.provider, asset: ASSET.USD, bucket: 'main', delta: -100000n }, { owner: agentOwner(id), asset: ASSET.USD, bucket: 'operating_backed', delta: 100000n }] });
  assert.equal(store.reserveMedia(job.id, '15000').reservedUsd, '15000'); store.reserveMedia(job.id, '15000');
  assert.deepEqual(usd(store, id), { backed: 85000n, reserved: 15000n, spent: 0n }, 'the reservation posts once');
  assert.equal(store.settleMedia(job.id, { spentUsd: '20000' }).costUsd, '15000', 'spend is capped at the reservation'); store.settleMedia(job.id, { spentUsd: '1' });
  assert.deepEqual(usd(store, id), { backed: 85000n, reserved: 0n, spent: 15000n });
  assert.throws(() => store.reserveMedia('f'.repeat(24), '1'), /not found/);
  const post = store.createXPost({ agentId: id, kind: 'text', text: 'gm', link: 'https://launchpad.test/coin?mint=' + MINT });
  assert.equal(post.state, 'queued'); assert.equal(post.link, 'https://launchpad.test/coin?mint=' + MINT);
  assert.throws(() => store.createXPost({ agentId: id, kind: 'gif', text: 'x' }), /Unsupported post kind/);
  assert.throws(() => store.createXPost({ agentId: id, kind: 'text', text: '' }), /Invalid post text/);
  assert.throws(() => store.updateXPost(post.id, { state: 'sent' }), /Invalid post state/);
  assert.throws(() => store.reservePost(post.id, '200000'), error => error.code === 'AGENT_LEDGER_INSUFFICIENT', 'a reservation never exceeds the backed credit');
  store.reservePost(post.id, '20000'); store.reservePost(post.id, '20000');
  assert.deepEqual(usd(store, id), { backed: 65000n, reserved: 20000n, spent: 15000n });
  store.settlePost(post.id, { spentUsd: '0' }); store.settlePost(post.id, { spentUsd: '20000' });
  assert.deepEqual(usd(store, id), { backed: 85000n, reserved: 0n, spent: 15000n }, 'an undelivered post refunds everything, once');
  assert.equal(store.openXPosts(10).length, 1); assert.equal(store.xPosts(id, { states: ['queued'] }).length, 1); assert.equal(store.xPosts(id, { runId: 'nope' }).length, 0);
  assert.equal(store.postsToday(id, '2026-10-04'), 1); assert.equal(store.postsToday(id, '2026-10-03'), 0); assert.equal(store.postsToday(id, 'today'), 0); assert.equal(store.postedToday('2026-10-04'), 0);
  assert.equal(store.ledger.verify().ok, true);
  db.close();
});

test('placeholder PNGs are valid, image inspection recognizes PNG/JPEG/WebP magic bytes only, and vision replies parse defensively', () => {
  const png = placeholderPng('a prompt');
  assert.deepEqual(png.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex')); assert.equal(png.toString('ascii', 12, 16), 'IHDR'); assert.equal(png.toString('ascii', png.length - 8, png.length - 4), 'IEND');
  assert.deepEqual(inspectImage(png), { ext: 'png', type: 'image/png', width: 256, height: 256 });
  assert.notDeepEqual(placeholderPng('other'), png, 'the colour follows the seed'); assert.deepEqual(placeholderPng('a prompt'), png, 'and is deterministic');
  assert.equal(inspectImage(Buffer.from('not an image at all, just text bytes')), null); assert.equal(inspectImage(Buffer.alloc(10)), null);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 200, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.alloc(8), Buffer.from([0xff, 0xd9])]);
  assert.deepEqual(inspectImage(jpeg), { ext: 'jpg', type: 'image/jpeg', width: 200, height: 100 });
  assert.deepEqual(parseCheck('Here you go: {"sameCharacter": 83.4, "appearsMinor": false, "realPersonLikeness": "true", "nsfw": 0, "hasText": true} thanks'), { sameCharacter: 83, appearsMinor: false, realPersonLikeness: true, nsfw: false, hasText: true });
  assert.deepEqual(parseCheck('{"sameCharacter": 250}'), { sameCharacter: 100, appearsMinor: false, realPersonLikeness: false, nsfw: false, hasText: false });
  assert.equal(parseCheck('no json here'), null); assert.equal(parseCheck(''), null); assert.equal(parseCheck('{"sameCharacter": broken'), null);
});

test('launchTarget validates the influencer option, attaches the record inside the lock, returns it in the attachment and releases the X account with the draft', async () => {
  const f = await fixture(), { service, store, x, tick } = f;
  const launch = (influencer, extra = {}) => service.launchTarget(launchRequest({ influencer, ...extra }), { accountId: 'acct-2', venue: 'raydium', name: 'Granite Goat', symbol: 'GOAT' });
  const first = await launch(influencerRequest());
  assert.deepEqual(first.influencer, { postToX: true, character: true, media: 'images' }); assert.equal(first.version, 1);
  const inf = store.influencer(first.id);
  assert.equal(inf.state, 'pending'); assert.equal(inf.spec.name, 'Granite Goat'); assert.equal(inf.spec.symbol, 'GOAT'); assert.ok(inf.spec.seed >= 1 && inf.spec.seed <= 1000000); assert.equal(inf.spec.xAccountId, X_ID); assert.equal(inf.spec.dailyPosts, 4);
  assert.match(inf.prompt, /^The same original character every time, the face of the coin Granite Goat \(GOAT\): an original fictional adult person, a woman in their thirties/);
  assert.equal(x.rows.get(X_ID).agentId, first.id, 'the X account is claimed for the agent');
  const again = await launch(influencerRequest()); assert.equal(again.id, first.id); assert.deepEqual(again.influencer, first.influencer, 'a re-provisioned draft carries the attachment again');
  const plain = await launch(undefined, { mission: 'no influencer' }); assert.equal('influencer' in plain, false, 'agents without the option keep the hashed attachment shape');
  // X only, and the X account of another Launchpad account.
  const xOnly = await launch(influencerRequest({ character: false, xAccountId: X_ID_2 }), { mission: 'x only' }); assert.deepEqual(xOnly.influencer, { postToX: true, character: false, media: 'text' }); assert.equal(store.influencer(xOnly.id).prompt, '');
  await assert.rejects(launch(influencerRequest({ xAccountId: OTHER_X }), { mission: 'stolen' }), error => error.statusCode === 400 && /Connect the X account/.test(error.message));
  const stray = store.allAgents({ includeArchived: true }).find(agent => agent.mission === 'stolen'); assert.equal(stray.archived, 1); assert.equal(stray.draftKey, null, 'a refused attachment leaves no reusable draft');
  await assert.rejects(launch(influencerRequest({ source: 'reference', referenceId: 'f'.repeat(64) + '.png' }), { mission: 'ref' }), /Upload the reference image again/);
  // Host switches: the option, then X, then media.
  store.setSetting('flags', { ...service.flags(), influencer: false }, 'test');
  await assert.rejects(launch(influencerRequest(), { mission: 'closed' }), error => error.statusCode === 400 && error.message === INFLUENCER_TEXT.unavailable);
  store.setSetting('flags', { ...service.flags(), influencer: true }, 'test');
  const noX = await fixture({ config: { xClientId: '' } });
  await assert.rejects(noX.service.launchTarget(launchRequest({ influencer: influencerRequest() }), { accountId: 'acct-2', venue: 'raydium' }), /not available right now/);
  assert.equal((await noX.service.launchTarget(launchRequest({ influencer: influencerRequest({ postToX: false, xAccountId: '' }) }), { accountId: 'acct-2', venue: 'raydium' })).influencer.postToX, false, 'a character-only influencer launches without X');
  const noMedia = await fixture({ config: { higgsfieldKey: '' } });
  await assert.rejects(noMedia.service.launchTarget(launchRequest({ influencer: influencerRequest() }), { accountId: 'acct-2', venue: 'raydium' }), /not available right now/);
  // An abandoned draft frees its X account and disables the record.
  tick(3 * HOUR); await service.syncLaunches();
  assert.ok(x.released.includes(first.id)); assert.equal(store.influencer(first.id).state, 'disabled'); assert.equal(x.rows.get(X_ID).agentId, null);
  assert.equal(store.ledger.verify().ok, true);
  service.close(); noX.service.close(); noMedia.service.close();
});

test('character pipeline: four 1080p candidates reserved first, checked one by one, the best kept as the master, the sheet from the edit model, all settled once', async () => {
  const vision = fakeVision([60, 85, 92, 40, 95]), f = await fixture({ vision }), { service, store, hf, dir } = f;
  const agent = await liveAgent(f);
  const before = usd(store, agent.id);
  await service.influencer.tick();
  let inf = store.influencer(agent.id); assert.equal(inf.state, 'generating'); assert.equal(inf.generations, 1);
  const master = store.mediaJobs(agent.id, { kinds: ['master'] })[0];
  assert.equal(master.state, 'submitted'); assert.equal(master.kind, 'master'); assert.equal(master.model, 'higgsfield-ai/soul/v2/standard'); assert.equal(master.providerRequestId, 'req-1');
  assert.equal(master.reservedUsd, (4n * BigInt(CARD.imageHdUsd) + 4n * BigInt(CARD.mediaCheckUsd)).toString()); assert.equal(master.reservedUsd, '80000');
  assert.deepEqual(usd(store, agent.id), { backed: before.backed - 80000n, reserved: 80000n, spent: 0n });
  assert.equal(store.agent(agent.id).daySpentUsd, '80000', 'reservations count against the daily budget');
  assert.equal(hf.submits[0].kind, 'image'); assert.equal(hf.submits[0].params.resolution, '1080p'); assert.equal(hf.submits[0].params.batch, 4); assert.equal(hf.submits[0].params.prompt, inf.prompt); assert.match(hf.submits[0].idempotencyKey, /^media:[a-f0-9]{24}:image:1$/);
  assert.equal(store.ledger.verify().ok, true);
  await passes(f, 2);
  inf = store.influencer(agent.id);
  assert.equal(inf.state, 'ready', inf.stateReason); assert.equal(inf.masterFile, 'master.png'); assert.equal(inf.consistency, 92);
  assert.equal(store.mediaJobs(agent.id, { kinds: ['sheet'] })[0].state, 'queued', 'the sheet starts once the master is kept');
  await passes(f, 3); inf = store.influencer(agent.id);
  assert.ok(existsSync(join(dir, 'media', agent.id, 'master.png'))); assert.deepEqual(inspectImage(readFileSync(join(dir, 'media', agent.id, 'master.png'))).ext, 'png');
  assert.equal(readdirSync(join(dir, 'media', agent.id)).filter(name => name.startsWith('tmp-')).length, 0, 'the other candidates are deleted');
  assert.equal(vision.calls.length, 5, 'four master candidates and one sheet'); assert.equal(vision.calls[0].images, 1, 'the master pass compares against the description'); assert.match(vision.calls[0].text, /sameCharacter/); assert.equal(vision.calls[4].images, 2, 'the sheet is compared against the master');
  const done = store.mediaJob(master.id); assert.equal(done.state, 'succeeded'); assert.equal(done.file, 'master.png'); assert.equal(done.score, 92); assert.equal(done.costUsd, '80000');
  assert.equal(store.mediaJobs(agent.id, { kinds: ['check'] }).length, 5, 'every vision call leaves a check row');
  const sheet = store.mediaJobs(agent.id, { kinds: ['sheet'] })[0]; assert.equal(sheet.state, 'succeeded'); assert.equal(sheet.model, 'alibaba/qwen-image-3/edit'); assert.equal(inf.sheetFile, 'sheet.png');
  assert.equal(hf.submits[1].kind, 'edit'); assert.deepEqual(hf.submits[1].params.imageUrls, ['https://media.test/up-1.png']); assert.equal(hf.uploads[0].type, 'image/png');
  assert.deepEqual(usd(store, agent.id), { backed: before.backed - 80000n - 60000n, reserved: 0n, spent: 140000n }, 'four pictures and their checks, then the edit-model sheet and its check'); assert.equal(store.agent(agent.id).daySpentUsd, '140000');
  assert.equal(store.ledger.verify().ok, true);
  const events = store.events(agent.id, { limit: 10 }); assert.ok(events.some(event => event.kind === 'character' && event.title === 'Character ready' && /score 92/.test(event.body)));
  const view = service.influencer.view(store.agent(agent.id));
  assert.equal(view.state, 'ready'); assert.equal(view.avatarUrl, `/influencer-media/${agent.id}/master.png`); assert.equal(view.sheetUrl, `/influencer-media/${agent.id}/sheet.png`); assert.equal(view.consistency, 92); assert.equal(view.regenerationsLeft, 3); assert.equal(view.handle, 'goat_agent'); assert.equal(view.xUrl, 'https://x.com/goat_agent'); assert.equal(view.tiles, 'Woman · Thirties · Curly · Streetwear · Anime');
  assert.equal(service.influencer.postingAllowed(store.agent(agent.id), f.now()), true);
  service.close();
});

test('low scores retry once with a new seed, then the character fails; the creator can regenerate within the limit; refused and nsfw candidates are not retried', async () => {
  const f = await fixture({ vision: fakeVision([30, 20, 10, 50, 65, 69, 1, 0]) }), { service, store, hf } = f;
  const agent = await liveAgent(f);
  await service.influencer.tick(); await passes(f, 3);
  let inf = store.influencer(agent.id);
  assert.equal(inf.state, 'generating', 'the first round retries'); assert.equal(hf.submits.length, 2); assert.notEqual(hf.submits[0].params.seed, hf.submits[1].params.seed); assert.match(hf.submits[1].idempotencyKey, /:image:1$/, 'a new job, not a resubmission');
  const jobs = store.mediaJobs(agent.id, { kinds: ['master'] }); assert.equal(jobs.length, 2); assert.equal(jobs[1].error, INFLUENCER_TEXT.lowScore); assert.equal(jobs[1].costUsd, '80000', 'generated pictures are charged even when none is kept');
  await passes(f, 2);
  inf = store.influencer(agent.id); assert.equal(inf.state, 'failed'); assert.equal(inf.stateReason, INFLUENCER_TEXT.lowScore); assert.equal(inf.generations, 1);
  assert.deepEqual(usd(store, agent.id), { backed: 10000000n - 160000n, reserved: 0n, spent: 160000n }); assert.equal(store.ledger.verify().ok, true);
  assert.ok(store.events(agent.id, { limit: 10 }).some(event => event.title === 'Character failed'));
  const view = service.influencer.view(store.agent(agent.id)); assert.equal(view.state, 'failed'); assert.equal(view.avatarUrl, null); assert.equal(view.regenerationsLeft, 3);
  // Regenerate: a new round, counted; the creator can ask three times.
  const session = { account: { id: 'acct-2' } };
  const regenerated = await service.influencer.control(session, { mint: agent.mint, regenerate: true }); assert.equal(regenerated.state, 'generating');
  await assert.rejects(service.influencer.control(session, { mint: agent.mint, regenerate: true }), error => error.statusCode === 409);
  f.vision.calls.length = 0; service.influencer.vision = fakeVision([{ sameCharacter: 95, realPersonLikeness: true }, 99, 71, 70]);
  await service.influencer.tick(); await passes(f, 2);
  inf = store.influencer(agent.id); assert.equal(inf.state, 'ready'); assert.equal(inf.generations, 2); assert.equal(inf.consistency, 99); assert.equal(service.influencer.view(store.agent(agent.id)).regenerationsLeft, 2);
  assert.ok(store.mediaJobs(agent.id, { kinds: ['check'] }).some(check => check.request?.verdict?.realPersonLikeness === true), 'a real-person likeness is recorded and the candidate discarded');
  // nsfw from the provider: refused, no retry, nothing charged.
  const g = await fixture(), second = await liveAgent(g); g.hf.outcomes.push('nsfw');
  await g.service.influencer.tick(); await passes(g, 2);
  assert.equal(g.store.influencer(second.id).state, 'failed'); assert.equal(g.store.influencer(second.id).stateReason, INFLUENCER_TEXT.nsfw); assert.equal(g.hf.submits.length, 1, 'a refusal is not retried');
  assert.deepEqual(usd(g.store, second.id), { backed: 10000000n, reserved: 0n, spent: 0n }, 'the provider does not charge nsfw: full refund'); assert.equal(g.store.agent(second.id).daySpentUsd, '0'); assert.equal(g.store.ledger.verify().ok, true);
  // A provider failure retries once (no charge) and the raw provider error never reaches the row.
  const h = await fixture(), third = await liveAgent(h); h.hf.outcomes.push('failed', 'failed');
  await h.service.influencer.tick(); await passes(h, 5);
  assert.equal(h.store.influencer(third.id).state, 'failed'); assert.equal(h.store.influencer(third.id).stateReason, INFLUENCER_TEXT.providerFailed); assert.equal(h.hf.submits.length, 2);
  assert.ok(h.store.mediaJobs(third.id).every(job => !/internal-secret-detail/.test(job.error))); assert.deepEqual(usd(h.store, third.id).spent, 0n);
  service.close(); g.service.close(); h.service.close();
});

test('a round interrupted by the daily budget waits and continues with its retry on the next day; rounds are counted when they start', async () => {
  const f = await fixture({ vision: fakeVision([10, 10, 10, 10]) }), { service, store, hf } = f;
  const agent = await liveAgent(f, { fund: 500000n }); // 20% of 500000 = 100000 a day: one four-candidate pass (80000) fits, its retry does not; the next day's 20% of 420000 = 84000 does
  await service.influencer.tick(); await passes(f, 2);
  let inf = store.influencer(agent.id);
  assert.equal(inf.state, 'generating'); assert.equal(inf.stateReason, INFLUENCER_TEXT.budget, 'the retry could not be reserved'); assert.equal(inf.generations, 1); assert.equal(hf.submits.length, 1);
  assert.deepEqual(usd(store, agent.id), { backed: 420000n, reserved: 0n, spent: 80000n });
  await passes(f, 2); assert.equal(hf.submits.length, 1, 'nothing is submitted over the budget'); assert.equal(store.influencer(agent.id).generations, 1, 'and no new round is counted');
  f.tick(DAY); await passes(f, 1);
  const jobs = store.mediaJobs(agent.id, { kinds: ['master'] }); assert.equal(jobs.length, 2); assert.equal(jobs[0].request.attempt, 2); assert.equal(jobs[0].request.round, 1); assert.equal(jobs[0].state, 'submitted'); assert.equal(hf.submits.length, 2);
  await passes(f, 2);
  inf = store.influencer(agent.id); assert.equal(inf.state, 'ready'); assert.equal(inf.generations, 1); assert.equal(service.influencer.view(store.agent(agent.id)).regenerationsLeft, 3);
  assert.deepEqual(usd(store, agent.id), { backed: 340000n, reserved: 0n, spent: 160000n }); assert.equal(store.ledger.verify().ok, true);
  service.close();
});

test('posting: the tool reserves the post and its media, the pipeline generates with the master as reference, checks, delivers with the coin link and settles exactly once', async () => {
  const f = await fixture(), { service, store, hf, x, dir } = f;
  // A two-hour cadence keeps four posts inside one UTC day (the fixture clock starts at noon).
  const agent = await liveAgent(f, { influencer: influencerRequest({ cadenceHours: 2 }) });
  await service.influencer.tick(); await passes(f, 5);
  assert.equal(store.influencer(agent.id).state, 'ready'); assert.equal(usd(store, agent.id).reserved, 0n, 'master and sheet are settled');
  const start = usd(store, agent.id), day = BigInt(store.agent(agent.id).daySpentUsd), run = runFor(store, agent), fresh = store.agent(agent.id);
  const context = service.influencer.promptContext(fresh);
  assert.equal(context.canPost, true); assert.equal(context.handle, 'goat_agent'); assert.equal(context.postsLeftToday, 4); assert.equal(context.imagesLeftToday, 2); assert.equal(context.videosLeftToday, 0); assert.equal(context.media, 'images'); assert.equal(context.coinLink, true); assert.match(context.character, /original fictional adult person/);
  await assert.rejects(service.influencer.requestPost(fresh, run.id, { text: 'buy now, guaranteed profit $GOAT' }), error => error.code === 'AGENT_TOOL' && /promise/.test(error.message));
  await assert.rejects(service.influencer.requestPost(fresh, run.id, { text: 'see https://evil.example' }), /links/);
  const result = await service.influencer.requestPost(fresh, run.id, { text: 'gm from the studio #goat', media: 'image', mediaBrief: 'sipping coffee at dawn, visit https://evil.example now' });
  assert.equal(result.queued, true); assert.equal(result.media, 'image'); assert.equal(result.deliversWithin, 'minutes'); assert.match(result.postId, /^[a-f0-9]{24}$/); assert.equal('link' in result, false, 'the model never sees the link');
  const post = store.xPost(result.postId);
  assert.equal(post.state, 'generating'); assert.equal(post.kind, 'image'); assert.equal(post.link, 'https://launchpad.test/coin?mint=' + agent.mint); assert.equal(post.runId, run.id); assert.equal(post.xAccountId, X_ID); assert.equal(post.reservedUsd, String(CARD.xPostLinkUsd));
  const job = store.mediaJob(post.mediaJobId); assert.equal(job.kind, 'image'); assert.equal(job.stage, 'edit'); assert.equal(job.postId, post.id); assert.equal(job.runId, run.id); assert.equal(job.reservedUsd, String(CARD.editUsd + CARD.mediaCheckUsd)); assert.equal(job.request.brief, 'sipping coffee at dawn, visit now'); assert.deepEqual(job.request.uploads, ['master.png']);
  assert.deepEqual(usd(store, agent.id), { backed: start.backed - 280000n, reserved: 280000n, spent: start.spent }, 'the link post ($0.22) plus an edited picture ($0.05) and its check ($0.01)'); assert.equal(BigInt(store.agent(agent.id).daySpentUsd), day + 280000n);
  let inf = store.influencer(agent.id); assert.equal(inf.postsToday, 1); assert.equal(inf.imagesToday, 1); assert.equal(inf.nextPostAt, f.now() + 2 * HOUR);
  assert.equal(service.influencer.postingAllowed(store.agent(agent.id), f.now()), false, 'the cadence gate closes');
  await assert.rejects(service.influencer.requestPost(store.agent(agent.id), run.id, { text: 'again' }), /not available this run/);
  assert.deepEqual(store.usage(run.id).map(row => [row.provider, row.kind, row.state]), [['x', 'post', 'estimated'], ['higgsfield', 'image', 'estimated']]);
  await service.influencer.tick();
  assert.equal(store.xPost(post.id).state, 'generating'); assert.equal(hf.submits.at(-1).kind, 'edit'); assert.match(hf.submits.at(-1).params.prompt, /New scene: sipping coffee at dawn, visit now\./); assert.deepEqual(hf.submits.at(-1).params.imageUrls, [`https://media.test/up-${hf.uploads.length}.png`]);
  await passes(f, 2);
  const posted = store.xPost(post.id);
  assert.equal(posted.state, 'posted', posted.error); assert.equal(posted.xPostId, 'x-1'); assert.equal(posted.url, 'https://x.com/i/web/status/1'); assert.equal(posted.postedAt, f.now()); assert.equal(posted.costUsd, String(CARD.xPostLinkUsd));
  assert.equal(x.posts.length, 1); assert.equal(x.posts[0].xAccountId, X_ID); assert.equal(x.posts[0].text, 'gm from the studio #goat\nhttps://launchpad.test/coin?mint=' + agent.mint); assert.deepEqual(x.posts[0].media, { kind: 'image', contentType: 'image/png', bytes: readFileSync(join(dir, 'media', agent.id, post.id + '.png')).length });
  assert.equal(store.mediaJob(job.id).state, 'succeeded'); assert.equal(store.mediaJob(job.id).file, post.id + '.png'); assert.equal(store.mediaJob(job.id).costUsd, '60000');
  assert.deepEqual(usd(store, agent.id), { backed: start.backed - 280000n, reserved: 0n, spent: start.spent + 280000n }); assert.equal(store.ledger.verify().ok, true);
  assert.equal(store.influencer(agent.id).lastPostAt, f.now());
  const event = store.events(agent.id, { limit: 5 }).find(item => item.title === 'Posted to X'); assert.equal(event.body, 'gm from the studio #goat'); assert.deepEqual(event.data, { url: 'https://x.com/i/web/status/1', kind: 'image', mediaUrl: `/influencer-media/${agent.id}/${post.id}.png` });
  const view = service.influencer.view(store.agent(agent.id));
  assert.equal(view.posts.length, 1); assert.deepEqual(Object.keys(view.posts[0]).sort(), ['at', 'feature', 'id', 'kind', 'mediaUrl', 'note', 'postedAt', 'seconds', 'state', 'stateLabel', 'text', 'url']); assert.equal(view.posts[0].feature, false); assert.equal(view.posts[0].seconds, 0); assert.equal(view.posts[0].stateLabel, 'Posted'); assert.equal(view.posts[0].mediaUrl, `/influencer-media/${agent.id}/${post.id}.png`); assert.deepEqual(view.today, { posts: 1, images: 1, videos: 0, feature: 0 }); assert.deepEqual(view.featureClip, { seconds: 0, usedToday: false, available: false, lengths: [10, 15], costsUsd: { 10: "1310000", 15: "1910000", 30: "3760000" } });
  // Text only: delivered on the next pass without media; a second post in the same run is refused; the cap of pictures downgrades a request to text with a note.
  f.tick(2 * HOUR); const run2 = runFor(store, agent);
  const again = await service.influencer.requestPost(store.agent(agent.id), run2.id, { text: 'quiet day, reading the order book' });
  assert.equal(again.media, 'none'); await service.influencer.tick();
  assert.equal(store.xPost(again.postId).state, 'posted'); assert.equal(x.posts[1].media, null); assert.equal(x.posts[1].text, 'quiet day, reading the order book\nhttps://launchpad.test/coin?mint=' + agent.mint);
  await assert.rejects(service.influencer.requestPost(store.agent(agent.id), run2.id, { text: 'twice' }), /not available this run/);
  f.tick(HOUR); assert.equal(service.influencer.postingAllowed(store.agent(agent.id), f.now()), false, 'the cadence gate');
  f.tick(HOUR); const run3 = runFor(store, agent);
  const downgraded = await service.influencer.requestPost(store.agent(agent.id), run3.id, { text: 'third post of the day', media: 'image' });
  assert.equal(downgraded.media, 'image', 'two pictures a day are allowed');
  f.tick(2 * HOUR); const run4 = runFor(store, agent);
  const capped = await service.influencer.requestPost(store.agent(agent.id), run4.id, { text: 'fourth post of the day', media: 'video' });
  assert.equal(capped.media, 'none'); assert.match(capped.note, /Clips are not enabled.*picture allowance is used/);
  f.tick(2 * HOUR); assert.equal(service.influencer.postingAllowed(store.agent(agent.id), f.now()), false, 'four posts a day');
  f.tick(DAY); assert.equal(service.influencer.postingAllowed(store.agent(agent.id), f.now()), true, 'a new UTC day resets the counters');
  assert.equal(service.influencer.promptContext(store.agent(agent.id)).recentPosts.length, 3);
  assert.equal(store.ledger.verify().ok, true);
  service.close();
});

test('video posts: the checked picture becomes the clip’s first frame, the clip is uploaded as video and the whole reservation settles; Soul 2 with the stored seed when the edit model is off', async () => {
  const f = await fixture(), { service, store, hf, x } = f;
  const agent = await liveAgent(f, { influencer: influencerRequest({ media: 'video', dailyImages: 2, dailyVideos: 1 }) });
  await service.influencer.tick(); await passes(f, 5);
  const run = runFor(store, agent), start = usd(store, agent.id); assert.equal(start.reserved, 0n);
  const result = await service.influencer.requestPost(store.agent(agent.id), run.id, { text: 'a short clip from the floor', media: 'video', mediaBrief: 'waving at the camera' });
  assert.equal(result.media, 'video');
  const post = store.xPost(result.postId), job = store.mediaJob(post.mediaJobId);
  assert.equal(job.kind, 'video'); assert.equal(job.stage, 'edit'); assert.equal(job.reservedUsd, String(CARD.editUsd + CARD.mediaCheckUsd + CARD.videoSecondUsd * 5 + CARD.videoOverheadUsd)); assert.equal(job.reservedUsd, '710000');
  await passes(f, 6);
  const done = store.mediaJob(job.id);
  assert.equal(done.state, 'succeeded', done.error); assert.equal(done.stage, 'video'); assert.equal(done.file, post.id + '.mp4'); assert.equal(done.request.poster, post.id + '.png'); assert.equal(done.costUsd, '710000');
  const video = hf.submits.find(item => item.kind === 'video'); assert.ok(video); assert.equal(video.params.duration, 5); assert.equal(video.params.resolution, '720p'); assert.match(video.params.imageUrl, /^https:\/\/media\.test\/up-/); assert.match(video.params.prompt, /waving at the camera/);
  assert.equal(store.xPost(post.id).state, 'posted'); assert.deepEqual(x.posts.at(-1).media, { kind: 'video', contentType: 'video/mp4', bytes: fakeMp4().length });
  assert.deepEqual(usd(store, agent.id), { backed: start.backed - 710000n - 220000n, reserved: 0n, spent: start.spent + 930000n }); assert.equal(store.ledger.verify().ok, true);
  assert.equal(service.influencer.view(store.agent(agent.id)).posts[0].mediaUrl, `/influencer-media/${agent.id}/${post.id}.mp4`);
  // Without the edit model: pictures come from Soul 2 with the fixed prompt, the brief and the stored seed.
  hf.editEnabled = false; f.tick(6 * HOUR); const run2 = runFor(store, agent);
  const second = await service.influencer.requestPost(store.agent(agent.id), run2.id, { text: 'another one', media: 'image', mediaBrief: 'at the desk' });
  assert.equal(second.media, 'image'); await service.influencer.tick();
  const soul = hf.submits.at(-1); assert.equal(soul.kind, 'image'); assert.equal(soul.params.seed, store.influencer(agent.id).spec.seed); assert.equal(soul.params.resolution, '720p'); assert.match(soul.params.prompt, /Scene: at the desk\.$/); assert.ok(soul.params.prompt.startsWith(store.influencer(agent.id).prompt));
  service.close();
});

test('a picture that fails its check is regenerated once, then the post goes out as text with a note; media failures refund the unused reservation', async () => {
  const f = await fixture(), { service, store, x } = f;
  const agent = await liveAgent(f);
  await service.influencer.tick(); await passes(f, 5);
  service.influencer.vision = fakeVision([20, 30]);
  const run = runFor(store, agent), start = usd(store, agent.id); assert.equal(start.reserved, 0n);
  const result = await service.influencer.requestPost(store.agent(agent.id), run.id, { text: 'hello', media: 'image', mediaBrief: 'on a rooftop' });
  const firstJob = store.xPost(result.postId).mediaJobId;
  await passes(f, 3);
  const post = store.xPost(result.postId); assert.equal(post.state, 'generating'); assert.notEqual(post.mediaJobId, firstJob, 'a second job replaced the first'); assert.equal(store.mediaJob(firstJob).state, 'failed'); assert.equal(store.mediaJob(post.mediaJobId).request.brief, 'on a rooftop', 'with the same brief');
  await passes(f, 3);
  const final = store.xPost(result.postId);
  assert.equal(final.state, 'posted'); assert.equal(final.kind, 'text'); assert.equal(final.error, INFLUENCER_TEXT.postLowScore); assert.equal(x.posts.at(-1).media, null);
  const jobs = store.mediaJobs(agent.id, { kinds: ['image'] }); assert.equal(jobs.length, 2); assert.ok(jobs.every(job => job.state === 'failed' && job.costUsd === '60000'));
  assert.deepEqual(usd(store, agent.id), { backed: start.backed - 220000n - 120000n, reserved: 0n, spent: start.spent + 340000n }); assert.equal(store.ledger.verify().ok, true);
  assert.equal(service.influencer.view(store.agent(agent.id)).posts[0].note, INFLUENCER_TEXT.postLowScore);
  service.close();
});

test('X rate limits reschedule, X revocation pauses posting and refunds every open post, reconnecting resumes; posts expire after six hours', async () => {
  const f = await fixture(), { service, store, x } = f;
  const agent = await liveAgent(f, { influencer: influencerRequest({ character: false }) });
  await service.influencer.tick();
  assert.equal(store.influencer(agent.id).state, 'ready'); assert.ok(store.events(agent.id, { limit: 5 }).some(event => event.title === 'Influencer ready'));
  const run = runFor(store, agent), start = usd(store, agent.id);
  const first = await service.influencer.requestPost(store.agent(agent.id), run.id, { text: 'first' });
  x.failNext = Object.assign(Error('rate limited'), { code: 'X_RATE_LIMITED', retryAfterMs: 120000 });
  await service.influencer.tick();
  let post = store.xPost(first.postId); assert.equal(post.state, 'uploading'); assert.equal(post.nextAttemptAt, f.now() + 120000); assert.equal(x.posts.length, 1);
  f.tick(MIN); await service.influencer.tick(); assert.equal(x.posts.length, 1, 'not retried before the window');
  f.tick(MIN); await service.influencer.tick(); post = store.xPost(first.postId); assert.equal(post.state, 'posted'); assert.equal(x.posts.length, 2);
  // Revocation.
  f.tick(6 * HOUR); const run2 = runFor(store, agent);
  const second = await service.influencer.requestPost(store.agent(agent.id), run2.id, { text: 'second' });
  x.failNext = Object.assign(Error('unauthorized'), { code: 'X_UNAUTHORIZED' });
  await service.influencer.tick();
  const inf = store.influencer(agent.id); assert.equal(inf.state, 'paused'); assert.equal(inf.stateReason, INFLUENCER_TEXT.revoked);
  assert.equal(store.xPost(second.postId).state, 'failed'); assert.equal(store.xPost(second.postId).error, INFLUENCER_TEXT.revoked);
  assert.ok(store.openAlerts().some(alert => alert.scope === 'agent:' + agent.id && alert.code === 'x-revoked'));
  assert.ok(store.events(agent.id, { limit: 5 }).some(event => event.title === 'Posting paused' && event.public === 1));
  assert.equal(service.influencer.postingAllowed(store.agent(agent.id), f.now() + DAY), false);
  assert.deepEqual(usd(store, agent.id), { backed: start.backed - 220000n, reserved: 0n, spent: start.spent + 220000n }, 'only the delivered post is charged'); assert.equal(store.ledger.verify().ok, true);
  const view = service.influencer.view(store.agent(agent.id)); assert.equal(view.state, 'paused'); assert.equal(view.stateReason, INFLUENCER_TEXT.revoked);
  // Reconnect with another connected account of the creator.
  const session = { account: { id: 'acct-2' } };
  const resumed = await service.influencer.control(session, { mint: agent.mint, xAccountId: X_ID_2 });
  assert.equal(resumed.state, 'ready'); assert.equal(resumed.handle, 'second_goat'); assert.equal(x.rows.get(X_ID_2).agentId, agent.id);
  await assert.rejects(service.influencer.control(session, { mint: agent.mint, xAccountId: OTHER_X }), /Connect the X account/);
  // Expiry: a post that waits more than six hours fails and is refunded.
  store.updateInfluencer(agent.id, { postingPaused: true });
  f.tick(DAY); const run3 = runFor(store, agent); store.updateInfluencer(agent.id, { postingPaused: false });
  const third = await service.influencer.requestPost(store.agent(agent.id), run3.id, { text: 'third' });
  store.updateInfluencer(agent.id, { postingPaused: true }); await service.influencer.tick();
  assert.equal(store.xPost(third.postId).state, 'queued'); assert.equal(store.xPost(third.postId).nextAttemptAt, f.now() + 5 * MIN, 'paused posting defers delivery');
  f.tick(7 * HOUR); await service.influencer.tick();
  assert.equal(store.xPost(third.postId).state, 'failed'); assert.equal(store.xPost(third.postId).error, INFLUENCER_TEXT.postExpired);
  assert.equal(usd(store, agent.id).reserved, 0n); assert.equal(store.ledger.verify().ok, true);
  service.close();
});

test('stuck generations expire after twenty minutes with a best-effort cancel; transient provider errors retry with back-off; a price above the ceiling refuses the edit', async () => {
  const f = await fixture(), { service, store, hf } = f;
  const agent = await liveAgent(f);
  await service.influencer.tick();
  const master = store.mediaJobs(agent.id, { kinds: ['master'] })[0]; assert.equal(master.state, 'submitted');
  hf.requests.get('req-1').polls = -1000; // never completes
  f.tick(21 * MIN); await service.influencer.tick();
  const expired = store.mediaJob(master.id); assert.equal(expired.state, 'expired'); assert.equal(expired.error, INFLUENCER_TEXT.expired); assert.equal(expired.costUsd, '40000', 'a generation the provider may have finished is charged, fail closed'); assert.deepEqual(hf.cancelled, ['req-1']);
  assert.equal(store.mediaJobs(agent.id, { kinds: ['master'] }).length, 2, 'the round retries once'); assert.equal(store.ledger.verify().ok, true);
  // Concurrency errors keep the job queued and retry later.
  const g = await fixture(), second = await liveAgent(g);
  g.hf.failNext = Object.assign(Error('Higgsfield HTTP 400: Maximum number of concurrent requests (4) has been reached'), { code: 'HF_CONCURRENCY' });
  await g.service.influencer.tick();
  let job = g.store.mediaJobs(second.id, { kinds: ['master'] })[0]; assert.equal(job.state, 'queued'); assert.equal(job.attempts, 1); assert.ok(job.nextCheckAt > g.now()); assert.equal(job.error, INFLUENCER_TEXT.providerBusy);
  await g.service.influencer.tick(); assert.equal(g.hf.submits.length, 0, 'not before the back-off');
  g.tick(2 * MIN); await g.service.influencer.tick(); job = g.store.mediaJobs(second.id, { kinds: ['master'] })[0]; assert.equal(job.state, 'submitted'); assert.equal(g.hf.submits.length, 1);
  // Out of provider credit: the job fails without charge and the operator is alerted.
  g.hf.failNext = Object.assign(Error('Higgsfield HTTP 403: Insufficient credits'), { code: 'HF_FUNDS' }); g.hf.outcomes.push('failed');
  await passes(g, 3);
  assert.ok(g.store.openAlerts().some(alert => alert.scope === 'provider' && alert.code === 'media-funds'));
  assert.equal(g.store.influencer(second.id).state, 'failed'); assert.equal(g.store.influencer(second.id).stateReason, INFLUENCER_TEXT.providerFunds); assert.equal(usd(g.store, second.id).spent, 0n); assert.equal(g.store.ledger.verify().ok, true);
  // Every generation is quoted first: a quote within the stage's reservation is accepted (and kept for settlement), a quote above it refuses the generation before anything is submitted.
  const h = await fixture(), third = await liveAgent(h), quotes = [];
  h.hf.estimate = async (kind, params) => { quotes.push(kind); return kind === 'edit' ? { usd: 5000000n, credits: '80' } : { usd: 22800n, credits: '1' }; };
  await h.service.influencer.tick(); await passes(h, 3);
  assert.equal(h.store.influencer(third.id).state, 'ready', 'the master comes from Soul 2, quoted under its reservation');
  const quotedMaster = h.store.mediaJobs(third.id, { kinds: ['master'] })[0]; assert.equal(quotedMaster.request.quotedUsd, '22800'); assert.equal(quotedMaster.costUsd, '80000', 'the rate card is charged when it is above the quote');
  const sheet = h.store.mediaJobs(third.id, { kinds: ['sheet'] })[0]; assert.equal(sheet.state, 'failed'); assert.equal(sheet.error, INFLUENCER_TEXT.price); assert.equal(sheet.costUsd, '0'); assert.deepEqual(quotes, ['image', 'edit']); assert.equal(h.hf.submits.length, 1, 'the refused edit was never submitted');
  assert.ok(h.store.openAlerts().some(alert => alert.code === 'media-price')); assert.equal(h.store.ledger.verify().ok, true);
  service.close(); g.service.close(); h.service.close();
});

test('daily feature clip (v71.32): 15 s renders once with the daily allowance, a second request the same day falls back to a 5-second clip, 30 s needs ffmpeg and joins two 15-second segments, settling the whole reservation', async () => {
  const f = await fixture(), { service, store, hf, x } = f;
  // $30 backed: the 20% share ($6) covers the $2 cap plus the $1.91 feature allowance.
  const agent = await liveAgent(f, { influencer: influencerRequest({ media: 'video', dailyImages: 2, dailyVideos: 1, featureClipSeconds: 15 }), fund: 30000000n });
  await service.influencer.tick(); await passes(f, 5);
  assert.deepEqual(service.influencer.featureClipLengths(), [10, 15], 'no ffmpeg: no joined clips');
  assert.equal(service.influencer.dailyAllowanceUsd(store.agent(agent.id)), 1910000n);
  let run = runFor(store, agent); const start = usd(store, agent.id);
  const context = service.influencer.promptContext(store.agent(agent.id)); assert.equal(context.featureClipSeconds, 15); assert.equal(context.featureAvailableToday, true);
  const result = await service.influencer.requestPost(store.agent(agent.id), run.id, { text: 'the day on the floor, in one take', media: 'feature', mediaBrief: 'walking the floor at the open' });
  assert.equal(result.media, 'feature'); assert.equal(result.featureClipSeconds, 15); assert.equal(result.deliversWithin, 'about an hour');
  const post = store.xPost(result.postId), job = store.mediaJob(post.mediaJobId);
  assert.equal(post.kind, 'video'); assert.equal(job.kind, 'video'); assert.deepEqual(job.request.feature, { seconds: 15, segments: [15], joined: false }); assert.equal(job.reservedUsd, '1910000'); assert.equal(job.request.params.aspectRatio, '16:9');
  assert.equal(BigInt(store.agent(agent.id).dayBudgetUsd), 3910000n, 'the day budget carries the feature allowance'); assert.equal(store.influencer(agent.id).featureToday, 1);
  assert.equal(service.influencer.featureAvailable(store.influencer(agent.id), service.influencer.counters(store.influencer(agent.id), f.now())), false, 'once a day');
  await passes(f, 6);
  const done = store.mediaJob(job.id); assert.equal(done.state, 'succeeded', done.error); assert.equal(done.file, post.id + '.mp4'); assert.equal(done.costUsd, '1910000');
  const kling = hf.submits.filter(item => item.kind === 'video'); assert.equal(kling.length, 1); assert.equal(kling[0].params.duration, 15);
  assert.equal(store.xPost(post.id).state, 'posted'); assert.deepEqual(x.posts.at(-1).media, { kind: 'video', contentType: 'video/mp4', bytes: fakeMp4().length });
  assert.deepEqual(usd(store, agent.id), { backed: start.backed - 1910000n - 220000n, reserved: 0n, spent: start.spent + 2130000n }); assert.equal(store.ledger.verify().ok, true);
  const view = service.influencer.view(store.agent(agent.id)); assert.deepEqual(view.featureClip, { seconds: 15, usedToday: true, available: false, lengths: [10, 15], costsUsd: { 10: '1310000', 15: '1910000', 30: '3760000' } }); assert.equal(view.posts[0].feature, true); assert.equal(view.posts[0].seconds, 15); assert.equal(view.today.feature, 1);
  // The same day: a second feature request becomes an ordinary 5-second clip (the clip allowance still has one).
  f.tick(6 * HOUR); run = runFor(store, agent);
  const second = await service.influencer.requestPost(store.agent(agent.id), run.id, { text: 'one more from the floor', media: 'feature', mediaBrief: 'closing bell' });
  assert.equal(second.media, 'video'); assert.match(second.note, /already used/); assert.equal(store.mediaJob(store.xPost(second.postId).mediaJobId).request.feature, undefined);
  await passes(f, 6);
  assert.equal(store.xPost(second.postId).state, 'posted'); assert.equal(hf.submits.filter(item => item.kind === 'video').at(-1).params.duration, INFLUENCER_LIMITS.videoSeconds, 'the fallback is the ordinary 5-second clip'); assert.equal(store.mediaJob(store.xPost(second.postId).mediaJobId).costUsd, '710000');
  assert.deepEqual(usd(store, agent.id).reserved, 0n); assert.equal(service.influencer.view(store.agent(agent.id)).posts[0].feature, false);
  // 30 s is refused without ffmpeg, both at launch validation and from the creator controls.
  assert.throws(() => service.influencer.validate(influencerRequest({ media: 'video', dailyImages: 2, dailyVideos: 1, featureClipSeconds: 30 })), /30-second feature clip is not available/);
  await assert.rejects(service.influencer.control({ account: { id: 'acct-2' } }, { mint: agent.mint, featureClipSeconds: 30 }), /not available on this host/);
  // With ffmpeg: the 30-second clip is two 15-second renders, the second starting from the first one's last frame, joined on the host.
  const calls = [];
  service.influencer.ffmpegState = { ok: true, at: Infinity, tool: async args => { calls.push(args); const out = args.at(-1); if (args.includes('-sseof')) writeFileSync(out, placeholderPng('frame')); else if (args.includes('concat')) writeFileSync(out, fakeMp4()); } };
  assert.deepEqual(service.influencer.featureClipLengths(), [10, 15, 30]);
  await service.influencer.control({ account: { id: 'acct-2' } }, { mint: agent.mint, featureClipSeconds: 30 });
  assert.equal(store.influencer(agent.id).spec.featureClipSeconds, 30); assert.equal(service.influencer.dailyAllowanceUsd(store.agent(agent.id)), 3760000n);
  f.tick(DAY); run = runFor(store, agent); const before = usd(store, agent.id), submits = hf.submits.length;
  const long = await service.influencer.requestPost(store.agent(agent.id), run.id, { text: 'thirty seconds from the floor', media: 'feature', mediaBrief: 'a slow walk past the screens' });
  assert.equal(long.media, 'feature'); assert.equal(long.featureClipSeconds, 30);
  const longPost = store.xPost(long.postId), longJob = store.mediaJob(longPost.mediaJobId); assert.deepEqual(longJob.request.feature, { seconds: 30, segments: [15, 15], joined: true }); assert.equal(longJob.reservedUsd, '3760000');
  await passes(f, 12);
  const finished = store.mediaJob(longJob.id); assert.equal(finished.state, 'succeeded', finished.error); assert.equal(finished.file, longPost.id + '.mp4'); assert.equal(finished.costUsd, '3760000');
  const segments = hf.submits.slice(submits).filter(item => item.kind === 'video'); assert.equal(segments.length, 2); assert.deepEqual(segments.map(item => item.params.duration), [15, 15]); assert.match(segments[1].params.prompt, /Continue the same shot/); assert.match(segments[1].params.imageUrl, /^https:\/\/media\.test\/up-/);
  assert.equal(calls.length, 2); assert.ok(calls[0].includes('-sseof')); assert.ok(calls[1].includes('concat'));
  const left = readdirSync(join(f.dir, 'media', agent.id)).filter(name => name.startsWith('tmp-')); assert.deepEqual(left, [], 'segments, frames and the list are removed');
  assert.ok(isMp4Buffer(readFileSync(join(f.dir, 'media', agent.id, longPost.id + '.mp4'))));
  assert.equal(store.xPost(longPost.id).state, 'posted');
  assert.deepEqual(usd(store, agent.id), { backed: before.backed - 3760000n - 220000n, reserved: 0n, spent: before.spent + 3980000n }); assert.equal(store.ledger.verify().ok, true);
  assert.equal(service.influencer.view(store.agent(agent.id)).posts[0].seconds, 30);
  service.close();
});

test('dry run: placeholder PNGs, no provider or vision call, posts end skipped with "[dry run] not sent", labelled events, nothing reserved', async () => {
  const vision = fakeVision(['{"sameCharacter": 1}']), f = await fixture({ dryRun: true, vision }), { service, store, hf, x, dir } = f;
  const agent = await liveAgent(f, { fund: 0n, influencer: influencerRequest({ media: 'video', dailyImages: 1, dailyVideos: 1 }) });
  await service.influencer.tick(); await passes(f, 2);
  const inf = store.influencer(agent.id);
  assert.equal(inf.state, 'ready'); assert.equal(inf.masterFile, 'master.png'); assert.equal(inf.consistency, 90);
  assert.deepEqual(inspectImage(readFileSync(join(dir, 'media', agent.id, 'master.png'))), { ext: 'png', type: 'image/png', width: 256, height: 256 });
  assert.equal(hf.submits.length, 0); assert.equal(hf.uploads.length, 0); assert.equal(vision.calls.length, 0);
  assert.deepEqual(usd(store, agent.id), { backed: 0n, reserved: 0n, spent: 0n }); assert.equal(store.mediaJobs(agent.id, { kinds: ['master'] })[0].reservedUsd, '0'); assert.equal(store.mediaJobs(agent.id, { kinds: ['sheet'] }).length, 0, 'no sheet without the provider');
  const run = runFor(store, agent);
  const result = await service.influencer.requestPost(store.agent(agent.id), run.id, { text: 'dry hello', media: 'video', mediaBrief: 'spinning' });
  assert.equal(result.media, 'video');
  await passes(f, 3);
  const post = store.xPost(result.postId);
  assert.equal(post.state, 'skipped'); assert.equal(post.error, '[dry run] not sent'); assert.equal(x.posts.length, 0); assert.equal(post.reservedUsd, '0');
  const job = store.mediaJob(post.mediaJobId); assert.equal(job.state, 'succeeded'); assert.equal(job.file, post.id + '.png', 'a clip keeps its placeholder poster'); assert.equal(job.provider, 'dry-run');
  assert.ok(store.events(agent.id, { limit: 20, publicOnly: false }).every(event => event.title.startsWith('[dry run] ')), JSON.stringify(store.events(agent.id, { limit: 20, publicOnly: false }).map(event => event.title)));
  assert.equal(store.usage(run.id).length, 0); assert.equal(store.ledger.verify().ok, true);
  const view = service.influencer.view(store.agent(agent.id)); assert.equal(view.dryRun, true); assert.equal(view.posts[0].stateLabel, 'Skipped'); assert.equal(view.posts[0].note, '[dry run] not sent');
  service.close();
});

test('the public view carries labels, caps, counters and rules and leaks no paths, request ids, provider text or keys; creator controls validate and revise', async () => {
  const f = await fixture(), { service, store, dir, x } = f;
  const agent = await liveAgent(f);
  await service.influencer.tick(); await passes(f, 5);
  const run = runFor(store, agent); await service.influencer.requestPost(store.agent(agent.id), run.id, { text: 'hi', media: 'image', mediaBrief: 'smiling' }); await passes(f, 4);
  const view = service.influencer.view(store.agent(agent.id)), text = JSON.stringify(view);
  assert.deepEqual(Object.keys(view).sort(), ['at', 'avatarUrl', 'cadenceHours', 'caps', 'character', 'coinLink', 'consistency', 'dryRun', 'enabled', 'featureClip', 'generations', 'handle', 'lastPostAt', 'media', 'nextPostAt', 'pausedByCreator', 'pausedByPlatform', 'postToX', 'posts', 'regenerationsLeft', 'rules', 'sheetUrl', 'source', 'state', 'stateLabel', 'stateReason', 'tiles', 'today', 'xConnected', 'xUrl']);
  assert.equal(view.stateLabel, 'Ready'); assert.deepEqual(view.caps, { dailyPosts: 4, dailyImages: 2, dailyVideos: 0 }); assert.equal(view.cadenceHours, 6); assert.equal(view.rules, INFLUENCER_RULES); assert.equal(view.media, 'images'); assert.equal(view.source, 'tiles');
  for (const forbidden of [dir, 'req-', 'tmp-', 'hf-secret-value', 'hf-id', 'x-secret-value', 'media.test', 'cdn.test', 'provider_request', 'sourceUrl']) assert.doesNotMatch(text, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), 'leaks ' + forbidden);
  assert.equal(service.influencer.view({ id: 'e'.repeat(24) }), null); assert.equal(service.influencer.view(null), null);
  assert.equal(service.creatorView(store.agent(agent.id)).influencer.state, 'ready', 'the creator view carries the card');
  // Controls.
  const session = { account: { id: 'acct-2' } }, control = body => service.influencer.control(session, { mint: agent.mint, ...body });
  await assert.rejects(service.influencer.control({ account: { id: 'acct-3' } }, { mint: agent.mint, pausePosting: true }), error => error.statusCode === 403);
  await assert.rejects(control({ cadenceHours: 5 }), /one of 2, 4, 6, 12, 24/); await assert.rejects(control({ dailyPosts: 20 }), /between 1 and 12/); await assert.rejects(control({ media: 'gif' }), /text only, pictures/); await assert.rejects(control({ dailyImages: 0, media: 'images' }), /at least one picture/); await assert.rejects(control({ pausePosting: 'yes' }), /pause or resume/);
  const paused = await control({ pausePosting: true, dailyPosts: 2, cadenceHours: 4, coinLink: false, media: 'video', dailyVideos: 1 });
  assert.equal(paused.state, 'paused'); assert.equal(paused.stateLabel, 'Posting paused'); assert.equal(paused.stateReason, 'Paused by the creator.'); assert.equal(paused.pausedByCreator, true); assert.deepEqual(paused.caps, { dailyPosts: 2, dailyImages: 2, dailyVideos: 1 }); assert.equal(paused.cadenceHours, 4); assert.equal(paused.coinLink, false); assert.equal(paused.media, 'video');
  assert.equal(service.influencer.postingAllowed(store.agent(agent.id), f.now() + DAY), false);
  const inf = store.influencer(agent.id); assert.equal(inf.spec.version, 1, 'the spec version is kept'); assert.equal(store.agent(agent.id).revision >= 2, true); assert.equal(store.revisions(agent.id)[0].kind, 'influencer');
  const resumed = await control({ pausePosting: false }); assert.equal(resumed.state, 'ready'); assert.equal(resumed.pausedByCreator, false);
  assert.equal(service.influencer.postingAllowed(store.agent(agent.id), f.now() + DAY), true);
  // Text-only mode zeroes the media caps; detaching X leaves a character-only influencer; regeneration starts a round and blocks a second request.
  assert.deepEqual((await control({ media: 'text' })).caps, { dailyPosts: 2, dailyImages: 0, dailyVideos: 0 });
  const detached = await control({ detachX: true }); assert.equal(detached.postToX, false); assert.equal(detached.handle, null); assert.ok(x.released.includes(agent.id));
  assert.equal((await control({ regenerate: true })).state, 'generating');
  await assert.rejects(control({ regenerate: true }), error => error.statusCode === 409, 'regenerating while generating is refused');
  // The platform pause shows on the card and blocks delivery.
  const admin = await service.control('acct-1', { agentId: agent.id, influencerPaused: true, reason: 'Posting under review by the platform.' });
  assert.equal(admin.flags.influencer, true); assert.equal(service.influencer.view(store.agent(agent.id)).pausedByPlatform, true); assert.equal(service.influencer.view(store.agent(agent.id)).stateReason, 'Posting under review by the platform.');
  await assert.rejects(service.control('acct-1', { agentId: agent.id, influencerPaused: 'yes', reason: 'Posting under review.' }), /Invalid influencer pause/);
  await assert.rejects(service.control('acct-2', { agentId: agent.id, influencerPaused: true, reason: 'Posting under review.' }), /Administrator/);
  assert.equal(store.ledger.verify().ok, true);
  service.close();
});

/** A fake account-app request context for handleInfluencerRoutes. */
class FakeRes extends Writable { constructor() { super(); this.chunks = []; this.status = 0; this.head = null; this.sent = undefined; } _write(chunk, encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); } writeHead(status, head) { this.status = status; this.head = head; return this; } }
function ctxFor(service, { method = 'GET', path, query = '', token = null, csrf = 'csrf-ok', body = undefined, ip = '9.9.9.9' }) {
  const res = new FakeRes(), keys = [];
  const req = { method, url: path + query, headers: { ...(token ? { cookie: 'launchpad-session=' + token } : {}), 'x-control-token': csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) } };
  const ctx = { req, res, path, url: new URL(path + query, 'https://launchpad.test'), ip, send: (code, value) => { res.status = code; res.sent = value; }, limits: { keys, check: (key, limit, windowMs) => { keys.push([key, limit, windowMs]); return true; } }, accounts: service.accounts, cookieToken: request => (request.headers.cookie || '').replace('launchpad-session=', '') || null, csrfSession: async (sessionToken, control) => ({ session: await service.accounts.getSession(sessionToken), csrfValid: control === 'csrf-ok' }), bodyJson: async () => { if (body === undefined) throw Object.assign(Error('Expected JSON.'), { statusCode: 415 }); return body; }, agents: service, origin: 'https://launchpad.test', configured: true };
  return { ctx, res, keys };
}

test('HTTP: the public card, the media files, the creator controls and reference uploads answer through the account-app context', async () => {
  const f = await fixture(), { service, store, dir } = f;
  const agent = await liveAgent(f);
  await service.influencer.tick(); await passes(f, 5);
  assert.equal(await handleInfluencerRoutes(ctxFor(service, { path: '/api/launchpad/agents/other' }).ctx), false, 'unrelated paths fall through');
  const card = ctxFor(service, { path: '/api/launchpad/agents/influencer', query: '?mint=' + agent.mint });
  assert.equal(await handleInfluencerRoutes(card.ctx), true); assert.equal(card.res.status, 200); assert.equal(card.res.sent.influencer.state, 'ready'); assert.deepEqual(card.keys[0], ['agents-influencer:ip:9.9.9.9', 120, undefined]);
  const viewer = ctxFor(service, { path: '/api/launchpad/agents/influencer', query: '?mint=' + agent.mint, token: 'tok-bob' }); await handleInfluencerRoutes(viewer.ctx); assert.equal(viewer.keys[0][0], 'agents-influencer:account:acct-2');
  const missing = ctxFor(service, { path: '/api/launchpad/agents/influencer', query: '?mint=' + wallet() }); await handleInfluencerRoutes(missing.ctx); assert.equal(missing.res.status, 404); assert.equal(missing.res.sent.error, 'Agent not found.');
  const plainAgent = await liveAgent(f, { influencer: null, fund: 0n }); const none = ctxFor(service, { path: '/api/launchpad/agents/influencer', query: '?mint=' + plainAgent.mint }); await handleInfluencerRoutes(none.ctx); assert.equal(none.res.status, 200); assert.equal(none.res.sent.influencer, null);
  // Media files: fixed names only, honest content types, long public cache; hidden agents and private files 404.
  const png = ctxFor(service, { path: `/influencer-media/${agent.id}/master.png` });
  assert.equal(await handleInfluencerRoutes(png.ctx), true); assert.equal(png.res.status, 200); assert.equal(png.res.head['content-type'], 'image/png'); assert.equal(png.res.head['cache-control'], 'public, max-age=3600'); assert.equal(png.res.head['accept-ranges'], 'none'); assert.ok(Buffer.concat(png.res.chunks).equals(readFileSync(join(dir, 'media', agent.id, 'master.png')))); assert.deepEqual(png.keys[0], ['influencer-media:9.9.9.9', 300, undefined]);
  const head = ctxFor(service, { method: 'HEAD', path: `/influencer-media/${agent.id}/sheet.png` }); await handleInfluencerRoutes(head.ctx); assert.equal(head.res.status, 200); assert.equal(head.res.chunks.length, 0); assert.equal(head.res.head['content-length'], readFileSync(join(dir, 'media', agent.id, 'sheet.png')).length);
  for (const bad of [`/influencer-media/${agent.id}/reference.png`, `/influencer-media/${agent.id}/../master.png`, `/influencer-media/${agent.id}/master.png.bak`, `/influencer-media/${agent.id}/${'f'.repeat(24)}.png`, `/influencer-media/${'f'.repeat(24)}/master.png`, '/influencer-media/x']) { const probe = ctxFor(service, { path: bad }); assert.equal(await handleInfluencerRoutes(probe.ctx), true, bad); assert.equal(probe.res.status, 404, bad); }
  const post = ctxFor(service, { method: 'POST', path: `/influencer-media/${agent.id}/master.png` }); await handleInfluencerRoutes(post.ctx); assert.equal(post.res.status, 405);
  store.updateAgent(agent.id, { hidden: true }); const hidden = ctxFor(service, { path: `/influencer-media/${agent.id}/master.png` }); await handleInfluencerRoutes(hidden.ctx); assert.equal(hidden.res.status, 404); store.updateAgent(agent.id, { hidden: false });
  // Controls need a session and the CSRF header; errors keep their own status and a safe message.
  const anon = ctxFor(service, { method: 'POST', path: '/api/launchpad/agents/influencer', body: { mint: agent.mint, pausePosting: true } }); await handleInfluencerRoutes(anon.ctx); assert.equal(anon.res.status, 401);
  const noCsrf = ctxFor(service, { method: 'POST', path: '/api/launchpad/agents/influencer', token: 'tok-bob', csrf: 'nope', body: { mint: agent.mint, pausePosting: true } }); await handleInfluencerRoutes(noCsrf.ctx); assert.equal(noCsrf.res.status, 403);
  const other = ctxFor(service, { method: 'POST', path: '/api/launchpad/agents/influencer', token: 'tok-eve', body: { mint: agent.mint, pausePosting: true } }); await handleInfluencerRoutes(other.ctx); assert.equal(other.res.status, 403); assert.match(other.res.sent.error, /creator account/);
  const ok = ctxFor(service, { method: 'POST', path: '/api/launchpad/agents/influencer', token: 'tok-bob', body: { mint: agent.mint, pausePosting: true } }); await handleInfluencerRoutes(ok.ctx); assert.equal(ok.res.status, 200); assert.equal(ok.res.sent.influencer.state, 'paused'); assert.deepEqual(ok.keys[0], ['agents-influencer-control:acct-2', 30, undefined]);
  const invalid = ctxFor(service, { method: 'POST', path: '/api/launchpad/agents/influencer', token: 'tok-bob', body: { mint: agent.mint, cadenceHours: 7 } }); await handleInfluencerRoutes(invalid.ctx); assert.equal(invalid.res.status, 400); assert.match(invalid.res.sent.error, /Posting cadence/);
  const wrongMethod = ctxFor(service, { path: '/api/launchpad/agents/influencer/reference' }); await handleInfluencerRoutes(wrongMethod.ctx); assert.equal(wrongMethod.res.status, 405);
  const unknown = ctxFor(service, { path: '/api/launchpad/agents/influencer/other' }); assert.equal(await handleInfluencerRoutes(unknown.ctx), true); assert.equal(unknown.res.status, 404);
  // Reference uploads: a valid image is stored under its hash and can be launched with; junk is refused.
  const bytes = placeholderPng('reference art'), upload = ctxFor(service, { method: 'POST', path: '/api/launchpad/agents/influencer/reference', token: 'tok-bob', body: { data: bytes.toString('base64') } });
  await handleInfluencerRoutes(upload.ctx); assert.equal(upload.res.status, 200);
  const referenceId = createHash('sha256').update(bytes).digest('hex') + '.png';
  assert.deepEqual(upload.res.sent, { referenceId, bytes: bytes.length, type: 'image/png', width: 256, height: 256 }); assert.deepEqual(upload.keys[0], ['agents-influencer-reference:acct-2', 10, 300000]);
  assert.ok(existsSync(join(dir, 'media', 'uploads', 'acct-2', referenceId)));
  const junk = ctxFor(service, { method: 'POST', path: '/api/launchpad/agents/influencer/reference', token: 'tok-bob', body: { data: Buffer.from('definitely not an image, just some text').toString('base64') } }); await handleInfluencerRoutes(junk.ctx); assert.equal(junk.res.status, 400); assert.match(junk.res.sent.error, /PNG, JPEG or WebP/);
  const notBase64 = ctxFor(service, { method: 'POST', path: '/api/launchpad/agents/influencer/reference', token: 'tok-bob', body: { data: '%%%' } }); await handleInfluencerRoutes(notBase64.ctx); assert.equal(notBase64.res.status, 400);
  const launched = await service.launchTarget(launchRequest({ influencer: influencerRequest({ postToX: false, xAccountId: '', source: 'reference', referenceId }) }), { accountId: 'acct-2', venue: 'raydium', name: 'Ref Goat', symbol: 'RGOAT' });
  assert.equal(store.influencer(launched.id).referenceFile, 'reference.png'); assert.ok(existsSync(join(dir, 'media', launched.id, 'reference.png'))); assert.ok(existsSync(join(dir, 'media', 'uploads', 'acct-2', referenceId)), 'the upload stays until it is pruned, so a retried launch still finds it');
  await assert.rejects(service.launchTarget(launchRequest({ influencer: influencerRequest({ postToX: false, xAccountId: '', source: 'reference', referenceId }) }), { accountId: 'acct-3', venue: 'raydium' }), /Upload the reference image again/, 'another account cannot use it');
  const ref = ctxFor(service, { path: `/influencer-media/${launched.id}/reference.png` }); await handleInfluencerRoutes(ref.ctx); assert.equal(ref.res.status, 404, 'reference art is never served');
  service.close();
});

test('a reference-art character goes through the edit model with the uploaded art and is checked against it; without the edit model the tiles prompt is used with a note', async () => {
  const f = await fixture(), { service, store, hf, dir } = f;
  const bytes = placeholderPng('my art'), { referenceId } = await service.influencer.storeReference('acct-2', bytes.toString('base64'));
  const agent = await liveAgent(f, { influencer: influencerRequest({ source: 'reference', referenceId, postToX: false, xAccountId: '' }) });
  await service.influencer.tick();
  const job = store.mediaJobs(agent.id, { kinds: ['master'] })[0];
  assert.equal(job.stage, 'edit'); assert.equal(job.reservedUsd, String(CARD.editUsd + CARD.mediaCheckUsd)); assert.deepEqual(job.request.uploads, ['reference.png']);
  assert.equal(hf.submits[0].kind, 'edit'); assert.match(hf.submits[0].params.prompt, /same original fictional adult character as in the reference art/); assert.equal(hf.uploads[0].bytes, bytes.length);
  await passes(f, 3);
  assert.equal(store.influencer(agent.id).state, 'ready'); assert.equal(f.vision.calls[0].images, 2, 'candidate and reference art'); assert.match(f.vision.calls[0].text, /reference art/);
  assert.ok(existsSync(join(dir, 'media', agent.id, 'master.png')));
  // Without the edit model the pipeline degrades to the tiles prompt and says so.
  const g = await fixture(); g.hf.editEnabled = false;
  const { referenceId: second } = await g.service.influencer.storeReference('acct-2', placeholderPng('other art').toString('base64'));
  const other = await liveAgent(g, { influencer: influencerRequest({ source: 'reference', referenceId: second, postToX: false, xAccountId: '' }) });
  await g.service.influencer.tick();
  assert.equal(g.hf.submits[0].kind, 'image'); assert.equal(g.store.influencer(other.id).stateReason, INFLUENCER_TEXT.referenceGuide);
  await passes(g, 3); assert.equal(g.store.influencer(other.id).state, 'ready'); assert.equal(g.store.influencer(other.id).stateReason, INFLUENCER_TEXT.referenceGuide, 'the note stays on the card'); assert.equal(g.store.mediaJobs(other.id, { kinds: ['sheet'] }).length, 0);
  service.close(); g.service.close();
});

test('the service tolerates literal configs without the influencer keys and the flag off: nothing runs, nothing throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'influencer-plain-'));
  const accounts = { dir, hostStore: new FakeStore(), list: async () => [], get: async () => null };
  const config = { enabled: true, dryRun: false, dbPath: join(dir, 'agents.sqlite'), backupDir: '', openrouterKey: 'k', models: [MODEL], defaultModel: MODEL, browserbaseKey: '', browserbaseProject: '', browserbaseRegion: '', operatorWallet: wallet(), globalDailyUsd: 10000000n, modelConcurrency: 2, browserConcurrency: 1, domainAllowlist: [], rateCard: AGENT_RATE_CARD_V1, workerPath: '' };
  const service = new AgentService({ accounts, launchpad: { book: async () => ({ launches: [] }) }, discovery: null, chainFactory: async () => new FakeChain(), config, now: Date.now, registry: new ModelRegistry({ allowlist: [MODEL], catalog: CATALOG }), worker: new InlineWorker({ model: dryRunModel() }) });
  const store = await service.ensure(); store.setSetting('flags', { intake: true, runs: true, model: true }, 'test');
  assert.equal(service.influencer.available(), false); assert.equal(service.effective().influencerOpen, false); assert.equal(service.effective().mediaConfigured, false);
  await service.influencer.tick();
  const agent = store.createAgent({ mint: wallet(), route: 'raydium', launchId: 'l', accountId: 'a', wallet: wallet(), name: 'G', symbol: 'G', policyHash: AGENT_POLICY_V2_HASH, policyVersion: AGENT_POLICY_V2.version, capabilities: 1, model: MODEL, mission: 'm', state: 'ready', launchState: 'live' });
  assert.equal(service.influencer.view(agent), null); assert.equal(service.influencer.postingAllowed(agent, Date.now()), false); assert.equal(service.influencer.promptContext(agent), null); assert.equal(service.influencer.attachmentOf(agent), null);
  await assert.rejects(service.influencer.requestPost(agent, null, { text: 'x' }), error => error.code === 'AGENT_TOOL');
  await assert.rejects(service.launchTarget(launchRequest({ influencer: influencerRequest() }), { accountId: 'acct-2', venue: 'raydium' }), /not available right now/);
  assert.equal(service.influencer.rateCard.xPostUsd, AGENT_RATE_CARD_V2.xPostUsd, 'a rate card without media prices falls back to V2 for them');
  await service.process();
  assert.equal(store.ledger.verify().ok, true);
  await service.close();
});

test('InfluencerService builds its Higgsfield client lazily from the config and never without a key', async () => {
  const f = await fixture(); const fresh = new InfluencerService({ service: f.service });
  const client = fresh.hf(); assert.equal(client.available(), true); assert.equal(client.keyId, 'hf-id'); assert.equal(client.baseUrl, 'https://api.higgsfield.ai'); assert.equal(fresh.hf(), client); assert.equal(fresh.editAvailable(), true);
  const bare = new InfluencerService({ service: { config: {}, now: Date.now, effective: () => ({}) } }); assert.equal(bare.hf().available(), false); assert.equal(bare.available(), false); assert.equal(bare.view({ id: 'a'.repeat(24) }), null);
  f.service.close();
});
