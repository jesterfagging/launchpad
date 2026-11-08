// The Robinhood launch curve's arithmetic, mirrored from the contracts in BigInt so the service and the pages
// compute the same numbers the chain does: tiers → curve numbers (LaunchFactory.curveForTargets), the supply
// split (plannedSupply), FDVs (fdvFor) and trade quotes (the curve's quoteBuy / quoteSell). Browser-safe.
const ONE = 10n ** 18n;
const BPS = 10000n;
const big = value => typeof value === 'bigint' ? value : BigInt(String(value));

/** floor(sqrt(x)) for a non-negative BigInt. */
export function isqrt(value) {
  const x = big(value);
  if (x < 0n) throw Error('sqrt of a negative');
  if (x < 2n) return x;
  let z = 1n << BigInt(Math.ceil(x.toString(2).length / 2));
  for (;;) { const next = (z + x / z) >> 1n; if (next >= z) return z; z = next; }
}
const mulDivUp = (a, b, d) => { const p = a * b; return p / d + (p % d === 0n ? 0n : 1n); };

/**
 * The curve numbers that start a coin at `startFdv` and graduate it at `graduationFdv` (both in the pair asset's raw
 * units, for the whole supply): rho = sqrt(graduation / start) − 1, Vq = start (1 + rho)² / (rho (2 + rho)), R = rho Vq.
 */
export function curveForTargets(startFdv, graduationFdv) {
  const start = big(startFdv), graduation = big(graduationFdv);
  if (start <= 0n || graduation <= start) throw Error('The graduation market cap must be above the starting one.');
  const rho = isqrt(graduation * ONE * ONE / start) - ONE;
  if (rho <= 0n) throw Error('The curve is too flat.');
  const onePlus = ONE + rho;
  const virtualQuote = start * onePlus * onePlus / (rho * (2n * ONE + rho));
  const graduationQuote = virtualQuote * rho / ONE;
  if (virtualQuote <= 0n || graduationQuote <= 0n) throw Error('The curve numbers are too small for this pair.');
  return { virtualQuote, graduationQuote };
}

/** How a total supply splits: the pool share N·Vq/(2Vq+R), the curve sells the rest; Vt = S (Vq + R) / R. */
export function plannedSupply(totalSupply, virtualQuote, graduationQuote) {
  const supply = big(totalSupply), vq = big(virtualQuote), r = big(graduationQuote);
  const lpSupply = supply * vq / (2n * vq + r);
  const sellSupply = supply - lpSupply;
  const virtualToken = sellSupply * (vq + r) / r;
  return { supply, sellSupply, lpSupply, virtualToken };
}

/** The start and graduation FDV (raw pair units) of a curve over `totalSupply`. */
export function fdvFor(totalSupply, virtualQuote, graduationQuote) {
  const { supply, sellSupply, virtualToken } = plannedSupply(totalSupply, virtualQuote, graduationQuote);
  const vq = big(virtualQuote), r = big(graduationQuote);
  return { startFdv: supply * vq / virtualToken, graduationFdv: supply * (vq + r) / (virtualToken - sellSupply) };
}

/** The curve's reserves and price from its immutables and state. */
export function reserves({ virtualQuote, virtualToken, realQuote, sold }) {
  return { quoteReserve: big(virtualQuote) + big(realQuote), tokenReserve: big(virtualToken) - big(sold) };
}

/** Quote units per 1e18 token units at the current point of the curve. */
export function curvePrice(curve) {
  const { quoteReserve, tokenReserve } = reserves(curve);
  return quoteReserve * ONE / tokenReserve;
}

/** quoteBuy: tokens for `quoteIn` after fees, the fees, and the refund when the curve fills up. */
export function quoteBuy(curve, quoteIn) {
  const amount = big(quoteIn);
  const tradeFeeBps = big(curve.tradeFeeBps), creatorTaxBps = big(curve.creatorTaxBps || 0);
  const graduationQuote = big(curve.graduationQuote), realQuote = big(curve.realQuote), sellSupply = big(curve.sellSupply), sold = big(curve.sold);
  if (curve.graduated || amount === 0n) return { tokensOut: 0n, fee: 0n, tax: 0n, refund: amount, spent: 0n };
  const feeRate = tradeFeeBps + creatorTaxBps, remaining = graduationQuote - realQuote;
  let spent = amount, fee = spent * tradeFeeBps / BPS, tax = spent * creatorTaxBps / BPS, refund = 0n;
  if (spent - fee - tax > remaining) {
    spent = mulDivUp(remaining, BPS, BPS - feeRate);
    if (spent > amount) spent = amount;
    fee = spent * tradeFeeBps / BPS; tax = spent * creatorTaxBps / BPS;
    const netCapped = spent - fee - tax;
    if (netCapped > remaining) fee += netCapped - remaining;
    refund = amount - spent;
  }
  const net = spent - fee - tax;
  const { quoteReserve, tokenReserve } = reserves(curve);
  const k = big(curve.virtualQuote) * big(curve.virtualToken);
  let tokensOut = tokenReserve - mulDivUp(k, 1n, quoteReserve + net);
  const left = sellSupply - sold;
  if (tokensOut > left || realQuote + net >= graduationQuote) tokensOut = left;
  return { tokensOut, fee, tax, refund, spent };
}

/** quoteSell: quote for `tokensIn` after fees, and the fees. */
export function quoteSell(curve, tokensIn) {
  const amount = big(tokensIn);
  if (curve.graduated || amount === 0n) return { quoteOut: 0n, fee: 0n, tax: 0n, gross: 0n };
  const { quoteReserve, tokenReserve } = reserves(curve);
  const k = big(curve.virtualQuote) * big(curve.virtualToken);
  let gross = quoteReserve - mulDivUp(k, 1n, tokenReserve + amount);
  const realQuote = big(curve.realQuote);
  if (gross > realQuote) gross = realQuote;
  const fee = gross * big(curve.tradeFeeBps) / BPS, tax = gross * big(curve.creatorTaxBps || 0) / BPS;
  return { quoteOut: gross - fee - tax, fee, tax, gross };
}

/** Progress to graduation in bps (tokens sold over the sellable supply). */
export function progressBps(curve) {
  const sellSupply = big(curve.sellSupply); if (sellSupply === 0n) return 0n;
  const p = big(curve.sold) * BPS / sellSupply; return p > BPS ? BPS : p;
}

/** A tier's start and graduation FDV in raw pair units at `usdPerUnit` (price of one whole pair unit, as a decimal string) for a pair with `decimals`. */
export function tierTargetsInPair(tier, usdPerUnit, decimals) {
  const price = parsePrice(usdPerUnit);
  if (price <= 0n) throw Error('A live pair price is required.');
  const scale = 10n ** BigInt(decimals);
  const inPair = usd => big(usd) * scale * PRICE_SCALE / price;
  return { startFdv: inPair(tier.startUsd), graduationFdv: inPair(tier.graduationUsd) };
}
const PRICE_SCALE = 10n ** 8n;
/** A USD price as a decimal string to 8-decimal integer units. */
export function parsePrice(text) {
  const value = String(text ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw Error('A price is a plain decimal.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * PRICE_SCALE + BigInt((fraction + '00000000').slice(0, 8));
}
/** Raw pair units to USD (as a number) at `usdPerUnit`. */
export function unitsToUsd(amount, usdPerUnit, decimals) {
  const price = parsePrice(usdPerUnit);
  return Number(big(amount) * price / 10n ** BigInt(decimals)) / 1e8;
}
