import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  ACCOUNT_SIZE, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT,
  unpackMint, unpackAccount, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  createInitializeAccount3Instruction, createCloseAccountInstruction,
  getTransferFeeConfig, getTransferHook, getNonTransferable, getDefaultAccountState,
  getPausableConfig, getMemoTransfer,
} from '@solana/spl-token';
import { readMintTokenAccounts } from './launchpad-token-accounts.mjs';
import { inspectNativeRewardRecipients } from './launchpad-recipient-rent.mjs';
import { associatedTokenAccountSize } from './launchpad-token-account-size.mjs';

export const MAX_REWARD_UNITS = 18446744073709551615n;
const MAX_HOLDERS = 50000, MAX_BATCH = 100;
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const fail = (message, code = 'METEORA_REWARD_INVALID') => { throw Object.assign(Error(message), { code }); };
const check = (condition, message, code) => { if (!condition) fail(message, code); };
const amount = (value, positive = false) => {
  check(typeof value === 'bigint' || typeof value === 'string' && /^(?:0|[1-9]\d{0,19})$/.test(value), 'Invalid exact holder reward amount.');
  const parsed = BigInt(value);
  check(parsed >= (positive ? 1n : 0n) && parsed <= MAX_REWARD_UNITS, 'Holder reward amount exceeds token limits.');
  return parsed;
};
function key(value, label, onCurve = false) {
  let parsed;
  try { parsed = value instanceof PublicKey ? value : new PublicKey(value?.publicKey || value); } catch { fail(`Invalid ${label}.`); }
  check((typeof value !== 'string' || parsed.toBase58() === value) && (!onCurve || PublicKey.isOnCurve(parsed.toBytes())), `Invalid ${label}.`);
  return parsed;
}
const minimumSlot = value => { check(Number.isSafeInteger(value) && value >= 0, 'Invalid holder reward minimum slot.'); return value; };
function context(snapshot, minimum, length) {
  check(Number.isSafeInteger(snapshot?.context?.slot) && snapshot.context.slot > 0 && snapshot.context.slot >= minimum
    && (length === undefined || Array.isArray(snapshot.value) && snapshot.value.length === length),
  'The RPC returned an incomplete or stale holder reward snapshot.', 'METEORA_REWARD_SNAPSHOT');
  return snapshot.context.slot;
}
function accountShape(info) {
  check(info && info.owner instanceof PublicKey && Buffer.isBuffer(info.data)
    && typeof info.executable === 'boolean' && !info.executable
    && Number.isSafeInteger(info.lamports) && info.lamports >= 0,
  'The RPC returned invalid holder reward account data.', 'METEORA_REWARD_SNAPSHOT');
}
async function mintInfo(connection, mint, minContextSlot) {
  const result = await connection.getAccountInfoAndContext(mint, { commitment: 'finalized', ...(minContextSlot ? { minContextSlot } : {}) });
  const slot = context(result, minContextSlot);
  accountShape(result.value);
  const program = result.value.owner;
  check(program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID), 'Unsupported holder reward token program.');
  let decoded;
  try { decoded = unpackMint(mint, result.value, program); } catch { fail('The holder reward mint is invalid.', 'METEORA_REWARD_SNAPSHOT'); }
  check(decoded.isInitialized, 'The holder reward mint is not initialized.');
  return { mint: decoded, program, slot };
}
function payoutRows(rows, limit = MAX_BATCH) {
  check(Array.isArray(rows) && rows.length <= limit, 'Invalid holder reward recipient count.');
  const seen = new Set();
  let total = 0n;
  const parsed = rows.map(row => {
    check(typeof row?.owner === 'string' && typeof row?.amount === 'string', 'Holder reward recipients must use exact saved strings.');
    const owner = key(row.owner, 'holder reward recipient', true).toBase58(), units = amount(row.amount, true);
    check(!seen.has(owner), 'Duplicate holder reward recipient.'); seen.add(owner);
    total += units; check(total <= MAX_REWARD_UNITS, 'Holder reward batch exceeds token limits.');
    return { owner, amount: units.toString() };
  });
  return { rows: parsed, total };
}

