import { PublicKey } from '@solana/web3.js';
import { createPublicFetcher } from './telegram-network.mjs';
import { PublicRefreshQueue, boundedRefresh } from './public-refresh-queue.mjs';

// Raydium's own LaunchLab chart consumes these values in quote-token units:
// https://github.com/raydium-io/raydium-ui-v3-public/blob/master/src/components/TradingView/datafeed.ts
// https://docs.raydium.io/api-reference/launch-history-v1-endpoints/candle-data/get-kline-candlestick-data
const HISTORY_URL = 'https://launch-history-v1.raydium.io/kline';
const TTL_MS = 30_000;
const TIMEOUT_MS = 1_500;
const MAX_BODY_BYTES = 256_000;
const MAX_ENTRIES = 1000;
const MAX_PENDING = 8;
const MAX_REQUESTS_PER_MINUTE = 60;
const STALE_MS=15*60_000;

function validPoolId(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}

function candlesFrom(data, poolId, now) {
  if (data?.success !== true || !Array.isArray(data?.data?.rows) || data.data.rows.length > 300) return null;
  if (!data.data.rows.length) return null;
  const seen = new Set(), candles = [];
  const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
  for (const row of data.data.rows) {
    // Pool identity is required on every row; never silently mix another market.
    if (row?.poolId !== poolId || !Number.isSafeInteger(row.t) || row.t < 1_500_000_000 || row.t > Math.floor(now / 1000) + 60 || seen.has(row.t)) return null;
    if (![row.o, row.h, row.l, row.c].every(positive) || row.l > row.h) return null;
    if (row.vB != null && (typeof row.vB !== 'number' || !Number.isFinite(row.vB) || row.vB < 0)) return null;
    seen.add(row.t);
    // Custom quote pairs can omit volume. Raydium also carries the previous
    // close into open while high/low describe only this bucket's executions.
    candles.push(Object.freeze({ time: row.t, open: row.o, high: Math.max(row.o,row.h,row.c), low: Math.min(row.o,row.l,row.c), close: row.c, volume: row.vB ?? null }));
  }
  candles.sort((a, b) => a.time - b.time);
  return Object.freeze({ candles: Object.freeze(candles), at: now, source: 'Raydium history' });
}

export async function readLaunchHistoryJson(response) {
  const size = Number(response.headers.get('content-length'));
  if (Number.isFinite(size) && size > MAX_BODY_BYTES) throw new Error('History response is too large.');
  if (!response.body?.getReader) throw new Error('Invalid history response.');
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) throw new Error('History response is too large.');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export class LaunchCurveHistory {
  constructor({ fetcher, now = Date.now, timeoutMs = TIMEOUT_MS,waitMs=2000 } = {}) {
    this.guarded = fetcher ? null : createPublicFetcher();
    this.fetcher = fetcher || this.guarded.fetcher;
    this.now = now;
    // Tests may shorten the deadline; callers cannot extend the public request.
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.min(TIMEOUT_MS, Math.max(1, timeoutMs)) : TIMEOUT_MS;
    this.cache = new Map();
    this.pending = new Map();
    this.controllers = new Set();
    this.requests = [];
    this.retryUntil = 0;
    this.closed = false;
    this.waitMs=Math.max(1,Math.min(2000,waitMs));
    this.queue=new PublicRefreshQueue({concurrency:MAX_PENDING,perMinute:MAX_REQUESTS_PER_MINUTE,now});
  }

  stale(cached){return cached?.value&&this.now()-cached.value.at<STALE_MS?{...cached.value,stale:true}:null;}

  async read(poolId) {
    if (!validPoolId(poolId)) throw Object.assign(new Error('Choose a valid launch curve.'), { statusCode: 400 });
    if (this.closed) return null;
    this.queue.drain();
    const now = this.now(), cached = this.cache.get(poolId);
    if (cached && cached.until > now) return cached.value;
    if (this.pending.has(poolId)){const job=this.pending.get(poolId);return this.stale(cached)||(!job.started?null:boundedRefresh(job,()=>this.stale(cached),this.waitMs));}
    if(this.retryUntil>now)this.queue.cooldown(this.retryUntil);
    const scheduled=this.queue.run(()=>this.fetchHistory(poolId));
    if(!scheduled)return this.stale(cached);
    const job = scheduled.catch(() => null).then(value => {
      value=value?{...value,stale:false}:this.stale(cached);
      if (!this.closed) {
        this.cache.delete(poolId);
        this.cache.set(poolId, { value, until: this.now() + (value?.stale?10_000:TTL_MS) });
        while (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value);
      }
      return value;
    }).finally(() => this.pending.delete(poolId));
    Object.defineProperty(job,'started',{get:()=>scheduled.started});this.pending.set(poolId, job);
    return this.stale(cached)||(!scheduled.started?null:boundedRefresh(job,()=>this.stale(cached),this.waitMs));
  }

  async fetchHistory(poolId) {
    this.requests=this.requests.filter(at=>at>this.now()-60_000);this.requests.push(this.now());
    const url = new URL(HISTORY_URL);
    url.searchParams.set('poolId', poolId);
    url.searchParams.set('interval', '1m');
    url.searchParams.set('limit', '300');
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, this.timeoutMs);
    });
    const request = (async () => {
      const response = await this.fetcher(url.toString(), { method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } });
      if (controller.signal.aborted || this.closed) return null;
      if (response.status === 429) {
        const retry = response.headers.get('retry-after') || '';
        const delay = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.now();
        this.retryUntil = Math.max(this.retryUntil, this.now() + (Number.isFinite(delay) && delay > 0 ? delay : 60_000));
        this.queue.cooldown(this.retryUntil);
        await response.body?.cancel().catch(() => {});
        return null;
      }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
      const data = await readLaunchHistoryJson(response);
      if (controller.signal.aborted || this.closed) return null;
      return candlesFrom(data, poolId, this.now());
    })().catch(() => null);
    try { return await Promise.race([request, timeout]); }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
  }

  close() {
    this.closed = true;
    this.queue.close();
    for (const controller of this.controllers) controller.abort();
    this.guarded?.close();
    this.cache.clear();
    this.requests = [];
  }
}
