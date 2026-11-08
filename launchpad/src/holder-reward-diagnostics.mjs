import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { displayUnits, isCurrentLaunch } from '../public/launchpad-model.mjs';
import { adminVolumeRecord } from './admin-volume.mjs';
import { autoRewardEnabled, classifyRewardFailure } from './launchpad-reward-recovery.mjs';
import { rewardIntegrityMessage } from './reward-transport-recovery.mjs';
import { deferredRewardSummary } from './launchpad-native-reward-debts.mjs';
import { holderRewardCheckDueAt, taxConversionDueAt } from './launchpad-holder-rewards.mjs';
import { rewardAnalyticsRecord, holderRewardJournalAudit, publicRewardAnalytics } from './public-reward-analytics.mjs';

const REFRESH_MS = 30_000;
const fail = (message, statusCode = 503) => { throw Object.assign(Error(message), { statusCode }); };
const text = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 24) : '';
const address = value => { try { return typeof value === 'string' && new PublicKey(value).toBase58() === value ? value : null; } catch { return null; } };
const unsigned = value => typeof value === 'string' && /^\d{1,40}$/.test(value) ? value : null;
const stamp = value => Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000 ? value : null;

const select = (value, allowed) => allowed.includes(value) ? value : null;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const operationKinds = ['claim','tax','tax-burn','sell','gas-sell','buy','burn','payout','tax-protocol-payout','reward-handoff','create','launch-all','protocol-claim','protocol-payout','protocol-enable','creator-fee-update','platform-brand-update'];
const failureKinds = ['network','gas-budget','transaction','funding','market'];