// A complete finalized paginated scan is required. It is monotonic across
// pages, not an atomic single-slot historical snapshot. The caller must persist
// this allocation once and resume it instead of resnapshotting unpaid rewards.
export async function holderSnapshot({ connection, launch, excludeAddresses = [], minContextSlot = 0, withRpcContext } = {}) {
  check(connection && launch, 'A holder reward connection and launch are required.');
  minimumSlot(minContextSlot);
  const mint = key(launch.mint, 'holder token mint'), info = await mintInfo(connection, mint, minContextSlot);
  check(Array.isArray(excludeAddresses), 'Invalid holder reward exclusions.');
  const excluded = new Set([
    launch.creatorAuthority, launch.partnerAuthority, launch.poolId, launch.poolAuthority,
    launch.baseVault, launch.quoteVault, launch.migratedPool, launch.rewardsWallet, launch.gasWallet,
    ...excludeAddresses,
  ].filter(Boolean).map(value => key(value, 'holder reward exclusion').toBase58()));
  const scan = await readMintTokenAccounts({ c: connection, ...(withRpcContext ? { withRpcContext } : {}) }, info.program, mint, { minContextSlot: info.slot });
  const balances = new Map(); let excludedAccounts = 0, eligible = 0n;
  for (const row of scan.value) {
    const token = unpackAccount(row.pubkey, row.account, info.program), owner = token.owner.toBase58();
    if (!token.amount || token.isFrozen || excluded.has(owner) || excluded.has(row.pubkey.toBase58()) || !PublicKey.isOnCurve(token.owner.toBytes())) { excludedAccounts++; continue; }
    const next = (balances.get(owner) || 0n) + token.amount; eligible += token.amount;
    check(next <= MAX_REWARD_UNITS && eligible <= MAX_REWARD_UNITS, 'Holder reward snapshot exceeds mint amount limits.');
    balances.set(owner, next);
  }
  return {
    complete: true, slot: scan.context.slot, rows: [...balances].sort(([a], [b]) => a.localeCompare(b)).map(([owner, units]) => ({ owner, amount: units.toString() })),
    eligibleBalance: eligible.toString(), scannedAccounts: scan.value.length, excludedAccounts, mintProgram: info.program.toBase58(),
  };
}

// Integer division leaves dust in earned credit. No arbitrary last recipient
// receives another holder's rounding remainder and no Number coercion occurs.
export function allocateHolderRewards(totalRaw, holders, { minimumRaw = '1' } = {}) {
  const budget = amount(totalRaw), minimum = amount(minimumRaw, true);
  check(Array.isArray(holders) && holders.length <= MAX_HOLDERS, 'Invalid holder reward snapshot size.');
  const balances = new Map(); let eligible = 0n;
  for (const row of holders) {
    const owner = key(row?.owner, 'holder reward owner', true).toBase58(), units = amount(row?.amount);
    const next = (balances.get(owner) || 0n) + units; eligible += units;
    check(next <= MAX_REWARD_UNITS && eligible <= MAX_REWARD_UNITS, 'Holder reward snapshot exceeds token limits.');
    if (units) balances.set(owner, next);
  }
  const payouts = eligible ? [...balances].sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, units]) => ({ owner, amount: (budget * units / eligible).toString() }))
    .filter(row => BigInt(row.amount) >= minimum) : [];
  const assigned = payouts.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  return { payouts, eligibleBalance: eligible.toString(), remainder: (budget - assigned).toString(), allocatedRaw: assigned.toString() };
}

// Keep deferred obligations when a holder sells later. The service saves this
// merged debt separately from the fresh-snapshot budget and clears only after a
// finalized exact payout receipt; constructing instructions never settles debt.
export function mergeHolderRewardPayouts(...sets) {
  const merged = new Map(); let total = 0n;
  for (const set of sets) for (const row of payoutRows(set, MAX_HOLDERS).rows) {
    const units = amount(row.amount), next = (merged.get(row.owner) || 0n) + units;
    total += units;
    check(next <= MAX_REWARD_UNITS && total <= MAX_REWARD_UNITS, 'Reserved holder rewards exceed token limits.');
    merged.set(row.owner, next);
  }
  check(merged.size <= MAX_HOLDERS, 'Too many reserved holder reward recipients.');
  return [...merged].sort(([a], [b]) => a.localeCompare(b)).map(([owner, units]) => ({ owner, amount: units.toString() }));
}

