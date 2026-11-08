// AI Agent core: the one durable authority for agent money and state. It owns
// the SQLite ledger, provisions agent wallets through the encrypted host store,
// binds launches, ingests finalized fee receipts (30/70), verifies signed
// funding deposits, settles operating SOL to USDC, records provider backing,
// derives agent states and drives the scheduler and the financial executor.
// HTTP handlers call its methods; no model or browser request runs in here.
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { launchpadEnv } from '../brand-env.mjs';
import { acquireProcessLock } from '../process-lock.mjs';
import { displayUnits } from '../../public/launchpad-model.mjs';
import { AGENT_MODE, AGENT_POLICY_V1, AGENT_RATE_CARD_V2, AGENT_LIMITS, AGENT_PERSONALITIES, AGENT_STATE_LABELS, AGENT_RULES, AGENT_FUNDING_SUMMARY, AGENT_TOOLS, AGENT_QUOTE_MINT, canonicalJson, capabilityList, validMission, validPersonality, normalizeDomains, formatUsdMicro, validObjective, objectiveById, objectiveMissingCapabilities, normalizeObjectiveSettings } from '../../public/agent-catalog.mjs';
import { openAgentDatabase } from './db.mjs';
import { AgentStore } from './store.mjs'; import { resetProgramSchedule } from './programs.mjs';
import { AGENT_POLICY_HASH, AGENT_POLICY_V2, AGENT_POLICY_V2_HASH, ledgerPlatformShareBps, policyHash, canActivate, canResume, shouldSleep, runReservationUsd, priceMicro, freshPrice, lamportsToUsd } from './policy.mjs';
import { raydiumAgentLaunch, raydiumAgentSources, validAgentAttachment } from './launches.mjs';
import { depositMemo } from './chain.mjs';
import { AgentRunner } from './runner.mjs';
import { AgentExecutor } from './executor.mjs';
import { ModelRegistry, providerCredits, DEFAULT_MODEL_ALLOWLIST } from './openrouter.mjs';
import { listRunningSessions, releaseSession } from './browserbase.mjs';
import { AgentViews } from './views.mjs';
import { splitBps } from './ledger.mjs';
import { XAccounts } from './x-accounts.mjs';
import { InfluencerService } from './influencer.mjs';

const fail = (message, statusCode = 400, code = 'AGENT') => { throw Object.assign(Error(message), { statusCode, code }); };
const publicFailure = message => Object.assign(Error(message), { agentPublic: true });
const base58 = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const validSignature = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(value);
const routingErrors = Object.freeze({ SOL_ROUTE_AUTH: 'Jupiter could not authorize the route. Check the configured Jupiter API key.', SOL_ROUTE_RATE_LIMITED: 'Jupiter is rate limiting routing. The saved step will retry automatically.', SOL_ROUTE_NOT_FOUND: 'Jupiter has no route for this amount right now.', SOL_ROUTE_NETWORK: 'The agent service could not reach Jupiter.', SOL_ROUTE_TIMEOUT: 'The routing request timed out.', SOL_ROUTE_PROVIDER_UNAVAILABLE: 'Jupiter is temporarily unavailable.', TREASURY_PRICE_IMPACT: 'The route exceeds its price-impact limit.', TREASURY_SLIPPAGE_LIMIT: 'The route changed its slippage protection.', TREASURY_INVALID_IMPACT: 'The route omitted its price impact.' });
export const safeError = error => error?.agentPublic === true || error?.statusCode ? String(error.message).replace(/(?:https?|wss?):\/\/\S+/g, '[provider]').slice(0, 240) : Object.hasOwn(routingErrors, error?.code) ? routingErrors[error.code] : 'The agent service is waiting for a verified route, balance or receipt. It will retry automatically.';
const KEY_PREFIX = 'agent-key-', LOCK = 'agents.lock', CLOSE_GRACE_MS = 5000;
const bool = value => value === '1' || value === 'true' || value === 'yes';
const SOL = AGENT_QUOTE_MINT;

/** Operator configuration from the environment; secrets never leave this object. */
export function agentConfig(env = process.env) {
  const read = name => launchpadEnv(name, env);
  const models = String(read('AGENTS_OPENROUTER_MODELS') || DEFAULT_MODEL_ALLOWLIST.join(',')).split(',').map(value => value.trim()).filter(Boolean);
  let rateCard = AGENT_RATE_CARD_V2;
  const override = read('AGENTS_RATE_CARD'); if (override) { try { const parsed = JSON.parse(override); if (parsed && typeof parsed === 'object' && typeof parsed.version === 'string') rateCard = Object.freeze({ ...AGENT_RATE_CARD_V2, ...parsed }); } catch { /* An invalid override keeps the published card. */ } }
  // v71.30 AI influencer: Higgsfield media generation and X posting. Both stay off until their
  // credentials are set here and the admin turns the influencer flag on; neither key ever leaves this object.
  let higgsfieldModels = null;
  const modelsOverride = read('AGENTS_HIGGSFIELD_MODELS'); if (modelsOverride) { try { const parsed = JSON.parse(modelsOverride); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) higgsfieldModels = Object.freeze({ ...parsed }); } catch { /* An invalid override keeps the built-in model table. */ } }
  const publicUrl = read('PUBLIC_URL') || '';
  return Object.freeze({
    enabled: bool(read('AGENTS_ENABLED')), dryRun: bool(read('AGENTS_DRY_RUN')), dbPath: read('AGENTS_DB_PATH') || '', backupDir: read('AGENTS_BACKUP_DIR') || '',
    openrouterKey: read('AGENTS_OPENROUTER_KEY') || '', models, defaultModel: read('AGENTS_DEFAULT_MODEL') || models[0] || '',
    browserbaseKey: read('AGENTS_BROWSERBASE_KEY') || '', browserbaseProject: read('AGENTS_BROWSERBASE_PROJECT') || '', browserbaseRegion: read('AGENTS_BROWSERBASE_REGION') || '',
    operatorWallet: read('AGENTS_OPERATOR_WALLET') || '', globalDailyUsd: BigInt(Math.round(Number(read('AGENTS_GLOBAL_DAILY_USD') || '10') * 1e6)) || BigInt(AGENT_POLICY_V1.budget.platformDailyCapUsd),
    modelConcurrency: Math.max(1, Math.min(8, Number(read('AGENTS_MODEL_CONCURRENCY') || AGENT_POLICY_V1.budget.modelConcurrency) | 0)), browserConcurrency: Math.max(0, Math.min(4, Number(read('AGENTS_BROWSER_CONCURRENCY') || AGENT_POLICY_V1.budget.browserConcurrency) | 0)),
    domainAllowlist: String(read('AGENTS_DOMAIN_ALLOWLIST') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean), rateCard, workerPath: read('AGENTS_WORKER_PATH') || '',
    higgsfieldKey: read('AGENTS_HIGGSFIELD_KEY') || '', higgsfieldUrl: read('AGENTS_HIGGSFIELD_URL') || 'https://api.higgsfield.ai', higgsfieldModels, mediaConcurrency: Math.max(1, Math.min(4, Number(read('AGENTS_MEDIA_CONCURRENCY') || 2) | 0)),
    visionModel: read('AGENTS_VISION_MODEL') || 'openai/gpt-5-mini', mediaDir: read('AGENTS_MEDIA_DIR') || '', ffmpegPath: read('AGENTS_FFMPEG') || 'ffmpeg',
    xClientId: read('AGENTS_X_CLIENT_ID') || '', xClientSecret: read('AGENTS_X_CLIENT_SECRET') || '', xCallbackUrl: read('AGENTS_X_CALLBACK_URL') || (publicUrl ? publicUrl.replace(/\/+$/, '') + '/api/launchpad/x/callback' : ''), xGlobalDailyPosts: Math.max(0, Math.min(10000, Number(read('AGENTS_X_GLOBAL_DAILY_POSTS') || 500) | 0)), publicUrl,
  });
}
const DEFAULT_FLAGS = Object.freeze({ intake: false, runs: false, financial: false, model: false, browser: false, settlement: false, influencer: false });
const capabilityWords = missing => (missing.length > 1 ? 'buy-and-burn or holder rewards' : missing[0] === 'buyback' ? 'buy-and-burn' : 'holder rewards');
/** An objective id and its creator-set numbers, validated against the catalogue and the agent's launch capabilities (400 otherwise). */
function objectiveChoice(objective, rawSettings, capabilities) {
  const id = objective === undefined || objective === null || objective === '' ? 'custom' : objective;
  if (!validObjective(id)) fail('Choose an objective for your agent.', 400);
  const missing = objectiveMissingCapabilities(id, capabilities);
  if (missing.length) fail(`${objectiveById(id).name} needs ${capabilityWords(missing)} enabled at launch.`, 400);
  return { objective: id, objectiveSettings: normalizeObjectiveSettings(id, rawSettings) };
}

