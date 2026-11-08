import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { RobinhoodTelegram } from '../src/robinhood-telegram.mjs';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { parseEther, parseTransaction, keccak256, decodeFunctionData, decodeAbiParameters, parseAbiParameters, encodeAbiParameters, encodeEventTopics } from 'viem';
import { AccountService } from '../src/accounts.mjs';
import { settingsSecrets } from '../src/account-secrets.mjs';
import { TelegramStore } from '../src/telegram-store.mjs';
import { TelegramBot } from '../src/telegram-bot.mjs';
import { createAccountApp } from '../src/account-app.mjs';
import { createRobinhoodAccount, cleanRobinhoodSettings, generateEvmWallets, evmWallet, ChainStore, ensureRobinhoodAccount } from '../src/robinhood-settings.mjs';

test('Robinhood imports bare or prefixed hex keys into the same market-making wallet without accepting other key types', () => {
  const hex='ab'.repeat(32), canonical=evmWallet({privateKey:`0x${hex}`,tool:'market'});
  for(const value of [hex,`  ${hex}  `,hex.toUpperCase(),`0X${hex.toUpperCase()}`]){
    const wallet=evmWallet({privateKey:value,publicKey:canonical.publicKey,tool:'market'});
    assert.equal(wallet.publicKey,canonical.publicKey);assert.equal(wallet.privateKey,`0x${hex}`);assert.equal(wallet.tool,'market');
  }
  for(const value of ['ab'.repeat(20),'a'.repeat(63),'z'.repeat(64),'5'.repeat(88),'one two three four','0'.repeat(64),'f'.repeat(64)])assert.throws(()=>evmWallet({privateKey:value}),/EVM private key/);
  assert.throws(()=>evmWallet({privateKey:hex,publicKey:'0x1111111111111111111111111111111111111111'}),/match/);
  const settings=createRobinhoodAccount().settings;
  settings.wallets.push({...canonical,privateKey:hex},{...canonical,privateKey:`0x${hex}`});
  assert.throws(()=>cleanRobinhoodSettings(settings),/only be imported once/);
});
import { RobinhoodFeePolicy } from '../src/robinhood-policy.mjs';
import { RobinhoodRuntimeManager } from '../src/robinhood-runtime.mjs';
import { RobinhoodExecutor } from '../src/robinhood-executor.mjs';
import { RobinhoodEngine } from '../src/robinhood-engine.mjs';
import { RobinhoodRpc, strictUnits } from '../src/robinhood-rpc.mjs';
import { buildSwapPlan, RobinhoodPools } from '../src/robinhood-pools.mjs';
import { buildLpDeposit, buildLpWithdrawal, lpFeePpm, rangeTicks, sqrtAtTick, liquidityForAmounts, amountsForLiquidity } from '../src/robinhood-liquidity.mjs';
import { verifyEvmFee } from '../src/robinhood-cashback.mjs';
import { CONTRACTS, routerAbi, positionAbi, erc20Abi, poolAbi, poolId, EVM_NATIVE } from '../src/robinhood-contracts.mjs';

