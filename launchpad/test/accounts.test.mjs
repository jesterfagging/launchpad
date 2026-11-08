import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { AccountService, accountKey, normalizeUsername } from '../src/accounts.mjs';

const password = 'strong-test-password-123';
async function harness(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-accounts-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const service = await new AccountService(dir, options).init();
  return { dir, service };
}

test('registration makes an isolated main wallet and separate default trading wallets; private export requires reauthentication', async t => {
  const { service, dir } = await harness(t);
  const a = await service.register('  Alice_1  ', password), b = await service.register('bob', password);
  assert.equal(a.username, 'alice_1'); assert.equal(a.role, 'user'); assert.equal(a.cashbackBps, 0); assert.equal(b.role, 'user');
  assert.notEqual(a.id, b.id); assert.notEqual(a.mainWallet, b.mainWallet);
  assert.equal((await service.authenticate('ALICE_1', password)).id, a.id);
  const settings = await service.storeFor(a.id).read('settings');
  assert.equal(settings.wallets.length, 3); assert.deepEqual(settings.wallets.map(w => w.tool), ['copy', 'liquidity', 'market']); assert.equal(new Set(settings.wallets.map(w => w.publicKey)).size, 3); assert.ok(!JSON.stringify(settings).includes(a.mainWallet));
  await assert.rejects(service.exportMainWallet(a.id, 'wrong-password'), /Invalid username or password/);
  const main = await service.exportMainWallet(a.id, password);
  assert.equal(Keypair.fromSecretKey(bs58.decode(main.privateKey)).publicKey.toBase58(), a.mainWallet);
  assert.equal(main.publicKey, a.mainWallet);
  for (const value of [a, await service.get(a.id), await service.list()]) {
    assert.ok(!JSON.stringify(value).includes(main.privateKey)); assert.ok(!JSON.stringify(value).includes(password));
    assert.ok(!JSON.stringify(value).includes('scrypt'));
  }
  const registry = await readFile(join(dir, 'registry.enc'), 'utf8');
  const vault = await readFile(service.storeFor(a.id).path('main-wallet'), 'utf8');
  for (const value of [registry, vault]) {
    assert.ok(!value.includes(main.privateKey)); assert.ok(!value.includes(password)); assert.ok(!value.includes(a.username));
  }
  const internal = await service.hostStore.read('registry');
  assert.equal(internal.accounts[0].password.algorithm, 'scrypt-v1');
  assert.notEqual(internal.accounts[0].password.salt, internal.accounts[1].password.salt);
  assert.notEqual(internal.accounts[0].password.hash, internal.accounts[1].password.hash);
  assert.notDeepEqual(accountKey(service.master, a.id), accountKey(service.master, b.id));
});

test('concurrent case-insensitive registrations cannot create duplicate accounts', async t => {
  const { service } = await harness(t);
  const registrations = await Promise.allSettled([service.register('Race_User', password), service.register('race_user', password)]);
  assert.equal(registrations.filter(value => value.status === 'fulfilled').length, 1);
  assert.match(registrations.find(value => value.status === 'rejected').reason.message, /already taken/);
  assert.equal((await service.list()).length, 1);
  assert.equal((await readdir(join(service.dir, 'users'))).length, 1);
});

test('invalid input is bounded and authentication errors do not expose account existence', async t => {
  const { service } = await harness(t);
  await service.register('valid_user', password);
  for (const name of ['', 'ab', '../escape', 'hello there', 'x'.repeat(33), 'Älice']) assert.throws(() => normalizeUsername(name));
  for (const secret of ['', 'short', 'a'.repeat(129)]) await assert.rejects(service.register('new_user', secret), /Password/);
  const messages = [];
  for (const [name, secret] of [['valid_user', 'wrong-passphrase'], ['unknown_user', password], ['invalid / user', password], ['valid_user', 'short']]) {
    try { await service.authenticate(name, secret); assert.fail('Unexpected authentication'); } catch (error) { messages.push(error.message); }
  }
  assert.deepEqual([...new Set(messages)], ['Invalid username or password.']);
  assert.equal(await service.get('../escape'), null);
  assert.throws(() => service.storeFor('../escape'));
});

