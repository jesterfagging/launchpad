// The EVM wallet editor in Edit profile (v71.40): choose a wallet → verify the account (password accounts) → sign the
// server's challenge in the wallet → link; disconnect; a wallet-created account skips the password step; cancelling
// mid-flow never writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createEvmWalletLinkUI } from '../public/evm-wallet-link-ui.mjs';

const main = '4'.repeat(44), target = '0x' + 'ab'.repeat(20), other = '0x' + 'cd'.repeat(20);
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

function fixture({ wallet = false, linked = '', wallets = [{ uuid: 'mm', name: 'MetaMask' }], connected = false, handler, authorization, mfa = false } = {}) {
  const { document, window } = parseHTML('<html><body><div id="container"></div></body></html>');
  let account = { id: 'acct-1', username: 'creator', authType: wallet ? 'wallet' : 'password', mainWallet: main, evmWallet: linked, role: 'user', mfaEnabled: mfa }, active = true, address = connected ? target : '';
  const calls = [], proofs = [], updates = [], authorizations = [], connections = [], listeners = new Set();
  const walletState = {
    state: () => ({ address, chainId: 4663, wallet: address ? 'MetaMask' : '' }), list: () => wallets,
    onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    connect: async uuid => { connections.push(uuid); if (!uuid && wallets.length !== 1) throw Object.assign(Error('Choose a wallet.'), { code: 'EVM_WALLET_CHOOSE', wallets }); address = target; for (const listener of listeners) listener(walletState.state()); return walletState.state(); },
    signMessage: async message => { proofs.push(message); return '0x' + '11'.repeat(65); },
  };
  const ui = createEvmWalletLinkUI({ document, window: { ...window, navigator: { clipboard: { writeText: async () => {} } } }, container: document.getElementById('container'), getAccount: () => account, isActive: () => active,
    walletFactory: () => walletState,
    authorize: async action => { authorizations.push(action); return authorization ? authorization(action) : { password: 'fresh-password', code: '123456' }; },
    api: async (path, body) => { calls.push({ path, body }); if (handler) { const result = await handler(path, body); if (result !== undefined) return result; } if (path.endsWith('/challenge')) return { nonce: 'single-use-nonce', message: 'Launchpad link EVM wallet\nNonce: single-use-nonce', address: body.address }; return { account: { ...account, evmWallet: path.endsWith('/unlink') ? '' : target } }; },
    onSaved: value => { account = value; updates.push(value); } });
  ui.render();
  const $ = name => document.querySelector('[data-evw-' + name + ']');
  return { document, ui, $, calls, proofs, updates, authorizations, connections, get account() { return account; }, setAddress: value => { address = value; for (const listener of listeners) listener(walletState.state()); }, edit: () => $('edit').onclick(), submit: () => $('save').onclick(), close() { active = false; ui.cancel(); } };
}

test('a password account links: choose the only wallet, verify, sign the exact challenge, save', async () => {
  const f = fixture();
  assert.equal(f.$('address').textContent, 'No EVM wallet linked.'); assert.equal(f.$('edit').textContent, 'Connect EVM wallet'); assert.equal(f.$('unlink').hidden, true);
  f.edit(); assert.equal(f.$('form').hidden, false); assert.equal(f.$('save').disabled, true, 'nothing to link before a wallet is chosen');
  await f.submit(); assert.equal(f.calls.length, 0); assert.equal(f.authorizations.length, 0);
  await f.$('connect').onclick(); assert.deepEqual(f.connections, ['mm']); assert.equal(f.$('selected').textContent, target); assert.equal(f.$('save').disabled, false);
  await f.submit();
  assert.deepEqual(f.authorizations, ['Connect EVM wallet']);
  assert.deepEqual(f.calls, [
    { path: '/api/account/evm-wallet/challenge', body: { address: target, password: 'fresh-password', code: '123456' } },
    { path: '/api/account/evm-wallet', body: { nonce: 'single-use-nonce', signature: '0x' + '11'.repeat(65) } },
  ]);
  assert.deepEqual(f.proofs, ['Launchpad link EVM wallet\nNonce: single-use-nonce'], 'the wallet signs the server-issued text, verbatim');
  assert.equal(f.updates.length, 1); assert.equal(f.account.evmWallet, target);
  assert.equal(f.$('address').textContent, target); assert.equal(f.$('form').hidden, true); assert.equal(f.$('edit').textContent, 'Change EVM wallet'); assert.equal(f.$('unlink').hidden, false);
  assert.match(f.$('message').textContent, /EVM wallet linked: 0xabab…abab/);
});

