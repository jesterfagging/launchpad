import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createPublicNavigation,publicRoute} from '../public/navigation.mjs';
const base='https://launchpad.test/';
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function html(page){const source=['docs','terms','privacy'].includes(page)?'documentation':page;return `<!doctype html><html><head><title>${page} — Launchpad</title><script type="module" src="/${source}.js"></script></head><body class="${page}-page" data-page="${page}"><header class="app-header">header</header><main id="${page}-main"><h1>${page}</h1><a href="/launchpad">Create</a></main><footer>footer</footer></body></html>`;}
function fixture(t,{respond,importer,cacheLimit=8,warmDelayMs,connection}={}){
  const {document,window}=parseHTML(html('explore'));document.querySelector('footer').className='site-footer';
  if(connection!==undefined)Object.defineProperty(window,'navigator',{value:{connection},configurable:true});
  if(warmDelayMs!==undefined)window.requestIdleCallback=fn=>{fn();return 1;};
  const search=document.createElement('dialog');search.id='explore-search-dialog';document.body.append(search);
  const rows=[{url:base,state:null}],fallbacks=[],calls=[],mounts=[],destroyed=[],scrolls=[];let cursor=0,allow=true;
  const location={get href(){return rows[cursor].url;},get origin(){return new URL(this.href).origin;},get pathname(){return new URL(this.href).pathname;},get search(){return new URL(this.href).search;}};
  const history={get state(){return rows[cursor].state;},replaceState(state,_,url){rows[cursor]={state,url:new URL(url,location.href).href};},pushState(state,_,url){rows.splice(cursor+1);rows.push({state,url:new URL(url,location.href).href});cursor++;},go(delta){cursor+=delta;assert(cursor>=0&&cursor<rows.length);const event=new window.Event('popstate');event.state=rows[cursor].state;window.dispatchEvent(event);}};
  Object.defineProperty(window,'location',{value:location,configurable:true});Object.defineProperty(window,'history',{value:history,configurable:true});
  window.scrollTo=(...position)=>scrolls.push(position);
  const mount=name=>()=>{mounts.push(name);return {canLeave:()=>allow,destroy(){destroyed.push(name);}};};
  const router=createPublicNavigation({document,window,cacheLimit,warmDelayMs,fallback:url=>fallbacks.push(url),fetcher:async(path,options)=>{calls.push({path,options});const result=await respond?.(path,options);if(result)return result;const page=publicRoute(path,base).page;return {ok:true,headers:new Headers({'content-type':'text/html'}),text:async()=>html(page)};},importer:importer|| (async path=>({mountPage:mount(path)}))});
  router.start(mount('initial'));t.after(()=>router.destroy());
  return {router,document,window,location,history,rows,calls,mounts,destroyed,search,scrolls,fallbacks,setAllow:value=>{allow=value;}};
}
test('public routing is an exact same-origin allowlist; private APIs, auth and administrator URLs stay native',()=>{
  for(const route of ['/','/explore?q=a','/launchpad','/coin?mint=abc','/user/sunrise','/creator?username=sunrise','/analytics','/docs#revenue','/terms','/privacy','/launched-tokens','/launched-tokens?id=abc','/launched-tokens?view=archived'])assert(publicRoute(route,base),route);
  for(const route of ['/admin','/api/session','/wallet-account','/launchpad?admin=1','/?signin=1','/?account=overview','/?tool=trade','/?token=abc','/coin/extra','/user/no','https://elsewhere.test/','javascript:alert(1)','//user:password@launchpad.test/'])assert.equal(publicRoute(route,base),null,route);
});
test('same-document routes retain header/search/footer and mount/destroy exactly once per visit',async t=>{
  const h=fixture(t),header=h.document.querySelector('header'),footer=h.document.querySelector('footer');
  await h.router.navigate('/launchpad');await h.router.navigate('/');await h.router.navigate('/launchpad');
  assert.equal(h.document.querySelector('header'),header);assert.equal(h.document.querySelector('footer'),footer);assert.equal(h.document.getElementById('explore-search-dialog'),h.search);
  assert.equal(h.document.querySelectorAll('main').length,1);assert.equal(h.document.querySelector('main').id,'launchpad-main');assert.equal(h.location.pathname,'/launchpad');
  assert.deepEqual(h.mounts,['initial','/launchpad.js','/explore.js','/launchpad.js']);assert.deepEqual(h.destroyed,['initial','/launchpad.js','/explore.js']);
  assert.equal(h.calls.filter(call=>call.path==='/launchpad').length,1);
  assert(h.calls.every(call=>call.options.credentials==='omit'&&call.options.cache==='no-store'&&call.options.redirect==='error'&&!call.path.startsWith('/api/')));
});
test('repeated Home clicks and the /explore alias retain the rendered page without fetching or remounting',async t=>{
  const h=fixture(t),main=h.document.querySelector('main'),header=h.document.querySelector('header');
  for(const href of ['/','/explore','/','/explore']){
    const link=h.document.createElement('a');link.href=href;header.append(link);
    const event=new h.window.Event('click',{bubbles:true,cancelable:true});event.button=0;link.dispatchEvent(event);await flush();
    assert.equal(event.defaultPrevented,true);assert.equal(h.document.querySelector('main'),main);
  }
  assert.deepEqual(h.mounts,['initial']);assert.deepEqual(h.destroyed,[]);assert.equal(h.calls.length,0);assert.equal(h.rows.length,1);assert.deepEqual(h.fallbacks,[]);
});
test('Home cancels an unfinished route switch and keeps the current content when its late response arrives',async t=>{
  const slow=deferred(),h=fixture(t,{respond:path=>path==='/launchpad'?slow.promise:undefined}),main=h.document.querySelector('main');
  const switching=h.router.navigate('/launchpad');await h.router.navigate('/');
  slow.resolve({ok:true,headers:new Headers({'content-type':'text/html'}),text:async()=>html('launchpad')});assert.equal(await switching,false);
  assert.equal(h.location.pathname,'/');assert.equal(h.document.querySelector('main'),main);assert.deepEqual(h.mounts,['initial']);assert.deepEqual(h.destroyed,[]);assert.equal(h.document.querySelector('.navigation-progress').hidden,true);
});
test('prefetch imports code without mounting or reading account APIs; bounded cache refetches evicted templates',async t=>{
  const h=fixture(t,{cacheLimit:2});await h.router.prefetch('/launchpad');await h.router.prefetch('/coin?mint=one');await h.router.prefetch('/creator?username=example');await h.router.prefetch('/launchpad');
  assert.deepEqual(h.mounts,['initial']);assert.deepEqual(h.destroyed,[]);assert.equal(h.location.pathname,'/');assert.equal(h.calls.filter(call=>call.path==='/launchpad').length,2);
  await h.router.prefetch('/admin');assert(!h.calls.some(call=>call.path==='/admin'));
});
test('rapid navigation discards late templates and never mounts the abandoned page',async t=>{
  const slow=deferred(),h=fixture(t,{respond:path=>path==='/launchpad'?slow.promise:undefined});
  const old=h.router.navigate('/launchpad');await h.router.navigate('/docs');slow.resolve({ok:true,headers:new Headers({'content-type':'text/html'}),text:async()=>html('launchpad')});await old;
  assert.equal(h.location.pathname,'/docs');assert.deepEqual(h.mounts,['initial','/documentation.js']);assert.deepEqual(h.destroyed,['initial']);
});
test('wallet/launch guard is checked before fetch and again before replacing a page',async t=>{
  const slow=deferred(),h=fixture(t,{respond:path=>path==='/launchpad'?slow.promise:undefined});
  h.setAllow(false);assert.equal(await h.router.navigate('/coin?mint=a'),false);assert.equal(h.calls.length,0);
  h.setAllow(true);const pending=h.router.navigate('/launchpad');h.setAllow(false);slow.resolve({ok:true,headers:new Headers({'content-type':'text/html'}),text:async()=>html('launchpad')});assert.equal(await pending,false);
  assert.equal(h.location.pathname,'/');assert.deepEqual(h.destroyed,[]);assert.deepEqual(h.fallbacks,[]);assert.match(h.document.querySelector('.navigation-notice').textContent,/Finish or cancel/);
});
test('back/forward remount pages and preserve route history; blocked back restores current entry',async t=>{
  const h=fixture(t);await h.router.navigate('/launchpad');await h.router.navigate('/docs');
  h.history.go(-1);await flush();await flush();assert.equal(h.location.pathname,'/launchpad');assert.equal(h.document.querySelector('main').id,'launchpad-main');
  h.history.go(1);await flush();await flush();assert.equal(h.document.querySelector('main').id,'docs-main');
  h.setAllow(false);h.history.go(-1);await flush();assert.equal(h.location.pathname,'/docs');assert.equal(h.document.querySelector('main').id,'docs-main');
});
test('modified, download, external and new-tab clicks are not intercepted',async t=>{
  const h=fixture(t);for(const values of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{button:1},{target:'_blank'},{download:'test'},{href:'https://other.test/'}]){
    const link=h.document.createElement('a');link.href=values.href||'/launchpad';if(values.target)link.target=values.target;if(values.download)link.setAttribute('download',values.download);h.document.querySelector('main').append(link);
    const event=new h.window.Event('click',{bubbles:true,cancelable:true});Object.assign(event,{button:0,...values});link.dispatchEvent(event);assert.equal(event.defaultPrevented,false);link.remove();
  }
  assert.equal(h.calls.length,0);
});
test('fetch, invalid HTML or lifecycle failures fall back to ordinary page navigation',async t=>{
  for(const respond of [async()=>{throw Error('offline');},async()=>({ok:true,headers:new Headers({'content-type':'text/html'}),text:async()=>'<html>bad</html>'})]){
    const h=fixture(t,{respond});await h.router.navigate('/launchpad');assert.deepEqual(h.fallbacks,[base+'launchpad']);assert.deepEqual(h.destroyed,[]);
  }
});
test('destroy cancels pending work and leaves late results inert',async t=>{
  const slow=deferred(),h=fixture(t,{respond:()=>slow.promise});const pending=h.router.navigate('/launchpad');h.router.destroy();slow.resolve({ok:true,headers:new Headers({'content-type':'text/html'}),text:async()=>html('launchpad')});await pending;
  assert.equal(h.calls[0].options.signal.aborted,true);assert.deepEqual(h.mounts,['initial']);assert.deepEqual(h.fallbacks,[]);
});

