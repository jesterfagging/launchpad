// AI Agent chain adapter: the Gotchi/protocol-treasury adapter (verified
// Jupiter route, airdrops, holder scans, finalized receipts) plus the few
// operations agents need that the treasury never performs: settling operating
// SOL into USDC under a tighter route guard, buying the agent's own coin,
// burning exactly the purchased tokens, verifying user-signed funding deposits
// and transferring backed USDC to the operator's reimbursement wallet.
// Every signed operation is journaled by the service before broadcast and
// reconciled from the finalized transaction, never from a submission response.
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint, unpackAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, createBurnCheckedInstruction } from '@solana/spl-token';
import { GotchiChain } from '../gotchi-chain.mjs';
import { LaunchChain } from '../launchpad-chain.mjs';
import { verifySignedTransaction, transactionSize } from '../providers.mjs';
import { requireValue as ok } from '../../public/launchpad-model.mjs';
import { USDC_MINT, AGENT_QUOTE_MINT, AGENT_POLICY_V1 } from '../../public/agent-catalog.mjs';

export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const FEE_LIMIT = 20000n, EXTRA_COST_LIMIT = 15000000n, MAX_U64 = 18446744073709551615n;
// A funder's deposit: the probe runs at the ceiling and the signed message carries the measured use plus margin.
// 200,000 units at this price is 2,000 lamports of priority fee, inside FEE_LIMIT.
const DEPOSIT_UNITS_CEILING = 200000, DEPOSIT_UNIT_PRICE = 10000;
const pk = value => new PublicKey(value), hash = value => createHash('sha256').update(value).digest('hex');
const quantity = (value, zero = false) => { ok(typeof value === 'string' && (zero ? /^(?:0|[1-9]\d{0,19})$/ : /^[1-9]\d{0,19}$/).test(value) && BigInt(value) <= MAX_U64, 'Invalid agent raw amount.'); return BigInt(value); };
const lamports = value => { ok(Number.isSafeInteger(value) && value >= 0, 'The RPC returned an invalid SOL balance.'); return BigInt(value); };
const wallet = value => { const key = pk(value); ok(key.toBase58() === value && PublicKey.isOnCurve(key.toBytes()), 'Invalid agent wallet.'); return key; };
export const SETTLEMENT_GUARD = Object.freeze({ slippageBps: AGENT_POLICY_V1.settlement.slippageBps, maxImpact: AGENT_POLICY_V1.settlement.maxPriceImpactBps / 10000 });
export const BUYBACK_GUARD = Object.freeze({ slippageBps: AGENT_POLICY_V1.treasury.slippageBps, maxImpact: AGENT_POLICY_V1.treasury.maxPriceImpactBps / 10000 });

function receiptKeys(tx) {
  const message = tx.transaction?.message, keys = message?.staticAccountKeys || message?.accountKeys;
  ok(Array.isArray(keys), 'The finalized receipt is missing account keys.');
  const base = keys.map(value => String(value.pubkey || value));
  const result = base.length === tx.meta?.preBalances?.length ? base : [...base, ...(tx.meta?.loadedAddresses?.writable || []).map(String), ...(tx.meta?.loadedAddresses?.readonly || []).map(String)];
  ok(result.length === tx.meta?.preBalances?.length && result.length === tx.meta?.postBalances?.length && new Set(result).size === result.length, 'The finalized receipt contains incomplete account balances.');
  return result;
}
function nativeDelta(tx, keys, address) { const index = keys.indexOf(address); ok(index >= 0, 'The finalized receipt omitted an expected account.'); return lamports(tx.meta.postBalances[index]) - lamports(tx.meta.preBalances[index]); }
function tokenBalance(tx, keys, side, account) {
  const rows = tx.meta?.[side + 'TokenBalances']; ok(Array.isArray(rows), 'The finalized receipt omitted token balances.');
  let total = 0n;
  for (const row of rows) { ok(Number.isSafeInteger(row.accountIndex) && row.accountIndex >= 0 && row.accountIndex < keys.length, 'The finalized receipt contains invalid token-account indexes.'); if (keys[row.accountIndex] === account) total += quantity(String(row.uiTokenAmount?.amount ?? '0'), true); }
  return total;
}
function instructionList(tx, keys) {
  const message = tx.transaction.message, list = [...(message.compiledInstructions || message.instructions || []), ...(tx.meta.innerInstructions || []).flatMap(row => row.instructions || [])];
  return list.map(ix => ({ program: String(ix.programId || keys[ix.programIdIndex]), accounts: (ix.accountKeyIndexes || ix.accounts || []).map(index => typeof index === 'number' ? keys[index] : String(index)), data: ix.parsed ? null : typeof ix.data === 'string' ? Buffer.from(bs58.decode(ix.data)) : Buffer.from(ix.data || []), parsed: ix.parsed || null }));
}
export function depositMemo(agentId, purpose, nonce) { return `agent:${agentId}:${purpose}:${nonce}`; }

