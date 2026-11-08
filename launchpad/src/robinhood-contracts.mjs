import { parseAbi, parseAbiParameters, encodeAbiParameters, keccak256, getAddress } from 'viem';
import { ROBINHOOD, EVM_NATIVE } from '../public/chains.mjs';

// Official Uniswap deployment registry and Doppler SDK 1.0.43, chain 4663.
export const CONTRACTS = Object.freeze(Object.fromEntries(Object.entries({
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  router: '0x204FAca1764B154221e35c0d20aBb3c525710498',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  // Canonical bridge asset: https://docs.robinhood.com/chain/contracts/
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  airlock: '0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862',
  ponsFactory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  ponsHook: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
  ponsV1Factory: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB',
  v2Factory: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f',
  v2Router: '0x89e5db8b5aa49aa85ac63f691524311aeb649eba',
  v3Factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  v3Quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  v3PositionManager: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
}).map(([k, v]) => [k, getAddress(v.toLowerCase())])));
export const poolType = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
export const poolParameters = parseAbiParameters(poolType);
export const poolId = pool => pool.protocol && pool.protocol !== 'v4' ? `${pool.protocol}:${pool.address.toLowerCase()}` : keccak256(encodeAbiParameters(poolParameters, [pool]));
export const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function uiMultiplier() view returns (uint256)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
export const routerAbi = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable', 'function poolManager() view returns (address)']);
export const permitAbi = parseAbi(['function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)', 'function approve(address token,address spender,uint160 amount,uint48 expiration)']);
export const poolAbi = parseAbi(['event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)', 'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)']);
export const stateAbi = parseAbi(['function getSlot0(bytes32) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)', 'function getLiquidity(bytes32) view returns (uint128)']);
export const quoterAbi = parseAbi([`struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }`, 'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }', 'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut,uint256 gasEstimate)']);
export const airlockAbi = parseAbi(['event Create(address asset,address indexed numeraire,address initializer,address poolOrHook)', 'function getAssetData(address asset) view returns (address numeraire,address timelock,address governance,address liquidityMigrator,address poolInitializer,address pool,address migrationPool,uint256 numTokensToSell,uint256 totalSupply,address integrator)']);
export const hookKeyAbi = parseAbi(['function poolKey() view returns (address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)']);
const poolStruct = 'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }';
// Official Doppler SDK: multicurve and shared-hook initializer variants.
export const initializerAbis = [
  parseAbi([poolStruct, 'function getState(address asset) view returns (address numeraire,uint8 status,PoolKey poolKey,int24 farTick)']),
  parseAbi([poolStruct, 'function getState(address asset) view returns (address numeraire,uint256 totalTokensOnBondingCurve,address dopplerHook,bytes graduationDopplerHookCalldata,uint8 status,PoolKey poolKey,int24 farTick)']),
];
export const migrationKeyAbi = parseAbi([poolStruct, 'function getAssetData(address token0,address token1) view returns (bool isToken0,PoolKey poolKey,uint32 lockDuration,uint24 feeOrInitialDynamicFee,bool useDynamicFee,address dopplerHook,bytes onInitializationCalldata,uint8 status)']);
export const ponsAbi = parseAbi(['struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }', 'function getLaunchedToken(address token) view returns (LaunchedToken)', 'event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)']);
export const positionAbi = parseAbi([`struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }`, 'function modifyLiquidities(bytes unlockData,uint256 deadline) payable', 'function getPositionLiquidity(uint256 tokenId) view returns (uint128)', 'function getPoolAndPositionInfo(uint256 tokenId) view returns (PoolKey poolKey,uint256 info)', 'function ownerOf(uint256 tokenId) view returns (address)', 'function nextTokenId() view returns (uint256)', 'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
export const ROBINHOOD_CHAIN = { id: ROBINHOOD.id, name: ROBINHOOD.name, nativeCurrency: { name: 'Robinhood ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [ROBINHOOD.rpc] } } };
export { EVM_NATIVE };
