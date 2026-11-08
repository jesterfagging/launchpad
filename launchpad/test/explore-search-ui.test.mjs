import {OFFICIAL_TOKEN_MINT} from '../public/coin-image.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {createExploreSearch,mountExploreHeaderSearch} from '../public/explore-search.mjs';
import {createWorkspaceShell} from '../public/workspace-shell.js';

const MINT='So11111111111111111111111111111111111111112';
const coin={mint:MINT,name:'Sunrise coin',symbol:'SUN',image:'/token-images/'+'a'.repeat(64)+'.png',marketCapUsd:25000,fdvUsd:50000};
const user={username:'sunrise',bio:'Ideas rise here',avatar:'/token-images/'+'b'.repeat(64)+'.png',launchCount:3};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,{respond,initialQuery='',page='explore',timeout=setTimeout,clear=clearTimeout}={}){
  const {document,window}=parseHTML(await readFile(new URL('../public/'+page+'.html',import.meta.url),'utf8')),calls=[],get=id=>document.getElementById(id);let focused=document.body;
  Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused});
  const original=window.HTMLElement.prototype.focus;window.HTMLElement.prototype.focus=function(){focused=this;this.dispatchEvent(new window.Event('focus'));this.dispatchEvent(new window.Event('focusin',{bubbles:true}));};
  const fetcher=async(path,options)=>{calls.push({path,options});const url=new URL(path,'https://launchpad.example'),kind=url.pathname==='/api/explore/users'?'users':'coins';const data=await respond?.(kind,url.searchParams,options)??{[kind]:[kind==='coins'?coin:user],total:1,nextOffset:null};return {ok:!data.error,status:data.error?503:200,json:async()=>data};};
  const app=createExploreSearch({document,window:{setTimeout:timeout,clearTimeout:clear},fetcher,initialQuery});
  const globals={document:globalThis.document,location:globalThis.location,requestAnimationFrame:globalThis.requestAnimationFrame};
  const shell=options=>{Object.assign(globalThis,{document,location:{href:'https://launchpad.example/'+(page==='explore'?'':page)},requestAnimationFrame:fn=>fn()});try{return createWorkspaceShell({page,...options});}finally{for(const [key,value]of Object.entries(globals))value===undefined?delete globalThis[key]:globalThis[key]=value;}};
  shell();const dialog=get('explore-search-dialog');Object.defineProperty(dialog,'open',{configurable:true,get:()=>dialog.hasAttribute('open')});dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>{dialog.removeAttribute('open');dialog.dispatchEvent(new window.Event('close'));};dialog.getBoundingClientRect=()=>({left:20,right:860,top:30,bottom:650});
  t.after(()=>{app.destroy();window.HTMLElement.prototype.focus=original;});
  const event=(target,type,props={})=>{const e=new window.Event(type,{bubbles:true,cancelable:true});for(const [key,value]of Object.entries(props))Object.defineProperty(e,key,{value});target.dispatchEvent(e);return e;};
  const key=(target,value,props={})=>{target.focus();return event(target,'keydown',{key:value,...props});};
  return {document,window,get,dialog,calls,app,event,key,shell,get focused(){return focused;}};
}

test('Coins and Users are only in a closed modal until the search bar is focused',async t=>{
  const ui=await fixture(t);assert.equal(ui.dialog.open,false);assert.equal(ui.get('explore-search-tabs').closest('dialog'),ui.dialog);assert.equal(ui.calls.length,0);assert.equal(ui.get('explore-search').getAttribute('aria-haspopup'),'dialog');
  assert.equal(ui.get('explore-search').closest('header'),ui.document.querySelector('.app-header'));assert.equal(ui.get('explore-main').querySelector('[data-curve-search-trigger]'),null);assert.equal(ui.document.querySelector('.explore-searchbox'),null);
  ui.get('explore-search').focus();assert.equal(ui.dialog.open,true);assert.equal(ui.focused,ui.get('explore-search-input'));assert.equal(ui.get('explore-search').getAttribute('aria-expanded'),'true');assert.equal(ui.document.body.classList.contains('explore-search-open'),true);assert.equal(ui.calls.length,0);
  await ui.app.search('sun');assert.equal(ui.calls.length,2);assert(ui.calls.every(call=>call.options.method==='GET'));assert.equal(ui.get('explore-search-coins-tab').getAttribute('aria-selected'),'true');assert.equal(ui.get('explore-search-users-panel').hidden,true);assert.equal(ui.get('explore-coins').hidden,false);
});

