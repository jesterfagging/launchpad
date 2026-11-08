import { randomBytes } from 'node:crypto';
import { PublicKey, SystemProgram, TransactionInstruction, AddressLookupTableAccount, AddressLookupTableProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, unpackMint, getTransferFeeConfig, getTransferHook, createInitializeAccount3Instruction, createCloseAccountInstruction } from '@solana/spl-token';
import BN from 'bn.js';
import { PUMP_SDK, GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, bondingCurvePda, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } from '@pump-fun/pump-sdk';
import { LaunchpadPool, LaunchpadConfig, PlatformConfig, Curve, getPdaLaunchpadPoolId, getPdaLaunchpadAuth, getPdaPlatformVault, getPdaCreatorVault, buyExactInInstruction, sellExactInInstruction } from '@raydium-io/raydium-sdk-v2';
import { SOL, PUMP, LAUNCHLAB, invariant, DirectRouteUnavailableError } from './core.mjs';

const pk = s => new PublicKey(s), bn = n => new BN(String(n));
const minOut = (amount, bps) => BigInt(amount.toString()) * BigInt(10000 - bps) / 10000n;
const convertIx = ix => new TransactionInstruction({ programId: pk(ix.programId), keys: ix.accounts.map(a => ({ pubkey: pk(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(ix.data, 'base64') });
export function mintInfo(mint, account) {
  invariant(account && [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(account.owner.toBase58()), 'Unsupported mint owner.');
  const info = unpackMint(mint, account, account.owner);
  // The extension can exist with no configured program. That is a disabled hook,
  // represented by the all-zero public key, and does not require extra accounts.
  const hook = getTransferHook(info);
  if (hook && !hook.programId.equals(PublicKey.default)) throw new DirectRouteUnavailableError(`Active transfer hook on mint ${mint.toBase58()}.`);
  return { info, program: account.owner, transferFees: getTransferFeeConfig(info) || undefined };
}
export class LaunchRouter {
  constructor(providers) { this.p = providers; this.cache = new Map(); this.lookupCache = new Map(); }
  async discover(mint, signal) {
    // A manual buy has a mint but no lead instruction to supply its launch
    // venue. Derive the curve address instead of relying on an indexer to have
    // listed a newly launched token. Other/graduated tokens use normal routing.
    const base = pk(mint), pool = bondingCurvePda(base);
    const { values: [curveAccount, baseAccount] } = await this.accounts([pool, base], 0, signal);
    invariant(!this.p.closed && !signal?.aborted, 'Stopped.');
    if (!curveAccount || !curveAccount.owner.equals(pk(PUMP))) return null;
    invariant(baseAccount && [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(baseAccount.owner.toBase58()), 'Pump base mint program is unavailable.');
    const curve = PUMP_SDK.decodeBondingCurve(curveAccount);
    if (curve.complete || curve.virtualTokenReserves.isZero()) return null;
    return { type: 'pump', pool: pool.toBase58(), baseMint: base.toBase58(),
      quoteMint: curve.quoteMint.equals(PublicKey.default) ? SOL : curve.quoteMint.toBase58(),
      baseTokenProgram: baseAccount.owner.toBase58(), lookupTables: [] };
  }
  async accounts(keys, slot, signal) {
    const response = this.p.readAccounts ? await this.p.readAccounts(keys, slot, signal)
      : await this.p.rpc('getMultipleAccounts', [keys.map(String), { encoding: 'base64', commitment: 'processed', ...(slot ? { minContextSlot: slot } : {}) }], signal);
    return { slot: response.context.slot, values: response.value.map(a => a && ({ ...a, data: Buffer.from(a.data[0], 'base64'), owner: pk(a.owner) })) };
  }
  async state(venue, slot, signal) {
    const key = `${venue.type}:${venue.pool}:${slot || 0}`;
    const old = this.cache.get(key);
    if (old && (!old.settled || Date.now() - old.at < 200)) return old.promise;
    const entry = { at:Date.now(), settled:false };
    const promise = this.loadState(venue, slot, signal).then(value => {
      entry.settled = true; entry.at = Date.now(); return value;
    }, error => { if (this.cache.get(key) === entry) this.cache.delete(key); throw error; });
    entry.promise = promise; this.cache.set(key, entry);
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
    return promise;
  }
  async lookups(keys, signal) {
    const requested = [...new Set(keys || [])].slice(0, 16), now = Date.now();
    const missing = requested.filter(key => !this.lookupCache.has(key) || now - this.lookupCache.get(key).at >= 30000);
    if (missing.length) {
      // All lead tables share one read, including concurrent follower builds.
      const batch = this.accounts(missing, 0, signal);
      missing.forEach((key, index) => {
        const entry = { at: now };
        entry.promise = batch.then(({ values }) => {
          const account = values[index];
          return account?.owner.equals(AddressLookupTableProgram.programId) ? AddressLookupTableAccount.deserialize(account.data).addresses.map(String) : null;
        }).catch(error => { if (this.lookupCache.get(key) === entry) this.lookupCache.delete(key); throw error; });
        this.lookupCache.set(key, entry);
      });
    }
    const entries = await Promise.all(requested.map(async key => [key, await this.lookupCache.get(key).promise]));
    return Object.fromEntries(entries.filter(([, addresses]) => addresses));
  }
  async loadState(v, slot, signal) {
    const base = pk(v.baseMint), quote = pk(v.quoteMint);
    if (v.type === 'pump') {
      const curveKey = bondingCurvePda(base);
      invariant(curveKey.toBase58() === v.pool, 'Pump curve does not match its mint.');
      const { values: [curveAccount, baseAccount, quoteAccount, globalAccount, feeAccount] } = await this.accounts([curveKey, base, quote, GLOBAL_PDA, PUMP_FEE_CONFIG_PDA], slot, signal);
      invariant(curveAccount?.owner.equals(pk(PUMP)) && globalAccount?.owner.equals(pk(PUMP)) && feeAccount, 'Pump state is unavailable.');
      const curve = PUMP_SDK.decodeBondingCurve(curveAccount);
      const quoteMint = curve.quoteMint.equals(PublicKey.default) ? SOL : curve.quoteMint.toBase58();
      invariant(quoteMint === v.quoteMint, 'Launchpad quote mint differs from the observed pair.');
      if (curve.complete || curve.virtualTokenReserves.isZero()) return { graduated: true };
      invariant(!v.baseTokenProgram || baseAccount?.owner.toBase58() === v.baseTokenProgram, 'Pump base mint program differs from the processed trade event.');
      const baseInfo = mintInfo(base, baseAccount), quoteInfo = mintInfo(quote, quoteAccount);
      if (baseInfo.transferFees || quoteInfo.transferFees) throw new DirectRouteUnavailableError('Pump direct route cannot calculate this pair\'s transfer fees.');
      return { base, quote, baseInfo, quoteInfo, curve, curveAccount, global: PUMP_SDK.decodeGlobal(globalAccount), feeConfig: PUMP_SDK.decodeFeeConfig(feeAccount) };
    }
    const program = pk(LAUNCHLAB), poolKey = getPdaLaunchpadPoolId(program, base, quote).publicKey;
    invariant(poolKey.toBase58() === v.pool, 'LaunchLab pool does not match the observed mints.');
    const { values: [poolAccount, baseAccount, quoteAccount], slot: stateSlot } = await this.accounts([poolKey, base, quote], slot, signal);
    invariant(poolAccount?.owner.equals(program), 'LaunchLab pool is unavailable.');
    const pool = LaunchpadPool.decode(poolAccount.data);
    invariant(pool.mintA.equals(base) && pool.mintB.equals(quote), 'LaunchLab pool mint mismatch.');
    if (pool.status !== 0) return { graduated: true };
    const { values: [configAccount, platformAccount] } = await this.accounts([pool.configId, pool.platformId], slot, signal);
    invariant(configAccount?.owner.equals(program) && platformAccount?.owner.equals(program), 'LaunchLab configuration is unavailable.');
    return { base, quote, baseInfo: mintInfo(base, baseAccount), quoteInfo: mintInfo(quote, quoteAccount), pool, config: LaunchpadConfig.decode(configAccount.data), platform: PlatformConfig.decode(platformAccount.data), stateSlot };
  }
  async build(order, wallet, signal, maxAccounts) {
    const v = order.venue;
    if (!v || !['pump', 'launchlab'].includes(v.type)) return null;
    const isBuy = order.outputMint === v.baseMint;
    if (!isBuy && (order.inputMint !== v.baseMint || order.outputMint !== v.quoteMint)) return null;
    const needsFunding = isBuy && order.inputMint !== v.quoteMint;
    // The funding quote is independent of the pool read. Fetch both together,
    // then validate the fresh pool and build its buy from this quote's minimum.
    const fundingRequest = needsFunding ? this.p.jupiterBuild({ ...order, outputMint: v.quoteMint }, wallet, signal, maxAccounts)
      .then(value => ({ value }), error => ({ error })) : Promise.resolve({});
    const [s, leadAlts, fundingResult] = await Promise.all([this.state(v, order.slot, signal), this.lookups(v.lookupTables, signal), fundingRequest]);
    if (s.graduated) return null; // Jupiter handles migrated PumpSwap / Raydium pools when indexed.
    invariant(!v.baseTokenProgram || s.baseInfo.program.toBase58() === v.baseTokenProgram, 'Pump base mint program differs from the processed trade event.');
    if (fundingResult.error) throw fundingResult.error;
    let spend = order.amount, prefix = [], suffix = [], alts = leadAlts, blockhash, fundingLeg;
    if (needsFunding) {
      // Atomically acquire the quote asset first. Spend only its guaranteed minimum output.
      const funding = fundingResult.value;
      spend = BigInt(funding.otherAmountThreshold);
      fundingLeg = { inputMint: order.inputMint, outputMint: v.quoteMint, inAmount: String(order.amount), outAmount: funding.outAmount, minimumOutput: String(spend) };
      prefix = [...(funding.setupInstructions || []), funding.swapInstruction, ...(funding.cleanupInstruction ? [funding.cleanupInstruction] : []), ...(funding.otherInstructions || [])].map(convertIx);
      alts = { ...leadAlts, ...(funding.addressesByLookupTableAddress || {}) }; blockhash = funding.blockhashWithMetadata;
    }
    const owner = pk(wallet.publicKey), baseATA = getAssociatedTokenAddressSync(s.base, owner, false, s.baseInfo.program);
    const instructions = [createAssociatedTokenAccountIdempotentInstruction(owner, baseATA, owner, s.base, s.baseInfo.program)];
    let quoteAccount = getAssociatedTokenAddressSync(s.quote, owner, false, s.quoteInfo.program);
    if (v.quoteMint !== SOL) instructions.push(createAssociatedTokenAccountIdempotentInstruction(owner, quoteAccount, owner, s.quote, s.quoteInfo.program));
    let out;
    if (v.type === 'pump') {
      const args = { global: s.global, feeConfig: s.feeConfig, mintSupply: bn(s.baseInfo.info.supply), bondingCurve: s.curve };
      if (isBuy) {
        const expected = getBuyTokenAmountFromSolAmount({ ...args, amount: bn(spend), quoteMint: s.quote });
        out = minOut(expected, this.p.c.slippageBps);
        invariant(out > 0n, 'Pump quote rounds to zero.');
        instructions.push(...await PUMP_SDK.buyV2Instructions({ ...args, bondingCurveAccountInfo: s.curveAccount, associatedUserAccountInfo: { data: Buffer.alloc(0) }, mint: s.base, user: owner, amount: bn(out), quoteAmount: bn(spend), slippage: 0, tokenProgram: s.baseInfo.program, quoteTokenProgram: s.quoteInfo.program }));
        const impact = 100 * (1 - Number(expected.toString()) * Number(s.curve.virtualQuoteReserves.toString()) / (Number(spend) * Number(s.curve.virtualTokenReserves.toString())));
        invariant(impact <= this.p.c.maxPriceImpact, 'Pump curve exceeds your price-impact limit.');
      } else {
        const expected = getSellSolAmountFromTokenAmount({ ...args, amount: bn(spend) }); out = BigInt(expected.toString());
        const impact = 100 * (1 - Number(out) * Number(s.curve.virtualTokenReserves.toString()) / (Number(spend) * Number(s.curve.virtualQuoteReserves.toString())));
        invariant(impact <= this.p.c.maxPriceImpact, 'Pump sell exceeds your price-impact limit.');
        const minimum = minOut(expected, this.p.c.slippageBps);
        invariant(minimum > 0n, 'Pump sell output rounds to zero.');
        instructions.push(...await PUMP_SDK.sellV2Instructions({ ...args, bondingCurveAccountInfo: s.curveAccount, mint: s.base, user: owner, amount: bn(spend), quoteAmount: bn(minimum), slippage: 0, tokenProgram: s.baseInfo.program, quoteTokenProgram: s.quoteInfo.program }));
      }
    } else {
      if (v.quoteMint === SOL) {
        const seed = randomBytes(16).toString('hex');
        quoteAccount = await PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID);
        const rent = await this.p.rpc('getMinimumBalanceForRentExemption', [165], signal);
        const funding = BigInt(rent) + (isBuy ? spend : 0n);
        invariant(funding <= BigInt(Number.MAX_SAFE_INTEGER), 'SOL amount exceeds the supported funding range.');
        instructions.push(SystemProgram.createAccountWithSeed({ fromPubkey: owner, basePubkey: owner, newAccountPubkey: quoteAccount, seed, lamports: Number(funding), space: 165, programId: TOKEN_PROGRAM_ID }), createInitializeAccount3Instruction(quoteAccount, s.quote, owner));
        suffix.push(createCloseAccountInstruction(quoteAccount, owner, owner));
      }
      const quoteArgs = { poolInfo: s.pool, protocolFeeRate: s.config.tradeFeeRate, platformFeeRate: s.platform.feeRate, creatorFeeRate: s.platform.creatorFeeRate, curveType: s.config.curveType,
        shareFeeRate: new BN(0), transferFeeConfigA: s.baseInfo.transferFees, transferFeeConfigB: s.quoteInfo.transferFees, slot: s.stateSlot };
      const result = isBuy ? Curve.buyExactIn({ ...quoteArgs, amountB: bn(spend) }) : Curve.sellExactIn({ ...quoteArgs, amountA: bn(spend) });
      out = BigInt((isBuy ? result.amountA.amount.sub(result.amountA.fee || new BN(0)) : result.amountB).toString());
      const minimum = minOut(out, this.p.c.slippageBps);
      invariant(minimum > 0n, 'LaunchLab quote rounds to zero.');
      const spot = Number(Curve.getPrice({ poolInfo: s.pool, curveType: s.config.curveType, decimalA: 0, decimalB: 0 }).toString());
      const execution = isBuy ? Number(spend) / Number(out) : Number(out) / Number(spend);
      const impact = isBuy ? 100 * (execution / spot - 1) : 100 * (1 - execution / spot);
      invariant(Number.isFinite(impact) && impact <= this.p.c.maxPriceImpact, 'LaunchLab route exceeds your price-impact limit.');
      const program = pk(LAUNCHLAB);
      const exactSpend = isBuy && BigInt(result.amountB.toString()) < spend ? BigInt(result.amountB.toString()) : spend;
      instructions.push((isBuy ? buyExactInInstruction : sellExactInInstruction)(program, owner, getPdaLaunchpadAuth(program).publicKey, s.pool.configId, s.pool.platformId, pk(v.pool), baseATA, quoteAccount, s.pool.vaultA, s.pool.vaultB, s.base, s.quote, s.baseInfo.program, s.quoteInfo.program,
        getPdaPlatformVault(program, s.pool.platformId, s.quote).publicKey, getPdaCreatorVault(program, s.pool.creator, s.quote).publicKey, bn(exactSpend), bn(minimum), new BN(0)));
    }
    if (!blockhash) {
      if (!this.p.blockhash || Date.now() - this.p.blockhash.at > 15000) await this.p.refreshBlockhash(signal);
      blockhash = this.p.blockhash;
    }
    return { inputMint: order.inputMint, outputMint: order.outputMint, outputDecimals: isBuy ? s.baseInfo.info.decimals : s.quoteInfo.info?.decimals, inAmount: order.amount.toString(), outAmount: out.toString(),
      otherAmountThreshold: minOut(out, this.p.c.slippageBps).toString(), nativeInstructions: [...prefix, ...instructions, ...suffix], addressesByLookupTableAddress: alts, blockhashWithMetadata: blockhash, fundingLeg,
      routeName: `${prefix.length ? 'Jupiter → ' : ''}${v.type === 'pump' ? 'Pump curve' : 'LaunchLab curve'}` };
  }
}
