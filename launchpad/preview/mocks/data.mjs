// Realistic preview catalogue. Shapes follow src/launchpad-explore.mjs
// (discoveryRecord/pumpDiscoveryRecord/meteoraDiscoveryRecord/dammPumpDiscoveryRecord
// and LaunchpadExplore.coin()). Timestamps are recomputed per request so prices
// and the $LAUNCHPAD badge are always "fresh" for the frontend's staleness checks.
import { LAUNCH_ASSETS, hookRuleById, describeHookRule, HOOK_ROUTES } from '../src-public.mjs';
import { address, signature, hex64, rng } from './util.mjs';

export const LAUNCHPAD_MINT = '7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc';
export const SOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const assets = new Map(LAUNCH_ASSETS.map(a => [a.mint, a]));
export const QUOTE_USD = { [SOL]: 152.37, [USDC]: 1, Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh: 181.22, XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB: 247.5, JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 0.8231, XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W: 571.3, Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw: 214.0 };
const QUOTE_DECIMALS = { [SOL]: 9, [USDC]: 6 };
export function quote(mint) {
  const a = assets.get(mint) || { symbol: 'TOKEN', name: 'Custom pair', category: 'other' };
  return { mint, symbol: a.symbol, name: a.name, category: a.category === 'crypto' || a.category === 'stocks' || a.category === 'preipo' ? a.category : 'other', decimals: QUOTE_DECIMALS[mint] ?? a.decimals ?? 8 };
}
export const image = seed => '/token-images/' + hex64('img:' + seed) + '.png';

