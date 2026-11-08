import { encodeAbiParameters, parseAbiParameters, encodeFunctionData, decodeEventLog, getAddress } from 'viem';
import { CONTRACTS, poolType, poolId, stateAbi, quoterAbi, ponsAbi, airlockAbi, hookKeyAbi, initializerAbis, migrationKeyAbi, poolAbi, routerAbi, EVM_NATIVE } from './robinhood-contracts.mjs';
import { cleanPool, evmAddress } from './robinhood-settings.mjs';
import { readLegacyPool, readCurve, legacyState, legacyQuote, legacySwap } from './robinhood-legacy-pools.mjs';
import { v2FactoryAbi, v3FactoryAbi, ponsV1Abi, adapterAbi, pairAbi, v3PoolAbi, curveAbi } from './robinhood-legacy-contracts.mjs';
import { throwIfRpcUnavailable } from './robinhood-rpc-errors.mjs';

const abi = text => parseAbiParameters(text);
export const encode = (types, values) => encodeAbiParameters(abi(types), values);
export const minimumOut = (amount, bps) => amount * BigInt(10000 - bps) / 10000n;
export const otherCurrency = (pool, input) => { if (pool.currency0 === input) return pool.currency1; if (pool.currency1 === input) return pool.currency0; throw Error('Token is not in the selected pool.'); };
const pairKey = (a, b) => [a, b].sort().join(':');

