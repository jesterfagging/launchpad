const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const stamp = value => number(value) > 0 && value <= 8_640_000_000_000_000 ? value : null;
const address = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : null;
const signature = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value) ? value : null;
const units = value => typeof value === 'string' && /^\d{1,40}$/.test(value) ? value : null;
const amount = value => typeof value === 'string' && /^\d{1,40}(?:\.\d{1,18})?$/.test(value) ? value : null;
const usd = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const decimals = value => number(value) !== null && value <= 18 ? value : null;
const symbol = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 24) : '';
const codes = new Set(['unsupported_launch','draft','missing_launch_authorization','invalid_launch_addresses','completed_launch_evidence_invalid_or_missing','operations_missing','retained_history_truncated','quote_or_launch_metadata_invalid','creation_receipt_missing','invalid_cycle_counter','cycle_counter_exceeds_retained_payouts','analytics_history_incomplete','not_confirmed','missing_or_invalid_signature','missing_or_invalid_finalized_slot','conflicting_signature','duplicate_signature','conflicting_operation_id','conflicting_record','missing_or_invalid_amount','contradictory_receipt','confirmed_payout','amount_recovered_from_confirmed_receipt','recipient_breakdown_incomplete','recipient_identity_incomplete']);
const list = value => Array.isArray(value) ? value : [];
const reason = value => codes.has(value) ? value : 'unrecognized_history_issue';
const platformIds = value => [...new Set(list(value).filter(id => ['raydium','meteora'].includes(id)))];
const select = (value, allowed) => allowed.includes(value) ? value : null;
const operationKinds = ['claim','tax','tax-burn','sell','gas-sell','buy','burn','payout','tax-protocol-payout','reward-handoff','create','launch-all','protocol-claim','protocol-payout','protocol-enable','creator-fee-update','platform-brand-update'];
const failureKinds = ['network','gas-budget','transaction','funding','market'];
const serviceBlockers = new Set(['launch_not_ready','connected_wallet_required','awaiting_wallet_signature','awaiting_transaction_receipt','invalid_automation_intent','policy_review_required','legacy_pause_needs_review','intentional_pause','automation_disabled','daily_budget_retry_scheduled','reward_retry_scheduled','reward_retry_due','network_retry','gas_budget','transaction_retry','native_funding_required','market_wait','runtime_paused','unclassified_error','held_sol_distribution_active','saved_reward_wallet_funding_need','invalid_saved_credit','no_saved_reward_credit','below_saved_quote_threshold','fresh_quote_price_required','holder_check_interval','tax_conversion_cooldown']);
// Mirror the server's fixed-message projection instead of trusting arbitrary
// error strings added to a future endpoint. Simulation log suffixes are dropped.
const canonicalUnits=value=>typeof value==='string'&&/^(?:0|[1-9]\d{0,39})$/.test(value)?value:null;
function programAddress(value){
  if(!address(value))return null;let encoded=0n;for(const char of value)encoded=encoded*58n+BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(char));
  let bytes=0;while(encoded>0n){bytes++;encoded>>=8n;}return bytes+(value.match(/^1*/)?.[0].length||0)===32?value:null;
}
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
  const match=/^Onchain simulation failed during fee processing \(instruction ((?:0|[1-9]\d{0,3})), program ([1-9A-HJ-NP-Za-km-z]{32,44}|unresolved)\): (\{"InstructionError":\[((?:0|[1-9]\d{0,3})),(\{"Custom":((?:0|[1-9]\d{0,9}))\}|"(InsufficientFunds|InvalidAccountData|InvalidAccountOwner|MissingRequiredSignature|AccountNotRentExempt|InvalidInstructionData)")\]\})\.(?: |$)/.exec(value);
  if(!match||match[1]!==match[4]||match[2]!=='unresolved'&&!programAddress(match[2]))return null;
  const custom=match[6]===undefined?null:Number(match[6]);if(custom!==null&&custom>4294967295)return null;
  return {instruction:Number(match[1]),program:match[2]==='unresolved'?null:match[2],customCode:custom,errorKind:match[7]||'Custom',message:`Onchain simulation failed during fee processing (instruction ${match[1]}, program ${match[2]}): ${match[3]}.`};
}
const localMessage = value => typeof value !== 'string' ? null : localServiceMessages.has(value)||tokenErrors.has(value) ? value : simulationFailure(value)?.message||null;
const simulationKinds=['Custom','InsufficientFunds','InvalidAccountData','InvalidAccountOwner','MissingRequiredSignature','AccountNotRentExempt','InvalidInstructionData'];
function safeSimulationFailure(value){
  if(!value||number(value.instruction)===null||value.instruction>9999||!simulationKinds.includes(value.errorKind))return null;
  if(value.program!==null&&!programAddress(value.program))return null;
  const custom=value.errorKind==='Custom';if(custom?(number(value.customCode)===null||value.customCode>4294967295):value.customCode!==null)return null;
  return{instruction:value.instruction,program:value.program,customCode:custom?value.customCode:null,errorKind:value.errorKind};
}
function safeHandoff(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  return{signature:signature(value.signature),at:stamp(value.at),slot:stamp(value.slot),...Object.fromEntries(['baseDebit','baseCredit','quoteDebit','quoteCredit','taxBaseLoss','protocolQuoteLoss','gasLamports'].map(key=>[key,canonicalUnits(value[key])]))};
}
function safeServiceEvidence(value) {
  const serviceError=localMessage(value?.serviceError),retryReason=localMessage(value?.retryReason),parsed=simulationFailure(serviceError);
  const deferred=value?.deferredRewards,deferredAmount=canonicalUnits(deferred?.amountUnits),deferredWallets=number(deferred?.wallets);
  return { evidence: 'saved-service-journal', creatorWallet: address(value?.creatorWallet), rewardsWallet: address(value?.rewardsWallet),
    state: select(value?.state, ['draft','launching','live','paused','error','failed','archived','stopping','pending','awaiting_signature']), enabled: value?.enabled === true,
    automationIntent: { saved: value?.automationIntent?.saved === true, enabled: typeof value?.automationIntent?.enabled === 'boolean' ? value.automationIntent.enabled : null,
      source: select(value?.automationIntent?.source, ['user','admin','launch','legacy-enabled','legacy-recovery','legacy-paused','policy-review','absent']), updatedAt: stamp(value?.automationIntent?.updatedAt) },
    feesRequested: value?.feesRequested === true, failureCategory: select(value?.failureCategory, failureKinds),
    serviceError,retryReason,errorTextOmitted:value?.errorTextOmitted===true||typeof value?.serviceError==='string'&&!!value.serviceError&&value.serviceError!==serviceError,retryReasonTextOmitted:value?.retryReasonTextOmitted===true||typeof value?.retryReason==='string'&&!!value.retryReason&&value.retryReason!==retryReason,
    simulationFailure:safeSimulationFailure(parsed||value?.simulationFailure),errorFingerprint:typeof value?.errorFingerprint==='string'&&/^[a-f0-9]{64}$/.test(value.errorFingerprint)?value.errorFingerprint:null,
    rewardsWalletStatus:select(value?.rewardsWalletStatus,['pending','migrating','active']),
    creatorCredits:value?.creatorCredits&&typeof value.creatorCredits==='object'&&!Array.isArray(value.creatorCredits)?Object.fromEntries(['base','quote','protocolQuote','taxBase'].map(key=>[key,canonicalUnits(value.creatorCredits[key])])):null,
    lastHandoff:safeHandoff(value?.lastHandoff),deferredRewards:deferred?.unavailable===true||deferredAmount===null||deferredWallets===null?{unavailable:true}:{wallets:deferredWallets,amountUnits:deferredAmount},
    blockers: [...new Set(list(value?.blockers).filter(code => serviceBlockers.has(code)))], pendingOperations: number(value?.pendingOperations),
    pendingOperation: value?.pendingOperation ? { kind: select(value.pendingOperation.kind, operationKinds), state: select(value.pendingOperation.state, ['pending','awaiting_signature']), createdAt: stamp(value.pendingOperation.createdAt), receiptCheckAfter: stamp(value.pendingOperation.receiptCheckAfter) } : null,
    retryAt: stamp(value?.retryAt), retryAttempt: number(value?.retryAttempt), retryKind: select(value?.retryKind, [...failureKinds, ...operationKinds]), launchRetryAt: stamp(value?.launchRetryAt),
    cycleStage: select(value?.cycleStage, ['claim','tax','route','tax-protocol','distribute','payout','burn','done']),
    credits: { baseUnits: units(value?.credits?.baseUnits), quoteUnits: units(value?.credits?.quoteUnits) }, savedMinimumQuoteUnits: units(value?.savedMinimumQuoteUnits), thresholdBasis: 'saved_reference_not_current_valuation',
    nextHolderCheckAt: stamp(value?.nextHolderCheckAt), nextTaxConversionAt: stamp(value?.nextTaxConversionAt),
    gasBudget: { day: typeof value?.gasBudget?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.gasBudget.day) ? value.gasBudget.day : null,
      reservedLamports: units(value?.gasBudget?.reservedLamports), dailyLimitLamports: units(value?.gasBudget?.dailyLimitLamports), liveBalanceVerified: false } };
}

