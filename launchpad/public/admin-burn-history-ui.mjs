import { PAGE_SIZE, filterBar, pageRows, pager } from './admin-list-kit.mjs';
import { revenueAmount } from './admin-revenue-ui.mjs';

const BASE58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function validSignature(value){
  if(typeof value!=='string'||value.length<64||value.length>88||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value))return false;
  let decoded=0n;for(const char of value)decoded=decoded*58n+BigInt(BASE58.indexOf(char));
  return (value.match(/^1*/)?.[0].length||0)+(decoded===0n?0:Math.ceil(decoded.toString(16).length/2))===64;
}
function transactionSignature(value){
  if(validSignature(value))return value;
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||!['solscan.io','www.solscan.io'].includes(url.hostname)||url.port||url.username||url.password||url.hash)return null;
    const match=url.pathname.match(/^\/tx\/([1-9A-HJ-NP-Za-km-z]+)\/?$/);
    if(!match||!validSignature(match[1]))return null;
    if(url.searchParams.has('cluster')&&!['mainnet','mainnet-beta'].includes(url.searchParams.get('cluster')))return null;
    return match[1];
  }catch{return null;}
}
const dateLabel=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)return '';const date=new Date(n);return Number.isNaN(date.getTime())?'':date.toLocaleString();};

// Recorded transactions change only through imports, so reopening the page within a minute reuses them.
const FRESH_MS=60000;
export function createAdminBurnHistory({document,api,protectedAction,getAccount,isActive=()=>true,clock=Date.now}){
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined&&text!==null)node.textContent=String(text);if(cls)node.className=cls;return node;};
  const element=el('section',null,'admin-card admin-burn-history');element.id='admin-burn-history';
  const heading=el('div',null,'admin-card-heading'),copy=el('div'),refresh=el('button','Refresh','text-button');refresh.type='button';refresh.id='admin-burn-history-refresh';
  copy.append(el('p','LAUNCHPAD / ANALYTICS','eyebrow'),el('h2','Buybacks & burns'),el('p','Add completed LAUNCHPAD transactions to the public analytics page. Amounts are verified from the transactions.'));
  heading.append(copy,refresh);
  const form=el('form',null,'admin-protocol-form');form.id='admin-burn-history-form';
  const burnLabel=el('label','Burn transaction link'),burn=el('input');burn.id='admin-burn-history-burn';burn.name='burnLink';burn.required=true;burnLabel.append(burn);
  const buyLabel=el('label','Buyback transaction link (optional)'),buy=el('input');buy.id='admin-burn-history-buyback';buy.name='buybackLink';buyLabel.append(buy);
  for(const input of [burn,buy]){input.type='text';input.inputMode='url';input.autocomplete='off';input.spellcheck=false;input.maxLength=300;input.placeholder='https://solscan.io/tx/…';}
  const hint=el('p','Leave buyback blank to record a burn only.','help admin-protocol-wide');hint.id='admin-burn-history-hint';buy.setAttribute('aria-describedby',hint.id);
  const submit=el('button','Add to analytics','small-button');submit.type='submit';submit.id='admin-burn-history-submit';
  form.append(burnLabel,buyLabel,hint,submit);
  const status=el('p','','admin-revenue-status');status.id='admin-burn-history-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const analytics=el('a','View analytics ↗','text-button');analytics.href='/analytics';analytics.id='admin-burn-history-analytics';analytics.hidden=true;
  const history=el('div',null,'admin-protocol-gas');history.id='admin-burn-history-records';
  element.append(heading,form,status,analytics,history);
  let revision=0,disposed=false,loading=false,busy=false,hasData=false,controller=null,loadedAt=0;
  const identity=()=>{const account=getAccount();return account?.id??account;};
  const permitted=()=>!disposed&&getAccount()?.role==='admin'&&getAccount()?.mfaEnabled;
  const current=(generation,owner)=>permitted()&&generation===revision&&owner===identity();
  function controls(){
    const unavailable=!permitted()||busy;
    burn.disabled=buy.disabled=submit.disabled=unavailable;
    refresh.disabled=unavailable||loading;
    submit.textContent=busy?'Verifying transactions…':'Add to analytics';
    form.setAttribute('aria-busy',String(busy));
  }
  function setStatus(text,negative=false){status.textContent=text;status.classList.toggle('negative',negative);}
  // Long histories read 25 a page (newest first) with a text filter; short ones show at once.
  const listQuery={q:'',offset:0};let lastRows=[];
  const listFilter=filterBar(document,{placeholder:'Find a transaction: signature, kind or date',label:'Find a recorded transaction',onChange:({q})=>{listQuery.q=q;listQuery.offset=0;render(lastRows);}});
  listFilter.input.id='admin-burn-history-search';
  const listPages=pager(document,{label:'transactions',onPage:offset=>{listQuery.offset=offset;render(lastRows);history.scrollIntoView?.({block:'start'});}});
  function render(rows){
    lastRows=Array.isArray(rows)?rows:[];
    history.replaceChildren(el('h3','Recorded transactions'));
    const safeRows=lastRows.filter(row=>['buy','burn'].includes(row?.kind)&&validSignature(row.signature)).sort((a,b)=>(Number(b.confirmedAt)||0)-(Number(a.confirmedAt)||0));
    if(!safeRows.length){history.append(el('p','No imported transactions yet. Add a burn link above to get started.','help'));return;}
    const page=pageRows(safeRows,{offset:listQuery.offset,q:listQuery.q,fields:['signature','kind',row=>row.kind==='burn'?'burned':'bought',row=>dateLabel(row.confirmedAt)||''],limit:PAGE_SIZE});listQuery.offset=page.offset;
    if(safeRows.length>PAGE_SIZE||listQuery.q)history.append(listFilter.element);
    const list=el('ul',null,'admin-protocol-history');
    if(!page.rows.length)list.append(el('li','No recorded transactions match this filter.','help'));
    for(const row of page.rows){
      const item=el('li'),details=el('div'),label=row.kind==='burn'?'LAUNCHPAD burned':'LAUNCHPAD bought';
      const amount=revenueAmount(row.kind==='burn'?row.inputAmount:row.outputAmount,row.curveDecimals);
      details.append(el('strong',label+(amount===null?' —':': '+amount+' LAUNCHPAD')));
      if(row.kind==='buy'){const sol=revenueAmount(row.inputAmount,9);if(sol!==null)details.append(el('span',sol+' SOL spent','help'));}
      const date=dateLabel(row.confirmedAt);if(date)details.append(el('time',date,'help'));
      const link=el('a','View transaction ↗');link.href='https://solscan.io/tx/'+row.signature;link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label','View '+(row.kind==='burn'?'burn':'buyback')+' transaction '+row.signature);
      item.append(details,link);list.append(item);
    }
    history.append(list);listPages.update({offset:page.offset,limit:PAGE_SIZE,total:page.total,shown:page.rows.length});history.append(listPages.element);
  }
  function clear(){
    revision++;controller?.abort();controller=null;loading=false;busy=false;hasData=false;loadedAt=0;
    element.hidden=true;burn.value=buy.value='';setStatus('');analytics.hidden=true;history.replaceChildren();controls();
  }
  async function load(){
    if(!permitted()){clear();return;}
    if(!isActive()||loading||busy)return;
    const generation=revision,owner=identity();loading=true;element.hidden=false;controller=new AbortController();const request=controller;controls();
    if(!hasData)setStatus('Loading recorded transactions…');
    try{
      const result=await api('/api/admin/burn-history',undefined,{signal:request.signal});
      if(!current(generation,owner))return;
      if(!Array.isArray(result?.history))throw Error('Invalid history response.');
      render(result.history);hasData=true;loadedAt=clock();
      if(status.textContent==='Loading recorded transactions…'||status.classList.contains('negative'))setStatus('');
    }catch(error){if(current(generation,owner)&&!request.signal.aborted)setStatus(hasData?'Could not refresh recorded transactions. Your last loaded records are shown.':'Could not load recorded transactions. Refresh to try again; you can still add a burn.',true);}
    finally{if(current(generation,owner)){loading=false;if(controller===request)controller=null;controls();}}
  }
  form.onsubmit=async event=>{
    event.preventDefault();if(!permitted()||!isActive()||busy)return;
    const burnLink=burn.value.trim(),buybackLink=buy.value.trim();
    if(!transactionSignature(burnLink)){setStatus('Enter a valid Solscan burn transaction link or Solana transaction signature.',true);burn.focus();return;}
    if(buybackLink&&!transactionSignature(buybackLink)){setStatus('Enter a valid Solscan buyback transaction link, or leave buyback blank.',true);buy.focus();return;}
    // Stop a history read from replacing the receipt of this import when it finishes later.
    controller?.abort();controller=null;loading=false;const generation=++revision,owner=identity();busy=true;controls();setStatus('Verify your admin access to add these transactions.');analytics.hidden=true;
    let attempted=false;
    try{
      await protectedAction('Add LAUNCHPAD buyback and burn to analytics',async credentials=>{
        if(!current(generation,owner)||!isActive())return;
        attempted=true;setStatus('Verifying confirmed transactions…');
        try{
          const result=await api('/api/admin/burn-history',{burnLink,...(buybackLink?{buybackLink}:{}),...credentials});
          if(!current(generation,owner))return;
          if(!Array.isArray(result?.history))throw Error('The import response could not be confirmed. Refresh the records before retrying.');
          render(result.history);hasData=true;burn.value=buy.value='';analytics.hidden=false;
          setStatus(result.added>0?'Added to analytics.':result.updated>0?'Updated in analytics.':'Already recorded in analytics. No duplicate was added.');
        }catch(error){if(current(generation,owner))setStatus(error?.message||'The import could not be confirmed. Your links are kept; refresh the records before retrying.',true);}
      });
      if(current(generation,owner)&&!attempted)setStatus('Nothing was added. Your links are kept; try again when ready.');
    }catch(error){if(current(generation,owner))setStatus(error?.message==='Cancelled.'?'Nothing was added. Your links are kept.':error?.message||'Could not verify admin access. Your links are kept.',error?.message!=='Cancelled.');}
    finally{if(generation===revision){if(!current(generation,owner)){clear();return;}busy=false;controls();}}
  };
  refresh.onclick=load;
  function destroy(){clear();disposed=true;controls();}
  function show(){if(permitted()&&isActive()&&hasData&&clock()-loadedAt<FRESH_MS){element.hidden=false;return;}return load();}
  clear();return {element,load,show,clear,pause(){},destroy};
}
