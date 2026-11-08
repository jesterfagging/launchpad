import {createMeteoraAccountLaunches} from '../public/meteora-account-ui.mjs';
import {coinImage,OFFICIAL_TOKEN_MINT} from '../public/coin-image.mjs';
import {createQuoteLabel,quoteLogoPath} from '../public/quote-logos.mjs';
import {createPersonalEarnings} from '../public/personal-earnings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createCoinTrade } from '../public/coin-trade.mjs';
import { createHoldersView } from '../public/holders-view.mjs';
import { createLiveTradesView, updateTradeAges } from '../public/live-trades-view.mjs';
import { LAUNCH_ASSETS } from '../public/launch-assets.mjs';
import { QUOTE_DISPLAY_ASSETS } from '../public/quote-display-assets.mjs';
import { createLaunchpadWallet } from '../public/launchpad-wallet.mjs';
import { creatorClaimState, runCreatorClaim } from '../public/creator-claims.mjs';
import { curveChartSnapshot } from '../public/launch-curve-chart.mjs';
import { createCoinRewardsView, validCoinRewards } from '../public/coin-rewards-view.mjs';

const ID='a'.repeat(32),DRAFT='b'.repeat(32),FAILED='c'.repeat(32);
const MINT='So11111111111111111111111111111111111111112',QUOTE='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',POOL='58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const SIGNATURE='5'.repeat(88),WALLET='11111111111111111111111111111111';
const launch=(patch={})=>({id:ID,mint:MINT,curve:POOL,state:'live',feeClaim:{available:true,busy:false,wallet:WALLET,requiresSignature:false,scope:'coin'},createdAt:1700000000000,input:{name:'Example token',symbol:'EXAMPLE',quoteMint:QUOTE,feeMode:'creator',targetUsd:20000,taxBps:0,description:'An account-owned launch.'},review:{actualUsd:20000},operations:[{kind:'create',state:'confirmed',signature:SIGNATURE}],...patch});
const market=(patch={})=>({address:POOL,token:MINT,symbol:'EXAMPLE',pair:'EXAMPLE / USDC',dex:'raydium',base:{address:MINT,symbol:'EXAMPLE'},quote:{address:QUOTE,symbol:'USDC'},priceUsd:.005,marketCapUsd:400000,fdvUsd:500000,liquidityUsd:42000,volume24h:9000,priceChange:{h24:4.2},txns:{h24:{buys:20,sells:8}},...patch});
const curve=(patch={})=>({launchId:ID,mint:MINT,curve:POOL,status:'curve',at:1700000100000,slot:100,source:'Raydium onchain',priceQuote:0.00002,fdvQuote:20000,supply:1e9,raisedQuote:1,targetQuote:100,progressPercent:1,quote:{mint:QUOTE,symbol:'USDC',usd:1,at:1700000100000,source:'Reference',stale:false},priceUsd:0.00002,fdvUsd:20000,stale:false,refreshMs:5000,points:[{time:1700000100,priceQuote:0.00002,slot:100}],historySource:'Launchpad observations',...patch});
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const ASSIGNED_OWNER='d'.repeat(32),ASSIGNED_ID='e'.repeat(32);
const feeAssignment=(patch={})=>({ownerAccountId:ASSIGNED_OWNER,id:ASSIGNED_ID,mint:POOL,name:'Assigned creator token',symbol:'ASSIGNED',image:null,quote:{mint:QUOTE,symbol:'USDC',decimals:6},recipient:WALLET,creator:{username:'original_creator'},claim:{available:true,busy:false,status:'ready',reason:''},collectedAmount:'1234567',collectedDisplay:'1.234567',lastCycle:100,lastClaimAt:100,operations:[],...patch});
const assignedResponse=rows=>({wallet:WALLET,assignments:rows,refreshMs:5000});

async function page(t,{id,view,rows=[launch()],respond,authenticated=true,sessionResponse,listResponse,beforeReady,chartFactory,walletFactory,claimWait=async()=>{}}={}){
  const {document,window}=parseHTML(await readFile(new URL('../public/launched-tokens.html',import.meta.url),'utf8'));
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return [...this.options].find(o=>o.selected)?.value||this.options[0]?.value||'';},set(value){for(const o of this.options)o.removeAttribute('selected');const option=[...this.options].find(o=>o.value===String(value));option?.setAttribute('selected','');}});
  Object.defineProperty(document,'hidden',{value:false,writable:true});
  const calls=[],timers=[],shells=[],charts=[],events=new Map();let now=1700000100000;
  const environment={Event:window.Event,dispatchEvent:()=>{},removeEventListener:(event,fn)=>{if(events.get(event)===fn)events.delete(event);},location:{search:id===undefined?view?'?view='+encodeURIComponent(view):'':`?id=${encodeURIComponent(id)}`},setTimeout,clearTimeout,navigator:{clipboard:{writeText:async()=>{}}},addEventListener:(event,fn)=>events.set(event,fn)};
  const fetcher=async(path,options)=>{
    calls.push({path,options});let value;
    if(path==='/api/session')value=sessionResponse?await sessionResponse(options):{authenticated,token:'account-csrf'};
    else if(path==='/api/launchpad')value=listResponse?await listResponse(options):{launches:typeof rows==='function'?rows():rows};
    else value=await respond?.(path,options);
    if(value===undefined){
      if(path==='/api/launchpad/meteora/launches')value={launches:[]};
      else if(path==='/api/launchpad/fee-assignments')value={wallet:WALLET,assignments:[],refreshMs:5000};
      else if(path.startsWith('/api/launchpad/rewards?')){const row=(typeof rows==='function'?rows():rows).find(row=>row.id===new URL(path,'https://app.local').searchParams.get('id'));value={launchId:row.id,mint:row.mint,asOf:now,stale:false,refreshMs:30000,schedule:row.holderRewards,wallet:{address:WALLET,quoteBalance:'0',quoteSymbol:row.holderRewards?.quoteSymbol||'USDC'},earned:{quote:row.holderRewards?.pendingQuote||'0',unconvertedTaxTokens:'0'},totals:{distributedQuote:'0',payments:0,lastDistributionAt:null,lastDistributionQuote:null},taxes:{note:'Unclaimed transfer fees are not included.'}};}
      else if(path.startsWith('/api/launchpad/market?'))value=curve();
      else if(path.startsWith('/api/launchpad/trades?'))value={trades:[],source:'Raydium launch curve',at:now,refreshMs:1000};
      else if(path.startsWith('/api/launchpad/market/pools'))value={chain:'solana',tokenAddress:MINT,pools:[market()],at:now,refreshMs:60000};
      else if(path.startsWith('/api/launchpad/market/live-trades'))value={trades:[],source:'Confirmed swaps',at:now,refreshMs:1000};
      else if(path.startsWith('/api/launchpad/market/holders'))value={chain:'solana',tokenAddress:MINT,source:'Solana onchain',at:now,supply:'1000',listedSupplyPercent:25,historyAvailable:true,rows:[{address:WALLET,amount:'250',supplyPercent:25}]};
      else throw Error('Unexpected API request '+path);
    }
    const status=typeof value.status==='number'?value.status:200;return {ok:status<400,status,json:async()=>status>=400?value.body:value};
  };
  window.HTMLDialogElement;for(const dialog of document.querySelectorAll('dialog')){dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};}
  const source=(await readFile(new URL('../public/launched-tokens.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replaceAll('export function ','function ').replace(/^bootPage\([^\n]+\n?$/m,'');
  const factory=new Function('createMeteoraAccountLaunches','coinImage','createPersonalEarnings','createQuoteLabel','createWorkspaceShell','createHoldersView','createLiveTradesView','updateTradeAges','LAUNCH_ASSETS','createLaunchpadWallet','creatorClaimState','runCreatorClaim','createCoinRewardsView','validCoinRewards','curveChartSnapshot','createCoinTrade',source+'\nreturn createLaunchedTokensPage;')(createMeteoraAccountLaunches,coinImage,createPersonalEarnings,createQuoteLabel,()=>{},createHoldersView,createLiveTradesView,updateTradeAges,QUOTE_DISPLAY_ASSETS,createLaunchpadWallet,creatorClaimState,runCreatorClaim,createCoinRewardsView,validCoinRewards,curveChartSnapshot,createCoinTrade);
  const app=factory({document,window:environment,fetcher,walletFactory,claimWait,clock:()=>now,setTimer:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimer:()=>{},shell:args=>shells.push(args),chartFactory:chartFactory||(async(container)=>{const chart={container,updates:[],removed:false,set(points,options){this.updates.push({points,options});},remove(){this.removed=true;}};charts.push(chart);return chart;})});t.after(()=>app.destroy());
  await beforeReady?.({document,window,app,calls});await app.ready;await flush();await flush();
  return {document,window,get:id=>document.getElementById(id),calls,app,events,shells,charts,async tick(ms){now+=ms;await app.tick();await flush();await flush();},async tab(name){document.querySelector(`[data-token-tab="${name}"]`).onclick();await flush();await flush();}};
}

test('owned launch list separates drafts and failed setup from confirmed onchain tokens',async t=>{
  const ui=await page(t,{rows:[launch(),launch({id:DRAFT,state:'draft',curve:null,operations:[]}),launch({id:FAILED,state:'error',curve:null,operations:[{kind:'setup',state:'confirmed',signature:SIGNATURE}]})]});
  assert.equal(ui.get('tokens-count-launched').textContent,'1');assert.equal(ui.get('tokens-count-drafts').textContent,'2');assert.equal(ui.document.querySelector('[data-launch-filter=unfinished]'),null);
  assert.equal(ui.document.querySelectorAll('.token-launch-card').length,1);assert.equal(ui.document.querySelector('.token-launch-card .token-card-link').getAttribute('href'),'/launched-tokens?id='+ID);
  assert.equal(ui.calls.some(call=>call.path.startsWith('/api/launchpad/market')),false);
  ui.document.querySelector('[data-launch-filter="drafts"]').onclick();assert.match(ui.get('tokens-list').textContent,/Draft/);assert.match(ui.get('tokens-list').textContent,/Not launched onchain/);
  assert.match(ui.get('tokens-list').textContent,/Needs attention/);assert.equal(ui.document.querySelectorAll('.token-launch-card').length,2);
  assert.equal(ui.shells[0].page,'launched-tokens');
});
test('unknown launch IDs never query markets or display another account launch',async t=>{
  for(const id of ['d'.repeat(32),'../../other','<script>']){
    const ui=await page(t,{id});assert.match(ui.get('tokens-list').textContent,/Launch not found/);assert.equal(ui.get('tokens-detail-view').hidden,true);assert.equal(ui.calls.some(call=>call.path.startsWith('/api/launchpad/market')),false);
  }
});
test('unauthenticated visitors cannot fetch or view the launch list',async t=>{
  const ui=await page(t,{authenticated:false,id:ID});assert.equal(ui.get('tokens-main').hidden,true);assert.equal(ui.get('tokens-gate').hidden,false);assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].path,'/api/session');
});
test('draft and failed precreation details have no market feed or trade controls',async t=>{
  for(const state of ['draft','error','awaiting_signature']){
    const ui=await page(t,{id:ID,rows:[launch({state,curve:null,operations:[{kind:'setup',state:'confirmed',signature:SIGNATURE}]})]});
    assert.equal(ui.document.querySelector('iframe'),null);assert.equal(ui.get('token-trade').hidden,true);assert.match(ui.get('token-chart').textContent,/Not onchain yet/);assert.equal(ui.calls.some(call=>call.path.startsWith('/api/launchpad/market')),false);
    assert.equal(ui.get('token-manage').getAttribute('href'),'/launchpad?id='+ID);
  }
});
test('confirmed creation waiting for verification is separate from unindexed market data',async t=>{
  const ui=await page(t,{id:ID,rows:[launch({curve:null,state:'launching'})],respond:path=>path.startsWith('/api/launchpad/market/pools')?{chain:'solana',tokenAddress:MINT,pools:[],at:1700000100000,refreshMs:60000}:undefined});
  assert.equal(ui.get('token-launch-state').textContent,'Verifying launch');assert.match(ui.get('token-launch-note').textContent,/creation is confirmed/);assert.match(ui.get('token-chart').textContent,/Reading your launch curve/);assert.equal(ui.get('token-market-cap').textContent,'—');assert.equal(ui.document.querySelector('iframe'),null);assert.equal(ui.get('token-trade').getAttribute('href'),null);assert.match(ui.get('token-trade').textContent,/Buy/);
  await ui.tab('holders');assert.match(ui.get('token-activity-body').textContent,/25%/);assert.equal(ui.calls.some(call=>call.path.includes('holder-history')),false);
});
test('market detail uses DEX data and retains the iframe across polling',async t=>{
  let cap=400000;
  const ui=await page(t,{id:ID,respond:path=>path.startsWith('/api/launchpad/market/pools')?{chain:'solana',tokenAddress:MINT,pools:[market({marketCapUsd:cap,url:'https://attacker.invalid',chart:'javascript:bad()'})],at:1700000100000,refreshMs:60000}:path.startsWith('/api/launchpad/market?')?curve({status:'migrated'}):undefined});
  const frame=ui.document.querySelector('iframe');assert(frame);assert.equal(frame.getAttribute('src'),`https://dexscreener.com/solana/${POOL}?embed=1&theme=dark&info=0&trades=0`);assert.match(ui.get('token-market-cap').textContent,/400/);assert(!ui.get('token-market-cap').textContent.includes('20,000'));
  cap=450000;await ui.app.refreshMarket(true);await flush();assert.equal(ui.document.querySelector('iframe'),frame);assert.match(ui.get('token-market-cap').textContent,/450/);assert.equal(ui.get('token-dex').getAttribute('href'),`https://dexscreener.com/solana/${POOL}`);
  assert(ui.calls.every(call=>call.options.method==='GET'));assert(ui.calls.filter(call=>call.path!=='/api/session').every(call=>call.options.headers['x-control-token']==='account-csrf'));
});
test('malicious metadata is text and unsupported link schemes never become clickable',async t=>{
  const row=launch();row.input={...row.input,name:'<img src=x onerror=alert(1)>',description:'<script>steal()</script>',image:'javascript:alert(1)',website:'javascript:alert(2)',twitter:'https://x.com/examplecoin',telegram:'data:text/html,bad'};
  const ui=await page(t,{id:ID,rows:[row]});assert.equal(ui.get('token-name').textContent,row.input.name);assert.equal(ui.get('token-description').textContent,row.input.description);assert.equal(ui.get('token-avatar').querySelector('img'),null);assert.equal(ui.get('token-socials').querySelectorAll('a').length,1);assert.equal(ui.get('token-socials').querySelector('a').getAttribute('href'),'https://x.com/examplecoin');
});
test('holders refresh independently and wallet histories remain explicitly requested',async t=>{
  const ui=await page(t,{id:ID,respond:path=>path.includes('/holder-history')?{source:'Helius',available:false,coverage:{complete:false,note:'No decoded swaps in the retrieved window.'}}:undefined});
  await ui.tab('holders');assert.match(ui.get('token-activity-body').textContent,/% of supply/);assert.match(ui.get('token-activity-body').textContent,/25%/);assert.equal(ui.calls.filter(call=>call.path.includes('/holder-history')).length,0);
  const before=ui.calls.filter(call=>call.path.includes('/holders?')).length;await ui.tick(15000);assert.equal(ui.calls.filter(call=>call.path.includes('/holders?')).length,before+1);
  ui.document.querySelector('.holder-history-button').onclick();await flush();await flush();assert.equal(ui.calls.filter(call=>call.path.includes('/holder-history')).length,1);assert.match(ui.get('token-activity-body').textContent,/No decoded swaps/);
  const marketReads=ui.calls.filter(call=>call.path.startsWith('/api/launchpad/market/'));assert(marketReads.length>=3);
  for(const call of marketReads){const query=new URL(call.path,'https://launch.example').searchParams;assert.equal(query.get('id'),ID);assert.equal(query.has('address'),false);assert.equal(query.has('chain'),false);}
  assert.equal(ui.calls.some(call=>call.path.startsWith('/api/market/')),false);
});
test('swap rows survive refresh and RPC cooldowns prevent one-second retry spam',async t=>{
  let fail=false;
  const trade={id:'trade-one',signature:SIGNATURE,side:'buy',at:1700000095000,tokenAmount:'10',quoteAmount:'1',quoteSymbol:'USDC',wallet:WALLET,gasNative:'0.000005',gasSymbol:'SOL'};
  const ui=await page(t,{id:ID,respond:path=>path.includes('/live-trades?')?fail?{status:503,body:{error:'RPC rate limited.',retryAfterMs:60000}}:{trades:[trade],at:1700000100000,refreshMs:1000,source:'Confirmed swaps'}:undefined});
  const row=ui.document.querySelector('[data-trade]');assert(row);await ui.tick(1000);assert.equal(ui.document.querySelector('[data-trade]'),row);
  fail=true;await ui.tick(1000);const requests=ui.calls.filter(call=>call.path.includes('/live-trades?')).length;await ui.tick(1000);assert.equal(ui.calls.filter(call=>call.path.includes('/live-trades?')).length,requests);assert.match(ui.get('token-activity-body').textContent,/RPC rate limited/);assert.equal(ui.document.querySelector('[data-trade]'),row);
});
test('hidden pages stop background API work and manual refresh preference stops holder polling',async t=>{
  const ui=await page(t,{id:ID,respond:path=>path.startsWith('/api/launchpad/market/pools')?{chain:'solana',tokenAddress:MINT,pools:[market()],at:1700000100000,refreshMs:0}:undefined});
  await ui.tab('holders');const before=ui.calls.length;await ui.tick(15000);assert.equal(ui.calls.length,before);
  ui.document.hidden=true;await ui.tick(120000);assert.equal(ui.calls.length,before);
});
test('provider failures are visible without labeling a missing chart as no trading activity',async t=>{
  const ui=await page(t,{id:ID,respond:path=>path.startsWith('/api/launchpad/market/pools')?{status:503,body:{error:'DEX Screener is rate limited.',retryAfterMs:30000}}:undefined});
  assert.match(ui.get('token-chart').textContent,/First confirmed curve price/);assert.match(ui.get('token-market-note').textContent,/DEX Screener is unavailable/);assert.equal(ui.get('token-market-cap').textContent,'$20K');assert.equal(ui.document.querySelector('iframe'),null);const before=ui.calls.filter(row=>row.path.startsWith('/api/launchpad/market/pools')).length;await ui.tick(1000);assert.equal(ui.calls.filter(row=>row.path.startsWith('/api/launchpad/market/pools')).length,before);
});
test('token images use validated local uploads and missing files fall back to an initial',async t=>{
  const row=launch();row.input={...row.input,imageId:'f'.repeat(64)+'.webp',image:'https://gateway.irys.xyz/remote-file'};
  const ui=await page(t,{id:ID,rows:[row]}),image=ui.get('token-avatar').querySelector('img');assert(image);assert.equal(image.getAttribute('src'),'/token-images/'+'f'.repeat(64)+'.webp');
  image.onerror();assert.equal(ui.get('token-avatar').querySelector('img'),null);assert.equal(ui.get('token-avatar').firstElementChild.hidden,false);assert.equal(ui.get('token-avatar').textContent,'R');
  row.input.imageId='../../private.png';const invalid=await page(t,{id:ID,rows:[row]});assert.equal(invalid.get('token-avatar').querySelector('img'),null);
});
test('legacy mainnet and devnet records remain readable in Archived tokens without mainnet feeds',async t=>{
  const old=launch({archived:true});old.input={...old.input,network:'mainnet-beta',route:'pump'};
  const dev=launch({id:DRAFT,archived:true});dev.input={...dev.input,network:'devnet'};
  const list=await page(t,{view:'archived',rows:[old,dev]});assert.equal(list.get('tokens-count-launched').textContent,'0');assert.equal(list.get('tokens-count-archived').textContent,'2');assert.match(list.get('tokens-list').textContent,/Earlier launch record · devnet/);assert.equal(list.get('tokens-claim-all').disabled,true);
  for(const id of [ID,DRAFT]){const detail=await page(t,{id,rows:[old,dev]});assert.equal(detail.get('tokens-detail-view').hidden,false);assert.equal(detail.calls.some(call=>call.path.startsWith('/api/launchpad/market')),false);assert.equal(detail.get('token-trade').hidden,true);assert.equal(detail.get('token-claim-detail').hidden,true);assert.match(detail.get('token-chart').textContent,/Saved launch record/);}
});
test('manual holder refresh honors cooldown and browser cache restoration keeps polling usable',async t=>{
  const ui=await page(t,{id:ID,respond:path=>path.includes('/holders?')?{status:503,body:{error:'Holder provider cooling down.',retryAfterMs:60000}}:undefined});
  await ui.tab('holders');const before=ui.calls.filter(call=>call.path.includes('/holders?')).length;await ui.app.refreshHolders(true);assert.equal(ui.calls.filter(call=>call.path.includes('/holders?')).length,before);
  ui.events.get('pagehide')({persisted:true});await ui.tick(60000);assert.equal(ui.calls.filter(call=>call.path.includes('/holders?')).length,before+1);
});

