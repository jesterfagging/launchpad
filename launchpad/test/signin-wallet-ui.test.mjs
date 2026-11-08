import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createSignInWalletUI} from '../public/signin-wallet-ui.mjs';

const main='4'.repeat(44),target='5'.repeat(44),replacement='6'.repeat(44);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(setImmediate);};

function fixture({wallet=false,linked='',previous=null,connected=true,handler,authorization,sign}={}){
  const {document,window}=parseHTML('<html><body><div id="container"></div></body></html>');
  let account={id:'manual-owner',username:'creator',authType:wallet?'wallet':'password',mainWallet:main,cashbackWallet:replacement,signInWallet:linked,walletAccount:previous,role:'user'},active=true,address=connected?target:'';
  const calls=[],proofs=[],updates=[],authorizations=[],connections=[],reloads=[],listeners=new Set();
  const location={href:'https://launch.example/coin/test-mint?tab=holders',reload(){reloads.push(this.href);}};
  const walletState={state:()=>({address,wallets:[{id:'test-wallet',name:'Test wallet'}]}),onChange:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},connect:async id=>{connections.push(id);address=target;for(const listener of listeners)listener(walletState.state());},signMessage:async message=>{proofs.push(message);return sign?sign(message):'signed-proof';}};
  const ui=createSignInWalletUI({document,window:{...window,location},container:document.getElementById('container'),getAccount:()=>account,isActive:()=>active,
    walletFactory:()=>walletState,
    authorize:async action=>{authorizations.push(action);return authorization?authorization(action):{password:'fresh-password',code:'123456'};},
    api:async(path,body)=>{calls.push({path,body});if(handler){const result=await handler(path,body);if(result!==undefined)return result;}if(path.endsWith('/challenge'))return{nonce:'single-use-nonce',message:'Exact server-issued link challenge'};if(path==='/api/wallet/verify')return{authenticated:true,account:{id:previous?.id,username:previous?.username,authType:'wallet',mainWallet:target}};return{account:{...account,signInWallet:path.endsWith('/unlink')?'':target}};},
    onSaved:value=>{account=value;updates.push(value);}});
  ui.render();
  const $=name=>document.querySelector('[data-siw-'+name+']');
  return{document,ui,$,calls,proofs,updates,authorizations,connections,reloads,location,get account(){return account;},setAccount:value=>{account=value;},setAddress:value=>{address=value;for(const listener of listeners)listener(walletState.state());},edit:()=>$('edit').onclick(),submit:()=>$('save').onclick(),close(){active=false;ui.cancel();}};
}

test('manual sign-in wallet linking requires fresh credentials and the exact wallet challenge',async()=>{
  const f=fixture();f.edit();await f.submit();
  assert.deepEqual(f.authorizations,['Link sign-in wallet']);
  assert.deepEqual(f.proofs,['Exact server-issued link challenge']);
  assert.deepEqual(f.calls,[
    {path:'/api/account/signin-wallet/challenge',body:{address:target,password:'fresh-password',code:'123456'}},
    {path:'/api/account/signin-wallet',body:{nonce:'single-use-nonce',signature:'signed-proof'}},
  ]);
  assert.equal(f.updates.length,1);assert.equal(f.account.signInWallet,target);
  assert.equal(f.account.mainWallet,main);assert.equal(f.account.cashbackWallet,replacement);assert.equal(f.account.role,'user');
  assert.equal(f.$('address').textContent,target);assert.equal(f.$('form').hidden,true);
});

test('wallet-created accounts remain read-only even when hidden action handlers are called directly',async()=>{
  const f=fixture({wallet:true});
  assert.equal(f.$('address').textContent,main);
  assert.equal(f.$('edit').hidden,true);assert.equal(f.$('unlink').hidden,true);
  f.$('edit').onclick();await f.submit();await f.$('unlink').onclick();
  assert.equal(f.$('form').hidden,true);assert.equal(f.authorizations.length,0);assert.equal(f.calls.length,0);assert.equal(f.proofs.length,0);assert.equal(f.updates.length,0);
});

test('connecting a discovered wallet enables linking but does not authenticate or write until explicitly saved',async()=>{
  const f=fixture({connected:false});f.edit();assert.equal(f.$('save').disabled,true);
  await f.submit();assert.equal(f.authorizations.length,0);assert.equal(f.calls.length,0);
  await f.$('connect').onclick();assert.deepEqual(f.connections,['test-wallet']);assert.equal(f.$('selected').textContent,target);assert.equal(f.$('save').disabled,false);
  assert.equal(f.authorizations.length,0);assert.equal(f.calls.length,0);assert.equal(f.proofs.length,0);
  await f.submit();assert.equal(f.account.signInWallet,target);
});

test('cancelling while password verification is pending prevents all wallet proof requests',async()=>{
  const pending=deferred(),f=fixture({authorization:()=>pending.promise});f.edit();const saving=f.submit();await flush();
  f.close();pending.resolve({password:'fresh-password',code:'123456'});await saving;
  assert.equal(f.calls.length,0);assert.equal(f.proofs.length,0);assert.equal(f.updates.length,0);
});

