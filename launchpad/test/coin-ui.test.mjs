import {OFFICIAL_TOKEN_MINT} from '../public/coin-image.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {createCoinPage} from '../public/coin-view.mjs';

const MINT='So11111111111111111111111111111111111111112',QUOTE='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',POOL='58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const NOW=1700000100000;
const token=(patch={})=>({mint:MINT,name:'Example coin',symbol:'EXAMPLE',description:'A new idea.',chain:'solana',createdAt:NOW,quote:{mint:QUOTE,symbol:'USDC'},stage:'new',curveStatus:'curve',curve:POOL,feeMode:'creator',taxBps:300,marketCapUsd:null,fdvUsd:20000,priceUsd:.00002,progressPercent:35,marketSource:'Raydium onchain',...patch});
const native=(patch={})=>({mint:MINT,curve:POOL,status:'curve',at:NOW,slot:12,priceQuote:.00002,fdvQuote:20000,supply:1e9,raisedQuote:35,targetQuote:100,progressPercent:35,quote:{mint:QUOTE,symbol:'USDC',stale:false},priceUsd:.00002,fdvUsd:20000,stale:false,points:[{time:1700000100,priceQuote:.00002}],...patch});
const pool=(patch={})=>({chain:'solana',address:POOL,token:MINT,base:{address:MINT},quote:{address:QUOTE},isBase:true,priceUsd:.0003,marketCapUsd:280000,fdvUsd:300000,liquidityUsd:60000,volume:{h24:95000},priceChange:{h24:21.5},txns:{h24:{buys:45,sells:12}},...patch});
const rewards=(mode='holders',patch={})=>({mint:MINT,mode,enabled:true,status:'enabled',quote:{mint:QUOTE,symbol:'USDC',decimals:6},tokenSymbol:'EXAMPLE',taxBps:300,asOf:NOW,refreshMs:30000,stale:false,error:'',holder:mode==='holders'?{distributedQuote:'112.345',payments:25,lastDistributionAt:NOW-3600000,lastDistributionQuote:'11.2',pendingQuote:'5.6',unconvertedTaxTokens:'5000',withheldTokens:'400',unclaimedCreatorQuote:'2.3',unclaimedScope:'curve',intervalMinutes:60,minimumQuote:'1',nextCheckAt:NOW+3600000}:null,buyback:mode==='buyback'?{totalQuoteSpent:'85.5',tokensBought:'500000',tokensBurned:'400000',completedBuys:4,completedBurns:3,pendingOperations:1,pendingQuote:'10.5',pendingBurnTokens:'100000',totalClaimedQuote:'96',totalClaimedTokens:'0',unclaimedCreatorQuote:'6',unclaimedScope:'curve',lastBuybackAt:NOW-60000,buybackPercent:100,intervalMinutes:1,historyComplete:true,historyNote:''}:null,...patch});
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));

async function page(t,{mint=MINT,coin=token(),respond,chartFactory,windowPatch={},prepare}={}){
  const {document}=parseHTML(await readFile(new URL('../public/coin.html',import.meta.url),'utf8'));prepare?.(document);
  Object.defineProperty(document,'hidden',{value:false,writable:true});
  const calls=[],timers=[],charts=[],shells=[],events=new Map(),copied=[];let now=NOW;
  const window={location:{search:'?mint='+encodeURIComponent(mint)},setTimeout,clearTimeout,Event:document.defaultView.Event,dispatchEvent:()=>true,navigator:{clipboard:{writeText:async value=>copied.push(value)}},addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:(name)=>events.delete(name),...windowPatch};
  const fetcher=async(path,options)=>{calls.push({path,options});let value=await respond?.(path,options);if(value===undefined)value=path.startsWith('/api/explore/token?')?{coin}:{coin,native:native(),pool:null,at:now,refreshMs:15000};const status=typeof value.status==='number'?value.status:200;return {status,ok:status<400,json:async()=>status<400?value:value.body};};
  const app=createCoinPage({document,window,fetcher,clock:()=>now,shell:args=>shells.push(args),setTimer:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimer:()=>{},chartFactory:chartFactory||(async root=>{const chart={root,updates:[],removed:false,set(points,options){this.updates.push({points,options});},remove(){this.removed=true;}};charts.push(chart);return chart;})});t.after(()=>app.destroy());
  await app.ready;await flush();
  return {document,get:id=>document.getElementById(id),app,calls,charts,timers,shells,events,copied,async tick(ms){now+=ms;await app.tick();await flush();}};
}