const unindexed=()=>({chain:'solana',tokenAddress:MINT,pools:[],at:1700000100000,refreshMs:60000});
test('a first confirmed WBTC curve point renders without DEX indexing or invented market totals',async t=>{
  const ui=await page(t,{id:ID,respond:path=>path.startsWith('/api/launchpad/market/pools')?unindexed():path.startsWith('/api/launchpad/market?')?curve({priceQuote:2e-10,fdvQuote:.2,priceUsd:.00002,fdvUsd:20000,quote:{mint:QUOTE,symbol:'WBTC',usd:100000,at:1700000100000,stale:false},points:[{time:1700000100,priceQuote:2e-10,slot:100}]}):undefined});
  assert.equal(ui.charts.length,1);assert.equal(ui.charts[0].updates[0].points.length,1);assert.equal(ui.get('token-price').textContent,'$0.00002');assert.equal(ui.get('token-price-usd').textContent,'0.0000000002 WBTC per token');assert.equal(ui.get('token-market-cap').textContent,'$20K');
  assert.equal(ui.get('token-market-cap-label').textContent,'Fully diluted value');assert.equal(ui.get('token-market-reference').textContent,'Raydium onchain');assert.match(ui.get('token-curve-caption').textContent,/First confirmed/);
  assert.match(ui.get('token-stats').textContent,/24h volume—/);assert.equal(ui.get('token-stats').textContent.includes('Liquidity'),false);assert.equal(ui.get('token-curve-progress').hidden,false);assert.match(ui.get('token-graduation-amount').textContent,/1 \/ 100 WBTC raised/);
  assert.equal(ui.calls.some(row=>row.path==='/api/launchpad/trades?id='+ID),true);assert.equal(ui.document.querySelector('iframe'),null);
});
test('curve refresh preserves the chart and exact observed history, with FDV based on supply',async t=>{
  let reading=curve();const ui=await page(t,{id:ID,respond:path=>path.startsWith('/api/launchpad/market/pools')?unindexed():path.startsWith('/api/launchpad/market?')?reading:undefined});const plot=ui.get('token-curve-plot');
  reading=curve({at:1700000105000,points:[{time:1700000100,priceQuote:.00002,slot:100},{time:1700000105,priceQuote:.000021,slot:101}],priceQuote:.000021,fdvQuote:21000});
  await ui.tick(5000);assert.equal(ui.charts.length,1);assert.equal(ui.get('token-curve-plot'),plot);assert.equal(ui.charts[0].updates.at(-1).points.length,2);
  const button=ui.document.querySelector('[data-curve-mode="fdv"]');button.onclick();assert.equal(button.getAttribute('aria-pressed'),'true');assert.equal(ui.charts[0].updates.at(-1).options.mode,'fdv');assert.equal(ui.charts[0].updates.at(-1).options.supply,1e9);
});
test('owned new launches draw a current curve snapshot even before history exists',async t=>{
  const ui=await page(t,{id:ID,respond:path=>path.startsWith('/api/launchpad/market/pools')?unindexed():path.startsWith('/api/launchpad/market?')?curve({points:undefined,candles:[],priceUsd:null,fdvUsd:null,quote:{mint:QUOTE,symbol:'USDC',stale:true}}):undefined});
  assert.equal(ui.charts.length,1);assert.deepEqual(ui.charts[0].updates[0].points,[{time:1700000100,priceQuote:.00002,slot:100}]);assert.deepEqual(ui.charts[0].updates[0].options.candles,[]);assert.match(ui.get('token-curve-caption').textContent,/First confirmed curve price/);assert.equal(ui.get('token-price').textContent,'—');assert.equal(ui.get('token-market-cap').textContent,'—');assert.equal(ui.get('token-price-usd').textContent,'0.00002 USDC per token');
});
test('owned active curves use fresh DEX USD fallback but never substitute quote units for missing FDV',async t=>{
  const missing=curve({priceUsd:null,fdvUsd:null,quote:{mint:QUOTE,symbol:'USDC',stale:true}});
  const ui=await page(t,{id:ID,respond:path=>path.startsWith('/api/launchpad/market?')?missing:undefined});
  assert.equal(ui.get('token-market-cap').textContent,'$500K');assert.equal(ui.get('token-price').textContent,'$0.005');assert.equal(ui.get('token-market-reference').textContent,'DEX Screener');
  assert.equal(ui.charts.length,1);assert.equal(ui.document.querySelector('iframe'),null);
  const stale=await page(t,{id:ID,respond:path=>path.startsWith('/api/launchpad/market?')?missing:path.startsWith('/api/launchpad/market/pools')?{...unindexed(),pools:[market()],stale:true}:undefined});
  assert.equal(stale.get('token-market-cap').textContent,'—');assert.equal(stale.get('token-price').textContent,'—');assert.equal(stale.get('token-market-reference').textContent,'USD pricing unavailable');
});
test('owned chart rendering failures retry without leaving a permanently empty plot',async t=>{
  let attempts=0,removed=0,sets=0;
  const ui=await page(t,{id:ID,respond:path=>path.startsWith('/api/launchpad/market/pools')?unindexed():undefined,chartFactory:async()=>{const attempt=++attempts;return {set(){if(attempt===1)throw Error('Transient canvas failure');sets++;},remove(){removed++;}};}});
  assert.match(ui.get('token-chart').textContent,/reconnecting/);assert.equal(attempts,1);assert.equal(removed,1);await ui.tick(5000);assert.equal(attempts,2);assert(sets>=1);assert(!ui.get('token-chart').textContent.includes('reconnecting'));
});
test('active curves stay native after indexing, then migrated curves hand off to DEX and pause native polling',async t=>{
  let indexed=false,fail=false,migrated=false;
  const ui=await page(t,{id:ID,respond:path=>path.startsWith('/api/launchpad/market/pools')?fail?{status:503,body:{error:'DEX unavailable',retryAfterMs:15000}}:indexed?{...unindexed(),pools:[market()]}:unindexed():path.startsWith('/api/launchpad/market?')?curve({status:migrated?'migrated':'curve'}):undefined});
  assert.equal(ui.charts.length,1);indexed=true;await ui.app.refreshMarket(true);await flush();assert.equal(ui.document.querySelector('iframe'),null);assert.equal(ui.charts[0].removed,false);
  migrated=true;await ui.app.refreshCurve(true);await flush();assert(ui.document.querySelector('iframe'));assert.equal(ui.charts[0].removed,true);
  const reads=ui.calls.filter(row=>row.path.startsWith('/api/launchpad/market?')).length;await ui.tick(10000);assert.equal(ui.calls.filter(row=>row.path.startsWith('/api/launchpad/market?')).length,reads);
  fail=true;await ui.app.refreshMarket(true);await flush();await flush();assert.equal(ui.document.querySelector('iframe'),null);assert.equal(ui.charts.length,2);assert.match(ui.get('token-market-note').textContent,/onchain chart remains active/);
});
test('curve failures keep the last verified chart, timestamps and explicit delayed status',async t=>{
  let fail=false;const ui=await page(t,{id:ID,respond:path=>path.startsWith('/api/launchpad/market/pools')?unindexed():path.startsWith('/api/launchpad/market?')?fail?{status:503,body:{error:'Your RPC is cooling down.',retryAfterMs:30000}}:curve():undefined});
  const plot=ui.get('token-curve-plot');fail=true;await ui.tick(5000);assert.equal(ui.get('token-curve-plot'),plot);assert.equal(ui.charts.length,1);assert.match(ui.get('token-market-note').textContent,/updated/);assert.match(ui.get('token-market-note').textContent,/cooling down/);assert.match(ui.get('token-market-reference').textContent,/Data delayed/);
  const reads=ui.calls.filter(row=>row.path.startsWith('/api/launchpad/market?')).length;await ui.app.refreshCurve(true);await ui.tick(5000);assert.equal(ui.calls.filter(row=>row.path.startsWith('/api/launchpad/market?')).length,reads);
});
test('manual market preference and hidden pages stop curve and trade polling',async t=>{
  let manual=false;const ui=await page(t,{id:ID,respond:path=>path.startsWith('/api/launchpad/market/pools')?{...unindexed(),refreshMs:manual?0:60000}:undefined});
  ui.document.hidden=true;const before=ui.calls.length;await ui.tick(20000);assert.equal(ui.calls.length,before);ui.document.hidden=false;
  manual=true;await ui.app.refreshMarket(true);await flush();const reads=ui.calls.filter(row=>row.path.startsWith('/api/launchpad/market?')||row.path.startsWith('/api/launchpad/trades?')).length;
  await ui.tick(20000);assert.equal(ui.calls.filter(row=>row.path.startsWith('/api/launchpad/market?')||row.path.startsWith('/api/launchpad/trades?')).length,reads);
  await ui.app.refreshCurve(true);assert.equal(ui.calls.filter(row=>row.path.startsWith('/api/launchpad/market?')||row.path.startsWith('/api/launchpad/trades?')).length,reads+1);
});
test('mismatched mint, quote or account launch data cannot populate the native chart',async t=>{
  for(const patch of [{launchId:DRAFT},{mint:QUOTE},{curve:MINT},{quote:{mint:MINT,symbol:'FAKE'}}]){
    const ui=await page(t,{id:ID,respond:path=>path.startsWith('/api/launchpad/market/pools')?unindexed():path.startsWith('/api/launchpad/market?')?curve(patch):undefined});
    assert.equal(ui.charts.length,0);assert.match(ui.get('token-market-note').textContent,/does not match this launch/);assert.equal(ui.get('token-market-cap').textContent,'—');
  }
});
test('real quote candles are passed through without synthesizing historical USD candles',async t=>{
  const candles=[{time:1700000040,open:.00001,high:.000021,low:.000009,close:.00002,volume:2}];
  const ui=await page(t,{id:ID,respond:path=>path.startsWith('/api/launchpad/market/pools')?unindexed():path.startsWith('/api/launchpad/market?')?curve({candles,candleSource:'Raydium history',candleAt:1700000100000}):undefined});
  assert.deepEqual(ui.charts[0].updates[0].options.candles,candles);assert.match(ui.get('token-curve-caption').textContent,/Raydium trading history/);assert.match(ui.get('token-market-note').textContent,/chart stays in the quote asset/);
});
test('onchain launch swaps render immediately without an indexed pair',async t=>{
  const trade={id:'curve-trade',signature:SIGNATURE,side:'buy',at:1700000095000,tokenAmount:'10',quoteAmount:'0.0000001',quoteSymbol:'WBTC',wallet:WALLET,gasNative:'0.000005',gasSymbol:'SOL'};
  const ui=await page(t,{id:ID,respond:path=>path.startsWith('/api/launchpad/market/pools')?unindexed():path.startsWith('/api/launchpad/trades?')?{trades:[trade],source:'Raydium launch curve',at:1700000100000,refreshMs:1000}:undefined});
  const row=ui.document.querySelector('[data-trade]');assert(row);await ui.tick(1000);assert.equal(ui.document.querySelector('[data-trade]'),row);assert.match(ui.get('token-activity-note').textContent,/Raydium launch curve/);
});
test('page teardown aborts pending curve requests and removes an initialized chart',async t=>{
  let pending=false,signal;
  const ui=await page(t,{id:ID,respond:(path,options)=>path.startsWith('/api/launchpad/market/pools')?unindexed():path.startsWith('/api/launchpad/market?')&&pending?new Promise((resolve,reject)=>{signal=options.signal;signal.addEventListener('abort',()=>reject(Error('aborted')));}):undefined});
  pending=true;const refresh=ui.app.refreshCurve(true);await flush();ui.app.destroy();await refresh;assert.equal(signal.aborted,true);assert.equal(ui.charts[0].removed,true);
});

