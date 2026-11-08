import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { burnTokenAmount, burnedUsdDisplay, coinBurnPrice, freshBurnPrice } from '../public/burn-valuation.mjs';
import { createCoinRewardsView } from '../public/coin-rewards-view.mjs';
import { createPublicAnalytics } from '../public/analytics-view.mjs';
import { OFFICIAL_TOKEN_MINT as MINT } from '../public/coin-image.mjs';
import { AdminVolume } from '../src/admin-volume.mjs';
import { PublicAnalytics } from '../src/public-analytics.mjs';

const NOW=Date.UTC(2026,8,29,12), QUOTE='So11111111111111111111111111111111111111112', POOL='5eqQJP9Ms7Rq6gqz1wKY9mNTiQckw2eQNh4hRtCB5Hh5';
const price=(patch={})=>({mint:MINT,usd:'0.00002',at:NOW,stale:false,...patch});
const coin={mint:MINT,curve:POOL,chain:'solana',feeMode:'holders',symbol:'LAUNCHPAD',taxBps:200,quote:{mint:QUOTE,symbol:'SOL'},marketSource:'Raydium onchain'};
const pool=(patch={})=>({chain:'solana',address:POOL,token:MINT,base:{address:MINT},quote:{address:QUOTE},isBase:true,priceUsd:'0.00003',at:NOW,liquidityUsd:1000,...patch});

test('burn USD valuation multiplies exact quantities before rounding and never treats USD value as spending',()=>{
  assert.equal(burnedUsdDisplay('41234567.890123',price(),{mint:MINT,now:NOW}),'$824.69');
  assert.equal(burnedUsdDisplay('12345678901234567890.123456',price({usd:'0.01'}),{mint:MINT,now:NOW}),'$123,456,789,012,345,678.90');
  assert.equal(burnedUsdDisplay('1000000000',price({usd:1e-8}),{mint:MINT,now:NOW}),'$10.00');
  assert.equal(burnedUsdDisplay('1',price(),{mint:MINT,now:NOW}),'<$0.01');
  assert.equal(burnedUsdDisplay('0',price(),{mint:MINT,now:NOW}),'$0.00');
  assert.equal(burnTokenAmount('41234567890123',6),'41234567.890123');
  assert.equal(burnTokenAmount('1',9),'0.000000001');
  for(const [raw,decimals]of [['2e6',6],['-1',6],[1,6],['1',null],['1',19]])assert.equal(burnTokenAmount(raw,decimals),null);
});

test('missing, stale, wrong-mint, zero, nonfinite and unbounded prices stay unavailable even for zero burns',()=>{
  for(const reference of [null,price({mint:QUOTE}),price({stale:true}),price({at:NOW-120001}),price({at:NOW+5001}),price({at:null}),price({usd:0}),price({usd:Infinity}),price({usd:'1e999'}),price({usd:'<img>'})]) {
    assert.equal(freshBurnPrice(reference,MINT,NOW),null);
    assert.equal(burnedUsdDisplay('0',reference,{mint:MINT,now:NOW}),'—');
  }
  for(const quantity of [null,100,'-1','1e999','9'.repeat(121)])assert.equal(burnedUsdDisplay(quantity,price(),{mint:MINT,now:NOW}),'—');
});

test('coin valuation uses current curve or correctly oriented pool, not stale or historical curve USD',()=>{
  const native={mint:MINT,curve:POOL,status:'curve',at:NOW,quote:{mint:QUOTE,usd:100,at:NOW,stale:false},priceUsd:'0.00002'};
  assert.equal(coinBurnPrice(coin,{coin,native},NOW)?.usd,'0.00002');
  assert.equal(coinBurnPrice(coin,{coin,native:{...native,status:'migrated'}},NOW),null);
  assert.equal(coinBurnPrice(coin,{coin,native:{...native,quote:{...native.quote,stale:true}}},NOW),null);
  assert.equal(coinBurnPrice(coin,{coin,pool:pool()},NOW)?.usd,'0.00003');
  assert.equal(coinBurnPrice(coin,{coin,pool:pool({base:{address:QUOTE},quote:{address:MINT},isBase:false,priceUsd:'0.00004'})},NOW)?.usd,'0.00004');
  for(const bad of [pool({isBase:false}),pool({token:QUOTE}),pool({at:NOW-120001}),pool({stale:true}),pool({base:{address:QUOTE}})])assert.equal(coinBurnPrice(coin,{coin,pool:bad},NOW),null);
  assert.equal(coinBurnPrice(coin,{coin,pool:pool(),stale:true},NOW),null);
});

test('tax burn card values only recorded direct burns and distinguishes current value from spending',()=>{
  const {document}=parseHTML('<section id="rewards"></section>'),root=document.querySelector('section'),ui=createCoinRewardsView({document,root});
  const data={mint:MINT,mode:'holders',quote:coin.quote,enabled:true,holder:{},taxBurn:{selected:true,tokensBurned:'41234567.890123',completedBurns:1,pendingTaxTokens:'90000000',initialInventory:{status:'burned',approvedTokens:'41234567.890123'}}};
  ui.render({coin,data,price:price(),now:NOW});
  const value=root.querySelector('[data-reward-metric="tax-burned-usd"]');
  assert.match(value.textContent,/Burned value · current price\$824.69/);
  assert.match(value.textContent,/not historical buyback spending/);
  ui.render({coin,data,price:price({stale:true}),now:NOW});
  assert.match(root.querySelector('[data-reward-metric="tax-burned-usd"]').textContent,/current price—/);
  assert.doesNotMatch(root.textContent,/\$0.00/);
});

