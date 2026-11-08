import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPrivateKey,sign} from 'node:crypto';
import {Keypair,PublicKey} from '@solana/web3.js';
import {AccountService} from '../src/accounts.mjs';
import {AccountFeePolicy,cashbackSummary} from '../src/account-policy.mjs';
import {receiptHash} from '../src/cashback-verifier.mjs';
import {totp} from '../src/totp.mjs';
const password='cashback-test-password-123',origin='https://launchpad.example';
const address=()=>Keypair.generate().publicKey.toBase58();
const signature=(wallet,message)=>sign(null,Buffer.from(message),createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(wallet.secretKey.slice(0,32))]),format:'der',type:'pkcs8'})).toString('base64');
async function harness(t){const dir=await mkdtemp(join(tmpdir(),'launchpad-cashback-wallet-'));t.after(()=>rm(dir,{recursive:true,force:true}));let now=Date.now();const service=await new AccountService(dir,{now:()=>now}).init();return{service,advance(ms){now+=ms;},get now(){return now;}};}
async function walletAccount(service,wallet=Keypair.generate()){
  const challenge=await service.walletChallenge(wallet.publicKey.toBase58(),origin,'a'.repeat(64));
  const account=await service.authenticateWallet({nonce:challenge.nonce,signature:signature(wallet,challenge.message)},origin,'a'.repeat(64));
  const session=await service.createSession(account.id);return{account,wallet,session,context:{token:session.token,origin}};
}
test('manual cashback destination requires fresh password and MFA while preserving identity, keys, and accrued rewards',async t=>{
  const h=await harness(t),s=h.service,a=await s.register('cashback_manual',password),store=s.storeFor(a.id),session=await s.createSession(a.id),context={token:session.token,origin};
  assert.equal(a.cashbackWallet,a.mainWallet);const original=await s.exportMainWallet(a.id,password),settings=await store.read('settings'),recipient=address();
  const receipt={mode:'live',signature:'confirmed',mint:'So11111111111111111111111111111111111111112',decimals:9,amount:'1000',cashbackAmount:'250',accountId:a.id,mainWallet:a.mainWallet};
  await store.write('live',{feeReceipts:[receipt]});await store.write('cashback-verification',{receipts:{confirmed:{status:'verified',hash:receiptHash(receipt)}}});const accrual=await cashbackSummary(store);
  await assert.rejects(s.setCashbackWallet(a.id,{address:recipient},context),/Invalid username or password/);
  await assert.rejects(s.setCashbackWallet(a.id,{address:recipient,password:'wrong-password'},context),/Invalid username or password/);
  for(const invalid of ['',null,'fake-address','11111111111111111111111111111111',PublicKey.findProgramAddressSync([Buffer.from('cashback')],Keypair.generate().publicKey)[0].toBase58()])await assert.rejects(s.setCashbackWallet(a.id,{address:invalid,password},context),/wallet|address/);
  const changed=await s.setCashbackWallet(a.id,{address:' '+recipient+' ',password},context);assert.equal(changed.cashbackWallet,recipient);assert.equal(changed.mainWallet,a.mainWallet);
  assert.deepEqual(await s.exportMainWallet(a.id,password),original);assert.deepEqual(await store.read('settings'),settings);assert.deepEqual(await cashbackSummary(store),accrual);
  const policy=await new AccountFeePolicy(s).get(a.id);assert.equal(policy.mainWallet,a.mainWallet);assert.equal(policy.cashbackWallet,recipient);
  const setup=await s.beginMfa(a.id,password);await s.enableMfa(a.id,password,totp(setup.secret,h.now));const secured=await s.createSession(a.id,{mfaVerified:true}),secureContext={token:secured.token,origin};
  await assert.rejects(s.setCashbackWallet(a.id,{address:a.mainWallet,password},secureContext),/authenticator/);
  h.advance(30000);const updated=await s.setCashbackWallet(a.id,{address:a.mainWallet,password,code:totp(setup.secret,h.now)},secureContext);assert.equal(updated.cashbackWallet,a.mainWallet);
  assert.equal((await s.securityEvents(a.id)).filter(e=>e.action==='cashback-wallet-updated').length,2);
});
test('wallet cashback proof binds exact account, session, origin and destination, rejects replay, and preserves reconnect identity',async t=>{
  const h=await harness(t),s=h.service,{account,wallet,session,context}=await walletAccount(s),to=address(),other=await walletAccount(s),anotherSession=await s.createSession(account.id);
  const c=await s.cashbackWalletChallenge(account.id,to,context),body={address:to,nonce:c.nonce,signature:signature(wallet,c.message)};
  assert.match(c.message,/Launchpad cashback wallet change/);assert(c.message.includes(to));assert(c.message.includes(account.id));assert(c.message.includes(account.mainWallet));
  await assert.rejects(s.setCashbackWallet(account.id,{...body,address:address()},context),/expired or changed/);
  await assert.rejects(s.setCashbackWallet(account.id,body,{...context,origin:'https://evil.invalid'}),/expired or changed/);
  await assert.rejects(s.setCashbackWallet(account.id,body,{...context,token:anotherSession.token}),/expired or changed/);
  await assert.rejects(s.setCashbackWallet(other.account.id,body,other.context),/expired or changed/);
  await assert.rejects(s.setCashbackWallet(account.id,{...body,signature:signature(other.wallet,c.message)},context),/Invalid wallet signature/);
  const saved=await s.setCashbackWallet(account.id,body,context);assert.equal(saved.cashbackWallet,to);assert.equal(saved.mainWallet,account.mainWallet);assert.equal(saved.id,account.id);assert.equal(saved.role,'user');
  await assert.rejects(s.setCashbackWallet(account.id,body,context),/expired or changed/);
  const restored=await walletAccount(s,wallet);assert.equal(restored.account.id,account.id);assert.equal(restored.account.cashbackWallet,to);assert.equal(restored.account.mainWallet,account.mainWallet);assert.equal((await s.list()).length,2);
  const store=s.storeFor(account.id);assert.equal(await store.read('main-wallet',null),null);assert.equal(await store.read('robinhood-account',null),null);assert.deepEqual((await store.read('settings')).wallets,[]);
  const login=await s.walletChallenge(account.mainWallet,origin,'c'.repeat(64));await assert.rejects(s.setCashbackWallet(account.id,{address:to,nonce:login.nonce,signature:signature(wallet,login.message)},context),/expired or changed/);
  assert.equal((await s.getSession(session.token)).account.cashbackWallet,to);
});
test('cashback proofs expire and are invalidated by logout, later updates, or bans before saving',async t=>{
  const h=await harness(t),s=h.service,{account,wallet,context}=await walletAccount(s),to=address();
  const proof=async(ctx=context)=>{const c=await s.cashbackWalletChallenge(account.id,to,ctx);return{address:to,nonce:c.nonce,signature:signature(wallet,c.message)};};
  const expired=await proof();h.advance(300001);await assert.rejects(s.setCashbackWallet(account.id,expired,context),/expired or changed/);
  const revoked=await proof();await s.revokeSession(context.token);await assert.rejects(s.setCashbackWallet(account.id,revoked,context),/Sign in again/);
  const a=await s.createSession(account.id),b=await s.createSession(account.id),ctxA={token:a.token,origin},ctxB={token:b.token,origin},old=await proof(ctxA),current=await proof(ctxB);
  await s.setCashbackWallet(account.id,current,ctxB);await assert.rejects(s.setCashbackWallet(account.id,old,ctxA),/expired or changed/);
  const banned=await proof(ctxA);await s.mutate(registry=>{registry.accounts.find(x=>x.id===account.id).banned=true;});await assert.rejects(s.setCashbackWallet(account.id,banned,ctxA),/banned/);
});