test('creator claims are separate buttons, managed rewards cannot be diverted, and draft recovery is explicit',async t=>{
  const holder=launch({id:DRAFT,input:{...launch().input,feeMode:'holders'}}),failed=launch({id:FAILED,state:'failed',curve:null,operations:[],recovery:{status:'complete',refundedLamports:'2500000',refundWallet:WALLET,notice:'Unused setup SOL is returned to the original paying wallet.'}});
  const ui=await page(t,{rows:[launch(),holder,failed]});
  assert.equal(ui.document.querySelector('.token-launch-card').tagName,'ARTICLE');assert.equal(ui.document.querySelector('a button'),null);
  const cards=[...ui.document.querySelectorAll('.token-launch-card')];assert.equal(cards.find(row=>row.dataset.launchId===ID).querySelector('button').disabled,false);assert.equal(cards.find(row=>row.dataset.launchId===DRAFT).querySelector('button').disabled,true);assert.match(cards.find(row=>row.dataset.launchId===DRAFT).textContent,/reserved for holder rewards/);
  ui.document.querySelector('[data-launch-filter="drafts"]').onclick();assert.match(ui.get('tokens-list').textContent,/0.0025 SOL returned/);assert.equal(ui.get('tokens-list').querySelector('button'),null);
});
test('per-coin default wallet claims wait for confirmed completion and expose the receipt',async t=>{
  const initial=launch();let rows=[initial],reads=0;
  const ui=await page(t,{rows:()=>rows,respond:(path,options)=>{
    if(path==='/api/launchpad/action'){assert.equal(JSON.parse(options.body).action,'fees');rows=[launch({feesRequested:true,cycle:{stage:'claim'}})];return rows[0];}
  },claimWait:async()=>{reads++;rows=[launch({feesRequested:false,lastCycle:1700000200000,lastFeeClaim:{result:'claimed'},operations:[...initial.operations,{kind:'claim',state:'confirmed',signature:'6'.repeat(88)}]})];}});
  await ui.app.claimFees(ID);assert.equal(reads,1);assert.match(ui.get('tokens-list').textContent,/Claim complete/);assert.equal(ui.document.querySelector('.token-claim-receipt').getAttribute('href'),'https://solscan.io/tx/'+'6'.repeat(88));assert.match(ui.get('tokens-claim-summary').textContent,/1 claim complete/);
  const mutation=ui.calls.find(row=>row.path==='/api/launchpad/action');assert.equal(mutation.options.method,'POST');assert.equal(mutation.options.headers['x-control-token'],'account-csrf');
});
test('legacy external fee claims connect and sign on the token page, then wait for the receipt',async t=>{
  const pending={operationId:'op-one',kind:'claim',wallet:WALLET,transaction:'YWJj'},base=launch({walletMode:'external',feeClaim:{available:true,busy:false,wallet:WALLET,requiresSignature:true,scope:'wallet_quote'}});let rows=[base],address='',signed=0;
  const ui=await page(t,{id:ID,rows:()=>rows,walletFactory:()=>({state:()=>({address,wallets:[{id:'wallet',name:'Test wallet'}]}),onChange:()=>()=>{},connect:async()=>({address:address=WALLET}),sign:async request=>{assert.equal(request.wallet,WALLET);signed++;return 'signed-by-wallet';},dispose:()=>{}}),respond:(path,options)=>{
    if(path==='/api/launchpad/action'){rows=[{...base,state:'awaiting_signature',feesRequested:true,pendingSignature:pending}];return rows[0];}
    if(path==='/api/launchpad/signature')return rows[0];
    if(path==='/api/launchpad/sign'){assert.equal(JSON.parse(options.body).transaction,'signed-by-wallet');rows=[{...base,state:'live',feesRequested:false,lastCycle:1700000200000,operations:[{kind:'claim',state:'confirmed',signature:SIGNATURE}]}];return rows[0];}
  }});
  const task=ui.app.claimFees(ID);await flush();assert.equal(ui.app.canLeave(),false);assert.equal(ui.get('tokens-wallet-dialog').open,true);await ui.get('tokens-wallet-options').querySelector('button').onclick();await task;assert.equal(ui.app.canLeave(),true);assert.equal(signed,1);assert.match(ui.get('token-claim-detail').textContent,/Claim complete/);assert.match(ui.get('token-claim-detail').textContent,/other coins paired/);assert.equal(ui.calls.filter(row=>row.path==='/api/launchpad/sign').length,1);
});
test('claim all reports per-item failure, preserves successful claims, and never queues managed rewards on the client',async t=>{
  const first=launch(),second=launch({id:DRAFT}),managed=launch({id:FAILED,input:{...launch().input,feeMode:'buyback'}});let rows=[first,second,managed];
  const ui=await page(t,{rows:()=>rows,respond:path=>{
    if(path==='/api/launchpad/fees/claim-all'){rows=[{...first,feesRequested:true},{...second,state:'error',error:'Claim account needs SOL.'},managed];return {launches:rows,queued:[ID,DRAFT],active:[],skipped:[{id:FAILED,reason:'Managed rewards.'}]};}
  },claimWait:async()=>{rows=[{...first,feesRequested:false,lastCycle:1700000200000,lastFeeClaim:{result:'empty'}},rows[1],managed];}});
  await ui.app.claimFees();assert.match(ui.get('tokens-claim-summary').textContent,/1 claim complete · 1 needs attention/);assert.match(ui.get('tokens-list').textContent,/No unclaimed creator fees/);assert.match(ui.get('tokens-list').textContent,/Claim account needs SOL/);assert.equal(ui.calls.filter(row=>row.path==='/api/launchpad/action').length,0);
});

test('zero-refund drafts show the actual recovery reason and link only safely reusable attempts',async t=>{
  const ui=await page(t,{rows:[launch({state:'failed',curve:null,operations:[],canReuseDraft:true,recovery:{status:'complete',refundedLamports:'0',reason:'Unused funds remain in the original paying wallet.'}})]});
  ui.document.querySelector('[data-launch-filter="drafts"]').onclick();assert.match(ui.get('tokens-list').textContent,/Unused funds remain in the original paying wallet/);assert.doesNotMatch(ui.get('tokens-list').textContent,/No unused setup SOL remained/);assert.equal([...ui.get('tokens-list').querySelectorAll('a')].find(a=>a.textContent==='Edit and try again').getAttribute('href'),'/launchpad?reuse='+ID);
});

test('holder token details use configured hourly minimum and collected credits, with trusted custom quote symbol',async t=>{
  const row=launch({input:{...launch().input,feeMode:'holders',quoteMint:'9'.repeat(44)},autoFees:true,holderRewards:{intervalMinutes:60,minimumQuote:'0.3',pendingQuote:'0.02',quoteSymbol:'SV151',nextCheckAt:1700003700000}});
  const ui=await page(t,{id:ID,rows:[row]});assert.match(ui.get('token-details').textContent,/SV151/);assert.match(ui.get('token-details').textContent,/Hourly · minimum \$100/);assert.match(ui.get('token-details').textContent,/Collected rewards0.02 SV151/);assert.match(ui.get('token-details').textContent,/Next reward check/);
});
test('confirmed creation with verification failure remains launched and exposes the actual reason',async t=>{
  const row=launch({curve:null,state:'error',error:'Launchpad quote mint does not match the saved launch.'});const ui=await page(t,{id:ID,rows:[row]});assert.equal(ui.get('token-launch-state').textContent,'Verification needs attention');assert.match(ui.get('token-launch-note').textContent,/Launchpad quote mint does not match/);assert.equal(ui.get('token-trade').hidden,false);
  const retrying=await page(t,{id:ID,rows:[{...row,retry:{attempt:2,at:1700000110000}}]});assert.equal(retrying.get('token-launch-state').textContent,'Verifying launch');assert.match(retrying.get('token-launch-note').textContent,/retrying verification automatically/);
});

