import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {createExplorePage} from '../public/explore.js';
import {createWorkspaceShell} from '../public/workspace-shell.js';
import {mountCurvePriceBadge} from '../public/curve-price-badge.mjs';
const read=name=>readFile(new URL('../public/'+name,import.meta.url),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const flush=()=>new Promise(setImmediate);
const MINT='So11111111111111111111111111111111111111112',QUOTE='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const coin={mint:MINT,curve:MINT,name:'Public coin',symbol:'PUBLIC',stage:'new',fdvUsd:23456,priceUsd:.000023456,progressPercent:51,quote:{mint:QUOTE,symbol:'USDC'},createdAt:1700000000000};
const payload={coins:[coin],total:1,counts:{all:1,new:1,moving:1,graduated:0},nextOffset:null};

test('public routes ship the final centered shell before any module or session response',async()=>{
 for(const name of ['explore','coin','launchpad','creator','analytics','launched-tokens','docs','terms','privacy']){
  const {document}=parseHTML(await read(name+'.html'));
  assert.equal(document.body.dataset.shell,'true',name);assert.equal(document.body.dataset.navigation,'top',name);
  for(const selector of ['.workspace-header-inner','.header-search','.top-launch','.curve-price-badge','[data-account-link]'])assert.equal(document.querySelectorAll('.app-header '+selector).length,1,`${name} ${selector}`);
  assert(document.querySelector('link#curve-price-badge-styles'));assert(document.querySelector('link[rel=preload][as=font]'));
 }
 const {document}=parseHTML(await read('explore.html'));
 // v71.26: two loading rows fill the 4-column grid (and whole rows at 2 columns).
 assert.equal(document.querySelectorAll('#explore-new-grid .explore-skeleton').length,8);
 assert.equal(document.querySelectorAll('#explore-new-grid .explore-skeleton > .explore-coin-body').length,8);
 assert.equal(document.querySelectorAll('#explore-leaders-list .explore-leader-placeholder').length,4);
 const theme=await read('curve-theme.css'),css=await read('explore.css');
 // v71.25: header, page and footer share one frame (--page-max inside a --page-gutter bar).
 assert.match(theme,/body\.relay-terminal\[data-navigation=top\] main[^}]*max-width:calc\(var\(--page-max\) \+ 2\*var\(--page-gutter\)\)/);
 assert.match(theme,/\.workspace-header-inner\{[^}]*max-width:var\(--page-max\)/);assert.match(theme,/\.site-footer-inner\{[^}]*max-width:var\(--page-max\)/);
 // v71.26 makeover v2: the featured card grew to 574px at 1440 (72px identity row, a 240px chart with axes, stat
 // tiles) and the grid card body to 180px (17px name, 22px value, pair row, 6px progress bar); both reserve that space.
 assert.match(theme,/scrollbar-gutter:stable/);assert.match(css,/\.explore-page \.explore-featured\{min-height:574px\}/);
 assert.match(css,/\.explore-page:not\(\.explore-list-view\) \.explore-coin-body\{min-height:180px\}/);assert.doesNotMatch(css,/explore-skeleton::after/);
});

test('static header hydrates once, keeps search node and waits for no account request',async t=>{
 const {document,window}=parseHTML(await read('explore.html'));
 const previous=globalThis.document;globalThis.document=document;t.after(()=>{globalThis.document=previous;});
 Object.defineProperty(window,'location',{value:{href:'https://launchpad.test/',search:''},configurable:true});
 // Price fetching is unrelated to layout; leave it unavailable for this cold boot.
 Object.defineProperty(window,'fetch',{value:undefined,configurable:true});
 const input=document.getElementById('explore-search'),header=document.querySelector('.workspace-header-inner'),launch=document.querySelector('.top-launch'),badge=document.querySelector('.curve-price-badge');
 input.value='retained query';createWorkspaceShell({page:'explore'});
 assert.equal(document.querySelector('.workspace-header-inner'),header);assert.equal(document.getElementById('explore-search'),input);assert.equal(input.value,'retained query');assert.equal(document.querySelector('.top-launch'),launch);assert.equal(document.querySelector('.curve-price-badge'),badge);
 createWorkspaceShell({page:'explore',session:{authenticated:true,account:{id:'one',username:'test_user',role:'user'}}});
 createWorkspaceShell({page:'explore',session:{authenticated:true,account:{id:'one',username:'test_user',role:'user'}}});
 for(const selector of ['.workspace-header-inner','.header-search','.top-launch','.curve-price-badge','[data-account-link]'])assert.equal(document.querySelectorAll('.app-header '+selector).length,1,selector);
 assert.equal(document.querySelector('[data-account-link]').textContent,'Ttest_user');
 mountCurvePriceBadge({document,window,container:document.querySelector('.local')}).destroy();
});

