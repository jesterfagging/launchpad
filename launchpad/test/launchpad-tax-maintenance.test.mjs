import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicKey, TransactionMessage } from '@solana/web3.js';
import { createBurnCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { Launchpad } from '../src/launchpad.mjs';
import { newLaunchKeys } from '../src/launchpad-receipts.mjs';
import { SOL_MINT } from '../public/launchpad-model.mjs';
import { HOLDER_REWARD_POLICY } from '../src/launchpad-holder-rewards.mjs';
import { TAX_PROTOCOL_POLICY, recordTaxHarvest } from '../src/launchpad-tax-protocol.mjs';
import { TAX_BURN_MINT, TAX_BURN_WALLET, selectOfficialTaxBurn, taxBurnPlan } from '../src/launchpad-tax-burn.mjs';
import { TAX_MAINTENANCE_POLICY, TAX_MAINTENANCE_INTERVAL_MS, officialTaxMaintenanceEnabled, officialTaxMaintenanceAt, beginOfficialTaxMaintenance, retryOfficialTaxMaintenance } from '../src/launchpad-tax-maintenance.mjs';
import { rewardFixtureReceipt } from './helpers/rewards-wallet-fixture.mjs';

const NOW = 1790670000000, address = () => newLaunchKeys().wallet.address;
const signature = n => bs58.encode(Buffer.alloc(64, n));
function flags(t) {
  // These scenarios burn automatically (v71.24: LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN=true).
  const names = ['LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED', 'LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED', 'LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN'], old = names.map(name => process.env[name]);
  process.env[names[0]] = 'true'; process.env[names[1]] = 'false'; process.env[names[2]] = 'true';
  t.after(() => names.forEach((name, i) => old[i] === undefined ? delete process.env[name] : process.env[name] = old[i]));
}
function launch() {
  return { id: 'c'.repeat(32), input: { network: 'mainnet-beta', route: 'raydium', feeMode: 'holders', taxBps: 200, quoteMint: SOL_MINT, dailyGasLamports: '100000000' },
    keys: { wallet: newLaunchKeys().wallet, mint: { address: TAX_BURN_MINT }, rewards: { address: TAX_BURN_WALLET } },
    rewardsWallet: { version: 1, status: 'active', address: TAX_BURN_WALLET, creatorCredits: { base: '0', quote: '0', protocolQuote: '0', taxBase: '0' } },
    review: { minimumSol: '0.01', quoteProgram: TOKEN_PROGRAM_ID.toBase58(), quoteDecimals: 9, price: { usd: '100' } },
    feeCustody: 'relay', authorizedAt: NOW, createdAt: NOW, state: 'live', curve: address(),
    credits: { quote: '1000000000', base: '0' }, operations: [], gas: { day: new Date(NOW).toISOString().slice(0, 10), reserved: '0' },
    autoFees: true, feeAutomation: { enabled: true, source: 'admin', updatedAt: NOW }, feesRequested: true,
    cycle: { id: 'saved-cycle', stage: 'payout', index: 1, holderRewardPolicy: HOLDER_REWARD_POLICY, snapshotSlot: 123,
      payouts: [{ owner: address(), amount: '5' }, { owner: address(), amount: '700000000' }], distributedQuoteUnits: '5' },
    nativeRewardDebts: { version: 1, payouts: [{ owner: address(), amount: '100000000' }] }, lastHolderRewardCheck: NOW };
}
function operation(l, kind = 'tax', n = 1) {
  const plan = kind === 'tax-burn' ? taxBurnPlan(l) : { amount: '0', operationData: { taxProtocolPolicy: TAX_PROTOCOL_POLICY, taxProtocolRecipient: address() } };
  return { ...plan.operationData, kind, amount: plan.amount, taxMaintenancePolicy: TAX_MAINTENANCE_POLICY,
    signature: signature(n), operationId: 'maintenance-' + n, state: 'pending', createdAt: NOW, reserve: '0', raw: 'saved-signed-bytes', lastValidBlockHeight: 10,
    rewardsWallet: { version: 1, source: 'rewards', address: TAX_BURN_WALLET, signerSource: kind === 'tax' ? 'wallet' : 'rewards' } };
}
function burnReceipt(l, op) {
  const mint = new PublicKey(TAX_BURN_MINT), owner = new PublicKey(TAX_BURN_WALLET), ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  const instruction = createBurnCheckedInstruction(ata, mint, owner, BigInt(op.amount), 6, [], TOKEN_2022_PROGRAM_ID);
  const message = new TransactionMessage({ payerKey: owner, recentBlockhash: address(), instructions: [instruction] }).compileToV0Message();
  const index = message.staticAccountKeys.findIndex(key => key.equals(ata)), row = value => ({ accountIndex: index, owner: TAX_BURN_WALLET, mint: TAX_BURN_MINT, programId: TOKEN_2022_PROGRAM_ID.toBase58(), uiTokenAmount: { amount: value.toString(), decimals: 6 } });
  return { slot: 451600000, transaction: { message, signatures: [op.signature] }, meta: { err: null, fee: 5000,
    preBalances: message.staticAccountKeys.map(() => 10000000), postBalances: message.staticAccountKeys.map((_, i) => i === 0 ? 9995000 : 10000000),
    preTokenBalances: [row(BigInt(l.credits.base))], postTokenBalances: [row(BigInt(l.credits.base) - BigInt(op.amount))], innerInstructions: [] } };
}
async function harness(t, initial = launch()) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-tax-maintenance-')); let book = { launches: [structuredClone(initial)] }, now = NOW, tx = null, manager;
  const calls = [], accounts = { storeFor: () => ({ dir, read: async () => structuredClone(book), write: async (_, value) => { book = structuredClone(value); } }) };
  const chain = { close() {}, c: { getBlockHeight: async () => 1 }, receipt: async () => tx };
  const restart = async () => { await manager?.close(); manager = new Launchpad(accounts, null, { now: () => now, chainFactory: () => chain }); manager.kick = () => {}; };
  await restart(); t.after(async () => { await manager.close(); await rm(dir, { recursive: true, force: true }); });
  return { calls, chain, restart, get manager() { return manager; }, get l() { return book.launches[0]; }, get now() { return now; },
    advance: value => { now += value; }, edit: async change => manager.locked('a', async value => { change(value.launches[0]); await manager.save('a', value); }),
    process: () => manager.process('a'),
    async reconcile(receipt) { tx = receipt; await manager.locked('a', async value => { const l = value.launches[0]; await manager.reconcile('a', value, l, chain, l.operations.find(op => op.state === 'pending')); }); tx = null; },
    setReceipt: value => { tx = value; } };
}

