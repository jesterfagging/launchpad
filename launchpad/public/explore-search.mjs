import {coinImage} from './coin-image.mjs';

// The header search is on every page. Pair logos and their catalogues load
// only once the search opens (Explore and coin pages already have them).
let quoteLogos=null,quoteLogosModule=null;
const loadQuoteLogos=()=>quoteLogos||(quoteLogos=import('./quote-logos.mjs').then(module=>quoteLogosModule=module,()=>{quoteLogos=null;return null;}));
// Same formats as the Explore cards (explore-view.mjs), kept here so the
// header search does not load the card renderer on every page.
const compactMoney=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:2}),preciseMoney=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumSignificantDigits:4});
const searchNumber=value=>value!==null&&value!==undefined&&value!==''&&['number','string'].includes(typeof value)&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
const exploreMoney=value=>{const n=searchNumber(value);return n===null?'—':(n>=1000?compactMoney:preciseMoney).format(n);};
const exploreShort=value=>typeof value==='string'&&value.length>14?`${value.slice(0,5)}…${value.slice(-4)}`:value||'—';

const controllers=new WeakMap();
const dialogMarkup=`<dialog id="explore-search-dialog" class="explore-search-dialog" aria-labelledby="explore-search-title" aria-modal="true">
    <h2 id="explore-search-title" class="search-sr-only">Search Launchpad</h2>
    <div class="explore-search-dialog-heading"><label class="explore-search-dialog-input" for="explore-search-input"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 5 5"></path></svg><span class="search-sr-only">Search coins or users</span><input id="explore-search-input" type="search" maxlength="100" autocomplete="off" placeholder="Search coins or users" aria-controls="explore-search-coins-results"></label><button id="explore-search-close" type="button" aria-label="Close search">✕</button></div>
    <div class="explore-search-dialog-tabs"><div id="explore-search-tabs" class="explore-search-tabs" role="tablist" aria-label="Search results"><button id="explore-search-coins-tab" type="button" role="tab" data-search-tab="coins" aria-selected="true" aria-controls="explore-search-coins-panel" tabindex="0">Coins <span id="explore-search-coins-count" class="explore-search-count">0</span></button><button id="explore-search-users-tab" type="button" role="tab" data-search-tab="users" aria-selected="false" aria-controls="explore-search-users-panel" tabindex="-1">Users <span id="explore-search-users-count" class="explore-search-count">0</span></button></div></div>
    <section id="explore-search-coins-panel" class="explore-search-panel" role="tabpanel" aria-labelledby="explore-search-coins-tab" tabindex="0"><p id="explore-search-coins-status" class="explore-search-status" role="status"></p><ul id="explore-search-coins-results" class="explore-search-results" aria-busy="false"></ul><nav id="explore-search-coins-pages" class="explore-search-pages" aria-label="Coins search pages"></nav></section>
    <section id="explore-search-users-panel" class="explore-search-panel" role="tabpanel" aria-labelledby="explore-search-users-tab" tabindex="0" hidden><p id="explore-search-users-status" class="explore-search-status" role="status"></p><ul id="explore-search-users-results" class="explore-search-results" aria-busy="false"></ul><nav id="explore-search-users-pages" class="explore-search-pages" aria-label="Users search pages"></nav></section>
  </dialog>`;
function ensureSearchSurface(document){
  if(!document.getElementById('explore-search-styles')){
    const style=document.createElement('link');style.id='explore-search-styles';style.rel='stylesheet';style.href='/explore-search.css?v=50';document.head.append(style);
  }
  if(!document.getElementById('explore-search-dialog')){
    const template=document.createElement('template');template.innerHTML=dialogMarkup;document.body.append(template.content.cloneNode(true));
  }
}
export function mountExploreHeaderSearch({document,window=document.defaultView,container}={}){
  if(!container)return;
  let label=container.querySelector('.header-search');
  if(!label){
    label=document.createElement('label');label.className='header-search';label.setAttribute('for','explore-search');
    label.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 5 5"></path></svg><span class="search-sr-only">Search coins, tickers, addresses or users</span><input id="explore-search" data-curve-search-trigger name="search" type="search" readonly autocomplete="off" placeholder="Search coins, tickers, addresses or users"><kbd aria-hidden="true">/</kbd>';
    const local=container.querySelector('.local');if(local)local.before(label);else container.append(label);
  }
  return createExploreSearch({document,window});
}

