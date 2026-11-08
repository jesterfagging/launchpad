import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createSignInOverlay} from '../public/signin-overlay.mjs';
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(setImmediate);};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function fixture({handler,signer,features={walletOnly:false}}={}){
 const {document,window}=parseHTML('<html><body><main><input id="draft" value="Untouched launch draft"></main><button id="trigger">Sign in</button></body></html>');
 window.HTMLElement.prototype.showModal=function(){this.open=true;this.setAttribute('open','');};window.HTMLElement.prototype.close=function(){this.open=false;this.removeAttribute('open');this.dispatchEvent(new window.Event('close'));};
 let connected='',proofs=0;const calls=[],updates=[],scroll=[],account={id:'a'.repeat(32),username:'returning_creator',authType:'wallet',mainWallet:'7'.repeat(44)},session={authenticated:true,account,token:'csrf-confirmed'};
 const wallet={state:()=>({address:connected,wallets:[{id:'test-wallet',name:'Test wallet'}]}),onChange:()=>()=>{},connect:async()=>{connected=account.mainWallet;},signMessage:async message=>{proofs++;assert.equal(message,'Exact signed challenge');return signer?signer(): 'signed-proof';}};
 const fetcher=async(path,options={})=>{calls.push({path,...options});let value=handler?await handler(path,options):undefined;if(value!==undefined)return value;if(path==='/api/session')value=session;else if(path==='/api/wallet/challenge')value={nonce:'one-use-proof',message:'Exact signed challenge'};else value=session;return{ok:true,json:async()=>value};};
 const overlay=createSignInOverlay({document,window:{...window,scrollX:0,scrollY:490,scrollTo:(...v)=>scroll.push(v)},fetcher,walletFactory:()=>wallet,getFeatures:()=>features,onSession:next=>updates.push(next)});
 overlay.open(document.getElementById('trigger'));
 return{document,window,overlay,calls,updates,scroll,account,session,get proofs(){return proofs;},$:name=>overlay.dialog.querySelector('[data-'+name+']')};
}
test('wallet sign-in is independent of manual fields, proves the exact challenge and publishes the existing account',async()=>{
 const f=fixture();assert.equal(f.$('username').value,'');assert.equal(f.$('password').value,'');assert.equal(f.$('connect').type,'button');assert.equal(f.overlay.dialog.querySelector('.signin-divider').textContent,'OR');assert.equal(f.$('manual-heading').textContent,'Sign in with username and password');
 f.$('connect').click();await flush();assert.equal(f.proofs,1);assert.deepEqual(f.calls.map(c=>c.path),['/api/wallet/challenge','/api/wallet/verify','/api/session']);assert.deepEqual(JSON.parse(f.calls[0].body),{address:f.account.mainWallet});assert.deepEqual(JSON.parse(f.calls[1].body),{nonce:'one-use-proof',signature:'signed-proof'});assert.equal(f.updates[0].account.id,f.account.id);assert.equal(f.overlay.dialog.open,false);assert.deepEqual(f.scroll,[[0,490]]);assert.equal(f.document.getElementById('draft').value,'Untouched launch draft');
});
test('manual sign-in reveals MFA only when required and does not connect a wallet',async()=>{
 let attempts=0;const f=fixture({handler:path=>path==='/api/account/login'&&++attempts===1?{ok:false,json:async()=>({error:'Enter your authenticator or recovery code.',mfaRequired:true})}:undefined});
 assert.equal(f.$('code-label').hidden,true);f.$('username').value='manual_creator';f.$('password').value='private-password';await f.$('form').onsubmit({preventDefault(){}});assert.equal(f.$('code-label').hidden,false);assert.equal(f.$('code').required,true);assert.equal(f.$('password').value,'private-password');assert.equal(f.proofs,0);
 f.$('code').value='123456';await f.$('form').onsubmit({preventDefault(){}});assert.deepEqual(JSON.parse(f.calls[1].body),{username:'manual_creator',password:'private-password',code:'123456'});assert.equal(f.updates.length,1);assert.equal(f.overlay.dialog.open,false);assert.equal(f.$('password').value,'');assert.equal(f.$('code').value,'');assert(f.calls.every(c=>!c.path.startsWith('/api/wallet/')));
});
test('closing while the wallet approves prevents verification and cannot sign in silently',async()=>{
 const pending=deferred(),f=fixture({signer:()=>pending.promise});f.$('connect').click();await flush();assert.equal(f.proofs,1);f.overlay.dialog.close();pending.resolve('late-proof');await flush();assert.deepEqual(f.calls.map(c=>c.path),['/api/wallet/challenge']);assert.equal(f.updates.length,0);
});
test('an accepted late login synchronizes the current session and closes a reopened dialog without a second authentication',async()=>{
 const pending=deferred(),f=fixture({handler:path=>path==='/api/account/login'?pending.promise:undefined});f.$('username').value='manual_creator';f.$('password').value='private-password';const login=f.$('form').onsubmit({preventDefault(){}});f.overlay.dialog.close();f.overlay.open(f.document.getElementById('trigger'));assert.equal(f.$('submit').disabled,true);await f.$('form').onsubmit({preventDefault(){}});assert.equal(f.calls.length,1);pending.resolve({ok:true,json:async()=>f.session});await login;assert.equal(f.updates.length,1);assert.equal(f.overlay.dialog.open,false);assert.equal(f.$('password').value,'');assert.equal(f.$('submit').disabled,false);
});
test('stale failed login cannot repopulate a reopened dialog; registration uses its own clear label',async()=>{
 const pending=deferred(),f=fixture({handler:path=>path==='/api/account/login'?pending.promise:undefined});f.$('password').value='private-password';const login=f.$('form').onsubmit({preventDefault(){}});f.overlay.dialog.close();f.overlay.open();pending.resolve({ok:false,json:async()=>({error:'Old failed authentication',mfaRequired:true})});await login;assert.equal(f.$('message').textContent,'');assert.equal(f.$('code-label').hidden,true);f.$('mode').click();assert.equal(f.$('manual-heading').textContent,'Create an account with username and password');assert.equal(f.$('password').autocomplete,'new-password');
});