// Export only exact local messages. A bounded redaction regex cannot guarantee
// arbitrary provider/decoder text has no passwords, keys or transaction bytes.
const localServiceMessages = new Set([
  'LAUNCHPAD tax burn exceeds its verified rewards-wallet inventory.',
  'LAUNCHPAD tax burn is missing a finalized token-account balance.',
  'The creator rewards token account cannot cover its saved credits.',
  'The creator rewards token account is unavailable.',
  'The reward inventory snapshot is behind its confirmed transaction receipt. Waiting for a fresh finalized context.',
  'The rewards handoff simulation is behind its verified inventory snapshot. Waiting for a fresh finalized context.',
  'Invalid dedicated rewards wallet state.',
  'The dedicated rewards wallet is unavailable.',
  'The original rewards custodian is unavailable or exported. Restore verified custody before moving reward funds.',
  'Missing reward wallet credit ledger.',
  'Invalid reward wallet credit ledger.',
  'Reward wallet source credit exceeds its accounted balance.',
  'Rewards handoff exceeds saved creator-held credits.',
  'Reward handoff differs from its saved credit allocation.',
  'Reward handoff receipt differs from its earned inventory.',
  'Reward handoff produced negative credits.',
  'The reward-wallet migration service is unavailable.',
  'The rewards destination token account is invalid.',
  'The separate rewards wallet needs SOL before reward processing can continue.',
  'The original creator wallet needs additional SOL for rewards account rent and gas while preserving its 0.01 SOL reserve.',
  'Fee-credit invariant failed.',
  'Payout receipt differs from its earned-fee budget.',
  'Invalid holder recipient balance check.',
  'Reserved native rewards exceed earned quote credit.',
  'Fee service paused. Pending receipts will still be reconciled.',
  'Saved reward automation settings need to be restored. Choose Resume rewards to continue.',
  'The token-account RPC request failed. Rewards paused without using incomplete data.',
  'Token-account scan is temporarily unavailable. Rewards will retry automatically.',
  'Automatic rewards are waiting to retry automatically.',
  'Automatic rewards are waiting for SOL and will retry automatically.',
  'Automatic rewards will continue after the daily gas budget resets.',
  'Manual rewards are waiting to retry automatically.',
  'Manual rewards are waiting for SOL and will retry automatically.',
  'Manual rewards will continue after the daily gas budget resets.',
  'The daily reward network-cost budget is used. The next budget starts at midnight UTC.',
  'Waiting for the saved reward transaction. Rewards will continue automatically once its outcome is verified.',
  'The reward transaction failed onchain. Its saved step will be prepared again using current chain state.',
  'Submission response unavailable. Launchpad is checking the saved signature; it will not create a second transaction.',
]);
const tokenErrors=new Set(['TokenAccountNotFoundError','TokenInvalidAccountOwnerError','TokenInvalidAccountDataError','TokenAccountFrozenError','TokenInvalidMintError','TokenInvalidOwnerError']);
function simulationFailure(value) {
  if(typeof value!=='string')return null;
  const match=/^Onchain simulation failed during fee processing \(instruction (\d{1,4}), program ([1-9A-HJ-NP-Za-km-z]{32,44}|unresolved)\): (\{"InstructionError":\[(\d{1,4}),(\{"Custom":(\d{1,10})\}|"(InsufficientFunds|InvalidAccountData|InvalidAccountOwner|MissingRequiredSignature|AccountNotRentExempt|InvalidInstructionData)")\]\})\.(?: |$)/.exec(value);
  if(!match||match[1]!==match[4]||match[2]!=='unresolved'&&!address(match[2]))return null;
  const custom=match[6]===undefined?null:Number(match[6]);if(custom!==null&&custom>4294967295)return null;
  return {instruction:Number(match[1]),program:match[2]==='unresolved'?null:match[2],customCode:custom,errorKind:match[7]||'Custom',message:`Onchain simulation failed during fee processing (instruction ${match[1]}, program ${match[2]}): ${match[3]}.`};
}
const localMessage = value => typeof value !== 'string' ? null : localServiceMessages.has(value)||tokenErrors.has(value) ? value : simulationFailure(value)?.message||null;
const canonicalUnits = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,39})$/.test(value) ? value : null;
const signature = value => { try { return typeof value === 'string' && value.length >= 64 && value.length <= 88 && bs58.decode(value).length === 64 ? value : null; } catch { return null; } };
function handoffEvidence(launch) {
  const handoff=launch.rewardsWallet?.lastHandoff;if(!handoff||typeof handoff!=='object')return null;
  const signed=signature(handoff.signature),slots=new Set((Array.isArray(launch.operations)?launch.operations:[]).filter(op=>signed&&op.kind==='reward-handoff'&&op.state==='confirmed'&&op.signature===signed&&Number.isSafeInteger(op.slot)&&op.slot>0).map(op=>op.slot));
  return {signature:signed,at:stamp(handoff.at),slot:slots.size===1?[...slots][0]:null,...Object.fromEntries(['baseDebit','baseCredit','quoteDebit','quoteCredit','taxBaseLoss','protocolQuoteLoss','gasLamports'].map(key=>[key,canonicalUnits(handoff[key])]))};
}

// Inspect saved state only. Arbitrary provider text, recipient identities and
// transaction contents never leave here.

