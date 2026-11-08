// Robinhood launch service over a scripted chain: every state the worker moves a launch through, with the chain's
// answers chosen by the test (a stalled transaction, a spent nonce, a reverting launch, a refusing recipient, a missed
// deadline). The real contracts are exercised by test/robinhood-launch-anvil.integration.mjs; this file is about the
// service's own decisions, journal and ledgers, with real keys and signing left to the adapter's shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { RobinhoodLaunchService } from '../src/robinhood-launch/service.mjs';
import { ROBINHOOD_LAUNCH_POLICY } from '../src/robinhood-launch/policy.mjs';
import { ROBINHOOD_NATIVE } from '../public/robinhood-launch-catalog.mjs';
import { plannedSupply } from '../public/robinhood-curve-math.mjs';
import { planPositions, quoteSwap, curveNumbers, tickAtSqrtPrice, graduationPositions } from '../public/robinhood-pool-math.mjs';
import { privateKeyToAddress } from '../src/evm/secp256k1.mjs';
import { encodeCall, abiItem, decodeParams, selectorOf as abiSelector } from '../src/evm/abi.mjs';
import { ABI } from '../src/robinhood-launch/abi.mjs';
import { parseEther, bytesToHex } from '../src/evm/hex.mjs';

const lower = v => String(v || '').toLowerCase();
const sha = v => createHash('sha256').update(v).digest('hex');
const addr = seed => '0x' + sha('addr:' + seed).slice(0, 40);
const hash32 = () => '0x' + randomBytes(32).toString('hex');
const GAS_PRICE = 10000000n, GAS_USED = 50000n;
const POOL_MANAGER = addr('pool-manager'), USDG = addr('usdg');
const ADDRESSES = { factory: addr('factory'), escrow: addr('escrow'), locker: addr('locker'), engine: addr('engine'), payouts: addr('payouts'), router: addr('router'), poolManager: POOL_MANAGER };
const IMAGE = '/token-images/' + 'b'.repeat(64) + '.png';

class FakeHostStore { constructor() { this.docs = new Map(); } async read(name, fallback) { return this.docs.has(name) ? JSON.parse(JSON.stringify(this.docs.get(name))) : fallback; } async write(name, doc) { this.docs.set(name, JSON.parse(JSON.stringify(doc))); } }

