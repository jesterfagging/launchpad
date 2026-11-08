import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPrivateKey,randomBytes,sign} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {AccountService} from '../src/accounts.mjs';
import {createAccountApp} from '../src/account-app.mjs';
import {totp} from '../src/totp.mjs';

const password='account-security-http-password-123',newPassword='account-security-http-updated-456';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-account-security-http-')),accounts=await new AccountService(dir).init();
  // Real account storage, credential proofs, sessions, CSRF and HTTP router.
  // The unrelated financial/provider interfaces are inert and never started.
  const server=createAccountApp({accounts,runtimes:{},policy:{},launchpad:{},marketData:{},funding:{},protocolFees:{},protocolTreasury:{},protocolGasFunding:{},branding:{},adminPanel:{},adminRevenue:{},explore:{},trading:{},adminVolume:{},lifetimeVolume:{},publicAnalytics:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await server.closeServices();await rm(dir,{recursive:true,force:true});});
  async function request(path,{auth,body,raw,method=body===undefined&&raw===undefined?'GET':'POST',headers={}}={}){
    const response=await fetch(base+path,{method,headers:{...(auth?{cookie:'launchpad-session='+auth.token,'x-control-token':auth.csrfToken}:{}),...(body!==undefined||raw!==undefined?{'content-type':'application/json'}:{}),...headers},...(body!==undefined||raw!==undefined?{body:raw??JSON.stringify(body)}:{})});
    return {status:response.status,headers:response.headers,body:await response.json()};
  }
  async function user(name,{mfa=false,admin=false}={}){
    const account=await accounts.register(name,password);let recovery=[];
    if(mfa){const setup=await accounts.beginMfa(account.id,password);recovery=(await accounts.enableMfa(account.id,password,totp(setup.secret,Date.now()))).recoveryCodes;}
    if(admin)await accounts.setAdmin(account.id);
    return {account,recovery,...await accounts.createSession(account.id,{mfaVerified:mfa})};
  }
  async function walletUser(){
    const wallet=Keypair.generate(),challenge=await request('/api/wallet/challenge',{body:{address:wallet.publicKey.toBase58()},headers:{origin:base}});assert.equal(challenge.status,200);
    const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(wallet.secretKey.slice(0,32))]),format:'der',type:'pkcs8'});
    const result=await request('/api/wallet/verify',{body:{nonce:challenge.body.nonce,signature:sign(null,Buffer.from(challenge.body.message),privateKey).toString('base64')},headers:{origin:base,cookie:challenge.headers.get('set-cookie').split(';')[0]}});assert.equal(result.status,200);
    return {account:result.body.account,token:result.headers.get('set-cookie').match(/launchpad-session=([^;]+)/)[1],csrfToken:result.body.token};
  }
  // Stored directly (no wallet generation), so it also runs without the Solana and EVM packages.
  async function storedUser(name,{mfa=false}={}){
    const id=randomBytes(16).toString('hex'),credential=await accounts.hashPassword(password);
    await accounts.mutate(registry=>{registry.accounts.push({id,username:name,password:credential,mainWallet:Keypair.generate().publicKey.toBase58(),cashbackBps:0,role:'user',createdAt:Date.now(),telegramId:null});});
    let recovery=[];
    if(mfa){const setup=await accounts.beginMfa(id,password);recovery=(await accounts.enableMfa(id,password,totp(setup.secret,Date.now()))).recoveryCodes;}
    return {account:await accounts.get(id),recovery,...await accounts.createSession(id,{mfaVerified:mfa})};
  }
  return {accounts,request,user,walletUser,storedUser,base};
}

