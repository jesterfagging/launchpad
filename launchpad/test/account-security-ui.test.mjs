import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';

test('account security keeps password and MFA controls without disabled product wording', async () => {
  const { document, window } = parseHTML('<html><body><dialog id="account"><section class="account-section"><h3>Profile</h3></section></dialog></body></html>');
  window.HTMLElement.prototype.showModal = function () { this.open = true; };
  window.HTMLElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.HTMLElement.prototype.reset = function () {};
  const source = (await readFile(new URL('../public/account-security-ui.js', import.meta.url), 'utf8')).replace('export function createAccountSecurity', 'function createAccountSecurity');
  const create = new Function('document', source + '\nreturn createAccountSecurity;')(document);
  let features = {}, account = { username: 'creator', role: 'user', mfaEnabled: false };
  const ui = create({ api: async () => ({}), dialog: document.getElementById('account'), getAccount: () => account, getFeatures: () => features, refresh: async () => {}, message() {} });
  ui.render();
  const section = document.querySelector('.account-section');
  assert.match(section.textContent, /Security/); assert.match(section.textContent, /Change password/); assert.match(section.textContent, /Sign out everywhere/);
  assert.match(section.textContent, /Enable two-factor authentication/);
  assert.ok(!/Telegram|Active runs|toolkit/.test(section.textContent));
  features = { toolkit: true, telegram: true }; ui.render();
  assert.match(section.textContent, /disconnects Telegram/); assert.match(section.textContent, /Active runs continue/);
  features = { toolkit: false, telegram: false }; ui.render();
  assert.ok(!/Telegram|Active runs/.test(section.textContent));
  account = { ...account, authType: 'wallet' }; ui.render(); assert.equal(section.hidden, true);
  await assert.rejects(ui.authorize('Change password'), /connected wallet secures/);
  account = { ...account, authType: 'password' }; ui.render(); assert.equal(section.hidden, false);
});

async function securityFixture({ refresh = async () => {}, features = {} } = {}) {
  const { document, window } = parseHTML('<html><body><dialog id="account"><section class="account-section"><h3>Profile</h3></section></dialog></body></html>');
  window.HTMLElement.prototype.showModal = function () { this.open = true; };
  window.HTMLElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.HTMLElement.prototype.reset = function () {};
  const source = (await readFile(new URL('../public/account-security-ui.js', import.meta.url), 'utf8')).replace('export function createAccountSecurity', 'function createAccountSecurity');
  const create = new Function('document', source + '\nreturn createAccountSecurity;')(document);
  const calls = [], messages = []; let refreshes = 0;
  const account = { username: 'creator', role: 'user', mfaEnabled: true, recoveryCodesRemaining: 8 };
  document.getElementById('account').open = true;
  const ui = create({ api: async (path, body) => { calls.push([path, body]); return {}; }, dialog: document.getElementById('account'), getAccount: () => account, getFeatures: () => features, refresh: async () => { refreshes++; await refresh(); }, message: (text, error = false) => messages.push([text, error]) });
  ui.render();
  const $ = id => document.getElementById(id);
  const confirm = async (id, fill) => { const task = $(id).onclick(); await new Promise(resolve => setTimeout(resolve, 0)); $('security-auth-password').value = 'current password'; $('security-auth-code').value = '123456'; fill?.($); $('security-auth-form').onsubmit({ preventDefault() {} }); await task; };
  return { $, calls, messages, confirm, get refreshes() { return refreshes; } };
}

test('password, two-factor and sign-out-everywhere confirm in place and refresh instead of reloading the page', async () => {
  const f = await securityFixture({ features: { telegram: true } });
  await f.confirm('security-password', $ => { $('security-new-password').value = 'a new long password'; $('security-repeat-password').value = 'a new long password'; });
  assert.deepEqual(f.calls.at(-1), ['/api/account/password', { password: 'current password', code: '123456', newPassword: 'a new long password' }]);
  assert.deepEqual(f.messages.at(-1), ['Password changed. Your other sessions were signed out.', false]); assert.equal(f.refreshes, 1); assert.equal(f.$('security-password').disabled, false);
  await f.confirm('security-disable'); assert.equal(f.calls.at(-1)[0], '/api/account/mfa/disable'); assert.match(f.messages.at(-1)[0], /^Two-factor authentication is off\. Your other sessions were signed out\./);
  await f.confirm('security-revoke'); assert.equal(f.calls.at(-1)[0], '/api/account/logout-all'); assert.deepEqual(f.messages.at(-1), ['Your other sessions were signed out. Telegram was disconnected.', false]); assert.equal(f.refreshes, 3);
});

test('a security change that also ended this session asks to sign in again instead of failing', async () => {
  const f = await securityFixture({ refresh: async () => { throw Object.assign(Error('Your session expired. Sign in again to continue.'), { sessionExpired: true }); } });
  await f.confirm('security-password', $ => { $('security-new-password').value = 'a new long password'; $('security-repeat-password').value = 'a new long password'; });
  assert.deepEqual(f.messages.at(-1), ['Password changed. Sign in again to continue.', true]);
});