test('session tokens persist only as hashes, CSRF is per-session, and expiry/logout survive reload', async t => {
  let clock = 1_000_000;
  const { service, dir } = await harness(t, { now: () => clock, sessionTtlMs: 2000 });
  const account = await service.register('sessions', password), one = await service.createSession(account.id), two = await service.createSession(account.id);
  assert.notEqual(one.token, two.token); assert.notEqual(one.csrfToken, two.csrfToken);
  assert.equal((await service.getSession(one.token)).csrfToken, one.csrfToken);
  assert.equal((await service.getSession(one.token)).walletAddress, null);
  assert.equal(await service.verifyCsrf(one.token, one.csrfToken), true);
  assert.equal(await service.verifyCsrf(one.token, two.csrfToken), false);
  assert.equal(await service.verifyCsrf(one.token, ''), false);
  assert.equal(await service.getSession('bad'), null);
  const registry = JSON.stringify(await service.hostStore.read('registry'));
  for (const secret of [one.token, one.csrfToken, two.token, two.csrfToken]) assert.ok(!registry.includes(secret));
  const restarted = await new AccountService(dir, { now: () => clock }).init();
  assert.equal((await restarted.getSession(one.token)).account.id, account.id);
  assert.equal((await restarted.getSession(one.token)).csrfToken, one.csrfToken);
  await restarted.revokeSession(one.token);
  assert.equal(await service.getSession(one.token), null); assert.ok(await service.getSession(two.token));
  clock += 2000;
  assert.equal(await service.getSession(two.token), null); assert.equal(await service.verifyCsrf(two.token, two.csrfToken), false);
});

test('cashback and admin changes are explicit, validated and visible across service instances without lost updates', async t => {
  const { service, dir } = await harness(t), a = await service.register('owner', password);
  assert.equal(a.role, 'user');
  const second = await new AccountService(dir).init();
  await Promise.all([service.setCashback(a.id, 2500), second.setAdmin(a.id)]);
  const updated = await service.get(a.id);
  assert.equal(updated.role, 'admin'); assert.equal(updated.cashbackBps, 2500);
  assert.deepEqual(updated, await second.get(a.id));
  for (const value of [-1, 10001, 0.5, '500', NaN]) await assert.rejects(service.setCashback(a.id, value));
  await assert.rejects(service.setAdmin(a.id, 'yes'));
  const session = await service.createSession(a.id);
  await second.setCashback(a.id, 10000); await second.setAdmin(a.id, false);
  assert.equal((await service.getSession(session.token)).account.cashbackBps, 10000);
  assert.equal((await service.getSession(session.token)).account.role, 'user');
});

test('password change revokes all existing sessions and link codes without changing the main wallet', async t => {
  const { service } = await harness(t), a = await service.register('rotation', password);
  const session = await service.createSession(a.id), { code } = await service.createLinkCode(a.id);
  await assert.rejects(service.changePassword(a.id, 'not-the-password', 'a-new-valid-password'));
  assert.ok(await service.getSession(session.token));
  await service.changePassword(a.id, password, 'a-new-valid-password');
  assert.equal(await service.getSession(session.token), null);
  await assert.rejects(service.redeemLinkCode(code, '5001'), /invalid or expired/);
  await assert.rejects(service.authenticate(a.username, password), /Invalid username or password/);
  assert.equal((await service.authenticate(a.username, 'a-new-valid-password')).mainWallet, a.mainWallet);
  assert.equal((await service.exportMainWallet(a.id, 'a-new-valid-password')).publicKey, a.mainWallet);
});