function serviceEvidence(launch, now) {
  const saved = Object.hasOwn(launch, 'feeAutomation'), intent = launch.feeAutomation;
  const enabled = autoRewardEnabled(launch), source = saved ? select(intent?.source, ['user','admin','launch','legacy-enabled','legacy-recovery','legacy-paused','policy-review']) : 'absent';
  const pending = (Array.isArray(launch.operations) ? launch.operations : []).filter(op => ['pending','awaiting_signature'].includes(op?.state));
  const pendingOp = pending.find(op => op.state === 'awaiting_signature') || pending[0];
  const reason = launch.rewardRetry?.reason || launch.error;
  const failure = rewardIntegrityMessage(String(reason || '')) || rewardIntegrityMessage(String(launch.error || '')) ? null
    : select(classifyRewardFailure(reason), failureKinds) || select(launch.rewardRetry?.kind, failureKinds);
  const retryAt = stamp(launch.rewardRetry?.at), blockers = [];
  const add = value => { if (!blockers.includes(value)) blockers.push(value); };
  if (!isCurrentLaunch(launch.input) || !launch.curve || !stamp(launch.authorizedAt) || ['draft','failed','archived','stopping','launching'].includes(launch.state)) add('launch_not_ready');
  if (launch.keys?.wallet?.external === true) add('connected_wallet_required');
  if (pending.some(op => op.state === 'awaiting_signature')) add('awaiting_wallet_signature');
  if (pending.some(op => op.state === 'pending')) add('awaiting_transaction_receipt');
  if (saved && typeof intent?.enabled !== 'boolean') add('invalid_automation_intent');
  else if (!enabled) add(source === 'policy-review' ? 'policy_review_required' : source === 'legacy-paused' || !saved ? 'legacy_pause_needs_review' : ['user','admin'].includes(source) ? 'intentional_pause' : 'automation_disabled');
  if (retryAt) add(retryAt > now ? failure === 'gas-budget' ? 'daily_budget_retry_scheduled' : 'reward_retry_scheduled' : 'reward_retry_due');
  if (failure) add({network:'network_retry', 'gas-budget':'gas_budget', transaction:'transaction_retry', funding:'native_funding_required', market:'market_wait'}[failure]);
  if (['paused','error'].includes(launch.state)) add('runtime_paused');
  if (launch.error && !failure && !pending.length && !retryAt && !['intentional_pause','legacy_pause_needs_review','invalid_automation_intent','policy_review_required'].some(value => blockers.includes(value))) add('unclassified_error');
  if (['queued','processing'].includes(launch.heldSolDistribution?.state)) add('held_sol_distribution_active');
  if (launch.rewardsWallet?.gasFundingNeed) add('saved_reward_wallet_funding_need');
  const base = unsigned(launch.credits?.base), quote = unsigned(launch.credits?.quote), minimum = unsigned(launch.holderRewards?.minimumQuoteUnits);
  if (base === null || quote === null) add('invalid_saved_credit');
  if (quote === '0' && base === '0') add('no_saved_reward_credit');
  if (quote !== null && minimum !== null && BigInt(quote) < BigInt(minimum)) add('below_saved_quote_threshold');
  if (/^Waiting for a fresh quote price to check the \$[0-9.]+ reward minimum\.$/.test(launch.holderRewards?.thresholdNote || '')) add('fresh_quote_price_required');
  let nextCheckAt = null, nextConversionAt = null;
  try { nextCheckAt = stamp(holderRewardCheckDueAt(launch)); nextConversionAt = stamp(taxConversionDueAt(launch)); } catch {}
  if (nextCheckAt > now) add('holder_check_interval');
  if (base !== null && BigInt(base) > 0n && nextConversionAt > now) add('tax_conversion_cooldown');
  const serviceError=localMessage(launch.error),retryReason=localMessage(launch.rewardRetry?.reason),deferred=deferredRewardSummary(launch);
  const day = typeof launch.gas?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(launch.gas.day) ? launch.gas.day : null;
  return { evidence: 'saved-service-journal', creatorWallet: address(launch.keys?.wallet?.address), rewardsWallet: address(launch.keys?.rewards?.address),
    state: select(launch.state, ['draft','launching','live','paused','error','failed','archived','stopping','pending','awaiting_signature']),
    enabled, automationIntent: { saved, enabled: saved && typeof intent?.enabled === 'boolean' ? intent.enabled : null, source, updatedAt: stamp(intent?.updatedAt) },
    feesRequested: launch.feesRequested === true, failureCategory: failure, blockers,
    simulationFailure: (()=>{const failure=simulationFailure(launch.error);if(!failure)return null;const {message,...details}=failure;return details;})(),
    errorFingerprint: typeof launch.error==='string'&&launch.error?createHash('sha256').update(launch.error.slice(0,10000)).digest('hex'):null,
    serviceError, errorTextOmitted: typeof launch.error==='string'&&!!launch.error&&!serviceError, retryReason, retryReasonTextOmitted: typeof launch.rewardRetry?.reason==='string'&&!!launch.rewardRetry.reason&&!retryReason,
    rewardsWalletStatus: select(launch.rewardsWallet?.status,['pending','migrating','active']),
    creatorCredits: launch.rewardsWallet?.creatorCredits ? Object.fromEntries(['base','quote','protocolQuote','taxBase'].map(key=>[key,canonicalUnits(launch.rewardsWallet.creatorCredits[key])])) : null,
    lastHandoff: handoffEvidence(launch), deferredRewards: deferred===null?{unavailable:true}:{wallets:deferred.wallets,amountUnits:deferred.amountUnits},
    pendingOperations: pending.length, pendingOperation: pendingOp ? { kind: select(pendingOp.kind, operationKinds), state: pendingOp.state, createdAt: stamp(pendingOp.createdAt), receiptCheckAfter: stamp(pendingOp.receiptCheckAfter) } : null,
    retryAt, retryAttempt: nonnegative(launch.rewardRetry?.attempt), retryKind: select(launch.rewardRetry?.kind, [...failureKinds, ...operationKinds]), launchRetryAt: stamp(launch.retry?.at),
    cycleStage: select(launch.cycle?.stage, ['claim','tax','route','tax-protocol','distribute','payout','burn','done']),
    credits: { baseUnits: base, quoteUnits: quote }, savedMinimumQuoteUnits: minimum, thresholdBasis: 'saved_reference_not_current_valuation',
    nextHolderCheckAt: nextCheckAt, nextTaxConversionAt: nextConversionAt,
    gasBudget: { day, reservedLamports: unsigned(launch.gas?.reserved), dailyLimitLamports: unsigned(launch.input?.dailyGasLamports), liveBalanceVerified: false } };
}

