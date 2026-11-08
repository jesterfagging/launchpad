import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { LAUNCHPAD_TREASURY_MINT, TREASURY_POLICY } from './protocol-treasury.mjs';
import { includeManualProtocolHistory, MANUAL_PROTOCOL_HISTORY } from './protocol-manual-history.mjs';
import { freshBurnPrice } from '../public/burn-valuation.mjs';
import { publicCombinedBurnAnalytics } from './public-direct-burns.mjs';
import { includeImportedBurnHistory } from './public-imported-burns.mjs';
import { unavailableRevenueAnalytics } from './public-revenue-analytics.mjs';

const REFRESH_MS = 60_000, MAX = 2n ** 64n - 1n;
// Visitor poll interval, and the shorter cache/poll interval for a report that
// is still warming up or had to reuse/omit a failed source.
const CLIENT_REFRESH_MS = 30_000, DEGRADED_REFRESH_MS = 10_000;
// A visitor waits at most this long for a rebuild while a previous report
// (no older than MAX_STALE_MS) can be served; the rebuild still completes.
// A served report keeps its own generatedAt, so visitors label it by its age.
const STALE_WAIT_MS = 2_000, MAX_STALE_MS = 300_000;
// A failed source section may reuse its last good value only while that value
// is no older than the visitors' two-minute freshness label. Reused values sit
// inside a newly generated report, so a longer reuse would present old numbers
// under a current "Updated" time.
const MAX_SECTION_AGE_MS = 120_000;
const degradedReports = new WeakSet();
const uint = value => typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= MAX ? value : null;
const timestamp = (value, now) => Number.isSafeInteger(value) && value > 0 && value <= now + 5000 && value <= 8640000000000000 ? value : null;
const address = value => { try { return typeof value === 'string' && new PublicKey(value).toBase58() === value; } catch { return false; } };
const signature = value => { try { return typeof value === 'string' && value.length >= 64 && value.length <= 88 && bs58.decode(value).length === 64; } catch { return false; } };
const baseTreasury = status => ({ status, complete: status === 'available', buybackBps: TREASURY_POLICY.buybackBps,
  curveMint: LAUNCHPAD_TREASURY_MINT, solDecimals: 9, curveDecimals: null, solSpent: null, curveBought: null, curveBurned: null,
  updatedAt: null, history: [], historyScope: 'Recent retained confirmed buyback and burn operations; not a complete transaction history.',
  evidence: 'saved-confirmed-receipts' });

// Project the persisted ledger directly. Do not invoke treasury.load()/view(),
// inspect private signing keys, initialize a chain, or trigger transaction work.
export function publicTreasuryAnalytics(state, now = Date.now()) {
  if (state === null || state === undefined) return baseTreasury('unconfigured');
  const unavailable = () => baseTreasury('unavailable');
  if (state.version !== 1 || !state.totals || !Array.isArray(state.history)) return unavailable();
  const solSpent = uint(state.totals.buybackSpent), curveBought = uint(state.totals.curveBought), curveBurned = uint(state.totals.curveBurned);
  if ([solSpent, curveBought, curveBurned].includes(null) || BigInt(curveBurned) > BigInt(curveBought) || (BigInt(solSpent) === 0n) !== (BigInt(curveBought) === 0n)) return unavailable();
  if (!state.wallet) return solSpent === '0' && curveBought === '0' && curveBurned === '0' ? baseTreasury('unconfigured') : unavailable();
  if (!address(state.wallet.address)) return unavailable();
  const updatedAt = timestamp(state.updatedAt, now);
  if (updatedAt === null) return unavailable();
  const curveDecimals = Number.isInteger(state.curveDecimals) && state.curveDecimals >= 0 && state.curveDecimals <= 18 ? state.curveDecimals : null;
  const seen = new Map();
  for (const op of state.history) {
    if (!op || op.state !== 'confirmed' || !['buy', 'burn'].includes(op.kind) || !signature(op.signature)) continue;
    const confirmedAt = timestamp(op.confirmedAt, now), inputAmount = uint(op.inputAmount), outputAmount = uint(op.outputAmount);
    if (confirmedAt === null || inputAmount === null || outputAmount === null || BigInt(inputAmount) === 0n || op.kind === 'buy' && BigInt(outputAmount) === 0n) continue;
    const row = { kind: op.kind, signature: op.signature, inputAmount, outputAmount, confirmedAt };
    const operationKey = row.signature + ':' + row.kind;
    const prior = seen.get(operationKey);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) return unavailable();
    seen.set(operationKey, row);
  }
  let retainedSpent = 0n, retainedBought = 0n, retainedBurned = 0n;
  for (const row of seen.values()) {
    if (row.kind === 'buy') { retainedSpent += BigInt(row.inputAmount); retainedBought += BigInt(row.outputAmount); }
    else retainedBurned += BigInt(row.inputAmount);
  }
  if (retainedSpent > BigInt(solSpent) || retainedBought > BigInt(curveBought) || retainedBurned > BigInt(curveBurned)) return unavailable();
  return { ...baseTreasury('available'), curveDecimals, solSpent, curveBought: curveDecimals === null ? null : curveBought,
    curveBurned: curveDecimals === null ? null : curveBurned, updatedAt,
    history: [...seen.values()].sort((a, b) => b.confirmedAt - a.confirmedAt).slice(0, 12),
    note: 'Cumulative managed protocol treasury totals from saved confirmed receipts. Token-level agent buybacks and unrelated transfers are excluded. Transactions are not re-verified on each page view.' };
}

