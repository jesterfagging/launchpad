// Robinhood launch venue: everything the service reads from and sends to Robinhood Chain, through the EVM
// primitives and the generated ABIs. Reads are plain eth_calls; a transaction is built, estimated, signed with the
// per-coin key and handed back as an operation the service journals before broadcasting; receipts and logs are
// decoded here. The adapter never chooses amounts or destinations: the service does, and the tests script this
// interface with a fake.
import { EvmRpc, RpcError } from '../evm/rpc.mjs';
import { encodeCall, abiItem, decodeLog, decodeRevert, decodeResult, topicOf } from '../evm/abi.mjs';
import { signTransaction, parseTransaction } from '../evm/tx.mjs';
import { privateKeyToAddress, isAddress } from '../evm/secp256k1.mjs';
import { hexToBigInt, toQuantity } from '../evm/hex.mjs';
import { keccakHex } from '../evm/keccak.mjs';
import { ABI } from './abi.mjs';
import { ROBINHOOD_NATIVE, ROBINHOOD_CHAIN_ID } from '../../public/robinhood-launch-catalog.mjs';

const ALL_ERRORS = [...ABI.factory, ...ABI.router, ...ABI.engine, ...ABI.escrow, ...ABI.locker, ...ABI.payouts, ...ABI.token].filter(e => e.type === 'error');
/** The PoolManager's `_pools` mapping slot (v4-core: slot 6); a pool's state starts at keccak256(id ‖ 6), its liquidity three slots on. */
const POOLS_SLOT = 6n;
const poolStateSlot = poolId => keccakHex(Buffer.from(lower(poolId).slice(2).padStart(64, '0') + POOLS_SLOT.toString(16).padStart(64, '0'), 'hex'));
const isNative = asset => !asset || /^0x0{40}$/i.test(asset);
const lower = value => String(value || '').toLowerCase();

/** Explains a revert the way an operator can read it: the custom error's name and arguments. */
export function revertText(error) {
  const revert = error?.revert || (error?.revertData ? decodeRevert(error.revertData, ALL_ERRORS) : null);
  if (!revert) return error?.rpcReason || error?.message || 'reverted';
  const args = Object.entries(revert.args || {}).map(([k, v]) => `${k}=${typeof v === 'bigint' ? v.toString() : v}`).join(', ');
  return `${revert.name}${args ? `(${args})` : ''}`;
}

export class RobinhoodLaunchChain {
  /**
   * @param {object} options {rpc: EvmRpc, addresses: {factory, escrow, locker, engine, payouts}, policy, log, clock}
   */
  constructor({ rpc, addresses, policy, log = () => {}, clock = () => Date.now() }) {
    for (const key of ['factory', 'escrow', 'locker', 'engine', 'payouts', 'router', 'poolManager']) if (!isAddress(String(addresses?.[key] || ''))) throw Error(`Robinhood launch: the ${key} address is not set.`);
    this.rpc = rpc; this.addresses = addresses; this.policy = policy; this.log = log; this.clock = clock;
  }

  static fromEnv({ rpcUrl, addresses, policy, log, requestsPerSecond = 15, insecure = false }) {
    const rpc = new EvmRpc({ url: rpcUrl, chainId: ROBINHOOD_CHAIN_ID, requestsPerSecond, log, insecure });
    return new RobinhoodLaunchChain({ rpc, addresses, policy, log });
  }

  // ------------------------------------------------------------------ reads

  read(address, abi, functionName, args = []) { return this.rpc.read({ address, abi, functionName, args }); }

  async blockNumber() { return Number(await this.rpc.blockNumber()); }
  async chainId() { return Number(await this.rpc.chainId()); }