test('public coin page loads without session or owner APIs and shows confirmed curve prices immediately',async t=>{
  const ui=await page(t);assert.equal(ui.get('coin-content').hidden,false);assert.equal(ui.get('coin-name').textContent,'Example coin');assert.equal(ui.get('coin-cap-label').textContent,'Fully diluted value');assert.match(ui.get('coin-cap').textContent,/20/);assert.equal(ui.get('coin-progress-label').textContent,'35%');assert.equal(ui.get('coin-trade').getAttribute('href'),null);assert.match(ui.get('coin-trade').textContent,/Buy/);assert.match(ui.get('coin-trade').textContent,/Sell/);assert.equal(ui.shells[0].page,'coin');
  assert.equal(ui.charts.length,1);assert.equal(ui.charts[0].updates[0].points.length,1);assert.equal(ui.charts[0].updates[0].options.mode,'price');assert(ui.calls.every(call=>call.path.startsWith('/api/explore/')&&call.options.method==='GET'&&!call.options.headers));assert.equal(ui.document.querySelector('dialog'),null);
  assert.equal(ui.document.querySelector('[id*=claim]'),null);assert.equal(ui.document.querySelector('[id*=distribute]'),null);
  ui.document.querySelector('[data-coin-chart="fdv"]').onclick();assert.equal(ui.charts[0].updates.at(-1).options.mode,'fdv');await ui.get('coin-copy').onclick();assert.deepEqual(ui.copied,[MINT]);
});
test('public active curves draw an exact snapshot without history and stay native when DEX has just indexed',async t=>{
  const coin=token(),snapshot=native({points:undefined,candles:[],priceUsd:null,fdvUsd:null,quote:{mint:QUOTE,symbol:'WBTC',stale:true}});
  const ui=await page(t,{coin,respond:path=>path.includes('/market?')?{coin,native:snapshot,pool:pool(),at:NOW}:undefined});
  assert.equal(ui.charts.length,1);assert.deepEqual(ui.charts[0].updates[0].points,[{time:Math.floor(NOW/1000),priceQuote:.00002,slot:12}]);assert.deepEqual(ui.charts[0].updates[0].options.candles,[]);assert.equal(ui.document.querySelector('iframe'),null);assert.equal(ui.get('coin-chart-source').textContent,'Raydium onchain');
});
test('public chart recovers from a transient rendering failure without waiting for another API response',async t=>{
  let attempts=0,removed=0,sets=0;
  const ui=await page(t,{chartFactory:async()=>{const attempt=++attempts;return {set(){if(attempt===1)throw Error('Transient canvas failure');sets++;},remove(){removed++;}};}});
  assert.match(ui.get('coin-chart').textContent,/reconnecting/);assert.equal(attempts,1);assert.equal(removed,1);const calls=ui.calls.length;await ui.tick(5000);assert.equal(attempts,2);assert.equal(sets,1);assert.equal(ui.calls.length,calls);assert(!ui.get('coin-chart').textContent.includes('reconnecting'));
});
test('Dex data produces a trusted iframe and retains it across updates',async t=>{
  const coin=token({stage:'graduated',curveStatus:'migrated'});let cap=280000;
  const ui=await page(t,{coin,respond:path=>path.includes('/market?')?{coin,pool:pool({marketCapUsd:cap,url:'javascript:evil()',chart:'https://evil.invalid'}),native:native({status:'migrated'}),at:NOW}:undefined});
  const frame=ui.document.querySelector('iframe');assert(frame);assert(frame.src.startsWith('https://dexscreener.com/solana/'+POOL+'?'));assert(frame.src.includes('embed=1'));assert.equal(ui.get('coin-cap-label').textContent,'Market cap');assert.match(ui.get('coin-cap').textContent,/280/);assert.equal(ui.get('coin-stage').textContent,'Graduated');assert.equal(ui.get('coin-progress-wrap').hidden,true);
  cap=290000;await ui.tick(15000);assert.equal(ui.document.querySelector('iframe'),frame);assert.match(ui.get('coin-cap').textContent,/290/);assert.match(ui.get('coin-stats').textContent,/95/);
});
test('unsafe metadata never creates markup, offsite images, or unsafe social links',async t=>{
  const coin=token({name:'<img src=x onerror=alert(1)>',description:'<script>bad()</script>',image:'https://evil.invalid/pixel',links:{website:'javascript:alert(1)',twitter:'https://x.com/examplecoin',telegram:'https://user:pass@t.me/evil'}});
  const ui=await page(t,{coin});assert.equal(ui.get('coin-name').textContent,coin.name);assert.equal(ui.get('coin-name').querySelector('img'),null);assert.equal(ui.get('coin-description').textContent,coin.description);assert.equal(ui.get('coin-avatar').querySelector('img'),null);assert.equal(ui.get('coin-socials').children.length,1);assert.equal(ui.get('coin-socials').firstElementChild.href,'https://x.com/examplecoin');
});
test('local upload avatars fall back to full ticker when the image fails',async t=>{
  const image='/token-images/'+'a'.repeat(64)+'.webp',ui=await page(t,{coin:token({image})});const img=ui.get('coin-avatar').querySelector('img');assert.equal(img.src,image);img.onerror();assert.equal(ui.get('coin-avatar').querySelector('img'),null);assert.equal(ui.get('coin-avatar').firstElementChild.hidden,false);assert.equal(ui.get('coin-avatar').textContent,'EXAMPLE');
});
test('invalid or unknown coins never request unrelated markets',async t=>{
  const invalid=await page(t,{mint:'../../private'});assert.equal(invalid.calls.length,0);assert.equal(invalid.get('coin-content').hidden,true);assert.match(invalid.get('coin-error').textContent,/Choose a coin/);
  const missing=await page(t,{respond:()=>({status:404,body:{error:'Not found'}})});assert.equal(missing.calls.length,1);assert.match(missing.get('coin-error').textContent,/not listed/);assert.equal(missing.get('coin-content').hidden,true);
});
test('mismatched native and Dex responses never become a chart',async t=>{
  const coin=token({marketCapUsd:null,fdvUsd:null,priceUsd:null});
  const ui=await page(t,{coin,respond:path=>path.includes('/market?')?{coin,native:native({mint:QUOTE}),pool:pool({token:QUOTE}),at:NOW}:undefined});assert.equal(ui.charts.length,0);assert.equal(ui.document.querySelector('iframe'),null);assert.equal(ui.get('coin-cap').textContent,'—');assert.equal(ui.get('coin-price').textContent,'—');assert.equal(ui.get('coin-dex').hidden,true);
});
test('periodic refresh pauses while hidden and provider failure backs off without blanking existing chart',async t=>{
  let fail=false;
  const ui=await page(t,{respond:path=>path.includes('/market?')&&fail?{status:503,body:{error:'Market provider is temporarily unavailable.'}}:undefined});const chart=ui.charts[0],before=ui.calls.filter(p=>!p.path.includes("/trades?")).length;
  ui.document.hidden=true;await ui.tick(60000);assert.equal(ui.calls.filter(p=>!p.path.includes("/trades?")).length,before);ui.document.hidden=false;fail=true;await ui.tick(1000);assert.equal(ui.calls.filter(p=>!p.path.includes("/trades?")).length,before+1);assert.match(ui.get('coin-market-note').textContent,/temporarily unavailable/);assert.equal(ui.charts[0],chart);assert.equal(chart.removed,false);
  await ui.tick(1000);await ui.app.refresh(true);assert.equal(ui.calls.filter(p=>!p.path.includes("/trades?")).length,before+1);await ui.tick(30000);assert.equal(ui.calls.filter(p=>!p.path.includes("/trades?")).length,before+2);
});
test('a fresh curve takes priority over stale Dex prices without presenting a stale market cap as current',async t=>{
  const coin=token({marketCapUsd:null});
  const ui=await page(t,{coin,respond:path=>path.includes('/market?')?{coin,native:native(),pool:pool({stale:true,priceUsd:9,marketCapUsd:9000000000}),at:NOW,stale:false}:undefined});
  assert.equal(ui.charts.length,1);assert.equal(ui.document.querySelector('iframe'),null);assert.equal(ui.get('coin-cap-label').textContent,'Fully diluted value');assert.match(ui.get('coin-cap').textContent,/20/);assert.equal(ui.get('coin-price').textContent,'$0.00002');assert(!ui.get('coin-stats').textContent.includes('95'));
});
test('a confirmed launch with unknown curve status is labeled Launched',async t=>{
  const coin=token({curveStatus:null,marketSource:null,fdvUsd:null,priceUsd:null});
  const ui=await page(t,{coin,respond:path=>path.includes('/market?')?{coin,native:null,pool:null,at:NOW}:undefined});assert.equal(ui.get('coin-stage').textContent,'Launched');assert.equal(ui.get('coin-price').textContent,'—');
});
test('migrated curve observations are clearly historical and cannot become live prices',async t=>{
  const coin=token({stage:'graduated',curveStatus:'migrated',marketSource:'Raydium onchain',marketCapUsd:null,fdvUsd:null,priceUsd:null});
  const ui=await page(t,{coin,respond:path=>path.includes('/market?')?{coin,native:native({status:'migrated'}),pool:null,at:NOW}:undefined});assert.equal(ui.charts.length,1);assert.equal(ui.get('coin-stage').textContent,'Graduated');assert.equal(ui.get('coin-chart-source').textContent,'Historical curve');assert.match(ui.get('coin-market-note').textContent,/Historical curve prices only/);assert.equal(ui.get('coin-price').textContent,'—');assert.equal(ui.get('coin-cap').textContent,'—');
});
test('a stale quote reference does not produce current USD values from native curve data',async t=>{
  const coin=token({marketSource:'Raydium onchain',marketCapUsd:null});
  const ui=await page(t,{coin,respond:path=>path.includes('/market?')?{coin,native:native({quote:{mint:QUOTE,symbol:'USDC',stale:true}}),pool:null,at:NOW}:undefined});assert.equal(ui.get('coin-price-label').textContent,'Price · USD');assert.equal(ui.get('coin-price').textContent,'—');assert.equal(ui.get('coin-cap').textContent,'—');assert.equal(ui.get('coin-price-quote').textContent,'0.00002 USDC per token');assert.equal(ui.get('coin-cap-source').textContent,'USD pricing unavailable');assert.match(ui.get('coin-market-note').textContent,/USD reference is delayed/);assert(!ui.get('coin-price').textContent.includes('$'));
});
test('an active quote chart can use independently fresh DEX USD values without changing its units',async t=>{
  const coin=token({marketSource:'Raydium onchain',marketCapUsd:null});
  const ui=await page(t,{coin,respond:path=>path.includes('/market?')?{coin,native:native({quote:{mint:QUOTE,symbol:'USDC',stale:true}}),pool:pool({marketCapUsd:null}),at:NOW}:undefined});
  assert.equal(ui.charts.length,1);assert.equal(ui.document.querySelector('iframe'),null);
  assert.equal(ui.get('coin-price').textContent,'$0.0003');assert.equal(ui.get('coin-cap').textContent,'$300K');
  assert.equal(ui.get('coin-cap-source').textContent,'DEX Screener');assert.equal(ui.get('coin-price-quote').textContent,'0.00002 USDC per token');
  assert.match(ui.get('coin-curve-caption').textContent,/USDC/);
});
test('reverse Dex pairs use native token charts and never embed the other asset chart',async t=>{
  const coin=token(),reverse=pool({isBase:false,base:{address:QUOTE},quote:{address:MINT},marketCapUsd:null,fdvUsd:null,priceChange:{}});
  const ui=await page(t,{coin,respond:path=>path.includes('/market?')?{coin,native:native(),pool:reverse,at:NOW}:undefined});assert.equal(ui.document.querySelector('iframe'),null);assert.equal(ui.charts.length,1);assert.equal(ui.get('coin-chart-source').textContent,'Raydium onchain');
  const unavailable=await page(t,{coin,respond:path=>path.includes('/market?')?{coin,native:null,pool:reverse,at:NOW}:undefined});assert.equal(unavailable.document.querySelector('iframe'),null);assert.match(unavailable.get('coin-chart').textContent,/other token in this pair/);assert.equal(unavailable.get('coin-dex').hidden,false);
});
test('outstanding requests and late chart creation are disposed when leaving the page',async t=>{
  let resolveChart;const ui=await page(t,{chartFactory:()=>new Promise(resolve=>{resolveChart=resolve;})});ui.app.destroy();const late={removed:false,set(){throw Error('Must not render after destroy');},remove(){this.removed=true;}};resolveChart(late);await flush();assert.equal(late.removed,true);const before=ui.calls.filter(p=>!p.path.includes("/trades?")).length;await ui.tick(60000);assert.equal(ui.calls.filter(p=>!p.path.includes("/trades?")).length,before);
});
test('holder reward totals are readable publicly in original quote units with no distribution actions',async t=>{
  const coin=token({feeMode:'holders'}),ui=await page(t,{coin,respond:path=>path.includes('/rewards?')?rewards():undefined});
  assert.equal(ui.get('coin-rewards').hidden,false);assert.equal(ui.get('coin-rewards-title').textContent,'Holder rewards');assert.equal(ui.get('coin-rewards-state').textContent,'Enabled');
  assert.match(ui.document.querySelector('[data-reward-metric="distributed"]').textContent,/112\.345USDC/);assert.match(ui.document.querySelector('[data-reward-metric="collecting"]').textContent,/5\.6USDC/);assert.match(ui.get('coin-rewards-schedule').textContent,/Checked hourly.*\$100 in USDC/);assert.match(ui.get('coin-rewards-latest').textContent,/11\.2 USDC/);
  assert(!ui.document.querySelector('[data-reward-metric="distributed"]').textContent.includes('$'));assert(!ui.get('coin-rewards').textContent.includes('Distribute now'));assert.equal(ui.get('coin-rewards').querySelectorAll('button').length,1);assert(ui.calls.every(call=>call.options.method==='GET'));assert(ui.calls.every(call=>!call.path.includes('/api/launchpad')));
  const requests=()=>ui.calls.filter(call=>call.path.includes('/rewards?')).length;assert.equal(requests(),1);await ui.tick(15000);assert.equal(requests(),1);await ui.tick(15000);assert.equal(requests(),2);ui.document.hidden=true;await ui.tick(60000);assert.equal(requests(),2);
});
test('agent card distinguishes actual quote spent, funds pending, and confirmed burns',async t=>{
  const coin=token({feeMode:'buyback'}),ui=await page(t,{coin,respond:path=>path.includes('/rewards?')?rewards('buyback'):undefined});
  assert.equal(ui.get('coin-rewards-title').textContent,'Tokenized agent');assert.match(ui.document.querySelector('[data-reward-metric="completed"]').textContent,/85\.5USDC.*4 confirmed buys/);assert.match(ui.document.querySelector('[data-reward-metric="pending"]').textContent,/10\.5USDC.*operation processing/);assert.match(ui.document.querySelector('[data-reward-metric="burned"]').textContent,/400,000EXAMPLE/);assert.match(ui.document.querySelector('[data-reward-metric="pending-burn"]').textContent,/100,000EXAMPLE/);assert.match(ui.document.querySelector('[data-reward-metric="claimed"]').textContent,/96USDC/);assert.match(ui.get('coin-rewards-schedule').textContent,/100%/);assert(!ui.get('coin-rewards').textContent.includes('Send creator fees'));
});
test('missing legacy buyback amounts remain unavailable and stale rewards are visibly labeled',async t=>{
  const coin=token({feeMode:'buyback'}),value=rewards('buyback');value.buyback={...value.buyback,totalQuoteSpent:null,totalClaimedQuote:null,tokensBought:null,historyComplete:false,historyNote:'Earlier claim amounts are unavailable.'};value.stale=true;
  const ui=await page(t,{coin,respond:path=>path.includes('/rewards?')?value:undefined});assert.match(ui.document.querySelector('[data-reward-metric="completed"]').textContent,/4buys/);assert.match(ui.document.querySelector('[data-reward-metric="claimed"]').textContent,/—/);assert.match(ui.document.querySelector('[data-reward-metric="burned"]').textContent,/400,000/);assert.match(ui.get('coin-rewards-note').textContent,/Balances delayed/);assert.match(ui.get('coin-rewards-note').textContent,/Earlier claim amounts are unavailable/);
});
test('public reward activity uses only a verified Solscan account URL and coverage remains explicit',async t=>{
  const coin=token({feeMode:'holders'}),value=rewards();value.activityUrl='https://solscan.io/account/'+POOL;value.holder={...value.holder,historyComplete:false,historyNote:'Earlier payout records are incomplete.',unclaimedScope:'curve_and_pool',unclaimedNote:'Verified curve and pool quote fees.',unclaimedBaseTokens:'25',withheldStale:true};
  const ui=await page(t,{coin,respond:path=>path.includes('/rewards?')?value:undefined});const activity=ui.get('coin-rewards').querySelector('.coin-rewards-activity');assert.equal(activity.hidden,false);assert.equal(activity.href,value.activityUrl);assert.equal(activity.rel,'noopener noreferrer');assert.match(ui.document.querySelector('[data-reward-metric="unclaimed"]').textContent,/Unclaimed creator fees/);assert.match(ui.document.querySelector('[data-reward-metric="unclaimed-tokens"]').textContent,/25EXAMPLE/);assert.match(ui.get('coin-rewards-note').textContent,/Earlier payout records are incomplete/);assert.match(ui.get('coin-rewards-note').textContent,/Verified curve and pool quote fees/);
  assert.match(ui.get('coin-rewards-note').textContent,/Transfer-fee balance is delayed/);value.activityUrl='https://solscan.io.evil.invalid/account/'+POOL;await ui.app.refreshRewards(true);assert.equal(activity.hidden,true);assert.equal(activity.hasAttribute('href'),false);
});
test('reward responses must match mint, mode, and quote; failures back off independently',async t=>{
  const coin=token({feeMode:'holders'}),ui=await page(t,{coin,respond:path=>path.includes('/rewards?')?rewards('buyback'):undefined});assert.match(ui.get('coin-rewards-note').textContent,/did not match/);assert.equal(ui.get('coin-rewards-state').textContent,'Unavailable');assert.match(ui.document.querySelector('[data-reward-metric="distributed"]').textContent,/—/);const before=ui.calls.filter(call=>call.path.includes('/rewards?')).length;await ui.app.refreshRewards(true);await ui.tick(1000);assert.equal(ui.calls.filter(call=>call.path.includes('/rewards?')).length,before);assert.equal(ui.get('coin-content').hidden,false);
});

