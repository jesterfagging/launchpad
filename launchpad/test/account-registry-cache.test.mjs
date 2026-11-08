import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { AccountService } from '../src/accounts.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, count = 1, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-account-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = Date.now();
  const service = await new AccountService(dir, { now: () => now, ...options }).init();
  const wallet = Keypair.generate().publicKey.toBase58(), rows = [];
  await service.mutate(registry => {
    for (let i = 0; i < count; i++) {
      const id = randomBytes(16).toString('hex'), token = randomBytes(32).toString('base64url');
      registry.accounts.push({ id, username: `fixture_${i}`, password: service.dummyPassword, mainWallet: wallet, cashbackBps: 0, role: 'user', createdAt: now, telegramId: null });
      registry.sessions.push({ accountId: id, hash: hash(token), expiresAt: now + 60000, authMethod: 'password', mfaVerified: false });
      rows.push({ id, token });
    }
  });
  return { dir, service, rows, advance: ms => { now += ms; } };
}

test('1,000 concurrent sessions share one decrypted indexed snapshot without sharing mutable results', async t => {
  const { service, rows } = await fixture(t, 1000);
  const read = service.hostStore.read.bind(service.hostStore); let reads = 0;
  service.hostStore.read = async (...args) => { if (args[0] === 'registry') reads++; return read(...args); };
  const sessions = await Promise.all(rows.map(row => service.getSession(row.token)));
  assert.equal(sessions.length, 1000); assert.equal(reads, 1);
  for (let i = 0; i < rows.length; i++) assert.equal(sessions[i].account.id, rows[i].id);
  sessions[0].account.role = 'admin';
  assert.equal((await service.getSession(rows[0].token)).account.role, 'user');
  const snapshot = await service.registry();
  assert.throws(() => { snapshot.accounts[0].role = 'admin'; }, TypeError);
  assert.throws(() => { snapshot.sessions.length = 0; }, TypeError);
  assert.equal(reads, 1);
});

test('warm sessions observe cross-process role changes and revocation immediately', async t => {
  const { service, dir, rows: [row] } = await fixture(t);
  const other = await new AccountService(dir).init();
  assert.equal((await service.getSession(row.token)).account.role, 'user');
  await other.setAdmin(row.id, true);
  assert.equal((await service.getSession(row.token)).account.role, 'admin');
  await other.setAdmin(row.id, false);
  assert.equal((await service.getSession(row.token)).account.role, 'user');
  await other.revokeSession(row.token);
  assert.equal(await service.getSession(row.token), null);
  assert.equal(await service.verifyCsrf(row.token, service.csrfToken(row.token)), false);
});

test('cached records never bypass live ban or expiry checks', async t => {
  const { service, rows: [row], advance } = await fixture(t);
  assert.ok(await service.getSession(row.token));
  await service.mutate(registry => { registry.accounts[0].banned = true; });
  assert.equal(await service.getSession(row.token), null);
  await service.mutate(registry => { registry.accounts[0].banned = false; });
  assert.ok(await service.getSession(row.token));
  advance(60000);
  assert.equal(await service.getSession(row.token), null);
});

test('a read spanning a cross-process commit reloads instead of publishing old authorization', async t => {
  const { service, dir, rows: [row] } = await fixture(t);
  const other = await new AccountService(dir).init(), entered = deferred(), release = deferred();
  const read = service.hostStore.read.bind(service.hostStore); let pause = true;
  service.hostStore.read = async (...args) => {
    const value = await read(...args);
    if (args[0] === 'registry' && pause) { pause = false; entered.resolve(); await release.promise; }
    return value;
  };
  const oldRead = service.getSession(row.token);
  await entered.promise;
  await other.revokeSession(row.token);
  // A new caller must not join a pending decrypt for an older revision.
  assert.equal(await service.getSession(row.token), null);
  release.resolve();
  assert.equal(await oldRead, null);
});

test('a local commit invalidates an older pending cache fill before new callers can join it', async t => {
  const { service, rows: [row], advance } = await fixture(t);
  const editing = deferred(), commit = deferred(), reading = deferred(), release = deferred();
  const mutation = service.mutate(async registry => {
    editing.resolve(); await commit.promise; registry.sessions = [];
  });
  await editing.promise;
  advance(5001);
  const read = service.hostStore.read.bind(service.hostStore); let pause = true;
  service.hostStore.read = async (...args) => {
    const value = await read(...args);
    if (args[0] === 'registry' && pause) { pause = false; reading.resolve(); await release.promise; }
    return value;
  };
  const pending = service.getSession(row.token);
  await reading.promise;
  commit.resolve(); await mutation;
  assert.equal(await service.getSession(row.token), null);
  release.resolve(); assert.equal(await pending, null);
});

