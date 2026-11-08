import {OFFICIAL_TOKEN_MINT} from '../public/coin-image.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {createCreatorPage,creatorUsername} from '../public/creator.js';

const mint='So11111111111111111111111111111111111111112';
async function page(t,href,{coins=[{mint,name:'Public launch',symbol:'SUN',fdvUsd:20000}],avatar=null}={}){
  const {document}=parseHTML(await readFile(new URL('../public/creator.html',import.meta.url),'utf8')),calls=[];
  const fetcher=async path=>{calls.push(path);if(path==='/api/session')return {ok:true,json:async()=>({authenticated:false})};const params=new URL(path,'https://launchpad.example').searchParams;return {ok:true,json:async()=>({profile:{username:params.get('username'),bio:'Public creator bio',avatar},coins,total:25,offset:Number(params.get('offset')),limit:24})};};
  const app=createCreatorPage({document,window:{location:{href}},fetcher,shell:()=>{},setTimer:()=>1,clearTimer:()=>{}});t.after(()=>app.destroy());await app.ready;
  return {app,document,calls,get:id=>document.getElementById(id)};
}

test('clean public profile URLs load the named user and their launched coins',async t=>{
  const ui=await page(t,'https://launchpad.example/user/sun_rise?username=other_user');
  assert.equal(ui.get('creator-name').textContent,'sun_rise');assert.equal(ui.get('creator-count').textContent,'25');assert.equal(ui.get('creator-coins').querySelector('a').getAttribute('href'),'/coin?mint='+mint);assert.match(ui.get('creator-coins').textContent,/Public launch/);
  const query=new URL(ui.calls.find(path=>path.startsWith('/api/explore/creator?')),'https://launchpad.example').searchParams;assert.equal(query.get('username'),'sun_rise');assert.equal(query.get('offset'),'0');
  await [...ui.get('creator-pages').querySelectorAll('button')].find(button=>button.textContent==='Next').onclick();const next=new URL(ui.calls.at(-1),'https://launchpad.example').searchParams;assert.equal(next.get('username'),'sun_rise');assert.equal(next.get('offset'),'24');
});

test('legacy creator query URLs remain compatible and normalize existing username conventions',async t=>{
  const ui=await page(t,'https://launchpad.example/creator?username=Sun-Rise');assert.equal(ui.get('creator-name').textContent,'sun-rise');
  assert.equal(creatorUsername('https://launchpad.example/user/Sun_Rise/'),'sun_rise');assert.equal(creatorUsername('https://launchpad.example/creator?username=%20Sun_Rise%20'),'sun_rise');
});

test('invalid public user paths never turn query strings or path escapes into account lookups',async t=>{
  for(const path of ['/user/sun_rise/private?username=good_user','/user/%2fprivate?username=good_user','/user/ab','/creator?username=../private','/api/account?username=good_user']){
    assert.equal(creatorUsername('https://launchpad.example'+path),'');
    const ui=await page(t,'https://launchpad.example'+path);assert.equal(ui.calls.some(call=>call.startsWith('/api/explore/creator')),false);assert.equal(ui.get('creator-error').hidden,false);
  }
});


