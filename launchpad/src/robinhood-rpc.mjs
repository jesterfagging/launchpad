import { createPublicClient, custom, formatUnits, parseUnits } from 'viem';
import { ROBINHOOD_CHAIN, CONTRACTS, erc20Abi, EVM_NATIVE, routerAbi } from './robinhood-contracts.mjs';
import { v2RouterAbi, v3PositionAbi } from './robinhood-legacy-contracts.mjs';
import { publicEndpoint } from './telegram-network.mjs';
import { evmAddress } from './robinhood-settings.mjs';
import { scrubRpcMessage, rpcRateLimit } from './robinhood-rpc-errors.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

const pause = (ms, signal) => new Promise((resolve, reject) => {
  const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
  const abort = () => { cleanup(); reject(signal.reason || Error('RPC request stopped.')); };
  const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
});
const retryableReads = new Set(['eth_call', 'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getLogs', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_estimateGas']);
const retryDelay = value => {
  const numeric = Number(value), time = value == null ? NaN : Number.isFinite(numeric) ? numeric * 1000 : Date.parse(value) - Date.now();
  return Math.min(120000, Math.max(250, Number.isFinite(time) ? time : 2000));
};

export function strictUnits(value, decimals) {
  const text = String(value);
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(text) || (text.split('.')[1]?.length || 0) > decimals) throw Error(`This token accepts at most ${decimals} decimal places.`);
  const result = parseUnits(text, decimals); if (result < 0n || result >= 2n ** 128n) throw Error('Token amount is outside the supported range.'); return result;
}
export class RobinhoodRpc {
  constructor(config, { signal, gate, fetcher = fetch } = {}) {
    this.config = config; this.url = publicEndpoint(config.rpcUrl).toString(); this.signal = signal; this.gate = gate; this.fetcher = fetcher; this.sequence = 0; this.tokens = new Map(); this.tokenReads = new Map(); this.nextAt = 0;
    this.reads = new Map(); this.blockedUntil = 0; this.effectiveRate = config.rpcRequestsPerSecond; this.lastReduction = 0; this.rateLimits = 0;
    this.priorities = new AsyncLocalStorage(); this.waiting = []; this.priorityBurst = 0; this.lastLimitedAt = 0; this.lastRecoveryAt = 0; this.successes = 0;
    this.client = createPublicClient({ chain: ROBINHOOD_CHAIN, transport: custom({ request: args => this.request(args) }, { retryCount: 0 }) });
  }
  async request({ method, params = [] }, { reconcile = false } = {}) {
    // Share only concurrent reads, never broadcasts, nonces or estimates. A
    // completed response is removed so the next transaction gets fresh state.
    const key = ['eth_call', 'eth_getBlockByNumber'].includes(method) ? JSON.stringify([method, params, reconcile]) : null;
    if (key && this.reads.has(key)) return this.reads.get(key);
    const job = this.requestOnce({ method, params }, { reconcile });
    if (key) this.reads.set(key, job);
    try { return await job; } finally { if (key && this.reads.get(key) === job) this.reads.delete(key); }
  }
  withPriority(priority, action) { return this.priorities.run(priority, action); }
  pace(signal, priority = 0) {
    signal.throwIfAborted();
    return new Promise((resolve,reject) => {
      const entry = { priority, resolve, reject, signal };
      entry.abort = () => { this.waiting = this.waiting.filter(row => row !== entry); reject(signal.reason || Error('RPC request stopped.')); this.pump(); };
      signal.addEventListener('abort', entry.abort, { once:true }); this.waiting.push(entry); this.pump();
    });
  }
  pump() {
    clearTimeout(this.paceTimer); this.paceTimer = null;
    if (!this.waiting.length || this.dispatching) return;
    const wait = Math.max(this.nextAt, this.blockedUntil) - Date.now();
    if (wait > 0) { this.paceTimer = setTimeout(() => this.pump(), wait); return; }
    // Prefer trade preparation, but give the oldest request every sixth slot
    // so lead scanning and receipts cannot starve under continuous activity.
    const index = this.priorityBurst >= 5 ? 0 : this.waiting.reduce((best,row,i,all) => row.priority > all[best].priority ? i : best, 0);
    this.priorityBurst = index ? this.priorityBurst + 1 : 0;
    const [entry] = this.waiting.splice(index,1); entry.signal.removeEventListener('abort',entry.abort);
    if (entry.signal.aborted) entry.reject(entry.signal.reason); else {
      this.dispatching = true; let finished = false;
      entry.resolve(() => {
        if (finished) return; finished = true;
        // Start the spacing clock when the request actually leaves, after any
        // shared-gate wait. A delayed gate must not release a burst of requests.
        this.nextAt = Date.now() + 1000 / this.effectiveRate; this.dispatching = false; this.pump();
      });
    }
    this.pump();
  }
  noteSuccess(now = Date.now()) {
    this.successes++;
    if (this.effectiveRate < this.config.rpcRequestsPerSecond && this.successes >= 10 && now - this.lastLimitedAt >= 15000 && now - this.lastRecoveryAt >= 5000 && now >= this.blockedUntil) {
      this.effectiveRate = Math.min(this.config.rpcRequestsPerSecond, this.effectiveRate + Math.max(1,Math.floor(this.effectiveRate / 5)));
      this.lastRecoveryAt = now; this.successes = 0;
    }
  }
  limited(method, reason, wait, code) {
    this.rateLimits++;
    const now = Date.now(); this.blockedUntil = Math.max(this.blockedUntil, now + wait); this.lastLimitedAt = now; this.successes = 0;
    if (now - this.lastReduction >= 2000) { this.effectiveRate = Math.max(1, Math.floor(this.effectiveRate / 2)); this.lastReduction = now; }
    this.gate?.cooldown(this.config, wait);
    return Object.assign(Error(`Robinhood RPC ${method}: ${reason}`), { rpcMethod: method, rpcReason: reason, rpcCode: code, rateLimited: true, retryable: true, retryAfterMs: wait });
  }
  status() { return { requests: this.sequence, rateLimits: this.rateLimits, configuredRequestsPerSecond: this.config.rpcRequestsPerSecond, effectiveRequestsPerSecond: this.effectiveRate, cooldownMs: Math.max(0, this.blockedUntil - Date.now()), queued: this.waiting.length }; }
  async requestOnce({ method, params }, { reconcile }) {
    const signal = reconcile ? AbortSignal.timeout(12000) : AbortSignal.any([this.signal || new AbortController().signal, AbortSignal.timeout(12000)]);
    for (let attempt = 0; ; attempt++) try {
      const dispatched = await this.pace(signal, reconcile ? -1 : this.priorities.getStore() || 0);
      let responsePromise;
      try {
        if (this.gate) await this.gate.acquire({ ...this.config, rpcRequestsPerSecond: this.effectiveRate }, signal, Date.now() + 12000);
        // A concurrent request may have received 429 while this permit was queued.
        if (this.blockedUntil > Date.now()) await pause(this.blockedUntil - Date.now(), signal);
        signal.throwIfAborted();
        responsePromise = this.fetcher(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.sequence, method, params }), signal });
      } finally { dispatched(); }
      const response = await responsePromise;
      if (!response.ok) {
        if (response.status === 429) throw Object.assign(this.limited(method, 'HTTP 429 — provider rate limit; requests are being slowed automatically.', retryDelay(response.headers?.get('retry-after')), 429), { rpcStatus: 429 });
        throw Object.assign(Error(`Robinhood RPC ${method} returned HTTP ${response.status}.`), { rpcMethod: method, rpcReason: `HTTP ${response.status}`, rpcStatus: response.status });
      }
      const data = await response.json();
      if (data.error) {
        const reason = scrubRpcMessage(data.error.message, this.url);
        if (data.error.code === 429 || /rate.?limit|too many requests|throughput|compute units? per second/i.test(reason)) throw this.limited(method, reason, 2000, data.error.code);
        const error = Error(`Robinhood RPC ${method} failed (${data.error.code ?? 'RPC error'}): ${reason}`);
        error.code = data.error.code; error.rpcCode = data.error.code; error.rpcMethod = method; error.rpcReason = reason;
        error.data = typeof data.error.data === 'string' && /^0x[0-9a-f]*$/i.test(data.error.data) ? data.error.data : undefined;
        throw error;
      }
      if (!Object.hasOwn(data, 'result')) throw Error(`Robinhood RPC ${method} returned an invalid response.`); this.noteSuccess(); return data.result;
    } catch (cause) {
      const limited = rpcRateLimit(cause);
      if (limited && attempt === 0 && retryableReads.has(method) && limited.retryAfterMs <= 3000 && !signal.aborted) {
        this.blockedUntil = Math.max(this.blockedUntil, Date.now() + limited.retryAfterMs);
        continue;
      }
      if (limited) throw cause;
      // Preserve provider details through viem's generic UnknownRpcError, but
      // never put the endpoint, request body or credentials into activity logs.
      if (cause.rpcMethod) throw cause;
      throw Object.assign(Error(`Robinhood RPC ${method} failed: ${scrubRpcMessage(cause.message, this.url)}`), { rpcMethod: method, rpcReason: scrubRpcMessage(cause.message, this.url) });
    }
  }
  async connect({ contracts = true } = {}) {
    if (await this.client.getChainId() !== ROBINHOOD_CHAIN.id) throw Error('RPC must be Robinhood mainnet, chain ID 4663. Ethereum and testnet RPCs cannot be used.');
    if (contracts) {
      for (const name of ['router', 'permit2', 'weth', 'poolManager', 'positionManager', 'quoter', 'stateView', 'v2Factory', 'v2Router', 'v3Factory', 'v3Quoter', 'v3PositionManager', 'ponsFactory', 'ponsV1Factory', 'airlock']) { const code = await this.client.getCode({ address: CONTRACTS[name] }); if (!code || code === '0x') throw Error(`The Robinhood ${name} contract is unavailable on this RPC.`); }
      // Universal Router's WETH9 immutable is internal; it has no public getter.
      for (const [address, abi, functionName, expected] of [[CONTRACTS.router, routerAbi, 'poolManager', CONTRACTS.poolManager], [CONTRACTS.v2Router, v2RouterAbi, 'factory', CONTRACTS.v2Factory], [CONTRACTS.v2Router, v2RouterAbi, 'WETH', CONTRACTS.weth], [CONTRACTS.v3PositionManager, v3PositionAbi, 'factory', CONTRACTS.v3Factory], [CONTRACTS.v3PositionManager, v3PositionAbi, 'WETH9', CONTRACTS.weth]]) {
        const actual = await this.client.readContract({ address, abi, functionName });
        if (actual.toLowerCase() !== expected.toLowerCase()) throw Error('Robinhood contract dependencies do not match the pinned deployment.');
      }
    }
    return this;
  }
  async token(address) {
    address = evmAddress(address); if (address === EVM_NATIVE) return { address, symbol: 'ETH', decimals: 18, uiMultiplier: '1000000000000000000' };
    if (this.tokens.has(address)) return this.tokens.get(address);
    if (this.tokenReads.has(address)) return this.tokenReads.get(address);
    const job = this.readToken(address); this.tokenReads.set(address, job);
    try { return await job; } finally { if (this.tokenReads.get(address) === job) this.tokenReads.delete(address); }
  }
  async readToken(address) {
    const decimals = Number(await this.client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }));
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw Error('Unsupported token decimals.');
    const symbol = String(await this.client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }).catch(() => address.slice(0, 8))).slice(0, 32);
    const uiMultiplier = String(await this.client.readContract({ address, abi: erc20Abi, functionName: 'uiMultiplier' }).catch(() => 10n ** 18n));
    const token = { address, symbol, decimals, uiMultiplier }; this.tokens.set(address, token); return token;
  }
  balance(wallet, token) { return token === EVM_NATIVE ? this.client.getBalance({ address: wallet }) : this.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }); }
  async displayBalance(wallet, address) { const token = await this.token(address), balance = await this.balance(wallet, address); return { ...token, raw: String(balance), amount: formatUnits(balance, token.decimals) }; }
}
