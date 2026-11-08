// A browser EVM wallet connection for Robinhood Chain (v71.39): EIP-6963 wallet discovery with the legacy
// window.ethereum fallback, EIP-1193 requests, chain switching (adding Robinhood Chain to the wallet when it is
// missing), one transaction at a time, and account / chain change events. The page never sees a key: every
// signature is the wallet's own prompt. Browser-safe: no Node imports.
export const ROBINHOOD_CHAIN = Object.freeze({
  chainId: 4663, hexId: '0x1237', chainName: 'Robinhood Chain', nativeCurrency: Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 }),
  rpcUrls: Object.freeze(['https://rpc.mainnet.chain.robinhood.com']), blockExplorerUrls: Object.freeze(['https://robinhoodchain.blockscout.com']),
});
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const lower = v => String(v || '').toLowerCase();
export const isEvmAddress = value => typeof value === 'string' && ADDRESS.test(value);
export const shortEvmAddress = value => isEvmAddress(value) ? value.slice(0, 6) + '…' + value.slice(-4) : '';
export const hexChainId = value => typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value) ? Number.parseInt(value, 16) : Number.isSafeInteger(Number(value)) ? Number(value) : null;

/** What a wallet error means to a person; provider messages can carry URLs, so only the code and short text travel. */
export function walletErrorText(error, fallback = 'The wallet did not complete the request.') {
  const code = error?.code ?? error?.data?.code, message = String(error?.message || '').replace(/(?:https?|wss?):\/\/\S+/g, '').trim();
  if (code === 4001 || /user rejected|user denied|rejected the request|cancelled|canceled/i.test(message)) return 'You rejected the request in your wallet.';
  if (code === 4902) return 'Robinhood Chain is not in your wallet yet. Approve adding it and try again.';
  if (code === -32002) return 'Your wallet is already asking for permission. Open it and finish that request.';
  if (code === -32603 && /insufficient funds/i.test(message) || /insufficient funds/i.test(message)) return 'Your wallet does not hold enough ETH for this transfer and its gas.';
  if (code === 4100 || /unauthorized/i.test(message)) return 'The wallet has not authorised this site. Connect it again.';
  return message ? message.slice(0, 200) : fallback;
}

/**
 * @param {object} options
 * @param {Window} options.window   the page's window (its `ethereum`, EIP-6963 events and `localStorage`)
 * @param {object} [options.chain]  the chain to work on (Robinhood Chain)
 * @param {string} [options.storageKey] where the last-used wallet's name is remembered (reconnects quietly on load)
 */
