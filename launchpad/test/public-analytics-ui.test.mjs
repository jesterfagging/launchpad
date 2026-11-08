import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readFile } from 'node:fs/promises';
import { analyticsCompact, analyticsRaw, analyticsTicks, analyticsUsd, analyticsWindowDelta, createPublicAnalytics } from '../public/analytics-view.mjs';

const at = 1800988800000;
const curveMint = '7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc';
function supplySnapshot(totalBurned, overrides = {}) {
  return { status: 'available', mint: curveMint, decimals: 6, originalSupply: '1000000000000000', currentSupply: (1000000000000000n - BigInt(totalBurned)).toString(), totalBurned, slot: 380000000, at, source: 'finalized-mint-supply', commitment: 'finalized', ...overrides };
}
const snapshot = {
  version: 1, generatedAt: at, refreshMs: 60000,
  launches: { total: 20, last24h: 3, uniqueDevelopers: 11, uniqueDevelopers24h: 2, complete: true, observedTotal: 20, observedLast24h: 3, observedUniqueDevelopers: 11, observedUniqueDevelopers24h: 2 },
  dailyLaunches: { timezone: 'UTC', complete: true, days: [{ date: '2026-09-25', count: 2, observedCount: 2 }, { date: '2026-09-26', count: 1, observedCount: 1 }] },
  volume: { usd: 45000, observedUsd: 45000, complete: true, lifetimeUsd: null, asOf: at, coverage: { launches: 20, usdComplete: 20, inventoryComplete: true } },
  treasury: { status: 'available', buybackBps: 5000, solDecimals: 9, curveDecimals: 6, solSpent: '1234567890', curveBought: '100000000000', curveBurned: '90000000000', updatedAt: at, history: [{ kind: 'buy', signature: '2'.repeat(88), inputAmount: '1234567890', outputAmount: '100000000000', confirmedAt: at }, { kind: 'burn', signature: '3'.repeat(88), inputAmount: '90000000000', outputAmount: '0', confirmedAt: at }] },
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function page({ respond = async () => snapshot, time = () => at } = {}) {
  const { document, window } = parseHTML('<html><body><main id="analytics-main"></main></body></html>');
  Object.defineProperty(document, 'hidden', { value: false, writable: true });
  const calls = [], timers = new Map(); let index = 0;
  const ui = createPublicAnalytics({ document, window, now: time, fetcher: async (path, options) => { calls.push({ path, options }); const data = await respond(); return { ok: true, json: async () => data }; }, setTimer: (fn, ms) => { const id = ++index; timers.set(id, { fn, ms }); return id; }, clearTimer: id => timers.delete(id) });
  return { ui, document, window, calls, timers, period: key => document.querySelector(`[data-period="${key}"]`).onclick(), visibility(hidden) { document.hidden = hidden; document.dispatchEvent(new window.Event('visibilitychange')); } };
}

test('analytics amount formatters retain verified zero and integer precision while rejecting unknowns', () => {
  for (const value of [null, undefined, NaN, Infinity, '1', -1]) assert.equal(analyticsUsd(value), '—');
  assert.equal(analyticsUsd(0), '$0.00'); assert.equal(analyticsUsd(.001), '<$0.01');
  assert.equal(analyticsRaw('0', 9), '0'); assert.equal(analyticsRaw('1', 9), '<0.000001');
  assert.equal(analyticsRaw('123456789012345678901234567890', 9), '123,456,789,012,345,678,901.234567');
  assert.equal(analyticsRaw('1234567890', 9), '1.234567');
  for (const [value, decimals] of [[null, 6], ['1', null], ['1', 19], ['-1', 6], ['1e8', 6], [123, 6]]) assert.equal(analyticsRaw(value, decimals), '—');
});

test('public anonymous analytics defaults to all time and period switches never relabel 24h volume as lifetime', async () => {
  const p = page(); await p.ui.load();
  assert.equal(p.calls[0].path, '/api/analytics'); assert.equal(p.calls[0].options.credentials, 'omit');
  assert.equal(p.document.querySelector('[data-period=all]').getAttribute('aria-pressed'), 'true');
  assert.match(p.document.querySelector('.analytics-metrics').textContent, /Total launches20/);
  assert.doesNotMatch(p.document.querySelector('.analytics-metrics').textContent, /Unique developers/i);
  assert.match(p.document.querySelector('.analytics-metrics').textContent, /Lifetime Total Volume—/);
  assert.deepEqual([...p.document.querySelectorAll('.analytics-metrics .analytics-metric-label')].map(node=>node.textContent),['Lifetime Total Volume','Total Revenue','Total launches']);
  p.period('24h'); assert.match(p.document.querySelector('.analytics-metrics').textContent, /24h Trading Volume\$45,000.00/);
  assert.match(p.document.querySelector('.analytics-market-volume').textContent, /24h market volume/);
  assert.equal(p.document.querySelector('.analytics-market-volume strong').textContent, '$45,000.00');
  assert.match(p.document.querySelector('.analytics-metrics').textContent, /24h launches3/);
  assert.doesNotMatch(p.document.querySelector('.analytics-metrics').textContent, /Unique developers/i);
  assert.equal(p.document.querySelectorAll('.analytics-metrics>.analytics-metric').length, 3);
  assert.equal(p.calls.length, 1); assert.match(p.document.querySelector('.analytics-treasury').textContent, /ALL TIME/);
  assert.equal([...p.timers.values()].filter(timer => timer.ms === 30000).length, 1); p.ui.destroy();
});

test('Total Revenue shows confirmed lifetime USD next to volume and stays all-time in the 24h view',async()=>{
  const revenue={status:'available',complete:true,historyComplete:true,pricingComplete:true,totalUsdEstimate:31207.46,pricedUsdEstimate:31207.46,updatedAt:at,coverage:{sources:['raydium','meteora']}};
  const p=page({respond:async()=>({...snapshot,revenue,lifetime:{recordedVolumeUsdEstimate:380000,coverage:{historyComplete:true},last24h:{recordedVolumeUsdEstimate:12500,historyComplete:true}}})});await p.ui.load();
  const value=()=>p.document.querySelector('[data-analytics-metric="revenue-usd"]');
  assert.equal(value().previousElementSibling.querySelector('h3').textContent,'Lifetime Total Volume');
  assert.equal(value().querySelector('strong').textContent,'$31,207.46');assert.equal(value().dataset.coverage,'complete');assert.match(value().textContent,/All-time recorded protocol revenue · Raydium \+ Meteora · current USD estimate/);
  assert.doesNotMatch(value().textContent,/subtotal/);p.period('24h');assert.equal(value().querySelector('strong').textContent,'$31,207.46');assert.equal(value().querySelector('h3').textContent,'All-time Revenue');assert.match(value().textContent,/All-time recorded protocol revenue · Raydium \+ Meteora/);assert.match(p.document.querySelector('.analytics-metrics').textContent,/24h Trading Volume\$45,000.00/);assert.equal(p.calls.length,1);p.ui.destroy();
});

test('revenue caption includes PumpSwap only when its receipt source is present', async () => {
  const p = page({ respond: async () => ({ ...snapshot, revenue: { status: 'partial', complete: false, historyComplete: false, pricingComplete: true, pricedUsdEstimate: 125, coverage: { sources: ['raydium', 'meteora', 'damm-pump'] } } }) });
  await p.ui.load();
  assert.match(p.document.querySelector('[data-analytics-metric="revenue-usd"]').textContent, /Raydium \+ Meteora \+ PumpSwap · recorded subtotal · partial history/);
  p.ui.destroy();
});

test('headline keeps full amounts without compact notation or digit truncation', async () => {
  const p = page({ respond: async () => ({ ...snapshot,
    lifetime: { recordedVolumeUsdEstimate: 2384615.39, coverage: { historyComplete: false } },
    revenue: { status: 'available', complete: true, historyComplete: true, pricingComplete: true, totalUsdEstimate: 26419.57 },
    launches: { ...snapshot.launches, total: 63 },
  }) });
  await p.ui.load();
  assert.deepEqual([...p.document.querySelectorAll('.analytics-metrics .analytics-metric-value')].map(node => node.textContent), ['$2,384,615.39', '$26,419.57', '63']);
  assert.match(p.document.querySelector('.analytics-metrics').textContent, /Recorded launch-curve subtotal/);
  p.ui.destroy();
});

test('revenue partial coverage remains a labelled subtotal and unavailable data never becomes zero',async()=>{
  const scenarios=[
    [{status:'partial',complete:false,historyComplete:false,pricingComplete:false,totalUsdEstimate:null,pricedUsdEstimate:512.5},'$512.50',/recorded subtotal · partial history and pricing/],
    [{status:'partial',complete:false,historyComplete:true,pricingComplete:false,totalUsdEstimate:null,pricedUsdEstimate:72},'$72.00',/recorded subtotal · partial pricing/],
    [{status:'partial',complete:false,historyComplete:false,pricingComplete:true,totalUsdEstimate:85,pricedUsdEstimate:85},'$85.00',/recorded subtotal · partial history/],
    [{status:'available',complete:true,historyComplete:true,pricingComplete:true,totalUsdEstimate:0,pricedUsdEstimate:0},'$0.00',/current USD estimate/],
    [undefined,'—',/unavailable/],
    [{status:'unavailable',totalUsdEstimate:0,pricedUsdEstimate:0},'—',/unavailable/],
    [{status:'loading',pricedUsdEstimate:123},'—',/unavailable/],
    [{status:'partial',totalUsdEstimate:null,pricedUsdEstimate:null},'—',/unavailable/],
    [{status:'available',totalUsdEstimate:'100',pricedUsdEstimate:NaN},'—',/unavailable/],
    [{status:'available',totalUsdEstimate:-1,pricedUsdEstimate:Infinity},'—',/unavailable/],
  ];
  for(const [revenue,expected,caption] of scenarios){const p=page({respond:async()=>({...snapshot,revenue})});await p.ui.load();const metric=p.document.querySelector('[data-analytics-metric="revenue-usd"]');assert.equal(metric.querySelector('strong').textContent,expected);assert.match(metric.textContent,caption);p.ui.destroy();}
});

test('partial counts and sampled volume display subtotals and observation ranges', async () => {
  const p = page({ respond: async () => ({ ...snapshot, launches: { ...snapshot.launches, total: null, last24h: null, uniqueDevelopers: null, uniqueDevelopers24h: null, complete: false }, volume: { ...snapshot.volume, usd: null, observedUsd: null, sampledUsd: null, sampledObservedUsd: 1400, sampling: { oldestAt: at - 300000, newestAt: at, cachedCoins: 10 } } }) });
  await p.ui.load(); assert.match(p.document.querySelector('.analytics-metrics').textContent, /Recorded subtotal · incomplete coverage/);
  p.period('24h'); assert.match(p.document.querySelector('.analytics-market-volume').textContent, /Sampled subtotal · partial reported coverage/);
  assert.equal(p.document.querySelector('.analytics-market-volume strong').textContent, '$1,400.00');
  assert.match(p.document.querySelector('.analytics-metrics').textContent, /24h Trading Volume\$1,400.00/);
  assert.match(p.document.querySelector('.analytics-sources').textContent, /10 \/ 20/);
  assert.match(p.document.querySelector('.analytics-sources').textContent, /windows are not synchronized/);
  assert.match(p.document.querySelector('.analytics-sources').textContent, /Some launch records are unavailable/); p.ui.destroy();
});

test('missing volume and unconfigured treasury never render unknown amounts as zero', async () => {
  const p = page({ respond: async () => ({ ...snapshot, volume: {}, treasury: { status: 'unconfigured' } }) });
  await p.ui.load(); p.period('24h'); assert.match(p.document.querySelector('.analytics-metrics').textContent, /24h Trading Volume—/);
  assert(!p.ui.element.textContent.includes('$0.00')); assert.match(p.document.querySelector('.analytics-treasury').textContent, /SOL spent on buybacks—SOL/);
  assert.equal(p.document.querySelector('.analytics-history details').hidden, true); p.ui.destroy();
});

test('confirmed protocol purchases and burns stay separate and receipts use validated Solscan links', async () => {
  const p = page(); await p.ui.load();
  assert.match(p.document.querySelector('.analytics-treasury').textContent, /SOL spent on buybacks1.234567SOL/);
  assert.match(p.document.querySelector('.analytics-treasury').textContent, /\$LAUNCHPAD bought100,000LAUNCHPAD/);
  assert.match(p.document.querySelector('.analytics-treasury').textContent, /Recorded burns: 90,000 LAUNCHPAD/);
  const links = [...p.document.querySelectorAll('.analytics-history a')]; assert.equal(links.length, 2);
  assert.equal(links[0].getAttribute('href'), 'https://solscan.io/tx/' + '2'.repeat(88)); assert.equal(links[0].getAttribute('rel'), 'noopener noreferrer');
  assert.match(p.document.querySelector('.analytics-history').textContent, /Buyback1.234567 SOL/); assert.match(p.document.querySelector('.analytics-history').textContent, /Burn90,000 LAUNCHPAD/); p.ui.destroy();
});

test('onchain burned supply shows 186 million and 18.6% while 182.8 million receipts remain separately attributed', async () => {
  const p = page({ respond: async () => ({ ...snapshot,
    burnSupply: supplySnapshot('186000000000000', { burnedPercent: '18.60' }),
    treasury: { ...snapshot.treasury, curvePrice: { mint: curveMint, usd: '0.01', at } },
    burns: { status: 'available', complete: true, curveDecimals: 6, curveBurned: '182800000000000', history: snapshot.treasury.history },
  }) });
  await p.ui.load();
  const total = p.document.querySelector('[data-analytics-metric="burned-supply"]');
  assert.equal(total.querySelector('strong').textContent, '186,000,000LAUNCHPAD');
  assert.match(total.textContent, /18\.6% of original supply · Finalized onchain/);
  assert.equal(total.dataset.coverage, 'available');
  assert.equal(p.document.querySelector('[data-analytics-metric="burned-usd"] strong').textContent, '$1,860,000.00');
  const receipts = p.document.querySelector('[data-analytics-metric="recorded-burns"]');
  assert.match(receipts.textContent, /Recorded burns: 182,800,000 LAUNCHPAD/);
  assert.match(receipts.textContent, /3,200,000 LAUNCHPAD burned outside these saved receipts; attribution is unclassified, not counted as protocol-funded/);
  assert.match(p.document.querySelector('.analytics-treasury').textContent, /SOL spent on buybacks1\.234567SOL/);
  assert.match(p.document.querySelector('.analytics-treasury').textContent, /\$LAUNCHPAD bought100,000LAUNCHPAD/);
  assert.equal(p.document.querySelectorAll('.analytics-history a').length, 2);
  p.ui.destroy();
});

test('stale finalized supply remains visible with last verified timestamp and no current attribution gap', async () => {
  for (const supply of [supplySnapshot('186000000000000', { status: 'stale', at: at - 30000 }), supplySnapshot('186000000000000', { at: at - 60001 })]) {
    const p = page({ respond: async () => ({ ...snapshot, burnSupply: supply, treasury: { ...snapshot.treasury, curvePrice: { mint: curveMint, usd: '0.01', at } } }) });
    await p.ui.load(); const total = p.document.querySelector('[data-analytics-metric="burned-supply"]');
    assert.equal(total.querySelector('strong').textContent, '186,000,000LAUNCHPAD');
    assert.match(total.textContent, /18\.6% of original supply · Last verified/); assert.equal(total.dataset.coverage, 'stale');
    assert.match(p.document.querySelector('[data-analytics-metric="burned-usd"]').textContent, /Last verified burned supply at today’s token price/);
    assert.doesNotMatch(p.document.querySelector('[data-analytics-metric="recorded-burns"]').textContent, /attribution is unclassified/); p.ui.destroy();
  }
});

test('automatic 30-second polling updates burned supply without a reload and marks failed checks stale until recovery', async () => {
  let time = at, response = 0;
  const p = page({ time: () => time, respond: async () => {
    response++;
    if (response === 3) throw new Error('Temporary connection failure');
    return { ...snapshot, generatedAt: time, burnSupply: supplySnapshot(response === 1 ? '182800000000000' : response === 2 ? '186000000000000' : '186100000000000', { at: time }) };
  } });
  // Exactly one poll/retry timer is armed between loads (the 20s request
  // timeout is cleared). A failed check retries sooner than the next poll.
  const poll = async (expectedMs = 30000) => {
    const armed = [...p.timers].filter(([, item]) => item.ms !== 20000);
    assert.equal(armed.length, 1); const [[id, timer]] = armed; assert.equal(timer.ms, expectedMs);
    p.timers.delete(id); time += 30000; timer.fn(); await tick();
  };
  const total = () => p.document.querySelector('[data-analytics-metric="burned-supply"]');
  await p.ui.load();
  assert.equal(total().querySelector('strong').textContent, '182,800,000LAUNCHPAD');
  assert.match(p.document.querySelector('.analytics-live').textContent, /Burn supply checks every 30 seconds/);
  await poll();
  assert.equal(p.calls.length, 2); assert.equal(total().querySelector('strong').textContent, '186,000,000LAUNCHPAD');
  assert.match(total().textContent, /18\.6% of original supply/); assert.equal(total().dataset.coverage, 'available');
  await poll();
  assert.equal(total().querySelector('strong').textContent, '186,000,000LAUNCHPAD');
  assert.equal(total().dataset.coverage, 'stale'); assert.match(total().textContent, /Last verified/);
  assert.match(p.document.querySelector('.analytics-message').textContent, /retrying automatically/);
  await poll(2000);
  assert.equal(p.calls.length, 4); assert.equal(total().querySelector('strong').textContent, '186,100,000LAUNCHPAD');
  assert.equal(total().dataset.coverage, 'available'); assert.doesNotMatch(total().textContent, /Last verified/); p.ui.destroy();
});

test('missing unavailable and invalid supply cannot substitute receipt totals or USD value as total burned', async () => {
  for (const supply of [undefined, { status: 'unavailable' }, supplySnapshot('186000000000000', { status: 'unavailable' }), supplySnapshot('186000000000000', { currentSupply: '815000000000000' }), supplySnapshot('186000000000000', { mint: 'wrong' }), supplySnapshot('186000000000000', { decimals: 9 }), supplySnapshot('186000000000000', { commitment: 'processed' }), supplySnapshot('186000000000000', { at: at + 60000 })]) {
    const p = page({ respond: async () => ({ ...snapshot, burnSupply: supply, treasury: { ...snapshot.treasury, curvePrice: { mint: curveMint, usd: '0.01', at } } }) });
    await p.ui.load(); const total = p.document.querySelector('[data-analytics-metric="burned-supply"]');
    assert.equal(total.querySelector('strong').textContent, '—LAUNCHPAD'); assert.equal(total.dataset.coverage, 'unavailable');
    assert.match(total.textContent, /Onchain burned supply unavailable/);
    assert.equal(p.document.querySelector('[data-analytics-metric="burned-usd"] strong').textContent, '—');
    assert.match(p.document.querySelector('[data-analytics-metric="recorded-burns"]').textContent, /Recorded burns: 90,000 LAUNCHPAD/); p.ui.destroy();
  }
});

test('supply percent rounds raw supply once and a newer receipt ledger never creates a negative gap', async () => {
  const p = page({ respond: async () => ({ ...snapshot, burnSupply: supplySnapshot('185499000000000', { burnedPercent: '18.55' }), burns: { status: 'available', complete: true, curveDecimals: 6, curveBurned: '186000000000000' } }) });
  await p.ui.load(); assert.match(p.document.querySelector('[data-analytics-metric="burned-supply"]').textContent, /18\.5% of original supply/);
  const receipts = p.document.querySelector('[data-analytics-metric="recorded-burns"]').textContent;
  assert.match(receipts, /Recorded receipts and the supply snapshot are awaiting reconciliation/); assert.doesNotMatch(receipts, /-501|attribution is unclassified/); p.ui.destroy();
});

test('automatic direct burns enter public amount, current USD valuation and receipts without inventing purchases',async()=>{
  const amount='50000000000000',mint='7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc',receipt={kind:'burn',source:'direct',funding:'approved-initial-inventory',signature:'4'.repeat(88),inputAmount:amount,outputAmount:'0',confirmedAt:at};
  const p=page({respond:async()=>({...snapshot,burnSupply:supplySnapshot((BigInt(amount)+BigInt(snapshot.treasury.curveBurned)).toString()),treasury:{...snapshot.treasury,curvePrice:{mint,usd:'0.01',at}},burns:{status:'available',complete:true,curveDecimals:6,curveBurned:(BigInt(amount)+BigInt(snapshot.treasury.curveBurned)).toString(),directBurned:amount,history:[receipt,...snapshot.treasury.history]}})});await p.ui.load();
  const text=p.document.querySelector('.analytics-treasury').textContent;assert.match(text,/\$LAUNCHPAD burned · onchain78,039,800LAUNCHPAD/);assert.match(text,/SOL spent on buybacks1\.234567SOL/);assert.match(text,/\$LAUNCHPAD bought100,000LAUNCHPAD/);assert.match(text,/have no recorded buyback cost/);assert.match(text,/next minute refresh/);assert.equal(p.document.querySelector('[data-analytics-metric="burned-usd"] strong').textContent,'$780,398.00');
  assert.match(p.document.querySelector('.analytics-history').textContent,/Direct inventory burn50,000,000 LAUNCHPAD/);assert.equal(p.document.querySelector('.analytics-history a').href,'https://solscan.io/tx/'+receipt.signature);p.ui.destroy();
});

test('direct burn records remain visible if treasury purchases are unavailable',async()=>{
  const p=page({respond:async()=>({...snapshot,treasury:{status:'unavailable'},burns:{status:'partial',complete:false,curveDecimals:6,curveBurned:'1000000',directBurned:'1000000',history:[{kind:'burn',source:'direct',funding:'withheld-tax',signature:'4'.repeat(88),inputAmount:'1000000',confirmedAt:at}]}})});await p.ui.load();const text=p.document.querySelector('.analytics-treasury').textContent;assert.match(text,/SOL spent on buybacks—SOL/);assert.match(text,/Recorded burns: 1 LAUNCHPAD/);assert.match(text,/Recorded burn subtotal/);assert.match(p.document.querySelector('.analytics-history').textContent,/Direct tax burn1 LAUNCHPAD/);p.ui.destroy();
});

test('imported burn-only receipts show current USD value without changing purchase metrics', async () => {
  const mint = '7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc';
  const receipt = { kind: 'burn', source: 'admin', signature: '4'.repeat(88), inputAmount: '250000000', outputAmount: '0', confirmedAt: at };
  const p = page({ respond: async () => ({ ...snapshot,
    burnSupply: supplySnapshot('90250000000'),
    treasury: { ...snapshot.treasury, adminIncluded: true, curvePrice: { mint, usd: '0.01', at } },
    burns: { status: 'available', complete: true, curveDecimals: 6, curveBurned: '90250000000', history: [receipt, ...snapshot.treasury.history] },
  }) });
  await p.ui.load(); const text = p.document.querySelector('.analytics-treasury').textContent;
  assert.match(text, /SOL spent on buybacks1\.234567SOL/); assert.match(text, /\$LAUNCHPAD bought100,000LAUNCHPAD/);
  assert.match(text, /\$LAUNCHPAD burned · onchain90,250LAUNCHPAD/); assert.match(text, /Burn-only entries do not increase SOL spent or LAUNCHPAD bought/);
  assert.equal(p.document.querySelector('[data-analytics-metric="burned-usd"] strong').textContent, '$902.50');
  assert.match(p.document.querySelector('.analytics-history').textContent, /Burn · imported250 LAUNCHPAD/);
  assert.equal(p.document.querySelector('.analytics-history a').href, 'https://solscan.io/tx/' + receipt.signature); p.ui.destroy();
});

test('public analytics explains contributed burns while preserving recorded buyback purchases and spending',async()=>{
  const receipt={kind:'burn',source:'manual',funding:'external-contribution',signature:'5grG4kBMMevX8VGGSrkhXjoSN6n68yistGQVh4uRik9p54jkG2gTwFAdV1Lt8bGwZqaJuLHXLAt7t5MaqSPrkXdW',inputAmount:'5099911699886',outputAmount:'0',confirmedAt:1790647124000};
  const p=page({respond:async()=>({...snapshot,treasury:{...snapshot.treasury,manualIncluded:true,manualContributionBurned:'5099911699886',curveBurned:'5189911699886',history:[receipt,...snapshot.treasury.history]}})});await p.ui.load();
  const treasury=p.document.querySelector('.analytics-treasury');assert.match(treasury.textContent,/SOL spent on buybacks1\.234567SOL/);assert.match(treasury.textContent,/\$LAUNCHPAD bought100,000LAUNCHPAD/);assert.match(treasury.textContent,/Recorded burns: 5,189,911\.699886 LAUNCHPAD/);
  assert.match(treasury.textContent,/5,099,911\.699886 LAUNCHPAD in the recorded burn total came from tokens contributed to the treasury; no protocol buyback spend is recorded for them\./);
  const row=p.document.querySelector('.analytics-history tbody tr');assert.match(row.textContent,/Contributed LAUNCHPAD burn5,099,911\.699886 LAUNCHPAD/);assert.equal(row.querySelector('a').getAttribute('href'),'https://solscan.io/tx/'+receipt.signature);assert.equal(p.calls.length,1);p.ui.destroy();
});

test('public analytics leaves absent and invalid contributed burn amounts unstated',async()=>{
  for(const extra of [{},{manualContributionBurned:null},{manualContributionBurned:'0'},{manualContributionBurned:'-1'},{manualContributionBurned:'1e8'},{manualContributionBurned:5099911699886},{manualContributionBurned:'5099911699886',curveDecimals:null},{manualContributionBurned:'5099911699886',status:'unavailable'}]){
    const p=page({respond:async()=>({...snapshot,treasury:{...snapshot.treasury,...extra}})});await p.ui.load();assert.doesNotMatch(p.document.querySelector('.analytics-treasury').textContent,/tokens contributed to the treasury/);p.ui.destroy();
  }
});

test('daily launch chart has exact accessible table and does not invent unavailable daily volume', async () => {
  const p = page(); await p.ui.load(); const chart = p.document.querySelector('.analytics-chart');
  assert.equal(chart.getAttribute('role'), 'img'); assert.equal(chart.querySelectorAll('rect').length, 2);
  assert.equal(p.document.querySelectorAll('.analytics-chart-wrap .analytics-data-details tbody tr').length, 2);
  assert.match(p.document.querySelector('.analytics-chart-wrap .analytics-data-details').textContent, /2026-09-261Complete/);
  assert.match(p.document.querySelector('.analytics-chart-wrap .analytics-chart-caption').textContent, /Today is still in progress/);
  assert.equal(p.document.querySelectorAll('svg').length, 1); p.ui.destroy();
});

test('daily chart and table hide pre-platform dates from older snapshots while retaining zeroes and incomplete coverage',async()=>{
  const p=page({respond:async()=>({...snapshot,dailyLaunches:{timezone:'UTC',complete:false,days:[
    {date:'2026-09-23',count:0,observedCount:0},
    {date:'2026-09-24',count:0,observedCount:0},
    {date:'2026-09-25',count:null,observedCount:null},
    {date:'2026-09-26',count:null,observedCount:2},
  ]}})});
  await p.ui.load();
  const rows=()=>[...p.document.querySelectorAll('.analytics-chart-wrap .analytics-data-details tbody tr')].map(row=>[...row.querySelectorAll('td')].map(cell=>cell.textContent));
  const expected=[['2026-09-26','2','Recorded subtotal'],['2026-09-25','—','Unavailable'],['2026-09-24','0','Complete']];
  assert.deepEqual(rows(),expected);assert.doesNotMatch(p.document.querySelector('.analytics-chart-wrap').textContent,/2026-09-23|Sep 23/);assert.match(p.document.querySelector('.analytics-chart-wrap .analytics-chart-caption').textContent,/Launch history is incomplete/);
  assert.match(p.document.querySelector('.analytics-metrics').textContent,/Total launches20/);
  p.period('24h');assert.match(p.document.querySelector('.analytics-metrics').textContent,/24h launches3/);assert.deepEqual(rows(),expected);
  p.period('all');assert.match(p.document.querySelector('.analytics-metrics').textContent,/Total launches20/);assert.deepEqual(rows(),expected);p.ui.destroy();
});

// A hidden tab used to abort its in-flight request and refuse to load, so a
// background tab stayed on "Loading public analytics…" with dashes until it was
// shown and then waited for a full slow request. Hidden tabs now finish the
// in-flight load, never poll, and refresh immediately once visible.
test('hidden pages pause polling, finish the in-flight load, refresh immediately when visible and never accept a superseded response', async () => {
  const resolvers = []; const p = page({ respond: () => new Promise(resolve => resolvers.push(resolve)) });
  const first = p.ui.load(); assert.equal(p.calls.length, 1); p.visibility(true);
  assert.equal(p.calls[0].options.signal.aborted, false);
  resolvers[0](snapshot); await first;
  assert.match(p.document.querySelector('.analytics-metrics').textContent, /Total launches20/);
  assert.equal(p.timers.size, 0); await p.ui.load(); assert.equal(p.calls.length, 1);
  p.visibility(false); assert.equal(p.calls.length, 2);
  [...p.timers.values()].find(timer => timer.ms === 20000).fn(); await tick();
  assert.equal(p.calls[1].options.signal.aborted, true);
  assert.match(p.document.querySelector('.analytics-message').textContent, /Showing the previous snapshot/);
  assert.match(p.document.querySelector('.analytics-metrics').textContent, /Total launches20/);
  const [[id, retry]] = [...p.timers]; assert.equal(p.timers.size, 1); assert.equal(retry.ms, 2000);
  p.timers.delete(id); retry.fn(); assert.equal(p.calls.length, 3);
  resolvers[2]({ ...snapshot, generatedAt: at + 1000, launches: { ...snapshot.launches, total: 21 } }); await tick();
  resolvers[1]({ ...snapshot, generatedAt: at + 2000, launches: { ...snapshot.launches, total: 99999 } }); await tick();
  assert.match(p.document.querySelector('.analytics-metrics').textContent, /Total launches21/);
  // An older report (e.g. another server process) never replaces newer numbers.
  p.document.querySelector('.analytics-refresh').onclick(); resolvers[3]({ ...snapshot, launches: { ...snapshot.launches, total: 5 } }); await tick();
  assert.match(p.document.querySelector('.analytics-metrics').textContent, /Total launches21/);
  assert(!p.ui.element.textContent.includes('99,999')); p.ui.destroy();
  const background = page(); background.visibility(true); await background.ui.load();
  assert.equal(background.calls.length, 1); assert.match(background.document.querySelector('.analytics-metrics').textContent, /Total launches20/);
  assert.equal(background.timers.size, 0); background.visibility(false); assert.equal(background.calls.length, 2); background.ui.destroy();
});

test('failed and rate-limited loads retry with backoff, honour Retry-After and converge once the API answers', async () => {
  const { document, window } = parseHTML('<html><body><main id="analytics-main"></main></body></html>');
  Object.defineProperty(document, 'hidden', { value: false, writable: true });
  const timers = new Map(), replies = [503, 503, 503, 429, 200]; let index = 0, calls = 0;
  const ui = createPublicAnalytics({ document, window, now: () => at, setTimer: (fn, ms) => { timers.set(++index, { fn, ms }); return index; }, clearTimer: id => timers.delete(id),
    fetcher: async () => { const status = replies[calls++]; return { ok: status === 200, status, headers: { get: name => status === 429 && name === 'retry-after' ? '45' : null }, json: async () => snapshot }; } });
  const next = async () => { const [[id, timer]] = [...timers]; assert.equal(timers.size, 1); timers.delete(id); timer.fn(); await tick(); return timer.ms; };
  await ui.load(); assert.match(document.querySelector('.analytics-message').textContent, /temporarily unavailable/);
  assert.deepEqual([[...timers.values()][0].ms, await next(), await next(), await next()], [2000, 2000, 5000, 10000]);
  assert.equal([...timers.values()][0].ms, 45000); await next();
  assert.match(document.querySelector('.analytics-metrics').textContent, /Total launches20/); assert.equal([...timers.values()][0].ms, 30000);
  ui.destroy();
});

test('pagehide aborts and pauses work; a bfcache restore reloads immediately', async () => {
  const resolvers = []; const p = page({ respond: () => new Promise(resolve => resolvers.push(resolve)) });
  const first = p.ui.load(); p.window.dispatchEvent(new p.window.Event('pagehide')); await first;
  assert.equal(p.calls[0].options.signal.aborted, true); assert.equal(p.timers.size, 0);
  await p.ui.load(); assert.equal(p.calls.length, 1);
  p.window.dispatchEvent(new p.window.Event('pageshow')); assert.equal(p.calls.length, 2);
  resolvers[1](snapshot); await tick(); resolvers[0]({ ...snapshot, launches: { ...snapshot.launches, total: 99999 } }); await tick();
  assert.match(p.document.querySelector('.analytics-metrics').textContent, /Total launches20/); p.ui.destroy();
});

test('visitor clock skew and cached reports never hide current server numbers', async () => {
  const supply = supplySnapshot('186000000000000', { at: at - 1000 }), curvePrice = { mint: curveMint, usd: '0.01', at: at - 125000 };
  for (const offset of [-10000, 180000]) {
    // The report was generated 25s before it was served; its price was 100s old then.
    const p = page({ time: () => at + offset, respond: async () => ({ ...snapshot, generatedAt: at - 25000, servedAt: at, burnSupply: supply, treasury: { ...snapshot.treasury, curvePrice } }) });
    await p.ui.load(); const burned = p.document.querySelector('[data-analytics-metric="burned-supply"]');
    assert.equal(burned.dataset.coverage, 'available'); assert.equal(burned.querySelector('strong').textContent, '186,000,000LAUNCHPAD');
    assert.equal(p.document.querySelector('[data-analytics-metric="burned-usd"] strong').textContent, '$1,860,000.00');
    assert.doesNotMatch(p.document.querySelector('.analytics-message').textContent, /older than two minutes/); p.ui.destroy();
  }
  // Without a server timestamp an HTTP Date header provides the offset.
  const { document, window } = parseHTML('<html><body><main id="analytics-main"></main></body></html>');
  Object.defineProperty(document, 'hidden', { value: false, writable: true });
  const ui = createPublicAnalytics({ document, window, now: () => at - 10000, setTimer: () => 1, clearTimer: () => {}, fetcher: async () => ({ ok: true, headers: { get: name => name === 'date' ? new Date(at).toUTCString() : null }, json: async () => ({ ...snapshot, burnSupply: supply }) }) });
  await ui.load(); assert.equal(document.querySelector('[data-analytics-metric="burned-supply"]').dataset.coverage, 'available'); ui.destroy();
});

test('a routine poll keeps the previous supply and values on screen without flashing stale or dashes', async () => {
  let time = at, resolve = null;
  const p = page({ time: () => time, respond: () => resolve ? new Promise(done => { resolve = done; }) : ({ ...snapshot, generatedAt: time, burnSupply: supplySnapshot('186000000000000', { at: time - 40000 }), treasury: { ...snapshot.treasury, curvePrice: { mint: curveMint, usd: '0.01', at: time - 60000 } } }) });
  await p.ui.load(); resolve = () => {};
  const view = () => [p.document.querySelector('[data-analytics-metric="burned-supply"]').dataset.coverage, p.document.querySelector('[data-analytics-metric="burned-usd"] strong').textContent, p.document.querySelector('.analytics-metrics .analytics-metric-value').textContent];
  const before = view(); assert.deepEqual(before.slice(0, 2), ['available', '$1,860,000.00']);
  time += 30000; const [[id, timer]] = [...p.timers]; p.timers.delete(id); timer.fn();
  assert.equal(p.calls.length, 2); assert.deepEqual(view(), before); p.ui.destroy();
});

test('quote amount formatting never shows exponents, rejects long decimals or rounds dust to zero', async () => {
  const p = page({ respond: async () => ({ ...snapshot, lifetime: { status: 'partial', recordedVolumeUsdEstimate: 1, coverage: {}, quoteTotals: [null, { symbol: 'DUST', amount: 1e-12, usdEstimate: 0 }, { symbol: 'BIG', amount: 1e21, usdEstimate: 1 }, { symbol: 'LONG', amount: '1.1234567890123456789012', usdEstimate: 1 }] } }) });
  await p.ui.load(); const text = p.document.querySelector('.analytics-lifetime-details').textContent;
  assert.match(text, /DUST<0\.000000001/); assert.match(text, /BIG1,000,000,000,000,000,000,000/); assert.match(text, /LONG1\.123456789012345678\$/); assert.doesNotMatch(text, /e\+|e-|NaN|Infinity/); p.ui.destroy();
});

// The shared motion layer counts up and flashes a number element whose text
// changes. Rebuilding every card on each poll meant it never saw a change, and
// a count-up that rewrites a whole value element would drop its unit label.
test('routine polls update metric cards in place, keep units beside the digits and never retween a switched period', async () => {
  let response = 0;
  const p = page({ respond: async () => { response++; return { ...snapshot, generatedAt: at + response, revenue: { status: 'available', complete: true, historyComplete: true, pricingComplete: true, totalUsdEstimate: 1000 + response }, treasury: { ...snapshot.treasury, solSpent: String(1234567890 + response * 1000000000) } }; } });
  await p.ui.load();
  const value = selector => p.document.querySelector(selector + ' .analytics-metric-value');
  const revenue = value('[data-analytics-metric="revenue-usd"]'), headline = p.document.querySelector('.analytics-metrics .analytics-metric-value');
  const sol = p.document.querySelector('.analytics-treasury-metrics .analytics-metric-value'), chart = p.document.querySelector('.analytics-chart'), receipts = p.document.querySelector('.analytics-history table');
  assert.equal(revenue.textContent, '$1,001.00'); assert.equal(sol.textContent, '2.234567SOL');
  assert.equal(sol.querySelector('[data-motion-number]').textContent, '2.234567'); assert.equal(sol.querySelector('.analytics-unit').textContent, 'SOL');
  const [[id, timer]] = [...p.timers]; p.timers.delete(id); timer.fn(); await tick();
  assert.equal(p.calls.length, 2); assert.equal(value('[data-analytics-metric="revenue-usd"]'), revenue); assert.equal(revenue.textContent, '$1,002.00');
  assert.equal(p.document.querySelector('.analytics-treasury-metrics .analytics-metric-value'), sol); assert.equal(sol.textContent, '3.234567SOL'); assert.equal(sol.querySelector('.analytics-unit').textContent, 'SOL');
  assert.equal(p.document.querySelector('.analytics-chart'), chart); assert.equal(p.document.querySelector('.analytics-history table'), receipts);
  p.period('24h'); assert.notEqual(p.document.querySelector('.analytics-metrics .analytics-metric-value'), headline);
  assert.equal(value('[data-analytics-metric="revenue-usd"]'), revenue); assert.equal(p.document.querySelectorAll('.analytics-metrics>.analytics-metric').length, 3);
  p.period('all'); assert.match(p.document.querySelector('.analytics-metrics').textContent, /Lifetime Total Volume—/); p.ui.destroy();
});

test('routine polls keep Refresh enabled and the page not busy; a first load and an explicit refresh show progress', async () => {
  const resolvers = []; const p = page({ respond: () => new Promise(resolve => resolvers.push(resolve)) });
  const button = p.document.querySelector('.analytics-refresh'), busy = () => [button.disabled, p.ui.element.getAttribute('aria-busy')];
  const first = p.ui.load(); assert.deepEqual(busy(), [true, 'true']); resolvers[0](snapshot); await first; assert.deepEqual(busy(), [false, 'false']);
  const [[id, timer]] = [...p.timers]; p.timers.delete(id); timer.fn(); assert.equal(p.calls.length, 2); assert.deepEqual(busy(), [false, 'false']);
  button.onclick(); assert.equal(p.calls.length, 2); assert.deepEqual(busy(), [true, 'true']);
  resolvers[1](snapshot); await tick(); assert.deepEqual(busy(), [false, 'false']);
  button.onclick(); assert.equal(p.calls.length, 3); assert.deepEqual(busy(), [true, 'true']); resolvers[2](snapshot); await tick(); assert.deepEqual(busy(), [false, 'false']); p.ui.destroy();
});

test('a fetcher that throws synchronously still retries and keeps polling', async () => {
  const { document, window } = parseHTML('<html><body><main id="analytics-main"></main></body></html>');
  Object.defineProperty(document, 'hidden', { value: false, writable: true });
  const timers = new Map(); let index = 0, calls = 0;
  const ui = createPublicAnalytics({ document, window, now: () => at, setTimer: (fn, ms) => { timers.set(++index, { fn, ms }); return index; }, clearTimer: id => timers.delete(id),
    fetcher: () => { if (++calls === 1) throw new TypeError('offline'); return Promise.resolve({ ok: true, json: async () => snapshot }); } });
  await ui.load(); assert.equal(calls, 1); assert.match(document.querySelector('.analytics-message').textContent, /temporarily unavailable/);
  const [[id, retry]] = [...timers]; assert.equal(timers.size, 1); assert.equal(retry.ms, 2000); timers.delete(id); retry.fn(); await tick();
  assert.equal(calls, 2); assert.match(document.querySelector('.analytics-metrics').textContent, /Total launches20/);
  assert.equal([...timers.values()].filter(timer => timer.ms === 30000).length, 1); ui.destroy();
});

test('teardown cancels timers, aborts pending requests and makes late responses inert', async () => {
  let resolve; const p = page({ respond: () => new Promise(done => { resolve = done; }) });
  const pending = p.ui.load(); p.ui.destroy(); assert.equal(p.calls[0].options.signal.aborted, true); assert.equal(p.timers.size, 0);
  resolve(snapshot); await pending; assert(!p.ui.element.textContent.includes('45,000'));
  p.visibility(false); await p.ui.load(); assert.equal(p.calls.length, 1);
});

test('temporary refresh failure preserves snapshot with explicit stale label and hides error details', async () => {
  let fail = false; const p = page({ respond: async () => { if (fail) throw Error('private rpc api-key=secret'); return snapshot; } });
  await p.ui.load(); fail = true; await p.ui.load(); assert.match(p.document.querySelector('.analytics-message').textContent, /Showing the previous snapshot/);
  assert.equal(p.document.querySelector('.analytics-message').dataset.state, 'stale'); assert(!p.ui.element.textContent.includes('secret'));
  assert.match(p.document.querySelector('.analytics-metrics').textContent, /Total launches20/); assert.equal(p.timers.size, 1); p.ui.destroy();
});

test('stale data, request timeout and malformed responses remain visibly unavailable', async () => {
  const stale = page({ time: () => at + 180000 }); await stale.ui.load(); assert.match(stale.document.querySelector('.analytics-message').textContent, /older than two minutes/); stale.ui.destroy();
  const malformed = page({ respond: async () => ({ ok: true }) }); await malformed.ui.load(); assert.match(malformed.document.querySelector('.analytics-message').textContent, /temporarily unavailable/); malformed.ui.destroy();
  let resolve; const timeout = page({ respond: () => new Promise(done => { resolve = done; }) }); const pending = timeout.ui.load();
  [...timeout.timers.values()].find(timer => timer.ms === 20000).fn(); assert.equal(timeout.calls[0].options.signal.aborted, true);
  resolve(snapshot); await pending; assert.match(timeout.document.querySelector('.analytics-message').textContent, /temporarily unavailable/); timeout.ui.destroy();
});

test('untrusted response content never creates markup, addresses, executable links or event handlers', async () => {
  const p = page({ respond: async () => ({ ...snapshot, scope: '<img src=x onerror=steal()>', dailyLaunches: { days: [{ date: '<svg/onload=steal()>', count: 99 }] }, treasury: { ...snapshot.treasury, history: [{ kind: 'buy', signature: 'javascript:steal()', confirmedAt: at, inputAmount: '100' }] }, launches: { ...snapshot.launches, total: '<script>x</script>', observedTotal: null } }) });
  await p.ui.load(); assert.equal(p.ui.element.querySelector('img,script,[onerror],[onload]'), null); assert.equal(p.ui.element.querySelector('a[href^="javascript"]'), null);
  assert.equal(p.ui.element.querySelectorAll('.analytics-history a').length, 0); p.ui.destroy();
});

test('lifetime headline uses persisted trade totals with current-price and market-scope labels', async () => {
  const p = page({ respond: async () => ({ ...snapshot, lifetime: { status: 'partial', recordedVolumeUsdEstimate: 380000, pricedVolumeUsdEstimate: 380000, coverage: { historyComplete: false, launches: 20, backfilledLaunches: 12 }, quoteTotals: [{ symbol: 'USDC', amount: 380000, usdEstimate: 380000 }], updatedAt: at } }) });
  await p.ui.load(); assert.match(p.document.querySelector('.analytics-metrics').textContent, /Lifetime Total Volume\$380,000.00/);
  assert.match(p.document.querySelector('.analytics-metrics').textContent, /Recorded launch-curve subtotal · partial history · current-price USD estimate/);
  assert.match(p.document.querySelector('.analytics-window-note').textContent, /post-graduation pools are excluded/);
  assert.match(p.document.querySelector('.analytics-window-note').textContent, /History sync: 12 \/ 20/);
  assert.match(p.document.querySelector('.analytics-lifetime-details').textContent, /USDC380,000\$380,000.00/);
  p.period('24h'); assert.equal(p.document.querySelector('.analytics-lifetime-details').hidden, true); assert.match(p.document.querySelector('.analytics-metrics').textContent, /24h Trading Volume\$45,000.00/); assert.equal(p.document.querySelector('.analytics-market-volume strong').textContent, '$45,000.00'); p.ui.destroy();
});

test('holder rewards replace agent metrics with unique wallets paid and retain paired-asset subtotals', async () => {
  const metric = { usdEstimate: null, observedUsdEstimate: 400, historyComplete: false, valuationComplete: false, quoteTotals: [{ symbol: '<img src=x>', amount: '1234.567890123456789', usdEstimate: null }, { symbol: 'USDC', amount: '400', usdEstimate: 400 }] };
  const p = page({ respond: async () => ({ ...snapshot, rewards: { holders: { distributed: metric, uniqueWallets: 125, observedUniqueWallets: 125, walletsComplete: true }, agents: { buybacks: { ...metric, usdEstimate: 600, historyComplete: true, valuationComplete: true }, boughtAndBurned: { ...metric, usdEstimate: 0, historyComplete: true, valuationComplete: true } } } }) });
  await p.ui.load(); const section = p.document.querySelector('.analytics-rewards');
  assert.match(section.textContent, /Current value of rewards sent\$400.00/); assert.match(section.textContent, /partial USD estimate/);
  assert.match(section.textContent, /valued today/); assert.match(section.textContent, /not the dollar amount paid at the time/);
  assert.match(section.textContent, /Wallets paid125/); assert.match(section.textContent, /Unique wallets paid across all holder reward coins/);
  assert.doesNotMatch(section.textContent, /Legacy agent|bought & burned|\$600.00/);
  assert.match(section.textContent, /1,234.567890123456789/); assert.match(section.textContent, /Each wallet is counted once/);
  assert.equal(section.querySelector('img'), null); p.ui.destroy();
});

test('analytics page uses external assets, persistent shared search shell and a no-script footer entry', async () => {
  const html = await readFile(new URL('../public/analytics.html', import.meta.url), 'utf8');
  const { document } = parseHTML(html); assert.equal(document.querySelector('body').dataset.page, 'analytics');
  assert.equal(document.querySelector('script:not([src])'), null); assert.equal(document.querySelector('[style]'), null);
  assert.equal(document.querySelector('footer a[href="/analytics"]').textContent, 'Analytics');
  const js = await readFile(new URL('../public/analytics.js', import.meta.url), 'utf8'); assert.match(js, /createWorkspaceShell/); assert.match(js, /bootPage\('analytics', mountPage\)/);
});

test('synced lifetime history with incomplete prices displays a priced USD subtotal and correct explanation', async () => {
  const p = page({ respond: async () => ({ ...snapshot, lifetime: { status: 'partial', tradeCount: 638, recordedVolumeUsdEstimate: null, pricedVolumeUsdEstimate: 3164.52, coverage: { historyComplete: true, launches: 11, backfilledLaunches: 11 } } }) });
  await p.ui.load(); const text = p.document.querySelector('.analytics-metrics').textContent;
  assert.match(text, /Lifetime Total Volume\$3,164.52/); assert.match(text, /partial pricing · current-price USD estimate/); p.ui.destroy();
});
test('USD pricing outage does not claim saved trade history is missing', async () => {
  const p = page({ respond: async () => ({ ...snapshot, lifetime: { status: 'partial', tradeCount: 638, recordedVolumeUsdEstimate: null, pricedVolumeUsdEstimate: null, coverage: { historyComplete: true } } }) });
  await p.ui.load(); const text = p.document.querySelector('.analytics-metrics').textContent;
  assert.match(text, /USD pricing is refreshing · 638 trades recorded/); assert.doesNotMatch(text, /Historical volume is not available yet/); p.ui.destroy();
});
test('rolling headline uses market volume without adding the overlapping saved ledger', async () => {
  const p = page({ respond: async () => ({ ...snapshot, volume: { ...snapshot.volume, usd: null, observedUsd: 45 }, lifetime: { last24h: { recordedVolumeUsdEstimate: 150, pricedVolumeUsdEstimate: 150, historyComplete: true } } }) });
  await p.ui.load(); p.period('24h'); const text = p.document.querySelector('.analytics-metrics').textContent;
  assert.match(text, /24h Trading Volume\$45.00/); assert.doesNotMatch(text, /\$150.00/); assert.doesNotMatch(text, /\$195.00/); assert.equal(p.document.querySelector('.analytics-market-volume strong').textContent, '$45.00');
  assert.match(p.document.querySelector('.analytics-window-note').textContent, /including trading after graduation/); p.ui.destroy();
});
test('wallet counts distinguish an observed subtotal from a complete zero', async () => {
  for (const [holders, expected] of [[{ uniqueWallets: null, observedUniqueWallets: 12, walletsComplete: false }, /Wallets paid12Verified unique wallets · recorded subtotal/], [{ uniqueWallets: 0, observedUniqueWallets: 0, walletsComplete: true }, /Wallets paid0Unique wallets paid/], [{ uniqueWallets: null, observedUniqueWallets: null, walletsComplete: false }, /Wallets paid—Recipient history/]]) {
    const p = page({ respond: async () => ({ ...snapshot, rewards: { holders } }) }); await p.ui.load(); assert.match(p.document.querySelector('.analytics-rewards').textContent, expected); p.ui.destroy();
  }
});

test('holder rewards table separates unknown history, verified zero, partial payouts and missing USD prices',async()=>{
  const p=page({respond:async()=>({...snapshot,rewards:{holders:{walletsComplete:false,observedUniqueWallets:38,distributed:{historyComplete:false,valuationComplete:false,usdEstimate:null,observedUsdEstimate:1089.37,quoteTotals:[
    {symbol:'FLWS',amount:null,usdEstimate:null,historyComplete:false},
    {symbol:'OPENAI',amount:'0',usdEstimate:0},
    {symbol:'SOL',amount:'7.41583209',usdEstimate:1089.37,historyComplete:false},
    {symbol:'SV151',amount:'194.302518',usdEstimate:null,historyComplete:true},
    {symbol:'KOx',amount:'0',usdEstimate:0,historyComplete:true},
  ]}}}})});
  await p.ui.load();const rows=[...p.document.querySelectorAll('.analytics-rewards tbody tr')].map(row=>[...row.querySelectorAll('td')].map(cell=>cell.textContent));
  assert.deepEqual(rows,[['FLWS','—','—','History unavailable'],['OPENAI','—','—','History unavailable'],['SOL','7.41583209','$1,089.37','Recorded subtotal'],['SV151','194.302518','—','USD price unavailable'],['KOx','0','$0.00','Complete']]);
  assert.match(p.document.querySelector('.analytics-rewards').textContent,/Wallets paid38/);assert.match(p.document.querySelector('.analytics-rewards').textContent,/partial USD estimate/);assert.match(p.document.querySelector('.analytics-rewards').textContent,/does not mean nothing was distributed/);p.ui.destroy();
});

test('24h headline includes graduated pool volume while lifetime retains its separate recorded history', async () => {
  const p = page({ respond: async () => ({ ...snapshot,
    volume: { ...snapshot.volume, usd: 3518206 },
    lifetime: { status: 'partial', recordedVolumeUsdEstimate: 2290473.18, coverage: { historyComplete: false, backfillComplete: false, launches: 63, backfilledLaunches: 62, headFreshLaunches: 61 },
      last24h: { recordedVolumeUsdEstimate: 241873.05, historyComplete: false } },
  }) });
  await p.ui.load();
  const volume = () => p.document.querySelector('.analytics-metrics .analytics-metric-value').textContent;
  const market = p.document.querySelector('.analytics-market-volume');
  assert.equal(volume(), '$2,290,473.18');
  assert.equal(market.querySelector('strong').textContent, '$3,518,206.00');
  assert.match(market.textContent, /24h market volume.*Launch curves \+ graduated pools/);
  assert.match(p.document.querySelector('.analytics-window-note').textContent, /Complete all-time market volume is not available yet/);
  assert.match(p.document.querySelector('.analytics-window-note').textContent, /Latest trades current: 61 \/ 63/);
  p.period('24h');
  assert.equal(volume(), '$3,518,206.00');
  assert.match(p.document.querySelector('.analytics-metrics').textContent, /24h Trading Volume.*complete reported coverage/);
  assert.match(p.document.querySelector('.analytics-window-note').textContent, /Lifetime volume has separate, incomplete historical coverage/);
  assert.equal(market.querySelector('strong').textContent, '$3,518,206.00');
  assert.equal(p.calls.length, 1);
  p.ui.destroy();
});

test('unavailable saved history hides lifetime values but does not hide valid market volume', async () => {
  for (const status of ['unavailable', 'loading']) {
    const p = page({ respond: async () => ({ ...snapshot, lifetime: { status, recordedVolumeUsdEstimate: 900, pricedVolumeUsdEstimate: 900, tradeCount: 3, coverage: { historyComplete: true }, quoteTotals: [{ symbol: 'STALE', amount: 900, usdEstimate: 900 }], last24h: { recordedVolumeUsdEstimate: 100, pricedVolumeUsdEstimate: 100, historyComplete: true } } }) });
    await p.ui.load();
    assert.equal(p.document.querySelector('.analytics-metrics .analytics-metric-value').textContent, '—');
    assert.match(p.document.querySelector('.analytics-metrics').textContent, status === 'unavailable' ? /saved history unavailable/ : /history is loading/);
    p.period('24h');
    assert.equal(p.document.querySelector('.analytics-metrics .analytics-metric-value').textContent, '$45,000.00');
    assert.doesNotMatch(p.document.querySelector('.analytics-metrics').textContent, /saved history|history is loading/);
    assert.doesNotMatch(p.document.querySelector('.analytics-lifetime-details').textContent, /STALE|\$900/);
    p.ui.destroy();
  }
});

test('completed backfill with stale current trades stays a labelled subtotal', async () => {
  const p = page({ respond: async () => ({ ...snapshot, lifetime: { status: 'partial', recordedVolumeUsdEstimate: 1200, coverage: { historyComplete: false, backfillComplete: true, headFreshLaunches: 1, launches: 2, backfilledLaunches: 2 }, last24h: { recordedVolumeUsdEstimate: 300, historyComplete: false } } }) });
  await p.ui.load();
  {
    p.period('all'); assert.equal(p.document.querySelector('.analytics-metrics').dataset.volumeCoverage, 'partial');
    assert.match(p.document.querySelector('.analytics-metrics').textContent, /Recorded launch-curve subtotal · latest trades syncing/);
    assert.match(p.document.querySelector('.analytics-window-note').textContent, /Latest trades current: 1 \/ 2/);
  }
  p.ui.destroy();
});

test('PumpSwap onchain history labels both pools without claiming other venues have full AMM history', async () => {
  const p = page({ respond: async () => ({ ...snapshot, lifetime: { status: 'partial', recordedVolumeUsdEstimate: 1000,
    coverage: { historyComplete: false, postGraduationIncluded: true, launches: 2, backfilledLaunches: 1 },
    quoteTotals: [{ symbol: 'SOL', amount: 10, usdEstimate: 1000 }], last24h: { recordedVolumeUsdEstimate: 700 } } }) });
  await p.ui.load();
  {
    p.period('all');
    assert.match(p.document.querySelector('.analytics-metrics').textContent, /Recorded trading volume/);
    assert.match(p.document.querySelector('.analytics-window-note').textContent, /original Meteora pool and verified PumpSwap pool, including external wallet trades/);
    assert.match(p.document.querySelector('.analytics-window-note').textContent, /Other launch modes retain limited pool coverage/);
    assert.doesNotMatch(p.document.querySelector('.analytics-window-note').textContent, /post-graduation pools are excluded/i);
  }
  assert.match(p.document.querySelector('.analytics-market-volume').textContent, /Provider market snapshot; coverage may differ/);
  p.period('all'); assert.match(p.document.querySelector('.analytics-lifetime-details').textContent, /Includes original Meteora and verified PumpSwap pools/); p.ui.destroy();
});


test('fresh partial market volume keeps fresh source labels when an older partial sample also exists', async () => {
  const p = page({ respond: async () => ({ ...snapshot, volume: { ...snapshot.volume, usd: null, observedUsd: 45, sampledUsd: null, sampledObservedUsd: 1400, coverage: { launches: 20, usdComplete: 3 }, sampling: { cachedCoins: 10, oldestAt: at - 300000, newestAt: at - 60000 } } }) });
  await p.ui.load();
  assert.equal(p.document.querySelector('.analytics-market-volume strong').textContent, '$45.00');
  assert.match(p.document.querySelector('.analytics-sources').textContent, /3 \/ 20Coins with complete fresh USD volume/);
  assert.match(p.document.querySelector('.analytics-sources').textContent, /Snapshot:/);
  assert.doesNotMatch(p.document.querySelector('.analytics-sources').textContent, /Sampled 24h|windows are not synchronized/);
  p.ui.destroy();
});


test('reported LAUNCHPAD and EXAMPLE market volume cannot be replaced by a small history subtotal', async () => {
  const p = page({ respond: async () => ({ ...snapshot,
    volume: { ...snapshot.volume, usd: null, observedUsd: 1284316.42, complete: false },
    lifetime: { status: 'partial', recordedVolumeUsdEstimate: 1437902.55, coverage: { historyComplete: false },
      last24h: { recordedVolumeUsdEstimate: 29871.36, historyComplete: false } },
  }) });
  await p.ui.load(); p.period('24h');
  const headline = p.document.querySelector('.analytics-metrics');
  assert.match(headline.textContent, /24h Trading Volume\$1,284,316.42/);
  assert.match(headline.textContent, /partial reported coverage/);
  assert.doesNotMatch(headline.textContent, /29,871.36|1,314,187.78/);
  assert.equal(p.document.querySelector('.analytics-market-volume').hidden, true);
  assert.equal(headline.dataset.volumeCoverage, 'partial');
  p.period('all');
  assert.equal(p.document.querySelector('.analytics-market-volume').hidden, false);
  assert.equal(headline.querySelector('strong').textContent, '$1,437,902.55');
  p.ui.destroy();
});

test('lifetime indexed history explains historical USD separately from remaining quote estimates', async () => {
  const p = page({ respond: async () => ({ ...snapshot, lifetime: {
    status: 'partial', recordedVolumeUsdEstimate: 4800000, indexedHistoricalVolumeUsd: 4200000, curveVolumeUsdEstimate: 600000,
    coverage: { indexedPools: 15, indexedRecordedPools: 12, postGraduationIncluded: true, historyComplete: false },
    quoteTotals: [{ symbol: 'SOL', amount: 5000, usdEstimate: 600000 }],
  } }) });
  await p.ui.load();
  assert.match(p.document.querySelector('.analytics-metrics').textContent, /Lifetime Total Volume\$4,800,000.00Historical pool volume \+ recorded launch trades/);
  assert.match(p.document.querySelector('.analytics-window-note').textContent, /Overlapping pool and saved-trade records count once/);
  assert.match(p.document.querySelector('.analytics-lifetime-details').textContent, /Indexed historical pool volume: \$4,200,000.00. Remaining saved-trade estimate: \$600,000.00/);
  assert.doesNotMatch(p.document.querySelector('.analytics-window-note').textContent, /post-graduation pools are excluded/);
  p.ui.destroy();
});

test('expected indexed pools alone do not claim historical pool volume is already included', async () => {
  const p = page({ respond: async () => ({ ...snapshot, lifetime: { status: 'partial', recordedVolumeUsdEstimate: 1000,
    indexedHistoricalVolumeUsd: 0, coverage: { indexedPools: 15, indexedRecordedPools: 0, historyComplete: false } } }) });
  await p.ui.load();
  assert.doesNotMatch(p.document.querySelector('.analytics-metrics').textContent, /Historical pool volume/);
  p.ui.destroy();
});


// ---- v71.26 makeover: charts, sparklines, deltas and chart interaction ----
test('chart helpers produce clean ticks, compact labels without "$0.00" and window deltas only from complete days', () => {
  assert.deepEqual(analyticsTicks(14, 4, true), { max: 15, ticks: [0, 5, 10, 15] });
  assert.deepEqual(analyticsTicks(2_200_000), { max: 3_000_000, ticks: [0, 1_000_000, 2_000_000, 3_000_000] });
  assert.deepEqual(analyticsTicks(0.5), { max: 0.6, ticks: [0, 0.2, 0.4, 0.6] });
  assert.deepEqual(analyticsTicks(0, 4, true).ticks, [0, 1, 2, 3, 4]);
  assert.equal(analyticsCompact(0, { currency: true }), '$0'); assert.equal(analyticsCompact(412_000, { currency: true }), '$412K');
  assert.equal(analyticsCompact(1_500_000, { currency: true }), '$1.5M'); assert.equal(analyticsCompact(2_000_000_000, { currency: true }), '$2B');
  assert.equal(analyticsCompact(6.875), '6.88'); assert.equal(analyticsCompact(14), '14'); assert.equal(analyticsCompact(null), '—');
  assert.deepEqual(analyticsWindowDelta([1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2]), { days: 7, current: 14, previous: 7, percent: 100 });
  assert.equal(analyticsWindowDelta([1, 1, 1, null, 2, 2, 2, 2]), null);
  assert.equal(analyticsWindowDelta([0, 0, 0, 0, 3, 3, 3, 3]), null);
  assert.equal(analyticsWindowDelta([5, 4, 1]), null); assert.deepEqual(analyticsWindowDelta([4, 4, 2, 2]), { days: 2, current: 4, previous: 8, percent: -50 });
});

const dayAt = n => new Date(at - n * 86400000).toISOString().slice(0, 10);
test('daily volume chart draws the saved ledger by UTC day, dims partial days, fills gaps only when history is complete and has a table twin', async () => {
  const daily = [{ date: dayAt(3), tradeCount: 10, completePricing: true, volumeUsdEstimate: 1200, pricedVolumeUsdEstimate: 1200 }, { date: dayAt(2), tradeCount: 4, completePricing: false, volumeUsdEstimate: null, pricedVolumeUsdEstimate: 300 }, { date: dayAt(0), tradeCount: 7, completePricing: true, volumeUsdEstimate: 900, pricedVolumeUsdEstimate: 900 }];
  const p = page({ respond: async () => ({ ...snapshot, lifetime: { status: 'partial', recordedVolumeUsdEstimate: 2400, coverage: { historyComplete: true }, daily } }) });
  await p.ui.load();
  const svg = p.document.querySelector('.analytics-volume-chart');
  assert.equal(svg.getAttribute('role'), 'img'); assert.equal(svg.getAttribute('tabindex'), '0'); assert(svg.classList.contains('is-single'));
  assert.equal(svg.querySelectorAll('.hit').length, 4); assert.equal(svg.querySelectorAll('path.bar').length, 3); // the complete zero day has a hit area but no bar
  assert.equal(svg.querySelectorAll('path.bar.is-partial').length, 1); assert.equal(svg.querySelector('.bar-label').textContent, '$900');
  assert(svg.querySelectorAll('.grid-line, .axis-line').length >= 3); assert.match(svg.querySelector('.axis-y').textContent, /^\$/);
  const rows = [...p.document.querySelectorAll('.analytics-volume-card tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent));
  assert.deepEqual(rows, [[dayAt(0), '$900.00', '7', 'Complete'], [dayAt(1), '$0.00', '—', 'Complete'], [dayAt(2), '$300.00', '4', 'Recorded subtotal'], [dayAt(3), '$1,200.00', '10', 'Complete']]);
  assert.doesNotMatch(p.document.querySelector('.analytics-volume-card').textContent, /NaN|undefined/);
  p.ui.destroy();
  // A syncing ledger leaves missing days unknown, and an unavailable one shows no chart at all.
  const partial = page({ respond: async () => ({ ...snapshot, lifetime: { status: 'partial', coverage: { historyComplete: false }, daily } }) }); await partial.ui.load();
  assert.equal(partial.document.querySelectorAll('.analytics-volume-chart path.bar').length, 3); assert.match(partial.document.querySelector('.analytics-volume-card tbody').textContent, /Unavailable/); partial.ui.destroy();
  const none = page({ respond: async () => ({ ...snapshot, lifetime: { status: 'unavailable' } }) }); await none.ui.load();
  assert.equal(none.document.querySelector('.analytics-volume-chart'), null); assert.match(none.document.querySelector('.analytics-volume-plot .analytics-empty').textContent, /taking a break/); none.ui.destroy();
});

test('launch chart stacks per-venue counts in fixed colour slots when the report carries them and keeps one series otherwise', async () => {
  const days = [{ date: '2026-09-25', count: 5, observedCount: 5, venues: { raydium: 2, meteora: 1, 'damm-pump': 1 } }, { date: '2026-09-26', count: 3, observedCount: 3, venues: { raydium: 3 } }];
  const p = page({ respond: async () => ({ ...snapshot, dailyLaunches: { timezone: 'UTC', complete: true, days } }) }); await p.ui.load();
  const svg = p.document.querySelector('.analytics-launch-chart');
  assert(svg.classList.contains('is-stacked')); assert.equal(svg.querySelectorAll('path.bar').length, 5);
  assert.equal(svg.querySelectorAll('[data-col="0"] path.bar').length, 4); // Raydium, Meteora, PumpSwap and the unattributed remainder
  assert.deepEqual([...p.document.querySelectorAll('.analytics-chart-wrap .analytics-legend-item')].map(node => node.textContent), ['Raydium', 'Meteora', 'PumpSwap', 'Other']);
  assert.deepEqual([...p.document.querySelectorAll('.analytics-chart-wrap thead th')].map(node => node.textContent), ['Date (UTC)', 'Launches', 'Coverage', 'Raydium', 'Meteora', 'PumpSwap']);
  assert.match(p.document.querySelector('.analytics-chart-wrap tbody tr').textContent, /2026-09-263Complete3——/);
  p.ui.destroy();
  // Venue counts that exceed the day's total cannot be trusted: single series, no legend.
  const broken = page({ respond: async () => ({ ...snapshot, dailyLaunches: { timezone: 'UTC', complete: true, days: [{ date: '2026-09-25', count: 1, observedCount: 1, venues: { raydium: 2 } }] } }) }); await broken.ui.load();
  assert(broken.document.querySelector('.analytics-launch-chart').classList.contains('is-single')); assert.equal(broken.document.querySelector('.analytics-chart-wrap .analytics-legend'), null); broken.ui.destroy();
});

test('receipt charts draw SOL spent and LAUNCHPAD burned by day from the deduplicated daily series and stay hidden without it', async () => {
  const p = page(); await p.ui.load();
  assert.equal(p.document.querySelector('.analytics-receipt-charts').hidden, true); assert.equal(p.document.querySelector('.analytics-buy-chart'), null); p.ui.destroy();
  const rows = [{ date: dayAt(1), solSpent: '2500000000', curveBurned: '7000000000', buys: 1, burns: 1 }, { date: dayAt(0), solSpent: '0', curveBurned: '1000000000', buys: 0, burns: 1 }];
  const q = page({ respond: async () => ({ ...snapshot, burns: { status: 'available', complete: false, curveDecimals: 6, curveBurned: '8000000000', history: snapshot.treasury.history, daily: { timezone: 'UTC', days: 30, complete: false, solDecimals: 9, curveDecimals: 6, rows } } }) }); await q.ui.load();
  assert.equal(q.document.querySelector('.analytics-receipt-charts').hidden, false);
  const buy = q.document.querySelector('.analytics-buy-chart'), burn = q.document.querySelector('.analytics-burn-chart');
  assert.equal(buy.querySelectorAll('path.bar').length, 1); assert.equal(burn.querySelectorAll('path.bar').length, 2);
  assert.match(buy.querySelector('title').textContent, /SOL spent/); assert.match(burn.querySelector('.bar-label').textContent, /^1K$/);
  assert.match(q.document.querySelector('.analytics-chart-caption + .analytics-treasury-note, .analytics-treasury .analytics-chart-caption').textContent, /recorded subtotal/);
  assert.doesNotMatch(q.document.querySelector('.analytics-treasury').textContent, /NaN/); q.ui.destroy();
});

test('headline tiles carry a sparkline and a window delta from complete days only, and a burned-supply meter', async () => {
  const days = Array.from({ length: 14 }, (_, index) => ({ date: dayAt(13 - index), count: index < 7 ? 2 : 3, observedCount: index < 7 ? 2 : 3 }));
  const p = page({ respond: async () => ({ ...snapshot, dailyLaunches: { timezone: 'UTC', complete: true, days }, burnSupply: supplySnapshot('186000000000000') }) }); await p.ui.load();
  const launches = [...p.document.querySelectorAll('.analytics-metrics>.analytics-metric')][2];
  assert.equal(launches.querySelector('.analytics-metric-label').textContent, 'Total launches');
  assert(launches.querySelector('.analytics-spark')); assert.equal(launches.querySelector('.analytics-delta b').textContent, '+50%');
  assert.equal(launches.querySelector('.analytics-delta').dataset.direction, 'up'); assert.match(launches.querySelector('.analytics-delta span').textContent, /last 7d vs the 7d before/);
  assert.equal([...p.document.querySelectorAll('.analytics-metrics>.analytics-metric')][1].querySelector('.analytics-metric-trend').hidden, true);
  const meter = p.document.querySelector('[data-analytics-metric="burned-supply"] .analytics-meter');
  assert.equal(meter.style.getPropertyValue('--value'), '0.186'); assert.match(meter.getAttribute('aria-label'), /18\.6% of the 1,000,000,000 original supply burned/);
  p.ui.destroy();
  const gap = page({ respond: async () => ({ ...snapshot, dailyLaunches: { timezone: 'UTC', complete: false, days: days.map((day, index) => index === 10 ? { ...day, count: null } : day) } }) }); await gap.ui.load();
  const tile = [...gap.document.querySelectorAll('.analytics-metrics>.analytics-metric')][2];
  assert.equal(tile.querySelector('.analytics-delta'), null); assert(tile.querySelector('.analytics-spark')); gap.ui.destroy();
});

test('chart tooltips answer hover and keyboard without gating any value', async () => {
  const p = page(); await p.ui.load();
  const svg = p.document.querySelector('.analytics-launch-chart'), host = svg.parentElement, tip = host.querySelector('.analytics-tip');
  assert.equal(tip.hidden, true);
  const hit = svg.querySelectorAll('.hit')[1]; hit.dispatchEvent(new p.window.Event('pointerover', { bubbles: true }));
  assert.equal(tip.hidden, false); assert.match(tip.textContent, /Sep 26, 2026/); assert.match(tip.querySelector('.analytics-tip-row b').textContent, /^1$/);
  assert(svg.querySelector('[data-col="1"]').classList.contains('is-hover'));
  const key = name => { const event = new p.window.Event('keydown', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'key', { value: name }); svg.dispatchEvent(event); };
  key('ArrowLeft'); assert.match(tip.textContent, /Sep 25, 2026/); assert.match(tip.querySelector('.analytics-tip-row b').textContent, /^2$/);
  key('End'); assert.match(tip.textContent, /Sep 26, 2026/); key('Escape'); assert.equal(tip.hidden, true);
  assert.equal(svg.querySelectorAll('[data-col].is-hover').length, 0);
  // Every bar also carries its value as a title, and the table twin lists the same numbers.
  assert.match(svg.querySelector('path.bar title').textContent, /Sep 25, 2026: 2 launches/);
  assert.match(p.document.querySelector('.analytics-chart-wrap tbody').textContent, /2026-09-261Complete2026-09-252Complete/);
  p.ui.destroy();
});
