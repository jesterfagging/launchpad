import { randomUUID, createHash } from 'node:crypto';
import { PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, NATIVE_MINT, ACCOUNT_SIZE, MintLayout, unpackMint, unpackAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createInitializeAccountInstruction, createCloseAccountInstruction } from '@solana/spl-token';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, poolPda, lpMintPda, buyQuoteInput, sellBaseInput } from '@pump-fun/pump-swap-sdk';
import BN from 'bn.js';
import bs58 from 'bs58';
import { units, displayUnits, requireValue as ok } from '../public/launchpad-model.mjs';
import { verifySignedTransaction } from './providers.mjs';
import { signer, launchSimulationError } from './launchpad-chain.mjs';
import { decodeState, PUBLIC_PROGRAM_ID } from './pump-public-client.mjs';

const pk = x => new PublicKey(x), bn = x => new BN(String(x));
const plans = new WeakMap(), MAX_U64 = (1n << 64n) - 1n, NETWORK = 25000n;
const BUY = Buffer.from([102,6,61,18,1,218,235,234]);
const EXACT_BUY = Buffer.from([198,46,21,82,180,217,232,112]);
const SELL = Buffer.from([51,230,133,164,1,127,131,173]);
const identity = launch => createHash('sha256').update(JSON.stringify([launch.keys?.mint?.address, launch.review?.publicProgramId, launch.review?.stateAddress, launch.review?.custodyAuthority, launch.review?.poolId])).digest('hex');
const token = (key, info, mint, owner, optional = false) => {
  if (!info && optional) return null;
  ok(info && !info.executable && info.owner.equals(TOKEN_PROGRAM_ID), 'The PumpSwap token account is unavailable.');
  const value = unpackAccount(key, info, TOKEN_PROGRAM_ID);
  ok(value.isInitialized && !value.isFrozen && value.mint.equals(mint) && value.owner.equals(owner), 'The PumpSwap token account identity is invalid.');
  return value;
};
const snapshot = (result, count, minimum = 0) => {
  ok(Number.isSafeInteger(result?.context?.slot) && result.context.slot >= minimum && Array.isArray(result.value) && result.value.length === count, 'The RPC returned an incomplete PumpSwap snapshot.');
  return result;
};

/** Direct trades only in the exact pool recorded by a graduated Launchpad PDA.
 * No launch creator key or platform signer is used in user trades. */
