// A launchpad's treasury (LAUNCHPAD_PRODUCT=tenant): the engine's protocol-treasury machinery (one managed wallet, verified
// revenue receipts, simulated and journaled transactions, gas-day limits) running the launchpad policy. Every verified
// protocol receipt is converted to SOL when it is not SOL already; of the SOL, the platform share (for example 10% by
// default, LAUNCHPAD_PLATFORM_SHARE_BPS) accrues to the platform and is paid to LAUNCHPAD_PLATFORM_SHARE_WALLET automatically
// once it reaches the minimum; the rest is the launchpad owner's, withdrawable from Admin → Revenue → Treasury.
//
// The wallet is made by the server on first start and is the launchpad's protocol fee recipient from the first launch
// (src/tenant/bootstrap.mjs). Automatic work runs as the system, not as an administrator; withdrawals still need an
// administrator with two-factor authentication. The owner cannot switch the treasury off or point protocol revenue
// elsewhere: the platform share is part of the launchpad's terms.
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { ProtocolTreasury, TREASURY_POLICY, treasuryInternals } from '../protocol-treasury.mjs';
import { SOL_MINT } from '../../public/launchpad-model.mjs';

const { uint, add, retry, safeError, publicFailure } = treasuryInternals;
/** The actor automatic treasury work runs as. Not an account id (those are 32 hex characters), so it can never sign in. */
export const TENANT_SYSTEM_ACTOR = 'tenant-system';
const SYSTEM = Object.freeze({ id: TENANT_SYSTEM_ACTOR, username: 'system', role: 'admin', mfaEnabled: true, banned: false });
/** Network limits as the engine's, without its buyback leg. */
export const TENANT_TREASURY_POLICY = Object.freeze({ ...TREASURY_POLICY, buybackBps: 0 });
const MANAGED = 'The treasury on this launchpad is managed by the platform: it is always on and receives every protocol fee.';
const refuse = message => { throw Object.assign(new Error(message), { statusCode: 403 }); };

export const emptyPlatformLedger = () => ({ version: 1, basisSol: '0', accrued: '0', paid: '0', payouts: [], retry: null });
/** The platform's share of all SOL revenue so far: floor(basis × bps / 10000), so rounding never drifts across receipts. */
export function platformAccrual(basisSol, bps) { return uint(String(basisSol)) * BigInt(bps) / 10000n; }
/** SOL owed to the platform and not yet paid or being paid. */
export function platformOwed(ledger, pending = null) {
  const inFlight = pending?.tag?.step === 'platform' ? uint(pending.inputAmount) : 0n, owed = uint(ledger.accrued) - uint(ledger.paid) - inFlight;
  return owed > 0n ? owed : 0n;
}