test('failed callbacks and failed durable commits cannot leak authorization changes into a cached snapshot', async t => {
  const { service, rows: [row] } = await fixture(t);
  assert.ok(await service.getSession(row.token));
  await assert.rejects(service.mutate(registry => { registry.accounts[0].role = 'admin'; registry.sessions = []; throw new Error('aborted'); }), /aborted/);
  assert.equal((await service.getSession(row.token)).account.role, 'user');
  const write = service.hostStore.write.bind(service.hostStore);
  service.hostStore.write = async () => { throw new Error('Disk full'); };
  await assert.rejects(service.setAdmin(row.id), /Disk full/);
  service.hostStore.write = write;
  assert.equal((await service.getSession(row.token)).account.role, 'user');
});

test('missing, corrupted and structurally invalid registry files fail closed despite a warm cache', async t => {
  const { service, rows: [row] } = await fixture(t), path = service.hostStore.path('registry');
  assert.ok(await service.getSession(row.token));
  const bytes = await readFile(path), info = await stat(path);
  await writeFile(path, Buffer.alloc(bytes.length, 32));
  // Keeping the old length and mtime cannot conceal a changed inode ctime.
  await utimes(path, info.atime, info.mtime);
  await assert.rejects(service.getSession(row.token), /cannot be read/);
  await writeFile(path, bytes); assert.ok(await service.getSession(row.token));
  await rm(path); await assert.rejects(service.getSession(row.token), /registry is missing/);
  await writeFile(path, bytes); assert.ok(await service.getSession(row.token));
  await service.hostStore.write('registry', { version: 1, accounts: [], sessions: [{ accountId: row.id, hash: hash(row.token), expiresAt: Date.now() + 60000 }], links: [] });
  await assert.rejects(service.getSession(row.token), /session data is damaged/);
  await writeFile(path, bytes); assert.ok(await service.getSession(row.token));
});

test('unchanged file snapshots still receive bounded full validation and combined CSRF checks use one read', async t => {
  const { service, rows: [row], advance } = await fixture(t);
  const read = service.hostStore.read.bind(service.hostStore); let reads = 0;
  service.hostStore.read = async (...args) => { if (args[0] === 'registry') reads++; return read(...args); };
  const valid = await service.getSessionWithCsrf(row.token, service.csrfToken(row.token));
  assert.equal(valid.session.account.id, row.id); assert.equal(valid.csrfValid, true); assert.equal(reads, 1);
  assert.equal((await service.getSessionWithCsrf(row.token, 'invalid')).csrfValid, false);
  assert.equal(reads, 1);
  advance(5001); assert.ok(await service.getSession(row.token)); assert.equal(reads, 2);
  await service.revokeSession(row.token);
  assert.deepEqual(await service.getSessionWithCsrf(row.token, service.csrfToken(row.token)), { session: null, csrfValid: false });
});

// Real Ed25519 wallets (node:crypto), so wallet proofs verify with or without the Solana packages.
function edWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { address: bs58.encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)), privateKey };
}
async function walletProof(service, wallet, binding, origin = 'https://launch.example') {
  const challenge = await service.walletChallenge(wallet.address, origin, binding);
  return { nonce: challenge.nonce, signature: sign(null, Buffer.from(challenge.message), wallet.privateKey).toString('base64') };
}