test('maintenance is scoped to enabled official LAUNCHPAD and never overrides a saved pause or handoff', t => {
  flags(t); const l = launch(); assert.equal(officialTaxMaintenanceAt(l), 0);
  for (const change of [x => x.feeAutomation.enabled = false, x => x.state = 'paused', x => x.keys.mint.address = address(),
    x => x.keys.rewards.address = address(), x => x.rewardsWallet.status = 'migrating', x => x.rewardsWallet.creatorCredits.quote = '1',
    x => x.heldSolDistribution = { state: 'processing' }]) {
    const other = structuredClone(l); change(other); assert.equal(officialTaxMaintenanceEnabled(other), false); assert.equal(officialTaxMaintenanceAt(other), Infinity);
  }
  for (const state of ['pending', 'awaiting_signature']) { const other = structuredClone(l); other.operations.push({ state }); assert.equal(officialTaxMaintenanceAt(other), Infinity); }
  process.env.LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED = 'false'; assert.equal(officialTaxMaintenanceAt(l), Infinity);
});

test('persisted cadence and isolated known-operational retries preserve the SOL cycle and actual authorization', t => {
  flags(t); const l = launch(), before = structuredClone(l);
  beginOfficialTaxMaintenance(l, NOW); assert.equal(officialTaxMaintenanceAt(l), NOW + TAX_MAINTENANCE_INTERVAL_MS);
  assert.throws(() => beginOfficialTaxMaintenance(l, NOW + 1), /not due/);
  l.rewardRetry = { attempt: 2, at: NOW + 900000, kind: 'funding', reason: 'Holder wait' }; const holderRetry = structuredClone(l.rewardRetry);
  assert.equal(retryOfficialTaxMaintenance(l, Object.assign(Error('SOL required'), { code: 'REWARD_SOL_REQUIRED' }), NOW), true);
  assert.equal(l.taxMaintenance.nextAt, NOW + 300000); assert.deepEqual(l.rewardRetry, holderRetry); assert.deepEqual(l.cycle, before.cycle);
  assert.deepEqual(l.credits, before.credits); assert.deepEqual(l.feeAutomation, before.feeAutomation);
  const saved = structuredClone(l);
  assert.equal(retryOfficialTaxMaintenance(l, Object.assign(Error('Reward payout receipt differs from its saved allocation.'), { statusCode: 503 }), NOW), false);
  assert.deepEqual(l, saved); l.feeAutomation.enabled = false; const paused = structuredClone(l);
  assert.equal(retryOfficialTaxMaintenance(l, Object.assign(Error('SOL required'), { code: 'REWARD_SOL_REQUIRED' }), NOW), false); assert.deepEqual(l, paused);
});

