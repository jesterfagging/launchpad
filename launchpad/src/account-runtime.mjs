import { WalletBalances } from './wallet-balances.mjs';
import { upgradeWalletTools } from './wallet-tools.mjs';
import { MAX_WALLETS, toolWallets, walletTool, checkWalletCaps } from '../public/wallet-limits.mjs';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { TelegramEngine } from './telegram-engine.mjs';
import { defaults, importSettings } from './telegram-settings.mjs';
import { normalizeStrategies } from './telegram-strategy.mjs';
import { createPreset } from '../public/presets.mjs';
import { invariant, decimal, SOL, parseWallet } from './core.mjs';
import { summarizePositions } from './positions.mjs';
import { selectedRunSettings } from './run-settings.mjs';
import { journalName, prepareRunJournals, runJournalNames } from './run-journals.mjs';
import { SharedRpcGate } from './shared-rpc-gate.mjs';
import { runKinds, runLabels } from '../public/run-settings.mjs';
import { generateWalletBatch } from './wallet-generation.mjs';
import { launchpadEnv } from './brand-env.mjs';
import { operatorCapacity } from './operator-capacity.mjs';

const blankMetrics = () => ({ detected: 0, submitted: 0, confirmed: 0, skipped: 0, detectionToSendMs: null, confirmationMs: null });
const stoppedStatus = () => ({ revision: 0, state: 'stopped', kind: 'copy', mode: 'live', positions: [], pending: [], events: [], metrics: blankMetrics(), streamConnected: false });
const fingerprint = settings => createHash('sha256').update(JSON.stringify(settings)).digest('hex');

