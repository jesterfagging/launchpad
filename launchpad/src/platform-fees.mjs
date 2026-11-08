import { Connection, PublicKey, SystemProgram, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, unpackMint, unpackAccount,
  getExtensionTypes, ExtensionType, getTransferHook, getTransferFeeConfig, calculateEpochFee, getAccountLen, getAccountTypeOfMintType,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, createTransferCheckedWithFeeInstruction,
  addExtraAccountMetasForExecute } from '@solana/spl-token';
import bs58 from 'bs58';
import { SOL, invariant } from './core.mjs';

const SCALE = 1000000n;
const keyString = value => new PublicKey(value).toBase58();
const integer = (value, max, name) => { invariant(Number.isInteger(value) && value >= 0 && value <= max, `Invalid platform ${name}.`); return value; };
const feeReads = new WeakMap();

// A follower burst needs the same rent and epoch metadata only once. Share only
// requests that are still running, and only within one cancellation scope. Never
// retain balances, mint extensions, or successful/failed responses for a later
// trade: authority changes and outside token transfers must remain visible.
function sharedFeeRpc(provider, method, params, signal) {
  invariant(!signal?.aborted, 'Stopped.');
  let scopes = feeReads.get(provider);
  if (!scopes) { scopes = new Map(); feeReads.set(provider, scopes); }
  let requests = scopes.get(signal);
  if (!requests) { requests = new Map(); scopes.set(signal, requests); }
  const key = JSON.stringify([method, params]);
  if (!requests.has(key)) {
    const request = Promise.resolve().then(() => {
      invariant(!signal?.aborted, 'Stopped.');
      return provider.rpc(method, params, signal);
    }).then(result => {
      invariant(!signal?.aborted, 'Stopped.');
      return result;
    }).finally(() => {
      requests.delete(key);
      if (!requests.size) scopes.delete(signal);
      if (!scopes.size) feeReads.delete(provider);
    });
    requests.set(key, request);
  }
  return requests.get(key);
}

async function feeAccounts(provider, keys, signal) {
  invariant(!signal?.aborted, 'Stopped.');
  let result;
  if (provider.readAccounts) {
    // Keep fee checks at confirmed commitment, independently of processed pool
    // snapshots. Providers batches/deduplicates all followers in this turn.
    result = await provider.readAccounts(keys, 0, signal, { commitment: 'confirmed' });
  } else if (keys.length === 1) {
    const account = await sharedFeeRpc(provider, 'getAccountInfo', [keys[0], { encoding: 'base64', commitment: 'confirmed' }], signal);
    result = { value: [account?.value] };
  } else result = await provider.rpc('getMultipleAccounts', [keys, { encoding: 'base64', commitment: 'confirmed' }], signal);
  invariant(!signal?.aborted, 'Stopped.');
  invariant(Array.isArray(result?.value) && result.value.length === keys.length, 'RPC returned an incomplete platform fee account snapshot.');
  return result.value;
}

// Called only with host-owned account data. Never construct this from a form,
// imported preset, or provider response. A run snapshots its fee terms once.
export function validatePlatformContext(context) {
  if (context === null || context === undefined) return null;
  invariant(typeof context.accountId === 'string' && context.accountId.length > 0 && context.accountId.length <= 128, 'Platform account is missing.');
  return Object.freeze({ accountId: context.accountId, recipient: keyString(context.recipient), mainWallet: keyString(context.mainWallet),
    cashbackBps: integer(context.cashbackBps ?? 0, 10000, 'cashback rate'), version: String(context.version ?? '1'), settlement: context.settlement === 'sol' ? 'sol' : 'input',
    copyPpm: integer(context.copyPpm ?? 2500, 100000, 'copy fee'), sniperPpm: integer(context.sniperPpm ?? 10000, 100000, 'sniping fee'), marketPpm: integer(context.marketPpm ?? 1000, 100000, 'market fee'),
    liquidityPpm: integer(context.liquidityPpm ?? 0, 100000, 'liquidity fee'), liquidityModel: 'half-krystal-auto-v1' });
}