function holderTotals(value) {
  if (!value || typeof value !== 'object') return null;
  const distributed = value.distributed || {};
  return { distributed: { usdEstimate: usd(distributed.usdEstimate), observedUsdEstimate: usd(distributed.observedUsdEstimate),
    quoteTotals: list(distributed.quoteTotals).slice(0, 10000).map(row => ({ symbol: symbol(row?.symbol), decimals: decimals(row?.decimals), amount: amount(row?.amount), amountUnits: units(row?.amountUnits), usdEstimate: usd(row?.usdEstimate), priceAt: stamp(row?.priceAt), historyComplete: row?.historyComplete === true, coverage: ['complete','subtotal','unavailable'].includes(row?.coverage) ? row.coverage : 'unavailable' })),
    historyComplete: distributed.historyComplete === true, valuationComplete: distributed.valuationComplete === true, valuationBasis: 'current_quote_prices', evidenceCount: number(distributed.evidenceCount), unpricedQuoteAssets: number(distributed.unpricedQuoteAssets) },
    uniqueWallets: number(value.uniqueWallets), observedUniqueWallets: number(value.observedUniqueWallets), walletsComplete: value.walletsComplete === true, walletCountBasis: 'distinct_confirmed_payout_recipients', payments: number(value.payments), observedPayments: number(value.observedPayments), coins: number(value.coins), historyComplete: value.historyComplete === true, distributedBasis: 'quote_sent' };
}

