import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createAccountOverlay} from '../public/account-overlay.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
function fixture({wallet=false,handler,features={}}={}){
  const {document,window}=parseHTML('<html><body><main>Explore stays here</main><button id="trigger">Account</button></body></html>');
  window.HTMLElement.prototype.showModal=function(){this.open=true;this.setAttribute('open','');};
  window.HTMLElement.prototype.close=function(){this.open=false;this.removeAttribute('open');this.dispatchEvent(new window.Event('close'));};
  const base={id:'a'.repeat(32),username:'sunrise',authType:wallet?'wallet':'password',avatar:'https://external.example/avatar.png',bio:'<img src=x onerror=alert(1)>',mainWallet:'4'.repeat(44),cashbackBps:2500,role:'user'};
  let token='csrf-first',current={...base},securityCalls=0,securityApi,reloads=0;const calls=[],updates=[],scroll=[];
  const browser={...window,scrollX:0,scrollY:380,scrollTo:(x,y)=>scroll.push([x,y]),navigator:{clipboard:{writeText:async()=>{}}},location:{reload:()=>reloads++}};
  const fetcher=async(path,options={})=>{calls.push({path,...options});let value;
    if(handler){const custom=await handler(path,options);if(custom?.__status)return{ok:false,status:custom.__status,json:async()=>({error:'Sign in to your Launchpad account.'})};if(custom?.__html)return{ok:false,status:custom.__html,json:async()=>{throw new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON');}};if(custom!==undefined)return{ok:true,json:async()=>custom};}
    if(path==='/api/session')value={authenticated:true,account:current,token,features};
    else if(path==='/api/account')value={account:current,cashback:[]};
    else if(path==='/api/account/profile'){current={...current,...JSON.parse(options.body)};value={account:current};}
    else if(path==='/api/account/mfa/enable'){token='csrf-rotated';value={account:current,token,recoveryCodes:['private-recovery']};}
    else value={};return{ok:true,json:async()=>value};
  };
  const overlay=createAccountOverlay({document,window:browser,fetcher,onAccount:v=>updates.push(v),securityFactory:options=>{securityCalls++;securityApi=options.api;return{render(){},authorize:async()=>({password:'not-logged',code:'123456'})};}});
  return{document,window,overlay,calls,updates,scroll,get securityCalls(){return securityCalls;},get securityApi(){return securityApi;},get reloads(){return reloads;},setToken:value=>token=value,setAccount:value=>current=value,account:base,$:name=>overlay.dialog.querySelector('[data-'+name+']')};
}
test('public wallet account edits stay in the current page and never mount password or toolkit controls',async()=>{
  const f=fixture({wallet:true});await f.overlay.open({},f.document.getElementById('trigger'));
  assert.equal(f.overlay.dialog.querySelector('h2').textContent,'Edit profile');assert.equal(f.$('logout'),null);
  assert.equal(f.securityCalls,0);assert.equal(f.$('export-controls').hidden,true);assert.equal(f.$('telegram').hidden,true);assert.equal(f.$('avatar').hidden,true);assert.equal(f.$('bio').value,'<img src=x onerror=alert(1)>');assert.equal(f.overlay.dialog.querySelector('[onerror]'),null);
  assert.equal(f.overlay.dialog.querySelector('.account-tabs'),null);
  assert.equal(f.$('my-profile'),null);assert.equal(f.overlay.dialog.querySelector('a[href="/launched-tokens"]'),null);
  assert.equal(f.$('toolkit-wallet').hidden,true);assert.equal(f.$('signin-wallet').hidden,false);assert.equal(f.$('signin-wallet').querySelector('[data-siw-address]').textContent,f.account.mainWallet);
  f.$('bio').value='Creator bio';await f.$('profile').onsubmit({preventDefault(){}});
  assert.equal(f.updates.at(-1).account.bio,'Creator bio');assert.equal(f.calls.at(-1).headers['x-control-token'],'csrf-first');assert.equal(f.securityCalls,0);
  f.$('close').click();assert.deepEqual(f.scroll,[[0,380]]);assert.equal(f.reloads,0);assert.equal(f.document.querySelector('main').textContent,'Explore stays here');
  assert(f.calls.every(c=>['/api/session','/api/account','/api/account/profile'].includes(c.path)));
});
test('manual account reuses security identity checks and propagates rotated CSRF to later profile requests',async()=>{
  const f=fixture();await f.overlay.open({});assert.equal(f.$('logout'),null);assert.equal(f.securityCalls,1);await f.securityApi('/api/account/mfa/enable',{code:'123456'});
  assert.equal(f.updates.at(-1).token,'csrf-rotated');f.$('bio').value='New bio';await f.$('profile').onsubmit({preventDefault(){}});assert.equal(f.calls.at(-1).headers['x-control-token'],'csrf-rotated');
});
test('closing and reopening discards an older account response without blocking the new dialog',async()=>{
  const pending=deferred();let reads=0;const f=fixture({handler:path=>path==='/api/account'&&++reads===1?pending.promise:undefined});
  const first=f.overlay.open({});await flush();f.overlay.dialog.close();await f.overlay.open({});assert.equal(f.overlay.dialog.open,true);assert.equal(f.$('username').value,'sunrise');
  pending.resolve({account:{...f.account,username:'outdated'},cashback:[]});await first;assert.equal(f.$('username').value,'sunrise');assert.equal(f.updates.at(-1).account.username,'sunrise');
});
test('late exported keys are never displayed after closing and reopening the account',async()=>{
  const pending=deferred();const f=fixture({handler:path=>path==='/api/account/export'?pending.promise:undefined});await f.overlay.open({});const exportAction=f.$('export').onclick();await flush();f.overlay.dialog.close();await f.overlay.open({});pending.resolve({privateKey:'secret-late-key'});await exportAction;assert.equal(f.$('key').value,'');assert.equal(f.$('export-result').hidden,true);
});
test('late MFA completion refreshes current session state without displaying recovery material',async()=>{
  const pending=deferred();const f=fixture({handler:path=>path==='/api/account/mfa/enable'?pending.promise:undefined});await f.overlay.open({});const enabling=f.securityApi('/api/account/mfa/enable',{code:'123456'});f.overlay.dialog.close();f.setToken('csrf-after-close');pending.resolve({token:'rotated',recoveryCodes:['never-render-this']});await assert.rejects(enabling,/Cancelled/);assert.equal(f.updates.at(-1).token,'csrf-after-close');assert(!f.document.body.textContent.includes('never-render-this'));assert.equal(f.overlay.dialog.open,false);
});


test('late MFA rotation also updates CSRF inside a reopened account overlay',async()=>{
  const pending=deferred();const f=fixture({handler:path=>path==='/api/account/mfa/enable'?pending.promise:undefined});await f.overlay.open({});const enabling=f.securityApi('/api/account/mfa/enable',{code:'123456'});f.overlay.dialog.close();await f.overlay.open({});f.setToken('csrf-after-close');pending.resolve({token:'rotated',recoveryCodes:['never-render-this']});await assert.rejects(enabling,/Cancelled/);
  f.$('bio').value='Saved after rotation';await f.$('profile').onsubmit({preventDefault(){}});assert.equal(f.calls.at(-1).headers['x-control-token'],'csrf-after-close');assert.equal(f.$('key').value,'');
});

test('linking or unlinking a wallet after Close refreshes the rotated session for the current page',async()=>{
 for(const path of ['/api/account/signin-wallet','/api/account/signin-wallet/unlink']){
  const pending=deferred(),f=fixture({handler:p=>p===path?pending.promise:undefined});await f.overlay.open({});const saving=f.securityApi(path,{nonce:'proof',signature:'signed'});f.overlay.dialog.close();await f.overlay.open({});f.setToken('csrf-after-wallet-link');pending.resolve({account:f.account,token:'rotated-response'});await assert.rejects(saving,/Cancelled/);assert.equal(f.updates.at(-1).token,'csrf-after-wallet-link');f.$('bio').value='After session rotation';await f.$('profile').onsubmit({preventDefault(){}});assert.equal(f.calls.at(-1).headers['x-control-token'],'csrf-after-wallet-link');
 }
});

test('launchpad account hides cashback and Telegram while retaining trading wallet access and profile editing',async()=>{
 const f=fixture({features:{walletOnly:true}});await f.overlay.open({});
 assert.equal(f.$('wallet-title').textContent,'Legacy trading wallet');assert.match(f.$('wallet-note').textContent,/Link an external wallet/);
 assert.equal(f.$('toolkit-wallet').hidden,false);assert.equal(f.$('wallet').textContent,f.account.mainWallet);
 assert.equal(f.$('export-controls').hidden,false);assert.equal(f.$('cashback-settings').hidden,true);assert.equal(f.$('cashback-settings').children.length,0);
 assert.equal(f.$('cashback').textContent,'');assert.equal(f.$('rate').textContent,'');assert.equal(f.$('telegram').hidden,true);
 assert.equal(f.overlay.dialog.querySelector('[data-cbw-edit]'),null);assert.equal(f.overlay.dialog.querySelector('.account-tabs'),null);
 assert.equal(f.securityCalls,1);assert.deepEqual(f.updates.at(-1).features,{walletOnly:true});
 await assert.rejects(f.securityApi('/api/account/cashback-wallet',{address:'5'.repeat(44)}),/not available/);
 await assert.rejects(f.securityApi('/api/account/telegram-link',{}),/not available/);
 await f.securityApi('/api/account/export',{password:'verified'});assert.equal(f.calls.at(-1).path,'/api/account/export');
 f.overlay.dialog.close();
});

test('disabled account capabilities remain unmounted unless each server feature is explicitly true',async()=>{
 const off=fixture({features:{toolkit:'true',telegram:1}});await off.overlay.open({});
 assert.equal(off.$('cashback-settings').children.length,0);assert.equal(off.$('telegram').hidden,true);off.overlay.dialog.close();
 const on=fixture({features:{toolkit:true,telegram:true}});await on.overlay.open({});
 assert.equal(on.$('cashback-settings').hidden,false);assert.ok(on.overlay.dialog.querySelector('[data-cbw-edit]'));assert.equal(on.$('telegram').hidden,false);
 on.$('bio').value='Preserve feature flags';await on.$('profile').onsubmit({preventDefault(){}});
 assert.deepEqual(on.updates.at(-1).features,{toolkit:true,telegram:true});on.overlay.dialog.close();
});

test('saving a username updates the current account while retaining profile editing',async()=>{
 const f=fixture({wallet:true});f.setAccount({...f.account,username:'Sun_Rise-123'});await f.overlay.open({});
 assert.equal(f.$('username').value,'Sun_Rise-123');
 f.$('username').value='New_Name';await f.$('profile').onsubmit({preventDefault(){}});
 assert.equal(f.updates.at(-1).account.username,'New_Name');assert.equal(f.$('username').value,'New_Name');
 assert.equal(f.$('message').textContent,'Profile saved.');f.overlay.dialog.close();
});

test('profile controls stay unavailable during a stale or expired session',async()=>{
 const pending=deferred();let reads=0;const f=fixture({wallet:true,handler:path=>path==='/api/session'&&++reads===2?pending.promise:undefined});await f.overlay.open({});f.overlay.dialog.close();
 const opening=f.overlay.open({});assert.equal(f.$('content').hidden,true);pending.resolve({authenticated:false});await opening;
 assert.equal(f.$('content').hidden,true);assert.match(f.$('message').textContent,/session expired/);f.overlay.dialog.close();
});

test('account events preserve unsaved edits and identity changes revoke profile access',async()=>{
 const f=fixture({wallet:true});await f.overlay.open({});f.$('bio').value='Unsaved profile text';
 f.document.dispatchEvent(new f.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,account:{...f.account,username:'Changed_Name'},token:'new-token'}}));
 assert.equal(f.$('bio').value,'Unsaved profile text');
 await f.$('profile').onsubmit({preventDefault(){}});assert.equal(f.calls.at(-1).headers['x-control-token'],'new-token');
 f.document.dispatchEvent(new f.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,account:{...f.account,id:'b'.repeat(32),username:'another_user'},token:'other-token'}}));
 assert.equal(f.$('content').hidden,true);assert.match(f.$('message').textContent,/session changed/);f.overlay.dialog.close();
 const guest=fixture({wallet:true});await guest.overlay.open({});guest.document.dispatchEvent(new guest.window.CustomEvent('curve-account-updated',{detail:{authenticated:false}}));
 assert.equal(guest.$('content').hidden,true);assert.match(guest.$('message').textContent,/session changed/);guest.overlay.dialog.close();
});