export class RobinhoodPools {
  constructor(rpc) { this.rpc = rpc; this.client = rpc.client; this.cache = new Map(); }
  snapshot() {
    // Followers reacting to one signal can share market reads. Limit completed
    // reuse to two seconds and never cache wallet balances, nonces, approvals or
    // the final full-transaction gas simulation. New signals get a new scope.
    const reads = new Map(), client = this.client;
    const share = method => args => {
      const key = JSON.stringify([method, args], (_, value) => typeof value === 'bigint' ? `${value}n` : value);
      const entry = reads.get(key);
      if (entry && (entry.pending || Date.now() - entry.at < 2000)) return entry.job;
      const next = { pending: true, at: 0 };
      next.job = Promise.resolve().then(() => client[method](args)).then(value => { next.pending = false; next.at = Date.now(); return value; }, error => { if (reads.get(key) === next) reads.delete(key); throw error; });
      reads.set(key, next); return next.job;
    };
    const scoped = new RobinhoodPools({ client: { ...client, readContract: share('readContract'), simulateContract: share('simulateContract') } });
    scoped.cache = this.cache; return scoped;
  }
  async state(pool) { if (pool.protocol && pool.protocol !== 'v4') return legacyState(this.client, pool); const value = await this.client.readContract({ address: CONTRACTS.stateView, abi: stateAbi, functionName: 'getSlot0', args: [poolId(pool)] }); if (!value[0]) throw Error('This Uniswap pool is not initialized.'); return { sqrtPriceX96: value[0], tick: value[1], fee: value[3] }; }
  async validate(pool, token, quote, { allowInactive = false } = {}) {
    pool = cleanPool(pool);
    if (token && ![pool.currency0, pool.currency1].includes(token) || quote && ![pool.currency0, pool.currency1].includes(quote)) throw Error('Pool currencies do not match the trade.');
    if (pool.protocol === 'pons-curve') { const verified = await readCurve(this.client, pool.token); if (verified.address !== pool.address || verified.currency0 !== pool.currency0 || verified.currency1 !== pool.currency1) throw Error('Launchpad identity changed.'); pool = verified; }
    else if (pool.protocol && pool.protocol !== 'v4') { const verified = await readLegacyPool(this.client, pool.address, pool.protocol, allowInactive); if (verified.currency0 !== pool.currency0 || verified.currency1 !== pool.currency1 || verified.fee !== pool.fee) throw Error('Pool identity mismatch.'); pool = verified; }
    else { await this.state(pool); if (!allowInactive && await this.client.readContract({ address: CONTRACTS.stateView, abi: stateAbi, functionName: 'getLiquidity', args: [poolId(pool)] }) <= 0n) throw Error('The pool has no active liquidity.'); }
    this.cache.set(pairKey(pool.currency0, pool.currency1), pool); return pool;
  }
  rememberLogs(logs) {
    for (const log of logs || []) if (log.address?.toLowerCase() === CONTRACTS.poolManager.toLowerCase()) {
      try { const { eventName, args } = decodeEventLog({ abi: poolAbi, data: log.data, topics: log.topics }); if (eventName === 'Initialize') {
        const pool = cleanPool(args); if (poolId(pool) === args.id) this.cache.set(pairKey(pool.currency0, pool.currency1), pool);
      } } catch (error) { throwIfRpcUnavailable(error); }
    }
  }
  async observeLegacyLogs(logs) {
    const pools = [], seen = new Set();
    for (const log of logs) {
      if (seen.has(log.address.toLowerCase())) continue;
      for (const [protocol, abi] of [['v2', pairAbi], ['v3', v3PoolAbi], ['pons-curve', curveAbi]]) {
        let d; try { d = decodeEventLog({ abi, topics: log.topics, data: log.data }); } catch { continue; }
        if (!['Swap', 'CurveBuy', 'CurveSell'].includes(d.eventName)) continue;
        seen.add(log.address.toLowerCase());
        try {
          const pool = protocol === 'pons-curve' ? await readCurve(this.client, await this.client.readContract({ address: log.address, abi: curveAbi, functionName: 'token' }), true) : await readLegacyPool(this.client, log.address, protocol);
          if (pool.address.toLowerCase() !== log.address.toLowerCase()) continue;
          this.cache.set(pairKey(pool.currency0, pool.currency1), pool); pools.push(pool);
        } catch (error) { throwIfRpcUnavailable(error); }
        break;
      }
    }
    return pools;
  }
  async launchPool(token) {
    const candidates = []; let ungraduated = false;
    try {
      const launch = await this.client.readContract({ address: CONTRACTS.ponsFactory, abi: ponsAbi, functionName: 'getLaunchedToken', args: [token] });
      if (launch.exists && evmAddress(launch.token) === token) {
        if (Number(launch.phase) === 0) { try { return await this.validate(await readCurve(this.client, token), token); } catch (error) { throwIfRpcUnavailable(error); ungraduated = true; } }
        else if (Number(launch.phase) !== 2) ungraduated = true;
        else { const currencies = [token, evmAddress(launch.pairToken)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1); candidates.push({ currency0: currencies[0], currency1: currencies[1], fee: launch.poolFee, tickSpacing: launch.tickSpacing, hooks: CONTRACTS.ponsHook }); }
      }
    } catch (error) { throwIfRpcUnavailable(error); }
    try {
      const launch = await this.client.readContract({ address: CONTRACTS.ponsV1Factory, abi: ponsV1Abi, functionName: 'getLaunchedToken', args: [token] });
      if (launch.exists && evmAddress(launch.token) === token) { const address = await this.client.readContract({ address: CONTRACTS.v3Factory, abi: v3FactoryAbi, functionName: 'getPool', args: [token, launch.pairedToken, launch.poolFee] }); return await this.validate(await readLegacyPool(this.client, address, 'v3'), token); }
    } catch (error) { throwIfRpcUnavailable(error); }
    try {
      const data = await this.client.readContract({ address: CONTRACTS.airlock, abi: airlockAbi, functionName: 'getAssetData', args: [token] });
      if (data[0] !== EVM_NATIVE || data[5] !== EVM_NATIVE) {
        for (const address of [data[6], data[5]].filter(x => x !== EVM_NATIVE)) for (const protocol of ['v2', 'v3']) try { return await this.validate(await readLegacyPool(this.client, address, protocol), token); } catch (error) { throwIfRpcUnavailable(error); }
        const currencies = [token, evmAddress(data[0])].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
        if (data[3] !== EVM_NATIVE) try { const state = await this.client.readContract({ address: data[3], abi: migrationKeyAbi, functionName: 'getAssetData', args: currencies }); candidates.push(state[1]); } catch (error) { throwIfRpcUnavailable(error); }
        for (const hook of [data[6], data[5]].filter(x => x !== EVM_NATIVE)) {
          try { const key = await this.client.readContract({ address: hook, abi: hookKeyAbi, functionName: 'poolKey' }); candidates.push(Object.fromEntries(['currency0','currency1','fee','tickSpacing','hooks'].map((k, i) => [k, key[i]]))); } catch (error) { throwIfRpcUnavailable(error); }
        }
        if (data[4] !== EVM_NATIVE) for (const abi of initializerAbis) {
          try { const state = await this.client.readContract({ address: data[4], abi, functionName: 'getState', args: [token] }); candidates.push(state.find(value => value && typeof value === 'object' && 'currency0' in value)); } catch (error) { throwIfRpcUnavailable(error); }
        }
      }
    } catch (error) { throwIfRpcUnavailable(error); }
    for (const candidate of candidates.filter(Boolean)) try {
      const pool = await this.validate(candidate, token);
      if (await this.client.readContract({ address: CONTRACTS.stateView, abi: stateAbi, functionName: 'getLiquidity', args: [poolId(pool)] }) > 0n) return pool;
    } catch (error) { throwIfRpcUnavailable(error); }
    if (ungraduated) throw Error('This Pons launch is transitioning between its curve and graduated pool. Retry after pool creation completes.');
    return null;
  }
  async find(token, quote, explicit = null) {
    token = evmAddress(token); quote = quote ? evmAddress(quote) : null;
    if (explicit) return this.validate(explicit, token, quote);
    const cached = quote ? this.cache.get(pairKey(token, quote)) : [...this.cache.values()].find(p => [p.currency0,p.currency1].includes(token));
    if (cached) { try { return await this.validate(cached, token, quote); } catch (error) { throwIfRpcUnavailable(error); this.cache.delete(pairKey(cached.currency0, cached.currency1)); } }
    const launch = await this.launchPool(token);
    if (launch && (!quote || [launch.currency0, launch.currency1].includes(quote))) return launch;
    if (!quote) {
      for (const currency of [EVM_NATIVE, CONTRACTS.usdg]) if (currency !== token) {
        try { return await this.find(token, currency); } catch (error) { throwIfRpcUnavailable(error); }
      }
    }
    if (quote) {
      if (quote !== EVM_NATIVE) {
        for (const fee of [500, 3000, 10000, 100]) try { const address = await this.client.readContract({ address: CONTRACTS.v3Factory, abi: v3FactoryAbi, functionName: 'getPool', args: [token, quote, fee] }); return await this.validate(await readLegacyPool(this.client, address, 'v3'), token, quote); } catch (error) { throwIfRpcUnavailable(error); }
        try { const address = await this.client.readContract({ address: CONTRACTS.v2Factory, abi: v2FactoryAbi, functionName: 'getPair', args: [token, quote] }); return await this.validate(await readLegacyPool(this.client, address, 'v2'), token, quote); } catch (error) { throwIfRpcUnavailable(error); }
      }
      const [currency0, currency1] = [token, quote].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
      for (const [fee, tickSpacing] of [[500, 10], [3000, 60], [10000, 200], [100, 1]]) try { return await this.validate({ currency0, currency1, fee, tickSpacing, hooks: EVM_NATIVE }, token, quote); } catch (error) { throwIfRpcUnavailable(error); }
    }
    if (quote === EVM_NATIVE) return this.find(token, CONTRACTS.weth);
    throw Error('No active Pons or Uniswap market was found for this token. Check the token address or try again after liquidity is available.');
  }
  async quote(pool, input, amount, recipient) {
    if (amount <= 0n || amount >= 2n ** 128n) throw Error('Trade amount is outside the supported range.');
    if (pool.protocol && pool.protocol !== 'v4') { const output = await legacyQuote(this.client, pool, input, amount, recipient); if (output <= 0n) throw Error('The pool returned no executable output.'); return output; }
    const { result } = await this.client.simulateContract({ address: CONTRACTS.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: pool, zeroForOne: pool.currency0 === input, exactAmount: amount, hookData: '0x' }] });
    if (result[0] <= 0n || result[0] >= 2n ** 128n) throw Error('The pool returned no executable output.'); return result[0];
  }
  async feePath(input, mainPool, feePool) {
    if ([EVM_NATIVE, CONTRACTS.weth].includes(input)) return [];
    if (feePool) { const candidate = await this.validate(feePool); if ([candidate.currency0, candidate.currency1].includes(input) && [EVM_NATIVE, CONTRACTS.weth].includes(otherCurrency(candidate, input))) return [candidate]; }
    const output = otherCurrency(mainPool, input);
    if ([EVM_NATIVE, CONTRACTS.weth].includes(output)) return [mainPool];
    if (feePool && [feePool.currency0, feePool.currency1].includes(output) && [EVM_NATIVE, CONTRACTS.weth].includes(otherCurrency(feePool, output))) return [mainPool, await this.validate(feePool)];
    for (const native of [EVM_NATIVE, CONTRACTS.weth]) {
      try { return [await this.find(input, native)]; } catch (error) { throwIfRpcUnavailable(error); }
      try { return [mainPool, await this.find(output, native)]; } catch (error) { throwIfRpcUnavailable(error); }
    }
    for (const [currency, prefix] of [[input, []], [output, [mainPool]]]) if (currency !== CONTRACTS.usdg) {
      try { return [...prefix, await this.find(currency, CONTRACTS.usdg), await this.find(CONTRACTS.usdg, EVM_NATIVE)]; } catch (error) { throwIfRpcUnavailable(error); }
    }
    throw Error('No liquid ETH route is currently available to settle this trade’s fee. No trade was submitted. Try again later.');
  }
}