for(const path of ['/api/account/password','/api/account/mfa/disable'])test(path+' rejects unauthorized transport, method and body variations without changing security',async t=>{
  const h=await fixture(t),owner=await h.user('security_owner',{mfa:true}),wallet=await h.walletUser(),body={password,newPassword,code:owner.recovery[0]};
  for(const [label,options,status]of [
    ['guest',{body},401],['bad csrf',{auth:owner,body,headers:{'x-control-token':'wrong'}},403],['cross origin',{auth:owner,body,headers:{origin:'https://unrelated.example'}},403],
    ['wallet account',{auth:wallet,body},403],['GET',{auth:owner,method:'GET'},404],['PUT',{auth:owner,method:'PUT',body},405],['content type',{auth:owner,body,headers:{'content-type':'text/plain'}},415],
    ['array body',{auth:owner,body:[]},400],['invalid json',{auth:owner,raw:'{"password":'},400],['oversized body',{auth:owner,body:{padding:'x'.repeat(262145)}},413]
  ])assert.equal((await h.request(path,options)).status,status,label);
  const query=new URLSearchParams({password,newPassword,code:owner.recovery[0],accountId:owner.account.id});
  assert.equal((await h.request(path+'?'+query,{auth:owner,body:{}})).status,400,'query credentials cannot replace the required body proof');
  assert.equal((await h.accounts.get(owner.account.id)).mfaEnabled,true);assert.ok(await h.accounts.getSession(owner.token));assert.ok(await h.accounts.getSession(wallet.token));
  assert.equal((await h.accounts.authenticate(owner.account.username,password,owner.recovery[0])).id,owner.account.id,'rejected requests did not consume the valid proof or change the password');
});

for(const path of ['/api/account/password','/api/account/mfa/disable'])test(path+' requires a fresh password and second factor even for an MFA-verified session',async t=>{
  const h=await fixture(t),owner=await h.user('proof_owner',{mfa:true});
  for(const body of [{password:'incorrect-password',newPassword,code:owner.recovery[0]},{password,newPassword},{password,newPassword,code:'not-a-valid-factor'}])assert.equal((await h.request(path,{auth:owner,body})).status,400);
  assert.equal((await h.accounts.get(owner.account.id)).mfaEnabled,true);assert.ok(await h.accounts.getSession(owner.token));
  assert.equal((await h.accounts.authenticate(owner.account.username,password,owner.recovery[0])).id,owner.account.id);
});

test('password change is bound to the session account and revokes all its existing access while preserving MFA and wallet identity',async t=>{
  const h=await fixture(t),owner=await h.user('password_owner',{mfa:true}),other=await h.user('password_other'),peer=await h.accounts.createSession(owner.account.id,{mfaVerified:true}),link=await h.accounts.createLinkCode(owner.account.id);
  const result=await h.request('/api/account/password?accountId='+other.account.id,{auth:owner,body:{accountId:other.account.id,id:other.account.id,password,newPassword,code:owner.recovery[0]}});
  assert.equal(result.status,200);assert.equal(result.body.ok,true);assert.equal(result.body.account.id,owner.account.id);
  const next={token:result.headers.get('set-cookie').match(/^launchpad-session=([A-Za-z0-9_-]{43});/)[1],csrfToken:result.body.token};assert.notEqual(next.token,owner.token);
  assert.equal((await h.request('/api/session',{auth:next})).body.account.id,owner.account.id);
  assert.equal(await h.accounts.getSession(owner.token),null);assert.equal(await h.accounts.getSession(peer.token),null);assert.ok(await h.accounts.getSession(other.token));await assert.rejects(h.accounts.redeemLinkCode(link.code,'1001'),/invalid or expired/);
  assert.equal((await h.request('/api/session',{auth:owner})).body.authenticated,false);assert.equal((await h.request('/api/account/password',{auth:peer,body:{password:newPassword,newPassword:password}})).status,401);
  await assert.rejects(h.accounts.authenticate(owner.account.username,password,owner.recovery[1]),/Invalid username or password/);await assert.rejects(h.accounts.authenticate(owner.account.username,newPassword),/authenticator/);
  const changed=await h.accounts.authenticate(owner.account.username,newPassword,owner.recovery[1]);assert.equal(changed.mainWallet,owner.account.mainWallet);assert.equal(changed.mfaEnabled,true);assert.equal((await h.accounts.authenticate(other.account.username,password)).id,other.account.id);
});

