import { EventEmitter } from 'node:events';
import { randomUUID, randomInt } from 'node:crypto';
import { decodeEventLog, encodeFunctionData, parseAbi, parseGwei } from 'viem';
import { cleanRobinhoodSettings, evmAddress } from './robinhood-settings.mjs';
import { RobinhoodRpc, strictUnits } from './robinhood-rpc.mjs';
import { RobinhoodWalletScanner } from './robinhood-scanner.mjs';
import { RobinhoodPools, buildSwapPlan, otherCurrency } from './robinhood-pools.mjs';
import { RobinhoodExecutor, tokenDelta } from './robinhood-executor.mjs';
import { buildLpDeposit, buildLpWithdrawal, liveLpLiquidity } from './robinhood-liquidity.mjs';
import { CONTRACTS, erc20Abi, poolAbi, positionAbi, ponsAbi, airlockAbi, poolId, EVM_NATIVE } from './robinhood-contracts.mjs';
import { ponsV1Abi, adapterAbi, v3PositionAbi } from './robinhood-legacy-contracts.mjs';
import { matchingSwap } from './robinhood-legacy-pools.mjs';
import { buildEthTradePlan, ethExecution, ethFundingPath } from './robinhood-eth-trades.mjs';
import { wrappedEthPlan, verifyWrappedEth } from './robinhood-wrapped-eth.mjs';
import { verifyExecutor } from './robinhood-deployment.mjs';
import { buildFeeClaim, buildFeeCompound } from './robinhood-lp-fees.mjs';
import { referenceEth } from './robinhood-liquidity.mjs';
import { TOOL_NAMES } from '../public/chains.mjs';
import { robinhoodErrorMessage, rpcRateLimit, throwIfRpcUnavailable } from './robinhood-rpc-errors.mjs';
import { manualIdentity, manualResult, updateManualResult } from './robinhood-manual.mjs';

const delay = (ms, signal) => new Promise(resolve => { const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true }); if (signal?.aborted) done(); });
const safeError = robinhoodErrorMessage;

