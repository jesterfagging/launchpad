import { PublicKey } from '@solana/web3.js';
import { formatUnits } from 'viem';
import { createHash } from 'node:crypto';
import { operatorRpcOptions, rpcEndpointHash } from './operator-capacity.mjs';
import { createPublicFetcher, publicEndpoint } from './telegram-network.mjs';
import { SharedRpcGate } from './shared-rpc-gate.mjs';
import { LiveMarketTrades, decodeExplorerPoolSwap } from './live-market-trades.mjs';
import { rawAmount, supplyPercent, heliusHolderHistory, blockscoutHolderHistory } from './holder-analytics.mjs';
import { LAUNCH_ASSETS } from '../public/launch-assets.mjs';

const CG = 'https://api.coingecko.com/api/v3/onchain';
const CG_PRO = 'https://pro-api.coingecko.com/api/v3/onchain';
const DEX = 'https://api.dexscreener.com';
// Public requests share one IP quota, regardless of which account opens a tab.
// A fetcher-scoped cache also keeps injected test providers isolated.
const publicDexFeeds = new WeakMap();
const dexFeed = fetcher => {
  if (!publicDexFeeds.has(fetcher)) publicDexFeeds.set(fetcher, { cache: new Map(), pending: new Map(), requests: [], retryUntil: 0 });
  return publicDexFeeds.get(fetcher);
};
const WINDOWS = ['m5', 'h1', 'h6', 'h24'];
const finite = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const dexNumber = value => ['string', 'number'].includes(typeof value) && /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(String(value)) ? finite(value) : null;
const positive = value => { const number = dexNumber(value); return number > 0 ? number : null; };
const nonnegative = value => { const number = dexNumber(value); return number !== null && number >= 0 ? number : null; };
const windowValues = (value, convert) => Object.fromEntries(WINDOWS.map(window => [window, convert(value?.[window])]));
const label = value => String(value || '').slice(0, 100);
const unavailable = (message, retryAfterMs = 15000) => Object.assign(Error(message), { statusCode: 503, retryAfterMs });
const needsConnection = message => Object.assign(Error(message), { statusCode: 428, connectionRequired: true });
export function marketAddress(chain, value) {
  if (!['solana', 'robinhood'].includes(chain)) throw Object.assign(Error('Choose Solana or Robinhood.'), { statusCode: 400 });
  if (typeof value !== 'string' || value.length > 44) throw Object.assign(Error('Enter a token contract address.'), { statusCode: 400 });
  try {
    if (chain === 'solana') return new PublicKey(value).toBase58();
    if (/^0x[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  } catch {}
  throw Object.assign(Error(`Enter a valid ${chain === 'solana' ? 'Solana mint' : 'Robinhood contract'} address.`), { statusCode: 400 });
}
const poolAddress = (chain, value) => chain === 'robinhood' && /^0x[0-9a-f]{64}$/i.test(value || '') ? value.toLowerCase() : marketAddress(chain,value);

function dexPair(chain, token, row) {
  if (row?.chainId !== chain) return null;
  const base = row.baseToken, quote = row.quoteToken;
  let address, baseAddress, quoteAddress;
  try { address = poolAddress(chain, row.pairAddress); baseAddress = marketAddress(chain, base?.address); quoteAddress = marketAddress(chain, quote?.address); } catch { return null; }
  if (baseAddress === quoteAddress || ![baseAddress, quoteAddress].includes(token)) return null;
  const isBase = baseAddress === token, asset = isBase ? base : quote;
  const basePrice = positive(row.priceUsd), nativePrice = positive(row.priceNative);
  const quotePrice = basePrice && nativePrice ? positive(basePrice / nativePrice) : null;
  const url = `https://dexscreener.com/${chain}/${address}`;
  const count = value => { const n = nonnegative(value); return Number.isSafeInteger(n) ? n : null; };
  return { address, token, symbol: label(asset.symbol), name: label(asset.name), pair: label(`${label(base.symbol) || baseAddress} / ${label(quote.symbol) || quoteAddress}`), dex: label(row.dexId),
    base: { address: baseAddress, symbol: label(base.symbol), priceUsd: basePrice }, quote: { address: quoteAddress, symbol: label(quote.symbol), priceUsd: quotePrice }, isBase,
    priceUsd: isBase ? basePrice : quotePrice, liquidityUsd: nonnegative(row.liquidity?.usd), volume24h: nonnegative(row.volume?.h24), marketCapUsd: isBase ? nonnegative(row.marketCap) : null, fdvUsd: isBase ? nonnegative(row.fdv) : null,
    priceChange: isBase ? windowValues(row.priceChange, dexNumber) : null,
    txns: windowValues(row.txns, value => ({ buys: count(value?.buys), sells: count(value?.sells) })),
    volume: windowValues(row.volume, nonnegative), createdAt: positive(row.pairCreatedAt),
    url, chart: `${url}?embed=1&theme=dark&info=0&trades=0` };
}

// Private providers retain account-scoped credentials and quotas. Dexscreener
// is public and shares a cache and quota; this service never receives wallet keys.
export class MarketData {
  constructor({ fetcher = fetch, rpcFetcher, now = Date.now, blockscoutKey = '', coingeckoKey = '', coingeckoPlan = 'demo', solanaRpcUrl = '', heliusKey = '', robinhoodRpcUrl = '', rpcRequestsPerSecond = 8, robinhoodRpcRequestsPerSecond = 10, rpcGate, rpcScope = '', marketRefreshSeconds = '60' } = {}) {
    Object.assign(this, { fetcher, rpcFetcher, now, blockscoutKey, coingeckoKey, coingeckoPlan, solanaRpcUrl, heliusKey, robinhoodRpcUrl, rpcRequestsPerSecond, robinhoodRpcRequestsPerSecond, rpcScope });
    this.rpcGate = rpcGate || new SharedRpcGate(); this.ownsRpcGate = !rpcGate; this.rpcClient = Symbol('market-viewer');
    this.liveFeed = new LiveMarketTrades({ rpc: (chain,method,params) => this.rpcRead(chain,method,params), explorer: path => this.explorer(path), now });
    this.refreshMs = Number(marketRefreshSeconds) * 1000;
    this.cache = new Map(); this.pending = new Map(); this.budgets = new Map();
    this.dex = dexFeed(fetcher);
  }
  marketJson(path) {
    if (!this.coingeckoKey) throw needsConnection('Add your CoinGecko API key in Account → Connections → Market data to load charts and swaps.');
    const pro = this.coingeckoPlan === 'pro';
    return this.json(`${pro ? CG_PRO : CG}${path}`, { headers: { [pro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key']: this.coingeckoKey } });
  }
  async cached(key, ttl, action, state = this) {
    const old = state.cache.get(key); if (old && old.until > this.now()) return old.value;
    if (state.pending.has(key)) return state.pending.get(key);
    if (state.pending.size >= 20) throw unavailable('Market data is busy. Try again shortly.');
    const job = action().then(value => {
      state.cache.delete(key); state.cache.set(key, { value, until: this.now() + ttl });
      while (state.cache.size > 100) state.cache.delete(state.cache.keys().next().value);
      return value;
    }).catch(error => {
      // Retain a recent successful snapshot during throttling, but never label
      // it fresh or substitute another token/pool's records.
      if (old && this.now() - old.value.at < 300000) return { ...old.value, stale: true, warning: error.message, retryAt: this.now() + (error.retryAfterMs || 15000) };
      throw error;
    }).finally(() => state.pending.delete(key));
    state.pending.set(key, job); return job;
  }
  async json(url, options = {}, fetcher = this.fetcher, publicDex = false, isRpc = false) {
    const host = new URL(url).hostname, budget = this.budgets.get(host) || { count: 0, until: 0 };
    const explorer = ['api.blockscout.com','robinhoodchain.blockscout.com'].includes(host);
    const explorerKey=explorer?`${this.rpcScope}:explorer:${createHash('sha256').update(host+':'+this.blockscoutKey).digest('hex')}`:null;
    if (publicDex) {
      const now = this.now();
      this.dex.requests = this.dex.requests.filter(at => at > now - 60000);
      if (this.dex.retryUntil > now) throw unavailable('DEX Screener is cooling down. The feed will retry automatically.', this.dex.retryUntil - now);
      // Leave headroom below the provider's 300 requests/minute public limit.
      if (this.dex.requests.length >= 240) throw unavailable('DEX Screener is busy. The feed will retry automatically.', Math.max(1000, this.dex.requests[0] + 60000 - now));
      this.dex.requests.push(now);
    } else if (!isRpc) {
      if (budget.until <= this.now()) { budget.count = 0; budget.until = this.now() + 60000; }
      this.budgets.set(host, budget);
      if (budget.count >= (explorer ? 120 : 24)) throw unavailable('Your market-data allowance is cooling down. The feed will retry automatically.', Math.max(1000, budget.until - this.now()));
      budget.count++;
    }
    if(explorer){
      await this.rpcGate.acquire(explorerKey,this.rpcClient,2,{signal:AbortSignal.timeout(15000),deadline:Date.now()+15000});
      if(budget.count===Infinity&&budget.until>this.now())throw unavailable('Your data provider is rate limited. The feed will retry after its cooldown.',budget.until-this.now());
    }
    let response;
    try { response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000), headers: { accept: 'application/json', ...options.headers } }); }
    catch { throw unavailable('Market-data provider is temporarily unreachable. Trading runs continue independently.'); }
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const delay = /^\d+(?:\.\d+)?$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry || '') - this.now();
      if (publicDex) {
        this.dex.retryUntil = Math.max(this.dex.retryUntil, this.now() + (Number.isFinite(delay) && delay > 0 ? delay : 60000));
        throw unavailable('DEX Screener is rate limited. The feed will retry after its cooldown.', this.dex.retryUntil - this.now());
      }
      budget.count = Infinity; budget.until = Math.max(budget.until, this.now() + (Number.isFinite(delay) && delay > 0 ? delay : 60000));
      if(explorer)this.rpcGate.cooldown?.(explorerKey,budget.until-this.now());
      throw unavailable('Your data provider is rate limited. The feed will retry after its cooldown.', budget.until - this.now());
    }
    if (response.status === 404) return null;
    if ([401, 403].includes(response.status)) {
      if (publicDex) throw unavailable('DEX Screener is temporarily unavailable. The feed will retry automatically.');
      throw needsConnection('Your data provider rejected this connection. Check your API key, key type, and plan in Account → Connections.');
    }
    if (!response.ok) throw unavailable(`Market-data provider returned HTTP ${response.status}.`);
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2000000) throw Error(); chunks.push(Buffer.from(value)); } return JSON.parse(Buffer.concat(chunks).toString()); }
    catch { await reader.cancel().catch(() => {}); throw unavailable('Market-data provider returned an invalid response.'); }
  }
  async pools(chain, token, selectedPair = '') {
    if (typeof selectedPair !== 'string') throw Object.assign(Error('Choose a valid pool.'), { statusCode: 400 });
    if (selectedPair) selectedPair = poolAddress(chain, selectedPair);
    token = marketAddress(chain, token);
    const snapshot = await this.cached(`pools:${chain}:${token}`, 60000, async () => {
      const data = await this.json(`${DEX}/token-pairs/v1/${chain}/${token}`, {}, this.fetcher, true);
      if (data !== null && !Array.isArray(data)) throw unavailable('DEX Screener returned an invalid pair response.');
      const seen = new Set();
      const pools = (data || []).slice(0, 1000).flatMap(row => {
        const pair = dexPair(chain, token, row);
        if (!pair || seen.has(pair.address)) return [];
        seen.add(pair.address);
        return [pair];
      }).sort((a,b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0)).slice(0, 20);
      return { chain, tokenAddress: token, pools, at: this.now(), source: 'DEX Screener', note: pools.length ? null : 'No indexed pool found yet. New launches may appear after DEX Screener indexes them.' };
    }, this.dex);
    if (!selectedPair || snapshot.pools.some(pair => pair.address === selectedPair)) return { ...snapshot, refreshMs: this.refreshMs };
    // Rankings and the provider's token-list limit must not evict the market
    // someone is watching. Confirm that exact pair separately before removing it.
    const selected = await this.cached(`pair:${chain}:${token}:${selectedPair}`, 60000, async () => {
      const data = await this.json(`${DEX}/latest/dex/pairs/${chain}/${selectedPair}`, {}, this.fetcher, true);
      if (data !== null && (!Object.hasOwn(data, 'pairs') || (data.pairs !== null && !Array.isArray(data.pairs)))) throw unavailable('DEX Screener returned an invalid selected-pair response.');
      const rows = data?.pairs || [];
      const pair = rows.slice(0, 1000).map(row => dexPair(chain, token, row)).find(row => row?.address === selectedPair);
      // A nonempty but mismatched response is a provider error, not proof that
      // the selected market disappeared. Never substitute another pair/token.
      if (rows.length && !pair) throw unavailable('DEX Screener could not verify the selected pool.');
      return { pools: pair ? [pair] : [], at: this.now() };
    }, this.dex);
    if (selected.stale && !selected.pools.length) throw unavailable(selected.warning, Math.max(1000, selected.retryAt - this.now()));
    const pools = [...snapshot.pools, ...selected.pools];
    const delayed = [snapshot, selected].filter(row => row.stale);
    return { ...snapshot, pools, at: Math.min(snapshot.at, selected.at), note: pools.length ? null : snapshot.note, refreshMs: this.refreshMs,
      ...(delayed.length ? { stale: true, warning: delayed.map(row => row.warning).filter(Boolean).join(' '), retryAt: Math.max(...delayed.map(row => row.retryAt || 0)) } : {}) };
  }
  async trades(chain, address) {
    address = poolAddress(chain, address);
    return this.cached(`trades:${chain}:${address}`, 60000, async () => {
      const data = await this.marketJson(`/networks/${chain}/pools/${address}/trades`);
      if (!data) throw unavailable('Recent swaps are not available for this pool yet.');
      const trades = (data.data || []).slice(0, 100).map(row => { const a = row.attributes || {}; return { id: label(row.id), at: Date.parse(a.block_timestamp) || null, side: ['buy','sell'].includes(a.kind) ? a.kind : 'swap', signature: label(a.tx_hash), wallet: label(a.tx_from_address), amountUsd: finite(a.volume_in_usd), priceUsd: finite(a.price_to_in_usd), from: label(a.from_token_address), to: label(a.to_token_address) }; });
      return { chain, address, trades, at: this.now(), source: 'CoinGecko', refreshMs: this.refreshMs, note: 'Recent indexed swaps. Buy/sell is relative to the pool’s base token. Provider timestamps may lag execution.' };
    });
  }
  async candles(chain, address, interval = '1m', unit = 'base') {
    address = poolAddress(chain,address);
    const intervals = { '1m':['minute',1], '5m':['minute',5], '15m':['minute',15], '1h':['hour',1] };
    if (!Object.hasOwn(intervals,interval) || !['base','quote'].includes(unit)) throw Object.assign(Error('Choose a supported chart interval and token.'),{statusCode:400});
    const [frame,aggregate]=intervals[interval];
    return this.cached(`candles:${chain}:${address}:${interval}:${unit}`,60000,async()=>{
      const data=await this.marketJson(`/networks/${chain}/pools/${address}/ohlcv/${frame}?aggregate=${aggregate}&limit=200&currency=usd&token=${unit}`);
      if(!data?.data?.attributes?.ohlcv_list)throw unavailable('Candles are not available for this pool yet.');
      const rows=data.data.attributes.ohlcv_list.slice(0,200).flatMap(row=>{
        if(!Array.isArray(row)||row.length<6)return [];const [time,open,high,low,close,volume]=row.map(Number);
        if(![time,open,high,low,close,volume].every(Number.isFinite)||!Number.isInteger(time)||time<=0||time>Date.now()/1000+60||Math.min(open,high,low,close)<=0||volume<0||high<Math.max(open,close)||low>Math.min(open,close))return [];
        return [{time,open,high,low,close,volume}];
      });
      return {chain,address,interval,unit,currency:'USD',at:this.now(),source:'CoinGecko',refreshMs:this.refreshMs,candles:[...new Map(rows.map(row=>[row.time,row])).values()].sort((a,b)=>a.time-b.time)};
    });
  }
  async rpcRead(chain, method, params) {
    const url = chain === 'solana' ? this.solanaRpcUrl : this.robinhoodRpcUrl;
    if (!url) throw needsConnection(`Save your ${chain === 'solana' ? 'Solana RPC or Helius key' : 'Robinhood RPC'} in Account → Connections to load onchain activity.`);
    const rawRate = chain === 'solana' ? this.rpcRequestsPerSecond : this.robinhoodRpcRequestsPerSecond;
    const rate = Number(rawRate);
    if (!Number.isInteger(rate) || rate < 1 || rate > 1000) throw needsConnection('Set a valid RPC request limit in Connections.');
    const endpoint = publicEndpoint(url).toString(), endpointHash = rpcEndpointHash(endpoint), gateKey = `rpc:${endpointHash}`;
    const signal = AbortSignal.timeout(15000);
    try {
      await this.rpcGate.acquire(gateKey,this.rpcClient,rate,{...operatorRpcOptions(endpointHash),method,signal,deadline:Date.now()+15000});
      const value = await this.json(endpoint, { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, this.rpcFetcher || this.fetcher, false, true);
      if (value?.error || !value || !Object.hasOwn(value,'result')) {
        if (value?.error?.code === 429 || /rate.?limit|too many requests/i.test(value?.error?.message || '')) throw unavailable('Your RPC provider is cooling down after a rate limit.', 2000);
        throw unavailable('Your RPC could not load onchain market activity. Check its plan and connection.');
      }
      return value.result;
    } catch (error) {
      if (error.retryAfterMs) this.rpcGate.cooldown(gateKey,error.retryAfterMs);
      throw error;
    }
  }
  rpc(method,params) { return this.rpcRead('solana',method,params); }
  async liveTrades(chain,token,pairAddress) {
    token = marketAddress(chain,token); pairAddress = poolAddress(chain,pairAddress);
    const snapshot = await this.pools(chain,token,pairAddress), pair = snapshot.pools.find(row => row.address === pairAddress);
    if (!pair) throw unavailable('The selected pool is no longer indexed. Choose another pool.');
    const quoteUsd = (pair.isBase ? pair.quote : pair.base).priceUsd;
    return this.liveFeed.read({chain,pair,tokenAddress:token,quoteUsd});
  }
  // The authenticated launch route supplies an owned, persisted public launch.
  // Never accept a pool descriptor from the browser or require DEX discovery:
  // LiveMarketTrades verifies the actual program, pool discriminator and mints.
  async launchTrades(launch, marketSnapshot = null) {
    if (!launch || !/^[a-f0-9]{32}$/.test(launch.id || '') || launch.input?.network !== 'mainnet-beta' || launch.input?.route !== 'raydium' || !launch.curve) {
      throw Object.assign(Error('Choose an onchain Solana mainnet launch.'), { statusCode: 400 });
    }
    const token = marketAddress('solana', launch.mint), quote = marketAddress('solana', launch.input.quoteMint), curve = marketAddress('solana', launch.curve);
    if (new Set([token, quote, curve]).size !== 3) throw Object.assign(Error('The launch market addresses do not match a valid pool.'), { statusCode: 400 });
    const matches = marketSnapshot?.launchId === launch.id && marketSnapshot.mint === token && marketSnapshot.curve === curve && marketSnapshot.quote?.mint === quote;
    const recent = (at, ttl) => typeof at === 'number' && Number.isFinite(at) && at <= this.now() && this.now() - at <= ttl;
    const currentQuote = matches && !marketSnapshot.stale && recent(marketSnapshot.at, 15000) && !marketSnapshot.quote.stale && recent(marketSnapshot.quote.at, 60000);
    const quoteUsd = currentQuote ? positive(marketSnapshot.quote.usd) : null;
    const quoteSymbol = label(LAUNCH_ASSETS.find(asset => asset.mint === quote)?.symbol || (matches && marketSnapshot.quote.symbol) || 'Quote');
    const pair = { address: curve, token, isBase: true, dex: 'raydium', base: { address: token, symbol: label(launch.input.symbol) }, quote: { address: quote, symbol: quoteSymbol } };
    // Store confirmed native amounts only. The quote reference can expire while
    // these rows remain cached; value them against this response's fresh price.
    const result = await this.liveFeed.read({ chain: 'solana', pair, tokenAddress: token, quoteUsd: null });
    const trades = result.trades.map(row => {
      const tokens = positive(row.tokenAmount), quotes = positive(row.quoteAmount);
      const amountUsd = quoteUsd && quotes ? positive(quoteUsd * quotes) : null;
      const priceUsd = amountUsd && tokens ? positive(amountUsd / tokens) : null;
      const supply = currentQuote ? positive(marketSnapshot.supply) : null;
      return { ...row, quoteSymbol, amountUsd, priceUsd, fdvUsd: priceUsd && supply ? positive(priceUsd * supply) : null, marketCapUsd: null };
    });
    return { ...result, trades, launchId: launch.id, quoteSymbol, quoteUsd, quoteAt: quoteUsd ? marketSnapshot.quote.at : null };
  }
  close() { this.rpcGate.removeClient(this.rpcClient); if (this.ownsRpcGate) this.rpcGate.close(); this.liveFeed.close?.(); }
  explorer(path) {
    // The live feed can request only explorer reads; credentials never leave
    // Blockscout and no supplied path can replace the fixed origin.
    if(typeof path!=='string'||path.length>4096||!/^\/api(?:\?|\/v2\/)/.test(path)||path.includes('\\')||path.includes('#'))throw Error('Unsupported explorer read.');
    const parsed=new URL(path,'https://robinhoodchain.blockscout.com');
    if(parsed.origin!=='https://robinhoodchain.blockscout.com'||parsed.pathname==='/api'&&(parsed.searchParams.get('module')!=='logs'||parsed.searchParams.get('action')!=='getLogs'))throw Error('Unsupported explorer read.');
    const base=this.blockscoutKey?'https://api.blockscout.com/4663':'https://robinhoodchain.blockscout.com';
    parsed.searchParams.delete('apikey');if(this.blockscoutKey)parsed.searchParams.set('apikey',this.blockscoutKey);
    return this.json(base+parsed.pathname+(parsed.searchParams.size?'?'+parsed.searchParams:''));
  }
  holderHistoryKey() {
    if (this.heliusKey) return this.heliusKey;
    // Custom RPC credentials must never be sent to a different provider.
    try { const url = new URL(this.solanaRpcUrl); if (url.hostname === 'mainnet.helius-rpc.com') return url.searchParams.get('api-key') || ''; } catch {}
    return '';
  }
  async holders(chain, token) {
    token = marketAddress(chain, token);
    return this.cached(`holders:${chain}:${token}`, 15000, async () => {
      if (chain === 'robinhood') {
        if (!this.blockscoutKey) throw needsConnection('Add your Blockscout API key in Account → Connections → Market data to load Robinhood holders.');
        const base = 'https://api.blockscout.com/4663', query = `?apikey=${encodeURIComponent(this.blockscoutKey)}`;
        const info = await this.json(`${base}/api/v2/tokens/${token}${query}`);
        const data = await this.json(`${base}/api/v2/tokens/${token}/holders${query}`);
        if (!info || !Array.isArray(data?.items)) throw unavailable('The explorer has not indexed holder data for this token yet.');
        const decimals = Number(info.decimals); if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw unavailable('Holder balances are not available yet.');
        const seen = new Set(); let listedRaw = 0n;
        const rows = data.items.slice(0, 50).flatMap(row => {
          const amount = rawAmount(row.value, decimals), address = row.address?.hash?.toLowerCase();
          if (amount === null || !/^0x[0-9a-f]{40}$/.test(address || '') || seen.has(address)) return [];
          seen.add(address); listedRaw += BigInt(row.value);
          return [{ address, amount, supplyPercent: supplyPercent(row.value,info.total_supply), contract: !!row.address.is_contract, balanceCoverage: 'wallet' }];
        });
        return { chain, tokenAddress: token, rows, supply: rawAmount(info.total_supply,decimals), listedSupplyPercent: supplyPercent(String(listedRaw),info.total_supply), total: finite(info.holders_count), at: this.now(), source: 'Blockscout', historyAvailable: true, historyNote: 'Balances refresh automatically. Recent supported wallet activity loads separately; unavailable prices stay blank.', note: 'Largest indexed holders. Supply percentages use total minted supply. Contract addresses can include pools and custodians.' };
      }
      const supply = await this.rpc('getTokenSupply', [token, { commitment: 'confirmed' }]);
      const largest = await this.rpc('getTokenLargestAccounts', [token, { commitment: 'confirmed' }]);
      if (!Array.isArray(largest.value) || rawAmount(supply.value?.amount,supply.value?.decimals) === null) throw unavailable('Your Solana RPC returned incomplete holder supply data.');
      const decimals = Number(supply.value.decimals), seen = new Set();
      const accountsToRead = largest.value.slice(0,20).filter(row => {
        try { marketAddress('solana',row.address); } catch { return false; }
        if (seen.has(row.address)) return false; seen.add(row.address); return true;
      });
      const accounts = accountsToRead.length ? await this.rpc('getMultipleAccounts', [accountsToRead.map(r => r.address), { encoding: 'jsonParsed', commitment: 'confirmed' }]) : { value: [] };
      if (!Array.isArray(accounts.value) || accounts.value.length !== accountsToRead.length) throw unavailable('Your Solana RPC returned incomplete token-account data.');
      const owners = new Map(); let listedRaw = 0n;
      for (const [i, entry] of accountsToRead.entries()) {
        const account = accounts.value?.[i], info = account?.data?.parsed?.info;
        if (info?.mint !== token || rawAmount(info?.tokenAmount?.amount,decimals) === null || Number(info?.tokenAmount?.decimals) !== decimals) continue;
        let owner; try { owner = marketAddress('solana',info.owner); } catch { continue; }
        const previous = owners.get(owner) || { address: owner, amountRaw: 0n, tokenAccounts: [], contract: !PublicKey.isOnCurve(new PublicKey(owner).toBytes()), balanceCoverage: 'listed-accounts' };
        previous.amountRaw += BigInt(info.tokenAmount.amount); listedRaw += BigInt(info.tokenAmount.amount); previous.tokenAccounts.push(entry.address); owners.set(owner,previous);
      }
      const rows = [...owners.values()].sort((a,b) => a.amountRaw === b.amountRaw ? 0 : a.amountRaw > b.amountRaw ? -1 : 1).map(({ amountRaw, ...row }) => ({ ...row, tokenAccount: row.tokenAccounts[0], amount: formatUnits(amountRaw,decimals), supplyPercent: supplyPercent(String(amountRaw),supply.value.amount) }));
      return { chain, tokenAddress: token, total: null, supply: rawAmount(supply.value.amount,decimals), listedSupplyPercent: supplyPercent(String(listedRaw),supply.value.amount), at: this.now(), source: 'Your Solana RPC', rows, historyAvailable: !!this.holderHistoryKey(), historyNote: this.holderHistoryKey() ? 'Balances refresh automatically. Recent decoded swaps load separately.' : 'Balances refresh automatically. Add a Helius key in Connections → Solana for recent swap history.', note: 'Owners grouped across the largest 20 token accounts. Amounts include only those listed accounts, not every account each owner may hold. This is not a complete holder count. Percentages use total minted supply.' };
    });
  }
  async holderHistory(chain, token, wallet) {
    token = marketAddress(chain,token); wallet = marketAddress(chain,wallet);
    return this.cached(`holder-history:${chain}:${token}:${wallet}`, 60000, async () => {
      if (chain === 'solana') {
        const key = this.holderHistoryKey();
        if (!key) throw needsConnection('Add a Helius API key in Account → Connections → Solana to load recent wallet swaps.');
        const query = new URLSearchParams({ 'api-key': key, limit: '100', 'token-accounts': 'balanceChanged', commitment: 'confirmed' });
        const data = await this.json(`https://api-mainnet.helius-rpc.com/v0/addresses/${wallet}/transactions?${query}`);
        if (!Array.isArray(data)) throw unavailable('Helius could not return parsed wallet history. Check your connection and plan.');
        return { chain, tokenAddress: token, wallet, ...heliusHolderHistory(data,token,wallet,this.now()) };
      }
      if (!this.blockscoutKey) throw needsConnection('Add your Blockscout API key in Account → Connections → Market data to load wallet activity.');
      const base = 'https://api.blockscout.com/4663/api/v2', query = `apikey=${encodeURIComponent(this.blockscoutKey)}`;
      const data = await this.json(`${base}/addresses/${wallet}/token-transfers?${query}&type=ERC-20&token=${token}`);
      if (!Array.isArray(data?.items)) throw unavailable('Blockscout has not indexed this wallet’s token activity yet.');
      const transfers = data.items.slice(0,50), hashes = [...new Set(transfers.map(row => row.transaction_hash).filter(hash => /^0x[0-9a-f]{64}$/i.test(hash || '')))].slice(0,6);
      const transactions = []; let warning = '';
      for (const hash of hashes) {
        try {
          const tx = await this.cached(`holder-tx:${hash.toLowerCase()}`,300000,async () => ({ tx: await this.json(`${base}/transactions/${hash}?${query}`), at: this.now() }));
          if (tx.tx?.hash?.toLowerCase() !== hash.toLowerCase())continue;
          const row={...tx.tx};
          const decoded=Array.isArray(row.actions)&&row.actions.length>0&&row.actions.every(action=>action?.type==='swap');
          if(row.status==='ok'&&row.from?.hash?.toLowerCase()===wallet&&row.token_transfers_overflow===false&&Array.isArray(row.token_transfers)&&row.token_transfers.length){
            if(!decoded&&(!row.actions?.length)&&!['transfer','transferFrom','approve'].includes(row.method)){
              try{row.relaySwapEvidence=await this.holderSwapEvidence(row,token);}catch(error){warning=error.message;}
            }
            if(decoded||row.relaySwapEvidence){
              const assets=new Set(row.token_transfers.filter(t=>[t.from?.hash?.toLowerCase(),t.to?.hash?.toLowerCase()].includes(wallet)).map(t=>t.token?.address_hash?.toLowerCase()));
              if(String(row.value)!=='0'||assets.size===1){
                try{const trace=await this.cached(`holder-trace:${hash.toLowerCase()}`,300000,async()=>({rows:await this.explorer(`/api/v2/transactions/${hash}/raw-trace`),at:this.now()}));row.raw_trace=trace.rows;}catch(error){warning=error.message;}
              }
            }
          }
          transactions.push(row);
        } catch (error) { warning = error.message; break; }
      }
      const result = blockscoutHolderHistory(transfers,transactions,token,wallet,this.now());
      if (warning) result.coverage.note += ` Some details are temporarily unavailable: ${warning}`;
      return { chain, tokenAddress: token, wallet, ...result };
    });
  }
  async holderSwapEvidence(transaction, token) {
    const descriptors=await this.cached(`holder-pools:${token}`,60000,async()=>{
      const pools=(await this.pools('robinhood',token)).pools.slice(0,2),verified=[];
      for(const pair of pools){try{verified.push(await this.liveFeed.describeExplorer(pair,token));}catch{}}
      return {pools:verified,at:this.now()};
    });
    if(!descriptors.pools.length)return null;
    const snapshot=await this.cached(`holder-logs:${transaction.hash.toLowerCase()}`,300000,async()=>({data:await this.explorer(`/api/v2/transactions/${transaction.hash}/logs`),at:this.now()}));
    const data=snapshot.data;if(!Array.isArray(data?.items)||data.next_page_params!=null||data.items.length>100)return null;
    const events=[];
    for(const pool of descriptors.pools)for(const log of data.items){
      const event=decodeExplorerPoolSwap(log,pool,transaction,{tokenAddress:token});
      if(event)events.push({...event,quoteMint:pool.mints.find(mint=>mint!==token)});
    }
    return events.length===1?events[0]:null;
  }

}