test('public holder card identifies associated conversion and creator collection wallets explicitly',async t=>{
  const coin=token({feeMode:'holders'}),data=rewards('holders',{wallets:{status:'active',creatorAddress:MINT,rewardsAddress:POOL},activityUrl:'https://solscan.io/account/'+POOL});const ui=await page(t,{coin,respond:path=>path.includes('/rewards?')?data:undefined}),roles=ui.get('coin-rewards-wallets');
  assert.equal(roles.hidden,false);assert.match(roles.textContent,/separate wallet for reward conversions and holder payouts/);assert.deepEqual([...roles.querySelectorAll('a')].map(link=>[link.textContent,link.href,link.rel]),[['Reward wallet ↗','https://solscan.io/account/'+POOL,'noopener noreferrer'],['Creator collection wallet ↗','https://solscan.io/account/'+MINT,'noopener noreferrer']]);
  data.wallets={status:'active',creatorAddress:MINT,rewardsAddress:'javascript:alert(1)'};await ui.app.refreshRewards(true);assert.equal(roles.hidden,true);assert.equal(roles.querySelectorAll('a').length,0);
  data.wallets={status:'unavailable',creatorAddress:MINT,rewardsAddress:POOL};await ui.app.refreshRewards(true);assert.match(roles.textContent,/balances are unavailable/);assert.equal(roles.querySelectorAll('a').length,0);
});