/** The chain the service talks to, scripted: balances, escrow, curves, a mempool mined by the test. */
class FakeChain {
  constructor() {
    this.block = 100; this.eth = new Map(); this.tokens = new Map(); this.escrow = new Map(); this.allowances = new Map();
    this.mined = new Map(); this.txs = new Map(); this.mempool = []; this.logs = []; this.pools = new Map(); this.launchRecords = new Map();
    this.stall = new Set(); this.revert = new Set(); this.refuse = new Set(); this.simulationError = null; this.sent = [];
    this.factory = { owner: addr('deployer'), pendingOwner: ROBINHOOD_NATIVE, launchesOpen: true, launchFee: parseEther('0.001'), platformRecipient: addr('deployer'), locker: ADDRESSES.locker, router: ADDRESSES.router, escrow: ADDRESSES.escrow, poolManager: POOL_MANAGER, ruleEngine: ADDRESSES.engine, tokenDeployer: addr('token-deployer'), payoutsDeployed: true,
      config: { totalSupply: BigInt(ROBINHOOD_LAUNCH_POLICY.config.totalSupply), ...Object.fromEntries(['curveProtocolFeeBps', 'curveCreatorFeeBps', 'poolProtocolFeeBps', 'poolCreatorFeeBps', 'taxPlatformShareBps', 'minTaxBps', 'maxTaxBps'].map(k => [k, ROBINHOOD_LAUNCH_POLICY.config[k]])), tickSpacing: 10, minRatioBps: 2000, maxRatioBps: 100000, enabled: true } };
    this.pairs = new Map([[ROBINHOOD_NATIVE, { approved: true, virtualQuote: parseEther('8'), graduationQuote: parseEther('5'), minGraduationQuote: parseEther('0.1'), maxGraduationQuote: parseEther('100') }], [lower(USDG), { approved: true, virtualQuote: 33333n * 10n ** 6n, graduationQuote: 19371n * 10n ** 6n, minGraduationQuote: 1000n * 10n ** 6n, maxGraduationQuote: 200000n * 10n ** 6n }]]);
  }
  key(recipient, asset) { return lower(recipient) + '|' + (asset ? lower(asset) : ROBINHOOD_NATIVE); }
  fund(address, wei) { this.eth.set(lower(address), (this.eth.get(lower(address)) || 0n) + wei); }
  balanceOf(address) { return this.eth.get(lower(address)) || 0n; }
  tokenOf(token) { if (!this.tokens.has(lower(token))) this.tokens.set(lower(token), new Map()); return this.tokens.get(lower(token)); }
  tokenBalanceOf(token, owner) { return this.tokenOf(token).get(lower(owner)) || 0n; }
  moveEth(from, to, wei) { if (this.balanceOf(from) < wei) throw Error(`insufficient ETH on ${from}`); this.eth.set(lower(from), this.balanceOf(from) - wei); this.fund(to, wei); }
  mint(token, to, amount) { const t = this.tokenOf(token); t.set(lower(to), (t.get(lower(to)) || 0n) + amount); this.logs.push({ kind: 'transfer', address: lower(token), from: ROBINHOOD_NATIVE, to, value: amount, txHash: this.currentTx || hash32(), logIndex: this.logs.length, block: this.block }); }
  moveToken(token, from, to, amount) { const t = this.tokenOf(token); if ((t.get(lower(from)) || 0n) < amount) throw Error('insufficient tokens'); t.set(lower(from), t.get(lower(from)) - amount); t.set(lower(to), (t.get(lower(to)) || 0n) + amount); this.logs.push({ kind: 'transfer', address: lower(token), from, to, value: amount, txHash: this.currentTx || hash32(), logIndex: this.logs.length, block: this.block }); }
  credit(recipient, asset, amount) { const k = this.key(recipient, asset); this.escrow.set(k, (this.escrow.get(k) || 0n) + amount); }
  /** A scripted buy through the coin's pool: the pool maths price it, coins move from the pool manager to the wallet, the LP fee waits in the pool for `collect`. */
  trade(token, { wallet, quote }, { txHash = hash32(), advance = true } = {}) {
    const pool = this.pools.get(lower(token)); if (!pool) throw Error('no pool for ' + token);
    if (advance) this.block += 1; const saved = this.currentTx, before = this.logs.length; this.currentTx = txHash;
    const q = quoteSwap(pool, { buy: true, amountIn: quote });
    pool.feesQuote += q.fee; pool.sqrtPriceX96 = q.sqrtPriceAfter; pool.tick = tickAtSqrtPrice(q.sqrtPriceAfter);
    this.moveToken(pool.token, POOL_MANAGER, wallet, q.amountOut);
    this.logs.push({ kind: 'trade', address: lower(pool.token), token: pool.token, poolId: pool.poolId, side: 'buy', wallet, payer: ADDRESSES.router, attributed: true, quote: q.amountUsed, tokens: q.amountOut, feePips: pool.fee, sqrtPriceX96: q.sqrtPriceAfter, tick: pool.tick, liquidity: 0n, txHash, logIndex: this.logs.length, block: this.block });
    this.currentTx = saved; return this.logs.slice(before);
  }
  /** A scripted sell: coins back to the pool manager, the pair asset out (the fake credits nothing; the sell's coin fee waits in the pool). */
  sellTrade(token, { wallet, tokens }, { txHash = hash32(), advance = true } = {}) {
    const pool = this.pools.get(lower(token)); if (!pool) throw Error('no pool for ' + token);
    if (advance) this.block += 1; const saved = this.currentTx, before = this.logs.length; this.currentTx = txHash;
    const q = quoteSwap(pool, { buy: false, amountIn: tokens });
    pool.feesCoins += q.fee; pool.sqrtPriceX96 = q.sqrtPriceAfter; pool.tick = tickAtSqrtPrice(q.sqrtPriceAfter);
    this.moveToken(pool.token, wallet, POOL_MANAGER, q.amountUsed);
    this.logs.push({ kind: 'trade', address: lower(pool.token), token: pool.token, poolId: pool.poolId, side: 'sell', wallet, payer: ADDRESSES.router, attributed: true, quote: q.amountOut, tokens: q.amountUsed, feePips: pool.fee, sqrtPriceX96: q.sqrtPriceAfter, tick: pool.tick, liquidity: 0n, txHash, logIndex: this.logs.length, block: this.block });
    this.currentTx = saved; return this.logs.slice(before);
  }
  /** Buys until the price sits past the graduation tick (what graduation takes on the chain). */
  cross(token) { const pool = this.pools.get(lower(token)); const numbers = curveNumbers(pool); const left = numbers.fullRaise - numbers.raised; this.fund(addr('whale'), left * 2n); this.trade(token, { wallet: addr('whale'), quote: left * 10000n / (10000n - BigInt(pool.fee) / 100n) + left / 50n }); }
  crossed(pool) { return pool.tokenIs0 ? pool.tick >= pool.graduationTick : pool.tick < pool.graduationTick; }
  /** An outside transaction (the creator's funding transfer): mined at once, with a proof. */
  outside({ from, to, value, status = true }) { const hash = hash32(); this.block += 1; if (status) this.moveEth(from, to, value); this.txs.set(hash, { hash, from, to, value, status, block: this.block, receipt: { hash, status, blockNumber: this.block, gasUsed: 21000n, effectiveGasPrice: GAS_PRICE, logs: [], from, to } }); return hash; }
  // --- reads ---
  async blockNumber() { return this.block; }
  async factoryState() { return { ...this.factory, config: { ...this.factory.config } }; }
  async pairAsset(address) { return this.pairs.get(lower(address)) || { approved: false, virtualQuote: 0n, graduationQuote: 0n, minGraduationQuote: 0n, maxGraduationQuote: 0n }; }
  async predictToken({ salt }) { return addr('token:' + salt); }
  async poolState(token) {
    this.poolReads = (this.poolReads || 0) + 1;
    const p = this.pools.get(lower(token)); if (!p) throw Error('no pool');
    const n = curveNumbers(p);
    return { poolId: p.poolId, curvePoolId: p.curvePoolId, tokenIs0: p.tokenIs0, startTick: p.startTick, graduationTick: p.graduationTick, lockedAt: 1, graduatedAt: p.graduated ? 2 : 0, curve: p.graduated ? null : { ...p.curve }, upper: p.graduated ? null : { ...p.upper }, positions: (p.positions || [p.curve, p.upper]).map(x => ({ ...x })), graduationFee: p.graduationFee, key: { currency0: p.tokenIs0 ? p.token : p.pairToken, currency1: p.tokenIs0 ? p.pairToken : p.token, fee: p.fee, tickSpacing: p.tickSpacing }, sqrtPriceX96: p.sqrtPriceX96, tick: p.tick, liquidity: (p.positions || [p.curve])[0]?.liquidity || 0n, progressBps: n.progressBps, crossed: this.crossed(p), graduated: p.graduated };
  }
  async launchRecord(token) { return this.launchRecords.get(lower(token)) || null; }
  async collectable(token) { const p = this.pools.get(lower(token)); if (!p) return { quote: 0n, coinsSold: 0n }; return { quote: p.feesQuote + (p.feesCoins > 0n ? quoteSwap(p, { buy: false, amountIn: p.feesCoins }).amountOut : 0n), coinsSold: p.feesCoins }; }
  async escrowBalance(recipient, asset) { return this.escrow.get(this.key(recipient, asset)) || 0n; }
  async ethBalance(address) { return this.balanceOf(address); }
  async tokenBalance(token, owner) { return this.tokenBalanceOf(token, owner); }
  async tokenMeta(token) { return { symbol: 'TKN', decimals: 18 }; }
  async allowance(token, owner, spender) { return this.allowances.get(lower(token) + '|' + lower(owner) + '|' + lower(spender)) || 0n; }
  async feeData() { return { maxFeePerGas: 2n * GAS_PRICE, maxPriorityFeePerGas: 1000000n, baseFee: GAS_PRICE }; }
  async pendingNonce(wallet) { return (this.mined.get(lower(wallet)) || 0) + this.mempool.filter(t => lower(t.from) === lower(wallet)).length; }
  async minedNonce(wallet) { return this.mined.get(lower(wallet)) || 0; }
  // --- transactions ---
  async prepare({ key, kind, launchId, to, data = '0x', value = 0n, nonce, gasLimit = null, expected = {} }) {
    const from = privateKeyToAddress(key);
    if (this.simulationError && kind === 'launch') throw Object.assign(Error(`launch: ${this.simulationError}`), { code: 'ROBINHOOD_LAUNCH_SIMULATION' });
    const tx = { hash: hash32(), from, to, data, value: BigInt(value), nonce, kind, launchId, expected, gas: gasLimit ? BigInt(gasLimit) : 200000n, maxFee: 2n * GAS_PRICE };
    return { kind, launchId, wallet: from, hash: tx.hash, raw: JSON.stringify({ ...tx, value: String(tx.value), gas: String(tx.gas), maxFee: String(tx.maxFee) }), nonce, gas: tx.gas, maxFee: tx.maxFee, expected: { ...expected, to, value: String(value), data: data.length > 10 ? data.slice(0, 10) : data } };
  }
  async bump({ key, op }) { const previous = JSON.parse(op.raw); if (lower(previous.from) !== lower(privateKeyToAddress(key))) throw Error('wrong key'); const bumped = { ...previous, hash: hash32(), maxFee: String(BigInt(previous.maxFee) * 13n / 10n + 1n) }; return { hash: bumped.hash, raw: JSON.stringify(bumped), maxFee: BigInt(bumped.maxFee) }; }
  async broadcast(raw) {
    const tx = JSON.parse(raw); tx.value = BigInt(tx.value); tx.gas = BigInt(tx.gas);
    if (this.txs.has(tx.hash)) return null;
    if (tx.nonce < (this.mined.get(lower(tx.from)) || 0)) return null; // nonce too low
    const same = this.mempool.findIndex(t => lower(t.from) === lower(tx.from) && t.nonce === tx.nonce);
    if (same >= 0) this.mempool.splice(same, 1); // a replacement drops the old bytes
    this.mempool.push(tx); this.sent.push(tx); return tx.hash;
  }
  /** Spends a wallet's next nonce with a transaction of someone else's (a stray send), voiding what waits on it. */
  stray(wallet) { const n = this.mined.get(lower(wallet)) || 0; this.mined.set(lower(wallet), n + 1); this.mempool = this.mempool.filter(t => !(lower(t.from) === lower(wallet) && t.nonce === n)); }
  mine(blocks = 1) {
    for (let b = 0; b < blocks; b++) {
      this.block += 1;
      for (const tx of [...this.mempool].sort((a, b) => a.nonce - b.nonce)) {
        if (this.stall.has(tx.kind)) continue;
        if (tx.nonce !== (this.mined.get(lower(tx.from)) || 0)) continue;
        this.mempool = this.mempool.filter(t => t !== tx); this.mined.set(lower(tx.from), tx.nonce + 1);
        const cost = GAS_USED * GAS_PRICE; this.currentTx = tx.hash;
        const logs = []; let status = true, moved = false;
        try {
          if (this.balanceOf(tx.from) < cost + tx.value) throw Error('insufficient funds');
          this.moveEth(tx.from, ROBINHOOD_NATIVE, cost);
          this.moveEth(tx.from, tx.to, tx.value); moved = true;
          if (this.revert.has(tx.kind)) throw Error('scripted revert');
          this.apply(tx, logs);
        } catch { status = false; if (moved) this.moveEth(tx.to, tx.from, tx.value); }
        this.txs.set(tx.hash, { ...tx, status, block: this.block, receipt: { hash: tx.hash, status, blockNumber: this.block, gasUsed: GAS_USED, effectiveGasPrice: GAS_PRICE, logs, from: tx.from, to: tx.to } });
        this.currentTx = null;
      }
    }
  }
  apply(tx, logs) {
    const selector = tx.data.slice(0, 10), args = item => decodeParams(item.inputs, '0x' + tx.data.slice(10));
    switch (tx.kind) {
      case 'seed': case 'refund': case 'sweep': case 'platform-sweep': break; // plain value transfers
      case 'approve': case 'approve-payouts': { const [spender, amount] = args(abiItem(ABI.erc20, 'approve')); this.allowances.set(lower(tx.to) + '|' + lower(tx.from) + '|' + lower(spender), amount); break; }
      case 'launch': this.launch(tx, logs); break;
      case 'claim': case 'platform-claim': {
        const native = selector === this.selectorOf('claimAll', ABI.escrow), asset = native ? null : args(abiItem(ABI.escrow, 'claimAllToken'))[0];
        const k = this.key(tx.from, asset), amount = this.escrow.get(k) || 0n; this.escrow.set(k, 0n);
        if (native) this.fund(tx.from, amount); else this.tokenOf(asset).set(lower(tx.from), this.tokenBalanceOf(asset, tx.from) + amount);
        logs.push({ kind: 'claim', address: ADDRESSES.escrow, recipient: tx.from, asset: asset || ROBINHOOD_NATIVE, amount, to: tx.from, txHash: tx.hash, logIndex: logs.length, block: this.block });
        break;
      }
      case 'payout': {
        const native = selector === this.selectorOf('payEth', ABI.payouts);
        let token = null, to, amounts;
        if (native) [to, amounts] = args(abiItem(ABI.payouts, 'payEth')); else [token, to, amounts] = args(abiItem(ABI.payouts, 'payToken'));
        let count = 0n, total = 0n;
        to.forEach((recipient, i) => {
          if (this.refuse.has(lower(recipient))) { logs.push({ kind: 'skipped', address: ADDRESSES.payouts, to: recipient, amount: amounts[i] }); if (native) this.moveEth(ADDRESSES.payouts, tx.from, amounts[i]); return; }
          if (native) this.moveEth(ADDRESSES.payouts, recipient, amounts[i]); else this.moveToken(token, tx.from, recipient, amounts[i]);
          count += 1n; total += amounts[i];
        });
        logs.push({ kind: 'paid', address: ADDRESSES.payouts, count, total });
        break;
      }
      case 'graduate': {
        // The locker's graduation: the curve pool's fees collected the curve way, then everything the positions hold moves into
        // the graduation pool at the same price (graduationPositions mirrors the contract), where trades cost the pool fee.
        const [token] = args(abiItem(ABI.locker, 'graduate')); const p = this.pools.get(lower(token)); if (!p || p.graduated || !this.crossed(p)) throw Error('NotCrossed');
        this.collectInto(p, logs);
        const g = graduationPositions(p, { fee: p.graduationFee, tickSpacing: p.tickSpacing });
        Object.assign(p, { positions: g.positions, fee: p.graduationFee, poolId: p.graduationPoolId, platformShareBps: p.poolShareBps, graduated: true, curve: null, upper: null });
        const record = this.launchRecords.get(lower(token)); if (record) { record.graduatedAt = 2; record.poolId = p.graduationPoolId; }
        logs.push({ kind: 'graduated', address: ADDRESSES.locker, token: p.token, curvePoolId: p.curvePoolId, poolId: p.poolId, tick: p.tick, sqrtPriceX96: p.sqrtPriceX96, liquidity: g.positions[0]?.liquidity || 0n });
        break;
      }
      case 'collect': {
        const [token] = args(abiItem(ABI.locker, 'collect')), p = this.pools.get(lower(token)); if (!p) throw Error('UnknownToken');
        this.collectInto(p, logs);
        break;
      }
      case 'owner': case 'pairs': {
        if (selector === this.selectorOf('acceptOwnership')) { if (lower(this.factory.pendingOwner) !== lower(tx.from)) throw Error('not pending'); this.factory.owner = tx.from; this.factory.pendingOwner = ROBINHOOD_NATIVE; }
        else if (lower(this.factory.owner) !== lower(tx.from)) throw Error('not owner');
        else if (selector === this.selectorOf('setPlatformRecipient')) this.factory.platformRecipient = args(abiItem(ABI.factory, 'setPlatformRecipient'))[0];
        else if (selector === this.selectorOf('setLaunchesOpen')) this.factory.launchesOpen = args(abiItem(ABI.factory, 'setLaunchesOpen'))[0];
        else if (selector === this.selectorOf('setLaunchFee')) this.factory.launchFee = args(abiItem(ABI.factory, 'setLaunchFee'))[0];
        else if (selector === this.selectorOf('setPairAssets')) { const [tokens, assets] = args(abiItem(ABI.factory, 'setPairAssets')); tokens.forEach((t, i) => this.pairs.set(lower(t), { ...assets[i] })); }
        break;
      }
      default: break;
    }
  }
  selectorOf(name, abi = ABI.factory) { return bytesToHex(abiSelector(abiItem(abi, name))); }
  /** A collection: the fees waiting in the pool, the coin side sold into it, the split of the stage (`platformShareBps` follows the pool). */
  collectInto(p, logs) {
    let quote = p.feesQuote, coinsSold = 0n;
    if (p.feesCoins > 0n) { const q = quoteSwap(p, { buy: false, amountIn: p.feesCoins }); quote += q.amountOut; coinsSold = q.amountUsed; p.sqrtPriceX96 = q.sqrtPriceAfter; p.tick = tickAtSqrtPrice(q.sqrtPriceAfter); }
    p.feesQuote = 0n; p.feesCoins = 0n;
    const native = lower(p.pairToken) === ROBINHOOD_NATIVE, asset = native ? null : p.pairToken, platform = quote * BigInt(p.platformShareBps) / 10000n;
    this.credit(this.factory.platformRecipient, asset, platform); this.credit(p.creatorFeeRecipient, asset, quote - platform);
    logs.push({ kind: 'fees', address: ADDRESSES.locker, token: p.token, quote, coinsSold, creator: quote - platform, platform });
  }
  launch(tx, logs) {
    const [p] = decodeParams(abiItem(ABI.factory, 'launch').inputs, '0x' + tx.data.slice(10)), native = lower(p.pairToken) === ROBINHOOD_NATIVE;
    if (!this.factory.launchesOpen) throw Error('LaunchesClosed');
    if (!this.pairs.get(lower(p.pairToken))?.approved) throw Error('PairNotApproved');
    if (tx.value < this.factory.launchFee + (native ? p.devBuyQuote : 0n)) throw Error('short value');
    const token = addr('token:' + p.salt), poolId = '0x' + sha('pool:' + p.salt), before = this.logs.length, tokenIs0 = lower(token) < lower(p.pairToken);
    const supply = plannedSupply(this.factory.config.totalSupply, p.virtualQuote, p.graduationQuote);
    const plan = planPositions({ tokenIs0, virtualQuote: p.virtualQuote, graduationQuote: p.graduationQuote, sellSupply: supply.sellSupply, lpSupply: supply.lpSupply, virtualToken: supply.virtualToken, tickSpacing: this.factory.config.tickSpacing });
    this.moveEth(ADDRESSES.factory, this.factory.platformRecipient, this.factory.launchFee);
    if (native) this.moveEth(ADDRESSES.factory, POOL_MANAGER, p.devBuyQuote); else if (p.devBuyQuote > 0n) this.moveToken(p.pairToken, tx.from, POOL_MANAGER, p.devBuyQuote);
    this.mint(token, ADDRESSES.factory, this.factory.config.totalSupply); this.moveToken(token, ADDRESSES.factory, POOL_MANAGER, this.factory.config.totalSupply);
    const c = this.factory.config, tax = Number(p.taxBps), platformTax = Math.floor(tax * c.taxPlatformShareBps / 10000);
    if (tax !== 0 && (tax < c.minTaxBps || tax > c.maxTaxBps)) throw Error('TaxOutOfBounds');
    const curveBps = c.curveProtocolFeeBps + (tax > 0 ? tax : c.curveCreatorFeeBps), poolBps = c.poolProtocolFeeBps + c.poolCreatorFeeBps + tax;
    const fee = curveBps * 100, graduationFee = poolBps * 100, curveShareBps = Math.floor((c.curveProtocolFeeBps + platformTax) * 10000 / curveBps), poolShareBps = Math.floor((c.poolProtocolFeeBps + platformTax) * 10000 / poolBps);
    const graduationPoolId = '0x' + sha('pool2:' + p.salt);
    const pool = { ...plan, token, pairToken: p.pairToken, poolId, curvePoolId: poolId, graduationPoolId, fee, graduationFee, tickSpacing: this.factory.config.tickSpacing, positions: [plan.curve, plan.upper], creator: p.creator, creatorFeeRecipient: p.creatorFeeRecipient, taxBps: tax, curveShareBps, poolShareBps, platformShareBps: curveShareBps, feesQuote: 0n, feesCoins: 0n, graduated: false };
    this.pools.set(lower(token), pool);
    this.launchRecords.set(lower(token), { creator: p.creator, creatorFeeRecipient: p.creatorFeeRecipient, pairToken: p.pairToken, configId: p.configId, createdAt: 1, graduatedAt: 0, curvePoolId: poolId, poolId, curveFee: fee, poolFee: graduationFee, tickSpacing: plan.tickSpacing, startTick: plan.startTick, graduationTick: plan.graduationTick, taxBps: tax, curveShareBps, poolShareBps });
    logs.push(...this.logs.slice(before), { kind: 'launched', address: ADDRESSES.factory, token, poolId, graduationPoolId, creator: p.creator, pairToken: p.pairToken, startTick: plan.startTick, graduationTick: plan.graduationTick, curveFee: fee, poolFee: graduationFee, taxBps: tax });
    if (p.devBuyQuote > 0n) logs.push(...this.trade(token, { wallet: p.devBuyRecipient, quote: p.devBuyQuote }, { txHash: tx.hash, advance: false }));
  }
  async receipt(hash) { return this.txs.get(hash)?.receipt || null; }
  async txState(op, { confirmations = ROBINHOOD_LAUNCH_POLICY.launch.confirmations } = {}) {
    const tx = this.txs.get(op.hash);
    if (tx) { const depth = this.block - tx.block + 1; if (depth < confirmations) return { state: 'pending', receipt: tx.receipt, confirmations: depth }; return { state: tx.status ? 'confirmed' : 'failed', receipt: tx.receipt, confirmations: depth }; }
    if (op.nonce != null && (this.mined.get(lower(op.wallet)) || 0) > op.nonce) return { state: 'replaced', receipt: null, confirmations: 0 };
    return { state: 'pending', receipt: null, confirmations: 0 };
  }
  async transactionProof(hash) { const tx = this.txs.get(hash); return tx ? { hash, from: tx.from, to: tx.to, value: tx.value, input: '0x', status: tx.status, blockNumber: tx.block, logs: [] } : null; }
  // --- decoders over the scripted logs ---
  decodeLaunched(receipt) { return receipt?.logs?.find(l => l.kind === 'launched') || null; }
  decodeGraduated(receipt, token) { return receipt?.logs?.find(l => l.kind === 'graduated' && (!token || lower(l.token) === lower(token))) || null; }
  decodeTransfers(logs, token) { return (logs || []).filter(l => l.kind === 'transfer' && (!token || lower(l.address) === lower(token))); }
  decodeTrades(logs, pools) { const wanted = pools instanceof Map ? pools : null; return (logs || []).filter(l => l.kind === 'trade' && (!wanted || wanted.has(lower(l.poolId)))).map(l => ({ ...l })); }
  attributeTrades(trades) { return trades; }
  decodeClaims(logs, recipient) { return (logs || []).filter(l => l.kind === 'claim' && (!recipient || lower(l.recipient) === lower(recipient))); }
  decodeFeesCollected(receipt, token) { return receipt?.logs?.find(l => l.kind === 'fees' && lower(l.token) === lower(token)) || null; }
  decodePayouts(receipt) { return { paid: receipt?.logs?.find(l => l.kind === 'paid') || null, skipped: (receipt?.logs || []).filter(l => l.kind === 'skipped') }; }
  async transferLogs(token, from, to) { this.scans = (this.scans || 0) + 1; return this.logs.filter(l => l.kind === 'transfer' && lower(l.address) === lower(token) && l.block >= from && l.block <= to); }
  async tradeLogs(pool, from, to) { this.scans = (this.scans || 0) + 1; return this.logs.filter(l => l.kind === 'trade' && lower(l.poolId) === lower(pool.poolId) && l.block >= from && l.block <= to).map(l => ({ ...l })); }
  // v71.40: the multi-address readers the service prefers (one request for every tracked coin); `refuseMulti` makes the node refuse them.
  async transferLogsOf(tokens, from, to) { this.multiScans = (this.multiScans || 0) + 1; if (this.refuseMulti) throw Error('multiple addresses are not supported'); const wanted = new Set(tokens.map(lower)); return this.logs.filter(l => l.kind === 'transfer' && wanted.has(lower(l.address)) && l.block >= from && l.block <= to); }
  async tradeLogsOf(pools, from, to) { this.multiScans = (this.multiScans || 0) + 1; if (this.refuseMulti) throw Error('multiple addresses are not supported'); const wanted = new Set(pools.map(p => lower(p.poolId))); return this.logs.filter(l => l.kind === 'trade' && wanted.has(lower(l.poolId)) && l.block >= from && l.block <= to).map(l => ({ ...l })); }
  async ethBalances(addresses) { this.balanceBatches = (this.balanceBatches || 0) + 1; return addresses.map(a => this.balanceOf(a)); }
  // --- call data (the real encoders, so the fake decodes what the service really sends) ---
  launchData(params) { return encodeCall(abiItem(ABI.factory, 'launch'), [params]); }
  approveData(spender, amount) { return encodeCall(abiItem(ABI.erc20, 'approve'), [spender, amount]); }
  transferData(to, amount) { return encodeCall(abiItem(ABI.erc20, 'transfer'), [to, amount]); }
  claimAllData(to) { return encodeCall(abiItem(ABI.escrow, 'claimAll'), [to]); }
  claimAllTokenData(token, to) { return encodeCall(abiItem(ABI.escrow, 'claimAllToken'), [token, to]); }
  collectData(token) { return encodeCall(abiItem(ABI.locker, 'collect'), [token]); }
  graduateData(token) { return encodeCall(abiItem(ABI.locker, 'graduate'), [token]); }
  payEthData(to, amounts) { return encodeCall(abiItem(ABI.payouts, 'payEth'), [to, amounts]); }
  payTokenData(token, to, amounts) { return encodeCall(abiItem(ABI.payouts, 'payToken'), [token, to, amounts]); }
  setPairAssetsData(tokens, assets) { return encodeCall(abiItem(ABI.factory, 'setPairAssets'), [tokens, assets]); }
  setLaunchesOpenData(open) { return encodeCall(abiItem(ABI.factory, 'setLaunchesOpen'), [open]); }
  setLaunchFeeData(fee) { return encodeCall(abiItem(ABI.factory, 'setLaunchFee'), [fee]); }
  setPlatformRecipientData(recipient) { return encodeCall(abiItem(ABI.factory, 'setPlatformRecipient'), [recipient]); }
  acceptOwnershipData() { return encodeCall(abiItem(ABI.factory, 'acceptOwnership'), []); }
}

