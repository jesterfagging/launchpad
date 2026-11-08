// Pump.fun Classic: pure, dependency-free launch planning and receipt analysis.
//
// Everything here works on plain data: account infos as { owner, lamports,
// data, executable } with base58 owners, instructions as returned by
// instructions.mjs and finalized transactions in the RPC's JSON shape. The
// chain adapter fetches, simulates, signs and broadcasts; this module decides
// what the transaction must contain and what its effects must be. Nothing in
// here reads a clock, a key or the network.
import { createHash } from 'node:crypto';
import { PUMP_PROGRAM, PUMP_AMM_PROGRAM, PUMP_FEES_PROGRAM, pumpAddresses, coinAddresses, quoteOf, quoteAta, SOL_QUOTE, createV2, createFeeSharingConfig, updateFeeSharesV2, buyV2, sellV2, buyExactQuoteInV2, distributeCreatorFeesV2, transferCreatorFeesToPumpV2, systemTransfer, createAtaIdempotent, transferChecked, closeTokenAccount, validShareholders, initUserVolumeAccumulator, userVolumeAccumulator } from './instructions.mjs';
import { decodeAccount, decodeEvent, decodeInstructionArgs } from './idl.mjs';
import { base58Decode, base58Encode, associatedTokenAddress, isAddress, isOnCurve, SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, NATIVE_MINT, COMPUTE_BUDGET_PROGRAM, MEMO_PROGRAM } from './codec.mjs';
import { curveFeeBps, quoteCurveFeeBps, curveTokensForQuote, curveBuyCost, curveSellOutput, effectiveQuoteReserves, ammFeeBps, ammBuyOutput, ammSellOutput, spotPrice, impactBps, PRICE_SCALE } from './math.mjs';

const DEFAULT_KEY = SYSTEM_PROGRAM;
export const TOKEN_DECIMALS = 6;
export const STANDARD_SUPPLY = 1000000000000000n;
const fail = (message, code = 'PUMP_CLASSIC_EFFECTS', statusCode = 409) => { throw Object.assign(Error(message), { code, statusCode }); };
const must = (condition, message, code) => { if (!condition) fail(message, code); };
const big = value => typeof value === 'bigint' ? value : BigInt(String(value ?? '0'));
const str = value => String(value?.toBase58 ? value.toBase58() : value ?? '');

// --- Account infos ------------------------------------------------------------
/** Normalizes a web3.js or RPC JSON account info to { owner, lamports, data, executable } (null stays null). */
export function plainAccount(info) {
  if (info === null || info === undefined) return null;
  const data = Array.isArray(info.data) ? Buffer.from(info.data[0], info.data[1] === 'base64' ? 'base64' : 'base64') : Buffer.from(info.data || []);
  return { owner: str(info.owner), lamports: big(info.lamports), data, executable: !!info.executable };
}
/**
 * Whether an account no longer exists after a transaction. RPC simulation results
 * can return a closed account as null or as an entry left with 0 lamports and no
 * data, depending on the node, so both count as closed.
 */
export const accountClosed = info => info === null || info === undefined || big(info.lamports ?? 0) === 0n;
const owned = (info, program, label) => { must(info && !info.executable && info.owner === program, `The ${label} account is missing or has the wrong owner.`, 'PUMP_CLASSIC_ACCOUNT'); return info; };
export function readGlobal(raw) {
  const info = owned(plainAccount(raw), PUMP_PROGRAM, 'Pump global'), g = decodeAccount('pump', 'Global', info.data);
  must(g.initialized === true && g.create_v2_enabled === true, 'Pump coin creation is not enabled right now.', 'PUMP_CLASSIC_GLOBAL');
  for (const k of ['initial_virtual_token_reserves', 'initial_virtual_sol_reserves', 'initial_real_token_reserves', 'token_total_supply']) must(big(g[k]) > 0n, 'Pump global parameters are incomplete.', 'PUMP_CLASSIC_GLOBAL');
  must(big(g.token_total_supply) >= 10n ** 14n && big(g.token_total_supply) <= 10n ** 16n && big(g.initial_real_token_reserves) < big(g.initial_virtual_token_reserves), 'Pump global supply parameters are outside the reviewed range.', 'PUMP_CLASSIC_GLOBAL');
  return g;
}
export function readFeeConfig(raw, prog = 'pump') {
  if (raw === null || raw === undefined) return null;
  const info = owned(plainAccount(raw), PUMP_FEES_PROGRAM, 'Pump fee configuration');
  return decodeAccount(prog, 'FeeConfig', info.data);
}
export function readBondingCurve(raw, mint, quoteInput) {
  const info = owned(plainAccount(raw), PUMP_PROGRAM, 'bonding curve'), bc = decodeAccount('pump', 'BondingCurve', info.data), quote = quoteOf(quoteInput);
  // SOL coins store Pubkey::default() (older ones may hold wrapped SOL); any other coin stores its quote mint.
  if (quote.native) must(bc.quote_mint === DEFAULT_KEY || bc.quote_mint === NATIVE_MINT, 'This coin is not paired with SOL.', 'PUMP_CLASSIC_CURVE');
  else must(bc.quote_mint === quote.mint, 'This coin is paired with a different quote asset.', 'PUMP_CLASSIC_CURVE');
  if (mint) must(coinAddresses(mint, quote).bondingCurve !== undefined, 'Invalid mint.');
  return { ...bc, lamports: info.lamports };
}
/** A bonding curve read without knowing its quote (a quote coin's own curve): the decoded account plus `quoteMint` (null for SOL). */
export function readAnyBondingCurve(raw, mint) {
  const info = owned(plainAccount(raw), PUMP_PROGRAM, 'bonding curve'), bc = decodeAccount('pump', 'BondingCurve', info.data);
  if (mint) must(coinAddresses(mint).bondingCurve !== undefined, 'Invalid mint.');
  return { ...bc, lamports: info.lamports, quoteMint: bc.quote_mint === DEFAULT_KEY || bc.quote_mint === NATIVE_MINT ? null : bc.quote_mint };
}
/** Pump's quote-control list: the custom pairs admitted beyond the Global whitelist. */
export function readQuoteControl(raw) {
  if (raw === null || raw === undefined) return null;
  const info = owned(plainAccount(raw), PUMP_PROGRAM, 'Pump quote control'), qc = decodeAccount('pump', 'QuoteControl', info.data);
  return { admin: qc.admin, mints: qc.mints.filter(m => isAddress(m.mint) && m.mint !== DEFAULT_KEY).map(m => ({ mint: m.mint, initialVirtualQuoteReserves: big(m.initial_virtual_quote_reserves) })) };
}
/**
 * Every quote asset a new Pump coin may pair with, from live program state:
 * SOL, the mints Global whitelists (Pump's listed stable quote, e.g. USDC) and
 * the quote-control list (custom pairs, which seed the curve from their own
 * entry and may carry a coin-specific creator fee). Global wins when a mint is
 * on both lists, exactly as create_v2 resolves it. Entries without positive
 * initial reserves are left out: a fresh curve could not be quoted.
 */