// Recorded buyback purchases (SOL) and burns (LAUNCHPAD) by UTC day for the chart
// on the public page. Receipts are deduplicated by signature and operation
// across the same sources the headline totals use (managed journal, verified
// manual history, direct burns, administrator imports), so one transaction is
// never counted twice. Amounts stay raw integer strings; the series is a
// recorded subtotal whenever any source is incomplete, and it never changes a
// total, a budget or a journal. Days without activity are omitted.
const DAY_MS = 86_400_000, SERIES_DAYS = 30;
export function receiptDailySeries({ treasury, burns, direct, knownTreasuryReceipts = [], imported, now = Date.now(), days = SERIES_DAYS } = {}) {
  const known = value => ['available', 'partial'].includes(value?.status);
  const valid = row => row && ['buy', 'burn'].includes(row.kind) && signature(row.signature) && timestamp(row.confirmedAt, now) !== null && uint(row.inputAmount) !== null && BigInt(row.inputAmount) > 0n;
  const treasuryKnown = known(treasury), burnsKnown = known(burns);
  const managedKnown = treasuryKnown && (treasury.managedStatus === 'available' || treasury.status === 'available' && !treasury.manualIncluded);
  const candidates = [
    ...(managedKnown && Array.isArray(knownTreasuryReceipts) ? knownTreasuryReceipts.filter(row => row?.state === 'confirmed') : []),
    ...(treasuryKnown && treasury.manualIncluded ? MANUAL_PROTOCOL_HISTORY.filter(row => row.confirmedAt <= now) : []),
    ...(treasuryKnown && Array.isArray(treasury.history) ? treasury.history : []),
    ...(burnsKnown && known(direct) && Array.isArray(direct.history) ? direct.history : []),
    ...(burnsKnown && Array.isArray(burns.history) ? burns.history : []),
    ...(imported?.status === 'available' && Array.isArray(imported.history) ? imported.history.filter(row => row?.source === 'admin') : []),
  ];
  const seen = new Map();
  for (const row of candidates) { if (!valid(row)) continue; const key = row.signature + ':' + row.kind; if (!seen.has(key)) seen.set(key, row); }
  const start = Math.floor(now / DAY_MS) * DAY_MS - (Math.max(1, Math.min(366, days)) - 1) * DAY_MS, buckets = new Map();
  for (const row of seen.values()) {
    if (row.confirmedAt < start) continue;
    const date = new Date(row.confirmedAt).toISOString().slice(0, 10);
    const bucket = buckets.get(date) || { date, solSpent: 0n, curveBurned: 0n, buys: 0, burns: 0 };
    if (row.kind === 'buy') { bucket.solSpent += BigInt(row.inputAmount); bucket.buys++; } else { bucket.curveBurned += BigInt(row.inputAmount); bucket.burns++; }
    buckets.set(date, bucket);
  }
  const complete = (treasury?.status === 'unconfigured' || treasury?.status === 'available' && treasury.complete !== false) && burns?.status === 'available' && burns.complete === true && (!imported || imported.status === 'available' && imported.complete === true);
  return { timezone: 'UTC', days: Math.max(1, Math.min(366, days)), complete, solDecimals: 9, curveDecimals: 6,
    rows: [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date)).map(bucket => ({ ...bucket, solSpent: bucket.solSpent.toString(), curveBurned: bucket.curveBurned.toString() })),
    note: 'Recorded buyback purchases (SOL) and burns (LAUNCHPAD) by UTC day, deduplicated by receipt. A recorded subtotal while any source is incomplete; days without receipts are omitted.' };
}

