import { createEvmWallet, isEvmAddress, shortEvmAddress, walletErrorText } from './evm-wallet.mjs';

// The account's EVM wallet (v71.40): the wallet a person uses on Robinhood Chain, linked to the account they already
// have. It is not a sign-in method and never moves funds by itself; the launch and coin pages prefer it. Linking
// proves control of the wallet (a personal signature in that wallet) and verifies the account (the password and
// second factor on a password account; the wallet session on a wallet-created account). Same shape as the sign-in
// wallet editor: {render, cancel, destroy}.
export function createEvmWalletLinkUI({ document, window, container, getAccount, api, authorize, onSaved = () => {}, isActive = () => true, walletFactory = createEvmWallet } = {}) {
  container.classList.add('evm-wallet-settings');
  container.innerHTML = `<h3>EVM wallet</h3><p data-evw-status class="help"></p><p data-evw-address class="account-address"></p><div class="account-actions"><button type="button" class="small-button" data-evw-edit>Connect EVM wallet</button><button type="button" class="text-button" data-evw-copy hidden>Copy address</button><button type="button" class="text-button" data-evw-unlink hidden>Disconnect EVM wallet</button></div><div data-evw-form hidden><p class="help">Choose the EVM wallet you use on Robinhood Chain (MetaMask, Rabby or another wallet extension), verify this account and approve a linking message in that wallet. It does not change how you sign in and does not move anything.</p><p data-evw-selected class="account-address"></p><button type="button" class="small-button" data-evw-connect>Choose wallet</button><div data-evw-wallets class="signin-wallets" hidden></div><p data-evw-warning class="help"></p><div class="account-actions"><button type="button" class="primary" data-evw-save>Verify &amp; link</button><button type="button" class="small-button" data-evw-cancel>Cancel</button></div></div><p data-evw-message class="help" role="status"></p>`;
  const $ = name => container.querySelector('[data-evw-' + name + ']');
  let generation = 0, busy = false, identity = '', editing = false, wallet = null, unsubscribe = null, operation = 0, walletWait = 0;
  const NO_WALLET = 'No EVM wallet was found in this browser. Install MetaMask, Rabby or another EVM wallet extension and reload this page.';
  const start = () => { busy = true; walletWait = 0; return ++operation; }, finish = token => { if (token === operation) { busy = false; walletWait = 0; controls(); } };
  async function fromWallet(token, task) { walletWait = token; try { return await task(); } finally { if (walletWait === token) walletWait = 0; } }
  const message = (text, error = false) => { $('message').textContent = text || ''; $('message').classList.toggle('account-error', error); $('message').setAttribute('role', error ? 'alert' : 'status'); };
  const failure = (error, fallback) => message(walletErrorText(error, fallback), !/rejected the request/.test(walletErrorText(error, fallback)));
  const current = (token, id) => generation === token && isActive() && getAccount()?.id === id;
  const linked = () => { const value = getAccount()?.evmWallet; return isEvmAddress(value) ? value : ''; };
  const passwordAccount = () => !!getAccount()?.id && getAccount()?.authType !== 'wallet';
  function controls() { for (const button of container.querySelectorAll('button')) button.disabled = busy; $('save').disabled = busy || !isEvmAddress(wallet?.state().address); }
  function selected() { const address = wallet?.state().address || ''; $('selected').textContent = address || 'No wallet connected.'; $('connect').textContent = address ? 'Change wallet' : 'Choose wallet'; controls(); }
  function ensureWallet() { if (!wallet) { wallet = walletFactory({ window }); unsubscribe = wallet.onChange?.(() => { if (editing) { selected(); if (!$('wallets').hidden) renderWallets(); } }); } return wallet; }
  function cancel() {
    generation++; const released = busy && walletWait === operation;
    if (released) { operation++; busy = false; walletWait = 0; }
    editing = false; $('form').hidden = true; $('wallets').hidden = true; $('wallets').replaceChildren(); $('selected').textContent = ''; message('');
    if (released) controls();
  }
  function render() {
    const account = getAccount(); if (identity !== account?.id) { cancel(); identity = account?.id || ''; }
    const address = linked();
    $('address').textContent = address || 'No EVM wallet linked.';
    $('address').title = address;
    $('status').textContent = address ? 'Your Robinhood Chain wallet. The launch and coin pages use it first; fees and rewards on your Robinhood coins go to the wallet you launch and trade from.' : 'Link the EVM wallet you use on Robinhood Chain so your launches, trades and rewards there belong to this account. Your sign-in stays as it is.';
    $('edit').hidden = editing; $('edit').textContent = address ? 'Change EVM wallet' : 'Connect EVM wallet';
    $('copy').hidden = editing || !address; $('unlink').hidden = editing || !address;
    $('warning').textContent = passwordAccount() ? 'You will be asked for your password' + (account?.mfaEnabled ? ' and your authenticator code' : '') + ', then your wallet asks you to sign a short message. Signing costs nothing.' : 'Your wallet asks you to sign a short message. Signing costs nothing.';
    if (!account?.id) { $('form').hidden = true; editing = false; }
    controls();
  }
  function renderWallets() {
    const rows = ensureWallet().list(); $('wallets').replaceChildren();
    for (const row of rows) { const button = document.createElement('button'); button.type = 'button'; button.className = 'small-button'; button.textContent = row.name; button.disabled = busy; button.onclick = () => connect(row.uuid); $('wallets').append(button); }
    if (!rows.length) message(NO_WALLET, true);
  }
  async function connect(uuid) {
    if (busy || !editing || !isActive()) return; const token = generation, accountId = getAccount()?.id, op = start(); controls(); message('Approve the connection in your wallet.');
    try { await fromWallet(op, () => ensureWallet().connect(uuid)); if (!current(token, accountId)) return; $('wallets').hidden = true; message(''); selected(); }
    catch (error) { if (current(token, accountId)) { if (error?.code === 'EVM_WALLET_CHOOSE' && error.wallets?.length) { $('wallets').hidden = false; renderWallets(); message('Choose the wallet to link.'); } else failure(error, 'Could not connect your wallet.'); } }
    finally { finish(op); }
  }
  async function save() {
    if (busy || !editing || !isActive()) return;
    const account = getAccount(), id = account?.id, token = generation, address = ensureWallet().state().address;
    if (!id) return;
    if (!isEvmAddress(address)) { message('Choose the wallet you want to link first.', true); return; }
    const op = start(); controls(); message('');
    try {
      let credentials = {};
      if (passwordAccount()) {
        if (!authorize) throw Error('Account verification is unavailable. Reopen your account and try again.');
        credentials = await authorize('Connect EVM wallet'); if (!current(token, id)) return;
      }
      if (wallet.state().address !== address) throw Error('Your wallet changed. Review the connected wallet and try again.');
      const challenge = await api('/api/account/evm-wallet/challenge', { address, ...credentials }); if (!current(token, id)) return;
      if (wallet.state().address !== address) throw Error('Your wallet changed. Review the connected wallet and try again.');
      message('Sign the linking message in your wallet.');
      const signature = await fromWallet(op, () => wallet.signMessage(challenge.message)); if (!current(token, id)) return;
      const now = wallet.state().address; if (now && now !== address) throw Error('Your wallet changed while signing. Try again.');
      const result = await api('/api/account/evm-wallet', { nonce: challenge.nonce, signature }); if (!current(token, id)) return;
      if (result.account?.id !== id) throw Error('Your account changed. Reopen your account before continuing.');
      onSaved(result.account); cancel(); render(); message('EVM wallet linked: ' + shortEvmAddress(result.account.evmWallet) + '. The launch and coin pages will use it first.');
    } catch (error) { if (current(token, id) && error.message !== 'Cancelled.') failure(error, 'Could not link your EVM wallet.'); }
    finally { finish(op); }
  }
  async function unlink() {
    if (busy || !isActive() || !linked()) return;
    const account = getAccount(), id = account.id, token = generation, op = start(); controls(); message('');
    try {
      let credentials = {};
      if (passwordAccount()) {
        if (!authorize) throw Error('Account verification is unavailable. Reopen your account and try again.');
        credentials = await authorize('Disconnect EVM wallet'); if (!current(token, id)) return;
      }
      const result = await api('/api/account/evm-wallet/unlink', credentials); if (!current(token, id)) return;
      if (result.account?.id !== id) throw Error('Your account changed. Reopen your account before continuing.');
      onSaved(result.account); cancel(); render(); message('EVM wallet disconnected. You can link one again at any time.');
    } catch (error) { if (current(token, id) && error.message !== 'Cancelled.') message(error.message || 'Could not disconnect your EVM wallet.', true); }
    finally { finish(op); }
  }
  $('edit').onclick = () => { if (busy || !isActive() || !getAccount()?.id) return; editing = true; ensureWallet(); $('form').hidden = false; message(''); render(); selected(); };
  $('connect').onclick = () => { if (busy || !editing || !isActive()) return; const rows = ensureWallet().list(); if (rows.length === 1) return connect(rows[0].uuid); if (!rows.length) { message(NO_WALLET, true); return; } $('wallets').hidden = false; renderWallets(); };
  $('save').onclick = save; $('unlink').onclick = unlink; $('cancel').onclick = () => { cancel(); render(); };
  $('copy').onclick = async () => { try { await window.navigator.clipboard.writeText(linked()); if (isActive()) message('EVM wallet address copied.'); } catch { message('Select the address to copy it.', true); } };
  return { render, cancel, destroy() { cancel(); unsubscribe?.(); container.replaceChildren(); } };
}
