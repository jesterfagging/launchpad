// The pair assets a Robinhood launch can choose: ETH, USDG and every tokenised stock or ETF Robinhood lists on its
// chain (the public stock-token API), with live USD prices for the tiers — stocks from the same API (bid / ask mid
// times the token's share multiplier), ETH from the chain's own ETH / USDG pools, USDG at one dollar. Discovery is
// the same idea as the Pump.fun pair list: scan what the venue offers, keep what Launchpad can handle, let the owner
// approve it on chain. Nothing here signs or spends.
import { checksumAddress } from '../evm/secp256k1.mjs';
import { encodeCall, abiItem } from '../evm/abi.mjs';
import { ROBINHOOD_ADDRESSES, ROBINHOOD_ASSETS_URL, robinhoodPriceUrl, quoterAbi, v3FactoryAbi, v3PoolAbi, V4_FEE_TIERS, V3_FEE_TIERS } from './addresses.mjs';
import { ROBINHOOD_NATIVE, ROBINHOOD_CHAIN_ID } from '../../public/robinhood-launch-catalog.mjs';
import { parsePrice } from '../../public/robinhood-curve-math.mjs';

const ETF_WORDS = /\b(ETF|Trust|Fund|Index|Shares|iShares|SPDR|Invesco|Vanguard)\b/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function fetchJson(url, { fetcher = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw Object.assign(Error(`HTTP ${response.status} from ${new URL(url).hostname}`), { status: response.status });
    return await response.json();
  } finally { clearTimeout(timer); }
}

/** Strips Robinhood's " • Robinhood Token" suffix and similar decorations from a display name. */
export function cleanAssetName(name) {
  return String(name || '').replace(/\s*[•·-]\s*Robinhood\s+Token\s*$/i, '').replace(/\s+/g, ' ').trim();
}

/** A decimal string from the API's multiplier (18-dp shares per token), defaulting to 1. */
export function multiplierOf(value) {
  const text = String(value ?? '').trim();
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) && Number(text) > 0 ? text : '1';
}

/** The tokenised stocks and ETFs deployed on Robinhood Chain, from the public API. */
export function parseStockAssets(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.assets) ? payload.assets : Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  for (const asset of list) {
    if (!asset || typeof asset !== 'object') continue;
    if (asset.status && asset.status !== 'ASSET_STATUS_ACTIVE') continue;
    const deployment = (asset.deployments || []).find(d => Number(d?.chainId) === ROBINHOOD_CHAIN_ID && /^0x[0-9a-fA-F]{40}$/.test(String(d?.contractAddress || '')));
    if (!deployment) continue;
    const symbol = String(asset.tokenSymbol || '').trim().toUpperCase();
    if (!/^[A-Z0-9.]{1,12}$/.test(symbol)) continue;
    const name = cleanAssetName(asset.tokenName) || symbol;
    const decimals = Number.isInteger(asset.tokenDecimals) ? asset.tokenDecimals : 18;
    out.push({
      address: checksumAddress(deployment.contractAddress), symbol, name, decimals,
      kind: ETF_WORDS.test(name) ? 'etf' : 'stock',
      logo: typeof asset.logoUrl === 'string' && /^https:\/\/cdn\.robinhood\.com\//.test(asset.logoUrl) ? asset.logoUrl : null,
      isin: typeof asset.isin === 'string' ? asset.isin : null,
      multiplier: multiplierOf(asset.currentMultiplier),
      assetId: typeof asset.id === 'string' ? asset.id : null,
    });
  }
  const seen = new Set();
  return out.filter(a => !seen.has(a.address) && seen.add(a.address)).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/**
 * A stock token's USD price from the API's quote (`{quotes: [...]}` or one quote): the token-denominated bid / ask
 * when the API gives them (`tokenBid` / `tokenAsk`, already multiplier-adjusted), else the equity bid / ask times the
 * token's share multiplier. The mid price is used.
 */