const fakeBook = () => ({
  prices: new Map([[ROBINHOOD_NATIVE, { usd: '4000', at: 1 }], [lower(USDG), { usd: '1', at: 1 }], [lower(addr('nvda')), { usd: '180', at: 1 }]]),
  // Tokens the fake chain "has": what they say about themselves and whether a pool prices them.
  tokens: new Map([[lower(addr('cbbtc')), { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8, totalSupply: '100000000000', pool: '65000' }], [lower(addr('dust')), { symbol: 'DUST', name: 'No Pool Token', decimals: 18, totalSupply: '1000', pool: null }]]),
  custom: [],
  setCustomPairs(rows) { this.custom = rows.map(r => ({ ...r, kind: 'custom' })); for (const r of rows) { const t = this.tokens.get(lower(r.address)); if (t?.pool) this.prices.set(lower(r.address), { usd: t.pool, at: 1 }); } },
  async pairs() { return [{ address: ROBINHOOD_NATIVE, symbol: 'ETH', name: 'Ether', decimals: 18, kind: 'native', logo: '', isin: '' }, { address: USDG, symbol: 'USDG', name: 'Global Dollar', decimals: 6, kind: 'stable', logo: '', isin: '' }, { address: addr('nvda'), symbol: 'NVDA', name: 'NVIDIA', decimals: 18, kind: 'stock', logo: 'https://cdn.robinhood.com/app_assets/nvda.png', isin: 'US1' }, ...this.custom]; },
  async priceUsd(address) { const p = this.prices.get(lower(address)); if (!p) throw Error('no price'); return { ...p, halted: false }; },
  async describeToken(address) { const t = this.tokens.get(lower(address)); if (!t) throw Object.assign(Error('This address is not an ERC-20 token (it does not answer symbol, name, decimals and totalSupply).'), { statusCode: 400 }); return { address, symbol: t.symbol, name: t.name, decimals: t.decimals, totalSupply: t.totalSupply }; },
  async poolPrice(address) { const t = this.tokens.get(lower(address)); if (!t?.pool) throw Object.assign(Error('No Uniswap pool on Robinhood Chain prices this token against USDG or ETH.'), { statusCode: 409 }); return { usd: t.pool, source: 'uniswap-v4', via: 'USDG', halted: false, at: 1 }; },
});

