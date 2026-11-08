import { parentPort, workerData } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { installTelegramNetworkGuard, publicEndpoint } from './telegram-network.mjs';
import { TelegramStore, TelegramLedger } from './telegram-store.mjs';
import { RunErrorStop } from './run-error-stop.mjs';
// Install before even loading web3.js through the shared config helpers.
if (parentPort && workerData) installTelegramNetworkGuard();
const [{ invariant, parseWallet }, { strategyRunSettings }] = await Promise.all([import('./core.mjs'), import('./telegram-strategy.mjs')]);

const kinds = new Set(['copy', 'market', 'liquidity', 'sniper']);
const modes = new Set(['live', 'paper']);
const safeError = error => String(error?.message || 'Operation failed.').replace(/(?:https?|wss?):\/\/\S+/g, '[provider]').slice(0, 300);
const pause = () => new Promise(resolve => setTimeout(resolve, 25));

// Both engines stay inside one user's guarded worker. They have separate ledgers
// and a shared lifecycle gate, so menus cannot start competing jobs on a wallet.
export class TelegramRuntime extends EventEmitter {
  constructor(engine, portfolio, { inventoryProviderFactory = null } = {}) {
    super(); this.engine = engine; this.portfolio = portfolio; this.inventoryProviderFactory = inventoryProviderFactory; this.copyViewMode = null;
    this.kind = 'copy'; this.mode = 'live'; this.closing = false; this.operation = null; this.generation = 0;
    this.inventoryRefreshTask = null; this.inventoryRefreshAbort = null; this.inventoryProvider = null; this.inventoryProviderKey = null;
    for (const selected of [engine, portfolio]) selected.on('change', () => this.emit('change'));
  }
  get state() {
    const states = [this.engine.state, this.portfolio.state];
    if (states.includes('stopping')) return 'stopping';
    if (states.includes('starting')) return 'starting';
    if (states.includes('running')) return 'running';
    return 'stopped';
  }
  status() {
    const selected = this.portfolio.state !== 'stopped' ? this.portfolio : this.engine.state !== 'stopped' ? this.engine : ['copy', 'sniper'].includes(this.kind) ? this.engine : this.portfolio;
    const copy = this.engine.status(this.engine.state === 'stopped' && this.copyViewMode ? this.copyViewMode : undefined);
    const value = selected === this.portfolio ? selected.status(this.mode) : copy;
    return { ...value, state: this.state, kind: this.kind, mode: this.mode,
      views: { copy, portfolioLive: this.portfolio.status('live'), portfolioPaper: this.portfolio.status('paper') } };
  }
  checkConfig(raw) {
    invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid run settings.');
    invariant(modes.has(raw.mode ?? 'paper'), 'Choose Live or Paper mode.');
    for (const name of ['rpcUrl', 'jitoUrl', 'senderUrl', 'wsUrl']) if (raw[name]) publicEndpoint(raw[name], name === 'wsUrl');
  }
  walletAddresses(raw) { return (raw.wallets || []).map((w, i) => parseWallet({ ...w }, i, 'live').publicKey); }
  checkCopiedWallets(addresses) {
    const data = this.engine.ledgers.live.data;
    invariant(!data.pending.some(p => addresses.includes(p.wallet)) && !data.lots.some(l => addresses.includes(l.wallet) && BigInt(l.remaining) > 0n), 'These wallets have copied positions or pending trades. Use separate wallets for this strategy.');
  }
  async cancelInventoryRefresh() {
    this.inventoryRefreshAbort?.abort();
    await this.inventoryRefreshTask?.catch(() => {});
  }
  refreshInventory(raw) {
    if (this.inventoryRefreshTask) return this.inventoryRefreshTask;
    if (this.closing || this.operation || this.state !== 'stopped' || this.storageError) return Promise.resolve(this.status());
    const generation = this.generation, abort = new AbortController(); this.inventoryRefreshAbort = abort;
    const task = Promise.resolve().then(async () => {
      this.kind = workerData?.journalKind === 'sniper' ? 'sniper' : 'copy'; this.mode = 'live'; this.copyViewMode = 'live'; this.engine.viewMode = 'live';
      this.engine.inventoryRefresh = { at: null, ...this.engine.inventoryRefresh, state: 'refreshing', mode: 'live' };
      this.engine.emit('change');
      const rpcUrl = publicEndpoint(String(raw?.rpcUrl || '').trim() || `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(String(raw?.heliusKey || '').trim())}`).toString();
      invariant(raw?.rpcUrl || String(raw?.heliusKey || '').trim(), 'Save a custom RPC URL or Helius API key to refresh live holdings.');
      const rate = Number(raw?.rpcRequestsPerSecond || 8);
      invariant(Number.isInteger(rate) && rate >= 1 && rate <= 1000, 'RPC requests per second must be between 1 and 1000.');
      invariant(!this.closing && !abort.signal.aborted && generation === this.generation, 'Refresh stopped.');
      const key = JSON.stringify([rpcUrl, rate]);
      if (!this.inventoryProvider || this.inventoryProviderKey !== key || this.inventoryProvider.closed) {
        this.inventoryProvider?.close();
        const config = { rpcUrl, rpcRequestsPerSecond: rate, maxSignalAgeMs: 5000 };
        this.inventoryProvider = this.inventoryProviderFactory ? await this.inventoryProviderFactory(config)
          : new (await import('./providers.mjs')).Providers(config, () => {});
        this.inventoryProviderKey = key; this.inventoryProviderVerified = false;
      }
      const provider = this.inventoryProvider;
      if (!this.inventoryProviderVerified) {
        const genesis = await provider.rpc('getGenesisHash', [], abort.signal);
        invariant(genesis === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'RPC returned a network other than Solana mainnet. Select a mainnet RPC URL.');
        this.inventoryProviderVerified = true;
      }
      invariant(!this.closing && !abort.signal.aborted && generation === this.generation && this.state === 'stopped', 'Refresh stopped.');
      await this.engine.refreshInventory({ provider, signal: abort.signal, mode: 'live', source: 'wallet-refresh' });
      return this.status();
    }).catch(error => {
      const { error: previousError, ...previous } = this.engine.inventoryRefresh || {};
      this.engine.inventoryRefresh = abort.signal.aborted || generation !== this.generation
        ? { ...previous, state: 'idle', mode: 'live' }
        : { ...previous, state: 'error', mode: 'live', error: safeError(error) };
      this.engine.emit('change'); throw error;
    }).finally(() => {
      if (this.inventoryRefreshTask === task) { this.inventoryRefreshTask = null; this.inventoryRefreshAbort = null; }
      this.emit('change');
    });
    this.inventoryRefreshTask = task; return task;
  }
  async mutate(task) {
    invariant(!this.closing, 'Trading worker is closing.');
    invariant(!this.storageError, this.storageError);
    invariant(!this.operation, 'Wait for the current operation to finish.');
    // Install the gate before invoking task, including its first synchronous part.
    const generation = this.generation;
    const operation = Promise.resolve().then(async () => {
      await this.cancelInventoryRefresh();
      invariant(!this.closing && generation === this.generation, 'Run stopped.'); return task();
    });
    this.operation = operation;
    try { await operation; return this.status(); }
    catch (error) {
      // Startup may have allocated an earlier wallet before a later wallet fails.
      // Publish its journal and error events before the host switches to disk for
      // stopped Positions/Activity. Keep the lifecycle gate through these writes.
      try { await this.saveLedgers(); }
      catch {
        this.storageError = 'Trading stopped because encrypted journals could not be saved. Check host storage before restarting the worker.';
        ++this.generation;
        for (const selected of [this.engine, this.portfolio]) {
          try { selected.stop(); } catch {}
          selected.startupError = this.storageError;
        }
        throw new Error(this.storageError);
      }
      throw error;
    }
    finally { if (this.operation === operation) this.operation = null; this.emit('change'); }
  }
  start(raw, kind = 'copy') {
    return this.mutate(async () => {
      invariant(kinds.has(kind), 'Unknown trading mode.');
      invariant(this.state === 'stopped', 'Stop the current run first.');
      this.checkConfig(raw);
      this.kind = kind; this.mode = raw.mode ?? 'paper';
      if (['copy', 'sniper'].includes(kind)) {
        if (this.mode === 'live') {
          const addresses = this.walletAddresses(raw), data = this.portfolio.ledgers.live.data;
          invariant(!data.lots.some(r => addresses.includes(r.wallet)) && !data.pending.some(p => addresses.includes(p.wallet)), 'Release this wallet’s portfolio allocation before using it for copytrading.');
        }
        this.copyConfig = structuredClone(raw);
        this.copyViewMode = null;
        await this.engine.start(raw);
      } else {
        if (this.mode === 'live') this.checkCopiedWallets(this.walletAddresses(raw));
        await this.portfolio.start(strategyRunSettings(raw, kind), kind);
      }
    });
  }
  manualTrade(raw, trade) {
    return this.mutate(async () => {
      invariant(this.portfolio.state === 'stopped', 'Stop the active portfolio strategy before manual trading.');
      invariant(this.engine.state === 'stopped' || this.engine.state === 'running', 'Wait for the current run to start or stop.');
      if (this.engine.state === 'running') {
        invariant(raw?.mode === this.copyConfig?.mode, 'The run mode changed. Review the manual trade again.');
        raw = this.copyConfig;
      }
      this.checkConfig(raw);
      const mode = raw.mode ?? 'paper';
      const imported = new Set((raw.wallets || []).map((wallet, i) => parseWallet({ ...wallet }, i, mode).publicKey));
      invariant(Array.isArray(trade?.wallets) && trade.wallets.length > 0 && trade.wallets.every(wallet => imported.has(wallet)), 'Choose imported follower wallets for the manual trade.');
      const selected = new Set(trade.wallets), data = this.portfolio.ledgers[mode].data;
      invariant(!data.lots.some(row => selected.has(row.wallet)) && !data.pending.some(row => selected.has(row.wallet)), 'Release the selected wallets’ portfolio allocations and reconcile pending transactions before manual trading.');
      this.kind = workerData?.journalKind === 'sniper' ? 'sniper' : 'copy'; this.mode = mode;
      this.copyViewMode = null;
      await this.engine.manualTrade(raw, trade);
    });
  }
  claimFees(wallet, raw) { return this.positionOperation('claimFees', wallet, raw); }
  withdraw(wallet, raw) { return this.positionOperation('withdraw', wallet, raw); }
  positionOperation(operation, wallet, raw) {
    return this.mutate(async () => {
      invariant(this.engine.state === 'stopped', 'Stop copytrading before withdrawing liquidity.');
      this.checkConfig(raw);
      invariant(raw.mode === 'live', 'Choose Live mode to withdraw a live position.');
      this.checkCopiedWallets([typeof wallet === 'object' ? wallet.wallet : wallet]);
      this.kind = 'liquidity'; this.mode = raw.mode;
      await this.portfolio[operation](wallet, strategyRunSettings(raw, 'liquidity'));
    });
  }
  release(id, mode) {
    return this.mutate(async () => {
      invariant(this.state === 'stopped', 'Stop the current run before releasing an allocation.');
      invariant(modes.has(mode), 'Choose Live or Paper mode.');
      const record = this.portfolio.ledgers[mode].data.lots.find(r => r.id === id);
      invariant(record, 'Allocation not found.');
      this.kind = record.kind; this.mode = mode;
      await this.portfolio.release(id, mode);
    });
  }
  stop() {
    // Deliberately bypass the operation gate: Stop must interrupt pending startup.
    ++this.generation; this.inventoryRefreshAbort?.abort(); this.engine.stop(); this.portfolio.stop(); this.emit('change'); return this.status();
  }
  async saveLedgers() {
    const results = await Promise.allSettled([...Object.values(this.engine.ledgers), ...Object.values(this.portfolio.ledgers)].map(ledger => Promise.resolve().then(() => ledger.save())));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  async close() {
    this.closing = true; this.stop();
    // A queued mutation may not have entered its engine yet. Let it finish its
    // synchronous setup before stopping again, then drain receipt reconciliation.
    await Promise.resolve(); this.stop();
    while (this.operation || this.inventoryRefreshTask || this.state !== 'stopped') { this.stop(); await pause(); }
    this.inventoryProvider?.close();
    await this.saveLedgers();
    return this.status();
  }
}

async function runWorker() {
  if (workerData.sharedRpc) {
    const [{ Providers }, { workerRpcGate }] = await Promise.all([import('./providers.mjs'), import('./worker-rpc.mjs')]);
    Providers.sharedRpcGate = workerRpcGate(parentPort);
    Providers.sharedJupiterGate = workerRpcGate(parentPort, 'jupiter');
    Providers.sharedJitoGate = workerRpcGate(parentPort, 'jito');
  }
  // Load providers and SDKs only after the worker-wide DNS/fetch guard is installed.
  const [{ Engine }, { PortfolioEngine }, { SniperEngine }] = await Promise.all([import('./engine.mjs'), import('./portfolio.mjs'), import('./sniper.mjs')]);
  const store = new TelegramStore(workerData.dir, Buffer.from(workerData.key), workerData.context);
  const kind = workerData.journalKind;
  invariant(kind == null || kinds.has(kind), 'Invalid worker mode.');
  const names = ['copy', 'sniper'].includes(kind) ? [kind === 'sniper' ? 'sniper-live' : 'live', kind === 'sniper' ? 'sniper-paper' : 'paper', `${kind}-unused-live`, `${kind}-unused-paper`]
    : kind ? [`${kind}-unused-live`, `${kind}-unused-paper`, `${kind}-live`, `${kind}-paper`]
      : ['live', 'paper', 'portfolio-live', 'portfolio-paper'];
  const [live, paper, portfolioLive, portfolioPaper] = await Promise.all(names.map(name => new TelegramLedger(store, name).load()));
  const runtime = new TelegramRuntime(new (kind === 'sniper' ? SniperEngine : Engine)({ live, paper }), new PortfolioEngine({ live: portfolioLive, paper: portfolioPaper }));
  runtime.kind = kind || 'copy';
  // Only the host passes this snapshot through workerData. Presets and user
  // request bodies cannot replace the account, recipient, or fee schedule.
  runtime.engine.platformContext = workerData.platformContext || null;
  runtime.portfolio.platformContext = workerData.platformContext || null;
  const errorStop = new RunErrorStop(runtime);
  let changed;
  const snapshot = () => parentPort.postMessage({ type: 'status', value: errorStop.status() });
  runtime.on('change', () => { if (!changed) changed = setTimeout(() => { changed = null; snapshot(); }, 30); });
  parentPort.on('message', async ({ type, id, method, raw, kind, wallet, allocation, mode, trade }) => {
    if (type?.startsWith('rpc-')) return;
    try {
      if (workerData.journalKind && method === 'start') invariant(kind === workerData.journalKind, 'This worker belongs to another mode.');
      if (workerData.journalKind && ['manualTrade', 'refreshInventory'].includes(method)) invariant(['copy', 'sniper'].includes(workerData.journalKind), 'This action belongs to Copytrading or Sniping.');
      if (workerData.journalKind && method === 'withdraw') invariant(workerData.journalKind === 'liquidity', 'This action belongs to LP management.');
      if (method === 'start' || (['manualTrade', 'withdraw', 'claimFees'].includes(method) && runtime.state === 'stopped')) errorStop.arm();
      if (['stop', 'close'].includes(method)) errorStop.disarm();
      if (method === 'start') await runtime.start(raw, kind);
      else if (method === 'refreshInventory') await runtime.refreshInventory(raw);
      else if (method === 'cancelInventoryRefresh') await runtime.cancelInventoryRefresh();
      else if (method === 'manualTrade') await runtime.manualTrade(raw, trade);
      else if (method === 'withdraw') await runtime.withdraw(wallet, raw);
      else if (method === 'claimFees') await runtime.claimFees(wallet, raw);
      else if (method === 'release') await runtime.release(allocation, mode);
      else if (method === 'stop') runtime.stop();
      else if (method === 'close') {
        await runtime.close(); clearTimeout(changed);
        parentPort.postMessage({ type: 'reply', id, value: errorStop.status() }); parentPort.close(); return;
      } else throw new Error('Unknown trading action.');
      parentPort.postMessage({ type: 'reply', id, value: errorStop.status() });
    } catch (error) {
      parentPort.postMessage({ type: 'reply', id, value: errorStop.status(), error: safeError(error) });
    }
  });
  parentPort.postMessage({ type: 'ready' });
}
if (parentPort && workerData) await runWorker();
