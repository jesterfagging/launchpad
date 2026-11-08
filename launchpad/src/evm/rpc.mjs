// A small JSON-RPC client for an EVM chain: paced, with timeouts, retries for reads (never silently for a
// broadcast), batch requests, and errors that carry the method and the node's reason without wire payloads.
// Contract reads and sends go through `call` / `send` with the ABI helpers.
import { publicEndpoint } from '../telegram-network.mjs';
import { scrubRpcMessage } from '../robinhood-rpc-errors.mjs';
import { toQuantity, hexToBigInt } from './hex.mjs';
import { encodeCall, decodeResult, abiItem, decodeRevert } from './abi.mjs';

const RETRYABLE = new Set(['eth_call', 'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getLogs',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_estimateGas', 'eth_feeHistory', 'eth_maxPriorityFeePerGas', 'eth_gasPrice', 'eth_getStorageAt']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class RpcError extends Error {
  constructor(method, message, extra = {}) {
    super(message);
    this.name = 'RpcError';
    this.rpcMethod = method;
    Object.assign(this, extra);
  }
}

export class EvmRpc {
  /**
   * @param {object} options {url, chainId?, requestsPerSecond = 20, timeoutMs = 15000, retries = 3, fetcher = fetch, log?}
   */
  constructor({ url, chainId = null, requestsPerSecond = 20, timeoutMs = 15000, retries = 3, fetcher = globalThis.fetch, log = null, insecure = false }) {
    // `insecure` admits a plain-HTTP local node (tests against anvil); the service never sets it.
    this.url = insecure ? String(url) : publicEndpoint(url).toString();
    this.expectedChainId = chainId == null ? null : BigInt(chainId);
    this.interval = 1000 / Math.max(1, requestsPerSecond);
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.fetcher = fetcher;
    this.log = log;
    this.nextAt = 0;
    this.sequence = 0;
    this.queue = Promise.resolve();
  }

  pace() {
    const run = this.queue.then(async () => {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextAt = Math.max(Date.now(), this.nextAt) + this.interval;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async post(body) {
    await this.pace();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      if (!response.ok) {
        const retryAfter = Number(response.headers?.get?.('retry-after')) || 0;
        throw new RpcError(Array.isArray(body) ? 'batch' : body.method, `HTTP ${response.status}`, { rpcStatus: response.status, rateLimited: response.status === 429, retryAfterMs: retryAfter * 1000, transient: response.status === 429 || response.status === 403 || response.status >= 500, blocked: response.status === 403 });
      }
      if (json === null) throw new RpcError(Array.isArray(body) ? 'batch' : body.method, 'invalid response', { transient: true, rpcReason: 'invalid response' });
      return json;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      const reason = error?.name === 'AbortError' ? 'timed out' : scrubRpcMessage(error?.message || 'fetch failed', this.url);
      throw new RpcError(Array.isArray(body) ? 'batch' : body.method, `RPC ${reason}`, { transient: true, rpcReason: reason, cause: error });
    } finally { clearTimeout(timer); }
  }

  /** One JSON-RPC call. Reads retry on transient failures; everything else is tried once. */
  async request(method, params = [], { retries = RETRYABLE.has(method) ? this.retries : 0 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        const json = await this.post({ jsonrpc: '2.0', id: ++this.sequence, method, params });
        if (json.error) {
          const code = json.error.code, reason = scrubRpcMessage(json.error.message || 'RPC error', this.url);
          throw new RpcError(method, `${method}: ${reason}`, { rpcCode: code, rpcReason: reason, rpcData: typeof json.error.data === 'string' ? json.error.data : json.error.data?.data ?? null, rateLimited: code === 429 || code === -32005, transient: code === 429 || code === -32005 });
        }
        return json.result;
      } catch (error) {
        if (!(error instanceof RpcError) || !error.transient || attempt >= retries) throw error;
        // A 403 is a public endpoint's block (rate or bot protection): give it a few seconds, not a few hundred milliseconds.
        const delay = Math.min(10000, (error.retryAfterMs || 0) || (error.blocked ? 3000 : 400) * 2 ** attempt);
        this.log?.('rpc-retry', { method, attempt: attempt + 1, delay, reason: error.rpcReason || error.message });
        await sleep(delay);
      }
    }
  }

  /** Several reads in one HTTP request (falls back to one by one when the node refuses batches). */
  async batch(calls) {
    if (!calls.length) return [];
    const ids = calls.map(() => ++this.sequence);
    let json;
    try { json = await this.post(calls.map((c, i) => ({ jsonrpc: '2.0', id: ids[i], method: c.method, params: c.params || [] }))); } catch (error) {
      if (!error.transient && error.rpcStatus !== 400) throw error;
      return Promise.all(calls.map(c => this.request(c.method, c.params || [])));
    }
    if (!Array.isArray(json)) return Promise.all(calls.map(c => this.request(c.method, c.params || [])));
    const byId = new Map(json.map(entry => [entry.id, entry]));
    return calls.map((c, i) => {
      const entry = byId.get(ids[i]);
      if (!entry) throw new RpcError(c.method, `${c.method}: missing batch response`, { transient: true });
      if (entry.error) { const reason = scrubRpcMessage(entry.error.message || 'RPC error', this.url); throw new RpcError(c.method, `${c.method}: ${reason}`, { rpcCode: entry.error.code, rpcReason: reason, rpcData: typeof entry.error.data === 'string' ? entry.error.data : null }); }
      return entry.result;
    });
  }

  // ------------------------------------------------------------------ typed helpers

  async chainId() { return hexToBigInt(await this.request('eth_chainId')); }
  async assertChain() {
    const id = await this.chainId();
    if (this.expectedChainId !== null && id !== this.expectedChainId) throw new RpcError('eth_chainId', `The RPC serves chain ${id}, not ${this.expectedChainId}.`, { rpcReason: 'wrong chain' });
    return id;
  }
  async blockNumber() { return hexToBigInt(await this.request('eth_blockNumber')); }
  async getBlock(tag = 'latest', full = false) { return this.request('eth_getBlockByNumber', [typeof tag === 'string' ? tag : toQuantity(tag), full]); }
  async getBalance(address, tag = 'latest') { return hexToBigInt(await this.request('eth_getBalance', [address, tag])); }
  async getTransactionCount(address, tag = 'latest') { return Number(hexToBigInt(await this.request('eth_getTransactionCount', [address, tag]))); }
  async getCode(address, tag = 'latest') { return this.request('eth_getCode', [address, tag]); }
  async getTransactionReceipt(hash) { return this.request('eth_getTransactionReceipt', [hash]); }
  async getTransaction(hash) { return this.request('eth_getTransactionByHash', [hash]); }
  async getLogs({ address, topics, fromBlock, toBlock }) {
    return this.request('eth_getLogs', [{ address, topics, fromBlock: typeof fromBlock === 'string' ? fromBlock : toQuantity(fromBlock), toBlock: typeof toBlock === 'string' ? toBlock : toQuantity(toBlock) }]);
  }
  async sendRawTransaction(raw) { return this.request('eth_sendRawTransaction', [raw]); }

  /** eth_call of raw calldata; a revert throws an RpcError with `revertData` (the node's returned data, when any). */
  async call({ to, data, from, value }, tag = 'latest') {
    const tx = { to, data };
    if (from) tx.from = from;
    if (value) tx.value = toQuantity(value);
    try { return await this.request('eth_call', [tx, tag]); } catch (error) {
      if (error instanceof RpcError && error.rpcData) error.revertData = error.rpcData;
      throw error;
    }
  }

  /** Reads a contract function through the ABI. */
  async read({ address, abi, functionName, args = [], from, value }, tag = 'latest') {
    const item = abiItem(abi, functionName);
    const data = await this.call({ to: address, data: encodeCall(item, args), from, value }, tag);
    if (data === '0x' || data == null) throw new RpcError('eth_call', `${functionName}: no code at ${address} or empty return`, { rpcReason: 'empty return' });
    return decodeResult(item, data);
  }

  /** Gas estimate for a transaction; a revert throws with the decoded error when `errors` is given. */
  async estimateGas({ from, to, data, value }, errors = []) {
    const tx = { from, to, data };
    if (value) tx.value = toQuantity(value);
    try { return hexToBigInt(await this.request('eth_estimateGas', [tx])); } catch (error) {
      if (error instanceof RpcError && error.rpcData) { error.revertData = error.rpcData; error.revert = decodeRevert(error.rpcData, errors); }
      throw error;
    }
  }

  /** EIP-1559 fee suggestion: base fee from the latest block, priority fee from the node, a 25% head room on both. */
  async feeData() {
    const [block, priority] = await Promise.all([this.getBlock('latest'), this.request('eth_maxPriorityFeePerGas').catch(() => '0x0')]);
    const baseFee = hexToBigInt(block?.baseFeePerGas || '0x0');
    let maxPriorityFeePerGas = hexToBigInt(priority);
    if (maxPriorityFeePerGas === 0n) maxPriorityFeePerGas = baseFee > 0n ? 1n : 0n;
    const maxFeePerGas = baseFee * 5n / 4n + maxPriorityFeePerGas + 1n;
    return { baseFee, maxPriorityFeePerGas, maxFeePerGas, blockNumber: hexToBigInt(block?.number || '0x0') };
  }
}
