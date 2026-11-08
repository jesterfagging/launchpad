import { WALLET_LIMITS } from '../public/wallet-limits.mjs';
import { address, units, invariant, SOL, validateConfig } from './core.mjs';
import { cleanLiquidityPlans } from '../public/liquidity-plans.mjs';
import { resolvedStrategy } from '../public/strategy-settings.mjs';
import { appliedExecutionValues } from '../public/execution-presets.mjs';

export function portfolioConfig(raw, kind) {
  invariant(['liquidity', 'market'].includes(kind), 'Unknown strategy.');
  const plans = kind === 'liquidity' ? cleanLiquidityPlans(raw.liquidityPlans).filter(p => raw.wallets.some(w => w.publicKey === p.wallet)) : [];
  invariant(!raw.liquidityPlans?.length || kind !== 'liquidity' || plans.length, 'Select a wallet used by an LP position.');
  const s = resolvedStrategy(plans[0]?.strategy || raw.strategy);
  const execution = appliedExecutionValues('solana', raw);
  if (execution) s.limits.slippagePercent = Number(execution.slippagePercent);
  s.baseMint = address(s.baseMint, 'Base token mint'); s.quoteMint = address(s.quoteMint, 'Quote token mint');
  invariant(s.baseMint !== s.quoteMint, 'Choose two different token mints.');
  if (s.pool) s.pool = address(s.pool, 'Pool address');
  const budgets = raw.wallets?.map((_, i) => units(s.walletBudgets[i] || s.budgetSol));
  invariant(budgets?.every(b => b > 0n && b <= 1000000n * 1000000000n), 'Set a positive SOL budget for every wallet (maximum 1,000,000 SOL).');
  const c = validateConfig({ ...raw, leads: [], amountMode: 'fixed', buyAmount: '1', funding: 'sol', runBudgetSol: '0', sellMode: 'mirror',
    ...(execution || (s.advanced ? {} : { prioritySol: '0.00005', jitoSol: '0', heliusSol: '0', sendRpc: true })),
    slippagePercent: s.limits.slippagePercent, maxPriceImpact: s.limits.impactPercent, simulateBeforeSend: true, directLaunches: false,
    marketPollMs: 10000, maxSignalAgeMs: 120000 }, { requireLeads: false, walletLimit: WALLET_LIMITS[kind] });
  c.wallets.forEach((w, i) => { w.budget = budgets[i]; });
  const allocations = plans.length ? plans.map(p => {
    const strategy = resolvedStrategy(p.strategy);
    if (execution) strategy.limits.slippagePercent = Number(execution.slippagePercent);
    strategy.baseMint = address(strategy.baseMint, 'Position token mint'); strategy.quoteMint = address(strategy.quoteMint, 'Position quote mint');
    invariant(strategy.baseMint !== strategy.quoteMint, 'Choose two different token mints.');
    if (strategy.pool) strategy.pool = address(strategy.pool, 'Position pool');
    const budget = units(strategy.budgetSol); invariant(budget > 0n && budget <= 1000000n * 1000000000n, 'Set a positive LP position budget.');
    return { planId: p.id, label: p.label, wallet: p.wallet, budget, strategy };
  }) : c.wallets.map(w => ({ wallet: w.publicKey, budget: w.budget, strategy: s }));
  if (plans.length) for (const w of c.wallets) w.budget = allocations.filter(a => a.wallet === w.publicKey).reduce((n, a) => n + a.budget, 0n);
  if (plans.length) c.wallets = c.wallets.filter(w => w.budget > 0n);
  return { ...c, strategy: s, allocations, kind };
}
export const fraction = (amount, pct) => BigInt(amount) * BigInt(Math.floor(pct * 100)) / 10000n;
export const valueOf = (amount, mint, prices, decimals) => BigInt(amount) * prices[mint] / 10n ** BigInt(decimals[mint]);
export const amountOf = (value, mint, prices, decimals) => value * 10n ** BigInt(decimals[mint]) / prices[mint];
export function inventoryValue(record, prices, decimals) {
  return Object.entries(record.tokens).reduce((sum, [mint, amount]) => sum + valueOf(amount, mint, prices, decimals), 0n);
}
export function planInventory(record, s, prices, decimals, now = Date.now()) {
  const { baseMint: base, quoteMint: quote, limits: l } = s;
  const targetValue = fraction(valueOf(record.budget, SOL, prices, decimals), l.deployPercent);
  const reserveValue = valueOf(record.cashReserve || 0, SOL, prices, decimals);
  const rawBaseValue = valueOf(record.tokens[base] || 0, base, prices, decimals);
  const baseValue = base === SOL ? (rawBaseValue > reserveValue ? rawBaseValue - reserveValue : 0n) : rawBaseValue;
  const quoteValue = valueOf(record.tokens[quote] || 0, quote, prices, decimals);
  if (!record.initialized && quote !== SOL && base !== SOL) {
    const missing = targetValue - baseValue - quoteValue;
    const amount = amountOf(missing > 0n ? missing : 0n, SOL, prices, decimals);
    if (amount > BigInt(record.budget) / 1000n) return { inputMint: SOL, outputMint: quote, amount: amount < BigInt(record.tokens[SOL] || 0) ? amount : BigInt(record.tokens[SOL] || 0), reason: 'Allocate the quote token', funding: true };
  }
  const cashReserveValue = valueOf(record.cashReserve || 0, SOL, prices, decimals);
  const active = record.initialized ? baseValue + (quote === SOL ? (quoteValue > cashReserveValue ? quoteValue - cashReserveValue : 0n) : quoteValue) : targetValue;
  if (active <= 0n) return null;
  const drift = baseValue - fraction(active, l.targetPercent);
  const threshold = fraction(active, l.bandPercent);
  if (record.initialized && (drift < 0n ? -drift : drift) <= threshold) return null;
  if (record.lastTradeAt && now - record.lastTradeAt < l.cooldownSeconds * 1000) return null;
  const ratio = prices[base] * 1000000000n / prices[quote];
  // Do not reverse a just-filled trade on the same reference price or our own tiny impact.
  const direction = drift > 0n ? 'sell' : 'buy';
  if (record.initialized && record.lastDirection && record.lastDirection !== direction && record.lastRatio) {
    const change = ratio - BigInt(record.lastRatio);
    if ((change < 0n ? -change : change) * 10000n < BigInt(record.lastRatio) * 100n) return null;
  }
  const inputMint = drift > 0n ? base : quote, outputMint = drift > 0n ? quote : base;
  let tradeValue = drift > 0n ? drift : -drift;
  const cap = record.initialized ? fraction(active, l.tradePercent) : tradeValue;
  if (tradeValue > cap) tradeValue = cap;
  let amount = amountOf(tradeValue, inputMint, prices, decimals);
  const available = BigInt(record.tokens[inputMint] || 0);
  if (amount > available) amount = available;
  return amount > 0n ? { inputMint, outputMint, amount, direction, ratio: ratio.toString(), reason: record.initialized ? 'Holdings moved outside the target band' : 'Set the initial allocation' } : null;
}
export function netPlans(plans, baseMint, prices, decimals) {
  // Net opposite wallet imbalances before trading. Wallets never manufacture
  // turnover by buying from and selling into the same inventory adjustment.
  const buy = plans.filter(p => p.order?.outputMint === baseMint), sell = plans.filter(p => p.order?.inputMint === baseMint);
  let buyValue = buy.reduce((n, p) => n + valueOf(p.order.amount, p.order.inputMint, prices, decimals), 0n);
  let sellValue = sell.reduce((n, p) => n + valueOf(p.order.amount, p.order.inputMint, prices, decimals), 0n);
  const remove = (list, value) => {
    for (const p of list) {
      const v = valueOf(p.order.amount, p.order.inputMint, prices, decimals), deduction = value < v ? value : v;
      p.order.amount = amountOf(v - deduction, p.order.inputMint, prices, decimals); value -= deduction;
    }
  };
  const overlap = buyValue < sellValue ? buyValue : sellValue;
  remove(buy, overlap); remove(sell, overlap);
  return plans.filter(p => p.order?.amount > 0n);
}
