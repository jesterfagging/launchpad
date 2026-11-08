import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {createCashbackWalletUI} from '../public/cashback-wallet-ui.mjs';
import {createSignInWalletUI} from '../public/signin-wallet-ui.mjs';
import {createEvmWalletLinkUI} from '../public/evm-wallet-link-ui.mjs';
import {validateProfilePicture,optimizeProfileImage} from '../public/profile-image.mjs';

const account={id:'a'.repeat(32),authType:'password',username:'creator',mainWallet:'4'.repeat(44),cashbackWallet:'4'.repeat(44),cashbackBps:2500,role:'user',mfaEnabled:true};
const destination='5'.repeat(44);
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(setImmediate);};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const dialogSupport=window=>{
 window.HTMLElement.prototype.showModal=function(){this.open=true;};
 window.HTMLElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
};
async function profileFixture({guest=false,handler,initialAccount=account,signInFactory=createSignInWalletUI,features={toolkit:true,telegram:true}}={}){
 const {document,window}=parseHTML(await readFile(new URL('../public/wallet-account.html',import.meta.url),'utf8'));dialogSupport(window);
 const source=(await readFile(new URL('../public/wallet-account.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
 let current={...initialAccount};const calls=[],shells=[];
 const fetch=async(path,options={})=>{
  calls.push({path,...options});let value=handler?await handler(path,options):undefined;
  if(value===undefined){
   if(path==='/api/session')value=guest?{authenticated:false}:{authenticated:true,token:'csrf',account:current,features};
   else if(path==='/api/account/cashback-wallet'){current={...current,cashbackWallet:JSON.parse(options.body).address};value={account:current};}
   else if(path==='/api/account/signin-wallet/challenge')value={nonce:'link-nonce',message:'Approve this test wallet link'};
   else if(path==='/api/account/signin-wallet'){current={...current,signInWallet:destination};value={account:current};}
   else if(path==='/api/account/signin-wallet/unlink'){current={...current,signInWallet:''};value={account:current};}
   else value={account:current,cashback:[]};
  }
  if(value?.__status)return {ok:false,status:value.__status,json:async()=>{if(value.__html)throw new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON');return {error:'Sign in to your Launchpad account.'};}};
  return {ok:true,json:async()=>value};
 };
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
 const running=new AsyncFunction('document','fetch','createWorkspaceShell','validateProfilePicture','optimizeProfileImage','createCashbackWalletUI','createSignInWalletUI','createEvmWalletLinkUI',source)(document,fetch,session=>shells.push(session),validateProfilePicture,optimizeProfileImage,createCashbackWalletUI,signInFactory,createEvmWalletLinkUI);
 return {document,window,calls,shells,running,$:id=>document.getElementById(id),cbw:name=>document.querySelector('[data-cbw-'+name+']'),siw:name=>document.querySelector('[data-siw-'+name+']')};
}

test('profile cashback edits verify manual credentials and retain the account wallet and unsaved profile draft',async()=>{
 const f=await profileFixture();await f.running;
 assert.equal(f.$('wallet-profile-logout'),null);
 assert.equal(f.cbw('address').textContent,account.mainWallet);
 f.$('profile-bio').value='Unsaved creator bio';f.cbw('edit').click();f.cbw('input').value=destination;
 const saving=f.cbw('form').onsubmit({preventDefault(){}});await flush();
 assert.equal(f.$('wallet-cashback-auth').open,true);assert.equal(f.$('wallet-cashback-code-label').hidden,false);
 f.$('wallet-cashback-password').value='private-test-password';f.$('wallet-cashback-code').value='123456';
 f.$('wallet-cashback-auth-form').onsubmit({preventDefault(){}});await saving;
 assert.equal(f.$('wallet-cashback-password').value,'');assert.equal(f.$('wallet-cashback-code').value,'');
 const saved=f.calls.find(c=>c.path==='/api/account/cashback-wallet');
 assert.deepEqual(JSON.parse(saved.body),{address:destination,password:'private-test-password',code:'123456'});
 assert.equal(f.cbw('address').textContent,destination);assert.equal(f.$('wallet-profile-address').textContent,account.mainWallet);
 assert.equal(f.$('profile-bio').value,'Unsaved creator bio');assert.match(f.cbw('message').textContent,/saved/);
});

test('header signout session event clears the direct profile page and pending verification credentials',async()=>{
 const f=await profileFixture();await f.running;
 f.$('profile-bio').value='Unsaved profile';f.cbw('edit').click();f.cbw('input').value=destination;
 const saving=f.cbw('form').onsubmit({preventDefault(){}});await flush();
 f.$('wallet-cashback-password').value='discarded';f.$('wallet-cashback-code').value='654321';
 f.document.dispatchEvent(new f.window.CustomEvent('curve-account-updated',{detail:{authenticated:false,account:null,token:''}}));await flush();await saving;
 assert.equal(f.$('wallet-profile').hidden,true);assert.equal(f.$('wallet-profile-gate').hidden,false);assert.equal(f.$('profile-bio').value,'');
 assert.equal(f.$('wallet-cashback-password').value,'');assert.equal(f.$('wallet-cashback-code').value,'');assert.equal(f.$('wallet-cashback-auth').open,false);
 assert.equal(f.calls.some(c=>c.path==='/api/account/cashback-wallet'),false);
});

test('cancelling profile cashback verification clears credentials without saving a destination',async()=>{
 const f=await profileFixture();await f.running;f.cbw('edit').click();f.cbw('input').value=destination;
 const saving=f.cbw('form').onsubmit({preventDefault(){}});await flush();
 f.$('wallet-cashback-password').value='discarded';f.$('wallet-cashback-code').value='654321';f.$('wallet-cashback-auth-cancel').click();await saving;
 assert.equal(f.$('wallet-cashback-password').value,'');assert.equal(f.$('wallet-cashback-code').value,'');
 assert.equal(f.calls.some(c=>c.path==='/api/account/cashback-wallet'),false);assert.equal(f.cbw('address').textContent,account.mainWallet);
});

test('same-page profile sign-in activates the cashback section and ignores an older account response',async()=>{
 const oldRead=deferred();let reads=0;
 const changed={...account,id:'b'.repeat(32),username:'new_creator',mainWallet:'6'.repeat(44),cashbackWallet:'7'.repeat(44)};
 const f=await profileFixture({guest:true,handler:path=>path==='/api/account'?(++reads===1?oldRead.promise:{account:changed,cashback:[]}):undefined});await f.running;
 assert.equal(f.$('wallet-profile').hidden,true);
 f.document.dispatchEvent(new f.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'first',account,features:{toolkit:true,telegram:true}}}));await flush();
 f.document.dispatchEvent(new f.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'second',account:changed,features:{toolkit:true,telegram:true}}}));await flush();
 assert.equal(f.$('wallet-profile').hidden,false);assert.equal(f.cbw('address').textContent,changed.cashbackWallet);
 oldRead.resolve({account,cashback:[]});await flush();assert.equal(f.$('wallet-profile').hidden,false);assert.equal(f.$('wallet-profile-address').textContent,changed.mainWallet);assert.equal(f.cbw('address').textContent,changed.cashbackWallet);
});

