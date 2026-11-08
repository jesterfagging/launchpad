// Pump.fun Classic managed strategies: pure decision and accounting rules.
//
// Market Maker is a finite, fee-funded inventory rebalancer: it buys or sells
// from its own strategy wallet to keep a target mix of SOL and the coin, with
// a drift band, cooldowns, a reversal guard against its own price impact,
// per-action, daily turnover and daily fee caps and a loss limit. It places no
// orders, sets no volume target and never trades the developer's tokens.
//
// Liquidity Manager accumulates its allocation until the coin graduates, then
// buys the matching amount of the coin and adds both sides to the canonical
// PumpSwap pool. Each later contribution increases the same LP position; LP
// increments are summed, never overwritten.
//
// Capital credits (fee receipts and seed) raise contributed capital and cash,
// never profit; performance is equity minus contributed capital.
import { PRICE_SCALE, valueOf, tokensFor, ammBuyOutput, effectiveQuoteReserves } from './math.mjs';

const big = value => typeof value === 'bigint' ? value : BigInt(String(value ?? '0'));
const max0 = value => value > 0n ? value : 0n;
const min = (a, b) => a < b ? a : b;
const abs = value => value < 0n ? -value : value;
export const DAY_MS = 86400000;
export const dayKey = now => new Date(now).toISOString().slice(0, 10);

/** Strategy equity in lamports at a spot price (lamports per raw token × 1e12) plus LP value. */
export function equity({ cash, tokens, price, lpValue = 0n }) { return big(cash) + valueOf(big(tokens), big(price)) + big(lpValue); }
/** Value of `lp` LP tokens: proportional claim on both effective reserves, priced at spot. */
export function lpValue({ lp, lpSupply, baseReserve, quoteReserve, price }) {
  const supply = big(lpSupply); if (supply === 0n || big(lp) === 0n) return 0n;
  return (big(quoteReserve) * big(lp) + valueOf(big(baseReserve) * big(lp), big(price))) / supply;
}
export function performance({ equity: value, contributed }) { const e = big(value), c = big(contributed); return { equity: e, contributed: c, result: e - c, resultBps: c > 0n ? (e - c) * 10000n / c : 0n }; }

/**
 * One Market Maker decision. Returns { action: 'hold', reason } or
 * { action: 'buy', lamports } / { action: 'sell', tokens }, or
 * { action: 'pause', reason } when a hard limit is reached.
 */
export function marketMakerDecision({ policy, state, price, now }) {
  const p = policy, cash = big(state.cash), tokens = big(state.tokens), spot = big(price);
  if (spot <= 0n) return { action: 'hold', reason: 'No current executable price.' };
  const reserve = big(p.cashReserveLamports), spendable = max0(cash - reserve);
  const tokenValue = valueOf(tokens, spot), total = spendable + tokenValue;
  const contributed = big(state.contributed);
  const value = cash + tokenValue;
  if (contributed > 0n && value * 10000n < contributed * BigInt(10000 - p.lossLimitBps)) return { action: 'pause', reason: 'The loss limit was reached. An operator must review and resume this strategy.' };
  const minTrade = big(p.minTradeLamports);
  if (total < minTrade * 2n) return { action: 'hold', reason: 'Waiting for enough capital to trade.', state: 'accumulating' };
  const baseBps = tokenValue * 10000n / total, target = BigInt(p.targetBaseBps), band = BigInt(p.bandBps);
  if (abs(baseBps - target) <= band) return { action: 'hold', reason: 'Inventory is within its target band.' };
  const side = baseBps < target ? 'buy' : 'sell';
  if (now - Number(state.lastActionAt || 0) < p.cooldownMs) return { action: 'hold', reason: 'Cooling down after the last trade.' };
  if (state.lastSide && state.lastSide !== side) {
    if (now - Number(state.lastActionAt || 0) < p.flipCooldownMs) return { action: 'hold', reason: 'Waiting before reversing direction.' };
    // Do not react to our own price impact: reversing needs the price to move
    // beyond the last fill by the reversal guard.
    const last = big(state.lastPrice);
    if (last > 0n) { const moved = abs(spot - last) * 10000n / last; if (moved < BigInt(p.reversalGuardBps)) return { action: 'hold', reason: 'The price has not moved beyond the last fill.' }; }
  }
  const day = dayKey(now), turnover = state.dayKey === day ? big(state.dayTurnover) : 0n, fees = state.dayKey === day ? big(state.dayFees) : 0n;
  const turnoverCap = total * BigInt(p.dailyTurnoverBps) / 10000n, feeCap = total * BigInt(p.dailyFeeCapBps) / 10000n;
  if (fees >= feeCap) return { action: 'hold', reason: 'The daily fee budget is used.' };
  const room = max0(turnoverCap - turnover); if (room < minTrade) return { action: 'hold', reason: 'The daily turnover cap is used.' };
  const needed = abs(baseBps - target) * total / 10000n, perAction = total * BigInt(p.maxAdjustmentBps) / 10000n;
  let size = min(min(needed, perAction), room);
  if (side === 'buy') { size = min(size, spendable); if (size < minTrade) return { action: 'hold', reason: 'The buy would be below the minimum trade size.' }; return { action: 'buy', lamports: size, baseBps, target }; }
  const sellTokens = min(tokensFor(size, spot), tokens);
  if (valueOf(sellTokens, spot) < minTrade) return { action: 'hold', reason: 'The sell would be below the minimum trade size.' };
  return { action: 'sell', tokens: sellTokens, baseBps, target };
}
/** Applies a finalized trade to the strategy state (fees are the network fee; venue fees are inside the fill). */
export function applyTrade(state, { side, solDelta, tokenDelta, feeLamports, price, now }) {
  const day = dayKey(now), same = state.dayKey === day, notional = side === 'buy' ? -big(solDelta) : big(solDelta);
  return {
    cash: (big(state.cash) + big(solDelta)).toString(), tokens: (big(state.tokens) + big(tokenDelta)).toString(),
    fees_spent: (big(state.fees_spent ?? state.feesSpent) + big(feeLamports)).toString(),
    day_key: day, day_turnover: ((same ? big(state.dayTurnover ?? state.day_turnover) : 0n) + max0(notional)).toString(), day_fees: ((same ? big(state.dayFees ?? state.day_fees) : 0n) + big(feeLamports)).toString(),
    last_action_at: now, last_side: side, last_price: big(price).toString(), failures: 0,
  };
}

