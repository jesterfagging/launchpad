const intervals = { '1m': '1', '5m': '5', '15m': '15', '1h': '60' };
const windows = [['m5', '5m'], ['h1', '1h'], ['h6', '6h'], ['h24', '24h']];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const money = value => finite(value) ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumSignificantDigits: 6 }).format(value) : '—';
const count = value => finite(value) && value >= 0 ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value) : '—';

// Construct every frame/link locally. Provider URLs are never iframe sources.
export function dexScreenerUrl(chain, address, { interval = '1m', trades = false, embed = false } = {}) {
  if (typeof address !== 'string' || !Object.hasOwn(intervals, interval)) return null;
  const valid = chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
    : chain === 'robinhood' && /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(address);
  if (!valid) return null;
  const url = new URL(`https://dexscreener.com/${chain}/${address}`);
  if (embed) {
    for (const [key, value] of Object.entries({ embed: '1', theme: 'dark', info: '0', trades: trades ? '1' : '0', chartTheme: 'dark', chartDefaultOnMobile: '1', interval: intervals[interval] })) url.searchParams.set(key, value);
  }
  return url.href;
}

export function marketMetricRows(pool) {
  return [
    { label: 'Token price', value: money(pool.priceUsd) },
    { label: 'Pool liquidity', value: money(pool.liquidityUsd) },
    { label: '24h volume', value: money(pool.volume?.h24 ?? pool.volume24h) },
    { label: 'Market cap', value: money(pool.isBase ? pool.marketCapUsd : null) },
    { label: 'FDV', value: money(pool.isBase ? pool.fdvUsd : null) }
  ];
}

export function marketChangeRows(pool) {
  return windows.map(([key, label]) => {
    const change = pool.isBase ? pool.priceChange?.[key] : null;
    return { label, value: finite(change) ? `${change > 0 ? '+' : ''}${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(change)}%` : '—', tone: finite(change) && change !== 0 ? change > 0 ? 'positive' : 'negative' : '' };
  });
}

export function marketSwapRows(pool) {
  return windows.map(([key, label]) => ({ label, buys: count(pool.txns?.[key]?.buys), sells: count(pool.txns?.[key]?.sells), volume: money(pool.volume?.[key] ?? (key === 'h24' ? pool.volume24h : null)) }));
}