test('cancelling while the challenge loads never asks the wallet to sign',async()=>{
  const pending=deferred(),f=fixture({handler:path=>path.endsWith('/challenge')?pending.promise:undefined});f.edit();const saving=f.submit();await flush();
  f.close();pending.resolve({nonce:'late-nonce',message:'Late server challenge'});await saving;
  assert.equal(f.calls.length,1);assert.equal(f.proofs.length,0);assert.equal(f.updates.length,0);
});

test('a different connected wallet before signing cannot approve the original address',async()=>{
  const pending=deferred(),f=fixture({handler:path=>path.endsWith('/challenge')?pending.promise:undefined});f.edit();const saving=f.submit();await flush();
  f.setAddress(replacement);pending.resolve({nonce:'nonce',message:'Exact server-issued link challenge'});await saving;
  assert.equal(f.calls.length,1);assert.equal(f.proofs.length,0);assert.equal(f.updates.length,0);assert.match(f.$('message').textContent,/wallet changed/i);
});

test('a wallet change during message approval prevents the link submission',async()=>{
  const pending=deferred(),f=fixture({sign:()=>pending.promise});f.edit();const saving=f.submit();await flush();
  f.setAddress(replacement);pending.resolve('late-signature');await saving;
  assert.equal(f.proofs.length,1);assert.equal(f.calls.length,1);assert.equal(f.updates.length,0);assert.match(f.$('message').textContent,/wallet changed/i);
});

test('repeated submissions cannot duplicate verification, signing, or linking',async()=>{
  const pending=deferred(),f=fixture({authorization:()=>pending.promise});f.edit();const first=f.submit();await flush();await f.submit();
  assert.equal(f.authorizations.length,1);assert.equal(f.calls.length,0);
  pending.resolve({password:'fresh-password',code:'123456'});await first;
  assert.equal(f.proofs.length,1);assert.equal(f.calls.length,2);assert.equal(f.updates.length,1);
});

test('a completed request cannot replace the active account after the session changes',async()=>{
  const pending=deferred(),f=fixture({handler:path=>path==='/api/account/signin-wallet'?pending.promise:undefined});f.edit();const original={...f.account};const saving=f.submit();await flush();
  f.setAccount({...original,id:'different-account',username:'other_creator'});f.ui.render();pending.resolve({account:{...original,signInWallet:target}});await saving;
  assert.equal(f.updates.length,0);assert.equal(f.account.id,'different-account');assert.equal(f.account.signInWallet,'');
});

test('a response for a different account is rejected without changing the current account',async()=>{
  const f=fixture({handler:path=>path==='/api/account/signin-wallet'?{account:{id:'different-account',signInWallet:target}}:undefined});f.edit();await f.submit();
  assert.equal(f.updates.length,0);assert.equal(f.account.id,'manual-owner');assert.equal(f.account.signInWallet,'');assert.match(f.$('message').textContent,/account changed/i);
});

test('an accepted late link cannot repopulate a closed editor',async()=>{
  const pending=deferred(),f=fixture({handler:path=>path==='/api/account/signin-wallet'?pending.promise:undefined});f.edit();const saving=f.submit();await flush();
  f.close();pending.resolve({account:{...f.account,signInWallet:target}});await saving;
  assert.equal(f.updates.length,0);assert.equal(f.$('form').hidden,true);assert.equal(f.$('message').textContent,'');
});

test('unlinking requires fresh credentials and preserves the account and receiving wallets',async()=>{
  const f=fixture({linked:target});await f.$('unlink').onclick();
  assert.equal(f.authorizations.length,1);assert.match(f.authorizations[0],/unlink sign-in wallet/i);
  assert.deepEqual(f.calls,[{path:'/api/account/signin-wallet/unlink',body:{password:'fresh-password',code:'123456'}}]);
  assert.equal(f.proofs.length,0);assert.equal(f.updates.length,1);assert.equal(f.account.signInWallet,'');assert.equal(f.account.mainWallet,main);assert.equal(f.account.cashbackWallet,replacement);assert.equal(f.account.role,'user');assert.equal(f.$('unlink').hidden,true);
});

test('cancelled unlink authorization cannot remove an existing sign-in wallet',async()=>{
  const pending=deferred(),f=fixture({linked:target,authorization:()=>pending.promise});const unlinking=f.$('unlink').onclick();await flush();f.close();
  pending.resolve({password:'fresh-password',code:'123456'});await unlinking;
  assert.equal(f.calls.length,0);assert.equal(f.updates.length,0);assert.equal(f.account.signInWallet,target);
});

const previousAccount={id:'preserved-wallet-account',username:'original_creator'};