test('toolkit account cashback editing reuses its identity check and keeps main-wallet export identity separate',async()=>{
 const {document,window}=parseHTML(await readFile(new URL('../public/index.html',import.meta.url),'utf8'));dialogSupport(window);
 const source=(await readFile(new URL('../public/account-ui.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export function createAccountUI','function createAccountUI');
 const authorizations=[],calls=[];let current={...account};
 const api=async(path,body)=>{calls.push({path,body});if(path==='/api/account/cashback-wallet'){current={...current,cashbackWallet:body.address};return{account:current};}if(path==='/api/account/settings')return{revision:0,settings:{}};return{account:current,cashback:[]};};
 const create=new Function('document','renderHeaderAccount','createAccountSecurity','createAccountConnections','createCashbackWalletUI','createSignInWalletUI','createEvmWalletLinkUI',source+'\nreturn createAccountUI;')(document,()=>{},()=>({render(){},authorize:async title=>{authorizations.push(title);return{password:'verified',code:'123456'};}}),()=>({open(){}}),createCashbackWalletUI,createSignInWalletUI,createEvmWalletLinkUI);
 const ui=create({api,settings:()=>({}),applySettings(){},alertError:error=>{throw Error(error);}});
 await ui.initialize({accounts:true,authenticated:true,account:current,features:{toolkit:true,telegram:true},fees:{version:'test-fees'}});document.getElementById('account-button').click();await flush();
 const box=document.getElementById('account-cashback-wallet'),get=name=>box.querySelector('[data-cbw-'+name+']');
 get('edit').click();get('input').value=destination;await get('form').onsubmit({preventDefault(){}});
 assert.deepEqual(authorizations,['Change cashback wallet']);assert.equal(get('address').textContent,destination);
 assert.equal(document.getElementById('account-main-wallet').textContent,account.mainWallet);
 assert.equal(calls.some(c=>c.path==='/api/account/export'),false);
 get('edit').click();get('input').value='discarded';document.getElementById('account-dialog').close();
 assert.equal(get('form').hidden,true);assert.equal(get('input').value,'');
});


test('manual profile links and unlinks a sign-in wallet without changing account identity, cashback or profile drafts',async()=>{
 const signatures=[];
 const wallet={state:()=>({address:destination,wallets:[]}),onChange:()=>()=>{},signMessage:async message=>{signatures.push(message);return 'proof-signature';}};
 const f=await profileFixture({initialAccount:{...account,role:'admin'},signInFactory:options=>createSignInWalletUI({...options,walletFactory:()=>wallet})});await f.running;
 f.$('profile-bio').value='Unsubmitted bio';f.siw('edit').click();
 assert.match(f.siw('warning').textContent,/administrator account/);
 const saving=f.siw('save').onclick();await flush();
 assert.equal(f.$('wallet-cashback-auth').open,true);assert.equal(f.$('wallet-cashback-code').required,true);
 assert.equal(f.$('wallet-cashback-auth-title').textContent,'Link sign-in wallet');
 f.$('wallet-cashback-password').value='owner-password';f.$('wallet-cashback-code').value='123456';
 f.$('wallet-cashback-auth-form').onsubmit({preventDefault(){}});await saving;
 assert.deepEqual(JSON.parse(f.calls.find(c=>c.path==='/api/account/signin-wallet/challenge').body),{address:destination,password:'owner-password',code:'123456'});
 assert.deepEqual(JSON.parse(f.calls.find(c=>c.path==='/api/account/signin-wallet').body),{nonce:'link-nonce',signature:'proof-signature'});
 assert.deepEqual(signatures,['Approve this test wallet link']);assert.equal(f.siw('address').textContent,destination);
 assert.equal(f.$('wallet-profile-address').textContent,account.mainWallet);assert.equal(f.cbw('address').textContent,account.cashbackWallet);
 assert.equal(f.$('profile-bio').value,'Unsubmitted bio');assert.equal(f.$('wallet-cashback-password').value,'');assert.equal(f.$('wallet-cashback-code').value,'');
 const unlinking=f.siw('unlink').onclick();await flush();
 assert.equal(f.$('wallet-cashback-auth-title').textContent,'Unlink sign-in wallet');
 f.$('wallet-cashback-password').value='owner-password';f.$('wallet-cashback-code').value='654321';f.$('wallet-cashback-auth-form').onsubmit({preventDefault(){}});await unlinking;
 assert.match(f.siw('address').textContent,/No sign-in wallet/);assert.equal(f.siw('unlink').hidden,true);
 assert.equal(f.$('wallet-profile-address').textContent,account.mainWallet);assert.equal(f.$('profile-bio').value,'Unsubmitted bio');
});

test('wallet-created profile displays its sign-in identity without link or unlink controls',async()=>{
 const f=await profileFixture({initialAccount:{...account,authType:'wallet',cashbackWallet:destination}});await f.running;
 assert.equal(f.siw('address').textContent,account.mainWallet);assert.equal(f.cbw('address').textContent,destination);
 assert.equal(f.siw('edit').hidden,true);assert.equal(f.siw('unlink').hidden,true);assert.equal(f.siw('form').hidden,true);
 assert.equal(f.$('wallet-cashback-auth').open,undefined);assert(f.calls.every(call=>!call.method||call.method==='GET'));
});

test('leaving the profile during sign-in wallet verification clears credentials and aborts the link',async()=>{
 const wallet={state:()=>({address:destination,wallets:[]}),onChange:()=>()=>{}};
 const f=await profileFixture({signInFactory:options=>createSignInWalletUI({...options,walletFactory:()=>wallet})});await f.running;
 f.siw('edit').click();const saving=f.siw('save').onclick();await flush();
 f.$('wallet-cashback-password').value='discarded';f.$('wallet-cashback-code').value='123456';f.window.dispatchEvent(new f.window.Event('pagehide'));await saving;
 assert.equal(f.$('wallet-cashback-password').value,'');assert.equal(f.$('wallet-cashback-code').value,'');assert.equal(f.siw('form').hidden,true);
 assert.equal(f.calls.some(call=>call.path==='/api/account/signin-wallet/challenge'),false);
});


test('profile sign-in wallet session rotation is used for later authenticated requests without losing drafts',async()=>{
 const linked={...account,signInWallet:destination};
 const wallet={state:()=>({address:destination,wallets:[]}),onChange:()=>()=>{},signMessage:async()=> 'proof'};
 const f=await profileFixture({handler:path=>path==='/api/account/signin-wallet'?{account:linked,token:'csrf-after-link'}:undefined,signInFactory:options=>createSignInWalletUI({...options,walletFactory:()=>wallet})});await f.running;
 f.$('profile-bio').value='Preserved draft';f.siw('edit').click();const saving=f.siw('save').onclick();await flush();
 f.$('wallet-cashback-password').value='verified';f.$('wallet-cashback-code').value='123456';f.$('wallet-cashback-auth-form').onsubmit({preventDefault(){}});await saving;
 assert.equal(f.$('profile-bio').value,'Preserved draft');assert.equal(f.shells.at(-1).session.token,'csrf-after-link');
 await f.$('profile-form').onsubmit({preventDefault(){}});
 assert.equal(f.calls.find(call=>call.path==='/api/account/profile').headers['x-control-token'],'csrf-after-link');
});


test('late accepted wallet-link session rotation reloads instead of restoring a previous account',async()=>{
 const pending=deferred(),changed={...account,id:'b'.repeat(32),username:'new_account',mainWallet:'6'.repeat(44)};let reads=0,reloads=0;
 const wallet={state:()=>({address:destination,wallets:[]}),onChange:()=>()=>{},signMessage:async()=> 'proof'};
 const f=await profileFixture({handler:path=>path==='/api/account/signin-wallet'?pending.promise:path==='/api/account'&&++reads>1?{account:changed,cashback:[]}:undefined,signInFactory:options=>createSignInWalletUI({...options,walletFactory:()=>wallet})});await f.running;
 f.window.location={reload(){reloads++;}};
 f.siw('edit').click();const saving=f.siw('save').onclick();await flush();
 f.$('wallet-cashback-password').value='verified';f.$('wallet-cashback-code').value='123456';f.$('wallet-cashback-auth-form').onsubmit({preventDefault(){}});await flush();
 f.document.dispatchEvent(new f.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'new-account-token',account:changed}}));await flush();
 assert.equal(f.$('wallet-profile-username').textContent,changed.username);
 pending.resolve({account:{...account,signInWallet:destination},token:'late-old-account-token'});await saving;
 assert.equal(reloads,1);assert.equal(f.$('wallet-profile-username').textContent,changed.username);
});