export async function pumpAmmSnapshot(chain, launch, wallet) {
  ok(launch.input?.route === 'pumpswap' && launch.input.network === 'mainnet-beta' && launch.input.quoteMint === NATIVE_MINT.toBase58(), 'This PumpSwap pair is unsupported.');
  const mint = pk(launch.keys.mint.address), program = pk(launch.review.publicProgramId), state = pk(launch.review.stateAddress), vault = pk(launch.review.custodyAuthority), poolKey = pk(launch.review.poolId), user = pk(wallet);
  ok(program.toBase58() === PUBLIC_PROGRAM_ID, 'Unknown Launchpad custody program.');
  ok(PublicKey.isOnCurve(user.toBytes()), 'Connect a Solana wallet to trade.');
  ok(PublicKey.findProgramAddressSync([Buffer.from('curve'), mint.toBuffer()], program)[0].equals(state) && PublicKey.findProgramAddressSync([Buffer.from('vault'), mint.toBuffer()], program)[0].equals(vault), 'The Launchpad custody address differs from this launch.');
  const first = snapshot(await chain.c.getMultipleAccountsInfoAndContext([state, poolKey, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, mint, NATIVE_MINT], { commitment: 'confirmed' }), 6);
  const [saved, poolInfo, globalInfo, feeInfo, mintInfo, quoteInfo] = first.value;
  ok(saved && !saved.executable && saved.owner.equals(program), 'The saved graduation is unavailable.');
  // Versioned public layout is separately checked by the launch service. This
  // proof binds the immutable mint, completed phase, burned LP and exact pool.
  const completed = decodeState(saved, program);
  ok(completed.phase === 2 && completed.mint === mint.toBase58() && BigInt(completed.burnedLp) > 0n && completed.pool === poolKey.toBase58(), 'This coin has not completed its verified PumpSwap graduation.');
  ok(poolInfo && !poolInfo.executable && poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID) && globalInfo && !globalInfo.executable && globalInfo.owner.equals(PUMP_AMM_PROGRAM_ID), 'The PumpSwap pool or configuration owner is invalid.');
  ok(!feeInfo || !feeInfo.executable && feeInfo.owner.equals(PUMP_FEE_PROGRAM_ID), 'The PumpSwap fee configuration owner is invalid.');
  const pool = PUMP_AMM_SDK.decodePool(poolInfo), globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(globalInfo), feeConfig = feeInfo ? PUMP_AMM_SDK.decodeFeeConfig(feeInfo) : null;
  ok(pool.baseMint.equals(mint) && pool.quoteMint.equals(NATIVE_MINT) && pool.creator.equals(vault) && poolPda(pool.index, vault, mint, NATIVE_MINT).equals(poolKey) && lpMintPda(poolKey).equals(pool.lpMint), 'The graduated pool does not belong to this launch.');
  ok(pool.coinCreator.equals(PublicKey.default) && !pool.isMayhemMode && !pool.isCashbackCoin && (!pool.virtualQuoteReserves || pool.virtualQuoteReserves.isZero()), 'The PumpSwap pool has unsupported trading terms.');
  ok(mintInfo && !mintInfo.executable && mintInfo.owner.equals(TOKEN_PROGRAM_ID) && quoteInfo && !quoteInfo.executable && quoteInfo.owner.equals(TOKEN_PROGRAM_ID), 'The PumpSwap mint program is invalid.');
  const mintState = unpackMint(mint, mintInfo, TOKEN_PROGRAM_ID), quoteState = unpackMint(NATIVE_MINT, quoteInfo, TOKEN_PROGRAM_ID);
  ok(mintState.isInitialized && mintState.decimals === 6 && !mintState.mintAuthority && !mintState.freezeAuthority && mintState.supply <= 1000000000000000n && quoteState.decimals === 9, 'The PumpSwap token mint differs from the reviewed launch.');
  const baseAta = getAssociatedTokenAddressSync(mint, user), quoteAta = getAssociatedTokenAddressSync(NATIVE_MINT, user);
  ok(pool.poolBaseTokenAccount.equals(getAssociatedTokenAddressSync(mint, poolKey, true)) && pool.poolQuoteTokenAccount.equals(getAssociatedTokenAddressSync(NATIVE_MINT, poolKey, true)), 'The PumpSwap pool vaults are invalid.');
  const second = snapshot(await chain.c.getMultipleAccountsInfoAndContext([pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount, user, baseAta, quoteAta], { commitment: 'confirmed', minContextSlot: first.context.slot }), 5, first.context.slot);
  const [poolBase, poolQuote, native, baseInfo, wsolInfo] = second.value;
  const baseReserve = token(pool.poolBaseTokenAccount, poolBase, mint, poolKey), quoteReserve = token(pool.poolQuoteTokenAccount, poolQuote, NATIVE_MINT, poolKey);
  ok(baseReserve.amount > 0n && quoteReserve.amount > 0n, 'The PumpSwap pool has no available liquidity.');
  ok(!native || !native.executable && native.owner.equals(SystemProgram.programId) && Number.isSafeInteger(native.lamports) && native.lamports >= 0, 'The trading wallet account is invalid.');
  const base = token(baseAta, baseInfo, mint, user, true), wsol = token(quoteAta, wsolInfo, NATIVE_MINT, user, true);
  return { user, mint, baseAta, quoteAta, base, wsol, native: BigInt(native?.lamports || 0), slot: second.context.slot,
    sdk: { globalConfig, feeConfig, poolKey, poolAccountInfo: poolInfo, pool, poolBaseAmount: bn(baseReserve.amount), poolQuoteAmount: bn(quoteReserve.amount), baseTokenProgram: TOKEN_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID, baseMint: mint, baseMintAccount: MintLayout.decode(mintInfo.data), user, userBaseTokenAccount: baseAta, userQuoteTokenAccount: quoteAta, userBaseAccountInfo: baseInfo, userQuoteAccountInfo: wsolInfo } };
}