test('My Tokens, its detail links and browser back retain the shell and cache only the inert HTML',async t=>{
  const h=fixture(t),header=h.document.querySelector('header'),footer=h.document.querySelector('footer');
  await h.router.prefetch('/launched-tokens');assert.deepEqual(h.mounts,['initial']);
  for(const route of ['/launched-tokens','/launched-tokens?id='+'a'.repeat(32),'/launched-tokens?view=archived','/'])assert.equal(await h.router.navigate(route),true);
  h.history.go(-1);await flush();await flush();
  assert.equal(h.location.pathname,'/launched-tokens');assert.equal(h.location.search,'?view=archived');
  assert.equal(h.document.querySelector('header'),header);assert.equal(h.document.querySelector('footer'),footer);assert.equal(h.document.getElementById('explore-search-dialog'),h.search);
  assert.deepEqual(h.mounts,['initial','/launched-tokens.js','/launched-tokens.js','/launched-tokens.js','/explore.js','/launched-tokens.js']);
  const requests=h.calls.filter(call=>call.path==='/launched-tokens');assert.equal(requests.length,1);assert.equal(requests[0].options.credentials,'omit');assert.equal(requests[0].options.cache,'no-store');assert(!h.calls.some(call=>call.path.startsWith('/api/')));assert.deepEqual(h.fallbacks,[]);
});

