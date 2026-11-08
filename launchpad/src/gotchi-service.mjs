import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { acquireProcessLock } from './process-lock.mjs';
import { SOL_MINT, displayUnits } from '../public/launchpad-model.mjs';
import { GOTCHI_THEMES, GOTCHI_GOAL_USD, GOTCHI_MILESTONES_USD, GOTCHI_TOP_HOLDERS, GOTCHI_WINNER_SPLIT_BPS, GOTCHI_SAMPLE_INTERVAL_MS, GOTCHI_MAX_SAMPLE_GAP_MS, GOTCHI_RULES, gotchiTheme, validGotchiId, evolutionStage, milestoneProgress, gotchiFundingSummary } from '../public/gotchi-catalog.mjs';
import { createRace, applySample, finalizeScores, rankHolders, selectWinner, splitPot, payoutPlan, transition, raceView, usdToUsd8, averageHoldingUsd } from './gotchi-race.mjs';
import { raydiumGotchiLaunch, raydiumGotchiSources } from './gotchi-launches.mjs';

export const GOTCHI_POLICY = Object.freeze({
  goalUsd: GOTCHI_GOAL_USD, milestonesUsd: GOTCHI_MILESTONES_USD, topHolders: GOTCHI_TOP_HOLDERS, splitBps: GOTCHI_WINNER_SPLIT_BPS,
  gasReserveLamports: '20000000', recipientReserveLamports: '3500000', maximumOperationCostLamports: '15000000', dailyNetworkLimitLamports: '100000000',
  minimumBuyLamports: '20000000', maximumBuyChunkLamports: '2000000000', slippageBps: 100, maxPriceImpactPercent: 2,
  sampleIntervalMs: GOTCHI_SAMPLE_INTERVAL_MS, maxSampleGapMs: GOTCHI_MAX_SAMPLE_GAP_MS, valuationFreshnessMs: 5 * 60 * 1000, closeGraceMs: 30 * 60 * 1000, closeRetryMs: 10 * 60 * 1000,
  airdropBatch: 4, maxSourcesPerTick: 8, maxSampleCoinsPerTick: 3, retryBaseMs: 15000, retryMaxMs: 3600000,
});
const REGISTRY = 'gotchi-registry', KEYS = 'gotchi-vault-keys', CONTROLS = 'gotchi-controls', BURN_ADDRESSES = Object.freeze(['1nc1nerator11111111111111111111111111111111', '11111111111111111111111111111111']);
const MAX = 2n ** 64n - 1n;
const fail = (message, statusCode = 400) => { throw Object.assign(Error(message), { statusCode }); };
const publicFailure = message => Object.assign(Error(message), { gotchiPublic: true });
const uint = value => { if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) fail('Invalid Gotchi amount.'); return BigInt(value); };
const base58 = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const validSignature = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(value);
const walletAddress = value => { let key; try { key = new PublicKey(value); } catch { fail('Invalid Gotchi wallet.'); } if (key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes())) fail('Invalid Gotchi wallet.'); return value; };
const add = (object, key, value) => { object[key] = (BigInt(object[key] || '0') + BigInt(value)).toString(); };
const subtract = (object, key, value) => { const next = BigInt(object[key] || '0') - BigInt(value); if (next < 0n) throw publicFailure('A Gotchi ledger entry would become negative.'); object[key] = next.toString(); };
const sourceId = source => createHash('sha256').update(JSON.stringify([source.signature, source.mint, source.wallet])).digest('hex');
const day = now => new Date(now).toISOString().slice(0, 10);
const retryAt = (record, now, message, { base = GOTCHI_POLICY.retryBaseMs, max = GOTCHI_POLICY.retryMaxMs } = {}) => { record.attempts = (record.attempts || 0) + 1; record.nextAttemptAt = now + Math.min(max, base * 2 ** Math.min(record.attempts - 1, 8)); record.error = message; record.at = now; return record; };
const routingErrors = Object.freeze({ SOL_ROUTE_AUTH: 'Jupiter could not authorize the Gotchi route. Check the configured Jupiter API key.', SOL_ROUTE_RATE_LIMITED: 'Jupiter is rate limiting Gotchi routing. The saved step will retry automatically.', SOL_ROUTE_NOT_FOUND: 'Jupiter has no route for this amount right now. The saved step will retry automatically.', SOL_ROUTE_NETWORK: 'The Gotchi service could not reach Jupiter. The saved step will retry automatically.', SOL_ROUTE_TIMEOUT: 'The Gotchi routing request timed out. The saved step will retry automatically.', SOL_ROUTE_PROVIDER_UNAVAILABLE: 'Jupiter is temporarily unavailable. The saved step will retry automatically.', TREASURY_PRICE_IMPACT: 'The route exceeds the 2% price-impact limit. A smaller purchase chunk will be tried.', TREASURY_SLIPPAGE_LIMIT: 'The route changed its slippage protection. The saved step will retry automatically.', TREASURY_INVALID_IMPACT: 'The route omitted its price impact. The saved step will retry automatically.' });
const safeError = error => error?.gotchiPublic === true ? String(error.message).slice(0, 220) : Object.hasOwn(routingErrors, error?.code) ? routingErrors[error.code] : 'The Gotchi service is waiting for a verified route, balance or transaction receipt. It will retry automatically.';
const opView = op => op ? Object.fromEntries(['kind', 'signature', 'state', 'createdAt', 'confirmedAt', 'inputAmount', 'tokenAmount', 'outputAmount', 'mint', 'error', 'stage'].filter(key => op[key] !== undefined).map(key => [key, op[key]])) : null;
const TOTAL_KEYS = Object.freeze(['receivedSol', 'convertedSol', 'realizedSol', 'spentOnWinnerSol', 'airdroppedSol', 'airdroppedTokens', 'networkSpent']);
const drain = (object, key, value) => { const have = BigInt(object[key] || '0'), paid = have < BigInt(value) ? have : BigInt(value); object[key] = (have - paid).toString(); return paid; };
const emptyControls = () => ({ version: 1, enabled: true, gotchis: {}, history: [] });
const defaultFlags = () => ({ collectionPaused: false, conversionPaused: false, settlementPaused: false, samplingPaused: false });
const emptyRaceDoc = index => ({ version: 1, index, coins: {}, scores: {}, gaps: [], sampleCount: 0 });
// A coin competes once graduated, while it is listed: hidden (moderated),
// archived and dead launches are neither sampled nor eligible to win.
const competing = coin => coin.graduated === true && !coin.archived && !coin.hidden && coin.live !== false;

function emptyState(theme, vault, now) {
  return { version: 1, id: theme.id, theme: theme.id, vault, createdAt: now, coins: {}, seen: {}, sourceRetry: {}, assets: {},
    totals: { receivedSol: '0', convertedSol: '0', realizedSol: '0', spentOnWinnerSol: '0', airdroppedSol: '0', airdroppedTokens: '0', networkSpent: '0', contributions: 0 },
    race: { ...createRace({ index: 1, startedAt: now }), coins: undefined, scores: undefined, gaps: undefined }, races: [], pending: null, history: [], retry: {}, gas: { day: '', used: '0', reserved: '0' }, milestones: [], valuation: null, celebration: null, error: '', updatedAt: now };
}
function mergedRace(state, doc) { return { ...state.race, coins: doc.coins, scores: doc.scores, gaps: doc.gaps, sampleCount: doc.sampleCount }; }
function storeRace(state, doc, race) { doc.coins = race.coins; doc.scores = race.scores; doc.gaps = race.gaps; doc.sampleCount = race.sampleCount; const { coins, scores, gaps, sampleCount, ...light } = race; state.race = { ...light, sampleCount }; }

/** Gotchi Mode: per-Gotchi vault accounting, race sampling and settlement.
 * Launch workers deliver contributions; this service only recognizes finalized
 * receipts, converts to SOL, scores holders and pays the frozen result. Every
 * signed transaction is journaled before broadcast and settled one at a time. */
