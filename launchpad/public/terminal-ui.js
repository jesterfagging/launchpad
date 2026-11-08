import { createWorkspaceShell } from './workspace-shell.js';
import { renderIfChanged, openPositionCount } from './ui-performance.mjs';
import { dexScreenerUrl, marketMetricRows, marketChangeRows, marketSwapRows } from './dexscreener-view.mjs';
import { createHoldersView } from './holders-view.mjs';
import { createLiveTradesView, updateTradeAges } from './live-trades-view.mjs';
import { createToolLayout } from './tool-layout-ui.js';
const titles = { copy: 'Copy trading', sniper: 'Launch sniper', liquidity: 'Liquidity', market: 'Market making' };
const node = (tag, value, cls) => { const el = document.createElement(tag); if (value != null) el.textContent = value; if (cls) el.className = cls; return el; };
const short = value => value ? `${value.slice(0,6)}…${value.slice(-5)}` : '—';
const compact = value => value == null ? '—' : new Intl.NumberFormat(undefined, { notation:'compact', maximumFractionDigits:2 }).format(value);
function txLink(chain, signature) {
  const valid = chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature || '') : /^0x[0-9a-f]{64}$/i.test(signature || '');
  if (!valid) return node('span', '—');
  const a = node('a', short(signature)); a.href = chain === 'solana' ? `https://solscan.io/tx/${signature}` : `https://robinhoodchain.blockscout.com/tx/${signature}`; a.target='_blank'; a.rel='noopener noreferrer'; return a;
}
function table(headers, rows) {
  const wrap = node('div', null, 'table-scroll'), t = node('table',null,'terminal-table'), head = node('thead'), tr = node('tr');
  for (const title of headers) tr.append(node('th', title)); head.append(tr); t.append(head);
  const body = node('tbody'); for (const values of rows) { const row = node('tr'); for (const value of values) { const td=node('td'); typeof value === 'object' && value ? td.append(value) : td.textContent = value ?? '—'; row.append(td); } body.append(row); }
  t.append(body); wrap.append(t); return wrap;
}
export function createTerminalUI({ chain, session, api, openConnections = () => {} }) {
  if (!session?.accounts || !session.authenticated) return;
  const $ = id => document.getElementById(id), owner = !!session.monitorAllowed;
  document.body.dataset.monitor = owner ? 'owner' : 'user';
  $('owner-sessions').hidden = !owner;
  for (const card of document.querySelectorAll('[data-owner-monitor]')) card.hidden = !owner;
  const main = document.querySelector('main'), workspace = main.querySelector('.workspace'), nav = document.querySelector(chain === 'solana' ? '.strategy-tabs' : '#rh-tools');
  const terminal = node('section', null, 'terminal'); terminal.id = 'trade-terminal';
  terminal.innerHTML = `<div class="terminal-heading"><div><p class="eyebrow">MARKETS / ${chain === 'solana' ? 'SOLANA' : 'ROBINHOOD CHAIN'}</p><h1>Your trading desk.</h1><p class="subtitle">Find a token. Watch your trades. Stay in control.</p></div><span class="terminal-live">● Live execution</span></div>
    <form id="token-search" class="token-search"><label for="token-contract">Token contract</label><div><span aria-hidden="true">⌕</span><input id="token-contract" placeholder="Paste a ${chain === 'solana' ? 'Solana mint' : 'Robinhood token contract'} address" spellcheck="false" autocomplete="off" required><button class="primary" type="submit" id="token-load">Load token ↗</button></div></form>
    <p id="token-feedback" class="help" role="status">Search by contract address to open a market.</p>
    <div class="terminal-grid"><div class="terminal-market"><section class="card market-card"><div class="market-heading"><div><p class="eyebrow">SELECTED MARKET</p><h2 id="token-title">No token selected</h2><p id="token-address" class="muted-address"></p></div><a id="token-source" target="_blank" rel="noopener noreferrer" hidden>DEX Screener ↗</a></div>
    <div class="market-metrics" id="market-metrics"></div><div id="market-changes" class="market-changes" hidden></div><div class="chart-toolbar"><label>Pool<select id="token-pool" disabled><option>Choose a token first</option></select></label><label>Interval<select id="chart-interval"><option value="1m">1 minute</option><option value="5m">5 minutes</option><option value="15m">15 minutes</option><option value="1h">1 hour</option></select></label></div><p id="chart-context" class="chart-status help"></p>
    <div id="token-chart" class="token-chart"><div class="chart-empty"><span>↗</span><strong>A clearer view of every trade.</strong><p>Your token chart will appear here.</p></div></div><div class="chart-access" id="chart-access" hidden><p id="chart-access-note">If the panel is blank or blocked by your browser, open it directly on DEX Screener.</p><a id="chart-external" target="_blank" rel="noopener noreferrer">Open chart ↗</a></div><p class="market-credit">Chart and market statistics by DEX Screener. Swap rows show confirmed onchain activity where supported. Indexed data may lag; Launchpad records your execution activity separately.</p></section>
    <section class="card market-detail"><nav class="market-tabs" aria-label="Market details"><button type="button" data-market-tab="orders" aria-pressed="true">Your orders</button><button type="button" data-market-tab="trades" aria-pressed="false">Market swaps</button><button type="button" data-market-tab="holders" aria-pressed="false">Holders</button></nav><div class="detail-heading"><p id="market-detail-note" class="help"></p><button type="button" id="market-refresh" class="text-button">Refresh</button></div><div id="market-detail-body"></div></section></div>
    <aside class="terminal-rail"><section class="card bots-card"><div class="card-heading"><h2>Your bots</h2><span id="terminal-active" class="count">—</span></div><div id="terminal-bots"></div><p id="terminal-sync" class="help">Connecting to your sessions…</p></section><div id="terminal-ticket"></div></aside></div>`;
  workspace.before(terminal);
  const button=node('button','Trade terminal','terminal-tab'); button.type='button'; button.dataset.terminal='true'; nav.prepend(button);
  createToolLayout({ chain, openConnections });
  const hero=node('div',null,'terminal-search-heading'); terminal.prepend(hero);
  hero.append(terminal.querySelector('.terminal-heading'), $('token-search'), $('token-feedback'));
  const chainName = chain === 'solana' ? 'Solana' : 'Robinhood';
  $('token-search').querySelector('label').textContent = `${chainName} token contract`;
  terminal.querySelector('.terminal-live').textContent = chain === 'solana' ? 'Solana mainnet' : 'Robinhood · 4663';
  const manual = document.querySelector(chain === 'solana' ? '.manual-card' : '#rh-manual-card'), home = document.createComment('manual ticket home'); manual.before(home);
  const executionPresets = document.querySelector('.execution-preset-card'), presetsHome = document.createComment('execution presets home'); executionPresets?.before(presetsHome);
  const copyButton = () => nav.querySelector(chain === 'solana' ? '[data-tab="copy"]' : '[data-kind="copy"]');
  let shell;
  let token = '', pools = [], selected = null, tab = 'orders', overview = null, busy = false, requestId=0, detailsId=0, pollBusy=false, overviewError='', chart=null, chartKey='';
  const detailCache = new Map(), detailsRetryAt = new Map(), holderHistoryCache = new Map(); let detailBusy = false, detailsRetryTimer, statsNextAt = 0, statsRetryAt = 0, marketRefreshMs = 60000;
  const liveTradeCache=new Map();let liveTradeBusy=false;
  const retryTime = at => new Date(at).toLocaleTimeString();
  function connectionsLink(parent) { const b = node('button','Open connections','text-button'); b.type = 'button'; b.onclick = () => openConnections(); parent.append(b); }
  document.addEventListener('relay-market-connections-saved', event => { marketRefreshMs = event.detail.refreshMs; detailCache.clear(); detailsRetryAt.clear(); statsNextAt = 0; refreshMarketSnapshot(true); });
  const openTerminal = () => {
    copyButton()?.click(); document.body.dataset.workspace = 'terminal'; terminal.hidden=false; button.setAttribute('aria-pressed','true');
    for (const b of nav.children) if(b!==button){ b.setAttribute('aria-pressed','false'); b.setAttribute('aria-selected','false'); }
    if (executionPresets) $('terminal-ticket').append(executionPresets); $('terminal-ticket').append(manual); manual.hidden=false; poll();
  };
  nav.addEventListener('click', event => { const b=event.target.closest('button'); if(!b || b===button) return; document.body.dataset.workspace='tools'; terminal.hidden=true; button.setAttribute('aria-pressed','false'); home.after(manual); if (executionPresets) presetsHome.after(executionPresets); });
  button.onclick=openTerminal;
  const samePool = (a, b) => chain === 'solana' ? a === b : String(a).toLowerCase() === String(b).toLowerCase();
  function renderMarketStats() {
    if (!selected) return;
    renderIfChanged($('market-metrics'), marketMetricRows(selected), () => {
      $('market-metrics').replaceChildren();
      for (const {label,value} of marketMetricRows(selected)) { const cell=node('div');cell.append(node('span',label),node('strong',value));$('market-metrics').append(cell); }
    });
    $('market-changes').hidden=false;
    renderIfChanged($('market-changes'), [selected.symbol, marketChangeRows(selected)], () => {
      $('market-changes').replaceChildren(node('span',`${selected.symbol || 'Token'} change`,'market-change-label'));
      for (const {label,value,tone} of marketChangeRows(selected)) { const cell=node('div');cell.append(node('span',label),node('strong',value,tone));$('market-changes').append(cell); }
    });
  }
  function clearChart(message) {
    chart?.remove(); chart=null; chartKey='';
    $('token-chart').classList.remove('with-swaps');
    $('token-chart').replaceChildren(node('p',message,'chart-empty'));
    $('chart-access').hidden=true; $('chart-external').removeAttribute('href');
    refreshChart.hidden=true; refreshStats.hidden=true;
  }
  function poolOptions(address = '', placeholder = '') {
    $('token-pool').replaceChildren();
    if (placeholder) { const option=node('option',placeholder);option.value='';option.disabled=true;option.selected=true;$('token-pool').append(option); }
    pools.forEach((p,i)=>{const option=node('option',`${p.pair} · ${p.dex} · ${compact(p.liquidityUsd)} USD liquidity`);option.value=String(i);option.selected=!!address&&samePool(p.address,address);$('token-pool').append(option);});
    $('token-pool').disabled=!pools.length;
    if (!placeholder && !address && pools.length) $('token-pool').value='0';
  }
  function selectPool() {
    ++detailsId;
    selected = $('token-pool').value === '' ? null : pools[Number($('token-pool').value)] || null;
    if (!selected) return;
    $('token-title').textContent = `${selected.symbol || short(token)} · ${selected.pair}`; $('token-address').textContent=token;
    const source=dexScreenerUrl(chain,selected.address);
    $('token-source').hidden=!source;
    if(source)$('token-source').href=source;else $('token-source').removeAttribute('href');
    renderMarketStats(); loadChart();
    const input=$(chain==='solana'?'manual-mint':'rh-manual-token'); input.value=token; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true}));
    renderDetails();
  }
  function loadChart(force=false) {
    if(!selected)return;
    const url=dexScreenerUrl(chain,selected.address,{interval:$('chart-interval').value,trades:false,embed:true});
    const external=dexScreenerUrl(chain,selected.address);
    if(!url||!external){clearChart('This pool does not have a supported DEX Screener chart.');$('chart-context').textContent='Chart unavailable for this pool.';return;}
    $('chart-context').textContent=`DEX Screener chart: ${selected.base.symbol} / ${selected.quote.symbol}${selected.isBase ? '' : ` · You searched for the quote asset, ${selected.symbol}. The chart and buy/sell counts describe ${selected.base.symbol}.`}`;
    $('chart-access').hidden=false; $('chart-external').href=external; refreshChart.hidden=false; refreshStats.hidden=false;
    $('token-chart').classList.remove('with-swaps');
    if(chart && chartKey===url && !force)return;
    // Keep one frame alive through polling; replace only for real viewer changes.
    const frame=node('iframe'); frame.title=`${selected.base.symbol} / ${selected.quote.symbol} chart on DEX Screener`;
    frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.setAttribute('referrerpolicy','no-referrer'); frame.setAttribute('loading','lazy'); frame.src=url;
    frame.onerror=()=>{if(chart===frame)$('chart-access-note').textContent='The DEX Screener panel could not open. Your browser or an extension may be blocking it. Open the chart directly to continue.';};
    // Cross-origin onload cannot prove that a chart rendered, so never report it as verified.
    $('chart-access-note').textContent='If the panel is blank or blocked by your browser, open it directly on DEX Screener.';
    chart=frame;chartKey=url;$('token-chart').replaceChildren(frame);
  }
  $('chart-interval').onchange=()=>loadChart();
  const refreshChart=node('button','Reload chart','text-button');refreshChart.type='button';refreshChart.hidden=true;refreshChart.onclick=()=>loadChart(true);$('chart-context').after(refreshChart);refreshChart.classList.add('chart-refresh');
  const refreshStats=node('button','Refresh stats','text-button chart-refresh');refreshStats.id='market-stats-refresh';refreshStats.type='button';refreshStats.hidden=true;refreshStats.onclick=()=>refreshMarketSnapshot(true);refreshChart.after(refreshStats);
  let statsBusy=false;
  async function refreshMarketSnapshot(force=false) {
    if(statsBusy||!token||(!force&&(!marketRefreshMs||Date.now()<statsNextAt||document.hidden||document.body.dataset.workspace!=='terminal')))return;
    if(Date.now()<statsRetryAt){if(force)$('token-feedback').textContent=`DEX Screener is temporarily unavailable. Try again after ${retryTime(statsRetryAt)}.${selected?' Showing the last available statistics.':''}`;return;}
    statsBusy=true;refreshStats.disabled=true;refreshStats.textContent='Refreshing…';statsNextAt=Date.now()+marketRefreshMs;const id=requestId,pair=selected?.address;
    try {
      const data=await api(`/api/market/pools?chain=${chain}&address=${encodeURIComponent(token)}${pair?`&pair=${encodeURIComponent(pair)}`:''}`);
      if(id!==requestId||selected?.address!==pair)return;
      if(Number.isFinite(data.refreshMs))marketRefreshMs=data.refreshMs;
      statsNextAt=Date.now()+marketRefreshMs;
      const nextPools=Array.isArray(data.pools)?data.pools:[],updated=nextPools.find(p=>samePool(p.address,pair));
      if(data.stale){
        statsRetryAt=data.retryAt||Date.now()+60000;statsNextAt=Math.max(statsNextAt,statsRetryAt);
        $('token-feedback').textContent=`Delayed DEX Screener snapshot from ${retryTime(data.at)}. ${data.warning||'The provider is temporarily unavailable.'}`;
        if(updated){selected=updated;renderMarketStats();if(tab==='trades')renderSwaps();}
        return;
      }
      statsRetryAt=0;
      pools=nextPools;
      if(updated){selected=updated;poolOptions(pair);renderMarketStats();if(tab==='trades')renderSwaps();$('token-feedback').textContent=`DEX Screener snapshot checked ${new Date(data.at).toLocaleTimeString()}. Pool selection changes the viewer; trades use your saved routing.`;}
      else {
        selected=null;poolOptions('',pools.length?'Choose another pool':'No indexed pools');
        $('token-source').hidden=true;$('token-source').removeAttribute('href');$('market-metrics').replaceChildren();$('market-changes').hidden=true;$('chart-context').textContent='';
        $('token-title').textContent=pools.length?'Choose a market':'Not indexed yet';
        clearChart('This pool is no longer in the latest DEX Screener snapshot.');
        $('token-feedback').textContent=pools.length?'The selected pool is no longer in the latest results. Choose another pool to continue watching.':data.note||'No indexed pool is currently available for this token.';
        renderDetails();
      }
    } catch(error){if(id===requestId){statsRetryAt=Date.now()+(Number(error.retryAfterMs)||15000);statsNextAt=Math.max(statsNextAt,statsRetryAt);$('token-feedback').textContent=`DEX Screener snapshot could not refresh: ${error.message}${selected?' Showing the last available statistics.':''}`;}}
    finally{statsBusy=false;refreshStats.disabled=false;refreshStats.textContent='Refresh stats';}
  }
  setInterval(()=>refreshMarketSnapshot(),15000);
  $('token-pool').onchange=selectPool;
  $('token-search').onsubmit=async event=>{
    event.preventDefault(); if(busy)return; const address=$('token-contract').value.trim(); if(!address)return;
    const id=++requestId; ++detailsId; clearTimeout(detailsRetryTimer); busy=true; $('token-load').disabled=true; $('token-feedback').textContent='Finding indexed pools…';
    // Clear the previous market immediately so a failed/new search can never
    // leave a chart or ticket looking like the newly requested contract.
    token=''; pools=[]; selected=null; statsRetryAt=0; clearChart('Loading chart…'); $(chain==='solana'?'manual-mint':'rh-manual-token').value=''; $('token-source').hidden=true; $('token-title').textContent='Loading market…'; $('token-address').textContent=address;
    $('market-detail-note').textContent=''; $('market-detail-body').replaceChildren(node('p','Loading a new market…','terminal-empty')); $('token-pool').replaceChildren(node('option','Loading…')); $('token-pool').disabled=true; $('market-metrics').replaceChildren(); $('market-changes').hidden=true; $('chart-context').textContent=''; $('token-chart').replaceChildren(node('p','Loading chart…','chart-empty'));
    try{
      const otherChain = chain === 'solana' && /^0x[0-9a-f]{40}$/i.test(address) ? 'robinhood' : chain === 'robinhood' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? 'solana' : '';
      if (otherChain) throw Object.assign(Error(`This looks like a ${otherChain === 'solana' ? 'Solana mint' : 'Robinhood / EVM contract'}. Your search is currently on ${chainName}.`), { otherChain });
      const data=await api(`/api/market/pools?chain=${chain}&address=${encodeURIComponent(address)}`); if(id!==requestId)return; token=data.tokenAddress; pools=data.pools; if(Number.isFinite(data.refreshMs))marketRefreshMs=data.refreshMs;statsNextAt=Date.now()+marketRefreshMs;
      poolOptions();
      $('token-pool').disabled=!pools.length; $('token-feedback').textContent=data.stale?`Delayed DEX Screener snapshot from ${retryTime(data.at)}. ${data.warning||'The provider is temporarily unavailable.'}`:data.note || `${pools.length} DEX Screener pool${pools.length===1?'':'s'} · choose the pool you want to watch.`; if(data.stale){statsRetryAt=data.retryAt||Date.now()+60000;statsNextAt=Math.max(statsNextAt,statsRetryAt);}
      if(pools.length)selectPool();else{$('token-title').textContent='Not indexed yet';clearChart(data.note||'No indexed DEX Screener pool found for this token yet.');poolOptions('','No indexed pools');renderDetails();}
    }catch(error){if(id===requestId){$('token-title').textContent='Market unavailable';$('token-pool').replaceChildren(node('option','No market selected'));$('market-detail-body').replaceChildren(node('p','Load a token to see this data.','terminal-empty'));$('token-feedback').textContent=error.message; if(error.statusCode===428)connectionsLink($('token-feedback'));if(error.otherChain){const link=node('a',`Search on ${error.otherChain === 'solana' ? 'Solana' : 'Robinhood'} →`,'market-switch-link');link.id='market-switch-chain';link.href=`${error.otherChain === 'solana' ? '/' : '/robinhood'}?token=${encodeURIComponent(address)}`;$('token-feedback').append(link);} clearChart('Try again or search another contract.');}}
    finally{if(id===requestId){busy=false;$('token-load').disabled=false;}}
  };
  function orders() {
    const bySignature=new Map(), events=(overview?.sessions || []).flatMap(s=>s.events.map(e=>({...e,kind:s.kind}))).sort((a,b)=>a.at-b.at);
    // A lifecycle is grouped by signature; receipt confirmation supersedes
    // submission. Approvals remain visible and are never labelled as swaps.
    for(const e of events){if(!e.signature || !['submitted','confirmed','error','warn','trade','success'].includes(e.level))continue; if(token && (e.token || e.mint) && (chain==='solana'?(e.token||e.mint)!==token:(e.token||e.mint).toLowerCase()!==token.toLowerCase()))continue; const key=`${e.kind}:${e.signature}`;bySignature.set(key,{...bySignature.get(key),...e});}
    $('market-detail-note').textContent=overviewError || 'Your recent execution activity across all four tools. Times are Launchpad event times. Rows without token metadata remain visible.';
    const rows=[...bySignature.values()].sort((a,b)=>b.at-a.at).slice(0,80).map(e=>[new Date(e.at).toLocaleTimeString(undefined,{hour12:false}),titles[e.kind],e.operation==='approval'?'Approval':e.side||e.operation||'Trade',node('span',e.level,e.level==='confirmed'?'positive':e.level==='error'?'negative':''),short(e.wallet),txLink(chain,e.signature)]);
    renderIfChanged($('market-detail-body'),['orders',token,[...bySignature.values()]],()=>$('market-detail-body').replaceChildren(rows.length?table(['Time','Tool','Action','Status','Wallet','Transaction'],rows):node('p','Your submitted trades will appear here.','terminal-empty')));
  }
  function renderSwaps() {
    if(!selected){$('market-detail-note').textContent='';$('market-detail-body').replaceChildren(node('p','Choose an indexed pool to view market swaps.','terminal-empty'));return;}
    const key=`${token}:${selected.address}`,state=liveTradeCache.get(key)||{},data=state.data;
    $('market-detail-note').textContent=`${data?.source||'Onchain pool activity'}${data?.at?` · checked ${retryTime(data.at)}`:''}${state.retryAt>Date.now()?` · next retry after ${retryTime(state.retryAt)}`:''}. DEX Screener supplies the chart and market totals.`;
    renderIfChanged($('market-detail-body'),['swaps',key,data?.trades,data?.partial,data?.warning,data?.note,data?.quoteSymbol,data?.source,data?.indexed,data?.rpcUnavailable,data?.unavailable,data?.stale,data?.connectionRequired,data?.unsupported,data?.backlog,state.error,!!data,marketSwapRows(selected)],()=>{
      const oldScroll=$('market-detail-body').querySelector('.live-trades-scroll'),position=oldScroll?{left:oldScroll.scrollLeft,top:oldScroll.scrollTop}:null;
      const feed=createLiveTradesView({document,chain,symbol:selected.symbol||'tokens',data,loading:!data&&!state.error,error:state.error,now:Date.now(),previous:$('market-detail-body').querySelector('.live-trades-view')});
      const source=node('a','Open this market on DEX Screener ↗','market-swaps-jump');source.href=dexScreenerUrl(chain,selected.address);source.target='_blank';source.rel='noopener noreferrer';
      const totals=node('details',null,'market-swaps-totals'),summary=node('summary','DEX Screener activity totals');totals.open=!!$('market-detail-body').querySelector('.market-swaps-totals')?.open;
      const rows=marketSwapRows(selected).map(row=>[row.label,node('span',row.buys,'positive'),node('span',row.sells,'negative'),row.volume]);
      totals.append(summary,node('p',`Buy/sell counts describe the pool's base token, ${selected.base.symbol}.`,'help'),table(['Period','Buys','Sells','Volume'],rows));
      $('market-detail-body').replaceChildren(feed,source,totals);
      const next=$('market-detail-body').querySelector('.live-trades-scroll');if(next&&position){next.scrollLeft=position.left;next.scrollTop=position.top;}
    });
  }
  async function refreshLiveTrades(force=false) {
    if(liveTradeBusy||tab!=='trades'||!selected||!token||document.hidden||document.body.dataset.workspace!=='terminal')return;
    const address=token,pair=selected.address,key=`${address}:${pair}`,state=liveTradeCache.get(key)||{nextAt:0,retryAt:0};
    if(Date.now()<state.retryAt||(!force&&Date.now()<state.nextAt))return;
    liveTradeCache.delete(key);liveTradeCache.set(key,state);while(liveTradeCache.size>20)liveTradeCache.delete(liveTradeCache.keys().next().value);
    const startedAt=Date.now();liveTradeBusy=true;state.nextAt=startedAt+1000;
    try {
      const data=await api(`/api/market/live-trades?chain=${chain}&address=${encodeURIComponent(address)}&pair=${encodeURIComponent(pair)}`);
      state.data=data;state.error='';state.failures=0;
      const refresh=Number(data.refreshMs);state.nextAt=startedAt+(Number.isFinite(refresh)?Math.max(1000,Math.min(300000,refresh)):1000);
      state.retryAt=data.stale?(Number(data.retryAt)||Date.now()+15000):0;
      if(data.stale)state.error=data.warning||'Showing the last available swaps while the provider recovers.';
    } catch(error) {
      state.failures=(state.failures||0)+1;
      state.retryAt=Date.now()+Math.max(1000,Number(error.retryAfterMs)||Math.min(60000,2000*2**Math.min(state.failures-1,5)));
      state.error=`${error.message||'The swap feed could not refresh.'}${state.data?' Showing the last available swaps.':''}`;
    } finally {liveTradeBusy=false;if(tab==='trades'&&token===address&&selected?.address===pair)renderSwaps();}
  }
  async function renderDetails(force=false) {
    if(tab==='orders'){orders();return;}
    if(tab==='trades'){renderSwaps();refreshLiveTrades(force);return;}
    if(!token){ $('market-detail-note').textContent=''; $('market-detail-body').replaceChildren(node('p','Load a token to see this data.','terminal-empty'));return; }
    if (detailBusy) return;
    const id=++detailsId,currentTab=tab,address=token,cacheKey=`holders:${address}`,cached=detailCache.get(cacheKey);
    function render(data) {
      const histories=new Map((data.rows||[]).map(row=>[row.address,holderHistoryCache.get(`${address}:${row.address}`)]).filter(([,state])=>state));
      const onHistory=async wallet=>{
        const historyKey=`${address}:${wallet}`, previous=holderHistoryCache.get(historyKey);
        if(previous?.loading || tab!=='holders' || token!==address)return;
        const state={...previous,loading:true,error:''};holderHistoryCache.delete(historyKey);holderHistoryCache.set(historyKey,state);
        while(holderHistoryCache.size>60)holderHistoryCache.delete(holderHistoryCache.keys().next().value);
        render(detailCache.get(cacheKey)||data);
        try{state.data=await api(`/api/market/holder-history?chain=${chain}&address=${encodeURIComponent(address)}&wallet=${encodeURIComponent(wallet)}`);}
        catch(error){state.error=error.message||'Wallet activity could not load. Try again.';}
        finally{state.loading=false;if(tab==='holders'&&token===address)render(detailCache.get(cacheKey)||data);}
      };
      renderIfChanged($('market-detail-body'),[cacheKey,data.rows,data.supply,data.listedSupplyPercent,data.historyAvailable,data.historyNote,selected?.priceUsd,selected?.symbol,[...histories]],()=>{
        const previousScroll=$('market-detail-body').querySelector('.holders-scroll'),position=previousScroll?{left:previousScroll.scrollLeft,top:previousScroll.scrollTop}:null;
        $('market-detail-body').replaceChildren(createHoldersView({document,chain,token:address,symbol:selected?.symbol||'tokens',priceUsd:selected?.priceUsd,data,histories,onHistory}));
        const next=$('market-detail-body').querySelector('.holders-scroll');if(next&&position){next.scrollLeft=position.left;next.scrollTop=position.top;}
      });
    }
    function cooldown(at) {
      detailsRetryAt.set(currentTab,at); clearTimeout(detailsRetryTimer);
      $('market-detail-note').textContent=`Market feed cooling down · next retry after ${retryTime(at)}.${cached?` Showing data from ${retryTime(cached.at)}.`:''}`;
      if(!cached) $('market-detail-body').replaceChildren(node('p','Waiting for the data provider. Trading runs continue independently.','terminal-empty'));
      if(marketRefreshMs)detailsRetryTimer=setTimeout(()=>{ if(marketRefreshMs && !document.hidden && document.body.dataset.workspace==='terminal')renderDetails(); },Math.min(300000,Math.max(1000,at-Date.now()+200)));
    }
    if(cached)render(cached);else $('market-detail-body').replaceChildren(node('p','Loading market data…','terminal-empty'));
    if(Date.now()<(detailsRetryAt.get(currentTab)||0)){cooldown(detailsRetryAt.get(currentTab));return;}
    if(cached && !cached.stale && !force && Date.now()-cached.at<(marketRefreshMs?15000:60000)){$('market-detail-note').textContent=`${cached.source} · updated ${retryTime(cached.at)} · ${cached.note}`;return;}
    detailBusy=true; $('market-detail-note').textContent=cached?'Updating…':'Loading…';
    try {
      const data=await api(`/api/market/holders?chain=${chain}&address=${encodeURIComponent(address)}`);if(id!==detailsId || tab!==currentTab)return;
      detailCache.set(cacheKey,data);while(detailCache.size>20)detailCache.delete(detailCache.keys().next().value);render(data);
      $('market-detail-note').textContent=`${data.source} · updated ${retryTime(data.at)} · ${data.note}`;
      if(data.stale){cooldown(data.retryAt||Date.now()+60000);$('market-detail-note').textContent+=` Last available snapshot: ${retryTime(data.at)}.`;render(data);}else detailsRetryAt.delete(currentTab);
    } catch(error) {
      if(id===detailsId && tab===currentTab){ if(error.retryAfterMs)cooldown(Date.now()+error.retryAfterMs);else{$('market-detail-note').textContent=error.message;if(!cached)$('market-detail-body').replaceChildren(node('p',error.statusCode===428?'Connect your data provider to view this tab.':'Data unavailable. Try Refresh.','terminal-empty'));if(error.statusCode===428)connectionsLink($('market-detail-body'));} }
    } finally { detailBusy=false; if(id!==detailsId || tab!==currentTab)renderDetails(); }
  }
  for(const b of terminal.querySelectorAll('[data-market-tab]')) b.onclick=()=>{++detailsId;clearTimeout(detailsRetryTimer);tab=b.dataset.marketTab;loadChart();for(const other of terminal.querySelectorAll('[data-market-tab]'))other.setAttribute('aria-pressed',String(other===b));renderDetails();};
  $('market-refresh').onclick=()=>tab==='orders'?poll():tab==='trades'?refreshLiveTrades(true):renderDetails(true);
  async function poll(){
    if(pollBusy || document.hidden || document.body.dataset.workspace!=='terminal')return;pollBusy=true;
    try{overview=await api(`/api/trading-overview?chain=${chain}`);overviewError='';shell?.update(overview);let count=overview.sessions.filter(s=>s.state!=='stopped').length;
      renderIfChanged($('terminal-bots'),overview.sessions.map(s=>[s.kind,s.state,openPositionCount(s.positions),s.pending.length]),()=>{$('terminal-bots').replaceChildren();
      for(const s of overview.sessions){const b=node('button',null,'bot-row');b.type='button';const info=node('div'); info.append(node('strong',titles[s.kind]),node('small',`${openPositionCount(s.positions)} positions · ${s.pending.length} pending`));b.append(info,node('span',s.state,`bot-state ${s.state}`));b.onclick=()=>nav.querySelector(chain==='solana'?`[data-tab="${s.kind}"]`:`[data-kind="${s.kind}"]`)?.click();$('terminal-bots').append(b);}});
      $('terminal-active').textContent=`${count} active`;$('terminal-sync').textContent=`Synced ${new Date(overview.at).toLocaleTimeString()} · select a bot to manage it`;if(tab==='orders')orders();
    }catch(error){overviewError=`Session feed unavailable: ${error.message}`;$('terminal-sync').textContent=overviewError;if(tab==='orders')orders();}finally{pollBusy=false;}
  }
  setInterval(()=>{if(marketRefreshMs && tab==='holders' && !document.hidden && document.body.dataset.workspace==='terminal')renderDetails(true);},15000);
  setInterval(()=>{if(tab==='trades'&&!document.hidden&&document.body.dataset.workspace==='terminal'){updateTradeAges($('market-detail-body'),Date.now());return refreshLiveTrades();}},1000);
  setInterval(poll,5000); document.addEventListener('visibilitychange',()=>{if(!document.hidden){poll();refreshLiveTrades();if(marketRefreshMs&&tab==='holders')renderDetails();}}); openTerminal();
  shell=createWorkspaceShell({chain,nav,session,openConnections});shell?.update(overview||{sessions:[]});
  const params=new URLSearchParams(location.search);
  const initialTool=params.get('tool');if(['copy','sniper','liquidity','market'].includes(initialTool))nav.querySelector(chain==='solana'?`[data-tab="${initialTool}"]`:`[data-kind="${initialTool}"]`)?.click();
  if(params.get('account')==='connections')openConnections();
  else if(params.get('account')==='overview')$(chain==='solana'?'account-button':'rh-account')?.click();
  const initialToken = new URLSearchParams(location.search).get('token');
  if (initialToken && initialToken.length <= 44) { $('token-contract').value = initialToken; $('token-search').requestSubmit(); }
  return { refresh:poll };
}