export class RobinhoodEngine extends EventEmitter {
  constructor(ledger, policy, kind, { rpcFactory = (config, options) => new RobinhoodRpc(config, options), gate } = {}) {
    super(); Object.assign(this, { ledger, policy, kind, rpcFactory, gate }); this.state = 'stopped'; this.tasks = new Set(); this.metrics = { signals: 0, submitted: 0, fills: 0 }; this.spent = new Map(); this.generation = 0; this.operation = false; this.copyPairs = new Map(); this.lpPaused = new Set(); this.copySellTasks = new Set();
    this.reconcileTimer = setInterval(() => {
      if (this.state === 'stopped' && !this.operation && !this.reconcileTask && this.executor && this.ledger.data.pending.length) this.reconcileTask = this.executor.reconcileAll().finally(() => { this.reconcileTask = null; });
    }, 10000); this.reconcileTimer.unref();
  }
  get manualResult() { return manualResult(this.ledger.data, this.lastManualId); }
  status() { return { chain: 'robinhood', chainId: 4663, state: this.state, kind: this.kind, mode: 'live', positions: this.ledger.data.lots.filter(l => BigInt(l.remaining || l.liquidity || 0) > 0n), pending: this.ledger.data.pending.map(({ signed, data, ...p }) => p), events: this.ledger.data.events, metrics: this.metrics, stream: this.scanner?.status() || null, rpc: this.rpc?.status?.() || null, manualResult: this.manualResult, startupError: this.startupError }; }
  event(level, message, details = {}) {
    this.ledger.addEvent({ id: randomUUID(), at: Date.now(), level, message, ...details });
    if (['submitted','confirmed','error'].includes(level) && details.timing && details.operation !== 'approval' && details.signature) {
      const prior = (this.metrics.executions || []).find(row => row.signature === details.signature) || {};
      const timing = { ...prior, ...details.timing, signature: details.signature, wallet: details.wallet, side: details.side || details.timing.side };
      this.metrics.executions = [timing, ...(this.metrics.executions || []).filter(row => row.signature !== details.signature)].slice(0, 25);
      this.metrics.lastExecution = timing;
      if (timing.acceptedAt) this.metrics.detectionToSendMs = Math.max(0, timing.acceptedAt - (timing.receivedAt || timing.detectedAt || timing.startedAt));
      this.metrics.confirmationMs = timing.confirmedAt && timing.acceptedAt ? Math.max(0, timing.confirmedAt - timing.acceptedAt) : null;
    }
    if (level === 'submitted') this.metrics.submitted++; if (level === 'confirmed' && details.operation !== 'approval') this.metrics.fills++;
    this.ledger.save().catch(() => {}); this.emit('change');
  }
  async prepare(raw) {
    const config = cleanRobinhoodSettings(raw);
    if (!this.policy?.ready || this.policy.chainId !== 4663 || config.agreedFeeVersion !== this.policy.version) throw Error('Review the current Robinhood fee schedule before starting.');
    if (!config.wallets.length) throw Error('Select at least one wallet.');
    this.config = config; this.tool = config.tools[this.kind]; this.abort = new AbortController();
    this.rpc = this.rpcFactory(config, { signal: this.abort.signal, gate: this.gate }); await this.rpc.connect();
    await verifyExecutor(this.rpc.client, this.policy.adapter);
    this.pools = new RobinhoodPools(this.rpc);
    this.executor = new RobinhoodExecutor(this.rpc, this.ledger, { policy: this.policy, signal: this.abort.signal, event: (l, m, d) => this.event(l, m, d), confirmed: (p, r) => this.confirmed(p, r) });
    await this.executor.reconcileAll();
    for (const lot of this.ledger.data.lots) if (lot.lead && lot.token && lot.pool) this.copyPairs.set(`${lot.lead}:${lot.token}`, { pool: lot.pool, quote: lot.quote });
    for (const p of this.ledger.data.pending) if (p.context?.side === 'buy' && p.context.lead) this.copyPairs.set(`${p.context.lead}:${p.context.token}`, { pool: p.context.pool, quote: p.context.quote });
    return config;
  }
  async start(raw, kind) {
    if (kind !== this.kind || !(kind in TOOL_NAMES)) throw Error('Wrong trading worker.');
    if (this.operation || this.state !== 'stopped') throw Error('Stop this tool before starting again.');
    this.operation = true; this.state = 'starting'; this.startupError = null; const generation = ++this.generation; this.emit('change');
    try {
      await this.prepare(raw);
      if (generation !== this.generation) throw Error('Run stopped.');
      if (kind === 'copy' && !this.tool.leads.length || kind === 'sniper' && !this.tool.developers.length) throw Error(kind === 'sniper' ? 'Enter at least one developer wallet.' : 'Enter at least one lead wallet.');
      if (['market', 'liquidity'].includes(kind)) {
        if (!this.tool.token) throw Error('Enter the token contract address.');
        this.strategyPool = await this.pools.find(this.tool.token, this.tool.quote, this.tool.pool);
        this.tool.quote = otherCurrency(this.strategyPool, this.tool.token);
        if (kind === 'liquidity' && this.strategyPool.protocol === 'pons-curve') throw Error('LP deposits open when this Pons launch graduates to Uniswap. Copying, sniping and inventory trading can use the curve.');
        if (kind === 'market') {
          const budget = this.marketBudget();
          for (const wallet of this.config.wallets) this.checkMarketAllocation(wallet.publicKey);
          // Discover and quote the entire ETH route before starting any wallet.
          const target = ({ conservative: 35, balanced: 50, active: 65 })[this.tool.preset] ?? this.tool.targetPercent;
          await buildEthTradePlan({ pools: this.pools, pool: this.strategyPool, token: this.tool.token, buy: true, amount: budget * BigInt(target) / 100n, wallet: this.config.wallets[0].publicKey, recipient: this.policy.recipient, adapter: this.policy.adapter, ppm: this.policy.marketPpm, slippageBps: this.config.slippageBps, feePool: this.tool.feePool });
        }
        if (kind === 'liquidity') {
          this.marketBudget();
          for (const wallet of this.config.wallets) this.checkLpAllocation(wallet.publicKey);
          await ethFundingPath(this.pools, this.tool.quote, { feePool: this.tool.feePool, avoid: this.tool.token });
          const selected = new Set(this.config.wallets.map(w => w.publicKey));
          const otherPositions = this.ledger.data.lots.filter(l => !selected.has(l.wallet) && BigInt(l.liquidity || 0) > 0n).length;
          if (otherPositions + this.config.wallets.length * this.tool.maxPositions > 20) throw Error('Maximum 20 LP positions across this account’s Robinhood wallets. Reduce positions per wallet or select fewer wallets.');
          if (this.ledger.data.lots.some(l => selected.has(l.wallet) && BigInt(l.liquidity || 0) > 0n && poolId(l.pool) !== poolId(this.strategyPool))) throw Error('Withdraw this wallet’s existing LP positions before changing its pool.');
        }
      }
      this.lastBlock = await this.rpc.client.getBlockNumber(); this.lastBlockHash = (await this.rpc.client.getBlock({ blockNumber: this.lastBlock })).hash;
      this.scanner = null;
      this.abort.signal.throwIfAborted(); if (generation !== this.generation) throw Error('Run stopped.');
      for (const intent of this.ledger.data.copySells || []) { intent.attempts = 0; intent.retryAt = 0; }
      this.spent.clear(); this.lpPaused.clear(); this.state = 'running'; this.event('info', `${TOOL_NAMES[kind]} started on Robinhood Chain for ${this.config.wallets.length} wallet(s).`);
      this.loopTask = this.loop(generation).catch(error => { if (!this.abort.signal.aborted) this.event('error', safeError(error)); }).finally(async () => {
        this.abort.abort(); await this.executor.drain(); this.state = 'stopped'; this.emit('change');
      });
    } catch (error) { this.abort?.abort(); this.state = 'stopped'; this.startupError = safeError(error); this.emit('change'); throw error; }
    finally { this.operation = false; }
  }
  stop() { ++this.generation; this.abort?.abort(); if (this.state !== 'stopped') this.state = 'stopping'; this.emit('change'); return this.status(); }
  async close() { clearInterval(this.reconcileTimer); this.stop(); await this.loopTask; await this.reconcileTask; await Promise.allSettled([...this.tasks]); await this.executor?.drain(); await this.ledger.save(); this.state = 'stopped'; }
  async loop(generation) {
    let failures = 0, nextStrategy = 0, nextInventory = 0;
    while (generation === this.generation && !this.abort.signal.aborted) {
      let catchingUp = false, retryAfterMs = 0;
      try {
        await this.executor.reconcileAll();
        if (this.abort.signal.aborted) break;
        if (['copy', 'sniper'].includes(this.kind)) { this.dispatchCopySells(); catchingUp = await this.scan(); }
        if (Date.now() >= nextStrategy) {
          nextStrategy = Date.now() + this.tool.intervalMs;
          if (this.kind === 'market') await this.marketTick();
          if (this.kind === 'liquidity') await this.liquidityTick();
          if (['percent', 'hybrid-percent'].includes(this.tool.sellMode)) await this.ladderTick();
        }
        if (Date.now() >= nextInventory && !this.tasks.size) { nextInventory = Date.now() + 15000; await (this.rpc?.withPriority ? this.rpc.withPriority(-2, () => this.refreshInventory()) : this.refreshInventory()); }
        failures = 0;
      } catch (error) {
        if (this.abort.signal.aborted) break;
        retryAfterMs = Number(rpcRateLimit(error)?.retryAfterMs || 0);
        this.event('error', safeError(error, this.rpc.url), { ...(error.signalSignature ? { signature: error.signalSignature, lead: error.signalLead } : {}), stream: this.scanner?.status() || null }); if (++failures >= 5) throw Error('RPC or route checks failed repeatedly. This run stopped; holdings remain in the wallets.');
      }
      await delay(Math.max(retryAfterMs, catchingUp ? 0 : this.config.pollMs), this.abort.signal);
    }
  }
  enqueue(wallet, task) {
    if (this.tasks.size >= 256) { this.event('error', 'The transaction queue is full; this signal was not submitted.'); return Promise.resolve(); }
    const generation = this.generation;
    const promise = this.executor.serial(wallet.publicKey, async () => { if (generation !== this.generation || this.abort.signal.aborted) return; return this.rpc?.withPriority ? this.rpc.withPriority(1, task) : task(); });
    this.tasks.add(promise); promise.catch(error => { if (!this.abort.signal.aborted) this.event('error', safeError(error, this.rpc?.url), { wallet: wallet.publicKey, ...(error.tradeTiming ? { timing: error.tradeTiming } : {}) }); }).finally(() => this.tasks.delete(promise)); return promise;
  }
  async scan() {
    this.scanner ||= new RobinhoodWalletScanner(this.rpc.client, {
      kind: this.kind, tracked: this.kind === 'copy' ? this.tool.leads : this.tool.developers, launchSource: this.tool.launchSource,
      blockNumber: this.lastBlock, blockHash: this.lastBlockHash, signal: this.abort.signal,
      onRangeLimit: size => this.event('info', `RPC event queries adjusted to ${size}-block ranges for this provider.`),
      onTransaction: async (tx, receipt, block, observed) => {
        const seen = `${this.kind}:${tx.hash}`; if (this.ledger.data.seen.includes(seen)) return;
        if (receipt.status !== 'success') { await this.ledger.remember(seen); return; }
        try {
          this.pools.rememberLogs(receipt.logs);
          if (this.kind === 'sniper') { await this.launchSignals(tx, receipt, block, observed); await this.copySignals(tx, receipt, block, true, observed); } else await this.copySignals(tx, receipt, block, false, observed);
          await this.ledger.remember(seen);
        } catch (cause) {
          const error = Error(safeError(cause), { cause }); error.signalSignature = tx.hash; error.signalLead = tx.from; throw error;
        }
      }
    });
    try { return await this.scanner.scan(); }
    finally { this.lastBlock = this.scanner.blockNumber; this.lastBlockHash = this.scanner.blockHash; }
  }
  async launchSignals(tx, receipt, block, observed = {}) {
    const receivedAt = observed.receivedAt || Date.now();
    for (const log of receipt.logs) {
      const isV1 = log.address.toLowerCase() === CONTRACTS.ponsV1Factory.toLowerCase(), isPons = isV1 || log.address.toLowerCase() === CONTRACTS.ponsFactory.toLowerCase(), isLong = log.address.toLowerCase() === CONTRACTS.airlock.toLowerCase();
      if (!isPons && !isLong || isPons && this.tool.launchSource === 'long' || isLong && this.tool.launchSource === 'pons') continue;
      let decoded; try { decoded = decodeEventLog({ abi: isV1 ? ponsV1Abi : isPons ? ponsAbi : airlockAbi, data: log.data, topics: log.topics }); } catch { continue; }
      if (!['TokenLaunched', 'Create'].includes(decoded.eventName)) continue;
      if (isPons && decoded.args.deployer.toLowerCase() !== tx.from.toLowerCase()) continue;
      const token = evmAddress(decoded.args.token || decoded.args.asset), quote = evmAddress(decoded.args.pairToken || decoded.args.numeraire);
      try { const pool = await this.pools.find(token, quote); this.buySignal({ token, quote, pool, lead: evmAddress(tx.from), signature: tx.hash, at: Number(block.timestamp) * 1000, receivedAt }); }
      catch (error) { this.event('warn', `Launch detected: ${safeError(error)}`, { token, signature: tx.hash }); }
    }
  }
  async copySignals(tx, receipt, block, sellsOnly = false, observed = {}) {
    const receivedAt = observed.receivedAt || Date.now();
    const pools = this.pools.snapshot?.() || this.pools;
    const lead = evmAddress(tx.from), tokens = new Set();
    for (const log of receipt.logs) try { const decoded = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics }); if (decoded.args.to.toLowerCase() === lead.toLowerCase() || decoded.args.from.toLowerCase() === lead.toLowerCase()) tokens.add(evmAddress(log.address)); } catch {}
    const swaps = [];
    for (const log of receipt.logs) if (log.address.toLowerCase() === CONTRACTS.poolManager.toLowerCase()) try { const event = decodeEventLog({ abi: poolAbi, data: log.data, topics: log.topics }); if (event.eventName === 'Swap') swaps.push(event.args); } catch {}
    const legacyPools = await pools.observeLegacyLogs(receipt.logs);
    if (!swaps.length && !legacyPools.length) return;
    let sold = false;
    for (const token of tokens) {
      const delta = tokenDelta(receipt, lead, token); if (delta >= 0n) continue;
      const lots = this.ledger.data.lots.filter(l => l.lead === lead && l.token === token && BigInt(l.remaining || 0) > 0n);
      const pair = lots[0] || this.copyPairs.get(`${lead}:${token}`);
      if (!pair) continue;
      let executedPool = legacyPools.find(p => [p.currency0, p.currency1].includes(token));
      if (!executedPool) try { const candidate = await pools.find(token, pair.quote); if (swaps.some(s => s.id === poolId(candidate))) executedPool = candidate; } catch (error) { throwIfRpcUnavailable(error); }
      if (!executedPool) continue; sold = true;
      if (!['mirror', 'hybrid-percent'].includes(this.tool.sellMode)) continue;
      const before = this.tool.mirrorFraction ? await this.leadBalanceBefore(token, lead, tx, receipt) : -delta;
      const numerator = before > -delta ? -delta : before;
      if (before <= 0n) throw Error('Could not verify the lead’s pre-sale balance.');
      const detectedAt = Date.now();
      this.event('signal', 'Lead sell detected.', { token, signature: tx.hash, side: 'sell', timing: { receivedAt, detectedAt, decodeMs: detectedAt - receivedAt } }); this.metrics.signals++;
      // A buy may remain unresolved after its initial receipt wait. Persist the
      // exit before queueing it so that reconciliation and restarts cannot lose
      // the lead's sell while the follower's buy is still pending.
      this.ledger.data.copySells ||= [];
      const sequence = this.nextCopySequence();
      for (const wallet of this.config.wallets) {
        const id = `${tx.hash}:${wallet.publicKey}:${token}`;
        if (this.ledger.data.seen.includes(`copy-sell:${id}`) || this.ledger.data.copySells.some(s => s.id === id)) continue;
        this.ledger.data.copySells.push({ id, wallet: wallet.publicKey, lead, token, quote: otherCurrency(executedPool, token), pool: executedPool, numerator: String(numerator), denominator: String(before), sequence, signal: tx.hash, receivedAt, detectedAt, leadBlockAt: Number(block.timestamp) * 1000, attempts: 0 });
      }
      await this.ledger.save(); this.dispatchCopySells();
    }
    if (sold || sellsOnly) return;
    for (const token of tokens) {
      if (tokenDelta(receipt, lead, token) <= 0n || [EVM_NATIVE, CONTRACTS.weth, this.tool.quote].includes(token)) continue;
      let pool; try { pool = legacyPools.find(p => matchingSwap(receipt.logs, p, token)) || await pools.find(token, null, this.tool.pool && [this.tool.pool.currency0,this.tool.pool.currency1].includes(token) ? this.tool.pool : null); } catch (error) { throwIfRpcUnavailable(error); continue; }
      const outputSwap = swaps.find(s => s.id === poolId(pool) && (pool.currency0 === token ? s.amount0 > 0n : s.amount1 > 0n));
      if (!outputSwap && !matchingSwap(receipt.logs, pool, token)) continue;
      const quote = otherCurrency(pool, token); this.buySignal({ token, quote, pool, lead, signature: tx.hash, at: Number(block.timestamp) * 1000, receivedAt }, pools);
    }
  }
  nextCopySequence() {
    this.ledger.data.copySequence = (this.ledger.data.copySequence || 0) + 1;
    return this.ledger.data.copySequence;
  }
  finishCopySell(id) {
    this.ledger.data.copySells = (this.ledger.data.copySells || []).filter(s => s.id !== id);
    const marker = `copy-sell:${id}`; if (!this.ledger.data.seen.includes(marker)) this.ledger.data.seen.push(marker);
  }
  dispatchCopySells() {
    if (this.state !== 'running' || this.abort?.signal.aborted) return;
    for (const intent of this.ledger.data.copySells || []) {
      if (this.copySellTasks.has(intent.id) || intent.attempts >= 3 || (intent.retryAt || 0) > Date.now()) continue;
      const wallet = this.config.wallets.find(w => w.publicKey === intent.wallet); if (!wallet) continue;
      this.copySellTasks.add(intent.id);
      this.enqueue(wallet, async () => {
        const currentIntent = (this.ledger.data.copySells || []).find(s => s.id === intent.id); if (!currentIntent) return;
        // Do not consume the signal until an earlier broadcast has a known
        // outcome. The next loop dispatches it again after reconciliation.
        if (this.ledger.data.pending.some(p => p.wallet === wallet.publicKey)) return;
        const earlier = (this.ledger.data.copySells || []).some(s => s.wallet === wallet.publicKey && s.sequence < intent.sequence && s.attempts < 3); if (earlier) return;
        const current = this.ledger.data.lots.filter(l => l.lead === intent.lead && l.token === intent.token && l.wallet === wallet.publicKey && BigInt(l.remaining || 0) > 0n && (l.copySequence || 0) < intent.sequence);
        const total = current.reduce((s, l) => s + BigInt(l.remaining), 0n), amount = total * BigInt(intent.numerator) / BigInt(intent.denominator);
        if (!amount) { this.finishCopySell(intent.id); await this.ledger.save(); return; }
        // Bound retries, including transactions that revert only after the
        // initial receipt wait. Ambiguous broadcasts stay blocked by pending.
        currentIntent.attempts = (currentIntent.attempts || 0) + 1;
        currentIntent.retryAt = Date.now() + currentIntent.attempts * 5000;
        await this.ledger.save();
        try {
          await this.swap(wallet, intent.pool, intent.token, amount, { side: 'sell', token: intent.token, quote: intent.quote, lead: intent.lead, lotIds: current.map(l => l.id), signal: intent.signal, copySellId: intent.id, receivedAt: intent.receivedAt, detectedAt: intent.detectedAt, leadBlockAt: intent.leadBlockAt, startedAt: Date.now() });
        } catch (error) {
          if (currentIntent.attempts >= 3 && !this.ledger.data.pending.some(p => p.wallet === wallet.publicKey)) this.event('error', 'Copied sell failed after three attempts. Use Manual Sell or restart this tool to retry.', { wallet: wallet.publicKey, token: intent.token });
          throw error;
        }
      }).finally(() => this.copySellTasks.delete(intent.id)).catch(() => {});
    }
  }
  async leadBalanceBefore(token, lead, tx, receipt) {
    const previous = await this.rpc.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [lead], blockNumber: receipt.blockNumber - 1n });
    const event = erc20Abi.find(a => a.type === 'event');
    const sets = await Promise.all([this.rpc.client.getLogs({ address: token, event, args: { from: lead }, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber }), this.rpc.client.getLogs({ address: token, event, args: { to: lead }, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber })]);
    const seen = new Set(); let balance = previous;
    for (const log of sets.flat()) { const key = `${log.transactionHash}:${log.logIndex}`; if (seen.has(key) || log.transactionIndex >= receipt.transactionIndex) continue; seen.add(key); if (log.args.to.toLowerCase() === lead.toLowerCase()) balance += log.args.value; if (log.args.from.toLowerCase() === lead.toLowerCase()) balance -= log.args.value; }
    return balance;
  }
  buySignal(signal, pools = this.pools.snapshot?.() || this.pools) {
    const detectedAt = Date.now();
    const copySequence = this.nextCopySequence();
    this.copyPairs.set(`${signal.lead}:${signal.token}`, { pool: signal.pool, quote: signal.quote });
    this.metrics.signals++; this.event('signal', 'Lead buy or launch detected.', { token: signal.token, quote: signal.quote, signature: signal.signature, side: 'buy', timing: { signalAgeMs: Math.max(0, detectedAt - signal.at), maxSignalAgeMs: this.config.maxSignalAgeMs } });
    for (const wallet of this.config.wallets) this.enqueue(wallet, async () => {
      const started = Date.now();
      try {
        if (Date.now() - signal.at > this.config.maxSignalAgeMs) throw Error('Buy signal expired before this wallet could submit.');
        const amount = this.buyAmount(wallet, 18);
        await this.swap(wallet, signal.pool, EVM_NATIVE, amount, { side: 'buy', token: signal.token, quote: signal.quote, lead: signal.lead, signal: signal.signature, signalAt: signal.at, receivedAt: signal.receivedAt || detectedAt, detectedAt, startedAt: started, copySequence }, { pools });
      } catch (error) {
        error.tradeTiming = { signalAgeMs: Math.max(0, Date.now() - signal.at), elapsedMs: Date.now() - started, queueMs: started - detectedAt, maxSignalAgeMs: this.config.maxSignalAgeMs };
        throw error;
      }
    });
  }
  buyAmount(wallet, decimals) {
    if (this.tool.amountMode === 'custom') return strictUnits(wallet.amount, decimals);
    if (this.tool.amountMode === 'random') { const low = strictUnits(this.tool.randomMin, decimals), high = strictUnits(this.tool.randomMax, decimals); if (high < low) throw Error('Random maximum must be at least the minimum.'); return low + (high - low) * BigInt(randomInt(1000001)) / 1000000n; }
    return strictUnits(this.tool.buyAmount, decimals);
  }
  async ensureWrappedQuote(wallet, token, amount) {
    if (token !== CONTRACTS.weth) return;
    const balance = await this.rpc.balance(wallet.publicKey, token);
    if (balance >= amount) return;
    const abi = parseAbi(['function deposit() payable']);
    this.event('info', 'Wrapping Robinhood ETH for this pool’s WETH quote asset.', { wallet: wallet.publicKey });
    await this.executor.send(wallet, { to: CONTRACTS.weth, data: encodeFunctionData({ abi, functionName: 'deposit' }), value: amount - balance }, { operation: 'wrap' });
  }
  async swap(wallet, pool, input, amount, context, { ppm = this.kind === 'sniper' ? this.policy.sniperPpm : this.kind === 'market' ? this.policy.marketPpm : this.policy.copyPpm, pools = this.pools.snapshot?.() || this.pools } = {}) {
    if (this.kind === 'market' && context.inventory && this.ledger.data.inventory?.[wallet.publicKey]?.budgetCurrency === EVM_NATIVE) return this.swapEth(wallet, pool, amount, context, ppm, pools);
    if (['copy', 'sniper'].includes(this.kind) && !context.inventory && !context.lpFunding && !context.feeLotId) return this.swapEth(wallet, pool, amount, context, ppm, pools);
    this.executor.check(wallet.publicKey);
    if (pool.protocol === 'pons-curve') pool = await this.pools.find(context.token, context.quote);
    if (context.side === 'buy') await this.ensureWrappedQuote(wallet, input, amount);
    const balance = await this.rpc.balance(wallet.publicKey, input); if (amount > balance) { if (context.side === 'sell') amount = balance; else throw Error('The wallet does not have enough of this pool’s quote token.'); }
    if (amount <= 0n) throw Error('No spendable balance for this trade.');
    if (context.side === 'buy' && !context.inventory && !context.lpFunding && !context.feeLotId) {
      const meta = await this.rpc.token(input), limit = strictUnits(this.tool.budget, meta.decimals), key = `${wallet.publicKey}:${input}`, used = this.spent.get(key) || 0n;
      if (limit > 0n && used + amount > limit) throw Error('This wallet’s run budget has been reached.');
    }
    if (context.inventory && context.side === 'buy' && BigInt(this.ledger.data.inventory?.[wallet.publicKey]?.quoteAvailable || 0) < amount) throw Error('The managed inventory budget cannot cover this buy.');
    const args = { pools: this.pools, pool, input, amount, wallet: wallet.publicKey, recipient: this.policy.recipient, adapter: this.policy.adapter, ppm, slippageBps: this.config.slippageBps, feePool: this.tool.feePool };
    let plan = await buildSwapPlan(args); await this.executor.approvals(wallet, plan.approvals);
    this.abort.signal.throwIfAborted(); plan = await buildSwapPlan(args);
    const token = await this.rpc.token(context.token), quote = await this.rpc.token(context.quote);
    const receipt = await this.executor.send(wallet, plan, { ...context, operation: 'swap', pool, input, amount: String(amount), inputAccounting: 'receipt', minimum: plan.minimum, tokenDecimals: token.decimals, tokenSymbol: token.symbol, quoteDecimals: quote.decimals, quoteSymbol: quote.symbol });
    return receipt;
  }
  async swapEth(wallet, pool, amount, context, ppm, pools = this.pools) {
    this.executor.check(wallet.publicKey);
    if (pool.protocol === 'pons-curve') pool = await pools.find(context.token, otherCurrency(pool, context.token));
    const buy = context.side === 'buy', input = buy ? EVM_NATIVE : context.token;
    // The executor performs the authoritative fresh ETH + gas/reserve check.
    // ERC20 sells still clamp to the current token balance before quoting.
    if (!buy) { const balance = await this.rpc.balance(wallet.publicKey, input); if (amount > balance) amount = balance; }
    if (amount <= 0n) throw Error('No spendable balance for this trade.');
    if (context.lpEthFunding) {
      const funds = this.ledger.data.lpFunds?.[wallet.publicKey];
      if (!funds || funds.token !== context.allocationToken || funds.quote !== context.allocationQuote || context.token !== funds.quote) throw Error('The LP ETH funding allocation is missing.');
      const available = buy ? funds.ethAvailable : funds.quoteAvailable;
      if (BigInt(available || 0) < amount) throw Error('The tracked LP budget cannot cover this conversion.');
    } else if (buy && context.inventory) {
      const allocation = this.ledger.data.inventory?.[wallet.publicKey];
      if (allocation?.budgetCurrency !== EVM_NATIVE || allocation.token !== context.token || allocation.quote !== context.quote || BigInt(allocation.ethAvailable) < amount) throw Error('The managed ETH budget cannot cover this buy.');
    } else if (buy) {
      const limit = strictUnits(this.tool.budget, 18), used = this.spent.get(`${wallet.publicKey}:${EVM_NATIVE}`) || 0n;
      if (limit > 0n && used + amount > limit) throw Error('This wallet’s ETH run budget has been reached.');
    }
    const args = { pools, pool, token: context.token, buy, amount, wallet: wallet.publicKey, recipient: this.policy.recipient, adapter: this.policy.adapter, ppm, slippageBps: this.config.slippageBps, feePool: this.tool.feePool };
    const routeStarted = Date.now();
    let plan = await buildEthTradePlan(args);
    let routeMs = Date.now() - routeStarted;
    const approvalsStarted = Date.now();
    await this.executor.approvals(wallet, plan.approvals);
    const approvalMs = Date.now() - approvalsStarted;
    this.abort.signal.throwIfAborted();
    if (plan.approvals.length) { const rebuiltAt = Date.now(); plan = await buildEthTradePlan({ ...args, pools: this.pools.snapshot?.() || this.pools }); routeMs += Date.now() - rebuiltAt; }
    const token = await this.rpc.token(context.token);
    return this.executor.send(wallet, plan, { ...context, timing: { routeMs, approvalMs }, operation: 'swap', nativeTrade: true, pool, quote: plan.quote, costCurrency: EVM_NATIVE, input, amount: String(amount), minimum: plan.minimum, tokenDecimals: token.decimals, tokenSymbol: token.symbol, quoteDecimals: 18, quoteSymbol: 'ETH' });
  }
  confirmed(pending, receipt) {
    // Receipt application is synchronous and staged. A rejected receipt must
    // leave budgets, lots and deduplication unchanged for the next retry.
    const before = this.ledger.data, spentBefore = this.spent;
    this.ledger.data = structuredClone(before); this.spent = new Map(spentBefore);
    try { this.applyConfirmed(pending, receipt); }
    catch (error) { this.ledger.data = before; this.spent = spentBefore; throw error; }
  }
  applyConfirmed(pending, receipt) {
    const c = { ...pending.context };
    if (c.operation === 'swap' && c.nativeTrade) {
      const execution = ethExecution({ ...pending, from: pending.wallet }, receipt);
      if (execution.token !== c.token || execution.buy !== (c.side === 'buy') || execution.inputSpent !== BigInt(c.amount)) throw Error('ETH trade receipt does not match its journal.');
      const delta = tokenDelta(receipt, pending.wallet, c.token);
      if (execution.buy ? delta !== execution.output : -delta !== execution.inputSpent) throw Error('ETH trade token transfers do not match its execution receipt.');
      c.amount = String(execution.inputSpent); c.minimum = String(execution.output);
    }
    if (c.operation === 'swap' && !c.nativeTrade && c.pool?.protocol === 'pons-curve') {
      const executions = (receipt.logs || []).filter(log => log.address.toLowerCase() === pending.to.toLowerCase()).flatMap(log => { try { const d = decodeEventLog({ abi: adapterAbi, eventName: 'CurveTraded', topics: log.topics, data: log.data }); return d.args.wallet.toLowerCase() === pending.wallet.toLowerCase() && d.args.token.toLowerCase() === c.token.toLowerCase() ? [d.args] : []; } catch { return []; } });
      if (executions.length !== 1 || executions[0].inputSpent > BigInt(c.amount) || executions[0].buy !== (c.side === 'buy') || executions[0].output < BigInt(c.minimum)) throw Error('Launchpad execution receipt does not match its signed limits.');
      c.amount = String(executions[0].inputSpent); c.minimum = String(executions[0].output);
    }
    if (this.ledger.data.seen.includes(`fill:${pending.signature}`)) return;
    if (c.lpEthFunding) {
      const funds = this.ledger.data.lpFunds?.[pending.wallet];
      if (!funds || funds.token !== c.allocationToken || funds.quote !== c.allocationQuote || c.token !== funds.quote) throw Error('The LP ETH funding allocation is missing; keeping its receipt pending.');
      const buying = c.side === 'buy', before = BigInt(buying ? funds.ethAvailable : funds.quoteAvailable);
      const output = c.operation === 'lp-wrap' ? verifyWrappedEth(pending, receipt) : c.nativeTrade ? BigInt(c.minimum) : 0n;
      if (output <= 0n || before < BigInt(c.amount)) throw Error('LP conversion exceeded its tracked budget or has no verified output.');
      if (buying) {
        funds.ethAvailable = String(before - BigInt(c.amount));
        funds.quoteAvailable = String(BigInt(funds.quoteAvailable) + output);
        funds.fundingComplete = true;
      } else {
        funds.quoteAvailable = String(before - BigInt(c.amount));
        funds.ethAvailable = String(BigInt(funds.ethAvailable || 0) + output);
      }
      this.ledger.data.seen.push(`fill:${pending.signature}`); this.emit('change'); return;
    }
    if (c.operation === 'swap' && c.inputAccounting === 'receipt' && c.input !== EVM_NATIVE && c.pool?.protocol !== 'pons-curve') {
      // Exact-input routes can fill partially and refund the rest. Budget and
      // entry cost must use the net wallet debit, including the input fee.
      const spent = -tokenDelta(receipt, pending.wallet, c.input);
      if (spent <= 0n || spent > BigInt(c.amount)) throw Error('Swap input debit does not match its signed maximum.');
      c.amount = String(spent);
    }
    if (c.operation === 'lp-claim' || c.operation === 'lp-compound' || c.feeLotId) {
      const lot = this.ledger.data.lots.find(l => l.id === (c.lotId || c.feeLotId) && l.wallet === pending.wallet);
      if (!lot) throw Error('LP fee allocation is missing; keeping its receipt pending.');
      lot.feeCredits ||= {};
      for (const [i, mint] of [lot.pool.currency0, lot.pool.currency1].entries()) {
        let delta = tokenDelta(receipt, pending.wallet, mint);
        if (mint === EVM_NATIVE) delta = c.operation === 'lp-claim' ? BigInt(c.minimums?.[i] || 0) : c.operation === 'lp-compound' ? -BigInt(c.maximums[i]) : c.input === mint ? -BigInt(c.amount) : BigInt(c.minimum);
        if (c.operation === 'lp-claim') {
          if (delta < 0n) throw Error('Fee claim has a negative asset receipt.');
          lot.claimedFees ||= {}; lot.claimedFees[mint] = String(BigInt(lot.claimedFees[mint] || 0) + delta);
          if (c.compound) lot.feeCredits[mint] = String(BigInt(lot.feeCredits[mint] || 0) + delta);
        } else {
          const next = BigInt(lot.feeCredits[mint] || 0) + delta; if (next < 0n) throw Error('Reinvestment exceeded its tracked fee proceeds.'); lot.feeCredits[mint] = String(next);
        }
      }
      if (c.operation === 'lp-compound') {
        let added = BigInt(c.liquidity);
        if (lot.pool.protocol === 'v3') {
          const increases = (receipt.logs || []).filter(log => log.address.toLowerCase() === CONTRACTS.v3PositionManager.toLowerCase()).flatMap(log => { try { const d = decodeEventLog({ abi: v3PositionAbi, topics: log.topics, data: log.data }); return d.eventName === 'IncreaseLiquidity' && String(d.args.tokenId) === lot.tokenId ? [d.args.liquidity] : []; } catch { return []; } });
          if (increases.length !== 1 || !increases[0]) throw Error('Compounded liquidity receipt is missing.'); added = increases[0];
        }
        lot.liquidity = String(BigInt(lot.liquidity) + added); lot.lastCompoundedAt = Date.now();
      }
      this.ledger.data.seen.push(`fill:${pending.signature}`); this.emit('change'); return;
    }
    if (c.operation === 'swap') {
      if (c.side === 'buy' && !c.inventory && !c.lpFunding) { const key = `${pending.wallet}:${c.input}`; this.spent.set(key, (this.spent.get(key) || 0n) + BigInt(c.amount)); }
      if (c.inventory) {
        const inventory = this.ledger.data.inventory?.[pending.wallet];
        if (!inventory || inventory.quote !== c.quote || inventory.token !== c.token) throw Error('Managed inventory allocation is missing; keeping its receipt pending.');
        if (inventory.budgetCurrency === EVM_NATIVE) {
          if (!c.nativeTrade) throw Error('An ETH inventory trade requires a verified ETH execution receipt.');
          const available = BigInt(inventory.ethAvailable);
          if (c.side === 'buy' && available < BigInt(c.amount)) throw Error('The receipt exceeds its managed ETH budget.');
          inventory.ethAvailable = String(c.side === 'buy' ? available - BigInt(c.amount) : available + BigInt(c.minimum));
        }
        else if (c.side === 'buy') { if (BigInt(inventory.quoteAvailable) < BigInt(c.amount)) throw Error('The receipt exceeds its managed inventory budget.'); inventory.quoteAvailable = String(BigInt(inventory.quoteAvailable) - BigInt(c.amount)); }
        else { const actual = c.quote === EVM_NATIVE ? BigInt(c.minimum) : tokenDelta(receipt, pending.wallet, c.quote); if (actual <= 0n) throw Error('The inventory sale has no verifiable proceeds.'); inventory.quoteAvailable = String(BigInt(inventory.quoteAvailable) + actual); }
      }
      if (c.lpFunding) {
        const funds = this.ledger.data.lpFunds?.[pending.wallet];
        if (!funds || funds.token !== c.token || funds.quote !== c.quote) throw Error('LP budget is missing; keeping its receipt pending.');
        const delta = tokenDelta(receipt, pending.wallet, c.token);
        const proceeds = c.quote === EVM_NATIVE ? BigInt(c.minimum) : tokenDelta(receipt, pending.wallet, c.quote);
        if (c.side === 'buy') {
          if (delta <= 0n || BigInt(funds.quoteAvailable) < BigInt(c.amount)) throw Error('LP funding receipt could not be verified.');
          funds.quoteAvailable = String(BigInt(funds.quoteAvailable) - BigInt(c.amount)); funds.tokenAvailable = String(BigInt(funds.tokenAvailable) + delta);
        } else {
          if (delta >= 0n || proceeds <= 0n || BigInt(funds.tokenAvailable) < -delta) throw Error('LP funding sale could not be verified.');
          funds.tokenAvailable = String(BigInt(funds.tokenAvailable) + delta); funds.quoteAvailable = String(BigInt(funds.quoteAvailable) + proceeds);
        }
      } else if (c.side === 'buy') {
        const received = tokenDelta(receipt, pending.wallet, c.token);
        if (received <= 0n) throw Error('Confirmed swap has no verifiable token receipt; keeping it pending for reconciliation.');
        this.ledger.data.lots.push({ id: randomUUID(), wallet: pending.wallet, kind: this.kind, lead: c.lead || '', token: c.token, quote: c.quote, pool: c.pool, remaining: String(received), cost: c.amount, costCurrency: c.costCurrency || c.quote, nativeTrade: !!c.nativeTrade, entryAmount: c.amount, entryTokens: String(received), decimals: c.tokenDecimals, symbol: c.tokenSymbol, quoteDecimals: c.quoteDecimals, quoteSymbol: c.quoteSymbol, at: Date.now(), nextStep: 1, signature: pending.signature, copySequence: c.copySequence || 0 });
      } else {
        let spent = -tokenDelta(receipt, pending.wallet, c.token);
        if (spent <= 0n) throw Error('Confirmed sale has no verifiable token debit; keeping it pending for reconciliation.');
        for (const lot of this.ledger.data.lots.filter(l => l.wallet === pending.wallet && l.token === c.token && (!c.lotIds || c.lotIds.includes(l.id)))) {
          const old = BigInt(lot.remaining || 0), used = old < spent ? old : spent; if (!old) continue;
          lot.remaining = String(old - used); lot.cost = String(BigInt(lot.cost || 0) * (old - used) / old); spent -= used;
          if (c.ladder) lot.nextStep = (lot.nextStep || 1) + 1; if (!spent) break;
        }
      }
    } else if (c.operation === 'lp-deposit') {
      const manager = c.lot.pool.protocol === 'v3' ? CONTRACTS.v3PositionManager : CONTRACTS.positionManager;
      let tokenId, actualLiquidity = c.lot.liquidity;
      if (c.lot.pool.protocol === 'v2') {
        const units = tokenDelta(receipt, pending.wallet, c.lot.pool.address);
        if (units <= 0n) throw Error('LP tokens were not received; keeping the deposit pending.');
        actualLiquidity = String(units); tokenId = c.lot.pool.address;
      } else {
        const minted = receipt.logs.find(log => { if (log.address.toLowerCase() !== manager.toLowerCase()) return false; try { const d = decodeEventLog({ abi: positionAbi, eventName: 'Transfer', topics: log.topics, data: log.data }); return d.args.from === EVM_NATIVE && d.args.to.toLowerCase() === pending.wallet.toLowerCase(); } catch { return false; } });
        if (!minted) throw Error('LP receipt was not found; keeping the deposit pending.');
        tokenId = String(decodeEventLog({ abi: positionAbi, eventName: 'Transfer', topics: minted.topics, data: minted.data }).args.tokenId);
        if (c.lot.pool.protocol === 'v3') {
          const increases = receipt.logs.filter(log => log.address.toLowerCase() === manager.toLowerCase()).flatMap(log => { try { const d = decodeEventLog({ abi: v3PositionAbi, eventName: 'IncreaseLiquidity', topics: log.topics, data: log.data }); return String(d.args.tokenId) === tokenId ? [d.args.liquidity] : []; } catch { return []; } });
          if (increases.length !== 1 || !increases[0]) throw Error('V3 liquidity receipt is missing.'); actualLiquidity = String(increases[0]);
        }
      }
      const funds = this.ledger.data.lpFunds?.[pending.wallet];
      if (!funds || funds.token !== c.lot.token || funds.quote !== c.lot.quote) throw Error('LP budget is missing; keeping its deposit pending.');
      const tokenUsed = -tokenDelta(receipt, pending.wallet, c.lot.token), quoteUsed = c.lot.quote === EVM_NATIVE ? BigInt(c.lot.quoteMaximum) : -tokenDelta(receipt, pending.wallet, c.lot.quote);
      if (tokenUsed < 0n || quoteUsed < 0n || tokenUsed > BigInt(funds.tokenAvailable) || quoteUsed > BigInt(funds.quoteAvailable)) throw Error('LP deposit exceeded its managed budget.');
      funds.tokenAvailable = String(BigInt(funds.tokenAvailable) - tokenUsed); funds.quoteAvailable = String(BigInt(funds.quoteAvailable) - quoteUsed);
      this.ledger.data.lots.push({ ...c.lot, id: randomUUID(), kind: 'liquidity', tokenId, liquidity: actualLiquidity, wallet: pending.wallet, at: Date.now(), signature: pending.signature });
      let deposited = -tokenDelta(receipt, pending.wallet, c.lot.token);
      for (const lot of this.ledger.data.lots.filter(l => l.wallet === pending.wallet && l.token === c.lot.token && BigInt(l.remaining || 0))) { const old = BigInt(lot.remaining), used = old < deposited ? old : deposited; if (used <= 0n) break; lot.remaining = String(old - used); lot.cost = String(BigInt(lot.cost || 0) * (old - used) / old); deposited -= used; }
    } else if (c.operation === 'lp-withdraw') {
      const lot = this.ledger.data.lots.find(l => l.id === c.lotId); if (lot) {
        const funds = this.ledger.data.lpFunds?.[pending.wallet];
        if (!funds || funds.token !== lot.token || funds.quote !== lot.quote) throw Error('LP budget is missing; keeping its withdrawal pending.');
        const tokenReceived = tokenDelta(receipt, pending.wallet, lot.token), quoteReceived = lot.quote === EVM_NATIVE ? BigInt(c.minimumQuote || 0) : tokenDelta(receipt, pending.wallet, lot.quote);
        if (tokenReceived < 0n || quoteReceived < 0n) throw Error('LP proceeds could not be verified.');
        funds.tokenAvailable = String(BigInt(funds.tokenAvailable) + tokenReceived); funds.quoteAvailable = String(BigInt(funds.quoteAvailable) + quoteReceived);
        if (lot.feeCredits) { funds.tokenAvailable = String(BigInt(funds.tokenAvailable) + BigInt(lot.feeCredits[lot.token] || 0)); funds.quoteAvailable = String(BigInt(funds.quoteAvailable) + BigInt(lot.feeCredits[lot.quote] || 0)); lot.feeCredits = {}; }
        lot.liquidity = '0'; lot.closedAt = Date.now(); lot.rebalance = c.automatic === true;
        if (!c.automatic && funds.budgetCurrency === EVM_NATIVE) funds.exitToEth = true;
      }
    }
    if (c.copySellId) this.finishCopySell(c.copySellId);
    this.ledger.data.seen.push(`fill:${pending.signature}`); this.emit('change');
  }
  async refreshInventory() {
    if (!this.rpc || this.abort.signal.aborted) return;
    const keys = new Set(), lpBalances = new Map();
    for (const lot of this.ledger.data.lots) {
      if (lot.kind === 'liquidity') {
        if (!BigInt(lot.liquidity || 0) || this.executor.queues.has(lot.wallet) || this.ledger.data.pending.some(p => p.wallet === lot.wallet)) continue;
        const revision = this.ledger.data.seen.length;
        let liquidity;
        if (lot.pool.protocol === 'v2') { const key = `${lot.wallet}:${lot.pool.address}`; if (!lpBalances.has(key)) lpBalances.set(key, await this.rpc.balance(lot.wallet, lot.pool.address)); const remaining = lpBalances.get(key), old = BigInt(lot.liquidity); liquidity = remaining < old ? remaining : old; lpBalances.set(key, remaining - liquidity); }
        else liquidity = await liveLpLiquidity(this.rpc, lot);
        if (revision === this.ledger.data.seen.length && !this.executor.queues.has(lot.wallet) && !this.ledger.data.pending.some(p => p.wallet === lot.wallet)) lot.liquidity = String(liquidity);
        continue;
      }
      const key = `${lot.wallet}:${lot.token}`; if (keys.has(key) || !BigInt(lot.remaining || 0) || this.executor.queues.has(lot.wallet) || this.ledger.data.pending.some(p => p.wallet === lot.wallet)) continue; keys.add(key);
      const revision = this.ledger.data.seen.length;
      let balance = await this.rpc.balance(lot.wallet, lot.token);
      if (revision !== this.ledger.data.seen.length || this.executor.queues.has(lot.wallet) || this.ledger.data.pending.some(p => p.wallet === lot.wallet)) continue;
      for (const item of this.ledger.data.lots.filter(l => l.wallet === lot.wallet && l.token === lot.token)) {
        const old = BigInt(item.remaining || 0), actual = old < balance ? old : balance;
        if (old > actual) { item.cost = String(BigInt(item.cost || 0) * actual / old); item.remaining = String(actual); }
        balance -= actual;
        if (actual > 0n) {
          try { const quoted = await this.quoteLot(item, actual); item.quoteValue = String(quoted); item.quotePnl = String(quoted - BigInt(item.cost || 0)); item.priceAt = Date.now(); } catch { item.quoteValue = null; item.quotePnl = null; }
        }
      }
    }
    await this.ledger.save(); this.emit('change');
  }
  async ladderTick() {
    if (!['copy', 'sniper'].includes(this.kind)) return;
    for (const wallet of this.config.wallets) this.enqueue(wallet, async () => {
      for (const lot of this.ledger.data.lots.filter(l => l.wallet === wallet.publicKey && BigInt(l.remaining || 0) > 0n)) {
        const output = await this.quoteLot(lot, BigInt(lot.remaining));
        const threshold = BigInt(Math.round((1 + this.tool.percentStep / 100 * (lot.nextStep || 1)) * 1000000));
        if (output * 1000000n >= BigInt(lot.cost) * threshold) {
          const amount = BigInt(lot.remaining) * BigInt(Math.round(this.tool.sellPercent * 100)) / 10000n;
          if (amount > 0n) await this.swap(wallet, lot.pool, lot.token, amount, { side: 'sell', token: lot.token, quote: lot.quote, lotIds: [lot.id], ladder: true });
        }
      }
    });
  }
  async quoteLot(lot, amount) {
    const pool = lot.pool.protocol === 'pons-curve' ? await this.pools.find(lot.token, lot.quote) : lot.pool;
    if (lot.costCurrency !== EVM_NATIVE || !['copy', 'sniper'].includes(lot.kind) && !lot.nativeTrade) return this.pools.quote(pool, lot.token, amount);
    const plan = await buildEthTradePlan({ pools: this.pools, pool, token: lot.token, buy: false, amount, wallet: lot.wallet, recipient: this.policy.recipient, adapter: this.policy.adapter, ppm: this.kind === 'market' ? this.policy.marketPpm : this.kind === 'sniper' ? this.policy.sniperPpm : this.policy.copyPpm, slippageBps: this.config.slippageBps, feePool: this.tool.feePool });
    return BigInt(plan.quoted);
  }
  async manualTrade(raw, trade) {
    if (!['copy', 'sniper', 'market'].includes(this.kind) || this.operation) throw Error('Manual trading is unavailable while another operation is starting.');
    if (this.kind === 'market' && (this.state !== 'stopped' || trade?.side !== 'sell')) throw Error('Stop Market Making before manually selling managed inventory.');
    if (typeof trade?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(trade.id)) throw Error('A manual trade request ID is required.');
    if (!['buy', 'sell'].includes(trade.side)) throw Error('Choose Buy or Sell.');
    const identity = manualIdentity(trade), previous = this.ledger.data.manualRequests?.find(r => r.id === trade.id);
    if (previous) {
      if (previous.identity !== identity) throw Error('This request ID was already used for different trade settings.');
      this.lastManualId = trade.id;
      if (!previous.complete) { previous.complete = true; for (const result of previous.results) if (result.state === 'queued') Object.assign(result, { state: 'skipped', error: 'The previous session ended before this wallet completed. Check pending transactions and Activity before making a new request.' }); await this.ledger.save(); }
      return this.status();
    }
    if (this.ledger.data.seen.includes(`manual:${trade.id}`)) {
      (this.ledger.data.manualRequests ||= []).push({ id: trade.id, identity, side: trade.side, complete: true, results: (trade.wallets || []).map(wallet => ({ wallet, state: 'skipped', error: 'This request was already accepted. Check Activity; it will not be repeated.' })) });
      this.lastManualId = trade.id; await this.ledger.save(); return this.status();
    }
    const wasStopped = this.state === 'stopped'; this.operation = true;
    try {
      if (wasStopped) { this.state = 'starting'; await this.prepare(raw); this.state = 'running'; }
      else if (this.state !== 'running' || raw.rpcUrl !== this.config.rpcUrl || raw.agreedFeeVersion !== this.policy.version) throw Error('Use the active run’s connection and fee settings, or stop first.');
      const token = evmAddress(trade.token), requestedQuote = trade.quote ? evmAddress(trade.quote) : null;
      const managedPair = this.kind === 'market' ? Object.entries(this.ledger.data.inventory || {}).find(([wallet, allocation]) => allocation.token === token && (!trade.wallets || trade.wallets.some(key => evmAddress(key) === wallet)))?.[1] : null;
      const pool = await this.pools.find(token, this.kind === 'market' ? requestedQuote || managedPair?.quote || this.tool.quote : requestedQuote === EVM_NATIVE ? null : requestedQuote, this.tool.pool), quote = otherCurrency(pool, token);
      const keys = (trade.wallets || raw.wallets.map(w => w.publicKey)).map(evmAddress), wallets = this.config.wallets.filter(w => keys.includes(w.publicKey));
      if (!wallets.length || wallets.length !== new Set(keys).size) throw Error('Choose wallets from this run.');
      if (trade.side === 'sell' && (!Number.isFinite(Number(trade.percent)) || Number(trade.percent) <= 0 || Number(trade.percent) > 100)) throw Error('Sell percentage must be above 0 and at most 100.');
      if (trade.side === 'buy' && strictUnits(trade.amount, 18) <= 0n) throw Error('Enter a positive ETH amount.');
      (this.ledger.data.manualRequests ||= []).push({ id: trade.id, identity, side: trade.side, complete: false, results: wallets.map(wallet => ({ wallet: wallet.publicKey, label: wallet.label, state: 'queued' })) });
      this.lastManualId = trade.id;
      await this.ledger.remember(`manual:${trade.id}`);
      const pools = this.pools.snapshot?.() || this.pools;
      await Promise.allSettled(wallets.map(wallet => this.enqueue(wallet, async () => {
        try {
          const inventory = this.kind === 'market';
          if (inventory && (this.ledger.data.inventory?.[wallet.publicKey]?.token !== token || this.ledger.data.inventory?.[wallet.publicKey]?.quote !== quote)) throw Error('Choose this wallet’s managed inventory pair.');
          const balance = await this.rpc.balance(wallet.publicKey, token), managed = this.ledger.data.lots.filter(l => l.wallet === wallet.publicKey && l.token === token).reduce((n, l) => n + BigInt(l.remaining || 0), 0n);
          const sellable = inventory && managed < balance ? managed : balance;
          const input = trade.side === 'buy' ? EVM_NATIVE : token, amount = trade.side === 'buy' ? strictUnits(trade.amount, 18) : sellable * BigInt(Math.round(Number(trade.percent) * 100)) / 10000n;
          const receipt = await this.swap(wallet, pool, input, amount, { side: trade.side, token, quote, inventory, manualId: trade.id }, { pools }); updateManualResult(this.ledger.data, trade.id, wallet.publicKey, { state: 'confirmed', signature: receipt.transactionHash });
        } catch (error) {
          const pending = this.ledger.data.pending.find(p => p.context?.manualId === trade.id && p.wallet === wallet.publicKey);
          updateManualResult(this.ledger.data, trade.id, wallet.publicKey, { state: pending ? 'pending' : 'failed', ...(pending ? { signature: pending.signature } : {}), error: safeError(error) });
          if (!this.abort.signal.aborted) this.event('error', safeError(error), { wallet: wallet.publicKey, manualRequestId: trade.id });
        }
        this.emit('change');
      })));
    } finally {
      try {
        const record = this.ledger.data.manualRequests?.find(r => r.id === trade.id);
        if (record) { record.complete = true; for (const result of record.results) if (result.state === 'queued') Object.assign(result, { state: 'skipped', error: 'Stopped before this wallet submitted a trade.' }); await this.ledger.save(); }
      } finally { this.operation = false; if (wasStopped) { this.abort?.abort(); this.state = 'stopped'; } this.emit('change'); }
    }
    return this.status();
  }
  marketBudget() {
    if (!this.tool.budgetEth || strictUnits(this.tool.budgetEth, 18) <= 0n) throw Error('Enter an ETH budget per wallet. Your previous quote-token amount has not been converted to ETH.');
    return strictUnits(this.tool.budgetEth, 18);
  }
  checkMarketAllocation(wallet) {
    const allocation = this.ledger.data.inventory?.[wallet];
    if (allocation && allocation.budgetCurrency !== EVM_NATIVE && (this.ledger.data.pending.some(p => p.wallet === wallet) || this.ledger.data.lots.some(l => l.wallet === wallet && BigInt(l.remaining || 0) > 0n))) throw Error('This wallet still has positions from a quote-token budget. Close those positions and wait for pending trades before starting an ETH budget.');
    return allocation;
  }
  async marketTick() {
    const pool = this.strategyPool = await this.pools.find(this.tool.token, this.tool.quote, this.strategyPool.protocol === 'pons-curve' ? null : this.strategyPool), token = this.tool.token, quote = this.tool.quote = otherCurrency(pool, token);
    const target = ({ conservative: 35, balanced: 50, active: 65 })[this.tool.preset] ?? this.tool.targetPercent;
    const drift = ({ conservative: 20, balanced: 15, active: 10 })[this.tool.preset] ?? this.tool.driftPercent;
    for (const wallet of this.config.wallets) if (!this.executor.queues.has(wallet.publicKey)) this.enqueue(wallet, async () => {
      this.ledger.data.inventory ||= {};
      this.executor.check(wallet.publicKey);
      let allocation = this.checkMarketAllocation(wallet.publicKey);
      if (allocation && allocation.budgetCurrency !== EVM_NATIVE) {
        // Idle legacy tracking can be replaced, but its quote assets are never spent.
        allocation = null;
        this.event('info', 'Switching this idle market-making budget to ETH. Existing quote tokens remain in the wallet.', { wallet: wallet.publicKey });
      }
      if (allocation && (allocation.token !== token || allocation.quote !== quote)) throw Error('This MM wallet already has a managed allocation for another pair. Use another MM wallet or exit that allocation first.');
      if (!allocation) {
        const budget = this.marketBudget(), balance = await this.rpc.balance(wallet.publicKey, EVM_NATIVE);
        if (balance < budget + strictUnits(this.config.reserveEth, 18)) throw Error('Fund this wallet with its ETH budget plus the ETH gas reserve. Quote tokens are not required.');
        allocation = this.ledger.data.inventory[wallet.publicKey] = { token, quote, budgetCurrency: EVM_NATIVE, budgetEth: String(budget), ethAvailable: String(budget) }; await this.ledger.save();
      }
      const owned = this.ledger.data.lots.filter(l => l.wallet === wallet.publicKey && l.token === token && BigInt(l.remaining || 0) > 0n).reduce((s, l) => s + BigInt(l.remaining), 0n);
      const tokenValue = owned ? await this.quoteLot({ pool, token, quote, wallet: wallet.publicKey, kind: 'market', costCurrency: EVM_NATIVE, nativeTrade: true }, owned) : 0n, budget = BigInt(allocation.ethAvailable) + tokenValue;
      const targetValue = budget * BigInt(target) / 100n, difference = targetValue - tokenValue;
      if ((difference < 0n ? -difference : difference) * 100n <= budget * BigInt(drift)) return;
      if (difference > 0n) {
        const balance = await this.rpc.balance(wallet.publicKey, EVM_NATIVE), spendable = balance - strictUnits(this.config.reserveEth, 18), available = BigInt(allocation.ethAvailable) < spendable ? BigInt(allocation.ethAvailable) : spendable, amount = difference < available ? difference : available;
        if (amount > 0n) await this.swap(wallet, pool, EVM_NATIVE, amount, { side: 'buy', token, quote, inventory: true });
      } else if (owned && tokenValue) {
        const amount = owned * (-difference) / tokenValue;
        if (amount > 0n) await this.swap(wallet, pool, token, amount, { side: 'sell', token, quote, inventory: true });
      }
    });
  }
  async releaseInventory(wallet) {
    if (!['market', 'liquidity'].includes(this.kind) || this.state !== 'stopped' || this.operation) throw Error('Stop this strategy before releasing its budget.');
    wallet = evmAddress(wallet);
    if (this.ledger.data.pending.some(p => p.wallet === wallet) || this.ledger.data.lots.some(l => l.wallet === wallet && BigInt(l.remaining || l.liquidity || 0) > 0n)) throw Error('Close the positions and reconcile pending transactions before releasing this budget.');
    delete this.ledger.data[this.kind === 'market' ? 'inventory' : 'lpFunds']?.[wallet]; await this.ledger.save(); this.emit('change');
  }
  async liquidityTick() {
    for (const wallet of this.config.wallets) if (!this.executor.queues.has(wallet.publicKey)) this.enqueue(wallet, () => {
      // Serialize LP creation across wallets so the account position cap also
      // covers deposits that have been submitted but not yet reconciled.
      const job = (this.lpTask || Promise.resolve()).catch(() => {}).then(() => this.liquidityWallet(wallet));
      this.lpTask = job; return job;
    });
  }
  async liquidityWallet(wallet) {
      this.abort.signal.throwIfAborted();
      if (this.lpPaused.has(wallet.publicKey)) return;
      const pool = this.strategyPool, quote = this.tool.quote, token = this.tool.token;
      this.ledger.data.lpFunds ||= {};
      this.executor.check(wallet.publicKey);
      let funds = this.checkLpAllocation(wallet.publicKey);
      if (funds && funds.budgetCurrency !== EVM_NATIVE) funds = null;
      if (funds && (funds.token !== token || funds.quote !== quote)) throw Error('Release this wallet’s previous LP budget before changing its pair.');
      if (!funds) {
        const budget = this.marketBudget();
        if (await this.rpc.balance(wallet.publicKey, EVM_NATIVE) < budget + strictUnits(this.config.reserveEth, 18)) throw Error('Fund the LP wallet with its ETH budget plus the ETH gas reserve. Pool assets are purchased automatically.');
        this.ledger.data.lpFunds[wallet.publicKey] = { token, quote, budgetCurrency: EVM_NATIVE, budgetEth: String(budget), ethAvailable: String(budget), quoteAvailable: '0', tokenAvailable: '0', fundingComplete: false }; await this.ledger.save();
      }
      funds = this.ledger.data.lpFunds[wallet.publicKey];
      if (funds.exitToEth) { this.lpPaused.add(wallet.publicKey); return this.returnLpEth(wallet, pool); }
      if (!funds.fundingComplete) await this.convertLpQuote(wallet, true, BigInt(funds.ethAvailable));
      const existing = this.ledger.data.lots.filter(l => l.wallet === wallet.publicKey && l.kind === 'liquidity' && BigInt(l.liquidity || 0));
      for (const previous of existing) {
        const lot = this.ledger.data.lots.find(l => l.id === previous.id); if (!lot || !BigInt(lot.liquidity || 0)) continue;
        if (poolId(lot.pool) !== poolId(pool)) throw Error('Withdraw existing LP positions before changing this wallet’s pool.');
        const state = await this.pools.state(lot.pool);
        if (pool.protocol !== 'v2' && (state.tick <= lot.lower || state.tick >= lot.upper)) await this.withdrawLot(wallet, lot, true);
        else if (pool.protocol !== 'v2' && this.tool.autoCompoundFees && Date.now() - (lot.lastFeeCheckAt || 0) >= 300000) { lot.lastFeeCheckAt = Date.now(); await this.ledger.save(); await this.claimLotFees(wallet, lot, true); }
      }
      const open = () => this.ledger.data.lots.filter(l => l.wallet === wallet.publicKey && BigInt(l.liquidity || 0) > 0n);
      while (open().length < this.tool.maxPositions) {
        this.abort.signal.throwIfAborted(); if (this.lpPaused.has(wallet.publicKey)) return;
        if (this.ledger.data.lots.filter(l => BigInt(l.liquidity || 0)).length + this.ledger.data.pending.filter(p => p.context?.operation === 'lp-deposit').length >= 20) throw Error('Maximum 20 open or pending LP positions.');
        funds = this.ledger.data.lpFunds[wallet.publicKey];
        let qAvailable = BigInt(funds.quoteAvailable), tAvailable = BigInt(funds.tokenAvailable);
        const [qBalance, tBalance] = await Promise.all([this.rpc.balance(wallet.publicKey, quote), this.rpc.balance(wallet.publicKey, token)]);
        if (qAvailable > qBalance) qAvailable = qBalance; if (tAvailable > tBalance) tAvailable = tBalance;
        funds.quoteAvailable = String(qAvailable); funds.tokenAvailable = String(tAvailable); await this.ledger.save();
        const tValue = tAvailable ? await this.pools.quote(pool, token, tAvailable) : 0n, half = (qAvailable + tValue) / 2n;
        if (half <= 0n) throw Error('The managed LP budget is empty. Withdraw, release, and fund a new budget.');
        // Rebalance only the tracked LP allocation, in either direction. Other
        // tokens already in the wallet are never adopted into this budget.
        if (qAvailable > half) await this.swap(wallet, pool, quote, qAvailable - half, { side: 'buy', token, quote, lpFunding: true }, { ppm: 0 });
        else if (tValue && half > qAvailable) {
          const amount = tAvailable * (half - qAvailable) / tValue;
          if (amount) await this.swap(wallet, pool, token, amount, { side: 'sell', token, quote, lpFunding: true }, { ppm: 0 });
        }
        funds = this.ledger.data.lpFunds[wallet.publicKey];
        const missing = BigInt(this.tool.maxPositions - open().length), qAmount = BigInt(funds.quoteAvailable) / missing, tAmount = BigInt(funds.tokenAvailable) / missing;
        const args = { pools: this.pools, pool, wallet: wallet.publicKey, amount0: pool.currency0 === quote ? qAmount : tAmount, amount1: pool.currency1 === quote ? qAmount : tAmount, preset: this.tool.preset, rangeBps: this.tool.rangeBps, slippageBps: this.config.slippageBps };
        let plan = await buildLpDeposit(args); await this.executor.approvals(wallet, plan.approvals); plan = await buildLpDeposit(args);
        await this.executor.send(wallet, plan, { operation: 'lp-deposit', lot: { pool, token, quote, quoteMaximum: String(qAmount), liquidity: plan.liquidity, lower: plan.lower, upper: plan.upper } });
      }
  }
  checkLpAllocation(wallet) {
    const funds = this.ledger.data.lpFunds?.[wallet];
    if (funds && funds.budgetCurrency !== EVM_NATIVE && (BigInt(funds.tokenAvailable || 0) || BigInt(funds.quoteAvailable || 0) || this.ledger.data.pending.some(p => p.wallet === wallet) || this.ledger.data.lots.some(l => l.wallet === wallet && BigInt(l.liquidity || l.remaining || 0) > 0n))) throw Error('This wallet has an older LP allocation. Withdraw its positions and release its idle budget before setting an ETH budget.');
    return funds;
  }
  async convertLpQuote(wallet, buy, amount) {
    this.executor.check(wallet.publicKey);
    const funds = this.ledger.data.lpFunds?.[wallet.publicKey], quote = funds?.quote;
    if (!funds || amount <= 0n || amount > BigInt(buy ? funds.ethAvailable || 0 : funds.quoteAvailable || 0)) throw Error('No tracked LP funds are available for this conversion.');
    if (quote === EVM_NATIVE) {
      const previous = structuredClone(funds);
      funds.ethAvailable = String(BigInt(funds.ethAvailable || 0) + (buy ? -amount : amount));
      funds.quoteAvailable = String(BigInt(funds.quoteAvailable) + (buy ? amount : -amount));
      if (buy) funds.fundingComplete = true;
      try { await this.ledger.save(); } catch (error) { this.ledger.data.lpFunds[wallet.publicKey] = previous; throw error; }
      return;
    }
    const context = { lpEthFunding: true, side: buy ? 'buy' : 'sell', token: quote, allocationToken: funds.token, allocationQuote: quote, amount: String(amount) };
    if (quote === CONTRACTS.weth) return this.executor.send(wallet, wrappedEthPlan(buy, amount), { ...context, operation: 'lp-wrap' });
    const path = await ethFundingPath(this.pools, quote, { feePool: this.tool.feePool, avoid: funds.token });
    return this.swapEth(wallet, path.at(-1).pool, amount, context, 0);
  }
  async returnLpEth(wallet, pool) {
    this.executor.check(wallet.publicKey);
    let funds = this.ledger.data.lpFunds?.[wallet.publicKey];
    if (!funds) throw Error('No LP budget is available to withdraw.');
    this.lpPaused.add(wallet.publicKey);
    funds.exitToEth = true; await this.ledger.save();
    const tokenBalance = await this.rpc.balance(wallet.publicKey, funds.token), tracked = BigInt(funds.tokenAvailable);
    const amount = tracked < tokenBalance ? tracked : tokenBalance;
    if (amount) await this.swap(wallet, pool, funds.token, amount, { side: 'sell', token: funds.token, quote: funds.quote, lpFunding: true }, { ppm: 0 });
    funds = this.ledger.data.lpFunds[wallet.publicKey];
    const balance = await this.rpc.balance(wallet.publicKey, funds.quote), available = BigInt(funds.quoteAvailable);
    const quoteAmount = available < balance ? available : balance;
    if (quoteAmount) await this.convertLpQuote(wallet, false, quoteAmount);
    this.event('info', 'Available LP proceeds returned to Robinhood ETH. No additional Launchpad conversion fee was charged.', { wallet: wallet.publicKey });
  }
  async convertInventory(walletAddress, raw) {
    if (this.kind !== 'liquidity' || this.state !== 'stopped' || this.operation) throw Error('Stop Liquidity before completing its ETH withdrawal.');
    this.operation = true;
    try {
      await this.prepare(raw);
      const wallet = this.config.wallets.find(w => w.publicKey === evmAddress(walletAddress)), funds = this.ledger.data.lpFunds?.[wallet?.publicKey];
      if (!wallet || !funds) throw Error('Choose a wallet with an LP budget.');
      const pool = await this.pools.find(funds.token, funds.quote, this.tool.pool);
      await this.enqueue(wallet, () => this.returnLpEth(wallet, pool));
    } finally { this.operation = false; this.abort?.abort(); this.state = 'stopped'; this.emit('change'); }
    return this.status();
  }
  async withdrawLot(wallet, lot, automatic) {
    lot = this.ledger.data.lots.find(l => l.id === lot.id && l.wallet === wallet.publicKey);
    if (!lot || !BigInt(lot.liquidity || 0)) throw Error('This LP position is already closed.');
    const args = { rpc: this.rpc, pools: this.pools, lot, wallet: wallet.publicKey, automatic, recipient: this.policy.recipient, adapter: this.policy.adapter, slippageBps: this.config.slippageBps, feePool: this.tool.feePool };
    let plan = await buildLpWithdrawal(args); await this.executor.approvals(wallet, plan.approvals); plan = await buildLpWithdrawal(args);
    return this.executor.send(wallet, plan, { operation: 'lp-withdraw', lotId: lot.id, automatic, minimumQuote: plan.minimumAmounts[lot.pool.currency0 === lot.quote ? 0 : 1] });
  }
  async claimLotFees(wallet, lot, compound = false) {
    lot = this.ledger.data.lots.find(l => l.id === lot.id && l.wallet === wallet.publicKey);
    if (!lot || !BigInt(lot.liquidity || 0)) throw Error('This LP position is already closed.');
    let plan = await buildFeeClaim({ rpc: this.rpc, lot, wallet: wallet.publicKey, slippageBps: this.config.slippageBps });
    if (compound) {
      const amounts = [lot.pool.currency0, lot.pool.currency1].map((m, i) => BigInt(plan?.amounts[i] || 0) + BigInt(lot.feeCredits?.[m] || 0));
      const value = await referenceEth(this.pools, lot.pool, amounts, this.tool.feePool), block = await this.rpc.client.getBlock();
      const gasPrice = (block.baseFeePerGas || 0n) * 2n + parseGwei(this.config.priorityGwei);
      if (!value || value < gasPrice * 1000000n * 5n) return;
    }
    if (plan) await this.executor.send(wallet, plan, { operation: 'lp-claim', lotId: lot.id, compound, minimums: plan.minimumAmounts });
    else if (!compound) this.event('info', 'No claimable fees on this LP position yet.', { wallet: wallet.publicKey });
    if (!compound) return;
    lot = this.ledger.data.lots.find(l => l.id === lot.id);
    for (const mint of [lot.pool.currency0, lot.pool.currency1]) { const balance = await this.rpc.balance(wallet.publicKey, mint), credit = BigInt(lot.feeCredits?.[mint] || 0); if (credit > balance) lot.feeCredits[mint] = String(balance); }
    let t = BigInt(lot.feeCredits?.[lot.token] || 0), q = BigInt(lot.feeCredits?.[lot.quote] || 0), tValue = t ? await this.pools.quote(lot.pool, lot.token, t) : 0n, half = (q + tValue) / 2n;
    if (q > half) await this.swap(wallet, lot.pool, lot.quote, q - half, { side: 'buy', token: lot.token, quote: lot.quote, feeLotId: lot.id }, { ppm: 0 });
    else if (tValue && half > q) { const amount = t * (half - q) / tValue; if (amount) await this.swap(wallet, lot.pool, lot.token, amount, { side: 'sell', token: lot.token, quote: lot.quote, feeLotId: lot.id }, { ppm: 0 }); }
    lot = this.ledger.data.lots.find(l => l.id === lot.id);
    const args = { rpc: this.rpc, pools: this.pools, lot, wallet: wallet.publicKey, amounts: lot.feeCredits || {}, slippageBps: this.config.slippageBps };
    plan = await buildFeeCompound(args); if (!plan) return;
    await this.executor.approvals(wallet, plan.approvals); plan = await buildFeeCompound(args); if (!plan) return;
    await this.executor.send(wallet, plan, { operation: 'lp-compound', lotId: lot.id, maximums: plan.maximums, liquidity: plan.liquidity });
  }
  async claimFees(allocation, raw) {
    if (this.kind !== 'liquidity' || this.operation) throw Error('Fee claiming is unavailable during startup.');
    const wasStopped = this.state === 'stopped'; this.operation = true;
    try {
      if (wasStopped) { this.state = 'starting'; await this.prepare(raw); this.state = 'running'; }
      const lot = this.ledger.data.lots.find(l => l.id === allocation.id && l.wallet === allocation.wallet), wallet = this.config.wallets.find(w => w.publicKey === allocation.wallet);
      if (!lot || !wallet) throw Error('Choose an LP position owned by a selected wallet.');
      if (lot.pool.protocol === 'v2') throw Error('Uniswap v2 fees already accrue inside its LP reserves. Withdraw liquidity to realize them.');
      await this.enqueue(wallet, () => this.claimLotFees(wallet, lot, false));
    } finally { this.operation = false; if (wasStopped) { this.abort?.abort(); this.state = 'stopped'; } this.emit('change'); }
    return this.status();
  }
  async withdraw(allocation, raw) {
    if (this.kind !== 'liquidity' || this.operation) throw Error('LP withdrawal is unavailable during startup.');
    const wasStopped = this.state === 'stopped'; this.operation = true;
    try {
      if (wasStopped) { this.state = 'starting'; await this.prepare(raw); this.state = 'running'; }
      const lot = this.ledger.data.lots.find(l => l.id === allocation.id && l.wallet === allocation.wallet), wallet = this.config.wallets.find(w => w.publicKey === allocation.wallet);
      if (!lot || !wallet) throw Error('Choose an LP position owned by a selected wallet.');
      this.lpPaused.add(wallet.publicKey);
      await this.enqueue(wallet, async () => {
        await this.withdrawLot(wallet, lot, false);
        if (this.ledger.data.lpFunds[wallet.publicKey]?.budgetCurrency === EVM_NATIVE) await this.returnLpEth(wallet, lot.pool);
      });
    } finally { this.operation = false; if (wasStopped) { this.abort?.abort(); this.state = 'stopped'; } this.emit('change'); }
  }
}
export { safeError };