test('worker interleaves bounded maintenance with an old partial payout cycle, including across restart', async t => {
  flags(t); const h = await harness(t), cycle = structuredClone(h.l.cycle);
  const install = () => {
    h.manager.advanceOfficialTaxMaintenance = async (id, book, l) => { h.calls.push('tax-check'); beginOfficialTaxMaintenance(l, h.now); await h.manager.save(id, book); };
    h.manager.advanceFees = async () => { h.calls.push('payout'); };
  };
  install(); await h.process(); assert.deepEqual(h.calls, ['tax-check']); assert.deepEqual(h.l.cycle, cycle);
  await h.restart(); install(); await h.process(); assert.deepEqual(h.calls, ['tax-check', 'payout']);
  h.advance(60000); await h.process(); assert.deepEqual(h.calls, ['tax-check', 'payout', 'tax-check']); assert.deepEqual(h.l.cycle, cycle);
});

test('a holder funding retry does not postpone due tax maintenance and a tax retry does not postpone holders', async t => {
  flags(t); const l = launch(); l.rewardRetry = { attempt: 1, at: NOW + 300000, kind: 'funding' };
  const h = await harness(t, l); h.manager.advanceOfficialTaxMaintenance = async () => { h.calls.push('tax'); throw Object.assign(Error('RPC timed out'), { code: 'ETIMEDOUT' }); };
  h.manager.advanceFees = async () => { h.calls.push('holders'); };
  await h.process(); assert.deepEqual(h.calls, ['tax']); assert.equal(h.l.state, 'live'); assert.equal(h.l.taxMaintenance.retry.kind, 'network');
  assert.deepEqual(h.l.rewardRetry, l.rewardRetry); await h.edit(x => { delete x.rewardRetry; }); await h.process(); assert.deepEqual(h.calls, ['tax', 'holders']);
});

test('pending and unsigned transactions are never replaced by maintenance; integrity failures still pause', async t => {
  flags(t);
  for (const state of ['pending', 'awaiting_signature']) {
    const l = launch(); l.operations.push({ kind: 'payout', state, signature: signature(8), createdAt: NOW, raw: 'unchanged', reserve: '0' });
    const h = await harness(t, l); h.manager.advanceOfficialTaxMaintenance = async () => { throw Error('unexpected maintenance'); };
    await h.process(); assert.deepEqual(h.l.operations, l.operations); assert.deepEqual(h.l.cycle, l.cycle);
  }
  const h = await harness(t); h.manager.advanceOfficialTaxMaintenance = async () => { throw Object.assign(Error('The saved rewards wallet no longer matches its key.'), { statusCode: 503 }); };
  await h.process(); assert.equal(h.l.state, 'paused'); assert.equal(h.l.taxMaintenance, undefined); assert.equal(h.l.rewardRetry, undefined);
});