// One mode has one engine even when web and Telegram control it concurrently.
class AccountRuntime extends EventEmitter {
  constructor(manager, id, kind = 'copy') {
    super(); this.manager = manager; this.id = id; this.worker = null; this.busy = false; this.generation = 0; this.current = stoppedStatus();
    this.kind = kind; this.current.kind = kind;
    this.statusStreamId = randomUUID(); this.runId = randomUUID(); this.revision = 0; this.runConfig = null; this.manualBusy = false; this.diskViews = new Map(); this.manualRequests = new Map();
    this.inventoryRefreshTask = null; this.inventoryRefreshAfter = 0;
  }
  emit(name, ...args) { if (name === 'change') this.revision++; return super.emit(name, ...args); }
  snapshot(value) { return { ...value, revision: this.revision, statusStreamId: this.statusStreamId, runId: this.runId, manualBusy: this.manualBusy }; }
  get state() { return this.busy && (!this.worker || this.worker.state === 'stopped') ? 'starting' : this.worker?.state || this.current.state; }
  get failed() { return false; }
  status() { return this.snapshot({ ...(this.worker?.status() || this.current), kind: this.kind, state: this.state }); }
  async cancelInventoryRefresh() {
    const task = this.inventoryRefreshTask;
    if (!task) return;
    await this.worker?.cancelInventoryRefresh?.();
    await task.catch(() => {});
  }
  refreshPositions() {
    if (this.inventoryRefreshTask) return this.inventoryRefreshTask;
    if (this.manager.closing || this.busy || this.state !== 'stopped' || this.manager.settingsPending.has(this.id) || Date.now() < this.inventoryRefreshAfter) return Promise.resolve(this.status());
    this.inventoryRefreshAfter = Date.now() + 10000;
    const generation = this.generation;
    const allowed = () => generation === this.generation && !this.manager.closing && !this.busy && this.state === 'stopped' && !this.manager.settingsPending.has(this.id);
    const task = (async () => {
      let worker, cold = false;
      try {
        const [{ settings }, ledger] = await Promise.all([this.manager.readSettings(this.id), this.manager.accounts.storeFor(this.id).read(journalName(this.kind, 'live'), { lots: [], pending: [] })]);
        if (!allowed() || (!settings.rpcUrl && !settings.heliusKey)) return this.status();
        const pending = new Set(ledger.pending.map(row => row.wallet));
        if (!ledger.lots.some(row => BigInt(row.remaining || 0) > 0n && !pending.has(row.wallet))) return this.status();
        worker = this.worker;
        if (!worker || worker.closed || worker.failed) {
          if (this.manager.inventoryRefreshWorkers >= 2) return this.status();
          this.manager.inventoryRefreshWorkers++; cold = true;
          worker = this.manager.makeWorker(this.id, this.kind, null); this.worker = worker;
          worker.on('change', () => { if (this.worker === worker) { this.current = worker.status(); this.emit('change'); } });
        }
        if (!allowed() || !worker.refreshInventory) return this.status();
        // The read-only worker receives no wallet keys, lead subscriptions, fee
        // settings or trading instructions. Its live journal supplies addresses.
        await worker.refreshInventory({ rpcUrl: settings.rpcUrl, heliusKey: settings.heliusKey, rpcRequestsPerSecond: settings.rpcRequestsPerSecond });
        if (this.worker === worker) this.current = worker.status();
        return this.status();
      } catch (error) {
        if (generation === this.generation && !this.manager.closing && !worker) {
          this.current = { ...this.current, inventoryRefresh: { state: 'error', at: this.current.inventoryRefresh?.at || null, mode: 'live', error: 'Live holdings could not be refreshed. Check the saved RPC connection.' } };
        }
        return this.status();
      } finally {
        if (cold) {
          try {
            if (worker && this.worker === worker && !this.busy && worker.state === 'stopped') {
              this.current = worker.status(); await worker.close();
              if (this.worker === worker) this.worker = null;
            }
          } finally { this.manager.inventoryRefreshWorkers--; }
        }
      }
    })().finally(() => { if (this.inventoryRefreshTask === task) this.inventoryRefreshTask = null; this.emit('change'); });
    this.inventoryRefreshTask = task; return task;
  }
  async perform(method, raw, kind, extra) {
    invariant(!this.manager.closing && !this.busy && !this.manager.settingsPending.has(this.id), 'Wait for the current operation to finish.');
    const manual = method === 'manualTrade', wasStopped = this.state === 'stopped';
    if (method === 'start' || (manual && wasStopped)) {
      invariant(this.state === 'stopped', 'Stop the current run first.');
      invariant(this.manager.activeCount(this) < this.manager.maxActive, 'All trading slots are busy. Try again when a run stops.');
    }
    if (manual) {
      invariant(extra?.expectedRunId === undefined || extra.expectedRunId === this.runId, 'The run changed. Review the manual trade again.');
      invariant(wasStopped || (this.state === 'running' && ['copy', 'sniper'].includes(this.status().kind)), 'Stop the active strategy before manual trading.');
      if (!wasStopped) {
        invariant(raw?.mode === this.runConfig?.mode, 'The run mode changed. Review the manual trade again.');
        raw = this.runConfig;
      }
      invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid manual trade settings.');
      const addresses = new Set((raw.wallets || []).map((wallet, i) => parseWallet({ ...wallet }, i, raw.mode).publicKey));
      invariant(Array.isArray(extra?.wallets) && extra.wallets.length > 0 && extra.wallets.length <= MAX_WALLETS && extra.wallets.every(wallet => addresses.has(wallet)), 'Choose imported follower wallets for the manual trade.');
    }
    if (['withdraw', 'claimFees'].includes(method)) invariant(this.state === 'stopped' || this.status().kind === 'liquidity', 'Stop the active strategy before withdrawing liquidity.');
    this.busy = true; this.manualBusy = manual; const generation = ++this.generation;
    this.emit('change');
    try {
      await this.cancelInventoryRefresh();
      const policy = await this.manager.policy.get(this.id);
      const newRun = method === 'start' || (manual && wasStopped);
      if (newRun && raw.mode === 'live') {
        await this.manager.beforeLiveStart(this.id);
        invariant(policy.ready, 'The operator must configure the Launchpad fee-collection wallet before starting runs.');
        invariant(raw.agreedFeeVersion === policy.version, 'The fee schedule changed or has not been accepted. Refresh and review it before starting.');
      }
      if (generation !== this.generation || this.manager.closing) throw new Error('Run stopped.');
      // Retire a stopped worker before giving a new run its immutable fee snapshot.
      if (this.worker?.state === 'stopped') { this.current = this.worker.status(); await this.worker.close(); this.worker = null; }
      if (generation !== this.generation || this.manager.closing) throw new Error('Run stopped.');
      if (!this.worker) {
        // Liquidity withdrawals remain available if fee collection is unconfigured.
        this.worker = this.manager.makeWorker(this.id, this.kind, newRun && policy.ready ? policy : null);
        const worker = this.worker;
        worker.on('change', () => { if (this.worker === worker) { this.current = worker.status(); this.emit('change'); } });
      }
      const clean = structuredClone(raw); delete clean.platformContext; delete clean.platformFees;
      if (method === 'start') { this.runId = randomUUID(); this.runConfig = structuredClone(clean); return await this.worker.start(clean, kind); }
      if (manual) {
        if (wasStopped) this.runId = randomUUID();
        const trade = { ...extra }; delete trade.expectedRunId;
        return await this.worker.manualTrade(clean, trade);
      }
      if (method === 'claimFees') return await this.worker.claimFees(extra, clean);
      return await this.worker.withdraw(extra, clean);
    } finally { this.busy = false; this.manualBusy = false; this.emit('change'); }
  }
  start(raw, kind = 'copy') { return this.perform('start', raw, kind); }
  manualTrade(raw, trade) {
    invariant(typeof trade?.id === 'string' && trade.id.length > 0 && trade.id.length <= 128, 'A manual trade request ID is required.');
    const hash = fingerprint({ raw, trade }), cached = this.manualRequests.get(trade.id);
    if (cached) {
      invariant(cached.hash === hash, 'This manual trade request ID was already used with different settings.');
      const status = this.status();
      return !cached.settled && status.manualResult?.id === trade.id ? Promise.resolve(status) : cached.promise;
    }
    const entry = { hash, settled: false };
    const promise = this.perform('manualTrade', raw, this.kind, trade).then(() => { entry.settled = true; return this.status(); }, error => { entry.settled = true; throw error; });
    entry.promise = promise; this.manualRequests.set(trade.id, entry);
    if (this.manualRequests.size > 100) this.manualRequests.delete(this.manualRequests.keys().next().value);
    return promise;
  }
  withdraw(wallet, raw) { return this.perform('withdraw', raw, 'liquidity', wallet); }
  claimFees(wallet, raw) { return this.perform('claimFees', raw, 'liquidity', wallet); }
  async release(id, mode) {
    invariant(!this.manager.closing && !this.manager.settingsPending.has(this.id), 'Wait for the current operation to finish.');
    invariant(!this.busy && this.state === 'stopped', 'Stop the current run before releasing an allocation.');
    this.busy = true; const generation = ++this.generation;
    try {
      await this.cancelInventoryRefresh();
      if (!this.worker || this.worker.failed || this.worker.closed) {
        this.worker = this.manager.makeWorker(this.id, this.kind, null);
        const worker = this.worker;
        worker.on('change', () => { if (this.worker === worker) { this.current = worker.status(); this.emit('change'); } });
      }
      if (generation !== this.generation) throw new Error('Operation stopped.');
      return await this.worker.release(id, mode);
    } finally { this.busy = false; this.emit('change'); }
  }
  stop() { ++this.generation; this.worker?.stop(); this.emit('change'); return this.status(); }
  async close() {
    // Telegram may release an idle view while a web view still references this
    // facade. A subsequent operation lazily restores its worker and journal.
    if (this.state !== 'stopped' || this.busy) return;
    ++this.generation; await this.cancelInventoryRefresh();
    if (this.worker) { this.current = this.worker.status(); await this.worker.close(); this.worker = null; this.emit('change'); }
  }
}

