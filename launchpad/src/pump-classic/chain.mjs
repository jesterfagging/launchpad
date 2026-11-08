// Pump.fun Classic chain adapter.
import { heliusEndpoint, programAccountsPaged, wantsPagination } from '../rpc-program-accounts.mjs';
//
// Extends the AI Agent adapter (which already carries the treasury/Gotchi
// operations this feature reuses: verified SOL withdrawals, airdrops, holder
// scans, user-signed deposits and incoming-receipt verification) with native
// Pump creation, fee distribution and strategy trades. The plan and every
// expected effect come from effects.mjs; this file only reads accounts, builds
// web3.js transactions, simulates them against the expected effects and signs.
// Signed bytes are returned to the service, which journals them before any
// broadcast. Nothing here decides money movements on its own.
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, TransactionInstruction } from '@solana/web3.js';
import { unpackMint } from '@solana/spl-token';
import { associatedTokenAccountSize } from '../launchpad-token-account-size.mjs';
import { AgentChain } from '../agent/chain.mjs';
import { LaunchChain, launchSimulationError, ray } from '../launchpad-chain.mjs';
import { treasuryMintInfo } from '../protocol-treasury-chain.mjs';
import { meteoraTokenBadgeAddress, validMeteoraTokenBadge, inspectMeteoraQuoteMint } from '../meteora-quotes.mjs';
import { makeV1Transaction, deserializeTransaction } from '../transactions-v1.mjs';
import { verifySignedTransaction, transactionSize } from '../providers.mjs';
import { pumpAddresses, coinAddresses, quoteOf, quoteAta, computeUnitLimit, computeUnitPrice, systemTransfer, createAtaIdempotent, transferChecked, closeTokenAccount, memo as memoInstruction, PUMP_AMM_PROGRAM } from './instructions.mjs';
import { associatedTokenAddress, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, NATIVE_MINT, SYSTEM_PROGRAM } from './codec.mjs';
import * as fx from './effects.mjs';

const FEE_LIMIT = 200000n;
// Priority fee for transactions Launchpad prepares, in micro-lamports per compute
// unit: the recent 75th percentile for the accounts involved, within these bounds.
const PRIORITY_FLOOR = 100000, PRIORITY_CAP = 2000000, FUNDING_FEE_LIMIT = 500000n;
// Swaps through the treasury route reserve 1.4M compute units, so their price is capped lower (at most 0.0007 SOL of priority).
const SWAP_PRIORITY_CAP = 500000;
const pk = value => new PublicKey(value), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (message, code = 'PUMP_CLASSIC_CHAIN', statusCode = 409) => { throw Object.assign(Error(message), { code, statusCode }); };
const must = (condition, message, code) => { if (!condition) fail(message, code); };
const big = value => typeof value === 'bigint' ? value : BigInt(String(value ?? '0'));
const solAmount = lamports => { const n = big(lamports), whole = n / 1000000000n, frac = (n % 1000000000n).toString().padStart(9, '0').replace(/0+$/, ''); return frac ? `${whole}.${frac}` : String(whole); };
const web3Ix = ix => new TransactionInstruction({ programId: pk(ix.programId), keys: ix.keys.map(k => ({ pubkey: pk(k.pubkey), isSigner: !!k.isSigner, isWritable: !!k.isWritable })), data: Buffer.from(ix.data) });
function snapshot(result, count, minimum = 0) {
  must(Number.isSafeInteger(result?.context?.slot) && result.context.slot >= minimum && Array.isArray(result.value) && result.value.length === count, 'The RPC returned an incomplete snapshot.', 'PUMP_CLASSIC_RPC');
  return result;
}
function keypair(signer, expected) {
  must(typeof signer?.secret === 'string' && signer.secret.length > 0 && signer.address === expected, 'A Launchpad signer is unavailable or does not match its wallet.', 'PUMP_CLASSIC_SIGNER');
  const secret = bs58.decode(signer.secret);
  try { const pair = Keypair.fromSecretKey(secret); must(pair.publicKey.toBase58() === expected, 'A Launchpad signer does not match its wallet.', 'PUMP_CLASSIC_SIGNER'); return { publicKey: pair.publicKey, secretKey: Uint8Array.from(secret) }; }
  finally { secret.fill(0); }
}
const wipe = signers => { for (const s of signers) s?.secretKey?.fill?.(0); };
/**
 * A simulation error for a prepared transaction. A blockhash the simulating node
 * does not know yet (a load-balanced RPC) is lag, retried without counting as a
 * failed launch check; everything else is a real simulation failure.
 */
function simulationFailure(tx, value, stage) {
  if (value?.err === 'BlockhashNotFound' || value?.err?.BlockhashNotFound !== undefined) return Object.assign(Error(`The RPC node has not seen the fresh blockhash for the ${stage} transaction yet. Launchpad retries; nothing was sent.`), { code: 'PUMP_CLASSIC_RPC', retryable: true });
  return launchSimulationError(tx, value, stage);
}
/**
 * A Token-2022 account that requires a memo on incoming transfers (MemoTransfer extension, type 8, enabled): a
 * plain transfer into it fails, so a holder payout skips it. Reads the account's extension list after the
 * 165-byte base layout and its account-type byte.
 */
function requiresMemo(data) {
  const bytes = Buffer.from(data || []); if (bytes.length <= 166) return false;
  for (let offset = 166; offset + 4 <= bytes.length;) {
    const type = bytes.readUInt16LE(offset), length = bytes.readUInt16LE(offset + 2);
    if (type === 0 && length === 0) break;
    if (type === 8 && length >= 1 && offset + 4 < bytes.length) return bytes[offset + 4] === 1;
    offset += 4 + length;
  }
  return false;
}
export { requiresMemo as tokenAccountRequiresMemo };
/** RPC reads for a launch step happen at or after the newest finalized step it depends on (`plan.readySlot`). */
const readyAt = plan => Number.isSafeInteger(plan?.readySlot) && plan.readySlot > 0 ? { minContextSlot: plan.readySlot } : {};
const simAccount = value => value === null || value === undefined ? null : { owner: value.owner, lamports: value.lamports, data: value.data, executable: value.executable };

