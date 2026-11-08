import { PublicKey } from '@solana/web3.js';
import { LAUNCH_ASSETS } from '../public/launch-assets.mjs';
import { createPublicFetcher } from './telegram-network.mjs';

const text = (s, limit = 100) => typeof s === 'string' ? s.trim().slice(0, limit) : '';
const verifiedAssets = new Map(LAUNCH_ASSETS.map(asset => [asset.mint,asset]));
const SUNRISE_TOKENS = 'https://sunrise.xyz/api/tokens?includeChains=true';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const retiredPreStocks = new Set([
  'PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh', // SPACEX: redemption only after IPO.
  'PreC1KtJ1sBPPqaeeqL6Qb15GTLCYVvyYEwxhdfTwfx', // XAI: conversion deadline has passed.
]);
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);

function visibleListing(listing, now) {
  if (!record(listing) || listing.appId !== 'sunrise' || listing.status !== 'active') return false;
  const from = typeof listing.visibleFrom === 'string' ? Date.parse(listing.visibleFrom) : NaN;
  const until = listing.visibleUntil === null ? Infinity
    : typeof listing.visibleUntil === 'string' ? Date.parse(listing.visibleUntil) : NaN;
  return Number.isFinite(from) && from <= now && until > now;
}

function cataloguePage(body) {
  if (!record(body) || body.success !== true || !record(body.data)) throw Error('Invalid asset list.');
  const {listings, count, pagination} = body.data;
  if (!Array.isArray(listings) || !Number.isInteger(count) || count !== listings.length
    || count > 200 || !record(pagination) || !Number.isInteger(pagination.limit)
    || pagination.limit < 1 || pagination.limit > 200 || count > pagination.limit
    || !Object.hasOwn(pagination, 'nextCursor')) throw Error('Invalid asset list.');
  const cursor = pagination.nextCursor;
  if (cursor !== null && (typeof cursor !== 'string' || (cursor !== '' && !/^[\x21-\x7e]{1,2048}$/.test(cursor)))) throw Error('Invalid asset pagination.');
  if (cursor && count === 0) throw Error('Empty asset page has a continuation.');
  if (listings.some(row => !record(row) || !record(row.listing) || !record(row.token))) throw Error('Invalid asset listing.');
  return {listings, cursor: cursor || ''};
}

// A listed token and a supported launch quote are different things. In
// particular, a tradable stock mint may have no Raydium GlobalConfig at all.
export function launchQuoteAvailability(asset, approvedMints) {
  const supported=Array.isArray(approvedMints)?approvedMints.includes(asset.mint):null;
  return {...asset,supported,supportReason:supported===false
    ? 'Raydium has no bonding-curve launch configuration for this token yet.'
    : supported===null?'Live availability could not be checked. It will be verified before launch.':''};
}
export function sunriseAsset(row, {now = Date.now()} = {}) {
  // Keep the token-only helper usable by callers with verified metadata. The
  // network reader requires complete listing wrappers and visibility dates.
  const wrapped = record(row) && ('token' in row || 'listing' in row);
  if (wrapped && !visibleListing(row.listing, now)) return null;
  const token = wrapped ? row.token : row;
  if (!record(token) || (token.horizonChainId ?? token.chain) !== 'solana') return null;
  if (token.isNative === true || token.address === 'native') {
    return token.isNative === true && token.address === 'native' && token.symbol === 'SOL' ? verifiedAssets.get(SOL_MINT) : null;
  }
  if (typeof token.address !== 'string') return null;
  let mint; try { mint = new PublicKey(token.address).toBase58(); } catch { return null; }
  if (mint === PublicKey.default.toBase58() || retiredPreStocks.has(mint)) return null;
  const symbol = text(token.symbol, 24), name = text(token.name);
  if (!symbol || !name) return null;
  const assetClass = text(token.assetClass).toLowerCase();
  const stock = !!token.stock?.ticker || /^(stock|stocks|equity|security|securities|etf)$/.test(assetClass);
  const issuer = text(token.issuerName || token.issuer?.name || token.issuer, 80) || 'Sunrise listing';
  // Keep issuer-verified classifications (including Pre-IPO and wrapped XMR)
  // when the general feed also lists a known mint with incomplete metadata.
  const category = stock ? 'stocks' : /^(crypto|stablecoin)$/.test(assetClass) || !assetClass ? 'crypto' : 'other';
  return verifiedAssets.get(mint) || { mint, symbol, name, issuer, category, source: 'https://sunrise.xyz/' };
}
export class LaunchQuoteCatalogue {
  constructor({fetcher, now = Date.now} = {}) {
    this.network = fetcher ? null : createPublicFetcher(); this.fetcher = fetcher || this.network.fetcher;
    this.now = now; this.until = 0; this.assets = LAUNCH_ASSETS; this.source = 'verified snapshot';
  }
  async read() {
    if (this.now() < this.until) return {assets:this.assets, source:this.source};
    if (!this.pending) this.pending = this.refresh().finally(() => {this.pending = null;});
    return this.pending;
  }
  async refresh() {
    try {
      const assets = new Map(LAUNCH_ASSETS.map(a => [a.mint,a])), seen = new Set(), now = this.now(); let cursor = '';
      for (let page = 0; page < 20; page++) {
        // Identify the client and accept JSON: some listing hosts return 403 to
        // a header-less request, which silently drops us to the static snapshot
        // (so newly listed Sunrise tokens, e.g. ETFs, would never merge in).
        const response = await this.fetcher(`${SUNRISE_TOKENS}${cursor ? '&cursor='+encodeURIComponent(cursor) : ''}`, {signal:AbortSignal.timeout(10000), headers:{accept:'application/json','user-agent':'Launchpad/1.0 (pair catalogue sync)'}});
        if (!response.ok) throw Error('Asset list unavailable.');
        const body = await response.text(); if (body.length > 2000000) throw Error('Asset list too large.');
        const parsed = cataloguePage(JSON.parse(body));
        for (const row of parsed.listings) { const a = sunriseAsset(row, {now}); if (a && !assets.has(a.mint)) assets.set(a.mint,a); }
        cursor = parsed.cursor;
        if (!cursor) { this.assets = [...assets.values()]; this.source = 'Sunrise + verified issuers'; this.until = this.now()+60000; return {assets:this.assets,source:this.source}; }
        if (seen.has(cursor)) throw Error('Invalid asset pagination.');
        seen.add(cursor);
      }
      throw Error('Asset list exceeded the pagination limit.');
    } catch { this.until = this.now()+60000; return {assets:this.assets,source:this.source,notice:'Showing the last verified asset list. Live pair checks still run before launch.'}; }
  }
  close() { this.network?.close(); }
}
