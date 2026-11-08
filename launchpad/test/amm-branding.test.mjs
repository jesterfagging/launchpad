import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {createLaunchAmmBadge,launchAmm} from '../public/amm-branding.mjs';
import {createExploreCard} from '../public/explore-view.mjs';

const MINT='So11111111111111111111111111111111111111112',QUOTE='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const coin=patch=>({mint:MINT,name:'Test coin',symbol:'TEST',stage:'new',curveStatus:'curve',quote:{mint:QUOTE,symbol:'USDC'},...patch});

test('AMM attribution uses launch metadata, preserves legacy Raydium and ignores mint suffixes and ticker',()=>{
  assert.equal(launchAmm(coin({platform:'pumpswap'})),'pumpswap');
  assert.equal(launchAmm(coin({launchMode:'raydium'})),'raydium');
  assert.equal(launchAmm(coin({mint:'A'.repeat(28)+'pump',symbol:'PUMP'})),'raydium');
  assert.equal(launchAmm(coin({platform:'unsupported',symbol:'RAY'})),null);
  assert.equal(launchAmm(null),null);
});

test('both AMM marks distinguish the planned destination from completed graduation on cards',async()=>{
  const {document}=parseHTML('<html><head></head><body></body></html>');
  for(const [launchMode,name,path] of [['pumpswap','PumpSwap','/pair-origin-pump.png'],['raydium','Raydium','/quote-logos/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R.png']]){
    for(const graduated of [false,true]){
      const card=createExploreCard(document,coin({launchMode,stage:graduated?'graduated':'new',curveStatus:graduated?'migrated':'curve'})),badge=card.querySelector('.launch-amm-badge');
      assert.equal(badge.dataset.amm,launchMode);assert.equal(badge.title,`${graduated?'Graduated to':'Graduates to'} ${name}`);assert.equal(badge.getAttribute('aria-label'),badge.title);assert.equal(badge.querySelector('img').src,path);
      assert(card.getAttribute('aria-label').includes(badge.title));
      assert.equal(card.querySelector('.explore-coin-pair').textContent,'USDC');assert.doesNotMatch(badge.title,/Launched on Pump\.fun/);
    }
    const bytes=await readFile(new URL('../public'+path,import.meta.url));assert.equal(bytes.subarray(1,4).toString(),'PNG');
  }
  assert.equal(document.querySelectorAll('#curve-amm-branding-styles').length,1);
});

test('AMM logos retain a readable accessible label if their image cannot load',()=>{
  const {document}=parseHTML('<html><head></head><body></body></html>'),badge=createLaunchAmmBadge(document,coin({platform:'pumpswap'}));
  badge.querySelector('img').onerror();assert.equal(badge.textContent,'PumpSwap');assert.equal(badge.dataset.state,'fallback');assert.equal(badge.getAttribute('aria-label'),'Graduates to PumpSwap');assert.equal(badge.querySelector('img'),null);
});