test('analytics values finalized burned mint supply once and never falls back to receipt or pending counters',async()=>{
  const {document,window}=parseHTML('<main id="analytics-main"></main>');
  Object.defineProperty(document,'hidden',{value:false});
  const burnSupply={status:'available',mint:MINT,decimals:6,originalSupply:'1000000000000000',currentSupply:'814000000000000',totalBurned:'186000000000000',slot:452000000,at:NOW,source:'finalized-mint-supply',commitment:'finalized'};
  let response={version:1,generatedAt:NOW,launches:{},volume:{},burnSupply,treasury:{status:'available',curveMint:MINT,curveBurned:'41234567890123',curveBought:'999999999999999',curveDecimals:6,solSpent:'2000000000',solDecimals:9,curvePrice:price(),pendingBurn:'999999999999999',totalMintBurned:'999999999999999'}};
  const ui=createPublicAnalytics({document,window,now:()=>NOW,fetcher:async()=>({ok:true,json:async()=>response}),setTimer:()=>1,clearTimer:()=>{}});
  try{
    await ui.load();assert.match(document.querySelector('[data-analytics-metric="burned-usd"]').textContent,/\$3,720.00/);
    assert.match(document.querySelector('[data-analytics-metric="burned-supply"]').textContent,/186,000,000/);
    assert.match(document.querySelector('[data-analytics-metric="recorded-burns"]').textContent,/41,234,567.890123/);
    assert.doesNotMatch(document.querySelector('[data-analytics-metric="burned-usd"]').textContent,/\$824.69|\$4,544.69/);
    assert.match(document.querySelector('[data-analytics-metric="burned-usd"]').textContent,/not historical spending/);
    response={...response,treasury:{...response.treasury,curvePrice:price({at:NOW-120001})}};await ui.load();
    assert.match(document.querySelector('[data-analytics-metric="burned-usd"]').textContent,/current price—/);
    for(const unavailable of [null,{...burnSupply,status:'unavailable'},{...burnSupply,totalBurned:'187000000000000'}]){
      response={...response,burnSupply:unavailable,treasury:{...response.treasury,curvePrice:price()}};await ui.load();
      assert.match(document.querySelector('[data-analytics-metric="burned-usd"]').textContent,/current price—/);
      assert.match(document.querySelector('[data-analytics-metric="burned-supply"]').textContent,/onchain—/);
      assert.match(document.querySelector('[data-analytics-metric="recorded-burns"]').textContent,/41,234,567.890123/);
    }
  }finally{ui.destroy();}
});

test('analytics tokenPrice reuses bounded caches, chooses deepest valid pool and validates quote-side orientation',()=>{
  const volume=new AdminVolume({now:()=>NOW,marketData:{pools:()=>assert.fail('must not fetch')},accounts:{}});
  volume.sources.set(MINT,{dexRaw:{chain:'solana',tokenAddress:MINT,at:NOW,pools:[pool(),pool({liquidityUsd:2000,base:{address:QUOTE},quote:{address:MINT},isBase:false,priceUsd:'0.00004'}),pool({token:QUOTE,liquidityUsd:999999,priceUsd:100})]}});
  assert.equal(volume.tokenPrice(MINT)?.usd,'0.00004');
  volume.sources.get(MINT).dexRaw.stale=true;assert.equal(volume.tokenPrice(MINT),null);
  volume.sources.get(MINT).dexRaw.stale=false;volume.sources.get(MINT).dexRaw.pools=[pool({isBase:false})];assert.equal(volume.tokenPrice(MINT),null);
  volume.sources.get(MINT).dexRaw.tokenAddress=QUOTE;assert.equal(volume.tokenPrice(MINT),null);
  volume.close();
});

test('analytics attaches only a fresh safe price projection and does not change protocol burn totals',async()=>{
  let reference=price();
  const service=new PublicAnalytics({now:()=>NOW,accounts:{hostStore:{read:async()=>null}},volume:{readPublic:async()=>({launches:{},volume:{}}),tokenPrice:mint=>{assert.equal(mint,MINT);return {...reference,secret:'DO_NOT_EXPOSE'};}}});
  const first=await service.build();assert.equal(first.treasury.curvePrice.usd,'0.00002');assert(!JSON.stringify(first).includes('DO_NOT_EXPOSE'));
  const totals=[first.treasury.curveBurned,first.treasury.curveBought,first.treasury.solSpent];
  reference=price({stale:true});const second=await service.build();assert.equal(second.treasury.curvePrice,null);assert.deepEqual([second.treasury.curveBurned,second.treasury.curveBought,second.treasury.solSpent],totals);
  service.close();
});