export function pumpQuotes({ global, quoteControl = null }) {
  const out = [{ mint: NATIVE_MINT, kind: 'sol', quoteControl: false, initialVirtualQuoteReserves: big(global.initial_virtual_sol_reserves) > 0n ? big(global.initial_virtual_sol_reserves) : big(global.initial_virtual_quote_reserves) }], seen = new Set([NATIVE_MINT, DEFAULT_KEY]);
  const listedReserves = big(global.initial_virtual_quote_reserves);
  for (const mint of global.whitelisted_quote_mints || []) { if (!isAddress(mint) || seen.has(mint)) continue; seen.add(mint); if (listedReserves > 0n) out.push({ mint, kind: 'listed', quoteControl: false, initialVirtualQuoteReserves: listedReserves }); }
  for (const row of quoteControl?.mints || []) { if (seen.has(row.mint)) continue; seen.add(row.mint); if (row.initialVirtualQuoteReserves > 0n) out.push({ mint: row.mint, kind: 'custom', quoteControl: true, initialVirtualQuoteReserves: row.initialVirtualQuoteReserves }); }
  return out;
}
// Token-2022 extension types (spl-token ExtensionType numbering).
const EXT = Object.freeze({ TransferFeeConfig: 1, MintCloseAuthority: 3, ConfidentialTransferMint: 4, DefaultAccountState: 6, NonTransferable: 9, InterestBearingConfig: 10, PermanentDelegate: 12, TransferHook: 14, MetadataPointer: 18, TokenMetadata: 19, ScaledUiAmountConfig: 25, PausableConfig: 26 });
// The extension set Pump admits on a Token-2022 quote mint (create_v2 docs).
const QUOTE_EXTENSIONS = new Set([EXT.MetadataPointer, EXT.TokenMetadata, EXT.PermanentDelegate, EXT.DefaultAccountState, EXT.ScaledUiAmountConfig, EXT.PausableConfig, EXT.ConfidentialTransferMint, EXT.TransferHook]);
/** Token-2022 mint TLV entries after the 165-byte base and account-type byte: [{ type, data }]. */
export function mintExtensions(data) {
  const bytes = Buffer.from(data || []); if (bytes.length <= 166) return [];
  must(bytes[165] === 1, 'The quote mint has an invalid Token-2022 layout.', 'PUMP_CLASSIC_MINT');
  const out = []; let offset = 166;
  while (offset + 4 <= bytes.length) {
    const type = bytes.readUInt16LE(offset), length = bytes.readUInt16LE(offset + 2); if (type === 0) break;
    must(offset + 4 + length <= bytes.length, 'The quote mint has a truncated extension.', 'PUMP_CLASSIC_MINT');
    out.push({ type, data: bytes.subarray(offset + 4, offset + 4 + length) }); offset += 4 + length;
  }
  return out;
}
/**
 * Name and symbol from a Token-2022 TokenMetadata extension (Borsh: update
 * authority, mint, name, symbol, uri, …). Display only; never trusted for
 * identity. Returns null when absent or malformed.
 */
export function tokenMetadataText(extensions = []) {
  const ext = extensions.find(e => e.type === EXT.TokenMetadata); if (!ext) return null;
  const data = Buffer.from(ext.data), text = offset => { if (offset + 4 > data.length) return null; const length = data.readUInt32LE(offset); if (length > 200 || offset + 4 + length > data.length) return null; return { value: data.subarray(offset + 4, offset + 4 + length).toString('utf8'), next: offset + 4 + length }; };
  const name = text(64), symbol = name && text(name.next); if (!name || !symbol) return null;
  const clean = (value, max) => value.replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max);
  return { name: clean(name.value, 48), symbol: clean(symbol.value, 16) };
}
/**
 * Whether Launchpad can handle a Pump-approved quote mint exactly: an initialized
 * SPL or Token-2022 mint whose raw transfers are never reduced (no transfer
 * fee), whose new token accounts are not frozen by default and whose transfers
 * need no hook program. Returns the program and decimals used everywhere else.
 */
