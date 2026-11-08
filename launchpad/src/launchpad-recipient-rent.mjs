import { PublicKey } from '@solana/web3.js';
import { requireValue as ok } from '../public/launchpad-model.mjs';

const MAX_UNITS = 18446744073709551615n;
const invalidSnapshot = () => Object.assign(new Error('The RPC returned an incomplete holder recipient balance snapshot. No payout was prepared.'), { code: 'REWARD_RECIPIENT_SNAPSHOT' });

export function recipientRentError(payouts) {
  return Object.assign(new Error('A holder recipient cannot yet accept its exact SOL reward without falling below the minimum account balance.'), {
    code: 'REWARD_RECIPIENT_RENT',
    payouts: payouts.map(({ owner, amount }) => ({ owner, amount })),
  });
}

// A tiny SOL transfer cannot create an account below rent exemption, even
// when the sender has ample gas. Keep the exact unpaid allocation instead of
// subsidizing the recipient or letting one empty wallet block other holders.
export async function inspectNativeRewardRecipients(connection, payouts, payer) {
  ok(Array.isArray(payouts) && payouts.length > 0 && payouts.length <= 100, 'Invalid holder payout batch.');
  const seen = new Set(), rows = [];
  for (const row of payouts) {
    const key = new PublicKey(row?.owner), owner = key.toBase58();
    ok(owner === row.owner && PublicKey.isOnCurve(key.toBytes()), 'Invalid fee recipient.');
    ok(typeof row.amount === 'string' && /^[1-9]\d*$/.test(row.amount) && BigInt(row.amount) <= MAX_UNITS, 'Invalid holder payout amount.');
    ok(!seen.has(owner), 'Duplicate holder payout recipient.');
    seen.add(owner);
    if (owner !== payer) rows.push({ owner, amount: row.amount, key });
  }
  if (!rows.length) return null;
  const snapshot = await connection.getMultipleAccountsInfoAndContext(rows.map(row => row.key), { commitment: 'finalized' });
  if (!Number.isSafeInteger(snapshot?.context?.slot) || snapshot.context.slot <= 0 || !Array.isArray(snapshot.value) || snapshot.value.length !== rows.length) throw invalidSnapshot();
  const checked = rows.map((row, index) => {
    const account = snapshot.value[index];
    // Only null is a proven absent account; undefined/malformed data must not
    // move anyone's reward into the deferred ledger.
    if (account !== null && (!account || !Number.isSafeInteger(account.lamports) || account.lamports < 0 || !Buffer.isBuffer(account.data) || account.data.length > 10485760 || !(account.owner instanceof PublicKey) || typeof account.executable !== 'boolean')) throw invalidSnapshot();
    return { ...row, balance: account === null ? 0n : BigInt(account.lamports), size: account === null ? 0 : account.data.length };
  });
  const rents = new Map();
  for (const size of new Set(checked.map(row => row.size))) {
    const value = await connection.getMinimumBalanceForRentExemption(size, 'finalized');
    if (!Number.isSafeInteger(value) || value < 0) throw invalidSnapshot();
    rents.set(size, BigInt(value));
  }
  const blocked = checked.filter(row => row.balance + BigInt(row.amount) < rents.get(row.size));
  if (blocked.length) throw recipientRentError(blocked);
  return Object.freeze({ slot: snapshot.context.slot, payouts: Object.freeze(rows.map(({ owner, amount }) => Object.freeze({ owner, amount }))) });
}

export function recipientRentSimulationError(transaction, result, check) {
  const index = result?.err?.InsufficientFundsForRent?.account_index;
  if (!check || !Number.isSafeInteger(index) || index <= 0) return null;
  // Payouts fit v0 without lookup tables. If another format does not expose a
  // static key at this index, retain the original error instead of guessing.
  const account = transaction?.message?.staticAccountKeys?.[index]?.toBase58?.();
  const row = account && check.payouts.find(payout => payout.owner === account);
  return row ? recipientRentError([row]) : null;
}