function exactTransferMint(info) {
  const fee = getTransferFeeConfig(info.mint), hook = getTransferHook(info.mint);
  check(!fee || [fee.olderTransferFee, fee.newerTransferFee].every(row => row.transferFeeBasisPoints === 0),
    'A transfer-tax quote cannot pay exact Meteora holder rewards.', 'METEORA_REWARD_QUOTE_UNSUPPORTED');
  check(!hook || hook.programId.equals(PublicKey.default), 'This quote requires a transfer hook that the reward payout does not support.', 'METEORA_REWARD_QUOTE_UNSUPPORTED');
  check(!getNonTransferable(info.mint), 'A non-transferable quote cannot pay holder rewards.', 'METEORA_REWARD_QUOTE_UNSUPPORTED');
}
function tokenAccount(address, info, mint, owner, program) {
  accountShape(info);
  check(info.owner.equals(program), 'Holder reward token account has the wrong program.', 'METEORA_REWARD_SNAPSHOT');
  let token;
  try { token = unpackAccount(address, info, program); } catch { fail('Holder reward token account is malformed.', 'METEORA_REWARD_SNAPSHOT'); }
  check(token.isInitialized && token.mint.equals(mint) && token.owner.equals(owner), 'Holder reward token account does not match its saved recipient.', 'METEORA_REWARD_SNAPSHOT');
  return token;
}
const sum = rows => rows.reduce((n, row) => n + amount(row.amount, true), 0n);

