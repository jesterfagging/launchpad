import { SniperEngine } from '../src/sniper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, Keypair, SystemProgram, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { MintLayout, AccountLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ExtensionType, TransferFeeConfigLayout, getMintLen, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { SOL, validateConfig } from '../src/core.mjs';
import { Engine } from '../src/engine.mjs';
import { PortfolioEngine } from '../src/portfolio.mjs';
import { portfolioConfig } from '../src/portfolio-plan.mjs';
import { Providers, prepareTransaction, makeTransaction } from '../src/providers.mjs';
import { validatePlatformContext, platformFeePlan, preparePlatformFee, attachPlatformFee, verifyPlatformFee, verifyRecordedPlatformFee, recordPlatformFee } from '../src/platform-fees.mjs';
import { key1, mint, quote, blockhash, config, build, token } from './fixtures.mjs';

const collector = Keypair.generate().publicKey.toBase58(), mainWallet = Keypair.generate().publicKey.toBase58(), wallet = key1.publicKey.toBase58();
const context = () => validatePlatformContext({ accountId: 'account-1', recipient: collector, mainWallet, cashbackBps: 2000, copyPpm: 2500, marketPpm: 1000, version: 1 });
const ledger = () => ({ data: { lots: [], pending: [], events: [], trades: 0, feeReceipts: [] }, save: async () => {}, addEvent(e) { this.data.events.unshift(e); } });
const publicInstruction = ix => ({ programId: ix.programId.toBase58(), accounts: ix.keys.map(k => k.pubkey.toBase58()), data: bs58.encode(ix.data) });
function nativeReceipt(pending, { amount, err = null } = {}) {
  const fee = pending.order.platformFee, credited = amount ?? BigInt(fee.expectedAmount);
  return { transaction: { signatures: [pending.signature], message: { accountKeys: [wallet, collector], instructions: [{ programId: SystemProgram.programId.toBase58(), parsed: { type: 'transfer', info: { source: wallet, destination: collector, lamports: Number(fee.chargedAmount) } } }] } },
    meta: { err, fee: 5000, preBalances: [10000000000, 1000000], postBalances: [9999995000 - Number(credited), 1000000 + Number(credited)], preTokenBalances: [], postTokenBalances: [] } };
}
function mintData(program = TOKEN_PROGRAM_ID, extension) {
  const data = Buffer.alloc(extension === undefined ? 82 : getMintLen([extension]));
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000000000000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  if (extension !== undefined) { data[165] = 1; data.writeUInt16LE(extension, 166); data.writeUInt16LE(data.length - 170, 168); }
  return { data: [data.toString('base64'), 'base64'], owner: program.toBase58(), lamports: 1000000, executable: false };
}
function tokenAccount(owner, amount = 1000000n, program = TOKEN_PROGRAM_ID) {
  const data = Buffer.alloc(165); AccountLayout.encode({ mint: new PublicKey(mint), owner: new PublicKey(owner), amount, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return { data: [data.toString('base64'), 'base64'], owner: program.toBase58(), lamports: 2039280, executable: false };
}
function tokenProvider({ program = TOKEN_PROGRAM_ID, extension, existing = false } = {}) {
  const calls = [];
  return { calls, c: { rpcUrl: 'https://example.invalid' }, rpc: async (method, params) => {
    calls.push({ method, params });
    if (method === 'getAccountInfo') return { value: mintData(program, extension) };
    if (method === 'getMultipleAccounts') return { value: [tokenAccount(wallet, 1000000n, program), existing ? tokenAccount(collector, 0n, program) : null] };
    if (method === 'getMinimumBalanceForRentExemption') return 2039280;
    throw Error(`Unexpected RPC ${method}`);
  } };
}

function batchedTokenProvider({ wallets = 20, taxed = false } = {}) {
  const program = taxed ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const accounts = new Map([[mint, mintData(program, taxed ? ExtensionType.TransferFeeConfig : undefined)]]), calls = [];
  if (taxed) {
    const raw = accounts.get(mint), data = Buffer.from(raw.data[0], 'base64');
    TransferFeeConfigLayout.encode({ transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: PublicKey.default, withheldAmount: 0n,
      olderTransferFee: { epoch: 0n, maximumFee: 1000000n, transferFeeBasisPoints: 100 },
      newerTransferFee: { epoch: 11n, maximumFee: 1000000n, transferFeeBasisPoints: 200 } }, data, 170);
    raw.data[0] = data.toString('base64');
  }
  const plans = Array.from({ length: wallets }, () => {
    const owner = Keypair.generate().publicKey, source = getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, program).toBase58();
    accounts.set(source, tokenAccount(owner, 1000000n, program));
    return platformFeePlan(context(), 'copy', mint, 1000000n, owner.toBase58());
  });
  const destination = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(collector), false, program).toBase58();
  const p = new Providers({ rpcUrl: 'https://example.invalid', maxSignalAgeMs: 5000 }, () => {});
  p.rpc = async (method, params, signal) => {
    signal?.throwIfAborted(); calls.push({ method, params });
    if (method === 'getMultipleAccounts') {
      assert.equal(params[1].commitment, 'confirmed');
      return { context: { slot: 100 }, value: params[0].map(key => accounts.get(key) || null) };
    }
    if (method === 'getMinimumBalanceForRentExemption') return 2039280;
    if (method === 'getEpochInfo') return { epoch: p.testEpoch ?? 10 };
    throw Error(`Unexpected batched fee RPC ${method}`);
  };
  return { p, calls, accounts, plans, program, destination };
}

