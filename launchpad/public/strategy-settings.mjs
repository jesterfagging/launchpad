export const profiles = Object.freeze({
  conservative: { name: 'Conservative', description: 'More cash held back. Wider limits between adjustments.', deployPercent: 50, targetPercent: 50, bandPercent: 15, tradePercent: 5, cooldownSeconds: 300, pollSeconds: 30, slippagePercent: 0.5, impactPercent: 1, turnoverMultiple: 1, feePercent: 1, lossPercent: 10, rangeBins: 34, maxMoves: 2 },
  balanced: { name: 'Balanced', description: 'A middle ground for allocation and adjustments.', deployPercent: 70, targetPercent: 50, bandPercent: 10, tradePercent: 10, cooldownSeconds: 120, pollSeconds: 20, slippagePercent: 1, impactPercent: 2, turnoverMultiple: 2, feePercent: 2, lossPercent: 20, rangeBins: 20, maxMoves: 4 },
  active: { name: 'Active', description: 'More capital deployed. Tighter limits between adjustments.', deployPercent: 90, targetPercent: 50, bandPercent: 5, tradePercent: 15, cooldownSeconds: 60, pollSeconds: 15, slippagePercent: 1.5, impactPercent: 3, turnoverMultiple: 3, feePercent: 3, lossPercent: 30, rangeBins: 8, maxMoves: 6 },
});
export const strategyDefaults = () => ({ preset: 'balanced', baseMint: '', quoteMint: 'So11111111111111111111111111111111111111112', budgetSol: '1', walletBudgets: {}, advanced: false, autoCompoundFees: false, pool: '', tuning: {} });
export const tuningLimits = {
  deployPercent: [5, 95], targetPercent: [10, 90], bandPercent: [2, 40], tradePercent: [1, 25], cooldownSeconds: [30, 86400], pollSeconds: [10, 300], slippagePercent: [0.1, 5], impactPercent: [0.1, 5], turnoverMultiple: [0.1, 10], feePercent: [0.1, 10], lossPercent: [1, 50], rangeBins: [1, 34], maxMoves: [1, 10],
};
export function cleanStrategy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid strategy settings.');
  const out = strategyDefaults();
  for (const field of ['preset', 'baseMint', 'quoteMint', 'budgetSol', 'pool']) if (value[field] !== undefined) {
    if (typeof value[field] !== 'string' || value[field].length > 100) throw Error(`Invalid ${field}.`);
    out[field] = value[field].trim();
  }
  if (!Object.hasOwn(profiles, out.preset)) throw Error('Choose Conservative, Balanced, or Active.');
  if (value.advanced !== undefined && typeof value.advanced !== 'boolean') throw Error('Invalid advanced mode.');
  out.advanced = value.advanced === true;
  if (value.autoCompoundFees !== undefined && typeof value.autoCompoundFees !== 'boolean') throw Error('Invalid auto-compound setting.');
  out.autoCompoundFees = value.autoCompoundFees === true;
  if (value.walletBudgets !== undefined) {
    if (!value.walletBudgets || typeof value.walletBudgets !== 'object' || Array.isArray(value.walletBudgets) || Object.keys(value.walletBudgets).length > 64) throw Error('Maximum 64 saved wallet budgets.');
    for (const [key, amount] of Object.entries(value.walletBudgets)) {
      if (!/^\d{1,2}$/.test(key) || Number(key) > 63 || typeof amount !== 'string' || amount.length > 30) throw Error('Invalid wallet budget.');
      out.walletBudgets[key] = amount;
    }
  }
  if (value.tuning !== undefined) {
    if (!value.tuning || typeof value.tuning !== 'object' || Array.isArray(value.tuning)) throw Error('Invalid advanced settings.');
    for (const [key, [min, max]] of Object.entries(tuningLimits)) if (value.tuning[key] !== undefined) {
      const n = Number(value.tuning[key]);
      if (!Number.isFinite(n) || n < min || n > max) throw Error(`${key} must be between ${min} and ${max}.`);
      out.tuning[key] = n;
    }
  }
  return out;
}
export function resolvedStrategy(value) {
  const s = cleanStrategy(value), p = profiles[s.preset];
  return { ...s, limits: { ...p, ...(s.advanced ? s.tuning : {}) } };
}
