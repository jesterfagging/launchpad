(() => {
  const ME = '0x1111111111111111111111111111111111111111';
  const hex = v => '0x' + BigInt(v).toString(16).padStart(64, '0');
  const provider = { async request({ method, params }) {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ME];
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'eth_getBalance') return hex(2n * 10n ** 18n + 123n);
    if (method === 'eth_call') { const sel = params[0].data.slice(0, 10); if (sel === '0x70a08231') return hex(123456789012345678901234567n); if (sel === '0xdd62ed3e') return hex(0); return hex(0); }
    if (method === 'eth_sendTransaction') return '0x' + '1'.repeat(64);
    if (method === 'eth_getTransactionReceipt') return { blockNumber: '0x10', status: '0x1' };
    return null; }, on() {}, removeListener() {} };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'fake', name: 'MetaMask', icon: 'data:image/svg+xml,', rdns: 'io.metamask' }, provider } }));
  window.addEventListener('eip6963:requestProvider', announce); announce();
})();