export class GotchiService {
  constructor({ accounts, launchpad = null, meteora = null, discovery = null, chainFactory, requireOwner = null, now = Date.now, intervalMs = 20000, maxAccounts = 10000, maxRecords = 200000 } = {}) {
    Object.assign(this, { accounts, launchpad, meteora, discovery, chainFactory, requireOwner, now, intervalMs, maxAccounts, maxRecords });
    this.running = null; this.timer = null; this.closed = false; this.launchCache = null; this.ensured = null;
  }
  // ---- storage -------------------------------------------------------------
  // Without the encrypted host store (minimal test hosts) every Gotchi entry
  // point answers 503 instead of the application failing to start.
  store() { const store = this.accounts?.hostStore; if (!store || typeof this.accounts.dir !== 'string') fail('Gotchi Mode requires the encrypted host store.', 503); return store; }
  async locked(id, fn) { this.store(); let release; try { release = await acquireProcessLock(join(this.accounts.dir, `gotchi-${id}.lock`)); return await fn(); } finally { await release?.(); } }
  async ensure() {
    this.store();
    if (this.ensured) return this.ensured;
    this.ensured = (async () => {
      let registry = await this.accounts.hostStore.read(REGISTRY, null), keys = await this.accounts.hostStore.read(KEYS, null);
      if (registry !== null && (registry.version !== 1 || !registry.gotchis || typeof registry.gotchis !== 'object')) fail('The Gotchi registry could not be read. Restore its original encrypted data.', 503);
      if (keys !== null && (keys.version !== 1 || !keys.keys || typeof keys.keys !== 'object')) fail('The Gotchi vault keys could not be read. Restore their original encrypted data.', 503);
      registry ||= { version: 1, createdAt: this.now(), gotchis: {} }; keys ||= { version: 1, keys: {} };
      let changed = false;
      for (const theme of GOTCHI_THEMES) {
        let key = keys.keys[theme.id];
        if (!key) { const pair = Keypair.generate(); try { key = { address: pair.publicKey.toBase58(), secret: bs58.encode(pair.secretKey), createdAt: this.now() }; } finally { pair.secretKey.fill(0); } keys.keys[theme.id] = key; changed = true; }
        let bytes; try { bytes = bs58.decode(key.secret); if (bytes.length !== 64 || Keypair.fromSecretKey(bytes).publicKey.toBase58() !== key.address) throw Error(); } catch { fail('A Gotchi vault key does not match its address. Restore the original encrypted data.', 503); } finally { bytes?.fill(0); }
        if (!registry.gotchis[theme.id]) { registry.gotchis[theme.id] = { id: theme.id, theme: theme.id, vault: key.address, createdAt: this.now() }; changed = true; }
        else if (registry.gotchis[theme.id].vault !== key.address) fail('The Gotchi registry vault differs from its saved key. Restore the original encrypted data.', 503);
      }
      // Keys are written first: a registry without a key is recoverable, a key
      // without its registry row is rebuilt from the key on the next start.
      if (changed) { await this.accounts.hostStore.write(KEYS, keys); await this.accounts.hostStore.write(REGISTRY, registry); }
      return registry;
    })().catch(error => { this.ensured = null; throw error; });
    return this.ensured;
  }
  async vaultSigner(id) { const keys = await this.store().read(KEYS, null), key = keys?.keys?.[id]; if (!key) fail('The Gotchi vault key is unavailable.', 503); return { address: key.address, secret: key.secret }; }
  async load(id) {
    const registry = await this.ensure(), row = registry.gotchis[id]; if (!row) fail('Gotchi not found.', 404);
    const theme = gotchiTheme(id); if (!theme) fail('Gotchi not found.', 404);
    const state = await this.accounts.hostStore.read(`gotchi-${id}`, null);
    if (state === null) return emptyState(theme, row.vault, this.now());
    if (state.version !== 1 || state.id !== id || state.vault !== row.vault || !state.totals || !state.race || !state.coins || !state.seen || !state.assets) fail('The Gotchi ledger could not be read. Restore its original encrypted data.', 503);
    for (const key of TOTAL_KEYS) uint(state.totals[key] || '0');
    state.retry ||= {}; state.races ||= []; state.history ||= []; state.milestones ||= []; state.gas ||= { day: '', used: '0', reserved: '0' }; state.sourceRetry ||= {};
    return state;
  }
  async save(state) { state.updatedAt = this.now(); await this.accounts.hostStore.write(`gotchi-${state.id}`, state); }
  async loadRace(state) { const doc = await this.accounts.hostStore.read(`gotchi-${state.id}-race`, null); if (doc === null || doc.index !== state.race.index) return emptyRaceDoc(state.race.index); if (doc.version !== 1 || !doc.coins || !doc.scores) fail('The Gotchi race data could not be read. Restore its original encrypted data.', 503); return doc; }
  async saveRace(state, doc) { await this.accounts.hostStore.write(`gotchi-${state.id}-race`, doc); }
  async loadControls() { const controls = await this.store().read(CONTROLS, null); if (controls === null) return emptyControls(); if (controls.version !== 1 || typeof controls.enabled !== 'boolean' || !controls.gotchis) fail('The Gotchi controls could not be read.', 503); return controls; }
  flags(controls, id) { return { ...defaultFlags(), ...(controls.gotchis?.[id] || {}) }; }
  // ---- launch integration --------------------------------------------------
  /** Immutable launch pairing: id, theme and the vault address copied into the launch record. */
  async launchTarget(id) {
    if (!validGotchiId(id)) fail('Choose a Gotchi to pair your coin with.');
    const controls = await this.loadControls(); if (!controls.enabled) fail('Gotchi launches are paused by the platform owner.', 409);
    const registry = await this.ensure(), row = registry.gotchis[id]; if (!row) fail('Gotchi not found.', 404);
    return { id: row.id, theme: row.theme, vault: row.vault };
  }
  async vaultAddresses() { const registry = await this.ensure(); return new Set(Object.values(registry.gotchis).map(row => row.vault)); }
  async launchRows() {
    if (this.launchCache && this.now() - this.launchCache.at < 60000) return this.launchCache;
    const raydium = [], sources = [];
    if (this.launchpad?.book || this.accounts.storeFor) {
      const accounts = await this.accounts.list(); if (accounts.length > this.maxAccounts) throw publicFailure('Gotchi launch discovery exceeds its account scan limit.');
      let count = 0;
      for (const account of accounts) {
        let book; try { book = this.launchpad?.book ? await this.launchpad.book(account.id) : await this.accounts.storeFor(account.id).read('launchpad', { launches: [] }); } catch { continue; }
        for (const launch of book?.launches || []) { count += 1 + (launch.operations?.length || 0); if (count > this.maxRecords) throw publicFailure('Gotchi launch discovery exceeds its record scan limit.'); const row = raydiumGotchiLaunch(launch, { accountId: account.id }); if (row) { row.banned = account.banned === true; raydium.push(row); sources.push(...raydiumGotchiSources(launch)); } }
      }
    }
    let meteora = [], pump = [];
    if (typeof this.meteora?.gotchiLaunches === 'function') { try { meteora = await this.meteora.gotchiLaunches(); sources.push(...await this.meteora.gotchiSources()); } catch { /* A Meteora read failure delays discovery; it never removes known coins. */ } }
    // Pump.fun coins: Launchpad sweeps each coin's Gotchi share from its per-coin relay wallet to the vault.
    if (typeof this.pumpClassic?.gotchiLaunches === 'function') { try { pump = await this.pumpClassic.gotchiLaunches(); sources.push(...await this.pumpClassic.gotchiSources()); } catch { /* Delays discovery only. */ } }
    this.launchCache = { at: this.now(), launches: [...raydium, ...meteora, ...pump], sources };
    return this.launchCache;
  }
  async marketRows(mints, { wait = 1200 } = {}) {
    const result = new Map();
    if (!this.discovery || !mints.length) return result;
    try {
      const inventory = await this.discovery.inventory(), records = mints.map(mint => inventory.get(mint)).filter(Boolean);
      if (typeof this.discovery.warm === 'function') await this.discovery.warm(records, { wait, max: 12 });
      for (const record of records) { try { result.set(record.coin.mint, this.discovery.coin(record)); } catch { /* A single stale projection never blocks the others. */ } }
    } catch { /* Market data is optional for views; settlement requires it explicitly. */ }
    return result;
  }
  freshMarket(coin) {
    if (!coin || coin.stale === true) return null;
    const at = Number(coin.marketAt); if (!Number.isSafeInteger(at) || at <= 0 || at > this.now() + 5000 || this.now() - at > GOTCHI_POLICY.valuationFreshnessMs) return null;
    const cap = Number(coin.marketCapUsd ?? coin.fdvUsd), price = Number(coin.priceUsd);
    return { marketCapUsd: Number.isFinite(cap) && cap > 0 ? cap : null, priceUsd: Number.isFinite(price) && price > 0 ? price : null, at, source: coin.marketSource || null, graduated: coin.stage === 'graduated' };
  }
  async syncCoins(state) {
    const { launches } = await this.launchRows(), now = this.now();
    const markets = await this.marketRows(launches.filter(row => row.gotchi.id === state.id).map(row => row.mint), { wait: 0 });
    for (const row of launches) {
      if (row.gotchi.id !== state.id || row.gotchi.vault !== state.vault) continue;
      const saved = state.coins[row.mint] ||= { mint: row.mint, venue: row.venue, attachedAt: row.gotchi.attachedAt || now, firstSeenAt: now, graduated: false, graduatedAt: null };
      Object.assign(saved, { name: row.name, symbol: row.symbol, image: row.image, status: row.status, live: row.live !== false && !row.banned, quoteMint: row.quoteMint, quoteDecimals: row.quoteDecimals, quoteSymbol: row.quoteSymbol, baseDecimals: row.baseDecimals ?? 6, custody: row.custody, hidden: row.hidden, archived: row.archived, contributedRaw: row.contributedRaw, pendingRaw: row.pendingRaw, unconvertedBaseRaw: row.unconvertedBaseRaw || '0', accountId: row.accountId || null, launchId: row.launchId || null });
      // Graduation is recorded once, when Launchpad first observes it. Meteora
      // migrations carry their finalized time; Raydium pools use the first
      // observation of the graduated market, which is documented as such.
      const observed = row.graduated === true || markets.get(row.mint)?.stage === 'graduated';
      if (observed && !saved.graduated) { saved.graduated = true; saved.graduatedAt = Number.isSafeInteger(row.graduatedAt) && row.graduatedAt > 0 ? row.graduatedAt : now; saved.graduationSource = Number.isSafeInteger(row.graduatedAt) ? 'migration-receipt' : 'first-observation'; }
    }
  }
  // ---- contributions -----------------------------------------------------
  async credit(state, source, receipt) {
    const id = sourceId(source); if (state.seen[id]) return false;
    if (receipt.signature !== source.signature || receipt.mint !== source.mint || receipt.wallet !== source.wallet || receipt.sourceWallet !== source.sourceWallet || !Number.isSafeInteger(receipt.slot) || receipt.slot < 0) throw publicFailure('A Gotchi contribution receipt could not be verified.');
    const amount = uint(receipt.receivedAmount); if (amount <= 0n || amount > uint(source.amount)) throw publicFailure('A Gotchi contribution receipt exceeds its recorded payout.');
    state.seen[id] = { signature: source.signature, mint: source.mint, launchMint: source.launchMint, venue: source.venue, amount: amount.toString(), slot: receipt.slot, at: this.now(), sourceAt: source.at || null };
    state.totals.contributions = (state.totals.contributions || 0) + 1;
    if (source.mint === SOL_MINT) { add(state.totals, 'receivedSol', amount); add(state.totals, 'realizedSol', amount); }
    else { const asset = state.assets[source.mint] ||= { mint: source.mint, decimals: source.decimals, symbol: source.symbol || '', received: '0', credit: '0', converted: '0', error: '', nextAttemptAt: 0, attempts: 0 }; if (asset.decimals !== source.decimals) throw publicFailure('A Gotchi contribution asset changed its precision.'); add(asset, 'received', amount); add(asset, 'credit', amount); }
    delete state.sourceRetry[id]; return true;
  }
  async discover(state, chain) {
    const { sources } = await this.launchRows(); let checked = 0;
    for (const source of sources) {
      if (source.gotchiId !== state.id || source.wallet !== state.vault || !validSignature(source.signature) || !base58(source.sourceWallet) || source.sourceWallet === source.wallet) continue;
      try { uint(source.amount); } catch { continue; }
      const id = sourceId(source);
      if (state.seen[id] || (state.sourceRetry[id]?.nextAttemptAt || 0) > this.now() || checked >= GOTCHI_POLICY.maxSourcesPerTick) continue;
      checked++;
      try { const receipt = await chain.incomingReceipt(source, { wallet: state.vault }); if (!receipt) { retryAt(state.sourceRetry[id] ||= {}, this.now(), 'Waiting for a finalized contribution receipt.'); continue; } await this.credit(state, source, receipt); }
      catch (error) { retryAt(state.sourceRetry[id] ||= {}, this.now(), safeError(error)); }
    }
    if (checked) await this.save(state);
  }
  // ---- valuation -----------------------------------------------------------
  frozenRemaining(state) { const settlement = state.race.settlement; if (!settlement || ['settled'].includes(state.race.status)) return 0n; const remaining = uint(settlement.potLamports) - uint(settlement.spentLamports || '0'); return remaining > 0n ? remaining : 0n; }
  spendableLamports(state) { const value = uint(state.totals.realizedSol) - BigInt(GOTCHI_POLICY.gasReserveLamports) - this.frozenRemaining(state); return value > 0n ? value : 0n; }
  async valuate(state, chain) {
    let price; try { price = await chain.solUsd(); } catch (error) { state.valuation = { ...(state.valuation || {}), stale: true, error: safeError(error) }; return null; }
    const spendable = this.spendableLamports(state), potUsd = Number(spendable) / 1e9 * price.usd;
    state.valuation = { potUsd, solUsd: price.usd, solUsdAt: price.at, at: this.now(), spendableLamports: spendable.toString(), realizedLamports: state.totals.realizedSol, stale: false, error: '' };
    for (const level of GOTCHI_MILESTONES_USD) if (potUsd >= level && !state.milestones.some(row => row.raceIndex === state.race.index && row.usd === level)) state.milestones.push({ raceIndex: state.race.index, usd: level, at: this.now(), potUsd });
    state.milestones = state.milestones.slice(-60);
    await this.save(state); return state.valuation;
  }
  freshValuation(state) { const value = state.valuation; return value && value.stale !== true && Number.isSafeInteger(value.at) && this.now() - value.at <= 2 * 60 * 1000 ? value : null; }
  // ---- conversion ----------------------------------------------------------
  gasDay(state) { if (state.gas.day !== day(this.now())) state.gas = { day: day(this.now()), used: '0', reserved: '0' }; }
  async prepare(state, chain, request, extra = {}) {
    if (state.pending) throw publicFailure('A saved Gotchi transaction must finish before another is prepared.');
    this.gasDay(state); const cap = BigInt(GOTCHI_POLICY.maximumOperationCostLamports);
    if (uint(state.gas.used) + uint(state.gas.reserved) + cap > BigInt(GOTCHI_POLICY.dailyNetworkLimitLamports)) throw publicFailure('The daily Gotchi network-cost limit is used. Processing resumes after midnight UTC.');
    const signer = await this.vaultSigner(state.id); if (signer.address !== state.vault) throw publicFailure('The Gotchi vault key does not match its ledger.');
    const prepared = request.kind === 'airdrop' ? await chain.prepareAirdrop({ wallet: signer, mint: request.mint, payouts: request.payouts, minSolReserve: request.minSolReserve, maxNetworkCostLamports: cap.toString() }) : await chain.prepare({ kind: request.kind, wallet: signer, mint: request.mint, amount: request.amount, minSolReserve: request.minSolReserve, maxNetworkCostLamports: cap.toString() });
    if (this.closed) return false;
    if (!prepared || prepared.kind !== request.kind || prepared.wallet !== state.vault || !validSignature(prepared.signature) || typeof prepared.raw !== 'string' || !prepared.raw || prepared.rawHash !== createHash('sha256').update(Buffer.from(prepared.raw, 'base64')).digest('hex')) throw publicFailure('The prepared Gotchi transaction could not be verified.');
    if (request.kind !== 'airdrop' && (prepared.mint !== request.mint || prepared.inputAmount !== request.amount)) throw publicFailure('The prepared Gotchi transaction changed its amount.');
    if (state.history.some(op => op.signature === prepared.signature) || state.pending?.signature === prepared.signature) throw publicFailure('Waiting for a fresh Gotchi transaction blockhash.');
    state.pending = { ...prepared, state: 'pending', createdAt: this.now(), reservedCost: cap.toString(), reservedDay: state.gas.day, attempts: 0, raceIndex: state.race.index, ...extra };
    add(state.gas, 'reserved', cap); state.error = ''; await this.save(state);
    if (!this.closed) await this.broadcast(state, chain);
    return true;
  }
  async broadcast(state, chain) { const op = state.pending; if (!op || this.closed) return; op.attempts = (op.attempts || 0) + 1; op.lastBroadcastAt = this.now(); await this.save(state); try { await chain.broadcast(op); op.error = ''; } catch { op.error = 'Submission response unavailable. Launchpad is checking the saved transaction.'; } await this.save(state); }
  spendCost(state, op, cost) { this.gasDay(state); if (op.reservedDay === state.gas.day) { const reserved = uint(state.gas.reserved) - uint(op.reservedCost); state.gas.reserved = (reserved > 0n ? reserved : 0n).toString(); } add(state.gas, 'used', cost); add(state.totals, 'networkSpent', cost); }
  async finish(original, receipt) {
    const state = structuredClone(original), op = state.pending;
    if (!op || receipt.signature !== op.signature || !['confirmed', 'failed', 'expired'].includes(receipt.state)) throw publicFailure('The Gotchi confirmation does not match the saved transaction.');
    const input = uint(op.inputAmount), cost = receipt.state === 'expired' ? 0n : uint(String(receipt.actualSolCostLamports || receipt.feeLamports || '0')), settlement = state.race.settlement;
    if (receipt.state === 'confirmed') {
      if (uint(String(receipt.inputAmount)) !== input) throw publicFailure('The confirmed Gotchi input differs from its saved budget.');
      const output = uint(String(receipt.outputAmount || '0'));
      if (op.kind === 'convert') { const asset = state.assets[op.mint]; if (!asset || uint(asset.credit) < input || output === 0n) throw publicFailure('The conversion receipt differs from recorded contributions.'); subtract(asset, 'credit', input); add(asset, 'converted', input); asset.error = ''; asset.nextAttemptAt = 0; asset.attempts = 0; add(state.totals, 'convertedSol', output); add(state.totals, 'realizedSol', output); }
      else if (op.kind === 'acquire') { if (!settlement || op.raceIndex !== state.race.index || state.race.status !== 'buying' || uint(settlement.buyRemainingLamports) < input || output === 0n) throw publicFailure('The purchase receipt differs from the frozen settlement.'); subtract(state.totals, 'realizedSol', input + cost); add(state.totals, 'spentOnWinnerSol', input); add(settlement, 'spentLamports', input + cost); subtract(settlement, 'buyRemainingLamports', input); add(settlement, 'boughtTokens', output); settlement.buys = [...(settlement.buys || []), { signature: op.signature, lamports: input.toString(), tokens: output.toString(), at: this.now() }]; delete state.retry.buy; }
      else if (op.kind === 'airdrop') { if (!settlement || op.raceIndex !== state.race.index || state.race.status !== 'distributing' || op.batchIndex !== settlement.index) throw publicFailure('The airdrop receipt differs from the frozen distribution.'); subtract(state.totals, 'realizedSol', input + cost); add(state.totals, 'airdroppedSol', input); add(state.totals, 'airdroppedTokens', op.tokenAmount || '0'); add(settlement, 'spentLamports', input + cost); settlement.index += op.payouts.length; settlement.airdrops = [...(settlement.airdrops || []), { signature: op.signature, recipients: receipt.recipients || op.payouts.map(row => ({ owner: row.owner, lamports: row.lamports, tokens: row.tokens })), at: this.now() }]; delete state.retry.airdrop; }
      else throw publicFailure('Unknown saved Gotchi operation.');
    } else {
      // A failed transaction still spent its network fee from the vault.
      if (receipt.state === 'failed') { const paid = drain(state.totals, 'realizedSol', cost); if (settlement && ['acquire', 'airdrop'].includes(op.kind)) add(settlement, 'spentLamports', paid); }
      const key = op.kind === 'convert' ? `convert:${op.mint}` : op.kind === 'acquire' ? 'buy' : 'airdrop';
      retryAt(state.retry[key] ||= {}, this.now(), `The previous ${op.kind} did not complete. A fresh transaction will be prepared.`);
      if (op.kind === 'convert' && state.assets[op.mint]) retryAt(state.assets[op.mint], this.now(), 'The previous conversion did not complete. A fresh route will be checked.');
    }
    this.spendCost(state, op, cost);
    state.history.push({ ...opView(op), state: receipt.state, inputAmount: receipt.inputAmount || op.inputAmount, outputAmount: receipt.outputAmount || '0', confirmedAt: this.now(), raceIndex: op.raceIndex, ...(receipt.state === 'confirmed' ? {} : { error: 'The transaction failed or expired without completing.' }) });
    state.history = state.history.slice(-400); state.pending = null; state.error = '';
    await this.save(state); Object.assign(original, state);
  }
  async reconcile(state, chain) {
    const op = state.pending; if (!op) return false; if ((op.nextCheckAt || 0) > this.now()) return true; op.nextCheckAt = this.now() + 10000; await this.save(state);
    try {
      const receipt = await chain.receipt(op, state.vault); if (receipt) { await this.finish(state, receipt); return true; }
      const status = await chain.state(op);
      if (status?.state === 'expired') {
        const checkpoint = status.checkpoint, previous = op.expiryCheck;
        if (status.signature !== op.signature || !Number.isSafeInteger(checkpoint?.slot) || !Number.isSafeInteger(checkpoint?.height) || checkpoint.height <= op.lastValidBlockHeight || !Number.isSafeInteger(status.historyFromSlot) || status.historyFromSlot > op.preparedSlot) { delete op.expiryCheck; op.error = 'Waiting for complete retained transaction history before a retry.'; }
        else if (previous && previous.signature === op.signature && this.now() - previous.at >= 10000 && checkpoint.slot > previous.slot && checkpoint.height > previous.height) { op.expiryProof = { first: previous, second: { ...checkpoint, at: this.now() }, historyFromSlot: status.historyFromSlot }; await this.finish(state, { state: 'expired', signature: op.signature }); return true; }
        else { op.expiryCheck = { signature: op.signature, at: this.now(), ...checkpoint }; op.error = 'Checking a second finalized checkpoint before allowing a fresh transaction.'; }
      } else { delete op.expiryCheck; if (status?.state === 'pending' && (op.attempts || 0) < 4 && this.now() - (op.lastBroadcastAt || 0) >= 20000) await this.broadcast(state, chain); }
      return true;
    } finally { if (state.pending) await this.save(state); }
  }
  async convert(state, chain) {
    for (const asset of Object.values(state.assets).sort((a, b) => (a.lastAttemptAt || 0) - (b.lastAttemptAt || 0) || a.mint.localeCompare(b.mint))) {
      if (asset.mint === SOL_MINT || uint(asset.credit) === 0n || (asset.nextAttemptAt || 0) > this.now()) continue;
      try { asset.lastAttemptAt = this.now(); await this.prepare(state, chain, { kind: 'convert', mint: asset.mint, amount: asset.credit, minSolReserve: '0' }, { stage: 'convert' }); return true; }
      catch (error) { if (state.pending) { state.error = safeError(error); await this.save(state); return true; } retryAt(asset, this.now(), safeError(error)); await this.save(state); }
    }
    return false;
  }
  // ---- sampling ------------------------------------------------------------
  async exclusions(state, coin) { const vaults = await this.vaultAddresses(); return [...new Set([...BURN_ADDRESSES, ...vaults, state.vault, ...(coin.custody || [])])]; }
  async sample(state, chain) {
    // Samples stop at the cutoff: a closing race extends every coin's last
    // sample to the cutoff (bounded by the gap rule), so holdings bought after
    // the pot reached its goal never count toward the frozen result.
    if (state.race.status !== 'open') return;
    const now = this.now(), doc = await this.loadRace(state), race = mergedRace(state, doc);
    const due = Object.values(state.coins).filter(coin => competing(coin) && (now - (race.coins[coin.mint]?.lastSampleAt || 0)) >= GOTCHI_POLICY.sampleIntervalMs).sort((a, b) => (race.coins[a.mint]?.lastSampleAt || 0) - (race.coins[b.mint]?.lastSampleAt || 0)).slice(0, GOTCHI_POLICY.maxSampleCoinsPerTick);
    if (!due.length) return;
    const markets = await this.marketRows(due.map(coin => coin.mint));
    let changed = false;
    for (const coin of due) {
      try {
        const summary = await chain.mintSummary(coin.mint), market = this.freshMarket(markets.get(coin.mint));
        const snapshot = await chain.holderSnapshot({ mint: coin.mint, program: summary.program, exclude: await this.exclusions(state, coin) });
        if (snapshot.complete !== true) throw publicFailure('The holder scan was incomplete.');
        applySample(race, { mint: coin.mint, at: snapshot.at, graduatedAt: coin.graduatedAt, priceUsd8: market?.priceUsd ? usdToUsd8(market.priceUsd).toString() : null, priceAt: market?.at ?? null, decimals: summary.decimals, rows: snapshot.rows }, { maxGapMs: GOTCHI_POLICY.maxSampleGapMs });
        coin.program = summary.program; coin.supply = summary.supply; coin.lastSampleAt = snapshot.at; coin.lastSampleHolders = snapshot.rows.length; coin.sampleError = ''; changed = true;
      } catch (error) { coin.sampleError = safeError(error); coin.lastSampleErrorAt = now; changed = true; }
    }
    if (changed) { storeRace(state, doc, race); state.lastSampleAt = now; await this.saveRace(state, doc); await this.save(state); }
  }
  // ---- settlement ----------------------------------------------------------
  // Closing and freezing are read-only computations plus a journal write and
  // always run, so the cutoff is the moment the pot reached its goal and the
  // frozen plan is visible to the owner. Paused settlement only holds the
  // payments (purchases and airdrops) until the owner resumes.
  async settle(state, chain, { paymentsPaused = false } = {}) {
    const race = state.race, now = this.now();
    if (race.status === 'open') {
      if ((race.nextCloseAt || 0) > now) return;
      const valuation = this.freshValuation(state); if (!valuation || valuation.potUsd < GOTCHI_POLICY.goalUsd) return;
      if (!Object.values(state.coins).some(competing)) return;
      transition(race, 'closing', now, { potUsd: valuation.potUsd }); race.cutoffAt = now; race.closeValuation = { ...valuation }; await this.save(state); return;
    }
    if (race.status === 'closing') { await this.freeze(state); if (race.status !== 'frozen') return; }
    if (paymentsPaused) return;
    // A frozen result is durable before the first purchase is prepared; the
    // purchase stage starts in the same pass so settlement never idles.
    if (race.status === 'frozen') { transition(race, 'buying', this.now()); await this.save(state); return this.buy(state, chain); }
    if (race.status === 'buying') return this.buy(state, chain);
    if (race.status === 'distributing') return this.airdrop(state, chain);
  }
  async freeze(state) {
    const race = state.race, now = this.now(), cutoffAt = race.cutoffAt;
    const graduated = Object.values(state.coins).filter(competing);
    const markets = await this.marketRows(graduated.map(coin => coin.mint));
    const candidates = graduated.map(coin => { const market = this.freshMarket(markets.get(coin.mint)); return { mint: coin.mint, marketCapUsd: market?.marketCapUsd ?? null, graduatedAt: coin.graduatedAt, valuedAt: market?.at ?? null, source: market?.source ?? null, reason: market ? 'No market cap in the fresh valuation.' : 'No fresh valuation at the cutoff.' }; });
    const graceElapsed = now - cutoffAt >= GOTCHI_POLICY.closeGraceMs, everyoneValued = candidates.every(row => row.marketCapUsd !== null);
    if (!everyoneValued && !graceElapsed) { race.closeNote = 'Waiting for a fresh valuation of every graduated coin before freezing the result.'; await this.save(state); return; }
    const doc = await this.loadRace(state), merged = mergedRace(state, doc), final = finalizeScores(merged, cutoffAt, { maxGapMs: GOTCHI_POLICY.maxSampleGapMs });
    const exclude = new Set([...BURN_ADDRESSES, ...await this.vaultAddresses(), ...graduated.flatMap(coin => coin.custody || [])]);
    const ranking = rankHolders(final.scores, { limit: GOTCHI_POLICY.topHolders, exclude }), selection = selectWinner(candidates);
    const abort = reason => { transition(race, 'open', now, { reason }); race.nextCloseAt = now + GOTCHI_POLICY.closeRetryMs; race.closeNote = reason; delete race.cutoffAt; delete race.closeValuation; };
    if (!selection.winner) { abort('No graduated coin had a fresh USD valuation at the cutoff. The pot is preserved and the race stays open.'); await this.save(state); return; }
    if (!ranking.winners.length) { abort('No eligible holder has race time yet. The pot is preserved and the race stays open.'); await this.save(state); return; }
    const spendable = this.spendableLamports(state), reserve = BigInt(GOTCHI_POLICY.recipientReserveLamports) * BigInt(ranking.winners.length);
    const split = splitPot({ spendableLamports: spendable.toString(), reserveLamports: reserve.toString(), splitBps: GOTCHI_POLICY.splitBps });
    if (BigInt(split.distributable) === 0n) { abort('The pot cannot cover its distribution reserve. The race stays open.'); await this.save(state); return; }
    const solPlan = payoutPlan({ winners: ranking.winners, solLamports: split.solLamports, tokensRaw: '0' });
    race.settlement = { cutoffAt, frozenAt: now, closeValuation: race.closeValuation, winner: selection.winner, ranked: selection.ranked, unvalued: selection.unvalued, winners: ranking.winners.map(row => ({ ...row, averageUsd: averageHoldingUsd(row.score, final.duration) })), eligible: ranking.eligible, totalScore: ranking.totalScore, durationMs: final.duration, tailGaps: final.tailGaps, sampleCount: merged.sampleCount, potLamports: spendable.toString(), reserveLamports: split.reserveLamports, distributableLamports: split.distributable, buyLamports: split.buyLamports, solLamports: split.solLamports, solPlan, spentLamports: '0', buyRemainingLamports: split.buyLamports, buyChunkLamports: (BigInt(split.buyLamports) < BigInt(GOTCHI_POLICY.maximumBuyChunkLamports) ? BigInt(split.buyLamports) : BigInt(GOTCHI_POLICY.maximumBuyChunkLamports)).toString(), unspentBuyLamports: '0', boughtTokens: '0', buys: [], payouts: null, index: 0, airdrops: [] };
    race.closedAt = now; delete race.closeNote;
    transition(race, 'frozen', now, { winner: selection.winner.mint, winners: ranking.winners.length, potLamports: spendable.toString() });
    await this.save(state);
  }
  async buy(state, chain) {
    const race = state.race, settlement = race.settlement, now = this.now();
    if (!settlement || race.status !== 'buying') return;
    const remaining = uint(settlement.buyRemainingLamports);
    if (remaining > 0n && (state.retry.buy?.nextAttemptAt || 0) <= now) {
      let chunk = uint(settlement.buyChunkLamports); if (chunk > remaining) chunk = remaining;
      const minimum = BigInt(GOTCHI_POLICY.minimumBuyLamports);
      if (chunk >= minimum) {
        const reserve = uint(state.totals.realizedSol) - chunk - BigInt(GOTCHI_POLICY.maximumOperationCostLamports);
        try { await this.prepare(state, chain, { kind: 'acquire', mint: settlement.winner.mint, amount: chunk.toString(), minSolReserve: (reserve > 0n ? reserve : 0n).toString() }, { stage: 'buy' }); return; }
        catch (error) {
          if (state.pending) { state.error = safeError(error); await this.save(state); return; }
          if (error?.code === 'TREASURY_PRICE_IMPACT' || error?.code === 'SOL_ROUTE_NOT_FOUND') { const next = chunk / 2n; settlement.buyChunkLamports = (next >= minimum ? next : minimum).toString(); settlement.buyNote = next >= minimum ? `The route exceeded its impact limit; trying ${displayUnits(settlement.buyChunkLamports)} SOL chunks.` : 'The market cannot absorb the remaining purchase within the 2% impact limit.'; if (next < minimum) { settlement.impactExhausted = (settlement.impactExhausted || 0) + 1; } }
          retryAt(state.retry.buy ||= {}, now, safeError(error)); state.error = safeError(error); await this.save(state);
          if (!(settlement.impactExhausted >= 3)) return;
          // Three consecutive minimum-chunk refusals: the rest of the purchase
          // budget is airdropped as SOL instead of waiting forever.
          add(settlement, 'unspentBuyLamports', remaining); settlement.buyRemainingLamports = '0'; settlement.buyNote = `${displayUnits(remaining)} SOL of the purchase budget could not be routed within the impact limit and is distributed as SOL.`;
        }
      } else { add(settlement, 'unspentBuyLamports', remaining); settlement.buyRemainingLamports = '0'; settlement.buyNote = 'The remaining purchase budget is below the minimum routed purchase and is distributed as SOL.'; }
    }
    if (uint(settlement.buyRemainingLamports) > 0n) return;
    // Every purchase landed (or was converted to SOL): allocate exact shares.
    const plan = payoutPlan({ winners: settlement.winners.map(row => ({ owner: row.owner, score: row.score })), solLamports: (uint(settlement.solLamports) + uint(settlement.unspentBuyLamports || '0')).toString(), tokensRaw: settlement.boughtTokens });
    settlement.payouts = plan.payouts.filter(row => BigInt(row.lamports) > 0n || BigInt(row.tokens) > 0n); settlement.solRemainder = plan.solRemainder; settlement.tokenRemainder = plan.tokenRemainder; settlement.index = 0;
    transition(race, 'distributing', now, { recipients: settlement.payouts.length, tokens: settlement.boughtTokens });
    await this.save(state);
    return this.airdrop(state, chain);
  }
  async airdrop(state, chain) {
    const race = state.race, settlement = race.settlement, now = this.now();
    if (!settlement || race.status !== 'distributing' || !Array.isArray(settlement.payouts)) return;
    const batch = settlement.payouts.slice(settlement.index, settlement.index + GOTCHI_POLICY.airdropBatch);
    if (batch.length) {
      if ((state.retry.airdrop?.nextAttemptAt || 0) > now) return;
      const reserve = uint(state.totals.realizedSol) - batch.reduce((sum, row) => sum + BigInt(row.lamports), 0n) - BigInt(GOTCHI_POLICY.maximumOperationCostLamports);
      try { await this.prepare(state, chain, { kind: 'airdrop', mint: settlement.winner.mint, payouts: batch.map(row => ({ owner: row.owner, lamports: row.lamports, tokens: row.tokens })), minSolReserve: (reserve > 0n ? reserve : 0n).toString() }, { stage: 'airdrop', batchIndex: settlement.index }); }
      catch (error) { if (state.pending) { state.error = safeError(error); await this.save(state); return; } retryAt(state.retry.airdrop ||= {}, now, safeError(error)); state.error = safeError(error); await this.save(state); }
      return;
    }
    // Settled: record the race, carry remainders and open the next one.
    const summary = { index: race.index, startedAt: race.startedAt, cutoffAt: settlement.cutoffAt, settledAt: now, winner: settlement.winner, winners: settlement.winners, payouts: settlement.payouts, potLamports: settlement.potLamports, reserveLamports: settlement.reserveLamports, buyLamports: settlement.buyLamports, solLamports: settlement.solLamports, unspentBuyLamports: settlement.unspentBuyLamports || '0', boughtTokens: settlement.boughtTokens, spentLamports: settlement.spentLamports, solRemainder: settlement.solRemainder, tokenRemainder: settlement.tokenRemainder, buys: settlement.buys, airdrops: settlement.airdrops, unvalued: settlement.unvalued, durationMs: settlement.durationMs, sampleCount: settlement.sampleCount, carryLamports: state.totals.realizedSol, closeValuation: settlement.closeValuation };
    transition(race, 'settled', now);
    state.races = [...state.races, summary].slice(-50);
    state.celebration = { at: now, raceIndex: race.index, winner: settlement.winner, winners: settlement.winners.length };
    state.race = { ...createRace({ index: race.index + 1, startedAt: now }), coins: undefined, scores: undefined, gaps: undefined };
    await this.saveRace(state, emptyRaceDoc(state.race.index)); await this.save(state);
  }
  // ---- worker ----------------------------------------------------------------
  async processGotchi(id, controls, shared = null) {
    return this.locked(id, async () => {
      const state = await this.load(id), flags = this.flags(controls, id); let chain = shared;
      try {
        chain ||= await this.chainFactory();
        // Read-only steps (coin sync, receipts, valuation, holder samples) run
        // on every pass so a slow or unresolved transaction never opens a gap
        // in the race record; signing steps wait until the journal is empty.
        await this.reconcile(state, chain);
        await this.syncCoins(state); await this.save(state);
        if (!flags.collectionPaused) await this.discover(state, chain);
        await this.valuate(state, chain);
        if (!flags.samplingPaused) await this.sample(state, chain);
        if (state.pending) return;
        if (!flags.conversionPaused && await this.convert(state, chain)) return;
        await this.settle(state, chain, { paymentsPaused: flags.settlementPaused === true });
      } catch (error) { state.error = safeError(error); await this.save(state); }
      finally { if (chain !== shared) await chain?.close?.(); }
    });
  }
  async process() {
    if (this.closed || !this.accounts?.hostStore) return;
    await this.ensure(); const controls = await this.loadControls();
    // One RPC adapter serves the whole pass; when it cannot be created, each
    // Gotchi records the failure on its own pass instead of the loop stopping.
    let shared = null; try { shared = await this.chainFactory(); } catch { /* Recorded per Gotchi below. */ }
    try { for (const theme of GOTCHI_THEMES) { if (this.closed) break; try { await this.processGotchi(theme.id, controls, shared); } catch { /* A locked or unreadable Gotchi retries on the next tick. */ } } }
    finally { await shared?.close?.(); }
  }
  kick() { if (this.closed || this.running) return this.running; this.running = this.process().catch(() => {}).finally(() => { this.running = null; }); return this.running; }
  // The first pass waits a few seconds so a host that is still starting (or a
  // short-lived test host) is not writing vault keys and locks during startup.
  start() { if (this.timer || this.closed) return; this.timer = setInterval(() => this.kick(), this.intervalMs); this.timer.unref?.(); this.initial = setTimeout(() => { this.initial = null; this.kick(); }, Math.min(this.intervalMs, 3000)); this.initial.unref?.(); }
  async close() { this.closed = true; clearInterval(this.timer); this.timer = null; clearTimeout(this.initial); this.initial = null; await this.running; }
  // ---- public views ---------------------------------------------------------
  potView(state) {
    const spendable = this.spendableLamports(state), valuation = state.valuation, usd = valuation && !valuation.stale ? valuation.solUsd : null, potUsd = usd === null ? null : Number(spendable) / 1e9 * usd;
    const collected = Object.values(state.assets).filter(asset => uint(asset.credit) > 0n).map(asset => ({ mint: asset.mint, symbol: asset.symbol, decimals: asset.decimals, amount: displayUnits(asset.credit, asset.decimals), error: asset.error || '' }));
    const coins = Object.values(state.coins);
    const unclaimed = coins.map(coin => ({ mint: coin.mint, venue: coin.venue, pending: displayUnits(coin.pendingRaw || '0', coin.quoteDecimals ?? 9), quoteSymbol: coin.quoteSymbol || '', unconvertedTokens: coin.venue === 'raydium' ? displayUnits(coin.unconvertedBaseRaw || '0', 6) : null }));
    return { realizedSol: displayUnits(state.totals.realizedSol), spendableSol: displayUnits(spendable), reservedSol: displayUnits(uint(state.totals.realizedSol) - spendable), frozenSol: displayUnits(this.frozenRemaining(state)), gasReserveSol: displayUnits(GOTCHI_POLICY.gasReserveLamports), potUsd, solUsd: usd, valuedAt: valuation?.at || null, stale: !valuation || valuation.stale === true || this.now() - (valuation.at || 0) > 10 * 60 * 1000, receivedSol: displayUnits(state.totals.receivedSol), convertedSol: displayUnits(state.totals.convertedSol), spentOnWinnerSol: displayUnits(state.totals.spentOnWinnerSol), airdroppedSol: displayUnits(state.totals.airdroppedSol), networkSpentSol: displayUnits(state.totals.networkSpent), contributions: state.totals.contributions || 0, collected, pendingConversion: state.pending?.kind === 'convert' ? { mint: state.pending.mint, amount: state.pending.inputAmount } : null, unclaimed };
  }
  raceSummary(state, { now = this.now() } = {}) {
    const race = state.race, progress = milestoneProgress(state.valuation && !state.valuation.stale ? state.valuation.potUsd : 0);
    return { ...raceView(race, { now }), coins: undefined, stage: progress.stage, milestones: progress, reached: state.milestones.filter(row => row.raceIndex === race.index), cutoffAt: race.cutoffAt || null, closeNote: race.closeNote || '', settlement: race.settlement ? this.settlementView(race.settlement) : null };
  }
  settlementView(settlement) {
    if (!settlement) return null;
    return { cutoffAt: settlement.cutoffAt, frozenAt: settlement.frozenAt, winner: settlement.winner, ranked: settlement.ranked, unvalued: settlement.unvalued, winners: settlement.winners, eligible: settlement.eligible, durationMs: settlement.durationMs, potSol: displayUnits(settlement.potLamports), reserveSol: displayUnits(settlement.reserveLamports), buySol: displayUnits(settlement.buyLamports), solShareSol: displayUnits(settlement.solLamports), unspentBuySol: displayUnits(settlement.unspentBuyLamports || '0'), boughtTokens: settlement.boughtTokens, payouts: settlement.payouts, index: settlement.index, buys: settlement.buys, airdrops: settlement.airdrops, buyNote: settlement.buyNote || '', spentSol: displayUnits(settlement.spentLamports || '0'), solRemainder: settlement.solRemainder || null, tokenRemainder: settlement.tokenRemainder || null };
  }
  coinViews(state, markets) {
    // Moderated (hidden) coins stay out of public Gotchi views, like Explore.
    return Object.values(state.coins).filter(coin => !coin.hidden).map(coin => { const market = markets.get(coin.mint) || null; return { mint: coin.mint, venue: coin.venue, name: coin.name, symbol: coin.symbol, image: coin.image, href: '/coin?mint=' + coin.mint, attachedAt: coin.attachedAt, graduated: coin.graduated, graduatedAt: coin.graduatedAt, graduationSource: coin.graduationSource || null, status: coin.status, live: coin.live !== false, archived: !!coin.archived, hidden: !!coin.hidden, quoteSymbol: coin.quoteSymbol || '', contributed: displayUnits(coin.contributedRaw || '0', coin.quoteDecimals ?? 9), pending: displayUnits(coin.pendingRaw || '0', coin.quoteDecimals ?? 9), marketCapUsd: market?.marketCapUsd ?? market?.fdvUsd ?? null, priceUsd: market?.priceUsd ?? null, volume24h: market?.volume24h ?? null, stage: market?.stage || (coin.graduated ? 'graduated' : 'new'), marketAt: market?.marketAt || null, marketStale: market?.stale !== false, lastSampleAt: coin.lastSampleAt || null, lastSampleHolders: coin.lastSampleHolders ?? null, sampleError: coin.sampleError || '' }; });
  }
  // Projections run to now while the race is open and to the cutoff once it is closing.
  projectionAt(state) { const cutoff = state.race.status === 'closing' ? state.race.cutoffAt : null; return Number.isSafeInteger(cutoff) && cutoff > 0 && cutoff < this.now() ? cutoff : this.now(); }
  // Public projections read the whole race record; one projection per Gotchi
  // is reused for 15 seconds so page refreshes do not re-integrate every sample.
  async projection(state) {
    const at = this.projectionAt(state), bucket = Math.floor(at / 15000), key = `${state.id}:${state.race.index}:${state.race.status}:${state.lastSampleAt || 0}:${bucket}`;
    const cached = this.projectionCache?.get(state.id); if (cached?.key === key) return cached.value;
    const doc = await this.loadRace(state), merged = mergedRace(state, doc), final = finalizeScores(merged, at, { maxGapMs: GOTCHI_POLICY.maxSampleGapMs });
    const exclude = new Set([...BURN_ADDRESSES, ...await this.vaultAddresses(), ...Object.values(state.coins).flatMap(coin => coin.custody || [])]);
    const value = { at, merged, final, ranking: rankHolders(final.scores, { limit: 100, exclude }) };
    (this.projectionCache ||= new Map()).set(state.id, { key, value }); return value;
  }
  async leaderboard(state, { limit = GOTCHI_POLICY.topHolders } = {}) {
    if (!['open', 'closing'].includes(state.race.status)) return { projected: [], eligible: 0, asOf: null };
    const { at, merged, final, ranking } = await this.projection(state);
    return { projected: ranking.winners.slice(0, limit).map((row, index) => ({ rank: index + 1, owner: row.owner, score: row.score, averageUsd: averageHoldingUsd(row.score, final.duration) })), eligible: ranking.eligible, totalScore: ranking.totalScore, durationMs: final.duration, asOf: at, sampleCount: merged.sampleCount, lastSampleAt: state.lastSampleAt || null };
  }
  async summary(state, markets) {
    const coins = this.coinViews(state, markets), theme = gotchiTheme(state.id), pot = this.potView(state);
    const top = coins.filter(coin => coin.graduated && coin.live && !coin.archived && !coin.hidden).sort((a, b) => (b.marketCapUsd || 0) - (a.marketCapUsd || 0) || a.mint.localeCompare(b.mint)).slice(0, 3);
    return { id: state.id, theme: theme.id, name: theme.name, species: theme.species, tagline: theme.tagline, description: theme.description, interaction: theme.interaction, palette: theme.palette, evolutions: theme.evolutions, vault: state.vault, createdAt: state.createdAt, pot, race: this.raceSummary(state), topCoins: top, attached: coins.length, graduated: coins.filter(coin => coin.graduated).length, lastRace: state.races.length ? this.raceHistoryView(state.races.at(-1)) : null, celebration: state.celebration && this.now() - state.celebration.at < 24 * 3600000 ? state.celebration : null, href: '/gotchi?id=' + state.id };
  }
  raceHistoryView(row) { return { index: row.index, startedAt: row.startedAt, cutoffAt: row.cutoffAt, settledAt: row.settledAt, winner: row.winner, winners: row.winners, payouts: row.payouts, potSol: displayUnits(row.potLamports), buySol: displayUnits(row.buyLamports), solShareSol: displayUnits(row.solLamports), unspentBuySol: displayUnits(row.unspentBuyLamports || '0'), boughtTokens: row.boughtTokens, spentSol: displayUnits(row.spentLamports || '0'), solRemainder: row.solRemainder, tokenRemainder: row.tokenRemainder, buys: row.buys, airdrops: row.airdrops, unvalued: row.unvalued, durationMs: row.durationMs, sampleCount: row.sampleCount, carrySol: displayUnits(row.carryLamports || '0'), closeValuation: row.closeValuation || null }; }
  async list() {
    await this.ensure(); const rows = [];
    const states = []; for (const theme of GOTCHI_THEMES) { try { states.push(await this.load(theme.id)); } catch { rows.push({ id: theme.id, name: theme.name, unavailable: true }); } }
    const markets = await this.marketRows(states.flatMap(state => Object.keys(state.coins)), { wait: 800 });
    for (const state of states) rows.push(await this.summary(state, markets));
    return { gotchis: rows, goalUsd: GOTCHI_POLICY.goalUsd, milestonesUsd: GOTCHI_POLICY.milestonesUsd, topHolders: GOTCHI_POLICY.topHolders, rules: GOTCHI_RULES, funding: { raydium: gotchiFundingSummary('raydium'), meteora: gotchiFundingSummary('meteora'), pump: gotchiFundingSummary('pump') }, at: this.now(), refreshMs: 30000 };
  }
  async detail(id) {
    if (!validGotchiId(id)) fail('Gotchi not found.', 404);
    const state = await this.load(id), markets = await this.marketRows(Object.keys(state.coins), { wait: 1500 }), summary = await this.summary(state, markets);
    return { ...summary, coins: this.coinViews(state, markets), leaderboard: await this.leaderboard(state), history: state.races.slice(-20).reverse().map(row => this.raceHistoryView(row)), rules: GOTCHI_RULES, funding: { raydium: gotchiFundingSummary('raydium'), meteora: gotchiFundingSummary('meteora'), pump: gotchiFundingSummary('pump') }, policy: { goalUsd: GOTCHI_POLICY.goalUsd, milestonesUsd: GOTCHI_POLICY.milestonesUsd, topHolders: GOTCHI_POLICY.topHolders, splitPercent: GOTCHI_POLICY.splitBps / 100, sampleIntervalMinutes: GOTCHI_POLICY.sampleIntervalMs / 60000, maxSampleGapHours: GOTCHI_POLICY.maxSampleGapMs / 3600000, gasReserveSol: displayUnits(GOTCHI_POLICY.gasReserveLamports), recipientReserveSol: displayUnits(GOTCHI_POLICY.recipientReserveLamports), maxPriceImpactPercent: GOTCHI_POLICY.maxPriceImpactPercent, slippageBps: GOTCHI_POLICY.slippageBps }, recent: state.history.slice(-10).reverse(), error: state.error || '', at: this.now(), refreshMs: 30000 };
  }
  async attachment(mint) {
    if (!base58(mint)) return null;
    await this.ensure();
    for (const theme of GOTCHI_THEMES) { let state; try { state = await this.load(theme.id); } catch { continue; } const coin = state.coins[mint]; if (!coin) continue; const pot = this.potView(state); return { id: state.id, name: theme.name, theme: theme.id, href: '/gotchi?id=' + state.id, venue: coin.venue, graduated: coin.graduated, stage: evolutionStage(pot.potUsd || 0), potUsd: pot.potUsd, race: { index: state.race.index, status: state.race.status } }; }
    return null;
  }
  async holdings(walletAddressValue) {
    const wallet = walletAddress(walletAddressValue), rows = [];
    for (const theme of GOTCHI_THEMES) {
      let state; try { state = await this.load(theme.id); } catch { continue; }
      if (!['open', 'closing'].includes(state.race.status)) { rows.push({ id: state.id, name: theme.name, race: { index: state.race.index, status: state.race.status }, settling: true, holdings: [], rank: null, score: '0', averageUsd: 0, inTop: false, shareOfTopPercent: null }); continue; }
      const { at: now, merged, final, ranking } = await this.projection(state), position = ranking.winners.findIndex(row => row.owner === wallet), score = final.scores[wallet] || '0';
      const topScore = ranking.winners.slice(0, GOTCHI_POLICY.topHolders).reduce((sum, row) => sum + BigInt(row.score), 0n);
      const holdings = Object.entries(merged.coins).flatMap(([mint, coin]) => { const amount = coin.balances?.[wallet]; if (!amount) return []; const saved = state.coins[mint]; return [{ mint, symbol: saved?.symbol || '', name: saved?.name || '', amount: displayUnits(amount, coin.decimals ?? 6), sampledAt: coin.lastSampleAt }]; });
      rows.push({ id: state.id, name: theme.name, race: { index: state.race.index, status: state.race.status, startedAt: state.race.startedAt }, settling: false, holdings, rank: position >= 0 ? position + 1 : null, score, averageUsd: averageHoldingUsd(score, final.duration), inTop: position >= 0 && position < GOTCHI_POLICY.topHolders, shareOfTopPercent: position >= 0 && position < GOTCHI_POLICY.topHolders && topScore > 0n ? Number(BigInt(score) * 10000n / topScore) / 100 : null, eligible: ranking.eligible, asOf: now });
    }
    return { wallet, gotchis: rows, at: this.now() };
  }
  // ---- owner controls -------------------------------------------------------
  async requireAdmin(id) { const actor = await this.accounts.get(id); if (!actor || actor.role !== 'admin' || !actor.mfaEnabled || actor.banned) fail('Administrator access with two-factor authentication is required.', 403); return actor; }
  async inspect(actorId, { balances = true } = {}) {
    await this.requireAdmin(actorId); await this.ensure();
    const controls = await this.loadControls(), rows = [];
    for (const theme of GOTCHI_THEMES) {
      let state; try { state = await this.load(theme.id); } catch (error) { rows.push({ id: theme.id, name: theme.name, error: String(error.message).slice(0, 200) }); continue; }
      const row = { id: state.id, name: theme.name, vault: state.vault, flags: this.flags(controls, state.id), pot: this.potView(state), race: this.raceSummary(state), totals: { ...state.totals }, gas: { ...state.gas }, pending: opView(state.pending), pendingError: state.pending?.error || '', retry: Object.fromEntries(Object.entries(state.retry).map(([key, value]) => [key, { attempts: value.attempts || 0, nextAttemptAt: value.nextAttemptAt || null, error: value.error || '' }])), assets: Object.values(state.assets).map(asset => ({ mint: asset.mint, symbol: asset.symbol, decimals: asset.decimals, received: asset.received, credit: asset.credit, converted: asset.converted, error: asset.error || '', nextAttemptAt: asset.nextAttemptAt || null })), sourceRetries: Object.values(state.sourceRetry).slice(0, 20), coins: Object.values(state.coins).map(coin => ({ mint: coin.mint, venue: coin.venue, symbol: coin.symbol, graduated: coin.graduated, graduatedAt: coin.graduatedAt, live: coin.live !== false, archived: !!coin.archived, hidden: !!coin.hidden, contributedRaw: coin.contributedRaw, pendingRaw: coin.pendingRaw, lastSampleAt: coin.lastSampleAt || null, sampleError: coin.sampleError || '' })), history: state.history.slice(-30).reverse(), races: state.races.slice(-10).reverse().map(row => this.raceHistoryView(row)), error: state.error || '', updatedAt: state.updatedAt, balance: null };
      if (balances) { let chain, timer; try { chain = await this.chainFactory(); const read = await Promise.race([chain.vaultBalances({ address: state.vault, mints: [] }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 8000); })]); row.balance = { lamports: read.lamports, sol: displayUnits(read.lamports), slot: read.slot, at: this.now() }; } catch { row.balance = null; } finally { clearTimeout(timer); await chain?.close?.(); } }
      rows.push(row);
    }
    await this.requireAdmin(actorId);
    return { version: 1, enabled: controls.enabled, gotchis: rows, controls: controls.history.slice(-30).reverse(), policy: GOTCHI_POLICY, at: this.now() };
  }
  async control(actorId, { id, enabled, collectionPaused, conversionPaused, settlementPaused, samplingPaused, reason } = {}) {
    const actor = await this.requireAdmin(actorId);
    if (typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 500) fail('Enter a reason between 5 and 500 characters.');
    const updates = { collectionPaused, conversionPaused, settlementPaused, samplingPaused };
    for (const [key, value] of Object.entries(updates)) if (value !== undefined && typeof value !== 'boolean') fail(`Invalid ${key} setting.`);
    if (enabled !== undefined && typeof enabled !== 'boolean') fail('Invalid enabled setting.');
    if (id !== undefined && !validGotchiId(id)) fail('Gotchi not found.', 404);
    const changes = Object.entries(updates).filter(([, value]) => value !== undefined);
    if (changes.length && id === undefined) fail('Choose the Gotchi to pause or resume.');
    if (!changes.length && enabled === undefined) fail('Choose a setting to change.');
    const controls = await this.loadControls(), at = this.now();
    if (enabled !== undefined) controls.enabled = enabled;
    if (id !== undefined) { const flags = { ...this.flags(controls, id) }; for (const [key, value] of changes) flags[key] = value; flags.updatedAt = at; flags.updatedBy = actorId; flags.reason = reason.trim(); controls.gotchis[id] = flags; }
    controls.history = [...controls.history, { at, actorId, actor: actor.username, id: id ?? null, enabled: enabled ?? null, ...Object.fromEntries(changes), reason: reason.trim() }].slice(-200);
    await this.requireAdmin(actorId); await this.accounts.hostStore.write(CONTROLS, controls); this.kick();
    return { enabled: controls.enabled, id: id ?? null, flags: id !== undefined ? this.flags(controls, id) : null };
  }
  async retry(actorId, { id } = {}) {
    await this.requireAdmin(actorId); if (!validGotchiId(id)) fail('Gotchi not found.', 404);
    await this.locked(id, async () => { const state = await this.load(id); state.retry = {}; state.sourceRetry = {}; for (const asset of Object.values(state.assets)) { asset.nextAttemptAt = 0; asset.attempts = 0; } if (state.pending) state.pending.nextCheckAt = 0; if (state.race.settlement) { delete state.race.settlement.impactExhausted; } if (state.race.nextCloseAt) state.race.nextCloseAt = 0; state.error = ''; await this.requireAdmin(actorId); await this.save(state); });
    this.launchCache = null; this.kick();
    return { id, retried: true, at: this.now() };
  }
}