test('launchpad profile leaves cashback unmounted but preserves trading identity and creator management',async()=>{
 const f=await profileFixture({features:{}});await f.running;
 assert.equal(f.$('wallet-profile-cashback-section').hidden,true);assert.equal(f.$('wallet-profile-cashback-wallet').children.length,0);
 assert.equal(f.$('wallet-profile-rate').textContent,'');assert.equal(f.$('wallet-profile-cashback').textContent,'');assert.equal(f.cbw('edit'),null);
 assert.equal(f.$('wallet-profile-wallet-section').hidden,false);assert.equal(f.$('wallet-profile-address').textContent,account.mainWallet);
 assert.equal(f.siw('edit').hidden,false);assert.ok(f.document.querySelector('a[href="/launched-tokens"]'));
 assert.match(f.$('wallet-profile-security').textContent,/Account recovery/);assert.equal(f.$('wallet-profile-wallet-title').textContent,'Legacy trading wallet');assert.match(f.$('wallet-profile-wallet-note').textContent,/Link an external wallet/);
 f.$('profile-bio').value='Launchpad creator';await f.$('profile-form').onsubmit({preventDefault(){}});
 assert.deepEqual(f.shells.at(-1).session.features,{});assert(f.calls.every(c=>!c.path.includes('cashback')&&!c.path.includes('telegram')&&!c.path.includes('connections')));
});

