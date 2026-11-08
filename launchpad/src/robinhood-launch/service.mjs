// Robinhood launch venue: the launchpad's own launch contracts on Robinhood Chain, run the way the Pump.fun Classic venue is run —
// one SQLite journal, per-coin wallets the service holds, a worker that moves every launch through its states and
// every money move journaled before it is sent. The chain half is the launch contracts in contracts/curve-launch-evm.
//
//   quote → the creator funds the launch wallet from a connected EVM wallet (one transfer) → funded → the launch wallet
//   calls the factory (approve + launch) → created (the coin trades on its curve; the dev-buy tokens went straight to
//   the creator; the rest of the funding is refunded) → the fee wallet claims the creator share from the escrow and
//   runs the option (holders paid through LaunchPayouts, Diamond Hands streaks, Earned escrow, Insured pot) → graduation
//   (the curve moves into its locked Uniswap v4 position; the locker's LP fees keep flowing through the escrow).
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { acquireProcessLock } from '../process-lock.mjs';
import { launchpadEnv } from '../brand-env.mjs';
import { coinText, coinLink } from '../pump-classic/coin-text.mjs';
import { pumpOptionRequest, describePumpOption, earnedProbationEnd, insuredDeadline, insuredPotShare, insuredGraduationTarget } from '../../public/pump-option-catalog.mjs';
import { hookLaunchRequest, hookRuleParams } from '../../public/hook-catalog.mjs';
import { openRobinhoodLaunchDatabase, RobinhoodLaunchStore, newId } from './store.mjs';
import { provisionLaunchKeys, launchKeys, hostKeys } from './keys.mjs';
import { RobinhoodLaunchChain, revertText } from './chain.mjs';
import { PairBook } from './pairs.mjs';
import { ROBINHOOD_ADDRESSES, ROBINHOOD_RPC_URL, ROBINHOOD_EXPLORER_URL } from './addresses.mjs';
import { ROBINHOOD_LAUNCH_POLICY, ROBINHOOD_LAUNCH_POLICY_HASH, policyFor, fundingPlan, feeRecipientRole, ledgerRole, tierById } from './policy.mjs';
import { curveForTargets, plannedSupply, tierTargetsInPair, unitsToUsd, curvePrice } from '../../public/robinhood-curve-math.mjs';
import { curveNumbers, poolPrice } from '../../public/robinhood-pool-math.mjs';
import { ROBINHOOD_MODES, ROBINHOOD_LATER_MODES, ROBINHOOD_OPTION_MODES, ROBINHOOD_HOLDER_MODES, ROBINHOOD_MODE_LABELS, ROBINHOOD_TIERS, ROBINHOOD_LIMITS, ROBINHOOD_FEES, ROBINHOOD_FEE_LINK, ROBINHOOD_STATES, ROBINHOOD_NATIVE, ROBINHOOD_CHAIN_ID, robinhoodDisclosure, robinhoodTier, robinhoodTradeLinks, robinhoodTaxed, robinhoodFeesFor } from '../../public/robinhood-launch-catalog.mjs';
import { isAddress, checksumAddress } from '../evm/secp256k1.mjs';
import { formatUnits, parseUnits } from '../evm/hex.mjs';
import { holdersPass, optionsPass, payoutView, cycleView, holderPayoutActive, samplesHolders, insuredCredit } from './rewards.mjs';
import { PairLogos } from './logos.mjs';

const fail = (message, statusCode = 400, code = 'ROBINHOOD_LAUNCH') => { throw Object.assign(Error(message), { statusCode, code }); };
const big = value => typeof value === 'bigint' ? value : BigInt(String(value ?? '0'));
const max0 = value => value > 0n ? value : 0n;
const sha = value => createHash('sha256').update(value).digest('hex');
const bool = value => value === '1' || value === 'true' || value === 'yes';
const lower = value => String(value || '').toLowerCase();
const validHash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const LOCK = 'robinhood-launch.lock';
const HOST = 'host';
// The venue-tracking pass stops after this long and lets the other passes run; the coins it did not reach come first next pass.
const TRACK_BUDGET_MS = 8000;
// Per-launch work runs a few launches at a time: every launch has its own wallet and nonce, so nothing here shares
// state beyond the journal (synchronous SQLite calls that never span an await).
const WORKER_CONCURRENCY = 6;
async function mapLimit(items, limit, fn) {
  const list = [...items]; let next = 0;
  const worker = async () => { while (next < list.length) { const item = list[next++]; await fn(item); } };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
}
const PENDING_STATES = ['awaiting_funding', 'funding_pending', 'funded', 'creating'];
const ABANDONED = ['expired', 'cancelled'];
const DEFAULT_FLAGS = Object.freeze({ intake: false, pairs: false, collection: true, routing: true, holders: true });
export const operatorError = error => String(error?.message || error || 'Unknown error').replace(/(?:https?|wss?):\/\/\S+/g, '[provider]').replace(/0x[0-9a-fA-F]{120,}/g, '[data]').replace(/\s+/g, ' ').trim().slice(0, 600) || 'Unknown error';
export const safeError = error => error?.robinhoodPublic === true || error?.statusCode ? String(error.message).replace(/(?:https?|wss?):\/\/\S+/g, '[provider]').slice(0, 240) : 'Waiting for a verified balance, quote or receipt. This step retries automatically.';
const publicFailure = message => Object.assign(Error(message), { robinhoodPublic: true });
export const amountText = (raw, decimals) => formatUnits(big(raw), decimals);

/** Operator configuration from the environment (LAUNCHPAD_ROBINHOOD_LAUNCH_* and LAUNCHPAD_RH_*). */
export function robinhoodLaunchConfig(env = process.env) {
  const read = name => launchpadEnv(name, env);
  // An address pasted in any case is accepted when its hex is right (a wrong EIP-55 mix is not: it may be a typo).
  const address = name => { const value = String(read(name) || '').trim(); return value && (isAddress(value) || isAddress(value.toLowerCase()) && value === value.toLowerCase()) ? checksumAddress(value) : ''; };
  const usd = Number(read('RH_HOLDER_PAYOUT_USD') ?? ROBINHOOD_LAUNCH_POLICY.holders.minimumCycleUsd);
  // Requests per second to the RPC: the public endpoint tolerates about 15; a dedicated endpoint takes 50 to 200.
  const rps = Number(read('RH_RPC_RPS') || 0);
  return Object.freeze({
    enabled: bool(read('ROBINHOOD_LAUNCH_ENABLED')), rpcUrl: String(read('RH_RPC_URL') || ROBINHOOD_RPC_URL), rpcRps: Number.isFinite(rps) && rps >= 1 && rps <= 1000 ? Math.floor(rps) : (read('RH_RPC_URL') ? 50 : 15),
    addresses: { factory: address('RH_LAUNCH_FACTORY'), escrow: address('RH_FEE_ESCROW'), locker: address('RH_LAUNCH_LOCKER'), engine: address('RH_RULE_ENGINE'), payouts: address('RH_PAYOUTS'), router: address('RH_SWAP_ROUTER'), poolManager: address('RH_POOL_MANAGER') || ROBINHOOD_ADDRESSES.poolManager },
    treasury: address('RH_TREASURY'), dbPath: read('RH_DB_PATH') || '', backupDir: read('RH_BACKUP_DIR') || '',
    ethUsdOverride: /^\d+(\.\d+)?$/.test(String(read('RH_ETH_USD') || '')) ? String(read('RH_ETH_USD')) : null,
    holderPayoutUsd: Number.isFinite(usd) && usd >= 1 && usd <= 1000000 ? usd : ROBINHOOD_LAUNCH_POLICY.holders.minimumCycleUsd,
  });
}

/** The LP fee a swap paid, from its fee in pips: on the input side (the pair asset of a buy, the coins of a sell). */
export function tradeFee(trade) { const pips = BigInt(trade.feePips || 0); return trade.side === 'buy' ? trade.quote * pips / 1000000n : trade.tokens * pips / 1000000n; }

export class RobinhoodLaunchService {
  constructor({ accounts, chainFactory = null, pairBookFactory = null, publishMetadata = null, requireOwner = null, config = robinhoodLaunchConfig(), now = Date.now, intervalMs = 20000, log = null } = {}) {
    Object.assign(this, { accounts, chainFactory, pairBookFactory, publishMetadata, requireOwner, config, now, intervalMs });
    this.log = log || (() => {});
    this.running = null; this.timer = null; this.closed = false; this.ensured = null; this.passes = 0; this.retry = new Map(); this.throttles = new Map(); this.lastError = null; this.lastPassAt = 0;
    this.factory = null; this.factoryAt = 0; this.host = null;
    this.logos = new PairLogos({ dir: typeof accounts?.dir === 'string' ? join(accounts.dir, 'robinhood-logos') : null, now, log: message => this.log('robinhood-logos', { message }) });
  }
  /** The badge path the browser loads for a pair (`/robinhood-pairs/logo/<address>?v=N`), or null for a lettermark. */
  logoPath(row) { return row ? this.logos.pathFor(checksumAddress(row.address), { kind: row.kind, symbol: row.symbol, isin: row.isin, logo: row.logo }) : null; }
  /** The badge bytes for the route: `{ bytes, type, etag }` or null (a 404). */
  async pairLogo(address) {
    if (!this.available() || !isAddress(String(address || ''))) return null;
    const store = await this.ensure(), row = store.pair(checksumAddress(address));
    return this.logos.get(checksumAddress(address), row ? { kind: row.kind, symbol: row.symbol, isin: row.isin, logo: row.logo } : null);
  }

  // ---- storage, flags, locks ----------------------------------------------------------------------------------
  available() { return this.config.enabled && !!this.accounts?.hostStore && typeof this.accounts?.dir === 'string'; }
  configured() { return this.available() && Object.values(this.config.addresses).every(Boolean); }
  store() { if (!this.available()) fail('Robinhood launches are not enabled on this host.', 503, 'ROBINHOOD_LAUNCH_DISABLED'); if (!this.rhStore) fail('Robinhood launches are still starting.', 503, 'ROBINHOOD_LAUNCH_STARTING'); return this.rhStore; }
  async ensure() {
    if (!this.available()) fail('Robinhood launches are not enabled on this host.', 503, 'ROBINHOOD_LAUNCH_DISABLED');
    if (this.ensured) return this.ensured;
    this.ensured = (async () => {
      const db = await openRobinhoodLaunchDatabase(this.config.dbPath || join(this.accounts.dir, 'robinhood-launch', 'robinhood-launch.sqlite'), { now: this.now });
      this.db = db; this.rhStore = new RobinhoodLaunchStore(db, { now: this.now });
      return this.rhStore;
    })().catch(error => { this.ensured = null; throw error; });
    return this.ensured;
  }
  flags() { const saved = this.rhStore?.flags() || {}; return Object.freeze(Object.fromEntries(Object.keys(DEFAULT_FLAGS).map(key => [key, saved[key]?.enabled ?? DEFAULT_FLAGS[key]]))); }
  effective() { const flags = this.flags(), master = this.configured(); return Object.freeze({ master, ...Object.fromEntries(Object.entries(flags).map(([key, value]) => [key, master && value])) }); }
  async locked(fn) { let release; try { release = await acquireProcessLock(join(this.accounts.dir, LOCK)); return await fn(); } finally { await release?.(); } }
  policyOf(launch) { return policyFor(launch.policy_version, launch.policy_hash); }
  throttle(key, ms) { const at = this.throttles.get(key) || 0; if (this.now() - at < ms) return true; this.throttles.set(key, this.now()); return false; }
  backoff(key) { const entry = this.retry.get(key); return !!entry && this.now() < entry.until; }
  retryLater(key, error, { base = 30000, max = 3600000 } = {}) {
    const entry = this.retry.get(key) || { count: 0 }, count = entry.count + 1, until = this.now() + Math.min(max, base * 2 ** Math.min(6, count - 1));
    this.retry.set(key, { count, until, error: operatorError(error) }); this.log('robinhood-launch-retry', { key, count, error: operatorError(error) });
  }

  // ---- chain and pairs ------------------------------------------------------------------------------------------
  async chain() {
    if (this.chainInstance) return this.chainInstance;
    if (!this.configured()) fail('Robinhood launch contracts are not configured on this host (LAUNCHPAD_RH_LAUNCH_FACTORY and friends).', 503, 'ROBINHOOD_LAUNCH_UNCONFIGURED');
    this.chainInstance = this.chainFactory ? await this.chainFactory() : RobinhoodLaunchChain.fromEnv({ rpcUrl: this.config.rpcUrl, addresses: this.config.addresses, policy: ROBINHOOD_LAUNCH_POLICY, log: this.log, requestsPerSecond: this.config.rpcRps || 15 });
    return this.chainInstance;
  }
  async pairBook() {
    if (this.book) return this.book;
    const chain = await this.chain();
    this.book = this.pairBookFactory ? await this.pairBookFactory(chain) : new PairBook({ rpc: chain.rpc, policy: ROBINHOOD_LAUNCH_POLICY, clock: this.now, log: this.log, ethUsdOverride: this.config.ethUsdOverride });
    this.feedCustomPairs(this.book);
    return this.book;
  }
  /** The owner-added (custom) pairs in the store, handed to the pair book so it lists and prices them. */
  feedCustomPairs(book = this.book) { if (book && typeof book.setCustomPairs === 'function' && this.rhStore) book.setCustomPairs(this.rhStore.pairs().filter(p => p.kind === 'custom')); }
  /** The factory's state, cached for a minute: switches, fee, config, recipients. */
  async factoryState({ fresh = false } = {}) {
    if (!fresh && this.factory && this.now() - this.factoryAt < 60000) return this.factory;
    const chain = await this.chain();
    this.factory = await chain.factoryState(BigInt(ROBINHOOD_LAUNCH_POLICY.config.id)); this.factoryAt = this.now();
    return this.factory;
  }
  /** What stops launches on chain, as text (empty when the factory agrees with the policy and is open). */
  factoryBlockers(state) {
    const c = state.config, p = ROBINHOOD_LAUNCH_POLICY.config, out = [];
    if (!state.launchesOpen) out.push('Launches are closed on the factory.');
    if (!c.enabled) out.push('The launch config is disabled on the factory.');
    if (String(c.totalSupply) !== p.totalSupply || ['curveProtocolFeeBps', 'curveCreatorFeeBps', 'poolProtocolFeeBps', 'poolCreatorFeeBps', 'taxPlatformShareBps', 'minTaxBps', 'maxTaxBps', 'tickSpacing'].some(k => Number(c[k]) !== Number(p[k]))) out.push('The factory config does not match this release’s policy.');
    if (!state.payoutsDeployed) out.push('The payouts contract is not deployed at the configured address.');
    if (lower(state.escrow) !== lower(this.config.addresses.escrow) || lower(state.locker) !== lower(this.config.addresses.locker) || lower(state.ruleEngine) !== lower(this.config.addresses.engine)) out.push('The escrow, locker or engine address does not match the factory’s.');
    return out;
  }
  async hostWallets() { if (!this.host) this.host = await hostKeys(this.accounts.hostStore, { now: this.now }); return { owner: this.host.owner.address, platform: this.host.platform.address }; }
  async hostKey(role) { await this.hostWallets(); return this.host[role]; }

  /** Syncs the pair table with the pair book and the chain's approvals (hourly, or on demand from the admin). */
  async syncPairs({ force = false } = {}) {
    const store = this.store(), book = await this.pairBook(), chain = await this.chain();
    if (!force && this.throttle('sync-pairs', 3600000)) return store.pairs();
    this.feedCustomPairs(book);
    const pairs = await book.pairs({ refresh: true });
    for (const p of pairs) if (p.kind !== 'custom') store.upsertPair({ address: p.address, symbol: p.symbol, name: p.name, decimals: p.decimals, kind: p.kind, logo: p.logo, isin: p.isin, enabled: p.kind === 'native' || p.kind === 'stable', approved: false });
    // The on-chain approvals, in a few batched requests (a public RPC throttles 200 single reads).
    const rows = store.pairs();
    try {
      const assets = typeof chain.pairAssets === 'function' ? await chain.pairAssets(rows.map(r => checksumAddress(r.address))) : await Promise.all(rows.map(r => chain.pairAsset(r.address)));
      rows.forEach((row, i) => { const asset = assets[i]; if (asset && asset.approved !== row.approved) store.setPairState(row.address, { approved: asset.approved, approvedAt: asset.approved ? this.now() : null }); });
    } catch (error) { this.log('robinhood-pair-sync-error', { error: operatorError(error) }); }
    return store.pairs();
  }
  /** The pairs a creator can launch on right now: approved on chain and enabled by the owner (stocks only when pairs are open). */
  async launchablePairs({ preview = false } = {}) {
    const store = this.store(), open = this.effective().pairs || preview, book = await this.pairBook();
    await this.logos.refreshOverrides();
    const rows = store.pairs().filter(p => p.approved && p.enabled && (open || p.kind === 'native' || p.kind === 'stable'));
    return rows.map(p => { const price = p.kind === 'stable' ? { usd: '1' } : book.prices.get(p.address) || null; return { address: checksumAddress(p.address), symbol: p.symbol, name: p.name, decimals: p.decimals, kind: p.kind, native: p.kind === 'native' || lower(p.address) === ROBINHOOD_NATIVE, logo: this.logoPath(p), isin: p.isin, usd: price?.usd ?? null, halted: price?.halted ?? false }; });
  }
  pairOf(launch) { return { address: launch.pair_token, symbol: launch.pair_symbol, decimals: Number(launch.pair_decimals), kind: launch.pair_kind, native: lower(launch.pair_token) === ROBINHOOD_NATIVE }; }

