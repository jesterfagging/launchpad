import { walletIndices, WALLET_LIMITS } from '../public/wallet-limits.mjs';
import { parseWallet, invariant } from './core.mjs';
import { cleanRunWallets, runKinds } from '../public/run-settings.mjs';
export function selectedRunSettings(raw, kind) {
  invariant(runKinds.includes(kind), 'Choose a trading mode.');
  const result = structuredClone(raw), selected = cleanRunWallets(raw.runWallets)[kind];
  const identities = raw.wallets.map((wallet, i) => parseWallet({ ...wallet }, i, wallet.privateKey ? 'live' : 'paper').publicKey);
  invariant(selected === null || selected.every(key => walletIndices(raw, kind).some(i => identities[i] === key)), 'A selected wallet is no longer imported. Review this mode’s wallets.');
  const indices = walletIndices(raw, kind).filter(i => selected === null || selected.includes(identities[i]));
  invariant(indices.length > 0, 'Select at least one wallet for this mode.');
  invariant(indices.length <= WALLET_LIMITS[kind], `Maximum ${WALLET_LIMITS[kind]} wallets for this tool.`);
  result.wallets = indices.map(i => ({ ...raw.wallets[i], publicKey: identities[i] }));
  if (['market', 'liquidity'].includes(kind)) {
    const strategy = result.strategy || result.strategies?.[kind];
    if (strategy) {
      const budgets = strategy.walletBudgets || {};
      strategy.walletBudgets = Object.fromEntries(indices.flatMap((old, i) => budgets[old] === undefined ? [] : [[i, budgets[old]]]));
    }
  }
  delete result.runWallets;
  return result;
}
