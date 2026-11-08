// Uniswap v4 maths for a Launchpad coin's pool (v71.41, pool-native launches). A coin's whole supply sits in its pool as two
// locked one-sided positions — the curve position (the sell supply between the start and the graduation price) and
// the upper position (the rest, from the graduation price up) — so the price, the raise, the coins sold and a quote
// for a buy or a sell all follow from the pool's sqrt price and the two positions. Everything is BigInt in the pool's
// own fixed point (sqrt prices in Q64.96; amounts in raw units), with Uniswap's rounding: what goes in rounds up, what
// comes out rounds down. Shared by the service (the coin view) and the pages (the trade box's quote).
//
// Orientation: a pool prices currency1 per currency0 (currency0 < currency1 by address). With ETH (address zero) the
// coin is always currency1 and the pool quotes coins per ETH, which falls as the coin is bought; with an ERC-20 pair
// the coin may sit on either side. `tokenIs0` says which, and every function here takes it into account.

export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const ONE = 10n ** 18n;
const big = value => typeof value === 'bigint' ? value : BigInt(String(value ?? '0'));
const mulDiv = (a, b, d) => (a * b) / d;
const mulDivUp = (a, b, d) => { const p = a * b; return p / d + (p % d === 0n ? 0n : 1n); };

/** sqrt(1.0001^tick) × 2^96 — Uniswap's TickMath.getSqrtPriceAtTick, bit for bit (the contracts use the same product). */
export function sqrtPriceAtTick(tick) {
  const t = Number(tick);
  if (!Number.isInteger(t) || t < MIN_TICK || t > MAX_TICK) throw Error('Tick out of range.');
  const absTick = BigInt(Math.abs(t));
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const steps = [
    [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn], [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n], [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n], [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n], [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n], [0x8000n, 0x31be135f97d08fd981231505542fcfa6n], [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n], [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, factor] of steps) if ((absTick & bit) !== 0n) ratio = (ratio * factor) >> 128n;
  if (t > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + ((ratio % (1n << 32n)) === 0n ? 0n : 1n);
}

/** The greatest tick whose sqrt price is at most `sqrtP` (a search over the exact forward function). */
export function tickAtSqrtPrice(sqrtP) {
  const p = big(sqrtP);
  if (p < MIN_SQRT_PRICE || p >= MAX_SQRT_PRICE) throw Error('Sqrt price out of range.');
  let lo = MIN_TICK, hi = MAX_TICK;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (sqrtPriceAtTick(mid) <= p) lo = mid; else hi = mid - 1; }
  return lo;
}

/** `tick` rounded down to a multiple of `spacing` (towards negative infinity), inside the usable range. */
export function alignDown(tick, spacing) {
  let aligned = Math.trunc(tick / spacing) * spacing;
  if (aligned > tick) aligned -= spacing;
  const [lo, hi] = usableRange(spacing);
  return Math.min(hi, Math.max(lo, aligned));
}

/** The widest ticks a pool of `spacing` allows. */
export function usableRange(spacing) { return [Math.trunc(MIN_TICK / spacing) * spacing, Math.trunc(MAX_TICK / spacing) * spacing]; }

/** sqrt(a1 / a0) × 2^96: the price of token1 per token0 that holds both amounts. */
export function sqrtPriceForAmounts(a0, a1) { return isqrt(big(a1) * Q192 / big(a0)); }

export function isqrt(value) {
  const x = big(value);
  if (x < 2n) return x;
  let z = 1n << BigInt(Math.ceil(x.toString(2).length / 2));
  for (;;) { const next = (z + x / z) >> 1n; if (next >= z) return z; z = next; }
}

/** The liquidity `amount` of token0 provides between sqrtA and sqrtB. */
export function liquidityForAmount0(sqrtA, sqrtB, amount) { return big(amount) * ((sqrtA * sqrtB) / Q96) / (sqrtB - sqrtA); }
/** The liquidity `amount` of token1 provides between sqrtA and sqrtB. */
export function liquidityForAmount1(sqrtA, sqrtB, amount) { return big(amount) * Q96 / (sqrtB - sqrtA); }

/**
 * LaunchFactory._plan in JavaScript: the pool a launch with these curve numbers gets — its orientation, opening
 * sqrt price, start and graduation ticks and the two positions (the curve position holds the sell supply between the
 * ticks, the upper position the rest above graduation). `sellSupply` / `lpSupply` / `virtualToken` as `plannedSupply`
 * gives them.
 */
