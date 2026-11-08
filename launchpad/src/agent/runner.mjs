// Scheduler and run supervisor of the AI Agent core. Decides which agents may
// run (state, cadence, daily and global budgets, concurrency), reserves the
// worst-case cost before anything is sent, hands sanitized jobs to the
// isolated worker, answers its data-tool calls, records provider usage and
// settles every reservation exactly once.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { displayUnits } from '../../public/launchpad-model.mjs';
import { AGENT_POLICY_V1, capabilityList, formatUsdMicro, hasCapability, objectiveById } from '../../public/agent-catalog.mjs';
import { runReservationUsd, dailyBudgetUsd, dayKey, lamportsToUsd, priceMicro, freshPrice, treasuryCaps } from './policy.mjs';
import { toolDefinitions } from './tools.mjs';
import { runAgentLoop } from './loop.mjs';
import { holderSummary } from './holders.mjs';
import { normalizeProgramState, effectiveRule } from './programs.mjs';
import { safeError } from './service.mjs';

const LEASE_MS = 150000, GRACE_MS = 300000;
const clip = (value, max) => { const text = String(value ?? ''); return text.length > max ? text.slice(0, max - 1) + '…' : text; };
const base58 = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
/** Public market fields of a discovery coin record: nothing but the published numbers and labels. */
export function coinSnapshot(coin, { venue = null } = {}) {
  return { mint: coin.mint, name: clip(coin.name, 60), symbol: clip(coin.symbol, 24), venue: venue || coin.platform || null, feeMode: coin.feeMode || null, priceUsd: number(coin.priceUsd), marketCapUsd: number(coin.marketCapUsd) ?? number(coin.fdvUsd), volume24hUsd: number(coin.volume24h), priceChange24h: number(coin.priceChange24h), liquidityUsd: number(coin.liquidityUsd), progressPercent: number(coin.progressPercent), stage: coin.stage || 'new', graduated: coin.stage === 'graduated', at: coin.marketAt || null, stale: coin.stale !== false, href: '/coin?mint=' + coin.mint };
}

