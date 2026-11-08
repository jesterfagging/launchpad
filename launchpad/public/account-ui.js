import { renderHeaderAccount } from './workspace-shell.js';
import { createAccountSecurity } from './account-security-ui.js';
import { createAccountConnections } from './account-connections-ui.js';
import { createCashbackWalletUI } from './cashback-wallet-ui.mjs';
import { createSignInWalletUI } from './signin-wallet-ui.mjs';
import { createEvmWalletLinkUI } from './evm-wallet-link-ui.mjs';
import { createSignInOverlay } from './signin-overlay.mjs';
const $ = id => document.getElementById(id);
const percent = ppm => `${(Number(ppm) / 10000).toLocaleString(undefined, { maximumFractionDigits: 4 })}%`;

export function createAccountUI({ api, settings, applySettings, sealSettings = () => {}, addGeneratedWallets = () => {}, alertError, getStatus = () => null, getKind = () => 'copy' }) {
  let session = null, account = null, fees = null, authMode = 'login', action = false, consentVersion = '', settingsRevision = null, saveQueue = Promise.resolve(), generating = false, cashback = [], linkRequestVersion = 0, keyTimer, features = {}, cashbackWallet = null, connections = null;
  const toolkit = () => features.toolkit === true, telegram = () => features.telegram === true, walletOnlyMode = () => features.walletOnly !== false;
  let recovering = false, signInOverlay = null;
  const preparedManual = new Map();
  const gate = document.createElement('section'); gate.id = 'account-gate'; gate.className = 'account-gate'; gate.hidden = true;
  gate.innerHTML = '<div class="card auth-card"><p class="eyebrow">Welcome to Launchpad</p><h1 id="auth-heading">Connect your wallet.</h1><p class="help" id="auth-description">Your profile, launches and trading wallet in one account.</p><button type="button" id="auth-connect" class="primary">Connect wallet</button><button type="button" id="auth-recovery" class="text-button">Recover an existing account</button><form id="auth-form" hidden><label>Username<input id="auth-username" name="username" autocomplete="username" minlength="3" maxlength="32" required spellcheck="false" autocapitalize="none"></label><label>Password<input id="auth-password" name="password" type="password" autocomplete="current-password" minlength="10" maxlength="128" required></label><p id="auth-error" role="alert" class="account-error" hidden></p><button type="submit" id="auth-submit" class="primary">Sign in ↗</button></form><button type="button" id="auth-switch" class="text-button" hidden>New here? Create an account</button></div>';
  $('session-loading').after(gate);
  const dialog = document.createElement('dialog'); dialog.id = 'account-dialog'; dialog.className = 'account-dialog';
  dialog.innerHTML = '<div class="card-heading"><h2>Account</h2><button type="button" class="small-button" id="account-close" aria-label="Close account">Close</button></div><p id="account-username" class="account-username"></p><p id="account-message" class="help" role="status"></p><section class="account-section"><h3>Public profile</h3><p class="help">Change your username, profile picture and bio.</p><a class="small-button" href="/profile">Edit profile</a></section><section class="account-section"><div id="account-signin-wallet"></div></section><section class="account-section"><div id="account-evm-wallet"></div></section><section class="account-section" id="account-trading-wallet"><h3 id="account-wallet-title">Trading wallet</h3><p class="help" id="account-wallet-note">Your connected wallet approves launches and trades.</p><p id="account-main-wallet" class="account-address"></p><button type="button" class="small-button" id="account-copy-address">Copy address</button><details id="account-export-details"><summary>Export main wallet key</summary><form id="account-export-form"><label>Account password<input id="account-export-password" type="password" autocomplete="current-password" required></label><button type="submit" class="small-button" id="account-export-submit">Unlock key</button></form><div id="account-export-result" hidden><label>Main wallet private key<input id="account-private-key" type="password" readonly autocomplete="off" spellcheck="false"></label><div class="account-actions"><button type="button" class="text-button" id="account-reveal-key">Show key</button><button type="button" class="text-button" id="account-copy-key">Copy key</button><button type="button" class="text-button" id="account-hide-key">Clear key</button></div></div></details></section><section class="account-section" id="account-cashback-section" hidden><div id="account-cashback-wallet"></div><p class="help" id="account-cashback"></p><div id="account-cashback-summary" class="cashback-summary"></div></section><section class="account-section" id="account-telegram-section" hidden><h3>Telegram</h3><p class="help">Link the same Launchpad account in the Telegram bot.</p><p class="help" id="account-telegram-linked" hidden></p><button type="button" class="small-button" id="account-link-telegram">Create linking code</button><button type="button" class="small-button" id="account-unlink-telegram" hidden>Disconnect Telegram</button><p id="account-link-code" class="account-address" hidden></p><p id="account-link-expiry" class="help" hidden></p></section><section id="account-admin" class="account-section" hidden><h3>Admin panel</h3><p class="help">Manage launches, rewards, fees and user accounts.</p><a class="small-button" href="/admin">Open admin panel ↗</a></section><div class="account-actions account-footer"><button type="button" class="small-button" id="account-save-dialog">Save settings to account</button><button type="button" class="small-button" id="account-logout">Sign out</button></div><p class="help" id="account-toolkit-signout-note" hidden>Signing out leaves active runs running. Use Stop in the trading screen to stop a run.</p>';
  document.body.append(dialog);
  const security = createAccountSecurity({ api, dialog, getAccount: () => account, getFeatures: () => features, refresh: refreshAccount, message });
  const mountCashback = () => createCashbackWalletUI({ document, window: document.defaultView, container: $('account-cashback-wallet'), getAccount: () => account, api, authorize: title => security.authorize(title), isActive: () => dialog.open, onSaved: next => { account = next; if (session) session = { ...session, account }; renderAccount(); } });
  const signInWallet = createSignInWalletUI({ document, window: document.defaultView, container: $('account-signin-wallet'), getAccount: () => account, getFeatures: () => features, api, authorize: title => security.authorize(title), isActive: () => dialog.open, onSaved: next => { account = next; if (session) session = { ...session, account }; renderAccount(); } });
  const evmWallet = createEvmWalletLinkUI({ document, window: document.defaultView, container: $('account-evm-wallet'), getAccount: () => account, api, authorize: title => security.authorize(title), isActive: () => dialog.open, onSaved: next => { account = next; if (session) session = { ...session, account }; renderAccount(); } });
  const mountConnections = () => createAccountConnections({ dialog, api, getAccount:()=>account, chain: 'solana', onSaved: value => {
    if (value.chain !== 'solana') return true;
    for (const [key, val] of Object.entries(value.values)) { const input = $(key); if (!input) continue; if (input.type === 'checkbox') input.checked = !!val; else input.value = val; input.dispatchEvent(new Event('input', { bubbles: true })); }
    if (settingsRevision !== value.previousRevision) return false;
    settingsRevision = value.revision; return true;
  } });
  const otpLabel = document.createElement('label'); otpLabel.id = 'auth-code-label'; otpLabel.textContent = 'Authenticator or recovery code (if enabled)';
  const otpInput = document.createElement('input'); otpInput.id = 'auth-code'; otpInput.autocomplete = 'one-time-code'; otpInput.maxLength = 40; otpLabel.append(otpInput); $('auth-password').closest('label').after(otpLabel);
  const exportOtp = document.createElement('label'); exportOtp.id = 'export-code-label'; exportOtp.textContent = 'Authenticator or recovery code';
  const exportInput = document.createElement('input'); exportInput.id = 'export-code'; exportInput.autocomplete = 'one-time-code'; exportInput.maxLength = 40; exportOtp.append(exportInput); $('account-export-password').closest('label').after(exportOtp);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearKey(); });
  function message(text, error = false) { $('account-message').textContent = text; $('account-message').classList.toggle('account-error', error); $('account-message').setAttribute('role', error ? 'alert' : 'status'); if (error && dialog.open) $('account-message').scrollIntoView({ block: 'nearest' }); }
  function clearKey() { clearTimeout(keyTimer); $('export-code').value = ''; $('account-private-key').value = ''; $('account-private-key').type = 'password'; $('account-reveal-key').textContent = 'Show key'; $('account-export-password').value = ''; $('account-export-result').hidden = true; }
  function clearSecrets() { cashbackWallet?.cancel(); signInWallet.cancel(); evmWallet.cancel(); ++linkRequestVersion; clearKey(); $('account-link-code').textContent = ''; $('account-link-code').hidden = true; $('account-link-expiry').textContent = ''; $('account-link-expiry').hidden = true; }
  function renderFees() {
    if (!toolkit()) { $('platform-fees').hidden = true; return; }
    $('platform-fees').hidden = !session?.accounts || !account;
    if (!fees) return;
    if (consentVersion !== fees.version) consentVersion = '';
    renderFeeNote();
    $('platform-fee-rates').replaceChildren();
    const lp = fees.liquidityDescription || (Number.isFinite(fees.liquidityPpm) ? `${percent(fees.liquidityPpm)} per automatic adjustment` : '0.005% / 0.015% / 0.025% of managed position value per automatic adjustment, by pool fee tier');
    for (const [label, value] of [['Launch sniping', `${percent(fees.sniperPpm ?? 10000)} per successful buy or sell`], ['Copy trading', `${percent(fees.copyPpm ?? 2500)} per successful buy or sell`], ['Market making', `${percent(fees.marketPpm ?? 1000)} per successful swap`], ['Liquidity management', lp]]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; $('platform-fee-rates').append(dt, dd);
    }
    $('platform-fee-description').textContent = typeof fees.description === 'string' ? fees.description : 'Swap fees are deducted from the entered input amount and collected with the trade. LP fees apply once per automatic adjustment, with no Launchpad fee for initial deposits or manual withdrawals. Network fees, tips, pool fees, and account rent are separate.';
    $('platform-fee-readiness').textContent = fees.ready ? '' : 'Live trading is unavailable until the administrator configures platform fees.';
    const cashback = Number(account.cashbackBps || 0) / 100;
    $('platform-cashback').textContent = cashback ? `Your cashback: ${cashback}% of the Launchpad platform fee. Verified rewards are tracked for your cashback wallet and remain unpaid until a payout is completed.` : '';
    $('account-cashback').textContent = cashback ? `Cashback: ${cashback}% of Launchpad platform fees, tracked in the fee asset. Pending rewards are verified but unpaid; they have not been sent to your cashback wallet.` : 'Cashback is not enabled for this account.';
  }
  function renderCashback() {
    const box = $('account-cashback-summary'); box.replaceChildren();
    if (!cashback.length) { const line = document.createElement('p'); line.className = 'help'; line.textContent = 'No cashback accrued yet.'; box.append(line); return; }
    const amount = (raw, decimals) => {
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return `${raw} raw units`;
      try { const padded = BigInt(raw || '0').toString().padStart(decimals + 1, '0'); if (!decimals) return padded; const fraction = padded.slice(-decimals).replace(/0+$/, ''); return padded.slice(0, -decimals) + (fraction ? `.${fraction}` : ''); } catch { return 'Unavailable'; }
    };
    for (const row of cashback) {
      const native = row.mint === 'So11111111111111111111111111111111111111112', decimals = native ? 9 : row.decimals;
      const item = document.createElement('div'), title = document.createElement('strong'), line = document.createElement('p');
      item.className = 'cashback-row'; title.textContent = native ? 'SOL' : row.mint; line.textContent = `Pending (verified, unpaid): ${amount(row.pendingAmount, decimals)} · Paid: ${amount(row.paidAmount, decimals)}`;
      item.append(title, line);
      if (/^[0-9]+$/.test(String(row.unverifiedAmount || '0')) && BigInt(row.unverifiedAmount || '0') > 0n) {
        const unverified = document.createElement('p'); unverified.textContent = `Awaiting verification: ${amount(row.unverifiedAmount, decimals)}`; item.append(unverified);
      }
      box.append(item);
    }
  }
  function profileNavigation() {
    const tabs = dialog.querySelector('.account-tabs'); if (!tabs) return;
    let link = tabs.querySelector('[data-my-profile]');
    if (!link) { link = document.createElement('a'); link.dataset.myProfile = 'true'; link.textContent = 'My Profile'; const launched = tabs.querySelector('a[href="/launched-tokens"]'); if (launched) launched.before(link); else tabs.append(link); }
    const username = account?.username, valid = !!account && typeof username === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]{2,31}$/.test(username);
    link.hidden = !valid; if (valid) link.href = '/user/' + username.toLowerCase(); else link.removeAttribute('href');
  }
  function renderAccount() {
    $('account-cashback-section').hidden = !toolkit(); $('account-telegram-section').hidden = !telegram(); $('account-save-dialog').hidden = !toolkit(); $('account-toolkit-signout-note').hidden = !toolkit();
    if (toolkit()) { cashbackWallet ||= mountCashback(); if (!connections) { dialog.querySelector('[data-launchpad-account-tabs]')?.remove(); connections = mountConnections(); } }
    else { const panel = dialog.querySelector('#account-connections'), overview = dialog.querySelector('.account-overview'); if (panel) panel.hidden = true; if (overview) overview.hidden = false; cashbackWallet?.cancel(); cashbackWallet = null; $('account-cashback-wallet').replaceChildren(); $('account-cashback-summary').replaceChildren(); $('account-cashback').textContent = ''; }
    if (!dialog.querySelector('.account-tabs')) { const tabs = document.createElement('nav'); tabs.className = 'account-tabs'; tabs.dataset.launchpadAccountTabs = 'true'; tabs.setAttribute('aria-label', 'Account pages'); tabs.innerHTML = '<span aria-current="page">Overview</span><a href="/launched-tokens">Launched tokens</a>'; dialog.querySelector('.card-heading').after(tabs); }
    profileNavigation();
    $('account-trading-wallet').hidden = !toolkit() && account.authType === 'wallet';
    $('account-username').textContent = account.username;
    $('account-main-wallet').textContent = account.mainWallet;
    const legacy = walletOnlyMode() && account.authType !== 'wallet';
    $('account-wallet-title').textContent = legacy ? 'Legacy trading wallet' : 'Trading wallet';
    $('account-wallet-note').textContent = legacy ? 'Your original account wallet remains available for recovery. Link an external wallet above to sign in and approve trades.' : 'Your connected wallet approves launches and trades.';
    $('account-export-details').hidden = account.authType === 'wallet';
    renderHeaderAccount($('account-button'), account);
    $('account-admin').hidden = account.role !== 'admin';
    $('export-code-label').hidden = !account.mfaEnabled; $('export-code').required = !!account.mfaEnabled; security.render();
    const linked = !!account.telegramId;
    $('account-telegram-linked').hidden = !linked; $('account-telegram-linked').textContent = linked ? `Linked Telegram account: ${account.telegramId}` : '';
    $('account-unlink-telegram').hidden = !linked; $('account-link-telegram').hidden = linked;
    renderFees(); if (toolkit()) { renderCashback(); cashbackWallet?.render(); } signInWallet.render(); evmWallet.render();
  }
  async function refreshAccount() {
    const value = await api('/api/account'); account = value.account; if (value.features) features = value.features; fees = value.fees || fees; cashback = value.cashback || []; renderAccount();
  }
  async function copy(value) {
    if (!value) return;
    try { await navigator.clipboard.writeText(value); message('Copied.'); }
    catch { message('Copy is unavailable in this browser. Select the address or key and copy it manually.', true); }
  }
  function save() {
    if (!toolkit()) return Promise.reject(Error('Toolkit settings are unavailable on the launchpad.'));
    if (generating) return Promise.reject(Error('Wait for wallet generation to finish saving.'));
    const value = { ...settings(), ...agreement() };
    const pending = saveQueue.catch(() => {}).then(async () => {
      const result = await api('/api/account/settings', { settings: value, revision: settingsRevision });
      settingsRevision = result.revision; sealSettings(value, result.settings);
    });
    saveQueue = pending; return pending;
  }
  function agreement() { return fees?.version && consentVersion === fees.version ? { agreedFeeVersion: fees.version } : {}; }
  function renderFeeNote() {
    const kind = getKind(), enabled = toolkit() && !!session?.accounts && !!account && !!fees;
    const label = kind === 'liquidity' ? '0.005% / 0.015% / 0.025% per automatic LP adjustment (pool tier)' : kind === 'market' ? `${percent(fees?.marketPpm ?? 1000)} per swap` : `${percent(kind === 'sniper' ? fees?.sniperPpm ?? 10000 : fees?.copyPpm ?? 2500)} per buy or sell`;
    $('platform-fee-start-note').hidden = !enabled;
    $('platform-fee-start-note').textContent = `Launchpad fee: ${label}. Starting accepts these fees. Network and pool costs are separate.`;
    const active = getStatus(), terms = active?.state === 'running' ? active.platformFees || fees : fees;
    $('manual-fee-note').hidden = !enabled;
    $('manual-fee-note').textContent = `Launchpad fee: ${percent(kind === 'sniper' ? terms?.sniperPpm ?? 10000 : terms?.copyPpm ?? 2500)} per buy or sell. Submitting accepts this fee. Collected in SOL; network and pool costs are separate.`;
  }
  function acceptDisplayedFees() {
    if (!fees?.ready) throw Error('Live trading is unavailable until the administrator configures platform fees.');
    // Start/Submit accepts exactly the displayed version. The server rejects a
    // stale version rather than silently changing the terms of this click.
    consentVersion = fees.version;
  }
  async function actionMessage(fn) { try { message(''); await fn(); } catch (e) { message(e.message, true); } }
  function renderAuthGate() {
    const only = walletOnlyMode();
    $('auth-connect').hidden = !only; $('auth-recovery').hidden = !only; $('auth-form').hidden = only && !recovering; $('auth-switch').hidden = only;
    if (only) { authMode = 'login'; $('auth-heading').textContent = 'Connect your wallet.'; $('auth-description').textContent = 'Your account is created automatically. Adding a public profile is optional.'; $('auth-submit').textContent = 'Recover account'; $('auth-password').autocomplete = 'current-password'; $('auth-recovery').textContent = recovering ? 'Back to wallet connection' : 'Recover an existing account'; }
    else { $('auth-heading').textContent = 'Sign in.'; $('auth-submit').textContent = 'Sign in ↗'; }
  }
  $('auth-connect').onclick = () => { signInOverlay ||= createSignInOverlay({document,window:document.defaultView,getFeatures:()=>features,onSession:()=>location.assign('/')}); signInOverlay.open($('auth-connect')); };
  $('auth-recovery').onclick = () => { if (action || !walletOnlyMode()) return; recovering = !recovering; $('auth-password').value = ''; $('auth-code').value = ''; renderAuthGate(); };
  renderAuthGate();
  $('auth-switch').onclick = () => {
    if (walletOnlyMode()) return;
    authMode = authMode === 'login' ? 'register' : 'login';
    $('auth-heading').textContent = authMode === 'login' ? 'Sign in.' : 'Create your account.';
    $('auth-description').textContent = authMode === 'login' ? 'Your profile, launches and trading wallet in one account.' : 'An account wallet is created for launches and trading. Its key is encrypted on the Launchpad server.';
    $('auth-submit').textContent = authMode === 'login' ? 'Sign in ↗' : 'Create account ↗';
    $('auth-switch').textContent = authMode === 'login' ? 'New here? Create an account' : 'Already registered? Sign in';
    $('auth-password').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
    if (authMode === 'register') { $('auth-username').pattern = '[A-Za-z0-9_]{3,32}'; $('auth-username').title = '3–32 letters, numbers, or underscores'; } else { $('auth-username').removeAttribute('pattern'); $('auth-username').removeAttribute('title'); }
    $('auth-password').value = ''; $('auth-code').value = ''; $('auth-code-label').hidden = authMode !== 'login'; $('auth-error').hidden = true;
  };
  $('auth-form').onsubmit = async event => {
    event.preventDefault(); if (action || walletOnlyMode() && !recovering) return; action = true; $('auth-submit').disabled = true; $('auth-switch').disabled = true; $('auth-error').hidden = true;
    try { await api(`/api/account/${walletOnlyMode() ? 'login' : authMode}`, { username: $('auth-username').value.trim(), password: $('auth-password').value, code: $('auth-code').value.trim() }); $('auth-password').value = ''; location.assign('/'); }
    catch (e) { $('auth-error').textContent = e.message; $('auth-error').hidden = false; }
    finally { action = false; $('auth-submit').disabled = false; $('auth-switch').disabled = false; }
  };
  $('account-button').onclick = () => {
    clearSecrets(); message(''); renderAccount(); dialog.showModal();
    actionMessage(refreshAccount);
  };
  $('account-close').onclick = () => { clearSecrets(); dialog.close(); };
  dialog.addEventListener('close', clearSecrets);
  dialog.addEventListener('cancel', clearSecrets);
  $('account-export-details').addEventListener('toggle', () => { if (!$('account-export-details').open) clearKey(); });
  $('account-copy-address').onclick = () => copy(account.mainWallet);
  $('account-reveal-key').onclick = () => { const show = $('account-private-key').type === 'password'; $('account-private-key').type = show ? 'text' : 'password'; $('account-reveal-key').textContent = show ? 'Hide key' : 'Show key'; };
  $('account-copy-key').onclick = () => copy($('account-private-key').value);
  $('account-hide-key').onclick = clearKey;
  $('account-export-form').onsubmit = async event => {
    event.preventDefault(); if (account?.authType === 'wallet') return; const password = $('account-export-password').value, code = $('export-code').value.trim(); $('account-export-password').value = ''; $('account-export-submit').disabled = true;
    await actionMessage(async () => { clearKey(); const value = await api('/api/account/export', { password, code }); if (dialog.open && $('account-export-details').open) { $('account-private-key').value = value.privateKey; $('account-export-result').hidden = false; keyTimer = setTimeout(clearKey, 60000); message('Main wallet key unlocked for one minute.'); } });
    $('account-export-submit').disabled = false;
  };
  $('account-link-telegram').onclick = async () => {
    if (!telegram()) return;
    $('account-link-telegram').disabled = true; const generation = ++linkRequestVersion;
    await actionMessage(async () => { const value = await api('/api/account/telegram-link', await security.authorize('Link Telegram to this account')); if (!dialog.open || generation !== linkRequestVersion) return; $('account-link-code').textContent = `/link ${value.code}`; $('account-link-code').hidden = false; $('account-link-expiry').textContent = `Send this privately to the Launchpad bot. Expires ${new Date(value.expiresAt).toLocaleTimeString()}.`; $('account-link-expiry').hidden = false; });
    $('account-link-telegram').disabled = false;
  };
  $('account-unlink-telegram').onclick = async () => {
    if (!telegram()) return;
    $('account-unlink-telegram').disabled = true; $('account-link-telegram').disabled = true; clearSecrets();
    await actionMessage(async () => {
      await api('/api/account/telegram-unlink', await security.authorize('Disconnect Telegram')); account = { ...account, telegramId: null }; renderAccount();
      await refreshAccount(); clearSecrets(); message('Telegram disconnected. Active runs continue, and you can control them here.');
    });
    $('account-unlink-telegram').disabled = false; $('account-link-telegram').disabled = false;
  };
  for (const id of ['account-save-settings', 'account-save-dialog']) $(id).onclick = async () => {
    $(id).disabled = true;
    try { await save(); if (dialog.open) message('Wallets, credentials, and settings saved.'); else { $(id).textContent = 'Saved to account'; setTimeout(() => { $(id).textContent = 'Save to account'; }, 2200); } }
    catch (e) { if (dialog.open) message(e.message, true); else alertError(e.message); }
    finally { $(id).disabled = false; }
  };
  $('account-logout').onclick = async () => {
    $('account-logout').disabled = true;
    await actionMessage(async () => { await api('/api/account/logout', {}); account = null; profileNavigation(); clearSecrets(); $('setup').reset(); $('wallets').replaceChildren(); location.reload(); });
    $('account-logout').disabled = false;
  };
  return {
    openConnections() { if (toolkit() && account) { connections ||= mountConnections(); connections.open(); } },
    get enabled() { return !!session?.accounts; },
    get authenticated() { return !session?.accounts || !!account; },
    async initialize(value) {
      session = value; features = value.features || {}; account = value.authenticated === false ? null : value.account || null; fees = value.fees || null; renderAuthGate(); profileNavigation();
      $('generate-toggle').hidden = !toolkit() || !session?.accounts || !account;
      $('session-loading').hidden = true;
      if (!session.accounts) { document.body.dataset.session = 'local'; return true; }
      $('session-label').textContent = 'Launchpad account';
      if (!session.authenticated || !account) { gate.hidden = false; document.body.dataset.session = 'guest'; (walletOnlyMode() ? $('auth-connect') : $('auth-username')).focus(); return false; }
      document.body.dataset.session = 'account'; $('account-button').hidden = false; $('account-save-settings').hidden = !toolkit();
      document.querySelector('.aside-note').replaceChildren();
      const noteTitle = document.createElement('strong'), note = document.createElement('p'); noteTitle.textContent = 'Your Launchpad account'; note.textContent = toolkit() ? 'Settings save to your account. Active runs require the Launchpad host to remain online.' : 'Manage your profile, security and launches.'; document.querySelector('.aside-note').append(noteTitle, note);
      document.querySelector('footer span:last-child').textContent = 'Your account. Measured execution.';
      renderAccount();
      if (!toolkit()) return true;
      try { const value = await api('/api/account/settings'); settingsRevision = value.revision; if (value.settings) { applySettings(value.settings); consentVersion = value.settings.agreedFeeVersion === fees?.version ? fees.version : ''; } }
      catch (e) { alertError(`Saved settings could not be loaded: ${e.message}`); }
      return true;
    },
    agreement,
    save,
    renderFeeNote,
    generateWallets(count, kind) {
      if (!toolkit()) return Promise.reject(Error('Toolkit wallet generation is unavailable on the launchpad.'));
      if (!session?.accounts || !account) return Promise.reject(Error('Sign in to generate saved wallets.'));
      if (generating) return Promise.reject(Error('Wallet generation is already in progress.'));
      generating = true;
      const pending = saveQueue.catch(() => {}).then(async () => {
        const value = { ...settings(), ...agreement() };
        value.wallets = value.wallets.filter(w => w.privateKey.trim() || w.publicKey.trim());
        const result = await api('/api/account/wallets/generate', { settings: value, revision: settingsRevision, count, kind });
        settingsRevision = result.revision; sealSettings(value, result.settings);
        const keys = new Set(result.generated.map(w => w.publicKey));
        addGeneratedWallets(result.settings.wallets.filter(w => keys.has(w.publicKey)));
        return result.generated;
      }).finally(() => { generating = false; });
      saveQueue = pending; return pending;
    },
    async exportPreset() {
      if (!toolkit()) throw Error('Toolkit settings are unavailable on the launchpad.');
      if (generating) throw Error('Wait for wallet generation to finish saving.');
      const current = settings(), credentials = await security.authorize('Export full setup, including private keys');
      return (await api('/api/account/settings-export', { settings: current, ...credentials })).settings;
    },
    async beforeManual(body) {
      if (!session?.accounts) return body;
      const id = body.trade?.id;
      if (preparedManual.has(id)) return preparedManual.get(id);
      if (body.config.mode === 'live') {
        acceptDisplayedFees();
      }
      const prepared = { ...body, config: { ...body.config, ...agreement() } };
      if (getStatus()?.state === 'stopped') await save();
      preparedManual.set(id, prepared);
      if (preparedManual.size > 32) preparedManual.delete(preparedManual.keys().next().value);
      return prepared;
    },
    async beforeStart(body, portfolio = false) {
      if (!session?.accounts) return body;
      const config = portfolio ? body.config : body;
      if (config.mode === 'live') {
        acceptDisplayedFees();
      }
      await save();
      return portfolio ? { ...body, config: { ...config, ...agreement() } } : { ...body, ...agreement() };
    },
  };
}
