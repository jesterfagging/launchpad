import { randomUUID, randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { Engine } from './engine.mjs';
import { Providers, prepareTransaction, verifySignedTransaction, transactionSize } from './providers.mjs';
import { SOL, SENDER_TIPS, invariant, tokenBalances, priorityPricing, decimal } from './core.mjs';
import { portfolioConfig, planInventory, netPlans, fraction, inventoryValue, valueOf, amountOf } from './portfolio-plan.mjs';
import { LiquidityAdapter, inspectMints } from './liquidity.mjs';
import { validatePlatformContext, platformFeePlan, preparePlatformFee, settlePlatformFee, verifyPlatformFee, recordPlatformFee } from './platform-fees.mjs';
const clone = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v));
const safeError = error => String(error?.message || 'Operation failed.').replace(/https?:\/\/\S+/g, '[provider]').slice(0, 250);

export class PortfolioEngine extends Engine {
  constructor(ledgers, providerFactory, adapterFactory = (p, signal) => new LiquidityAdapter(p, signal)) {
    super(ledgers, providerFactory); this.adapterFactory = adapterFactory; this.kind = 'market'; this.checking = false; this.prices = null; this.limitReservations = new Map();
  }
  status(viewMode) {
    const mode = this.state === 'stopped' && ['live','paper'].includes(viewMode) ? viewMode : this.c?.mode || 'paper';
    const viewLedger = this.ledgers[mode];
    return { state: this.state, mode, kind: this.kind, startupError: this.startupError, revision: this.revision,
      preset: this.c?.strategy?.preset, pool: this.pool || null, limits: this.c?.strategy?.limits || null,
      positions: viewLedger.data.lots.map(r => ({ ...r, balances: Object.entries(r.tokens).map(([mint, amount]) => ({ mint, amount: decimal(amount, r.decimals?.[mint] ?? this.decimals?.[mint] ?? (mint === SOL ? 9 : 0)) })) })),
      pending: viewLedger.data.pending.map(p => ({ signature: p.signature, wallet: p.wallet, kind: p.order.kind, createdAt: p.createdAt })),
      events: viewLedger.data.events, metrics: this.metrics, pricesAt: this.pricesAt || null,
      platformFees: this.runPlatformContext, feeReceipts: viewLedger.data.feeReceipts || [] };
  }
  async start(raw, kind) {
    invariant(this.state === 'stopped' && this.queues.size === 0, 'Stop the strategy before changing settings.');
    this.runPlatformContext = validatePlatformContext(this.platformContext);
    const c = portfolioConfig(raw, kind); this.c = c; this.kind = kind; this.ledger = this.ledgers[c.mode];
    this.state = 'starting'; this.abort = new AbortController(); this.startupError = null; this.prices = null; this.pool = null; this.withdrawOnly = false; this.claimOnly = false; this.activeIds = new Set(); this.limitReservations.clear();
    this.emit('change');
    try {
      this.p = this.providerFactory(c, (level, msg, details) => this.event(level, msg, details));
      await this.p.init(this.abort.signal);
      this.adapter = this.adapterFactory(this.p, this.abort.signal);
      const allMints = [...new Set([SOL, ...c.allocations.flatMap(a => [a.strategy.baseMint, a.strategy.quoteMint])])];
      const mintInfo = await inspectMints(this.adapter.connection, allMints, { routed: kind === 'market' });
      this.decimals = Object.fromEntries(Object.entries(mintInfo).map(([m, i]) => [m, i.decimals]));
      await this.reconcileAll(true);
      invariant(!this.ledger.data.pending.length, 'A previous transaction is unresolved. Start again after it is reconciled.');
      await this.refreshPrices();
      const prepared = [], pools = new Map();
      for (const allocation of c.allocations) {
        const w = c.wallets.find(w => w.publicKey === allocation.wallet), strategy = allocation.strategy, budget = allocation.budget;
        const old = this.ledger.data.lots.find(r => allocation.planId ? r.planId === allocation.planId : r.wallet === w.publicKey && !r.planId) || (allocation.planId && this.ledger.data.lots.find(r => !r.planId && !prepared.some(p => p.record.id === r.id) && r.wallet === w.publicKey && r.baseMint === strategy.baseMint && r.quoteMint === strategy.quoteMint && BigInt(r.budget) === budget));
        if (old) invariant(old.wallet === w.publicKey && old.kind === kind && old.baseMint === strategy.baseMint && old.quoteMint === strategy.quoteMint && BigInt(old.budget) === budget,
          'An existing allocation has a different wallet, pair or budget. Resume it unchanged, or withdraw and release it first.');
        let pool = null;
        if (kind === 'liquidity') {
          const key = JSON.stringify([old?.position?.id || strategy.pool, strategy.baseMint, strategy.quoteMint]);
          if (!pools.has(key)) pools.set(key, old?.position ? await this.adapter.inspect(old.position.id, strategy, w.publicKey) : await this.adapter.discover(strategy, w.publicKey));
          pool = pools.get(key); this.pool ||= pool;
        }
        const reserve = budget - fraction(budget, strategy.limits.deployPercent);
        invariant(old || reserve >= this.feeEstimate() + 10000000n, `${w.label}: raise the budget or lower fees; cash must cover fees and account rent.`);
        const record = old || { id: randomUUID(), planId: allocation.planId, label: allocation.label, kind, wallet: w.publicKey, walletLabel: w.label,
          baseMint: strategy.baseMint, quoteMint: strategy.quoteMint, decimals: this.decimals, budget: String(budget), tokens: { [SOL]: String(budget) },
          initialValue: String(valueOf(budget, SOL, this.prices, this.decimals)), initialized: false, fees: '0', turnover: '0', moves: 0, failures: 0, day: this.day(), createdAt: Date.now() };
        prepared.push({ record, old, strategy, pool, reserve, planId: allocation.planId, label: allocation.label });
      }
      invariant(kind !== 'liquidity' || this.ledger.data.lots.length + prepared.filter(p => !p.old).length <= 20, 'Maximum 20 managed LP allocations. Release an unused allocation first.');
      // All allocations in a wallet share one real balance; never allocate the
      // same funds twice when adding another pool, including stopped positions.
      if (c.mode === 'live') for (const w of c.wallets) {
        const required = new Map([[SOL, c.reserve]]);
        for (const r of [...this.ledger.data.lots.filter(r => r.wallet === w.publicKey), ...prepared.filter(p => !p.old && p.record.wallet === w.publicKey).map(p => p.record)])
          for (const [mint, amount] of Object.entries(r.tokens)) required.set(mint, (required.get(mint) || 0n) + BigInt(amount));
        for (const [mint, amount] of required) invariant(await this.p.balance(w.publicKey, mint, this.abort.signal) >= amount, `${w.label}: balance must cover all allocations in this wallet plus its reserve.`);
      }
      for (const { record: r, old, strategy, pool, reserve, planId, label } of prepared) {
        Object.assign(r, { planId, label, strategy, pool, cashReserve: String(reserve), paused: null, failures: 0 });
        if (!old) this.ledger.data.lots.push(r); this.activeIds.add(r.id);
      }
      invariant(!this.abort.signal.aborted, 'Stopped.');
      await this.ledger.save(); this.accepting = true; this.state = 'running';
      this.receiptTimer = setInterval(() => this.reconcileAll().catch(e => this.fatal(e)), 2000);
      this.pollTimer = setInterval(() => this.tick().catch(e => this.event('warn', safeError(e))), Math.min(...c.allocations.map(a => a.strategy.limits.pollSeconds)) * 1000);
      this.event('info', `${kind === 'market' ? 'Inventory rebalancing' : 'Liquidity management'} started with the ${c.strategy.preset} preset (${c.mode}).`);
      this.tick().catch(e => this.fatal(e));
    } catch (e) {
      const cancelled = this.abort.signal.aborted;
      this.accepting = false; this.abort.abort(); this.p?.close(); this.releaseKeys(); this.state = 'stopped'; this.startupError = cancelled ? null : safeError(e);
      this.event(cancelled ? 'info' : 'error', cancelled ? 'Strategy stopped.' : this.startupError); throw e;
    }
    return this.status();
  }
  day() { return new Date().toISOString().slice(0, 10); }
  feeEstimate() { return this.c.fees.priority + this.c.fees.jito + this.c.fees.helius + 15000n; }
  async refreshPrices() {
    const mints = [...new Set([SOL, ...(this.c.allocations || [{ strategy: this.c.strategy }]).flatMap(a => [a.strategy.baseMint, a.strategy.quoteMint])])];
    // Prices are a trigger/reference only; every actual trade also needs an
    // executable quote and an enforced minimum output.
    const data = await this.p.jupiterRequest(`/price/v3?ids=${mints.join(',')}`, 'Strategy prices', this.abort.signal);
    const prices = {}, blockTimes = new Map();
    for (const mint of mints) {
      const block = data?.[mint]?.blockId;
      invariant(Number.isSafeInteger(block) && data[mint].decimals === this.decimals[mint], 'Price response omitted a valid block or mint decimals.');
      if (!blockTimes.has(block)) blockTimes.set(block, await this.p.rpc('getBlockTime', [block], this.abort.signal));
      const at = blockTimes.get(block);
      invariant(Number.isSafeInteger(at) && Date.now() - at * 1000 <= 120000 && at * 1000 <= Date.now() + 10000, 'Token price is more than two minutes old. Waiting for a fresh reference.');
      const price = Number(data?.[mint]?.usdPrice);
      invariant(Number.isFinite(price) && price > 0 && price < 1e12, 'Fresh prices are unavailable for one of these mints. Strategy waits without trading.');
      prices[mint] = BigInt(Math.round(price * 1e12)); invariant(prices[mint] > 0n, 'Token price is below supported precision.');
    }
    this.prices = prices; this.pricesAt = Date.now();
  }
  record(wallet, id) { return this.ledger.data.lots.find(r => id ? r.id === id : r.wallet === wallet); }
  strategyFor(r) { return r.strategy || this.c.strategy; }
  activeRecords() { return this.ledger.data.lots.filter(r => this.activeIds?.has(r.id) || (!this.activeIds && this.c.wallets.some(w => w.publicKey === r.wallet))); }
  async tick() {
    if (!this.accepting || this.checking) return; this.checking = true;
    try {
      // Withdrawals are independent of the price feed. A missing token price
      // must not trap an already-open liquidity position.
      for (const r of this.activeRecords()) {
        const w = this.c.wallets.find(w => w.publicKey === r.wallet);
        if (r?.position && r.exiting === 'withdraw' && !r.paused && !this.queues.has(w.publicKey) && !this.ledger.data.pending.some(p => p.wallet === w.publicKey)) this.enqueue(w, () => this.executeLiquidity(r, w, true));
        if (r?.position && r.exiting === 'claimFees' && !r.paused && !this.queues.has(w.publicKey) && !this.ledger.data.pending.some(p => p.wallet === w.publicKey)) this.enqueue(w, () => this.executeFeeClaim(r, w, false));
      }
      if (this.claimOnly && !this.queues.size && !this.ledger.data.pending.length && this.activeRecords().every(r => r.exiting !== 'claimFees')) { this.stop(); return; }
      if (this.withdrawOnly) return;
      await this.refreshPrices();
      const plans = [];
      for (const r of this.activeRecords().sort((a, b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0))) {
        const w = this.c.wallets.find(w => w.publicKey === r.wallet), strategy = this.strategyFor(r); if (!r || r.paused || this.queues.has(w.publicKey) || this.ledger.data.pending.some(p => p.wallet === w.publicKey)) continue;
        if (Date.now() - (r.lastCheckedAt || 0) < strategy.limits.pollSeconds * 1000) continue;
        r.lastCheckedAt = Date.now();
        if (r.day !== this.day()) { r.day = this.day(); r.fees = '0'; r.turnover = '0'; r.moves = 0; }
        if (r.position) {
          const holdings = await this.adapter.positionAmounts(r.position, r.wallet);
          r.poolBalances = holdings;
          const lpValue = Object.entries(holdings).reduce((n, [mint, amount]) => n + valueOf(amount, mint, this.prices, this.decimals), 0n);
          if (inventoryValue(r, this.prices, this.decimals) + lpValue < fraction(BigInt(r.initialValue), 100 - strategy.limits.lossPercent)) { this.pause(r, 'Allocation loss limit reached. Withdraw is available; the position remains in the pool.'); continue; }
          if (r.exiting || (await this.adapter.outOfRange(r.position) && Date.now() - (r.lastTradeAt || 0) > strategy.limits.cooldownSeconds * 1000)) {
            if (!r.exiting && r.moves >= strategy.limits.maxMoves) { this.pause(r, 'Daily liquidity adjustment limit reached.'); continue; }
            r.exiting ||= 'rebalance'; this.enqueue(w, () => this.executeLiquidity(r, w, true));
          }
          else if (strategy.autoCompoundFees && !this.adapter.feesInReserves(r.position) && Date.now() - (r.lastFeeCheckAt || 0) >= 300000) {
            r.lastFeeCheckAt = Date.now(); await this.ledger.save(); this.enqueue(w, () => this.executeFeeClaim(r, w, true));
          }
          continue;
        }
        if (r.exiting === 'withdraw') { this.pause(r, 'Liquidity withdrawn; tokens are in this wallet.'); continue; }
        const current = inventoryValue(r, this.prices, this.decimals), floor = fraction(BigInt(r.initialValue), 100 - strategy.limits.lossPercent);
        if (current < floor) { this.pause(r, 'Allocation loss limit reached. Holdings remain in this wallet.'); continue; }
        let order = planInventory(r, strategy, this.prices, this.decimals);
        if (order) plans.push({ r, w, order });
        else if (!r.initialized) { r.initialized = true; await this.ledger.save(); }
        if (!order && r.initialized && this.kind === 'liquidity') {
          if (this.c.mode === 'paper') { if (!r.preview) { r.preview = true; this.event('paper', `${r.walletLabel}: inventory ready for ${r.pool.venue}. LP deposit is preview only in Paper mode.`); } }
          else this.enqueue(w, () => this.executeLiquidity(r, w, false));
        }
      }
      for (const { r, w, order } of (this.kind === 'market' ? netPlans(plans, this.c.strategy.baseMint, this.prices, this.decimals) : plans)) this.enqueue(w, () => this.executeSwap(r, w, order));
    } finally { this.checking = false; this.emit('change'); }
  }
  pause(r, reason) { if (r.paused === reason) return; r.paused = reason; this.event('warn', `${r.walletLabel}: ${reason}`); this.ledger.save().catch(e => this.fatal(e)); }
  async limits(r, costValue = 0n, platformFeeSol = 0n, checkBalances = true) {
    invariant(this.accepting && !this.abort.signal.aborted, 'Stopped.');
    invariant(this.prices && Date.now() - this.pricesAt < 60000, 'Price reference expired; waiting for the next check.');
    const l = this.strategyFor(r).limits;
    const records = this.kind === 'market' ? this.activeRecords() : [r];
    for (const row of records) if (row.day !== this.day()) { row.day = this.day(); row.fees = '0'; row.turnover = '0'; row.moves = 0; }
    const ids = new Set(records.map(row => row.id)), pending = this.ledger.data.pending.filter(p => ids.has(p.order.recordId));
    const pendingIds = new Set(pending.map(p => p.order.recordId));
    const reservations = [...this.limitReservations].filter(([id]) => ids.has(id) && id !== r.id && !pendingIds.has(id)).map(([, v]) => v);
    const budget = records.reduce((n, row) => n + BigInt(row.budget), 0n);
    const usedFees = records.reduce((n, row) => n + BigInt(row.fees), 0n) + pending.reduce((n, p) => n + BigInt(p.order.estimatedFee || 0), 0n) + reservations.reduce((n, v) => n + v.fee, 0n);
    const usedTurnover = records.reduce((n, row) => n + BigInt(row.turnover), 0n) + pending.reduce((n, p) => n + BigInt(p.order.turnover || 0), 0n) + reservations.reduce((n, v) => n + v.turnover, 0n);
    const estimate = this.feeEstimate() + platformFeeSol, turnoverSol = amountOf(costValue, SOL, this.prices, this.decimals);
    invariant(usedFees + estimate <= fraction(budget, l.feePercent), 'Daily strategy fee budget reached.');
    invariant(usedTurnover + turnoverSol <= fraction(budget, l.turnoverMultiple * 100), 'Daily strategy turnover limit reached.');
    this.limitReservations.set(r.id, { fee: estimate, turnover: turnoverSol });
    if (checkBalances && this.c.mode === 'live') for (const [mint, amount] of Object.entries(r.tokens)) {
      const actual = await this.p.balance(r.wallet, mint, this.abort.signal);
      invariant(actual >= BigInt(amount) + (mint === SOL ? this.c.reserve : 0n), 'Wallet balance is below its allocation or reserve. Check external transfers before resuming.');
    }
    return turnoverSol;
  }
  async executeSwap(r, w, plan) {
    try {
      // LP inventory preparation is included in the management service. Its
      // swaps never receive an additional market-making platform charge.
      const feePlan = this.kind === 'market' ? platformFeePlan(this.runPlatformContext, 'market', plan.inputMint, plan.amount, w.publicKey) : null;
      const feeSol = feePlan ? amountOf(valueOf(BigInt(feePlan.chargedAmount), plan.inputMint, this.prices, this.decimals), SOL, this.prices, this.decimals) : 0n;
      const turnover = await this.limits(r, valueOf(plan.amount, plan.inputMint, this.prices, this.decimals), feeSol);
      const strategy = this.strategyFor(r);
      const order = { ...plan, estimatedFee: String(this.feeEstimate() + feeSol), slippageBps: Math.floor(strategy.limits.slippagePercent * 100), maxPriceImpact: strategy.limits.impactPercent, kind: 'rebalance', recordId: r.id, receivedAt: Date.now(), observedAt: performance.now(), amount: String(plan.amount), turnover: String(turnover), signalSource: 'strategy', priceExpiresAt: this.pricesAt + 60000 };
      const fee = await preparePlatformFee(feePlan, this.p, this.abort.signal, { paper: this.c.mode === 'paper', order });
      order.platformFee = fee.plan; order.platformFeeSol = String(feeSol);
      const routeOrder = { ...order, amount: fee.plan ? BigInt(fee.plan.swapAmount) : plan.amount };
      let build = await this.p.jupiterBuild(routeOrder, w, this.abort.signal);
      order.requestedAt = order.receivedAt; order.receivedAt = order.routeQuotedAt = Date.now();
      routeOrder.receivedAt = order.receivedAt; routeOrder.routeQuotedAt = order.routeQuotedAt;
      build = await settlePlatformFee(build, fee, this.p, routeOrder, w, this.abort.signal);
      order.platformFee = fee.plan;
      const settledFeeSol = fee.plan?.mint === SOL ? BigInt(fee.plan.chargedAmount) : fee.plan ? feeSol : 0n;
      order.platformFeeSol = String(settledFeeSol);
      order.estimatedFee = String(this.feeEstimate() + settledFeeSol);
      // The executable conversion can differ from the reference price. Replace
      // the reservation with its actual SOL charge before signing or sending.
      await this.limits(r, valueOf(plan.amount, plan.inputMint, this.prices, this.decimals), settledFeeSol);
      const inputValue = valueOf(routeOrder.amount, plan.inputMint, this.prices, this.decimals), outValue = valueOf(BigInt(build.otherAmountThreshold), plan.outputMint, this.prices, this.decimals);
      invariant(outValue >= fraction(inputValue, 100 - strategy.limits.impactPercent - strategy.limits.slippagePercent), 'Executable quote is too far below the price reference.');
      if (r.initialized) invariant(turnover > (this.feeEstimate() + settledFeeSol) * 10n, 'Adjustment is too small relative to fees.');
      const prepared = await prepareTransaction(build, routeOrder, w, this.c, this.p, this.abort.signal);
      order.routeName = 'Jupiter'; order.minOutput = String(prepared.build.otherAmountThreshold);
      const paperDeltas = { [plan.inputMint]: -plan.amount, [plan.outputMint]: BigInt(prepared.build.outAmount) };
      paperDeltas[SOL] = (paperDeltas[SOL] || 0n) - this.feeEstimate();
      await this.sendPrepared(r, w, order, prepared.transaction.tx, prepared.transaction.lastValidBlockHeight, [], paperDeltas);
    } catch (e) { this.operationError(r, e); } finally { this.limitReservations.delete(r.id); }
  }
  async executeLiquidity(r, w, withdrawing) {
    const strategy = this.strategyFor(r), pool = r.pool || this.pool;
    try {
      if (!withdrawing) await this.limits(r);
      else invariant(this.accepting, 'Stopped.');
      invariant(this.c.mode === 'live', 'Liquidity deposits require Live mode. Paper mode previews pool selection and inventory swaps only.');
      let managementFee = null;
      // A multi-transaction withdrawal is one adjustment. Charge its full
      // pre-withdrawal position value only on the first confirmed slice.
      if (withdrawing && r.exiting === 'rebalance' && !r.position?.managementFeeCharged && this.runPlatformContext) {
        invariant(this.prices && Date.now() - this.pricesAt < 60000, 'A fresh price reference is required for an automatic management fee. Manual withdrawal remains available.');
        const tier = await this.adapter.feeTier(pool), holdings = await this.adapter.positionAmounts(r.position, r.wallet);
        const value = Object.entries(holdings).reduce((sum, [mint, amount]) => sum + valueOf(amount, mint, this.prices, this.decimals), 0n);
        const positionSol = amountOf(value, SOL, this.prices, this.decimals);
        invariant(positionSol > 0n, 'Position value is unavailable for this automatic adjustment. Manual withdrawal remains available.');
        const plan = platformFeePlan({ ...this.runPlatformContext, liquidityPpm: tier.managementFeePpm }, 'liquidity', SOL, positionSol, w.publicKey);
        const charge = BigInt(plan?.chargedAmount || 0);
        invariant(BigInt(r.tokens[SOL] || 0) >= charge + this.feeEstimate(), 'Allocation cash cannot cover the management fee and network fees. Manual withdrawal remains available.');
        invariant(BigInt(r.fees) + charge + this.feeEstimate() <= fraction(BigInt(r.budget), strategy.limits.feePercent), 'Management fee exceeds the daily fee budget. Manual withdrawal remains available.');
        managementFee = await preparePlatformFee(plan && { ...plan, basis: 'position-value-sol', poolFeePpm: tier.poolFeePpm }, this.p, this.abort.signal);
      }
      const amounts = { ...r.tokens };
      if (!withdrawing) amounts[SOL] = String(BigInt(amounts[SOL] || 0) > BigInt(r.cashReserve) ? BigInt(amounts[SOL] || 0) - BigInt(r.cashReserve) : 0n);
      const build = await this.adapter.build(pool, w, amounts, strategy, withdrawing ? r.position : null);
      const tables = [];
      for (const id of build.lookupTables) { const table = await this.adapter.connection.getAddressLookupTable(new PublicKey(id)); if (table.value) tables.push(table.value); }
      await this.p.refreshBlockhash(this.abort.signal);
      const blockhash = this.p.blockhash, payer = new PublicKey(w.publicKey);
      const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: this.c.computeUnits }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityPricing(this.c.fees.priority, this.c.computeUnits).microLamports }),
        ...(managementFee?.instructions || []), ...build.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId))];
      if (this.c.sendJito) { invariant(this.p.jitoTips.length, 'Jito tip accounts unavailable.'); instructions.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(this.p.jitoTips[randomInt(this.p.jitoTips.length)]), lamports: this.c.fees.jito })); }
      if (this.c.sendHelius) instructions.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(SENDER_TIPS[randomInt(SENDER_TIPS.length)]), lamports: this.c.fees.helius }));
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash.blockhash, instructions }).compileToV0Message(tables));
      invariant(transactionSize(tx.message) <= 1232, 'Liquidity transaction is too large with these tips. Reduce enabled relay tips or use a smaller range. Nothing was submitted.');
      const order = { kind: withdrawing ? 'withdraw' : 'deposit', routeName: pool.venue, recordId: r.id, receivedAt: Date.now(), position: build.position,
        maxInputs: build.maxInputs, partial: build.partial === true, turnover: '0',
        managementFeeCharged: managementFee !== null, platformFee: managementFee?.plan || null, platformFeeSol: managementFee?.plan?.chargedAmount || '0' };
      await this.sendPrepared(r, w, order, tx, blockhash.lastValidBlockHeight, build.signers);
    } catch (e) { this.operationError(r, e); } finally { this.limitReservations.delete(r.id); }
  }
  operationError(r, e) { if (!this.accepting) return; r.failures++; this.event('error', `${r.walletLabel}: ${safeError(e)}`); if (r.failures >= 3) this.pause(r, 'Paused after three failed operations. Review activity, then Stop and Start to retry.'); }
  async sendFeeInstructions(r, w, build, order) {
    if (order.kind !== 'lp-claim' || order.compound) await this.limits(r);
    else invariant(this.accepting && !this.abort.signal.aborted, 'Stopped.');
    const tables = [];
    for (const id of build.lookupTables || []) { const table = await this.adapter.connection.getAddressLookupTable(new PublicKey(id)); if (table.value) tables.push(table.value); }
    await this.p.refreshBlockhash(this.abort.signal);
    const blockhash = this.p.blockhash, payer = new PublicKey(w.publicKey);
    const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: this.c.computeUnits }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityPricing(this.c.fees.priority, this.c.computeUnits).microLamports }), ...build.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId))];
    if (this.c.sendJito) { invariant(this.p.jitoTips.length, 'Jito tip accounts unavailable.'); instructions.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(this.p.jitoTips[randomInt(this.p.jitoTips.length)]), lamports: this.c.fees.jito })); }
    if (this.c.sendHelius) instructions.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(SENDER_TIPS[randomInt(SENDER_TIPS.length)]), lamports: this.c.fees.helius }));
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash.blockhash, instructions }).compileToV0Message(tables));
    invariant(transactionSize(tx.message) <= 1232, 'This fee operation is too large with the current relay tips. Reduce tips or use a smaller position range. Nothing was submitted.');
    await this.sendPrepared(r, w, { ...order, recordId: r.id, routeName: r.position.venue, receivedAt: Date.now(), maxInputs: build.maxInputs, feeMaximums: build.feeMaximums, partial: build.partial, turnover: '0', platformFeeSol: '0' }, tx, blockhash.lastValidBlockHeight, build.signers || []);
  }
  async executeFeeClaim(r, w, compound) {
    try {
      if (this.adapter.feesInReserves(r.position)) { r.exiting = null; this.event('info', 'This pool already retains fees in its LP reserves. Withdraw liquidity to realize them.'); await this.ledger.save(); return; }
      if (compound) {
        const fees = await this.adapter.feeAmounts(r.position), amounts = { ...fees };
        for (const [mint, n] of Object.entries(r.feeCredits || {})) amounts[mint] = String(BigInt(amounts[mint] || 0) + BigInt(n));
        const feeValue = Object.entries(amounts).reduce((n, [mint, a]) => n + valueOf(a, mint, this.prices, this.decimals), 0n);
        if (feeValue < valueOf(this.feeEstimate() * 50n, SOL, this.prices, this.decimals)) return;
      }
      const build = await this.adapter.buildFeeClaim(r.position, w);
      if (build) await this.sendFeeInstructions(r, w, build, { kind: 'lp-claim', compound });
      else if (!compound) { r.exiting = null; this.event('info', 'No claimable fees on this LP position yet.', { wallet: r.wallet }); await this.ledger.save(); }
      if (!compound || this.ledger.data.pending.some(p => p.wallet === w.publicKey)) return;
      r.feeCredits ||= {};
      const [base, quote] = [r.baseMint, r.quoteMint], baseValue = valueOf(r.feeCredits[base] || 0, base, this.prices, this.decimals), quoteValue = valueOf(r.feeCredits[quote] || 0, quote, this.prices, this.decimals), half = (baseValue + quoteValue) / 2n;
      const inputMint = baseValue > half ? base : quote, outputMint = inputMint === base ? quote : base, difference = (baseValue > half ? baseValue : quoteValue) - half;
      const amount = amountOf(difference, inputMint, this.prices, this.decimals), credit = BigInt(r.feeCredits[inputMint] || 0);
      if (amount && amount <= credit && difference > valueOf(this.feeEstimate() * 10n, SOL, this.prices, this.decimals)) await this.executeSwap(r, w, { inputMint, outputMint, amount, feeCompound: true, funding: true, reason: 'Balance earned LP fees for reinvestment' });
      if (!this.accepting || r.paused || this.ledger.data.pending.some(p => p.wallet === w.publicKey)) return;
      const reinvest = await this.adapter.buildFeeCompound(r.position, w, r.feeCredits, this.strategyFor(r));
      if (reinvest) await this.sendFeeInstructions(r, w, reinvest, { kind: 'lp-compound' });
    } catch (error) { this.operationError(r, error); }
    finally { this.limitReservations.delete(r.id); }
  }
  async sendPrepared(r, w, order, tx, height, signers, paperDeltas = {}) {
    if (!this.accepting) return;
    const checkQuote = () => { if (order.routeQuotedAt) invariant(Date.now() <= Math.min(order.routeQuotedAt + this.c.maxSignalAgeMs, order.priceExpiresAt ?? Infinity), 'Strategy quote expired before signing. Nothing was submitted.'); };
    checkQuote();
    if (this.c.mode === 'paper') {
      await this.applyDeltas({ wallet: w.publicKey, signature: `paper-${randomUUID()}`, order, createdAt: Date.now() }, paperDeltas, this.feeEstimate() + BigInt(order.platformFeeSol || 0), true); return;
    }
    const solBefore = await this.p.balance(w.publicKey, SOL, this.abort.signal);
    const sim = await this.p.rpc('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [w.publicKey] } }], this.abort.signal);
    invariant(sim?.value && sim.value.err === null, `Simulation failed: ${JSON.stringify(sim?.value?.err || 'missing result').slice(0, 120)}. Nothing was submitted.`);
    const post = sim.value.accounts?.[0]?.lamports;
    invariant(Number.isSafeInteger(post) && solBefore - BigInt(post) <= BigInt(r.tokens[SOL] || 0), 'Simulation would spend SOL outside the allocated budget. Nothing was submitted.');
    invariant(this.accepting && !this.abort.signal.aborted, 'Stopped.');
    checkQuote();
    tx.sign([w.keypair, ...signers]);
    const bytes = tx.serialize(), additionalSigners = signers.map(s => s.publicKey.toBase58()), { signature } = verifySignedTransaction(bytes, w.publicKey, additionalSigners);
    order.relayFees = String(this.c.fees.jito + this.c.fees.helius);
    const pending = { wallet: w.publicKey, walletLabel: w.label, signature, signatureVerified: true, additionalSigners, order: clone(order), lastValidBlockHeight: height, createdAt: Date.now(), relayAttempts: [] };
    this.ledger.data.pending.push(pending); await this.ledger.save();
    if (!this.accepting) { this.ledger.data.pending = this.ledger.data.pending.filter(p => p !== pending); await this.ledger.save(); return; }
    this.transmissions.set(signature, { bytes, attempts: 0, lastSentAt: 0, inFlight: false }); this.broadcast(pending);
    this.event('info', `${order.kind} submitted; awaiting confirmation.`, { signature, wallet: w.publicKey });
    const until = Date.now() + this.receiptWaitMs;
    while (this.ledger.data.pending.includes(pending) && Date.now() < until) { await this.reconcileAll(); if (this.ledger.data.pending.includes(pending)) await delay(250); }
  }
  async reconcileTransaction(pending, tx) {
    if (!tx?.meta) return;
    if (tx.meta.err) return this.failOnChain(pending, tx.meta.err, tx);
    const platformReceipt = verifyPlatformFee(pending, tx);
    const r = this.ledger.data.lots.find(r => r.id === pending.order.recordId); invariant(r, 'Transaction allocation is missing.');
    const balances = tokenBalances(tx, pending.wallet), deltas = {};
    for (const mint of new Set([r.baseMint, r.quoteMint])) if (mint !== SOL) deltas[mint] = balances.find(b => b.mint === mint)?.delta || 0n;
    const keys = tx.transaction?.message?.accountKeys || [], index = keys.findIndex(k => (k.pubkey || k).toString() === pending.wallet);
    invariant(index >= 0 && Number.isSafeInteger(tx.meta.preBalances[index]) && Number.isSafeInteger(tx.meta.postBalances[index]), 'RPC omitted exact native balances.');
    deltas[SOL] = BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index]);
    const o = pending.order;
    if (o.kind === 'rebalance') {
      if (o.outputMint !== SOL) invariant(deltas[o.outputMint] >= BigInt(o.minOutput), 'Confirmed output below minimum; allocation stays paused.');
      if (o.inputMint !== SOL) invariant(deltas[o.inputMint] < 0n && -deltas[o.inputMint] <= BigInt(o.amount), 'Unexpected confirmed input debit.');
    } else if (o.kind === 'deposit' || o.kind === 'lp-compound') {
      if (o.kind === 'deposit') {
      if (o.position.lpMint) {
        const lp = balances.find(b => b.mint === o.position.lpMint)?.delta || 0n; invariant(lp > 0n, 'Deposit receipt has no LP-token credit.'); o.position.lpAmount = String(lp);
      } else invariant(o.position.position, 'Deposit omitted its position address.');
      }
      for (const [mint, max] of Object.entries(o.maxInputs)) if (mint !== SOL) invariant(-deltas[mint] <= BigInt(max), 'Deposit exceeded allocated inventory.');
    }
    const fee = BigInt(tx.meta.fee) + BigInt(o.relayFees || 0) + BigInt(o.platformFeeSol || 0);
    await this.applyDeltas(pending, deltas, fee, false, platformReceipt);
  }
  async applyDeltas(pending, deltas, fee, paper = false, platformReceipt = null) {
    if (!paper && !this.ledger.data.pending.some(p => p.signature === pending.signature)) return;
    const o = pending.order, r = this.ledger.data.lots.find(r => r.id === o.recordId); invariant(r, 'Allocation missing.');
    const next = { ...r.tokens };
    for (const [mint, delta] of Object.entries(deltas)) { const amount = BigInt(next[mint] || 0) + delta; invariant(amount >= 0n, 'Receipt exceeds allocated funds; wallet stays paused for reconciliation.'); next[mint] = String(amount); }
    const feeCredits = { ...r.feeCredits }, claimed = { ...r.claimedFees };
    if (o.kind === 'lp-claim' || o.kind === 'lp-compound' || o.feeCompound) {
      for (const mint of new Set([r.baseMint, r.quoteMint])) {
        const delta = (deltas[mint] || 0n) + (mint === SOL ? fee : 0n);
        if (o.kind === 'lp-claim') {
          invariant(o.feeMaximums?.[mint] !== undefined, 'Claim receipt is missing its quoted fee amounts.');
          const received = delta > 0n ? delta : 0n, maximum = BigInt(o.feeMaximums[mint]);
          // A wrapped-SOL account closure can also return pre-existing funds or
          // rent. Only the quoted LP earnings may become reinvestment credits.
          const earned = received < maximum ? received : maximum;
          claimed[mint] = String(BigInt(claimed[mint] || 0) + earned);
          if (o.compound) feeCredits[mint] = String(BigInt(feeCredits[mint] || 0) + earned);
          const kept = BigInt(next[mint] || 0) - received + (o.compound ? earned : 0n);
          invariant(kept >= 0n, 'The allocation cannot cover claim network costs.'); next[mint] = String(kept);
        } else {
          let tracked = delta;
          if (o.feeCompound) {
            if (mint === o.inputMint) tracked = -BigInt(o.amount);
            else if (mint === o.outputMint) { const minimum = BigInt(o.minOutput); tracked = delta < minimum ? delta : minimum; }
          } else if (mint === SOL) {
            invariant(o.maxInputs?.[mint] !== undefined, 'Reinvestment receipt is missing its native input limit.');
            tracked = -BigInt(o.maxInputs[mint]);
          } else if (tracked > 0n) tracked = 0n;
          const credit = BigInt(feeCredits[mint] || 0) + tracked;
          invariant(credit >= 0n, 'Reinvestment exceeded the position’s tracked fee proceeds.');
          const surplus = delta > tracked ? delta - tracked : 0n, kept = BigInt(next[mint] || 0) - surplus;
          invariant(kept >= 0n, 'Reinvestment accounting exceeded its allocation.'); next[mint] = String(kept); feeCredits[mint] = String(credit);
        }
      }
      r.feeCredits = feeCredits; r.claimedFees = claimed;
      if (o.kind === 'lp-claim' && !o.compound && !o.partial) r.exiting = null;
      if (o.kind === 'lp-compound') r.lastCompoundedAt = Date.now();
    }
    r.tokens = next; r.fees = String(BigInt(r.fees) + fee); r.turnover = String(BigInt(r.turnover) + BigInt(o.turnover || 0)); r.failures = 0;
    r.lastTradeAt = Date.now();
    if (o.kind === 'rebalance') { r.lastDirection = o.direction; r.lastRatio = o.ratio; if (!o.funding) r.initialized = true; }
    if (o.kind === 'deposit') { r.feeCredits = {}; r.position = o.position; r.exiting = null; r.moves++; }
    if (o.kind === 'withdraw' && o.managementFeeCharged && r.position) r.position.managementFeeCharged = true;
    if (o.kind === 'withdraw' && !o.partial) { r.feeCredits = {}; r.position = null; delete r.poolBalances; r.initialized = false; if (r.exiting === 'withdraw') r.paused = 'Liquidity withdrawn; tokens are in this wallet.'; else r.exiting = null; }
    this.ledger.data.pending = this.ledger.data.pending.filter(p => p.signature !== pending.signature); this.transmissions.delete(pending.signature);
    recordPlatformFee(this.ledger, pending, platformReceipt, paper);
    this.ledger.data.trades++; this.metrics.confirmed++;
    this.event(paper ? 'paper' : 'confirmed', `${o.kind} ${paper ? 'simulated' : 'confirmed'}; allocation updated.`, { wallet: r.wallet, signature: pending.signature });
    await this.ledger.save(); this.emit('change');
  }
  async failReceipt(pending, message, details) { const r = this.record(pending.wallet, pending.order.recordId); await super.failReceipt(pending, message, details); if (r) this.pause(r, 'Transaction failed or expired. Review activity before restarting.'); }
  async failOnChain(pending, error, tx) {
    if (!this.ledger.data.pending.includes(pending)) return;
    if (!tx) tx = await this.p.transaction(pending.signature);
    if (!tx?.meta || !Number.isSafeInteger(tx.meta.fee)) return;
    const r = this.record(pending.wallet, pending.order.recordId), fee = BigInt(tx.meta.fee);
    invariant(r && BigInt(r.tokens[SOL] || 0) >= fee, 'Failed transaction fee exceeds its allocation; reconciliation required.');
    r.tokens[SOL] = String(BigInt(r.tokens[SOL]) - fee); r.fees = String(BigInt(r.fees) + fee);
    await this.failReceipt(pending, `Transaction failed on-chain: ${JSON.stringify(error).slice(0, 140)}. Network fee accounted for.`);
  }
  claimFees(selection, raw) { return this.positionOperation(selection, raw, 'claimFees'); }
  withdraw(selection, raw) { return this.positionOperation(selection, raw, 'withdraw'); }
  async positionOperation(selection, raw, operation) {
    const requested = typeof selection === 'object' ? selection : { wallet: selection };
    const matches = this.ledgers.live.data.lots.filter(r => r.wallet === requested.wallet && r.position && (!requested.id || r.id === requested.id));
    invariant(matches.length === 1, 'Choose the specific LP position to withdraw.');
    const target = matches[0], wallet = target.wallet;
    if (this.state === 'stopped') {
      this.claimOnly = operation === 'claimFees';
      invariant(raw?.mode === 'live', 'Choose Live mode and load the wallet key to withdraw a live position.');
      const r = target;
      const c = portfolioConfig({ ...raw, wallets: raw.wallets.filter(w => w.publicKey === wallet), liquidityPlans: [], strategy: { baseMint: r.baseMint, quoteMint: r.quoteMint, budgetSol: decimal(r.budget), pool: r.position.id, advanced: raw.strategy?.advanced === true } }, 'liquidity');
      const w = c.wallets.find(w => w.publicKey === wallet); invariant(w, 'Import the key for this position’s wallet.'); c.wallets = [w];
      this.c = c; this.kind = 'liquidity'; this.withdrawOnly = true; this.ledger = this.ledgers.live; this.pool = r.position; r.pool = r.position; this.activeIds = new Set([r.id]);
      this.runPlatformContext = validatePlatformContext(this.platformContext);
      this.abort = new AbortController(); this.state = 'starting'; this.startupError = null;
      try {
        this.p = this.providerFactory(c, (level, msg, details) => this.event(level, msg, details)); await this.p.init(this.abort.signal);
        this.adapter = this.adapterFactory(this.p, this.abort.signal);
        const mints = await inspectMints(this.adapter.connection, [SOL, r.baseMint, r.quoteMint]); this.decimals = Object.fromEntries(Object.entries(mints).map(([m, i]) => [m, i.decimals]));
        await this.reconcileAll(true); invariant(!this.ledger.data.pending.some(p => p.wallet === wallet), 'This wallet still has an unresolved transaction.');
        invariant(!this.abort.signal.aborted, 'Stopped.'); this.accepting = true; this.state = 'running';
        this.receiptTimer = setInterval(() => this.reconcileAll().catch(e => this.fatal(e)), 2000);
        this.pollTimer = setInterval(() => this.tick().catch(e => this.event('error', safeError(e))), 5000);
      } catch (e) { this.accepting = false; this.abort.abort(); this.p?.close(); this.releaseKeys(); this.state = 'stopped'; throw e; }
    }
    invariant(this.state === 'running' && this.kind === 'liquidity', 'Start Liquidity Management with this allocation before withdrawing.');
    const r = this.record(wallet, target.id), w = this.c.wallets.find(w => w.publicKey === wallet); invariant(r?.position && w, 'No managed liquidity position for this wallet.');
    this.activeIds?.add(r.id);
    r.paused = null; r.exiting = operation; await this.ledger.save(); this.tick().catch(e => this.fatal(e)); return this.status();
  }
  async release(id, mode) {
    if (['live','paper'].includes(mode) && this.state === 'stopped') this.ledger = this.ledgers[mode];
    invariant(this.state === 'stopped' && !this.ledger.data.pending.length, 'Stop and reconcile all transactions before releasing an allocation.');
    const r = this.ledger.data.lots.find(r => r.id === id); invariant(r && !r.position, 'Withdraw the liquidity position before releasing this allocation.');
    this.ledger.data.lots = this.ledger.data.lots.filter(r => r.id !== id); await this.ledger.save(); return this.status();
  }
}
