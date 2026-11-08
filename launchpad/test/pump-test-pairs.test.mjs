import test from 'node:test';
import assert from 'node:assert/strict';
import {LAUNCH_ASSETS} from '../public/launch-assets.mjs';
import {buildPumpTestPairCatalogue,PUMP_TEST_PAIR_EVIDENCE,PUMP_TEST_PAIR_PROVENANCE} from '../src/pump-test-pairs.mjs';
const SOL='So11111111111111111111111111111111111111112',TAXED='HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR';
const sol=LAUNCH_ASSETS.find(x=>x.mint===SOL),now=Date.parse('2026-09-28T21:00:00Z');

test('unknown mints and forged readiness never enter the private accepted list',()=>{
  const assets=[{name:'Unknown',symbol:'UNK',mint:'11111111111111111111111111111111',supported:true,ready:true,launchReady:true,mintCompatibility:'supported',testSelectable:true},
    {name:'Taxed',symbol:'TAX',mint:TAXED,supported:true,ready:true,launchReady:true}];
  const result=buildPumpTestPairCatalogue({assets,evidence:[{mint:assets[0].mint,status:'passed'}],now});
  assert.equal(result.pairs.length,0);assert.equal(result.excluded.length,2);
  assert.equal(result.excluded[0].mintCompatibility,'unknown');assert.equal(result.excluded[1].mintCompatibility,'unsupported');
  for(const row of result.excluded){assert.equal(row.testSelectable,false);assert.equal(row.launchReady,false);assert.equal(row.supported,false);assert.equal(row.ready,false);}
});

test('accepted mint is independently selected even when Raydium support says false',()=>{
  const input={...sol,id:'sol',decimals:1,supported:false,logo:'/sol.svg'};
  const result=buildPumpTestPairCatalogue({assets:[input],now}),pair=result.pairs[0];
  assert.equal(pair.testSelectable,true);assert.equal(pair.poolCompatible,true);assert.equal(pair.decimals,9);
  assert.equal(pair.id,'sol');assert.equal(pair.logo,'/sol.svg');assert.equal(pair.symbol,sol.symbol);
  assert.equal(pair.launchReady,false);assert.equal(input.decimals,1);
});

test('prices require finite positive numbers and fresh nonfuture timestamps',()=>{
  const base={assets:[sol],now};
  assert.equal(buildPumpTestPairCatalogue(base).pairs[0].priceStatus,'missing');
  for(const entry of [{usd:NaN,updatedAt:now},{usd:Infinity,updatedAt:now},{usd:0,updatedAt:now},{usd:-1,updatedAt:now},{usd:'100',updatedAt:now},{usd:100,updatedAt:now+1},{usd:100}]){
    const pair=buildPumpTestPairCatalogue({...base,prices:{[SOL]:entry}}).pairs[0];assert.equal(pair.priceStatus,'invalid');assert.equal(pair.priceUsd,null);
  }
  const stale=buildPumpTestPairCatalogue({...base,prices:new Map([[SOL,{usd:150,updatedAt:now-60001}]])});
  assert.equal(stale.pairs[0].priceStatus,'stale');assert.equal(stale.pairs[0].priceUsd,null);
  const fresh=buildPumpTestPairCatalogue({...base,prices:{[SOL]:{usd:150,updatedAt:new Date(now-500).toISOString()}}});
  assert.equal(fresh.summary.priceReady,1);assert.equal(fresh.pairs[0].priceUsd,150);assert.equal(fresh.pairs[0].launchReady,false);
});

test('catalogue uses exact mint identity, deduplicates, and never mutates caller metadata',()=>{
  const original=Object.freeze({...sol}),result=buildPumpTestPairCatalogue({assets:[original,{...sol,name:'Duplicate'},null,{}, {...sol,mint:` ${SOL}`}],now});
  assert.equal(result.pairs.length,1);assert.equal(result.pairs[0].id,SOL);assert.equal(result.excluded.length,1);
  assert.equal(result.excluded[0].mintCompatibility,'unknown');assert.equal(result.summary.total,2);
  assert.equal(buildPumpTestPairCatalogue({assets:null,now}).pairs.length,0);
});

test('evidence is deeply immutable and metadata-only token2022 is not confused with taxes',()=>{
  const taxed=PUMP_TEST_PAIR_EVIDENCE.find(x=>x.mint===TAXED),metadata=PUMP_TEST_PAIR_EVIDENCE.find(x=>x.extensions.join(',')==='18,19');
  assert.equal(taxed.status,'rejected');assert.equal(metadata.status,'passed');
  assert.throws(()=>PUMP_TEST_PAIR_EVIDENCE.push({}),TypeError);assert.throws(()=>{metadata.status='rejected'},TypeError);assert.throws(()=>metadata.extensions.push(1),TypeError);
  const pair=buildPumpTestPairCatalogue({assets:[{mint:metadata.mint,name:'Metadata',symbol:'M'}],now}).pairs[0];pair.extensions.push(1);assert.equal(metadata.extensions.includes(1),false);
});
