// Pump.fun Classic service: the one durable authority for native Pump.fun
// launches made through Launchpad.
//
// Lifecycle: quote (keys provisioned, metadata bound, policy hashed) →
// developer-signed funding (memo-bound transfer to the per-coin launch wallet,
// proving the delivery wallet) → atomic creation (create_v2, fee sharing with
// the admin revoked, exact dev buy delivered, Launchpad wallets funded) → refund
// of the unused remainder. Live coins then run fee collection, an append-only
// receipt journal, per-option routing, Launchpad-run holder rewards and the two
// managed strategies. Every signed transaction is journaled before broadcast
// and every money movement is reconciled from a finalized receipt.
//
// Pairs (v71.19): a coin pairs with SOL or any quote asset Pump.fun admits for
// new coins (its listed quote and custom pairs). On another pair fee shares
// arrive in that asset. Launchpad converts the platform and Gotchi shares it holds
// to SOL through the treasury's verified route before routing them; from
// v71.24 holder rewards are paid in the pair asset itself (see holders()).
import { join } from 'node:path';
import { createHash, randomBytes, generateKeyPairSync } from 'node:crypto';
import { launchpadEnv } from '../brand-env.mjs';
import { acquireProcessLock } from '../process-lock.mjs';
import { openPumpClassicDatabase, PumpClassicStore, newId } from './store.mjs';
import { PUMP_CLASSIC_POLICY, PUMP_CLASSIC_POLICY_HASH, policyFor, validMode, isStrategyMode, shareholdersFor, fundingPlan, quotePairAllowed, pairDevBuyInSol, platformShareBps, solOnlyText } from './policy.mjs';
import { knownQuoteAsset, quoteLabel } from '../../public/quote-identity.mjs';
import { PUMP_CLASSIC_MODES, PUMP_CLASSIC_MODE_LABELS, PUMP_CLASSIC_STATES, PUMP_CLASSIC_STRATEGY_STATES, PUMP_CLASSIC_LIMITS, PUMP_CLASSIC_FEE_LINK, PUMP_CLASSIC_HOLDER_MODES, PUMP_CLASSIC_OPTION_MODES, pumpClassicDisclosure } from '../../public/pump-classic-catalog.mjs';
import { pumpOptionRequest, describePumpOption, diamondMultiplierBps, diamondCapStreak, earnedFloor, earnedProbationEnd, insuredPotShare, insuredDeadline, insuredGraduationTarget } from '../../public/pump-option-catalog.mjs';
import { basketLaunchRequest, basketShares, describeBasket } from '../../public/basket-catalog.mjs';
import { valueOf } from './math.mjs';
import { base58Encode, base58Decode, isAddress, isOnCurve } from './codec.mjs';
import { coinAddresses } from './instructions.mjs';
import { coinText, coinLink } from './coin-text.mjs';
import { marketMakerDecision, applyTrade, lpPlan, curvePrice, poolPrice, lpValue, performance, observedStatus } from './strategy.mjs';
import { ammFeeBps, curveTokensForQuote } from './math.mjs';
import { agentLaunchRequest } from '../../public/launchpad-model.mjs';
import { AGENT_MODE } from '../../public/agent-catalog.mjs';
import { rewardWindow, minimumBalances, topHolders, allocateRewards } from '../agent/holders.mjs';
import { requireTenantLaunch } from '../tenant/gate.mjs';
import { padCheck } from '../tenant/pad.mjs';

const SOL = 'So11111111111111111111111111111111111111112', SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const KEY_PREFIX = 'pump-classic-keys-', LOCK = 'pump-classic.lock', CLOSE_GRACE_MS = 5000;
// Defaults apply only to flags the owner never set. From v71.24 creator-fee collection, sweeps and holder payouts run
// unless switched off in Admin → Pump.fun; new launches, other pairs and strategy trading still start off.
const DEFAULT_FLAGS = Object.freeze({ intake: false, pairs: false, collection: true, routing: true, holders: true, strategies: false });
const FLAG_LABELS = Object.freeze({ intake: 'New launches and coin creation', pairs: 'Launches on pairs other than SOL (the platform owner can preview them while this is off)', collection: 'Creator-fee collection', routing: 'Sweeps to the treasury, Gotchi pots and agents (and converting those shares to SOL on other pairs)', holders: 'Holder reward payouts (in the coin’s pair asset; on other pairs a small part is sold for new holder accounts and network fees)', strategies: 'Market Maker and Liquidity Manager trading' });
/**
 * Holder payouts (v71.24). A Holders coin pays its holders in its pair asset: SOL on a SOL coin, the pair's asset
 * (for example AMD) on another pair, never converted to SOL first. On another pair Launchpad sells only enough of it
 * for the token accounts new recipients need and the payout's network fees. A payout starts by itself once the
 * holders' share (collected, plus their share of fees still pending at Pump.fun) is worth `holderPayoutUsd`
 * (100 USD unless the operator sets LAUNCHPAD_PUMP_CLASSIC_HOLDER_PAYOUT_USD), checked every few minutes and at most
 * once per cycle interval, or when an administrator asks (Sell & distribute all, Distribute SOL rewards, Pay
 * holders now). Each payout collects the pending fees first, then freezes the top holders by minimum balance over
 * the last hour and pays them four at a time.
 */
const HOLDER_PAYOUT_USD = 100, PAYOUT_CHECK_MS = 5 * 60000, PAYOUT_RECORD_WAIT_MS = 10 * 60000, PAYOUT_GAS_ATTEMPTS = 3;
// After an automatic payout ends without paying anyone, the trigger waits a cycle interval (six hours after a blocked
// one) before starting another; and a coin sells for payout costs at most this many times a day.
const PAYOUT_BLOCKED_WAIT_MS = 6 * 3600000, PAYOUT_SALES_PER_DAY = 6;
// Payout costs on another pair: each batch's network fee (with headroom), a recipient without a token account for the
// pair asset needs a payout worth at least this many times the account's rent, and the sale covers the estimate plus
// this margin. The wallet's own reserve (policy routing.keepLamports) always stays.
const PAYOUT_BATCH_FEE_LAMPORTS = 20000n, NEW_ACCOUNT_VALUE_MULTIPLE = 3n, PAYOUT_COST_MARGIN_BPS = 1000n, PAYOUT_COST_FLOOR_LAMPORTS = 2000000n, PAYOUT_SALE_HEADROOM_LAMPORTS = 1000000n;
// SOL a pair Holders wallet keeps beyond its reserve, so it can always run the next small sale.
const PAYOUT_SALE_FLOAT_LAMPORTS = 3000000n;
// A token payout batch may create up to four recipient accounts: their rent plus the fee stay under this limit.
const TOKEN_PAYOUT_MAX_COST_LAMPORTS = '15000000';
const HOLDERS_OFF = 'Holder reward payouts are switched off in Admin → Pump.fun.';
const OPEN = ['signed', 'submitted', 'unknown'];
/** An RPC that lags or load-balances (an unknown blockhash, a context below the asked slot, an omitted field): retried, never counted as a failed check. */
const rpcLag = error => ['PUMP_CLASSIC_RPC', 'LAUNCH_BLOCKHASH_EXPIRED', -32016].includes(error?.code) || error?.launchCode === 'LAUNCH_RPC_CONTEXT_LAG' || /BlockhashNotFound|blockhash not found|minimum context slot/i.test(String(error?.message));
/**
 * A pair purchase that retrying cannot fix soon: no route, or one outside the
 * policy's limits; a failed simulation; a purchase over its budget or reserve; a
 * pair asset Launchpad cannot hold. These count toward the policy's purchase tries,
 * after which the launch is refunded in SOL. Every other failure (the network,
 * the RPC, the swap provider or its configuration) waits, at most
 * PAIR_PURCHASE_MAX_WAITS times with backoff (about three hours), so a launch is
 * never kept waiting for a day.
 */
const PERMANENT_PURCHASE_CODES = ['SOL_ROUTE_NOT_FOUND', 'TREASURY_PRICE_IMPACT', 'TREASURY_SLIPPAGE_LIMIT', 'TREASURY_INVALID_IMPACT', 'TREASURY_ROUTE_TOO_LARGE', 'PUMP_CLASSIC_SLIPPAGE', 'PUMP_CLASSIC_CONVERSION'];
const permanentPurchaseError = error => {
  if (rpcLag(error)) return false;
  const message = String(error?.message || '');
  return PERMANENT_PURCHASE_CODES.includes(error?.code) || /simulation failed/i.test(message)
    || (/^(?:The treasury|A treasury|A managed treasury|Treasury|The SOL route|The SOL conversion|The prepared purchase|The launch funding|Only a dev buy|Invalid dev-buy|Duplicate treasury)/.test(message) && !/expired|RPC/i.test(message));
};
const PAIR_PURCHASE_MAX_WAITS = 24;
// Swaps prepared per worker pass. A swap waits for finalization (about 13 s), and
// the pass holds the lock admin actions take, so passes stay short.
const SWAPS_PER_PASS = 1;
// A retired strategy's wallet keeps this when its SOL is returned: it stays a rent-exempt fee shareholder.
const STRATEGY_WALLET_RESERVE = 1000000n;
// A vanity address may replace the quoted one only while the launch is unfunded and unlisted.
const VANITY_SWITCHABLE = ['awaiting_funding', 'funding_pending'];
// A launch in one of these states can never create its coin; its vanity address may go back to the pool after a day without activity.
const VANITY_RETURNABLE = ['failed', 'refunded', 'expired', 'cancelled'], VANITY_RETURN_AFTER_MS = 24 * 3600000;
// Launches agents may bind to: funded or later (the coin address is final by then).
const UNFUNDED = ['draft', 'awaiting_funding', 'funding_pending', 'expired', 'cancelled'];
// SOL kept in a launch wallet when an operator releases the SOL refund before the pair asset could be returned,
// so the pair refund can still open the developer's token account and pay its fee later.
const PAIR_REFUND_RESERVE = 3000000n;
const fail = (message, statusCode = 400, code = 'PUMP_CLASSIC') => { throw Object.assign(Error(message), { statusCode, code }); };
const publicFailure = message => Object.assign(Error(message), { pumpClassicPublic: true });
const big = value => typeof value === 'bigint' ? value : BigInt(String(value ?? '0'));
const max0 = value => value > 0n ? value : 0n;
const minBig = (a, b) => a < b ? a : b;
const sha = value => createHash('sha256').update(value).digest('hex');
const jsonable = value => JSON.parse(JSON.stringify(value ?? null, (key, v) => typeof v === 'bigint' ? v.toString() : v));
const bool = value => value === '1' || value === 'true' || value === 'yes';
const validSignature = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(value);
const LAMPORTS = 1000000000n;
// Same shape check as agent/launches.mjs, kept local so this module stays free of web3.js.
const validAgentAttachment = value => !!value && value.version === 1 && value.mode === AGENT_MODE && /^[a-f0-9]{24}$/.test(value.id || '') && isAddress(value.wallet) && /^[a-f0-9]{64}$/.test(value.policyHash || '') && Number.isInteger(value.capabilities) && value.capabilities > 0 && typeof value.model === 'string' && value.model.length > 0;
/** Raw 6-decimal token units as whole tokens for public event text. */
const wholeTokens = raw => { const n = big(raw), whole = n / 1000000n, frac = (n % 1000000n).toString().padStart(6, '0').slice(0, 2).replace(/0+$/, ''); return whole.toLocaleString('en-US') + (frac ? '.' + frac : ''); };
export const sol = lamports => { const n = big(lamports), sign = n < 0n ? '-' : '', v = n < 0n ? -n : n, whole = v / LAMPORTS, frac = (v % LAMPORTS).toString().padStart(9, '0').replace(/0+$/, ''); return sign + whole.toString() + (frac ? '.' + frac : ''); };
export function lamportsFromSol(value, label) {
  const text = String(value ?? '0').trim();
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,9})?$/.test(text)) fail(`Enter ${label} as a SOL amount with up to 9 decimals.`);
  const [whole, fraction = ''] = text.split('.'); return BigInt(whole) * LAMPORTS + BigInt((fraction + '000000000').slice(0, 9));
}
/** A decimal amount of a quote asset as raw units (at most `decimals` places). */
export function rawFromAmount(value, decimals, label, symbol) {
  const text = String(value ?? '0').trim() || '0', places = Number(decimals);
  if (!Number.isSafeInteger(places) || places < 0 || places > 12) fail('This pair has invalid decimals.');
  const pattern = places > 0 ? new RegExp(`^(?:0|[1-9]\\d{0,14})(?:\\.\\d{1,${places}})?$`) : /^(?:0|[1-9]\d{0,14})$/;
  if (!pattern.test(text)) fail(places ? `Enter ${label} as ${symbol ? 'a ' + symbol : 'an'} amount with up to ${places} decimals.` : `Enter ${label} as a whole number${symbol ? ' of ' + symbol : ''}.`);
  const [whole, fraction = ''] = text.split('.'); return BigInt(whole) * 10n ** BigInt(places) + (places ? BigInt((fraction + '0'.repeat(places)).slice(0, places)) : 0n);
}
/** Raw units as decimal text (no grouping), trailing zeros trimmed. */
export function amountText(raw, decimals) {
  const n = big(raw), places = Number(decimals), sign = n < 0n ? '-' : '', v = n < 0n ? -n : n, scale = 10n ** BigInt(places);
  const frac = places ? (v % scale).toString().padStart(places, '0').replace(/0+$/, '') : '';
  return sign + (v / scale).toString() + (frac ? '.' + frac : '');
}
const percentText = bps => (Number(bps) / 100).toFixed(2).replace(/\.?0+$/, '') + '%';
const routing = Object.freeze({ SOL_ROUTE_RATE_LIMITED: 'The RPC or route provider is rate limiting. The saved step will retry automatically.' });
/**
 * The real error for operators (admin alerts, journal and the launch report):
 * provider URLs (which can carry API keys) and long encoded payloads removed.
 * Simulation errors name the failing instruction, program and Pump's own log
 * line, none of which is secret. Creators still see safeError's wording.
 */
export const operatorError = error => String(error?.message || error || 'Unknown error').replace(/(?:https?|wss?):\/\/\S+/g, '[provider]').replace(/[A-Za-z0-9+/=]{120,}/g, '[data]').replace(/\s+/g, ' ').trim().slice(0, 600) || 'Unknown error';
export const safeError = error => error?.pumpClassicPublic === true || error?.statusCode ? String(error.message).replace(/(?:https?|wss?):\/\/\S+/g, '[provider]').slice(0, 240) : Object.hasOwn(routing, error?.code) ? routing[error.code] : 'Waiting for a verified balance, quote or receipt. This step retries automatically.';

/** Operator configuration from the environment (LAUNCHPAD_PUMP_CLASSIC_*). */
export function pumpClassicConfig(env = process.env) {
  const read = name => launchpadEnv(name, env), usd = Number(read('PUMP_CLASSIC_HOLDER_PAYOUT_USD') ?? HOLDER_PAYOUT_USD);
  return Object.freeze({ enabled: bool(read('PUMP_CLASSIC_ENABLED')), dbPath: read('PUMP_CLASSIC_DB_PATH') || '', backupDir: read('PUMP_CLASSIC_BACKUP_DIR') || '',
    // USD value of the holders' share that starts an automatic payout (1 to 1,000,000; anything else falls back to 100).
    holderPayoutUsd: Number.isFinite(usd) && usd >= 1 && usd <= 1000000 ? usd : HOLDER_PAYOUT_USD });
}
/** A fresh Ed25519 wallet as { address, secret } (secret = base58 of seed‖public key, the web3.js secret-key format). */
export function generateWallet() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32), secret = Buffer.concat([seed, pub]);
  try { return { address: base58Encode(pub), secret: base58Encode(secret) }; } finally { secret.fill(0); seed.fill(0); }
}
function walletMatches(key) {
  if (!key || typeof key.secret !== 'string' || !isAddress(key.address)) return false;
  let bytes; try { bytes = base58Decode(key.secret, 128); return bytes.length === 64 && base58Encode(bytes.subarray(32)) === key.address; } catch { return false; } finally { bytes?.fill(0); }
}
// A launch waiting for, or in, its funding and creation. An account may have at most MAX_PENDING_LAUNCHES at once.
const PENDING_STATES = ['awaiting_funding', 'funding_pending', 'funded', 'creating'], MAX_PENDING_LAUNCHES = 3;
// Quotes that ended without funding. Anyone signed in can make them, so lists never let them push other launches out.
const ABANDONED = ['expired', 'cancelled'];