test('seconds selector uses actual trade candles and creator stays next to token address',async t=>{
  const coin=token({creator:{username:'sunrise'}}),ui=await page(t,{coin,respond:path=>path.includes('/market?')?{coin,native:native({trades:[{time:1700000100,amount:100,quote:2}],candles:[]})}:undefined});
  ui.document.querySelector('[data-coin-interval="1"]').onclick();
  assert.equal(ui.charts[0].updates.at(-1).options.candles[0].close,.02);
  assert.deepEqual(ui.charts[0].updates.at(-1).points,[]);
  assert(ui.get('coin-creator').parentElement.classList.contains('coin-address-row'));
  assert.equal(ui.get('coin-creator').querySelector('a').getAttribute('href'),'/user/sunrise');
  assert.match(ui.get('coin-description-section').textContent,/Description:/);
});
test('public trades and holders show actual paired amounts and explorer links',async t=>{
  const ui=await page(t,{respond:path=>path.includes('/trades?')?{mint:MINT,available:true,quote:{symbol:'WBTC'},trades:[{time:NOW/1000,side:'buy',quote:2,amount:100,wallet:QUOTE,signature:'2'.repeat(88)}]}:path.includes('/holders?')?{mint:MINT,available:true,holders:[{wallet:QUOTE,tokenAccount:POOL,amount:'2500',percent:25,isLp:true,lpType:'curve'}]}:undefined});
  assert.match(ui.get('coin-activity-table').textContent,/WBTC/);assert.match(ui.get('coin-activity-table').textContent,/Buy/);
  assert(ui.get('coin-activity-table').querySelector('a').href.includes('/tx/'));
  ui.document.querySelector('[data-activity="holders"]').onclick();await flush();
  assert.match(ui.get('coin-activity-table').textContent,/25%/);assert.equal(ui.get('coin-activity-table').querySelector('.holder-lp-badge').textContent,'LP');
});
test('holder refresh failure preserves previously loaded balances',async t=>{
  let fail=false;const ui=await page(t,{respond:path=>path.includes('/holders?')?(fail?{mint:MINT,available:false,holders:[],note:'RPC busy.'}:{mint:MINT,available:true,holders:[{wallet:QUOTE,tokenAccount:POOL,amount:'2500',percent:25}]}):undefined});
  ui.document.querySelector('[data-activity="holders"]').onclick();await flush();assert.match(ui.get('coin-activity-table').textContent,/2,500/);
  fail=true;await ui.get('coin-activity-refresh').onclick();assert.match(ui.get('coin-activity-table').textContent,/2,500/);assert.match(ui.get('coin-activity-note').textContent,/last available/);
});

