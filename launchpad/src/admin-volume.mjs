import { PublicKey } from '@solana/web3.js';
import { pumpDiscoveryRecord, meteoraDiscoveryRecord, dammPumpDiscoveryRecord, pumpClassicDiscoveryRecord } from './launchpad-explore.mjs';
import { ray } from './launchpad-chain.mjs';
import { isCurrentLaunch } from '../public/launchpad-model.mjs';
import { quoteLabel } from '../public/quote-identity.mjs';
import { boundedRefresh } from './public-refresh-queue.mjs';
import { rewardAnalyticsRecord, publicRewardAnalytics } from './public-reward-analytics.mjs';
import { LAUNCHPAD_ANALYTICS_START_DAY } from '../public/analytics-dates.mjs';
import { freshBurnPrice } from '../public/burn-valuation.mjs';
import { directBurnRecord, publicDirectBurnAnalytics } from './public-direct-burns.mjs';

const REFRESH_MS = 30_000, DEX_REFRESH_MS = 5_000, SOURCE_MAX_AGE = 120_000, SAMPLE_MAX_AGE = 900_000;
// Venues whose market and trade data come from Launchpad's own services.
const NATIVE_ACTIVITY = ['pumpswap', 'meteora', 'pump-classic'];
const NATIVE_SOURCES = { meteora: 'Meteora recorded trades', pumpswap: 'Launchpad recorded trades', 'pump-classic': 'Pump.fun onchain trades' };
const fail = (message, statusCode = 503) => { throw Object.assign(Error(message), { statusCode }); };
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const positive = value => amount(value) > 0 ? value : null;
const text = (value, max = 100) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : '';
const timestamp = value => Number.isSafeInteger(value) && value > 0;
const address = value => { try { return typeof value === 'string' && new PublicKey(value).toBase58() === value ? value : null; } catch { return null; } };
const sum = rows => { const value = rows.reduce((total, next) => total + next, 0); return Number.isFinite(value) ? value : null; };
const fresh = (value, now) => value && value.stale !== true && timestamp(value.at) && value.at <= now + 5000 && now - value.at <= SOURCE_MAX_AGE;
const cachedWithin = (value, now, maxAge) => value && timestamp(value.at) && timestamp(value.sourceAt) && value.at <= now + 5000 && value.sourceAt <= now + 5000 && now - value.at <= maxAge && now - value.sourceAt <= maxAge;
const nativeWithin = (value, now, maxAge) => value && timestamp(value.curveAt) && value.curveAt <= now + 5000 && now - value.curveAt <= maxAge && amount(value.observedVolumeQuote) !== null;
const collectParts = (target, parts) => {
  let conflict = false;
  for (const part of parts || []) {
    const old = target.get(part.key);
    if (old && [old.base, old.quote].sort().join(':') !== [part.base, part.quote].sort().join(':')) { conflict = true; continue; }
    if (!old || part.at > old.at) target.set(part.key, part);
  }
  return conflict;
};

// Include hidden/archived launches and banned owners, but never a paid setup
// request which did not create its token. No signing material enters this DTO.
export function adminVolumeRecord(launch, now) {
  if (!isCurrentLaunch(launch?.input) || !timestamp(launch.authorizedAt) || launch.state === 'draft') return null;
  const mint = address(launch.keys?.mint?.address), quoteMint = address(launch.input.quoteMint), wallet = address(launch.keys?.wallet?.address);
  if (!mint || !quoteMint || !wallet || mint === quoteMint) return null;
  const creation = (Array.isArray(launch.operations) ? launch.operations : []).find(op => ['create', 'launch-all'].includes(op?.kind) && op.state === 'confirmed' && Number.isSafeInteger(op.slot) && op.slot > 0 && typeof op.signature === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(op.signature));
  if (!creation && !address(launch.curve)) return null;
  const createdAt = creation?.confirmedAt || creation?.createdAt || launch.createdAt;
  if (!timestamp(createdAt) || createdAt > now + 5000) return null;
  const curve = ray.getPdaLaunchpadPoolId(ray.LAUNCHPAD_PROGRAM, new PublicKey(mint), new PublicKey(quoteMint)).publicKey.toBase58();
  if (launch.curve && launch.curve !== curve) return null;
  const review = {};
  for (const key of ['configId', 'cpConfigId', 'supply', 'sell', 'raise', 'virtualBase', 'virtualQuote', 'quoteDecimals', 'quoteProgram']) review[key] = launch.review?.[key];
  return {
    mint, curve, name: text(launch.input.name), symbol: text(launch.input.symbol, 24), createdAt,
    hidden: launch.moderation?.hidden === true, archived: launch.listArchive?.archived === true,
    quote: { mint: quoteMint, symbol: quoteLabel(quoteMint, launch.review?.quoteSymbol, launch.input.quoteSymbol) },
    chainRecord: { curve, input: { route: 'raydium', network: 'mainnet-beta', quoteMint }, review, keys: {
      mint: { address: mint }, wallet: { address: wallet },
      payer: { address: address(launch.keys?.payer?.address) || wallet }, platform: { address: address(launch.keys?.platform?.address) || wallet },
    } },
  };
}

