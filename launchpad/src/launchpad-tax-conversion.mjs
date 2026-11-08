import { requireValue as ok } from '../public/launchpad-model.mjs';

export const TAX_CONVERSION_INTERVAL_MS = 5 * 60 * 1000;
export const TAX_CONVERSION_MAX_TOKENS = '1000000';
export const TAX_CONVERSION_BACKLOG_TOKENS = '10000000';
export const TAX_CONVERSION_BURST_POLICY = 'backlog-burst-v1';
export const TAX_CONVERSION_BACKLOG_UNITS = 10000000000000n; // Launch-base tokens, 6 decimals; never quote or wallet deposits.
export const TAX_CONVERSION_MAX_UNITS = 1000000000000n; // 0.1% of the fixed 1B supply, 6 decimals.
export const TAX_CONVERSION_MAX_IMPACT_BPS = 50;
export const TAX_CONVERSION_RESERVE_BPS = 25;
export const TAX_CONVERSION_BURST_MAX_IMPACT_BPS = 500;
export const TAX_CONVERSION_BURST_RESERVE_BPS = 250;

// Use gross input for a conservative bound: transfer/swap fees reduce the
// amount entering a constant-product pool. Default one-million clips retain
// their existing reserve/impact bounds. The explicit ten-million burst policy
// uses its own bounds; the caller requires the full burst or waits. No floating
// point token arithmetic.
export function taxConversionAmount(credit, reserveBase, {availableBase, availableQuote, quoteReserve, policy='paced-v1'} = {}) {
  ok(['paced-v1',TAX_CONVERSION_BURST_POLICY].includes(policy),'Unknown tax conversion policy.');
  const burst=policy===TAX_CONVERSION_BURST_POLICY,maximum=burst?TAX_CONVERSION_BACKLOG_UNITS:TAX_CONVERSION_MAX_UNITS;
  const maximumImpact=burst?TAX_CONVERSION_BURST_MAX_IMPACT_BPS:TAX_CONVERSION_MAX_IMPACT_BPS,reserveBps=burst?TAX_CONVERSION_BURST_RESERVE_BPS:TAX_CONVERSION_RESERVE_BPS;
  const balance=BigInt(credit),reserve=BigInt(reserveBase);
  ok(balance>=0n,'Tax conversion credit must not be negative.');
  const empty={amount:'0',priceImpactBps:0,maxPriceImpactBps:maximumImpact};
  if(!balance||reserve<=0n)return empty;
  let amount=[balance,maximum,reserve*BigInt(reserveBps)/10000n].reduce((a,b)=>a<b?a:b);
  if(availableBase!=null)amount=amount<BigInt(availableBase)?amount:BigInt(availableBase);
  if(quoteReserve!=null){
    const quote=BigInt(quoteReserve),available=availableQuote==null?quote:BigInt(availableQuote);
    if(quote<=0n||available<=0n)return empty;
    // Launchpad virtual liquidity is not withdrawable. Shrink the gross input
    // until the conservative output fits the actual quote reserve.
    if(available<quote){const cap=available*reserve/(quote-available);if(amount>cap)amount=cap;}
    if(amount<=0n||amount*quote/(reserve+amount)<=0n)return empty;
  }
  if(amount<=0n)return empty;
  const after=reserve+amount,denominator=after*after;
  const impact=((denominator-reserve*reserve)*10000n+denominator-1n)/denominator;
  ok(impact<=BigInt(maximumImpact),'Tax conversion exceeds the price-impact limit.');
  return {amount:amount.toString(),priceImpactBps:Number(impact),maxPriceImpactBps:maximumImpact};
}