const rewardsLaunch=(patch={})=>launch({input:{...launch().input,feeMode:'holders'},autoFees:true,holderRewards:{intervalMinutes:60,minimumQuote:'1',quoteSymbol:'USDC',pendingQuote:'0.2',totalDistributedQuote:'3',totalPayments:2,unconvertedTaxTokens:'15',nextCheckAt:1700003700000,lastDistributionAt:1700000000000,lastDistributionQuote:'3'},...patch});
const rewardsDashboard=row=>({launchId:row.id,mint:row.mint,asOf:1700000100000,stale:false,refreshMs:30000,schedule:row.holderRewards,wallet:{address:WALLET,quoteBalance:'40',quoteSymbol:'USDC',unconvertedTaxTokens:'99',nativeSol:'0.3'},earned:{quote:row.holderRewards.pendingQuote,unconvertedTaxTokens:row.holderRewards.unconvertedTaxTokens},totals:{distributedQuote:row.holderRewards.totalDistributedQuote,payments:row.holderRewards.totalPayments,lastDistributionAt:row.holderRewards.lastDistributionAt,lastDistributionQuote:row.holderRewards.lastDistributionQuote},taxes:{withheldTokens:null,availableAfterGraduation:false,note:'Unclaimed transfer fees are not included.'}});
test('holder rewards box separates earned credits from wallet deposits and displays only verified quote totals',async t=>{
  const row=rewardsLaunch();const ui=await page(t,{id:ID,rows:[row],respond:path=>path.startsWith('/api/launchpad/rewards?')?rewardsDashboard(row):undefined});
  assert.equal(ui.get('token-rewards').hidden,false);assert.equal(ui.get('token-claim-detail').hidden,true);assert.equal(ui.get('token-rewards-total').textContent,'3 USDC');assert.equal(ui.get('token-rewards-payments').textContent,'2 confirmed holder payments');assert.equal(ui.get('token-rewards-collected').textContent,'0.2 USDC');assert.equal(ui.get('token-rewards-balance').textContent,'40 USDC');assert.equal(ui.get('token-rewards-unconverted').textContent,'15 EXAMPLE');assert.equal(ui.get('token-rewards-wallet').getAttribute('href'),'https://solscan.io/account/'+WALLET);assert.match(ui.get('token-rewards').textContent,/only earned rewards are distributed/);assert.match(ui.get('token-rewards-next').textContent,/minimum · \$100/);assert.doesNotMatch(ui.get('token-rewards').textContent,/1724062|2\.5%/);
});
test('holder dashboards are read-only and never expose an owner distribution action',async t=>{
  const row=rewardsLaunch({autoFees:false}),ui=await page(t,{id:ID,rows:[row],respond:path=>path.startsWith('/api/launchpad/rewards?')?rewardsDashboard(row):undefined});
  assert.equal(ui.get('token-rewards-distribute'),null);assert.equal(ui.app.distributeRewards,undefined);assert.match(ui.get('token-rewards-next').textContent,/\$100/);
  assert.equal(ui.calls.some(c=>c.options.method==='POST'),false);
});
test('partial payout progress uses confirmed totals without claiming the batch completed',async t=>{
  const row=rewardsLaunch({cycle:{stage:'payout'},holderRewards:{...rewardsLaunch().holderRewards,totalDistributedQuote:'3.1',totalPayments:3,lastDistributionAt:1700000200000}});
  const ui=await page(t,{id:ID,rows:[row],respond:path=>path.startsWith('/api/launchpad/rewards?')?rewardsDashboard(row):undefined});
  assert.equal(ui.get('token-rewards-total').textContent,'3.1 USDC');assert.match(ui.get('token-rewards-last').textContent,/Latest confirmed payout/);assert.doesNotMatch(ui.get('token-rewards').textContent,/Rewards distributed/);
});
test('reward RPC failure and mismatched dashboard responses never become zero balances or another coin totals',async t=>{
  const row=rewardsLaunch();const ui=await page(t,{id:ID,rows:[row],respond:path=>path.startsWith('/api/launchpad/rewards?')?{...rewardsDashboard(row),stale:true,asOf:null,error:'Distribution wallet temporarily unavailable.',wallet:{address:WALLET,quoteBalance:null,quoteSymbol:'USDC'}}:undefined});
  assert.equal(ui.get('token-rewards-balance').textContent,'—');assert.equal(ui.get('token-rewards-collected').textContent,'0.2 USDC');assert.match(ui.get('token-rewards-data-note').textContent,/temporarily unavailable/);const before=ui.calls.filter(c=>c.path.startsWith('/api/launchpad/rewards?')).length;await ui.app.refreshRewards(true);assert.equal(ui.calls.filter(c=>c.path.startsWith('/api/launchpad/rewards?')).length,before);
  const other=await page(t,{id:ID,rows:[row],respond:path=>path.startsWith('/api/launchpad/rewards?')?{...rewardsDashboard(row),launchId:DRAFT,totals:{distributedQuote:'9999'}}:undefined});assert.equal(other.get('token-rewards-balance').textContent,'—');assert.match(other.get('token-rewards-data-note').textContent,/does not match/);assert.doesNotMatch(other.get('token-rewards').textContent,/9999/);
});
test('only confirmed holder launches read the dashboard and hidden pages stop its background polling',async t=>{
  const creator=await page(t,{id:ID});assert.equal(creator.get('token-rewards').hidden,true);assert.equal(creator.calls.some(c=>c.path.startsWith('/api/launchpad/rewards?')),false);assert.equal(creator.calls.some(c=>c.options.method==='POST'),false);
  const draft=await page(t,{id:ID,rows:[rewardsLaunch({curve:null,state:'draft',operations:[]})]});assert.equal(draft.get('token-rewards').hidden,true);assert.equal(draft.calls.some(c=>c.path.startsWith('/api/launchpad/rewards?')),false);
  const holder=await page(t,{id:ID,rows:[rewardsLaunch()]});holder.document.hidden=true;const before=holder.calls.length;await holder.tick(60000);assert.equal(holder.calls.length,before);
});

test('observed withheld transfer fees remain separate from collected credits and use verified withdrawal authority',async t=>{
  const row=rewardsLaunch();const ui=await page(t,{id:ID,rows:[row],respond:path=>path.startsWith('/api/launchpad/rewards?')?{...rewardsDashboard(row),taxes:{withheldTokens:'1250',claimableNow:true,stale:false,asOf:1700000100000,note:'Observed withheld fees.'}}:undefined});
  assert.equal(ui.get('token-rewards-withheld').textContent,'1,250 EXAMPLE');assert.match(ui.get('token-rewards-withheld-note').textContent,/Ready to collect/);assert.doesNotMatch(ui.get('token-rewards-withheld-note').textContent,/after graduation/);assert.equal(ui.get('token-rewards-unconverted').textContent,'15 EXAMPLE');assert.equal(ui.get('token-rewards-collected').textContent,'0.2 USDC');
  const stale=await page(t,{id:ID,rows:[row],respond:path=>path.startsWith('/api/launchpad/rewards?')?{...rewardsDashboard(row),taxes:{withheldTokens:'1250',claimableNow:null,stale:true,asOf:1700000000000,error:'Transfer fee balances are delayed.'}}:undefined});assert.match(stale.get('token-rewards-withheld-note').textContent,/Last observed amount/);assert.match(stale.get('token-rewards-withheld-note').textContent,/not verified/);
});

test('unclaimed LaunchLab fees appear separately from collected credits and exclude pool-fee totals',async t=>{
  const row=rewardsLaunch({feeCustody:'relay'});const ui=await page(t,{id:ID,rows:[row],respond:path=>path.startsWith('/api/launchpad/rewards?')?{...rewardsDashboard(row),unclaimedCreatorQuote:'12.375',unclaimedCreatorScope:'curve',unclaimedCreatorShared:false}:undefined});
  assert.equal(ui.get('token-rewards-curve-fees').textContent,'12.375 USDC');assert.equal(ui.get('token-rewards-collected').textContent,'0.2 USDC');assert.equal(ui.get('token-rewards-balance').textContent,'40 USDC');assert.match(ui.get('token-rewards-curve-fees-note').textContent,/Post-graduation pool fees are not included/);assert.doesNotMatch(ui.get('token-rewards-curve-fees-note').textContent,/share a fee vault/);
  const legacy=await page(t,{id:ID,rows:[rewardsLaunch()],respond:path=>path.startsWith('/api/launchpad/rewards?')?{...rewardsDashboard(row),stale:true,unclaimedCreatorQuote:'12.375',unclaimedCreatorScope:'curve',unclaimedCreatorShared:true}:undefined});assert.match(legacy.get('token-rewards-curve-fees-note').textContent,/Last observed/);assert.match(legacy.get('token-rewards-curve-fees-note').textContent,/share a fee vault/);
  const unavailable=await page(t,{id:ID,rows:[row],respond:path=>path.startsWith('/api/launchpad/rewards?')?{...rewardsDashboard(row),unclaimedCreatorQuote:null}:undefined});assert.equal(unavailable.get('token-rewards-curve-fees').textContent,'—');
});


test('tax queue shows paced sale limits and the next eligible conversion without changing hourly payout terms',async t=>{
  const row=rewardsLaunch({input:{...launch().input,feeMode:'holders',taxBps:400}});
  row.holderRewards.taxConversion={enabled:true,intervalMinutes:5,maxTokens:'1000000',maxPriceImpactBps:50,maxReserveBps:25,nextAt:1700000400000,lastAt:1700000100000};
  const ui=await page(t,{id:ID,rows:[row],respond:path=>path.startsWith('/api/launchpad/rewards?')?rewardsDashboard(row):undefined});
  assert.equal(ui.get('token-rewards-unconverted').textContent,'15 EXAMPLE');assert.match(ui.get('token-rewards-conversion-note').textContent,/at least 5 minutes apart/);assert.match(ui.get('token-rewards-conversion-note').textContent,/1,000,000 EXAMPLE per sale/);assert.match(ui.get('token-rewards-conversion-note').textContent,/capped at 0.5%/);assert.equal(ui.get('token-rewards-conversion-next').hidden,false);assert.match(ui.get('token-rewards-conversion-next').textContent,/Next conversion eligible/);assert.match(ui.get('token-rewards-next').textContent,/Hourly minimum/);assert.equal(ui.get('token-rewards-distribute'),null);
  const taxRow=[...ui.get('token-details').children].find(node=>node.textContent.includes('Transfer tax'));assert.match(taxRow.textContent,/4%/);
});

test('tax conversion schedule supports percentage limits and never shows a scheduled sale while paused',async t=>{
  const row=rewardsLaunch();row.holderRewards.taxConversion={enabled:true,intervalMinutes:5,maximumSupplyPercent:0.1,maximumPriceImpactPercent:0.5,nextCheckAt:1700000400000};
  const ui=await page(t,{id:ID,rows:[row],respond:path=>path.startsWith('/api/launchpad/rewards?')?rewardsDashboard(row):undefined});assert.match(ui.get('token-rewards-conversion-note').textContent,/0.1% of supply/);assert.match(ui.get('token-rewards-conversion-note').textContent,/0.5%/);assert.match(ui.get('token-rewards-conversion-next').textContent,/Next conversion eligible/);
  const paused=await page(t,{id:ID,rows:[{...row,autoFees:false}],respond:path=>path.startsWith('/api/launchpad/rewards?')?rewardsDashboard(row):undefined});assert.match(paused.get('token-rewards-conversion-next').textContent,/conversions paused/);assert.doesNotMatch(paused.get('token-rewards-conversion-next').textContent,/Next conversion eligible/);
});

test('official tax-burn owner view preserves SOL rewards and shows the separate initial inventory approval',async t=>{
  const row=rewardsLaunch({input:{...launch().input,feeMode:'holders',taxBps:200,symbol:'LAUNCHPAD'}});
  row.holderRewards={...row.holderRewards,quoteSymbol:'SOL',unconvertedTaxTokens:null,taxBurn:{selected:true,enabled:true,paused:false,tokensBurned:'5',pendingTaxTokens:'15',unattributedTokens:'10',completedBurns:1,lastBurnSignature:SIGNATURE,initialInventory:{approvedTokens:'41234567.890123',status:'authorized'}}};
  const ui=await page(t,{id:ID,rows:[row],respond:path=>path.startsWith('/api/launchpad/rewards?')?rewardsDashboard(row):undefined});
  assert.equal(ui.get('token-rewards-unconverted').textContent,'15 LAUNCHPAD');assert.match(ui.get('token-rewards-unconverted').parentElement.textContent,/Collected tax awaiting burn/);assert.match(ui.get('token-rewards-conversion-note').textContent,/initial inventory approved for one burn/);assert.match(ui.get('token-rewards-conversion-note').textContent,/existing owed SOL remains payable/);assert.doesNotMatch(ui.get('token-rewards-conversion-note').textContent,/Small sales|price impact|10 LAUNCHPAD other/);assert.equal(ui.get('token-rewards-collected').textContent,'0.2 SOL');assert.equal(ui.get('token-rewards-conversion-next').querySelector('a').href,'https://solscan.io/tx/'+SIGNATURE);assert.equal(ui.calls.some(call=>call.options.method==='POST'),false);
  row.holderRewards.taxBurn.paused=true;await ui.app.refreshRewards(true);assert.match(ui.get('token-rewards-conversion-next').textContent,/paused.*not sold/);
});