async function fixture(t){
 const html=await read('explore.html'),{document}=parseHTML(html);document.hidden=false;
 let now=1700000100000;const calls=[],session=deferred(),chart=deferred();let waiting=false,releases=[];
 const window={location:{search:''},history:{replaceState(){}},setTimeout,clearTimeout,addEventListener(){},removeEventListener(){}};
 const fetcher=async(path,options)=>{calls.push(path);let data;
  if(path==='/api/session')data=await session.promise;
  else if(path.startsWith('/api/explore/market?'))data=await chart.promise;
  else if(path==='/api/explore/updates')data={version:'a'.repeat(64)};
  else if(waiting)data=await new Promise(resolve=>releases.push(resolve));else data=payload;
  return {ok:true,json:async()=>data};
 };
 const options={document,window,fetcher,clock:()=>now,setTimer:()=>1,clearTimer(){},shell(){}};
 let app=createExplorePage(options);t.after(()=>{app.destroy();session.resolve({authenticated:false});chart.resolve({});for(const release of releases)release(payload);});
 await app.ready;await flush();
 return{document,calls,session,chart,get app(){return app;},setTime:value=>now=value,
 async remount(){app.destroy();document.querySelector('main').replaceWith(parseHTML(html).document.querySelector('main'));waiting=true;app=createExplorePage(options);await flush();return app;},
 release(){waiting=false;for(const release of releases)release(payload);releases=[];},options};
}

test('coin metadata and visible cards render while session and chart are still pending',async t=>{
 const h=await fixture(t);assert(h.calls.includes('/api/session'));assert(h.calls.some(path=>path.startsWith('/api/explore/market?')));
 assert.match(h.document.querySelector('#explore-featured').textContent,/\$PUBLIC/);assert.match(h.document.querySelector('#explore-featured').textContent,/\$23\.46K/);
 assert.match(h.document.querySelector('#explore-featured').textContent,/Loading confirmed price history/);assert.match(h.document.querySelector('#explore-new-grid').textContent,/Public coin/);
 h.chart.resolve({native:{mint:MINT,curve:MINT,quote:{mint:QUOTE},points:[{time:1,priceQuote:1},{time:2,priceQuote:2}]}});await flush();assert(h.document.querySelector('#explore-featured svg'));
});

test('returning to Explore restores public cards and highlights immediately then revalidates',async t=>{
 const h=await fixture(t);const initial=h.calls.length;const app=await h.remount();
 assert.match(h.document.querySelector('#explore-featured').textContent,/\$PUBLIC/);assert.match(h.document.querySelector('#explore-new-grid').textContent,/Public coin/);
 assert.equal(h.document.querySelectorAll('#explore-new-grid .explore-skeleton').length,0);
 assert.match(h.document.getElementById('explore-status').textContent,/Updating/);assert(h.calls.length>initial);
 h.release();await app.ready;
});

test('old public snapshots expire instead of rendering indefinitely on return',async t=>{
 const h=await fixture(t);h.app.destroy();h.setTime(1700000100000+120001);await h.remount();
 assert.equal(h.document.querySelectorAll('#explore-new-grid .explore-skeleton').length,8);assert.equal(h.document.querySelectorAll('#explore-new-grid .explore-skeleton > .explore-coin-body').length,8);assert.doesNotMatch(h.document.querySelector('#explore-featured').textContent,/\$PUBLIC/);
 h.release();await h.app.ready;
});