  /** The factory as deployed: owner, switches, fee, recipients and the launch config the policy expects. */
  async factoryState(configId = 1n) {
    const f = this.addresses.factory, abi = ABI.factory;
    const [owner, pendingOwner, launchesOpen, launchFee, platformRecipient, locker, router, escrow, poolManager, ruleEngine, tokenDeployer, payoutsCode, config] = await Promise.all([
      this.read(f, abi, 'owner'), this.read(f, abi, 'pendingOwner').catch(() => null), this.read(f, abi, 'launchesOpen'), this.read(f, abi, 'launchFee'), this.read(f, abi, 'platformRecipient'),
      this.read(f, abi, 'locker'), this.read(f, abi, 'router'), this.read(f, abi, 'escrow'), this.read(f, abi, 'poolManager'), this.read(f, abi, 'ruleEngine'), this.read(f, abi, 'tokenDeployer'),
      this.rpc.getCode(this.addresses.payouts), this.read(f, abi, 'launchConfigs', [configId]),
    ]);
    return {
      owner, pendingOwner, launchesOpen, launchFee, platformRecipient, locker, router, escrow, poolManager, ruleEngine, tokenDeployer, payoutsDeployed: payoutsCode && payoutsCode !== '0x',
      config: { totalSupply: config.totalSupply, curveProtocolFeeBps: Number(config.curveProtocolFeeBps), curveCreatorFeeBps: Number(config.curveCreatorFeeBps), poolProtocolFeeBps: Number(config.poolProtocolFeeBps), poolCreatorFeeBps: Number(config.poolCreatorFeeBps), taxPlatformShareBps: Number(config.taxPlatformShareBps), minTaxBps: Number(config.minTaxBps), maxTaxBps: Number(config.maxTaxBps), tickSpacing: Number(config.tickSpacing), minRatioBps: Number(config.minRatioBps), maxRatioBps: Number(config.maxRatioBps), enabled: config.enabled },
    };
  }

  async pairAsset(address) {
    const p = await this.read(this.addresses.factory, ABI.factory, 'pairAssets', [address]);
    return { approved: p.approved, virtualQuote: p.virtualQuote, graduationQuote: p.graduationQuote, minGraduationQuote: p.minGraduationQuote, maxGraduationQuote: p.maxGraduationQuote };
  }
  /** Many pairs' on-chain state in batched requests (50 reads per HTTP request), in the order given. */
  async pairAssets(addresses) {
    const item = abiItem(ABI.factory, 'pairAssets'), out = [];
    for (let i = 0; i < addresses.length; i += 50) {
      const slice = addresses.slice(i, i + 50);
      const results = await this.rpc.batch(slice.map(address => ({ method: 'eth_call', params: [{ to: this.addresses.factory, data: encodeCall(item, [address]) }, 'latest'] })));
      for (const raw of results) { const p = decodeResult(item, raw); out.push({ approved: p.approved, virtualQuote: p.virtualQuote, graduationQuote: p.graduationQuote, minGraduationQuote: p.minGraduationQuote, maxGraduationQuote: p.maxGraduationQuote }); }
    }
    return out;
  }

  async predictToken({ name, symbol, metadataURI, configId = 1n, pairToken, virtualQuote, graduationQuote, salt }) {
    return this.read(this.addresses.factory, ABI.factory, 'predictToken', [name, symbol, metadataURI, configId, pairToken, virtualQuote, graduationQuote, salt]);
  }

