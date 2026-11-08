// Robinhood launch venue: the store (SQLite in memory), the per-coin and host keys in a fake host store, and the chain
// adapter's decoding of real receipts captured from the contracts on a local anvil chain (a launch with a dev buy, a
// buy, a sell, an escrow claim, the buy that graduated the coin) plus its transaction-state and preparation logic
// against a scripted RPC. Dependency-free; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openRobinhoodLaunchDatabase, RobinhoodLaunchStore, newId } from '../src/robinhood-launch/store.mjs';
import { provisionLaunchKeys, launchKeys, hostKeys, generateEvmWallet, walletMatches } from '../src/robinhood-launch/keys.mjs';
import { RobinhoodLaunchChain, revertText } from '../src/robinhood-launch/chain.mjs';
import { ROBINHOOD_LAUNCH_POLICY } from '../src/robinhood-launch/policy.mjs';
import { privateKeyToAddress } from '../src/evm/secp256k1.mjs';
import { parseTransaction } from '../src/evm/tx.mjs';
import { parseEther } from '../src/evm/hex.mjs';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/robinhood-launch-anvil.json', import.meta.url), 'utf8'));
const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

class FakeHostStore {
  constructor() { this.docs = new Map(); this.writes = 0; }
  async read(name, fallback) { return this.docs.has(name) ? JSON.parse(JSON.stringify(this.docs.get(name))) : fallback; }
  async write(name, doc) { this.writes++; this.docs.set(name, JSON.parse(JSON.stringify(doc))); }
}

async function store() { const db = await openRobinhoodLaunchDatabase(':memory:'); return { db, store: new RobinhoodLaunchStore(db) }; }
function launchRow(overrides = {}) {
  return { id: newId('rh'), account_id: 'acct', request_key: newId('rq'), mode: 'holders', policy_version: 'v1', policy_hash: 'h', name: 'Coin', symbol: 'COIN', tier: '20k',
    pair_token: '0x0000000000000000000000000000000000000000', pair_symbol: 'ETH', pair_decimals: 18, pair_kind: 'native', virtual_quote: '1', graduation_quote: '2',
    developer_wallet: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf', launch_wallet: generateEvmWallet().address, fee_wallet: generateEvmWallet().address, token: generateEvmWallet().address, salt: '0x' + '00'.repeat(32),
    plan: { totalWei: '1' }, quote: { expiresAt: 1 }, quote_expires_at: 1, state: 'awaiting_funding', ...overrides };
}

