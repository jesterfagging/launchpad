import { updateManualResult } from './robinhood-manual.mjs';
import { encodeFunctionData, decodeEventLog, parseGwei, parseEther, keccak256, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CONTRACTS, erc20Abi, permitAbi, EVM_NATIVE, ROBINHOOD_CHAIN } from './robinhood-contracts.mjs';
import { adapterAbi, v3PositionAbi } from './robinhood-legacy-contracts.mjs';
import { ethExecution } from './robinhood-eth-trades.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export function tokenDelta(receipt, wallet, token) {
  let result = 0n;
  for (const log of receipt.logs || []) if (log.address.toLowerCase() === token.toLowerCase()) {
    try { const { args } = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics }); if (args.to.toLowerCase() === wallet.toLowerCase()) result += args.value; if (args.from.toLowerCase() === wallet.toLowerCase()) result -= args.value; } catch {}
  }
  return result;
}
export class RobinhoodExecutor {
  constructor(rpc, ledger, { policy, signal, event = () => {}, confirmed = async () => {} } = {}) { Object.assign(this, { rpc, ledger, policy, signal, event, confirmed }); this.client = rpc.client; this.queues = new Map(); this.reconciling = new Map(); this.preparing = new Set(); this.receiptWaiters = new Map(); }
  serial(wallet, task) {
    const job = (this.queues.get(wallet) || Promise.resolve()).catch(() => {}).then(task); this.queues.set(wallet, job);
    job.finally(() => { if (this.queues.get(wallet) === job) this.queues.delete(wallet); }).catch(() => {}); return job;
  }
  check(wallet) {
    this.signal?.throwIfAborted();
    if (this.ledger.data.pending.some(p => p.wallet === wallet)) throw Error('This wallet has an unresolved transaction. Receipt reconciliation must finish before another submission.');
  }
  async approvals(wallet, requirements) {
    for (const item of requirements) {
      this.check(wallet.publicKey); const amount = BigInt(item.amount);
      if (item.mode === 'nft') {
        if (item.token !== CONTRACTS.v3PositionManager || item.spender !== this.policy.adapter) throw Error('Invalid LP approval.');
        if ((await this.client.readContract({ address: item.token, abi: v3PositionAbi, functionName: 'ownerOf', args: [amount] })).toLowerCase() !== wallet.publicKey.toLowerCase()) throw Error('The LP receipt does not belong to this wallet.');
        if ((await this.client.readContract({ address: item.token, abi: v3PositionAbi, functionName: 'getApproved', args: [amount] })).toLowerCase() !== item.spender.toLowerCase()) await this.send(wallet, { to: item.token, data: encodeFunctionData({ abi: v3PositionAbi, functionName: 'approve', args: [item.spender, amount] }), value: 0n }, { operation: 'approval' });
        continue;
      }
      if (item.mode === 'erc20') {
        if (amount <= 0n || amount >= 2n ** 128n || ![CONTRACTS.v2Router, CONTRACTS.v3PositionManager, this.policy.adapter].filter(Boolean).includes(item.spender)) throw Error('Invalid direct approval requirement.');
        const allowance = await this.client.readContract({ address: item.token, abi: erc20Abi, functionName: 'allowance', args: [wallet.publicKey, item.spender] });
        if (allowance < amount) {
          if (allowance) await this.send(wallet, { to: item.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [item.spender, 0n] }), value: 0n }, { operation: 'approval' });
          await this.send(wallet, { to: item.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [item.spender, amount] }), value: 0n }, { operation: 'approval' });
        }
        continue;
      }
      if (amount <= 0n || amount >= 2n ** 160n || ![CONTRACTS.router, CONTRACTS.positionManager].includes(item.spender)) throw Error('Invalid approval requirement.');
      const ercAllowance = await this.client.readContract({ address: item.token, abi: erc20Abi, functionName: 'allowance', args: [wallet.publicKey, CONTRACTS.permit2] });
      if (ercAllowance < amount) {
        // Some ERC20s require resetting a non-zero allowance first.
        if (ercAllowance > 0n) await this.send(wallet, { to: item.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [CONTRACTS.permit2, 0n] }), value: 0n }, { operation: 'approval' });
        await this.send(wallet, { to: item.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [CONTRACTS.permit2, amount] }), value: 0n }, { operation: 'approval' });
      }
      const allowance = await this.client.readContract({ address: CONTRACTS.permit2, abi: permitAbi, functionName: 'allowance', args: [wallet.publicKey, item.token, item.spender] });
      if (allowance[0] < amount || Number(allowance[1]) < Date.now() / 1000 + 120) await this.send(wallet, { to: CONTRACTS.permit2, data: encodeFunctionData({ abi: permitAbi, functionName: 'approve', args: [item.token, item.spender, amount, Math.floor(Date.now() / 1000) + 3600] }), value: 0n }, { operation: 'approval' });
    }
  }
  async send(wallet, plan, context = {}) {
    const checksStarted = Date.now();
    this.check(wallet.publicKey);
    if (context.signalAt && Date.now() - context.signalAt > this.rpc.config.maxSignalAgeMs) throw Error('Buy signal expired before signing.');
    const account = privateKeyToAccount(wallet.privateKey);
    if (account.address !== wallet.publicKey) throw Error('Wallet key mismatch.');
    const [nonce, minedNonce, balance, block] = await Promise.all([this.client.getTransactionCount({ address: account.address, blockTag: 'pending' }), this.client.getTransactionCount({ address: account.address, blockTag: 'latest' }), this.client.getBalance({ address: account.address }), this.client.getBlock()]);
    if (nonce !== minedNonce) throw Error('This wallet already has a pending transaction outside this run. Wait for it to confirm.');
    const cap = parseGwei(this.rpc.config.maxGasGwei), priority = parseGwei(this.rpc.config.priorityGwei), base = block.baseFeePerGas;
    if (base == null || base + priority > cap || cap <= 0n) throw Error('The configured gas-price cap is below the current Robinhood requirement.');
    const maxFeePerGas = base * 2n + priority < cap ? base * 2n + priority : cap;
    const tx = { account: account.address, to: plan.to, data: plan.data, value: BigInt(plan.value || 0), nonce, maxFeePerGas, maxPriorityFeePerGas: priority };
    const simulationStarted = Date.now();
    // Gas estimation executes the complete transaction, including the platform fee.
    const gas = (await this.client.estimateGas(tx)) * 120n / 100n;
    const simulationMs = Date.now() - simulationStarted, signStarted = Date.now();
    if (context.signalAt && Date.now() - context.signalAt > this.rpc.config.maxSignalAgeMs) throw Error('Buy signal expired during simulation. No trade was submitted.');
    if (balance < tx.value + gas * maxFeePerGas + parseEther(this.rpc.config.reserveEth)) throw Error('Not enough Robinhood ETH for this transaction, gas, and the configured reserve.');
    this.check(wallet.publicKey);
    const serialized = await account.signTransaction({ ...tx, account: undefined, chainId: ROBINHOOD_CHAIN.id, type: 'eip1559', gas });
    const signature = keccak256(serialized), pending = { signature, wallet: account.address, nonce, signed: serialized, to: plan.to, data: plan.data, value: String(tx.value), createdAt: Date.now(), attempted: false, context: { ...context }, fee: plan.feeEth && BigInt(plan.feeEth) > 0n ? { amount: plan.feeEth, recipient: plan.recipient, ppm: plan.ppm, input: plan.input, inputAmount: plan.amount, mainWallet: this.policy.mainWallet, cashbackBps: this.policy.cashbackBps, accountId: this.policy.accountId, version: this.policy.version } : null };
    pending.timing = { ...context.timing, side: context.side, token: context.token, signalAt: context.signalAt || context.leadBlockAt,
      receivedAt: context.receivedAt, detectedAt: context.detectedAt, startedAt: context.startedAt || checksStarted,
      queueMs: context.detectedAt && context.startedAt ? Math.max(0,context.startedAt-context.detectedAt) : null,
      decodeMs: context.receivedAt && context.detectedAt ? Math.max(0,context.detectedAt-context.receivedAt) : null,
      checksMs: simulationStarted-checksStarted, simulationMs, signatureMs: Date.now()-signStarted };
    // Background reconciliation can remove the pending entry while this send
    // awaits its RPC acknowledgement or sleeps between receipt polls. Keep the
    // verified outcome for this active sender, independent of ledger snapshots.
    const completion = { receipt: null };
    this.receiptWaiters.set(signature, completion);
    try {
      const journalStarted = Date.now();
      await this.journalBeforeBroadcast(pending);
      pending.timing.journalMs = Date.now()-journalStarted;
      const broadcastAt = Date.now();
      const updateTiming = extra => { Object.assign(pending.timing, extra); const current = this.ledger.data.pending.find(p => p.signature === signature); if (current) current.timing = { ...pending.timing }; };
      updateTiming({});
      try {
        const returned = await this.rpc.request({ method: 'eth_sendRawTransaction', params: [serialized] });
        if (returned?.toLowerCase() !== signature.toLowerCase()) throw Error('RPC returned a different transaction hash.');
        updateTiming({ acceptedAt: Date.now(), rpcAckMs: Date.now()-broadcastAt });
        this.event('submitted', completion.receipt ? 'Transaction broadcast; its receipt was already checked.' : 'Transaction broadcast; waiting for its receipt.', { wallet: account.address, signature, operation: context.operation, side: context.side, token: context.token, timing: { ...pending.timing } });
      } catch {
        if (!completion.receipt) this.event('warn', 'Submission outcome is unresolved. This wallet is paused while its receipt is checked.', { wallet: account.address, signature });
      }
      let result;
      for (let i = 0; i < 30; i++) {
        result = completion.receipt || await this.reconcile(pending).catch(() => null) || completion.receipt;
        if (result || this.signal?.aborted) break;
        await wait(1000);
      }
      result ||= completion.receipt;
      if (result) { if (result.status !== '0x1') throw Error('Transaction reverted on Robinhood. No Launchpad fee was collected.'); return result; }
      throw Error('Transaction is still unresolved. This wallet remains paused; Stop prevents new submissions but cannot undo a broadcast.');
    } finally { this.receiptWaiters.delete(signature); }
  }
  async journalBeforeBroadcast(pending) {
    const signature = pending.signature;
    this.preparing.add(signature);
    try {
      this.ledger.data.pending.push(pending); await this.ledger.save();
      // Applying another wallet's receipt can replace the ledger snapshot while
      // this write is awaiting disk. Always mutate the current journal object.
      const current = this.ledger.data.pending.find(p => p.signature === signature);
      if (!current) throw Error('Transaction journal disappeared before broadcasting.');
      if (!this.signal?.aborted) {
        current.attempted = true;
        try { await this.ledger.save(); }
        catch (error) {
          const live = this.ledger.data.pending.find(p => p.signature === signature); if (live) live.attempted = false;
          throw error;
        }
      }
      // Stop can arrive during either durable write. Nothing has reached the
      // RPC yet, so cancellation remains definite and cannot strand a nonce.
      if (this.signal?.aborted) {
        this.ledger.data.pending = this.ledger.data.pending.filter(p => p.signature !== signature);
        await this.ledger.save(); throw Error('Stopped before broadcasting.');
      }
    } finally { this.preparing.delete(signature); }
  }
  async reconcile(pending) {
    const signature = pending.signature;
    if (this.reconciling.has(signature)) return this.reconciling.get(signature);
    const job = (async () => {
      if (this.preparing.has(pending.signature)) return null;
      pending = this.ledger.data.pending.find(p => p.signature === pending.signature);
      if (!pending) return null;
      if (!pending.attempted) { this.ledger.data.pending = this.ledger.data.pending.filter(p => p.signature !== pending.signature); await this.ledger.save(); return null; }
      const receipt = await this.rpc.request({ method: 'eth_getTransactionReceipt', params: [pending.signature] }, { reconcile: true });
      if (!receipt) return null;
      if (receipt.transactionHash?.toLowerCase() !== pending.signature.toLowerCase() || receipt.from?.toLowerCase() !== pending.wallet.toLowerCase() || receipt.to?.toLowerCase() !== pending.to.toLowerCase() || !['0x0','0x1'].includes(receipt.status)) throw Error('Transaction receipt identity mismatch.');
      const block = await this.rpc.request({ method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] }, { reconcile: true });
      if (!block || block.hash !== receipt.blockHash) return null;
      if (receipt.status === '0x1') {
        let feeAmount = pending.fee?.amount;
        if (pending.fee && this.policy.adapter && pending.to.toLowerCase() === this.policy.adapter.toLowerCase()) {
          let actual = 0n;
          for (const log of receipt.logs || []) if (log.address.toLowerCase() === this.policy.adapter.toLowerCase()) try { const d = decodeEventLog({ abi: adapterAbi, eventName: 'PlatformFee', topics: log.topics, data: log.data }); if (d.args.wallet.toLowerCase() === pending.wallet.toLowerCase() && d.args.recipient.toLowerCase() === pending.fee.recipient.toLowerCase()) actual += d.args.amount; } catch {}
          if (pending.context.nativeTrade) {
            const execution = ethExecution({ ...pending, from: pending.wallet }, receipt);
            if (actual !== execution.feeEth || execution.ppm !== pending.fee.ppm || execution.recipient.toLowerCase() !== pending.fee.recipient.toLowerCase()) throw Error('ETH trade fee evidence does not match its signed percentage.');
          } else if (actual > BigInt(pending.fee.amount)) throw Error('Execution-contract fee exceeds the signed maximum.');
          feeAmount = String(actual);
        }
        // Validate executor evidence before applying holdings or allocation
        // changes. Invalid fee evidence must leave the whole receipt pending.
        await this.confirmed(pending, receipt);
        if (pending.fee && BigInt(feeAmount) > 0n && !this.ledger.data.feeReceipts.some(r => r.signature === pending.signature)) this.ledger.data.feeReceipts.push({ mode: 'live', chain: 'robinhood', chainId: ROBINHOOD_CHAIN.id, signature: pending.signature, wallet: pending.wallet, recipient: pending.fee.recipient, mint: EVM_NATIVE, decimals: 18, amount: feeAmount, cashbackAmount: String(BigInt(feeAmount) * BigInt(pending.fee.cashbackBps) / 10000n), cashbackBps: pending.fee.cashbackBps, mainWallet: pending.fee.mainWallet, accountId: pending.fee.accountId, evidence: { to: pending.to, data: pending.data, value: pending.value, feeVersion: pending.fee.version }, at: Date.now() });
      }
      if (pending.context?.manualId) updateManualResult(this.ledger.data, pending.context.manualId, pending.wallet, { state: receipt.status === '0x1' ? 'confirmed' : 'failed', signature: pending.signature, ...(receipt.status === '0x0' ? { error: 'Transaction reverted; no Launchpad fee collected.' } : {}) });
      this.ledger.data.pending = this.ledger.data.pending.filter(p => p.signature !== pending.signature);
      try { await this.ledger.save(); }
      catch (error) {
        // Keep the wallet blocked on an I/O failure. The fill marker makes the
        // next receipt application idempotent, including its fee and budget.
        if (!this.ledger.data.pending.some(p => p.signature === pending.signature)) this.ledger.data.pending.push(pending);
        throw error;
      }
      // Publish only after identity/block/fee checks, accounting and its durable
      // save all succeed. An absent pending entry alone is never proof of a fill.
      const completion = this.receiptWaiters.get(signature);
      if (completion) completion.receipt = receipt;
      const confirmedAt = Date.now(), timing = { ...pending.timing, confirmedAt,
        receiptMs: pending.timing?.acceptedAt ? Math.max(0,confirmedAt-pending.timing.acceptedAt) : null,
        leadBlockToReceiptMs: pending.timing?.signalAt ? Math.max(0,confirmedAt-pending.timing.signalAt) : null };
      this.event(receipt.status === '0x1' ? 'confirmed' : 'error', receipt.status === '0x1' ? 'Transaction confirmed on Robinhood.' : 'Transaction reverted; no Launchpad fee collected.', { wallet: pending.wallet, signature: pending.signature, operation: pending.context.operation, side: pending.context.side, token: pending.context.token, timing });
      return receipt;
    })().finally(() => this.reconciling.delete(signature));
    this.reconciling.set(signature, job); return job;
  }
  async reconcileAll() { for (const pending of [...this.ledger.data.pending]) await this.reconcile(pending).catch(() => {}); }
  async drain() { await Promise.allSettled([...this.queues.values()]); await this.reconcileAll(); }
}
