import { encodeFunctionData, decodeFunctionData, decodeEventLog } from 'viem';
import { CONTRACTS, EVM_NATIVE } from './robinhood-contracts.mjs';
import { adapterAbi } from './robinhood-legacy-contracts.mjs';
import { otherCurrency, minimumOut } from './robinhood-pools.mjs';
import { throwIfRpcUnavailable } from './robinhood-rpc-errors.mjs';

const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const native = token => [EVM_NATIVE, CONTRACTS.weth].includes(token);
const reverse = path => [...path].reverse().map(h => ({ pool: h.pool, input: h.output, output: h.input }));

// Pool identities originate from verified on-chain discovery, including the
// lead's routing hops. Do not guess stock symbols or reinterpret their decimals.
export async function ethFundingPath(pools, quote, { feePool, avoid } = {}) {
  if (native(quote)) return [];
  const candidates = [...(pools.cache?.values() || [])].filter(p => p.protocol !== 'pons-curve' && ![p.currency0, p.currency1].includes(avoid));
  if (feePool) candidates.unshift(await pools.validate(feePool));
  const search = () => {
    const queue = [{ token: quote, path: [], visited: new Set([quote]) }];
    while (queue.length) {
      const item = queue.shift();
      if (item.path.length >= 3) continue;
      for (const pool of candidates) {
        if (![pool.currency0, pool.currency1].includes(item.token) || pool.protocol === 'pons-curve' || [pool.currency0, pool.currency1].includes(avoid)) continue;
        const next = otherCurrency(pool, item.token); if (item.visited.has(next)) continue;
        const path = [...item.path, { pool, input: item.token, output: next }];
        if (native(next)) return reverse(path);
        queue.push({ token: next, path, visited: new Set([...item.visited, next]) });
      }
    }
  };
  let path = search();
  if (!path) {
    try { candidates.push(await pools.find(quote, EVM_NATIVE)); } catch (error) { throwIfRpcUnavailable(error); }
    path = search();
  }
  // Stock tokens commonly trade against USDG, with no direct ETH pool.
  // Discover both legs on-chain; the user never supplies a conversion pool.
  if (!path && quote !== CONTRACTS.usdg && avoid !== CONTRACTS.usdg) {
    try {
      candidates.push(await pools.find(quote, CONTRACTS.usdg));
      candidates.push(await pools.find(CONTRACTS.usdg, EVM_NATIVE));
    } catch (error) { throwIfRpcUnavailable(error); }
    path = search();
  }
  // A lead may route a stock through another ERC20 before wrapping/unwrapping.
  // Connect already-observed neighbouring currencies to a verified ETH pool.
  if (!path) for (const pool of [...candidates]) {
    if (![pool.currency0, pool.currency1].includes(quote)) continue;
    const next = otherCurrency(pool, quote); if (next === avoid) continue;
    try { candidates.push(await pools.find(next, EVM_NATIVE)); } catch (error) { throwIfRpcUnavailable(error); }
    path = search(); if (path) break;
  }
  if (!path) throw Error('No liquid ETH trading route is currently available for this token. No trade was submitted. Try again later or choose another token.');
  const verified = [];
  for (const hop of path) verified.push({ ...hop, pool: await pools.validate(hop.pool, hop.input, hop.output) });
  return verified;
}