// Each mode owns a worker and encrypted journal. The account facade reserves
// live wallets before any asynchronous startup, across web and Telegram alike.
class AccountRuns extends EventEmitter {
  constructor(manager, id) {
    super(); this.manager = manager; this.id = id; this.lanes = new Map(); this.reservations = new Map(); this.selected = 'copy'; this.generation = 0;
    this.revision = 0; this.statusStreamId = randomUUID(); this.manualRequests = new Map();
  }
  emit(name, ...args) { if (name === 'change') this.revision++; return super.emit(name, ...args); }
  lane(kind = 'copy') {
    invariant(runKinds.includes(kind), 'Choose a trading mode.');
    if (!this.lanes.has(kind)) {
      const lane = new AccountRuntime(this.manager, this.id, kind);
      lane.on('change', () => this.emit('change')); this.lanes.set(kind, lane);
    }
    return this.lanes.get(kind);
  }
  get state() {
    const states = [...this.lanes.values()].map(l => l.state);
    return states.includes('running') ? 'running' : states.includes('starting') || this.reservations.size ? 'starting' : states.includes('stopping') ? 'stopping' : 'stopped';
  }
  get busy() { return this.reservations.size > 0 || [...this.lanes.values()].some(l => l.busy); }
  get failed() { return false; }
  get worker() { return this.lane(this.selected).worker; }
  get runId() { return this.lane('copy').runId; }
  get current() { return this.lane(this.selected).current; }
  get inventoryRefreshTask() { return this.lane('copy').inventoryRefreshTask; }
  status(kind) {
    const chosen = kind || this.selected, value = this.lane(chosen).status();
    const runs = Object.fromEntries(runKinds.map(k => {
      const lane = this.lane(k), status = lane.status();
      return [k, { state: this.reservations.has(k) && lane.state === 'stopped' ? 'starting' : lane.state, mode: status.mode, runId: lane.runId, startupError: status.startupError || null,
        wallets: (lane.runConfig?.wallets || []).map(w => w.publicKey).filter(Boolean) }];
    }));
    return { ...value, ...(kind ? {} : { state: this.state }), kind: chosen, runs, concurrent: true };
  }
  async guarded(kind, raw, task, selectedWallets) {
    invariant(!this.manager.closing && !this.reservations.has(kind), 'Wait for this mode’s current operation to finish.');
    const lane = this.lane(kind), generation = lane.generation;
    const keys = selectedWallets || (raw.wallets || []).map((w, i) => parseWallet({ ...w }, i, raw.mode).publicKey);
    const live = raw.mode === 'live';
    if (lane.state === 'stopped') invariant(this.manager.activeCount(lane) < this.manager.maxActive, 'All trading slots are busy. Try again when a run stops.');
    // Reserve synchronously, before reading policy or journal files. Two starts
    // cannot both pass a check against the same unallocated wallet.
    this.reservations.set(kind, { keys, live }); this.emit('change');
    try {
      await this.manager.prepare(this.id);
      invariant(generation === lane.generation && !this.manager.closing, 'Run stopped.');
      if (live) for (const other of runKinds.filter(k => k !== kind)) {
        const active = this.lane(other), reservation = this.reservations.get(other);
        const activeKeys = active.runConfig?.mode === 'live' && (active.state !== 'stopped' || active.busy)
          ? (active.runConfig.wallets || []).map(w => w.publicKey || parseWallet({ ...w }, 0, 'live').publicKey) : [];
        invariant(!keys.some(key => activeKeys.includes(key) || (reservation?.live && reservation.keys.includes(key))),
          `A selected wallet is in use by ${runLabels[other]}. Select separate wallets for concurrent live runs.`);
        const status = active.worker && !active.worker.closed && !active.worker.failed ? active.worker.status() : null;
        const view = ['copy', 'sniper'].includes(other) ? status?.views?.copy : status?.views?.portfolioLive;
        const data = view?.mode === 'live' ? { lots: view.positions, pending: view.pending }
          : await this.manager.accounts.storeFor(this.id).read(journalName(other, 'live'), { lots: [], pending: [] });
        invariant(!data.pending.some(p => keys.includes(p.wallet)) && !data.lots.some(p => keys.includes(p.wallet) && (!['copy', 'sniper'].includes(other) || BigInt(p.remaining || 0) > 0n)),
          `A selected wallet has an open position, allocation, or pending transaction in ${runLabels[other]}. Resolve it there before reusing the wallet.`);
      }
      invariant(generation === lane.generation && !this.manager.closing, 'Run stopped.');
      this.selected = kind;
      return await task(lane);
    } finally { this.reservations.delete(kind); this.emit('change'); }
  }
  start(raw, kind = 'copy') {
    const selected = selectedRunSettings(raw, kind);
    return this.guarded(kind, selected, lane => lane.start(selected, kind));
  }
  manualTrade(raw, trade, kind = 'copy') {
    invariant(['copy', 'sniper'].includes(kind), 'Choose Copytrading or Sniping for manual trades.');
    invariant(typeof trade?.id === 'string' && trade.id.length > 0 && trade.id.length <= 128, 'A manual trade request ID is required.');
    const hash = fingerprint({ raw, trade, kind }), cached = this.manualRequests.get(trade.id);
    if (cached) { invariant(cached.hash === hash, 'This manual trade request ID was already used with different settings.'); return cached.promise; }
    const selected = { ...raw, wallets: toolWallets(raw, kind).filter(w => trade.wallets?.includes(w.publicKey)) };
    const promise = this.guarded(kind, selected, lane => lane.manualTrade(selected, trade), trade.wallets);
    this.manualRequests.set(trade.id, { hash, promise });
    if (this.manualRequests.size > 100) this.manualRequests.delete(this.manualRequests.keys().next().value);
    return promise;
  }
  claimFees(selection, raw) {
    const selected = { ...raw, wallets: toolWallets(raw, 'liquidity').filter(w => w.publicKey === selection.wallet) };
    return this.guarded('liquidity', selected, lane => lane.claimFees(selection, selected), [selection.wallet]);
  }
  withdraw(selection, raw) {
    const wallet = typeof selection === 'object' ? selection.wallet : selection;
    const selected = { ...raw, wallets: toolWallets(raw, 'liquidity').filter(w => w.publicKey === wallet) };
    return this.guarded('liquidity', selected, lane => lane.withdraw(selection, selected), [wallet]);
  }
  async release(id, mode, kind) {
    invariant(!this.manager.closing && !this.manager.settingsPending.has(this.id), 'Wait for the current operation to finish.');
    await this.manager.prepare(this.id);
    if (!['liquidity', 'market'].includes(kind)) {
      const books = await Promise.all(['market','liquidity'].map(k => this.manager.accounts.storeFor(this.id).read(journalName(k, mode), { lots: [] })));
      const found = books.map((book, i) => book.lots.some(r => r.id === id) ? ['market','liquidity'][i] : null).filter(Boolean);
      invariant(found.length === 1, 'Choose the allocation’s trading mode.'); kind = found[0];
    }
    this.selected = kind; return this.lane(kind).release(id, mode);
  }
  stop(kind) {
    if (kind) this.lane(kind).stop();
    else for (const lane of this.lanes.values()) lane.stop();
    this.emit('change'); return this.status(kind);
  }
  refreshPositions() { return this.lane('copy').refreshPositions(); }
  async cancelInventoryRefresh() { await Promise.all([...this.lanes.values()].map(l => l.cancelInventoryRefresh())); }
  async close() { await Promise.all([...this.lanes.values()].map(lane => lane.close())); }
}

