import { launchpadEnv } from './brand-env.mjs';
import { createPublicClient, http, decodeFunctionData, decodeEventLog, decodeAbiParameters, parseAbiParameters } from 'viem';
import { ROBINHOOD, EVM_NATIVE } from '../public/chains.mjs';
import { CONTRACTS, routerAbi, positionAbi } from './robinhood-contracts.mjs';
import { ChainStore, ensureRobinhoodAccount } from './robinhood-settings.mjs';
import { receiptHash } from './cashback-verifier.mjs';
import { publicEndpoint } from './telegram-network.mjs';
import { adapterAbi } from './robinhood-legacy-contracts.mjs';
import { executorAddress, verifyExecutor } from './robinhood-deployment.mjs';
import { ethExecution } from './robinhood-eth-trades.mjs';

export function verifyEvmFee(receipt, transaction, mined, mainWallet, adapter = executorAddress()) {
  if (receipt.chainId !== 4663 || mined.status !== 'success' || transaction.chainId !== 4663 || transaction.hash !== receipt.signature || transaction.from.toLowerCase() !== receipt.wallet.toLowerCase() || transaction.to?.toLowerCase() !== receipt.evidence.to.toLowerCase() || transaction.input !== receipt.evidence.data || transaction.value !== BigInt(receipt.evidence.value) || receipt.mainWallet !== mainWallet) throw Error('Robinhood fee evidence mismatch.');
  let amount = 0n;
  if (transaction.to.toLowerCase() === CONTRACTS.router.toLowerCase()) {
    const { args } = decodeFunctionData({ abi: routerAbi, data: transaction.input });
    const commands = args[0].slice(2).match(/../g) || [], inputs = args[1];
    if (commands.length !== inputs.length || commands.some(c => Number.parseInt(c, 16) & 0x80)) throw Error('Fee commands must execute atomically.');
    for (let i = 0; i < commands.length; i++) if (commands[i] === '05') {
      const [token, recipient, value] = decodeAbiParameters(parseAbiParameters('address,address,uint256'), inputs[i]);
      if (token === EVM_NATIVE && recipient.toLowerCase() === receipt.recipient.toLowerCase()) amount += value;
    }
  } else if (transaction.to.toLowerCase() === CONTRACTS.positionManager.toLowerCase()) {
    const { args } = decodeFunctionData({ abi: positionAbi, data: transaction.input });
    const [actions, inputs] = decodeAbiParameters(parseAbiParameters('bytes,bytes[]'), args[0]);
    if (actions !== '0x011114' || inputs.length !== 3) throw Error('Unrecognized LP fee transaction.');
    const [token, recipient] = decodeAbiParameters(parseAbiParameters('address,address'), inputs[2]);
    const [currency0, currency1, owner] = decodeAbiParameters(parseAbiParameters('address,address,address'), inputs[1]);
    if (token !== EVM_NATIVE || recipient.toLowerCase() !== receipt.recipient.toLowerCase() || owner.toLowerCase() !== receipt.wallet.toLowerCase()) throw Error('Invalid LP fee destination.');
    amount = transaction.value;
  } else if (adapter && transaction.to.toLowerCase() === adapter.toLowerCase()) {
    const { functionName, args } = decodeFunctionData({ abi: adapterAbi, data: transaction.input });
    const routed = functionName === 'tradeEth';
    if (!routed && (!['curveSwap', 'withdrawV2', 'withdrawV3'].includes(functionName) || args[4].toLowerCase() !== receipt.recipient.toLowerCase() || transaction.value < args[5])) throw Error('Invalid execution-contract fee call.');
    for (const log of mined.logs || []) if (log.address.toLowerCase() === adapter.toLowerCase()) try { const d = decodeEventLog({ abi: adapterAbi, eventName: 'PlatformFee', topics: log.topics, data: log.data }); if (d.args.wallet.toLowerCase() === receipt.wallet.toLowerCase() && d.args.recipient.toLowerCase() === receipt.recipient.toLowerCase() && d.args.operation === transaction.input.slice(0, 10)) amount += d.args.amount; } catch {}
    if (routed) {
      const execution = ethExecution(transaction, mined);
      if (execution.recipient.toLowerCase() !== receipt.recipient.toLowerCase() || execution.feeEth !== amount) throw Error('ETH execution fee evidence mismatch.');
    } else if (amount > args[5]) throw Error('Fee exceeds the signed maximum.');
  } else throw Error('Unknown fee contract.');
  if (amount <= 0n || amount !== BigInt(receipt.amount) || !Number.isInteger(receipt.cashbackBps) || receipt.cashbackBps < 0 || receipt.cashbackBps > 10000 || BigInt(receipt.cashbackAmount) !== amount * BigInt(receipt.cashbackBps) / 10000n) throw Error('Fee or cashback amount mismatch.');
  return { amount: String(amount), cashbackAmount: receipt.cashbackAmount };
}
export class RobinhoodCashbackVerifier {
  constructor(accounts, { client } = {}) {
    this.accounts = accounts; this.closed = false;
    this.client = client || createPublicClient({ transport: http(publicEndpoint(launchpadEnv('ROBINHOOD_CASHBACK_RPC_URL') || ROBINHOOD.rpc).toString(), { retryCount: 0, timeout: 12000 }) });
  }
  start() { this.timer ||= setInterval(() => this.tick().catch(() => {}), 30000); this.timer.unref(); }
  close() { this.closed = true; clearInterval(this.timer); }
  async tick() {
    if (this.closed || this.busy) return; this.busy = true;
    try {
      let checked = 0, finalized;
      for (const account of await this.accounts.list()) {
        if (this.closed || checked >= 10) break;
        const store = new ChainStore(this.accounts.storeFor(account.id)), verification = await store.read('cashback-verification', { version: 1, receipts: {} }); let changed = false;
        for (const name of ['live','sniper-live','market-live','liquidity-live']) {
          const ledger = await store.read(name, {});
          for (const receipt of ledger.feeReceipts || []) {
            if (this.closed || checked >= 10) break;
            const hash = receiptHash(receipt), old = verification.receipts[receipt.signature];
            if (old?.hash === hash && (old.status === 'verified' || old.retryAt > Date.now())) continue;
            checked++; changed = true;
            try {
              if (await this.client.getChainId() !== 4663) throw Error('Wrong verification chain.');
              finalized ||= await this.client.getBlock({ blockTag: 'finalized' });
              const [tx, mined] = await Promise.all([this.client.getTransaction({ hash: receipt.signature }), this.client.getTransactionReceipt({ hash: receipt.signature })]);
              if (receipt.accountId !== account.id || !finalized || mined.blockNumber > finalized.number) throw Error('Waiting for finalized fee history.');
              const block = await this.client.getBlock({ blockNumber: mined.blockNumber }); if (block.hash !== mined.blockHash) throw Error('Receipt is no longer canonical.');
              const main = (await ensureRobinhoodAccount(this.accounts, account.id)).mainWallet.publicKey;
              if (executorAddress() && tx.to?.toLowerCase() === executorAddress().toLowerCase()) await verifyExecutor(this.client, executorAddress());
              const value = verifyEvmFee(receipt, tx, mined, main); verification.receipts[receipt.signature] = { hash, status: 'verified', at: Date.now(), ...value };
            } catch { verification.receipts[receipt.signature] = { hash, status: 'pending', at: Date.now(), retryAt: Date.now() + 60000 }; }
          }
        }
        if (changed) await store.write('cashback-verification', verification);
      }
    } finally { this.busy = false; }
  }
}
