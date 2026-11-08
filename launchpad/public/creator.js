import {coinImage} from './coin-image.mjs';
import {bootPage} from './navigation.mjs';
import {createWorkspaceShell} from './workspace-shell.js';
export function creatorUsername(href){
  try{const url=new URL(href),path=/^\/user\/([a-z0-9_][a-z0-9_-]{2,31})\/?$/i.exec(url.pathname),value=(path?.[1]||(url.pathname==='/creator'?url.searchParams.get('username'):'')||'').trim().toLowerCase();return /^[a-z0-9_][a-z0-9_-]{2,31}$/.test(value)?value:'';}catch{return '';}
}
// Refreshes disable and rebuild the page's controls, which drops keyboard focus
// to the page body. Remember the focused control and return to it (or to its
// rebuilt equivalent) afterwards.
function focusSnapshot(document,root){const node=document.activeElement;if(!node||node===document.body||!root.contains(node))return null;return {node,tag:node.tagName,href:node.getAttribute('href'),text:node.textContent,host:node.parentElement?.closest('[id]')?.id||''};}
function restoreFocus(document,root,state){
  if(!state)return;const active=document.activeElement;if(active&&active!==document.body&&active!==document.documentElement)return;
  let next=state.node.isConnected&&!state.node.disabled?state.node:null;
  if(!next){const host=(state.host&&root.querySelector('[id="'+state.host+'"]'))||root,candidates=[...host.querySelectorAll(state.tag)].filter(node=>!node.disabled);next=candidates.find(node=>node.getAttribute('href')===state.href&&node.textContent===state.text)||candidates.find(node=>state.href?node.getAttribute('href')===state.href:node.textContent===state.text)||null;}
  next?.focus?.({preventScroll:true});
}
export function createCreatorPage({document,window,fetcher=fetch,shell=createWorkspaceShell,setTimer=setInterval,clearTimer=clearInterval,requestTimeoutMs=15000,setRequestTimer=setTimeout,clearRequestTimer=clearTimeout}={}){
  const pageRoot=document.querySelector('main'),$=id=>pageRoot.querySelector('[id="'+id+'"]'),node=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
  const username=creatorUsername(window.location.href);let offset=0,busy=false,disposed=false,missing=false;const requests=new Set();
  const image=value=>typeof value==='string'&&/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(value);
  const money=value=>value==null||!Number.isFinite(Number(value))?'—':new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:2}).format(value);
  async function readJson(path){
    const controller=new AbortController();requests.add(controller);
    let onAbort;
    const aborted=new Promise((resolve,reject)=>{onAbort=()=>reject(controller.signal.reason||Error('Request cancelled.'));controller.signal.addEventListener('abort',onAbort,{once:true});});
    const timeout=setRequestTimer(()=>controller.abort(Error('Creator data is taking longer than usual. Try Refresh.')),requestTimeoutMs);
    try{
      return await Promise.race([aborted,(async()=>{
        const response=await fetcher(path,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
        // Proxy outages answer with an HTML page: show readable text, never a parser error.
        const data=await response.json().catch(()=>null);
        return {response,data};
      })()]);
    }finally{clearRequestTimer(timeout);controller.signal.removeEventListener('abort',onAbort);requests.delete(controller);}
  }
  // An unknown creator is final: show it plainly and stop polling for it.
  function notFound(text){
    missing=true;$('creator-name').textContent='Creator not found';document.title='Creator not found — Launchpad';if($('creator-initial'))$('creator-initial').textContent='?';
    $('creator-bio').textContent='';$('creator-picture').hidden=true;$('creator-count').textContent='';$('creator-coins').replaceChildren();$('creator-pages').replaceChildren();
    $('creator-error').textContent=text;$('creator-error').hidden=false;
  }
  async function load(requestedOffset=offset){
    if(busy||disposed)return;
    if(!username){notFound('Choose a user from search to open their public profile.');return;}
    busy=true;const focus=focusSnapshot(document,pageRoot);$('creator-refresh').disabled=true;
    const previousButtons=[...$('creator-pages').querySelectorAll('button')].map(button=>[button,button.disabled]);
    for(const [button]of previousButtons)button.disabled=true;
    try{
      const {response,data}=await readJson('/api/explore/creator?'+new URLSearchParams({username,offset:requestedOffset}));
      if(disposed)return;
      if(response.status===404){notFound('No Launchpad creator uses this username. Check the spelling, or search for the creator by name.');return;}
      if(!response.ok||!data?.profile||!Array.isArray(data.coins))throw Error(typeof data?.error==='string'&&data.error?data.error:'Creator data is temporarily unavailable. Try Refresh in a moment.');
      missing=false;$('creator-name').textContent=data.profile.username;document.title=data.profile.username+' — Launchpad';if($('creator-initial'))$('creator-initial').textContent=String(data.profile.username||'?').slice(0,1).toUpperCase();$('creator-bio').textContent=data.profile.bio||'';$('creator-picture').hidden=!image(data.profile.avatar);if(image(data.profile.avatar))$('creator-picture').src=data.profile.avatar;$('creator-count').textContent=String(data.total);
      const root=$('creator-coins');root.replaceChildren();
      for(const coin of data.coins){
        if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(coin.mint))continue;
        const card=node('a',null,'creator-coin');card.href='/coin?mint='+encodeURIComponent(coin.mint);card.dataset.motionReveal='';card.dataset.motionSpotlight='';const media=node('span',null,'creator-coin-media'),source=coinImage(coin.mint,coin.image);media.append(node('span',String(coin.symbol||'?').slice(0,6).toUpperCase(),'creator-coin-fallback'));if(source){const img=node('img');img.src=source;img.alt='';img.loading='lazy';img.onerror=()=>img.remove();media.append(img);}card.append(media);
        // Presentation: labelled stat rows and a bar of the current value against the tracked high.
        const useCap=coin.marketCapUsd!=null,current=useCap?coin.marketCapUsd:coin.fdvUsd,ath=useCap?coin.trackedAthMarketCapUsd:coin.trackedAthFdvUsd,body=node('span',null,'creator-coin-body'),stat=(label,value,cls)=>{const row=node('p',null,'creator-coin-stat'+(cls?' '+cls:''));row.append(node('span',label),node('strong',value));return row;};
        body.append(node('h3',coin.name),node('p','$'+coin.symbol,'creator-coin-symbol'),stat(useCap?'Market cap':'FDV',money(current)),stat('ATH (tracked)',money(ath),'is-ath'));
        if(Number.isFinite(Number(current))&&Number(ath)>0&&current!=null&&ath!=null){const bar=node('span',null,'creator-coin-ath');bar.setAttribute('aria-hidden','true');bar.style?.setProperty?.('--ath',String(Math.max(2,Math.min(100,Number(current)/Number(ath)*100))));bar.append(node('i'));body.append(bar);}
        card.append(body);if(coin.athTrackedSince)card.title='Highest observed since '+new Date(coin.athTrackedSince).toLocaleString();root.append(card);
      }
      if(!data.total)root.append(node('p','No launched coins yet.','creator-empty'));
      offset=requestedOffset;
      const pages=$('creator-pages');pages.replaceChildren();
      for(const [label,next,disabled]of [['Previous',Math.max(0,offset-24),offset===0],['Next',offset+24,offset+24>=data.total]]){
        const button=node('button',label,'small-button');button.type='button';button.disabled=disabled;button.onclick=()=>{if(busy||disposed||button.disabled)return;return load(next);};pages.append(button);
      }
      $('creator-error').hidden=true;
    }catch(error){if(disposed)return;$('creator-error').textContent=error.name==='AbortError'||error.name==='TimeoutError'?'Creator data is taking longer than usual. Try Refresh.':error.message;$('creator-error').hidden=false;}
    finally{busy=false;if(!disposed){$('creator-refresh').disabled=false;for(const [button,disabled]of previousButtons)button.disabled=disabled;restoreFocus(document,pageRoot,focus);}}
  }
  $('creator-refresh').onclick=()=>load();shell({page:'creator'});
  readJson('/api/session').then(({response,data:session})=>{if(!disposed&&response.ok&&session)shell({page:'creator',session});}).catch(()=>{});
  const ready=load(),timer=setTimer(()=>{if(!document.hidden&&!missing)void load();},30000);
  return {ready,refresh:()=>load(),destroy(){disposed=true;clearTimer(timer);for(const controller of requests)controller.abort();requests.clear();}};
}
export function mountPage({document=globalThis.document,window=document.defaultView}={}){return createCreatorPage({document,window});}
bootPage('creator',mountPage);