export function quoteMintSupport(raw) {
  const info = plainAccount(raw); if (!info || info.executable || ![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(info.owner) || info.data.length < 82) return { supported: false, reason: 'This pair’s token mint was not found.' };
  const base = readMint(raw); if (!base.initialized || base.decimals > 12) return { supported: false, reason: 'This pair’s token mint is not initialized.' };
  if (info.owner === TOKEN_PROGRAM) return { supported: true, program: TOKEN_PROGRAM, decimals: base.decimals, extensions: [], metadata: null };
  let extensions; try { extensions = mintExtensions(info.data); } catch { return { supported: false, reason: 'This pair’s token has an unreadable extension.' }; }
  const metadata = tokenMetadataText(extensions);
  for (const ext of extensions) {
    if (!QUOTE_EXTENSIONS.has(ext.type)) return { supported: false, program: TOKEN_2022_PROGRAM, decimals: base.decimals, metadata, reason: 'This pair’s token uses a feature Launchpad does not handle yet.' };
    if (ext.type === EXT.DefaultAccountState && ext.data[0] !== 1) return { supported: false, program: TOKEN_2022_PROGRAM, decimals: base.decimals, metadata, reason: 'New accounts of this pair’s token start frozen.' };
    if (ext.type === EXT.TransferHook && (ext.data.length < 64 || base58Encode(ext.data.subarray(32, 64)) !== DEFAULT_KEY)) return { supported: false, program: TOKEN_2022_PROGRAM, decimals: base.decimals, metadata, reason: 'This pair’s token runs a transfer hook program.' };
  }
  return { supported: true, program: TOKEN_2022_PROGRAM, decimals: base.decimals, extensions: extensions.map(e => e.type), metadata };
}
export function readSharingConfig(raw, mint) {
  const info = owned(plainAccount(raw), PUMP_FEES_PROGRAM, 'fee sharing configuration'), sc = decodeAccount('pump_fees', 'SharingConfig', info.data);
  if (mint) must(sc.mint === mint, 'The fee sharing configuration belongs to another coin.', 'PUMP_CLASSIC_SHARING');
  return { ...sc, shareholders: sc.shareholders.map(s => ({ address: s.address, shareBps: Number(s.share_bps) })) };
}
export function readAmmGlobalConfig(raw) { const info = owned(plainAccount(raw), PUMP_AMM_PROGRAM, 'PumpSwap configuration'); return decodeAccount('pump_amm', 'GlobalConfig', info.data); }
export function readPool(raw) { const info = owned(plainAccount(raw), PUMP_AMM_PROGRAM, 'PumpSwap pool'); return decodeAccount('pump_amm', 'Pool', info.data); }
/** SPL / Token-2022 account basics: mint, owner, amount (first 72 bytes are common to both programs). */
export function readTokenAccount(raw, { program, mint, owner } = {}) {
  const info = plainAccount(raw); if (!info) return null;
  must(!info.executable && [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(info.owner) && (!program || info.owner === program) && info.data.length >= 165, 'A token account has the wrong program or layout.', 'PUMP_CLASSIC_TOKEN');
  const value = { mint: base58Encode(info.data.subarray(0, 32)), owner: base58Encode(info.data.subarray(32, 64)), amount: info.data.readBigUInt64LE(64), state: info.data[108], delegateOption: info.data.readUInt32LE(72), closeOption: info.data.readUInt32LE(129), lamports: info.lamports, program: info.owner };
  must(value.state === 1, 'A token account is frozen or uninitialized.', 'PUMP_CLASSIC_TOKEN');
  if (mint) must(value.mint === mint, 'A token account holds a different mint.', 'PUMP_CLASSIC_TOKEN');
  if (owner) must(value.owner === owner, 'A token account belongs to another wallet.', 'PUMP_CLASSIC_TOKEN');
  return value;
}
/** Mint basics shared by SPL and Token-2022: supply, decimals, authorities. */
export function readMint(raw, { program } = {}) {
  const info = plainAccount(raw); must(info && !info.executable && [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(info.owner) && (!program || info.owner === program) && info.data.length >= 82, 'The coin mint is missing or has the wrong program.', 'PUMP_CLASSIC_MINT');
  const d = info.data;
  return { program: info.owner, mintAuthority: d.readUInt32LE(0) ? base58Encode(d.subarray(4, 36)) : null, supply: d.readBigUInt64LE(36), decimals: d[44], initialized: d[45] === 1, freezeAuthority: d.readUInt32LE(46) ? base58Encode(d.subarray(50, 82)) : null };
}
export const walletLamports = raw => { const info = plainAccount(raw); if (!info) return 0n; must(!info.executable && info.owner === SYSTEM_PROGRAM && info.data.length === 0, 'A Launchpad wallet must be an ordinary SOL wallet.', 'PUMP_CLASSIC_WALLET'); return info.lamports; };

// --- Trading recipients -----------------------------------------------------------
/** One normal and one buyback fee recipient from the live global, chosen deterministically per (mint, wallet). */
export function tradeRecipients(global, seed = '') {
  const normal = [global.fee_recipient, ...(global.fee_recipients || [])].filter(a => isAddress(a) && a !== DEFAULT_KEY);
  const buyback = (global.buyback_fee_recipients || []).filter(a => isAddress(a) && a !== DEFAULT_KEY);
  must(normal.length > 0 && buyback.length > 0, 'Pump fee recipients are unavailable.', 'PUMP_CLASSIC_GLOBAL');
  const h = createHash('sha256').update(String(seed)).digest();
  return { feeRecipient: normal[h[0] % normal.length], buybackFeeRecipient: buyback[h[1] % buyback.length] };
}

// --- Launch -------------------------------------------------------------------------
/**
 * The creation curve a new coin starts from, read from the live global. A SOL
 * coin uses Global's SOL reserves; another quote uses the initial virtual quote
 * reserves Pump resolved for it (pumpQuotes()).
 */
export function initialCurve(global, quote = null) {
  const vq = quote && quote.kind && quote.kind !== 'sol' ? big(quote.initialVirtualQuoteReserves) : big(global.initial_virtual_sol_reserves) > 0n ? big(global.initial_virtual_sol_reserves) : big(global.initial_virtual_quote_reserves);
  must(vq > 0n, 'Pump has no initial reserves for this quote asset.', 'PUMP_CLASSIC_GLOBAL');
  return { virtual_quote_reserves: vq, virtual_token_reserves: big(global.initial_virtual_token_reserves), real_token_reserves: big(global.initial_real_token_reserves), token_total_supply: big(global.token_total_supply) };
}
/**
 * A coin paired with a pump coin Q (Pump's public docs, CREATE_WITH_PUMP_COIN_QUOTE.md) has no fixed starting
 * reserves: Pump computes them from the live state of every coin on Q's chain, so the new coin raises about what a
 * normal launch raises, counted in Q. The off-chain mirror: take the quote a normal launch raises by sell-out
 * (`bottomReserves` is the listed quote's seed at the bottom of the chain: Global's SOL reserves or the
 * quote-control entry's), buy each chain coin with it in turn with no fees — on its PumpSwap pool once migrated
 * (constant product on the two vaults), otherwise on its curve, with the synthetic-migration pricing when the buy
 * empties the curve — and scale the Q tokens that last buy returns back to a seed with the seed:raise ratio every
 * normal curve has. `chain` runs from the depth-0 coin up to Q: [{ pool: { baseAmount, quoteAmount } } | { curve,
 * curveBaseBalance, migrationFee }]. Pump's own rounding may differ by a unit or so; launches tolerate that.
 */
export function pumpCoinQuoteReserves({ global, bottomReserves, chain }) {
  const vtok = big(global.initial_virtual_token_reserves), real = big(global.initial_real_token_reserves), seed = big(bottomReserves);
  must(vtok > real && real > 0n && seed > 0n && Array.isArray(chain) && chain.length > 0, 'Pump has no initial reserves for this quote asset.', 'PUMP_CLASSIC_GLOBAL');
  let amount = seed * real / (vtok - real);
  for (const coin of chain) {
    must(amount > 0n, 'The starting reserves computed from the quote coin round down to nothing.', 'PUMP_CLASSIC_QUOTE_ASSET');
    if (coin.pool) { const base = big(coin.pool.baseAmount), quote = big(coin.pool.quoteAmount); must(base > 0n && quote > 0n, 'The quote coin’s pool is empty.', 'PUMP_CLASSIC_QUOTE_ASSET'); amount = base * amount / (quote + amount); continue; }
    const c = coin.curve, vq = big(c.virtual_quote_reserves), vt = big(c.virtual_token_reserves), remaining = big(c.real_token_reserves);
    must(vq > 0n && vt > 0n, 'The quote coin’s curve has no reserves.', 'PUMP_CLASSIC_QUOTE_ASSET');
    const out = vt * amount / (vq + amount);
    if (out <= remaining) { amount = out; continue; }
    // The buy empties the curve: the rest is priced on the pool the migration would open (Pump's public docs, SYNTHETIC_MIGRATION.md).
    const curveQuote = vq * remaining / (vt - remaining), left = amount - curveQuote, poolBase = big(coin.curveBaseBalance) - remaining, poolQuote = big(c.real_quote_reserves) + curveQuote - big(coin.migrationFee || 0n);
    must(left >= 0n && poolBase > 0n && poolQuote > 0n, 'The quote coin’s curve cannot price this raise.', 'PUMP_CLASSIC_QUOTE_ASSET');
    amount = remaining + (left > 1n ? (left - 1n) * poolBase / (poolQuote + left - 1n) : 0n);
  }
  must(amount > 0n, 'The starting reserves computed from the quote coin round down to nothing.', 'PUMP_CLASSIC_QUOTE_ASSET');
  return amount * (vtok - real) / real;
}
/**
 * Exact tokens for a dev-buy budget on a fresh curve, in the quote asset's raw
 * units (lamports for SOL). The budget is a hard cap: buy_v2 signs it as its
 * maximum quote cost.
 */
export function launchQuote({ global, feeConfig, devBuyLamports, devBuyRaw = devBuyLamports, quote = null, creatorFeeBps = 0n }) {
  const budget = big(devBuyRaw), curve = initialCurve(global, quote);
  const feeBps = quoteCurveFeeBps({ global, feeConfig, curve, supply: curve.token_total_supply, kind: quote?.kind || 'sol', creatorFeeBps });
  if (budget === 0n) return { tokens: 0n, costLamports: 0n, maxSolCost: 0n, feeBps, curve };
  const tokens = curveTokensForQuote({ virtualQuote: curve.virtual_quote_reserves, virtualToken: curve.virtual_token_reserves, realToken: curve.real_token_reserves, quoteIn: budget, feeBps });
  must(tokens > 0n, 'The dev buy is too small to buy any tokens.', 'PUMP_CLASSIC_QUOTE');
  const cost = curveBuyCost({ virtualQuote: curve.virtual_quote_reserves, virtualToken: curve.virtual_token_reserves, realToken: curve.real_token_reserves, amount: tokens, feeBps });
  must(cost.total <= budget, 'The dev-buy quote exceeds its budget.', 'PUMP_CLASSIC_QUOTE');
  return { tokens, costLamports: cost.total, maxSolCost: budget, feeBps, curve };
}
/**
 * The atomic launch: create (launch wallet is payer and initial creator), opt
 * into fee sharing, set the final shareholders (admin revoked), dev buy with
 * the shared creator vault, deliver the exact tokens, close the temporary token
 * account and fund the per-coin Launchpad wallets. Returns plain instructions.
 */
/** Base58 address shape (format only; on-curve checks live in codec.isOnCurve). */
export const isAddressLike = value => typeof value === 'string' && isAddress(value);
/**
 * The accounts a launch on another pair needs before its creation transaction:
 * the launch wallet's pair account (dev-buy source and initial shareholder), the
 * shared creator vault's (distribution source), the PumpSwap creator vault's
 * (post-graduation sweeps) and, with a dev buy, the launch wallet's Pump volume
 * account with its pair account and the chosen fee recipients' pair accounts.
 * Created in a separate setup transaction, they keep the creation transaction
 * inside Solana's limit of 64 program calls per transaction: a dev buy on a
 * token-program pair makes several token calls of its own.
 */
export function launchSetupPlan({ mint, launchWallet, global, quote: quoteInput, devBuy = false }) {
  const quote = quoteOf(quoteInput); must(!quote.native, 'Only a launch on another pair needs a setup transaction.', 'PUMP_CLASSIC_SETUP');
  const a = coinAddresses(mint, quote), ata = owner => ({ kind: 'ata', owner, address: quoteAta(owner, quote) });
  const rows = [ata(launchWallet), ata(a.sharedCreatorVault), ata(a.ammCreatorVaultAuthority)];
  if (devBuy) {
    const { feeRecipient, buybackFeeRecipient } = tradeRecipients(global, mint + launchWallet), volume = userVolumeAccumulator(launchWallet);
    rows.push({ kind: 'volume', owner: launchWallet, address: volume }, ata(volume), ata(feeRecipient), ata(buybackFeeRecipient));
  }
  const seen = new Set(); return rows.filter(r => !seen.has(r.address) && seen.add(r.address));
}
/** Instructions creating the setup accounts that do not exist yet (`missing`: rows of launchSetupPlan). */
export function launchSetupInstructions({ launchWallet, quote: quoteInput, missing }) {
  const quote = quoteOf(quoteInput);
  return missing.map(row => row.kind === 'volume' ? initUserVolumeAccumulator({ payer: launchWallet, user: row.owner }) : createAtaIdempotent({ payer: launchWallet, owner: row.owner, mint: quote.mint, tokenProgram: quote.program }));
}
/**
 * The launch transaction. `pairAccounts`: 'create' creates the pair accounts
 * inline (`ammVault` false leaves out the PumpSwap creator vault's), 'ready'
 * expects them from the setup transaction. `delivery`: 'inline' moves the dev-buy
 * tokens to the developer in the same transaction; 'separate' leaves them in the
 * launch wallet for the delivery transaction (deliveryInstructions).
 */
export function launchInstructions({ mint, launchWallet, developer, name, symbol, uri, shareholders, tokens = 0n, maxSolCost = 0n, global, transfers = [], quote: quoteInput = null, quoteControl = false, pumpQuote = null, creatorFeeBps = 0n, pairAccounts = 'create', ammVault = true, delivery = 'inline' }) {
  for (const [value, label] of [[mint, 'mint'], [launchWallet, 'launch wallet'], [developer, 'developer wallet']]) must(isAddress(value), `Invalid ${label}.`);
  must(new Set([mint, launchWallet, developer]).size === 3, 'The launch, mint and developer addresses must be distinct.');
  const final = validShareholders(shareholders);
  must(!final.some(s => s.address === launchWallet || s.address === mint), 'The launch wallet cannot be a final fee shareholder.');
  const quote = quoteOf(quoteInput), a = coinAddresses(mint, quote), amount = big(tokens), cap = big(maxSolCost), out = [];
  out.push(createV2({ mint, user: launchWallet, creator: launchWallet, name, symbol, uri, quote, quoteControl, pumpQuote, creatorFeeBps }));
  must(['create', 'ready'].includes(pairAccounts) && ['inline', 'separate'].includes(delivery), 'Invalid launch layout.');
  if (!quote.native && pairAccounts === 'create') {
    // Quote accounts Pump expects to exist for a non-native quote: the launch
    // wallet's (initial shareholder and dev-buy source), the shared creator
    // vault's (distribution source) and the AMM creator vault's (post-graduation sweep).
    for (const owner of [launchWallet, a.sharedCreatorVault, ...(ammVault ? [a.ammCreatorVaultAuthority] : [])]) out.push(createAtaIdempotent({ payer: launchWallet, owner, mint: quote.mint, tokenProgram: quote.program }));
  }
  out.push(createFeeSharingConfig({ payer: launchWallet, mint }));
  out.push(updateFeeSharesV2({ authority: launchWallet, mint, currentShareholders: [launchWallet], newShareholders: final, quote }));
  if (amount > 0n) {
    must(cap > 0n, 'A dev buy needs a quote budget.');
    const { feeRecipient, buybackFeeRecipient } = tradeRecipients(global, mint + launchWallet);
    out.push(createAtaIdempotent({ payer: launchWallet, owner: launchWallet, mint }));
    // After create_fee_sharing_config the curve creator is the sharing config, so
    // the buy pays creator fees into the shared vault (distributed to the final shares).
    out.push(buyV2({ amount, maxQuoteIn: cap, mint, user: launchWallet, creator: a.sharingConfig, feeRecipient, buybackFeeRecipient, quote }));
    if (delivery === 'inline') out.push(...deliveryInstructions({ launchWallet, developer, mint, tokens: amount }));
  } else must(cap === 0n, 'A zero dev buy cannot carry a quote budget.');
  const seen = new Set();
  for (const t of transfers) {
    const lamports = big(t.lamports); if (lamports === 0n) continue;
    must(isAddress(t.to) && t.to !== launchWallet && t.to !== mint && !seen.has(t.to), 'Invalid launch funding transfer.'); seen.add(t.to);
    out.push(systemTransfer({ from: launchWallet, to: t.to, lamports }));
  }
  return out;
}
/** Moves the dev-buy tokens from the launch wallet to the developer and closes the launch wallet's token account (its rent returns to the launch wallet). */
export function deliveryInstructions({ launchWallet, developer, mint, tokens }) {
  const amount = big(tokens); must(amount > 0n && isAddress(developer) && isAddress(launchWallet) && developer !== launchWallet, 'Invalid dev-buy delivery.', 'PUMP_CLASSIC_DELIVERY');
  return [createAtaIdempotent({ payer: launchWallet, owner: developer, mint }), transferChecked({ owner: launchWallet, recipient: developer, mint, amount, decimals: TOKEN_DECIMALS }), closeTokenAccount({ owner: launchWallet, mint, destination: launchWallet })];
}
/**
 * The accounts whose simulated post-state proves the launch, in a fixed order
 * (the launch wallet's quote account last for a non-native quote). `holder` is
 * the wallet whose token account receives the dev-buy tokens: the developer, or
 * the launch wallet when they are delivered separately.
 */
export function launchWatchList({ mint, launchWallet, developer, holder = developer, transfers = [], quote: quoteInput = null }) {
  const quote = quoteOf(quoteInput), a = coinAddresses(mint, quote);
  return [launchWallet, associatedTokenAddress(holder, mint, TOKEN_2022_PROGRAM), a.bondingCurve, a.sharingConfig, mint, ...transfers.filter(t => big(t.lamports) > 0n).map(t => t.to), ...(quote.native ? [] : [quoteAta(launchWallet, quote)])];
}
/**
 * Checks the simulated (or finalized) post-state of a launch: the coin exists,
 * the curve creator is the sharing config, the shareholders are exactly the
 * planned ones with the admin revoked, the developer received exactly the
 * quoted tokens, each Launchpad wallet received its exact funding and the launch
 * wallet spent no more than its funded budget.
 */
export function verifyLaunchState({ mint, launchWallet, developer, holder = developer, shareholders, tokens = 0n, transfers = [], before, after, maxDebit, quote: quoteInput = null, creatorFeeBps = 0n, maxQuoteDebit = 0n }) {
  const quote = quoteOf(quoteInput), watch = launchWatchList({ mint, launchWallet, developer, holder, transfers, quote }), a = coinAddresses(mint, quote);
  must(Array.isArray(after) && after.length === watch.length, 'The launch simulation omitted account states.', 'PUMP_CLASSIC_SIMULATION');
  const [walletAfter, devAta, curveRaw, sharingRaw, mintRaw, ...rest] = after, fundedRaw = quote.native ? rest : rest.slice(0, -1);
  const walletBefore = big(before.launchLamports), spent = walletBefore - (walletAfter ? plainAccount(walletAfter).lamports : 0n);
  must(spent >= 0n && spent <= big(maxDebit), 'The launch would spend more than its approved budget.', 'PUMP_CLASSIC_SIMULATION');
  let quoteSpent = 0n;
  if (!quote.native) { const qa = rest.at(-1), quoteAfter = qa ? readTokenAccount(qa, { program: quote.program, mint: quote.mint, owner: launchWallet }).amount : 0n; quoteSpent = big(before.launchQuote ?? 0n) - quoteAfter; must(quoteSpent >= 0n && quoteSpent <= big(maxQuoteDebit), 'The launch would spend more of the quote asset than its dev-buy budget.', 'PUMP_CLASSIC_SIMULATION'); }
  const curve = readBondingCurve(curveRaw, mint, quote);
  // Mayhem, cashback and holder-reward coins divert the creator fee this launch
  // relies on; the curve creator must already be the fee-sharing configuration.
  must(curve.creator === a.sharingConfig && curve.complete === false && curve.is_mayhem_mode === false && curve.is_cashback_coin === false && curve.is_holder_reward === false, 'The created coin does not have the reviewed regular-coin settings.', 'PUMP_CLASSIC_SIMULATION');
  // A creator-chosen fee (custom pairs) must be exactly the reviewed one; without a choice Pump's own default applies.
  if (big(creatorFeeBps) > 0n) must(big(curve.creator_fee_bps) === big(creatorFeeBps), 'The created coin does not carry the reviewed creator fee.', 'PUMP_CLASSIC_SIMULATION');
  const sharing = readSharingConfig(sharingRaw, mint), planned = validShareholders(shareholders);
  must(sharing.status === 'Active' && sharing.admin_revoked === true && sharing.shareholders.length === planned.length && planned.every((s, i) => sharing.shareholders[i].address === s.address && sharing.shareholders[i].shareBps === s.shareBps), 'The fee sharing configuration differs from the reviewed recipients.', 'PUMP_CLASSIC_SIMULATION');
  const minted = readMint(mintRaw, { program: TOKEN_2022_PROGRAM });
  must(minted.initialized && minted.decimals === TOKEN_DECIMALS && minted.freezeAuthority === null, 'The created mint differs from a standard Pump coin.', 'PUMP_CLASSIC_SIMULATION');
  const delivered = devAta ? readTokenAccount(devAta, { program: TOKEN_2022_PROGRAM, mint, owner: holder }).amount : 0n;
  must(delivered === big(tokens), holder === developer ? 'The developer would not receive exactly the quoted dev-buy tokens.' : 'The launch wallet would not hold exactly the quoted dev-buy tokens for delivery.', 'PUMP_CLASSIC_SIMULATION');
  const funded = transfers.filter(t => big(t.lamports) > 0n);
  funded.forEach((t, i) => { const prior = big(before.recipients?.[t.to] ?? 0n), now = fundedRaw[i] ? plainAccount(fundedRaw[i]).lamports : 0n; must(now - prior === big(t.lamports), 'A Launchpad wallet would not receive its exact launch funding.', 'PUMP_CLASSIC_SIMULATION'); });
  return { spentLamports: spent, spentQuote: quoteSpent, tokens: delivered, curveCreator: curve.creator, shareholders: sharing.shareholders, creatorFeeBps: big(curve.creator_fee_bps), creatorFeeEditable: curve.can_edit_creator_fee === true };
}

// --- Finalized transactions ----------------------------------------------------------
/** All account keys of a finalized transaction, including loaded lookup addresses, in balance order. */
export function txKeys(tx) {
  const message = tx?.transaction?.message, keys = message?.staticAccountKeys || message?.accountKeys;
  must(Array.isArray(keys), 'The finalized transaction is missing account keys.', 'PUMP_CLASSIC_RECEIPT');
  const base = keys.map(value => str(value.pubkey || value));
  const all = base.length === tx.meta?.preBalances?.length ? base : [...base, ...(tx.meta?.loadedAddresses?.writable || []).map(str), ...(tx.meta?.loadedAddresses?.readonly || []).map(str)];
  must(all.length === tx.meta?.preBalances?.length && all.length === tx.meta?.postBalances?.length && new Set(all).size === all.length, 'The finalized transaction has incomplete balances.', 'PUMP_CLASSIC_RECEIPT');
  return all;
}
export function lamportDelta(tx, keys, address) { const i = keys.indexOf(address); if (i < 0) return 0n; return big(tx.meta.postBalances[i]) - big(tx.meta.preBalances[i]); }
export function feePayer(tx, keys = txKeys(tx)) { return keys[0]; }
/** Raw token amount held by `account` before/after (0 when absent). */
export function tokenAmount(tx, keys, side, account) {
  const rows = tx.meta?.[side + 'TokenBalances']; must(Array.isArray(rows), 'The finalized transaction omitted token balances.', 'PUMP_CLASSIC_RECEIPT');
  let total = 0n;
  for (const row of rows) { must(Number.isSafeInteger(row.accountIndex) && row.accountIndex >= 0 && row.accountIndex < keys.length, 'Invalid token-balance index.', 'PUMP_CLASSIC_RECEIPT'); if (keys[row.accountIndex] === account) total += big(row.uiTokenAmount?.amount ?? '0'); }
  return total;
}
// Instruction data arrives as base58 text (JSON receipts) or bytes (compiled messages).
const ixData = ix => ix.parsed ? null : typeof ix.data === 'string' ? (ix.data === '' ? Buffer.alloc(0) : base58Decode(ix.data, 16384)) : Buffer.from(ix.data || []);
/** Top-level and inner instructions in execution order: { top, program, accounts, data }. */
export function txInstructions(tx, keys = txKeys(tx)) {
  const message = tx.transaction.message, top = message.compiledInstructions || message.instructions || [], inner = new Map((tx.meta?.innerInstructions || []).map(row => [row.index, row.instructions || []]));
  const out = [];
  const one = (ix, index) => ({ top: index, program: str(ix.programId || keys[ix.programIdIndex]), accounts: (ix.accountKeyIndexes || ix.accounts || []).map(a => typeof a === 'number' ? keys[a] : str(a)), data: ixData(ix) });
  top.forEach((ix, index) => { out.push({ ...one(ix, index), inner: false }); for (const child of inner.get(index) || []) out.push({ ...one(child, index), inner: true }); });
  return out;
}
/** Anchor event-CPI events emitted by `prog` (self-invocations through its event authority). */
export function programEvents(tx, prog, keys = txKeys(tx)) {
  const programId = { pump: PUMP_PROGRAM, pump_amm: PUMP_AMM_PROGRAM, pump_fees: PUMP_FEES_PROGRAM }[prog];
  const authority = { pump: pumpAddresses.eventAuthority, pump_amm: pumpAddresses.ammEventAuthority, pump_fees: pumpAddresses.feesEventAuthority }[prog];
  const out = [];
  txInstructions(tx, keys).forEach((ix, position) => {
    if (!ix.inner || ix.program !== programId || !ix.data || ix.accounts[0] !== authority) return;
    const event = decodeEvent(prog, ix.data); if (event) out.push({ ...event, position, top: ix.top });
  });
  return out;
}
/** The top-level instruction list of a finalized transaction, for exact-plan comparison. */
export function topLevel(tx, keys = txKeys(tx)) { return txInstructions(tx, keys).filter(ix => !ix.inner); }

/**
 * Finalized launch effects: the receipt must be our exact transaction (checked
 * by the caller), succeed, emit the create event for this mint and leave the
 * developer with exactly the quoted tokens.
 */
export function launchReceiptEffects(tx, { mint, launchWallet, developer, holder = developer, tokens = 0n, transfers = [], quote: quoteInput = null, maxQuoteDebit = 0n }) {
  const quote = quoteOf(quoteInput), keys = txKeys(tx), failed = tx.meta.err !== null, fee = big(tx.meta.fee);
  const result = { failed, error: failed ? tx.meta.err : null, slot: tx.slot, feeLamports: fee, launchDelta: lamportDelta(tx, keys, launchWallet), tokens: 0n, transfers: {}, quoteSpent: 0n };
  if (failed) { must(tokenAmount(tx, keys, 'post', associatedTokenAddress(holder, mint, TOKEN_2022_PROGRAM)) === 0n, 'A failed launch moved tokens.', 'PUMP_CLASSIC_RECEIPT'); return result; }
  const created = programEvents(tx, 'pump', keys).find(e => e.name === 'CreateEvent');
  must(created && created.fields.mint === mint && created.fields.user === launchWallet && created.fields.creator === launchWallet && created.fields.is_mayhem_mode === false, 'The finalized launch did not create the reviewed coin.', 'PUMP_CLASSIC_RECEIPT');
  must(quote.native ? [DEFAULT_KEY, NATIVE_MINT].includes(created.fields.quote_mint) : created.fields.quote_mint === quote.mint, 'The finalized launch created the coin on a different quote asset.', 'PUMP_CLASSIC_RECEIPT');
  if (!quote.native) { const qa = quoteAta(launchWallet, quote); result.quoteSpent = tokenAmount(tx, keys, 'pre', qa) - tokenAmount(tx, keys, 'post', qa); must(result.quoteSpent >= 0n && result.quoteSpent <= big(maxQuoteDebit), 'The finalized launch spent more of the quote asset than its dev-buy budget.', 'PUMP_CLASSIC_RECEIPT'); }
  const ata = associatedTokenAddress(holder, mint, TOKEN_2022_PROGRAM), delivered = tokenAmount(tx, keys, 'post', ata) - tokenAmount(tx, keys, 'pre', ata);
  must(delivered === big(tokens), 'The finalized launch delivered a different token amount.', 'PUMP_CLASSIC_RECEIPT');
  result.tokens = delivered;
  for (const t of transfers) if (big(t.lamports) > 0n) { const d = lamportDelta(tx, keys, t.to); must(d === big(t.lamports), 'A Launchpad wallet received a different launch funding amount.', 'PUMP_CLASSIC_RECEIPT'); result.transfers[t.to] = d; }
  const shares = programEvents(tx, 'pump_fees', keys).find(e => e.name === 'UpdateFeeSharesEvent');
  result.shareholders = shares ? shares.fields.new_shareholders.map(s => ({ address: s.address, shareBps: Number(s.share_bps) })) : null;
  return result;
}

/** Finalized effects of a separate dev-buy delivery: exactly `tokens` reached the developer's account. */
export function deliveryEffects(tx, { launchWallet, developer, mint, tokens }) {
  const keys = txKeys(tx), failed = tx.meta.err !== null, fee = big(tx.meta.fee), ata = associatedTokenAddress(developer, mint, TOKEN_2022_PROGRAM);
  const delivered = tokenAmount(tx, keys, 'post', ata) - tokenAmount(tx, keys, 'pre', ata);
  must(keys[0] === launchWallet, 'The finalized delivery has a different payer.', 'PUMP_CLASSIC_RECEIPT');
  if (failed) { must(delivered === 0n, 'A failed delivery moved tokens.', 'PUMP_CLASSIC_RECEIPT'); return { failed, error: tx.meta.err, slot: tx.slot, feeLamports: fee, tokens: 0n }; }
  must(delivered === big(tokens), 'The finalized delivery moved a different token amount.', 'PUMP_CLASSIC_RECEIPT');
  return { failed, error: null, slot: tx.slot, feeLamports: fee, tokens: delivered, launchDelta: lamportDelta(tx, keys, launchWallet) };
}

// --- Fee distribution ----------------------------------------------------------------
/**
 * Every Pump creator-fee distribution in a finalized transaction for `mint`,
 * one leg per shareholder. A leg's amount is the shareholder's actual lamport
 * gain from the distribution: its balance delta, corrected for the network fee
 * when it paid one, and bounded by the program's floor share plus rounding dust.
 * Non-distribution income never appears here.
 */
export function distributionLegs(tx, { mint, quote: quoteInput = null, sharingConfig = coinAddresses(mint, quoteInput).sharingConfig }) {
  const quote = quoteOf(quoteInput), keys = txKeys(tx), none = { legs: [], anomalies: [] }; if (tx.meta.err !== null) return none;
  const events = programEvents(tx, 'pump', keys).filter(e => e.name === 'DistributeCreatorFeesEvent' && e.fields.mint === mint && e.fields.sharing_config === sharingConfig && (quote.native ? (e.fields.quote_mint === NATIVE_MINT || e.fields.quote_mint === DEFAULT_KEY) : e.fields.quote_mint === quote.mint));
  if (!events.length) return none;
  const payer = keys[0], fee = big(tx.meta.fee), legs = [], anomalies = [];
  // Expected legs from every event; observed deltas reconcile them per address.
  const expected = new Map();
  events.forEach((event, eventIndex) => {
    const distributed = big(event.fields.distributed); if (distributed === 0n) return;
    for (const s of event.fields.shareholders) {
      const share = distributed * big(s.share_bps) / 10000n, row = expected.get(s.address) || { floor: 0n, events: [] };
      row.floor += share; row.events.push({ eventIndex, share, distributed, bps: Number(s.share_bps), count: event.fields.shareholders.length }); expected.set(s.address, row);
    }
  });
  for (const [address, row] of expected) {
    // SOL shares are lamport gains (the payer's corrected for its network fee); other quotes are token gains on the shareholder's quote account.
    const observed = quote.native ? lamportDelta(tx, keys, address) + (address === payer ? fee : 0n) : tokenAmount(tx, keys, 'post', quoteAta(address, quote)) - tokenAmount(tx, keys, 'pre', quoteAta(address, quote));
    const dust = BigInt(row.events.reduce((n, e) => n + e.count, 0));
    // The program floors each share and leaves dust in the vault (or hands it to
    // one shareholder); accept the observed gain only within that bound.
    if (observed < row.floor - dust || observed > row.floor + dust) { anomalies.push({ recipient: address, expected: row.floor, observed }); continue; }
    let remaining = observed;
    row.events.forEach((e, i) => { const amount = i === row.events.length - 1 ? remaining : e.share; remaining -= amount; legs.push({ eventIndex: e.eventIndex, recipient: address, amount, distributed: e.distributed, shareBps: e.bps }); });
  }
  return { legs: legs.filter(l => l.amount > 0n), anomalies };
}
/**
 * Pending creator fees: the shared vault above rent (SOL) or its quote token
 * account balance (other quotes), plus the AMM coin-creator vault after graduation.
 */
export function pendingCreatorFees({ vaultLamports = 0n, vaultRentExempt = 0n, ammVaultAmount = 0n, vaultQuoteAmount = null }) {
  const curve = vaultQuoteAmount !== null ? big(vaultQuoteAmount) : big(vaultLamports) > big(vaultRentExempt) ? big(vaultLamports) - big(vaultRentExempt) : 0n;
  return { curve, amm: big(ammVaultAmount), total: curve + big(ammVaultAmount) };
}
export function distributionInstructions({ payer, mint, shareholders, includeAmm = false, quote = null }) {
  const out = [];
  if (includeAmm) out.push(transferCreatorFeesToPumpV2({ payer, mint, quote }));
  out.push(distributeCreatorFeesV2({ payer, mint, shareholders: shareholders.map(s => s.address || s), quote }));
  return out;
}

// --- Graduation --------------------------------------------------------------------------
/** Canonical PumpSwap graduation proof: complete curve plus the canonical pool for this mint, creator authority and fee sharing. */
export function graduationState({ mint, curve, poolRaw, quote: quoteInput = null }) {
  const quote = quoteOf(quoteInput), a = coinAddresses(mint, quote);
  if (!curve.complete) return { venue: 'curve', pool: null };
  if (!poolRaw) return { venue: 'migrating', pool: null };
  const pool = readPool(poolRaw);
  must(pool.base_mint === mint && pool.quote_mint === quote.mint && pool.creator === a.poolAuthority && Number(pool.index) === 0 && pool.lp_mint === a.lpMint && pool.pool_base_token_account === a.poolBaseTokenAccount && pool.pool_quote_token_account === a.poolQuoteTokenAccount, 'The PumpSwap pool is not the canonical pool for this coin.', 'PUMP_CLASSIC_POOL');
  must(pool.coin_creator === a.sharingConfig && pool.is_mayhem_mode === false && pool.is_cashback_coin === false && pool.is_holder_reward === false, 'The canonical pool does not route creator fees to this coin’s fee sharing.', 'PUMP_CLASSIC_POOL');
  return { venue: 'amm', pool: { ...pool, address: a.canonicalPool } };
}

// --- Strategy trades on the bonding curve --------------------------------------------------
/** Plain instructions for a strategy-wallet trade on the curve. Buys spend an exact SOL amount; sells an exact token amount. */
export function curveTradeInstructions({ side, wallet, mint, amount, minimum, global, createTokenAccount = false }) {
  must(['buy', 'sell'].includes(side) && isAddress(wallet) && isOnCurve(wallet), 'Invalid strategy trade.');
  const a = coinAddresses(mint), { feeRecipient, buybackFeeRecipient } = tradeRecipients(global, mint + wallet + side), out = [];
  if (side === 'buy') {
    if (createTokenAccount) out.push(createAtaIdempotent({ payer: wallet, owner: wallet, mint }));
    out.push(buyExactQuoteInV2({ quoteIn: amount, minTokensOut: minimum, mint, user: wallet, creator: a.sharingConfig, feeRecipient, buybackFeeRecipient }));
  } else out.push(sellV2({ amount, minQuoteOut: minimum, mint, user: wallet, creator: a.sharingConfig, feeRecipient, buybackFeeRecipient }));
  return out;
}
/** Conservative curve quote for a strategy trade (all fee components, rounded against us). */
export function curveTradeQuote({ side, amount, curve, global, feeConfig, slippageBps }) {
  const feeBps = curveFeeBps({ global, feeConfig, curve, supply: curve.token_total_supply }), input = big(amount);
  const vQ = big(curve.virtual_quote_reserves), vT = big(curve.virtual_token_reserves), spot = spotPrice(vQ, vT);
  let expected, execution;
  if (side === 'buy') { expected = curveTokensForQuote({ virtualQuote: vQ, virtualToken: vT, realToken: curve.real_token_reserves, quoteIn: input, feeBps }); must(expected > 0n, 'The buy is too small.', 'PUMP_CLASSIC_QUOTE'); execution = input * PRICE_SCALE / expected; }
  else { expected = curveSellOutput({ virtualQuote: vQ, virtualToken: vT, amount: input, feeBps }); must(expected > 0n, 'The sell is too small.', 'PUMP_CLASSIC_QUOTE'); execution = expected * PRICE_SCALE / input; }
  const minimum = expected * BigInt(10000 - slippageBps) / 10000n;
  return { side, input, expected, minimum, feeBps, spot, impactBps: impactBps(spot, execution), venue: 'curve' };
}
/** Conservative canonical-pool quote using effective reserves (vault + signed virtual quote reserves). */
export function ammTradeQuote({ side, amount, baseReserve, quoteVault, virtualQuoteReserves = 0n, globalConfig, feeConfig, supply, slippageBps }) {
  const quoteReserve = effectiveQuoteReserves(quoteVault, virtualQuoteReserves), base = big(baseReserve), input = big(amount);
  const feeBps = ammFeeBps({ globalConfig, feeConfig, baseReserve: base, quoteReserve, supply, canonical: true }), spot = spotPrice(quoteReserve, base);
  let expected, execution;
  if (side === 'buy') { expected = ammBuyOutput({ baseReserve: base, quoteReserve, quoteIn: input, feeBps }); must(expected > 0n, 'The buy is too small.', 'PUMP_CLASSIC_QUOTE'); execution = input * PRICE_SCALE / expected; }
  else { expected = ammSellOutput({ baseReserve: base, quoteReserve, baseIn: input, feeBps }); must(expected > 0n, 'The sell is too small.', 'PUMP_CLASSIC_QUOTE'); execution = expected * PRICE_SCALE / input; }
  const minimum = expected * BigInt(10000 - slippageBps) / 10000n;
  return { side, input, expected, minimum, feeBps, spot, impactBps: impactBps(spot, execution), venue: 'amm' };
}
/** Strategy trade effects from a finalized (or simulated) transaction: exact input spent, at least the minimum received. */
/**
 * Public trades of one coin in a finalized or confirmed transaction: Pump curve
 * TradeEvents and, once graduated, canonical PumpSwap Buy/SellEvents. Amounts
 * are raw (lamports and 6-decimal token units); a failed transaction has none.
 */
export function coinTrades(tx, { mint, pool = null, native = true }) {
  if (!tx?.meta || tx.meta.err !== null) return [];
  const keys = txKeys(tx), rows = [], time = value => { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : null; };
  for (const e of programEvents(tx, 'pump', keys)) {
    if (e.name !== 'TradeEvent' || e.fields.mint !== mint) continue;
    // `lamports` is the quote amount in raw units: SOL for SOL coins, the pair token otherwise.
    const sol = big(e.fields.sol_amount ?? 0), other = big(e.fields.quote_amount ?? 0), lamports = native ? (sol > 0n ? sol : other) : (other > 0n ? other : sol);
    rows.push({ venue: 'curve', side: e.fields.is_buy ? 'buy' : 'sell', wallet: e.fields.user, tokens: big(e.fields.token_amount), lamports, time: time(e.fields.timestamp) });
  }
  if (pool) for (const e of programEvents(tx, 'pump_amm', keys)) {
    if (!['BuyEvent', 'SellEvent'].includes(e.name) || e.fields.pool !== pool) continue;
    const buy = e.name === 'BuyEvent';
    rows.push({ venue: 'amm', side: buy ? 'buy' : 'sell', wallet: e.fields.user, tokens: big(buy ? e.fields.base_amount_out : e.fields.base_amount_in), lamports: big(buy ? e.fields.quote_amount_in : e.fields.quote_amount_out), time: time(e.fields.timestamp) });
  }
  return rows.filter(r => r.tokens > 0n && r.lamports > 0n);
}
export function tradeEffects(tx, { side, wallet, mint, input, minimum }) {
  const keys = txKeys(tx), fee = big(tx.meta.fee), ata = associatedTokenAddress(wallet, mint, TOKEN_2022_PROGRAM);
  const sol = lamportDelta(tx, keys, wallet) + (keys[0] === wallet ? fee : 0n), tokens = tokenAmount(tx, keys, 'post', ata) - tokenAmount(tx, keys, 'pre', ata);
  if (tx.meta.err !== null) { must(tokens === 0n, 'A failed trade moved tokens.', 'PUMP_CLASSIC_RECEIPT'); return { failed: true, solDelta: sol, tokenDelta: 0n, feeLamports: fee }; }
  if (side === 'buy') must(tokens >= big(minimum) && -sol >= 0n && -sol <= big(input) + 5000000n, 'The finalized buy differs from its authorized spend or minimum output.', 'PUMP_CLASSIC_RECEIPT');
  else must(-tokens === big(input) && sol >= big(minimum) - 5000000n, 'The finalized sell differs from its authorized amount or minimum output.', 'PUMP_CLASSIC_RECEIPT');
  return { failed: false, solDelta: sol, tokenDelta: tokens, feeLamports: fee };
}
/**
 * Finalized developer funding for a launch whose dev buy uses another quote
 * asset: one signer (the developer), the intent memo, exactly `lamports` SOL
 * transferred to the launch wallet and exactly `tokenAmount` of the quote asset
 * moved from the developer's quote account into the launch wallet's.
 */
export function quoteFundingEffects(tx, { sender, recipient, lamports, memo, quote: quoteInput, tokenAmount: tokens }) {
  const quote = quoteOf(quoteInput); must(!quote.native, 'SOL funding uses the SOL deposit check.', 'PUMP_CLASSIC_FUNDING');
  if (tx.meta.err !== null) return { state: 'failed', error: tx.meta.err, slot: tx.slot };
  const keys = txKeys(tx), message = tx.transaction.message, required = message.header?.numRequiredSignatures;
  must(keys[0] === sender && required === 1, 'The funding was not signed by the funding wallet alone.', 'PUMP_CLASSIC_FUNDING');
  let memoSeen = false, transferred = 0n;
  for (const ix of txInstructions(tx, keys)) {
    if (ix.program === MEMO_PROGRAM && !ix.inner && ix.data?.toString('utf8') === memo) memoSeen = true;
    if (ix.program !== SYSTEM_PROGRAM || ix.inner || !ix.data || ix.data.length !== 12 || ix.data.readUInt32LE(0) !== 2) continue;
    const [from, to] = ix.accounts; if (to !== recipient) continue;
    must(from === sender, 'The funding mixes transfers from another wallet.', 'PUMP_CLASSIC_FUNDING'); transferred += ix.data.readBigUInt64LE(4);
  }
  must(memoSeen, 'The funding does not carry its launch memo.', 'PUMP_CLASSIC_FUNDING');
  const received = lamportDelta(tx, keys, recipient);
  must(transferred === big(lamports) && received === big(lamports), 'The funding moved a different SOL amount.', 'PUMP_CLASSIC_FUNDING');
  const into = quoteAta(recipient, quote), from = quoteAta(sender, quote);
  const tokensIn = tokenAmount(tx, keys, 'post', into) - tokenAmount(tx, keys, 'pre', into), tokensOut = tokenAmount(tx, keys, 'pre', from) - tokenAmount(tx, keys, 'post', from);
  must(tokensIn === big(tokens) && tokensOut === big(tokens), 'The funding moved a different amount of the quote asset.', 'PUMP_CLASSIC_FUNDING');
  return { state: 'finalized', slot: tx.slot, receivedLamports: received, receivedTokens: tokensIn, feeLamports: big(tx.meta.fee) };
}
/** Decoded first top-level instruction of a given Pump IDL name, for receipt identity checks. */
export function findInstruction(tx, prog, name, keys = txKeys(tx)) {
  const programId = { pump: PUMP_PROGRAM, pump_amm: PUMP_AMM_PROGRAM, pump_fees: PUMP_FEES_PROGRAM }[prog];
  for (const ix of topLevel(tx, keys)) { if (ix.program !== programId || !ix.data) continue; try { return { accounts: ix.accounts, args: decodeInstructionArgs(prog, name, ix.data) }; } catch { /* another instruction */ } }
  return null;
}
export const COMPUTE_BUDGET = COMPUTE_BUDGET_PROGRAM;