export async function pumpAmmBalances(chain, launch, { wallet }) {
  const s = await pumpAmmSnapshot(chain, launch, wallet);
  return { nativeBalanceLamports: s.native.toString(), baseBalanceRaw: (s.base?.amount || 0n).toString(), baseDecimals: 6, quoteBalanceRaw: s.native.toString(), quoteDecimals: 9, baseSymbol: launch.input.symbol, quoteSymbol: 'SOL', slot: s.slot };
}

export async function quotePumpAmm(chain, launch, { wallet, side, amount, slippageBps = 100 }) {
  ok(['buy','sell'].includes(side) && Number.isInteger(slippageBps) && slippageBps >= 0 && slippageBps <= 10000, 'Choose a trade and slippage between 0% and 100%.');
  ok(typeof amount === 'string' && amount.length <= 48 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount), 'Enter a positive amount.');
  const raw = units(amount, side === 'buy' ? 9 : 6); ok(raw > 0n && raw <= MAX_U64, 'The trade amount is outside the supported range.');
  const s = await pumpAmmSnapshot(chain, launch, wallet), p = s.sdk.pool;
  const args = { slippage: 0, baseReserve: s.sdk.poolBaseAmount, quoteReserve: s.sdk.poolQuoteAmount, globalConfig: s.sdk.globalConfig, baseMintAccount: s.sdk.baseMintAccount, baseMint: s.mint, coinCreator: p.coinCreator, creator: p.creator, feeConfig: s.sdk.feeConfig, quoteMint: NATIVE_MINT, isMayhemMode: false, creatorFeeBps: p.creatorFeeBps };
  const expected = BigInt((side === 'buy' ? buyQuoteInput({ ...args, quote: bn(raw) }).base : sellBaseInput({ ...args, base: bn(raw) }).uiQuote).toString());
  ok(expected > 0n, 'This amount is too small to trade.');
  const minimum = expected * BigInt(10000 - slippageBps) / 10000n;
  // Bound temporary WSOL plus first-trade ATA/volume/venue account creation.
  // The complete simulation below checks the actual debit against this budget.
  const rent = BigInt(await chain.c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)) * 5n + BigInt(await chain.c.getMinimumBalanceForRentExemption(256));
  ok(s.native >= rent + NETWORK + (side === 'buy' ? raw : 0n), 'Insufficient SOL for this trade and possible first-trade account deposits.');
  ok(side !== 'sell' || (s.base?.amount || 0n) >= raw, 'Insufficient token balance.');
  const quote = Object.freeze({ wallet, side, amount, amountRaw: raw.toString(), inputMint: (side === 'buy' ? NATIVE_MINT : s.mint).toBase58(), outputMint: (side === 'buy' ? s.mint : NATIVE_MINT).toBase58(), inputSymbol: side === 'buy' ? 'SOL' : launch.input.symbol, outputSymbol: side === 'buy' ? launch.input.symbol : 'SOL', inputDecimals: side === 'buy' ? 9 : 6, outputDecimals: side === 'buy' ? 6 : 9, expectedOutputRaw: expected.toString(), minimumOutputRaw: minimum.toString(), expectedOutput: displayUnits(expected, side === 'buy' ? 6 : 9), minimumOutput: displayUnits(minimum, side === 'buy' ? 6 : 9), slippageBps, slot: s.slot, expiresAt: Date.now() + 30000, balanceRaw: (side === 'buy' ? s.native : s.base?.amount || 0n).toString(), nativeBalanceLamports: s.native.toString(), market: 'pumpswap', pool: p ? s.sdk.poolKey.toBase58() : '', networkFeeLamports: NETWORK.toString(), rentLamports: rent.toString(), quoteSymbol: 'SOL' });
  plans.set(quote, { chain, identity: identity(launch), snapshot: s }); return quote;
}

