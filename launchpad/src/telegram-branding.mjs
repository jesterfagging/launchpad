import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchpadEnv } from './brand-env.mjs';
import { brandName, publicOrigin } from './brand.mjs';
import { TELEGRAM_PROFILE_PHOTO_MAX_BYTES } from './telegram-api.mjs';

export const TELEGRAM_BRANDING_VERSION = 'brand-v1';
export const DEFAULT_TELEGRAM_PROFILE_PHOTO = fileURLToPath(new URL('../public/brand-avatar.jpg', import.meta.url));
/** The bot's public profile, in the platform's name (LAUNCHPAD_BRAND_NAME) with its address (LAUNCHPAD_PUBLIC_URL). */
export function telegramProfile(env = process.env) {
  const name = brandName(env), origin = publicOrigin(env), visit = origin ? ` Visit ${origin}.` : '';
  return Object.freeze({
    name: name.slice(0, 64),
    description: `Launch your next coin and manage your trading on ${name}. Solana launch and trading tools, funding and account settings in one place.${visit}`.slice(0, 512),
    short_description: `${name} · launchpad and trading toolkit for Solana.${origin ? ' ' + origin : ''}`.slice(0, 120),
  });
}
export const TELEGRAM_PROFILE = telegramProfile();

const digest = value => createHash('sha256').update(value).digest('hex');
const profileFields = [
  ['setMyName', 'name'], ['setMyDescription', 'description'], ['setMyShortDescription', 'short_description'],
];

export function telegramBrandingOptions(env = process.env) {
  return {
    enabled: !['0', 'false', 'off'].includes(String(launchpadEnv('TELEGRAM_BRANDING', env) ?? '').toLowerCase()),
    profilePhoto: launchpadEnv('TELEGRAM_PROFILE_PHOTO', env) || DEFAULT_TELEGRAM_PROFILE_PHOTO,
  };
}

async function profilePhotoBytes(path) {
  // Only an operator-selected local image is read; no URL fetch or arbitrary
  // document upload. A bounded read also handles a file growing after stat().
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 4 || stat.size > TELEGRAM_PROFILE_PHOTO_MAX_BYTES) throw new Error('Invalid profile image.');
    const buffer = Buffer.alloc(TELEGRAM_PROFILE_PHOTO_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > TELEGRAM_PROFILE_PHOTO_MAX_BYTES || size < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) throw new Error('Invalid profile image.');
    return buffer.subarray(0, size);
  } finally { await file.close(); }
}

// This edits the existing bot profile only. It never rotates its token,
// replaces its identity, changes its username, or modifies linked accounts.
// Persist each successful operation, and only mark the whole rebrand complete
// after every requested method returns true. Retries skip confirmed work.
export async function applyTelegramBranding({ api, hostStore, botId, enabled = true, profilePhoto = DEFAULT_TELEGRAM_PROFILE_PHOTO, signal, now = Date.now }) {
  if (!enabled) return { skipped: true, complete: false, updated: 0, failed: 0 };
  if (!Number.isSafeInteger(botId) || botId <= 0) throw new Error('Invalid Telegram bot identity.');
  const saved = await hostStore.read('branding', {});
  const state = saved.botId === botId && saved.version === TELEGRAM_BRANDING_VERSION
    ? { ...saved, confirmed: { ...saved.confirmed } }
    : { botId, version: TELEGRAM_BRANDING_VERSION, confirmed: {} };
  const profile = telegramProfile();
  const tasks = profileFields.map(([method, field]) => ({ method, hash: digest(profile[field]), run: () => api.call(method, { [field]: profile[field], language_code: '' }, signal) }));
  let failed = 0, updated = 0;
  try {
    const bytes = await profilePhotoBytes(profilePhoto);
    tasks.push({ method: 'setMyProfilePhoto', hash: digest(bytes), run: () => api.setProfilePhoto(bytes, signal) });
  } catch { failed++; }
  for (const task of tasks) {
    if (signal?.aborted) { failed++; break; }
    if (state.confirmed[task.method] === task.hash) continue;
    try {
      if (await task.run() !== true) throw new Error('Unconfirmed profile update.');
    } catch { failed++; continue; }
    state.confirmed[task.method] = task.hash;
    state.updatedAt = new Date(now()).toISOString();
    state.complete = false;
    await hostStore.write('branding', state);
    updated++;
  }
  state.complete = !failed && tasks.length === 4 && tasks.every(task => state.confirmed[task.method] === task.hash);
  if (state.complete !== saved.complete || updated || failed && saved.complete) await hostStore.write('branding', state);
  return { complete: state.complete, updated, failed };
}