  /**
   * A launched coin's pool (v71.41): the locker's record (the pool it trades in now, its positions, the curve's ticks),
   * the pool's live price, tick and active liquidity (slot0 and the liquidity slot through `extsload`), its progress
   * and whether it crossed the graduation tick, in one batched request — two when the coin has moved into its
   * graduation pool since `poolId` was recorded.
   */
  async poolState(token, poolId) {
    const lockerAbi = ABI.locker, locker = this.addresses.locker, pm = this.addresses.poolManager;
    const slots = id => { const stateSlot = poolStateSlot(id); return [stateSlot, '0x' + (hexToBigInt(stateSlot) + 3n).toString(16).padStart(64, '0')]; };
    const [stateSlot, liquiditySlot] = slots(poolId);
    const calls = [
      { to: locker, item: abiItem(lockerAbi, 'launchOf'), args: [token] },
      { to: locker, item: abiItem(lockerAbi, 'progressBps'), args: [token] },
      { to: locker, item: abiItem(lockerAbi, 'crossed'), args: [token] },
      { to: pm, item: abiItem(ABI.poolManager, 'extsload'), args: [stateSlot] },
      { to: pm, item: abiItem(ABI.poolManager, 'extsload'), args: [liquiditySlot] },
    ];
    let results = await this.rpc.batch(calls.map(c => ({ method: 'eth_call', params: [{ to: c.to, data: encodeCall(c.item, c.args) }, 'latest'] })));
    const l = decodeResult(calls[0].item, results[0]), progress = decodeResult(calls[1].item, results[1]), crossed = decodeResult(calls[2].item, results[2]);
    let slot0 = hexToBigInt(decodeResult(calls[3].item, results[3])), liquidityWord = hexToBigInt(decodeResult(calls[4].item, results[4]));
    if (lower(l.poolId) !== lower(poolId)) {
      // The coin graduated into its graduation pool: read that pool's state instead.
      const [s2, l2] = slots(l.poolId);
      const more = await this.rpc.batch([s2, l2].map(slot => ({ method: 'eth_call', params: [{ to: pm, data: encodeCall(abiItem(ABI.poolManager, 'extsload'), [slot]) }, 'latest'] })));
      slot0 = hexToBigInt(decodeResult(abiItem(ABI.poolManager, 'extsload'), more[0])); liquidityWord = hexToBigInt(decodeResult(abiItem(ABI.poolManager, 'extsload'), more[1]));
    }
    const sqrtPriceX96 = slot0 & ((1n << 160n) - 1n), tickRaw = (slot0 >> 160n) & 0xffffffn;
    const tick = Number(tickRaw >= 0x800000n ? tickRaw - 0x1000000n : tickRaw);
    const positions = (l.positions || []).map(p => ({ tickLower: Number(p.tickLower), tickUpper: Number(p.tickUpper), liquidity: p.liquidity }));
    const graduated = Number(l.graduatedAt) > 0;
    return {
      poolId: l.poolId, curvePoolId: l.curvePoolId, tokenIs0: l.tokenIs0, startTick: Number(l.startTick), graduationTick: Number(l.graduationTick), lockedAt: Number(l.lockedAt), graduatedAt: Number(l.graduatedAt),
      positions, curve: graduated ? null : positions[0] || null, upper: graduated ? null : positions[1] || null,
      key: { currency0: l.key.currency0, currency1: l.key.currency1, fee: Number(l.key.fee), tickSpacing: Number(l.key.tickSpacing) }, graduationFee: Number(l.graduationFee),
      sqrtPriceX96, tick, liquidity: liquidityWord & ((1n << 128n) - 1n), progressBps: Number(progress), crossed: !!crossed, graduated,
    };
  }

  async launchRecord(token) {
    const l = await this.read(this.addresses.factory, ABI.factory, 'launches', [token]);
    return { creator: l.creator, creatorFeeRecipient: l.creatorFeeRecipient, pairToken: l.pairToken, configId: l.configId, createdAt: Number(l.createdAt), graduatedAt: Number(l.graduatedAt), curvePoolId: l.curvePoolId, poolId: l.poolId, curveFee: Number(l.curveFee), poolFee: Number(l.poolFee), tickSpacing: Number(l.tickSpacing), startTick: Number(l.startTick), graduationTick: Number(l.graduationTick), taxBps: Number(l.taxBps), curveShareBps: Number(l.curveShareBps), poolShareBps: Number(l.poolShareBps) };
  }

  /** The fee numbers a launch with this tax gets (both pools' fees in pips and the platform's share of each stage). */
  async feesFor(configId, taxBps) {
    const f = await this.read(this.addresses.factory, ABI.factory, 'feesFor', [configId, taxBps]);
    return { curveFee: Number(f.curveFee), poolFee: Number(f.poolFee), curveShareBps: Number(f.curveShareBps), poolShareBps: Number(f.poolShareBps) };
  }