export function stockTokenPrice(payload, multiplier = '1', symbol = null) {
  const list = Array.isArray(payload?.quotes) ? payload.quotes : [payload];
  const quote = list.find(q => q && typeof q === 'object' && (!symbol || String(q.tokenSymbol || '').toUpperCase() === String(symbol).toUpperCase()));
  if (!quote) return null;
  const mid = (a, b) => { const x = Number(a), y = Number(b); const ok = v => Number.isFinite(v) && v > 0; return ok(x) && ok(y) ? (x + y) / 2 : ok(x) ? x : ok(y) ? y : NaN; };
  let price = mid(quote.tokenBid, quote.tokenAsk);
  if (!Number.isFinite(price)) { const equity = mid(quote.bid, quote.ask); price = Number.isFinite(equity) ? equity * Number(multiplierOf(multiplier)) : NaN; }
  if (!Number.isFinite(price) || price <= 0) return null;
  return { usd: price.toFixed(6), halted: Boolean(quote.isTradingHalt), bid: Number(quote.bid), ask: Number(quote.ask), at: Date.parse(quote.generatedAt || '') || Date.now() };
}

const Q96 = 2n ** 96n;
const lowerHex = v => String(v || '').toLowerCase();
const ERC20_READ_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
];
/**
 * What an ERC-20 at `address` says about itself: symbol, name, decimals, total supply. Throws 'not an ERC-20' when the
 * address has no code or any of the four reads fails; decimals above 18 are refused (the curve maths is 18-dp).
 */
export async function describeToken(rpc, address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ''))) throw Object.assign(Error('Enter a Robinhood Chain token address (0x…).'), { code: 'ROBINHOOD_PAIR_ADDRESS', statusCode: 400 });
  const token = checksumAddress(address);
  const code = typeof rpc.getCode === 'function' ? await rpc.getCode(token).catch(() => '0x') : null;
  if (code !== null && (!code || code === '0x')) throw Object.assign(Error('There is no contract at this address on Robinhood Chain.'), { code: 'ROBINHOOD_PAIR_NOT_TOKEN', statusCode: 400 });
  let symbol, name, decimals, totalSupply;
  try {
    [[symbol], [name], [decimals], [totalSupply]] = await Promise.all(['symbol', 'name', 'decimals', 'totalSupply'].map(fn => rpc.read({ address: token, abi: ERC20_READ_ABI, functionName: fn })));
  } catch { throw Object.assign(Error('This address is not an ERC-20 token (it does not answer symbol, name, decimals and totalSupply).'), { code: 'ROBINHOOD_PAIR_NOT_TOKEN', statusCode: 400 }); }
  symbol = String(symbol || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 16); name = cleanAssetName(String(name || '')).replace(/[^\x20-\x7e]/g, '').trim().slice(0, 60);
  decimals = Number(decimals);
  if (!symbol) throw Object.assign(Error('This token has no symbol.'), { code: 'ROBINHOOD_PAIR_NOT_TOKEN', statusCode: 400 });
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw Object.assign(Error(`${symbol} uses ${decimals} decimals; Launchpad pairs support up to 18.`), { code: 'ROBINHOOD_PAIR_DECIMALS', statusCode: 400 });
  if (BigInt(totalSupply) === 0n) throw Object.assign(Error(`${symbol} has no supply yet.`), { code: 'ROBINHOOD_PAIR_NOT_TOKEN', statusCode: 400 });
  return { address: token, symbol, name: name || symbol, decimals, totalSupply: String(totalSupply) };
}
/** A v4 pool key for two currencies in canonical order, and which way a sale of `sell` goes. */
function v4Key(sell, buy, fee, tickSpacing) {
  const zeroForOne = BigInt(sell) < BigInt(buy);
  return { poolKey: { currency0: zeroForOne ? sell : buy, currency1: zeroForOne ? buy : sell, fee, tickSpacing, hooks: ROBINHOOD_NATIVE }, zeroForOne };
}
/** The best v4 quote (amount out) for selling `amountIn` of `sell` for `buy` across the common fee tiers, or 0n. */
async function bestV4Quote(rpc, addresses, sell, buy, amountIn) {
  let best = 0n;
  for (const [fee, tickSpacing] of V4_FEE_TIERS) {
    try {
      const { poolKey, zeroForOne } = v4Key(sell, buy, fee, tickSpacing);
      const [amountOut] = await rpc.read({ address: addresses.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: '0x' }] });
      if (amountOut > best) best = amountOut;
    } catch { /* no pool on this tier */ }
  }
  return best;
}
/** A v3 pool's price of `token` (tokenDecimals) in `quote` (quoteDecimals) across the fee tiers, as a Number, or 0. */
async function v3Price(rpc, addresses, token, tokenDecimals, quote, quoteDecimals) {
  for (const fee of V3_FEE_TIERS) {
    try {
      const pool = await rpc.read({ address: addresses.v3Factory, abi: v3FactoryAbi, functionName: 'getPool', args: [token, quote, fee] });
      if (!pool || /^0x0{40}$/i.test(pool)) continue;
      const slot0 = await rpc.read({ address: pool, abi: v3PoolAbi, functionName: 'slot0' });
      const sqrt = BigInt(slot0.sqrtPriceX96); if (sqrt === 0n) continue;
      const tokenIs0 = BigInt(token) < BigInt(quote);
      const ratioE18 = sqrt * sqrt * 10n ** 18n / (Q96 * Q96); // token1 per token0, raw units, ×1e18
      const raw = tokenIs0 ? Number(ratioE18) / 1e18 : ratioE18 > 0n ? 1e18 / Number(ratioE18) : 0; // quote raw per token raw
      const price = raw * 10 ** (tokenDecimals - quoteDecimals);
      if (price > 0 && Number.isFinite(price)) return price;
    } catch { /* no pool on this tier */ }
  }
  return 0;
}
/**
 * Any token's USD price from the chain's own Uniswap pools: a v4 quote of one whole token into USDG, else into ETH
 * times ETH's USD price, else the v3 pools the same way. Throws when no pool answers.
 */
