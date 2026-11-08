import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPrivateKey,sign} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {AccountService} from '../src/accounts.mjs';
import {totp} from '../src/totp.mjs';
const password='wallet-link-password-123',origin='https://launchpad.example';
const signature=(wallet,message)=>sign(null,Buffer.from(message),createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(wallet.secretKey.slice(0,32))]),format:'der',type:'pkcs8'})).toString('base64');
async function harness(t){const dir=await mkdtemp(join(tmpdir(),'launchpad-wallet-link-'));t.after(()=>rm(dir,{recursive:true,force:true}));let now=Date.now();const service=await new AccountService(dir,{now:()=>now}).init();return{service,advance(ms=30000){now+=ms;},get now(){return now;}};}
async function prove(service,wallet,accountId){const binding='b'.repeat(64),challenge=await service.walletChallenge(wallet.publicKey.toBase58(),origin,binding,accountId?{accountId}:{});return service.authenticateWallet({nonce:challenge.nonce,signature:signature(wallet,challenge.message)},origin,binding);}
async function enroll(h,account){const setup=await h.service.beginMfa(account.id,password);await h.service.enableMfa(account.id,password,totp(setup.secret,h.now));h.advance();return setup.secret;}
async function link(h,account,wallet,context,secret){const c=await h.service.walletLinkChallenge(account.id,{address:wallet.publicKey.toBase58(),password,...(secret?{code:totp(secret,h.now)}:{})},context);return h.service.linkWallet(account.id,{nonce:c.nonce,signature:signature(wallet,c.message)},context);}

test('explicit wallet linking restores the existing admin identity without OTP and preserves original wallet account data',async t=>{
  const h=await harness(t),s=h.service,owner=await s.register('main_owner',password),wallet=Keypair.generate(),address=wallet.publicKey.toBase58();await s.setAdmin(owner.id);
  const initial=await s.createSession(owner.id),initialContext={token:initial.token,origin};await s.setCashbackWallet(owner.id,{address,password},initialContext);
  const original=await prove(s,wallet);assert.notEqual(original.id,owner.id);assert.equal(original.role,'user');assert.equal(original.mainWallet,address);
  const oldSession=await s.createWalletSession(original),oldProfile=await s.updateProfile(original.id,{username:'original_creator',bio:'Original creator profile'}),oldStore=s.storeFor(original.id),book={version:1,launches:[{id:'owned-launch',mint:'original-mint',keys:{private:'preserved'},credits:{quote:'123'}}]};await oldStore.write('launchpad',book);
  const originalSettings=await oldStore.read('settings'),mainKey=await s.exportMainWallet(owner.id,password),manualSettings=await s.storeFor(owner.id).read('settings');
  const secret=await enroll(h,owner),manualSession=await s.createSession(owner.id,{mfaVerified:true}),context={token:manualSession.token,origin};
  await assert.rejects(s.walletLinkChallenge(owner.id,{address,password},context),/authenticator/);
  const linked=await link(h,owner,wallet,context,secret);assert.equal(linked.id,owner.id);assert.equal(linked.signInWallet,address);assert.equal(linked.mainWallet,owner.mainWallet);assert.equal(linked.cashbackWallet,address);assert.deepEqual(linked.walletAccount,{id:original.id,username:oldProfile.username});
  assert.equal(await s.getSession(oldSession.token),null);assert.deepEqual(await oldStore.read('launchpad'),book);assert.deepEqual(await oldStore.read('settings'),originalSettings);assert.deepEqual(await s.storeFor(owner.id).read('settings'),manualSettings);assert.equal((await s.get(original.id)).role,'user');assert.equal((await s.get(original.id)).bio,oldProfile.bio);
  const signed=await prove(s,wallet);assert.equal(signed.id,owner.id);assert.equal(signed.username,owner.username);assert.equal(signed.role,'admin');assert.equal(signed.mfaEnabled,true);assert.equal(signed.authType,'password');
  await assert.rejects(s.createWalletSession({...signed}),/Verify your wallet signature/);
  await assert.rejects(s.createSession(owner.id,{walletVerified:true,authMethod:'wallet'}),/Two-factor authentication required/);
  const login=await s.createWalletSession(signed),session=await s.getSession(login.token);assert.equal(session.authMethod,'wallet');assert.equal(session.walletVerified,true);assert.equal(session.walletAddress,address);assert.equal(session.mfaVerified,false);assert.equal(session.account.id,owner.id);assert.equal(await s.verifyCsrf(login.token,login.csrfToken),true);
  await assert.rejects(s.createWalletSession(signed),/Verify your wallet signature/);
  await assert.rejects(s.authenticate(owner.username,password),/authenticator/);await assert.rejects(s.exportMainWallet(owner.id,password),/authenticator/);
  h.advance();assert.deepEqual(await s.exportMainWallet(owner.id,password,totp(secret,h.now)),mainKey);
  await assert.rejects(s.walletChallenge(address,origin,'c'.repeat(64),{accountId:owner.id}),/Original wallet account/);
  const legacy=await prove(s,wallet,original.id),legacySession=await s.createWalletSession(legacy);assert.equal(legacySession.account.id,original.id);assert.equal(legacySession.account.role,'user');assert.equal(legacySession.account.authType,'wallet');assert.equal((await s.getSession(legacySession.token)).walletAddress,address);assert.deepEqual(await oldStore.read('launchpad'),book);
  h.advance();const unlinked=await s.unlinkWallet(owner.id,{password,code:totp(secret,h.now)},context);assert.equal(unlinked.signInWallet,'');assert.equal(unlinked.cashbackWallet,address);assert.equal(unlinked.mainWallet,owner.mainWallet);assert.equal(await s.getSession(login.token),null);assert.equal((await prove(s,wallet)).id,original.id);assert.equal((await s.list()).length,2);
});