export class TenantTreasury extends ProtocolTreasury {
  /** @param share platformShare() from src/tenant/config.mjs: { wallet, bps, minimumLamports } (null = no platform share). */
  constructor({ share = null, ...options } = {}) {
    super({ ...options, policy: TENANT_TREASURY_POLICY });
    this.share = share;
  }
  ledger(state) { if (!state.platform) state.platform = emptyPlatformLedger(); return state.platform; }
  async load() {
    const state = await super.load();
    if (state.platform) { try { for (const key of ['basisSol', 'accrued', 'paid']) uint(state.platform[key]); if (!Array.isArray(state.platform.payouts)) throw Error(); } catch { throw Object.assign(Error('The platform share ledger could not be read. Restore its original data before continuing.'), { statusCode: 503 }); } }
    return state;
  }
  async requireAdmin(id) { if (id === TENANT_SYSTEM_ACTOR) return SYSTEM; return super.requireAdmin(id); }
  /**
   * First start: a new server-made wallet, switched on as the system, with no history. Returns the wallet address.
   * Idempotent: an existing wallet is kept (its address is returned), whatever its origin.
   */
  async ensureWallet() {
    return this.locked(async () => {
      const state = await this.load();
      if (state.wallet) { if (!state.enabled || state.operatorId !== TENANT_SYSTEM_ACTOR) { state.enabled = true; state.operatorId = TENANT_SYSTEM_ACTOR; await this.save(state); } return state.wallet.address; }
      const key = Keypair.generate(), at = this.now();
      try { state.wallet = { address: key.publicKey.toBase58(), secret: bs58.encode(key.secretKey), origin: 'server-generated', createdAt: at }; } finally { key.secretKey.fill(0); }
      state.enabled = true; state.operatorId = TENANT_SYSTEM_ACTOR; state.configurationHistory.push({ action: 'tenant-wallet', actorId: TENANT_SYSTEM_ACTOR, address: state.wallet.address, enabled: true, at }); state.error = '';
      this.ledger(state); await this.save(state); return state.wallet.address;
    }, { fee: true });
  }
  // The owner cannot install another signer, switch the treasury off or recognise outside transfers on a launchpad.
  async installSigner() { refuse(MANAGED); }
  async configure() { refuse(MANAGED); }
  async recognizeRevenue() { refuse(MANAGED); }
  /** SOL revenue: the platform's share accrues to the platform, the rest is the owner's retained revenue. */
  allocateSol(state, amount, { converted = false } = {}) {
    const n = uint(String(amount)), ledger = this.ledger(state);
    add(state.totals, 'receivedSol', n); if (converted) add(state.totals, 'convertedSol', n);
    add(ledger, 'basisSol', n);
    const accrued = this.share ? platformAccrual(ledger.basisSol, this.share.bps) : 0n, share = accrued - uint(ledger.accrued);
    if (share > 0n) add(ledger, 'accrued', share);
    add(state.totals, 'retainedSol', n - (share > 0n ? share : 0n));
  }
  /** What the wallet must keep while an operation runs: an owner withdrawal leaves the platform's unpaid share behind. */
  solObligation(state, kind, amount, extra = {}) {
    if (extra.tag?.step === 'platform') return 0n;
    return kind === 'withdraw' ? platformOwed(this.ledger(state), state.pending) : 0n;
  }
  /** Retained SOL the owner may withdraw: the engine's figure, which already excludes the platform's share. */
  availableRetained(state) { return super.availableRetained(state); }
  settle(state, op, receipt, { input }) {
    if (op.tag?.step !== 'platform') return false;
    const ledger = this.ledger(state);
    if (receipt.state === 'confirmed') { add(ledger, 'paid', input); ledger.payouts = [...ledger.payouts, { signature: op.signature, amount: input.toString(), recipient: op.recipient, at: this.now() }].slice(-200); ledger.retry = null; }
    else retry(ledger.retry ||= {}, this.now(), 'The previous platform payout did not complete. It will be prepared again.');
    return true;
  }
  /** One tick: the platform payout when it is due, else the next foreign asset to convert to SOL. */
  async work(state, chain) {
    const ledger = this.ledger(state), owed = platformOwed(ledger, state.pending);
    if (this.share && owed >= BigInt(this.share.minimumLamports) && (ledger.retry?.nextAttemptAt || 0) <= this.now()) {
      try { await this.prepare(state, chain, 'withdraw', SOL_MINT, owed.toString(), { recipient: this.share.wallet, tag: { product: 'tenant', step: 'platform' } }); return; }
      catch (error) {
        if (error.treasuryStorageFailure) throw error;
        if (state.pending) { state.error = safeError(error); await this.save(state); return; }
        retry(ledger.retry ||= {}, this.now(), safeError(error)); state.error = safeError(error); await this.save(state);
      }
    }
    await this.convertAssets(state, chain);
  }
  async view(state) {
    const view = await super.view(state), ledger = this.ledger(state);
    view.managed = true;
    view.platform = this.share ? { wallet: this.share.wallet, bps: this.share.bps, minimumLamports: this.share.minimumLamports, accrued: ledger.accrued, paid: ledger.paid, owed: platformOwed(ledger, state.pending).toString(), payouts: ledger.payouts.slice(-20), retry: ledger.retry ? { reason: ledger.retry.error || '', nextAttemptAt: ledger.retry.nextAttemptAt || null } : null } : null;
    return view;
  }
  /** Totals for a hosting platform's status view (no addresses beyond the platform wallet, no secrets). */
  async platformSummary() {
    let state = null; try { state = await this.load(); } catch { state = null; }
    const ledger = state ? this.ledger(state) : emptyPlatformLedger();
    return { configured: !!state?.wallet, address: state?.wallet?.address || '', receivedSol: state?.totals?.receivedSol || '0', retainedSol: state?.totals?.retainedSol || '0', withdrawnSol: state?.totals?.withdrawnSol || '0', platform: { accrued: ledger.accrued, paid: ledger.paid, owed: platformOwed(ledger, state?.pending).toString(), bps: this.share?.bps || 0 }, error: state?.error || '', updatedAt: state?.updatedAt || null };
  }
}
export { publicFailure };
