import { launchpadEnv } from './brand-env.mjs';

// Launchpad-only is the release default. These operator-only switches preserve
// the dormant products for a future upgrade; request bodies cannot enable them.
export const toolkitEnabled = (env = process.env) => launchpadEnv('ENABLE_TOOLKIT', env) === '1';
export const telegramEnabled = (env = process.env) => toolkitEnabled(env) && launchpadEnv('ENABLE_TELEGRAM', env) === '1';
export const managedAccountsEnabled = (env = process.env) => launchpadEnv('ENABLE_MANAGED_ACCOUNTS', env) === '1';
// v71.43: Robinhood Chain is off the site unless the operator turns it on. The code stays; the pages hide every
// Robinhood control (<body data-robinhood="off">) and the Robinhood APIs answer 404.
export const robinhoodEnabled = (env = process.env) => launchpadEnv('ROBINHOOD_ENABLED', env) === '1';
// White-label: LAUNCHPAD_PRODUCT=tenant runs the engine as one branded launchpad (src/tenant/config.mjs reads its settings).
export const tenantEnabled = (env = process.env) => launchpadEnv('PRODUCT', env) === 'tenant';
export const productFeatures = (env = process.env) => Object.freeze({ toolkit: toolkitEnabled(env), telegram: telegramEnabled(env), walletOnly: !managedAccountsEnabled(env), robinhood: robinhoodEnabled(env), tenant: tenantEnabled(env) });

const accountPaths = new Set(['/api/account','/api/account/register','/api/account/login','/api/account/logout','/api/account/logout-all','/api/account/password','/api/account/security','/api/account/profile','/api/account/avatar','/api/account/export','/api/account/signin-wallet','/api/account/signin-wallet/challenge','/api/account/signin-wallet/unlink','/api/account/evm-wallet','/api/account/evm-wallet/challenge','/api/account/evm-wallet/unlink','/api/account/mfa/setup','/api/account/mfa/enable','/api/account/mfa/disable']);
const adminPaths = new Set(['/api/admin/pump-public/deployment/status','/api/admin/pump-public/deployment/prepare','/api/admin/pump-public/deployment/submit','/api/admin/pump-public/deployment/reconcile','/api/admin/pump-public/configuration/status','/api/admin/pump-public/configuration/prepare','/api/admin/pump-public/configuration/submit','/api/admin/pump-public/configuration/reconcile','/api/admin/pump-public/status','/api/admin/pump-public/setup','/api/admin/pump-public/configure','/api/admin/pump-test','/api/admin/pump-test/pairs','/api/admin/pump-test/preview','/api/admin/pump-test/funded/status','/api/admin/pump-test/funded/prepare','/api/admin/pump-test/funded/submit','/api/admin/pump-test/funded/reconcile','/api/admin/pump-test/deployment/status','/api/admin/pump-test/deployment/prepare','/api/admin/pump-test/deployment/submit','/api/admin/pump-test/deployment/reconcile','/api/admin/accounts','/api/admin/health','/api/admin/overview','/api/admin/revenue','/api/admin/revenue-audit','/api/admin/reward-diagnostics','/api/admin/holder-distributions','/api/admin/reward-sweeps','/api/admin/failed-launch-archive','/api/admin/cleanup','/api/admin/cleanup/archive-all','/api/admin/pairs','/api/admin/pairs/check','/api/admin/pairs/save','/api/admin/volume','/api/admin/protocol-treasury','/api/admin/protocol-treasury/configure','/api/admin/protocol-treasury/recognize','/api/admin/protocol-treasury/withdraw','/api/admin/protocol-gas-funding','/api/admin/protocol-gas-funding/configure','/api/admin/launches','/api/admin/launches/recipient','/api/admin/launches/action','/api/admin/launches/archive','/api/admin/branding','/api/admin/branding/update','/api/admin/moderation/user','/api/admin/moderation/launch']);
export function launchpadApi(path, env = process.env) {
  if(!robinhoodEnabled(env)&&(path==='/api/admin/robinhood'||path.startsWith('/api/admin/robinhood/')||path.startsWith('/api/launchpad/robinhood/')))return false;
  if(path==='/api/admin/burn-history')return true;
  // A launchpad has no engine analytics and no onchain re-branding of another brand's launches.
  if(tenantEnabled(env)&&(path==='/api/analytics'||path==='/api/admin/branding'||path.startsWith('/api/admin/branding/')))return false;
  // A launchpad's own features (v1.1, src/tenant/pad.mjs): only on a launchpad; each answers 404 itself when it is off.
  if(path.startsWith('/api/pad/')||path.startsWith('/api/admin/pad/'))return tenantEnabled(env);
  if(/^\/api\/admin\/damm-pump-test\/(status|setup|launches|operations|prepare|submit|reconcile|cancel|wallet|market|(deployment|configuration)\/(status|prepare|submit|reconcile))$/.test(path))return true;
  if(/^\/api\/admin\/damm-pump\/(status|setup|configure|claim-fees|(deployment|configuration)\/(status|prepare|submit|reconcile))$/.test(path))return true;
  if (new Set(['/api/admin/meteora/status','/api/admin/meteora/setup','/api/admin/meteora/configure','/api/admin/meteora/pairs','/api/admin/meteora/refresh-pairs']).has(path)) return true;
  if (path === '/api/gotchi' || path.startsWith('/api/gotchi/') || ['/api/admin/gotchi','/api/admin/gotchi/control','/api/admin/gotchi/retry'].includes(path)) return true;
  if (path === '/api/admin/agents' || path.startsWith('/api/admin/agents/')) return true;
  if (path === '/api/admin/pump-classic' || path.startsWith('/api/admin/pump-classic/')) return true;
  if (path === '/api/admin/robinhood' || path.startsWith('/api/admin/robinhood/')) return true;
  if (['/api/admin/vanity','/api/admin/vanity/import','/api/admin/vanity/remove'].includes(path)) return true;
  return path === '/api/session' || path === '/api/analytics' || path === '/api/wallet/challenge' || path === '/api/wallet/verify' || path === '/api/explore' || path.startsWith('/api/explore/') || path === '/api/launchpad' || path.startsWith('/api/launchpad/') || path.startsWith('/api/admin/launchpad/') || path === '/api/admin/protocol-fees' || path.startsWith('/api/admin/protocol-fees/') || accountPaths.has(path) || adminPaths.has(path);
}

// Keep the account's signing wallet, identity, profile and security state. Hide
// retired product metadata without modifying its persisted records or keys.
export function launchpadAccount(account) {
  if (!account || typeof account !== 'object') return account;
  const { cashbackBps, cashbackWallet, cashbackWalletUpdatedAt, cashbackWalletUpdatedBy, cashbackWalletVerified, telegramId, ...visible } = account;
  return visible;
}
