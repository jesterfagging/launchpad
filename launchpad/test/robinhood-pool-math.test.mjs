// The pool maths (v71.41): the tick ↔ sqrt price product matches Uniswap's constants, the curve position built the way
// the factory builds it reproduces the virtual-reserve curve (same raise, same price path, within the tick rounding),
// quotes step across the two positions in both orientations, and the raise / sold / progress numbers follow the price.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqrtPriceAtTick, tickAtSqrtPrice, planPositions, poolPrice, curveNumbers, quoteSwap, graduationPositions, liquiditySegments, positionAmounts, usableRange, Q96, MIN_SQRT_PRICE, MAX_SQRT_PRICE } from '../public/robinhood-pool-math.mjs';
import { plannedSupply, quoteBuy, quoteSell, curvePrice } from '../public/robinhood-curve-math.mjs';

const SUPPLY = 10n ** 27n, SPACING = 10;
/** The two positions of a launch with these curve numbers, as the factory plans them. */
function plan({ tokenIs0, virtualQuote, graduationQuote, tickSpacing = SPACING, totalSupply = SUPPLY }) {
  const { sellSupply, lpSupply, virtualToken } = plannedSupply(totalSupply, virtualQuote, graduationQuote);
  return { ...planPositions({ tokenIs0, virtualQuote, graduationQuote, sellSupply, lpSupply, virtualToken, tickSpacing }), fee: 17500, tickSpacing, sellSupply, lpSupply };
}
const tickAt = tickAtSqrtPrice;
const within = (a, b, bps, what) => { const diff = a > b ? a - b : b - a; assert.ok(diff * 10000n <= b * BigInt(bps), `${what}: ${a} vs ${b} (over ${bps} bps apart)`); };

test('sqrtPriceAtTick is Uniswap’s TickMath', () => {
  assert.equal(sqrtPriceAtTick(-887272), MIN_SQRT_PRICE); assert.equal(sqrtPriceAtTick(887272), MAX_SQRT_PRICE); assert.equal(sqrtPriceAtTick(0), Q96);
  // 2^96 × 1.0001^(tick/2) to 80 digits: the bit-by-bit product (the same one the contracts run) lands within a few parts in 1e18.
  for (const [tick, value] of [[1, 79232123823359799118286999567n], [-1, 79224201403219477170569942573n], [100, 79625275426524748796330556127n], [-100, 78833030112140176575862854578n], [1000, 83290069058676223003182343269n], [-1000, 75364347830767020784054125654n], [5000, 101729702841318637793976746269n], [-5000, 61703726247759831737814779830n], [100000, 11755562826496067164730007768449n], [-100000, 533968626430936354154228407n], [443636, 340275971719517849884101479063205952279n], [-443636, 18447090764788882727n], [887200, 1456195216270955103182949462556801019286893565306n], [-887200, 4310618291n]]) { const got = sqrtPriceAtTick(tick), diff = got > value ? got - value : value - got; assert.ok(diff <= value / 10n ** 15n + 1n, `tick ${tick}: ${got} vs ${value}`); }
  assert.equal(tickAt(sqrtPriceAtTick(12345)), 12345); assert.equal(tickAt(sqrtPriceAtTick(12346) - 1n), 12345);
  assert.throws(() => sqrtPriceAtTick(887273), /out of range/);
});