function unavailableVolume() {
  return { launches: { total: null, last24h: null, uniqueDevelopers: null, uniqueDevelopers24h: null,
    observedTotal: null, observedLast24h: null, observedUniqueDevelopers: null, observedUniqueDevelopers24h: null, complete: false },
  dailyLaunches: { timezone: 'UTC', complete: false, days: [] }, inventoryAt: null,
  volume: { period: '24h', usd: null, observedUsd: null, complete: false, sampledUsd: null, sampledObservedUsd: null,
    sampling: { oldestAt: null, newestAt: null, cachedCoins: 0, maxAgeMs: 900000 },
    coverage: { launches: null, usdComplete: 0, partial: 0, unavailable: 0, unpriced: 0, inventoryComplete: false },
    lifetimeUsd: null, lifetimeStatus: 'unavailable', refreshing: false, asOf: null,
    note: 'Current volume data is temporarily unavailable. Lifetime volume is not reconstructed from overlapping daily totals.' } };
}

// One report and one in-flight refresh per host, independent of visitor count.
// The volume service shares the admin's bounded provider queue and cached data.
export class PublicAnalytics {
  constructor({ accounts, volume, lifetime, revenue, burnHistory, burnSupply, now = Date.now, staleWaitMs = STALE_WAIT_MS, maxStaleMs = MAX_STALE_MS, maxSectionAgeMs = MAX_SECTION_AGE_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { accounts, volume, lifetime, revenue, burnHistory, burnSupply, now, staleWaitMs, maxStaleMs, maxSectionAgeMs, setTimer, clearTimer }); this.cached = null; this.pending = null; this.closed = false; this.generation = 0;
    // Last successfully read sections, reused (bounded) when a later read fails
    // so a transient source error does not replace known values with dashes.
    this.sections = {};
  }
  withBurnSupply(report, refreshMs = CLIENT_REFRESH_MS) {
    // The mint reader is background-only. Project its latest verified snapshot
    // even while the expensive market/receipt report is cached; no visitor RPC.
    let burnSupply = null;
    try { burnSupply = this.burnSupply?.readPublic() ?? null; } catch {}
    // servedAt lets visitors measure their clock offset from this host.
    return { ...structuredClone(report), refreshMs, burnSupply: structuredClone(burnSupply), servedAt: this.now() };
  }
  settledWithin(promise, ms) {
    let timer;
    return Promise.race([promise.then(() => true, () => true), new Promise(resolve => { timer = this.setTimer(() => resolve(false), ms); })])
      .finally(() => this.clearTimer(timer));
  }
  async read() {
    for (;;) {
      if (this.closed) throw Object.assign(Error('Public analytics is restarting.'), { statusCode: 503 });
      const cached = this.cached, age = cached ? this.now() - cached.generatedAt : Infinity, degraded = !!cached && degradedReports.has(cached);
      if (cached && age < (degraded ? DEGRADED_REFRESH_MS : REFRESH_MS)) return this.withBurnSupply(cached, degraded ? DEGRADED_REFRESH_MS : CLIENT_REFRESH_MS);
      const generation = this.generation;
      if (!this.pending || this.pendingGeneration !== generation) {
        const pending = this.build().then(result => {
          if (!this.closed && generation === this.generation) this.cached = result;
          return result;
        }).finally(() => { if (this.pending === pending) this.pending = null; });
        pending.catch(() => {}); // a background rebuild may finish with no waiter
        this.pending = pending; this.pendingGeneration = generation;
      }
      const pending = this.pending;
      // Cache expiry must not make every visitor wait for a slow rebuild (cold
      // provider caches, a large store scan). Serve the previous report briefly
      // and ask visitors to return sooner; the rebuild completes in the background.
      const servable = () => !!cached && !this.closed && generation === this.generation && this.now() - cached.generatedAt < this.maxStaleMs;
      if (cached && age < this.maxStaleMs && !(await this.settledWithin(pending, this.staleWaitMs))) {
        if (this.closed) throw Object.assign(Error('Public analytics is restarting.'), { statusCode: 503 });
        // invalidate() during the wait (e.g. a new burn receipt) retires the
        // previous report; never serve it after that.
        if (generation !== this.generation) continue;
        return this.withBurnSupply(cached, DEGRADED_REFRESH_MS);
      }
      let result;
      try { result = await pending; }
      catch (error) {
        // A failed rebuild keeps serving the previous report within its bounded
        // age (it keeps its own generatedAt) instead of failing every visitor.
        if (servable()) return this.withBurnSupply(cached, DEGRADED_REFRESH_MS);
        if (!this.closed && generation !== this.generation) continue;
        throw error;
      }
      if (generation === this.generation) return this.withBurnSupply(result, degradedReports.has(result) ? DEGRADED_REFRESH_MS : CLIENT_REFRESH_MS);
    }
  }
  invalidate() { this.generation++; this.cached = null; }
  // A failed section reuses its last successful value for a bounded time.
  section(name, result, now) {
    if (result.status === 'fulfilled') { if (!this.closed) this.sections[name] = { value: result.value, at: now }; return { value: result.value, reused: false }; }
    const previous = this.sections[name];
    if (previous && now - previous.at < this.maxSectionAgeMs) return { value: structuredClone(previous.value), reused: true };
    delete this.sections[name];
    return null;
  }
  async build() {
    const [marketResult, treasuryResult, importResult] = await Promise.allSettled([
      Promise.resolve().then(() => this.volume.readPublic()),
      Promise.resolve().then(() => {
        if (!this.accounts.hostStore?.read) throw Error('Unavailable');
        return this.accounts.hostStore.read('protocol-treasury', null);
      }),
      Promise.resolve().then(() => this.burnHistory?.readPublic() ?? { status: 'available', complete: true, history: [] }),
    ]);
    if (this.closed) throw Object.assign(Error('Public analytics is restarting.'), { statusCode: 503 });
    const now = this.now();
    // A degraded report (a reused section, or sources still warming up) is
    // cached and polled every 10s so it is replaced soon. A section that is
    // simply unavailable keeps the normal interval: an outage must not triple
    // visitor polling and rebuilds for as long as it lasts.
    let degraded = false;
    const marketSection = this.section('market', marketResult, now);
    const market = marketSection?.value || unavailableVolume();
    if (marketSection?.reused) degraded = true;
    if (marketSection?.reused && market.volume) market.volume = { ...market.volume, refreshing: true };
    // Cold market caches: ask visitors to come back sooner than the normal interval.
    if (market.volume?.refreshing === true && market.volume.observedUsd == null && market.volume.sampledObservedUsd == null) degraded = true;
    // Market refresh can finish fresh quote references during the bounded
    // wait above. Revalue saved lifetime trade amounts using that same view;
    // reading lifetime first captured the previous worker's empty price cache.
    let pricesByMint;
    try { pricesByMint = this.volume.quotePrices?.(); } catch {}
    const [lifetimeResult, revenueResult] = await Promise.allSettled([
      Promise.resolve().then(() => this.lifetime?.readPublic({ pricesByMint }) ?? null),
      Promise.resolve().then(() => this.revenue?.readPublic?.({ pricesByMint, tokenPrice: mint => this.volume.tokenPrice?.(mint) }) ?? unavailableRevenueAnalytics()),
    ]);
    const lifetimeSection = this.section('lifetime', lifetimeResult, now), revenueSection = this.section('revenue', revenueResult, now);
    const lifetime = lifetimeSection?.value ?? null;
    const revenue = revenueSection?.value || unavailableRevenueAnalytics();
    if (lifetimeSection?.reused || revenueSection?.reused || lifetime?.status === 'loading') degraded = true;
    if (this.closed) throw Object.assign(Error('Public analytics is restarting.'), { statusCode: 503 });
    const treasuryState=treasuryResult.status==='fulfilled'?treasuryResult.value:null;
    let treasury = includeManualProtocolHistory(treasuryResult.status === 'fulfilled' ? publicTreasuryAnalytics(treasuryState, now) : baseTreasury('unavailable'),now,treasuryState?.history||[]);
    // A current valuation reference, independent from historical spend and
    // confirmed burn totals. Missing or stale pricing never implies $0.
    treasury.curvePrice = null;
    try { treasury.curvePrice = freshBurnPrice(this.volume.tokenPrice?.(LAUNCHPAD_TREASURY_MINT), LAUNCHPAD_TREASURY_MINT, now); } catch {}
    let burns = publicCombinedBurnAnalytics(treasury, market.directBurns, treasuryState?.history || [], now);
    const imported = importResult.status === 'fulfilled' ? importResult.value : { status: 'unavailable', complete: false, history: [] };
    ({ treasury, burns } = includeImportedBurnHistory({ treasury, burns, direct: market.directBurns, knownTreasuryReceipts: treasuryState?.history || [], now, imported }));
    // The chart series is derived from the same deduplicated receipts; a
    // failure here only loses the chart, never the totals.
    try { burns = { ...burns, daily: receiptDailySeries({ treasury, burns, direct: market.directBurns, knownTreasuryReceipts: treasuryState?.history || [], imported, now }) }; }
    catch { burns = { ...burns, daily: { timezone: 'UTC', days: SERIES_DAYS, complete: false, solDecimals: 9, curveDecimals: 6, rows: [] } }; }
    const report = { version: 1, generatedAt: now, refreshMs: REFRESH_MS,
      scope: 'All Launchpad launches recorded on this host, including hidden and archived coins.',
      launches: market.launches, dailyLaunches: market.dailyLaunches, volume: market.volume, inventoryAt: market.inventoryAt,
      lifetime, revenue, rewards: market.rewards || null, treasury, burns };
    if (degraded) degradedReports.add(report);
    return report;
  }
  close() { this.closed = true; this.cached = null; }
}