test('a wallet-created account skips the password step; several wallets show a picker', async () => {
  const wallets = [{ uuid: 'mm', name: 'MetaMask' }, { uuid: 'rabby', name: 'Rabby' }];
  const f = fixture({ wallet: true, wallets });
  f.edit(); await f.$('connect').onclick();
  assert.equal(f.$('wallets').hidden, false); assert.deepEqual([...f.$('wallets').querySelectorAll('button')].map(b => b.textContent), ['MetaMask', 'Rabby']);
  await f.$('wallets').querySelectorAll('button')[1].onclick(); assert.deepEqual(f.connections, ['rabby']); assert.equal(f.$('wallets').hidden, true);
  await f.submit();
  assert.equal(f.authorizations.length, 0, 'no password dialog on a wallet account');
  assert.deepEqual(f.calls.map(c => c.path), ['/api/account/evm-wallet/challenge', '/api/account/evm-wallet']);
  assert.deepEqual(f.calls[0].body, { address: target });
  assert.equal(f.account.evmWallet, target);
});

test('disconnecting verifies a password account and clears the link; a wallet account disconnects directly', async () => {
  const f = fixture({ linked: target });
  assert.equal(f.$('address').textContent, target); assert.equal(f.$('unlink').hidden, false);
  await f.$('unlink').onclick();
  assert.deepEqual(f.authorizations, ['Disconnect EVM wallet']);
  assert.deepEqual(f.calls, [{ path: '/api/account/evm-wallet/unlink', body: { password: 'fresh-password', code: '123456' } }]);
  assert.equal(f.account.evmWallet, ''); assert.equal(f.$('address').textContent, 'No EVM wallet linked.'); assert.equal(f.$('unlink').hidden, true);
  const w = fixture({ wallet: true, linked: target }); await w.$('unlink').onclick();
  assert.equal(w.authorizations.length, 0); assert.deepEqual(w.calls, [{ path: '/api/account/evm-wallet/unlink', body: {} }]); assert.equal(w.account.evmWallet, '');
});

test('a wallet that changes between the challenge and the signature, or a server refusal, never links', async () => {
  const f = fixture({ connected: true, handler: async path => { if (path.endsWith('/challenge')) { f.setAddress(other); } } });
  f.edit(); await f.submit();
  assert.equal(f.proofs.length, 0, 'no signature was requested'); assert.equal(f.updates.length, 0); assert.match(f.$('message').textContent, /wallet changed/i);
  const g = fixture({ connected: true, handler: async path => { if (path === '/api/account/evm-wallet') throw Error('This wallet is already linked to another Launchpad account. Disconnect it there first.'); } });
  g.edit(); await g.submit();
  assert.equal(g.proofs.length, 1); assert.equal(g.updates.length, 0); assert.match(g.$('message').textContent, /already linked to another/); assert.equal(g.account.evmWallet, '');
});

test('cancelling while the password check is pending prevents every request', async () => {
  const pending = deferred(), f = fixture({ connected: true, authorization: () => pending.promise });
  f.edit(); const saving = f.submit(); await flush();
  f.close(); pending.resolve({ password: 'fresh-password', code: '123456' }); await saving;
  assert.equal(f.calls.length, 0); assert.equal(f.proofs.length, 0); assert.equal(f.updates.length, 0);
});
