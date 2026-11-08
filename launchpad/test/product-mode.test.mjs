import test from 'node:test';
import assert from 'node:assert/strict';
import { toolkitEnabled, telegramEnabled, managedAccountsEnabled, robinhoodEnabled, productFeatures, launchpadApi, launchpadAccount } from '../src/product-mode.mjs';

test('launchpad-only is the default and Telegram also requires an explicit toolkit opt-in', () => {
  assert.deepEqual(productFeatures({}), { toolkit: false, telegram: false, walletOnly: true, robinhood: false, tenant: false });
  for (const value of ['0', 'false', 'true', 'yes', 'TRUE', ' 1 ', 1, true]) assert.equal(toolkitEnabled({ LAUNCHPAD_ENABLE_TOOLKIT: value }), false);
  assert.equal(toolkitEnabled({ LAUNCHPAD_ENABLE_TOOLKIT: '1' }), true);
  assert.equal(telegramEnabled({ LAUNCHPAD_ENABLE_TELEGRAM: '1' }), false);
  assert.equal(managedAccountsEnabled({}), false);
  for (const value of ['true', '0', 1, true]) assert.equal(managedAccountsEnabled({ LAUNCHPAD_ENABLE_MANAGED_ACCOUNTS: value }), false);
  assert.deepEqual(productFeatures({ LAUNCHPAD_ENABLE_MANAGED_ACCOUNTS: '1' }), { toolkit: false, telegram: false, walletOnly: false, robinhood: false, tenant: false });
  assert.deepEqual(productFeatures({ LAUNCHPAD_ENABLE_TOOLKIT: '1' }), { toolkit: true, telegram: false, walletOnly: true, robinhood: false, tenant: false });
  const enabled = productFeatures({ LAUNCHPAD_ENABLE_TOOLKIT: '1', LAUNCHPAD_ENABLE_TELEGRAM: '1' });
  assert.deepEqual(enabled, { toolkit: true, telegram: true, walletOnly: true, robinhood: false, tenant: false }); assert(Object.isFrozen(enabled));
});

test('operator feature settings are read only under their LAUNCHPAD_ names', () => {
  assert.deepEqual(productFeatures({ LAUNCHPAD_ENABLE_TOOLKIT: '1', LAUNCHPAD_ENABLE_TELEGRAM: '1' }), { toolkit: true, telegram: true, walletOnly: true, robinhood: false, tenant: false });
  assert.equal(managedAccountsEnabled({ LAUNCHPAD_ENABLE_MANAGED_ACCOUNTS: '1' }), true);
  assert.deepEqual(productFeatures({ ENABLE_TOOLKIT: '1', ENABLE_TELEGRAM: '1' }), { toolkit: false, telegram: false, walletOnly: true, robinhood: false, tenant: false });
});

test('launchpad allowlist retains identity, security, creator and owner controls without reopening toolkit APIs', () => {
  const allowed = ['/api/session', '/api/wallet/challenge', '/api/wallet/verify', '/api/explore', '/api/explore/token', '/api/explore/holders', '/api/launchpad', '/api/launchpad/trading/submit', '/api/launchpad/fees/claim-all', '/api/launchpad/archive', '/api/admin/launches/archive', '/api/account', '/api/account/login', '/api/account/register', '/api/account/export', '/api/account/profile', '/api/account/avatar', '/api/account/security', '/api/account/mfa/setup', '/api/account/signin-wallet/challenge', '/api/admin/accounts', '/api/admin/health', '/api/admin/moderation/launch', '/api/admin/launchpad/create', '/api/admin/protocol-fees', '/api/admin/protocol-fees/claim'];
  for (const path of allowed) assert.equal(launchpadApi(path), true, path);
  const blocked = ['/api/status', '/api/start', '/api/stop', '/api/account/settings', '/api/account/settings-export', '/api/account/connections', '/api/account/wallets/generate', '/api/account/cashback-wallet', '/api/account/cashback-wallet/challenge', '/api/account/telegram-link', '/api/account/telegram-unlink', '/api/funding', '/api/robinhood/status', '/api/admin/sessions', '/api/launchpad-extra', '/api/explore-private'];
  for (const path of blocked) assert.equal(launchpadApi(path), false, path);
});

