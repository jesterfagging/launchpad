import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PublicKey} from '@solana/web3.js';
import {LAUNCH_ASSETS,CUSTOM_LAUNCH_ASSETS} from '../public/launch-assets.mjs';
import {customPairLabels} from '../public/custom-pair-fields.mjs';
import {quoteLabel,knownQuoteAsset} from '../public/quote-identity.mjs';
import {launchQuoteAvailability} from '../src/launchpad-quotes.mjs';

test('all 324 selected custom pairs retain exact supplied labels, mints and validated decimals',async()=>{
  const requested=JSON.parse(await readFile(new URL('./fixtures/selected-custom-pairs-v52.json',import.meta.url),'utf8'));
  assert.equal(requested.length,324);assert(CUSTOM_LAUNCH_ASSETS.length>=requested.length);assert.equal(new Set(LAUNCH_ASSETS.map(a=>a.mint)).size,LAUNCH_ASSETS.length);
  for(const row of requested){const asset=knownQuoteAsset(row.mint);assert.equal(asset.category,'custom');assert.equal(asset.name,row.name);assert.equal(asset.symbol,row.ticker);assert.equal(asset.mint,new PublicKey(row.mint).toBase58());assert(Number.isInteger(asset.decimals));assert.deepEqual(customPairLabels(row),{name:row.name,symbol:row.ticker});assert.equal(quoteLabel(row.mint,'FAKE'),row.ticker);if(asset.launchpadOrigin){assert.equal(asset.originVerified,true);assert(['pump','stonk'].includes(asset.launchpadOrigin));}else assert.notEqual(asset.originVerified,true);}
  assert.equal(LAUNCH_ASSETS.filter(a=>a.symbol==='FARTCOIN').length,1);
});
test('duplicate ticker identities and official LAUNCHPAD readiness remain exact-mint decisions',()=>{
  const cats=CUSTOM_LAUNCH_ASSETS.filter(a=>a.symbol==='BTC');assert.equal(cats.length,1);assert.equal(cats[0].name,'Buy The Cat');assert.equal(cats[0].mint,'E4Ap4icMLwKot8rkkTbq5JkS5kZxt5XCE3yfxbzYBjHx');
  const same=CUSTOM_LAUNCH_ASSETS.filter(a=>a.symbol==='BUTTHOLE');assert.equal(same.length,2);assert.notEqual(same[0].mint,same[1].mint);
  assert.equal(launchQuoteAvailability(same[0],[same[1].mint]).supported,false);assert.equal(launchQuoteAvailability(same[1],[same[1].mint]).supported,true);
  const customUsdc=knownQuoteAsset('C5nG72gUFJz6wewcgTPjcBmpSq4BwFLHy5j8heo9d7rZ');assert.equal(customUsdc.name,'Upside Down Cat');assert.equal(customUsdc.symbol,'USDC');assert.equal(customUsdc.category,'custom');assert.equal(customUsdc.decimals,9);assert.notEqual(customUsdc.mint,'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');assert.equal(launchQuoteAvailability(customUsdc,['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']).supported,false);
});