export function platformFeePlan(context, kind, mint, grossAmount, wallet) {
  if (!context) return null;
  invariant(['copy', 'sniper', 'market', 'liquidity'].includes(kind), 'Unknown platform fee category.');
  const ppm = context[`${kind}Ppm`], gross = BigInt(grossAmount), amount = gross * BigInt(ppm) / SCALE;
  invariant(gross > 0n && gross <= 18446744073709551615n, 'Platform order amount is out of range.');
  invariant(wallet !== context.recipient, 'A trading wallet cannot be the platform fee collection wallet.');
  if (!amount) return null; // Integer rounding: never round a small fee upward.
  invariant(amount < gross, 'Platform fee leaves no amount to trade.');
  return { accountId: context.accountId, recipient: context.recipient, mainWallet: context.mainWallet, cashbackBps: context.cashbackBps,
    version: context.version, settlement: context.settlement, kind, mint, ppm, grossAmount: String(gross), swapAmount: String(gross - amount),
    chargedAmount: String(amount), expectedAmount: String(amount), wallet };
}

function rpcConnection(provider, signal) {
  return new Connection(provider.c.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: async (_url, options) => {
    invariant(!signal?.aborted, 'Stopped.');
    const request = JSON.parse(options.body), result = await provider.rpc(request.method, request.params, signal);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
}
function accountInfo(raw) {
  invariant(raw && Array.isArray(raw.data) && raw.data[1] === 'base64', 'Fee transfer account data is unavailable.');
  return { ...raw, owner: new PublicKey(raw.owner), data: Buffer.from(raw.data[0], 'base64') };
}

// Fees precede the swap so a full token exit may close the source account after
// both debits. Destination ATA rent is borne by the payer and checked explicitly.
export async function preparePlatformFee(plan, provider, signal, { paper = false, order } = {}) {
  if (!plan) return { plan: null, instructions: [], rent: 0n, requiresSimulation: false };
  const fee = { ...plan }, payer = new PublicKey(fee.wallet), recipient = new PublicKey(fee.recipient), amount = BigInt(fee.chargedAmount);
  if (fee.settlement === 'sol' && fee.mint !== SOL) {
    invariant(order && order.inputMint === fee.mint, 'SOL fee conversion requires its exact trade.');
    fee.sourceMint = fee.mint; fee.sourceGrossAmount = fee.grossAmount; fee.sourceFeeAmount = fee.chargedAmount;
    if (order.outputMint === SOL) fee.swapAmount = fee.grossAmount;
    return { plan: fee, instructions: [], rent: 0n, requiresSimulation: true, convertToSol: true, paper };
  }
  if (paper) return { plan: fee, instructions: [], rent: 0n, requiresSimulation: false };
  let instructions, rent = 0n, transfer;
  if (fee.mint === SOL) {
    fee.decimals = 9; fee.destination = fee.recipient; fee.program = SystemProgram.programId.toBase58();
    transfer = SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: amount }); instructions = [transfer];
  } else {
    const mint = new PublicKey(fee.mint), [mintAccount] = await feeAccounts(provider, [fee.mint], signal);
    const raw = accountInfo(mintAccount), program = raw.owner;
    invariant(program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID), 'Platform fee input must be an SPL mint.');
    const info = unpackMint(mint, raw, program);
    invariant(info.isInitialized && info.decimals <= 18, 'Platform fee mint is uninitialized or unsupported.');
    const supported = [ExtensionType.TransferFeeConfig, ExtensionType.TransferHook, ExtensionType.MetadataPointer,
      ExtensionType.TokenMetadata, ExtensionType.MintCloseAuthority, ExtensionType.PermanentDelegate];
    invariant(getExtensionTypes(info.tlvData).every(type => supported.includes(type)), 'This token extension is not supported for an atomic platform fee. Nothing was submitted.');
    const source = getAssociatedTokenAddressSync(mint, payer, false, program), destination = getAssociatedTokenAddressSync(mint, recipient, false, program);
    const accounts = await feeAccounts(provider, [source.toBase58(), destination.toBase58()], signal);
    const sourceInfo = unpackAccount(source, accountInfo(accounts[0]), program);
    invariant(sourceInfo.owner.equals(payer) && sourceInfo.mint.equals(mint) && sourceInfo.isInitialized, 'The input token account does not match this wallet and mint.');
    invariant(!sourceInfo.isFrozen, 'The input token account is frozen. Nothing was submitted.');
    invariant(sourceInfo.amount >= BigInt(fee.grossAmount), `The input associated token account cannot cover this trade and platform fee: available ${sourceInfo.amount}, required ${fee.grossAmount} raw token units. Nothing was submitted.`);
    instructions = [];
    if (accounts[1]) {
      const destinationInfo = unpackAccount(destination, accountInfo(accounts[1]), program);
      invariant(destinationInfo.owner.equals(recipient) && destinationInfo.mint.equals(mint) && destinationInfo.isInitialized && !destinationInfo.isFrozen, 'Platform fee destination token account is invalid or frozen.');
    } else {
      const accountExtensions = getExtensionTypes(info.tlvData).map(getAccountTypeOfMintType).filter(type => type !== ExtensionType.Uninitialized);
      if (program.equals(TOKEN_2022_PROGRAM_ID)) accountExtensions.push(ExtensionType.ImmutableOwner);
      const value = await sharedFeeRpc(provider, 'getMinimumBalanceForRentExemption', [getAccountLen(accountExtensions), { commitment: 'confirmed' }], signal);
      invariant(Number.isSafeInteger(value) && value >= 0, 'RPC omitted platform token-account rent.'); rent = BigInt(value);
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(payer, destination, recipient, mint, program));
    }
    const tax = getTransferFeeConfig(info);
    if (tax) {
      const epoch = await sharedFeeRpc(provider, 'getEpochInfo', [{ commitment: 'confirmed' }], signal);
      invariant(Number.isSafeInteger(epoch?.epoch), 'RPC omitted token transfer-fee epoch.');
      const withheld = calculateEpochFee(tax, BigInt(epoch.epoch), amount);
      fee.expectedAmount = String(amount - withheld); fee.tokenTransferFee = String(withheld);
      transfer = createTransferCheckedWithFeeInstruction(source, mint, destination, payer, amount, info.decimals, withheld, [], program);
    } else transfer = createTransferCheckedInstruction(source, mint, destination, payer, amount, info.decimals, [], program);
    const hook = getTransferHook(info);
    if (hook && !hook.programId.equals(PublicKey.default)) await addExtraAccountMetasForExecute(rpcConnection(provider, signal), transfer, hook.programId, source, mint, destination, payer, amount, 'confirmed');
    fee.source = source.toBase58(); fee.destination = destination.toBase58(); fee.decimals = info.decimals; fee.program = program.toBase58(); instructions.push(transfer);
  }
  fee.transferData = bs58.encode(transfer.data); fee.transferAccounts = transfer.keys.map(k => k.pubkey.toBase58());
  return { plan: fee, instructions, rent, requiresSimulation: fee.mint !== SOL };
}

