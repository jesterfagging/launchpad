import { launchpadEnv } from './brand-env.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { rpcCall } from './providers.mjs';
import { verifyRecordedPlatformFee } from './platform-fees.mjs';
import { publicEndpoint } from './telegram-network.mjs';
import { invariant } from './core.mjs';
import { operatorCapacity, operatorRpcOptions, rpcEndpointHash } from './operator-capacity.mjs';

export const receiptHash = receipt => createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

// Customer-supplied RPC receipts are trading journals, not trusted evidence of
// money received by the operator. Cashback becomes accrued only after this
// independent host-owned read confirms the fee on finalized mainnet history.
export class CashbackVerifier {
  constructor(accounts, { rpcUrl = launchpadEnv('CASHBACK_RPC_URL') || 'https://api.mainnet-beta.solana.com', rpc = rpcCall, now = Date.now, rpcGate } = {}) {
    publicEndpoint(rpcUrl); Object.assign(this, { accounts, rpcUrl, rpc, now }); this.busy = false; this.closed = false; this.abort = new AbortController(); this.chainChecked = false;
    if(rpcGate){
      this.rpcGate=rpcGate;this.rpcClient=randomUUID();const hash=rpcEndpointHash(rpcUrl),key=`rpc:${hash}`,rate=operatorCapacity({rpcUrl}).rpcRequestsPerSecond;
      this.rpc=async(url,method,params,signal)=>{const options=operatorRpcOptions(hash);await rpcGate.acquire(key,this.rpcClient,rate,{...options,method,signal,deadline:Date.now()+options.requestDeadlineMs});signal?.throwIfAborted();try{return await rpc(url,method,params,signal);}catch(error){if(error.rateLimited)rpcGate.cooldown(key,error.retryAfterMs||1000);throw error;}};
    }
  }
  start() { this.timer ||= setInterval(() => this.tick().catch(() => {}), 20000); this.timer.unref(); }
  async tick() {
    if (this.busy || this.closed) return; this.busy = true;
    try {
      let checked = 0;
      for (const account of await this.accounts.list()) {
        if (this.closed || checked >= 10) break;
        const store = this.accounts.storeFor(account.id), verification = await store.read('cashback-verification', { version: 1, receipts: {} });
        let changed = false;
        for (const name of ['live', 'sniper-live', 'market-live', 'liquidity-live', 'portfolio-live']) {
          const ledger = await store.read(name, {});
          for (const receipt of ledger.feeReceipts || []) {
            if (this.closed || checked >= 10) break;
            if (receipt.mode !== 'live') continue;
            const hash = receiptHash(receipt), old = verification.receipts[receipt.signature];
            if (old?.hash === hash && (old.status === 'verified' || old.retryAt > this.now())) continue;
            checked++;
            try {
              if (!this.chainChecked) { invariant(await this.rpc(this.rpcUrl, 'getGenesisHash', [], this.abort.signal) === MAINNET, 'Cashback verifier requires Solana mainnet.'); this.chainChecked = true; }
              const tx = await this.rpc(this.rpcUrl, 'getTransaction', [receipt.signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1 }], this.abort.signal);
              invariant(tx?.meta, 'Waiting for finalized transaction history.');
              invariant(receipt.accountId === account.id && receipt.mainWallet === account.mainWallet && receipt.evidence?.accountId === account.id, 'Cashback receipt account mismatch.');
              invariant(tx.transaction?.signatures?.[0] === receipt.signature, 'Cashback transaction signature mismatch.');
              const keys = tx.transaction.message?.accountKeys || [];
              invariant(keys.some(k => String(k.pubkey || k) === receipt.wallet && k.signer === true), 'Cashback payer signature is missing.');
              const result = verifyRecordedPlatformFee(receipt, tx);
              invariant(result.amount === receipt.amount && result.cashbackAmount === receipt.cashbackAmount && result.recipient === receipt.recipient && result.mint === receipt.mint && result.mainWallet === account.mainWallet, 'Cashback verification differs from the recorded claim.');
              verification.receipts[receipt.signature] = { hash, status: 'verified', at: this.now(), amount: result.amount, cashbackAmount: result.cashbackAmount };
            } catch {
              if (this.closed) break;
              // No customer URL, credential, or provider exception is surfaced.
              verification.receipts[receipt.signature] = { hash, status: 'pending', retryAt: this.now() + 60000, at: this.now() };
            }
            changed = true;
          }
        }
        if (changed) await store.write('cashback-verification', verification);
      }
    } finally { this.busy = false; }
  }
  close() { this.closed = true; clearInterval(this.timer); this.abort.abort(); this.rpcGate?.removeClient(this.rpcClient); }
}
