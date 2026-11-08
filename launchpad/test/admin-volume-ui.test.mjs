import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAdminVolume, volumeAmount } from '../public/admin-volume-ui.mjs';

const admin = { id: 'admin-account', role: 'admin', mfaEnabled: true };
const coin = { mint: 'TokenMint', name: 'Test coin', symbol: 'TEST', quote: { mint: 'QuoteMint', symbol: 'USDC' }, hidden: false, archived: false, volume24hUsd: 1200, observedVolumeUsd: 1200, volume24hQuote: 1200, observedVolumeQuote: 1200, complete: true, status: 'available', source: 'Raydium' };
const snapshot = { at: 1800840000000, refreshMs: 60000, period: '24h', volumeUsd: 2400, observedVolumeUsd: 2400, lifetimeVolumeUsd: null, coverage: { launches: 2, complete: 2, usdComplete: 2, partial: 0, unavailable: 0, unpriced: 0, inventoryComplete: true }, quoteTotals: [{ mint: 'QuoteMint', symbol: 'USDC', volume24hQuote: 2400, observedVolumeQuote: 2400, coins: 2, complete: true, sampledVolume24hQuote:2400, sampledObservedVolumeQuote:2400, sampledAt:1800840000000, sampledComplete:2, sampledCoins:2 }], coins: [{ ...coin, hidden: true }, { ...coin, mint: 'SecondMint', name: 'Second coin', archived: true }] };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function page({ account = admin, respond = async () => snapshot, isActive = () => true, period = '24h' } = {}) {
  const { document } = parseHTML('<html><body></body></html>'); Object.defineProperty(document, 'hidden', { value: false, writable: true });
  const timers = new Map(), calls = []; let nextTimer = 0;
  const ui = createAdminVolume({ document, getAccount: () => account, isActive, api: async path => { calls.push(path); return respond(); }, setTimer: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimer: id => timers.delete(id) });
  document.body.append(ui.element); if(period)ui.element.querySelector(`[data-volume-period="${period}"]`).onclick();
  return { ui, document, timers, calls, setAccount: value => { account = value; }, visibility: hidden => { document.hidden = hidden; document.dispatchEvent(new document.defaultView.Event('visibilitychange')); } };
}

test('volume formatting distinguishes unavailable values, verified zero and tiny amounts', () => {
  for (const value of [null, undefined, '1', NaN, Infinity, -1]) assert.equal(volumeAmount(value, true), '—');
  assert.equal(volumeAmount(0, true), '$0.00'); assert.equal(volumeAmount(1200345.5, true), '$1,200,345.50');
  assert.equal(volumeAmount(0.001, true), '<$0.01'); assert.equal(volumeAmount(0.0000001), '<0.000001');
  assert.equal(volumeAmount(1.123456789), '1.123457');
});

test('admin volume includes hidden and archived coins with correct period, pricing basis and native-quote separation', async () => {
  const p = page(); await p.ui.load();
  assert.deepEqual(p.calls, ['/api/admin/volume']); assert.equal(p.ui.element.dataset.coverage, 'available');
  assert.match(p.ui.element.textContent, /24h volume · USD estimate\$2,400.00/);
  assert.match(p.ui.element.textContent, /Coins with complete USD data2 \/ 2/);
  assert.match(p.ui.element.textContent, /Select Lifetime for saved cumulative launch-curve trades/);
  assert.match(p.ui.element.textContent, /quote-token prices at observation/);
  assert.match(p.ui.element.querySelector('.admin-volume-quotes').textContent, /Bonding-curve volume by quote asset/);
  const rows = p.ui.element.querySelectorAll('.admin-volume-details tbody tr');
  assert.equal(rows.length, 2); assert.match(rows[0].textContent, /Hidden/); assert.match(rows[1].textContent, /Archived/);
  assert.equal(p.ui.element.querySelector('details').open, false);
  assert.equal(p.timers.size, 1); assert.equal([...p.timers.values()][0].ms, 60000); p.ui.destroy();
});