test('retained stale candle and seconds history is visibly marked as delayed',async t=>{
  const ui=await page(t,{respond:path=>path.includes('/market?')?{coin:token(),native:native({historyStale:true,tradesStale:true,trades:[{time:1700000100,amount:100,quote:2}]})}:undefined});
  assert.match(ui.get('coin-curve-caption').textContent,/History delayed/);
  ui.document.querySelector('[data-coin-interval="15"]').onclick();assert.match(ui.get('coin-curve-caption').textContent,/History delayed/);
});


test('public holder and buyback cards distinguish scheduled retries from paused automation',async t=>{
  for(const mode of ['holders','buyback']){
    const coin=token({feeMode:mode});let data=rewards(mode,{status:'retrying',retryAt:NOW+30000});
    const ui=await page(t,{coin,respond:path=>path.includes('/rewards?')?data:undefined});
    assert.equal(ui.get('coin-rewards-state').textContent,'Retry scheduled');assert.match(ui.get('coin-rewards-schedule').textContent,/Next automatic check:/);
    assert.match(ui.document.querySelector('[data-reward-metric="'+(mode==='holders'?'collecting':'pending')+'"]').textContent,/remain recorded/);
    assert.equal(ui.calls.some(call=>call.options.method!=='GET'),false);
    data={...data,status:'paused',enabled:false};await ui.app.refreshRewards(true);
    assert.equal(ui.get('coin-rewards-state').textContent,'Paused');assert.doesNotMatch(ui.get('coin-rewards-schedule').textContent,/Next automatic check/);assert.match(ui.get('coin-rewards-schedule').textContent,/paused/);
    data={...data,status:'processing',enabled:true,retryAt:null};await ui.app.refreshRewards(true);assert.equal(ui.get('coin-rewards-state').textContent,'Processing');
  }
});