const buybackLaunch=(patch={})=>launch({input:{...launch().input,feeMode:'buyback'},autoFees:true,...patch});
const buybackDashboard=(patch={})=>({mint:MINT,mode:'buyback',enabled:true,status:'enabled',quote:{mint:QUOTE,symbol:'USDC',decimals:6},tokenSymbol:'EXAMPLE',taxBps:0,asOf:1700000100000,refreshMs:30000,stale:false,error:'',holder:null,buyback:{totalQuoteSpent:'12.25',tokensBought:'10000',tokensBurned:'7500',completedBuys:3,completedBurns:2,pendingOperations:0,pendingQuote:'1.25',pendingBurnTokens:'2500',totalClaimedQuote:'13.5',totalClaimedTokens:'0',unclaimedCreatorQuote:'2',unclaimedScope:'curve',lastBuybackAt:1700000000000,buybackPercent:100,intervalMinutes:1,historyComplete:true,historyNote:''},...patch});
test('owned buyback token page displays the shared public confirmed metrics without holder or claim actions',async t=>{
  const ui=await page(t,{id:ID,rows:[buybackLaunch()],respond:path=>path.startsWith('/api/explore/rewards?')?buybackDashboard():undefined});
  assert.equal(ui.get('token-buyback').hidden,false);assert.equal(ui.get('token-rewards').hidden,true);assert.equal(ui.get('token-claim-detail').hidden,true);
  const metric=key=>ui.get('token-buyback').querySelector(`[data-reward-metric="${key}"] strong`);
  assert.equal(metric('completed').title,'12.25 USDC');assert.equal(metric('burned').title,'7500 EXAMPLE');assert.equal(metric('pending').title,'1.25 USDC');assert.match(ui.get('token-buyback').textContent,/3 confirmed buys/);assert.doesNotMatch(ui.get('token-buyback').textContent,/\$|Distribute now|Claim creator fees/);
  assert.equal(ui.get('token-buyback-state').textContent,'Enabled');
  const request=ui.calls.find(call=>call.path.startsWith('/api/explore/rewards?'));assert.equal(request.path,'/api/explore/rewards?mint='+MINT);assert.equal(request.options.method,'GET');assert.equal(request.options.credentials,'omit');assert.equal(request.options.headers['x-control-token'],undefined);
  const count=()=>ui.calls.filter(call=>call.path.startsWith('/api/explore/rewards?')).length;assert.equal(count(),1);await ui.tick(29999);assert.equal(count(),1);await ui.tick(1);assert.equal(count(),2);ui.document.hidden=true;await ui.tick(30000);assert.equal(count(),2);
});
test('buyback statistics never display another mint or quote, and failures remain unknown',async t=>{
  for(const patch of [{mint:POOL},{quote:{mint:MINT,symbol:'SOL'}},{mode:'holders'}]){
    const ui=await page(t,{id:ID,rows:[buybackLaunch()],respond:path=>path.startsWith('/api/explore/rewards?')?buybackDashboard(patch):undefined});
    assert.match(ui.get('token-buyback-note').textContent,/does not match/);assert.equal(ui.get('token-buyback').querySelector('[data-reward-metric="completed"] strong').textContent,'—');
    const before=ui.calls.length;await ui.app.refreshBuyback(true);assert.equal(ui.calls.length,before,'error backoff also limits manual refresh');
  }
});
test('buyback reads stay off other modes and drafts, and dispose aborts a pending public read',async t=>{
  const creator=await page(t,{id:ID});assert.equal(creator.get('token-buyback').hidden,true);assert.equal(creator.calls.some(call=>call.path.startsWith('/api/explore/rewards?')),false);
  const holder=await page(t,{id:ID,rows:[rewardsLaunch()]});assert.equal(holder.get('token-buyback').hidden,true);assert.equal(holder.calls.some(call=>call.path.startsWith('/api/explore/rewards?')),false);
  const draft=await page(t,{id:ID,rows:[buybackLaunch({state:'draft',curve:null,operations:[]})]});assert.equal(draft.get('token-buyback').hidden,true);assert.equal(draft.calls.some(call=>call.path.startsWith('/api/explore/rewards?')),false);
  let resolve,signal;const pending=new Promise(done=>{resolve=done;});const ui=await page(t,{id:ID,rows:[buybackLaunch()],respond:(path,options)=>{if(path.startsWith('/api/explore/rewards?')){signal=options.signal;return pending;}}});
  assert.equal(signal.aborted,false);ui.app.destroy();assert.equal(signal.aborted,true);resolve(buybackDashboard());await flush();assert.equal(ui.get('token-buyback').querySelector('[data-reward-metric="completed"] strong').textContent,'—');
});
test('switching the saved token mode invalidates an in-flight buyback response',async t=>{
  let rows=[buybackLaunch()],resolve,signal;const pending=new Promise(done=>{resolve=done;});const ui=await page(t,{id:ID,rows:()=>rows,respond:(path,options)=>{if(path.startsWith('/api/explore/rewards?')){signal=options.signal;return pending;}}});
  rows=[launch()];await ui.app.refreshList(true);assert.equal(signal.aborted,true);assert.equal(ui.get('token-buyback').hidden,true);resolve(buybackDashboard());await flush();assert.equal(ui.get('token-buyback').hidden,true);assert.equal(ui.get('token-buyback').querySelector('[data-reward-metric="completed"] strong').textContent,'—');
});


test('signing in on the owned launches page opens the list in place with the new session token',async t=>{
  const ui=await page(t,{authenticated:false});
  const session={authenticated:true,token:'signed-in-csrf',account:{id:'creator-one',username:'creator_one'}};
  ui.document.dispatchEvent(new ui.window.CustomEvent('curve-account-updated',{detail:session}));await flush();await flush();
  assert.equal(ui.get('tokens-gate').hidden,true);assert.equal(ui.get('tokens-main').hidden,false);
  assert.equal(ui.document.querySelectorAll('.token-launch-card').length,1);
  assert.equal(ui.calls.find(call=>call.path==='/api/launchpad').options.headers['x-control-token'],'signed-in-csrf');
  const before=ui.calls.length;
  ui.document.dispatchEvent(new ui.window.CustomEvent('curve-account-updated',{detail:{...session,token:'renewed-csrf',account:{...session.account,username:'updated_creator'}}}));await flush();
  assert.equal(ui.calls.length,before);assert.match(ui.get('token-creator').textContent,/updated_creator/);
  assert.equal(ui.get('token-creator').querySelector('a').getAttribute('href'),'/user/updated_creator');
  await ui.app.refreshList(true);assert.equal(ui.calls.at(-1).options.headers['x-control-token'],'renewed-csrf');
});

test('a slow initial guest session cannot undo an in-place sign-in',async t=>{
  let resolveSession;const pending=new Promise(resolve=>{resolveSession=resolve;});
  const ui=await page(t,{sessionResponse:()=>pending,beforeReady:async({document,window})=>{
    document.dispatchEvent(new window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'fresh-csrf',account:{id:'creator-two',username:'creator_two'}}}));
    await flush();resolveSession({authenticated:false});
  }});
  assert.equal(ui.get('tokens-gate').hidden,true);assert.equal(ui.get('tokens-main').hidden,false);
  assert.match(ui.get('token-creator').textContent,/creator_two/);assert.equal(ui.document.querySelectorAll('.token-launch-card').length,1);
  assert.equal(ui.calls.filter(call=>call.path==='/api/launchpad').length,1);
});

test('late launch lists from the previous account cannot replace the newly signed-in account',async t=>{
  let resolveOld,hold=false;
  const oldRow=launch({input:{...launch().input,name:'Private prior launch'}}),newRow=launch({id:DRAFT,input:{...launch().input,name:'New account launch'}});
  const ui=await page(t,{listResponse:options=>options.headers['x-control-token']==='new-account-csrf'?{launches:[newRow]}:hold?new Promise(resolve=>{resolveOld=resolve;}):{launches:[oldRow]}});
  assert.match(ui.get('tokens-list').textContent,/Private prior launch/);hold=true;const prior=ui.app.refreshList(true);
  ui.document.dispatchEvent(new ui.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'new-account-csrf',account:{id:'different-account',username:'new_creator'}}}));
  assert.doesNotMatch(ui.get('tokens-list').textContent,/Private prior launch/);
  await flush();resolveOld({launches:[oldRow]});await prior;await flush();
  assert.match(ui.get('tokens-list').textContent,/New account launch/);assert.doesNotMatch(ui.get('tokens-list').textContent,/Private prior launch/);
  assert.equal(ui.get('tokens-error').hidden,true);
});

test('changing accounts while a creator claim waits for wallet approval never submits the old claim',async t=>{
  const base=launch({walletMode:'external',feeClaim:{available:true,busy:false,wallet:WALLET,requiresSignature:true,scope:'wallet_quote'}});
  let rows=[base];const ui=await page(t,{rows:()=>rows,walletFactory:()=>({state:()=>({address:'',wallets:[{id:'wallet',name:'Test wallet'}]}),onChange:()=>()=>{},connect:async()=>({address:WALLET}),sign:async()=>{throw Error('Must not sign an old account claim.');}})});
  const claim=ui.app.claimFees(ID);await flush();assert.equal(ui.app.canLeave(),false);assert.equal(ui.get('tokens-wallet-dialog').open,true);
  rows=[];ui.document.dispatchEvent(new ui.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'different-csrf',account:{id:'different-owner',username:'different_owner'}}}));
  await claim;await flush();assert.equal(ui.get('tokens-wallet-dialog').open,false);
  assert.equal(ui.calls.some(call=>call.options.method==='POST'),false);
  assert.equal(ui.get('tokens-claim-summary').hidden,true);assert.equal(ui.document.querySelectorAll('.token-launch-card').length,0);
});

test('archived requests and hidden coins share their own owner section',async t=>{
  const draft=launch({id:DRAFT,state:'failed',curve:null,operations:[],listArchived:true,manuallyArchived:true,canRestore:true,recovery:{status:'checking'}}),hidden=launch({id:FAILED,hidden:true,listArchived:true,canRestore:false});
  const ui=await page(t,{rows:[launch(),draft,hidden]});
  assert.equal(ui.get('tokens-count-launched').textContent,'1');assert.equal(ui.get('tokens-count-drafts').textContent,'0');assert.equal(ui.get('tokens-count-archived').textContent,'2');
  assert.equal(ui.document.querySelectorAll('.token-launch-card').length,1);
  ui.document.querySelector('[data-launch-filter="archived"]').onclick();
  assert.equal(ui.document.querySelectorAll('.token-launch-card').length,2);assert.match(ui.get('tokens-list').textContent,/Archived/);assert.match(ui.get('tokens-list').textContent,/Hidden/);assert.match(ui.get('tokens-list').textContent,/Checking unused setup funds/);
  assert.equal(ui.document.querySelector(`[data-archive-for="${DRAFT}"]`).textContent,'Restore');assert.equal(ui.document.querySelector(`[data-archive-for="${FAILED}"]`),null);
});

test('archive deep links open saved requests with recovery and details still available',async t=>{
  const row=launch({state:'failed',curve:null,operations:[],listArchived:true,manuallyArchived:true,canRestore:true,recovery:{status:'complete',refundedLamports:'1000000',refundWallet:WALLET}});
  const list=await page(t,{view:'archived',rows:[row]});
  assert.equal(list.document.querySelector('[data-launch-filter="archived"]').getAttribute('aria-pressed'),'true');assert.equal(list.document.querySelector('.token-card-link').textContent,'View details →');
  const detail=await page(t,{id:ID,rows:[row]});assert.equal(detail.get('tokens-detail-view').hidden,false);assert.equal(detail.get('token-launch-state').textContent,'Archived');assert.match(detail.get('token-archive-detail').textContent,/0.001 SOL returned/);assert.match(detail.get('token-archive-detail').textContent,/Restore/);assert.equal(detail.get('token-manage').getAttribute('href'),'/launchpad?id='+ID);
});

test('owner archive and restore use one authenticated metadata write and update section counts',async t=>{
  let row=launch({state:'failed',curve:null,operations:[],canArchive:true});
  const ui=await page(t,{rows:()=>[row],respond:(path,options)=>{if(path==='/api/launchpad/archive'){const body=JSON.parse(options.body);assert.equal(body.id,ID);row={...row,listArchived:body.archived,manuallyArchived:body.archived,canArchive:!body.archived,canRestore:body.archived};return row;}}});
  ui.document.querySelector('[data-launch-filter="drafts"]').onclick();await ui.document.querySelector('[data-archive-for]').onclick();
  assert.equal(ui.get('tokens-count-drafts').textContent,'0');assert.equal(ui.get('tokens-count-archived').textContent,'1');assert.equal(ui.document.querySelectorAll('.token-launch-card').length,0);
  ui.document.querySelector('[data-launch-filter="archived"]').onclick();await ui.document.querySelector('[data-archive-for]').onclick();
  assert.equal(ui.get('tokens-count-drafts').textContent,'1');assert.equal(ui.get('tokens-count-archived').textContent,'0');
  const writes=ui.calls.filter(call=>call.path==='/api/launchpad/archive');assert.equal(writes.length,2);assert.deepEqual(writes.map(call=>JSON.parse(call.options.body)),[{id:ID,archived:true},{id:ID,archived:false}]);assert(writes.every(call=>call.options.method==='POST'&&call.options.headers['x-control-token']==='account-csrf'));
  assert.equal(ui.calls.filter(call=>call.path==='/api/launchpad/action').length,0);
});

test('duplicate archive clicks are blocked and late list responses cannot undo the saved archive',async t=>{
  const initial=launch({state:'failed',curve:null,operations:[],canArchive:true});let hold=false,resolveList,resolveArchive;
  const ui=await page(t,{rows:[initial],listResponse:()=>hold?new Promise(resolve=>{resolveList=resolve;}):{launches:[initial]},respond:path=>path==='/api/launchpad/archive'?new Promise(resolve=>{resolveArchive=resolve;}):undefined});
  hold=true;const list=ui.app.refreshList(true);await flush();const archive=ui.app.archiveLaunch(ID,true);await flush();assert.equal(ui.app.canLeave(),false);await ui.app.archiveLaunch(ID,true);
  assert.equal(ui.calls.filter(call=>call.path==='/api/launchpad/archive').length,1);
  resolveArchive({...initial,listArchived:true,canArchive:false,canRestore:true});await archive;assert.equal(ui.app.canLeave(),true);resolveList({launches:[initial]});await list;
  assert.equal(ui.get('tokens-count-archived').textContent,'1');assert.equal(ui.get('tokens-count-drafts').textContent,'0');
});

test('archive failures keep the request in its original section and restore its button',async t=>{
  const ui=await page(t,{rows:[launch({state:'failed',curve:null,operations:[],canArchive:true})],respond:path=>path==='/api/launchpad/archive'?{status:409,body:{error:'This launch is still confirming.'}}:undefined});
  ui.document.querySelector('[data-launch-filter="drafts"]').onclick();await ui.document.querySelector('[data-archive-for]').onclick();
  assert.equal(ui.get('tokens-count-drafts').textContent,'1');assert.equal(ui.get('tokens-count-archived').textContent,'0');assert.match(ui.get('tokens-error').textContent,/still confirming/);assert.equal(ui.document.querySelector('[data-archive-for]').disabled,false);
});

test('hidden launches cannot be restored by owner controls and retain creator claims',async t=>{
  const row=launch({listArchived:true,hidden:true,canRestore:true});
  const ui=await page(t,{view:'archived',rows:[row]});assert.equal(ui.document.querySelector('[data-archive-for]'),null);assert.equal(ui.get('tokens-claim-all').disabled,false);await ui.app.archiveLaunch(ID,false);assert.equal(ui.calls.some(call=>call.path==='/api/launchpad/archive'),false);
  const detail=await page(t,{id:ID,rows:[row]});assert.equal(detail.get('token-launch-state').textContent,'Hidden');assert.equal(detail.get('token-archive-detail').querySelector('button'),null);assert.equal(detail.get('token-claim-detail').hidden,false);
});