test('confirmed independent harvest and burn preserve a partial payout snapshot, debt and retry exactly', async t => {
  flags(t); const l = launch(); selectOfficialTaxBurn(l, NOW); l.credits.base = '17';
  l.rewardRetry = { attempt: 2, at: NOW + 300000, kind: 'funding', reason: 'holder gas wait' }; l.error = 'Automatic rewards are waiting for SOL and will retry automatically.';
  beginOfficialTaxMaintenance(l, NOW); l.operations.push(operation(l)); const h = await harness(t, l), before = structuredClone(h.l);
  await h.reconcile(rewardFixtureReceipt(h.l, { base: 123n }));
  assert.deepEqual(h.l.cycle, before.cycle); assert.deepEqual(h.l.nativeRewardDebts, before.nativeRewardDebts); assert.equal(h.l.credits.quote, before.credits.quote);
  assert.equal(h.l.credits.base, '140'); assert.equal(h.l.taxProtocol.sourceBaseCredit, '123'); assert.deepEqual(h.l.rewardRetry, before.rewardRetry); assert.equal(h.l.error, before.error);
  assert.equal(h.l.taxMaintenance.nextAt, NOW + 1000); assert.equal(h.l.operations[0].state, 'confirmed');
  await h.edit(x => { x.operations.push(operation(x, 'tax-burn', 2)); }); await h.restart(); await h.reconcile(burnReceipt(h.l, h.l.operations[1]));
  assert.equal(h.l.credits.base, '17'); assert.equal(h.l.taxProtocol.sourceBaseCredit, '0'); assert.equal(h.l.taxProtocol.burnedBase, '123');
  assert.equal(h.l.taxBurn.burnCount, 1); assert.equal(h.l.taxMaintenance.nextAt, NOW + 60000); assert.deepEqual(h.l.cycle, before.cycle);
  assert.deepEqual(h.l.rewardRetry, before.rewardRetry); assert.equal(h.l.credits.quote, before.credits.quote); assert.deepEqual(h.l.nativeRewardDebts, before.nativeRewardDebts);
});

test('maintenance receipts settle without a holder cycle and after an explicit pause and disabled burn flag', async t => {
  flags(t); const l = launch(); l.cycle = null; l.nativeRewardDebts = { version: 1, payouts: [] }; selectOfficialTaxBurn(l, NOW); l.operations.push(operation(l));
  const h = await harness(t, l); await h.edit(x => { x.feeAutomation.enabled = false; x.autoFees = false; x.feesRequested = false; x.state = 'paused'; });
  process.env.LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED = 'false'; const before = structuredClone(h.l); await h.reconcile(rewardFixtureReceipt(h.l, { base: 25n }));
  assert.equal(h.l.credits.base, '25'); assert.equal(h.l.cycle, null); assert.equal(h.l.state, 'paused'); assert.equal(h.l.feesRequested, false);
  assert.deepEqual(h.l.feeAutomation, before.feeAutomation); assert.equal(officialTaxMaintenanceAt(h.l), Infinity);
});

test('a signed maintenance burn still settles after pausing without changing its saved payout cycle', async t => {
  flags(t); const l = launch(); selectOfficialTaxBurn(l, NOW); l.taxProtocol = recordTaxHarvest(l, 25n); l.credits.base = '25'; l.operations.push(operation(l, 'tax-burn'));
  const h = await harness(t, l), receipt = burnReceipt(h.l, h.l.operations[0]);
  await h.edit(x => { x.feeAutomation.enabled = false; x.autoFees = false; x.feesRequested = false; x.state = 'paused'; });
  process.env.LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED = 'false'; await h.reconcile(receipt);
  assert.equal(h.l.credits.base, '0'); assert.equal(h.l.taxProtocol.burnedBase, '25'); assert.equal(h.l.state, 'paused'); assert.equal(h.l.autoFees, false);
  assert.deepEqual(h.l.cycle, l.cycle); assert.equal(h.l.feesRequested, false); assert.equal(officialTaxMaintenanceAt(h.l), Infinity);
});

test('proven maintenance expiry keeps credits and payout allocations and backs off without replacing signed bytes early', async t => {
  flags(t); const l = launch(); selectOfficialTaxBurn(l, NOW); l.operations.push(operation(l)); const h = await harness(t, l); let checkpoint = 100;
  h.chain.pendingTransactionState = async op => ({ state: 'expired', signature: op.signature, checkpoint: { slot: checkpoint++, height: checkpoint++ }, historyFromSlot: 1 });
  const check = () => h.manager.locked('a', async book => { const current = book.launches[0]; return h.manager.checkExpiredReward('a', book, current, h.chain, current.operations[0]); });
  assert.equal(await check(), false); assert.equal(h.l.operations[0].state, 'pending'); assert.equal(h.l.operations[0].raw, 'saved-signed-bytes');
  h.advance(10000); assert.equal(await check(), true); assert.equal(h.l.operations[0].state, 'expired'); assert.equal(h.l.operations[0].raw, undefined);
  assert.equal(h.l.taxMaintenance.retry.kind, 'transaction'); assert.equal(h.l.state, 'live'); assert.deepEqual(h.l.cycle, l.cycle); assert.deepEqual(h.l.credits, l.credits);
});

