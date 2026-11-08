import { CONTRACTS, erc20Abi, ponsAbi, airlockAbi } from './robinhood-contracts.mjs';
import { ponsV1Abi } from './robinhood-legacy-contracts.mjs';
import { deploymentErrorMessage } from './robinhood-rpc-errors.mjs';

const event = (abi, name) => abi.find(item => item.type === 'event' && item.name === name);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hash = value => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const min = (a, b) => a < b ? a : b;

export function walletLogFilters(kind, tracked, launchSource = 'both') {
  const transfer = event(erc20Abi, 'Transfer');
  const filters = [{ event: transfer, args: { from: tracked } }, { event: transfer, args: { to: tracked } }];
  if (kind === 'sniper') {
    if (launchSource !== 'long') filters.push(
      { address: CONTRACTS.ponsFactory, event: event(ponsAbi, 'TokenLaunched'), args: { deployer: tracked } },
      { address: CONTRACTS.ponsV1Factory, event: event(ponsV1Abi, 'TokenLaunched'), args: { deployer: tracked } }
    );
    // Airlock does not index the creator. Check each matching receipt's sender.
    if (launchSource !== 'pons') filters.push({ address: CONTRACTS.airlock, event: event(airlockAbi, 'Create') });
  }
  return filters;
}

function rangeLimit(error) {
  const text = deploymentErrorMessage(error);
  if (!/block range|range (?:is |too |limit|exceed)|too many (?:logs|results)|query returned more|response (?:size|too large)|query (?:timeout|timed out)/i.test(text)) return null;
  // Alchemy Free explicitly reports a 10-block range. Learn it once per run.
  const count = text.match(/\b(\d+)[ -]block(?:s)?\b/i);
  return count && Number(count[1]) > 0 ? BigInt(count[1]) : 0n;
}