const PAGE_SIZE=12;
// Coins show their ticker as $SYMBOL; a search typed that way means the ticker.
const searchTerm=value=>String(value??'').trim().replace(/^\$+/,'').trim().slice(0,100);
const names={coins:'Coins',users:'Users'};
const mint=value=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const username=value=>typeof value==='string'&&/^[a-z0-9_][a-z0-9_-]{2,31}$/.test(value);

export function createExploreSearch({document,window=document.defaultView,fetcher=fetch,initialQuery=''}={}){
  const existing=controllers.get(document);
  if(existing){for(const node of document.querySelectorAll('[data-curve-search-trigger]'))existing.bindTrigger(node);return existing;}
  ensureSearchSurface(document);
  const $=id=>document.getElementById(id),dialog=$('explore-search-dialog'),input=$('explore-search-input'),triggers=new Map();
  const primaryTrigger=()=>[...triggers.keys()].find(node=>node.isConnected);
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=String(text);if(cls)node.className=cls;return node;};
  let opened=false,disposed=false,active='coins',query=searchTerm(initialQuery),epoch=0,debounce=null,returnTo=null,suppressFocus=false,backdropDown=false,refocused=false;
  const states=Object.fromEntries(Object.keys(names).map(kind=>[kind,{offset:0,total:0,nextOffset:null,rows:[],busy:false,error:false,request:0,controller:null,promise:null,loaded:false,refreshing:false,refreshTimer:null,warmups:0}]));
  const visible=()=>dialog.querySelectorAll('button,input,a[href],[tabindex="0"]');
  const focusables=()=>[...visible()].filter(node=>!node.disabled&&node.getAttribute('tabindex')!=='-1'&&!node.closest('[hidden]'));
  function syncTabs(){
    for(const kind of Object.keys(names)){
      const selected=kind===active,tab=$('explore-search-'+kind+'-tab');tab.setAttribute('aria-selected',String(selected));tab.setAttribute('tabindex',selected?'0':'-1');$('explore-search-'+kind+'-panel').hidden=!selected;
      $('explore-search-'+kind+'-count').textContent=states[kind].total===null?'—':states[kind].total.toLocaleString();
    }
    input.setAttribute('aria-controls','explore-search-'+active+'-results');
  }
  // Results render once the logo module is ready; if it could not load, the
  // pair keeps its readable ticker without an image.
  function quotePair(quote){
    if(quoteLogosModule)return quoteLogosModule.createQuoteLabel(document,quote,{size:18,className:'explore-search-pair'});
    const root=el('span',null,'quote-identity explore-search-pair'),symbol=String(quote.symbol||'').replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,24);
    root.append(el('span',symbol||exploreShort(quote.mint),'quote-symbol'));return root;
  }
  const unavailable=(button,value)=>{if(value)button.setAttribute('aria-disabled','true');else button.removeAttribute('aria-disabled');};
  function avatar(value,label,coinMint){
    const root=el('span',String(label||'?').slice(0,1).toUpperCase(),'explore-search-avatar');root.setAttribute('aria-hidden','true');
    const source=coinImage(coinMint,value);if(source){const image=el('img');image.src=source;image.alt='';image.loading='lazy';image.onerror=()=>{root.replaceChildren();root.textContent=String(label||'?').slice(0,1).toUpperCase();};root.replaceChildren(image);}
    return root;
  }
  // Presentation only: wrap the first case-insensitive match of the query in <mark>.
  function highlight(node,text){
    const value=String(text),lower=value.toLowerCase(),needle=query.toLowerCase(),at=needle&&lower.length===value.length?lower.indexOf(needle):-1;
    if(at<0){node.textContent=value;return node;}
    node.append(value.slice(0,at),el('mark',value.slice(at,at+needle.length),'explore-search-match'),value.slice(at+needle.length));return node;
  }
  function result(kind,value){
    if(kind==='coins'?!mint(value?.mint):!username(value?.username))return null;
    const row=el('li'),link=el('a',null,'explore-search-result'),identity=el('span',null,'explore-search-identity'),metric=el('span',null,'explore-search-metric');
    if(kind==='coins'){
      link.href='/coin?mint='+encodeURIComponent(value.mint);const name=String(value.name||value.symbol||'Unnamed coin').slice(0,100);
      identity.append(highlight(el('strong'),name),el('small',(value.symbol?'$'+String(value.symbol).slice(0,24)+' · ':'')+exploreShort(value.mint)));
      if(mint(value.quote?.mint)){const pair=quotePair(value.quote);pair.setAttribute('aria-label','Paired with '+pair.textContent);identity.append(pair);}
      const cap=typeof value.marketCapUsd==='number'&&Number.isFinite(value.marketCapUsd)&&value.marketCapUsd>=0?value.marketCapUsd:null,fdv=typeof value.fdvUsd==='number'&&Number.isFinite(value.fdvUsd)&&value.fdvUsd>=0?value.fdvUsd:null;
      metric.append(el('strong',exploreMoney(cap??fdv)),el('small',cap!==null?'Market cap':fdv!==null?'FDV':'FDV · USD'));if(cap===null&&fdv===null)metric.title='USD pricing is temporarily unavailable.';if(value.stale)metric.append(el('small','Delayed'));link.append(avatar(value.image,name,value.mint));
    }else{
      link.href='/user/'+encodeURIComponent(value.username);identity.append(highlight(el('strong'),'@'+value.username));if(typeof value.bio==='string'&&value.bio)identity.append(el('small',value.bio.slice(0,280)));
      const count=Number.isSafeInteger(value.launchCount)&&value.launchCount>=0?value.launchCount:0;metric.append(el('strong',count.toLocaleString()),el('small',count===1?'launch':'launches'));link.append(avatar(value.avatar,value.username));
    }
    const go=el('span','↗','explore-search-go');go.setAttribute('aria-hidden','true');link.append(identity,metric,go);row.append(link);return row;
  }
  function render(kind){
    const state=states[kind],root=$('explore-search-'+kind+'-results'),status=$('explore-search-'+kind+'-status'),pages=$('explore-search-'+kind+'-pages');
    const focused=root.contains(document.activeElement)?document.activeElement.closest('a')?.getAttribute('href'):null;
    // Page controls are rebuilt on every render; keyboard focus stays on the one that was used.
    const control=pages.contains(document.activeElement)?document.activeElement.dataset?.searchPage||'':null;
    root.setAttribute('aria-busy',String(state.busy));root.replaceChildren(...state.rows.map(value=>result(kind,value)).filter(Boolean));pages.replaceChildren();
    if(focused)[...root.querySelectorAll('a')].find(link=>link.getAttribute('href')===focused)?.focus({preventScroll:true});
    if(!query){status.textContent=kind==='coins'?'Search coins by name, ticker or address.':'Search for a user by username.';}
    else if(state.busy||!state.loaded&&!state.error){status.textContent='Finding '+kind+'…';}
    else if(state.error){status.textContent=names[kind]+' search is temporarily unavailable.';const retry=el('button','Try again','small-button');retry.type='button';retry.dataset.searchPage='retry';retry.onclick=()=>load(kind,state.offset,true);pages.append(retry);}
    else status.textContent=state.total?`${state.total.toLocaleString()} ${kind==='coins'?(state.total===1?'coin':'coins'):(state.total===1?'user':'users')} found`:'No matching '+kind+'.';
    if(!state.error&&state.total>PAGE_SIZE){
      const previous=el('button','Previous','small-button'),next=el('button','Next','small-button');previous.type=next.type='button';previous.dataset.searchPage='previous';next.dataset.searchPage='next';previous.setAttribute('aria-label','Previous '+kind+' search page');next.setAttribute('aria-label','Next '+kind+' search page');unavailable(previous,state.busy||state.offset===0);unavailable(next,state.busy||state.nextOffset===null);
      previous.onclick=()=>state.busy||state.offset===0?undefined:load(kind,Math.max(0,state.offset-PAGE_SIZE),true);next.onclick=()=>state.busy||state.nextOffset===null?undefined:load(kind,state.nextOffset,true);pages.append(previous,el('span',`Page ${Math.floor(state.offset/PAGE_SIZE)+1} of ${Math.ceil(state.total/PAGE_SIZE)}`),next);
    }
    if(control!==null)(pages.querySelector(`[data-search-page="${control}"]`)||input).focus({preventScroll:true});
    syncTabs();
  }
  function reset(){
    epoch++;for(const [kind,state] of Object.entries(states)){window.clearTimeout(state.refreshTimer);state.controller?.abort();state.request++;Object.assign(state,{offset:0,total:query?null:0,nextOffset:null,rows:[],busy:false,error:false,controller:null,promise:null,loaded:false,refreshing:false,refreshTimer:null,warmups:0});render(kind);}
  }
  async function load(kind,offset=states[kind].offset,force=false,quiet=false){
    if(!opened||disposed||!query)return;
    const state=states[kind];if(state.busy&&!force)return state.promise;if(state.loaded&&!force&&offset===state.offset)return;
    window.clearTimeout(state.refreshTimer);state.refreshTimer=null;state.controller?.abort();const controller=new AbortController(),generation=epoch,request=++state.request;Object.assign(state,{offset,busy:true,error:false,controller,...quiet?{}:{rows:[],nextOffset:null}});if(!quiet)render(kind);
    const params=new URLSearchParams({search:query,offset:String(offset),limit:String(PAGE_SIZE)});if(kind==='coins'){params.set('stage','all');params.set('sort','newest');}
    const pending=(async()=>{const timeout=window.setTimeout(()=>controller.abort(),15000);try{
      const logos=kind==='coins'&&!quoteLogosModule?loadQuoteLogos():null;
      const response=await fetcher((kind==='coins'?'/api/explore?':'/api/explore/users?')+params,{method:'GET',credentials:'same-origin',signal:controller.signal});const data=await response.json();if(logos)await logos;
      if(disposed||!opened||generation!==epoch||request!==state.request)return;
      if(!response.ok||!Array.isArray(data?.[kind])||!Number.isSafeInteger(data.total)||data.total<0)throw Error('Search unavailable');
      state.rows=data[kind].slice(0,PAGE_SIZE);state.total=data.total;state.nextOffset=Number.isSafeInteger(data.nextOffset)&&data.nextOffset===offset+PAGE_SIZE&&data.nextOffset<data.total?data.nextOffset:null;state.loaded=true;state.refreshing=kind==='coins'&&data.refreshing===true;
      if(!state.refreshing)state.warmups=0;
      if(state.refreshing&&active===kind&&state.warmups<6){const delay=Math.min(15000,3000*2**state.warmups++);state.refreshTimer=window.setTimeout(()=>{state.refreshTimer=null;if(opened&&!disposed&&generation===epoch&&active===kind&&!document.hidden)return load(kind,offset,true,true);},delay);}
      if(offset>0&&offset>=data.total){state.busy=false;return load(kind,data.total?Math.floor((data.total-1)/PAGE_SIZE)*PAGE_SIZE:0,true);}
    }catch{
      if(disposed||!opened||generation!==epoch||request!==state.request)return;state.error=true;state.total=null;state.rows=[];state.loaded=false;
    }finally{window.clearTimeout(timeout);if(generation===epoch&&request===state.request){state.busy=false;state.controller=null;state.promise=null;if(opened&&!disposed)render(kind);}}
    })();state.promise=pending;return pending;
  }
  function search(value){
    const next=searchTerm(value);input.value=String(value??'').trim().slice(0,100);window.clearTimeout(debounce);debounce=null;
    if(next!==query){query=next;reset();}
    return opened?Promise.allSettled(Object.keys(names).map(kind=>load(kind))):Promise.resolve();
  }
  function open(source=primaryTrigger()){
    if(disposed||suppressFocus||opened||document.querySelector('dialog[open]'))return;
    void loadQuoteLogos();refocused=false;
    returnTo=source||primaryTrigger();opened=true;for(const trigger of triggers.keys())trigger.setAttribute('aria-expanded','true');document.body.classList.add('explore-search-open');input.value=query;reset();
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');input.focus({preventScroll:true});
    return Promise.allSettled(Object.keys(names).map(kind=>load(kind)));
  }
  function close(){
    if(!opened)return;opened=false;epoch++;window.clearTimeout(debounce);debounce=null;
    for(const state of Object.values(states)){window.clearTimeout(state.refreshTimer);state.refreshTimer=null;state.controller?.abort();state.request++;state.busy=false;state.controller=null;state.promise=null;}
    for(const trigger of triggers.keys())trigger.setAttribute('aria-expanded','false');document.body.classList.remove('explore-search-open');suppressFocus=true;
    try{if(typeof dialog.close==='function'&&dialog.open)dialog.close();else dialog.removeAttribute('open');(returnTo?.isConnected?returnTo:primaryTrigger())?.focus({preventScroll:true});}finally{suppressFocus=false;}
  }
  function select(kind){if(!states[kind])return;active=kind;syncTabs();return load(kind,states[kind].offset,states[kind].refreshing,true);}
  function bindTrigger(trigger){
    if(!trigger||triggers.has(trigger)||disposed)return;
    trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-controls',dialog.id);trigger.setAttribute('aria-expanded',String(opened));
    const activate=()=>{void open(trigger);};
    // Focus returning with the tab or window is not a request to search again.
    const focus=()=>{if(refocused){refocused=false;return;}activate();};
    const key=event=>{if(event.altKey||event.ctrlKey||event.metaKey||!['Enter',' ','ArrowDown'].includes(event.key))return;event.preventDefault();activate();};
    triggers.set(trigger,{focus,activate,key});trigger.addEventListener('focus',focus);trigger.addEventListener('click',activate);trigger.addEventListener('keydown',key);
  }
  $('explore-search-close').onclick=close;
  input.oninput=()=>{window.clearTimeout(debounce);query=searchTerm(input.value);reset();debounce=window.setTimeout(()=>{debounce=null;void Promise.allSettled(Object.keys(names).map(kind=>load(kind)));},250);};
  for(const kind of Object.keys(names))$('explore-search-'+kind+'-tab').onclick=()=>select(kind);
  const keydown=event=>{
    if(!opened)return;
    if(['Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key))document.body.dataset.searchInputMode='keyboard';
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
    if(event.key==='Tab'){
      const nodes=focusables(),first=nodes[0]||input,last=nodes.at(-1)||input,target=document.activeElement||event.target;
      if(event.shiftKey&&(target===first||!dialog.contains(target))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(target===last||!dialog.contains(target))){event.preventDefault();first.focus();}return;
    }
    if(event.ctrlKey||event.metaKey||event.altKey)return;
    const tab=event.target.closest?.('[data-search-tab]');
    if(tab&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'coins':event.key==='End'?'users':active==='coins'?'users':'coins';void select(next);$('explore-search-'+next+'-tab').focus();return;}
    const links=[...$('explore-search-'+active+'-results').querySelectorAll('a')],index=links.indexOf(event.target.closest?.('a'));
    if(event.target===input){if(event.key==='Enter'){event.preventDefault();void search(input.value);}else if(event.key==='ArrowDown'&&links.length){event.preventDefault();links[0].focus();}return;}
    if(index<0)return;
    if(event.key==='ArrowUp'&&index===0){event.preventDefault();input.focus();}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();links[event.key==='Home'?0:event.key==='End'?links.length-1:Math.max(0,Math.min(links.length-1,index+(event.key==='ArrowDown'?1:-1)))].focus();}
  };
  const outside=event=>{if(event.target!==dialog)return false;const rect=dialog.getBoundingClientRect();return event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom;};
  const pointerdown=event=>{backdropDown=outside(event);},backdrop=event=>{if(backdropDown&&outside(event))close();backdropDown=false;};
  const cancel=event=>{event.preventDefault();close();},nativeClose=()=>{if(opened)close();};
  const focusin=event=>{if(opened&&!dialog.contains(event.target))input.focus({preventScroll:true});};
  // The read-only header field is itself a trigger: "/" works there too, so the
  // search reopens after Escape returned focus to it.
  const editable=target=>{const field=target?.closest?.('input,textarea,select,[contenteditable=true]');return field&&!triggers.has(field)?field:null;};
  const shortcut=event=>{if(event.defaultPrevented||event.key!=='/'||event.ctrlKey||event.metaKey||event.altKey||document.querySelector('dialog[open]')||editable(event.target))return;event.preventDefault();void open(triggers.has(event.target)?event.target:undefined);};
  dialog.addEventListener('keydown',keydown);dialog.addEventListener('pointerdown',pointerdown);dialog.addEventListener('click',backdrop);dialog.addEventListener('cancel',cancel);dialog.addEventListener('close',nativeClose);document.addEventListener('focusin',focusin);
  const pointerMode=()=>{refocused=false;document.body.dataset.searchInputMode='pointer';};
  const keyboardMode=event=>{refocused=false;if(event.key==='Tab'||event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!editable(event.target))document.body.dataset.searchInputMode='keyboard';};
  // Leaving the tab or window while a trigger keeps focus: the browser focuses
  // it again on return, which must not reopen the search.
  const away=()=>{refocused=!opened&&triggers.has(document.activeElement);},hidden=()=>{if(document.hidden)away();};
  document.addEventListener('pointerdown',pointerMode,true);document.addEventListener('keydown',keyboardMode,true);
  document.addEventListener('keydown',shortcut);document.addEventListener('visibilitychange',hidden);window.addEventListener?.('blur',away);
  for(const kind of Object.keys(names))render(kind);
  const app={open,close,search,select,bindTrigger,isOpen:()=>opened,destroy(){close();disposed=true;for(const [trigger,handlers]of triggers){trigger.removeEventListener('focus',handlers.focus);trigger.removeEventListener('click',handlers.activate);trigger.removeEventListener('keydown',handlers.key);}triggers.clear();dialog.removeEventListener('keydown',keydown);dialog.removeEventListener('pointerdown',pointerdown);dialog.removeEventListener('click',backdrop);dialog.removeEventListener('cancel',cancel);dialog.removeEventListener('close',nativeClose);document.removeEventListener('focusin',focusin);document.removeEventListener('keydown',shortcut);document.removeEventListener('visibilitychange',hidden);window.removeEventListener?.('blur',away);document.removeEventListener('pointerdown',pointerMode,true);document.removeEventListener('keydown',keyboardMode,true);if(controllers.get(document)===app)controllers.delete(document);}};
  controllers.set(document,app);for(const trigger of document.querySelectorAll('[data-curve-search-trigger]'))bindTrigger(trigger);return app;
}
