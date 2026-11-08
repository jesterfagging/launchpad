// Shared, RPC-backed checks for wallet-modified transactions (Phantom/Solflare).
// The pure message validator lives in launchpad-wallet-guards.mjs; this module
// performs the chain proofs required before a platform key co-signs a changed
// message: the Lighthouse executable must be the immutable, hash-pinned build,
// and the complete co-signed packet must pass a signature-verifying simulation.
import { createHash } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { validateWalletMessage } from './launchpad-wallet-guards.mjs';

export const WALLET_GUARD_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
export const WALLET_GUARD_DATA = 'CJ5WEjifs4d77pEA9DpewppByFjHcAkNv3YYSuSoDk7c';
export const WALLET_GUARD_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const WALLET_GUARD_HASH = '94aee62cffe609a6a676b0b71281c49f1aa7ed3f388bae7dcb88d3b8ca412f9a';

const verified = new WeakSet();
const unavailable = message => Object.assign(Error(message), { statusCode: 503, code: 'WALLET_GUARD_RPC' });

/** Same immutable-program proof used by the Raydium launch path. */
export async function verifyWalletGuardProgram(connection) {
  if (verified.has(connection)) return;
  let snapshot;
  try { snapshot = await connection.getMultipleAccountsInfoAndContext([new PublicKey(WALLET_GUARD_PROGRAM), new PublicKey(WALLET_GUARD_DATA)], { commitment: 'finalized' }); }
  catch (error) { throw Object.assign(unavailable('The wallet safety program could not be verified. Nothing was submitted. Try again shortly.'), { cause: error }); }
  const [program, data] = snapshot?.value || [], failure = 'The wallet safety program could not be verified. Nothing was submitted. Try again shortly.';
  const loader = new PublicKey(WALLET_GUARD_LOADER);
  const programOk = Number.isSafeInteger(snapshot?.context?.slot) && snapshot.context.slot >= 294179293 && program?.owner?.equals(loader) && program.executable === true && program.data?.length === 36 && program.data.readUInt32LE(0) === 2 && new PublicKey(program.data.subarray(4)).toBase58() === WALLET_GUARD_DATA;
  const dataOk = data?.owner?.equals(loader) && data.executable === false && data.data?.length === 424293 && data.data.readUInt32LE(0) === 3 && data.data[12] === 0 && createHash('sha256').update(data.data).digest('hex') === WALLET_GUARD_HASH;
  if (!programOk || !dataOk) throw unavailable(failure);
  verified.add(connection);
}

/** Simulate the complete, co-signed packet before it is journaled or sent. */
export async function simulateWalletChangedTransaction(connection, tx, { commitment = 'confirmed', minContextSlot } = {}) {
  let result;
  try { result = await connection.simulateTransaction(tx, { sigVerify: true, commitment, ...(Number.isSafeInteger(minContextSlot) && minContextSlot >= 0 ? { minContextSlot } : {}) }); }
  catch (error) { throw Object.assign(unavailable('The wallet safety check could not reach Solana. Keep this step open and retry.'), { cause: error }); }
  if (result?.value?.err) throw Object.assign(Error(`The approved transaction could not pass its wallet safety checks (${JSON.stringify(result.value.err).slice(0, 120)}). Nothing was submitted. Approve this step again.`), { statusCode: 400, code: 'WALLET_TRANSACTION_REJECTED' });
  if (!result?.value || result.value.err !== null) throw unavailable('The RPC omitted wallet safety simulation results. Keep this step open and retry.');
  return result;
}

/**
 * Describe how a wallet-returned packet differs from its saved review for the
 * static-account (no lookup table) Meteora and Pump paths. Throws the shared
 * WALLET_TRANSACTION_REJECTED error for anything beyond the bounded wallet
 * compute budget and Lighthouse assertion suffix.
 */
export function staticWalletChange(tx, unsignedBase64) {
  const prepared = VersionedTransaction.deserialize(Buffer.from(unsignedBase64, 'base64'));
  if (Buffer.from(tx.message.serialize()).equals(Buffer.from(prepared.message.serialize()))) return { changed: false, guardCount: 0 };
  if (tx.version !== 0 || prepared.version !== 0 || tx.message.addressTableLookups.length || prepared.message.addressTableLookups.length)
    throw Object.assign(Error('Wallet transaction validation failed (address lookups changed). This step was not submitted.'), { code: 'WALLET_TRANSACTION_REJECTED', walletValidationReason: 'address lookups changed' });
  return validateWalletMessage(prepared.message, tx.message, { allowComputeBudget: true });
}
