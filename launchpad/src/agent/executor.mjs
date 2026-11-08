// Deterministic financial executor of the AI Agent core. The model only ever
// proposes {kind, amount, reason}; everything else here is platform code:
// typed proposal -> policy evaluation -> atomic reservation -> canonical
// builder (verified route / airdrop) -> independent checks -> simulation ->
// journal (signed bytes before broadcast) -> broadcast -> finalized receipt
// reconciliation. Unknown outcomes keep their reservation. Buybacks burn only
// the purchased delta; holder rewards pay a frozen snapshot allocation.
import { createHash } from 'node:crypto';
import { displayUnits } from '../../public/launchpad-model.mjs';
import { AGENT_POLICY_V1, AGENT_QUOTE_MINT, formatUsdMicro, hasCapability } from '../../public/agent-catalog.mjs';
import { evaluateTreasuryProposal, treasuryCaps, priceMicro, freshPrice, dayKey, lamportsToUsd } from './policy.mjs';
import { rewardWindow, minimumBalances, topHolders, allocateRewards } from './holders.mjs';
import { tokenAsset } from './ledger.mjs';
import { modelProposalLimit, runObjectivePrograms } from './programs.mjs';
import { safeError } from './service.mjs';

const MAX_COST = 5000000n, BURN_COST = 2000000n, AIRDROP_BATCH = 4, MIN_PAYOUT = 1000000n, SAMPLE_MS = AGENT_POLICY_V1.rewards.sampleIntervalMinutes * 60000;
// Expected network fees (base fee plus the fixed priority fee) used for the 1%
// rule; the reservation itself is the hard simulation cap above, which also
// covers recoverable token-account rent on a first purchase.
const FEE_ESTIMATE = Object.freeze({ buyback_burn: 60000n, holder_reward_batch: 10000n });
const BURN_ADDRESSES = Object.freeze(['1nc1nerator11111111111111111111111111111111', '11111111111111111111111111111111']);
const validSignature = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(value);
const publicFailure = message => Object.assign(Error(message), { agentPublic: true });
const OPEN = new Set(['reserved', 'signed', 'submitted', 'confirmed_pending_finality', 'reconciliation_required']);

