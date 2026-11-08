import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AccountService } from '../src/accounts.mjs';
import { settingsSecrets, secretFields } from '../src/account-secrets.mjs';
import { base32, totp, verifyTotp } from '../src/totp.mjs';
import { defaults } from '../src/telegram-settings.mjs';
import { config } from './fixtures.mjs';

const password = 'security-test-password-9281';
async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-security-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = Date.now();
  const accounts = await new AccountService(dir, { now: () => now }).init();
  const user = await accounts.register('security_user', password);
  return { dir, accounts, user, get now() { return now; }, advance() { now += 30000; } };
}

test('TOTP matches every RFC 6238 SHA-1 test vector including dates beyond 2038', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  for (const [seconds, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) assert.equal(totp(secret, seconds * 1000, 8), expected);
  assert.equal(verifyTotp(secret, totp(secret, 90000), 90000, 3), null);
  assert.equal(verifyTotp(secret, '12345', 90000), null);
  assert.equal(verifyTotp(secret, totp(secret, 90000), 90000, 2), 3);
});

test('enrollment requires password and code; login, export and old sessions cannot bypass MFA', async t => {
  const h = await harness(t), { accounts, user } = h;
  const old = await accounts.createSession(user.id), link = await accounts.createLinkCode(user.id);
  await assert.rejects(accounts.beginMfa(user.id, 'wrong-password'));
  const enrollment = await accounts.beginMfa(user.id, password);
  await assert.rejects(accounts.enableMfa(user.id, password, 'invalid'));
  assert.equal((await accounts.get(user.id)).mfaEnabled, false);
  const recovery = await accounts.enableMfa(user.id, password, totp(enrollment.secret, h.now));
  assert.equal(recovery.recoveryCodes.length, 10);
  assert.equal(await accounts.getSession(old.token), null);
  await assert.rejects(accounts.redeemLinkCode(link.code, 9001), /invalid or expired/);
  await assert.rejects(accounts.createSession(user.id), /Two-factor/);
  await assert.rejects(accounts.authenticate(user.username, password), /authenticator/);
  await assert.rejects(accounts.exportMainWallet(user.id, password), /authenticator/);
  await assert.rejects(accounts.authenticate(user.username, password, totp(enrollment.secret, h.now)), /already used/);
  h.advance(); const code = totp(enrollment.secret, h.now);
  assert.equal((await accounts.authenticate(user.username, password, code)).id, user.id);
  await assert.rejects(accounts.authenticate(user.username, password, code), /already used/);
  const restarted = await new AccountService(h.dir, { now: () => h.now }).init();
  await assert.rejects(restarted.authenticate(user.username, password, code), /already used/);
  const session = await accounts.createSession(user.id, { mfaVerified: true }); assert.ok((await accounts.getSession(session.token)).mfaVerified);
  const registry = await readFile(join(h.dir, 'registry.enc'), 'utf8');
  assert.ok(!registry.includes(enrollment.secret)); assert.ok(!registry.includes(recovery.recoveryCodes[0]));
  const publicData = JSON.stringify([await accounts.get(user.id), await accounts.list(), await accounts.getSession(session.token)]);
  assert.ok(!publicData.includes(enrollment.secret)); assert.ok(!publicData.includes(recovery.recoveryCodes[0]));
});

test('recovery codes are single-use under concurrent authentication and survive restart as hashes', async t => {
  const h = await harness(t), { accounts, user } = h;
  const setup = await accounts.beginMfa(user.id, password);
  const recovery = await accounts.enableMfa(user.id, password, totp(setup.secret, h.now));
  const second = await new AccountService(h.dir, { now: () => h.now }).init();
  const attempts = await Promise.allSettled([accounts.authenticate(user.username, password, recovery.recoveryCodes[0]), second.authenticate(user.username, password, recovery.recoveryCodes[0])]);
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
  assert.equal((await accounts.get(user.id)).recoveryCodesRemaining, 9);
  assert.ok(!JSON.stringify(await accounts.registry()).includes(recovery.recoveryCodes[0]));
  await assert.rejects(second.authenticate(user.username, password, recovery.recoveryCodes[0]), /Invalid/);
});

test('admin MFA cannot be disabled; revoking access disconnects Telegram and every session', async t => {
  const h = await harness(t), { accounts, user } = h;
  const setup = await accounts.beginMfa(user.id, password);
  const recovery = await accounts.enableMfa(user.id, password, totp(setup.secret, h.now));
  await accounts.setAdmin(user.id);
  await assert.rejects(accounts.disableMfa(user.id, password, recovery.recoveryCodes[0]), /must keep/);
  const session = await accounts.createSession(user.id, { mfaVerified: true }), link = await accounts.createLinkCode(user.id);
  await accounts.redeemLinkCode(link.code, 9123);
  await accounts.revokeAllAccess(user.id, password, recovery.recoveryCodes[1]);
  assert.equal(await accounts.getSession(session.token), null); assert.equal(await accounts.getTelegramAccount(9123), null);
  assert.equal((await accounts.get(user.id)).mainWallet, user.mainWallet);
  assert.equal((await accounts.securityEvents(user.id))[0].action, 'all-access-revoked');
});

test('password change requires the second factor, invalidates Telegram and does not reset wallets', async t => {
  const h = await harness(t), { accounts, user } = h;
  const setup = await accounts.beginMfa(user.id, password), recovery = await accounts.enableMfa(user.id, password, totp(setup.secret, h.now));
  const link = await accounts.createLinkCode(user.id); await accounts.redeemLinkCode(link.code, 9421);
  await assert.rejects(accounts.changePassword(user.id, password, 'updated-security-password'), /authenticator/);
  await accounts.changePassword(user.id, password, 'updated-security-password', recovery.recoveryCodes[0]);
  assert.equal(await accounts.getTelegramAccount(9421), null);
  assert.equal((await accounts.exportMainWallet(user.id, 'updated-security-password', recovery.recoveryCodes[1])).publicKey, user.mainWallet);
});