export class AccountMarketData {
  constructor(connections, { fetcher = fetch, rpcFetcher } = {}) {
    Object.assign(this, { connections, fetcher }); this.feeds = new Map();
    this.guarded = rpcFetcher ? null : createPublicFetcher(); this.rpcFetcher = rpcFetcher || this.guarded.fetcher;
  }
  async forAccount(id) {
    const [market, solana, robinhood] = await Promise.all([this.connections.market.readSettings(id), this.connections.solana.readSettings(id), this.connections.robinhood?.readSettings(id) || { settings: {} }]);
    const rpcUrl = solana.settings.rpcUrl || (solana.settings.heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(solana.settings.heliusKey)}` : '');
    const key = createHash('sha256').update(JSON.stringify([market.revision, rpcUrl, solana.settings.heliusKey, solana.settings.rpcRequestsPerSecond, robinhood.settings.rpcUrl, robinhood.settings.rpcRequestsPerSecond])).digest('hex');
    let row = this.feeds.get(id);
    if (!row || row.key !== key) {
      const previous = row?.feed;
      const feed = new MarketData({ ...market.settings, solanaRpcUrl: rpcUrl, heliusKey: solana.settings.heliusKey || '', robinhoodRpcUrl: robinhood.settings.rpcUrl || '', rpcRequestsPerSecond: solana.settings.rpcRequestsPerSecond ?? 8, robinhoodRpcRequestsPerSecond: robinhood.settings.rpcRequestsPerSecond ?? 10, rpcGate: this.connections.solana.rpcGate, rpcScope: id, fetcher: this.fetcher, rpcFetcher: this.rpcFetcher });
      // Editing a refresh preference or another provider's key must not reset
      // an unchanged provider's quota or Retry-After deadline. Share the bucket
      // object so an in-flight response on the old feed also preserves a 429.
      const retain = host => { if (previous?.budgets.has(host)) feed.budgets.set(host, previous.budgets.get(host)); };
      if (previous?.coingeckoKey === feed.coingeckoKey && previous?.coingeckoPlan === feed.coingeckoPlan) retain(new URL(feed.coingeckoPlan === 'pro' ? CG_PRO : CG).hostname);
      if (previous?.blockscoutKey === feed.blockscoutKey) retain('api.blockscout.com');
      if (rpcUrl && previous?.solanaRpcUrl === rpcUrl) retain(new URL(rpcUrl).hostname);
      if (previous?.holderHistoryKey() === feed.holderHistoryKey()) retain('api-mainnet.helius-rpc.com');
      previous?.close();
      row = { key, feed };
    }
    this.feeds.delete(id); this.feeds.set(id, row);
    while (this.feeds.size > 1000) { const first = this.feeds.keys().next().value; this.feeds.get(first).feed.close(); this.feeds.delete(first); }
    return row.feed;
  }
  async launchTrades(id, launch, marketSnapshot = null) { return (await this.forAccount(id)).launchTrades(launch, marketSnapshot); }
  close() { for (const {feed} of this.feeds.values()) feed.close(); this.feeds.clear(); this.guarded?.close(); }
}
