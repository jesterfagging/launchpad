import { WALLET_LIMITS } from './wallet-limits.mjs';
export const runKinds = ['copy', 'liquidity', 'market', 'sniper'];
export const runLabels = { copy: 'Copytrading', liquidity: 'LP management', market: 'Market making', sniper: 'Launch sniping' };
export function cleanRunWallets(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid mode wallet selections.');
  return Object.fromEntries(runKinds.map(kind => {
    const selected = value[kind];
    if (selected == null) return [kind, null];
    if (!Array.isArray(selected) || selected.length > WALLET_LIMITS[kind] || selected.some(x => typeof x !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x)) || new Set(selected).size !== selected.length)
      throw Error(`Invalid ${runLabels[kind]} wallet selection.`);
    return [kind, [...selected]];
  }));
}
