import { encodeFunctionData, parseAbi, toHex } from 'viem';
import { CONTRACTS, EVM_NATIVE, poolId, positionAbi } from './robinhood-contracts.mjs';
import { v3PositionAbi } from './robinhood-legacy-contracts.mjs';
import { encode, minimumOut } from './robinhood-pools.mjs';
import { liveLpLiquidity, liquidityForAmounts, amountsForLiquidity } from './robinhood-liquidity.mjs';

const max128 = 2n ** 128n - 1n, wrap256 = n => BigInt.asUintN(256, n);
const feeStateAbi = parseAbi(['function getPositionInfo(bytes32,address,int24,int24,bytes32) view returns (uint128,uint256,uint256)', 'function getFeeGrowthInside(bytes32,int24,int24) view returns (uint256,uint256)']);
export async function buildFeeClaim({ rpc, lot, wallet, slippageBps }) {
  if (lot.pool.protocol === 'v2') throw Error('Uniswap v2 retains trading fees in the LP reserves automatically. Withdraw LP liquidity to realize those fees.');
  if (!await liveLpLiquidity(rpc, { ...lot, wallet })) throw Error('This wallet no longer owns an active LP position.');
  const id = BigInt(lot.tokenId), deadline = Math.floor(Date.now() / 1000) + 120;
  if (lot.pool.protocol === 'v3') {
    const args = [{ tokenId: id, recipient: wallet, amount0Max: max128, amount1Max: max128 }];
    const { result } = await rpc.client.simulateContract({ address: CONTRACTS.v3PositionManager, abi: v3PositionAbi, functionName: 'collect', args, account: wallet });
    if (!result[0] && !result[1]) return null;
    return { to: CONTRACTS.v3PositionManager, data: encodeFunctionData({ abi: v3PositionAbi, functionName: 'collect', args }), value: 0n, approvals: [], amounts: result.map(String), minimumAmounts: ['0', '0'], deadline };
  }
  const key = poolId(lot.pool);
  const [position, inside] = await Promise.all([
    rpc.client.readContract({ address: CONTRACTS.stateView, abi: feeStateAbi, functionName: 'getPositionInfo', args: [key, CONTRACTS.positionManager, lot.lower, lot.upper, toHex(id, { size: 32 })] }),
    rpc.client.readContract({ address: CONTRACTS.stateView, abi: feeStateAbi, functionName: 'getFeeGrowthInside', args: [key, lot.lower, lot.upper] }),
  ]);
  const amounts = inside.map((n, i) => wrap256(n - position[i + 1]) * position[0] / (2n ** 128n));
  if (!amounts[0] && !amounts[1]) return null;
  const minimums = amounts.map(n => minimumOut(n, slippageBps));
  // TAKE enforces the native-ETH lower bound used by receipt accounting. The
  // final TAKE_PAIR returns any fee growth since the quote to the same owner.
  let actions = '01'; const inputs = [encode('uint256,uint256,uint128,uint128,bytes', [id, 0n, 0n, 0n, '0x'])];
  for (let i = 0; i < 2; i++) if (minimums[i]) { actions += '0e'; inputs.push(encode('address,address,uint256', [i ? lot.pool.currency1 : lot.pool.currency0, wallet, minimums[i]])); }
  actions += '11'; inputs.push(encode('address,address,address', [lot.pool.currency0, lot.pool.currency1, wallet]));
  return { to: CONTRACTS.positionManager, data: encodeFunctionData({ abi: positionAbi, functionName: 'modifyLiquidities', args: [encode('bytes,bytes[]', [`0x${actions}`, inputs]), BigInt(deadline)] }), value: 0n, approvals: [], amounts: amounts.map(String), minimumAmounts: minimums.map(String), deadline };
}
export async function buildFeeCompound({ rpc, pools, lot, wallet, amounts, slippageBps }) {
  if (lot.pool.protocol === 'v2') return null;
  if (!await liveLpLiquidity(rpc, { ...lot, wallet })) throw Error('The LP position is no longer active.');
  const state = await pools.state(lot.pool), amount0 = BigInt(amounts[lot.pool.currency0] || 0), amount1 = BigInt(amounts[lot.pool.currency1] || 0);
  const liquidity = minimumOut(liquidityForAmounts(state.sqrtPriceX96, lot.lower, lot.upper, amount0, amount1, lot.pool.protocol !== 'v3'), slippageBps);
  if (!liquidity || liquidity >= 2n ** 128n) return null;
  const deadline = Math.floor(Date.now() / 1000) + 120, id = BigInt(lot.tokenId), required = amountsForLiquidity(state.sqrtPriceX96, lot.lower, lot.upper, liquidity);
  let to, data;
  if (lot.pool.protocol === 'v3') {
    to = CONTRACTS.v3PositionManager;
    data = encodeFunctionData({ abi: v3PositionAbi, functionName: 'increaseLiquidity', args: [{ tokenId: id, amount0Desired: amount0, amount1Desired: amount1, amount0Min: minimumOut(required[0], slippageBps), amount1Min: minimumOut(required[1], slippageBps), deadline: BigInt(deadline) }] });
  } else {
    to = CONTRACTS.positionManager;
    // Increasing an existing position also credits newly accrued fees. Either
    // asset can therefore finish in credit, even though liquidity increased.
    // CLOSE_CURRENCY pays debt or returns credit; SETTLE_PAIR would revert on
    // a positive delta. The final sweep refunds unused native funding.
    const inputs = [encode('uint256,uint256,uint128,uint128,bytes', [id, liquidity, amount0, amount1, '0x']), encode('address', [lot.pool.currency0]), encode('address', [lot.pool.currency1]), encode('address,address', [EVM_NATIVE, wallet])];
    data = encodeFunctionData({ abi: positionAbi, functionName: 'modifyLiquidities', args: [encode('bytes,bytes[]', ['0x00121214', inputs]), BigInt(deadline)] });
  }
  return { to, data, value: lot.pool.currency0 === EVM_NATIVE ? amount0 : 0n, approvals: [lot.pool.currency0, lot.pool.currency1].map((token, i) => ({ token, amount: String(i ? amount1 : amount0), spender: to, ...(lot.pool.protocol === 'v3' ? { mode: 'erc20' } : {}) })).filter(r => r.token !== EVM_NATIVE && BigInt(r.amount) > 0n), liquidity: String(liquidity), maximums: [String(amount0), String(amount1)], deadline };
}