test('the curve position reproduces the virtual-reserve curve: price, raise and quotes (ETH pair: the coin is currency1)', () => {
  const [vq, r] = [30n * 10n ** 18n, 85n * 10n ** 18n];
  const p = plan({ tokenIs0: false, virtualQuote: vq, graduationQuote: r });
  const { sellSupply, virtualToken } = plannedSupply(SUPPLY, vq, r);
  const cpmm = { virtualQuote: vq, graduationQuote: r, virtualToken, sellSupply, realQuote: 0n, sold: 0n, tradeFeeBps: 175, creatorTaxBps: 0, graduated: false };
  within(poolPrice(p.sqrtPriceX96, false), curvePrice(cpmm), 25, 'opening price (one tick spacing of rounding at most)');
  const numbers = curveNumbers(p, sellSupply);
  assert.equal(numbers.raised, 0n); assert.equal(numbers.sold, 0n); assert.equal(numbers.progressBps, 0);
  within(numbers.fullRaise, r, 150, 'the position holds R when full');
  // A 1 ETH buy, then a 5 ETH buy, each matching the curve's answer; then selling the second one back.
  const q1 = quoteSwap(p, { buy: true, amountIn: 10n ** 18n }), c1 = quoteBuy(cpmm, 10n ** 18n);
  within(q1.amountOut, c1.tokensOut, 60, '1 ETH buys what the curve gives');
  assert.equal(q1.fee, 175n * 10n ** 14n, 'the 1.75% curve-pool fee on the input'); assert.equal(q1.amountUsed, 10n ** 18n); assert.equal(q1.priceLimited, false);
  const after1 = { ...p, sqrtPriceX96: q1.sqrtPriceAfter };
  const n1 = curveNumbers(after1, sellSupply);
  within(n1.raised, 9825n * 10n ** 14n, 10, 'the net 0.9825 ETH sits in the position'); within(n1.sold, q1.amountOut, 1, 'sold = what left the position');
  assert.ok(n1.progressBps >= 114 && n1.progressBps <= 117, 'progress ≈ 0.9825 / 85 = 115 bps: ' + n1.progressBps);
  const cpmm1 = { ...cpmm, realQuote: c1.spent - c1.fee - c1.tax, sold: c1.tokensOut };
  const q2 = quoteSwap(after1, { buy: true, amountIn: 5n * 10n ** 18n }), c2 = quoteBuy(cpmm1, 5n * 10n ** 18n);
  within(q2.amountOut, c2.tokensOut, 60, 'the next 5 ETH too');
  const after2 = { ...p, sqrtPriceX96: q2.sqrtPriceAfter };
  const s2 = quoteSwap(after2, { buy: false, amountIn: q2.amountOut }), cs = quoteSell({ ...cpmm1, realQuote: cpmm1.realQuote + c2.spent - c2.fee - c2.tax, sold: cpmm1.sold + c2.tokensOut }, c2.tokensOut);
  within(s2.amountOut, cs.quoteOut, 60, 'selling the 5 ETH worth back returns what the curve would');
  assert.ok(s2.amountOut < 5n * 10n ** 18n && s2.amountOut > 48n * 10n ** 17n, 'two 1.75% fees and rounding');
  assert.equal(s2.fee, q2.amountOut * 175n / 10000n + (q2.amountOut * 175n % 10000n === 0n ? 0n : 1n), 'a sell’s fee is in coins');
});

test('graduation: the raise crosses into the upper position; the graduation pool takes the raise and the rest of the supply as a full-range position at the same price and trades at 0.5%', () => {
  const [vq, r] = [30n * 10n ** 18n, 85n * 10n ** 18n];
  const p = plan({ tokenIs0: false, virtualQuote: vq, graduationQuote: r }), { sellSupply, lpSupply } = plannedSupply(SUPPLY, vq, r);
  const big = quoteSwap(p, { buy: true, amountIn: r * 10000n / 9825n + r / 50n });
  const after = { ...p, sqrtPriceX96: big.sqrtPriceAfter, tick: tickAt(big.sqrtPriceAfter) };
  assert.ok(after.tick < p.graduationTick, 'coins per ETH fell past the graduation tick');
  const n = curveNumbers(after, sellSupply);
  assert.equal(n.progressBps, 10000); assert.equal(n.coinsLeft, 0n); assert.equal(n.sold, n.fullCoins);
  assert.ok(n.fullCoins > sellSupply - 10n ** 9n && n.fullCoins <= sellSupply, 'the position holds the sell supply less a few wei of rounding');
  assert.ok(big.amountOut > n.fullCoins, 'the buy took the whole curve position and some of the upper one');
  const more = quoteSwap(after, { buy: true, amountIn: 10n ** 18n });
  assert.ok(more.amountOut > 0n && more.amountOut < sellSupply / 200n, 'buys continue above graduation at a higher price (1 ETH buys under 0.5% of the supply there)');
  // Selling everything ever bought and then some in the curve pool: the liquidity ends at the start tick; the extra input is not taken.
  const dump = quoteSwap(after, { buy: false, amountIn: big.amountOut + more.amountOut + SUPPLY / 10n });
  assert.equal(dump.priceLimited, true); assert.ok(dump.amountUsed < big.amountOut + more.amountOut + SUPPLY / 10n, 'part of the input is left');
  within(dump.amountOut, (r * 10000n / 9825n + r / 50n + 10n ** 18n) * 9825n / 10000n, 150, 'what comes back is the raise (less the fees)');
  // The graduation (v71.41): the locker moves what the positions hold into the graduation pool at the same price.
  const held = after.positions ? null : [after.curve, after.upper].map(pos => positionAmounts(after.sqrtPriceX96, pos));
  const eth = held.reduce((s, a) => s + a.amount0, 0n), coins = held.reduce((s, a) => s + a.amount1, 0n);
  within(eth, (r * 10000n / 9825n + r / 50n) * 9825n / 10000n, 150, 'the positions hold the raise in ETH'); within(coins, lpSupply - (big.amountOut - n.fullCoins), 1, 'and the rest of the supply in coins');
  const g = graduationPositions(after, { fee: 5000, tickSpacing: SPACING });
  assert.equal(g.graduated, true); assert.equal(g.fee, 5000); assert.ok(g.positions.length >= 1 && g.positions.length <= 3, 'a full-range position and at most two slivers');
  const [lo, hi] = usableRange(SPACING); assert.equal(g.positions[0].tickLower, lo); assert.equal(g.positions[0].tickUpper, hi);
  for (const sliver of g.positions.slice(1)) assert.ok(sliver.liquidity < g.positions[0].liquidity / 100n, 'a sliver is a rounding leftover');
  assert.ok(g.dust.amount0 < 10n ** 12n && g.dust.amount1 < 10n ** 12n, 'a few wei of dust at most: ' + g.dust.amount0 + ' / ' + g.dust.amount1);
  const moved = g.positions.map(pos => positionAmounts(g.sqrtPriceX96, pos));
  within(moved.reduce((s, a) => s + a.amount0, 0n), eth, 1, 'the graduation pool holds the raise'); within(moved.reduce((s, a) => s + a.amount1, 0n), coins, 1, 'and the coins');
  assert.equal(liquiditySegments(g).length >= 1, true);
  assert.equal(poolPrice(g.sqrtPriceX96, false), poolPrice(after.sqrtPriceX96, false), 'the price did not move');
  // Trading in the graduation pool: 0.5% each way, no price limit for a modest sell (the raise is the depth).
  const buyG = quoteSwap(g, { buy: true, amountIn: 5n * 10n ** 18n });
  assert.equal(buyG.fee, 25n * 10n ** 15n, '0.5% of 5 ETH'); assert.ok(buyG.amountOut > 0n && !buyG.priceLimited);
  const sellG = quoteSwap({ ...g, sqrtPriceX96: buyG.sqrtPriceAfter, tick: tickAt(buyG.sqrtPriceAfter) }, { buy: false, amountIn: buyG.amountOut });
  within(sellG.amountOut, 5n * 10n ** 18n * 9950n * 9950n / 100000000n, 20, 'selling back returns the 5 ETH less two 0.5% fees');
  const dumpG = quoteSwap(g, { buy: false, amountIn: big.amountOut / 2n });
  assert.equal(dumpG.priceLimited, false); assert.ok(dumpG.amountOut > 0n && dumpG.amountOut < eth, 'selling half of everything bought into the graduation pool is paid from the raise, well within it');
  // The raise and lpSupply at the graduation price form a full-range pool with no leftovers of note: the CPMM shape's
  // promise (R / lpSupply = the graduation price).
  const fullAmounts = positionAmounts(g.sqrtPriceX96, g.positions[0]);
  assert.ok(fullAmounts.amount0 >= eth - eth / 100n && fullAmounts.amount1 >= coins - coins / 100n, 'the full-range position holds over 99% of both; the slivers the rest');
});

