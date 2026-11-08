import { PublicKey } from '@solana/web3.js';
import { createPublicFetcher } from './telegram-network.mjs';

// Indexed historical USD volume, not a sum of overlapping rolling windows.
// https://api.geckoterminal.com/docs/index.html
const STORE = 'public-pool-volume-history', DAY = 86_400_000, MAX_POOLS = 4000;
const MAX_DAYS = 4000, REFRESH = 300_000, MAX_BODY = 1_000_000;
const address = value => { try { return typeof value === 'string' && new PublicKey(value).toBase58() === value; } catch { return false; } };
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const stamp = value => Number.isSafeInteger(value) && value >= 1_500_000_000_000;
const ensure = (value, message = 'Indexed historical volume is unavailable.') => { if (!value) throw Error(message); };
const day = value => Math.floor(value / DAY) * (DAY / 1000);
const pair = (a, b) => [a, b].sort().join(':');

export class PublicPoolVolumeHistory {
  constructor({ store, inventory, fetcher, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { store, inventory, now, setTimer, clearTimer });
    this.guarded = fetcher ? null : createPublicFetcher(); this.fetcher = fetcher || this.guarded.fetcher;
    this.data = { version: 1, pools: {} }; this.records = []; this.descriptors = new Map(); this.invalidPools = new Set();
    this.loaded = false; this.inventoryComplete = false; this.pending = null; this.closed = false;
    this.requests = []; this.retryAt = 0; this.timer = null; this.controller = null; this.lastError = null; this.poolRetries = new Map(); this.started = false;
  }
  async load() {
    if (this.loaded) return;
    const data = await this.store.read(STORE, { version: 1, pools: {} });
    ensure(data?.version === 1 && data.pools && typeof data.pools === 'object' && !Array.isArray(data.pools) && Object.keys(data.pools).length <= MAX_POOLS);
    for (const [id, row] of Object.entries(data.pools)) {
      ensure(address(id) && address(row.base) && address(row.quote) && row.base !== row.quote && stamp(row.createdAt));
      ensure(stamp(row.at) && row.at <= this.now() + 5000 && typeof row.complete === 'boolean' && row.days && typeof row.days === 'object' && !Array.isArray(row.days) && Object.keys(row.days).length <= MAX_DAYS);
      for (const [time, volume] of Object.entries(row.days)) ensure(/^\d+$/.test(time) && Number(time) % 86400 === 0 && Number(time) <= day(this.now()) && finite(volume));
    }
    this.data = data; this.loaded = true;
  }
  sync({ records, sources, complete }) {
    // Bounded by the same 4,000-pool limit as the descriptors (Pump.fun coins now join this inventory).
    ensure(Array.isArray(records) && records.length <= MAX_POOLS && sources instanceof Map);
    this.records = records; this.inventoryComplete = complete === true;
    const descriptors = new Map(), invalidPools = new Set();
    const launchLabCurves = new Set(records.filter(record => !record.platform || record.platform === 'raydium').map(record => record.curve));
    const add = row => {
      if (launchLabCurves.has(row.id) || invalidPools.has(row.id)) return;
      if (!address(row.id) || !address(row.base) || !address(row.quote) || row.base === row.quote || !stamp(row.createdAt) || row.createdAt > this.now() + 5000) { this.inventoryComplete = false; return; }
      const old = descriptors.get(row.id) || this.data.pools[row.id];
      if (old && pair(old.base, old.quote) !== pair(row.base, row.quote)) { this.inventoryComplete = false; invalidPools.add(row.id); descriptors.delete(row.id); return; }
      const prior = descriptors.get(row.id);
      descriptors.set(row.id, { ...row, priority: Math.max(row.priority || 0, prior?.priority || 0) });
    };
    for (const record of records) {
      if (!address(record.mint) || !address(record.curve) || !address(record.quote?.mint)) { this.inventoryComplete = false; continue; }
      const source = sources.get(record.mint)?.dexRaw;
      const validSource = source && source.tokenAddress === record.mint && source.chain === 'solana' && Array.isArray(source.pools);
      if (!validSource || source.stale === true || !stamp(source.at) || this.now() - source.at > 900_000) this.inventoryComplete = false;
      const createdAt = id => {
        const pool = validSource && source.pools.find(pool => pool.address === id && pool.token === record.mint && pair(pool.base?.address, pool.quote?.address) === pair(record.mint, record.quote.mint) && stamp(pool.createdAt) && pool.createdAt <= this.now() + 5000);
        return pool?.createdAt || this.data.pools[id]?.createdAt || record.createdAt;
      };
      // Native venues name their own curve and graduation pool, so indexed history can replace the
      // local trade ledger only as a complete group (never added on top of it).
      if (['damm-pump', 'meteora', 'pump-classic'].includes(record.platform)) {
        add({ id: record.curve, base: record.mint, quote: record.quote.mint, createdAt: createdAt(record.curve), priority: 0 });
        const destination = record.chainRecord?.review?.poolId;
        if (destination) add({ id: destination, base: record.mint, quote: record.quote.mint, createdAt: createdAt(destination), priority: 0 });
      }
      for (const pool of validSource ? source.pools : []) {
        if (pool.token !== record.mint || ![pool.base?.address, pool.quote?.address].includes(record.mint)) { this.inventoryComplete = false; continue; }
        // LaunchLab history already contains this exact curve. Its other pools
        // are separate markets and must be included once in the lifetime sum.
        if ((!record.platform || record.platform === 'raydium') && pool.address === record.curve) continue;
        add({ id: pool.address, base: pool.base.address, quote: pool.quote.address, createdAt: pool.createdAt || record.createdAt, priority: finite(pool.volume24h) ? pool.volume24h : 0 });
      }
    }
    // Preserve known pool identities when an index temporarily drops a market.
    const mints = new Set(records.map(row => row.mint));
    for (const [id, row] of Object.entries(this.data.pools)) if (!descriptors.has(id) && (mints.has(row.base) || mints.has(row.quote))) add({ id, base: row.base, quote: row.quote, createdAt: row.createdAt, priority: 0 });
    ensure(descriptors.size <= MAX_POOLS); this.descriptors = descriptors; this.invalidPools = invalidPools;
  }
  async request(row) {
    const url = new URL(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${row.id}/ohlcv/day`);
    url.searchParams.set('aggregate', '1'); url.searchParams.set('limit', '1000'); url.searchParams.set('currency', 'usd'); url.searchParams.set('token', 'base'); url.searchParams.set('include_empty_intervals', 'true');
    this.requests = this.requests.filter(at => this.now() - at < 60_000);
    ensure(this.requests.length < 8 && this.now() >= this.retryAt && !this.closed);
    this.requests.push(this.now()); const controller = new AbortController(); this.controller = controller;
    let timeout; const deadline = new Promise((_, reject) => { timeout = this.setTimer(() => { controller.abort(); reject(Error('Indexed volume timed out.')); }, 10_000); });
    const read = async () => {
      const response = await this.fetcher(url.toString(), { method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json;version=20230203' } });
      ensure(!controller.signal.aborted && !this.closed);
      if (response.status === 429) {
        const raw = response.headers.get('retry-after'), seconds = Number(raw), wait = raw && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - this.now();
        this.retryAt = this.now() + Math.min(900_000, Math.max(60_000, Number.isFinite(wait) ? wait : 60_000));
      }
      ensure(response.ok); const reader = response.body.getReader(), parts = []; let size = 0;
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; ensure(size <= MAX_BODY); parts.push(Buffer.from(value)); } }
      finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(parts).toString());
    };
    try {
      const result = await Promise.race([read(), deadline]), bars = result?.data?.attributes?.ohlcv_list;
      ensure(!controller.signal.aborted && !this.closed);
      ensure(pair(result?.meta?.base?.address, result?.meta?.quote?.address) === pair(row.base, row.quote));
      ensure(Array.isArray(bars) && bars.length > 0 && bars.length <= 1000 && bars[0]?.[0] === day(this.now()));
      const old = this.data.pools[row.id], days = { ...(old?.days || {}) }; let previous = Infinity;
      for (const bar of bars) {
        ensure(Array.isArray(bar) && bar.length === 6 && Number.isSafeInteger(bar[0]) && bar[0] >= 1_500_000_000 && bar[0] % 86400 === 0 && bar[0] <= day(this.now()) && (previous === Infinity || previous - bar[0] === 86400) && bar.slice(1).every(finite));
        previous = bar[0]; days[String(bar[0])] = bar[5];
      }
      ensure(Object.keys(days).length <= MAX_DAYS);
      // A short response alone is not proof of launch-to-date coverage. Its
      // first day must reach the pool's creation day (free history is bounded).
      let complete = (day(this.now()) - day(row.createdAt)) / 86400 < MAX_DAYS;
      for (let time = day(row.createdAt); complete && time <= day(this.now()); time += 86400) if (!Object.hasOwn(days, String(time))) complete = false;
      const next = { version: 1, pools: { ...this.data.pools, [row.id]: { base: row.base, quote: row.quote, createdAt: row.createdAt, days, at: this.now(), complete } } };
      ensure(Buffer.byteLength(JSON.stringify(next)) <= 48_000_000);
      if (!this.closed) { await this.store.write(STORE, next); this.data = next; }
    } finally { this.clearTimer(timeout); this.controller = null; }
  }
  async collect() {
    await this.load(); this.sync(await this.inventory());
    const rows = [...this.descriptors.values()].filter(row => (this.poolRetries.get(row.id) || 0) <= this.now() && (!this.data.pools[row.id] || this.data.pools[row.id].createdAt !== row.createdAt || this.now() - this.data.pools[row.id].at >= REFRESH));
    rows.sort((a, b) => (this.data.pools[a.id]?.at || 0) - (this.data.pools[b.id]?.at || 0) || b.priority - a.priority || a.id.localeCompare(b.id));
    for (const row of rows.slice(0, 4)) {
      if (this.closed || this.now() < this.retryAt || this.requests.filter(at => this.now() - at < 60000).length >= 8) break;
      try { await this.request(row); this.poolRetries.delete(row.id); this.lastError = null; }
      catch { this.lastError = 'provider'; this.poolRetries.set(row.id, this.now() + REFRESH); }
    }
  }
  tick() {
    if (this.closed) return Promise.resolve();
    return this.pending ||= this.collect().catch(() => { this.lastError = 'unavailable'; }).finally(() => { this.pending = null; });
  }
  selection() {
    const excluded = new Set(), replacementFresh = new Set(), selected = new Set(), blocked = new Set();
    for (const record of this.records) {
      if (!['damm-pump', 'meteora', 'pumpswap', 'pump-classic'].includes(record.platform)) continue;
      const required = [record.curve, record.chainRecord?.review?.poolId].filter(Boolean);
      const ready = required.every(id => this.descriptors.has(id) && !this.invalidPools.has(id) && this.data.pools[id]?.complete === true && this.data.pools[id].createdAt === this.descriptors.get(id).createdAt && pair(this.data.pools[id].base, this.data.pools[id].quote) === pair(record.mint, record.quote?.mint));
      if (ready) { excluded.add(record.curve); for (const id of required) selected.add(id); if (required.every(id => this.now() - this.data.pools[id].at <= REFRESH * 3)) replacementFresh.add(record.curve); }
      else for (const id of required) blocked.add(id);
    }
    for (const id of this.descriptors.keys()) if (!blocked.has(id)) selected.add(id);
    const pools = [...selected].flatMap(id => this.data.pools[id] ? [{ id, ...this.data.pools[id] }] : []);
    return { excluded, replacementFresh, pools, expected: this.descriptors.size, complete: this.loaded && this.inventoryComplete && !this.lastError && ![...this.poolRetries.keys()].some(id => this.descriptors.has(id)) && pools.length === this.descriptors.size && pools.every(row => row.complete && row.createdAt === this.descriptors.get(row.id)?.createdAt && this.now() - row.at <= REFRESH * 3), refreshing: !!this.pending };
  }
  start() {
    if (this.started || this.closed) return; this.started = true;
    const run = async () => { await this.tick(); if (!this.closed) { this.timer = this.setTimer(run, 30_000); this.timer?.unref?.(); } }; void run();
  }
  close() { this.closed = true; if (this.timer !== null) this.clearTimer(this.timer); this.controller?.abort(); this.guarded?.close(); }
}