  /** What `collect` would credit right now (a dry run): the pair asset and the coins it would sell; both 0 = nothing to collect. */
  async collectable(token) {
    const item = abiItem(ABI.locker, 'collect');
    try { const raw = await this.rpc.call({ to: this.addresses.locker, data: encodeCall(item, [token]) }); const r = decodeResult(item, raw); return { quote: r.quote, coinsSold: r.coinsSold }; } catch { return { quote: 0n, coinsSold: 0n }; }
  }

  async escrowBalance(recipient, asset) {
    return isNative(asset) ? this.read(this.addresses.escrow, ABI.escrow, 'balanceOf', [recipient]) : this.read(this.addresses.escrow, ABI.escrow, 'balanceOfToken', [recipient, asset]);
  }

  async ethBalance(address) { return this.rpc.getBalance(address); }
  /** Many wallets' ETH in batched requests (50 per HTTP request), in the order given. */
  async ethBalances(addresses) {
    const out = [];
    for (let i = 0; i < addresses.length; i += 50) {
      const results = await this.rpc.batch(addresses.slice(i, i + 50).map(address => ({ method: 'eth_getBalance', params: [address, 'latest'] })));
      for (const hex of results) out.push(BigInt(hex));
    }
    return out;
  }
  async tokenBalance(token, owner) { return this.read(token, ABI.erc20, 'balanceOf', [owner]); }
  async assetBalance(asset, owner) { return isNative(asset) ? this.ethBalance(owner) : this.tokenBalance(asset, owner); }
  async tokenMeta(token) {
    const [symbol, decimals] = await Promise.all([this.read(token, ABI.erc20, 'symbol').catch(() => ''), this.read(token, ABI.erc20, 'decimals').catch(() => null)]);
    return { symbol, decimals: decimals == null ? null : Number(decimals) };
  }
  async allowance(token, owner, spender) { return this.read(token, ABI.erc20, 'allowance', [owner, spender]); }
  async isContract(address) { const code = await this.rpc.getCode(address); return !!code && code !== '0x'; }
  async feeData() { return this.rpc.feeData(); }
  async pendingNonce(wallet) { return this.rpc.getTransactionCount(wallet, 'pending'); }
  async minedNonce(wallet) { return this.rpc.getTransactionCount(wallet, 'latest'); }

  // ------------------------------------------------------------------ transactions

  /**
   * Builds and signs one transaction from `key` (the per-coin wallet's secret). Gas is estimated on chain (a revert
   * surfaces as a readable error), priced from live fees with the policy's head room, and the signed bytes, hash and
   * nonce come back for the journal. `nonce` is the service's choice (chain pending vs. journal).
   */
  async prepare({ key, kind, launchId, to, data = '0x', value = 0n, nonce, gasLimit = null, fees = null, expected = {} }) {
    const from = privateKeyToAddress(key);
    const feeData = fees || await this.rpc.feeData();
    const floor = BigInt(this.policy.gas.minimumGasPriceWei);
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas, maxFeePerGas = feeData.maxFeePerGas > floor ? feeData.maxFeePerGas : floor;
    let gas;
    if (gasLimit != null) gas = BigInt(gasLimit);
    else {
      try { gas = await this.rpc.estimateGas({ from, to, data, value }, ALL_ERRORS); } catch (error) {
        throw Object.assign(Error(`${kind}: ${revertText(error)}`), { code: 'ROBINHOOD_LAUNCH_SIMULATION', cause: error, revert: error?.revert || null });
      }
      gas = gas * BigInt(this.policy.gas.feeHeadroomBps) / 10000n;
    }
    const signed = signTransaction({ chainId: ROBINHOOD_CHAIN_ID, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data }, key);
    return { kind, launchId, wallet: from, hash: signed.hash, raw: signed.raw, nonce, gas, maxFee: maxFeePerGas, expected: { ...expected, to, value: String(value), data: data.length > 10 ? data.slice(0, 10) : data } };
  }

