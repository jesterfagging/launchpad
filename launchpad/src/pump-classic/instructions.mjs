// Pump.fun Classic: plain instruction builders for native Pump, Pump Fees and
// the PumpSwap creator-fee sweep, built from the vendored official IDL.
//
// Every builder returns { programId, keys: [{ pubkey, isSigner, isWritable }], data }
// with base58 strings and a Buffer. The chain adapter wraps them in web3.js
// TransactionInstruction objects. Account order, signer and writable flags come
// from the IDL; addresses derive from the IDL's PDA seeds. Liquidity and AMM
// swaps after graduation use the pinned PumpSwap SDK in the chain adapter
// because those instructions take SDK-managed remaining accounts.
import { pda, key, associatedTokenAddress, publicKeyBytes, isAddress, BorshWriter, SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, MEMO_PROGRAM, NATIVE_MINT } from './codec.mjs';
import { PROGRAMS, accountMetas, encodeInstructionData } from './idl.mjs';

const fail = message => { throw Object.assign(Error(message), { code: 'PUMP_CLASSIC_INSTRUCTION', statusCode: 400 }); };
export const PUMP_PROGRAM = PROGRAMS.pump;
export const PUMP_AMM_PROGRAM = PROGRAMS.pump_amm;
export const PUMP_FEES_PROGRAM = PROGRAMS.pump_fees;
export const MAYHEM_PROGRAM = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e';
export const CANONICAL_POOL_INDEX = 0;
const address = (value, label) => { if (!isAddress(value)) fail(`Invalid ${label} address.`); return value; };
/**
 * The coin's quote asset: { mint, program, native }. SOL coins trade native SOL
 * (wrapped SOL is passed where the IDL asks for a quote mint); other coins pair
 * with a mint Pump approved (Global whitelist or the quote-control list).
 */
