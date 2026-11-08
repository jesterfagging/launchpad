// Robinhood Chain (chain 4663) addresses the launch venue reads: Uniswap v4 from the official deployment registry
// (the same values src/robinhood-contracts.mjs records for the trading toolkit; kept here without that module's viem
// dependency), the canonical USDG, and the Robinhood stock-token API.
import { checksumAddress } from '../evm/secp256k1.mjs';

export const ROBINHOOD_ADDRESSES = Object.freeze({
  poolManager: checksumAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951'),
  quoter: checksumAddress('0x8dc178efb8111bb0973dd9d722ebeff267c98f94'),
  stateView: checksumAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'),
  weth: checksumAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
  usdg: checksumAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
  v3Factory: checksumAddress('0x1f7d7550b1b028f7571e69a784071f0205fd2efa'),
});
export const ROBINHOOD_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
export const ROBINHOOD_ASSETS_URL = 'https://api.robinhood.com/rhj/assets';
export const robinhoodPriceUrl = symbol => `https://api.robinhood.com/rhj/prices/${encodeURIComponent(symbol)}`;
export const ROBINHOOD_EXPLORER_URL = 'https://robinhoodchain.blockscout.com';

/** The quoter's and state view's ABI fragments (Uniswap v4 periphery). */
export const quoterAbi = [
  { type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'poolKey', type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] },
    { name: 'zeroForOne', type: 'bool' }, { name: 'exactAmount', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }],
    outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }] },
];
export const v3FactoryAbi = [{ type: 'function', name: 'getPool', stateMutability: 'view', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'fee', type: 'uint24' }], outputs: [{ name: 'pool', type: 'address' }] }];
export const v3PoolAbi = [{ type: 'function', name: 'slot0', stateMutability: 'view', inputs: [], outputs: [{ name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }, { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' }, { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' }, { name: 'unlocked', type: 'bool' }] }];
/** The v4 fee / tick-spacing pairs the ETH reference price is probed on, most common first. */
export const V4_FEE_TIERS = Object.freeze([[500, 10], [3000, 60], [10000, 200], [100, 1]]);
export const V3_FEE_TIERS = Object.freeze([500, 3000, 10000, 100]);