function eligibility(launch, now) {
  if (!isCurrentLaunch(launch?.input)) return 'unsupported_launch';
  if (launch.state === 'draft') return 'draft';
  if (!stamp(launch.authorizedAt)) return 'missing_launch_authorization';
  if (!address(launch.keys?.mint?.address) || !address(launch.input.quoteMint) || !address(launch.keys?.wallet?.address)) return 'invalid_launch_addresses';
  try { return adminVolumeRecord(launch, now) ? null : 'completed_launch_evidence_invalid_or_missing'; }
  catch { return 'completed_launch_evidence_invalid_or_missing'; }
}

/** Read-only admin export from the retained private books. No chain request,
 * transaction submission or journal change occurs. Signatures are public;
 * account IDs, payout recipients, arbitrary errors and signing material are omitted. */
export function holderRewardDiagnostics(launches = [], { now = Date.now(), inventoryComplete = true, storesRead = 0, storesUnavailable = 0, maxDetails = 500, additionalRecords, additionalComplete = true, pricesByMint = new Map() } = {}) {
  const facts = [], groups = new Map(); let index = 0;
  const raydiumComplete = inventoryComplete === true && Array.isArray(launches);
  for (const launch of Array.isArray(launches) ? launches : []) {
    if (launch?.input?.feeMode !== 'holders' || launch.input.gotchi) continue;
    const reason = eligibility(launch, now), fact = rewardAnalyticsRecord(launch), mint = address(launch.keys?.mint?.address);
    const key = mint || `invalid:${index++}`;
    let group = groups.get(key);
    if (!group) {
      group = { mint, symbol: text(launch.input.symbol), quote: fact.quote, platforms: new Set(['raydium']), sourceWallet: address(launch.keys?.wallet?.address), includedInAnalytics: false, excludedLaunchReasons: new Set(),
        journalCopies: 0, retainedOperations: 0, payoutStates: { confirmed: 0, pending: 0, failed: 0, expired: 0, other: 0 }, historyFlags: new Set(), cycleEvidence: [], omittedCycleEvidence: 0, serviceEvidence: [], omittedServiceEvidence: 0, serviceEvidenceUnavailable: false };
      groups.set(key, group);
    }
    group.journalCopies++;
    if (group.serviceEvidence.length < 10) group.serviceEvidence.push(serviceEvidence(launch, now));
    else group.omittedServiceEvidence++;
    if (group.sourceWallet !== address(launch.keys?.wallet?.address)) group.sourceWallet = null;
    if (reason) group.excludedLaunchReasons.add(reason);
    else { group.includedInAnalytics = true; facts.push(fact); }
    const ops = Array.isArray(launch.operations) ? launch.operations : [];
    group.retainedOperations += ops.length;
    if (!Array.isArray(launch.operations)) group.historyFlags.add('operations_missing');
    if (launch.historyTruncated === true || launch.operationsTruncated === true) group.historyFlags.add('retained_history_truncated');
    if (!fact.metadataValid) group.historyFlags.add('quote_or_launch_metadata_invalid');
    if (!fact.operations.some(op => ['create', 'launch-all'].includes(op.kind) && op.state === 'confirmed' && op.signature && op.slot)) group.historyFlags.add('creation_receipt_missing');
    for (const op of ops) if (op?.kind === 'payout') group.payoutStates[Object.hasOwn(group.payoutStates, op.state) ? op.state : 'other']++;
    const evidence = { lastDistributionAt: stamp(launch.holderRewards?.lastDistributionAt), lastCycleQuoteUnits: unsigned(launch.holderRewards?.lastDistributionQuoteUnits), currentCycleQuoteUnits: unsigned(launch.cycle?.distributedQuoteUnits) };
    const values = [launch.holderRewards?.lastDistributionQuoteUnits, launch.cycle?.distributedQuoteUnits].filter(value => value !== undefined && value !== null);
    if (values.some(value => unsigned(value) === null)) group.historyFlags.add('invalid_cycle_counter');
    if (values.length || evidence.lastDistributionAt) {
      if (group.cycleEvidence.length < 10) group.cycleEvidence.push(evidence);
      else group.omittedCycleEvidence++;
    }
  }
  const raydiumFacts = [...facts], meteoraFacts = [];
  const includesMeteora = additionalRecords !== undefined, meteoraComplete = additionalComplete === true && Array.isArray(additionalRecords);
  for (const fact of Array.isArray(additionalRecords) ? additionalRecords : []) {
    if (!fact || fact.mode !== 'holders') continue;
    meteoraFacts.push(fact); facts.push(fact);
    const mint = address(fact.mint), key = mint || `invalid:${index++}`;
    let group = groups.get(key);
    if (!group) {
      group = { mint, symbol: '', quote: { mint: address(fact.quote?.mint), symbol: text(fact.quote?.symbol), decimals: Number.isInteger(fact.quote?.decimals) && fact.quote.decimals >= 0 && fact.quote.decimals <= 18 ? fact.quote.decimals : null }, platforms: new Set(), sourceWallet: null, includedInAnalytics: false, excludedLaunchReasons: new Set(),
        journalCopies: 0, retainedOperations: 0, payoutStates: { confirmed: 0, pending: 0, failed: 0, expired: 0, other: 0 }, historyFlags: new Set(), cycleEvidence: [], omittedCycleEvidence: 0, serviceEvidence: [], omittedServiceEvidence: 0, serviceEvidenceUnavailable: false };
      groups.set(key, group);
    }
    group.serviceEvidenceUnavailable = true;
    group.platforms.add('meteora'); group.sourceWallet = null; group.includedInAnalytics = true; group.journalCopies++;
    const operations = Array.isArray(fact.operations) ? fact.operations : [];
    group.retainedOperations += operations.length;
    if (!fact.metadataValid) group.historyFlags.add('quote_or_launch_metadata_invalid');
    if (!fact.historyComplete) group.historyFlags.add('analytics_history_incomplete');
    for (const op of operations) if (op?.kind === 'payout') group.payoutStates[Object.hasOwn(group.payoutStates, op.state) ? op.state : 'other']++;
  }
  const audits = new Map(holderRewardJournalAudit(facts, { maxDetails }).map(row => [row.mint, row]));
  const rows = [...groups.values()].map(group => {
    const audit = audits.get(group.mint) || null;
    const retained = audit ? BigInt(audit.countedQuoteUnits) : null;
    if (retained !== null && group.cycleEvidence.some(row => [row.lastCycleQuoteUnits, row.currentCycleQuoteUnits].some(value => value !== null && BigInt(value) > retained))) group.historyFlags.add('cycle_counter_exceeds_retained_payouts');
    if (audit && !audit.historyComplete) group.historyFlags.add('analytics_history_incomplete');
    const amount = audit?.metadataValid && Number.isInteger(audit.quote.decimals) ? displayUnits(audit.countedQuoteUnits, audit.quote.decimals) : null;
    return { ...group, platforms: [...group.platforms].sort(), excludedLaunchReasons: [...group.excludedLaunchReasons].sort(), historyFlags: [...group.historyFlags].sort(),
      analytics: audit ? { historyComplete: audit.historyComplete, countedPayouts: audit.countedPayouts, recoveredPayoutAmounts: audit.recoveredPayoutAmounts,
        countedQuoteUnits: audit.countedQuoteUnits, countedQuoteAmount: amount, reasons: audit.reasons, transactions: audit.details, omittedTransactions: audit.omittedDetails } : null };
  }).sort((a, b) => (a.mint || '').localeCompare(b.mint || ''));
  const complete = raydiumComplete && (!includesMeteora || meteoraComplete);
  const totals = (records, inventoryComplete) => {
    const holders = publicRewardAnalytics(records, { now, pricesByMint, inventoryComplete }).holders;
    // Recover raw units only from the reducer's exact decimal string. This
    // adds no independent summation or Number rounding to the public totals.
    holders.distributed.quoteTotals = holders.distributed.quoteTotals.map(row => {
      const [whole, fraction = ''] = typeof row.amount === 'string' ? row.amount.split('.') : [];
      const amountUnits = whole !== undefined && Number.isInteger(row.decimals) && fraction.length <= row.decimals ? BigInt(whole + fraction.padEnd(row.decimals, '0')).toString() : null;
      return { ...row, amountUnits };
    });
    return holders;
  };
  return { version: 1, generatedAt: now, inventoryComplete: complete, storesRead, storesUnavailable,
    holderLaunches: rows.length, includedLaunches: rows.filter(row => row.includedInAnalytics).length, launches: rows,
    evidence: 'saved-confirmed-payout-journals', liveChainVerified: false,
    holders: totals(facts, complete),
    platforms: [{ id: 'raydium', inventoryComplete: raydiumComplete, holders: totals(raydiumFacts, raydiumComplete) }, ...(includesMeteora ? [{ id: 'meteora', inventoryComplete: meteoraComplete, holders: totals(meteoraFacts, meteoraComplete) }] : [])],
    note: 'Retained confirmed payout receipts only. Combined amounts and unique recipient-address counts use the public analytics reducer across all included platforms; platform wallet counts must not be added together. USD uses the same current cached quote prices, not historical payout prices. Raydium state counts include retained journal copies; Meteora exposes finalized receipt projections. Analytics deduplicates signatures across copies. Cycle counters describe individual cycles, never lifetime totals. Saved receipts are not reverified onchain by this report. Service evidence lists individual saved Raydium journals, including excluded and duplicate copies; credits and gas reservations are not live wallet balances. Thresholds are saved references, not current valuations. Service error text includes only recognized fixed local messages; arbitrary provider errors are omitted. Wallet handoffs and deferred amounts are saved evidence, not live balances. Meteora exposes receipt history without current service journals. This report does not pay, retry or change rewards.' };
}