async function harness({ holderPayoutUsd = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rh-fake-')); let clock = 1_700_000_000_000;
  const chain = new FakeChain(), log = [];
  const service = new RobinhoodLaunchService({
    accounts: { hostStore: new FakeHostStore(), dir }, chainFactory: async () => chain, pairBookFactory: async () => fakeBook(), publishMetadata: async ({ mint }) => `https://launchpad.test/token-metadata/${mint}.json`, requireOwner: async () => true,
    config: { enabled: true, rpcUrl: 'http://fake', addresses: ADDRESSES, treasury: addr('treasury'), dbPath: join(dir, 'rh.sqlite'), backupDir: '', ethUsdOverride: '4000', holderPayoutUsd }, now: () => clock, log: (kind, data) => log.push({ kind, ...data }),
  });
  const store = await service.ensure();
  const host = await service.hostWallets();
  chain.fund(host.owner, parseEther('1')); chain.fund(host.platform, parseEther('0.5'));
  chain.factory.owner = host.owner; chain.factory.platformRecipient = host.platform;
  await service.adminControl('owner', { flags: { intake: true, pairs: true }, reason: 'service test' });
  await service.adminControl('owner', { action: 'sync-pairs' });
  const session = { account: { id: 'acct1', role: 'user' }, walletVerified: false };
  const creator = addr('creator'); chain.fund(creator, parseEther('5'));
  // One worker pass: the clock moves, blocks are mined, the service runs.
  const pass = async ({ advanceMs = 5000, blocks = 1 } = {}) => { const seen = log.length; clock += advanceMs; chain.mine(blocks); await service.run(); if (service.lastError) throw Error(service.lastError); const bad = log.slice(seen).find(l => l.kind === 'robinhood-launch-op-error' || l.kind === 'robinhood-launch-holder-index'); if (bad) throw Error('worker error: ' + JSON.stringify(bad)); };
  const quote = (body = {}) => service.quote(session, { requestKey: 'req-' + randomBytes(8).toString('hex'), mode: 'holders', name: 'Fake Coin', symbol: 'FAKE', description: '', image: IMAGE, wallet: creator, tier: '4k', pairToken: 'eth', devBuy: '0.05', ...body }, { authorize: async () => {} });
  const fundIt = async q => { const f = await service.prepareFunding(session, { launchId: q.id }, { authorize: async () => {} }); const hash = chain.outside({ from: creator, to: f.transactions[0].to, value: BigInt(f.transactions[0].value) }); await service.submitFunding(session, { launchId: q.id, txHashes: [hash] }, { authorize: async () => {} }); return hash; };
  const until = async (predicate, { passes = 30, label = '', ...opts } = {}) => { for (let i = 0; i < passes; i++) { await pass(opts); if (predicate()) return; } throw Error(`not reached: ${label}; log tail ${JSON.stringify(log.slice(-3))}`); };
  const close = async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); };
  return { service, store, chain, session, creator, host, quote, fundIt, pass, until, close, log, clock: () => clock, advance: ms => { clock += ms; } };
}