export function attachPlatformFee(build, prepared) {
  return { ...build, platformFeeInstructions: prepared.instructions, requiresSimulation: !!(build.requiresSimulation || prepared.requiresSimulation) };
}

// Conversion and collection stay in the same signed transaction as the trade.
// A conservative, executable minimum determines the SOL sent; positive execution
// improvement stays in the trader's wallet. No token ATA is created for collection.
export async function settlePlatformFee(build, prepared, provider, order, wallet, signal) {
  if (!prepared.convertToSol) return attachPlatformFee(build, prepared);
  invariant(!signal?.aborted, 'Stopped.');
  const fee = prepared.plan;
  let amount, conversion = null;
  if (order.outputMint === SOL) {
    amount = BigInt(build.otherAmountThreshold) * BigInt(fee.ppm) / SCALE;
    fee.basis = 'minimum-sol-proceeds';
  } else {
    conversion = await provider.jupiterBuild({ ...order, kind: 'fee-conversion', inputMint: fee.sourceMint, outputMint: SOL,
      amount: BigInt(fee.sourceFeeAmount), venue: undefined, platformFee: undefined }, wallet, signal, 24);
    invariant(conversion.outputMint === SOL && BigInt(conversion.inAmount) === BigInt(fee.sourceFeeAmount), 'Fee conversion differs from the fee amount.');
    amount = BigInt(conversion.otherAmountThreshold || 0);
    fee.basis = 'converted-input-fee';
  }
  if (amount === 0n && order.outputMint === SOL) { prepared.plan = null; return build; }
  invariant(amount > 0n && amount <= 18446744073709551615n, 'Token fee is too small for a SOL settlement. Nothing was submitted.');
  invariant(!signal?.aborted, 'Stopped.');
  const transfer = SystemProgram.transfer({ fromPubkey: new PublicKey(wallet.publicKey), toPubkey: new PublicKey(fee.recipient), lamports: amount });
  Object.assign(fee, { mint: SOL, decimals: 9, chargedAmount: String(amount), expectedAmount: String(amount), destination: fee.recipient,
    program: SystemProgram.programId.toBase58(), transferData: bs58.encode(transfer.data), transferAccounts: transfer.keys.map(k => k.pubkey.toBase58()) });
  const result = { ...build, feeSettlementLocked: true, requiresSimulation: true };
  if (conversion) {
    const decode = ix => new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(ix.data, 'base64') });
    const raw = conversion.nativeInstructions || [...(conversion.setupInstructions || []), conversion.swapInstruction, conversion.cleanupInstruction, ...(conversion.otherInstructions || [])].filter(Boolean).map(decode);
    invariant(raw.length > 0, 'Fee conversion omitted swap instructions.');
    result.platformFeeInstructions = [...raw.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId)), transfer];
    const tables = { ...(build.addressesByLookupTableAddress || {}) };
    for (const [key, addresses] of Object.entries(conversion.addressesByLookupTableAddress || {})) {
      if (tables[key]) invariant(JSON.stringify(tables[key]) === JSON.stringify(addresses), 'Fee conversion lookup table changed. Retry the trade.');
      tables[key] = addresses;
    }
    result.addressesByLookupTableAddress = tables;
  } else {
    result.platformFeeInstructions = [];
    result.platformFeeAfterInstructions = [transfer];
    result.outAmount = String(BigInt(build.outAmount) - amount);
    result.otherAmountThreshold = String(BigInt(build.otherAmountThreshold) - amount);
  }
  return result;
}