export class AccountRuntimeManager {
  constructor(accounts, policy, { maxActive = 5, engineFactory = (store, context, options) => new TelegramEngine(store, context, options), beforeLiveStart = async () => {}, positionFeed = null, toolkit = true } = {}) {
    Object.assign(this, { accounts, policy, maxActive, engineFactory, beforeLiveStart, positionFeed, toolkit }); this.runtimes = new Map(); this.settingsPending = new Map(); this.walletMigrations = new Map(); this.closing = false; this.inventoryRefreshWorkers = 0; this.preparations = new Map(); this.rpcGate = new SharedRpcGate(); this.balances = toolkit ? new WalletBalances({rpcGate:this.rpcGate}) : null;
  }
  requireToolkit(){invariant(this.toolkit,'Launchpad Toolkit is disabled in launchpad-only mode.');}
  get(id) { this.requireToolkit();if (!this.runtimes.has(id)) this.runtimes.set(id, new AccountRuns(this, id)); return this.runtimes.get(id); }
  activeCount(except) { return [...this.runtimes.values()].reduce((count, runtime) => count + [...runtime.lanes.values()].filter(lane => lane !== except && (lane.state !== 'stopped' || lane.busy || runtime.reservations.has(lane.kind))).length, 0); }
  makeWorker(id, kind, context) { this.requireToolkit();return this.engineFactory(this.accounts.storeFor(id), context, { journalKind: kind, rpcGate: this.rpcGate, rpcScope: id }); }
  prepare(id) {
    this.requireToolkit();
    if (!this.preparations.has(id)) {
      const work = prepareRunJournals(this.accounts.storeFor(id)).catch(error => { this.preparations.delete(id); throw error; });
      this.preparations.set(id, work);
    }
    return this.preparations.get(id);
  }
  async readSettings(id) {
    if(!this.toolkit){
      const saved=await this.accounts.storeFor(id).read('settings',defaults),capacity=operatorCapacity();
      const settings={...structuredClone(defaults),...saved,mode:'live',strategies:normalizeStrategies(saved.strategies),rpcUrl:launchpadEnv('PUBLIC_RPC_URL')||'',heliusKey:'',jupiterKey:launchpadEnv('PUBLIC_JUPITER_KEY')||'',rpcRequestsPerSecond:capacity.rpcRequestsPerSecond};
      return{settings,revision:fingerprint(settings)};
    }
    if (!this.walletMigrations.has(id)) {
      const store = this.accounts.storeFor(id);
      this.walletMigrations.set(id, store.read('settings', defaults).then(saved => upgradeWalletTools(saved, store)).catch(error => { this.walletMigrations.delete(id); throw error; }));
    }
    await this.walletMigrations.get(id);
    const saved = await this.accounts.storeFor(id).read('settings', defaults);
    const settings = { ...structuredClone(defaults), ...saved, mode: 'live', strategies: normalizeStrategies(saved.strategies) };
    return { settings, revision: fingerprint(settings) };
  }
  async saveSettings(id, next, revision) {
    const runtime = this.get(id);
    invariant(!runtime.busy, 'Wait for the current operation before saving settings.');
    const work = (this.settingsPending.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      invariant(!runtime.busy, 'Wait for the current operation before saving settings.');
      const current = await this.readSettings(id);
      if (typeof revision !== 'string' || revision !== current.revision) throw Object.assign(new Error('Settings changed in another window or Telegram. Reload the saved settings before saving again.'), { statusCode: 409 });
      const normalized = importSettings(JSON.stringify(createPreset({ ...next, mode: 'live' })));
      if (normalized.walletSchema !== 1) for (const w of normalized.wallets) {
        const old = current.settings.wallets.find(row => row.publicKey === w.publicKey);
        w.tool = old?.tool || ['liquidity', 'market'].find(k => normalized.runWallets?.[k]?.includes(w.publicKey) && !normalized.runWallets?.copy?.includes(w.publicKey)) || 'copy';
      }
      normalized.walletSchema = 1;
      checkWalletCaps(normalized, current.settings);
      const retained = new Set(normalized.wallets.map(w => w.publicKey));
      await this.prepare(id);
      for (const lane of runtime.lanes.values()) if (lane.state !== 'stopped' || lane.busy) {
        invariant((lane.runConfig?.wallets || []).every(w => retained.has(w.publicKey)), 'Keep wallets used by active runs in the saved setup.');
      }
      for (const name of runJournalNames) {
        const ledger = await this.accounts.storeFor(id).read(name, { lots: [], pending: [] });
        const locked = [...ledger.pending.map(p => p.wallet), ...ledger.lots.filter(l => ['liquidity', 'market', 'portfolio'].some(k => name.startsWith(k + '-')) || BigInt(l.remaining || 0) > 0n).map(l => l.wallet)];
        invariant(locked.every(wallet => retained.has(wallet)), 'Keep wallets with positions, allocations, or pending transactions in the saved setup.');
      }
      await this.accounts.storeFor(id).write('settings', normalized);
      return this.readSettings(id);
    });
    this.settingsPending.set(id, work);
    try { return await work; } finally { if (this.settingsPending.get(id) === work) this.settingsPending.delete(id); }
  }
  async generateWallets(id, next, revision, count, kind = 'copy') {
    // The revision check prevents retry/double-click requests and concurrent
    // web/Telegram changes from appending a second batch or losing settings.
    const current = await this.readSettings(id);
    if (typeof revision !== 'string' || revision !== current.revision) throw Object.assign(new Error('Settings changed. Reload your saved wallets before generating another batch.'), { statusCode: 409 });
    const normalized = importSettings(JSON.stringify(createPreset({ ...next, mode: 'live' })));
    const tool = walletTool(kind);
    const generated = await generateWalletBatch(count, toolWallets({ ...normalized, walletSchema: 1 }, tool), tool);
    try {
      const result = await this.saveSettings(id, { ...normalized, wallets: [...normalized.wallets, ...generated] }, revision);
      return { ...result, generated: generated.map(({ label, publicKey }) => ({ label, publicKey })) };
    } finally { for (const wallet of generated) wallet.privateKey = ''; }
  }
  async view(id, kind = 'copy', mode) {
    await this.prepare(id);
    const account = this.get(id), runtime = account.lane(kind), isCopy = ['copy', 'sniper'].includes(kind);
    if (runtime.state !== 'stopped' && runtime.worker) mode = runtime.status().mode;
    if (!['live', 'paper'].includes(mode)) {
      // A completed one-shot may use a different mode from the saved form. Keep
      // showing that worker's authoritative copy ledger on subsequent polls/SSE.
      const copyView = isCopy && runtime.worker && !runtime.worker.closed && !runtime.worker.failed ? runtime.status().views?.copy : null;
      mode = copyView?.mode || (await this.readSettings(id)).settings.mode;
    }
    if (isCopy && mode === 'live' && runtime.state === 'stopped') runtime.refreshPositions().catch(() => {});
    const current = runtime.status();
    const view = isCopy ? current.views?.copy : current.views?.[mode === 'live' ? 'portfolioLive' : 'portfolioPaper'];
    const workerView = view && runtime.worker && !runtime.worker.closed && (view.mode === mode || (isCopy && ['copy', 'sniper'].includes(current.kind) && runtime.state !== 'stopped'));
    if (workerView && (!isCopy || runtime.state !== 'stopped' || !this.positionFeed)) return { ...runtime.snapshot({ ...view, state: runtime.state, kind }), concurrent: true, runs: account.status(kind).runs };
    const beforeRead = runtime.revision;
    const ledger = workerView ? { lots: view.positions, pending: view.pending, events: view.events, feeReceipts: view.feeReceipts }
      : await this.accounts.storeFor(id).read(journalName(kind, mode), { lots: [], pending: [], events: [] });
    const markets = isCopy && runtime.state === 'stopped' && this.positionFeed ? await this.positionFeed.prices(ledger.lots.filter(l => BigInt(l.remaining || 0) > 0n).map(l => l.mint)) : new Map();
    // A worker update may overtake this disk read. Never give the older journal
    // the new revision and let it overwrite a confirmed sell in the browser.
    if (beforeRead !== runtime.revision) return this.view(id, kind, mode);
    const positions = isCopy ? []
      : ledger.lots.map(l => ({ ...l, balances: Object.entries(l.tokens).map(([mint, amount]) => ({ mint, amount: decimal(amount, l.decimals?.[mint] ?? (mint === SOL ? 9 : 0)) })) }));
    const result = { ...stoppedStatus(), ...(workerView ? view : {}), mode, kind, positions, pending: ledger.pending, events: ledger.events,
      ...(isCopy ? summarizePositions(ledger.lots, markets, { feeReceipts: ledger.feeReceipts || [] }) : {}),
      ...(current.kind === kind ? { metrics: current.metrics || blankMetrics(), startupError: current.startupError || null,
        inventoryRefresh: current.inventoryRefresh || null } : {}),
      state: current.kind === kind ? runtime.state : 'stopped' };
    const key = `${kind}:${mode}`, hash = fingerprint(result);
    if (runtime.diskViews.get(key) !== hash) { runtime.diskViews.set(key, hash); runtime.revision++; }
    return { ...runtime.snapshot(result), concurrent: true, runs: account.status(kind).runs };
  }
  close({ consumersClosed } = {}) {
    return this.closingTask ||= (async () => {
      this.closing = true;
      for (const r of this.runtimes.values()) r.stop();
      // Stop admission immediately, while letting already-running launch,
      // reward and treasury jobs use the shared scheduler until they settle.
      await Promise.allSettled([consumersClosed, ...[...this.runtimes.values()].map(async r => {
        await r.cancelInventoryRefresh();
        while (r.busy) await new Promise(resolve => setTimeout(resolve, 25));
        await Promise.all([...r.lanes.values()].map(async lane => { if (lane.worker) await lane.worker.close(); }));
      })]);
      this.rpcGate.close(); this.balances?.close();
    })();
  }
}