export async function pumpAmmInstructions(chain, quote) {
  const plan = plans.get(quote); ok(plan?.chain === chain && quote.expiresAt > Date.now(), 'The PumpSwap quote expired.');
  const s = plan.snapshot, raw = BigInt(quote.amountRaw), minimum = BigInt(quote.minimumOutputRaw);
  // SDK supplies the current canonical venue accounts. Only the locally built
  // swap is retained; our own temporary WSOL account preserves existing WSOL.
  const sdkInstructions = quote.side === 'buy' ? await PUMP_AMM_SDK.buyInstructionsNoPool(s.sdk, bn(minimum), bn(raw)) : await PUMP_AMM_SDK.sellInstructionsNoPool(s.sdk, bn(raw), bn(minimum));
  const swaps = sdkInstructions.filter(ix => ix.programId.equals(PUMP_AMM_PROGRAM_ID));
  ok(swaps.length === 1, 'Unexpected PumpSwap instruction set.');
  const swap = swaps[0], wanted = quote.side === 'buy' ? BUY : SELL;
  ok(swap.data.subarray(0,8).equals(wanted) && swap.keys[0].pubkey.equals(s.sdk.poolKey) && swap.keys[1].pubkey.equals(s.user) && swap.keys[5].pubkey.equals(s.baseAta) && swap.keys[6].pubkey.equals(s.quoteAta), 'The PumpSwap instruction identity is invalid.');
  ok(swap.keys.every(k => !k.isSigner || k.pubkey.equals(s.user)), 'Unexpected PumpSwap signer.');
  const data = Buffer.from(swap.data);
  if (quote.side === 'buy') { EXACT_BUY.copy(data, 0); data.writeBigUInt64LE(raw, 8); data.writeBigUInt64LE(minimum, 16); }
  const seed = randomUUID().replaceAll('-', ''), temporary = await PublicKey.createWithSeed(s.user, seed, TOKEN_PROGRAM_ID), rent = BigInt(await chain.c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)), funding = rent + (quote.side === 'buy' ? raw : 0n);
  ok(funding <= BigInt(Number.MAX_SAFE_INTEGER), 'The SOL trade amount is too large.');
  const instructions = [SystemProgram.createAccountWithSeed({ fromPubkey: s.user, basePubkey: s.user, seed, newAccountPubkey: temporary, lamports: Number(funding), space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }), createInitializeAccountInstruction(temporary, NATIVE_MINT, s.user)];
  if (!s.base) instructions.push(createAssociatedTokenAccountIdempotentInstruction(s.user, s.baseAta, s.user, s.mint));
  instructions.push(new TransactionInstruction({ programId: PUMP_AMM_PROGRAM_ID, data, keys: swap.keys.map(k => ({ ...k, pubkey: k.pubkey.equals(s.quoteAta) ? temporary : k.pubkey })) }), createCloseAccountInstruction(temporary, s.user, s.user));
  return instructions;
}