function matchesTransfer(ix, fee) {
  if (String(ix.programId) !== fee.program) return false;
  if (ix.data && Array.isArray(ix.accounts)) return ix.data === fee.transferData && ix.accounts.map(String).join(':') === fee.transferAccounts.join(':');
  const parsed = ix.parsed, info = parsed?.info;
  if (!info) return false;
  if (fee.mint === SOL) return parsed.type === 'transfer' && info.source === fee.wallet && info.destination === fee.destination && String(info.lamports) === fee.chargedAmount;
  // Agave's parsed-token representation labels all accounts after authority as
  // multisig signers, including transfer-hook extra account metas. The signed
  // transaction still has exactly one signer; match those metas in order.
  const authorityMatches = (info.authority || info.owner) === fee.wallet || (info.multisigAuthority === fee.wallet &&
    Array.isArray(info.signers) && info.signers.map(String).join(':') === fee.transferAccounts.slice(4).join(':'));
  return ['transferChecked', 'transferCheckedWithFee'].includes(parsed.type) && info.source === fee.source && info.destination === fee.destination &&
    info.mint === fee.mint && authorityMatches && String(info.tokenAmount?.amount) === fee.chargedAmount && info.tokenAmount?.decimals === fee.decimals;
}

export function verifyPlatformFee(pending, tx) {
  const fee = pending.order.platformFee;
  if (!fee) return null;
  invariant(tx?.meta && tx.meta.err === null, 'Platform fees only accrue after a successful transaction.');
  invariant(tx.transaction?.signatures?.[0] === pending.signature, 'Platform fee transaction signature does not match its journal.');
  const message = tx.transaction?.message, keys = message?.accountKeys?.map(k => String(k.pubkey || k)) || [];
  invariant((message?.instructions || []).filter(ix => matchesTransfer(ix, fee)).length === 1, 'Confirmed transaction omitted its exact platform fee transfer; reconciliation required.');
  const index = keys.indexOf(fee.destination); invariant(index >= 0, 'Platform fee destination is missing from receipt.');
  let amount;
  if (fee.mint === SOL) {
    const pre = tx.meta.preBalances?.[index], post = tx.meta.postBalances?.[index];
    invariant(Number.isSafeInteger(pre) && Number.isSafeInteger(post), 'RPC omitted exact platform SOL balances.'); amount = BigInt(post) - BigInt(pre);
  } else {
    const find = side => (tx.meta[`${side}TokenBalances`] || []).find(b => b.accountIndex === index && b.mint === fee.mint);
    const pre = find('pre'), post = find('post');
    invariant(post?.owner === fee.recipient && (!pre || pre.owner === fee.recipient), 'Platform fee receipt owner differs from its destination.');
    amount = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount || 0);
  }
  invariant(amount === BigInt(fee.expectedAmount), 'Platform fee credit differs from its recorded amount; reconciliation required.');
  return feeReceipt(pending, amount, false);
}