const token = '0x1111111111111111111111111111111111111111', stock = '0x2222222222222222222222222222222222222222', collector = '0x3333333333333333333333333333333333333333';
const pool = { currency0: EVM_NATIVE, currency1: token, fee: 3000, tickSpacing: 60, hooks: EVM_NATIVE };
const book = () => ({ data: { version: 1, lots: [], pending: [], seen: [], events: [], feeReceipts: [] }, async save() {}, addEvent(e) { this.data.events.unshift(e); }, async remember(k) { if (this.data.seen.includes(k)) return false; this.data.seen.push(k); return true; } });
class FakeEngine extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.current = { kind: 'copy', positions: [], events: [], pending: [] }; }
  status() { return { ...this.current, state: this.state }; }
  async start(raw, kind) { this.raw = raw; this.state = 'running'; this.current.kind = kind; this.emit('change'); return this.status(); }
  async manualTrade(raw, trade) { this.trade = trade; return this.status(); }
  stop() { this.state = 'stopped'; this.emit('change'); }
  async close() { this.stop(); }
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-robinhood-')), accounts = await new AccountService(dir).init();
  const user = await accounts.register('robinhood_test', 'a-strong-test-password'), second = await accounts.register('robinhood_other', 'a-strong-test-password');
  const policy = new RobinhoodFeePolicy(accounts, { verifyRecipient: async () => {}, adapterAddress: () => collector }); await policy.setRecipient(collector);
  const workers = [], manager = new RobinhoodRuntimeManager(accounts, policy, { maxActive: 5, engineFactory: (store, context, options) => { const engine = new FakeEngine(); workers.push({ store, context, options, engine }); return engine; } });
  t.after(async () => { await manager.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, accounts, user, second, policy, manager, workers };
}
test('Robinhood creates separate recoverable tool keys and an unselected cashback wallet', async t => {
  const h = await fixture(t), data = await ensureRobinhoodAccount(h.accounts, h.user.id);
  assert.equal(data.settings.wallets.length, 4);
  const keys = new Set([data.mainWallet.publicKey, ...data.settings.wallets.map(w => w.publicKey)]); assert.equal(keys.size, 5);
  assert.notEqual(data.mainWallet.publicKey, h.user.mainWallet);
  for (const [kind, key] of Object.entries(data.settings.defaultWallets)) { assert.deepEqual(data.settings.runWallets[kind], [key]); assert.equal(evmWallet(data.settings.wallets.find(w => w.publicKey === key)).publicKey, key); }
  assert(!data.settings.wallets.some(w => w.publicKey === data.mainWallet.publicKey));
  assert.deepEqual((await Promise.all(Array.from({ length: 4 }, () => ensureRobinhoodAccount(h.accounts, h.user.id)))).map(x => x.mainWallet), Array(4).fill(data.mainWallet));
});
test('older accounts lazily create one stable Robinhood cashback wallet at 100% cashback', async t => {
  const h = await fixture(t), store = h.accounts.storeFor(h.user.id);
  await unlink(store.path('robinhood-account')); // Account from before Robinhood support.
  await h.accounts.setCashback(h.user.id, 10000);
  const rows = await Promise.all(Array.from({ length: 8 }, () => ensureRobinhoodAccount(h.accounts, h.user.id)));
  assert(rows.every(row => row.mainWallet.publicKey === rows[0].mainWallet.publicKey && row.mainWallet.privateKey === rows[0].mainWallet.privateKey));
  assert(!rows[0].settings.wallets.some(w => w.publicKey === rows[0].mainWallet.publicKey));
  const policy = await h.policy.get(h.user.id); assert.equal(policy.cashbackBps, 10000); assert.equal(policy.mainWallet, rows[0].mainWallet.publicKey);
  await h.accounts.setCashback(h.user.id, 0); assert.deepEqual((await ensureRobinhoodAccount(h.accounts, h.user.id)).mainWallet, rows[0].mainWallet);
});
test('Telegram ETH budgets and bare key imports persist to the same account settings used by the website', async t => {
  const h = await fixture(t), messages = [];
  const bot = { now: () => 1000, deleteInput: async () => {}, button: (_ctx, title, op, args) => ({ title, op, args }), say: (_ctx, message) => messages.push(message) };
  const telegram = new RobinhoodTelegram(bot, { runtimes: h.manager, policy: h.policy });
  const saved = await h.manager.readSettings(h.user.id);
  const ctx = { account: h.user, chain: 'robinhood', tool: 'market', revision: 1, generation: 1, engine: h.manager.get(h.user.id), settings: saved.settings, settingsRevision: saved.revision };
  for (const kind of ['market', 'liquidity']) {
    ctx.tool = kind;
    await telegram.action(ctx, 'rhField', { key: 'budgetEth' });
    await telegram.message(ctx, { text: '0.025' });
    const web = await h.manager.readSettings(h.user.id);
    assert.equal(web.settings.tools[kind].budgetEth, '0.025');
    await telegram.review(ctx); assert.match(messages.at(-1), /Configured total: 0.025 ETH/); assert.match(messages.at(-1), /Pool and conversion routes: Automatic/);
  }
  ctx.tool = 'market';
  const key = generateEvmWallets(1, ctx.settings.wallets, 'market')[0].privateKey;
  await telegram.action(ctx, 'rhImport'); await telegram.message(ctx, { text: key.slice(2) });
  const web = await h.manager.readSettings(h.user.id), imported = web.settings.wallets.find(w => w.privateKey === key);
  assert(imported); assert.equal(imported.tool, 'market'); assert(web.settings.runWallets.market.includes(imported.publicKey));
  assert(messages.every(message => !message.includes(key) && !message.includes(key.slice(2))));
  await telegram.review(ctx); assert.match(messages.at(-1), /Configured total: 0.05 ETH across 2 wallet/);
});
test('caps are 25 shared Copy/Sniping, 10 LP and 5 MM; generation cannot exceed them', () => {
  const data = createRobinhoodAccount(), wallets = data.settings.wallets;
  wallets.push(...generateEvmWallets(23, wallets, 'copy')); assert.equal(wallets.filter(w => w.tool === 'copy').length, 25);
  assert.throws(() => generateEvmWallets(1, wallets, 'sniper'), /25/);
  wallets.push(...generateEvmWallets(9, wallets, 'liquidity')); assert.throws(() => generateEvmWallets(1, wallets, 'liquidity'), /10/);
  wallets.push(...generateEvmWallets(4, wallets, 'market')); assert.throws(() => generateEvmWallets(1, wallets, 'market'), /5/);
  assert.throws(() => generateEvmWallets(0, wallets, 'market'));
});
test('settings reject wrong chains, forged keys, duplicate wallets and more than 100 leads/developers', () => {
  const raw = createRobinhoodAccount().settings;
  assert.throws(() => cleanRobinhoodSettings({ ...raw, chainId: 1 }), /4663/);
  assert.throws(() => cleanRobinhoodSettings({ ...raw, mode: 'paper' }));
  assert.throws(() => evmWallet({ ...raw.wallets[0], publicKey: token }), /match/);
  assert.throws(() => cleanRobinhoodSettings({ ...raw, wallets: [...raw.wallets, raw.wallets[0]] }), /once/);
  const leads = Array.from({ length: 101 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
  assert.throws(() => cleanRobinhoodSettings({ ...raw, tools: { copy: { leads } } }), /100/);
  assert.throws(() => cleanRobinhoodSettings({ ...raw, tools: { sniper: { developers: leads } } }), /100/);
  assert.throws(() => cleanRobinhoodSettings({ ...raw, rpcUrl: 'https://127.0.0.1' }));
});
test('encrypted chain journals and opaque credential references cannot cross users or chains', async t => {
  const h = await fixture(t), store = h.accounts.storeFor(h.user.id), chain = new ChainStore(store);
  await store.write('live', { marker: 'solana' }); await chain.write('live', { marker: 'robinhood' });
  assert.equal((await store.read('live')).marker, 'solana'); assert.equal((await chain.read('live')).marker, 'robinhood');
  const raw = (await h.manager.readSettings(h.user.id)).settings, protectedRh = settingsSecrets(h.accounts.master, `${h.user.id}:robinhood`, raw).protectedSettings;
  assert(!JSON.stringify(protectedRh).includes(raw.wallets[0].privateKey));
  assert.throws(() => settingsSecrets(h.accounts.master, h.user.id, raw).resolve(protectedRh));
  assert.throws(() => settingsSecrets(h.accounts.master, `${h.second.id}:robinhood`, raw).resolve(protectedRh));
});
test('settings revisions prevent lost updates and wallet generation is saved before keys are returned', async t => {
  const h = await fixture(t), saved = await h.manager.readSettings(h.user.id);
  const next = await h.manager.generateWallets(h.user.id, saved.settings, saved.revision, 2, 'market');
  assert.equal(next.generated.length, 2); assert(!('privateKey' in next.generated[0]));
  assert.equal((await h.manager.readSettings(h.user.id)).settings.wallets.length, 6);
  await assert.rejects(h.manager.saveSettings(h.user.id, saved.settings, saved.revision), /changed/);
});
test('fees use the Solana rates, separate ETH collection, and owner-controlled cashback', async t => {
  const h = await fixture(t), before = await h.policy.get(h.user.id);
  assert.equal(before.copyPpm, 2500); assert.equal(before.sniperPpm, 10000); assert.equal(before.marketPpm, 1000); assert.equal(before.settlement, 'eth');
  await h.accounts.setCashback(h.user.id, 2500); const next = await h.policy.get(h.user.id);
  assert.notEqual(next.version, before.version); assert.equal(next.cashbackBps, 2500); assert.equal((await h.policy.get(h.second.id)).cashbackBps, 0);
  assert.equal(await h.accounts.hostStore.read('fee-policy'), null); assert.equal((await h.accounts.hostStore.read('robinhood-fee-policy')).recipient, collector);
});
test('runs and reservations keep Copy and Sniping from sharing an active wallet', async t => {
  const h = await fixture(t), raw = (await h.manager.readSettings(h.user.id)).settings; raw.agreedFeeVersion = (await h.policy.get(h.user.id)).version;
  const run = h.manager.get(h.user.id); await run.start(raw, 'copy');
  assert.equal(h.workers[0].options.chain, 'robinhood'); assert.equal(h.workers[0].context.chainId, 4663);
  const same = structuredClone(raw); same.runWallets.sniper = [...same.runWallets.copy];
  await assert.rejects(run.start(same, 'sniper'), /reserved/);
  await run.start(raw, 'sniper'); assert.equal(h.manager.ownActiveCount(), 2);
  run.stop('copy'); assert.equal(run.status('copy').state, 'stopped'); assert.equal(run.status('sniper').state, 'running');
  const other = (await h.manager.readSettings(h.second.id)).settings; other.agreedFeeVersion = (await h.policy.get(h.second.id)).version;
  await h.manager.get(h.second.id).start(other, 'copy'); run.stop(); assert.equal(h.manager.get(h.second.id).status('copy').state, 'running');
});
test('late Stop cancels startup before any trading worker is created', async t => {
  const h = await fixture(t), raw = (await h.manager.readSettings(h.user.id)).settings; raw.agreedFeeVersion = (await h.policy.get(h.user.id)).version;
  const run = h.manager.get(h.user.id), pending = run.start(raw, 'copy'); run.stop('copy');
  await assert.rejects(pending, /stopped/); assert.equal(h.workers.length, 0); assert.equal(run.busy, false);
});
test('native fees are inside a non-optional swap transaction and do not overspend the budget', async () => {
  const wallet = createRobinhoodAccount().settings.wallets[0].publicKey;
  const plan = await buildSwapPlan({ pools: { quote: async (p, input, amount) => amount * 2n }, pool, input: EVM_NATIVE, amount: parseEther('20'), wallet, recipient: collector, ppm: 2500, slippageBps: 200 });
  assert.equal(plan.feeEth, String(parseEther('0.05'))); assert.equal(plan.value, parseEther('20'));
  const { args } = decodeFunctionData({ abi: routerAbi, data: plan.data }); assert.equal(args[0], '0x051004');
  const transfer = decodeAbiParameters(parseAbiParameters('address,address,uint256'), args[1][0]); assert.equal(transfer[1], collector); assert.equal(transfer[2], parseEther('0.05'));
  assert.equal(plan.approvals.length, 0); assert.equal(plan.minimum, String(parseEther('19.95') * 2n * 98n / 100n));
});
test('token fees convert to ETH and the conversion failure prevents building a live swap', async () => {
  const p = { currency0: token, currency1: stock, fee: 500, tickSpacing: 10, hooks: EVM_NATIVE }, fp = { currency0: EVM_NATIVE, currency1: stock, fee: 3000, tickSpacing: 60, hooks: EVM_NATIVE };
  const args = { pool: p, input: token, amount: 1000000n, wallet: collector, recipient: collector, ppm: 10000, slippageBps: 200 };
  const plan = await buildSwapPlan({ ...args, pools: { feePath: async () => [p, fp], quote: async (p, input, amount) => amount * 2n } });
  assert.equal(plan.approvals[0].amount, '1000000'); assert.equal(plan.feeInput, '10000'); assert.equal(plan.feeEth, '38416');
  const { args: commands } = decodeFunctionData({ abi: routerAbi, data: plan.data }); assert(commands[0].includes('05')); assert(!commands[0].slice(2).match(/../g).some(c => parseInt(c, 16) & 128));
  await assert.rejects(buildSwapPlan({ ...args, pools: { feePath: async () => { throw Error('No ETH route'); } } }), /ETH route/);
});
test('LP math stays integral, fees follow tiers, and deposits use explicit liquidity with maxima', async () => {
  assert.equal(sqrtAtTick(0), 2n ** 96n); assert.equal(sqrtAtTick(-887272), 4295128739n);
  assert.equal(sqrtAtTick(887272), 1461446703485210103287273052203988822378723970342n);
  assert.deepEqual([500, 3000, 10000].map(lpFeePpm), [50, 150, 250]);
  const ticks = rangeTicks(0, 60, 'balanced'), amount = 10n ** 18n, liquidity = liquidityForAmounts(2n ** 96n, ticks.lower, ticks.upper, amount, amount);
  assert(amountsForLiquidity(2n ** 96n, ticks.lower, ticks.upper, liquidity).every(a => a <= amount && a > amount - 100n));
  const plan = await buildLpDeposit({ pools: { state: async () => ({ tick: 0, sqrtPriceX96: 2n ** 96n }) }, pool, wallet: collector, amount0: amount, amount1: amount, preset: 'balanced', rangeBps: 2000, slippageBps: 200 });
  const { args } = decodeFunctionData({ abi: positionAbi, data: plan.data }), [actions] = decodeAbiParameters(parseAbiParameters('bytes,bytes[]'), args[0]); assert.equal(actions, '0x020d14'); assert.equal(plan.value, amount);
});
test('manual LP withdrawal has no platform fee; automatic fee is atomic with withdrawal', async () => {
  const lot = { tokenId: '1', pool, lower: -60, upper: 60 }, rpc = { client: { readContract: async q => q.functionName === 'ownerOf' ? collector : 100000000000000000000n } };
  const pools = { state: async () => ({ tick: 0, fee: 3000, sqrtPriceX96: 2n ** 96n }), feePath: async () => [pool], quote: async (p, i, a) => a };
  const args = { rpc, pools, lot, wallet: collector, recipient: token, slippageBps: 200 };
  const manual = await buildLpWithdrawal({ ...args, automatic: false }), auto = await buildLpWithdrawal({ ...args, automatic: true });
  assert.equal(manual.feeEth, '0'); assert.equal(manual.value, 0n); assert(BigInt(auto.feeEth) > 0n); assert.equal(auto.value, BigInt(auto.feeEth));
  const decoded = decodeFunctionData({ abi: positionAbi, data: auto.data }), [actions] = decodeAbiParameters(parseAbiParameters('bytes,bytes[]'), decoded.args[0]); assert.equal(actions, '0x011114');
});
test('wrong-chain RPC and excessive decimal precision fail before signing', async () => {
  const rpc = new RobinhoodRpc(createRobinhoodAccount().settings); rpc.client = { getChainId: async () => 1 };
  await assert.rejects(rpc.connect(), /4663/); assert.throws(() => strictUnits('0.0000001', 6), /decimal/); assert.equal(strictUnits('.0003', 18), 300000000000000n);
});
test('simulation failure never signs, journals, or broadcasts a trade', async () => {
  const data = createRobinhoodAccount(), wallet = data.settings.wallets[0], ledger = book(); let sent = 0;
  const rpc = { config: data.settings, client: { getTransactionCount: async () => 0, getBalance: async () => parseEther('10'), getBlock: async () => ({ baseFeePerGas: 1n }), estimateGas: async () => { throw Error('Simulation reverted'); } }, request: async () => { sent++; } };
  const executor = new RobinhoodExecutor(rpc, ledger, { policy: {} });
  await assert.rejects(executor.send(wallet, { to: collector, data: '0x', value: 0n }), /Simulation/); assert.equal(sent, 0); assert.equal(ledger.data.pending.length, 0);
});
test('ambiguous broadcasts retain signed chain-4663 journals and block nonce reuse', async () => {
  const data = createRobinhoodAccount(), wallet = data.settings.wallets[0], ledger = book(), abort = new AbortController(); let persisted = false;
  ledger.save = async () => { if (ledger.data.pending[0]?.attempted) persisted = true; };
  const rpc = { config: data.settings, client: { getTransactionCount: async () => 0, getBalance: async () => parseEther('10'), getBlock: async () => ({ baseFeePerGas: 1n }), estimateGas: async () => 21000n }, request: async ({ method, params }) => {
    if (method === 'eth_sendRawTransaction') { assert(persisted); assert.equal(parseTransaction(params[0]).chainId, 4663); assert.equal(keccak256(params[0]), ledger.data.pending[0].signature); abort.abort(); throw Error('connection lost'); }
    return null;
  } };
  const executor = new RobinhoodExecutor(rpc, ledger, { policy: {}, signal: abort.signal });
  await assert.rejects(executor.send(wallet, { to: collector, data: '0x', value: 0n }), /unresolved/);
  assert.equal(ledger.data.pending.length, 1); const fresh = new RobinhoodExecutor(rpc, ledger, { policy: {} }); assert.throws(() => fresh.check(wallet.publicKey), /unresolved/);
});
test('reverted transactions clear pending without recording a platform fee', async () => {
  const ledger = book(), pending = { signature: `0x${'ab'.repeat(32)}`, wallet: token, to: collector, attempted: true, context: {}, fee: { amount: '12' } }; ledger.data.pending.push(pending);
  const rpc = { client: {}, request: async ({ method }) => method === 'eth_getBlockByNumber' ? { hash: '0x1' } : { transactionHash: pending.signature, from: token, to: collector, status: '0x0', blockNumber: '0x2', blockHash: '0x1' } };
  const executor = new RobinhoodExecutor(rpc, ledger); await executor.reconcile(pending); assert.equal(ledger.data.pending.length, 0); assert.equal(ledger.data.feeReceipts.length, 0);
});
test('cashback verification rejects a changed recipient, failed receipt or different chain', async () => {
  const plan = await buildSwapPlan({ pools: { quote: async (p, i, a) => a }, pool, input: EVM_NATIVE, amount: parseEther('1'), wallet: token, recipient: collector, ppm: 2500, slippageBps: 200 });
  const signature = `0x${'11'.repeat(32)}`, receipt = { chainId: 4663, signature, wallet: token, recipient: collector, mainWallet: stock, amount: plan.feeEth, cashbackBps: 2000, cashbackAmount: String(BigInt(plan.feeEth) / 5n), evidence: { to: plan.to, data: plan.data, value: String(plan.value) } };
  const tx = { chainId: 4663, hash: signature, from: token, to: plan.to, input: plan.data, value: plan.value };
  assert.equal(verifyEvmFee(receipt, tx, { status: 'success' }, stock).amount, plan.feeEth);
  assert.throws(() => verifyEvmFee({ ...receipt, recipient: stock }, tx, { status: 'success' }, stock));
  assert.throws(() => verifyEvmFee(receipt, { ...tx, chainId: 1 }, { status: 'success' }, stock));
  assert.throws(() => verifyEvmFee(receipt, tx, { status: 'reverted' }, stock));
});
test('a lead sell queues behind an unconfirmed copied buy instead of being discarded', async () => {
  const data = createRobinhoodAccount(), wallet = data.settings.wallets[0], lead = stock, ledger = book(), engine = new RobinhoodEngine(ledger, {}, 'copy');
  engine.config = { ...data.settings, wallets: [wallet] }; engine.tool = { mirrorFraction: true, sellMode: 'mirror' }; engine.abort = new AbortController(); engine.state = 'running'; engine.copyPairs.set(`${lead}:${token}`, { pool, quote: EVM_NATIVE });
  engine.leadBalanceBefore = async () => 200n; engine.pools = { observeLegacyLogs: async () => [], find: async () => pool }; const queued = [], orders = []; engine.executor = { serial: async (key, task) => { queued.push(task); } }; engine.swap = async (...args) => orders.push(args);
  const log = { address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: lead, to: collector } }), data: encodeAbiParameters(parseAbiParameters('uint256'), [100n]) };
  const swap = { address: CONTRACTS.poolManager, topics: encodeEventTopics({ abi: poolAbi, eventName: 'Swap', args: { id: poolId(pool), sender: collector } }), data: encodeAbiParameters(parseAbiParameters('int128,int128,uint160,uint128,int24,uint24'), [100n,-100n,2n ** 96n,1000n,0,3000]) };
  await engine.copySignals({ from: lead, hash: `0x${'12'.repeat(32)}` }, { logs: [log, swap] }, { timestamp: BigInt(Math.floor(Date.now()/1000)) });
  assert.equal(queued.length, 1); ledger.data.lots.push({ id: 'entry', wallet: wallet.publicKey, lead, token, quote: EVM_NATIVE, pool, remaining: '1000' }); await queued[0](); assert.equal(orders[0][3], 500n);
});
test('Robinhood HTTP endpoints require authentication and CSRF and seal all trading keys', async t => {
  const h = await fixture(t), session = await h.accounts.createSession(h.user.id);
  const server = createAccountApp({ accounts: h.accounts, runtimes: {}, policy: { get: async () => ({}) }, robinhood: { runtimes: h.manager, policy: h.policy }, features: { toolkit: true, telegram: true, walletOnly: false } }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const call = (path, { auth = true, csrf = true, body } = {}) => new Promise((resolve, reject) => { const req = request(`http://127.0.0.1:${server.address().port}${path}`, { method: body ? 'POST' : 'GET', headers: { ...(auth ? { cookie: `launchpad-session=${session.token}` } : {}), ...(csrf ? { 'x-control-token': session.csrfToken } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, res => { let s='';res.on('data',b=>s+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(s)})); }); req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end(); });
  assert.equal((await call('/api/robinhood/settings',{auth:false})).status,401); assert.equal((await call('/api/robinhood/settings',{csrf:false})).status,403);
  const saved = await call('/api/robinhood/settings'); assert.equal(saved.status,200); assert(saved.body.settings.wallets.every(w=>w.privateKey.startsWith('relay-saved-v1:')));
  const account = await call('/api/robinhood/account'); assert(account.body.account.mainWallet.startsWith('0x')); assert(!JSON.stringify(account.body).includes('privateKey'));
  assert.equal((await call('/api/robinhood/admin/fees',{body:{recipient:token,password:'a-strong-test-password'}})).status,403);
});
test('Telegram starts with a chain chooser, preserves independent runs, and rejects stale chain buttons', async t => {
  const h = await fixture(t), sent = [], root = join(h.dir,'telegram'), master=randomBytes(32), solRuns=new Map();
  const sol = { get(id) { if(!solRuns.has(id))solRuns.set(id,new FakeEngine());return solRuns.get(id); }, readSettings: async id=>({settings:await h.accounts.storeFor(id).read('settings'),revision:'sol-v1'}) };
  const bot = await new TelegramBot({ root, master, hostStore:new TelegramStore(root,master), api:{call:async()=>true}, outbox:{send:(id,text,buttons)=>sent.push({id,text,buttons})}, accounts:h.accounts,runtimeManager:sol,robinhood:{runtimes:h.manager,policy:h.policy} }).init(); t.after(()=>bot.close());
  const ctx=await bot.context('8211'); await bot.message(ctx,{text:'/start'}); assert.match(sent.at(-1).text,/Choose your chain/); assert.equal(sent.at(-1).buttons[0].length,2);
  const code=await h.accounts.createLinkCode(h.user.id); await h.accounts.redeemLinkCode(code.code,ctx.id); await bot.attachAccount(ctx,h.user);
  const raw=(await h.manager.readSettings(h.user.id)).settings; raw.agreedFeeVersion=(await h.policy.get(h.user.id)).version; await h.manager.get(h.user.id).start(raw,'copy');
  await bot.action(ctx,'chooseChain',{chain:'robinhood'}); assert.equal(ctx.chain,'robinhood'); assert.equal(ctx.engine,h.manager.get(h.user.id));
  const old=bot.button(ctx,'old','select',{kind:'copy'}).callback_data;
  await bot.action(ctx,'chooseChain',{chain:'solana'}); assert.equal(ctx.chain,'solana'); assert(!ctx.actions.has(old)); assert.equal(h.manager.get(h.user.id).status('copy').state,'running');
  for(const wallet of raw.wallets) assert(!JSON.stringify(sent).includes(wallet.privateKey));
});

const transfer = (address, from, to, amount) => ({ address, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters(parseAbiParameters('uint256'), [amount]) });
test('failed receipt validation leaves inventory unchanged, and successful replay is idempotent', () => {
  const wallet = createRobinhoodAccount().settings.wallets[0].publicKey, ledger = book(), engine = new RobinhoodEngine(ledger, {}, 'market');
  ledger.data.inventory = { [wallet]: { token, quote: stock, quoteAvailable: '1000', budget: '1000' } };
  const pending = { signature: 'one-fill', wallet, context: { operation: 'swap', side: 'buy', inventory: true, token, quote: stock, amount: '100', pool, tokenDecimals: 0, quoteDecimals: 0 } };
  const before = structuredClone(ledger.data);
  assert.throws(() => engine.confirmed(pending, { logs: [] }), /verifiable token/); assert.deepEqual(ledger.data, before);
  const receipt = { logs: [transfer(token, collector, wallet, 250n)] };
  engine.confirmed(pending, receipt); engine.confirmed(pending, receipt);
  assert.equal(ledger.data.inventory[wallet].quoteAvailable, '900'); assert.equal(ledger.data.lots.length, 1); assert.equal(ledger.data.lots[0].remaining, '250');
  clearInterval(engine.reconcileTimer);
});
test('a ledger write failure keeps a wallet paused without double-counting its fill or run budget', async () => {
  const wallet = createRobinhoodAccount().settings.wallets[0].publicKey, ledger = book(), engine = new RobinhoodEngine(ledger, {}, 'copy');
  const pending = { signature: `0x${'ab'.repeat(32)}`, wallet, to: CONTRACTS.router, attempted: true, context: { operation: 'swap', side: 'buy', input: stock, token, quote: stock, amount: '100', pool } };
  ledger.data.pending.push(pending); let fail = true;
  ledger.save = async () => { if (fail) { fail = false; throw Error('disk full'); } };
  const receipt = { transactionHash: pending.signature, from: wallet, to: CONTRACTS.router, status: '0x1', blockHash: '0xab', blockNumber: '0x1', logs: [transfer(token, collector, wallet, 200n)] };
  const rpc = { client: {}, request: async ({ method }) => method === 'eth_getBlockByNumber' ? { hash: '0xab' } : receipt };
  const executor = new RobinhoodExecutor(rpc, ledger, { confirmed: (p, r) => engine.confirmed(p, r) });
  await assert.rejects(executor.reconcile(pending), /disk full/); assert.equal(ledger.data.pending.length, 1);
  await executor.reconcile(pending); assert.equal(ledger.data.pending.length, 0); assert.equal(ledger.data.lots.length, 1); assert.equal(engine.spent.get(`${wallet}:${stock}`), 100n);
  clearInterval(engine.reconcileTimer);
});
test('LP funding ignores unrelated tokens and divides one wallet budget across its positions', async () => {
  const raw = createRobinhoodAccount().settings, wallet = raw.wallets.find(w => w.tool === 'liquidity'), ledger = book(), engine = new RobinhoodEngine(ledger, {}, 'liquidity');
  const pair = { currency0: token, currency1: stock, fee: 3000, tickSpacing: 60, hooks: EVM_NATIVE }, balances = { [stock]: 20000n, [token]: 99000n };
  engine.abort = new AbortController(); engine.config = { ...raw, wallets: [wallet] }; engine.tool = { ...raw.tools.liquidity, token, quote: stock, budgetEth: '0.00000000000001', maxPositions: 2 }; engine.strategyPool = pair;
  engine.rpc = { token: async () => ({ decimals: 0 }), balance: async (w, t) => t === EVM_NATIVE ? 10n ** 18n : balances[t] };
  let ethFunding = 0;
  engine.convertLpQuote = async (w, buy, amount) => {
    assert.equal(buy, true); assert.equal(amount, 10000n); ethFunding++;
    const funds = ledger.data.lpFunds[w.publicKey]; funds.ethAvailable = '0'; funds.quoteAvailable = '10000'; funds.fundingComplete = true; balances[stock] += 10000n;
  };
  engine.pools = { quote: async (p, i, a) => a, state: async () => ({ tick: 0, sqrtPriceX96: 2n ** 96n }) };
  let swaps = 0, deposits = 0;
  engine.swap = async (w, p, input, amount, context, fees) => {
    assert.equal(input, stock); assert.equal(amount, 5000n); assert.equal(fees.ppm, 0); swaps++;
    balances[stock] -= amount; balances[token] += amount;
    engine.confirmed({ signature: 'fund', wallet: w.publicKey, context: { ...context, operation: 'swap', input, amount: String(amount), minimum: String(amount) } }, { logs: [transfer(token, collector, w.publicKey, amount)] });
  };
  engine.executor = { check() {}, approvals: async () => {}, send: async (w, plan, context) => {
    deposits++; const amounts = Object.fromEntries(plan.approvals.map(a => [a.token, BigInt(a.amount)]));
    assert.equal(amounts[token], 2500n); assert.equal(amounts[stock], 2500n);
    balances[token] -= amounts[token]; balances[stock] -= amounts[stock];
    engine.confirmed({ signature: `deposit-${deposits}`, wallet: w.publicKey, context }, { logs: [
      { address: CONTRACTS.positionManager, topics: encodeEventTopics({ abi: positionAbi, eventName: 'Transfer', args: { from: EVM_NATIVE, to: w.publicKey, tokenId: BigInt(deposits) } }), data: '0x' },
      transfer(token, w.publicKey, CONTRACTS.poolManager, amounts[token]), transfer(stock, w.publicKey, CONTRACTS.poolManager, amounts[stock]),
    ] });
  } };
  await engine.liquidityWallet(wallet); assert.equal(swaps, 1); assert.equal(deposits, 2); assert.equal(ethFunding, 1);
  assert.equal(balances[token], 99000n); assert.equal(balances[stock], 20000n); assert.equal(ledger.data.lpFunds[wallet.publicKey].quoteAvailable, '0'); assert.equal(ledger.data.lots.filter(l => l.liquidity).length, 2);
  await engine.liquidityWallet(wallet); assert.equal(ethFunding, 1); assert.equal(deposits, 2);
  clearInterval(engine.reconcileTimer);
});
test('LP withdrawals update the tracked allocation once and idle release leaves wallet assets alone', async () => {
  const wallet = createRobinhoodAccount().settings.wallets[0].publicKey, ledger = book(), engine = new RobinhoodEngine(ledger, {}, 'liquidity');
  ledger.data.lpFunds = { [wallet]: { token, quote: stock, quoteAvailable: '0', tokenAvailable: '0' } };
  ledger.data.lots.push({ id: 'lp-one', wallet, token, quote: stock, liquidity: '1000', pool, tokenId: '1' });
  await assert.rejects(engine.releaseInventory(wallet), /Close/);
  const pending = { signature: 'withdraw', wallet, context: { operation: 'lp-withdraw', lotId: 'lp-one', automatic: false } }, receipt = { logs: [transfer(token, CONTRACTS.poolManager, wallet, 120n), transfer(stock, CONTRACTS.poolManager, wallet, 230n)] };
  engine.confirmed(pending, receipt); engine.confirmed(pending, receipt);
  assert.equal(ledger.data.lpFunds[wallet].tokenAvailable, '120'); assert.equal(ledger.data.lpFunds[wallet].quoteAvailable, '230'); assert.equal(ledger.data.lots[0].liquidity, '0');
  await engine.releaseInventory(wallet); assert.equal(ledger.data.lpFunds[wallet], undefined); clearInterval(engine.reconcileTimer);
});
test('LONG shared-hook pool discovery resolves its initializer and validates liquidity on-chain', async () => {
  const pair = { currency0: token, currency1: stock, fee: 3000, tickSpacing: 60, hooks: collector }, calls = [];
  const client = { readContract: async request => {
    calls.push(request.functionName);
    if (request.address === CONTRACTS.ponsFactory) throw Error('Not a Pons token');
    if (request.address === CONTRACTS.airlock) return [stock, EVM_NATIVE, EVM_NATIVE, EVM_NATIVE, collector, EVM_NATIVE, EVM_NATIVE, 0n, 0n, EVM_NATIVE];
    if (request.functionName === 'getState') return [stock, 1, pair, 0];
    if (request.functionName === 'getSlot0') return [2n ** 96n, 0, 0, 3000];
    if (request.functionName === 'getLiquidity') return 1000n;
    throw Error('Unexpected call');
  } };
  const result = await new RobinhoodPools({ client }).find(token, stock); assert.deepEqual(result, pair); assert(calls.includes('getState')); assert(calls.includes('getLiquidity'));
});
test('strategy budgets cannot be released across tools or while transactions remain unresolved', async t => {
  const h = await fixture(t), settings = (await h.manager.readSettings(h.user.id)).settings, wallet = settings.wallets.find(w => w.tool === 'market').publicKey;
  const store = h.manager.storeFor(h.user.id), data = book().data; data.inventory = { [wallet]: { token, quote: stock, quoteAvailable: '100' } }; data.pending.push({ wallet, signature: 'pending' }); await store.write('market-live', data);
  await assert.rejects(h.manager.get(h.user.id).releaseInventory(wallet, 'copy'), /Choose/);
  await assert.rejects(h.manager.get(h.user.id).releaseInventory(wallet, 'market'), /pending/);
  data.pending = []; await store.write('market-live', data); await h.manager.get(h.user.id).releaseInventory(wallet, 'market'); assert.deepEqual((await store.read('market-live')).inventory, {});
});