  /** Re-signs an unmined operation (from its saved bytes) with the same nonce and higher fees; the old hash becomes void. */
  async bump({ key, op, factorBps = 13000 }) {
    const previous = parseTransaction(op.raw);
    if (previous.from.toLowerCase() !== privateKeyToAddress(key).toLowerCase()) throw Error('The key does not match the operation’s wallet.');
    const feeData = await this.rpc.feeData();
    const bumped = previous.maxFeePerGas * BigInt(factorBps) / 10000n + 1n;
    const maxFeePerGas = feeData.maxFeePerGas > bumped ? feeData.maxFeePerGas : bumped;
    const priorityBumped = previous.maxPriorityFeePerGas * BigInt(factorBps) / 10000n + 1n;
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas > priorityBumped ? feeData.maxPriorityFeePerGas : priorityBumped;
    const signed = signTransaction({ chainId: previous.chainId, nonce: previous.nonce, maxPriorityFeePerGas, maxFeePerGas: maxFeePerGas > maxPriorityFeePerGas ? maxFeePerGas : maxPriorityFeePerGas + 1n, gas: previous.gas, to: previous.to, value: previous.value, data: previous.data }, key);
    return { hash: signed.hash, raw: signed.raw, maxFee: maxFeePerGas };
  }

  /** Broadcasts signed bytes. A node that already knows the transaction, or sees its nonce as spent, is not an error here. */
  async broadcast(raw) {
    try { return await this.rpc.sendRawTransaction(raw); } catch (error) {
      const reason = lower(error?.rpcReason || error?.message);
      if (/already known|already imported|known transaction|nonce too low|replacement transaction underpriced/.test(reason)) return null;
      throw error;
    }
  }

  async receipt(hash) {
    const r = await this.rpc.getTransactionReceipt(hash);
    if (!r) return null;
    return { hash: r.transactionHash, status: r.status === '0x1', blockNumber: Number(hexToBigInt(r.blockNumber)), gasUsed: hexToBigInt(r.gasUsed), effectiveGasPrice: hexToBigInt(r.effectiveGasPrice || '0x0'), logs: r.logs || [], from: r.from, to: r.to, contractAddress: r.contractAddress || null };
  }

  /**
   * Where an operation stands: pending (no receipt, nonce not yet spent), confirmed / failed (a receipt with enough
   * confirmations; failed = reverted), replaced (the nonce was spent by another transaction), unknown (RPC trouble).
   */
  async txState(op, { confirmations = this.policy.launch.confirmations } = {}) {
    const receipt = await this.receipt(op.hash);
    if (receipt) {
      const head = await this.blockNumber();
      const depth = head - receipt.blockNumber + 1;
      if (depth < confirmations) return { state: 'pending', receipt, confirmations: depth };
      return { state: receipt.status ? 'confirmed' : 'failed', receipt, confirmations: depth };
    }
    const mined = await this.minedNonce(op.wallet);
    if (op.nonce != null && mined > op.nonce) {
      // The nonce is spent without our hash: another transaction took it (a replacement of ours, or a stray send).
      const again = await this.receipt(op.hash);
      if (again) return this.txState(op, { confirmations });
      return { state: 'replaced', receipt: null, confirmations: 0 };
    }
    return { state: 'pending', receipt: null, confirmations: 0 };
  }

  /** A deposit's proof: the transaction, who sent it, where, how much; null while it is not mined. */
  async transactionProof(hash) {
    const [tx, receipt] = await Promise.all([this.rpc.getTransaction(hash), this.receipt(hash)]);
    if (!tx || !receipt) return null;
    return { hash, from: tx.from, to: tx.to, value: hexToBigInt(tx.value || '0x0'), input: tx.input || '0x', status: receipt.status, blockNumber: receipt.blockNumber, logs: receipt.logs };
  }

  // ------------------------------------------------------------------ logs and events