test('platform fee exact integer arithmetic, immutable host snapshot, and input amount cap', () => {
  const raw = { ...context() }, c = validatePlatformContext(raw); raw.copyPpm = 0;
  const fee = platformFeePlan(c, 'copy', SOL, 20000000000n, wallet);
  assert.equal(fee.chargedAmount, '50000000'); assert.equal(fee.swapAmount, '19950000000'); assert.equal(c.copyPpm, 2500); assert(Object.isFrozen(c));
  assert.equal(platformFeePlan(c, 'copy', SOL, 399n, wallet), null);
  assert.equal(platformFeePlan(c, 'copy', SOL, 400n, wallet).chargedAmount, '1');
  assert.equal(platformFeePlan(c, 'market', SOL, 1000000n, wallet).chargedAmount, '1000');
  assert.throws(() => platformFeePlan(c, 'copy', SOL, 1n, collector), /collection wallet/);
  assert.throws(() => validatePlatformContext({ ...raw, cashbackBps: 10001 }), /cashback/);
  assert.throws(() => validatePlatformContext({ ...raw, recipient: '' }));
});

test('native fee is in the same signed transaction and stays through compact route fallback', async () => {
  const fee = await preparePlatformFee(platformFeePlan(context(), 'copy', SOL, 1000000n, wallet), {});
  const order = { kind: 'buy', inputMint: SOL, outputMint: mint, amount: BigInt(fee.plan.swapAmount), receivedAt: Date.now() }, w = { publicKey: wallet }, c = validateConfig(config({ mode: 'live' }));
  const huge = build(order, w); huge.swapInstruction.data = Buffer.alloc(4300).toString('base64');
  let calls = 0;
  const p = { jitoTips: [], jupiterBuild: async o => { calls++; assert.equal(o.amount, 997500n); return build(o, w); } };
  const packed = await prepareTransaction(attachPlatformFee(huge, fee), order, w, c, p);
  assert(calls > 0); packed.transaction.tx.sign([key1]);
  const tx = VersionedTransaction.deserialize(packed.transaction.tx.serialize());
  const index = tx.message.staticAccountKeys.findIndex(k => k.toBase58() === collector);
  assert(index >= 0); assert.equal(tx.message.compiledInstructions.filter(ix => ix.accountKeyIndexes.includes(index)).length, 1);
  assert.equal(packed.build.platformFeeInstructions.length, 1);
});

