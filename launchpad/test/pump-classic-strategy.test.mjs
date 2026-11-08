// Pump.fun Classic managed strategies: the pure decision and accounting rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marketMakerDecision, applyTrade, lpPlan, lpValue, performance, observedStatus, curvePrice, dayKey } from '../src/pump-classic/strategy.mjs';
import { PUMP_CLASSIC_POLICY_V1 } from '../src/pump-classic/policy.mjs';
import { ammBuyOutput } from '../src/pump-classic/math.mjs';

const P = PUMP_CLASSIC_POLICY_V1.strategies.market_maker, SOL = 1000000000n, now = Date.UTC(2026, 9, 2, 12);
const price = 1000000000000n; // 1 lamport per raw token (× 1e12)
const state = over => ({ cash: (10n * SOL).toString(), tokens: '0', contributed: (10n * SOL).toString(), lastActionAt: 0, lastSide: '', lastPrice: '0', dayKey: '', dayTurnover: '0', dayFees: '0', ...over });

test('Market Maker rebalances toward its target with per-action, turnover and fee caps', () => {
  const buy = marketMakerDecision({ policy: P, state: state(), price, now });
  assert.equal(buy.action, 'buy');
  assert.equal(buy.lamports, (10n * SOL - BigInt(P.cashReserveLamports)) * BigInt(P.maxAdjustmentBps) / 10000n, 'one action moves at most the per-action share of equity');
  const balanced = marketMakerDecision({ policy: P, state: state({ cash: (5n * SOL).toString(), tokens: (5n * SOL).toString() }), price, now });
  assert.equal(balanced.action, 'hold'); assert.match(balanced.reason, /band/);
  const sell = marketMakerDecision({ policy: P, state: state({ cash: (1n * SOL).toString(), tokens: (9n * SOL).toString() }), price, now });
  assert.equal(sell.action, 'sell'); assert.ok(sell.tokens <= 9n * SOL);
  const cooling = marketMakerDecision({ policy: P, state: state({ lastActionAt: now - P.cooldownMs + 1, lastSide: 'buy' }), price, now });
  assert.equal(cooling.action, 'hold'); assert.match(cooling.reason, /Cooling/);
  const day = dayKey(now), cap = (10n * SOL - BigInt(P.cashReserveLamports)) * BigInt(P.dailyTurnoverBps) / 10000n;
  assert.match(marketMakerDecision({ policy: P, state: state({ dayKey: day, dayTurnover: cap.toString() }), price, now }).reason, /turnover/);
  assert.match(marketMakerDecision({ policy: P, state: state({ dayKey: day, dayFees: (SOL).toString() }), price, now }).reason, /fee budget/);
  // A new UTC day resets the daily counters.
  assert.equal(marketMakerDecision({ policy: P, state: state({ dayKey: '2026-10-01', dayTurnover: cap.toString() }), price, now }).action, 'buy');
});

test('Market Maker does not react to its own price impact and stops at its loss limit', () => {
  const afterBuy = { cash: (1n * SOL).toString(), tokens: (9n * SOL).toString(), lastSide: 'buy', lastPrice: price.toString() };
  assert.match(marketMakerDecision({ policy: P, state: state({ ...afterBuy, lastActionAt: now - P.flipCooldownMs + 1 }), price, now }).reason, /reversing/);
  const nudged = price + price * BigInt(P.reversalGuardBps - 1) / 10000n;
  assert.match(marketMakerDecision({ policy: P, state: state({ ...afterBuy, lastActionAt: now - P.flipCooldownMs - 1 }), price: nudged, now }).reason, /last fill/);
  const moved = price + price * BigInt(P.reversalGuardBps + 50) / 10000n;
  assert.equal(marketMakerDecision({ policy: P, state: state({ ...afterBuy, lastActionAt: now - P.flipCooldownMs - 1 }), price: moved, now }).action, 'sell');
  const losing = marketMakerDecision({ policy: P, state: state({ cash: (7n * SOL).toString(), contributed: (10n * SOL).toString() }), price, now });
  assert.equal(losing.action, 'pause'); assert.match(losing.reason, /loss limit/);
  assert.equal(marketMakerDecision({ policy: P, state: state({ cash: '15000000', contributed: '15000000' }), price, now }).state, 'accumulating');
});

