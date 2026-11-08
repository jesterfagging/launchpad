import { createRequire } from 'node:module';
const { TickMath } = createRequire(import.meta.url)('@uniswap/v3-sdk');
import { encodeFunctionData } from 'viem';
import { CONTRACTS, positionAbi, poolType, EVM_NATIVE } from './robinhood-contracts.mjs';
import { encode, minimumOut, otherCurrency } from './robinhood-pools.mjs';
import { pairAbi, v2RouterAbi, v3PositionAbi, adapterAbi } from './robinhood-legacy-contracts.mjs';
import { erc20Abi } from './robinhood-contracts.mjs';

const Q96 = 2n ** 96n;
export const sqrtAtTick = tick => BigInt(TickMath.getSqrtRatioAtTick(tick).toString());
export function rangeTicks(tick, spacing, preset, rangeBps = 2000) {
  const width = ({ conservative: 5000, balanced: 2000, active: 700 })[preset] || rangeBps;
  const distance = Math.ceil(Math.log(1 + width / 10000) / Math.log(1.0001));
  const min = Math.ceil(-887272 / spacing) * spacing, max = Math.floor(887272 / spacing) * spacing;
  const lower = Math.max(min, Math.floor((tick - distance) / spacing) * spacing), upper = Math.min(max, Math.ceil((tick + distance) / spacing) * spacing);
  if (lower >= tick || upper <= tick) throw Error('Pool price is too close to its tick boundary.'); return { lower, upper };
}
export function liquidityForAmounts(price, lower, upper, amount0, amount1, fullPrecision = true) {
  const a = sqrtAtTick(lower), b = sqrtAtTick(upper);
  // V3's NonfungiblePositionManager uses LiquidityAmounts, which rounds the
  // price product before multiplying by amount0. Match it for v3 quotes;
  // explicit-liquidity v4 calls can use the full-precision amount bound.
  const from0 = (p, q) => fullPrecision ? amount0 * p * q / (q - p) / Q96 : amount0 * (p * q / Q96) / (q - p);
  if (price <= a) return from0(a, b);
  if (price >= b) return amount1 * Q96 / (b - a);
  const l0 = from0(price, b), l1 = amount1 * Q96 / (price - a); return l0 < l1 ? l0 : l1;
}
export function amountsForLiquidity(price, lower, upper, liquidity) {
  const a = sqrtAtTick(lower), b = sqrtAtTick(upper);
  const p = price < a ? a : price > b ? b : price;
  return [liquidity * (b - p) * Q96 / p / b, liquidity * (p - a) / Q96];
}
export function lpFeePpm(fee) { return fee <= 500 ? 50 : fee <= 3000 ? 150 : 250; }
export async function referenceEth(pools, pool, amounts, feePool) {
  let value = 0n;
  for (const [i, input] of [pool.currency0, pool.currency1].entries()) {
    let amount = amounts[i], currency = input; if (!amount) continue;
    if (![EVM_NATIVE, CONTRACTS.weth].includes(input)) for (const hop of await pools.feePath(input, pool, feePool)) { amount = await pools.quote(hop, currency, amount); currency = otherCurrency(hop, currency); }
    if (![EVM_NATIVE, CONTRACTS.weth].includes(currency)) throw Error('An executable ETH reference route is required for automatic LP fees.'); value += amount;
  }
  return value;
}
export async function buildLpDeposit({ pools, pool, wallet, amount0, amount1, preset, rangeBps, slippageBps }) {
  if (pool.protocol && pool.protocol !== 'v4') return legacyDeposit({ pools, pool, wallet, amount0, amount1, preset, rangeBps, slippageBps });
  const state = await pools.state(pool), { lower, upper } = rangeTicks(state.tick, pool.tickSpacing, preset, rangeBps);
  // Explicit liquidity with maxima prevents the delta-mint sandwich weakness.
  const liquidity = minimumOut(liquidityForAmounts(state.sqrtPriceX96, lower, upper, amount0, amount1), slippageBps);
  if (liquidity <= 0n || liquidity >= 2n ** 128n || amount0 >= 2n ** 128n || amount1 >= 2n ** 128n) throw Error('LP amount is outside the supported range.');
  const actions = '0x020d14', inputs = [
    encode(`${poolType},int24,int24,uint256,uint128,uint128,address,bytes`, [pool, lower, upper, liquidity, amount0, amount1, wallet, '0x']),
    encode('address,address', [pool.currency0, pool.currency1]), encode('address,address', [EVM_NATIVE, wallet]),
  ];
  const deadline = Math.floor(Date.now() / 1000) + 120;
  return { to: CONTRACTS.positionManager, data: encodeFunctionData({ abi: positionAbi, functionName: 'modifyLiquidities', args: [encode('bytes,bytes[]', [actions, inputs]), BigInt(deadline)] }),
    value: pool.currency0 === EVM_NATIVE ? amount0 : 0n, approvals: [pool.currency0, pool.currency1].map((token, i) => ({ token, amount: String(i ? amount1 : amount0), spender: CONTRACTS.positionManager })).filter(a => a.token !== EVM_NATIVE && BigInt(a.amount) > 0n), liquidity: String(liquidity), lower, upper, pool, deadline };
}
export async function buildLpWithdrawal({ rpc, pools, lot, wallet, automatic, recipient, adapter, slippageBps, feePool }) {
  if (lot.pool.protocol && lot.pool.protocol !== 'v4') return legacyWithdrawal({ rpc, pools, lot, wallet, automatic, recipient, adapter, slippageBps, feePool });
  const id = BigInt(lot.tokenId), owner = await rpc.client.readContract({ address: CONTRACTS.positionManager, abi: positionAbi, functionName: 'ownerOf', args: [id] });
  if (owner.toLowerCase() !== wallet.toLowerCase()) throw Error('The LP receipt no longer belongs to this wallet.');
  const liveLiquidity = await rpc.client.readContract({ address: CONTRACTS.positionManager, abi: positionAbi, functionName: 'getPositionLiquidity', args: [id] });
  if (!liveLiquidity) throw Error('This LP position is already empty.');
  const state = await pools.state(lot.pool), amounts = amountsForLiquidity(state.sqrtPriceX96, lot.lower, lot.upper, liveLiquidity);
  const ppm = automatic ? lpFeePpm(state.fee) : 0, feeEth = automatic ? await referenceEth(pools, lot.pool, amounts, feePool) * BigInt(ppm) / 1000000n : 0n;
  const actions = feeEth ? '0x011114' : '0x0111';
  const inputs = [encode('uint256,uint256,uint128,uint128,bytes', [id, liveLiquidity, minimumOut(amounts[0], slippageBps), minimumOut(amounts[1], slippageBps), '0x']), encode('address,address,address', [lot.pool.currency0, lot.pool.currency1, wallet])];
  // The fee is supplied as ETH; LP proceeds go directly from PoolManager to the
  // owner before this sweep. A reverted withdrawal reverts the fee as well.
  if (feeEth) inputs.push(encode('address,address', [EVM_NATIVE, recipient]));
  const deadline = Math.floor(Date.now() / 1000) + 120;
  return { to: CONTRACTS.positionManager, data: encodeFunctionData({ abi: positionAbi, functionName: 'modifyLiquidities', args: [encode('bytes,bytes[]', [actions, inputs]), BigInt(deadline)] }), value: feeEth, approvals: [], feeEth: String(feeEth), ppm, recipient, input: EVM_NATIVE, amount: String(feeEth), deadline, amounts: amounts.map(String), minimumAmounts: amounts.map(a => String(minimumOut(a, slippageBps))) };
}