export function planPositions({ tokenIs0, virtualQuote, graduationQuote, sellSupply, lpSupply, virtualToken, tickSpacing = 10 }) {
  const vq = big(virtualQuote), r = big(graduationQuote), sell = big(sellSupply), lp = big(lpSupply), vt = big(virtualToken), spacing = Number(tickSpacing);
  const sqrtA = tokenIs0 ? sqrtPriceForAmounts(vt, vq) : sqrtPriceForAmounts(vq, vt);
  const sqrtB = tokenIs0 ? sqrtPriceForAmounts(vt - sell, vq + r) : sqrtPriceForAmounts(vq + r, vt - sell);
  const tickA = alignDown(tickAtSqrtPrice(sqrtA), spacing), tickB = alignDown(tickAtSqrtPrice(sqrtB), spacing), [lo, hi] = usableRange(spacing);
  const fit0 = (a, b, amount) => { let l = liquidityForAmount0(sqrtPriceAtTick(a), sqrtPriceAtTick(b), amount); while (l > 0n && amount0Delta(sqrtPriceAtTick(a), sqrtPriceAtTick(b), l, true) > amount) l -= l / 1000000000n + 1n; return l; };
  const fit1 = (a, b, amount) => { let l = liquidityForAmount1(sqrtPriceAtTick(a), sqrtPriceAtTick(b), amount); while (l > 0n && amount1Delta(sqrtPriceAtTick(a), sqrtPriceAtTick(b), l, true) > amount) l -= l / 1000000000n + 1n; return l; };
  if (tokenIs0) {
    if (tickB <= tickA) throw Error('The curve range is narrower than the tick spacing.');
    return { tokenIs0, sqrtPriceX96: sqrtPriceAtTick(tickA), tick: tickA, startTick: tickA, graduationTick: tickB, curve: { tickLower: tickA, tickUpper: tickB, liquidity: fit0(tickA, tickB, sell) }, upper: { tickLower: tickB, tickUpper: hi, liquidity: tickB < hi ? fit0(tickB, hi, lp) : 0n }, tickSpacing: spacing };
  }
  if (tickA <= tickB) throw Error('The curve range is narrower than the tick spacing.');
  return { tokenIs0, sqrtPriceX96: sqrtPriceAtTick(tickA), tick: tickA, startTick: tickA, graduationTick: tickB, curve: { tickLower: tickB, tickUpper: tickA, liquidity: fit1(tickB, tickA, sell) }, upper: { tickLower: lo, tickUpper: tickB, liquidity: tickB > lo ? fit1(lo, tickB, lp) : 0n }, tickSpacing: spacing };
}

/** liquidity × (√B − √A) / (√A √B) in token0 (√A < √B). */
export function amount0Delta(sqrtA, sqrtB, liquidity, roundUp = false) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const numerator1 = liquidity << 96n, numerator2 = sqrtB - sqrtA;
  if (sqrtA === 0n) throw Error('Zero sqrt price.');
  return roundUp ? mulDivUp(mulDivUp(numerator1, numerator2, sqrtB), 1n, sqrtA) : mulDiv(numerator1, numerator2, sqrtB) / sqrtA;
}

/** liquidity × (√B − √A) in token1. */
export function amount1Delta(sqrtA, sqrtB, liquidity, roundUp = false) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return roundUp ? mulDivUp(liquidity, sqrtB - sqrtA, Q96) : mulDiv(liquidity, sqrtB - sqrtA, Q96);
}

/** The sqrt price after adding `amount` of token0 (price falls) at `liquidity` (getNextSqrtPriceFromAmount0RoundingUp). */
export function nextSqrtPriceFromAmount0(sqrtP, liquidity, amount) {
  if (amount === 0n) return sqrtP;
  const numerator1 = liquidity << 96n, product = amount * sqrtP;
  const denominator = numerator1 + product;
  return mulDivUp(numerator1, sqrtP, denominator);
}

/** The sqrt price after adding `amount` of token1 (price rises) at `liquidity` (getNextSqrtPriceFromAmount1RoundingDown). */
export function nextSqrtPriceFromAmount1(sqrtP, liquidity, amount) {
  return sqrtP + mulDiv(amount, Q96, liquidity);
}