export const SOL_QUOTE = Object.freeze({ mint: NATIVE_MINT, program: TOKEN_PROGRAM, native: true });
export function quoteOf(quote) {
  if (!quote || quote.mint === NATIVE_MINT || quote.native === true) return SOL_QUOTE;
  address(quote.mint, 'quote mint');
  if (![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(quote.program)) fail('Invalid quote token program.');
  return Object.freeze({ mint: quote.mint, program: quote.program, native: false });
}
const u64 = (value, label) => { const n = typeof value === 'bigint' ? value : BigInt(String(value)); if (n < 0n || n > 18446744073709551615n) fail(`Invalid ${label} amount.`); return n; };

// --- Addresses --------------------------------------------------------------------
export const pumpAddresses = Object.freeze({
  global: pda(['global'], PUMP_PROGRAM),
  mintAuthority: pda(['mint-authority'], PUMP_PROGRAM),
  eventAuthority: pda(['__event_authority'], PUMP_PROGRAM),
  globalVolumeAccumulator: pda(['global_volume_accumulator'], PUMP_PROGRAM),
  quoteControl: pda(['quote-control'], PUMP_PROGRAM),
  feeConfig: pda(['fee_config', key(PUMP_PROGRAM)], PUMP_FEES_PROGRAM),
  feesEventAuthority: pda(['__event_authority'], PUMP_FEES_PROGRAM),
  ammEventAuthority: pda(['__event_authority'], PUMP_AMM_PROGRAM),
  ammGlobalConfig: pda(['global_config'], PUMP_AMM_PROGRAM),
  ammFeeConfig: pda(['fee_config', key(PUMP_AMM_PROGRAM)], PUMP_FEES_PROGRAM),
  mayhemGlobalParams: pda(['global-params'], MAYHEM_PROGRAM),
  mayhemSolVault: pda(['sol-vault'], MAYHEM_PROGRAM),
});
const addressCache = new Map();
export function coinAddresses(mint, quoteInput) {
  address(mint, 'mint'); const quote = quoteOf(quoteInput), cacheKey = mint + ':' + quote.mint;
  if (addressCache.has(cacheKey)) return addressCache.get(cacheKey);
  const bondingCurve = pda(['bonding-curve', key(mint)], PUMP_PROGRAM), sharingConfig = pda(['sharing-config', key(mint)], PUMP_FEES_PROGRAM);
  const sharedCreatorVault = pda(['creator-vault', key(sharingConfig)], PUMP_PROGRAM), poolAuthority = pda(['pool-authority', key(mint)], PUMP_PROGRAM);
  const canonicalPool = pda(['pool', Buffer.from([CANONICAL_POOL_INDEX & 255, CANONICAL_POOL_INDEX >> 8]), key(poolAuthority), key(mint), key(quote.mint)], PUMP_AMM_PROGRAM);
  const ammCreatorVaultAuthority = pda(['creator_vault', key(sharingConfig)], PUMP_AMM_PROGRAM);
  const value = Object.freeze({
    mint, quote, bondingCurve, sharingConfig, sharedCreatorVault, poolAuthority, canonicalPool,
    associatedBondingCurve: associatedTokenAddress(bondingCurve, mint, TOKEN_2022_PROGRAM),
    associatedQuoteBondingCurve: associatedTokenAddress(bondingCurve, quote.mint, quote.program),
    sharedCreatorVaultQuoteAta: associatedTokenAddress(sharedCreatorVault, quote.mint, quote.program),
    mayhemState: pda(['mayhem-state', key(mint)], MAYHEM_PROGRAM),
    mayhemTokenVault: associatedTokenAddress(pumpAddresses.mayhemSolVault, mint, TOKEN_2022_PROGRAM),
    ammCreatorVaultAuthority, ammCreatorVaultAta: associatedTokenAddress(ammCreatorVaultAuthority, quote.mint, quote.program),
    lpMint: pda(['pool_lp_mint', key(canonicalPool)], PUMP_AMM_PROGRAM),
    poolBaseTokenAccount: associatedTokenAddress(canonicalPool, mint, TOKEN_2022_PROGRAM),
    poolQuoteTokenAccount: associatedTokenAddress(canonicalPool, quote.mint, quote.program),
  });
  if (addressCache.size > 2000) addressCache.delete(addressCache.keys().next().value);
  addressCache.set(cacheKey, value); return value;
}
/** A wallet's associated account for the coin's quote asset (wrapped SOL for SOL coins). */
export const quoteAta = (owner, quoteInput) => { const q = quoteOf(quoteInput); return associatedTokenAddress(address(owner, 'quote owner'), q.mint, q.program); };
export const creatorVault = creator => pda(['creator-vault', key(address(creator, 'creator'))], PUMP_PROGRAM);
export const userVolumeAccumulator = user => pda(['user_volume_accumulator', key(address(user, 'user'))], PUMP_PROGRAM);
const instruction = (prog, name, values, args, remaining = []) => ({ programId: PROGRAMS[prog], keys: [...accountMetas(prog, name, values).map(({ pubkey, isSigner, isWritable }) => ({ pubkey, isSigner, isWritable })), ...remaining], data: encodeInstructionData(prog, name, args) });

// --- Pump: creation, sharing, trading, distribution -------------------------------
/**
 * create_v2. A SOL coin omits every optional trailing argument and remaining
 * account, so cashback, custom creator fee and holder-reward mode all read as
 * off. A coin on another approved quote appends the documented remaining
 * accounts (quote mint, the curve's quote account, the quote token program and,
 * for a mint admitted through quote-control, the quote-control PDA). A custom
 * creator fee (quote-control pairs only) is the trailing creator_fee_bps, with
 * cashback explicitly off before it.
 */
/**
 * The remaining accounts of a coin paired with a pump coin Q (Pump's public docs, CREATE_WITH_PUMP_COIN_QUOTE.md), after
 * the quote mint, its curve account and token program and the quote control: Q's bonding curve, then Q's PumpSwap pool
 * with its two vaults once Q has migrated, then the same group for each coin below Q, nearest first.
 */
export function pumpQuoteAccounts(pumpQuote) {
  const group = ({ curve, pool }) => { address(curve, 'quote bonding curve'); const out = [{ pubkey: curve, isSigner: false, isWritable: false }]; if (pool) { for (const [key, label] of [['address', 'quote pool'], ['base', 'quote pool base vault'], ['quote', 'quote pool quote vault']]) { address(pool[key], label); out.push({ pubkey: pool[key], isSigner: false, isWritable: true }); } } return out; };
  const chain = Array.isArray(pumpQuote.chain) ? pumpQuote.chain : [];
  if (chain.length > 5) fail('The quote coin chain is too deep.');
  return [...group(pumpQuote), ...chain.flatMap(group)];
}
export function createV2({ mint, user, creator, name, symbol, uri, quote: quoteInput, quoteControl = false, pumpQuote = null, creatorFeeBps = 0 }) {
  address(mint, 'mint'); address(user, 'payer'); address(creator, 'creator');
  if (typeof name !== 'string' || !name.trim() || [...name].length > 32) fail('The coin name must be 1-32 characters.');
  if (typeof symbol !== 'string' || !symbol.trim() || [...symbol].length > 13) fail('The ticker must be 1-13 characters.');
  if (typeof uri !== 'string' || !/^https:\/\//.test(uri) || Buffer.byteLength(uri) > 200) fail('The metadata URI must be an https URL of at most 200 bytes.');
  const quote = quoteOf(quoteInput), a = coinAddresses(mint, quote), fee = BigInt(creatorFeeBps || 0);
  if (fee < 0n || fee > 10000n) fail('Invalid creator fee.');
  if (fee > 0n && (quote.native || !quoteControl)) fail('A custom creator fee is only available on custom pairs.');
  if (quoteControl && quote.native) fail('SOL is not a quote-control pair.');
  if (pumpQuote && (quote.native || !quoteControl)) fail('A pump coin quote passes the quote control and the quote coin accounts.');
  const remaining = quote.native ? [] : [
    { pubkey: quote.mint, isSigner: false, isWritable: false }, { pubkey: a.associatedQuoteBondingCurve, isSigner: false, isWritable: true },
    { pubkey: quote.program, isSigner: false, isWritable: false }, ...(quoteControl ? [{ pubkey: pumpAddresses.quoteControl, isSigner: false, isWritable: false }] : []),
    ...(pumpQuote ? pumpQuoteAccounts(pumpQuote) : []),
  ];
  return instruction('pump', 'create_v2', {
    mint, mint_authority: pumpAddresses.mintAuthority, bonding_curve: a.bondingCurve, associated_bonding_curve: a.associatedBondingCurve,
    global: pumpAddresses.global, user, mayhem_program_id: MAYHEM_PROGRAM, global_params: pumpAddresses.mayhemGlobalParams, sol_vault: pumpAddresses.mayhemSolVault,
    mayhem_state: a.mayhemState, mayhem_token_vault: a.mayhemTokenVault, event_authority: pumpAddresses.eventAuthority, program: PUMP_PROGRAM,
  }, { name, symbol, uri, creator, is_mayhem_mode: false, ...(fee > 0n ? { is_cashback_enabled: false, creator_fee_bps: fee } : {}) }, remaining);
}
/** Pump Fees: opt the (not yet graduated) coin into shared distribution. */
export function createFeeSharingConfig({ payer, mint }) {
  address(payer, 'payer'); const a = coinAddresses(mint);
  return instruction('pump_fees', 'create_fee_sharing_config', {
    event_authority: pumpAddresses.feesEventAuthority, program: PUMP_FEES_PROGRAM, payer, global: pumpAddresses.global, mint,
    sharing_config: a.sharingConfig, bonding_curve: a.bondingCurve, pump_program: PUMP_PROGRAM, pump_event_authority: pumpAddresses.eventAuthority,
    // Not graduated: the pool and both AMM accounts are None (the invoked program's ID).
    pool: null, pump_amm_program: null, pump_amm_event_authority: null,
  }, {});
}
export function validShareholders(shareholders) {
  if (!Array.isArray(shareholders) || shareholders.length < 1 || shareholders.length > 10) fail('Fee sharing needs one to ten shareholders.');
  const seen = new Set(); let total = 0;
  for (const s of shareholders) {
    address(s?.address, 'shareholder'); if (seen.has(s.address)) fail('Fee shareholders must be distinct.'); seen.add(s.address);
    if (!Number.isInteger(s.shareBps) || s.shareBps <= 0 || s.shareBps > 10000) fail('Each fee share must be between 1 and 10,000 bps.');
    total += s.shareBps;
  }
  if (total !== 10000) fail('Fee shares must total 10,000 bps.');
  return shareholders.map(s => ({ address: s.address, shareBps: s.shareBps }));
}
/** Remaining accounts of a distribution: the shareholders, then (non-native quote) their quote accounts, in config order. */
function shareholderAccounts(holders, quote) {
  const wallets = holders.map(holder => ({ pubkey: address(holder, 'shareholder'), isSigner: false, isWritable: true }));
  return quote.native ? wallets : [...wallets, ...holders.map(holder => ({ pubkey: associatedTokenAddress(holder, quote.mint, quote.program), isSigner: false, isWritable: true }))];
}
/** Pump Fees: set the final shareholders once (the admin is revoked afterwards). */
export function updateFeeSharesV2({ authority, mint, currentShareholders, newShareholders, quote: quoteInput }) {
  address(authority, 'authority'); const quote = quoteOf(quoteInput), a = coinAddresses(mint, quote), next = validShareholders(newShareholders);
  if (!Array.isArray(currentShareholders) || !currentShareholders.length) fail('The current shareholders are required.');
  return instruction('pump_fees', 'update_fee_shares_v2', {
    event_authority: pumpAddresses.feesEventAuthority, program: PUMP_FEES_PROGRAM, authority, global: pumpAddresses.global, mint,
    sharing_config: a.sharingConfig, bonding_curve: a.bondingCurve, pump_creator_vault: a.sharedCreatorVault, pump_creator_vault_ata: a.sharedCreatorVaultQuoteAta,
    pump_program: PUMP_PROGRAM, pump_event_authority: pumpAddresses.eventAuthority, pump_amm_program: PUMP_AMM_PROGRAM, amm_event_authority: pumpAddresses.ammEventAuthority,
    quote_mint: quote.mint, token_program: quote.program, coin_creator_vault_authority: a.ammCreatorVaultAuthority, coin_creator_vault_ata: a.ammCreatorVaultAta,
  }, { shareholders: next.map(s => ({ address: s.address, share_bps: s.shareBps })) }, shareholderAccounts(currentShareholders, quote));
}
function tradeAccounts({ mint, user, creator, feeRecipient, buybackFeeRecipient, volume = true, quote: quoteInput }) {
  address(user, 'trader'); address(creator, 'curve creator'); address(feeRecipient, 'fee recipient'); address(buybackFeeRecipient, 'buyback fee recipient');
  const quote = quoteOf(quoteInput), a = coinAddresses(mint, quote), vault = creatorVault(creator), accumulator = userVolumeAccumulator(user), qa = owner => associatedTokenAddress(owner, quote.mint, quote.program);
  return {
    global: pumpAddresses.global, base_mint: mint, quote_mint: quote.mint, base_token_program: TOKEN_2022_PROGRAM, quote_token_program: quote.program,
    fee_recipient: feeRecipient, associated_quote_fee_recipient: qa(feeRecipient),
    buyback_fee_recipient: buybackFeeRecipient, associated_quote_buyback_fee_recipient: qa(buybackFeeRecipient),
    bonding_curve: a.bondingCurve, associated_base_bonding_curve: a.associatedBondingCurve, associated_quote_bonding_curve: a.associatedQuoteBondingCurve,
    user, associated_base_user: associatedTokenAddress(user, mint, TOKEN_2022_PROGRAM), associated_quote_user: qa(user),
    creator_vault: vault, associated_creator_vault: qa(vault), sharing_config: a.sharingConfig,
    ...(volume ? { global_volume_accumulator: pumpAddresses.globalVolumeAccumulator } : {}),
    user_volume_accumulator: accumulator, associated_user_volume_accumulator: qa(accumulator),
    fee_config: pumpAddresses.feeConfig, event_authority: pumpAddresses.eventAuthority,
  };
}
/**
 * init_user_volume_accumulator: creates `user`'s Pump volume account, paid by
 * `payer`. A first buy would otherwise create it inside the trade; creating it
 * beforehand keeps the launch transaction within Solana's instruction limit.
 */
export function initUserVolumeAccumulator({ payer, user }) {
  address(payer, 'payer'); address(user, 'user');
  return instruction('pump', 'init_user_volume_accumulator', { payer, user, user_volume_accumulator: userVolumeAccumulator(user), event_authority: pumpAddresses.eventAuthority, program: PUMP_PROGRAM });
}
/** buy_v2: exactly `amount` base tokens for at most `maxQuoteIn` lamports (fees included). */
export function buyV2({ amount, maxQuoteIn, ...accounts }) {
  return instruction('pump', 'buy_v2', tradeAccounts(accounts), { amount: u64(amount, 'token'), max_sol_cost: u64(maxQuoteIn, 'maximum SOL') });
}
/** buy_exact_quote_in_v2: spend exactly `quoteIn` lamports for at least `minTokensOut`. */
export function buyExactQuoteInV2({ quoteIn, minTokensOut, ...accounts }) {
  return instruction('pump', 'buy_exact_quote_in_v2', tradeAccounts(accounts), { spendable_quote_in: u64(quoteIn, 'SOL'), min_tokens_out: u64(minTokensOut, 'minimum token') });
}
/** sell_v2: exactly `amount` base tokens for at least `minQuoteOut` lamports after fees. */
export function sellV2({ amount, minQuoteOut, ...accounts }) {
  return instruction('pump', 'sell_v2', tradeAccounts({ ...accounts, volume: false }), { amount: u64(amount, 'token'), min_sol_output: u64(minQuoteOut, 'minimum SOL') });
}
/**
 * distribute_creator_fees_v2. Remaining accounts are the shareholders in config
 * order and, for a non-native quote, their quote accounts (created on the fly
 * with initialize_ata, paid by the payer).
 */
export function distributeCreatorFeesV2({ payer, mint, shareholders, quote: quoteInput }) {
  address(payer, 'payer'); const quote = quoteOf(quoteInput), a = coinAddresses(mint, quote);
  if (!Array.isArray(shareholders) || !shareholders.length || shareholders.length > 10) fail('Distribution needs the configured shareholders.');
  return instruction('pump', 'distribute_creator_fees_v2', {
    payer, mint, bonding_curve: a.bondingCurve, sharing_config: a.sharingConfig, creator_vault: a.sharedCreatorVault, event_authority: pumpAddresses.eventAuthority,
    creator_vault_quote_token_account: a.sharedCreatorVaultQuoteAta, quote_mint: quote.mint, quote_token_program: quote.program,
  }, { initialize_ata: !quote.native }, shareholderAccounts(shareholders, quote));
}
/** PumpSwap: sweep the AMM coin-creator vault (owned by the sharing config) into Pump's creator vault. */
export function transferCreatorFeesToPumpV2({ payer, mint, quote: quoteInput }) {
  address(payer, 'payer'); const quote = quoteOf(quoteInput), a = coinAddresses(mint, quote);
  return instruction('pump_amm', 'transfer_creator_fees_to_pump_v2', {
    payer, quote_mint: quote.mint, token_program: quote.program, coin_creator: a.sharingConfig, coin_creator_vault_authority: a.ammCreatorVaultAuthority,
    coin_creator_vault_ata: a.ammCreatorVaultAta, pump_creator_vault: a.sharedCreatorVault, pump_creator_vault_ata: a.sharedCreatorVaultQuoteAta,
    event_authority: pumpAddresses.ammEventAuthority, program: PUMP_AMM_PROGRAM,
  }, {});
}

// --- System, SPL Token, ATA, compute budget and memo ------------------------------
export function systemTransfer({ from, to, lamports }) {
  address(from, 'sender'); address(to, 'recipient');
  const data = Buffer.alloc(12); data.writeUInt32LE(2, 0); data.writeBigUInt64LE(u64(lamports, 'SOL'), 4);
  return { programId: SYSTEM_PROGRAM, keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }], data };
}
export function createAtaIdempotent({ payer, owner, mint, tokenProgram = TOKEN_2022_PROGRAM }) {
  address(payer, 'payer'); address(owner, 'token owner'); address(mint, 'mint');
  return { programId: ASSOCIATED_TOKEN_PROGRAM, keys: [
    { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: associatedTokenAddress(owner, mint, tokenProgram), isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }, { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ], data: Buffer.from([1]) };
}
export function transferChecked({ owner, recipient, mint, amount, decimals, tokenProgram = TOKEN_2022_PROGRAM }) {
  address(owner, 'token owner'); address(recipient, 'token recipient'); address(mint, 'mint');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) fail('Invalid token decimals.');
  return { programId: tokenProgram, keys: [
    { pubkey: associatedTokenAddress(owner, mint, tokenProgram), isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: associatedTokenAddress(recipient, mint, tokenProgram), isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false },
  ], data: new BorshWriter().u8(12).u64(u64(amount, 'token')).u8(decimals).toBuffer() };
}
export function closeTokenAccount({ owner, mint, destination = owner, tokenProgram = TOKEN_2022_PROGRAM }) {
  address(owner, 'token owner'); address(destination, 'rent destination');
  return { programId: tokenProgram, keys: [
    { pubkey: associatedTokenAddress(owner, mint, tokenProgram), isSigner: false, isWritable: true }, { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ], data: Buffer.from([9]) };
}
export const computeUnitLimit = units => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: new BorshWriter().u8(2).u32(units).toBuffer() });
export const computeUnitPrice = microLamports => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: new BorshWriter().u8(3).u64(microLamports).toBuffer() });
export function memo(text, signer) {
  if (typeof text !== 'string' || !text || Buffer.byteLength(text) > 180) fail('Invalid memo.');
  return { programId: MEMO_PROGRAM, keys: signer ? [{ pubkey: address(signer, 'memo signer'), isSigner: true, isWritable: false }] : [], data: Buffer.from(text, 'utf8') };
}
export const keyBytes = publicKeyBytes;
