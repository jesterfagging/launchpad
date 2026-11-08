import { LAUNCH_ASSETS } from './launch-assets.mjs';

const assets = new Map(LAUNCH_ASSETS.map(asset => [asset.mint, asset]));
const placeholder = /^(?:quote(?:\s+tokens?)?|custom(?:\s+pair)?|saved\s+pair|unknown|n\/?a|token)$/i;

export function cleanQuoteSymbol(value) {
  if (typeof value !== 'string') return '';
  const symbol = value.replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 24);
  return symbol && !placeholder.test(symbol) ? symbol : '';
}

/** Display identity only: this never changes a quote mint, decimals or pricing. */
export function quoteLabel(mint, ...symbols) {
  const verified = assets.get(mint)?.symbol;
  if (verified) return verified;
  for (const value of symbols) { const symbol = cleanQuoteSymbol(value); if (symbol) return symbol; }
  return typeof mint === 'string' && mint.length > 12 ? mint.slice(0, 5) + '…' + mint.slice(-5) : 'Unidentified asset';
}

export function knownQuoteAsset(mint) { return assets.get(mint) || null; }
