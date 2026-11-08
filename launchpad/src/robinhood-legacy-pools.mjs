import { decodeEventLog, encodePacked } from 'viem';
import { CONTRACTS, EVM_NATIVE, ponsAbi } from './robinhood-contracts.mjs';
import { pairAbi, v2FactoryAbi, v3FactoryAbi, v3PoolAbi, v3QuoterAbi, curveAbi } from './robinhood-legacy-contracts.mjs';
import { evmAddress } from './robinhood-settings.mjs';

const ordered = (a, b) => [a, b].sort((x, y) => BigInt(x) < BigInt(y) ? -1 : 1);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
function missingOptionalGetter(error) {
  for (let current = error, i = 0; current && i < 10; current = current.cause, i++) {
    if (current.name === 'ContractFunctionZeroDataError' || [3, -32000].includes(current.code) && current.data === '0x') return true;
  }
  return false;
}
export async function readLegacyPool(client, address, protocol, allowInactive = false) {
  address = evmAddress(address);
  const abi = protocol === 'v2' ? pairAbi : v3PoolAbi;
  const read = functionName => client.readContract({ address, abi, functionName });
  const [factory, a, b] = await Promise.all(['factory', 'token0', 'token1'].map(read));
  const currency0 = evmAddress(a), currency1 = evmAddress(b);
  if (BigInt(currency0) >= BigInt(currency1) || currency0 === EVM_NATIVE) throw Error('Invalid pool currencies.');
  if (protocol === 'v2') {
    if (!same(factory, CONTRACTS.v2Factory) || !same(await client.readContract({ address: CONTRACTS.v2Factory, abi: v2FactoryAbi, functionName: 'getPair', args: [currency0, currency1] }), address)) throw Error('The pair is not registered with the Robinhood Uniswap v2 factory.');
    const reserves = await read('getReserves'); if (!allowInactive && (!reserves[0] || !reserves[1])) throw Error('The pair has no liquidity.');
    return { protocol, address, currency0, currency1, fee: 3000, tickSpacing: 1 };
  }
  const [fee, tickSpacing, liquidity] = await Promise.all(['fee', 'tickSpacing', 'liquidity'].map(read));
  if (!same(factory, CONTRACTS.v3Factory) || !same(await client.readContract({ address: CONTRACTS.v3Factory, abi: v3FactoryAbi, functionName: 'getPool', args: [currency0, currency1, fee] }), address) || !allowInactive && liquidity <= 0n) throw Error('No active liquidity in a verified Robinhood Uniswap v3 pool.');
  return { protocol: 'v3', address, currency0, currency1, fee, tickSpacing };
}
export async function readCurve(client, token, historical = false) {
  const launch = await client.readContract({ address: CONTRACTS.ponsFactory, abi: ponsAbi, functionName: 'getLaunchedToken', args: [token] });
  if (!launch.exists || !same(launch.token, token) || !historical && Number(launch.phase) !== 0) throw Error('The Pons bonding curve has graduated or is transitioning to its pool.');
  const address = evmAddress(launch.curve), read = functionName => client.readContract({ address, abi: curveAbi, functionName });
  const [factory, asset, quote, graduated, ready] = await Promise.all(['factory', 'token', 'pairToken', 'graduated', 'readyToGraduate'].map(read));
  if (!same(factory, CONTRACTS.ponsFactory) || !same(asset, token) || !same(quote, launch.pairToken) || !historical && (graduated || ready)) throw Error('This curve is transitioning to its graduated pool.');
  const currencies = ordered(evmAddress(asset), evmAddress(quote));
  return { protocol: 'pons-curve', address, token: evmAddress(asset), quote: evmAddress(quote), currency0: currencies[0], currency1: currencies[1] };
}
export async function legacyState(client, pool) {
  if (pool.protocol === 'v2') {
    const [a, b] = await client.readContract({ address: pool.address, abi: pairAbi, functionName: 'getReserves' });
    if (!a || !b) throw Error('The pair has no liquidity.');
    return { reserves: [a, b], fee: 3000, tick: null };
  }
  if (pool.protocol === 'v3') {
    const state = await client.readContract({ address: pool.address, abi: v3PoolAbi, functionName: 'slot0' });
    if (!state[0]) throw Error('The v3 pool is not initialized.');
    return { sqrtPriceX96: state[0], tick: state[1], fee: pool.fee };
  }
  throw Error('Bonding curves do not accept user LP positions.');
}
export function constantProductOut(amount, reserveIn, reserveOut, fee = 3000n) {
  if (amount <= 0n || reserveIn <= 0n || reserveOut <= 0n || fee >= 1000000n) throw Error('No executable pool liquidity.');
  const net = amount * (1000000n - fee); return net * reserveOut / (reserveIn * 1000000n + net);
}
export async function legacyQuote(client, pool, input, amount, recipient) {
  if (![pool.currency0, pool.currency1].includes(input)) throw Error('Token is not in this pool.');
  if (pool.protocol === 'v2') {
    const { reserves } = await legacyState(client, pool), i = pool.currency0 === input ? 0 : 1;
    return constantProductOut(amount, reserves[i], reserves[1 - i]);
  }
  if (pool.protocol === 'v3') {
    const { result } = await client.simulateContract({ address: CONTRACTS.v3Quoter, abi: v3QuoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: input, tokenOut: input === pool.currency0 ? pool.currency1 : pool.currency0, amountIn: amount, fee: pool.fee, sqrtPriceLimitX96: 0n }] });
    return result[0];
  }
  await readCurve(client, pool.token);
  const read = functionName => client.readContract({ address: pool.address, abi: curveAbi, functionName });
  const [[q, t], fee, tax, sellable, real] = await Promise.all(['getReserves', 'feeBps', 'creatorTaxBps', 'sellableTokens', 'realQuoteReserve'].map(read));
  if (fee + tax >= 10000n || !sellable) throw Error('This curve cannot execute a trade.');
  if (input === pool.quote) {
    // Some deployed revisions expose a recipient-specific launch tax. A missing
    // getter is compatible with the verified source; execution is still simulated.
    const snipe = recipient ? await client.readContract({ address: pool.address, abi: curveAbi, functionName: 'currentSnipeTaxBps', args: [recipient] }).catch(error => { if (!missingOptionalGetter(error)) throw error; return 0n; }) : 0n;
    const net = amount - amount * fee / 10000n - amount * tax / 10000n - amount * snipe / 10000n;
    const output = constantProductOut(net, q, t, 0n); return output < sellable ? output : sellable;
  }
  const gross = constantProductOut(amount, t, q, 0n), output = gross - gross * fee / 10000n - gross * tax / 10000n;
  if (gross > real) throw Error('The curve has insufficient real quote reserves for this sale.'); return output;
}
export function legacySwap(encode, pool, input, amount, minOut, recipient, payerIsUser) {
  const output = input === pool.currency0 ? pool.currency1 : pool.currency0;
  if (pool.protocol === 'v2') return { command: '08', input: encode('address,uint256,uint256,address[],bool,uint256[]', [recipient, amount, minOut, [input, output], payerIsUser, [0n]]) };
  if (pool.protocol === 'v3') return { command: '00', input: encode('address,uint256,uint256,bytes,bool,uint256[]', [recipient, amount, minOut, encodePacked(['address', 'uint24', 'address'], [input, pool.fee, output]), payerIsUser, [0n]]) };
  throw Error('A bonding-curve trade must use the verified Launchpad execution contract.');
}
export function matchingSwap(logs, pool, token) {
  if (!pool.protocol || pool.protocol === 'v4') return null;
  // A routed buy can emit swaps for several different pairs. Never interpret
  // another hop's token1 output as output of the token currently being copied.
  if (![pool.currency0, pool.currency1].some(currency => same(currency, token))) return null;
  for (const log of logs) if (same(log.address, pool.address)) try {
    const d = decodeEventLog({ abi: pool.protocol === 'v2' ? pairAbi : pool.protocol === 'v3' ? v3PoolAbi : curveAbi, data: log.data, topics: log.topics });
    if (pool.protocol === 'pons-curve' && d.eventName === 'CurveBuy' && pool.token === token) return d.args;
    if (d.eventName !== 'Swap') continue;
    if (pool.protocol === 'v2' ? (pool.currency0 === token ? d.args.amount0Out > 0n : d.args.amount1Out > 0n) : (pool.currency0 === token ? d.args.amount0 < 0n : d.args.amount1 < 0n)) return d.args;
  } catch {}
  return null;
}