test('an idle dialog never holds navigation: its links close it, Back works and reload is not held; a busy dialog still blocks until it closes',async t=>{
  const h=fixture(t),notice=h.document.querySelector('.navigation-notice');
  const idle=h.document.createElement('dialog');idle.setAttribute('open','');idle.setAttribute('data-navigation-free','');let closed=0;
  idle.close=function(){closed++;this.removeAttribute('open');this.dispatchEvent(new h.window.Event('close'));};
  const terms=h.document.createElement('a');terms.href=base+'terms';idle.append(terms);h.document.body.append(idle);
  const click=new h.window.Event('click',{bubbles:true,cancelable:true});click.button=0;terms.dispatchEvent(click);await flush();await flush();
  assert.equal(click.defaultPrevented,true);assert.equal(h.location.pathname,'/terms');assert.equal(h.document.querySelector('main').id,'terms-main');assert.equal(closed,1);assert.equal(idle.hasAttribute('open'),false);assert.equal(notice.hidden,true);
  idle.setAttribute('open','');const reload=new h.window.Event('beforeunload',{cancelable:true});h.window.dispatchEvent(reload);assert.equal(reload.defaultPrevented,false,'no "Leave site?" prompt for an idle dialog');
  h.history.go(-1);await flush();await flush();assert.equal(h.location.pathname,'/');assert.equal(h.document.querySelector('main').id,'explore-main');assert.equal(idle.hasAttribute('open'),false);assert.equal(closed,2);
  // A dialog without the marker (a wallet approval or launch in progress) keeps today's protection.
  const busy=h.document.createElement('dialog');busy.setAttribute('open','');h.document.body.append(busy);
  assert.equal(await h.router.navigate('/docs'),false);assert.equal(h.location.pathname,'/');assert.match(notice.textContent,/Finish or cancel/);assert.equal(notice.hidden,false);
  const held=new h.window.Event('beforeunload',{cancelable:true});h.window.dispatchEvent(held);assert.equal(held.defaultPrevented,true);
  busy.removeAttribute('open');busy.dispatchEvent(new h.window.Event('close'));assert.equal(notice.hidden,true,'closing the dialog clears the stale notice');
  assert.equal(await h.router.navigate('/docs'),true);assert.equal(h.location.pathname,'/docs');
});

