import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createCashbackWalletUI} from '../public/cashback-wallet-ui.mjs';
const main='4'.repeat(44),target='5'.repeat(44);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(setImmediate);};
function fixture({wallet=false,handler,sign,connected=true}={}){
 const {document,window}=parseHTML('<html><body><div id="container"></div></body></html>');
 let account={id:'own-account',authType:wallet?'wallet':'password',mainWallet:main,cashbackWallet:main},active=true,address=connected?main:'';
 const calls=[],proofs=[],updates=[];let authorizations=0;
 const ui=createCashbackWalletUI({document,window:{...window,navigator:{clipboard:{writeText:async()=>{}}}},container:document.getElementById('container'),getAccount:()=>account,isActive:()=>active,
  authorize:async()=>{authorizations++;return{password:'verified-password',code:'123456'};},
  walletFactory:()=>({state:()=>({address,wallets:[{id:'test-wallet',name:'Test wallet'}]}),connect:async()=>{address=main;},signMessage:async message=>{proofs.push(message);return sign?sign(message):'signed-proof';}}),
  api:async(path,body)=>{calls.push({path,body});if(handler){const result=await handler(path,body);if(result!==undefined)return result;}return path.endsWith('/challenge')?{nonce:'destination-nonce',message:'Change cashback to '+body.address}:{account:{...account,cashbackWallet:body.address}};},
  onSaved:value=>{account=value;updates.push(value);}});
 ui.render();const $=name=>document.querySelector('[data-cbw-'+name+']');
 const edit=()=>{$('edit').click();$('input').value=target;};
 return {ui,$,edit,calls,proofs,updates,get account(){return account;},get authorizations(){return authorizations;},setAddress:value=>address=value,close(){active=false;ui.cancel();}};
}
test('manual cashback edits verify credentials and change only the receiving preference',async()=>{
 const f=fixture();f.edit();await f.$('form').onsubmit({preventDefault(){}});
 assert.equal(f.authorizations,1);assert.deepEqual(f.calls,[{path:'/api/account/cashback-wallet',body:{address:target,password:'verified-password',code:'123456'}}]);
 assert.equal(f.account.mainWallet,main);assert.equal(f.account.cashbackWallet,target);assert.equal(f.$('address').textContent,target);assert.equal(f.$('form').hidden,true);assert.match(f.$('message').textContent,/saved/);
});
test('wallet cashback edit connects the sign-in wallet and signs the target challenge without manual credentials',async()=>{
 const f=fixture({wallet:true,connected:false});f.edit();await f.$('form').onsubmit({preventDefault(){}});assert.equal(f.calls.length,0);assert.equal(f.$('wallets').hidden,false);
 await f.$('wallets').querySelector('button').onclick();assert.equal(f.authorizations,0);assert.deepEqual(f.proofs,['Change cashback to '+target]);
 assert.deepEqual(f.calls,[{path:'/api/account/cashback-wallet/challenge',body:{address:target}},{path:'/api/account/cashback-wallet',body:{address:target,nonce:'destination-nonce',signature:'signed-proof'}}]);assert.equal(f.account.mainWallet,main);assert.equal(f.account.cashbackWallet,target);
});
test('closing the editor during a challenge never asks the wallet to sign or saves',async()=>{
 const pending=deferred(),f=fixture({wallet:true,handler:path=>path.endsWith('/challenge')?pending.promise:undefined});f.edit();const saving=f.$('form').onsubmit({preventDefault(){}});await flush();f.close();pending.resolve({nonce:'nonce',message:'late-challenge'});await saving;assert.equal(f.calls.length,1);assert.equal(f.proofs.length,0);assert.equal(f.updates.length,0);
});
test('wallet change while approving prevents cashback destination submission',async()=>{
 const pending=deferred(),f=fixture({wallet:true,sign:()=>pending.promise});f.edit();const saving=f.$('form').onsubmit({preventDefault(){}});await flush();f.setAddress('6'.repeat(44));pending.resolve('proof');await saving;assert.equal(f.calls.length,1);assert.equal(f.updates.length,0);assert.match(f.$('message').textContent,/wallet changed/);
});
test('invalid address fails before authorization and double submit cannot duplicate writes',async()=>{
 const pending=deferred(),f=fixture({handler:()=>pending.promise});f.edit();f.$('input').value='not-an-address';await f.$('form').onsubmit({preventDefault(){}});assert.equal(f.authorizations,0);assert.equal(f.calls.length,0);
 f.$('input').value=target;const first=f.$('form').onsubmit({preventDefault(){}});await flush();await f.$('form').onsubmit({preventDefault(){}});assert.equal(f.calls.length,1);pending.resolve({account:{...f.account,cashbackWallet:target}});await first;assert.equal(f.updates.length,1);
});
test('accepted late destination save cannot overwrite a closed or reopened editor',async()=>{
 const pending=deferred(),f=fixture({handler:()=>pending.promise});f.edit();const saving=f.$('form').onsubmit({preventDefault(){}});await flush();f.close();pending.resolve({account:{...f.account,cashbackWallet:target}});await saving;assert.equal(f.updates.length,0);assert.equal(f.$('input').value,'');
});
test('cashback destination keeps a padded paste whole and requires an exact 32-byte wallet address',async()=>{
 const f=fixture();assert.equal(f.$('input').hasAttribute('maxlength'),false);f.$('edit').click();
 for(const value of ['z'.repeat(44),'2'.repeat(32)]){f.$('input').value=value;await f.$('form').onsubmit({preventDefault(){}});assert.equal(f.authorizations,0,value);assert.match(f.$('message').textContent,/valid Solana wallet/);}
 f.$('input').value=' '+target+' ';await f.$('form').onsubmit({preventDefault(){}});
 assert.equal(f.authorizations,1);assert.deepEqual(f.calls.map(call=>call.body.address),[target]);
});
