// The linked EVM wallet (v71.40): challenge → EIP-191 personal signature → link; unlink; one wallet per account; the
// proof is bound to the session, the account, the origin, the security stamp and the expiry; a password account
// verifies its password and second factor, a wallet-created account its wallet session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, sign as edSign } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { AccountService, evmSignatureAddress } from '../src/accounts.mjs';
import { totp } from '../src/totp.mjs';
import { randomPrivateKey, privateKeyToAddress, sign, signatureBytes, checksumAddress } from '../src/evm/secp256k1.mjs';
import { personalMessageHash } from '../src/evm/tx.mjs';

const password = 'evm-link-password-123', origin = 'https://launchpad.example';
const evmWallet = () => { const key = randomPrivateKey(); return { key, address: privateKeyToAddress(key) }; };
/** What MetaMask returns for personal_sign: 65 bytes, v = 27 / 28. */
const personalSign = (wallet, message) => '0x' + signatureBytes(sign(personalMessageHash(message), wallet.key)).toString('hex');
const solSignature = (wallet, message) => edSign(null, Buffer.from(message), createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(wallet.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' })).toString('base64');
async function harness(t) { const dir = await mkdtemp(join(tmpdir(), 'launchpad-evm-link-')); t.after(() => rm(dir, { recursive: true, force: true })); let now = Date.now(); const service = await new AccountService(dir, { now: () => now }).init(); return { service, advance(ms = 30000) { now += ms; }, get now() { return now; } }; }
async function prove(service, wallet) { const binding = 'b'.repeat(64), challenge = await service.walletChallenge(wallet.publicKey.toBase58(), origin, binding); return service.authenticateWallet({ nonce: challenge.nonce, signature: solSignature(wallet, challenge.message) }, origin, binding); }
async function link(h, account, wallet, context, { code } = {}) { const c = await h.service.evmWalletChallenge(account.id, { address: wallet.address, password, ...(code ? { code } : {}) }, context); return h.service.linkEvmWallet(account.id, { nonce: c.nonce, signature: personalSign(wallet, c.message) }, context); }

test('evmSignatureAddress recovers the signer of a personal message (v = 27/28 or 0/1) and refuses anything else', () => {
  const wallet = evmWallet(), message = 'Launchpad link EVM wallet\nNonce: 1';
  const signature = personalSign(wallet, message);
  assert.equal(evmSignatureAddress(message, signature), checksumAddress(wallet.address));
  const raw = Buffer.from(signature.slice(2), 'hex'); raw[64] -= 27;
  assert.equal(evmSignatureAddress(message, '0x' + raw.toString('hex')), checksumAddress(wallet.address), 'v = 0/1 is accepted too');
  assert.notEqual(evmSignatureAddress(message + '!', signature), checksumAddress(wallet.address), 'another message recovers another address');
  for (const bad of ['', '0x12', signature.slice(0, -2), signature.slice(2), 42, null]) assert.throws(() => evmSignatureAddress(message, bad), /Invalid wallet signature/);
  raw[64] = 9; assert.throws(() => evmSignatureAddress(message, '0x' + raw.toString('hex')), /Invalid wallet signature/);
});

test('a password account links an EVM wallet with its password, the wallet signature and a session-bound challenge; one wallet per account; unlink', async t => {
  const h = await harness(t), s = h.service, a = await s.register('evm_first', password), b = await s.register('evm_second', password);
  const wallet = evmWallet(), other = evmWallet(), one = await s.createSession(a.id), two = await s.createSession(a.id), bSession = await s.createSession(b.id), context = { token: one.token, origin };
  assert.equal((await s.get(a.id)).evmWallet, '');
  await assert.rejects(s.evmWalletChallenge(a.id, { address: wallet.address }, context), /Invalid username or password/);
  await assert.rejects(s.evmWalletChallenge(a.id, { address: 'not-an-address', password }, context), /valid EVM wallet address/);
  await assert.rejects(s.evmWalletChallenge(a.id, { address: '0x' + '0'.repeat(40), password }, context), /valid EVM wallet address/);
  const c = await s.evmWalletChallenge(a.id, { address: wallet.address.toLowerCase(), password }, context);
  assert.equal(c.address, checksumAddress(wallet.address), 'the challenge carries the checksummed address');
  assert.ok(c.message.includes(a.id) && c.message.includes(c.address) && c.message.includes('does not change how you sign in'));
  const body = { nonce: c.nonce, signature: personalSign(wallet, c.message) };
  await assert.rejects(s.linkEvmWallet(a.id, body, { token: two.token, origin }), /expired or changed/, 'another session of the same account cannot finish it');
  await assert.rejects(s.linkEvmWallet(a.id, body, { ...context, origin: 'https://evil.invalid' }), /expired or changed/);
  await assert.rejects(s.linkEvmWallet(b.id, body, { token: bSession.token, origin }), /expired or changed/);
  await assert.rejects(s.linkEvmWallet(a.id, { ...body, signature: personalSign(other, c.message) }, context), /did not come from the wallet/);
  await assert.rejects(s.linkEvmWallet(a.id, { ...body, signature: '0xzz' }, context), /Invalid wallet signature/);
  const linked = await s.linkEvmWallet(a.id, body, context);
  assert.equal(linked.id, a.id); assert.equal(linked.evmWallet, checksumAddress(wallet.address)); assert.ok(linked.evmWalletLinkedAt > 0);
  assert.equal(linked.signInWallet, '', 'the sign-in wallet is untouched'); assert.equal(linked.mainWallet, a.mainWallet);
  await assert.rejects(s.linkEvmWallet(a.id, body, context), /expired or changed/, 'single use');
  assert.equal((await s.accountByEvmWallet(wallet.address.toLowerCase())).id, a.id);
  assert.equal(await s.accountByEvmWallet(other.address), null);
  // one wallet, one account
  await assert.rejects(s.evmWalletChallenge(b.id, { address: wallet.address, password }, { token: bSession.token, origin }), /already linked to another/);
  const bc = await s.evmWalletChallenge(b.id, { address: other.address, password }, { token: bSession.token, origin });
  await s.mutate(registry => { registry.accounts.find(r => r.id === a.id).evmWallet = checksumAddress(other.address); });
  await assert.rejects(s.linkEvmWallet(b.id, { nonce: bc.nonce, signature: personalSign(other, bc.message) }, { token: bSession.token, origin }), /already linked to another/, 'checked again at link time');
  await s.mutate(registry => { registry.accounts.find(r => r.id === a.id).evmWallet = checksumAddress(wallet.address); });
  // replacing the linked wallet re-verifies, then unlink
  const replaced = await link(h, a, other, context); assert.equal(replaced.evmWallet, checksumAddress(other.address));
  await assert.rejects(s.unlinkEvmWallet(a.id, { password: 'wrong-password-1234' }, context), /Invalid username or password/);
  const unlinked = await s.unlinkEvmWallet(a.id, { password }, context); assert.equal(unlinked.evmWallet, ''); assert.equal(unlinked.evmWalletLinkedAt, 0);
  await assert.rejects(s.unlinkEvmWallet(a.id, { password }, context), /No EVM wallet is linked/);
  // an expired challenge
  const c2 = await s.evmWalletChallenge(a.id, { address: wallet.address, password }, context); h.advance(300001);
  await assert.rejects(s.linkEvmWallet(a.id, { nonce: c2.nonce, signature: personalSign(wallet, c2.message) }, context), /expired or changed/);
  // the registry validates the stored wallet: a non-checksummed or duplicated value is damage, read back as such
  await s.mutate(registry => { registry.accounts.find(r => r.id === a.id).evmWallet = wallet.address.toLowerCase(); });
  await assert.rejects(s.get(a.id), /EVM wallet data is damaged/);
});

test('a second factor is required on an MFA account; a password change or a sign-in wallet change voids a pending challenge', async t => {
  const h = await harness(t), s = h.service, a = await s.register('evm_mfa', password), wallet = evmWallet();
  const setup = await s.beginMfa(a.id, password); await s.enableMfa(a.id, password, totp(setup.secret, h.now)); h.advance();
  const session = await s.createSession(a.id, { mfaVerified: true }), context = { token: session.token, origin };
  await assert.rejects(s.evmWalletChallenge(a.id, { address: wallet.address, password }, context), /authenticator/);
  const linked = await link(h, a, wallet, context, { code: totp(setup.secret, h.now) }); assert.equal(linked.evmWallet, checksumAddress(wallet.address));
  h.advance(); const other = evmWallet(), c = await s.evmWalletChallenge(a.id, { address: other.address, password, code: totp(setup.secret, h.now) }, context);
  h.advance(); await s.changePassword(a.id, password, 'a-new-password-for-evm-1', totp(setup.secret, h.now));
  await assert.rejects(s.linkEvmWallet(a.id, { nonce: c.nonce, signature: personalSign(other, c.message) }, context), /Sign in again|expired or changed/, 'the security stamp changed');
});

test('a wallet-created account links its EVM wallet from its wallet session with the EVM signature alone', async t => {
  const h = await harness(t), s = h.service, sol = Keypair.generate(), a = await prove(s, sol), wallet = evmWallet();
  assert.equal(a.authType, 'wallet');
  const auth = await s.createWalletSession(a), context = { token: auth.token, origin };
  const c = await s.evmWalletChallenge(a.id, { address: wallet.address }, context);
  const linked = await s.linkEvmWallet(a.id, { nonce: c.nonce, signature: personalSign(wallet, c.message) }, context);
  assert.equal(linked.evmWallet, checksumAddress(wallet.address)); assert.equal(linked.signInWallet, sol.publicKey.toBase58());
  const unlinked = await s.unlinkEvmWallet(a.id, {}, context); assert.equal(unlinked.evmWallet, '');
  // a plain (non-wallet) session token of a wallet account is refused
  await assert.rejects(s.evmWalletChallenge(a.id, { address: wallet.address }, { token: 'x'.repeat(43), origin }), /Sign in again/);
});
