import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { createPublicFetcher } from './telegram-network.mjs';
import { readLaunchHistoryJson } from './launch-curve-history.mjs';

// Reporting only. Historical amounts are quote-token units, not historical USD.
// Cursor API: https://docs.raydium.io/api-reference/launch-history-v1-endpoints/trades/get-trade-history
const ENDPOINT = 'https://launch-history-v1.raydium.io/trade';
const STORE_KEY = 'public-lifetime-volume', INTERVAL = 30_000, PRICE_AGE = 120_000;
// Venues whose trades come from Launchpad's own services rather than Raydium's launch-history API.
const NATIVE_PLATFORMS = ['pumpswap', 'meteora', 'damm-pump', 'pump-classic'];
const SCALE = 10n ** 18n, HASH = /^[a-f0-9]{64}$/, INTEGER = /^(?:0|[1-9]\d{0,70})$/;
const address = value => { try { return typeof value === 'string' && new PublicKey(value).toBase58() === value; } catch { return false; } };
const digest = value => createHash('sha256').update(value).digest('hex');
const symbol = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 24) : 'Quote';
const date = seconds => new Date(seconds * 1000).toISOString().slice(0, 10);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const stamp = value => Number.isSafeInteger(value) && value >= 0;
const freshPrice = (value, mint, now) => value && (!value.mint || value.mint === mint) && value.stale !== true && typeof value.usd === 'number' && Number.isFinite(value.usd) && value.usd > 0 && stamp(value.at) && value.at <= now + 5000 && now - value.at <= PRICE_AGE;
const invalid = () => { throw Object.assign(Error('Invalid lifetime volume history.'), { code: 'HISTORY_INVALID' }); };
const units = value => Number(BigInt(value)) / 1e18;
const safeTotal = values => { const total = values.reduce((a, b) => a + b, 0); return Number.isFinite(total) ? total : null; };

// Sum the provider's decimal representation without accumulating floating-point
// drift. A provider value finer than 18 decimals is rejected rather than rounded.
function atoms(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e30) invalid();
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const shift = 18 + Number(exponent) - fraction.length;
  if (shift < 0) invalid();
  return (BigInt(whole + fraction) * 10n ** BigInt(shift)).toString();
}
const lane = () => ({ cursor: null, cursors: [], oldest: null, complete: false });
const newPool = record => ({ mint: record.mint, quoteMint: record.quote.mint, symbol: symbol(record.quote.symbol),
  events: {}, totalAtoms: '0', daily: {}, history: lane(), recent: lane(), turn: 0,
  lastSuccessAt: null, recentAt: null, failures: 0, retryAt: 0, problem: null });