test('compact results use canonical coin and user links and honest market labels',async t=>{
  const ui=await fixture(t);await ui.app.open();await ui.app.search('sun');
  const coins=ui.get('explore-search-coins-results'),link=coins.querySelector('a');assert.equal(link.getAttribute('href'),'/coin?mint='+MINT);assert.match(link.textContent,/Sunrise coin/);assert.match(link.textContent,/\$SUN/);assert.match(link.textContent,/\$25KMarket cap/);assert.equal(link.querySelector('img').src,coin.image);
  await ui.app.select('users');const profile=ui.get('explore-search-users-results').querySelector('a');assert.equal(profile.getAttribute('href'),'/user/sunrise');assert.match(profile.textContent,/@sunrise/);assert.match(profile.textContent,/Ideas rise here/);assert.match(profile.textContent,/3launches/);assert.equal(ui.get('explore-search-users-count').textContent,'1');assert.equal(ui.event(profile,'click',{ctrlKey:true}).defaultPrevented,false);
});

test('tabs and result arrows work inside the focus trap and Escape returns focus without reopening',async t=>{
  const ui=await fixture(t);await ui.app.open();await ui.app.search('sun');const input=ui.get('explore-search-input'),coins=ui.get('explore-search-coins-tab'),users=ui.get('explore-search-users-tab');
  ui.key(coins,'ArrowRight');assert.equal(ui.focused,users);assert.equal(users.getAttribute('aria-selected'),'true');assert.equal(coins.getAttribute('tabindex'),'-1');assert.equal(ui.get('explore-search-users-panel').hidden,false);assert.equal(ui.get('explore-search-coins-panel').hidden,true);
  ui.key(users,'Home');assert.equal(ui.focused,coins);ui.key(coins,'End');assert.equal(ui.focused,users);
  const link=ui.get('explore-search-users-results').querySelector('a');ui.key(input,'ArrowDown');assert.equal(ui.focused,link);assert.equal(ui.key(link,'Enter').defaultPrevented,false);ui.key(link,'ArrowUp');assert.equal(ui.focused,input);
  assert.equal(ui.key(input,'Tab',{shiftKey:true}).defaultPrevented,true);assert.equal(ui.focused,link);assert.equal(ui.key(link,'Tab').defaultPrevented,true);assert.equal(ui.focused,input);
  ui.key(input,'Escape');assert.equal(ui.dialog.open,false);assert.equal(ui.focused,ui.get('explore-search'));assert.equal(ui.get('explore-search').getAttribute('aria-expanded'),'false');assert.equal(ui.document.body.classList.contains('explore-search-open'),false);
});

test('close button, cancel and real backdrop clicks close while inside clicks stay open',async t=>{
  const ui=await fixture(t);await ui.app.open();ui.event(ui.dialog,'pointerdown',{clientX:100,clientY:100});ui.event(ui.dialog,'click',{clientX:100,clientY:100});assert.equal(ui.dialog.open,true);
  ui.event(ui.dialog,'pointerdown',{clientX:0,clientY:0});ui.event(ui.dialog,'click',{clientX:0,clientY:0});assert.equal(ui.dialog.open,false);
  await ui.app.open();ui.get('explore-search-close').onclick();assert.equal(ui.dialog.open,false);
  await ui.app.open();assert.equal(ui.event(ui.dialog,'cancel').defaultPrevented,true);assert.equal(ui.dialog.open,false);
});

