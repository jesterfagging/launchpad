// The EVM wallet connection for Robinhood Chain: EIP-6963 discovery plus the injected fallback, connecting (prompted or
// quiet), switching or adding the chain, sending a transaction through the wallet, and the wallet's own events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvmWallet, ROBINHOOD_CHAIN, walletErrorText, isEvmAddress, shortEvmAddress } from '../public/evm-wallet.mjs';

const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222';
/** A scripted EIP-1193 provider: accounts, chain, what it rejects, and the requests it saw. */
function fakeProvider({ accounts = [A], chainId = '0x1', known = true, rejectAccounts = false } = {}) {
  const handlers = {}, calls = [];
  return {
    calls, handlers, chainId,
    async request({ method, params }) {
      calls.push({ method, params });
      switch (method) {
        case 'eth_accounts': return accounts;
        case 'eth_requestAccounts': if (rejectAccounts) throw Object.assign(Error('User rejected the request.'), { code: 4001 }); return accounts;
        case 'eth_chainId': return this.chainId;
        case 'wallet_switchEthereumChain': if (!known) throw Object.assign(Error('Unrecognized chain ID'), { code: 4902 }); this.chainId = params[0].chainId; return null;
        case 'wallet_addEthereumChain': known = true; this.chainId = params[0].chainId; return null;
        case 'eth_sendTransaction': return '0x' + 'ab'.repeat(32);
        case 'eth_getBalance': return '0xde0b6b3a7640000';
        case 'personal_sign': if (params[1] !== accounts[0]) throw Error('wrong account'); return '0x' + 'cd'.repeat(64) + '1b';
        default: throw Error('unexpected ' + method);
      }
    },
    on(type, fn) { (handlers[type] ||= []).push(fn); }, removeListener(type, fn) { handlers[type] = (handlers[type] || []).filter(f => f !== fn); },
    emit(type, value) { for (const fn of handlers[type] || []) fn(value); },
  };
}
function fakeWindow({ injected = null, announced = [] } = {}) {
  const listeners = {}, store = new Map();
  const win = {
    ethereum: injected, localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, dispatchEvent(event) { if (event.type === 'eip6963:requestProvider') for (const entry of announced) for (const fn of listeners['eip6963:announceProvider'] || []) fn({ detail: entry }); return true; },
    Event: class { constructor(type) { this.type = type; } },
  };
  return win;
}

test('addresses and error texts', () => {
  assert.equal(isEvmAddress(A), true); assert.equal(isEvmAddress('0x12'), false); assert.equal(shortEvmAddress(A), '0x1111…1111');
  assert.match(walletErrorText({ code: 4001 }), /rejected/); assert.match(walletErrorText({ code: 4902 }), /not in your wallet yet/); assert.match(walletErrorText({ code: -32002 }), /already asking/);
  assert.equal(walletErrorText({ message: 'see https://secret.example/x failed' }), 'see  failed', 'URLs never reach the page');
  assert.match(walletErrorText(Error('insufficient funds for gas * price + value')), /not hold enough ETH/);
});

test('discovery lists announced wallets and the injected one; a single wallet connects without choosing', async () => {
  const metamask = fakeProvider(), injected = fakeProvider({ accounts: [B] });
  const window = fakeWindow({ injected, announced: [{ info: { uuid: 'mm', name: 'MetaMask', icon: 'data:image/svg+xml;base64,AA==', rdns: 'io.metamask' }, provider: metamask }] });
  const wallet = createEvmWallet({ window });
  assert.deepEqual(wallet.list().map(p => p.name), ['MetaMask', 'Browser wallet']);
  await assert.rejects(wallet.connect(), /Choose a wallet/);
  const state = await wallet.connect('mm');
  assert.equal(state.address, A); assert.equal(state.chainId, 1); assert.equal(state.wallet, 'MetaMask'); assert.equal(wallet.connected, true); assert.equal(wallet.onChain, false);
  assert.equal(window.localStorage.getItem('curve.evmWallet'), 'MetaMask', 'the choice is remembered');
  const single = createEvmWallet({ window: fakeWindow({ injected }) });
  assert.equal((await single.connect()).address, B, 'one wallet needs no picker');
});