export const USERS = [
  { username: 'launchpad', bio: 'The official Launchpad account. Protocol buybacks and burns.', avatar: null, id: 'u'.repeat(32) },
  { username: 'mira_builds', bio: 'Shipping tiny internet experiments. Otter enthusiast.', seed: 'mira' },
  { username: 'saltwater', bio: 'Long walks on the order book.', seed: 'salt' },
  { username: 'kenji', bio: 'Market structure nerd · Tokyo', seed: 'kenji' },
  { username: 'pixelpilot', bio: 'Pixel art, small caps and quiet harbors.', seed: 'pixel' },
  { username: 'otterdao', bio: 'Community-run. Holder rewards forever.', seed: 'otter' },
  { username: 'lumen_labs', bio: 'Research collective building onchain indexes.', seed: 'lumen' },
].map((u, i) => ({ ...u, id: u.id || hex64('acct:' + u.username).slice(0, 32), avatar: u.seed ? image('avatar:' + u.seed) : null, mainWallet: address('wallet:' + u.username), createdAt: Date.UTC(2026, 8, 24 + (i % 5), 9 + i) }));
const userByName = new Map(USERS.map(u => [u.username, u]));
const creator = name => { const u = userByName.get(name); return { username: u.username, bio: u.bio, avatar: u.avatar }; };

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
// stage: 'new' (on curve) | 'graduated'. moving: null|'progress'|'volume'|'both'.
const SPECS = [
  { mint: LAUNCHPAD_MINT, name: 'Launchpad', symbol: 'LAUNCHPAD', platform: 'raydium', quote: SOL, stage: 'graduated', feeMode: 'buyback', taxBps: 300, fdv: 378_000, cap: 378_000, vol: 61_200, age: 7 * DAY, creator: 'launchpad', change: 6.4, desc: 'The Launchpad protocol token. 50% of recognized net SOL revenue buys back and burns $LAUNCHPAD.', links: { website: 'https://launchpad.example', twitter: 'https://x.com/example' } },
  { name: 'Moonbeam Otter', symbol: 'OTTER', platform: 'raydium', quote: SOL, stage: 'new', feeMode: 'creator', progress: 72.4, fdv: 41_300, vol: 38_900, age: 5 * HOUR, creator: 'mira_builds', moving: 'progress', desc: 'An otter who only swims at night. Creator fees fund more otter art.', links: { website: 'https://otter.example', twitter: 'https://x.com/moonbeamotter', telegram: 'https://t.me/moonbeamotter' } },
  { name: 'Quiet Harbor', symbol: 'HARBR', platform: 'meteora', quote: USDC, stage: 'new', feeMode: 'holders', progress: 48.1, fdv: 33_600, vol: 12_450, age: 26 * HOUR, creator: 'pixelpilot', desc: 'A calm place to park. Trading fees are paid out to holders in USDC every hour.' },
  { name: 'Neon Koi', symbol: 'KOI', platform: 'damm-pump', quote: SOL, stage: 'new', feeMode: 'none', progress: 88.2, fdv: 46_800, vol: 61_200, age: 3 * HOUR, creator: 'kenji', moving: 'both', desc: 'Bright fish, fast pond. Graduates to PumpSwap with all LP burned.' },
  { name: 'Gridlock', symbol: 'GRID', platform: 'raydium', quote: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', stage: 'graduated', feeMode: 'creator', fdv: 1_340_000, cap: 1_290_000, vol: 212_000, age: 4 * DAY, creator: 'lumen_labs', change: -3.2, desc: 'A coin paired with NVDAx. For people who stare at heat maps.' },
  { name: 'Paper Lantern', symbol: 'LNTRN', platform: 'raydium', quote: SOL, stage: 'new', feeMode: 'holders', taxBps: 200, progress: 38.6, fdv: 29_900, vol: 22_400, age: 9 * HOUR, creator: 'otterdao', moving: 'volume', desc: 'Lanterns for every holder. 2% transfer tax converts into SOL rewards.' },
  { name: 'Payday Pigeon', symbol: 'PAYDAY', platform: 'raydium', quote: SOL, stage: 'new', feeMode: 'paycheck', taxBps: 0, progress: 54.2, fdv: 35_100, vol: 44_800, age: 6 * HOUR, creator: 'mira_builds', moving: 'volume', desc: 'A pigeon that delivers every 15 minutes. The creator fee is paid out to holders, a $LAUNCHPAD burn, Launchpad and the creator.', links: { twitter: 'https://x.com/paydaypigeon' } },
  { name: 'Saltwater Saga', symbol: 'SALT', platform: 'meteora', quote: SOL, stage: 'graduated', feeMode: 'gotchi', gotchi: 'pumpgotchi', fdv: 612_000, cap: 598_000, vol: 74_300, age: 3 * DAY, creator: 'saltwater', change: 12.8, desc: 'A seafaring saga told one block at a time.' },
  { name: 'Tiny Tractor', symbol: 'TRCTR', platform: 'damm-pump', quote: USDC, stage: 'new', feeMode: 'none', progress: 12.3, fdv: 21_700, vol: 1_840, age: 47 * MIN, creator: 'mira_builds', desc: 'Small farm, big harvest.' },
  { name: 'Velvet Comet', symbol: 'VELV', platform: 'raydium', quote: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', stage: 'new', feeMode: 'creator', progress: 5.4, fdv: 20_540, vol: 640, age: 18 * MIN, creator: 'kenji', desc: 'Paired with TSLAx. A soft streak across the sky.' },
  { name: 'Orbit Garden', symbol: 'ORBIT', platform: 'pump-classic', quote: SOL, stage: 'new', feeMode: 'market_maker', progress: 33.0, fdv: 9_800, vol: 5_200, age: 2 * HOUR, creator: 'mira_builds', desc: 'A market-made garden that launched on Pump.fun.' },
  { name: 'Orbital Bakery', symbol: 'BAKE', platform: 'pumpswap', quote: SOL, stage: 'new', feeMode: 'creator', progress: 61.0, fdv: 37_100, vol: 15_900, age: 14 * HOUR, creator: 'pixelpilot', desc: 'Croissants in low earth orbit.' },
  { name: 'Fjord Fox', symbol: 'FJORD', platform: 'raydium', quote: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', stage: 'new', feeMode: 'creator', progress: 27.5, fdv: 26_100, vol: 9_800, age: 2 * DAY, creator: 'saltwater', moving: 'volume', desc: 'A fox that lives where the mountains meet the sea.' },
  { name: 'Ember Index', symbol: 'EMBR', platform: 'meteora', quote: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', stage: 'graduated', feeMode: 'holders', fdv: 2_120_000, cap: 2_060_000, vol: 188_000, age: 5 * DAY, creator: 'lumen_labs', change: 2.1, desc: 'Holder rewards paid in SPYx. A slow-burning index of embers.' },
  { name: 'Cobalt Crow', symbol: 'CROW', platform: 'raydium', quote: USDC, stage: 'new', feeMode: 'buyback', progress: 3.1, fdv: 20_310, vol: 420, age: 6 * MIN, creator: 'otterdao', desc: 'Agent buyback coin. Creator fees buy back and burn CROW.' },
  { name: 'Marble Moth', symbol: 'MOTH', platform: 'meteora', quote: SOL, stage: 'new', feeMode: 'creator', progress: 9.7, fdv: 22_050, vol: 2_210, age: 34 * MIN, creator: 'pixelpilot', desc: 'Drawn to every green candle.' },
  { name: 'Sunday Static', symbol: 'STATIC', platform: 'damm-pump', quote: SOL, stage: 'new', feeMode: 'none', progress: 41.2, fdv: 31_400, vol: 18_700, age: 7 * HOUR, creator: 'kenji', desc: 'Lo-fi radio for the timeline.' },
  { name: 'Granite Goat', symbol: 'GOAT', platform: 'raydium', quote: SOL, stage: 'new', feeMode: 'gotchi', gotchi: 'fomogotchi', taxBps: 100, progress: 54.9, fdv: 35_200, vol: 27_300, age: 20 * HOUR, creator: 'saltwater', moving: 'progress', desc: 'Climbs anything. 1% transfer tax funds SOL rewards for holders.' },
  { name: 'Lemon Ledger', symbol: 'LEMON', platform: 'raydium', quote: USDC, stage: 'graduated', feeMode: 'gotchi', gotchi: 'fomogotchi', taxBps: 100, fdv: 288_000, cap: 281_000, vol: 31_200, age: 6 * DAY, creator: 'mira_builds', change: -8.9, desc: 'Bookkeeping, but zesty.' },
  { name: 'Scout Signal', symbol: 'SCOUT', platform: 'raydium', quote: SOL, stage: 'new', feeMode: 'agent', agent: true, progress: 66.3, fdv: 39_800, vol: 44_100, age: 6 * DAY, creator: 'mira_builds', moving: 'volume', desc: 'An AI agent coin. SCOUT reads approved sites, posts honest updates and runs a capped buyback-and-burn from its 70% treasury share.', links: { website: 'https://scout.example', twitter: 'https://x.com/scoutsignal' } },
  { name: 'Night Owl Notes', symbol: 'OWL', platform: 'raydium', quote: SOL, stage: 'new', feeMode: 'agent', agent: true, progress: 41.0, fdv: 31_200, vol: 18_900, age: 3 * DAY + 5 * HOUR, creator: 'kenji', desc: 'An AI agent coin that writes an evening digest of Solana network news and rewards long-term holders weekly.' },
  { name: 'Tidewriter', symbol: 'TIDE', platform: 'meteora', quote: SOL, stage: 'new', feeMode: 'agent', agent: true, progress: 14.2, fdv: 23_900, vol: 3_400, age: 2 * DAY + 3 * HOUR, creator: 'pixelpilot', desc: 'A Meteora agent coin that explains dynamic fees to newcomers. Research and browsing only; no financial capabilities.' },
  // v71.28: hooked Meteora coins (transfer hook rules v2). LAMP trades anywhere (caps and trading hours); ROPE is a Launchpad-route coin
  // (allowlist, gate token, vesting); TOLL carries a sealed blocklist, sliding caps and a tithe (Launchpad route because of the tithe).
  { name: 'Lantern Market', symbol: 'LAMP', platform: 'meteora', quote: SOL, stage: 'new', feeMode: 'creator', progress: 31.5, fdv: 27_400, vol: 8_900, age: 5 * HOUR + 20 * MIN, creator: 'mira_builds', desc: 'A night market with house rules: no wallet above 2% of supply, small sells only, and trading on weekdays 09:00–17:00 Berlin time.', hook: [['max_per_wallet', { maxPct: 2 }], ['anti_dump', { maxBuyPct: 2, maxSellPct: 0.25 }], ['trading_hours', { openMinute: 540, closeMinute: 1020, weekdays: 31, tzOffset: 60, dst: 2 }]] },
  { name: 'Velvet Rope', symbol: 'ROPE', platform: 'meteora', quote: SOL, stage: 'new', feeMode: 'creator', progress: 12.8, fdv: 22_900, vol: 3_100, age: 2 * DAY + 4 * HOUR, creator: 'mira_builds', desc: 'Members only. Wallets must be on the creator’s allowlist and hold 1,000 $LAUNCHPAD; bought tokens unlock 10% a day after a one-day cliff.', hook: [['allowlist', {}], ['holder_gated', { minAmount: 1000 }], ['holder_vesting', { cliffHours: 24, unlockPct: 10, periodHours: 24 }]], gateMint: LAUNCHPAD_MINT },
  { name: 'Toll Road', symbol: 'TOLL', platform: 'meteora', quote: SOL, stage: 'new', feeMode: 'holders', progress: 44.1, fdv: 31_900, vol: 12_600, age: 18 * HOUR, creator: 'mira_builds', desc: 'Every trade pays a 0.005 SOL toll to the road fund, 44 known bot wallets are blocked for good, and per-trade caps widen as the curve fills.', hook: [['blocklist', {}], ['sliding_caps', { levels: 3 }], ['tithe', { donationSol: 0.005 }]], blocklistCount: 44, titheRecipient: address('tithe:road-fund') },
  { name: 'Anthropic Arcade', symbol: 'ARCADE', platform: 'raydium', quote: 'Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw', stage: 'new', feeMode: 'creator', progress: 19.8, fdv: 24_400, vol: 3_100, age: 31 * HOUR, creator: 'lumen_labs', desc: 'Paired with a pre-IPO token. Coin-op cabinets, onchain.' },
];

function build(spec, i) {
  const mint = spec.mint || address('mint:' + spec.symbol), q = quote(spec.quote), now = Date.now();
  const curve = spec.platform === 'damm-pump' ? address('damm:' + spec.symbol) : address('curve:' + spec.symbol);
  const createdAt = Math.floor((now - spec.age) / 1000) * 1000, usd = QUOTE_USD[spec.quote] ?? 1, supply = 1e9;
  const graduated = spec.stage === 'graduated', price = spec.fdv / supply;
  const base = { mint, name: spec.name, symbol: spec.symbol, description: spec.desc || '', image: mint === LAUNCHPAD_MINT ? null : image('coin:' + spec.symbol), createdAt, chain: 'solana', platform: spec.platform, launchMode: spec.platform,
    quote: q, feeMode: spec.feeMode, gotchi: spec.gotchi ? { id: spec.gotchi, theme: spec.gotchi, href: '/gotchi?id=' + spec.gotchi } : null, agent: spec.agent ? { id: hex64('agent:' + spec.symbol).slice(0, 24), wallet: address('agent-wallet:' + spec.symbol), model: spec.platform === 'meteora' ? 'google/gemini-3.8-flash' : 'openai/gpt-6-luna', capabilities: spec.platform === 'meteora' ? 3 : 15, href: '/coin?mint=' + mint + '#agent' } : null, creatorFeeBps: spec.platform === 'damm-pump' ? 0 : spec.platform === 'pumpswap' ? 50 : spec.feeMode === 'holders' && spec.taxBps ? 0 : 50, creatorFeePolicy: spec.platform === 'raydium' ? 'flat-0.5-v2' : null, postGradCreatorFeeBps: spec.platform === 'raydium' ? 25 : 0, taxBps: spec.taxBps || 0,
    links: spec.links || {}, curve, href: '/coin?mint=' + mint, explorerUrl: 'https://solscan.io/token/' + mint, creator: creator(spec.creator) };
  if (spec.platform === 'pumpswap') Object.assign(base, { poolId: null, custodyAuthority: address('custody:' + spec.symbol), graduationFeeBps: 2885, tradeFeeBps: 100, totalTradeFeeBps: 150 });
  if (spec.platform === 'meteora') Object.assign(base, { poolId: graduated ? address('pool:' + spec.symbol) : null, baseDecimals: 6, totalTradeFeeBps: 188, graduationFeeBps: 0 });
  // Public rows of hooked coins carry `hook` (src/meteora-service.mjs hookView, v2): the rules with their enforced sentences, the route
  // ('any' | 'curve'), the gate mint, the tithe recipient, the blocklist size and whether the rules still run. No supply fields: the
  // mint authority is revoked at creation like every Launchpad coin.
  if (spec.hook) { const route = spec.hook.some(([id]) => hookRuleById(id).route === 'curve') ? 'curve' : 'any'; base.hook = { version: 2, rules: spec.hook.map(([id, settings]) => ({ id, name: hookRuleById(id).name, text: describeHookRule(id, settings) })), route, routeName: HOOK_ROUTES[route].name, routeText: HOOK_ROUTES[route].text, gateMint: spec.gateMint || null, titheRecipient: spec.titheRecipient || null, blocklistCount: spec.hook.some(([id]) => id === 'blocklist') ? spec.blocklistCount || 0 : 0, active: !graduated, ended: graduated, program: address('program:curve-hook') }; }
  if (spec.platform === 'damm-pump') Object.assign(base, { dammPoolId: curve, poolId: null, baseDecimals: 6, graduationFeeBps: 0, tradeFeeBps: 125, totalTradeFeeBps: 125 });
  const r = rng('trades:' + spec.symbol), buys = Math.round(spec.vol / (graduated ? 240 : 90) * (0.7 + r() * 0.3)) + 3, sells = Math.round(buys * (0.35 + r() * 0.3));
  const volQuote = spec.vol / usd;
  return { ...base,
    trackedAthFdvUsd: Math.round(spec.fdv * (graduated ? 1.42 : 1.08)), trackedAthMarketCapUsd: graduated ? Math.round(spec.cap * 1.42) : null, athTrackedSince: createdAt + 60_000, athComplete: false,
    stage: graduated ? 'graduated' : 'new', curveStatus: graduated ? 'migrated' : 'curve', movingReason: spec.moving || null, volumeAcceleration: spec.moving === 'volume' || spec.moving === 'both' ? 2.6 : null,
    lastBuyAt: now - (i * 97_000 + 40_000) % (45 * MIN),
    marketCapUsd: graduated ? spec.cap : null, fdvUsd: spec.fdv, priceUsd: price, priceQuote: graduated ? null : price / usd, fdvQuote: graduated ? null : spec.fdv / usd, supply,
    volume24h: spec.vol, volume24hQuote: graduated ? null : volQuote, volumeObserved: null, volumeObservedQuote: null, volumeUsdEstimate: !graduated, volumeSource: graduated ? 'DEX Screener' : spec.platform === 'meteora' ? 'Meteora recorded trades' : ['pumpswap', 'damm-pump'].includes(spec.platform) ? 'Launchpad trade history' : 'Raydium trade history',
    volumeAt: now - 12_000, volumeComplete: true, buys24h: buys, sells24h: sells,
    liquidityUsd: graduated ? Math.round(spec.cap * 0.11) : null, priceChange24h: graduated ? spec.change ?? 0 : null, progressPercent: graduated ? 100 : spec.progress,
    marketAt: now - 8_000, marketSource: graduated ? 'DEX Screener' : spec.platform === 'meteora' ? 'Meteora onchain' : ['pumpswap', 'damm-pump'].includes(spec.platform) ? 'Launchpad onchain' : 'Raydium onchain', stale: false, stageStale: false,
    _spec: spec };
}

export function coins() { return SPECS.map(build); }
export function coinByMint(mint) { return coins().find(c => c.mint === mint) || null; }
export const publicCoin = coin => { const { _spec, ...rest } = coin; return rest; };

export function creatorEarnings(coin) {
  if (coin.feeMode !== 'creator') return undefined;
  const d = coin.quote.decimals, scale = 10 ** Math.min(d, 9), earned = Math.round(coin.volume24h / (QUOTE_USD[coin.quote.mint] || 1) * 0.005 * 3.2 * scale);
  return { scope: 'coin', status: 'available', quote: { mint: coin.quote.mint, symbol: coin.quote.symbol, decimals: Math.min(d, 9) }, earnedRaw: String(earned), paidRaw: String(Math.round(earned * 0.82)), pendingRaw: String(earned - Math.round(earned * 0.82)), recipient: USERS.find(u => u.username === coin.creator.username).mainWallet, note: 'Recorded from confirmed Launchpad fee claims and payouts. Fees still accruing onchain appear after the next collection.', at: Date.now() - 4 * MIN };
}

// ------------------------------------------------------------------ markets
export function candles(coin, count = 240) {
  const r = rng('candles:' + coin.symbol), usd = QUOTE_USD[coin.quote.mint] ?? 1, end = coin.fdvUsd / 1e9 / usd, nowSec = Math.floor(Date.now() / 60000) * 60;
  const startPrice = end * (0.35 + r() * 0.3); const rows = []; let price = startPrice;
  for (let i = 0; i < count; i++) {
    const t = nowSec - (count - 1 - i) * 60, drift = (Math.log(end) - Math.log(price)) / Math.max(1, count - i) * 1.1, shock = (r() - 0.48) * 0.06;
    const open = price, close = Math.max(startPrice * 0.3, open * Math.exp(drift + shock)), high = Math.max(open, close) * (1 + r() * 0.025), low = Math.min(open, close) * (1 - r() * 0.025);
    rows.push({ time: t, open, high, low, close, volume: +(coin.volume24h / usd / 1440 * (0.3 + r() * 2.4)).toFixed(4) }); price = close;
  }
  rows.at(-1).close = end; rows.at(-1).high = Math.max(rows.at(-1).high, end); rows.at(-1).low = Math.min(rows.at(-1).low, end);
  return rows;
}
export function trades(coin, max = 40) {
  // Tape size and spacing follow the coin's 24h activity so small coins look small.
  const r = rng('tape:' + coin.symbol), usd = QUOTE_USD[coin.quote.mint] ?? 1, price = coin.fdvUsd / 1e9 / usd, nowSec = Math.floor(Date.now() / 1000), rows = [];
  const count = Math.min(max, (coin.buys24h || 0) + (coin.sells24h || 0)) || 6, avgUsd = coin.volume24h / Math.max(1, (coin.buys24h || 0) + (coin.sells24h || 0)), gap = Math.min(4 * 3600, 86400 / Math.max(1, (coin.buys24h || 0) + (coin.sells24h || 0)));
  let t = nowSec - 20;
  for (let i = 0; i < count; i++) {
    const side = r() < 0.62 ? 'buy' : 'sell', quoteAmount = +(avgUsd * (0.15 + r() * r() * 3) / usd).toFixed(usd > 50 ? 4 : 2), p = price * (1 + (r() - 0.5) * 0.04);
    rows.push({ time: t, side, quote: quoteAmount, amount: Math.round(quoteAmount / p), wallet: address('trader:' + coin.symbol + ':' + Math.floor(r() * 18)), signature: signature('tx:' + coin.symbol + ':' + i) });
    t -= Math.round(gap * (0.2 + r() * 1.6));
  }
  return rows;
}
export function holders(coin) {
  const r = rng('holders:' + coin.symbol), rows = []; let left = 100;
  const lp = coin.stage === 'graduated' ? 'pool' : 'curve', lpShare = coin.stage === 'graduated' ? 18.4 : 100 - (coin.progressPercent || 0) * 0.62;
  rows.push({ wallet: address('lp:' + coin.symbol), tokenAccount: address('lpacct:' + coin.symbol), amount: String(Math.round(lpShare * 1e7)), percent: +lpShare.toFixed(4), isLp: true, lpType: lp });
  left -= lpShare;
  for (let i = 0; i < 19; i++) { const pct = +(left * (0.08 + r() * 0.16)).toFixed(4); left -= pct; rows.push({ wallet: address('holder:' + coin.symbol + i), tokenAccount: address('hacct:' + coin.symbol + i), amount: (pct * 1e7).toFixed(6), percent: pct, isLp: false, lpType: null }); }
  return rows.sort((a, b) => b.percent - a.percent);
}
export function nativeSnapshot(coin) {
  const now = Date.now(), usd = QUOTE_USD[coin.quote.mint] ?? 1, graduated = coin.stage === 'graduated', c = candles(coin);
  const raisedTarget = { [SOL]: 85, [USDC]: 12_900 }[coin.quote.mint] ?? +(12_900 / usd).toFixed(4);
  return { mint: coin.mint, curve: coin.curve, status: graduated ? 'migrated' : 'curve', at: now - 6_000, slot: 391_204_000 + Math.floor(now / 400 % 100000), source: coin.marketSource === 'DEX Screener' ? 'Raydium onchain' : coin.marketSource,
    priceQuote: graduated ? null : coin.priceQuote, fdvQuote: graduated ? null : coin.fdvQuote, supply: 1e9, raisedQuote: +(raisedTarget * (coin.progressPercent || 0) / 100).toFixed(4), targetQuote: raisedTarget, progressPercent: coin.progressPercent,
    quote: { mint: coin.quote.mint, symbol: coin.quote.symbol, usd, at: now - 6_000, source: 'Live market reference', stale: false },
    priceUsd: graduated ? null : coin.priceUsd, fdvUsd: graduated ? null : coin.fdvUsd, stale: false, refreshMs: 30_000, warning: graduated ? 'This token has graduated to its AMM market.' : '', historySource: 'Launchpad observations',
    points: c.slice(-30).map((row, i) => ({ time: row.time, priceQuote: row.close, slot: 391_200_000 + i * 150 })), candles: c, historyAt: now - 30_000, historyStale: false, trades: trades(coin), tradesStale: false,
    candleSource: coin.platform === 'meteora' || coin.platform === 'damm-pump' ? 'Meteora history' : coin.platform === 'pumpswap' ? 'Launchpad history' : 'Raydium history' };
}
export function pool(coin) {
  if (coin.stage !== 'graduated') return null;
  const addr = address('pool:' + coin.symbol), now = Date.now();
  return { chain: 'solana', address: addr, token: coin.mint, name: coin.name, symbol: coin.symbol, isBase: true, dex: coin.platform === 'meteora' ? 'meteora' : 'raydium', pair: coin.symbol + ' / ' + coin.quote.symbol, priceUsd: coin.priceUsd, marketCapUsd: coin.marketCapUsd, fdvUsd: coin.fdvUsd, liquidityUsd: coin.liquidityUsd, volume24h: coin.volume24h,
    priceChange: { m5: 0.4, h1: 1.8, h6: -2.2, h24: coin.priceChange24h }, txns: { m5: { buys: 4, sells: 2 }, h1: { buys: 38, sells: 21 }, h6: { buys: 190, sells: 122 }, h24: { buys: coin.buys24h, sells: coin.sells24h } }, volume: { m5: 1200, h1: 14_800, h6: 81_000, h24: coin.volume24h },
    url: 'https://dexscreener.com/solana/' + addr, chart: 'https://dexscreener.com/solana/' + addr + '?embed=1&theme=dark&info=0&trades=0', base: { address: coin.mint, symbol: coin.symbol }, quote: { address: coin.quote.mint, symbol: coin.quote.symbol }, stale: false, at: now - 20_000 };
}
export function rewards(coin) {
  const now = Date.now(), q = { mint: coin.quote.mint, symbol: coin.quote.symbol, decimals: coin.quote.decimals };
  if (['pumpswap', 'damm-pump'].includes(coin.platform)) return { mint: coin.mint, mode: 'none', holder: null, buyback: null, refreshMs: 30000 };
  if (coin.feeMode === 'creator') return { mint: coin.mint, mode: 'creator', holder: null, buyback: null, refreshMs: 30000 };
  if (coin.feeMode === 'agent') return { mint: coin.mint, mode: 'agent', agent: coin.agent, quote: q, taxBps: 0, enabled: true, status: 'ready', holder: null, buyback: null, refreshMs: 30000 };
  if (coin.feeMode === 'gotchi') return { mint: coin.mint, mode: 'gotchi', gotchi: { ...coin.gotchi, ...(coin.platform === 'meteora' ? { vault: address('vault:' + coin.gotchi.id), contributedRaw: '12410000000', pendingRaw: '310000000', quoteDecimals: 9, quoteSymbol: 'SOL', feePreset: 'gotchi-1pct-v1' } : {}) }, quote: q, taxBps: coin.taxBps, enabled: true, status: 'ready', holder: null, buyback: null, refreshMs: 30000 };
  const base = { mint: coin.mint, mode: coin.feeMode, enabled: true, status: 'enabled', quote: q, tokenSymbol: coin.symbol, taxBps: coin.taxBps, asOf: now, refreshMs: 30000, stale: false, error: '' };
  if (coin.feeMode === 'paycheck') return { ...base, wallets: { creatorAddress: address('wallet:' + coin.symbol), rewardsAddress: address('rewards:' + coin.symbol), status: 'active' }, activityUrl: 'https://solscan.io/account/' + address('rewards:' + coin.symbol), holder: { distributedQuote: '9.1842', payments: 412, lastDistributionAt: now - 7 * MIN, lastDistributionQuote: '0.0412', pendingQuote: '0.6218', unconvertedTaxTokens: '0', withheldTokens: '0', unclaimedCreatorQuote: '0.0031', unclaimedScope: 'curve', intervalMinutes: 15, minimumUsd: 1, minimumQuote: '0.0061', nextCheckAt: now + 8 * MIN, historyComplete: true, historyNote: 'Confirmed quote amounts sent to holders since this launch.' },
    paycheck: { policy: 'paycheck-v1', intervalMinutes: 15, thresholdUsd: 0.5, claimMinimumUsd: 1, split: { holders: 5000, burn: 3500, curve: 1000, creator: 500 }, claimed: '14.2104', paidToHolders: '6.4133', paidToCreator: '0.6902', paidToProtocol: '6.3947', allocatedToHolders: '7.1052', allocatedToBurn: '4.97364', allocatedToCurve: '1.42104', allocatedToCreator: '0.71052', forfeited: '0.3121', accruing: '0.6218', accruingWallets: 184, pendingCreator: '0.0203', pendingProtocol: '0', carry: '0.000000004', cycles: 23, lastAllocationAt: now - 7 * MIN, lastSnapshotWallets: 211, asOf: now }, buyback: null };
  if (coin.feeMode === 'holders') return { ...base, holder: { distributedQuote: coin.quote.symbol === 'SOL' ? '18.4127' : '2841.33', payments: 37, lastDistributionAt: now - 42 * MIN, lastDistributionQuote: coin.quote.symbol === 'SOL' ? '0.6112' : '96.2', pendingQuote: coin.quote.symbol === 'SOL' ? '0.2841' : '41.7', unconvertedTaxTokens: '182400', withheldTokens: '9120', unclaimedCreatorQuote: '0.12', unclaimedScope: 'curve', intervalMinutes: 60, minimumQuote: '1', nextCheckAt: now + 18 * MIN }, buyback: null };
  return { ...base, holder: null, buyback: { totalQuoteSpent: coin.quote.symbol === 'SOL' ? '412.75' : '8251.5', tokensBought: '38120400', tokensBurned: '36400000', completedBuys: 214, completedBurns: 207, pendingOperations: 1, pendingQuote: '1.25', pendingBurnTokens: '1720400', totalClaimedQuote: '430.1', totalClaimedTokens: '0', unclaimedCreatorQuote: '2.4', unclaimedScope: 'curve', lastBuybackAt: now - 3 * MIN, buybackPercent: 100, intervalMinutes: 1, historyComplete: true, historyNote: '' } };
}

/** The creator's allowlist for an allowlisted coin (the preview keeps three sample wallets). */
export function hookAllowlist(coin) { if (!coin?.hook?.rules?.some(rule => rule.id === 'allowlist')) return []; return [0, 1, 2].map(i => address('allow:' + coin.symbol + ':' + i)); }
/** The sealed blocklist of a blocklisted coin: `blocklistCount` deterministic wallets. */
export function hookBlocklist(coin) { if (!coin?.hook?.rules?.some(rule => rule.id === 'blocklist')) return []; return Array.from({ length: coin.hook.blocklistCount || 0 }, (_, i) => address('block:' + coin.symbol + ':' + i)); }