test('SPL fee creates the correct collector ATA, checks gross balance and includes rent', async () => {
  const p = tokenProvider(), prepared = await preparePlatformFee(platformFeePlan(context(), 'copy', mint, 1000000n, wallet), p);
  assert.equal(prepared.instructions.length, 2); assert.equal(prepared.rent, 2039280n); assert(prepared.requiresSimulation);
  assert.equal(prepared.plan.destination, getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(collector)).toBase58());
  assert.equal(prepared.plan.chargedAmount, '2500'); assert.equal(prepared.plan.expectedAmount, '2500');
  await assert.rejects(preparePlatformFee(platformFeePlan(context(), 'copy', mint, 1000001n, wallet), p), /cannot cover/);
  const existing = await preparePlatformFee(platformFeePlan(context(), 'copy', mint, 1000000n, wallet), tokenProvider({ existing: true }));
  assert.equal(existing.instructions.length, 1); assert.equal(existing.rent, 0n);
});

test('20 concurrent follower token fees use two fresh account snapshots and one rent request', async () => {
  const { p, calls, accounts, plans, program, destination } = batchedTokenProvider();
  const signal = new AbortController().signal;
  const prepared = await Promise.all(plans.map(plan => preparePlatformFee(plan, p, signal)));
  assert.equal(prepared.length, 20);
  assert.deepEqual(calls.map(call => call.method), ['getMultipleAccounts', 'getMultipleAccounts', 'getMinimumBalanceForRentExemption']);
  assert.deepEqual(calls[0].params[0], [mint]);
  assert.equal(calls[1].params[0].length, 21, '20 distinct source accounts plus one collector ATA');
  assert.equal(new Set(prepared.map(fee => fee.plan.source)).size, 20);
  for (let i = 0; i < prepared.length; i++) {
    assert.equal(prepared[i].plan.wallet, plans[i].wallet);
    assert.equal(prepared[i].plan.source, getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(plans[i].wallet), false, program).toBase58());
    assert.equal(prepared[i].instructions.length, 2);
    assert.equal(prepared[i].rent, 2039280n); assert(prepared[i].requiresSimulation);
  }
  // A later sell must observe an outside transfer and the collector ATA created
  // by the preceding wave; neither successful balances nor missing ATAs cache.
  accounts.set(prepared[0].plan.source, tokenAccount(plans[0].wallet, 0n, program));
  accounts.set(destination, tokenAccount(collector, 50000n, program));
  const again = await Promise.allSettled(plans.map(plan => preparePlatformFee(plan, p, signal)));
  assert.equal(again[0].status, 'rejected'); assert.match(again[0].reason.message, /cannot cover/);
  assert(again.slice(1).every(result => result.status === 'fulfilled' && result.value.rent === 0n && result.value.instructions.length === 1));
  assert.equal(calls.length, 5); assert(calls.slice(3).every(call => call.method === 'getMultipleAccounts'));
});

test('concurrent transfer-tax fees share epoch metadata only in flight and refresh the fee schedule next time', async () => {
  const { p, calls, plans } = batchedTokenProvider({ taxed: true });
  const signal = new AbortController().signal;
  const first = await Promise.all(plans.map(plan => preparePlatformFee(plan, p, signal)));
  assert.equal(calls.length, 4);
  assert.equal(calls.filter(call => call.method === 'getEpochInfo').length, 1);
  assert(first.every(fee => fee.plan.tokenTransferFee === '25' && fee.plan.expectedAmount === '2475'));
  p.testEpoch = 11;
  const second = await Promise.all(plans.map(plan => preparePlatformFee(plan, p, signal)));
  assert.equal(calls.length, 8);
  assert(second.every(fee => fee.plan.tokenTransferFee === '50' && fee.plan.expectedAmount === '2450'));
});

