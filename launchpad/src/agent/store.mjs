// AI Agent mode: typed access to the agent database. Rows come back in
// camelCase with JSON columns parsed; amounts stay decimal strings (callers use
// BigInt). Money moves only through AgentLedger postings, which several of
// these methods wrap in the same SQLite transaction as their row changes.
import { randomBytes } from 'node:crypto';
import { AgentLedger, ASSET, EXTERNAL, PLATFORM, agentOwner, nonNegative, positive, splitBps } from './ledger.mjs';
import { AGENT_STATES, RUN_STATES, ACTION_STATES, AGENT_LIMITS, validObjective } from '../../public/agent-catalog.mjs';
import { INFLUENCER_STATES, POST_STATES } from '../../public/influencer-catalog.mjs';

const fail = (message, statusCode = 400, code = 'AGENT_STORE') => { throw Object.assign(Error(message), { statusCode, code }); };
const camel = key => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
// v71.30: influencers.spec and media_jobs.request are JSON too; spec always reads as an object.
const JSON_COLUMNS = new Set(['domains', 'changes', 'document', 'rate_card', 'apportionment', 'operation', 'quote', 'receipt', 'evidence', 'proposal', 'evaluation', 'outcome', 'recipients', 'exclusions', 'rows', 'data', 'payload', 'detail', 'provider_requests', 'expiry_check', 'objective_settings', 'program_state', 'spec', 'request']);
// Objective settings, program state and influencer specs are always objects for their readers, even from a damaged row.
const OBJECT_COLUMNS = new Set(['objective_settings', 'program_state', 'spec']);
export const MEDIA_JOB_KINDS = Object.freeze(['master', 'sheet', 'image', 'video', 'check']);
export const MEDIA_JOB_STATES = Object.freeze(['queued', 'submitted', 'downloaded', 'checking', 'succeeded', 'failed', 'expired']);
export const MEDIA_JOB_OPEN_STATES = Object.freeze(['queued', 'submitted', 'downloaded', 'checking']);
export const POST_OPEN_STATES = Object.freeze(['queued', 'generating', 'checking', 'uploading']);
const X_POST_KINDS = Object.freeze(['text', 'image', 'video']);
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const row = value => { if (!value) return null; const out = {}; for (const [key, item] of Object.entries(value)) { if (JSON_COLUMNS.has(key) && typeof item === 'string') { let parsed = null; try { parsed = JSON.parse(item); } catch { parsed = null; } out[camel(key)] = OBJECT_COLUMNS.has(key) && !plainObject(parsed) ? {} : parsed; } else out[camel(key)] = item; } return out; };
const rows = list => list.map(row);
const json = value => JSON.stringify(value ?? null);
const text = (value, max, label) => { if (typeof value !== 'string' || value.length > max) fail(`${label} must be a string of at most ${max} characters.`); return value; };
const base58 = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
export const newId = () => randomBytes(12).toString('hex');
const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const ensureId = value => { if (!validId(value)) fail('Invalid agent record id.', 404); return value; };