// Reporting only: the shared market readers have no submission interface here.
// Provider results are 24-hour windows, never an inferred lifetime counter.
export class AdminVolume {
  // The account scan limit matches the registry ceiling (accounts.mjs MAX_REGISTRY_ACCOUNTS).
  constructor({ accounts, explore, activity = explore?.activity, marketData = explore?.marketData, marketSnapshot, now = Date.now, waitMs = 1500, maxAccounts = 10000, maxRecords = 100000, maxOperations = 1000000, maxRefresh = 6, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { accounts, explore, activity, marketData, marketSnapshot, now, maxAccounts, maxRecords, maxOperations, setTimer, clearTimer });
    this.waitMs = Math.max(0, Math.min(2000, waitMs)); this.maxRefresh = Math.max(1, Math.min(6, maxRefresh));
    this.records = []; this.inventoryAt = null; this.inventoryComplete = false; this.inventoryPending = null;
    this.entries = new Map(); this.samples = new Map(); this.nativeSamples = new Map(); this.sources = new Map(); this.quoteReferences = new Map(); this.refreshPending = null; this.refreshAt = null; this.cursor = 0; this.closed = false;
    this.lastAdminPoll = null; this.lastPublicPoll = null; this.timer = null;
    this.dexRefreshPending = null; this.dexRefreshAt = null; this.dexCursor = 0; this.fullCheckedAt = new Map();
    this.quoteRefreshPending = null; this.quoteRefreshAt = null; this.quoteCursor = 0;
    this.launchFacts = []; this.rewardFacts = []; this.directBurnFacts = []; this.launchFactsComplete = false; this.inventoryAttemptAt = null;
  }
  async requireAdmin(id) {
    const actor = await this.accounts.get(id);
    if (actor?.role !== 'admin' || actor.banned || !actor.mfaEnabled) fail('Administrator access with two-factor authentication is required.', 403);
  }
  async inventory() {
    if (this.inventoryAt !== null && this.now() - this.inventoryAt < REFRESH_MS) return;
    if (this.inventoryPending) return this.inventoryPending;
    // A failed account-store read must not be amplified by public visitors.
    if (this.inventoryAttemptAt !== null && this.now() - this.inventoryAttemptAt < REFRESH_MS) fail('Launch volume inventory is temporarily unavailable.');
    this.inventoryAttemptAt = this.now();
    this.inventoryPending = (async () => {
      let users;
      try { users = await this.accounts.list(); } catch { fail('Launch volume inventory is temporarily unavailable.'); }
      if (!Array.isArray(users) || users.length > this.maxAccounts) fail('Launch volume exceeds the reporting scan limit.');
      const records = new Map(), facts = new Map(), rewardFacts = [], directBurnFacts = []; let checked = 0, operationsChecked = 0, complete = true;
      for (let index = 0; index < users.length; index += 8) {
        const batch = await Promise.allSettled(users.slice(index, index + 8).map(user => this.accounts.storeFor(user.id).read('launchpad', { launches: [] })));
        for (const result of batch) {
          if (result.status !== 'fulfilled' || !Array.isArray(result.value?.launches)) { complete = false; continue; }
          for (const launch of result.value.launches) {
            if (++checked > this.maxRecords) fail('Launch volume exceeds the reporting scan limit.');
            if (!launch || typeof launch !== 'object' || Array.isArray(launch)) { complete = false; continue; }
            operationsChecked += Array.isArray(launch.operations) ? launch.operations.length : 0;
            if (operationsChecked > this.maxOperations) fail('Launch volume exceeds the reporting history limit.');
            const record = adminVolumeRecord(launch, this.now());
            if (!record && ['live', 'paused', 'launched'].includes(launch.state) && isCurrentLaunch(launch.input)) complete = false;
            if (record && !records.has(record.mint)) records.set(record.mint, record);
            if (record) { const reward = rewardAnalyticsRecord(launch, record); if (reward) rewardFacts.push(reward); }
            const directBurn = directBurnRecord(launch, this.now()); if (directBurn) directBurnFacts.push(directBurn);
            // The original launch payer is stable across creator-fee redirects.
            // Keep its identity internal: only distinct counts are public.
            if (record && Array.isArray(launch.operations) && launch.operations.some(op => ['create', 'launch-all'].includes(op?.kind) && op.state === 'confirmed' && Number.isSafeInteger(op.slot) && op.slot > 0 && typeof op.signature === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(op.signature))) {
              const fact = { mint: record.mint, createdAt: record.createdAt, developer: record.chainRecord.keys.payer.address, platform: 'raydium' };
              const old = facts.get(record.mint);
              if (old && (old.developer !== fact.developer || old.createdAt !== fact.createdAt)) complete = false;
              if (!old) facts.set(record.mint, fact);
            }
          }
        }
      }
      // Native Pump.fun rows name their creator account, not the funding wallet. A wallet account can
      // only fund from its own wallet; any other account is counted once by its account identity.
      const accountDevelopers = new Map(users.map(user => [user?.id, user?.authType === 'wallet' ? address(user.mainWallet) : null]));
      const developerOf = (platform, launch) => address(launch.creatorWallet) || (platform === 'pump-classic' ? address(launch.developerWallet) || accountDevelopers.get(launch.creatorId) || (typeof launch.creatorId === 'string' && /^[a-f0-9]{32}$/.test(launch.creatorId) ? 'account:' + launch.creatorId : null) : null);
      for(const [platform,service,project]of [['pumpswap',this.explore?.pumpPublic,pumpDiscoveryRecord],['meteora',this.explore?.meteora,meteoraDiscoveryRecord],['damm-pump',this.explore?.dammPump,dammPumpDiscoveryRecord],['pump-classic',this.explore?.pumpClassic,pumpClassicDiscoveryRecord]]) {
        if(!service)continue;
        try {
          const feed=await (service.analyticsList?service.analyticsList():service.publicList()), rows=Array.isArray(feed)?feed:feed?.launches;
          if(!Array.isArray(rows))throw Error('Invalid Pump analytics inventory.');
          for(const launch of rows){
            if(++checked>this.maxRecords)throw Error('Pump analytics inventory limit.');
            const publicRecord=project({...launch,hidden:false,archived:false,moderation:null},this.now());
            if(!publicRecord){complete=false;continue;}
            const {coin,chainRecord}=publicRecord;
            const record={mint:coin.mint,curve:coin.curve,name:coin.name,symbol:coin.symbol,createdAt:coin.createdAt,hidden:launch.hidden===true||launch.moderation?.hidden===true,archived:launch.archived===true,quote:coin.quote,chainRecord,platform};
            if(!records.has(record.mint))records.set(record.mint,record);
            const developer=developerOf(platform,launch);if(!developer){complete=false;continue;}
            const old=facts.get(record.mint),fact={mint:record.mint,createdAt:record.createdAt,developer,platform};
            if(old&&(old.developer!==developer||old.createdAt!==fact.createdAt))complete=false;
            if(!old)facts.set(record.mint,fact);
          }
        }catch{complete=false;}
      }
      if(this.explore?.meteora){try{const rows=await this.explore.meteora.analyticsRewardRecords();if(!Array.isArray(rows))throw Error('Invalid Meteora reward history.');rewardFacts.push(...rows);}catch{complete=false;}}
      if (this.closed) return;
      this.records = [...records.values()].sort((a, b) => a.mint.localeCompare(b.mint));
      this.launchFacts = [...facts.values()];
      this.launchFactsComplete = complete && records.size === facts.size;
      this.rewardFacts = rewardFacts;
      this.directBurnFacts = directBurnFacts;
      this.inventoryComplete = complete; this.inventoryAt = this.now();
      for (const mint of this.entries.keys()) if (!records.has(mint)) this.entries.delete(mint);
      for (const mint of this.samples.keys()) if (!records.has(mint)) this.samples.delete(mint);
      for (const mint of this.nativeSamples.keys()) if (!records.has(mint)) this.nativeSamples.delete(mint);
      for (const mint of this.sources.keys()) if (!records.has(mint)) this.sources.delete(mint);
      for (const mint of this.fullCheckedAt.keys()) if (!records.has(mint)) this.fullCheckedAt.delete(mint);
      const quoteMints = new Set(this.records.map(record => record.quote.mint));
      for (const mint of this.quoteReferences.keys()) if (!quoteMints.has(mint)) this.quoteReferences.delete(mint);
    })().finally(() => { this.inventoryPending = null; });
    return this.inventoryPending;
  }
  async snapshotFor(record) {
    const cached = this.explore?.entries?.get(record.mint)?.native;
    if (fresh(cached, this.now())) return cached;
    if(record.platform==='damm-pump')return this.explore?.dammPump?.marketSnapshot(record.mint);
    if(record.platform==='pumpswap')return this.explore?.pumpPublic?.marketSnapshot(record.mint);
    if(record.platform==='meteora')return this.explore?.meteora?.marketSnapshot(record.mint);
    if(record.platform==='pump-classic')return this.explore?.pumpClassic?.marketSnapshot(record.mint);
    if (this.marketSnapshot) return this.marketSnapshot(record.chainRecord);
    const chain = await this.explore?.chain?.();
    return chain?.marketSnapshot ? chain.marketSnapshot(record.chainRecord) : null;
  }
  async observe(record) {
    const responses = await Promise.allSettled([
      Promise.resolve().then(async () => {
        if(record.platform==='damm-pump')return this.dammActivity(record);
        if(NATIVE_ACTIVITY.includes(record.platform))return this.explore.nativeActivity({coin:{mint:record.mint,curve:record.curve,platform:record.platform}});
        const value = await this.activity?.read(record.curve);
        if (fresh(value, this.now())) return value;
        // Activity.read returns the old window immediately while refreshing.
        // Reuse that shared work; calling read again at the next 30s boundary
        // would otherwise keep accepting only its stale predecessor forever.
        const pending = this.activity?.pending?.get(record.curve);
        if (pending) return pending.started !== false ? boundedRefresh(pending, () => value, 10_000) : value;
        const completed = this.activity?.cache?.get(record.curve)?.value;
        return completed && completed.at > (value?.at || 0) ? completed : value;
      }),
      Promise.resolve().then(() => this.marketData?.pools('solana', record.mint)),
      Promise.resolve().then(() => this.snapshotFor(record)),
    ]);
    const [activityResponse, dexRaw, snapshotRaw] = responses.map(result => result.status === 'fulfilled' ? result.value : null);
    // Only the aggregate is needed for revaluation, not up to 500 trade rows.
    const activityRaw = activityResponse ? { poolId: activityResponse.poolId, at: activityResponse.at, stale: activityResponse.stale,
      windows: { h24: activityResponse.windows?.h24 ? { ...activityResponse.windows.h24 } : null },
      ...(Array.isArray(activityResponse.pools)?{pools:activityResponse.pools}: {}) } : null;
    if (this.closed) return;
    const currentDex=this.sources.get(record.mint)?.dexRaw;
    const source={activityRaw,dexRaw:currentDex?.at>dexRaw?.at||currentDex&&!dexRaw?currentDex:dexRaw,snapshotRaw};
    this.sources.set(record.mint, source);
    this.project(record, source);
  }
  async dammActivity(record) {
    const result=await this.explore?.dammPump?.analyticsTrades?.(record.mint);
    if(result?.source!=='damm-pump-onchain'||result.mint!==record.mint||result.poolId!==record.curve||!Array.isArray(result.trades)||result.trades.length>200000)return null;
    const now=this.now(),cutoff=Math.floor((now-86400000)/1000),pools=new Map(),seen=new Set(),destination=address(record.chainRecord?.review?.poolId);
    let valid=true;
    // The local collector includes both venues. Keep their pool identities:
    // assigning all swaps to the original pool would duplicate PumpSwap DEX volume.
    for(const row of result.trades){
      if(!Number.isSafeInteger(row.time)||row.time<cutoff||row.time>Math.floor(now/1000))continue;
      if(!address(row.poolId)||!['damm','pumpswap'].includes(row.venue)||row.poolId!==(row.venue==='damm'?record.curve:destination)||!['buy','sell'].includes(row.side)||!positive(row.quote)||typeof row.eventId!=='string'||!/^[a-f0-9]{64}$/.test(row.eventId)){valid=false;continue;}
      if(seen.has(row.eventId))continue;seen.add(row.eventId);
      pools.set(row.poolId,(pools.get(row.poolId)||0)+row.quote);
    }
    const complete=result.recentComplete===true&&valid;
    if(!pools.has(record.curve)&&complete)pools.set(record.curve,0);
    if(destination&&!pools.has(destination)&&complete)pools.set(destination,0);
    return {poolId:record.curve,at:result.at,stale:false,windows:{h24:{quote:sum([...pools.values()]),complete}},
      pools:[...pools].map(([poolId,quote])=>({poolId,quote,complete}))};
  }
  project(record, { activityRaw, dexRaw, snapshotRaw }, prices) {
    const now = this.now();
    const activity = fresh(activityRaw, now) && activityRaw.poolId === record.curve && amount(activityRaw.windows?.h24?.quote) !== null && typeof activityRaw.windows.h24.complete === 'boolean' ? activityRaw : null;
    const snapshot = fresh(snapshotRaw, now) && snapshotRaw.mint === record.mint && snapshotRaw.curve === record.curve && snapshotRaw.quote?.mint === record.quote.mint && ['curve', 'migrating', 'migrated'].includes(snapshotRaw.status) && Number.isSafeInteger(snapshotRaw.slot) && snapshotRaw.slot > 0 ? snapshotRaw : null;
    const sharedReference = (prices || this.quotePrices()).get(record.quote.mint);
    const snapshotReference = snapshot && fresh(snapshot.quote, now) && positive(Number(snapshot.quote.usd)) ? snapshot.quote : null;
    const quoteReference = sharedReference && (!snapshotReference || sharedReference.at > snapshotReference.at) ? sharedReference : snapshotReference;
    const quoteUsd = quoteReference && fresh(quoteReference, now) ? positive(Number(quoteReference.usd)) : null;
    const dex = fresh(dexRaw, now) && dexRaw.chain === 'solana' && dexRaw.tokenAddress === record.mint && Array.isArray(dexRaw.pools) ? dexRaw : null;
    const pools = new Map(); let invalidPool = false;
    for (const pool of dex?.pools || []) {
      const base = address(pool?.base?.address), quote = address(pool?.quote?.address), key = address(pool?.address);
      if (!key || pool.token !== record.mint || !base || !quote || base === quote || ![base, quote].includes(record.mint)) { invalidPool = true; continue; }
      const old = pools.get(key), usd = amount(pool.volume24h);
      if (old && ([old.base, old.quote].sort().join(':') !== [base, quote].sort().join(':') || old.usd !== usd)) invalidPool = true;
      if (!old) pools.set(key, { key, base, quote, usd, complete: usd !== null, at: dex.at, source: 'DEX Screener' });
    }
    const curveQuote = activity?.windows.h24.quote ?? null;
    const curveUsd = curveQuote === 0 ? 0 : curveQuote !== null && quoteUsd !== null ? amount(curveQuote * quoteUsd) : null;
    const indexedCurve = pools.get(record.curve);
    // The LaunchLab pool may also be indexed by DEX Screener. Use its complete
    // USD report as a fallback, never add both reports for the same market.
    if (record.platform==='damm-pump'&&activity&&Array.isArray(activity.pools)) {
      for(const part of activity.pools){
        if(!address(part.poolId)||amount(part.quote)===null)continue;
        // Indexed market USD is the same source displayed on trading terminals.
        // Onchain quote totals fill only missing exact pools, never add to them.
        if(pools.get(part.poolId)?.complete)continue;
        const usd=part.quote===0?0:quoteUsd===null?null:amount(part.quote*quoteUsd);
        pools.set(part.poolId,{key:part.poolId,base:record.mint,quote:record.quote.mint,usd,complete:part.complete===true,at:activity.at,source:'PumpSwap onchain history'});
      }
    } else if (activity && (!indexedCurve?.complete || activity.windows.h24.complete && curveUsd !== null)) {
      pools.set(record.curve, { key: record.curve, base: record.mint, quote: record.quote.mint, usd: curveUsd, complete: activity.windows.h24.complete, at: activity.at, source: NATIVE_SOURCES[record.platform] || 'Raydium trade history' });
    }
    const parts = [...pools.values()];
    const curveCovered = pools.get(record.curve)?.complete === true;
    const ammCovered = dex !== null && !invalidPool && dex.pools.length < 20 && (snapshot?.status === 'curve' || parts.some(part => part.key !== record.curve));
    const complete = curveCovered && ammCovered && parts.every(part => part.complete);
    const numericParts = parts.filter(part => part.usd !== null);
    const observedVolumeUsd = numericParts.length ? sum(numericParts.map(part => part.usd)) : null;
    const usdComplete = complete && parts.every(part => part.usd !== null) && observedVolumeUsd !== null;
    // Freshness includes the responses that establish coverage and conversion,
    // even when an empty DEX list contributes no numeric pool to the total.
    const sourceTimes = parts.map(part => part.at);
    if (dex) sourceTimes.push(dex.at);
    if (snapshot) sourceTimes.push(snapshot.at);
    if (quoteUsd!==null && parts.some(part => ['Raydium trade history','PumpSwap onchain history',...Object.values(NATIVE_SOURCES)].includes(part.source) && part.usd !== null && curveQuote > 0)) sourceTimes.push(quoteReference.at);
    const value = { parts, at: now, complete, usdComplete, observedVolumeUsd, volume24hUsd: usdComplete ? observedVolumeUsd : null,
      quoteUsd, quoteUsdAt: quoteUsd === null ? null : quoteReference.at,
      volume24hQuote: activity?.windows.h24.complete ? curveQuote : null, observedVolumeQuote: curveQuote,
      curveComplete: activity?.windows.h24.complete === true, curveAt: activity?.at || null,
      source: [...new Set(parts.map(part => part.source))].join(' + ') || null,
      status: usdComplete ? 'available' : complete ? 'unpriced' : parts.length ? 'partial' : 'unavailable',
      sourceAt: parts.length ? Math.min(...sourceTimes) : null,
      newestAt: parts.length ? Math.max(...sourceTimes) : null,
    };
    if (!this.closed) {
      this.entries.set(record.mint, value);
      if (usdComplete) this.samples.set(record.mint, value);
      if (activity) {
        const previous = this.nativeSamples.get(record.mint);
        if (!previous || activity.at >= previous.curveAt) this.nativeSamples.set(record.mint, {
          curveAt: activity.at, curveComplete: activity.windows.h24.complete,
          volume24hQuote: activity.windows.h24.complete ? curveQuote : null, observedVolumeQuote: curveQuote,
        });
      }
    }
  }
  revalue() {
    const prices = this.quotePrices();
    for (const record of this.records) {
      const source = this.sources.get(record.mint), entry = this.entries.get(record.mint), price = prices.get(record.quote.mint);
      if (source && (!entry || !cachedWithin(entry,this.now(),SOURCE_MAX_AGE) || price && (price.at > (entry.quoteUsdAt || 0) || price.usd !== entry.quoteUsd))) this.project(record, source, prices);
    }
  }
  interestAt() { return this.lastAdminPoll === null ? this.lastPublicPoll : this.lastPublicPoll === null ? this.lastAdminPoll : Math.max(this.lastAdminPoll, this.lastPublicPoll); }
  active() { const at = this.interestAt(); return !this.closed && at !== null && this.now() - at < SOURCE_MAX_AGE; }
  stopTimer() { if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; } }
  schedule() {
    this.stopTimer();
    if (!this.active() || !this.records.length) return;
    const remaining = this.interestAt() + SOURCE_MAX_AGE - this.now();
    const fullNext = this.refreshPending ? REFRESH_MS : Math.max(1, REFRESH_MS - (this.now() - this.refreshAt));
    const dexNext = !this.marketData?.pools||this.dexRefreshPending ? REFRESH_MS : Math.max(1, DEX_REFRESH_MS - (this.now() - (this.dexRefreshAt??this.now())));
    const next=Math.min(fullNext,dexNext);
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.active()) return;
      this.refresh(); this.schedule();
    }, Math.min(remaining, next));
    this.timer?.unref?.();
  }
  refreshQuotePrices({ background = false } = {}) {
    const allowed = () => !this.closed && (background || this.active());
    if (!allowed() || this.quoteRefreshPending || !this.explore?.chain || this.quoteRefreshAt !== null && this.now() - this.quoteRefreshAt < REFRESH_MS) return this.quoteRefreshPending;
    this.quoteRefreshAt = this.now();
    const prices = this.quotePrices(), mints = [...new Set(this.records.map(record => record.quote.mint))].sort();
    const rotated = mints.slice(this.quoteCursor).concat(mints.slice(0, this.quoteCursor));
    const needed = rotated.filter(mint => !prices.has(mint) || this.now() - prices.get(mint).at >= 60_000).slice(0, this.maxRefresh);
    this.quoteCursor = mints.length ? (this.quoteCursor + this.maxRefresh) % mints.length : 0;
    if (!needed.length) return null;
    // Warm exact quote assets independently from per-coin RPC snapshots. The
    // explorer shares pending requests, caches and the provider's rate gates.
    // This bounded host job never scales with the number of public visitors.
    let index = 0;
    this.quoteRefreshPending = Promise.resolve().then(() => this.explore.chain()).then(chain => {
      if (!chain?.referencePrice || !chain?.mintInfo) return;
      return Promise.allSettled(Array.from({ length: Math.min(2, needed.length) }, async () => {
        while (allowed() && index < needed.length) {
          const mint = needed[index++];
          try {
            const info = await chain.mintInfo(mint);
            if (allowed()) {
              const value = await chain.referencePrice({ quoteMint: mint }, info);
              if (!this.closed && fresh(value, this.now()) && (!value.mint || value.mint === mint) && positive(Number(value.usd))) {
                this.quoteReferences.set(mint, { ...value, mint });
                this.revalue();
              }
            }
          } catch {}
        }
      }));
    }).catch(() => {}).finally(() => { this.quoteRefreshPending = null; });
    return this.quoteRefreshPending;
  }
  refresh() {
    this.refreshQuotePrices();
    this.refreshDex();
    if (!this.active() || this.refreshPending || this.refreshAt !== null && this.now() - this.refreshAt < REFRESH_MS || !this.records.length) return this.refreshPending;
    this.refreshAt = this.now();
    const rotated = this.records.slice(this.cursor).concat(this.records.slice(0, this.cursor));
    const candidates = rotated.filter(record => !this.fullCheckedAt.has(record.mint) || this.now() - this.fullCheckedAt.get(record.mint) >= REFRESH_MS).slice(0, this.maxRefresh);
    this.cursor = (this.cursor + this.maxRefresh) % this.records.length;
    let index = 0;
    this.refreshPending = Promise.allSettled(Array.from({ length: Math.min(3, candidates.length) }, async () => {
      while (this.active() && index < candidates.length) {
        const record = candidates[index++];
        try { await this.observe(record); } catch { if (!this.closed) this.entries.delete(record.mint); }
        finally { if(!this.closed)this.fullCheckedAt.set(record.mint,this.now()); }
      }
    })).finally(() => { this.refreshPending = null; this.schedule(); });
    return this.refreshPending;
  }
  refreshDex() {
    if(!this.active()||!this.marketData?.pools||this.dexRefreshPending||!this.records.length)return this.dexRefreshPending;
    // Let the first normal batch populate shared source/cache entries first.
    if(this.dexRefreshAt===null){this.dexRefreshAt=this.now();return null;}
    if(this.now()-this.dexRefreshAt<DEX_REFRESH_MS)return null;
    this.dexRefreshAt=this.now();
    const rotated=this.records.slice(this.dexCursor).concat(this.records.slice(0,this.dexCursor));
    const selected=rotated.filter(record=>{const dex=this.sources.get(record.mint)?.dexRaw;return !fresh(dex,this.now())||this.now()-dex.at>=60000;}).slice(0,this.maxRefresh);
    this.dexCursor=(this.dexCursor+this.maxRefresh)%this.records.length;
    let index=0;
    // Provider owns the shared cache, in-flight coalescing and hard 240/min
    // public DEX budget. This lane adds no RPC/transaction-history requests.
    this.dexRefreshPending=Promise.allSettled(Array.from({length:Math.min(3,selected.length)},async()=>{
      while(this.active()&&index<selected.length){
        const record=selected[index++];
        try{
          const dexRaw=await this.marketData.pools('solana',record.mint);
          if(this.closed||!this.records.some(row=>row.mint===record.mint))continue;
          const prior=this.sources.get(record.mint)||{};
          if(prior.dexRaw?.at>dexRaw?.at)continue;
          const source={...prior,dexRaw};this.sources.set(record.mint,source);this.project(record,source);
        }catch{}
      }
    })).finally(()=>{this.dexRefreshPending=null;this.schedule();});
    return this.dexRefreshPending;
  }
  report() {
    this.revalue();
    const now = this.now(), allParts = new Map(), sampledParts = new Map(), quoteGroups = new Map(); let conflict = false, sampleConflict = false;
    const sampling = { oldestAt: null, newestAt: null, cachedCoins: 0, maxAgeMs: SAMPLE_MAX_AGE };
    const coverage = { launches: this.records.length, complete: 0, usdComplete: 0, partial: 0, unavailable: 0, unpriced: 0, inventoryComplete: this.inventoryComplete };
    const coins = this.records.map(record => {
      const cached = this.entries.get(record.mint), value = cachedWithin(cached, now, SOURCE_MAX_AGE) ? cached : null;
      const saved = this.samples.get(record.mint), sample = cachedWithin(saved, now, SAMPLE_MAX_AGE) ? saved : null;
      const savedNative = this.nativeSamples.get(record.mint);
      const native = nativeWithin(savedNative, now, SOURCE_MAX_AGE) ? savedNative : null;
      const nativeSample = nativeWithin(savedNative, now, SAMPLE_MAX_AGE) ? savedNative : null;
      if (savedNative && !nativeSample) this.nativeSamples.delete(record.mint);
      if (saved && !sample) this.samples.delete(record.mint);
      if (sample) {
        sampling.cachedCoins++;
        sampling.oldestAt = sampling.oldestAt === null ? sample.sourceAt : Math.min(sampling.oldestAt, sample.sourceAt);
        sampling.newestAt = sampling.newestAt === null ? sample.newestAt : Math.max(sampling.newestAt, sample.newestAt);
        sampleConflict = collectParts(sampledParts, sample.parts) || sampleConflict;
      }
      if (value?.complete) coverage.complete++;
      if (value?.usdComplete) coverage.usdComplete++;
      if (!value || value.status === 'unavailable') coverage.unavailable++;
      else if (value.status === 'partial') coverage.partial++;
      else if (value.status === 'unpriced') coverage.unpriced++;
      conflict = collectParts(allParts, value?.parts) || conflict;
      const group = quoteGroups.get(record.quote.mint) || { ...record.quote, coins: 0, complete: 0, amounts: [], sampledAmounts: [], sampledComplete: 0, sampledCoins: 0, sampledAt: null };
      group.coins++; if (native?.curveComplete) group.complete++;
      if (native) group.amounts.push(native.observedVolumeQuote);
      if (nativeSample) {
        group.sampledAmounts.push(nativeSample.observedVolumeQuote); group.sampledCoins++;
        if (nativeSample.curveComplete) group.sampledComplete++;
        group.sampledAt = group.sampledAt === null ? nativeSample.curveAt : Math.min(group.sampledAt, nativeSample.curveAt);
      }
      quoteGroups.set(group.mint, group);
      return { mint: record.mint, name: record.name, symbol: record.symbol, quote: record.quote, hidden: record.hidden, archived: record.archived,
        volume24hUsd: value?.volume24hUsd ?? null, observedVolumeUsd: value?.observedVolumeUsd ?? null,
        volume24hQuote: native?.volume24hQuote ?? null, observedVolumeQuote: native?.observedVolumeQuote ?? null,
        sampledVolume24hQuote: nativeSample?.volume24hQuote ?? null, sampledObservedVolumeQuote: nativeSample?.observedVolumeQuote ?? null, sampledQuoteAt: nativeSample?.curveAt ?? null,
        sampledVolume24hUsd: sample?.volume24hUsd ?? null, sampledAt: sample?.sourceAt ?? null, sampledSource: sample?.source || null,
        complete: value?.complete === true, status: value?.status || 'unavailable', source: value?.source || null, at: value?.sourceAt || null };
    });
    const parts = [...allParts.values()], numeric = parts.filter(part => part.usd !== null);
    const observedVolumeUsd = numeric.length ? sum(numeric.map(part => part.usd)) : this.inventoryComplete && !coins.length ? 0 : null;
    const complete = this.inventoryComplete && !conflict && coverage.usdComplete === coins.length && observedVolumeUsd !== null;
    const sampledObservedVolumeUsd = sampledParts.size ? sum([...sampledParts.values()].map(part => part.usd)) : this.inventoryComplete && !coins.length ? 0 : null;
    const sampledComplete = this.inventoryComplete && !sampleConflict && sampling.cachedCoins === coins.length && sampledObservedVolumeUsd !== null;
    return { at: now, refreshMs: REFRESH_MS, scope: 'Launchpad launches on this host', period: '24h',
      volumeUsd: complete ? observedVolumeUsd : null, observedVolumeUsd, lifetimeVolumeUsd: null,
      sampledVolumeUsd: sampledComplete ? sampledObservedVolumeUsd : null, sampledObservedVolumeUsd, sampling,
      lifetimeStatus: this.lifetime ? 'recorded' : 'unavailable', lifetime: this.lifetime?.readPublic?.({ pricesByMint: this.quotePrices() }) ?? null,
      complete, refreshing: !!this.refreshPending || !!this.quoteRefreshPending || !!this.dexRefreshPending, coverage, coins,
      quoteTotals: [...quoteGroups.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)).map(({ amounts, sampledAmounts, ...group }) => {
        const observedVolumeQuote = amounts.length ? sum(amounts) : null;
        const sampledObservedVolumeQuote = sampledAmounts.length ? sum(sampledAmounts) : null;
        return { ...group, volume24hQuote: group.complete === group.coins ? observedVolumeQuote : null, observedVolumeQuote,
          sampledVolume24hQuote: group.sampledComplete === group.coins ? sampledObservedVolumeQuote : null, sampledObservedVolumeQuote };
      }),
      note: 'Rolling 24-hour estimate across Launchpad launch curves and indexed trading pools, including hidden and archived coins. Shared pools count once in the total; coin rows can overlap. Sampled volume combines complete 24-hour windows observed at different times within the past 15 minutes; it is not one synchronized current window. Bonding-curve USD uses a fresh available quote-token price, while AMM USD comes from DEX Screener. Native quote totals cover bonding-curve trades independently of USD coverage; sampled quote totals identify their own observation times. Missing, delayed or capped history is excluded from complete totals. Lifetime volume uses the separate deduplicated trade ledger; successive 24-hour windows are never added together.',
    };
  }
  async read(id) {
    await this.requireAdmin(id);
    if (this.closed) fail('Launch volume is restarting.');
    this.lastAdminPoll = this.now();
    await this.inventory();
    if (this.closed) fail('Launch volume is restarting.');
    const work = this.refresh();
    if ((work || this.quoteRefreshPending) && this.waitMs) await boundedRefresh(Promise.allSettled([work, this.quoteRefreshPending]), () => null, this.waitMs);
    try { await this.requireAdmin(id); } catch (error) { this.lastAdminPoll = null; this.schedule(); throw error; }
    if (this.closed) fail('Launch volume is restarting.');
    this.schedule();
    return structuredClone(this.report());
  }
  // Reuse existing bounded market work. Reading burn analytics never starts
  // another provider request or exposes a launch record/private wallet.
  tokenPrice(mint) {
    if (!address(mint)) return null;
    const now = this.now(), reference = this.quotePrices().get(mint);
    const quoted = freshBurnPrice(reference && { ...reference, mint, source: 'Current quote reference' }, mint, now);
    if (quoted) return quoted;
    const record = this.records.find(row => row.mint === mint), source = this.sources.get(mint), entry = this.explore?.entries?.get(mint);
    const pools = [];
    const addPool = (pool, at, stale) => {
      if (!pool || !address(pool.address) || pool.token !== mint || !address(pool.base?.address) || !address(pool.quote?.address) || pool.base.address === pool.quote.address || ![pool.base.address, pool.quote.address].includes(mint) || pool.isBase !== (pool.base.address === mint)) return;
      const value = freshBurnPrice({ mint, usd: pool.priceUsd, at, stale: stale === true || pool.stale === true, source: 'DEX Screener' }, mint, now);
      if (value) pools.push({ value, liquidity: amount(pool.liquidityUsd) || 0 });
    };
    if (source?.dexRaw?.chain === 'solana' && source.dexRaw.tokenAddress === mint && Array.isArray(source.dexRaw.pools)) {
      for (const pool of source.dexRaw.pools.slice(0, 20)) addPool(pool, source.dexRaw.at, source.dexRaw.stale);
    }
    if (entry?.pool?.chain === 'solana') addPool(entry.pool, entry.dexAt, entry.dexStale);
    pools.sort((a, b) => b.liquidity - a.liquidity || b.value.at - a.value.at);
    if (pools.length) return pools[0].value;
    for (const native of [source?.snapshotRaw, entry?.native]) {
      if (!record || !native || native.mint !== mint || native.curve !== record.curve || native.quote?.mint !== record.quote.mint || native.status !== 'curve' || native.stale === true || !fresh(native.quote, now) || !positive(Number(native.quote.usd))) continue;
      const value = freshBurnPrice({ mint, usd: native.priceUsd, at: Math.min(native.at, native.quote.at), source: 'Current launch curve' }, mint, now);
      if (value) return value;
    }
    return null;
  }
  quotePrices() {
    const result = new Map(), now = this.now();
    const add = (mint, value) => {
      if (!value || value.mint && value.mint !== mint || !fresh(value, now) || !['number', 'string'].includes(typeof value.usd) || !positive(Number(value.usd))) return;
      const old = result.get(mint);
      if (!old || old.at < value.at) result.set(mint, { usd: Number(value.usd), at: value.at, stale: false });
    };
    for (const record of this.records) {
      const mint = record.quote.mint, value = this.entries.get(record.mint);
      add(mint, { usd: value?.quoteUsd, at: value?.quoteUsdAt });
      add(mint, this.quoteReferences.get(mint));
      // A quote reference is shared across every pool using that exact mint.
      // Its completion does not depend on the next full market/RPC refresh.
      add(mint, this.explore?.quoteReferences?.get(mint));
      const native = this.explore?.entries?.get(record.mint)?.native;
      if (native?.mint === record.mint && native?.curve === record.curve && native.quote?.mint === mint) add(mint, native.quote);
    }
    return result;
  }
  // Explicit public projection. Never return report().coins/quoteTotals or the
  // internal facts, which can identify hidden launches and their creators.
  async readPublic() {
    if (this.closed) fail('Public analytics is restarting.');
    this.lastPublicPoll = this.now();
    // A failed inventory refresh keeps the last verified inventory instead of
    // blanking every public count and volume; its counts become subtotals.
    let inventoryCurrent = true;
    try { await this.inventory(); }
    catch (error) { if (this.closed || this.inventoryAt === null) throw error; inventoryCurrent = false; }
    if (this.closed) fail('Public analytics is restarting.');
    const work = this.refresh();
    if ((work || this.quoteRefreshPending) && this.waitMs) await boundedRefresh(Promise.allSettled([work, this.quoteRefreshPending]), () => null, this.waitMs);
    if (this.closed) fail('Public analytics is restarting.');
    this.schedule();
    const report = this.report(), now = this.now(), cutoff = now - 86400000;
    const recent = this.launchFacts.filter(row => row.createdAt >= cutoff && row.createdAt <= now);
    const complete = this.launchFactsComplete && inventoryCurrent;
    const launches = { total: complete ? this.launchFacts.length : null, last24h: complete ? recent.length : null,
      uniqueDevelopers: complete ? new Set(this.launchFacts.map(row => row.developer)).size : null,
      uniqueDevelopers24h: complete ? new Set(recent.map(row => row.developer)).size : null,
      observedTotal: this.launchFacts.length, observedLast24h: recent.length,
      observedUniqueDevelopers: new Set(this.launchFacts.map(row => row.developer)).size,
      observedUniqueDevelopers24h: new Set(recent.map(row => row.developer)).size, complete,
      developerDefinition: 'Distinct original launch wallets; fee-recipient changes do not create a new developer.' };
    const days = [], today = Math.floor(now / 86400000) * 86400000;
    const buckets = new Map(), VENUES = ['raydium', 'meteora', 'damm-pump', 'pump-classic'];
    for (const row of this.launchFacts) {
      if (row.createdAt > now) continue;
      const day = new Date(row.createdAt).toISOString().slice(0, 10), bucket = buckets.get(day) || { count: 0, venues: Object.fromEntries(VENUES.map(v => [v, 0])) };
      bucket.count++; if (VENUES.includes(row.platform)) bucket.venues[row.platform]++;
      buckets.set(day, bucket);
    }
    for (let i = 29; i >= 0; i--) {
      const date = new Date(today - i * 86400000).toISOString().slice(0, 10), bucket = buckets.get(date), observedCount = bucket?.count || 0;
      if (date < LAUNCHPAD_ANALYTICS_START_DAY) continue;
      // v71.26: launches per venue for the analytics chart (observed counts; null like `count` while the inventory is incomplete).
      const venues = bucket?.venues || Object.fromEntries(VENUES.map(v => [v, 0]));
      days.push({ date, count: complete ? observedCount : null, observedCount, venues: complete ? venues : null, observedVenues: venues });
    }
    const sourceTimes = report.coins.map(row => row.at).filter(timestamp);
    const inventoryComplete = this.inventoryComplete && inventoryCurrent;
    // With a retained inventory, observed amounts remain subtotals of known
    // coins; an empty retained inventory's implied $0 is not reported.
    const observed = value => inventoryCurrent || this.records.length ? value : null;
    return { launches, dailyLaunches: { timezone: 'UTC', complete, days }, directBurns: publicDirectBurnAnalytics(this.directBurnFacts, { inventoryComplete }), rewards: publicRewardAnalytics(this.rewardFacts, { pricesByMint: this.quotePrices(), now, inventoryComplete }), volume: {
      period: '24h', usd: inventoryCurrent ? report.volumeUsd : null, observedUsd: observed(report.observedVolumeUsd), complete: report.complete && inventoryCurrent,
      sampledUsd: inventoryCurrent ? report.sampledVolumeUsd : null, sampledObservedUsd: observed(report.sampledObservedVolumeUsd),
      sampling: report.sampling, coverage: { ...report.coverage, inventoryComplete }, lifetimeUsd: null, lifetimeStatus: 'unavailable',
      refreshing: report.refreshing, asOf: sourceTimes.length ? Math.min(...sourceTimes) : this.records.length ? null : this.inventoryAt,
      note: report.note,
    }, inventoryAt: this.inventoryAt };
  }
  close() { this.closed = true; this.stopTimer(); this.entries.clear(); this.samples.clear(); this.nativeSamples.clear(); this.sources.clear(); this.quoteReferences.clear(); this.fullCheckedAt.clear(); }
}