test('toolkit wallet controls remain available and hiding the duplicate launchpad section does not change signing identity',async()=>{
 const f=fixture({wallet:true,features:{toolkit:true}});await f.overlay.open({});assert.equal(f.$('toolkit-wallet').hidden,false);assert.equal(f.$('wallet').textContent,f.account.mainWallet);assert.equal(f.$('signin-wallet').querySelector('[data-siw-address]').textContent,f.account.mainWallet);assert.equal(f.updates.at(-1).account.mainWallet,f.account.mainWallet);assert.equal(f.$('export-controls').hidden,true);f.overlay.dialog.close();
});

test('an expired session publishes the signed-out state and offers sign-in inside the dialog',async()=>{
 let expired=false;const f=fixture({wallet:true,handler:path=>path==='/api/account/profile'&&expired?{__status:401}:undefined});
 await f.overlay.open({});assert.equal(f.$('signin-action').hidden,true);
 expired=true;f.$('bio').value='After expiry';await f.$('profile').onsubmit({preventDefault(){}});
 assert.deepEqual(f.updates.at(-1),{authenticated:false,account:null,token:''});assert.equal(f.$('content').hidden,true);assert.equal(f.$('signin-action').hidden,false);
 assert.match(f.$('message').textContent,/session expired/i);assert.equal(f.$('signin-action').querySelector('a[data-signin-link]').getAttribute('href'),'/?signin=1');
 const signIn=f.$('signin-action').querySelector('a');signIn.addEventListener('click',event=>event.preventDefault());signIn.click();assert.equal(f.overlay.dialog.open,false,'the account dialog closes before sign-in opens');
 const guest=fixture({wallet:true,handler:path=>path==='/api/session'?{authenticated:false}:undefined});await guest.overlay.open({});
 assert.deepEqual(guest.updates.at(-1),{authenticated:false,account:null,token:''});assert.equal(guest.$('signin-action').hidden,false);assert.match(guest.$('message').textContent,/session expired/);
});

test('proxy error pages show readable account text instead of a JSON parser error',async()=>{
 const f=fixture({wallet:true,handler:path=>path==='/api/account'?{__html:502}:undefined});await f.overlay.open({});
 assert.equal(f.$('content').hidden,true);assert.match(f.$('message').textContent,/temporarily unavailable/);assert.doesNotMatch(f.$('message').textContent,/JSON|Unexpected token/);
});