export class AgentChain extends GotchiChain {
  async withRouteGuard(guard, fn) { const previous = this.routeGuard; this.routeGuard = guard; try { return await fn(); } finally { this.routeGuard = previous; } }
  /** Operating SOL -> USDC in the agent's own wallet under the 50 bps settlement guard. */
  prepareSettlement({ wallet: signer, lamports: amount, minSolReserve = '0', maxNetworkCostLamports = '5000000' }) {
    ok(quantity(String(amount)) >= BigInt(AGENT_POLICY_V1.settlement.minimumBatchLamports), 'The settlement batch is below the minimum economic size.');
    return this.withRouteGuard(SETTLEMENT_GUARD, () => this.prepare({ kind: 'acquire', wallet: signer, mint: USDC_MINT, amount: String(amount), minSolReserve, maxNetworkCostLamports }));
  }
  /** Buys the agent's own coin with treasury SOL under the 100 bps buyback guard. */
  prepareBuyback({ wallet: signer, mint, lamports: amount, minSolReserve = '0', maxNetworkCostLamports = '5000000' }) {
    ok(mint !== AGENT_QUOTE_MINT && mint !== USDC_MINT, 'Buybacks target the agent coin only.');
    return this.withRouteGuard(BUYBACK_GUARD, () => this.prepare({ kind: 'acquire', wallet: signer, mint, amount: String(amount), minSolReserve, maxNetworkCostLamports }));
  }
  /** Burns exactly `amount` of the agent coin held by the agent wallet (never pre-existing or unrelated tokens beyond the purchased delta the caller passes). */
  async prepareIncinerate({ wallet: signer, mint, amount, maxNetworkCostLamports = '5000000' }) {
    const owner = wallet(signer?.address), input = quantity(String(amount)), maxCost = quantity(maxNetworkCostLamports); ok(maxCost <= EXTRA_COST_LIMIT, 'The burn network-cost limit is too large.');
    ok(typeof signer?.secret === 'string' && signer.secret.length > 0, 'A managed agent signer is required.');
    const summary = await this.mintSummary(mint), program = pk(summary.program), key = pk(mint), ata = getAssociatedTokenAddressSync(key, owner, false, program);
    const before = await this.c.getMultipleAccountsInfoAndContext([owner, ata, key], { commitment: 'finalized' });
    ok(Number.isSafeInteger(before?.context?.slot) && Array.isArray(before.value) && before.value.length === 3 && before.value[0] && before.value[1] && before.value[2], 'The RPC returned an incomplete burn snapshot.');
    ok(!before.value[0].executable && before.value[0].owner.equals(SystemProgram.programId), 'The agent wallet must be an ordinary SOL wallet.');
    const account = unpackAccount(ata, before.value[1], program); ok(account.mint.equals(key) && account.owner.equals(owner) && !account.isFrozen && account.amount >= input, 'The agent wallet does not hold the tokens to burn.');
    const supplyBefore = unpackMint(key, before.value[2], program).supply, native = lamports(before.value[0].lamports);
    const block = await this.c.getLatestBlockhash('finalized'); ok(Number.isSafeInteger(block.lastValidBlockHeight) && block.lastValidBlockHeight >= 151, 'The RPC omitted burn transaction expiry.');
    const message = new TransactionMessage({ payerKey: owner, recentBlockhash: block.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 60000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }), createBurnCheckedInstruction(ata, key, owner, input, summary.decimals, [], program)] }).compileToV0Message();
    ok(message.header.numRequiredSignatures === 1 && transactionSize(message) <= 1232, 'The burn transaction needs another signer.');
    const fee = lamports((await this.c.getFeeForMessage(message, 'finalized'))?.value); ok(fee > 0n && fee <= FEE_LIMIT && fee <= maxCost, 'The burn network fee exceeds its limit.');
    const tx = new VersionedTransaction(message), addresses = [owner.toBase58(), ata.toBase58(), mint];
    const sim = await this.simulatePrepared(tx, { sigVerify: false, commitment: 'finalized', minContextSlot: before.context.slot, accounts: { encoding: 'base64', addresses } }, block.lastValidBlockHeight);
    ok(!sim.value?.err, `Burn simulation failed: ${JSON.stringify(sim.value?.err)}.`);
    ok(Array.isArray(sim.value?.accounts) && sim.value.accounts.length === 3 && sim.value.accounts.every(Boolean), 'The RPC omitted burn simulation balances.');
    const decode = info => ({ ...info, owner: pk(info.owner), data: Buffer.from(info.data[0], 'base64') });
    const afterToken = unpackAccount(ata, decode(sim.value.accounts[1]), program), afterMint = unpackMint(key, decode(sim.value.accounts[2]), program);
    ok(account.amount - afterToken.amount === input && supplyBefore - afterMint.supply === input && native - BigInt(sim.value.accounts[0].lamports) === fee, 'The burn simulation changed an unexpected balance.');
    const secret = bs58.decode(signer.secret); let bytes;
    try { const keypair = Keypair.fromSecretKey(secret); ok(keypair.publicKey.equals(owner), 'The agent signer does not match its wallet.'); tx.sign([{ publicKey: keypair.publicKey, secretKey: secret }]); bytes = Buffer.from(tx.serialize()); verifySignedTransaction(bytes, owner.toBase58()); }
    finally { secret.fill(0); }
    return { kind: 'incinerate', mint, wallet: owner.toBase58(), inputAmount: input.toString(), minimumOutput: '0', expectedOutput: '0', signature: bs58.encode(tx.signatures[0]), raw: bytes.toString('base64'), rawHash: hash(bytes), ...block, preparedSlot: sim.context.slot, createdAt: this.now(), accounting: { maxCostLamports: maxCost.toString(), networkFeeLamports: fee.toString(), monitoredAccounts: [], ata: ata.toBase58(), program: summary.program, decimals: summary.decimals, minSolReserve: '0', beforeSol: native.toString(), beforeTokens: account.amount.toString(), supplyBefore: supplyBefore.toString() } };
  }
  /** Backed USDC from the agent wallet to the operator reimbursement wallet. */
  async prepareUsdcTransfer({ wallet: signer, amount, recipient, maxNetworkCostLamports = '5000000' }) {
    const owner = wallet(signer?.address), to = wallet(recipient), input = quantity(String(amount)), maxCost = quantity(maxNetworkCostLamports); ok(!owner.equals(to) && maxCost <= EXTRA_COST_LIMIT, 'Invalid USDC transfer.');
    const summary = await this.mintSummary(USDC_MINT), program = pk(summary.program), key = pk(USDC_MINT), source = getAssociatedTokenAddressSync(key, owner, false, program), destination = getAssociatedTokenAddressSync(key, to, false, program);
    const before = await this.c.getMultipleAccountsInfoAndContext([owner, source, destination], { commitment: 'finalized' });
    ok(Number.isSafeInteger(before?.context?.slot) && before.value?.length === 3 && before.value[0] && before.value[1], 'The RPC returned an incomplete transfer snapshot.');
    const account = unpackAccount(source, before.value[1], program); ok(account.mint.equals(key) && account.owner.equals(owner) && !account.isFrozen && account.amount >= input, 'The agent wallet does not hold enough USDC.');
    const rent = before.value[2] ? 0n : lamports(await this.c.getMinimumBalanceForRentExemption(165, 'finalized')), native = lamports(before.value[0].lamports);
    const block = await this.c.getLatestBlockhash('finalized'); ok(Number.isSafeInteger(block.lastValidBlockHeight) && block.lastValidBlockHeight >= 151, 'The RPC omitted transfer expiry.');
    const message = new TransactionMessage({ payerKey: owner, recentBlockhash: block.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 80000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }), createAssociatedTokenAccountIdempotentInstruction(owner, destination, to, key, program), createTransferCheckedInstruction(source, key, destination, owner, input, summary.decimals, [], program)] }).compileToV0Message();
    ok(message.header.numRequiredSignatures === 1 && transactionSize(message) <= 1232, 'The transfer needs another signer.');
    const fee = lamports((await this.c.getFeeForMessage(message, 'finalized'))?.value); ok(fee > 0n && fee <= FEE_LIMIT && fee + rent <= maxCost, 'The transfer network cost exceeds its limit.');
    const tx = new VersionedTransaction(message), addresses = [owner.toBase58(), source.toBase58(), destination.toBase58()];
    const sim = await this.simulatePrepared(tx, { sigVerify: false, commitment: 'finalized', minContextSlot: before.context.slot, accounts: { encoding: 'base64', addresses } }, block.lastValidBlockHeight);
    ok(!sim.value?.err && Array.isArray(sim.value?.accounts) && sim.value.accounts.length === 3 && sim.value.accounts.every(Boolean), `USDC transfer simulation failed: ${JSON.stringify(sim.value?.err)}.`);
    const decode = info => ({ ...info, owner: pk(info.owner), data: Buffer.from(info.data[0], 'base64') });
    const afterSource = unpackAccount(source, decode(sim.value.accounts[1]), program), afterDestination = unpackAccount(destination, decode(sim.value.accounts[2]), program);
    ok(account.amount - afterSource.amount === input && afterDestination.owner.equals(to) && afterDestination.mint.equals(key) && native - BigInt(sim.value.accounts[0].lamports) === fee + rent, 'The transfer simulation changed an unexpected balance.');
    const secret = bs58.decode(signer.secret); let bytes;
    try { const keypair = Keypair.fromSecretKey(secret); ok(keypair.publicKey.equals(owner), 'The agent signer does not match its wallet.'); tx.sign([{ publicKey: keypair.publicKey, secretKey: secret }]); bytes = Buffer.from(tx.serialize()); verifySignedTransaction(bytes, owner.toBase58()); }
    finally { secret.fill(0); }
    return { kind: 'usdc-transfer', mint: USDC_MINT, wallet: owner.toBase58(), recipient: to.toBase58(), inputAmount: input.toString(), minimumOutput: '0', expectedOutput: '0', signature: bs58.encode(tx.signatures[0]), raw: bytes.toString('base64'), rawHash: hash(bytes), ...block, preparedSlot: sim.context.slot, createdAt: this.now(), accounting: { maxCostLamports: maxCost.toString(), networkFeeLamports: fee.toString(), rentBudgetLamports: rent.toString(), monitoredAccounts: [], ata: source.toBase58(), destinationAta: destination.toBase58(), program: summary.program, decimals: summary.decimals, minSolReserve: '0', beforeSol: native.toString(), beforeTokens: account.amount.toString() } };
  }
  /**
   * Unsigned, memo-bound SOL deposit for the funder's own wallet to sign. The compute limit is measured, not fixed: the
   * memo program's cost grows with the memo text (it validates and debug-formats every character), so a small fixed limit
   * fails the simulation with ProgramFailedToComplete. A probe at the ceiling measures the real use; the signed message
   * carries that plus margin (v71.33). The funder's balance is checked against the ceiling fee before the probe, so a short
   * wallet is named as such instead of as a failed simulation.
   */
  async prepareDeposit({ sender, recipient, lamports: amount, memo }) {
    const from = wallet(sender), to = wallet(recipient), input = quantity(String(amount)); ok(!from.equals(to), 'The funding wallet cannot be the agent wallet.');
    ok(typeof memo === 'string' && memo.length >= 10 && memo.length <= 80 && /^[a-z0-9:_-]+$/.test(memo), 'Invalid deposit memo.');
    const before = await this.c.getMultipleAccountsInfoAndContext([from, to], { commitment: 'confirmed' });
    ok(Number.isSafeInteger(before?.context?.slot) && before.value?.length === 2 && before.value[0], 'The funding wallet was not found.');
    ok(!before.value[0].executable && before.value[0].owner.equals(SystemProgram.programId), 'The funding wallet must be an ordinary SOL wallet.');
    const block = await this.c.getLatestBlockhash('finalized'); ok(Number.isSafeInteger(block.lastValidBlockHeight) && block.lastValidBlockHeight >= 151, 'The RPC omitted deposit expiry.');
    const compile = units => new TransactionMessage({ payerKey: from, recentBlockhash: block.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEPOSIT_UNIT_PRICE }), SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: input }), new TransactionInstruction({ programId: pk(MEMO_PROGRAM), keys: [], data: Buffer.from(memo, 'utf8') })] }).compileToV0Message();
    const feeFor = async message => { const fee = lamports((await this.c.getFeeForMessage(message, 'finalized'))?.value); ok(fee > 0n && fee <= FEE_LIMIT, 'The deposit network fee exceeds its limit.'); return fee; };
    const simulate = async tx => { const sim = await this.simulatePrepared(tx, { sigVerify: false, commitment: 'confirmed', minContextSlot: before.context.slot }, block.lastValidBlockHeight); ok(!sim.value?.err, `Deposit simulation failed: ${JSON.stringify(sim.value?.err)}.`); return sim; };
    const ceiling = compile(DEPOSIT_UNITS_CEILING); ok(ceiling.header.numRequiredSignatures === 1 && transactionSize(ceiling) <= 1232, 'The deposit transaction is invalid.');
    ok(lamports(before.value[0].lamports) >= input + await feeFor(ceiling), 'The funding wallet cannot cover this deposit and its network fee.');
    const probe = await simulate(new VersionedTransaction(ceiling)), used = Number(probe.value?.unitsConsumed);
    const units = Number.isFinite(used) && used > 0 ? Math.min(DEPOSIT_UNITS_CEILING, Math.ceil(used * 1.3) + 3000) : DEPOSIT_UNITS_CEILING, message = compile(units);
    ok(message.header.numRequiredSignatures === 1 && transactionSize(message) <= 1232, 'The deposit transaction is invalid.');
    const fee = await feeFor(message);
    ok(lamports(before.value[0].lamports) >= input + fee, 'The funding wallet cannot cover this deposit and its network fee.');
    const tx = new VersionedTransaction(message), sim = await simulate(tx);
    const bytes = Buffer.from(tx.serialize());
    return { kind: 'deposit', needsSignature: true, state: 'awaiting_signature', externalSigner: from.toBase58(), recipient: to.toBase58(), mint: AGENT_QUOTE_MINT, inputAmount: input.toString(), memo, unsignedRaw: bytes.toString('base64'), messageHash: hash(Buffer.from(tx.message.serialize())), blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight, preparedSlot: sim.context?.slot ?? before.context.slot, createdAt: this.now() };
  }
  /** Finalized verification of a user-signed deposit: exact transfer, memo and recipient delta. */
  async depositReceipt({ signature, sender, recipient, lamports: amount, memo }) {
    const tx = await LaunchChain.prototype.receipt.call(this, { signature }); if (!tx) return null;
    ok(tx.transaction?.signatures?.[0] === signature && Number.isSafeInteger(tx.slot) && tx.meta && Object.hasOwn(tx.meta, 'err'), 'The finalized deposit receipt is incomplete.');
    if (tx.meta.err !== null) return { state: 'failed', signature, slot: tx.slot, error: tx.meta.err };
    const keys = receiptKeys(tx), expected = quantity(String(amount)), message = tx.transaction.message;
    ok(keys.indexOf(sender) === 0 && message.header.numRequiredSignatures === 1, 'The deposit was not signed by the funding wallet.');
    let transferred = 0n, memoSeen = false;
    for (const ix of instructionList(tx, keys)) {
      if (ix.program === MEMO_PROGRAM) { const text = ix.parsed ? String(ix.parsed) : ix.data.toString('utf8'); if (text === memo) memoSeen = true; continue; }
      if (ix.program !== SystemProgram.programId.toBase58()) continue;
      let from, to, value;
      if (ix.parsed?.type === 'transfer') { from = ix.parsed.info?.source; to = ix.parsed.info?.destination; value = lamports(ix.parsed.info?.lamports); }
      else if (ix.data?.length === 12 && ix.data.readUInt32LE(0) === 2 && ix.accounts.length === 2) { [from, to] = ix.accounts; value = ix.data.readBigUInt64LE(4); }
      else continue;
      if (to !== recipient) continue; ok(from === sender, 'The deposit mixes transfers from different senders.'); transferred += value;
    }
    ok(memoSeen, 'The finalized deposit does not carry its intent memo.');
    const received = nativeDelta(tx, keys, recipient);
    ok(transferred === expected && received === expected, 'The finalized deposit differs from its intent.');
    return { state: 'finalized', signature, slot: tx.slot, receivedAmount: received.toString(), feeLamports: String(tx.meta.fee) };
  }
  async receipt(op, walletAddress = op?.wallet) {
    if (op?.kind !== 'incinerate' && op?.kind !== 'usdc-transfer') return super.receipt(op, walletAddress);
    const { tx: signed } = this.verifyOperation(op); ok(walletAddress === op.wallet, 'The receipt belongs to another wallet.');
    const tx = await LaunchChain.prototype.receipt.call(this, op); if (!tx) return null;
    ok(tx.transaction?.signatures?.[0] === op.signature && Number.isSafeInteger(tx.slot) && tx.meta && Object.hasOwn(tx.meta, 'err'), 'The finalized receipt is incomplete or has the wrong signature.');
    ok(Buffer.from(tx.transaction.message.serialize()).equals(Buffer.from(signed.message.serialize())), 'The finalized transaction differs from its saved message.');
    const keys = receiptKeys(tx), fee = lamports(tx.meta.fee), failed = tx.meta.err !== null, delta = nativeDelta(tx, keys, op.wallet), input = quantity(op.inputAmount);
    const result = { state: failed ? 'failed' : 'confirmed', signature: op.signature, slot: tx.slot, feeLamports: fee.toString(), inputAmount: op.inputAmount, outputAmount: '0', solDelta: delta.toString(), tokenDelta: '0', actualSolCostLamports: fee.toString(), outputDecimals: op.accounting.decimals, error: failed ? tx.meta.err : null };
    const tokenDelta = tokenBalance(tx, keys, 'post', op.accounting.ata) - tokenBalance(tx, keys, 'pre', op.accounting.ata);
    if (failed) { ok(tokenDelta === 0n && delta === -fee, 'A failed receipt changed unexpected balances.'); return result; }
    result.tokenDelta = tokenDelta.toString();
    if (op.kind === 'incinerate') { ok(tokenDelta === -input && delta === -fee, 'The finalized burn differs from its authorized amount.'); result.outputAmount = input.toString(); }
    else { const received = tokenBalance(tx, keys, 'post', op.accounting.destinationAta) - tokenBalance(tx, keys, 'pre', op.accounting.destinationAta); const cost = -delta; ok(tokenDelta === -input && received === input && cost >= fee && cost <= quantity(op.accounting.maxCostLamports), 'The finalized USDC transfer differs from its authorized amount.'); result.outputAmount = received.toString(); result.actualSolCostLamports = cost.toString(); }
    return result;
  }
}