export class AgentService {
  constructor({ accounts, launchpad = null, meteora = null, pumpClassic = null, discovery = null, chainFactory, requireOwner = null, protocolRecipient = null, config = agentConfig(), now = Date.now, intervalMs = 60000, maxAccounts = 10000, maxRecords = 200000, registry = null, worker = null, browser = null } = {}) {
    Object.assign(this, { accounts, launchpad, meteora, pumpClassic, discovery, chainFactory, requireOwner, protocolRecipient, config, now, intervalMs, maxAccounts, maxRecords });
    this.running = null; this.timer = null; this.initial = null; this.closed = false; this.ensured = null; this.launchCache = null; this.sourceRetry = new Map(); this.events = new EventEmitter(); this.events.setMaxListeners(0); this.passes = 0;
    this.registry = registry || new ModelRegistry({ apiKey: config.openrouterKey, allowlist: config.models, now });
    this.runner = new AgentRunner({ service: this, worker, browser });
    this.executor = new AgentExecutor({ service: this });
    this.views = new AgentViews(this);
    // v71.30 AI influencer: creator-connected X accounts (tokens in the encrypted host store) and the
    // character / media / posting pipeline. Both are inert until the influencer flag and credentials are set.
    this.xAccounts = new XAccounts({ service: this });
    this.influencer = new InfluencerService({ service: this });
  }
  // ---- storage and flags --------------------------------------------------------
  available() { return this.config.enabled && !!this.accounts?.hostStore && typeof this.accounts?.dir === 'string'; }
  store() { if (!this.available()) fail('AI Agent mode is not enabled on this host.', 503, 'AGENT_DISABLED'); if (!this.agentStore) fail('The agent service is still starting.', 503, 'AGENT_STARTING'); return this.agentStore; }
  async ensure() {
    if (!this.available()) fail('AI Agent mode is not enabled on this host.', 503, 'AGENT_DISABLED');
    if (this.ensured) return this.ensured;
    this.ensured = (async () => {
      const path = this.config.dbPath || join(this.accounts.dir, 'agents', 'agents.sqlite');
      const db = await openAgentDatabase(path, { now: this.now });
      const store = new AgentStore(db, { now: this.now });
      store.savePolicy({ hash: AGENT_POLICY_HASH, version: AGENT_POLICY_V1.version, document: AGENT_POLICY_V1, rateCard: this.config.rateCard });
      store.savePolicy({ hash: AGENT_POLICY_V2_HASH, version: AGENT_POLICY_V2.version, document: AGENT_POLICY_V2, rateCard: this.config.rateCard });
      this.db = db; this.agentStore = store; return store;
    })().catch(error => { this.ensured = null; throw error; });
    return this.ensured;
  }
  flags() { const saved = this.agentStore?.setting('flags', null); return Object.freeze({ ...DEFAULT_FLAGS, ...(saved && typeof saved === 'object' ? saved : {}) }); }
  /** Effective switches: the environment master switch and credentials gate everything the admin enables. */
  effective() {
    const flags = this.flags(), dry = this.config.dryRun;
    return Object.freeze({ ...flags, master: this.config.enabled, dryRun: dry, modelConfigured: dry || !!this.config.openrouterKey, browserConfigured: dry || !!(this.config.browserbaseKey && this.config.browserbaseProject), operatorWallet: !!this.config.operatorWallet,
      intakeOpen: this.config.enabled && flags.intake, runsOpen: this.config.enabled && flags.runs, modelOpen: this.config.enabled && flags.runs && flags.model && (dry || !!this.config.openrouterKey), browserOpen: this.config.enabled && flags.runs && flags.browser && (dry || !!(this.config.browserbaseKey && this.config.browserbaseProject)), financialOpen: this.config.enabled && flags.financial && !dry, settlementOpen: this.config.enabled && flags.settlement && !dry,
      // v71.30 AI influencer: X posting needs the X app credentials and a public callback address; media needs the Higgsfield key. Dry run mocks both.
      xConfigured: dry || !!(this.config.xClientId && this.config.xClientSecret && this.config.xCallbackUrl), mediaConfigured: dry || !!this.config.higgsfieldKey,
      influencerOpen: this.config.enabled && flags.influencer, xOpen: this.config.enabled && flags.influencer && (dry || !!(this.config.xClientId && this.config.xClientSecret && this.config.xCallbackUrl)), mediaOpen: this.config.enabled && flags.influencer && (dry || !!this.config.higgsfieldKey) });
  }
  async locked(fn) { let release; try { release = await acquireProcessLock(join(this.accounts.dir, LOCK)); return await fn(); } finally { await release?.(); } }
  // ---- keys --------------------------------------------------------------------------
  async provisionKey(id) {
    const name = KEY_PREFIX + id, existing = await this.accounts.hostStore.read(name, null); if (existing) return existing.address;
    const pair = Keypair.generate(); let secret; try { secret = bs58.encode(pair.secretKey); } finally { pair.secretKey.fill(0); }
    await this.accounts.hostStore.write(name, { version: 1, address: pair.publicKey.toBase58(), secret, createdAt: this.now() });
    return pair.publicKey.toBase58();
  }
  async signer(id) {
    const key = await this.accounts.hostStore.read(KEY_PREFIX + id, null); if (!key) fail('The agent wallet key is unavailable.', 503);
    let bytes; try { bytes = bs58.decode(key.secret); if (bytes.length !== 64 || Keypair.fromSecretKey(bytes).publicKey.toBase58() !== key.address) throw Error(); } catch { fail('The agent wallet key does not match its address. Restore the original encrypted data.', 503); } finally { bytes?.fill(0); }
    return { address: key.address, secret: key.secret };
  }
  // ---- launch integration ------------------------------------------------------------
  /** Provisions (or reuses) a draft agent for a normalized launch request and returns the immutable attachment. */
  async launchTarget(request, { accountId, venue, name = '', symbol = '' } = {}) {
    const store = await this.ensure(); const effective = this.effective();
    if (!effective.intakeOpen) fail('AI Agent launches are closed right now.', 409, 'AGENT_INTAKE_CLOSED');
    if (!request || request.mode !== AGENT_MODE || !['raydium', 'meteora', 'pump'].includes(venue) || (request.venue && request.venue !== venue)) fail('AI Agent launches are available on Raydium, Meteora and Pump.fun only.', 400);
    if (!this.config.models.includes(request.model)) fail('Choose a model from the supported list.', 400);
    // Once the live catalog has been read, only a model it prices (with tool support) can be launched; the model is permanent.
    if (this.registry.refreshedAt > 0 && !this.registry.fresh(request.model)) fail('That model is not available right now. Choose another from the list.', 400);
    // The launch normalizer validated the objective already; the server checks it again against the launch capabilities.
    const { objective, objectiveSettings } = objectiveChoice(request.objective, request.objectiveSettings, request.capabilities);
    // v71.30 AI influencer: the option must be open on this host (and its X / media layers for what the request uses) before anything is provisioned.
    const influencerRequest = request.influencer ? this.influencer.validate(request.influencer, effective) : null;
    const account = await this.accounts.get(accountId); if (!account || account.banned) fail('This account cannot launch an agent.', 403);
    const draftKey = createHash('sha256').update(canonicalJson({ accountId, venue, request })).digest('hex');
    const existing = store.agentByDraft(draftKey);
    const attachment = agent => { const base = { version: 1, mode: AGENT_MODE, id: agent.id, wallet: agent.wallet, policyHash: agent.policyHash, policyVersion: agent.policyVersion, capabilities: agent.capabilities, model: agent.model }, influencer = this.influencer.attachmentOf(agent); return influencer ? { ...base, influencer } : base; };
    if (existing) return attachment(existing);
    if (store.countAgents() >= 5000) fail('The agent registry is full.', 503);
    return this.locked(async () => {
      const again = store.agentByDraft(draftKey); if (again) return attachment(again);
      const id = randomBytes(12).toString('hex'), wallet = await this.provisionKey(id);
      // New agents launch under policy v2 (platform share); earlier agents keep v1.
      const agent = store.createAgent({ id, mint: null, launchId: null, draftKey, route: venue, accountId, wallet, name: name || 'Agent', symbol: symbol || 'AGENT', policyHash: AGENT_POLICY_V2_HASH, policyVersion: AGENT_POLICY_V2.version, capabilities: request.capabilities, model: request.model, mission: request.mission, personality: request.personality || '', personalityPreset: request.personalityPreset || 'analyst', domains: request.domains || [], creatorWallet: '', state: 'provisioning', stateReason: 'Waiting for the coin launch to be created.', objective, objectiveSettings });
      // The influencer record (X account claim, reference art, fixed appearance) attaches here; a refused attachment leaves no usable draft behind.
      if (influencerRequest) { try { await this.influencer.attach(agent, influencerRequest, { accountId }); } catch (error) { store.updateAgent(agent.id, { archived: true, state: 'archived', launchState: 'abandoned', stateReason: 'The influencer attachment was refused.' }); store.db.run('UPDATE agents SET draft_key = NULL WHERE id = ?', agent.id); throw error; } }
      store.addEvent({ agentId: agent.id, kind: 'provisioned', title: 'Agent provisioned', body: `A dedicated wallet was created for a ${venue} launch.${influencerRequest ? ' An AI influencer is attached.' : ''}`, isPublic: false });
      return attachment(agent);
    });
  }
  async launchRows() {
    if (this.launchCache && this.now() - this.launchCache.at < 60000) return this.launchCache;
    const launches = [], sources = [];
    if (this.launchpad?.book || this.accounts.storeFor) {
      const accounts = await this.accounts.list(); if (accounts.length > this.maxAccounts) throw publicFailure('Agent launch discovery exceeds its account scan limit.');
      let count = 0;
      for (const account of accounts) {
        if (this.closed) break;
        let book; try { book = this.launchpad?.book ? await this.launchpad.book(account.id) : await this.accounts.storeFor(account.id).read('launchpad', { launches: [] }); } catch { continue; }
        for (const launch of book?.launches || []) { count += 1 + (launch.operations?.length || 0); if (count > this.maxRecords) throw publicFailure('Agent launch discovery exceeds its record scan limit.'); const row = raydiumAgentLaunch(launch, { accountId: account.id }); if (row) { row.banned = account.banned === true; launches.push(row); sources.push(...raydiumAgentSources(launch)); } }
      }
    }
    if (typeof this.meteora?.agentLaunches === 'function') { try { launches.push(...await this.meteora.agentLaunches()); sources.push(...await this.meteora.agentSources()); } catch { /* A Meteora read failure delays discovery; it never removes known agents. */ } }
    if (typeof this.pumpClassic?.agentLaunches === 'function') { try { launches.push(...await this.pumpClassic.agentLaunches()); sources.push(...await this.pumpClassic.agentSources()); } catch { /* A Pump.fun read failure delays discovery only. */ } }
    this.launchCache = { at: this.now(), launches, sources };
    return this.launchCache;
  }
  /** Binds drafts to created launches, tracks launch state and verifies fee authorities before activation. */
  async syncLaunches() {
    const store = this.store(), { launches } = await this.launchRows(), seen = new Set();
    for (const row of launches) {
      if (!validAgentAttachment(row.agent)) continue;
      let agent = store.agent(row.agent.id); if (!agent) continue; seen.add(agent.id);
      if (agent.wallet !== row.agent.wallet || agent.policyHash !== row.agent.policyHash || agent.route !== row.venue) { this.integrityPause(agent.id, 'The launch attachment differs from the provisioned agent.'); continue; }
      if (!agent.mint) { try { agent = store.bindAgent(agent.id, { mint: row.mint, launchId: row.launchId, name: row.name, symbol: row.symbol, image: row.image, creatorWallet: row.creatorWallet }); store.addEvent({ agentId: agent.id, kind: 'bound', title: `Bound to ${row.symbol}`, body: `Coin ${row.mint} on ${row.venue}.` }); } catch { continue; } }
      else if (agent.mint !== row.mint) { this.integrityPause(agent.id, 'The bound coin changed.'); continue; }
      const patch = {};
      if (row.name && row.name !== agent.name) patch.name = row.name; if (row.symbol && row.symbol !== agent.symbol) patch.symbol = row.symbol; if (row.image !== undefined && row.image !== agent.image) patch.image = row.image;
      // Visibility (v71.37): a coin hidden in Token management hides its agent too (recorded as hidden by "coin") and unhiding the coin
      // brings the agent back — unless a moderator hid the agent itself from the agents page, which only a moderator undoes. Before
      // v71.37 this line mirrored the coin's flag onto the agent every sync, which silently undid "Hide (moderation)" within a minute.
      const moderated = !!agent.hidden && !!agent.hiddenBy && agent.hiddenBy !== 'coin';
      if (row.hidden && !agent.hidden) { patch.hidden = true; patch.hiddenReason = 'The coin is hidden in Token management.'; patch.hiddenAt = this.now(); patch.hiddenBy = 'coin'; }
      else if (!row.hidden && agent.hidden && !moderated) { patch.hidden = false; patch.hiddenReason = ''; patch.hiddenAt = null; patch.hiddenBy = ''; }
      let launchState = agent.launchState;
      if (row.failed) launchState = 'failed'; else if (row.created && row.live) launchState = 'live'; else if (row.created) launchState = 'created'; else launchState = 'pending';
      if (launchState === 'live' && agent.launchState !== 'live') {
        // Authority check at activation: relay fee custody and an unredirected recipient.
        const custodyOk = row.feeCustody === 'relay' && !row.redirected;
        if (!custodyOk) { this.integrityPause(agent.id, 'The launch fee custody or recipient is not the assigned agent wallet.'); continue; }
        patch.authorityCheckedAt = this.now(); store.addEvent({ agentId: agent.id, kind: 'live', title: 'Coin is live', body: `Fee entitlement assigned to the agent wallet on ${row.venue === 'pump' ? 'Pump.fun' : row.venue}. 30% operations / 70% treasury on every finalized payout${agent.policyHash === AGENT_POLICY_HASH ? '' : ', after the platform share'}.` });
      }
      if (launchState === 'failed' && agent.launchState !== 'failed') { patch.archived = true; patch.state = 'archived'; patch.stateReason = 'The coin launch failed or was abandoned; no spending agent exists.'; store.addEvent({ agentId: agent.id, kind: 'archived', title: 'Launch failed', body: 'The agent was archived without any spendable credit.' }); await this.influencer.release(agent.id, 'The coin launch failed.').catch(() => {}); }
      if (row.redirected && agent.launchState === 'live') this.integrityPause(agent.id, 'The fee recipient was changed after activation.');
      if (launchState !== agent.launchState) patch.launchState = launchState;
      if (Object.keys(patch).length) store.updateAgent(agent.id, patch);
    }
    // Drafts never bound within two hours never became launches: archive them quietly (and free their X account).
    for (const draft of store.unboundDrafts(this.now() - 2 * 3600000)) if (!seen.has(draft.id)) { store.updateAgent(draft.id, { archived: true, state: 'archived', launchState: 'abandoned', stateReason: 'No launch was created for this draft.' }); await this.influencer.release(draft.id, 'No launch was created for this draft.').catch(() => {}); }
  }
  integrityPause(agentId, reason) { const store = this.store(), agent = store.agent(agentId); if (!agent || agent.integrityPaused) return; store.updateAgent(agentId, { integrityPaused: true, integrityReason: reason }); store.raiseAlert({ scope: 'agent:' + agentId, code: 'integrity', message: reason }); store.addEvent({ agentId, kind: 'paused', title: 'Paused for an integrity check', body: reason }); }
  // ---- fee receipts ----------------------------------------------------------------------
  async discoverFees(chain) {
    const store = this.store(), { sources } = await this.launchRows(); let checked = 0;
    for (const source of sources) {
      if (!validSignature(source.signature) || !base58(source.sourceWallet) || source.mint !== SOL || source.sourceWallet === source.wallet) continue;
      const agent = store.agent(source.agentId); if (!agent || agent.wallet !== source.wallet || !agent.mint || agent.mint !== source.launchMint) continue;
      if (store.hasFeeReceipt({ signature: source.signature, allocation: source.allocation })) continue;
      const key = `${source.signature}:${source.allocation}`, retry = this.sourceRetry.get(key); if (retry && retry.nextAt > this.now()) continue;
      if (checked++ >= 8) break;
      try {
        const receipt = await chain.incomingReceipt(source, { wallet: agent.wallet });
        if (!receipt) { this.retryLater(key, 'Waiting for a finalized payout receipt.'); continue; }
        if (receipt.signature !== source.signature || receipt.wallet !== agent.wallet || receipt.sourceWallet !== source.sourceWallet || !Number.isSafeInteger(receipt.slot)) throw publicFailure('A fee receipt could not be verified.');
        const amount = BigInt(receipt.receivedAmount); if (amount <= 0n || amount > BigInt(source.amount)) throw publicFailure('A fee receipt exceeds its recorded payout.');
        const platformShareBps = ledgerPlatformShareBps(agent.policyHash, source.venue);
        const result = store.recordFeeReceipt({ agentId: agent.id, signature: source.signature, allocation: source.allocation, venue: source.venue, launchMint: source.launchMint, sourceWallet: source.sourceWallet, mint: SOL, amount: amount.toString(), slot: receipt.slot, sourceAt: source.at, operationsBps: AGENT_POLICY_V1.funding.operationsBps, platformShareBps });
        if (!result.duplicate) { store.addEvent({ agentId: agent.id, kind: 'fee', title: `Fee receipt ${displayUnits(amount)} SOL`, body: `${result.platform > 0n ? `${displayUnits(result.platform)} SOL platform share, ` : ''}${displayUnits(result.operations)} SOL to operations, ${displayUnits(result.treasury)} SOL to treasury.`, data: { signature: source.signature, venue: source.venue, amount: amount.toString(), platform: result.platform.toString(), operations: result.operations.toString(), treasury: result.treasury.toString() } }); this.sourceRetry.delete(key); }
      } catch (error) { this.retryLater(key, safeError(error)); }
    }
  }
  retryLater(key, message) { const previous = this.sourceRetry.get(key), attempts = (previous?.attempts || 0) + 1; this.sourceRetry.set(key, { attempts, nextAt: this.now() + Math.min(3600000, 15000 * 2 ** Math.min(attempts - 1, 8)), message }); if (this.sourceRetry.size > 5000) this.sourceRetry.delete(this.sourceRetry.keys().next().value); }
  // ---- funding deposits --------------------------------------------------------------
  async prepareFunding(session, { mint, purpose, amountSol }, context) {
    const store = await this.ensure(); if (!this.config.enabled) fail('AI Agent mode is not enabled.', 503);
    const agent = store.agentByMint(mint); if (!agent || agent.archived) fail('Agent not found.', 404);
    if (!['activity', 'treasury'].includes(purpose)) fail('Choose activity or treasury funding.');
    const sender = session.walletVerified === true ? session.walletAddress : session.account?.mainWallet; if (!base58(sender)) fail('Connect a Solana wallet before funding an agent.', 403);
    let lamports; try { lamports = BigInt(Math.round(Number(amountSol) * 1e9)); } catch { fail('Enter a SOL amount.'); }
    if (!(lamports >= 10000000n && lamports <= 1000000000000n)) fail('Fund between 0.01 and 1,000 SOL.');
    const open = store.intents(agent.id, { accountId: session.account.id }).filter(intent => ['awaiting_signature', 'submitted'].includes(intent.state) && intent.expiresAt > this.now());
    if (open.length >= 3) fail('Finish or cancel your pending funding deposits first.', 409);
    const chain = await this.chainFactory();
    try {
      const memo = depositMemo(agent.id, purpose, randomBytes(6).toString('hex'));
      const op = await chain.prepareDeposit({ sender, recipient: agent.wallet, lamports: lamports.toString(), memo });
      await context?.authorize?.();
      const intent = store.createIntent({ agentId: agent.id, accountId: session.account.id, purpose, sender, recipient: agent.wallet, mint: SOL, amount: lamports.toString(), memo, messageHash: op.messageHash, unsignedRaw: op.unsignedRaw, blockhash: op.blockhash, lastValidBlockHeight: op.lastValidBlockHeight, preparedSlot: op.preparedSlot, expiresAt: this.now() + 120000 });
      return this.intentView(intent, { includeTransaction: true });
    } finally { await chain.close?.(); }
  }
  async submitFunding(session, { intentId, signedTransaction }, context) {
    const store = this.store(), intent = store.intent(intentId); if (!intent || intent.accountId !== session.account.id) fail('Funding deposit not found.', 404);
    if (intent.state !== 'awaiting_signature') return this.intentView(intent);
    if (intent.expiresAt <= this.now()) { store.updateIntent(intent.id, { state: 'expired', unsignedRaw: null }); fail('This funding request expired. Prepare it again.', 409); }
    const chain = await this.chainFactory();
    try {
      const op = { kind: 'deposit', needsSignature: true, state: 'awaiting_signature', externalSigner: intent.sender, unsignedRaw: intent.unsignedRaw, messageHash: intent.messageHash, blockhash: intent.blockhash, lastValidBlockHeight: intent.lastValidBlockHeight, preparedSlot: intent.preparedSlot, createdAt: intent.createdAt };
      const signed = await chain.acceptSigned(op, signedTransaction);
      await context?.authorize?.();
      const current = store.intent(intent.id); if (current.state !== 'awaiting_signature') return this.intentView(current);
      // The broadcast path re-verifies the exact signed bytes against the funder (wallet) and their hash.
      const rawHash = createHash('sha256').update(Buffer.from(signed.raw, 'base64')).digest('hex');
      store.updateIntent(intent.id, { state: 'submitted', signature: signed.signature, operation: { signature: signed.signature, raw: signed.raw, rawHash, wallet: intent.sender, blockhash: signed.blockhash, lastValidBlockHeight: signed.lastValidBlockHeight, preparedSlot: signed.preparedSlot, attempts: 0 }, unsignedRaw: null });
      try { await chain.broadcast({ ...signed, kind: 'deposit', wallet: intent.sender, rawHash }); } catch { /* The saved signed bytes are retried by the worker. */ }
      return this.intentView(store.intent(intent.id));
    } finally { await chain.close?.(); }
  }
  async cancelFunding(session, { intentId }) { const store = this.store(), intent = store.intent(intentId); if (!intent || intent.accountId !== session.account.id) fail('Funding deposit not found.', 404); if (intent.state !== 'awaiting_signature') fail('A signed deposit cannot be cancelled; it is reconciled from the chain.', 409); return this.intentView(store.updateIntent(intent.id, { state: 'cancelled', unsignedRaw: null })); }
  async fundingStatus(session, { intentId }) { const store = this.store(), intent = store.intent(intentId); if (!intent || intent.accountId !== session.account.id) fail('Funding deposit not found.', 404); return this.intentView(intent); }
  intentView(intent, { includeTransaction = false } = {}) { return { id: intent.id, purpose: intent.purpose, state: intent.state, sender: intent.sender, recipient: intent.recipient, amountSol: displayUnits(intent.amount), memo: intent.memo, signature: intent.signature || null, error: intent.error || '', expiresAt: intent.expiresAt, createdAt: intent.createdAt, finalizedAt: intent.finalizedAt || null, ...(includeTransaction && intent.state === 'awaiting_signature' ? { transaction: intent.unsignedRaw, messageHash: intent.messageHash } : {}) }; }
  async reconcileFunding(chain) {
    const store = this.store();
    for (const intent of store.intents ? store.pendingIntents(20) : []) {
      const op = intent.operation; if (!op?.signature) { store.updateIntent(intent.id, { state: 'failed', error: 'The signed deposit was lost before broadcast.' }); continue; }
      try {
        const receipt = await chain.depositReceipt({ signature: op.signature, sender: intent.sender, recipient: intent.recipient, lamports: intent.amount, memo: intent.memo });
        if (receipt) {
          if (receipt.state === 'failed') { store.updateIntent(intent.id, { state: 'failed', error: 'The deposit transaction failed onchain.', operation: null }); continue; }
          const result = store.creditIntent(intent.id, { signature: receipt.signature, slot: receipt.slot, receivedAmount: receipt.receivedAmount });
          if (!result.duplicate) { const agent = store.agent(intent.agentId); store.addEvent({ agentId: intent.agentId, kind: 'funding', title: `${intent.purpose === 'activity' ? 'Activity' : 'Treasury'} funding ${displayUnits(intent.amount)} SOL`, body: `Non-refundable contribution received${agent ? ' by ' + agent.symbol : ''}.`, data: { signature: receipt.signature, purpose: intent.purpose, amount: intent.amount } }); }
          continue;
        }
        const status = await chain.pendingTransactionState({ signature: op.signature, raw: op.raw, blockhash: op.blockhash, lastValidBlockHeight: op.lastValidBlockHeight, preparedSlot: op.preparedSlot });
        if (status?.state === 'expired') {
          const previous = intent.expiryCheck, checkpoint = status.checkpoint;
          if (previous && this.now() - previous.at >= 10000 && Number.isSafeInteger(checkpoint?.slot) && checkpoint.slot > previous.slot) { store.updateIntent(intent.id, { state: 'expired', error: 'The signed deposit expired before it was confirmed. Nothing was credited.', operation: null, expiryCheck: null }); }
          else store.updateIntent(intent.id, { expiryCheck: { at: this.now(), slot: checkpoint?.slot ?? 0, height: checkpoint?.height ?? 0 } });
        } else if (status?.state === 'pending' && (op.attempts || 0) < 6 && this.now() - (op.lastBroadcastAt || 0) >= 20000) { op.attempts = (op.attempts || 0) + 1; op.lastBroadcastAt = this.now(); store.updateIntent(intent.id, { operation: op, expiryCheck: null }); try { await chain.broadcast({ kind: 'deposit', signature: op.signature, raw: op.raw, rawHash: op.rawHash || createHash('sha256').update(Buffer.from(op.raw, 'base64')).digest('hex'), wallet: op.wallet || intent.sender, blockhash: op.blockhash, lastValidBlockHeight: op.lastValidBlockHeight, preparedSlot: op.preparedSlot }); } catch { /* Retried on the next pass. */ } }
      } catch (error) { store.updateIntent(intent.id, { error: safeError(error) }); }
    }
  }
  // ---- settlement (operating SOL -> USDC) ----------------------------------------------
  async settle(chain) {
    const store = this.store(), effective = this.effective(); if (!effective.settlementOpen) return;
    const maxCost = '5000000', minimum = BigInt(AGENT_POLICY_V1.settlement.minimumBatchLamports);
    for (const batch of store.openSettlementBatches()) await this.reconcileSettlement(chain, batch);
    let prepared = 0;
    for (const agent of store.allAgents({ includeArchived: false })) {
      if (prepared >= 2 || this.closed) break;
      if (!agent.mint || agent.launchState !== 'live' || agent.integrityPaused || agent.adminPaused) continue;
      const balances = store.agentBalances(agent.id), unsettled = BigInt(balances.sol.operatingUnsettled);
      if (unsettled < minimum + BigInt(maxCost) || store.openSettlementBatch(agent.id)) continue;
      const retry = this.sourceRetry.get('settle:' + agent.id); if (retry && retry.nextAt > this.now()) continue;
      const amount = unsettled - BigInt(maxCost);
      let batch = null;
      try {
        batch = store.createSettlementBatch({ agentId: agent.id, lamports: amount.toString(), maxNetworkCost: maxCost });
        const signer = await this.signer(agent.id), treasuryReserve = BigInt(balances.sol.treasuryAvailable) + BigInt(balances.sol.treasuryReserved) + BigInt(balances.sol.rewardFrozen) + BigInt(balances.sol.suspense) + BigInt(balances.sol.protocolPayable || 0) + BigInt(balances.sol.protocolRemitting || 0);
        const op = await chain.prepareSettlement({ wallet: signer, lamports: amount.toString(), minSolReserve: treasuryReserve.toString(), maxNetworkCostLamports: maxCost });
        if (this.closed) return;
        if (op.kind !== 'acquire' || op.wallet !== agent.wallet || op.inputAmount !== amount.toString() || !validSignature(op.signature) || op.rawHash !== createHash('sha256').update(Buffer.from(op.raw, 'base64')).digest('hex')) throw publicFailure('The prepared settlement could not be verified.');
        store.updateSettlementBatch(batch.id, { state: 'signed', operation: { ...op, attempts: 0 }, quote: { expected: op.expectedOutput, minimum: op.minimumOutput, slippageBps: AGENT_POLICY_V1.settlement.slippageBps } });
        prepared++;
        try { await chain.broadcast(op); store.updateSettlementBatch(batch.id, { state: 'submitted', operation: { ...op, attempts: 1, lastBroadcastAt: this.now() } }); } catch { store.updateSettlementBatch(batch.id, { state: 'submitted', operation: { ...op, attempts: 1, lastBroadcastAt: this.now() }, error: 'Submission response unavailable; checking the saved transaction.' }); }
      } catch (error) {
        if (batch && store.settlementBatch(batch.id)?.state === 'reserved') store.releaseSettlementBatch(batch.id, { reason: safeError(error) });
        this.retryLater('settle:' + agent.id, safeError(error));
      }
    }
  }
  async reconcileSettlement(chain, batch) {
    const store = this.store(), op = batch.operation, agentId = batch.apportionment[0]?.agentId;
    if (!op?.signature) { if (batch.state === 'reserved' && this.now() - batch.createdAt > 600000) store.releaseSettlementBatch(batch.id, { reason: 'The settlement was never signed.' }); return; }
    if ((batch.nextAttemptAt || 0) > this.now()) return;
    store.updateSettlementBatch(batch.id, { nextAttemptAt: this.now() + 10000 });
    try {
      const receipt = await chain.receipt(op, op.wallet);
      if (receipt) {
        if (receipt.state === 'confirmed') { store.finalizeSettlementBatch(batch.id, { outputUsdc: receipt.outputAmount, networkCost: receipt.actualSolCostLamports, signature: op.signature }); store.addEvent({ agentId, kind: 'settlement', title: `Settled ${displayUnits(op.inputAmount)} SOL to ${displayUnits(receipt.outputAmount, 6)} USDC`, body: 'Operating SOL converted for provider backing. Credits become spendable once the operator records matching provider funding.', data: { signature: op.signature, inputLamports: op.inputAmount, outputUsdc: receipt.outputAmount } }); }
        else store.releaseSettlementBatch(batch.id, { reason: 'The settlement transaction failed onchain.', feeLamports: receipt.actualSolCostLamports || receipt.feeLamports || '0', failed: true });
        return;
      }
      const status = await chain.state(op);
      if (status?.state === 'expired') {
        const checkpoint = status.checkpoint, previous = batch.operation.expiryCheck;
        if (previous && this.now() - previous.at >= 10000 && Number.isSafeInteger(checkpoint?.slot) && checkpoint.slot > previous.slot && checkpoint.height > op.lastValidBlockHeight) store.releaseSettlementBatch(batch.id, { reason: 'The settlement expired without executing; a fresh batch will be prepared.' });
        else store.updateSettlementBatch(batch.id, { operation: { ...op, expiryCheck: { at: this.now(), slot: checkpoint?.slot ?? 0, height: checkpoint?.height ?? 0 } } });
      } else if (status?.state === 'pending' && (op.attempts || 0) < 4 && this.now() - (op.lastBroadcastAt || 0) >= 20000) { const next = { ...op, attempts: (op.attempts || 0) + 1, lastBroadcastAt: this.now() }; delete next.expiryCheck; store.updateSettlementBatch(batch.id, { operation: next }); try { await chain.broadcast(op); } catch { /* Checked again next pass. */ } }
    } catch (error) { store.updateSettlementBatch(batch.id, { error: safeError(error), attempts: (batch.attempts || 0) + 1 }); }
  }
  // ---- provider backing and reimbursement (owner) -------------------------------------
  async requireAdmin(id) { const actor = await this.accounts.get(id); if (!actor || actor.role !== 'admin' || !actor.mfaEnabled || actor.banned) fail('Administrator access with two-factor authentication is required.', 403); return actor; }
  async recordProviderBatch(actorId, { provider = 'openrouter', reference, evidence, paidUsdc, purchaseFeeUsdc = '0', creditsUsd } = {}) {
    const actor = await this.requireAdmin(actorId), store = await this.ensure();
    if (typeof reference !== 'string' || reference.trim().length < 3) fail('Enter the provider invoice or transaction reference.');
    if (typeof evidence !== 'string' || evidence.trim().length < 5) fail('Describe the evidence (invoice id, payment hash, screenshot name).');
    const toUsdc = value => { const n = Number(value); if (!Number.isFinite(n) || n < 0) fail('Enter valid USD amounts.'); return BigInt(Math.round(n * 1e6)).toString(); };
    const batch = store.createProviderBatch({ provider: String(provider).slice(0, 40), reference: reference.trim(), evidence: evidence.trim(), paidUsdc: toUsdc(paidUsdc), purchaseFeeUsdc: toUsdc(purchaseFeeUsdc), creditsUsd: toUsdc(creditsUsd), actor: actor.username });
    store.audit({ actorId, actor: actor.username, action: 'provider-batch', target: batch.id, detail: { reference: batch.reference, paidUsdc: batch.paidUsdc, creditsUsd: batch.creditsUsd }, reason: evidence.trim() });
    await this.requireAdmin(actorId);
    return this.providerBatchView(batch);
  }
  providerBatchView(batch) { return { ...batch, paid: displayUnits(batch.paidUsdc, 6), purchaseFee: displayUnits(batch.purchaseFeeUsdc, 6), credits: formatUsdMicro(batch.creditsUsd), remainingUsdc: displayUnits(BigInt(batch.paidUsdc) - BigInt(batch.allocatedUsdc), 6), remainingUsd: formatUsdMicro(BigInt(batch.creditsUsd) - BigInt(batch.allocatedUsd)) }; }
  /** Backs settled USDC with a recorded provider batch at the batch's own USDC->credit rate (purchase fee passed through, published separately). */
  async allocateBacking(actorId, { batchId, agentId = null, reason = '' } = {}) {
    const actor = await this.requireAdmin(actorId), store = await this.ensure(), batch = store.providerBatch(batchId); if (!batch) fail('Provider batch not found.', 404);
    const targets = agentId ? [store.requireAgent(agentId)] : store.allAgents({ includeArchived: true }).filter(agent => BigInt(store.agentBalances(agent.id).usdc.operatingSettled) > 0n);
    const applied = [];
    for (const agent of targets) {
      const current = store.providerBatch(batchId), remainingUsdc = BigInt(current.paidUsdc) - BigInt(current.allocatedUsdc), remainingUsd = BigInt(current.creditsUsd) - BigInt(current.allocatedUsd);
      const settled = BigInt(store.agentBalances(agent.id).usdc.operatingSettled); if (settled <= 0n || remainingUsdc <= 0n) continue;
      const usdc = settled < remainingUsdc ? settled : remainingUsdc, usd = usdc * BigInt(current.creditsUsd) / BigInt(current.paidUsdc);
      if (usd <= 0n || usd > remainingUsd) continue;
      store.allocateBacking({ batchId, agentId: agent.id, usdc: usdc.toString(), usd: usd.toString() });
      store.addEvent({ agentId: agent.id, kind: 'backing', title: `${formatUsdMicro(usd)} of operating credit backed`, body: `${displayUnits(usdc, 6)} USDC matched to recorded provider funding (${current.reference}).`, data: { usdc: usdc.toString(), usd: usd.toString(), batch: current.reference } });
      applied.push({ agentId: agent.id, symbol: agent.symbol, usdc: usdc.toString(), usd: usd.toString() });
    }
    store.audit({ actorId, actor: actor.username, action: 'backing', target: batchId, detail: { applied }, reason });
    await this.requireAdmin(actorId);
    return { batch: this.providerBatchView(store.providerBatch(batchId)), applied };
  }
  async requestReimbursement(actorId, { agentId, amountUsdc, reason = '' } = {}) {
    const actor = await this.requireAdmin(actorId), store = await this.ensure(), agent = store.requireAgent(agentId);
    if (!base58(this.config.operatorWallet)) fail('Configure LAUNCHPAD_AGENTS_OPERATOR_WALLET before requesting a reimbursement.', 409);
    if (typeof reason !== 'string' || reason.trim().length < 5) fail('Enter a reason of at least 5 characters.');
    const receivable = BigInt(store.platformBalances().operatorReceivableUsdc), reimbursable = store.reimbursableUsdc(agent.id);
    let usdc; try { usdc = BigInt(Math.round(Number(amountUsdc) * 1e6)); } catch { fail('Enter a USDC amount.'); }
    if (usdc <= 0n) fail('Enter a positive USDC amount.');
    if (usdc > receivable || usdc > reimbursable) fail(`At most ${displayUnits(reimbursable < receivable ? reimbursable : receivable, 6)} USDC can be reimbursed from this agent wallet.`, 409);
    if (store.openReimbursements().some(item => item.agentId === agent.id)) fail('A reimbursement from this wallet is already in progress.', 409);
    const item = store.createReimbursement({ agentId: agent.id, usdc: usdc.toString(), destination: this.config.operatorWallet, actor: actor.username });
    store.audit({ actorId, actor: actor.username, action: 'reimbursement', target: item.id, detail: { agentId: agent.id, usdc: usdc.toString(), destination: this.config.operatorWallet }, reason: reason.trim() });
    await this.requireAdmin(actorId); this.kick();
    return item;
  }
  async processReimbursements(chain) {
    const store = this.store();
    for (const item of store.openReimbursements()) {
      try {
        if (item.state === 'requested') {
          const agent = store.requireAgent(item.agentId), signer = await this.signer(agent.id);
          const op = await chain.prepareUsdcTransfer({ wallet: signer, amount: item.usdc, recipient: item.destination, maxNetworkCostLamports: '5000000' });
          if (op.wallet !== agent.wallet || op.inputAmount !== item.usdc || op.recipient !== item.destination) throw publicFailure('The prepared reimbursement could not be verified.');
          store.updateReimbursement(item.id, { state: 'signed', operation: { ...op, attempts: 0 } });
          try { await chain.broadcast(op); } catch { /* Retried below. */ }
          store.updateReimbursement(item.id, { state: 'submitted', operation: { ...op, attempts: 1, lastBroadcastAt: this.now() } });
          continue;
        }
        const op = item.operation; if (!op) { store.updateReimbursement(item.id, { state: 'failed', error: 'The signed transfer was lost.' }); continue; }
        const receipt = await chain.receipt(op, op.wallet);
        if (receipt) { if (receipt.state === 'confirmed') store.settleReimbursement(item.id, { signature: op.signature }); else store.updateReimbursement(item.id, { state: 'failed', error: 'The transfer failed onchain.', operation: null }); continue; }
        const status = await chain.state(op);
        if (status?.state === 'expired') { const previous = item.expiryCheck, checkpoint = status.checkpoint; if (previous && this.now() - previous.at >= 10000 && checkpoint?.slot > previous.slot) store.updateReimbursement(item.id, { state: 'failed', error: 'The transfer expired without executing. Request it again.', operation: null, expiryCheck: null }); else store.updateReimbursement(item.id, { expiryCheck: { at: this.now(), slot: checkpoint?.slot ?? 0 } }); }
        else if (status?.state === 'pending' && (op.attempts || 0) < 4 && this.now() - (op.lastBroadcastAt || 0) >= 20000) { store.updateReimbursement(item.id, { operation: { ...op, attempts: (op.attempts || 0) + 1, lastBroadcastAt: this.now() } }); try { await chain.broadcast(op); } catch { /* Next pass. */ } }
      } catch (error) { store.updateReimbursement(item.id, { error: safeError(error) }); }
    }
  }
  // ---- platform share (policy v2) ---------------------------------------------------------------
  /**
   * Remits the platform share set aside from gross Raydium/Meteora receipts to the
   * protocol recipient. The share is reserved in the ledger before signing, the
   * signed bytes are saved before broadcast, and only a finalized receipt settles it.
   */
  async remitPlatformShare(chain) {
    const store = this.store();
    for (const remit of store.openRemits()) await this.reconcileRemit(chain, remit);
    if (!this.effective().financialOpen && !this.effective().settlementOpen) return;
    const destination = typeof this.protocolRecipient === 'function' ? await this.protocolRecipient().catch(() => null) : null;
    if (!base58(destination)) return;
    const minimum = BigInt(AGENT_POLICY_V2.funding.platformRemitMinimumLamports), buffer = 20000n;
    let prepared = 0;
    for (const agent of store.allAgents({ includeArchived: true })) {
      if (prepared >= 2 || this.closed) break;
      if (agent.wallet === destination || store.openRemits().some(r => r.agentId === agent.id)) continue;
      const balances = store.agentBalances(agent.id), payable = BigInt(balances.sol.protocolPayable || 0); if (payable < minimum + buffer) continue;
      const retry = this.sourceRetry.get('remit:' + agent.id); if (retry && retry.nextAt > this.now()) continue;
      let remit = null;
      try {
        const amount = payable - buffer; remit = store.createRemit({ agentId: agent.id, amount: amount.toString(), destination });
        const floor = Object.values(store.agentBalances(agent.id).sol).reduce((sum, value) => sum + BigInt(value), 0n) - amount;
        const signer = await this.signer(agent.id), op = await chain.prepareWithdrawal({ kind: 'withdraw', wallet: signer, mint: SOL, amount: amount.toString(), recipient: destination, minSolReserve: (floor > 0n ? floor : 0n).toString(), maxNetworkCostLamports: '20000' });
        if (op.wallet !== agent.wallet || op.recipient !== destination || op.inputAmount !== amount.toString() || !validSignature(op.signature) || op.rawHash !== createHash('sha256').update(Buffer.from(op.raw, 'base64')).digest('hex')) throw publicFailure('The prepared remittance could not be verified.');
        store.updateRemit(remit.id, { state: 'signed', operation: { ...op, attempts: 0 }, signature: op.signature }); prepared++;
        try { await chain.broadcast(op); } catch { /* Reconciled from the saved bytes. */ }
        store.updateRemit(remit.id, { state: 'submitted', operation: { ...op, attempts: 1, lastBroadcastAt: this.now() } });
      } catch (error) { if (remit && store.remit(remit.id)?.state === 'reserved') store.releaseRemit(remit.id, { reason: safeError(error) }); this.retryLater('remit:' + agent.id, safeError(error)); }
    }
  }
  async reconcileRemit(chain, remit) {
    const store = this.store(), op = remit.operation;
    if (!op?.signature) { if (remit.state === 'reserved' && this.now() - remit.createdAt > 600000) store.releaseRemit(remit.id, { reason: 'The remittance was never signed.' }); return; }
    try {
      const receipt = await chain.receipt(op, op.wallet);
      if (receipt) {
        if (receipt.state === 'confirmed') { store.settleRemit(remit.id, { signature: op.signature, feeLamports: receipt.actualSolCostLamports || receipt.feeLamports || '0' }); store.addEvent({ agentId: remit.agentId, kind: 'platform', title: `Platform share remitted ${displayUnits(op.inputAmount)} SOL`, body: 'The platform share set aside from fee receipts was sent to the protocol recipient.', data: { signature: op.signature, amount: op.inputAmount } }); }
        else store.releaseRemit(remit.id, { reason: 'The remittance failed onchain.', feeLamports: receipt.actualSolCostLamports || receipt.feeLamports || '0' });
        return;
      }
      const status = await chain.state(op);
      if (status?.state === 'expired') { const previous = remit.expiryCheck, checkpoint = status.checkpoint; if (previous && this.now() - previous.at >= 10000 && checkpoint?.slot > previous.slot) store.releaseRemit(remit.id, { reason: 'The remittance expired without executing.' }); else store.updateRemit(remit.id, { expiryCheck: { at: this.now(), slot: checkpoint?.slot ?? 0 } }); }
      else if (status?.state === 'pending' && (op.attempts || 0) < 4 && this.now() - (op.lastBroadcastAt || 0) >= 20000) { store.updateRemit(remit.id, { operation: { ...op, attempts: (op.attempts || 0) + 1, lastBroadcastAt: this.now() } }); try { await chain.broadcast(op); } catch { /* Next pass. */ } }
    } catch (error) { store.updateRemit(remit.id, { error: safeError(error) }); }
  }
  /** Finalized remittances, as protocol-treasury revenue sources (verified again by the treasury). */
  async protocolShareSources() {
    if (!this.available()) return [];
    const store = await this.ensure(), byId = new Map(store.allAgents({ includeArchived: true }).map(agent => [agent.id, agent]));
    return store.remits({ state: 'confirmed' }).flatMap(remit => { const agent = byId.get(remit.agentId); return agent && remit.signature ? [{ kind: 'agent-protocol-share', signature: remit.signature, mint: SOL, amount: remit.amount, wallet: remit.destination, sourceWallet: agent.wallet, decimals: 9, symbol: 'SOL' }] : []; });
  }
  // ---- state derivation --------------------------------------------------------------------
  deriveState(agent, balances = this.store().agentBalances(agent.id)) {
    const store = this.store(), effective = this.effective();
    const backed = BigInt(balances.usd.backed), unsettled = BigInt(balances.sol.operatingUnsettled) + BigInt(balances.sol.operatingSettling), settled = BigInt(balances.usdc.operatingSettled);
    const blockers = [];
    if (agent.archived) return { state: 'archived', reason: agent.stateReason || 'Archived.', blockers };
    if (agent.launchState !== 'live') return { state: 'provisioning', reason: agent.launchState === 'failed' ? 'The launch failed.' : 'Waiting for the coin launch to confirm.', blockers };
    if (agent.integrityPaused) blockers.push({ code: 'integrity', reason: agent.integrityReason });
    if (agent.adminPaused) blockers.push({ code: 'admin', reason: agent.adminPauseReason || 'Paused by the platform.' });
    if (!effective.runsOpen || !effective.modelOpen) blockers.push({ code: 'provider', reason: !effective.master ? 'AI Agent mode is disabled on this host.' : !effective.runs ? 'Agent runs are paused platform-wide.' : !effective.model ? 'Model execution is disabled.' : 'The model provider is not configured.' });
    if (agent.creatorPaused) blockers.push({ code: 'creator', reason: 'Paused by the creator.' });
    const run = store.activeRun(agent.id);
    const pricing = this.registry.pricing(agent.model), nextRun = pricing ? runReservationUsd({ pricing, browser: effective.browserOpen }, AGENT_POLICY_V1, this.config.rateCard) : BigInt(AGENT_POLICY_V1.activation.minimumRunUsd);
    const activated = !!agent.activatedAt;
    if (blockers.some(b => b.code === 'integrity')) return { state: 'paused_integrity', reason: agent.integrityReason, blockers };
    if (blockers.some(b => b.code === 'admin')) return { state: 'paused_admin', reason: agent.adminPauseReason || 'Paused by the platform.', blockers };
    if (blockers.some(b => b.code === 'provider')) return { state: 'paused_provider', reason: blockers.find(b => b.code === 'provider').reason, blockers };
    if (blockers.some(b => b.code === 'creator')) return { state: 'paused_creator', reason: 'Paused by the creator.', blockers };
    if (run && ['reserved', 'running', 'reconciling_cost'].includes(run.state)) return { state: 'running', reason: 'A run is in progress.', blockers };
    // Dry run: the mock model costs nothing, so activation and sleep do not depend on backed credit. Fees still accrue and settle only once dry run ends.
    if (this.config.dryRun) return { state: 'ready', reason: 'Dry run: labelled mock runs need no operating credit.', blockers };
    if (!activated) { if (canActivate(backed)) return { state: 'ready', reason: 'Backed credit reached the $2 activation threshold.', blockers }; return unsettled > 0n || settled > 0n ? { state: 'awaiting_settlement', reason: `Awaiting operating-credit settlement: ${displayUnits(unsettled)} SOL unsettled, ${displayUnits(settled, 6)} USDC awaiting provider backing.`, blockers } : { state: 'awaiting_funding', reason: 'Needs $2 of backed operating credit from fees or activity funding.', blockers }; }
    if (agent.state === 'sleeping_budget' ? !canResume(backed) : shouldSleep(backed, nextRun)) return { state: 'sleeping_budget', reason: `Operating credit ${formatUsdMicro(backed)} is below the ${agent.state === 'sleeping_budget' ? '$2 resume' : '$0.50 sleep'} threshold or the next run reservation.`, blockers };
    return { state: 'ready', reason: '', blockers };
  }
  refreshStates() {
    const store = this.store();
    for (const agent of store.allAgents({ includeArchived: true })) {
      if (agent.archived) { if (agent.state !== 'archived') store.updateAgent(agent.id, { state: 'archived' }); continue; }
      const balances = store.agentBalances(agent.id), derived = this.deriveState(agent, balances), patch = {};
      if (derived.state === 'ready' && !agent.activatedAt && agent.launchState === 'live') { patch.activatedAt = this.now(); store.addEvent({ agentId: agent.id, kind: 'activated', title: 'Agent activated', body: this.config.dryRun ? 'Dry run: scheduled mock runs can start without operating credit. Every output is labelled "[dry run]".' : 'Backed operating credit reached $2. Scheduled research runs can start.' }); }
      if (derived.state !== agent.state) { patch.state = derived.state; patch.stateReason = derived.reason; if (['sleeping_budget', 'paused_provider', 'paused_admin', 'paused_creator', 'paused_integrity'].includes(derived.state) && agent.state !== derived.state) store.addEvent({ agentId: agent.id, kind: 'state', title: AGENT_STATE_LABELS[derived.state], body: derived.reason }); if (derived.state === 'ready' && ['sleeping_budget', 'paused_provider', 'paused_admin', 'paused_creator'].includes(agent.state)) store.addEvent({ agentId: agent.id, kind: 'state', title: 'Resumed', body: 'The agent is eligible for runs again.' }); }
      else if (derived.reason !== agent.stateReason) patch.stateReason = derived.reason;
      if (Object.keys(patch).length) store.updateAgent(agent.id, patch);
    }
  }
  // ---- worker loop ----------------------------------------------------------------------------
  async process() {
    if (this.closed || !this.available()) return;
    const store = await this.ensure(); this.passes++;
    let chain = null; try { chain = await this.chainFactory(); } catch (error) { store.raiseAlert({ scope: 'global', code: 'rpc', message: safeError(error) }); }
    try {
      await this.syncLaunches(); if (this.closed) return;
      if (chain) { store.clearAlert('global', 'rpc'); try { this.lastSolUsd = await chain.solUsd(); } catch { /* A missing price blocks treasury actions, nothing else. */ } if (this.closed) return; await this.discoverFees(chain); if (this.closed) return; await this.reconcileFunding(chain); if (this.closed) return; await this.settle(chain); if (this.closed) return; await this.processReimbursements(chain); if (this.closed) return; await this.remitPlatformShare(chain); if (this.closed) return; }
      this.refreshStates();
      await this.registry.refresh().catch(() => {}); if (this.closed) return;
      await this.runner.tick(); if (this.closed) return;
      if (chain) await this.executor.tick(chain);
      if (this.closed) return;
      // Influencer media jobs and queued X posts advance once per pass; every step is its own transaction.
      await this.influencer.tick().catch(error => store.raiseAlert({ scope: 'global', code: 'influencer', message: safeError(error) })); if (this.closed) return;
      this.refreshStates();
      this.maintenance();
    } catch (error) { if (!this.closed) store.raiseAlert({ scope: 'global', code: 'pass', message: safeError(error) }); }
    finally { await chain?.close?.(); }
  }
  maintenance() {
    const store = this.store();
    if (this.passes % 5 === 1) { const check = store.ledger.verify(); if (!check.ok) { store.raiseAlert({ scope: 'global', code: 'ledger', message: 'The agent ledger failed its balance audit; new financial actions are paused.', detail: { problems: check.problems.slice(0, 10) } }); } else store.clearAlert('global', 'ledger'); }
    if (this.passes % 15 === 1) { store.pruneExpired(); try { this.xAccounts.prune?.(); } catch { /* Expired connection states are pruned again on the next pass. */ } }
    if (this.passes % 60 === 1) { try { this.db.backup(this.backupDirectory()); } catch (error) { store.raiseAlert({ scope: 'global', code: 'backup', message: safeError(error) }); } }
    this.db.checkpoint();
  }
  kick() { if (this.closed || this.running || !this.available()) return this.running; this.running = this.process().catch(() => {}).finally(() => { this.running = null; }); return this.running; }
  start() { if (this.timer || this.closed || !this.available()) return; this.timer = setInterval(() => this.kick(), this.intervalMs); this.timer.unref?.(); this.initial = setTimeout(() => { this.initial = null; this.kick(); }, Math.min(this.intervalMs, 3000)); this.initial.unref?.(); }
  // Shutdown never waits on the network: a pass in flight gets a few seconds
  // (every step of a pass is its own transaction, so abandoning it is safe), a
  // running agent job is cancelled and its worker killed. The database is
  // closed only when nothing is still using it; otherwise process exit releases it.
  async close() {
    this.closed = true; clearInterval(this.timer); this.timer = null; clearTimeout(this.initial); this.initial = null;
    const settled = await Promise.race([Promise.resolve(this.running).then(() => true), new Promise(resolve => { const t = setTimeout(() => resolve(false), CLOSE_GRACE_MS); t.unref?.(); })]);
    await this.runner.close?.();
    await this.influencer.close?.().catch(() => {});
    if (settled) { try { this.db?.close(); } catch { /* Already closed. */ } }
  }
  emit(agentId, event) { this.events.emit('event', { agentId, ...event }); }
  // ---- creator controls -------------------------------------------------------------------------
  async requireCreator(session, mint, context) {
    const store = this.store(), agent = store.agentByMint(mint); if (!agent) fail('Agent not found.', 404);
    const current = context?.authorize ? await context.authorize() : session; if (!current || current.account.id !== agent.accountId) fail('Only this coin’s creator account can change its agent.', 403);
    if (current.account.authType === 'wallet' && agent.creatorWallet && current.walletVerified === true && current.walletAddress !== agent.creatorWallet) fail('Connect the wallet that launched this coin.', 403);
    return { agent, current };
  }
  async revise(session, { mint, mission, personalityPreset, personality, domains, model, objective, objectiveSettings } = {}, context) {
    const store = this.store(), { agent, current } = await this.requireCreator(session, mint, context), changes = {};
    if (mission !== undefined) { if (!validMission(mission)) fail(`A mission of 1–${AGENT_LIMITS.missionChars} characters is required.`); if (mission.trim() !== agent.mission) changes.mission = mission.trim(); }
    if (personalityPreset !== undefined) { if (!AGENT_PERSONALITIES.some(p => p.id === personalityPreset)) fail('Choose a personality preset.'); if (personalityPreset !== agent.personalityPreset) changes.personalityPreset = personalityPreset; }
    const preset = changes.personalityPreset || agent.personalityPreset;
    if (personality !== undefined || changes.personalityPreset) { const text = preset === 'custom' ? String(personality ?? agent.personality).trim() : ''; if (!validPersonality(text) || (preset === 'custom' && !text)) fail('Describe the custom personality.'); if (text !== agent.personality) changes.personality = text; }
    if (domains !== undefined) { const list = normalizeDomains(domains); if (JSON.stringify(list) !== JSON.stringify(agent.domains)) changes.domains = list; }
    if (model !== undefined) { if (!this.config.models.includes(model)) fail('Choose a model from the supported list.'); if (model !== agent.model) changes.model = model; }
    // Objective: any catalogue id whose program the launched capabilities satisfy (capabilities never change); settings are re-validated for the objective in force.
    if (objective !== undefined || objectiveSettings !== undefined) {
      // Same objective: given numbers patch the saved ones. New objective: only the given numbers count, the rest take the catalogue defaults.
      const same = objective === undefined || objective === (agent.objective || 'custom'), given = objectiveSettings && typeof objectiveSettings === 'object' && !Array.isArray(objectiveSettings) ? objectiveSettings : undefined;
      const choice = objectiveChoice(same ? agent.objective || 'custom' : objective, same ? { ...(agent.objectiveSettings || {}), ...(given || {}) } : given, agent.capabilities);
      if (choice.objective !== (agent.objective || 'custom')) changes.objective = choice.objective;
      if (JSON.stringify(choice.objectiveSettings) !== JSON.stringify(agent.objectiveSettings || {})) changes.objectiveSettings = choice.objectiveSettings;
    }
    if (!Object.keys(changes).length) return this.creatorView(agent);
    const revision = store.addRevision(agent.id, { actor: 'creator:' + current.account.id, kind: 'settings', changes });
    // A new objective or new program numbers start the program schedule over; counters and launch facts are kept.
    store.updateAgent(agent.id, { ...changes, ...(changes.objective || changes.objectiveSettings ? { programState: resetProgramSchedule(agent.programState) } : {}) });
    store.addEvent({ agentId: agent.id, kind: 'revision', title: `Settings revised (r${revision})`, body: Object.keys(changes).map(key => key === 'model' ? `Model changed to ${changes.model}.` : key === 'mission' ? 'Mission updated.' : key === 'domains' ? `Research domains: ${changes.domains.join(', ') || 'none'}.` : key === 'objective' ? `Objective changed to ${objectiveById(changes.objective).name}.` : key === 'objectiveSettings' ? 'Program settings updated.' : 'Personality updated.').join(' '), data: { revision, fields: Object.keys(changes) } });
    return this.creatorView(store.agent(agent.id));
  }
  async setCreatorPause(session, { mint, paused } = {}, context) {
    const store = this.store(), { agent } = await this.requireCreator(session, mint, context);
    if (typeof paused !== 'boolean') fail('Choose pause or resume.');
    if (agent.creatorPaused !== paused) { store.updateAgent(agent.id, { creatorPaused: paused }); store.addEvent({ agentId: agent.id, kind: 'revision', title: paused ? 'Paused by creator' : 'Resumed by creator', body: paused ? 'No new runs start while paused. Fees keep accruing and signed transactions still reconcile.' : 'Runs resume when the agent is eligible.' }); this.refreshStates(); }
    return this.creatorView(store.agent(agent.id));
  }
  creatorView(agent) { return { id: agent.id, mint: agent.mint, mission: agent.mission, personalityPreset: agent.personalityPreset, personality: agent.personality, domains: agent.domains, model: agent.model, objective: agent.objective || 'custom', objectiveSettings: agent.objectiveSettings || {}, capabilities: capabilityList(agent.capabilities), creatorPaused: !!agent.creatorPaused, revision: agent.revision, state: agent.state, models: this.config.models, approvedDomains: this.approvedDomains(agent), influencer: this.influencer.view(agent), moderation: agent.hidden ? { hidden: true, reason: agent.hiddenReason || '', at: agent.hiddenAt || null } : null }; }
  approvedDomains(agent) { const global = this.config.domainAllowlist; return (agent.domains || []).filter(domain => global.some(allowed => domain === allowed || domain.endsWith('.' + allowed))); }
  // ---- owner controls --------------------------------------------------------------------------
  async control(actorId, { flags, agentId, adminPaused, reason, clearIntegrity, hidden, influencerPaused } = {}) {
    const actor = await this.requireAdmin(actorId), store = await this.ensure();
    if (typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 500) fail('Enter a reason between 5 and 500 characters.');
    if (flags !== undefined) { if (!flags || typeof flags !== 'object') fail('Invalid flags.'); const next = { ...this.flags() }; for (const key of Object.keys(DEFAULT_FLAGS)) if (flags[key] !== undefined) { if (typeof flags[key] !== 'boolean') fail(`Invalid ${key} flag.`); next[key] = flags[key]; } store.setSetting('flags', next, actor.username); }
    if (agentId !== undefined) {
      const agent = store.requireAgent(agentId), patch = {};
      if (adminPaused !== undefined) { if (typeof adminPaused !== 'boolean') fail('Invalid pause setting.'); patch.adminPaused = adminPaused; patch.adminPauseReason = adminPaused ? reason.trim() : ''; }
      if (clearIntegrity === true) { patch.integrityPaused = false; patch.integrityReason = ''; store.clearAlert('agent:' + agent.id, 'integrity'); }
      // v71.37: a hidden agent keeps the reason, the time and the moderator with it (shown to the creator on its own page and to admins on the directory).
      if (hidden !== undefined) { if (typeof hidden !== 'boolean') fail('Invalid hidden setting.'); patch.hidden = hidden; patch.hiddenReason = hidden ? reason.trim() : ''; patch.hiddenAt = hidden ? this.now() : null; patch.hiddenBy = hidden ? actor.username : ''; }
      if (Object.keys(patch).length) { store.updateAgent(agent.id, patch); store.addEvent({ agentId: agent.id, kind: 'admin', title: adminPaused === true ? 'Paused by the platform' : adminPaused === false ? 'Platform pause lifted' : clearIntegrity ? 'Integrity check cleared' : hidden === true ? 'Hidden by moderation' : 'Moderation updated', body: adminPaused === true ? reason.trim() : '', isPublic: hidden === undefined }); }
      // v71.30 AI influencer: the platform can pause an agent's posting and media separately from its runs.
      if (influencerPaused !== undefined) {
        if (typeof influencerPaused !== 'boolean') fail('Invalid influencer pause setting.');
        if (!store.influencer(agent.id)) fail('This agent has no influencer.', 404);
        store.updateInfluencer(agent.id, { adminPaused: influencerPaused, adminPauseReason: influencerPaused ? reason.trim() : '' });
        store.addEvent({ agentId: agent.id, kind: 'influencer', title: influencerPaused ? 'Posting paused by the platform' : 'Posting resumed by the platform', body: influencerPaused ? reason.trim() : '' });
      }
    }
    store.audit({ actorId, actor: actor.username, action: 'control', target: agentId || 'flags', detail: { flags, adminPaused, clearIntegrity, hidden, influencerPaused }, reason: reason.trim() });
    await this.requireAdmin(actorId); this.refreshStates(); this.kick();
    return { flags: this.flags(), effective: this.effective() };
  }
  async verifyKeys(actorId) {
    await this.requireAdmin(actorId); const store = await this.ensure(), rows = [];
    for (const agent of store.allAgents({ includeArchived: true })) { try { const signer = await this.signer(agent.id); rows.push({ id: agent.id, wallet: agent.wallet, ok: signer.address === agent.wallet }); } catch (error) { rows.push({ id: agent.id, wallet: agent.wallet, ok: false, error: safeError(error) }); } }
    return { checked: rows.length, ok: rows.every(row => row.ok), rows };
  }
  /** Re-encrypts every agent key document under the current master key (fresh IV/tag). Wallet addresses cannot change: fee recipients are immutable. */
  async rotateKeys(actorId, { reason = '' } = {}) {
    const actor = await this.requireAdmin(actorId), store = await this.ensure(); if (reason.trim().length < 5) fail('Enter a reason of at least 5 characters.');
    let rotated = 0;
    for (const agent of store.allAgents({ includeArchived: true })) { const key = await this.accounts.hostStore.read(KEY_PREFIX + agent.id, null); if (!key || key.address !== agent.wallet) continue; await this.accounts.hostStore.write(KEY_PREFIX + agent.id, { ...key, rotatedAt: this.now() }); rotated++; }
    store.audit({ actorId, actor: actor.username, action: 'key-rewrap', target: 'all', detail: { rotated }, reason: reason.trim() });
    await this.requireAdmin(actorId);
    return { rotated, note: 'Keys were re-encrypted in place. Agent wallet addresses are immutable because launches assign fees to them.' };
  }
  /** Owner health check: catalog freshness, provider balances, browser sessions, database integrity. Never spends. */
  async providerHealth(actorId, { releaseOrphans = false } = {}) {
    const actor = await this.requireAdmin(actorId), store = await this.ensure(), result = { at: this.now(), model: null, browser: null, database: { ok: this.db.integrity(), version: this.db.version() }, worker: this.runner.worker?.status?.() || null, dryRun: this.config.dryRun };
    await this.registry.refresh({ force: true }).catch(() => {});
    result.catalog = this.registry.status();
    if (this.config.openrouterKey) { try { const credits = await providerCredits({ apiKey: this.config.openrouterKey }); result.model = { configured: true, ok: true, remainingUsd: formatUsdMicro(credits.remainingUsd || 0n), totalCreditsUsd: formatUsdMicro(credits.totalCreditsUsd || 0n), totalUsageUsd: formatUsdMicro(credits.totalUsageUsd || 0n) }; const capacity = BigInt(store.platformBalances().providerCapacityUsd) + BigInt(store.totals().usdBacked) + BigInt(store.totals().usdReserved); if ((credits.remainingUsd || 0n) < capacity) store.raiseAlert({ scope: 'provider', code: 'capacity', message: `OpenRouter reports ${formatUsdMicro(credits.remainingUsd || 0n)} remaining but the ledger backs ${formatUsdMicro(capacity)}.` }); else store.clearAlert('provider', 'capacity'); } catch (error) { result.model = { configured: true, ok: false, error: safeError(error) }; } }
    else result.model = { configured: false, ok: false, error: 'LAUNCHPAD_AGENTS_OPENROUTER_KEY is not set.' };
    if (this.config.browserbaseKey && this.config.browserbaseProject) {
      try { const sessions = await listRunningSessions({ apiKey: this.config.browserbaseKey }); const known = new Set(store.openBrowserSessions().map(session => session.providerSessionId).filter(Boolean)); const orphans = sessions.filter(session => !known.has(session.id)); let released = 0; if (releaseOrphans) for (const session of orphans) { if (await releaseSession({ apiKey: this.config.browserbaseKey, id: session.id })) released++; } result.browser = { configured: true, ok: true, running: sessions.length, orphans: orphans.length, released }; if (orphans.length && !releaseOrphans) store.raiseAlert({ scope: 'provider', code: 'orphan-browsers', message: `${orphans.length} browser session(s) are running without a known run.` }); else store.clearAlert('provider', 'orphan-browsers'); }
      catch (error) { result.browser = { configured: true, ok: false, error: safeError(error) }; }
    } else result.browser = { configured: false, ok: false, error: 'LAUNCHPAD_AGENTS_BROWSERBASE_KEY / LAUNCHPAD_AGENTS_BROWSERBASE_PROJECT are not set.' };
    store.audit({ actorId, actor: actor.username, action: 'provider-health', detail: { releaseOrphans } });
    await this.requireAdmin(actorId);
    return result;
  }
  backupDirectory() { return this.config.backupDir || join(this.accounts.dir, 'agents', 'backups'); }
  async backup(actorId) { const actor = await this.requireAdmin(actorId), store = await this.ensure(); const directory = this.backupDirectory(); const target = this.db.backup(directory); store.audit({ actorId, actor: actor.username, action: 'backup', target }); return { path: target, at: this.now() }; }
}
export { AGENT_RULES, AGENT_FUNDING_SUMMARY, AGENT_TOOLS, capabilityList, lamportsToUsd, priceMicro, freshPrice, splitBps, policyHash, formatUsdMicro };
