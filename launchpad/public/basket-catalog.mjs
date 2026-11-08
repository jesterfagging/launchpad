// Reward baskets (Launchpad v71.33): a Meteora holder-rewards launch may name up to two more assets
// next to its pair asset, three in all. The coin still trades against its pair asset on one curve
// and one graduated pool; what changes is the reward: every reward round is split equally across
// the basket, the extra shares are converted at market by the platform before they are sent, and
// every eligible holder is airdropped every basket asset. Shared by the launch page, the coin page,
// the docs and the server, which validates again with the same functions. Nothing here calls a
// provider or spends.
export const BASKET_VERSION = 1;
export const BASKET_LIMITS = Object.freeze({
  maxAssets: 3, maxExtras: 2,
  // Conversions (pair asset → basket asset) use the fixed treasury-grade route guard: 1% slippage, at most 2% price impact.
  conversionSlippageBps: 100, conversionMaxImpactPct: 2,
  // A conversion that fails this many times in a round pays that share in the pair asset instead, with a note.
  conversionAttempts: 3,
});
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const fail = message => { throw Object.assign(Error(message), { statusCode: 400 }); };

/**
 * The creator's basket choice as the launch form holds it (`basket: [mint, mint]`, the extras only; the pair asset is
 * always the first basket asset), normalized for the server: an array of 0–2 distinct base58 mints, none of them the pair
 * asset. Returns null when nothing was chosen (no basket). Throws a 400 with a plain sentence otherwise.
 */
export function basketLaunchRequest(raw, { quoteMint = '' } = {}) {
  if (raw === undefined || raw === null) return null;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray(raw.extras) ? raw.extras : null;
  if (!list) fail('A reward basket lists the extra assets as mint addresses.');
  if (list.length === 0) return null;
  if (list.length > BASKET_LIMITS.maxExtras) fail(`A reward basket holds at most ${BASKET_LIMITS.maxAssets} assets: your pair asset plus ${BASKET_LIMITS.maxExtras} more.`);
  const extras = list.map(value => { if (typeof value !== 'string' || !BASE58.test(value)) fail('A reward basket asset must be a Solana mint address.'); return value; });
  if (new Set(extras).size !== extras.length) fail('A reward basket lists each asset once.');
  if (quoteMint && extras.includes(quoteMint)) fail('Your pair asset is already in the basket; add a different asset.');
  return { version: BASKET_VERSION, extras };
}
/** Equal shares of `amountRaw` (bigint or decimal string) across `count` assets; the rounding remainder stays with the first (the pair asset). */
export function basketShares(amountRaw, count) {
  const total = BigInt(amountRaw), n = Math.max(1, Math.min(BASKET_LIMITS.maxAssets, Number(count) || 1));
  if (total < 0n) fail('A reward round cannot be negative.');
  const each = total / BigInt(n), shares = Array.from({ length: n }, () => each);
  shares[0] += total - each * BigInt(n);
  return shares;
}
/** "TSLAx, NVDAx and SOL" from the basket's symbols (in basket order). */
export function describeBasket(symbols) {
  const names = (Array.isArray(symbols) ? symbols : []).map(s => String(s || '').trim()).filter(Boolean);
  if (names.length <= 1) return names[0] || '';
  return names.slice(0, -1).join(', ') + ' and ' + names.at(-1);
}
export const BASKET_RULES = Object.freeze([
  'A reward basket is for Meteora launches with holder rewards. The coin trades against its pair asset on one curve and one graduated pool exactly like any other Meteora coin; the basket changes only what holders receive.',
  'Every hourly reward round, once at least $100 of the creator fee share is ready in the pair asset, is split equally across the basket. The extra shares are converted into their assets at market through Jupiter by the platform (1% slippage, at most 2% price impact, route costs come out of that share), then every eligible holder is airdropped every basket asset, weighted by eligible token balances.',
  'A share whose conversion has no route or exceeds the impact limit three times in a round is paid in the pair asset instead, and the round says so. Nothing is ever paid out of Launchpad’s own funds; conversions only move the creator fee share already earned by that coin.',
  'The basket is chosen at launch and cannot change afterwards. It is written into the coin’s public record.',
]);