test('failed shared fee metadata is evicted, and cancelling one run does not cancel another', async () => {
  const { p, calls, plans } = batchedTokenProvider();
  const rpc = p.rpc; let failedRent = false;
  p.rpc = async (method, params, signal) => {
    const result = await rpc(method, params, signal);
    if (method === 'getMinimumBalanceForRentExemption' && !failedRent) { failedRent = true; throw Error('Temporary rent read failure'); }
    return result;
  };
  const firstSignal = new AbortController(), secondSignal = new AbortController();
  const failed = await Promise.allSettled(plans.map(plan => preparePlatformFee(plan, p, firstSignal.signal)));
  assert.equal(calls.filter(call => call.method === 'getMinimumBalanceForRentExemption').length, 1);
  assert(failed.every(result => result.status === 'rejected' && /Temporary rent/.test(result.reason.message)));
  const first = preparePlatformFee(plans[0], p, firstSignal.signal);
  const second = preparePlatformFee(plans[1], p, secondSignal.signal);
  firstSignal.abort();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[1].value.plan.wallet, plans[1].wallet);
  assert.equal(calls.filter(call => call.method === 'getMinimumBalanceForRentExemption').length, 2);
});

test('Token2022 metadata uses its token program and immutable-owner ATA rent; unsupported extension refuses before signing', async () => {
  const p = tokenProvider({ program: TOKEN_2022_PROGRAM_ID, extension: ExtensionType.MetadataPointer });
  const prepared = await preparePlatformFee(platformFeePlan(context(), 'copy', mint, 1000000n, wallet), p);
  assert.equal(prepared.plan.program, TOKEN_2022_PROGRAM_ID.toBase58()); assert.equal(p.calls.find(c => c.method === 'getMinimumBalanceForRentExemption').params[0], 170);
  await assert.rejects(preparePlatformFee(platformFeePlan(context(), 'copy', mint, 1000000n, wallet), tokenProvider({ program: TOKEN_2022_PROGRAM_ID, extension: ExtensionType.NonTransferable })), /not supported/);
});

test('transfer-tax tokens lock the tax in the instruction and cashback accrues on the actual net fee', async () => {
  const p = tokenProvider({ program: TOKEN_2022_PROGRAM_ID, extension: ExtensionType.TransferFeeConfig }), rpc = p.rpc;
  p.rpc = async (method, params) => {
    if (method === 'getEpochInfo') return { epoch: 10 };
    const value = await rpc(method, params);
    if (method === 'getAccountInfo') {
      const data = Buffer.from(value.value.data[0], 'base64'), schedule = { epoch: 0n, maximumFee: 1000000n, transferFeeBasisPoints: 100 };
      TransferFeeConfigLayout.encode({ transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: PublicKey.default, withheldAmount: 0n, olderTransferFee: schedule, newerTransferFee: schedule }, data, 170);
      value.value.data[0] = data.toString('base64');
    }
    return value;
  };
  const prepared = await preparePlatformFee(platformFeePlan(context(), 'copy', mint, 1000000n, wallet), p);
  assert.equal(prepared.plan.chargedAmount, '2500'); assert.equal(prepared.plan.tokenTransferFee, '25'); assert.equal(prepared.plan.expectedAmount, '2475');
  const pending = { signature: 'taxed-spl', wallet, createdAt: 100, order: { platformFee: prepared.plan } };
  const tx = { transaction: { signatures: [pending.signature], message: { accountKeys: [wallet, prepared.plan.destination], instructions: prepared.instructions.map(publicInstruction) } },
    meta: { err: null, preTokenBalances: [], postTokenBalances: [token(collector, mint, 2475n, 6, 1)] } };
  const receipt = verifyPlatformFee(pending, tx); assert.equal(receipt.amount, '2475'); assert.equal(receipt.cashbackAmount, '495');
});

