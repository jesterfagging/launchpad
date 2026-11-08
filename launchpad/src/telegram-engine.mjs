import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { operatorCapacity, operatorRpcOptions, operatorJupiterInterval } from './operator-capacity.mjs';

const kinds = new Set(['copy', 'market', 'liquidity', 'sniper']);
export class TelegramEngine extends EventEmitter {
  constructor(store, platformContext = null, { journalKind = null, rpcGate = null, rpcScope = '', chain = 'solana' } = {}) {
    super(); this.current = { state: 'stopped', kind: 'copy', mode: 'live', positions: [], pending: [], events: [], metrics: {} };
    this.sequence = 0; this.pending = new Map(); this.generation = 0; this.closed = false; this.closing = false;
    this.rpcGate = rpcGate; this.rpcScope = rpcScope; this.rpcClient = randomUUID(); this.rpcPending = new Map();
    this.runId = randomUUID(); this.manualRequests = new Map(); this.journalKind = journalKind; this.chain = chain;
    if (!['solana', 'robinhood'].includes(chain)) throw Error('Unknown worker chain.');
    this.worker = new Worker(new URL(chain === 'robinhood' ? './robinhood-worker.mjs' : './telegram-worker.mjs', import.meta.url), {
      workerData: { dir: store.dir, key: store.key, context: store.context, platformContext, journalKind, sharedRpc: !!rpcGate },
      resourceLimits: { maxOldGenerationSizeMb: 512 }, stdout: true, stderr: true,
    });
    // Provider exceptions must never write customer URLs or keys to the host console.
    this.worker.stdout.resume(); this.worker.stderr.resume();
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.worker.on('message', message => {
      if (message.type?.startsWith('rpc-')) { this.rpcMessage(message); return; }
      if (message.type === 'ready') this.resolveReady();
      if (message.type === 'status' || (message.type === 'reply' && message.value)) {
        this.current = message.value;
        if (this.current.state === 'stopped' && this.current.inventoryRefresh?.state !== 'refreshing') this.rpcGate?.removeClient(this.rpcClient);
        this.emit('change');
      }
      if (message.type === 'reply') {
        const request = this.pending.get(message.id); this.pending.delete(message.id);
        if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.value);
      }
    });
    this.worker.on('error', () => this.fail());
    this.worker.on('exit', () => { if (!this.closed) this.fail(); });
  }
  rpcMessage(message) {
    if (!this.rpcGate) return;
    const service = message.service || 'rpc', id = `${service}:${message.id}`;
    if (!['rpc','jupiter','jito'].includes(service)) return;
    if (message.type === 'rpc-cancel') { this.rpcPending.get(id)?.abort(); return; }
    if (typeof message.key !== 'string' || !/^[a-f0-9]{64}$/.test(message.key)) return;
    const paced = service !== 'rpc', gate = paced ? this.rpcGate.requests : this.rpcGate;
    const key = `${paced ? service : 'rpc'}:${message.key}`;
    if (message.type === 'rpc-cooldown') { gate.cooldown(key, message.wait); return; }
    if (message.type !== 'rpc-permit') return;
    const controller = new AbortController(); this.rpcPending.set(id, controller);
    const reply = value => { if (!this.closed && !this.failed) this.worker.postMessage({ type: 'rpc-reply', service, id: message.id, ...value }); };
    const capacity = operatorCapacity(), options = paced ? { maxQueue: capacity.maxProviderQueue, requestDeadlineMs: capacity.requestDeadlineMs } : operatorRpcOptions(message.key);
    const interval = service === 'jupiter' ? operatorJupiterInterval(message.key) : 1050;
    gate.acquire(key, this.rpcClient, paced ? interval : message.rate, { ...options, method: message.method, signal: controller.signal, deadline: message.deadline })
      .then(() => reply({}), error => reply({ error: error.message, details: { rateLimited: error.rateLimited, capacityLimited: error.capacityLimited, retryable: error.retryable, retryAfterMs: error.retryAfterMs } }))
      .finally(() => this.rpcPending.delete(id)).catch(() => {});
  }
  clearRpc() { for (const controller of this.rpcPending.values()) controller.abort(); this.rpcGate?.removeClient(this.rpcClient); }
  fail() {
    if (this.failed) return; this.failed = true; this.clearRpc();
    const error = new Error('Trading worker stopped unexpectedly. Reopen the menu and review pending transactions before restarting.');
    this.rejectReady(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear(); this.current = { ...this.current, state: 'stopped', startupError: error.message,
      stopReason: { id: randomUUID(), at: Date.now(), message: error.message } };
    this.emit('change');
  }
  get state() { return this.current.state; }
  status() { return { ...this.current, runId: this.runId }; }
  async request(method, raw, extra = {}) {
    if (this.failed || this.closed) throw new Error('Trading worker is unavailable.');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ ...extra, id, method, raw }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async begin(method, raw, kind, extra = {}) {
    if (this.closing || this.closed || this.operation) throw new Error('Wait for the current operation to finish.');
    if (!kinds.has(kind)) throw new Error('Unknown trading mode.');
    if (method === 'start' && this.state !== 'stopped') throw new Error('Stop the current run first.');
    if (['withdraw', 'claimFees'].includes(method) && this.state !== 'stopped' && this.current.kind !== 'liquidity') throw new Error('Stop the current run before withdrawing liquidity.');
    if (method === 'manualTrade' && this.state !== 'stopped' && (this.state !== 'running' || !['copy', 'sniper'].includes(this.current.kind))) throw new Error('Stop the active strategy before manual trading.');
    if (method === 'manualTrade' && extra.trade?.expectedRunId !== undefined && extra.trade.expectedRunId !== this.runId) throw new Error('The run changed. Review the manual trade again.');
    const generation = ++this.generation, wasStopped = this.state === 'stopped';
    let sent = false;
    this.operation = true;
    if (wasStopped) { this.current = { ...this.current, state: 'starting', kind, mode: raw?.mode || 'paper', startupError: null, stopReason: null }; this.emit('change'); }
    try {
      await this.ready;
      if (generation !== this.generation || this.closing) throw new Error('Run stopped.');
      if (method === 'start' || (method === 'manualTrade' && wasStopped)) this.runId = randomUUID();
      sent = true; return await this.request(method, raw, { ...extra, kind });
    } finally {
      this.operation = false;
      // An authoritative worker reply carries stopping/running state. Only undo
      // optimistic startup if no operation reached the worker or it failed early.
      if (!sent && (this.state === 'starting' || this.state === 'stopping')) {
        this.current = { ...this.current, state: 'stopped' }; this.emit('change');
      }
    }
  }
  start(raw, kind = 'copy') { return this.begin('start', raw, kind); }
  refreshInventory(raw) {
    if (this.inventoryRefreshTask) return this.inventoryRefreshTask;
    if (this.closing || this.closed || this.operation || this.state !== 'stopped' || Date.now() < (this.inventoryRefreshAfter || 0)) return Promise.resolve(this.status());
    this.inventoryRefreshAfter = Date.now() + 10000;
    const generation = this.generation;
    const task = (async () => {
      await this.ready;
      if (generation !== this.generation || this.closing || this.closed || this.operation || this.state !== 'stopped') return this.status();
      await this.request('refreshInventory', raw); return this.status();
    })().finally(() => { if (this.inventoryRefreshTask === task) this.inventoryRefreshTask = null; });
    this.inventoryRefreshTask = task; return task;
  }
  async cancelInventoryRefresh() {
    const task = this.inventoryRefreshTask;
    if (!task) return;
    // Also invalidate a refresh waiting for worker readiness, before it has an
    // AbortController in the worker that the cancellation command can reach.
    ++this.generation;
    await this.request('cancelInventoryRefresh').catch(() => {});
    await task.catch(() => {});
  }
  manualTrade(raw, trade) {
    if (typeof trade?.id !== 'string' || !trade.id || trade.id.length > 128) throw new Error('A manual trade request ID is required.');
    const hash = createHash('sha256').update(JSON.stringify({ raw, trade })).digest('hex'), cached = this.manualRequests.get(trade.id);
    if (cached) {
      if (cached.hash !== hash) throw new Error('This manual trade request ID was already used with different settings.');
      const status = this.status();
      return !cached.settled && status.manualResult?.id === trade.id ? Promise.resolve(status) : cached.promise;
    }
    const entry = { hash, settled: false };
    const promise = this.begin('manualTrade', raw, this.chain === 'robinhood' ? this.journalKind : this.journalKind === 'sniper' ? 'sniper' : 'copy', { trade }).then(() => { entry.settled = true; return this.status(); }, error => { entry.settled = true; throw error; });
    entry.promise = promise; this.manualRequests.set(trade.id, entry);
    if (this.manualRequests.size > 100) this.manualRequests.delete(this.manualRequests.keys().next().value);
    return promise;
  }
  withdraw(wallet, raw) { return this.begin('withdraw', raw, 'liquidity', { wallet }); }
  claimFees(wallet, raw) { return this.begin('claimFees', raw, 'liquidity', { wallet }); }
  convertInventory(wallet, raw) { if (this.chain !== 'robinhood' || this.state !== 'stopped') throw Error('Stop Robinhood Liquidity before completing its ETH withdrawal.'); return this.begin('convertInventory', raw, 'liquidity', { wallet }); }
  async release(id, mode) {
    if (this.closing || this.closed || this.operation || this.state !== 'stopped') throw new Error('Stop the current run before releasing an allocation.');
    const generation = ++this.generation;
    this.operation = true;
    try {
      await this.ready;
      if (generation !== this.generation || this.closing) throw new Error('Operation stopped.');
      return await this.request('release', undefined, { allocation: id, mode });
    }
    finally { this.operation = false; }
  }
  stop() {
    ++this.generation;
    if (this.inventoryRefreshTask && this.state === 'stopped' && !this.operation) { this.request('stop').catch(() => {}); return this.current; }
    if (this.state === 'stopped' && !this.operation) return this.current;
    this.current = { ...this.current, state: 'stopping' }; this.emit('change');
    // Sending Stop does not wait for startup or its network requests to finish.
    this.request('stop').catch(() => {}); return this.current;
  }
  async close() {
    if (this.closed) return;
    if (this.closePromise) return this.closePromise;
    this.closing = true; ++this.generation;
    this.closePromise = (async () => {
      if (this.failed) { this.closed = true; this.clearRpc(); await this.worker.terminate(); return; }
      try { await this.ready; await this.request('close'); this.closed = true; this.clearRpc(); }
      catch (error) { this.closed = true; this.clearRpc(); await this.worker.terminate(); throw error; }
    })();
    return this.closePromise;
  }
}
