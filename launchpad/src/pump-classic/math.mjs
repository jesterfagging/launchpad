// Pump.fun Classic: integer quote math for the native bonding curve and the
// canonical PumpSwap pool. Everything is BigInt in raw units.
//
// These quotes size orders and minimum outputs; they are never proof of a fill.
// Fees are applied conservatively: every fee component that can apply to a trade
// (protocol, creator and LP) is charged in full and rounded against us, so a
// real fill can only be the same or better. The program enforces the exact
// maximum input / minimum output we sign, and finalized receipts are the only
// source of accounting truth.
//
// Pump's buyback fee is not a further charge. `buyback_basis_points` is the
// share of the protocol fee (at most 10,000 bps of it) that Pump routes to its
// buyback recipients. Pump rejects a value above 10,000, and the deployed
// PumpSwap program asserts "buyback fee is at most protocol_fee". Mainnet
// PumpSwap's config held 5,000 when read on September 28, 2026, half the
// protocol fee, which as a trade fee would be 50%. The protocol fee is already
// charged in full, so the buyback share adds nothing to what a trader pays.
const fail = message => { throw Object.assign(Error(message), { code: 'PUMP_CLASSIC_QUOTE', statusCode: 409 }); };
const big = (value, label) => { const n = typeof value === 'bigint' ? value : BigInt(String(value ?? '')); if (n < 0n) fail(`Negative ${label}.`); return n; };
/** True when a buyback share is one Pump itself accepts (0 to 10,000 bps of the protocol fee). */
const buybackShareValid = value => big(value ?? 0n, 'buyback share') <= 10000n;
export const ceilDiv = (a, b) => { if (b <= 0n) fail('Division by zero in a quote.'); return (a + b - 1n) / b; };
export const BPS = 10000n;

/** Pump's market cap in lamports: virtual quote reserves × supply / virtual token reserves. */
export function curveMarketCap({ virtualQuote, virtualToken, supply }) {
  const vT = big(virtualToken, 'token reserves'); if (vT === 0n) fail('The curve has no virtual token reserves.');
  return big(virtualQuote, 'quote reserves') * big(supply, 'supply') / vT;
}
export function poolMarketCap({ baseReserve, quoteReserve, supply }) {
  const b = big(baseReserve, 'base reserves'); if (b === 0n) fail('The pool has no base reserves.');
  return big(quoteReserve, 'quote reserves') * big(supply, 'supply') / b;
}
/** calculate_fee_tier from Pump's fee program: first tier below its threshold, otherwise the highest reached. */
export function feeTier(tiers, marketCap) {
  if (!Array.isArray(tiers) || !tiers.length) return null;
  const mc = big(marketCap, 'market cap'), threshold = t => big(t.market_cap_lamports_threshold ?? t.marketCapLamportsThreshold, 'threshold');
  if (mc < threshold(tiers[0])) return tiers[0].fees;
  for (const tier of tiers.slice().reverse()) if (mc >= threshold(tier)) return tier.fees;
  return tiers[0].fees;
}
const feeParts = fees => ['lp_fee_bps', 'protocol_fee_bps', 'creator_fee_bps'].map(k => big(fees?.[k] ?? 0n, k));
/** Conservative total fee for a bonding-curve trade at the curve's current market cap. */
export function curveFeeBps({ global, feeConfig, curve, supply }) {
  const mc = curveMarketCap({ virtualQuote: curve.virtual_quote_reserves, virtualToken: curve.virtual_token_reserves, supply });
  const tier = feeConfig ? feeTier(feeConfig.fee_tiers, mc) : null;
  const [lp, protocol, creator] = tier ? feeParts(tier) : [0n, big(global.fee_basis_points, 'protocol fee'), big(global.creator_fee_basis_points, 'creator fee')];
  const total = lp + protocol + creator;
  if (total >= 2000n || !buybackShareValid(global.buyback_basis_points)) fail('The current Pump fee is outside the reviewed range.');
  return total;
}
/**
 * Conservative curve fee for a coin's quote kind. SOL coins use the live tier
 * for the curve's market cap. Pump prices a listed stable quote (USDC) from its
 * stable tiers and an approved custom pair from its exotic flat fees; their
 * market-cap units are not documented, so the highest schedule that could apply
 * is charged, and a coin's own custom creator fee replaces the creator part when
 * higher. Over-estimating only buys fewer tokens: the program enforces the
 * signed maximum spend either way.
 */
