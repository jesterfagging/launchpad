// Robinhood launch venue against the real contracts on a local anvil chain: the whole service lifecycle with real
// signing, real receipts and real logs. Skipped unless LAUNCHPAD_ANVIL_RPC names a running anvil with the stack deployed
// (script/Deploy.s.sol against the real Uniswap v4 PoolManager, compiled from the vendored v4-core; anvil needs
// --hardfork cancun for its transient storage); the addresses come from LAUNCHPAD_ANVIL_FACTORY / ESCROW / LOCKER /
// ENGINE / ROUTER / PAYOUTS / POOL_MANAGER and LAUNCHPAD_ANVIL_KEY is a funded key (anvil's first account by default).
//
//   node --test test/robinhood-launch-anvil.integration.mjs   (with the environment set)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RobinhoodLaunchService } from '../src/robinhood-launch/service.mjs';
import { RobinhoodLaunchChain } from '../src/robinhood-launch/chain.mjs';
import { PairBook } from '../src/robinhood-launch/pairs.mjs';
import { ROBINHOOD_LAUNCH_POLICY } from '../src/robinhood-launch/policy.mjs';
import { ABI } from '../src/robinhood-launch/abi.mjs';
import { EvmRpc } from '../src/evm/rpc.mjs';
import { signTransaction } from '../src/evm/tx.mjs';
import { encodeCall, abiItem } from '../src/evm/abi.mjs';
import { privateKeyToAddress, randomPrivateKey } from '../src/evm/secp256k1.mjs';
import { parseEther, formatEther, hexToBigInt } from '../src/evm/hex.mjs';

const RPC = process.env.LAUNCHPAD_ANVIL_RPC || '';
const env = name => process.env[name] || '';
const addresses = { factory: env('LAUNCHPAD_ANVIL_FACTORY'), escrow: env('LAUNCHPAD_ANVIL_ESCROW'), locker: env('LAUNCHPAD_ANVIL_LOCKER'), engine: env('LAUNCHPAD_ANVIL_ENGINE'), payouts: env('LAUNCHPAD_ANVIL_PAYOUTS'), router: env('LAUNCHPAD_ANVIL_ROUTER'), poolManager: env('LAUNCHPAD_ANVIL_POOL_MANAGER') };
const DEPLOYER = env('LAUNCHPAD_ANVIL_KEY') || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const skip = !RPC || Object.values(addresses).some(a => !a);