test('query responses cannot repopulate a closed modal or overwrite newer results',async t=>{
  const releases=new Map(),ui=await fixture(t,{respond:(kind,q)=>q.get('search')==='old'?new Promise(resolve=>releases.set(kind,()=>resolve({[kind]:[kind==='coins'?{...coin,name:'OLD RESULT'}:{...user,username:'old_user'}],total:99}))):{[kind]:[kind==='coins'?coin:user],total:1}});
  await ui.app.open();const old=ui.app.search('old');await flush();await ui.app.search('fresh');for(const release of releases.values())release();await old;assert.equal(ui.get('explore-search-users-count').textContent,'1');assert(!ui.dialog.textContent.includes('OLD RESULT'));assert(!ui.dialog.textContent.includes('old_user'));
  releases.clear();const waiting=ui.app.search('old');await flush();const signals=ui.calls.slice(-2).map(call=>call.options.signal);ui.app.close();assert(signals.every(signal=>signal.aborted));for(const release of releases.values())release();await waiting;assert.equal(ui.dialog.open,false);assert(!ui.dialog.textContent.includes('OLD RESULT'));
  const calls=ui.calls.length;await ui.app.search('offline');assert.equal(ui.calls.length,calls);await ui.app.open();assert.equal(ui.get('explore-search-users-count').textContent,'1');
});

test('coin and user pagination are independent and preserve query across tabs',async t=>{
  const ui=await fixture(t,{respond:(kind,q)=>({[kind]:[kind==='coins'?coin:{...user,username:Number(q.get('offset'))?'later_user':'sunrise'}],total:25,nextOffset:Number(q.get('offset'))+12<25?Number(q.get('offset'))+12:null})});
  await ui.app.open();await ui.app.search('sun');await ui.get('explore-search-coins-pages').querySelector('[aria-label="Next coins search page"]').onclick();assert.match(ui.get('explore-search-coins-pages').textContent,/Page 2 of 3/);
  await ui.app.select('users');assert.match(ui.get('explore-search-users-pages').textContent,/Page 1 of 3/);await ui.get('explore-search-users-pages').querySelector('[aria-label="Next users search page"]').onclick();assert.match(ui.get('explore-search-users-results').textContent,/later_user/);
  await ui.app.select('coins');assert.match(ui.get('explore-search-coins-pages').textContent,/Page 2 of 3/);assert.equal(ui.get('explore-search-input').value,'sun');
  const queries=ui.calls.filter(call=>call.path.startsWith('/api/explore?')).map(call=>new URL(call.path,'https://launchpad.example').searchParams);assert(queries.every(q=>q.get('stage')==='all'&&q.get('limit')==='12'&&!q.has('category')&&!q.has('quote')));
});

test('search handles loading, empty and failures without showing provider details or unsafe metadata',async t=>{
  let fail=true;const ui=await fixture(t,{respond:kind=>fail?{error:'https://PRIVATE-KEY.invalid'}:kind==='users'?{users:[],total:0}:{coins:[{...coin,name:'<script>bad()</script>',image:'https://outside.invalid/image',href:'javascript:bad()',marketCapUsd:null,fdvUsd:50000},{mint:'../secret'}],total:1}});
  await ui.app.open();await ui.app.search('sun');assert.match(ui.get('explore-search-coins-status').textContent,/temporarily unavailable/);assert(!ui.dialog.textContent.includes('PRIVATE-KEY'));
  fail=false;await ui.get('explore-search-coins-pages').querySelector('button').onclick();const link=ui.get('explore-search-coins-results').querySelector('a');assert.equal(ui.get('explore-search-coins-results').querySelectorAll('a').length,1);assert.equal(link.querySelector('script'),null);assert.equal(link.querySelector('img'),null);assert.match(link.textContent,/<script>bad/);assert.match(link.textContent,/\$50KFDV/);assert.equal(link.getAttribute('href'),'/coin?mint='+MINT);
  await ui.get('explore-search-users-pages').querySelector('button').onclick();assert.equal(ui.get('explore-search-users-count').textContent,'0');assert.equal(ui.get('explore-search-users-status').textContent,'No matching users.');
  const calls=ui.calls.length;await ui.app.search('');assert.equal(ui.calls.length,calls);assert.equal(ui.get('explore-search-coins-results').children.length,0);assert.match(ui.get('explore-search-coins-status').textContent,/Search coins/);
});