  decodeLaunched(receipt) {
    for (const log of receipt?.logs || []) { if (lower(log.address) !== lower(this.addresses.factory)) continue; const decoded = decodeLog(abiItem(ABI.factory, 'Launched', 'event'), log); if (decoded) return { ...decoded.args, logIndex: Number(hexToBigInt(log.logIndex || '0x0')) }; }
    return null;
  }
  /** The locker's Graduated event for `token` in a receipt. */
  decodeGraduated(receipt, token) {
    for (const log of receipt?.logs || []) { if (lower(log.address) !== lower(this.addresses.locker)) continue; const decoded = decodeLog(abiItem(ABI.locker, 'Graduated', 'event'), log); if (decoded && (!token || lower(decoded.args.token) === lower(token))) return decoded.args; }
    return null;
  }
  /** The router's Swapped events (the site's own trades carry the payer and the recipient). */
  decodeSwapped(logs, token) {
    const item = abiItem(ABI.router, 'Swapped', 'event'), out = [];
    for (const log of logs || []) { if (lower(log.address) !== lower(this.addresses.router)) continue; const d = decodeLog(item, log); if (d && (!token || lower(d.args.token) === lower(token))) out.push({ token: d.args.token, payer: d.args.payer, recipient: d.args.recipient, buy: d.args.buy, quote: d.args.quoteAmount, tokens: d.args.tokenAmount, sqrtPriceX96: d.args.sqrtPriceX96After, tick: Number(d.args.tickAfter), txHash: log.transactionHash, logIndex: Number(hexToBigInt(log.logIndex || '0x0')), block: Number(hexToBigInt(log.blockNumber || '0x0')) }); }
    return out;
  }
  decodeTransfers(logs, token) {
    const item = abiItem(ABI.erc20, 'Transfer', 'event'), out = [];
    for (const log of logs || []) { if (token && lower(log.address) !== lower(token)) continue; const d = decodeLog(item, log); if (d) out.push({ from: d.args.from, to: d.args.to, value: d.args.value, txHash: log.transactionHash, logIndex: Number(hexToBigInt(log.logIndex || '0x0')), block: Number(hexToBigInt(log.blockNumber || '0x0')) }); }
    return out;
  }
  /**
   * The pool's Swap events as trades of the coin. `pools` maps a lowercase pool id → { token, tokenIs0 }: the coin's
   * side of the swap delta says whether it was bought (coins left the pool: a positive delta for the swapper) or
   * sold. The swapper in the event is the router; the wallet behind it is found from the coin's Transfer in the same
   * transaction (`attribute`), the router's Swapped event, or falls back to the sender.
   */
  decodeTrades(logs, pools) {
    const item = abiItem(ABI.poolManager, 'Swap', 'event'), out = [];
    for (const log of logs || []) {
      if (lower(log.address) !== lower(this.addresses.poolManager)) continue;
      const d = decodeLog(item, log); if (!d) continue;
      const pool = pools?.get?.(lower(d.args.id)) || pools?.[lower(d.args.id)]; if (!pool) continue;
      const coinDelta = pool.tokenIs0 ? d.args.amount0 : d.args.amount1, quoteDelta = pool.tokenIs0 ? d.args.amount1 : d.args.amount0;
      if (coinDelta === 0n && quoteDelta === 0n) continue; // a swap that moved nothing: the graduation setting an empty pool's price
      const buy = coinDelta > 0n;
      out.push({ side: buy ? 'buy' : 'sell', token: pool.token, poolId: d.args.id, wallet: d.args.sender, payer: d.args.sender, attributed: false, quote: quoteDelta < 0n ? -quoteDelta : quoteDelta, tokens: coinDelta < 0n ? -coinDelta : coinDelta, feePips: Number(d.args.fee), sqrtPriceX96: d.args.sqrtPriceX96, tick: Number(d.args.tick), liquidity: d.args.liquidity, txHash: log.transactionHash, logIndex: Number(hexToBigInt(log.logIndex || '0x0')), block: Number(hexToBigInt(log.blockNumber || '0x0')) });
    }
    return out;
  }
  /** Names the wallet behind each trade from the coin's Transfer logs of the same transaction (the pool manager's counterparty). */
  attributeTrades(trades, transfers) {
    const pm = lower(this.addresses.poolManager), byTx = new Map();
    for (const t of transfers || []) { const list = byTx.get(lower(t.txHash)) || []; list.push(t); byTx.set(lower(t.txHash), list); }
    for (const trade of trades) {
      const list = byTx.get(lower(trade.txHash)) || [];
      const match = list.find(t => trade.side === 'buy' ? lower(t.from) === pm && t.value === trade.tokens : lower(t.to) === pm && t.value === trade.tokens)
        || list.find(t => trade.side === 'buy' ? lower(t.from) === pm : lower(t.to) === pm);
      if (match) { trade.wallet = trade.side === 'buy' ? match.to : match.from; trade.attributed = true; }
    }
    return trades;
  }
  /** The escrow's Claimed events in a receipt for `recipient`: what a claim actually moved. */
  decodeClaims(logs, recipient) {
    const item = abiItem(ABI.escrow, 'Claimed', 'event'), out = [];
    for (const log of logs || []) { if (lower(log.address) !== lower(this.addresses.escrow)) continue; const d = decodeLog(item, log); if (d && (!recipient || lower(d.args.recipient) === lower(recipient))) out.push({ recipient: d.args.recipient, asset: d.args.asset, amount: d.args.amount, to: d.args.to, txHash: log.transactionHash, logIndex: Number(hexToBigInt(log.logIndex || '0x0')), block: Number(hexToBigInt(log.blockNumber || '0x0')) }); }
    return out;
  }
  decodeCredits(logs, recipient) {
    const item = abiItem(ABI.escrow, 'Credited', 'event'), out = [];
    for (const log of logs || []) { if (lower(log.address) !== lower(this.addresses.escrow)) continue; const d = decodeLog(item, log); if (d && (!recipient || lower(d.args.recipient) === lower(recipient))) out.push({ recipient: d.args.recipient, asset: d.args.asset, amount: d.args.amount, from: d.args.from, txHash: log.transactionHash, logIndex: Number(hexToBigInt(log.logIndex || '0x0')), block: Number(hexToBigInt(log.blockNumber || '0x0')) }); }
    return out;
  }
  decodeFeesCollected(receipt, token) {
    for (const log of receipt?.logs || []) { if (lower(log.address) !== lower(this.addresses.locker)) continue; const d = decodeLog(abiItem(ABI.locker, 'FeesCollected', 'event'), log); if (d && lower(d.args.token) === lower(token)) return d.args; }
    return null;
  }
  decodePayouts(receipt) {
    const paid = abiItem(ABI.payouts, 'Paid', 'event'), skipped = abiItem(ABI.payouts, 'PayoutSkipped', 'event');
    const out = { paid: null, skipped: [] };
    for (const log of receipt?.logs || []) { if (lower(log.address) !== lower(this.addresses.payouts)) continue; const p = decodeLog(paid, log); if (p) { out.paid = p.args; continue; } const s = decodeLog(skipped, log); if (s) out.skipped.push(s.args); }
    return out;
  }