test('claim all still includes creator fees from the archived section',async t=>{
  const first=launch(),hidden=launch({id:DRAFT,listArchived:true,hidden:true});let rows=[first,hidden];
  const ui=await page(t,{rows:()=>rows,respond:path=>{if(path==='/api/launchpad/fees/claim-all'){rows=rows.map(row=>({...row,feesRequested:true}));return {launches:rows,queued:[ID,DRAFT],active:[],skipped:[]};}},claimWait:async()=>{rows=rows.map(row=>({...row,feesRequested:false,lastCycle:1700000200000,lastFeeClaim:{result:'empty'}}));}});
  await ui.app.claimFees();assert.match(ui.get('tokens-claim-summary').textContent,/2 claims complete/);assert.equal(ui.get('tokens-count-launched').textContent,'1');assert.equal(ui.get('tokens-count-archived').textContent,'1');ui.document.querySelector('[data-launch-filter="archived"]').onclick();assert.match(ui.get('tokens-list').textContent,/No unclaimed creator fees/);
});

test('an archive response from a previous account cannot populate the new account',async t=>{
  const initial=launch({state:'failed',curve:null,operations:[],canArchive:true});let resolveArchive,rows=[initial];
  const ui=await page(t,{rows:()=>rows,respond:path=>path==='/api/launchpad/archive'?new Promise(resolve=>{resolveArchive=resolve;}):undefined});
  const task=ui.app.archiveLaunch(ID,true);await flush();rows=[];
  ui.document.dispatchEvent(new ui.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'different-csrf',account:{id:'different-owner'}}}));await flush();
  resolveArchive({...initial,listArchived:true,canRestore:true});await task;await flush();assert.equal(ui.get('tokens-count-archived').textContent,'0');assert.equal(ui.get('tokens-count-drafts').textContent,'0');assert.equal(ui.get('tokens-error').hidden,true);assert.equal(ui.document.querySelector('[data-archive-for]'),null);
});

test('archived launch history preserves transaction states and safe receipt links',async t=>{
 const row=launch({state:'failed',curve:null,listArchived:true,manuallyArchived:true,canRestore:true,operations:[{kind:'setup',state:'confirmed',signature:SIGNATURE},{kind:'setup-refund',state:'pending',signature:'6'.repeat(88)},{kind:'create',state:'failed',signature:'javascript:bad()',error:'<img onerror=bad>'}]});
 const ui=await page(t,{id:ID,rows:[row]});assert.equal(ui.get('token-back').getAttribute('href'),'/launched-tokens?view=archived');assert.match(ui.get('token-launch-history').textContent,/setup refund · pending/);assert.equal(ui.get('token-launch-history').querySelectorAll('a').length,2);assert.equal(ui.get('token-launch-history').querySelector('a').getAttribute('href'),'https://solscan.io/tx/'+SIGNATURE);assert.equal(ui.get('token-launch-history').querySelector('img'),null);assert.match(ui.get('token-launch-history').textContent,/<img onerror=bad>/);
});

test('signing out clears archive controls and ignores an in-flight archive response',async t=>{
 const row=launch({state:'failed',curve:null,operations:[],canArchive:true});let resolveArchive;
 const ui=await page(t,{id:ID,rows:[row],respond:path=>path==='/api/launchpad/archive'?new Promise(resolve=>{resolveArchive=resolve;}):undefined});
 const task=ui.app.archiveLaunch(ID,true);await flush();ui.document.dispatchEvent(new ui.window.CustomEvent('curve-account-updated',{detail:{authenticated:false}}));await flush();
 assert.equal(ui.get('tokens-main').hidden,true);assert.equal(ui.get('tokens-gate').hidden,false);assert.equal(ui.get('token-archive-detail').childNodes.length,0);resolveArchive({...row,listArchived:true,canRestore:true});await task;assert.equal(ui.get('tokens-main').hidden,true);assert.equal(ui.get('token-name').textContent,'');assert.equal(ui.get('tokens-error').hidden,true);
});

test('assigned fee cards remain private and separate from ownership, public creator attribution and claim-all',async t=>{
 const ui=await page(t,{respond:path=>path==='/api/launchpad/fee-assignments'?assignedResponse([feeAssignment()]):undefined});
 assert.equal(ui.get('assigned-fees').hidden,false);assert.match(ui.get('assigned-fees').textContent,/Fees assigned to you/);assert.match(ui.get('assigned-fees').textContent,/private list/);
 assert.equal(ui.get('tokens-count-launched').textContent,'1');assert.equal(ui.document.querySelectorAll('.token-launch-card').length,1);assert.equal(ui.document.querySelectorAll('.assigned-fee-card').length,1);
 assert.equal(ui.get('tokens-list').textContent.includes('ASSIGNED'),false);assert.equal(ui.get('token-creator').textContent.includes('original_creator'),false);
 const card=ui.document.querySelector('.assigned-fee-card');assert.equal(card.querySelectorAll('button').length,1);assert.equal(card.querySelector('[data-archive-for],[data-claim-for]'),null);assert.equal(card.querySelector('.token-card-link').getAttribute('href'),'/coin?mint='+POOL);assert.equal(card.querySelector('a[href^="/user/"],a[href^="/launchpad"],a[href^="/launched-tokens"]'),null);
 assert.match(card.textContent,/Paired withUSDC/);assert.match(card.textContent,/Collected awaiting payout1\.234567 USDC/);assert.match(card.textContent,/Receiving wallet/);assert.equal(ui.get('tokens-claim-all').textContent,'Claim fees from your launches');
 await ui.app.archiveLaunch(ASSIGNED_ID,true);assert.equal(ui.calls.some(call=>call.path==='/api/launchpad/archive'),false);
});

test('recipient claims queue once without wallet approval and show confirmed completion using only narrow request fields',async t=>{
 let row=feeAssignment(),resolveClaim,walletCalls=0;
 const ui=await page(t,{rows:[],walletFactory:()=>{walletCalls++;throw Error('Recipient claims must not ask for a wallet signature');},respond:path=>path==='/api/launchpad/fee-assignments'?assignedResponse([row]):path==='/api/launchpad/fee-assignments/claim'?new Promise(resolve=>{resolveClaim=resolve;}):undefined});
 assert.equal(ui.get('tokens-claim-all').disabled,true);const first=ui.app.claimAssignedFees(ASSIGNED_OWNER,ASSIGNED_ID);await flush();assert.equal(ui.app.canLeave(),false);await ui.app.claimAssignedFees(ASSIGNED_OWNER,ASSIGNED_ID);assert.equal(ui.calls.filter(call=>call.path.endsWith('/fee-assignments/claim')).length,1);
 const post=ui.calls.find(call=>call.path.endsWith('/fee-assignments/claim')),body=JSON.parse(post.options.body);assert.deepEqual(Object.keys(body).sort(),['id','ownerAccountId','requestId']);assert.equal(body.ownerAccountId,ASSIGNED_OWNER);assert.equal(body.id,ASSIGNED_ID);assert.match(body.requestId,/^[a-f0-9-]{36}$/);assert.equal(post.options.headers['x-control-token'],'account-csrf');assert.equal(walletCalls,0);
 row=feeAssignment({claim:{available:true,busy:true,status:'queued'}});resolveClaim({assignment:row,alreadyRequested:false});await first;assert.equal(ui.app.canLeave(),true);assert.equal(ui.document.querySelector('[data-assigned-claim]').disabled,true);assert.match(ui.get('assigned-fees').textContent,/Claim queued/);
 row=feeAssignment({lastCycle:101,lastClaimAt:101,lastClaimResult:'claimed',operations:[{state:'confirmed',signature:SIGNATURE}]});await ui.tick(5000);
 assert.match(ui.get('assigned-fees').textContent,/Claim processing completed/);assert.equal(ui.document.querySelector('[data-assigned-claim]').disabled,false);assert.equal(ui.document.querySelector('.assigned-fee-card a[href^="https://solscan.io/tx/"]').getAttribute('href'),'https://solscan.io/tx/'+SIGNATURE);
 assert.equal(ui.calls.some(call=>/\/api\/launchpad\/(action|fees\/claim-all|sign)/.test(call.path)),false);
});

test('uncertain recipient claim retries reuse the same request ID and a later explicit claim starts a new request',async t=>{
 let fail=true;const ui=await page(t,{rows:[],respond:path=>path==='/api/launchpad/fee-assignments'?assignedResponse([feeAssignment()]):path.endsWith('/fee-assignments/claim')?fail?{status:503,body:{error:'Private provider failure'}}:{assignment:feeAssignment(),alreadyRequested:true}:undefined});
 await ui.app.claimAssignedFees(ASSIGNED_OWNER,ASSIGNED_ID);assert.equal(ui.document.querySelector('[data-assigned-claim]').textContent,'Check claim');assert.match(ui.get('assigned-fees').textContent,/same request safely/);assert.equal(ui.get('assigned-fees').textContent.includes('Private provider failure'),false);
 fail=false;await ui.app.claimAssignedFees(ASSIGNED_OWNER,ASSIGNED_ID);await ui.app.claimAssignedFees(ASSIGNED_OWNER,ASSIGNED_ID);
 const requests=ui.calls.filter(call=>call.path.endsWith('/fee-assignments/claim')).map(call=>JSON.parse(call.options.body));assert.equal(requests[0].requestId,requests[1].requestId);assert.notEqual(requests[1].requestId,requests[2].requestId);
});

test('recipient assignment revocation removes stale cards and never grants owner management',async t=>{
 let assigned=true;const ui=await page(t,{respond:path=>path==='/api/launchpad/fee-assignments'?assignedResponse(assigned?[feeAssignment()]:[]):path.endsWith('/fee-assignments/claim')?{status:403,body:{error:'This fee assignment is no longer available.'}}:undefined});
 await ui.app.claimAssignedFees(ASSIGNED_OWNER,ASSIGNED_ID);assert.equal(ui.document.querySelector('.assigned-fee-card'),null);assert.match(ui.get('assigned-fees-status').textContent,/no longer available/);assert.equal(ui.get('tokens-count-launched').textContent,'1');assert.equal(ui.get('tokens-main').hidden,false);
 assigned=false;await ui.get('assigned-fees-refresh').onclick();assert.match(ui.get('assigned-fees').textContent,/No creator fees are currently assigned/);assert.equal(ui.document.querySelector('[data-assigned-claim]'),null);await ui.app.claimAssignedFees(ASSIGNED_OWNER,ASSIGNED_ID);assert.equal(ui.calls.filter(call=>call.path.endsWith('/fee-assignments/claim')).length,1);
});

test('recipient lists require verified wallet sign-in and never load for guests or owned detail views',async t=>{
 const guest=await page(t,{authenticated:false});assert.equal(guest.get('assigned-fees').hidden,true);assert.equal(guest.calls.some(call=>call.path.includes('fee-assignments')),false);
 const detail=await page(t,{id:ID});assert.equal(detail.get('assigned-fees').hidden,true);assert.equal(detail.calls.some(call=>call.path.includes('fee-assignments')),false);
 const manual=await page(t,{respond:path=>path==='/api/launchpad/fee-assignments'?{wallet:null,assignments:[],requiresWalletSignIn:true}:undefined});assert.match(manual.get('assigned-fees').textContent,/Connect the wallet assigned/);assert.equal(manual.document.querySelector('[data-assigned-claim]'),null);
});

test('assigned inventory refreshes every 30 seconds normally and every 5 seconds only while pending',async t=>{
 let row=feeAssignment();const ui=await page(t,{rows:[],respond:path=>path==='/api/launchpad/fee-assignments'?assignedResponse([row]):undefined}),reads=()=>ui.calls.filter(call=>call.path==='/api/launchpad/fee-assignments').length;
 assert.equal(reads(),1);await ui.tick(5000);assert.equal(reads(),1);await ui.tick(24999);assert.equal(reads(),1);await ui.tick(1);assert.equal(reads(),2);
 row=feeAssignment({claim:{available:true,busy:true,status:'pending'}});await ui.app.refreshAssignedFees(true);assert.equal(reads(),3);await ui.tick(4999);assert.equal(reads(),3);await ui.tick(1);assert.equal(reads(),4);
 ui.document.hidden=true;await ui.tick(30000);await ui.app.refreshAssignedFees(true);assert.equal(reads(),4);ui.document.hidden=false;await ui.tick(1);assert.equal(reads(),5);
});

test('assignment read failures disable stale claims, allow refresh and respect provider cooldowns',async t=>{
 let failure=null;const ui=await page(t,{respond:path=>path==='/api/launchpad/fee-assignments'?failure||assignedResponse([feeAssignment()]):undefined});
 failure={status:503,body:{error:'Private RPC URL'}};await ui.app.refreshAssignedFees(true);assert.match(ui.get('assigned-fees-status').textContent,/Refresh fees before claiming/);assert.equal(ui.document.querySelector('[data-assigned-claim]').disabled,true);assert.equal(ui.get('assigned-fees').textContent.includes('Private RPC URL'),false);
 await ui.app.claimAssignedFees(ASSIGNED_OWNER,ASSIGNED_ID);assert.equal(ui.calls.some(call=>call.path.endsWith('/fee-assignments/claim')),false);
 failure=null;await ui.get('assigned-fees-refresh').onclick();assert.equal(ui.document.querySelector('[data-assigned-claim]').disabled,false);
 failure={status:429,body:{error:'Slow down',retryAfterMs:60000}};await ui.app.refreshAssignedFees(true);const before=ui.calls.length;await ui.app.refreshAssignedFees(true);await ui.tick(5000);assert.equal(ui.calls.length,before);failure=null;await ui.tick(55000);assert.equal(ui.document.querySelector('[data-assigned-claim]').disabled,false);
});