export class PumpClassicService {
  constructor({ accounts, launchpad = null, chainFactory, publishMetadata = null, gotchiTarget = null, agentTarget = null, requireOwner = null, protocolRecipient = null, vanity = null, config = pumpClassicConfig(), now = Date.now, intervalMs = 20000, rebroadcast = null } = {}) {
    // `rebroadcast` ({ everyMs, times }): after a funding is submitted, resend it this often until it lands or expires (off unless the host enables it).
    Object.assign(this, { accounts, launchpad, chainFactory, publishMetadata, gotchiTarget, agentTarget, requireOwner, protocolRecipient, vanity, config, now, intervalMs, rebroadcast });
    this.running = null; this.timer = null; this.initial = null; this.closed = false; this.ensured = null; this.passes = 0; this.retry = new Map();
  }
  // ---- storage, flags and locks ------------------------------------------------------
  available() { return this.config.enabled && !!this.accounts?.hostStore && typeof this.accounts?.dir === 'string'; }
  store() { if (!this.available()) fail('Pump.fun launches are not enabled on this host.', 503, 'PUMP_CLASSIC_DISABLED'); if (!this.pcStore) fail('Pump.fun launches are still starting.', 503, 'PUMP_CLASSIC_STARTING'); return this.pcStore; }
  async ensure() {
    if (!this.available()) fail('Pump.fun launches are not enabled on this host.', 503, 'PUMP_CLASSIC_DISABLED');
    if (this.ensured) return this.ensured;
    this.ensured = (async () => {
      const db = await openPumpClassicDatabase(this.config.dbPath || join(this.accounts.dir, 'pump-classic', 'pump-classic.sqlite'), { now: this.now });
      this.db = db; this.pcStore = new PumpClassicStore(db, { now: this.now }); return this.pcStore;
    })().catch(error => { this.ensured = null; throw error; });
    return this.ensured;
  }
  flags() { const saved = this.pcStore?.flags() || {}; return Object.freeze(Object.fromEntries(Object.keys(DEFAULT_FLAGS).map(key => [key, saved[key]?.enabled ?? DEFAULT_FLAGS[key]]))); }
  effective() { const flags = this.flags(), master = this.config.enabled; return Object.freeze({ master, ...Object.fromEntries(Object.entries(flags).map(([key, value]) => [key, master && value])) }); }
  async locked(fn) { let release; try { release = await acquireProcessLock(join(this.accounts.dir, LOCK)); return await fn(); } finally { await release?.(); } }
  // ---- key custody ------------------------------------------------------------------------
  /** Per-coin wallets: launch (creator/payer), mint, protocol receipt and the option wallet. Written before anything can be funded. */
  async provisionKeys(launchId, mode) {
    const name = KEY_PREFIX + launchId, existing = await this.accounts.hostStore.read(name, null); if (existing) return existing;
    const doc = { version: 1, launchId, mode, launch: generateWallet(), mint: generateWallet(), protocol: generateWallet(), mode_wallet: mode === 'creator' ? null : generateWallet(), createdAt: this.now() };
    await this.accounts.hostStore.write(name, doc);
    const saved = await this.accounts.hostStore.read(name, null);
    if (!saved || saved.launch?.address !== doc.launch.address) fail('The launch keys could not be stored. Nothing was funded.', 503);
    return doc;
  }
  async keys(launch) {
    const doc = await this.accounts.hostStore.read(KEY_PREFIX + launch.id, null);
    // While a vanity address is being switched in, the document holds both keys; the launch row decides which one is the coin's.
    const mint = doc?.mint?.address === launch.mint ? doc.mint : doc?.randomMint?.address === launch.mint ? doc.randomMint : null;
    if (!doc || doc.launch?.address !== launch.launch_wallet || !mint || doc.protocol?.address !== launch.protocol_wallet || (doc.mode_wallet?.address || null) !== (launch.mode_wallet || null)) fail('The launch keys do not match this launch. Restore the original encrypted data.', 503, 'PUMP_CLASSIC_KEYS');
    for (const key of [doc.launch, mint, doc.protocol, ...(doc.mode_wallet ? [doc.mode_wallet] : [])]) if (!walletMatches(key)) fail('A launch key does not match its address. Restore the original encrypted data.', 503, 'PUMP_CLASSIC_KEYS');
    return { launch: doc.launch, mint, protocol: doc.protocol, mode: doc.mode_wallet };
  }
  // ---- vanity contract address ------------------------------------------------------------
  /**
   * Gives a launch the next address from the operator's vanity pool once its
   * funding is final and before the launch counts as funded: quotes and
   * fundings that never settle use none, and the coin's address is final before
   * the launch is listed anywhere (agents bind only to funded launches). Order:
   * lease the address, publish its metadata, store its key with the launch keys
   * (the quoted key stays as `randomMint`), commit it in the pool, then switch
   * the launch row, so a launch row only ever carries an address the pool has
   * recorded as used by it. Every step resumes after a restart; an empty pool or
   * any failure leaves the quoted address. Returns { launch, ready }: ready is
   * false only while a started switch could not be settled yet (the launch then
   * stays unfunded and unlisted for another pass; after repeated failures it
   * keeps its quoted address).
   */
  async assignVanity(launch) {
    if (!this.vanity) return { launch, ready: true };
    const store = this.store(), hostStore = this.accounts.hostStore, name = KEY_PREFIX + launch.id, venue = 'pump', ref = launch.id, retryKey = 'vanity:' + launch.id;
    let doc = null;
    const save = async next => {
      await hostStore.write(name, next); const saved = await hostStore.read(name, null);
      if (saved?.mint?.address !== next.mint?.address || saved?.vanity?.state !== next.vanity?.state) throw Error('The launch keys could not be stored.');
      doc = saved;
    };
    const giveUp = async reason => {
      // Back to the quoted key; the launch row never carried the vanity address. The lease, if still ours, goes back to the pool.
      const address = doc.vanity?.address || null, next = { ...doc, mint: doc.randomMint || doc.mint, vanity: { state: 'failed', address, at: this.now(), reason } }; delete next.randomMint; delete next.randomUri;
      await save(next); if (address) await this.vanity.release({ venue, ref, address }).catch(() => {});
      this.retry.delete(retryKey); return { launch: store.launch(launch.id) || launch, ready: true };
    };
    try {
      doc = await hostStore.read(name, null);
      if (!doc || ['assigned', 'none', 'failed', 'returned'].includes(doc.vanity?.state)) return { launch, ready: true };
      if (!doc.vanity) {
        if (!VANITY_SWITCHABLE.includes(launch.state) || store.operationsFor(launch.id, 'launch').length) return { launch, ready: true };
        const picked = await this.vanity.reserve({ venue, ref });
        if (!picked) { await save({ ...doc, vanity: { state: 'none', at: this.now() } }); await this.vanity.noteFallback({ venue, ref }).catch(() => {}); return { launch, ready: true }; }
        let uri;
        try {
          // The address is leased to this launch and unused, so a metadata file an earlier attempt left for it is replaced.
          uri = await this.publishMetadata({ accountId: launch.account_id, mint: picked.address, name: launch.name, symbol: launch.symbol, description: launch.description, image: launch.image, website: launch.website, twitter: launch.twitter, telegram: launch.telegram, replace: true });
          if (typeof uri !== 'string' || !uri.startsWith('https://') || Buffer.byteLength(uri) > 200) throw Error('invalid metadata address');
        } catch {
          await this.vanity.release({ venue, ref, address: picked.address }).catch(() => {});
          await save({ ...doc, vanity: { state: 'failed', address: picked.address, at: this.now(), reason: 'The coin metadata could not be published at the vanity address.' } });
          return { launch, ready: true };
        }
        await save({ ...doc, randomMint: doc.mint, randomUri: launch.metadata_uri, mint: { address: picked.address, secret: picked.secret }, vanity: { state: 'pending', address: picked.address, uri, at: this.now() } });
      }
      // A switch in progress (now, or left by a restart).
      const address = doc.vanity.address;
      if (launch.mint !== address) {
        if (launch.mint !== doc.randomMint?.address) throw Error('The launch address matches neither of its keys.');
        if (!VANITY_SWITCHABLE.includes(launch.state)) return await giveUp('The launch moved on before the vanity address was switched in.');
        if (!(await this.vanity.claim({ venue, ref, address }))) return await giveUp('The vanity address was taken by another launch.');
        await this.vanity.commit({ venue, ref, address, launch: { name: launch.name, symbol: launch.symbol, accountId: launch.account_id } });
        if (!store.switchMint(launch.id, { from: launch.mint, to: address, uri: doc.vanity.uri, states: VANITY_SWITCHABLE })) return await giveUp('The launch moved on before the vanity address was switched in.');
        launch = store.launch(launch.id);
        store.addEvent({ launchId: launch.id, kind: 'vanity', title: 'Vanity address assigned', body: `The coin will be created at ${address}.`, isPublic: false });
      }
      // The row carries the vanity address, which the pool recorded as used before the switch: only the document's state is left.
      this.retry.delete(retryKey);
      await save({ ...doc, vanity: { ...doc.vanity, state: 'assigned', at: this.now() } }).catch(() => {});
      return { launch, ready: true };
    } catch (error) {
      // Retried next pass; after repeated failures the launch keeps its quoted address (while its row still has it).
      const attempts = (this.retry.get(retryKey)?.attempts || 0) + 1; this.retry.set(retryKey, { attempts, at: this.now() });
      this.alert(launch, 'Vanity address not settled', operatorError(error));
      const current = store.launch(launch.id) || launch;
      if (doc?.vanity?.state !== 'pending' || current.mint === doc.vanity.address) return { launch: current, ready: true };
      if (attempts >= 5) { try { return await giveUp('The vanity address could not be switched in: ' + safeError(error)); } catch { /* storage is failing; keep waiting */ } }
      return { launch: current, ready: false };
    }
  }
  /**
   * Vanity addresses of launches that ended without creating their coin go back
   * to the pool after VANITY_RETURN_AFTER_MS without activity. Only launches
   * that can never create the coin qualify (failed, refunded, expired or
   * cancelled, never created, every creation transaction settled), and only
   * while the address is still empty onchain. Checked every ten minutes.
   */
  async recycleVanity() {
    if (typeof this.vanity?.usedFor !== 'function' || typeof this.vanity?.restore !== 'function' || this.throttle('vanity-recycle', 600000)) return;
    const store = this.store();
    for (const { address, ref } of await this.vanity.usedFor('pump')) {
      if (this.closed) return;
      const launch = /^[a-f0-9]{24}$/.test(ref) ? store.launch(ref) : null; if (!launch) continue;
      // A return already under way (a restart between its steps) finishes without waiting again.
      const resuming = launch.mint !== address; if (resuming && !(await this.returningVanity(launch, address))) continue;
      if (!VANITY_RETURNABLE.includes(launch.state) || launch.create_signature || (!resuming && this.now() - Math.max(launch.updated_at || 0, launch.funded_at || 0) < VANITY_RETURN_AFTER_MS)) continue;
      if (launch.mode === 'agent' || launch.agent) continue; // its AI agent is bound to the address
      if (store.operationsFor(launch.id, 'launch').some(op => !['expired', 'failed', 'superseded'].includes(op.state))) continue;
      try { await this.returnVanity(launch, address); }
      catch (error) { this.alert(launch, 'Vanity address not returned to the pool', `${operatorError(error)} Launchpad tries again later.`); }
    }
    // Returns the pool took back whose launch keys were not finished yet (a restart, or a failed write).
    if (typeof this.vanity.returnedFor === 'function') for (const { address, ref } of await this.vanity.returnedFor('pump')) {
      const launch = /^[a-f0-9]{24}$/.test(ref) ? store.launch(ref) : null; if (!launch) continue;
      try { await this.finishVanityReturn(launch, address); } catch (error) { this.alert(launch, 'Vanity address not returned to the pool', `${operatorError(error)} Launchpad tries again later.`); }
    }
  }
  /** The last step of a return: the launch keys forget the parked vanity key, then the pool records the return as settled. */
  async finishVanityReturn(launch, address) {
    const hostStore = this.accounts.hostStore, name = KEY_PREFIX + launch.id, doc = await hostStore.read(name, null);
    if (doc?.returning?.address === address) {
      const done = { ...doc, vanity: { ...(doc.vanity || {}), state: 'returned', address, returnedAt: this.now() } }; delete done.returning;
      await hostStore.write(name, done); const saved = await hostStore.read(name, null);
      if (saved?.returning || saved?.vanity?.state !== 'returned') throw Error('The launch keys could not be stored.');
      this.store().addEvent({ launchId: launch.id, kind: 'vanity', title: 'Vanity address returned to the pool', body: `${address} was never created as this coin and is available to new launches again. This launch now shows its original address, ${doc.mint?.address || launch.mint}.`, isPublic: false });
    }
    await this.vanity.settleReturn?.({ venue: 'pump', ref: launch.id, address });
  }
  /** True when this launch's keys are part-way through returning `address` (a restart between the steps). */
  async returningVanity(launch, address) { const doc = await this.accounts.hostStore.read(KEY_PREFIX + launch.id, null); return doc?.returning?.address === address || (doc?.mint?.address === address && !!doc.randomMint?.address && doc.randomMint.address === launch.mint); }
  /**
   * Returns one launch's vanity address to the pool. Steps (each resumes after a
   * restart): the launch row goes back to its own quoted address, the vanity key
   * is parked in the launch keys while the quoted key becomes the coin key
   * again, the pool takes the address back with its key, then the launch keys
   * forget it.
   */
  async returnVanity(launch, address) {
    const store = this.store(), hostStore = this.accounts.hostStore, name = KEY_PREFIX + launch.id;
    let doc = await hostStore.read(name, null);
    const save = async next => { await hostStore.write(name, next); const saved = await hostStore.read(name, null); if (saved?.mint?.address !== next.mint?.address || saved?.returning?.address !== next.returning?.address) throw Error('The launch keys could not be stored.'); doc = saved; };
    if (!doc) throw Error('The launch keys are missing.');
    const parked = doc.returning?.address === address ? doc.returning : null, vanityKey = parked || (doc.mint?.address === address ? doc.mint : null), random = parked ? doc.mint : doc.randomMint;
    if (!vanityKey?.secret || !random?.address || random.address === address) throw Error('The launch keys do not hold this vanity address and the quoted one.');
    // Never return an address that holds an account (a created coin), or one the chain could not be asked about.
    const exists = await this.vanity.exists(address);
    if (exists !== false) { if (exists === true) this.alert(launch, 'Vanity address kept', `${address} holds an account onchain, so it stays recorded as used.`); return false; }
    if (store.launch(launch.id)?.mint === address && !store.switchMint(launch.id, { from: address, to: random.address, uri: doc.randomUri || launch.metadata_uri, states: VANITY_RETURNABLE })) return false;
    if (store.launch(launch.id)?.mint !== random.address) throw Error('The launch row names neither address.');
    if (!parked) { const next = { ...doc, mint: random, returning: { address, secret: vanityKey.secret } }; delete next.randomMint; delete next.randomUri; await save(next); }
    await this.vanity.restore({ venue: 'pump', ref: launch.id, address, secret: doc.returning.secret });
    await this.finishVanityReturn(launch, address);
    return true;
  }
  // ---- availability -----------------------------------------------------------------------
  async status(session) {
    const signedIn = !!session?.account;
    if (!this.available()) return { available: false, reason: 'Pump.fun launches are not enabled on this host.', venue: 'pump-classic' };
    await this.ensure(); const effective = this.effective();
    // pairsOpen lets the launch page lay out its pair buttons before the live pair list arrives.
    return { available: true, venue: 'pump-classic', intakeOpen: effective.intake, pairsOpen: effective.pairs || await this.ownerPreview(session), signedIn, modes: PUMP_CLASSIC_MODES.map(id => ({ id, label: PUMP_CLASSIC_MODE_LABELS[id] })), limits: PUMP_CLASSIC_LIMITS, feeLink: PUMP_CLASSIC_FEE_LINK, quoteTtlMs: PUMP_CLASSIC_POLICY.launch.quoteTtlMs,
      solOnlyModes: [...PUMP_CLASSIC_POLICY.solOnlyModes], convertModes: [...PUMP_CLASSIC_POLICY.convertModes], reason: effective.intake ? '' : 'Pump.fun launches are paused right now. The platform owner can reopen them.',
      // Reward baskets (v71.35): Holders coins may name up to two more reward assets; the launch page offers the verified pair catalogue for them.
      basketsEnabled: !!PUMP_CLASSIC_POLICY.basket, basketModes: [...(PUMP_CLASSIC_POLICY.basket?.modes || [])], basketLimits: { maxAssets: (PUMP_CLASSIC_POLICY.basket?.maxExtras || 0) + 1, maxExtras: PUMP_CLASSIC_POLICY.basket?.maxExtras || 0 } };
  }
  // ---- pairs ---------------------------------------------------------------------------------
  /** The SOL pair row (always offered). */
  solPair() { return { mint: SOL, symbol: 'SOL', name: 'Solana', issuer: 'Native', category: 'crypto', decimals: 9, program: SPL_TOKEN_PROGRAM, kind: 'sol', launchReady: true, convertible: true, supportReason: '', maxDevBuy: amountText(PUMP_CLASSIC_POLICY.launch.maxDevBuyLamports, 9), creatorFee: null, pumpClassic: true }; }
  /** Display rows for Pump's live quote list: verified display identity where Launchpad knows the asset, otherwise the mint's own metadata, never a guess. */
  pairRows({ quotes, solReserves, creatorFee }) {
    const maxSol = big(PUMP_CLASSIC_POLICY.launch.maxDevBuyLamports), out = [];
    for (const q of quotes) {
      if (q.kind === 'sol') { out.push(this.solPair()); continue; }
      const known = knownQuoteAsset(q.mint), decimals = Number.isSafeInteger(q.decimals) ? q.decimals : null;
      const maxRaw = decimals !== null && big(solReserves) > 0n ? maxSol * big(q.initialVirtualQuoteReserves) / big(solReserves) : 0n;
      // Display identity only (bridge and launchpad-origin badges describe other venues and are left out).
      const display = known ? Object.fromEntries(Object.entries(known).filter(([key]) => ['issuer', 'category', 'logoPath', 'imagePath'].includes(key))) : {};
      out.push({ ...display, mint: q.mint, symbol: quoteLabel(q.mint, q.metadata?.symbol), name: String(known?.name || q.metadata?.name || (q.kind === 'listed' ? 'Pump.fun listed pair' : 'Pump.fun custom pair')).slice(0, 80), issuer: known?.issuer || '', category: known?.category || (q.kind === 'listed' ? 'crypto' : 'custom'),
        decimals, program: q.program || null, kind: q.kind, launchReady: q.supported === true && decimals !== null && maxRaw > 0n, convertible: q.convertible === true, supportReason: q.supported === true ? '' : String(q.reason || 'Launchpad cannot handle this pair yet.'),
        maxDevBuy: decimals === null ? '0' : amountText(maxRaw, decimals),
        // From policy v3 the dev buy on another pair is entered and paid in SOL; Launchpad buys the pair asset, so it needs a convertible pair.
        devBuyIn: pairDevBuyInSol(PUMP_CLASSIC_POLICY) ? 'SOL' : 'pair', maxDevBuySol: amountText(maxSol, 9), devBuyAvailable: pairDevBuyInSol(PUMP_CLASSIC_POLICY) ? q.convertible === true : true,
        ...(pairDevBuyInSol(PUMP_CLASSIC_POLICY) ? { devBuySlippageBps: PUMP_CLASSIC_POLICY.pairDevBuy.slippageBps, devBuyDriftBps: PUMP_CLASSIC_POLICY.pairDevBuy.quoteDriftBps } : {}), creatorFee: q.kind === 'custom' && creatorFee?.configurable === true && Number.isSafeInteger(creatorFee.maxBps) && creatorFee.maxBps > 0 ? { maxBps: creatorFee.maxBps } : null, pumpClassic: true });
    }
    return out;
  }
  /** The platform owner (two-factor admin) may preview pairs other than SOL while the pairs flag is off. */
  async ownerPreview(session) { if (typeof this.requireOwner !== 'function' || session?.account?.role !== 'admin') return false; try { await this.requireOwner(session); return true; } catch { return false; } }
  /**
   * Public: every pair Pump.fun admits for new coins right now (SOL, its listed
   * quote and its custom pairs) with whether Launchpad can launch on it. Read from
   * Pump's live program state and cached for five minutes. Until the pairs
   * flag is on, only SOL is offered (the platform owner sees the full list as a
   * preview).
   */
  async pairs(viewer = null) {
    if (!this.available()) return { available: false, reason: 'Pump.fun launches are not enabled on this host.', pairs: [] };
    await this.ensure(); this.pairCache ||= new Map();
    const policy = { solOnlyModes: [...PUMP_CLASSIC_POLICY.solOnlyModes], convertModes: [...PUMP_CLASSIC_POLICY.convertModes] }, open = this.effective().pairs, preview = !open && await this.ownerPreview(viewer);
    if (!open && !preview) return { available: true, ...policy, pairsOpen: false, ownerPreview: false, pairs: [this.solPair()], at: this.now(), stale: false, notice: 'Pump.fun pairs other than SOL are not open on this site yet.' };
    try {
      const value = await this.cachedRead(this.pairCache, 'pairs', 300000, async () => { const live = await (await this.readChain()).pumpQuotes(); return { pairs: this.pairRows(live), slot: live.slot, at: this.now() }; });
      return { available: true, ...policy, pairsOpen: open, ownerPreview: preview, ...value, stale: false, ...(preview ? { notice: 'Owner preview: pairs other than SOL are closed to the public until the pairs flag is on.' } : {}) };
    } catch (error) {
      return { available: true, ...policy, pairsOpen: open, ownerPreview: preview, pairs: [this.solPair()], at: this.now(), stale: true, notice: 'Pump.fun’s other pairs could not be loaded right now. SOL is available; try again shortly.' };
    }
  }
  /** Chain-facing quote of a launch: null for SOL coins. */
  chainQuote(launch) { return this.isQuote(launch) ? { mint: launch.quote_mint, program: launch.quote_program, quoteControl: !!launch.quote_control } : null; }
  isQuote(launch) { return typeof launch?.quote_mint === 'string' && launch.quote_mint !== SOL; }
  pairOf(launch) { return { mint: launch?.quote_mint || SOL, symbol: launch?.quote_symbol || 'SOL', decimals: Number.isSafeInteger(launch?.quote_decimals) ? launch.quote_decimals : 9, kind: launch?.quote_kind || 'sol', program: launch?.quote_program || SPL_TOKEN_PROGRAM }; }
  /** A SOL amount as this coin's quote units, scaled by Pump's initial curve reserves (unchanged for SOL coins). */
  quoteThreshold(launch, lamports) {
    if (!this.isQuote(launch)) return big(lamports);
    const q = big(launch.quote_reserves), s = big(launch.sol_reserves); return q > 0n && s > 0n ? big(lamports) * q / s : big(lamports);
  }
  sessionWallet(session) { return session?.walletVerified === true ? session.walletAddress : session?.account?.mainWallet || ''; }
  // ---- quote ---------------------------------------------------------------------------------
  /**
   * Validates the launch, provisions its wallets, publishes its metadata and
   * returns an expiring quote. Idempotent per (account, requestKey): an
   * account's quotes run one at a time, so a repeated request (a double click
   * or a retry while the first is still being prepared) waits for the first
   * and gets its launch back without provisioning anything, and concurrent
   * quotes cannot pass the pending-launch limit together.
   */
  async quote(session, body = {}, context) {
    const accountId = session?.account?.id;
    return typeof accountId === 'string' && accountId ? this.serial('quote:' + accountId, () => this.createQuote(session, body, context)) : this.createQuote(session, body, context);
  }
  /** Runs `fn` once every earlier call with the same key has settled (in this process). */
  async serial(key, fn) {
    this.queues ||= new Map();
    const previous = this.queues.get(key); let done; const current = new Promise(resolve => { done = resolve; });
    this.queues.set(key, current);
    try { await previous; return await fn(); } finally { done(); if (this.queues.get(key) === current) this.queues.delete(key); }
  }
  async createQuote(session, body = {}, context) {
    const store = await this.ensure(); if (!this.effective().intake) fail('Pump.fun launches are paused right now.', 409, 'PUMP_CLASSIC_INTAKE_CLOSED');
    const account = session?.account; if (!account || account.banned) fail('Sign in to launch a coin.', 403);
    // Session and CSRF are checked before any side effect (wallets, metadata, agent drafts) and again before the launch is saved.
    await context?.authorize?.();
    const requestKey = String(body.requestKey || ''); if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestKey)) fail('A unique launch request ID is required.');
    const key = sha(account.id + ':' + requestKey), existing = store.launchByRequest(key);
    if (existing) { if (existing.account_id !== account.id) fail('Launch not found.', 404); return this.launchView(existing, { owner: true }); }
    const mode = String(body.mode || ''); if (!validMode(mode)) fail('Choose Creator, Holders, Gotchi, AI Agent, Market Maker, Liquidity Manager, Diamond Hands, Earned or Insured.');
    // A white-label launchpad (LAUNCHPAD_PRODUCT=tenant) offers only the venues and launch modes its owner picked.
    requireTenantLaunch({ venue: 'pump-classic', mode });
    // One line each, trimmed; the name and ticker are limited in bytes as Pump's program stores them (see coin-text.mjs).
    const name = coinText(body.name, { field: 'coin name', max: 32, bytes: true, required: true }), symbol = coinText(typeof body.symbol === 'string' ? body.symbol.toUpperCase() : body.symbol, { field: 'ticker', max: 13, bytes: true, required: true });
    padCheck({ name, symbol, owner: account.id });
    const description = coinText(body.description, { field: 'description', max: 500 }), website = coinLink(body.website, 'website'), twitter = coinLink(body.twitter, 'twitter'), telegram = coinLink(body.telegram, 'telegram');
    const image = String(body.image || ''); if (!/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(image)) fail('Upload a coin image before reviewing your launch.');
    const developer = String(body.wallet || ''); if (!isAddress(developer) || !isOnCurve(developer)) fail('Connect the Solana wallet you will fund this launch from.');
    const bound = this.sessionWallet(session); if (bound && session.walletVerified === true && bound !== developer) fail('Connect the wallet you signed in with. Your dev-buy tokens are delivered to the funding wallet.', 403);
    if (store.countLaunches({ accountId: account.id, states: PENDING_STATES }) >= MAX_PENDING_LAUNCHES) fail('Finish or cancel your pending Pump.fun launches first.', 409);
    const policy = PUMP_CLASSIC_POLICY, quoteMint = String(body.quoteMint || SOL); if (!isAddress(quoteMint)) fail('Choose a valid pair.');
    const quotePair = quoteMint !== SOL;
    if (quotePair && !this.effective().pairs && !(await this.ownerPreview(session))) fail('Pump.fun pairs other than SOL are not open on this site yet. Choose SOL.', 409, 'PUMP_CLASSIC_PAIRS_CLOSED');
    if (quotePair && !quotePairAllowed(mode, policy)) fail(solOnlyText(policy));
    let creatorFeeBps = body.creatorFeeBps === undefined || body.creatorFeeBps === null || body.creatorFeeBps === '' ? 0 : Number(body.creatorFeeBps);
    if (!Number.isSafeInteger(creatorFeeBps) || creatorFeeBps < 0 || creatorFeeBps > 10000) fail('Choose a valid creator fee.');
    // From policy v3 a dev buy on another pair is paid in SOL: Launchpad buys the pair asset with it after the funding is final.
    const solDevBuy = quotePair && pairDevBuyInSol(policy);
    let solDevBuyLamports = 0n;
    if (solDevBuy) {
      if (body.devBuyAmount !== undefined && !/^0*(?:\.0*)?$/.test(String(body.devBuyAmount).trim())) fail('Enter the dev buy in SOL. Launchpad buys the pair asset for it.');
      solDevBuyLamports = lamportsFromSol(body.devBuySol ?? '0', 'the dev buy');
    }
    // The pair is read fresh from Pump's program state: it must still be admitted and handled exactly.
    let asset = null, conversion = null;
    if (quotePair) {
      const chain = await this.chainFactory();
      try {
        asset = await chain.quoteAsset(quoteMint);
        if (asset.supported === true && (policy.convertModes.includes(mode) || solDevBuyLamports > 0n)) asset.convertible = (await chain.conversionSupport([quoteMint])).get(quoteMint) === true;
        if (asset.supported === true && solDevBuyLamports > 0n && asset.convertible === true) {
          const guard = policy.pairDevBuy;
          // Priced for a fresh wallet like the launch wallet that will buy it (the creator's own token accounts play no part).
          try { conversion = await chain.quoteDevBuyConversion({ quoteMint, program: asset.program, lamports: solDevBuyLamports, taker: generateWallet().address, slippageBps: guard.slippageBps, maxImpactBps: guard.maxImpactBps }); }
          catch (error) {
            const code = String(error?.code || '');
            if (['SOL_ROUTE_NOT_FOUND', 'TREASURY_PRICE_IMPACT', 'TREASURY_INVALID_IMPACT', 'TREASURY_SLIPPAGE_LIMIT', 'PUMP_CLASSIC_CONVERSION'].includes(code)) fail('No fair SOL route to this pair’s asset is available for this dev buy right now. Try a smaller dev buy or try again shortly.', 409, 'PUMP_CLASSIC_NO_ROUTE');
            if (code.startsWith('SOL_ROUTE_')) fail('Launchpad could not reach its swap route to price this dev buy. Try again shortly.', 503, 'PUMP_CLASSIC_ROUTE_UNAVAILABLE');
            throw error;
          }
        }
      } finally { await chain.close?.(); }
      if (asset.supported !== true) fail(asset.reason || 'Launchpad cannot handle this pair yet.', 409);
      if (policy.convertModes.includes(mode) && asset.convertible !== true) fail('Launchpad cannot convert this pair’s fees to SOL yet, so Holders, Diamond Hands and Gotchi launches are unavailable on it. Creator launches still work.', 409);
      if (solDevBuyLamports > 0n && asset.convertible !== true) fail('Launchpad cannot buy this pair’s asset with SOL right now, so a dev buy is unavailable on it. Launch without a dev buy, or choose another pair.', 409);
      if (conversion) {
        // The reviewed minimum: what the route guarantees now, less the price movement allowed before the purchase.
        const minimum = big(conversion.minimumRaw), reviewed = minimum * BigInt(10000 - policy.pairDevBuy.quoteDriftBps) / 10000n;
        conversion = { ...conversion, routeMinimumRaw: minimum.toString(), minimumRaw: reviewed.toString() };
      }
      if (solDevBuyLamports > 0n && !(big(conversion?.minimumRaw) > 0n)) fail('No fair SOL route to this pair’s asset is available for this dev buy right now. Try a smaller dev buy or try again shortly.', 409);
    }
    const decimals = quotePair ? asset.decimals : 9, pairSymbol = quotePair ? quoteLabel(quoteMint, asset.metadata?.symbol) : 'SOL';
    if (creatorFeeBps > 0) {
      if (!quotePair || asset.kind !== 'custom') fail('A custom creator fee is only available on Pump.fun custom pairs.');
      if (asset.creatorFee?.configurable !== true || creatorFeeBps > asset.creatorFee.maxBps) fail(`Pump.fun allows a creator fee of at most ${percentText(asset.creatorFee?.maxBps || 0)} on this pair right now.`);
    }
    let devBuy = 0n, devBuyRaw = 0n;
    if (quotePair) {
      const maxRaw = big(asset.solReserves) > 0n ? big(policy.launch.maxDevBuyLamports) * big(asset.initialVirtualQuoteReserves) / big(asset.solReserves) : 0n;
      if (solDevBuy) {
        // Paid in SOL; the quote's minimum tokens come from the reviewed minimum of the pair asset, its estimate from the route's expected amount.
        devBuy = solDevBuyLamports; devBuyRaw = conversion ? big(conversion.minimumRaw) : 0n;
        if (conversion && big(conversion.expectedRaw) > maxRaw) fail(`The dev buy exceeds this pair’s launch limit. Use at most about ${sol(devBuy * maxRaw / big(conversion.expectedRaw))} SOL.`);
      } else {
        if (body.devBuySol !== undefined && !/^0*(?:\.0*)?$/.test(String(body.devBuySol).trim())) fail(`Enter the dev buy in ${pairSymbol}.`);
        devBuyRaw = rawFromAmount(body.devBuyAmount ?? '0', decimals, 'the dev buy', pairSymbol);
        if (devBuyRaw > maxRaw) fail(`The dev buy exceeds the launch limit of ${amountText(maxRaw, decimals)} ${pairSymbol}.`);
      }
    } else devBuyRaw = devBuy = lamportsFromSol(body.devBuyAmount ?? body.devBuySol ?? '0', 'the dev buy');
    const seed = lamportsFromSol(body.seedSol ?? '0', 'seed capital');
    const plan = fundingPlan({ mode, devBuyLamports: devBuy, seedLamports: seed, quotePair }, policy);
    if (mode === 'gotchi' && typeof this.gotchiTarget !== 'function') fail('Gotchi launches are unavailable on this host.', 503);
    if (mode === 'agent' && typeof this.agentTarget !== 'function') fail('AI Agent launches are unavailable on this host.', 503);
    const gotchi = mode === 'gotchi' ? await this.gotchiTarget(String(body.gotchiId || '')) : null;
    let agent = null;
    if (mode === 'agent') {
      let request; try { request = agentLaunchRequest({ ...(body.agent || {}), venue: 'pump' }); } catch (error) { fail(error.message); }
      const target = await this.agentTarget(request, { accountId: account.id, venue: 'pump', name, symbol });
      if (!validAgentAttachment(target) || !isOnCurve(target.wallet)) fail('AI Agent launches are not accepting new coins right now.', 409);
      agent = { version: 1, mode: target.mode, id: target.id, wallet: target.wallet, policyHash: target.policyHash, policyVersion: target.policyVersion, capabilities: target.capabilities, model: target.model, attachedAt: this.now() };
    } else if (body.agent !== undefined && body.agent !== null) fail('Agent settings require the AI Agent launch option.');
    // v71.35: Diamond Hands, Earned and Insured carry the creator's settings; the lifecycle state is written when the coin is created.
    let option = null;
    try { option = pumpOptionRequest(mode, body.option); } catch (error) { fail(error.message); }
    // v71.35: a Holders coin may name up to two more reward assets. Checked and frozen here; nothing is spent for it.
    const basket = await this.basketPlan(body.basket, { mode, quoteMint, quotePair, pairSymbol, decimals, asset, policy });
    const id = randomBytes(12).toString('hex'), keys = await this.provisionKeys(id, mode);
    const launchWallet = keys.launch.address, mint = keys.mint.address, protocolWallet = keys.protocol.address, modeWallet = keys.mode_wallet?.address || null;
    const recipient = mode === 'creator' ? developer : modeWallet;
    if ([launchWallet, mint, protocolWallet, modeWallet].includes(developer)) fail('Invalid developer wallet.');
    const shareholders = shareholdersFor(mode, { protocolWallet, recipient });
    const transfers = [{ to: protocolWallet, lamports: plan.collectorGasLamports }, ...(modeWallet ? [{ to: modeWallet, lamports: (big(plan.modeGasLamports) + big(plan.seedLamports)).toString() }] : [])];
    const chain = await this.chainFactory();
    let quote;
    try { quote = await chain.quoteLaunch({ devBuyLamports: devBuyRaw, devBuyRaw, quoteMint, creatorFeeBps: BigInt(creatorFeeBps) }); } finally { await chain.close?.(); }
    // A pump-coin quote's starting reserves move with the quote coin's live price (within reason); a listed quote's are a fixed entry.
    const reservesMoved = (a, b) => { a = big(a); b = big(b); return quote.entry?.pumpCoin ? (a > b ? a - b : b - a) * 10n > (a > b ? a : b) : a !== b; };
    if (quotePair && (quote.entry?.mint !== quoteMint || quote.entry.kind !== asset.kind || !!quote.entry.quoteControl !== !!asset.quoteControl || reservesMoved(quote.entry.initialVirtualQuoteReserves, asset.initialVirtualQuoteReserves))) fail('Pump.fun changed this pair while your quote was prepared. Review the launch again.', 409);
    const uri = await this.publishMetadata({ accountId: account.id, mint, name, symbol, description, image, website, twitter, telegram });
    if (typeof uri !== 'string' || !uri.startsWith('https://') || Buffer.byteLength(uri) > 200) fail('The coin metadata address is invalid. Configure a short public HTTPS address.', 503);
    await context?.authorize?.();
    const devBuyText = solDevBuy ? (devBuy > 0n ? `${sol(devBuy)} SOL, converted to at least ${amountText(devBuyRaw, decimals)} ${pairSymbol}` : 'none') : `${amountText(devBuyRaw, decimals)} ${pairSymbol}`;
    // The request key and the pending limit are checked again in the transaction that saves the launch, so even another
    // process quoting for this account at the same moment cannot add a duplicate or a fourth pending launch.
    const row = store.db.transaction(() => {
      const raced = store.launchByRequest(key); if (raced) return raced;
      if (store.countLaunches({ accountId: account.id, states: PENDING_STATES }) >= MAX_PENDING_LAUNCHES) fail('Finish or cancel your pending Pump.fun launches first.', 409);
      const saved = store.insertLaunch({
        id, account_id: account.id, request_key: key, mode, policy_version: policy.version, policy_hash: PUMP_CLASSIC_POLICY_HASH,
        name, symbol, description, image, website, twitter, telegram, metadata_uri: uri, gotchi, agent, option, basket,
        developer_wallet: developer, launch_wallet: launchWallet, protocol_wallet: protocolWallet, mode_wallet: modeWallet, mint, recipient,
        dev_buy_lamports: devBuy.toString(), seed_lamports: seed.toString(),
        quote_mint: quoteMint, quote_program: quotePair ? asset.program : SPL_TOKEN_PROGRAM, quote_decimals: decimals, quote_symbol: pairSymbol, quote_kind: quotePair ? asset.kind : 'sol', quote_control: quotePair && asset.quoteControl === true,
        quote_reserves: String(quotePair ? asset.initialVirtualQuoteReserves : quote.entry?.initialVirtualQuoteReserves ?? 0), sol_reserves: String(quotePair ? asset.solReserves : quote.solReserves ?? 0), creator_fee_bps: creatorFeeBps, dev_buy_raw: devBuyRaw.toString(),
        plan: { funding: plan, transfers, shareholders, memo: `pump-launch:${id}` },
        quote: { tokens: quote.tokens.toString(), costLamports: quote.costLamports.toString(), feeBps: quote.feeBps.toString(), slot: quote.slot, totalLamports: plan.totalLamports, devBuyRaw: devBuyRaw.toString(), quoteMint, creatorFeeBps,
          // A SOL-paid dev buy on another pair: tokens above are what the route's minimum buys; expectedTokens what its expected amount buys.
          ...(conversion ? { expectedTokens: curveTokensForQuote({ virtualQuote: quote.initialCurve.virtual_quote_reserves, virtualToken: quote.initialCurve.virtual_token_reserves, realToken: quote.initialCurve.real_token_reserves, quoteIn: big(conversion.expectedRaw), feeBps: quote.feeBps }).toString(),
            conversion: { inputLamports: devBuy.toString(), expectedRaw: String(conversion.expectedRaw), minimumRaw: String(conversion.minimumRaw), routeMinimumRaw: String(conversion.routeMinimumRaw), slot: conversion.slot ?? null } } : {}) },
        quote_expires_at: this.now() + policy.launch.quoteTtlMs, state: 'awaiting_funding', venue_state: 'curve',
      });
      store.addEvent({ launchId: id, kind: 'quote', title: 'Launch quoted', body: `${PUMP_CLASSIC_MODE_LABELS[mode]} on Pump.fun, paired with ${pairSymbol}. Dev buy ${devBuyText}.${creatorFeeBps ? ` Creator fee ${percentText(creatorFeeBps)}.` : ''}${option ? ' ' + describePumpOption(mode, option.settings) : ''}${basket ? ` Reward basket: ${describeBasket(basket.assets.map(a => a.symbol))}, equal shares.` : ''}`, isPublic: false });
      if (isStrategyMode(mode)) store.ensureStrategy(id, mode, modeWallet);
      return saved;
    });
    if (row.account_id !== account.id) fail('Launch not found.', 404);
    return this.launchView(row, { owner: true });
  }
  requireOwnLaunch(session, launchId) {
    const store = this.store(), launch = typeof launchId === 'string' && /^[a-f0-9]{24}$/.test(launchId) ? store.launch(launchId) : null;
    if (!launch || launch.account_id !== session?.account?.id) fail('Launch not found.', 404); return launch;
  }
  // ---- funding ---------------------------------------------------------------------------------
  async prepareFunding(session, { launchId } = {}, context) {
    await this.ensure(); await context?.authorize?.(); const store = this.store(), launch = this.requireOwnLaunch(session, launchId);
    if (launch.state !== 'awaiting_funding') fail('This launch is no longer waiting for funding.', 409);
    requireTenantLaunch({ venue: 'pump-classic', mode: launch.mode });
    if (launch.quote_expires_at <= this.now()) { store.moveLaunch(launch.id, 'awaiting_funding', 'expired', { state_reason: 'The quote expired before funding.' }); fail('This quote expired. Review the launch again for a fresh quote.', 409, 'PUMP_CLASSIC_QUOTE_EXPIRED'); }
    if (!this.effective().intake) fail('Pump.fun launches are paused right now.', 409, 'PUMP_CLASSIC_INTAKE_CLOSED');
    if (this.isQuote(launch) && !this.effective().pairs && !(await this.ownerPreview(session))) fail('Pump.fun pairs other than SOL are closed right now. Start over on SOL.', 409, 'PUMP_CLASSIC_PAIRS_CLOSED');
    const chain = await this.chainFactory(), pair = this.pairOf(launch), tokenAmount = this.fundingTokens(launch);
    try {
      // On another pair with a dev buy, one transaction carries both the SOL for costs and reserves and the exact dev-buy amount of the pair asset.
      const op = tokenAmount > 0n
        ? await chain.prepareQuoteDeposit({ sender: launch.developer_wallet, recipient: launch.launch_wallet, lamports: launch.plan.funding.totalLamports, memo: launch.plan.memo, quote: this.chainQuote(launch), tokenAmount, decimals: pair.decimals })
        : await chain.prepareSolDeposit({ sender: launch.developer_wallet, recipient: launch.launch_wallet, lamports: launch.plan.funding.totalLamports, memo: launch.plan.memo });
      if (op?.externalSigner !== launch.developer_wallet || op.recipient !== launch.launch_wallet || String(op.inputAmount) !== String(launch.plan.funding.totalLamports) || (tokenAmount > 0n && (op.tokenAmount !== tokenAmount.toString() || op.mint !== pair.mint)) || typeof op.unsignedRaw !== 'string') throw publicFailure('The prepared funding could not be verified.');
      await context?.authorize?.();
      for (const prior of store.operationsFor(launch.id, 'funding')) if (prior.state === 'awaiting_signature') store.updateOperation(prior.id, { state: 'superseded', unsigned: null });
      const row = store.insertOperation({ id: newId('op'), launchId: launch.id, kind: 'funding', state: 'awaiting_signature', wallet: launch.developer_wallet, unsigned: op.unsignedRaw, version: 0, blockhash: op.blockhash, lastValidBlockHeight: op.lastValidBlockHeight, preparedSlot: op.preparedSlot, expected: { op: { ...op, unsignedRaw: undefined }, messageHash: op.messageHash, amount: launch.plan.funding.totalLamports, memo: launch.plan.memo, tokenAmount: tokenAmount.toString(), quoteMint: pair.mint } });
      return { operationId: row.id, transaction: op.unsignedRaw, messageHash: op.messageHash, amountLamports: launch.plan.funding.totalLamports, amountSol: sol(launch.plan.funding.totalLamports), memo: launch.plan.memo, wallet: launch.developer_wallet,
        pairAmountRaw: tokenAmount.toString(), pairAmount: amountText(tokenAmount, pair.decimals), pairSymbol: pair.symbol, pairMint: pair.mint, launch: this.launchView(store.launch(launch.id), { owner: true }) };
    } finally { await chain.close?.(); }
  }
  async submitFunding(session, { launchId, operationId, signedTransaction } = {}, context) {
    await this.ensure(); await context?.authorize?.(); const store = this.store(), launch = this.requireOwnLaunch(session, launchId), row = store.operation(String(operationId || ''));
    if (!row || row.launch_id !== launch.id || row.kind !== 'funding') fail('Funding request not found.', 404);
    if (row.state !== 'awaiting_signature') return this.launchView(store.launch(launch.id), { owner: true });
    if (launch.state !== 'awaiting_funding') fail('This launch is no longer waiting for funding.', 409);
    const chain = await this.chainFactory();
    try {
      // The funding was prepared against confirmed state, so a wallet-edited signature is checked against confirmed state too.
      const pending = { kind: 'deposit', needsSignature: true, state: 'awaiting_signature', externalSigner: launch.developer_wallet, unsignedRaw: row.unsigned, messageHash: row.expected.messageHash, blockhash: row.blockhash, lastValidBlockHeight: row.last_valid_block_height, preparedSlot: row.prepared_slot, createdAt: row.created_at, simulationCommitment: 'confirmed' };
      const signed = await chain.acceptSigned(pending, signedTransaction);
      await context?.authorize?.();
      const raw = signed.raw, rawHash = sha(Buffer.from(raw, 'base64'));
      if (store.operationBySignature(signed.signature)) fail('This funding transaction was already submitted.', 409);
      const moved = store.db.transaction(() => {
        if (!store.moveLaunch(launch.id, 'awaiting_funding', 'funding_pending', { funding_signature: signed.signature })) return false;
        store.updateOperation(row.id, { state: 'signed', signature: signed.signature, raw, rawHash, unsigned: null });
        return true;
      });
      if (!moved) return this.launchView(store.launch(launch.id), { owner: true });
      store.addEvent({ launchId: launch.id, kind: 'funding', title: 'Funding signed', body: `${this.fundingText(launch)} from ${launch.developer_wallet}.`, signature: signed.signature, isPublic: false });
      // Funds the creator received seconds ago count: the first send is checked against confirmed state.
      await this.broadcastOp(chain, store.operation(row.id), { preflightCommitment: 'confirmed' });
      this.burst(row.id);
      this.kick();
      return this.launchView(store.launch(launch.id), { owner: true });
    } finally { await chain.close?.(); }
  }
  async cancel(session, { launchId } = {}) {
    await this.ensure(); const store = this.store(), launch = this.requireOwnLaunch(session, launchId);
    if (launch.state !== 'awaiting_funding') fail('Only an unfunded launch can be cancelled. Funded launches are created or refunded automatically.', 409);
    if (store.operationsFor(launch.id, 'funding').some(op => OPEN.includes(op.state))) fail('A signed funding transaction is being checked.', 409);
    store.moveLaunch(launch.id, 'awaiting_funding', 'cancelled', { state_reason: 'Cancelled before funding.' });
    for (const op of store.operationsFor(launch.id, 'funding')) if (op.state === 'awaiting_signature') store.updateOperation(op.id, { state: 'cancelled', unsigned: null });
    return this.launchView(store.launch(launch.id), { owner: true });
  }
  /**
   * The creator's launches, newest first: every live coin, plus the newest 50 others still in progress or ended after
   * funding (failed, refunded). Abandoned quotes (expired, cancelled, or past their expiry) are left out, so however
   * many a creator leaves behind, they never push a live coin or an unfinished launch off this list.
   */
  async mine(session) {
    await this.ensure(); const store = this.store(), accountId = session.account.id, now = this.now();
    const live = store.launchesWhere({ accountId, states: ['created'] });
    const recent = store.launchesWhere({ accountId, exceptStates: ['created', ...ABANDONED], limit: 50 }).filter(row => row.state !== 'awaiting_funding' || row.quote_expires_at > now);
    return { launches: [...live, ...recent].sort((a, b) => b.created_at - a.created_at).map(row => this.launchView(row, { owner: true })) };
  }
  async ownLaunch(session, { launchId } = {}) { await this.ensure(); return this.launchView(this.requireOwnLaunch(session, launchId), { owner: true }); }

  // ---- operation journal -------------------------------------------------------------------
  /** Persists exact signed bytes before any broadcast. */
  journal(launch, kind, prepared, extra = {}) {
    const store = this.store(), bytes = Buffer.from(String(prepared?.raw || ''), 'base64');
    if (!validSignature(prepared?.signature) || !bytes.length || prepared.rawHash !== sha(bytes) || typeof prepared.wallet !== 'string') throw publicFailure('The prepared transaction could not be verified.');
    if (store.operationBySignature(prepared.signature)) throw publicFailure('Waiting for a fresh transaction blockhash.');
    const { raw, ...rest } = prepared;
    return store.insertOperation({ id: newId('op'), launchId: launch.id, kind, state: 'signed', wallet: prepared.wallet, signature: prepared.signature, raw, rawHash: prepared.rawHash, version: prepared.version ?? 0, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight, preparedSlot: prepared.preparedSlot, expected: jsonable({ op: rest, ...extra }) });
  }
  chainOp(row) { return { ...row.expected.op, raw: row.raw, rawHash: row.raw_hash, signature: row.signature, wallet: row.wallet, blockhash: row.blockhash, lastValidBlockHeight: row.last_valid_block_height, preparedSlot: row.prepared_slot }; }
  opSigners(row) { return row.kind === 'launch' ? [row.expected.op.mint] : []; }
  treasuryShaped(row) { return ['withdraw', 'airdrop', 'convert', 'acquire', 'unwind'].includes(row.kind); }
  async broadcastOp(chain, row, { preflightCommitment = 'finalized' } = {}) {
    const store = this.store(), first = !(row.attempts > 0); store.updateOperation(row.id, { attempts: (row.attempts || 0) + 1, lastBroadcastAt: this.now() });
    try {
      // Resends of a transaction the RPC may already hold skip the preflight check.
      if (this.treasuryShaped(row)) await chain.broadcast(this.chainOp(row)); else await chain.broadcastSaved(this.chainOp(row), this.opSigners(row), { preflightCommitment, skipPreflight: !first });
      store.updateOperation(row.id, { state: 'submitted', error: '' });
    } catch (error) { store.updateOperation(row.id, { state: 'submitted', error: `Not accepted by the RPC on attempt ${(row.attempts || 0) + 1}: ${operatorError(error)} Launchpad keeps checking the saved transaction until it lands or expires.`.slice(0, 600) }); }
  }
  /**
   * Resends a just-submitted operation every `rebroadcast.everyMs` while it is open, so it lands within its blockhash
   * lifetime. One chain client serves the whole sequence: built for the first resend, rebuilt only after a failed one,
   * and closed when the sequence ends (or the service closes).
   */
  burst(operationId) {
    const plan = this.rebroadcast; if (!plan || !(plan.times > 0) || !(plan.everyMs > 0)) return;
    let sent = 0, chain = null;
    const release = async () => { const held = chain; chain = null; if (held && this.bursts?.delete(held)) { try { await held.close?.(); } catch { /* closed */ } } };
    const tick = async () => {
      try {
        if (this.closed || ++sent > plan.times) return await release();
        const row = this.pcStore?.operation(operationId); if (!row || !['signed', 'submitted'].includes(row.state) || this.treasuryShaped(row)) return await release();
        if (!chain) { chain = await this.chainFactory(); (this.bursts ||= new Set()).add(chain); }
        await chain.broadcastSaved(this.chainOp(row), this.opSigners(row), { skipPreflight: true });
      } catch { await release(); /* the next resend builds a fresh client; the worker's checks continue */ }
      if (this.closed) return await release();
      const timer = setTimeout(tick, plan.everyMs); timer.unref?.();
    };
    const timer = setTimeout(tick, plan.everyMs); timer.unref?.();
  }
  /** One reconciliation step for a journaled operation. Never re-signs; a replacement needs a proven expiry. */
  /**
   * `apply` runs in the same database transaction as the operation's terminal
   * state, so a crash can never record an outcome without its ledger effects.
   */
  async settleOp(chain, row, receipt, apply = () => {}) {
    const store = this.store();
    if (!OPEN.includes(row.state)) return { state: row.state, receipt: row.receipt };
    if ((row.check_after || 0) > this.now()) return { state: 'pending' };
    store.updateOperation(row.id, { checkAfter: this.now() + 10000 });
    try {
      const result = await receipt(chain, row);
      if (result) { const state = result.state === 'failed' ? 'failed' : 'confirmed'; store.db.transaction(() => { store.updateOperation(row.id, { state, receipt: jsonable(result), error: state === 'failed' ? 'The transaction failed onchain.' : '' }); apply({ state, receipt: result }); }); return { state, receipt: result }; }
      const status = this.treasuryShaped(row) ? await chain.state(this.chainOp(row)) : await chain.savedState(this.chainOp(row), this.opSigners(row));
      if (status?.state === 'expired') {
        const check = row.receipt?.expiryCheck, cp = status.checkpoint;
        if (check && this.now() - check.at >= 10000 && Number.isSafeInteger(cp?.slot) && cp.slot > check.slot && cp.height > row.last_valid_block_height) { store.db.transaction(() => { store.updateOperation(row.id, { state: 'expired', error: 'Expired without executing; a fresh transaction can be prepared.' }); apply({ state: 'expired' }); }); return { state: 'expired' }; }
        store.updateOperation(row.id, { receipt: { expiryCheck: { at: this.now(), slot: cp?.slot ?? 0, height: cp?.height ?? 0 } } });
      } else if (status?.state === 'pending' && (row.attempts || 0) < 6 && this.now() - (row.last_broadcast_at || 0) >= 20000) await this.broadcastOp(chain, store.operation(row.id));
      else if (status?.state === 'unknown') store.updateOperation(row.id, { error: String(status.reason || 'Outcome not yet provable.').slice(0, 240) });
    } catch (error) { store.updateOperation(row.id, { error: operatorError(error) }); }
    return { state: 'pending' };
  }
  /** The newest open operation of one of `kinds`. A reward basket's purchases (v71.35, kind 'acquire' with purpose 'basket') belong to the payout, never to the launch's dev buy: 'acquire' here means the dev-buy purchase only. */
  openOp(launchId, kinds) { return this.store().openOperations(launchId).find(op => kinds.includes(op.kind) && OPEN.includes(op.state) && !(op.kind === 'acquire' && op.expected?.purpose === 'basket')) || null; }
  backoff(key) { const r = this.retry.get(key); return !!r && r.nextAt > this.now(); }
  /** One of this pass's swap preparations (unlimited outside a worker pass). */
  takeSwap() { if (this.swapsLeft === undefined) return true; if (this.swapsLeft <= 0) return false; this.swapsLeft--; return true; }
  retryLater(key, error, { base = 15000, max = 3600000 } = {}) { const prev = this.retry.get(key), attempts = (prev?.attempts || 0) + 1; this.retry.set(key, { attempts, nextAt: this.now() + Math.min(max, base * 2 ** Math.min(attempts - 1, 8)), message: safeError(error) }); if (this.retry.size > 5000) this.retry.delete(this.retry.keys().next().value); }
  throttle(key, ms) { const r = this.retry.get('t:' + key); if (r && this.now() - r.at < ms) return true; this.retry.set('t:' + key, { at: this.now(), nextAt: 0 }); return false; }
  alert(launch, title, body = '') { const store = this.store(), recent = store.events(launch.id, { publicOnly: false, limit: 30 }); if (recent.some(e => e.kind === 'alert' && e.title === title.slice(0, 160) && this.now() - e.at < 3600000)) return; store.addEvent({ launchId: launch.id, kind: 'alert', title, body, isPublic: false }); }
  /**
   * The immutable launch record as the chain adapter takes it. On another pair
   * the creation transaction expects its pair accounts from the setup
   * transaction and leaves the dev-buy tokens with the launch wallet for a
   * separate delivery: a dev buy on a token-program pair makes too many program
   * calls to fit everything in one transaction. SOL launches keep one transaction.
   */
  launchPlan(launch) {
    const quotePair = this.isQuote(launch);
    return { mint: launch.mint, launchWallet: launch.launch_wallet, developer: launch.developer_wallet, name: launch.name, symbol: launch.symbol, uri: launch.metadata_uri, shareholders: launch.plan.shareholders, transfers: launch.plan.transfers, tokens: launch.quote.tokens,
      devBuyLamports: launch.dev_buy_lamports, devBuyRaw: this.devBuyRaw(launch).toString(), fundedLamports: this.launchWalletLamports(launch).toString(), quote: this.chainQuote(launch), creatorFeeBps: launch.creator_fee_bps || 0, fundedQuoteRaw: quotePair ? launch.funded_quote || '0' : '0',
      // A SOL-paid pair dev buy spends everything the purchase delivered (at least the reviewed minimum's tokens).
      buyAll: this.solPaidPair(launch),
      pairAccounts: quotePair ? 'ready' : 'create', delivery: quotePair ? 'separate' : 'inline', createdSlot: Number.isSafeInteger(launch.created_slot) ? launch.created_slot : null, readySlot: this.readySlot(launch) };
  }
  /** The newest finalized slot creation depends on (the funding, the pair purchase and the setup): the adapter reads chain state at or after it. */
  readySlot(launch) {
    let slot = 0;
    for (const kind of ['funding', 'acquire', 'setup']) for (const op of this.store().operationsFor(launch.id, kind)) { const s = op.state === 'confirmed' ? op.receipt?.slot : null; if (Number.isSafeInteger(s) && s > slot) slot = s; }
    return slot;
  }
  /**
   * SOL the launch wallet must still hold for creation: the verified funding,
   * less the SOL a settled pair purchase spent and every cost the launch ledger
   * recorded since (the purchase's network cost, the setup's rent and fee, and
   * the fees of failed attempts). Each comes from a finalized receipt.
   */
  launchWalletLamports(launch) {
    const r = launch.quote?.conversion?.receipt, spent = (r ? big(r.inputLamports) : 0n) + this.store().balance(launch.id, 'launch').costs, funded = big(launch.funded_lamports);
    return funded > spent ? funded - spent : 0n;
  }
  /** Settles a pair purchase for a SOL-paid dev buy: on success the delivered amount becomes the dev-buy budget in the pair asset. */
  async settleDevBuyConversion(chain, launch, row) {
    const store = this.store(), pair = this.pairOf(launch);
    await this.settleOp(chain, row, (c, r) => c.receipt(this.chainOp(r), r.wallet), ({ state, receipt }) => {
      if (state === 'confirmed') {
        const output = big(receipt.outputAmount), cost = big(receipt.actualSolCostLamports || 0), input = big(row.expected.op.inputAmount), current = store.launch(launch.id);
        if (output <= 0n) throw publicFailure('The finalized purchase delivered none of the pair asset.');
        store.updateLaunch(launch.id, { funded_quote: output.toString(), quote: { ...current.quote, conversion: { ...(current.quote?.conversion || {}), receipt: { inputLamports: input.toString(), outputRaw: output.toString(), costLamports: cost.toString(), signature: row.signature, slot: receipt.slot ?? null } } } });
        store.adjust(launch.id, 'launch', { cost });
        store.addEvent({ launchId: launch.id, kind: 'convert', title: `Bought ${pair.symbol} for your dev buy`, body: `${sol(input)} SOL → ${amountText(output, pair.decimals)} ${pair.symbol}.`, signature: row.signature, isPublic: false });
      } else if (state === 'failed') store.adjust(launch.id, 'launch', { cost: big(receipt?.actualSolCostLamports || 0) });
    });
  }
  /**
   * A SOL-paid dev buy on another pair: the launch wallet buys the pair asset
   * with exactly the dev-buy SOL through the treasury's verified route, under the
   * policy's slippage and price-impact limits, keeping the rest of the funding as
   * a protected reserve. After `maxAttempts` failed purchases the launch is
   * refunded in SOL; nothing was converted. Returns true once the purchase is
   * final (creation can continue in the same pass).
   */
  async convertDevBuy(chain, launch, keys, policy) {
    const store = this.store(), pair = this.pairOf(launch), guard = policy.pairDevBuy, open = this.openOp(launch.id, ['acquire']);
    if (open) { await this.settleDevBuyConversion(chain, launch, open); return store.operation(open.id)?.state === 'confirmed'; }
    if (this.backoff('acquire:' + launch.id)) return false;
    const failures = store.operationsFor(launch.id, 'acquire').filter(op => ['failed', 'expired'].includes(op.state)).length + Number(launch.quote?.conversion?.prepareFailures || 0);
    if (failures >= guard.maxAttempts) { this.failLaunch(launch, 'funded', `Launchpad could not buy ${pair.symbol} for your dev buy within its price limits. Your SOL is being refunded; nothing was converted.`); return false; }
    if (Number(launch.quote?.conversion?.waitFailures || 0) >= PAIR_PURCHASE_MAX_WAITS) { this.failLaunch(launch, 'funded', `Launchpad could not reach the network long enough to buy ${pair.symbol} for your dev buy. Your SOL is being refunded; nothing was converted.`); return false; }
    if (!this.takeSwap()) return false;
    try {
      const funding = launch.plan.funding, budget = big(funding.conversionBudgetLamports || guard.maxNetworkCostLamports), reserve = big(launch.funded_lamports) - big(launch.dev_buy_lamports) - budget;
      if (reserve < 0n) throw publicFailure('The launch funding does not cover the dev-buy purchase.');
      const op = await chain.prepareDevBuyConversion({ wallet: keys.launch, quote: this.chainQuote(launch), lamports: launch.dev_buy_lamports, minSolReserve: reserve, maxNetworkCostLamports: budget, slippageBps: guard.slippageBps, maxImpactBps: guard.maxImpactBps });
      if (op?.kind !== 'acquire' || op.wallet !== launch.launch_wallet || op.mint !== launch.quote_mint || op.inputAmount !== String(launch.dev_buy_lamports)) throw publicFailure('The prepared purchase could not be verified.');
      // The purchase must still guarantee the reviewed minimum. Otherwise it is not sent: Launchpad retries, then refunds the SOL.
      if (big(op.minimumOutput) < big(launch.dev_buy_raw)) throw Object.assign(Error(`${pair.symbol} costs more SOL than when this launch was reviewed, so the purchase cannot guarantee the reviewed ${amountText(launch.dev_buy_raw, pair.decimals)} ${pair.symbol} (now at least ${amountText(op.minimumOutput, pair.decimals)}). Nothing was sent.`), { code: 'PUMP_CLASSIC_SLIPPAGE' });
      const row = this.journal(launch, 'acquire', op, { purpose: 'dev-buy' });
      store.updateLaunch(launch.id, { state_reason: '' });
      store.addEvent({ launchId: launch.id, kind: 'convert', title: `Buying ${pair.symbol} for your dev buy`, body: `${sol(launch.dev_buy_lamports)} SOL, at least ${amountText(op.minimumOutput, pair.decimals)} ${pair.symbol}.`, signature: op.signature, isPublic: false });
      await this.broadcastOp(chain, row);
    } catch (error) {
      // A route outside the limits, a failed simulation or a budget overrun counts toward the SOL refund; the network and the provider wait.
      const wait = !permanentPurchaseError(error), current = store.launch(launch.id), conversion = current.quote?.conversion || {};
      const counted = wait ? failures : failures + 1;
      store.updateLaunch(launch.id, {
        quote: { ...current.quote, conversion: { ...conversion, ...(wait ? { waitFailures: Number(conversion.waitFailures || 0) + 1 } : { prepareFailures: Number(conversion.prepareFailures || 0) + 1 }) } },
        state_reason: wait ? `Launchpad is buying ${pair.symbol} for your dev buy and is waiting on the network or its swap provider. It retries automatically.`
          : `Launchpad could not buy ${pair.symbol} for your dev buy yet (${counted} of ${guard.maxAttempts} tries).${error?.code === 'PUMP_CLASSIC_SLIPPAGE' ? ` ${pair.symbol} costs more SOL than when you reviewed the launch.` : ''} It retries automatically; if it cannot, your SOL is refunded.`,
      });
      this.alert(launch, `Buying ${pair.symbol} for the dev buy is waiting`, `${operatorError(error)} The SOL stays in the launch wallet and Launchpad retries automatically.`);
      this.retryLater('acquire:' + launch.id, error, { base: 30000, max: 600000 });
    }
    return false;
  }
  /** A failed launch whose SOL-paid pair dev buy was bought but whose coin was never created: the asset is still in its launch wallet. */
  needsUnwind(launch) {
    return launch.state === 'failed' && this.solPaidPair(launch) && !launch.create_signature && big(launch.funded_quote || '0') > 0n && launch.quote_refund_state === 'pending' && !['sold', 'returned'].includes(launch.quote?.conversion?.unwind?.state);
  }
  /**
   * The coin was not created after Launchpad bought the pair asset for a SOL-paid
   * dev buy: the launch wallet sells it back to SOL through the same verified
   * route and limits, so the creator's refund is SOL. If that cannot be done in
   * `unwindAttempts` tries, the asset itself is returned with the unused SOL.
   * Returns true when the refunds may continue.
   */
  async unwindDevBuy(chain, launch) {
    const store = this.store(), pair = this.pairOf(launch), guard = this.policyOf(launch).pairDevBuy, maxTries = guard?.unwindAttempts ?? 3, open = this.openOp(launch.id, ['unwind']);
    const mark = fields => { const current = store.launch(launch.id), conversion = current.quote?.conversion || {}; store.updateLaunch(launch.id, { quote: { ...current.quote, conversion: { ...conversion, unwind: { ...(conversion.unwind || {}), ...fields } } } }); };
    if (open) {
      await this.settleOp(chain, open, (c, r) => c.receipt(this.chainOp(r), r.wallet), ({ state, receipt }) => {
        if (state === 'confirmed') {
          mark({ state: 'sold', soldRaw: String(open.expected.op.inputAmount), outputLamports: String(receipt.outputAmount), signature: open.signature, slot: receipt.slot ?? null });
          store.adjust(launch.id, 'launch', { cost: big(receipt.actualSolCostLamports || 0) });
          store.addEvent({ launchId: launch.id, kind: 'convert', title: `Sold the ${pair.symbol} back to SOL`, body: `The coin was not created, so the ${amountText(open.expected.op.inputAmount, pair.decimals)} ${pair.symbol} bought for your dev buy was sold for ${sol(receipt.outputAmount)} SOL. It is refunded with the rest of your funding.`, signature: open.signature });
        } else if (state === 'failed') store.adjust(launch.id, 'launch', { cost: big(receipt?.actualSolCostLamports || 0) });
      });
      return store.operation(open.id)?.state === 'confirmed';
    }
    const unwind = launch.quote?.conversion?.unwind || {};
    const failures = store.operationsFor(launch.id, 'unwind').filter(op => ['failed', 'expired'].includes(op.state)).length + Number(unwind.prepareFailures || 0);
    if (failures >= maxTries) {
      mark({ state: 'returned' });
      store.addEvent({ launchId: launch.id, kind: 'refund', title: `Returning the ${pair.symbol} as is`, body: `Launchpad could not sell the ${pair.symbol} bought for your dev buy back to SOL within its price limits, so it is returned to your wallet together with your unused SOL.` });
      return true;
    }
    if (this.backoff('unwind:' + launch.id)) return false;
    try {
      const held = big((await chain.quoteBalances([launch.launch_wallet], this.chainQuote(launch), { minContextSlot: this.settledSlot(launch) })).balances?.[launch.launch_wallet] ?? 0n);
      if (held === 0n) { mark({ state: 'sold', soldRaw: '0', outputLamports: '0' }); return true; }
      if (!this.takeSwap()) return false;
      const keys = await this.keys(launch);
      const op = await chain.prepareConversion({ wallet: keys.launch, quote: this.chainQuote(launch), amount: held, minSolReserve: '0', maxNetworkCostLamports: guard.maxNetworkCostLamports, guard, priority: true });
      if (op?.kind !== 'convert' || op.wallet !== launch.launch_wallet || op.mint !== launch.quote_mint || op.inputAmount !== held.toString()) throw publicFailure('The prepared sale could not be verified.');
      const row = this.journal(launch, 'unwind', op, { purpose: 'unwind' });
      store.addEvent({ launchId: launch.id, kind: 'convert', title: `Selling the ${pair.symbol} back to SOL`, body: `The coin was not created: ${amountText(held, pair.decimals)} ${pair.symbol} for at least ${sol(op.minimumOutput)} SOL.`, signature: op.signature, isPublic: false });
      await this.broadcastOp(chain, row);
    } catch (error) {
      // Every failed attempt counts, so a refund never waits on the sale for long; afterwards the asset is returned as is.
      mark({ prepareFailures: Number(unwind.prepareFailures || 0) + 1 });
      this.alert(launch, `Selling the ${pair.symbol} back to SOL is waiting`, `${operatorError(error)} The refund waits for it; after ${maxTries} tries the ${pair.symbol} is returned as is.`);
      this.retryLater('unwind:' + launch.id, error, { base: 30000, max: 600000 });
    }
    return false;
  }
  /**
   * A launch on another pair creates its pair accounts before creation (see
   * launchPlan). Returns true once they exist; until then it settles or sends
   * the setup transaction and returns false.
   */
  /** Settles a journaled setup transaction (its rent and fee are launch costs). */
  settleLaunchSetup(chain, launch, open) {
    const store = this.store();
    return this.settleOp(chain, open, (c, r) => c.setupReceipt(this.chainOp(r)), ({ state, receipt }) => {
      if (state === 'confirmed') { store.adjust(launch.id, 'launch', { cost: big(receipt.spentLamports ?? receipt.feeLamports ?? 0n) }); store.addEvent({ launchId: launch.id, kind: 'setup', title: 'Pair accounts created', body: `The ${this.pairOf(launch).symbol} accounts this launch uses were created before the coin.`, signature: open.signature, isPublic: false }); }
      else if (state === 'failed') store.adjust(launch.id, 'launch', { cost: big(receipt?.feeLamports ?? 0n) });
    });
  }
  async launchSetup(chain, launch, keys) {
    const store = this.store(), open = this.openOp(launch.id, ['setup']);
    if (open) {
      const settled = await this.settleLaunchSetup(chain, launch, open);
      // Once final, creation continues in the same pass (reads happen at or after the setup's slot).
      if (settled.state !== 'confirmed') return false;
    }
    // A setup that keeps failing onchain costs fees each time: after three the launch is refunded.
    if (store.operationsFor(launch.id, 'setup').filter(op => op.state === 'failed').length >= 3) { this.failLaunch(launch, 'funded', 'The pair accounts for this launch could not be created. Your funding is being refunded.'); return false; }
    const op = await chain.prepareLaunchSetup({ plan: this.launchPlan(launch), signer: keys.launch });
    if (!op) return true;
    if (op.kind !== 'setup' || op.wallet !== launch.launch_wallet || op.mint !== launch.mint) throw publicFailure('The prepared setup could not be verified.');
    const row = this.journal(launch, 'setup', op, { purpose: 'setup' }); await this.broadcastOp(chain, row, { preflightCommitment: 'confirmed' }); this.burst(row.id);
    return false;
  }
  /** Whether this launch pays its pair dev buy in SOL (policy v3+): Launchpad buys the pair asset after funding. */
  solPaidPair(launch) { return this.isQuote(launch) && pairDevBuyInSol(this.policyOf(launch)); }
  /** The dev-buy amount the creator funds in the pair asset (0 for SOL coins, launches without a dev buy and SOL-paid pair dev buys). */
  fundingTokens(launch) { return this.isQuote(launch) && !this.solPaidPair(launch) ? big(launch.dev_buy_raw) : 0n; }
  /** The dev buy in the coin's quote asset: what the pair purchase delivered once it settled (SOL-paid), else the planned amount. */
  devBuyRaw(launch) { return this.isQuote(launch) ? (this.solPaidPair(launch) && big(launch.funded_quote || '0') > 0n ? big(launch.funded_quote) : big(launch.dev_buy_raw)) : big(launch.dev_buy_lamports); }
  /** A SOL-paid pair dev buy whose pair asset has not been bought yet. */
  needsDevBuyConversion(launch) { return this.solPaidPair(launch) && big(launch.dev_buy_lamports) > 0n && big(launch.funded_quote || '0') === 0n; }
  fundingText(launch) { const pair = this.pairOf(launch), tokens = this.fundingTokens(launch); return `${sol(launch.plan.funding.totalLamports)} SOL${tokens > 0n ? ` and ${amountText(tokens, pair.decimals)} ${pair.symbol}` : ''}`; }
  roleOf(launch, address) { if (address === launch.protocol_wallet) return 'protocol'; if (address === launch.recipient) return ({ creator: 'developer', holders: 'rewards', gotchi: 'gotchi', agent: 'agent', market_maker: 'strategy', lp_manager: 'strategy', diamond_hands: 'rewards', earned: 'escrow', insured: 'insured' })[launch.mode]; return null; }
  policyOf(launch) { return policyFor(launch.policy_hash); }
  // ---- launch options (v71.35: Diamond Hands, Earned, Insured) -------------------------------------
  /** Holders and Diamond Hands: holder rewards for the coin's whole life. */
  holderMode(launch) { return PUMP_CLASSIC_HOLDER_MODES.includes(launch?.mode); }
  /** The ledger role a holder payout pays from: the rewards wallet, the Earned escrow or the Insured pot wallet. */
  rewardRole(launch) { return launch?.mode === 'earned' ? 'escrow' : launch?.mode === 'insured' ? 'insured' : 'rewards'; }
  optionPhase(launch) { return typeof launch?.option?.state?.phase === 'string' ? launch.option.state.phase : null; }
  /** Whether the coin pays holders through the Launchpad-run holder rewards right now. */
  holderPayoutActive(launch) { return this.holderMode(launch) || (launch?.mode === 'earned' && this.optionPhase(launch) === 'failed') || (launch?.mode === 'insured' && ['holders', 'bonus'].includes(this.optionPhase(launch))); }
  /** Coins that keep holder snapshots: holder-reward coins, and every option coin so a refund or failure can pay at once. */
  samplesHolders(launch) { return this.holderMode(launch) || !!launch?.option; }
  /** The option's lifecycle state once the coin is live. Settings came from the quote; nothing here can be changed later. */
  initialOptionState(launch, liveAt) {
    const settings = launch.option?.settings || {};
    switch (launch.mode) {
      case 'diamond_hands': return { phase: 'active', payouts: 0, paidWallets: 0, skippedWallets: 0, lastPayoutAt: null };
      case 'earned': return { phase: 'probation', baseline: null, floor: null, latest: null, probationEndsAt: earnedProbationEnd(liveAt, settings), nextCheckAt: liveAt + this.policyOf(launch).options.earned.checkIntervalMs, checks: [], decidedAt: null };
      case 'insured': return { phase: 'active', deadlineAt: insuredDeadline(liveAt, settings), pot: '0', potCredited: '0', potPaid: '0', potReleased: '0', refundDue: null, decidedAt: null };
      default: return null;
    }
  }
  /** Re-reads the launch, applies `mutate(state, launch)` to its option state and saves it; returns the saved launch (or the unchanged one). */
  updateOption(launch, mutate) {
    const store = this.store(), fresh = store.launch(launch.id); if (!fresh?.option?.state) return fresh || launch;
    const state = structuredClone(fresh.option.state); if (mutate(state, fresh) === false) return fresh;
    return store.updateLaunch(fresh.id, { option: { ...fresh.option, state } });
  }
  /** The coin's market cap in its quote asset's raw units (SOL lamports): the curve's or the pool's spot price times the supply. */
  marketCap(launch, coin) {
    if (!coin?.exists) return null;
    const supply = big(coin.mint?.supply ?? coin.curve?.token_total_supply ?? 0n); if (supply <= 0n) return null;
    const price = coin.venue === 'amm' && coin.pool ? poolPrice({ baseReserve: coin.poolBase, quoteVault: coin.poolQuote, virtualQuoteReserves: coin.pool.virtual_quote_reserves }) : coin.curve ? curvePrice(coin.curve) : 0n;
    return price > 0n ? valueOf(supply, price) : null;
  }
  /** Insured: what the pot wallet owes the developer: its revenue-backed balance beyond the pot. */
  insuredDeveloperDue(launch) { return max0(this.roleAvailable(launch, 'insured') - big(launch.option?.state?.pot || '0')); }
  /** Insured: a holder payout leaves the pot; once a graduation bonus has emptied it, the creator receives every later fee. */
  insuredPaid(launch, paid) {
    this.updateOption(launch, state => {
      state.pot = max0(big(state.pot || '0') - big(paid)).toString(); state.potPaid = (big(state.potPaid || '0') + big(paid)).toString();
      // A payout keeps half the wallet's reserve back; once what is left could not make another payout, the bonus is done and the dust joins the creator's share.
      const reserve = big(launch.plan.funding.modeGasLamports) / 2n, minimum = BigInt(this.policyOf(launch).holders.minimumPayoutLamports);
      if (state.phase === 'bonus' && big(state.pot) - reserve < minimum) { state.phase = 'released'; state.potReleased = (big(state.potReleased || '0') + big(state.pot)).toString(); state.pot = '0'; }
    });
  }
  /** Insured: the coverage share of one recorded creator-fee receipt joins the pot while the pot is still being built (before a graduation settled it). */
  insuredCredit(launch, amount) {
    this.updateOption(launch, (state, fresh) => {
      if (!['active', 'holders'].includes(state.phase)) return false;
      const share = insuredPotShare(amount, fresh.option.settings); if (share <= 0n) return false;
      state.pot = (big(state.pot || '0') + share).toString(); state.potCredited = (big(state.potCredited || '0') + share).toString();
    });
  }

  // ---- funding and creation ------------------------------------------------------------------
  async reconcileFunding(chain) {
    const store = this.store();
    for (const pending of store.launchesInStates(['funding_pending'])) {
      if (this.closed) return;
      try {
        // A funding whose receipt is final waits here only for the coin's vanity address (finishFunding).
        const settled = store.operationsFor(pending.id, 'funding').filter(op => op.state === 'confirmed').at(-1);
        if (settled) { await this.finishFunding(pending, settled); continue; }
        const row = store.operationsFor(pending.id, 'funding').filter(op => OPEN.includes(op.state)).at(-1);
        if (!row) { store.moveLaunch(pending.id, 'funding_pending', pending.quote_expires_at > this.now() ? 'awaiting_funding' : 'expired', { funding_signature: null, state_reason: 'The funding transaction was not found.' }); continue; }
        const launch = pending, tokens = this.fundingTokens(launch);
        await this.settleOp(chain, row, (c, r) => tokens > 0n
          ? c.quoteDepositReceipt({ signature: r.signature, sender: launch.developer_wallet, recipient: launch.launch_wallet, lamports: launch.plan.funding.totalLamports, memo: launch.plan.memo, quote: this.chainQuote(launch), tokenAmount: tokens })
          : c.depositReceipt({ signature: r.signature, sender: launch.developer_wallet, recipient: launch.launch_wallet, lamports: launch.plan.funding.totalLamports, memo: launch.plan.memo }), ({ state, receipt }) => {
          if (state === 'confirmed') {
            // The receipt proves the exact SOL (and pair-asset) amounts, sender, recipient and memo.
            if (tokens > 0n && big(receipt.receivedTokens) !== tokens) throw publicFailure('The finalized funding moved a different amount of the pair asset.');
          } else store.moveLaunch(launch.id, 'funding_pending', launch.quote_expires_at > this.now() ? 'awaiting_funding' : 'expired', { funding_signature: null, state_reason: state === 'failed' ? 'The funding transaction failed onchain. Nothing was received.' : 'The funding transaction expired before it executed. Nothing was received.' });
        });
        const confirmed = store.operation(row.id);
        if (confirmed?.state === 'confirmed' && !this.closed) await this.finishFunding(store.launch(pending.id), confirmed);
      } catch (error) { this.lastError = 'reconcileFunding: ' + operatorError(error); }
    }
  }
  /**
   * The funding is final: the coin's vanity address is switched in (only now,
   * so quotes and fundings that never settle use none), then the launch is funded.
   */
  async finishFunding(launch, op) {
    const store = this.store(), vanity = await this.assignVanity(launch); if (!vanity.ready || this.closed) return;
    const current = vanity.launch, tokens = this.fundingTokens(current), pair = this.pairOf(current), receipt = op.receipt || {};
    if (store.moveLaunch(current.id, 'funding_pending', 'funded', { funded_lamports: String(receipt.receivedAmount), funded_quote: tokens > 0n ? String(receipt.receivedTokens) : '0', funded_at: this.now(), state_reason: '' })) store.addEvent({ launchId: current.id, kind: 'funded', title: 'Funding finalized', body: `${sol(receipt.receivedAmount)} SOL${tokens > 0n ? ` and ${amountText(receipt.receivedTokens, pair.decimals)} ${pair.symbol}` : ''} received for this launch.`, signature: op.signature });
  }
  async createCoins(chain) {
    const store = this.store();
    for (const funded of store.launchesInStates(['funded'])) {
      if (this.closed) return;
      let launch = funded;
      const policy = this.policyOf(launch);
      if (this.now() - (launch.funded_at || 0) > policy.launch.maxFundingAgeMs && !this.openOp(launch.id, ['acquire', 'setup'])) { this.failLaunch(launch, 'funded', 'The coin could not be created in time. Your funding is being refunded.'); continue; }
      if (!this.effective().intake) {
        // Paused: nothing new is prepared, but a purchase or setup already sent is still settled (an operator can then refund).
        const inFlight = this.openOp(launch.id, ['acquire', 'setup']);
        if (inFlight) { try { if (inFlight.kind === 'acquire') await this.settleDevBuyConversion(chain, launch, inFlight); else await this.settleLaunchSetup(chain, launch, inFlight); } catch (error) { this.lastError = 'createCoins: ' + operatorError(error); } }
        continue;
      }
      if (this.backoff('create:' + launch.id)) continue;
      if (launch.create_attempts >= policy.launch.maxCreateAttempts) { this.failLaunch(launch, 'funded', 'Creation did not succeed after repeated checks. Your funding is being refunded.'); continue; }
      if (this.openOp(launch.id, ['launch'])) { store.moveLaunch(launch.id, 'funded', 'creating'); continue; }
      try {
        const keys = await this.keys(launch);
        if (this.needsDevBuyConversion(launch)) {
          // The pair purchase first; once it is final, creation continues in the same pass with what it bought.
          if (!(await this.convertDevBuy(chain, launch, keys, policy))) continue;
          launch = store.launch(launch.id);
          if (launch?.state !== 'funded' || this.needsDevBuyConversion(launch)) continue;
        }
        if (this.isQuote(launch) && !(await this.launchSetup(chain, launch, keys))) continue;
        const priorityMicroLamports = Math.max(Number(policy.costs.priorityMicroLamports) || 0, await chain.priorityPrice([launch.launch_wallet]));
        const op = await chain.prepareLaunch({ plan: this.launchPlan(launch), signers: { launch: keys.launch, mint: keys.mint }, tolerancePpm: policy.launch.tokenTolerancePpm, computeUnits: policy.costs.computeUnits, priorityMicroLamports });
        if (this.closed) return;
        if (op.kind !== 'launch' || op.wallet !== launch.launch_wallet || op.mint !== launch.mint) throw publicFailure('The prepared launch could not be verified.');
        const row = store.db.transaction(() => store.moveLaunch(launch.id, 'funded', 'creating', { create_attempts: launch.create_attempts + 1, state_reason: '' }) ? this.journal(launch, 'launch', op) : null);
        if (!row) continue;
        store.addEvent({ launchId: launch.id, kind: 'creating', title: 'Creating on Pump.fun', body: `Atomic create, fee sharing and dev buy of ${op.expected.tokens} raw tokens, paired with ${this.pairOf(launch).symbol}.`, signature: op.signature, isPublic: false });
        await this.broadcastOp(chain, row); this.burst(row.id);
      } catch (error) {
        // A pair Pump no longer admits, or a creator fee it no longer accepts, cannot succeed on retry: those count toward the refund too.
        const deterministic = (['PUMP_CLASSIC_QUOTE_MOVED', 'PUMP_CLASSIC_SIMULATION', 'PUMP_CLASSIC_SIZE', 'PUMP_CLASSIC_GLOBAL', 'PUMP_CLASSIC_QUOTE_ASSET', 'PUMP_CLASSIC_CREATOR_FEE'].includes(error?.code) || /simulation/i.test(String(error?.message))) && !rpcLag(error);
        if (error?.code === 'PUMP_CLASSIC_EXISTS') { this.alert(launch, 'Coin already exists onchain', 'Creation stopped. An operator must reconcile this launch.'); this.retryLater('create:' + launch.id, error, { base: 600000 }); continue; }
        if (deterministic) { store.updateLaunch(launch.id, { create_attempts: launch.create_attempts + 1, state_reason: error?.pumpClassicPublic === true || error?.statusCode ? safeError(error) : `The launch check failed (attempt ${launch.create_attempts + 1} of ${policy.launch.maxCreateAttempts}). Launchpad retries it automatically; nothing was sent.` }); this.alert(launch, `Creation check failed (attempt ${launch.create_attempts + 1} of ${policy.launch.maxCreateAttempts})`, operatorError(error)); }
        this.retryLater('create:' + launch.id, error);
      }
    }
  }
  failLaunch(launch, from, reason) { const store = this.store(); if (store.moveLaunch(launch.id, from, 'failed', { state_reason: reason, refund_state: 'pending', ...(this.isQuote(launch) ? { quote_refund_state: 'pending' } : {}) })) store.addEvent({ launchId: launch.id, kind: 'failed', title: 'Launch failed', body: reason }); }
  async reconcileCreation(chain) {
    const store = this.store();
    for (const launch of store.launchesInStates(['creating'])) {
      if (this.closed) return;
      const row = store.operationsFor(launch.id, 'launch').at(-1);
      if (!row || ['expired', 'failed', 'superseded'].includes(row.state)) { store.moveLaunch(launch.id, 'creating', 'funded', { state_reason: row?.state === 'failed' ? 'The creation transaction failed; it will be checked again.' : '' }); if (row?.state === 'expired') store.updateLaunch(launch.id, { create_attempts: Math.max(0, launch.create_attempts - 1) }); continue; }
      if (row.state === 'confirmed') { this.markCreated(launch, row, row.receipt); continue; }
      await this.settleOp(chain, row, (c, r) => c.launchReceipt(this.chainOp(r), this.launchPlan(launch)), ({ state, receipt }) => {
        if (state === 'confirmed') this.markCreated(launch, row, receipt);
        else if (state === 'failed') { store.adjust(launch.id, 'launch', { cost: big(receipt?.feeLamports ?? 0n) }); store.moveLaunch(launch.id, 'creating', 'funded', { state_reason: 'The creation transaction failed onchain; nothing was created.' }); this.alert(launch, 'Creation transaction failed', JSON.stringify(jsonable(receipt?.error) || '').slice(0, 200)); }
        else store.moveLaunch(launch.id, 'creating', 'funded', { create_attempts: Math.max(0, launch.create_attempts - 1), state_reason: '' });
      });
    }
  }
  markCreated(launch, row, receipt) {
    const store = this.store(), seed = big(launch.seed_lamports);
    const moved = store.db.transaction(() => {
      // A separate delivery (launches on another pair) leaves the dev-buy tokens with the launch wallet until deliver() sends them.
      const separate = row.expected?.op?.expected?.delivery === 'separate', tokens = big(receipt?.tokens ?? row.expected.op.expected.tokens);
      const liveAt = this.now(), option = launch.option ? { ...launch.option, state: this.initialOptionState(launch, liveAt) } : null;
      if (!store.moveLaunch(launch.id, 'creating', 'created', { create_signature: row.signature, created_slot: receipt?.slot ?? null, live_at: liveAt, dev_tokens: tokens.toString(), delivery_state: tokens > 0n ? (separate ? 'pending' : 'complete') : 'none', fee_state: 'pending', refund_state: 'pending', ...(this.isQuote(launch) ? { quote_refund_state: 'pending' } : {}), shareholders: launch.plan.shareholders, venue_state: 'curve', state_reason: '', ...(option ? { option } : {}) })) return false;
      if (isStrategyMode(launch.mode)) { store.ensureStrategy(launch.id, launch.mode, launch.mode_wallet); if (seed > 0n) store.creditStrategy(launch.id, `seed:${launch.id}`, seed, 'seed'); store.updateStrategy(launch.id, { observed: launch.mode === 'lp_manager' ? 'waiting_for_graduation' : 'waiting_for_fees' }); }
      return true;
    });
    if (!moved) return;
    store.adjust(launch.id, 'launch', { cost: big(receipt?.feeLamports ?? 0n) });
    const separate = row.expected?.op?.expected?.delivery === 'separate';
    store.addEvent({ launchId: launch.id, kind: 'live', title: 'Live on Pump.fun', body: (this.devBuyRaw(launch) > 0n ? (separate ? 'Coin created with your dev buy in the same transaction. Your tokens are delivered next.' : 'Coin created and dev-buy tokens delivered in one transaction.') : 'Coin created.') + (this.isQuote(launch) ? ` Paired with ${this.pairOf(launch).symbol}.` : ''), signature: row.signature });
    if (launch.option) store.addEvent({ launchId: launch.id, kind: 'option', title: `${PUMP_CLASSIC_MODE_LABELS[launch.mode]} rules in force`, body: describePumpOption(launch.mode, launch.option.settings) });
  }
  /**
   * Sends the dev-buy tokens a launch on another pair left with its launch
   * wallet (separate delivery) to the developer, and closes that token account.
   * Refunds wait for it: the launch wallet pays this transaction.
   */
  async deliver(chain) {
    const store = this.store();
    for (const launch of store.liveLaunches()) {
      if (this.closed) return;
      if (launch.delivery_state !== 'pending' || this.backoff('deliver:' + launch.id)) continue;
      const open = this.openOp(launch.id, ['deliver']);
      if (open) {
        await this.settleOp(chain, open, (c, r) => c.deliveryReceipt(this.chainOp(r), this.launchPlan(launch)), ({ state, receipt }) => {
          if (state === 'confirmed') {
            store.updateLaunch(launch.id, { delivery_state: 'complete', dev_tokens: String(receipt.tokens ?? launch.dev_tokens) });
            store.adjust(launch.id, 'launch', { cost: big(receipt.feeLamports ?? 0n) });
            store.addEvent({ launchId: launch.id, kind: 'delivered', title: 'Dev-buy tokens delivered', body: `${wholeTokens(receipt.tokens ?? launch.dev_tokens)} ${launch.symbol} sent to ${launch.developer_wallet}.`, signature: open.signature });
          } else if (state === 'failed') store.adjust(launch.id, 'launch', { cost: big(receipt?.feeLamports ?? 0n) });
        });
        continue;
      }
      try {
        const keys = await this.keys(launch);
        const op = await chain.prepareDelivery({ plan: this.launchPlan(launch), signer: keys.launch, tokens: launch.dev_tokens });
        if (op.kind !== 'deliver' || op.wallet !== launch.launch_wallet || op.recipient !== launch.developer_wallet || op.mint !== launch.mint || big(op.inputAmount) < big(launch.dev_tokens)) throw publicFailure('The prepared delivery could not be verified.');
        const row = this.journal(launch, 'deliver', op, { purpose: 'deliver' }); await this.broadcastOp(chain, row, { preflightCommitment: 'confirmed' }); this.burst(row.id);
      } catch (error) {
        this.alert(launch, 'Dev-buy delivery is waiting', `${operatorError(error)} The tokens stay in this coin's launch wallet and the delivery retries automatically.`);
        this.retryLater('deliver:' + launch.id, error);
      }
    }
  }
  async refunds(chain) {
    const store = this.store();
    for (const launch of store.launchesInStates(['created', 'failed', 'refunded'])) {
      if (this.closed) return;
      // The launch wallet pays the dev-buy delivery, so refunds wait for it. A pair purchase or setup still in flight settles first.
      if (launch.delivery_state === 'pending') continue;
      const inFlight = this.openOp(launch.id, ['acquire', 'setup']);
      if (inFlight) { if (inFlight.kind === 'acquire') await this.settleDevBuyConversion(chain, launch, inFlight); else await this.settleLaunchSetup(chain, launch, inFlight); continue; }
      const pairOpen = this.isQuote(launch) && ['pending', 'released'].includes(launch.quote_refund_state);
      if ((launch.refund_state !== 'pending' && !pairOpen) || this.backoff('refund:' + launch.id)) continue;
      // A SOL-paid dev buy whose coin was never created: the pair asset is sold back to SOL first.
      if (this.needsUnwind(launch) && !(await this.unwindDevBuy(chain, launch))) continue;
      // Another pair: the pair asset goes back first (its account closes and its rent joins the SOL refund). If an
      // operator released the SOL refund because the pair asset could not be moved, SOL goes first (keeping a small
      // reserve) and the pair refund keeps retrying.
      if (pairOpen && (launch.quote_refund_state === 'pending' || launch.refund_state !== 'pending')) { await this.refundQuote(chain, launch); continue; }
      const keep = this.isQuote(launch) && launch.quote_refund_state === 'released' ? PAIR_REFUND_RESERVE : 0n;
      const open = store.operationsFor(launch.id, 'withdraw').filter(op => op.expected?.purpose === 'refund').at(-1);
      if (open && OPEN.includes(open.state)) {
        await this.settleOp(chain, open, (c, r) => c.receipt(this.chainOp(r), r.wallet), ({ state, receipt }) => {
          if (state === 'confirmed') {
            store.updateLaunch(launch.id, { refund_state: 'complete', refund_signature: open.signature, refunded_lamports: (big(launch.refunded_lamports) + big(open.expected.op.inputAmount)).toString() });
            store.adjust(launch.id, 'launch', { debit: big(open.expected.op.inputAmount), cost: big(receipt.actualSolCostLamports || 0) });
            store.addEvent({ launchId: launch.id, kind: 'refund', title: 'Unused funding refunded', body: `${sol(open.expected.op.inputAmount)} SOL returned to ${launch.developer_wallet}.`, signature: open.signature });
            if (launch.state === 'failed') store.moveLaunch(launch.id, 'failed', 'refunded');
          } else if (state === 'failed') store.adjust(launch.id, 'launch', { cost: big(receipt?.actualSolCostLamports || 0) });
        });
        continue;
      }
      try {
        const keys = await this.keys(launch);
        const op = await chain.prepareDrain({ wallet: keys.launch, recipient: launch.developer_wallet, keepLamports: keep, minContextSlot: this.settledSlot(launch) });
        if (op.wallet !== launch.launch_wallet || op.recipient !== launch.developer_wallet) throw publicFailure('The prepared refund could not be verified.');
        const row = this.journal(launch, 'withdraw', op, { purpose: 'refund', keepLamports: keep.toString() }); await this.broadcastOp(chain, row);
      } catch (error) {
        if (error?.code === 'PUMP_CLASSIC_EMPTY' || error?.code === 'PUMP_CLASSIC_REFUND') { store.updateLaunch(launch.id, { refund_state: big(launch.refunded_lamports) > 0n ? 'complete' : 'not_needed' }); continue; }
        this.retryLater('refund:' + launch.id, error);
      }
    }
  }
  /**
   * The newest finalized slot among this launch's settled transactions (and its
   * creation). Refunds read the launch wallet at or after it, so a lagging RPC
   * node can never show a balance from before a purchase, setup, sale or refund.
   */
  settledSlot(launch) {
    let slot = Number.isSafeInteger(launch.created_slot) ? launch.created_slot : 0;
    for (const op of this.store().operationsFor(launch.id)) { const s = op.state === 'confirmed' ? op.receipt?.slot : null; if (Number.isSafeInteger(s) && s > slot) slot = s; }
    return slot;
  }
  pairAccountSlot(launch) { return this.settledSlot(launch); }

  async refundQuote(chain, launch) {
    const store = this.store(), pair = this.pairOf(launch), open = store.operationsFor(launch.id, 'quote-refund').filter(op => OPEN.includes(op.state)).at(-1);
    if (open) {
      await this.settleOp(chain, open, (c, r) => c.quoteRefundReceipt(this.chainOp(r)), ({ state, receipt }) => {
        if (state === 'confirmed') {
          const refunded = big(receipt.refunded ?? open.expected.op.inputAmount), released = launch.quote_refund_state === 'released';
          // After a released SOL refund the kept reserve (and the closed account's rent) is refunded by one more drain.
          store.updateLaunch(launch.id, { quote_refund_state: 'complete', quote_refund_signature: open.signature, refunded_quote: refunded.toString(), ...(released ? { refund_state: 'pending' } : {}) });
          store.adjust(launch.id, 'launch', { cost: big(receipt.feeLamports ?? 0n) });
          store.addEvent({ launchId: launch.id, kind: 'refund', title: refunded > 0n ? `Unused ${pair.symbol} refunded` : 'Launch token account closed', body: refunded > 0n ? `${amountText(refunded, pair.decimals)} ${pair.symbol} returned to ${launch.developer_wallet}.` : `The launch wallet’s empty ${pair.symbol} account was closed; its rent joins the SOL refund.`, signature: open.signature });
        } else if (state === 'failed') store.adjust(launch.id, 'launch', { cost: big(receipt?.feeLamports ?? 0n) });
      });
      return;
    }
    try {
      const keys = await this.keys(launch);
      const op = await chain.prepareQuoteRefund({ wallet: keys.launch, recipient: launch.developer_wallet, quote: this.chainQuote(launch), decimals: pair.decimals, minContextSlot: this.pairAccountSlot(launch) });
      if (op.kind !== 'quote-refund' || op.wallet !== launch.launch_wallet || op.recipient !== launch.developer_wallet || op.mint !== launch.quote_mint) throw publicFailure('The prepared refund could not be verified.');
      const row = this.journal(launch, 'quote-refund', op, { purpose: 'quote-refund' }); await this.broadcastOp(chain, row);
    } catch (error) {
      if (error?.code === 'PUMP_CLASSIC_NO_QUOTE') {
        // Only a launch that never held the pair asset may skip this step: no pair funding and never created
        // (creation opens the account). Anything else keeps retrying; an operator can release the SOL refund.
        if (big(launch.funded_quote || '0') === 0n && !launch.create_signature) { store.updateLaunch(launch.id, { quote_refund_state: 'not_needed' }); return; }
        this.alert(launch, 'The launch wallet’s pair account is not visible', 'The pair refund retries and the SOL refund waits for it. An operator can release the SOL refund if the pair asset cannot be returned.');
      } else this.alert(launch, 'The pair refund is waiting', `${operatorError(error)} The SOL refund waits for it; an operator can release the SOL refund if the pair asset cannot be returned.`);
      this.retryLater('refund:' + launch.id, error);
    }
  }

  // ---- live coins: venue, fee setup, collection and the receipt journal ----------------------
  async trackVenues(chain) {
    const store = this.store();
    for (const launch of store.liveLaunches()) {
      if (this.closed) return;
      if ((launch.venue_state === 'amm' && launch.fee_state === 'verified') || this.throttle('venue:' + launch.id, 60000)) continue;
      try {
        if (launch.fee_state === 'pending') {
          const { ok, coin } = await chain.verifyCoinSetup(this.launchPlan(launch));
          store.updateLaunch(launch.id, { fee_state: ok ? 'verified' : 'mismatch' });
          if (ok) store.addEvent({ launchId: launch.id, kind: 'fees', title: 'Fee recipients verified', body: 'Pump.fun fee sharing is set to this coin’s recorded recipients and can no longer be changed by its admin.' });
          else this.alert(launch, 'Fee recipients differ from the plan', 'Collection and routing stay paused for this coin until an operator reviews it.');
          if (coin && coin.venue !== launch.venue_state) this.venueChanged(launch, coin);
          continue;
        }
        const coin = await chain.readCoin(launch.mint, { quote: this.chainQuote(launch) }); if (!coin.exists) continue;
        if (coin.venue !== launch.venue_state) this.venueChanged(launch, coin);
      } catch (error) { this.retryLater('venue:' + launch.id, error); }
    }
  }
  venueChanged(launch, coin) {
    const store = this.store(), fields = { venue_state: coin.venue };
    if (coin.venue === 'amm') { fields.pool = coin.pool.address; fields.graduated_at = this.now(); }
    store.updateLaunch(launch.id, fields);
    store.addEvent({ launchId: launch.id, kind: 'venue', title: coin.venue === 'amm' ? 'Graduated to PumpSwap' : coin.venue === 'migrating' ? 'Bonding curve complete' : 'On the bonding curve', body: coin.venue === 'amm' ? `Canonical PumpSwap pool ${coin.pool.address} verified onchain.` : coin.venue === 'migrating' ? 'Waiting for Pump’s migration to the canonical PumpSwap pool.' : '' });
    if (coin.venue === 'amm' && launch.mode === 'insured') this.insuredGraduated(launch);
  }
  /**
   * Insured: a graduation before the deadline settles the pot the way the creator chose: released to the developer
   * (it joins the next sweep) or paid to holders as a bonus (a payout starts at once). After the deadline the coverage
   * share already belongs to holders and a later graduation changes nothing.
   */
  insuredGraduated(launch) {
    const store = this.store(); let outcome = null;
    this.updateOption(launch, state => {
      if (state.phase !== 'active') return false;
      const target = insuredGraduationTarget(launch.option.settings), pot = big(state.pot || '0');
      state.decidedAt = this.now();
      if (target === 'developer') { state.phase = 'released'; state.potReleased = (big(state.potReleased || '0') + pot).toString(); state.pot = '0'; outcome = { target, pot }; }
      else { state.phase = 'bonus'; state.refundDue = 'bonus'; outcome = { target, pot }; }
    });
    if (!outcome) return;
    store.addEvent({ launchId: launch.id, kind: 'option', title: 'Graduated in time', body: outcome.target === 'developer' ? `The refund pot (${sol(outcome.pot)} SOL) is released to the creator, who now receives every creator fee.` : `The refund pot (${sol(outcome.pot)} SOL) is paid to holders as a graduation bonus; the creator receives every later creator fee.` });
  }
  async collect(chain) {
    const store = this.store();
    for (const launch of store.liveLaunches()) {
      if (this.closed) return;
      const policy = this.policyOf(launch), quote = this.chainQuote(launch), open = this.openOp(launch.id, ['distribute']);
      // On another pair the payer also opens shareholder token accounts: its whole SOL change is the cost.
      if (open) { await this.settleOp(chain, open, (c, r) => c.distributionReceipt(r.signature, { mint: launch.mint, quote }).then(x => x && { ...x, state: x.failed ? 'failed' : 'confirmed' }), ({ state, receipt }) => { if (state !== 'expired') store.adjust(launch.id, 'protocol', { cost: quote && receipt?.payerLamportDelta !== undefined ? max0(-big(receipt.payerLamportDelta)) : big(receipt?.feeLamports ?? 0n) }); }); continue; }
      if (!this.effective().collection || launch.fee_state !== 'verified' || this.backoff('collect:' + launch.id)) continue;
      // A holder payout collects on its own step (holders()), without waiting for the interval.
      if (this.payoutRequest(launch)?.stage === 'collect' || this.throttle('collect:' + launch.id, policy.collection.intervalMs)) continue;
      try {
        const coin = await chain.readCoin(launch.mint, { quote }); if (!coin.exists) continue;
        if (coin.venue !== launch.venue_state) this.venueChanged(launch, coin);
        if (coin.fees.total < this.collectionThreshold(launch)) continue;
        await this.sendDistribution(chain, launch, coin);
      } catch (error) { this.collectFailed(launch, error); }
    }
  }
  /** Pending fees worth collecting (scaled into the pair's units): the policy minimum, or for a holder payout only what covers its network cost. */
  collectionThreshold(launch, { payout = false } = {}) {
    const c = this.policyOf(launch).collection, network = 5000n * BigInt(c.minimumNetworkMultiple), minimum = BigInt(c.minimumLamports);
    return this.quoteThreshold(launch, payout || network > minimum ? network : minimum);
  }
  /** Journals and broadcasts one creator-fee distribution of a coin (the permissionless crank, paid by the platform receipt wallet). */
  async sendDistribution(chain, launch, coin) {
    const keys = await this.keys(launch), quote = this.chainQuote(launch);
    const op = await chain.prepareDistribution({ wallet: keys.protocol, mint: launch.mint, shareholders: launch.shareholders, includeAmm: coin.venue === 'amm' && coin.fees.amm > 0n, quote });
    if (op.wallet !== launch.protocol_wallet || op.mint !== launch.mint) throw publicFailure('The prepared distribution could not be verified.');
    const row = this.journal(launch, 'distribute', op, { pending: coin.fees.total.toString() }); await this.broadcastOp(chain, row);
    return row;
  }
  collectFailed(launch, error) {
    if (error?.code === 'PUMP_CLASSIC_RECIPIENT_CLOSED') this.alert(launch, 'A fee recipient wallet is closed', 'Distribution waits until every recipient wallet holds SOL again.');
    if (error?.code !== 'PUMP_CLASSIC_NOTHING') this.retryLater('collect:' + launch.id, error, { base: 60000 });
  }
  /**
   * The append-only receipt journal. Every distribution of this coin pays the
   * per-coin protocol wallet, so its finalized history (ours and other callers'
   * permissionless distributions alike) is scanned once, in order, from a
   * durable cursor. Each (signature, event, recipient) is recorded exactly once.
   */
  async scanReceipts(chain) {
    const store = this.store();
    for (const launch of store.liveLaunches()) {
      if (this.closed) return;
      if (this.backoff('scan:' + launch.id) || this.throttle('scan:' + launch.id, 45000)) continue;
      try {
        const cursor = store.cursor(launch.id, 'protocol-history'), { rows, complete } = await chain.signaturesFor(launch.protocol_wallet, { until: cursor }), quote = this.chainQuote(launch);
        if (!complete) { this.alert(launch, 'Receipt history is longer than one scan', 'The journal cursor is kept; an operator can run a backfill.'); continue; }
        for (const sig of rows) {
          if (this.closed) return;
          if (!sig.failed) {
            const receipt = await chain.distributionReceipt(sig.signature, { mint: launch.mint, quote });
            if (!receipt) break;
            let recorded = 0;
            for (const leg of receipt.legs) { const role = this.roleOf(launch, leg.recipient); if (!role) continue; if (store.recordFeeReceipt({ launchId: launch.id, mint: launch.mint, signature: sig.signature, eventIndex: leg.eventIndex, recipient: leg.recipient, role, amount: leg.amount, distributed: leg.distributed, slot: receipt.slot, blockTime: receipt.blockTime, caller: receipt.payer, ours: receipt.payer === launch.protocol_wallet, quoteMint: launch.quote_mint || SOL })) { recorded++; if (role === 'insured') this.insuredCredit(launch, leg.amount); } }
            if (receipt.anomalies.length) this.alert(launch, 'A distribution needs review', `Signature ${sig.signature}: a recipient's balance change did not match its share.`);
            if (recorded) store.addEvent({ launchId: launch.id, kind: 'fees', title: 'Creator fees distributed', body: receipt.payer === launch.protocol_wallet ? 'Collected by Launchpad.' : 'Distributed by another caller (permissionless).', signature: sig.signature });
          }
          store.setCursor(launch.id, 'protocol-history', sig.signature);
        }
      } catch (error) { this.retryLater('scan:' + launch.id, error, { base: 60000 }); }
    }
  }
  /** Revenue-backed balance of a role: receipts minus sweeps minus costs beyond its funded gas. */
  roleAvailable(launch, role) {
    const b = this.store().balance(launch.id, role), plan = launch.plan.funding;
    const gas = role === 'protocol' ? big(plan.collectorGasLamports) : big(plan.modeGasLamports);
    return max0(b.credited - b.debited - max0(b.costs - gas));
  }

  // ---- conversion of pair-asset shares to SOL (coins on another pair) -----------------------------------
  /**
   * Roles whose pair-asset share Launchpad holds and converts: the platform share and the Gotchi share. Holder rewards
   * are paid in the pair asset (v71.24); holders() sells only the little a payout needs for accounts and fees.
   */
  convertRoles(launch) { return ['protocol', ...(launch.mode === 'gotchi' ? ['gotchi'] : [])]; }
  /**
   * Converts receipt-backed pair-asset shares in a per-coin Launchpad wallet to SOL
   * through the treasury's verified route (exact input, simulated minimum
   * output). The SOL a finalized conversion adds is credited to the same role,
   * where routing uses it exactly as on a SOL coin. Both shares convert under
   * the sweeps flag. Every open conversion settles here, including the small
   * sale a holder payout makes for its costs.
   */
  async convert(chain) {
    const store = this.store();
    for (const launch of store.liveLaunches()) {
      if (this.closed) return;
      if (!this.isQuote(launch)) continue;
      const open = this.openOp(launch.id, ['convert']);
      if (open) { await this.settleConversion(chain, launch, open); continue; }
      const policy = this.policyOf(launch), flags = this.effective();
      if (launch.fee_state !== 'verified' || !policy.conversion || this.backoff('convert:' + launch.id)) continue;
      const roles = flags.routing ? this.convertRoles(launch) : [], minimum = this.quoteThreshold(launch, policy.conversion.minimumLamports);
      const due = roles.filter(role => { const b = store.quoteBalance(launch.id, role).available; return b > 0n && b >= minimum; });
      if (!due.length || this.throttle('convert:' + launch.id, policy.conversion.intervalMs)) continue;
      for (const role of due) {
        try {
          const wallet = role === 'protocol' ? launch.protocol_wallet : launch.mode_wallet, available = store.quoteBalance(launch.id, role).available;
          const { balances } = await chain.quoteBalances([wallet], this.chainQuote(launch)), held = big(balances[wallet]), amount = minBig(available, held);
          if (held < available) this.alert(launch, 'A fee wallet holds less of the pair asset than its receipts', `The ${role} wallet holds ${amountText(held, launch.quote_decimals)} ${launch.quote_symbol}; recorded receipts are ${amountText(available, launch.quote_decimals)}. Only the held amount is converted.`);
          if (amount < minimum || amount <= 0n) continue;
          if (!this.takeSwap()) return;
          const keys = await this.keys(launch), signer = role === 'protocol' ? keys.protocol : keys.mode;
          const op = await chain.prepareConversion({ wallet: signer, quote: this.chainQuote(launch), amount, minSolReserve: '0', maxNetworkCostLamports: policy.conversion.maxNetworkCostLamports });
          if (op?.kind !== 'convert' || op.wallet !== wallet || op.mint !== launch.quote_mint || op.inputAmount !== amount.toString()) throw publicFailure('The prepared conversion could not be verified.');
          const conversionId = newId('cv'), row = store.db.transaction(() => { const r = this.journal(launch, 'convert', op, { purpose: 'convert', role, conversionId }); store.insertConversion({ id: conversionId, launchId: launch.id, role, operationId: r.id, signature: op.signature, wallet, quoteMint: launch.quote_mint, input: amount }); return r; });
          await this.broadcastOp(chain, row); break;
        } catch (error) {
          this.alert(launch, 'Conversion to SOL is waiting', `${operatorError(error)} The ${launch.quote_symbol} stays in the coin’s Launchpad wallet and is retried automatically.`);
          this.retryLater('convert:' + launch.id, error, { base: 300000 }); break;
        }
      }
    }
  }
  async settleConversion(chain, launch, row) {
    const store = this.store(), conversion = store.conversionForOperation(row.id), role = row.expected.role, pair = this.pairOf(launch);
    await this.settleOp(chain, row, (c, r) => c.receipt(this.chainOp(r), r.wallet), ({ state, receipt }) => {
      if (state === 'confirmed') {
        // The treasury receipt proves the exact input left and reports the net SOL the wallet gained (after its network cost).
        const input = big(row.expected.op.inputAmount), output = big(receipt.outputAmount);
        if (output <= 0n) throw publicFailure('The finalized conversion produced no SOL.');
        store.updateConversion(conversion.id, { state: 'confirmed', output: output.toString(), fee: String(receipt.actualSolCostLamports || '0'), slot: receipt.slot ?? null });
        store.adjustQuote(launch.id, role, { converted: input });
        store.adjust(launch.id, role, { credit: output });
        const gas = row.expected.purpose === 'payout-gas', basketSell = row.expected.purpose === 'basket-sell';
        if (basketSell) this.noteBasketLeg(launch, row.expected.legIndex, { solRaw: output.toString(), sold: true, state: 'queued', opId: null });
        store.addEvent({ launchId: launch.id, kind: 'convert', title: gas ? 'Sold for holder accounts and network fees' : basketSell ? 'Reward share sold for a basket asset' : role === 'protocol' ? 'Platform share converted to SOL' : role === 'rewards' ? 'Holder rewards converted to SOL' : 'Gotchi share converted to SOL', body: `${amountText(input, pair.decimals)} ${pair.symbol} → ${sol(output)} SOL.`, signature: row.signature, isPublic: !gas });
      } else if (state === 'failed') { store.updateConversion(conversion.id, { state: 'failed', fee: String(receipt?.actualSolCostLamports || '0') }); store.adjust(launch.id, role, { cost: big(receipt?.actualSolCostLamports || 0) }); if (row.expected.purpose === 'basket-sell') this.basketLegFailed(launch, row.expected.legIndex, 'The sale of the share did not land.'); }
      else { store.updateConversion(conversion.id, { state: 'expired' }); if (row.expected.purpose === 'basket-sell') this.basketLegFailed(launch, row.expected.legIndex, 'The sale of the share expired.'); }
    });
  }

  // ---- routing ------------------------------------------------------------------------------------
  async destination(launch, role) {
    if (role === 'protocol') { const value = typeof this.protocolRecipient === 'function' ? await this.protocolRecipient() : null; return isAddress(value) && isOnCurve(value) ? value : null; }
    if (role === 'gotchi') return launch.gotchi?.vault || null;
    if (role === 'agent') return launch.agent?.wallet || null;
    // Earned: the escrow reaches the developer only once the coin passed its probation. Insured: the developer's part of every receipt.
    if (role === 'escrow') return this.optionPhase(launch) === 'earned' && isAddress(launch.developer_wallet) ? launch.developer_wallet : null;
    if (role === 'insured') return isAddress(launch.developer_wallet) ? launch.developer_wallet : null;
    return null;
  }
  /** Roles whose revenue-backed balance is swept to a destination (per coin, in order). */
  sweepRoles(launch) { return ['protocol', ...(['gotchi', 'agent'].includes(launch.mode) ? [launch.mode] : []), ...(launch.mode === 'earned' ? ['escrow'] : []), ...(launch.mode === 'insured' ? ['insured'] : [])]; }
  /** What a sweep may take from a role: everything revenue-backed, except the Insured pot, which stays for holders. */
  sweepable(launch, role) { return role === 'insured' ? this.insuredDeveloperDue(launch) : this.roleAvailable(launch, role); }
  async route(chain) {
    const store = this.store();
    for (const launch of store.liveLaunches()) {
      if (this.closed) return;
      const policy = this.policyOf(launch);
      const open = store.operationsFor(launch.id, 'withdraw').filter(op => op.expected?.purpose === 'sweep' && OPEN.includes(op.state)).at(-1);
      if (open) { await this.settleSweep(chain, launch, open); continue; }
      if (!this.effective().routing || launch.fee_state !== 'verified' || this.backoff('route:' + launch.id)) continue;
      for (const role of this.sweepRoles(launch)) {
        try {
          const to = await this.destination(launch, role); if (!to) continue;
          const available = this.sweepable(launch, role); if (available < BigInt(policy.routing.sweepMinimumLamports)) continue;
          const wallet = role === 'protocol' ? launch.protocol_wallet : launch.mode_wallet, keep = BigInt(policy.routing.keepLamports) > BigInt(policy.collection.gasFloatLamports) ? BigInt(policy.routing.keepLamports) : BigInt(policy.collection.gasFloatLamports);
          const { balances } = await chain.walletBalances([wallet]), onchain = balances[wallet] - keep - 10000n;
          const amount = minBig(available, onchain); if (amount < BigInt(policy.routing.sweepMinimumLamports)) continue;
          const keys = await this.keys(launch), signer = role === 'protocol' ? keys.protocol : keys.mode;
          const op = await chain.prepareWithdrawal({ kind: 'withdraw', wallet: signer, mint: SOL, amount: amount.toString(), recipient: to, minSolReserve: keep.toString(), maxNetworkCostLamports: '50000' });
          if (op.wallet !== wallet || op.recipient !== to || op.inputAmount !== amount.toString()) throw publicFailure('The prepared sweep could not be verified.');
          const sweepId = newId('sw'), row = store.db.transaction(() => { const r = this.journal(launch, 'withdraw', op, { purpose: 'sweep', role, sweepId }); store.insertSweep({ id: sweepId, launchId: launch.id, kind: role, operationId: r.id, signature: op.signature, from: wallet, to, amount, state: 'pending' }); return r; });
          await this.broadcastOp(chain, row); break;
        } catch (error) { this.retryLater('route:' + launch.id, error, { base: 60000 }); break; }
      }
    }
  }
  async settleSweep(chain, launch, row) {
    const store = this.store(), sweep = store.sweepForOperation(row.id), role = row.expected.role;
    await this.settleOp(chain, row, (c, r) => c.receipt(this.chainOp(r), r.wallet), ({ state, receipt }) => {
      if (state === 'confirmed') {
        store.updateSweep(sweep.id, { state: 'confirmed', slot: receipt.slot ?? null, fee: String(receipt.actualSolCostLamports || '0') });
        store.adjust(launch.id, role, { debit: big(row.expected.op.inputAmount), cost: big(receipt.actualSolCostLamports || 0) });
        store.addEvent({ launchId: launch.id, kind: 'route', title: role === 'protocol' ? 'Platform share routed' : role === 'gotchi' ? 'Sent to the Gotchi pot' : role === 'escrow' ? 'Escrow released to the creator' : role === 'insured' ? 'Creator share paid' : 'Sent to the agent', body: `${sol(row.expected.op.inputAmount)} SOL.`, signature: row.signature });
      } else if (state === 'failed') { store.updateSweep(sweep.id, { state: 'failed', fee: String(receipt?.actualSolCostLamports || '0') }); store.adjust(launch.id, role, { cost: big(receipt?.actualSolCostLamports || 0) }); }
      else store.updateSweep(sweep.id, { state: 'expired' });
    });
  }

  // ---- holder rewards (Launchpad-run) ---------------------------------------------------------------
  // See HOLDER_PAYOUT_USD at the top. A payout is one durable request per coin (cursor 'holder-payout'): it collects
  // the pending creator fees, freezes the top holders by minimum balance over the last hour (on another pair after
  // selling only what new holder accounts and fees need) and pays the frozen cycle four holders at a time. Every
  // administrator request it carries records its outcome under 'payout-result:<request ID>'.
  curveWallets(launch) { return [launch.launch_wallet, launch.protocol_wallet, launch.mode_wallet, launch.mint].filter(Boolean); }
  payoutThresholdUsd() { const value = Number(this.config.holderPayoutUsd); return Number.isFinite(value) && value >= 1 && value <= 1000000 ? value : HOLDER_PAYOUT_USD; }
  /** The coin's open holder payout, or null. */
  payoutRequest(launch) {
    const raw = this.store().cursor(launch.id, 'holder-payout'); if (!raw) return null;
    try { const value = JSON.parse(raw); return value?.v === 1 && ['collect', 'basket', 'freeze', 'pay'].includes(value.stage) && Array.isArray(value.requests) ? value : null; } catch { return null; }
  }
  savePayout(launch, value) { this.store().setCursor(launch.id, 'holder-payout', value ? JSON.stringify(value) : ''); return value; }
  /** Merges `fields` into the open payout (re-read first, so nothing saved meanwhile is lost). */
  notePayout(launch, fields) { const current = this.payoutRequest(launch); return current ? this.savePayout(launch, { ...current, ...fields }) : null; }
  /** Whether a frozen cycle pays the pair asset (from v71.24 on another pair) rather than SOL. */
  tokenCycle(cycle) { return Array.isArray(cycle?.payouts) && cycle.payouts.some(p => big(p.tokens || '0') > 0n); }
  /**
   * Rewards ready to pay, in the payout asset: on a SOL coin the SOL ledger of the payout role less half its operating
   * reserve; on another pair the receipt-backed pair-asset share. An Insured coin pays holders from its pot only.
   */
  payoutHeld(launch) {
    const role = this.rewardRole(launch);
    if (this.isQuote(launch)) return max0(this.store().quoteBalance(launch.id, role).available);
    const held = max0(this.roleAvailable(launch, role) - big(launch.plan.funding.modeGasLamports) / 2n);
    return launch.mode === 'insured' ? minBig(held, big(launch.option?.state?.pot || '0')) : held;
  }
  /** The holders' share of each creator-fee distribution, in basis points (as recorded in the coin's fee sharing). */
  holderShareBps(launch) { const row = (launch.shareholders || []).find(s => s.address === launch.recipient); return BigInt(Number.isInteger(row?.shareBps) ? row.shareBps : 10000 - platformShareBps(launch.mode, this.policyOf(launch))); }
  /** The holders' part of fees still pending at Pump.fun: the recipient's share, of which an Insured coin keeps only the coverage share for holders. */
  pendingHolderBps(launch) { const bps = this.holderShareBps(launch); return launch.mode === 'insured' ? bps * BigInt(launch.option?.settings?.coveragePercent || 0) / 100n : bps; }
  /** SOL a pair Holders wallet always keeps: its reserve plus enough to run the next small sale. */
  tokenPayoutReserve(launch) { return BigInt(this.policyOf(launch).routing.keepLamports) + PAYOUT_SALE_FLOAT_LAMPORTS; }
  /**
   * Diamond Hands (v71.35): the top holders of this payout with their streaks applied. A wallet whose minimum balance
   * over the window fell below the balance recorded at its last payout sold in between: it is skipped, and its
   * streak starts over (recorded at once, so a payout that pays nobody still counts the sale). Everyone else's streak
   * grows by one and multiplies their weight, up to the cap; those streaks are written when the cycle freezes.
   */
  diamondSelection(launch, list) {
    const store = this.store(), settings = launch.option?.settings || {}, streaks = store.streaks(launch.id), kept = [], updates = [], resets = [];
    for (const h of list) {
      const prior = streaks.get(h.owner), weight = big(h.weight);
      if (prior && weight < prior.balance) { resets.push({ owner: h.owner, streak: 0, balance: weight, had: prior.streak }); continue; }
      const streak = (prior?.streak || 0) + 1, multiplierBps = diamondMultiplierBps(streak, settings);
      kept.push({ owner: h.owner, weight: weight * BigInt(multiplierBps) / 10000n, streak, multiplierBps });
      updates.push({ owner: h.owner, streak, balance: weight });
    }
    if (resets.length) store.setStreaks(launch.id, resets);
    return { list: kept, updates, skipped: resets };
  }
  /** The streak fields of the frozen payouts, from the selection (SOL and pair-asset cycles alike). */
  withStreaks(payouts, diamond) {
    if (!diamond) return payouts;
    const by = new Map(diamond.list.map(h => [h.owner, h]));
    return payouts.map(p => { const h = by.get(p.owner); return h ? { ...p, streak: h.streak, multiplierBps: h.multiplierBps } : p; });
  }
  /** The asset a reward cycle pays: a basket asset (v71.35, `mint` set), the pair asset (payouts carry `tokens`) or SOL. */
  cycleAsset(launch, cycle) {
    if (cycle?.mint) { const asset = (this.basketAssets(launch) || []).find(a => a.mint === cycle.mint); return asset ? { mint: asset.mint, symbol: asset.symbol, decimals: asset.decimals, program: asset.program || SPL_TOKEN_PROGRAM, extra: true } : { mint: cycle.mint, symbol: cycle.mint.slice(0, 4) + '…', decimals: 0, program: SPL_TOKEN_PROGRAM, extra: true }; }
    return this.tokenCycle(cycle) ? { ...this.pairOf(launch), extra: false } : { mint: SOL, symbol: 'SOL', decimals: 9, program: SPL_TOKEN_PROGRAM, extra: false };
  }
  cycleOutcome(launch, cycle) {
    const asset = this.cycleAsset(launch, cycle), count = cycle.payouts.length;
    return { paid: String(cycle.paid), amount: String(cycle.amount), recipients: count, asset: asset.symbol, decimals: asset.decimals, cycleId: cycle.id, reason: `Paid ${amountText(cycle.paid, asset.decimals)} ${asset.symbol} to ${count} holder${count === 1 ? '' : 's'}.` };
  }
  /**
   * Current market rates for payouts: raw pair units per lamport and USD per lamport. The pair asset is priced from
   * its USD reference, or when none is available from the SOL route Launchpad would buy it through (read-only).
   */
  async pairRate(chain, launch) {
    // USD references are shared by every coin for a minute (the worker's chain adapter is new each pass).
    const usdOf = mint => this.cachedRead(this.priceCache ||= new Map(), mint, 60000, () => chain.quoteUsd(mint));
    const lamportUsd = Number((await usdOf(SOL))?.usd) / 1e9;
    if (!(lamportUsd > 0)) throw publicFailure('A live SOL price is unavailable.');
    if (!this.isQuote(launch)) return { rawPerLamport: 1, lamportUsd };
    const asset = this.pairOf(launch);
    try { const usd = Number((await usdOf(asset.mint))?.usd); if (usd > 0) return { rawPerLamport: lamportUsd / (usd / 10 ** asset.decimals), lamportUsd }; } catch { /* the SOL route below */ }
    const probe = 50000000n, route = await chain.quoteDevBuyConversion({ quoteMint: asset.mint, program: asset.program, lamports: probe, taker: launch.mode_wallet, slippageBps: 200, maxImpactBps: 500 });
    const raw = Number(route?.expectedRaw); if (!(raw > 0)) throw publicFailure(`A live ${asset.symbol} price is unavailable.`);
    return { rawPerLamport: raw / Number(probe), lamportUsd };
  }
  async holders(chain) {
    const store = this.store(), minute = 60000;
    for (const launch of store.liveLaunches().filter(row => this.samplesHolders(row))) {
      if (this.closed) return;
      const policy = this.policyOf(launch).holders, flags = this.effective();
      try {
        const cycle = store.openRewardCycle(launch.id);
        if (cycle) {
          await this.payCycle(chain, launch, cycle);
          const after = store.rewardCycle(cycle.id), request = this.payoutRequest(launch);
          if (after?.state === 'complete' && request?.cycleId === cycle.id) {
            // A basket coin pays its assets one after another: the next asset is frozen on the following pass.
            if (request.basket && this.continueBasket(launch, request, after)) continue;
            // Requests that joined after this cycle froze get a payout of their own (collect and freeze again).
            const late = request.requests.filter(r => Number(r.at) > Number(after.created_at));
            this.finishPayout(launch, { ...request, requests: request.requests.filter(r => !late.includes(r)) }, { state: 'completed', ...this.cycleOutcome(launch, after) });
            if (late.length) this.savePayout(launch, { v: 1, id: newId('hp'), source: 'admin', at: this.now(), stage: 'collect', requests: late });
          }
          continue;
        }
        const request = this.payoutRequest(launch);
        if (!flags.holders || launch.fee_state !== 'verified') { if (request) this.finishPayout(launch, request, { state: 'skipped', reason: flags.holders ? 'This coin’s creator-fee sharing is not verified.' : HOLDERS_OFF }); continue; }
        if (!this.throttle('sample:' + launch.id, policy.sampleIntervalMinutes * minute - 15000)) {
          try {
            const snap = await chain.holderBalances({ mint: launch.mint, exclude: this.curveWallets(launch) });
            if (snap?.complete) store.addHolderSample(launch.id, snap.slot, snap.at ?? this.now(), snap.rows);
            store.pruneHolderSamples(launch.id, this.now() - 3 * policy.windowMinutes * minute);
          } catch (error) { this.retryLater('sample:' + launch.id, error, { base: 60000 }); }
        }
        // An Earned coin in probation and an Insured coin before its deadline only keep snapshots; their holders are paid once the option says so.
        if (!this.holderPayoutActive(launch)) continue;
        const open = request || this.duePayout(launch) || await this.autoPayout(chain, launch);
        if (open && !this.backoff('payout:' + launch.id)) { await this.advancePayout(chain, launch, open); this.retry.delete('payout:' + launch.id); }
      } catch (error) {
        this.retryLater('payout:' + launch.id, error, { base: 60000 });
        if (this.payoutRequest(launch)) this.notePayout(launch, { waiting: `Retrying shortly: ${safeError(error)}` });
      }
    }
  }
  /**
   * Insured: a refund (the deadline passed) or a graduation bonus pays the pot at once, whatever it is worth and
   * however recent the last payout. One durable request, recorded on the option so a restart cannot start it twice.
   */
  duePayout(launch) {
    const due = launch.option?.state?.refundDue; if (launch.mode !== 'insured' || !due) return null;
    const request = this.savePayout(launch, { v: 1, id: newId('hp'), source: due === 'bonus' ? 'bonus' : 'insurance', at: this.now(), stage: 'collect', requests: [] });
    this.updateOption(launch, state => { state.refundDue = null; });
    this.store().addEvent({ launchId: launch.id, kind: 'rewards', title: due === 'bonus' ? 'Graduation bonus started' : 'Holder refund started', body: `${sol(big(launch.option.state.pot || '0'))} SOL from the refund pot goes to the top holders.` });
    return request;
  }
  /**
   * The automatic trigger: the holders' share (collected rewards not yet paid, plus their share of the fees still
   * pending at Pump.fun) is worth at least the payout threshold. Checked every five minutes per coin, and not within
   * one cycle interval of the coin's last payout.
   */
  async autoPayout(chain, launch) {
    const store = this.store(), key = 'payout-check:' + launch.id;
    if (this.backoff(key) || this.now() - Number(store.cursor(launch.id, 'reward-cycle-at') || 0) < this.policyOf(launch).holders.cycleIntervalMs || this.now() < Number(store.cursor(launch.id, 'holder-payout-auto-after') || 0) || this.throttle(key, PAYOUT_CHECK_MS)) return null;
    try {
      let pending = 0n;
      if (this.effective().collection) { const coin = await chain.readCoin(launch.mint, { quote: this.chainQuote(launch) }); if (coin?.exists) pending = big(coin.fees.total); }
      const share = this.payoutHeld(launch) + pending * this.pendingHolderBps(launch) / 10000n; if (share <= 0n) return null;
      const asset = this.pairOf(launch), rate = await this.pairRate(chain, launch), usd = Number(share) / rate.rawPerLamport * rate.lamportUsd;
      if (!Number.isFinite(usd) || usd < this.payoutThresholdUsd()) return null;
      const request = this.savePayout(launch, { v: 1, id: newId('hp'), source: 'auto', at: this.now(), stage: 'collect', requests: [], valueUsd: Math.round(usd * 100) / 100 });
      store.addEvent({ launchId: launch.id, kind: 'rewards', title: 'Holder payout started', body: `The holders’ share reached about $${usd.toFixed(2)} (${amountText(share, asset.decimals)} ${asset.symbol}, including fees still pending at Pump.fun).`, isPublic: false });
      return request;
    } catch (error) { this.retryLater(key, error, { base: 300000 }); return null; }
  }
  /** One step of the coin's open payout: collect, then freeze (selling for costs first on another pair), then pay. */
  async advancePayout(chain, launch, request) {
    const store = this.store();
    if (request.stage === 'collect') {
      if (this.openOp(launch.id, ['distribute'])) return this.notePayout(launch, { waiting: '', note: 'Collecting this coin’s creator fees.' });
      let sent = request.collectOp ? store.operation(request.collectOp) : null;
      // A collection that failed or expired is tried again (three tries in all); after that the payout pays what was already collected.
      if (sent && sent.state !== 'confirmed') { request = this.notePayout(launch, { collectOp: null, collectTries: (request.collectTries || 0) + 1 }); sent = null; }
      // Collected fees count once the receipt journal records them (scanReceipts, within a minute or so), whichever collection sent them.
      const latest = store.latestOperation(launch.id, 'distribute', 'confirmed');
      if (latest && !store.knownDistribution(latest.signature) && this.now() - (latest.updated_at || 0) < PAYOUT_RECORD_WAIT_MS) return this.notePayout(launch, { waiting: '', note: 'Recording the collected creator fees.' });
      if (!sent && this.effective().collection && (request.collectTries || 0) < 3) {
        let coin = null;
        try {
          coin = await chain.readCoin(launch.mint, { quote: this.chainQuote(launch) });
          if (coin?.exists && coin.venue !== launch.venue_state) this.venueChanged(launch, coin);
          if (coin?.exists && coin.fees.total >= this.collectionThreshold(launch, { payout: true })) { const row = await this.sendDistribution(chain, launch, coin); return this.notePayout(launch, { collectOp: row.id, waiting: '', note: 'Collecting this coin’s creator fees.' }); }
        } catch (error) {
          this.collectFailed(launch, error);
          this.notePayout(launch, { collectTries: (request.collectTries || 0) + 1, collectError: operatorError(error).slice(0, 240) });
          throw error;
        }
      }
      // A basket coin (v71.35) first splits what is ready and buys the extra assets; then every asset is frozen and paid in turn.
      request = this.basketAssets(launch) ? this.startBasketRound(launch, request) : this.notePayout(launch, { stage: 'freeze', waiting: '', note: '' });
      if (!request) return null;
    }
    if (request.stage === 'basket') return this.advanceBasket(chain, launch, request);
    if (request.stage === 'freeze') {
      const extra = this.basketAssetDue(launch, request);
      if (extra) return this.freezeBasketAssetPayout(chain, launch, request, extra);
      return this.isQuote(launch) ? this.freezeTokenPayout(chain, launch, request) : this.freezeSolPayout(launch, request);
    }
    // 'pay': the cycle finished between passes and is no longer open; close the request with its outcome.
    const cycle = request.cycleId ? store.rewardCycle(request.cycleId) : null;
    if (!cycle || cycle.state === 'complete') return this.finishPayout(launch, request, cycle ? { state: 'completed', ...this.cycleOutcome(launch, cycle) } : { state: 'blocked', reason: 'The frozen payout could not be found. An operator needs to review this coin.' });
  }
  /** Top holders by minimum balance over the reward window, or why the window is not ready yet. */
  payoutWindow(launch) {
    const store = this.store(), policy = this.policyOf(launch).holders, minute = 60000;
    const samples = store.holderSamples(launch.id, this.now() - 2 * policy.windowMinutes * minute).map(row => ({ at: row.at, slot: row.slot, complete: true, rows: row.balances }));
    const window = rewardWindow(samples, { now: this.now(), windowMs: policy.windowMinutes * minute, maxGapMs: policy.sampleIntervalMinutes * minute + 60000 });
    if (!window.ok) return { ok: false, reason: `Waiting for an hour of holder snapshots: ${window.reason}` };
    return { ok: true, window, list: topHolders(minimumBalances(window.samples), { limit: policy.topHolders, exclude: new Set(this.curveWallets(launch)) }) };
  }
  /** Repeatedly drops holders whose allocation falls below their minimum and reallocates among the rest (deterministic, bounded). */
  allocatePayouts(amount, list, minimum) {
    let holders = list, payouts = allocateRewards(amount, holders);
    for (let i = 0; i < 8 && payouts.some(p => p.lamports < minimum(p.owner)); i++) { holders = holders.filter((h, index) => payouts[index].lamports >= minimum(h.owner)); payouts = allocateRewards(amount, holders); }
    return payouts.filter(p => p.lamports > 0n && p.lamports >= minimum(p.owner));
  }
  /** A payout with nothing to pay: completed, or blocked when collecting the coin's fees kept failing. */
  nothingToPay(launch, request, reason) {
    return this.finishPayout(launch, request, request.collectError ? { state: 'blocked', reason: `Collecting this coin’s creator fees failed: ${request.collectError}` } : { state: 'completed', reason });
  }
  freezeSolPayout(launch, request) {
    const policy = this.policyOf(launch).holders, amount = this.payoutHeld(launch), minimum = BigInt(policy.minimumPayoutLamports);
    if (amount < minimum) return this.nothingToPay(launch, request, 'No holder rewards were waiting to be paid.');
    const window = this.roundWindow(launch, request); if (!window.ok) return this.notePayout(launch, { waiting: window.reason });
    const diamond = launch.mode === 'diamond_hands' ? this.diamondSelection(launch, window.list) : null, list = diamond ? diamond.list : window.list;
    const payouts = this.allocatePayouts(amount, list, () => minimum);
    if (!payouts.length) return this.finishPayout(launch, request, { state: 'completed', reason: diamond?.skipped.length && !list.length ? 'Every top holder sold since the last payout; nothing is paid this round.' : 'No holder qualifies for a payout yet.' });
    const total = payouts.reduce((sum, p) => sum + p.lamports, 0n);
    return this.freezeCycle(launch, { window: window.window, payouts: this.withStreaks(payouts.map(p => ({ owner: p.owner, weight: p.weight, lamports: p.lamports.toString() })), diamond), total, text: `${sol(total)} SOL`, diamond });
  }
  /**
   * Freezes a payout in the pair asset. Holders without a usable token account for it are paid only when their
   * share is worth NEW_ACCOUNT_VALUE_MULTIPLE times the account's rent (others at least the policy's minimum
   * payout); a frozen account excludes its holder. When the rewards wallet's SOL cannot cover the new accounts and
   * fees, Launchpad first sells just enough of the pair asset (journaled like any conversion, at most
   * PAYOUT_GAS_ATTEMPTS sales per payout), then freezes what remains.
   */
  async freezeTokenPayout(chain, launch, request) {
    const store = this.store(), policy = this.policyOf(launch), asset = this.pairOf(launch), quote = this.chainQuote(launch), wallet = launch.mode_wallet;
    const sale = this.openOp(launch.id, ['convert']);
    if (sale) return this.notePayout(launch, { waiting: '', note: sale.expected?.purpose === 'payout-gas' ? `Selling a little ${asset.symbol} for new holder accounts and network fees.` : 'Waiting for this coin’s open conversion to settle.' });
    const held = this.payoutHeld(launch);
    if (held <= 0n) return this.nothingToPay(launch, request, `No ${asset.symbol} holder rewards were waiting to be paid.`);
    const window = this.roundWindow(launch, request); if (!window.ok) return this.notePayout(launch, { waiting: window.reason });
    const diamond = launch.mode === 'diamond_hands' ? this.diamondSelection(launch, window.list) : null, list = diamond ? diamond.list : window.list;
    if (!list.length) return this.finishPayout(launch, request, { state: 'completed', reason: diamond?.skipped.length ? 'Every top holder sold since the last payout; nothing is paid this round.' : 'No holder qualifies for a payout yet.' });
    const { balances: tokens } = await chain.quoteBalances([wallet], quote), { balances: lamports } = await chain.walletBalances([wallet]);
    const amount = minBig(held, big(tokens[wallet]));
    if (amount < held) this.alert(launch, 'The holder rewards wallet holds less than its receipts', `It holds ${amountText(big(tokens[wallet]), asset.decimals)} ${asset.symbol}; recorded rewards are ${amountText(held, asset.decimals)}. Only the held amount is paid.`);
    if (amount <= 0n) return this.notePayout(launch, { waiting: `Waiting for the holder rewards wallet to show its ${asset.symbol}.` });
    let rate = null;
    try { rate = await this.pairRate(chain, launch); } catch { rate = null; }
    if (!(rate?.rawPerLamport > 0)) return this.notePayout(launch, { waiting: `Waiting for live ${asset.symbol} and SOL prices.` });
    // Raw pair units worth `value` lamports at the current market (rounded up).
    const rawFor = value => BigInt(Math.ceil(Number(value) * rate.rawPerLamport));
    const accounts = await chain.payoutAccounts({ owners: list.map(h => h.owner), quote });
    const rent = big(accounts.rentLamports), ready = owner => accounts.accounts?.[owner] === 'ready';
    const usable = list.filter(h => accounts.accounts?.[h.owner] === 'ready' || accounts.accounts?.[h.owner] === 'missing');
    const minimum = { ready: rawFor(BigInt(policy.holders.minimumPayoutLamports)), fresh: rawFor(rent * NEW_ACCOUNT_VALUE_MULTIPLE) };
    const allocate = total => this.allocatePayouts(total, usable, owner => ready(owner) ? minimum.ready : minimum.fresh);
    const costOf = payouts => { const fresh = BigInt(payouts.filter(p => !ready(p.owner)).length), batches = BigInt(Math.ceil(payouts.length / policy.holders.batchSize)), base = fresh * rent + batches * PAYOUT_BATCH_FEE_LAMPORTS; return base + base * PAYOUT_COST_MARGIN_BPS / 10000n + PAYOUT_COST_FLOOR_LAMPORTS; };
    const payouts = allocate(amount);
    if (!payouts.length) return this.finishPayout(launch, request, { state: 'completed', reason: 'No holder qualifies for a payout yet.' });
    const spendable = max0(big(lamports[wallet]) - this.tokenPayoutReserve(launch)), cost = costOf(payouts);
    if (spendable < cost) {
      const sell = rawFor((cost - spendable) * (10000n + PAYOUT_COST_MARGIN_BPS) / 10000n + PAYOUT_SALE_HEADROOM_LAMPORTS), fresh = payouts.filter(p => !ready(p.owner)).length;
      const salesToday = store.countOperations(launch.id, 'convert', this.now() - 24 * 3600000, '"purpose":"payout-gas"');
      if ((request.gasSales || 0) >= PAYOUT_GAS_ATTEMPTS || salesToday >= PAYOUT_SALES_PER_DAY) { this.alert(launch, 'A holder payout could not cover its costs', `The holder rewards wallet ${wallet} still lacks SOL for ${fresh} new token accounts and fees after ${request.gasSales || 0} sales in this payout (${salesToday} today). Send it a little SOL; the rest of the ${asset.symbol} stays in it.`); return this.finishPayout(launch, request, { state: 'blocked', reason: `The holder rewards wallet needs a little SOL for ${fresh} new holder accounts. The rest of the ${asset.symbol} stays in it until the next payout.` }); }
      if (sell >= amount) return this.finishPayout(launch, request, { state: 'completed', reason: `The ${asset.symbol} waiting is too small to pay for the holders’ new token accounts. It stays reserved for the next payout.` });
      if (!this.takeSwap()) return this.notePayout(launch, { waiting: '', note: `Selling a little ${asset.symbol} for new holder accounts next.` });
      return this.sellForPayoutCosts(chain, launch, request, sell, fresh);
    }
    const total = payouts.reduce((sum, p) => sum + p.lamports, 0n);
    return this.freezeCycle(launch, { window: window.window, payouts: this.withStreaks(payouts.map(p => ({ owner: p.owner, weight: p.weight, lamports: '0', tokens: p.lamports.toString() })), diamond), total, text: `${amountText(total, asset.decimals)} ${asset.symbol}`, diamond });
  }
  /** Sells `sell` raw units of the holder rewards for SOL (journaled like any conversion; convert() settles it). */
  async sellForPayoutCosts(chain, launch, request, sell, fresh) {
    const store = this.store(), asset = this.pairOf(launch), wallet = launch.mode_wallet, keys = await this.keys(launch);
    const op = await chain.prepareConversion({ wallet: keys.mode, quote: this.chainQuote(launch), amount: sell, minSolReserve: '0', maxNetworkCostLamports: this.policyOf(launch).conversion.maxNetworkCostLamports });
    if (op?.kind !== 'convert' || op.wallet !== wallet || op.mint !== launch.quote_mint || op.inputAmount !== sell.toString()) throw publicFailure('The prepared sale could not be verified.');
    const conversionId = newId('cv'), role = this.rewardRole(launch), row = store.db.transaction(() => {
      const r = this.journal(launch, 'convert', op, { purpose: 'payout-gas', role, conversionId });
      store.insertConversion({ id: conversionId, launchId: launch.id, role, operationId: r.id, signature: op.signature, wallet, quoteMint: launch.quote_mint, input: sell });
      this.notePayout(launch, { gasSales: (request.gasSales || 0) + 1, waiting: '', note: `Selling ${amountText(sell, asset.decimals)} ${asset.symbol} for ${fresh} new holder account${fresh === 1 ? '' : 's'} and network fees.` });
      return r;
    });
    await this.broadcastOp(chain, row);
  }
  /**
   * A token payout batch that keeps failing. Recipients who can no longer receive the pair asset (a frozen account,
   * or one that requires a memo) leave the cycle; their shares stay with the rewards for the next payout. When the
   * wallet lacks SOL for new accounts, Launchpad sells a little of the rewards not committed to this cycle (within the
   * same sale limits). Returns whether anything changed.
   */
  async recoverTokenCycle(chain, launch, cycle, error) {
    const store = this.store(), remaining = cycle.payouts.slice(cycle.next_index); if (!remaining.length) return false;
    const accounts = await chain.payoutAccounts({ owners: remaining.map(p => p.owner), quote: this.cycleQuote(launch, cycle) });
    const unusable = new Set(remaining.filter(p => accounts.accounts?.[p.owner] === 'unusable').map(p => p.owner));
    if (unusable.size) return this.skipRecipients(launch, cycle, unusable);
    if (!/cannot fund this airdrop|network and rent cost/i.test(String(error?.message))) return this.probeTokenBatch(chain, launch, cycle);
    const request = this.payoutRequest(launch), policy = this.policyOf(launch);
    // Only a coin on another pair can sell for its costs; a SOL coin's basket payout waits for the wallet's SOL (the alert above names it).
    if (!this.isQuote(launch) || !request || request.cycleId !== cycle.id || (request.gasSales || 0) >= PAYOUT_GAS_ATTEMPTS || store.countOperations(launch.id, 'convert', this.now() - 24 * 3600000, '"purpose":"payout-gas"') >= PAYOUT_SALES_PER_DAY || this.openOp(launch.id, ['convert'])) return false;
    const { balances } = await chain.walletBalances([launch.mode_wallet]), spendable = max0(big(balances[launch.mode_wallet]) - this.tokenPayoutReserve(launch));
    const fresh = remaining.filter(p => accounts.accounts?.[p.owner] !== 'ready').length, base = BigInt(fresh) * big(accounts.rentLamports) + BigInt(Math.ceil(remaining.length / policy.holders.batchSize)) * PAYOUT_BATCH_FEE_LAMPORTS;
    const cost = base + base * PAYOUT_COST_MARGIN_BPS / 10000n + PAYOUT_COST_FLOOR_LAMPORTS; if (spendable >= cost) return false;
    const rate = await this.pairRate(chain, launch), sell = BigInt(Math.ceil(Number((cost - spendable) * (10000n + PAYOUT_COST_MARGIN_BPS) / 10000n + PAYOUT_SALE_HEADROOM_LAMPORTS) * rate.rawPerLamport));
    // Only rewards collected since the cycle froze can be sold; the frozen amount belongs to its recipients (a basket asset's cycle holds none of the pair asset).
    if (sell <= 0n || sell > this.payoutHeld(launch) - (cycle.mint ? 0n : big(cycle.amount) - big(cycle.paid)) || !this.takeSwap()) return false;
    await this.sellForPayoutCosts(chain, launch, request, sell, fresh);
    return true;
  }
  /** Removes recipients who cannot receive from the cycle's unpaid part; their shares stay with the rewards for the next payout. */
  skipRecipients(launch, cycle, owners) {
    const asset = this.cycleAsset(launch, cycle), remaining = cycle.payouts.slice(cycle.next_index), skipped = remaining.filter(p => owners.has(p.owner)); if (!skipped.length) return false;
    const kept = [...cycle.payouts.slice(0, cycle.next_index), ...remaining.filter(p => !owners.has(p.owner))], dropped = skipped.reduce((sum, p) => sum + big(p.tokens || '0'), 0n);
    this.store().updateRewardCycle(cycle.id, { payouts: JSON.stringify(kept), amount: (big(cycle.amount) - dropped).toString(), ...(cycle.next_index >= kept.length ? { state: 'complete' } : {}) });
    this.alert(launch, 'Holders skipped in a payout', `${skipped.length} holder${skipped.length === 1 ? '' : 's'} cannot receive ${asset.symbol} (for example a frozen token account, or one that rejects ordinary transfers). Their ${amountText(dropped, asset.decimals)} ${asset.symbol} stays with the rewards for the next payout.`);
    return true;
  }
  /** Recipients per payout transaction for this cycle: one at a time once a full batch kept failing although each recipient passes alone. */
  cycleBatchSize(launch, cycle) { const request = this.payoutRequest(launch); return request?.cycleId === cycle.id && request.batchSize === 1 ? 1 : this.policyOf(launch).holders.batchSize; }
  /**
   * A token batch that keeps failing for no reason Launchpad recognises: each recipient is prepared alone (read-only; the
   * prepared transactions are never sent). A recipient whose own token account is refused, or whose transfer fails
   * simulation while another recipient's passes, leaves the cycle. When every recipient passes alone, the rest of the
   * cycle pays one holder per transaction. Anything else (for example a paused asset) keeps retrying with an alert.
   */
  async probeTokenBatch(chain, launch, cycle) {
    const batch = cycle.payouts.slice(cycle.next_index, cycle.next_index + this.cycleBatchSize(launch, cycle)); if (!batch.length) return false;
    const keys = await this.keys(launch), ACCOUNT = /recipient token account (is unavailable|has the wrong program)/i, REJECTED = /Airdrop simulation failed/i;
    const prepareOne = (owner, tokens) => chain.prepareAirdrop({ wallet: keys.mode, mint: this.cycleAsset(launch, cycle).mint, payouts: [{ owner, lamports: '0', tokens: String(tokens) }], minSolReserve: String(this.tokenPayoutReserve(launch)), maxNetworkCostLamports: TOKEN_PAYOUT_MAX_COST_LAMPORTS });
    const results = [];
    for (const p of batch) { try { await prepareOne(p.owner, p.tokens); results.push({ owner: p.owner, ok: true }); } catch (error) { results.push({ owner: p.owner, ok: false, message: String(error?.message || '') }); } }
    let failing = results.filter(r => !r.ok && (ACCOUNT.test(r.message) || REJECTED.test(r.message)));
    if (failing.some(r => !ACCOUNT.test(r.message)) && !results.some(r => r.ok)) {
      // No recipient of this batch passed: try one other recipient of the cycle (one raw unit) before blaming anyone.
      const control = [...cycle.payouts.slice(0, cycle.next_index).reverse(), ...cycle.payouts.slice(cycle.next_index + batch.length)][0];
      let passes = false;
      if (control) { try { await prepareOne(control.owner, 1n); passes = true; } catch { passes = false; } }
      if (!passes) failing = failing.filter(r => ACCOUNT.test(r.message));
    }
    if (failing.length) return this.skipRecipients(launch, cycle, new Set(failing.map(r => r.owner)));
    if (batch.length > 1 && results.every(r => r.ok)) { this.notePayout(launch, { batchSize: 1 }); return true; }
    return false;
  }
  freezeCycle(launch, { window, payouts, total, text, diamond = null, mint = null }) {
    const store = this.store(), id = newId('rc');
    store.db.transaction(() => {
      store.insertRewardCycle({ id, launchId: launch.id, amount: total, payouts, windowFrom: window.from, windowTo: window.to, mint });
      store.setCursor(launch.id, 'reward-cycle-at', this.now());
      this.notePayout(launch, { stage: 'pay', cycleId: id, waiting: '', note: '' });
      if (diamond) {
        // Streaks grow only for wallets the cycle pays; a wallet dropped for a share below the minimum keeps its record.
        const paid = new Set(payouts.map(p => p.owner));
        store.setStreaks(launch.id, diamond.updates.filter(row => paid.has(row.owner)));
        this.updateOption(launch, state => { state.payouts = (state.payouts || 0) + 1; state.paidWallets = payouts.length; state.skippedWallets = diamond.skipped.length; state.lastPayoutAt = this.now(); });
      }
    });
    const skipped = diamond?.skipped.length || 0;
    store.addEvent({ launchId: launch.id, kind: 'rewards', title: mint ? 'Basket rewards frozen' : 'Holder rewards frozen', body: `${text} to ${payouts.length} holder${payouts.length === 1 ? '' : 's'} by minimum balance over the last hour${diamond ? (skipped ? `; ${skipped} wallet${skipped === 1 ? '' : 's'} skipped for selling since the last payout, streak${skipped === 1 ? '' : 's'} reset` : '; nobody sold since the last payout') : ''}.` });
    return id;
  }
  /** Records the outcome for every administrator request the payout carried and as the coin's last payout, then closes it. */
  finishPayout(launch, request, result) {
    const store = this.store(), asset = this.pairOf(launch), outcomes = request?.basket?.outcomes || [];
    const value = { asset: asset.symbol, decimals: asset.decimals, paid: '0', recipients: 0, ...result, held: this.payoutHeld(launch).toString(), at: this.now(), ...(request?.basket ? { basket: [...outcomes, ...(result?.cycleId ? [{ asset: result.asset, decimals: result.decimals, paid: result.paid, recipients: result.recipients }] : [])] } : {}) };
    if (outcomes.length && value.state === 'completed') value.reason = [...outcomes, ...(result?.cycleId ? [result] : [])].map(o => `${amountText(o.paid, o.decimals)} ${o.asset} to ${o.recipients} holder${o.recipients === 1 ? '' : 's'}`).join('; ') + (result?.cycleId ? '.' : `. ${result?.reason || ''}`.trimEnd());
    store.db.transaction(() => {
      for (const entry of request?.requests || []) store.setCursor(launch.id, 'payout-result:' + entry.requestId, JSON.stringify(value));
      store.setCursor(launch.id, 'holder-payout-last', JSON.stringify({ ...value, source: request?.source || 'auto' }));
      // A payout that paid nobody holds back the automatic trigger (a cycle interval; six hours after a blocked one).
      if (!value.cycleId) store.setCursor(launch.id, 'holder-payout-auto-after', this.now() + (value.state === 'blocked' ? PAYOUT_BLOCKED_WAIT_MS : this.policyOf(launch).holders.cycleIntervalMs));
      this.savePayout(launch, null);
    });
    if (value.state === 'completed' && big(value.paid) === 0n && request?.source === 'auto') store.addEvent({ launchId: launch.id, kind: 'rewards', title: 'Holder payout ended without a payment', body: value.reason || '', isPublic: false });
    return value;
  }
  // ---- reward baskets worker (v71.35) --------------------------------------------------------------
  // A basket coin's payout has one more stage, 'basket', between collecting and freezing: what is ready in the main
  // reward asset is split equally across the basket and each extra share is bought from the rewards wallet (on another
  // pair the share is first sold for SOL, then the asset is bought with it). Then the assets are frozen and paid one
  // after another to the same top holders: the extra assets first (their new token accounts are SOL costs of the
  // rewards wallet), the main asset last with what remains. The round's recipient list is captured once.
  basketRules(launch) { return this.policyOf(launch).basket || null; }
  /** The payout's basket record: the shares of this round and one leg per extra asset. */
  startBasketRound(launch, request) {
    const assets = this.basketAssets(launch), rules = this.basketRules(launch), held = this.payoutHeld(launch);
    if (!rules) return this.notePayout(launch, { stage: 'freeze', waiting: '', note: '' });
    const minimum = this.isQuote(launch) ? 0n : BigInt(this.policyOf(launch).holders.minimumPayoutLamports);
    if (held <= minimum) return this.nothingToPay(launch, request, `No holder rewards were waiting to be paid.`);
    const shares = basketShares(held, assets.length), minimumLeg = this.quoteThreshold(launch, rules.minimumLegLamports);
    const legs = assets.slice(1).map((asset, i) => { const share = shares[i + 1]; return { mint: asset.mint, symbol: asset.symbol, inputRaw: share.toString(), state: share >= minimumLeg ? 'queued' : 'skipped', attempts: 0, outputRaw: '0', solRaw: this.isQuote(launch) ? '0' : share.toString(), sold: !this.isQuote(launch), opId: null, note: share >= minimumLeg ? '' : 'share too small to buy this round; paid in the main asset' }; });
    const pair = this.pairOf(launch);
    this.store().addEvent({ launchId: launch.id, kind: 'rewards', title: 'Reward round split across the basket', body: `${amountText(held, pair.decimals)} ${pair.symbol} ready: ${assets.map((a, i) => `${amountText(shares[i], pair.decimals)} ${pair.symbol} for ${a.symbol}`).join(', ')}.${legs.some(l => l.state === 'skipped') ? ' Shares too small to buy stay in ' + pair.symbol + '.' : ''}` });
    return this.notePayout(launch, { stage: legs.some(l => l.state === 'queued') ? 'basket' : 'freeze', waiting: '', note: '', basket: { shares: shares.map(String), legs, position: 0, outcomes: [] } });
  }
  /** Merges `fields` into one leg of the open payout's basket (re-read first). */
  noteBasketLeg(launch, index, fields) {
    const request = this.payoutRequest(launch); if (!request?.basket?.legs?.[index]) return null;
    const legs = request.basket.legs.map((leg, i) => i === index ? { ...leg, ...fields } : leg);
    return this.savePayout(launch, { ...request, basket: { ...request.basket, legs } });
  }
  /** A leg whose purchase (or sale) did not land: another attempt, or past the limit its share stays in the main asset. */
  basketLegFailed(launch, index, reason) {
    const request = this.payoutRequest(launch), leg = request?.basket?.legs?.[index]; if (!leg) return null;
    const attempts = (leg.attempts || 0) + 1, limit = this.basketRules(launch)?.conversionAttempts || 3, skipped = attempts >= limit;
    return this.noteBasketLeg(launch, index, { attempts, opId: null, state: skipped ? 'skipped' : 'queued', note: skipped ? `${String(reason || '').slice(0, 120)} Paid in the main asset this round.` : String(reason || '').slice(0, 160) });
  }
  /** One step of the basket stage: settle the open purchase or sale, or start the next one. */
  async advanceBasket(chain, launch, request) {
    const store = this.store(), rules = this.basketRules(launch), b = request.basket;
    if (!b || !rules) return this.notePayout(launch, { stage: 'freeze' });
    const open = store.openOperations(launch.id).find(op => OPEN.includes(op.state) && ['acquire', 'convert'].includes(op.kind) && ['basket', 'basket-sell'].includes(op.expected?.purpose));
    if (open) { if (open.kind === 'convert') await this.settleConversion(chain, launch, open); else await this.settleBasketAcquire(chain, launch, open); return this.notePayout(launch, { waiting: '', note: `Buying ${open.expected?.symbol || 'a basket asset'} for this round.` }); }
    const index = b.legs.findIndex(leg => leg.state === 'queued');
    if (index < 0) { if (b.legs.some(leg => leg.state === 'converting')) return this.notePayout(launch, { waiting: 'Waiting for a basket purchase to settle.' }); return this.notePayout(launch, { stage: 'freeze', waiting: '', note: '' }); }
    const leg = b.legs[index], asset = (this.basketAssets(launch) || []).find(a => a.mint === leg.mint); if (!asset) return this.noteBasketLeg(launch, index, { state: 'skipped', note: 'The basket asset is no longer on the launch record.' });
    if (this.backoff('basket:' + launch.id)) return null;
    if (!this.takeSwap()) return this.notePayout(launch, { waiting: '', note: `Buying ${asset.symbol} for this round next.` });
    const keys = await this.keys(launch), wallet = launch.mode_wallet, role = this.rewardRole(launch), policy = this.policyOf(launch);
    try {
      if (!leg.sold) {
        // Another pair: the share is sold for SOL first (journaled like any conversion; the convert pass or this one settles it).
        const op = await chain.prepareConversion({ wallet: keys.mode, quote: this.chainQuote(launch), amount: big(leg.inputRaw), minSolReserve: '0', maxNetworkCostLamports: rules.maxNetworkCostLamports, guard: { slippageBps: rules.conversionSlippageBps, maxImpactBps: rules.conversionMaxImpactBps } });
        if (op?.kind !== 'convert' || op.wallet !== wallet || op.mint !== launch.quote_mint || op.inputAmount !== String(leg.inputRaw)) throw publicFailure('The prepared sale could not be verified.');
        const conversionId = newId('cv'), row = store.db.transaction(() => { const r = this.journal(launch, 'convert', op, { purpose: 'basket-sell', role, conversionId, legIndex: index, symbol: asset.symbol }); store.insertConversion({ id: conversionId, launchId: launch.id, role, operationId: r.id, signature: op.signature, wallet, quoteMint: launch.quote_mint, input: big(leg.inputRaw) }); this.noteBasketLeg(launch, index, { state: 'converting', opId: r.id, note: `Selling ${amountText(big(leg.inputRaw), this.pairOf(launch).decimals)} ${this.pairOf(launch).symbol} for ${asset.symbol}.` }); return r; });
        await this.broadcastOp(chain, row); return null;
      }
      const lamports = big(leg.solRaw); if (lamports <= 0n) { this.noteBasketLeg(launch, index, { state: 'skipped', note: 'nothing to buy with this round' }); return null; }
      const op = await chain.prepareBasketAcquire({ wallet: keys.mode, mint: asset.mint, lamports, minSolReserve: String(policy.routing.keepLamports), maxNetworkCostLamports: rules.maxNetworkCostLamports, slippageBps: rules.conversionSlippageBps, maxImpactBps: rules.conversionMaxImpactBps });
      if (op?.kind !== 'acquire' || op.wallet !== wallet || op.mint !== asset.mint || op.inputAmount !== lamports.toString()) throw publicFailure('The prepared purchase could not be verified.');
      const row = store.db.transaction(() => { const r = this.journal(launch, 'acquire', op, { purpose: 'basket', role, legIndex: index, mint: asset.mint, symbol: asset.symbol }); this.noteBasketLeg(launch, index, { state: 'converting', opId: r.id, note: `Buying ${asset.symbol} with ${sol(lamports)} SOL.` }); return r; });
      await this.broadcastOp(chain, row); return null;
    } catch (error) {
      // The route or its guard refused, or the chain could not be read: the attempt counts (past the limit the share stays in the main asset).
      this.basketLegFailed(launch, index, operatorError(error));
      this.alert(launch, `A basket purchase of ${asset.symbol} is waiting`, `${operatorError(error)} Launchpad tries again; after ${rules.conversionAttempts} failed attempts the share is paid in the main asset instead.`);
      this.retryLater('basket:' + launch.id, error, { base: 120000 }); return null;
    }
  }
  /** The finalized purchase of a basket asset: the SOL left the rewards ledger, the asset joins its own. */
  async settleBasketAcquire(chain, launch, row) {
    const store = this.store(), role = row.expected.role || this.rewardRole(launch), index = row.expected.legIndex, mint = row.expected.mint, symbol = row.expected.symbol || mint;
    await this.settleOp(chain, row, (c, r) => c.receipt(this.chainOp(r), r.wallet), ({ state, receipt }) => {
      const cost = big(receipt?.actualSolCostLamports || 0), input = big(row.expected.op.inputAmount);
      if (state === 'confirmed') {
        const output = big(receipt.outputAmount); if (output <= 0n) throw publicFailure('The finalized purchase produced none of the basket asset.');
        store.adjust(launch.id, role, { debit: input, cost });
        store.adjustBasket(launch.id, mint, { credit: output });
        this.noteBasketLeg(launch, index, { state: 'converted', outputRaw: output.toString(), opId: null, note: '' });
        const asset = (this.basketAssets(launch) || []).find(a => a.mint === mint);
        store.addEvent({ launchId: launch.id, kind: 'convert', title: `Bought ${symbol} for the holders`, body: `${sol(input)} SOL → ${asset ? amountText(output, asset.decimals) : output.toString()} ${symbol}.`, signature: row.signature });
      } else if (state === 'failed') { store.adjust(launch.id, role, { cost }); this.basketLegFailed(launch, index, 'The purchase failed onchain.'); }
      else this.basketLegFailed(launch, index, 'The purchase expired.');
    });
  }
  /** The next basket asset to freeze in this payout (position 0 … n-2 of the extras), or null when the main asset is next. */
  basketAssetDue(launch, request) {
    const b = request.basket, assets = this.basketAssets(launch); if (!b || !assets) return null;
    const extras = assets.slice(1), position = Number(b.position) || 0;
    for (let i = position; i < extras.length; i++) {
      const asset = extras[i]; if (this.store().basketBalance(launch.id, asset.mint).available > 0n) { if (i !== position) this.notePayout(launch, { basket: { ...b, position: i } }); return asset; }
      this.notePayout(launch, { basket: { ...b, position: i + 1 } });
    }
    return null;
  }
  /** The round's recipients: captured when the first asset is frozen, reused for every other asset of the round. */
  roundWindow(launch, request) {
    if (request?.basket?.list?.length) return { ok: true, window: request.basket.window, list: request.basket.list.map(h => ({ owner: h.owner, weight: big(h.weight) })) };
    const window = this.payoutWindow(launch);
    if (window.ok && request?.basket) this.notePayout(launch, { basket: { ...request.basket, window: window.window, list: window.list.map(h => ({ owner: h.owner, weight: String(h.weight) })) } });
    return window;
  }
  /** Chain-facing description of the asset a token cycle pays (the pair asset, or a basket asset). */
  cycleQuote(launch, cycle) { const asset = this.cycleAsset(launch, cycle); return asset.extra ? { mint: asset.mint, program: asset.program } : this.chainQuote(launch); }
  /**
   * Freezes this round's payout of one basket asset: everything bought of it (less what earlier rounds still owe), to
   * the round's recipients by weight; holders without a token account for it only when their share is worth the
   * account's rent several times over, as for a pair-asset payout. The SOL for new accounts and fees comes from the
   * rewards wallet (a coin on another pair sells a little of the pair asset for it, as for its own payouts).
   */
  async freezeBasketAssetPayout(chain, launch, request, asset) {
    const store = this.store(), policy = this.policyOf(launch), wallet = launch.mode_wallet, quote = { mint: asset.mint, program: asset.program || SPL_TOKEN_PROGRAM };
    const sale = this.openOp(launch.id, ['convert']);
    if (sale) return this.notePayout(launch, { waiting: '', note: sale.expected?.purpose === 'payout-gas' ? `Selling a little ${this.pairOf(launch).symbol} for new holder accounts and network fees.` : 'Waiting for this coin’s open conversion to settle.' });
    const held = store.basketBalance(launch.id, asset.mint).available;
    const skipAsset = reason => { store.addEvent({ launchId: launch.id, kind: 'rewards', title: `${asset.symbol} not paid this round`, body: reason, isPublic: false }); return this.notePayout(launch, { basket: { ...request.basket, position: (Number(request.basket.position) || 0) + 1 } }); };
    if (held <= 0n) return skipAsset(`Nothing of ${asset.symbol} is waiting to be paid.`);
    const window = this.roundWindow(launch, request); if (!window.ok) return this.notePayout(launch, { waiting: window.reason });
    const list = window.list; if (!list.length) return skipAsset('No holder qualifies for a payout yet.');
    const { balances: tokens } = await chain.quoteBalances([wallet], quote), { balances: lamports } = await chain.walletBalances([wallet]);
    const amount = minBig(held, big(tokens[wallet]));
    if (amount < held) this.alert(launch, `The holder rewards wallet holds less ${asset.symbol} than it bought`, `It holds ${amountText(big(tokens[wallet]), asset.decimals)} ${asset.symbol}; recorded purchases are ${amountText(held, asset.decimals)}. Only the held amount is paid.`);
    if (amount <= 0n) return this.notePayout(launch, { waiting: `Waiting for the holder rewards wallet to show its ${asset.symbol}.` });
    let rate = null;
    try { rate = await this.assetRate(chain, launch, asset); } catch { rate = null; }
    if (!(rate?.rawPerLamport > 0)) return this.notePayout(launch, { waiting: `Waiting for live ${asset.symbol} and SOL prices.` });
    const rawFor = value => BigInt(Math.ceil(Number(value) * rate.rawPerLamport));
    const accounts = await chain.payoutAccounts({ owners: list.map(h => h.owner), quote });
    const rent = big(accounts.rentLamports), ready = owner => accounts.accounts?.[owner] === 'ready';
    const usable = list.filter(h => accounts.accounts?.[h.owner] === 'ready' || accounts.accounts?.[h.owner] === 'missing');
    const minimum = { ready: rawFor(BigInt(policy.holders.minimumPayoutLamports)), fresh: rawFor(rent * NEW_ACCOUNT_VALUE_MULTIPLE) };
    const payouts = this.allocatePayouts(amount, usable, owner => ready(owner) ? minimum.ready : minimum.fresh);
    if (!payouts.length) return skipAsset(`No holder’s share of ${asset.symbol} covers a payout this round; it stays for the next.`);
    const fresh = payouts.filter(p => !ready(p.owner)).length, batches = BigInt(Math.ceil(payouts.length / policy.holders.batchSize)), base = BigInt(fresh) * rent + batches * PAYOUT_BATCH_FEE_LAMPORTS, cost = base + base * PAYOUT_COST_MARGIN_BPS / 10000n + PAYOUT_COST_FLOOR_LAMPORTS;
    const reserve = this.isQuote(launch) ? this.tokenPayoutReserve(launch) : BigInt(policy.routing.keepLamports), spendable = max0(big(lamports[wallet]) - reserve);
    if (spendable < cost) {
      if (!this.isQuote(launch)) { this.alert(launch, 'A basket payout needs more SOL', `The holder rewards wallet ${wallet} lacks ${sol(cost - spendable)} SOL for ${fresh} new ${asset.symbol} token accounts and fees. Send it a little SOL; Launchpad retries automatically.`); return this.notePayout(launch, { waiting: `Waiting for SOL in the rewards wallet for ${fresh} new ${asset.symbol} holder accounts.` }); }
      const pairRate = await this.pairRate(chain, launch), sell = BigInt(Math.ceil(Number((cost - spendable) * (10000n + PAYOUT_COST_MARGIN_BPS) / 10000n + PAYOUT_SALE_HEADROOM_LAMPORTS) * pairRate.rawPerLamport));
      const salesToday = store.countOperations(launch.id, 'convert', this.now() - 24 * 3600000, '"purpose":"payout-gas"');
      if ((request.gasSales || 0) >= PAYOUT_GAS_ATTEMPTS || salesToday >= PAYOUT_SALES_PER_DAY) return skipAsset(`The rewards wallet lacks SOL for ${fresh} new ${asset.symbol} holder accounts after its sales for the day; ${asset.symbol} stays for the next round.`);
      if (sell > this.payoutHeld(launch)) return skipAsset(`Too little of the pair asset is left to sell for the ${asset.symbol} holder accounts; ${asset.symbol} stays for the next round.`);
      if (!this.takeSwap()) return this.notePayout(launch, { waiting: '', note: `Selling a little ${this.pairOf(launch).symbol} for new ${asset.symbol} holder accounts next.` });
      return this.sellForPayoutCosts(chain, launch, request, sell, fresh);
    }
    const total = payouts.reduce((sum, p) => sum + p.lamports, 0n);
    return this.freezeCycle(launch, { window: window.window, payouts: payouts.map(p => ({ owner: p.owner, weight: p.weight, lamports: '0', tokens: p.lamports.toString() })), total, text: `${amountText(total, asset.decimals)} ${asset.symbol}`, mint: asset.mint });
  }
  /** Raw units of a basket asset per lamport at the current market (its USD reference, or the SOL route Launchpad buys it through). */
  async assetRate(chain, launch, asset) {
    const usdOf = mint => this.cachedRead(this.priceCache ||= new Map(), mint, 60000, () => chain.quoteUsd(mint));
    const lamportUsd = Number((await usdOf(SOL))?.usd) / 1e9;
    if (!(lamportUsd > 0)) throw publicFailure('A live SOL price is unavailable.');
    try { const usd = Number((await usdOf(asset.mint))?.usd); if (usd > 0) return { rawPerLamport: lamportUsd / (usd / 10 ** asset.decimals), lamportUsd }; } catch { /* the SOL route below */ }
    const probe = 50000000n, route = await chain.quoteDevBuyConversion({ quoteMint: asset.mint, program: asset.program || SPL_TOKEN_PROGRAM, lamports: probe, taker: launch.mode_wallet, slippageBps: 200, maxImpactBps: 500 });
    const raw = Number(route?.expectedRaw); if (!(raw > 0)) throw publicFailure(`A live ${asset.symbol} price is unavailable.`);
    return { rawPerLamport: raw / Number(probe), lamportUsd };
  }
  /**
   * A basket asset's cycle finished: its outcome is kept on the request and the next asset (or the main asset) is
   * frozen on the next pass. Returns false when the cycle was the main asset's, which closes the round.
   */
  continueBasket(launch, request, cycle) {
    if (!cycle.mint) return false;
    const outcome = this.cycleOutcome(launch, cycle), b = request.basket;
    this.notePayout(launch, { stage: 'freeze', cycleId: null, waiting: '', note: '', basket: { ...b, position: (Number(b.position) || 0) + 1, outcomes: [...(b.outcomes || []), outcome] } });
    return true;
  }
  async payCycle(chain, launch, cycle) {
    const store = this.store(), asset = this.cycleAsset(launch, cycle), token = asset.mint !== SOL, role = this.rewardRole(launch), open = store.operationsFor(launch.id, 'airdrop').filter(op => op.expected?.cycleId === cycle.id && OPEN.includes(op.state)).at(-1);
    const shown = value => token ? `${amountText(value, asset.decimals)} ${asset.symbol}` : `${sol(value)} SOL`;
    if (open) {
      await this.settleOp(chain, open, (c, r) => c.receipt(this.chainOp(r), r.wallet), ({ state, receipt }) => {
        const cost = big(receipt?.actualSolCostLamports || 0);
        if (state === 'confirmed') {
          const paid = token ? big(open.expected.op.tokenAmount) : big(open.expected.op.inputAmount), next = cycle.next_index + open.expected.count, done = next >= cycle.payouts.length;
          store.updateRewardCycle(cycle.id, { next_index: next, paid: (big(cycle.paid) + paid).toString(), state: done ? 'complete' : 'paying' });
          // A pair-asset payout leaves the pair ledger, a basket asset's its own ledger; the network fee and any new holder accounts are SOL costs.
          if (token) { if (asset.extra) store.adjustBasket(launch.id, asset.mint, { paid, payments: done ? 1 : 0 }); else store.adjustQuote(launch.id, role, { converted: paid }); store.adjust(launch.id, role, { cost }); }
          else store.adjust(launch.id, role, { debit: paid, cost });
          if (launch.mode === 'insured') this.insuredPaid(launch, paid);
          if (done) store.addEvent({ launchId: launch.id, kind: 'rewards', title: asset.extra ? `Basket rewards paid in ${asset.symbol}` : launch.mode === 'insured' ? (this.optionPhase(launch) === 'bonus' || this.optionPhase(launch) === 'released' ? 'Graduation bonus paid' : 'Holder refund paid') : launch.mode === 'earned' ? 'Escrow paid to holders' : 'Holder rewards paid', body: `${shown(big(cycle.paid) + paid)} paid to ${cycle.payouts.length} holders.` });
        } else if (state === 'failed') store.adjust(launch.id, role, { cost });
      });
      return;
    }
    if (!this.effective().holders || this.backoff('airdrop:' + launch.id) || (token && this.openOp(launch.id, ['convert']))) return;
    try {
      const policy = this.policyOf(launch), batch = cycle.payouts.slice(cycle.next_index, cycle.next_index + (token ? this.cycleBatchSize(launch, cycle) : policy.holders.batchSize)); if (!batch.length) { store.updateRewardCycle(cycle.id, { state: 'complete' }); return; }
      const keys = await this.keys(launch), lamports = batch.reduce((sum, p) => sum + big(p.lamports || '0'), 0n), tokens = batch.reduce((sum, p) => sum + big(p.tokens || '0'), 0n);
      const op = await chain.prepareAirdrop(token
        ? { wallet: keys.mode, mint: asset.mint, payouts: batch.map(p => ({ owner: p.owner, lamports: '0', tokens: String(p.tokens) })), minSolReserve: String(this.tokenPayoutReserve(launch)), maxNetworkCostLamports: TOKEN_PAYOUT_MAX_COST_LAMPORTS }
        : { wallet: keys.mode, mint: SOL, payouts: batch.map(p => ({ owner: p.owner, lamports: p.lamports, tokens: '0' })), minSolReserve: String(policy.routing.keepLamports), maxNetworkCostLamports: '200000' });
      if (op.wallet !== launch.mode_wallet || op.kind !== 'airdrop' || big(op.inputAmount) !== lamports || (token && (op.mint !== asset.mint || big(op.tokenAmount) !== tokens))) throw publicFailure('The prepared payout could not be verified.');
      const row = this.journal(launch, 'airdrop', op, { cycleId: cycle.id, count: batch.length }); store.updateRewardCycle(cycle.id, { state: 'paying' });
      await this.broadcastOp(chain, row);
    } catch (error) {
      const attempts = this.retry.get('airdrop:' + launch.id)?.attempts || 0;
      // From the third failure a token batch is checked: recipients who can no longer receive leave the cycle, or a little more is sold for SOL.
      if (token && attempts >= 2) { try { if (await this.recoverTokenCycle(chain, launch, store.rewardCycle(cycle.id) || cycle, error)) { this.retry.delete('airdrop:' + launch.id); return; } } catch { /* the batch keeps retrying */ } }
      if (token && /cannot fund this airdrop|network and rent cost/i.test(String(error?.message))) this.alert(launch, 'A holder payout needs more SOL', `The holder rewards wallet ${launch.mode_wallet} cannot pay for the next batch’s new ${asset.symbol} token accounts and fee. Send it a little SOL; Launchpad retries automatically.`);
      else if (attempts >= 2) this.alert(launch, 'A holder payout batch is waiting', `${operatorError(error)} Launchpad retries automatically.`);
      this.retryLater('airdrop:' + launch.id, error, { base: 60000 });
    }
  }
  // ---- administrator payout requests (Admin → Pump.fun, Sell & distribute all, Distribute SOL rewards) ----------------------------
  /** Administrator: pay this Holders coin's holders now. Idempotent per request ID; a request made while a payout is open joins it. */
  async queueHolderPayout(actorId, { launchId, requestId, solOnly = false } = {}) {
    const actor = await this.requireAdmin(actorId);
    if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId)) fail('Choose a valid payout request.');
    if (!this.available()) return { state: 'skipped', reason: 'Pump.fun launches are disabled on this host.' };
    await this.ensure();
    return this.locked(async () => { await this.requireAdmin(actorId); return this.recordPayoutRequest(actor, { launchId, requestId, solOnly }); });
  }
  /** Records an administrator payout request (the caller holds the service lock). */
  recordPayoutRequest(actor, { launchId, requestId, solOnly = false, reason = '' }) {
    const store = this.store(), launch = typeof launchId === 'string' && /^[a-f0-9]{24}$/.test(launchId) ? store.launch(launchId) : null;
    if (!launch) return { state: 'skipped', reason: 'The coin no longer exists.' };
    const known = this.holderPayoutStatus({ launchId, requestId }); if (known.state !== 'missing') return known;
    if (!this.holderPayoutActive(launch)) return { state: 'skipped', reason: this.holderMode(launch) || launch.option ? 'This coin does not pay holder rewards right now.' : 'This coin does not pay holder rewards.' };
    if (launch.state !== 'created') return { state: 'skipped', reason: 'This coin is not live.' };
    if (solOnly && this.isQuote(launch)) return { state: 'skipped', reason: `Holder rewards on this coin are paid in ${this.pairOf(launch).symbol}. Use Sell & distribute all.` };
    if (!this.effective().holders) return { state: 'skipped', reason: HOLDERS_OFF };
    if (launch.fee_state !== 'verified') return { state: 'skipped', reason: 'This coin’s creator-fee sharing is not verified yet.' };
    const entry = { requestId, actorId: actor.id, at: this.now() }, current = this.payoutRequest(launch);
    if (current) this.savePayout(launch, { ...current, source: 'admin', requests: [...current.requests.filter(r => r.requestId !== requestId), entry] });
    else this.savePayout(launch, { v: 1, id: newId('hp'), source: 'admin', at: this.now(), stage: 'collect', requests: [entry] });
    store.addEvent({ launchId: launch.id, kind: 'rewards', title: 'Holder payout requested by the platform', body: `Requested by ${String(actor.username || 'an administrator').slice(0, 40)}.${reason ? ' ' + String(reason).slice(0, 500) : ''}`, isPublic: false });
    this.retry.delete('payout:' + launch.id);
    this.kick();
    return this.holderPayoutStatus({ launchId, requestId });
  }
  /** A payout request's state: missing (not recorded), processing or waiting while it runs, or its recorded result. */
  holderPayoutStatus({ launchId, requestId } = {}) {
    if (!this.pcStore || typeof launchId !== 'string' || !/^[a-f0-9]{24}$/.test(launchId) || typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId)) return { state: 'missing' };
    const store = this.store(), launch = store.launch(launchId); if (!launch) return { state: 'missing' };
    const saved = store.cursor(launch.id, 'payout-result:' + requestId);
    if (saved) { try { return JSON.parse(saved); } catch { return { state: 'blocked', reason: 'The saved payout result needs review.' }; } }
    const request = this.payoutRequest(launch); if (!request?.requests.some(r => r.requestId === requestId)) return { state: 'missing' };
    return this.payoutProgress(launch, request);
  }
  payoutProgress(launch, request) {
    const store = this.store(), asset = this.pairOf(launch), cycle = request.cycleId ? store.rewardCycle(request.cycleId) : null, sale = request.stage === 'freeze' && this.openOp(launch.id, ['convert'])?.expected?.purpose === 'payout-gas';
    const label = { collect: 'Collecting this coin’s creator fees.', basket: 'Buying the basket assets for this round.', freeze: 'Preparing the holder payout.', pay: 'Paying holders.' }[request.stage], off = !this.effective().holders;
    const paying = cycle ? this.cycleAsset(launch, cycle) : asset;
    return { state: off || request.waiting ? 'waiting' : 'processing', stage: sale ? 'convert' : request.stage === 'basket' ? 'convert' : request.stage, reason: off ? HOLDERS_OFF : request.waiting || request.note || label, asset: paying.symbol, decimals: paying.decimals,
      paid: cycle ? String(cycle.paid) : '0', amount: cycle ? String(cycle.amount) : null, held: this.payoutHeld(launch).toString(), recipients: cycle ? cycle.payouts.length : 0, ...(request.basket ? { basket: (request.basket.outcomes || []).map(o => ({ asset: o.asset, decimals: o.decimals, paid: o.paid, recipients: o.recipients })) } : {}) };
  }
  /** Admin "Sell & distribute all": this coin's part, in the bulk sweep's item shape. */
  async queueRewardSweep(actorId, input = {}) { return this.sweepView(await this.queueHolderPayout(actorId, { launchId: input.launchId, requestId: input.requestId })); }
  async rewardSweepStatus(input = {}) { if (!this.available()) return { state: 'missing' }; await this.ensure(); return this.sweepView(this.holderPayoutStatus({ launchId: input.launchId, requestId: input.requestId })); }
  sweepView(status) {
    if (!status || status.state === 'missing') return { state: 'missing' };
    const state = { completed: 'completed', skipped: 'skipped', blocked: 'blocked', failed: 'failed', waiting: 'waiting', processing: 'processing', queued: 'processing' }[status.state] || 'blocked';
    const stage = { collect: 'collect', freeze: 'distribute', convert: 'convert', pay: 'payout' }[status.stage] || (state === 'completed' ? 'done' : '');
    return { state, reason: String(status.reason || '').slice(0, 400), ...(stage ? { stage } : {}), ...(/^\d+$/.test(String(status.paid ?? '')) ? { distributedQuoteUnits: String(status.paid) } : {}), ...(/^\d+$/.test(String(status.held ?? '')) ? { remainingQuoteUnits: String(status.held) } : {}) };
  }
  /** Admin "Distribute SOL rewards": SOL-paired Holders coins only (a coin on another pair pays in its pair asset through Sell & distribute all). */
  async queueHeldSolDistribution(actorId, input = {}) { return this.heldSolView(await this.queueHolderPayout(actorId, { launchId: input.id, requestId: input.requestId, solOnly: true })); }
  async heldSolDistributionStatus(input = {}) { if (!this.available()) return { state: 'missing' }; await this.ensure(); return this.heldSolView(this.holderPayoutStatus({ launchId: input.id, requestId: input.requestId })); }
  heldSolView(status) {
    if (!status || status.state === 'missing') return { state: 'missing' };
    const state = { completed: 'completed', skipped: 'skipped', blocked: 'failed', failed: 'failed', waiting: 'waiting', processing: 'processing', queued: 'queued' }[status.state] || 'failed', sol = status.asset === undefined || status.asset === 'SOL';
    return { state, reason: String(status.reason || '').slice(0, 240), ...(sol && /^\d+$/.test(String(status.paid ?? '')) ? { paidLamports: String(status.paid) } : {}), ...(sol && /^\d+$/.test(String(status.held ?? '')) ? { remainingLamports: String(status.held) } : {}) };
  }

  // ---- managed strategies ------------------------------------------------------------------------
  strategyState(s) { return { cash: s.cash, tokens: s.tokens, contributed: s.contributed, lastActionAt: s.last_action_at, lastSide: s.last_side, lastPrice: s.last_price, dayKey: s.day_key, dayTurnover: s.day_turnover, dayFees: s.day_fees, fees_spent: s.fees_spent }; }
  async strategies(chain) {
    const store = this.store();
    for (const launch of store.liveLaunches().filter(row => isStrategyMode(row.mode))) {
      if (this.closed) return;
      const policy = this.policyOf(launch).strategies;
      const s = store.strategy(launch.id); if (!s) continue;
      const withdrawal = this.strategyWithdrawal(launch); if (withdrawal) { await this.settleStrategyWithdrawal(chain, launch, withdrawal); continue; }
      const open = this.openOp(launch.id, ['trade', 'lp-deposit', 'lp-withdraw']);
      if (open) { await this.settleStrategyOp(chain, launch, open); continue; }
      const status = observedStatus({ strategy: s, launch, kind: launch.mode });
      if (status !== s.observed) store.updateStrategy(launch.id, { observed: status });
      if (!this.effective().strategies || s.desired !== 'active' || launch.fee_state !== 'verified' || this.backoff('strategy:' + launch.id)) continue;
      const p = policy[launch.mode]; if (this.throttle('strategy:' + launch.id, p.pollMs)) continue;
      try {
        const coin = await chain.readCoin(launch.mint, { commitment: 'confirmed' }); if (!coin.exists) continue;
        if (coin.venue !== launch.venue_state) { this.venueChanged(launch, coin); continue; }
        if (coin.venue === 'migrating') continue;
        await this.verifyStrategyCash(chain, launch, s);
        if (launch.mode === 'market_maker') await this.marketMaker(chain, launch, s, coin, p); else await this.liquidityManager(chain, launch, s, coin, p);
      } catch (error) {
        const failures = (s.failures || 0) + 1; store.updateStrategy(launch.id, { failures });
        if (failures >= p.maxFailures) this.pauseStrategy(launch, `Paused after ${failures} consecutive failed checks: ${safeError(error)}`);
        this.retryLater('strategy:' + launch.id, error, { base: 60000 });
      }
    }
  }
  /**
   * The ledger may only spend capital the strategy wallet actually holds. A
   * shortfall counts as a failed check (an RPC can lag); if it persists the
   * strategy pauses for an operator to reconcile it.
   */
  async verifyStrategyCash(chain, launch, s) {
    const { balances } = await chain.walletBalances([launch.mode_wallet]), held = balances[launch.mode_wallet];
    if (held + 1000000n < big(s.cash)) throw publicFailure('The strategy wallet holds less SOL than its ledger; reconcile it before trading resumes.');
  }
  pauseStrategy(launch, reason) { const store = this.store(), s = store.strategy(launch.id); if (!s || s.desired !== 'active') return; store.updateStrategy(launch.id, { desired: 'paused', pause_reason: reason.slice(0, 300), observed: 'paused' }); store.addEvent({ launchId: launch.id, kind: 'strategy', title: 'Strategy paused', body: reason }); }
  async marketMaker(chain, launch, s, coin, p) {
    const store = this.store(), price = coin.venue === 'curve' ? curvePrice(coin.curve) : poolPrice({ baseReserve: coin.poolBase, quoteVault: coin.poolQuote, virtualQuoteReserves: coin.pool.virtual_quote_reserves });
    const decision = marketMakerDecision({ policy: p, state: this.strategyState(s), price, now: this.now() });
    const value = big(s.cash) + big(s.tokens) * price / 1000000000000n;
    store.updateStrategy(launch.id, { last_value: value.toString(), last_valued_at: this.now(), high_water: (value > big(s.high_water) ? value : big(s.high_water)).toString(), observed: decision.state === 'accumulating' ? 'accumulating' : 'active' });
    if (decision.action === 'pause') { this.pauseStrategy(launch, decision.reason); return; }
    if (decision.action === 'hold') return;
    const keys = await this.keys(launch), side = decision.action, amount = side === 'buy' ? decision.lamports : decision.tokens;
    const request = { wallet: keys.mode, mint: launch.mint, side, amount, slippageBps: p.slippageBps, maxImpactBps: p.maxImpactBps };
    const op = coin.venue === 'curve' ? await chain.prepareCurveTrade(request) : await chain.prepareAmmTrade(request);
    if (op.wallet !== launch.mode_wallet || op.mint !== launch.mint || op.side !== side || big(op.inputAmount) !== big(amount)) throw publicFailure('The prepared trade could not be verified.');
    const row = this.journal(launch, 'trade', op, { price: price.toString(), purpose: 'rebalance' }); await this.broadcastOp(chain, row);
  }
  async liquidityManager(chain, launch, s, coin, p) {
    const store = this.store();
    if (coin.venue !== 'amm') { if (s.observed !== 'waiting_for_graduation') store.updateStrategy(launch.id, { observed: 'waiting_for_graduation' }); return; }
    const price = poolPrice({ baseReserve: coin.poolBase, quoteVault: coin.poolQuote, virtualQuoteReserves: coin.pool.virtual_quote_reserves });
    const lpVal = lpValue({ lp: s.lp, lpSupply: coin.pool.lp_supply, baseReserve: coin.poolBase, quoteReserve: coin.poolQuote, price }), value = big(s.cash) + big(s.tokens) * price / 1000000000000n + lpVal;
    store.updateStrategy(launch.id, { last_value: value.toString(), last_valued_at: this.now(), high_water: (value > big(s.high_water) ? value : big(s.high_water)).toString() });
    if (big(s.contributed) > 0n && value * 10000n < big(s.contributed) * BigInt(10000 - p.lossLimitBps)) { this.pauseStrategy(launch, 'The loss limit was reached. An operator must review and resume this strategy.'); return; }
    const g = await chain.readGlobals();
    const feeBps = ammFeeBps({ globalConfig: g.ammGlobalConfig, feeConfig: g.ammFeeConfig, baseReserve: coin.poolBase, quoteReserve: coin.poolQuote + big(coin.pool.virtual_quote_reserves), supply: coin.mint.supply, canonical: true });
    const plan = lpPlan({ cash: s.cash, tokens: s.tokens, reserveLamports: p.cashReserveLamports, baseReserve: coin.poolBase, quoteVault: coin.poolQuote, virtualQuoteReserves: coin.pool.virtual_quote_reserves, feeBps });
    const contribution = plan.depositQuote + plan.depositBase * price / 1000000000000n;
    if (contribution < BigInt(p.minDepositLamports)) { if (s.observed !== 'accumulating') store.updateStrategy(launch.id, { observed: 'accumulating' }); return; }
    const keys = await this.keys(launch);
    // Swap only when the imbalance is material; a small residual (conservative
    // fee modelling, price drift) is left as cash for the next contribution.
    const spendable = max0(big(s.cash) - BigInt(p.cashReserveLamports)), material = spendable / 50n > 1000000n ? spendable / 50n : 1000000n;
    if (plan.swapLamports >= material) {
      const op = await chain.prepareAmmTrade({ wallet: keys.mode, mint: launch.mint, side: 'buy', amount: plan.swapLamports, slippageBps: p.slippageBps, maxImpactBps: p.maxImpactBps });
      if (op.wallet !== launch.mode_wallet || op.side !== 'buy') throw publicFailure('The prepared swap could not be verified.');
      const row = this.journal(launch, 'trade', op, { price: price.toString(), purpose: 'lp-swap' }); await this.broadcastOp(chain, row); return;
    }
    const maxBase = minBig(big(s.tokens), plan.depositBase), maxQuote = minBig(plan.depositQuote, max0(big(s.cash) - BigInt(p.cashReserveLamports)));
    const op = await chain.prepareLpDeposit({ wallet: keys.mode, mint: launch.mint, maxBase, maxQuote, slippageBps: p.slippageBps });
    if (op.wallet !== launch.mode_wallet || op.kind !== 'lp-deposit') throw publicFailure('The prepared deposit could not be verified.');
    const row = this.journal(launch, 'lp-deposit', op, { price: price.toString(), purpose: 'contribution' }); await this.broadcastOp(chain, row);
  }
  async settleStrategyOp(chain, launch, row) {
    const store = this.store(), lp = row.kind !== 'trade';
    await this.settleOp(chain, row, (c, r) => lp ? c.liquidityReceipt(this.chainOp(r)) : c.tradeReceipt(this.chainOp(r)), result => this.applyStrategyResult(launch, row, result));
  }
  applyStrategyResult(launch, row, result) {
    const store = this.store(), lp = row.kind !== 'trade';
    if (!['confirmed', 'failed'].includes(result.state)) return;
    const s = store.strategy(launch.id), r = result.receipt, fee = big(r.feeLamports ?? 0n);
    if (result.state === 'failed') { const failures = (s.failures || 0) + 1; store.updateStrategy(launch.id, { cash: (big(s.cash) - fee).toString(), fees_spent: (big(s.fees_spent) + fee).toString(), failures }); if (failures >= this.policyOf(launch).strategies[launch.mode].maxFailures) this.pauseStrategy(launch, 'Paused after repeated failed transactions.'); return; }
    if (!lp) {
      const side = row.expected.op.side, solChange = big(r.solDelta) - fee;
      store.updateStrategy(launch.id, applyTrade({ ...this.strategyState(s), fees_spent: s.fees_spent }, { side, solDelta: solChange, tokenDelta: big(r.tokenDelta), feeLamports: fee, price: big(row.expected.price || '0'), now: this.now() }));
      store.addEvent({ launchId: launch.id, kind: 'strategy', title: `${launch.mode === 'market_maker' ? 'Market Maker' : 'Liquidity Manager'} ${side === 'buy' ? 'bought' : 'sold'}`, body: side === 'buy' ? `${sol(-solChange)} SOL for ${wholeTokens(r.tokenDelta)} ${launch.symbol}.` : `${wholeTokens(-big(r.tokenDelta))} ${launch.symbol} for ${sol(solChange)} SOL.`, signature: row.signature });
    } else {
      const solChange = big(r.solDelta);
      store.updateStrategy(launch.id, { cash: (big(s.cash) + solChange).toString(), tokens: (big(s.tokens) + big(r.baseDelta)).toString(), lp: (big(s.lp) + big(r.lpDelta)).toString(), fees_spent: (big(s.fees_spent) + fee).toString(), last_action_at: this.now(), failures: 0 });
      store.addEvent({ launchId: launch.id, kind: 'strategy', title: row.kind === 'lp-deposit' ? 'Liquidity added' : 'Liquidity withdrawn', body: `${big(r.lpDelta) < 0n ? -big(r.lpDelta) : big(r.lpDelta)} LP tokens ${row.kind === 'lp-deposit' ? 'added to' : 'removed from'} the canonical PumpSwap position.`, signature: row.signature });
    }
  }

  // ---- worker loop ---------------------------------------------------------------------------------
  async process() {
    if (this.closed || !this.available()) return;
    const store = await this.ensure(); this.passes++;
    let chain = null; try { chain = await this.chainFactory(); } catch (error) { this.lastError = operatorError(error); return; }
    try {
      await this.locked(async () => {
        this.swapsLeft = SWAPS_PER_PASS;
        try {
          for (const pass of ['reconcileFunding', 'createCoins', 'reconcileCreation', 'deliver', 'refunds', 'trackVenues', 'collect', 'scanReceipts', 'convert', 'route', 'options', 'holders', 'strategies', 'recycleVanity']) {
            if (this.closed) return;
            try { await this[pass](chain); } catch (error) { this.lastError = `${pass}: ${operatorError(error)}`; }
          }
        } finally { this.swapsLeft = undefined; }
        this.expireQuotes();
      });
      this.lastPassAt = this.now();
      if (this.passes % 180 === 1) { try { this.db.backup(this.backupDirectory()); } catch (error) { this.lastError = 'backup: ' + safeError(error); } }
      this.db.checkpoint();
    } finally { await chain?.close?.(); }
    return store;
  }
  expireQuotes() { const store = this.store(); for (const launch of store.launchesInStates(['awaiting_funding'])) if (launch.quote_expires_at <= this.now() && !store.operationsFor(launch.id, 'funding').some(op => OPEN.includes(op.state))) store.moveLaunch(launch.id, 'awaiting_funding', 'expired', { state_reason: 'The quote expired before funding.' }); }
  kick() { if (this.closed || this.running || !this.available()) return this.running; this.running = this.process().catch(() => {}).finally(() => { this.running = null; }); return this.running; }
  start() { if (this.timer || this.closed || !this.available()) return; this.timer = setInterval(() => this.kick(), this.intervalMs); this.timer.unref?.(); this.initial = setTimeout(() => { this.initial = null; this.kick(); }, Math.min(this.intervalMs, 4000)); this.initial.unref?.(); }
  async close() {
    this.closed = true; clearInterval(this.timer); this.timer = null; clearTimeout(this.initial); this.initial = null;
    if (this.reader) { const reader = this.reader; this.reader = null; reader.then(chain => chain?.close?.(), () => {}); }
    for (const held of this.bursts || []) Promise.resolve().then(() => held.close?.()).catch(() => {});
    this.bursts?.clear();
    const settled = await Promise.race([Promise.resolve(this.running).then(() => true), new Promise(resolve => { const t = setTimeout(() => resolve(false), CLOSE_GRACE_MS); t.unref?.(); })]);
    if (settled) { try { this.db?.close(); } catch { /* already closed */ } }
  }
  backupDirectory() { return this.config.backupDir || join(this.accounts.dir, 'pump-classic', 'backups'); }

  // ---- views (never include key material) ------------------------------------------------------------
  quoteView(row) {
    const q = row.quote || {}, f = row.plan?.funding || {}, reserves = big(f.collectorGasLamports) + big(f.modeGasLamports), pair = this.pairOf(row), devBuy = this.devBuyRaw(row), quotePair = this.isQuote(row);
    const policy = this.policyOf(row), solPaid = this.solPaidPair(row), conversion = q.conversion || null, estimate = quotePair ? policy.costs.estimatedQuoteSetupLamports : policy.costs.estimatedSetupLamports;
    // devBuy is in the coin's quote asset. On another pair it is funded alongside the SOL total (v1/v2) or bought with SOL after funding (v3: devBuyPaidIn 'SOL').
    return { devBuySol: quotePair && !solPaid ? '0' : sol(row.dev_buy_lamports), devBuyPaidIn: quotePair && !solPaid ? pair.symbol : 'SOL', devBuy: amountText(devBuy, pair.decimals), devBuyRaw: devBuy.toString(), devBuySymbol: pair.symbol, pairAmountRaw: this.fundingTokens(row).toString(), pairAmount: amountText(this.fundingTokens(row), pair.decimals),
      pairBought: conversion?.receipt ? amountText(conversion.receipt.outputRaw, pair.decimals) : null, pairExpected: conversion ? amountText(conversion.expectedRaw, pair.decimals) : null, pairMinimum: conversion ? amountText(conversion.minimumRaw, pair.decimals) : null,
      pairSoldForSol: conversion?.unwind?.state === 'sold' ? sol(conversion.unwind.outputLamports || '0') : null,
      expectedTokens: q.expectedTokens || q.tokens || '0', minimumTokens: (big(q.tokens || '0') - big(q.tokens || '0') * BigInt(policy.launch.tokenTolerancePpm) / 1000000n).toString(), setupBudgetSol: sol(f.setupBudgetLamports), estimatedSetupSol: estimate ? sol(estimate) : null, conversionBudgetSol: f.conversionBudgetLamports ? sol(f.conversionBudgetLamports) : null,
      operatingReserveSol: sol(reserves), seedSol: sol(row.seed_lamports), totalSol: sol(f.totalLamports || '0'), totalLamports: String(f.totalLamports || '0'), expiresAt: row.quote_expires_at };
  }
  // ---- reward baskets (v71.35) --------------------------------------------------------------------
  /**
   * The creator's basket choice (`basket: [mint, mint]`, the extras only) checked for a new Holders launch: each extra
   * asset is read fresh from the chain (an ordinary or Token-2022 mint without a transfer tax, hook or frozen default),
   * must be accepted by the treasury conversion route and routable from SOL for a probe purchase within the basket guard
   * (nothing is bought), and needs a ticker Launchpad can show. Returns the frozen basket record (the main reward asset
   * first) or null when no basket was chosen.
   */
  async basketPlan(raw, { mode, quoteMint, quotePair, pairSymbol, decimals, asset, policy }) {
    let plan = null; try { plan = basketLaunchRequest(raw, { quoteMint }); } catch (error) { fail(error.message); }
    if (!plan) return null;
    const rules = policy.basket; if (!rules) fail('Reward baskets are not available for this launch.');
    if (!rules.modes.includes(mode)) fail('A reward basket is for Holders launches. Choose Holders, or remove the basket.');
    if (plan.extras.length > rules.maxExtras) fail(`A reward basket holds at most ${rules.maxExtras + 1} assets: your pair asset plus ${rules.maxExtras} more.`);
    const main = { mint: quotePair ? quoteMint : SOL, symbol: pairSymbol, decimals, program: quotePair ? asset.program : SPL_TOKEN_PROGRAM }, extras = [], chain = await this.chainFactory();
    try {
      const support = await chain.conversionSupport(plan.extras);
      for (const mint of plan.extras) {
        const info = await chain.basketAssetInfo(mint), symbol = quoteLabel(mint, info.metadata?.symbol);
        if (info.supported !== true) fail(`${symbol || mint} cannot join the basket: ${String(info.reason || 'Launchpad cannot handle this asset.').replace(/^This pair’s token/, 'its token')}`, 409);
        if (support.get(mint) !== true) fail(`${symbol} cannot join the basket: Launchpad’s swap route does not accept this asset.`, 409);
        try { await chain.quoteDevBuyConversion({ quoteMint: mint, program: info.program, lamports: big(rules.probeLamports), taker: generateWallet().address, slippageBps: rules.conversionSlippageBps, maxImpactBps: rules.conversionMaxImpactBps }); }
        catch (error) {
          const code = String(error?.code || '');
          if (['SOL_ROUTE_NOT_FOUND', 'TREASURY_PRICE_IMPACT', 'TREASURY_INVALID_IMPACT', 'TREASURY_SLIPPAGE_LIMIT', 'PUMP_CLASSIC_CONVERSION'].includes(code)) fail(`${symbol} cannot join the basket: no fair SOL route to it is available right now (at most ${rules.conversionMaxImpactBps / 100}% price impact). Choose a more liquid asset or try again shortly.`, 409, 'PUMP_CLASSIC_NO_ROUTE');
          if (code.startsWith('SOL_ROUTE_')) fail('Launchpad could not reach its swap route to check the basket. Try again shortly.', 503, 'PUMP_CLASSIC_ROUTE_UNAVAILABLE');
          throw error;
        }
        extras.push({ mint, symbol, decimals: info.decimals, program: info.program });
      }
    } finally { await chain.close?.(); }
    return { version: plan.version, assets: [main, ...extras], shares: 'equal', createdAt: this.now() };
  }
  /** The main reward asset of a coin (SOL, or the pair asset) and its extra basket assets, in basket order. */
  basketAssets(launch) { return Array.isArray(launch?.basket?.assets) && launch.basket.assets.length > 1 ? launch.basket.assets : null; }
  /** Public view of a coin's reward basket: its assets and, once live, each extra asset's pending and distributed amounts. */
  basketView(launch) {
    const assets = this.basketAssets(launch); if (!assets) return null;
    const store = this.store(), live = launch.state === 'created';
    return { version: launch.basket.version || 1, shares: 'equal', count: assets.length, description: describeBasket(assets.map(a => a.symbol)),
      assets: assets.map((a, i) => { const row = live && i > 0 ? store.basketBalance(launch.id, a.mint) : null; return { mint: a.mint, symbol: a.symbol, decimals: a.decimals, ...(row ? { pending: amountText(row.available, a.decimals), distributed: amountText(row.paid, a.decimals), payments: row.payments } : {}) }; }),
      ...(live ? { stage: this.basketStage(launch) } : {}) };
  }
  /** Where a basket coin's open payout stands ('convert', 'pay' or null), for the coin page. */
  basketStage(launch) { const request = this.payoutRequest(launch); return request?.basket ? (request.stage === 'basket' ? 'convert' : request.stage === 'pay' || request.stage === 'freeze' ? 'pay' : 'collect') : null; }
  launchView(row, { owner = false } = {}) {
    if (!row) return null;
    const view = {
      id: row.id, state: row.state, stateLabel: PUMP_CLASSIC_STATES[row.state] || row.state, reason: row.state_reason || '', mode: row.mode, modeLabel: PUMP_CLASSIC_MODE_LABELS[row.mode], venueLabel: 'Pump.fun',
      // v71.35: whether a holder payout can be requested now (Holders and Diamond Hands always; Earned once failed; Insured while refunding or paying its bonus).
      paysHolders: row.state === 'created' && this.holderPayoutActive(row),
      name: row.name, symbol: row.symbol, image: row.image, mint: row.mint, pumpUrl: `https://pump.fun/coin/${row.mint}`, coinUrl: `/coin?mint=${row.mint}`,
      dimensions: { launch: row.state, delivery: row.delivery_state, fees: row.fee_state, venue: row.venue_state, refund: row.refund_state },
      signatures: { funding: row.funding_signature || null, create: row.create_signature || null, refund: row.refund_signature || null },
      devTokens: row.dev_tokens, refundedSol: sol(row.refunded_lamports), createdAt: row.created_at, liveAt: row.live_at || null,
      pair: (({ mint, symbol, decimals, kind }) => ({ mint, symbol, decimals, kind }))(this.pairOf(row)), creatorFeeBps: Number(row.creator_fee_bps || 0),
      disclosure: pumpClassicDisclosure(row.mode, { pair: this.isQuote(row) ? this.pairOf(row).symbol : '', creatorFeeBps: Number(row.creator_fee_bps || 0), devBuyInSol: this.solPaidPair(row) }), feeLink: PUMP_CLASSIC_FEE_LINK,
      option: row.option ? (row.state === 'created' ? this.optionView(row) : { kind: row.mode, label: PUMP_CLASSIC_MODE_LABELS[row.mode], settings: { ...(row.option.settings || {}) }, description: describePumpOption(row.mode, row.option.settings || {}), phase: 'pending' }) : null,
      basket: this.basketView(row),
    };
    if (owner) Object.assign(view, { developerWallet: row.developer_wallet, launchWallet: row.launch_wallet, quote: this.quoteView(row), memo: row.plan?.memo || '', canCancel: row.state === 'awaiting_funding', canFund: row.state === 'awaiting_funding' && row.quote_expires_at > this.now(),
      refundedPair: this.isQuote(row) ? amountText(row.refunded_quote || '0', this.pairOf(row).decimals) : null, signatures: { ...view.signatures, pairRefund: row.quote_refund_signature || null } });
    return view;
  }
  strategyView(launch) {
    const s = this.store().strategy(launch.id); if (!s) return null;
    const status = observedStatus({ strategy: s, launch, kind: launch.mode }), perf = performance({ equity: big(s.last_value || '0') > 0n ? s.last_value : s.cash, contributed: s.contributed });
    return { kind: launch.mode, label: PUMP_CLASSIC_MODE_LABELS[launch.mode], status, statusLabel: PUMP_CLASSIC_STRATEGY_STATES[status] || status, wallet: s.wallet, cashSol: sol(s.cash), tokens: s.tokens, lp: s.lp, contributedSol: sol(s.contributed), equitySol: sol(perf.equity), resultSol: sol(perf.result), feesSpentSol: sol(s.fees_spent), lastActionAt: s.last_action_at || null, lastSide: s.last_side || null, pauseReason: s.pause_reason || '', valuedAt: s.last_valued_at || null };
  }
  async coinView(mint) {
    if (!this.available()) fail('Not found.', 404); await this.ensure();
    const store = this.store(), launch = isAddress(mint) ? store.launchByMint(mint) : null;
    if (!launch || launch.state !== 'created' || launch.hidden) fail('Not found.', 404);
    const totals = store.feeTotals(launch.id), recipientRole = this.roleOf(launch, launch.recipient), gross = Object.values(totals).reduce((sum, v) => sum + big(v), 0n), pair = this.pairOf(launch), d = pair.decimals;
    const holders = this.holderMode(launch) || this.holderPayoutActive(launch), quotePair = this.isQuote(launch);
    // On another pair Launchpad converts the shares it routes to SOL; holder rewards are paid in the pair asset (v71.24), so a Holders coin shows what holders were paid instead.
    const converted = quotePair && !holders ? store.conversions({ launchId: launch.id, state: 'confirmed' }).reduce((sum, c) => sum + big(c.output), 0n) : 0n;
    const recipientLabel = { developer: 'Creator wallet', rewards: 'Holder rewards wallet', gotchi: 'Gotchi pot relay', agent: 'AI agent relay', strategy: 'Strategy wallet', escrow: 'Creator escrow wallet', insured: 'Creator share and refund pot wallet' }[recipientRole];
    const cycles = holders ? store.rewardCycles(launch.id, 5).map(c => this.cycleView(launch, c)) : null, paidTotals = holders ? store.rewardPaidTotals(launch.id) : null;
    // Public: no internal activity (funding, refunds, account closures, operator alerts); those stay in the owner and admin views.
    return { mint: launch.mint, name: launch.name, symbol: launch.symbol, image: launch.image, mode: launch.mode, modeLabel: PUMP_CLASSIC_MODE_LABELS[launch.mode], venue: launch.venue_state, pool: launch.pool || null, pumpUrl: `https://pump.fun/coin/${launch.mint}`, liveAt: launch.live_at,
      developerWallet: launch.developer_wallet, createSignature: launch.create_signature, devTokens: launch.dev_tokens, feeState: launch.fee_state, feeLink: PUMP_CLASSIC_FEE_LINK,
      pair: { mint: pair.mint, symbol: pair.symbol, decimals: d, kind: pair.kind }, creatorFeeBps: Number(launch.creator_fee_bps || 0),
      recipients: [{ role: 'platform', label: 'Launchpad platform share', address: launch.protocol_wallet }, { role: recipientRole, label: recipientLabel, address: launch.recipient }],
      // Distributed amounts are in the coin's pair asset.
      fees: { symbol: pair.symbol, distributed: amountText(gross, d), platform: amountText(totals.protocol || '0', d), recipient: amountText(totals[recipientRole] || '0', d), convertedSol: quotePair && !holders ? sol(converted) : null,
        ...(holders ? { paidToHolders: quotePair ? amountText(paidTotals.tokens, d) : sol(paidTotals.sol), paidToHoldersSymbol: pair.symbol } : {}),
        ...(quotePair ? {} : { distributedSol: sol(gross), platformSol: sol(totals.protocol || '0'), recipientSol: sol(totals[recipientRole] || '0') }) },
      strategy: isStrategyMode(launch.mode) ? this.strategyView(launch) : null, rewards: cycles,
      holderRewards: holders ? { asset: pair.symbol, thresholdUsd: this.payoutThresholdUsd(), topHolders: this.policyOf(launch).holders.topHolders } : null,
      option: this.optionView(launch), basket: this.basketView(launch),
      gotchi: launch.gotchi ? { id: launch.gotchi.id, theme: launch.gotchi.theme } : null, agent: launch.agent ? { id: launch.agent.id, wallet: launch.agent.wallet } : null };
  }
  /** Public view of a coin's launch option (Diamond Hands, Earned, Insured): its settings, its rules in words and where its lifecycle stands. */
  optionView(launch) {
    const option = launch?.option; if (!option || !PUMP_CLASSIC_OPTION_MODES.includes(launch.mode)) return null;
    const store = this.store(), state = option.state || {}, settings = option.settings || {};
    const base = { kind: launch.mode, label: PUMP_CLASSIC_MODE_LABELS[launch.mode], settings: { ...settings }, description: describePumpOption(launch.mode, settings), phase: state.phase || 'pending', decidedAt: state.decidedAt || null };
    const daysLeft = at => Number.isFinite(Number(at)) ? Math.max(0, Math.ceil((Number(at) - this.now()) / 86400000)) : null;
    const swept = kind => store.sweeps({ kind, state: 'confirmed', launchId: launch.id }).reduce((sum, r) => sum + big(r.amount), 0n);
    switch (launch.mode) {
      case 'diamond_hands': {
        const top = store.topStreaks(launch.id, 10);
        return { ...base, phaseLabel: 'Active', capStreak: diamondCapStreak(settings), payouts: state.payouts || 0, lastPayout: state.lastPayoutAt ? { at: state.lastPayoutAt, paid: state.paidWallets || 0, skipped: state.skippedWallets || 0 } : null,
          holding: top.holding, streaks: top.rows.map(r => ({ owner: r.owner, streak: r.streak, multiplierBps: diamondMultiplierBps(r.streak, settings) })) };
      }
      case 'earned': {
        const labels = { pending: 'Waiting for the coin', probation: 'In probation', earned: 'Earned by the creator', failed: 'Failed · the escrow pays holders' };
        return { ...base, phaseLabel: labels[base.phase] || base.phase, baselineSol: state.baseline ? sol(state.baseline) : null, floorSol: state.floor ? sol(state.floor) : null, latestSol: state.latest?.marketCap ? sol(state.latest.marketCap) : null, latestAt: state.latest?.at || null,
          probationEndsAt: state.probationEndsAt || null, daysLeft: base.phase === 'probation' ? daysLeft(state.probationEndsAt) : 0, nextCheckAt: base.phase === 'probation' ? state.nextCheckAt || null : null,
          checks: (state.checks || []).slice(-10).map(c => ({ at: c.at, marketCapSol: sol(c.marketCap), ok: c.ok !== false })), escrowSol: sol(this.roleAvailable(launch, 'escrow')), releasedSol: sol(swept('escrow')), paidToHoldersSol: sol(store.rewardPaidTotals(launch.id).sol) };
      }
      case 'insured': {
        const labels = { pending: 'Waiting for the coin', active: 'Covered until the deadline', holders: 'Deadline missed · the pot pays holders', bonus: 'Graduated · bonus paid to holders', released: 'Graduated · pot released to the creator' };
        return { ...base, phaseLabel: labels[base.phase] || base.phase, target: insuredGraduationTarget(settings), deadlineAt: state.deadlineAt || null, daysLeft: base.phase === 'active' ? daysLeft(state.deadlineAt) : 0, graduated: launch.venue_state === 'amm',
          potSol: sol(state.pot || '0'), potCreditedSol: sol(state.potCredited || '0'), potPaidSol: sol(state.potPaid || '0'), potReleasedSol: sol(state.potReleased || '0'), creatorPaidSol: sol(swept('insured')), developerDueSol: sol(this.insuredDeveloperDue(launch)) };
      }
      default: return base;
    }
  }
  // ---- launch options worker (v71.35) ----------------------------------------------------------------------
  /** Earned: a market-cap record once a day from creation (the first is the baseline; one below the floor fails the coin; surviving the probation releases the escrow). Insured: the graduation deadline. */
  async options(chain) {
    const store = this.store();
    for (const launch of store.liveLaunches().filter(row => row.option && ['earned', 'insured'].includes(row.mode))) {
      if (this.closed) return;
      const state = launch.option.state || {}, policy = this.policyOf(launch);
      try {
        if (launch.mode === 'earned' && state.phase === 'probation' && this.now() >= Number(state.nextCheckAt || 0)) {
          if (this.backoff('option:' + launch.id)) continue;
          const coin = await chain.readCoin(launch.mint, { quote: this.chainQuote(launch) }), marketCap = this.marketCap(launch, coin);
          if (marketCap === null) throw publicFailure('The coin’s market cap could not be read.');
          this.earnedCheck(launch, marketCap);
        } else if (launch.mode === 'insured' && state.phase === 'active' && this.now() >= Number(state.deadlineAt || 0) && !this.throttle('option:' + launch.id, policy.options?.insured?.checkIntervalMs || 3600000)) {
          this.insuredDeadlinePassed(launch);
        }
      } catch (error) { this.retryLater('option:' + launch.id, error, { base: 300000 }); }
    }
  }
  earnedCheck(launch, marketCap) {
    const store = this.store(), settings = launch.option.settings, interval = this.policyOf(launch).options?.earned?.checkIntervalMs || 86400000; let outcome = null;
    this.updateOption(launch, state => {
      if (state.phase !== 'probation') return false;
      const at = this.now(), check = { at, marketCap: marketCap.toString(), ok: true };
      if (!state.baseline) { state.baseline = marketCap.toString(); state.floor = earnedFloor(marketCap, settings).toString(); outcome = 'baseline'; }
      else if (marketCap < big(state.floor)) { check.ok = false; state.phase = 'failed'; state.decidedAt = at; outcome = 'failed'; }
      else if (at >= Number(state.probationEndsAt)) { state.phase = 'earned'; state.decidedAt = at; outcome = 'earned'; }
      else outcome = 'ok';
      state.latest = { at, marketCap: marketCap.toString() }; state.checks = [...(state.checks || []), check].slice(-30);
      // The next record is due a day after this one (a late pass never bunches records together).
      state.nextCheckAt = at + interval;
    });
    if (!outcome) return;
    const body = `Market cap ${sol(marketCap)} SOL`;
    if (outcome === 'baseline') store.addEvent({ launchId: launch.id, kind: 'option', title: 'Baseline recorded', body: `${body}. The floor is ${settings.floorPercent}% of it: ${sol(earnedFloor(marketCap, settings))} SOL.` });
    else if (outcome === 'failed') store.addEvent({ launchId: launch.id, kind: 'option', title: 'Probation failed', body: `${body}, below the floor. The escrow and every later creator fee now pay holders.` });
    else if (outcome === 'earned') store.addEvent({ launchId: launch.id, kind: 'option', title: 'Probation passed', body: `${body}. The escrow is released to the creator, who now receives every creator fee.` });
    else store.addEvent({ launchId: launch.id, kind: 'option', title: 'Daily record above the floor', body: body + '.', isPublic: false });
  }
  insuredDeadlinePassed(launch) {
    const store = this.store(); let pot = null;
    this.updateOption(launch, state => { if (state.phase !== 'active') return false; state.phase = 'holders'; state.refundDue = 'refund'; state.decidedAt = this.now(); pot = big(state.pot || '0'); });
    if (pot === null) return;
    store.addEvent({ launchId: launch.id, kind: 'option', title: 'Graduation deadline missed', body: `The refund pot (${sol(pot)} SOL) is paid to holders, and the coverage share of every later creator fee goes to holders too.` });
  }
  /** A reward cycle in its payout asset (SOL cycles also keep their SOL fields). */
  cycleView(launch, c) {
    const asset = this.cycleAsset(launch, c), token = asset.mint !== SOL;
    return { state: c.state, asset: asset.symbol, amount: amountText(c.amount, asset.decimals), paid: amountText(c.paid, asset.decimals), ...(token ? {} : { amountSol: sol(c.amount), paidSol: sol(c.paid) }), ...(asset.extra ? { basketAsset: true, mint: asset.mint } : {}), recipients: c.payouts.length, at: c.created_at };
  }
  /** Owner view of a coin's holder payouts (Holders, Diamond Hands, a failed Earned coin, an Insured pot owed to holders): the open one and the last result. */
  payoutView(launch) {
    if (!this.holderPayoutActive(launch)) return null;
    const store = this.store(), request = this.payoutRequest(launch), asset = this.pairOf(launch);
    let last = null; try { last = JSON.parse(store.cursor(launch.id, 'holder-payout-last') || 'null'); } catch { last = null; }
    return { asset: asset.symbol, thresholdUsd: this.payoutThresholdUsd(), held: amountText(this.payoutHeld(launch), asset.decimals),
      open: request ? { source: request.source, stage: request.stage, note: String(request.waiting || request.note || ''), at: request.at, valueUsd: request.valueUsd ?? null, requests: request.requests.length } : null,
      last: last && typeof last === 'object' ? { state: String(last.state || ''), reason: String(last.reason || '').slice(0, 400), paid: /^\d+$/.test(String(last.paid ?? '')) ? amountText(last.paid, Number.isSafeInteger(last.decimals) ? last.decimals : asset.decimals) : '0', asset: String(last.asset || asset.symbol), recipients: Number(last.recipients) || 0, source: String(last.source || ''), at: last.at || null } : null };
  }

  // ---- integrations ---------------------------------------------------------------------------------------
  async ready() { if (!this.available()) return null; return this.ensure(); }
  /** Public discovery row: identity, links and verified venue only (no wallets, shares or keys). */
  publicRow(l) {
    const pair = this.pairOf(l), a = coinAddresses(l.mint, this.chainQuote(l)), known = knownQuoteAsset(pair.mint);
    return { platform: 'pump-classic', status: l.venue_state === 'amm' ? 'migrated' : 'trading', id: l.id, creatorId: l.account_id, mint: l.mint, name: l.name, symbol: l.symbol, description: l.description, image: l.image, createdAt: l.live_at || l.created_at, mode: l.mode, bondingCurve: a.bondingCurve, poolId: l.venue_state === 'amm' ? a.canonicalPool : null, venue: l.venue_state, website: l.website, twitter: l.twitter, telegram: l.telegram, gotchi: l.gotchi ? { id: l.gotchi.id, theme: l.gotchi.theme } : null, agent: l.agent ? { id: l.agent.id, wallet: l.agent.wallet, model: l.agent.model, capabilities: l.agent.capabilities } : null, hidden: !!l.hidden,
      option: l.option && PUMP_CLASSIC_OPTION_MODES.includes(l.mode) ? { kind: l.mode, phase: l.option.state?.phase || 'pending' } : null,
      basket: this.basketAssets(l) ? { count: l.basket.assets.length, symbols: l.basket.assets.map(a => a.symbol) } : null,
      quoteMint: pair.mint, quoteSymbol: pair.symbol, quoteDecimals: pair.decimals, quoteProgram: pair.program, quoteName: pair.mint === SOL ? 'Solana' : known?.name || pair.symbol, quoteCategory: pair.mint === SOL ? 'crypto' : known?.category || (pair.kind === 'custom' ? 'custom' : 'crypto'), creatorFeeBps: Number(l.creator_fee_bps || 0) };
  }
  async publicList() {
    const store = await this.ready(); if (!store) return [];
    return store.launchesWhere({ states: ['created'] }).filter(l => !l.hidden).map(l => this.publicRow(l));
  }
  /** Server-side analytics inventory (Analytics, Admin → Volume): every live coin, hidden ones too, with its funding wallet as the developer. Never served as is. */
  async analyticsList() {
    const store = await this.ready(); if (!store) return [];
    return store.launchesWhere({ states: ['created'] }).map(l => ({ ...this.publicRow(l), creatorWallet: l.developer_wallet }));
  }
  /** One coin for direct links; hidden coins still resolve so holders can open them. */
  async publicDetail(mint) {
    const store = await this.ready(); if (!store) return null;
    const l = isAddress(mint) ? store.launchByMint(mint) : null; return l && l.state === 'created' ? this.publicRow(l) : null;
  }
  /** One long-lived chain for public reads (discovery, coin pages); the worker keeps its own per pass. */
  readChain() { if (!this.reader) { this.reader = this.chainFactory(); this.reader.catch(() => { this.reader = null; }); } return this.reader; }
  publicLaunch(mint) { const store = this.store(), launch = isAddress(mint) ? store.launchByMint(mint) : null; return launch && launch.state === 'created' && !launch.hidden ? launch : null; }
  async cachedRead(cache, key, ttlMs, read) {
    const hit = cache.get(key), now = this.now();
    if (hit?.value !== undefined && now - hit.at < ttlMs) return hit.value;
    if (hit?.pending) return hit.pending;
    const pending = (async () => { try { const value = await read(); cache.set(key, { at: this.now(), value }); return value; } catch (error) { if (hit?.value !== undefined) cache.set(key, hit); else cache.delete(key); throw error; } })();
    cache.set(key, { ...(hit || {}), pending }); if (cache.size > 500) cache.delete(cache.keys().next().value);
    return pending;
  }
  /** Discovery market snapshot (src/launchpad-explore.mjs safeSnapshot shape). */
  async marketSnapshot(mint) {
    if (!this.available()) return null; await this.ensure(); if (!this.publicLaunch(mint)) return null;
    this.marketCache ||= new Map();
    const launch = this.publicLaunch(mint), pair = this.pairOf(launch), quote = this.isQuote(launch) ? { mint: pair.mint, program: pair.program, symbol: pair.symbol, decimals: pair.decimals, initialVirtualQuoteReserves: launch.quote_reserves } : null;
    return this.cachedRead(this.marketCache, mint, 10000, async () => (await this.readChain()).marketSnapshot(mint, { quote }));
  }
  /** Recent public trades in the discovery activity shape: seconds, side, quote amount (in the coin's pair asset), tokens, wallet, signature. */
  async trades(mint) {
    if (!this.available()) return []; await this.ensure(); const launch = this.publicLaunch(mint); if (!launch) return [];
    this.tradeCache ||= new Map(); const scale = 10 ** this.pairOf(launch).decimals, quote = this.chainQuote(launch);
    return this.cachedRead(this.tradeCache, mint, 45000, async () => (await (await this.readChain()).recentTrades(mint, { limit: 15, quote })).map(t => ({ time: Number.isSafeInteger(t.time) ? t.time : null, side: t.side, quote: Number(big(t.lamports)) / scale, amount: Number(big(t.tokens)) / 1e6, wallet: t.wallet, signature: t.signature, venue: t.venue })).filter(t => t.time));
  }
  async treasurySources() {
    const store = await this.ready(); if (!store) return [];
    return store.sweeps({ kind: 'protocol', state: 'confirmed' }).map(sw => ({ kind: 'pump-classic-protocol', signature: sw.signature, mint: SOL, amount: sw.amount, wallet: sw.to_wallet, sourceWallet: sw.from_wallet, decimals: 9, symbol: 'SOL' }));
  }
  /** SOL received as platform share: SOL-coin receipts plus SOL from converted pair-asset receipts. */
  async revenueSummary() {
    const store = await this.ready(); if (!store) return { receivedLamports: '0', routedLamports: '0', coins: 0 };
    let received = 0n, routed = 0n, coins = 0;
    for (const launch of store.liveLaunches()) { coins++; if (!this.isQuote(launch)) received += big(store.feeTotals(launch.id).protocol || '0'); }
    for (const c of store.conversions({ role: 'protocol', state: 'confirmed' })) received += big(c.output);
    for (const sw of store.sweeps({ kind: 'protocol', state: 'confirmed' })) routed += big(sw.amount);
    return { receivedLamports: received.toString(), routedLamports: routed.toString(), coins };
  }
  /** Platform-share receipts for the admin revenue report: one row per distribution leg, in the asset received. */
  async revenueSources() {
    const store = await this.ready(); if (!store) return { complete: true, sources: [] };
    const rows = store.db.all("SELECT r.signature, r.event_index, r.recipient, r.amount, r.quote_mint, l.quote_decimals, l.quote_symbol FROM fee_receipts r JOIN launches l ON l.id = r.launch_id WHERE r.role = 'protocol' ORDER BY r.slot");
    return { complete: true, sources: rows.map(r => { const native = (r.quote_mint || SOL) === SOL; return { kind: 'platform-share', signature: r.signature, eventIndex: r.event_index, wallet: r.recipient, amount: r.amount, mint: native ? SOL : r.quote_mint, decimals: native ? 9 : r.quote_decimals, symbol: native ? 'SOL' : r.quote_symbol }; }) };
  }
  async gotchiLaunches() {
    const store = await this.ready(); if (!store) return [];
    return store.launchesWhere({ mode: 'gotchi', states: ['created'] }).filter(l => l.gotchi).map(l => ({ venue: 'pump', mint: l.mint, name: l.name, symbol: l.symbol, image: l.image, gotchi: { id: l.gotchi.id, theme: l.gotchi.theme, vault: l.gotchi.vault, attachedAt: l.created_at }, status: 'live', live: true, createdAt: l.live_at || l.created_at,
      quoteMint: SOL, quoteDecimals: 9, quoteSymbol: 'SOL', baseDecimals: 6, custody: this.curveWallets(l), hidden: !!l.hidden, archived: !!l.archived, contributedRaw: store.sweeps({ kind: 'gotchi', state: 'confirmed', launchId: l.id }).reduce((sum, sw) => sum + big(sw.amount), 0n).toString(), pendingRaw: this.roleAvailable(l, 'gotchi').toString(), unconvertedBaseRaw: '0', accountId: l.account_id, launchId: l.id, graduated: l.venue_state === 'amm', graduatedAt: l.graduated_at || null }));
  }
  /** The launches these sweeps came from, by id (every one, however old). */
  sweptLaunches(store, sweeps) { const byId = new Map(); for (const sw of sweeps) if (!byId.has(sw.launch_id)) byId.set(sw.launch_id, store.launch(sw.launch_id)); return byId; }
  async gotchiSources() {
    const store = await this.ready(); if (!store) return [];
    const sweeps = store.sweeps({ kind: 'gotchi', state: 'confirmed' }), byId = this.sweptLaunches(store, sweeps);
    return sweeps.flatMap(sw => { const l = byId.get(sw.launch_id); return l?.mode === 'gotchi' && l.gotchi ? [{ kind: 'pump-classic-gotchi', gotchiId: l.gotchi.id, launchMint: l.mint, venue: 'pump', signature: sw.signature, mint: SOL, amount: sw.amount, wallet: sw.to_wallet, sourceWallet: sw.from_wallet, decimals: 9, symbol: 'SOL', at: sw.updated_at }] : []; });
  }
  async agentLaunches() {
    const store = await this.ready(); if (!store) return [];
    return store.launchesWhere({ mode: 'agent', exceptStates: UNFUNDED }).filter(l => l.agent).map(l => ({ venue: 'pump', mint: l.mint, launchId: l.id, accountId: l.account_id, name: l.name, symbol: l.symbol, image: l.image, agent: { ...l.agent }, creatorWallet: l.developer_wallet, status: l.state, live: l.state === 'created', created: l.state === 'created', createdAt: l.live_at || l.created_at, authorizedAt: l.funded_at || null,
      failed: ['failed', 'refunded', 'cancelled', 'expired'].includes(l.state), feeCustody: 'relay', feeWallet: l.mode_wallet, quoteMint: SOL, quoteDecimals: 9, custody: this.curveWallets(l), hidden: !!l.hidden, archived: !!l.archived, paidRaw: store.sweeps({ kind: 'agent', state: 'confirmed', launchId: l.id }).reduce((sum, sw) => sum + big(sw.amount), 0n).toString(), pendingRaw: l.state === 'created' ? this.roleAvailable(l, 'agent').toString() : '0', redirected: l.fee_state === 'mismatch' }));
  }
  async agentSources() {
    const store = await this.ready(); if (!store) return [];
    const sweeps = store.sweeps({ kind: 'agent', state: 'confirmed' }), byId = this.sweptLaunches(store, sweeps);
    return sweeps.flatMap(sw => { const l = byId.get(sw.launch_id); return l?.mode === 'agent' && l.agent ? [{ kind: 'pump-classic-agent', agentId: l.agent.id, launchMint: l.mint, venue: 'pump', signature: sw.signature, allocation: `${l.mint}:pump-sweep`, mint: SOL, amount: sw.amount, wallet: sw.to_wallet, sourceWallet: sw.from_wallet, decimals: 9, at: sw.updated_at }] : []; });
  }

  // ---- owner controls -------------------------------------------------------------------------------------------
  async requireAdmin(id) { const actor = await this.accounts.get(id); if (!actor || actor.role !== 'admin' || !actor.mfaEnabled || actor.banned) fail('Administrator access with two-factor authentication is required.', 403); return actor; }
  adminRow(launch) {
    const store = this.store(), balances = store.balances(launch.id), policy = this.policyOf(launch), pair = this.pairOf(launch), quotePair = this.isQuote(launch);
    // The pair ledger's "converted" is everything that left it: sales to SOL and, for holder rewards, payouts in the pair asset.
    const paidTokens = quotePair && this.holderMode(launch) ? store.rewardPaidTotals(launch.id).tokens : 0n;
    const strategy = isStrategyMode(launch.mode) ? this.strategyView(launch) : null, holderPayout = this.payoutView(launch);
    return { ...this.launchView(launch, { owner: true }), accountId: launch.account_id, protocolWallet: launch.protocol_wallet, modeWallet: launch.mode_wallet, recipient: launch.recipient, hidden: !!launch.hidden, archived: !!launch.archived, updatedAt: launch.updated_at || launch.created_at, attention: this.attentionFor(launch, strategy, holderPayout), archive: this.archiveEligibility(launch), policyVersion: launch.policy_version, platformShareBps: policy.platformShareBps[launch.mode], shareholders: launch.shareholders,
      createAttempts: launch.create_attempts, balances: Object.fromEntries(Object.entries(balances).map(([role, b]) => [role, { credited: sol(b.credited), debited: sol(b.debited), costs: sol(b.costs) }])), feeTotals: Object.fromEntries(Object.entries(store.feeTotals(launch.id)).map(([k, v]) => [k, amountText(v, pair.decimals)])), feeUnit: pair.symbol,
      pairBalances: quotePair ? Object.fromEntries(Object.entries(store.quoteBalances(launch.id)).map(([role, b]) => { const paid = role === 'rewards' ? minBig(paidTokens, b.converted) : 0n; return [role, { credited: amountText(b.credited, pair.decimals), converted: amountText(b.converted - paid, pair.decimals), paid: amountText(paid, pair.decimals), held: amountText(b.available, pair.decimals) }]; })) : null,
      holderPayout,
      conversions: quotePair ? store.conversions({ launchId: launch.id }).slice(-10).map(c => ({ role: c.role, state: c.state, input: amountText(c.input, pair.decimals), outputSol: sol(c.output), signature: c.signature })) : null,
      fundedPair: quotePair ? amountText(launch.funded_quote || '0', pair.decimals) : null, pairRefund: quotePair ? launch.quote_refund_state : null, fundedSol: sol(launch.funded_lamports || '0'),
      strategy, openOperations: store.openOperations(launch.id).map(op => ({ id: op.id, kind: op.kind, state: op.state, signature: op.signature, error: op.error, attempts: op.attempts })), events: store.events(launch.id, { publicOnly: false, limit: 20 }) };
  }
  /**
   * The owner view. Without options every reviewable launch is returned (live, in progress or ended after
   * funding, plus the newest 200 for context: abandoned quotes never push a coin's controls out of view).
   * With `offset`/`limit` the list is paged after `search` (name, ticker, mint, id, account), `state`
   * (a launch state, or `attention` for launches needing the owner) and `mode` filters; archived launches
   * are left out unless `archived` is true, which then lists only them. Counts cover the whole reviewable set.
   */
  async adminOverview(actorId, { offset, limit, search = '', state = '', mode = '', archived = false } = {}) {
    await this.requireAdmin(actorId);
    if (!this.available()) return { available: false, reason: 'Pump.fun launches are disabled on this host. Set LAUNCHPAD_PUMP_CLASSIC_ENABLED=1 in /etc/launchpad.env and restart.', flagLabels: FLAG_LABELS };
    const store = await this.ensure();
    const base = { available: true, flags: this.flags(), flagLabels: FLAG_LABELS, effective: this.effective(), policy: { version: PUMP_CLASSIC_POLICY.version, hash: PUMP_CLASSIC_POLICY_HASH }, lastPassAt: this.lastPassAt || null, lastError: this.lastError || '', database: { ok: this.db.integrity(), version: this.db.version() } };
    const reviewable = store.launchesForReview({ exceptStates: ABANDONED, recent: 200 });
    if (offset === undefined && limit === undefined) return { ...base, launches: reviewable.map(row => this.adminRow(row)) };
    if (typeof search !== 'string' || search.length > 128) fail('Search must be 128 characters or fewer.');
    offset = Number(offset ?? 0); limit = Number(limit ?? 25);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('Invalid launch page.');
    if (state && state !== 'attention' && !Object.hasOwn(PUMP_CLASSIC_STATES, state)) fail('Choose a valid launch state.');
    if (mode && !PUMP_CLASSIC_MODES.includes(mode)) fail('Choose a valid launch mode.');
    const showArchived = archived === true || archived === 'true' || archived === '1', query = search.trim().toLowerCase();
    const rows = reviewable.map(row => this.adminRow(row)), counts = { total: rows.length, archived: 0, attention: 0, byState: {}, byMode: {} };
    for (const row of rows) { counts.byState[row.state] = (counts.byState[row.state] || 0) + 1; counts.byMode[row.mode] = (counts.byMode[row.mode] || 0) + 1; if (row.archived) counts.archived++; if (row.attention.length) counts.attention++; }
    const matched = rows.filter(row => (showArchived ? row.archived : !row.archived) && (!mode || row.mode === mode) && (state === 'attention' ? row.attention.length > 0 : !state || row.state === state)
      && (!query || [row.name, row.symbol, row.mint, row.id, row.accountId, row.developerWallet, row.reason, row.stateLabel, row.modeLabel].some(value => String(value || '').toLowerCase().includes(query))));
    return { ...base, launches: matched.slice(offset, offset + limit), launchTotal: matched.length, counts, offset, limit, nextOffset: offset + limit < matched.length ? offset + limit : null, search: query, state, mode, archived: showArchived };
  }
  /** What needs the owner on a launch: a waiting refund, a paused strategy, a blocked payout, funding that never finished. */
  attentionFor(launch, strategy = null, payout = null) {
    const items = [], now = this.now(), quote = this.isQuote(launch);
    if (launch.refund_state === 'pending' || quote && ['pending', 'released'].includes(launch.quote_refund_state)) items.push({ code: 'refund', text: quote && launch.quote_refund_state === 'pending' ? 'Pair refund waiting' : 'Refund waiting' });
    if (strategy && strategy.status === 'paused') items.push({ code: 'strategy-paused', text: 'Strategy paused' });
    if (payout?.last?.state === 'blocked' && !payout.open) items.push({ code: 'payout-blocked', text: 'Holder payout blocked' });
    if (['funded', 'creating', 'funding_pending'].includes(launch.state) && now - (launch.funded_at || launch.updated_at || launch.created_at || now) > 3600000) items.push({ code: 'stuck', text: 'Funding never finished' });
    if (launch.state === 'failed' && launch.refund_state !== 'pending') items.push({ code: 'failed', text: 'Failed' });
    return items;
  }
  /** Whether a finished launch can leave the owner's lists: its money is settled and nothing is still being checked. */
  archiveEligibility(launch) {
    if (launch.archived) return { eligible: false, reason: 'This launch is already archived.' };
    if (!['failed', 'refunded', 'cancelled', 'expired'].includes(launch.state)) return { eligible: false, reason: 'Only a launch that failed, was refunded, cancelled or expired can be archived.' };
    if (launch.refund_state === 'pending' || this.isQuote(launch) && ['pending', 'released'].includes(launch.quote_refund_state)) return { eligible: false, reason: 'Its refund is still being returned. It can be archived once the refund settles.' };
    if (this.store().openOperations(launch.id).length) return { eligible: false, reason: 'A transaction for this launch is still being checked.' };
    return { eligible: true, reason: '' };
  }
  /**
   * Launches that stopped before (or after) going live and still need the owner, for the Cleanup page: failed,
   * refunding, refunded, cancelled and expired launches, funding that never finished, and live coins whose pair
   * refund is waiting. Archived rows are included (flagged) so the page can show them on request.
   */
  async adminUnfinished(actorId) {
    await this.requireAdmin(actorId);
    if (!this.available()) return [];
    const store = await this.ensure(), now = this.now(), people = typeof this.accounts?.list === 'function' ? await this.accounts.list() : [], byId = new Map(people.map(a => [a.id, a]));
    const rows = [];
    for (const launch of store.launchesWhere({})) {
      const expiredQuote = launch.state === 'awaiting_funding' && launch.quote_expires_at <= now;
      const state = expiredQuote ? 'expired' : launch.state;
      const stuck = ['funded', 'creating', 'funding_pending'].includes(launch.state) && now - (launch.funded_at || launch.updated_at || launch.created_at || now) > 3600000;
      const refund = launch.refund_state === 'pending' || this.isQuote(launch) && ['pending', 'released'].includes(launch.quote_refund_state);
      if (!['failed', 'refunding', 'refunded', 'cancelled', 'expired'].includes(state) && !stuck && !refund) continue;
      if (launch.state === 'draft') continue;
      const pair = this.pairOf(launch), quote = this.isQuote(launch), archive = this.archiveEligibility(launch), open = store.openOperations(launch.id);
      const money = [];
      if (big(launch.funded_lamports || '0') > 0n) money.push(`${sol(launch.funded_lamports)} SOL funded`);
      if (big(launch.refunded_lamports || '0') > 0n) money.push(`${sol(launch.refunded_lamports)} SOL refunded`);
      if (quote && big(launch.funded_quote || '0') > 0n) money.push(`${amountText(launch.funded_quote, pair.decimals)} ${pair.symbol} funded`);
      if (quote && big(launch.refunded_quote || '0') > 0n) money.push(`${amountText(launch.refunded_quote, pair.decimals)} ${pair.symbol} refunded`);
      const actions = [];
      if (launch.state === 'funded' && !this.openOp(launch.id, ['launch', 'acquire', 'setup'])) actions.push('refund');
      if (quote && launch.quote_refund_state === 'pending' && launch.refund_state === 'pending' && ['created', 'failed'].includes(launch.state)) actions.push('release-sol-refund');
      if (archive.eligible) actions.push('archive');
      if (launch.archived) actions.push('unarchive');
      if (launch.state === 'created') actions.push(launch.hidden ? 'unhide' : 'hide');
      // A quote that expired or was cancelled before any funding arrived is an abandoned review, not a launch.
      const abandoned = ['expired', 'cancelled'].includes(state) && big(launch.funded_lamports || '0') === 0n && !launch.funding_signature;
      rows.push({
        accountId: launch.account_id, username: String(byId.get(launch.account_id)?.username || '').slice(0, 32), id: launch.id, mint: launch.mint, name: String(launch.name || '').slice(0, 100), symbol: String(launch.symbol || '').slice(0, 24),
        state, stateLabel: PUMP_CLASSIC_STATES[state] || state, mode: launch.mode, modeLabel: PUMP_CLASSIC_MODE_LABELS[launch.mode] || launch.mode, kind: launch.archived ? 'archived' : refund ? 'refund' : stuck ? 'unfinished' : abandoned ? 'abandoned' : 'failed',
        reason: String(launch.state_reason || (stuck ? 'Funding was received but the coin was never created.' : expiredQuote ? 'The quote expired before funding.' : '')).slice(0, 300),
        createdAt: launch.created_at, updatedAt: launch.updated_at || launch.created_at, money: money.join(' · '), moneyZero: !money.length, pending: open.length > 0, recovery: refund,
        refundState: launch.refund_state, pairRefundState: quote ? launch.quote_refund_state : null, pair: quote ? pair.symbol : 'SOL',
        archived: !!launch.archived, hidden: !!launch.hidden, listArchived: !!launch.archived || !!launch.hidden, archiveReason: archive.reason, bulkEligible: archive.eligible, bulkCode: '', actions,
      });
    }
    await this.requireAdmin(actorId);
    return rows;
  }
  /** Overview alerts for the admin home: refunds waiting, paused strategies, blocked payouts, funding that never finished. */
  async adminAttention(actorId) {
    await this.requireAdmin(actorId);
    if (!this.available()) return { refunds: 0, strategiesPaused: 0, payoutsBlocked: 0, stuck: 0, failed: 0 };
    const store = await this.ensure(), totals = { refunds: 0, strategiesPaused: 0, payoutsBlocked: 0, stuck: 0, failed: 0 };
    for (const launch of store.launchesWhere({ exceptStates: ABANDONED })) {
      if (launch.archived) continue;
      for (const item of this.attentionFor(launch, isStrategyMode(launch.mode) ? this.strategyView(launch) : null, this.holderPayoutActive(launch) ? this.payoutView(launch) : null)) {
        if (item.code === 'refund') totals.refunds++; else if (item.code === 'strategy-paused') totals.strategiesPaused++; else if (item.code === 'payout-blocked') totals.payoutsBlocked++; else if (item.code === 'stuck') totals.stuck++; else if (item.code === 'failed') totals.failed++;
      }
    }
    return totals;
  }
  async adminControl(actorId, { flags, launchId, action, reason, lpAmount } = {}) {
    const actor = await this.requireAdmin(actorId), store = await this.ensure();
    if (typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 500) fail('Enter a reason between 5 and 500 characters.');
    const why = reason.trim();
    return this.locked(async () => {
      if (flags !== undefined) {
        if (!flags || typeof flags !== 'object') fail('Invalid flags.');
        for (const [key, value] of Object.entries(flags)) { if (!Object.hasOwn(DEFAULT_FLAGS, key) || typeof value !== 'boolean') fail(`Invalid ${key} flag.`); store.setFlag(key, value, { reason: why, by: actor.username }); }
      }
      if (launchId !== undefined) {
        const launch = store.launch(String(launchId)); if (!launch) fail('Launch not found.', 404);
        const s = store.strategy(launch.id);
        if (action === 'pause-strategy') { if (!s) fail('This launch has no strategy.'); store.updateStrategy(launch.id, { desired: 'paused', pause_reason: why, observed: 'paused' }); }
        else if (action === 'resume-strategy') { if (!s || s.desired === 'retired') fail('This strategy cannot be resumed.'); if (this.openOp(launch.id, ['trade', 'lp-deposit', 'lp-withdraw'])) fail('Wait for the open strategy transaction to reconcile.', 409); store.updateStrategy(launch.id, { desired: 'active', pause_reason: '', failures: 0 }); }
        else if (action === 'retire-strategy') { if (!s) fail('This launch has no strategy.'); store.updateStrategy(launch.id, { desired: 'retired', pause_reason: why, observed: 'retired' }); }
        else if (action === 'refund') { if (!['funded'].includes(launch.state)) fail('Only a funded launch that has not been created can be refunded.', 409); if (this.openOp(launch.id, ['launch', 'acquire', 'setup'])) fail('A transaction for this launch is still being checked.', 409); this.failLaunch(launch, 'funded', 'Refunded by the platform before creation.'); }
        else if (action === 'release-sol-refund') {
          if (!this.isQuote(launch) || launch.quote_refund_state !== 'pending' || launch.refund_state !== 'pending' || !['created', 'failed'].includes(launch.state)) fail('Only a launch whose pair refund is still pending can release its SOL refund.', 409);
          if (this.openOp(launch.id, ['quote-refund', 'unwind'])) fail('A pair refund or sale transaction is still being checked.', 409);
          store.updateLaunch(launch.id, { quote_refund_state: 'released' });
        }
        else if (action === 'hide' || action === 'unhide') store.updateLaunch(launch.id, { hidden: action === 'hide' });
        // Archiving only organises the owner's lists: the journal row, its keys and its receipts stay as they are.
        else if (action === 'archive') { const archive = this.archiveEligibility(launch); if (!archive.eligible) fail(archive.reason, 409); store.updateLaunch(launch.id, { archived: true }); }
        else if (action === 'unarchive') { if (!launch.archived) fail('This launch is not archived.', 409); store.updateLaunch(launch.id, { archived: false }); }
        else if (action === 'lp-withdraw') await this.operatorWithdrawLp(launch, s, lpAmount);
        else if (action === 'withdraw-strategy-sol') await this.operatorWithdrawStrategySol(launch, s);
        else if (action === 'pay-holders') {
          // Pays this Holders coin's holders now: collect, then pay in the pair asset (the $100 trigger is waived).
          const result = this.recordPayoutRequest(actor, { launchId: launch.id, requestId: randomBytes(16).toString('hex'), reason: why });
          if (['skipped', 'blocked', 'failed'].includes(result.state)) fail(result.reason || 'This coin cannot pay its holders right now.', 409);
        }
        else if (action !== undefined) fail('Unknown action.');
        // A payout request records its own event (with the reason) in recordPayoutRequest.
        if (action && action !== 'pay-holders') store.addEvent({ launchId: launch.id, kind: 'admin', title: { 'pause-strategy': 'Strategy paused by the platform', 'resume-strategy': 'Strategy resumed by the platform', 'retire-strategy': 'Strategy retired by the platform', refund: 'Refunded by the platform', 'release-sol-refund': 'SOL refund released by the platform; the pair refund keeps retrying', hide: 'Hidden by moderation', unhide: 'Listed again', 'lp-withdraw': 'Liquidity withdrawal requested by the platform', 'withdraw-strategy-sol': 'Return of the retired strategy’s SOL requested by the platform', 'pay-holders': 'Holder payout requested by the platform', archive: 'Archived by the platform', unarchive: 'Restored from the archive by the platform' }[action], body: ['hide', 'unhide', 'archive', 'unarchive'].includes(action) ? '' : why, isPublic: !['hide', 'unhide', 'pay-holders', 'archive', 'unarchive'].includes(action) });
      } else if (action === 'archive-all') {
        // Every finished launch whose money is settled leaves the owner's lists at once (abandoned quotes included).
        let archived = 0;
        store.db.transaction(() => { for (const launch of store.launchesWhere({ states: ['failed', 'refunded', 'cancelled', 'expired'] })) { if (!this.archiveEligibility(launch).eligible) continue; store.updateLaunch(launch.id, { archived: true }); store.addEvent({ launchId: launch.id, kind: 'admin', title: 'Archived by the platform', body: '', isPublic: false }); archived++; } });
        this.lastArchiveAll = { at: this.now(), archived, by: actor.username };
      } else if (action !== undefined && launchId === undefined && flags === undefined) fail('Unknown action.');
      this.kick();
      return this.adminOverview(actorId);
    });
  }
  /** Operator-initiated LP withdrawal; proceeds stay in the same coin's strategy wallet. */
  async operatorWithdrawLp(launch, s, lpAmount) {
    if (!s || launch.mode !== 'lp_manager') fail('Only a Liquidity Manager position can be withdrawn.');
    const amount = big(String(lpAmount ?? '')); if (amount <= 0n || amount > big(s.lp)) fail('Enter an LP amount up to the strategy’s recorded position.');
    if (this.openOp(launch.id, ['trade', 'lp-deposit', 'lp-withdraw']) || this.strategyWithdrawal(launch)) fail('Wait for the open strategy transaction to reconcile.', 409);
    const chain = await this.chainFactory();
    try {
      const keys = await this.keys(launch), op = await chain.prepareLpWithdraw({ wallet: keys.mode, mint: launch.mint, lpAmount: amount, slippageBps: this.policyOf(launch).strategies.lp_manager.slippageBps });
      if (op.wallet !== launch.mode_wallet || op.kind !== 'lp-withdraw') throw publicFailure('The prepared withdrawal could not be verified.');
      const row = this.journal(launch, 'lp-withdraw', op, { purpose: 'operator' }); await this.broadcastOp(chain, row);
    } finally { await chain.close?.(); }
  }
  /**
   * Owner action for a retired strategy: the SOL in its wallet goes back to the
   * coin's funding wallet. Its tokens and LP stay. The wallet keeps
   * STRATEGY_WALLET_RESERVE: it is one of the coin's fee shareholders, and
   * Pump's distribution fails while a shareholder wallet is closed. Repeatable,
   * since the coin's creator fees keep arriving there.
   */
  async operatorWithdrawStrategySol(launch, s) {
    if (!s || !isStrategyMode(launch.mode)) fail('This launch has no strategy.');
    if (s.desired !== 'retired') fail('Retire the strategy before withdrawing its SOL.', 409);
    if (launch.state !== 'created') fail('Only a live coin’s strategy can be withdrawn.', 409);
    if (this.openOp(launch.id, ['trade', 'lp-deposit', 'lp-withdraw']) || this.strategyWithdrawal(launch)) fail('Wait for the open strategy transaction to reconcile.', 409);
    const chain = await this.chainFactory();
    try {
      const keys = await this.keys(launch);
      let op;
      try { op = await chain.prepareDrain({ wallet: keys.mode, recipient: launch.developer_wallet, keepLamports: STRATEGY_WALLET_RESERVE, minContextSlot: this.settledSlot(launch) }); }
      catch (error) { if (['PUMP_CLASSIC_EMPTY', 'PUMP_CLASSIC_REFUND'].includes(error?.code)) fail('The strategy wallet has no SOL to withdraw beyond its 0.001 SOL reserve.', 409); throw error; }
      if (op.wallet !== launch.mode_wallet || op.recipient !== launch.developer_wallet || big(op.accounting?.minSolReserve) !== STRATEGY_WALLET_RESERVE) throw publicFailure('The prepared withdrawal could not be verified.');
      const row = this.journal(launch, 'withdraw', op, { purpose: 'strategy-withdraw', keepLamports: STRATEGY_WALLET_RESERVE.toString() }); await this.broadcastOp(chain, row);
    } finally { await chain.close?.(); }
  }
  /** The open SOL withdrawal of a retired strategy, if any. */
  strategyWithdrawal(launch) { return this.store().operationsFor(launch.id, 'withdraw').filter(op => op.expected?.purpose === 'strategy-withdraw' && OPEN.includes(op.state)).at(-1) || null; }
  async settleStrategyWithdrawal(chain, launch, row) {
    const store = this.store();
    await this.settleOp(chain, row, (c, r) => c.receipt(this.chainOp(r), r.wallet), ({ state, receipt }) => {
      const s = store.strategy(launch.id), amount = big(row.expected.op.inputAmount), cost = big(receipt?.actualSolCostLamports || 0), less = (value, by) => { const v = big(value || '0'); return (v > by ? v - by : 0n).toString(); };
      if (state === 'confirmed') {
        // Capital returned: cash, contributed capital and the last valuation fall by what left the wallet, so no result is reported for it.
        store.updateStrategy(launch.id, { cash: less(s.cash, amount + cost), contributed: less(s.contributed, amount), last_value: less(s.last_value, amount + cost), high_water: less(s.high_water, amount + cost), fees_spent: (big(s.fees_spent) + cost).toString() });
        store.adjust(launch.id, 'strategy', { debit: amount, cost });
        store.addEvent({ launchId: launch.id, kind: 'strategy', title: 'Retired strategy’s SOL returned', body: `${sol(amount)} SOL sent to the coin’s funding wallet ${launch.developer_wallet}. Its tokens and LP stay in the strategy wallet.`, signature: row.signature });
      } else if (state === 'failed') { store.updateStrategy(launch.id, { cash: less(s.cash, cost), fees_spent: (big(s.fees_spent) + cost).toString() }); store.adjust(launch.id, 'strategy', { cost }); }
    });
  }
  // ---- the shared Token moderation tab -------------------------------------------------------
  /** Live Pump.fun coins as rows for the admin Token moderation list (route 'pump-classic'): visibility only. */
  async adminInventory(actorId) {
    await this.requireAdmin(actorId);
    if (!this.available()) return [];
    const store = await this.ensure(), people = typeof this.accounts?.list === 'function' ? await this.accounts.list() : [], byId = new Map(people.map(a => [a.id, a]));
    const rows = store.launchesWhere({ states: ['created'] }).map(l => {
      const account = { id: l.account_id, username: String(byId.get(l.account_id)?.username || '').slice(0, 32) };
      return { account, adminRow: this.moderationRow(l, account), launch: { id: l.id, createdAt: l.live_at || l.created_at, state: l.state, input: { route: 'pump-classic', network: 'mainnet-beta', name: l.name, symbol: l.symbol, recipient: l.recipient, feeMode: l.mode, quoteMint: l.quote_mint, quoteSymbol: l.quote_symbol }, review: { quoteSymbol: l.quote_symbol, quoteDecimals: l.quote_decimals }, keys: { mint: { address: l.mint }, wallet: { address: l.launch_wallet } }, moderation: { hidden: !!l.hidden }, listArchive: { archived: false } } };
    });
    await this.requireAdmin(actorId);
    return rows;
  }
  moderationRow(l, account) {
    const hidden = !!l.hidden, unavailable = 'Pump.fun coins use Pump.fun’s native fee sharing; manage them in the Pump.fun tab. Only visibility is changed here.';
    return { route: 'pump-classic', platform: 'pump-classic', accountId: l.account_id, username: account.username, id: l.id, mint: l.mint, network: 'mainnet-beta', name: String(l.name || '').slice(0, 100), symbol: String(l.symbol || '').slice(0, 24), createdAt: l.live_at || l.created_at, state: l.state,
      hidden, manuallyArchived: false, listArchived: hidden, canArchive: false, canRestore: false, archiveReason: hidden ? 'This coin is hidden from public lists. An administrator can restore its visibility.' : 'This token was created. Live tokens can be hidden from public lists by an administrator.', archiveAt: null,
      quoteMint: l.quote_mint, quoteSymbol: l.quote_symbol, recipient: l.recipient, feeMode: l.mode, feeCustody: 'program', feeWallet: '', rewardsWallet: null,
      eligibility: { allowed: false, reason: unavailable }, rewardsAction: { kind: null, allowed: false, reason: unavailable, busy: false, autoFees: false }, rewardsAutomation: { allowed: false, enabled: false, reason: unavailable, pending: false, needed: false },
      serviceError: '', serviceStage: '', pendingOperation: null, rewardRetry: null, deferredRewards: { wallets: 0, amount: '0' }, credits: { quote: null, base: null }, rewardHistory: [], history: [] };
  }
  /** Hides or restores a live Pump.fun coin on public lists (from the Token moderation tab). Direct coin links keep working. */
  async adminVisibility(actorId, { accountId, id, mint, hidden, reason } = {}) {
    await this.requireAdmin(actorId);
    if (typeof hidden !== 'boolean' || typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 500) fail('Provide a visibility action and a reason (5–500 characters).');
    const store = await this.ensure();
    return this.locked(async () => {
      const launch = typeof id === 'string' && /^[a-f0-9]{24}$/.test(id) ? store.launch(id) : null;
      if (!launch || launch.mint !== mint || launch.account_id !== accountId || launch.state !== 'created') fail('The Pump.fun coin was not found.', 404);
      await this.requireAdmin(actorId);
      store.updateLaunch(launch.id, { hidden });
      store.addEvent({ launchId: launch.id, kind: 'admin', title: hidden ? 'Hidden by moderation' : 'Listed again', body: reason.trim(), isPublic: false });
      return { route: 'pump-classic', id: launch.id, mint: launch.mint, hidden };
    });
  }
  /** Checks the key documents of every launch that holds or held funds (however old), plus the newest 5,000 of any state. */
  async verifyKeys(actorId) {
    await this.requireAdmin(actorId); const store = await this.ensure(), rows = [];
    for (const launch of store.launchesForReview({ exceptStates: ABANDONED, recent: 5000 })) { try { await this.keys(launch); rows.push({ id: launch.id, ok: true }); } catch (error) { rows.push({ id: launch.id, ok: false, error: operatorError(error) }); } }
    return { checked: rows.length, ok: rows.every(r => r.ok), rows };
  }
  async backup(actorId) { await this.requireAdmin(actorId); await this.ensure(); return { path: this.db.backup(this.backupDirectory()), at: this.now() }; }
}
