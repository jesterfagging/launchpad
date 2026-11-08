import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {LAUNCH_ASSETS} from '../public/launch-assets.mjs';
import {METEORA_EXTRA_ASSETS} from '../public/meteora-extra-assets.mjs';
import {LaunchQuoteCatalogue,launchQuoteAvailability} from '../src/launchpad-quotes.mjs';
import {MeteoraQuoteCatalogue} from '../src/meteora-quotes.mjs';

const current=[
  ['NFLX','NFLX7qV57zuVxCoHy3s1jiGZyALraLNwttbxdvmYJLJ'],
  ['RKLB','RKLBnAXGqv31iZomqsuAWkQm1aqC7JwwvbCfzGdqAhz'],
];
test('September 29 Sunrise and Backpack listings survive an unavailable live index without implying Raydium support',async()=>{
  const catalogue=new LaunchQuoteCatalogue({fetcher:async()=>new Response('Unavailable',{status:403})}),result=await catalogue.read();
  assert(result.notice);
  for(const [symbol,mint] of current){
    const rows=result.assets.filter(asset=>asset.mint===mint);assert.equal(rows.length,1);
    const asset=rows[0];assert.equal(asset.symbol,symbol);assert.equal(asset.decimals,6);assert.equal(asset.tokenProgram,TOKEN_2022_PROGRAM_ID.toBase58());assert.equal(asset.issuer,'Backpack Securities');
    assert.equal(launchQuoteAvailability(asset,[]).supported,false);assert.equal(launchQuoteAvailability(asset,null).supported,null);assert.equal(asset.launchReady,undefined);
  }
  catalogue.close();
});
test('issuer additions merge by exact mint and remain unavailable until their live Meteora checks pass',async()=>{
  const catalogue=new MeteoraQuoteCatalogue({catalogue:{read:async()=>({assets:LAUNCH_ASSETS})}}),assets=await catalogue.assets();
  assert.equal(new Set(assets.map(asset=>asset.mint)).size,assets.length);
  for(const [,mint] of current)assert.equal(assets.filter(asset=>asset.mint===mint).length,1);
  const added=METEORA_EXTRA_ASSETS.filter(asset=>asset.source==='https://xstocks.fi/products'&&asset.tokenProgram===TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(added.length,391);
  for(const asset of added){
    assert.equal(new PublicKey(asset.mint).toBase58(),asset.mint);assert.equal(asset.decimals,8);assert.equal(asset.category,'stocks');assert.equal(asset.supported,undefined);assert.equal(asset.launchReady,undefined);
    assert.equal(catalogue.current(asset.mint).launchReady,false);
  }
  for(const mint of ['PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh','PreC1KtJ1sBPPqaeeqL6Qb15GTLCYVvyYEwxhdfTwfx'])assert(!assets.some(asset=>asset.mint===mint));
  await catalogue.close();
});