test('missing or incomplete histories show an explicit reported subtotal rather than a complete total', async () => {
  const p = page({ respond: async () => ({ ...snapshot, volumeUsd: null, observedVolumeUsd: 1200, coverage: { ...snapshot.coverage, complete: 1, usdComplete: 1, partial: 1, inventoryComplete: false }, quoteTotals: [{ ...snapshot.quoteTotals[0], volume24hQuote: null, observedVolumeQuote: 1200, complete: false }], coins: [{ ...coin, volume24hUsd: null, observedVolumeUsd: 1200, status: 'partial', complete: false }, { ...coin, volume24hUsd: null, observedVolumeUsd: null, status: 'unavailable' }] }) });
  await p.ui.load(); assert.equal(p.ui.element.dataset.coverage, 'partial');
  assert.match(p.ui.element.textContent, /Reported 24h volume · USD estimate\$1,200.00/);
  assert.match(p.ui.element.textContent, /Partial subtotal; missing data is excluded/);
  assert.match(p.ui.element.textContent, /Launch inventory is incomplete/);
  assert.match(p.ui.element.textContent, /Missing volume is not counted as zero/);
  assert.match(p.ui.element.querySelector('.admin-volume-quotes').textContent, /Reported subtotal/);
  const amounts = [...p.ui.element.querySelectorAll('.admin-volume-details .admin-revenue-amount')].map(n => n.textContent);
  assert.deepEqual(amounts, ['$1,200.00', '—']); p.ui.destroy();
});

test('unpriced coins retain their native quote amount and never turn unavailable USD into zero', async () => {
  const p = page({ respond: async () => ({ ...snapshot, volumeUsd: null, observedVolumeUsd: null, coverage: { ...snapshot.coverage, usdComplete: 0, unpriced: 2 }, coins: [{ ...coin, volume24hUsd: null, observedVolumeUsd: null, status: 'unpriced' }] }) });
  await p.ui.load(); assert.equal(p.ui.element.dataset.coverage, 'unavailable');
  assert.match(p.ui.element.querySelector('.admin-volume-summary').textContent, /USD estimate—/);
  assert.match(p.ui.element.textContent, /2 without a USD price/);
  assert.match(p.ui.element.querySelector('.admin-volume-quotes').textContent, /2,400/);
  assert(!p.ui.element.textContent.includes('$0.00')); p.ui.destroy();
});

test('a complete empty launch inventory can truthfully show zero volume', async () => {
  const p = page({ respond: async () => ({ ...snapshot, volumeUsd: 0, observedVolumeUsd: 0, coverage: { ...snapshot.coverage, launches: 0, complete: 0, usdComplete: 0 }, quoteTotals: [], coins: [] }) });
  await p.ui.load(); assert.match(p.ui.element.textContent, /USD estimate\$0.00/);
  assert.equal(p.ui.element.querySelector('details').hidden, true); assert.equal(p.ui.element.querySelector('table'), null); p.ui.destroy();
});

test('sampled complete volume is labeled with its observation range and never described as a synchronized window', async () => {
  const oldestAt = snapshot.at - 300000, newestAt = snapshot.at - 30000;
  const p = page({ respond: async () => ({ ...snapshot, volumeUsd: null, sampledVolumeUsd: 2400, sampledObservedVolumeUsd: 2400,
    sampling: { oldestAt, newestAt, cachedCoins: 2, maxAgeMs: 900000 }, coverage: { ...snapshot.coverage, usdComplete: 1, unavailable: 1 },
    coins: snapshot.coins.map(c => ({ ...c, volume24hUsd: null, sampledVolume24hUsd: 1200, sampledAt: oldestAt, sampledSource: 'DEX Screener' })) }) });
  await p.ui.load(); const text = p.ui.element.textContent;
  assert.equal(p.ui.element.dataset.coverage, 'sampled'); assert.match(text, /Sampled 24h volume · USD estimate\$2,400.00/);
  assert.match(text, /Separate 24-hour windows observed within the past 15 minutes/);
  assert.match(text, /Coins with complete sampled USD data2 \/ 2/); assert.match(text, /windows are not synchronized/);
  assert(text.includes(new Date(oldestAt).toLocaleString())); assert(text.includes(new Date(newestAt).toLocaleString()));
  assert.match(text, /Fresh complete USD data: 1 \/ 2 coins/); assert.match(text, /Sampled 24h bonding-curve volume/);
  assert.equal(p.ui.element.querySelectorAll('.admin-volume-details .admin-revenue-amount')[0].textContent, '$1,200.00');
  assert.match(p.ui.element.querySelector('.admin-volume-details').textContent, /Complete sampleDEX Screener/); p.ui.destroy();
});