export function quoteCurveFeeBps({ global, feeConfig, curve, supply, kind = 'sol', creatorFeeBps = 0n }) {
  if (kind === 'sol') return curveFeeBps({ global, feeConfig, curve, supply });
  const custom = big(creatorFeeBps ?? 0n, 'creator fee'), candidates = [];
  const add = fees => { if (!fees) return; const [lp, protocol, creator] = feeParts(fees); candidates.push(lp + protocol + (custom > creator ? custom : creator)); };
  if (feeConfig) { for (const t of feeConfig.fee_tiers || []) add(t.fees); for (const t of feeConfig.stable_fee_tiers || []) add(t.fees); if (kind === 'custom') add(feeConfig.exotic_flat_fees); }
  if (!candidates.length) add({ lp_fee_bps: 0n, protocol_fee_bps: global.fee_basis_points ?? 0n, creator_fee_bps: global.creator_fee_basis_points ?? 0n });
  const total = candidates.reduce((a, b) => (a > b ? a : b), 0n);
  if (total >= 2000n || !buybackShareValid(global.buyback_basis_points)) fail('The current Pump fee is outside the reviewed range.');
  return total;
}
/** Lamports needed (fees included) to buy exactly `amount` tokens from the curve. */
export function curveBuyCost({ virtualQuote, virtualToken, realToken, amount, feeBps }) {
  const vQ = big(virtualQuote, 'quote reserves'), vT = big(virtualToken, 'token reserves'), a = big(amount, 'amount');
  if (a === 0n) return { base: 0n, fee: 0n, total: 0n };
  if (realToken !== undefined && a > big(realToken, 'real token reserves')) fail('The buy exceeds the tokens left on the curve.');
  if (a >= vT) fail('The buy exceeds the curve reserves.');
  const base = ceilDiv(vQ * a, vT - a) + 1n, fee = ceilDiv(base * big(feeBps, 'fee'), BPS);
  return { base, fee, total: base + fee };
}
/** Tokens for at most `quoteIn` lamports (fees included); never exceeds the curve's real tokens. */
export function curveTokensForQuote({ virtualQuote, virtualToken, realToken, quoteIn, feeBps }) {
  const vQ = big(virtualQuote, 'quote reserves'), vT = big(virtualToken, 'token reserves'), q = big(quoteIn, 'quote'), f = big(feeBps, 'fee');
  if (q === 0n) return 0n;
  const net = q * BPS / (BPS + f);
  let tokens = vT - ceilDiv(vQ * vT, vQ + net);
  if (realToken !== undefined) { const r = big(realToken, 'real token reserves'); if (tokens > r) tokens = r; }
  // Walk down until the conservative cost fits (rounding can overshoot by a few units).
  for (let i = 0; i < 64 && tokens > 0n; i++) {
    if (curveBuyCost({ virtualQuote: vQ, virtualToken: vT, realToken, amount: tokens, feeBps: f }).total <= q) return tokens;
    tokens -= tokens / 100000n + 1n;
  }
  return tokens > 0n ? fail('Could not size the curve buy within the budget.') : 0n;
}
/** Net lamports for selling exactly `amount` tokens into the curve. */
export function curveSellOutput({ virtualQuote, virtualToken, amount, feeBps }) {
  const vQ = big(virtualQuote, 'quote reserves'), vT = big(virtualToken, 'token reserves'), a = big(amount, 'amount');
  if (a === 0n) return 0n;
  const gross = vQ * a / (vT + a), fee = ceilDiv(gross * big(feeBps, 'fee'), BPS);
  return gross > fee ? gross - fee : 0n;
}
/** Effective PumpSwap quote reserves = vault balance + signed virtual quote reserves. */
export function effectiveQuoteReserves(vaultAmount, virtualQuoteReserves = 0n) {
  const value = big(vaultAmount, 'quote vault') + BigInt(virtualQuoteReserves ?? 0n);
  if (value <= 0n) fail('The pool has no effective quote reserves.');
  return value;
}
export function ammFeeBps({ globalConfig, feeConfig, pool, baseReserve, quoteReserve, supply, canonical = true }) {
  let parts;
  if (feeConfig) {
    const tier = canonical ? feeTier(feeConfig.fee_tiers, poolMarketCap({ baseReserve, quoteReserve, supply })) : feeConfig.flat_fees;
    parts = feeParts(tier);
  } else parts = [big(globalConfig.lp_fee_basis_points, 'lp fee'), big(globalConfig.protocol_fee_basis_points, 'protocol fee'), big(globalConfig.coin_creator_fee_basis_points ?? 0n, 'creator fee')];
  const total = parts.reduce((a, b) => a + b, 0n);
  if (total >= 2000n || !buybackShareValid(globalConfig.buyback_basis_points)) fail('The current PumpSwap fee is outside the reviewed range.');
  return total;
}
/** Base out for exactly `quoteIn` lamports into the pool (fees deducted from the input). */
export function ammBuyOutput({ baseReserve, quoteReserve, quoteIn, feeBps }) {
  const b = big(baseReserve, 'base reserves'), q = big(quoteReserve, 'quote reserves'), input = big(quoteIn, 'quote');
  if (input === 0n) return 0n;
  const net = input * BPS / (BPS + big(feeBps, 'fee'));
  return b * net / (q + net);
}
export function ammSellOutput({ baseReserve, quoteReserve, baseIn, feeBps }) {
  const b = big(baseReserve, 'base reserves'), q = big(quoteReserve, 'quote reserves'), input = big(baseIn, 'base');
  if (input === 0n) return 0n;
  const gross = q * input / (b + input), fee = ceilDiv(gross * big(feeBps, 'fee'), BPS);
  return gross > fee ? gross - fee : 0n;
}
/** Price impact (bps) of moving from a spot price to the execution price; both as quote per token scaled by 1e12. */
export function impactBps(spotScaled, executionScaled) {
  const s = big(spotScaled, 'spot'), e = big(executionScaled, 'execution');
  if (s === 0n) fail('No spot price.');
  const diff = e > s ? e - s : s - e;
  return diff * BPS / s;
}
export const PRICE_SCALE = 10n ** 12n;
/** Quote lamports per raw token, scaled by PRICE_SCALE. */
export const spotPrice = (quoteReserve, baseReserve) => big(quoteReserve, 'quote') * PRICE_SCALE / (big(baseReserve, 'base') || fail('No base reserves.'));
export const valueOf = (tokens, priceScaled) => big(tokens, 'tokens') * big(priceScaled, 'price') / PRICE_SCALE;
export const tokensFor = (lamports, priceScaled) => big(lamports, 'lamports') * PRICE_SCALE / (big(priceScaled, 'price') || fail('No price.'));
/** The program's proportional split of a distribution, floor per shareholder (dust stays in the vault). */
export function shareAmounts(distributed, shareholders) {
  const total = big(distributed, 'distribution');
  return shareholders.map(s => ({ address: s.address, amount: total * BigInt(s.shareBps ?? s.share_bps) / BPS }));
}