// Universal Router 2.1.2 (802fe4c); v4-periphery 545a5d2. Includes minHopPriceX36.
export function v4Swap(pool, input, amount, minOut, recipient, payerIsUser = true) {
  const output = otherCurrency(pool, input);
  return encode('bytes,bytes[]', ['0x060b0e0e', [
    encode(`(${poolType} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`, [{ poolKey: pool, zeroForOne: pool.currency0 === input, amountIn: amount, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: '0x' }]),
    encode('address,uint256,bool', [input, amount, payerIsUser]),
    encode('address,address,uint256', [output, recipient, 0n]),
    // An exact-input swap may stop at the end of available liquidity. Paying
    // the signed maximum preserves the input cap; return its positive delta
    // so PoolManager.unlock does not revert CurrencyNotSettled. Use the UR
    // payer aliases, not the output recipient (fee hops pay output to UR).
    encode('address,address,uint256', [input, payerIsUser ? '0x0000000000000000000000000000000000000001' : '0x0000000000000000000000000000000000000002', 0n]),
  ]]);
}
export async function buildSwapPlan({ pools, pool, input, amount, wallet, recipient, adapter, ppm, slippageBps, feePool = null, deadline = Math.floor(Date.now() / 1000) + 90 }) {
  if (!Number.isSafeInteger(ppm) || ppm < 0 || ppm > 10000) throw Error('Invalid server fee rate.');
  if (pool.protocol === 'pons-curve') return buildCurvePlan({ pools, pool, input, amount, wallet, recipient, adapter, ppm, slippageBps, feePool, deadline });
  const feeInput = amount * BigInt(ppm) / 1000000n, tradeInput = amount - feeInput;
  if (tradeInput <= 0n || ppm && feeInput <= 0n) throw Error('Amount is too small for this fee schedule.');
  const commands = [], inputs = [], approvals = new Map(); let feeEth = feeInput;
  const add = (command, value) => { commands.push(command); inputs.push(value); };
  if (input !== EVM_NATIVE) approvals.set(input, amount);
  if (feeInput > 0n && input !== EVM_NATIVE) {
    if (input === CONTRACTS.weth) add('02', encode('address,address,uint160', [input, CONTRACTS.router, feeInput]));
    else {
      const path = await pools.feePath(input, pool, feePool); let currency = input, inAmount = feeInput;
      for (let i = 0; i < path.length; i++) {
        const out = otherCurrency(path[i], currency), min = minimumOut(await pools.quote(path[i], currency, inAmount), slippageBps);
        if (min <= 0n) throw Error('Fee conversion is too small.');
        // Later hops spend the guaranteed minimum; residual improvements return to the user.
        const swap = swapCommand(path[i], currency, inAmount, min, CONTRACTS.router, i === 0); add(swap.command, swap.input);
        if (i > 0) add('04', encode('address,address,uint256', [currency, wallet, 0n]));
        currency = out; inAmount = min;
      }
      feeEth = inAmount;
      if (currency === CONTRACTS.weth) add('0c', encode('address,uint256', [CONTRACTS.router, feeEth]));
      else if (currency !== EVM_NATIVE) throw Error('Fee route must finish in Robinhood ETH.');
    }
    if (input === CONTRACTS.weth) add('0c', encode('address,uint256', [CONTRACTS.router, feeEth]));
  }
  if (feeInput > 0n) add('05', encode('address,address,uint256', [EVM_NATIVE, recipient, feeEth]));
  const out = otherCurrency(pool, input), quoted = await pools.quote(pool, input, tradeInput), minimum = minimumOut(quoted, slippageBps);
  if (minimum <= 0n) throw Error('Trade output is too small.');
  const swap = swapCommand(pool, input, tradeInput, minimum, wallet); add(swap.command, swap.input);
  add('04', encode('address,address,uint256', [EVM_NATIVE, wallet, 0n]));
  const commandBytes = `0x${commands.join('')}`;
  return { to: CONTRACTS.router, data: encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: [commandBytes, inputs, BigInt(deadline)] }), value: input === EVM_NATIVE ? amount : 0n,
    approvals: [...approvals].map(([token, value]) => ({ token, amount: String(value), spender: CONTRACTS.router })), input, output: out, amount: String(amount), minimum: String(minimum), quoted: String(quoted), feeEth: String(ppm ? feeEth : 0n), feeInput: String(feeInput), ppm, recipient, deadline, pool };
}