test('legacy account dialog defaults to launchpad controls without fetching or mounting toolkit settings',async()=>{
 const {document,window}=parseHTML(await readFile(new URL('../public/index.html',import.meta.url),'utf8'));dialogSupport(window);
 const source=(await readFile(new URL('../public/account-ui.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export function createAccountUI','function createAccountUI');
 const calls=[];let connectionMounts=0,cashbackMounts=0;
 const create=new Function('document','renderHeaderAccount','createAccountSecurity','createAccountConnections','createCashbackWalletUI','createSignInWalletUI','createEvmWalletLinkUI',source+'\nreturn createAccountUI;')(document,()=>{},()=>({render(){},authorize:async()=>({password:'verified'})}),()=>{connectionMounts++;return{open(){}};},()=>{cashbackMounts++;return{render(){},cancel(){}};},createSignInWalletUI,createEvmWalletLinkUI);
 const ui=create({api:async(path)=>{calls.push(path);return{account,cashback:[]};},settings:()=>({}),applySettings(){},alertError:error=>{throw Error(error);}});
 await ui.initialize({accounts:true,authenticated:true,account});document.getElementById('account-button').click();await flush();
 assert.equal(connectionMounts,0);assert.equal(cashbackMounts,0);assert.equal(calls.includes('/api/account/settings'),false);
 for(const id of ['account-cashback-section','account-telegram-section','account-save-dialog','account-toolkit-signout-note'])assert.equal(document.getElementById(id).hidden,true);
 assert.equal(document.getElementById('account-main-wallet').textContent,account.mainWallet);assert.ok(document.getElementById('account-export-details'));
 assert.ok(document.querySelector('#account-dialog a[href="/launched-tokens"]'));ui.openConnections();assert.equal(connectionMounts,0);
 assert.deepEqual([...document.querySelector('#account-dialog .account-tabs').children].map(node=>node.textContent),['Overview','My Profile','Launched tokens']);
 const profileLink=document.querySelector('#account-dialog [data-my-profile]');assert.equal(profileLink.getAttribute('href'),'/user/'+account.username.toLowerCase());assert.equal(document.getElementById('account-trading-wallet').hidden,false);
 document.getElementById('account-dialog').close();
 const connected={...account,authType:'wallet',username:'Wallet_Owner'};await ui.initialize({accounts:true,authenticated:true,account:connected,features:{walletOnly:true}});
 assert.equal(profileLink.getAttribute('href'),'/user/wallet_owner');assert.equal(document.getElementById('account-trading-wallet').hidden,true);assert.equal(document.querySelector('#account-signin-wallet [data-siw-address]').textContent,account.mainWallet);
 await ui.initialize({accounts:true,authenticated:false,features:{walletOnly:true}});
 assert.equal(profileLink.hidden,true);assert.equal(profileLink.hasAttribute('href'),false);
 assert.equal(document.getElementById('auth-form').hidden,true);assert.equal(document.getElementById('auth-switch').hidden,true);
 document.getElementById('auth-switch').click();await document.getElementById('auth-form').onsubmit({preventDefault(){}});assert.ok(!calls.includes('/api/account/register'));
 document.getElementById('auth-recovery').click();assert.equal(document.getElementById('auth-form').hidden,false);assert.equal(document.getElementById('auth-submit').textContent,'Recover account');
});


test('profile initializes the shared header and footer before a slow or failed session read',async()=>{
 const pending=deferred(),f=await profileFixture({features:{walletOnly:true},handler:path=>path==='/api/session'?pending.promise:undefined});
 assert.deepEqual(f.shells[0],{page:'wallet-account'});assert.equal(f.shells.length,1);
 pending.resolve({authenticated:false,features:{walletOnly:true}});await f.running;
 assert.equal(f.$('wallet-profile-gate').hidden,false);assert.match(f.$('wallet-profile-gate-note').textContent,/profile is optional/);assert.equal(f.$('wallet-profile-gate').querySelector('a').textContent,'Connect wallet');
});

test('profile account settings open the header Edit profile entry, not the profile menu toggle',async()=>{
 const f=await profileFixture();await f.running;let menuClicks=0,editClicks=0;
 f.document.querySelector('[data-account-link]').addEventListener('click',event=>{event.preventDefault();menuClicks++;});
 const edit=f.document.createElement('a');edit.dataset.accountEdit='true';edit.href='/?account=overview';edit.addEventListener('click',event=>{event.preventDefault();editClicks++;});f.document.body.append(edit);
 f.$('wallet-profile-security').onclick();assert.equal(editClicks,1);assert.equal(menuClicks,0);
 edit.remove();f.$('wallet-profile-security').onclick();assert.equal(menuClicks,1,'signed out: the account button opens sign-in');
});

test('a saved profile is published to the header as the full session',async()=>{
 const f=await profileFixture({features:{walletOnly:true},handler:(path,options)=>path==='/api/account/profile'?{account:{...account,username:JSON.parse(options.body).username}}:undefined});await f.running;const events=[];f.document.addEventListener('curve-account-updated',event=>events.push(event.detail));
 f.$('profile-username').value='renamed_creator';await f.$('profile-form').onsubmit({preventDefault(){}});
 assert.equal(f.$('profile-message').textContent,'Profile saved.');assert.equal(events.length,1);
 assert.equal(events[0].authenticated,true);assert.equal(events[0].account.username,'renamed_creator');assert.equal(events[0].token,'csrf');assert.deepEqual(events[0].features,{walletOnly:true});
 assert.equal(f.$('wallet-profile-username').textContent,'renamed_creator');assert.equal(f.$('wallet-profile').hidden,false);
});

test('an expired session signs the page and header out, and a proxy error page shows readable text and retries',async()=>{
 const f=await profileFixture({handler:path=>path==='/api/account/profile'?{__status:401}:undefined});await f.running;const events=[];f.document.addEventListener('curve-account-updated',event=>events.push(event.detail));
 await f.$('profile-form').onsubmit({preventDefault(){}});
 assert.deepEqual(events,[{authenticated:false,account:null,token:''}]);assert.equal(f.$('wallet-profile').hidden,true);assert.equal(f.$('wallet-profile-gate').hidden,false);assert.match(f.$('wallet-profile-gate-note').textContent,/^Your session expired\./);
 let fail=true;const g=await profileFixture({handler:path=>path==='/api/session'&&fail?{__status:502,__html:true}:undefined});await g.running;
 assert.equal(g.$('wallet-profile-error').hidden,false);assert.match(g.$('wallet-profile-error').textContent,/could not be loaded right now\. Retrying automatically/);assert.doesNotMatch(g.$('wallet-profile-error').textContent,/JSON|Unexpected token/);
 fail=false;await new Promise(resolve=>setTimeout(resolve,5300));await flush();assert.equal(g.$('wallet-profile-error').hidden,true);assert.equal(g.$('wallet-profile').hidden,false);
});