export async function tokenUsdFromPools(rpc, token, decimals, addresses = ROBINHOOD_ADDRESSES, { ethUsd = null } = {}) {
  const one = 10n ** BigInt(decimals);
  const usdgOut = await bestV4Quote(rpc, addresses, token, addresses.usdg, one);
  if (usdgOut > 0n) return { usd: (Number(usdgOut) / 1e6).toFixed(6), source: 'uniswap-v4', via: 'USDG' };
  const eth = async () => ethUsd ?? (await ethUsdFromPools(rpc, addresses)).usd;
  const ethOut = await bestV4Quote(rpc, addresses, token, ROBINHOOD_NATIVE, one);
  if (ethOut > 0n) return { usd: (Number(ethOut) / 1e18 * Number(await eth())).toFixed(6), source: 'uniswap-v4', via: 'ETH' };
  const v3Usdg = await v3Price(rpc, addresses, token, decimals, addresses.usdg, 6);
  if (v3Usdg > 0) return { usd: v3Usdg.toFixed(6), source: 'uniswap-v3', via: 'USDG' };
  const v3Eth = await v3Price(rpc, addresses, token, decimals, addresses.weth, 18);
  if (v3Eth > 0) return { usd: (v3Eth * Number(await eth())).toFixed(6), source: 'uniswap-v3', via: 'ETH' };
  throw Object.assign(Error('No Uniswap pool on Robinhood Chain prices this token against USDG or ETH.'), { code: 'ROBINHOOD_PAIR_PRICE', statusCode: 409 });
}
/** ETH in USD from the chain's own pools: the v4 ETH→USDG quote for 1 ETH on the common fee tiers, else a v3 pool's price. */
export async function ethUsdFromPools(rpc, addresses = ROBINHOOD_ADDRESSES) {
  let best = 0n;
  for (const [fee, tickSpacing] of V4_FEE_TIERS) {
    try {
      const [amountOut] = await rpc.read({ address: addresses.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: { currency0: ROBINHOOD_NATIVE, currency1: addresses.usdg, fee, tickSpacing, hooks: ROBINHOOD_NATIVE }, zeroForOne: true, exactAmount: 10n ** 18n, hookData: '0x' }] });
      if (amountOut > best) best = amountOut;
    } catch { /* no pool on this tier */ }
  }
  if (best > 0n) return { usd: (Number(best) / 1e6).toFixed(4), source: 'uniswap-v4' };
  for (const fee of V3_FEE_TIERS) {
    try {
      const pool = await rpc.read({ address: addresses.v3Factory, abi: v3FactoryAbi, functionName: 'getPool', args: [addresses.weth, addresses.usdg, fee] });
      if (!pool || /^0x0{40}$/i.test(pool)) continue;
      const slot0 = await rpc.read({ address: pool, abi: v3PoolAbi, functionName: 'slot0' });
      const sqrt = BigInt(slot0.sqrtPriceX96);
      // price of token1 per token0 = (sqrt / 2^96)^2; WETH (18 dp) vs USDG (6 dp) in either order.
      const wethIs0 = BigInt(addresses.weth) < BigInt(addresses.usdg);
      const ratioE18 = sqrt * sqrt * 10n ** 18n / (Q96 * Q96);
      const usd = wethIs0 ? Number(ratioE18) / 1e18 * 1e12 : ratioE18 > 0n ? 1e18 / Number(ratioE18) / 1e12 : 0;
      if (usd > 0) return { usd: usd.toFixed(4), source: 'uniswap-v3' };
    } catch { /* no pool on this tier */ }
  }
  throw Object.assign(Error('No ETH / USDG pool answered for the ETH price.'), { code: 'ROBINHOOD_ETH_PRICE' });
}