test('sampled partial coverage is a subtotal and missing samples remain unavailable', async () => {
  const p = page({ respond: async () => ({ ...snapshot, volumeUsd: null, observedVolumeUsd: null, sampledVolumeUsd: null, sampledObservedVolumeUsd: 1200,
    sampling: { oldestAt: snapshot.at - 300000, newestAt: snapshot.at - 300000, cachedCoins: 1, maxAgeMs: 900000 },
    coverage: { ...snapshot.coverage, usdComplete: 0, inventoryComplete: false },
    coins: [{ ...coin, sampledVolume24hUsd: 1200, sampledAt: snapshot.at - 300000 }, { ...coin, sampledVolume24hUsd: null }] }) });
  await p.ui.load(); assert.equal(p.ui.element.dataset.coverage, 'partial');
  assert.match(p.ui.element.textContent, /Sampled 24h subtotal · USD estimate\$1,200.00/);
  assert.match(p.ui.element.textContent, /Coins with complete sampled USD data1 \/ 2/);
  assert.match(p.ui.element.textContent, /Partial sampled subtotal; missing volume is not counted as zero/);
  assert.match(p.ui.element.textContent, /Launch inventory is incomplete/);
  assert.deepEqual([...p.ui.element.querySelectorAll('.admin-volume-details .admin-revenue-amount')].map(n => n.textContent), ['$1,200.00', '—']);
  assert.match(p.ui.element.querySelector('.admin-volume-details').textContent, /No complete sample/); p.ui.destroy();
});

test('zero sampled volume stays explicit and expired samples disappear on the next response', async () => {
  let expired = false;
  const p = page({ respond: async () => ({ ...snapshot, volumeUsd: null, observedVolumeUsd: null,
    sampledVolumeUsd: expired ? null : 0, sampledObservedVolumeUsd: expired ? null : 0,
    sampling: { oldestAt: expired ? null : snapshot.at, newestAt: expired ? null : snapshot.at, cachedCoins: expired ? 0 : 2, maxAgeMs: 900000 },
    coverage: { ...snapshot.coverage, usdComplete: 0, unavailable: 2 },
    coins: snapshot.coins.map(c => ({ ...c, volume24hUsd: null, observedVolumeUsd: null, sampledVolume24hUsd: expired ? null : 0, sampledAt: snapshot.at, status: 'unavailable' })) }) });
  await p.ui.load(); assert.match(p.ui.element.textContent, /Sampled 24h volume · USD estimate\$0.00/);
  expired = true; await p.ui.load(); assert.equal(p.ui.element.dataset.coverage, 'unavailable'); assert(!p.ui.element.textContent.includes('$0.00'));
  assert(!p.ui.element.textContent.includes('Sampled 24h volume')); p.ui.destroy();
});

test('inactive admin tabs and pause stop volume polling while preserving the rendered snapshot', async () => {
  let active = false; const p = page({ isActive: () => active });
  await p.ui.load(); assert.equal(p.calls.length, 0); assert.equal(p.timers.size, 0);
  active = true; await p.ui.load(); assert.equal(p.timers.size, 1);
  active = false; p.ui.pause(); assert.equal(p.timers.size, 0); assert.match(p.ui.element.textContent, /\$2,400.00/);
  await p.ui.load(); p.visibility(true); p.visibility(false); await tick(); assert.equal(p.calls.length, 1); assert.equal(p.timers.size, 0);
  active = true; await p.ui.load(); assert.equal(p.calls.length, 2); assert.equal(p.timers.size, 1);
  active = false; await [...p.timers.values()][0].fn(); assert.equal(p.calls.length, 2); assert.equal(p.timers.size, 0); p.ui.destroy();
});

