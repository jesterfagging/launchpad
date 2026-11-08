// Robinhood launch venue: the curve maths mirrored from the contracts, the tiers, the policy's funding plan and the
// pair book (Robinhood's stock-token API parsed from captured responses, ETH priced from the chain's pools, prices
// cached and served stale within limits). Dependency-free; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { curveForTargets, plannedSupply, fdvFor, quoteBuy, quoteSell, curvePrice, progressBps, tierTargetsInPair, parsePrice, unitsToUsd, isqrt } from '../public/robinhood-curve-math.mjs';
import { ROBINHOOD_TIERS, robinhoodTier, robinhoodDisclosure, ROBINHOOD_MODES, ROBINHOOD_STATES } from '../public/robinhood-launch-catalog.mjs';
import { ROBINHOOD_LAUNCH_POLICY, ROBINHOOD_LAUNCH_POLICY_HASH, policyFor, fundingPlan, feeRecipientRole, ledgerRole, tierById } from '../src/robinhood-launch/policy.mjs';
import { parseStockAssets, stockTokenPrice, cleanAssetName, multiplierOf, PairBook, ethUsdFromPools, tokenUsdFromPools, describeToken, quoterCallData, ROBINHOOD_ADDRESSES } from '../src/robinhood-launch/pairs.mjs';
import { ROBINHOOD_NATIVE } from '../public/robinhood-launch-catalog.mjs';

const ETHER = 10n ** 18n;
const SUPPLY = 10n ** 27n;