test('launchpad account projection removes retired product metadata without changing signing identity or storage', () => {
  const source = { id: 'user', username: 'creator', mainWallet: 'signing-wallet', signInWallet: 'linked-wallet', authType: 'password', role: 'admin', mfaEnabled: true, avatar: '/avatar.png', bio: 'Creator profile', cashbackBps: 500, cashbackWallet: 'cashback-wallet', cashbackWalletUpdatedAt: 123, cashbackWalletUpdatedBy: 'user', cashbackWalletVerified: true, telegramId: '12345' };
  const original = structuredClone(source), visible = launchpadAccount(source);
  for (const key of ['cashbackBps', 'cashbackWallet', 'cashbackWalletUpdatedAt', 'cashbackWalletUpdatedBy', 'cashbackWalletVerified', 'telegramId']) assert.equal(Object.hasOwn(visible, key), false, key);
  assert.equal(visible.mainWallet, source.mainWallet); assert.equal(visible.signInWallet, source.signInWallet); assert.equal(visible.role, 'admin'); assert.equal(visible.mfaEnabled, true); assert.equal(visible.avatar, source.avatar); assert.equal(visible.bio, source.bio);
  assert.deepEqual(source, original); assert.notEqual(source, visible); assert.equal(launchpadAccount(null), null); assert.equal(launchpadAccount(undefined), undefined);
});

test('only the exact public analytics endpoint is allowed in launchpad mode', () => {
  assert.equal(launchpadApi('/api/analytics'), true);
  for (const path of ['/api/analytics/private', '/api/analytics-config', '/api/analytics/refresh']) assert.equal(launchpadApi(path), false);
});

test('launchpad mode allows the exact holder-distribution status and enqueue route', () => {
  assert.equal(launchpadApi('/api/admin/holder-distributions'), true);
  assert.equal(launchpadApi('/api/admin/launches/action'), true);
  for (const path of ['/api/admin/holder-distributions/private', '/api/admin/holder-distributions-extra', '/api/admin/holder-distributions/', '/api/admin/sessions']) assert.equal(launchpadApi(path), false, path);
});


test('launchpad mode exposes only the exact global reward sweep route',()=>{
  assert.equal(launchpadApi('/api/admin/reward-sweeps'),true);
  for(const path of ['/api/admin/reward-sweeps/private','/api/admin/reward-sweeps-extra','/api/admin/reward-sweeps/'])assert.equal(launchpadApi(path),false);
});

test('v71.43: Robinhood Chain is off unless LAUNCHPAD_ROBINHOOD_ENABLED=1; its APIs leave the allowlist while it is off', () => {
  assert.equal(robinhoodEnabled({}), false);
  for (const value of ['0', 'false', 'true', 'yes', 1, true]) assert.equal(robinhoodEnabled({ LAUNCHPAD_ROBINHOOD_ENABLED: value }), false);
  assert.equal(robinhoodEnabled({ LAUNCHPAD_ROBINHOOD_ENABLED: '1' }), true);
  assert.deepEqual(productFeatures({ LAUNCHPAD_ROBINHOOD_ENABLED: '1' }), { toolkit: false, telegram: false, walletOnly: true, robinhood: true, tenant: false });
  for (const path of ['/api/admin/robinhood', '/api/admin/robinhood/setup', '/api/launchpad/robinhood/status', '/api/launchpad/robinhood/pairs', '/api/launchpad/robinhood/quote']) {
    assert.equal(launchpadApi(path, {}), false, path + ' off');
    assert.equal(launchpadApi(path, { LAUNCHPAD_ROBINHOOD_ENABLED: '1' }), true, path + ' on');
  }
  assert.equal(launchpadApi('/api/explore', {}), true);
});

test('white-label: LAUNCHPAD_PRODUCT=tenant is a product feature; a launchpad has no engine analytics or re-branding API, and the feature APIs only on a launchpad', () => {
  const env = { LAUNCHPAD_PRODUCT: 'tenant' };
  assert.equal(productFeatures(env).tenant, true); assert.equal(productFeatures({}).tenant, false);
  assert.equal(launchpadApi('/api/analytics', env), false); assert.equal(launchpadApi('/api/admin/branding', env), false); assert.equal(launchpadApi('/api/admin/branding/update', env), false);
  assert.equal(launchpadApi('/api/analytics', {}), true); assert.equal(launchpadApi('/api/admin/branding', {}), true);
  assert.equal(launchpadApi('/api/launchpad/estimate', env), true);
  assert.equal(launchpadApi('/api/pad/registry', env), true); assert.equal(launchpadApi('/api/admin/pad/takeovers', env), true); assert.equal(launchpadApi('/api/pad/registry', {}), false);
});