export class HolderRewardDiagnostics {
  // The account scan limit matches the registry ceiling (accounts.mjs MAX_REGISTRY_ACCOUNTS).
  constructor({ accounts, additionalRecords, pricesByMint, now = Date.now, maxAccounts = 10000, maxLaunches = 100000, maxOperations = 1000000 } = {}) {
    Object.assign(this, { accounts, additionalRecords, pricesByMint, now, maxAccounts, maxLaunches, maxOperations }); this.cached = null; this.pending = null; this.closed = false;
  }
  async read(actorId) {
    const actor = await this.accounts.get(actorId);
    if (actor?.role !== 'admin' || actor.banned || !actor.mfaEnabled) fail('Administrator access with two-factor authentication is required.', 403);
    if (this.closed) fail('Holder reward diagnostics is restarting.');
    if (this.cached && this.now() - this.cached.generatedAt < REFRESH_MS) return structuredClone(this.cached);
    if (!this.pending) this.pending = this.build().finally(() => { this.pending = null; });
    return structuredClone(await this.pending);
  }
  async build() {
    let accounts;
    try { accounts = await this.accounts.list(); } catch { fail('Holder reward diagnostics inventory is temporarily unavailable.'); }
    if (!Array.isArray(accounts) || accounts.length > this.maxAccounts) fail('Holder reward diagnostics exceeds its account scan limit.');
    const launches = []; let storesRead = 0, storesUnavailable = 0, checked = 0, operations = 0;
    for (let index = 0; index < accounts.length; index += 8) {
      const books = await Promise.allSettled(accounts.slice(index, index + 8).map(account => Promise.resolve().then(() => this.accounts.storeFor(account.id).read('launchpad', { launches: [] }))));
      for (const book of books) {
        if (book.status !== 'fulfilled' || !Array.isArray(book.value?.launches)) { storesUnavailable++; continue; }
        storesRead++;
        for (const launch of book.value.launches) {
          if (++checked > this.maxLaunches) fail('Holder reward diagnostics exceeds its launch scan limit.');
          operations += Array.isArray(launch?.operations) ? launch.operations.length : 0;
          if (operations > this.maxOperations) fail('Holder reward diagnostics exceeds its history scan limit.');
          if (!launch || typeof launch !== 'object' || Array.isArray(launch)) { storesUnavailable++; continue; }
          if (launch.input?.feeMode === 'holders' && !launch.input.gotchi) launches.push(launch);
        }
      }
    }
    let additionalRecords, additionalComplete = true;
    if (typeof this.additionalRecords === 'function') {
      try {
        additionalRecords = await this.additionalRecords();
        if (!Array.isArray(additionalRecords) || checked + additionalRecords.length > this.maxLaunches) throw Error('Invalid additional reward history.');
        for (const row of additionalRecords) {
          if (!row || row.mode !== 'holders' || !Array.isArray(row.operations)) throw Error('Invalid additional reward record.');
          operations += row.operations.length;
          if (operations > this.maxOperations) throw Error('Additional reward history exceeds its limit.');
        }
      } catch { additionalRecords = []; additionalComplete = false; }
    }
    let pricesByMint;
    try { pricesByMint = typeof this.pricesByMint === 'function' ? await this.pricesByMint() : this.pricesByMint; } catch {}
    if (this.closed) fail('Holder reward diagnostics is restarting.');
    const report = holderRewardDiagnostics(launches, { now: this.now(), inventoryComplete: storesUnavailable === 0, storesRead, storesUnavailable, additionalRecords, additionalComplete, pricesByMint });
    this.cached = report; return report;
  }
  close() { this.closed = true; this.cached = null; }
}