test('link proofs bind session, account, origin, wallet, fresh verification and expiry; other manual-account links cannot be stolen',async t=>{
  const h=await harness(t),s=h.service,a=await s.register('link_first',password),b=await s.register('link_second',password),wallet=Keypair.generate(),wrong=Keypair.generate(),address=wallet.publicKey.toBase58(),one=await s.createSession(a.id),two=await s.createSession(a.id),other=await s.createSession(b.id),context={token:one.token,origin};
  await assert.rejects(s.walletLinkChallenge(a.id,{address},context),/Invalid username or password/);
  const c=await s.walletLinkChallenge(a.id,{address,password},context),body={nonce:c.nonce,signature:signature(wallet,c.message)};assert(c.message.includes(a.id));assert(c.message.includes(address));assert(c.message.includes('without a password or authenticator code'));
  await assert.rejects(s.linkWallet(a.id,body,{token:two.token,origin}),/expired or changed/);
  await assert.rejects(s.linkWallet(a.id,body,{...context,origin:'https://evil.invalid'}),/expired or changed/);
  await assert.rejects(s.linkWallet(b.id,body,{token:other.token,origin}),/expired or changed/);
  await assert.rejects(s.linkWallet(a.id,{...body,signature:signature(wrong,c.message)},context),/Invalid wallet signature/);
  const competing=await s.walletLinkChallenge(b.id,{address,password},{token:other.token,origin});
  await s.linkWallet(a.id,body,context);await assert.rejects(s.linkWallet(a.id,body,context),/expired or changed/);
  await assert.rejects(s.linkWallet(b.id,{nonce:competing.nonce,signature:signature(wallet,competing.message)},{token:other.token,origin}),/already linked/);
  await assert.rejects(s.walletLinkChallenge(b.id,{address,password},{token:other.token,origin}),/already linked/);
  const c2=await s.walletLinkChallenge(a.id,{address:wrong.publicKey.toBase58(),password},context);h.advance(300001);await assert.rejects(s.linkWallet(a.id,{nonce:c2.nonce,signature:signature(wrong,c2.message)},context),/expired or changed/);
  assert.equal((await s.get(a.id)).signInWallet,address);assert.equal((await s.get(b.id)).signInWallet,'');
});

