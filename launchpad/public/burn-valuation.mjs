// Read-only valuation of confirmed burn quantities. This is today's mark-to-
// market value, never historical buyback spending or an executable sale quote.
export const BURN_PRICE_MAX_AGE_MS = 120000;
const mintAddress = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
function decimal(value) {
  if (typeof value === 'number') { if (!Number.isFinite(value) || value < 0) return null; value = String(value); }
  if (typeof value !== 'string' || value.length > 120) return null;
  const match = /^(0|[1-9]\d{0,79})(?:\.(\d{1,80}))?(?:e([+-]?\d{1,3}))?$/i.exec(value);
  if (!match) return null;
  const exponent = Number(match[3] || 0), scale = (match[2]?.length || 0) - exponent;
  if (Math.abs(scale) > 100 || Math.abs(exponent) > 100) return null;
  let units = BigInt(match[1] + (match[2] || ''));
  if (scale < 0) units *= 10n ** BigInt(-scale);
  return { units, scale: Math.max(0, scale) };
}
export function freshBurnPrice(price, mint, now = Date.now()) {
  if (!mintAddress(mint) || price?.mint !== mint || price.stale === true || !Number.isSafeInteger(now) || !Number.isSafeInteger(price.at) || price.at <= 0 || price.at > now + 5000 || now - price.at > BURN_PRICE_MAX_AGE_MS) return null;
  const value = decimal(price.usd);
  return value?.units > 0n ? { mint, usd: String(price.usd), at: price.at, stale: false, source: typeof price.source === 'string' ? price.source.slice(0, 80) : 'Current market' } : null;
}
export function burnTokenAmount(raw, decimals) {
  if (typeof raw !== 'string' || !/^(0|[1-9]\d{0,79})$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  if (!decimals) return raw;
  const digits = raw.padStart(decimals + 1, '0');
  return digits.slice(0, -decimals) + '.' + digits.slice(-decimals);
}
export function burnedUsdDisplay(tokens, price, { mint, now = Date.now() } = {}) {
  // A missing price remains unavailable even when the quantity is zero.
  const reference = freshBurnPrice(price, mint, now), quantity = typeof tokens === 'string' ? decimal(tokens) : null;
  if (!reference || !quantity) return '—';
  const unitPrice = decimal(reference.usd), product = quantity.units * unitPrice.units, scale = 10n ** BigInt(quantity.scale + unitPrice.scale);
  if (product > 0n && product * 100n < scale) return '<$0.01';
  const cents = (product * 100n + scale / 2n) / scale;
  return '$' + (cents / 100n).toLocaleString('en-US') + '.' + (cents % 100n).toString().padStart(2, '0');
}
export function coinBurnPrice(coin, market, now = Date.now()) {
  const mint = coin?.mint;
  if (!mintAddress(mint) || market?.coin?.mint !== mint || market.stale === true) return null;
  const native = market.native, pool = market.pool;
  const nativeCurrent = native?.mint === mint && native.curve === coin.curve && native.quote?.mint === coin.quote?.mint && native.status === 'curve';
  if (nativeCurrent && native.stale !== true && freshBurnPrice({ ...native.quote, mint: native.quote.mint }, coin.quote.mint, now)) {
    const value = freshBurnPrice({ mint, usd: native.priceUsd, at: Math.min(native.at, native.quote.at), stale: native.stale, source: 'Current launch curve' }, mint, now);
    if (value) return value;
  }
  // API pool.priceUsd is already oriented to pool.token; verify that identity
  // and isBase agree before using it, including tokens on the quote side.
  if (pool?.chain === 'solana' && mintAddress(pool.address) && pool.token === mint && pool.base?.address !== pool.quote?.address && [pool.base?.address, pool.quote?.address].includes(mint) && pool.isBase === (pool.base.address === mint)) {
    const value = freshBurnPrice({ mint, usd: pool.priceUsd, at: pool.at, stale: pool.stale, source: 'Current pool price' }, mint, now);
    if (value) return value;
  }
  const nativeSource = ['Raydium onchain', 'Meteora onchain', 'Launchpad onchain'].includes(coin.marketSource);
  if (nativeSource) return null; // Historical curve prices never value graduated burns.
  return freshBurnPrice({ mint, usd: coin.priceUsd, at: coin.marketAt, stale: coin.stale, source: coin.marketSource }, mint, now);
}