test('public profiles update only exact official LAUNCHPAD token art, preserving personal avatars and other launches',async t=>{
  const image='/token-images/'+'a'.repeat(64)+'.png',coins=[{mint:OFFICIAL_TOKEN_MINT,name:'Launchpad',symbol:'LAUNCHPAD',image},{mint,name:'Unrelated',symbol:'LAUNCHPAD',image}];
  const ui=await page(t,'https://launchpad.example/user/curve',{coins,avatar:image}),cards=ui.get('creator-coins').querySelectorAll('a');
  assert.equal(cards[0].querySelector('img').src,'/brand-icon.png?v=54');assert.equal(cards[1].querySelector('img').src,image);assert.equal(ui.get('creator-picture').src,image);assert.equal(coins[0].image,image);
});

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const creatorResponse=(offset,{username='sun_rise',total=80}={})=>({ok:true,json:async()=>({profile:{username,bio:'Page '+offset,avatar:null},coins:[{mint,name:'Page '+offset,symbol:'SUN'}],total,offset,limit:24})});
async function controlledPage(t,{document:existingDocument,username='sun_rise',sessionResponse}={}){
  const document=existingDocument||(parseHTML(await readFile(new URL('../public/creator.html',import.meta.url),'utf8'))).document;
  const calls=[],timers=new Map(),shellCalls=[];let nextTimer=0;
  const fetcher=(path,options)=>{
    if(path==='/api/session')return sessionResponse?sessionResponse(path,options):Promise.resolve({ok:true,json:async()=>({authenticated:false})});
    const result=deferred();calls.push({path,options,result,offset:Number(new URL(path,'https://launchpad.example').searchParams.get('offset'))});return result.promise;
  };
  const app=createCreatorPage({document,window:{location:{href:'https://launchpad.example/user/'+username}},fetcher,shell:value=>shellCalls.push(value),setTimer:()=>1,clearTimer:()=>{},setRequestTimer:fn=>{timers.set(++nextTimer,fn);return nextTimer;},clearRequestTimer:id=>timers.delete(id)});
  t.after(()=>app.destroy());
  return {document,app,calls,timers,shellCalls,get:id=>document.getElementById(id),button:label=>[...document.getElementById('creator-pages').querySelectorAll('button')].find(button=>button.textContent===label),expire:()=>{for(const fn of [...timers.values()])fn();}};
}

test('creator pagination cannot change its offset or start another request while a page is pending',async t=>{
  const ui=await controlledPage(t);ui.calls[0].result.resolve(creatorResponse(0));await ui.app.ready;
  const second=ui.button('Next').onclick();ui.calls[1].result.resolve(creatorResponse(24));await second;
  const previous=ui.button('Previous'),next=ui.button('Next');const third=next.onclick();
  assert.equal(previous.disabled,true);assert.equal(next.disabled,true);
  await previous.onclick();await next.onclick();await ui.app.refresh();assert.equal(ui.calls.length,3);
  ui.calls[2].result.resolve(creatorResponse(48));await third;
  assert.match(ui.get('creator-coins').textContent,/Page 48/);
  const back=ui.button('Previous').onclick();assert.equal(ui.calls[3].offset,24);ui.calls[3].result.resolve(creatorResponse(24));await back;
  assert.deepEqual(ui.calls.map(call=>call.offset),[0,24,48,24]);
});

test('a failed creator page leaves the successful offset and pagination usable for retry',async t=>{
  const ui=await controlledPage(t);ui.calls[0].result.resolve(creatorResponse(0));await ui.app.ready;
  const second=ui.button('Next').onclick();ui.calls[1].result.resolve(creatorResponse(24));await second;
  const failed=ui.button('Next').onclick();ui.calls[2].result.reject(Error('Temporarily unavailable.'));await failed;
  assert.match(ui.get('creator-coins').textContent,/Page 24/);assert.equal(ui.button('Previous').disabled,false);assert.equal(ui.button('Next').disabled,false);assert.equal(ui.get('creator-refresh').disabled,false);
  const refreshed=ui.app.refresh();assert.equal(ui.calls[3].offset,24);ui.calls[3].result.resolve(creatorResponse(24));await refreshed;
  assert.equal(ui.get('creator-error').hidden,true);
});

test('creator requests time out, recover, and ignore a late response from a request that ignored abort',async t=>{
  const ui=await controlledPage(t);await flush();ui.expire();await ui.app.ready;
  assert.equal(ui.calls[0].options.signal.aborted,true);assert.equal(ui.get('creator-refresh').disabled,false);assert.equal(ui.get('creator-error').textContent,'Creator data is taking longer than usual. Try Refresh.');
  const retry=ui.app.refresh();ui.calls[1].result.resolve(creatorResponse(0));await retry;
  ui.calls[0].result.resolve(creatorResponse(999));await flush();
  assert.match(ui.get('creator-coins').textContent,/Page 0/);assert.doesNotMatch(ui.get('creator-coins').textContent,/999/);assert.equal(ui.get('creator-error').hidden,true);assert.equal(ui.timers.size,0);
});