test('volume is private to verified administrators and stops polling when the page is hidden', async () => {
  for (const account of [null, { ...admin, role: 'user' }, { ...admin, mfaEnabled: false }]) {
    const p = page({ account }); await p.ui.load(); assert.equal(p.calls.length, 0); assert.equal(p.timers.size, 0); assert.equal(p.ui.element.hidden, true); p.ui.destroy();
  }
  const p = page(); await p.ui.load(); p.visibility(true); assert.equal(p.timers.size, 0); await p.ui.load(); assert.equal(p.calls.length, 1);
  p.visibility(false); await tick(); assert.equal(p.calls.length, 2); assert.equal(p.timers.size, 1);
  p.setAccount(null); await [...p.timers.values()][0].fn(); await tick();
  assert.equal(p.ui.element.hidden, true); assert.equal(p.ui.element.querySelector('table'), null); assert.equal(p.timers.size, 0); p.ui.destroy();
});

test('late volume responses cannot restore private data after clearing, account changes or teardown', async () => {
  for (const action of ['clear', 'account', 'destroy']) {
    let resolve; const p = page({ respond: () => new Promise(done => { resolve = done; }) }); const pending = p.ui.load();
    if (action === 'account') p.setAccount({ ...admin, id: 'other-admin' }); else p.ui[action]();
    resolve(snapshot); await pending; assert.equal(p.ui.element.hidden, true); assert.equal(p.ui.element.querySelector('table'), null); assert.equal(p.timers.size, 0); p.ui.destroy();
  }
});

test('clearing lets the next verified session refresh without accepting an earlier response', async () => {
  const resolvers = [], p = page({ respond: () => new Promise(resolve => resolvers.push(resolve)) }); const old = p.ui.load();
  p.ui.clear(); const fresh = p.ui.load(); resolvers[0]({ ...snapshot, volumeUsd: 99999 }); await old;
  assert.equal(p.ui.element.querySelector('table'), null); resolvers[1](snapshot); await fresh; p.ui.element.querySelector('[data-volume-period="24h"]').onclick();
  assert.match(p.ui.element.textContent, /\$2,400.00/); assert(!p.ui.element.textContent.includes('99,999')); assert.equal(p.timers.size, 1); p.ui.destroy();
});

test('refresh failures keep the previous snapshot with a stale label and no internal errors', async () => {
  let fail = false; const p = page({ respond: async () => { if (fail) throw Error('secret database path'); return snapshot; } });
  await p.ui.load(); fail = true; await p.ui.element.querySelector('button').onclick();
  assert.match(p.ui.element.textContent, /Showing the previous snapshot/); assert.match(p.ui.element.textContent, /\$2,400.00/);
  assert(!p.ui.element.textContent.includes('secret database path')); p.ui.destroy();
  let resolve; const busy = page({ respond: () => new Promise(done => { resolve = done; }) }); const loading = busy.ui.load(); await busy.ui.load();
  assert.equal(busy.calls.length, 1); resolve(snapshot); await loading; busy.ui.destroy();
});

test('coin metadata, source descriptions and notes render only as inert text', async () => {
  const p = page({ respond: async () => ({ ...snapshot, note: '<script>steal()</script>', coins: [{ ...coin, name: '<img src=x onerror=steal()>', symbol: '<svg onload=steal()>', quote: { symbol: '<script>q()</script>' }, source: '<img src=x>' }], quoteTotals: [{ ...snapshot.quoteTotals[0], symbol: '<img src=x>' }] }) });
  await p.ui.load(); assert.match(p.ui.element.textContent, /<img src=x onerror=steal\(\)>/);
  assert.equal(p.ui.element.querySelector('img,script,svg'), null); p.ui.destroy();
});