/**
 * The live pair book: ETH, USDG and the listed stock tokens, with prices on demand. `rpc` reads the chain; `fetcher`
 * reaches the public API; `clock` and `overrides` serve the tests and an operator's emergency price.
 */
export class PairBook {
  constructor({ rpc, fetcher = globalThis.fetch, policy, clock = () => Date.now(), log = () => {}, ethUsdOverride = null, addresses = ROBINHOOD_ADDRESSES }) {
    this.rpc = rpc; this.fetcher = fetcher; this.policy = policy; this.clock = clock; this.log = log; this.addresses = addresses;
    this.ethUsdOverride = ethUsdOverride ? String(ethUsdOverride) : null;
    this.stocks = []; this.stocksAt = 0; this.stocksError = null;
    this.custom = []; // owner-added ERC-20 pairs (kind 'custom'), priced from the chain's pools
    this.prices = new Map(); // address → {usd, at, source, halted}
    this.inflight = new Map();
  }
  /** The owner-added pairs (from the store): {address, symbol, name, decimals, logo}. */
  setCustomPairs(rows) {
    this.custom = (Array.isArray(rows) ? rows : []).filter(r => r && /^0x[0-9a-fA-F]{40}$/.test(String(r.address || ''))).map(r => ({ address: checksumAddress(r.address), symbol: String(r.symbol || '?'), name: String(r.name || r.symbol || '?'), decimals: Number(r.decimals ?? 18), kind: 'custom', logo: r.logo || null, isin: null, multiplier: '1', assetId: null }));
  }

  /** The fixed pairs every deployment has. */
  basePairs() {
    return [
      { address: ROBINHOOD_NATIVE, symbol: 'ETH', name: 'Ether', decimals: 18, kind: 'native', logo: null, isin: null, multiplier: '1', assetId: null },
      { address: this.addresses.usdg, symbol: 'USDG', name: 'Global Dollar', decimals: 6, kind: 'stable', logo: null, isin: null, multiplier: '1', assetId: null },
    ];
  }

  /** Every pair the book knows (refreshing the stock list when it is stale); never throws for a stale stock list. */
  async pairs({ refresh = true } = {}) {
    if (refresh) await this.refreshStocks().catch(() => {});
    const seen = new Set();
    return [...this.basePairs(), ...this.stocks, ...this.custom].filter(p => !seen.has(lowerHex(p.address)) && seen.add(lowerHex(p.address)));
  }