test('the creator deadline covers stalled response bodies and does not show raw browser abort errors',async t=>{
  const ui=await controlledPage(t),body=deferred();ui.calls[0].result.resolve({ok:true,json:()=>body.promise});await flush();ui.expire();await ui.app.ready;
  assert.equal(ui.calls[0].options.signal.aborted,true);assert.match(ui.get('creator-error').textContent,/Try Refresh/);
  const retry=ui.app.refresh();ui.calls[1].result.reject(new DOMException('signal is aborted without reason','AbortError'));await retry;
  assert.equal(ui.get('creator-error').textContent,'Creator data is taking longer than usual. Try Refresh.');assert.equal(ui.get('creator-refresh').disabled,false);
  body.resolve(await creatorResponse(999).json());await flush();assert.doesNotMatch(ui.get('creator-coins').textContent,/999/);assert.equal(ui.timers.size,0);
});

test('navigation aborts creator and session reads and stale results cannot overwrite a newly mounted creator',async t=>{
  const session=deferred();let sessionSignal;
  const old=await controlledPage(t,{sessionResponse:(_path,options)=>{sessionSignal=options.signal;return session.promise;}});
  old.app.destroy();await old.app.ready;
  assert.equal(old.calls[0].options.signal.aborted,true);assert.equal(sessionSignal.aborted,true);assert.equal(old.timers.size,0);
  const current=await controlledPage(t,{document:old.document,username:'new_creator'});current.calls[0].result.resolve(creatorResponse(0,{username:'new_creator'}));await current.app.ready;
  old.calls[0].result.resolve(creatorResponse(999));session.resolve({ok:true,json:async()=>({authenticated:true,account:{id:'old-account'}})});await flush();
  assert.equal(current.get('creator-name').textContent,'new_creator');assert.equal(current.document.title,'new_creator — Launchpad');assert.match(current.get('creator-coins').textContent,/Page 0/);assert.equal(current.get('creator-error').hidden,true);assert.equal(old.shellCalls.length,1);assert.equal(old.calls.length,1);
  await old.app.refresh();assert.equal(old.calls.length,1);
});

async function respondingPage(t,respond,username='nobody_here'){
  const {document}=parseHTML(await readFile(new URL('../public/creator.html',import.meta.url),'utf8')),calls=[];let tick=null;
  const fetcher=async path=>{if(path==='/api/session')return {ok:true,json:async()=>({authenticated:false})};calls.push(path);return respond(path);};
  const app=createCreatorPage({document,window:{location:{href:'https://launchpad.example/user/'+username}},fetcher,shell:()=>{},setTimer:fn=>{tick=fn;return 1;},clearTimer:()=>{}});t.after(()=>app.destroy());await app.ready;
  return {document,app,calls,get:id=>document.getElementById(id),tick:async()=>{tick();await flush();}};
}

test('an unknown creator shows a not-found state and stops re-requesting the missing profile',async t=>{
  const ui=await respondingPage(t,()=>({ok:false,status:404,json:async()=>({error:'Creator not found.'})}));
  assert.equal(ui.get('creator-name').textContent,'Creator not found');assert.equal(ui.document.title,'Creator not found — Launchpad');
  assert.equal(ui.get('creator-error').hidden,false);assert.match(ui.get('creator-error').textContent,/No Launchpad creator uses this username/);assert.equal(ui.get('creator-coins').children.length,0);
  await ui.tick();await ui.tick();assert.equal(ui.calls.length,1,'the 30-second refresh does not poll a missing creator');
  await ui.app.refresh();assert.equal(ui.calls.length,2,'Refresh still checks again on request');
});

test('a proxy error page shows readable creator text instead of a JSON parser error, and polling retries',async t=>{
  let fail=true;const ui=await respondingPage(t,()=>fail?{ok:false,status:502,json:async()=>{throw new SyntaxError('Unexpected token \'<\', "<html><hea"... is not valid JSON');}}:creatorResponse(0,{username:'nobody_here'}),'nobody_here');
  assert.equal(ui.get('creator-error').hidden,false);assert.match(ui.get('creator-error').textContent,/temporarily unavailable/);assert.doesNotMatch(ui.get('creator-error').textContent,/JSON|Unexpected token/);
  fail=false;await ui.tick();await flush();assert.equal(ui.get('creator-name').textContent,'nobody_here');assert.equal(ui.get('creator-error').hidden,true);
});