test('opening a preserved wallet account proves its explicit target and reloads the same URL',async()=>{
  const f=fixture({linked:target,previous:previousAccount});assert.equal(f.$('previous').hidden,false);assert.equal(f.$('previous-name').textContent,'original_creator');
  await f.$('previous-open').onclick();
  assert.deepEqual(f.calls,[
    {path:'/api/wallet/challenge',body:{address:target,accountId:'preserved-wallet-account'}},
    {path:'/api/wallet/verify',body:{nonce:'single-use-nonce',signature:'signed-proof'}},
  ]);
  assert.deepEqual(f.proofs,['Exact server-issued link challenge']);assert.deepEqual(f.reloads,['https://launch.example/coin/test-mint?tab=holders']);
  assert.equal(f.authorizations.length,0);assert.equal(f.updates.length,0);assert.equal(f.account.id,'manual-owner');
});

test('the previous-account action is absent and inert without an eligible manual account and linked target',async()=>{
  for(const options of [{linked:target},{previous:previousAccount},{wallet:true,linked:target,previous:previousAccount}]){
    const f=fixture(options);assert.equal(f.$('previous').hidden,true);await f.$('previous-open').onclick();
    assert.equal(f.calls.length,0);assert.equal(f.proofs.length,0);assert.equal(f.authorizations.length,0);assert.equal(f.reloads.length,0);
  }
});

test('opening the previous account connects the linked wallet before requesting its proof',async()=>{
  const f=fixture({linked:target,previous:previousAccount,connected:false});await f.$('previous-open').onclick();
  assert.equal(f.$('previous-wallets').hidden,false);assert.equal(f.calls.length,0);assert.equal(f.proofs.length,0);
  await f.$('previous-wallets').querySelector('button').onclick();
  assert.deepEqual(f.connections,['test-wallet']);assert.equal(f.calls[0].body.accountId,previousAccount.id);assert.equal(f.reloads.length,1);assert.equal(f.updates.length,0);
});

test('closing during a previous-account challenge prevents signing and changing the session',async()=>{
  const pending=deferred(),f=fixture({linked:target,previous:previousAccount,handler:path=>path==='/api/wallet/challenge'?pending.promise:undefined});
  const opening=f.$('previous-open').onclick();await flush();f.close();pending.resolve({nonce:'late-nonce',message:'Late challenge'});await opening;
  assert.equal(f.calls.length,1);assert.equal(f.proofs.length,0);assert.equal(f.reloads.length,0);assert.equal(f.updates.length,0);
});

test('a changed current account cannot continue a previous-account challenge',async()=>{
  const pending=deferred(),f=fixture({linked:target,previous:previousAccount,handler:path=>path==='/api/wallet/challenge'?pending.promise:undefined});
  const opening=f.$('previous-open').onclick();await flush();f.setAccount({...f.account,id:'other-manual-account'});f.ui.render();pending.resolve({nonce:'nonce',message:'Original target challenge'});await opening;
  assert.equal(f.calls.length,1);assert.equal(f.proofs.length,0);assert.equal(f.reloads.length,0);assert.equal(f.updates.length,0);
});

test('a wallet changed during previous-account signing cannot submit that proof',async()=>{
  const pending=deferred(),f=fixture({linked:target,previous:previousAccount,sign:()=>pending.promise});
  const opening=f.$('previous-open').onclick();await flush();f.setAddress(replacement);pending.resolve('wrong-wallet-proof');await opening;
  assert.equal(f.calls.length,1);assert.equal(f.reloads.length,0);assert.equal(f.updates.length,0);assert.match(f.$('message').textContent,/wallet changed/i);
});

test('an accepted previous-account proof reloads even after the editor closes because its session cookie changed',async()=>{
  const pending=deferred(),f=fixture({linked:target,previous:previousAccount,handler:path=>path==='/api/wallet/verify'?pending.promise:undefined});
  const opening=f.$('previous-open').onclick();await flush();assert.equal(f.calls.length,2);f.close();pending.resolve({authenticated:true,account:{id:previousAccount.id}});await opening;
  assert.deepEqual(f.reloads,['https://launch.example/coin/test-mint?tab=holders']);assert.equal(f.updates.length,0);
});

test('a previous-account verification for the wrong identity is rejected without publishing account details',async()=>{
  const f=fixture({linked:target,previous:previousAccount,handler:path=>path==='/api/wallet/verify'?{authenticated:true,account:{id:'unexpected-account'}}:undefined});
  await f.$('previous-open').onclick();assert.equal(f.reloads.length,0);assert.equal(f.updates.length,0);assert.equal(f.account.id,'manual-owner');assert.match(f.$('message').textContent,/sign-in changed/i);
});

test('repeated previous-account clicks cannot issue duplicate sign-in proofs',async()=>{
  const pending=deferred(),f=fixture({linked:target,previous:previousAccount,handler:path=>path==='/api/wallet/challenge'?pending.promise:undefined});
  const first=f.$('previous-open').onclick();await flush();await f.$('previous-open').onclick();assert.equal(f.calls.length,1);
  pending.resolve({nonce:'nonce',message:'Previous account challenge'});await first;assert.equal(f.proofs.length,1);assert.equal(f.calls.length,2);assert.equal(f.reloads.length,1);
});