const lifetime={status:'partial',period:'lifetime',scope:'launch-curves',recordedVolumeUsdEstimate:null,pricedVolumeUsdEstimate:71839.54,tradeCount:1263,quoteTotals:[{symbol:'SOL',amount:'583.217946102',usdEstimate:71839.54,priced:true},{symbol:'OPENAI',amount:'0.418265379',usdEstimate:null,priced:false}],coverage:{launches:12,backfilledLaunches:10,recordedLaunches:12,unpricedQuotes:1,inventoryComplete:true,historyComplete:false,postGraduationIncluded:false},updatedAt:snapshot.at};

test('Lifetime is the actual default and uses shared saved native volume without substituting 24h totals',async()=>{
  const p=page({period:null,respond:async()=>({...snapshot,lifetime})});await p.ui.load();assert.equal(p.ui.element.dataset.period,'all');assert.equal(p.ui.element.querySelector('[data-volume-period="all"]').getAttribute('aria-pressed'),'true');
  assert.match(p.ui.element.textContent,/Recorded lifetime subtotal · USD estimate\$71,839.54/);assert.match(p.ui.element.textContent,/10 \/ 12/);assert.match(p.ui.element.textContent,/1,263 recorded trades/);assert.match(p.ui.element.textContent,/September 24, 2026/);assert.match(p.ui.element.textContent,/583\.217946102/);assert.match(p.ui.element.textContent,/0\.418265379/);assert.match(p.ui.element.textContent,/Subtotal · USD unavailable/);assert(!p.ui.element.textContent.includes('$2,400.00'));
  assert.match(p.ui.element.textContent,/Post-graduation pools are excluded/);assert.match(p.ui.element.textContent,/never calculated by adding overlapping/);assert.equal(p.ui.element.querySelector('.admin-volume-details').hidden,true);
  p.ui.element.querySelector('[data-volume-period="24h"]').onclick();assert.match(p.ui.element.textContent,/24h volume · USD estimate\$2,400.00/);assert.equal(p.calls.length,1);assert.equal(p.ui.element.querySelector('.admin-volume-details').hidden,false);
  await p.ui.load();assert.equal(p.ui.element.dataset.period,'24h');p.ui.destroy();
});

test('partial or unpriced lifetime history retains native totals and cannot manufacture zero USD',async()=>{
  const p=page({period:'all',respond:async()=>({...snapshot,lifetime:{...lifetime,recordedVolumeUsdEstimate:null,pricedVolumeUsdEstimate:null,quoteTotals:[{symbol:'OPENAI',amount:'0.418265379',usdEstimate:null}]}})});await p.ui.load();assert.match(p.ui.element.querySelector('.admin-volume-summary').textContent,/USD estimate—/);assert.match(p.ui.element.textContent,/0\.418265379/);assert(!p.ui.element.textContent.includes('$0.00'));p.ui.destroy();
  const q=page({period:'all',respond:async()=>({...snapshot,lifetime:{...lifetime,tradeCount:0,recordedVolumeUsdEstimate:0,pricedVolumeUsdEstimate:0,quoteTotals:[{symbol:'USDC',amount:0,usdEstimate:0}]}})});await q.ui.load();assert(!q.ui.element.textContent.includes('$0.00'));assert.match(q.ui.element.textContent,/History unavailable/);q.ui.destroy();
});

test('complete empty lifetime inventory can show zero and malformed amount strings stay unavailable',async()=>{
  const p=page({period:'all',respond:async()=>({...snapshot,lifetime:{...lifetime,status:'available',recordedVolumeUsdEstimate:0,pricedVolumeUsdEstimate:0,tradeCount:0,quoteTotals:[],coverage:{historyComplete:true,inventoryComplete:true,launches:0,backfilledLaunches:0}}})});await p.ui.load();assert.match(p.ui.element.textContent,/Recorded lifetime volume · USD estimate\$0.00/);assert.match(p.ui.element.textContent,/No recorded launch-curve trades yet/);p.ui.destroy();
  const q=page({period:'all',respond:async()=>({...snapshot,lifetime:{...lifetime,quoteTotals:[{symbol:'<img src=x onerror=bad()>',amount:'Infinity',usdEstimate:null}]}})});await q.ui.load();assert.equal(q.ui.element.querySelector('img'),null);assert.match(q.ui.element.textContent,/History unavailable/);q.ui.destroy();
});

