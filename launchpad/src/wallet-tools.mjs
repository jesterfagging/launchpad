import { WALLET_TOOLS, WALLET_LIMITS, toolWallets, WALLET_LABELS } from '../public/wallet-limits.mjs';
import { generateWalletBatch } from './wallet-generation.mjs';

// Run once under the account settings migration gate. Old journals and keys
// remain intact, including over-cap groups that still need manual exits.
export async function upgradeWalletTools(saved, store) {
  if (saved.walletSchema === 1) return saved;
  const next = structuredClone(saved), holdings = new Map();
  for (const tool of ['liquidity', 'market']) {
    const ledger = await store.read(`${tool}-live`, { lots: [], pending: [] });
    for (const row of [...ledger.lots, ...ledger.pending]) holdings.set(row.wallet, tool);
  }
  const legacy = await store.read('portfolio-live', { lots: [], pending: [] });
  for (const row of legacy.lots) if (['liquidity', 'market'].includes(row.kind)) holdings.set(row.wallet, row.kind);
  next.wallets = (next.wallets || []).map(w => {
    const selected = ['liquidity', 'market'].find(k => next.runWallets?.[k]?.includes(w.publicKey) && !next.runWallets?.copy?.includes(w.publicKey));
    return { ...w, tool: holdings.get(w.publicKey) || selected || 'copy' };
  });
  next.walletSchema = 1; next.defaultWallets = {}; next.runWallets ||= {};
  for (const tool of WALLET_TOOLS) {
    const existing = toolWallets(next, tool), priorSelection = next.runWallets[tool];
    let chosen;
    if (existing.length < WALLET_LIMITS[tool]) {
      [chosen] = await generateWalletBatch(1, existing, tool);
      chosen.label = `${WALLET_LABELS[tool]} default`; next.wallets.push(chosen);
    } else chosen = existing[0];
    next.defaultWallets[tool] = chosen.publicKey;
    const keys = existing.map(w => w.publicKey);
    next.runWallets[tool] = (Array.isArray(priorSelection) ? priorSelection.filter(k => keys.includes(k)) : keys).slice(0, WALLET_LIMITS[tool]);
    if (!existing.length) next.runWallets[tool] = [chosen.publicKey];
  }
  // Sharing the copy wallet pool does not automatically start a sniper run.
  next.runWallets.sniper = [next.defaultWallets.copy];
  await store.write('settings', next); return next;
}