test('typing resets stale results immediately and submits through the same bounded query path',async t=>{
  const ui=await fixture(t);await ui.app.open();await ui.app.search('sun');const input=ui.get('explore-search-input');input.value='new query';input.oninput();assert.equal(ui.get('explore-search-coins-results').children.length,0);assert.equal(ui.get('explore-search-coins-count').textContent,'—');
  ui.key(input,'Enter');await flush();assert(ui.calls.slice(-2).every(call=>new URL(call.path,'https://launchpad.example').searchParams.get('search')==='new query'));
  assert.equal(ui.get('explore-search-coins-results').getAttribute('aria-busy'),'false');
});

test('shared header search opens in place on coin, public profile, launch and information pages',async t=>{
  for(const page of ['coin','creator','launchpad','docs','terms','privacy']){
    await t.test(page,async t=>{
      const ui=await fixture(t,{page}),header=ui.document.querySelector('.workspace-header-inner'),main=ui.document.querySelector('main'),before=main.innerHTML;
      assert.equal(header.children[0].className,'brand');assert.equal(header.children[1].className,'header-search');assert.equal(header.children[2].className,'local');assert.equal(header.querySelector('.local .top-launch').getAttribute('href'),'/launchpad');assert.equal(header.querySelectorAll('.curve-price-badge').length,1);assert.equal(ui.calls.length,0);
      ui.event(ui.get('explore-search'),'click');await ui.app.search('sun');assert.equal(ui.dialog.open,true);assert.equal(main.innerHTML,before);assert.equal(ui.get('explore-search-coins-results').querySelector('a').getAttribute('href'),'/coin?mint='+MINT);
      await ui.app.select('users');assert.equal(ui.get('explore-search-users-results').querySelector('a').getAttribute('href'),'/user/sunrise');assert.equal(ui.calls.length,2);
      ui.key(ui.get('explore-search-input'),'Escape');assert.equal(ui.focused,ui.get('explore-search'));assert.equal(ui.dialog.open,false);assert.equal(main.innerHTML,before);
    });
  }
});

test('repeated shell mounting and multiple triggers share one controller and restore their own focus',async t=>{
  const ui=await fixture(t),header=ui.document.querySelector('.workspace-header-inner');
  ui.shell({session:{authenticated:true,account:{username:'sunrise',role:'user'}}});ui.shell({session:{authenticated:true,account:{username:'changed_name',role:'admin'}}});
  assert.equal(ui.document.querySelectorAll('#explore-search').length,1);assert.equal(ui.document.querySelectorAll('#explore-search-dialog').length,1);assert.equal(ui.document.querySelectorAll('#explore-search-styles').length,1);assert.equal(ui.document.querySelectorAll('#explore-search-tabs').length,1);assert.equal(ui.calls.length,0);
  assert.equal(mountExploreHeaderSearch({document:ui.document,container:header}),ui.app);
  const extra=ui.document.createElement('button');extra.textContent='Search again';extra.setAttribute('data-curve-search-trigger','');ui.document.querySelector('main').append(extra);
  assert.equal(createExploreSearch({document:ui.document,fetcher:()=>{throw Error('A second fetcher must not replace the active controller');}}),ui.app);
  await ui.app.search('sun');extra.focus();await flush();assert.equal(ui.calls.length,2);assert.equal(extra.getAttribute('aria-expanded'),'true');assert.equal(ui.get('explore-search').getAttribute('aria-expanded'),'true');
  ui.key(ui.get('explore-search-input'),'Escape');assert.equal(ui.focused,extra);assert.equal(ui.dialog.open,false);assert.equal(extra.getAttribute('aria-expanded'),'false');
  ui.get('explore-search').focus();await flush();assert.equal(ui.calls.length,4);assert.equal(ui.get('explore-search-input').value,'sun');ui.app.close();assert.equal(ui.focused,ui.get('explore-search'));assert.equal(ui.dialog.open,false);
  const accountDialog=ui.document.createElement('dialog');accountDialog.setAttribute('open','');ui.document.body.append(accountDialog);ui.event(ui.get('explore-search'),'click');assert.equal(ui.dialog.open,false);accountDialog.remove();
  ui.key(ui.document.body,'/');await flush();assert.equal(ui.dialog.open,true);assert.equal(ui.calls.length,6);ui.app.close();ui.app.destroy();extra.focus();ui.event(ui.get('explore-search'),'click');assert.equal(ui.dialog.open,false);assert.equal(ui.calls.length,6);
});