export class AgentStore {
  constructor(db, { now = Date.now } = {}) { this.db = db; this.now = now; this.ledger = new AgentLedger(db, { now }); }
  transaction(fn) { return this.db.transaction(fn); }
  // ---- policies -------------------------------------------------------------
  savePolicy({ hash, version, document, rateCard }) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) fail('Invalid policy hash.');
    if (!this.db.get('SELECT hash FROM agent_policies WHERE hash = ?', hash)) this.db.run('INSERT INTO agent_policies(hash, version, document, rate_card, created_at) VALUES (?, ?, ?, ?, ?)', hash, version, json(document), json(rateCard), this.now());
    return hash;
  }
  policy(hash) { return row(this.db.get('SELECT * FROM agent_policies WHERE hash = ?', hash)); }
  // ---- agents ---------------------------------------------------------------
  createAgent(input) {
    const id = input.id || newId(); ensureId(id);
    if ((input.mint !== undefined && input.mint !== null && !base58(input.mint)) || !base58(input.wallet)) fail('Invalid agent mint or wallet.');
    if (!['raydium', 'meteora', 'pump'].includes(input.route)) fail('Unsupported agent route.');
    if (!AGENT_STATES.includes(input.state || 'provisioning')) fail('Invalid agent state.');
    if (!this.policy(input.policyHash)) fail('Unknown agent policy hash.');
    // Objective (v71.27): one catalogue id, 'custom' when absent; settings are the creator's validated numbers.
    const objective = input.objective === undefined || input.objective === null || input.objective === '' ? 'custom' : input.objective;
    if (!validObjective(objective)) fail('Unknown agent objective.');
    if (input.objectiveSettings !== undefined && input.objectiveSettings !== null && !plainObject(input.objectiveSettings)) fail('Objective settings must be an object.');
    const at = this.now();
    this.db.run(`INSERT INTO agents(id, chain, mint, route, launch_id, account_id, draft_key, wallet, name, symbol, image, policy_hash, policy_version, capabilities, model, state, state_reason, revision, mission, personality, personality_preset, domains, creator_wallet, launch_state, objective, objective_settings, program_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.chain || 'solana', input.mint ?? null, input.route, input.launchId === undefined || input.launchId === null ? null : text(input.launchId, 80, 'Launch id'), text(input.accountId, 80, 'Account id'), input.draftKey || null, input.wallet, text(input.name, 100, 'Name'), text(input.symbol, 24, 'Symbol'), input.image || null, input.policyHash, text(input.policyVersion, 40, 'Policy version'), Number(input.capabilities) | 0, text(input.model, 120, 'Model'), input.state || 'provisioning', String(input.stateReason || '').slice(0, 300),
      text(input.mission, AGENT_LIMITS.missionChars, 'Mission'), text(input.personality || '', AGENT_LIMITS.personalityChars, 'Personality'), text(input.personalityPreset || 'analyst', 20, 'Preset'), json(Array.isArray(input.domains) ? input.domains.slice(0, AGENT_LIMITS.domains) : []), input.creatorWallet || '', input.launchState || 'pending', objective, json(input.objectiveSettings || {}), json(plainObject(input.programState) ? input.programState : {}), at, at);
    return this.agent(id);
  }
  agent(id) { if (!validId(id)) return null; return row(this.db.get('SELECT * FROM agents WHERE id = ?', id)); }
  agentByMint(mint) { if (!base58(mint)) return null; return row(this.db.get('SELECT * FROM agents WHERE mint = ?', mint)); }
  agentByWallet(wallet) { if (!base58(wallet)) return null; return row(this.db.get('SELECT * FROM agents WHERE wallet = ?', wallet)); }
  agentByLaunch(route, launchId) { return row(this.db.get('SELECT * FROM agents WHERE route = ? AND launch_id = ?', route, String(launchId))); }
  agentByDraft(draftKey) { return row(this.db.get('SELECT * FROM agents WHERE draft_key = ?', draftKey)); }
  /** Binds a provisioned draft to its created launch; the mint and launch id are written once. */
  bindAgent(id, { mint, launchId, name, symbol, image, creatorWallet }) {
    return this.transaction(() => {
      const agent = this.requireAgent(id); if (agent.mint && agent.mint !== mint) fail('This agent is already bound to another coin.', 409);
      if (!base58(mint)) fail('Invalid agent mint.');
      this.db.run('UPDATE agents SET mint = ?, launch_id = ?, name = ?, symbol = ?, image = ?, creator_wallet = ?, draft_key = NULL, updated_at = ? WHERE id = ?', mint, String(launchId), text(name || agent.name, 100, 'Name'), text(symbol || agent.symbol, 24, 'Symbol'), image || agent.image || null, creatorWallet || agent.creatorWallet || '', this.now(), id);
      return this.agent(id);
    });
  }
  unboundDrafts(before) { return rows(this.db.all('SELECT * FROM agents WHERE mint IS NULL AND created_at < ? AND archived = 0', before)); }
  requireAgent(id) { const agent = this.agent(id); if (!agent) fail('Agent not found.', 404); return agent; }
  listAgents({ cursor = null, limit = 24, accountId = null, states = null, includeHidden = false, includeArchived = false } = {}) {
    const clauses = [], params = [];
    if (cursor) { clauses.push('created_at < ?'); params.push(Number(cursor)); }
    if (accountId) { clauses.push('account_id = ?'); params.push(accountId); }
    if (!includeHidden) clauses.push('hidden = 0');
    if (!includeArchived) clauses.push('archived = 0');
    clauses.push('mint IS NOT NULL');
    if (Array.isArray(states) && states.length) { clauses.push(`state IN (${states.map(() => '?').join(',')})`); params.push(...states); }
    const size = Math.min(100, Math.max(1, limit | 0));
    const list = rows(this.db.all(`SELECT * FROM agents ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, size + 1));
    const page = list.slice(0, size);
    return { agents: page, nextCursor: list.length > size ? String(page.at(-1).createdAt) : null };
  }
  allAgents({ includeArchived = true } = {}) { return rows(this.db.all(`SELECT * FROM agents ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY created_at ASC`)); }
  countAgents() { return this.db.get('SELECT COUNT(*) AS n FROM agents').n; }
  updateAgent(id, patch) {
    ensureId(id);
    const allowed = ['state', 'state_reason', 'launch_state', 'launch_signature', 'authority_checked_at', 'archived', 'hidden', 'hidden_reason', 'hidden_at', 'hidden_by', 'creator_paused', 'admin_paused', 'admin_pause_reason', 'integrity_paused', 'integrity_reason', 'day_key', 'day_budget_usd', 'day_spent_usd', 'treasury_day_key', 'treasury_day_baseline', 'last_run_started_at', 'next_run_at', 'cadence_minutes', 'activated_at', 'mission', 'personality', 'personality_preset', 'domains', 'model', 'image', 'name', 'symbol', 'revision', 'objective', 'objective_settings', 'program_state'];
    const sets = [], params = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
      if (!allowed.includes(column)) fail(`Agent field ${key} cannot be updated.`);
      if (column === 'state' && !AGENT_STATES.includes(value)) fail('Invalid agent state.');
      if (column === 'objective' && !validObjective(value)) fail('Unknown agent objective.');
      if (OBJECT_COLUMNS.has(column) && !plainObject(value)) fail(`Agent field ${key} must be an object.`);
      sets.push(`${column} = ?`); params.push(column === 'domains' || OBJECT_COLUMNS.has(column) ? json(value) : typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    if (!sets.length) return this.agent(id);
    sets.push('updated_at = ?'); params.push(this.now(), id);
    this.db.run(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.agent(id);
  }
  addRevision(agentId, { actor, kind, changes }) {
    const agent = this.requireAgent(agentId), revision = agent.revision + 1, at = this.now();
    this.db.run('INSERT INTO agent_revisions(agent_id, revision, actor, kind, changes, created_at) VALUES (?, ?, ?, ?, ?, ?)', agentId, revision, String(actor).slice(0, 80), String(kind).slice(0, 40), json(changes), at);
    this.db.run('UPDATE agents SET revision = ?, updated_at = ? WHERE id = ?', revision, at, agentId);
    return revision;
  }
  revisions(agentId, limit = 20) { return rows(this.db.all('SELECT * FROM agent_revisions WHERE agent_id = ? ORDER BY revision DESC LIMIT ?', agentId, limit)); }
  // ---- fee receipts -----------------------------------------------------------
  hasFeeReceipt({ chain = 'solana', signature, allocation }) { return !!this.db.get('SELECT id FROM fee_receipts WHERE chain = ? AND signature = ? AND allocation = ?', chain, signature, allocation); }
  /** Records a finalized fee receipt and posts the 30/70 split atomically. Idempotent per chain+signature+allocation. */
  /**
   * One finalized fee receipt. With a platform share (policy v2 on gross
   * Raydium/Meteora receipts) that share is set aside in protocol_payable first;
   * the 30/70 split applies to the remainder. Net receipts pass platformShareBps 0.
   */
  recordFeeReceipt({ agentId, chain = 'solana', signature, allocation, venue, launchMint, sourceWallet, mint, amount, slot, sourceAt = null, operationsBps = 3000, platformShareBps = 0 }) {
    const agent = this.requireAgent(agentId), total = positive(amount, 'Receipt amount');
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(signature)) fail('Invalid receipt signature.');
    if (typeof allocation !== 'string' || allocation.length < 1 || allocation.length > 120) fail('Invalid receipt allocation identity.');
    if (mint !== 'So11111111111111111111111111111111111111112') fail('Agent fee receipts must be SOL.');
    if (!Number.isInteger(platformShareBps) || platformShareBps < 0 || platformShareBps >= 10000) fail('Invalid platform share.');
    const platform = total * BigInt(platformShareBps) / 10000n, { first: operations, second: treasury } = splitBps(total - platform, operationsBps);
    return this.transaction(() => {
      if (this.hasFeeReceipt({ chain, signature, allocation })) return { duplicate: true };
      const owner = agentOwner(agent.id), entries = [{ owner: EXTERNAL.chain, asset: ASSET.SOL, bucket: 'main', delta: -total }];
      if (platform > 0n) entries.push({ owner, asset: ASSET.SOL, bucket: 'protocol_payable', delta: platform });
      if (operations > 0n) entries.push({ owner, asset: ASSET.SOL, bucket: 'operating_unsettled', delta: operations });
      if (treasury > 0n) entries.push({ owner, asset: ASSET.SOL, bucket: 'treasury_available', delta: treasury });
      const transactionId = this.ledger.post({ kind: 'fee-receipt', sourceKey: `fee:${chain}:${signature}:${allocation}`, agentId: agent.id, reference: signature, memo: `${venue} fee payout to agent ${agent.symbol}`, entries });
      this.db.run('INSERT INTO fee_receipts(agent_id, chain, signature, allocation, venue, launch_mint, source_wallet, mint, amount, operations, treasury, slot, source_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', agent.id, chain, signature, allocation, String(venue).slice(0, 20), launchMint, sourceWallet, mint, total.toString(), operations.toString(), treasury.toString(), slot, sourceAt, this.now());
      return { duplicate: false, transactionId, operations, treasury, platform };
    });
  }
  feeReceipts(agentId, { limit = 50, before = null } = {}) { return rows(before ? this.db.all('SELECT * FROM fee_receipts WHERE agent_id = ? AND id < ? ORDER BY id DESC LIMIT ?', agentId, before, limit) : this.db.all('SELECT * FROM fee_receipts WHERE agent_id = ? ORDER BY id DESC LIMIT ?', agentId, limit)); }
  feeTotals(agentId) { const out = this.db.get('SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS total, COALESCE(SUM(CAST(operations AS INTEGER)), 0) AS operations, COALESCE(SUM(CAST(treasury AS INTEGER)), 0) AS treasury, MAX(created_at) AS last FROM fee_receipts WHERE agent_id = ?', agentId); return { count: out.n, total: String(out.total), operations: String(out.operations), treasury: String(out.treasury), platform: String(BigInt(out.total) - BigInt(out.operations) - BigInt(out.treasury)), lastAt: out.last || null }; }
  // ---- funding intents --------------------------------------------------------
  createIntent({ agentId, accountId, purpose, sender, recipient, mint, amount, memo, messageHash, unsignedRaw, blockhash, lastValidBlockHeight, preparedSlot, expiresAt }) {
    const agent = this.requireAgent(agentId); if (!['activity', 'treasury'].includes(purpose)) fail('Choose activity or treasury funding.');
    if (!base58(sender) || recipient !== agent.wallet) fail('Invalid funding wallets.');
    const id = newId(), at = this.now();
    this.db.run('INSERT INTO funding_intents(id, agent_id, account_id, purpose, sender, recipient, mint, amount, memo, state, message_hash, unsigned_raw, blockhash, last_valid_block_height, prepared_slot, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, agent.id, accountId, purpose, sender, recipient, mint, positive(amount, 'Funding amount').toString(), text(memo, 80, 'Memo'), 'awaiting_signature', messageHash, unsignedRaw, blockhash, lastValidBlockHeight, preparedSlot, expiresAt, at, at);
    return this.intent(id);
  }
  // Request input reaches this lookup: anything that is not a record id is simply not found.
  intent(id) { return validId(id) ? row(this.db.get('SELECT * FROM funding_intents WHERE id = ?', id)) : null; }
  intentByMemo(memo) { return row(this.db.get('SELECT * FROM funding_intents WHERE memo = ?', memo)); }
  updateIntent(id, patch) {
    const allowed = ['state', 'signature', 'receipt', 'error', 'finalized_at', 'unsigned_raw', 'operation', 'expiry_check'], sets = [], params = [];
    for (const [key, value] of Object.entries(patch)) { const column = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()); if (!allowed.includes(column)) fail(`Intent field ${key} cannot be updated.`); sets.push(`${column} = ?`); params.push(['receipt', 'operation', 'expiry_check'].includes(column) ? (value === null ? null : json(value)) : value); }
    sets.push('updated_at = ?'); params.push(this.now(), id);
    this.db.run(`UPDATE funding_intents SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.intent(id);
  }
  intents(agentId, { limit = 30, accountId = null } = {}) { return rows(accountId ? this.db.all('SELECT * FROM funding_intents WHERE agent_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT ?', agentId, accountId, limit) : this.db.all('SELECT * FROM funding_intents WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?', agentId, limit)); }
  pendingIntents(limit = 50) { return rows(this.db.all("SELECT * FROM funding_intents WHERE state IN ('submitted', 'confirmed') ORDER BY updated_at ASC LIMIT ?", limit)); }
  /** Credits a finalized deposit once; the intent id is the dedup identity. */
  creditIntent(id, { signature, slot, receivedAmount }) {
    return this.transaction(() => {
      const intent = this.intent(id); if (!intent) fail('Funding intent not found.', 404);
      if (intent.state === 'finalized') return { duplicate: true };
      const amount = positive(receivedAmount, 'Received amount'); if (amount !== BigInt(intent.amount)) fail('The finalized deposit differs from its intent.', 409, 'AGENT_INTENT_MISMATCH');
      const owner = agentOwner(intent.agentId), bucket = intent.purpose === 'activity' ? 'operating_unsettled' : 'treasury_available';
      const transactionId = this.ledger.post({ kind: 'deposit', sourceKey: `deposit:solana:${signature}:${intent.memo}`, agentId: intent.agentId, reference: signature, memo: `${intent.purpose} funding`, entries: [{ owner: EXTERNAL.chain, asset: ASSET.SOL, bucket: 'main', delta: -amount }, { owner, asset: ASSET.SOL, bucket, delta: amount }] });
      this.updateIntent(id, { state: 'finalized', signature, finalizedAt: this.now(), receipt: { signature, slot, receivedAmount: amount.toString() }, unsignedRaw: null });
      return { duplicate: false, transactionId };
    });
  }
  // ---- settlement batches ------------------------------------------------------
  /** Reserves one agent's operating SOL (amount plus worst-case network cost) for a SOL->USDC settlement in its own wallet. */
  createSettlementBatch({ agentId, lamports, maxNetworkCost }) {
    const agent = this.requireAgent(agentId), id = newId(), at = this.now(), amount = positive(lamports, 'Batch input'), cost = nonNegative(maxNetworkCost, 'Network reserve'), total = amount + cost;
    return this.transaction(() => {
      if (this.openSettlementBatch(agent.id)) fail('This agent already has an open settlement batch.', 409, 'AGENT_BATCH_OPEN');
      const owner = agentOwner(agent.id);
      this.ledger.post({ kind: 'settlement-reserve', sourceKey: `settle:${id}:reserve`, agentId: agent.id, reference: id, entries: [{ owner, asset: ASSET.SOL, bucket: 'operating_unsettled', delta: -total }, { owner, asset: ASSET.SOL, bucket: 'operating_settling', delta: total }] });
      this.db.run('INSERT INTO settlement_batches(id, state, input_lamports, network_cost, apportionment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, 'reserved', amount.toString(), cost.toString(), json([{ agentId: agent.id, lamports: amount.toString(), reservedCost: cost.toString() }]), at, at);
      return this.settlementBatch(id);
    });
  }
  settlementBatch(id) { return row(this.db.get('SELECT * FROM settlement_batches WHERE id = ?', id)); }
  updateSettlementBatch(id, patch) {
    const allowed = ['state', 'output_usdc', 'network_cost', 'operation', 'signature', 'quote', 'error', 'attempts', 'next_attempt_at', 'finalized_at'], sets = [], params = [];
    for (const [key, value] of Object.entries(patch)) { const column = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()); if (!allowed.includes(column)) fail(`Batch field ${key} cannot be updated.`); sets.push(`${column} = ?`); params.push(['operation', 'quote'].includes(column) ? (value === null ? null : json(value)) : value); }
    sets.push('updated_at = ?'); params.push(this.now(), id);
    this.db.run(`UPDATE settlement_batches SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.settlementBatch(id);
  }
  openSettlementBatch(agentId = null) { const list = rows(this.db.all("SELECT * FROM settlement_batches WHERE state NOT IN ('finalized', 'failed', 'cancelled') ORDER BY created_at ASC")); return agentId ? list.find(batch => batch.apportionment[0]?.agentId === agentId) || null : list[0] || null; }
  openSettlementBatches() { return rows(this.db.all("SELECT * FROM settlement_batches WHERE state NOT IN ('finalized', 'failed', 'cancelled') ORDER BY created_at ASC")); }
  settlementBatches({ limit = 20, agentId = null } = {}) { const list = rows(this.db.all('SELECT * FROM settlement_batches ORDER BY created_at DESC LIMIT ?', agentId ? 500 : limit)); return agentId ? list.filter(batch => batch.apportionment[0]?.agentId === agentId).slice(0, limit) : list; }
  /** Finalizes a batch: the swapped SOL and its actual network cost leave the settling bucket, unused cost reserve returns, USDC arrives. */
  finalizeSettlementBatch(id, { outputUsdc, networkCost = '0', signature }) {
    return this.transaction(() => {
      const batch = this.settlementBatch(id); if (!batch) fail('Settlement batch not found.', 404);
      if (batch.state === 'finalized') return { duplicate: true };
      const item = batch.apportionment[0], owner = agentOwner(item.agentId), amount = BigInt(item.lamports), reservedCost = BigInt(item.reservedCost || '0');
      const output = nonNegative(outputUsdc, 'Settlement output'), cost = nonNegative(networkCost, 'Network cost');
      if (cost > reservedCost) fail('Settlement network cost exceeds its reservation.', 409, 'AGENT_ACTION_OVERSPEND');
      const entries = [{ owner, asset: ASSET.SOL, bucket: 'operating_settling', delta: -(amount + reservedCost) }, { owner: EXTERNAL.swap, asset: ASSET.SOL, bucket: 'main', delta: amount + cost }];
      if (reservedCost - cost > 0n) entries.push({ owner, asset: ASSET.SOL, bucket: 'operating_unsettled', delta: reservedCost - cost });
      if (output > 0n) entries.push({ owner: EXTERNAL.swap, asset: ASSET.USDC, bucket: 'main', delta: -output }, { owner, asset: ASSET.USDC, bucket: 'operating_settled', delta: output });
      this.ledger.post({ kind: 'settlement', sourceKey: `settle:${id}:final`, agentId: item.agentId, reference: signature || id, memo: 'Operating SOL settled to USDC', entries });
      this.updateSettlementBatch(id, { state: 'finalized', outputUsdc: output.toString(), networkCost: cost.toString(), signature: signature || null, finalizedAt: this.now(), error: '', operation: null });
      return { duplicate: false };
    });
  }
  /** A failed (fee-only) or released batch: SOL returns to the unsettled bucket minus any proven network fee. */
  releaseSettlementBatch(id, { reason, feeLamports = '0', failed = false }) {
    return this.transaction(() => {
      const batch = this.settlementBatch(id); if (!batch) fail('Settlement batch not found.', 404);
      if (['finalized', 'failed', 'cancelled'].includes(batch.state)) return;
      const item = batch.apportionment[0], owner = agentOwner(item.agentId), total = BigInt(item.lamports) + BigInt(item.reservedCost || '0'), fee = nonNegative(feeLamports, 'Fee');
      if (fee > total) fail('A failed settlement cannot cost more than its reservation.', 409);
      const entries = [{ owner, asset: ASSET.SOL, bucket: 'operating_settling', delta: -total }];
      if (fee > 0n) entries.push({ owner: EXTERNAL.chain, asset: ASSET.SOL, bucket: 'main', delta: fee });
      if (total - fee > 0n) entries.push({ owner, asset: ASSET.SOL, bucket: 'operating_unsettled', delta: total - fee });
      this.ledger.post({ kind: 'settlement-release', sourceKey: `settle:${id}:release`, agentId: item.agentId, reference: id, memo: reason, entries });
      this.updateSettlementBatch(id, { state: failed ? 'failed' : 'cancelled', error: String(reason).slice(0, 300), operation: null });
    });
  }
  // ---- provider funding batches ------------------------------------------------
  /** Owner-recorded provider credit purchase with evidence; capacity becomes allocatable USD. */
  createProviderBatch({ provider, reference, evidence, paidUsdc, purchaseFeeUsdc, creditsUsd, actor }) {
    const id = newId(), paid = positive(paidUsdc, 'Paid USDC'), fee = nonNegative(purchaseFeeUsdc, 'Purchase fee'), credits = positive(creditsUsd, 'Provider credits');
    if (fee >= paid) fail('The purchase fee cannot exceed the amount paid.');
    return this.transaction(() => {
      if (this.db.get('SELECT id FROM provider_batches WHERE reference = ?', reference)) fail('This provider funding reference was already recorded.', 409, 'AGENT_DUPLICATE_BATCH');
      this.ledger.post({ kind: 'provider-batch', sourceKey: `provider:${provider}:${reference}`, reference, memo: 'Provider credits recorded', entries: [{ owner: EXTERNAL.provider, asset: ASSET.USD, bucket: 'main', delta: -credits }, { owner: PLATFORM, asset: ASSET.USD, bucket: 'provider_capacity', delta: credits }] });
      this.db.run('INSERT INTO provider_batches(id, provider, reference, evidence, paid_usdc, purchase_fee_usdc, credits_usd, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, provider, text(reference, 120, 'Reference'), text(evidence, 500, 'Evidence'), paid.toString(), fee.toString(), credits.toString(), actor, this.now());
      return this.providerBatch(id);
    });
  }
  providerBatch(id) { return row(this.db.get('SELECT * FROM provider_batches WHERE id = ?', id)); }
  providerBatches({ limit = 20 } = {}) { return rows(this.db.all('SELECT * FROM provider_batches ORDER BY created_at DESC LIMIT ?', limit)); }
  /** Backs an agent's settled USDC with purchase capacity at the batch's recorded rate: USDC moves to the operator receivable, USD credits to the agent. */
  allocateBacking({ batchId, agentId, usdc, usd }) {
    return this.transaction(() => {
      const batch = this.providerBatch(batchId); if (!batch) fail('Provider batch not found.', 404);
      const agent = this.requireAgent(agentId), owner = agentOwner(agent.id), usdcAmount = positive(usdc, 'USDC'), usdAmount = positive(usd, 'USD');
      const remainingUsdc = BigInt(batch.paidUsdc) - BigInt(batch.allocatedUsdc), remainingUsd = BigInt(batch.creditsUsd) - BigInt(batch.allocatedUsd);
      if (usdcAmount > remainingUsdc || usdAmount > remainingUsd) fail('The provider batch cannot back this allocation.', 409, 'AGENT_BACKING_EXHAUSTED');
      const transactionId = this.ledger.post({ kind: 'backing', sourceKey: `backing:${batchId}:${agentId}:${this.db.get('SELECT COUNT(*) AS n FROM provider_allocations WHERE batch_id = ? AND agent_id = ?', batchId, agentId).n}`, agentId, reference: batch.reference, memo: 'Operating credit backed by provider funding', entries: [
        { owner, asset: ASSET.USDC, bucket: 'operating_settled', delta: -usdcAmount }, { owner: PLATFORM, asset: ASSET.USDC, bucket: 'operator_receivable', delta: usdcAmount },
        { owner: PLATFORM, asset: ASSET.USD, bucket: 'provider_capacity', delta: -usdAmount }, { owner, asset: ASSET.USD, bucket: 'operating_backed', delta: usdAmount }] });
      this.db.run('INSERT INTO provider_allocations(batch_id, agent_id, usdc, usd, transaction_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', batchId, agentId, usdcAmount.toString(), usdAmount.toString(), transactionId, this.now());
      this.db.run('UPDATE provider_batches SET allocated_usdc = ?, allocated_usd = ? WHERE id = ?', (BigInt(batch.allocatedUsdc) + usdcAmount).toString(), (BigInt(batch.allocatedUsd) + usdAmount).toString(), batchId);
      return transactionId;
    });
  }
  allocations(agentId, limit = 30) { return rows(this.db.all('SELECT * FROM provider_allocations WHERE agent_id = ? ORDER BY id DESC LIMIT ?', agentId, limit)); }
  createReimbursement({ agentId, usdc, destination, actor }) { const id = newId(), at = this.now(); this.requireAgent(agentId); this.db.run('INSERT INTO reimbursements(id, agent_id, usdc, destination, state, actor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, agentId, positive(usdc, 'USDC').toString(), destination, 'requested', actor, at, at); return this.reimbursement(id); }
  reimbursement(id) { return row(this.db.get('SELECT * FROM reimbursements WHERE id = ?', id)); }
  reimbursements(limit = 20) { return rows(this.db.all('SELECT * FROM reimbursements ORDER BY created_at DESC LIMIT ?', limit)); }
  // ---- platform-share remittances (policy v2) -----------------------------------------
  /** Reserves the set-aside platform share for one remittance (protocol_payable → protocol_remitting). */
  createRemit({ agentId, amount, destination }) {
    const agent = this.requireAgent(agentId), value = positive(amount, 'Remittance'), id = newId(), at = this.now(); if (!base58(destination)) fail('Invalid remittance destination.');
    return this.transaction(() => {
      if (this.db.get("SELECT id FROM platform_remits WHERE agent_id = ? AND state IN ('reserved', 'signed', 'submitted')", agent.id)) fail('A platform-share remittance is already open.', 409);
      const owner = agentOwner(agent.id);
      this.ledger.post({ kind: 'platform-remit-reserve', sourceKey: `remit:${id}:reserve`, agentId: agent.id, reference: id, entries: [{ owner, asset: ASSET.SOL, bucket: 'protocol_payable', delta: -value }, { owner, asset: ASSET.SOL, bucket: 'protocol_remitting', delta: value }] });
      this.db.run('INSERT INTO platform_remits(id, agent_id, amount, destination, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, agent.id, value.toString(), destination, 'reserved', at, at);
      return this.remit(id);
    });
  }
  remit(id) { return row(this.db.get('SELECT * FROM platform_remits WHERE id = ?', id)); }
  openRemits() { return rows(this.db.all("SELECT * FROM platform_remits WHERE state IN ('reserved', 'signed', 'submitted') ORDER BY created_at ASC")); }
  remits({ state = null, limit = 500 } = {}) { return rows(state ? this.db.all('SELECT * FROM platform_remits WHERE state = ? ORDER BY created_at ASC LIMIT ?', state, limit) : this.db.all('SELECT * FROM platform_remits ORDER BY created_at DESC LIMIT ?', limit)); }
  updateRemit(id, patch) {
    const allowed = ['state', 'operation', 'signature', 'expiry_check', 'error'], sets = [], params = [];
    for (const [key, value] of Object.entries(patch)) { const column = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()); if (!allowed.includes(column)) fail(`Remittance field ${key} cannot be updated.`); sets.push(`${column} = ?`); params.push(['operation', 'expiry_check'].includes(column) ? (value === null ? null : json(value)) : value); }
    this.db.run(`UPDATE platform_remits SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params, this.now(), id); return this.remit(id);
  }
  /** Finalized remittance: the reserved share left the wallet; its network fee comes out of the remaining set-aside share. */
  settleRemit(id, { signature, feeLamports = '0' }) {
    const remit = this.remit(id); if (!remit || !['signed', 'submitted'].includes(remit.state)) fail('The remittance is not awaiting confirmation.', 409);
    const owner = agentOwner(remit.agentId), amount = BigInt(remit.amount), payable = BigInt(this.agentBalances(remit.agentId).sol.protocolPayable), fee = nonNegative(feeLamports, 'Fee'), fromPayable = fee < payable ? fee : payable;
    return this.transaction(() => {
      const entries = [{ owner, asset: ASSET.SOL, bucket: 'protocol_remitting', delta: -amount }, { owner: EXTERNAL.chain, asset: ASSET.SOL, bucket: 'main', delta: amount + fromPayable }];
      if (fromPayable > 0n) entries.push({ owner, asset: ASSET.SOL, bucket: 'protocol_payable', delta: -fromPayable });
      this.ledger.post({ kind: 'platform-remit', sourceKey: `remit:${id}:settle`, agentId: remit.agentId, reference: signature, entries });
      this.db.run("UPDATE platform_remits SET state = 'confirmed', signature = ?, fee = ?, updated_at = ? WHERE id = ?", signature, fee.toString(), this.now(), id);
      return this.remit(id);
    });
  }
  /** A failed or expired remittance returns the reserve to protocol_payable (a failed transaction's fee is still charged to it). */
  releaseRemit(id, { reason, feeLamports = '0' } = {}) {
    const remit = this.remit(id); if (!remit || !['reserved', 'signed', 'submitted'].includes(remit.state)) return remit;
    const owner = agentOwner(remit.agentId), amount = BigInt(remit.amount), fee = nonNegative(feeLamports, 'Fee'), charged = fee < amount ? fee : amount;
    return this.transaction(() => {
      const entries = [{ owner, asset: ASSET.SOL, bucket: 'protocol_remitting', delta: -amount }];
      if (amount - charged > 0n) entries.push({ owner, asset: ASSET.SOL, bucket: 'protocol_payable', delta: amount - charged });
      if (charged > 0n) entries.push({ owner: EXTERNAL.chain, asset: ASSET.SOL, bucket: 'main', delta: charged });
      this.ledger.post({ kind: 'platform-remit-release', sourceKey: `remit:${id}:release`, agentId: remit.agentId, reference: id, memo: String(reason || '').slice(0, 200), entries });
      this.db.run("UPDATE platform_remits SET state = ?, fee = ?, error = ?, updated_at = ? WHERE id = ?", charged > 0n ? 'failed' : 'released', charged.toString(), String(reason || '').slice(0, 240), this.now(), id);
      return this.remit(id);
    });
  }
  openReimbursements() { return rows(this.db.all("SELECT * FROM reimbursements WHERE state IN ('requested', 'signed', 'submitted') ORDER BY created_at ASC")); }
  /** USDC physically in this agent's wallet that has already been backed and not yet moved to the operator. */
  reimbursableUsdc(agentId) {
    let allocated = 0n, moved = 0n;
    for (const found of this.db.all('SELECT usdc FROM provider_allocations WHERE agent_id = ?', agentId)) allocated += BigInt(found.usdc);
    for (const found of this.db.all("SELECT usdc FROM reimbursements WHERE agent_id = ? AND state IN ('requested', 'signed', 'submitted', 'finalized')", agentId)) moved += BigInt(found.usdc);
    return allocated > moved ? allocated - moved : 0n;
  }
  updateReimbursement(id, patch) { const allowed = ['state', 'operation', 'signature', 'error', 'finalized_at', 'expiry_check'], sets = [], params = []; for (const [key, value] of Object.entries(patch)) { const column = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()); if (!allowed.includes(column)) fail(`Reimbursement field ${key} cannot be updated.`); sets.push(`${column} = ?`); params.push(['operation', 'expiry_check'].includes(column) ? (value === null ? null : json(value)) : value); } sets.push('updated_at = ?'); params.push(this.now(), id); this.db.run(`UPDATE reimbursements SET ${sets.join(', ')} WHERE id = ?`, ...params); return this.reimbursement(id); }
  /** A finalized reimbursement: the receivable leaves the platform for the operator wallet. */
  settleReimbursement(id, { signature }) {
    return this.transaction(() => {
      const item = this.reimbursement(id); if (!item) fail('Reimbursement not found.', 404); if (item.state === 'finalized') return item;
      const amount = BigInt(item.usdc);
      this.ledger.post({ kind: 'reimbursement', sourceKey: `reimburse:${id}`, agentId: item.agentId, reference: signature, memo: 'Operator reimbursed from backed operating funds', entries: [{ owner: PLATFORM, asset: ASSET.USDC, bucket: 'operator_receivable', delta: -amount }, { owner: EXTERNAL.operator, asset: ASSET.USDC, bucket: 'main', delta: amount }] });
      return this.updateReimbursement(id, { state: 'finalized', signature, finalizedAt: this.now(), operation: null });
    });
  }
  // ---- runs ---------------------------------------------------------------------
  createRun({ agentId, trigger, policyHash, model, revision, dryRun = false }) {
    const agent = this.requireAgent(agentId), id = newId(), at = this.now();
    if (this.activeRun(agent.id)) fail('This agent already has an active run.', 409, 'AGENT_RUN_ACTIVE');
    this.db.run('INSERT INTO runs(id, agent_id, state, trigger, policy_hash, model, revision, dry_run, queued_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, agent.id, 'queued', String(trigger).slice(0, 40), policyHash, model, revision, dryRun ? 1 : 0, at, at);
    return this.run(id);
  }
  run(id) { return row(this.db.get('SELECT * FROM runs WHERE id = ?', id)); }
  activeRun(agentId) { return row(this.db.get("SELECT * FROM runs WHERE agent_id = ? AND state IN ('queued', 'reserved', 'running', 'reconciling_cost') ORDER BY queued_at DESC LIMIT 1", agentId)); }
  activeRuns() { return rows(this.db.all("SELECT * FROM runs WHERE state IN ('queued', 'reserved', 'running', 'reconciling_cost') ORDER BY queued_at ASC")); }
  runs(agentId, { limit = 20, before = null } = {}) { return rows(before ? this.db.all('SELECT * FROM runs WHERE agent_id = ? AND queued_at < ? ORDER BY queued_at DESC LIMIT ?', agentId, before, limit) : this.db.all('SELECT * FROM runs WHERE agent_id = ? ORDER BY queued_at DESC LIMIT ?', agentId, limit)); }
  updateRun(id, patch) {
    const allowed = ['state', 'reserved_usd', 'spent_usd', 'disputed_usd', 'model_calls', 'tool_calls', 'browser_actions', 'browser_seconds', 'lease_owner', 'lease_expires_at', 'summary', 'error_code', 'error', 'provider_requests', 'started_at', 'finished_at'], sets = [], params = [];
    for (const [key, value] of Object.entries(patch)) { const column = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()); if (!allowed.includes(column)) fail(`Run field ${key} cannot be updated.`); if (column === 'state' && !RUN_STATES.includes(value)) fail('Invalid run state.'); sets.push(`${column} = ?`); params.push(column === 'provider_requests' ? json(value) : value); }
    sets.push('updated_at = ?'); params.push(this.now(), id);
    this.db.run(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.run(id);
  }
  /** Lease with fencing: a takeover bumps the fence so late results from the previous owner are ignored. */
  claimRun(id, owner, leaseMs) {
    return this.transaction(() => {
      const run = this.run(id); if (!run) fail('Run not found.', 404);
      if (run.leaseOwner && run.leaseOwner !== owner && run.leaseExpiresAt > this.now()) return null;
      const fence = run.fence + 1;
      this.db.run('UPDATE runs SET lease_owner = ?, lease_expires_at = ?, fence = ?, updated_at = ? WHERE id = ?', owner, this.now() + leaseMs, fence, this.now(), id);
      return { ...run, leaseOwner: owner, leaseExpiresAt: this.now() + leaseMs, fence };
    });
  }
  renewRun(id, owner, fence, leaseMs) { const result = this.db.run('UPDATE runs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND fence = ?', this.now() + leaseMs, this.now(), id, owner, fence); return result.changes === 1; }
  /** Reserves operating credit for a run: backed -> reserved. */
  reserveRun(runId, usd) {
    return this.transaction(() => {
      const run = this.run(runId); if (!run) fail('Run not found.', 404); const amount = positive(usd, 'Reservation'), owner = agentOwner(run.agentId);
      this.ledger.post({ kind: 'run-reserve', sourceKey: `run:${runId}:reserve`, agentId: run.agentId, reference: runId, entries: [{ owner, asset: ASSET.USD, bucket: 'operating_backed', delta: -amount }, { owner, asset: ASSET.USD, bucket: 'operating_reserved', delta: amount }] });
      return this.updateRun(runId, { state: 'reserved', reservedUsd: amount.toString() });
    });
  }
  /** Settles a run's reservation: known cost is spent, unknown cost stays disputed, the rest returns to backed. */
  settleRun(runId, { spentUsd, disputedUsd = '0' }) {
    return this.transaction(() => {
      const run = this.run(runId); if (!run) fail('Run not found.', 404);
      if (this.ledger.hasSource(`run:${runId}:settle`)) return run;
      const reserved = BigInt(run.reservedUsd), spent = nonNegative(spentUsd, 'Spent'), disputed = nonNegative(disputedUsd, 'Disputed'), owner = agentOwner(run.agentId);
      if (reserved === 0n) return run;
      const entries = [{ owner, asset: ASSET.USD, bucket: 'operating_reserved', delta: -reserved }];
      let charged = spent + disputed, variance = 0n;
      if (charged > reserved) { variance = charged - reserved; charged = reserved; }
      const spentCharged = spent > charged ? charged : spent, disputedCharged = charged - spentCharged;
      if (spentCharged > 0n) entries.push({ owner, asset: ASSET.USD, bucket: 'operating_spent', delta: spentCharged });
      if (disputedCharged > 0n) entries.push({ owner, asset: ASSET.USD, bucket: 'operating_disputed', delta: disputedCharged });
      if (reserved - charged > 0n) entries.push({ owner, asset: ASSET.USD, bucket: 'operating_backed', delta: reserved - charged });
      this.ledger.post({ kind: 'run-settle', sourceKey: `run:${runId}:settle`, agentId: run.agentId, reference: runId, entries });
      // Cost beyond the authorized reservation is operator variance, never another
      // agent's credit: it comes out of unallocated provider capacity when there is
      // any, otherwise it is an operator liability flagged for reconciliation.
      if (variance > 0n) {
        const funded = this.ledger.balance(PLATFORM, ASSET.USD, 'provider_capacity') >= variance;
        this.ledger.post({ kind: 'provider-variance', sourceKey: `run:${runId}:variance`, agentId: run.agentId, reference: runId, memo: 'Provider cost above reservation', entries: [{ owner: funded ? PLATFORM : EXTERNAL.provider, asset: ASSET.USD, bucket: funded ? 'provider_capacity' : 'main', delta: -variance }, { owner: PLATFORM, asset: ASSET.USD, bucket: 'provider_variance', delta: variance }] });
        this.raiseAlert({ scope: 'provider', code: funded ? 'variance' : 'variance-unfunded', message: `Provider cost exceeded a run reservation by ${variance} micro-USD.`, detail: { runId, variance: variance.toString() } });
      }
      return this.updateRun(runId, { spentUsd: spentCharged.toString(), disputedUsd: disputedCharged.toString() });
    });
  }
  /** Resolves disputed (unknown) cost once provider evidence arrives. */
  resolveDispute(runId, { actualUsd }) {
    return this.transaction(() => {
      const run = this.run(runId); if (!run) fail('Run not found.', 404); const disputed = BigInt(run.disputedUsd); if (disputed === 0n) return run;
      const actual = nonNegative(actualUsd, 'Actual cost'), owner = agentOwner(run.agentId), charged = actual > disputed ? disputed : actual, entries = [{ owner, asset: ASSET.USD, bucket: 'operating_disputed', delta: -disputed }];
      if (charged > 0n) entries.push({ owner, asset: ASSET.USD, bucket: 'operating_spent', delta: charged });
      if (disputed - charged > 0n) entries.push({ owner, asset: ASSET.USD, bucket: 'operating_backed', delta: disputed - charged });
      this.ledger.post({ kind: 'run-resolve', sourceKey: `run:${runId}:resolve:${this.now()}`, agentId: run.agentId, reference: runId, entries });
      return this.updateRun(runId, { spentUsd: (BigInt(run.spentUsd) + charged).toString(), disputedUsd: '0' });
    });
  }
  recordUsage({ runId, agentId, provider, requestId, kind, model = '', promptTokens = 0, completionTokens = 0, costUsd = '0', estimatedUsd = '0', state, detail = '' }) {
    if (this.db.get('SELECT id FROM usage_events WHERE provider = ? AND request_id = ?', provider, requestId)) return { duplicate: true };
    this.db.run('INSERT INTO usage_events(run_id, agent_id, provider, request_id, kind, model, prompt_tokens, completion_tokens, cost_usd, estimated_usd, state, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', runId, agentId, provider, String(requestId).slice(0, 120), kind, model, promptTokens | 0, completionTokens | 0, nonNegative(costUsd, 'Cost').toString(), nonNegative(estimatedUsd, 'Estimate').toString(), state, String(detail).slice(0, 300), this.now());
    return { duplicate: false };
  }
  usage(runId) { return rows(this.db.all('SELECT * FROM usage_events WHERE run_id = ? ORDER BY id', runId)); }
  resolveUsage(provider, requestId, { costUsd, state = 'resolved' }) { this.db.run('UPDATE usage_events SET cost_usd = ?, state = ?, resolved_at = ? WHERE provider = ? AND request_id = ?', nonNegative(costUsd, 'Cost').toString(), state, this.now(), provider, requestId); }
  unknownUsage(limit = 50) { return rows(this.db.all("SELECT * FROM usage_events WHERE state = 'unknown' ORDER BY created_at ASC LIMIT ?", limit)); }
  // ---- actions ------------------------------------------------------------------
  createAction({ agentId, runId = null, kind, proposal, policyHash, reason = '', state = 'proposed', evaluation = null }) {
    const agent = this.requireAgent(agentId), id = newId(), at = this.now();
    if (!['buyback_burn', 'holder_reward'].includes(kind)) fail('Unsupported action kind.'); if (!ACTION_STATES.includes(state)) fail('Invalid action state.');
    this.db.run('INSERT INTO actions(id, agent_id, run_id, kind, state, proposal, evaluation, policy_hash, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, agent.id, runId, kind, state, json(proposal), evaluation ? json(evaluation) : '', policyHash, String(reason).slice(0, 280), at, at);
    return this.action(id);
  }
  action(id) { return row(this.db.get('SELECT * FROM actions WHERE id = ?', id)); }
  actions(agentId, { limit = 20, before = null, states = null } = {}) {
    const clauses = ['agent_id = ?'], params = [agentId];
    if (before) { clauses.push('created_at < ?'); params.push(before); }
    if (Array.isArray(states) && states.length) { clauses.push(`state IN (${states.map(() => '?').join(',')})`); params.push(...states); }
    return rows(this.db.all(`SELECT * FROM actions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, ...params, limit));
  }
  openActions(agentId = null) { return rows(agentId ? this.db.all("SELECT * FROM actions WHERE agent_id = ? AND state IN ('reserved', 'signed', 'submitted', 'confirmed_pending_finality', 'reconciliation_required') ORDER BY created_at ASC", agentId) : this.db.all("SELECT * FROM actions WHERE state IN ('reserved', 'signed', 'submitted', 'confirmed_pending_finality', 'reconciliation_required') ORDER BY created_at ASC")); }
  updateAction(id, patch) {
    const allowed = ['state', 'evaluation', 'principal_lamports', 'reserved_lamports', 'spent_lamports', 'intent_hash', 'error', 'venue', 'quote', 'outcome', 'finalized_at', 'run_id'], sets = [], params = [];
    for (const [key, value] of Object.entries(patch)) { const column = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()); if (!allowed.includes(column)) fail(`Action field ${key} cannot be updated.`); if (column === 'state' && !ACTION_STATES.includes(value)) fail('Invalid action state.'); sets.push(`${column} = ?`); params.push(['evaluation', 'quote', 'outcome'].includes(column) ? json(value) : value); }
    sets.push('updated_at = ?'); params.push(this.now(), id);
    this.db.run(`UPDATE actions SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.action(id);
  }
  /** Moves treasury SOL into the reserved bucket for an action (principal plus worst-case network cost). */
  reserveAction(actionId, { lamports }) {
    return this.transaction(() => {
      const action = this.action(actionId); if (!action) fail('Action not found.', 404); const amount = positive(lamports, 'Reservation'), owner = agentOwner(action.agentId);
      this.ledger.post({ kind: 'action-reserve', sourceKey: `action:${actionId}:reserve`, agentId: action.agentId, reference: actionId, entries: [{ owner, asset: ASSET.SOL, bucket: 'treasury_available', delta: -amount }, { owner, asset: ASSET.SOL, bucket: 'treasury_reserved', delta: amount }] });
      return this.updateAction(actionId, { state: 'reserved', reservedLamports: amount.toString() });
    });
  }
  /** Settles an action's SOL reservation: spent lamports leave to the chain, the rest returns. Optional token legs record purchased tokens. */
  settleActionLamports(actionId, { spentLamports, retainLamports = '0', sourceSuffix = 'settle', tokenAsset = null, tokensBought = '0' }) {
    return this.transaction(() => {
      const action = this.action(actionId); if (!action) fail('Action not found.', 404);
      const key = `action:${actionId}:${sourceSuffix}`; if (this.ledger.hasSource(key)) return action;
      const reserved = BigInt(action.reservedLamports), spent = nonNegative(spentLamports, 'Spent lamports'), retain = nonNegative(retainLamports, 'Retained lamports'), owner = agentOwner(action.agentId);
      if (spent + retain > reserved) fail('An action spent more than its reservation.', 409, 'AGENT_ACTION_OVERSPEND');
      const release = reserved - spent - retain, entries = [];
      if (spent + release > 0n) entries.push({ owner, asset: ASSET.SOL, bucket: 'treasury_reserved', delta: -(spent + release) });
      if (spent > 0n) entries.push({ owner: EXTERNAL.chain, asset: ASSET.SOL, bucket: 'main', delta: spent });
      if (release > 0n) entries.push({ owner, asset: ASSET.SOL, bucket: 'treasury_available', delta: release });
      const bought = nonNegative(tokensBought, 'Tokens bought');
      if (tokenAsset && bought > 0n) entries.push({ owner: EXTERNAL.chain, asset: tokenAsset, bucket: 'main', delta: -bought }, { owner, asset: tokenAsset, bucket: 'bought_pending_burn', delta: bought });
      if (entries.length >= 2) this.ledger.post({ kind: 'action-settle', sourceKey: key, agentId: action.agentId, reference: actionId, entries });
      return this.updateAction(actionId, { spentLamports: (BigInt(action.spentLamports) + spent).toString(), reservedLamports: retain.toString() });
    });
  }
  /** Burn finalized: tokens leave the pending bucket for the burn address. */
  settleBurn(actionId, { tokenAsset, tokens }) {
    return this.transaction(() => {
      const action = this.action(actionId); if (!action) fail('Action not found.', 404);
      const key = `action:${actionId}:burn`; if (this.ledger.hasSource(key)) return action;
      const amount = positive(tokens, 'Burned tokens'), owner = agentOwner(action.agentId);
      this.ledger.post({ kind: 'burn', sourceKey: key, agentId: action.agentId, reference: actionId, entries: [{ owner, asset: tokenAsset, bucket: 'bought_pending_burn', delta: -amount }, { owner: EXTERNAL.burn, asset: tokenAsset, bucket: 'main', delta: amount }] });
      return action;
    });
  }
  createLeg({ actionId, agentId, sequence, kind, operation = null, signature = null, rawHash = null, expiresHeight = null, preparedSlot = null, state = 'signed' }) {
    const id = newId(), at = this.now();
    this.db.run('INSERT INTO action_legs(id, action_id, agent_id, sequence, kind, state, operation, signature, raw_hash, expires_height, prepared_slot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, actionId, agentId, sequence, kind, state, operation ? json(operation) : null, signature, rawHash, expiresHeight, preparedSlot, at, at);
    return this.leg(id);
  }
  leg(id) { return row(this.db.get('SELECT * FROM action_legs WHERE id = ?', id)); }
  legs(actionId) { return rows(this.db.all('SELECT * FROM action_legs WHERE action_id = ? ORDER BY sequence', actionId)); }
  pendingLegs() { return rows(this.db.all("SELECT * FROM action_legs WHERE state IN ('signed', 'submitted', 'confirmed_pending_finality') ORDER BY created_at ASC")); }
  updateLeg(id, patch) {
    const allowed = ['state', 'operation', 'signature', 'attempts', 'last_broadcast_at', 'next_check_at', 'receipt', 'expiry_check', 'error', 'finalized_at'], sets = [], params = [];
    for (const [key, value] of Object.entries(patch)) { const column = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()); if (!allowed.includes(column)) fail(`Leg field ${key} cannot be updated.`); sets.push(`${column} = ?`); params.push(['operation', 'receipt', 'expiry_check'].includes(column) ? (value === null ? null : json(value)) : value); }
    sets.push('updated_at = ?'); params.push(this.now(), id);
    this.db.run(`UPDATE action_legs SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.leg(id);
  }
  // ---- reward cycles --------------------------------------------------------------
  createRewardCycle({ agentId, actionId, policyHash, windowFrom, windowTo, sampleCount, totalLamports, recipients, exclusions, evidence }) {
    const id = newId(), at = this.now(), total = positive(totalLamports, 'Reward total');
    const sum = recipients.reduce((acc, item) => acc + nonNegative(item.lamports, 'Recipient share'), 0n); if (sum !== total) fail('Reward recipients do not sum to the cycle total.');
    return this.transaction(() => {
      const owner = agentOwner(agentId), action = this.action(actionId); if (!action || BigInt(action.reservedLamports) < total) fail('The action reservation does not cover the reward cycle.', 409);
      this.ledger.post({ kind: 'reward-freeze', sourceKey: `reward:${id}:freeze`, agentId, reference: actionId, memo: 'Holder reward cycle frozen', entries: [{ owner, asset: ASSET.SOL, bucket: 'treasury_reserved', delta: -total }, { owner, asset: ASSET.SOL, bucket: 'reward_frozen', delta: total }] });
      // The frozen principal leaves the action's SOL reservation; only the network-cost reserve remains.
      this.db.run('UPDATE actions SET reserved_lamports = ?, updated_at = ? WHERE id = ?', (BigInt(action.reservedLamports) - total).toString(), this.now(), actionId);
      this.db.run('INSERT INTO reward_cycles(id, agent_id, action_id, state, policy_hash, window_from, window_to, sample_count, total_lamports, recipients, exclusions, evidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, agentId, actionId, 'frozen', policyHash, windowFrom, windowTo, sampleCount, total.toString(), json(recipients.map(r => ({ owner: r.owner, lamports: String(r.lamports), weight: String(r.weight ?? '0') }))), json(exclusions), json(evidence), at, at);
      for (const recipient of recipients) this.db.run('INSERT INTO reward_debts(agent_id, cycle_id, owner, lamports, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', agentId, id, recipient.owner, String(recipient.lamports), 'frozen', at, at);
      return this.rewardCycle(id);
    });
  }
  rewardCycle(id) { return row(this.db.get('SELECT * FROM reward_cycles WHERE id = ?', id)); }
  rewardCycleForAction(actionId) { return row(this.db.get('SELECT * FROM reward_cycles WHERE action_id = ?', actionId)); }
  rewardCycles(agentId, limit = 10) { return rows(this.db.all('SELECT * FROM reward_cycles WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?', agentId, limit)); }
  updateRewardCycle(id, patch) { const allowed = ['state', 'paid_index', 'finalized_at'], sets = [], params = []; for (const [key, value] of Object.entries(patch)) { const column = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()); if (!allowed.includes(column)) fail(`Cycle field ${key} cannot be updated.`); sets.push(`${column} = ?`); params.push(value); } sets.push('updated_at = ?'); params.push(this.now(), id); this.db.run(`UPDATE reward_cycles SET ${sets.join(', ')} WHERE id = ?`, ...params); return this.rewardCycle(id); }
  debts(cycleId) { return rows(this.db.all('SELECT * FROM reward_debts WHERE cycle_id = ? ORDER BY id', cycleId)); }
  openDebts(agentId) { return rows(this.db.all("SELECT * FROM reward_debts WHERE agent_id = ? AND state IN ('frozen', 'deferred') ORDER BY id", agentId)); }
  /** Pays frozen debts in one finalized leg: frozen SOL leaves to the chain; network cost comes from the action reservation. */
  settleDebts(cycleId, { debtIds, signature, legKey }) {
    return this.transaction(() => {
      const cycle = this.rewardCycle(cycleId); if (!cycle) fail('Reward cycle not found.', 404);
      const key = `reward:${cycleId}:${legKey}`; if (this.ledger.hasSource(key)) return cycle;
      const list = debtIds.map(id => row(this.db.get('SELECT * FROM reward_debts WHERE id = ? AND cycle_id = ?', id, cycleId))).filter(Boolean); if (list.length !== debtIds.length) fail('Reward debt not found.', 404);
      const total = list.reduce((acc, debt) => acc + BigInt(debt.lamports), 0n), owner = agentOwner(cycle.agentId);
      this.ledger.post({ kind: 'reward-pay', sourceKey: key, agentId: cycle.agentId, reference: signature, memo: 'Holder rewards paid', entries: [{ owner, asset: ASSET.SOL, bucket: 'reward_frozen', delta: -total }, { owner: EXTERNAL.chain, asset: ASSET.SOL, bucket: 'main', delta: total }] });
      for (const debt of list) this.db.run('UPDATE reward_debts SET state = ?, signature = ?, updated_at = ? WHERE id = ?', 'paid', signature, this.now(), debt.id);
      return this.rewardCycle(cycleId);
    });
  }
  deferDebts(cycleId, debtIds, reason) { for (const id of debtIds) this.db.run('UPDATE reward_debts SET state = ?, reason = ?, updated_at = ? WHERE id = ? AND cycle_id = ?', 'deferred', String(reason).slice(0, 200), this.now(), id, cycleId); }
  /** Releases frozen SOL for debts that can never be paid (e.g. uneconomic recipients after the retention window). */
  releaseDebts(cycleId, debtIds, reason) {
    return this.transaction(() => {
      const cycle = this.rewardCycle(cycleId); if (!cycle) fail('Reward cycle not found.', 404);
      const list = debtIds.map(id => row(this.db.get("SELECT * FROM reward_debts WHERE id = ? AND cycle_id = ? AND state IN ('frozen', 'deferred')", id, cycleId))).filter(Boolean); if (!list.length) return cycle;
      const total = list.reduce((acc, debt) => acc + BigInt(debt.lamports), 0n), owner = agentOwner(cycle.agentId);
      this.ledger.post({ kind: 'reward-release', sourceKey: `reward:${cycleId}:release:${list.map(d => d.id).join('-')}`, agentId: cycle.agentId, reference: cycleId, memo: reason, entries: [{ owner, asset: ASSET.SOL, bucket: 'reward_frozen', delta: -total }, { owner, asset: ASSET.SOL, bucket: 'treasury_available', delta: total }] });
      for (const debt of list) this.db.run('UPDATE reward_debts SET state = ?, reason = ?, updated_at = ? WHERE id = ?', 'released', String(reason).slice(0, 200), this.now(), debt.id);
      return this.rewardCycle(cycleId);
    });
  }
  // ---- holder samples ----------------------------------------------------------------
  addHolderSample({ agentId, at, slot, complete, program, decimals, rows: holders }) {
    if (this.db.get('SELECT id FROM holder_samples WHERE agent_id = ? AND at = ?', agentId, at)) return false;
    this.db.run('INSERT INTO holder_samples(agent_id, at, slot, complete, program, decimals, rows, holder_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', agentId, at, slot, complete ? 1 : 0, program, decimals, json(holders), holders.length);
    return true;
  }
  holderSamples(agentId, { from, to }) { return rows(this.db.all('SELECT * FROM holder_samples WHERE agent_id = ? AND at >= ? AND at <= ? ORDER BY at ASC', agentId, from, to)); }
  latestHolderSample(agentId) { return row(this.db.get('SELECT id, agent_id, at, slot, complete, holder_count FROM holder_samples WHERE agent_id = ? ORDER BY at DESC LIMIT 1', agentId)); }
  pruneHolderSamples(agentId, before) { return this.db.run('DELETE FROM holder_samples WHERE agent_id = ? AND at < ?', agentId, before).changes; }
  // ---- market samples (program evidence, v71.27) -------------------------------------
  /** One public market snapshot per agent per UTC day; the first fresh snapshot of a day is kept. Returns false when the day already has one. */
  recordMarketSample({ agentId, dayKey, at, priceUsd = null, marketCapUsd = null, volume24hUsd = null, priceChange24h = null, progressPercent = null, graduated = false }) {
    if (typeof dayKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) fail('Invalid market sample day.');
    const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    if (this.db.get('SELECT id FROM market_samples WHERE agent_id = ? AND day_key = ?', agentId, dayKey)) return false;
    this.db.run('INSERT INTO market_samples(agent_id, day_key, at, price_usd, market_cap_usd, volume24h_usd, price_change24h, progress_percent, graduated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', agentId, dayKey, at, number(priceUsd), number(marketCapUsd), number(volume24hUsd), number(priceChange24h), number(progressPercent), graduated ? 1 : 0);
    return true;
  }
  marketSample(agentId, dayKey) { return row(this.db.get('SELECT * FROM market_samples WHERE agent_id = ? AND day_key = ?', agentId, dayKey)); }
  /** Newest first, at most `limit` days. */
  marketSamples(agentId, { limit = 31 } = {}) { return rows(this.db.all('SELECT * FROM market_samples WHERE agent_id = ? ORDER BY day_key DESC LIMIT ?', agentId, Math.min(400, Math.max(1, limit | 0)))); }
  pruneMarketSamples(agentId, beforeDayKey) { return this.db.run('DELETE FROM market_samples WHERE agent_id = ? AND day_key < ?', agentId, String(beforeDayKey)).changes; }
  /** Treasury share of the fee receipts credited after `since` (lamports, string). */
  treasuryIncomeSince(agentId, since) { const out = this.db.get('SELECT COALESCE(SUM(CAST(treasury AS INTEGER)), 0) AS total FROM fee_receipts WHERE agent_id = ? AND created_at > ?', agentId, Number(since) || 0); return String(out.total); }
  /** When the newest proposal that was not rejected was created (null when none): the Patience limiter's clock. */
  lastAcceptedActionAt(agentId) { const out = this.db.get("SELECT MAX(created_at) AS at FROM actions WHERE agent_id = ? AND state != 'rejected'", agentId); return out?.at || null; }
  // ---- notes (memory) ----------------------------------------------------------------
  saveNote({ agentId, runId = null, kind = 'note', title, body, sourceUrl = '', provenance }) {
    const bytes = Buffer.byteLength(title, 'utf8') + Buffer.byteLength(body, 'utf8'); if (bytes > AGENT_LIMITS.noteBytes) fail(`Notes are limited to ${AGENT_LIMITS.noteBytes} bytes.`);
    if (typeof title !== 'string' || !title.trim() || typeof body !== 'string') fail('A note needs a title and body.');
    return this.transaction(() => {
      const result = this.db.run('INSERT INTO notes(agent_id, run_id, kind, title, body, source_url, provenance, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', agentId, runId, kind, title.slice(0, 200), body, String(sourceUrl).slice(0, 500), String(provenance).slice(0, 40), bytes, this.now());
      const active = this.db.get('SELECT COUNT(*) AS n FROM notes WHERE agent_id = ? AND active = 1', agentId).n;
      if (active > AGENT_LIMITS.activeNotes) this.db.run('UPDATE notes SET active = 0 WHERE id IN (SELECT id FROM notes WHERE agent_id = ? AND active = 1 AND kind != ? ORDER BY created_at ASC LIMIT ?)', agentId, 'identity', active - AGENT_LIMITS.activeNotes);
      return Number(result.lastInsertRowid);
    });
  }
  notes(agentId, { limit = 50, before = null } = {}) { return rows(before ? this.db.all('SELECT * FROM notes WHERE agent_id = ? AND active = 1 AND id < ? ORDER BY id DESC LIMIT ?', agentId, before, limit) : this.db.all('SELECT * FROM notes WHERE agent_id = ? AND active = 1 ORDER BY id DESC LIMIT ?', agentId, limit)); }
  noteCount(agentId) { return this.db.get('SELECT COUNT(*) AS n FROM notes WHERE agent_id = ? AND active = 1', agentId).n; }
  recallNotes(agentId, query, limit = 8) {
    const terms = String(query || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(term => term.length >= 2).slice(0, 8);
    if (!terms.length) return this.notes(agentId, { limit });
    const match = terms.map(term => `"${term}"*`).join(' OR ');
    try { return rows(this.db.all('SELECT n.* FROM notes_fts f JOIN notes n ON n.id = f.rowid WHERE notes_fts MATCH ? AND n.agent_id = ? AND n.active = 1 ORDER BY bm25(notes_fts) LIMIT ?', match, agentId, limit)); }
    catch { return this.notes(agentId, { limit }); }
  }
  // ---- activity events ---------------------------------------------------------------
  addEvent({ agentId, runId = null, kind, title, body = '', data = {}, isPublic = true }) {
    const result = this.db.run('INSERT INTO activity_events(agent_id, run_id, kind, title, body, data, public, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', agentId, runId, String(kind).slice(0, 40), String(title).slice(0, 200), String(body).slice(0, 2000), json(data), isPublic ? 1 : 0, this.now());
    return Number(result.lastInsertRowid);
  }
  events(agentId, { limit = 30, before = null, after = null, publicOnly = true } = {}) {
    const clauses = ['agent_id = ?'], params = [agentId];
    if (publicOnly) clauses.push('public = 1');
    if (before) { clauses.push('id < ?'); params.push(before); }
    if (after) { clauses.push('id > ?'); params.push(after); }
    return rows(this.db.all(`SELECT * FROM activity_events WHERE ${clauses.join(' AND ')} ORDER BY id ${after ? 'ASC' : 'DESC'} LIMIT ?`, ...params, Math.min(100, limit)));
  }
  recentEvents({ limit = 30, after = null } = {}) { return rows(after ? this.db.all('SELECT * FROM activity_events WHERE public = 1 AND id > ? ORDER BY id ASC LIMIT ?', after, limit) : this.db.all('SELECT * FROM activity_events WHERE public = 1 ORDER BY id DESC LIMIT ?', limit)); }
  lastEventId() { return this.db.get('SELECT MAX(id) AS id FROM activity_events').id || 0; }
  // ---- browser sessions -----------------------------------------------------------------
  createBrowserSession({ agentId, runId, provider, providerSessionId = '', expiresAt }) { const id = newId(), at = this.now(); this.db.run('INSERT INTO browser_sessions(id, agent_id, run_id, provider, provider_session_id, state, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, agentId, runId, provider, providerSessionId, 'open', at, at, expiresAt); return this.browserSession(id); }
  browserSession(id) { return row(this.db.get('SELECT * FROM browser_sessions WHERE id = ?', id)); }
  openBrowserSessions() { return rows(this.db.all("SELECT * FROM browser_sessions WHERE state = 'open' ORDER BY created_at ASC")); }
  latestBrowserSession(agentId) { return row(this.db.get('SELECT * FROM browser_sessions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1', agentId)); }
  updateBrowserSession(id, patch) { const allowed = ['state', 'provider_session_id', 'actions', 'seconds', 'charged_usd', 'current_url', 'error', 'closed_at'], sets = [], params = []; for (const [key, value] of Object.entries(patch)) { const column = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()); if (!allowed.includes(column)) fail(`Session field ${key} cannot be updated.`); sets.push(`${column} = ?`); params.push(value); } sets.push('updated_at = ?'); params.push(this.now(), id); this.db.run(`UPDATE browser_sessions SET ${sets.join(', ')} WHERE id = ?`, ...params); return this.browserSession(id); }
  addScreenshot({ sessionId, agentId, url, bytes, retainMs }) { if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 600000) fail('Invalid screenshot.'); const at = this.now(); const result = this.db.run('INSERT INTO screenshots(session_id, agent_id, url, bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', sessionId, agentId, String(url).slice(0, 500), bytes, at, at + retainMs); return Number(result.lastInsertRowid); }
  latestScreenshot(agentId) { return row(this.db.get('SELECT id, session_id, agent_id, url, created_at, expires_at FROM screenshots WHERE agent_id = ? ORDER BY id DESC LIMIT 1', agentId)); }
  screenshot(id) { const found = this.db.get('SELECT * FROM screenshots WHERE id = ?', id); return found ? { ...row(found), bytes: Buffer.from(found.bytes) } : null; }
  screenshotCount(agentId) { return this.db.get('SELECT COUNT(*) AS n FROM screenshots WHERE agent_id = ?', agentId).n; }
  pruneExpired() { const now = this.now(); const shots = this.db.run('DELETE FROM screenshots WHERE expires_at < ?', now).changes; const logs = this.db.run("UPDATE runs SET provider_requests = '[]' WHERE finished_at IS NOT NULL AND finished_at < ? AND provider_requests != '[]'", now - 30 * 86400000).changes; return { screenshots: shots, runLogs: logs }; }
  // ---- outbox / audit / settings / alerts -----------------------------------------------------
  enqueue({ kind, dedupKey, payload, nextAt = 0 }) { if (this.db.get('SELECT id FROM outbox WHERE dedup_key = ?', dedupKey)) return false; this.db.run('INSERT INTO outbox(kind, dedup_key, payload, next_at, created_at) VALUES (?, ?, ?, ?, ?)', kind, dedupKey, json(payload), nextAt, this.now()); return true; }
  pendingOutbox(limit = 20) { return rows(this.db.all('SELECT * FROM outbox WHERE done_at IS NULL AND next_at <= ? ORDER BY id ASC LIMIT ?', this.now(), limit)); }
  completeOutbox(id) { this.db.run('UPDATE outbox SET done_at = ? WHERE id = ?', this.now(), id); }
  retryOutbox(id, error, delayMs) { this.db.run('UPDATE outbox SET attempts = attempts + 1, error = ?, next_at = ? WHERE id = ?', String(error).slice(0, 300), this.now() + delayMs, id); }
  audit({ actorId, actor, action, target = '', detail = {}, reason = '' }) { this.db.run('INSERT INTO admin_audit(actor_id, actor, action, target, detail, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', String(actorId), String(actor).slice(0, 80), String(action).slice(0, 60), String(target).slice(0, 120), json(detail), String(reason).slice(0, 500), this.now()); }
  auditLog(limit = 50) { return rows(this.db.all('SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?', limit)); }
  setting(key, fallback = null) { const found = this.db.get('SELECT value FROM settings WHERE key = ?', key); if (!found) return fallback; try { return JSON.parse(found.value); } catch { return fallback; } }
  setSetting(key, value, actor = '') { this.db.run('INSERT INTO settings(key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by', key, json(value), this.now(), actor); }
  raiseAlert({ scope, code, message, detail = {} }) { if (this.db.get('SELECT id FROM alerts WHERE scope = ? AND code = ? AND cleared_at IS NULL', scope, code)) return false; this.db.run('INSERT INTO alerts(scope, code, message, detail, created_at) VALUES (?, ?, ?, ?, ?)', scope, code, String(message).slice(0, 300), json(detail), this.now()); return true; }
  clearAlert(scope, code) { return this.db.run('UPDATE alerts SET cleared_at = ? WHERE scope = ? AND code = ? AND cleared_at IS NULL', this.now(), scope, code).changes; }
  openAlerts() { return rows(this.db.all('SELECT * FROM alerts WHERE cleared_at IS NULL ORDER BY created_at DESC LIMIT 100')); }
  // ---- AI influencer (v71.30): influencer record, media jobs, X posts and their reservations ----------------
  /** One influencer per agent: the normalized launch request (plus name/symbol) as spec, the fixed appearance prompt and the state. */
  createInfluencer(agentId, { spec, prompt = '', state = 'pending' }) {
    const agent = this.requireAgent(agentId), at = this.now();
    if (!plainObject(spec)) fail('The influencer spec must be an object.'); if (!INFLUENCER_STATES.includes(state)) fail('Invalid influencer state.');
    if (this.influencer(agent.id)) fail('This agent already has an influencer.', 409);
    this.db.run('INSERT INTO influencers(agent_id, version, spec, prompt, state, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)', agent.id, json(spec), String(prompt || '').slice(0, 2000), state, at, at);
    return this.influencer(agent.id);
  }
  influencer(agentId) { if (!validId(agentId)) return null; return row(this.db.get('SELECT * FROM influencers WHERE agent_id = ?', agentId)); }
  influencers({ states = null } = {}) { return Array.isArray(states) && states.length ? rows(this.db.all(`SELECT * FROM influencers WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY updated_at ASC`, ...states)) : rows(this.db.all('SELECT * FROM influencers ORDER BY updated_at ASC')); }
  updateInfluencer(agentId, patch) {
    ensureId(agentId);
    const allowed = ['version', 'spec', 'prompt', 'state', 'state_reason', 'master_file', 'sheet_file', 'reference_file', 'soul_id', 'consistency', 'generations', 'posting_paused', 'admin_paused', 'admin_pause_reason', 'day_key', 'posts_today', 'images_today', 'videos_today', 'feature_today', 'next_post_at', 'last_post_at'], sets = [], params = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
      if (!allowed.includes(column)) fail(`Influencer field ${key} cannot be updated.`);
      if (column === 'state' && !INFLUENCER_STATES.includes(value)) fail('Invalid influencer state.');
      if (column === 'spec' && !plainObject(value)) fail('The influencer spec must be an object.');
      sets.push(`${column} = ?`); params.push(column === 'spec' ? json(value) : typeof value === 'boolean' ? (value ? 1 : 0) : ['state_reason', 'admin_pause_reason'].includes(column) ? String(value ?? '').slice(0, 300) : value);
    }
    if (!sets.length) return this.influencer(agentId);
    sets.push('updated_at = ?'); params.push(this.now(), agentId);
    this.db.run(`UPDATE influencers SET ${sets.join(', ')} WHERE agent_id = ?`, ...params);
    return this.influencer(agentId);
  }
  createMediaJob({ agentId, runId = null, postId = null, kind, stage = '', provider = 'higgsfield', model = '', request = {}, state = 'queued' }) {
    const agent = this.requireAgent(agentId), id = newId(), at = this.now();
    if (!MEDIA_JOB_KINDS.includes(kind)) fail('Unsupported media job kind.'); if (!MEDIA_JOB_STATES.includes(state)) fail('Invalid media job state.');
    if (!plainObject(request)) fail('The media job request must be an object.');
    this.db.run('INSERT INTO media_jobs(id, agent_id, run_id, post_id, kind, stage, provider, model, request, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, agent.id, runId || null, postId || null, kind, String(stage).slice(0, 40), String(provider).slice(0, 40), String(model).slice(0, 120), json(request), state, at, at);
    return this.mediaJob(id);
  }
  mediaJob(id) { return validId(id) ? row(this.db.get('SELECT * FROM media_jobs WHERE id = ?', id)) : null; }
  updateMediaJob(id, patch) {
    const allowed = ['run_id', 'post_id', 'stage', 'model', 'provider_request_id', 'request', 'state', 'file', 'source_url', 'reserved_usd', 'cost_usd', 'score', 'error', 'attempts', 'next_check_at', 'finished_at'], sets = [], params = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
      if (!allowed.includes(column)) fail(`Media job field ${key} cannot be updated.`);
      if (column === 'state' && !MEDIA_JOB_STATES.includes(value)) fail('Invalid media job state.');
      if (column === 'request' && !plainObject(value)) fail('The media job request must be an object.');
      sets.push(`${column} = ?`); params.push(column === 'request' ? json(value) : column === 'error' ? String(value ?? '').slice(0, 300) : value);
    }
    sets.push('updated_at = ?'); params.push(this.now(), id);
    this.db.run(`UPDATE media_jobs SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.mediaJob(id);
  }
  /** Open jobs whose next check is due, oldest check first. */
  openMediaJobs(limit = 20) { return rows(this.db.all(`SELECT * FROM media_jobs WHERE state IN (${MEDIA_JOB_OPEN_STATES.map(() => '?').join(',')}) AND next_check_at <= ? ORDER BY next_check_at ASC, created_at ASC LIMIT ?`, ...MEDIA_JOB_OPEN_STATES, this.now(), Math.min(200, Math.max(1, limit | 0)))); }
  /** Every open job (due or not), for concurrency counts and expiry. */
  allOpenMediaJobs() { return rows(this.db.all(`SELECT * FROM media_jobs WHERE state IN (${MEDIA_JOB_OPEN_STATES.map(() => '?').join(',')}) ORDER BY created_at ASC`, ...MEDIA_JOB_OPEN_STATES)); }
  mediaJobs(agentId, { limit = 20, kinds = null } = {}) { const clauses = ['agent_id = ?'], params = [agentId]; if (Array.isArray(kinds) && kinds.length) { clauses.push(`kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); } return rows(this.db.all(`SELECT * FROM media_jobs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, ...params, Math.min(200, Math.max(1, limit | 0)))); }
  createXPost({ agentId, runId = null, xAccountId = null, kind, text, link = '', mediaJobId = null, state = 'queued' }) {
    const agent = this.requireAgent(agentId), id = newId(), at = this.now();
    if (!X_POST_KINDS.includes(kind)) fail('Unsupported post kind.'); if (!POST_STATES.includes(state)) fail('Invalid post state.');
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) fail('Invalid post text.');
    this.db.run('INSERT INTO x_posts(id, agent_id, run_id, x_account_id, kind, text, link, media_job_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, agent.id, runId || null, xAccountId || null, kind, text, String(link || '').slice(0, 500), mediaJobId || null, state, at, at);
    return this.xPost(id);
  }
  xPost(id) { return validId(id) ? row(this.db.get('SELECT * FROM x_posts WHERE id = ?', id)) : null; }
  updateXPost(id, patch) {
    const allowed = ['x_account_id', 'kind', 'link', 'media_job_id', 'state', 'x_post_id', 'url', 'reserved_usd', 'cost_usd', 'error', 'attempts', 'next_attempt_at', 'posted_at'], sets = [], params = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
      if (!allowed.includes(column)) fail(`Post field ${key} cannot be updated.`);
      if (column === 'state' && !POST_STATES.includes(value)) fail('Invalid post state.');
      if (column === 'kind' && !X_POST_KINDS.includes(value)) fail('Unsupported post kind.');
      sets.push(`${column} = ?`); params.push(column === 'error' ? String(value ?? '').slice(0, 300) : value);
    }
    sets.push('updated_at = ?'); params.push(this.now(), id);
    this.db.run(`UPDATE x_posts SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.xPost(id);
  }
  openXPosts(limit = 20) { return rows(this.db.all(`SELECT * FROM x_posts WHERE state IN (${POST_OPEN_STATES.map(() => '?').join(',')}) ORDER BY created_at ASC LIMIT ?`, ...POST_OPEN_STATES, Math.min(200, Math.max(1, limit | 0)))); }
  xPosts(agentId, { limit = 20, states = null, runId = undefined } = {}) {
    const clauses = ['agent_id = ?'], params = [agentId];
    if (Array.isArray(states) && states.length) { clauses.push(`state IN (${states.map(() => '?').join(',')})`); params.push(...states); }
    if (runId !== undefined) { clauses.push('run_id = ?'); params.push(runId); }
    return rows(this.db.all(`SELECT * FROM x_posts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, ...params, Math.min(200, Math.max(1, limit | 0))));
  }
  /** Posts of an agent created on a UTC day ('YYYY-MM-DD'), whatever their state (a failed post still used its slot). */
  postsToday(agentId, dayKey) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || '')); if (!match) return 0;
    const from = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return this.db.get('SELECT COUNT(*) AS n FROM x_posts WHERE agent_id = ? AND created_at >= ? AND created_at < ?', agentId, from, from + 86400000).n;
  }
  /** Posts delivered platform-wide on a UTC day (the platform ceiling). */
  postedToday(dayKey) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || '')); if (!match) return 0;
    const from = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return this.db.get("SELECT COUNT(*) AS n FROM x_posts WHERE state = 'posted' AND posted_at >= ? AND posted_at < ?", from, from + 86400000).n;
  }
  /** Reserves operating credit for a media job (backed -> reserved) before the provider is called. A zero amount (dry run) posts nothing. */
  reserveMedia(jobId, usd) {
    return this.transaction(() => {
      const job = this.mediaJob(jobId); if (!job) fail('Media job not found.', 404); const amount = nonNegative(usd, 'Reservation'), owner = agentOwner(job.agentId);
      if (this.ledger.hasSource(`media:${jobId}:reserve`)) return job;
      if (amount > 0n) this.ledger.post({ kind: 'media-reserve', sourceKey: `media:${jobId}:reserve`, agentId: job.agentId, reference: jobId, memo: `${job.kind} generation reserved`, entries: [{ owner, asset: ASSET.USD, bucket: 'operating_backed', delta: -amount }, { owner, asset: ASSET.USD, bucket: 'operating_reserved', delta: amount }] });
      return this.updateMediaJob(jobId, { reservedUsd: amount.toString() });
    });
  }
  /** Settles a media job once: the charged part is spent, the rest returns to backed (a failed or refused generation refunds everything). */
  settleMedia(jobId, { spentUsd = '0' } = {}) {
    return this.transaction(() => {
      const job = this.mediaJob(jobId); if (!job) fail('Media job not found.', 404);
      if (this.ledger.hasSource(`media:${jobId}:settle`)) return job;
      const reserved = BigInt(job.reservedUsd || '0'), owner = agentOwner(job.agentId); let spent = nonNegative(spentUsd, 'Spent'); if (spent > reserved) spent = reserved;
      if (reserved > 0n) {
        const entries = [{ owner, asset: ASSET.USD, bucket: 'operating_reserved', delta: -reserved }];
        if (spent > 0n) entries.push({ owner, asset: ASSET.USD, bucket: 'operating_spent', delta: spent });
        if (reserved - spent > 0n) entries.push({ owner, asset: ASSET.USD, bucket: 'operating_backed', delta: reserved - spent });
        this.ledger.post({ kind: 'media-settle', sourceKey: `media:${jobId}:settle`, agentId: job.agentId, reference: jobId, memo: `${job.kind} generation settled`, entries });
      }
      return this.updateMediaJob(jobId, { costUsd: spent.toString() });
    });
  }
  mediaSettled(jobId) { return this.ledger.hasSource(`media:${jobId}:settle`); }
  reservePost(postId, usd) {
    return this.transaction(() => {
      const post = this.xPost(postId); if (!post) fail('Post not found.', 404); const amount = nonNegative(usd, 'Reservation'), owner = agentOwner(post.agentId);
      if (this.ledger.hasSource(`post:${postId}:reserve`)) return post;
      if (amount > 0n) this.ledger.post({ kind: 'post-reserve', sourceKey: `post:${postId}:reserve`, agentId: post.agentId, reference: postId, memo: 'X post reserved', entries: [{ owner, asset: ASSET.USD, bucket: 'operating_backed', delta: -amount }, { owner, asset: ASSET.USD, bucket: 'operating_reserved', delta: amount }] });
      return this.updateXPost(postId, { reservedUsd: amount.toString() });
    });
  }
  settlePost(postId, { spentUsd = '0' } = {}) {
    return this.transaction(() => {
      const post = this.xPost(postId); if (!post) fail('Post not found.', 404);
      if (this.ledger.hasSource(`post:${postId}:settle`)) return post;
      const reserved = BigInt(post.reservedUsd || '0'), owner = agentOwner(post.agentId); let spent = nonNegative(spentUsd, 'Spent'); if (spent > reserved) spent = reserved;
      if (reserved > 0n) {
        const entries = [{ owner, asset: ASSET.USD, bucket: 'operating_reserved', delta: -reserved }];
        if (spent > 0n) entries.push({ owner, asset: ASSET.USD, bucket: 'operating_spent', delta: spent });
        if (reserved - spent > 0n) entries.push({ owner, asset: ASSET.USD, bucket: 'operating_backed', delta: reserved - spent });
        this.ledger.post({ kind: 'post-settle', sourceKey: `post:${postId}:settle`, agentId: post.agentId, reference: postId, memo: 'X post settled', entries });
      }
      return this.updateXPost(postId, { costUsd: spent.toString() });
    });
  }
  postSettled(postId) { return this.ledger.hasSource(`post:${postId}:settle`); }
  // ---- aggregate views --------------------------------------------------------------------------
  agentBalances(agentId) {
    const owner = agentOwner(agentId), balances = this.ledger.balances(owner), pick = (asset, bucket) => (balances[asset]?.[bucket] ?? 0n).toString();
    const tokens = Object.fromEntries(Object.entries(balances).filter(([asset]) => asset.startsWith('TOKEN:')).map(([asset, buckets]) => [asset.slice(6), { pendingBurn: (buckets.bought_pending_burn ?? 0n).toString() }]));
    return { sol: { treasuryAvailable: pick('SOL', 'treasury_available'), treasuryReserved: pick('SOL', 'treasury_reserved'), rewardFrozen: pick('SOL', 'reward_frozen'), operatingUnsettled: pick('SOL', 'operating_unsettled'), operatingSettling: pick('SOL', 'operating_settling'), suspense: pick('SOL', 'suspense'), protocolPayable: pick('SOL', 'protocol_payable'), protocolRemitting: pick('SOL', 'protocol_remitting') }, usdc: { operatingSettled: pick('USDC', 'operating_settled') }, usd: { backed: pick('USD', 'operating_backed'), reserved: pick('USD', 'operating_reserved'), spent: pick('USD', 'operating_spent'), disputed: pick('USD', 'operating_disputed') }, tokens };
  }
  platformBalances() { const balances = this.ledger.balances(PLATFORM), pick = (asset, bucket) => (balances[asset]?.[bucket] ?? 0n).toString(); return { providerCapacityUsd: pick('USD', 'provider_capacity'), providerVarianceUsd: pick('USD', 'provider_variance'), operatorReceivableUsdc: pick('USDC', 'operator_receivable'), operatorReimbursedUsdc: pick('USDC', 'operator_reimbursed') }; }
  totals() {
    const sum = (asset, bucket) => { let total = 0n; for (const found of this.db.all("SELECT balance FROM ledger_accounts WHERE owner LIKE 'agent:%' AND asset = ? AND bucket = ?", asset, bucket)) total += BigInt(found.balance); return total; };
    return { solPlatformShare: (sum('SOL', 'protocol_payable') + sum('SOL', 'protocol_remitting')).toString(), solTreasury: (sum('SOL', 'treasury_available') + sum('SOL', 'treasury_reserved') + sum('SOL', 'reward_frozen')).toString(), solOperating: (sum('SOL', 'operating_unsettled') + sum('SOL', 'operating_settling')).toString(), solSuspense: sum('SOL', 'suspense').toString(), usdcSettled: sum('USDC', 'operating_settled').toString(), usdBacked: sum('USD', 'operating_backed').toString(), usdReserved: sum('USD', 'operating_reserved').toString(), usdSpent: sum('USD', 'operating_spent').toString(), usdDisputed: sum('USD', 'operating_disputed').toString() };
  }
}