// Standard eth_getLogs finds candidate transactions over a range. Receipt and
// canonical-header checks still run before the engine is allowed to act.
export class RobinhoodWalletScanner {
  constructor(client, { kind, tracked, launchSource, blockNumber, blockHash, signal, onTransaction, onRangeLimit = () => {} }) {
    Object.assign(this, { client, kind, signal, onTransaction, onRangeLimit });
    this.tracked = new Set(tracked.map(address => address.toLowerCase()));
    this.filters = walletLogFilters(kind, tracked, launchSource);
    this.blockNumber = blockNumber; this.blockHash = blockHash; this.head = blockNumber;
    this.range = 1000n; this.queries = 0; this.transactions = 0; this.lastScanAt = null; this.scanMs = null;
  }
  status() {
    return { mode: 'filtered-rpc-events', block: String(this.blockNumber), head: String(this.head), backlogBlocks: String(this.head > this.blockNumber ? this.head - this.blockNumber : 0n), rangeBlocks: Number(this.range), logQueries: this.queries, matchedTransactions: this.transactions, lastScanAt: this.lastScanAt, scanMs: this.scanMs };
  }
  check() { this.signal?.throwIfAborted(); }
  async header(number) {
    this.check();
    const block = await this.client.getBlock(number == null ? { blockTag: 'latest', includeTransactions: false } : { blockNumber: number, includeTransactions: false });
    this.check();
    if (typeof block.number !== 'bigint' || !hash(block.hash) || typeof block.timestamp !== 'bigint' || number != null && block.number !== number) throw Error('Robinhood RPC returned an incomplete block header. The scan cursor was not advanced.');
    return block;
  }
  async scan() {
    const started = Date.now();
    try {
      const head = await this.header(); this.head = head.number;
      if (head.number < this.blockNumber) throw Error('Robinhood RPC returned a head behind the last scanned block. Waiting for a current RPC response.');
      if (head.number === this.blockNumber) {
        if (!same(head.hash, this.blockHash)) throw Error('Robinhood block history changed. Stop and reconnect after pending transactions reconcile.');
        return false;
      }
      const anchor = await this.header(this.blockNumber);
      if (!same(anchor.hash, this.blockHash)) throw Error('Robinhood block history changed. Stop and reconnect after pending transactions reconcile.');
      // Bound one turn so receipt reconciliation also gets time. Catch-up turns
      // run without the ordinary poll delay; no unscanned blocks are discarded.
      for (let windows = 0; windows < 8 && this.blockNumber < head.number; windows++) {
        this.check();
        const fromBlock = this.blockNumber + 1n;
        let toBlock, end, logs;
        while (true) {
          toBlock = min(head.number, fromBlock + this.range - 1n);
          end = toBlock === head.number ? head : await this.header(toBlock);
          const results = await Promise.allSettled(this.filters.map(filter => {
            this.check(); this.queries++;
            return this.client.getLogs({ ...filter, fromBlock, toBlock });
          }));
          this.check();
          const failures = results.filter(result => result.status === 'rejected');
          if (!failures.length) { logs = results.flatMap(result => result.value); break; }
          const hardFailure = failures.find(result => rangeLimit(result.reason) === null);
          if (hardFailure || toBlock === fromBlock) throw Error(`Robinhood event query failed: ${deploymentErrorMessage((hardFailure || failures[0]).reason)}`, { cause: (hardFailure || failures[0]).reason });
          const suggested = failures.map(result => rangeLimit(result.reason)).filter(value => value > 0n);
          const span = toBlock - fromBlock + 1n;
          let smaller = suggested.length ? span - 1n : (span + 1n) / 2n;
          for (const value of suggested) smaller = min(smaller, value);
          this.range = smaller; this.onRangeLimit(Number(smaller));
        }
        if (!Array.isArray(logs)) throw Error('Robinhood RPC returned invalid event data. The scan cursor was not advanced.');
        const receivedAt = Date.now(), candidates = new Map();
        for (const log of logs) {
          if (log?.removed || !hash(log?.transactionHash) || !hash(log?.blockHash) || typeof log?.blockNumber !== 'bigint' || log.blockNumber < fromBlock || log.blockNumber > toBlock || !Number.isSafeInteger(log.transactionIndex) || log.transactionIndex < 0) throw Error('Robinhood event history is incomplete or changed. The scan cursor was not advanced.');
          const key = log.transactionHash.toLowerCase(), previous = candidates.get(key);
          if (previous && (!same(previous.blockHash, log.blockHash) || previous.blockNumber !== log.blockNumber || previous.transactionIndex !== log.transactionIndex)) throw Error('Robinhood RPC returned conflicting transaction history.');
          candidates.set(key, log);
        }
        const currentEnd = await this.header(toBlock);
        if (!same(currentEnd.hash, end.hash)) throw Error('Robinhood block history changed during the event query. The scan cursor was not advanced.');
        const headers = new Map([[String(toBlock), currentEnd]]);
        const ordered = [...candidates.values()].sort((a, b) => a.blockNumber === b.blockNumber ? a.transactionIndex - b.transactionIndex : a.blockNumber < b.blockNumber ? -1 : 1);
        for (const candidate of ordered) {
          this.check();
          const receipt = await this.client.getTransactionReceipt({ hash: candidate.transactionHash });
          this.check();
          if (!same(receipt?.transactionHash, candidate.transactionHash) || !same(receipt?.blockHash, candidate.blockHash) || receipt?.blockNumber !== candidate.blockNumber || receipt?.transactionIndex !== candidate.transactionIndex || !['success', 'reverted'].includes(receipt?.status)) throw Error('Robinhood receipt does not match its event history. The scan cursor was not advanced.');
          if (!this.tracked.has(receipt.from?.toLowerCase())) continue;
          const key = String(candidate.blockNumber);
          if (!headers.has(key)) headers.set(key, await this.header(candidate.blockNumber));
          const block = headers.get(key);
          if (!same(block.hash, receipt.blockHash)) throw Error('Robinhood receipt is no longer canonical. The scan cursor was not advanced.');
          this.check();
          await this.onTransaction({ hash: receipt.transactionHash, from: receipt.from, to: receipt.to }, receipt, block, { receivedAt });
          this.transactions++;
        }
        this.check();
        this.blockNumber = toBlock; this.blockHash = currentEnd.hash;
      }
      return this.blockNumber < head.number;
    } finally { this.lastScanAt = Date.now(); this.scanMs = this.lastScanAt - started; }
  }
}
