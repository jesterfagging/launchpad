// AgentChain receipt verification with fake RPC transactions. The chain adapter
// imports the Solana SDKs, so this file skips itself when those packages are
// not installed (the stub-loader sandbox); `npm test` on a full checkout runs it.
import test from 'node:test';
import assert from 'node:assert/strict';

let chainModule = null, web3 = null, loadError = '';
try { chainModule = await import('../src/agent/chain.mjs'); web3 = await import('@solana/web3.js'); } catch (error) { loadError = error?.message || String(error); }
let realSdk = false; try { realSdk = web3?.SystemProgram?.programId?.toBase58?.() === '11111111111111111111111111111111' && typeof web3.Keypair?.generate === 'function'; } catch { realSdk = false; }
const skip = !chainModule || !web3 ? 'Solana SDK packages are not installed: ' + loadError : !realSdk ? 'The Solana SDK in this environment is a stub; run with real dependencies.' : false;

const SIG = '5'.repeat(88), MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', SYSTEM = '11111111111111111111111111111111';
function keypairs() { const sender = web3.Keypair.generate().publicKey.toBase58(), agent = web3.Keypair.generate().publicKey.toBase58(); return { sender, agent }; }
function transferData(lamports) { const data = Buffer.alloc(12); data.writeUInt32LE(2, 0); data.writeBigUInt64LE(BigInt(lamports), 4); return data; }
function fakeDeposit({ sender, agent, lamports, memo, err = null, extraTransferFrom = null }) {
  const keys = [sender, agent, SYSTEM, MEMO_PROGRAM, ...(extraTransferFrom ? [extraTransferFrom] : [])];
  const instructions = [
    { programIdIndex: 2, accountKeyIndexes: [0, 1], data: transferData(lamports) },
    { programIdIndex: 3, accountKeyIndexes: [], data: Buffer.from(memo, 'utf8') },
    ...(extraTransferFrom ? [{ programIdIndex: 2, accountKeyIndexes: [4, 1], data: transferData(1) }] : []),
  ];
  const received = BigInt(lamports) + (extraTransferFrom ? 1n : 0n);
  return { slot: 391204410, blockTime: 1790000000, transaction: { signatures: [SIG], message: { header: { numRequiredSignatures: 1 }, staticAccountKeys: keys, compiledInstructions: instructions } },
    meta: { err, fee: 5000, preBalances: [10_000_000_000, 1_000_000, 1, 1, ...(extraTransferFrom ? [5_000_000] : [])], postBalances: [10_000_000_000 - Number(lamports) - 5000, 1_000_000 + Number(received), 1, 1, ...(extraTransferFrom ? [4_999_999] : [])], innerInstructions: [], preTokenBalances: [], postTokenBalances: [], loadedAddresses: { writable: [], readonly: [] } } };
}
function chainWith(tx) {
  const chain = Object.create(chainModule.AgentChain.prototype);
  chain.c = { getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'finalized', slot: tx.slot }] }), getTransaction: async () => tx };
  chain.routeGuard = null; return chain;
}

test('deposit memos are bound to the agent, purpose and nonce', { skip }, () => {
  assert.equal(chainModule.depositMemo('a'.repeat(24), 'activity', 'n1'), 'agent:' + 'a'.repeat(24) + ':activity:n1');
  assert.equal(chainModule.MEMO_PROGRAM, MEMO_PROGRAM);
  assert.equal(chainModule.SETTLEMENT_GUARD.slippageBps, 50); assert.equal(chainModule.BUYBACK_GUARD.slippageBps, 100);
});

// The compute-unit limit a compiled deposit requests (SetComputeUnitLimit: tag 2, u32 LE).
function unitsOf(message) { const ix = message.compiledInstructions[0]; const data = Buffer.from(ix.data); assert.equal(data[0], 2); return data.readUInt32LE(1); }
function depositChain({ lamports = 1_000_000_000, simulate }) {
  const chain = Object.create(chainModule.AgentChain.prototype), simulations = [];
  chain.now = () => 1790000000000; chain.routeGuard = null;
  chain.c = {
    getMultipleAccountsInfoAndContext: async (keys, config) => { assert.equal(keys.length, 2); assert.equal(config.commitment, 'confirmed'); return { context: { slot: 500 }, value: [{ executable: false, owner: web3.SystemProgram.programId, lamports, data: Buffer.alloc(0) }, null] }; },
    getLatestBlockhash: async () => ({ blockhash: web3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 }),
    // 5,000 lamports base plus the priority fee the requested units imply at 10,000 micro-lamports each.
    getFeeForMessage: async message => ({ value: 5000 + Math.ceil(unitsOf(message) * 10000 / 1_000_000) }),
    simulateTransaction: async (tx, config) => { simulations.push({ units: unitsOf(tx.message), config }); return simulate(simulations.length); },
  };
  return { chain, simulations };
}