test('capital credits never count as profit; trades update cash, tokens and daily counters', () => {
  assert.deepEqual(performance({ equity: 12n * SOL, contributed: 10n * SOL }), { equity: 12n * SOL, contributed: 10n * SOL, result: 2n * SOL, resultBps: 2000n });
  assert.equal(performance({ equity: 20n * SOL, contributed: 20n * SOL }).result, 0n, 'a deposit raises equity and contributed capital equally');
  const next = applyTrade({ cash: '1000000000', tokens: '0', fees_spent: '0', dayKey: '', dayTurnover: '0', dayFees: '0' }, { side: 'buy', solDelta: -100005000n, tokenDelta: 99000000n, feeLamports: 5000n, price, now });
  assert.deepEqual([next.cash, next.tokens, next.fees_spent, next.day_turnover, next.last_side], ['899995000', '99000000', '5000', '100005000', 'buy']);
});

test('Liquidity Manager sizes its swap so both sides match the post-swap pool', () => {
  const B = 200000000000000n, Q = 85000000000n, fee = 30n, plan = lpPlan({ cash: 3n * SOL, reserveLamports: 10000000n, baseReserve: B, quoteVault: Q, feeBps: fee });
  assert.ok(plan.swapLamports > 0n && plan.swapLamports < 3n * SOL);
  assert.equal(plan.tokensOut, ammBuyOutput({ baseReserve: B, quoteReserve: Q, quoteIn: plan.swapLamports, feeBps: fee }));
  const postB = B - plan.tokensOut, postQ = Q + plan.swapLamports * 10000n / (10000n + fee);
  const lhs = plan.depositBase * postQ, rhs = plan.depositQuote * postB, gap = lhs > rhs ? lhs - rhs : rhs - lhs;
  assert.ok(gap * 1000n < rhs, 'post-swap holdings are within 0.1% of the pool ratio');
  assert.notEqual(plan.swapLamports, (3n * SOL - 10000000n) / 2n, 'not a blind half split');
  // Already holding more tokens than the pool ratio: deposit without swapping.
  const tokenHeavy = lpPlan({ cash: 1n * SOL, tokens: 10000000000000n, reserveLamports: 0n, baseReserve: B, quoteVault: Q, feeBps: fee });
  assert.equal(tokenHeavy.swapLamports, 0n); assert.equal(tokenHeavy.depositBase, 10000000000000n);
  assert.equal(lpPlan({ cash: 5000000n, reserveLamports: 10000000n, baseReserve: B, quoteVault: Q, feeBps: fee }).depositQuote, 0n);
  // Own LP units value: proportional to the pool, priced at spot.
  assert.equal(lpValue({ lp: 10n, lpSupply: 100n, baseReserve: 1000n, quoteReserve: 2000n, price: 2000000000000n }), 400n);
});

test('observed strategy status never calls a stopped or unfunded bot active', () => {
  const base = { desired: 'active', observed: 'active', pause_reason: '', contributed: '1000' }, live = { delivery_state: 'complete', venue_state: 'curve' };
  assert.equal(observedStatus({ strategy: base, launch: live, kind: 'market_maker' }), 'active');
  assert.equal(observedStatus({ strategy: { ...base, desired: 'paused' }, launch: live, kind: 'market_maker' }), 'paused');
  assert.equal(observedStatus({ strategy: { ...base, desired: 'retired' }, launch: live, kind: 'market_maker' }), 'retired');
  assert.equal(observedStatus({ strategy: { ...base, contributed: '0' }, launch: live, kind: 'market_maker' }), 'waiting_for_fees');
  assert.equal(observedStatus({ strategy: base, launch: live, kind: 'lp_manager' }), 'waiting_for_graduation');
  assert.equal(observedStatus({ strategy: base, launch: { ...live, delivery_state: 'pending' }, kind: 'market_maker' }), 'delivery_pending');
  assert.equal(observedStatus({ strategy: { ...base, observed: 'reconciling' }, launch: live, kind: 'market_maker' }), 'reconciling');
  assert.equal(curvePrice({ virtual_quote_reserves: 30000000000n, virtual_token_reserves: 1073000000000000n }), 27958993n);
});
