import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { loadMasterKey, TelegramStore } from './telegram-store.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import { TelegramApi, TelegramOutbox, pollTelegram } from './telegram-api.mjs';
import { TelegramBot } from './telegram-bot.mjs';
import { launchpadEnv } from './brand-env.mjs';
import { applyTelegramBranding, telegramBrandingOptions } from './telegram-branding.mjs';
import { telegramEnabled } from './product-mode.mjs';
export function requireTelegramEnabled(){if(!telegramEnabled())throw Error('Telegram is disabled in launchpad-only mode. A future operator opt-in requires both LAUNCHPAD_ENABLE_TOOLKIT=1 and LAUNCHPAD_ENABLE_TELEGRAM=1.');}
export const telegramRoot = () => resolve(launchpadEnv('TELEGRAM_DATA_DIR') || fileURLToPath(new URL('../telegram-data', import.meta.url)));
export async function startHostedTelegram({ accounts, runtimes, policy, robinhood = null, publicUrl, maxUsers = 100, maxActive = 5, signal }) {
  requireTelegramEnabled();
  const brandingOptions = telegramBrandingOptions(), brandingAbort = new AbortController();
  const root = telegramRoot(); await mkdir(root, { recursive: true, mode: 0o700 });
  const release = await acquireProcessLock(join(root, 'process.lock'), 0);
  let bot, outbox, closing, branding;
  const close = () => closing ||= (async () => { brandingAbort.abort(); await branding; await bot?.close(); outbox?.close(); await release(); })();
  try {
    const master = await loadMasterKey(root), hostStore = new TelegramStore(root, master), saved = await hostStore.read('host', {});
    const token = launchpadEnv('TELEGRAM_BOT_TOKEN') || saved.token;
    if (!token) throw new Error('Run npm run telegram:setup once to enter your BotFather token.');
    const api = new TelegramApi(token), me = await api.call('getMe'), webhook = await api.call('getWebhookInfo');
    if (webhook.url) throw new Error('This token has an active webhook. Use a dedicated bot or remove the previous webhook.');
    if (saved.botId && saved.botId !== me.id) throw new Error('This directory belongs to a different Telegram bot. Use another LAUNCHPAD_TELEGRAM_DATA_DIR.');
    await hostStore.write('host', { ...saved, token, botId: me.id });
    const allowedUsers = (launchpadEnv('TELEGRAM_ALLOWED_USERS') ?? saved.allowedUsers ?? '').split(/[\s,]+/).filter(Boolean);
    outbox = new TelegramOutbox(api);
    bot = await new TelegramBot({ root, master, hostStore, api, outbox, maxUsers, maxActive, allowedUsers, accounts, runtimeManager: runtimes, robinhood, feePolicy: id => policy.get(id), publicUrl }).init();
    await api.call('setMyCommands', { scope: { type: 'all_private_chats' }, commands: [
      { command: 'start', description: 'Choose a chain and Launchpad tool' }, { command: 'account', description: 'Main wallet and cashback' },
      { command: 'login', description: 'Sign in to a Launchpad account' }, { command: 'logout', description: 'Disconnect this Telegram account' },
      { command: 'status', description: 'Run state and selected mode menu' }, { command: 'run', description: 'Review fees and start the selected mode' },
      { command: 'stop', description: 'Stop the selected mode' }, { command: 'stopall', description: 'Stop all tools on the selected chain' }, { command: 'wallets', description: 'Import follower wallets' },
      { command: 'positions', description: 'View positions and manage liquidity' }, { command: 'activity', description: 'Recent trading activity' },
      { command: 'tutorial', description: 'Get your own RPCs and API keys' },
      { command: 'funding', description: 'Fund wallets with Husher multi-route swaps' },
      { command: 'cancel', description: 'Cancel an input and return to the menu' },
    ] });
    // Cosmetic profile updates never hold up polling or active trading. The
    // encrypted checkpoint retries only unconfirmed fields on the next start.
    branding = applyTelegramBranding({ api, hostStore, botId: me.id, ...brandingOptions, signal: signal ? AbortSignal.any([signal, brandingAbort.signal]) : brandingAbort.signal })
      .then(result => { if (result.failed) console.warn('Launchpad Telegram profile update is incomplete; it will retry on the next start. Trading and bot commands are available.'); })
      .catch(() => console.warn('Launchpad Telegram profile update could not be saved; it will retry on the next start. Trading and bot commands are available.'));
    console.log(`Launchpad Telegram: https://t.me/${me.username}\nWeb and Telegram share accounts, settings and four independent modes per account.`);
    return { bot, done: pollTelegram(api, hostStore, bot, signal), close };
  } catch (error) { await close(); throw error; }
}
export async function main() { requireTelegramEnabled(); const { runHost } = await import('./host-server.mjs'); return runHost({ telegram: true }); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(String(error.message).replace(/(?:https?|wss?):\/\/\S+/g, '[endpoint]')); process.exitCode = 1; });