test('assigned list and claim responses from a prior account cannot repopulate the new private view',async t=>{
 let pending=false,resolveList,resolveClaim,newAccount=false;const ui=await page(t,{rows:[],respond:path=>path==='/api/launchpad/fee-assignments'?pending?new Promise(resolve=>{resolveList=resolve;}):assignedResponse(newAccount?[]:[feeAssignment()]):path.endsWith('/fee-assignments/claim')?new Promise(resolve=>{resolveClaim=resolve;}):undefined});
 const claim=ui.app.claimAssignedFees(ASSIGNED_OWNER,ASSIGNED_ID);await flush();newAccount=true;
 ui.document.dispatchEvent(new ui.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'new-account-csrf',account:{id:'f'.repeat(32),username:'new_owner'}}}));await flush();await flush();assert.equal(ui.document.querySelector('.assigned-fee-card'),null);
 resolveClaim({assignment:feeAssignment({claim:{available:true,busy:true,status:'queued'}})});await claim;assert.equal(ui.document.querySelector('.assigned-fee-card'),null);
 pending=true;const oldList=ui.app.refreshAssignedFees(true);await flush();ui.document.dispatchEvent(new ui.window.CustomEvent('curve-account-updated',{detail:{authenticated:false}}));assert.equal(ui.get('assigned-fees').hidden,true);assert.equal(ui.get('assigned-fees-list').children.length,0);resolveList(assignedResponse([feeAssignment()]));await oldList;assert.equal(ui.get('assigned-fees-list').children.length,0);assert.equal(ui.get('assigned-fees').hidden,true);
});

test('assignment metadata is inert, mismatched recipients and owner rows are excluded, and paused claims can retry',async t=>{
 const self='f'.repeat(32),row=feeAssignment({name:'<img src=x onerror=bad()>',image:'https://external.invalid/image',claim:{available:true,busy:false,status:'paused',reason:'A saved payout can be retried.'},operations:[{state:'confirmed',signature:'javascript:bad()'}]});
 const ui=await page(t,{rows:[],sessionResponse:async()=>({authenticated:true,token:'csrf',account:{id:self,username:'recipient'}}),respond:path=>path==='/api/launchpad/fee-assignments'?assignedResponse([row,feeAssignment({id:FAILED,ownerAccountId:self}),feeAssignment({id:DRAFT,recipient:QUOTE})]):undefined});
 assert.equal(ui.document.querySelectorAll('.assigned-fee-card').length,1);assert.equal(ui.get('assigned-fees').querySelector('img,script'),null);assert.match(ui.get('assigned-fees').textContent,/<img src=x/);assert.equal(ui.document.querySelector('[data-assigned-claim]').textContent,'Retry assigned fees');assert.equal(ui.document.querySelector('[data-assigned-claim]').disabled,false);assert.equal(ui.get('tokens-count-launched').textContent,'0');
 assert([...ui.get('assigned-fees').querySelectorAll('a')].every(link=>/^https:\/\/solscan.io\/account\/|^\/coin\?mint=/.test(link.getAttribute('href'))));
});

test('a paused saved recipient payout gets a fresh retry ID and returns to modest inventory polling',async t=>{
 let row=feeAssignment();const ui=await page(t,{rows:[],respond:path=>path==='/api/launchpad/fee-assignments'?assignedResponse([row]):path.endsWith('/fee-assignments/claim')?{assignment:row=feeAssignment({claim:{available:true,busy:true,status:'queued'}}),alreadyRequested:false}:undefined});
 await ui.app.claimAssignedFees(ASSIGNED_OWNER,ASSIGNED_ID);row=feeAssignment({claim:{available:true,busy:false,status:'paused',reason:'The saved payout is ready to retry.'}});await ui.tick(5000);
 assert.equal(ui.document.querySelector('[data-assigned-claim]').textContent,'Retry assigned fees');assert.match(ui.get('assigned-fees').textContent,/saved payout is ready to retry/);assert.equal(ui.get('assigned-fees').textContent.includes('Claim queued'),false);
 const reads=ui.calls.filter(call=>call.path==='/api/launchpad/fee-assignments').length;await ui.tick(5000);assert.equal(ui.calls.filter(call=>call.path==='/api/launchpad/fee-assignments').length,reads);
 await ui.app.claimAssignedFees(ASSIGNED_OWNER,ASSIGNED_ID);const requests=ui.calls.filter(call=>call.path.endsWith('/fee-assignments/claim')).map(call=>JSON.parse(call.options.body));assert.notEqual(requests[0].requestId,requests[1].requestId);
});


test('owned launch cards and detail pair fields use local mint-matched quote logos',async t=>{
  const list=await page(t);assert.equal(list.document.querySelector('.token-card-meta .quote-identity img').src,quoteLogoPath(QUOTE));
  const detail=await page(t,{id:ID}),pair=detail.get('token-details').querySelector('.quote-identity');assert.equal(pair.textContent,'USDC');assert.equal(pair.querySelector('img').src,quoteLogoPath(QUOTE));pair.querySelector('img').onerror();assert.equal(pair.textContent,'USDC');
});

test('Launched tokens mounts private rewards once, polls no faster than a minute and clears them on wallet/session changes',async t=>{
  const accountId='f'.repeat(32),earnings={quoteTotals:[{mint:QUOTE,symbol:'USDC',decimals:6,amountUnits:'12500000'}],usdEstimate:12.5,observedUsdEstimate:12.5,valuationComplete:true,historyComplete:true,valuationBasis:'current_quote_prices',paymentCount:2,lastPaymentAt:1700000000000};
  let wallet=WALLET;
  const ui=await page(t,{rows:[],sessionResponse:async()=>({authenticated:true,token:'csrf',account:{id:accountId,mainWallet:wallet}}),respond:path=>path==='/api/launchpad/earnings'?{scope:'confirmed_curve_payments',wallet,requiresWalletSignIn:false,creator:earnings,holders:earnings,updatedAt:1700000100000,refreshMs:60000}:undefined});
  const reads=()=>ui.calls.filter(row=>row.path==='/api/launchpad/earnings').length;
  assert.equal(reads(),1);assert.equal(ui.get('personal-earnings').hidden,false);assert.match(ui.get('personal-earnings').textContent,/Creator rewards received/);assert.match(ui.get('personal-earnings').textContent,/12\.5/);
  await ui.get('tokens-list-refresh').onclick();assert.equal(reads(),1);await ui.tick(59999);assert.equal(reads(),1);await ui.tick(1);assert.equal(reads(),2);
  ui.document.hidden=true;await ui.tick(60000);assert.equal(reads(),2);ui.document.hidden=false;
  wallet=MINT;ui.document.dispatchEvent(new ui.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'csrf2',account:{id:accountId,mainWallet:wallet}}}));await flush();await flush();assert.equal(reads(),3);assert.match(ui.get('personal-earnings').textContent,/So1111/);
  ui.document.dispatchEvent(new ui.window.CustomEvent('curve-account-updated',{detail:{authenticated:false}}));await flush();assert.equal(ui.get('personal-earnings').hidden,true);assert(!ui.get('personal-earnings').textContent.includes('12.5'));await ui.tick(60000);assert.equal(reads(),3);
});


test('private owned and assigned fee token images use current art for exact official LAUNCHPAD mint only',async t=>{
  const imageId='f'.repeat(64)+'.webp',image='/token-images/'+imageId,row=launch({mint:OFFICIAL_TOKEN_MINT});row.input={...row.input,symbol:'LAUNCHPAD',imageId};
  const list=await page(t,{rows:[row]});assert.equal(list.get('tokens-list').querySelector('.token-avatar img').src,'/brand-icon.png?v=54');
  const detail=await page(t,{id:ID,rows:[row]});assert.equal(detail.get('token-avatar').querySelector('img').src,'/brand-icon.png?v=54');assert.equal(row.input.imageId,imageId);
  const unrelated=await page(t,{id:ID,rows:[{...row,mint:MINT}]});assert.equal(unrelated.get('token-avatar').querySelector('img').src,image);
  const assigned=await page(t,{rows:[],respond:path=>path==='/api/launchpad/fee-assignments'?assignedResponse([feeAssignment({mint:OFFICIAL_TOKEN_MINT,image,symbol:'LAUNCHPAD'}),feeAssignment({id:DRAFT,image,symbol:'LAUNCHPAD'})]):undefined});
  const images=assigned.get('assigned-fees-list').querySelectorAll('.token-avatar img');assert.equal(images[0].src,'/brand-icon.png?v=54');assert.equal(images[1].src,image);
});

const ORIGINAL='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',RECIPIENT='HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF';
const redirectSession=()=>({authenticated:true,token:'account-csrf',account:{id:ID,authType:'wallet',mainWallet:ORIGINAL},authMethod:'wallet',walletVerified:true,walletAddress:ORIGINAL});
const redirectLaunch=(patch={})=>launch({feeRedirect:{allowed:true,used:false,reason:'',originalWallet:ORIGINAL,recipient:ORIGINAL,...patch}});
const fillRedirect=ui=>{ui.get('tokens-fee-redirect-address').value=RECIPIENT;ui.get('tokens-fee-redirect-address').oninput();ui.get('tokens-fee-redirect-confirm').checked=true;ui.get('tokens-fee-redirect-confirm').onchange();};

test('only the original verified creator can open one-time fee routing; assigned recipients get no route controls',async t=>{
 const ui=await page(t,{rows:[redirectLaunch()],sessionResponse:redirectSession,respond:path=>path==='/api/launchpad/fee-assignments'?assignedResponse([feeAssignment()]):undefined});
 const button=ui.document.querySelector('[data-redirect-for]');assert.equal(button.disabled,false);button.onclick();assert.equal(ui.get('tokens-fee-redirect-dialog').open,true);assert.equal(ui.get('tokens-fee-redirect-current').textContent,ORIGINAL);assert.match(ui.get('tokens-fee-redirect-dialog').textContent,/new recipient can claim fees but cannot change this address/);assert.equal(ui.document.querySelector('.assigned-fee-card [data-redirect-for]'),null);
 for(const session of [{...redirectSession(),authMethod:'password',walletVerified:false},{...redirectSession(),walletAddress:RECIPIENT}]){const other=await page(t,{rows:[redirectLaunch()],sessionResponse:()=>session});assert.equal(other.document.querySelector('[data-redirect-for]').disabled,true);other.document.querySelector('[data-redirect-for]').onclick();assert.notEqual(other.get('tokens-fee-redirect-dialog').open,true);}
});

test('fee reroute requires the irreversible checkbox then sends only the bound original-recipient request once',async t=>{
 let complete;const ui=await page(t,{rows:[redirectLaunch()],sessionResponse:redirectSession,respond:path=>path.endsWith('/fee-assignments/redirect')?new Promise(resolve=>complete=resolve):undefined});ui.document.querySelector('[data-redirect-for]').onclick();ui.get('tokens-fee-redirect-address').value=RECIPIENT;ui.get('tokens-fee-redirect-address').oninput();assert.equal(ui.get('tokens-fee-redirect-submit').disabled,true);await ui.get('tokens-fee-redirect-form').onsubmit();assert.equal(ui.calls.some(x=>x.path.endsWith('/redirect')),false);
 fillRedirect(ui);assert.equal(ui.get('tokens-fee-redirect-preview').textContent,RECIPIENT);assert.equal(ui.get('tokens-fee-redirect-preview').getAttribute('aria-live'),'polite');const first=ui.get('tokens-fee-redirect-form').onsubmit();await flush();assert.equal(ui.app.canLeave(),false);await ui.get('tokens-fee-redirect-form').onsubmit();assert.equal(ui.calls.filter(x=>x.path.endsWith('/redirect')).length,1);assert.equal(ui.get('tokens-fee-redirect-close').disabled,true);const request=JSON.parse(ui.calls.find(x=>x.path.endsWith('/redirect')).options.body);assert.deepEqual(Object.keys(request).sort(),['expectedRecipient','id','recipient','requestId']);assert.equal(request.expectedRecipient,ORIGINAL);assert.equal(request.recipient,RECIPIENT);
 complete({launch:redirectLaunch({allowed:false,used:true,recipient:RECIPIENT})});await first;assert.equal(ui.app.canLeave(),true);assert.equal(ui.get('tokens-fee-redirect-dialog').open,false);assert.equal(ui.document.querySelector('[data-redirect-for]'),null);assert.match(ui.get('tokens-list').textContent,/Fee recipient locked/);assert.match(ui.get('tokens-list').textContent,/Example token/);
});

test('an uncertain fee redirect locks its recipient and retries only the same request ID',async t=>{
 let fail=true;const ui=await page(t,{rows:[redirectLaunch()],sessionResponse:redirectSession,respond:path=>{if(path.endsWith('/fee-assignments/redirect')){if(fail)throw Error('Network interrupted');return{launch:redirectLaunch({allowed:false,used:true,recipient:RECIPIENT}),alreadyRedirected:true};}}});ui.document.querySelector('[data-redirect-for]').onclick();fillRedirect(ui);await ui.get('tokens-fee-redirect-form').onsubmit();assert.equal(ui.get('tokens-fee-redirect-address').disabled,true);assert.equal(ui.get('tokens-fee-redirect-submit').textContent,'Check saved redirect');assert.match(ui.get('tokens-fee-redirect-status').textContent,/exact request safely/);fail=false;await ui.get('tokens-fee-redirect-form').onsubmit();const writes=ui.calls.filter(x=>x.path.endsWith('/redirect')).map(x=>JSON.parse(x.options.body));assert.deepEqual(writes[0],writes[1]);assert.equal(ui.get('tokens-fee-redirect-dialog').open,false);
});

test('same-account wallet proof change closes fee routing and ignores an in-flight previous-proof result',async t=>{
 let complete;const ui=await page(t,{rows:[redirectLaunch()],sessionResponse:redirectSession,respond:path=>path.endsWith('/fee-assignments/redirect')?new Promise(resolve=>complete=resolve):undefined});ui.document.querySelector('[data-redirect-for]').onclick();fillRedirect(ui);const pending=ui.get('tokens-fee-redirect-form').onsubmit();await flush();ui.document.dispatchEvent(new ui.window.CustomEvent('curve-account-updated',{detail:{...redirectSession(),authMethod:'password',walletVerified:false,walletAddress:null}}));await flush();assert.equal(ui.get('tokens-fee-redirect-dialog').open,false);complete({launch:redirectLaunch({allowed:false,used:true,recipient:RECIPIENT})});await pending;assert.equal(ui.document.querySelector('[data-redirect-for]').disabled,true);assert.equal(ui.get('tokens-list').textContent.includes('Fee recipient locked'),false);
});