  // ---- public reads ---------------------------------------------------------------------------------------------
  async status(session = null) {
    if (!this.available()) return { available: false, venue: 'robinhood', reason: 'Robinhood launches are not enabled on this host.' };
    let reason = '';
    try { await this.ensure(); } catch (error) { reason = safeError(error); }
    const effective = this.effective(), preview = await this.ownerPreview(session);
    let blockers = [], launchFeeEth = null;
    if (this.configured()) { try { const factory = await this.factoryState(); blockers = this.factoryBlockers(factory); launchFeeEth = amountText(factory.launchFee, 18); } catch (error) { blockers = ['The Robinhood Chain RPC did not answer: ' + operatorError(error)]; } }
    else blockers = ['The launch contracts are not configured on this host.'];
    return {
      available: true, venue: 'robinhood', chainId: ROBINHOOD_CHAIN_ID, explorer: ROBINHOOD_EXPLORER_URL, intakeOpen: effective.intake && !blockers.length, pairsOpen: effective.pairs || preview, ownerPreview: preview && !effective.pairs, launchFeeEth,
      modes: ROBINHOOD_MODES.map(id => ({ id, label: ROBINHOOD_MODE_LABELS[id] })), laterModes: [...ROBINHOOD_LATER_MODES], optionModes: [...ROBINHOOD_OPTION_MODES], tiers: ROBINHOOD_TIERS.map(t => ({ id: t.id, label: t.label, startUsd: t.startUsd, graduationUsd: t.graduationUsd, summary: t.summary })),
      limits: ROBINHOOD_LIMITS, feeLink: ROBINHOOD_FEE_LINK, quoteTtlMs: ROBINHOOD_LAUNCH_POLICY.launch.quoteTtlMs, contracts: this.config.addresses, blockers, reason: reason || (blockers.length ? blockers[0] : ''),
    };
  }
  async ownerPreview(session) { if (typeof this.requireOwner !== 'function' || session?.account?.role !== 'admin') return false; try { await this.requireOwner(session); return true; } catch { return false; } }
  async pairs(session = null) {
    await this.ensure();
    const preview = await this.ownerPreview(session), open = this.effective().pairs;
    let pairs = [];
    try { await this.syncPairs(); pairs = await this.launchablePairs({ preview }); } catch (error) { this.log('robinhood-pairs-error', { error: operatorError(error) }); pairs = await this.launchablePairs({ preview }).catch(() => []); }
    return { available: true, pairsOpen: open || preview, ownerPreview: preview && !open, pairs, at: this.now(), notice: open || preview ? '' : 'Stock and ETF pairs are not open on this site yet. Choose ETH or USDG.' };
  }
  /** A pair's USD price (fresh, cached a minute). */
  async pairUsd(address) { const book = await this.pairBook(); return book.priceUsd(address); }

  // ---- the pair catalogue's Custom check (v71.40) ----------------------------------------------------------------
  /**
   * What a creator learns about any token address: a listed pair's state (available, not open yet, not offered, not
   * approved on chain), or — for a token Launchpad has not added — whether it is an ERC-20 the curve could run on (a
   * Uniswap pool on the chain prices it against USDG or ETH). An unlisted, compatible token is recorded as a pair
   * request for the operator (the admin tab lists them with one-click Add). Nothing is signed or spent.
   */
  async pairCheck(session, { address: value } = {}) {
    const store = await this.ensure(), address = String(value || '').trim();
    if (!isAddress(address)) fail('Enter a Robinhood Chain token address (0x followed by 40 hex characters).', 400, 'ROBINHOOD_PAIR_ADDRESS');
    const wanted = checksumAddress(address), book = await this.pairBook(), preview = await this.ownerPreview(session), open = this.effective().pairs || preview;
    if (lower(wanted) === ROBINHOOD_NATIVE || /^0x0{40}$/i.test(wanted)) return { address: ROBINHOOD_NATIVE, symbol: 'ETH', name: 'Ether', decimals: 18, kind: 'native', status: 'available', available: true, usd: (await book.priceUsd(ROBINHOOD_NATIVE).catch(() => null))?.usd ?? null, reason: 'ETH is always available.' };
    const row = store.pair(wanted);
    if (row) {
      const price = await book.priceUsd(row.address).catch(() => null);
      const base = { address: checksumAddress(row.address), symbol: row.symbol, name: row.name, decimals: row.decimals, kind: row.kind, logo: this.logoPath(row), usd: price?.usd ?? null, halted: price?.halted ?? false, approved: row.approved, enabled: row.enabled };
      if (row.approved && row.enabled && (open || row.kind === 'native' || row.kind === 'stable')) return { ...base, status: price?.halted ? 'halted' : 'available', available: !price?.halted, reason: price?.halted ? `${row.symbol} trading is halted right now.` : `${row.symbol} is available as a pair.` };
      if (row.approved && row.enabled) return { ...base, status: 'not_open', available: false, reason: 'Stock, ETF and custom pairs are not open on this site yet. Choose ETH or USDG.' };
      if (row.approved) return { ...base, status: 'not_offered', available: false, reason: `${row.symbol} is approved on chain but not offered on this site yet.` };
      return { ...base, status: 'not_approved', available: false, reason: `${row.symbol} is listed but not approved on chain yet. The operator can approve it from the admin tab.` };
    }
    // Not listed: read the token itself, then look for a price.
    let token;
    try { token = await book.describeToken(wanted); }
    catch (error) { return { address: wanted, status: 'invalid', available: false, compatible: false, reason: operatorError(error) }; }
    let price = null, priceError = '';
    try { price = await book.poolPrice(token.address, token.decimals); } catch (error) { priceError = operatorError(error); }
    const compatible = !!price;
    const onChain = await (await this.chain()).pairAsset(token.address).catch(() => null);
    const reason = compatible ? `${token.symbol} is a valid token with a Uniswap price on Robinhood Chain, but Launchpad has not added it yet. Your request has been sent to the operator.` : `${token.symbol} is a valid token, but ${priceError || 'no Uniswap pool prices it against USDG or ETH'} — Launchpad cannot run a market-cap tier on it until it has a price.`;
    this.recordPairRequest(store, { ...token, usd: price?.usd ?? null, compatible, accountId: session?.account?.id || '' });
    return { address: token.address, symbol: token.symbol, name: token.name, decimals: token.decimals, kind: 'custom', usd: price?.usd ?? null, priceSource: price ? `${price.source} via ${price.via}` : null, approved: !!onChain?.approved, enabled: false, status: 'unlisted', available: false, compatible, requested: true, reason };
  }
  recordPairRequest(store, { address, symbol, name, decimals, usd, compatible, accountId }) {
    const name_ = 'pair-request:' + lower(address), previous = (() => { try { return JSON.parse(store.cursor(HOST, name_) || 'null'); } catch { return null; } })() || {};
    const accounts = [...new Set([...(previous.accounts || []), accountId].filter(Boolean))].slice(-20);
    store.setCursor(HOST, name_, JSON.stringify({ address: checksumAddress(address), symbol, name, decimals, usd: usd ?? previous.usd ?? null, compatible, count: (previous.count || 0) + 1, accounts, firstAt: previous.firstAt || this.now(), lastAt: this.now() }));
    const requests = store.cursorsLike(HOST, 'pair-request:');
    for (const r of requests.slice(200)) store.deleteCursor(HOST, r.name); // bounded: the oldest beyond 200 yield
  }
  /** The operator's list of requested pairs (newest first). */
  pairRequests() { const store = this.rhStore; if (!store) return []; return store.cursorsLike(HOST, 'pair-request:').map(r => { try { return JSON.parse(r.value); } catch { return null; } }).filter(Boolean); }
  /** The owner adds a token as a custom pair: it must be an ERC-20 with a pool price; approval on chain is a separate step. */
  async addCustomPair(address, by) {
    const store = this.store(), book = await this.pairBook();
    if (!isAddress(String(address || ''))) fail('Enter the token address to add.');
    const existing = store.pair(address);
    if (existing && existing.kind !== 'custom') fail(`${existing.symbol} is already listed as a ${existing.kind}.`, 409);
    const token = await book.describeToken(address);
    let price; try { price = await book.poolPrice(token.address, token.decimals); } catch (error) { fail(`${token.symbol} cannot be priced: ${operatorError(error)}`, 409, 'ROBINHOOD_PAIR_PRICE'); }
    const onChain = await (await this.chain()).pairAsset(token.address).catch(() => null);
    store.upsertPair({ address: token.address, symbol: token.symbol, name: token.name, decimals: token.decimals, kind: 'custom', logo: null, isin: null, enabled: false, approved: !!onChain?.approved, approvedAt: onChain?.approved ? this.now() : null, updatedBy: by });
    if (!existing) store.setPairState(token.address, { enabled: false, approved: !!onChain?.approved, updatedBy: by });
    store.deleteCursor(HOST, 'pair-request:' + lower(token.address));
    this.feedCustomPairs(book);
    return { ok: true, pair: { ...token, kind: 'custom', usd: price.usd, approved: !!onChain?.approved }, pairs: store.pairs(), what: `${token.symbol} added as a custom pair (${price.source} price $${price.usd})` };
  }
  removeCustomPair(address, by) {
    const store = this.store(), row = isAddress(String(address || '')) ? store.pair(address) : null;
    if (!row) fail('Unknown pair.', 404);
    if (row.kind !== 'custom') fail('Only custom pairs can be removed; stocks and ETFs come from the stock-token list.');
    store.deletePair(row.address); this.feedCustomPairs();
    this.log('robinhood-pair-removed', { address: row.address, symbol: row.symbol, by });
    return { ok: true, pairs: store.pairs(), what: `${row.symbol} removed from the pair list` };
  }
  sessionWallet(session) { return session?.walletVerified === true ? session.walletAddress : session?.account?.mainWallet || ''; }