test('a quote is refused for a later mode, a missing image, a tax outside 1–3% or on a Creator coin, and too many pending launches', async () => {
  const h = await harness();
  await assert.rejects(h.quote({ mode: 'gotchi' }), /not on Robinhood Chain yet/);
  await assert.rejects(h.quote({ image: 'x.png' }), /Upload a coin image/);
  await assert.rejects(h.quote({ taxBps: 350 }), /between 1% and 3%/, 'a Holders coin: the tax has bounds');
  await assert.rejects(h.quote({ taxBps: 50 }), /between 1% and 3%/);
  await assert.rejects(h.quote({ mode: 'creator', taxBps: 200 }), /flat creator fee/, 'a Creator coin carries the flat creator fee, not a tax');
  await assert.rejects(h.quote({ pairToken: addr('nvda') }), /not open for launches|not approved/);
  await assert.rejects(h.quote({ hooks: { rules: [{ id: 'sniper_fee_cap', settings: { windowMinutes: 10, maxPriorityFeeSol: 0.01, maxTipSol: 0.01 } }] } }), /not available on Robinhood Chain/, 'a Solana-only rule (priority fees and Jito tips)');
  await assert.rejects(h.quote({ hooks: { rules: [{ id: 'tithe', settings: { donationSol: 0.005 } }], titheRecipient: '0x3333333333333333333333333333333333333333' } }), /not available on Robinhood Chain/, 'the tithe needs the donation instruction only the Solana route adds (v71.41: the pool is a plain Uniswap v4 pool)');
  for (let i = 0; i < 3; i++) await h.quote();
  await assert.rejects(h.quote(), /Finish or cancel your pending/);
  const status = await h.service.status(null); assert.equal(status.intakeOpen, true); assert.deepEqual(status.tiers.map(t => t.id), ['4k', '20k']);
  await h.close();
});

test('an unfunded quote expires; a cancelled one refunds a late deposit to the creator', async () => {
  const h = await harness();
  const expiring = await h.quote();
  h.advance(ROBINHOOD_LAUNCH_POLICY.launch.quoteTtlMs + 1000); await h.pass();
  assert.equal(h.store.launch(expiring.id).state, 'expired');
  await assert.rejects(h.service.prepareFunding(h.session, { launchId: expiring.id }, {}), /expired|is Expired/i);
  const cancelled = await h.quote();
  const view = await h.service.cancel(h.session, { launchId: cancelled.id });
  assert.equal(view.state, 'cancelled');
  await assert.rejects(h.service.cancel(h.session, { launchId: cancelled.id }), /Only a launch waiting for funding/);
  // The creator sends anyway: the launch wallet returns it (minus one transfer's gas).
  const late = parseEther('0.3'); h.chain.outside({ from: h.creator, to: h.store.launch(cancelled.id).launch_wallet, value: late });
  const before = h.chain.balanceOf(h.creator);
  await h.until(() => h.store.launch(cancelled.id).refund_state === 'complete', { label: 'late refund', advanceMs: 61000, blocks: 3 });
  assert.ok(h.chain.balanceOf(h.creator) > before + late - parseEther('0.001'), 'the deposit came back');
  await h.close();
});

test('a reverting launch is retried, then failed and refunded; the factory refusing in simulation fails at once', async () => {
  const h = await harness();
  const q = await h.quote(); await h.fundIt(q);
  h.chain.revert.add('launch');
  await h.until(() => h.store.launch(q.id).state === 'creating' && h.store.launch(q.id).create_attempts === 1, { label: 'first attempt' });
  await h.until(() => h.store.launch(q.id).state === 'refunded', { label: 'refunded after the attempts', advanceMs: 61000, blocks: 3, passes: 60 });
  const row = h.store.launch(q.id);
  assert.equal(row.create_attempts, ROBINHOOD_LAUNCH_POLICY.launch.maxCreateAttempts); assert.match(row.state_reason, /kept failing/);
  assert.ok(BigInt(row.refunded_wei) > BigInt(row.plan.totalWei) - parseEther('0.01'), 'nearly everything came back: ' + row.refunded_wei);
  assert.equal(h.store.operationsFor(q.id).filter(op => op.kind === 'launch' && op.state === 'failed').length, 3, 'three journaled failures');
  h.chain.revert.delete('launch');
  // Simulation refusal: the pair stops being approved between quote and creation.
  const q2 = await h.quote(); await h.fundIt(q2);
  h.chain.simulationError = 'PairNotApproved(0x0000000000000000000000000000000000000000)';
  await h.until(() => h.store.launch(q2.id).state === 'failed' || h.store.launch(q2.id).state === 'refunding' || h.store.launch(q2.id).state === 'refunded', { label: 'simulation failure' });
  assert.match(h.store.launch(q2.id).state_reason, /factory refused the launch: PairNotApproved/);
  h.chain.simulationError = null;
  await h.until(() => h.store.launch(q2.id).state === 'refunded', { label: 'refund of the refused launch', advanceMs: 61000, blocks: 3 });
  const mine = await h.service.mine(h.session);
  assert.deepEqual(mine.launches.map(l => l.state).sort(), ['refunded', 'refunded']);
  await h.close();
});