class FakeHostStore { constructor() { this.docs = new Map(); } async read(name, fallback) { return this.docs.has(name) ? JSON.parse(JSON.stringify(this.docs.get(name))) : fallback; } async write(name, doc) { this.docs.set(name, JSON.parse(JSON.stringify(doc))); } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('the service runs a coin from quote to live, claims fees, pays holders and sees the graduation on anvil', { skip: skip ? 'set LAUNCHPAD_ANVIL_RPC and the LAUNCHPAD_ANVIL_* addresses' : false, timeout: 600000 }, async () => {
  const rpc = new EvmRpc({ url: RPC, chainId: 4663, insecure: true, requestsPerSecond: 200 });
  const dir = mkdtempSync(join(tmpdir(), 'rh-anvil-'));
  let clock = Date.now(); const now = () => clock;
  const log = [], logger = (kind, data) => log.push({ kind, ...data });
  const chain = new RobinhoodLaunchChain({ rpc, addresses, policy: ROBINHOOD_LAUNCH_POLICY, log: logger });
  const accounts = { hostStore: new FakeHostStore(), dir };
  const fetcher = async url => url.includes('/rhj/assets') ? { ok: true, json: async () => ({ assets: [] }) } : { ok: false, status: 404, json: async () => ({}) };
  const service = new RobinhoodLaunchService({
    accounts, chainFactory: async () => chain, pairBookFactory: async () => new PairBook({ rpc, fetcher, policy: ROBINHOOD_LAUNCH_POLICY, clock: now, ethUsdOverride: '4000' }),
    publishMetadata: async ({ mint }) => `https://launchpad.test/token-metadata/${mint}.json`, requireOwner: async () => true,
    config: { enabled: true, rpcUrl: RPC, addresses, treasury: '0x00000000000000000000000000000000000000Fe', dbPath: join(dir, 'rh.sqlite'), backupDir: '', ethUsdOverride: '4000', holderPayoutUsd: 1 }, now, log: logger,
  });
  const store = await service.ensure();
  // A helper to send a transaction from an outside key (the deployer, the creator, a buyer).
  async function sendFrom(key, { to, data = '0x', value = 0n, gas = 3000000n, expect = '0x1' }) {
    const from = privateKeyToAddress(key), fees = await rpc.feeData(), nonce = await rpc.getTransactionCount(from, 'pending');
    const signed = signTransaction({ chainId: 4663, nonce, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas * 2n + 1n, gas, to, value, data }, key);
    await rpc.sendRawTransaction(signed.raw);
    for (let i = 0; i < 100; i++) { const receipt = await rpc.getTransactionReceipt(signed.hash); if (receipt) { assert.equal(receipt.status, expect, `outside transaction ${expect === '0x1' ? 'succeeded' : 'reverted'}`); return signed.hash; } await sleep(200); }
    throw Error('not mined');
  }
  // A buy through the Launchpad swap router, as the coin page sends it (any router would do: the pool is a plain v4 pool).
  const buyData = (token, wei, recipient) => encodeCall(abiItem(ABI.router, 'buy'), [token, wei, 0n, recipient, BigInt(Math.floor(Date.now() / 1000) + 3600)]);
  // One worker pass per loop through the service's own run() (serialized like the timer's), the injected clock
  // keeping step with real time (plus any jump the step needs: a sampling interval, a cycle interval).
  async function runUntil(predicate, { passes = 60, advanceMs = 0, label = '' } = {}) {
    for (let i = 0; i < passes; i++) { await service.run(); if (await predicate()) return; clock += advanceMs + 1200; await sleep(1100); }
    throw Error(`condition not reached: ${label}; last error: ${service.lastError}; log tail: ${JSON.stringify(log.slice(-4))}`);
  }
  // 1. The host wallets become the factory owner and the platform recipient (as a real deploy would arrange).
  const host = await service.hostWallets();
  await sendFrom(DEPLOYER, { to: host.owner, value: parseEther('1'), gas: 21000n });
  await sendFrom(DEPLOYER, { to: host.platform, value: parseEther('0.5'), gas: 21000n });
  await sendFrom(DEPLOYER, { to: addresses.factory, data: encodeCall(abiItem(ABI.factory, 'transferOwnership'), [host.owner]) });
  await service.adminControl('owner', { flags: { intake: true, pairs: true }, reason: 'integration test' });
  const accepted = await service.adminControl('owner', { action: 'accept-ownership' });
  assert.ok(accepted.hash, 'ownership acceptance sent');
  await runUntil(async () => (await service.factoryState({ fresh: true })).owner.toLowerCase() === host.owner.toLowerCase(), { label: 'ownership accepted' });
  await service.adminControl('owner', { action: 'set-platform-recipient' });
  await runUntil(async () => (await service.factoryState({ fresh: true })).platformRecipient.toLowerCase() === host.platform.toLowerCase(), { label: 'platform recipient' });
  const status = await service.status(null);
  assert.equal(status.intakeOpen, true, 'intake open: ' + JSON.stringify(status.blockers));
  const pairs = await service.pairs(null);
  assert.deepEqual(pairs.pairs.map(p => p.symbol), ['ETH', 'USDG'], 'ETH and USDG approved at deploy');
  // 2. The creator quotes a Holders coin on the $4k tier with a 40% max-per-wallet rule and a 0.05 ETH first buy.
  const creatorKey = randomPrivateKey(), creator = privateKeyToAddress(creatorKey);
  await sendFrom(DEPLOYER, { to: creator, value: parseEther('2'), gas: 21000n });
  const session = { account: { id: 'acct1', role: 'user' }, walletVerified: false };
  const quoted = await service.quote(session, { requestKey: 'request-0001-aaaa', mode: 'holders', name: 'Anvil Coin', symbol: 'ANV', description: 'test', image: '/token-images/' + 'a'.repeat(64) + '.png', wallet: creator, tier: '4k', pairToken: 'eth', devBuy: '0.05', taxBps: 300, hooks: { rules: [{ id: 'max_per_wallet', settings: { maxPct: 40 } }] } }, { authorize: async () => {} });
  assert.equal(quoted.state, 'awaiting_funding'); assert.equal(quoted.tier.id, '4k'); assert.equal(quoted.rules, 1); assert.ok(quoted.feeWallet, 'a fee wallet for Holders');
  assert.equal(quoted.taxBps, 300); assert.equal(quoted.fees.curveTotalBps, 425); assert.equal(quoted.fees.poolTotalBps, 350); assert.equal(quoted.fees.curveShareBps, 3294, 'a 3% tax Holders coin: 4.25% curve pool, 1.4 of it the platform’s');
  assert.ok(BigInt(quoted.quote.totalWei) > parseEther('0.051'), 'the total covers the fee, the dev buy and gas');
  // 3. Funding from the creator's wallet, exactly as the page would send it.
  const funding = await service.prepareFunding(session, { launchId: quoted.id }, { authorize: async () => {} });
  assert.equal(funding.transactions.length, 1);
  const hash = await sendFrom(creatorKey, { to: funding.transactions[0].to, value: hexToBigInt(funding.transactions[0].value), data: funding.transactions[0].data, gas: 30000n });
  const submitted = await service.submitFunding(session, { launchId: quoted.id, txHashes: [hash] }, { authorize: async () => {} });
  assert.equal(submitted.state, 'funding_pending');
  await runUntil(async () => store.launch(quoted.id).state === 'created', { label: 'created' });
  const live = store.launch(quoted.id);
  assert.equal(live.curve.toLowerCase(), addresses.poolManager.toLowerCase(), 'the venue is the PoolManager'); assert.ok(live.pool_id && live.pool_id.length === 66, 'the pool id is recorded at creation'); assert.ok(BigInt(live.dev_tokens) > 0n, 'dev-buy tokens recorded');
  const tokenBalance = await chain.tokenBalance(live.token, creator);
  assert.equal(tokenBalance, BigInt(live.dev_tokens), 'the creator holds the dev-buy tokens directly');
  const record = await chain.launchRecord(live.token);
  assert.equal(record.creatorFeeRecipient.toLowerCase(), live.fee_wallet.toLowerCase(), 'the fee wallet is the creator fee recipient on chain');
  assert.equal(record.taxBps, 300); assert.equal(record.curveFee, 42500); assert.equal(record.poolFee, 35000); assert.equal(record.curveShareBps, 3294); assert.equal(record.poolShareBps, 1142);
  assert.equal(live.tax_bps, 300); assert.equal(live.curve_fee, 42500); assert.equal(live.pool_fee, 35000); assert.equal(live.curve_pool_id, live.pool_id, 'the curve pool trades first');
  // The refund of the unused funding reaches the creator.
  await runUntil(async () => store.launch(quoted.id).refund_state === 'complete', { label: 'refund', advanceMs: 61000 });
  assert.ok(BigInt(store.launch(quoted.id).refunded_wei) > 0n, 'leftover ETH refunded');
  // 4. A buyer trades through the router: the rule refuses a buy that would hold over 40% of the supply (the creator
  // was exempt for the dev buy; the refusal reverts the swap inside the PoolManager), a smaller one goes through, the
  // tracker records it from the Swap log, and the holder index sees both wallets. The pool's fees sit in the locked
  // positions until the fee wallet collects them into the escrow (the worker does, once they are worth the minimum).
  const buyerKey = randomPrivateKey(), buyer = privateKeyToAddress(buyerKey);
  await sendFrom(DEPLOYER, { to: buyer, value: parseEther('5'), gas: 21000n });
  await sendFrom(buyerKey, { to: addresses.router, data: buyData(live.token, parseEther('2.5'), buyer), value: parseEther('2.5'), expect: '0x0' });
  await sendFrom(buyerKey, { to: addresses.router, data: buyData(live.token, parseEther('0.2'), buyer), value: parseEther('0.2') });
  const collectable = await chain.collectable(live.token);
  assert.ok(collectable.quote > 0n, 'the pool holds fees to collect');
  clock += 61000; await service.run();
  assert.equal(service.holderCount(store.launch(quoted.id)), 2, 'creator and buyer indexed from Transfer logs (the PoolManager is not a holder)');
  assert.ok(store.trades(quoted.id, 10).some(t => t.wallet.toLowerCase() === buyer.toLowerCase() && t.side === 'buy' && t.attributed), 'the buy came in from the Swap log, attributed to the buyer');
  await runUntil(async () => (await chain.escrowBalance(live.fee_wallet, null)) > 0n, { label: 'pool fees collected into the escrow', advanceMs: 61000 });
  const owed = await chain.escrowBalance(live.fee_wallet, null);
  assert.ok(owed > 0n, 'fees owed to the fee wallet in the escrow');
  // 5. The claim and the holder payout (samples every five minutes for an hour; the threshold is $1 in this run).
  await runUntil(async () => store.balance(quoted.id, 'rewards', '0x0000000000000000000000000000000000000000').available > 0n, { label: 'claim', advanceMs: 300000 });
  const held = service.payoutHeld(store.launch(quoted.id)), costsBefore = store.balance(quoted.id, 'rewards', '0x0000000000000000000000000000000000000000').costs;
  assert.ok(held > 0n, 'rewards held');
  const gasLedger = store.balance(quoted.id, 'gas', '0x0000000000000000000000000000000000000000');
  assert.ok(gasLedger.credited === parseEther(quoted.quote.feeWalletGasEth) && gasLedger.costs > 0n && gasLedger.available > 0n, 'the seed paid the first claim’s gas: ' + JSON.stringify(gasLedger, (k, v) => typeof v === 'bigint' ? String(v) : v));
  const buyerBefore = await chain.ethBalance(buyer), creatorBefore = await chain.ethBalance(creator);
  await runUntil(async () => store.rewardCycles(quoted.id, 1)[0]?.state === 'complete', { label: 'payout', advanceMs: 300000, passes: 40 });
  const cycle = store.rewardCycles(quoted.id, 1)[0];
  assert.equal(cycle.payouts.length, 2, 'both holders paid'); assert.equal(cycle.skipped, 0);
  const paid = BigInt(cycle.paid);
  assert.ok(paid > 0n && paid <= held, 'paid what was held');
  assert.ok((await chain.ethBalance(buyer)) > buyerBefore && (await chain.ethBalance(creator)) > creatorBefore, 'both wallets received ETH');
  const after = store.balance(quoted.id, 'rewards', '0x0000000000000000000000000000000000000000');
  assert.ok(after.available <= held - paid && held - paid - after.available === after.costs - costsBefore, 'the ledger moved with the payout and charged its gas');
  assert.ok(after.costs > costsBefore && after.costs - costsBefore < parseEther('0.001'), 'the payout transaction cost a little gas');
  const view = await service.coinView(live.token);
  assert.equal(view.holderRewards.cycles[0].state, 'complete'); assert.equal(view.holders, 2); assert.ok(view.trades.length >= 2);
  // 6. Two whales fill the curve position (each under the 40% cap): the price crosses the graduation tick, the worker
  // runs the graduation from the owner wallet (the raise and the unsold supply move into the 3.5% graduation pool), the
  // tracked pool switches, and trading continues there.
  const whales = [randomPrivateKey(), randomPrivateKey()];
  for (const key of whales) await sendFrom(DEPLOYER, { to: privateKeyToAddress(key), value: parseEther('20'), gas: 21000n });
  await sendFrom(whales[0], { to: addresses.router, data: buyData(live.token, parseEther('1'), privateKeyToAddress(whales[0])), value: parseEther('1') });
  await sendFrom(whales[1], { to: addresses.router, data: buyData(live.token, parseEther('10'), privateKeyToAddress(whales[1])), value: parseEther('10') });
  const pool = await chain.poolState(live.token, live.pool_id);
  assert.equal(pool.crossed, true, 'the price is past the graduation tick'); assert.equal(pool.progressBps, 10000);
  await runUntil(async () => store.launch(quoted.id).venue_state === 'graduated' && store.operationsFor(quoted.id).some(op => op.kind === 'graduate' && op.state === 'confirmed'), { label: 'graduated (the owner wallet’s graduate transaction confirmed)', advanceMs: 61000 });
  const graduatedRow = store.launch(quoted.id);
  assert.notEqual(graduatedRow.pool_id, live.pool_id, 'the tracked pool is the graduation pool'); assert.equal(graduatedRow.curve_pool_id, live.pool_id, 'the curve pool is remembered');
  const graduatedRecord = await chain.launchRecord(live.token);
  assert.equal(graduatedRecord.poolId, graduatedRow.pool_id, 'the factory names the graduation pool'); assert.equal(graduatedRecord.curvePoolId, live.pool_id);
  const gradPool = await chain.poolState(live.token, graduatedRow.pool_id);
  assert.equal(gradPool.graduated, true); assert.equal(gradPool.curve, null, 'no curve position in the graduation pool'); assert.ok(gradPool.positions.length >= 1 && BigInt(gradPool.positions[0].liquidity) > 0n, 'the full-range position holds the liquidity'); assert.ok(BigInt(gradPool.liquidity) > 0n, 'the graduation pool is live at the price');
  assert.equal(gradPool.key.fee, 35000, 'the graduation pool charges 3.5%: 0.5% + the 3% tax');
  const tradesBefore = store.trades(quoted.id, 50).length;
  await sendFrom(buyerKey, { to: addresses.router, data: buyData(live.token, parseEther('0.1'), buyer), value: parseEther('0.1') }); // trading continues in the graduation pool, through the same router
  await runUntil(async () => store.trades(quoted.id, 50).length > tradesBefore, { label: 'a trade in the graduation pool journaled', advanceMs: 61000 });
  const lastTrade = store.trades(quoted.id, 1)[0];
  assert.equal(lastTrade.wallet.toLowerCase(), buyer.toLowerCase()); assert.equal(lastTrade.side, 'buy'); assert.ok(BigInt(lastTrade.quote) > 0n && BigInt(lastTrade.tokens) > 0n, 'the migration’s own swap was not journaled as a trade, the buyer’s was');
  const lateView = await service.coinView(live.token);
  assert.equal(lateView.feeShape.stage, 'pool'); assert.equal(lateView.recipients.platformShareBps, 1142); assert.equal(lateView.curve.tradeFeeBps, 350); assert.equal(lateView.pool.curvePoolId, live.pool_id); assert.ok(lateView.pool.positions.length >= 1);
  // The graduation pool's fees are collected with the pool-stage split.
  await runUntil(async () => store.operationsFor(quoted.id).filter(op => op.kind === 'collect' && op.state === 'confirmed').length >= 2, { label: 'a second collection, from the graduation pool', advanceMs: 3600000, passes: 30 });
  assert.ok((await chain.collectable(live.token)).quote < parseEther('0.001'), 'the graduation pool’s fees went into the escrow');
  const admin = await service.adminOverview('owner', {});
  assert.equal(admin.rows[0].state, 'created'); assert.equal(admin.factory.ownerIsHost, true); assert.equal(admin.rows[0].holders, 4); assert.equal(admin.rows[0].fees.stage, 'pool'); assert.equal(admin.rows[0].taxBps, 300);
  await service.close(); rmSync(dir, { recursive: true, force: true });
});
