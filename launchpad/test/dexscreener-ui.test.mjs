import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { renderIfChanged, openPositionCount } from '../public/ui-performance.mjs';
import * as dexView from '../public/dexscreener-view.mjs';
import * as holderView from '../public/holders-view.mjs';
import * as liveView from '../public/live-trades-view.mjs';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const RH_TOKEN = `0x${'a'.repeat(40)}`;
const RH_POOL = `0x${'b'.repeat(40)}`;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function pool(overrides = {}) {
  return {
    address: POOL, token: SOL, symbol: 'SOL', name: 'Wrapped SOL', pair: 'SOL / USDC', dex: 'raydium',
    base: { address: SOL, symbol: 'SOL' }, quote: { address: USDC, symbol: 'USDC' }, isBase: true,
    priceUsd: 123, liquidityUsd: 250000, volume24h: 90000, marketCapUsd: 400000, fdvUsd: 500000,
    priceChange: { m5: 1, h1: -2, h6: 3, h24: 4 },
    txns: { m5: { buys: 2, sells: 1 }, h1: { buys: 4, sells: 3 }, h6: { buys: 8, sells: 5 }, h24: { buys: 20, sells: 10 } },
    volume: { m5: 100, h1: 300, h6: 900, h24: 90000 },
    url: 'https://attacker.invalid/not-a-trusted-provider', ...overrides,
  };
}
function snapshot(tokenAddress, pools, at = Date.now()) {
  return { chain: 'solana', tokenAddress, pools, at, source: 'DEX Screener', refreshMs: 60000, note: pools.length ? null : 'No indexed pool found yet.' };
}