export async function prepareHolderPayoutInstructions({ connection, wallet, launch, source, payouts, minContextSlot = 0, operationId = '', allowPayerRecipient = false } = {}) {
  check(connection && launch, 'A holder payout connection and launch are required.'); minimumSlot(minContextSlot);
  const payer = key(wallet, 'holder reward gas payer', true), authority = key(source || launch.creatorAuthority, 'holder reward authority', true);
  if (launch.creatorAuthority) check(authority.equals(key(launch.creatorAuthority, 'saved holder reward authority')), 'Holder payout authority differs from the saved launch.');
  const mint = key(launch.quoteMint, 'holder reward quote mint'), native = mint.equals(NATIVE_MINT);
  const requested = payoutRows(payouts).rows;
  const manualCreator = allowPayerRecipient === true && launch.feeMode === 'creator' && requested.length === 1 && requested[0].owner === launch.creatorRecipient && requested[0].owner === payer.toBase58() && authority.toBase58() === launch.creatorAuthority;
  check(requested.every(row => row.owner !== authority.toBase58() && (row.owner !== payer.toBase58() || manualCreator)), 'Holder payout cannot send an allocation back to its source or gas wallet.');
  check(typeof operationId === 'string' && operationId.length <= 200, 'Invalid holder payout operation identifier.');
  const info = await mintInfo(connection, mint, minContextSlot);
  check(Number.isInteger(launch.quoteDecimals) && launch.quoteDecimals === info.mint.decimals, 'Holder quote decimals differ from the saved launch.');
  if (launch.quoteProgram) check(info.program.equals(key(launch.quoteProgram, 'saved quote token program')), 'Holder quote program differs from the saved launch.');
  exactTransferMint(info);
  if (native) check(info.program.equals(TOKEN_PROGRAM_ID) && info.mint.decimals === 9, 'Invalid wrapped SOL quote mint.');
  const from = getAssociatedTokenAddressSync(mint, authority, false, info.program), instructions = [], deferredPayouts = [];
  let ready = requested, slot = info.slot, rentLamports = 0n, recipientCheck = null;
  const defer = (rows, reason) => { deferredPayouts.push(...rows.map(row => ({ ...row, reason }))); };
  const empty = () => ({ instructions, payouts: [], deferredPayouts, quoteDebitRaw: '0', rentLamports: '0', slot, native, sourceTokenAccount: from.toBase58() });
  if (!requested.length) return empty();
  if (getPausableConfig(info.mint)?.paused) { defer(requested, 'quote-paused'); return empty(); }
  const sourceSnapshot = await connection.getAccountInfoAndContext(from, { commitment: 'finalized', minContextSlot: slot });
  slot = context(sourceSnapshot, slot);
  check(sourceSnapshot.value !== null, 'The earned holder reward token account is not available.', 'METEORA_REWARD_FUNDING');
  const sourceAccount = tokenAccount(from, sourceSnapshot.value, mint, authority, info.program);
  check(!sourceAccount.isFrozen, 'The holder reward source account is frozen.', 'METEORA_REWARD_FUNDING');
  if (native) {
    // The shared inspector differentiates a proven under-rent account from a
    // malformed/incomplete RPC response. Only the former becomes deferred debt.
    const recipientConnection = {
      getMultipleAccountsInfoAndContext: async (keys, config) => {
        const snapshot = await connection.getMultipleAccountsInfoAndContext(keys, { ...config, minContextSlot: slot });
        slot = context(snapshot, slot, keys.length);
        return snapshot;
      },
      getMinimumBalanceForRentExemption: (...args) => connection.getMinimumBalanceForRentExemption(...args),
    };
    try { recipientCheck = await inspectNativeRewardRecipients(recipientConnection, ready, authority.toBase58()); }
    catch (error) {
      if (error?.code !== 'REWARD_RECIPIENT_RENT') throw error;
      const blocked = payoutRows(error.payouts).rows, byOwner = new Map(ready.map(row => [row.owner, row.amount]));
      check(blocked.length && blocked.every(row => byOwner.get(row.owner) === row.amount), 'Deferred holder reward differs from the saved allocation.');
      const owners = new Set(blocked.map(row => row.owner)); defer(blocked, 'recipient-rent'); ready = ready.filter(row => !owners.has(row.owner));
      if (ready.length) recipientCheck = await inspectNativeRewardRecipients(recipientConnection, ready, authority.toBase58());
    }
    if (!ready.length) return empty();
    slot = Math.max(slot, minimumSlot(recipientCheck.slot));
    check(recipientCheck.slot >= sourceSnapshot.context.slot, 'Holder recipient snapshot is stale.', 'METEORA_REWARD_SNAPSHOT');
  } else {
    const addresses = ready.map(row => getAssociatedTokenAddressSync(mint, key(row.owner, 'holder reward owner', true), false, info.program));
    const recipientSnapshot = await connection.getMultipleAccountsInfoAndContext(addresses, { commitment: 'finalized', minContextSlot: slot });
    slot = context(recipientSnapshot, slot, addresses.length);
    const accountSize = associatedTokenAccountSize(info);
    let rent;
    const accepted = [];
    for (let i = 0; i < ready.length; i++) {
      const row = ready[i], owner = key(row.owner, 'holder reward owner', true), destination = addresses[i], data = recipientSnapshot.value[i];
      let memoRequired = false;
      if (data === null) {
        if (getDefaultAccountState(info.mint)?.state === 2) { defer([row], 'recipient-frozen'); continue; }
        if (rent === undefined) { rent = await connection.getMinimumBalanceForRentExemption(accountSize, 'finalized'); check(Number.isSafeInteger(rent) && rent >= 0, 'Invalid holder token-account rent estimate.', 'METEORA_REWARD_SNAPSHOT'); }
        rentLamports += BigInt(rent);
        instructions.push(createAssociatedTokenAccountIdempotentInstruction(payer, destination, owner, mint, info.program));
      } else {
        const token = tokenAccount(destination, data, mint, owner, info.program);
        if (token.isFrozen) { defer([row], 'recipient-frozen'); continue; }
        memoRequired = !!getMemoTransfer(token)?.requireIncomingTransferMemos;
      }
      if (memoRequired) instructions.push(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: authority, isSigner: true, isWritable: false }], data: Buffer.from('Launchpad holder reward') }));
      instructions.push(createTransferCheckedInstruction(from, mint, destination, authority, amount(row.amount, true), info.mint.decimals, [], info.program));
      accepted.push(row);
    }
    ready = accepted;
  }
  const debit = sum(ready);
  check(sourceAccount.amount >= debit, 'Earned holder rewards exceed the available quote token balance.', 'METEORA_REWARD_FUNDING');
  if (native && debit) {
    const rent = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'finalized');
    check(Number.isSafeInteger(rent) && rent >= 0, 'Invalid wrapped SOL payout rent estimate.', 'METEORA_REWARD_SNAPSHOT');
    rentLamports = BigInt(rent);
    const seed = createHash('sha256').update(JSON.stringify(['curve-dbc-holder-v1', operationId, authority.toBase58(), payer.toBase58(), ready])).digest('hex').slice(0, 32);
    const temporary = await PublicKey.createWithSeed(payer, seed, TOKEN_PROGRAM_ID);
    instructions.push(
      SystemProgram.createAccountWithSeed({ fromPubkey: payer, basePubkey: payer, seed, newAccountPubkey: temporary, lamports: rent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeAccount3Instruction(temporary, mint, authority, TOKEN_PROGRAM_ID),
      createTransferCheckedInstruction(from, mint, temporary, authority, debit, 9, [], TOKEN_PROGRAM_ID),
      createCloseAccountInstruction(temporary, payer, authority, [], TOKEN_PROGRAM_ID),
      ...ready.filter(row => !(manualCreator && row.owner === payer.toBase58())).map(row => SystemProgram.transfer({ fromPubkey: payer, toPubkey: key(row.owner, 'holder recipient', true), lamports: amount(row.amount, true) })),
    );
  }
  return { instructions, payouts: ready, deferredPayouts, quoteDebitRaw: debit.toString(), rentLamports: rentLamports.toString(), slot, native, sourceTokenAccount: from.toBase58(), recipientCheck };
}
