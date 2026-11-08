import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, unpackAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { invariant } from './core.mjs';

const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
const key = row => `${row.wallet}:${row.mint}`;
const scopes = new WeakMap();

function amountIn(raw, address, owner, mint, expectedProgram) {
  if (raw === null) return 0n;
  invariant(raw && !raw.executable && Array.isArray(raw.data) && raw.data[1] === 'base64', 'RPC returned invalid position account data.');
  const program = new PublicKey(raw.owner);
  invariant(programs.some(p => p.equals(program)) && (!expectedProgram || expectedProgram.equals(program)), 'Position account has an unexpected token program.');
  const account = unpackAccount(new PublicKey(address), { ...raw, owner: program, data: Buffer.from(raw.data[0], 'base64') }, program);
  invariant(account.isInitialized && account.owner.toBase58() === owner && account.mint.toBase58() === mint, 'Position account does not match its wallet and mint.');
  // Frozen holdings still exist. Trade preparation independently rejects frozen inputs.
  return account.amount;
}

async function readBatch(provider, entries, signal) {
  const live = () => invariant(!provider.closed && !signal?.aborted, 'Stopped.');
  live();
  const rows = new Map();
  for (const entry of entries) for (const input of entry.groups) {
    const row = { ...input, wallet: new PublicKey(input.wallet).toBase58(), mint: new PublicKey(input.mint).toBase58(),
      tracked: BigInt(input.tracked), minContextSlot: input.minContextSlot ?? 0, signatures: [...(input.signatures || [])] };
    invariant(row.tracked >= 0n && Number.isSafeInteger(row.minContextSlot) && row.minContextSlot >= 0, 'Invalid tracked position balance.');
    const old = rows.get(key(row));
    if (old) {
      old.tracked = old.tracked > row.tracked ? old.tracked : row.tracked;
      old.minContextSlot = Math.max(old.minContextSlot, row.minContextSlot);
      old.signatures.push(...row.signatures);
    } else rows.set(key(row), row);
  }
  // Old releases did not persist fill slots. Recover the freshness floor from
  // their confirmed signatures before a balance can reduce retained inventory.
  const signatures = [...new Set([...rows.values()].flatMap(r => r.signatures))];
  const statuses = new Map();
  for (let i = 0; i < signatures.length; i += 256) {
    const batch = signatures.slice(i, i + 256);
    const result = await provider.rpc('getSignatureStatuses', [batch, { searchTransactionHistory: true }], signal);
    live();
    invariant(Array.isArray(result?.value) && result.value.length === batch.length, 'RPC omitted position receipt statuses; balances were not changed.');
    batch.forEach((signature, n) => statuses.set(signature, result.value[n]));
  }
  const prepared = [...rows.values()].map(row => {
    for (const signature of row.signatures) {
      const status = statuses.get(signature);
      invariant(status && status.err === null && ['confirmed', 'finalized'].includes(status.confirmationStatus) && Number.isSafeInteger(status.slot),
        'A previous position receipt is unavailable; balances were not changed.');
      row.minContextSlot = Math.max(row.minContextSlot, status.slot);
    }
    invariant(row.minContextSlot > 0, 'A confirmed position slot is required before refreshing its balance.');
    const owner = new PublicKey(row.wallet), mint = new PublicKey(row.mint);
    return { ...row, addresses: programs.map(program => getAssociatedTokenAddressSync(mint, owner, false, program).toBase58()) };
  });
  if (!prepared.length) { entries.forEach(e => e.resolve([])); return; }
  const slot = Math.max(...prepared.map(r => r.minContextSlot));
  const addresses = [...new Set(prepared.flatMap(r => r.addresses))];
  const snapshot = await provider.readAccounts(addresses, slot, signal, { commitment: 'confirmed' });
  live();
  invariant(Number.isSafeInteger(snapshot?.context?.slot) && snapshot.context.slot >= slot && Array.isArray(snapshot.value) && snapshot.value.length === addresses.length,
    'RPC returned an incomplete or stale position snapshot.');
  const values = new Map(addresses.map((address, i) => [address, snapshot.value[i]]));
  const results = new Map(prepared.map(row => [key(row), (async () => {
    const lowerBound = row.addresses.reduce((sum, address, i) => sum + amountIn(values.get(address), address, row.wallet, row.mint, programs[i]), 0n);
    if (lowerBound >= row.tracked) return { wallet: row.wallet, mint: row.mint, amount: lowerBound, slot: snapshot.context.slot, complete: false };
    // An empty/smaller ATA alone cannot prove tokens left the wallet: they may
    // have moved to another owned token account. Enumerate all owned accounts
    // only on a shortfall, keeping ordinary 20-wallet checks in one batch.
    const result = await provider.rpc('getTokenAccountsByOwner', [row.wallet, { mint: row.mint },
      { encoding: 'base64', commitment: 'confirmed', minContextSlot: snapshot.context.slot }], signal);
    live();
    invariant(Number.isSafeInteger(result?.context?.slot) && result.context.slot >= snapshot.context.slot && Array.isArray(result.value),
      'RPC returned an incomplete or stale wallet token snapshot.');
    let amount = 0n; const seen = new Set();
    for (const item of result.value) {
      const address = new PublicKey(item.pubkey).toBase58();
      invariant(!seen.has(address) && item.account !== null, 'RPC returned duplicate or missing wallet token accounts.');
      seen.add(address); amount += amountIn(item.account, address, row.wallet, row.mint);
    }
    return { wallet: row.wallet, mint: row.mint, amount, slot: result.context.slot, complete: true };
  })()]));
  // Attach all handlers immediately: one wallet's malformed response must not
  // create an unhandled rejection or prevent independent callers from finishing.
  const settled = await Promise.allSettled(entries.map(entry => Promise.all(entry.groups.map(row => results.get(key(row))))));
  // Release the cohort together even when shortfall checks span several RPC
  // budget windows. Otherwise 20 callers fragment their fee/route reads again.
  settled.forEach((result, i) => result.status === 'fulfilled' ? entries[i].resolve(result.value) : entries[i].reject(result.reason));
}

export function trackedBalances(provider, groups, signal) {
  return new Promise((resolve, reject) => {
    invariant(Array.isArray(groups), 'Invalid position refresh request.');
    let batches = scopes.get(provider);
    if (!batches) { batches = new Map(); scopes.set(provider, batches); }
    let batch = batches.get(signal);
    if (!batch) {
      batch = []; batches.set(signal, batch);
      queueMicrotask(() => {
        batches.delete(signal); if (!batches.size) scopes.delete(provider);
        readBatch(provider, batch, signal).catch(error => batch.forEach(entry => entry.reject(error)));
      });
    }
    batch.push({ groups, resolve, reject });
  });
}