// Captured from https://api.robinhood.com/rhj/assets and /rhj/prices/NVDA on 2026-10-06.
const ASSETS = { assets: [
  { id: '0x000000000000000000000000000000001c6f27a62789417d8ed359ed3c2d3da1', tokenSymbol: 'SPY', tokenName: 'SPDR S&P 500 ETF Trust • Robinhood Token', deployments: [{ contractAddress: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', chainId: 4663, networkName: 'Robinhood Chain' }], currentMultiplier: '1.001717991187472003', pendingMultiplier: '', status: 'ASSET_STATUS_ACTIVE', logoUrl: 'https://cdn.robinhood.com/ncw_assets/logos/0x117cc2133c37b721f49de2a7a74833232b3b4c0c.png', tokenDecimals: 18, isin: 'US78462F1030' },
  { id: '0x000000000000000000000000000000001db61e88b20b481093c556e4d07195b5', tokenSymbol: 'GLD', tokenName: 'SPDR Gold Trust • Robinhood Token', deployments: [{ contractAddress: '0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e', chainId: 4663 }], currentMultiplier: '1.000000000000000000', status: 'ASSET_STATUS_ACTIVE', logoUrl: 'https://cdn.robinhood.com/ncw_assets/logos/0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e.png', tokenDecimals: 18, isin: 'US78463V1070' },
  { id: '0x00000000000000000000000000000000022015c295294037bfe416d3e45327b9', tokenSymbol: 'CRM', tokenName: 'Salesforce • Robinhood Token', deployments: [{ contractAddress: '0xd95B44124e475743a7589e68F3D74008A5536D44', chainId: 4663 }], currentMultiplier: '1.001148322800714293', status: 'ASSET_STATUS_ACTIVE', logoUrl: 'https://cdn.robinhood.com/ncw_assets/logos/0xd95b44124e475743a7589e68f3d74008a5536d44.png', tokenDecimals: 18, isin: 'US79466L3024' },
  { id: '0x1', tokenSymbol: 'NVDA', tokenName: 'NVIDIA • Robinhood Token', deployments: [{ contractAddress: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEc', chainId: 4663 }], currentMultiplier: '1.000041396932551318', status: 'ASSET_STATUS_ACTIVE', logoUrl: 'https://cdn.robinhood.com/ncw_assets/logos/x.png', tokenDecimals: 18, isin: 'US67066G1040' },
  { id: '0x2', tokenSymbol: 'OLD', tokenName: 'Delisted • Robinhood Token', deployments: [{ contractAddress: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0D', chainId: 4663 }], currentMultiplier: '1', status: 'ASSET_STATUS_INACTIVE', tokenDecimals: 18 },
  { id: '0x3', tokenSymbol: 'ARB', tokenName: 'Elsewhere • Robinhood Token', deployments: [{ contractAddress: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0E', chainId: 42161 }], currentMultiplier: '1', status: 'ASSET_STATUS_ACTIVE', tokenDecimals: 18 },
  { id: '0x4', tokenSymbol: 'bad symbol!', tokenName: 'Nope', deployments: [{ contractAddress: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0F', chainId: 4663 }], status: 'ASSET_STATUS_ACTIVE' },
  { id: '0x5', tokenSymbol: 'DUP', tokenName: 'Duplicate', deployments: [{ contractAddress: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEc', chainId: 4663 }], status: 'ASSET_STATUS_ACTIVE', tokenDecimals: 18 },
] };
const NVDA_QUOTE = { quotes: [{ tokenSymbol: 'NVDA', deployments: [{ contractAddress: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEc', chainId: 4663 }], bid: '241.48', ask: '241.49', currency: 'USD', dailyTradingVolume: '47056143', isTradingHalt: false, generatedAt: '2026-10-06T16:11:21.191832490Z', dailyHigh: '243.37', dailyLow: '239.18', tokenBid: '241.667185435074996081', tokenAsk: '241.677193186666642387' }] };

test('the tiers are Solana’s and the curve numbers match the contracts', () => {
  assert.deepEqual(ROBINHOOD_TIERS.map(t => [t.id, t.startUsd, t.graduationUsd]), [['4k', 4000, 50000], ['20k', 20000, 50000]]);
  assert.equal(robinhoodTier('4k').label, '$4k start'); assert.equal(robinhoodTier('nope'), null);
  // The same numbers the Solidity suite pins (ETH at $500 in the fixture: $4k = 8 ETH, $50k = 100 ETH).
  const low = curveForTargets(8n * ETHER, 100n * ETHER), high = curveForTargets(40n * ETHER, 100n * ETHER);
  const near = (a, b, bps = 5n) => assert.ok((a > b ? a - b : b - a) * 10000n <= b * bps, `${a} ~ ${b}`);
  near(low.virtualQuote, 8696n * ETHER / 1000n); near(low.graduationQuote, 22048n * ETHER / 1000n);
  near(high.virtualQuote, 66667n * ETHER / 1000n); near(high.graduationQuote, 38743n * ETHER / 1000n);
  // Values read back from a factory on anvil for $4k → $50k at $4,000 ETH.
  const anvil = curveForTargets(ETHER, 125n * ETHER / 10n);
  assert.equal(anvil.virtualQuote, 1086956521739130434n); assert.equal(anvil.graduationQuote, 2756015115144280021n);
  const split = plannedSupply(SUPPLY, anvil.virtualQuote, anvil.graduationQuote);
  assert.equal(split.sellSupply + split.lpSupply, SUPPLY);
  near(split.sellSupply, SUPPLY * 7795n / 10000n, 3n); near(split.lpSupply, SUPPLY * 2205n / 10000n, 10n);
  const fdv = fdvFor(SUPPLY, anvil.virtualQuote, anvil.graduationQuote);
  near(fdv.startFdv, ETHER, 1n); near(fdv.graduationFdv, 125n * ETHER / 10n, 1n);
  // Pump.fun's own 30 : 85 shape splits a billion 793.1 M / 206.9 M.
  const pump = plannedSupply(SUPPLY, 30n * ETHER, 85n * ETHER);
  assert.equal(pump.lpSupply, 206896551724137931034482758n); assert.equal(pump.virtualToken, 1073022312373225152129817445n);
  assert.throws(() => curveForTargets(10n, 10n), /above the starting/);
  assert.equal(isqrt(10n ** 36n), 10n ** 18n); assert.equal(isqrt(15n), 3n); assert.equal(isqrt(0n), 0n);
});

test('buy and sell quotes reproduce the curve, including the fill-up refund', () => {
  const vq = 30n * ETHER, r = 85n * ETHER;
  const { sellSupply, virtualToken } = plannedSupply(SUPPLY, vq, r);
  const curve = { virtualQuote: vq, virtualToken, graduationQuote: r, sellSupply, realQuote: 0n, sold: 0n, tradeFeeBps: 100, creatorTaxBps: 0, graduated: false };
  const one = quoteBuy(curve, ETHER);
  assert.equal(one.tokensOut, 34278544344933620542385262n, 'the Solidity suite’s number for 0.99 ETH net');
  assert.equal(one.fee, ETHER / 100n); assert.equal(one.refund, 0n);
  const fill = quoteBuy(curve, 100n * ETHER);
  assert.equal(fill.tokensOut, sellSupply, 'the whole sellable supply');
  assert.equal(fill.spent, 85858585858585858586n, '85 ETH net plus the fee'); assert.equal(fill.refund, 100n * ETHER - fill.spent);
  const after = { ...curve, realQuote: ETHER - ETHER / 100n, sold: one.tokensOut };
  const sell = quoteSell(after, one.tokensOut / 2n);
  assert.equal(sell.fee, 5030349237579931n); assert.equal(sell.quoteOut, 498004574520413182n);
  assert.equal(curvePrice(curve), vq * ETHER / virtualToken);
  assert.equal(progressBps(after), one.tokensOut * 10000n / sellSupply);
  assert.equal(quoteBuy({ ...curve, graduated: true }, ETHER).refund, ETHER, 'nothing after graduation');
  assert.equal(quoteSell(curve, 0n).quoteOut, 0n);
  const taxed = quoteBuy({ ...curve, creatorTaxBps: 500 }, ETHER);
  assert.equal(taxed.tax, ETHER * 5n / 100n);
});

test('tiers convert to pair units at a live price', () => {
  const eth = tierTargetsInPair(robinhoodTier('4k'), '4000', 18);
  assert.equal(eth.startFdv, ETHER); assert.equal(eth.graduationFdv, 125n * ETHER / 10n);
  const usdg = tierTargetsInPair(robinhoodTier('20k'), '1', 6);
  assert.equal(usdg.startFdv, 20000000000n); assert.equal(usdg.graduationFdv, 50000000000n);
  const nvda = tierTargetsInPair(robinhoodTier('20k'), '241.672189', 18);
  assert.equal(nvda.startFdv, 20000n * ETHER * 10n ** 8n / parsePrice('241.672189'));
  assert.equal(parsePrice('241.672189'), 24167218900n); assert.equal(parsePrice('1'), 100000000n);
  assert.throws(() => parsePrice('1e3'), /plain decimal/); assert.throws(() => tierTargetsInPair(robinhoodTier('4k'), '0', 18), /live pair price/);
  assert.equal(unitsToUsd(2n * ETHER, '4000', 18), 8000); assert.equal(unitsToUsd(19371290000n, '1', 6), 19371.29);
});

test('the policy is frozen, hashed and has Solana’s tiers; the funding plan covers fee, dev buy, gas and the fee wallet’s seed', () => {
  assert.equal(ROBINHOOD_LAUNCH_POLICY.version, 'robinhood-launch-policy-v3');
  assert.match(ROBINHOOD_LAUNCH_POLICY_HASH, /^[0-9a-f]{64}$/);
  assert.equal(policyFor('robinhood-launch-policy-v3', ROBINHOOD_LAUNCH_POLICY_HASH), ROBINHOOD_LAUNCH_POLICY);
  assert.throws(() => policyFor('robinhood-launch-policy-v9'), /Unknown/); assert.throws(() => policyFor('robinhood-launch-policy-v3', 'ff'), /does not match/);
  assert.throws(() => { ROBINHOOD_LAUNCH_POLICY.launch.quoteTtlMs = 1; }, TypeError);
  assert.deepEqual(ROBINHOOD_LAUNCH_POLICY.modes, [...ROBINHOOD_MODES]);
  assert.equal(tierById('4k').graduationUsd, 50000);
  assert.equal(feeRecipientRole('creator'), 'developer'); assert.equal(feeRecipientRole('holders'), 'fee'); assert.equal(feeRecipientRole('nope'), null);
  assert.equal(ledgerRole('earned'), 'escrow'); assert.equal(ledgerRole('insured'), 'insured'); assert.equal(ledgerRole('creator'), null);
  const plan = fundingPlan({ launchFeeWei: ETHER / 1000n, devBuyWei: ETHER / 10n, pairIsEth: true, maxFeePerGas: 100000000n });
  assert.equal(plan.launchFee, ETHER / 1000n); assert.equal(plan.devBuy, ETHER / 10n); assert.equal(plan.feeWalletGas, ETHER / 1000n, 'the fee wallet’s gas for its first claim');
  assert.equal(plan.gasBudget, (7000000n + 60000n) * 100000000n * 2n, 'gas units × price × head room');
  assert.equal(plan.totalWei, plan.launchFee + plan.devBuy + plan.gasBudget + plan.feeWalletGas);
  const usdg = fundingPlan({ launchFeeWei: ETHER / 1000n, devBuyWei: 5n * ETHER, pairIsEth: false, maxFeePerGas: 1n });
  assert.equal(usdg.devBuy, 0n, 'an ERC-20 dev buy is not ETH');
  assert.equal(usdg.feeWalletGas, 3n * ETHER / 1000n, 'the fee wallet’s gas seed on a non-ETH pair');
  assert.equal(usdg.gasPrice, 10000000n, 'the floor gas price applies when the chain is quieter than it');
});

test('the disclosure and the states read right', () => {
  const lines = robinhoodDisclosure('holders', { pair: 'NVDA', tier: '4k', creatorFeeBps: 100, rules: 2 });
  assert.ok(lines.some(l => l.includes('$50,000')) && lines.some(l => l.includes('NVDA pool')));
  assert.ok(lines.some(l => l.includes('creator fee')) && lines.some(l => l.includes('transfer rules')));
  assert.ok(lines.some(l => l.includes('paid in NVDA')) && lines.some(l => l.includes('network fees, which are ETH')));
  const creator = robinhoodDisclosure('creator', {});
  assert.ok(creator.some(l => l.includes('claim it yourself')) && !creator.some(l => l.includes('network fees, which are ETH')));
  assert.equal(ROBINHOOD_STATES.created, 'Live on Robinhood Chain');
});

test('stock assets are parsed from the API: active, deployed on chain 4663, well-formed, deduplicated, ETFs told apart', () => {
  const assets = parseStockAssets(ASSETS);
  assert.deepEqual(assets.map(a => a.symbol), ['CRM', 'GLD', 'NVDA', 'SPY']);
  const spy = assets.find(a => a.symbol === 'SPY');
  assert.equal(spy.address, '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C'); assert.equal(spy.kind, 'etf'); assert.equal(spy.name, 'SPDR S&P 500 ETF Trust');
  assert.equal(spy.decimals, 18); assert.equal(spy.isin, 'US78462F1030'); assert.equal(spy.multiplier, '1.001717991187472003'); assert.match(spy.logo, /^https:\/\/cdn\.robinhood\.com\//);
  assert.equal(assets.find(a => a.symbol === 'GLD').kind, 'etf'); assert.equal(assets.find(a => a.symbol === 'CRM').kind, 'stock');
  assert.equal(assets.find(a => a.symbol === 'NVDA').name, 'NVIDIA');
  assert.deepEqual(parseStockAssets({}), []); assert.deepEqual(parseStockAssets(null), []);
  assert.equal(cleanAssetName('Tesla • Robinhood Token'), 'Tesla'); assert.equal(cleanAssetName('  Plain  Name '), 'Plain Name');
  assert.equal(multiplierOf('abc'), '1'); assert.equal(multiplierOf('0'), '1'); assert.equal(multiplierOf('1.5'), '1.5');
});

test('stock token prices prefer the token-denominated quote and fall back to the equity price times the multiplier', () => {
  const price = stockTokenPrice(NVDA_QUOTE, '1.000041396932551318', 'NVDA');
  assert.equal(price.usd, '241.672189'); assert.equal(price.halted, false); assert.equal(price.bid, 241.48);
  assert.equal(price.at, Date.parse('2026-10-06T16:11:21.191Z'));
  const equityOnly = stockTokenPrice({ tokenSymbol: 'X', bid: '100', ask: '102', isTradingHalt: true }, '1.5');
  assert.equal(equityOnly.usd, '151.500000'); assert.equal(equityOnly.halted, true);
  assert.equal(stockTokenPrice({ tokenSymbol: 'X', bid: '0', ask: '' }), null);
  assert.equal(stockTokenPrice(NVDA_QUOTE, '1', 'TSLA'), null, 'another symbol’s quote is not this one');
});

function fakeRpc(quotes = {}) {
  return { async read({ address, functionName, args }) {
    if (functionName === 'quoteExactInputSingle') { const key = `${args[0].poolKey.fee}`; if (!(key in quotes)) throw Error('no pool'); return [quotes[key], 0n]; }
    throw Error('unexpected read ' + functionName);
  } };
}

test('ETH is priced from the best v4 ETH / USDG quote, and the probe encodes the pool key', async () => {
  const price = await ethUsdFromPools(fakeRpc({ 500: 3990000000n, 3000: 4001500000n }));
  assert.deepEqual(price, { usd: '4001.5000', source: 'uniswap-v4' });
  await assert.rejects(() => ethUsdFromPools({ async read() { throw Error('nope'); } }), /No ETH \/ USDG pool/);
  const data = quoterCallData(ROBINHOOD_ADDRESSES, 500, 10);
  assert.ok(data.startsWith('0x')); assert.ok(data.toLowerCase().includes(ROBINHOOD_ADDRESSES.usdg.slice(2).toLowerCase()));
});

test('the pair book lists ETH, USDG and the stocks, prices on demand with caching, and tolerates a dead API', async () => {
  let now = 1_800_000_000_000, assetCalls = 0, priceCalls = 0;
  const fetcher = async url => {
    if (url.includes('/rhj/assets')) { assetCalls++; return { ok: true, json: async () => ASSETS }; }
    if (url.includes('/rhj/prices/NVDA')) { priceCalls++; return { ok: true, json: async () => NVDA_QUOTE }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const book = new PairBook({ rpc: fakeRpc({ 500: 4000000000n }), fetcher, policy: ROBINHOOD_LAUNCH_POLICY, clock: () => now });
  const pairs = await book.pairs();
  assert.deepEqual(pairs.map(p => p.symbol), ['ETH', 'USDG', 'CRM', 'GLD', 'NVDA', 'SPY']);
  assert.equal(pairs[0].address, ROBINHOOD_NATIVE); assert.equal(pairs[1].kind, 'stable'); assert.equal(pairs[1].decimals, 6);
  await book.pairs(); assert.equal(assetCalls, 1, 'the list is cached for an hour');
  now += 3600001; await book.pairs(); assert.equal(assetCalls, 2, 'then refreshed');
  assert.equal((await book.priceUsd(ROBINHOOD_NATIVE)).usd, '4000.0000');
  assert.equal((await book.priceUsd(ROBINHOOD_ADDRESSES.usdg)).usd, '1');
  const nvda = await book.priceUsd('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEc');
  assert.equal(nvda.usd, '241.672189'); assert.equal(nvda.source, 'robinhood');
  await book.priceUsd('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'); assert.equal(priceCalls, 1, 'cached, case-insensitive');
  now += 60001; await book.priceUsd('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEc'); assert.equal(priceCalls, 2, 'refetched after the TTL');
  await assert.rejects(() => book.priceUsd('0x117cc2133c37B721F49dE2A7a74833232B3B4C0C'), /HTTP 404/, 'no quote for SPY in this fixture');
  await assert.rejects(() => book.priceUsd('0x0000000000000000000000000000000000000001'), /not listed/);
  const view = await book.listView();
  assert.equal(view.find(v => v.symbol === 'NVDA').usd, '241.672189'); assert.equal(view.find(v => v.symbol === 'SPY').usd, null);
  // The API dies: the last prices serve while they are not too stale, and the last list stays.
  book.fetcher = async () => { throw Error('down'); };
  now += 60001; assert.equal((await book.priceUsd('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEc')).stale, true, 'a stale price is served within 15 minutes');
  now += 900001; await assert.rejects(() => book.priceUsd('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEc'), /down/);
  now += 3600001; assert.equal((await book.pairs()).length, 6, 'the old list stays');
  assert.equal(book.stocksError, 'down');
  const override = new PairBook({ rpc: fakeRpc({}), fetcher, policy: ROBINHOOD_LAUNCH_POLICY, clock: () => now, ethUsdOverride: '3500' });
  assert.deepEqual(await override.priceUsd(ROBINHOOD_NATIVE).then(p => [p.usd, p.source]), ['3500', 'override']);
});

/** A chain with one ERC-20 (cbBTC, 8 dp) and the pools named in `pools`: {'v4:<sell>/<buy>': amountOut per whole token, 'v3:<a>/<b>': sqrtPriceX96}. */
function poolRpc({ pools = {}, token = '0x' + 'cb'.repeat(20), code = '0x6080', decimals = 8, supply = 10n ** 11n } = {}) {
  const A = ROBINHOOD_ADDRESSES, l = v => String(v).toLowerCase();
  return {
    async getCode(address) { return l(address) === l(token) ? code : '0x'; },
    async read({ address, functionName, args }) {
      if (l(address) === l(token)) { if (functionName === 'symbol') return ['cbBTC']; if (functionName === 'name') return ['Coinbase Wrapped BTC • Robinhood Token']; if (functionName === 'decimals') return [decimals]; if (functionName === 'totalSupply') return [supply]; }
      if (functionName === 'quoteExactInputSingle') {
        const k = args[0].poolKey, sell = args[0].zeroForOne ? k.currency0 : k.currency1, buy = args[0].zeroForOne ? k.currency1 : k.currency0, key = `v4:${l(sell)}/${l(buy)}`;
        assert.ok(BigInt(k.currency0) < BigInt(k.currency1), 'currencies are in canonical order');
        if (!(key in pools)) throw Error('no pool'); return [pools[key], 0n];
      }
      if (functionName === 'getPool') { const key = `v3:${l(args[0])}/${l(args[1])}`; return key in pools ? '0x' + '33'.repeat(20) : '0x' + '0'.repeat(40); }
      if (functionName === 'slot0') { const entry = Object.entries(pools).find(([key]) => key.startsWith('v3:')); return { sqrtPriceX96: entry[1] }; }
      throw Error('unexpected read ' + functionName);
    },
  };
}

test('any token is priced from the chain\'s pools: v4 into USDG first, then v4 into ETH times ETH, then v3; nothing prices → a clear error', async () => {
  const A = ROBINHOOD_ADDRESSES, token = '0x' + 'cb'.repeat(20), l = v => v.toLowerCase();
  const viaUsdg = await tokenUsdFromPools(poolRpc({ pools: { [`v4:${l(token)}/${l(A.usdg)}`]: 65000_000000n } }), token, 8);
  assert.deepEqual(viaUsdg, { usd: '65000.000000', source: 'uniswap-v4', via: 'USDG' });
  const viaEth = await tokenUsdFromPools(poolRpc({ pools: { [`v4:${l(token)}/${l(ROBINHOOD_NATIVE)}`]: 16n * 10n ** 18n } }), token, 8, A, { ethUsd: '4000' });
  assert.deepEqual(viaEth, { usd: '64000.000000', source: 'uniswap-v4', via: 'ETH' });
  // v3: cbBTC (8 dp) / USDG (6 dp); sqrtPriceX96 for a raw ratio of 650 USDG-units per cbBTC-unit when the token is currency0
  const tokenIs0 = BigInt(token) < BigInt(A.usdg), ratio = tokenIs0 ? 650 : 1 / 650, sqrt = BigInt(Math.round(Math.sqrt(ratio) * 2 ** 48)) * 2n ** 48n;
  const viaV3 = await tokenUsdFromPools(poolRpc({ pools: { [`v3:${l(token)}/${l(A.usdg)}`]: sqrt } }), token, 8);
  assert.equal(viaV3.source, 'uniswap-v3'); assert.ok(Math.abs(Number(viaV3.usd) - 65000) / 65000 < 0.001, viaV3.usd);
  await assert.rejects(() => tokenUsdFromPools(poolRpc({}), token, 8, A, { ethUsd: '4000' }), /No Uniswap pool/);
});

test('describeToken reads an ERC-20 and refuses an empty address, a non-token, more than 18 decimals and an empty supply', async () => {
  const token = '0x' + 'cb'.repeat(20);
  const info = await describeToken(poolRpc({}), token.toLowerCase());
  assert.equal(info.symbol, 'cbBTC'); assert.equal(info.name, 'Coinbase Wrapped BTC'); assert.equal(info.decimals, 8); assert.equal(info.totalSupply, '100000000000'); assert.match(info.address, /^0x[0-9a-fA-F]{40}$/);
  await assert.rejects(() => describeToken(poolRpc({}), '0x' + '11'.repeat(20)), /no contract at this address/);
  await assert.rejects(() => describeToken({ async getCode() { return '0x60'; }, async read() { throw Error('revert'); } }, token), /not an ERC-20/);
  await assert.rejects(() => describeToken(poolRpc({ decimals: 24 }), token), /24 decimals/);
  await assert.rejects(() => describeToken(poolRpc({ supply: 0n }), token), /no supply/);
  await assert.rejects(() => describeToken(poolRpc({}), 'nope'), /token address/);
});