/** In-process worker for tests and single-process dry runs: same contract as the child process. */
export class InlineWorker {
  constructor({ model, browserFactory = null } = {}) { this.model = model; this.browserFactory = browserFactory; this.active = new Map(); }
  async run(job, hooks) { const result = await runAgentLoop({ job, model: this.model, browserFactory: this.browserFactory, callTool: hooks.onTool, onUsage: hooks.onUsage, onEvent: hooks.onEvent }); return result; }
  cancel() {}
  async close() {}
  status() { return { kind: 'inline', ready: true }; }
}
/** Child-process worker client with a minimal environment and JSON-lines protocol. */
export class WorkerClient {
  constructor({ config, workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url)), spawnImpl = spawn, now = Date.now } = {}) { this.config = config; this.workerPath = workerPath; this.spawnImpl = spawnImpl; this.now = now; this.child = null; this.jobs = new Map(); this.ready = false; this.restarts = 0; this.closed = false; }
  env() { const env = { PATH: process.env.PATH || '', NODE_ENV: 'production', OPENROUTER_KEY: this.config.openrouterKey, BROWSERBASE_KEY: this.config.browserbaseKey, BROWSERBASE_PROJECT: this.config.browserbaseProject, BROWSERBASE_REGION: this.config.browserbaseRegion, AGENT_DRY_RUN: this.config.dryRun ? '1' : '0' }; for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) if (process.env[key]) env[key] = process.env[key]; return env; }
  start() {
    if (this.child || this.closed) return;
    const child = this.spawnImpl(process.execPath, [this.workerPath], { env: this.env(), stdio: ['pipe', 'pipe', 'pipe'], cwd: process.cwd() });
    this.child = child; this.ready = false;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => { let message; try { message = JSON.parse(line); } catch { return; } this.receive(message); });
    child.stderr?.on('data', () => {});
    child.on('exit', () => { this.child = null; this.ready = false; for (const [id, job] of this.jobs) { job.resolve({ summary: '', error: 'The worker process exited before the run finished; its cost is retained until reconciled.', errorCode: 'worker-exit', usage: { spentUsd: '0', disputedUsd: job.reservedUsd, modelCalls: 0, toolCalls: 0, browserActions: 0, browserSeconds: 0, providerRequests: [] }, tools: [] }); this.jobs.delete(id); } if (!this.closed) { this.restarts++; setTimeout(() => this.start(), Math.min(60000, 2000 * 2 ** Math.min(this.restarts, 5))).unref?.(); } });
  }
  send(message) { if (!this.child) this.start(); try { this.child?.stdin.write(JSON.stringify(message) + '\n'); } catch { /* The exit handler fails the job. */ } }
  receive(message) {
    if (message.type === 'ready') { this.ready = true; this.capabilities = message; return; }
    const job = this.jobs.get(message.id); if (!job) return;
    if (message.type === 'tool') { job.hooks.onTool(message.name, message.args).then(result => this.send({ type: 'tool-result', id: message.id, seq: message.seq, result }), error => this.send({ type: 'tool-result', id: message.id, seq: message.seq, error: safeError(error), code: error?.code || 'AGENT_TOOL' })); return; }
    if (message.type === 'usage') { job.hooks.onUsage(message.event).catch(() => {}); return; }
    if (message.type === 'event') { job.hooks.onEvent(message.event).catch(() => {}); return; }
    if (message.type === 'screenshot') { job.hooks.onScreenshot?.({ url: message.url, bytes: Buffer.from(String(message.bytes || ''), 'base64') })?.catch?.(() => {}); return; }
    if (message.type === 'done') { if (message.fence !== job.fence) return; this.jobs.delete(message.id); job.resolve(message.result); }
  }
  run(job, hooks) { return new Promise(resolve => { this.jobs.set(job.id, { hooks, resolve, fence: job.fence, reservedUsd: job.budget.reservedUsd }); this.send({ type: 'run', job }); }); }
  cancel(id) { this.send({ type: 'cancel', id }); }
  async close() { this.closed = true; try { this.child?.stdin.end(); this.child?.kill(); } catch { /* Already gone. */ } }
  status() { return { kind: 'process', ready: this.ready, restarts: this.restarts, pid: this.child?.pid || null, inFlight: this.jobs.size }; }
}

