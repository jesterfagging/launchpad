export const WALLET_TOOLS = ['copy', 'liquidity', 'market'];
export const WALLET_LIMITS = Object.freeze({ copy: 25, sniper: 25, liquidity: 10, market: 5 });
export const WALLET_LABELS = { copy: 'Copy / Sniping', liquidity: 'LP', market: 'MM' };
export const MAX_WALLETS = 25;
// Older accounts may retain over-cap LP/MM wallets for withdrawals. New
// additions are checked against the per-tool limits on the account server.
export const MAX_STORED_WALLETS = 64;
export function walletTool(kind = 'copy') {
  if (kind === 'sniper') return 'copy';
  if (!WALLET_TOOLS.includes(kind)) throw Error('Choose Copytrading, LP, or MM wallets.');
  return kind;
}
export function walletIndices(settings, kind) {
  const tool = walletTool(kind);
  return (settings.wallets || []).flatMap((w, i) => settings.walletSchema !== 1 || (w.tool || 'copy') === tool ? [i] : []);
}
export function toolWallets(settings, kind) { return walletIndices(settings, kind).map(i => settings.wallets[i]); }
export function checkWalletCaps(next, previous = null) {
  for (const tool of WALLET_TOOLS) {
    const rows = toolWallets({ ...next, walletSchema: 1 }, tool), cap = WALLET_LIMITS[tool];
    if (rows.length <= cap) continue;
    const retained = new Set(previous ? toolWallets({ ...previous, walletSchema: 1 }, tool).map(w => w.publicKey) : []);
    if (rows.length <= retained.size && rows.every(w => retained.has(w.publicKey))) continue;
    throw Error(`Maximum ${cap} ${WALLET_LABELS[tool]} wallets, including imported and generated wallets.`);
  }
}