test('copy execution ignores client fee overrides, routes net, and journals one confirmed fee with its fill', async () => {
  const l = ledger(), receipts = new Map(); let builtAmount, submitted = 0;
  const p = { market: new Map(), jitoTips: [], init: async () => {}, subscribe: async () => {}, close() {}, markets: async () => {},
    balance: async () => 10000000000n, build: async (order, w) => { builtAmount = order.amount; return build(order, w); },
    rpc: async () => ({ value: { err: null } }), statuses: async signatures => signatures.map(sig => receipts.has(sig) ? { confirmationStatus: 'confirmed', err: null } : null),
    transaction: async sig => receipts.get(sig), height: async () => 100,
    submit: async bytes => {
      submitted++; const tx = VersionedTransaction.deserialize(bytes), signature = bs58.encode(tx.signatures[0]);
      const pending = l.data.pending.find(p => p.signature === signature); assert(pending, 'journal precedes any broadcast');
      const receipt = nativeReceipt(pending); receipt.meta.postTokenBalances.push(token(wallet, mint, 1000n, 6, 2)); receipts.set(signature, receipt);
      return { signature, route: 'test' };
    } };
  const e = new Engine({ live: l, paper: ledger() }, () => p); e.platformContext = context(); e.receiptIntervalMs = 1;
  await e.start(config({ mode: 'live', platformContext: { ...context(), copyPpm: 0 }, copyPpm: 0 }));
  await e.execute({ kind: 'buy', inputMint: SOL, outputMint: mint, outputDecimals: 6, amount: 1000000n, receivedAt: Date.now(), observedAt: performance.now() }, e.c.wallets[0]);
  assert.equal(builtAmount, 997500n); assert.equal(submitted, 1); assert.equal(l.data.pending.length, 0); assert.equal(l.data.lots.length, 1);
  assert.equal(l.data.feeReceipts[0].amount, '2500'); assert.equal(l.data.feeReceipts[0].cashbackAmount, '500'); assert.equal(e.spend.get(wallet), 1000000n);
  e.stop(); await e.stopPromise;
});

test('fee accrues once only on verified successful transfer and matching destination credit', async () => {
  const prepared = await preparePlatformFee(platformFeePlan(context(), 'copy', SOL, 1000000n, wallet), {});
  const pending = { signature: 'signature-one', wallet, createdAt: 100, order: { platformFee: prepared.plan } }, l = ledger();
  assert.throws(() => verifyPlatformFee(pending, nativeReceipt(pending, { err: { InstructionError: [1, 'Failed'] } })), /successful/);
  assert.throws(() => verifyPlatformFee(pending, nativeReceipt(pending, { amount: 2499n })), /differs/);
  const missing = nativeReceipt(pending); missing.transaction.message.instructions = [];
  assert.throws(() => verifyPlatformFee(pending, missing), /exact platform fee/);
  const verified = verifyPlatformFee(pending, nativeReceipt(pending)); recordPlatformFee(l, pending, verified); recordPlatformFee(l, pending, verified);
  assert.equal(l.data.feeReceipts.length, 1); assert.equal(verified.amount, '2500'); assert.equal(verified.cashbackAmount, '500'); assert.equal(verified.mainWallet, mainWallet);
  assert.deepEqual(verifyRecordedPlatformFee(verified, nativeReceipt(pending)), verified);
  assert.notEqual(verified.evidence, pending.order.platformFee); assert.notEqual(verified.evidence.transferAccounts, pending.order.platformFee.transferAccounts);
  const wrongSignature = nativeReceipt(pending); wrongSignature.transaction.signatures[0] = 'another-transaction';
  assert.throws(() => verifyRecordedPlatformFee(verified, wrongSignature), /signature does not match/);
  assert.throws(() => recordPlatformFee(l, pending, { ...verified, cashbackAmount: '1000' }), /immutable/);
  assert.throws(() => recordPlatformFee(l, { ...pending, signature: 'unverified' }, null), /Verified/);
});