test('malformed public retry times remain unavailable and never render markup or Invalid Date',async t=>{
  const coin=token({feeMode:'holders'});let data=rewards('holders',{status:'retrying',retryAt:'<img src=x onerror=bad()>'});
  const ui=await page(t,{coin,respond:path=>path.includes('/rewards?')?data:undefined});
  assert.notEqual(ui.get('coin-rewards-state').textContent,'Retry scheduled');assert.doesNotMatch(ui.get('coin-rewards-schedule').textContent,/Next automatic check/);assert.equal(ui.get('coin-rewards').querySelector('img'),null);
  data={...data,retryAt:8640000000000001};await ui.app.refreshRewards(true);assert.doesNotMatch(ui.get('coin-rewards').textContent,/Invalid Date|Next automatic check/);
});


test('token pair badge and details show the local quote logo with readable fallback',async t=>{
  const ui=await page(t),badge=ui.get('coin-pair');assert.equal(badge.textContent,'Paired with USDC');const image=badge.querySelector('.quote-identity img');assert(image.src.startsWith('/quote-logos/'+QUOTE+'.'));image.onerror();assert.equal(badge.textContent,'Paired with USDC');assert.equal(badge.querySelector('.quote-identity img'),null);assert(ui.get('coin-details').querySelector('.quote-identity img').src.startsWith('/quote-logos/'+QUOTE+'.'));
});

test('token pair and details display the correct AMM and update after graduation',async t=>{
  for(const [platform,name] of [['pumpswap','PumpSwap'],['raydium','Raydium']]){
    let coin=token({platform});
    const ui=await page(t,{coin,respond:path=>path.includes('/market?')?{coin,native:native(),pool:null,at:NOW}:undefined});
    assert.equal(ui.get('coin-pair').querySelector('.launch-amm-badge').title,'Graduates to '+name);assert.equal(ui.get('coin-error').textContent,'');assert.equal(ui.get('coin-details').querySelector('.launch-amm-badge').dataset.amm,platform);
    coin={...coin,stage:'graduated',curveStatus:'migrated'};await ui.app.refresh(true);
    assert.equal(ui.get('coin-pair').querySelector('.launch-amm-badge').title,'Graduated to '+name);assert.equal(ui.get('coin-details').querySelector('.launch-amm-badge').getAttribute('aria-label'),'Graduated to '+name);
  }
});


