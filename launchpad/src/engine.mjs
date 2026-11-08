import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { SOL, validateConfig, chooseAmount, detectSwap, tokenBalances, ladderTarget, ladderAmount, invariant, short } from './core.mjs';
import { Providers, ProviderError, prepareTransaction, verifySignedTransaction } from './providers.mjs';
import { LaunchRouter } from './launches.mjs';
import { describeTradeFailure } from './trade-errors.mjs';
import { validatePlatformContext, platformFeePlan, preparePlatformFee, settlePlatformFee, verifyPlatformFee, recordPlatformFee } from './platform-fees.mjs';
import { manualSellGroups, refreshManualOutcome, validateManualTrade } from './manual-trades.mjs';
import { captureEntryCost, costBasisFromFill, summarizePositions } from './positions.mjs';
import { inventoryFingerprint, reconcileTrackedLots } from './position-sync.mjs';
import packageInfo from '../package.json' with { type: 'json' };

function publicError(error) { return String(error?.message || 'Operation failed.').replace(/https?:\/\/\S+/g, '[provider]').slice(0, 250); }
const copy = data => JSON.parse(JSON.stringify(data, (_, v) => typeof v === 'bigint' ? v.toString() : v));
const elapsed = since => Math.round(Math.max(0, performance.now() - since) * 10) / 10;