/** The pool's price as the pages show it: raw pair units per whole coin (× 1e18, like the curve's `curvePrice`). */
export function poolPrice(sqrtPriceX96, tokenIs0) {
  const sqrtP = big(sqrtPriceX96);
  if (sqrtP === 0n) return 0n;
  return tokenIs0 ? mulDiv(sqrtP * sqrtP, ONE, Q192) : mulDiv(Q192, ONE, sqrtP * sqrtP);
}

/** A pool state as the service stores it (strings for the big numbers) made numeric. */
export function normalizePool(pool) {
  if (!pool) return null;
  const position = p => p ? { tickLower: Number(p.tickLower), tickUpper: Number(p.tickUpper), liquidity: big(p.liquidity) } : null;
  const curve = position(pool.curve), upper = position(pool.upper);
  // The positions locked in the pool trading now: [curve, upper] in the curve pool; the full-range position and the
  // slivers of the price's rounding in the graduation pool (v71.41).
  const positions = Array.isArray(pool.positions) && pool.positions.length ? pool.positions.map(position) : [curve, upper].filter(Boolean);
  return { sqrtPriceX96: big(pool.sqrtPriceX96), tick: Number(pool.tick), tokenIs0: !!pool.tokenIs0, startTick: Number(pool.startTick), graduationTick: Number(pool.graduationTick), curve, upper, positions, fee: Number(pool.fee || 0), tickSpacing: Number(pool.tickSpacing || 0), graduated: !!pool.graduated, crossed: !!pool.crossed };
}

/**
 * What the curve position holds right now: the pair asset raised (the quote in the position), the coins still in it,
 * the coins sold (of `sellSupply`) and the progress in bps (quote raised over the quote the position holds when full).
 */
export function curveNumbers(pool, sellSupply = null) {
  const p = normalizePool(pool);
  if (!p) return { raised: 0n, coinsLeft: 0n, sold: 0n, progressBps: 0, fullRaise: 0n, fullCoins: 0n };
  if (!p.curve || p.graduated) {
    // Graduated: the curve position is gone (its raise and the rest of the supply moved into the graduation pool); the
    // curve sold out in full.
    const supply = sellSupply === null || sellSupply === undefined ? 0n : big(sellSupply);
    return { raised: 0n, coinsLeft: 0n, sold: supply, sellSupply: supply, progressBps: 10000, fullRaise: 0n, fullCoins: supply, graduated: true };
  }
  const { curve, sqrtPriceX96: sqrtP, tokenIs0 } = p, lo = sqrtPriceAtTick(curve.tickLower), hi = sqrtPriceAtTick(curve.tickUpper), L = curve.liquidity;
  let raised, coinsLeft, fullRaise, fullCoins;
  if (tokenIs0) {
    // The coin is currency0: the position starts all coins at the lower tick and fills with the pair asset (currency1) as the price rises.
    fullRaise = amount1Delta(lo, hi, L); fullCoins = amount0Delta(lo, hi, L);
    raised = sqrtP <= lo ? 0n : sqrtP >= hi ? fullRaise : amount1Delta(lo, sqrtP, L);
    coinsLeft = sqrtP >= hi ? 0n : sqrtP <= lo ? fullCoins : amount0Delta(sqrtP, hi, L);
  } else {
    // The coin is currency1: the position starts all coins at the upper tick and fills with the pair asset (currency0) as the price falls.
    // Inside the range the part above the price has already turned into the pair asset, the part below still holds coins.
    fullRaise = amount0Delta(lo, hi, L); fullCoins = amount1Delta(lo, hi, L);
    raised = sqrtP >= hi ? 0n : sqrtP <= lo ? fullRaise : amount0Delta(sqrtP, hi, L);
    coinsLeft = sqrtP <= lo ? 0n : sqrtP >= hi ? fullCoins : amount1Delta(lo, sqrtP, L);
  }
  // The position's own capacity is the sell supply as locked (the planned number less a few wei of rounding burned at launch).
  const supply = sellSupply === null || sellSupply === undefined ? fullCoins : big(sellSupply);
  if (coinsLeft > fullCoins) coinsLeft = fullCoins;
  const progressBps = fullRaise === 0n ? 0 : Number(raised * 10000n / fullRaise);
  return { raised, coinsLeft, sold: fullCoins - coinsLeft, sellSupply: supply < fullCoins ? supply : fullCoins, progressBps: Math.min(10000, progressBps), fullRaise, fullCoins };
}