test('the background warm-up waits for an idle page and never runs on a metered or slow connection; pointing at a link still prepares it',async t=>{
  for(const connection of [{saveData:true},{effectiveType:'2g'}]){
    const metered=fixture(t,{warmDelayMs:0,connection}),link=metered.document.createElement('a');link.href=base+'docs';metered.document.querySelector('main').append(link);await new Promise(resolve=>setTimeout(resolve,20));
    link.dispatchEvent(new metered.window.Event('pointerover',{bubbles:true}));await flush();assert.equal(metered.calls.length,0,JSON.stringify(connection));
  }
  const delayed=fixture(t);await flush();assert.equal(delayed.calls.length,0,'nothing is fetched while the first page loads');
  const h=fixture(t,{warmDelayMs:0,connection:{effectiveType:'4g'}});await new Promise(resolve=>setTimeout(resolve,20));await flush();
  assert.deepEqual(h.calls.map(call=>call.path),['/launchpad']);assert.deepEqual(h.mounts,['initial']);
  const docs=h.document.createElement('a');docs.href=base+'docs';h.document.querySelector('main').append(docs);docs.dispatchEvent(new h.window.Event('pointerover',{bubbles:true}));await flush();
  assert.deepEqual(h.calls.map(call=>call.path),['/launchpad','/docs']);assert.deepEqual(h.mounts,['initial']);
});
