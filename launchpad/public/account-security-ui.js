const $ = id => document.getElementById(id);

export function createAccountSecurity({ api, dialog, getAccount, refresh, message, idPrefix = '', getFeatures = () => ({}), after = null }) {
  const $ = id => document.getElementById(idPrefix + id);
  const section = document.createElement('section'); section.className = 'account-section';
  section.innerHTML = '<h3>Security</h3><p id="security-summary" class="help"></p><div class="account-actions"><button type="button" class="small-button" id="security-setup">Enable two-factor authentication</button><button type="button" class="small-button" id="security-disable" hidden>Disable two-factor</button><button type="button" class="small-button" id="security-password">Change password</button><button type="button" class="small-button" id="security-revoke">Sign out everywhere</button></div><div id="security-enrollment" hidden><p id="security-enrollment-note" class="help"></p><label>Setup key<input id="security-secret" readonly autocomplete="off" spellcheck="false"></label><button type="button" class="small-button" id="security-confirm">Confirm authenticator</button></div><div id="security-recovery" hidden><p class="help">Save these recovery codes somewhere private. Each works once if you lose your authenticator. They are only shown now.</p><pre id="security-codes" class="account-address"></pre><button type="button" class="small-button" id="security-download">Save recovery codes</button></div><p id="security-account-note" class="help"></p>';
  if(idPrefix)for(const node of section.querySelectorAll('[id]'))node.id=idPrefix+node.id;
  // By default the section leads the dialog; a profile dialog passes `after` so its profile stays first.
  if (after?.isConnected) after.after(section); else dialog.querySelector('.account-section').before(section);
  // The compact credentials dialog look (430px, one form column), shared with sign-in.
  const auth = document.createElement('dialog'); auth.className = 'account-dialog signin-dialog security-auth-dialog'; auth.id = idPrefix + 'security-auth';
  auth.innerHTML = '<form id="security-auth-form"><h2 id="security-auth-title">Confirm your identity</h2><p id="security-auth-intro" class="help security-auth-intro">A quick check that it is really you. Nothing changes until you continue.</p><label>Account password<input id="security-auth-password" type="password" autocomplete="current-password" maxlength="128" required></label><label id="security-code-label">Authenticator or recovery code<input id="security-auth-code" autocomplete="one-time-code" spellcheck="false" maxlength="40"></label><p id="security-code-help" class="help">Use a new authenticator code. A code that was already accepted cannot be reused.</p><label id="security-new-label" hidden>New password<input id="security-new-password" type="password" autocomplete="new-password" minlength="10" maxlength="128"></label><label id="security-repeat-label" hidden>Confirm new password<input id="security-repeat-password" type="password" autocomplete="new-password" minlength="10" maxlength="128"></label><p id="security-auth-error" class="account-error" role="alert" hidden></p><div class="account-actions"><button type="submit" class="primary">Continue</button><button type="button" class="small-button" id="security-auth-cancel">Cancel</button></div></form>';
  if(idPrefix)for(const node of auth.querySelectorAll('[id]'))node.id=idPrefix+node.id;
  document.body.append(auth);
  let pending = null, enrollmentTimer, opener = null, focusTimer, lastBlur = null;
  // Callers disable their button before asking for identity, which already moves
  // focus to the page body, so the dialog cannot hand focus back when it closes.
  // Remember that control and return to it once it is usable again, or to the
  // nearest usable control when it was replaced.
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
  const concealed = node => !!node.closest?.('[hidden],[inert],dialog:not([open])');
  const usable = node => !!node && node.isConnected && !node.disabled && !concealed(node);
  const pageFocus = node => !node || node === document.body || node === document.documentElement;
  document.addEventListener('focusout', event => { if (!event.relatedTarget && event.target !== auth && !auth.contains(event.target)) lastBlur = { node: event.target, at: Date.now() }; }, true);
  function remember() {
    clearTimeout(focusTimer); let node = document.activeElement;
    if (pageFocus(node)) node = lastBlur && Date.now() - lastBlur.at < 1500 ? lastBlur.node : null;
    opener = node && typeof node.focus === 'function' && !auth.contains(node) ? { node, path: [] } : null;
    for (let parent = opener?.node.parentElement; parent; parent = parent.parentElement) if (!pageFocus(parent)) opener.path.push(parent);
  }
  function returnFocus() {
    const target = opener; opener = null; clearTimeout(focusTimer); if (!target) return;
    const started = Date.now();
    const attempt = () => {
      const active = document.activeElement;
      // Stop once focus is somewhere real again: the user moved on or another dialog took it.
      if (active === target.node || !pageFocus(active) && active.tagName !== 'DIALOG' && !auth.contains(active)) return;
      const waiting = target.node.isConnected && target.node.disabled && !concealed(target.node);
      let next = usable(target.node) ? target.node : null;
      if (!next && !waiting) {
        const ancestor = target.path.find(node => node.isConnected && !concealed(node));
        next = ancestor ? (ancestor.matches?.(FOCUSABLE) && usable(ancestor) ? ancestor : [...ancestor.querySelectorAll(FOCUSABLE)].find(usable)) : null;
        if (!next) return;
      }
      if (next) { next.focus({ preventScroll: true }); if (document.activeElement === next) return; }
      if (Date.now() - started < 20000) focusTimer = setTimeout(attempt, 100);
    };
    focusTimer = setTimeout(attempt, 0);
  }
  function clear() {
    clearTimeout(enrollmentTimer); $('security-secret').value = ''; $('security-codes').textContent = '';
    $('security-enrollment').hidden = true; $('security-recovery').hidden = true;
  }
  function finish(value) {
    const request = pending; pending = null;
    $('security-auth-form').reset(); if (auth.open) auth.close();
    if (request) value ? request.resolve(value) : request.reject(new Error('Cancelled.'));
    if (request) returnFocus();
  }
  auth.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  auth.addEventListener('close', () => { if (pending) finish(); });
  $('security-auth-cancel').onclick = () => finish();
  $('security-auth-form').onsubmit = event => {
    event.preventDefault();
    if (!$('security-new-label').hidden && $('security-new-password').value !== $('security-repeat-password').value) {
      $('security-auth-error').textContent = 'New passwords do not match.'; $('security-auth-error').hidden = false; return;
    }
    finish({ password: $('security-auth-password').value, code: $('security-auth-code').value.trim(), ...(!$('security-new-label').hidden ? { newPassword: $('security-new-password').value } : {}) });
  };
  function authorize(title, { requireCode = getAccount()?.mfaEnabled, newPassword = false } = {}) {
    if (getAccount()?.authType === 'wallet') return Promise.reject(new Error('Your connected wallet secures this account.'));
    if (pending) return Promise.reject(new Error('Finish the current identity check first.'));
    $('security-auth-title').textContent = title; $('security-auth-error').hidden = true;
    $('security-code-label').hidden = $('security-code-help').hidden = !requireCode; $('security-auth-code').required = !!requireCode;
    $('security-new-label').hidden = $('security-repeat-label').hidden = !newPassword;
    $('security-new-password').required = $('security-repeat-password').required = newPassword;
    remember();
    return new Promise((resolve, reject) => { pending = { resolve, reject }; auth.showModal(); $('security-auth-password').focus(); });
  }
  function bind(id, task) {
    $(id).onclick = async () => {
      $(id).disabled = true;
      try { message(''); await task(); }
      catch (error) { if (error.message !== 'Cancelled.') message(error.message, true); }
      finally { $(id).disabled = false; }
    };
  }
  bind('security-setup', async () => {
    const credentials = await authorize('Set up two-factor authentication', { requireCode: false });
    const result = await api('/api/account/mfa/setup', credentials);
    if (!dialog.open) return;
    clear(); $('security-secret').value = result.secret; $('security-enrollment').hidden = false;
    enrollmentTimer = setTimeout(clear, Math.max(0, result.expiresAt - Date.now()));
  });
  bind('security-confirm', async () => {
    const credentials = await authorize('Confirm your authenticator', { requireCode: true });
    const result = await api('/api/account/mfa/enable', credentials);
    clear();
    if (dialog.open) { $('security-codes').textContent = result.recoveryCodes.join('\n'); $('security-recovery').hidden = false; }
    await refresh(); message('Two-factor authentication enabled. Save your recovery codes.');
  });
  // These changes keep this session and sign out the other ones: confirm in place
  // and refresh this view. If the server ended this session too, say so instead.
  async function completed(done, ended) {
    try { await refresh(); }
    catch (error) { if (error?.sessionExpired) { message(ended, true); return; } throw error; }
    message(done);
  }
  bind('security-disable', async () => {
    await api('/api/account/mfa/disable', await authorize('Disable two-factor authentication'));
    await completed('Two-factor authentication is off. Your other sessions were signed out.', 'Two-factor authentication is off. Sign in again to continue.');
  });
  bind('security-password', async () => {
    await api('/api/account/password', await authorize('Change password', { newPassword: true }));
    await completed('Password changed. Your other sessions were signed out.', 'Password changed. Sign in again to continue.');
  });
  bind('security-revoke', async () => {
    const telegram = getFeatures().telegram === true;
    await api('/api/account/logout-all', await authorize(telegram ? 'Sign out everywhere and disconnect Telegram' : 'Sign out everywhere'));
    await completed('Your other sessions were signed out.' + (telegram ? ' Telegram was disconnected.' : ''), 'All sessions were signed out. Sign in again to continue.');
  });
  $('security-download').onclick = () => {
    const text = $('security-codes').textContent; if (!text) return;
    const url = URL.createObjectURL(new Blob([`Launchpad recovery codes for ${getAccount().username}\nKeep private. Each code works once.\n\n${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a'); a.href = url; a.download = 'recovery-codes.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  dialog.addEventListener('close', () => { clear(); if (pending) finish(); });
  return {
    authorize,
    render() {
      const account = getAccount(); section.hidden = !account || account.authType === 'wallet';
      if (section.hidden) { clear(); if (pending) finish(); return; }
      const features = getFeatures();
      $('security-enrollment-note').textContent = 'Enabling two-factor signs out other sessions' + (features.telegram === true ? ' and disconnects Telegram.' : '.') + ' In your authenticator app, add a setup key: time-based, 6 digits, 30 seconds. Enter this key, then confirm below.';
      $('security-account-note').textContent = 'Changing your password or signing out everywhere revokes your other sign-in sessions.' + (features.telegram === true ? ' Linked Telegram access is also disconnected.' : '') + (features.toolkit === true ? ' Active runs continue until you press Stop.' : '');
      $('security-summary').textContent = account.mfaEnabled ? `Two-factor authentication is on. ${account.recoveryCodesRemaining} recovery codes remain.`
        : account.role === 'admin' ? 'Enable two-factor authentication to unlock administration.' : (features.toolkit === true ? 'Add an authenticator to protect sign-ins, exports and account changes.' : 'Add an authenticator to protect password sign-ins and account changes.');
      $('security-setup').hidden = account.mfaEnabled;
      $('security-disable').hidden = !account.mfaEnabled || account.role === 'admin';
    },
  };
}