  // ---- quote ----------------------------------------------------------------------------------------------------
  async quote(session, body = {}, context) { return this.createQuote(session, body, context); }
  async createQuote(session, body = {}, context) {
    const store = await this.ensure(); if (!this.effective().intake) fail('Robinhood launches are paused right now.', 409, 'ROBINHOOD_LAUNCH_INTAKE_CLOSED');
    const account = session?.account; if (!account || account.banned) fail('Sign in to launch a coin.', 403);
    await context?.authorize?.();
    const requestKey = String(body.requestKey || ''); if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestKey)) fail('A unique launch request ID is required.');
    const key = sha(account.id + ':' + requestKey), existing = store.launchByRequest(key);
    if (existing) { if (existing.account_id !== account.id) fail('Launch not found.', 404); return this.launchView(existing, { owner: true }); }
    const mode = String(body.mode || ''); if (!ROBINHOOD_MODES.includes(mode)) fail(ROBINHOOD_LATER_MODES.includes(mode) ? `${mode.replace('_', ' ')} is not on Robinhood Chain yet. Choose Creator, Holders, Diamond Hands, Earned or Insured.` : 'Choose Creator, Holders, Diamond Hands, Earned or Insured.');
    const name = coinText(body.name, { field: 'coin name', max: 32, bytes: true, required: true }), symbol = coinText(typeof body.symbol === 'string' ? body.symbol.toUpperCase() : body.symbol, { field: 'ticker', max: 13, bytes: true, required: true });
    const description = coinText(body.description, { field: 'description', max: 500 }), website = coinLink(body.website, 'website'), twitter = coinLink(body.twitter, 'twitter'), telegram = coinLink(body.telegram, 'telegram');
    const image = String(body.image || ''); if (!/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(image)) fail('Upload a coin image before reviewing your launch.');
    const developer = String(body.wallet || ''); if (!isAddress(developer)) fail('Connect the Robinhood Chain (EVM) wallet you will fund this launch from.');
    if (store.countLaunches({ accountId: account.id, states: PENDING_STATES }) >= ROBINHOOD_LAUNCH_POLICY.launch.maxPendingLaunches) fail('Finish or cancel your pending Robinhood launches first.', 409);
    const tier = robinhoodTier(String(body.tier || '')); if (!tier) fail('Choose the $4k start or the $20k start.');
    // The fee shape (v71.41, Raydium's): a Creator / Earned / Insured coin carries the flat creator fee; a Holders /
    // Diamond Hands coin carries a holder tax of 1–3% (2% unless chosen) in its pools' fees instead.
    let taxBps = 0;
    if (robinhoodTaxed(mode)) {
      taxBps = body.taxBps === undefined || body.taxBps === null || body.taxBps === '' ? ROBINHOOD_LIMITS.defaultTaxBps : Number(body.taxBps);
      if (!Number.isSafeInteger(taxBps) || taxBps < ROBINHOOD_LIMITS.minTaxBps || taxBps > ROBINHOOD_LIMITS.maxTaxBps) fail(`The holder tax is between ${ROBINHOOD_LIMITS.minTaxBps / 100}% and ${ROBINHOOD_LIMITS.maxTaxBps / 100}%.`);
    } else if (body.taxBps !== undefined && body.taxBps !== null && body.taxBps !== '' && Number(body.taxBps) !== 0) fail('A holder tax belongs to the Holders and Diamond Hands options; a Creator, Earned or Insured coin carries the flat creator fee.');
    const feeShape = robinhoodFeesFor(taxBps);
    const option = pumpOptionRequest(mode, body.option);
    // The pair: approved on chain, enabled here, open or previewed; its price sets the tier's curve numbers.
    const pairAddress = isAddress(String(body.pairToken || '')) ? checksumAddress(body.pairToken) : lower(body.pairToken || '') === 'eth' || !body.pairToken ? ROBINHOOD_NATIVE : '';
    if (!pairAddress) fail('Choose a valid pair asset.');
    const preview = await this.ownerPreview(session), pair = (await this.launchablePairs({ preview })).find(p => lower(p.address) === lower(pairAddress));
    if (!pair) fail(this.effective().pairs || preview ? 'This pair asset is not open for launches.' : 'Stock and ETF pairs are not open on this site yet. Choose ETH or USDG.', 409, 'ROBINHOOD_LAUNCH_PAIR');
    const blockers = this.factoryBlockers(await this.factoryState()); if (blockers.length) fail('Robinhood launches are paused right now: ' + blockers[0], 409, 'ROBINHOOD_LAUNCH_BLOCKED');
    const [price, ethPrice] = await Promise.all([this.pairUsd(pair.address), this.pairUsd(ROBINHOOD_NATIVE)]);
    if (price.halted) fail(`${pair.symbol} trading is halted right now. Choose another pair or try later.`, 409);
    const targets = tierTargetsInPair(tier, price.usd, pair.decimals), numbers = curveForTargets(targets.startFdv, targets.graduationFdv);
    const chain = await this.chain(), onChainPair = await chain.pairAsset(pair.address);
    const rules = await this.rulesFrom(chain, body, mode);
    if (!onChainPair.approved) fail('This pair asset is not approved on chain yet.', 409, 'ROBINHOOD_LAUNCH_PAIR');
    if (onChainPair.maxGraduationQuote !== 0n && (numbers.graduationQuote < onChainPair.minGraduationQuote || numbers.graduationQuote > onChainPair.maxGraduationQuote)) fail(`${pair.symbol}’s price has moved too far from the pair’s approved range for this tier. An operator needs to refresh the pair.`, 409, 'ROBINHOOD_LAUNCH_PAIR_RANGE');
    const devBuy = this.devBuyFrom(body, pair);
    const factory = await this.factoryState(), fees = await chain.feeData();
    const plan = fundingPlan({ launchFeeWei: factory.launchFee, devBuyWei: pair.native ? devBuy : 0n, pairIsEth: pair.native, maxFeePerGas: fees.maxFeePerGas });
    const id = randomBytes(12).toString('hex'), keys = await provisionLaunchKeys(this.accounts.hostStore, id, mode, { now: this.now });
    const salt = '0x' + sha('salt:' + id).slice(0, 64);
    const supply = plannedSupply(ROBINHOOD_LAUNCH_POLICY.config.totalSupply, numbers.virtualQuote, numbers.graduationQuote);
    const uri = await this.publishMetadata({ accountId: account.id, mint: await this.predictedToken(chain, { name, symbol, metadataURI: '', pair, numbers, salt }), name, symbol, description, image, website, twitter, telegram });
    const token = await this.predictedToken(chain, { name, symbol, metadataURI: uri, pair, numbers, salt });
    const quote = {
      v: 1, tier: tier.id, startUsd: tier.startUsd, graduationUsd: tier.graduationUsd, pairUsd: price.usd, ethUsd: ethPrice.usd, priceAt: price.at,
      launchFeeWei: String(plan.launchFee), devBuy: String(devBuy), devBuyWei: String(plan.devBuy), gasBudgetWei: String(plan.gasBudget), feeWalletGasWei: String(plan.feeWalletGas), totalWei: String(plan.totalWei),
      sellSupply: String(supply.sellSupply), lpSupply: String(supply.lpSupply), expectedTokens: devBuy > 0n ? String(this.expectedTokens(numbers, supply, devBuy, feeShape.curveTotalBps)) : '0', expiresAt: this.now() + ROBINHOOD_LAUNCH_POLICY.launch.quoteTtlMs,
    };
    const row = store.insertLaunch({
      id, account_id: account.id, request_key: key, mode, policy_version: ROBINHOOD_LAUNCH_POLICY.version, policy_hash: ROBINHOOD_LAUNCH_POLICY_HASH,
      name, symbol, description, image, website, twitter, telegram, metadata_uri: uri, option: option ? { ...option, state: this.initialOptionState(mode, option) } : null, rules,
      tier: tier.id, pair_token: pair.address, pair_symbol: pair.symbol, pair_decimals: pair.decimals, pair_kind: pair.kind, pair_usd: price.usd, eth_usd: ethPrice.usd, virtual_quote: String(numbers.virtualQuote), graduation_quote: String(numbers.graduationQuote),
      developer_wallet: checksumAddress(developer), launch_wallet: keys.launch.address, fee_wallet: keys.fee?.address || null, token, salt, tax_bps: taxBps, curve_fee: feeShape.curveTotalBps * 100, pool_fee: feeShape.poolTotalBps * 100, dev_buy: String(devBuy),
      plan: { totalWei: String(plan.totalWei), launchFeeWei: String(plan.launchFee), devBuyWei: String(plan.devBuy), devBuy: String(devBuy), gasBudgetWei: String(plan.gasBudget), feeWalletGasWei: String(plan.feeWalletGas), gasPriceWei: String(plan.gasPrice) },
      quote, quote_expires_at: quote.expiresAt, state: 'awaiting_funding',
    });
    store.addEvent({ launchId: id, kind: 'quote', title: 'Launch quoted', body: `${tier.label} on ${pair.symbol}, ${ROBINHOOD_MODE_LABELS[mode]}.`, isPublic: false });
    return this.launchView(row, { owner: true });
  }
  async predictedToken(chain, { name, symbol, metadataURI, pair, numbers, salt }) {
    return chain.predictToken({ name, symbol, metadataURI, configId: BigInt(ROBINHOOD_LAUNCH_POLICY.config.id), pairToken: pair.address, virtualQuote: numbers.virtualQuote, graduationQuote: numbers.graduationQuote, salt });
  }
  /** The creator's rules from the launch form, through the shared hook catalogue (EVM addresses), as the engine's RuleSetup. */
  async rulesFrom(chain, body, mode) {
    const request = body.hooks === undefined || body.hooks === null ? null : hookLaunchRequest(body.hooks, { address: /^0x[0-9a-fA-F]{40}$/ });
    const rules = request?.rules || [];
    if (!rules.length) return null;
    if (rules.length > ROBINHOOD_LIMITS.maxRules) fail(`At most ${ROBINHOOD_LIMITS.maxRules} transfer rules.`);
    const addr = value => { const v = String(value || ''); if (!isAddress(v)) fail('A rule names an address that is not a Robinhood Chain address.'); return checksumAddress(v); };
    // Kind 21 reads a Solana transaction's priority fee; kind 25 (the tithe) needs the donation instruction only Launchpad's Solana
    // route adds — a Uniswap v4 pool swap carries neither, and the factory refuses 25 as well (UnsupportedRule).
    for (const rule of rules) if (!Number.isInteger(rule.kind) || rule.kind < 1 || rule.kind > 25 || rule.kind === 21 || rule.kind === 25) fail(`${rule.id || 'This rule'} is not available on Robinhood Chain.`);
    let gateDecimals = 0;
    if (request.gateMint) { const meta = await chain.tokenMeta(addr(request.gateMint)); if (meta.decimals == null) fail('Holder-gated: the gate token could not be read on Robinhood Chain.'); gateDecimals = meta.decimals; }
    const list = rules.map(r => ({ id: r.id, kind: r.kind, p: hookRuleParams(r.id, r.settings, { gateDecimals, decimals: 18, maxParam: (1n << 256n) - 1n }).map(String), settings: r.settings }));
    return { version: 1, mode, rules: list, gateToken: request.gateMint ? addr(request.gateMint) : ROBINHOOD_NATIVE, titheRecipient: request.titheRecipient ? addr(request.titheRecipient) : ROBINHOOD_NATIVE,
      allowlist: (request.allowlist || []).map(addr), blocklist: (request.blocklist || []).map(addr) };
  }
  devBuyFrom(body, pair) {
    const text = String(body.devBuy ?? body.devBuyAmount ?? '0').trim() || '0';
    let amount; try { amount = parseUnits(text, pair.decimals); } catch { fail(`Enter the first buy as a ${pair.symbol} amount with up to ${pair.decimals} decimals.`); }
    if (amount < 0n) fail('The first buy cannot be negative.');
    return amount;
  }
  expectedTokens(numbers, supply, devBuy, curveFeeBps) {
    const net = devBuy - devBuy * BigInt(curveFeeBps) / 10000n;
    const k = numbers.virtualQuote * supply.virtualToken, after = k / (numbers.virtualQuote + net), out = supply.virtualToken - after;
    return out > supply.sellSupply ? supply.sellSupply : out;
  }
  initialOptionState(mode, option) {
    if (mode === 'diamond_hands') return { payouts: 0, paidWallets: 0, skippedWallets: 0, lastPayoutAt: null };
    if (mode === 'earned') return { phase: 'pending', baseline: null, floor: null, checks: [], nextCheckAt: null, probationEndsAt: null };
    if (mode === 'insured') return { phase: 'pending', pot: '0', potCredited: '0', potPaid: '0', potReleased: '0', deadlineAt: null, refundDue: null };
    return null;
  }

  // ---- funding --------------------------------------------------------------------------------------------------
  requireOwnLaunch(session, launchId) {
    const store = this.store(), account = session?.account; if (!account) fail('Sign in first.', 401);
    if (typeof launchId !== 'string' || !/^[a-f0-9]{24}$/.test(launchId)) fail('Launch not found.', 404);
    const launch = store.launch(launchId); if (!launch || launch.account_id !== account.id) fail('Launch not found.', 404);
    return launch;
  }
  /** What the creator's wallet must send: ETH to the launch wallet (plus the pair asset for a non-ETH first buy). */
  async prepareFunding(session, { launchId } = {}, context) {
    await this.ensure(); await context?.authorize?.();
    const launch = this.requireOwnLaunch(session, launchId);
    if (launch.state !== 'awaiting_funding') fail(`This launch is ${ROBINHOOD_STATES[launch.state] || launch.state}.`, 409);
    if (this.now() >= launch.quote_expires_at) { this.store().moveLaunch(launch.id, 'awaiting_funding', 'expired', { state_reason: 'The quote expired before funding.' }); fail('This quote expired. Start over for a fresh quote.', 409, 'ROBINHOOD_LAUNCH_EXPIRED'); }
    return { launchId: launch.id, chainId: ROBINHOOD_CHAIN_ID, from: launch.developer_wallet, expiresAt: launch.quote_expires_at, transactions: this.fundingTransactions(launch) };
  }
  fundingTransactions(launch) {
    const pair = this.pairOf(launch), tag = '0x' + Buffer.from('rh-launch:' + launch.id, 'utf8').toString('hex');
    const list = [{ purpose: 'eth', to: launch.launch_wallet, value: '0x' + big(launch.plan.totalWei).toString(16), data: tag, label: `${amountText(launch.plan.totalWei, 18)} ETH to the launch wallet` }];
    if (!pair.native && big(launch.dev_buy) > 0n) list.push({ purpose: 'pair', to: pair.address, value: '0x0', data: this.chainInstance ? this.chainInstance.transferData(launch.launch_wallet, big(launch.dev_buy)) : null, label: `${amountText(launch.dev_buy, pair.decimals)} ${pair.symbol} to the launch wallet` });
    return list;
  }
  /** The creator sent the funding; the worker confirms it by balance and, when hashes are given, by the transactions themselves. */
  async submitFunding(session, { launchId, txHashes, txHash } = {}, context) {
    await this.ensure(); await context?.authorize?.();
    const launch = this.requireOwnLaunch(session, launchId), store = this.store();
    const hashes = [...new Set([...(Array.isArray(txHashes) ? txHashes : []), ...(txHash ? [txHash] : [])].map(String))];
    if (!hashes.length || !hashes.every(validHash)) fail('Send the funding transaction hash(es).');
    if (launch.state === 'funding_pending' || launch.state === 'funded') return this.launchView(store.launch(launch.id), { owner: true });
    if (launch.state !== 'awaiting_funding') fail(`This launch is ${ROBINHOOD_STATES[launch.state] || launch.state}.`, 409);
    if (!store.moveLaunch(launch.id, 'awaiting_funding', 'funding_pending', { funding_tx: hashes[0], quote: { ...launch.quote, fundingHashes: hashes, submittedAt: this.now() } })) fail('The launch changed. Reload and try again.', 409);
    store.addEvent({ launchId: launch.id, kind: 'funding', title: 'Funding sent', body: 'Waiting for the transfer to confirm.', txHash: hashes[0], isPublic: false });
    this.kick();
    return this.launchView(store.launch(launch.id), { owner: true });
  }
  async cancel(session, { launchId } = {}) {
    await this.ensure();
    const launch = this.requireOwnLaunch(session, launchId), store = this.store();
    if (launch.state !== 'awaiting_funding') fail('Only a launch waiting for funding can be cancelled.', 409);
    store.moveLaunch(launch.id, 'awaiting_funding', 'cancelled', { state_reason: 'Cancelled by the creator before funding.' });
    return this.launchView(store.launch(launch.id), { owner: true });
  }
  async mine(session) {
    const store = await this.ensure(), account = session?.account; if (!account) fail('Sign in first.', 401);
    const live = store.launchesWhere({ accountId: account.id, states: ['created'] }), rest = store.launchesWhere({ accountId: account.id, exceptStates: ['created', ...ABANDONED], limit: 50 });
    return { launches: [...live, ...rest].map(l => this.launchView(l, { owner: true })) };
  }
  async ownLaunch(session, { launchId } = {}) { await this.ensure(); return this.launchView(this.requireOwnLaunch(session, launchId), { owner: true }); }

  // ---- worker ---------------------------------------------------------------------------------------------------
  start() {
    if (!this.available() || this.timer || this.closed) return;
    const tick = () => { this.timer = setTimeout(() => this.run().finally(() => { if (!this.closed) tick(); }), this.intervalMs); this.timer.unref?.(); };
    this.run().finally(() => { if (!this.closed) tick(); });
  }
  kick() { if (!this.running && !this.closed && this.available()) this.run().catch(() => {}); }
  async run() {
    if (this.running) return this.running;
    this.running = (async () => { try { await this.ensure(); await this.locked(() => this.process()); this.lastError = null; } catch (error) { this.lastError = operatorError(error); this.log('robinhood-launch-pass-error', { error: this.lastError }); } finally { this.running = null; } })();
    return this.running;
  }
  async close() {
    this.closed = true; clearTimeout(this.timer); this.timer = null;
    if (this.running) await this.running.catch(() => {});
    this.db?.close(); this.db = null; this.rhStore = null; this.ensured = null;
  }
  stop() { return this.close(); }
  async process() {
    if (!this.configured()) return;
    const chain = await this.chain(); this.passes += 1; this.lastPassAt = this.now();
    for (const pass of ['settleOperations', 'reconcileFunding', 'createCoins', 'refunds', 'trackVenues', 'collect', 'route', 'holders', 'options', 'housekeeping']) {
      if (this.closed) return;
      try { await this[pass](chain); } catch (error) { this.lastError = `${pass}: ${operatorError(error)}`; this.log('robinhood-launch-pass-error', { pass, error: operatorError(error) }); }
    }
  }

  // ---- operations: sign, journal, send, settle -------------------------------------------------------------------
  async nonceFor(chain, wallet) { const pending = await chain.pendingNonce(wallet), journal = this.store().highestNonce(wallet) + 1; return Math.max(pending, journal); }
  /** Signs, journals and broadcasts one transaction from a per-coin or host key. */
  async send(chain, { key, launchId, kind, to, data = '0x', value = 0n, gasLimit = null, expected = {} }) {
    const store = this.store(), wallet = key.address;
    const nonce = await this.nonceFor(chain, wallet);
    const op = await chain.prepare({ key: key.secret, kind, launchId, to, data, value, nonce, gasLimit, expected });
    const row = store.insertOperation({ id: newId('op'), launchId, kind, state: 'signed', wallet, hash: op.hash, raw: op.raw, nonce: op.nonce, gas: op.gas, maxFee: op.maxFee, expected: { ...op.expected, ...expected, hashes: [op.hash] } });
    await this.broadcastOp(chain, row);
    return store.operation(row.id);
  }
  async broadcastOp(chain, op) {
    const store = this.store();
    try { await chain.broadcast(op.raw); store.updateOperation(op.id, { state: 'submitted', attempts: (op.attempts || 0) + 1, lastBroadcastAt: this.now(), checkAfter: this.now() + 3000 }); }
    catch (error) { store.updateOperation(op.id, { state: op.state === 'signed' ? 'signed' : op.state, attempts: (op.attempts || 0) + 1, error: operatorError(error), checkAfter: this.now() + 15000 }); throw error; }
  }
  openOp(launchId, kinds) { return this.store().openOperations(launchId).find(op => kinds.includes(op.kind)) || null; }
  /** Every open operation: resend what never landed, settle what did (effects by kind), replace what stalled. */
  async settleOperations(chain) {
    const store = this.store();
    for (const op of store.allOpenOperations()) {
      if (this.closed) return;
      if (this.now() < (op.check_after || 0)) continue;
      try {
        if (op.state === 'signed') { await this.broadcastOp(chain, op); continue; }
        const state = await chain.txState({ ...op, hash: op.hash });
        if (state.state === 'pending' && !state.receipt) {
          const age = this.now() - (op.created_at || this.now());
          if (age > 600000 && (op.attempts || 0) < 12) await this.replaceOp(chain, op);
          else if (this.now() - (op.last_broadcast_at || 0) > 30000) await this.broadcastOp(chain, op);
          else store.updateOperation(op.id, { checkAfter: this.now() + 5000 });
          continue;
        }
        if (state.state === 'pending') { store.updateOperation(op.id, { checkAfter: this.now() + 3000 }); continue; }
        if (state.state === 'replaced') { store.updateOperation(op.id, { state: 'replaced', error: 'The nonce was spent by another transaction.' }); await this.opFailed(chain, store.operation(op.id), 'replaced'); continue; }
        const receipt = state.receipt, cost = receipt.gasUsed * receipt.effectiveGasPrice;
        store.transaction(() => {
          store.updateOperation(op.id, { state: state.state, receipt: { status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: String(receipt.gasUsed), effectiveGasPrice: String(receipt.effectiveGasPrice), cost: String(cost), logs: receipt.logs.length } });
        });
        if (state.state === 'confirmed') await this.opConfirmed(chain, store.operation(op.id), receipt, cost); else await this.opFailed(chain, store.operation(op.id), 'reverted', receipt, cost);
      } catch (error) { store.updateOperation(op.id, { error: operatorError(error), checkAfter: this.now() + 15000 }); this.log('robinhood-launch-op-error', { op: op.id, kind: op.kind, error: operatorError(error) }); }
    }
  }
  async replaceOp(chain, op) {
    const store = this.store(), key = await this.keyForOp(op); if (!key) return;
    const bumped = await chain.bump({ key: key.secret, op });
    store.updateOperation(op.id, { hash: bumped.hash, raw: bumped.raw, maxFee: bumped.maxFee, expected: { ...op.expected, hashes: [...(op.expected.hashes || []), bumped.hash], replacedAt: this.now() }, state: 'signed', attempts: (op.attempts || 0) + 1, checkAfter: 0 });
    await this.broadcastOp(chain, store.operation(op.id));
    this.log('robinhood-launch-op-replaced', { op: op.id, kind: op.kind });
  }
  async keyForOp(op) {
    await this.hostWallets();
    const hostKey = [this.host.owner, this.host.platform].find(k => lower(k.address) === lower(op.wallet)) || null;
    // A launch-scoped operation the host signed (a graduation record, a pool-fee collection on a Creator coin) is the
    // host wallet's to replace as well.
    if (op.launch_id === HOST || hostKey) return hostKey;
    const launch = this.store().launch(op.launch_id); if (!launch) return null;
    const keys = await launchKeys(this.accounts.hostStore, launch);
    return [keys.launch, keys.fee].filter(Boolean).find(k => lower(k.address) === lower(op.wallet)) || null;
  }
  /** Gas paid by a per-coin wallet lands on its ledger: the launch wallet's budget, or the fee wallet's gas (ETH) or rewards (ETH pair). */
  chargeGas(launch, op, cost) {
    if (!launch || cost <= 0n) return;
    const store = this.store();
    if (lower(op.wallet) === lower(launch.launch_wallet)) { try { store.adjust(launch.id, 'launch', ROBINHOOD_NATIVE, { cost }); } catch { /* the budget ledger is informative */ } return; }
    if (launch.fee_wallet && lower(op.wallet) === lower(launch.fee_wallet)) {
      // On an ETH pair the option's own ledger pays its gas once it holds something; before that (the first claim) and
      // on every other pair the gas seed pays. A cost the seed ledger cannot cover is still recorded against it.
      const role = ledgerRole(launch.mode) || 'rewards', native = this.pairOf(launch).native;
      if (native && store.balance(launch.id, role, ROBINHOOD_NATIVE).available >= cost) { try { store.adjust(launch.id, role, ROBINHOOD_NATIVE, { cost }); return; } catch { /* falls through to the seed */ } }
      try { store.adjust(launch.id, 'gas', ROBINHOOD_NATIVE, { cost }); } catch { try { store.adjust(launch.id, 'gas', ROBINHOOD_NATIVE, { credit: cost, cost }); } catch { /* informative */ } }
    }
  }
  async opConfirmed(chain, op, receipt, cost) {
    const store = this.store(), launch = op.launch_id === HOST ? null : store.launch(op.launch_id);
    this.chargeGas(launch, op, cost);
    switch (op.kind) {
      case 'approve': case 'approve-payouts': break;
      case 'launch': await this.launchConfirmed(chain, launch, op, receipt); break;
      case 'seed': try { store.adjust(launch.id, 'gas', ROBINHOOD_NATIVE, { credit: big(op.expected.value || 0) }); } catch { /* informative */ } store.addEvent({ launchId: launch.id, kind: 'funding', title: 'Fee wallet seeded with gas', body: `${amountText(op.expected.value || '0', 18)} ETH for the option’s network fees.`, txHash: op.hash, isPublic: false }); break;
      case 'refund': store.updateLaunch(launch.id, { refund_state: 'complete', refund_tx: op.hash, refunded_wei: String(big(launch.refunded_wei) + big(op.expected.value || 0)) }); try { store.adjust(launch.id, 'launch', ROBINHOOD_NATIVE, { debit: big(op.expected.value || 0) }); } catch { /* informative */ }
        if (launch.state === 'refunding' || launch.state === 'failed') store.moveLaunch(launch.id, ['refunding', 'failed'], 'refunded'); store.addEvent({ launchId: launch.id, kind: 'refund', title: 'Unused funding returned', body: `${amountText(op.expected.value || '0', 18)} ETH went back to your wallet.`, txHash: op.hash }); break;
      case 'refund-pair': store.updateLaunch(launch.id, { refunded_pair: String(big(launch.refunded_pair) + big(op.expected.amount || 0)) }); store.addEvent({ launchId: launch.id, kind: 'refund', title: `Unused ${launch.pair_symbol} returned`, body: `${amountText(op.expected.amount || '0', launch.pair_decimals)} ${launch.pair_symbol} went back to your wallet.`, txHash: op.hash }); break;
      case 'claim': this.claimConfirmed(launch, op, receipt); break;
      case 'collect': { const fees = chain.decodeFeesCollected(receipt, launch.token); const pair = this.pairOf(launch); store.addEvent({ launchId: launch.id, kind: 'fees', title: 'Pool fees collected', body: fees && fees.quote > 0n ? `${amountText(fees.quote, pair.decimals)} ${pair.symbol} of the pool’s fees moved into the escrow${fees.coinsSold > 0n ? ` (${amountText(fees.coinsSold, 18)} ${launch.symbol} of coin-side fees sold into the pool)` : ''}: ${amountText(fees.creator, pair.decimals)} to the option, ${amountText(fees.platform, pair.decimals)} to Launchpad.` : 'Nothing was waiting.', txHash: op.hash, isPublic: false }); break; }
      case 'graduate': { const g = chain.decodeGraduated(receipt, launch.token); if (g) this.graduated(launch, { poolId: g.poolId, tick: Number(g.tick), txHash: op.hash }); else store.addEvent({ launchId: launch.id, kind: 'venue', title: 'Graduation not recorded', body: 'The price was no longer past the graduation tick when the transaction ran. It is retried when it crosses again.', txHash: op.hash, isPublic: false }); break; }
      case 'payout': this.payoutConfirmed(chain, launch, op, receipt); break;
      case 'sweep': { const sweep = store.sweepForOperation(op.id); if (sweep) { store.updateSweep(sweep.id, { state: 'complete', hash: op.hash, block: receipt.blockNumber }); } break; }
      case 'platform-claim': { for (const claim of chain.decodeClaims(receipt.logs, op.wallet)) store.recordFeeClaim({ launchId: HOST, kind: 'platform-claim', wallet: op.wallet, role: 'platform', asset: claim.asset, amount: claim.amount, txHash: op.hash, logIndex: claim.logIndex, block: receipt.blockNumber }); break; }
      case 'platform-sweep': { const sweep = store.sweepForOperation(op.id); if (sweep) store.updateSweep(sweep.id, { state: 'complete', hash: op.hash, block: receipt.blockNumber }); break; }
      case 'pairs': { for (const address of op.expected.pairs || []) store.setPairState(address, { approved: true, approvedAt: this.now() }); this.factoryAt = 0; break; }
      case 'owner': this.factoryAt = 0; break;
      default: break;
    }
  }
  async opFailed(chain, op, why, receipt = null, cost = 0n) {
    const store = this.store(), launch = op.launch_id === HOST ? null : store.launch(op.launch_id);
    this.chargeGas(launch, op, cost);
    this.log('robinhood-launch-op-failed', { op: op.id, kind: op.kind, why });
    switch (op.kind) {
      case 'launch': await this.launchFailed(chain, launch, op, why); break;
      case 'refund': store.updateLaunch(launch.id, { refund_state: 'pending' }); break;
      case 'payout': { const cycle = op.expected.cycleId ? store.rewardCycle(op.expected.cycleId) : null; if (cycle && cycle.state === 'paying') store.updateRewardCycle(cycle.id, { state: 'frozen' }); break; }
      case 'sweep': case 'platform-sweep': { const sweep = store.sweepForOperation(op.id); if (sweep) store.updateSweep(sweep.id, { state: 'failed' }); break; }
      default: break;
    }
    if (launch) store.addEvent({ launchId: launch.id, kind: 'operation', title: `A ${op.kind} transaction ${why === 'reverted' ? 'reverted' : 'was replaced'}`, body: 'It is retried automatically.', txHash: op.hash, isPublic: false });
  }

  // ---- funding → creation → refund ----------------------------------------------------------------------------
  async reconcileFunding(chain) {
    const store = this.store();
    const due = [];
    for (const launch of store.launchesInStates(['awaiting_funding', 'funding_pending'])) {
      if (launch.state === 'awaiting_funding' && this.now() >= launch.quote_expires_at) { store.moveLaunch(launch.id, 'awaiting_funding', 'expired', { state_reason: 'The quote expired before funding.' }); continue; }
      if (launch.state === 'awaiting_funding' && this.throttle('fund-check:' + launch.id, 30000)) continue;
      due.push(launch);
    }
    if (!due.length) return;
    // One batched request reads every pending launch wallet's ETH (hundreds of launches, one round trip).
    let balances = null;
    try { balances = typeof chain.ethBalances === 'function' ? await chain.ethBalances(due.map(l => l.launch_wallet)) : null; } catch (error) { this.log('robinhood-launch-balance-batch', { error: operatorError(error) }); }
    for (const [index, launch] of due.entries()) {
      if (this.closed) return;
      try {
        const pair = this.pairOf(launch), need = big(launch.plan.totalWei), devBuy = big(launch.dev_buy);
        const [eth, pairBalance] = await Promise.all([balances ? Promise.resolve(balances[index]) : chain.ethBalance(launch.launch_wallet), pair.native || devBuy === 0n ? Promise.resolve(0n) : chain.tokenBalance(pair.address, launch.launch_wallet)]);
        const funded = eth >= need && (pair.native || devBuy === 0n || pairBalance >= devBuy);
        if (!funded) {
          if (launch.state === 'funding_pending') {
            // A hash the creator sent that reverted or belongs to someone else sends the launch back to waiting (or expires it).
            const hashes = launch.quote?.fundingHashes || [];
            let bad = false;
            for (const hash of hashes) { const proof = await chain.transactionProof(hash); if (proof && (!proof.status || lower(proof.from) !== lower(launch.developer_wallet))) bad = true; }
            if (bad || this.now() - Number(launch.quote?.submittedAt || launch.updated_at) > 1800000) {
              const expired = this.now() >= launch.quote_expires_at;
              store.moveLaunch(launch.id, 'funding_pending', expired ? 'expired' : 'awaiting_funding', { state_reason: bad ? 'The funding transaction did not deliver the amount from your wallet.' : expired ? 'The quote expired before the funding arrived.' : '' });
            }
          }
          continue;
        }
        const seen = launch.quote?.fundingHashes || [];
        let fundingTx = launch.funding_tx || seen[0] || null;
        if (store.moveLaunch(launch.id, ['awaiting_funding', 'funding_pending'], 'funded', { funded_wei: String(eth), funded_pair: String(pairBalance), funded_at: this.now(), funding_tx: fundingTx })) {
          try { store.adjust(launch.id, 'launch', ROBINHOOD_NATIVE, { credit: eth }); } catch { /* informative */ }
          store.addEvent({ launchId: launch.id, kind: 'funding', title: 'Funding confirmed', body: `${amountText(eth, 18)} ETH${pair.native || devBuy === 0n ? '' : ` and ${amountText(pairBalance, pair.decimals)} ${pair.symbol}`} on the launch wallet.`, txHash: fundingTx, isPublic: false });
        }
      } catch (error) { this.retryLater('fund:' + launch.id, error, { base: 30000 }); }
    }
  }
  async createCoins(chain) {
    const store = this.store();
    await mapLimit(store.launchesInStates(['funded', 'creating']), WORKER_CONCURRENCY, async launch => {
      if (this.closed) return;
      if (this.openOp(launch.id, ['approve', 'launch'])) return;
      if (this.backoff('create:' + launch.id)) return;
      if (launch.state === 'creating' && launch.create_attempts >= ROBINHOOD_LAUNCH_POLICY.launch.maxCreateAttempts) { await this.failLaunch(chain, launch, 'The launch transaction kept failing.'); return; }
      if (this.now() - Number(launch.funded_at || launch.updated_at) > ROBINHOOD_LAUNCH_POLICY.launch.maxFundingAgeMs) { await this.failLaunch(chain, launch, 'The launch could not be created within a day of funding.'); return; }
      try {
        const keys = await launchKeys(this.accounts.hostStore, launch), pair = this.pairOf(launch), devBuy = big(launch.dev_buy), factory = await this.factoryState({ fresh: launch.state === 'creating' });
        const blockers = this.factoryBlockers(factory); if (blockers.length) { this.retryLater('create:' + launch.id, Error(blockers[0]), { base: 120000 }); return; }
        if (factory.launchFee > big(launch.plan.launchFeeWei)) { await this.failLaunch(chain, launch, 'The launch fee rose after your quote; your funding is refunded. Launch again for a fresh quote.'); return; }
        if (!pair.native && devBuy > 0n) {
          const allowance = await chain.allowance(pair.address, launch.launch_wallet, this.config.addresses.factory);
          if (allowance < devBuy) { await this.send(chain, { key: keys.launch, launchId: launch.id, kind: 'approve', to: pair.address, data: chain.approveData(this.config.addresses.factory, devBuy), expected: { amount: String(devBuy) } }); return; }
        }
        const params = this.launchParams(launch, factory);
        const value = factory.launchFee + (pair.native ? devBuy : 0n);
        store.moveLaunch(launch.id, ['funded', 'creating'], 'creating', { create_attempts: launch.create_attempts + 1 });
        const op = await this.send(chain, { key: keys.launch, launchId: launch.id, kind: 'launch', to: this.config.addresses.factory, data: chain.launchData(params), value, gasLimit: ROBINHOOD_LAUNCH_POLICY.gas.launchGas, expected: { token: launch.token } });
        store.updateLaunch(launch.id, { create_tx: op.hash });
      } catch (error) {
        if (error?.code === 'ROBINHOOD_LAUNCH_SIMULATION' && /PairNotApproved|LaunchesClosed|ConfigDisabled|RaiseOutOfBounds|RatioOutOfBounds|CustomCurvesOff/.test(error.message)) { await this.failLaunch(chain, launch, `The factory refused the launch: ${error.message.replace(/^launch: /, '')}.`); return; }
        store.updateLaunch(launch.id, { state_reason: operatorError(error).slice(0, 240) });
        this.retryLater('create:' + launch.id, error, { base: 60000 });
      }
    });
  }
  launchParams(launch, factory) {
    const rules = launch.rules;
    const zero = ROBINHOOD_NATIVE, feeRecipient = feeRecipientRole(launch.mode) === 'developer' ? launch.developer_wallet : launch.fee_wallet;
    return {
      name: launch.name, symbol: launch.symbol, metadataURI: launch.metadata_uri, creator: launch.developer_wallet, creatorFeeRecipient: feeRecipient, devBuyRecipient: launch.developer_wallet,
      taxBps: launch.tax_bps || 0, pairToken: launch.pair_token, configId: BigInt(ROBINHOOD_LAUNCH_POLICY.config.id), virtualQuote: big(launch.virtual_quote), graduationQuote: big(launch.graduation_quote), salt: launch.salt,
      devBuyQuote: big(launch.dev_buy), minDevBuyTokens: 0n,
      rules: { rules: (rules?.rules || []).map(r => ({ kind: r.kind, p: r.p.map(big) })), gateToken: rules?.gateToken || zero, titheRecipient: rules?.titheRecipient || zero, allowlist: rules?.allowlist || [], blocklist: rules?.blocklist || [], exempt: launch.fee_wallet ? [launch.fee_wallet] : [] },
    };
  }
  async launchConfirmed(chain, launch, op, receipt) {
    const store = this.store(), event = chain.decodeLaunched(receipt);
    if (!event) { await this.launchFailed(chain, launch, op, 'no Launched event'); return; }
    const tokenIs0 = lower(event.token) < lower(launch.pair_token), transfers = chain.decodeTransfers(receipt.logs, event.token);
    const trades = chain.attributeTrades(chain.decodeTrades(receipt.logs, new Map([[lower(event.poolId), { token: event.token, tokenIs0 }]])), transfers), devTokens = trades.find(t => t.side === 'buy')?.tokens || 0n;
    if (lower(event.token) !== lower(launch.token)) this.log('robinhood-launch-token-mismatch', { launch: launch.id, predicted: launch.token, actual: event.token });
    store.transaction(() => {
      // `curve` names the venue the coin trades in: the Uniswap v4 PoolManager (the pool itself is `pool_id`).
      store.moveLaunch(launch.id, ['creating', 'funded'], 'created', { token: event.token, curve: this.config.addresses.poolManager, pool_id: event.poolId, curve_pool_id: event.poolId, curve_fee: Number(event.curveFee), pool_fee: Number(event.poolFee), tax_bps: Number(event.taxBps), created_block: receipt.blockNumber, live_at: this.now(), dev_tokens: String(devTokens), fee_state: 'verified', venue_state: 'curve', state_reason: '' });
      store.setCursor(launch.id, 'transfers', receipt.blockNumber - 1); store.setCursor(launch.id, 'trades', receipt.blockNumber - 1); store.setCursor(launch.id, 'credits', receipt.blockNumber - 1);
      if (launch.option) this.updateOption(store.launch(launch.id), state => { if (launch.mode === 'earned') { state.phase = 'probation'; state.probationEndsAt = earnedProbationEnd(this.now(), launch.option.settings); state.nextCheckAt = this.now() + 86400000; } if (launch.mode === 'insured') { state.phase = 'active'; state.deadlineAt = insuredDeadline(this.now(), launch.option.settings); } });
    });
    store.addEvent({ launchId: launch.id, kind: 'live', title: 'Coin created on Robinhood Chain', body: `${launch.symbol} trades in its Uniswap v4 pool against ${launch.pair_symbol} from this block: on Launchpad, on GMGN, DexScreener, DEXTools and in any wallet that swaps on Robinhood Chain.`, txHash: op.hash });
    // Apply this receipt's own logs to the holder index and trade list right away.
    this.indexTransfers(launch, transfers); store.setCursor(launch.id, 'transfers', receipt.blockNumber);
    for (const t of trades) store.recordTrade({ launchId: launch.id, side: t.side, wallet: t.wallet, quote: t.quote, tokens: t.tokens, fee: tradeFee(t), txHash: t.txHash, logIndex: t.logIndex, block: t.block, at: this.now(), sqrtPrice: t.sqrtPriceX96, tick: t.tick, attributed: t.attributed });
    store.setCursor(launch.id, 'trades', receipt.blockNumber);
    this.factoryAt = 0;
  }
  async launchFailed(chain, launch, op, why) {
    const store = this.store();
    store.updateLaunch(launch.id, { state_reason: why === 'reverted' ? 'The launch transaction reverted.' : `The launch transaction ${why}.` });
    if (launch.create_attempts >= ROBINHOOD_LAUNCH_POLICY.launch.maxCreateAttempts) await this.failLaunch(chain, launch, 'The launch transaction kept failing.');
    else this.retryLater('create:' + launch.id, Error(why), { base: 30000 });
  }
  async failLaunch(chain, launch, reason) {
    const store = this.store();
    if (store.moveLaunch(launch.id, ['funded', 'creating'], 'failed', { state_reason: reason, refund_state: 'pending' })) store.addEvent({ launchId: launch.id, kind: 'failed', title: 'Launch failed', body: reason });
  }
  /** Returns what the launch wallet still holds to the developer: after creation, after a failure, or a late deposit. */
  async refunds(chain) {
    const store = this.store(), policy = ROBINHOOD_LAUNCH_POLICY;
    const candidates = [...store.launchesInStates(['failed', 'refunding']), ...store.launchesWhere({ states: ['created'] }).filter(l => l.refund_state === 'none' || l.refund_state === 'pending'), ...store.launchesInStates(['expired', 'cancelled']).filter(l => l.refund_state !== 'complete' && this.now() - l.updated_at < 7 * 86400000)];
    await mapLimit(candidates, WORKER_CONCURRENCY, async launch => {
      if (this.closed) return;
      if (this.openOp(launch.id, ['launch', 'approve', 'seed', 'refund', 'refund-pair'])) return;
      if (this.backoff('refund:' + launch.id) || this.throttle('refund-check:' + launch.id, launch.state === 'created' ? 60000 : 300000)) return;
      try {
        const keys = await launchKeys(this.accounts.hostStore, launch), pair = this.pairOf(launch);
        const seedDue = launch.state === 'created' && launch.fee_wallet && big(launch.plan.feeWalletGasWei) > 0n && !store.latestOperation(launch.id, 'seed', 'confirmed');
        const fees = await chain.feeData(), gasPrice = fees.maxFeePerGas > BigInt(policy.gas.minimumGasPriceWei) ? fees.maxFeePerGas : BigInt(policy.gas.minimumGasPriceWei);
        if (seedDue) { await this.send(chain, { key: keys.launch, launchId: launch.id, kind: 'seed', to: launch.fee_wallet, value: big(launch.plan.feeWalletGasWei), gasLimit: 21000, expected: { value: launch.plan.feeWalletGasWei } }); return; }
        if (!pair.native) {
          const pairBalance = await chain.tokenBalance(pair.address, launch.launch_wallet);
          if (pairBalance > 0n && launch.state !== 'funded' && launch.state !== 'creating') { await this.send(chain, { key: keys.launch, launchId: launch.id, kind: 'refund-pair', to: pair.address, data: chain.transferData(launch.developer_wallet, pairBalance), expected: { amount: String(pairBalance) } }); return; }
        }
        const balance = await chain.ethBalance(launch.launch_wallet);
        const amount = balance - 21000n * gasPrice * BigInt(policy.gas.feeHeadroomBps) / 10000n;
        if (amount <= BigInt(policy.reserves.refundDustWei)) { if (launch.state !== 'expired' && launch.state !== 'cancelled' && launch.refund_state !== 'complete') store.updateLaunch(launch.id, { refund_state: launch.refund_state === 'pending' ? 'not_needed' : launch.refund_state }); if (launch.state === 'failed') store.moveLaunch(launch.id, 'failed', 'refunded'); return; }
        if (launch.state === 'failed') store.moveLaunch(launch.id, 'failed', 'refunding');
        await this.send(chain, { key: keys.launch, launchId: launch.id, kind: 'refund', to: launch.developer_wallet, value: amount, gasLimit: 21000, expected: { value: String(amount) } });
        store.updateLaunch(launch.id, { refund_state: 'pending' });
      } catch (error) { this.retryLater('refund:' + launch.id, error, { base: 60000 }); }
    });
  }

  // ---- venue tracking: curve state, trades, transfers, graduation ----------------------------------------------
  async trackVenues(chain) {
    const store = this.store(), started = this.now(), budgetMs = TRACK_BUDGET_MS;
    // Coins least recently tracked first, so a long list is covered round-robin across passes instead of the same head of the list each time.
    const live = store.liveLaunches(this.config.addresses.poolManager).filter(l => !this.backoff('track:' + l.id)).sort((a, b) => (this.throttles.get('track:' + a.id) || 0) - (this.throttles.get('track:' + b.id) || 0));
    const due = live.filter(l => !this.throttle('track:' + l.id, 30000));
    if (!due.length) return;
    let head;
    try { head = await chain.blockNumber(); } catch (error) { this.log('robinhood-launch-pass-error', { pass: 'trackVenues', error: operatorError(error) }); return; }
    // The logs of every due coin in a few requests (transfers of all tokens, trades of all curves) instead of two per coin.
    await this.scanLogsTogether(chain, due, head);
    for (const launch of due) {
      if (this.closed) return;
      if (this.now() - started > budgetMs) { this.throttles.delete('track:' + launch.id); continue; } // the rest comes first next pass
      try {
        if (!this.throttle('pool:' + launch.id, 60000)) {
          // The pool's live state (price, tick, liquidity, progress) is kept for the pages; graduation is recorded on chain
          // the first time the price sits past the graduation tick (anyone may call it; the host does, from the owner wallet).
          const pool = await chain.poolState(launch.token, launch.pool_id);
          const pos = p => p ? { tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: String(p.liquidity) } : null;
          store.setCursor(launch.id, 'pool-state', JSON.stringify({ poolId: pool.poolId, curvePoolId: pool.curvePoolId, sqrtPriceX96: String(pool.sqrtPriceX96), tick: pool.tick, liquidity: String(pool.liquidity), progressBps: pool.progressBps, crossed: pool.crossed, graduated: pool.graduated, tokenIs0: pool.tokenIs0, startTick: pool.startTick, graduationTick: pool.graduationTick, curve: pos(pool.curve), upper: pos(pool.upper), positions: (pool.positions || []).map(pos), fee: pool.key.fee, tickSpacing: pool.key.tickSpacing, at: this.now() }));
          if (pool.graduated) { if (launch.venue_state !== 'graduated') this.graduated(launch, { poolId: pool.poolId, tick: pool.tick, txHash: null }); }
          else if (pool.crossed && launch.venue_state !== 'graduated' && !this.openOp(launch.id, ['graduate']) && !this.throttle('graduate:' + launch.id, 300000)) {
            // The graduation moves the liquidity into the graduation pool (the locker does it; anyone may call it, the host does).
            const owner = await this.hostKey('owner');
            if ((await chain.ethBalance(owner.address)) > 10n ** 15n) await this.send(chain, { key: owner, launchId: launch.id, kind: 'graduate', to: this.config.addresses.locker, data: chain.graduateData(launch.token), gasLimit: BigInt(ROBINHOOD_LAUNCH_POLICY.gas.graduateGas) });
            else this.log('robinhood-launch-owner-gas', { launch: launch.id, note: 'the owner wallet needs ETH to graduate the coin' });
          }
        }
      } catch (error) { this.retryLater('track:' + launch.id, error, { base: 60000 }); }
    }
  }
  /** A launch as the pool log scans need it: its coin and pool id, and which side of the pool the coin is. */
  poolOf(launch) { return { token: launch.token, poolId: launch.pool_id, tokenIs0: lower(launch.token) < lower(launch.pair_token) }; }
  /** The pools a coin's trades can be in: the pool trading now and, once graduated, the curve pool it came from (its last trades). */
  poolsOf(launch) {
    const pools = [this.poolOf(launch)];
    if (launch.curve_pool_id && lower(launch.curve_pool_id) !== lower(launch.pool_id)) pools.push({ ...pools[0], poolId: launch.curve_pool_id });
    return pools;
  }
  recordTrades(launch, trades) {
    const store = this.store();
    for (const t of trades) store.recordTrade({ launchId: launch.id, side: t.side, wallet: t.wallet, quote: t.quote, tokens: t.tokens, fee: tradeFee(t), txHash: t.txHash, logIndex: t.logIndex, block: t.block, at: this.now(), sqrtPrice: t.sqrtPriceX96, tick: t.tick, attributed: t.attributed });
  }
  /**
   * The Transfer logs of many coins and the Swap logs of their pools in a few requests: one `eth_getLogs` per 50 coins
   * per block range (the pool ids as the Swap event's indexed topic), from the oldest cursor to the head; each coin
   * applies only the logs past its own cursor, and every swap is attributed to the wallet behind the router from the
   * coin's Transfer in the same transaction. A coin whose cursor lags more than `maxRange` blocks behind the rest is
   * scanned on its own (its range would stretch everyone's). Falls back to per-coin scans when the node refuses
   * multi-address queries.
   */
  async scanLogsTogether(chain, launches, head, { maxRange = 4000, perRequest = 50 } = {}) {
    const store = this.store();
    if (typeof chain.transferLogsOf !== 'function' || typeof chain.tradeLogsOf !== 'function' || launches.length < 2) { for (const launch of launches) { try { await this.scanLogs(chain, launch, head); } catch (error) { this.retryLater('track:' + launch.id, error, { base: 60000 }); } } return; }
    const cursorOf = (l, name) => Number(store.cursor(l.id, name) ?? (l.created_block || 0));
    const group = [], alone = [];
    const newest = Math.max(...launches.map(l => Math.min(cursorOf(l, 'transfers'), cursorOf(l, 'trades'))));
    for (const l of launches) (Math.min(cursorOf(l, 'transfers'), cursorOf(l, 'trades')) < newest - maxRange ? alone : group).push(l);
    for (const launch of alone) { try { await this.scanLogs(chain, launch, head); } catch (error) { this.retryLater('track:' + launch.id, error, { base: 60000 }); } }
    for (let i = 0; i < group.length; i += perRequest) {
      const slice = group.slice(i, i + perRequest);
      let from = Math.min(...slice.map(l => Math.min(cursorOf(l, 'transfers'), cursorOf(l, 'trades')))) + 1;
      try {
        for (let step = 0; from <= head && step < 10; step++) {
          const to = Math.min(head, from + maxRange - 1);
          const [transfers, trades] = await Promise.all([chain.transferLogsOf(slice.map(l => l.token), from, to), chain.tradeLogsOf(slice.flatMap(l => this.poolsOf(l)), from, to)]);
          const transfersOf = new Map(slice.map(l => [lower(l.token), []])), tradesOf = new Map(slice.map(l => [lower(l.token), []]));
          for (const row of transfers) transfersOf.get(lower(row.address))?.push(row);
          for (const row of trades) tradesOf.get(lower(row.address))?.push(row);
          store.transaction(() => {
            for (const launch of slice) {
              const sinceTransfers = cursorOf(launch, 'transfers'), sinceTrades = cursorOf(launch, 'trades');
              const mineTransfers = (transfersOf.get(lower(launch.token)) || []).filter(r => Number(r.block) > sinceTransfers);
              const mineTrades = chain.attributeTrades((tradesOf.get(lower(launch.token)) || []).filter(r => Number(r.block) > sinceTrades), transfersOf.get(lower(launch.token)) || []);
              this.indexTransfers(launch, mineTransfers);
              this.recordTrades(launch, mineTrades);
              if (to > sinceTransfers) store.setCursor(launch.id, 'transfers', to);
              if (to > sinceTrades) store.setCursor(launch.id, 'trades', to);
            }
          });
          from = to + 1;
        }
      } catch (error) {
        // A node that refuses the multi-address query (or a transient failure): the coins fall back to their own scans next pass.
        this.log('robinhood-launch-scan-batch', { coins: slice.length, error: operatorError(error) });
        for (const launch of slice) { try { await this.scanLogs(chain, launch, head); } catch (e) { this.retryLater('track:' + launch.id, e, { base: 60000 }); } }
      }
    }
  }
  /** Applies one coin's Transfer logs and its pool's Swap logs since the saved cursors (in bounded block ranges). */
  async scanLogs(chain, launch, head, { maxRange = 4000 } = {}) {
    const store = this.store();
    let from = Math.min(Number(store.cursor(launch.id, 'transfers') ?? (launch.created_block || 0)), Number(store.cursor(launch.id, 'trades') ?? (launch.created_block || 0))) + 1;
    for (let step = 0; from <= head && step < 10; step++) {
      const to = Math.min(head, from + maxRange - 1);
      const transfers = await chain.transferLogs(launch.token, from, to);
      const trades = (await Promise.all(this.poolsOf(launch).map(pool => chain.tradeLogs(pool, from, to, transfers)))).flat().sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
      const sinceTransfers = Number(store.cursor(launch.id, 'transfers') ?? (launch.created_block || 0)), sinceTrades = Number(store.cursor(launch.id, 'trades') ?? (launch.created_block || 0));
      store.transaction(() => {
        this.indexTransfers(launch, transfers.filter(r => Number(r.block) > sinceTransfers));
        this.recordTrades(launch, trades.filter(r => Number(r.block) > sinceTrades));
        if (to > sinceTransfers) store.setCursor(launch.id, 'transfers', to);
        if (to > sinceTrades) store.setCursor(launch.id, 'trades', to);
      });
      from = to + 1;
    }
  }
  indexTransfers(launch, rows) {
    const result = this.store().applyTransfers(launch.id, rows);
    if (result.underflows) this.log('robinhood-launch-holder-index', { launch: launch.id, underflows: result.underflows, note: 'a Transfer log before the cursor was missed; balances clamped at zero' });
    return result;
  }
  /** The coin moved into its graduation pool: `poolId` is the graduation pool (the curve pool's id stays in `curve_pool_id`). */
  graduated(launch, { poolId, tick = null, txHash }) {
    const store = this.store(), fresh = store.launch(launch.id);
    if (!fresh || fresh.venue_state === 'graduated') return;
    const fees = robinhoodFeesFor(fresh.tax_bps || 0);
    store.updateLaunch(launch.id, { venue_state: 'graduated', graduated_at: this.now(), pool_id: poolId || fresh.pool_id, curve_pool_id: fresh.curve_pool_id || fresh.pool_id });
    store.addEvent({ launchId: launch.id, kind: 'venue', title: 'Graduated', body: `${launch.symbol} passed its graduation price: the curve position sold out, the transfer rules are off, and the raise and the remaining supply moved into the coin’s ${(fees.poolTotalBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}% Uniswap v4 ${launch.pair_symbol} pool, locked for good. It keeps trading there on Launchpad, Uniswap, GMGN and any wallet.`, txHash });
    if (fresh.mode === 'insured') this.insuredGraduated(fresh);
    this.log('robinhood-launch-graduated', { launch: launch.id, poolId: poolId || fresh.pool_id, tick });
  }
  insuredGraduated(launch) {
    const store = this.store(); let outcome = null;
    this.updateOption(launch, state => { if (state.phase !== 'active') return false; const target = insuredGraduationTarget(launch.option.settings); state.phase = target === 'holders' ? 'bonus' : 'released'; state.decidedAt = this.now(); if (target === 'holders') state.refundDue = 'bonus'; else state.potReleased = state.pot; outcome = state.phase; });
    if (outcome) store.addEvent({ launchId: launch.id, kind: 'option', title: outcome === 'bonus' ? 'Graduation bonus owed to holders' : 'Refund pot released to the creator', body: outcome === 'bonus' ? 'The coin graduated in time: the refund pot is paid to the top holders as a bonus.' : 'The coin graduated in time: the refund pot goes to the creator with the rest of the fees.' });
  }
  updateOption(launch, mutate) {
    const store = this.store(), fresh = store.launch(launch.id); if (!fresh?.option) return null;
    const option = JSON.parse(JSON.stringify(fresh.option)); option.state = option.state || {};
    if (mutate(option.state) === false) return null;
    store.updateLaunch(launch.id, { option });
    return option;
  }

  // ---- fee claims and routing -----------------------------------------------------------------------------------
  /**
   * Every coin's pool fees are collected from the locker into the escrow (the platform's and the option's shares),
   * then the fee wallet claims the creator share from the escrow. A collection goes out only when the locker has
   * something worth the gas (a dry run says what it would credit).
   */
  async collect(chain) {
    const store = this.store(); if (!this.effective().collection) return;
    const book = await this.pairBook();
    await mapLimit(store.liveLaunches(this.config.addresses.poolManager), WORKER_CONCURRENCY, async launch => {
      if (this.closed) return;
      if (this.openOp(launch.id, ['claim', 'collect']) || this.backoff('collect:' + launch.id)) return;
      try {
        const pair = this.pairOf(launch), keys = launch.fee_wallet ? await launchKeys(this.accounts.hostStore, launch) : null;
        // The pool's fees sit in the locked positions until someone collects them into the escrow: the coin's fee wallet
        // does it for the reward options, the host's platform wallet for a Creator coin (whose share then waits under the
        // creator's own wallet in the escrow, claimed from the coin page; the platform's share is in the same call).
        const collector = keys?.fee || await this.hostKey('platform');
        const collectorHasGas = keys?.fee ? await this.hasGas(chain, launch, keys.fee) : (await chain.ethBalance(collector.address)) >= 2n * BigInt(ROBINHOOD_LAUNCH_POLICY.reserves.keepWei);
        if (!this.throttle('locker:' + launch.id, ROBINHOOD_LAUNCH_POLICY.collection.lockerIntervalMs) && collectorHasGas) {
          const due = typeof chain.collectable === 'function' ? await chain.collectable(launch.token) : { quote: 1n, coinsSold: 0n };
          const duePrice = due.quote > 0n ? await book.priceUsd(pair.address).catch(() => null) : null;
          const worth = due.quote > 0n && (!duePrice || unitsToUsd(due.quote, duePrice.usd, pair.decimals) >= ROBINHOOD_LAUNCH_POLICY.collection.minimumUsd);
          if (worth) { await this.send(chain, { key: collector, launchId: launch.id, kind: 'collect', to: this.config.addresses.locker, data: chain.collectData(launch.token) }); return; }
        }
        if (!keys?.fee) return; // a Creator coin's escrow share is the creator's to claim
        if (this.throttle('claim:' + launch.id, ROBINHOOD_LAUNCH_POLICY.collection.intervalMs)) return;
        const owed = await chain.escrowBalance(launch.fee_wallet, pair.native ? null : pair.address);
        if (owed === 0n) return;
        const price = await book.priceUsd(pair.address).catch(() => null);
        const usd = price ? unitsToUsd(owed, price.usd, pair.decimals) : null;
        if (usd !== null && usd < ROBINHOOD_LAUNCH_POLICY.collection.minimumUsd) return;
        if (!await this.hasGas(chain, launch, keys.fee)) return;
        await this.send(chain, { key: keys.fee, launchId: launch.id, kind: 'claim', to: this.config.addresses.escrow, data: pair.native ? chain.claimAllData(launch.fee_wallet) : chain.claimAllTokenData(pair.address, launch.fee_wallet), expected: { owed: String(owed) } });
      } catch (error) { this.retryLater('collect:' + launch.id, error, { base: 120000 }); }
    });
  }
  /** Whether a per-coin wallet can pay for its next transaction (on a non-ETH pair it lives on its gas seed). */
  async hasGas(chain, launch, wallet) {
    const balance = await chain.ethBalance(wallet.address);
    if (balance >= 2n * BigInt(ROBINHOOD_LAUNCH_POLICY.reserves.keepWei)) return true;
    if (!this.throttle('gas-alert:' + launch.id, 3600000)) this.store().addEvent({ launchId: launch.id, kind: 'gas', title: 'Fee wallet is out of gas', body: `Send a little ETH to ${wallet.address} so this coin’s option can keep running.`, isPublic: false });
    return false;
  }
  claimConfirmed(launch, op, receipt) {
    const store = this.store(), chain = this.chainInstance, role = ledgerRole(launch.mode) || 'rewards';
    let total = 0n;
    for (const claim of chain.decodeClaims(receipt.logs, launch.fee_wallet)) {
      if (store.recordFeeClaim({ launchId: launch.id, kind: 'escrow-claim', wallet: launch.fee_wallet, role, asset: claim.asset, amount: claim.amount, txHash: op.hash, logIndex: claim.logIndex, block: receipt.blockNumber })) total += claim.amount;
    }
    if (launch.mode === 'insured' && total > 0n) insuredCredit(this, store.launch(launch.id), total);
    store.addEvent({ launchId: launch.id, kind: 'fees', title: 'Creator fee share claimed', body: `${amountText(total, launch.pair_decimals)} ${launch.pair_symbol} from the fee escrow.`, txHash: op.hash, isPublic: false });
  }
  /** Sweeps: the platform wallet's claims to the treasury; an Earned coin's escrow and an Insured coin's surplus to the developer. */
  async route(chain) {
    const store = this.store(); if (!this.effective().routing) return;
    const book = await this.pairBook();
    try { await this.platformRouting(chain, book); } catch (error) { this.retryLater('platform', error, { base: 300000 }); }
    for (const launch of store.liveLaunches(this.config.addresses.poolManager).filter(l => l.fee_wallet && ['earned', 'insured'].includes(l.mode))) {
      if (this.closed) return;
      if (this.openOp(launch.id, ['sweep', 'claim']) || this.backoff('route:' + launch.id) || this.throttle('route:' + launch.id, 600000)) continue;
      try {
        const pair = this.pairOf(launch), role = ledgerRole(launch.mode), state = launch.option?.state || {};
        let amount = 0n;
        if (launch.mode === 'earned' && state.phase === 'earned') amount = store.balance(launch.id, role, pair.address).available;
        if (launch.mode === 'insured') { const held = store.balance(launch.id, role, pair.address).available, pot = state.phase === 'released' ? 0n : big(state.pot || '0') - big(state.potPaid || '0'); amount = max0(held - max0(pot)); }
        if (pair.native) amount -= 2n * BigInt(ROBINHOOD_LAUNCH_POLICY.reserves.keepWei);
        if (amount <= 0n) continue;
        const price = await book.priceUsd(pair.address).catch(() => null);
        if (price && unitsToUsd(amount, price.usd, pair.decimals) < ROBINHOOD_LAUNCH_POLICY.routing.sweepMinimumUsd) continue;
        const keys = await launchKeys(this.accounts.hostStore, launch);
        if (!await this.hasGas(chain, launch, keys.fee)) continue;
        const op = pair.native ? await this.send(chain, { key: keys.fee, launchId: launch.id, kind: 'sweep', to: launch.developer_wallet, value: amount, gasLimit: 21000, expected: { amount: String(amount), role } })
          : await this.send(chain, { key: keys.fee, launchId: launch.id, kind: 'sweep', to: pair.address, data: chain.transferData(launch.developer_wallet, amount), expected: { amount: String(amount), role } });
        store.transaction(() => { store.insertSweep({ id: newId('sw'), launchId: launch.id, kind: launch.mode, operationId: op.id, hash: op.hash, from: launch.fee_wallet, to: launch.developer_wallet, asset: pair.address, amount, state: 'pending' }); store.adjust(launch.id, role, pair.address, { debit: amount }); });
        store.addEvent({ launchId: launch.id, kind: 'fees', title: launch.mode === 'earned' ? 'Escrow released to the creator' : 'Creator share paid', body: `${amountText(amount, pair.decimals)} ${pair.symbol} sent to the creator’s wallet.`, txHash: op.hash });
      } catch (error) { this.retryLater('route:' + launch.id, error, { base: 300000 }); }
    }
  }
  async platformRouting(chain, book) {
    const store = this.store();
    if (this.openOp(HOST, ['platform-claim', 'platform-sweep']) || this.throttle('platform', 900000)) return;
    const platform = await this.hostKey('platform'), treasury = this.config.treasury;
    const owedEth = await chain.escrowBalance(platform.address, null);
    const gas = await chain.ethBalance(platform.address);
    if (owedEth > 0n && (gas >= BigInt(ROBINHOOD_LAUNCH_POLICY.reserves.keepWei) || owedEth > 10n ** 16n)) {
      const price = await book.priceUsd(ROBINHOOD_NATIVE).catch(() => null);
      if (!price || unitsToUsd(owedEth, price.usd, 18) >= ROBINHOOD_LAUNCH_POLICY.routing.platformClaimMinimumUsd) { if (gas >= BigInt(ROBINHOOD_LAUNCH_POLICY.reserves.keepWei)) { await this.send(chain, { key: platform, launchId: HOST, kind: 'platform-claim', to: this.config.addresses.escrow, data: chain.claimAllData(platform.address), expected: { owed: String(owedEth) } }); return; } }
    }
    // Pair-asset claims for each asset the platform earned in (from the launches' pairs).
    const assets = [...new Set(store.liveLaunches(this.config.addresses.poolManager).map(l => lower(l.pair_token)).filter(a => a !== ROBINHOOD_NATIVE))];
    for (const asset of assets) {
      const owed = await chain.escrowBalance(platform.address, asset);
      if (owed > 0n && gas >= BigInt(ROBINHOOD_LAUNCH_POLICY.reserves.keepWei)) { await this.send(chain, { key: platform, launchId: HOST, kind: 'platform-claim', to: this.config.addresses.escrow, data: chain.claimAllTokenData(asset, platform.address), expected: { owed: String(owed), asset } }); return; }
    }
    if (!treasury) return;
    // Sweep claimed ETH (keeping gas) and claimed pair assets to the treasury.
    const held = store.balance(HOST, 'platform', ROBINHOOD_NATIVE).available, spare = gas - 5n * BigInt(ROBINHOOD_LAUNCH_POLICY.reserves.keepWei);
    const amount = held < spare ? held : spare;
    if (amount > 10n ** 15n) {
      const op = await this.send(chain, { key: platform, launchId: HOST, kind: 'platform-sweep', to: treasury, value: amount, gasLimit: 21000, expected: { amount: String(amount) } });
      store.transaction(() => { store.insertSweep({ id: newId('sw'), launchId: HOST, kind: 'platform', operationId: op.id, hash: op.hash, from: platform.address, to: treasury, asset: ROBINHOOD_NATIVE, amount, state: 'pending' }); store.adjust(HOST, 'platform', ROBINHOOD_NATIVE, { debit: amount }); });
      return;
    }
    for (const asset of assets) {
      const balance = store.balance(HOST, 'platform', asset).available;
      if (balance > 0n && gas >= BigInt(ROBINHOOD_LAUNCH_POLICY.reserves.keepWei)) {
        const op = await this.send(chain, { key: platform, launchId: HOST, kind: 'platform-sweep', to: asset, data: chain.transferData(treasury, balance), expected: { amount: String(balance), asset } });
        store.transaction(() => { store.insertSweep({ id: newId('sw'), launchId: HOST, kind: 'platform', operationId: op.id, hash: op.hash, from: platform.address, to: treasury, asset, amount: balance, state: 'pending' }); store.adjust(HOST, 'platform', asset, { debit: balance }); });
        return;
      }
    }
  }

  // ---- holders and options (rewards.mjs) -----------------------------------------------------------------------
  async holders(chain) { return holdersPass(this, chain); }
  async options(chain) { return optionsPass(this, chain); }
  payoutThresholdUsd() { return this.config.holderPayoutUsd; }
  /** The venue's own wallets, never holders: the coin's wallets, the contracts, the pool manager (the factory's, so a
   * test stack counts too) and the burn address. */
  curveWallets(launch) { return [launch.launch_wallet, launch.fee_wallet, launch.curve, launch.token, this.config.addresses.router, this.config.addresses.locker, this.config.addresses.escrow, this.config.addresses.payouts, this.config.addresses.factory, this.factory?.poolManager, ROBINHOOD_ADDRESSES.poolManager, '0x000000000000000000000000000000000000dEaD'].filter(Boolean).map(lower); }
  /** Holders of the coin outside the venue's wallets. */
  holderCount(launch) { return this.store().holderCount(launch.id, { exclude: this.curveWallets(launch) }); }
  payoutConfirmed(chain, launch, op, receipt) {
    const store = this.store(), cycle = op.expected.cycleId ? store.rewardCycle(op.expected.cycleId) : null; if (!cycle) return;
    const result = chain.decodePayouts(receipt), batch = op.expected.batch || [], skipped = new Set(result.skipped.map(s => lower(s.to)));
    const paid = batch.filter(p => !skipped.has(lower(p.owner))).reduce((sum, p) => sum + big(p.amount), 0n);
    const nextIndex = Number(op.expected.nextIndex ?? cycle.next_index), done = nextIndex >= cycle.payouts.length;
    store.transaction(() => {
      store.updateRewardCycle(cycle.id, { next_index: nextIndex, paid: big(cycle.paid) + paid, skipped: Number(cycle.skipped || 0) + skipped.size, state: done ? 'complete' : 'frozen' });
      if (skipped.size) { const pair = this.pairOf(launch); store.adjust(launch.id, op.expected.role || 'rewards', pair.address, { credit: batch.filter(p => skipped.has(lower(p.owner))).reduce((sum, p) => sum + big(p.amount), 0n) }); }
    });
    if (done) {
      store.setCursor(launch.id, 'reward-cycle-at', this.now());
      const total = big(cycle.paid) + paid;
      store.addEvent({ launchId: launch.id, kind: 'rewards', title: 'Holder rewards paid', body: `${amountText(total, launch.pair_decimals)} ${launch.pair_symbol} to ${cycle.payouts.length - Number(cycle.skipped || 0) - skipped.size} holders.`, txHash: op.hash });
      if (launch.mode === 'diamond_hands') this.updateOption(launch, state => { state.payouts = (state.payouts || 0) + 1; state.paidWallets = (state.paidWallets || 0) + cycle.payouts.length; state.lastPayoutAt = this.now(); });
      if (launch.mode === 'insured') this.updateOption(launch, state => { state.potPaid = String(big(state.potPaid || '0') + total); });
    }
  }
  async housekeeping() {
    const store = this.store();
    if (!this.throttle('pairs-sync', 3600000)) await this.syncPairs().catch(error => this.log('robinhood-pairs-error', { error: operatorError(error) }));
    if (!this.throttle('checkpoint', 600000)) this.db?.checkpoint();
    if (!this.throttle('backup', 6 * 3600000) && this.config.backupDir) { try { this.db.backup(this.config.backupDir); } catch (error) { this.log('robinhood-launch-backup-error', { error: operatorError(error) }); } }
    // The offered pairs' prices stay warm (the picker shows them; quotes do not wait on the first fetch): every five
    // minutes while the pairs are open, every fifteen while only the owner previews them. One fetch at a time.
    const open = this.effective().pairs;
    if (!this.throttle('price-warm', open ? 300000 : 900000)) {
      const book = await this.pairBook().catch(() => null), rows = store.pairs().filter(p => p.approved && p.enabled && p.kind !== 'stable');
      if (book) for (const row of rows) { if (this.closed) return; await book.priceUsd(row.address, { maxAgeMs: 240000 }).catch(() => null); }
    }
  }

  // ---- views ----------------------------------------------------------------------------------------------------
  explorerTx(hash) { return hash ? `${ROBINHOOD_EXPLORER_URL}/tx/${hash}` : null; }
  explorerAddress(address) { return address ? `${ROBINHOOD_EXPLORER_URL}/address/${address}` : null; }
  coinUrl(launch) { return `/coin?mint=${launch.token}&chain=robinhood`; }
  dimensions(launch) {
    const live = launch.state === 'created';
    return { launch: live ? 'live' : ['failed', 'refunding', 'refunded'].includes(launch.state) ? 'failed' : launch.state, fees: launch.fee_state, venue: live ? launch.venue_state : 'none', refund: launch.refund_state };
  }
  launchView(l, { owner = false } = {}) {
    const pair = this.pairOf(l), tier = robinhoodTier(l.tier), disclosure = robinhoodDisclosure(l.mode, { pair: pair.symbol, taxBps: l.tax_bps || 0, tier: l.tier, rules: l.rules?.rules?.length || 0 });
    const view = {
      id: l.id, venue: 'robinhood', chainId: ROBINHOOD_CHAIN_ID, state: l.state, stateLabel: ROBINHOOD_STATES[l.state] || l.state, reason: l.state_reason || '', mode: l.mode, modeLabel: ROBINHOOD_MODE_LABELS[l.mode] || l.mode, paysHolders: holderPayoutActive(l),
      name: l.name, symbol: l.symbol, image: l.image, token: l.state === 'created' ? l.token : null, predictedToken: l.token, poolId: l.pool_id, coinUrl: l.state === 'created' ? this.coinUrl(l) : null, tradeLinks: l.state === 'created' ? robinhoodTradeLinks(l.token) : [], explorer: { token: l.state === 'created' ? this.explorerAddress(l.token) : null, pool: this.explorerAddress(this.config.addresses.poolManager), funding: this.explorerTx(l.funding_tx), create: this.explorerTx(l.create_tx), refund: this.explorerTx(l.refund_tx) },
      dimensions: this.dimensions(l), hashes: { funding: l.funding_tx, create: l.create_tx, refund: l.refund_tx }, devTokens: amountText(l.dev_tokens, 18), refundedEth: amountText(l.refunded_wei, 18), refundedPair: amountText(l.refunded_pair, pair.decimals),
      createdAt: l.created_at, liveAt: l.live_at, pair: { address: pair.address, symbol: pair.symbol, decimals: pair.decimals, kind: pair.kind }, tier: tier ? { id: tier.id, label: tier.label, startUsd: tier.startUsd, graduationUsd: tier.graduationUsd } : null,
      taxBps: l.tax_bps || 0, fees: this.feeView(l), rules: l.rules?.rules?.length || 0, disclosure: l.state === 'awaiting_funding' ? disclosure : [], feeLink: ROBINHOOD_FEE_LINK, venueState: l.venue_state, graduatedAt: l.graduated_at,
      option: l.option ? { kind: l.mode, settings: l.option.settings, description: describePumpOption(l.mode, l.option.settings), phase: l.option.state?.phase || null } : null,
    };
    if (!owner) return view;
    return { ...view, developerWallet: l.developer_wallet, launchWallet: l.launch_wallet, feeWallet: l.fee_wallet, canCancel: l.state === 'awaiting_funding', canFund: l.state === 'awaiting_funding' && this.now() < l.quote_expires_at, quote: this.quoteView(l), fundingTransactions: l.state === 'awaiting_funding' ? this.fundingTransactions(l) : [] };
  }
  quoteView(l) {
    const q = l.quote || {}, pair = this.pairOf(l);
    return { tier: q.tier, startUsd: q.startUsd, graduationUsd: q.graduationUsd, pairUsd: q.pairUsd, ethUsd: q.ethUsd, launchFeeEth: amountText(q.launchFeeWei || '0', 18), devBuy: amountText(q.devBuy || '0', pair.decimals), devBuySymbol: pair.symbol, gasBudgetEth: amountText(q.gasBudgetWei || '0', 18), feeWalletGasEth: amountText(q.feeWalletGasWei || '0', 18), totalEth: amountText(q.totalWei || '0', 18), totalWei: String(q.totalWei || '0'), expectedTokens: amountText(q.expectedTokens || '0', 18), sellSupply: amountText(q.sellSupply || '0', 18), lpSupply: amountText(q.lpSupply || '0', 18), expiresAt: q.expiresAt || l.quote_expires_at };
  }
  /** The coin page's panel for a Robinhood coin, by token address. */
  async coinView(token) {
    const store = await this.ready(); if (!store || !isAddress(String(token || ''))) return null;
    const l = store.launchByToken(token); if (!l || l.state !== 'created' || l.hidden) return null;
    const pair = this.pairOf(l), tier = robinhoodTier(l.tier);
    let pool = null; try { pool = JSON.parse(store.cursor(l.id, 'pool-state') || 'null'); } catch { pool = null; }
    const numbers = { virtualQuote: big(l.virtual_quote), graduationQuote: big(l.graduation_quote) }, supply = plannedSupply(ROBINHOOD_LAUNCH_POLICY.config.totalSupply, numbers.virtualQuote, numbers.graduationQuote);
    // The curve's numbers come off the pool's price and its two positions (the curve position is the curve); before the
    // first pool read the planned numbers stand in.
    const live = pool ? curveNumbers(pool) : null;
    const feeView = this.feeView(l), graduatedNow = l.venue_state === 'graduated' || !!pool?.graduated;
    // The curve maths' fee fields carry the stage's whole fee (the curve pool's before graduation, the graduation pool's after).
    const state = { ...numbers, virtualToken: supply.virtualToken, sellSupply: supply.sellSupply, realQuote: live ? live.raised : 0n, sold: live ? live.sold : 0n, tradeFeeBps: graduatedNow ? feeView.poolTotalBps : feeView.curveTotalBps, creatorTaxBps: 0, graduated: graduatedNow };
    const price = pool ? poolPrice(pool.sqrtPriceX96, pool.tokenIs0) : curvePrice({ ...state, realQuote: 0n, sold: 0n });
    const fees = store.feeTotals(l.id), paid = store.rewardPaidTotals(l.id);
    // Prices and the creator's claimable share are read live (cached briefly); a read that fails leaves them null.
    let pairUsd = null, ethUsd = null, owed = null;
    try { const book = await this.pairBook(); const [p, e] = await Promise.all([book.priceUsd(pair.address).catch(() => null), book.priceUsd(ROBINHOOD_NATIVE).catch(() => null)]); pairUsd = p?.usd ?? null; ethUsd = e?.usd ?? null; } catch { /* unpriced */ }
    const creatorRecipient = feeRecipientRole(l.mode) === 'developer' ? l.developer_wallet : l.fee_wallet;
    if (feeRecipientRole(l.mode) === 'developer') { try { owed = String(await this.cachedOwed(creatorRecipient, pair)); } catch { owed = null; } }
    return {
      venue: 'robinhood', chainId: ROBINHOOD_CHAIN_ID, id: l.id, token: l.token, routerAddress: this.config.addresses.router, name: l.name, symbol: l.symbol, image: l.image, description: l.description, links: { website: l.website || '', twitter: l.twitter || '', telegram: l.telegram || '' }, creatorId: l.account_id, mode: l.mode, modeLabel: ROBINHOOD_MODE_LABELS[l.mode], pair: { address: pair.address, symbol: pair.symbol, decimals: pair.decimals, kind: pair.kind, usd: pairUsd }, ethUsd, tier: tier ? { id: tier.id, label: tier.label, startUsd: tier.startUsd, graduationUsd: tier.graduationUsd } : null,
      contracts: { escrow: this.config.addresses.escrow, locker: this.config.addresses.locker, factory: this.config.addresses.factory, router: this.config.addresses.router, poolManager: this.config.addresses.poolManager }, explorerBase: ROBINHOOD_EXPLORER_URL, totalSupply: ROBINHOOD_LAUNCH_POLICY.config.totalSupply,
      venueState: l.venue_state, graduatedAt: l.graduated_at, poolId: l.pool_id, liveAt: l.live_at, explorer: { token: this.explorerAddress(l.token), pool: this.explorerAddress(this.config.addresses.poolManager), locker: this.explorerAddress(this.config.addresses.locker) },
      tradeLinks: robinhoodTradeLinks(l.token),
      curve: { virtualQuote: String(numbers.virtualQuote), graduationQuote: String(live ? live.fullRaise : numbers.graduationQuote), virtualToken: String(supply.virtualToken), sellSupply: String(live ? live.fullCoins : supply.sellSupply), lpSupply: String(supply.lpSupply), realQuote: String(state.realQuote), sold: String(state.sold), progressBps: live ? live.progressBps : 0, price: String(price), tradeFeeBps: state.tradeFeeBps, creatorTaxBps: state.creatorTaxBps, graduated: state.graduated, at: pool?.at || null },
      pool: pool ? { id: pool.poolId || l.pool_id, curvePoolId: l.curve_pool_id || null, sqrtPriceX96: String(pool.sqrtPriceX96), tick: pool.tick, liquidity: String(pool.liquidity), tokenIs0: pool.tokenIs0, startTick: pool.startTick, graduationTick: pool.graduationTick, curve: pool.curve, upper: pool.upper, positions: pool.positions || [], fee: pool.fee, tickSpacing: pool.tickSpacing, crossed: pool.crossed, graduated: pool.graduated, at: pool.at } : null,
      recipients: { creatorFeeRecipient: creatorRecipient, creatorClaims: feeRecipientRole(l.mode) === 'developer', owed, platformShareBps: graduatedNow ? feeView.poolShareBps : feeView.curveShareBps },
      feeShape: feeView,
      fees: { claimed: Object.fromEntries(Object.entries(fees).map(([k, v]) => [k, amountText(v, k.endsWith(ROBINHOOD_NATIVE) ? 18 : pair.decimals)])), paidToHolders: amountText(paid[lower(pair.address)] || '0', pair.decimals), paidSymbol: pair.symbol },
      rules: l.rules ? l.rules.rules.map(r => ({ kind: r.kind, params: r.p })) : [], taxBps: l.tax_bps || 0,
      option: l.option ? { kind: l.mode, settings: l.option.settings, description: describePumpOption(l.mode, l.option.settings), state: this.publicOptionState(l) } : null,
      holderRewards: holderPayoutActive(l) ? { thresholdUsd: this.payoutThresholdUsd(), held: amountText(this.payoutHeld(l), pair.decimals), symbol: pair.symbol, cycles: store.rewardCycles(l.id, 5).map(c => cycleView(this, l, c)), streaks: l.mode === 'diamond_hands' ? store.topStreaks(l.id, 10) : null } : null,
      holders: this.holderCount(l), trades: store.trades(l.id, 30).map(t => ({ side: t.side, wallet: t.wallet, quote: amountText(t.quote, pair.decimals), tokens: amountText(t.tokens, 18), tx: t.tx_hash, block: t.block, at: t.at, price: t.sqrt_price && t.sqrt_price !== '0' ? String(poolPrice(t.sqrt_price, pool ? pool.tokenIs0 : lower(l.token) < lower(l.pair_token))) : null })),
      priceHistory: store.priceHistory(l.id, 500).filter(t => t.sqrt_price && t.sqrt_price !== '0').map(t => ({ at: t.at, block: t.block, price: String(poolPrice(t.sqrt_price, pool ? pool.tokenIs0 : lower(l.token) < lower(l.pair_token))) })), events: store.events(l.id, { limit: 20 }),
    };
  }
  /** The escrow balance owed to a creator wallet, cached for 20 s per coin page read. */
  async cachedOwed(recipient, pair) {
    this.owedCache ||= new Map(); const key = lower(recipient) + '|' + lower(pair.address), hit = this.owedCache.get(key);
    if (hit && this.now() - hit.at < 20000) return hit.value;
    const chain = await this.chain(), value = await chain.escrowBalance(recipient, pair.native ? null : pair.address);
    this.owedCache.set(key, { at: this.now(), value }); if (this.owedCache.size > 500) this.owedCache.delete(this.owedCache.keys().next().value);
    return value;
  }
  /** A launch's fee numbers for the pages (public/robinhood-launch-catalog.mjs robinhoodFeesFor): both stages, in bps. */
  feeView(l) {
    const f = robinhoodFeesFor(l.tax_bps || 0);
    return { ...f, stage: l.venue_state === 'graduated' ? 'pool' : 'curve', curveFeePips: l.curve_fee || f.curveTotalBps * 100, poolFeePips: l.pool_fee || f.poolTotalBps * 100, creatorShape: !(l.tax_bps > 0), curvePoolId: l.curve_pool_id || null };
  }
  publicOptionState(l) {
    const s = l.option?.state || {};
    if (l.mode === 'earned') return { phase: s.phase, baseline: s.baseline ? amountText(s.baseline, l.pair_decimals) : null, floor: s.floor ? amountText(s.floor, l.pair_decimals) : null, latest: s.latest ? { at: s.latest.at, marketCap: amountText(s.latest.marketCap, l.pair_decimals) } : null, probationEndsAt: s.probationEndsAt, checks: (s.checks || []).slice(-10).map(c => ({ at: c.at, marketCap: amountText(c.marketCap, l.pair_decimals), ok: c.ok })) };
    if (l.mode === 'insured') return { phase: s.phase, pot: amountText(s.pot || '0', l.pair_decimals), potPaid: amountText(s.potPaid || '0', l.pair_decimals), deadlineAt: s.deadlineAt };
    if (l.mode === 'diamond_hands') return { payouts: s.payouts || 0, paidWallets: s.paidWallets || 0, skippedWallets: s.skippedWallets || 0, lastPayoutAt: s.lastPayoutAt || null };
    return null;
  }
  payoutHeld(launch) { const role = ledgerRole(launch.mode) || 'rewards'; return max0(this.store().balance(launch.id, role, launch.pair_token).available); }
  async ready() { if (!this.available()) return null; return this.ensure(); }
  /** Public discovery row (explore / coin lists): identity, pair, venue and option, no wallets or keys. */
  publicRow(l) {
    const pair = this.pairOf(l), tier = robinhoodTier(l.tier);
    return { platform: 'robinhood', chain: 'robinhood', status: l.venue_state === 'graduated' ? 'graduated' : 'trading', id: l.id, creatorId: l.account_id, mint: l.token, token: l.token, venue: this.config.addresses.poolManager, name: l.name, symbol: l.symbol, description: l.description, image: l.image, createdAt: l.live_at || l.created_at, mode: l.mode, poolId: l.pool_id, tradeLinks: robinhoodTradeLinks(l.token),
      option: l.option ? { kind: l.mode, phase: l.option.state?.phase || 'pending' } : null, quoteMint: pair.address, quoteSymbol: pair.symbol, quoteDecimals: pair.decimals, quoteName: pair.kind === 'native' ? 'Ether' : pair.symbol, quoteCategory: pair.kind, creatorFeeBps: l.tax_bps > 0 ? 0 : ROBINHOOD_FEES.curveCreatorBps, taxBps: l.tax_bps || 0, postGradCreatorFeeBps: l.tax_bps > 0 ? 0 : ROBINHOOD_FEES.poolCreatorBps, tier: tier?.id || l.tier, rules: l.rules?.rules?.length || 0, coinUrl: this.coinUrl(l), explorer: this.explorerAddress(l.token) };
  }
  /**
   * The live numbers Explore shows for a coin, from the last pool reading and the trade journal (no RPC): the price and
   * market cap in USD (when the pair is priced), the curve's progress, the day's volume and buys, the latest buy, holders.
   */
  liveNumbers(l, prices) {
    const store = this.store(), pair = this.pairOf(l);
    let pool = null; try { pool = JSON.parse(store.cursor(l.id, 'pool-state') || 'null'); } catch { pool = null; }
    const usd = pair.kind === 'stable' ? '1' : prices?.get?.(lower(pair.address))?.usd ?? null, supply = ROBINHOOD_LAUNCH_POLICY.config.totalSupply;
    const price = pool ? poolPrice(pool.sqrtPriceX96, pool.tokenIs0) : null, live = pool ? curveNumbers(pool) : null;
    const priceUsd = price !== null && usd ? unitsToUsd(price, usd, pair.decimals) : null;
    const window = store.tradeWindow(l.id, this.now() - 86400000);
    return {
      priceUsd, marketCapUsd: priceUsd !== null ? priceUsd * Number(BigInt(supply) / 10n ** 18n) : null, priceQuote: price !== null ? Number(price) / 10 ** pair.decimals : null,
      progressPercent: l.venue_state === 'graduated' ? 100 : live ? live.progressBps / 100 : 0, graduated: l.venue_state === 'graduated',
      volume24hQuote: window.volume ? Number(window.volume) / 10 ** pair.decimals : 0, volume24hUsd: usd && window.volume ? Number(window.volume) / 10 ** pair.decimals * Number(usd) : null,
      buys24h: window.buys, sells24h: window.sells, lastBuyAt: window.lastBuyAt, holders: this.holderCount(l), marketAt: pool?.at || null, quoteUsd: usd,
    };
  }
  async publicList() {
    const store = await this.ready(); if (!store) return [];
    let prices = null; try { prices = (await this.pairBook()).prices; } catch { prices = null; }
    return store.liveLaunches(this.config.addresses.poolManager).filter(l => !l.hidden).map(l => ({ ...this.publicRow(l), live: this.liveNumbers(l, prices), quoteLogo: this.logoPath(store.pair(l.pair_token)) }));
  }

  // ---- admin ----------------------------------------------------------------------------------------------------
  async adminOverview(actorId, { offset = 0, limit = 25, search = '', state = '', mode = '', archived = false } = {}) {
    if (!this.available()) return { available: false, configured: false, reason: 'Robinhood launches are disabled on this host. Set LAUNCHPAD_ROBINHOOD_LAUNCH_ENABLED=1 and the contract addresses in /etc/launchpad.env and restart.', flags: {}, rows: [], total: 0, offset: 0, limit: 25, pairs: [], counts: {} };
    const store = await this.ensure();
    let factory = null, factoryError = '';
    try { factory = await this.factoryState(); } catch (error) { factoryError = operatorError(error); }
    const wallets = await this.hostWallets();
    const balances = {};
    try { const chain = await this.chain(); balances.owner = amountText(await chain.ethBalance(wallets.owner), 18); balances.platform = amountText(await chain.ethBalance(wallets.platform), 18); balances.platformEscrow = amountText(await chain.escrowBalance(wallets.platform, null), 18); } catch { /* shown as unknown */ }
    const all = store.launchesForReview({ exceptStates: ABANDONED, recent: 50 }).filter(l => archived ? l.archived : !l.archived);
    const needle = search.trim().toLowerCase();
    const rows = all.filter(l => (!needle || [l.name, l.symbol, l.token, l.id, l.developer_wallet].some(v => String(v || '').toLowerCase().includes(needle))) && (!state || l.state === state) && (!mode || l.mode === mode));
    const start = Math.max(0, Number(offset) || 0), size = Math.min(100, Math.max(1, Number(limit) || 25));
    return {
      available: this.available(), configured: this.configured(), flags: this.flags(), effective: this.effective(), policy: { version: ROBINHOOD_LAUNCH_POLICY.version, hash: ROBINHOOD_LAUNCH_POLICY_HASH, tiers: ROBINHOOD_LAUNCH_POLICY.tiers }, contracts: this.config.addresses, treasury: this.config.treasury || null,
      host: { ...wallets, balances }, factory: factory ? { owner: factory.owner, pendingOwner: factory.pendingOwner, ownerIsHost: lower(factory.owner) === lower(wallets.owner), launchesOpen: factory.launchesOpen, launchFee: amountText(factory.launchFee, 18), platformRecipient: factory.platformRecipient, platformIsHost: lower(factory.platformRecipient) === lower(wallets.platform), config: factory.config, blockers: this.factoryBlockers(factory) } : null, factoryError,
      pairs: store.pairs().map(p => ({ ...p, address: checksumAddress(p.address), logo: this.logoPath(p), source: p.logo || null })), pairRequests: this.pairRequests(), lastPassAt: this.lastPassAt, lastError: this.lastError, passes: this.passes, db: { version: this.db?.version(), ok: this.db?.integrity() },
      counts: Object.fromEntries(Object.keys(ROBINHOOD_STATES).map(s => [s, all.filter(l => l.state === s).length])), total: rows.length, offset: start, limit: size, rows: rows.slice(start, start + size).map(l => this.adminRow(l)),
    };
  }
  adminRow(l) {
    const store = this.store(), pair = this.pairOf(l);
    const legacy = l.state === 'created' && !!l.curve && lower(l.curve) !== lower(this.config.addresses.poolManager);
    return { ...this.launchView(l, { owner: true }), accountId: l.account_id, hidden: l.hidden, archived: l.archived, legacy, createAttempts: l.create_attempts, balances: store.balances(l.id).map(b => ({ role: b.role, asset: b.asset, available: amountText(b.available, lower(b.asset) === ROBINHOOD_NATIVE ? 18 : pair.decimals), credited: amountText(b.credited, lower(b.asset) === ROBINHOOD_NATIVE ? 18 : pair.decimals) })),
      openOperations: store.openOperations(l.id).map(op => ({ id: op.id, kind: op.kind, state: op.state, hash: op.hash, attempts: op.attempts, error: op.error, createdAt: op.created_at })), events: store.events(l.id, { publicOnly: false, limit: 15 }), holderPayout: payoutView(this, l), feeClaims: store.feeClaims(l.id, 10).map(c => ({ kind: c.kind, role: c.role, amount: amountText(c.amount, lower(c.asset) === ROBINHOOD_NATIVE ? 18 : pair.decimals), tx: c.tx_hash, block: c.block })), holders: this.holderCount(l) };
  }
  async adminControl(actorId, { flags, launchId, action, reason, address, addresses, value } = {}) {
    const store = await this.ensure(), by = String(actorId || 'owner'), why = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
    if (flags && typeof flags === 'object') {
      if (why.length < 5) fail('Give a reason of at least five characters.');
      for (const [name, enabled] of Object.entries(flags)) { if (!Object.hasOwn(DEFAULT_FLAGS, name)) fail(`Unknown flag ${name}.`); store.setFlag(name, !!enabled, { reason: why, by }); }
      return { ok: true, flags: this.flags(), effective: this.effective() };
    }
    const chain = await this.chain();
    switch (action) {
      case 'sync-pairs': return { ok: true, pairs: await this.syncPairs({ force: true }) };
      case 'enable-pair': case 'disable-pair': { if (!isAddress(String(address || ''))) fail('Choose a pair.'); if (!store.pair(address)) fail('Unknown pair.'); store.setPairState(address, { enabled: action === 'enable-pair', updatedBy: by }); return { ok: true, pairs: store.pairs() }; }
      case 'approve-pairs': return this.approvePairs(chain, Array.isArray(addresses) ? addresses : address ? [address] : [], by);
      case 'add-pair': return this.addCustomPair(address, by);
      case 'remove-pair': return this.removeCustomPair(address, by);
      case 'dismiss-pair-request': { if (!isAddress(String(address || ''))) fail('Choose a request.'); store.deleteCursor(HOST, 'pair-request:' + lower(address)); return { ok: true, requests: this.pairRequests() }; }
      case 'set-launches-open': return this.ownerTx(chain, chain.setLaunchesOpenData(!!value), 'launches ' + (value ? 'opened' : 'closed'));
      case 'set-launch-fee': { let fee; try { fee = parseUnits(String(value ?? ''), 18); } catch { fail('Enter the launch fee in ETH.'); } return this.ownerTx(chain, chain.setLaunchFeeData(fee), `launch fee ${amountText(fee, 18)} ETH`); }
      case 'accept-ownership': return this.ownerTx(chain, chain.acceptOwnershipData(), 'ownership accepted');
      case 'set-platform-recipient': { const platform = await this.hostKey('platform'); return this.ownerTx(chain, chain.setPlatformRecipientData(platform.address), 'platform recipient set to the host wallet'); }
      case 'graduate': { const launch = this.requireLaunch(launchId); const owner = await this.hostKey('owner'); const op = await this.send(chain, { key: owner, launchId: launch.id, kind: 'graduate', to: this.config.addresses.locker, data: chain.graduateData(launch.token) }); return { ok: true, operation: op.id, hash: op.hash }; }
      case 'collect': { const launch = this.requireLaunch(launchId); const owner = await this.hostKey('owner'); const op = await this.send(chain, { key: owner, launchId: launch.id, kind: 'collect', to: this.config.addresses.locker, data: chain.collectData(launch.token) }); return { ok: true, operation: op.id, hash: op.hash }; }
      case 'pay-holders': { const launch = this.requireLaunch(launchId); if (!holderPayoutActive(launch)) fail('This coin does not pay holders.'); store.setCursor(launch.id, 'holder-payout-request', JSON.stringify({ at: this.now(), by, reason: why })); this.kick(); return { ok: true }; }
      case 'hide': case 'unhide': { const launch = this.requireLaunch(launchId); store.updateLaunch(launch.id, { hidden: action === 'hide' }); store.addEvent({ launchId: launch.id, kind: 'moderation', title: action === 'hide' ? 'Hidden from the public' : 'Shown again', body: why, isPublic: false }); return { ok: true }; }
      case 'archive': case 'unarchive': { const launch = this.requireLaunch(launchId); if (action === 'archive' && !['failed', 'refunded', 'expired', 'cancelled'].includes(launch.state)) fail('Only a finished failure can be archived.'); store.updateLaunch(launch.id, { archived: action === 'archive' }); return { ok: true }; }
      case 'refund': { const launch = this.requireLaunch(launchId); if (!['funded', 'creating'].includes(launch.state)) fail('Only a funded launch that has not been created can be refunded.'); await this.failLaunch(chain, launch, why || 'Refunded by the operator.'); this.kick(); return { ok: true }; }
      case 'retry': { const launch = this.requireLaunch(launchId); this.retry.delete('create:' + launch.id); this.retry.delete('refund:' + launch.id); this.retry.delete('collect:' + launch.id); this.kick(); return { ok: true }; }
      default: fail('Unknown action.');
    }
  }
  requireLaunch(launchId) { const launch = this.store().launch(String(launchId || '')); if (!launch) fail('Launch not found.', 404); return launch; }
  async ownerTx(chain, data, what, { kind = 'owner', expected = {} } = {}) {
    const owner = await this.hostKey('owner'), factory = await this.factoryState({ fresh: true });
    if (lower(factory.owner) !== lower(owner.address) && !(what === 'ownership accepted' && lower(factory.pendingOwner) === lower(owner.address))) fail(`The factory owner is ${factory.owner}, not the host wallet ${owner.address}.`, 409);
    if ((await chain.ethBalance(owner.address)) < 10n ** 14n) fail(`The host owner wallet ${owner.address} needs ETH for gas.`, 409);
    const op = await this.send(chain, { key: owner, launchId: HOST, kind, to: this.config.addresses.factory, data, expected: { ...expected, what } });
    return { ok: true, operation: op.id, hash: op.hash, what };
  }
  /** Approves pairs on chain with the default tier at today's price and the policy's bounds: owner transactions of up
   * to 40 pairs each (a pair whose price cannot be read is left out and named). */
  async approvePairs(chain, list, by) {
    const store = this.store(), book = await this.pairBook();
    const wanted = list.map(a => String(a)).filter(a => isAddress(a)).map(a => store.pair(a)).filter(Boolean);
    if (!wanted.length) fail('Choose at least one listed pair.');
    const tier = tierById(ROBINHOOD_LAUNCH_POLICY.tiers[1].id), pairs = [], assets = [], skipped = [];
    for (const p of wanted) {
      let price; try { price = await book.priceUsd(p.address); if (price.halted) throw Error('halted'); } catch (error) { skipped.push(`${p.symbol}: ${operatorError(error)}`); continue; }
      const targets = tierTargetsInPair(tier, price.usd, p.decimals), numbers = curveForTargets(targets.startFdv, targets.graduationFdv);
      pairs.push(checksumAddress(p.address));
      assets.push({ approved: true, virtualQuote: numbers.virtualQuote, graduationQuote: numbers.graduationQuote, minGraduationQuote: numbers.graduationQuote * 500n / 10000n, maxGraduationQuote: numbers.graduationQuote * 100000n / 10000n });
    }
    if (!pairs.length) fail('No pair could be priced: ' + skipped.join('; '));
    const operations = [];
    for (let i = 0; i < pairs.length; i += 40) {
      const slice = pairs.slice(i, i + 40), result = await this.ownerTx(chain, chain.setPairAssetsData(slice, assets.slice(i, i + 40)), `${slice.length} pair(s) approved`, { kind: 'pairs', expected: { pairs: slice.map(lower) } });
      operations.push(result.operation); for (const address of slice) store.setPairState(address, { enabled: true, updatedBy: by });
    }
    return { ok: true, operation: operations[0], operations, pairs: pairs.length, skipped, what: `${pairs.length} pair(s) approved in ${operations.length} transaction(s)` + (skipped.length ? `; skipped ${skipped.join('; ')}` : '') };
  }
  /** The admin's cross-venue launch inventory (Token moderation tab): live Robinhood coins with visibility only. */
  async adminInventory(actorId) {
    if (!this.available()) return [];
    const store = await this.ensure(), people = typeof this.accounts?.list === 'function' ? await this.accounts.list() : [], byId = new Map(people.map(a => [a.id, a]));
    return store.launchesWhere({ states: ['created'] }).map(l => {
      const account = { id: l.account_id, username: String(byId.get(l.account_id)?.username || '').slice(0, 32) };
      return { account, adminRow: this.moderationRow(l, account), launch: { id: l.id, createdAt: l.live_at || l.created_at, state: l.state, input: { route: 'robinhood', network: 'robinhood', name: l.name, symbol: l.symbol, recipient: l.developer_wallet, feeMode: l.mode, quoteMint: l.pair_token, quoteSymbol: l.pair_symbol }, review: { quoteSymbol: l.pair_symbol, quoteDecimals: l.pair_decimals }, keys: { mint: { address: l.token }, wallet: { address: l.launch_wallet } }, moderation: { hidden: !!l.hidden }, listArchive: { archived: false } } };
    });
  }
  moderationRow(l, account) {
    const hidden = !!l.hidden, unavailable = 'Robinhood Chain coins are run by the Robinhood launch service; manage them in the Robinhood tab. Only visibility is changed here.';
    return { route: 'robinhood', platform: 'robinhood', chain: 'robinhood', accountId: l.account_id, username: account.username, id: l.id, mint: l.token, network: 'robinhood', name: String(l.name || '').slice(0, 100), symbol: String(l.symbol || '').slice(0, 24), createdAt: l.live_at || l.created_at, state: l.state,
      hidden, manuallyArchived: false, listArchived: hidden, canArchive: false, canRestore: false, archiveReason: hidden ? 'This coin is hidden from public lists. An administrator can restore its visibility.' : 'This token was created. Live tokens can be hidden from public lists by an administrator.', archiveAt: null,
      quoteMint: l.pair_token, quoteSymbol: l.pair_symbol, recipient: l.developer_wallet, feeMode: l.mode, feeCustody: 'program', feeWallet: '', rewardsWallet: null,
      eligibility: { allowed: false, reason: unavailable }, rewardsAction: { kind: null, allowed: false, reason: unavailable, busy: false, autoFees: false }, rewardsAutomation: { allowed: false, enabled: false, reason: unavailable, pending: false, needed: false },
      serviceError: '', serviceStage: '', pendingOperation: null, rewardRetry: null, deferredRewards: { wallets: 0, amount: '0' }, credits: { quote: null, base: null }, rewardHistory: [], history: [] };
  }
  async adminVisibility(actorId, { id, mint, hidden, reason } = {}) {
    const store = await this.ensure(), launch = id ? store.launch(String(id)) : mint ? store.launchByToken(String(mint)) : null;
    if (!launch) fail('Launch not found.', 404);
    store.updateLaunch(launch.id, { hidden: !!hidden }); store.addEvent({ launchId: launch.id, kind: 'moderation', title: hidden ? 'Hidden from the public' : 'Shown again', body: String(reason || '').slice(0, 300), isPublic: false });
    return { ok: true, hidden: !!hidden };
  }
  async verifyKeys() {
    const store = await this.ensure(); let ok = 0, bad = [];
    for (const l of store.launchesWhere({ exceptStates: ABANDONED })) { try { await launchKeys(this.accounts.hostStore, l); ok++; } catch (error) { bad.push({ id: l.id, error: operatorError(error) }); } }
    await this.hostWallets();
    return { ok, bad, host: true };
  }
  async backup() { await this.ensure(); if (!this.config.backupDir) fail('Set LAUNCHPAD_RH_BACKUP_DIR to take backups.'); return { ok: true, file: this.db.backup(this.config.backupDir) }; }
  /** Revenue sources for the admin revenue report: platform claims from the escrow (ETH and pair assets). */
  /** Platform-share claims for the admin revenue report: one row per escrow claim by the platform wallet, in the asset received. */
  revenueSources() {
    const store = this.rhStore; if (!store) return { complete: true, sources: [] };
    const pairs = new Map(store.pairs().map(p => [lower(p.address), p]));
    return { complete: true, sources: store.feeClaims(HOST, 5000).filter(c => c.role === 'platform').map(c => { const pair = pairs.get(lower(c.asset)); return { kind: 'platform-share', venue: 'robinhood', asset: c.asset, decimals: lower(c.asset) === ROBINHOOD_NATIVE ? 18 : pair?.decimals ?? 18, symbol: lower(c.asset) === ROBINHOOD_NATIVE ? 'ETH' : pair?.symbol || 'PAIR', amount: String(c.amount), tx: c.tx_hash, logIndex: c.log_index, block: c.block, at: c.created_at }; }) };
  }
}
export { ROBINHOOD_HOLDER_MODES, samplesHolders, holderPayoutActive };