test('the other orientation (the coin is currency0): the curve runs upwards and the numbers agree', () => {
  const [vq, r] = [6000n * 10n ** 6n, 17000n * 10n ** 6n];
  const p = plan({ tokenIs0: true, virtualQuote: vq, graduationQuote: r }), { sellSupply, virtualToken } = plannedSupply(SUPPLY, vq, r);
  assert.ok(p.graduationTick > p.startTick);
  const cpmm = { virtualQuote: vq, graduationQuote: r, virtualToken, sellSupply, realQuote: 0n, sold: 0n, tradeFeeBps: 175, creatorTaxBps: 0, graduated: false };
  within(poolPrice(p.sqrtPriceX96, true), curvePrice(cpmm), 25, 'opening price in USDG per coin');
  const q = quoteSwap(p, { buy: true, amountIn: 1000n * 10n ** 6n }), c = quoteBuy(cpmm, 1000n * 10n ** 6n);
  within(q.amountOut, c.tokensOut, 60, '1,000 USDG buys what the curve gives');
  const after = { ...p, sqrtPriceX96: q.sqrtPriceAfter };
  assert.ok(after.sqrtPriceX96 > p.sqrtPriceX96, 'the price rose');
  within(curveNumbers(after, sellSupply).raised, 9825n * 10n ** 5n, 10, 'raised the net input');
  const s = quoteSwap(after, { buy: false, amountIn: q.amountOut });
  within(s.amountOut, 1000n * 10n ** 6n * 9825n * 9825n / 100000000n, 30, 'sold back for the input less two fees');
  const grad = quoteSwap(p, { buy: true, amountIn: r * 10000n / 9825n + r / 50n });
  assert.ok(tickAt(grad.sqrtPriceAfter) >= p.graduationTick, 'crossed upwards');
  // The graduation the other way round: the coin is currency0, the raise is amount1.
  const g = graduationPositions({ ...p, sqrtPriceX96: grad.sqrtPriceAfter, tick: tickAt(grad.sqrtPriceAfter) }, { fee: 5000, tickSpacing: SPACING });
  const moved = g.positions.map(pos => positionAmounts(g.sqrtPriceX96, pos));
  within(moved.reduce((t, a) => t + a.amount1, 0n), (r * 10000n / 9825n + r / 50n) * 9825n / 10000n, 150, 'the graduation pool holds the USDG raise');
  const buyG = quoteSwap(g, { buy: true, amountIn: 100n * 10n ** 6n }); assert.ok(buyG.amountOut > 0n && buyG.fee === 500000n, '0.5% of 100 USDG');
});
