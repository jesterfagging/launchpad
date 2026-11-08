import { PublicKey } from '@solana/web3.js';
import { ExtensionType, getScaledUiAmountConfig } from '@solana/spl-token';
import { USDC_MINT, requireValue as ok } from '../public/launchpad-model.mjs';

const address = value => { try { return typeof value === 'string' && new PublicKey(value).toBase58() === value; } catch { return false; } };
const numeric = value => typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
const price = value => { const n = numeric(value); return Number.isFinite(n) && n >= 0.00000001 && n < 1e9 ? n : null; };
const positive = value => { const n = numeric(value); return Number.isFinite(n) && n > 0 ? n : null; };

function unscaledReference(mint) {
  if (mint.extensions?.includes(ExtensionType.InterestBearingConfig)) return false;
  if (!mint.extensions?.includes(ExtensionType.ScaledUiAmountConfig)) return true;
  // Several quote assets carry the extension before any split/rebase occurs.
  // Both current and scheduled multipliers must be exactly one. Checking only
  // the active value could cache an unadjusted price across a scheduled change.
  // Missing/malformed extension data still requires an exact raw-unit route.
  try {
    const config = getScaledUiAmountConfig(mint.mint);
    return config?.multiplier === 1 && config.newMultiplier === 1;
  } catch { return false; }
}

// Match by mint, never by ticker or an underlying equity's market price. The
// curve uses unscaled token units, so rebasing mints need the raw route below.
export function dexQuotePrice(rows, mint) {
  if (!Array.isArray(rows)) return null;
  const candidates = [];
  for (const row of rows) {
    if (row?.chainId !== 'solana' || !address(row.pairAddress) || !address(row.baseToken?.address) || !address(row.quoteToken?.address) || row.baseToken.address === row.quoteToken.address) continue;
    const liquidity = positive(row.liquidity?.usd), baseUsd = positive(row.priceUsd), ratio = positive(row.priceNative);
    if (liquidity === null || liquidity < 10000 || baseUsd === null) continue;
    const usd = price(row.baseToken.address === mint ? baseUsd : row.quoteToken.address === mint && ratio !== null ? baseUsd / ratio : null);
    if (usd !== null) candidates.push({ usd, liquidity });
  }
  return candidates.sort((a, b) => b.liquidity - a.liquidity)[0]?.usd ?? null;
}

async function rawQuote({ fetcher, jupiterGate, jupiterKey, now }, input, mint) {
  const signal = AbortSignal.timeout(15000), deadline = now() + 15000, config = { jupiterKey };
  const unavailable = 'This asset’s current price is unavailable. Check your Jupiter connection in Account or try again shortly.';
  const unreliable = 'This asset does not have a reliable price route right now. Try another asset.';
  // One token can round to only a few USDC micro-units, making both its price
  // and reported impact unusable. Increase only such samples, with a shared
  // deadline. All prices still use raw token units, never UI-scaled amounts.
  for (const sample of [1n, 1000n, 1000000n]) {
    signal.throwIfAborted(); ok(now() < deadline, unavailable);
    await jupiterGate.acquire(config, signal, deadline);
    signal.throwIfAborted(); ok(now() < deadline, unavailable);
    const amount = (10n ** BigInt(mint.mint.decimals) * sample).toString(), url = new URL('https://api.jup.ag/swap/v1/quote');
    url.search = new URLSearchParams({ inputMint: input.quoteMint, outputMint: USDC_MINT, amount, swapMode: 'ExactIn', slippageBps: '50' });
    const response = await fetcher(url.href, { headers: jupiterKey ? { 'x-api-key': jupiterKey } : {}, signal });
    if (response.status === 429) jupiterGate.cooldown(config, Math.max(1000, (Number(response.headers.get('retry-after')) || 1) * 1000));
    ok(response.ok, unavailable);
    const quote = await response.json();
    signal.throwIfAborted(); ok(now() < deadline, unavailable);
    ok(quote.inputMint === input.quoteMint && quote.outputMint === USDC_MINT && quote.inAmount === amount && quote.swapMode === 'ExactIn' && typeof quote.outAmount === 'string' && /^(0|[1-9]\d*)$/.test(quote.outAmount) && Number.isFinite(numeric(quote.priceImpactPct)) && Array.isArray(quote.routePlan) && quote.routePlan.length > 0, unreliable);
    if (BigInt(quote.outAmount) < 1000n) continue;
    ok(Math.abs(numeric(quote.priceImpactPct)) <= .02, unreliable);
    const usd = price(Number(quote.outAmount) / 1e6 / Number(sample)); ok(usd !== null, 'Invalid asset price.');
    return { usd: usd.toFixed(8), source: 'Live raw-token / USDC quote', at: now() };
  }
  throw Error(unreliable);
}

/** Read-only market references through the same DEX/Jupiter endpoints already
 * used for launch quotes. A missing reference remains unavailable, never zero. */
export async function readQuoteReference({ fetcher, jupiterGate, jupiterKey = '', now = Date.now }, input, mint) {
  ok(address(input.quoteMint) && Number.isSafeInteger(mint?.mint?.decimals) && mint.mint.decimals >= 0 && mint.mint.decimals <= 12, 'Invalid quote mint.');
  if (unscaledReference(mint)) {
    try {
      const response = await fetcher(`https://api.dexscreener.com/token-pairs/v1/solana/${input.quoteMint}`, { signal: AbortSignal.timeout(10000) });
      if (response.ok) {
        const usd = dexQuotePrice(await response.json(), input.quoteMint);
        if (usd !== null) return { usd: usd.toFixed(8), source: 'Live market reference', at: now() };
      }
    } catch { /* An unavailable index can still have a live routing quote. */ }
  }
  return rawQuote({ fetcher, jupiterGate, jupiterKey, now }, input, mint);
}