export async function preparePumpAmm(chain, launch, intent, { external, secret, authorize } = {}) {
  const original = plans.get(intent);
  ok(original?.chain === chain && original.identity === identity(launch) && intent.expiresAt > Date.now(), 'The PumpSwap quote expired. Review again.');
  ok(typeof external === 'boolean' && (external ? !secret : typeof secret === 'string' && secret.length > 0), 'The selected wallet cannot sign this trade.');
  const fresh = await quotePumpAmm(chain, launch, intent), plan = plans.get(fresh), s = plan.snapshot;
  ok(fresh.pool === intent.pool && BigInt(fresh.minimumOutputRaw) >= BigInt(intent.minimumOutputRaw) && BigInt(fresh.rentLamports) <= BigInt(intent.rentLamports), 'The price or account costs changed. Review a new quote.');
  const instructions = await pumpAmmInstructions(chain, fresh), selected = { address: intent.wallet, external: true };
  const op = await chain.prepare({ ...launch, keys: { ...launch.keys, wallet: selected, payer: selected } }, instructions, [], 'trade', { minContextSlot: fresh.slot });
  const tx = VersionedTransaction.deserialize(Buffer.from(op.unsignedRaw, 'base64'));
  const sim = await chain.simulatePrepared(tx, { sigVerify: false, commitment: 'confirmed', minContextSlot: fresh.slot, accounts: { encoding: 'base64', addresses: [s.user.toBase58(), s.baseAta.toBase58(), s.quoteAta.toBase58()] } }, op.lastValidBlockHeight);
  if (sim.value.err) throw launchSimulationError(tx, sim.value, 'trade');
  ok(sim.context?.slot >= fresh.slot && sim.value.accounts?.length === 3, 'The RPC omitted the PumpSwap trade balance audit.');
  const [native, baseInfo, wsolInfo] = sim.value.accounts;
  ok(native && !native.executable && native.owner === SystemProgram.programId.toBase58() && Number.isSafeInteger(native.lamports), 'The simulated wallet balance is invalid.');
  const decode = (key, info, mint) => token(key, info ? { ...info, owner: pk(info.owner), data: Buffer.from(info.data[0], 'base64') } : null, mint, s.user, true);
  const base = decode(s.baseAta, baseInfo, s.mint), wsol = decode(s.quoteAta, wsolInfo, NATIVE_MINT);
  for (const [before, after] of [[s.base, base], [s.wsol, wsol]]) {
    if (before) ok(after && String(before.delegate || '') === String(after.delegate || '') && String(before.closeAuthority || '') === String(after.closeAuthority || '') && before.delegatedAmount === after.delegatedAmount, 'The trade changes an existing token-account permission.');
    else if (after) ok(!after.delegate && !after.closeAuthority && after.delegatedAmount === 0n, 'The trade assigns an unexpected token-account permission.');
  }
  ok((wsol?.amount || 0n) === (s.wsol?.amount || 0n) && Boolean(wsol) === Boolean(s.wsol), 'The trade would change an existing wrapped SOL account.');
  const costs = BigInt(fresh.networkFeeLamports) + BigInt(fresh.rentLamports), input = BigInt(fresh.amountRaw), minimum = BigInt(fresh.minimumOutputRaw), afterBase = base?.amount || 0n, beforeBase = s.base?.amount || 0n, afterNative = BigInt(native.lamports);
  if (intent.side === 'buy') ok(afterBase - beforeBase >= minimum && s.native - afterNative <= input + costs, 'The trade exceeds the reviewed SOL spend or minimum output.');
  else ok(beforeBase - afterBase === input && afterNative - s.native + costs >= minimum, 'The trade exceeds the reviewed token spend or minimum output.');
  if (authorize) await authorize();
  let prepared = { ...op, preparedSlot: Math.max(op.preparedSlot || 0, sim.context.slot) };
  if (!external) {
    const key = signer(secret); ok(key.publicKey.equals(s.user), 'The trading signer does not match the reviewed wallet.'); tx.sign([key]);
    const bytes = Buffer.from(tx.serialize()); verifySignedTransaction(bytes, intent.wallet);
    const { unsignedRaw, messageHash, externalSigner, needsSignature, ...validity } = prepared;
    prepared = { ...validity, state: 'pending', signature: bs58.encode(tx.signatures[0]), raw: bytes.toString('base64') };
  }
  plans.delete(intent); plans.delete(fresh);
  return { ...prepared, trade: { wallet: intent.wallet, side: intent.side, inputMint: intent.inputMint, outputMint: intent.outputMint, amountRaw: intent.amountRaw, minimumOutputRaw: fresh.minimumOutputRaw, market: 'pumpswap', pool: intent.pool } };
}
