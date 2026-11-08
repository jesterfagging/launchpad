import { launchpadEnv } from './brand-env.mjs';
import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { SOL, invariant } from './core.mjs';
import { receiptHash } from './cashback-verifier.mjs';
import { rpcCall } from './providers.mjs';
import { publicEndpoint } from './telegram-network.mjs';
import { join } from 'node:path';
import { acquireProcessLock } from './process-lock.mjs';

export async function verifyFeeRecipient(recipient, { rpc = rpcCall, rpcUrl = launchpadEnv('CASHBACK_RPC_URL') || 'https://api.mainnet-beta.solana.com' } = {}) {
  publicEndpoint(rpcUrl);
  const signal = AbortSignal.timeout(15000);
  invariant(await rpc(rpcUrl, 'getGenesisHash', [], signal) === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'The collection-wallet check requires Solana mainnet.');
  const [info, minimum] = await Promise.all([
    rpc(rpcUrl, 'getAccountInfo', [recipient, { encoding: 'base64', commitment: 'confirmed' }], signal),
    rpc(rpcUrl, 'getMinimumBalanceForRentExemption', [0], signal),
  ]);
  invariant(info?.value?.owner === SystemProgram.programId.toBase58() && !info.value.executable && Array.isArray(info.value.data) && info.value.data[0] === '', 'Fund a regular Solana wallet with SOL before using it for fee collection.');
  invariant(Number.isSafeInteger(minimum) && minimum > 0 && Number.isSafeInteger(info.value.lamports) && info.value.lamports >= minimum, `Fund the collection wallet with at least ${Number.isSafeInteger(minimum) ? minimum / 1e9 : 'the rent minimum in'} SOL before saving it.`);
}

// Rates are application policy, never imported from a customer's preset.
export const RATES = Object.freeze({ copyPpm: 2500, sniperPpm: 10000, marketPpm: 1000, liquidityPpm: 0, liquidityModel: 'half-krystal-auto-v1', settlement: 'sol' });
export class AccountFeePolicy {
  constructor(accounts, { verifyRecipient = verifyFeeRecipient } = {}) { this.accounts = accounts; this.verifyRecipient = verifyRecipient; this.queue = Promise.resolve(); }
  async get(id) {
    const account = await this.accounts.get(id), saved = await this.accounts.hostStore.read('fee-policy', {});
    const recipient = saved.recipient || '';
    const version = createHash('sha256').update(JSON.stringify({ schedule: 2, recipient, ...RATES, cashbackBps: account.cashbackBps })).digest('hex').slice(0, 24);
    return { ...RATES, version, recipient, ready: !!recipient && saved.fundingVerified === true, accountId: id, mainWallet: account.mainWallet, cashbackWallet: account.cashbackWallet || account.mainWallet, cashbackBps: account.cashbackBps,
      description: 'Copytrading: 0.25% per buy or sell. Launch Sniping: 1% per buy or sell. Manual trades use their selected tool’s rate. Market-making swaps: 0.10%. Fees settle in SOL within the trade transaction. SOL inputs deduct the fee from your budget. Token-to-SOL sells deduct the rate from guaranteed minimum SOL proceeds. Other token fees are swapped to SOL; collection uses that conversion’s guaranteed minimum. Better execution stays in your wallet. Conversion adds swap costs and requires an executable route. Cashback is a share of the actual Launchpad fee collected; it accrues to your account for your selected cashback wallet and is not yet paid.',
      liquidityDescription: 'LP automatic adjustments: 0.005%, 0.015%, or 0.025% of the position’s fresh SOL reference value, for pool swap-fee tiers up to 0.05%, up to 0.30%, or above 0.30%. Charged once when an automatic withdrawal begins; initial deposits, funding swaps, and manual withdrawals have no Launchpad management fee.',
      benchmarks: [
        { name: 'Ultimate SOL Market Maker', url: 'https://ultimatemarketmaker.com/pricing', publishedRate: '0.20% per swap', relayRate: '0.10% per swap' },
        { name: 'Krystal auto rebalance / exit', url: 'https://docs.krystal.app/ecosystem/fees', publishedRate: '0.01% / 0.03% / 0.05% per position', relayRate: '0.005% / 0.015% / 0.025%' },
      ], checkedAt: '2026-09-23',
    };
  }
  async setRecipient(value) {
    invariant(typeof value === 'string', 'Enter a Solana fee-collection wallet address.');
    let key; try { key = new PublicKey(value.trim()); } catch { throw new Error('Enter a valid Solana fee-collection wallet address.'); }
    invariant(PublicKey.isOnCurve(key.toBytes()), 'Use a regular Solana wallet for fee collection.');
    const task = this.queue.catch(() => {}).then(async () => {
      const release=await acquireProcessLock(join(this.accounts.dir,'fee-recipients.lock'));
      try{
        const launchpad=await this.accounts.hostStore.read('launch-protocol-fees',{});
        invariant(key.toBase58()!==launchpad.recipient,'Use a separate wallet for toolkit fees; this address receives launchpad fees.');
        const gasFunding=await this.accounts.hostStore.read('protocol-gas-funding',null);
        invariant(key.toBase58()!==gasFunding?.wallet?.address,'Use a separate wallet for toolkit fees; this address funds service gas.');
        await this.verifyRecipient(key.toBase58());
        await this.accounts.hostStore.write('fee-policy', { recipient: key.toBase58(), fundingVerified: true, updatedAt: Date.now() });
      }finally{await release();}
    });
    this.queue = task; await task; return key.toBase58();
  }
}

export async function cashbackSummary(store) {
  const byMint = new Map(), seen = new Set();
  const verification = await store.read('cashback-verification', { receipts: {} });
  for (const name of ['live', 'sniper-live', 'market-live', 'liquidity-live', 'portfolio-live']) {
    const ledger = await store.read(name, {});
    for (const receipt of ledger.feeReceipts || []) {
      if (receipt.mode && receipt.mode !== 'live') continue;
      const mint = receipt.mint || SOL, key = `${receipt.signature}:${mint}`;
      if (seen.has(key)) continue; seen.add(key);
      const row = byMint.get(mint) || { mint, decimals: receipt.decimals ?? (mint === SOL ? 9 : null), collected: 0n, accrued: 0n, unverified: 0n, paid: 0n };
      const verified = verification.receipts?.[receipt.signature];
      if (verified?.status === 'verified' && verified.hash === receiptHash(receipt)) {
        row.collected += BigInt(receipt.amount || 0); row.accrued += BigInt(receipt.cashbackAmount || 0);
      } else row.unverified += BigInt(receipt.cashbackAmount || 0);
      byMint.set(mint, row);
    }
  }
  // No payout is inferred from a submitted transaction or an operator checkbox.
  // A future payout reconciler must verify a transfer before it records payment.
  return [...byMint.values()].map(row => ({ mint: row.mint, decimals: row.decimals, collectedAmount: String(row.collected), accruedAmount: String(row.accrued), unverifiedAmount: String(row.unverified), paidAmount: String(row.paid), pendingAmount: String(row.accrued - row.paid) }));
}