// Wallet-only sign-ins do not use LAUNCHPAD_MAX_USERS (maxUsers); the registry ceiling (maxAccounts,
// 10,000 in production) bounds them, atomically, and existing wallets reconnect at capacity.
test('wallet signup capacity is enforced atomically while existing wallet accounts can reconnect at capacity', async t => {
  const { service } = await fixture(t, 0, { maxAccounts: 1 }), origin = 'https://launch.example';
  const first = edWallet(), second = edWallet();
  const a = await walletProof(service, first, 'first'), b = await walletProof(service, second, 'second');
  const attempts = await Promise.allSettled([service.authenticateWallet(a, origin, 'first', { maxUsers: 1 }), service.authenticateWallet(b, origin, 'second', { maxUsers: 1 })]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(attempts.find(result => result.status === 'rejected').reason.message, /currently full/);
  const winner = attempts[0].status === 'fulfilled' ? first : second;
  const original = attempts.find(result => result.status === 'fulfilled').value;
  const again = await service.authenticateWallet(await walletProof(service, winner, 'again'), origin, 'again', { maxUsers: 1 });
  assert.equal(again.id, original.id); assert.equal((await service.list()).length, 1);
});

test('wallet-only visitors do not use LAUNCHPAD_MAX_USERS, which still bounds password registration', async t => {
  const { service } = await fixture(t, 1), origin = 'https://launch.example', password = 'capacity-password-123';
  for (const binding of ['one', 'two', 'three']) assert.equal((await service.authenticateWallet(await walletProof(service, edWallet(), binding), origin, binding, { maxUsers: 1 })).authType, 'wallet');
  assert.equal((await service.list()).length, 4);
  // One password account already uses the single password slot.
  await assert.rejects(service.register('second_password_user', password, { maxUsers: 1 }), /currently full/);
  // Wallet accounts never use password slots (registration may still fail later for unrelated reasons offline).
  const { service: fresh } = await fixture(t, 0);
  await fresh.authenticateWallet(await walletProof(fresh, edWallet(), 'wallet'), origin, 'wallet', { maxUsers: 1 });
  assert.doesNotMatch(await fresh.register('first_password_user', password, { maxUsers: 1 }).then(() => 'registered', error => error.message), /currently full/);
});

test('pending wallet challenges never rewrite the registry, are single use and yield the oldest entry when the table is full', async t => {
  const { dir, service } = await fixture(t, 0), origin = 'https://launch.example', wallet = edWallet();
  const before = await stat(join(dir, 'registry.enc'), { bigint: true });
  const first = await walletProof(service, wallet, 'browser-a');
  const after = await stat(join(dir, 'registry.enc'), { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ino, before.ino);
  // A wrong origin or browser binding does not consume the challenge; a valid proof does, once.
  await assert.rejects(service.authenticateWallet(first, 'https://outside.example', 'browser-a'), /expired/);
  await assert.rejects(service.authenticateWallet(first, origin, 'browser-b'), /expired/);
  const results = await Promise.allSettled([service.authenticateWallet(first, origin, 'browser-a'), service.authenticateWallet(first, origin, 'browser-a')]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.match(results.find(row => row.status === 'rejected').reason.message, /expired/);
  // 10,000 pending challenges (the bound) never refuse a new visitor: the oldest yields.
  const oldest = await walletProof(service, wallet, 'oldest');
  for (let i = 0; i < 10000; i++) await service.walletChallenge(wallet.address, origin, 'filler-' + i);
  const newest = await walletProof(service, wallet, 'newest');
  await assert.rejects(service.authenticateWallet(oldest, origin, 'oldest'), /expired/);
  assert.equal((await service.authenticateWallet(newest, origin, 'newest')).mainWallet, wallet.address);
});

test('a username guessed from other addresses cannot lock its owner out of sign-in or reauthentication', async t => {
  const { service } = await fixture(t, 0), id = 'a'.repeat(32), password = 'correct-horse-battery';
  const credential = await service.hashPassword(password);
  await service.mutate(registry => { registry.accounts.push({ id, username: 'owner', password: credential, mainWallet: '', cashbackBps: 0, role: 'admin', createdAt: Date.now(), telegramId: null }); });
  await service.authenticate('owner', password, undefined, { source: '203.0.113.5' });
  const attempt = (source, value = 'wrong-password-' + source) => service.authenticate('owner', value, undefined, { source }).then(() => 'ok', error => error.statusCode || error.message);
  // One address: its own allowance runs out, nobody else is affected.
  for (let i = 0; i < 10; i++) assert.equal(await attempt('198.51.100.1'), 'Invalid username or password.');
  const limited = await service.authenticate('owner', password, undefined, { source: '198.51.100.1' }).catch(error => error);
  assert.equal(limited.statusCode, 429); assert(limited.retryAfterMs > 0 && limited.retryAfterMs <= 15 * 60000);
  assert.equal(await attempt('192.0.2.10', password), 'ok');
  assert.equal((await service.reauthenticate(id, password)).id, id);
  // Many addresses: unfamiliar addresses share a bounded ceiling, the owner's usual address keeps working.
  for (let source = 2; source < 8; source++) for (let i = 0; i < 10; i++) await attempt('198.51.100.' + source);
  assert.equal(await attempt('192.0.2.99', password), 429);
  assert.equal(await attempt('203.0.113.5', password), 'ok');
  assert.equal((await service.reauthenticate(id, password)).id, id);
  // Reauthentication keeps its own allowance.
  for (let i = 0; i < 10; i++) await service.reauthenticate(id, 'wrong-password-x').catch(() => {});
  await assert.rejects(service.reauthenticate(id, password), error => error.statusCode === 429);
  assert.equal(await attempt('203.0.113.5', password), 'ok');
});

test('password change, 2FA removal and sign-out-everywhere hand back one proof for the browser that made the change', async t => {
  const { service } = await fixture(t, 0), password = 'security-change-password';
  const credential = await service.hashPassword(password);
  for (const change of ['password', 'mfa', 'everywhere']) {
    const id = randomBytes(16).toString('hex');
    await service.mutate(registry => { registry.accounts.push({ id, username: 'security_' + change, password: credential, mainWallet: '', cashbackBps: 0, role: 'user', createdAt: Date.now(), telegramId: null }); });
    const current = await service.createSession(id), other = await service.createSession(id);
    const result = change === 'password' ? await service.changePassword(id, password, 'a-new-security-password') : change === 'mfa' ? await service.disableMfa(id, password) : await service.revokeAllAccess(id, password);
    assert.equal(result.id, id);
    assert.equal(await service.getSession(current.token), null); assert.equal(await service.getSession(other.token), null);
    const next = await service.createAuthenticatedSession(result);
    assert.equal((await service.getSession(next.token)).account.id, id);
    await assert.rejects(service.createAuthenticatedSession(result), /Verify your account again/);
  }
});