test('MFA disable is bound to the session account and revokes its sessions and links before ordinary sign-in resumes',async t=>{
  const h=await fixture(t),owner=await h.user('mfa_owner',{mfa:true}),other=await h.user('mfa_other',{mfa:true}),peer=await h.accounts.createSession(owner.account.id,{mfaVerified:true}),link=await h.accounts.createLinkCode(owner.account.id);
  const result=await h.request('/api/account/mfa/disable?accountId='+other.account.id,{auth:owner,body:{accountId:other.account.id,id:other.account.id,password,code:owner.recovery[0]}});
  assert.equal(result.status,200);assert.equal(result.body.ok,true);assert.match(result.headers.get('set-cookie'),/^launchpad-session=[A-Za-z0-9_-]{43};/);assert.equal(await h.accounts.getSession(owner.token),null);assert.equal(await h.accounts.getSession(peer.token),null);assert.ok(await h.accounts.getSession(other.token));
  await assert.rejects(h.accounts.redeemLinkCode(link.code,'1002'),/invalid or expired/);assert.equal((await h.request('/api/account/mfa/disable',{auth:peer,body:{password,code:owner.recovery[1]}})).status,401);
  assert.equal((await h.accounts.get(owner.account.id)).mfaEnabled,false);assert.equal((await h.accounts.get(other.account.id)).mfaEnabled,true);
  const login=await h.request('/api/account/login',{body:{username:owner.account.username,password}});assert.equal(login.status,200);assert.equal(login.body.account.id,owner.account.id);assert.equal(login.body.account.mainWallet,owner.account.mainWallet);assert.equal(login.body.account.mfaEnabled,false);
});

test('an administrator cannot disable MFA even with a valid current password and second factor',async t=>{
  const h=await fixture(t),owner=await h.user('secured_admin',{mfa:true,admin:true});
  const result=await h.request('/api/account/mfa/disable',{auth:owner,body:{password,code:owner.recovery[0],role:'user',admin:false}});
  assert.equal(result.status,400);assert.match(result.body.error,/must keep two-factor/);assert.equal(result.headers.get('set-cookie'),null);assert.equal((await h.accounts.get(owner.account.id)).mfaEnabled,true);assert.ok(await h.accounts.getSession(owner.token));
});

test('password change, 2FA removal and sign-out-everywhere keep only the browser that made them signed in, with a fresh session and CSRF token',async t=>{
  const h=await fixture(t);
  for(const [path,name] of [['/api/account/password','keep_password'],['/api/account/mfa/disable','keep_mfa'],['/api/account/logout-all','keep_everywhere']]){
    const owner=await h.storedUser(name,{mfa:true}),peer=await h.accounts.createSession(owner.account.id,{mfaVerified:true});
    const result=await h.request(path,{auth:owner,body:{password,newPassword,code:owner.recovery[0]}});
    assert.equal(result.status,200,path);assert.equal(result.body.ok,true);assert.equal(result.body.account.id,owner.account.id);
    const cookie=result.headers.get('set-cookie');assert.match(cookie,/^launchpad-session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+/);
    const next={token:cookie.match(/^launchpad-session=([^;]+)/)[1],csrfToken:result.body.token};assert.notEqual(next.token,owner.token);
    assert.equal(await h.accounts.getSession(owner.token),null);assert.equal(await h.accounts.getSession(peer.token),null,'every other session is revoked');
    assert.equal((await h.request('/api/session',{auth:owner})).body.authenticated,false);
    const session=(await h.request('/api/session',{auth:next})).body;assert.equal(session.authenticated,true);assert.equal(session.account.id,owner.account.id);assert.equal(session.token,next.csrfToken);
    assert.equal((await h.request('/api/account/logout',{auth:next,body:{}})).status,200,'the returned CSRF token authorizes the next change');
  }
});