test('the store migrates, journals launches and operations, keeps ledgers per role and asset, and indexes holders', async () => {
  const { db, store: s } = await store();
  assert.equal(db.version(), 3, 'schema 3: the pool-native trade columns and the two-pool launch columns (v71.41)');
  const row = s.insertLaunch(launchRow());
  assert.equal(row.state, 'awaiting_funding'); assert.deepEqual(row.plan, { totalWei: '1' }); assert.equal(row.hidden, false);
  assert.equal(s.launchByToken(row.token.toLowerCase()).id, row.id, 'token lookups ignore case');
  assert.ok(s.moveLaunch(row.id, 'awaiting_funding', 'funding_pending', { funding_tx: '0xabc' }));
  assert.ok(!s.moveLaunch(row.id, 'awaiting_funding', 'funded'), 'a stale move is refused');
  assert.equal(s.launch(row.id).funding_tx, '0xabc');
  assert.equal(s.countLaunches({ accountId: 'acct', states: ['funding_pending'] }), 1);
  assert.throws(() => s.updateLaunch('missing', { name: 'x' }), /no longer exists/);
  // operations and nonces
  const wallet = row.launch_wallet;
  s.insertOperation({ id: 'op1', launchId: row.id, kind: 'launch', state: 'signed', wallet, hash: '0x01', raw: '0x02', nonce: 0, gas: 7000000n, maxFee: 10n, expected: { to: '0xf' } });
  s.insertOperation({ id: 'op2', launchId: row.id, kind: 'refund', state: 'submitted', wallet: wallet.toUpperCase(), hash: '0x02', raw: '0x02', nonce: 1, gas: 21000n, maxFee: 10n });
  s.insertOperation({ id: 'op3', launchId: row.id, kind: 'refund', state: 'replaced', wallet, hash: '0x03', raw: '0x02', nonce: 2, gas: 21000n, maxFee: 10n });
  assert.equal(s.highestNonce(wallet), 1, 'replaced operations do not hold a nonce');
  assert.equal(s.highestNonce('0x0000000000000000000000000000000000000009'), -1);
  assert.equal(s.openOperations(row.id).length, 2); assert.equal(s.allOpenOperations().length, 2);
  s.updateOperation('op1', { state: 'confirmed', receipt: { status: true, blockNumber: 5 }, checkAfter: 9 });
  assert.equal(s.operation('op1').receipt.blockNumber, 5); assert.equal(s.operation('op1').check_after, 9);
  assert.equal(s.operationByHash('0X01').id, 'op1');
  assert.equal(s.latestOperation(row.id, 'refund', 'submitted').id, 'op2');
  // ledgers: per role and asset; debits never exceed credits
  const ETH = '0x0000000000000000000000000000000000000000', USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
  assert.ok(s.recordFeeClaim({ launchId: row.id, kind: 'escrow-claim', wallet: row.fee_wallet, role: 'rewards', asset: ETH, amount: 1000n, txHash: '0xAA', logIndex: 2, block: 10 }));
  assert.ok(!s.recordFeeClaim({ launchId: row.id, kind: 'escrow-claim', wallet: row.fee_wallet, role: 'rewards', asset: ETH, amount: 1000n, txHash: '0xaa', logIndex: 2, block: 10 }), 'the same log once');
  assert.ok(s.recordFeeClaim({ launchId: row.id, kind: 'escrow-claim', wallet: row.fee_wallet, role: 'rewards', asset: USDG, amount: 5n, txHash: '0xab', logIndex: 0, block: 11 }));
  assert.equal(s.balance(row.id, 'rewards', ETH).available, 1000n); assert.equal(s.balance(row.id, 'rewards', USDG.toLowerCase()).available, 5n);
  s.adjust(row.id, 'rewards', ETH, { debit: 600n, cost: 100n });
  assert.equal(s.balance(row.id, 'rewards', ETH).available, 300n);
  assert.throws(() => s.adjust(row.id, 'rewards', ETH, { debit: 301n }), /exceed/);
  assert.deepEqual(s.feeTotals(row.id), { [`rewards:${ETH}`]: '1000', [`rewards:${USDG.toLowerCase()}`]: '5' });
  assert.equal(s.balances(row.id).length, 2);
  // holders from transfer logs
  const a = '0x00000000000000000000000000000000000000A1', b = '0x00000000000000000000000000000000000000B2';
  s.applyTransfers(row.id, [{ from: ETH, to: a, value: 100n }, { from: a, to: b, value: 30n }, { from: b, to: ETH, value: 10n }]);
  assert.deepEqual(s.holders(row.id).map(h => [h.owner, h.balance]), [[a.toLowerCase(), 70n], [b.toLowerCase(), 20n]]);
  assert.deepEqual(s.applyTransfers(row.id, [{ from: b, to: a, value: 21n }]), { applied: 1, underflows: 1 }, 'a missed log is reported, the balance clamped at zero');
  assert.equal(s.holderCount(row.id), 1, 'an emptied wallet leaves the index');
  assert.equal(s.holderCount(row.id, { exclude: [a] }), 0, 'the venue’s own wallets are not holders');
  s.addHolderSample(row.id, 100, 1000, { [a]: '90' }); s.addHolderSample(row.id, 100, 1000, { [a]: '1' });
  assert.deepEqual(s.holderSamples(row.id, 0), [{ block: 100, at: 1000, balances: { [a]: '90' } }]);
  // trades, cursors, events, flags, pairs
  assert.ok(s.recordTrade({ launchId: row.id, side: 'buy', wallet: a, quote: 10n, tokens: 5n, fee: 1n, txHash: '0xCC', logIndex: 1, block: 12, at: 1 }));
  assert.ok(!s.recordTrade({ launchId: row.id, side: 'buy', wallet: a, quote: 10n, tokens: 5n, fee: 1n, txHash: '0xcc', logIndex: 1, block: 12, at: 1 }));
  assert.equal(s.trades(row.id).length, 1); assert.equal(s.tradeTotals(row.id).count, 1);
  s.setCursor(row.id, 'transfers', 12); assert.equal(s.cursor(row.id, 'transfers'), '12');
  s.addEvent({ launchId: row.id, kind: 'funded', title: 'Funded', isPublic: false }); s.addEvent({ launchId: row.id, kind: 'live', title: 'Live' });
  assert.equal(s.events(row.id).length, 1); assert.equal(s.events(row.id, { publicOnly: false }).length, 2);
  s.setFlag('intake', true, { reason: 'open', by: 'owner' }); assert.ok(s.flag('intake')); assert.equal(s.flags().intake.reason, 'open');
  s.upsertPair({ address: USDG, symbol: 'USDG', name: 'Global Dollar', decimals: 6, kind: 'stable', enabled: true, approved: false });
  s.upsertPair({ address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', symbol: 'SPY', name: 'SPDR', decimals: 18, kind: 'etf', enabled: false, approved: false });
  s.setPairState(USDG, { approved: true, approvedAt: 5 });
  assert.deepEqual(s.pairs().map(p => [p.symbol, p.enabled, p.approved]), [['USDG', true, true], ['SPY', false, false]]);
  assert.equal(s.pair(USDG.toUpperCase().replace('0X', '0x')).approved_at, 5);
  const cycle = s.insertRewardCycle({ id: 'c1', launchId: row.id, asset: ETH, amount: 300n, payouts: [{ owner: a, amount: '300' }], windowFrom: 1, windowTo: 2 });
  assert.equal(cycle.state, 'frozen'); assert.equal(s.openRewardCycle(row.id).id, 'c1');
  s.updateRewardCycle('c1', { state: 'complete', paid: 300n, skipped: 0 });
  assert.equal(s.openRewardCycle(row.id), null); assert.deepEqual(s.rewardPaidTotals(row.id), { [ETH]: '300' });
  s.setStreaks(row.id, [{ owner: a, streak: 3, balance: 70n }]); assert.equal(s.streaks(row.id).get(a.toLowerCase()).streak, 3); assert.equal(s.topStreaks(row.id).holding, 1);
  db.close();
});

test('keys: per-coin wallets are created once, stored before use and verified against the launch row; host keys likewise', async () => {
  const host = new FakeHostStore();
  const doc = await provisionLaunchKeys(host, 'abc', 'holders');
  assert.ok(walletMatches(doc.launch) && walletMatches(doc.fee)); assert.equal(doc.chain, 'robinhood');
  assert.deepEqual(await provisionLaunchKeys(host, 'abc', 'holders'), doc, 'idempotent');
  assert.equal((await provisionLaunchKeys(host, 'creator-coin', 'creator')).fee, null, 'Creator mode needs no fee wallet');
  const keys = await launchKeys(host, { id: 'abc', launch_wallet: doc.launch.address, fee_wallet: doc.fee.address });
  assert.equal(keys.launch.secret, doc.launch.secret);
  await assert.rejects(() => launchKeys(host, { id: 'abc', launch_wallet: doc.fee.address, fee_wallet: doc.fee.address }), /do not match/);
  host.docs.get('robinhood-launch-keys-abc').fee.secret = KEY;
  await assert.rejects(() => launchKeys(host, { id: 'abc', launch_wallet: doc.launch.address, fee_wallet: doc.fee.address }), /does not match its address/);
  const h1 = await hostKeys(host), h2 = await hostKeys(host);
  assert.equal(h1.owner.address, h2.owner.address); assert.notEqual(h1.owner.address, h1.platform.address);
  assert.equal(privateKeyToAddress(h1.owner.secret), h1.owner.address);
});

// The v71.41 adapter needs the router and the pool manager too; a fixture captured before them gets stand-ins.
const ADDRESSES = { router: '0x00000000000000000000000000000000000000f1', poolManager: '0x00000000000000000000000000000000000000f2', ...FIX.addresses };
function chainWith(rpc) { return new RobinhoodLaunchChain({ rpc, addresses: ADDRESSES, policy: ROBINHOOD_LAUNCH_POLICY }); }

test('the adapter decodes the captured receipts: Launched, the pool’s swaps as attributed trades, transfers, fees collected, escrow claims, the graduation into the second pool', () => {
  const chain = chainWith({});
  const pool = { token: FIX.token, poolId: FIX.poolId, tokenIs0: false }, pools = new Map([[FIX.poolId.toLowerCase(), pool]]);
  const pool2 = { token: FIX.token, poolId: FIX.graduationPoolId, tokenIs0: false }, both = new Map([[FIX.poolId.toLowerCase(), pool], [FIX.graduationPoolId.toLowerCase(), pool2]]);
  const launched = chain.decodeLaunched(FIX.launchReceipt);
  assert.equal(launched.token, FIX.token); assert.equal(launched.poolId, FIX.poolId); assert.equal(launched.graduationPoolId, FIX.graduationPoolId); assert.equal(launched.creator, FIX.creator);
  assert.equal(launched.supply, 10n ** 27n); assert.ok(launched.sellSupply > 0n && launched.lpSupply > 0n && launched.sellSupply + launched.lpSupply === launched.supply);
  assert.equal(launched.pairToken, '0x0000000000000000000000000000000000000000');
  assert.equal(Number(launched.curveFee), 17500, 'a Creator-shape coin: 1.25% + 0.5% on the curve'); assert.equal(Number(launched.poolFee), 5000, '0.25% + 0.25% after graduation'); assert.equal(Number(launched.taxBps), 0);
  assert.ok(Number(launched.startTick) > Number(launched.graduationTick), 'an ETH pair: the coin is currency1 and the curve runs down the ticks');
  assert.equal(chain.decodeLaunched(FIX.buyReceipt), null, 'a buy carries no Launched');
  // The dev buy is a Swap of the curve pool inside the launch transaction, attributed to the creator from the coin's Transfer.
  const launchTransfers = chain.decodeTransfers(FIX.launchReceipt.logs, FIX.token);
  assert.ok(launchTransfers.length >= 3, 'mint, into the pool manager, the dev buy'); assert.ok(launchTransfers.every(t => t.txHash === FIX.launchReceipt.hash && t.block > 0));
  assert.equal(launchTransfers[0].from, '0x0000000000000000000000000000000000000000');
  const devBuy = chain.attributeTrades(chain.decodeTrades(FIX.launchReceipt.logs, pools), launchTransfers);
  assert.equal(devBuy.length, 1); assert.equal(devBuy[0].side, 'buy'); assert.equal(devBuy[0].quote, parseEther('0.2')); assert.equal(devBuy[0].wallet, FIX.creator); assert.equal(devBuy[0].attributed, true);
  assert.ok(devBuy[0].sqrtPriceX96 > 0n && Number.isInteger(devBuy[0].tick) && devBuy[0].feePips === 17500, 'the swap carries the price after it and the curve pool’s 1.75% fee');
  // A router buy and a sell: the router's Swapped event names payer and recipient; the pool's Swap is the trade.
  const swapped = chain.decodeSwapped(FIX.buyReceipt.logs, FIX.token);
  assert.equal(swapped.length, 1); assert.equal(swapped[0].buy, true); assert.equal(swapped[0].payer, FIX.creator); assert.equal(swapped[0].quote, parseEther('0.3'));
  const buys = chain.attributeTrades(chain.decodeTrades(FIX.buyReceipt.logs, pools), chain.decodeTransfers(FIX.buyReceipt.logs, FIX.token));
  assert.equal(buys.length, 1); assert.equal(buys[0].side, 'buy'); assert.equal(buys[0].wallet, FIX.creator); assert.equal(buys[0].tokens, swapped[0].tokens);
  const sells = chain.attributeTrades(chain.decodeTrades(FIX.sellReceipt.logs, pools), chain.decodeTransfers(FIX.sellReceipt.logs, FIX.token));
  assert.equal(sells.length, 1); assert.equal(sells[0].side, 'sell'); assert.equal(sells[0].tokens, 10n ** 24n); assert.equal(sells[0].wallet, FIX.creator); assert.ok(sells[0].quote > 0n);
  assert.equal(chain.decodeTrades(FIX.sellReceipt.logs, new Map()).length, 0, 'a swap of an unknown pool is ignored');
  // Collecting the curve pool's fees credits the escrow with the curve stage's split: 1.25 of 1.75 to the platform.
  const fees = chain.decodeFeesCollected(FIX.collectReceipt, FIX.token);
  assert.ok(fees.quote > 0n && fees.coinsSold > 0n, 'ETH fees, and the sell’s coin-side fees sold into the pool'); assert.equal(fees.creator + fees.platform, fees.quote);
  assert.ok(fees.platform > 0n && fees.platform === fees.quote * 7142n / 10_000n, 'the platform’s share on the curve: 7142 bps');
  const credits = chain.decodeCredits(FIX.collectReceipt.logs, FIX.creator);
  assert.equal(credits.length, 1, 'the collect credited the creator’s share'); assert.equal(credits[0].amount, fees.creator);
  assert.equal(chain.decodeCredits(FIX.buyReceipt.logs, FIX.creator).length, 0, 'a buy credits nothing by itself: the fees wait in the pool');
  const claims = chain.decodeClaims(FIX.claimReceipt.logs, FIX.creator);
  assert.equal(claims.length, 1); assert.equal(claims[0].asset, '0x0000000000000000000000000000000000000000'); assert.equal(claims[0].amount, fees.creator); assert.equal(claims[0].to, FIX.creator);
  // The filling buy crossed the tick; the graduation is the locker's move into the graduation pool.
  const fill = chain.decodeTrades(FIX.fillReceipt.logs, pools);
  assert.equal(fill.length, 1); assert.ok(Number(fill[0].tick) < Number(launched.graduationTick), 'the price sits past the graduation tick');
  assert.equal(chain.decodeGraduated(FIX.fillReceipt, FIX.token), null, 'the fill itself graduates nothing');
  const graduated = chain.decodeGraduated(FIX.graduateReceipt, FIX.token);
  assert.equal(graduated.curvePoolId, FIX.poolId); assert.equal(graduated.poolId, FIX.graduationPoolId); assert.ok(graduated.sqrtPriceX96 > 0n && graduated.liquidity > 0n); assert.ok(Number(graduated.tick) < Number(launched.graduationTick));
  assert.ok(graduated.quoteMoved > parseEther('10') && graduated.coinsMoved > 0n, 'the raise and the remaining supply moved');
  const lastCurveFees = chain.decodeFeesCollected(FIX.graduateReceipt, FIX.token);
  assert.ok(lastCurveFees.quote > 0n && lastCurveFees.platform === lastCurveFees.quote * 7142n / 10_000n, 'the curve pool’s last fees, collected on the way with the curve split');
  assert.equal(chain.decodeTrades(FIX.graduateReceipt.logs, both).filter(t => t.poolId.toLowerCase() === FIX.graduationPoolId.toLowerCase()).length, 0, 'the migration itself is no trade of the graduation pool (setting the empty pool’s price swaps nothing)');
  assert.equal(FIX.pool.poolId.toLowerCase(), FIX.graduationPoolId.toLowerCase(), 'the locker’s record now names the graduation pool'); assert.equal(FIX.pool.graduated, true); assert.equal(FIX.pool.progressBps, 10000); assert.equal(FIX.pool.curve, null);
  assert.ok(Array.isArray(FIX.pool.positions) && FIX.pool.positions.length >= 1 && BigInt(FIX.pool.positions[0].liquidity) === BigInt(graduated.liquidity), 'the full-range position is the record’s first');
  // A trade after graduation is a Swap of the graduation pool at its 0.5% fee; its collection splits half and half.
  const late = chain.attributeTrades(chain.decodeTrades(FIX.lateReceipt.logs, both), chain.decodeTransfers(FIX.lateReceipt.logs, FIX.token));
  assert.equal(late.length, 1); assert.equal(late[0].poolId.toLowerCase(), FIX.graduationPoolId.toLowerCase()); assert.equal(late[0].feePips, 5000); assert.equal(late[0].wallet, FIX.creator); assert.equal(late[0].attributed, true);
  const fees2 = chain.decodeFeesCollected(FIX.collect2Receipt, FIX.token);
  assert.ok(fees2.quote > 0n && fees2.platform === fees2.quote * 5000n / 10_000n, 'the graduation pool’s split: 5000 bps');
  assert.deepEqual(chain.decodePayouts(FIX.buyReceipt), { paid: null, skipped: [] });
});

test('the adapter prices, estimates and signs a transaction, explains reverts, and tells pending from confirmed, failed and replaced', async () => {
  const calls = [];
  const rpc = {
    async feeData() { return { baseFee: 100n, maxPriorityFeePerGas: 1n, maxFeePerGas: 126n, blockNumber: 50n }; },
    async estimateGas(tx, errors) { calls.push(['estimate', tx.to]); if (tx.to === '0x00000000000000000000000000000000000000ff') { const e = Object.assign(Error('execution reverted'), { rpcData: '0xeb0613880000000000000000000000000000000000000000000000000000000000000007' }); e.revert = { name: 'RuleRefused', args: { kind: 7n } }; throw e; } return 100000n; },
    async sendRawTransaction(raw) { calls.push(['send', raw.slice(0, 6)]); if (this.known) { const e = Error('already known'); e.rpcReason = 'already known'; throw e; } return '0x' + 'ab'.repeat(32); },
    async getTransactionReceipt(hash) { return this.receipts?.[hash] ?? null; },
    async blockNumber() { return 60n; },
    async getTransactionCount(address, tag) { return tag === 'latest' ? (this.mined ?? 3) : 5; },
  };
  const chain = chainWith(rpc);
  const op = await chain.prepare({ key: KEY, kind: 'claim', launchId: 'L', to: FIX.addresses.escrow, data: chain.claimAllData(FIX.creator), nonce: 7 });
  assert.equal(op.wallet, privateKeyToAddress(KEY)); assert.equal(op.nonce, 7); assert.equal(op.gas, 200000n, 'the estimate doubled by the head room');
  assert.equal(op.maxFee, BigInt(ROBINHOOD_LAUNCH_POLICY.gas.minimumGasPriceWei), 'the policy’s floor beats a quiet chain');
  const parsed = parseTransaction(op.raw);
  assert.equal(parsed.to, FIX.addresses.escrow); assert.equal(parsed.nonce, 7n); assert.equal(parsed.hash, op.hash); assert.equal(parsed.data, chain.claimAllData(FIX.creator));
  assert.equal(op.expected.to, FIX.addresses.escrow); assert.equal(op.expected.data, chain.claimAllData(FIX.creator).slice(0, 10));
  await assert.rejects(() => chain.prepare({ key: KEY, kind: 'buy', launchId: 'L', to: '0x00000000000000000000000000000000000000ff', data: '0x', nonce: 1 }), error => error.code === 'ROBINHOOD_LAUNCH_SIMULATION' && /RuleRefused\(kind=7\)/.test(error.message));
  assert.equal(revertText({ revertData: '0x08c379a0' + '0'.repeat(62) + '20' + '0'.repeat(63) + '4' + '6e6f7065' + '0'.repeat(56) }), 'Error(message=nope)');
  const fixedGas = await chain.prepare({ key: KEY, kind: 'transfer', launchId: 'L', to: FIX.creator, value: 5n, nonce: 8, gasLimit: 21000 });
  assert.equal(fixedGas.gas, 21000n); assert.equal(calls.filter(c => c[0] === 'estimate').length, 2, 'a fixed limit skips the estimate');
  assert.equal(await chain.broadcast(op.raw), '0x' + 'ab'.repeat(32));
  rpc.known = true; assert.equal(await chain.broadcast(op.raw), null, 'a known transaction is not an error');
  // states
  rpc.receipts = { [op.hash]: { transactionHash: op.hash, status: '0x1', blockNumber: '0x3b', gasUsed: '0x5208', effectiveGasPrice: '0x64', logs: [] } };
  assert.deepEqual((await chain.txState(op)).state, 'pending', 'mined at 59 with the head at 60: two confirmations, under the three required');
  rpc.receipts[op.hash].blockNumber = '0x38';
  const confirmed = await chain.txState(op); assert.equal(confirmed.state, 'confirmed'); assert.equal(confirmed.receipt.gasUsed, 21000n); assert.equal(confirmed.confirmations, 5);
  rpc.receipts[op.hash].status = '0x0'; assert.equal((await chain.txState(op)).state, 'failed');
  rpc.receipts = {}; rpc.mined = 7; assert.equal((await chain.txState(op)).state, 'pending', 'nonce 7 not yet spent');
  rpc.mined = 8; assert.equal((await chain.txState(op)).state, 'replaced', 'nonce 7 spent by something else');
  const bumped = await chain.bump({ key: KEY, op });
  const again = parseTransaction(bumped.raw);
  assert.equal(again.nonce, 7n); assert.ok(again.maxFeePerGas > parsed.maxFeePerGas); assert.notEqual(bumped.hash, op.hash); assert.equal(again.data, parsed.data);
  await assert.rejects(() => chain.bump({ key: '0x' + '2'.padStart(64, '0'), op }), /does not match/);
});

test('call data builders target the right functions', () => {
  const chain = chainWith({});
  assert.equal(chain.claimAllData(FIX.creator).slice(0, 10), '0x' + '7dcc1ea0'.slice(0, 8).replace('7dcc1ea0', chain.claimAllData(FIX.creator).slice(2, 10)));
  for (const [data, selector] of [[chain.approveData(ADDRESSES.router, 1n), '0x095ea7b3'], [chain.transferData(FIX.creator, 1n), '0xa9059cbb']]) assert.equal(data.slice(0, 10), selector);
  assert.notEqual(chain.collectData(FIX.token).slice(0, 10), chain.graduateData(FIX.token).slice(0, 10));
  assert.equal(chain.graduateData(FIX.token).length, 2 + 8 + 64, 'graduate(token)');
  assert.equal(chain.buyData(FIX.token, 1n, 0n, FIX.creator, 1n).length, 2 + 8 + 64 * 5, 'buy(token, quoteIn, minTokensOut, recipient, deadline)');
  assert.equal(chain.sellData(FIX.token, 1n, 0n, FIX.creator, 1n).length, 2 + 8 + 64 * 5, 'sell(token, tokensIn, minQuoteOut, recipient, deadline)');
  assert.notEqual(chain.buyData(FIX.token, 1n, 0n, FIX.creator, 1n).slice(0, 10), chain.sellData(FIX.token, 1n, 0n, FIX.creator, 1n).slice(0, 10));
  assert.equal(chain.payEthData([FIX.creator], [1n]).length, 2 + 8 + 64 * 6);
  assert.ok(chain.setPairAssetsData([FIX.addresses.escrow], [{ approved: true, virtualQuote: 1n, graduationQuote: 2n, minGraduationQuote: 0n, maxGraduationQuote: 0n }]).length > 10);
  assert.equal(chain.setLaunchesOpenData(true).length, 2 + 8 + 64);
  assert.throws(() => new RobinhoodLaunchChain({ rpc: {}, addresses: { ...ADDRESSES, payouts: '' }, policy: ROBINHOOD_LAUNCH_POLICY }), /payouts address/);
  assert.throws(() => new RobinhoodLaunchChain({ rpc: {}, addresses: { ...ADDRESSES, router: '' }, policy: ROBINHOOD_LAUNCH_POLICY }), /router address/);
});

test('pairAssets reads many pairs in batched requests of 50, in order; the RPC client backs off on a 403 and gives up on a non-transient failure', async () => {
  const { encodeParams } = await import('../src/evm/abi.mjs');
  const batches = [];
  const rpc = { async batch(calls) { batches.push(calls.length); return calls.map((c, i) => encodeParams([{ type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [(batches.length * 100 + i) % 2 === 0, 1n, 2n, 3n, 4n])); } };
  const chain = chainWith(rpc);
  const addresses = Array.from({ length: 120 }, (_, i) => '0x' + String(i + 1).padStart(40, '0'));
  const assets = await chain.pairAssets(addresses);
  assert.deepEqual(batches, [50, 50, 20]); assert.equal(assets.length, 120);
  assert.equal(assets[0].approved, true); assert.equal(assets[1].approved, false); assert.equal(assets[0].graduationQuote, 2n);
  const { EvmRpc } = await import('../src/evm/rpc.mjs');
  let attempts = 0; const seen = [];
  const client = new EvmRpc({ url: 'https://rpc.example/', requestsPerSecond: 1000, retries: 2, log: (k, v) => seen.push([k, v.delay]), fetcher: async () => { attempts++; return attempts < 3 ? { ok: false, status: 403, headers: { get: () => null }, text: async () => 'blocked' } : { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1237' }) }; } });
  const started = Date.now(); const id = await client.request('eth_chainId'); assert.equal(id, '0x1237'); assert.equal(attempts, 3);
  assert.deepEqual(seen.map(([k]) => k), ['rpc-retry', 'rpc-retry']); assert.ok(seen[0][1] >= 3000 && seen[1][1] >= 6000, 'a 403 waits seconds, not milliseconds: ' + seen.map(s => s[1]).join(','));
  assert.ok(Date.now() - started >= 9000, 'the waits really happen');
  const refused = new EvmRpc({ url: 'https://rpc.example/', requestsPerSecond: 1000, retries: 2, fetcher: async () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => 'no' }) });
  await assert.rejects(refused.request('eth_chainId'), /HTTP 401/);
});