export async function buildEthTradePlan({ pools, pool, token, buy, amount, wallet, recipient, adapter, ppm, slippageBps, feePool = null, deadline = Math.floor(Date.now() / 1000) + 90 }) {
  if (!adapter) throw Error('The host must configure the updated Robinhood execution contract.');
  if (!Number.isSafeInteger(ppm) || ppm < 0 || ppm > 10000 || amount <= 0n || amount >= 2n ** 128n) throw Error('Invalid ETH trade amount or fee rate.');
  const quote = otherCurrency(pool, token), curve = pool.protocol === 'pons-curve';
  const funding = await ethFundingPath(pools, quote, { feePool, avoid: token });
  const buyPath = curve ? funding : [...funding, { pool, input: quote, output: token }];
  const path = buy ? buyPath : reverse(buyPath), route = [];
  const steps = path.length + (curve ? 1 : 0), hopSlippage = Math.floor(slippageBps / Math.max(1, steps));
  let feeEth = buy ? amount * BigInt(ppm) / 1000000n : 0n;
  let expected = buy ? amount - feeEth : amount, guaranteed = expected;
  if (curve && !buy) { expected = await pools.quote(pool, token, expected, wallet); guaranteed = minimumOut(expected, hopSlippage); }
  for (const hop of path) {
    const full = await pools.quote(hop.pool, hop.input, expected, wallet);
    const conservative = guaranteed === expected ? full : await pools.quote(hop.pool, hop.input, guaranteed, wallet);
    const minimum = minimumOut(conservative, hopSlippage);
    if (minimum <= 0n) throw Error('The ETH conversion route returns too little for this amount.');
    route.push({ version: hop.pool.protocol === 'v2' ? 2 : hop.pool.protocol === 'v3' ? 3 : 4, input: hop.input, output: hop.output, fee: hop.pool.fee, tickSpacing: hop.pool.tickSpacing, hooks: hop.pool.hooks || EVM_NATIVE, minimum });
    expected = full; guaranteed = minimum;
  }
  if (curve && buy) expected = await pools.quote(pool, quote, expected, wallet);
  if (!buy) { feeEth = expected * BigInt(ppm) / 1000000n; expected -= feeEth; }
  const minimum = minimumOut(expected, slippageBps);
  if (minimum <= 0n || ppm && !feeEth) throw Error('Trade amount is too small for its ETH fee schedule.');
  const trade = { token, buy, curve, amount, minimum, feeRecipient: recipient, feePpm: ppm };
  return { to: adapter, data: encodeFunctionData({ abi: adapterAbi, functionName: 'tradeEth', args: [trade, route, BigInt(deadline)] }),
    value: buy ? amount : 0n, approvals: buy ? [] : [{ token, amount: String(amount), spender: adapter, mode: 'erc20' }],
    input: buy ? EVM_NATIVE : token, output: buy ? token : EVM_NATIVE, amount: String(amount), minimum: String(minimum), quoted: String(expected),
    feeEth: String(feeEth), feeMode: 'eth-trade', ppm, recipient, deadline, pool, nativeTrade: true, quote };
}

// Both reconciliation and independent cashback verification check the actual
// ETH output. Positive price improvement may raise the fee without exceeding
// its signed percentage; an estimate is never used as the receipt's fee cap.
export function ethExecution(transaction, receipt) {
  const { functionName, args } = decodeFunctionData({ abi: adapterAbi, data: transaction.input || transaction.data });
  if (functionName !== 'tradeEth') throw Error('Unexpected ETH trade call.');
  const [trade] = args, events = [];
  for (const log of receipt.logs || []) if (same(log.address, transaction.to)) try {
    const decoded = decodeEventLog({ abi: adapterAbi, eventName: 'EthTraded', topics: log.topics, data: log.data });
    if (decoded.eventName === 'EthTraded') events.push(decoded.args);
  } catch {}
  const event = events[0];
  if (events.length !== 1 || !same(event.wallet, transaction.from) || !same(event.token, trade.token) || event.buy !== trade.buy || event.inputSpent !== trade.amount || event.output < trade.minimum || BigInt(transaction.value || 0) !== (trade.buy ? trade.amount : 0n) || trade.feePpm > 10000) throw Error('ETH execution receipt does not match its signed trade.');
  const expectedFee = (trade.buy ? trade.amount : event.output + event.feeEth) * BigInt(trade.feePpm) / 1000000n;
  if (event.feeEth !== expectedFee) throw Error('ETH execution fee does not match its signed percentage.');
  return { ...event, recipient: trade.feeRecipient, ppm: trade.feePpm };
}