export class Engine extends EventEmitter {
  get platformFeeKind() { return 'copy'; }
  constructor(ledgers, providerFactory = (c, event) => new Providers(c, event)) {
    super(); this.ledgers = ledgers; this.ledger = ledgers.paper; this.providerFactory = providerFactory;
    this.state = 'stopped'; this.startupError = null; this.accepting = false; this.streamConnected = false; this.queues = new Map(); this.queueDepth = new Map();
    this.metrics = { detected: 0, submitted: 0, confirmed: 0, skipped: 0, detectionToSendMs: null, confirmationMs: null };
    this.incoming = new Set(); this.spend = new Map(); this.ladderLocks = new Set(); this.ladderFailures = new Map();
    this.receiptWaitMs = 20000; this.receiptIntervalMs = 1500;
    this.receiptPromise = null; this.receiptNextAt = 0; this.receiptFailures = 0; this.receiptWarningAt = 0; this.receiptHeight = null;
    this.transmissions = new Map();
    this.revision = 0; this.statusStreamId = randomUUID(); this.runId = null; this.receiptPrompted = false;
    this.manualInFlight = new Map(); this.lastManualId = null; this.manualOnly = false;
    this.platformContext = null; this.runPlatformContext = null;
    this.viewMode = 'live'; this.inventoryRefresh = { state: 'idle', at: null }; this.inventoryRefreshes = 0; this.inventoryPolling = false;
    this.inventorySaves = new Map();
  }
  emit(name, ...args) { if (name === 'change') this.revision = (this.revision || 0) + 1; return super.emit(name, ...args); }
  event(level, message, details = {}) {
    const item = { id: randomUUID(), at: Date.now(), level, message, ...details };
    this.ledger.addEvent(item); this.emit('change');
  }
  status(mode = this.c?.mode || this.viewMode || 'live') {
    const c = this.c, ledger = this.ledgers[mode] || this.ledger;
    const positionView = summarizePositions(ledger.data.lots, this.p?.market || new Map(), { feeReceipts: ledger.data.feeReceipts || [] });
    return {
      version: packageInfo.version, revision:this.revision, statusStreamId:this.statusStreamId, runId:this.runId, platform: process.platform, state: this.state, startupError: this.startupError, mode, streamConnected: this.streamConnected, stream: this.p?.streamInfo || null,
      manualOnly: this.manualOnly, manualResult: this.manualResult(ledger.data.manualRequests?.find(r => r.id === this.lastManualId) || null), inventoryRefresh: { ...this.inventoryRefresh },
      execution: c ? { simulateBeforeSend: c.simulateBeforeSend, fastPumpLogs: c.fastPumpLogs, mirrorFraction: c.mirrorFraction,
        sellMode:c.sellMode, slippagePercent:c.slippageBps/100, maxPriceImpactPercent:c.maxPriceImpact,
        maxSignalAgeMs:c.maxSignalAgeMs, rpcRequestsPerSecond:c.rpcRequestsPerSecond } : null,
      activeJobs: [...this.queueDepth.values()].reduce((a, b) => a + b, 0),
      followers: c?.wallets.map(w => ({ label: w.label, publicKey: w.publicKey, blocked: ledger.data.pending.some(p => p.wallet === w.publicKey) })) || [],
      leads: c?.leads || [], metrics: this.metrics, fees: c ? { priority: c.prioritySol, jito: c.jitoSol, helius: c.heliusSol } : null,
      positions: positionView.positions.map(l => ({ ...l, ladderPaused: (this.ladderFailures.get(l.id) || 0) >= 3 })),
      positionSummary: positionView.positionSummary,
      positionAdjustments: ledger.data.positionAdjustments || [],
      pending: ledger.data.pending.map(p => ({ signature: p.signature, wallet: p.wallet, kind: p.order.kind, createdAt: p.createdAt,
        signatureVerified: p.signatureVerified === true,
        lastValidBlockHeight: p.lastValidBlockHeight, order: p.order, acknowledgedAt: p.acknowledgedAt || null,
        broadcastAttempts: p.broadcastAttempts || 0, relayAttempts: p.relayAttempts || [], chainStatus: p.chainStatus || 'unknown',
        lastCheckedAt: p.lastCheckedAt || null, lastCheckError: p.lastCheckError || null })),
      platformFees: this.runPlatformContext, feeReceipts: ledger.data.feeReceipts || [],
      confirmationRetryAt: this.receiptFailures ? this.receiptNextAt : null, events: ledger.data.events,
    };
  }
  async start(raw, { manualOnly = false } = {}) {
    invariant(this.state === 'stopped' && this.queues.size === 0, 'Stop the current run before starting another.');
    const config = validateConfig(raw, { requireLeads: !manualOnly });
    this.runPlatformContext = validatePlatformContext(this.platformContext);
    if (config.runBudget > 0n) invariant(config.funding === 'sol', 'The SOL run budget applies to SOL-funded buys. Set it to zero when spending quote tokens.');
    this.c = config; this.ledger = this.ledgers[config.mode]; this.abort = new AbortController(); this.state = 'starting'; this.startupError = null; this.manualOnly = manualOnly; this.runId = randomUUID();
    this.receiptNextAt = 0; this.receiptFailures = 0; this.receiptWarningAt = 0; this.receiptHeight = null; this.receiptPrompted = false; this.transmissions.clear();
    this.incoming.clear(); this.spend.clear(); this.ladderFailures.clear(); this.metrics = { detected: 0, submitted: 0, confirmed: 0, skipped: 0, detectionToSendMs: null, confirmationMs: null };
    this.p = null;
    try {
      this.p = this.providerFactory(config, (level, message, details) => this.event(level, message, details));
      this.p.direct = new LaunchRouter(this.p);
      this.event('info', manualOnly ? 'Connecting to your RPC for the manual trade.' : 'Connecting to your RPC and transaction stream.');
      await this.p.init(this.abort.signal);
      if (this.abort.signal.aborted) throw new Error('Stopped.');
      await this.reconcileAll();
      if (this.abort.signal.aborted) throw new Error('Stopped.');
      await this.refreshInventory({ source: 'run-start' });
      if (this.abort.signal.aborted) throw new Error('Stopped.');
      this.accepting = true;
      if (!manualOnly) await this.p.subscribe(event => { this.onTransaction(event).catch(error => this.fatal(error)); }, connected => { this.streamConnected = connected; this.emit('change'); });
      if (!this.accepting || this.abort.signal.aborted) throw new Error('Stopped.');
      for (const pending of this.ledger.data.pending) this.watchReceipt(pending);
      this.state = 'running';
      if (!manualOnly) this.pollTimer = setInterval(() => this.pollMarkets().catch(error => this.event('warn', publicError(error))), config.marketPollMs);
      this.receiptTimer = setInterval(() => this.reconcileAll().catch(error => this.fatal(error)), this.receiptIntervalMs);
      if (!manualOnly && config.mode === 'live') this.inventoryTimer = setInterval(() => this.pollInventory(), 10000);
      this.event('info', manualOnly ? `Manual ${config.mode} trading ready; automatic copying remains stopped.` : `${config.mode === 'live' ? 'Live trading' : 'Paper trading'} started for ${config.leads.length} ${config.sniperMode ? 'developer(s)' : 'lead(s)'}, ${config.wallets.length} follower(s).`);
      if (!manualOnly && config.streamMode === 'logs') this.event(config.fastPumpLogs ? 'info' : 'warn', config.fastPumpLogs
        ? `Standard RPC fast logs active: supported Pump/SOL buys${config.mirrorFraction ? '' : ' and full exits'} read processed trade events directly. ${config.mirrorFraction ? 'Proportional sells and other routes' : 'Other routes'} use confirmed transaction data.`
        : 'Standard RPC logs mode waits for confirmed transactions and a separate RPC read. Enable fast Pump logs to bypass that read for supported trades.');
      this.event('info', config.simulateBeforeSend ? 'Pre-send RPC simulation enabled.' : 'Fast execution: optional RPC simulation disabled; balance checks, local signature verification and journaling remain enabled.');
      if (!manualOnly) this.pollMarkets().catch(() => {});
    } catch (error) {
      const cancelled = this.abort.signal.aborted || error?.message === 'Stopped.' || error?.name === 'AbortError';
      this.accepting = false; this.abort.abort();
      try { this.p?.close(); } catch {}
      clearInterval(this.pollTimer); clearInterval(this.receiptTimer); clearInterval(this.inventoryTimer);
      this.releaseKeys(); this.state = 'stopped'; this.streamConnected = false;
      this.startupError = cancelled ? null : publicError(error);
      const message = cancelled ? 'Run stopped.' : `Start failed. Run stopped. ${this.startupError}`;
      this.event(cancelled ? 'info' : 'error', message); throw new Error(message);
    }
    return this.status();
  }
  stop() {
    if (this.state === 'stopped' || this.state === 'stopping') return this.status();
    const wasStarting = this.state === 'starting';
    this.accepting = false; this.state = 'stopping'; this.abort?.abort(); this.p?.close(); this.streamConnected = false;
    clearInterval(this.pollTimer); clearInterval(this.receiptTimer); clearInterval(this.inventoryTimer);
    this.event('info', 'Stopped accepting trades. Already-broadcast transactions are being checked; holdings remain in your wallets.');
    if (!wasStarting) this.stopPromise = this.finishStop().catch(error => { this.state = 'stopped'; this.releaseKeys(); this.event('error', publicError(error)); });
    return this.status();
  }
  async finishStop() {
    await Promise.allSettled([...this.queues.values()]);
    await this.reconcileAll();
    this.transmissions.clear(); this.releaseKeys(); this.state = 'stopped'; await this.ledger.save(); this.emit('change');
  }
  releaseKeys() {
    // Drop references. JavaScript cannot guarantee erasure of immutable strings or prior heap copies.
    for (const w of this.c?.wallets || []) w.keypair = null;
  }
  persistInventory(ledger, changed) {
    // All wallets released from one batched read must resume together. Separate
    // save promises serialize their route starts and turn one RPC snapshot into
    // twenty. A write that overlaps later mutations loops before releasing any
    // waiter, so the common barrier also covers every pending ledger update.
    let entry = this.inventorySaves.get(ledger);
    if (entry) { entry.dirty ||= changed; return entry.promise; }
    entry = { dirty: changed };
    entry.promise = new Promise((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          while (entry.dirty) { entry.dirty = false; await ledger.save(); }
          resolve();
        } catch (error) { this.fatal(error); reject(error); }
        finally { if (this.inventorySaves.get(ledger) === entry) this.inventorySaves.delete(ledger); }
      });
    });
    this.inventorySaves.set(ledger, entry); return entry.promise;
  }
  async refreshInventory({ provider = this.p, signal = this.abort?.signal, mode = this.c?.mode || this.viewMode || 'paper',
    wallet = null, mint = null, source = 'wallet-refresh', allowBusy = false } = {}) {
    const ledger = this.ledgers[mode], report = { checked: 0, changed: 0, updated: 0, adjustments: [], skipped: 0 };
    const noop = () => {
      if (!this.inventoryRefreshes && this.inventoryRefresh.state === 'refreshing') { this.inventoryRefresh.state = 'idle'; this.emit('change'); }
      return report;
    };
    if (mode !== 'live' || !ledger || !provider?.trackedBalances || signal?.aborted) return noop();
    const initialRun = this.runId, initialState = this.state, externalProvider = provider !== this.p;
    if (externalProvider && initialState !== 'stopped') return noop();
    const current = () => !signal?.aborted && this.runId === initialRun && this.state !== 'stopping' &&
      (externalProvider ? this.state === 'stopped' : this.p === provider && this.state === initialState);
    const grouped = new Map();
    for (const lot of ledger.data.lots) {
      if ((lot.mode && lot.mode !== 'live') || BigInt(lot.remaining) <= 0n || (wallet && lot.wallet !== wallet) || (mint && lot.mint !== mint)) continue;
      if (ledger.data.pending.some(p => p.wallet === lot.wallet) || (!allowBusy && (this.queueDepth.get(lot.wallet) || 0) > 0)) { report.skipped++; continue; }
      const key = `${lot.wallet}:${lot.mint}`;
      if (!grouped.has(key)) {
        const related = ledger.data.lots.filter(l => (!l.mode || l.mode === 'live') && l.wallet === lot.wallet && l.mint === lot.mint);
        const ids = new Set(related.map(l => l.id));
        const eventSlots = ledger.data.events.filter(e => e.level === 'confirmed' && ids.has(e.signature)).map(e => e.followerSlot);
        const knownSlots = [...related.flatMap(l => [l.confirmedSlot, l.lastBalanceSlot]), ...eventSlots].filter(s => Number.isSafeInteger(s) && s >= 0);
        const minContextSlot = knownSlots.length ? Math.max(...knownSlots) : 0;
        grouped.set(key, { wallet: lot.wallet, mint: lot.mint, tracked: 0n, minContextSlot,
          signatures: related.filter(l => BigInt(l.remaining) > 0n && !Number.isSafeInteger(l.confirmedSlot) && !Number.isSafeInteger(l.lastBalanceSlot))
            .filter(l => !ledger.data.events.some(e => e.level === 'confirmed' && e.signature === l.id && Number.isSafeInteger(e.followerSlot))).map(l => l.id),
          fingerprint: inventoryFingerprint(ledger.data.lots, lot.wallet, lot.mint) });
      }
      grouped.get(key).tracked += BigInt(lot.remaining);
    }
    if (!grouped.size || !current()) return noop();
    this.inventoryRefreshes++; this.inventoryRefresh = { state: 'refreshing', at: this.inventoryRefresh.at, mode }; this.emit('change');
    try {
      const groups = [...grouped.values()];
      const results = await provider.trackedBalances(groups.map(({ fingerprint, ...group }) => group), signal);
      invariant(Array.isArray(results) && results.length === groups.length, 'RPC returned incomplete tracked-wallet balances.');
      const seen = new Set();
      const checked = results.map(row => {
        const key = `${row.wallet}:${row.mint}`, group = grouped.get(key), amount = BigInt(row.amount);
        invariant(group && !seen.has(key) && amount >= 0n && Number.isSafeInteger(row.slot) && row.slot >= group.minContextSlot &&
          (row.complete === true || (row.complete === false && amount >= group.tracked)), 'RPC returned an incomplete or stale tracked-wallet balance.');
        seen.add(key); return { ...row, amount, group };
      });
      if (!current()) { report.skipped += groups.length; return report; }
      for (const row of checked) {
        const group = row.group;
        if (ledger.data.pending.some(p => p.wallet === group.wallet) || (!allowBusy && (this.queueDepth.get(group.wallet) || 0) > 0) ||
          inventoryFingerprint(ledger.data.lots, group.wallet, group.mint) !== group.fingerprint) { report.skipped++; continue; }
        const adjustment = reconcileTrackedLots(ledger, { wallet: group.wallet, mint: group.mint, balance: row.amount, slot: row.slot, source });
        report.checked++;
        if (adjustment.changed) { report.changed++; if (adjustment.adjustment) report.adjustments.push(adjustment.adjustment); }
        if (adjustment.updated) report.updated++;
        if (adjustment.changed) ledger.addEvent({ id: randomUUID(), at: Date.now(), level: 'info',
          message: 'Tracked position updated to confirmed wallet holdings after an external balance change.',
          wallet: group.wallet, mint: group.mint, source, before: String(adjustment.before), after: String(adjustment.after), slot: row.slot });
      }
      await this.persistInventory(ledger, report.updated > 0);
      this.inventoryRefresh = { state: 'idle', at: report.checked ? Date.now() : this.inventoryRefresh.at, mode };
      return report;
    } catch (error) {
      if (!signal?.aborted) this.inventoryRefresh = { state: 'error', at: this.inventoryRefresh.at, mode, error: publicError(error) };
      throw error;
    } finally {
      this.inventoryRefreshes--;
      if (!this.inventoryRefreshes && this.inventoryRefresh.state === 'refreshing') this.inventoryRefresh.state = 'idle';
      this.emit('change');
    }
  }
  async pollInventory() {
    if (!this.accepting || this.inventoryPolling || [...this.queueDepth.values()].some(depth => depth > 0)) return;
    this.inventoryPolling = true; const controller = new AbortController(); this.inventoryPollAbort = controller;
    const signal = AbortSignal.any([this.abort.signal, controller.signal]);
    try { await this.refreshInventory({ source: 'background', signal }); }
    catch (error) {
      if (!signal.aborted && Date.now() - (this.inventoryWarningAt || 0) > 30000) {
        this.inventoryWarningAt = Date.now(); this.event('warn', `Wallet holdings refresh: ${publicError(error)}`);
      }
    } finally { this.inventoryPolling = false; if (this.inventoryPollAbort === controller) this.inventoryPollAbort = null; }
  }
  manualResult(record = this.ledger.data.manualRequests?.find(r => r.id === this.lastManualId)) {
    if (!record) return null;
    return copy({ id: record.id, side: record.request.side, mint: record.request.mint, mode: record.mode,
      state: record.state, createdAt: record.createdAt, completedAt: record.completedAt, outcomes: record.outcomes });
  }
  updateManualOrder(order, wallet, status, signature, error) {
    if (!order.manualRequestId) return;
    const request = this.ledger.data.manualRequests?.find(r => r.id === order.manualRequestId);
    const outcome = request?.outcomes.find(o => o.wallet === wallet);
    if (!outcome) return;
    const trade = outcome.trades.find(t => t.id === order.manualOrderId);
    if (!trade) return;
    Object.assign(trade, { status });
    if (signature) trade.signature = signature;
    if (error) trade.error = error; else delete trade.error;
    refreshManualOutcome(outcome);
    this.emit('change');
  }
  async manualTrade(raw, value) {
    const request = validateManualTrade(value), mode = raw?.mode;
    invariant(mode === 'live' || mode === 'paper', 'Choose live or paper mode before placing a manual trade.');
    const identity = JSON.stringify(request);
    const existing = Object.values(this.ledgers).flatMap(ledger => ledger.data.manualRequests || []).find(r => r.id === request.id);
    if (existing) {
      invariant(existing.mode === mode && JSON.stringify(existing.request) === identity, 'This manual request ID was already used for different trade settings.');
      if (existing.state !== 'complete' && !this.manualInFlight.has(request.id)) {
        // The previous process may have stopped after reserving the ID. Recover
        // its result, never its intent: unsigned work is not replayed on restart.
        existing.state = 'complete'; existing.completedAt = Date.now();
        for (const outcome of existing.outcomes) if (!outcome.trades.length) {
          outcome.status = 'skipped'; outcome.error = 'The previous session ended before this wallet submitted a transaction. Review positions before creating a new request.';
        }
        await this.ledgers[mode].save();
      }
      this.lastManualId = request.id;
      return { ...this.status(), manualResult: this.manualResult(existing) };
    }
    const oneShot = this.state === 'stopped';
    if (Object.hasOwn(value, 'expectedRunId')) invariant(value.expectedRunId === this.runId, 'The trading run changed. Review the manual trade again.');
    invariant(oneShot || (this.state === 'running' && !this.manualOnly), 'Wait for the current start, stop, or manual trade to finish.');
    invariant(!oneShot || this.manualInFlight.size === 0, 'Wait for the current manual trade to finish.');
    const c = oneShot ? validateConfig(copy(raw), { requireLeads: false }) : this.c;
    invariant(c.mode === mode, 'Manual trade mode must match the active copytrading run.');
    invariant(request.wallets.every(key => c.wallets.some(w => w.publicKey === key)), 'Manual trades can only use wallets imported into this copytrading run.');
    const ledger = this.ledgers[mode], key = `manual:${request.id}`;
    if (ledger.data.seen.includes(key)) {
      // Older/pruned request details must never turn an HTTP retry into a new order.
      return { ...this.status(), manualResult: { id: request.id, side: request.side, mint: request.mint, mode, state: 'complete',
        outcomes: request.wallets.map(wallet => ({ wallet, status: 'skipped', error: 'This request was already accepted. Check activity and pending transactions; it will not be repeated.' })) } };
    }
    const record = { id: request.id, request, mode, createdAt: Date.now(), state: 'preparing',
      outcomes: request.wallets.map(wallet => ({ wallet, status: 'skipped', error: 'Waiting to prepare this wallet. Nothing submitted yet.', trades: [] })) };
    (ledger.data.manualRequests ||= []).push(record);
    this.inventoryPollAbort?.abort();
    this.manualInFlight.set(request.id, record); this.lastManualId = request.id;
    this.emit('change');
    try {
      if (oneShot) await this.start(copy(raw), { manualOnly: true });
      invariant(this.accepting, 'Trading stopped before the manual trade was submitted.');
      await ledger.remember(key);
      invariant(this.accepting, 'Trading stopped before the manual trade was submitted.');
      record.state = 'executing';
      this.event('info', `Manual ${request.side} requested for ${request.wallets.length} wallet(s).`, { manualRequestId: request.id, mint: request.mint });
      // Market data is optional; it cannot delay, authorize, or alter the order.
      this.p.markets([request.mint, SOL], this.abort.signal).catch(() => {});
      const buyVenue = request.side === 'buy' ? this.ledger.data.lots.find(l => l.mint === request.mint && l.venue)?.venue
        || await this.p.direct?.discover?.(request.mint, this.abort.signal) || null : null;
      invariant(this.accepting, 'Trading stopped before the manual trade was submitted.');
      // Route requests share a paced queue. Direct routes can still batch RPC
      // reads; Jito-only batches serialize so signed transactions do not wait
      // behind twenty other submissions until their quotes have expired.
      const dispatch = async publicKey => {
        const wallet = this.c.wallets.find(w => w.publicKey === publicKey), outcome = record.outcomes.find(o => o.wallet === publicKey);
        const skipped = error => { outcome.status = 'skipped'; outcome.error = error; };
        await this.enqueue(wallet, async () => {
          let orders;
          if (request.side === 'buy') {
            const amount = BigInt(request.amount);
            if (this.c.runBudget > 0n) invariant((this.spend.get(publicKey) || 0n) + amount <= this.c.runBudget, 'Per-wallet SOL buy budget reached.');
            const venue = buyVenue;
            orders = [{ kind: 'buy', lead: 'manual', inputMint: SOL, inputDecimals: 9, outputMint: request.mint, amount, exitMint: venue?.quoteMint || SOL, venue }];
          } else {
            await this.refreshInventory({ wallet: publicKey, mint: request.mint, source: 'manual-sell', allowBusy: true });
            if (!this.accepting) { skipped('Trading stopped before the manual sell was submitted.'); return; }
            orders = manualSellGroups(ledger.data.lots, publicKey, request.mint, request.percent).map(group => ({
              kind: 'sell', lead: 'manual', inputMint: request.mint, outputMint: group.exitMint,
              amount: group.amount, allocations: group.allocations, venue: group.venue,
            }));
            if (!orders.length) { skipped('No tracked position for this token, or the selected percentage rounds to zero. Nothing was submitted.'); return; }
          }
          for (const order of orders) {
            Object.assign(order, { manualRequestId: request.id, manualOrderId: randomUUID(), signalSource: 'manual',
              observedAt: performance.now(), receivedAt: Date.now() });
            outcome.trades.push({ id: order.manualOrderId, status: 'skipped', error: 'Nothing was submitted.' });
            if (!this.accepting) { this.updateManualOrder(order, publicKey, 'skipped', null, 'Trading was stopped before this order executed.'); break; }
            if (ledger.data.pending.some(p => p.wallet === publicKey)) {
              this.updateManualOrder(order, publicKey, 'skipped', null, 'A previous transaction remains unresolved. No additional order was submitted.'); break;
            }
            try {
              await this.execute(order, wallet);
              refreshManualOutcome(outcome);
            } catch (error) {
              // A pending signature takes precedence over a transport exception.
              // Never clear it or sign a replacement as part of manual recovery.
              const pending = ledger.data.pending.find(p => p.order.manualOrderId === order.manualOrderId);
              this.updateManualOrder(order, publicKey, pending ? 'pending' : 'failed', pending?.signature, publicError(error));
              this.event('error', publicError(error), { wallet: publicKey, manualRequestId: request.id });
            }
          }
        }, { onSkipped: skipped, onError: error => { outcome.status = 'failed'; outcome.error = publicError(error); } });
      };
      if (this.c.sendJito && !this.c.sendRpc && !this.c.sendHelius) {
        for (const publicKey of request.wallets) await dispatch(publicKey);
      } else await Promise.allSettled(request.wallets.map(dispatch));
    } catch (error) {
      for (const outcome of record.outcomes) if (!outcome.trades.length) { outcome.status = 'failed'; outcome.error = publicError(error); }
      this.event('error', publicError(error), { manualRequestId: request.id });
    } finally {
      record.state = 'complete'; record.completedAt = Date.now();
      try { await ledger.save(); } catch (error) { this.fatal(error); throw error; }
      finally {
        if (oneShot && this.state !== 'stopped') { this.stop(); await this.stopPromise; }
        this.manualInFlight.delete(request.id); this.emit('change');
      }
    }
    return { ...this.status(), manualResult: this.manualResult(record) };
  }
  fatal(error) { this.event('error', publicError(error)); this.stop(); }
  async onTransaction(event) {
    if (!this.accepting || this.manualOnly || Date.now() - event.receivedAt > this.c.maxSignalAgeMs) return;
    for (const lead of this.c.leads) {
      const signal = event.decoded?.lead === lead ? { ...event.decoded } : detectSwap(event.tx, lead, this.p.knownPrograms);
      if (!signal) continue;
      const signalAt = performance.now();
      const key = `${event.signature}:${lead}`;
      if (this.incoming.has(key)) continue;
      this.incoming.add(key);
      if (this.incoming.size > 30000) this.incoming.delete(this.incoming.values().next().value);
      if (!(await this.ledger.remember(key)) || !this.accepting) continue;
      this.metrics.detected++;
      Object.assign(signal, { signature: event.signature, observedAt: event.observedAt, receivedAt: event.receivedAt, slot: event.slot, signalAt,
        fallbackReason: event.fallbackReason, confirmationWaitMs: event.confirmationWaitMs, transactionFetchMs: event.transactionFetchMs });
      const quotes = new Set(this.c.quoteMints);
      if (signal.venue) quotes.add(signal.venue.quoteMint);
      for (const lot of this.ledger.data.lots) if (lot.lead === lead) quotes.add(lot.exitMint);
      const isBuy = quotes.has(signal.inputMint) && !quotes.has(signal.outputMint);
      const isSell = !quotes.has(signal.inputMint) && quotes.has(signal.outputMint);
      if (this.c.sniperMode && isBuy) continue;
      if (!isBuy && !isSell) { this.metrics.skipped++; this.event('warn', `Ambiguous quote side skipped. Add the pair's quote mint in Pair settings.`, { lead, signature: event.signature }); continue; }
      this.event('signal', `Lead ${isBuy ? 'buy' : 'sell'} detected: ${short(isBuy ? signal.outputMint : signal.inputMint)}.${signal.fallbackReason ? ` Confirmed fallback: ${signal.fallbackReason}.` : signal.source === 'pump-processed-logs' ? ' Fast logs.' : ''}`, { lead, signature: event.signature,
        inputMint: signal.inputMint, outputMint: signal.outputMint, venue: signal.venue, source: signal.source || 'full-transaction', fallbackReason: signal.fallbackReason,
        confirmationWaitMs: signal.confirmationWaitMs, transactionFetchMs: signal.transactionFetchMs, notificationToSignalMs: Math.round((signalAt - event.observedAt) * 10) / 10 });
      if (isBuy) this.p.markets([signal.outputMint, signal.inputMint]).catch(() => {});
      for (const wallet of this.c.wallets) this.enqueue(wallet, async () => {
        if (Date.now() - signal.receivedAt > this.c.maxSignalAgeMs) { this.metrics.skipped++; this.event('warn', 'Stale trade skipped after waiting for this wallet.', { wallet: wallet.publicKey }); return; }
        if (isBuy) await this.buy(signal, wallet);
        else if (this.c.sellMode === 'mirror' || this.c.sellMode.startsWith('hybrid')) await this.mirrorSell(signal, wallet);
      });
    }
  }
  enqueue(wallet, task, { onSkipped = () => {}, onError = () => {} } = {}) {
    if (!this.accepting) { onSkipped('Trading is stopped. Nothing was submitted.'); return; }
    this.inventoryPollAbort?.abort();
    const key = wallet.publicKey, depth = this.queueDepth.get(key) || 0;
    if (depth >= 30) { this.metrics.skipped++; this.event('warn', 'Wallet queue is full; new signal skipped.', { wallet: key }); onSkipped('Wallet queue is full. Nothing was submitted.'); return; }
    this.queueDepth.set(key, depth + 1);
    const prior = this.queues.get(key) || Promise.resolve();
    const job = prior.catch(() => {}).then(async () => {
      if (!this.accepting) { onSkipped('Trading was stopped before this wallet executed.'); return; }
      if (this.ledger.data.pending.some(p => p.wallet === key)) { this.event('warn', 'Wallet paused while a previous transaction outcome is unresolved.', { wallet: key }); onSkipped('Wallet paused while a previous transaction outcome is unresolved.'); return; }
      await task();
    }).catch(error => { this.metrics.skipped++; this.event('error', publicError(error), { wallet: key }); onError(error); }).finally(() => {
      this.queueDepth.set(key, Math.max(0, (this.queueDepth.get(key) || 1) - 1));
      if (this.queues.get(key) === job) this.queues.delete(key);
      this.emit('change');
    });
    this.queues.set(key, job); return job;
  }
  async buy(signal, wallet) {
    const inputMint = this.c.funding === 'sol' ? SOL : (signal.venue?.quoteMint || signal.inputMint);
    let decimals = inputMint === SOL ? 9 : inputMint === signal.inputMint ? signal.inputDecimals : signal.quoteDecimals;
    if (decimals === undefined) decimals = (await this.p.rpc('getTokenSupply', [inputMint, { commitment: 'confirmed' }], this.abort.signal)).value.decimals;
    const amount = chooseAmount(this.c, wallet, decimals);
    invariant(amount > 0n, 'Buy size rounds to zero in this quote asset.');
    if (inputMint === SOL && this.c.runBudget > 0n) invariant((this.spend.get(wallet.publicKey) || 0n) + amount <= this.c.runBudget, 'Per-wallet SOL buy budget reached.');
    await this.execute({ kind: 'buy', lead: signal.lead, inputMint, inputDecimals: decimals, outputMint: signal.outputMint, outputDecimals: signal.outputDecimals,
      amount, exitMint: signal.venue?.quoteMint || inputMint, venue: signal.venue, leadSignature: signal.signature, slot: signal.slot, observedAt: signal.observedAt, receivedAt: signal.receivedAt, signalAt: signal.signalAt, signalSource: signal.source,
      fallbackReason: signal.fallbackReason, confirmationWaitMs: signal.confirmationWaitMs, transactionFetchMs: signal.transactionFetchMs }, wallet);
  }
  async mirrorSell(signal, wallet) {
    await this.refreshInventory({ wallet: wallet.publicKey, mint: signal.inputMint, source: 'lead-sell', allowBusy: true });
    if (!this.accepting) return;
    const lots = this.ledger.data.lots.filter(l => l.wallet === wallet.publicKey && l.lead === signal.lead && l.mint === signal.inputMint && BigInt(l.remaining) > 0n);
    if (!lots.length) { this.event('info', 'Lead sold a token with no copied position for this wallet.', { wallet: wallet.publicKey }); return; }
    const grouped = new Map();
    for (const lot of lots) {
      const remaining = BigInt(lot.remaining);
      const amount = this.c.mirrorFraction ? remaining * signal.sellNumerator / signal.sellDenominator : remaining;
      const capped = amount > remaining ? remaining : amount;
      if (!capped) continue;
      const list = grouped.get(lot.exitMint) || []; list.push({ lot, amount: capped }); grouped.set(lot.exitMint, list);
    }
    for (const [exitMint, allocations] of grouped) {
      if (!this.accepting) break;
      await this.execute({ kind: 'sell', lead: signal.lead, inputMint: signal.inputMint, outputMint: exitMint,
        amount: allocations.reduce((a, x) => a + x.amount, 0n), allocations: allocations.map(a => ({ lotId: a.lot.id, amount: a.amount.toString() })),
        venue: signal.venue || allocations[0].lot.venue, leadSignature: signal.signature, slot: signal.slot, observedAt: signal.observedAt, receivedAt: signal.receivedAt, signalAt: signal.signalAt, signalSource: signal.source,
        fallbackReason: signal.fallbackReason, confirmationWaitMs: signal.confirmationWaitMs, transactionFetchMs: signal.transactionFetchMs }, wallet);
    }
  }
  async execute(order, wallet) {
    if (!this.accepting) return;
    order.executionLimits = { slippageBps:this.c.slippageBps, maxPriceImpactPercent:this.c.maxPriceImpact };
    const stopSignal = this.abort.signal;
    const feePlan = platformFeePlan(this.runPlatformContext, this.platformFeeKind, order.inputMint, order.amount, wallet.publicKey);
    const started = performance.now();
    const feePromise = feePlan ? preparePlatformFee(feePlan, this.p, stopSignal, { paper: this.c.mode === 'paper', order }) : null;
    const timings = { notificationToSignalMs: Number.isFinite(order.signalAt) ? Math.round((order.signalAt - order.observedAt) * 10) / 10 : null,
      confirmationWaitMs: order.confirmationWaitMs ?? null, transactionFetchMs: order.transactionFetchMs ?? null,
      signalToOrderMs: Number.isFinite(order.signalAt) ? elapsed(order.signalAt) : null, feePreparationMs: 0, routeMs: 0, balanceMs: 0, packMs: 0,
      simulationMs: 0, simulationPerformed: false, signatureMs: 0, journalMs: 0 };
    this.event('info', `Building ${order.kind} route.`, { wallet: wallet.publicKey, order: {
      kind: order.kind, lead: order.lead, leadSignature: order.leadSignature, inputMint: order.inputMint, outputMint: order.outputMint,
      amount: String(order.amount), venue: order.venue, receivedAt: order.receivedAt, executionLimits:order.executionLimits,
    } });
    // Finish fee metadata before either read path starts. Native balance and
    // direct-route state reads must join the same microtask batch; an await
    // between them doubles RPC snapshots (and all slot-lag retries).
    const fee = feePromise ? await feePromise : { plan: null, instructions: [], rent: 0n, requiresSimulation: false };
    timings.feePreparationMs = elapsed(started);
    if (!this.accepting) return;
    invariant(Date.now() - order.receivedAt <= this.c.maxSignalAgeMs, 'Fee preparation exceeded your maximum signal age. Nothing was submitted.');
    order.platformFee = fee.plan;
    const balanceStarted = performance.now();
    const readBalances = () => this.c.mode === 'paper' ? Promise.resolve(null) : this.p.executionBalances ? this.p.executionBalances(order, wallet, stopSignal) : Promise.all([
      this.p.balance(wallet.publicKey, SOL, stopSignal), order.inputMint === SOL ? Promise.resolve(null) : this.p.balance(wallet.publicKey, order.inputMint, stopSignal),
    ]);
    const overhead = this.c.fees.priority + this.c.fees.jito + this.c.fees.helius + 5000n + this.c.reserve;
    // A slower balance read no longer holds up packing or optional simulation.
    // Both paths must finish successfully before any transaction is signed.
    const checkBalances = balances => {
      if (balances) {
        invariant(balances[0] >= overhead + fee.rent + (order.inputMint === SOL ? order.amount : 0n), 'Insufficient SOL for input, fees, token-account rent, tips, and reserve.');
        if (order.inputMint !== SOL) invariant(balances[1] >= order.amount, 'Insufficient balance in the required input token.');
        if (order.kind === 'sell') {
          const tracked = this.ledger.data.lots.filter(l => l.wallet === wallet.publicKey && l.mint === order.inputMint).reduce((n, l) => n + BigInt(l.remaining), 0n);
          invariant(balances[1] >= tracked, 'Wallet token balance is below tracked positions (external transfer/sale detected). Reconcile manually before selling.');
        }
      }
    };
    // A manual request may wait for route quota. Read spendable funds after
    // that wait, so the balance used to authorize signing is still current.
    let checkedBalances = readBalances().then(checkBalances).then(() => null, error => error).finally(() => { timings.balanceMs = elapsed(balanceStarted); });
    const routeStarted = performance.now();
    const routeOrder = fee.plan ? { ...order, amount: BigInt(fee.plan.swapAmount) } : order;
    let build = await this.p.build(routeOrder, wallet, stopSignal);
    if (order.signalSource === 'manual') {
      order.requestedAt = order.receivedAt; order.receivedAt = order.routeQuotedAt = Date.now();
      routeOrder.receivedAt = order.receivedAt; routeOrder.routeQuotedAt = order.routeQuotedAt;
    }
    // The executable quote's age begins before any additional fee-conversion
    // request; conversion cannot renew an older primary route's lifetime.
    build = await settlePlatformFee(build, fee, this.p, routeOrder, wallet, stopSignal);
    if (order.signalSource === 'manual') {
      if (build.routeName === 'Jupiter' || elapsed(balanceStarted) > 1000) {
        const at = performance.now(); checkedBalances = readBalances().then(checkBalances).then(() => null, error => error).finally(() => { timings.balanceMs = elapsed(at); });
      }
    }
    order.platformFee = fee.plan;
    timings.routeMs = elapsed(routeStarted);
    if (!this.accepting) return;
    invariant(Date.now() - order.receivedAt <= this.c.maxSignalAgeMs, 'Route build exceeded your maximum signal age.');
    const packStarted = performance.now();
    const prepared = await prepareTransaction(build, routeOrder, wallet, this.c, this.p, stopSignal);
    timings.packMs = elapsed(packStarted);
    if (!this.accepting) return;
    invariant(Date.now() - order.receivedAt <= this.c.maxSignalAgeMs, 'Transaction build exceeded your maximum signal age. Nothing was submitted.');
    build = prepared.build;
    if (order.kind === 'buy' && order.outputDecimals === undefined) {
      order.outputDecimals = build.outputDecimals ?? (await this.p.rpc('getTokenSupply', [order.outputMint, { commitment: 'confirmed' }], stopSignal)).value.decimals;
      invariant(Number.isInteger(order.outputDecimals) && order.outputDecimals >= 0 && order.outputDecimals <= 18, 'Route omitted valid output token decimals.');
    }
    const { tx, size, lastValidBlockHeight: builtHeight } = prepared.transaction;
    let lastValidBlockHeight = builtHeight;
    const market = this.p.market.get(order.outputMint);
    order.entryMarket = market && Date.now() - market.receivedAt < 10000 ? market : null;
    if (order.kind === 'buy') order.entryCostContext = captureEntryCost(order, this.p.market, {
      tipsLamports: (this.c.sendJito ? this.c.fees.jito : 0n) + (this.c.sendHelius ? this.c.fees.helius : 0n),
    });
    order.routeName = build.routeName; order.transactionBytes = size; order.transactionVersion = tx.version;
    if (this.c.mode === 'paper') {
      if (order.kind === 'buy') order.costBasis = costBasisFromFill(order, BigInt(build.outAmount), null, this.p.market, wallet.publicKey, { paper: true });
      await this.applyFill({ signature: `paper-${randomUUID()}`, wallet: wallet.publicKey, walletLabel: wallet.label, order: copy(order), createdAt: Date.now() }, BigInt(build.outAmount), order.amount, true);
      this.event('paper', `Paper ${order.kind}: ${build.routeName}; quoted fill only.`, { wallet: wallet.publicKey, lead: order.lead }); return;
    }
    if (build.requiresSimulation || this.c.simulateBeforeSend) {
      const simulationStarted = performance.now(); timings.simulationPerformed = true;
      const simulation = await this.p.rpc('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), {
        encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed',
      }], stopSignal, order.receivedAt + this.c.maxSignalAgeMs);
      timings.simulationMs = elapsed(simulationStarted);
      invariant(simulation?.value && Object.hasOwn(simulation.value, 'err'), 'RPC omitted the simulation result. Nothing was submitted.');
      if (simulation.value.err !== null) {
        const logs = (simulation.value.logs || []).filter(line => typeof line === 'string').slice(-20);
        this.event('error', `Pre-send simulation failed: ${JSON.stringify(simulation.value.err).slice(0, 140)}. Nothing was submitted.`, {
          wallet: wallet.publicKey, route: build.routeName, programLogs: logs,
        });
        throw new Error('Trade was not signed or submitted because its simulation failed. See the session export for program logs.');
      }
      const replacement = simulation.value.replacementBlockhash;
      if (replacement && Number.isSafeInteger(replacement.lastValidBlockHeight)) {
        tx.message.recentBlockhash = replacement.blockhash; lastValidBlockHeight = replacement.lastValidBlockHeight;
      }
      if (!this.accepting) return;
      invariant(Date.now() - order.receivedAt <= this.c.maxSignalAgeMs, 'Route simulation exceeded your maximum signal age. Nothing was submitted.');
    }
    const balanceError = await checkedBalances;
    if (balanceError) throw balanceError;
    if (!this.accepting) return;
    invariant(Date.now() - order.receivedAt <= this.c.maxSignalAgeMs, 'Trade checks exceeded your maximum signal age. Nothing was submitted.');
    invariant(wallet.keypair, 'Wallet key has been cleared. Stop and re-enter it to restart.');
    const signatureStarted = performance.now();
    tx.sign([wallet.keypair]);
    const bytes = tx.serialize(), { signature } = verifySignedTransaction(bytes, wallet.publicKey);
    timings.signatureMs = elapsed(signatureStarted); order.timings = timings;
    const pending = { signature, signatureVerified: true, wallet: wallet.publicKey, walletLabel: wallet.label, order: copy(order), lastValidBlockHeight, createdAt: Date.now(), relayAttempts: [] };
    this.ledger.data.pending.push(pending);
    this.updateManualOrder(order, wallet.publicKey, 'pending', signature);
    const journalStarted = performance.now();
    try { await this.ledger.save(); } catch (error) { this.fatal(error); throw new Error('Could not persist the transaction journal. Nothing was submitted.'); }
    timings.journalMs = elapsed(journalStarted);
    if (!this.accepting) { this.ledger.data.pending = this.ledger.data.pending.filter(p => p.signature !== signature); this.updateManualOrder(order, wallet.publicKey, 'skipped', null, 'Trading stopped before broadcast. Nothing was submitted.'); await this.ledger.save(); return; }
    this.metrics.detectionToSendMs = Math.round((performance.now() - order.observedAt) * 10) / 10;
    timings.notificationToBroadcastMs = this.metrics.detectionToSendMs;
    pending.order.timings = { ...timings }; pending.broadcastAt = Date.now();
    this.metrics.lastExecution = { signature, wallet: wallet.publicKey, kind: order.kind, source: order.signalSource || 'full-transaction', fallbackReason: order.fallbackReason, ...timings };
    this.event('info', `${order.kind} broadcast started via ${build.routeName}; awaiting relay acknowledgment.`, { wallet: wallet.publicKey, signature, signatureVerified: true, latencyMs: this.metrics.detectionToSendMs, timings: { ...timings } });
    this.transmissions.set(signature, { bytes, attempts: 0, lastSentAt: 0, inFlight: false });
    this.watchReceipt(pending);
    this.broadcast(pending);
    const until = Date.now() + this.receiptWaitMs;
    while (this.ledger.data.pending.some(p => p.signature === signature) && Date.now() < until) {
      await this.reconcileAll();
      if (this.ledger.data.pending.some(p => p.signature === signature)) await delay(200);
    }
    if (this.ledger.data.pending.some(p => p.signature === signature)) this.event('warn', 'Transaction outcome unresolved. This wallet stays paused until reconciliation.', { signature, wallet: wallet.publicKey });
  }
  watchReceipt(pending) {
    const provider = this.p;
    provider.watchSignature?.(pending.signature, status => {
      if (this.p !== provider || !this.ledger.data.pending.includes(pending)) return;
      pending.confirmedStatus = status; pending.confirmationSource = 'websocket';
      pending.confirmationObservedAt ||= Date.now();
      this.reconcileAll(true).catch(error => this.fatal(error));
    });
  }
  broadcast(pending) {
    const sending = this.transmissions.get(pending.signature), provider = this.p;
    if (!sending || sending.inFlight || !this.accepting) return;
    sending.inFlight = true; sending.lastSentAt = Date.now(); const attempt = ++sending.attempts;
    pending.broadcastAttempts = attempt;
    const record = result => {
      if (this.p !== provider || pending.relayAttempts.some(r => r.attempt === attempt && r.route === result.route)) return;
      const accepted = result.accepted !== false && result.signature === pending.signature;
      pending.relayAttempts.push({ attempt, route: result.route, accepted, at: Date.now(), error: result.error ? publicError({ message: result.error }) : undefined,
        httpStatus: result.httpStatus, rpcCode: result.rpcCode, retryAfterMs: result.retryAfterMs });
      if (accepted && !pending.acknowledgedAt) {
        pending.acknowledgedAt = Date.now(); this.metrics.submitted++;
        const relayAckMs = pending.acknowledgedAt - (pending.broadcastAt || pending.createdAt);
        if (this.metrics.lastExecution?.signature === pending.signature) this.metrics.lastExecution.relayAckMs = relayAckMs;
        this.event('sent', `${result.route} accepted the ${pending.order.kind} transaction via ${pending.order.routeName}; awaiting on-chain confirmation.`, { signature: pending.signature, wallet: pending.wallet, relayAckMs });
      } else if (!accepted) this.event('warn', `${result.route} submission: ${publicError({ message: result.error || 'Unexpected signature returned.' })}`, { signature: pending.signature, wallet: pending.wallet });
      this.ledger.save().catch(error => this.fatal(error));
    };
    // Retries reuse these exact signed bytes. Never refresh the blockhash, sign a
    // replacement, or replay an expired/old order when reconciling after restart.
    const signal = this.abort.signal, deadline = pending.order.receivedAt + this.c.maxSignalAgeMs;
    sending.promise = Promise.resolve().then(() => provider.submit(sending.bytes, record, signal, deadline, pending.additionalSigners || [])).then(record).catch(error => {
      if (this.p !== provider) return;
      if (!pending.relayAttempts.some(r => r.attempt === attempt)) record({ route: 'Submission', accepted: false, error: publicError(error) });
      this.event('warn', 'No relay acknowledged this broadcast attempt. Its original signature is still being checked.', { signature: pending.signature, wallet: pending.wallet });
    }).finally(() => { sending.inFlight = false; });
  }
  rebroadcastPending(pending) {
    const sending = this.transmissions.get(pending.signature), now = Date.now();
    if (!this.accepting || !sending || sending.inFlight || sending.attempts >= 3 || now - sending.lastSentAt < 2000 ||
      now - pending.order.receivedAt > this.c.maxSignalAgeMs || !Number.isFinite(pending.order.receivedAt)) return;
    this.event('info', 'Rebroadcasting the same signed transaction; amount and signature are unchanged.', { signature: pending.signature, wallet: pending.wallet });
    this.broadcast(pending);
  }
  async reconcileAll(prompt = false) {
    if (prompt) this.receiptPrompted = true;
    if (this.receiptPromise) return this.receiptPromise;
    if (!this.p || !this.ledger.data.pending.length || (Date.now() < this.receiptNextAt && (!this.receiptPrompted || this.receiptFailures))) return;
    this.receiptPrompted = false;
    this.receiptNextAt = Date.now() + this.receiptIntervalMs;
    this.receiptPromise = this.reconcileBatch().then(() => {
      if (this.receiptFailures) this.event('info', 'RPC confirmation checks recovered. Pending wallets resume only after their outcomes are verified.');
      this.receiptFailures = 0;
    }).catch(error => {
      if (!(error instanceof ProviderError)) throw error;
      const wait = Math.max(error.retryAfterMs || 0, error.retryable ? Math.min(30000, 1500 * 2 ** Math.min(this.receiptFailures, 5)) : 30000);
      this.receiptFailures++; this.receiptNextAt = Date.now() + wait;
      for (const p of this.ledger.data.pending) p.lastCheckError = publicError(error);
      if (this.receiptFailures === 1 || Date.now() - this.receiptWarningAt >= 30000) {
        this.receiptWarningAt = Date.now();
        this.event('warn', `${publicError(error)} Confirmation checks retry in ${Math.ceil(wait / 1000)}s; pending wallets remain paused.`, { retryAt: this.receiptNextAt });
      }
      this.emit('change');
    }).finally(() => {
      this.receiptPromise = null;
      if (this.receiptPrompted && !this.receiptFailures) queueMicrotask(() => this.reconcileAll().catch(error => this.fatal(error)));
    });
    return this.receiptPromise;
  }
  async reconcileBatch() {
    const pending = [...this.ledger.data.pending], polled = new Map(), needingStatus = pending.filter(p => !p.confirmedStatus);
    for (let i = 0; i < needingStatus.length; i += 256) {
      const batch = needingStatus.slice(i, i + 256), statuses = await this.p.statuses(batch.map(p => p.signature));
      batch.forEach((p, j) => polled.set(p.signature, statuses[j]));
    }
    const missing = [];
    const checked = await Promise.allSettled(pending.map(async p => {
      const status = p.confirmedStatus || polled.get(p.signature);
      p.lastCheckedAt = Date.now(); p.lastCheckError = null; p.chainStatus = status?.confirmationStatus || 'not_seen';
      if (!status) { missing.push(p); return; }
      await this.reconcileConfirmed(p, status);
    }));
    const failure = checked.find(r => r.status === 'rejected'); if (failure) throw failure.reason;
    if (missing.length) {
      if (!this.receiptHeight || Date.now() - this.receiptHeight.at >= 5000) this.receiptHeight = { value: await this.p.height(), at: Date.now() };
      const expired = missing.filter(p => Number.isSafeInteger(p.lastValidBlockHeight) && this.receiptHeight.value > p.lastValidBlockHeight + 32);
      if (expired.length) {
        // Finalized height plus a second historical read: a temporary cache miss
        // or a failed RPC call must never clear the journal or unlock a wallet.
        for (let offset = 0; offset < expired.length; offset += 256) {
          const chunk = expired.slice(offset, offset + 256), late = await this.p.statuses(chunk.map(p => p.signature));
          for (let i = 0; i < chunk.length; i++) {
            const p = chunk[i];
            if (late[i]) await this.reconcileConfirmed(p, late[i]);
            else {
              const tx = await this.p.transaction(p.signature);
              if (!tx) await this.failReceipt(p, 'Transaction expired without a recorded fill; wallet can follow new signals.');
              else await this.reconcileTransaction(p, tx);
            }
          }
        }
      }
      for (const p of missing) if (this.ledger.data.pending.includes(p) && this.receiptHeight.value <= p.lastValidBlockHeight) this.rebroadcastPending(p);
    }
    this.emit('change');
  }
  async reconcileConfirmed(pending, status) {
    if (!['confirmed', 'finalized'].includes(status.confirmationStatus)) return;
    pending.confirmationObservedAt ||= Date.now(); pending.confirmationSource ||= 'poll';
    if (status.err) { await this.failOnChain(pending, status.err); return; }
    if (Number.isSafeInteger(status.slot)) pending.confirmedSlot = status.slot;
    await this.reconcileTransaction(pending, await this.p.transaction(pending.signature));
  }
  async reconcileTransaction(pending, tx) {
    if (!tx?.meta) return;
    if (Number.isSafeInteger(tx.slot)) pending.confirmedSlot = tx.slot;
    if (tx.meta.err) { await this.failOnChain(pending, tx.meta.err, tx); return; }
    const platformReceipt = verifyPlatformFee(pending, tx);
    const balances = tokenBalances(tx, pending.wallet);
    if (pending.order.kind === 'buy') {
      const output = balances.find(b => b.mint === pending.order.outputMint)?.delta || 0n;
      invariant(output > 0n, 'Confirmed swap has no measurable token credit; wallet remains paused for review.');
      pending.order.costBasis = costBasisFromFill(pending.order, output, tx, this.p.market, pending.wallet);
      await this.applyFill(pending, output, BigInt(pending.order.amount), false, platformReceipt);
    } else {
      const debit = -(balances.find(b => b.mint === pending.order.inputMint)?.delta || 0n);
      invariant(debit > 0n && debit <= BigInt(pending.order.amount), 'Confirmed sell debit differs from its recorded order; wallet remains paused for review.');
      await this.applyFill(pending, 0n, debit, false, platformReceipt);
    }
  }
  async failOnChain(pending, error, tx) {
    // Only a confirmed failure reaches here. Diagnostics never trigger a new
    // trade, and an unavailable diagnostic read cannot leave this wallet paused.
    if (!tx) { try { tx = await this.p.transaction(pending.signature, AbortSignal.timeout(1500)); } catch {} }
    const report = describeTradeFailure(pending.order, error, tx);
    await this.failReceipt(pending, report.message, report.details);
  }
  async failReceipt(pending, message, details = {}) {
    this.p.unwatchSignature?.(pending.signature);
    this.transmissions.delete(pending.signature);
    this.ledger.data.pending = this.ledger.data.pending.filter(p => p.signature !== pending.signature);
    this.updateManualOrder(pending.order, pending.wallet, 'failed', pending.signature, message);
    for (const allocation of pending.order.allocations || []) {
      if (allocation.level === undefined) continue;
      const failures = (this.ladderFailures.get(allocation.lotId) || 0) + 1;
      this.ladderFailures.set(allocation.lotId, failures);
      if (failures === 3) this.event('warn', 'Automatic ladder paused for this position after three failed or expired orders. Review the cause, then Stop and Start to retry. Mirror lead sells remain enabled in hybrid mode.', { wallet: pending.wallet });
    }
    this.event('error', message, { signature: pending.signature, wallet: pending.wallet, order:copy(pending.order), ...details });
    try { await this.ledger.save(); } catch (error) { this.fatal(error); throw error; }
  }
  async applyFill(pending, received, spent, paper = false, platformReceipt = null) {
    const o = pending.order;
    if (!paper && !this.ledger.data.pending.some(p => p.signature === pending.signature)) return;
    this.transmissions.delete(pending.signature);
    this.p.unwatchSignature?.(pending.signature);
    if (o.kind === 'buy') {
      this.ledger.data.lots.push({ id: pending.signature, wallet: pending.wallet, walletLabel: pending.walletLabel, lead: o.lead,
        mint: o.outputMint, decimals: o.outputDecimals, exitMint: o.exitMint, venue: o.venue || null, remaining: received.toString(), original: received.toString(),
        ...(Number.isSafeInteger(pending.confirmedSlot) ? { confirmedSlot: pending.confirmedSlot } : {}),
        entryPrice: o.entryMarket?.price || null, entryMarketCap: o.entryMarket?.marketCap || null, costBasis: o.costBasis || null, symbol: o.entryMarket?.symbol || '', lastLevel: 0, ruleKey: '', openedAt: Date.now(), mode: paper ? 'paper' : 'live' });
      if (o.inputMint === SOL) this.spend.set(pending.wallet, (this.spend.get(pending.wallet) || 0n) + spent);
      if (this.c?.sellMode !== 'mirror' && (!o.entryMarket || (this.c?.sellMode.includes('marketcap') && !o.entryMarket.marketCap))) this.event('warn', 'Entry market data unavailable. This position has no automatic ladder baseline for the selected rule; mirror mode can still sell it.', { wallet: pending.wallet, mint: o.outputMint });
    } else {
      let appliedDebit = 0n, allocatedInput = 0n;
      for (let i = 0; i < o.allocations.length; i++) {
        const allocation = o.allocations[i], lot = this.ledger.data.lots.find(l => l.id === allocation.lotId);
        invariant(lot, 'A sell allocation has no position record.');
        allocatedInput += BigInt(allocation.amount);
        const targetDebit = i === o.allocations.length - 1 ? spent : allocatedInput * spent / BigInt(o.amount);
        const debit = targetDebit - appliedDebit;
        invariant(debit <= BigInt(lot.remaining), 'A sell would overdraw an attributed position.');
        lot.remaining = (BigInt(lot.remaining) - debit).toString(); appliedDebit = targetDebit;
        if (Number.isSafeInteger(pending.confirmedSlot)) lot.confirmedSlot = Math.max(lot.confirmedSlot || 0, pending.confirmedSlot);
        this.ladderFailures.delete(lot.id);
        if (allocation.level !== undefined) lot.lastLevel = allocation.level;
      }
    }
    this.ledger.data.pending = this.ledger.data.pending.filter(p => p.signature !== pending.signature);
    this.updateManualOrder(o, pending.wallet, 'confirmed', pending.signature);
    recordPlatformFee(this.ledger, pending, platformReceipt, paper);
    this.ledger.data.trades++; this.metrics.confirmed++;
    if (!paper) {
      this.metrics.confirmationMs = Date.now() - pending.createdAt;
      const slotLag = Number.isSafeInteger(pending.confirmedSlot) && Number.isSafeInteger(o.slot) ? pending.confirmedSlot - o.slot : null;
      this.event('confirmed', `${o.kind} confirmed; position updated from on-chain balances.`, { signature: pending.signature, wallet: pending.wallet, latencyMs: this.metrics.confirmationMs,
        leadSlot: o.slot, followerSlot: pending.confirmedSlot, slotLag, timings: o.timings, confirmationSource:pending.confirmationSource || 'poll',
        confirmationObservedMs:pending.confirmationObservedAt ? pending.confirmationObservedAt - pending.createdAt : null });
    }
    try { await this.ledger.save(); } catch (error) { this.fatal(error); throw error; }
    this.emit('change');
  }
  async pollMarkets() {
    if (!this.accepting || this.marketPolling) return;
    this.marketPolling = true;
    try {
      const lots = this.ledger.data.lots.filter(l => BigInt(l.remaining) > 0n && this.c.wallets.some(w => w.publicKey === l.wallet));
      if (!lots.length) return;
      await this.p.markets(lots.map(l => l.mint), this.abort.signal);
      if (this.manualOnly || this.c.sellMode === 'mirror' || !this.accepting) return;
      const ruleKey = [this.c.sellMode, this.c.percentStep, this.c.marketcapStep, this.c.sellPercent].join(':');
      for (const lot of lots) {
        if (!this.c.leads.includes(lot.lead)) continue;
        if (lot.ruleKey !== ruleKey) { lot.ruleKey = ruleKey; lot.lastLevel = 0; }
        const market = this.p.market.get(lot.mint), target = ladderTarget(lot, market, this.c);
        if (target <= lot.lastLevel || this.ladderLocks.has(lot.id) || (this.ladderFailures.get(lot.id) || 0) >= 3) continue;
        const wallet = this.c.wallets.find(w => w.publicKey === lot.wallet);
        this.ladderLocks.add(lot.id);
        const queued = this.enqueue(wallet, async () => {
          await this.refreshInventory({ wallet: wallet.publicKey, mint: lot.mint, source: 'ladder-sell', allowBusy: true });
          if (!this.accepting) return;
          const freshTarget = ladderTarget(lot, this.p.market.get(lot.mint), this.c);
          const crossed = freshTarget - lot.lastLevel;
          if (crossed <= 0 || BigInt(lot.remaining) <= 0n) return;
          const amount = ladderAmount(lot.remaining, this.c.sellPercent, crossed);
          await this.execute({ kind: 'sell', lead: lot.lead, inputMint: lot.mint, outputMint: lot.exitMint, amount, venue: lot.venue,
            allocations: [{ lotId: lot.id, amount: amount.toString(), level: freshTarget }], observedAt: performance.now(), receivedAt: Date.now(), trigger: this.c.sellMode }, wallet);
        });
        if (queued) queued.finally(() => this.ladderLocks.delete(lot.id)); else this.ladderLocks.delete(lot.id);
      }
    } finally { this.marketPolling = false; this.emit('change'); }
  }
}