export class AgentRunner {
  constructor({ service, worker = null, browser = null }) { this.service = service; this.worker = worker; this.browser = browser; this.active = new Map(); this.ownerId = 'core-' + randomBytes(4).toString('hex'); }
  get now() { return this.service.now; }
  workerClient() { if (!this.worker) this.worker = new WorkerClient({ config: this.service.config, now: this.service.now }); return this.worker; }
  // Cancel in-flight jobs, give the worker a moment to report them, then kill
  // it; a killed worker fails its jobs with their cost retained as disputed.
  async close() {
    for (const [id] of this.active) this.worker?.cancel?.(id);
    await Promise.race([this.drain(), new Promise(resolve => { const t = setTimeout(resolve, 8000); t.unref?.(); })]);
    await this.worker?.close?.();
    await Promise.race([this.drain(), new Promise(resolve => { const t = setTimeout(resolve, 2000); t.unref?.(); })]);
  }
  /** Runs started by a previous process whose lease expired: cost unknown, reservation retained as disputed. */
  recoverStaleRuns() {
    const store = this.service.store();
    for (const run of store.activeRuns()) {
      if (this.active.has(run.id)) continue;
      if (run.state === 'queued' || (run.leaseExpiresAt && run.leaseExpiresAt + GRACE_MS < this.now())) {
        store.settleRun(run.id, { spentUsd: '0', disputedUsd: run.state === 'queued' ? '0' : run.reservedUsd });
        store.updateRun(run.id, { state: 'failed', errorCode: 'lease-expired', error: 'The run lease expired without a result; its reservation is retained until the provider bill is reconciled.', finishedAt: this.now() });
        store.addEvent({ agentId: run.agentId, runId: run.id, kind: 'run', title: 'Run abandoned', body: 'A previous worker stopped without reporting. Reserved credit stays on hold until reconciled.', isPublic: false });
      }
    }
  }
  globalSpentToday() { const store = this.service.store(), today = dayKey(this.now()); let total = 0n; for (const agent of store.allAgents({ includeArchived: false })) if (agent.dayKey === today) total += BigInt(agent.daySpentUsd || '0'); for (const [, item] of this.active) total += BigInt(item.reservedUsd); return total; }
  async tick() {
    const service = this.service, store = service.store(), effective = service.effective();
    this.recoverStaleRuns();
    if (!effective.runsOpen || !effective.modelOpen) return;
    if (store.openAlerts().some(alert => alert.scope === 'global' && alert.code === 'ledger')) return;
    const today = dayKey(this.now()), concurrency = service.config.modelConcurrency, dry = !!service.config.dryRun;
    const candidates = store.allAgents({ includeArchived: false }).filter(agent => agent.state === 'ready' && agent.mint && agent.launchState === 'live' && !agent.creatorPaused && !agent.adminPaused && !agent.integrityPaused && agent.nextRunAt <= this.now() && this.now() - agent.lastRunStartedAt >= AGENT_POLICY_V1.run.minimumStartGapMinutes * 60000 && !store.activeRun(agent.id)).sort((a, b) => a.lastRunStartedAt - b.lastRunStartedAt || a.createdAt - b.createdAt);
    for (const agent of candidates) {
      if (this.active.size >= concurrency) break;
      const pricing = service.registry.pricing(agent.model); if (!pricing || !pricing.supportsTools) { store.updateAgent(agent.id, { stateReason: 'Model pricing is stale or the model does not support tools; runs wait for a fresh catalog.' }); continue; }
      const balances = store.agentBalances(agent.id), backed = BigInt(balances.usd.backed);
      const reservation = runReservationUsd({ pricing, browser: effective.browserOpen && hasCapability(agent.capabilities, 'browser') }, AGENT_POLICY_V1, service.config.rateCard);
      let dayBudget = BigInt(agent.dayBudgetUsd || '0'), daySpent = BigInt(agent.daySpentUsd || '0');
      // Dry run keeps the cadence and the per-agent daily cap as virtual limits but reserves and spends no credit.
      if (agent.dayKey !== today) { dayBudget = dry ? BigInt(AGENT_POLICY_V1.budget.agentDailyCapUsd) : dailyBudgetUsd(backed, AGENT_POLICY_V1, service.influencer?.dailyAllowanceUsd?.(agent) ?? 0n); daySpent = 0n; store.updateAgent(agent.id, { dayKey: today, dayBudgetUsd: dayBudget.toString(), daySpentUsd: '0' }); }
      if (!dry && backed < reservation) continue;
      if (daySpent + reservation > dayBudget) { store.updateAgent(agent.id, { nextRunAt: nextUtcDay(this.now()), stateReason: `Today's budget (${formatUsdMicro(dayBudget)}) is used; runs resume after midnight UTC.` }); continue; }
      if (!dry && this.globalSpentToday() + reservation > service.config.globalDailyUsd) { store.raiseAlert({ scope: 'global', code: 'provider-cap', message: 'The platform-wide daily provider ceiling is reached; new runs wait for the next UTC day.' }); break; }
      await this.startRun(agent, { reservation, pricing, effective, dayBudget, daySpent });
    }
    // Housekeeping: close browser sessions whose run finished, prune stale screenshots.
    for (const session of store.openBrowserSessions()) if (session.expiresAt < this.now()) store.updateBrowserSession(session.id, { state: 'expired', closedAt: this.now() });
  }
  async startRun(agent, { reservation, pricing, effective, dayBudget, daySpent }) {
    const service = this.service, store = service.store();
    let run;
    try { run = store.createRun({ agentId: agent.id, trigger: 'schedule', policyHash: agent.policyHash, model: agent.model, revision: agent.revision, dryRun: service.config.dryRun }); if (!service.config.dryRun) store.reserveRun(run.id, reservation.toString()); }
    catch (error) { store.addEvent({ agentId: agent.id, kind: 'run', title: 'Run skipped', body: safeError(error), isPublic: false }); return; }
    const lease = store.claimRun(run.id, this.ownerId, LEASE_MS); if (!lease) return;
    const cadence = dayBudget - daySpent - reservation < reservation ? nextUtcDay(this.now()) : this.now() + AGENT_POLICY_V1.run.cadenceMinutes * 60000;
    store.updateAgent(agent.id, { lastRunStartedAt: this.now(), nextRunAt: cadence, daySpentUsd: (daySpent + reservation).toString(), state: 'running', stateReason: 'A run is in progress.' });
    store.updateRun(run.id, { state: 'running', startedAt: this.now() });
    const browserAllowed = effective.browserOpen && hasCapability(agent.capabilities, 'browser') && service.approvedDomains(agent).length > 0;
    // v71.30 AI influencer: post_to_x is offered only when a post is due and allowed right now; the character and quota
    // context rides along for the prompts (no new capability bit: the influencer is a per-agent record).
    const posting = service.influencer?.postingAllowed?.(agent, this.now()) === true, influencer = service.influencer?.promptContext?.(agent) ?? null;
    const job = { id: run.id, fence: lease.fence, dryRun: service.config.dryRun, agent: { name: agent.name, symbol: agent.symbol, route: agent.route, mission: agent.mission, personality: agent.personality, personalityPreset: agent.personalityPreset, model: agent.model, objective: agent.objective || 'custom', objectiveSettings: agent.objectiveSettings || {}, createdAt: agent.createdAt, ...(influencer ? { influencer } : {}) }, capabilities: capabilityList(agent.capabilities).filter(name => name !== 'browser' || browserAllowed), approvedDomains: browserAllowed ? service.approvedDomains(agent) : [], policy: { hash: agent.policyHash, version: agent.policyVersion }, rateCard: service.config.rateCard, pricing: { promptMicroPerMillion: pricing.promptMicroPerMillion.toString(), completionMicroPerMillion: pricing.completionMicroPerMillion.toString(), requestUsd: String(pricing.requestUsd || 0) }, budget: { reservedUsd: reservation.toString(), maxSeconds: AGENT_POLICY_V1.run.maxSeconds, maxModelCalls: AGENT_POLICY_V1.run.maxModelCalls, maxToolCalls: AGENT_POLICY_V1.run.maxToolCalls, maxOutputTokens: AGENT_POLICY_V1.run.maxOutputTokens, maxPromptTokens: AGENT_POLICY_V1.run.maxPromptTokens, browserMaxSeconds: AGENT_POLICY_V1.run.browserMaxSeconds, browserMaxActions: AGENT_POLICY_V1.run.browserMaxActions }, context: { ...(await this.context(agent)), influencer }, tools: toolDefinitions({ buyback: hasCapability(agent.capabilities, 'buyback'), rewards: hasCapability(agent.capabilities, 'rewards'), browser: browserAllowed, influencer: posting }) };
    const worker = this.workerClient(), entry = { reservedUsd: reservation.toString(), agentId: agent.id, startedAt: this.now() };
    this.active.set(run.id, entry);
    let session = null;
    const hooks = {
      onTool: (name, args) => this.executeTool(agent.id, run.id, name, args),
      onUsage: async event => { try { store.recordUsage({ runId: run.id, agentId: agent.id, ...event, ...(service.config.dryRun ? { provider: 'dry-run', costUsd: '0', state: 'resolved' } : {}) }); } catch { /* Duplicate usage ids settle once. */ } },
      onEvent: async event => { store.addEvent({ agentId: agent.id, runId: run.id, kind: event.kind || 'run', title: clip(event.title, 200), body: clip(event.body, 2000), data: event.data || {} }); service.emit(agent.id, { kind: event.kind || 'run', title: event.title }); },
      onScreenshot: async ({ url, bytes }) => { if (!session) session = store.createBrowserSession({ agentId: agent.id, runId: run.id, provider: 'browserbase', expiresAt: this.now() + 120000 }); if (store.screenshotCount(agent.id) < 60 && bytes.length) store.addScreenshot({ sessionId: session.id, agentId: agent.id, url, bytes, retainMs: AGENT_POLICY_V1.browser.retainScreenshotsDays * 86400000 }); store.updateBrowserSession(session.id, { currentUrl: clip(url, 500) }); service.emit(agent.id, { kind: 'screenshot', title: url }); },
    };
    const renewal = setInterval(() => { if (!store.renewRun(run.id, this.ownerId, lease.fence, LEASE_MS)) { clearInterval(renewal); worker.cancel?.(run.id); } }, 60000); renewal.unref?.();
    entry.promise = worker.run(job, hooks).then(result => this.finishRun(agent.id, run.id, lease.fence, result, session), error => this.finishRun(agent.id, run.id, lease.fence, { summary: '', error: safeError(error), errorCode: 'worker-error', usage: { spentUsd: '0', disputedUsd: reservation.toString(), modelCalls: 0, toolCalls: 0, browserActions: 0, browserSeconds: 0, providerRequests: [] } }, session)).catch(() => {}).finally(() => { clearInterval(renewal); this.active.delete(run.id); });
  }
  /** Waits for every in-flight run (tests, shutdown). */
  async drain() { await Promise.allSettled([...this.active.values()].map(entry => entry.promise)); }
  finishRun(agentId, runId, fence, result, session) {
    const service = this.service, store = service.store(), run = store.run(runId); if (!run || run.fence !== fence || !['running', 'reserved'].includes(run.state)) return;
    // A dry run never touched a provider: its estimate is recorded as zero spend and no ledger entry is posted (nothing was reserved).
    const usage = result.usage || {}, spent = run.dryRun ? 0n : BigInt(usage.spentUsd || '0'), disputed = run.dryRun ? 0n : BigInt(usage.disputedUsd || '0');
    store.updateRun(runId, { state: 'reconciling_cost', modelCalls: usage.modelCalls || 0, toolCalls: usage.toolCalls || 0, browserActions: usage.browserActions || 0, browserSeconds: usage.browserSeconds || 0, providerRequests: usage.providerRequests || [], summary: clip(result.summary, 1000), errorCode: result.errorCode || '', error: clip(result.error, 300) });
    store.settleRun(runId, { spentUsd: spent.toString(), disputedUsd: disputed.toString() });
    const agent = store.agent(agentId), charged = spent + disputed, reserved = BigInt(run.reservedUsd), refund = reserved > charged ? reserved - charged : 0n;
    if (agent) store.updateAgent(agentId, { daySpentUsd: (BigInt(agent.daySpentUsd || '0') - refund > 0n ? BigInt(agent.daySpentUsd || '0') - refund : 0n).toString() });
    const failed = !!result.errorCode && !['model-call-limit', 'reservation-exhausted', 'run-timeout'].includes(result.errorCode);
    store.updateRun(runId, { state: failed ? 'failed' : 'completed', finishedAt: this.now() });
    if (session) store.updateBrowserSession(session.id, { state: 'closed', closedAt: this.now(), actions: usage.browserActions || 0, seconds: usage.browserSeconds || 0 });
    store.addEvent({ agentId, runId, kind: 'run', title: failed ? 'Run failed' : run.dryRun ? '[dry run] Run completed' : 'Run completed', body: failed ? clip(result.error, 300) : clip(result.summary, 600), data: { spentUsd: spent.toString(), disputedUsd: disputed.toString(), modelCalls: usage.modelCalls || 0, toolCalls: usage.toolCalls || 0, browserActions: usage.browserActions || 0, dryRun: !!run.dryRun, ...(run.dryRun ? { estimatedUsd: String(usage.spentUsd || '0') } : {}), errorCode: result.errorCode || '' } });
    if (disputed > 0n) store.raiseAlert({ scope: 'agent:' + agentId, code: 'unknown-cost', message: `Run ${runId} has ${formatUsdMicro(disputed)} of unresolved provider cost.`, detail: { runId } });
    if (result.errorCode === 'provider-funds') { store.raiseAlert({ scope: 'global', code: 'provider-funds', message: 'The model provider reported exhausted prepaid credit. Runs are paused until the operator tops up and records the funding batch.' }); store.setSetting('flags', { ...service.flags(), model: false }, 'system'); }
    service.emit(agentId, { kind: 'run', title: failed ? 'Run failed' : 'Run completed' });
    service.refreshStates();
  }
  async context(agent) {
    const service = this.service, store = service.store();
    const market = await this.market(agent), treasury = this.treasurySummary(agent), fees = store.feeTotals(agent.id), notes = store.notes(agent.id, { limit: 6 }).map(note => ({ id: note.id, title: note.title, body: clip(note.body, 600) })), recentUpdates = store.events(agent.id, { limit: 3 }).filter(event => event.kind === 'update').map(event => ({ title: event.title, body: event.body }));
    return { market, treasury, feeSummary: { receipts: fees.count, totalSol: displayUnits(fees.total), operationsSol: displayUnits(fees.operations), treasurySol: displayUnits(fees.treasury), lastAt: fees.lastAt }, notes, recentUpdates, program: this.programSummary(agent) };
  }
  /** What the platform's program did or is waiting for, so the model can explain it (never change it). */
  programSummary(agent) {
    const objective = objectiveById(agent.objective || 'custom'), found = effectiveRule(objective); if (!objective?.program) return null;
    const state = normalizeProgramState(agent.programState);
    return { objective: objective.name, rule: objective.program.rule, limiter: objective.program.action === 'limiter', runsAs: found?.id || objective.id, status: state.lastNote || 'Not evaluated yet.', actions: state.actions, lastActionAt: state.lastActionAt, nextDueAt: state.nextDueAt, finished: state.finished };
  }
  async market(agent) {
    const discovery = this.service.discovery; if (!discovery || !agent.mint) return null;
    try { const inventory = await discovery.inventory(), record = inventory.get(agent.mint); if (!record) return null; if (typeof discovery.warm === 'function') await discovery.warm([record], { wait: 800, max: 1 }); return coinSnapshot(discovery.coin(record), { venue: agent.route }); } catch { return null; }
  }
  /** Public snapshot of any listed Launchpad coin (the model's choice of mint; nothing about the agent is derived from it). */
  async curveCoin(mint) {
    const discovery = this.service.discovery; if (!base58(mint)) return { note: 'That is not a valid Solana mint address.' };
    if (!discovery) return { note: 'The Launchpad coin directory is unavailable right now.' };
    try { const inventory = await discovery.inventory(), record = inventory.get(mint); if (!record) return { note: 'No coin with that mint is listed on Launchpad.' }; if (typeof discovery.warm === 'function') await discovery.warm([record], { wait: 800, max: 1 }); return coinSnapshot(discovery.coin(record)); } catch { return { note: 'The Launchpad coin directory is unavailable right now.' }; }
  }
  /** Public agent directory cards: the same fields the /agents page shows, nothing internal. */
  curveAgents() {
    const cards = this.service.views.list({ limit: 24 }).agents;
    return { agents: cards.map(card => ({ name: card.name, symbol: card.symbol, mint: card.mint, venue: card.route, objective: card.objective, objectiveName: card.objectiveName, state: card.stateLabel, mission: clip(card.mission, 160), treasurySol: card.treasurySol, href: card.href })), count: cards.length };
  }
  treasurySummary(agent) {
    const service = this.service, store = service.store(), balances = store.agentBalances(agent.id), open = store.openActions(agent.id);
    const price = service.lastSolUsd; let caps = null;
    if (price && freshPrice(price, this.now())) { try { const baseline = BigInt(balances.sol.treasuryAvailable) - BigInt(AGENT_POLICY_V1.treasury.gasReserveLamports); caps = treasuryCaps({ baselineLamports: baseline > 0n ? baseline : 0n, solUsdMicro: priceMicro(price.usd) }, AGENT_POLICY_V1); } catch { caps = null; } }
    return { treasury: { availableSol: displayUnits(balances.sol.treasuryAvailable), reservedSol: displayUnits(balances.sol.treasuryReserved), frozenRewardsSol: displayUnits(balances.sol.rewardFrozen), gasReserveSol: displayUnits(AGENT_POLICY_V1.treasury.gasReserveLamports) }, operating: { backedUsd: formatUsdMicro(balances.usd.backed), reservedUsd: formatUsdMicro(balances.usd.reserved), unsettledSol: displayUnits(balances.sol.operatingUnsettled) }, limits: caps ? { perActionSol: displayUnits(caps.perAction), hourlySol: displayUnits(caps.hourly), dailySol: displayUnits(caps.daily), minimumPrincipalSol: displayUnits(caps.minimumPrincipal) } : { note: 'Treasury caps need a fresh SOL/USD price; none is available right now.' }, capabilities: capabilityList(agent.capabilities), pendingActions: open.length, solUsd: price?.usd ?? null };
  }
  async executeTool(agentId, runId, name, args) {
    const service = this.service, store = service.store(), agent = store.agent(agentId); if (!agent) throw Object.assign(Error('Agent not found.'), { code: 'AGENT_TOOL' });
    switch (name) {
      case 'get_own_market': return (await this.market(agent)) || { note: 'No market snapshot is available right now.' };
      case 'get_own_treasury': return this.treasurySummary(agent);
      case 'get_own_fee_history': return { receipts: store.feeReceipts(agent.id, { limit: args.limit || 10 }).map(row => ({ at: row.createdAt, venue: row.venue, sol: displayUnits(row.amount), operationsSol: displayUnits(row.operations), treasurySol: displayUnits(row.treasury) })) };
      case 'get_own_holder_summary': { const latest = store.latestHolderSample(agent.id); if (!latest) return { note: 'No holder snapshot yet.' }; const full = store.holderSamples(agent.id, { from: latest.at, to: latest.at })[0]; return holderSummary(full, { exclude: new Set([agent.wallet]) }); }
      case 'get_curve_coin': return this.curveCoin(args.coinMint);
      case 'list_curve_agents': return this.curveAgents();
      case 'recall_memory': return { notes: store.recallNotes(agent.id, args.query, 8).map(note => ({ id: note.id, title: note.title, body: clip(note.body, 800), sourceUrl: note.sourceUrl, at: note.createdAt })) };
      case 'save_note': { const id = store.saveNote({ agentId: agent.id, runId, kind: 'note', title: args.title, body: args.body, sourceUrl: /^https:\/\//i.test(args.sourceUrl || '') ? args.sourceUrl : '', provenance: 'model' }); return { saved: true, id, activeNotes: store.noteCount(agent.id) }; }
      case 'publish_update': { const id = store.addEvent({ agentId: agent.id, runId, kind: 'update', title: args.title, body: args.body }); service.emit(agent.id, { kind: 'update', title: args.title }); return { published: true, id }; }
      case 'propose_buyback_burn': return service.executor.propose(agent, runId, 'buyback_burn', args);
      case 'propose_holder_reward': return service.executor.propose(agent, runId, 'holder_reward', args);
      // v71.30: the influencer queues the post; the platform picks the account, the link, the media and the moment.
      case 'post_to_x': return service.influencer.requestPost(agent, runId, args);
      default: throw Object.assign(Error('Unknown tool.'), { code: 'AGENT_TOOL' });
    }
  }
}
export function nextUtcDay(now) { const date = new Date(now); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1); }
export { lamportsToUsd };
