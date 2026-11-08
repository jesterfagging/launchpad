import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {LAUNCHPAD_MINT,LAUNCHPAD_TOKEN_HREF,curvePriceSnapshot,formatCurvePrice,formatCurveCap,mountCurvePriceBadge} from '../public/curve-price-badge.mjs';
const NOW=1790560000000;
const data=(changes={})=>({coin:{mint:LAUNCHPAD_MINT,chain:'solana',priceUsd:0.01194,marketAt:NOW,stale:false,...changes}});
const flush=()=>new Promise(setImmediate);
function fixture(t,{respond=()=>({ok:true,json:async()=>data()}),hidden=false}={}){
  const {document,window}=parseHTML('<html><head></head><body><header class="app-header"><div class="local"><a class="top-launch" href="/launchpad">Launch on Launchpad</a></div></header></body></html>');
  document.hidden=hidden;let now=NOW,next=0;const timers=new Map(),calls=[],container=document.querySelector('.local');
  const options={document,window,container,clock:()=>now,setTimer:(fn,ms)=>{const id=++next;timers.set(id,{fn,at:now+ms});return id;},clearTimer:id=>timers.delete(id),fetcher:async(path,options)=>{calls.push({path,options});return respond(path,options,calls.length);}};
  const app=mountCurvePriceBadge(options);t.after(()=>app.destroy());
  return {app,document,window,calls,timers,options,setTime:value=>now=value,async advance(ms){now+=ms;for(const [id,timer]of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}await flush();},visibility(value){document.hidden=value;document.dispatchEvent(new window.Event('visibilitychange'));},price:()=>app.element.querySelector('.curve-price-value').textContent};
}
test('only fresh, exact-mint USD prices are accepted; no quote-token fallback or made-up zero',()=>{
  assert.deepEqual(curvePriceSnapshot(data(),NOW),{price:0.01194,cap:null,capKind:null,at:NOW});
  for(const changes of [{mint:'So11111111111111111111111111111111111111112'},{chain:'robinhood'},{stale:true},{priceUsd:null,priceQuote:42},{priceUsd:0},{priceUsd:-1},{priceUsd:'garbage'},{priceUsd:true},{marketAt:null},{marketAt:NOW-120001},{marketAt:NOW+5001}])assert.equal(curvePriceSnapshot(data(changes),NOW),null);
  assert.equal(curvePriceSnapshot({...data(),stale:true},NOW),null);
  assert.equal(formatCurvePrice(0.01194),'$0.01194');assert.equal(formatCurvePrice(null),'—');assert.notEqual(formatCurvePrice(0.000000000001),'$0.00');
});
test('the badge shows the market cap (or the fully diluted value) and keeps the price for the tooltip and as the fallback',async t=>{
  assert.deepEqual(curvePriceSnapshot(data({marketCapUsd:378010.4,fdvUsd:3980000}),NOW),{price:0.01194,cap:378010.4,capKind:'Market cap',at:NOW});
  assert.deepEqual(curvePriceSnapshot(data({marketCapUsd:null,fdvUsd:'3980000'}),NOW),{price:0.01194,cap:3980000,capKind:'Fully diluted value',at:NOW});
  assert.deepEqual(curvePriceSnapshot(data({priceUsd:null,marketCapUsd:378010.4}),NOW),{price:null,cap:378010.4,capKind:'Market cap',at:NOW});
  assert.equal(formatCurveCap(378010.4),'$378.0K');assert.equal(formatCurveCap(3980000),'$3.98M');assert.equal(formatCurveCap(950),'$950');assert.equal(formatCurveCap(null),'—');
  const h=fixture(t,{respond:()=>({ok:true,json:async()=>data({marketCapUsd:378010.4,fdvUsd:3980000})})});await flush();
  assert.equal(h.price(),'$378.0K');assert.equal(h.app.element.dataset.priceKind,'cap');assert.match(h.app.element.title,/market cap \$378\.0K · price \$0\.01194/);assert.match(h.app.element.getAttribute('aria-label'),/Market cap \$378\.0K USD/);
  const f=fixture(t,{respond:()=>({ok:true,json:async()=>data({fdvUsd:3980000})})});await flush();
  assert.equal(f.price(),'$3.98M');assert.equal(f.app.element.dataset.priceKind,'fdv');
});
test('shared header mounts one keyboard-accessible official link and polls only the existing discovery endpoint',async t=>{
  const h=fixture(t);await flush();
  assert.equal(h.price(),'$0.01194');assert.equal(h.app.element.getAttribute('href'),LAUNCHPAD_TOKEN_HREF);assert.equal(h.app.element.getAttribute('target'),null);
  assert.equal(h.app.element.nextElementSibling.className,'top-launch');assert.match(h.app.element.getAttribute('aria-label'),/official \$LAUNCHPAD/);
  assert.equal(mountCurvePriceBadge(h.options),h.app);assert.equal(h.document.querySelectorAll('.curve-price-badge').length,1);assert.equal(h.document.querySelectorAll('#curve-price-badge-styles').length,1);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].path,'/api/explore/token?mint='+LAUNCHPAD_MINT);assert.equal(h.calls[0].options.method,'GET');
  await h.app.refresh();assert.equal(h.calls.length,1);await h.advance(30000);assert.equal(h.calls.length,2);
});
test('hidden pages stop polling, returning pages obey the shared interval and expired data is cleared',async t=>{
  const h=fixture(t);await flush();h.visibility(true);await h.advance(60000);assert.equal(h.calls.length,1);
  h.visibility(false);await flush();assert.equal(h.calls.length,2);h.visibility(true);await h.advance(61000);h.visibility(false);await flush();assert.equal(h.price(),'—');assert.equal(h.app.element.dataset.priceState,'unavailable');
});
// A failed request used to blank a price that was seconds old and keep the
// dash for the whole 60s backoff. The price now stays only while it is inside
// its two-minute freshness window; the backoff schedule is unchanged.
test('errors keep a still-fresh price, clear it when it expires and back off automatically without parallel requests',async t=>{
  const h=fixture(t,{respond:(_path,_options,count)=>count===1?{ok:true,json:async()=>data()}:{ok:false}});await flush();await h.advance(30000);
  assert.equal(h.calls.length,2);assert.equal(h.price(),'$0.01194');assert.equal(h.app.element.dataset.priceState,'current');
  await h.advance(59000);assert.equal(h.calls.length,2);await h.advance(1000);assert.equal(h.calls.length,3);
  await h.advance(29999);assert.equal(h.price(),'$0.01194');
  await h.advance(119000-29999);assert.equal(h.calls.length,3);assert.equal(h.price(),'—');assert.match(h.app.element.title,/unavailable/);await h.advance(1000);assert.equal(h.calls.length,4);
});
test('cold discovery cache is retried after ten seconds and does not present missing USD as zero',async t=>{
  const h=fixture(t,{respond:(_path,_options,count)=>({ok:true,json:async()=>count===1?{...data({priceUsd:null}),refreshing:true}:data()})});await flush();assert.equal(h.price(),'—');await h.advance(10000);assert.equal(h.price(),'$0.01194');assert.equal(h.calls.length,2);
});
test('pagehide aborts outstanding work and late results after disposal cannot repopulate the badge',async t=>{
  let resolve;const h=fixture(t,{respond:()=>new Promise(done=>resolve=done)});await h.app.refresh();assert.equal(h.calls.length,1);
  h.window.dispatchEvent(new h.window.Event('pagehide'));assert.equal(h.calls[0].options.signal.aborted,true);h.app.destroy();resolve({ok:true,json:async()=>data()});await flush();assert.equal(h.document.querySelector('.curve-price-badge'),null);assert.equal(h.timers.size,0);
});
test('a visitor clock behind the server still shows the current price, using the response Date header',async t=>{
  const h=fixture(t,{respond:()=>({ok:true,headers:{get:name=>name==='date'?new Date(NOW+15000).toUTCString():null},json:async()=>data({marketAt:NOW+14000})})});
  await flush();assert.equal(h.price(),'$0.01194');assert.equal(h.app.element.dataset.priceState,'current');
});
test('an aging cached price is renewed before it expires instead of lapsing to a dash until the next poll',async t=>{
  let marketAt=NOW-100000;const h=fixture(t,{respond:()=>({ok:true,json:async()=>data({marketAt})})});
  await flush();assert.equal(h.price(),'$0.01194');marketAt=NOW+9000;
  await h.advance(10000);assert.equal(h.calls.length,2);await h.advance(15000);assert.equal(h.price(),'$0.01194');
  await h.advance(5000);assert.equal(h.calls.length,2);
});
test('a bfcache restore refreshes an interrupted price request without waiting for the next interval',async t=>{
  let count=0;const h=fixture(t,{respond:()=>++count===1?new Promise(()=>{}):{ok:true,json:async()=>data({marketAt:NOW+20000})}});
  await flush();assert.equal(h.calls.length,1);h.window.dispatchEvent(new h.window.Event('pagehide'));await flush();
  h.setTime(NOW+20000);h.window.dispatchEvent(new h.window.Event('pageshow'));await flush();
  assert.equal(h.calls.length,2);assert.equal(h.price(),'$0.01194');
});