export class PersistentLifetimeVolume {
  constructor({ store, inventory, quotePrices = async () => new Map(), pumpTrades, meteoraTrades, dammPumpTrades, pumpClassicTrades, poolHistory, fetcher, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 2000, maxPages = 6,
    maxPools = 1000, maxEvents = 200_000, maxCursors = 10_000 } = {}) {
    Object.assign(this, { store, inventory, quotePrices, pumpTrades, meteoraTrades, dammPumpTrades, pumpClassicTrades, poolHistory, now, setTimer, clearTimer });
    this.guarded = fetcher ? null : createPublicFetcher(); this.fetcher = fetcher || this.guarded.fetcher;
    this.timeoutMs = Math.max(1, Math.min(2000, timeoutMs)); this.maxPages = Math.max(1, Math.min(6, maxPages));
    this.maxPools = Math.max(1, Math.min(1000, maxPools)); this.maxEvents = Math.max(1, Math.min(200_000, maxEvents));
    this.maxCursors = Math.max(1, Math.min(10_000, maxCursors));
    this.data = { version: 1, pools: {}, at: null }; this.loaded = false; this.records = [];
    this.inventoryComplete = false; this.prices = new Map(); this.pending = null; this.timer = null;
    this.closed = false; this.started = false; this.lastTick = null; this.cursor = 0; this.dammCursor = 0; this.requests = [];
    this.retryUntil = 0; this.controllers = new Set(); this.storageError = false; this.lastError = null;
  }
  async load() {
    if (this.loaded) return;
    const data = await this.store.read(STORE_KEY, { version: 1, pools: {}, at: null });
    if (!plain(data) || data.version !== 1 || !plain(data.pools) || Object.keys(data.pools).length > this.maxPools || data.at !== null && !stamp(data.at)) invalid();
    let count = 0;
    for (const [poolId, pool] of Object.entries(data.pools)) {
      if (!address(poolId) || !plain(pool) || !address(pool.mint) || !address(pool.quoteMint) || !plain(pool.events) || !plain(pool.daily) || !INTEGER.test(pool.totalAtoms)) invalid();
      if (pool.source !== undefined && pool.source !== 'damm-pump-onchain' || pool.postGraduationIncluded !== undefined && typeof pool.postGraduationIncluded !== 'boolean') invalid();
      if (!stamp(pool.turn) || !stamp(pool.failures) || !stamp(pool.retryAt) || ![null, 'provider', 'history', 'capacity'].includes(pool.problem)) invalid();
      if (![pool.lastSuccessAt, pool.recentAt].every(value => value === null || stamp(value))) invalid();
      for (const state of [pool.history, pool.recent]) {
        if (!plain(state) || typeof state.complete !== 'boolean' || state.cursor !== null && (typeof state.cursor !== 'string' || !state.cursor || state.cursor.length > 2048) || !Array.isArray(state.cursors) || state.cursors.length > this.maxCursors || !state.cursors.every(value => HASH.test(value)) || state.oldest !== null && !stamp(state.oldest)) invalid();
      }
      let total = 0n; const daily = {};
      for (const [id, event] of Object.entries(pool.events)) {
        if (++count > this.maxEvents || !HASH.test(id) || !Array.isArray(event) || event.length !== 2 || !Number.isSafeInteger(event[0]) || event[0] < 1_500_000_000 || event[0] > Math.floor(this.now() / 1000) + 60 || !INTEGER.test(event[1]) || BigInt(event[1]) <= 0n) invalid();
        total += BigInt(event[1]); const key = date(event[0]); const bucket = daily[key] || { atoms: 0n, trades: 0 };
        bucket.atoms += BigInt(event[1]); bucket.trades++; daily[key] = bucket;
      }
      if (total.toString() !== pool.totalAtoms || Object.keys(daily).length !== Object.keys(pool.daily).length) invalid();
      for (const [key, bucket] of Object.entries(daily)) if (pool.daily[key]?.atoms !== bucket.atoms.toString() || pool.daily[key]?.trades !== bucket.trades) invalid();
    }
    this.data = data; this.loaded = true; this.storageError = false;
  }
  async commit(poolId, pool) {
    const next = { version: 1, at: this.now(), pools: { ...this.data.pools, [poolId]: pool } };
    // This journal is never pruned: forgetting a dedupe key could count an old
    // swap twice. Stop at a bounded size and keep the already recorded subtotal.
    if (Buffer.byteLength(JSON.stringify(next)) > 48_000_000) throw Object.assign(Error('Lifetime reporting capacity reached.'), { code: 'HISTORY_CAPACITY' });
    await this.store.write(STORE_KEY, next);
    this.data = next; this.storageError = false;
  }
  async request(poolId, cursor) {
    this.requests = this.requests.filter(at => this.now() - at < 60_000);
    if (this.closed || this.requests.length >= 12 || this.now() < this.retryUntil) throw Error('Lifetime history cooling down.');
    this.requests.push(this.now());
    const url = new URL(ENDPOINT); url.searchParams.set('poolId', poolId); url.searchParams.set('limit', '100');
    if (cursor !== null) url.searchParams.set('nextPageKey', cursor);
    const controller = new AbortController(); this.controllers.add(controller); let timer;
    const timeout = new Promise((_, reject) => { timer = this.setTimer(() => { controller.abort(); reject(Error('Lifetime history timed out.')); }, this.timeoutMs); });
    const work = (async () => {
      const response = await this.fetcher(url.toString(), { method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } });
      if (this.closed || controller.signal.aborted) throw Error('Lifetime history stopped.');
      if (response.status === 429) {
        const header = response.headers.get('retry-after') || '';
        const delay = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - this.now();
        this.retryUntil = this.now() + Math.min(900_000, Math.max(30_000, Number.isFinite(delay) ? delay : 60_000));
      }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw Error('Lifetime history unavailable.'); }
      const data = await readLaunchHistoryJson(response);
      if (this.closed || controller.signal.aborted) throw Error('Lifetime history stopped.');
      return data;
    })();
    try { return await Promise.race([work, timeout]); }
    finally { this.clearTimer(timer); this.controllers.delete(controller); }
  }
  async stepPump(record) {
    const provider=record.platform==='damm-pump'?this.dammPumpTrades:record.platform==='meteora'?this.meteoraTrades:record.platform==='pump-classic'?this.pumpClassicTrades:this.pumpTrades;
    if(typeof provider!=='function')throw Error('Launch history provider is unavailable.');
    const result=await provider(record.mint),rows=Array.isArray(result)?result:result?.trades;
    if(!Array.isArray(rows)||rows.length>this.maxEvents)throw Object.assign(Error('Lifetime reporting capacity reached.'),{code:'HISTORY_CAPACITY'});
    if(record.platform==='damm-pump'&&result?.source==='damm-pump-onchain')return this.replaceDammHistory(record,result);
    const pool=structuredClone(this.data.pools[record.curve]||newPool(record));
    if(pool.mint!==record.mint||pool.quoteMint!==record.quote.mint)invalid();
    // Once canonical chain events replace the legacy host journal, falling
    // back to host receipts would count the same trades under different IDs.
    if(pool.source==='damm-pump-onchain')throw Error('Verified onchain launch history is unavailable.');
    const page=new Map();
    for(const row of rows){
      const time=stamp(row.time)?row.time:stamp(row.at)?Math.floor(row.at/1000):null;
      if(!Number.isSafeInteger(time)||time<1500000000||time>Math.floor(this.now()/1000)+60||!['buy','sell'].includes(row.side)||!address(row.wallet)||typeof row.signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(row.signature))invalid();
      const decimals=record.platform==='pumpswap'?9:record.quote.decimals;
      const quantity=typeof row.quoteRaw==='string'&&/^[1-9]\d{0,39}$/.test(row.quoteRaw)&&Number.isInteger(decimals)&&decimals>=0&&decimals<=18?(BigInt(row.quoteRaw)*10n**BigInt(18-decimals)).toString():atoms(row.quote);atoms(row.amount);
      const id=digest(JSON.stringify([record.curve,row.signature,row.side,row.amount,row.quote,row.wallet]));
      const old=pool.events[id]||page.get(id);if(old&&(old[0]!==time||old[1]!==quantity))invalid();
      if(!old)page.set(id,[time,quantity]);
    }
    const total=Object.values(this.data.pools).reduce((n,value)=>n+Object.keys(value.events).length,0);
    if(total+page.size>this.maxEvents)throw Object.assign(Error('Lifetime reporting capacity reached.'),{code:'HISTORY_CAPACITY'});
    for(const [id,event]of page){pool.events[id]=event;pool.totalAtoms=(BigInt(pool.totalAtoms)+BigInt(event[1])).toString();const key=date(event[0]),bucket=pool.daily[key]||{atoms:'0',trades:0};pool.daily[key]={atoms:(BigInt(bucket.atoms)+BigInt(event[1])).toString(),trades:bucket.trades+1};}
    // The host journal does not cover direct external program trades. Preserve
    // useful recorded volume while explicitly keeping chain coverage partial.
    pool.history=lane();pool.recent=lane();pool.turn++;pool.lastSuccessAt=this.now();pool.recentAt=this.now();pool.failures=0;pool.retryAt=0;pool.problem=null;
    if(!this.closed)await this.commit(record.curve,pool);
  }
  async replaceDammHistory(record,result) {
    const current=this.data.pools[record.curve],rows=result.trades,decimals=record.quote.decimals;
    if(result.poolId!==record.curve||typeof result.complete!=='boolean'||typeof result.historyComplete!=='boolean'||typeof result.recentComplete!=='boolean'||result.complete!==(result.historyComplete&&result.recentComplete)||result.postGraduationIncluded!==true||!Number.isInteger(decimals)||decimals<0||decimals>18)invalid();
    if(current&&(current.mint!==record.mint||current.quoteMint!==record.quote.mint))invalid();
    // The source is a full durable snapshot, not a page. An empty initial
    // crawl must not erase the useful host subtotal before any chain evidence.
    if(!rows.length&&!result.complete)throw Error('Onchain launch history is still loading.');
    const headAt=result.at;
    if(headAt!==null&&headAt!==undefined&&(!stamp(headAt)||headAt>this.now()+5000))invalid();
    if(result.recentComplete&&!stamp(headAt))invalid();
    const pool={...newPool(record),source:'damm-pump-onchain',postGraduationIncluded:true};
    for(const row of rows){
      const time=row.time,id=row.eventId;
      if(!HASH.test(id)||!address(row.poolId)||!Number.isSafeInteger(time)||time<1500000000||time>Math.floor(this.now()/1000)+60||!['buy','sell'].includes(row.side)||!address(row.wallet)||typeof row.signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(row.signature)||typeof row.quoteRaw!=='string'||!/^[1-9]\d{0,39}$/.test(row.quoteRaw)||typeof row.baseRaw!=='string'||!/^[1-9]\d{0,39}$/.test(row.baseRaw))invalid();
      const quantity=(BigInt(row.quoteRaw)*10n**BigInt(18-decimals)).toString(),old=pool.events[id];
      if(old){if(old[0]!==time||old[1]!==quantity)invalid();continue;}
      pool.events[id]=[time,quantity];pool.totalAtoms=(BigInt(pool.totalAtoms)+BigInt(quantity)).toString();
      const key=date(time),bucket=pool.daily[key]||{atoms:'0',trades:0};pool.daily[key]={atoms:(BigInt(bucket.atoms)+BigInt(quantity)).toString(),trades:bucket.trades+1};
    }
    if(current?.source==='damm-pump-onchain')for(const [id,event]of Object.entries(current.events)){
      const next=pool.events[id];if(!next||next[0]!==event[0]||next[1]!==event[1])invalid();
    }
    const others=Object.entries(this.data.pools).reduce((n,[id,value])=>n+(id===record.curve?0:Object.keys(value.events).length),0);
    if(others+Object.keys(pool.events).length>this.maxEvents)throw Object.assign(Error('Lifetime reporting capacity reached.'),{code:'HISTORY_CAPACITY'});
    pool.history.complete=result.historyComplete;pool.recent.complete=result.recentComplete;
    pool.turn=(current?.turn||0)+1;pool.lastSuccessAt=this.now();pool.recentAt=result.recentComplete?headAt:null;
    if(!this.closed)await this.commit(record.curve,pool);
  }
  async step(record) {
    if(NATIVE_PLATFORMS.includes(record.platform))return this.stepPump(record);
    const current = this.data.pools[record.curve] || newPool(record);
    if (current.retryAt > this.now() || current.problem === 'capacity') return;
    if (current.mint !== record.mint || current.quoteMint !== record.quote.mint) invalid();
    const pool = structuredClone(current);
    const type = !pool.history.complete && pool.turn % 2 === 0 ? 'history' : 'recent';
    const progress = pool[type];
    const response = await this.request(record.curve, progress.cursor), rows = response?.data?.rows;
    if (response?.success !== true || !Array.isArray(rows) || rows.length > 100) invalid();
    const nextCursor = response.data.nextPageKey;
    if (nextCursor != null && (typeof nextCursor !== 'string' || nextCursor.length > 2048 || /[\x00-\x1f\x7f]/.test(nextCursor))) invalid();
    const next = nextCursor || null;
    if (next && (progress.cursors.includes(digest(next)) || next === progress.cursor)) invalid();
    const page = new Map(); let previous = progress.oldest ?? Infinity, newEvents = 0;
    for (const row of rows) {
      if (row?.poolId !== record.curve || !Number.isSafeInteger(row.blockTime) || row.blockTime < 1_500_000_000 || row.blockTime > Math.floor(this.now() / 1000) + 60 || !['buy', 'sell'].includes(row.side) || !address(row.owner) || typeof row.txid !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(row.txid)) invalid();
      const quantity = atoms(row.amountB); atoms(row.amountA);
      const id = digest(JSON.stringify([record.curve, row.txid, row.side, row.amountA, row.amountB, row.owner]));
      const old = pool.events[id] || page.get(id);
      if (old && (old[0] !== row.blockTime || old[1] !== quantity)) invalid();
      // Overlapping cursor pages are allowed; unseen rows must remain ordered.
      if (!old && row.blockTime > previous) invalid();
      previous = Math.min(previous, row.blockTime);
      if (!old) page.set(id, [row.blockTime, quantity]);
    }
    const totalEvents = Object.values(this.data.pools).reduce((n, value) => n + Object.keys(value.events).length, 0);
    if (totalEvents + page.size > this.maxEvents || next && progress.cursors.length >= this.maxCursors) throw Object.assign(Error('Lifetime reporting capacity reached.'), { code: 'HISTORY_CAPACITY' });
    for (const [id, event] of page) {
      pool.events[id] = event; pool.totalAtoms = (BigInt(pool.totalAtoms) + BigInt(event[1])).toString();
      const key = date(event[0]), bucket = pool.daily[key] || { atoms: '0', trades: 0 };
      pool.daily[key] = { atoms: (BigInt(bucket.atoms) + BigInt(event[1])).toString(), trades: bucket.trades + 1 }; newEvents++;
    }
    // A full page without a cursor is ambiguous and must not prove completion.
    const exhausted = next === null && rows.length < 100;
    const caughtUp = type === 'recent' && rows.length > 0 && newEvents === 0;
    if (exhausted || caughtUp) {
      if (type === 'history') pool.history = { ...lane(), complete: true };
      else { pool.recent = lane(); pool.recentAt = this.now(); }
    } else {
      if (next) { progress.cursor = next; progress.cursors.push(digest(next)); progress.oldest = Number.isFinite(previous) ? previous : null; }
      else { pool[type] = lane(); pool.problem = 'history'; }
    }
    pool.turn++; pool.lastSuccessAt = this.now(); pool.failures = 0; pool.retryAt = 0;
    if (next || exhausted || caughtUp) pool.problem = null;
    if (this.closed) return;
    await this.commit(record.curve, pool);
  }
  async collect() {
    try { await this.load(); } catch { this.storageError = true; this.lastError = 'storage'; return; }
    let inventory;
    try { inventory = await this.inventory(); } catch { this.inventoryComplete = false; this.lastError = 'inventory'; return; }
    if (!inventory || !Array.isArray(inventory.records) || inventory.records.length > 100_000) { this.inventoryComplete = false; return; }
    const records = new Map(), rejected = new Set(); let valid = inventory.complete === true;
    for (const record of inventory.records) {
      if (!record || !address(record.mint) || !address(record.curve) || !address(record.quote?.mint) || record.mint === record.quote.mint) { valid = false; continue; }
      if (rejected.has(record.curve)) continue;
      const old = records.get(record.curve), saved = this.data.pools[record.curve];
      if (old && (old.mint !== record.mint || old.quote.mint !== record.quote.mint) || saved && (saved.mint !== record.mint || saved.quoteMint !== record.quote.mint)) { valid = false; records.delete(record.curve); rejected.add(record.curve); continue; }
      records.set(record.curve, { mint: record.mint, curve: record.curve, platform: NATIVE_PLATFORMS.includes(record.platform)?record.platform:'raydium', quote: { mint: record.quote.mint, symbol: symbol(record.quote.symbol), decimals:record.quote.decimals } });
    }
    this.records = [...records.values()].sort((a, b) => a.curve.localeCompare(b.curve)); this.inventoryComplete = valid;
    try { const prices = await this.quotePrices(); this.prices = prices instanceof Map ? prices : new Map(); } catch { this.prices = new Map(); }
    if (this.closed) return;
    let knownPools = Object.keys(this.data.pools).length;
    const eligible = this.records.filter(record => this.data.pools[record.curve] || knownPools++ < this.maxPools);
    // PumpSwap-mode history reads an independently collected local snapshot.
    // Keep its bounded refresh lane separate from remote Raydium pagination so
    // a large legacy inventory or a provider cooldown cannot delay new trades.
    const damm = eligible.filter(record => record.platform === 'damm-pump'), remote = eligible.filter(record => record.platform !== 'damm-pump');
    const selected = damm.slice(this.dammCursor).concat(damm.slice(0, this.dammCursor)).slice(0, this.maxPages)
      .concat(remote.slice(this.cursor).concat(remote.slice(0, this.cursor)).slice(0, this.maxPages));
    if (knownPools > this.maxPools) this.inventoryComplete = false;
    this.cursor = remote.length ? (this.cursor + this.maxPages) % remote.length : 0;
    this.dammCursor = damm.length ? (this.dammCursor + this.maxPages) % damm.length : 0;
    for (const record of selected) {
      if (this.closed) break;
      if (record.platform !== 'damm-pump' && this.now() < this.retryUntil) continue;
      try { await this.step(record); this.lastError = null; }
      catch (error) {
        if (this.closed) return;
        const pool = structuredClone(this.data.pools[record.curve] || newPool(record));
        pool.problem = error.code === 'HISTORY_CAPACITY' ? 'capacity' : error.code === 'HISTORY_INVALID' ? 'history' : 'provider';
        pool.failures = Math.min(30, pool.failures + 1);
        pool.retryAt = this.now() + Math.min(900_000, INTERVAL * 2 ** Math.min(5, pool.failures - 1));
        // A provider can retire an opaque cursor while the server is offline.
        // Rewind after repeated failure, retaining every durable dedupe key.
        // Never turn an invalid page into a completed historical scan.
        if (pool.failures % 3 === 0 && pool.problem !== 'capacity') {
          if (!pool.history.complete) pool.history = lane();
          pool.recent = lane();
        }
        this.lastError = pool.problem;
        try { await this.commit(record.curve, pool); } catch { this.storageError = true; this.lastError = 'storage'; break; }
      }
    }
  }
  tick() {
    if (this.closed || this.pending || this.lastTick !== null && this.now() - this.lastTick < INTERVAL) return this.pending || Promise.resolve();
    this.lastTick = this.now(); this.pending = this.collect().catch(() => { this.lastError = 'unavailable'; }).finally(() => { this.pending = null; });
    return this.pending;
  }
  start() {
    if (this.started || this.closed) return; this.started = true;
    this.poolHistory?.start();
    const run = async () => { this.timer = null; await this.tick(); if (!this.closed) { this.timer = this.setTimer(run, INTERVAL); this.timer?.unref?.(); } };
    void run();
  }
  readPublic({ pricesByMint } = {}) {
    const now = this.now(), availablePrices = new Map(this.prices);
    for (const [mint, candidate] of pricesByMint instanceof Map ? pricesByMint : []) {
      const old = availablePrices.get(mint);
      if (freshPrice(candidate, mint, now) && (!freshPrice(old, mint, now) || candidate.at >= old.at)) availablePrices.set(mint, candidate);
    }
    const indexed = this.poolHistory?.selection();
    const excluded = indexed?.excluded || new Set();
    const groups = new Map(), days = new Map(), pools = Object.entries(this.data.pools).filter(([id]) => !excluded.has(id)).map(([, pool]) => pool);
    const postGraduationIncluded=!!indexed?.pools.length||pools.some(pool=>pool.source==='damm-pump-onchain'&&pool.postGraduationIncluded===true),scope=indexed?.pools.length?'launch-curves-and-indexed-pools':postGraduationIncluded?'launch-curves-and-pumpswap':'launch-curves';
    const allPools = new Set([...Object.keys(this.data.pools), ...this.records.map(record => record.curve)]);
    let backfilledLaunches = excluded.size, recordedLaunches = excluded.size, tradeCount = 0, recentTradeCount = 0, headFreshLaunches = indexed?.replacementFresh?.size || 0, oldestHeadAt = null, updatedAt = null, sourceProblem = false, reportingLimitReached = false;
    const cutoff = (now - 86_400_000) / 1000;
    for (const pool of pools) {
      const count = Object.keys(pool.events).length; tradeCount += count;
      const headAt = pool.recentAt ?? (pool.source !== 'damm-pump-onchain' && pool.turn === 1 && pool.history.complete ? pool.lastSuccessAt : null);
      if (headAt !== null && stamp(headAt) && headAt <= now + 5000) {
        oldestHeadAt = oldestHeadAt === null ? headAt : Math.min(oldestHeadAt, headAt);
        if (!pool.problem && now - headAt <= PRICE_AGE) headFreshLaunches++;
      }
      if (count) recordedLaunches++; if (pool.history.complete) backfilledLaunches++;
      if (pool.problem) sourceProblem = true;
      if (pool.problem === 'capacity') reportingLimitReached = true;
      if (pool.lastSuccessAt !== null) updatedAt = updatedAt === null ? pool.lastSuccessAt : Math.max(updatedAt, pool.lastSuccessAt);
      // A failed first fetch has no observed volume. Do not turn its default
      // zero accumulator into a publicly reported zero-volume market.
      if (pool.lastSuccessAt === null && count === 0) continue;
      const group = groups.get(pool.quoteMint) || { symbol: pool.symbol, atoms: 0n, recentAtoms: 0n, daily: {} };
      group.atoms += BigInt(pool.totalAtoms);
      for (const [time, amount] of Object.values(pool.events)) if (time >= cutoff && time <= now / 1000) { group.recentAtoms += BigInt(amount); recentTradeCount++; }
      for (const [key, bucket] of Object.entries(pool.daily)) {
        const prior = group.daily[key] || { atoms: 0n, trades: 0 };
        group.daily[key] = { atoms: prior.atoms + BigInt(bucket.atoms), trades: prior.trades + bucket.trades };
      }
      groups.set(pool.quoteMint, group);
    }
    let unpricedQuotes = 0, unpricedRecentQuotes = 0; const recentValues = [], recentQuoteTotals = [];
    const quoteTotals = [...groups].map(([mint, group]) => {
      const candidate = availablePrices.get(mint), price = freshPrice(candidate, mint, now) ? candidate.usd : null;
      const amount = units(group.atoms), usdEstimate = amount === 0 ? 0 : price === null ? null : amount * price;
      const priced = usdEstimate !== null && Number.isFinite(usdEstimate);
      if (!priced) unpricedQuotes++;
      const recentUsd = group.recentAtoms === 0n ? 0 : price === null ? null : units(group.recentAtoms) * price;
      const recentPriced = recentUsd !== null && Number.isFinite(recentUsd);
      if (recentPriced) recentValues.push(recentUsd); else unpricedRecentQuotes++;
      recentQuoteTotals.push({ symbol: group.symbol, amount: units(group.recentAtoms), usdEstimate: recentPriced ? recentUsd : null, priced: recentPriced });
      for (const [key, bucket] of Object.entries(group.daily)) {
        const day = days.get(key) || { date: key, values: [], tradeCount: 0, completePricing: true };
        const usd = price === null ? null : units(bucket.atoms) * price;
        if (usd !== null && Number.isFinite(usd)) day.values.push(usd); else day.completePricing = false;
        day.tradeCount += bucket.trades; days.set(key, day);
      }
      return { symbol: group.symbol, amount, usdEstimate: priced ? usdEstimate : null, priced };
    });
    const priced = quoteTotals.filter(group => group.priced);
    const noLaunches = this.loaded && this.inventoryComplete && allPools.size === 0;
    const curveVolumeUsdEstimate = priced.length ? safeTotal(priced.map(group => group.usdEstimate)) : noLaunches ? 0 : null;
    let indexedHistoricalVolumeUsd = 0;
    for (const pool of indexed?.pools || []) {
      updatedAt = Math.max(updatedAt || 0, pool.at);
      for (const [time, value] of Object.entries(pool.days)) {
        indexedHistoricalVolumeUsd += value;
        const key = date(Number(time)), bucket = days.get(key) || { date: key, values: [], tradeCount: 0, completePricing: true };
        bucket.values.push(value); days.set(key, bucket);
      }
    }
    const pricedVolumeUsdEstimate = indexed?.pools.length ? safeTotal([curveVolumeUsdEstimate || 0, indexedHistoricalVolumeUsd]) : curveVolumeUsdEstimate;
    const recordedVolumeUsdEstimate = unpricedQuotes === 0 && (pools.length || indexed?.pools.length || noLaunches) ? pricedVolumeUsdEstimate : null;
    const backfillComplete = this.loaded && this.inventoryComplete && !this.storageError && !sourceProblem && backfilledLaunches === allPools.size;
    // Exhausting historical pages once does not prove that new trades have
    // been collected today. Preserve the recorded subtotal while the head of
    // any market is stale, without calling that subtotal a current full total.
    const historyComplete = backfillComplete && headFreshLaunches === allPools.size && (!indexed || indexed.complete);
    return {
      at: now, period: 'lifetime', scope, status: this.storageError ? 'unavailable' : !this.loaded ? 'loading' : historyComplete && !unpricedQuotes ? 'available' : 'partial',
      recordedVolumeUsdEstimate, pricedVolumeUsdEstimate, tradeCount, quoteTotals: quoteTotals.sort((a, b) => a.symbol.localeCompare(b.symbol)),
      ...(indexed ? { indexedHistoricalVolumeUsd, curveVolumeUsdEstimate, valuationBasis: 'historical-indexed-usd-and-current-quote-estimate', tradeCountPartial: indexed.pools.length > 0 } : {}),
      daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(({ values, ...day }) => ({ ...day, volumeUsdEstimate: day.completePricing ? safeTotal(values) : null, pricedVolumeUsdEstimate: values.length ? safeTotal(values) : null })),
      coverage: { launches: allPools.size, backfilledLaunches, recordedLaunches, unpricedQuotes, inventoryComplete: this.inventoryComplete,
        historyComplete, backfillComplete, headFreshLaunches, oldestHeadAt, headFreshnessMaxAgeMs: PRICE_AGE,
        reportingLimitReached, postGraduationIncluded,
        ...(indexed ? { indexedPools: indexed.expected, indexedRecordedPools: indexed.pools.length, indexedHistoricalPools: indexed.pools.filter(pool => pool.complete).length, indexedFreshPools: indexed.pools.filter(pool => now - pool.at <= 900_000).length, indexedHistoryComplete: indexed.complete } : {}) },
      last24h: { period: '24h', scope, tradeCount: recentTradeCount,
        quoteTotals: recentQuoteTotals.sort((a, b) => a.symbol.localeCompare(b.symbol)),
        recordedVolumeUsdEstimate: unpricedRecentQuotes === 0 && (groups.size || noLaunches) ? safeTotal(recentValues) : null,
        pricedVolumeUsdEstimate: recentValues.length ? safeTotal(recentValues) : noLaunches ? 0 : null,
        historyComplete: historyComplete && !indexed?.pools.length,
        unpricedQuotes: unpricedRecentQuotes, postGraduationIncluded },
      updatedAt, refreshing: !!this.pending || indexed?.refreshing === true,
      note: indexed ? 'Lifetime volume includes hidden and archived launches. Indexed pool volume uses GeckoTerminal historical USD daily candles, deduplicated by pool and UTC day; refreshing replaces a candle instead of adding overlapping 24-hour windows. Complete original-pool and migration-pool history replaces the corresponding local trade ledger as a group, avoiding duplicate trades. Distinct Raydium and secondary pools add their own history. Remaining launch-curve amounts use current quote prices, so the combined figure is an estimate with mixed valuation methods. Unavailable or unfinished pool history remains partial. Trade counts and the ledger-only last24h field exclude candle-derived trades; use the separate rolling-volume report for 24-hour volume.' : 'Recorded lifetime volume includes hidden and archived launches. PumpSwap launch mode records finalized onchain trades in its original Meteora pool and verified PumpSwap destination, including external terminals and wallets. Other launch modes use Raydium launch-curve history or confirmed Pump and Meteora trades submitted through Launchpad; their external or post-graduation coverage remains limited. Historical pages are backfilled incrementally and swaps are deduplicated across refreshes and restarts. USD values estimate recorded quote amounts at current available quote prices, not prices at trade time. Unfinished history and unavailable prices are reported as partial coverage.',
    };
  }
  close() { this.closed = true; if (this.timer !== null) this.clearTimer(this.timer); for (const controller of this.controllers) controller.abort(); this.guarded?.close(); this.poolHistory?.close(); }
}