/** What a position holds at `sqrtP` (both sides, rounded down as a withdrawal pays). */
export function positionAmounts(sqrtP, position) {
  const lo = sqrtPriceAtTick(position.tickLower), hi = sqrtPriceAtTick(position.tickUpper), L = big(position.liquidity);
  if (sqrtP <= lo) return { amount0: amount0Delta(lo, hi, L, false), amount1: 0n };
  if (sqrtP >= hi) return { amount0: 0n, amount1: amount1Delta(lo, hi, L, false) };
  return { amount0: amount0Delta(sqrtP, hi, L, false), amount1: amount1Delta(lo, sqrtP, L, false) };
}

/** The largest liquidity both amounts fund at `sqrtP` over [sqrtA, sqrtB] (LiquidityAmounts.getLiquidityForAmounts). */
export function liquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1) {
  if (sqrtP <= sqrtA) return liquidityForAmount0(sqrtA, sqrtB, amount0);
  if (sqrtP >= sqrtB) return liquidityForAmount1(sqrtA, sqrtB, amount1);
  const l0 = liquidityForAmount0(sqrtP, sqrtB, amount0), l1 = liquidityForAmount1(sqrtA, sqrtP, amount1);
  return l0 < l1 ? l0 : l1;
}

/**
 * LaunchLocker's graduation in JavaScript: everything the curve pool's positions hold at the current price goes
 * into the graduation pool at that same price as one full-range position, with the leftover of either side as a
 * one-sided sliver next to the price. Returns the graduation pool's state (`fee` is the graduation pool's) and what
 * was moved; the few wei the rounding leaves are dust (coins burned, quote to the fees).
 */
export function graduationPositions(pool, { fee, tickSpacing = 10 } = {}) {
  const p = normalizePool(pool), sqrtP = p.sqrtPriceX96, tick = p.tick;
  let amount0 = 0n, amount1 = 0n;
  for (const position of p.positions) { const a = positionAmounts(sqrtP, position); amount0 += a.amount0; amount1 += a.amount1; }
  const [lo, hi] = usableRange(tickSpacing), sqrtLo = sqrtPriceAtTick(lo), sqrtHi = sqrtPriceAtTick(hi), positions = [];
  const take = (position, L) => { const need0 = amount0Delta(sqrtP <= sqrtPriceAtTick(position.tickLower) ? sqrtPriceAtTick(position.tickLower) : sqrtP < sqrtPriceAtTick(position.tickUpper) ? sqrtP : sqrtPriceAtTick(position.tickUpper), sqrtPriceAtTick(position.tickUpper), L, true), need1 = amount1Delta(sqrtPriceAtTick(position.tickLower), sqrtP >= sqrtPriceAtTick(position.tickUpper) ? sqrtPriceAtTick(position.tickUpper) : sqrtP > sqrtPriceAtTick(position.tickLower) ? sqrtP : sqrtPriceAtTick(position.tickLower), L, true); return { need0: sqrtP >= sqrtPriceAtTick(position.tickUpper) ? 0n : need0, need1: sqrtP <= sqrtPriceAtTick(position.tickLower) ? 0n : need1 }; };
  const fit = (position, start) => { let L = start; for (let i = 0; i < 64 && L > 0n; i++) { const { need0, need1 } = take(position, L); if (need0 <= amount0 && need1 <= amount1) { amount0 -= need0; amount1 -= need1; return L; } L -= L / 1000000000n + 1n; } return 0n; };
  const full = { tickLower: lo, tickUpper: hi, liquidity: 0n };
  full.liquidity = fit(full, liquidityForAmounts(sqrtP, sqrtLo, sqrtHi, amount0, amount1));
  if (full.liquidity > 0n) positions.push(full);
  if (amount0 > 0n) { const lower = alignDown(tick, tickSpacing) + tickSpacing; if (lower < hi) { const sliver = { tickLower: lower, tickUpper: hi, liquidity: 0n }; sliver.liquidity = fit(sliver, liquidityForAmount0(sqrtPriceAtTick(lower), sqrtHi, amount0)); if (sliver.liquidity > 0n) positions.push(sliver); } }
  if (amount1 > 0n) { const upper = alignDown(tick, tickSpacing); if (upper > lo) { const sliver = { tickLower: lo, tickUpper: upper, liquidity: 0n }; sliver.liquidity = fit(sliver, liquidityForAmount1(sqrtLo, sqrtPriceAtTick(upper), amount1)); if (sliver.liquidity > 0n) positions.push(sliver); } }
  return { ...p, fee: Number(fee ?? p.fee), tickSpacing, positions, curve: null, upper: null, graduated: true, crossed: true, dust: { amount0, amount1 } };
}