test('a deposit measures its compute limit with a probe at the ceiling, so a long memo cannot fail the memo program', { skip }, async () => {
  const { sender, agent } = keypairs(), memo = chainModule.depositMemo('c'.repeat(24), 'activity', 'abcdef012345'), request = { sender, recipient: agent, lamports: '200000000', memo };
  const measured = depositChain({ simulate: () => ({ context: { slot: 501 }, value: { err: null, unitsConsumed: 24150 } }) });
  const op = await measured.chain.prepareDeposit(request);
  assert.equal(measured.simulations.length, 2, 'one probe, one final simulation');
  assert.equal(measured.simulations[0].units, 200000, 'the probe runs at the ceiling');
  assert.equal(measured.simulations[1].units, Math.ceil(24150 * 1.3) + 3000, 'the signed message carries the measured use plus margin');
  for (const sim of measured.simulations) { assert.equal(sim.config.sigVerify, false); assert.equal(sim.config.minContextSlot, 500); assert.equal(sim.config.commitment, 'confirmed'); }
  const message = web3.VersionedTransaction.deserialize(Buffer.from(op.unsignedRaw, 'base64')).message;
  assert.equal(unitsOf(message), Math.ceil(24150 * 1.3) + 3000);
  assert.equal(message.header.numRequiredSignatures, 1); assert.equal(message.staticAccountKeys[0].toBase58(), sender);
  const memoIx = message.compiledInstructions[3]; assert.equal(message.staticAccountKeys[memoIx.programIdIndex].toBase58(), MEMO_PROGRAM); assert.equal(Buffer.from(memoIx.data).toString('utf8'), memo); assert.equal(memoIx.accountKeyIndexes.length, 0);
  assert.deepEqual([op.kind, op.needsSignature, op.state, op.externalSigner, op.recipient, op.inputAmount, op.memo, op.preparedSlot, op.lastValidBlockHeight], ['deposit', true, 'awaiting_signature', sender, agent, '200000000', memo, 501, 1000]);
  // Without a measured figure the ceiling itself is signed.
  const unmeasured = depositChain({ simulate: () => ({ context: { slot: 501 }, value: { err: null } }) });
  await unmeasured.chain.prepareDeposit(request);
  assert.deepEqual(unmeasured.simulations.map(s => s.units), [200000, 200000]);
  // The probe's failure is reported as the deposit's.
  const failing = depositChain({ simulate: () => ({ context: { slot: 501 }, value: { err: { InstructionError: [3, 'ProgramFailedToComplete'] } } }) });
  await assert.rejects(failing.chain.prepareDeposit(request), /Deposit simulation failed: \{"InstructionError":\[3,"ProgramFailedToComplete"\]\}/);
  assert.equal(failing.simulations.length, 1);
  // A wallet short of the deposit plus the ceiling fee is named before anything is simulated.
  const short = depositChain({ lamports: 200_000_000 + 6000, simulate: () => ({ context: { slot: 501 }, value: { err: null, unitsConsumed: 24150 } }) });
  await assert.rejects(short.chain.prepareDeposit(request), /cannot cover this deposit and its network fee/);
  assert.equal(short.simulations.length, 0);
  // The memo is bounded and the funder can never be the agent wallet.
  await assert.rejects(measured.chain.prepareDeposit({ ...request, memo: 'x'.repeat(81) }), /Invalid deposit memo/);
  await assert.rejects(measured.chain.prepareDeposit({ ...request, recipient: sender }), /cannot be the agent wallet/);
});

test('a finalized deposit receipt must match sender, recipient, amount and memo exactly', { skip }, async () => {
  const { sender, agent } = keypairs(), memo = chainModule.depositMemo('b'.repeat(24), 'treasury', 'nonce-1');
  const good = await chainWith(fakeDeposit({ sender, agent, lamports: 50_000_000, memo })).depositReceipt({ signature: SIG, sender, recipient: agent, lamports: '50000000', memo });
  assert.equal(good.state, 'finalized'); assert.equal(good.receivedAmount, '50000000'); assert.equal(good.feeLamports, '5000');
  const failed = await chainWith(fakeDeposit({ sender, agent, lamports: 50_000_000, memo, err: { InstructionError: [0, 'Custom'] } })).depositReceipt({ signature: SIG, sender, recipient: agent, lamports: '50000000', memo });
  assert.equal(failed.state, 'failed');
  await assert.rejects(chainWith(fakeDeposit({ sender, agent, lamports: 40_000_000, memo })).depositReceipt({ signature: SIG, sender, recipient: agent, lamports: '50000000', memo }), /differs from its intent/);
  await assert.rejects(chainWith(fakeDeposit({ sender, agent, lamports: 50_000_000, memo: 'agent:other' })).depositReceipt({ signature: SIG, sender, recipient: agent, lamports: '50000000', memo }), /intent memo/);
  const other = keypairs().sender;
  await assert.rejects(chainWith(fakeDeposit({ sender, agent, lamports: 50_000_000, memo, extraTransferFrom: other })).depositReceipt({ signature: SIG, sender, recipient: agent, lamports: '50000000', memo }), /different senders/);
  await assert.rejects(chainWith(fakeDeposit({ sender: other, agent, lamports: 50_000_000, memo })).depositReceipt({ signature: SIG, sender, recipient: agent, lamports: '50000000', memo }), /not signed by the funding wallet/);
  const pending = Object.create(chainModule.AgentChain.prototype); pending.c = { getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed', slot: 1 }] }), getTransaction: async () => null };
  assert.equal(await pending.depositReceipt({ signature: SIG, sender, recipient: agent, lamports: '50000000', memo }), null);
});
