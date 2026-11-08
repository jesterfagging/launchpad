import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { LAUNCH_ASSETS } from '../public/launch-assets.mjs';
import { QUOTE_DISPLAY_ASSETS, NATIVE_LAUNCH_ASSETS } from '../public/quote-display-assets.mjs';
import { SOL_MINT, USDC_MINT } from '../public/launchpad-model.mjs';
import { QUOTE_LOGO_PATHS } from '../public/quote-logo-paths.mjs';
import { cleanQuoteSymbol, quoteLabel, knownQuoteAsset } from '../public/quote-identity.mjs';
import { cleanQuoteSymbol as displayClean, quoteLabel as displayLabel, knownQuoteDisplayAsset } from '../public/quote-display-identity.mjs';
import { quoteAssetTitle, quoteLogoPath } from '../public/quote-logos.mjs';

test('the lightweight display catalogue preserves every exact mint, symbol, name and issuer', () => {
  assert.equal(QUOTE_DISPLAY_ASSETS.length, LAUNCH_ASSETS.length);
  assert.equal(new Set(QUOTE_DISPLAY_ASSETS.map(asset => asset.mint)).size, LAUNCH_ASSETS.length);
  assert.deepEqual(NATIVE_LAUNCH_ASSETS, LAUNCH_ASSETS.filter(asset => [SOL_MINT, USDC_MINT].includes(asset.mint)), 'native launch fallbacks retain every original field');
  for (const asset of LAUNCH_ASSETS) {
    const display = knownQuoteDisplayAsset(asset.mint);
    assert.deepEqual(display, Object.fromEntries(['mint', 'name', 'symbol', 'issuer'].map(key => [key, asset[key]])));
    assert.equal(displayLabel(asset.mint, 'FAKE'), quoteLabel(asset.mint, 'FAKE'));
    assert.equal(quoteAssetTitle({ mint: asset.mint, symbol: 'FAKE' }), [asset.name, asset.issuer.replace(/_/g, ' ').trim(), asset.mint].join(' · '));
    assert.equal(knownQuoteAsset(asset.mint), asset, 'the full catalogue API still returns all eligibility/provider fields');
  }
  execFileSync(process.execPath, ['scripts/generate-quote-display-assets.mjs', '--check'], { cwd: new URL('..', import.meta.url) });
});

test('unknown symbols, placeholders and control characters keep identical display fallback rules', () => {
  for (const value of [null, undefined, 7, '', 'USDC', ' FAKE ', 'quote', 'quote token', 'Custom Pair', 'Saved pair', 'unknown', 'N/A', 'token', 'VERY_LONG_QUOTE_SYMBOL_1234567890', 'A\u202eB\u0000C']) {
    assert.equal(displayClean(value), cleanQuoteSymbol(value));
    for (const mint of [null, '', '11111111111111111111111111111111']) assert.equal(displayLabel(mint, value, 'backup'), quoteLabel(mint, value, 'backup'));
  }
  assert.equal(knownQuoteDisplayAsset('unknown'), null);
});

test('compact logo storage preserves all 1580 exact pinned paths, insertion order and frozen map behavior', () => {
  assert(Object.keys(QUOTE_LOGO_PATHS).length >= 1580);
  const originalPaths = Object.fromEntries(Object.entries(QUOTE_LOGO_PATHS).slice(0, 1580));
  assert.equal(createHash('sha256').update(JSON.stringify(originalPaths)).digest('hex'), 'cca783610a9adaf8fc4d68b39edddc7b7c8b00ffb537189ff11f234e65bd18e5');
  assert.equal(Object.isFrozen(QUOTE_LOGO_PATHS), true);
  for (const [mint, path] of Object.entries(QUOTE_LOGO_PATHS)) assert.equal(quoteLogoPath(mint), path);
});