test('official LAUNCHPAD token detail uses current site art without changing stored images or symbol-only coins',async t=>{
  const image='/token-images/'+'a'.repeat(64)+'.webp',coin=token({mint:OFFICIAL_TOKEN_MINT,symbol:'LAUNCHPAD',image});
  const official=await page(t,{mint:OFFICIAL_TOKEN_MINT,coin});assert.equal(official.get('coin-avatar').querySelector('img').src,'/brand-icon.png?v=54');assert.equal(coin.image,image);
  const unrelated=await page(t,{coin:token({symbol:'LAUNCHPAD',image})});assert.equal(unrelated.get('coin-avatar').querySelector('img').src,image);
  const unsafe=await page(t,{coin:token({symbol:'LAUNCHPAD',image:'https://evil.invalid/curve.png'})});assert.equal(unsafe.get('coin-avatar').querySelector('img'),null);
});

test('market refresh preserves metadata images and stat rows while live values and metadata changes still update',async t=>{
  let revision=1,fdv=20000,metadata='Example coin';const current=()=>token({name:metadata,image:'/token-images/'+'a'.repeat(64)+'.webp',creator:{username:'creator',avatar:'/token-images/'+'b'.repeat(64)+'.png',bio:'Bio'},fdvUsd:fdv,marketAt:revision});
  const ui=await page(t,{coin:current(),respond:path=>path.includes('/market?')?{coin:current(),native:native({fdvUsd:fdv,at:NOW+revision}),pool:null,at:NOW+revision}:undefined});
  const avatar=ui.get('coin-avatar').querySelector('img'),pair=ui.get('coin-pair'),creator=ui.get('coin-creator').firstElementChild,stats=[...ui.get('coin-stats').children],create=ui.document.createElement.bind(ui.document);let elements=0,images=0;
  ui.document.createElement=(tag,...args)=>{elements++;if(tag==='img')images++;return create(tag,...args);};
  revision++;await ui.app.refresh(true);const unchanged={elements,images};
  elements=images=0;fdv=25000;revision++;await ui.app.refresh(true);const changed={elements,images};
  t.diagnostic('Coin: timestamp-only refresh '+JSON.stringify(unchanged)+'; market value refresh '+JSON.stringify(changed));
  assert.equal(unchanged.images,0);assert.equal(changed.images,0);assert.equal(ui.get('coin-avatar').querySelector('img'),avatar);assert.equal(ui.get('coin-pair'),pair);assert.equal(ui.get('coin-creator').firstElementChild,creator);assert.deepEqual([...ui.get('coin-stats').children],stats);assert.match(ui.get('coin-cap').textContent,/25/);
  metadata='Renamed coin';revision++;await ui.app.refresh(true);assert.equal(ui.get('coin-name').textContent,'Renamed coin');
});

test('Refresh asks again at once after a failed market or reward update while automatic refreshes keep backing off',async t=>{
  let fail=false;const ui=await page(t,{coin:token({feeMode:'holders'}),respond:path=>fail&&(path.includes('/market?')||path.includes('/rewards?'))?{status:503,body:{error:'Market information is temporarily unavailable.'}}:path.includes('/rewards?')?rewards('holders'):undefined});
  const reads=kind=>ui.calls.filter(call=>call.path.includes('/explore/'+kind+'?')).length;
  fail=true;await ui.app.refresh(true);await ui.app.refreshRewards(true);assert.match(ui.get('coin-market-note').textContent,/temporarily unavailable/);assert.match(ui.get('coin-rewards-note').textContent,/temporarily unavailable/);
  const market=reads('market'),reward=reads('rewards');fail=false;await ui.tick(1000);await ui.app.refresh(true);assert.equal(reads('market'),market,'automatic and programmatic refreshes keep the backoff');
  await ui.get('coin-refresh').onclick();assert.equal(reads('market'),market+1);assert.equal(reads('rewards'),reward+1);assert.doesNotMatch(ui.get('coin-market-note').textContent,/temporarily unavailable/);assert.doesNotMatch(ui.get('coin-rewards-note').textContent,/temporarily unavailable/);
  fail=true;await ui.app.refreshRewards(true);fail=false;const again=reads('rewards');await ui.get('coin-rewards-refresh').onclick();assert.equal(reads('rewards'),again+1,'the rewards Refresh also asks at once');
});