// A defensive whitelist protects downloads even if a future endpoint adds
// private operational fields. Recipient identities and arbitrary errors stay absent.
export function safeHolderRewardDiagnostics(value) {
  if (value?.version !== 1 || !stamp(value.generatedAt) || !Array.isArray(value.launches)) throw Error('Invalid diagnostics report.');
  return { version: 1, generatedAt: value.generatedAt, inventoryComplete: value.inventoryComplete === true,
    storesRead: number(value.storesRead), storesUnavailable: number(value.storesUnavailable), holderLaunches: number(value.holderLaunches), includedLaunches: number(value.includedLaunches),
    evidence: 'saved-confirmed-payout-journals', liveChainVerified: false,
    holders: holderTotals(value.holders),
    platforms: list(value.platforms).filter(row => ['raydium','meteora'].includes(row?.id)).slice(0, 2).map(row => ({ id: row.id, inventoryComplete: row.inventoryComplete === true, holders: holderTotals(row.holders) })),
    launches: value.launches.slice(0, 10000).map(row => ({ mint: address(row?.mint), symbol: symbol(row?.symbol),
      quote: { mint: address(row?.quote?.mint), symbol: symbol(row?.quote?.symbol), decimals: decimals(row?.quote?.decimals) }, platforms: platformIds(row?.platforms),
      sourceWallet: address(row?.sourceWallet), includedInAnalytics: row?.includedInAnalytics === true,
      excludedLaunchReasons: list(row?.excludedLaunchReasons).map(reason), journalCopies: number(row?.journalCopies), retainedOperations: number(row?.retainedOperations),
      payoutStates: Object.fromEntries(['confirmed','pending','failed','expired','other'].map(key => [key, number(row?.payoutStates?.[key])])),
      serviceEvidence: list(row?.serviceEvidence).slice(0, 10).map(safeServiceEvidence), omittedServiceEvidence: number(row?.omittedServiceEvidence), serviceEvidenceUnavailable: row?.serviceEvidenceUnavailable === true,
      historyFlags: list(row?.historyFlags).map(reason), omittedCycleEvidence: number(row?.omittedCycleEvidence),
      cycleEvidence: list(row?.cycleEvidence).slice(0, 10).map(cycle => ({ lastDistributionAt: stamp(cycle?.lastDistributionAt), lastCycleQuoteUnits: units(cycle?.lastCycleQuoteUnits), currentCycleQuoteUnits: units(cycle?.currentCycleQuoteUnits) })),
      analytics: row?.analytics ? { historyComplete: row.analytics.historyComplete === true, countedPayouts: number(row.analytics.countedPayouts), recoveredPayoutAmounts: number(row.analytics.recoveredPayoutAmounts),
        countedQuoteUnits: units(row.analytics.countedQuoteUnits), countedQuoteAmount: amount(row.analytics.countedQuoteAmount),
        reasons: Object.fromEntries(Object.entries(row.analytics.reasons || {}).filter(([key]) => codes.has(key)).map(([key, count]) => [key, number(count)])),
        transactions: list(row.analytics.transactions).slice(0, 50).map(tx => ({ signature: signature(tx?.signature), slot: stamp(tx?.slot), counted: tx?.counted === true, reason: reason(tx?.reason) })),
        omittedTransactions: number(row.analytics.omittedTransactions) } : null,
    })), omittedLaunches: Math.max(0, value.launches.length - 10000),
    note: 'Read-only retained history diagnostics. Combined totals use the public analytics reducer across the listed platforms. Wallets are distinct recipient addresses, not users; do not add per-platform wallet counts together. USD uses current cached quote prices, not historical payout prices. Cycle counters are individual cycles, not lifetime totals. Saved receipts are not reverified onchain by this report. Service evidence describes saved Raydium wallet and retry states; credits and gas reservations are not live wallet balances. Thresholds are saved references, not current valuations. Error text includes only recognized local messages and bounded simulation fields; arbitrary provider details are omitted. Handoffs and deferred amounts are saved evidence. Meteora service state is unavailable in this report. This report does not pay, retry or change rewards.' };
}