export function createEvmWallet({ window, chain = ROBINHOOD_CHAIN, storageKey = 'curve.evmWallet', clock = Date.now } = {}) {
  const providers = new Map(); // uuid → { uuid, name, icon, rdns, provider }
  const listeners = new Set();
  let active = null, state = { address: '', chainId: null, wallet: '', connecting: false, error: '' }, busy = null, unbindActive = () => {};
  function emit() { for (const fn of listeners) { try { fn(state); } catch { /* a listener's error is its own */ } } }
  function setState(patch) { state = Object.freeze({ ...state, ...patch }); emit(); }
  function remember(name) { try { if (name) window.localStorage?.setItem(storageKey, name); else window.localStorage?.removeItem(storageKey); } catch { /* storage is a convenience */ } }
  function remembered() { try { return window.localStorage?.getItem(storageKey) || ''; } catch { return ''; } }
  // EIP-6963: wallets announce themselves on request; the legacy injected provider is listed when nothing announced it.
  function onAnnounce(event) {
    const detail = event?.detail, info = detail?.info, provider = detail?.provider;
    if (!info || !provider || typeof provider.request !== 'function') return;
    const uuid = String(info.uuid || info.rdns || info.name);
    if (!providers.has(uuid)) providers.set(uuid, { uuid, name: String(info.name || 'Wallet').slice(0, 40), icon: typeof info.icon === 'string' && /^data:image\//.test(info.icon) ? info.icon : '', rdns: String(info.rdns || ''), provider });
  }
  try { window.addEventListener('eip6963:announceProvider', onAnnounce); window.dispatchEvent(new window.Event('eip6963:requestProvider')); } catch { /* no DOM events: tests pass providers in */ }
  function list() {
    const out = [...providers.values()];
    const injected = window.ethereum;
    if (injected && typeof injected.request === 'function' && !out.some(p => p.provider === injected || Array.isArray(injected.providers) && injected.providers.includes(p.provider))) {
      out.push({ uuid: 'injected', name: injected.isRabby ? 'Rabby' : injected.isCoinbaseWallet ? 'Coinbase Wallet' : injected.isMetaMask ? 'MetaMask' : 'Browser wallet', icon: '', rdns: '', provider: injected });
    }
    return out;
  }
  function bind(entry) {
    unbindActive();
    const provider = entry.provider, onAccounts = accounts => { const address = Array.isArray(accounts) && isEvmAddress(accounts[0]) ? accounts[0] : ''; if (!address) { disconnect(); return; } setState({ address }); };
    const onChain = id => setState({ chainId: hexChainId(id) }), onDisconnect = () => disconnect();
    if (typeof provider.on === 'function') { provider.on('accountsChanged', onAccounts); provider.on('chainChanged', onChain); provider.on('disconnect', onDisconnect); }
    unbindActive = () => { if (typeof provider.removeListener === 'function') { provider.removeListener('accountsChanged', onAccounts); provider.removeListener('chainChanged', onChain); provider.removeListener('disconnect', onDisconnect); } unbindActive = () => {}; };
  }
  async function request(method, params = []) {
    if (!active) throw Object.assign(Error('Connect an EVM wallet first.'), { code: 'EVM_WALLET_NONE' });
    return active.provider.request({ method, params });
  }
  /** Connects the named wallet (or the only one, or the remembered one) and reads its account and chain. */
  async function connect(uuid = '', { silent = false } = {}) {
    if (busy) return busy;
    busy = (async () => {
      const available = list();
      const entry = available.find(p => p.uuid === uuid) || (uuid ? null : available.find(p => p.name === remembered()) || (available.length === 1 ? available[0] : null));
      if (!entry) throw Object.assign(Error(available.length ? 'Choose a wallet.' : 'No EVM wallet was found in this browser. Install MetaMask, Rabby or another EVM wallet and reload.'), { code: 'EVM_WALLET_CHOOSE', wallets: available.map(p => ({ uuid: p.uuid, name: p.name, icon: p.icon })) });
      setState({ connecting: true, error: '' });
      try {
        const accounts = await entry.provider.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts', params: [] });
        const address = Array.isArray(accounts) && isEvmAddress(accounts[0]) ? accounts[0] : '';
        if (!address) { if (silent) { setState({ connecting: false }); return state; } throw Error('The wallet did not share an account.'); }
        active = entry; bind(entry); remember(entry.name);
        let chainId = null; try { chainId = hexChainId(await entry.provider.request({ method: 'eth_chainId', params: [] })); } catch { chainId = null; }
        setState({ address, chainId, wallet: entry.name, connecting: false, error: '' });
        return state;
      } catch (error) { setState({ connecting: false, error: walletErrorText(error) }); throw error; }
    })().finally(() => { busy = null; });
    return busy;
  }
  function disconnect() { unbindActive(); active = null; remember(''); setState({ address: '', chainId: null, wallet: '', connecting: false, error: '' }); }
  /** Switches the wallet to the chain, adding it when the wallet does not know it (EIP-3085 / EIP-3326). */
  async function ensureChain() {
    if (state.chainId === chain.chainId) return true;
    try { await request('wallet_switchEthereumChain', [{ chainId: chain.hexId }]); }
    catch (error) {
      const code = error?.code ?? error?.data?.originalError?.code;
      if (code !== 4902 && !/unrecognized chain|not added|does not exist|Unrecognized chain ID/i.test(String(error?.message || ''))) throw error;
      await request('wallet_addEthereumChain', [{ chainId: chain.hexId, chainName: chain.chainName, nativeCurrency: { ...chain.nativeCurrency }, rpcUrls: [...chain.rpcUrls], blockExplorerUrls: [...chain.blockExplorerUrls] }]);
    }
    let id = null; try { id = hexChainId(await request('eth_chainId')); } catch { id = null; }
    setState({ chainId: id });
    if (id !== chain.chainId) throw Object.assign(Error('Switch your wallet to Robinhood Chain and try again.'), { code: 'EVM_WALLET_CHAIN' });
    return true;
  }
  /** Sends one transaction from the connected account (hex `value`, optional `data`); the wallet estimates gas. Returns the hash. */
  async function sendTransaction({ to, value = '0x0', data = '0x' }) {
    if (!isEvmAddress(to)) throw Error('Invalid destination address.');
    if (!state.address) throw Object.assign(Error('Connect an EVM wallet first.'), { code: 'EVM_WALLET_NONE' });
    await ensureChain();
    const hash = await request('eth_sendTransaction', [{ from: state.address, to, value: typeof value === 'bigint' ? '0x' + value.toString(16) : value, data }]);
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw Error('The wallet did not return a transaction hash.');
    return hash;
  }
  /** Signs a text message with the connected account (EIP-191 personal_sign; the wallet shows the text). Returns the 65-byte hex signature. */
  async function signMessage(message) {
    if (!state.address) throw Object.assign(Error('Connect an EVM wallet first.'), { code: 'EVM_WALLET_NONE' });
    const text = String(message ?? ''); if (!text) throw Error('Nothing to sign.');
    const hex = '0x' + [...new TextEncoder().encode(text)].map(b => b.toString(16).padStart(2, '0')).join('');
    const signature = await request('personal_sign', [hex, state.address]);
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw Error('The wallet did not return a signature.');
    return signature;
  }
  /** Reads a balance through the wallet's own provider (no RPC of ours): wei as a bigint, or null. */
  async function balance(address = state.address) {
    try { const hex = await request('eth_getBalance', [address, 'latest']); return typeof hex === 'string' ? BigInt(hex) : null; } catch { return null; }
  }
  /**
   * Waits for a sent transaction to be mined, polling the wallet's provider for its receipt. Resolves with the receipt;
   * throws when the chain reverted it (`EVM_TX_FAILED`), when the wallet disconnects, or after `timeoutMs` (`EVM_TX_TIMEOUT`).
   */
  async function waitForReceipt(hash, { timeoutMs = 180000, intervalMs = 1500, sleep = ms => new Promise(resolve => window.setTimeout(resolve, ms)) } = {}) {
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw Error('Invalid transaction hash.');
    const started = clock();
    for (;;) {
      if (!state.address) throw Object.assign(Error('The wallet disconnected while the transaction was pending.'), { code: 'EVM_WALLET_NONE', hash });
      let receipt = null;
      try { receipt = await request('eth_getTransactionReceipt', [hash]); } catch { receipt = null; }
      if (receipt && typeof receipt === 'object' && receipt.blockNumber) {
        const status = typeof receipt.status === 'string' ? receipt.status.toLowerCase() : receipt.status;
        if (status === '0x0' || status === 0 || status === '0x00') throw Object.assign(Error('The transaction failed on the chain.'), { code: 'EVM_TX_FAILED', hash, receipt });
        return receipt;
      }
      if (clock() - started >= timeoutMs) throw Object.assign(Error('The transaction was not confirmed in time. Check it in your wallet and try again.'), { code: 'EVM_TX_TIMEOUT', hash });
      await sleep(intervalMs);
    }
  }
  return Object.freeze({
    chain, list, connect, disconnect, ensureChain, sendTransaction, signMessage, balance, waitForReceipt, request,
    state: () => state, onChange(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
    get connected() { return !!state.address; }, get onChain() { return !!state.address && state.chainId === chain.chainId; },
    /** Quiet reconnect on page load for the remembered wallet (no prompt). */
    resume() { return remembered() ? connect('', { silent: true }).catch(() => state) : Promise.resolve(state); },
    at: () => clock(),
  });
}
