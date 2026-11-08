const address=v=>typeof v==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
const short=v=>v.slice(0,5)+'…'+v.slice(-5);
const amount=v=>v!=null&&Number.isFinite(Number(v))?Number(v).toLocaleString(undefined,{maximumSignificantDigits:6}):'—';
export function createCoinActivity({document,api,mint,clock=Date.now}){
  const root=document.getElementById('coin-activity');if(!root)return {refresh:async()=>{},destroy(){}};
  const table=document.getElementById('coin-activity-table'),note=document.getElementById('coin-activity-note'),button=document.getElementById('coin-activity-refresh');
  let tab='trades',disposed=false;const cache={},busy={},next={};
  // Presentation only: remember rendered trades so newly arrived rows can animate in.
  const seenTrades=new Set();let tradesPainted=false;
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;return e;};
  const link=(text,url)=>{const a=node('a',text+' ↗');a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;};
  function render(){
    // A busy Refresh stays focusable (aria-disabled) so keyboard focus is not lost.
    if(disposed)return;if(busy[tab])button.setAttribute('aria-disabled','true');else button.removeAttribute('aria-disabled');button.textContent=busy[tab]?'Refreshing…':'Refresh';root.dataset.activityTab=tab;
    const data=cache[tab],head=table.querySelector('thead'),body=table.querySelector('tbody');head.replaceChildren();body.replaceChildren();
    const labels=tab==='trades'?['Time','Type',data?.quote?.symbol||'Paired token','Tokens','Price / token','Wallet']:['Rank','Wallet','Balance','Supply','Token account'];
    const tr=node('tr');for(const label of labels)tr.append(node('th',label));head.append(tr);
    const rows=data?.[tab]||[];let arrivals=0;
    for(const [i,row]of rows.entries()){
      const tr=node('tr');
      if(tab==='trades'){
        if(!address(row.wallet)||!Number.isFinite(row.time)||!['buy','sell'].includes(row.side)||!Number.isFinite(row.amount)||row.amount<=0||!Number.isFinite(row.quote)||row.quote<=0||! /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(row.signature))continue;
        const date=new Date(row.time*1000),cell=node('td'),age=Math.max(0,Math.floor((clock()-date.getTime())/1000));cell.append(link(age<60?age+'s ago':age<3600?Math.floor(age/60)+'m ago':Math.floor(age/3600)+'h ago','https://solscan.io/tx/'+row.signature));cell.title=date.toLocaleString();tr.append(cell);
        const side=node('td'),chip=node('span',row.side==='buy'?'Buy':'Sell');chip.className='trade-side-chip';side.className='trade-'+row.side;side.append(chip);tr.className='trade-row is-'+row.side;tr.append(side,node('td',amount(row.quote)),node('td',amount(row.amount)),node('td',amount(row.quote/row.amount)));
        if(tradesPainted&&!seenTrades.has(row.signature)&&arrivals<8){tr.classList.add('is-arriving');tr.style?.setProperty?.('--arrival',String(arrivals++));}seenTrades.add(row.signature);
        const wallet=node('td');wallet.append(link(short(row.wallet),'https://solscan.io/account/'+row.wallet));tr.append(wallet);
      }else{
        if(!address(row.wallet)||!address(row.tokenAccount))continue;
        const rank=node('td',String(i+1));if(i<3)rank.className='coin-holder-rank is-top-'+(i+1);tr.className='coin-holder-row';tr.append(rank);const wallet=node('td');wallet.append(link(short(row.wallet),'https://solscan.io/account/'+row.wallet));if(row.isLp===true){const badge=node('span','LP');badge.className='holder-lp-badge';badge.title=row.lpType==='curve'?'Bonding curve liquidity vault':'Liquidity pool vault';wallet.append(badge);}const share=node('td',row.percent==null?'—':amount(row.percent)+'%');if(row.percent!=null&&Number.isFinite(Number(row.percent))){share.className='coin-holder-share';share.style?.setProperty?.('--share',String(Math.max(0,Math.min(100,Number(row.percent)))));}tr.append(wallet,node('td',amount(row.amount)),share);const account=node('td');account.append(link(short(row.tokenAccount),'https://solscan.io/account/'+row.tokenAccount));tr.append(account);
      }body.append(tr);
    }
    if(!body.children.length){const loading=!!(busy[tab]||data?.refreshing),tr=node('tr'),td=node('td',loading?(tab==='trades'?'Warming up the tape…':'Counting holders…'):data?.available?(tab==='trades'?'Quiet on the curve. No trades in the last 24 hours yet.':'No holder balances found yet.'):'Unable to load '+tab+'. Try refreshing.');td.colSpan=labels.length;td.className='activity-empty'+(loading?' is-loading':'');tr.append(td);body.append(tr);
      // Decorative only: a Gotchi peeks into a quiet table (the shared motion layer draws it when present).
      if(!loading&&data?.available){const motion=document.defaultView?.curveMotion;if(typeof motion?.peek==='function')try{Promise.resolve(motion.peek(td,{side:'right',height:72})).catch(()=>{});}catch{}}}
    if(tab==='trades'&&rows.length)tradesPainted=true;
    note.textContent=[data?.at?'Updated '+new Date(data.at).toLocaleTimeString():'',data?.note].filter(Boolean).join(' · ');
  }
  async function refresh(force=false){
    const kind=tab;if(disposed||document.hidden||busy[kind]||(!force&&clock()<(next[kind]||0)))return;
    busy[kind]=true;next[kind]=clock()+(kind==='holders'?60000:30000);render();
    try{const data=await api('/api/explore/'+kind+'?mint='+encodeURIComponent(mint));if(data?.mint!==mint||!Array.isArray(data[kind]))throw Error('Invalid token activity');next[kind]=clock()+Math.max(10000,Math.min(120000,Number(data.refreshMs)||(kind==='holders'?60000:30000)));cache[kind]=data.available===false&&cache[kind]?.[kind]?.length?{...cache[kind],stale:true,note:'Showing the last available balances. '+(data.note||'Updates are temporarily unavailable.')}:data;}
    catch{cache[kind]={...cache[kind],note:'Updates are temporarily unavailable. Refresh to try again.'};}finally{busy[kind]=false;render();}
  }
  for(const b of root.querySelectorAll('[data-activity]'))b.onclick=()=>{tab=b.dataset.activity;for(const other of root.querySelectorAll('[data-activity]'))other.setAttribute('aria-pressed',String(other===b));render();void refresh();};
  button.onclick=()=>refresh(true);
  return {refresh,destroy(){disposed=true;}};
}