test('Telegram linking is single-use, persistent, expires and binds one Telegram identity to one Launchpad account', async t => {
  let clock = 2_000_000;
  const { service, dir } = await harness(t, { now: () => clock, linkTtlMs: 2000 });
  const a = await service.register('first_link', password), b = await service.register('second_link', password);
  const { code: old } = await service.createLinkCode(a.id), { code, expiresAt } = await service.createLinkCode(a.id);
  assert.equal(expiresAt, clock + 2000);
  await assert.rejects(service.redeemLinkCode(old, 1001), /invalid or expired/);
  const registry = JSON.stringify(await service.hostStore.read('registry'));
  assert.ok(!registry.includes(code));
  const restarted = await new AccountService(dir, { now: () => clock }).init();
  assert.equal(await restarted.redeemLinkCode(code, 1001), a.id);
  assert.equal((await service.getTelegramAccount('1001')).id, a.id);
  assert.equal((await service.get(a.id)).telegramId, '1001');
  await assert.rejects(service.redeemLinkCode(code, '1001'), /invalid or expired/);
  await assert.rejects(service.createLinkCode(a.id), /already linked/);
  const { code: other } = await service.createLinkCode(b.id);
  await assert.rejects(service.redeemLinkCode(other, 1001), /already linked/);
  assert.equal(await service.getTelegramAccount('1002'), null);
  clock += 2000;
  await assert.rejects(service.redeemLinkCode(other, 1002), /invalid or expired/);
  const { code: fresh } = await service.createLinkCode(b.id);
  const race = await Promise.allSettled([service.redeemLinkCode(fresh, 1002), restarted.redeemLinkCode(fresh, 1003)]);
  assert.equal(race.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(race.filter(value => value.status === 'rejected').length, 1);
});

test('Telegram logout persists and stale unlink requests cannot disconnect another account', async t => {
  const { service, dir } = await harness(t), a = await service.register('unlink_a', password), b = await service.register('unlink_b', password);
  const { code } = await service.createLinkCode(a.id);
  await service.redeemLinkCode(code, 2001);
  await assert.rejects(service.unlinkTelegram(2001, b.id), /link changed/);
  assert.equal((await service.getTelegramAccount(2001)).id, a.id);
  const result = await service.unlinkTelegram(2001, a.id);
  assert.equal(result.telegramId, null); assert.equal(result.mainWallet, a.mainWallet);
  const restarted = await new AccountService(dir).init();
  assert.equal(await restarted.getTelegramAccount(2001), null);
  assert.equal((await restarted.exportMainWallet(a.id, password)).publicKey, a.mainWallet);
  const { code: other } = await restarted.createLinkCode(b.id);
  await restarted.redeemLinkCode(other, 2001);
  await assert.rejects(service.unlinkTelegram(2001, a.id), /link changed/);
  assert.equal((await restarted.getTelegramAccount(2001)).id, b.id);
});

test('missing master keys and registries never silently replace existing accounts', async t => {
  const { service, dir } = await harness(t), a = await service.register('preserved', password);
  const key = await readFile(join(dir, 'master.key'));
  await rm(join(dir, 'master.key'));
  await assert.rejects(new AccountService(dir).init(), /key is missing/);
  await writeFile(join(dir, 'master.key'), key);
  const registry = await readFile(join(dir, 'registry.enc'));
  await rm(join(dir, 'registry.enc'));
  await assert.rejects(new AccountService(dir).init(), /registry is missing/);
  await writeFile(join(dir, 'registry.enc'), registry);
  assert.equal((await (await new AccountService(dir).init()).get(a.id)).mainWallet, a.mainWallet);
});

test('encrypted account stores reject another account’s wallet ciphertext', async t => {
  const { service } = await harness(t), a = await service.register('vault_a', password), b = await service.register('vault_b', password);
  await writeFile(service.storeFor(b.id).path('main-wallet'), await readFile(service.storeFor(a.id).path('main-wallet')));
  await assert.rejects(service.exportMainWallet(b.id, password), /cannot be read/);
  assert.equal((await service.exportMainWallet(a.id, password)).publicKey, a.mainWallet);
});

test('failed registry commits cannot authenticate an incompletely registered account', async t => {
  const { service } = await harness(t), original = service.hostStore.write.bind(service.hostStore);
  service.hostStore.write = async (name, value) => { if (name === 'registry') throw new Error('Disk full'); return original(name, value); };
  await assert.rejects(service.register('failed_user', password), /Disk full/);
  service.hostStore.write = original;
  assert.deepEqual(await service.list(), []);
  await assert.rejects(service.authenticate('failed_user', password), /Invalid username or password/);
  const account = await service.register('failed_user', password);
  assert.equal((await service.get(account.id)).id, account.id);
});


test('registration rejects punctuation, Unicode and control characters and blocks duplicate names across services', async t => {
  const {service, dir} = await harness(t), other = await new AccountService(dir).init();
  for (const name of ['a/b','a.b','a,b','a-b','a b','ab@c','ab\ncd','a\u0000bc','älice','Ａlice','Kevin','a\u200bbc']) await assert.rejects(service.register(name, password), /letters, numbers, or underscores/);
  const results = await Promise.allSettled([service.register('Shared_Name', password), other.register('sHaReD_nAmE', password)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.match(results.find(r => r.status === 'rejected').reason.message, /already taken/);
  assert.equal((await other.list()).length, 1);
});

test('existing legacy usernames remain usable while new hyphenated names are blocked', async t => {
  const {service} = await harness(t), user = await service.register('legacy_user', password);
  await service.mutate(registry => { registry.accounts[0].username = 'legacy-user'; });
  assert.equal((await service.authenticate('LEGACY-USER', password)).id, user.id);
  await assert.rejects(service.register('new-user', password), /underscores/);
});

test('wallet proof is origin and browser bound, expires, rejects impersonation and replay, and restores the same identity', async t => {
  const { createPrivateKey, sign } = await import('node:crypto');
  let now=Date.now();const {service}=await harness(t,{now:()=>now});
  const wallet=Keypair.generate(), other=Keypair.generate(),origin='https://launchpad.example',binding='a'.repeat(64);
  const signature=(message,w=wallet)=>sign(null,Buffer.from(message),createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(w.secretKey.slice(0,32))]),format:'der',type:'pkcs8'})).toString('base64');
  const c=await service.walletChallenge(wallet.publicKey.toBase58(),origin,binding), proof={nonce:c.nonce,signature:signature(c.message)};
  await assert.rejects(service.authenticateWallet(proof,'https://evil.invalid',binding),/expired/);
  await assert.rejects(service.authenticateWallet(proof,origin,'b'.repeat(64)),/expired/);
  await assert.rejects(service.authenticateWallet({...proof,signature:signature(c.message,other)},origin,binding),/Invalid wallet signature/);
  const identity=await service.authenticateWallet(proof,origin,binding);
  assert.match(identity.username,/^[a-z]+-[a-z]+-[a-f0-9]{8}$/);assert.equal(identity.authType,'wallet');assert.equal(identity.role,'user');assert.equal(identity.mainWallet,wallet.publicKey.toBase58());
  assert.equal(await service.storeFor(identity.id).read('main-wallet',null),null);
  await assert.rejects(service.authenticateWallet(proof,origin,binding),/expired/);
  const c2=await service.walletChallenge(identity.mainWallet,origin,binding);
  assert.equal((await service.authenticateWallet({nonce:c2.nonce,signature:signature(c2.message)},origin,binding)).id,identity.id);
  const c3=await service.walletChallenge(identity.mainWallet,origin,binding);now+=300001;
  await assert.rejects(service.authenticateWallet({nonce:c3.nonce,signature:signature(c3.message)},origin,binding),/expired/);
  assert.equal((await service.get(identity.id)).username,identity.username);
  await assert.rejects(service.authenticate(identity.username,'fixture-invalid-password'),/Invalid username or password/);
  const session=await service.createSession(identity.id);assert.equal((await service.getSession(session.token)).account.authType,'wallet');
});