export function createAdminRewardDiagnostics({ document, window = document?.defaultView, api, getAccount = () => null, isActive = () => true, downloadFile } = {}) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node; };
  const element = el('details', '', 'admin-card'); element.id = 'admin-reward-diagnostics'; element.hidden = true;
  const button = el('button', 'Download reward diagnostics', 'small-button'); button.type = 'button'; button.id = 'admin-reward-diagnostics-download';
  const status = el('p', '', 'help'); status.setAttribute('role', 'status');
  element.append(el('summary', 'Holder reward status and history'), el('p', 'Download reward wallet addresses, saved pause and retry reasons across all retained Raydium holder launches, plus Raydium and Meteora payout history and coverage gaps.', 'help'), button, status);
  let revision = 0, closed = false, busy = false, controller = null, identity = null;
  const permitted = () => { const account = getAccount(); return !closed && account?.role === 'admin' && account.mfaEnabled === true && !account.banned && typeof account.id === 'string' && isActive(); };
  const current = (version, actor) => permitted() && revision === version && getAccount().id === actor;
  function stop() { revision++; controller?.abort(); controller = null; busy = false; button.disabled = false; status.textContent = ''; }
  function clear() { stop(); identity = null; element.hidden = true; }
  function load() { if (!permitted()) { clear(); return; } if (identity !== getAccount().id) stop(); identity = getAccount().id; element.hidden = false; }
  function pause() { stop(); }
  const save = downloadFile || (file => {
    const blob = new window.Blob([file.contents], { type: file.type });
    const url = window.URL.createObjectURL(blob), link = document.createElement('a');
    try { link.href = url; link.download = file.name; document.body.append(link); link.click(); }
    finally { link.remove(); window.URL.revokeObjectURL(url); }
  });
  button.onclick = async () => {
    if (!permitted() || identity !== getAccount().id) { clear(); return; }
    if (busy) return;
    const version = revision, actor = identity; busy = true; button.disabled = true; status.textContent = 'Preparing report…'; controller = new AbortController();
    try {
      const result = await api('/api/admin/reward-diagnostics', undefined, { signal: controller.signal });
      if (!current(version, actor)) return;
      const report = safeHolderRewardDiagnostics(result), contents = JSON.stringify(report, null, 2) + '\n';
      if (!current(version, actor)) return;
      await save({ name: `Launchpad-Reward-Diagnostics-${new Date(report.generatedAt).toISOString().slice(0, 10)}.json`, type: 'application/json', contents });
      if (current(version, actor)) status.textContent = 'Report downloaded.';
    } catch { if (current(version, actor)) status.textContent = 'The report could not be downloaded. Try again.'; }
    finally { if (current(version, actor)) { busy = false; controller = null; button.disabled = false; } else if (revision === version && (!permitted() || getAccount()?.id !== actor)) clear(); }
  };
  function destroy() { clear(); closed = true; button.onclick = null; element.remove(); }
  return { element, load, pause, clear, destroy };
}
