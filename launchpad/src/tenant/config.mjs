// A white-label launchpad (LAUNCHPAD_PRODUCT=tenant). Its settings are in
// LAUNCHPAD_TENANT_FILE (tenant.json, next to its brand art in brand/) and its platform terms to the environment; this
// module reads both once, checks them with the shared validator and hands every other part of the engine one frozen
// object. Nothing here is ever taken from a request.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { launchpadEnv } from '../brand-env.mjs';
import { normalizeTenantSettings, presetPalette, modeById } from '../../public/tenant-catalog.mjs';

export const TENANT_PRODUCT = 'tenant';
export const tenantEnabled = (env = process.env) => launchpadEnv('PRODUCT', env) === TENANT_PRODUCT;
/** The brand art in brand/ next to tenant.json (PNG, square): the logo, the favicon and the home-screen icon. */
export const BRAND_FILES = Object.freeze({ 'logo-512.png': 512, 'icon-64.png': 64, 'icon-180.png': 180 });
/** The optional hero banner, brand/hero.jpg (public/tenant-catalog.mjs HERO_SIZE). */
export const HERO_FILE = 'hero.jpg';
export const PLATFORM_SHARE_DEFAULT_BPS = 1000;
export const PLATFORM_SHARE_DEFAULT_MIN_LAMPORTS = '50000000';

const fail = message => { throw new Error(`Launchpad settings: ${message}`); };
function walletAddress(value, name) {
  let key; try { key = new PublicKey(String(value).trim()); } catch { fail(`${name} is not a Solana address.`); }
  if (key.toBase58() !== String(value).trim() || !PublicKey.isOnCurve(key.toBytes())) fail(`${name} must be a regular Solana wallet.`);
  return key.toBase58();
}
/** The platform's share of the launchpad's protocol revenue (for example 10%): wallet, basis points and the payout minimum. */
export function platformShare(env = process.env) {
  const wallet = (launchpadEnv('PLATFORM_SHARE_WALLET', env) || '').trim();
  if (!wallet) return null;
  const bpsText = (launchpadEnv('PLATFORM_SHARE_BPS', env) || String(PLATFORM_SHARE_DEFAULT_BPS)).trim(), minText = (launchpadEnv('PLATFORM_SHARE_MIN_LAMPORTS', env) || PLATFORM_SHARE_DEFAULT_MIN_LAMPORTS).trim();
  if (!/^\d{1,5}$/.test(bpsText) || Number(bpsText) < 1 || Number(bpsText) > 5000) fail('LAUNCHPAD_PLATFORM_SHARE_BPS must be 1–5000.');
  if (!/^\d{1,12}$/.test(minText) || BigInt(minText) < 1000000n) fail('LAUNCHPAD_PLATFORM_SHARE_MIN_LAMPORTS must be at least 1000000 (0.001 SOL).');
  return Object.freeze({ wallet: walletAddress(wallet, 'LAUNCHPAD_PLATFORM_SHARE_WALLET'), bps: Number(bpsText), minimumLamports: minText });
}

let cached = null;
/** The launchpad's settings, or null on any other product. Throws (stopping the host) when the file is missing or wrong. */
export function tenantConfig(env = process.env) {
  if (!tenantEnabled(env)) return null;
  if (cached?.env === env) return cached.value;
  const file = (launchpadEnv('TENANT_FILE', env) || '').trim();
  if (!file) fail('LAUNCHPAD_TENANT_FILE is required when LAUNCHPAD_PRODUCT=tenant.');
  let raw; try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { fail(`${file} could not be read (${error.code || error.message}).`); }
  if (raw?.version !== 1) fail('unsupported tenant.json version.');
  // A capability the server cannot offer (agents, hooks) only hides its option rather than stopping the host.
  // Modes launchpads no longer offer (Gotchi, AI Agent) are dropped from an older file rather than stopping the host.
  const settings = normalizeTenantSettings(raw, { capabilities: { agents: true, hooks: true }, retired: true });
  const agents = launchpadEnv('AGENTS_ENABLED', env) === '1', hooks = !!(launchpadEnv('HOOK_PROGRAM_ID', env) || '').trim();
  const modes = settings.modes.filter(id => modeById(id).needs !== 'agents' || agents);
  if (!modes.length) fail('no launch mode is available on this server.');
  const dir = dirname(file), brand = join(dir, 'brand');
  const launcher = raw.launcher && typeof raw.launcher === 'object' ? raw.launcher : {};
  const launcherName = String(launcher.name || '').trim().slice(0, 40), launcherUrl = /^https:\/\/[a-z0-9.-]+(?::\d+)?\/?$/i.test(String(launcher.url || '')) ? String(launcher.url).replace(/\/$/, '') : '';
  const value = Object.freeze({
    ...settings, modes: Object.freeze(modes), venues: Object.freeze([...settings.venues]), hooks: settings.hooks && hooks,
    starts: Object.freeze(Object.fromEntries(Object.entries(settings.starts).map(([venue, ids]) => [venue, Object.freeze([...ids])]))),
    links: Object.freeze({ ...settings.links }), dir, brandDir: brand,
    logo: existsSync(join(brand, 'logo-512.png')) && existsSync(join(brand, 'icon-64.png')) && existsSync(join(brand, 'icon-180.png')),
    palette: presetPalette(settings.preset, settings.accent),
    look: Object.freeze({ ...settings.look, hero: settings.look.hero && existsSync(join(brand, HERO_FILE)) }), features: Object.freeze({ ...settings.features }),
    launcher: Object.freeze({ name: launcherName, url: launcherUrl }),
    createdAt: Number.isSafeInteger(raw.createdAt) ? raw.createdAt : 0,
  });
  cached = { env, value };
  return value;
}
/** Tests only: forget the cached settings. */
export function resetTenantConfig() { cached = null; }

/** Whether a launchpad offers a venue / a launch mode / transfer hooks (always true on any other product). */
export const tenantVenue = (venue, env = process.env) => { const config = tenantConfig(env); return !config || config.venues.includes(venue); };
export const tenantMode = (mode, env = process.env) => { const config = tenantConfig(env); return !config || config.modes.includes(mode); };
export const tenantHooks = (env = process.env) => { const config = tenantConfig(env); return !config || config.hooks; };
/** The starts a launchpad offers on a venue that sets its own curve (['20k'], ['4k'] or both), or null on any other product. */
/** Whether a launchpad switched a feature on (public/tenant-catalog.mjs FEATURES); false on any other product. */
export const tenantFeature = (id, env = process.env) => { const config = tenantConfig(env); return !!config?.features?.[id]; };
export const tenantStarts = (venue, env = process.env) => { const config = tenantConfig(env); return config ? (config.starts[venue] || []) : null; };
/** The brand art file for a /brand/<name> request, or null. */
export function brandFile(name, env = process.env) {
  const config = tenantConfig(env);
  if (!config) return null;
  if (name === HERO_FILE) return config.look.hero ? join(config.brandDir, HERO_FILE) : null;
  if (!Object.hasOwn(BRAND_FILES, name) || !config.logo) return null;
  return join(config.brandDir, name);
}