test('profile renames are unique, atomic and limited to 30 days while bio and owned avatar remain editable',async t=>{
 let now=Date.now();const {service}=await harness(t,{now:()=>now});const a=await service.register('profile_one',password),b=await service.register('profile_two',password),avatar='a'.repeat(64)+'.png';
 await service.storeFor(a.id).write('launch-images',{ids:[avatar]});
 await assert.rejects(service.updateProfile(a.id,{username:b.username}),/taken/);
 const updated=await service.updateProfile(a.id,{username:'new_creator',bio:'My coins',avatarId:avatar});assert.equal(updated.username,'new_creator');assert.equal(updated.avatar,'/token-images/'+avatar);
 await assert.rejects(service.updateProfile(a.id,{username:'another_name'}),/30 days/);
 assert.equal((await service.updateProfile(a.id,{username:'new_creator',bio:'Updated bio',avatarId:avatar})).bio,'Updated bio');
 await assert.rejects(service.updateProfile(b.id,{username:b.username,avatarId:avatar}),/own profile picture/);
 await assert.rejects(service.updateProfile(b.id,{username:b.username,bio:'x'.repeat(281)}),/280/);
 now+=30*86400000;assert.equal((await service.updateProfile(a.id,{username:'another_name'})).username,'another_name');
 const c=await service.register('profile_three',password);const results=await Promise.allSettled([service.updateProfile(b.id,{username:'same_name'}),service.updateProfile(c.id,{username:'same_name'})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});

test('administrator bans revoke sessions and block password and wallet entry until restored',async t=>{
 const {service}=await harness(t),admin=await service.register('moderator',password),user=await service.register('moderated',password),session=await service.createSession(user.id);
 await service.mutate(r=>{const a=r.accounts.find(a=>a.id===admin.id);a.role='admin';a.mfa={secret:'A'.repeat(32),lastCounter:0,recoveryHashes:[]};});
 await assert.rejects(service.moderateUser(user.id,{target:'moderator',banned:true,reason:'Rule violation'}),/Administrator/);
 await service.moderateUser(admin.id,{target:user.username,banned:true,reason:'Rule violation'});
 assert.equal(await service.getSession(session.token),null);await assert.rejects(service.authenticate(user.username,password),/banned/);await assert.rejects(service.createSession(user.id),/banned/);await assert.rejects(service.assertWalletAllowed(user.mainWallet),/banned/);
 await service.moderateUser(admin.id,{target:user.mainWallet,banned:false,reason:'Appeal accepted'});assert.equal((await service.authenticate(user.username,password)).banned,false);
 const unknown=Keypair.generate().publicKey.toBase58();await service.moderateUser(admin.id,{target:unknown,banned:true,reason:'Known abusive wallet'});await assert.rejects(service.walletChallenge(unknown,'https://launchpad.example','browser-binding'),/banned/);
 await assert.rejects(service.moderateUser(admin.id,{target:admin.username,banned:true,reason:'Accidental self ban'}),/cannot be banned/);
});

test('wallet reconnect preserves the existing profile and launches instead of creating another account',async t=>{
  const {createPrivateKey,sign}=await import('node:crypto');
  const {service}=await harness(t),wallet=Keypair.generate(),origin='https://launchpad.example';
  const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(wallet.secretKey.slice(0,32))]),format:'der',type:'pkcs8'});
  const login=async binding=>{const challenge=await service.walletChallenge(wallet.publicKey.toBase58(),origin,binding);return service.authenticateWallet({nonce:challenge.nonce,signature:sign(null,Buffer.from(challenge.message),key).toString('base64')},origin,binding);};
  const created=await login('first-browser-binding'),avatar='b'.repeat(64)+'.webp';await service.storeFor(created.id).write('launch-images',{ids:[avatar]});
  const edited=await service.updateProfile(created.id,{username:'returning_creator',bio:'Existing creator bio',avatarId:avatar});await service.setCashback(created.id,2500);
  await service.storeFor(created.id).write('launchpad',{launches:[{id:'existing-owned-launch'}]});
  const firstSession=await service.createSession(created.id);await service.revokeSession(firstSession.token);
  const restored=await login('new-browser-binding');assert.equal(restored.id,created.id);assert.equal(restored.username,edited.username);assert.equal(restored.bio,edited.bio);assert.equal(restored.avatar,edited.avatar);assert.equal(restored.cashbackBps,2500);assert.equal(restored.usernameChangeAvailableAt,edited.usernameChangeAvailableAt);assert.equal(restored.mainWallet,wallet.publicKey.toBase58());assert.equal(restored.role,'user');
  assert.equal((await service.list()).length,1);assert.deepEqual((await service.storeFor(restored.id).read('launchpad')).launches,[{id:'existing-owned-launch'}]);assert.equal(await service.storeFor(restored.id).read('main-wallet',null),null);assert.equal(await service.storeFor(restored.id).read('robinhood-account',null),null);assert.deepEqual((await service.storeFor(restored.id).read('settings')).wallets,[]);
});