test('a stalled refund is replaced with higher fees; a nonce spent by a stray transaction is noticed and the refund re-sent', async () => {
  const h = await harness();
  const q = await h.quote(); await h.fundIt(q);
  await h.until(() => h.store.launch(q.id).state === 'created', { label: 'created', blocks: 3 });
  h.chain.stall.add('refund');
  await h.until(() => h.store.openOperations(q.id).some(op => op.kind === 'refund'), { label: 'refund sent', advanceMs: 61000, blocks: 3 });
  const first = h.store.openOperations(q.id).find(op => op.kind === 'refund');
  h.advance(600001); await h.pass({ blocks: 0 }); // ten minutes: the service bumps the fees and re-signs with the same nonce
  const bumped = h.store.operation(first.id);
  assert.notEqual(bumped.hash, first.hash); assert.equal(bumped.nonce, first.nonce); assert.ok(BigInt(bumped.max_fee) > BigInt(first.max_fee)); assert.equal(bumped.expected.hashes.length, 2);
  h.chain.stall.delete('refund');
  await h.until(() => h.store.operation(first.id).state === 'confirmed', { label: 'replacement mined', blocks: 3 });
  assert.equal(h.store.launch(q.id).refund_state, 'complete');
  // A second coin: its refund's nonce is spent by a stray transaction from the launch wallet.
  const q2 = await h.quote(); await h.fundIt(q2);
  await h.until(() => h.store.launch(q2.id).state === 'created', { label: 'created 2', blocks: 3 });
  h.chain.stall.add('refund');
  await h.until(() => h.store.openOperations(q2.id).some(op => op.kind === 'refund'), { label: 'refund 2 sent', advanceMs: 61000, blocks: 3 });
  const op2 = h.store.openOperations(q2.id).find(op => op.kind === 'refund');
  h.chain.stray(op2.wallet); h.chain.stall.delete('refund');
  await h.until(() => h.store.operation(op2.id).state === 'replaced', { label: 'replaced noticed', blocks: 1 });
  assert.equal(h.store.launch(q2.id).refund_state, 'pending');
  await h.until(() => h.store.launch(q2.id).refund_state === 'complete', { label: 'refund re-sent', advanceMs: 61000, blocks: 3 });
  assert.equal(h.store.operationsFor(q2.id).filter(op => op.kind === 'refund').length, 2);
  await h.close();
});

test('a Holders coin claims, samples, pays (a refusing wallet is skipped and re-credited) and graduates; the platform routes to the treasury', async () => {
  const h = await harness();
  const q = await h.quote(); await h.fundIt(q);
  await h.until(() => h.store.launch(q.id).state === 'created', { label: 'created', blocks: 3 });
  const live = h.store.launch(q.id);
  assert.ok(BigInt(live.dev_tokens) > 0n); assert.equal(h.chain.tokenBalanceOf(live.token, h.creator), BigInt(live.dev_tokens));
  const wallets = [addr('w1'), addr('w2'), addr('w3')];
  wallets.forEach((w, i) => { h.chain.fund(w, parseEther('1')); h.chain.trade(live.token, { wallet: w, quote: parseEther(i === 0 ? '2' : '0.2') }); });
  h.chain.refuse.add(lower(wallets[2]));
  await h.until(() => h.service.holderCount(h.store.launch(q.id)) === 4, { label: 'holders indexed', advanceMs: 31000 });
  assert.equal(h.store.trades(q.id, 10).length, 4, 'dev buy and three buys');
  // A holder is paid for what it held through the whole hour-long window: an hour without samples restarts the window
  // with all four wallets in it (the creation-time sample held the creator alone).
  h.advance(3600000);
  await h.until(() => h.store.balance(q.id, 'rewards', ROBINHOOD_NATIVE).available > 0n, { label: 'claim', advanceMs: 300000, blocks: 3 });
  const held = h.service.payoutHeld(h.store.launch(q.id));
  assert.ok(held > parseEther('0.04'), 'buys of 2.45 ETH at a 1% fee (70% to the creator) and a 1% creator tax: ' + held);
  await h.until(() => h.store.rewardCycles(q.id, 1)[0]?.state === 'complete', { label: 'payout', advanceMs: 300000, blocks: 3, passes: 40 });
  const cycle = h.store.rewardCycles(q.id, 1)[0];
  assert.equal(cycle.payouts.length, 4, JSON.stringify(cycle.payouts.map(p => [p.owner, String(p.amount)]))); assert.equal(cycle.skipped, 1, 'the refusing wallet was skipped');
  const refused = cycle.payouts.find(p => lower(p.owner) === lower(wallets[2]));
  assert.equal(h.chain.balanceOf(wallets[2]), parseEther('1'), 'nothing reached the refusing wallet');
  assert.ok(h.chain.balanceOf(wallets[0]) > parseEther('1'), 'a holder was paid');
  const ledger = h.store.balance(q.id, 'rewards', ROBINHOOD_NATIVE);
  assert.ok(ledger.available >= BigInt(refused.amount), 'the skipped amount is back on the ledger');
  const view = await h.service.coinView(live.token);
  assert.equal(view.holderRewards.cycles[0].state, 'complete'); assert.equal(view.holders, 4);
  // Graduation seen from the curve state.
  const feeWalletBefore = await h.chain.escrowBalance(live.fee_wallet, null), platformEscrowBefore = await h.chain.escrowBalance(h.host.platform, null);
  h.chain.cross(live.token); // the price passes the graduation tick: the worker graduates the coin (the owner wallet sends it)
  await h.until(() => h.store.launch(q.id).venue_state === 'graduated', { label: 'graduated', advanceMs: 61000 });
  // v71.41: the graduation moved the liquidity into the graduation pool; the journal follows the coin there and keeps
  // where it came from; the curve pool's last fees were split the curve way (a Holders coin with a 2% tax: 41.53% to Launchpad).
  const graduatedRow = h.store.launch(q.id), pool = h.chain.pools.get(live.token.toLowerCase());
  assert.equal(graduatedRow.pool_id, pool.graduationPoolId, 'the pool trading now is the graduation pool'); assert.equal(graduatedRow.curve_pool_id, pool.curvePoolId, 'the curve pool is remembered');
  assert.equal(graduatedRow.tax_bps, 200); assert.equal(graduatedRow.curve_fee, 32500); assert.equal(graduatedRow.pool_fee, 25000);
  const curveFees = (await h.chain.escrowBalance(live.fee_wallet, null)) - feeWalletBefore + (await h.chain.escrowBalance(h.host.platform, null)) - platformEscrowBefore;
  assert.ok(curveFees > 0n, 'the curve pool’s last fees were collected on the way');
  assert.equal((await h.chain.escrowBalance(h.host.platform, null)) - platformEscrowBefore, curveFees * 4153n / 10000n, 'split the curve stage’s way');
  // A trade in the graduation pool lands in the journal from the new pool's Swap log, at the 2.5% fee of that pool.
  const late = addr('late-buyer'); h.chain.fund(late, parseEther('1'));
  const lateLogs = h.chain.trade(live.token, { wallet: late, quote: parseEther('0.1') }, { txHash: hash32(), advance: true });
  assert.equal(lateLogs.find(l => l.kind === 'trade').poolId, pool.graduationPoolId); assert.equal(lateLogs.find(l => l.kind === 'trade').feePips, 25000);
  h.advance(31000); await h.pass({ blocks: 1 });
  assert.ok(h.store.trades(q.id, 50).some(t => t.wallet.toLowerCase() === late.toLowerCase()), 'the graduation pool’s trade is in the journal');
  const viewAfter = await h.service.coinView(live.token);
  assert.equal(viewAfter.pool.id, pool.graduationPoolId); assert.equal(viewAfter.pool.curvePoolId, pool.curvePoolId); assert.equal(viewAfter.curve.graduated, true); assert.equal(viewAfter.curve.progressBps, 10000);
  assert.equal(viewAfter.feeShape.stage, 'pool'); assert.equal(viewAfter.feeShape.poolTotalBps, 250); assert.equal(viewAfter.recipients.platformShareBps, 1400);
  assert.ok(viewAfter.pool.positions.length >= 1 && viewAfter.pool.curve === null, 'the pool view carries the graduation pool’s positions');
  await h.until(() => h.store.operationsFor(q.id).some(op => op.kind === 'collect' && op.state === 'confirmed'), { label: 'locker collect', advanceMs: 3600001, blocks: 3 });
  // Platform: claims from the escrow and sweeps to the treasury.
  await h.until(() => BigInt(h.store.feeTotals('host')['platform:' + ROBINHOOD_NATIVE] || 0) > 0n, { label: 'platform claim', advanceMs: 900001, blocks: 3 });
  await h.until(() => h.chain.balanceOf(addr('treasury')) > 0n, { label: 'platform sweep', advanceMs: 900001, blocks: 3 });
  const admin = await h.service.adminOverview('owner', {});
  assert.equal(admin.rows[0].dimensions.venue, 'graduated'); assert.equal(admin.rows[0].holders, 6, 'the wallet that bought it over the line and the late buyer in the graduation pool hold too'); assert.equal(admin.factory.ownerIsHost, true);
  await h.close();
});