  pairByAddress(address) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ''))) return null;
    const wanted = address.toLowerCase();
    return [...this.basePairs(), ...this.stocks, ...this.custom].find(p => p.address.toLowerCase() === wanted) || null;
  }

  /** Reads what a token says about itself (symbol, name, decimals, supply); throws when it is not an ERC-20. */
  describeToken(address) { return describeToken(this.rpc, address); }
  /** A token's USD price from the chain's pools (no listing needed), cached a minute. */
  async poolPrice(address, decimals) {
    const key = 'pool:' + lowerHex(address), cached = this.prices.get(key);
    if (cached && this.clock() - cached.at < (this.policy?.market?.priceTtlMs ?? 60000)) return cached;
    const ethUsd = this.ethUsdOverride || null;
    const entry = { ...(await tokenUsdFromPools(this.rpc, checksumAddress(address), decimals, this.addresses, { ethUsd })), halted: false, at: this.clock() };
    parsePrice(entry.usd); this.prices.set(key, entry); return entry;
  }

  async refreshStocks({ force = false } = {}) {
    const ttl = this.policy?.market?.assetsTtlMs ?? 3600000;
    if (!force && this.stocksAt && this.clock() - this.stocksAt < ttl) return this.stocks;
    if (this.inflight.has('stocks')) return this.inflight.get('stocks');
    const job = (async () => {
      try {
        const payload = await fetchJson(ROBINHOOD_ASSETS_URL, { fetcher: this.fetcher });
        const parsed = parseStockAssets(payload);
        this.stocks = parsed; this.stocksAt = this.clock(); this.stocksError = null;
        this.log('robinhood-pairs', { stocks: parsed.length });
        return parsed;
      } catch (error) {
        this.stocksError = error?.message || String(error);
        this.log('robinhood-pairs-error', { error: this.stocksError });
        if (!this.stocksAt) this.stocksAt = this.clock() - ttl + 60000; // retry in a minute, not on every call
        throw error;
      } finally { this.inflight.delete('stocks'); }
    })();
    this.inflight.set('stocks', job);
    return job;
  }

  /** USD per whole unit of a pair asset, cached for the policy's price TTL. Throws when no fresh price exists. */
  async priceUsd(address, { maxAgeMs = this.policy?.market?.priceTtlMs ?? 60000 } = {}) {
    const pair = this.pairByAddress(address);
    if (!pair) throw Object.assign(Error('This pair asset is not listed.'), { code: 'ROBINHOOD_PAIR_UNKNOWN', statusCode: 400 });
    if (pair.kind === 'stable') return { usd: '1', at: this.clock(), source: 'fixed', halted: false };
    const cached = this.prices.get(pair.address.toLowerCase());
    if (cached && this.clock() - cached.at < maxAgeMs) return cached;
    const key = 'price:' + pair.address.toLowerCase();
    if (this.inflight.has(key)) return this.inflight.get(key);
    const job = (async () => {
      try {
        let entry;
        if (pair.kind === 'native') {
          entry = this.ethUsdOverride ? { usd: this.ethUsdOverride, source: 'override' } : await ethUsdFromPools(this.rpc, this.addresses);
          entry.halted = false;
        } else if (pair.kind === 'custom') {
          entry = { ...(await tokenUsdFromPools(this.rpc, pair.address, pair.decimals, this.addresses, { ethUsd: this.ethUsdOverride || null })), halted: false };
        } else {
          const quote = await fetchJson(robinhoodPriceUrl(pair.symbol), { fetcher: this.fetcher });
          entry = stockTokenPrice(quote, pair.multiplier, pair.symbol);
          if (!entry) throw Object.assign(Error(`No quote for ${pair.symbol}.`), { code: 'ROBINHOOD_PAIR_PRICE' });
          entry.source = 'robinhood';
        }
        parsePrice(entry.usd); // validates the decimal
        entry.at = this.clock();
        this.prices.set(pair.address.toLowerCase(), entry);
        return entry;
      } catch (error) {
        const stale = this.policy?.market?.stalePriceMs ?? 900000;
        if (cached && this.clock() - cached.at < stale) return { ...cached, stale: true };
        throw Object.assign(error instanceof Error ? error : Error(String(error)), { code: error?.code || 'ROBINHOOD_PAIR_PRICE' });
      } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, job);
    return job;
  }

  /** The public view of the pair list: what the launch page shows (prices included when they are cached). */
  async listView() {
    const pairs = await this.pairs();
    return pairs.map(p => {
      const price = p.kind === 'stable' ? { usd: '1' } : this.prices.get(p.address.toLowerCase());
      return { address: p.address, symbol: p.symbol, name: p.name, decimals: p.decimals, kind: p.kind, logo: p.logo, isin: p.isin, usd: price?.usd ?? null, halted: price?.halted ?? false, priceAt: price?.at ?? null };
    });
  }
}

/** Builds call data for the quoter (exposed for tests of the probe's encoding). */
export const quoterCallData = (addresses, fee, tickSpacing) => encodeCall(abiItem(quoterAbi, 'quoteExactInputSingle'), [{ poolKey: { currency0: ROBINHOOD_NATIVE, currency1: addresses.usdg, fee, tickSpacing, hooks: ROBINHOOD_NATIVE }, zeroForOne: true, exactAmount: 10n ** 18n, hookData: '0x' }]);
export { ROBINHOOD_ADDRESSES };
