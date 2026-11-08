import { PublicKey } from '@solana/web3.js';
import { freshBurnPrice } from '../public/burn-valuation.mjs';

const PRODUCTS = new Set(['creation','curve','lp','tax','meteora','damm-pump','pump-classic','agent-share']);
const amount = value => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value) ? BigInt(value) : null;
const address = value => { try { return typeof value === 'string' && new PublicKey(value).toBase58() === value; } catch { return false; } };
const stamp = (value, now) => Number.isSafeInteger(value) && value > 0 && value <= now + 5000;
const base = () => ({status:'unavailable',complete:false,historyComplete:false,pricingComplete:false,totalUsdEstimate:null,pricedUsdEstimate:null,updatedAt:null,
  coverage:{scope:'recorded-confirmed-history',sources:[],assetCount:0,pricedAssets:0,unpricedAssets:0},
  note:'Recorded protocol revenue from retained Raydium, Meteora, PumpSwap and Pump.fun launch receipts. USD values use current cached prices. Unclaimed fees, holder distributions, external contributions and buyback spending are excluded.'});

// A one-way allowlisted projection of AdminRevenue's already deduplicated
// earned-revenue rows. Neither treasury transfers nor wallet balances are added.
// Individual token identities stay private, including those of hidden launches.
export function publicRevenueAnalytics(report, { pricesByMint = new Map(), tokenPrice, now = Date.now() } = {}) {
  const result = base();
  if (!report || !stamp(report.at, now) || !Array.isArray(report.products) || report.products.length > 32) return result;
  const products = report.products.filter(row => row?.scope === 'launchpad' && PRODUCTS.has(row.id));
  if (!products.length || new Set(products.map(row=>row.id)).size !== products.length) return result;
  let historyComplete = products.every(row => row.revenueComplete === true), invalid = false;
  const assets = new Map();
  for (const product of products) {
    if (!Array.isArray(product.totals) || product.totals.length > 100000) { invalid = true; continue; }
    for (const row of product.totals) {
      const raw = amount(row?.grossAmount);
      if (row?.scope !== 'launchpad' || row.chain !== 'solana' || !address(row.mint) || !Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 18 || raw === null) { invalid = true; continue; }
      if (!raw) continue;
      const prior = assets.get(row.mint);
      if (prior && prior.decimals !== row.decimals) return result;
      assets.set(row.mint, {decimals:row.decimals,amount:(prior?.amount || 0n)+raw});
    }
  }
  if (invalid) historyComplete = false;
  let pricedUsd = 0, pricedAssets = 0;
  for (const [mint, row] of assets) {
    const quote = pricesByMint instanceof Map ? pricesByMint.get(mint) : null;
    // Quote maps are keyed by mint; an explicit conflicting identity fails.
    let reference = freshBurnPrice(quote && (!quote.mint || quote.mint === mint) ? {...quote,mint} : null, mint, now);
    if (!reference) try { reference = freshBurnPrice(tokenPrice?.(mint), mint, now); } catch {}
    if (!reference) continue;
    const estimate = Number(row.amount) / (10 ** row.decimals) * Number(reference.usd);
    if (!Number.isFinite(estimate) || estimate < 0 || !Number.isFinite(pricedUsd + estimate)) continue;
    pricedUsd += estimate; pricedAssets++;
  }
  const pricingComplete = pricedAssets === assets.size, complete = historyComplete && pricingComplete;
  const knownSubtotal = pricedAssets > 0 || assets.size === 0 && historyComplete ? pricedUsd : null;
  return {...result,status:complete?'available':assets.size||products.some(row=>Array.isArray(row.totals)&&row.totals.length)?'partial':'unavailable',complete,historyComplete,pricingComplete,
    totalUsdEstimate:complete?pricedUsd:null,pricedUsdEstimate:knownSubtotal,updatedAt:report.at,
    coverage:{scope:'recorded-confirmed-history',sources:['raydium',...(products.some(row=>row.id==='meteora')?['meteora']:[]),...(products.some(row=>row.id==='damm-pump')?['damm-pump']:[])],assetCount:assets.size,pricedAssets,unpricedAssets:assets.size-pricedAssets},
    note:result.note+(complete?' These are recorded earnings valued at current prices, not historical USD proceeds.':' The available USD figure is a subtotal; missing receipt amounts or current prices remain unavailable.')};
}

export function unavailableRevenueAnalytics() { return base(); }
