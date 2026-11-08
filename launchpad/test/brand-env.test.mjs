import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launchpadEnv } from '../src/brand-env.mjs';

test('operator settings are read from LAUNCHPAD_ names without changing the environment', () => {
  for (const suffix of ['DATA_DIR', 'MASTER_KEY_FILE', 'PUBLIC_URL', 'PUBLIC_RPC_URL', 'HUSHER_API_KEY', 'TELEGRAM_BOT_TOKEN']) {
    const value = suffix.endsWith('DIR') ? '/existing/launchpad-data' : 'configured value';
    const env = Object.freeze({ [`LAUNCHPAD_${suffix}`]: value });
    assert.equal(launchpadEnv(suffix, env), value);
  }
  assert.equal(launchpadEnv('DATA_DIR', {}), undefined);
  assert.equal(launchpadEnv('TELEGRAM_ALLOWED_USERS', { LAUNCHPAD_TELEGRAM_ALLOWED_USERS: '' }), '');
  assert.equal(launchpadEnv('DATA_DIR', { DATA_DIR: '/elsewhere' }), undefined);
  for (const value of ['', 'DATA_DIR\n', '../KEY', 'process.env', 'lowercase']) assert.throws(() => launchpadEnv(value, {}), /Invalid/);
});

const project = new URL('../', import.meta.url);
function child(env) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^LAUNCHPAD_/.test(name)));
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { accountRoot } from './src/host-server.mjs';
    import { telegramRoot } from './src/telegram-server.mjs';
    import { AccountService } from './src/accounts.mjs';
    console.log(JSON.stringify({data:accountRoot(),telegram:telegramRoot(),key:new AccountService('/unused').keyFile}));
  `], { cwd: project, env: { ...base, ...env }, encoding: 'utf8' });
}

test('host, Telegram and encryption-key paths come from the settings, with defaults inside the app', () => {
  const paths = { DATA_DIR: '/existing/launchpad-data', TELEGRAM_DATA_DIR: '/existing/telegram-data', MASTER_KEY_FILE: '/existing/account-master.key' };
  const result = child(Object.fromEntries(Object.entries(paths).map(([name, value]) => [`LAUNCHPAD_${name}`, value])));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { data: paths.DATA_DIR, telegram: paths.TELEGRAM_DATA_DIR, key: paths.MASTER_KEY_FILE });
  const defaults = child({});
  assert.equal(defaults.status, 0, defaults.stderr);
  const value = JSON.parse(defaults.stdout.trim());
  assert.match(value.data, /\/launchpad-data$/);
  assert.match(value.telegram, /\/telegram-data$/);
});
