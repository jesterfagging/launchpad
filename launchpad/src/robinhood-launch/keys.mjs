// Robinhood launch venue: the per-coin and per-host EVM wallets, fresh randomness stored encrypted in the host store
// exactly like the Pump.fun Classic keys (never derived, never exported, verified against the launch row before use).
// Per coin: the launch wallet (funded by the creator, signs the launch, refunds the rest) and, for every option but
// Creator, the fee wallet (the coin's creator fee recipient on chain: claims from the escrow and pays the option).
// Per host: the factory owner key (approves pairs, sets fees, forces graduations; it can never move a launch's funds)
// and the platform wallet (the platform recipient on chain; its claims go to the treasury).
import { randomPrivateKey, privateKeyToAddress } from '../evm/secp256k1.mjs';

export const LAUNCH_KEY_PREFIX = 'robinhood-launch-keys-';
export const HOST_KEYS_NAME = 'robinhood-launch-host';
const fail = (message, statusCode = 503, code = 'ROBINHOOD_LAUNCH_KEYS') => { throw Object.assign(Error(message), { code, statusCode }); };

export function generateEvmWallet() {
  const secret = randomPrivateKey();
  return { address: privateKeyToAddress(secret), secret };
}
export const walletMatches = wallet => !!wallet?.secret && !!wallet?.address && privateKeyToAddress(wallet.secret) === wallet.address;

/** Creates (once) the wallets a launch needs and stores them before anything is funded. */
export async function provisionLaunchKeys(hostStore, launchId, mode, { now = Date.now } = {}) {
  const name = LAUNCH_KEY_PREFIX + launchId;
  const existing = await hostStore.read(name, null);
  if (existing) return existing;
  const doc = { version: 1, chain: 'robinhood', launchId, mode, launch: generateEvmWallet(), fee: mode === 'creator' ? null : generateEvmWallet(), createdAt: now() };
  await hostStore.write(name, doc);
  const saved = await hostStore.read(name, null);
  if (!saved || saved.launch?.address !== doc.launch.address || (saved.fee?.address || null) !== (doc.fee?.address || null)) fail('The launch keys could not be stored. Nothing was funded.');
  return doc;
}

/** The keys of a launch, checked against its row: a mismatch fails closed. */
export async function launchKeys(hostStore, launch) {
  const doc = await hostStore.read(LAUNCH_KEY_PREFIX + launch.id, null);
  if (!doc || doc.launch?.address !== launch.launch_wallet || (doc.fee?.address || null) !== (launch.fee_wallet || null)) fail('The launch keys do not match this launch. Restore the original encrypted data.');
  for (const key of [doc.launch, ...(doc.fee ? [doc.fee] : [])]) if (!walletMatches(key)) fail('A launch key does not match its address. Restore the original encrypted data.');
  return { launch: doc.launch, fee: doc.fee };
}

/** The host's owner and platform wallets, created on first use. */
export async function hostKeys(hostStore, { now = Date.now } = {}) {
  let doc = await hostStore.read(HOST_KEYS_NAME, null);
  if (!doc) {
    doc = { version: 1, chain: 'robinhood', owner: generateEvmWallet(), platform: generateEvmWallet(), createdAt: now() };
    await hostStore.write(HOST_KEYS_NAME, doc);
    const saved = await hostStore.read(HOST_KEYS_NAME, null);
    if (saved?.owner?.address !== doc.owner.address || saved?.platform?.address !== doc.platform.address) fail('The host keys could not be stored.');
  }
  for (const key of [doc.owner, doc.platform]) if (!walletMatches(key)) fail('A host key does not match its address. Restore the original encrypted data.');
  return { owner: doc.owner, platform: doc.platform };
}