test('SPL receipt uses the exact collector token account, not another holder balance', async () => {
  const prepared = await preparePlatformFee(platformFeePlan(context(), 'copy', mint, 1000000n, wallet), tokenProvider());
  const pending = { signature: 'spl-signature', wallet, createdAt: 100, order: { platformFee: prepared.plan } };
  const tx = { transaction: { signatures: [pending.signature], message: { accountKeys: [wallet, prepared.plan.destination], instructions: prepared.instructions.map(publicInstruction) } },
    meta: { err: null, preTokenBalances: [], postTokenBalances: [token(collector, mint, 2500n, 6, 1)] } };
  assert.equal(verifyPlatformFee(pending, tx).cashbackAmount, '500');
  tx.meta.postTokenBalances[0].owner = mainWallet; assert.throws(() => verifyPlatformFee(pending, tx), /owner differs/);
});

test('RPC parsed transfer-hook extras are verified even when Agave labels them as multisig signers', async () => {
  const prepared = await preparePlatformFee(platformFeePlan(context(), 'copy', mint, 1000000n, wallet), tokenProvider());
  const hook = Keypair.generate().publicKey.toBase58(), extras = [hook, quote]; prepared.plan.transferAccounts.push(...extras);
  const fee = prepared.plan, pending = { signature: 'hook-transfer', wallet, createdAt: 100, order: { platformFee: fee } };
  const info = { source: fee.source, destination: fee.destination, mint, multisigAuthority: wallet, signers: extras, tokenAmount: { amount: '2500', decimals: 6 } };
  const tx = { transaction: { signatures: [pending.signature], message: { accountKeys: [wallet, fee.destination], instructions: [{ programId: fee.program, parsed: { type: 'transferChecked', info } }] } },
    meta: { err: null, preTokenBalances: [], postTokenBalances: [token(collector, mint, 2500n, 6, 1)] } };
  assert.equal(verifyPlatformFee(pending, tx).cashbackAmount, '500');
  info.signers = [...extras].reverse(); assert.throws(() => verifyPlatformFee(pending, tx), /exact platform fee/);
});

test('paper simulation adjusts buy size but never accrues payable cashback or sends fee instructions', async () => {
  const c = context(), prepared = await preparePlatformFee(platformFeePlan(c, 'copy', SOL, 1000000n, wallet), {}, null, { paper: true });
  assert.equal(prepared.instructions.length, 0); assert.equal(prepared.plan.swapAmount, '997500');
  const l = ledger(), p = { signature: 'paper-test', wallet, createdAt: 1, order: { platformFee: prepared.plan } }; recordPlatformFee(l, p, null, true);
  assert.equal(l.data.feeReceipts[0].mode, 'paper'); assert.equal(l.data.feeReceipts[0].status, 'simulated'); assert.equal(l.data.feeReceipts[0].cashbackAmount, '0');
});

test('confirmed full sell includes fee debit, closes gross copied lot and atomically journals its cashback', async () => {
  const prepared = await preparePlatformFee(platformFeePlan(context(), 'copy', mint, 1000000n, wallet), tokenProvider());
  const l = ledger(), e = new Engine({ live: l, paper: ledger() }); e.ledger = l; e.p = {}; e.c = { sellMode: 'mirror' };
  l.data.lots.push({ id: 'lot-one', wallet, mint, remaining: '1000000' });
  const pending = { signature: 'full-sell', wallet, createdAt: Date.now(), order: { kind: 'sell', inputMint: mint, outputMint: SOL, amount: '1000000', allocations: [{ lotId: 'lot-one', amount: '1000000' }], platformFee: prepared.plan } };
  l.data.pending.push(pending);
  const tx = { transaction: { signatures: [pending.signature], message: { accountKeys: [wallet, prepared.plan.destination, prepared.plan.source], instructions: prepared.instructions.map(publicInstruction) } },
    meta: { err: null, preTokenBalances: [token(wallet, mint, 1000000n, 6, 2)], postTokenBalances: [token(wallet, mint, 0n, 6, 2), token(collector, mint, 2500n, 6, 1)] } };
  await e.reconcileTransaction(pending, tx); assert.equal(l.data.lots[0].remaining, '0'); assert.equal(l.data.pending.length, 0); assert.equal(l.data.feeReceipts.length, 1);
  await e.reconcileTransaction(pending, tx); assert.equal(l.data.feeReceipts.length, 1); assert.equal(l.data.trades, 1);
});