test('route teardown is idempotent, removes pagehide and leaves later page DOM and session events untouched',async t=>{
  let resolveList,pending=false;const ui=await page(t,{listResponse:()=>pending?new Promise(resolve=>{resolveList=resolve;}):{launches:[launch()]}});
  assert.equal(ui.app.canLeave(),true);assert(ui.events.has('pagehide'));pending=true;const refresh=ui.app.refreshList(true);await flush();const request=ui.calls.filter(call=>call.path==='/api/launchpad').at(-1);ui.app.destroy();
  assert.equal(request.options.signal.aborted,true);assert.equal(ui.events.has('pagehide'),false);
  ui.document.body.innerHTML='<main id="replacement">Next page</main>';assert.doesNotThrow(()=>ui.app.destroy());
  resolveList({launches:[launch({input:{...launch().input,name:'Late response'}})]});await refresh;ui.document.dispatchEvent(new ui.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'new'}}));await flush();
  assert.equal(ui.document.body.textContent,'Next page');const calls=ui.calls.length;await ui.tick(60000);assert.equal(ui.calls.length,calls);
});

test('Meteora saved-claim lookup and one-time redirect keep route navigation blocked until settled',async t=>{
  const row={platform:'meteora',mint:MINT,name:'Meteora token',symbol:'MET',status:'trading',creatorId:ID,creatorRecipient:WALLET,quoteMint:QUOTE,quoteDecimals:6,quoteSymbol:'USDC',feeRedirect:{canRedirect:true,recipient:WALLET}};
  let resolveLookup,resolveRedirect;
  const ui=await page(t,{rows:[],sessionResponse:()=>({authenticated:true,token:'csrf',account:{id:ID}}),walletFactory:()=>({state:()=>({address:WALLET,wallets:[]}),onChange:()=>()=>{}}),respond:path=>path==='/api/launchpad/meteora/launches'?{launches:[row]}:path==='/api/launchpad/meteora/operations'?new Promise(resolve=>{resolveLookup=resolve;}):path==='/api/launchpad/meteora/reroute'?new Promise(resolve=>{resolveRedirect=resolve;}):path==='/api/launchpad/meteora/prepare'?{status:409,body:{error:'No claim available.'}}:undefined});
  assert.equal(ui.app.canLeave(),true);const claim=[...ui.get('tokens-meteora').querySelectorAll('button')].find(button=>button.textContent==='Claim creator fees').onclick();await flush();assert.equal(ui.app.canLeave(),false);resolveLookup({operations:[]});await claim;assert.equal(ui.app.canLeave(),true);
  // The one-time redirect now opens a confirmation dialog instead of posting from an inline form.
  assert.equal(ui.get('tokens-meteora').querySelector('form'),null);ui.get('tokens-meteora').querySelector('[data-meteora-redirect]').onclick();
  const dialog=ui.get('meteora-fee-redirect-dialog'),form=dialog.querySelector('form'),input=ui.get('meteora-fee-redirect-address'),confirm=dialog.querySelector('input[type=checkbox]');
  input.value=POOL;input.oninput();await form.onsubmit({preventDefault(){}});assert.equal(ui.calls.some(call=>call.path==='/api/launchpad/meteora/reroute'),false);
  confirm.checked=true;confirm.onchange();const saving=form.onsubmit({preventDefault(){}});await flush();assert.equal(ui.app.canLeave(),false);resolveRedirect({launch:{...row,creatorRecipient:POOL}});await saving;await flush();assert.equal(ui.app.canLeave(),true);
});

test('Meteora wallet connection blocks navigation and cannot start a claim after teardown',async t=>{
  const row={platform:'meteora',mint:MINT,name:'Meteora token',symbol:'MET',status:'trading',creatorId:ID,creatorRecipient:WALLET,quoteMint:QUOTE,quoteDecimals:6,quoteSymbol:'USDC'};let address='',resolveConnect;
  const ui=await page(t,{rows:[],sessionResponse:()=>({authenticated:true,token:'csrf',account:{id:ID}}),walletFactory:()=>({state:()=>({address,wallets:[{id:'test',name:'Test wallet'}]}),onChange:()=>()=>{},connect:()=>new Promise(resolve=>{resolveConnect=()=>{address=WALLET;resolve({address});};})}),respond:path=>path==='/api/launchpad/meteora/launches'?{launches:[row]}:undefined});
  await [...ui.get('tokens-meteora').querySelectorAll('button')].find(button=>button.textContent==='Claim creator fees').onclick();
  const connect=[...ui.get('tokens-meteora').querySelectorAll('button')].find(button=>button.textContent==='Test wallet').onclick();await flush();assert.equal(ui.app.canLeave(),false);ui.app.destroy();resolveConnect();await connect;
  assert.equal(ui.calls.some(call=>call.path==='/api/launchpad/meteora/operations'||call.options.method==='POST'),false);
});

// v71.25 regressions.
test('fee redirect accepts a padded paste of the full address and refuses addresses that are not 32-byte wallets',async t=>{
  let complete;const ui=await page(t,{rows:[redirectLaunch()],sessionResponse:redirectSession,respond:path=>path.endsWith('/fee-assignments/redirect')?new Promise(resolve=>complete=resolve):undefined});
  const input=ui.get('tokens-fee-redirect-address');assert.equal(input.hasAttribute('maxlength'),false,'a maxlength cuts a pasted address short before it can be trimmed');
  ui.document.querySelector('[data-redirect-for]').onclick();ui.get('tokens-fee-redirect-confirm').checked=true;ui.get('tokens-fee-redirect-confirm').onchange();
  for(const value of ['z'.repeat(44),'2'.repeat(32),RECIPIENT.slice(0,31)]){input.value=value;input.oninput();assert.equal(ui.get('tokens-fee-redirect-submit').disabled,true,value);assert.equal(ui.get('tokens-fee-redirect-preview').textContent,'');await ui.get('tokens-fee-redirect-form').onsubmit();}
  assert.equal(ui.calls.some(x=>x.path.endsWith('/redirect')),false);
  input.value=' '+RECIPIENT+'\n';input.oninput();assert.equal(ui.get('tokens-fee-redirect-preview').textContent,RECIPIENT);assert.equal(ui.get('tokens-fee-redirect-submit').disabled,false);
  const saving=ui.get('tokens-fee-redirect-form').onsubmit();await flush();assert.equal(JSON.parse(ui.calls.find(x=>x.path.endsWith('/redirect')).options.body).recipient,RECIPIENT);
  complete({launch:redirectLaunch({allowed:false,used:true,recipient:RECIPIENT})});await saving;assert.equal(ui.get('tokens-fee-redirect-dialog').open,false);
});

test('My Tokens lists native Pump.fun launches by state, with coin and launch-status links',async t=>{
  const pumpLaunch=(patch={})=>({id:'f'.repeat(24),state:'created',stateLabel:'Live on Pump.fun',mode:'creator',modeLabel:'Creator',name:'Orbit',symbol:'ORBIT',image:null,mint:POOL,dimensions:{launch:'created',venue:'curve',refund:null},refundedSol:'0',refundedPair:null,pair:{mint:MINT,symbol:'SOL',decimals:9,kind:'sol'},...patch});
  const launches=[pumpLaunch(),pumpLaunch({id:'1'.repeat(24),state:'awaiting_funding',stateLabel:'Waiting for funding',name:'Pending',symbol:'PEND',mint:null}),pumpLaunch({id:'2'.repeat(24),state:'failed',stateLabel:'Failed',name:'Refunding',symbol:'REF',dimensions:{refund:'pending'},reason:'Pump.fun rejected the create transaction.'}),pumpLaunch({id:'3'.repeat(24),state:'failed',stateLabel:'Failed',name:'Refunded',symbol:'DONE',dimensions:{refund:'complete'},refundedSol:'0.25'}),pumpLaunch({id:'4'.repeat(24),state:'expired',stateLabel:'Quote expired',name:'Old',symbol:'OLD'})];
  const respond=path=>path==='/api/launchpad/pump-classic/launches'?{launches}:undefined;
  const ui=await page(t,{rows:[],respond});
  const request=ui.calls.find(c=>c.path==='/api/launchpad/pump-classic/launches');assert.equal(request.options.method,'GET');assert.equal(request.options.headers['x-control-token'],'account-csrf');
  const section=ui.get('tokens-pump-classic'),cards=()=>[...section.querySelectorAll('[data-pump-classic-launch]')].map(card=>card.dataset.pumpClassicLaunch),links=()=>[...section.querySelectorAll('a.token-card-open')].map(a=>[a.textContent,a.getAttribute('href')]);
  assert.equal(section.hidden,false);assert.match(section.textContent,/Your Pump.fun launches/);assert.match(section.textContent,/Live on Pump.fun/);assert.deepEqual(links(),[['Open coin →','/coin?mint='+POOL]]);
  ui.document.querySelector('[data-launch-filter="drafts"]').onclick();assert.deepEqual(cards(),['1'.repeat(24),'2'.repeat(24)]);assert.match(section.textContent,/Waiting for funding/);assert.match(section.textContent,/Refunding/);assert.match(section.textContent,/rejected the create transaction/);
  assert.deepEqual(links(),[['Resume launch →','/launchpad?venue=pump-classic&launchId='+'1'.repeat(24)],['View launch →','/launchpad?venue=pump-classic&launchId='+'2'.repeat(24)]]);
  ui.document.querySelector('[data-launch-filter="archived"]').onclick();assert.deepEqual(cards(),['3'.repeat(24),'4'.repeat(24)]);assert.match(section.textContent,/Refunded 0.25 SOL/);assert.match(section.textContent,/Quote expired/);
  // A launch detail page never reads the other venues' lists.
  const detail=await page(t,{id:ID,respond});await detail.tick(31000);assert.equal(detail.calls.some(c=>/\/api\/launchpad\/(pump-classic|pump|damm-pump|meteora)\/launches/.test(c.path)),false);assert.equal(detail.get('tokens-pump-classic').hidden,true);
});

test('an expired session signs the header out and the gate says so',async t=>{
  let expired=false;const ui=await page(t,{listResponse:()=>expired?{status:401,body:{error:'Sign in to your Launchpad account.'}}:{launches:[launch()]}});
  const events=[];ui.document.addEventListener('curve-account-updated',event=>events.push(event.detail));
  expired=true;await ui.get('tokens-list-refresh').onclick();await flush();
  assert.deepEqual(events,[{authenticated:false,account:null,token:''}]);assert.equal(ui.get('tokens-main').hidden,true);assert.equal(ui.get('tokens-gate').hidden,false);
  assert.match(ui.get('tokens-gate-message').textContent,/session expired/);assert.equal(ui.get('tokens-gate').querySelector('a').hidden,false);assert.equal(ui.get('tokens-list').textContent,'');
});

test('proxy error pages and slow responses show readable messages, and a failed session check retries',async t=>{
  const proxyPage=()=>({status:502,get body(){throw new SyntaxError('Unexpected token \'<\', "<html><hea"... is not valid JSON');}});
  let sessionFails=true;const ui=await page(t,{sessionResponse:()=>sessionFails?proxyPage():{authenticated:true,token:'account-csrf'}});
  assert.equal(ui.get('tokens-gate').hidden,false);assert.match(ui.get('tokens-gate-message').textContent,/could not be checked right now\. Retrying automatically/);assert.equal(ui.get('tokens-gate').querySelector('a').hidden,true);
  assert.doesNotMatch(ui.get('tokens-gate').textContent,/JSON|Unexpected token/);
  sessionFails=false;await ui.tick(1000);assert.equal(ui.calls.filter(c=>c.path==='/api/session').length,1,'retries wait for their backoff');
  await ui.tick(5000);for(let i=0;i<6;i++)await flush();assert.equal(ui.get('tokens-main').hidden,false);assert.equal(ui.get('tokens-gate').hidden,true);assert.equal(ui.document.querySelectorAll('.token-launch-card').length,1);
  for(const listResponse of [()=>proxyPage(),()=>{throw new DOMException('signal is aborted without reason','AbortError');}]){
    const list=await page(t,{listResponse});const text=list.get('tokens-error').textContent;assert.equal(list.get('tokens-error').hidden,false);
    assert.match(text,/^Launchpad is (temporarily unavailable|taking longer than usual)/);assert.doesNotMatch(text,/JSON|Unexpected token|aborted/);
  }
});

test('Gotchi launches link their prize pot instead of showing holder rewards',async t=>{
  const gotchi=launch({gotchi:{id:'fomogotchi',theme:'Fomo',vault:POOL},input:{...launch().input,feeMode:'holders'},holderRewards:{pendingQuote:'1',quoteSymbol:'USDC',totalDistributedQuote:'0'}});
  const ui=await page(t,{id:ID,rows:[gotchi]});assert.equal(ui.get('token-rewards').hidden,true);assert.equal(ui.calls.some(c=>c.path.startsWith('/api/launchpad/rewards?')),false);
  assert.ok([...ui.get('token-details').querySelectorAll('a')].some(a=>a.getAttribute('href')==='/gotchi?id=fomogotchi'));assert.doesNotMatch(ui.get('token-details').textContent,/Holder rewards|Collected rewards/);
  await ui.tick(31000);assert.equal(ui.calls.some(c=>c.path.startsWith('/api/launchpad/rewards?')),false);
});

test('the claim-all hint shows only on the Launched tab and internal links use the in-page arrow',async t=>{
  const ui=await page(t,{rows:[launch(),launch({id:DRAFT,state:'draft',curve:null,operations:[]})]});
  assert.equal(ui.get('tokens-claim-hint').hidden,false);assert.equal(ui.document.querySelector('.token-card-link').textContent,'View market →');
  ui.document.querySelector('[data-launch-filter="drafts"]').onclick();assert.equal(ui.get('tokens-claim-hint').hidden,true);assert.equal(ui.document.querySelector('.token-card-link').textContent,'View draft →');
  ui.document.querySelector('[data-launch-filter="archived"]').onclick();assert.equal(ui.get('tokens-claim-hint').hidden,true);
  ui.document.querySelector('[data-launch-filter="launched"]').onclick();assert.equal(ui.get('tokens-claim-hint').hidden,false);
});