/**
 * Liquidity Manager: SOL to swap so that, after the swap, the strategy's coin
 * and SOL match the pool's post-swap ratio (bisection on constant product with
 * the full fee charged). Returns { swapLamports, tokensOut, depositQuote, depositBase }.
 */
export function lpPlan({ cash, tokens = 0n, reserveLamports, baseReserve, quoteVault, virtualQuoteReserves = 0n, feeBps }) {
  const available = max0(big(cash) - big(reserveLamports)), held = big(tokens);
  const B = big(baseReserve), Q = effectiveQuoteReserves(quoteVault, virtualQuoteReserves), fee = BigInt(feeBps);
  if (available === 0n) return { swapLamports: 0n, tokensOut: 0n, depositQuote: 0n, depositBase: 0n };
  // f(x) = tokens(x) * Q'(x) - sol(x) * B'(x); increasing in x.
  const state = x => { const out = x > 0n ? ammBuyOutput({ baseReserve: B, quoteReserve: Q, quoteIn: x, feeBps: fee }) : 0n, net = x * 10000n / (10000n + fee); return { out, t: held + out, s: available - x, b: B - out, q: Q + net }; };
  const f = x => { const v = state(x); return v.t * v.q - v.s * v.b; };
  if (f(0n) >= 0n) { const s = held * Q / B; return { swapLamports: 0n, tokensOut: 0n, depositQuote: min(s, available), depositBase: held }; }
  let lo = 0n, hi = available;
  for (let i = 0; i < 80 && hi - lo > 1n; i++) { const mid = (lo + hi) / 2n; if (f(mid) < 0n) lo = mid; else hi = mid; }
  const v = state(lo);
  return { swapLamports: lo, tokensOut: v.out, depositQuote: v.s, depositBase: v.t };
}
/** Spot price from curve virtual reserves or effective pool reserves (lamports per raw token × 1e12). */
export const curvePrice = curve => big(curve.virtual_quote_reserves) * PRICE_SCALE / big(curve.virtual_token_reserves);
export const poolPrice = ({ baseReserve, quoteVault, virtualQuoteReserves = 0n }) => effectiveQuoteReserves(quoteVault, virtualQuoteReserves) * PRICE_SCALE / big(baseReserve);
/** Observed strategy status for display. A funded but stopped bot is never "active". */
export function observedStatus({ strategy, launch, kind }) {
  if (launch.delivery_state === 'pending') return 'delivery_pending';
  if (strategy.desired === 'retired') return 'retired';
  if (strategy.desired === 'paused' || strategy.pause_reason) return 'paused';
  if (strategy.observed === 'reconciling') return 'reconciling';
  if (kind === 'lp_manager' && launch.venue_state !== 'amm') return 'waiting_for_graduation';
  if (big(strategy.contributed) === 0n) return 'waiting_for_fees';
  return strategy.observed === 'accumulating' ? 'accumulating' : 'active';
}
