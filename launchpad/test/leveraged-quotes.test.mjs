import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PublicKey } from '@solana/web3.js';
import { LAUNCH_ASSETS } from '../public/launch-assets.mjs';
import { quoteLogoPath, quoteAssetTitle } from '../public/quote-logos.mjs';
import { launchQuoteAvailability, sunriseAsset } from '../src/launchpad-quotes.mjs';

// Exact mints are published in Hylo's production app and independently derived
// from its official SDK (exo_levercoin collateral PDA under the Hylo program).
const canonical = [
  ['xSOL', 'SOL', '4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs', null],
  ['xBTC', 'BTC', '2zCo6bUowJMvr89ajxuWsPadAqJ2F9akCkxumNsSdgsL', 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij'],
  ['xHYPE', 'HYPE', '7ga6rtE9qSb3wdEiDCpTu2kHqoGVfT52jD8ign1rYTvx', '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g'],
];

test('Hylo leveraged quotes use issuer-derived mints and explicit exposure names, distinct from spot tokens', () => {
  const program = new PublicKey('HYEXCHtHkBagdStcJCp3xbbb9B7sdMdWXFNj6mdsG4hn');
  for (const [symbol, underlying, mint, collateral] of canonical) {
    const derived = PublicKey.findProgramAddressSync(collateral
      ? [Buffer.from('exo_levercoin'), new PublicKey(collateral).toBuffer()]
      : [Buffer.from('xSOL')], program)[0].toBase58();
    assert.equal(mint, derived);
    const rows = LAUNCH_ASSETS.filter(row => row.mint === mint); assert.equal(rows.length, 1);
    const asset = rows[0]; assert.equal(asset.symbol, symbol); assert.equal(asset.category, 'leveraged');
    assert.equal(asset.issuer, 'Hylo'); assert.equal(asset.name, 'Hylo Leveraged ' + underlying);
    assert.equal(asset.source, 'https://docs.hylo.so/product-guide/xassets');
    assert.match(quoteAssetTitle(asset), /Leveraged.*Hylo/);
    assert(!/\d+x|guaranteed|risk.free|no.loss/i.test(asset.name));
    for (const spot of LAUNCH_ASSETS.filter(row => row.symbol === underlying)) assert.notEqual(spot.mint, mint);
  }
});

test('a generic live feed cannot erase leveraged classification or force an unsupported pair live', () => {
  for (const [symbol, , mint] of canonical) {
    const asset = LAUNCH_ASSETS.find(row => row.mint === mint);
    assert.equal(sunriseAsset({ chain: 'solana', address: mint, symbol, name: symbol, assetClass: 'crypto' }).category, 'leveraged');
    assert.equal(launchQuoteAvailability(asset, []).supported, false);
    assert.equal(launchQuoteAvailability(asset, null).supported, null);
    assert.equal(launchQuoteAvailability(asset, [mint]).supported, true);
    assert.equal(asset.supported, undefined, 'catalogue metadata is not onchain approval');
  }
});

test('leveraged quotes ship distinct local 512px PNGs and do not list undeployed future SDK tokens', async () => {
  const paths = new Set();
  for (const [, , mint] of canonical) {
    const path = quoteLogoPath(mint); assert.equal(path, '/quote-logos/' + mint + '.png');
    paths.add(path); const image = await readFile(new URL('../public' + path, import.meta.url));
    assert(image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    assert.equal(image.readUInt32BE(16), 512); assert.equal(image.readUInt32BE(20), 512);
  }
  assert.equal(paths.size, 3);
  for (const mint of [
    'BzaYb37TkhSMW8d7Xfa1zB697NWZdRG9DGWesdiYs5qA', // xONYC
    'BmQFwSYrgd8vRRCYXbqUrpQ4vDaKmSYBMTGpKUorxziX', // xPST
    'FZzTUcH4Zf7A9QbmZw2kkh9K4ZGq7z8VV5vQj8s2RPXp', // xETH
    'FgLfLhT3QoPWynZ53L3KUUsPhspWbdPUfMtmPfezXci6', // xZEC
  ]) assert(!LAUNCH_ASSETS.some(row => row.mint === mint));
});