export class PumpClassicChain extends AgentChain {
  async rentExempt(size) {
    this.rentCache ||= new Map();
    if (!this.rentCache.has(size)) { const value = await this.c.getMinimumBalanceForRentExemption(size, 'finalized'); must(Number.isSafeInteger(value) && value > 0, 'The RPC returned an invalid rent value.', 'PUMP_CLASSIC_RPC'); this.rentCache.set(size, BigInt(value)); }
    return this.rentCache.get(size);
  }
  /**
   * A compute-unit price (micro-lamports) likely to land now: the 75th
   * percentile of the recent per-slot fees for transactions that lock these
   * accounts, kept within [PRIORITY_FLOOR, PRIORITY_CAP]. The floor applies when
   * the RPC cannot say.
   */
  async priorityPrice(accounts = []) {
    let price = PRIORITY_FLOOR;
    try {
      const rows = await this.c.getRecentPrioritizationFees(accounts.length ? { lockedWritableAccounts: accounts.map(pk) } : undefined);
      const fees = (Array.isArray(rows) ? rows : []).map(r => Number(r?.prioritizationFee)).filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
      if (fees.length) price = Math.max(PRIORITY_FLOOR, fees[Math.min(fees.length - 1, Math.floor(fees.length * 0.75))]);
    } catch { /* the floor */ }
    return Math.min(PRIORITY_CAP, Math.round(price));
  }
  /**
   * A funding transaction the creator signs: a fresh (confirmed) blockhash, a
   * priority fee from recent fees and a compute limit sized by simulation, so it
   * lands well within its lifetime. Simulated twice: with a generous limit to
   * measure it, then exactly as it will be signed.
   */
  async userFunding({ sender, plain, walletLamports, input, minContextSlot }) {
    const price = await this.priorityPrice([sender]), block = await this.c.getLatestBlockhash('confirmed');
    must(Number.isSafeInteger(block.lastValidBlockHeight) && block.lastValidBlockHeight >= 151, 'The RPC omitted the funding expiry.', 'PUMP_CLASSIC_RPC');
    const compile = units => new TransactionMessage({ payerKey: pk(sender), recentBlockhash: block.blockhash, instructions: [computeUnitLimit(units), computeUnitPrice(price), ...plain].map(web3Ix) }).compileToV0Message();
    const simulate = async tx => {
      const sim = await this.simulatePrepared(tx, { sigVerify: false, commitment: 'confirmed', minContextSlot }, block.lastValidBlockHeight);
      if (sim.value?.err) {
        // Not enough SOL (for the transfer, the fee or a token account's rent) is named with the amount to add.
        const known = launchSimulationError(tx, sim.value), short = known?.fundingShortfallLamports;
        if (known?.code === 'REWARD_NATIVE_FUNDS') fail(`Your wallet does not hold enough SOL for this funding, its network fee and token-account rent.${short ? ` Add at least ${solAmount(short)} SOL.` : ''} Nothing was sent.`, 'PUMP_CLASSIC_BALANCE');
        fail(`The funding simulation failed: ${JSON.stringify(sim.value.err)}.`, 'PUMP_CLASSIC_SIMULATION');
      }
      return sim;
    };
    const probe = await simulate(new VersionedTransaction(compile(200000))), used = Number(probe.value?.unitsConsumed);
    const message = compile(Number.isFinite(used) && used > 0 ? Math.min(200000, Math.ceil(used * 1.3) + 3000) : 200000);
    must(message.header.numRequiredSignatures === 1 && transactionSize(message) <= 1232, 'The funding transaction is invalid.', 'PUMP_CLASSIC_FUNDING');
    const fee = big((await this.c.getFeeForMessage(message, 'confirmed'))?.value); must(fee > 0n && fee <= FUNDING_FEE_LIMIT, 'The funding network fee exceeds its limit.', 'PUMP_CLASSIC_FEE');
    must(big(walletLamports) >= big(input) + fee, 'Your wallet cannot cover this funding and its network fee.', 'PUMP_CLASSIC_BALANCE');
    const tx = new VersionedTransaction(message), sim = await simulate(tx);
    return { tx, block, fee, preparedSlot: sim.context?.slot ?? minContextSlot };
  }
  /** Unsigned SOL funding for a launch: one transfer from the creator's wallet to the launch wallet, with the launch memo. */
  async prepareSolDeposit({ sender, recipient, lamports: amount, memo }) {
    const input = big(amount);
    must(fx.isAddressLike(sender) && fx.isAddressLike(recipient) && sender !== recipient && input > 0n && typeof memo === 'string' && /^[a-z0-9:_-]{10,80}$/.test(memo), 'Invalid funding request.', 'PUMP_CLASSIC_FUNDING');
    const before = snapshot(await this.c.getMultipleAccountsInfoAndContext([pk(sender), pk(recipient)], { commitment: 'confirmed' }), 2), wallet = fx.plainAccount(before.value[0]);
    must(wallet && !wallet.executable && wallet.owner === SYSTEM_PROGRAM, 'The funding wallet must be an ordinary SOL wallet.', 'PUMP_CLASSIC_FUNDING');
    const { tx, block, preparedSlot } = await this.userFunding({ sender, plain: [systemTransfer({ from: sender, to: recipient, lamports: input }), memoInstruction(memo)], walletLamports: wallet.lamports, input, minContextSlot: before.context.slot });
    const bytes = Buffer.from(tx.serialize());
    return { kind: 'deposit', needsSignature: true, state: 'awaiting_signature', externalSigner: sender, recipient, mint: NATIVE_MINT, inputAmount: input.toString(), memo, unsignedRaw: bytes.toString('base64'), messageHash: sha(Buffer.from(tx.message.serialize())), blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight, preparedSlot, createdAt: this.now() };
  }
  /** Live Pump global, fee configs, PumpSwap configs and the quote-control list, owner-checked. */
  // ---- Program-account scans: raw program accounts and a curve's token-account mints; the caller decodes.
  /**
   * Filtered program accounts as [{pubkey, data}]. Helius refuses getProgramAccounts on the Pump programs (tens of
   * millions of accounts) and asks for getProgramAccountsV2 with pagination, so that is used there; any other RPC
   * gets the plain call, with the same paginated fallback when it answers with that refusal.
   */
  // Filtered program accounts. A plain read where the provider allows it; Helius (or any provider that refuses the
  // plain read) is paged with getProgramAccountsV2, where `changedSinceSlot` makes a later read incremental and the
  // rows carry `.contextSlot` (the slot of the read, the next cursor). A plain read has no slot cursor.
  async programAccounts(program, filters, { changedSinceSlot = null, onPage = null, signal = null } = {}) {
    const key = pk(program), config = { commitment: 'confirmed', encoding: 'base64', filters };
    if (!heliusEndpoint(this.c)) {
      try { const rows = await this.c.getProgramAccounts(key, config); return Object.assign(rows.map(row => ({ pubkey: row.pubkey.toBase58(), data: Buffer.from(row.account.data) })), { contextSlot: null }); }
      catch (error) { if (!wantsPagination(error)) throw error; }
    }
    return programAccountsPaged(this.c, key.toBase58(), config, { changedSinceSlot, onPage, signal });
  }
  async tokenAccountMints(owner, program) {
    const r = await this.c.getParsedTokenAccountsByOwner(pk(owner), { programId: pk(program) }, 'confirmed');
    return (r?.value || []).map(row => row.account?.data?.parsed?.info?.mint).filter(m => typeof m === 'string');
  }
  async readGlobals({ minContextSlot } = {}) {
    const a = pumpAddresses, keys = [a.global, a.feeConfig, a.ammGlobalConfig, a.ammFeeConfig, a.quoteControl];
    const r = snapshot(await this.c.getMultipleAccountsInfoAndContext(keys.map(pk), { commitment: 'finalized', ...(minContextSlot ? { minContextSlot } : {}) }), keys.length, minContextSlot || 0);
    return { slot: r.context.slot, global: fx.readGlobal(r.value[0]), feeConfig: fx.readFeeConfig(r.value[1], 'pump'), ammGlobalConfig: r.value[2] ? fx.readAmmGlobalConfig(r.value[2]) : null, ammFeeConfig: fx.readFeeConfig(r.value[3], 'pump_amm'), quoteControl: fx.readQuoteControl(r.value[4]) };
  }
  /**
   * Every quote asset a new coin may pair with right now (SOL, Pump's listed
   * quote and the custom pairs), each with its token program, decimals and
   * whether Launchpad can handle it exactly, plus Pump's live custom creator-fee rule.
   */
  async pumpQuotes() {
    const g = await this.readGlobals(), list = fx.pumpQuotes({ global: g.global, quoteControl: g.quoteControl }), others = list.filter(q => q.kind !== 'sol'), infos = [];
    for (let i = 0; i < others.length; i += 100) {
      const chunk = others.slice(i, i + 100), r = snapshot(await this.c.getMultipleAccountsInfoAndContext(chunk.map(q => pk(q.mint)), { commitment: 'finalized', minContextSlot: g.slot }), chunk.length, g.slot);
      infos.push(...r.value);
    }
    const quotes = list.map(q => q.kind === 'sol' ? { ...q, program: TOKEN_PROGRAM, decimals: 9, supported: true, convertible: true } : { ...q, ...fx.quoteMintSupport(infos[others.indexOf(q)]) });
    // Pump coins this host offers as quotes (Pump's public docs, CREATE_WITH_PUMP_COIN_QUOTE.md): their live entry, or the reason they cannot be one right now.
    for (const mint of this.pumpCoinQuoteMints()) {
      if (quotes.some(q => q.mint === mint)) continue;
      try { const entry = await this.pumpCoinQuote(g, mint); quotes.push({ ...entry, ...entry.support }); }
      catch (error) { quotes.push({ mint, kind: 'custom', quoteControl: true, pumpCoin: null, initialVirtualQuoteReserves: 0n, supported: false, reason: String(error?.message || 'This pump coin cannot be a quote right now.') }); }
    }
    const convert = await this.conversionSupport(quotes.filter(q => q.kind !== 'sol' && q.supported).map(q => q.mint));
    for (const q of quotes) if (q.kind !== 'sol') q.convertible = q.supported === true && convert.get(q.mint) === true;
    return { slot: g.slot, quotes, solReserves: big(g.global.initial_virtual_sol_reserves), creatorFee: this.creatorFeeRule(g) };
  }
  creatorFeeRule(g) { return { configurable: g.global.creator_fee_configurable === true, maxBps: Number(big(g.global.max_configurable_creator_fee_bps)) }; }
  /**
   * Fresh read of one quote asset for a new launch: Pump's live entry (it must
   * still admit the mint), the mint's program, decimals and support, Pump's SOL
   * curve reserves (for scaling SOL limits) and the custom creator-fee rule.
   */
  async quoteAsset(quoteMint = NATIVE_MINT) {
    const g = await this.readGlobals(), entry = await this.resolveQuote(g, quoteMint), base = { ...entry, solReserves: big(g.global.initial_virtual_sol_reserves), creatorFee: this.creatorFeeRule(g), slot: g.slot };
    if (entry.kind === 'sol') return { ...base, program: TOKEN_PROGRAM, decimals: 9, supported: true, metadata: null };
    const r = snapshot(await this.c.getMultipleAccountsInfoAndContext([pk(quoteMint)], { commitment: 'finalized', minContextSlot: g.slot }), 1, g.slot);
    return { ...base, ...fx.quoteMintSupport(r.value[0]) };
  }
  /**
   * Whether the treasury conversion route accepts each mint (its exact mint
   * rule: plain mints, or issuer-controlled Token-2022 mints registered with
   * Raydium or Meteora). Read-only; a route can still be missing at conversion
   * time, which the conversion itself reports. Map(mint → boolean).
   */
  async conversionSupport(mints) {
    const out = new Map(), program = this.ids?.CREATE_CPMM_POOL_PROGRAM; if (!mints.length) return out;
    if (!program) { for (const mint of mints) out.set(mint, false); return out; }
    const rows = mints.map(mint => { const key = pk(mint), support = ray.getPdaMintExAccountCp(program, key); return { mint, key, support, badge: meteoraTokenBadgeAddress(key) }; });
    let epoch = null;
    for (let i = 0; i < rows.length; i += 33) {
      const chunk = rows.slice(i, i + 33), r = snapshot(await this.c.getMultipleAccountsInfoAndContext(chunk.flatMap(x => [x.key, x.support.publicKey, x.badge]), { commitment: 'finalized' }), chunk.length * 3);
      for (const [j, x] of chunk.entries()) {
        const [mintInfo, supportInfo, badgeInfo] = r.value.slice(j * 3, j * 3 + 3);
        try { treasuryMintInfo(x.key, mintInfo, supportInfo, program, x.support.nonce, { official: false }); out.set(x.mint, true); continue; }
        catch (error) { if (error?.message !== 'The treasury mint has unsupported extensions.') { out.set(x.mint, false); continue; } }
        try {
          if (!validMeteoraTokenBadge(x.key, badgeInfo)) { out.set(x.mint, false); continue; }
          if (epoch === null) { const e = await this.c.getEpochInfo({ commitment: 'finalized' }); epoch = Number.isSafeInteger(e?.epoch) ? e.epoch : -1; }
          const inspected = epoch >= 0 ? inspectMeteoraQuoteMint(x.key, mintInfo, { epoch, tokenBadge: badgeInfo }) : null;
          if (inspected?.supported !== true) { out.set(x.mint, false); continue; }
          treasuryMintInfo(x.key, mintInfo, null, program, x.support.nonce, { meteoraRegistered: true }); out.set(x.mint, true);
        } catch { out.set(x.mint, false); }
      }
    }
    return out;
  }
  /** The live entry for one listed quote asset (fails when Pump no longer lists it). */
  quoteEntry(g, quoteMint = NATIVE_MINT) {
    const entry = fx.pumpQuotes({ global: g.global, quoteControl: g.quoteControl }).find(q => q.mint === quoteMint);
    must(entry, 'Pump.fun no longer accepts this quote asset for new coins.', 'PUMP_CLASSIC_QUOTE_ASSET'); return entry;
  }
  /** The pump coins this host admits as quotes beyond Pump's lists (set by the host). */
  pumpCoinQuoteMints() { return Array.isArray(this.pumpCoinQuotes) ? this.pumpCoinQuotes.filter(fx.isAddressLike) : []; }
  /** The live entry for a quote: Pump's listed quotes first, then the pump coins this host admits as quotes. */
  async resolveQuote(g, quoteMint = NATIVE_MINT) {
    const listed = fx.pumpQuotes({ global: g.global, quoteControl: g.quoteControl }).find(q => q.mint === quoteMint);
    if (listed) return listed;
    must(this.pumpCoinQuoteMints().includes(quoteMint), 'Pump.fun no longer accepts this quote asset for new coins.', 'PUMP_CLASSIC_QUOTE_ASSET');
    return this.pumpCoinQuote(g, quoteMint);
  }
  /**
   * A pump coin Q as a quote (Pump's public docs, CREATE_WITH_PUMP_COIN_QUOTE.md): Q's own curve and, once migrated,
   * its PumpSwap pool and vaults; the same for each pump coin below Q down to a listed quote; and the starting reserves
   * Pump computes from that chain's live state (fx.pumpCoinQuoteReserves). `kind` is 'custom' because Pump treats the
   * pair like any custom pair (creator fee, dev buy in the quote); `pumpCoin` carries the extra creation accounts.
   */
  async pumpCoinQuote(g, quoteMint, { depth = 0, seen = new Set() } = {}) {
    must(fx.isAddressLike(quoteMint) && quoteMint !== NATIVE_MINT && !seen.has(quoteMint) && depth <= 5, 'The quote coin chain is invalid.', 'PUMP_CLASSIC_QUOTE_ASSET'); seen.add(quoteMint);
    const own = coinAddresses(quoteMint), read = async keys => snapshot(await this.c.getMultipleAccountsInfoAndContext(keys.map(pk), { commitment: 'finalized', minContextSlot: g.slot }), keys.length, g.slot).value;
    const [mintRaw, curveRaw] = await read([quoteMint, own.bondingCurve]);
    must(curveRaw, 'This quote asset is not a Pump.fun coin.', 'PUMP_CLASSIC_QUOTE_ASSET');
    const support = fx.quoteMintSupport(mintRaw), curve = fx.readAnyBondingCurve(curveRaw, quoteMint);
    must(support.supported, support.reason || 'Launchpad cannot handle this quote mint.', 'PUMP_CLASSIC_QUOTE_ASSET');
    must(!curve.is_mayhem_mode, 'A mayhem-mode coin cannot be a quote.', 'PUMP_CLASSIC_QUOTE_ASSET');
    // Below Q: SOL or a listed quote (the chain ends there), or another pump coin (one more group).
    const listed = fx.pumpQuotes({ global: g.global, quoteControl: g.quoteControl });
    let below = null, bottom, lower;
    if (curve.quoteMint === null) { bottom = { mint: NATIVE_MINT, reserves: listed[0].initialVirtualQuoteReserves }; lower = { mint: NATIVE_MINT, program: TOKEN_PROGRAM }; }
    else {
      const entry = listed.find(q => q.mint === curve.quoteMint);
      if (entry) { const [lowerMint] = await read([entry.mint]), lowerSupport = fx.quoteMintSupport(lowerMint); must(lowerSupport.supported, 'The quote coin’s own pair cannot be read.', 'PUMP_CLASSIC_QUOTE_ASSET'); bottom = { mint: entry.mint, reserves: entry.initialVirtualQuoteReserves }; lower = { mint: entry.mint, program: lowerSupport.program }; }
      else { below = await this.pumpCoinQuote(g, curve.quoteMint, { depth: depth + 1, seen }); bottom = below.bottom; lower = { mint: curve.quoteMint, program: below.support.program }; }
    }
    const a = coinAddresses(quoteMint, lower);
    let group;
    if (curve.complete) {
      const [poolRaw, baseRaw, quoteRaw] = await read([a.canonicalPool, a.poolBaseTokenAccount, a.poolQuoteTokenAccount]);
      must(poolRaw, 'The quote coin has completed its curve but has no pool yet. Try again after it migrates.', 'PUMP_CLASSIC_QUOTE_ASSET');
      const pool = fx.readPool(poolRaw); must(pool.base_mint === quoteMint && pool.quote_mint === lower.mint, 'The quote coin’s pool does not match its pair.', 'PUMP_CLASSIC_QUOTE_ASSET');
      const base = fx.readTokenAccount(baseRaw, { mint: quoteMint, owner: a.canonicalPool }), quoteVault = fx.readTokenAccount(quoteRaw, { mint: lower.mint, owner: a.canonicalPool });
      must(base && quoteVault, 'The quote coin’s pool vaults are missing.', 'PUMP_CLASSIC_QUOTE_ASSET');
      group = { mint: quoteMint, curve: own.bondingCurve, pool: { address: a.canonicalPool, base: a.poolBaseTokenAccount, quote: a.poolQuoteTokenAccount, baseAmount: base.amount, quoteAmount: quoteVault.amount } };
    } else {
      const [balanceRaw] = await read([own.associatedBondingCurve]), balance = fx.readTokenAccount(balanceRaw, { mint: quoteMint, owner: own.bondingCurve });
      must(balance, 'The quote coin’s curve token account is missing.', 'PUMP_CLASSIC_QUOTE_ASSET');
      group = { mint: quoteMint, curve: own.bondingCurve, pool: null, curveState: curve, curveBaseBalance: balance.amount, migrationFee: curve.quoteMint === null ? big(g.global.pool_migration_fee) : 0n };
    }
    const chainBelow = below ? [below.group, ...below.chainBelow] : [];
    const forMath = [...chainBelow].reverse().concat(group).map(x => x.pool ? { pool: { baseAmount: x.pool.baseAmount, quoteAmount: x.pool.quoteAmount } } : { curve: x.curveState, curveBaseBalance: x.curveBaseBalance, migrationFee: x.migrationFee });
    const initialVirtualQuoteReserves = fx.pumpCoinQuoteReserves({ global: g.global, bottomReserves: bottom.reserves, chain: forMath });
    const accounts = x => ({ curve: x.curve, pool: x.pool ? { address: x.pool.address, base: x.pool.base, quote: x.pool.quote } : null });
    return { mint: quoteMint, kind: 'custom', quoteControl: true, initialVirtualQuoteReserves, support, bottom, group, chainBelow, depth: below ? below.depth + 1 : 0,
      pumpCoin: { depth: below ? below.depth + 1 : 0, ...accounts(group), chain: chainBelow.map(accounts) } };
  }
  async quoteLaunch({ devBuyLamports, devBuyRaw = devBuyLamports, quoteMint = NATIVE_MINT, creatorFeeBps = 0n } = {}) {
    const g = await this.readGlobals(), entry = await this.resolveQuote(g, quoteMint);
    if (big(creatorFeeBps) > 0n) must(entry.kind === 'custom' && g.global.creator_fee_configurable === true && big(creatorFeeBps) <= big(g.global.max_configurable_creator_fee_bps), 'Pump.fun does not accept this creator fee for this pair right now.', 'PUMP_CLASSIC_CREATOR_FEE');
    return { ...fx.launchQuote({ global: g.global, feeConfig: g.feeConfig, devBuyRaw, quote: entry, creatorFeeBps }), slot: g.slot, entry, initialCurve: fx.initialCurve(g.global, entry), solReserves: big(g.global.initial_virtual_sol_reserves), creatorFee: this.creatorFeeRule(g) };
  }
  /** Coin state: curve, sharing, vault balances and verified graduation, for the coin's quote asset. */
  async readCoin(mint, { commitment = 'finalized', minContextSlot, quote: quoteInput = null } = {}) {
    const quote = quoteOf(quoteInput), a = coinAddresses(mint, quote), keys = [mint, a.bondingCurve, a.sharingConfig, a.sharedCreatorVault, a.canonicalPool, a.ammCreatorVaultAta, a.poolBaseTokenAccount, a.poolQuoteTokenAccount, ...(quote.native ? [] : [a.sharedCreatorVaultQuoteAta])];
    const r = snapshot(await this.c.getMultipleAccountsInfoAndContext(keys.map(pk), { commitment, ...(minContextSlot ? { minContextSlot } : {}) }), keys.length, minContextSlot || 0);
    if (!r.value[1]) return { exists: false, slot: r.context.slot, mintExists: !!r.value[0] };
    const curve = fx.readBondingCurve(r.value[1], mint, quote), sharing = r.value[2] ? fx.readSharingConfig(r.value[2], mint) : null, mintState = fx.readMint(r.value[0], { program: TOKEN_2022_PROGRAM });
    const graduation = fx.graduationState({ mint, curve, poolRaw: r.value[4], quote });
    const vaultLamports = r.value[3] ? fx.plainAccount(r.value[3]).lamports : 0n, rent = await this.rentExempt(0);
    const vaultQuoteAmount = quote.native ? null : r.value[8] ? fx.readTokenAccount(r.value[8], { program: quote.program, mint: quote.mint, owner: a.sharedCreatorVault }).amount : 0n;
    let ammVault = 0n, poolBase = 0n, poolQuote = 0n;
    if (graduation.venue === 'amm') {
      ammVault = r.value[5] ? fx.readTokenAccount(r.value[5], { program: quote.program, mint: quote.mint, owner: a.ammCreatorVaultAuthority }).amount : 0n;
      poolBase = fx.readTokenAccount(r.value[6], { program: TOKEN_2022_PROGRAM, mint, owner: a.canonicalPool }).amount;
      poolQuote = fx.readTokenAccount(r.value[7], { program: quote.program, mint: quote.mint, owner: a.canonicalPool }).amount;
    }
    return { exists: true, slot: r.context.slot, quote, mint: mintState, curve, sharing, graduation, venue: graduation.venue, pool: graduation.pool, poolBase, poolQuote, fees: fx.pendingCreatorFees({ vaultLamports, vaultRentExempt: rent, ammVaultAmount: ammVault, vaultQuoteAmount }) };
  }
  /**
   * Public market snapshot in the discovery shape (src/launchpad-explore.mjs
   * safeSnapshot): SOL price per whole token and curve progress while on the
   * curve; graduated coins report status only (pool pricing comes from DEX data).
   */
  /** USD per whole unit of a quote asset (raw units ÷ 10^decimals), cached for a minute. */
  async quoteUsd(mint) {
    if (mint === NATIVE_MINT) return this.solUsd();
    this.quoteUsdCache ||= new Map(); const hit = this.quoteUsdCache.get(mint);
    if (hit && this.now() - hit.readAt < 60000) return hit.value;
    const info = await this.mintInfo(mint), ref = await this.referencePrice({ quoteMint: mint }, info), usd = Number(ref?.usd), at = Number(ref?.at);
    must(Number.isFinite(usd) && usd > 0 && usd < 1e9 && Number.isSafeInteger(at) && at > 0, 'A fresh quote-asset price is unavailable.', 'PUMP_CLASSIC_PRICE');
    const value = { usd, at }; this.quoteUsdCache.set(mint, { readAt: this.now(), value }); return value;
  }
  /**
   * Public market snapshot in the discovery shape (src/launchpad-explore.mjs
   * safeSnapshot), priced in the coin's quote asset: price per whole token and
   * curve progress while on the curve; graduated coins report status only.
   * `quote` is { mint, program, symbol, decimals, initialVirtualQuoteReserves } from the launch record.
   */
  async marketSnapshot(mint, { quote: quoteInput = null } = {}) {
    const quote = quoteOf(quoteInput), symbol = quote.native ? 'SOL' : String(quoteInput?.symbol || ''), quoteDecimals = quote.native ? 9 : Number(quoteInput?.decimals);
    must(Number.isSafeInteger(quoteDecimals) && quoteDecimals >= 0 && quoteDecimals <= 12, 'Invalid quote decimals.', 'PUMP_CLASSIC_QUOTE_ASSET');
    const g = await this.readGlobals(), coin = await this.readCoin(mint, { commitment: 'confirmed', quote }); if (!coin.exists) return null;
    const a = coinAddresses(mint, quote), unit = 10 ** quoteDecimals, decimals = 10 ** coin.mint.decimals, supply = Number(coin.mint.supply) / decimals;
    // Quote raised when a curve with the coin's initial parameters completes.
    const init = quote.native ? fx.initialCurve(g.global) : big(quoteInput?.initialVirtualQuoteReserves ?? 0n) > 0n ? fx.initialCurve(g.global, { kind: 'custom', initialVirtualQuoteReserves: quoteInput.initialVirtualQuoteReserves }) : null;
    const target = init ? init.virtual_quote_reserves * init.virtual_token_reserves / (init.virtual_token_reserves - init.real_token_reserves) - init.virtual_quote_reserves : null;
    const status = coin.venue === 'amm' ? 'migrated' : coin.venue === 'migrating' || coin.curve.complete ? 'migrating' : 'curve';
    const initialReal = big(g.global.initial_real_token_reserves);
    let priceQuote = null, progress = 100, raised = target === null ? null : Number(target) / unit;
    if (status === 'curve') {
      const vq = big(coin.curve.virtual_quote_reserves), vt = big(coin.curve.virtual_token_reserves), real = big(coin.curve.real_token_reserves);
      must(vq > 0n && vt > 0n, 'The bonding curve reserves are invalid.', 'PUMP_CLASSIC_CURVE');
      priceQuote = (Number(vq) / unit) / (Number(vt) / decimals);
      raised = Number(big(coin.curve.real_quote_reserves)) / unit;
      progress = initialReal > 0n ? Math.max(0, Math.min(100, Number(initialReal - (real < initialReal ? real : initialReal)) * 100 / Number(initialReal))) : 0;
    }
    let ref = { mint: quote.mint, symbol, usd: null, at: null, stale: true };
    try { const value = await this.quoteUsd(quote.mint); ref = { mint: quote.mint, symbol, usd: value.usd, at: value.at, stale: false }; } catch { /* price stays unavailable; status and progress remain */ }
    const usd = ref.stale ? null : ref.usd;
    return { mint, curve: a.bondingCurve, poolId: coin.venue === 'amm' ? a.canonicalPool : null, status, slot: coin.slot, at: this.now(), supply, priceQuote, fdvQuote: priceQuote === null ? null : priceQuote * supply,
      priceUsd: priceQuote === null || usd === null ? null : priceQuote * usd, fdvUsd: priceQuote === null || usd === null ? null : priceQuote * supply * usd, quote: ref, raisedQuote: raised, targetQuote: target === null ? null : Number(target) / unit, progressPercent: progress };
  }
  /** The most recent public trades of a coin (curve, then canonical pool), newest first. Amounts are raw quote units. Bounded and best effort. */
  async recentTrades(mint, { limit = 15, quote: quoteInput = null } = {}) {
    const quote = quoteOf(quoteInput), a = coinAddresses(mint, quote), coin = await this.readCoin(mint, { commitment: 'confirmed', quote }); if (!coin.exists) return [];
    const pool = coin.venue === 'amm' ? a.canonicalPool : null, rows = await this.c.getSignaturesForAddress(pk(pool || a.bondingCurve), { limit: Math.max(1, Math.min(25, limit)) }, 'confirmed');
    must(Array.isArray(rows), 'The RPC returned an invalid signature list.', 'PUMP_CLASSIC_RPC');
    const out = [];
    for (const row of rows) {
      if (row?.err || typeof row?.signature !== 'string') continue;
      let tx; try { tx = await this.c.getTransaction(row.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 1 }); } catch { continue; }
      if (!tx) continue;
      try { for (const t of fx.coinTrades(tx, { mint, pool, native: quote.native })) out.push({ ...t, signature: row.signature, slot: tx.slot, time: t.time || tx.blockTime || row.blockTime || null }); } catch { /* an undecodable event is skipped, never guessed */ }
    }
    return out;
  }
  /**
   * Holder payouts in a pair asset (v71.24): for each recipient, whether a usable token account for the asset
   * exists ('ready'), is missing (the payout creates it: 'missing') or cannot receive ('unusable', for example
   * frozen by its issuer), plus the rent a new account costs. Finalized reads, at most 100 accounts per request.
   */
  async payoutAccounts({ owners, quote: quoteInput }) {
    const quote = quoteOf(quoteInput); must(!quote.native, 'SOL payouts need no token accounts.', 'PUMP_CLASSIC_QUOTE_ASSET');
    must(Array.isArray(owners) && owners.length <= 1000, 'Too many payout recipients.', 'PUMP_CLASSIC_PAYOUT');
    const mintKey = pk(quote.mint), mintInfo = await this.c.getAccountInfo(mintKey, 'finalized');
    must(mintInfo && mintInfo.owner.toBase58() === quote.program, 'The pair asset mint is unavailable.', 'PUMP_CLASSIC_QUOTE_ASSET');
    const size = associatedTokenAccountSize({ mint: unpackMint(mintKey, mintInfo, mintInfo.owner), program: mintInfo.owner });
    const rent = await this.c.getMinimumBalanceForRentExemption(size, 'finalized'); must(Number.isSafeInteger(rent) && rent > 0, 'The token account rent is unavailable.', 'PUMP_CLASSIC_RPC');
    const accounts = {}; let slot = 0;
    for (let i = 0; i < owners.length; i += 100) {
      const chunk = owners.slice(i, i + 100), keys = chunk.map(owner => quoteAta(owner, quote));
      const r = snapshot(await this.c.getMultipleAccountsInfoAndContext(keys.map(pk), { commitment: 'finalized' }), keys.length);
      slot = Math.max(slot, r.context.slot);
      chunk.forEach((owner, n) => {
        if (!r.value[n]) { accounts[owner] = 'missing'; return; }
        try { fx.readTokenAccount(r.value[n], { program: quote.program, mint: quote.mint, owner }); accounts[owner] = requiresMemo(r.value[n].data) ? 'unusable' : 'ready'; } catch { accounts[owner] = 'unusable'; }
      });
    }
    return { slot, rentLamports: BigInt(rent), accounts };
  }
  async walletBalances(addresses, { commitment = 'finalized' } = {}) {
    const r = snapshot(await this.c.getMultipleAccountsInfoAndContext(addresses.map(pk), { commitment }), addresses.length);
    return { slot: r.context.slot, balances: Object.fromEntries(addresses.map((address, i) => [address, fx.walletLamports(r.value[i])])) };
  }
  /** Quote-asset balances of wallets (their associated quote accounts; 0 when absent). */
  async quoteBalances(addresses, quoteInput, { commitment = 'finalized', minContextSlot = 0 } = {}) {
    const quote = quoteOf(quoteInput); must(!quote.native, 'SOL balances use walletBalances.', 'PUMP_CLASSIC_QUOTE_ASSET');
    const accounts = addresses.map(owner => quoteAta(owner, quote)), r = snapshot(await this.c.getMultipleAccountsInfoAndContext(accounts.map(pk), { commitment, ...(minContextSlot > 0 ? { minContextSlot } : {}) }), accounts.length, minContextSlot > 0 ? minContextSlot : 0);
    return { slot: r.context.slot, balances: Object.fromEntries(addresses.map((owner, i) => [owner, r.value[i] ? fx.readTokenAccount(r.value[i], { program: quote.program, mint: quote.mint, owner }).amount : 0n])) };
  }

  // --- launch -------------------------------------------------------------------------
  /**
   * Builds, simulates and signs the atomic launch. `plan` is the immutable
   * launch record (wallets, metadata URI, shareholders, quoted tokens,
   * transfers, funded amount). Returns the signed operation; never broadcasts.
   */
  async prepareLaunch({ plan, signers, tolerancePpm = 10000, computeUnits = 700000, priorityLamports = 14000n, priorityMicroLamports = null }) {
    const { mint, launchWallet, developer, name, symbol, uri, shareholders, transfers } = plan, quoted = big(plan.tokens), devBuy = big(plan.devBuyRaw ?? plan.devBuyLamports);
    // Layout (see fx.launchInstructions): pair accounts from the setup transaction, and dev-buy tokens held by the launch wallet for a separate delivery.
    const pairAccounts = plan.pairAccounts === 'ready' ? 'ready' : 'create', delivery = plan.delivery === 'separate' ? 'separate' : 'inline', holder = delivery === 'separate' ? launchWallet : developer;
    const quote = quoteOf(plan.quote), creatorFeeBps = big(plan.creatorFeeBps ?? 0n);
    // Read at or after the newest finalized step creation depends on (funding, pair purchase, setup).
    const g = await this.readGlobals(readyAt(plan)), entry = await this.resolveQuote(g, quote.mint);
    must(quote.native || (entry.kind !== 'sol' && entry.quoteControl === !!plan.quote?.quoteControl), 'Pump.fun changed how this quote asset is admitted. The launch will be refunded.', 'PUMP_CLASSIC_QUOTE_ASSET');
    if (creatorFeeBps > 0n) must(entry.kind === 'custom' && g.global.creator_fee_configurable === true && creatorFeeBps <= big(g.global.max_configurable_creator_fee_bps), 'Pump.fun no longer accepts the reviewed creator fee. The launch will be refunded.', 'PUMP_CLASSIC_CREATOR_FEE');
    const fresh = fx.launchQuote({ global: g.global, feeConfig: g.feeConfig, devBuyRaw: devBuy, quote: entry, creatorFeeBps });
    // A fresh curve depends only on Pump's global parameters. If they moved, buy
    // the smaller of the fresh and quoted amounts, but never less than the floor.
    // A pump-coin quote's starting reserves follow the quote coin's live price, so the floor is wider there (10%).
    const floor = quoted - quoted * BigInt(entry.pumpCoin ? Math.max(tolerancePpm, 100000) : tolerancePpm) / 1000000n;
    must(fresh.tokens >= floor, 'Pump’s launch parameters changed since your quote. The launch will be refunded instead of buying fewer tokens.', 'PUMP_CLASSIC_QUOTE_MOVED');
    // `buyAll` (a SOL-paid pair dev buy): spend everything the purchase delivered; the reviewed amount is the floor.
    const tokens = plan.buyAll === true ? fresh.tokens : fresh.tokens < quoted ? fresh.tokens : quoted;
    const watched = [launchWallet, ...transfers.filter(t => big(t.lamports) > 0n).map(t => t.to)], launchQuoteAta = quote.native ? null : quoteAta(launchWallet, quote);
    const before = snapshot(await this.c.getMultipleAccountsInfoAndContext([...watched, ...(launchQuoteAta ? [launchQuoteAta] : []), mint, coinAddresses(mint, quote).bondingCurve].map(pk), { commitment: 'finalized', minContextSlot: g.slot }), watched.length + (launchQuoteAta ? 3 : 2), g.slot);
    must(!before.value.at(-1) && !before.value.at(-2), 'This coin already exists onchain. Reconcile the saved launch instead of creating it again.', 'PUMP_CLASSIC_EXISTS');
    const launchLamports = fx.walletLamports(before.value[0]), recipients = Object.fromEntries(watched.slice(1).map((address, i) => [address, fx.walletLamports(before.value[i + 1])]));
    must(launchLamports >= big(plan.fundedLamports), 'The launch wallet holds less than its verified funding.', 'PUMP_CLASSIC_FUNDING');
    const quoteRaw = launchQuoteAta ? before.value[watched.length] : null, launchQuote = quoteRaw ? fx.readTokenAccount(quoteRaw, { program: quote.program, mint: quote.mint, owner: launchWallet }).amount : 0n;
    if (launchQuoteAta) must(launchQuote >= big(plan.fundedQuoteRaw ?? 0n) && launchQuote >= (tokens > 0n ? devBuy : 0n), 'The launch wallet holds less of the quote asset than its verified funding.', 'PUMP_CLASSIC_FUNDING');
    const launchPlan = { mint, launchWallet, developer, name, symbol, uri, shareholders, tokens, maxSolCost: tokens > 0n ? devBuy : 0n, global: g.global, transfers, quote, quoteControl: entry.quoteControl === true, pumpQuote: entry.pumpCoin || null, creatorFeeBps, pairAccounts, delivery };
    const instructions = fx.launchInstructions(launchPlan).map(web3Ix);
    const priorityFor = units => priorityMicroLamports ? BigInt(Math.ceil(units * Number(priorityMicroLamports) / 1e6)) : big(priorityLamports);
    const keys = [keypair(signers.launch, launchWallet), keypair(signers.mint, mint)];
    try {
      const block = await this.c.getLatestBlockhash('finalized'); must(Number.isSafeInteger(block.lastValidBlockHeight) && block.lastValidBlockHeight >= 151, 'The RPC omitted the transaction expiry.', 'PUMP_CLASSIC_RPC');
      const build = units => {
        const tx = makeV1Transaction(pk(launchWallet), block.blockhash, instructions, { computeUnits: units, fees: { priority: priorityFor(units) } });
        must(transactionSize(tx.message) <= 4096, 'The atomic launch exceeds the transaction size limit. Nothing was created.', 'PUMP_CLASSIC_SIZE');
        tx.sign(keys); const bytes = Buffer.from(tx.serialize()); verifySignedTransaction(bytes, launchWallet, [mint]); return { tx, bytes };
      };
      let built = build(computeUnits);
      const watch = fx.launchWatchList({ mint, launchWallet, developer, holder, transfers, quote });
      const sim = await this.simulatePrepared(built.tx, { sigVerify: true, commitment: 'finalized', minContextSlot: before.context.slot, accounts: { encoding: 'base64', addresses: watch } }, block.lastValidBlockHeight);
      if (sim.value?.err) throw simulationFailure(built.tx, sim.value, 'create');
      must(Number.isSafeInteger(sim.context?.slot) && sim.context.slot >= before.context.slot, 'The RPC omitted the launch simulation context.', 'PUMP_CLASSIC_RPC');
      const effects = fx.verifyLaunchState({ mint, launchWallet, developer, holder, shareholders, tokens, transfers, before: { launchLamports, recipients, launchQuote }, after: sim.value.accounts.map(simAccount), maxDebit: launchLamports, quote, creatorFeeBps, maxQuoteDebit: quote.native ? 0n : (tokens > 0n ? devBuy : 0n) });
      if (Number.isFinite(sim.value.unitsConsumed)) built = build(Math.min(1400000, Math.max(200000, Math.ceil(sim.value.unitsConsumed * 1.2) + 10000)));
      return { kind: 'launch', version: built.tx.version, wallet: launchWallet, mint, signature: bs58.encode(built.tx.signatures[0]), raw: built.bytes.toString('base64'), rawHash: sha(built.bytes), blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight, preparedSlot: sim.context.slot,
        expected: { delivery, pairAccounts, tokens: tokens.toString(), quotedTokens: quoted.toString(), simulatedSpend: effects.spentLamports.toString(), simulatedQuoteSpend: effects.spentQuote.toString(), transfers: transfers.map(t => ({ to: t.to, lamports: big(t.lamports).toString() })), shareholders: shareholders.map(s => ({ address: s.address, shareBps: s.shareBps })), feeBps: fresh.feeBps.toString(), globalSlot: g.slot, creatorFeeBps: effects.creatorFeeBps.toString(), quoteMint: quote.mint, maxQuoteDebit: (quote.native ? 0n : (tokens > 0n ? devBuy : 0n)).toString(), initialVirtualQuoteReserves: entry.initialVirtualQuoteReserves.toString() } };
    } finally { wipe(keys); }
  }
  /**
   * Operator readiness check (scripts/check-pump-classic.mjs): builds the exact
   * atomic launch for fresh, never-funded mint/developer/receipt addresses with
   * a funded `payer` standing in for the launch wallet, and simulates it without
   * signatures. Nothing is signed or sent; the report says whether create_v2,
   * fee sharing with the admin revoked, the dev buy, delivery and transfers all
   * produce exactly the effects a real launch requires.
   */
  async checkLaunch({ payer, devBuyLamports = 10000000n, addresses, uri = 'https://example.com/curve-pump-check.json', computeUnits = 700000, priorityLamports = 14000n, quoteMint = NATIVE_MINT, creatorFeeBps = 0n }) {
    must(fx.isAddressLike(payer), 'Enter the funded payer address.', 'PUMP_CLASSIC_CHECK');
    const { mint, developer, protocol, recipient } = addresses, devBuy = big(devBuyLamports), fee = big(creatorFeeBps);
    const g = await this.readGlobals(), entry = await this.resolveQuote(g, quoteMint), quote = fx.launchQuote({ global: g.global, feeConfig: g.feeConfig, devBuyRaw: devBuy, quote: entry, creatorFeeBps: fee });
    let quoteInfo = null;
    if (entry.kind !== 'sol') { const r = snapshot(await this.c.getMultipleAccountsInfoAndContext([pk(entry.mint)], { commitment: 'confirmed', minContextSlot: g.slot }), 1, g.slot), support = fx.quoteMintSupport(r.value[0]); must(support.supported, support.reason || 'Launchpad cannot handle this quote mint.', 'PUMP_CLASSIC_CHECK'); quoteInfo = { mint: entry.mint, program: support.program }; }
    const q = quoteOf(quoteInfo);
    // Mirrors a non-creator launch: both shareholder wallets are new and funded only later in the same transaction.
    const shareholders = [{ address: protocol, shareBps: 1000 }, { address: recipient, shareBps: 9000 }], transfers = [{ to: protocol, lamports: '5000000' }, { to: recipient, lamports: '3000000' }];
    const watched = [payer, protocol, recipient], payerQuoteAta = q.native ? null : quoteAta(payer, q);
    const before = snapshot(await this.c.getMultipleAccountsInfoAndContext([...watched, ...(payerQuoteAta ? [payerQuoteAta] : []), mint, coinAddresses(mint, q).bondingCurve].map(pk), { commitment: 'confirmed', minContextSlot: g.slot }), watched.length + (payerQuoteAta ? 3 : 2), g.slot);
    must(!before.value.at(-1) && !before.value.at(-2), 'The check mint already exists. Run the check again.', 'PUMP_CLASSIC_CHECK');
    const launchLamports = fx.walletLamports(before.value[0]), recipients = { [protocol]: fx.walletLamports(before.value[1]), [recipient]: fx.walletLamports(before.value[2]) };
    const launchQuote = payerQuoteAta && before.value[3] ? fx.readTokenAccount(before.value[3], { program: q.program, mint: q.mint, owner: payer }).amount : 0n;
    if (payerQuoteAta && quote.tokens > 0n) must(launchQuote >= devBuy, 'The payer does not hold enough of the quote asset for this dev buy. Use --dev-buy 0 or a payer that holds it.', 'PUMP_CLASSIC_CHECK');
    // On another pair a real launch first creates its pair accounts in a setup transaction and delivers the
    // dev-buy tokens afterwards. This check creates the accounts the dev buy needs inline instead (more program
    // calls than the real launch makes) and leaves the tokens with the payer, so a pass is an upper bound.
    const layout = q.native ? { pairAccounts: 'create', delivery: 'inline' } : { pairAccounts: 'create', ammVault: false, delivery: 'separate' }, holder = q.native ? developer : payer;
    const instructions = fx.launchInstructions({ mint, launchWallet: payer, developer, name: 'Launchpad check', symbol: 'CHECK', uri, shareholders, tokens: quote.tokens, maxSolCost: quote.tokens > 0n ? devBuy : 0n, global: g.global, transfers, quote: q, quoteControl: entry.quoteControl === true, pumpQuote: entry.pumpCoin || null, creatorFeeBps: fee, ...layout }).map(web3Ix);
    const block = await this.c.getLatestBlockhash('confirmed');
    const tx = makeV1Transaction(pk(payer), block.blockhash, instructions, { computeUnits, fees: { priority: big(priorityLamports) } }), size = transactionSize(tx.message);
    const watch = fx.launchWatchList({ mint, launchWallet: payer, developer, holder, transfers, quote: q });
    const sim = await this.c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } });
    const report = { slot: sim.context?.slot ?? null, size, quoteMint: entry.mint, quoteKind: entry.kind, payerLamports: launchLamports.toString(), quote: { tokens: quote.tokens.toString(), costLamports: quote.costLamports.toString(), feeBps: quote.feeBps.toString() }, unitsConsumed: sim.value?.unitsConsumed ?? null, error: sim.value?.err ?? null, logs: (sim.value?.logs || []).slice(-25) };
    if (sim.value?.err) return { ok: false, ...report };
    try { const effects = fx.verifyLaunchState({ mint, launchWallet: payer, developer, holder, shareholders, tokens: quote.tokens, transfers, before: { launchLamports, recipients, launchQuote }, after: sim.value.accounts.map(simAccount), maxDebit: launchLamports, quote: q, creatorFeeBps: fee, maxQuoteDebit: q.native ? 0n : (quote.tokens > 0n ? devBuy : 0n) }); return { ok: true, ...report, spentLamports: effects.spentLamports.toString(), spentQuote: effects.spentQuote.toString(), creatorFeeBps: effects.creatorFeeBps?.toString?.() ?? null }; }
    catch (error) { return { ok: false, ...report, error: error.message }; }
  }
  /**
   * Operator readiness check of the setup transaction a launch on another pair
   * sends before creation (prepareLaunchSetup), for a fresh check mint with the
   * funded `payer` standing in for the launch wallet. Simulated without
   * signatures; nothing is signed or sent.
   */
  async checkLaunchSetup({ payer, mint, quoteMint, program, devBuy = false }) {
    const quote = quoteOf({ mint: quoteMint, program }), g = await this.readGlobals();
    const rows = fx.launchSetupPlan({ mint, launchWallet: payer, global: g.global, quote, devBuy }), watch = [payer, ...rows.map(r => r.address)];
    const before = snapshot(await this.c.getMultipleAccountsInfoAndContext(watch.map(pk), { commitment: 'confirmed', minContextSlot: g.slot }), watch.length, g.slot);
    const missing = rows.filter((r, i) => fx.accountClosed(before.value[i + 1]));
    if (!missing.length) return { ok: true, created: 0, size: 0 };
    const block = await this.c.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({ payerKey: pk(payer), recentBlockhash: block.blockhash, instructions: [computeUnitLimit(40000 * missing.length + 20000), computeUnitPrice(PRIORITY_FLOOR), ...fx.launchSetupInstructions({ launchWallet: payer, quote, missing })].map(web3Ix) }).compileToV0Message();
    const size = transactionSize(message), sim = await this.c.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } });
    const after = sim.value?.accounts || [], created = rows.every((r, i) => !fx.accountClosed(after[i + 1]));
    return { ok: !sim.value?.err && created && size <= 1232, created: missing.length, size, unitsConsumed: sim.value?.unitsConsumed ?? null, error: sim.value?.err ?? (created ? null : 'not every planned account was created'), logs: (sim.value?.logs || []).slice(-15) };
  }
  /** Saved launch bytes are exactly the journaled, fully signed transaction. */
  verifySaved(op, additionalSigners = []) {
    must(op && typeof op.raw === 'string' && op.raw.length > 0 && op.raw.length <= 5600 && typeof op.wallet === 'string', 'Invalid saved transaction.', 'PUMP_CLASSIC_SAVED');
    const bytes = Buffer.from(op.raw, 'base64'); must(bytes.toString('base64') === op.raw && sha(bytes) === op.rawHash, 'The saved transaction bytes changed.', 'PUMP_CLASSIC_SAVED');
    const identity = verifySignedTransaction(bytes, op.wallet, additionalSigners), tx = deserializeTransaction(bytes);
    must(identity.signature === op.signature && tx.message.recentBlockhash === op.blockhash, 'The saved transaction identity changed.', 'PUMP_CLASSIC_SAVED');
    return { bytes, tx };
  }
  /**
   * Sends saved bytes. A funding the creator just signed is checked against
   * confirmed state (`preflightCommitment`), so funds that arrived seconds ago
   * count; rebroadcasts of an already accepted transaction skip the check.
   */
  async broadcastSaved(op, additionalSigners = [], { preflightCommitment = 'finalized', skipPreflight = false } = {}) {
    const { bytes } = this.verifySaved(op, additionalSigners);
    const result = await this.c.sendRawTransaction(bytes, { skipPreflight, preflightCommitment, maxRetries: 0, ...(Number.isSafeInteger(op.preparedSlot) ? { minContextSlot: op.preparedSlot } : {}) });
    must(result === op.signature, 'The RPC returned a different signature.', 'PUMP_CLASSIC_RPC'); return result;
  }
  async savedState(op, additionalSigners = []) { this.verifySaved(op, additionalSigners); return LaunchChain.prototype.pendingTransactionState.call(this, op); }
  async finalized(signature) {
    const tx = await LaunchChain.prototype.receipt.call(this, { signature }); if (!tx) return null;
    must(tx.transaction?.signatures?.[0] === signature && Number.isSafeInteger(tx.slot) && tx.meta && Object.hasOwn(tx.meta, 'err'), 'The finalized receipt is incomplete or has the wrong signature.', 'PUMP_CLASSIC_RECEIPT');
    return tx;
  }
  /** Finalized launch effects (null until finalized). A failed launch reports its fee only. */
  async launchReceipt(op, plan) {
    this.verifySaved(op, [plan.mint]); const tx = await this.finalized(op.signature); if (!tx) return null;
    const keys = fx.txKeys(tx); must(keys[0] === plan.launchWallet && keys.includes(plan.mint), 'The finalized launch has a different payer or mint.', 'PUMP_CLASSIC_RECEIPT');
    const holder = op.expected.delivery === 'separate' ? plan.launchWallet : plan.developer;
    const effects = fx.launchReceiptEffects(tx, { mint: plan.mint, launchWallet: plan.launchWallet, developer: plan.developer, holder, tokens: big(op.expected.tokens), transfers: op.expected.transfers, quote: plan.quote, maxQuoteDebit: big(op.expected.maxQuoteDebit ?? 0n) });
    return { ...effects, state: effects.failed ? 'failed' : 'confirmed', signature: op.signature };
  }
  /**
   * The setup transaction of a launch on another pair (fx.launchSetupPlan):
   * creates the accounts the creation transaction expects that do not exist
   * yet, paid and signed by the launch wallet. Returns null when they all exist.
   * Simulated: afterwards every planned account must exist, and the launch
   * wallet may spend no more than their rent and the network fee.
   */
  async prepareLaunchSetup({ plan, signer }) {
    const quote = quoteOf(plan.quote), launchWallet = plan.launchWallet; must(!quote.native, 'A SOL launch needs no setup transaction.', 'PUMP_CLASSIC_SETUP');
    const g = await this.readGlobals(readyAt(plan)), rows = fx.launchSetupPlan({ mint: plan.mint, launchWallet, global: g.global, quote, devBuy: big(plan.devBuyRaw ?? 0n) > 0n }), watch = [launchWallet, ...rows.map(r => r.address)];
    const before = snapshot(await this.c.getMultipleAccountsInfoAndContext(watch.map(pk), { commitment: 'confirmed', minContextSlot: g.slot }), watch.length, g.slot);
    const missing = rows.filter((r, i) => fx.accountClosed(before.value[i + 1]));
    if (!missing.length) return null;
    const plain = fx.launchSetupInstructions({ launchWallet, quote, missing }), price = await this.priorityPrice([launchWallet]);
    const block = await this.c.getLatestBlockhash('confirmed'); must(Number.isSafeInteger(block.lastValidBlockHeight) && block.lastValidBlockHeight >= 151, 'The RPC omitted the transaction expiry.', 'PUMP_CLASSIC_RPC');
    const units = 40000 * missing.length + 20000, message = new TransactionMessage({ payerKey: pk(launchWallet), recentBlockhash: block.blockhash, instructions: [computeUnitLimit(units), computeUnitPrice(price), ...plain].map(web3Ix) }).compileToV0Message();
    must(message.header.numRequiredSignatures === 1 && transactionSize(message) <= 1232, 'The launch setup transaction is too large.', 'PUMP_CLASSIC_SETUP');
    const fee = big((await this.c.getFeeForMessage(message, 'confirmed'))?.value); must(fee > 0n && fee <= FUNDING_FEE_LIMIT, 'The setup network fee exceeds its limit.', 'PUMP_CLASSIC_FEE');
    const tx = new VersionedTransaction(message);
    const sim = await this.simulatePrepared(tx, { sigVerify: false, commitment: 'confirmed', minContextSlot: before.context.slot, accounts: { encoding: 'base64', addresses: watch } }, block.lastValidBlockHeight);
    if (sim.value?.err) throw simulationFailure(tx, sim.value, 'setup');
    const after = sim.value?.accounts || []; must(after.length === watch.length && rows.every((r, i) => !fx.accountClosed(after[i + 1])), 'The launch setup simulation did not create every planned account.', 'PUMP_CLASSIC_SIMULATION');
    const spent = fx.walletLamports(before.value[0]) - big(after[0]?.lamports ?? 0), rent = await this.rentExempt(200);
    must(spent >= 0n && spent <= fee + rent * BigInt(missing.length + 1), 'The launch setup would spend more than its accounts and fee.', 'PUMP_CLASSIC_SIMULATION');
    const keys = [keypair(signer, launchWallet)]; let bytes;
    try { tx.sign(keys); bytes = Buffer.from(tx.serialize()); verifySignedTransaction(bytes, launchWallet); } finally { wipe(keys); }
    return { kind: 'setup', wallet: launchWallet, mint: plan.mint, signature: bs58.encode(tx.signatures[0]), raw: bytes.toString('base64'), rawHash: sha(bytes), blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight, preparedSlot: sim.context?.slot ?? before.context.slot, createdAt: this.now(), created: missing.map(r => ({ kind: r.kind, owner: r.owner, address: r.address })), simulatedSpend: spent.toString() };
  }
  /** Finalized outcome of a setup transaction (null until finalized). */
  async setupReceipt(op) {
    this.verifySaved(op); const tx = await this.finalized(op.signature); if (!tx) return null;
    const keys = fx.txKeys(tx); must(keys[0] === op.wallet, 'The finalized setup has a different payer.', 'PUMP_CLASSIC_RECEIPT');
    return { state: tx.meta.err === null ? 'confirmed' : 'failed', signature: op.signature, slot: tx.slot, feeLamports: big(tx.meta.fee), spentLamports: -fx.lamportDelta(tx, keys, op.wallet), error: tx.meta.err };
  }
  /**
   * Delivers the dev-buy tokens the launch wallet bought to the developer and
   * closes its token account (its rent returns to the launch wallet). Everything
   * the account holds goes to the developer. Simulated: the developer gains
   * exactly that amount and the account closes.
   */
  async prepareDelivery({ plan, signer, tokens }) {
    const { mint, launchWallet, developer } = plan, expected = big(tokens), source = associatedTokenAddress(launchWallet, mint, TOKEN_2022_PROGRAM), destination = associatedTokenAddress(developer, mint, TOKEN_2022_PROGRAM), watch = [launchWallet, source, destination];
    must(expected > 0n, 'There are no dev-buy tokens to deliver.', 'PUMP_CLASSIC_DELIVERY');
    const before = snapshot(await this.c.getMultipleAccountsInfoAndContext(watch.map(pk), { commitment: 'confirmed', ...(Number.isSafeInteger(plan.createdSlot) ? { minContextSlot: plan.createdSlot } : {}) }), watch.length, Number.isSafeInteger(plan.createdSlot) ? plan.createdSlot : 0);
    must(!fx.accountClosed(before.value[1]), 'The launch wallet’s dev-buy token account is not visible yet.', 'PUMP_CLASSIC_PENDING');
    const held = fx.readTokenAccount(before.value[1], { program: TOKEN_2022_PROGRAM, mint, owner: launchWallet }).amount, destinationBefore = fx.accountClosed(before.value[2]) ? 0n : fx.readTokenAccount(before.value[2], { program: TOKEN_2022_PROGRAM, mint, owner: developer }).amount;
    must(held >= expected, 'The launch wallet holds fewer dev-buy tokens than the launch delivered.', 'PUMP_CLASSIC_DELIVERY');
    const price = await this.priorityPrice([launchWallet]), block = await this.c.getLatestBlockhash('confirmed'); must(Number.isSafeInteger(block.lastValidBlockHeight) && block.lastValidBlockHeight >= 151, 'The RPC omitted the transaction expiry.', 'PUMP_CLASSIC_RPC');
    const message = new TransactionMessage({ payerKey: pk(launchWallet), recentBlockhash: block.blockhash, instructions: [computeUnitLimit(120000), computeUnitPrice(price), ...fx.deliveryInstructions({ launchWallet, developer, mint, tokens: held })].map(web3Ix) }).compileToV0Message();
    must(message.header.numRequiredSignatures === 1 && transactionSize(message) <= 1232, 'The delivery transaction is invalid.', 'PUMP_CLASSIC_DELIVERY');
    const fee = big((await this.c.getFeeForMessage(message, 'confirmed'))?.value); must(fee > 0n && fee <= FUNDING_FEE_LIMIT, 'The delivery network fee exceeds its limit.', 'PUMP_CLASSIC_FEE');
    const tx = new VersionedTransaction(message);
    const sim = await this.simulatePrepared(tx, { sigVerify: false, commitment: 'confirmed', minContextSlot: before.context.slot, accounts: { encoding: 'base64', addresses: watch } }, block.lastValidBlockHeight);
    if (sim.value?.err) throw simulationFailure(tx, sim.value, 'delivery');
    const after = sim.value?.accounts || [], destinationAfter = after[2] && !fx.accountClosed(after[2]) ? fx.readTokenAccount(simAccount(after[2]), { program: TOKEN_2022_PROGRAM, mint, owner: developer }).amount : 0n;
    must(after.length === 3 && fx.accountClosed(after[1]) && destinationAfter - destinationBefore === held, 'The delivery simulation moved an unexpected amount.', 'PUMP_CLASSIC_SIMULATION');
    const keys = [keypair(signer, launchWallet)]; let bytes;
    try { tx.sign(keys); bytes = Buffer.from(tx.serialize()); verifySignedTransaction(bytes, launchWallet); } finally { wipe(keys); }
    return { kind: 'deliver', wallet: launchWallet, recipient: developer, mint, inputAmount: held.toString(), signature: bs58.encode(tx.signatures[0]), raw: bytes.toString('base64'), rawHash: sha(bytes), blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight, preparedSlot: sim.context?.slot ?? before.context.slot, createdAt: this.now() };
  }
  /** Finalized outcome of a delivery (null until finalized): exactly the prepared amount reached the developer. */
  async deliveryReceipt(op, plan) {
    this.verifySaved(op); const tx = await this.finalized(op.signature); if (!tx) return null;
    const effects = fx.deliveryEffects(tx, { launchWallet: plan.launchWallet, developer: plan.developer, mint: plan.mint, tokens: big(op.inputAmount) });
    return { ...effects, state: effects.failed ? 'failed' : 'confirmed', signature: op.signature };
  }
  /** Read-back after creation: curve creator, shares and admin revocation exactly as planned. */
  async verifyCoinSetup(plan) {
    const coin = await this.readCoin(plan.mint, { quote: plan.quote }); must(coin.exists, 'The coin is not visible onchain yet.', 'PUMP_CLASSIC_PENDING');
    const a = coinAddresses(plan.mint, plan.quote), planned = plan.shareholders;
    const ok = coin.curve.creator === a.sharingConfig && coin.sharing && coin.sharing.status === 'Active' && coin.sharing.admin_revoked === true && coin.sharing.shareholders.length === planned.length && planned.every((s, i) => coin.sharing.shareholders[i].address === s.address && coin.sharing.shareholders[i].shareBps === s.shareBps);
    return { ok, coin };
  }

  // --- refunds and sweeps -----------------------------------------------------------
  /**
   * Full or partial native refund from a Launchpad wallet. With keepLamports 0 the
   * wallet is drained and closed. The result has the treasury 'withdraw' shape
   * so the inherited receipt verification applies unchanged.
   */
  async prepareDrain({ wallet: signer, recipient, keepLamports = 0n, maxNetworkCostLamports = '50000', minContextSlot = 0 }) {
    const owner = signer?.address, keep = big(keepLamports);
    must(owner && recipient && owner !== recipient, 'Invalid refund wallets.', 'PUMP_CLASSIC_REFUND');
    // Read at or after the launch's newest settled transaction, so a lagging node never under-refunds.
    const before = snapshot(await this.c.getMultipleAccountsInfoAndContext([pk(owner), pk(recipient)], { commitment: 'finalized', ...(minContextSlot > 0 ? { minContextSlot } : {}) }), 2, minContextSlot > 0 ? minContextSlot : 0);
    const balance = fx.walletLamports(before.value[0]), recipientBefore = fx.walletLamports(before.value[1]);
    const block = await this.c.getLatestBlockhash('finalized'); must(Number.isSafeInteger(block.lastValidBlockHeight) && block.lastValidBlockHeight >= 151, 'The RPC omitted the transaction expiry.', 'PUMP_CLASSIC_RPC');
    const compile = amount => new TransactionMessage({ payerKey: pk(owner), recentBlockhash: block.blockhash, instructions: [web3Ix(systemTransfer({ from: owner, to: recipient, lamports: amount }))] }).compileToV0Message();
    const fee = big((await this.c.getFeeForMessage(compile(1n), 'finalized'))?.value); must(fee > 0n && fee <= big(maxNetworkCostLamports), 'The refund network fee exceeds its limit.', 'PUMP_CLASSIC_FEE');
    const amount = balance - fee - keep; must(amount > 0n, 'Nothing is left to refund after the network fee.', 'PUMP_CLASSIC_EMPTY');
    if (keep > 0n) must(keep >= await this.rentExempt(0), 'A kept balance must stay rent-exempt.', 'PUMP_CLASSIC_REFUND');
    if (recipientBefore === 0n) must(amount >= await this.rentExempt(0), 'The refund is too small to open the recipient wallet.', 'PUMP_CLASSIC_REFUND');
    const message = compile(amount), tx = new VersionedTransaction(message);
    const sim = await this.simulatePrepared(tx, { sigVerify: false, commitment: 'finalized', minContextSlot: before.context.slot, accounts: { encoding: 'base64', addresses: [owner, recipient] } }, block.lastValidBlockHeight);
    must(!sim.value?.err && Array.isArray(sim.value?.accounts) && sim.value.accounts.length === 2, `The refund simulation failed: ${JSON.stringify(sim.value?.err)}.`, 'PUMP_CLASSIC_SIMULATION');
    const ownerAfter = sim.value.accounts[0] ? BigInt(sim.value.accounts[0].lamports) : 0n, recipientAfter = BigInt(sim.value.accounts[1]?.lamports ?? 0);
    must(ownerAfter === keep && recipientAfter - recipientBefore === amount, 'The refund simulation moved an unexpected amount.', 'PUMP_CLASSIC_SIMULATION');
    const keys = [keypair(signer, owner)]; let bytes;
    try { tx.sign(keys); bytes = Buffer.from(tx.serialize()); verifySignedTransaction(bytes, owner); } finally { wipe(keys); }
    return { kind: 'withdraw', mint: NATIVE_MINT, wallet: owner, recipient, inputAmount: amount.toString(), minimumOutput: '0', expectedOutput: '0', signature: bs58.encode(tx.signatures[0]), raw: bytes.toString('base64'), rawHash: sha(bytes), ...block, preparedSlot: sim.context.slot, createdAt: this.now(),
      accounting: { maxCostLamports: big(maxNetworkCostLamports).toString(), monitoredAccounts: [], minSolReserve: keep.toString(), networkFeeLamports: fee.toString(), beforeSol: balance.toString() } };
  }

  // --- fee distribution -----------------------------------------------------------------
  /** Permissionless distribution of this coin's pending creator fees, paid by the per-coin protocol wallet. */
  async prepareDistribution({ wallet: signer, mint, shareholders, includeAmm = false, maxNetworkCostLamports = '100000', microLamports = 10000, quote: quoteInput = null }) {
    const quote = quoteOf(quoteInput);
    if (!quote.native) return this.prepareQuoteDistribution({ wallet: signer, mint, shareholders, includeAmm, maxNetworkCostLamports, microLamports, quote });
    const payer = signer?.address, a = coinAddresses(mint), holders = shareholders.map(s => s.address);
    must(holders.includes(payer), 'The distribution payer must be a shareholder of this coin.', 'PUMP_CLASSIC_DISTRIBUTION');
    const watch = [...new Set([payer, ...holders, a.sharedCreatorVault])];
    const before = snapshot(await this.c.getMultipleAccountsInfoAndContext(watch.map(pk), { commitment: 'finalized' }), watch.length);
    const prior = Object.fromEntries(watch.map((address, i) => [address, before.value[i] ? fx.plainAccount(before.value[i]).lamports : 0n]));
    for (const holder of holders) must(prior[holder] > 0n, 'A fee shareholder wallet is closed; distribution waits until it is reopened.', 'PUMP_CLASSIC_RECIPIENT_CLOSED');
    const block = await this.c.getLatestBlockhash('finalized'); must(Number.isSafeInteger(block.lastValidBlockHeight) && block.lastValidBlockHeight >= 151, 'The RPC omitted the transaction expiry.', 'PUMP_CLASSIC_RPC');
    const instructions = [computeUnitLimit(includeAmm ? 160000 : 90000), computeUnitPrice(microLamports), ...fx.distributionInstructions({ payer, mint, shareholders, includeAmm })].map(web3Ix);
    const message = new TransactionMessage({ payerKey: pk(payer), recentBlockhash: block.blockhash, instructions }).compileToV0Message();
    must(message.header.numRequiredSignatures === 1 && transactionSize(message) <= 1232, 'The distribution transaction is invalid.', 'PUMP_CLASSIC_DISTRIBUTION');
    const fee = big((await this.c.getFeeForMessage(message, 'finalized'))?.value); must(fee > 0n && fee <= big(maxNetworkCostLamports), 'The distribution network fee exceeds its limit.', 'PUMP_CLASSIC_FEE');
    const tx = new VersionedTransaction(message);
    const sim = await this.simulatePrepared(tx, { sigVerify: false, commitment: 'finalized', minContextSlot: before.context.slot, accounts: { encoding: 'base64', addresses: watch } }, block.lastValidBlockHeight);
    if (sim.value?.err) fail(`Distribution simulation failed: ${JSON.stringify(sim.value.err)}.`, 'PUMP_CLASSIC_DISTRIBUTION_SIM');
    const after = Object.fromEntries(watch.map((address, i) => [address, sim.value.accounts?.[i] ? BigInt(sim.value.accounts[i].lamports) : 0n]));
    const vaultOut = prior[a.sharedCreatorVault] - after[a.sharedCreatorVault];
    let paid = 0n; for (const holder of holders) { const gain = after[holder] - prior[holder] + (holder === payer ? fee : 0n); must(gain >= 0n, 'The distribution simulation debits a shareholder.', 'PUMP_CLASSIC_SIMULATION'); paid += gain; }
    must(paid > 0n, 'No creator fees are ready to distribute.', 'PUMP_CLASSIC_NOTHING');
    if (!includeAmm) must(vaultOut === paid, 'The distribution simulation does not match the creator vault.', 'PUMP_CLASSIC_SIMULATION');
    const keys = [keypair(signer, payer)]; let bytes;
    try { tx.sign(keys); bytes = Buffer.from(tx.serialize()); verifySignedTransaction(bytes, payer); } finally { wipe(keys); }
    return { kind: 'distribute', wallet: payer, mint, signature: bs58.encode(tx.signatures[0]), raw: bytes.toString('base64'), rawHash: sha(bytes), ...block, preparedSlot: sim.context.slot, expected: { paid: paid.toString(), feeLamports: fee.toString(), includeAmm, shareholders: shareholders.map(s => ({ address: s.address, shareBps: s.shareBps })) } };
  }
  /**
   * Distribution for a coin on another quote asset: shares are paid in that
   * token (the program creates missing shareholder accounts, paid by the payer,
   * which must be a shareholder). The simulation must pay exactly what leaves the
   * shared vault (when the AMM vault is not swept in the same transaction).
   */
  async prepareQuoteDistribution({ wallet: signer, mint, shareholders, includeAmm, maxNetworkCostLamports, microLamports, quote }) {
    const payer = signer?.address, a = coinAddresses(mint, quote), holders = shareholders.map(s => s.address);
    must(holders.includes(payer), 'The distribution payer must be a shareholder of this coin.', 'PUMP_CLASSIC_DISTRIBUTION');
    const accounts = holders.map(holder => quoteAta(holder, quote)), watch = [payer, a.sharedCreatorVaultQuoteAta, ...accounts];
    const before = snapshot(await this.c.getMultipleAccountsInfoAndContext(watch.map(pk), { commitment: 'finalized' }), watch.length);
    const amount = (raw, owner) => raw ? fx.readTokenAccount(raw, { program: quote.program, mint: quote.mint, owner }).amount : 0n;
    const vaultBefore = amount(before.value[1], a.sharedCreatorVault), prior = holders.map((holder, i) => amount(before.value[i + 2], holder)), payerLamports = fx.walletLamports(before.value[0]);
    const block = await this.c.getLatestBlockhash('finalized'); must(Number.isSafeInteger(block.lastValidBlockHeight) && block.lastValidBlockHeight >= 151, 'The RPC omitted the transaction expiry.', 'PUMP_CLASSIC_RPC');
    const instructions = [computeUnitLimit(includeAmm ? 260000 : 180000), computeUnitPrice(microLamports), ...fx.distributionInstructions({ payer, mint, shareholders, includeAmm, quote })].map(web3Ix);
    const message = new TransactionMessage({ payerKey: pk(payer), recentBlockhash: block.blockhash, instructions }).compileToV0Message();
    must(message.header.numRequiredSignatures === 1 && transactionSize(message) <= 1232, 'The distribution transaction is invalid.', 'PUMP_CLASSIC_DISTRIBUTION');
    const fee = big((await this.c.getFeeForMessage(message, 'finalized'))?.value); must(fee > 0n && fee <= big(maxNetworkCostLamports), 'The distribution network fee exceeds its limit.', 'PUMP_CLASSIC_FEE');
    const rent = await this.rentExempt(quote.program === TOKEN_PROGRAM ? 165 : 170), missing = BigInt(accounts.filter((_, i) => !before.value[i + 2]).length);
    must(payerLamports >= fee + rent * missing + 1000000n, 'The platform receipt wallet needs SOL for this distribution’s network fee and new token accounts.', 'PUMP_CLASSIC_GAS');
    const tx = new VersionedTransaction(message);
    const sim = await this.simulatePrepared(tx, { sigVerify: false, commitment: 'finalized', minContextSlot: before.context.slot, accounts: { encoding: 'base64', addresses: watch } }, block.lastValidBlockHeight);
    if (sim.value?.err) fail(`Distribution simulation failed: ${JSON.stringify(sim.value.err)}.`, 'PUMP_CLASSIC_DISTRIBUTION_SIM');
    const after = sim.value.accounts || [], vaultAfter = amount(after[1] && simAccount(after[1]), a.sharedCreatorVault);
    let paid = 0n; holders.forEach((holder, i) => { const gain = amount(after[i + 2] && simAccount(after[i + 2]), holder) - prior[i]; must(gain >= 0n, 'The distribution simulation debits a shareholder.', 'PUMP_CLASSIC_SIMULATION'); paid += gain; });
    must(paid > 0n, 'No creator fees are ready to distribute.', 'PUMP_CLASSIC_NOTHING');
    if (!includeAmm) must(vaultBefore - vaultAfter === paid, 'The distribution simulation does not match the creator vault.', 'PUMP_CLASSIC_SIMULATION');
    const keys = [keypair(signer, payer)]; let bytes;
    try { tx.sign(keys); bytes = Buffer.from(tx.serialize()); verifySignedTransaction(bytes, payer); } finally { wipe(keys); }
    return { kind: 'distribute', wallet: payer, mint, signature: bs58.encode(tx.signatures[0]), raw: bytes.toString('base64'), rawHash: sha(bytes), ...block, preparedSlot: sim.context.slot, expected: { paid: paid.toString(), feeLamports: fee.toString(), includeAmm, quoteMint: quote.mint, shareholders: shareholders.map(s => ({ address: s.address, shareBps: s.shareBps })) } };
  }
  /** Distribution legs of any finalized transaction (ours or another caller's), in the coin's quote asset. */
  async distributionReceipt(signature, { mint, quote = null }) {
    const tx = await this.finalized(signature); if (!tx) return null;
    const keys = fx.txKeys(tx), { legs, anomalies } = fx.distributionLegs(tx, { mint, quote });
    // The payer's whole SOL change: the network fee plus any token accounts the distribution opened.
    return { signature, slot: tx.slot, blockTime: tx.blockTime ?? null, failed: tx.meta.err !== null, payer: keys[0], feeLamports: big(tx.meta.fee), payerLamportDelta: fx.lamportDelta(tx, keys, keys[0]), legs, anomalies };
  }

  // --- launches on another quote asset: funding, refunds and conversion ---------------------
  /**
   * Unsigned funding for a launch whose dev buy uses another quote asset: the
   * developer's wallet sends the SOL for launch costs and reserves, and the
   * exact dev-buy amount of the quote asset into the launch wallet's quote
   * account (created idempotently, rent paid by the developer), with the memo.
   */
  async prepareQuoteDeposit({ sender, recipient, lamports: amount, memo, quote: quoteInput, tokenAmount, decimals }) {
    const quote = quoteOf(quoteInput), input = big(amount), tokens = big(tokenAmount); must(!quote.native && tokens > 0n, 'This funding needs a quote-asset amount.', 'PUMP_CLASSIC_FUNDING');
    must(fx.isAddressLike(sender) && fx.isAddressLike(recipient) && sender !== recipient && typeof memo === 'string' && /^[a-z0-9:_-]{10,80}$/.test(memo), 'Invalid funding request.', 'PUMP_CLASSIC_FUNDING');
    must(Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 12, 'Invalid quote decimals.', 'PUMP_CLASSIC_FUNDING');
    const from = quoteAta(sender, quote), keys = [sender, from, quote.mint];
    const before = snapshot(await this.c.getMultipleAccountsInfoAndContext(keys.map(pk), { commitment: 'confirmed' }), keys.length);
    const wallet = fx.plainAccount(before.value[0]);
    must(wallet && !wallet.executable && wallet.owner === SYSTEM_PROGRAM, 'The funding wallet must be an ordinary SOL wallet.', 'PUMP_CLASSIC_FUNDING');
    const held = before.value[1] ? fx.readTokenAccount(before.value[1], { program: quote.program, mint: quote.mint, owner: sender }).amount : 0n;
    must(held >= tokens, 'Your wallet does not hold enough of the quote asset for this dev buy.', 'PUMP_CLASSIC_BALANCE');
    must(fx.readMint(before.value[2], { program: quote.program }).decimals === decimals, 'The quote asset decimals changed. Review the launch again.', 'PUMP_CLASSIC_FUNDING');
    const plain = [systemTransfer({ from: sender, to: recipient, lamports: input }), createAtaIdempotent({ payer: sender, owner: recipient, mint: quote.mint, tokenProgram: quote.program }), transferChecked({ owner: sender, recipient, mint: quote.mint, amount: tokens, decimals, tokenProgram: quote.program }), memoInstruction(memo)];
    const { tx, block, preparedSlot } = await this.userFunding({ sender, plain, walletLamports: wallet.lamports, input, minContextSlot: before.context.slot });
    const sim = { context: { slot: preparedSlot } };
    const bytes = Buffer.from(tx.serialize());
    return { kind: 'deposit', needsSignature: true, state: 'awaiting_signature', externalSigner: sender, recipient, mint: quote.mint, inputAmount: input.toString(), tokenAmount: tokens.toString(), memo, unsignedRaw: bytes.toString('base64'), messageHash: sha(Buffer.from(tx.message.serialize())), blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight, preparedSlot: sim.context?.slot ?? before.context.slot, createdAt: this.now() };
  }
  /** Finalized verification of a quote-asset funding (null until finalized). */
  async quoteDepositReceipt({ signature, sender, recipient, lamports, memo, quote, tokenAmount }) {
    const tx = await this.finalized(signature); if (!tx) return null;
    const effects = fx.quoteFundingEffects(tx, { sender, recipient, lamports, memo, quote, tokenAmount });
    return effects.state === 'failed' ? { state: 'failed', signature, slot: tx.slot, error: effects.error } : { state: 'finalized', signature, slot: tx.slot, receivedAmount: effects.receivedLamports.toString(), receivedTokens: effects.receivedTokens.toString(), feeLamports: effects.feeLamports.toString() };
  }
  /**
   * Returns every quote token the launch wallet still holds (an unused dev-buy
   * budget, or all of it when the launch failed) to the developer and closes the
   * launch wallet's quote account; the rent comes back to the launch wallet and
   * leaves with the SOL refund.
   */
  async prepareQuoteRefund({ wallet: signer, recipient, quote: quoteInput, decimals, minContextSlot = 0 }) {
    const quote = quoteOf(quoteInput), owner = signer?.address; must(!quote.native && fx.isAddressLike(owner) && fx.isAddressLike(recipient) && owner !== recipient, 'Invalid quote refund.', 'PUMP_CLASSIC_REFUND');
    const source = quoteAta(owner, quote), destination = quoteAta(recipient, quote), watch = [owner, source, destination];
    // Read at or after the slot that proved the account exists (funding or creation), so a lagging node cannot hide it.
    const before = snapshot(await this.c.getMultipleAccountsInfoAndContext(watch.map(pk), { commitment: 'finalized', ...(minContextSlot > 0 ? { minContextSlot } : {}) }), watch.length, minContextSlot);
    if (!before.value[1]) fail('The launch wallet holds no quote account.', 'PUMP_CLASSIC_NO_QUOTE');
    const amount = fx.readTokenAccount(before.value[1], { program: quote.program, mint: quote.mint, owner }).amount, destinationBefore = before.value[2] ? fx.readTokenAccount(before.value[2], { program: quote.program, mint: quote.mint, owner: recipient }).amount : 0n;
    const block = await this.c.getLatestBlockhash('finalized'); must(Number.isSafeInteger(block.lastValidBlockHeight) && block.lastValidBlockHeight >= 151, 'The RPC omitted the transaction expiry.', 'PUMP_CLASSIC_RPC');
    const plain = [computeUnitLimit(80000), computeUnitPrice(10000), ...(amount > 0n ? [createAtaIdempotent({ payer: owner, owner: recipient, mint: quote.mint, tokenProgram: quote.program }), transferChecked({ owner, recipient, mint: quote.mint, amount, decimals, tokenProgram: quote.program })] : []), closeTokenAccount({ owner, mint: quote.mint, destination: owner, tokenProgram: quote.program })];
    const message = new TransactionMessage({ payerKey: pk(owner), recentBlockhash: block.blockhash, instructions: plain.map(web3Ix) }).compileToV0Message();
    must(message.header.numRequiredSignatures === 1 && transactionSize(message) <= 1232, 'The quote refund transaction is invalid.', 'PUMP_CLASSIC_REFUND');
    const fee = big((await this.c.getFeeForMessage(message, 'finalized'))?.value); must(fee > 0n && fee <= 50000n, 'The refund network fee exceeds its limit.', 'PUMP_CLASSIC_FEE');
    const tx = new VersionedTransaction(message);
    const sim = await this.simulatePrepared(tx, { sigVerify: false, commitment: 'finalized', minContextSlot: before.context.slot, accounts: { encoding: 'base64', addresses: watch } }, block.lastValidBlockHeight);
    must(!sim.value?.err && Array.isArray(sim.value?.accounts) && sim.value.accounts.length === 3, `The quote refund simulation failed: ${JSON.stringify(sim.value?.err)}.`, 'PUMP_CLASSIC_SIMULATION');
    const destinationAfter = sim.value.accounts[2] ? fx.readTokenAccount(simAccount(sim.value.accounts[2]), { program: quote.program, mint: quote.mint, owner: recipient }).amount : 0n;
    must(fx.accountClosed(sim.value.accounts[1]), 'The quote refund simulation left the launch wallet’s token account open.', 'PUMP_CLASSIC_SIMULATION');
    must(destinationAfter - destinationBefore === amount, 'The quote refund simulation moved an unexpected amount.', 'PUMP_CLASSIC_SIMULATION');
    const keys = [keypair(signer, owner)]; let bytes;
    try { tx.sign(keys); bytes = Buffer.from(tx.serialize()); verifySignedTransaction(bytes, owner); } finally { wipe(keys); }
    return { kind: 'quote-refund', wallet: owner, recipient, mint: quote.mint, inputAmount: amount.toString(), signature: bs58.encode(tx.signatures[0]), raw: bytes.toString('base64'), rawHash: sha(bytes), ...block, preparedSlot: sim.context.slot, createdAt: this.now(), accounting: { source, destination, program: quote.program, networkFeeLamports: fee.toString() } };
  }
  async quoteRefundReceipt(op) {
    this.verifySaved(op); const tx = await this.finalized(op.signature); if (!tx) return null;
    const keys = fx.txKeys(tx), failed = tx.meta.err !== null, fee = big(tx.meta.fee);
    const moved = fx.tokenAmount(tx, keys, 'post', op.accounting.destination) - fx.tokenAmount(tx, keys, 'pre', op.accounting.destination), left = fx.tokenAmount(tx, keys, 'post', op.accounting.source);
    if (failed) { must(moved === 0n, 'A failed quote refund moved tokens.', 'PUMP_CLASSIC_RECEIPT'); return { state: 'failed', signature: op.signature, slot: tx.slot, feeLamports: fee }; }
    must(moved === big(op.inputAmount) && left === 0n, 'The finalized quote refund differs from its authorized amount.', 'PUMP_CLASSIC_RECEIPT');
    return { state: 'confirmed', signature: op.signature, slot: tx.slot, feeLamports: fee, refunded: moved };
  }
  /**
   * Read-only: how much of a pair asset a SOL dev buy buys through the
   * treasury's verified route, under the dev-buy limits (slippage and price
   * impact). `minimumRaw` is what the route guarantees after slippage.
   */
  async quoteDevBuyConversion({ quoteMint, program, lamports, taker, slippageBps = 100, maxImpactBps = 200 }) {
    must(fx.isAddressLike(quoteMint) && quoteMint !== NATIVE_MINT && big(lamports) > 0n && fx.isAddressLike(taker), 'Invalid dev-buy conversion request.', 'PUMP_CLASSIC_CONVERSION');
    const route = await this.withRouteGuard({ slippageBps, maxImpact: maxImpactBps / 10000 }, () => this.routes.quoteConversion(this, { inputMint: NATIVE_MINT, outputMint: quoteMint, inputProgram: TOKEN_PROGRAM, outputProgram: program, amountRaw: big(lamports).toString(), slippageBps, wallet: taker, maxAccounts: 32 }));
    must(big(route?.minimumRaw) > 0n && big(route.expectedRaw) >= big(route.minimumRaw), 'The SOL route returned none of the pair asset for this dev buy.', 'PUMP_CLASSIC_CONVERSION');
    return { expectedRaw: String(route.expectedRaw), minimumRaw: String(route.minimumRaw), slot: route.slot ?? null };
  }
  /**
   * The launch wallet buys the pair asset with exactly `lamports` (a SOL-paid
   * dev buy) through the treasury's verified route: signed and simulated, never
   * sent. The minimum output, the network-cost limit and the SOL reserve the
   * rest of the launch needs are enforced in the simulation and again on the
   * finalized receipt (receipt()).
   */
  async prepareDevBuyConversion({ wallet: signer, quote: quoteInput, lamports, minSolReserve, maxNetworkCostLamports, slippageBps = 100, maxImpactBps = 200 }) {
    const quote = quoteOf(quoteInput); must(!quote.native && big(lamports) > 0n, 'Only a dev buy on another pair is converted.', 'PUMP_CLASSIC_CONVERSION');
    const priority = await this.swapPriority(signer?.address);
    return this.withRouteGuard({ slippageBps, maxImpact: maxImpactBps / 10000 }, () => this.prepare({ kind: 'acquire', wallet: signer, mint: quote.mint, amount: big(lamports).toString(), minSolReserve: big(minSolReserve).toString(), maxNetworkCostLamports: String(maxNetworkCostLamports), ...priority }));
  }
  /**
   * An asset a reward basket names (v71.35): its mint read fresh (an ordinary
   * or Token-2022 mint without a transfer tax, hook or frozen default, the same
   * rule as a pair asset) with decimals, program and on-chain metadata text.
   */
  async basketAssetInfo(mint) {
    must(fx.isAddressLike(mint) && mint !== NATIVE_MINT, 'Invalid basket asset.', 'PUMP_CLASSIC_BASKET');
    const r = snapshot(await this.c.getMultipleAccountsInfoAndContext([pk(mint)], { commitment: 'finalized' }), 1);
    return { mint, slot: r.context.slot, ...fx.quoteMintSupport(r.value[0]) };
  }
  /**
   * A reward basket's purchase (v71.35): the holder rewards wallet buys exactly
   * `lamports` of a basket asset through the treasury's verified route, under
   * the basket guard. Signed and simulated, never sent; the minimum output, the
   * network-cost limit and the wallet's SOL reserve are enforced in the
   * simulation and again on the finalized receipt (receipt()).
   */
  async prepareBasketAcquire({ wallet: signer, mint, lamports, minSolReserve, maxNetworkCostLamports, slippageBps = 100, maxImpactBps = 200 }) {
    must(fx.isAddressLike(mint) && mint !== NATIVE_MINT && big(lamports) > 0n, 'Invalid basket purchase.', 'PUMP_CLASSIC_BASKET');
    const priority = await this.swapPriority(signer?.address);
    return this.withRouteGuard({ slippageBps, maxImpact: maxImpactBps / 10000 }, () => this.prepare({ kind: 'acquire', wallet: signer, mint, amount: big(lamports).toString(), minSolReserve: big(minSolReserve).toString(), maxNetworkCostLamports: String(maxNetworkCostLamports), ...priority }));
  }
  /**
   * Priority for a time-sensitive swap from a launch wallet (the dev-buy
   * purchase and its unwind): the recent price for the wallet, capped, and the
   * matching network-fee limit for the treasury route's 1.4M compute-unit budget.
   */
  async swapPriority(wallet) {
    const price = Math.min(SWAP_PRIORITY_CAP, await this.priorityPrice(wallet ? [wallet] : []));
    return { priorityMicroLamports: price, feeLimitLamports: String(10000n + BigInt(Math.ceil(1400000 * price / 1e6))) };
  }
  /**
   * Converts quote-asset fees held by a per-coin Launchpad wallet into SOL through
   * the treasury's verified route (simulated: exact input, minimum SOL output,
   * protected SOL reserve). Settles from the finalized receipt like any treasury
   * conversion. `guard` ({ slippageBps, maxImpactBps }) and `priority` are used
   * when a launch wallet sells a pair asset back (an unwound dev buy).
   */
  async prepareConversion({ wallet: signer, quote: quoteInput, amount, minSolReserve = '0', maxNetworkCostLamports = '5000000', guard = null, priority = false }) {
    const quote = quoteOf(quoteInput); must(!quote.native && big(amount) > 0n, 'Only quote-asset fees are converted.', 'PUMP_CLASSIC_CONVERSION');
    const request = { kind: 'convert', wallet: signer, mint: quote.mint, amount: big(amount).toString(), minSolReserve: big(minSolReserve).toString(), maxNetworkCostLamports: String(maxNetworkCostLamports), ...(priority ? await this.swapPriority(signer?.address) : {}) };
    return guard ? this.withRouteGuard({ slippageBps: guard.slippageBps, maxImpact: guard.maxImpactBps / 10000 }, () => this.prepare(request)) : this.prepare(request);
  }
  /**
   * Every finalized signature touching a Launchpad wallet after `until`, oldest
   * first. `complete` is false when the history is longer than the page budget;
   * callers then keep their cursor and process nothing (no gaps are skipped).
   */
  async signaturesFor(address, { until = null, pageSize = 1000, maxPages = 5 } = {}) {
    const all = []; let before = null, complete = false;
    for (let page = 0; page < maxPages; page++) {
      const rows = await this.c.getSignaturesForAddress(pk(address), { limit: pageSize, ...(before ? { before } : {}), ...(until ? { until } : {}) }, 'finalized');
      must(Array.isArray(rows), 'The RPC returned an invalid signature list.', 'PUMP_CLASSIC_RPC');
      for (const r of rows) if (typeof r?.signature === 'string' && Number.isSafeInteger(r.slot)) all.push({ signature: r.signature, slot: r.slot, failed: r.err !== null && r.err !== undefined, blockTime: r.blockTime ?? null });
      if (rows.length < pageSize) { complete = true; break; }
      before = rows.at(-1).signature;
    }
    return { rows: all.reverse(), complete };
  }
  async holderBalances({ mint, exclude = [] }) { return this.holderSnapshot({ mint, program: TOKEN_2022_PROGRAM, exclude }); }

  // --- strategy trades: bonding curve -------------------------------------------------------
  async prepareCurveTrade({ wallet: signer, mint, side, amount, slippageBps = 100, maxImpactBps = 200, microLamports = 20000 }) {
    const owner = signer?.address, ata = associatedTokenAddress(owner, mint, TOKEN_2022_PROGRAM), input = big(amount);
    must(['buy', 'sell'].includes(side) && input > 0n, 'Invalid strategy trade.', 'PUMP_CLASSIC_TRADE');
    const g = await this.readGlobals(), coin = await this.readCoin(mint, { commitment: 'confirmed', minContextSlot: g.slot });
    must(coin.exists && coin.venue === 'curve' && !coin.curve.complete, 'The coin is no longer on its bonding curve.', 'PUMP_CLASSIC_VENUE');
    const quote = fx.curveTradeQuote({ side, amount: input, curve: coin.curve, global: g.global, feeConfig: g.feeConfig, slippageBps });
    must(quote.impactBps <= BigInt(maxImpactBps), 'The trade exceeds its price-impact limit.', 'PUMP_CLASSIC_IMPACT');
    const before = snapshot(await this.c.getMultipleAccountsInfoAndContext([pk(owner), pk(ata)], { commitment: 'confirmed', minContextSlot: coin.slot }), 2, coin.slot);
    const native = fx.walletLamports(before.value[0]), tokens = before.value[1] ? fx.readTokenAccount(before.value[1], { program: TOKEN_2022_PROGRAM, mint, owner }).amount : 0n;
    if (side === 'sell') must(tokens >= input, 'The strategy wallet holds fewer tokens than this sell.', 'PUMP_CLASSIC_BALANCE');
    const plain = [computeUnitLimit(200000), computeUnitPrice(microLamports), ...fx.curveTradeInstructions({ side, wallet: owner, mint, amount: input, minimum: quote.minimum, global: g.global, createTokenAccount: !before.value[1] })];
    return this.signTrade({ signer, owner, mint, ata, side, input, quote, plain, native, tokens, minContextSlot: before.context.slot, venue: 'curve' });
  }
  async signTrade({ signer, owner, mint, ata, side, input, quote, plain, native, tokens, minContextSlot, venue, lookupTables = [], extra = {} }) {
    const block = await this.c.getLatestBlockhash('confirmed'); must(Number.isSafeInteger(block.lastValidBlockHeight) && block.lastValidBlockHeight >= 151, 'The RPC omitted the transaction expiry.', 'PUMP_CLASSIC_RPC');
    const instructions = plain.map(ix => ix instanceof TransactionInstruction ? ix : web3Ix(ix));
    const message = new TransactionMessage({ payerKey: pk(owner), recentBlockhash: block.blockhash, instructions }).compileToV0Message(lookupTables);
    must(message.header.numRequiredSignatures === 1 && transactionSize(message) <= 1232, 'The strategy trade is too large or needs another signer.', 'PUMP_CLASSIC_TRADE');
    const fee = big((await this.c.getFeeForMessage(message, 'confirmed'))?.value); must(fee > 0n && fee <= FEE_LIMIT, 'The trade network fee exceeds its limit.', 'PUMP_CLASSIC_FEE');
    const tx = new VersionedTransaction(message);
    const sim = await this.simulatePrepared(tx, { sigVerify: false, commitment: 'confirmed', minContextSlot, accounts: { encoding: 'base64', addresses: [owner, ata] } }, block.lastValidBlockHeight);
    if (sim.value?.err) throw launchSimulationError(tx, sim.value, 'trade');
    const nativeAfter = BigInt(sim.value.accounts?.[0]?.lamports ?? 0), tokensAfter = sim.value.accounts?.[1] ? fx.readTokenAccount(simAccount(sim.value.accounts[1]), { program: TOKEN_2022_PROGRAM, mint, owner }).amount : 0n;
    const solSpent = native - nativeAfter, tokenGain = tokensAfter - tokens;
    if (side === 'buy') must(tokenGain >= quote.minimum && solSpent <= input + fee + 6000000n, 'The trade simulation exceeds its spend or misses its minimum output.', 'PUMP_CLASSIC_SIMULATION');
    else must(-tokenGain === input && -solSpent + fee >= quote.minimum, 'The trade simulation sells a different amount or misses its minimum output.', 'PUMP_CLASSIC_SIMULATION');
    const keys = [keypair(signer, owner)]; let bytes;
    try { tx.sign(keys); bytes = Buffer.from(tx.serialize()); verifySignedTransaction(bytes, owner); } finally { wipe(keys); }
    return { kind: 'trade', venue, side, wallet: owner, mint, inputAmount: input.toString(), minimumOutput: quote.minimum.toString(), expectedOutput: quote.expected.toString(), impactBps: quote.impactBps.toString(), spot: quote.spot.toString(), signature: bs58.encode(tx.signatures[0]), raw: bytes.toString('base64'), rawHash: sha(bytes), ...block, preparedSlot: sim.context?.slot ?? minContextSlot,
      expected: { simulatedSol: (-solSpent).toString(), simulatedTokens: tokenGain.toString(), feeLamports: fee.toString(), ...extra } };
  }
  async tradeReceipt(op) {
    this.verifySaved(op); const tx = await this.finalized(op.signature); if (!tx) return null;
    const effects = fx.tradeEffects(tx, { side: op.side, wallet: op.wallet, mint: op.mint, input: big(op.inputAmount), minimum: big(op.minimumOutput) });
    return { ...effects, state: effects.failed ? 'failed' : 'confirmed', signature: op.signature, slot: tx.slot };
  }

  // --- strategy trades and liquidity: canonical PumpSwap pool (pinned SDK) -------------------------
  async ammSdk() { if (!this.pumpSwap) this.pumpSwap = { sdk: await import('@pump-fun/pump-swap-sdk'), spl: await import('@solana/spl-token'), BN: (await import('bn.js')).default }; return this.pumpSwap; }
  /** Verified canonical pool snapshot for SDK instruction builders (Token-2022 base, SOL quote). */
  async ammSnapshot(mint, owner) {
    const { sdk, spl, BN } = await this.ammSdk(), a = coinAddresses(mint);
    const coin = await this.readCoin(mint, { commitment: 'confirmed' }); must(coin.exists && coin.venue === 'amm', 'The coin has not completed its canonical PumpSwap graduation.', 'PUMP_CLASSIC_VENUE');
    const g = await this.readGlobals();
    const baseAta = associatedTokenAddress(owner, mint, TOKEN_2022_PROGRAM), quoteAta = associatedTokenAddress(owner, NATIVE_MINT, TOKEN_PROGRAM), lpAta = associatedTokenAddress(owner, a.lpMint, TOKEN_2022_PROGRAM);
    const keys = [a.canonicalPool, pumpAddresses.ammGlobalConfig, pumpAddresses.ammFeeConfig, mint, owner, baseAta, quoteAta, a.lpMint];
    const r = snapshot(await this.c.getMultipleAccountsInfoAndContext(keys.map(pk), { commitment: 'confirmed', minContextSlot: coin.slot }), keys.length, coin.slot);
    const [poolInfo, globalInfo, feeInfo, mintInfo, nativeInfo, baseInfo, wsolInfo, lpMintInfo] = r.value;
    const pool = sdk.PUMP_AMM_SDK.decodePool(poolInfo), mine = fx.readPool(poolInfo);
    // readCoin already proved this is the canonical pool for the mint; re-check the decoded copy the SDK will use.
    must(mine.base_mint === mint && mine.quote_mint === NATIVE_MINT && mine.coin_creator === a.sharingConfig && pool.baseMint.toBase58() === mint, 'The PumpSwap pool identity changed.', 'PUMP_CLASSIC_POOL');
    const lpProgram = lpMintInfo ? fx.plainAccount(lpMintInfo).owner : TOKEN_2022_PROGRAM;
    return { coin, globals: g, slot: r.context.slot, native: fx.walletLamports(nativeInfo), base: baseInfo ? fx.readTokenAccount(baseInfo, { program: TOKEN_2022_PROGRAM, mint, owner }).amount : 0n, wsolExists: !!wsolInfo, baseExists: !!baseInfo, baseAta, quoteAta, lpAta, lpProgram,
      sdk: { globalConfig: sdk.PUMP_AMM_SDK.decodeGlobalConfig(globalInfo), feeConfig: feeInfo ? sdk.PUMP_AMM_SDK.decodeFeeConfig(feeInfo) : null, poolKey: pk(a.canonicalPool), poolAccountInfo: poolInfo, pool, poolBaseAmount: new BN(coin.poolBase.toString()), poolQuoteAmount: new BN(coin.poolQuote.toString()), baseTokenProgram: pk(TOKEN_2022_PROGRAM), quoteTokenProgram: pk(TOKEN_PROGRAM), baseMint: pk(mint), baseMintAccount: spl.MintLayout.decode(Buffer.from(mintInfo.data).subarray(0, 82)), user: pk(owner), userBaseTokenAccount: pk(baseAta), userQuoteTokenAccount: pk(quoteAta), userBaseAccountInfo: baseInfo, userQuoteAccountInfo: wsolInfo } };
  }
  async prepareAmmTrade({ wallet: signer, mint, side, amount, slippageBps = 100, maxImpactBps = 200 }) {
    const owner = signer?.address, input = big(amount); must(['buy', 'sell'].includes(side) && input > 0n, 'Invalid strategy trade.', 'PUMP_CLASSIC_TRADE');
    const { sdk, spl, BN } = await this.ammSdk(), s = await this.ammSnapshot(mint, owner), pool = fx.readPool(s.sdk.poolAccountInfo);
    const quote = fx.ammTradeQuote({ side, amount: input, baseReserve: s.coin.poolBase, quoteVault: s.coin.poolQuote, virtualQuoteReserves: pool.virtual_quote_reserves, globalConfig: s.globals.ammGlobalConfig, feeConfig: s.globals.ammFeeConfig, supply: s.coin.mint.supply, slippageBps });
    must(quote.impactBps <= BigInt(maxImpactBps), 'The trade exceeds its price-impact limit.', 'PUMP_CLASSIC_IMPACT');
    if (side === 'sell') must(s.base >= input, 'The strategy wallet holds fewer tokens than this sell.', 'PUMP_CLASSIC_BALANCE');
    // The SDK supplies the current pool, fee and volume accounts; Launchpad signs only
    // the swap it reviewed: buy_exact_quote_in (exact SOL in) or sell (exact tokens in).
    const all = side === 'buy' ? await sdk.PUMP_AMM_SDK.buyInstructionsNoPool(s.sdk, new BN(quote.minimum.toString()), new BN(input.toString())) : await sdk.PUMP_AMM_SDK.sellInstructionsNoPool(s.sdk, new BN(input.toString()), new BN(quote.minimum.toString()));
    const swaps = all.filter(ix => ix.programId.equals(pk(PUMP_AMM_PROGRAM))); must(swaps.length === 1, 'Unexpected PumpSwap instruction set.', 'PUMP_CLASSIC_TRADE');
    const swap = swaps[0], data = Buffer.from(swap.data);
    must(swap.keys[0].pubkey.equals(s.sdk.poolKey) && swap.keys[1].pubkey.toBase58() === owner && swap.keys.every(k => !k.isSigner || k.pubkey.toBase58() === owner), 'The PumpSwap instruction identity is invalid.', 'PUMP_CLASSIC_TRADE');
    if (side === 'buy') { Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]).copy(data, 0); data.writeBigUInt64LE(input, 8); data.writeBigUInt64LE(quote.minimum, 16); }
    // A temporary wrapped-SOL account keeps any existing WSOL untouched.
    const seed = createHash('sha256').update(owner + mint + Date.now() + Math.random()).digest('hex').slice(0, 32), temporary = await PublicKey.createWithSeed(pk(owner), seed, pk(TOKEN_PROGRAM));
    const rent = await this.rentExempt(165), funding = rent + (side === 'buy' ? input : 0n);
    const instructions = [web3Ix(computeUnitLimit(260000)), web3Ix(computeUnitPrice(20000)), SystemProgram.createAccountWithSeed({ fromPubkey: pk(owner), basePubkey: pk(owner), seed, newAccountPubkey: temporary, lamports: Number(funding), space: 165, programId: pk(TOKEN_PROGRAM) }), spl.createInitializeAccountInstruction(temporary, pk(NATIVE_MINT), pk(owner))];
    if (!s.baseExists) instructions.push(spl.createAssociatedTokenAccountIdempotentInstruction(pk(owner), pk(s.baseAta), pk(owner), pk(mint), pk(TOKEN_2022_PROGRAM)));
    instructions.push(new TransactionInstruction({ programId: pk(PUMP_AMM_PROGRAM), data, keys: swap.keys.map(k => ({ ...k, pubkey: k.pubkey.toBase58() === s.quoteAta ? temporary : k.pubkey })) }), spl.createCloseAccountInstruction(temporary, pk(owner), pk(owner)));
    return this.signTrade({ signer, owner, mint, ata: s.baseAta, side, input, quote, plain: instructions, native: s.native, tokens: s.base, minContextSlot: s.slot, venue: 'amm' });
  }
  /** Adds liquidity to the canonical pool within explicit base/quote maximums; LP tokens stay in the strategy wallet. */
  async prepareLpDeposit({ wallet: signer, mint, maxBase, maxQuote, slippageBps = 100 }) {
    const owner = signer?.address, { sdk, BN } = await this.ammSdk(), s = await this.ammSnapshot(mint, owner);
    const state = await new sdk.OnlinePumpAmmSdk(this.c).liquiditySolanaState(s.sdk.poolKey, pk(owner)), slip = slippageBps / 100;
    const fromBase = sdk.PUMP_AMM_SDK.depositBaseInput(state, new BN(big(maxBase).toString()), slip), fromQuote = sdk.PUMP_AMM_SDK.depositQuoteInput(state, new BN(big(maxQuote).toString()), slip);
    const lp = BN.min(fromBase.lpToken, fromQuote.lpToken); must(!lp.isZero(), 'The contribution is too small for this pool.', 'PUMP_CLASSIC_LP');
    const built = await sdk.PUMP_AMM_SDK.depositInstructionsInternal(state, lp, new BN(big(maxBase).toString()), new BN(big(maxQuote).toString()));
    return this.signLiquidity({ signer, owner, mint, s, kind: 'lp-deposit', instructions: built, expectLp: big(lp.toString()), maxBase: big(maxBase), maxQuote: big(maxQuote) });
  }
  async prepareLpWithdraw({ wallet: signer, mint, lpAmount, slippageBps = 100 }) {
    const owner = signer?.address, { sdk, BN } = await this.ammSdk(), s = await this.ammSnapshot(mint, owner);
    const state = await new sdk.OnlinePumpAmmSdk(this.c).liquiditySolanaState(s.sdk.poolKey, pk(owner));
    const built = await sdk.PUMP_AMM_SDK.withdrawInstructions(state, new BN(big(lpAmount).toString()), slippageBps / 100);
    return this.signLiquidity({ signer, owner, mint, s, kind: 'lp-withdraw', instructions: built, expectLp: -big(lpAmount) });
  }
  async signLiquidity({ signer, owner, mint, s, kind, instructions, expectLp, maxBase = 0n, maxQuote = 0n }) {
    must(instructions.every(ix => ix.keys.every(k => !k.isSigner || k.pubkey.toBase58() === owner)), 'The liquidity instruction needs another signer.', 'PUMP_CLASSIC_LP');
    const block = await this.c.getLatestBlockhash('confirmed'), all = [web3Ix(computeUnitLimit(300000)), web3Ix(computeUnitPrice(20000)), ...instructions];
    const message = new TransactionMessage({ payerKey: pk(owner), recentBlockhash: block.blockhash, instructions: all }).compileToV0Message();
    must(message.header.numRequiredSignatures === 1 && transactionSize(message) <= 1232, 'The liquidity transaction is too large.', 'PUMP_CLASSIC_LP');
    const fee = big((await this.c.getFeeForMessage(message, 'confirmed'))?.value), tx = new VersionedTransaction(message), watch = [owner, s.baseAta, s.lpAta];
    const sim = await this.simulatePrepared(tx, { sigVerify: false, commitment: 'confirmed', minContextSlot: s.slot, accounts: { encoding: 'base64', addresses: watch } }, block.lastValidBlockHeight);
    if (sim.value?.err) throw launchSimulationError(tx, sim.value, 'trade');
    const lpBefore = await this.tokenBalance(s.lpAta, s.lpProgram), lpAfter = sim.value.accounts?.[2] ? fx.readTokenAccount(simAccount(sim.value.accounts[2]), { owner }).amount : 0n, lpDelta = lpAfter - lpBefore;
    const baseAfter = sim.value.accounts?.[1] ? fx.readTokenAccount(simAccount(sim.value.accounts[1]), { program: TOKEN_2022_PROGRAM, mint, owner }).amount : 0n, baseDelta = baseAfter - s.base, solDelta = BigInt(sim.value.accounts?.[0]?.lamports ?? 0) - s.native;
    if (kind === 'lp-deposit') must(lpDelta >= expectLp * 99n / 100n && -baseDelta <= maxBase && -solDelta <= maxQuote + fee + 6000000n, 'The deposit simulation exceeds its maximums or mints too few LP tokens.', 'PUMP_CLASSIC_SIMULATION');
    else must(lpDelta === expectLp && baseDelta >= 0n, 'The withdrawal simulation burns a different LP amount.', 'PUMP_CLASSIC_SIMULATION');
    const keys = [keypair(signer, owner)]; let bytes;
    try { tx.sign(keys); bytes = Buffer.from(tx.serialize()); verifySignedTransaction(bytes, owner); } finally { wipe(keys); }
    return { kind, wallet: owner, mint, signature: bs58.encode(tx.signatures[0]), raw: bytes.toString('base64'), rawHash: sha(bytes), ...block, preparedSlot: sim.context?.slot ?? s.slot, lpAta: s.lpAta, baseAta: s.baseAta, expected: { lp: lpDelta.toString(), base: baseDelta.toString(), sol: solDelta.toString(), feeLamports: fee.toString(), maxBase: maxBase.toString(), maxQuote: maxQuote.toString() } };
  }
  async tokenBalance(account, program) { const info = await this.c.getAccountInfo(pk(account), 'confirmed'); return info ? fx.readTokenAccount(info, { program }).amount : 0n; }
  async liquidityReceipt(op) {
    this.verifySaved(op); const tx = await this.finalized(op.signature); if (!tx) return null;
    const keys = fx.txKeys(tx), fee = big(tx.meta.fee), failed = tx.meta.err !== null;
    const lp = fx.tokenAmount(tx, keys, 'post', op.lpAta) - fx.tokenAmount(tx, keys, 'pre', op.lpAta), base = fx.tokenAmount(tx, keys, 'post', op.baseAta) - fx.tokenAmount(tx, keys, 'pre', op.baseAta), sol = fx.lamportDelta(tx, keys, op.wallet);
    if (failed) { must(lp === 0n && base === 0n, 'A failed liquidity transaction moved tokens.', 'PUMP_CLASSIC_RECEIPT'); return { state: 'failed', signature: op.signature, slot: tx.slot, feeLamports: fee, lpDelta: 0n, baseDelta: 0n, solDelta: sol }; }
    if (op.kind === 'lp-deposit') must(lp > 0n && -base <= big(op.expected.maxBase) && -sol <= big(op.expected.maxQuote) + fee + 6000000n, 'The finalized deposit differs from its reviewed maximums.', 'PUMP_CLASSIC_RECEIPT');
    else must(lp < 0n && base >= 0n, 'The finalized withdrawal differs from its reviewed LP amount.', 'PUMP_CLASSIC_RECEIPT');
    return { state: 'confirmed', signature: op.signature, slot: tx.slot, feeLamports: fee, lpDelta: lp, baseDelta: base, solDelta: sol };
  }
}
export { SYSTEM_PROGRAM };
