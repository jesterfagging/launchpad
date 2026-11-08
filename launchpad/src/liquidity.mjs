import liquiditySdks from './liquidity-sdks.cjs';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { getMint, getExtensionTypes, getTransferHook, ExtensionType, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { SOL, PUMP_AMM, invariant } from './core.mjs';
import { jsonFetch } from './providers.mjs';
const PROGRAMS = {
  [PUMP_AMM]: 'PumpSwap',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium CPMM',
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'Meteora DAMM v2',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
};
const bn = n => new BN(String(n));
const min = (a, b) => a < b ? a : b;
// Pool fees are rates on swaps, not LP deposit/withdrawal charges. This is
// Launchpad's half-Krystal automatic-management schedule, in parts per million.
export function liquidityFeeTier(poolFeePpm) {
  invariant(typeof poolFeePpm === 'number' && Number.isFinite(poolFeePpm) && poolFeePpm >= 0 && poolFeePpm <= 1000000,
    'Current pool fee is unavailable; automatic liquidity adjustment is paused.');
  return { poolFeePpm, managementFeePpm: poolFeePpm <= 500 ? 50 : poolFeePpm <= 3000 ? 150 : 250 };
}
function feePpm(numerator, denominator) {
  const raw = numerator?.toString();
  invariant(typeof raw === 'string' && /^\d+$/.test(raw), 'Invalid pool fee metadata.');
  const value = BigInt(raw);
  invariant(value <= BigInt(denominator), 'Invalid pool fee metadata.');
  // SDK numerators are at most 1e9, safely exact as Numbers. Preserve fractional
  // ppm so 500.001 cannot accidentally fall into the <=500 tier.
  return liquidityFeeTier(Number(value) * 1000000 / denominator).poolFeePpm;
}
function matchingPoolMints(pool, a, b) {
  invariant(Array.isArray(pool.mints) && pool.mints.length === 2 && a?.toBase58() === pool.mints[0] && b?.toBase58() === pool.mints[1],
    'Pool mints changed while checking its fee.');
}
export function sdkConnection(p, signal) {
  return new Connection(p.c.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: async (_url, options) => {
    invariant(!signal?.aborted, 'Stopped.');
    const request = JSON.parse(options.body);
    const result = await p.rpc(request.method, request.params, signal);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
}
export async function inspectMints(connection, mints, { routed = false } = {}) {
  const result = {};
  for (const mint of new Set(mints)) {
    const key = new PublicKey(mint), account = await connection.getAccountInfo(key);
    invariant(account && [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(account.owner.toBase58()), 'Pair addresses must be SPL token mints.');
    const info = await getMint(connection, key, 'confirmed', account.owner);
    invariant(info.isInitialized && info.decimals <= 18, 'Unsupported or uninitialized token mint.');
    const allowed = [ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer, ExtensionType.TokenMetadata, ExtensionType.MintCloseAuthority, ExtensionType.PermanentDelegate];
    const hook = getTransferHook(info);
    if (routed || !hook || hook.programId.equals(PublicKey.default)) allowed.push(ExtensionType.TransferHook);
    invariant(getExtensionTypes(info.tlvData).every(e => allowed.includes(e)), 'This strategy does not support this token extension (such as transfer hooks, interest, or rebasing).');
    result[mint] = { mint: info, decimals: info.decimals, program: account.owner };
  }
  return result;
}
export class LiquidityAdapter {
  constructor(p, signal, sdks = liquiditySdks) { this.p = p; this.connection = sdkConnection(p, signal); this.signal = signal; this.sdks = sdks; }
  feesInReserves(position) { return ['PumpSwap', 'Raydium CPMM'].includes(position.venue); }
  async feeAmounts(position) {
    if (this.feesInReserves(position)) return null;
    if (position.venue === 'Meteora DAMM v2') {
      const sdk = this.sdks.damm(), cp = new sdk.CpAmm(this.connection), pool = await cp.fetchPoolState(new PublicKey(position.id)), state = await cp.fetchPositionState(new PublicKey(position.position));
      invariant(state.pool.equals(new PublicKey(position.id)), 'Position pool mismatch.');
      const fees = sdk.getUnClaimLpFee(pool, state); return { [position.mints[0]]: fees.feeTokenA.toString(), [position.mints[1]]: fees.feeTokenB.toString() };
    }
    const DLMM = this.sdks.dlmm(), dl = await DLMM.create(this.connection, new PublicKey(position.id)), current = await dl.getPosition(new PublicKey(position.position));
    return { [position.mints[0]]: current.positionData.feeX.toString(), [position.mints[1]]: current.positionData.feeY.toString() };
  }
  async buildFeeClaim(position, wallet) {
    invariant(!this.feesInReserves(position), 'This pool already retains fees inside its LP reserves. Withdraw liquidity to realize them.');
    const fees = await this.feeAmounts(position); if (!Object.values(fees).some(n => BigInt(n))) return null;
    const owner = new PublicKey(wallet.publicKey), result = { instructions: [], signers: [], lookupTables: [], maxInputs: {}, feeMaximums: fees, partial: false };
    if (position.venue === 'Meteora DAMM v2') {
      const sdk = this.sdks.damm(), cp = new sdk.CpAmm(this.connection), pool = new PublicKey(position.id), state = await cp.fetchPoolState(pool), mints = await inspectMints(this.connection, position.mints);
      const tx = await cp.claimPositionFee({ owner, receiver: owner, pool, position: new PublicKey(position.position), positionNftAccount: new PublicKey(position.nftAccount), tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault, tokenAProgram: mints[position.mints[0]].program, tokenBProgram: mints[position.mints[1]].program });
      result.instructions = tx.instructions;
    } else {
      const DLMM = this.sdks.dlmm(), dl = await DLMM.create(this.connection, new PublicKey(position.id)), current = await dl.getPosition(new PublicKey(position.position));
      const txs = await dl.claimSwapFee({ owner, position: current }); invariant(txs.length, 'No fee claim could be built.');
      result.instructions = txs[0].instructions; result.partial = txs.length > 1; result.lookupTables.push(DLMM.ALT_ADDRESS['mainnet-beta']);
    }
    return result;
  }
  async buildFeeCompound(position, wallet, amounts, strategy) {
    invariant(!this.feesInReserves(position), 'This pool compounds fees in its reserves automatically.');
    const owner = new PublicKey(wallet.publicKey), pool = new PublicKey(position.id), [a, b] = position.mints, maxA = BigInt(amounts[a] || 0), maxB = BigInt(amounts[b] || 0);
    if (!maxA && !maxB) return null;
    const result = { instructions: [], signers: [], lookupTables: [], maxInputs: { [a]: String(maxA), [b]: String(maxB) } };
    if (position.venue === 'Meteora DAMM v2') {
      const sdk = this.sdks.damm(), cp = new sdk.CpAmm(this.connection), state = await cp.fetchPoolState(pool), mints = await inspectMints(this.connection, position.mints), epoch = (await this.connection.getEpochInfo()).epoch;
      const liquidity = cp.getLiquidityDelta({ maxAmountTokenA: bn(maxA), maxAmountTokenB: bn(maxB), sqrtPrice: state.sqrtPrice, sqrtMinPrice: state.sqrtMinPrice, sqrtMaxPrice: state.sqrtMaxPrice, collectFeeMode: state.collectFeeMode, tokenAAmount: state.tokenAAmount, tokenBAmount: state.tokenBAmount, liquidity: state.liquidity, tokenAInfo: { mint: mints[a].mint, currentEpoch: epoch }, tokenBInfo: { mint: mints[b].mint, currentEpoch: epoch } }).muln(10000 - Math.round(strategy.limits.slippagePercent * 100)).divn(10000);
      if (liquidity.isZero()) return null;
      const tx = await cp.addLiquidity({ owner, pool, position: new PublicKey(position.position), positionNftAccount: new PublicKey(position.nftAccount), liquidityDelta: liquidity, maxAmountTokenA: bn(maxA), maxAmountTokenB: bn(maxB), tokenAAmountThreshold: bn(maxA), tokenBAmountThreshold: bn(maxB), tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault, tokenAProgram: mints[a].program, tokenBProgram: mints[b].program });
      result.instructions = tx.instructions;
    } else {
      const DLMM = this.sdks.dlmm(), dl = await DLMM.create(this.connection, pool);
      const tx = await dl.addLiquidityByStrategy({ positionPubKey: new PublicKey(position.position), user: owner, totalXAmount: bn(maxA), totalYAmount: bn(maxB), strategy: { minBinId: position.lower, maxBinId: position.upper, strategyType: DLMM.StrategyType.Spot }, slippage: strategy.limits.slippagePercent });
      result.instructions = tx.instructions; result.lookupTables.push(DLMM.ALT_ADDRESS['mainnet-beta']);
    }
    return result;
  }
  async discover(s, user) {
    if (s.pool) return this.inspect(s.pool, s, user);
    const data = await jsonFetch(`https://api.dexscreener.com/token-pairs/v1/solana/${s.baseMint}`, { signal: this.signal }, 'Pool discovery');
    invariant(Array.isArray(data), 'Pool discovery returned no pairs.');
    const candidates = data.filter(p => p.chainId === 'solana' &&
      [p.baseToken?.address, p.quoteToken?.address].includes(s.baseMint) && [p.baseToken?.address, p.quoteToken?.address].includes(s.quoteMint))
      .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0)).slice(0, 15);
    for (const pair of candidates) {
      const account = await this.connection.getAccountInfo(new PublicKey(pair.pairAddress));
      if (!PROGRAMS[account?.owner?.toBase58()]) continue;
      return this.inspect(pair.pairAddress, s, user);
    }
    throw Error('No supported pool found for these exact mints. Advanced lets you enter a PumpSwap, Raydium CPMM, Meteora DAMM v2, or DLMM pool.');
  }
  async inspect(id, s, user) {
    const key = new PublicKey(id), account = await this.connection.getAccountInfo(key);
    const venue = PROGRAMS[account?.owner?.toBase58()]; invariant(venue, 'Unsupported pool program. Use PumpSwap, Raydium CPMM, Meteora DAMM v2, or DLMM.');
    let a, b, lpMint;
    if (venue === 'PumpSwap') {
      const { OnlinePumpAmmSdk } = this.sdks.pump();
      const state = await new OnlinePumpAmmSdk(this.connection).fetchPool(key);
      a = state.baseMint; b = state.quoteMint; lpMint = state.lpMint.toBase58();
    } else if (venue === 'Raydium CPMM') {
      const { Raydium } = this.sdks.raydium();
      const ray = await Raydium.load({ connection: this.connection, owner: new PublicKey(user), disableLoadToken: true });
      const { poolInfo } = await ray.cpmm.getPoolInfoFromRpc(id);
      a = new PublicKey(poolInfo.mintA.address); b = new PublicKey(poolInfo.mintB.address); lpMint = poolInfo.lpMint.address;
    } else if (venue === 'Meteora DAMM v2') {
      const { CpAmm } = this.sdks.damm();
      const state = await new CpAmm(this.connection).fetchPoolState(key); a = state.tokenAMint; b = state.tokenBMint;
    } else {
      const DLMM = this.sdks.dlmm(); const dl = await DLMM.create(this.connection, key);
      a = dl.lbPair.tokenXMint; b = dl.lbPair.tokenYMint;
    }
    const mints = [a.toBase58(), b.toBase58()];
    invariant(mints.includes(s.baseMint) && mints.includes(s.quoteMint), 'Pool mints do not match the selected pair.');
    const pool = { id, venue, mints, poolFeePpm: null, ...(lpMint ? { lpMint } : {}) };
    try { pool.poolFeePpm = (await this.feeTier(pool)).poolFeePpm; }
    catch (error) {
      // Missing fee metadata must not prevent an initial deposit or a manual
      // withdrawal. A fee-bearing automatic adjustment requires a fresh read.
      if (this.signal?.aborted) throw error;
    }
    return pool;
  }
  async feeTier(pool) {
    invariant(!this.signal?.aborted, 'Stopped.');
    const key = new PublicKey(pool.id), account = await this.connection.getAccountInfo(key);
    invariant(PROGRAMS[account?.owner?.toBase58()] === pool.venue && PROGRAMS[account?.owner?.toBase58()], 'Pool program changed while checking its fee.');
    let rate;
    if (pool.venue === 'Meteora DLMM') {
      const DLMM = this.sdks.dlmm(), dl = await DLMM.create(this.connection, key);
      matchingPoolMints(pool, dl.lbPair.tokenXMint, dl.lbPair.tokenYMint);
      // getDynamicFee returns the total base + variable fee as a PERCENTAGE,
      // with current volatility decay applied. It is not the variable leg alone.
      // Recreate from RPC for every operation; never bill using inspect's cache.
      rate = dl.getDynamicFee().mul(10000).toNumber();
    } else if (pool.venue === 'Raydium CPMM') {
      const { CpmmPoolInfoLayout, CpmmConfigInfoLayout } = this.sdks.raydium();
      const state = CpmmPoolInfoLayout.decode(account.data);
      matchingPoolMints(pool, state.mintA, state.mintB);
      const configAccount = await this.connection.getAccountInfo(state.configId);
      invariant(configAccount?.owner?.equals(account.owner), 'Pool fee configuration is unavailable.');
      const config = CpmmConfigInfoLayout.decode(configAccount.data);
      invariant(typeof state.enableCreatorFee === 'boolean', 'Invalid pool fee metadata.');
      // Protocol/fund shares are already part of tradeFeeRate, not extra fees.
      rate = feePpm(config.tradeFeeRate.add(state.enableCreatorFee ? config.creatorFeeRate : bn(0)), 1000000);
    } else if (pool.venue === 'PumpSwap') {
      const { OnlinePumpAmmSdk, computeFeesBps } = this.sdks.pump();
      const state = await new OnlinePumpAmmSdk(this.connection).swapSolanaState(key, PublicKey.default);
      const p = state.pool;
      matchingPoolMints(pool, p.baseMint, p.quoteMint);
      invariant(state.feeConfig, 'Current PumpSwap fee configuration is unavailable.');
      const fees = computeFeesBps({ globalConfig: state.globalConfig, feeConfig: state.feeConfig, creator: p.creator,
        baseMintSupply: bn(state.baseMintAccount.supply), baseMint: p.baseMint, baseReserve: state.poolBaseAmount,
        quoteReserve: state.poolQuoteAmount.add(p.virtualQuoteReserves || bn(0)), quoteMint: p.quoteMint,
        isMayhemMode: p.isMayhemMode, creatorFeeBps: p.creatorFeeBps });
      rate = feePpm(fees.lpFeeBps.add(fees.protocolFeeBps).add(p.coinCreator.equals(PublicKey.default) ? bn(0) : fees.creatorFeeBps), 10000);
    } else if (pool.venue === 'Meteora DAMM v2') {
      const sdk = this.sdks.damm(), state = await new sdk.CpAmm(this.connection).fetchPoolState(key);
      matchingPoolMints(pool, state.tokenAMint, state.tokenBMint);
      const mode = sdk.getBaseFeeModeFromPodAlignedData(state.poolFees.baseFee.baseFeeInfo.data);
      // Rate-limiter fees depend on trade direction AND size: no single pool
      // rate is defensible for that legacy mode. Leave these pools unclassified.
      invariant(mode !== sdk.BaseFeeMode.RateLimiter, 'A size-dependent pool fee cannot be used for automatic liquidity pricing.');
      invariant(state.activationType === sdk.ActivationType.Slot || state.activationType === sdk.ActivationType.Timestamp, 'Invalid pool activation metadata.');
      const slot = await this.connection.getSlot();
      const point = state.activationType === sdk.ActivationType.Slot ? slot : await this.connection.getBlockTime(slot);
      invariant(Number.isSafeInteger(point) && point >= 0, 'Current pool time is unavailable.');
      const numerator = sdk.getTotalTradingFeeFromIncludedFeeAmount(state.poolFees, bn(point), state.activationPoint, bn(0),
        sdk.TradeDirection.AtoB, sdk.getMaxFeeNumerator(state.feeVersion), state.poolFees.initSqrtPrice, state.sqrtPrice);
      rate = feePpm(numerator, 1000000000);
    }
    invariant(!this.signal?.aborted, 'Stopped.');
    return liquidityFeeTier(rate);
  }
  async build(pool, wallet, amounts, s, position = null) {
    const owner = new PublicKey(wallet.publicKey), key = new PublicKey(pool.id), [a, b] = pool.mints;
    const maxA = BigInt(amounts[a] || 0), maxB = BigInt(amounts[b] || 0), slip = s.limits.slippagePercent;
    const result = { instructions: [], signers: [], lookupTables: [], position: { ...pool }, maxInputs: position ? {} : { [a]: maxA.toString(), [b]: maxB.toString() } };
    if (pool.venue === 'PumpSwap') {
      const { OnlinePumpAmmSdk, PUMP_AMM_SDK: sdk } = this.sdks.pump();
      const state = await new OnlinePumpAmmSdk(this.connection).liquiditySolanaState(key, owner);
      if (position) result.instructions = await sdk.withdrawInstructions(state, bn(position.lpAmount), slip);
      else {
        const fromA = sdk.depositBaseInput(state, bn(maxA), slip), fromB = sdk.depositQuoteInput(state, bn(maxB), slip);
        const lp = BN.min(fromA.lpToken, fromB.lpToken);
        invariant(!lp.isZero(), 'Budget is too small for this pool.');
        // Explicit maximums are the allocated inventory, never the whole wallet.
        result.instructions = await sdk.depositInstructionsInternal(state, lp, bn(maxA), bn(maxB));
      }
    } else if (pool.venue === 'Raydium CPMM') {
      const { Raydium, Percent, TxVersion } = this.sdks.raydium();
      const ray = await Raydium.load({ connection: this.connection, owner, disableLoadToken: true });
      const { poolInfo, poolKeys, rpcData } = await ray.cpmm.getPoolInfoFromRpc(pool.id);
      let built;
      if (position) built = await ray.cpmm.withdrawLiquidity({ poolInfo, poolKeys, lpAmount: bn(position.lpAmount), slippage: new Percent(Math.round(slip * 100), 10000), txVersion: TxVersion.LEGACY });
      else {
        const epochInfo = await this.connection.getEpochInfo();
        const quote = ray.cpmm.computePairAmount({ poolInfo, baseReserve: rpcData.baseReserve, quoteReserve: rpcData.quoteReserve,
          amount: (await import('./core.mjs')).decimal(maxA, poolInfo.mintA.decimals), baseIn: true, epochInfo, slippage: new Percent(0) });
        const another = BigInt(quote.anotherAmount.amount.toString());
        const input = min(maxA, another > 0n ? maxA * maxB / another : maxA) * 9900n / 10000n;
        invariant(input > 0n, 'Budget is too small for this pool.');
        built = await ray.cpmm.addLiquidity({ poolInfo, poolKeys, inputAmount: bn(input), baseIn: true, slippage: new Percent(Math.round(slip * 100), 10000), txVersion: TxVersion.LEGACY });
      }
      result.instructions = built.transaction.instructions; result.signers = built.signers || [];
      invariant(result.instructions.every(ix => ix.programId && ix.keys.every(k => k.pubkey)), 'The required funded token account is not yet available. Wait for quote funding to confirm, then retry.');
      if (poolKeys.lookupTableAccount && poolKeys.lookupTableAccount !== PublicKey.default.toBase58()) result.lookupTables.push(poolKeys.lookupTableAccount);
    } else if (pool.venue === 'Meteora DAMM v2') {
      const sdk = this.sdks.damm(), cp = new sdk.CpAmm(this.connection), state = await cp.fetchPoolState(key);
      const mintInfo = await inspectMints(this.connection, pool.mints), epoch = (await this.connection.getEpochInfo()).epoch;
      const common = { owner, pool: key, tokenAMint: new PublicKey(a), tokenBMint: new PublicKey(b), tokenAProgram: mintInfo[a].program, tokenBProgram: mintInfo[b].program };
      let tx;
      if (position) {
        const ps = await cp.fetchPositionState(new PublicKey(position.position));
        const q = cp.getWithdrawQuote({ liquidityDelta: ps.unlockedLiquidity, minSqrtPrice: state.sqrtMinPrice, maxSqrtPrice: state.sqrtMaxPrice, sqrtPrice: state.sqrtPrice,
          collectFeeMode: state.collectFeeMode, tokenAAmount: state.tokenAAmount, tokenBAmount: state.tokenBAmount, liquidity: state.liquidity,
          tokenATokenInfo: { mint: mintInfo[a].mint, currentEpoch: epoch }, tokenBTokenInfo: { mint: mintInfo[b].mint, currentEpoch: epoch } });
        const minimum = n => n.muln(10000 - Math.round(slip * 100)).divn(10000);
        tx = await cp.removeAllLiquidityAndClosePosition({ owner, position: new PublicKey(position.position), positionNftAccount: new PublicKey(position.nftAccount),
          poolState: state, positionState: ps, tokenAAmountThreshold: minimum(q.outAmountA), tokenBAmountThreshold: minimum(q.outAmountB), vestings: [], currentPoint: bn(Math.floor(Date.now() / 1000)) });
      } else {
        const nft = Keypair.generate(), liquidity = cp.getLiquidityDelta({ maxAmountTokenA: bn(maxA), maxAmountTokenB: bn(maxB), sqrtPrice: state.sqrtPrice,
          sqrtMinPrice: state.sqrtMinPrice, sqrtMaxPrice: state.sqrtMaxPrice, collectFeeMode: state.collectFeeMode,
          tokenAAmount: state.tokenAAmount, tokenBAmount: state.tokenBAmount, liquidity: state.liquidity,
          tokenAInfo: { mint: mintInfo[a].mint, currentEpoch: epoch }, tokenBInfo: { mint: mintInfo[b].mint, currentEpoch: epoch } }).muln(10000 - Math.round(slip * 100)).divn(10000);
        invariant(!liquidity.isZero(), 'Budget is too small for this pool.');
        tx = await cp.createPositionAndAddLiquidity({ ...common, positionNft: nft.publicKey, liquidityDelta: liquidity,
          maxAmountTokenA: bn(maxA), maxAmountTokenB: bn(maxB), tokenAAmountThreshold: bn(maxA), tokenBAmountThreshold: bn(maxB) });
        result.signers = [nft]; Object.assign(result.position, { position: sdk.derivePositionAddress(nft.publicKey).toBase58(), nft: nft.publicKey.toBase58(), nftAccount: sdk.derivePositionNftAccount(nft.publicKey).toBase58() });
      }
      result.instructions = tx.instructions;
    } else {
      const DLMM = this.sdks.dlmm(), dl = await DLMM.create(this.connection, key);
      result.lookupTables.push(DLMM.ALT_ADDRESS['mainnet-beta']);
      if (position) {
        // Remove in bounded slices. A receipt advances to the next slice; a
        // restart fetches remaining liquidity instead of replaying signed work.
        const current = await dl.getPosition(new PublicKey(position.position));
        const occupied = current.positionData.positionBinData.filter(b => BigInt(b.positionLiquidity.toString()) > 0n);
        if (!occupied.length) {
          const fees = current.positionData;
          if (!fees.feeX.isZero() || !fees.feeY.isZero()) {
            const claims = await dl.claimSwapFee({ owner, position: current });
            invariant(claims.length > 0, 'Could not build the remaining fee claim.');
            result.instructions = claims[0].instructions; result.partial = true;
          } else {
            result.instructions = (await dl.closePositionIfEmpty({ owner, position: current })).instructions;
          }
          return result;
        }
        const first = occupied[0].binId, last = Math.min(first + 19, occupied.at(-1).binId);
        const txs = await dl.removeLiquidity({ user: owner, position: new PublicKey(position.position), fromBinId: first, toBinId: last, bps: bn(10000), shouldClaimAndClose: false });
        invariant(txs.length === 1, 'This withdrawal needs multiple transactions; reduce its bin slice before continuing.');
        result.instructions = txs[0].instructions; result.partial = true;
      } else {
        const active = await dl.getActiveBin(), step = dl.lbPair.binStep;
        const bins = Math.floor(s.limits.rangeBins);
        const positionKey = Keypair.generate(), lower = active.binId - bins, upper = active.binId + bins;
        const tx = await dl.initializePositionAndAddLiquidityByStrategy({ positionPubKey: positionKey.publicKey, user: owner, totalXAmount: bn(maxA), totalYAmount: bn(maxB),
          strategy: { minBinId: lower, maxBinId: upper, strategyType: DLMM.StrategyType.Spot }, slippage: slip });
        result.instructions = tx.instructions; result.signers = [positionKey];
        Object.assign(result.position, { position: positionKey.publicKey.toBase58(), lower, upper, binStep: step });
      }
    }
    return result;
  }
  async outOfRange(position) {
    if (position.venue !== 'Meteora DLMM') return false;
    const DLMM = this.sdks.dlmm(), dl = await DLMM.create(this.connection, new PublicKey(position.id));
    const active = await dl.getActiveBin(); return active.binId < position.lower || active.binId > position.upper;
  }
  async positionAmounts(position, wallet) {
    const [a, b] = position.mints, key = new PublicKey(position.id);
    if (position.venue === 'Meteora DLMM') {
      const DLMM = this.sdks.dlmm(), dl = await DLMM.create(this.connection, key), ps = await dl.getPosition(new PublicKey(position.position));
      invariant(ps.positionData.owner.toBase58() === wallet, 'Liquidity position is no longer owned by this wallet.');
      return { [a]: ps.positionData.totalXAmountExcludeTransferFee.toString(), [b]: ps.positionData.totalYAmountExcludeTransferFee.toString() };
    }
    if (position.venue === 'Meteora DAMM v2') {
      const { CpAmm } = this.sdks.damm(), cp = new CpAmm(this.connection), state = await cp.fetchPoolState(key), ps = await cp.fetchPositionState(new PublicKey(position.position));
      const info = await inspectMints(this.connection, position.mints), epoch = (await this.connection.getEpochInfo()).epoch;
      const q = cp.getWithdrawQuote({ liquidityDelta: ps.unlockedLiquidity, minSqrtPrice: state.sqrtMinPrice, maxSqrtPrice: state.sqrtMaxPrice, sqrtPrice: state.sqrtPrice,
        collectFeeMode: state.collectFeeMode, tokenAAmount: state.tokenAAmount, tokenBAmount: state.tokenBAmount, liquidity: state.liquidity,
        tokenATokenInfo: { mint: info[a].mint, currentEpoch: epoch }, tokenBTokenInfo: { mint: info[b].mint, currentEpoch: epoch } });
      return { [a]: q.outAmountA.toString(), [b]: q.outAmountB.toString() };
    }
    invariant(await this.p.balance(wallet, position.lpMint, this.signal) >= BigInt(position.lpAmount), 'LP tokens have been moved outside this allocation.');
    if (position.venue === 'PumpSwap') {
      const { OnlinePumpAmmSdk, PUMP_AMM_SDK } = this.sdks.pump();
      const state = await new OnlinePumpAmmSdk(this.connection).liquiditySolanaState(key, new PublicKey(wallet));
      const q = PUMP_AMM_SDK.withdrawInputs(state, bn(position.lpAmount), 0);
      return { [a]: q.base.toString(), [b]: q.quote.toString() };
    }
    const { Raydium } = this.sdks.raydium(), ray = await Raydium.load({ connection: this.connection, owner: new PublicKey(wallet), disableLoadToken: true });
    const r = await ray.cpmm.getRpcPoolInfo(position.id);
    return { [a]: bn(position.lpAmount).mul(r.baseReserve).div(r.lpAmount).toString(), [b]: bn(position.lpAmount).mul(r.quoteReserve).div(r.lpAmount).toString() };
  }
}
