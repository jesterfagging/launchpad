// The router stores public, inert page templates only. Account/API responses,
// reviewed transactions and mounted page state never enter the template cache.
const routers=new WeakMap();
const entries={'launched-tokens':['/launched-tokens','/launched-tokens.js'],explore:['/','/explore.js'],launchpad:['/launchpad','/launchpad.js'],coin:['/coin','/coin.js'],creator:['/creator','/creator.js'],gotchi:['/gotchi','/gotchi.js'],agents:['/agents','/agents.js'],analytics:['/analytics','/analytics.js'],docs:['/docs','/documentation.js'],terms:['/terms','/documentation.js'],privacy:['/privacy','/documentation.js']};
const preserved=node=>node.matches?.('.app-header,.site-footer,.skip-link,#explore-search-dialog,[data-navigation-persistent]');
// The background warm-up waits until the first page's own requests have settled.
const WARM_DELAY_MS=2500;
export function publicRoute(value,base='https://launchpad.invalid/'){
  let url;try{url=new URL(value,base);}catch{return null;}
  if(url.origin!==new URL(base).origin||!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
  const path=url.pathname;let page=path==='/'||path==='/explore'?'explore':/^\/user\/[a-z0-9_][a-z0-9_-]{2,31}\/?$/i.test(path)?'creator':Object.keys(entries).find(key=>entries[key][0]===path);
  if(!page||['signin','account','tool','token'].some(key=>url.searchParams.has(key))||page==='launchpad'&&url.searchParams.has('admin'))return null;
  return {page,url,template:entries[page][0],module:entries[page][1]};
}
function samePage(route,current){return route?.page===current?.page&&route.url.search===current.url.search&&(route.url.pathname===current.url.pathname||route.page==='explore');}
export function createPublicNavigation({document,window,fetcher=globalThis.fetch,importer=path=>import(path),clock=Date.now,cacheLimit=8,cacheMs=300000,warmDelayMs=WARM_DELAY_MS,fallback=url=>window.location.assign(url)}={}){
  let current=null,routeNodes=[],disposed=false,sequence=0,started=false,currentUrl=window.location.href,index=0,restorePop=false,warmTimer=null,warmIdle=null;
  const templates=new Map(),pending=new Map(),controllers=new Set(),watchedDialogs=new WeakSet();
  const headStyles=new Set([...document.querySelectorAll('link[rel="stylesheet"]')].map(link=>new URL(link.href,window.location.href).pathname));
  const initial=publicRoute(currentUrl,window.location.href);
  if(!initial)return null;
  const style=document.createElement('link');style.rel='stylesheet';style.href='/navigation.css';style.dataset.navigationPersistent='true';document.head.append(style);
  const notice=document.createElement('p');notice.className='navigation-notice';notice.setAttribute('role','status');notice.hidden=true;notice.dataset.navigationPersistent='true';document.body.append(notice);
  const progress=document.createElement('div');progress.className='navigation-progress';progress.hidden=true;progress.setAttribute('aria-hidden','true');progress.dataset.navigationPersistent='true';document.body.append(progress);
  function status(text=''){
    notice.textContent=text;notice.hidden=!text;
    // Above an open modal dialog the notice joins the top layer so it stays readable.
    try{
      if(text&&typeof notice.showPopover==='function'&&document.querySelector('dialog:modal')){if(!notice.hasAttribute('popover'))notice.setAttribute('popover','manual');if(!notice.matches(':popover-open'))notice.showPopover();}
      else if(notice.hasAttribute('popover')){if(notice.matches(':popover-open'))notice.hidePopover();notice.removeAttribute('popover');}
    }catch{}
  }
  // An open dialog holds the page while it may be running a wallet, launch or
  // trade action. A dialog that is idle opts out with data-navigation-free:
  // links inside it close it and navigate, and Back and reload are not held.
  const blockingDialog=()=>document.querySelector('dialog[open]:not(#explore-search-dialog):not([data-navigation-free])');
  function permitted(){return current?.canLeave?.()!==false&&!blockingDialog();}
  function closeIdle(dialog){try{if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');}catch{}}
  function closeIdleDialogs(){for(const dialog of document.querySelectorAll('dialog[open][data-navigation-free]'))if(dialog.id!=='explore-search-dialog')closeIdle(dialog);}
  // The notice is about the open dialog: it goes away when that dialog closes.
  function refuse(){
    status('Finish or cancel the current wallet or launch action before changing pages.');
    const dialog=blockingDialog();if(dialog&&!watchedDialogs.has(dialog)){watchedDialogs.add(dialog);dialog.addEventListener('close',()=>{watchedDialogs.delete(dialog);if(!disposed&&!notice.hidden)status();},{once:true});}
  }
  // Metered or slow connections never warm pages in the background.
  function frugal(){const connection=window.navigator?.connection;return connection?.saveData===true||['slow-2g','2g','3g'].includes(connection?.effectiveType);}
  function restoreHistory(state){const target=state?.curveNavigation?.index;if(Number.isInteger(target)&&target!==index){restorePop=true;window.history.go(index-target);}else window.history.replaceState({curveNavigation:{index}},'',currentUrl);}
  function rememberScroll(){window.history.replaceState({...window.history.state,curveNavigation:{index,x:window.scrollX||0,y:window.scrollY||0}},'',window.location.href);}
  function routeStyles(parsed){
    const loads=[];
    for(const source of parsed.querySelectorAll('link[rel="stylesheet"]')){
      const url=new URL(source.getAttribute('href'),window.location.href);
      if(url.origin!==window.location.origin||!/^\/[a-z0-9-]+\.css$/i.test(url.pathname))throw Error('Invalid page stylesheet');
      if(headStyles.has(url.pathname))continue;
      headStyles.add(url.pathname);const link=document.createElement('link');link.rel='stylesheet';link.href=url.pathname+url.search;
      loads.push(new Promise((resolve,reject)=>{const timeout=window.setTimeout(()=>{headStyles.delete(url.pathname);link.remove();reject(Error('Page styles timed out'));},10000);link.onload=()=>{window.clearTimeout(timeout);resolve();};link.onerror=()=>{window.clearTimeout(timeout);headStyles.delete(url.pathname);link.remove();reject(Error('Page styles unavailable'));};}));
      const theme=document.querySelector('link[href*="/curve-theme.css"]');if(theme)theme.before(link);else document.head.append(link);
    }
    return Promise.all(loads);
  }
  function parse(html,route){
    if(typeof html!=='string'||html.length>512000)throw Error('Invalid page template');
    const parsed=new window.DOMParser().parseFromString(html,'text/html');
    if(parsed.querySelectorAll('main').length!==1||!parsed.querySelector('.app-header')||!parsed.querySelector(`script[src^="${route.module}"]`))throw Error('Page template did not match');
    return parsed;
  }
  async function prepare(route){
    const cached=templates.get(route.page);if(cached&&clock()-cached.at<cacheMs){templates.delete(route.page);templates.set(route.page,cached);return cached;}
    if(pending.has(route.page))return pending.get(route.page);
    const controller=new AbortController();controllers.add(controller);const timeout=window.setTimeout(()=>controller.abort(),15000);
    const operation=(async()=>{
      const response=await fetcher(route.template,{method:'GET',credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal,headers:{Accept:'text/html'}});
      if(!response.ok||!String(response.headers.get('content-type')||'').startsWith('text/html'))throw Error('Page unavailable');
      const html=await response.text(),parsed=parse(html,route);
      const [module]=await Promise.all([importer(route.module),routeStyles(parsed)]);
      if(typeof module.mountPage!=='function')throw Error('Page lifecycle unavailable');
      const value={html,module,at:clock()};if(!disposed){templates.set(route.page,value);while(templates.size>cacheLimit)templates.delete(templates.keys().next().value);}return value;
    })().finally(()=>{window.clearTimeout(timeout);controllers.delete(controller);pending.delete(route.page);});
    pending.set(route.page,operation);return operation;
  }
  function closeSearch(){document.getElementById('explore-search-close')?.click();}
  // Page transitions (decorative, curve-theme.css): the leaving page fades out while the next template is
  // prepared (never delaying a cached switch), the arriving page fades in. Reduced motion and non-browser
  // hosts skip both.
  const animated=()=>{try{return typeof window.matchMedia==='function'&&typeof window.requestAnimationFrame==='function'&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches;}catch{return false;}};
  let enterTimer=null;
  function leaveMain(){if(!animated())return null;const main=document.querySelector('main');if(!main)return null;main.classList.add('curve-page-leave');return main;}
  function enterMain(){if(!animated())return;const main=document.querySelector('main');if(!main)return;window.clearTimeout(enterTimer);main.classList.add('curve-page-enter');const done=()=>{main.classList.remove('curve-page-enter');main.removeEventListener('animationend',done);};main.addEventListener('animationend',done);enterTimer=window.setTimeout(done,600);}
  function adopt(parsed,route){
    for(const node of routeNodes)node.remove();
    const fragment=document.createDocumentFragment();routeNodes=[];
    for(const node of [...parsed.body.children]){
      if(node.matches('.app-header,footer,script,.skip-link'))continue;
      // Parsed scripts remain inert, and no executable page content is imported.
      for(const script of node.querySelectorAll('script'))script.remove();
      const copy=document.importNode(node,true);fragment.append(copy);routeNodes.push(copy);
    }
    const footer=document.querySelector('.site-footer');if(footer)footer.before(fragment);else document.body.append(fragment);
    document.body.className=parsed.body.className;
    for(const key of Object.keys(document.body.dataset))if(!['shell','navigation','toolkit'].includes(key))delete document.body.dataset[key];
    for(const [key,value]of Object.entries(parsed.body.dataset))if(!['shell','navigation','toolkit'].includes(key))document.body.dataset[key]=value;
    document.body.dataset.page=route.page;document.title=parsed.title;
    const description=parsed.querySelector('meta[name="description"]');let currentDescription=document.querySelector('meta[name="description"]');
    if(description){if(!currentDescription){currentDescription=document.createElement('meta');currentDescription.name='description';document.head.append(currentDescription);}currentDescription.content=description.content;}else currentDescription?.remove();
    document.querySelector('.relay-toolkit')?.removeAttribute('open');
    for(const link of document.querySelectorAll('.top-launch,.gotchi-nav,.agents-nav,.site-footer-links a')){if(new URL(link.href,window.location.href).pathname===route.url.pathname)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
    const main=document.querySelector('main');if(main){main.id||='workspace-content';main.tabIndex=-1;const skip=document.querySelector('.skip-link');if(skip)skip.href='#'+main.id;}
  }
  function scrollToRoute(route,restore){
    if(restore){window.scrollTo?.(restore.x||0,restore.y||0);return;}
    let target;try{target=route.url.hash&&document.getElementById(decodeURIComponent(route.url.hash.slice(1)));}catch{}
    if(target)target.scrollIntoView?.();else window.scrollTo?.(0,0);
    (target||document.querySelector('main:not([hidden])')||document.querySelector('h1'))?.focus?.({preventScroll:true});
  }
  async function navigate(value,{pop=false,state=null}={}){
    const route=publicRoute(value,window.location.href);if(!route||disposed)return false;
    // Home is also reachable through /explore. Staying on the current page
    // retains its content and cancels any slower, earlier navigation intent.
    if(!pop&&!route.url.hash&&samePage(route,publicRoute(window.location.href,window.location.href))){sequence++;progress.hidden=true;status();closeSearch();closeIdleDialogs();return true;}
    if(!permitted()){refuse();return false;}
    closeIdleDialogs();
    const turn=++sequence;status();progress.hidden=false;
    const leaving=leaveMain();let swapped=false;
    try{
      const entry=await prepare(route);if(disposed||turn!==sequence)return false;
      // A wallet action may have begun while the template was loading.
      if(!permitted()){refuse();if(pop)restoreHistory(state);return false;}
      const parsed=parse(entry.html,route);closeSearch();
      if(!pop)rememberScroll();current?.destroy?.();current=null;
      document.dispatchEvent(new window.CustomEvent('curve-navigation-start',{detail:{page:route.page}}));
      if(pop){index=Number.isInteger(state?.curveNavigation?.index)?state.curveNavigation.index:index;}
      else{index++;window.history.pushState({curveNavigation:{index,x:0,y:0}},'',route.url.href);}
      currentUrl=route.url.href;adopt(parsed,route);swapped=true;
      current=entry.module.mountPage({document,window});
      if(!current||typeof current.destroy!=='function')throw Error('Page lifecycle unavailable');
      scrollToRoute(route,pop?state?.curveNavigation:null);enterMain();
      document.dispatchEvent(new window.CustomEvent('curve-navigation-complete',{detail:{page:route.page}}));
      return true;
    }catch(error){if(!disposed&&turn===sequence){if(permitted())fallback(route.url.href);else{refuse();if(pop)restoreHistory(state);}}return false;}
    finally{if(turn===sequence){progress.hidden=true;if(!swapped)leaving?.classList.remove('curve-page-leave');}}
  }
  function clicked(event){
    if(event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    const link=event.target.closest?.('a[href]');if(!link||link.hasAttribute('download')||link.target&&link.target!=='_self'||link.hasAttribute('data-no-router'))return;
    const route=publicRoute(link.href,window.location.href);if(!route)return;
    if(samePage(route,publicRoute(window.location.href,window.location.href))&&route.url.hash){const owner=link.closest('dialog[open][data-navigation-free]');if(owner&&owner.id!=='explore-search-dialog')closeIdle(owner);return;}
    event.preventDefault();void navigate(route.url.href);
  }
  function intent(event){
    if(frugal())return;
    const link=event.target.closest?.('a[href]');if(!link||link.hasAttribute('download')||link.target&&link.target!=='_self')return;
    const route=publicRoute(link.href,window.location.href);if(route&&!samePage(route,publicRoute(window.location.href,window.location.href))&&!document.hidden)void prepare(route).catch(()=>{});
  }
  function popstate(event){
    if(restorePop){restorePop=false;return;}
    if(!permitted()){
      sequence++;progress.hidden=true;refuse();
      restoreHistory(event.state);
      return;
    }
    if(!publicRoute(window.location.href,window.location.href)){fallback(window.location.href);return;}
    void navigate(window.location.href,{pop:true,state:event.state});
  }
  function beforeUnload(event){if(!permitted()){event.preventDefault();event.returnValue='';}}
  function start(mount){
    if(started)return current;started=true;
    routeNodes=[...document.body.children].filter(node=>!preserved(node)&&node.tagName!=='FOOTER'&&node.tagName!=='SCRIPT');
    document.body.dataset.page=initial.page;
    window.history.replaceState({...window.history.state,curveNavigation:{index,x:window.scrollX||0,y:window.scrollY||0}},'',window.location.href);
    current=mount({document,window});
    document.addEventListener('click',clicked);document.addEventListener('pointerover',intent);document.addEventListener('focusin',intent);window.addEventListener('popstate',popstate);window.addEventListener('beforeunload',beforeUnload);
    // Warm the most common switch with inert HTML, styles and code only, once the
    // page has settled and is idle. Hovering or focusing any page link (above)
    // still prepares that page on demand.
    warmTimer=window.setTimeout(()=>{
      warmTimer=null;
      const warm=()=>{warmIdle=null;if(disposed||document.hidden||frugal())return;void prepare(publicRoute(document.body.dataset.page==='launchpad'?'/':'/launchpad',window.location.href)).catch(()=>{});};
      if(typeof window.requestIdleCallback==='function')warmIdle=window.requestIdleCallback(warm,{timeout:5000});else warm();
    },warmDelayMs);
    return current;
  }
  function destroy(){disposed=true;sequence++;window.clearTimeout(warmTimer);window.clearTimeout(enterTimer);if(warmIdle!==null)window.cancelIdleCallback?.(warmIdle);for(const controller of controllers)controller.abort();templates.clear();current?.destroy?.();document.removeEventListener('click',clicked);document.removeEventListener('pointerover',intent);document.removeEventListener('focusin',intent);window.removeEventListener('popstate',popstate);window.removeEventListener('beforeunload',beforeUnload);status();notice.remove();progress.remove();if(routers.get(document)===api)routers.delete(document);}
  const api={start,navigate,prefetch:value=>{const route=publicRoute(value,window.location.href);return route?prepare(route):Promise.resolve(null);},destroy,get current(){return current;}};
  return api;
}
export function bootPage(page,mount){
  if(typeof document==='undefined'||!document.defaultView||routers.has(document))return;
  const route=publicRoute(document.defaultView.location.href,document.defaultView.location.href);
  // Account bookmarks and administrator launch URLs retain their ordinary
  // entry-point behavior; they are deliberately excluded from template caching.
  if(!route){const base=publicRoute(document.defaultView.location.pathname,document.defaultView.location.href);if(base?.page!==page)return;routers.set(document,{});const current=mount({document,window:document.defaultView});document.defaultView.addEventListener('pagehide',()=>current?.destroy?.(),{once:true});return;}
  if(route?.page!==page)return;
  const router=createPublicNavigation({document,window:document.defaultView});
  if(!router)return;
  routers.set(document,router);router.start(mount);
}
