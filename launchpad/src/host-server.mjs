import { launchpadEnv } from './brand-env.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { AccountService } from './accounts.mjs';
import { AccountFeePolicy } from './account-policy.mjs';
import { AccountRuntimeManager } from './account-runtime.mjs';
import { createAccountApp } from './account-app.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import { invariant } from './core.mjs';
import { CashbackVerifier } from './cashback-verifier.mjs';
import { PositionMarketFeed } from './position-feed.mjs';
import { RobinhoodFeePolicy } from './robinhood-policy.mjs';
import { RobinhoodRuntimeManager } from './robinhood-runtime.mjs';
import { RobinhoodCashbackVerifier } from './robinhood-cashback.mjs';
import { toolkitEnabled, telegramEnabled } from './product-mode.mjs';
import { tenantConfig } from './tenant/config.mjs';
import { bootstrapTenant } from './tenant/bootstrap.mjs';
import { brandName } from './brand.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
export const accountRoot = () => resolve(launchpadEnv('DATA_DIR') || join(root, 'launchpad-data'));
function integer(value, fallback, min, max, name) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  invariant(Number.isSafeInteger(n) && n >= min && n <= max, `${name} must be ${min}–${max}.`); return n;
}
export async function runHost({ telegram = launchpadEnv('ENABLE_TELEGRAM') === '1', openBrowser = false, bindAddress = launchpadEnv('BIND_ADDRESS') || '127.0.0.1' } = {}) {
  const toolkit = toolkitEnabled(), startTelegram = telegram && telegramEnabled();
  invariant(process.env.NODE_ENV !== 'production' || !!launchpadEnv('PUBLIC_URL'), 'Set LAUNCHPAD_PUBLIC_URL to the HTTPS website origin before running in production.');
  const dir = accountRoot(); await mkdir(dir, { recursive: true, mode: 0o700 });
  const release = await acquireProcessLock(join(dir, 'host.lock'), 0);
  let server, runtimes, telegramService, verifier, positionFeed, closing, robinhood;
  const abort = new AbortController();
  const shutdown = () => closing ||= (async () => {
    abort.abort(); console.log('Stopping hosted runs and saving transaction journals…');
    if (server) { server.close(); server.closeAllConnections?.(); }
    verifier?.close(); robinhood?.verifier?.close(); positionFeed?.close();
    // Launches and treasury jobs share the Solana runtime's RPC scheduler.
    // Stop workers now, but keep their scheduler alive until the other users
    // finish saving/checking in-flight operations. Closing it in parallel used
    // to turn a normal deployment restart into a persisted reward failure.
    const services = server?.closeServices?.(), consumersClosed = Promise.allSettled([services, telegramService?.close()]);
    // v71.37: a close that never settles (a provider call without a deadline, a browser that will not quit) used to hold the
    // process until systemd killed it at its stop timeout. Say which services are still closing after 60 s and leave at 100 s.
    const stillClosing = () => [...(services?.pending || [])].join(', ') || 'none of the named services';
    const slow = setTimeout(() => console.error(`Stopping is taking longer than 60 s; still closing: ${stillClosing()}.`), 60000); slow.unref?.();
    const deadline = setTimeout(() => { console.error(`Stopping exceeded 100 s; leaving with these still closing: ${stillClosing()}. Journals are written atomically, so nothing half-written is left behind.`); process.exit(0); }, 100000); deadline.unref?.();
    await Promise.allSettled([consumersClosed, robinhood?.runtimes.close(), runtimes?.close({ consumersClosed })]); await release();
    clearTimeout(slow); clearTimeout(deadline);
    // Everything has saved and closed. A stray socket or timer must not keep
    // the process alive until systemd's stop timeout kills it: leave on our own.
    const hardExit = setTimeout(() => process.exit(0), 20000); hardExit.unref?.();
  })();
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  try {
    const accounts = await new AccountService(dir).init(), policy = new AccountFeePolicy(accounts);
    // A white-label launchpad (LAUNCHPAD_PRODUCT=tenant): its settings are checked, and its treasury, protocol fee recipient and
    // venue switches are in place, before the app takes a request (src/tenant/bootstrap.mjs).
    const tenant = tenantConfig();
    if (tenant) await bootstrapTenant({ accounts, log: line => console.log(`[launchpad] ${line}`) });
    const maxActive = integer(launchpadEnv('MAX_ACTIVE') || launchpadEnv('TELEGRAM_MAX_ACTIVE'), 5, 1, 100, 'LAUNCHPAD_MAX_ACTIVE');
    const maxUsers = integer(launchpadEnv('MAX_USERS') || launchpadEnv('TELEGRAM_MAX_USERS'), 1000, 1, 10000, 'LAUNCHPAD_MAX_USERS');
    const beforeLiveStart = async id => {
      const account = await accounts.get(id);
      if (!account.telegramId) return;
      const { telegramRoot } = await import('./telegram-server.mjs');
      const legacyRoot = telegramRoot();
      try { await stat(join(legacyRoot, 'users', String(account.telegramId))); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      const { readLegacyExposure } = await import('./telegram-bot.mjs');
      const master = await readFile(join(legacyRoot, 'master.key')).catch(() => { throw new Error('Restore the previous Telegram encryption key before starting live trading.'); });
      const legacy = await readLegacyExposure(legacyRoot, master, account.telegramId);
      invariant(!legacy.blocked, 'Previous Telegram positions have not been imported. Resolve open positions, pending transactions and LP allocations in the previous build before starting live trading here.');
    };
    if (toolkit) positionFeed = new PositionMarketFeed();
    runtimes = new AccountRuntimeManager(accounts, policy, { maxActive, beforeLiveStart, positionFeed, toolkit });
    if (toolkit) {
      const robinhoodPolicy = new RobinhoodFeePolicy(accounts);
      robinhood = { policy: robinhoodPolicy, runtimes: new RobinhoodRuntimeManager(accounts, robinhoodPolicy, { maxActive, solana: runtimes }), verifier: new RobinhoodCashbackVerifier(accounts) }; robinhood.verifier.start();
      runtimes.activeCountSolana = runtimes.activeCount.bind(runtimes);
      runtimes.activeCount = except => runtimes.activeCountSolana(except) + robinhood.runtimes.ownActiveCount();
      verifier = new CashbackVerifier(accounts,{rpcGate:runtimes.rpcGate}); verifier.start();
    }
    const port = integer(process.env.COPYTRADER_PORT, 8787, 1024, 65535, 'COPYTRADER_PORT'), publicUrl = launchpadEnv('PUBLIC_URL') || '';
    invariant(['127.0.0.1', '0.0.0.0'].includes(bindAddress), 'LAUNCHPAD_BIND_ADDRESS must be 127.0.0.1 or 0.0.0.0.');
    invariant(!publicUrl || bindAddress === '127.0.0.1', 'Public hosting requires LAUNCHPAD_BIND_ADDRESS=127.0.0.1 behind the local HTTPS reverse proxy.');
    if (abort.signal.aborted) throw new Error('Host stopped.');
    server = createAccountApp({ accounts, runtimes, policy, robinhood, publicUrl, maxUsers });
    await new Promise((ready, reject) => { server.once('error', reject); server.listen(port, bindAddress, ready); });
    const url = publicUrl || `http://127.0.0.1:${port}`;
    if (tenant) console.log(`\n${tenant.name} launchpad\nOpen ${url}\n`); else console.log(toolkit ? `\n${brandName()} accounts\nOpen ${url}\n${maxUsers} accounts · ${maxActive} simultaneous runs\nKeep this process running. Press Ctrl+C to stop all hosted runs.\n` : `\n${brandName()}\nOpen ${url}\n${maxUsers} accounts · Toolkit and Telegram are disabled.\nKeep this process running. Press Ctrl+C to stop the host.\n`);
    if (!(await accounts.list()).some(a => a.role === 'admin')) console.log('Run npm run owner:setup to create or designate your administrator account.');
    if (startTelegram) {
      const { startHostedTelegram } = await import('./telegram-server.mjs');
      telegramService = await startHostedTelegram({ accounts, runtimes, policy, robinhood, publicUrl, maxUsers, maxActive, signal: abort.signal });
      telegramService.done.catch(async error => { if (!abort.signal.aborted) { console.error(String(error.message).replace(/(?:https?|wss?):\/\/\S+/g, '[endpoint]')); await shutdown(); process.exitCode = 1; } });
    }
    if (openBrowser) {
      const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      const child = spawn(command, args, { stdio: 'ignore', detached: true }); child.on('error', () => {}); child.unref();
    }
    return { accounts, policy, runtimes, server, shutdown, products: { toolkit, telegram: startTelegram }, background: { positionFeed, verifier, robinhood, telegramService } };
  } catch (error) { await shutdown(); throw error; }
}
