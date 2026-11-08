import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { WALLET_TOOLS, WALLET_LIMITS, WALLET_LABELS, walletTool } from '../public/wallet-limits.mjs';

// Keypair.generate uses the system-backed CSPRNG. No RPC or funding transaction
// is involved. Yield between small groups so key generation cannot stall Stop.
export async function generateWalletBatch(count, existing = [], kind = 'copy') {
  const tool = walletTool(kind), cap = WALLET_LIMITS[tool];
  if (!Number.isInteger(count) || count < 1 || count > cap) throw new Error(`Choose a whole number from 1 to ${cap}.`);
  if (!Array.isArray(existing) || existing.length + count > cap) throw new Error(`Maximum ${cap} ${WALLET_LABELS[tool]} wallets total, including imported wallets.`);
  const used = new Set(existing.map(w => w.publicKey)), wallets = [];
  try {
    while (wallets.length < count) {
      const keypair = Keypair.generate();
      try {
        const publicKey = keypair.publicKey.toBase58();
        if (used.has(publicKey)) continue;
        used.add(publicKey);
        wallets.push({ label: `${WALLET_LABELS[tool]} ${existing.length + wallets.length + 1}`, publicKey, privateKey: bs58.encode(keypair.secretKey), amount: '', tool });
      } finally { keypair.secretKey.fill(0); }
      if (wallets.length % 5 === 0) await yieldTurn();
    }
    return wallets;
  } catch (error) { for (const wallet of wallets) wallet.privateKey = ''; throw error; }
}

export async function defaultTradingWallets(settings) {
  const next = { ...structuredClone(settings), walletSchema: 1, defaultWallets: {}, wallets: [] };
  for (const tool of WALLET_TOOLS) {
    const [wallet] = await generateWalletBatch(1, [], tool);
    wallet.label = `${WALLET_LABELS[tool]} default`;
    next.wallets.push(wallet); next.defaultWallets[tool] = wallet.publicKey;
  }
  return next;
}