test('coin search results display exact-mint pair logos without changing the coin avatar',async t=>{
  const quote={mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',symbol:'USDC'},ui=await fixture(t,{respond:kind=>kind==='coins'?{coins:[{...coin,quote}],total:1,nextOffset:null}:undefined});await ui.app.open();await ui.app.search('sun');
  const row=ui.get('explore-search-coins-results').querySelector('a'),pair=row.querySelector('.explore-search-pair');assert.equal(row.querySelector('.explore-search-avatar img').src,coin.image);assert.equal(pair.textContent,'USDC');assert.equal(pair.querySelector('img').src.startsWith('/quote-logos/'+quote.mint+'.'),true);pair.querySelector('img').onerror();assert.equal(pair.textContent,'USDC');assert.equal(pair.querySelector('img'),null);
});


test('search distinguishes pointer focus from keyboard navigation without changing focus behavior',async t=>{
  const ui=await fixture(t),trigger=ui.get('explore-search');ui.event(trigger,'pointerdown');trigger.focus();assert.equal(ui.document.body.dataset.searchInputMode,'pointer');assert.equal(ui.focused,ui.get('explore-search-input'));
  ui.key(ui.get('explore-search-input'),'Tab');assert.equal(ui.document.body.dataset.searchInputMode,'keyboard');ui.event(ui.get('explore-search-input'),'pointerdown');assert.equal(ui.document.body.dataset.searchInputMode,'pointer');
  ui.app.close();ui.key(ui.document.body,'/');assert.equal(ui.document.body.dataset.searchInputMode,'keyboard');assert.equal(ui.dialog.open,true);assert.equal(ui.focused,ui.get('explore-search-input'));
  ui.app.destroy();ui.event(ui.document.body,'pointerdown');assert.equal(ui.document.body.dataset.searchInputMode,'keyboard','destroy removes modality listeners');
});

test('cold USD search results update while open and preserve keyboard selection',async t=>{
  let warming=true,next=0;const timers=new Map();
  const ui=await fixture(t,{timeout:(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});return id;},clear:id=>timers.delete(id),respond:kind=>kind==='coins'?{coins:[{...coin,marketCapUsd:null,fdvUsd:warming?null:24000,fdvQuote:7}],total:1,nextOffset:null,refreshing:warming}:undefined});
  await ui.app.open();await ui.app.search('sun');const root=ui.get('explore-search-coins-results');assert.match(root.textContent,/—FDV · USD/);assert.doesNotMatch(root.textContent,/7FDV/);
  root.querySelector('a').focus();const count=ui.calls.length,pending=[...timers].find(([,timer])=>timer.ms===3000);assert(pending);timers.delete(pending[0]);warming=false;await pending[1].fn();
  assert.equal(ui.calls.length,count+1);assert.match(root.textContent,/\$24KFDV/);assert.equal(ui.focused.getAttribute('href'),'/coin?mint='+MINT);assert.equal(timers.size,0);
  warming=true;await ui.app.search('new');assert([...timers.values()].some(timer=>timer.ms===3000));ui.app.close();assert.equal(timers.size,0);
});