test('switching from a manual MFA challenge to wallet sign-in never requires an OTP',async()=>{
 const f=fixture({handler:path=>path==='/api/account/login'?{ok:false,json:async()=>({error:'Enter your authenticator or recovery code.',mfaRequired:true})}:undefined});f.$('username').value='manual_creator';f.$('password').value='private-password';await f.$('form').onsubmit({preventDefault(){}});assert.equal(f.$('code-label').hidden,false);assert.equal(f.$('code').value,'');f.$('connect').click();await flush();assert.equal(f.proofs,1);assert.equal(f.updates.length,1);assert.equal(f.updates[0].account.authType,'wallet');assert.equal(f.overlay.dialog.open,false);const verification=f.calls.find(c=>c.path==='/api/wallet/verify');assert.deepEqual(Object.keys(JSON.parse(verification.body)).sort(),['nonce','signature']);
});


test('wallet-only is the safe default, with automatic account wording and no public registration',async()=>{
 for(const features of [{},{walletOnly:true},{walletOnly:'false'},{walletOnly:null}]){
  const f=fixture({features});assert.equal(f.$('manual').hidden,true);assert.equal(f.$('mode').hidden,true);assert.equal(f.$('recovery').hidden,false);
  assert.match(f.$('intro').textContent,/account is created automatically/);assert.match(f.$('intro').textContent,/profile is optional/);
  assert.equal(f.overlay.dialog.querySelector('.signin-policy-note a').getAttribute('href'),'/terms');assert.equal(f.overlay.dialog.querySelectorAll('.signin-policy-note a')[1].getAttribute('href'),'/privacy');
  f.$('mode').click();await f.$('form').onsubmit({preventDefault(){}});assert.equal(f.calls.length,0);
  f.$('connect').click();await flush();assert.equal(f.updates.length,1);assert.equal(f.calls.some(c=>c.path==='/api/account/register'),false);assert.equal(f.proofs,1);
 }
});

test('existing-account recovery is explicit and retains password MFA without permitting registration',async()=>{
 let attempts=0;const f=fixture({features:{walletOnly:true},handler:path=>path==='/api/account/login'&&++attempts===1?{ok:false,json:async()=>({error:'Authenticator required',mfaRequired:true})}:undefined});
 f.$('recovery').click();assert.equal(f.$('manual').hidden,false);assert.equal(f.$('recovery').getAttribute('aria-expanded'),'true');assert.equal(f.$('manual-heading').textContent,'Recover an existing account');assert.equal(f.$('submit').textContent,'Recover account');assert.equal(f.$('mode').hidden,true);
 f.$('username').value='existing_admin';f.$('password').value='existing-password';f.$('mode').click();await f.$('form').onsubmit({preventDefault(){}});assert.equal(f.$('code-label').hidden,false);
 f.$('code').value='123456';await f.$('form').onsubmit({preventDefault(){}});assert.equal(f.calls[0].path,'/api/account/login');assert.equal(f.calls[1].path,'/api/account/login');assert.equal(f.proofs,0);assert.equal(f.updates.length,1);assert.equal(f.$('password').value,'');
 f.overlay.open();assert.equal(f.$('manual').hidden,true);assert.equal(f.$('code').value,'');
});

test('wallet-only changes revoke an open legacy registration form before it can submit',async()=>{
 const features={walletOnly:false},f=fixture({features});f.$('mode').click();assert.equal(f.$('submit').textContent,'Create account');
 features.walletOnly=true;await f.$('form').onsubmit({preventDefault(){}});assert.equal(f.calls.length,0);
 f.overlay.dialog.close();f.overlay.open();assert.equal(f.$('manual').hidden,true);assert.equal(f.$('mode').hidden,true);
 f.$('recovery').click();f.$('password').value='discarded';f.$('code').value='123456';f.$('recovery').click();assert.equal(f.$('manual').hidden,true);assert.equal(f.$('password').value,'');assert.equal(f.$('code').value,'');
});

test('an idle sign-in dialog never holds page navigation, a pending wallet approval does, and a page change keeps the new page scroll and focus',async()=>{
 const pending=deferred(),f=fixture({signer:()=>pending.promise}),dialog=f.overlay.dialog,trigger=f.document.getElementById('trigger');let focused=0;trigger.focus=()=>{focused++;};
 assert.equal(dialog.hasAttribute('data-navigation-free'),true,'Terms, Privacy, Back and reload work while nothing is pending');
 f.$('connect').click();await flush();assert.equal(f.proofs,1);assert.equal(dialog.hasAttribute('data-navigation-free'),false,'a wallet approval in progress keeps the page');
 pending.resolve('signed-proof');await flush();assert.equal(dialog.open,false);assert.equal(dialog.hasAttribute('data-navigation-free'),true);
 f.overlay.open(trigger);f.scroll.length=0;focused=0;
 f.document.dispatchEvent(new f.window.CustomEvent('curve-navigation-start',{detail:{page:'terms'}}));dialog.close();
 assert.deepEqual(f.scroll,[],'the previous page scroll position is not restored on the new page');assert.equal(focused,0);assert.equal(f.document.body.style.overflow,'');
 f.overlay.open(trigger);dialog.close();assert.deepEqual(f.scroll,[[0,490]]);assert.equal(focused,1,'an ordinary close still returns focus to the trigger');
});
