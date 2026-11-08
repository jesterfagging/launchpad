/** Confirmed pool notifications are scheduling hints, never authority to spend. */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';

const str = value => value?.toBase58?.() ?? String(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const eligible = launch => launch?.confirmationStatus === 'finalized'
  && ['trading', 'bonded'].includes(launch.status)
  && launch.quoteMint === str(NATIVE_MINT) && launch.quoteDecimals === 9;

export function createDammPumpGraduationWatcher({ adapter, onHint, maxInputRaw = '250000000' }) {
  const connection = adapter?.connection;
  const supported = typeof connection?.onAccountChange === 'function'
    && typeof connection?.removeAccountChangeListener === 'function'
    && typeof adapter.rawState === 'function' && typeof onHint === 'function';
  const cap = /^(0|[1-9]\d*)$/.test(String(maxInputRaw)) ? BigInt(maxInputRaw) : 0n;
  const active = new Map();
  let desired = new Map(), version = 0, appliedVersion = -1, running = null, closed = false;

  async function remove(entry) {
    entry.stopped = true;
    active.delete(entry.mint);
    if (entry.id !== undefined) try { await connection.removeAccountChangeListener(entry.id); } catch {}
  }

  function observe(entry, account, context) {
    if (closed || entry.stopped || active.get(entry.mint) !== entry) return;
    try {
      const slot = context?.slot;
      if (!Number.isSafeInteger(slot) || slot < entry.finalizedSlot || slot < entry.lastSlot
        || account?.executable || !new PublicKey(account?.owner).equals(CP_AMM_PROGRAM_ID)
        || !Buffer.isBuffer(account.data)) return;
      // Multiple changes in one slot matter; reject exact duplicates, not the slot.
      const hash = digest(account.data);
      if (slot === entry.lastSlot && hash === entry.lastHash) return;
      const pool = adapter.cp._program.coder.accounts.decode('pool', account.data);
      adapter.verifyPool(entry.launch, entry.state, pool);
      entry.lastSlot = slot; entry.lastHash = hash;
      const endpoint = BigInt(str(pool.sqrtPrice)) === BigInt(entry.state.sqrtMaxPrice);
      let near = false;
      if (!endpoint && typeof adapter.graduationFinishPlan === 'function') {
        const plan = adapter.graduationFinishPlan(entry.launch, {
          state: entry.state, addresses: entry.addresses, pool, slot,
        });
        near = !!plan && plan.quoteMint === str(NATIVE_MINT) && plan.quoteDecimals === 9
          && /^(0|[1-9]\d*)$/.test(plan.amountRaw)
          && BigInt(plan.amountRaw) > 0n && BigInt(plan.amountRaw) <= cap;
      }
      if (!endpoint && !near) return;
      entry.hintSlot = slot;
      if (entry.queued) return;
      entry.queued = true;
      queueMicrotask(() => {
        entry.queued = false;
        if (closed || entry.stopped || active.get(entry.mint) !== entry) return;
        // The service rereads the current state, wallet budget and simulation.
        try { Promise.resolve(onHint({ mint: entry.mint, slot: entry.hintSlot })).catch(() => {}); } catch {}
      });
    } catch { /* Invalid or unsupported notifications fall back to normal polling. */ }
  }

  async function drain() {
    let seen;
    do {
      seen = version;
      for (const entry of active.values()) if (desired.get(entry.mint)?.fingerprint !== entry.fingerprint) await remove(entry);
      for (const [mint, row] of desired) {
        if (closed) return;
        if (active.has(mint)) continue;
        try {
          const snapshot = await adapter.rawState(row.config, row.launch, 'finalized');
          if (closed || desired.get(mint)?.fingerprint !== row.fingerprint) continue;
          const addresses = adapter.launchAddresses(row.config, row.launch);
          if (snapshot.state?.phase !== 0 || !Number.isSafeInteger(snapshot.slot)
            || snapshot.slot < 0 || snapshot.state.mint !== mint
            || snapshot.state.quoteMint !== str(NATIVE_MINT)
            || snapshot.state.dammPool !== str(addresses.dammPool)
            || str(snapshot.addresses?.dammPool) !== str(addresses.dammPool)) continue;
          const entry = { ...row, mint, addresses, state: snapshot.state, finalizedSlot: snapshot.slot,
            lastSlot: snapshot.slot, lastHash: null, stopped: false, queued: false };
          active.set(mint, entry);
          try {
            entry.id = connection.onAccountChange(addresses.dammPool,
              (account, context) => observe(entry, account, context), 'confirmed');
            if (!Number.isSafeInteger(entry.id) || entry.id < 0) throw Error('Subscription unavailable');
          } catch { await remove(entry); }
        } catch { /* A failed optional subscription never blocks launch or polling. */ }
      }
      appliedVersion = seen;
    } while (!closed && seen !== version);
  }

  function begin() {
    if (!running) running = drain().catch(() => { appliedVersion = version; }).finally(() => {
      running = null;
      if (!closed && appliedVersion !== version) begin();
    });
    return running;
  }

  return {
    sync(rows = []) {
      if (closed || !supported || cap <= 0n || cap > 250000000n) return Promise.resolve();
      const next = new Map();
      for (const row of rows) if (eligible(row?.launch) && row.config?.programId === row.launch.publicProgramId) {
        try {
          const launch = structuredClone(row.launch), config = structuredClone(row.config);
          const fingerprint = digest(JSON.stringify([config, launch.mint, launch.quoteMint,
            launch.quoteDecimals, launch.quoteTokenProgram, launch.dammPoolId, launch.priceSnapshot?.quoteUsdMicros]));
          next.set(launch.mint, { launch, config, fingerprint });
        } catch {}
      }
      desired = next; version++;
      return begin();
    },
    async close() {
      closed = true; desired.clear(); version++;
      await Promise.allSettled([...active.values()].map(remove));
    },
  };
}

export const createGraduationWatcher = createDammPumpGraduationWatcher;