test('coin search overrides exact official LAUNCHPAD art while preserving other token and user avatars',async t=>{
  const official={...coin,mint:OFFICIAL_TOKEN_MINT,symbol:'LAUNCHPAD'},impostor={...coin,symbol:'LAUNCHPAD'};
  const ui=await fixture(t,{respond:kind=>kind==='coins'?{coins:[official,impostor],total:2}:{users:[{...user,username:'launchpad',mint:OFFICIAL_TOKEN_MINT}],total:1}});
  await ui.app.open();await ui.app.search('launchpad');
  const results=ui.get('explore-search-coins-results').querySelectorAll('a');assert.equal(results[0].querySelector('img').src,'/brand-icon.png?v=54');assert.equal(results[1].querySelector('img').src,coin.image);
  assert.equal(ui.get('explore-search-users-results').querySelector('img').src,user.avatar);assert.equal(official.image,coin.image);
});

// Search controller only (no workspace shell globals), with a window that can lose focus.
async function searchFixture(t,{respond}={}){
  const {document,window}=parseHTML(await readFile(new URL('../public/explore.html',import.meta.url),'utf8')),calls=[],get=id=>document.getElementById(id);let focused=document.body;
  Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused});
  const original=window.HTMLElement.prototype.focus;window.HTMLElement.prototype.focus=function(){focused=this;this.dispatchEvent(new window.Event('focus'));this.dispatchEvent(new window.Event('focusin',{bubbles:true}));};
  const fetcher=async(path,options)=>{calls.push({path,options});const url=new URL(path,'https://launchpad.example'),kind=url.pathname==='/api/explore/users'?'users':'coins';const data=await respond?.(kind,url.searchParams,options)??{[kind]:[kind==='coins'?coin:user],total:1,nextOffset:null};return {ok:!data.error,status:data.error?503:200,json:async()=>data};};
  const events=new EventTarget(),view={setTimeout,clearTimeout,addEventListener:(...args)=>events.addEventListener(...args),removeEventListener:(...args)=>events.removeEventListener(...args),dispatchEvent:event=>events.dispatchEvent(event)};
  const app=createExploreSearch({document,window:view,fetcher});
  const dialog=get('explore-search-dialog');Object.defineProperty(dialog,'open',{configurable:true,get:()=>dialog.hasAttribute('open')});dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>{dialog.removeAttribute('open');dialog.dispatchEvent(new window.Event('close'));};
  t.after(()=>{app.destroy();window.HTMLElement.prototype.focus=original;});
  const press=(target,value,props={})=>{const e=new window.Event('keydown',{bubbles:true,cancelable:true});for(const [name,property]of Object.entries({key:value,...props}))Object.defineProperty(e,name,{value:property});target.dispatchEvent(e);return e;};
  return {document,window,view,get,dialog,calls,app,press,get focused(){return focused;}};
}

test('the header field reopens search with "/", Enter or Space after Escape, and focus returning with the window does not reopen it',async t=>{
  const ui=await searchFixture(t),trigger=ui.get('explore-search'),input=ui.get('explore-search-input');
  ui.press(ui.document.body,'/');assert.equal(ui.dialog.open,true);assert.equal(ui.focused,input);
  ui.press(input,'Escape');assert.equal(ui.dialog.open,false);assert.equal(ui.focused,trigger);
  assert.equal(ui.press(trigger,'/').defaultPrevented,true);assert.equal(ui.dialog.open,true,'"/" works from the read-only header field');assert.equal(ui.focused,input);
  for(const value of ['Enter',' ']){ui.press(input,'Escape');assert.equal(ui.focused,trigger);assert.equal(ui.press(trigger,value).defaultPrevented,true);assert.equal(ui.dialog.open,true,JSON.stringify(value));}
  ui.press(input,'Escape');assert.equal(ui.dialog.open,false);
  ui.view.dispatchEvent(new ui.window.Event('blur'));trigger.focus();assert.equal(ui.dialog.open,false,'the browser re-focusing the field on return is not a search request');
  ui.press(ui.document.body,'Tab');trigger.focus();assert.equal(ui.dialog.open,true,'keyboard focus still opens the search');
  ui.app.close();const typed=ui.document.createElement('input');ui.document.querySelector('main').append(typed);assert.equal(ui.press(typed,'/').defaultPrevented,false);assert.equal(ui.dialog.open,false,'"/" typed in another field stays text');
});