test('sampled headline and native quote rows use the same retained sampling window even without fresh data',async()=>{
  const p=page({respond:async()=>({...snapshot,volumeUsd:null,observedVolumeUsd:null,sampledVolumeUsd:null,sampledObservedVolumeUsd:19866.13,sampling:{oldestAt:snapshot.at-300000,newestAt:snapshot.at-60000,cachedCoins:9},coverage:{...snapshot.coverage,launches:12,usdComplete:0},quoteTotals:[{mint:'OPENAI',symbol:'OPENAI',coins:1,volume24hQuote:null,observedVolumeQuote:null,sampledVolume24hQuote:.418265379,sampledObservedVolumeQuote:.418265379,sampledAt:snapshot.at-300000,sampledComplete:1,sampledCoins:1},{mint:'OTHER',symbol:'OTHER',coins:2,volume24hQuote:null,observedVolumeQuote:null,sampledVolume24hQuote:null,sampledObservedVolumeQuote:2.5,sampledAt:snapshot.at-120000,sampledComplete:1,sampledCoins:1}]})});await p.ui.load();const quotes=p.ui.element.querySelector('.admin-volume-quotes');assert.match(p.ui.element.textContent,/\$19,866.13/);assert.match(quotes.textContent,/0.418265/);assert.match(quotes.textContent,/2.5/);assert.match(quotes.textContent,/Complete sample/);assert.match(quotes.textContent,/Recorded subtotal/);assert.match(quotes.textContent,/same retained sampling window/);p.ui.destroy();
});

test('recorded 24h fallback uses only its matching native trade window and follows public analytics source priority',async()=>{
  const recent={period:'24h',scope:'launch-curves',recordedVolumeUsdEstimate:220,pricedVolumeUsdEstimate:220,historyComplete:true,tradeCount:8,quoteTotals:[{symbol:'OPENAI',amount:.418265379,usdEstimate:220,priced:true}]};
  let current={...snapshot,volumeUsd:null,observedVolumeUsd:100,sampledVolumeUsd:null,sampledObservedVolumeUsd:150,lifetime:{...lifetime,last24h:recent}};
  const p=page({respond:async()=>current});await p.ui.load();assert.equal(p.ui.element.dataset.coverage,'curve-only');assert.match(p.ui.element.textContent,/Recorded 24h launch-curve volume · USD estimate\$220.00/);assert.match(p.ui.element.textContent,/0.418265379/);assert(!p.ui.element.textContent.includes('583.217946102'));assert.match(p.ui.element.textContent,/Post-graduation pools are excluded/);
  current={...current,sampledVolumeUsd:500,sampledObservedVolumeUsd:500,sampling:{cachedCoins:2,oldestAt:snapshot.at,newestAt:snapshot.at}};await p.ui.load();assert.match(p.ui.element.textContent,/Sampled 24h volume · USD estimate\$500.00/);
  current={...current,volumeUsd:600};await p.ui.load();assert.match(p.ui.element.textContent,/24h volume · USD estimate\$600.00/);p.ui.destroy();
});

test('a loaded volume snapshot clears immediately when a different admin begins a read',async()=>{
  let finish,wait=false;const p=page({period:'all',respond:async()=>wait?new Promise(resolve=>{finish=resolve;}):({...snapshot,lifetime})});await p.ui.load();assert.match(p.ui.element.textContent,/85,061/);
  wait=true;p.setAccount({...admin,id:'new-admin'});const pending=p.ui.load();assert(!p.ui.element.textContent.includes('85,061'));finish({...snapshot,lifetime});await pending;assert.match(p.ui.element.textContent,/85,061/);p.ui.destroy();
});