test('wallet linking and session proofs are invalidated by revocation, replacement, password changes and bans',async t=>{
  const h=await harness(t),s=h.service,a=await s.register('link_revoke',password),wallet=Keypair.generate(),replacement=Keypair.generate(),auth=await s.createSession(a.id),context={token:auth.token,origin};
  await link(h,a,wallet,context);const staleProof=await prove(s,wallet),signed=await prove(s,wallet),session=await s.createWalletSession(signed);
  await link(h,a,replacement,context);assert.equal(await s.getSession(session.token),null);await assert.rejects(s.createWalletSession(staleProof),/changed or expired/);
  const pending=await prove(s,replacement);await s.revokeAllAccess(a.id,password);await assert.rejects(s.createWalletSession(pending),/changed or expired/);
  const refreshed=await s.createSession(a.id),refreshContext={token:refreshed.token,origin},c=await s.walletLinkChallenge(a.id,{address:wallet.publicKey.toBase58(),password},refreshContext);await s.revokeSession(refreshed.token);await assert.rejects(s.linkWallet(a.id,{nonce:c.nonce,signature:signature(wallet,c.message)},refreshContext),/Sign in again/);
  const valid=await prove(s,replacement),allowed=await s.createWalletSession(valid);await s.mutate(registry=>{registry.bannedWallets=[replacement.publicKey.toBase58()];});assert.equal(await s.getSession(allowed.token),null);
  await s.mutate(registry=>{registry.bannedWallets=[];});const beforePassword=await prove(s,replacement);await s.changePassword(a.id,password,'new-wallet-link-password');await assert.rejects(s.createWalletSession(beforePassword),/changed or expired/);
});

test('wallet-created users cannot link another identity and original-account selection never accepts arbitrary account ids',async t=>{
  const h=await harness(t),s=h.service,wallet=Keypair.generate(),other=Keypair.generate(),a=await prove(s,wallet),b=await prove(s,other),auth=await s.createWalletSession(a),context={token:auth.token,origin};
  await assert.rejects(s.walletLinkChallenge(a.id,{address:other.publicKey.toBase58(),password},context),/username and password/);
  await assert.rejects(s.unlinkWallet(a.id,{password},context),/must keep/);
  await assert.rejects(s.walletChallenge(wallet.publicKey.toBase58(),origin,'c'.repeat(64),{accountId:b.id}),/Original wallet account/);
  await assert.rejects(s.createWalletSession(await s.get(a.id)),/Verify your wallet signature/);
  assert.equal((await s.get(a.id)).mainWallet,wallet.publicKey.toBase58());assert.equal((await s.get(b.id)).mainWallet,other.publicKey.toBase58());
});

test('post-link session rotation requires a one-use current reauthentication proof',async t=>{
  const h=await harness(t),s=h.service,a=await s.register('link_rotation',password),wallet=Keypair.generate(),secret=await enroll(h,a),auth=await s.createSession(a.id,{mfaVerified:true}),context={token:auth.token,origin};
  const linked=await link(h,a,wallet,context,secret);await assert.rejects(s.createLinkedAccountSession({...linked}),/Verify your account again/);
  const rotated=await s.createLinkedAccountSession(linked);assert.equal(rotated.account.id,a.id);assert.equal(rotated.authMethod,'password');assert.equal(rotated.mfaVerified,true);assert.equal(rotated.walletVerified,false);assert.equal((await s.getSession(rotated.token)).mfaVerified,true);assert.equal((await s.getSession(rotated.token)).walletAddress,null);
  await assert.rejects(s.createLinkedAccountSession(linked),/Verify your account again/);
  h.advance();const unlinked=await s.unlinkWallet(a.id,{password,code:totp(secret,h.now)},context),next=await s.createLinkedAccountSession(unlinked);assert.equal(next.account.signInWallet,'');assert.equal(next.mfaVerified,true);assert.equal(next.walletVerified,false);
});

test('password changes, MFA enrollment, all-access revocation and expiry prevent stale post-link session rotation',async t=>{
  for(const change of ['password','mfa','revoke','expiry'])await t.test(change,async t=>{
    const h=await harness(t),s=h.service,a=await s.register('stale_rotation',password),wallet=Keypair.generate(),auth=await s.createSession(a.id),context={token:auth.token,origin},updated=await link(h,a,wallet,context);
    if(change==='password')await s.changePassword(a.id,password,'changed-rotation-password');
    if(change==='mfa')await enroll(h,a);
    if(change==='revoke')await s.revokeAllAccess(a.id,password);
    if(change==='expiry')h.advance(30001);
    await assert.rejects(s.createLinkedAccountSession(updated),/security changed or verification expired/);
    await assert.rejects(s.createLinkedAccountSession(updated),/Verify your account again/);
  });
});