  async transferLogs(token, fromBlock, toBlock) {
    const logs = await this.rpc.getLogs({ address: token, topics: [topicOf(abiItem(ABI.erc20, 'Transfer', 'event'))], fromBlock, toBlock });
    return this.decodeTransfers(logs, token);
  }
  /** One pool's Swap logs as trades (the wallet attributed from `transfers` when given). */
  async tradeLogs(pool, fromBlock, toBlock, transfers = null) {
    const logs = await this.rpc.getLogs({ address: this.addresses.poolManager, topics: [topicOf(abiItem(ABI.poolManager, 'Swap', 'event')), '0x' + lower(pool.poolId).slice(2).padStart(64, '0')], fromBlock, toBlock });
    const trades = this.decodeTrades(logs, new Map([[lower(pool.poolId), pool]]));
    return transfers ? this.attributeTrades(trades, transfers) : trades;
  }
  /** The Transfer logs of many tokens in one request; each row carries its `address` so the caller can split them. */
  async transferLogsOf(tokens, fromBlock, toBlock) {
    if (!tokens.length) return [];
    const logs = await this.rpc.getLogs({ address: tokens.length === 1 ? tokens[0] : tokens, topics: [topicOf(abiItem(ABI.erc20, 'Transfer', 'event'))], fromBlock, toBlock });
    const wanted = new Set(tokens.map(lower)), out = [];
    for (const log of logs) { if (!wanted.has(lower(log.address))) continue; const [row] = this.decodeTransfers([log], null); if (row) out.push({ ...row, address: log.address }); }
    return out;
  }
  /** The Swap logs of many pools in one request (the pool ids as the event's indexed topic); each row carries its `address` (the coin). */
  async tradeLogsOf(pools, fromBlock, toBlock) {
    if (!pools.length) return [];
    const ids = pools.map(p => '0x' + lower(p.poolId).slice(2).padStart(64, '0'));
    const logs = await this.rpc.getLogs({ address: this.addresses.poolManager, topics: [topicOf(abiItem(ABI.poolManager, 'Swap', 'event')), ids.length === 1 ? ids[0] : ids], fromBlock, toBlock });
    const map = new Map(pools.map(p => [lower(p.poolId), p]));
    return this.decodeTrades(logs, map).map(row => ({ ...row, address: row.token }));
  }
  async creditLogs(recipient, fromBlock, toBlock) {
    const topic = topicOf(abiItem(ABI.escrow, 'Credited', 'event')), who = '0x' + lower(recipient).slice(2).padStart(64, '0');
    const logs = await this.rpc.getLogs({ address: this.addresses.escrow, topics: [topic, who], fromBlock, toBlock });
    return this.decodeCredits(logs, recipient);
  }
  async blockTimestamp(number) { const block = await this.rpc.getBlock(number); return block ? Number(hexToBigInt(block.timestamp)) * 1000 : null; }