test('a matching manual administrator wallet never links or upgrades a wallet-login account or bypasses administrator MFA',async t=>{
  const {createPrivateKey,sign}=await import('node:crypto');
  const {service}=await harness(t),manual=await service.register('manual_wallet_owner',password),exported=await service.exportMainWallet(manual.id,password),wallet=Keypair.fromSecretKey(bs58.decode(exported.privateKey));
  await service.mutate(registry=>{const record=registry.accounts.find(a=>a.id===manual.id);record.role='admin';record.mfa={secret:'A'.repeat(32),lastCounter:0,recoveryHashes:[]};});
  const origin='https://launchpad.example',binding='known-wallet-binding',challenge=await service.walletChallenge(wallet.publicKey.toBase58(),origin,binding);
  const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(wallet.secretKey.slice(0,32))]),format:'der',type:'pkcs8'});
  const connected=await service.authenticateWallet({nonce:challenge.nonce,signature:sign(null,Buffer.from(challenge.message),key).toString('base64')},origin,binding);
  assert.notEqual(connected.id,manual.id);assert.equal(connected.authType,'wallet');assert.equal(connected.role,'user');assert.equal(connected.mfaEnabled,false);assert.notEqual(connected.username,manual.username);assert.equal(connected.mainWallet,manual.mainWallet);
  const session=await service.createSession(connected.id);assert.equal((await service.getSession(session.token)).account.id,connected.id);assert.equal((await service.getSession(session.token)).mfaVerified,false);
  await assert.rejects(service.createSession(manual.id),/Two-factor authentication required/);await assert.rejects(service.authenticate(manual.username,password),/authenticator code/);assert.equal((await service.get(manual.id)).role,'admin');assert.equal((await service.list()).length,2);wallet.secretKey.fill(0);
});