async function legacyDeposit({ pools, pool, wallet, amount0, amount1, preset, rangeBps, slippageBps }) {
  const state = await pools.state(pool), deadline = Math.floor(Date.now() / 1000) + 120;
  if (amount0 <= 0n || amount1 <= 0n) throw Error('Both pool assets are required for this LP deposit.');
  if (pool.protocol === 'v2') {
    const [r0, r1] = state.reserves, supply = await pools.client.readContract({ address: pool.address, abi: pairAbi, functionName: 'totalSupply' });
    const optimal1 = amount0 * r1 / r0, used0 = optimal1 > amount1 ? amount1 * r0 / r1 : amount0, used1 = optimal1 > amount1 ? amount1 : optimal1;
    const min0 = minimumOut(used0, slippageBps), min1 = minimumOut(used1, slippageBps);
    if (!min0 || !min1 || !supply) throw Error('The v2 LP deposit is too small.');
    return { to: CONTRACTS.v2Router, data: encodeFunctionData({ abi: v2RouterAbi, functionName: 'addLiquidity', args: [pool.currency0, pool.currency1, amount0, amount1, min0, min1, wallet, BigInt(deadline)] }), value: 0n, approvals: [pool.currency0, pool.currency1].map((token, i) => ({ token, amount: String(i ? amount1 : amount0), spender: CONTRACTS.v2Router, mode: 'erc20' })), liquidity: String(used0 * supply / r0), lower: null, upper: null, pool, deadline };
  }
  if (pool.protocol !== 'v3') throw Error('User liquidity is available after a Pons curve graduates to Uniswap.');
  const { lower, upper } = rangeTicks(state.tick, pool.tickSpacing, preset, rangeBps), liquidity = liquidityForAmounts(state.sqrtPriceX96, lower, upper, amount0, amount1, false);
  if (!liquidity || liquidity >= 2n ** 128n) throw Error('LP amount is outside the supported range.');
  const amounts = amountsForLiquidity(state.sqrtPriceX96, lower, upper, liquidity);
  return { to: CONTRACTS.v3PositionManager, data: encodeFunctionData({ abi: v3PositionAbi, functionName: 'mint', args: [{ token0: pool.currency0, token1: pool.currency1, fee: pool.fee, tickLower: lower, tickUpper: upper, amount0Desired: amount0, amount1Desired: amount1, amount0Min: minimumOut(amounts[0], slippageBps), amount1Min: minimumOut(amounts[1], slippageBps), recipient: wallet, deadline: BigInt(deadline) }] }), value: 0n, approvals: [pool.currency0, pool.currency1].map((token, i) => ({ token, amount: String(i ? amount1 : amount0), spender: CONTRACTS.v3PositionManager, mode: 'erc20' })), liquidity: String(liquidity), lower, upper, pool, deadline };
}
export async function liveLpLiquidity(rpc, lot) {
  if (lot.pool.protocol === 'v2') { const balance = await rpc.balance(lot.wallet, lot.pool.address), owned = BigInt(lot.liquidity); return balance < owned ? balance : owned; }
  const manager = lot.pool.protocol === 'v3' ? CONTRACTS.v3PositionManager : CONTRACTS.positionManager, abi = lot.pool.protocol === 'v3' ? v3PositionAbi : positionAbi;
  const owner = await rpc.client.readContract({ address: manager, abi, functionName: 'ownerOf', args: [BigInt(lot.tokenId)] });
  if (owner.toLowerCase() !== lot.wallet.toLowerCase()) return 0n;
  if (lot.pool.protocol === 'v3') { const p = await rpc.client.readContract({ address: manager, abi, functionName: 'positions', args: [BigInt(lot.tokenId)] });
    if (p[2].toLowerCase() !== lot.pool.currency0.toLowerCase() || p[3].toLowerCase() !== lot.pool.currency1.toLowerCase() || p[4] !== lot.pool.fee || p[5] !== lot.lower || p[6] !== lot.upper) throw Error('The live v3 position does not match the recorded pool and range.'); return p[7]; }
  return rpc.client.readContract({ address: manager, abi, functionName: 'getPositionLiquidity', args: [BigInt(lot.tokenId)] });
}
async function legacyWithdrawal({ rpc, pools, lot, wallet, automatic, recipient, adapter, slippageBps, feePool }) {
  const pool = await pools.validate(lot.pool, null, null, { allowInactive: true }), liquidity = await liveLpLiquidity(rpc, { ...lot, wallet });
  if (!liquidity) throw Error('This LP position is empty or no longer owned by the wallet.');
  const state = await pools.state(pool);
  let amounts;
  if (pool.protocol === 'v2') {
    const supply = await rpc.client.readContract({ address: pool.address, abi: pairAbi, functionName: 'totalSupply' });
    amounts = state.reserves.map(r => r * liquidity / supply);
  } else amounts = amountsForLiquidity(state.sqrtPriceX96, lot.lower, lot.upper, liquidity);
  const minimums = amounts.map(a => minimumOut(a, slippageBps)), ppm = automatic ? lpFeePpm(state.fee) : 0, feeEth = automatic ? await referenceEth(pools, pool, amounts, feePool) * BigInt(ppm) / 1000000n : 0n;
  const deadline = Math.floor(Date.now() / 1000) + 120;
  let to, data, approvals;
  if (!automatic && pool.protocol === 'v3') {
    to = CONTRACTS.v3PositionManager; approvals = [];
    data = encodeFunctionData({ abi: v3PositionAbi, functionName: 'multicall', args: [[encodeFunctionData({ abi: v3PositionAbi, functionName: 'decreaseLiquidity', args: [{ tokenId: BigInt(lot.tokenId), liquidity, amount0Min: minimums[0], amount1Min: minimums[1], deadline: BigInt(deadline) }] }), encodeFunctionData({ abi: v3PositionAbi, functionName: 'collect', args: [{ tokenId: BigInt(lot.tokenId), recipient: wallet, amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n }] })]] });
  } else if (!automatic && pool.protocol === 'v2') {
    to = CONTRACTS.v2Router; approvals = [{ token: pool.address, amount: String(liquidity), spender: to, mode: 'erc20' }];
    data = encodeFunctionData({ abi: v2RouterAbi, functionName: 'removeLiquidity', args: [pool.currency0, pool.currency1, liquidity, minimums[0], minimums[1], wallet, BigInt(deadline)] });
  } else {
    if (!adapter) throw Error('The Robinhood execution contract must be configured before automatic LP adjustments.');
    to = adapter;
    approvals = pool.protocol === 'v2' ? [{ token: pool.address, amount: String(liquidity), spender: adapter, mode: 'erc20' }] : [{ token: CONTRACTS.v3PositionManager, amount: lot.tokenId, spender: adapter, mode: 'nft' }];
    data = encodeFunctionData({ abi: adapterAbi, functionName: pool.protocol === 'v2' ? 'withdrawV2' : 'withdrawV3', args: [pool.protocol === 'v2' ? pool.address : BigInt(lot.tokenId), liquidity, minimums[0], minimums[1], recipient, feeEth, BigInt(deadline)] });
  }
  return { to, data, value: feeEth, approvals, feeEth: String(feeEth), ppm, recipient, input: EVM_NATIVE, amount: String(feeEth), deadline, amounts: amounts.map(String), minimumAmounts: minimums.map(String) };
}