test('LP first automatic withdrawal slice charges full position once; partial restart and manual withdrawals are exempt', async () => {
  const l = ledger(), e = new PortfolioEngine({ live: l, paper: ledger() }); e.ledger = l; e.accepting = true; e.abort = new AbortController(); e.runPlatformContext = context();
  e.kind = 'liquidity'; e.c = portfolioConfig(config({ mode: 'live', strategy: { baseMint: mint, quoteMint: SOL, budgetSol: '10' } }), 'liquidity');
  e.decimals = { [SOL]: 9, [mint]: 6 }; e.prices = { [SOL]: 100000000000000n, [mint]: 1000000000000n }; e.pricesAt = Date.now(); e.pool = { id: quote, venue: 'Meteora DLMM' };
  const r = { id: 'allocation', wallet, walletLabel: 'Test', tokens: { [SOL]: '1000000000' }, budget: '10000000000', fees: '0', turnover: '0', failures: 0, position: { ...e.pool }, exiting: 'rebalance' }; l.data.lots.push(r);
  let tiers = 0, sends = 0; const orders = [];
  e.adapter = { feeTier: async () => { tiers++; return { poolFeePpm: 3000, managementFeePpm: 150 }; }, positionAmounts: async () => ({ [SOL]: '1000000000' }),
    build: async () => ({ instructions: [SystemProgram.transfer({ fromPubkey: key1.publicKey, toPubkey: new PublicKey(quote), lamports: 1 })], lookupTables: [], signers: [], position: r.position, maxInputs: {}, partial: true }) };
  e.p = { refreshBlockhash: async () => {}, blockhash: { blockhash, lastValidBlockHeight: 1000 }, jitoTips: [] };
  e.sendPrepared = async (_r, _w, order) => {
    sends++; orders.push(order); const pending = { signature: `slice-${sends}`, wallet, createdAt: 100, order }; l.data.pending.push(pending);
    const fee = BigInt(order.platformFee?.chargedAmount || 0), receipt = order.platformFee ? verifyPlatformFee(pending, nativeReceipt(pending)) : null;
    await e.applyDeltas(pending, { [SOL]: -fee }, fee, false, receipt);
  };
  await e.executeLiquidity(r, { publicKey: wallet }, true);
  assert.equal(orders[0].platformFee.chargedAmount, '150000'); assert.equal(r.position.managementFeeCharged, true); assert.equal(l.data.feeReceipts.length, 1);
  // Simulate persistence and loading between two slices of this same position.
  r.position = JSON.parse(JSON.stringify(r.position)); await e.executeLiquidity(r, { publicKey: wallet }, true);
  assert.equal(orders[1].platformFee, null); assert.equal(tiers, 1); assert.equal(l.data.feeReceipts.length, 1);
  r.exiting = 'withdraw'; r.position = { ...e.pool }; e.prices = null;
  await e.executeLiquidity(r, { publicKey: wallet }, true); assert.equal(orders[2].platformFee, null); assert.equal(tiers, 1);
});