export class AgentExecutor {
  constructor({ service }) { this.service = service; this.sampled = new Map(); this.retry = new Map(); }
  get now() { return this.service.now; }
  // ---- proposals -----------------------------------------------------------------
  /**
   * Called from a run's tool call (origin 'model') or by an objective program (origin 'program', no run).
   * Records the proposal and its deterministic evaluation; never executes here. A model proposal is also
   * subject to the agent's objective limiter (Patience: one per week; Research first: none in week one).
   */
  propose(agent, runId, kind, { amountSol, reason }, { origin = 'model', objective = null } = {}) {
    const service = this.service, store = service.store(), effective = service.effective();
    const requested = BigInt(Math.round(Number(amountSol) * 1e9)), program = origin === 'program', label = `${program ? 'Program ' : ''}${kind === 'buyback_burn' ? (program ? 'buyback' : 'Buyback') : (program ? 'holder reward' : 'Holder reward')}`;
    const data = { kind, origin, ...(objective ? { objective } : {}) };
    const reject = text => { const action = store.createAction({ agentId: agent.id, runId, kind, proposal: { amountSol, reason, origin }, policyHash: agent.policyHash, reason, state: 'rejected', evaluation: { ok: false, reason: text, at: this.now() } }); store.addEvent({ agentId: agent.id, runId, kind: 'action', title: `${label} proposal rejected`, body: text, data: { ...data, actionId: action.id, requestedSol: displayUnits(requested) } }); return { accepted: false, actionId: action.id, reason: text }; };
    const capability = kind === 'buyback_burn' ? 'buyback' : 'rewards';
    if (!hasCapability(agent.capabilities, capability)) return reject(`This agent launched without the ${capability} capability.`);
    if (!effective.financialOpen) return reject('Treasury actions are disabled on this platform right now.');
    if (!program) { const limited = modelProposalLimit({ objective: agent.objective || 'custom', createdAt: agent.createdAt, now: this.now(), lastAcceptedAt: store.lastAcceptedActionAt(agent.id) }); if (limited) return reject(limited); }
    if (store.openActions(agent.id).length) return reject('A treasury action is already in progress. Propose again after it reconciles.');
    const evaluation = this.evaluate(agent, kind, requested); if (!evaluation.ok) return reject(evaluation.reason);
    const action = store.createAction({ agentId: agent.id, runId, kind, proposal: { amountSol, reason, origin }, policyHash: agent.policyHash, reason, state: 'proposed', evaluation: { ...evaluation, principal: evaluation.principal.toString(), reserved: evaluation.reserved.toString(), network: evaluation.network.toString(), maxNetwork: evaluation.maxNetwork.toString(), at: this.now() } });
    store.addEvent({ agentId: agent.id, runId, kind: 'action', title: `${label} proposed: ${displayUnits(evaluation.principal)} SOL`, body: `${reason} (requested ${displayUnits(requested)} SOL${evaluation.bounded ? ', capped by policy' : ''}). Queued for the deterministic executor.`, data: { ...data, actionId: action.id, principal: evaluation.principal.toString() } });
    return { accepted: true, actionId: action.id, requestedSol: displayUnits(requested), approvedSol: displayUnits(evaluation.principal), cappedByPolicy: evaluation.bounded, note: 'Queued: platform code re-checks policy, reserves, builds, simulates, signs and reconciles. The result appears in the activity feed.' };
  }
  /** Worst-case network reservation per action kind (the amount `evaluate` keeps back beside the principal). */
  reserveFor(kind) { return kind === 'buyback_burn' ? MAX_COST + BURN_COST : MAX_COST * BigInt(Math.ceil(AGENT_POLICY_V1.rewards.topHolders / AIRDROP_BATCH)); }
  evaluate(agent, kind, requested) {
    const service = this.service, store = service.store(), price = service.lastSolUsd;
    if (!price || !freshPrice(price, this.now())) return { ok: false, reason: 'A fresh SOL/USD price (≤60 s) is required for treasury actions.' };
    const balances = store.agentBalances(agent.id), available = BigInt(balances.sol.treasuryAvailable), liabilities = BigInt(balances.sol.treasuryReserved) + BigInt(balances.sol.rewardFrozen);
    let baseline = BigInt(agent.treasuryDayBaseline || '0'); const today = dayKey(this.now());
    if (agent.treasuryDayKey !== today) { baseline = available + liabilities - BigInt(AGENT_POLICY_V1.treasury.gasReserveLamports); if (baseline < 0n) baseline = 0n; store.updateAgent(agent.id, { treasuryDayKey: today, treasuryDayBaseline: baseline.toString() }); }
    const caps = treasuryCaps({ baselineLamports: baseline, solUsdMicro: priceMicro(price.usd) }, AGENT_POLICY_V1);
    const { hour, day } = this.spent(agent.id);
    const batches = BigInt(Math.ceil(AGENT_POLICY_V1.rewards.topHolders / AIRDROP_BATCH));
    const estimate = kind === 'buyback_burn' ? FEE_ESTIMATE.buyback_burn : FEE_ESTIMATE.holder_reward_batch * batches, maxReserve = kind === 'buyback_burn' ? MAX_COST + BURN_COST : MAX_COST * batches;
    const result = evaluateTreasuryProposal({ kind, requestedLamports: requested, capabilities: agent.capabilities, caps, available, pendingLiabilities: liabilities, spentHourLamports: hour, spentDayLamports: day, networkCostLamports: estimate }, AGENT_POLICY_V1);
    if (result.ok) { if (result.principal + maxReserve > available - BigInt(AGENT_POLICY_V1.treasury.gasReserveLamports) - liabilities) result.principal = available - BigInt(AGENT_POLICY_V1.treasury.gasReserveLamports) - liabilities - maxReserve; if (result.principal < caps.minimumPrincipal) return { ok: false, reason: 'The treasury cannot cover the action principal plus its network-cost reservation.', caps: { perAction: caps.perAction.toString(), hourly: caps.hourly.toString(), daily: caps.daily.toString(), baseline: baseline.toString() }, solUsd: price.usd }; result.reserved = result.principal + maxReserve; result.network = estimate; result.maxNetwork = maxReserve; }
    return { ...result, caps: { perAction: caps.perAction.toString(), hourly: caps.hourly.toString(), daily: caps.daily.toString(), baseline: baseline.toString() }, solUsd: price.usd };
  }
  spent(agentId) {
    const store = this.service.store(), now = this.now(), start = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    let hour = 0n, day = 0n;
        // Principal plus attributable network cost of every action that is reserved,
    // pending or finalized; buyback spend already includes its principal.
    for (const action of store.actions(agentId, { limit: 200 })) { if (['rejected', 'proposed'].includes(action.state)) continue; const principal = BigInt(action.principalLamports || '0'), spent = BigInt(action.spentLamports || '0'); const amount = action.state === 'failed_proven' ? spent : action.kind === 'holder_reward' ? principal + spent : (spent > principal ? spent : principal); if (action.createdAt >= now - 3600000) hour += amount; if (action.createdAt >= start) day += amount; }
    return { hour, day };
  }
  // ---- tick ------------------------------------------------------------------------
  async tick(chain) {
    const service = this.service, store = service.store();
    try { service.lastSolUsd = await chain.solUsd(); } catch { /* Missing price blocks financial actions below. */ }
    await this.sampleHolders(chain);
    for (const action of store.openActions()) { if (service.closed) return; try { await this.advance(chain, action); } catch (error) { store.updateAction(action.id, { error: safeError(error) }); } }
    if (service.closed) return;
    // Objective programs: daily market evidence for every live agent, then at most one proposal per agent through propose() above.
    try { await runObjectivePrograms(service, chain); store.clearAlert('global', 'programs'); } catch (error) { store.raiseAlert({ scope: 'global', code: 'programs', message: safeError(error) }); }
    const effective = service.effective(); if (!effective.financialOpen) return;
    if (store.openAlerts().some(alert => alert.scope === 'global' && alert.code === 'ledger')) return;
    for (const agent of store.allAgents({ includeArchived: false })) {
      if (service.closed) return;
      if (agent.adminPaused || agent.integrityPaused || agent.launchState !== 'live' || store.openActions(agent.id).length) continue;
      const proposed = store.actions(agent.id, { limit: 5, states: ['proposed'] }).filter(action => action.evaluation?.ok).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!proposed) continue;
      if (this.now() - proposed.createdAt > 30 * 60000) { store.updateAction(proposed.id, { state: 'rejected', error: 'The proposal was not executed within 30 minutes and expired.' }); continue; }
      const retry = this.retry.get(proposed.id); if (retry && retry.nextAt > this.now()) continue;
      try { await this.execute(chain, agent, proposed); } catch (error) { const attempts = (retry?.attempts || 0) + 1; this.retry.set(proposed.id, { attempts, nextAt: this.now() + Math.min(600000, 30000 * 2 ** Math.min(attempts, 4)) }); store.updateAction(proposed.id, { error: safeError(error) }); if (attempts >= 3) store.updateAction(proposed.id, { state: 'rejected', error: 'The action could not be prepared after three attempts: ' + safeError(error) }); }
    }
  }
  async execute(chain, agent, action) {
    const service = this.service, store = service.store();
    const current = this.evaluate(agent, action.kind, BigInt(action.evaluation.principal));
    if (!current.ok) { store.updateAction(action.id, { state: 'rejected', error: current.reason, evaluation: { ...action.evaluation, recheck: { ok: false, reason: current.reason } } }); store.addEvent({ agentId: agent.id, runId: action.runId, kind: 'action', title: 'Action rejected at execution', body: current.reason, data: { actionId: action.id } }); return; }
    const principal = current.principal, reserved = current.reserved, exclusions = await this.exclusions(agent);
    if (action.kind === 'holder_reward') {
      const window = rewardWindow(store.holderSamples(agent.id, { from: this.now() - 2 * 3600000, to: this.now() }), { now: this.now() });
      if (!window.ok) { store.updateAction(action.id, { state: 'rejected', error: 'Rewards deferred: ' + window.reason }); store.addEvent({ agentId: agent.id, runId: action.runId, kind: 'action', title: 'Holder reward deferred', body: window.reason, data: { actionId: action.id } }); return; }
      const holders = topHolders(minimumBalances(window.samples), { limit: AGENT_POLICY_V1.rewards.topHolders, exclude: new Set(exclusions) });
      if (!holders.length) { store.updateAction(action.id, { state: 'rejected', error: 'No eligible holders were observed across the whole window.' }); return; }
      const allocation = allocateRewards(principal, holders), payable = allocation.filter(row => row.lamports >= MIN_PAYOUT), deferred = allocation.filter(row => row.lamports > 0n && row.lamports < MIN_PAYOUT);
      if (!payable.length) { store.updateAction(action.id, { state: 'rejected', error: 'Every individual payout would be below the 0.001 SOL minimum.' }); return; }
      const batches = Math.ceil(payable.length / AIRDROP_BATCH), network = MAX_COST * BigInt(batches);
      store.reserveAction(action.id, { lamports: (principal + network).toString() });
      store.updateAction(action.id, { principalLamports: principal.toString(), intentHash: createHash('sha256').update(JSON.stringify({ kind: 'holder_reward', agent: agent.id, principal: principal.toString(), recipients: allocation.map(row => [row.owner, row.lamports.toString()]), window: [window.from, window.to] })).digest('hex'), quote: { solUsd: current.solUsd, caps: current.caps } });
      const cycle = store.createRewardCycle({ agentId: agent.id, actionId: action.id, policyHash: agent.policyHash, windowFrom: window.from, windowTo: window.to, sampleCount: window.samples.length, totalLamports: principal.toString(), recipients: allocation.filter(row => row.lamports > 0n).map(row => ({ owner: row.owner, lamports: row.lamports.toString(), weight: row.weight })), exclusions, evidence: { slots: window.samples.map(sample => sample.slot), sampleAts: window.samples.map(sample => sample.at), policy: AGENT_POLICY_V1.rewards } });
      if (deferred.length) store.deferDebts(cycle.id, store.debts(cycle.id).filter(debt => deferred.some(row => row.owner === debt.owner)).map(debt => debt.id), 'Below the 0.001 SOL minimum payout; retained as a frozen debt.');
      store.addEvent({ agentId: agent.id, runId: action.runId, kind: 'action', title: `Holder reward frozen: ${displayUnits(principal)} SOL to ${payable.length} holders`, body: `Top ${holders.length} holders by minimum balance over ${window.samples.length} snapshots (${new Date(window.from).toISOString()} → ${new Date(window.to).toISOString()}). ${deferred.length ? deferred.length + ' small shares retained as frozen debts.' : ''}`, data: { actionId: action.id, cycleId: cycle.id, recipients: payable.length, deferred: deferred.length } });
      return this.advance(chain, store.action(action.id));
    }
    store.reserveAction(action.id, { lamports: reserved.toString() });
    store.updateAction(action.id, { principalLamports: principal.toString(), intentHash: createHash('sha256').update(JSON.stringify({ kind: 'buyback_burn', agent: agent.id, mint: agent.mint, principal: principal.toString() })).digest('hex'), quote: { solUsd: current.solUsd, caps: current.caps }, venue: agent.route });
    return this.advance(chain, store.action(action.id));
  }
  async exclusions(agent) {
    const { launches } = await this.service.launchRows(), row = launches.find(item => item.mint === agent.mint);
    return [...new Set([...BURN_ADDRESSES, agent.wallet, ...(agent.creatorWallet ? [agent.creatorWallet] : []), ...(row?.custody || []), ...(row?.creatorWallet ? [row.creatorWallet] : [])])];
  }
  /** Moves an open action forward one step: prepare the next leg, broadcast, or reconcile the pending one. */
  async advance(chain, action) {
    const service = this.service, store = service.store(), agent = store.agent(action.agentId); if (!agent) return;
    const legs = store.legs(action.id), pending = legs.find(leg => ['signed', 'submitted', 'confirmed_pending_finality'].includes(leg.state));
    if (pending) {
      await this.reconcileLeg(chain, action, pending);
      // A finalized leg hands straight to the next one (burn after buy, next reward batch) so settlement never idles a full pass.
      const after = store.action(action.id);
      if (after && after.state === 'confirmed_pending_finality' && !store.legs(action.id).some(leg => ['signed', 'submitted'].includes(leg.state))) return this.advance(chain, after);
      return;
    }
    if (!['reserved', 'confirmed_pending_finality'].includes(action.state)) return;
    const retry = this.retry.get('leg:' + action.id); if (retry && retry.nextAt > this.now()) return;
    const effective = service.effective(); if (!effective.financialOpen || agent.adminPaused || agent.integrityPaused) { store.updateAction(action.id, { error: 'Waiting: new signatures are paused by the platform.' }); return; }
    try {
      if (action.kind === 'buyback_burn') return legs.length === 0 ? await this.buyLeg(chain, agent, action) : await this.burnLeg(chain, agent, action, legs);
      return this.rewardLeg(chain, agent, action, legs);
    } catch (error) { const attempts = (retry?.attempts || 0) + 1; this.retry.set('leg:' + action.id, { attempts, nextAt: this.now() + Math.min(900000, 30000 * 2 ** Math.min(attempts, 5)) }); store.updateAction(action.id, { error: safeError(error) }); if (attempts >= 4 && legs.length === 0) { store.settleActionLamports(action.id, { spentLamports: '0', sourceSuffix: 'abort' }); store.updateAction(action.id, { state: 'failed_proven', error: 'Could not prepare a valid transaction after four attempts: ' + safeError(error), finalizedAt: this.now() }); store.addEvent({ agentId: agent.id, runId: action.runId, kind: 'action', title: 'Action abandoned before signing', body: safeError(error), data: { actionId: action.id } }); } }
  }
  walletFloor(agent, action) { const balances = this.service.store().agentBalances(agent.id), total = Object.values(balances.sol).reduce((sum, value) => sum + BigInt(value), 0n); return total - BigInt(action.reservedLamports); }
  verifyOp(op, agent, expectations) { if (!op || op.wallet !== agent.wallet || !validSignature(op.signature) || typeof op.raw !== 'string' || op.rawHash !== createHash('sha256').update(Buffer.from(op.raw, 'base64')).digest('hex')) throw publicFailure('The prepared transaction could not be verified.'); for (const [key, value] of Object.entries(expectations)) if (op[key] !== value) throw publicFailure(`The prepared transaction changed its ${key}.`); const store = this.service.store(); if (store.db.get('SELECT id FROM action_legs WHERE signature = ?', op.signature)) throw publicFailure('Waiting for a fresh blockhash.'); }
  async journal(chain, agent, action, { kind, op, sequence }) {
    const store = this.service.store();
    const leg = store.createLeg({ actionId: action.id, agentId: agent.id, sequence, kind, operation: { ...op, attempts: 0 }, signature: op.signature, rawHash: op.rawHash, expiresHeight: op.lastValidBlockHeight, preparedSlot: op.preparedSlot, state: 'signed' });
    store.updateAction(action.id, { state: 'signed', error: '' });
    try { await chain.broadcast(op); } catch { /* The saved bytes are retried on reconciliation. */ }
    store.updateLeg(leg.id, { state: 'submitted', attempts: 1, lastBroadcastAt: this.now(), nextCheckAt: this.now() + 10000 });
    store.updateAction(action.id, { state: 'submitted' });
    return leg;
  }
  async buyLeg(chain, agent, action) {
    const signer = await this.service.signer(agent.id), principal = BigInt(action.principalLamports), floor = this.walletFloor(agent, action) + BURN_COST;
    const op = await chain.prepareBuyback({ wallet: signer, mint: agent.mint, lamports: principal.toString(), minSolReserve: (floor > 0n ? floor : 0n).toString(), maxNetworkCostLamports: MAX_COST.toString() });
    this.verifyOp(op, agent, { kind: 'acquire', mint: agent.mint, inputAmount: principal.toString() });
    await this.journal(chain, agent, action, { kind: 'buy', op, sequence: 1 });
    this.service.store().addEvent({ agentId: agent.id, runId: action.runId, kind: 'action', title: `Buyback submitted: ${displayUnits(principal)} SOL`, body: `Expected at least ${displayUnits(op.minimumOutput, op.accounting?.decimals ?? 6)} ${agent.symbol}; burn follows once the purchase finalizes.`, data: { actionId: action.id, signature: op.signature, stage: 'bought-pending' } });
  }
  async burnLeg(chain, agent, action, legs) {
    const store = this.service.store(), buy = legs.find(leg => leg.kind === 'buy' && leg.state === 'finalized'); if (!buy) return;
    const bought = BigInt(buy.receipt?.outputAmount || '0'); if (bought <= 0n) { store.settleActionLamports(action.id, { spentLamports: '0', sourceSuffix: 'noburn' }); store.updateAction(action.id, { state: 'finalized', finalizedAt: this.now(), outcome: { ...(action.outcome || {}), burned: '0', note: 'No tokens were delivered; nothing to burn.' } }); return; }
    const signer = await this.service.signer(agent.id);
    const op = await chain.prepareIncinerate({ wallet: signer, mint: agent.mint, amount: bought.toString(), maxNetworkCostLamports: BURN_COST.toString() });
    this.verifyOp(op, agent, { kind: 'incinerate', mint: agent.mint, inputAmount: bought.toString() });
    await this.journal(chain, agent, action, { kind: 'burn', op, sequence: legs.length + 1 });
    store.addEvent({ agentId: agent.id, runId: action.runId, kind: 'action', title: `Burn submitted: ${displayUnits(bought, op.accounting?.decimals ?? 6)} ${agent.symbol}`, body: 'Exactly the purchased amount is burned.', data: { actionId: action.id, signature: op.signature, stage: 'burn-pending' } });
  }
  async rewardLeg(chain, agent, action, legs) {
    const store = this.service.store(), cycle = store.rewardCycleForAction(action.id); if (!cycle) return;
    const debts = store.debts(cycle.id).filter(debt => debt.state === 'frozen'), batch = debts.slice(0, AIRDROP_BATCH);
    if (!batch.length) {
      store.settleActionLamports(action.id, { spentLamports: '0', sourceSuffix: 'done' });
      store.updateRewardCycle(cycle.id, { state: 'paid', finalizedAt: this.now() });
      store.updateAction(action.id, { state: 'finalized', finalizedAt: this.now(), outcome: { ...(action.outcome || {}), paid: store.debts(cycle.id).filter(debt => debt.state === 'paid').length, deferred: store.debts(cycle.id).filter(debt => debt.state === 'deferred').length } });
      store.addEvent({ agentId: agent.id, runId: action.runId, kind: 'action', title: 'Holder reward complete', body: `${displayUnits(cycle.totalLamports)} SOL distributed to the frozen snapshot; ${store.debts(cycle.id).filter(debt => debt.state === 'deferred').length} small shares retained as debts.`, data: { actionId: action.id, cycleId: cycle.id } });
      return;
    }
    const signer = await this.service.signer(agent.id), floor = this.walletFloor(agent, action);
    const op = await chain.prepareAirdrop({ wallet: signer, mint: AGENT_QUOTE_MINT, payouts: batch.map(debt => ({ owner: debt.owner, lamports: debt.lamports, tokens: '0' })), minSolReserve: (floor > 0n ? floor : 0n).toString(), maxNetworkCostLamports: MAX_COST.toString() });
    this.verifyOp(op, agent, { kind: 'airdrop' });
    if (op.payouts.length !== batch.length || op.payouts.some((row, index) => row.owner !== batch[index].owner || row.lamports !== batch[index].lamports)) throw publicFailure('The prepared reward batch differs from the frozen plan.');
    const leg = await this.journal(chain, agent, action, { kind: 'reward', op: { ...op, debtIds: batch.map(debt => debt.id) }, sequence: legs.length + 1 });
    store.updateLeg(leg.id, { operation: { ...op, debtIds: batch.map(debt => debt.id), attempts: 1, lastBroadcastAt: this.now() } });
  }
  async reconcileLeg(chain, action, leg) {
    const store = this.service.store(), op = leg.operation; if (!op) return;
    if (leg.nextCheckAt > this.now()) return;
    store.updateLeg(leg.id, { nextCheckAt: this.now() + 10000 });
    const receipt = await chain.receipt(op, op.wallet);
    if (receipt) return this.finalizeLeg(action, leg, receipt);
    const status = await chain.state(op);
    if (status?.state === 'expired') {
      const checkpoint = status.checkpoint, previous = leg.expiryCheck;
      if (previous && this.now() - previous.at >= 10000 && Number.isSafeInteger(checkpoint?.slot) && checkpoint.slot > previous.slot && checkpoint.height > op.lastValidBlockHeight) return this.finalizeLeg(action, leg, { state: 'expired', signature: op.signature });
      store.updateLeg(leg.id, { expiryCheck: { at: this.now(), slot: checkpoint?.slot ?? 0, height: checkpoint?.height ?? 0 }, error: 'Checking a second finalized checkpoint before treating the transaction as expired.' });
      return;
    }
    if (status?.state === 'unknown') { store.updateLeg(leg.id, { error: status.reason || 'Outcome unknown; keeping the reservation.' }); if (action.state !== 'reconciliation_required') store.updateAction(action.id, { state: 'reconciliation_required', error: 'The transaction outcome cannot be established yet; funds stay reserved.' }); return; }
    if (status?.state === 'pending' && (op.attempts || 0) < 4 && this.now() - (op.lastBroadcastAt || 0) >= 20000) { const next = { ...op, attempts: (op.attempts || 0) + 1, lastBroadcastAt: this.now() }; store.updateLeg(leg.id, { operation: next, expiryCheck: null }); try { await chain.broadcast(op); } catch { /* Next pass. */ } }
  }
  finalizeLeg(action, leg, receipt) {
    const service = this.service, store = service.store(), agent = store.agent(action.agentId), op = leg.operation, cost = receipt.state === 'expired' ? 0n : BigInt(receipt.actualSolCostLamports || receipt.feeLamports || '0');
    if (receipt.state === 'confirmed') {
      if (leg.kind === 'buy') {
        const bought = BigInt(receipt.outputAmount || '0'), input = BigInt(op.inputAmount);
        if (bought < BigInt(op.minimumOutput || '0')) throw publicFailure('The confirmed purchase delivered less than its minimum output.');
        store.settleActionLamports(action.id, { spentLamports: (input + cost).toString(), retainLamports: BURN_COST.toString(), sourceSuffix: 'buy', tokenAsset: tokenAsset(agent.mint), tokensBought: bought.toString() });
        store.updateLeg(leg.id, { state: 'finalized', receipt, finalizedAt: this.now(), error: '' });
        store.updateAction(action.id, { state: 'confirmed_pending_finality', outcome: { bought: bought.toString(), buySignature: op.signature, buyCost: (input + cost).toString(), burned: '0' }, error: '' });
        store.addEvent({ agentId: agent.id, runId: action.runId, kind: 'action', title: `Bought ${displayUnits(bought, receipt.outputDecimals ?? 6)} ${agent.symbol}`, body: `Spent ${displayUnits(input + cost)} SOL including network cost. Burn pending.`, data: { actionId: action.id, signature: op.signature, stage: 'bought' } });
      } else if (leg.kind === 'burn') {
        const burned = BigInt(op.inputAmount);
        store.settleBurn(action.id, { tokenAsset: tokenAsset(agent.mint), tokens: burned.toString() });
        store.settleActionLamports(action.id, { spentLamports: cost.toString(), sourceSuffix: 'burn-fee-' + leg.sequence });
        store.updateLeg(leg.id, { state: 'finalized', receipt, finalizedAt: this.now(), error: '' });
        store.updateAction(action.id, { state: 'finalized', finalizedAt: this.now(), outcome: { ...(action.outcome || {}), burned: burned.toString(), burnSignature: op.signature, burnCost: cost.toString() }, error: '' });
        store.addEvent({ agentId: agent.id, runId: action.runId, kind: 'action', title: `Burned ${displayUnits(burned, op.accounting?.decimals ?? 6)} ${agent.symbol}`, body: 'Buyback and burn finalized; both receipts are on the Treasury tab.', data: { actionId: action.id, signature: op.signature, stage: 'burned' } });
      } else {
        const cycle = store.rewardCycleForAction(action.id), retain = BigInt(action.reservedLamports) - cost;
        store.settleDebts(cycle.id, { debtIds: op.debtIds, signature: op.signature, legKey: 'leg' + leg.sequence });
        store.settleActionLamports(action.id, { spentLamports: cost.toString(), retainLamports: (retain > 0n ? retain : 0n).toString(), sourceSuffix: 'leg' + leg.sequence });
        store.updateLeg(leg.id, { state: 'finalized', receipt, finalizedAt: this.now(), error: '' });
        store.updateRewardCycle(cycle.id, { paidIndex: store.debts(cycle.id).filter(debt => debt.state === 'paid').length });
        store.updateAction(action.id, { state: 'confirmed_pending_finality', outcome: { ...(action.outcome || {}), paidSignatures: [...(action.outcome?.paidSignatures || []), op.signature] }, error: '' });
        store.addEvent({ agentId: agent.id, runId: action.runId, kind: 'action', title: `Rewards paid to ${op.payouts.length} holders`, body: `${displayUnits(op.inputAmount)} SOL in this batch.`, data: { actionId: action.id, signature: op.signature, stage: 'reward-batch' } });
      }
      this.retry.delete('leg:' + action.id);
      return;
    }
    // failed (fee only) or proven expired (nothing spent): never buy again because a burn failed; retry the burn instead.
    const fee = receipt.state === 'failed' ? cost : 0n;
    store.updateLeg(leg.id, { state: receipt.state === 'failed' ? 'failed_proven' : 'expired', receipt, finalizedAt: this.now(), error: receipt.state === 'failed' ? 'The transaction failed onchain.' : 'The transaction expired without executing.' });
    if (leg.kind === 'buy') { store.settleActionLamports(action.id, { spentLamports: fee.toString(), sourceSuffix: 'buy-' + receipt.state }); store.updateAction(action.id, { state: 'failed_proven', finalizedAt: this.now(), error: receipt.state === 'failed' ? 'The buyback transaction failed onchain; only the network fee was spent.' : 'The buyback transaction expired without executing; nothing was spent.' }); store.addEvent({ agentId: agent.id, runId: action.runId, kind: 'action', title: 'Buyback did not execute', body: receipt.state === 'failed' ? `Failed onchain (network fee ${displayUnits(fee)} SOL).` : 'Expired before confirmation; nothing was spent.', data: { actionId: action.id, signature: op.signature, stage: 'failed' } }); }
    else if (leg.kind === 'burn') { store.settleActionLamports(action.id, { spentLamports: fee.toString(), retainLamports: (BigInt(action.reservedLamports) - fee > 0n ? BigInt(action.reservedLamports) - fee : 0n).toString(), sourceSuffix: 'burn-' + receipt.state + '-' + leg.sequence }); store.updateAction(action.id, { state: 'confirmed_pending_finality', error: 'The burn did not execute; a fresh burn of the same purchased amount will be prepared.' }); this.retry.set('leg:' + action.id, { attempts: 1, nextAt: this.now() + 60000 }); }
    else { const cycle = store.rewardCycleForAction(action.id); store.settleActionLamports(action.id, { spentLamports: fee.toString(), retainLamports: (BigInt(action.reservedLamports) - fee > 0n ? BigInt(action.reservedLamports) - fee : 0n).toString(), sourceSuffix: 'reward-' + receipt.state + '-' + leg.sequence }); store.updateAction(action.id, { state: 'confirmed_pending_finality', error: 'A reward batch did not execute; the same frozen batch will be prepared again.' }); if (cycle) store.updateRewardCycle(cycle.id, { state: 'frozen' }); this.retry.set('leg:' + action.id, { attempts: 1, nextAt: this.now() + 60000 }); }
  }
  // ---- holder sampling ---------------------------------------------------------------
  async sampleHolders(chain) {
    const service = this.service, store = service.store(); let sampled = 0;
    for (const agent of store.allAgents({ includeArchived: false })) {
      if (sampled >= 3 || service.closed) break;
      if (!agent.mint || agent.launchState !== 'live' || !hasCapability(agent.capabilities, 'rewards')) continue;
      const last = this.sampled.get(agent.id) || store.latestHolderSample(agent.id)?.at || 0; if (this.now() - last < SAMPLE_MS) continue;
      sampled++; this.sampled.set(agent.id, this.now());
      try {
        const summary = await chain.mintSummary(agent.mint), exclude = await this.exclusions(agent), snapshot = await chain.holderSnapshot({ mint: agent.mint, program: summary.program, exclude });
        const complete = snapshot.complete === true && snapshot.rows.length <= 50000;
        store.addHolderSample({ agentId: agent.id, at: snapshot.at, slot: snapshot.slot, complete, program: summary.program, decimals: summary.decimals, rows: complete ? snapshot.rows : [] });
        store.pruneHolderSamples(agent.id, this.now() - 3 * 3600000);
      } catch (error) { store.updateAgent(agent.id, { stateReason: agent.stateReason }); store.raiseAlert({ scope: 'agent:' + agent.id, code: 'holder-scan', message: safeError(error) }); }
    }
  }
}
export { lamportsToUsd, formatUsdMicro };