test('failed or contradictory tax receipts cannot change holder or tax credit and failed maintenance uses its own retry', async t => {
  flags(t);
  for (const failed of [true, false]) {
    const l = launch(); selectOfficialTaxBurn(l, NOW); beginOfficialTaxMaintenance(l, NOW); l.operations.push(operation(l));
    const h = await harness(t, l), before = structuredClone(h.l), receipt = rewardFixtureReceipt(h.l, failed ? { err: { InstructionError: [2, { Custom: 1 }] } } : { quote: 1n, base: 25n });
    if (failed) { await h.reconcile(receipt); assert.equal(h.l.operations[0].state, 'failed'); assert.equal(h.l.taxMaintenance.retry.kind, 'transaction'); assert.equal(h.l.state, 'live'); }
    else { await assert.rejects(() => h.reconcile(receipt), /unexpected token movements/); assert.equal(h.l.operations[0].state, 'pending'); }
    assert.deepEqual(h.l.credits, before.credits); assert.deepEqual(h.l.cycle, before.cycle); assert.deepEqual(h.l.nativeRewardDebts, before.nativeRewardDebts); assert.equal(h.l.taxProtocol, undefined);
  }
});

test('duplicate signatures, malformed markers and persistence failures cannot double-credit maintenance', async t => {
  flags(t); const l = launch(); selectOfficialTaxBurn(l, NOW); l.operations.push(operation(l)); const h = await harness(t, l);
  const receipt = rewardFixtureReceipt(h.l, { base: 25n }), save = h.manager.save.bind(h.manager); let fail = true;
  h.manager.save = async (...args) => { if (fail) { fail = false; throw Error('persistence failure'); } return save(...args); };
  await assert.rejects(() => h.reconcile(receipt), /persistence failure/); assert.equal(h.l.operations[0].state, 'pending'); assert.equal(h.l.credits.base, '0');
  await h.reconcile(receipt); assert.equal(h.l.credits.base, '25');
  await h.edit(x => { x.operations.push({ ...operation(x), operationId: 'duplicate' }); });
  await assert.rejects(() => h.reconcile(receipt), /already applied/); assert.equal(h.l.credits.base, '25');
  await h.edit(x => { x.operations[1].signature = signature(2); x.operations[1].taxMaintenancePolicy = 'unexpected'; });
  await assert.rejects(() => h.reconcile(receipt), /Invalid official LAUNCHPAD tax maintenance operation/); assert.equal(h.l.credits.base, '25');
});

test('tax maintenance never bypasses the existing private signing custody check', async t => {
  flags(t); const h = await harness(t), before = structuredClone(h.l); let rpc = 0;
  h.chain.claimInstructions = async () => { rpc++; return []; };
  await h.process(); assert.equal(h.l.state, 'paused'); assert.match(h.l.error, /wallet is unavailable/); assert.equal(rpc, 0);
  assert.equal(h.l.taxMaintenance.nextAt, NOW + 60000); assert.deepEqual(h.l.cycle, before.cycle); assert.deepEqual(h.l.credits, before.credits);
});

test('the ordinary automatic cycle skips duplicate tax work; a manual request with automation off retains the old path', async t => {
  flags(t);
  for (const automatic of [true, false]) {
    const l = launch(); l.autoFees = automatic; l.feeAutomation.enabled = automatic; l.cycle = { stage: 'tax', index: 0 }; l.nativeRewardDebts = { version: 1, payouts: [] }; l.credits.quote = '0';
    selectOfficialTaxBurn(l, NOW); const h = await harness(t, l); h.manager.advanceRewardsWallet = async () => false;
    h.chain.claimInstructions = async () => { h.calls.push('collect'); return []; };
    if (automatic) { await h.manager.locked('a', book => h.manager.advanceFees('a', book, book.launches[0], h.chain)); assert.deepEqual(h.calls, []); assert.equal(h.l.cycle, null); }
    else { await assert.rejects(() => h.manager.locked('a', book => h.manager.advanceFees('a', book, book.launches[0], h.chain)), /wallet is unavailable/); }
  }
});