test('password sessions reject proof completed before a password reset and require a new login', async t => {
  const { accounts, user } = await harness(t);
  const proof = await accounts.authenticate(user.username, password);
  const old = await accounts.createAuthenticatedSession(await accounts.authenticate(user.username, password));
  await accounts.changePassword(user.id, password, 'replacement-security-password');
  await assert.rejects(accounts.createAuthenticatedSession(proof), /security changed/);
  assert.equal(await accounts.getSession(old.token), null);
  const fresh = await accounts.createAuthenticatedSession(await accounts.authenticate(user.username, 'replacement-security-password'));
  assert.equal((await accounts.getSession(fresh.token)).account.id, user.id);
});

test('password session proof is opaque, short lived, single use and bound to server account identity', async t => {
  const h = await harness(t), { accounts, user } = h;
  await assert.rejects(accounts.createAuthenticatedSession({ ...user }), /Verify your account/);
  const proof = await accounts.authenticate(user.username, password);
  proof.id = 'f'.repeat(32); proof.mfaEnabled = true;
  const attempts = await Promise.allSettled([accounts.createAuthenticatedSession(proof), accounts.createAuthenticatedSession(proof)]);
  assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1);
  const session = await accounts.getSession(attempts.find(row => row.status === 'fulfilled').value.token);
  assert.equal(session.account.id, user.id); assert.equal(session.mfaVerified, false);
  const expired = await accounts.authenticate(user.username, password); h.advance();
  await assert.rejects(accounts.createAuthenticatedSession(expired), /verification expired/);
});

test('logout-all, MFA changes and a ban invalidate pending password session issuance', async t => {
  const h = await harness(t), { accounts, user } = h;
  const beforeLogout = await accounts.authenticate(user.username, password);
  await accounts.revokeAllAccess(user.id, password);
  await assert.rejects(accounts.createAuthenticatedSession(beforeLogout), /security changed/);
  const beforeMfa = await accounts.authenticate(user.username, password);
  const setup = await accounts.beginMfa(user.id, password);
  const enrollment = await accounts.enableMfa(user.id, password, totp(setup.secret, h.now));
  await assert.rejects(accounts.createAuthenticatedSession(beforeMfa), /security changed/);
  const enrolled = await accounts.createAuthenticatedSession(enrollment);
  assert.equal((await accounts.getSession(enrolled.token)).mfaVerified, true);
  const beforeDisable = await accounts.authenticate(user.username, password, enrollment.recoveryCodes[0]);
  await accounts.disableMfa(user.id, password, enrollment.recoveryCodes[1]);
  await assert.rejects(accounts.createAuthenticatedSession(beforeDisable), /security changed/);
  assert.equal(await accounts.getSession(enrolled.token), null);
  const beforeBan = await accounts.authenticate(user.username, password);
  await accounts.mutate(registry => { registry.accounts.find(row => row.id === user.id).banned = true; });
  await assert.rejects(accounts.createAuthenticatedSession(beforeBan), /banned/);
});

test('registration and MFA enrollment cannot issue a session after a concurrent security reset', async t => {
  const h = await harness(t), { accounts, user } = h;
  await accounts.revokeAllAccess(user.id, password);
  await assert.rejects(accounts.createAuthenticatedSession(user), /security changed/);
  const setup = await accounts.beginMfa(user.id, password);
  const enrollment = await accounts.enableMfa(user.id, password, totp(setup.secret, h.now));
  await accounts.revokeAllAccess(user.id, password, enrollment.recoveryCodes[0]);
  await assert.rejects(accounts.createAuthenticatedSession(enrollment), /security changed/);
});

test('masked settings preserve all secrets without cross-account, field-swap or stale-reference resolution', () => {
  const key = randomBytes(32), settings = { ...structuredClone(defaults), ...config({ mode: 'live' }) };
  for (const field of secretFields) settings[field] = `secret-${field}`;
  const a = settingsSecrets(key, 'alice', settings), b = settingsSecrets(key, 'bob', settings);
  for (const value of [...secretFields.map(f => settings[f]), ...settings.wallets.map(w => w.privateKey)]) assert.ok(!JSON.stringify(a.protectedSettings).includes(value));
  assert.deepEqual(a.resolve(a.protectedSettings), settings);
  assert.throws(() => b.resolve(a.protectedSettings), /another account/);
  assert.throws(() => a.resolve({ ...a.protectedSettings, rpcUrl: a.protectedSettings.heliusKey }), /another account/);
  const updated = settingsSecrets(key, 'alice', { ...settings, heliusKey: 'changed' });
  assert.throws(() => updated.resolve(a.protectedSettings), /changed/);
  assert.equal(a.resolve({ ...a.protectedSettings, heliusKey: '' }).heliusKey, '');
});

test('a separate protected master key can open existing data; missing or permissive key files fail closed', async t => {
  const h = await harness(t), outside = join(h.dir, 'external.key');
  await writeFile(outside, await readFile(join(h.dir, 'master.key')), { mode: 0o600 });
  await rm(join(h.dir, 'master.key'));
  const second = await new AccountService(h.dir, { keyFile: outside }).init();
  assert.equal((await second.get(h.user.id)).mainWallet, h.user.mainWallet);
  await assert.rejects(new AccountService(h.dir, { keyFile: join(h.dir, 'missing.key') }).init(), /ENOENT/);
  if (process.platform !== 'win32') { await chmod(outside, 0o644); await assert.rejects(new AccountService(h.dir, { keyFile: outside }).init(), /only by its owner/); }
});