export function swapCommand(pool, input, amount, minimum, recipient, payerIsUser = true) {
  return pool.protocol && pool.protocol !== 'v4' ? legacySwap(encode, pool, input, amount, minimum, recipient, payerIsUser) : { command: '10', input: v4Swap(pool, input, amount, minimum, recipient, payerIsUser) };
}
export async function ethReference(pools, input, amount, pool, feePool) {
  let currency = input;
  if (![EVM_NATIVE, CONTRACTS.weth].includes(input)) for (const hop of await pools.feePath(input, pool, feePool)) { amount = await pools.quote(hop, currency, amount); currency = otherCurrency(hop, currency); }
  if (![EVM_NATIVE, CONTRACTS.weth].includes(currency)) throw Error('An executable Robinhood ETH reference route is required.');
  return amount;
}
async function buildCurvePlan({ pools, pool, input, amount, wallet, recipient, adapter, ppm, slippageBps, feePool, deadline }) {
  if (!adapter) throw Error('Robinhood execution contract has not been deployed and verified by the host.');
  const quoted = await pools.quote(pool, input, amount, wallet), minimum = minimumOut(quoted, slippageBps);
  if (!minimum) throw Error('Launchpad output is too small.');
  const feeInput = amount * BigInt(ppm) / 1000000n;
  const feeEth = feeInput ? await ethReference(pools, input, feeInput, pool, feePool) : 0n;
  if (ppm && !feeEth) throw Error('Trade is too small for this fee schedule.');
  return { to: adapter, data: encodeFunctionData({ abi: adapterAbi, functionName: 'curveSwap', args: [pool.token, input === pool.quote, amount, minimum, recipient, feeEth, BigInt(deadline)] }), value: feeEth + (input === EVM_NATIVE ? amount : 0n), approvals: input === EVM_NATIVE ? [] : [{ token: input, amount: String(amount), spender: adapter, mode: 'erc20' }], input, output: otherCurrency(pool, input), amount: String(amount), minimum: String(minimum), quoted: String(quoted), feeEth: String(feeEth), feeInput: String(feeInput), ppm, recipient, deadline, pool };
}
