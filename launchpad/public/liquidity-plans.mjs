import { cleanStrategy } from './strategy-settings.mjs';
export const MAX_LP_POSITIONS = 20;
export function cleanLiquidityPlans(value = []) {
  if (!Array.isArray(value) || value.length > MAX_LP_POSITIONS) throw Error(`Maximum ${MAX_LP_POSITIONS} managed LP allocations.`);
  const seen = new Set();
  return value.map(row => {
    if (!row || !/^[a-zA-Z0-9_-]{8,80}$/.test(row.id || '') || seen.has(row.id)) throw Error('Invalid or duplicate LP allocation ID.');
    seen.add(row.id);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.wallet || '')) throw Error('Choose an LP wallet for every position.');
    return { id: row.id, label: String(row.label || 'LP position').slice(0, 40), wallet: row.wallet, strategy: cleanStrategy(row.strategy) };
  });
}
