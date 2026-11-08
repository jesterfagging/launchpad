import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { TelegramEngine } from './telegram-engine.mjs';
import { ChainStore, ensureRobinhoodAccount, cleanRobinhoodSettings, generateEvmWallets, evmAddress } from './robinhood-settings.mjs';
import { TOOL_NAMES } from '../public/chains.mjs';
import { WALLET_LIMITS, walletTool } from '../public/wallet-limits.mjs';
import { manualIdentity, manualResult } from './robinhood-manual.mjs';

export const evmJournal = kind => kind === 'copy' ? 'live' : `${kind}-live`;
const empty = kind => ({ chain: 'robinhood', state: 'stopped', kind, mode: 'live', positions: [], pending: [], events: [], metrics: {}, runId: '' });
export class RobinhoodRuns extends EventEmitter {
  constructor(manager, id) { super(); this.manager = manager; this.id = id; this.workers = new Map(); this.busyKinds = new Set(); this.reservations = new Map(); this.generations = new Map(); this.manualJobs = new Map(); }
  get state() { return this.status().state; }
  get busy() { return this.busyKinds.size > 0; }
  status(kind) {
    if (kind) { if (!(kind in TOOL_NAMES)) throw Error('Unknown Robinhood tool.'); return this.workers.get(kind)?.status() || empty(kind); }
    const runs = Object.fromEntries(Object.keys(TOOL_NAMES).map(k => [k, this.status(k)]));
    return { concurrent: true, chain: 'robinhood', state: this.busy ? 'starting' : Object.values(runs).some(r => r.state !== 'stopped') ? 'running' : 'stopped', runs, positions: [], pending: [], events: [] };
  }
  async exposure() {
    const store = this.manager.storeFor(this.id), rows = [];
    for (const kind of Object.keys(TOOL_NAMES)) {
      const ledger = await store.read(evmJournal(kind), {});
      for (const lot of ledger.lots || []) if (lot.liquidity && BigInt(lot.liquidity) > 0n || lot.remaining && BigInt(lot.remaining) > 0n) rows.push({ kind, wallet: lot.wallet });
      for (const pending of ledger.pending || []) rows.push({ kind, wallet: pending.wallet });
      for (const wallet of Object.keys(ledger.inventory || ledger.lpFunds || {})) rows.push({ kind, wallet });
    }
    return rows;
  }
  async perform(method, raw, kind, extra) {
    if (this.manager.closing) throw Error('The host is shutting down.');
    if (!(kind in TOOL_NAMES)) throw Error('Choose a trading tool.');
    if (this.busyKinds.has(kind)) throw Error('Wait for this tool’s current operation to finish.');
    if (this.manager.settingsJobs.has(this.id)) throw Error('Wait for wallet settings to finish saving.');
    const generation = (this.generations.get(kind) || 0) + 1; this.generations.set(kind, generation);
    // Reserve a capacity slot synchronously before any I/O, shared with Solana.
    if (this.status(kind).state === 'stopped' && this.manager.activeCount() >= this.manager.maxActive) throw Error('All trading slots are busy.');
    this.busyKinds.add(kind); this.emit('change');
    try {
      const saved = (await this.manager.readSettings(this.id)).settings, settings = cleanRobinhoodSettings(raw, saved);
      const selected = method === 'manualTrade' ? (extra.wallets || settings.runWallets[kind]).map(evmAddress) : ['withdraw', 'claimFees', 'convertInventory'].includes(method) ? [evmAddress(extra.wallet)] : settings.runWallets[kind];
      if (!selected.length || selected.length > WALLET_LIMITS[kind] || new Set(selected).size !== selected.length || selected.some(a => !settings.wallets.some(w => w.publicKey === a && w.tool === walletTool(kind)))) throw Error('Choose valid wallets for this tool.');
      for (const [other, keys] of this.reservations) if (other !== kind && selected.some(a => keys.includes(a))) throw Error('A selected wallet is already reserved by another Robinhood tool.');
      const reserved = [...new Set([...(this.status(kind).state !== 'stopped' ? this.reservations.get(kind) || [] : []), ...selected])];
      this.reservations.set(kind, reserved);
      for (const e of await this.exposure()) if (e.kind !== kind && selected.includes(e.wallet)) throw Error('A selected wallet has positions or pending transactions in another Robinhood tool.');
      const policy = await this.manager.policy.get(this.id);
      if (!policy.ready) throw Error('The administrator must configure the Robinhood fee wallet and verified execution-contract deployment first.');
      if (settings.agreedFeeVersion !== policy.version) throw Error('Fees changed. Review the current fees and press Start or Confirm again.');
      if (generation !== this.generations.get(kind)) throw Error('Run stopped.');
      let worker = this.workers.get(kind);
      if (method === 'start' && worker?.state !== 'stopped' && worker) throw Error('Stop this run first.');
      if (!worker || worker.failed || worker.state === 'stopped') {
        if (worker) await worker.close();
        worker = this.manager.engineFactory(this.manager.storeFor(this.id), policy, { chain: 'robinhood', journalKind: kind, rpcGate: this.manager.solana?.rpcGate, rpcScope: `${this.id}:robinhood` });
        worker.on('change', () => this.emit('change')); this.workers.set(kind, worker);
      }
      if (generation !== this.generations.get(kind)) { worker.stop(); throw Error('Run stopped.'); }
      const config = { ...settings, wallets: settings.wallets.filter(w => selected.includes(w.publicKey)), runWallets: { [kind]: selected } };
      if (method === 'start') return await worker.start(config, kind);
      if (method === 'manualTrade') return await worker.manualTrade(config, extra);
      if (method === 'withdraw') return await worker.withdraw(extra, config);
      if (method === 'claimFees') return await worker.claimFees(extra, config);
      if (method === 'convertInventory') return await worker.convertInventory(extra.wallet, config);
      throw Error('Unknown Robinhood operation.');
    } finally { this.busyKinds.delete(kind); if (this.status(kind).state === 'stopped') this.reservations.delete(kind); this.emit('change'); }
  }
  start(raw, kind = 'copy') { return this.perform('start', raw, kind); }
  async manualTrade(raw, trade, kind = 'copy') {
    if (!['copy', 'sniper', 'market'].includes(kind)) throw Error('Manual trading is unavailable for this tool.');
    if (typeof trade?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(trade.id)) throw Error('A manual trade request ID is required.');
    const key = `${kind}:${trade.id}`, identity = manualIdentity(trade), inFlight = this.manualJobs.get(key), generation = this.generations.get(kind) || 0;
    if (inFlight) { if (inFlight.identity !== identity) throw Error('This request ID was already used for different trade settings.'); return inFlight.task; }
    const task = (async () => {
      const store = this.manager.storeFor(this.id), data = await store.read(evmJournal(kind), {}), record = data.manualRequests?.find(r => r.id === trade.id);
      if (record) {
        if (record.identity !== identity) throw Error('This request ID was already used for different trade settings.');
        // Reading an accepted request must never start a new worker or repeat a
        // swap, even after a restart or a fee-policy/settings change.
        const result = manualResult(data, trade.id); result.complete = true;
        for (const row of result.results) if (row.state === 'queued') Object.assign(row, { state: 'skipped', error: 'The previous session ended before this wallet completed. Check Activity and pending transactions.' });
        return { ...this.status(kind), manualResult: result };
      }
      if ((this.generations.get(kind) || 0) !== generation) throw Error('Run stopped before this manual request started.');
      return this.perform('manualTrade', raw, kind, trade);
    })();
    this.manualJobs.set(key, { task, identity });
    try { return await task; } finally { if (this.manualJobs.get(key)?.task === task) this.manualJobs.delete(key); }
  }
  async releaseInventory(wallet, kind = 'market') {
    wallet = evmAddress(wallet);
    if (!['market', 'liquidity'].includes(kind)) throw Error('Choose Market Making or LP management.');
    if (this.busyKinds.has(kind) || this.status(kind).state !== 'stopped') throw Error('Stop this strategy first.');
    this.busyKinds.add(kind);
    try {
      const settings = (await this.manager.readSettings(this.id)).settings;
      if (!settings.wallets.some(w => w.publicKey === wallet && w.tool === kind)) throw Error('Choose a wallet from this tool.');
      const worker = this.workers.get(kind);
      if (worker && !worker.failed) return await worker.release(wallet, 'live');
      const store = this.manager.storeFor(this.id), ledger = await store.read(evmJournal(kind), {});
      if (ledger.pending?.some(p => p.wallet === wallet) || ledger.lots?.some(l => l.wallet === wallet && BigInt(l.remaining || l.liquidity || 0) > 0n)) throw Error('Close the positions and reconcile pending transactions first.');
      delete ledger[kind === 'market' ? 'inventory' : 'lpFunds']?.[wallet]; if (ledger.version) await store.write(evmJournal(kind), ledger);
    } finally { this.busyKinds.delete(kind); }
  }
  claimFees(allocation, raw) { return this.perform('claimFees', raw, 'liquidity', allocation); }
  withdraw(allocation, raw) { return this.perform('withdraw', raw, 'liquidity', allocation); }
  convertInventory(wallet, raw) { return this.perform('convertInventory', raw, 'liquidity', { wallet }); }
  stop(kind) { for (const key of kind ? [kind] : Object.keys(TOOL_NAMES)) { this.generations.set(key, (this.generations.get(key) || 0) + 1); this.workers.get(key)?.stop(); } this.emit('change'); return this.status(kind); }
  async close() { this.stop(); await Promise.all([...this.workers.values()].map(w => w.close())); }
}
export class RobinhoodRuntimeManager {
  constructor(accounts, policy, { maxActive = 5, solana = null, engineFactory = (s, p, o) => new TelegramEngine(s, p, o) } = {}) { Object.assign(this, { accounts, policy, maxActive, solana, engineFactory }); this.runs = new Map(); this.settingsJobs = new Map(); }
  storeFor(id) { return new ChainStore(this.accounts.storeFor(id)); }
  get(id) { if (!this.runs.has(id)) this.runs.set(id, new RobinhoodRuns(this, id)); return this.runs.get(id); }
  ownActiveCount() { return [...this.runs.values()].reduce((n, r) => n + Object.keys(TOOL_NAMES).filter(k => r.busyKinds.has(k) || r.status(k).state !== 'stopped').length, 0); }
  activeCount() { return this.ownActiveCount() + (this.solana?.activeCountSolana?.() ?? this.solana?.activeCount?.() ?? 0); }
  async readSettings(id) { const data = await ensureRobinhoodAccount(this.accounts, id); return { settings: structuredClone(data.settings), revision: data.revision }; }
  async saveSettings(id, raw, revision, generation) {
    const job = (this.settingsJobs.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      await ensureRobinhoodAccount(this.accounts, id);
      return this.accounts.mutate(async registry => {
        if (!registry.accounts.some(a => a.id === id)) throw Error('Account unavailable.');
        const store = this.accounts.storeFor(id), data = await store.read('robinhood-account');
        if (revision !== data.revision) throw Error('Settings changed on another device. Reload before saving.');
        if (this.get(id).busy) throw Error('Wait for the trading operation to finish before changing wallets.');
        const settings = cleanRobinhoodSettings(raw, data.settings);
        if (settings.wallets.some(w => w.publicKey === data.mainWallet.publicKey)) throw Error('Keep the cashback wallet separate from trading wallets.');
        const retained = new Set((await this.get(id).exposure()).map(e => e.wallet));
        for (const keys of this.get(id).reservations.values()) for (const key of keys) retained.add(key);
        if ([...retained].some(key => !settings.wallets.some(w => w.publicKey === key && data.settings.wallets.some(old => old.publicKey === key && old.tool === w.tool)))) throw Error('Keep wallets with active runs, positions, or pending transactions in their current tool.');
        let generated = [];
        if (generation) {
          generated = generateEvmWallets(generation.count, settings.wallets, generation.kind); settings.wallets.push(...generated);
          settings.runWallets[generation.kind].push(...generated.map(w => w.publicKey));
        }
        data.settings = settings; data.revision++;
        await store.write('robinhood-account', data);
        return { settings: structuredClone(settings), revision: data.revision, generated: generated.map(({ publicKey, label, tool }) => ({ publicKey, label, tool })) };
      });
    });
    this.settingsJobs.set(id, job); try { return await job; } finally { if (this.settingsJobs.get(id) === job) this.settingsJobs.delete(id); }
  }
  generateWallets(id, raw, revision, count, kind = 'copy') { return this.saveSettings(id, raw, revision, { count, kind }); }
  async view(id, kind = 'copy') {
    const run = this.get(id), current = run.status(kind), ledger = await this.storeFor(id).read(evmJournal(kind), {});
    return { ...current, manualResult: manualResult({ pending: [], ...ledger }, current.manualResult?.id) || current.manualResult, positions: ledger.lots?.filter(l => BigInt(l.remaining || l.liquidity || 0) > 0n) || [], inventory: kind === 'market' ? ledger.inventory || {} : kind === 'liquidity' ? ledger.lpFunds || {} : {}, pending: (ledger.pending || []).map(({ signed, data, ...p }) => p), events: current.events?.length ? current.events : ledger.events || [], runs: Object.fromEntries(Object.entries(run.status().runs).map(([k, v]) => [k, { state: v.state, kind: k, runId: v.runId }])) };
  }
  async close() { this.closing = true; await Promise.all([...this.runs.values()].map(r => r.close())); }
}