  // ------------------------------------------------------------------ call data

  launchData(params) { return encodeCall(abiItem(ABI.factory, 'launch'), [params]); }
  approveData(spender, amount) { return encodeCall(abiItem(ABI.erc20, 'approve'), [spender, amount]); }
  transferData(to, amount) { return encodeCall(abiItem(ABI.erc20, 'transfer'), [to, amount]); }
  claimAllData(to) { return encodeCall(abiItem(ABI.escrow, 'claimAll'), [to]); }
  claimAllTokenData(token, to) { return encodeCall(abiItem(ABI.escrow, 'claimAllToken'), [token, to]); }
  collectData(token) { return encodeCall(abiItem(ABI.locker, 'collect'), [token]); }
  graduateData(token) { return encodeCall(abiItem(ABI.locker, 'graduate'), [token]); }
  buyData(token, quoteIn, minTokensOut, recipient, deadline) { return encodeCall(abiItem(ABI.router, 'buy'), [token, quoteIn, minTokensOut, recipient, deadline]); }
  sellData(token, tokensIn, minQuoteOut, recipient, deadline) { return encodeCall(abiItem(ABI.router, 'sell'), [token, tokensIn, minQuoteOut, recipient, deadline]); }
  payEthData(to, amounts) { return encodeCall(abiItem(ABI.payouts, 'payEth'), [to, amounts]); }
  payTokenData(token, to, amounts) { return encodeCall(abiItem(ABI.payouts, 'payToken'), [token, to, amounts]); }
  setPairAssetsData(pairTokens, assets) { return encodeCall(abiItem(ABI.factory, 'setPairAssets'), [pairTokens, assets]); }
  setLaunchesOpenData(open) { return encodeCall(abiItem(ABI.factory, 'setLaunchesOpen'), [open]); }
  setLaunchFeeData(fee) { return encodeCall(abiItem(ABI.factory, 'setLaunchFee'), [fee]); }
  setPlatformRecipientData(recipient) { return encodeCall(abiItem(ABI.factory, 'setPlatformRecipient'), [recipient]); }
  acceptOwnershipData() { return encodeCall(abiItem(ABI.factory, 'acceptOwnership'), []); }
}

export { ALL_ERRORS, isNative, toQuantity, RpcError };
