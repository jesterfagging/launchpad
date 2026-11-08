import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, SystemInstruction } from '@solana/web3.js';
import {
  MintLayout, AccountLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT,
  ExtensionType, getTypeLen, getAssociatedTokenAddressSync, decodeTransferCheckedInstruction,
  decodeCloseAccountInstruction, decodeInitializeAccount3Instruction,
} from '@solana/spl-token';
import { holderSnapshot, allocateHolderRewards, mergeHolderRewardPayouts, prepareHolderPayoutInstructions, MAX_REWARD_UNITS } from '../src/meteora-rewards.mjs';

const address = () => Keypair.generate().publicKey;
const info = (data, owner = TOKEN_PROGRAM_ID, lamports = 2039280) => ({ data, owner, lamports, executable: false });
const extension = (type, fill = () => {}) => {
  const data = Buffer.alloc(4 + getTypeLen(type)); data.writeUInt16LE(type); data.writeUInt16LE(data.length - 4, 2); fill(data.subarray(4)); return data;
};
function mintAccount({ decimals = 6, program = TOKEN_PROGRAM_ID, extensions = [] } = {}) {
  const data = Buffer.alloc(extensions.length ? 166 + extensions.reduce((n, x) => n + x.length, 0) : MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000000000000000n, decimals, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  if (extensions.length) { data[165] = 1; Buffer.concat(extensions).copy(data, 166); }
  return info(data, program);
}
function tokenAccount({ mint, owner, amount = 10n, state = 1, program = TOKEN_PROGRAM_ID, extensions = [] }) {
  const data = Buffer.alloc(extensions.length ? 166 + extensions.reduce((n, x) => n + x.length, 0) : AccountLayout.span);
  AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  if (extensions.length) { data[165] = 2; Buffer.concat(extensions).copy(data, 166); }
  return info(data, program);
}
const nativeAccount = (lamports = 1000000) => info(Buffer.alloc(0), SystemProgram.programId, lamports);
const rawRow = ({ pubkey, account }) => ({ pubkey: pubkey.toBase58(), account: { ...account, owner: account.owner.toBase58(), data: [account.data.toString('base64'), 'base64'] } });

test('holder snapshot consumes complete finalized pages, merges owners, excludes vaults and managed wallets', async () => {
  const mint = address(), a = address(), b = address(), authority = address(), gas = address(), excluded = address();
  const vaultOwner = PublicKey.findProgramAddressSync([Buffer.from('vault')], TOKEN_PROGRAM_ID)[0];
  const row = (owner, amount = 10n, state = 1) => ({ pubkey: address(), account: tokenAccount({ mint, owner, amount, state }) });
  const one = row(a, 4n), two = row(a, 9n), three = row(b, 3n), excludedRow = row(excluded, 88n);
  const pages = [[one, row(authority), row(gas), row(vaultOwner), row(a, 0n), row(a, 3n, 2)], [], [two, three, excludedRow]];
  const calls = []; const connection = {
    rpcEndpoint: 'https://mainnet.helius-rpc.com/?api-key=fixture',
    getAccountInfoAndContext: async (_mint, config) => { assert.equal(config.commitment, 'finalized'); assert.equal(config.minContextSlot, 90); return { context: { slot: 100 }, value: mintAccount() }; },
    _rpcRequest: async (method, params) => { const index = calls.length; calls.push(params); assert.equal(method, 'getProgramAccountsV2'); return { jsonrpc: '2.0', result: { context: { slot: 101 + index }, value: { accounts: pages[index].map(rawRow), paginationKey: index === 2 ? null : String(index) } } }; },
  };
  const result = await holderSnapshot({ connection, launch: { mint: mint.toBase58(), creatorAuthority: authority.toBase58(), gasWallet: gas.toBase58() }, excludeAddresses: [excludedRow.pubkey.toBase58()], minContextSlot: 90 });
  assert.equal(calls.length, 3); assert.deepEqual(calls.map(p => p[1].minContextSlot), [100, 101, 102]); assert.equal(result.slot, 103);
  assert.deepEqual(result.rows, [{ owner: a.toBase58(), amount: '13' }, { owner: b.toBase58(), amount: '3' }].sort((a, b) => a.owner.localeCompare(b.owner)));
  assert.equal(result.eligibleBalance, '16'); assert.equal(result.excludedAccounts, 6); assert.equal(result.scannedAccounts, 9);
});

test('holder scan does not return partial recipients after a later page fails', async () => {
  const mint = address(); let calls = 0;
  const connection = {
    rpcEndpoint: 'https://mainnet.helius-rpc.com/?api-key=fixture',
    getAccountInfoAndContext: async () => ({ context: { slot: 100 }, value: mintAccount() }),
    _rpcRequest: async () => ++calls === 1 ? { jsonrpc: '2.0', result: { context: { slot: 100 }, value: { accounts: [rawRow({ pubkey: address(), account: tokenAccount({ mint, owner: address() }) })], paginationKey: 'next' } } } : { jsonrpc: '2.0', error: { code: -32005, message: 'RPC overloaded' } },
  };
  await assert.rejects(holderSnapshot({ connection, launch: { mint: mint.toBase58() } }), { code: 'REWARD_ACCOUNT_SCAN_RETRY' }); assert.equal(calls, 2);
});

test('allocation is exact above Number precision, consolidates owners, and keeps rounding and minimum dust', () => {
  const a = address().toBase58(), b = address().toBase58();
  const result = allocateHolderRewards('18446744073709551615', [{ owner: a, amount: '1' }, { owner: a, amount: '1' }, { owner: b, amount: '1' }]);
  assert.equal(result.payouts.find(r => r.owner === a).amount, '12297829382473034410');
  assert.equal(result.payouts.find(r => r.owner === b).amount, '6148914691236517205'); assert.equal(result.remainder, '0');
  const dust = allocateHolderRewards('10', [{ owner: a, amount: '1' }, { owner: b, amount: '2' }], { minimumRaw: '4' });
  assert.deepEqual(dust.payouts, [{ owner: b, amount: '6' }]); assert.equal(dust.remainder, '4');
  assert.equal(allocateHolderRewards('99', []).remainder, '99');
});

test('amount parsing rejects malformed, signed, floating and overflowing values before allocation', () => {
  const owner = address().toBase58();
  for (const bad of [-1n, MAX_REWARD_UNITS + 1n, '-1', '+1', ' 1', '01', '1e9', '1.1', '1\n', '', 1, Number.MAX_SAFE_INTEGER, null, {}, '9'.repeat(100000)]) {
    assert.throws(() => allocateHolderRewards(bad, [{ owner, amount: '1' }]), /amount|limits/);
    assert.throws(() => allocateHolderRewards('1', [{ owner, amount: bad }]), /amount|limits/);
  }
  assert.throws(() => allocateHolderRewards('1', [{ owner, amount: MAX_REWARD_UNITS.toString() }, { owner, amount: '1' }]), /limits/);
  const offCurve = PublicKey.findProgramAddressSync([Buffer.from('ineligible')], TOKEN_PROGRAM_ID)[0];
  assert.throws(() => allocateHolderRewards('1', [{ owner: offCurve.toBase58(), amount: '1' }]));
});

test('deferred payouts merge exact debts independently of current holder ownership', () => {
  const owner = address().toBase58(), exited = address().toBase58();
  assert.deepEqual(mergeHolderRewardPayouts([{ owner, amount: '3' }, { owner: exited, amount: '9' }], [{ owner, amount: '5' }]), [{ owner, amount: '8' }, { owner: exited, amount: '9' }].sort((a, b) => a.owner.localeCompare(b.owner)));
  assert.throws(() => mergeHolderRewardPayouts([{ owner, amount: MAX_REWARD_UNITS.toString() }], [{ owner, amount: '1' }]), /limits/);
  assert.throws(() => mergeHolderRewardPayouts([{ owner, amount: '1' }, { owner, amount: '1' }]), /Duplicate/);
});

function payoutFixture({ native = false, program = TOKEN_PROGRAM_ID, extensions = [], sourceAmount = 999999999n } = {}) {
  const mint = native ? NATIVE_MINT : address(), source = address(), wallet = address();
  const launch = { mint: address().toBase58(), quoteMint: mint.toBase58(), quoteDecimals: native ? 9 : 6, quoteProgram: program.toBase58(), creatorAuthority: source.toBase58() };
  const from = getAssociatedTokenAddressSync(mint, source, false, program), accounts = new Map([
    [mint.toBase58(), mintAccount({ decimals: launch.quoteDecimals, program, extensions })],
    [from.toBase58(), tokenAccount({ mint, owner: source, amount: sourceAmount, program })],
  ]), calls = [], rentSizes = [];
  const connection = {
    getAccountInfoAndContext: async (key, config) => { calls.push(config); assert.equal(config.commitment, 'finalized'); return { context: { slot: 100 }, value: accounts.get(key.toBase58()) ?? null }; },
    getMultipleAccountsInfoAndContext: async (keys, config) => { calls.push(config); assert.equal(config.commitment, 'finalized'); return { context: { slot: 100 }, value: keys.map(k => accounts.get(k.toBase58()) ?? null) }; },
    getMinimumBalanceForRentExemption: async size => { rentSizes.push(size); return size ? 2039280 : 890880; },
  };
  const add = (owner, data) => accounts.set((native ? owner : getAssociatedTokenAddressSync(mint, owner, false, program)).toBase58(), data);
  return { mint, source, wallet, launch, from, accounts, calls, rentSizes, connection, add, prepare: (payouts, extra = {}) => prepareHolderPayoutInstructions({ connection, wallet, launch, source, payouts, minContextSlot: 90, operationId: 'durable-cycle:batch-1', ...extra }) };
}

test('SPL payouts use exact checked transfers and gas payer funds only missing recipient ATAs', async () => {
  const f = payoutFixture(), a = address(), b = address();
  f.add(b, tokenAccount({ mint: f.mint, owner: b }));
  const payouts = [{ owner: a.toBase58(), amount: '101' }, { owner: b.toBase58(), amount: '102' }], result = await f.prepare(payouts);
  assert.equal(result.instructions.length, 3); assert.deepEqual(result.payouts, payouts); assert.deepEqual(result.deferredPayouts, []); assert.equal(result.quoteDebitRaw, '203'); assert.equal(result.rentLamports, '2039280');
  const create = result.instructions[0]; assert(create.keys[0].pubkey.equals(f.wallet));
  for (const [index, ix] of [result.instructions[1], result.instructions[2]].entries()) {
    const transfer = decodeTransferCheckedInstruction(ix); assert.equal(transfer.data.amount, BigInt(payouts[index].amount)); assert(transfer.keys.owner.pubkey.equals(f.source)); assert(transfer.keys.source.pubkey.equals(f.from));
  }
  assert.deepEqual(f.rentSizes, [165]); assert(f.calls.every(row => row.minContextSlot >= 90));
});

test('frozen stock recipients retain exact debts while other recipients remain payable', async () => {
  const f = payoutFixture({ program: TOKEN_2022_PROGRAM_ID, extensions: [extension(ExtensionType.PermanentDelegate)] }), a = address(), b = address();
  f.add(a, tokenAccount({ mint: f.mint, owner: a, state: 2, program: TOKEN_2022_PROGRAM_ID }));
  const result = await f.prepare([{ owner: a.toBase58(), amount: '4' }, { owner: b.toBase58(), amount: '8' }]);
  assert.deepEqual(result.deferredPayouts, [{ owner: a.toBase58(), amount: '4', reason: 'recipient-frozen' }]); assert.equal(result.quoteDebitRaw, '8');
  assert.deepEqual(f.rentSizes, [170]); assert.equal(decodeTransferCheckedInstruction(result.instructions[1], TOKEN_2022_PROGRAM_ID).data.amount, 8n);
});

test('a stock quote with an incoming-memo ATA receives a memo immediately before its exact transfer', async () => {
  const f = payoutFixture({ program: TOKEN_2022_PROGRAM_ID }), owner = address();
  f.add(owner, tokenAccount({ mint: f.mint, owner, program: TOKEN_2022_PROGRAM_ID, extensions: [extension(ExtensionType.MemoTransfer, data => { data[0] = 1; })] }));
  const result = await f.prepare([{ owner: owner.toBase58(), amount: '2' }]);
  assert.equal(result.instructions.length, 2); assert.equal(result.instructions[0].programId.toBase58(), 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'); assert.equal(result.rentLamports, '0');
  assert.equal(decodeTransferCheckedInstruction(result.instructions[1], TOKEN_2022_PROGRAM_ID).data.amount, 2n);
});

test('native rewards unwrap only the saved exact batch, refund temporary rent, and preserve unrelated WSOL', async () => {
  const f = payoutFixture({ native: true, sourceAmount: 999999999n }), owner = address(); f.add(owner, nativeAccount());
  const result = await f.prepare([{ owner: owner.toBase58(), amount: '12345' }]);
  assert.equal(result.instructions.length, 5); assert.equal(result.quoteDebitRaw, '12345'); assert.equal(result.rentLamports, '2039280');
  const create = SystemInstruction.decodeCreateWithSeed(result.instructions[0]), init = decodeInitializeAccount3Instruction(result.instructions[1]);
  assert(create.fromPubkey.equals(f.wallet)); assert(create.basePubkey.equals(f.wallet)); assert.equal(create.lamports, 2039280); assert(init.data.owner.equals(f.source));
  const transfer = decodeTransferCheckedInstruction(result.instructions[2]), close = decodeCloseAccountInstruction(result.instructions[3]);
  assert.equal(transfer.data.amount, 12345n); assert(transfer.keys.source.pubkey.equals(f.from)); assert(transfer.keys.destination.pubkey.equals(create.newAccountPubkey));
  assert(close.keys.destination.pubkey.equals(f.wallet)); assert(close.keys.authority.pubkey.equals(f.source));
  const send = SystemInstruction.decodeTransfer(result.instructions[4]); assert(send.fromPubkey.equals(f.wallet)); assert(send.toPubkey.equals(owner)); assert.equal(send.lamports, 12345n);
  const again = await f.prepare([{ owner: owner.toBase58(), amount: '12345' }]); assert(SystemInstruction.decodeCreateWithSeed(again.instructions[0]).newAccountPubkey.equals(create.newAccountPubkey));
});

test('empty SOL recipient below rent is deferred without subsidizing or losing their allocation', async () => {
  const f = payoutFixture({ native: true }), empty = address(), funded = address(); f.add(funded, nativeAccount());
  const result = await f.prepare([{ owner: empty.toBase58(), amount: '100' }, { owner: funded.toBase58(), amount: '201' }]);
  assert.deepEqual(result.deferredPayouts, [{ owner: empty.toBase58(), amount: '100', reason: 'recipient-rent' }]);
  assert.deepEqual(result.payouts, [{ owner: funded.toBase58(), amount: '201' }]); assert.equal(result.quoteDebitRaw, '201');
  const allBlocked = await f.prepare([{ owner: empty.toBase58(), amount: '100' }]); assert.equal(allBlocked.instructions.length, 0); assert.equal(allBlocked.quoteDebitRaw, '0'); assert.equal(allBlocked.rentLamports, '0');
  const enough = await f.prepare([{ owner: empty.toBase58(), amount: '890880' }]); assert.equal(enough.quoteDebitRaw, '890880'); assert.deepEqual(enough.deferredPayouts, []);
});

test('malformed or stale recipient snapshots never become skipped or silently deferred payments', async () => {
  for (const native of [false, true]) for (const bad of [{ context: { slot: 99 }, value: [null] }, { context: { slot: 100 }, value: [] }, { context: { slot: 100 }, value: [undefined] }]) {
    const f = payoutFixture({ native }); f.connection.getMultipleAccountsInfoAndContext = async () => bad;
    await assert.rejects(f.prepare([{ owner: address().toBase58(), amount: '1' }]), /snapshot|account data/);
  }
});

test('payout validation rejects duplicates, source/self recipients, mismatched authorities and insufficient credit', async () => {
  const f = payoutFixture({ sourceAmount: 5n }), owner = address().toBase58();
  await assert.rejects(f.prepare([{ owner, amount: '3' }, { owner, amount: '2' }]), /Duplicate/);
  for (const recipient of [f.source, f.wallet]) await assert.rejects(f.prepare([{ owner: recipient.toBase58(), amount: '1' }]), /source or gas wallet/);
  await assert.rejects(f.prepare([{ owner, amount: '1' }], { source: address() }), /authority differs/);
  await assert.rejects(f.prepare([{ owner, amount: '6' }]), { code: 'METEORA_REWARD_FUNDING' });
  await assert.rejects(f.prepare([{ owner, amount: 1 }]), /exact saved strings/);
  await assert.rejects(f.prepare([{ owner, amount: '1' }], { launch: { ...f.launch, quoteDecimals: 9 } }), /decimals/);
});

test('transfer-tax and active transfer-hook quotes cannot silently underpay exact obligations', async () => {
  const fee = extension(ExtensionType.TransferFeeConfig, data => { data.writeUInt16LE(1, 88); });
  const hook = extension(ExtensionType.TransferHook, data => address().toBuffer().copy(data, 32));
  for (const ext of [fee, hook, extension(ExtensionType.NonTransferable)]) {
    const f = payoutFixture({ program: TOKEN_2022_PROGRAM_ID, extensions: [ext] });
    await assert.rejects(f.prepare([{ owner: address().toBase58(), amount: '1' }]), { code: 'METEORA_REWARD_QUOTE_UNSUPPORTED' });
  }
});

test('paused quote and default-frozen new ATAs preserve the entire unpaid reward', async () => {
  const paused = payoutFixture({ program: TOKEN_2022_PROGRAM_ID, extensions: [extension(ExtensionType.PausableConfig, data => { data[32] = 1; })] });
  const defaultFrozen = payoutFixture({ program: TOKEN_2022_PROGRAM_ID, extensions: [extension(ExtensionType.DefaultAccountState, data => { data[0] = 2; })] });
  for (const [f, reason] of [[paused, 'quote-paused'], [defaultFrozen, 'recipient-frozen']]) {
    const owner = address().toBase58(), result = await f.prepare([{ owner, amount: '7' }]);
    assert.equal(result.instructions.length, 0); assert.equal(result.quoteDebitRaw, '0'); assert.deepEqual(result.deferredPayouts, [{ owner, amount: '7', reason }]);
  }
});

test('manual creator withdrawal permits its registered recipient as payer and unwraps only earned credit', async () => {
  const f = payoutFixture({ native: true }); f.launch.feeMode = 'creator'; f.launch.creatorRecipient = f.wallet.toBase58();
  f.add(f.wallet, nativeAccount(1_000_000));
  const payout = [{ owner: f.wallet.toBase58(), amount: '999' }];
  const plan = await f.prepare(payout, { allowPayerRecipient: true });
  assert.equal(plan.quoteDebitRaw, '999');
  assert.equal(plan.instructions.filter(ix => ix.programId.equals(SystemProgram.programId) && SystemInstruction.decodeInstructionType(ix) === 'Transfer').length, 0);
  const close = plan.instructions.find(ix => ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 9);
  assert.equal(decodeCloseAccountInstruction(close).keys.destination.pubkey.toBase58(), f.wallet.toBase58());
  await assert.rejects(f.prepare(payout, { allowPayerRecipient: true, launch: { ...f.launch, feeMode: 'holders' } }), /source or gas wallet/);
  await assert.rejects(f.prepare(payout, { allowPayerRecipient: true, launch: { ...f.launch, creatorRecipient: address().toBase58() } }), /source or gas wallet/);
});