function feeReceipt(pending, amount, paper) {
  const fee = pending.order.platformFee;
  return { signature: pending.signature, accountId: fee.accountId, wallet: pending.wallet, recipient: fee.recipient, mainWallet: fee.mainWallet,
    version: fee.version, kind: fee.kind, mint: fee.mint, decimals: fee.decimals ?? (fee.mint === SOL ? 9 : undefined),
    grossAmount: fee.grossAmount, chargedAmount: fee.chargedAmount, amount: String(amount), ppm: fee.ppm,
    cashbackBps: fee.cashbackBps, cashbackAmount: paper ? '0' : String(amount * BigInt(fee.cashbackBps) / 10000n),
    evidence: paper ? null : structuredClone(fee),
    mode: paper ? 'paper' : 'live', status: paper ? 'simulated' : 'accrued', at: pending.createdAt };
}

// Host-owned cashback verification can check this proof against an independent
// trusted RPC. A subscriber-controlled RPC alone must never authorize payout.
export function verifyRecordedPlatformFee(receipt, transaction) {
  invariant(receipt?.mode === 'live' && receipt.evidence, 'A live platform fee proof is required.');
  return verifyPlatformFee({ signature: receipt.signature, wallet: receipt.wallet, createdAt: receipt.at,
    order: { platformFee: receipt.evidence } }, transaction);
}

// The caller saves this together with its position fill and removal of pending.
// Re-broadcasts keep the same signature and can never mint another receipt.
export function recordPlatformFee(ledger, pending, verified, paper = false) {
  if (!pending.order.platformFee) return;
  const receipt = paper ? feeReceipt(pending, BigInt(pending.order.platformFee.chargedAmount), true) : verified;
  invariant(receipt && receipt.signature === pending.signature && receipt.accountId === pending.order.platformFee.accountId, 'Verified platform fee receipt is required.');
  const receipts = ledger.data.feeReceipts ||= [], old = receipts.find(r => r.signature === receipt.signature);
  if (old) invariant(JSON.stringify(old) === JSON.stringify(receipt), 'An immutable platform fee receipt cannot be replaced.');
  else receipts.push(Object.freeze(receipt));
}
