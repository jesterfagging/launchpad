import {OFFICIAL_TOKEN_MINT} from '../public/coin-image.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createExplorePage, explorePageSize } from '../public/explore.js';
import { createExploreCard, exploreFilters, exploreAge } from '../public/explore-view.mjs';

const MINT='So11111111111111111111111111111111111111112',QUOTE='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',NOW=1700000100000;
const coin=(patch={})=>({mint:MINT,name:'Example coin',symbol:'EXAMPLE',createdAt:NOW-60000,stage:'new',curveStatus:'curve',quote:{mint:QUOTE,symbol:'USDC',category:'crypto'},feeMode:'creator',priceUsd:.000021,fdvUsd:21000,marketCapUsd:null,volume24h:null,progressPercent:45,...patch});
const payload=(stage,patch={})=>({coins:[coin({stage:stage==='graduated'?'graduated':'new',movingReason:stage==='moving'?'progress':null})],total:1,offset:0,limit:10,nextOffset:null,counts:{all:3,new:2,graduated:1,moving:1},quotes:[{mint:QUOTE,symbol:'USDC',category:'crypto'}],at:NOW,refreshMs:30000,stale:false,...patch});
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
// The paging fixtures below use 10-card pages (offsets 10/20, totals of 21); the page fills whole grid
// rows in the browser (explorePageSize, covered by its own test), so these tests pin pageSize to 10.
async function page(t,{respond,respondUsers,respondUpdates,search='',authenticated=false,random=()=>0,pageSize=10,innerWidth,storage,robinhood='on'}={}){
  const {document,window}=parseHTML(await readFile(new URL('../public/explore.html',import.meta.url),'utf8'));
  // v71.43: the server writes <body data-robinhood="off"> on a host without LAUNCHPAD_ROBINHOOD_ENABLED=1.
  document.body.dataset.robinhood=robinhood;
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return [...this.options].find(o=>o.selected)?.value||this.options[0]?.value||'';},set(value){for(const o of this.options)o.removeAttribute('selected');const option=[...this.options].find(o=>o.value===String(value));option?.setAttribute('selected','');}});
  Object.defineProperty(document,'hidden',{value:false,writable:true});let now=NOW;const calls=[],paths=[],shells=[],events=new Map(),timers=[];
  const environment={location:{search},history:{replaceState:(_,__,path)=>paths.push(path)},setTimeout,clearTimeout,addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:(name,fn)=>{if(events.get(name)===fn)events.delete(name);},...(innerWidth===undefined?{}:{innerWidth}),...(storage?{localStorage:storage}:{})};
  const fetcher=async(path,options)=>{calls.push({path,options});if(path==='/api/session')return{ok:true,json:async()=>({authenticated,account:authenticated?{username:'sunrise_user',role:'user'}:null})};if(path==='/api/explore/updates'){const data=(await respondUpdates?.(options))??{version:'a'.repeat(64),total:3,stale:false,refreshMs:10000};return {ok:!data.error,status:data.error?503:200,json:async()=>data};}const query=new URL(path,'https://app.example').searchParams;let data=path.startsWith('/api/explore/users?')?(await respondUsers?.(query,options))??{users:[],total:0,offset:0,limit:12,nextOffset:null}:await respond?.(query,options);data??=payload(query.get('stage'));return {ok:!data.error,status:data.error?503:200,json:async()=>data};};
  const app=createExplorePage({document,window:environment,fetcher,random,pageSize:innerWidth===undefined?pageSize:undefined,clock:()=>now,setTimer:(fn,ms)=>{timers.push({fn,ms,cleared:false});return timers.length;},clearTimer:id=>{timers[id-1].cleared=true;},shell:args=>shells.push(args)});t.after(()=>app.destroy());await app.ready;await flush();
  return {app,document,calls,paths,shells,events,timers,get:id=>document.getElementById(id),async tick(ms){now+=ms;await app.tick();await flush();}};
}
test('public homepage loads the selected New cohort only and requires no account credentials',async t=>{
  const ui=await page(t);assert.equal(ui.document.querySelectorAll('.explore-coin').length,1);assert.equal(ui.get('explore-account').textContent,'Connect wallet');assert.equal(ui.shells[0].page,'explore');assert.match(ui.get('explore-status').textContent,/3 Launchpad coins/);
  assert.deepEqual(ui.calls.filter(row=>row.path.startsWith('/api/explore?')&&new URL(row.path,'https://app.example').searchParams.get('limit')==='10').map(row=>new URL(row.path,'https://app.example').searchParams.get('stage')),['new']);assert(ui.calls.every(row=>row.options.method==='GET'));assert(ui.calls.every(row=>!row.options.headers));assert.equal(ui.document.querySelector('.explore-coin').getAttribute('href'),'/coin?mint='+MINT);
});
test('cards use real FDV without substituting launch valuation or inventing missing volume',async t=>{
  const ui=await page(t);const card=ui.get('explore-new-grid').querySelector('.explore-coin');assert.match(card.textContent,/\$21KFDV/);assert.match(card.textContent,/— vol \/ 24h/);assert.match(card.textContent,/45.0%/);assert(!card.textContent.includes('$20K'));assert(!card.textContent.includes('MC'));
  const missing=createExploreCard(ui.document,coin({fdvUsd:null,progressPercent:null}));assert.match(missing.textContent,/—FDV · USD/);assert.equal(missing.querySelector('progress'),null);
  const native=createExploreCard(ui.document,coin({fdvUsd:null,fdvQuote:.2,quote:{symbol:'WBTC'}}));assert.match(native.textContent,/—FDV · USD/);assert.doesNotMatch(native.textContent,/0.2 WBTC/);
});
test('malicious metadata stays text and external image or navigation payloads are ignored',async t=>{
  const ui=await page(t,{respond:query=>payload(query.get('stage'),{coins:[coin({name:'<img src=x onerror=steal()>',symbol:'<script>',image:'javascript:bad()',href:'https://attacker.example',description:'<svg onload=bad()>'})]})});const card=ui.document.querySelector('.explore-coin');assert.equal(card.querySelector('.explore-coin-name').textContent,'<img src=x onerror=steal()>');assert.equal(card.querySelector('.explore-coin-image img'),null);assert([...card.querySelectorAll('img')].every(image=>image.src.startsWith('/quote-logos/')));assert.equal(card.querySelector('script'),null);assert.equal(card.getAttribute('href'),'/coin?mint='+MINT);
  assert.equal(createExploreCard(ui.document,coin({mint:'../private'})),null);
  const imageCard=createExploreCard(ui.document,coin({image:'/token-images/'+'a'.repeat(64)+'.webp'}));const image=imageCard.querySelector('.explore-coin-image>img');assert(image);image.onerror();assert.equal(imageCard.querySelector('.explore-coin-image>img'),null);assert.equal(imageCard.querySelector('.explore-coin-image').firstElementChild.hidden,false);
});
test('category and age changes reset the selected feed and retain only visible filters',async t=>{
  const ui=await page(t,{search:'?quote='+QUOTE+'&feeMode=holders',respond:q=>payload(q.get('stage'),{total:21,nextOffset:Number(q.get('offset'))===0?10:Number(q.get('offset'))===10?20:null})});
  await ui.app.page('new',10);assert.match(ui.get('explore-new-pagination').textContent,/Page 2 of 3/);
  await ui.document.querySelector('[data-explore-category="stocks"]').onclick();await ui.document.querySelector('[data-explore-age="24h"]').onclick();
  const query=new URL(ui.calls.at(-1).path,'https://launchpad.example').searchParams;assert.equal(query.get('category'),'stocks');assert.equal(query.get('age'),'24h');assert.equal(query.get('offset'),'0');assert.equal(query.has('quote'),false);assert.equal(query.has('feeMode'),false);
  assert.equal(ui.document.querySelector('[data-explore-category="stocks"]').getAttribute('aria-pressed'),'true');assert.equal(ui.document.querySelector('[data-explore-age="24h"]').getAttribute('aria-pressed'),'true');
  assert(ui.paths.at(-1).startsWith('/explore?'));await ui.app.apply({search:'',category:'all',age:'all'});assert.equal(ui.paths.at(-1),'/');
});
test('newer filters win over stale in-flight requests even if transport ignores abort',async t=>{
  let release;const ui=await page(t,{respond:q=>q.get('search')==='old'?new Promise(resolve=>{if(q.get('stage')==='new')release=()=>resolve(payload('new',{coins:[coin({name:'Old result'})]}));else resolve(payload(q.get('stage')));}):q.get('search')==='fresh'?payload(q.get('stage'),{coins:[coin({name:'Fresh result'})]}):undefined});
  const old=ui.app.apply({search:'old'});await flush();const fresh=ui.app.apply({search:'fresh'});await fresh;release();await old;assert.match(ui.get('explore-new-grid').textContent,/Fresh result/);assert(!ui.get('explore-new-grid').textContent.includes('Old result'));assert.match(ui.paths.at(-1),/search=fresh/);
});
test('refresh is coalesced, keeps card nodes stable, updates ages and pauses while hidden',async t=>{
  let waiting=false,releases=[];const ui=await page(t,{respond:q=>waiting?new Promise(resolve=>releases.push(()=>resolve(payload(q.get('stage'))))):undefined});const card=ui.document.querySelector('.explore-coin'),count=ui.calls.length;await ui.tick(1000);assert.equal(ui.calls.length,count);assert.match(card.querySelector('time').textContent,/1m ago/);
  waiting=true;const first=ui.app.refresh();const second=ui.app.refresh();assert.equal(ui.calls.length,count+1);for(const release of releases)release();await first;await second;assert.equal(ui.document.querySelector('.explore-coin'),card);
  ui.document.hidden=true;await ui.tick(60000);assert.equal(ui.calls.length,count+1);
});
test('temporary errors preserve cards and show delayed status with a retry action',async t=>{
  let fail=false;const ui=await page(t,{respond:()=>fail?{error:'Provider secret https://private.invalid',retryAfterMs:60000}:undefined});const card=ui.get('explore-new-grid').querySelector('.explore-coin');fail=true;await ui.app.refresh();assert.equal(ui.get('explore-new-grid').querySelector('.explore-coin'),card);assert.match(ui.get('explore-new-message').textContent,/last available coins/);assert(ui.get('explore-new-message').querySelector('button'));assert.match(ui.get('explore-status').textContent,/delayed/);assert(!ui.document.body.textContent.includes('private.invalid'));const reads=()=>ui.calls.filter(call=>call.path.startsWith('/api/explore?')&&new URL(call.path,'https://launchpad.example').searchParams.get('limit')==='10').length,count=reads();await ui.tick(30000);assert.equal(reads(),count);
});
test('empty cohorts explain the criteria and authenticated users can reach their account',async t=>{
  const ui=await page(t,{authenticated:true,respond:q=>payload(q.get('stage'),{coins:[],total:0,counts:{all:0,new:0,moving:0,graduated:0}})});await ui.document.querySelector('button[data-explore-stage="moving"]').onclick();assert.match(ui.get('explore-moving-grid').textContent,/curve reaches 35%/);await ui.document.querySelector('button[data-explore-stage="graduated"]').onclick();assert.match(ui.get('explore-graduated-grid').textContent,/graduation is confirmed/);assert.equal(ui.shells.at(-1).session.account.username,'sunrise_user');assert.equal(ui.shells.at(-1).session.authenticated,true);assert.equal(ui.document.querySelectorAll('.explore-coin').length,0);
});
test('a shrinking live cohort returns an out-of-range page to its last available page',async t=>{
  let total=21;const ui=await page(t,{respond:q=>payload(q.get('stage'),{total,nextOffset:Number(q.get('offset'))+10<total?Number(q.get('offset'))+10:null,coins:Number(q.get('offset'))>=total?[]:[coin()]})});await ui.app.page('new',20);assert.match(ui.get('explore-new-pagination').textContent,/Page 3 of 3/);total=11;await ui.app.refresh();assert.match(ui.get('explore-new-pagination').textContent,/Page 2 of 2/);assert.equal(ui.get('explore-new-grid').querySelectorAll('.explore-coin').length,1);
});
test('main tabs sort one combined feed while cohort tabs retain their matching stage',async t=>{
  const ui=await page(t);for(const id of ['explore-quote','explore-rewards','explore-age','explore-sort','explore-clear','explore-refresh'])assert.equal(ui.get(id),null);
  for(const [mode,sort]of [['oldest','oldest'],['volume','volume'],['recentBuys','recentBuys'],['all','newest']]){
    await ui.document.querySelector('button[data-explore-stage="'+mode+'"]').onclick();
    const q=new URL(ui.calls.at(-1).path,'https://launchpad.example').searchParams;assert.equal(q.get('stage'),'all');assert.equal(q.get('sort'),sort);assert.equal(ui.get('explore-all').hidden,false);
    for(const cohort of ['new','moving','graduated'])assert.equal(ui.get('explore-'+cohort).hidden,true);
    assert.equal(ui.get('explore-main').dataset.exploreStage,mode);assert.equal(ui.get('explore-coins').onclick,null);
  }
  for(const mode of ['new','moving','graduated']){await ui.document.querySelector('button[data-explore-stage="'+mode+'"]').onclick();assert.equal(ui.get('explore-'+mode).hidden,false);assert.equal(ui.get('explore-all').hidden,true);}
  for(const [feeMode,label]of [['creator','Creator fees'],['holders','Holder rewards'],['buyback','Agent buyback']])assert.equal(createExploreCard(ui.document,coin({feeMode})).querySelector('.explore-coin-badges').textContent,label);
});
test('URL filters reject unknown enums, clip search and preserve supported values',()=>{
  assert.deepEqual(exploreFilters(new URLSearchParams('category=bad&feeMode=private&quote=javascript:bad&sort=secret&age=forever&launchMode=bad&chain=ethereum')), {search:'',category:'all',launchMode:'all',chain:'all',feeMode:'',quote:'',sort:'newest',age:'all'});
  // v71.41: the chain switch is a filter of its own — Solana, Robinhood, or all of them.
  assert.equal(exploreFilters(new URLSearchParams('chain=robinhood')).chain,'robinhood');assert.equal(exploreFilters(new URLSearchParams('chain=solana')).chain,'solana');assert.equal(exploreFilters(new URLSearchParams('chain=ROBINHOOD')).chain,'all');
  const filters=exploreFilters(new URLSearchParams('category=stocks&age=7d&sort=marketCap&search='+'a'.repeat(200)));assert.equal(filters.search.length,100);assert.equal(filters.category,'stocks');assert.equal(filters.sort,'marketCap');assert.equal(exploreAge(null),'Age unavailable');assert.equal(exploreAge(NOW+100,NOW),'0s ago');
  assert.equal(exploreFilters(new URLSearchParams('category=preipo')).category,'preipo');assert.equal(exploreAge(1e100),'Age unavailable');
});