test('Insured: the pot grows with claims, a missed deadline refunds it to holders; Earned: a failed probation sends the escrow to holders', async () => {
  const h = await harness();
  const q = await h.quote({ mode: 'insured', option: { coveragePercent: 50, deadlineDays: 7, onGraduation: 0 } }); await h.fundIt(q);
  await h.until(() => h.store.launch(q.id).state === 'created', { label: 'created', blocks: 3 });
  const live = h.store.launch(q.id);
  assert.equal(live.option.state.phase, 'active'); assert.ok(live.option.state.deadlineAt > h.clock());
  const w = addr('ins-1'); h.chain.fund(w, parseEther('1')); h.chain.trade(live.token, { wallet: w, quote: parseEther('0.5') });
  await h.until(() => h.store.balance(q.id, 'insured', ROBINHOOD_NATIVE).available > 0n, { label: 'claim', advanceMs: 300000, blocks: 3 });
  const pot = BigInt(h.store.launch(q.id).option.state.pot), claimed = BigInt(h.store.feeTotals(q.id)['insured:' + ROBINHOOD_NATIVE] || 0);
  assert.equal(pot, claimed / 2n, 'half of every claim is the pot');
  // Nothing is paid before the deadline (the holders' trigger is the insurance, not the threshold).
  await h.pass({ advanceMs: 3600001 }); assert.equal(h.store.rewardCycles(q.id, 1).length, 0);
  h.advance(8 * 86400000);
  await h.until(() => h.store.launch(q.id).option.state.phase === 'holders', { label: 'deadline', advanceMs: 61000 });
  await h.until(() => h.store.rewardCycles(q.id, 1)[0]?.state === 'complete', { label: 'refund paid', advanceMs: 300000, blocks: 3, passes: 40 });
  const cycle = h.store.rewardCycles(q.id, 1)[0];
  assert.ok(BigInt(cycle.paid) <= pot && BigInt(cycle.paid) > 0n, 'the pot (not more) went to holders: ' + cycle.paid + ' of ' + pot);
  assert.equal(h.store.launch(q.id).option.state.refundDue, null);
  // Earned: a baseline, then a crash below the floor.
  const e = await h.quote({ mode: 'earned', option: { probationDays: 7, floorPercent: 150 } }); await h.fundIt(e);
  await h.until(() => h.store.launch(e.id).state === 'created', { label: 'earned created', blocks: 3 });
  const eLive = h.store.launch(e.id);
  assert.equal(eLive.option.state.phase, 'probation');
  await h.until(() => h.store.launch(e.id).option.state.baseline, { label: 'baseline', advanceMs: 86400001 });
  const baseline = BigInt(h.store.launch(e.id).option.state.baseline), floor = BigInt(h.store.launch(e.id).option.state.floor);
  assert.equal(floor, baseline * 150n / 100n, 'the floor is 150% of the day-one baseline');
  // The next day's record is the same market cap: below a floor set above the baseline, so the probation fails.
  await h.until(() => ['failed', 'earned'].includes(h.store.launch(e.id).option.state.phase), { label: 'probation decided', advanceMs: 86400001 });
  assert.equal(h.store.launch(e.id).option.state.phase, 'failed', 'below ' + floor);
  assert.ok(h.store.events(e.id, { limit: 5 }).some(ev => /Probation failed/.test(ev.title)));
  // Its escrow now pays holders: the Earned coin becomes a holder-paying coin.
  const ew = addr('earned-holder'); h.chain.fund(ew, parseEther('1')); h.chain.trade(eLive.token, { wallet: ew, quote: parseEther('1') });
  h.advance(3600000);
  await h.until(() => h.store.rewardCycles(e.id, 1)[0]?.state === 'complete', { label: 'earned escrow paid to holders', advanceMs: 300000, blocks: 3, passes: 40 });
  assert.ok(BigInt(h.store.rewardCycles(e.id, 1)[0].paid) > 0n);
  await h.close();
});

test('admin: pairs are enabled, approved on chain in one owner transaction, and launches can be closed and reopened', async () => {
  const h = await harness();
  const pairs = await h.service.pairs({ account: { id: 'owner', role: 'admin' } });
  assert.deepEqual(pairs.pairs.map(p => p.symbol), ['ETH', 'USDG'], 'the stock is listed but not approved on chain yet');
  const nvda = addr('nvda');
  const approved = await h.service.adminControl('owner', { action: 'approve-pairs', addresses: [nvda] });
  assert.equal(approved.pairs, 1);
  await h.until(() => h.store.pair(nvda)?.approved === true, { label: 'pair approved', blocks: 3 });
  assert.equal(h.chain.pairs.get(lower(nvda)).approved, true);
  const after = await h.service.pairs(null);
  assert.deepEqual(after.pairs.map(p => p.symbol), ['ETH', 'USDG', 'NVDA']);
  // Badges (v71.40): a published logo is served by this host; ETH and USDG are lettermarks unless the operator adds a file.
  const nvdaRow = after.pairs.find(p => p.symbol === 'NVDA');
  assert.deepEqual(after.pairs.map(p => p.logo), ['/robinhood-pairs/logo/0x0000000000000000000000000000000000000000?v=2', '/robinhood-pairs/logo/' + after.pairs[1].address + '?v=2', '/robinhood-pairs/logo/' + nvdaRow.address + '?v=2'], 'every pair with a source has a badge path (checksummed, versioned; v71.42: ETH and USDG from the crypto marks, the stock by ISIN / ticker), no third-party URL');
  const badges = (await h.service.adminOverview('owner')).pairs.find(p => p.symbol === 'NVDA');
  assert.equal(badges.logo, '/robinhood-pairs/logo/' + nvdaRow.address + '?v=2'); assert.equal(badges.source, 'https://cdn.robinhood.com/app_assets/nvda.png');
  await h.service.adminControl('owner', { action: 'set-launches-open', value: false });
  await h.until(() => h.chain.factory.launchesOpen === false, { label: 'closed', blocks: 3 });
  const status = await h.service.status(null);
  assert.equal(status.intakeOpen, false); assert.match(status.blockers[0], /closed/);
  await assert.rejects(h.quote(), /paused right now/);
  await h.service.adminControl('owner', { action: 'set-launches-open', value: true });
  await h.until(() => h.chain.factory.launchesOpen === true, { label: 'reopened', blocks: 3 });
  const q = await h.quote({ pairToken: nvda, devBuy: '0' });
  assert.equal(q.pair.symbol, 'NVDA'); assert.equal(Number(q.quote.devBuy), 0);
  const overview = await h.service.adminOverview('owner', {});
  assert.equal(overview.factory.ownerIsHost, true); assert.equal(overview.rows.length, 1);
  await h.close();
});