test('market-making execution charges 0.10% within its gross budget; LP funding swaps remain exempt', async () => {
  for (const kind of ['market', 'liquidity']) {
    const l = ledger(), e = new PortfolioEngine({ live: ledger(), paper: l }); e.ledger = l; e.accepting = true; e.abort = new AbortController(); e.runPlatformContext = context(); e.kind = kind;
    e.c = portfolioConfig(config({ mode: 'paper', strategy: { baseMint: mint, quoteMint: SOL, budgetSol: '1' } }), kind);
    e.decimals = { [SOL]: 9, [mint]: 6 }; e.prices = { [SOL]: 100000000000000n, [mint]: 1000000000000n }; e.pricesAt = Date.now();
    const r = { id: 'allocation', wallet, walletLabel: 'Test', budget: '1000000000', tokens: { [SOL]: '1000000000' }, fees: '0', turnover: '0', failures: 0 }; l.data.lots.push(r);
    let routed;
    e.p = { jitoTips: [], jupiterBuild: async (o, w) => { routed = o.amount; const result = build(o, w); result.outAmount = String(o.amount / 10n); result.otherAmountThreshold = result.outAmount; return result; } };
    await e.executeSwap(r, { publicKey: wallet }, { amount: 100000000n, inputMint: SOL, outputMint: mint, direction: 'buy' });
    assert.equal(r.failures, 0); assert.equal(routed, kind === 'market' ? 99900000n : 100000000n);
    assert.equal(BigInt(r.tokens[SOL]), 900000000n - e.feeEstimate());
    assert.equal(BigInt(r.fees), e.feeEstimate() + (kind === 'market' ? 100000n : 0n));
    assert.equal(l.data.feeReceipts.length, kind === 'market' ? 1 : 0);
    if (kind === 'market') assert.equal(l.data.feeReceipts[0].cashbackAmount, '0');
  }
});

test('sniper execution charges 1% and ignores client fee overrides, routes net, and journals one confirmed fee with its fill', async () => {
  const l = ledger(), receipts = new Map(); let builtAmount, submitted = 0;
  const p = { market: new Map(), jitoTips: [], init: async () => {}, subscribe: async () => {}, close() {}, markets: async () => {},
    balance: async () => 10000000000n, build: async (order, w) => { builtAmount = order.amount; return build(order, w); },
    rpc: async () => ({ value: { err: null } }), statuses: async signatures => signatures.map(sig => receipts.has(sig) ? { confirmationStatus: 'confirmed', err: null } : null),
    transaction: async sig => receipts.get(sig), height: async () => 100,
    submit: async bytes => {
      submitted++; const tx = VersionedTransaction.deserialize(bytes), signature = bs58.encode(tx.signatures[0]);
      const pending = l.data.pending.find(p => p.signature === signature); assert(pending, 'journal precedes any broadcast');
      const receipt = nativeReceipt(pending); receipt.meta.postTokenBalances.push(token(wallet, mint, 1000n, 6, 2)); receipts.set(signature, receipt);
      return { signature, route: 'test' };
    } };
  const e = new SniperEngine({ live: l, paper: ledger() }, () => p); e.platformContext = context(); e.receiptIntervalMs = 1;
  await e.start(config({ mode: 'live', platformContext: { ...context(), copyPpm: 0 }, copyPpm: 0, sniperPpm: 0, sniper: { developers: config().leads.join('\n') } }));
  await e.execute({ kind: 'buy', inputMint: SOL, outputMint: mint, outputDecimals: 6, amount: 1000000n, receivedAt: Date.now(), observedAt: performance.now() }, e.c.wallets[0]);
  assert.equal(builtAmount, 990000n); assert.equal(submitted, 1); assert.equal(l.data.pending.length, 0); assert.equal(l.data.lots.length, 1);
  assert.equal(l.data.feeReceipts[0].amount, '10000'); assert.equal(l.data.feeReceipts[0].cashbackAmount, '2000'); assert.equal(e.spend.get(wallet), 1000000n);
  assert.equal(l.data.feeReceipts[0].kind, 'sniper');
  e.stop(); await e.stopPromise;
});

