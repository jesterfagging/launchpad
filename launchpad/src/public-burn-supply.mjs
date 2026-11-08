import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, unpackMint } from '@solana/spl-token';
import { PLATFORM_TOKEN_MINT } from './platform-token.mjs';

// This display-only reader is deliberately restricted to the platform token (LAUNCHPAD_TOKEN_MINT): a launch with a
// fixed 1,000,000,000 issuance, 6 decimals and its mint authority revoked. These are its issued supply and decimals,
// not a circulating-supply estimate, and must not be inferred from a token index or a receipt journal. Without a
// platform token it never reads the chain.
export const PUBLIC_BURN_MINT = PLATFORM_TOKEN_MINT;
export const PUBLIC_BURN_DECIMALS = 6;
export const PUBLIC_BURN_ORIGINAL_SUPPLY = '1000000000000000';
const ORIGINAL = BigInt(PUBLIC_BURN_ORIGINAL_SUPPLY), REFRESH = 30_000, STALE = 60_000, TIMEOUT = 2_500;
const ensure = value => { if (!value) throw Error('Finalized LAUNCHPAD mint supply could not be verified.'); };
const base = Object.freeze({ mint: PUBLIC_BURN_MINT, decimals: PUBLIC_BURN_DECIMALS,
  originalSupply: PUBLIC_BURN_ORIGINAL_SUPPLY, currentSupply: null, totalBurned: null,
  burnedPercent: null, slot: null, at: null, source: 'finalized-mint-supply', commitment: 'finalized' });

function verifiedSupply(result, previous, at) {
  ensure(Number.isSafeInteger(result?.context?.slot) && result.context.slot > 0);
  ensure(!previous || result.context.slot >= previous.slot);
  const info = result.value;
  ensure(info && info.executable === false && Buffer.isBuffer(info.data));
  const mint = unpackMint(new PublicKey(PUBLIC_BURN_MINT), info, TOKEN_2022_PROGRAM_ID);
  // With mint authority revoked, supply cannot be replenished. The difference
  // from the fixed original issuance is therefore actual burned supply.
  ensure(mint.isInitialized && mint.decimals === PUBLIC_BURN_DECIMALS && mint.mintAuthority === null);
  ensure(typeof mint.supply === 'bigint' && mint.supply >= 0n && mint.supply <= ORIGINAL);
  ensure(!previous || mint.supply <= BigInt(previous.currentSupply));
  ensure(!previous || result.context.slot !== previous.slot || mint.supply === BigInt(previous.currentSupply));
  const burned = ORIGINAL - mint.supply, hundredths = (burned * 10_000n + ORIGINAL / 2n) / ORIGINAL;
  return Object.freeze({ ...base, currentSupply: mint.supply.toString(), totalBurned: burned.toString(),
    burnedPercent: `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`,
    slot: result.context.slot, at });
}

// One instance is shared by the application. Public requests only read its
// cached snapshot; they cannot create additional RPC work. A failed refresh
// keeps the last verified supply explicitly stale and never falls back to
// incomplete burn receipts or changes protocol-funded attribution.
export class PublicBurnSupply {
  #connection; #connectionFactory; #now; #setTimer; #clearTimer;
  #snapshot = null; #failed = false; #pending = null; #rpcBusy = null;
  #nextAttempt = 0; #started = false; #closed = false; #timer = null; #deadline = null;

  constructor({ connection, connectionFactory, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.#connection = connection; this.#connectionFactory = connectionFactory;
    this.#now = now; this.#setTimer = setTimer; this.#clearTimer = clearTimer;
  }

  readPublic() {
    const status = !this.#snapshot ? 'unavailable' : this.#failed || this.#now() - this.#snapshot.at >= STALE ? 'stale' : 'available';
    return Object.freeze({ ...(this.#snapshot || base), status });
  }

  tick() {
    if (this.#closed || !PUBLIC_BURN_MINT) return Promise.resolve(this.readPublic());
    if (this.#pending) return this.#pending;
    if (this.#rpcBusy || this.#now() < this.#nextAttempt) return Promise.resolve(this.readPublic());
    this.#nextAttempt = this.#now() + REFRESH;
    const attempt = {}; this.#rpcBusy = attempt;
    const read = async () => {
      let resource;
      try {
        resource = this.#connectionFactory ? await this.#connectionFactory() : this.#connection;
        ensure(!attempt.expired && !this.#closed);
        const connection = resource?.connection || resource;
        ensure(typeof connection?.getAccountInfoAndContext === 'function');
        const config = { commitment: 'finalized', ...(this.#snapshot ? { minContextSlot: this.#snapshot.slot } : {}) };
        const result = await connection.getAccountInfoAndContext(new PublicKey(PUBLIC_BURN_MINT), config);
        return verifiedSupply(result, this.#snapshot, this.#now());
      } finally {
        // Do not reuse a timed-out transport concurrently. If an RPC ignores
        // its deadline, keep at most that one outstanding request until it
        // settles; any late result is discarded by the timeout race below.
        try { if (resource?.connection) await resource.close?.(); } catch { /* read-only cleanup */ }
        if (this.#rpcBusy === attempt) this.#rpcBusy = null;
      }
    };
    const deadline = new Promise((_, reject) => { this.#deadline = this.#setTimer(() => { attempt.expired = true; reject(Error('Finalized LAUNCHPAD mint read timed out.')); }, TIMEOUT); });
    this.#pending = Promise.race([read(), deadline]).then(snapshot => {
      if (!this.#closed) { this.#snapshot = snapshot; this.#failed = false; }
    }, () => { if (!this.#closed) this.#failed = true; }).finally(() => {
      this.#clearTimer(this.#deadline); this.#deadline = null; this.#pending = null;
    }).then(() => this.readPublic());
    return this.#pending;
  }

  start() {
    if (this.#started || this.#closed) return;
    this.#started = true;
    const run = async () => {
      await this.tick();
      if (!this.#closed) { this.#timer = this.#setTimer(run, REFRESH); this.#timer?.unref?.(); }
    };
    void run();
  }

  close() {
    this.#closed = true;
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    // Retain the finite RPC deadline so pending callers always settle. The
    // closed flag prevents both scheduled refreshes and late publication.
  }
}