test('busy Refresh buttons stay focusable for keyboard users and ignore repeated presses',async t=>{
  let hold=null;const ui=await page(t,{coin:token({feeMode:'holders'}),respond:path=>hold&&path.includes('/market?')?hold.promise.then(()=>undefined):path.includes('/rewards?')?rewards('holders'):undefined});
  let release;hold={promise:new Promise(resolve=>release=resolve)};const button=ui.get('coin-refresh'),pending=button.onclick();
  assert.equal(button.getAttribute('aria-disabled'),'true');assert.equal(button.disabled,false);const calls=ui.calls.length;await ui.app.refresh(true,true);assert.equal(ui.calls.length,calls,'one market request at a time');
  hold=null;release();await pending;assert.equal(button.hasAttribute('aria-disabled'),false);
  const activity=ui.get('coin-activity-refresh'),loading=activity.onclick();assert.equal(activity.getAttribute('aria-disabled'),'true');assert.equal(activity.disabled,false);await loading;assert.equal(activity.hasAttribute('aria-disabled'),false);
  const rewardsButton=ui.get('coin-rewards-refresh'),reading=ui.app.refreshRewards(true,true);assert.equal(rewardsButton.getAttribute('aria-disabled'),'true');assert.equal(rewardsButton.disabled,false);const before=ui.calls.length;rewardsButton.onclick();assert.equal(ui.calls.length,before);await reading;assert.equal(rewardsButton.hasAttribute('aria-disabled'),false);
});

test('Copy shows its result on the button and clears it, and the announcement is for screen readers only',async t=>{
  const timers=[];let denied=false;const ui=await page(t,{windowPatch:{setTimeout:(fn,ms)=>{if(ms<15000)timers.push({fn,ms});return setTimeout(()=>{},0);},navigator:{clipboard:{writeText:async()=>{if(denied)throw Error('denied');}}}}}),button=ui.get('coin-copy');
  await button.onclick();assert.equal(button.textContent,'Copied ✓');assert.equal(ui.get('coin-announcement').textContent,'Token address copied.');
  const reset=timers.find(timer=>timer.ms===2500);assert(reset);reset.fn();assert.equal(button.textContent,'Copy');assert.equal(ui.get('coin-announcement').textContent,'');
  denied=true;await button.onclick();assert.equal(button.textContent,'Copy failed');assert.equal(ui.get('coin-announcement').textContent,'Copy this address: '+MINT);timers.at(-1).fn();assert.equal(button.textContent,'Copy');
  const css=await readFile(new URL('../public/coin.css',import.meta.url),'utf8');assert.match(css,/\.coin-announcement \{ position:absolute; width:1px; height:1px;/);
});

test('an unknown coin names itself in the title and a trailing space in the mint link is ignored',async t=>{
  const missing=await page(t,{respond:()=>({status:404,body:{error:'Not found'}})});assert.equal(missing.document.title,'Coin not found — Launchpad');assert.match(missing.get('coin-error').textContent,/not listed/);
  const spaced=await page(t,{mint:MINT+' '});assert.equal(spaced.get('coin-content').hidden,false);assert.equal(spaced.get('coin-error').hidden,true);assert(spaced.calls.every(call=>!call.path.includes('%20')));assert.equal(spaced.document.title,'EXAMPLE — Launchpad');
});

test('a Gotchi coin still on its curve funds the pot without racing; a graduated one is racing',async t=>{
  const gotchi=stage=>({mint:MINT,mode:'gotchi',quote:{mint:QUOTE,symbol:'USDC'},gotchi:{id:'fomogotchi',theme:'fomogotchi'},stage});
  const curve=await page(t,{coin:token({feeMode:'gotchi',gotchi:{id:'fomogotchi'}}),respond:path=>path.includes('/rewards?')?gotchi('new'):undefined});
  assert.equal(curve.get('coin-rewards-state').textContent,'Not racing yet');assert.equal(curve.get('coin-rewards-state').dataset.state,'paused');assert.match(curve.get('coin-rewards-note').textContent,/Only graduated coins compete/);
  const graduated=await page(t,{coin:token({feeMode:'gotchi',gotchi:{id:'fomogotchi'},stage:'graduated',curveStatus:'migrated'}),respond:path=>path.includes('/rewards?')?gotchi('graduated'):undefined});
  assert.equal(graduated.get('coin-rewards-state').textContent,'Racing');assert.equal(graduated.get('coin-rewards-state').dataset.state,'enabled');
});

test('an #agent link scrolls to the agent once it has rendered, unless the visitor moved first',async t=>{
  for(const moved of [false,true]){
    let scrolled=null,release;const held=new Promise(resolve=>release=resolve),wait=async ready=>{for(let i=0;i<100&&!ready();i++)await new Promise(resolve=>setTimeout(resolve,10));await flush();};
    const ui=await page(t,{coin:token({feeMode:'agent',agent:{id:'agent-one'}}),windowPatch:{location:{search:'?mint='+MINT,hash:'#agent'}},
      prepare:document=>{const host=document.getElementById('coin-agent');host.scrollIntoView=options=>{scrolled={options,text:host.textContent};};},
      respond:path=>path.startsWith('/api/launchpad/agents/')?held.then(()=>({status:503,body:{error:'AI Agent mode is not enabled on this host.'}})):undefined});
    const host=ui.get('coin-agent');await wait(()=>ui.calls.some(call=>call.path.startsWith('/api/launchpad/agents/')));
    assert.equal(scrolled,null,'the loading placeholder is not scrolled to');
    if(moved)ui.events.get('wheel')?.();
    release();await wait(()=>/not enabled/.test(host.textContent));
    if(moved)assert.equal(scrolled,null,'the visitor kept their position');
    else{assert(scrolled,'scrolled to the agent');assert.deepEqual(scrolled.options,{block:'start'});assert.match(scrolled.text,/not enabled/,'scrolled after the agent section rendered');}
  }
});