async function terminal({ chain = 'solana', respond, overview = { sessions: [], at: Date.now() } } = {}) {
  const { document, window } = parseHTML(`<html><body><div id="owner-sessions"></div><div data-owner-monitor></div>
    <nav class="strategy-tabs"><button data-tab="copy">Copy</button><button data-tab="market">Market</button></nav>
    <nav id="rh-tools"><button data-kind="copy">Copy</button><button data-kind="market">Market</button></nav>
    <main><div class="workspace"><section class="manual-card"><input id="manual-mint"></section>
    <section id="rh-manual-card"><input id="rh-manual-token"></section><section class="execution-preset-card"></section></div></main>
    </body></html>`);
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { return [...this.options].find(option => option.selected)?.value || this.options[0]?.value || ''; },
    set(value) { for (const option of this.options) option.removeAttribute('selected'); const option = [...this.options].find(option => option.value === String(value)); option?.setAttribute('selected', ''); },
  });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.requestSubmit = function () { this.onsubmit?.({ preventDefault() {} }); };
  const calls = [], intervals = [], timeouts = new Map(); let now = Date.now(), nextTimeout = 0;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path.startsWith('/api/trading-overview')) return overview;
    const result = respond?.(path, body);
    if (result !== undefined) return result;
    if (path.startsWith('/api/market/live-trades')) return {trades:[],at:now,refreshMs:1000,source:'Confirmed onchain swaps',note:'No supported swaps yet.'};
    throw Error(`Unexpected request: ${path}`);
  };
  const source = (await readFile(new URL('../public/terminal-ui.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace('export function createTerminalUI', 'function createTerminalUI');
  const names = ['document', 'Event', 'location', 'setInterval', 'setTimeout', 'clearTimeout', 'Date', 'createWorkspaceShell', 'createToolLayout', 'renderIfChanged', 'openPositionCount', ...Object.keys(dexView), ...Object.keys(holderView), ...Object.keys(liveView)];
  const values = [document, window.Event, { search: '' }, (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, (fn, ms) => { timeouts.set(++nextTimeout, { fn, ms }); return nextTimeout; }, id => timeouts.delete(id), Clock, () => ({ update() {} }), () => {}, renderIfChanged, openPositionCount, ...Object.values(dexView), ...Object.values(holderView), ...Object.values(liveView)];
  const createTerminalUI = new Function(...names, source + '\nreturn createTerminalUI;')(...values);
  const ui = createTerminalUI({ chain, session: { accounts: true, authenticated: true }, api });
  await flush();
  const get = id => document.getElementById(id);
  return {
    document, window, get, calls, ui,
    async search(address) { get('token-contract').value = address; await get('token-search').onsubmit({ preventDefault() {} }); await flush(); },
    async tab(name) { document.querySelector(`[data-market-tab="${name}"]`).onclick(); await flush(); },
    async tick(ms) { now += ms; for (const timer of intervals.filter(timer => timer.ms <= ms)) await timer.fn(); await flush(); },
  };
}

test('Dexscreener URLs are constructed from validated chain and pool identifiers only', () => {
  const { dexScreenerUrl } = dexView;
  const solana = new URL(dexScreenerUrl('solana', POOL, { embed: true, interval: '5m', trades: true }));
  assert.equal(solana.origin, 'https://dexscreener.com');
  assert.equal(solana.pathname, `/solana/${POOL}`);
  assert.equal(solana.searchParams.get('embed'), '1');
  assert.equal(solana.searchParams.get('trades'), '1');
  const robinhood = new URL(dexScreenerUrl('robinhood', RH_POOL));
  assert.equal(robinhood.origin, 'https://dexscreener.com');
  assert.equal(robinhood.pathname, `/robinhood/${RH_POOL}`);
  for (const [chain, address] of [
    ['ethereum', RH_POOL], ['solana/../../evil', POOL], ['solana', RH_POOL], ['robinhood', POOL],
    ['solana', 'https://evil.invalid'], ['solana', `${POOL}?redirect=evil`], ['robinhood', `${RH_POOL}/evil`], ['solana', ''],
  ]) assert.equal(dexScreenerUrl(chain, address), null, `${chain}: ${address}`);
});

test('quote-side metrics never display the base token market cap or FDV as the searched token value', () => {
  const normal = dexView.marketMetricRows(pool());
  assert(normal.find(row => /market cap/i.test(row.label)).value.includes('400'));
  const quote = dexView.marketMetricRows(pool({ isBase: false, priceUsd: null }));
  for (const label of [/token price/i, /market cap/i, /fdv/i]) assert.equal(quote.find(row => label.test(row.label)).value, '—');
  const malformed = dexView.marketMetricRows(pool({ priceUsd: NaN, volume24h: Infinity, liquidityUsd: undefined }));
  assert(malformed.every(row => !/NaN|Infinity|undefined/.test(row.value)));
  assert(dexView.marketChangeRows(pool({ isBase: false })).every(row => row.value === '—'));
  const changes = dexView.marketChangeRows(pool());
  assert.equal(changes.find(row => row.label === '5m').tone, 'positive');
  assert.equal(changes.find(row => row.label === '1h').tone, 'negative');
});

test('loading a market selects the manual ticket and embeds only Dexscreener with explicit isolation', async () => {
  const t = await terminal({ respond: path => path.startsWith('/api/market/pools') ? snapshot(SOL, [pool()]) : undefined });
  await t.search(SOL);
  assert.equal(t.get('manual-mint').value, SOL);
  const frame = t.get('token-chart').querySelector('iframe');
  assert(frame);
  assert.equal(new URL(frame.getAttribute('src')).origin, 'https://dexscreener.com');
  assert.equal(new URL(frame.getAttribute('src')).pathname, `/solana/${POOL}`);
  assert(frame.getAttribute('sandbox'));
  assert(!frame.getAttribute('sandbox').includes('allow-top-navigation'));
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(new URL(t.get('token-source').href).origin, 'https://dexscreener.com');
  assert(!t.document.body.textContent.includes('attacker.invalid'));
  await t.tab('trades');
  assert.equal(new URL(t.get('token-chart').querySelector('iframe').getAttribute('src')).searchParams.get('trades'), '0');
  assert.equal(t.get('token-chart').querySelector('iframe'), frame, 'the custom swaps tab preserves the chart');
  t.get('chart-interval').value = '5m'; t.get('chart-interval').onchange();
  assert.equal(new URL(t.get('token-chart').querySelector('iframe').getAttribute('src')).searchParams.get('interval'), '5');
  await t.tab('orders');
  assert.equal(new URL(t.get('token-chart').querySelector('iframe').getAttribute('src')).searchParams.get('trades'), '0');
  assert(!t.calls.some(call => /\/api\/market\/(candles|trades)\?/.test(call.path)));
});

test('refreshing market stats preserves the live iframe and switching pools uses the chosen pair', async () => {
  let response = snapshot(SOL, [pool(), pool({ address: USDC, dex: 'meteora' })]);
  const t = await terminal({ respond: path => path.startsWith('/api/market/pools') ? response : undefined });
  await t.search(SOL);
  const first = t.get('token-chart').querySelector('iframe'), firstSrc = first.getAttribute('src');
  response = snapshot(SOL, [pool({ priceUsd: 234 }), pool({ address: USDC, dex: 'meteora' })]);
  await t.tick(60000);
  assert.equal(t.get('token-chart').querySelector('iframe'), first);
  assert.equal(first.getAttribute('src'), firstSrc);
  assert.match(t.get('market-metrics').textContent, /234/);
  t.get('token-pool').value = '1'; t.get('token-pool').onchange(); await flush();
  const next = t.get('token-chart').querySelector('iframe');
  assert.equal(new URL(next.getAttribute('src')).pathname, `/solana/${USDC}`);
  assert.equal(t.get('token-chart').querySelectorAll('iframe').length, 1);
  response = snapshot(SOL, [pool()]);
  await t.tick(60000);
  assert.equal(t.get('token-chart').querySelector('iframe'), null);
  assert.equal(t.get('token-source').hidden, true);
});

test('a wrong-chain or failed new search immediately clears the old chart and trade ticket', async () => {
  let failure = false;
  const t = await terminal({ respond: path => {
    if (path.startsWith('/api/market/pools')) { if (failure) throw Error('Provider unavailable'); return snapshot(SOL, [pool()]); }
  } });
  await t.search(SOL);
  const count = t.calls.length;
  await t.search(RH_TOKEN);
  assert.equal(t.get('manual-mint').value, '');
  assert.equal(t.get('token-chart').querySelector('iframe'), null);
  assert.equal(t.get('token-source').hidden, true);
  assert.equal(t.calls.length, count);
  assert.equal(t.get('market-switch-chain').getAttribute('href'), `/robinhood?token=${RH_TOKEN}`);
  await t.search(SOL);
  failure = true;
  await t.search(USDC);
  assert.equal(t.get('manual-mint').value, '');
  assert.equal(t.get('token-chart').querySelector('iframe'), null);
  assert.match(t.get('token-feedback').textContent, /Provider unavailable/);
});

test('quote-token searches identify the chart base token and Robinhood retains its own chain route', async () => {
  const quotePool = pool({ token: USDC, symbol: 'USDC', isBase: false, priceUsd: null });
  const solana = await terminal({ respond: path => path.startsWith('/api/market/pools') ? snapshot(USDC, [quotePool]) : undefined });
  await solana.search(USDC);
  assert.equal(solana.get('manual-mint').value, USDC);
  assert.match(solana.get('chart-context').textContent, /SOL/);
  assert.match(solana.get('chart-context').textContent, /quote/i);
  const rhPool = pool({ address: RH_POOL, token: RH_TOKEN, symbol: 'TEST', base: { address: RH_TOKEN, symbol: 'TEST' }, quote: { address: `0x${'c'.repeat(40)}`, symbol: 'USDG' }, pair: 'TEST / USDG' });
  const robinhood = await terminal({ chain: 'robinhood', respond: path => path.startsWith('/api/market/pools') ? { ...snapshot(RH_TOKEN, [rhPool]), chain: 'robinhood' } : undefined });
  await robinhood.search(RH_TOKEN);
  assert.equal(robinhood.get('rh-manual-token').value, RH_TOKEN);
  assert.equal(new URL(robinhood.get('token-chart').querySelector('iframe').getAttribute('src')).pathname, `/robinhood/${RH_POOL}`);
  assert(robinhood.calls.some(call => call.path.includes('pools?chain=robinhood')));
});

test('delayed holder results cannot replace account orders or another token holder view', async () => {
  const stale = deferred(); let holderCalls = 0;
  const overview = { at: Date.now(), sessions: [{ kind: 'copy', state: 'running', positions: [], pending: [], events: [
    { at: 1, token: SOL, level: 'submitted', signature: '3'.repeat(88), wallet: SOL, operation: 'approval' },
    { at: 2, token: SOL, level: 'confirmed', signature: '3'.repeat(88), wallet: SOL, operation: 'approval' },
    { at: 3, token: USDC, level: 'confirmed', signature: '4'.repeat(88), wallet: USDC, side: 'sell' },
  ] }] };
  const t = await terminal({ overview, respond: path => {
    const address = new URL(path, 'https://app.invalid').searchParams.get('address');
    if (path.startsWith('/api/market/pools')) return snapshot(address, [pool({ token: address, symbol: address === SOL ? 'SOL' : 'USDC' })]);
    if (path.startsWith('/api/market/holders')) {
      holderCalls++;
      if (holderCalls === 1) return stale.promise;
      return { at: Date.now(), rows: [{ address: USDC, amount: '77', tokenAccount: POOL }], source: 'Your Solana RPC', note: 'Largest accounts.' };
    }
  } });
  await t.search(SOL);
  const orders = t.get('market-detail-body');
  assert.equal(orders.querySelectorAll('tbody tr').length, 1);
  assert.match(orders.textContent, /Approval/);
  assert.match(orders.textContent, /confirmed/);
  await t.tab('holders');
  await t.tab('orders');
  assert.match(orders.textContent, /Approval/);
  stale.resolve({ at: Date.now(), rows: [{ address: SOL, amount: '987654321', tokenAccount: POOL }], source: 'Your Solana RPC', note: 'Old holder response.' });
  await flush(); await flush();
  assert.match(orders.textContent, /Approval/);
  assert(!orders.textContent.includes('987654321'));
  await t.search(USDC); await t.tab('holders');
  assert.match(orders.textContent, /77/);
  assert(!orders.textContent.includes('987654321'));
  assert(!t.calls.some(call => /\/api\/market\/(candles|trades)\?/.test(call.path)));
});

test('a pending holder response is discarded when a new token is selected', async () => {
  const old = deferred();
  const t = await terminal({ respond: path => {
    const address = new URL(path, 'https://app.invalid').searchParams.get('address');
    if (path.startsWith('/api/market/pools')) return snapshot(address, [pool({ token: address })]);
    if (path.startsWith('/api/market/holders')) return address === SOL ? old.promise : {
      at: Date.now(), rows: [{ address: USDC, amount: '222', tokenAccount: POOL }], source: 'Your Solana RPC', note: 'New token holders.',
    };
  } });
  await t.search(SOL); await t.tab('holders'); await t.search(USDC);
  old.resolve({ at: Date.now(), rows: [{ address: SOL, amount: '111', tokenAccount: POOL }], source: 'Your Solana RPC', note: 'Old token holders.' });
  await flush(); await flush();
  assert.equal(t.get('market-detail-body').querySelector('.holder-remaining').title, '222 SOL');
  assert.equal(t.get('manual-mint').value, USDC);
});

test('snapshot refresh sends the selected pool so a lower-ranked pool can remain selected', async () => {
  let response = snapshot(SOL, [pool(), pool({ address: USDC, dex: 'meteora' })]);
  const t = await terminal({ respond: path => path.startsWith('/api/market/pools') ? response : undefined });
  await t.search(SOL);
  assert.equal(new URL(t.calls.find(call => call.path.startsWith('/api/market/pools')).path, 'https://app.invalid').searchParams.has('pair'), false);
  t.get('token-pool').value = '1'; t.get('token-pool').onchange();
  const frame = t.get('token-chart').querySelector('iframe');
  response = snapshot(SOL, [pool({ address: USDC, dex: 'meteora', priceUsd: 321 })]);
  await t.tick(60000);
  const refreshed = new URL(t.calls.filter(call => call.path.startsWith('/api/market/pools')).at(-1).path, 'https://app.invalid');
  assert.equal(refreshed.searchParams.get('pair'), USDC);
  assert.equal(refreshed.searchParams.get('address'), SOL);
  assert.equal(t.get('token-chart').querySelector('iframe'), frame);
  assert.match(t.get('market-metrics').textContent, /321/);
});

test('manual stats refresh works with automatic refresh disabled and retains the chart and cooldown', async () => {
  const pending = deferred(); let requests = 0;
  const t = await terminal({ respond: path => {
    if (!path.startsWith('/api/market/pools')) return;
    requests++;
    if (requests === 1) return { ...snapshot(SOL, [pool()]), refreshMs: 0 };
    if (requests === 2) return pending.promise;
    return { ...snapshot(SOL, [pool({ priceUsd: 456 })]), refreshMs: 0, stale: true, retryAt: Date.now() + 300000 };
  } });
  const button = t.get('market-stats-refresh');
  assert.equal(button.hidden, true);
  await t.search(SOL);
  assert.equal(button.hidden, false);
  const frame = t.get('token-chart').querySelector('iframe');
  await t.tick(60000);
  assert.equal(requests, 1);
  const refresh = button.onclick();
  assert.equal(button.disabled, true);
  assert.equal(requests, 2);
  pending.resolve({ ...snapshot(SOL, [pool({ priceUsd: 456 })]), refreshMs: 0 });
  await refresh;
  assert.equal(button.disabled, false);
  assert.equal(t.get('token-chart').querySelector('iframe'), frame);
  assert.match(t.get('market-metrics').textContent, /456/);
  assert.match(t.get('token-feedback').textContent, /snapshot checked/);
  const url = new URL(t.calls.filter(call => call.path.startsWith('/api/market/pools')).at(-1).path, 'https://app.invalid');
  assert.deepEqual([...url.searchParams.keys()], ['chain', 'address', 'pair']);
  await button.onclick();
  assert.equal(requests, 3);
  await button.onclick();
  assert.equal(requests, 3, 'manual refresh must respect provider cooldown');
  assert.equal(t.get('token-chart').querySelector('iframe'), frame);
});

test('holders show supply share, marked balances and on-demand quote-denominated entry and exit without inventing P&L', async () => {
  let historyCalls=0;
  const t=await terminal({respond:path=>{
    if(path.startsWith('/api/market/pools'))return snapshot(SOL,[pool()]);
    if(path.startsWith('/api/market/holder-history')){historyCalls++;return {available:true,source:'Helius',at:Date.now(),coverage:{complete:false,note:'Recent 100 transactions; not lifetime totals.'},bought:{tokens:1000,usd:null,count:2},sold:{tokens:250,usd:null,count:1},quotes:[{symbol:'USDC',mint:USDC,bought:100,sold:50,averageEntry:.1,averageExit:.2}],pnl:null};}
    if(path.startsWith('/api/market/holders'))return {at:Date.now(),source:'Your Solana RPC',note:'Listed accounts only.',historyAvailable:true,historyNote:'Load a wallet to inspect recent decoded swaps.',supply:'1000000',listedSupplyPercent:7.5,rows:[{address:USDC,amount:'75000',supplyPercent:7.5,balanceCoverage:'listed-accounts'}]};
  }});
  await t.search(SOL);await t.tab('holders');
  const body=t.get('market-detail-body');
  assert.equal(historyCalls,0,'opening holders must not fetch every wallet history');
  assert.match(body.querySelector('.holders-summary').textContent,/7.5%/);
  assert.match(body.querySelector('.holder-balance').textContent,/75KSOL/);
  assert.match(body.querySelector('.holder-remaining').textContent,/\$9.23M/);
  assert.equal(body.querySelector('.holder-share-meter span').style.width,'7.5%');
  const address=body.querySelector('.holder-address');assert.equal(address.href,`https://solscan.io/account/${USDC}`);assert.match(address.rel,/noopener/);
  const scroll=body.querySelector('.holders-scroll');scroll.scrollLeft=120;scroll.scrollTop=15;
  await body.querySelector('.holder-history-button').onclick();
  assert.equal(historyCalls,1);assert.equal(body.querySelector('.holders-scroll').scrollLeft,120);
  assert.match(body.textContent,/100 USDC/);assert.match(body.textContent,/50 USDC/);
  assert.match(body.textContent,/0.1 USDC/);assert.match(body.textContent,/0.2 USDC/);
  assert.match(body.textContent,/2 swaps/);assert(!body.textContent.includes('Cost basis unavailable'));assert(!body.querySelector('.holder-activity-metrics').textContent.includes('P&L'));
  assert.match(body.querySelector('.holder-coverage-row').textContent,/not lifetime totals/);
  assert(!body.textContent.includes('$100'),'quote not converted to a fabricated USD cost basis');
  const request=new URL(t.calls.find(call=>call.path.startsWith('/api/market/holder-history')).path,'https://app.invalid');
  assert.equal(request.searchParams.get('wallet'),USDC);assert.equal(request.searchParams.get('address'),SOL);
});

test('holder history arriving after a token switch cannot replace the new view and unknown price is never zero dollars', async () => {
  const pending=deferred();
  const t=await terminal({respond:path=>{
    const url=new URL(path,'https://app.invalid'),address=url.searchParams.get('address');
    if(path.startsWith('/api/market/pools'))return snapshot(address,[pool({token:address,priceUsd:null})]);
    if(path.startsWith('/api/market/holder-history'))return pending.promise;
    if(path.startsWith('/api/market/holders'))return {at:Date.now(),source:'RPC',note:'Listed holders.',supply:'1000000',listedSupplyPercent:1,rows:[{address:address===SOL?USDC:POOL,amount:'10000',supplyPercent:1}]};
  }});
  await t.search(SOL);await t.tab('holders');
  const request=t.get('market-detail-body').querySelector('.holder-history-button').onclick();
  await t.search(USDC);
  pending.resolve({available:true,source:'Stale history',coverage:{note:'Old token history'},bought:{tokens:777,usd:99,count:1},sold:{tokens:0,usd:0,count:0},quotes:[]});await request;
  const body=t.get('market-detail-body');
  assert.equal(body.querySelector('[data-holder]').dataset.holder,POOL);
  assert(!body.textContent.includes('Old token history'));assert(!body.textContent.includes('$0'));
  assert.equal(body.querySelector('.holder-remaining strong').firstChild.textContent,'—');
});

test('Robinhood transfer-only holder history stays separate from buys, sells and P&L', async () => {
  const {document}=parseHTML('<html></html>'),wallet=`0x${'c'.repeat(40)}`;
  const view=holderView.createHoldersView({document,chain:'robinhood',symbol:'TEST',priceUsd:2,data:{supply:'1000',listedSupplyPercent:10,rows:[{address:wallet,amount:'100',supplyPercent:10,contract:true}]},histories:new Map([[wallet,{data:{available:false,source:'Blockscout',coverage:{note:'Transfers only.'},bought:{tokens:null,usd:null,count:null},sold:{tokens:null,usd:null,count:null},transferred:{in:200,out:100,count:3},pnl:null}}]])});
  assert.equal(view.querySelector('.holder-address').href,`https://robinhoodchain.blockscout.com/address/${wallet}`);
  assert.match(view.textContent,/Transfers in: 200 TEST; out: 100 TEST/);
  assert.match(view.textContent,/Transfers are not classified as trades/);
  assert.equal(view.querySelector('.holder-activity-metrics'),null);assert(!view.textContent.includes('P&L'));assert(!view.textContent.includes('History unavailable'));
  assert.equal(holderView.holderExplorerUrl('robinhood','javascript:alert(1)'),null);
  assert.equal(holderView.holderCurrentValue('100',null),null);assert.equal(holderView.holderCurrentValue('0',2),0);
});

function liveTrade(overrides={}) {return {id:'swap-1',signature:'3'.repeat(88),at:Date.now()-2000,side:'buy',wallet:USDC,walletRole:'transaction payer',tokenAmount:'1000',quoteAmount:'2',quoteSymbol:'USDC',amountUsd:2,fdvUsd:2000,usdEstimate:true,gasNative:'0.000005',gasSymbol:'SOL',amountKind:'Pool vault changes',...overrides};}

test('market swaps update ages each second and retain existing rows and the chart while new confirmed trades arrive', async () => {
  const first=liveTrade(),second=liveTrade({id:'swap-2',signature:'4'.repeat(88),side:'sell'});let trades=[first],requests=0;
  const t=await terminal({respond:path=>{
    if(path.startsWith('/api/market/pools'))return snapshot(SOL,[pool()]);
    if(path.startsWith('/api/market/live-trades')){requests++;return {at:Date.now(),source:'Confirmed onchain swaps',trades,refreshMs:1000,partial:true,note:'A bounded confirmed window.'};}
  }});
  await t.search(SOL);const frame=t.get('token-chart').querySelector('iframe');await t.tab('trades');
  assert.equal(requests,1);
  const body=t.get('market-detail-body'),row=body.querySelector('[data-trade="swap-1"]'),age=row.querySelector('[data-trade-at]').textContent;
  assert.match(body.textContent,/FDV \(est\.\)/);assert.match(body.textContent,/Total USD \(est\.\)/);assert.match(body.textContent,/Partial history/);
  trades=[second,first];await t.tick(1000);
  assert.equal(requests,2);assert.equal(body.querySelector('[data-trade="swap-1"]'),row,'existing row nodes remain mounted across arrivals');
  assert.notEqual(row.querySelector('[data-trade-at]').textContent,age);assert.equal(body.querySelectorAll('[data-trade]').length,2);
  assert.equal(t.get('token-chart').querySelector('iframe'),frame);
  assert.equal(body.querySelector('.live-trade-wallet').href,`https://solscan.io/account/${USDC}`);
  assert.match(body.querySelector('.live-trade-wallet').title,/transaction payer/);
  assert.equal(body.querySelector('.live-trade-age').href,`https://solscan.io/tx/${second.signature}`);
  Object.defineProperty(t.document,'hidden',{value:true,writable:true});await t.tick(1000);assert.equal(requests,2);
  t.document.hidden=false;await t.tab('orders');await t.tick(1000);assert.equal(requests,2,'leaving swaps suspends market activity polling');
});

test('swap feed honors provider cooldown, preserves last rows, and discards delayed results for a previous token', async () => {
  const pending=deferred();let requests=0,mode='normal';
  const t=await terminal({respond:path=>{
    const address=new URL(path,'https://app.invalid').searchParams.get('address');
    if(path.startsWith('/api/market/pools'))return snapshot(address,[pool({token:address})]);
    if(path.startsWith('/api/market/live-trades')){requests++;if(mode==='error')throw Object.assign(Error('Provider cooling down'),{retryAfterMs:10000});if(mode==='pending')return pending.promise;return {at:Date.now(),trades:[liveTrade()],refreshMs:1000};}
  }});
  await t.search(SOL);await t.tab('trades');mode='error';await t.tick(1000);
  assert.equal(requests,2);assert.match(t.get('market-detail-body').textContent,/Feed delayed/);
  assert.equal(t.get('market-detail-body').querySelectorAll('[data-trade]').length,1);
  await t.get('market-refresh').onclick();await t.tick(1000);assert.equal(requests,2,'manual and automatic refresh respect the same cooldown');
  mode='pending';const tick=t.tick(10000);await flush();await t.search(USDC);
  pending.resolve({at:Date.now(),trades:[liveTrade({id:'old-token-swap',tokenAmount:'999999'})],refreshMs:1000});await tick;
  assert(!t.get('market-detail-body').querySelector('[data-trade="old-token-swap"]'));
});

test('live row rendering rejects unsafe transaction links and marks unavailable valuation without fake zeros', () => {
  const {document}=parseHTML('<html></html>');
  const view=liveView.createLiveTradesView({document,chain:'robinhood',symbol:'TEST',data:{trades:[liveTrade({id:'rh',signature:`0x${'a'.repeat(64)}`,wallet:RH_TOKEN,amountUsd:null,fdvUsd:null,gasNative:null}),liveTrade({id:'bad',signature:'javascript:alert(1)'})]}});
  assert.equal(view.querySelectorAll('[data-trade]').length,1);
  assert.equal(view.querySelector('.live-trade-wallet').href,`https://robinhoodchain.blockscout.com/address/${RH_TOKEN}`);
  assert.equal(view.querySelector('tbody tr').children[2].textContent,'—');assert.equal(view.querySelector('tbody tr').children[4].textContent,'—');
  assert(!view.textContent.includes('$0'));assert(!view.querySelector('[href^="javascript:"]'));
  assert.equal(liveView.tradeAge(NaN), '—');assert.equal(liveView.tradeAge(1000,62000),'1m 1s');
});

test('holders keep wallet, supply share, balance and value in the four primary cells with activity collapsed', async () => {
  const {document}=parseHTML('<html></html>');let calls=0;const address=USDC;
  const view=holderView.createHoldersView({document,chain:'solana',symbol:'COIN',priceUsd:2,data:{supply:'1000000',listedSupplyPercent:7.5,historyAvailable:true,rows:[{address,amount:'75000',supplyPercent:7.5}]},onHistory:()=>{calls++;}});
  assert.deepEqual([...view.querySelectorAll('thead th')].map(x=>x.textContent),['Wallet','% of supply','Balance','Value']);
  const cells=view.querySelector('[data-holder]').children;assert.equal(cells.length,4);assert.match(cells[1].textContent,/7.5%/);assert.match(cells[2].textContent,/75KCOIN/);assert.match(cells[3].textContent,/\$150K/);assert.deepEqual([...cells].map(x=>x.dataset.label),['Wallet','% of supply','Balance','Value']);assert.equal(calls,0);assert.equal(view.querySelector('.holder-activity-row').hidden,true);assert(!view.textContent.includes('Avg. entry'));assert(!view.textContent.includes('P&L'));
  await view.querySelector('.holder-history-button').onclick();assert.equal(calls,1);assert.equal(view.querySelector('.holder-history-button').getAttribute('aria-expanded'),'true');
  const css=await readFile(new URL('../public/terminal.css',import.meta.url),'utf8');assert.match(css,/\.holders-table\{width:100%;min-width:0;/);assert.match(css,/@media\(max-width:650px\).*\.holders-table \.holder-row\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);assert(!css.includes('.holders-table{min-width:1100px'));
});
test('loaded activity can be collapsed and unavailable holder history adds no blank columns or disabled controls',()=>{
  const {document}=parseHTML('<html></html>'),history={available:true,bought:{tokens:10,count:1,usd:20},sold:{tokens:0,count:0,usd:0},quotes:[],pnl:null,coverage:{note:'Recent window'}};const state={data:history};
  const args={document,chain:'solana',symbol:'COIN',priceUsd:null,data:{rows:[{address:USDC,amount:'10',supplyPercent:null}],historyAvailable:true},histories:new Map([[USDC,state]]),onHistory(){}};
  let view=holderView.createHoldersView(args);assert.equal(view.querySelector('.holder-activity-row').hidden,false);view.querySelector('.holder-history-button').onclick();assert.equal(state.expanded,false);view=holderView.createHoldersView(args);assert.equal(view.querySelector('.holder-activity-row').hidden,true);assert.equal(view.querySelector('.holder-share').textContent,'—');assert.equal(view.querySelector('.holder-value strong').textContent,'—');
  const unavailable=holderView.createHoldersView({...args,data:{...args.data,historyAvailable:false},histories:new Map()});assert.equal(unavailable.querySelector('.holder-history-button'),null);assert.equal(unavailable.querySelectorAll('thead th').length,4);
});
test('live feed distinguishes RPC failure, missing connection, unsupported pool, pending details and healthy no activity',()=>{
  const {document}=parseHTML('<html></html>');const render=data=>liveView.createLiveTradesView({document,chain:'solana',data});
  const failed=render({trades:[],warning:'Live swaps are temporarily unavailable from your RPC.',retryAt:Date.now()+15000});assert.equal(failed.querySelector('.live-trades-state').textContent,'RPC unavailable');assert.match(failed.querySelector('.terminal-empty').textContent,/does not mean there are no trades/);assert(!failed.textContent.includes('No confirmed swap rows'));
  assert.equal(render({trades:[],connectionRequired:true,warning:'Save your RPC.'}).querySelector('.live-trades-state').textContent,'Connection needed');
  assert.equal(render({trades:[],unsupported:true}).querySelector('.live-trades-state').textContent,'Pool not supported');
  assert.equal(render({trades:[],backlog:2}).querySelector('.live-trades-state').textContent,'Loading transactions');
  const empty=render({trades:[],at:Date.now()});assert.equal(empty.querySelector('.live-trades-state').textContent,'No recent swaps');assert.match(empty.textContent,/connected and checking/);
});
test('indexed live swaps show their source and keep detailed coverage notes collapsed below actual rows',()=>{
  const {document}=parseHTML('<html></html>');const view=liveView.createLiveTradesView({document,chain:'robinhood',data:{source:'Blockscout indexed swaps',partial:true,trades:[liveTrade({signature:'0x'+'a'.repeat(64),wallet:RH_TOKEN})]}});
  assert.equal(view.querySelector('.live-trades-state').textContent,'Indexed swaps');assert.match(view.querySelector('.live-trades-message').textContent,/lag chain confirmation/);assert.equal(view.querySelectorAll('[data-trade]').length,1);assert.equal(view.querySelector('.live-trades-gap'),null);assert.equal(view.querySelector('.live-trades-info').hasAttribute('open'),false);assert.match(view.querySelector('.live-trades-info').textContent,/Partial history/);
});

test('fresh indexed fallback stays available when the primary RPC is unavailable',()=>{
  const {document}=parseHTML('<html></html>'),data={indexed:true,rpcUnavailable:true,source:'Blockscout',refreshMs:5000,trades:[liveTrade({signature:'0x'+'a'.repeat(64),wallet:RH_TOKEN})]};
  const current=liveView.createLiveTradesView({document,chain:'robinhood',data});assert.equal(current.querySelector('.live-trades-state').textContent,'Indexed swaps');assert.equal(current.querySelector('.live-trades-state').classList.contains('delayed'),false);
  const delayed=liveView.createLiveTradesView({document,chain:'robinhood',data:{...data,stale:true}});assert.equal(delayed.querySelector('.live-trades-state').textContent,'Feed delayed');assert.equal(delayed.querySelectorAll('[data-trade]').length,1);
});
test('status-only fallback transitions rerender labels while keeping trade nodes and the chart mounted',async()=>{
  let indexed=false;const trades=[liveTrade()];
  const t=await terminal({respond:path=>path.startsWith('/api/market/pools')?snapshot(SOL,[pool()]):path.startsWith('/api/market/live-trades')?{trades,at:Date.now(),refreshMs:1000,...(indexed?{indexed:true,rpcUnavailable:true,source:'Blockscout'}:{source:'RPC'})}:undefined});
  await t.search(SOL);await t.tab('trades');const frame=t.get('token-chart').querySelector('iframe'),row=t.get('market-detail-body').querySelector('[data-trade]');assert.equal(t.get('market-detail-body').querySelector('.live-trades-state').textContent,'Confirmed swaps');indexed=true;await t.tick(1000);assert.equal(t.get('market-detail-body').querySelector('.live-trades-state').textContent,'Indexed swaps');assert.equal(t.get('market-detail-body').querySelector('[data-trade]'),row);assert.equal(t.get('token-chart').querySelector('iframe'),frame);
});
test('active holder balances refresh every 15 seconds, respecting hidden pages, inactive tabs and manual refresh mode',async()=>{
  let count=0,manual=false;const t=await terminal({respond:path=>{
    if(path.startsWith('/api/market/pools'))return {...snapshot(SOL,[pool()]),refreshMs:manual?0:60000};
    if(path.startsWith('/api/market/holders')){count++;return{at:Date.now()+1000,source:'RPC',rows:[{address:USDC,amount:String(count),supplyPercent:count}],supply:'100',listedSupplyPercent:count};}
  }});
  await t.search(SOL);await t.tab('holders');const frame=t.get('token-chart').querySelector('iframe');assert.equal(count,1);await t.tick(15000);assert.equal(count,2);assert.equal(t.get('token-chart').querySelector('iframe'),frame);assert.equal(t.get('market-detail-body').querySelector('.holder-share').textContent,'2%');
  Object.defineProperty(t.document,'hidden',{value:true,writable:true});await t.tick(15000);assert.equal(count,2);t.document.hidden=false;await t.tab('orders');await t.tick(15000);assert.equal(count,2);
  manual=true;await t.search(SOL);await t.tab('holders');const stopped=count;await t.tick(15000);assert.equal(count,stopped);await t.get('market-refresh').onclick();assert.equal(count,stopped+1);
  assert.equal(t.calls.filter(call=>call.path.startsWith('/api/market/holder-history')).length,0,'holder polling must never fan out wallet-history requests');
});

test('live trade USD totals show whole cents rather than five significant digits', () => {
  const {document}=parseHTML('<html></html>');
  const view=liveView.createLiveTradesView({document,chain:'solana',symbol:'TEST',data:{trades:[liveTrade({amountUsd:43.365}),liveTrade({id:'swap-2',signature:'4'.repeat(88),amountUsd:0.004}),liveTrade({id:'swap-3',signature:'6'.repeat(88),amountUsd:2})]}});
  assert.deepEqual([...view.querySelectorAll('tbody tr')].map(row=>row.children[4].textContent),['$43.37','<$0.01','$2.00']);
});