/**
 * The pool's liquidity as segments of the tick line: between two consecutive position bounds the active liquidity is the
 * sum of the positions covering the segment (the graduation pool's slivers overlap its full-range position). Each
 * segment is [sqrtLower, sqrtUpper, L], ordered upwards.
 */
export function liquiditySegments(pool) {
  const p = normalizePool(pool); if (!p) return [];
  const positions = p.positions.filter(r => r && r.liquidity > 0n);
  const bounds = [...new Set(positions.flatMap(r => [r.tickLower, r.tickUpper]))].sort((a, b) => a - b), out = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const lo = bounds[i], hi = bounds[i + 1], L = positions.filter(r => r.tickLower <= lo && r.tickUpper >= hi).reduce((sum, r) => sum + r.liquidity, 0n);
    if (L > 0n) out.push([sqrtPriceAtTick(lo), sqrtPriceAtTick(hi), L]);
  }
  return out;
}

/**
 * A swap against the pool's locked positions (the only liquidity a Launchpad pool has until others add some; the curve pool's
 * two positions, or the graduation pool's full range and slivers). `buy` spends `amountIn` of the pair asset for
 * coins; a sell spends coins for the pair asset. The LP fee comes off the input first. Returns what comes out, the
 * fee, the input actually used (a swap stops where the liquidity ends), and the sqrt price afterwards.
 */
export function quoteSwap(pool, { buy, amountIn }) {
  const p = normalizePool(pool), amount = big(amountIn);
  if (!p || amount <= 0n) return { amountOut: 0n, fee: 0n, amountUsed: 0n, sqrtPriceAfter: p?.sqrtPriceX96 || 0n, priceLimited: false };
  const feePips = BigInt(p.fee), fee = mulDivUp(amount, feePips, 1000000n);
  let remaining = amount - fee, out = 0n, sqrtP = p.sqrtPriceX96;
  // The input is currency0 when the price must fall (zeroForOne), currency1 when it must rise.
  const zeroForOne = p.tokenIs0 ? !buy : buy;
  const ranges = liquiditySegments(p);
  const ordered = zeroForOne ? ranges.slice().reverse() : ranges;
  for (const [lo, hi, L] of ordered) {
    if (remaining === 0n) break;
    if (zeroForOne) {
      if (sqrtP <= lo) continue; // already below this range
      const start = sqrtP < hi ? sqrtP : hi, target = lo;
      const needed = amount0Delta(target, start, L, true);
      if (remaining >= needed) { out += amount1Delta(target, start, L, false); remaining -= needed; sqrtP = target; continue; }
      const next = nextSqrtPriceFromAmount0(start, L, remaining);
      out += amount1Delta(next, start, L, false); remaining = 0n; sqrtP = next; break;
    } else {
      if (sqrtP >= hi) continue; // already above this range
      const start = sqrtP > lo ? sqrtP : lo, target = hi;
      const needed = amount1Delta(start, target, L, true);
      if (remaining >= needed) { out += amount0Delta(start, target, L, false); remaining -= needed; sqrtP = target; continue; }
      const next = nextSqrtPriceFromAmount1(start, L, remaining);
      out += amount0Delta(start, next, L, false); remaining = 0n; sqrtP = next; break;
    }
  }
  if (remaining > 0n) {
    // The liquidity ran out: only part of the input is taken (the fee applies to that part); a router refunds the rest.
    const netConsumed = amount - fee - remaining, gross = feePips === 0n ? netConsumed : mulDivUp(netConsumed, 1000000n, 1000000n - feePips);
    return { amountOut: out, fee: gross - netConsumed, amountUsed: gross > amount ? amount : gross, sqrtPriceAfter: sqrtP, priceLimited: true };
  }
  return { amountOut: out, fee, amountUsed: amount, sqrtPriceAfter: sqrtP, priceLimited: false };
}
