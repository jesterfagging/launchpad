import { mkdir } from 'node:fs/promises';
import { loadMasterKey, TelegramStore } from '../src/telegram-store.mjs';
import { TelegramApi } from '../src/telegram-api.mjs';
import { telegramRoot, requireTelegramEnabled } from '../src/telegram-server.mjs';
import { readSecret } from './terminal-secret.mjs';
import { launchpadEnv } from '../src/brand-env.mjs';
import { applyTelegramBranding, telegramBrandingOptions } from '../src/telegram-branding.mjs';
async function main() {
  requireTelegramEnabled();
  const brandingOptions = telegramBrandingOptions();
  const root = telegramRoot(); await mkdir(root, { recursive: true, mode: 0o700 });
  const master = await loadMasterKey(root), store = new TelegramStore(root, master), saved = await store.read('host', {});
  if (saved.token && !process.argv.includes('--replace-token')) { console.log('Launchpad Telegram is already configured. Starting the host updates the existing bot’s profile.'); return; }
  console.log('One-time Launchpad Telegram setup: open @BotFather and copy the token for your existing bot, or use /newbot to create one.\nYour users will enter their own wallets and trading settings inside your bot.');
  let token = launchpadEnv('TELEGRAM_BOT_TOKEN');
  if (!token) {
    console.log('Paste with Ctrl+V or right-click, then press Enter. Stars and a character count confirm the paste; the token itself stays hidden.');
    do {
      token = await readSecret('BotFather token: ');
      if (!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token)) console.log('That does not look like a complete bot token. Copy only the token from BotFather and paste it again.');
    } while (!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token));
  }
  const api = new TelegramApi(token), me = await api.call('getMe');
  if (saved.botId && saved.botId !== me.id) throw new Error('This directory belongs to a different bot. Choose a separate LAUNCHPAD_TELEGRAM_DATA_DIR.');
  const webhook = await api.call('getWebhookInfo');
  if (webhook.url) throw new Error('This bot already has a webhook. Use a dedicated bot or remove its previous webhook first.');
  await store.write('host', { ...saved, token, botId: me.id });
  try {
    const result = await applyTelegramBranding({ api, hostStore: store, botId: me.id, ...brandingOptions });
    if (result.failed) console.log('The Launchpad profile update will retry when the host starts. Your bot token is saved.');
  } catch { console.log('The Launchpad profile update will retry when the host starts. Your bot token is saved.'); }
  console.log(`Saved. Your Launchpad bot: https://t.me/${me.username}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
