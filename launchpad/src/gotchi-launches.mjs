// Gotchi helpers over Raydium launch records. A Gotchi launch is a taxed
// holder-rewards launch whose reward recipient is the Gotchi vault instead of
// the holder set: the existing tax harvest, paced conversion and protocol-share
// machinery are reused unchanged and only the final payout target differs.
import { isCurrentLaunch, SOL_MINT } from '../public/launchpad-model.mjs';
import { rewardsWalletSelection, rewardsWalletKey } from './launchpad-rewards-wallet.mjs';
import { referenceRewardMinimum } from './launchpad-holder-rewards.mjs';
import { GOTCHI_RAYDIUM_TAX_BPS, validGotchiId } from '../public/gotchi-catalog.mjs';

const base58 = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const signature = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value);
const digits = value => typeof value === 'string' && /^\d+$/.test(value);
export const GOTCHI_PAYOUT_FLOOR_CENTS = 100n;

export function validGotchiAttachment(value) {
  return !!value && value.version === 1 && validGotchiId(value.id) && typeof value.theme === 'string' && base58(value.vault);
}
// The association is read from the immutable launch input only. A launch with
// a malformed attachment is not a Gotchi launch and never pays a vault.
export function gotchiLaunch(l) {
  const input = l?.input;
  return !!input && input.feeMode === 'holders' && validGotchiAttachment(input.gotchi) && Number(input.taxBps) === GOTCHI_RAYDIUM_TAX_BPS;
}
export function gotchiVault(l) { return gotchiLaunch(l) ? l.input.gotchi.vault : null; }
// $1 floor in quote units, like creator payouts; the vault batches hourly.
export function gotchiPayoutMinimum(l) { return referenceRewardMinimum(l.review, GOTCHI_PAYOUT_FLOOR_CENTS); }
export function gotchiPayoutRows(l, amount) { const vault = gotchiVault(l); return vault && BigInt(amount) > 0n ? [{ owner: vault, amount: String(amount) }] : []; }

function confirmedCreation(l) {
  return (l.operations || []).find(op => ['create', 'launch-all'].includes(op.kind) && op.state === 'confirmed');
}
export function raydiumGotchiLaunch(l, { accountId = null } = {}) {
  if (!gotchiLaunch(l) || !isCurrentLaunch(l.input) || l.state === 'draft') return null;
  const creation = confirmedCreation(l);
  if (!creation && !base58(l.curve)) return null;
  const mint = l.keys?.mint?.address;
  if (!base58(mint)) return null;
  let contributed = 0n, pendingQuote = 0n, base = 0n;
  for (const op of l.operations || []) {
    if (op.kind !== 'payout' || op.state !== 'confirmed' || !Array.isArray(op.payouts)) continue;
    for (const row of op.payouts) if (row.owner === l.input.gotchi.vault && digits(row.amount)) contributed += BigInt(row.amount);
  }
  if (digits(l.credits?.quote)) pendingQuote = BigInt(l.credits.quote);
  if (digits(l.credits?.base)) base = BigInt(l.credits.base);
  const custody = [l.keys?.wallet?.address, l.keys?.rewards?.address, l.keys?.platform?.address, l.keys?.payer?.address, l.keys?.protocol?.address, l.curve].filter(base58);
  return { venue: 'raydium', mint, name: String(l.input.name || '').slice(0, 100), symbol: String(l.input.symbol || '').slice(0, 24), image: /^[a-f0-9]{64}\.(png|jpg|webp)$/.test(l.input.imageId || '') ? '/token-images/' + l.input.imageId : null,
    gotchi: { id: l.input.gotchi.id, theme: l.input.gotchi.theme, vault: l.input.gotchi.vault, attachedAt: l.input.gotchi.attachedAt || l.createdAt },
    status: l.state, live: !!l.curve && ['live', 'paused', 'error'].includes(l.state), createdAt: creation?.confirmedAt || l.authorizedAt || l.createdAt, authorizedAt: l.authorizedAt || null,
    quoteMint: l.input.quoteMint, quoteDecimals: l.review?.quoteDecimals ?? 9, quoteSymbol: l.review?.quoteSymbol || (l.input.quoteMint === SOL_MINT ? 'SOL' : ''), baseDecimals: 6, custody, hidden: l.moderation?.hidden === true, archived: !!l.listArchive?.archived,
    contributedRaw: contributed.toString(), pendingRaw: pendingQuote.toString(), unconvertedBaseRaw: base.toString(), accountId, launchId: l.id };
}
// Finalized payouts to the vault. The sender is the key that signed the payout,
// recovered from the operation's saved rewards-wallet role; nothing is guessed.
export function raydiumGotchiSources(l) {
  if (!gotchiLaunch(l) || !isCurrentLaunch(l.input)) return [];
  const rows = [], vault = l.input.gotchi.vault, mint = l.keys?.mint?.address;
  for (const op of l.operations || []) {
    if (op.kind !== 'payout' || op.state !== 'confirmed' || !signature(op.signature) || !Array.isArray(op.payouts)) continue;
    let sender;
    try { sender = rewardsWalletKey(l, rewardsWalletSelection(l, { operation: op, receipt: true }), { signer: true, receipt: true })?.address; } catch { continue; }
    if (!base58(sender)) continue;
    for (const row of op.payouts) {
      if (row.owner !== vault || !digits(row.amount) || BigInt(row.amount) === 0n) continue;
      rows.push({ kind: 'raydium-gotchi-payout', gotchiId: l.input.gotchi.id, launchMint: mint, venue: 'raydium', signature: op.signature, mint: l.input.quoteMint, amount: row.amount, wallet: vault, sourceWallet: sender, decimals: l.review?.quoteDecimals ?? 9, symbol: l.review?.quoteSymbol || 'SOL', at: op.confirmedAt || op.createdAt || null });
    }
  }
  return rows;
}
