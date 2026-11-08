const POLL_MS=15000;
const states={available:'Current records',partial:'Partial history',unavailable:'History unavailable'};

export function revenueAmount(value,decimals){
  const raw=String(value??'');
  if(!/^\d{1,80}$/.test(raw)||!Number.isInteger(decimals)||decimals<0||decimals>18)return null;
  const padded=BigInt(raw).toString().padStart(decimals+1,'0');
  const whole=(decimals?padded.slice(0,-decimals):padded).replace(/\B(?=(\d{3})+(?!\d))/g,',');
  const fraction=decimals?padded.slice(-decimals).replace(/0+$/,''):'';
  return whole+(fraction?'.'+fraction:'');
}

export function createAdminRevenue({document,api,getAccount,getFeatures=()=>({}),isActive=()=>true,setTimer=setInterval,clearTimer=clearInterval,clock=Date.now}){
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined&&text!==null)node.textContent=String(text);if(cls)node.className=cls;return node;};
  const element=el('section',null,'admin-card admin-revenue');element.id='admin-revenue';
  const heading=el('div',null,'admin-card-heading'),copy=el('div'),refresh=el('button','Refresh','text-button');refresh.type='button';refresh.id='admin-revenue-refresh';
  copy.append(el('p','PLATFORM / REVENUE','eyebrow'),el('h2','Protocol fees & revenue'),el('p','Confirmed fees by product and asset. Updates every 15 seconds while this page is visible.'));
  heading.append(copy,refresh);
  const status=el('p','','admin-revenue-status');status.setAttribute('role','status');
  const totals=el('div',null,'admin-revenue-totals'),products=el('div',null,'admin-revenue-products'),note=el('p','','admin-muted');
  const more=el('details',null,'admin-more');more.append(el('summary','More info'),note);element.append(heading,status,totals,products,more);
  let revision=0,loading=false,disposed=false,active=false,timer=null,hasData=false,loadedAt=0;
  const toolkitEnabled=()=>getFeatures()?.toolkit===true;
  const visibleAssets=assets=>(Array.isArray(assets)?assets:[]).filter(asset=>toolkitEnabled()||asset.scope==='launchpad');
  const permitted=()=>!disposed&&getAccount()?.role==='admin'&&getAccount()?.mfaEnabled;
  function stop(){if(timer!==null){clearTimer(timer);timer=null;}}
  function schedule(){stop();if(active&&permitted()&&isActive()&&!document.hidden)timer=setTimer(()=>{if(permitted()&&isActive()&&!document.hidden)void load();else stop();},POLL_MS);}
  function clear(){revision++;active=false;loading=false;stop();hasData=false;loadedAt=0;totals.replaceChildren();products.replaceChildren();note.textContent='';status.textContent='';element.hidden=true;refresh.disabled=false;}
  function amount(value,decimals){const full=revenueAmount(value,decimals),node=el('span',full??'—','admin-revenue-amount');if(full!==null)node.title=full;return node;}
  function assetLabel(asset){const root=el('span',null,'admin-revenue-asset');root.append(el('strong',asset.symbol||'Token'),el('small',asset.chain==='robinhood'?'Robinhood':asset.chain==='solana'?'Solana':asset.chain||'Network unavailable'));if(asset.scope)root.append(el('small',asset.scope==='launchpad'?'Launchpad wallet':'Toolkit wallet'));if(asset.mint){const mint=String(asset.mint);root.append(el('small',mint.length>22?mint.slice(0,8)+'…'+mint.slice(-6):mint,'admin-revenue-mint'));root.title=mint;}return root;}
  function assetTable(assets){
    const wrapper=el('div',null,'admin-revenue-table-wrap'),table=el('table',null,'admin-revenue-table'),head=el('thead'),tr=el('tr'),body=el('tbody');
    for(const [index,label] of (toolkitEnabled()?['Asset','Earned after cashback','Sent to treasury','Pending transfer','Cashback owed']:['Asset','Earned','Sent to treasury','Pending transfer']).entries())tr.append(el('th',label,index?'num':null));
    head.append(tr);table.append(head,body);
    for(const asset of assets){const row=el('tr'),name=el('td');name.append(assetLabel(asset));row.append(name);for(const field of toolkitEnabled()?['netAmount','paidAmount','pendingAmount','cashbackPendingAmount']:['netAmount','paidAmount','pendingAmount']){const cell=el('td',null,'num');cell.append(amount(asset[field],asset.decimals));if(field==='paidAmount'&&asset.scope==='launchpad')cell.title='Sent before token transfer fees';row.append(cell);}body.append(row);}
    wrapper.append(table);
    if(!toolkitEnabled())return wrapper;
    const breakdown=el('details',null,'admin-revenue-gross'),summary=el('summary','Gross fees & cashback breakdown');breakdown.append(summary);
    for(const asset of assets){const line=el('p',null,'admin-muted');line.append(el('strong',(asset.symbol||'Token')+(asset.scope==='launchpad'?' · Launchpad':asset.scope==='toolkit'?' · Toolkit':'')),el('span',' · Gross fees: '),amount(asset.grossAmount,asset.decimals),el('span',' · Cashback allocated: '),amount(asset.cashbackAmount,asset.decimals));breakdown.append(line);}wrapper.append(breakdown);return wrapper;
  }
  function productRow(product){
    const root=el('article',null,'admin-revenue-product'),top=el('div',null,'admin-revenue-product-top'),name=el('div'),rate=el('div',null,'admin-revenue-rate');
    name.append(el('span',product.scope==='launchpad'?'Launchpad':'Toolkit','admin-revenue-scope'),el('h3',product.label||'Product'));
    const state=el('span',states[product.status]||'History unavailable','admin-revenue-state');state.dataset.state=Object.hasOwn(states,product.status)?product.status:'unavailable';name.append(state);
    rate.append(el('strong',product.feeLabel||'Rate unavailable'),el('span',product.feeBasis||'Fee basis unavailable'));top.append(name,rate);root.append(top);
    const assets=visibleAssets(product.totals);
    root.append(assets.length?assetTable(assets):el('p',product.noFees===true?'0 protocol earnings. No Launchpad protocol fee applies.':product.status==='available'?'No confirmed fees recorded.':'No confirmed totals are available for this product.','admin-muted'));
    if(product.note)root.append(el('p',product.note,'admin-muted'));return root;
  }
  function render(data){
    const assets=visibleAssets(data.totals),rows=(Array.isArray(data.products)?data.products:[]).filter(product=>toolkitEnabled()||product.scope==='launchpad');
    totals.replaceChildren(el('h3','Recorded earnings by asset'));
    totals.append(assets.length?assetTable(assets):el('p','No confirmed earnings are recorded yet. Review each product for history availability.','admin-muted'));
    products.replaceChildren(...(rows.length?rows.map(productRow):[el('p','Product fee records are unavailable.','admin-muted')]));
    note.textContent=(toolkitEnabled()?(data.note?String(data.note)+' ':''):'Confirmed retained launchpad history, not an audited lifetime total. ')+'Sent to treasury and pending transfer are gross amounts. Launchpad transfers are before any token transfer fee. '+(toolkitEnabled()?'Cashback owed is a separate liability. ':'')+'Totals include confirmed records only; missing history is not treated as zero.';
    const at=Number(data.at),date=Number.isFinite(at)&&at>0?new Date(at):null;
    status.textContent=date&&!Number.isNaN(date.getTime())?'Updated '+date.toLocaleString()+'.':'Update time unavailable.';
    status.classList.remove('negative');hasData=true;loadedAt=clock();
  }
  async function load(){
    if(!permitted()){clear();return;}if(!isActive()){stop();return;}
    active=true;if(document.hidden){schedule();return;}if(loading)return;
    loading=true;refresh.disabled=true;element.hidden=false;const generation=revision;
    if(!hasData)status.textContent='Loading confirmed revenue…';
    try{const data=await api('/api/admin/revenue');if(!permitted()||generation!==revision)return;render(data);}
    catch{if(permitted()&&generation===revision){status.textContent=hasData?'Revenue could not be refreshed. Showing the last confirmed snapshot.':'Revenue is temporarily unavailable. Use Refresh to try again.';status.classList.add('negative');}}
    finally{if(generation===revision){loading=false;refresh.disabled=false;schedule();}}
  }
  function pause(){active=false;stop();}
  // Opening the page again reuses a report younger than one poll interval and only restarts polling.
  function show(){if(permitted()&&isActive()&&hasData&&clock()-loadedAt<POLL_MS){active=true;schedule();return;}return load();}
  function visibility(){if(document.hidden||!isActive()){stop();return;}if(active&&permitted())void load();}
  function destroy(){clear();disposed=true;document.removeEventListener('visibilitychange',visibility);}
  refresh.onclick=load;document.addEventListener('visibilitychange',visibility);clear();return {element,load,show,clear,pause,destroy};
}
