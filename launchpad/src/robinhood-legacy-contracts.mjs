import { parseAbi } from 'viem';

// ABIs from Uniswap v2/v3 and ponsdotdev/pons-labs (162310f).
export const v2FactoryAbi = parseAbi(['function getPair(address,address) view returns (address)']);
export const v3FactoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
export const pairAbi = parseAbi(['function factory() view returns (address)', 'function token0() view returns (address)', 'function token1() view returns (address)', 'function getReserves() view returns (uint112,uint112,uint32)', 'function totalSupply() view returns (uint256)', 'function kLast() view returns (uint256)', 'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
export const v3PoolAbi = parseAbi(['function factory() view returns (address)', 'function token0() view returns (address)', 'function token1() view returns (address)', 'function fee() view returns (uint24)', 'function tickSpacing() view returns (int24)', 'function liquidity() view returns (uint128)', 'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)']);
export const v3QuoterAbi = parseAbi(['struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }', 'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256,uint160,uint32,uint256)']);
export const v2RouterAbi = parseAbi(['function addLiquidity(address tokenA,address tokenB,uint256 amountADesired,uint256 amountBDesired,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline) returns (uint256,uint256,uint256)', 'function removeLiquidity(address tokenA,address tokenB,uint256 liquidity,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline) returns (uint256,uint256)', 'function factory() view returns (address)', 'function WETH() view returns (address)']);
export const v3PositionAbi = parseAbi([
  'event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
  'struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }',
  'struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }',
  'struct IncreaseLiquidityParams { uint256 tokenId; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'function increaseLiquidity(IncreaseLiquidityParams params) payable returns (uint128,uint256,uint256)',
  'function mint(MintParams params) payable returns (uint256,uint128,uint256,uint256)',
  'function decreaseLiquidity(DecreaseLiquidityParams params) payable returns (uint256,uint256)', 'function collect(CollectParams params) payable returns (uint256,uint256)',
  'function multicall(bytes[] data) payable returns (bytes[])', 'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
  'function ownerOf(uint256) view returns (address)', 'function approve(address,uint256)', 'function getApproved(uint256) view returns (address)', 'function factory() view returns (address)', 'function WETH9() view returns (address)',
]);
export const ponsV1Abi = parseAbi(['struct LaunchedToken { address token; address deployer; address pairedToken; address positionManager; uint256 positionId; uint256 dexId; uint256 launchConfigId; uint256 restrictionsEndBlock; uint256 supply; bool isToken0; uint24 poolFee; bool exists; uint256 initialBuyAmount; }', 'function getLaunchedToken(address token) view returns (LaunchedToken)', 'event TokenLaunched(address indexed token,address indexed deployer,address indexed dexFactory,address pairToken,address pool,uint256 dexId,uint256 launchConfigId,uint256 positionId,uint256 restrictionsEndBlock,uint256 initialBuyAmount)']);
export const curveAbi = parseAbi(['function token() view returns (address)', 'function pairToken() view returns (address)', 'function factory() view returns (address)', 'function getReserves() view returns (uint256,uint256)', 'function realQuoteReserve() view returns (uint256)', 'function sellableTokens() view returns (uint256)', 'function readyToGraduate() view returns (bool)', 'function graduated() view returns (bool)', 'function feeBps() view returns (uint256)', 'function creatorTaxBps() view returns (uint256)', 'function currentSnipeTaxBps(address recipient) view returns (uint256)', 'function buy(uint256,uint256,address) payable returns (uint256)', 'function sell(uint256,uint256,address) returns (uint256)', 'event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 tax)', 'event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 tax)', 'event CurveBuyRefunded(address indexed buyer,uint256 refund)']);
export const adapterAbi = parseAbi([
  'function ponsFactory() view returns (address)', 'function v2Router() view returns (address)', 'function v3PositionManager() view returns (address)',
  'function curveSwap(address token,bool buy,uint256 amount,uint256 minimum,address feeRecipient,uint256 feeEth,uint256 deadline) payable',
  'function tradeEth((address token,bool buy,bool curve,uint256 amount,uint256 minimum,address feeRecipient,uint24 feePpm) trade,(uint8 version,address input,address output,uint24 fee,int24 tickSpacing,address hooks,uint256 minimum)[] route,uint256 deadline) payable',
  'function withdrawV2(address pair,uint256 liquidity,uint256 minimum0,uint256 minimum1,address feeRecipient,uint256 feeEth,uint256 deadline) payable',
  'function withdrawV3(uint256 tokenId,uint128 liquidity,uint256 minimum0,uint256 minimum1,address feeRecipient,uint256 feeEth,uint256 deadline) payable',
  'event PlatformFee(address indexed wallet,address indexed recipient,uint256 amount,bytes4 operation)',
  'event CurveTraded(address indexed wallet,address indexed token,bool buy,uint256 inputSpent,uint256 output)',
  'event EthTraded(address indexed wallet,address indexed token,bool buy,uint256 inputSpent,uint256 output,uint256 feeEth)',
]);