// v71.41: the home page's All | Solana | Robinhood switch.
const RH_TOKEN='0x1111111111111111111111111111111111111111',RH_PAIR='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const rhCoin=(patch={})=>coin({mint:RH_TOKEN,chain:'robinhood',launchMode:'robinhood',name:'Hood coin',symbol:'HOOD',coinUrl:'/coin?mint='+RH_TOKEN+'&chain=robinhood',quote:{mint:RH_PAIR,symbol:'USDG',name:'USDG',category:'crypto',logo:'/robinhood-pairs/logo/'+RH_PAIR},marketCapUsd:12000,fdvUsd:12000,...patch});
const memory=()=>{const map=new Map();return {getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),map};};
test('the chain switch filters the feed by chain, hides the AMM row on Robinhood, renders Robinhood cards with their pool badge and is remembered',async t=>{
  const storage=memory();
  const ui=await page(t,{storage,respond:q=>q.get('chain')==='robinhood'?payload(q.get('stage'),{coins:[rhCoin()]}):q.get('chain')==='solana'?payload(q.get('stage')):payload(q.get('stage'),{coins:[coin(),rhCoin()]})});
  const buttons=Object.fromEntries([...ui.document.querySelectorAll('[data-explore-chain]')].map(b=>[b.dataset.exploreChain,b]));assert.deepEqual(Object.keys(buttons),['all','solana','robinhood']);
  assert.equal(buttons.all.getAttribute('aria-pressed'),'true');assert.equal(new URL(ui.calls.find(c=>c.path.startsWith('/api/explore?stage=')&&c.path.includes('offset=')).path,'https://launch.example').searchParams.get('chain'),'all');
  // All: both chains' cards; the Robinhood card links to its own coin page and carries the pool badge and the pair badge the host serves.
  const cards=[...ui.get('explore-new-grid').querySelectorAll('.explore-coin')];assert.equal(cards.length,2);const rh=cards.find(c=>c.dataset.chain==='robinhood');assert(rh);
  assert.equal(rh.getAttribute('href'),'/coin?mint='+RH_TOKEN+'&chain=robinhood');assert.equal(rh.querySelector('.launch-amm-badge').dataset.amm,'robinhood');assert.equal(rh.querySelector('.launch-amm-badge').title,'Uniswap v4 pool on Robinhood Chain');
  assert.equal(rh.querySelector('.explore-coin-pair-robinhood img').getAttribute('src'),'/robinhood-pairs/logo/'+RH_PAIR);assert.match(rh.querySelector('.explore-coin-pair-robinhood').title,/USDG on Robinhood Chain/);
  // Robinhood: the request carries the chain, the launch-mode row has no meaning there and hides, the choice is remembered.
  await ui.document.querySelector('[data-explore-launch-mode="meteora"]').onclick();
  // v71.42: a chain change also redraws the highlights, so the feed request is found by its offset rather than taken as the last call.
  const lastFeed=page=>new URL(page.calls.filter(c=>/[?&]offset=/.test(c.path)).at(-1).path,'https://launch.example').searchParams;
  await buttons.robinhood.onclick();let q=lastFeed(ui);assert.equal(q.get('chain'),'robinhood');assert.equal(q.get('launchMode'),'all');assert.equal(q.get('offset'),'0');
  assert.equal(buttons.robinhood.getAttribute('aria-pressed'),'true');assert.equal(buttons.all.getAttribute('aria-pressed'),'false');assert.equal(ui.document.querySelector('.explore-amm-options').hidden,true);
  assert.equal(new URL(ui.paths.at(-1),'https://launch.example').searchParams.get('chain'),'robinhood');assert.equal(storage.getItem('curve.explore.chain'),'robinhood');
  assert.equal(ui.get('explore-new-grid').querySelectorAll('.explore-coin').length,1);assert.equal(ui.get('explore-new-grid').querySelector('.explore-coin').dataset.chain,'robinhood');
  // Solana, then All again: the AMM row returns, the memory clears on All.
  await buttons.solana.onclick();q=lastFeed(ui);assert.equal(q.get('chain'),'solana');assert.equal(ui.document.querySelector('.explore-amm-options').hidden,false);assert.equal(storage.getItem('curve.explore.chain'),'solana');
  assert.equal(ui.get('explore-new-grid').querySelector('.explore-coin').dataset.chain,undefined);
  await buttons.all.onclick();q=lastFeed(ui);assert.equal(q.get('chain'),'all');assert.equal(storage.getItem('curve.explore.chain'),null);assert.equal(new URL(ui.paths.at(-1),'https://launch.example').searchParams.has('chain'),false);
});
test('a remembered chain comes back on the next visit unless the URL names one',async t=>{
  const storage=memory();storage.setItem('curve.explore.chain','robinhood');
  const remembered=await page(t,{storage,respond:q=>payload(q.get('stage'),{coins:[rhCoin()]})});
  assert.equal(new URL(remembered.calls.find(c=>c.path.startsWith('/api/explore?')).path,'https://launch.example').searchParams.get('chain'),'robinhood');
  assert.equal(remembered.document.querySelector('[data-explore-chain="robinhood"]').getAttribute('aria-pressed'),'true');assert.equal(remembered.document.querySelector('.explore-amm-options').hidden,true);
  const fromUrl=await page(t,{storage,search:'?chain=solana'});
  assert.equal(new URL(fromUrl.calls.find(c=>c.path.startsWith('/api/explore?')).path,'https://launch.example').searchParams.get('chain'),'solana');assert.equal(fromUrl.document.querySelector('[data-explore-chain="solana"]').getAttribute('aria-pressed'),'true');
  const broken={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');},removeItem(){throw new Error('blocked');}};
  const noStorage=await page(t,{storage:broken});await noStorage.document.querySelector('[data-explore-chain="robinhood"]').onclick();assert.equal(new URL(noStorage.calls.filter(c=>/[?&]offset=/.test(c.path)).at(-1).path,'https://launch.example').searchParams.get('chain'),'robinhood');
});

test('AMM filters use server filtering, preserve category and sort, and reset only pagination',async t=>{
  const ui=await page(t,{respond:q=>payload(q.get('stage'),{total:21,nextOffset:10,coins:[coin({launchMode:q.get('launchMode')==='meteora'?'meteora':'raydium'})]})});
  await ui.document.querySelector('[data-explore-stage="volume"]').onclick();await ui.app.apply({category:'stocks',age:'7d'});await ui.app.page('all',10);ui.document.querySelector('[data-explore-view="list"]').click();
  for(const mode of ['meteora','raydium','all']){
    await ui.document.querySelector('[data-explore-launch-mode="'+mode+'"]').onclick();
    const q=new URL(ui.calls.at(-1).path,'https://launch.example').searchParams;
    assert.equal(q.get('launchMode'),mode);assert.equal(q.get('stage'),'all');assert.equal(q.get('sort'),'volume');assert.equal(q.get('category'),'stocks');assert.equal(q.get('age'),'7d');assert.equal(q.get('offset'),'0');
    assert.equal(ui.document.querySelector('[data-explore-launch-mode="'+mode+'"]').getAttribute('aria-pressed'),'true');assert.equal(ui.document.body.classList.contains('explore-list-view'),true);
    assert.equal(new URL(ui.paths.at(-1),'https://launch.example').searchParams.get('launchMode'),mode==='all'?null:mode);
    assert.equal(ui.get('explore-all-grid').querySelector('.launch-amm-badge').dataset.amm,mode==='meteora'?'meteora':'raydium');
  }
});

test('legacy Pump AMM deep links remain functional without a public Pump filter button',async t=>{
  const ui=await page(t,{search:'?launchMode=pumpswap',respond:q=>payload(q.get('stage'),{coins:[coin({platform:'pumpswap'})]})});
  assert.equal(ui.document.querySelector('[data-explore-launch-mode="pumpswap"]'),null);
  await ui.app.refresh();const q=new URL(ui.calls.at(-1).path,'https://launch.example').searchParams;assert.equal(q.get('launchMode'),'pumpswap');
  assert.equal(ui.get('explore-new-grid').querySelector('.launch-amm-badge').title,'Graduates to PumpSwap');
  assert.equal(ui.get('explore-featured').querySelector('.launch-amm-badge').title,'Graduates to PumpSwap');
  assert.equal(ui.get('explore-leaders-list').querySelector('.launch-amm-badge').dataset.amm,'pumpswap');
  await ui.app.search.open();await ui.app.search.search('test');assert.equal(ui.document.querySelector('[data-explore-launch-mode="pumpswap"]'),null);
});

test('the earlier Meteora → PumpSwap launches have no filter button; their deep link still filters',async t=>{
  const ui=await page(t,{search:'?launchMode=damm-pump',respond:q=>payload(q.get('stage'),{coins:[coin({platform:'damm-pump'})]})});
  assert.equal(ui.document.querySelector('[data-explore-launch-mode="damm-pump"]'),null);
  assert.deepEqual([...ui.document.querySelectorAll('[data-explore-launch-mode]')].map(b=>b.textContent.trim()),['All','Pump.fun','Meteora','Raydium']);
  await ui.app.refresh();assert.equal(new URL(ui.calls.at(-1).path,'https://launch.example').searchParams.get('launchMode'),'damm-pump');
});

test('feed fallback updates every minute while unchanged lightweight launch checks leave it intact',async t=>{
 const ui=await page(t),count=()=>ui.calls.filter(c=>c.path.startsWith('/api/explore?')&&new URL(c.path,'https://launchpad.example').searchParams.get('limit')==='10').length,initial=count(),card=ui.get('explore-new-grid').firstElementChild;
 await ui.tick(10000);assert.equal(count(),initial);assert.equal(ui.calls.filter(c=>c.path==='/api/explore/updates').length,2);assert.equal(ui.get('explore-new-grid').firstElementChild,card);
 await ui.tick(49999);assert.equal(count(),initial);await ui.tick(1);assert.equal(count(),initial+1);assert.equal(ui.get('explore-new-grid').firstElementChild,card);
 ui.document.querySelector('[data-explore-view="list"]').click();assert.equal(ui.document.body.classList.contains('explore-list-view'),true);
});
test('cold market snapshots refresh the visible feed promptly, then return to normal polling',async t=>{
  let warming=true;
  const ui=await page(t,{respond:q=>payload(q.get('stage'),{refreshing:warming,refreshMs:warming?3000:30000,coins:[coin({fdvUsd:warming?null:23000,fdvQuote:100})]})});
  const reads=()=>ui.calls.filter(call=>call.path.startsWith('/api/explore?')&&new URL(call.path,'https://launchpad.example').searchParams.get('limit')==='10');
  assert.match(ui.get('explore-new-grid').textContent,/—FDV · USD/);const initial=reads().length;
  await ui.tick(2999);assert.equal(reads().length,initial);warming=false;await ui.tick(1);
  assert.equal(reads().length,initial+1);assert.match(ui.get('explore-new-grid').textContent,/\$23KFDV/);
  await ui.tick(59999);assert.equal(reads().length,initial+1);await ui.tick(1);assert.equal(reads().length,initial+2);
  assert(reads().every(call=>new URL(call.path,'https://launchpad.example').searchParams.get('stage')==='new'));
});

test('new-launch detection refreshes the selected category and mode without resetting pagination or view',async t=>{
  let version='a'.repeat(64),added=false;
  const ui=await page(t,{respondUpdates:()=>({version,stale:false}),respond:q=>payload(q.get('stage'),{total:21,nextOffset:20,coins:[coin({name:added?'Fresh reading':'Old reading'})]})});
  await ui.document.querySelector('button[data-explore-stage="volume"]').onclick();await ui.document.querySelector('[data-explore-category="stocks"]').onclick();await ui.document.querySelector('[data-explore-age="7d"]').onclick();await ui.app.page('all',10);ui.document.querySelector('[data-explore-view="list"]').click();
  const card=ui.get('explore-all-grid').firstElementChild;version='b'.repeat(64);added=true;const before=ui.calls.length;await ui.tick(10000);
  const queries=ui.calls.slice(before).filter(c=>c.path.startsWith('/api/explore?')&&new URL(c.path,'https://launchpad.example').searchParams.get('limit')==='10').map(c=>new URL(c.path,'https://launchpad.example').searchParams);
  assert.equal(queries.length,1);assert.equal(queries[0].get('stage'),'all');assert.equal(queries[0].get('sort'),'volume');assert.equal(queries[0].get('category'),'stocks');assert.equal(queries[0].get('age'),'7d');assert.equal(queries[0].get('offset'),'10');
  assert.equal(ui.get('explore-all-grid').firstElementChild,card);assert.match(card.textContent,/Fresh reading/);assert.equal(ui.document.body.classList.contains('explore-list-view'),true);assert.match(ui.get('explore-all-pagination').textContent,/Page 2 of 3/);
});

test('modal searches leave the Explore feed, filters and current page intact',async t=>{
  const ui=await page(t,{respond:q=>payload(q.get('stage'),{total:21,nextOffset:Number(q.get('offset'))+10<21?Number(q.get('offset'))+10:null})});
  await ui.app.apply({category:'stocks',age:'7d'});await ui.app.page('new',10);const card=ui.get('explore-new-grid').querySelector('.explore-coin'),path=ui.paths.at(-1),before=ui.calls.length;
  await ui.app.search.open();await ui.app.search.search('sunrise');await ui.app.search.select('users');
  assert.equal(ui.get('explore-new-grid').querySelector('.explore-coin'),card);assert.match(ui.get('explore-new-pagination').textContent,/Page 2 of 3/);assert.equal(ui.document.querySelector('[data-explore-age="7d"]').getAttribute('aria-pressed'),'true');assert.equal(ui.paths.at(-1),path);assert.equal(ui.get('explore-coins').hidden,false);
  assert.equal(ui.get('explore-search-tabs').closest('dialog'),ui.get('explore-search-dialog'));const queries=ui.calls.slice(before).filter(call=>call.path.startsWith('/api/explore?')).map(call=>new URL(call.path,'https://launchpad.example').searchParams);assert.equal(queries.length,1);assert(queries.every(q=>q.get('stage')==='all'&&!q.has('category')));
  ui.app.search.close();assert.equal(ui.get('explore-new-grid').querySelector('.explore-coin'),card);
});


test('official LAUNCHPAD cards and homepage highlights replace old saved art by exact mint only',async t=>{
  const image='/token-images/'+'c'.repeat(64)+'.png',official=coin({mint:OFFICIAL_TOKEN_MINT,symbol:'LAUNCHPAD',image}),impostor=coin({symbol:'LAUNCHPAD',image});
  const ui=await page(t,{respond:q=>payload(q.get('stage'),{coins:[official,impostor]})});
  assert.equal(ui.get('explore-new-grid').querySelector('.explore-coin-image img').src,'/brand-icon.png?v=54');
  assert.equal(ui.get('explore-featured').querySelector('.explore-feature-heading img').src,'/brand-icon.png?v=54');
  assert.equal(createExploreCard(ui.document,impostor).querySelector('.explore-coin-image img').src,image);assert.equal(official.image,image);
});

test('stale detector responses do not hide launches or suppress the next complete update',async t=>{
  let version='a'.repeat(64),stale=false;const ui=await page(t,{respondUpdates:()=>({version,stale})});
  const feeds=()=>ui.calls.filter(c=>c.path.startsWith('/api/explore?')&&new URL(c.path,'https://launchpad.example').searchParams.get('limit')==='10').length,initial=feeds();
  version='b'.repeat(64);stale=true;await ui.tick(10000);assert.equal(feeds(),initial);
  stale=false;await ui.tick(10000);assert.equal(feeds(),initial+1);await ui.tick(10000);assert.equal(feeds(),initial+1);
});

test('detector errors leave the one-minute feed fallback running',async t=>{
  let fail=false;const ui=await page(t,{respondUpdates:()=>fail?{error:'busy'}:{version:'a'.repeat(64),stale:false}});
  const feeds=()=>ui.calls.filter(c=>c.path.startsWith('/api/explore?')&&new URL(c.path,'https://launchpad.example').searchParams.get('limit')==='10').length,initial=feeds();
  fail=true;await ui.tick(10000);assert.equal(feeds(),initial);await ui.tick(50000);assert.equal(feeds(),initial+1);assert.doesNotMatch(ui.get('explore-status').textContent,/error|unavailable/);
});

test('an in-flight new-launch check is coalesced and waits until the hidden tab becomes visible',async t=>{
  let hold=false,release;const ui=await page(t,{respondUpdates:()=>hold?new Promise(resolve=>{release=()=>resolve({version:'b'.repeat(64),stale:false});}):{version:'a'.repeat(64),stale:false}});
  const feeds=()=>ui.calls.filter(c=>c.path.startsWith('/api/explore?')&&new URL(c.path,'https://launchpad.example').searchParams.get('limit')==='10').length,initial=feeds();hold=true;
  const pending=ui.tick(10000);await flush();await ui.tick(1000);assert.equal(ui.calls.filter(c=>c.path==='/api/explore/updates').length,2);
  ui.document.hidden=true;release();await pending;assert.equal(feeds(),initial);ui.document.hidden=false;hold=false;await ui.tick(0);assert.equal(feeds(),initial+1);
});

test('new-launch detection during a feed request remains queued and never duplicates an active request',async t=>{
  let hold=false,release,version='a'.repeat(64);const ui=await page(t,{respondUpdates:()=>({version,stale:false}),respond:q=>hold&&q.get('limit')==='10'?new Promise(resolve=>{release=()=>resolve(payload(q.get('stage')));}):undefined});
  const feeds=()=>ui.calls.filter(c=>c.path.startsWith('/api/explore?')&&new URL(c.path,'https://launchpad.example').searchParams.get('limit')==='10').length,initial=feeds();hold=true;
  const pendingFeed=ui.app.refresh();version='b'.repeat(64);const pendingTick=ui.tick(10000);await flush();assert.equal(feeds(),initial+1);
  hold=false;release();await pendingFeed;await pendingTick;await ui.tick(1000);assert.equal(feeds(),initial+2);
});

test('background updates retain card anchors and avatars, including late image error fallback',async t=>{
  let fdvUsd=21000,added=false;const picture='/token-images/'+'a'.repeat(64)+'.webp';const ui=await page(t,{respond:q=>payload(q.get('stage'),{coins:[...(added?[coin({mint:QUOTE,name:'Just launched',createdAt:NOW})]:[]),coin({fdvUsd,image:picture})]})});
  const original=ui.get('explore-new-grid').firstElementChild,img=original.querySelector('.explore-coin-image>img');fdvUsd=24000;added=true;await ui.app.refresh();
  assert.equal(ui.get('explore-new-grid').children[1],original);assert.equal(original.querySelector('.explore-coin-image>img'),img);assert.match(original.textContent,/\$24K/);
  img.onerror();assert.equal(original.querySelector('.explore-coin-image>img'),null);assert.equal(original.querySelector('.explore-coin-image>span').hidden,false);
});

test('page teardown stops its single timer, detaches pagehide and aborts pending detection',async t=>{
  let hold=false,release;const ui=await page(t,{respondUpdates:()=>hold?new Promise(resolve=>{release=()=>resolve({version:'b'.repeat(64),stale:false});}):{version:'a'.repeat(64),stale:false}});
  assert.equal(ui.timers.length,1);assert.equal(ui.timers[0].ms,1000);hold=true;const pending=ui.tick(10000);await flush();const detector=ui.calls.at(-1);assert.equal(detector.path,'/api/explore/updates');
  ui.app.destroy();assert.equal(detector.options.signal.aborted,true);assert.equal(ui.timers[0].cleared,true);assert.equal(ui.events.has('pagehide'),false);const before=ui.calls.length;release();await pending;await ui.tick(60000);assert.equal(ui.calls.length,before);
});

test('a partial stale inventory never resets the reader’s saved page offset',async t=>{
  let partial=false;const ui=await page(t,{respond:q=>payload(q.get('stage'),{total:partial?1:21,nextOffset:partial?null:20,coins:partial?[]:[coin()],stale:partial})});
  await ui.app.page('new',20);partial=true;await ui.app.refresh();assert.match(ui.get('explore-new-pagination').textContent,/^$/);
  partial=false;await ui.app.refresh();const q=new URL(ui.calls.at(-1).path,'https://launchpad.example').searchParams;assert.equal(q.get('offset'),'20');assert.match(ui.get('explore-new-pagination').textContent,/Page 3 of 3/);
});

test('feed refresh skips card construction for timestamp-only changes and updates only changed cards',async t=>{
  let revision=1,changedIndex=-1;const rows=()=>Array.from({length:10},(_,index)=>coin({mint:'123456789A'[index]+MINT.slice(1),image:'/token-images/'+'a'.repeat(64)+'.webp',marketAt:revision,fdvUsd:index===changedIndex?24000:21000}));
  const ui=await page(t,{respond:q=>payload(q.get('stage'),{coins:rows(),total:30,nextOffset:10})});
  const grid=ui.get('explore-new-grid'),originalCards=[...grid.children],pagination=[...ui.get('explore-new-pagination').children],create=ui.document.createElement.bind(ui.document);let elements=0,images=0;
  ui.document.createElement=(tag,...args)=>{elements++;if(tag==='img')images++;return create(tag,...args);};
  revision++;await ui.app.refresh();const unchanged={elements,images};
  elements=images=0;changedIndex=3;revision++;await ui.app.refresh();const changed={elements,images};
  t.diagnostic('Explore: timestamp-only refresh '+JSON.stringify(unchanged)+'; one changed card '+JSON.stringify(changed));
  assert.equal(unchanged.images,0);assert.equal(changed.images,3);
  assert.deepEqual([...grid.children],originalCards);assert.deepEqual([...ui.get('explore-new-pagination').children],pagination);assert.match(grid.children[3].textContent,/\$24K/);
});

test('a search filter from an old /explore?search= link is shown as a chip that clears it',async t=>{
  const empty=q=>q.get('search')==='zzzz'?payload(q.get('stage'),{coins:[],total:0,counts:{all:0,new:0,graduated:0,moving:0}}):undefined;
  const ui=await page(t,{search:'?search=zzzz',respond:empty}),chip=ui.document.querySelector('[data-explore-search-chip]'),feeds=()=>ui.calls.filter(call=>call.path.startsWith('/api/explore?')&&new URL(call.path,'https://launchpad.example').searchParams.get('limit')==='10');
  assert.equal(new URL(feeds().at(-1).path,'https://launchpad.example').searchParams.get('search'),'zzzz');
  assert.equal(chip.hidden,false);assert.equal(chip.previousElementSibling,ui.get('explore-status'));assert.match(chip.textContent,/Search:zzzz/);assert.equal(chip.getAttribute('aria-label'),'Clear the search filter “zzzz”');
  assert.match(ui.get('explore-status').textContent,/Filters applied/);assert.match(ui.get('explore-new-grid').textContent,/Clear the search/);
  await chip.onclick();
  assert.equal(chip.hidden,true);assert.equal(ui.paths.at(-1),'/');assert.equal(new URL(feeds().at(-1).path,'https://launchpad.example').searchParams.get('search')||'','');assert.doesNotMatch(ui.get('explore-status').textContent,/Filters applied/);assert(ui.get('explore-new-grid').querySelector('.explore-coin'));
  await ui.app.apply({search:'fresh'});assert.equal(chip.hidden,false);assert.match(chip.textContent,/fresh/);
});

test('page buttons stay focusable while a page loads and at the ends, and an unavailable page does nothing',async t=>{
  const ui=await page(t,{respond:q=>payload(q.get('stage'),{total:21,nextOffset:Number(q.get('offset'))===0?10:Number(q.get('offset'))===10?20:null})});
  const root=ui.get('explore-new-pagination'),[previous,,next]=root.children,reads=()=>ui.calls.filter(call=>call.path.startsWith('/api/explore?')&&new URL(call.path,'https://launchpad.example').searchParams.get('limit')==='10').length;
  assert.equal(previous.getAttribute('aria-disabled'),'true');assert.equal(previous.disabled,false);assert.equal(next.hasAttribute('aria-disabled'),false);
  let count=reads();await previous.onclick();assert.equal(reads(),count,'Previous on the first page does nothing');
  const loading=next.onclick();assert.equal(next.getAttribute('aria-disabled'),'true');assert.equal(next.disabled,false);await loading;await flush();
  assert.match(root.textContent,/Page 2 of 3/);assert.equal(root.children[2],next,'the same, still focused button');assert.equal(next.hasAttribute('aria-disabled'),false);assert.equal(previous.hasAttribute('aria-disabled'),false);
  await next.onclick();await flush();assert.match(root.textContent,/Page 3 of 3/);assert.equal(next.getAttribute('aria-disabled'),'true');
  count=reads();await next.onclick();assert.equal(reads(),count,'Next on the last page does nothing');
});

test('a search filter typed as a displayed ticker ($OTTER) filters by the ticker',()=>{
  assert.equal(exploreFilters(new URLSearchParams('search=%24OTTER')).search,'OTTER');assert.equal(exploreFilters(new URLSearchParams('search=%20%24%24otter%20')).search,'otter');assert.equal(exploreFilters(new URLSearchParams('search=%24')).search,'');
});
// v71.26 makeover v2 grid: 4 columns ≥1200 (5 ≥1560), 3 ≥900, 2 ≥380 → 24 cards everywhere except the 5-column band (20).
test('feed pages fill whole grid rows: 24 cards for 4, 3 and 2 columns, 20 in the 5-column band',async t=>{
  assert.equal(explorePageSize(1440),24);assert.equal(explorePageSize(1560),20);assert.equal(explorePageSize(1559),24);assert.equal(explorePageSize(1920),20);assert.equal(explorePageSize(1180),24);assert.equal(explorePageSize(390),24);assert.equal(explorePageSize(NaN),24);
  for(const [innerWidth,limit]of [[1440,'24'],[1600,'20'],[390,'24']]){
    const ui=await page(t,{innerWidth});const feeds=ui.calls.filter(row=>row.path.startsWith('/api/explore?')&&new URL(row.path,'https://app.example').searchParams.get('stage')==='new'&&new URL(row.path,'https://app.example').searchParams.get('sort')!=='progress');
    assert(feeds.length>0);for(const row of feeds)assert.equal(new URL(row.path,'https://app.example').searchParams.get('limit'),limit,String(innerWidth));
  }
});

test('v71.43: on a host with Robinhood Chain off, the feed is Solana-only whatever the URL or the memory says, and nothing is remembered',async t=>{
  const storage=memory();storage.setItem('curve.explore.chain','robinhood');
  const ui=await page(t,{storage,search:'?chain=robinhood',robinhood:'off',respond:q=>q.get('chain')==='solana'?payload(q.get('stage')):payload(q.get('stage'),{coins:[coin(),rhCoin()]})});
  for(const call of ui.calls.filter(c=>c.path.startsWith('/api/explore?')))assert.equal(new URL(call.path,'https://launch.example').searchParams.get('chain'),'solana',call.path);
  assert.equal(ui.get('explore-new-grid').querySelectorAll('.explore-coin').length,1);assert.equal(ui.get('explore-new-grid').querySelector('.explore-coin').dataset.chain,undefined);
  assert.equal(ui.document.querySelector('[data-explore-chain="solana"]').getAttribute('aria-pressed'),'true');
  assert.equal(ui.paths.at(-1)??'/','/','the URL carries no chain');assert.equal(ui.document.querySelector('.explore-amm-options').hidden,false);
  // A click on the (hidden) Robinhood button cannot leave Solana and does not write the memory.
  await ui.document.querySelector('[data-explore-chain="robinhood"]').onclick();
  const last=new URL(ui.calls.filter(c=>/[?&]offset=/.test(c.path)).at(-1).path,'https://launch.example').searchParams;assert.equal(last.get('chain'),'solana');assert.equal(storage.getItem('curve.explore.chain'),'robinhood','untouched');
});