test('the Custom pair check: listed pairs report their state, an unlisted ERC-20 with a pool price is recorded as a request, the owner adds it and approves it, a token without a pool is refused', async () => {
  const h = await harness(), who = { account: { id: 'creator-1', role: 'user' } }, owner = { account: { id: 'owner', role: 'admin' } };
  await assert.rejects(h.service.pairCheck(who, { address: 'nope' }), /token address/);
  assert.equal((await h.service.pairCheck(who, { address: ROBINHOOD_NATIVE })).status, 'available');
  assert.equal((await h.service.pairCheck(who, { address: USDG })).status, 'available');
  const nvda = await h.service.pairCheck(who, { address: addr('nvda') });
  assert.equal(nvda.status, 'not_approved'); assert.equal(nvda.available, false); assert.equal(nvda.symbol, 'NVDA');
  const dust = await h.service.pairCheck(who, { address: addr('dust') });
  assert.equal(dust.status, 'unlisted'); assert.equal(dust.compatible, false); assert.match(dust.reason, /no Uniswap pool/i);
  const nothing = await h.service.pairCheck(who, { address: addr('ghost') });
  assert.equal(nothing.status, 'invalid'); assert.match(nothing.reason, /not an ERC-20/);
  const cb = await h.service.pairCheck(who, { address: addr('cbbtc') });
  assert.equal(cb.status, 'unlisted'); assert.equal(cb.compatible, true); assert.equal(cb.usd, '65000'); assert.equal(cb.decimals, 8); assert.match(cb.reason, /sent to the operator/);
  await h.service.pairCheck({ account: { id: 'creator-2', role: 'user' } }, { address: addr('cbbtc') });
  const requests = (await h.service.adminOverview('owner', {})).pairRequests;
  assert.equal(requests.length, 2, 'the priced one and the unpriced one are both on the operator\'s list');
  const cbReq = requests.find(r => r.symbol === 'cbBTC'); assert.equal(cbReq.count, 2); assert.deepEqual(cbReq.accounts, ['creator-1', 'creator-2']); assert.equal(cbReq.compatible, true);
  await assert.rejects(h.service.adminControl('owner', { action: 'add-pair', address: addr('dust') }), /cannot be priced/);
  await assert.rejects(h.service.adminControl('owner', { action: 'add-pair', address: addr('nvda') }), /already listed as a stock/);
  const added = await h.service.adminControl('owner', { action: 'add-pair', address: addr('cbbtc') });
  assert.equal(added.pair.symbol, 'cbBTC'); assert.equal(added.pair.approved, false); assert.match(added.what, /custom pair/);
  assert.equal((await h.service.adminOverview('owner', {})).pairRequests.some(r => r.symbol === 'cbBTC'), false, 'adding clears the request');
  assert.equal(h.store.pair(addr('cbbtc')).kind, 'custom');
  assert.equal((await h.service.pairCheck(who, { address: addr('cbbtc') })).status, 'not_approved');
  const approved = await h.service.adminControl('owner', { action: 'approve-pairs', addresses: [addr('cbbtc')] });
  assert.equal(approved.pairs, 1);
  await h.until(() => h.store.pair(addr('cbbtc'))?.approved === true, { label: 'custom pair approved', blocks: 3 });
  await h.service.adminControl('owner', { flags: { pairs: false }, reason: 'close the stocks and custom pairs for a moment' });
  assert.equal((await h.service.pairCheck(who, { address: addr('cbbtc') })).status, 'not_open', 'custom pairs open with the pairs flag');
  assert.equal((await h.service.pairCheck(owner, { address: addr('cbbtc') })).status, 'available', 'the owner previews them');
  await h.service.adminControl('owner', { flags: { pairs: true }, reason: 'open the stocks and custom pairs' });
  assert.equal((await h.service.pairCheck(who, { address: addr('cbbtc') })).status, 'available');
  const listed = await h.service.pairs(null);
  assert.deepEqual(listed.pairs.map(p => p.symbol), ['ETH', 'USDG', 'cbBTC']); assert.equal(listed.pairs[2].kind, 'custom'); assert.equal(listed.pairs[2].usd, '65000');
  const q = await h.quote({ pairToken: addr('cbbtc'), devBuy: '0' }); assert.equal(q.pair.symbol, 'cbBTC');
  await h.service.adminControl('owner', { action: 'sync-pairs' });
  assert.equal(h.store.pair(addr('cbbtc'))?.kind, 'custom', 'a sync keeps the custom pair');
  await assert.rejects(h.service.adminControl('owner', { action: 'remove-pair', address: addr('nvda') }), /Only custom pairs/);
  const removed = await h.service.adminControl('owner', { action: 'remove-pair', address: addr('cbbtc') }); assert.match(removed.what, /removed/);
  assert.equal(h.store.pair(addr('cbbtc')), null);
  const dismissed = await h.service.adminControl('owner', { action: 'dismiss-pair-request', address: addr('dust') }); assert.equal(dismissed.requests.length, 0);
  await h.close();
});

test('many live coins are tracked together: one balance batch for pending launches, multi-address log scans for the coins (per-coin scans when the node refuses them)', async () => {
  const h = await harness(), coins = [];
  // Three launches from three creators, funded and created; their trades land in the shared scans.
  for (const i of [1, 2, 3]) {
    const creator = addr('creator-' + i); h.chain.fund(creator, parseEther('2'));
    const session = { account: { id: 'acct-' + i, role: 'user' } };
    const q = await h.service.quote(session, { requestKey: 'req-coin-' + i + '-' + randomBytes(8).toString('hex'), mode: 'creator', name: 'Coin ' + i, symbol: 'C' + i, description: '', image: IMAGE, wallet: creator, tier: '4k', pairToken: 'eth', devBuy: '0', creatorFeeBps: 0 }, { authorize: async () => {} });
    const f = await h.service.prepareFunding(session, { launchId: q.id }, { authorize: async () => {} });
    const hash = h.chain.outside({ from: creator, to: f.transactions[0].to, value: BigInt(f.transactions[0].value) });
    await h.service.submitFunding(session, { launchId: q.id, txHashes: [hash] }, { authorize: async () => {} });
    coins.push({ id: q.id, creator });
  }
  const batchesBefore = h.chain.balanceBatches || 0;
  await h.until(() => coins.every(c => h.store.launch(c.id).state === 'created'), { label: 'three coins live', passes: 40 });
  assert.ok((h.chain.balanceBatches || 0) > batchesBefore, 'pending launches were checked in batched balance reads');
  // Trades on each coin, then one tracking pass: the scans go out per address set, not per coin.
  for (const c of coins) { const l = h.store.launch(c.id); h.chain.trade(l.token, { wallet: c.creator, quote: parseEther('0.01') }, { txHash: hash32(), advance: true }); }
  const scansBefore = h.chain.scans || 0, multiBefore = h.chain.multiScans || 0;
  h.advance(31000); await h.pass({ blocks: 1 });
  assert.ok((h.chain.multiScans || 0) > multiBefore, 'the multi-address readers were used');
  assert.equal(h.chain.scans || 0, scansBefore, 'no per-coin scans when the node serves multi-address queries');
  for (const c of coins) assert.equal(h.store.trades(c.id, 10).length, 1, 'each coin recorded exactly its own trade');
  assert.equal(h.service.holderCount(h.store.launch(coins[0].id)), 1);
  // A node that refuses multi-address queries: the coins fall back to their own scans and nothing is lost.
  h.chain.refuseMulti = true;
  for (const c of coins) { const l = h.store.launch(c.id); h.chain.trade(l.token, { wallet: c.creator, quote: parseEther('0.01') }, { txHash: hash32(), advance: true }); }
  const scansBefore2 = h.chain.scans || 0;
  h.advance(31000); await h.pass({ blocks: 1 });
  assert.ok((h.chain.scans || 0) >= scansBefore2 + 6, 'per-coin scans ran for every coin');
  for (const c of coins) assert.equal(h.store.trades(c.id, 10).length, 2);
  // A Creator coin has no fee wallet: the host's platform wallet collects its pool fees once they are worth the minimum
  // (its own share is in the same call); the creator's share waits in the escrow under the creator's wallet.
  const second = h.store.launch(coins[1].id);
  h.chain.trade(second.token, { wallet: coins[1].creator, quote: parseEther('1') }, { txHash: hash32(), advance: true }); // a 1% fee on 1 ETH: $40 at the test's ETH price
  const platformBefore = await h.chain.escrowBalance(h.host.platform, null), creatorBefore = await h.chain.escrowBalance(coins[1].creator, null);
  await h.until(() => h.store.operationsFor(second.id).some(op => op.kind === 'collect' && op.state === 'confirmed'), { label: 'platform-wallet collect on a Creator coin', advanceMs: 3600001, blocks: 3 });
  const collectOp = h.store.operationsFor(second.id).find(op => op.kind === 'collect');
  assert.equal(collectOp.wallet.toLowerCase(), h.host.platform.toLowerCase(), 'signed by the platform wallet');
  assert.ok((await h.chain.escrowBalance(coins[1].creator, null)) > creatorBefore, 'the creator’s share is in the escrow under the creator’s wallet');
  assert.ok((await h.chain.escrowBalance(h.host.platform, null)) > platformBefore, 'and the platform’s under the platform wallet');
  assert.ok(!h.store.operationsFor(second.id).some(op => op.kind === 'claim'), 'no claim: the creator claims from the coin page');
  // A coin made by the v71.39 contract set (its `curve` is a bonding-curve contract, not the PoolManager) stays in the
  // journal, out of tracking, out of Explore, flagged in the admin rows — the host never asks the new locker about it.
  const first = h.store.launch(coins[0].id);
  h.store.db.run("UPDATE launches SET curve = ?, pool_id = NULL WHERE id = ?", addr('old-bonding-curve'), first.id);
  const poolReadsBefore = h.chain.poolReads || 0, scansBefore3 = h.chain.scans || 0;
  h.advance(61000); await h.pass({ blocks: 1 });
  assert.ok((h.chain.poolReads || 0) > poolReadsBefore, 'the pool-native coins were read');
  assert.ok(!h.log.some(l => l.kind === 'robinhood-launch-error' && String(l.note || l.error || '').includes(first.token)), 'no errors about the legacy coin');
  assert.deepEqual((await h.service.publicList()).map(r => r.id).sort(), coins.slice(1).map(c => c.id).sort(), 'Explore lists the pool-native coins only');
  const admin = await h.service.adminOverview('owner', { limit: 50 });
  assert.equal(admin.rows.find(r => r.id === first.id).legacy, true, 'the admin row says which contract set made it');
  assert.equal(admin.rows.filter(r => r.legacy).length, 1);
  assert.ok((h.chain.scans || 0) + (h.chain.multiScans || 0) >= scansBefore3, 'the other coins keep scanning');
  await h.close();
});