test('a quiet resume reconnects the remembered wallet without a prompt; a rejection surfaces in the state', async () => {
  const provider = fakeProvider(), window = fakeWindow({ injected: provider });
  window.localStorage.setItem('curve.evmWallet', 'Browser wallet');
  const wallet = createEvmWallet({ window });
  const state = await wallet.resume();
  assert.equal(state.address, A); assert.ok(provider.calls.some(c => c.method === 'eth_accounts') && !provider.calls.some(c => c.method === 'eth_requestAccounts'));
  const refusing = createEvmWallet({ window: fakeWindow({ injected: fakeProvider({ rejectAccounts: true }) }) });
  await assert.rejects(refusing.connect(), /rejected/); assert.match(refusing.state().error, /rejected the request/); assert.equal(refusing.connected, false);
});

test('ensureChain switches, or adds Robinhood Chain when the wallet does not know it; sendTransaction goes through the wallet on that chain', async () => {
  const provider = fakeProvider({ known: false }), wallet = createEvmWallet({ window: fakeWindow({ injected: provider }) });
  await wallet.connect();
  const changes = []; wallet.onChange(s => changes.push(s.chainId));
  await wallet.ensureChain();
  assert.equal(wallet.state().chainId, 4663); assert.equal(wallet.onChain, true);
  const added = provider.calls.find(c => c.method === 'wallet_addEthereumChain');
  assert.deepEqual(added.params[0], { chainId: '0x1237', chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [...ROBINHOOD_CHAIN.rpcUrls], blockExplorerUrls: [...ROBINHOOD_CHAIN.blockExplorerUrls] });
  const hash = await wallet.sendTransaction({ to: B, value: 123n, data: '0x' });
  assert.equal(hash, '0x' + 'ab'.repeat(32));
  const sent = provider.calls.find(c => c.method === 'eth_sendTransaction').params[0];
  assert.deepEqual(sent, { from: A, to: B, value: '0x7b', data: '0x' });
  await assert.rejects(wallet.sendTransaction({ to: 'nope', value: '0x0' }), /Invalid destination/);
  assert.equal(await wallet.balance(), 10n ** 18n);
  // The wallet's own events move the state; an empty account list disconnects.
  provider.emit('chainChanged', '0x1'); assert.equal(wallet.state().chainId, 1);
  provider.emit('accountsChanged', [B]); assert.equal(wallet.state().address, B);
  provider.emit('accountsChanged', []); assert.equal(wallet.connected, false);
  wallet.disconnect(); assert.equal(wallet.state().wallet, '');
});

test('signMessage asks the wallet for a personal signature of the UTF-8 message, from the connected account only', async () => {
  const provider = fakeProvider(), window = fakeWindow({ injected: provider }), wallet = createEvmWallet({ window });
  await assert.rejects(wallet.signMessage('hi'), /Connect an EVM wallet first/);
  await wallet.connect();
  const signature = await wallet.signMessage('Launchpad link EVM wallet\nNonce: é');
  assert.equal(signature, '0x' + 'cd'.repeat(64) + '1b');
  const call = provider.calls.find(c => c.method === 'personal_sign');
  assert.equal(call.params[1], A, 'signed by the connected account');
  assert.equal(call.params[0], '0x' + Buffer.from('Launchpad link EVM wallet\nNonce: é', 'utf8').toString('hex'), 'the message travels as UTF-8 hex');
  await assert.rejects(wallet.signMessage(''), /Nothing to sign/);
  provider.request = async () => 'nope'; await assert.rejects(wallet.signMessage('x'), /did not return a signature/);
});
