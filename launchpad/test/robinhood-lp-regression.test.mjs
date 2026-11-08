import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { decodeAbiParameters, decodeFunctionData, parseAbiParameters } from 'viem';
import { buildLpDeposit, liquidityForAmounts, amountsForLiquidity, sqrtAtTick } from '../src/robinhood-liquidity.mjs';
import { buildFeeCompound } from '../src/robinhood-lp-fees.mjs';
import { positionAbi, EVM_NATIVE } from '../src/robinhood-contracts.mjs';
import { v3PositionAbi } from '../src/robinhood-legacy-contracts.mjs';

const { maxLiquidityForAmounts } = createRequire(import.meta.url)('@uniswap/v3-sdk');
const JSBI = createRequire(import.meta.url)('jsbi');
const wallet = '0x1111111111111111111111111111111111111111';
const stock = '0x2222222222222222222222222222222222222222';
const token = '0x3333333333333333333333333333333333333333';
const unpack = (type, data) => decodeAbiParameters(parseAbiParameters(type), data);

// Action semantics from Uniswap v4-periphery 545a5d2: PositionManager._close,
// _settlePair, and DeltaResolver._getFullDebt. This models pool deltas, not a
// venue deployment; the real mainnet deployment still needs a fork test.
function settleCompound(plan, lot, price, fees, debtOnly = false) {
  const decoded = decodeFunctionData({ abi: positionAbi, data: plan.data });
  const [commands, inputs] = unpack('bytes,bytes[]', decoded.args[0]);
  const currencies = [lot.pool.currency0, lot.pool.currency1];
  const credits = new Map(), walletChanges = new Map();
  let heldNative = plan.value;
  const account = (currency, delta) => walletChanges.set(currency, (walletChanges.get(currency) || 0n) + delta);
  account(EVM_NATIVE, -plan.value);
  const close = currency => {
    const delta = credits.get(currency) || 0n;
    if (debtOnly && delta > 0n) throw Error('DeltaNotNegative');
    if (delta < 0n && currency === EVM_NATIVE) heldNative += delta;
    else account(currency, delta);
    credits.set(currency, 0n);
  };
  for (const [i, command] of commands.slice(2).match(/../g).entries()) {
    if (command === '00') {
      const [id, liquidity, max0, max1] = unpack('uint256,uint256,uint128,uint128,bytes', inputs[i]);
      assert.equal(id, BigInt(lot.tokenId));
      const used = amountsForLiquidity(price, lot.lower, lot.upper, liquidity).map(n => n + 1n);
      used.forEach((n, j) => {
        assert(n <= [max0, max1][j]);
        credits.set(currencies[j], fees[j] - n);
      });
    } else if (command === '12') close(unpack('address', inputs[i])[0].toLowerCase());
    else if (command === '0d') {
      for (const currency of unpack('address,address', inputs[i])) {
        assert((credits.get(currency.toLowerCase()) || 0n) <= 0n, 'DeltaNotNegative');
        close(currency.toLowerCase());
      }
    } else if (command === '14') {
      const [currency, recipient] = unpack('address,address', inputs[i]);
      assert.equal(currency, EVM_NATIVE); assert.equal(recipient.toLowerCase(), wallet);
      account(EVM_NATIVE, heldNative); heldNative = 0n;
    } else throw Error(`Unsupported fixture action ${command}`);
  }
  assert([...credits.values()].every(n => n === 0n), 'CurrencyNotSettled');
  assert.equal(heldNative, 0n);
  return walletChanges;
}

test('v4 compound settles fresh fee credits as well as debt, including native refunds', async () => {
  const amount = 10n ** 18n, price = 2n ** 96n;
  for (const currency0 of [EVM_NATIVE, stock]) {
    const lot = { tokenId: '8', wallet, lower: -60, upper: 60, pool: { protocol: 'v4', currency0, currency1: token } };
    const rpc = { client: { readContract: async ({ functionName }) => functionName === 'ownerOf' ? wallet : amount } };
    const plan = await buildFeeCompound({ rpc, pools: { state: async () => ({ sqrtPriceX96: price }) }, lot, wallet, amounts: { [currency0]: String(amount), [token]: String(amount) }, slippageBps: 100 });
    for (const fees of [[0n, 0n], [2n * amount, 0n], [0n, 2n * amount], [2n * amount, 2n * amount]]) {
      const changes = settleCompound(plan, lot, price, fees);
      for (const currency of [currency0, token]) assert((changes.get(currency) || 0n) >= -amount);
      if (fees.some(n => n > amount)) assert.throws(() => settleCompound(plan, lot, price, fees, true), /DeltaNotNegative/);
    }
  }
});

test('v3 deposit minimums use the position manager integer rounding at unequal token prices', async () => {
  const tick = -500000, amount = 10n ** 18n, price = sqrtAtTick(tick);
  const pool = { protocol: 'v3', currency0: stock, currency1: token, tickSpacing: 60, fee: 3000 };
  const plan = await buildLpDeposit({ pools: { state: async () => ({ tick, sqrtPriceX96: price }) }, pool, wallet, amount0: amount, amount1: amount, preset: 'balanced', slippageBps: 0 });
  const expected = BigInt(maxLiquidityForAmounts(JSBI.BigInt(price.toString()), JSBI.BigInt(sqrtAtTick(plan.lower).toString()), JSBI.BigInt(sqrtAtTick(plan.upper).toString()), String(amount), String(amount), false).toString());
  assert.equal(BigInt(plan.liquidity), expected);
  assert(expected < liquidityForAmounts(price, plan.lower, plan.upper, amount, amount));
  const [params] = decodeFunctionData({ abi: v3PositionAbi, data: plan.data }).args;
  const expectedAmounts = amountsForLiquidity(price, plan.lower, plan.upper, expected);
  assert.deepEqual([params.amount0Min, params.amount1Min], expectedAmounts);
});

test('v3 refuses a deposit or compound whose liquidity rounds to zero in the venue contract', async () => {
  const tick = -700000, price = sqrtAtTick(tick), amount = 10n ** 18n;
  const pool = { protocol: 'v3', currency0: stock, currency1: token, tickSpacing: 60, fee: 3000 };
  const pools = { state: async () => ({ tick, sqrtPriceX96: price }) };
  await assert.rejects(buildLpDeposit({ pools, pool, wallet, amount0: amount, amount1: amount, preset: 'balanced', slippageBps: 100 }), /LP amount/);
  const lot = { tokenId: '1', wallet, pool, lower: -700080, upper: -699960 };
  const rpc = { client: { readContract: async ({ functionName }) => functionName === 'ownerOf' ? wallet : [0n, EVM_NATIVE, stock, token, 3000, lot.lower, lot.upper, 1000n] } };
  assert.equal(await buildFeeCompound({ rpc, pools, lot, wallet, amounts: { [stock]: String(amount), [token]: String(amount) }, slippageBps: 100 }), null);
});