test('search page buttons keep keyboard focus while a page loads and at the last page',async t=>{
  const ui=await searchFixture(t,{respond:(kind,q)=>({[kind]:[kind==='coins'?coin:{...user,username:Number(q.get('offset'))?'later_user':'sunrise'}],total:25,nextOffset:Number(q.get('offset'))+12<25?Number(q.get('offset'))+12:null})});
  await ui.app.open();await ui.app.search('sun');
  const pages=ui.get('explore-search-coins-pages'),button=label=>pages.querySelector(`[aria-label="${label} coins search page"]`);
  assert.equal(button('Previous').getAttribute('aria-disabled'),'true');assert.equal(button('Previous').disabled,false);const calls=ui.calls.length;await button('Previous').onclick();assert.equal(ui.calls.length,calls,'an unavailable page does nothing');
  button('Next').focus();const loading=button('Next').onclick();assert.equal(ui.focused,button('Next'),'focus stays on Next while it loads');assert.equal(button('Next').getAttribute('aria-disabled'),'true');
  await loading;assert.equal(ui.focused,button('Next'));assert.match(pages.textContent,/Page 2 of 3/);assert.equal(button('Next').hasAttribute('aria-disabled'),false);
  await button('Next').onclick();assert.match(pages.textContent,/Page 3 of 3/);assert.equal(ui.focused,button('Next'),'focus stays on the last Next');assert.equal(button('Next').getAttribute('aria-disabled'),'true');
  const last=ui.calls.length;await button('Next').onclick();assert.equal(ui.calls.length,last);
});

test('the header search loads pair logos only once it opens, so pages without coin cards skip the quote catalogues',async t=>{
  const source=await readFile(new URL('../public/explore-search.mjs',import.meta.url),'utf8');
  assert.deepEqual([...source.matchAll(/^import[^;]*?from\s*['"]([^'"]+)['"]/gm)].map(match=>match[1]),['./coin-image.mjs']);assert.match(source,/import\('\.\/quote-logos\.mjs'\)/);
  const quote={mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',symbol:'USDC'},ui=await searchFixture(t,{respond:kind=>kind==='coins'?{coins:[{...coin,quote}],total:1,nextOffset:null}:undefined});
  await ui.app.open();await ui.app.search('sun');
  const row=ui.get('explore-search-coins-results').querySelector('a'),pair=row.querySelector('.explore-search-pair');
  assert.equal(pair.textContent,'USDC');assert(pair.querySelector('img'),'the logo is ready when the results first render');assert.equal(pair.getAttribute('aria-label'),'Paired with USDC');assert.match(row.textContent,/\$25KMarket cap/);assert.match(row.textContent,/So111…1112/);
});

test('a ticker typed as it is displayed ($SUN) searches for the ticker',async t=>{
  const ui=await searchFixture(t);await ui.app.open();await ui.app.search('  $SUN ');
  const coins=ui.calls.filter(call=>call.path.startsWith('/api/explore?')).map(call=>new URL(call.path,'https://launchpad.example').searchParams.get('search'));assert.deepEqual(coins,['SUN']);assert.equal(ui.get('explore-search-input').value,'$SUN');
  assert.match(ui.get('explore-search-coins-status').textContent,/1 coin found/);
  const calls=ui.calls.length;await ui.app.search('$');assert.equal(ui.calls.length,calls,'a lone "$" is not a search');assert.match(ui.get('explore-search-coins-status').textContent,/Search coins by name/);
});
