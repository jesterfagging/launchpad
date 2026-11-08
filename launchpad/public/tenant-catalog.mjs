// White-label launchpads: what a launchpad is built from — venues, launch modes, layouts and colour presets — and the one validator
// for a launchpad's settings (tenant.json, LAUNCHPAD_PRODUCT=tenant, src/tenant/config.mjs). Usable from a server or a
// browser (a settings form, a provisioning service): pure data and functions, no imports, no DOM.

export const CATALOG_VERSION = 1;

/** Where coins launch. `id` is the engine's venue id. */
export const VENUES = Object.freeze([
  Object.freeze({ id: 'pump-classic', label: 'Pump.fun', note: 'Pump.fun bonding curve, graduates to PumpSwap.', icon: '/pair-origin-pump.png' }),
  Object.freeze({ id: 'raydium', label: 'Raydium', note: 'LaunchLab bonding curve, graduates to a Raydium pool.', icon: '/quote-logos/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R.png' }),
  Object.freeze({ id: 'meteora', label: 'Meteora', note: 'Dynamic bonding curve, graduates to Meteora DAMM v2.', icon: '/quote-logos/METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL.webp' }),
]);
export const VENUE_IDS = Object.freeze(VENUES.map(venue => venue.id));

/**
 * Launch modes: what a coin's creator fees do. `venues` are exactly the venues the engine runs the mode on (Raydium
 * and Meteora take Creator and Holders; Pump.fun takes every mode). Every mode here runs on the server's RPC and Jupiter
 * keys alone. Gotchi and AI Agent are not offered on launchpads (they need services and keys of their own);
 * RETIRED_MODES lists them so an older settings file still loads (they are dropped).
 */
export const MODES = Object.freeze([
  Object.freeze({ id: 'creator', label: 'Creator', note: 'Creator fees are paid to the coin’s creator.', venues: ['pump-classic', 'raydium', 'meteora'] }),
  Object.freeze({ id: 'holders', label: 'Holders', note: 'Creator fees are shared by the coin’s top holders.', venues: ['pump-classic', 'raydium', 'meteora'] }),
  Object.freeze({ id: 'diamond_hands', label: 'Diamond Hands', note: 'Holder rewards that skip sellers and grow with every payout held.', venues: ['pump-classic'] }),
  Object.freeze({ id: 'earned', label: 'Earned', note: 'Creator fees wait in escrow until the coin proves itself.', venues: ['pump-classic'] }),
  Object.freeze({ id: 'insured', label: 'Insured', note: 'Part of the fees builds a refund pot for holders.', venues: ['pump-classic'] }),
  Object.freeze({ id: 'market_maker', label: 'Market Maker', note: 'Creator fees fund a bot that balances SOL and the coin.', venues: ['pump-classic'] }),
  Object.freeze({ id: 'lp_manager', label: 'Liquidity Manager', note: 'Creator fees add liquidity to the pool after graduation.', venues: ['pump-classic'] }),
]);
export const MODE_IDS = Object.freeze(MODES.map(mode => mode.id));
export const RETIRED_MODES = Object.freeze(['gotchi', 'agent']);
const MODE_BY_ID = new Map(MODES.map(mode => [mode.id, mode]));
export const modeById = id => MODE_BY_ID.get(id) || null;
/** Whether a launch mode runs on a venue. */
export const modeOnVenue = (mode, venue) => !!MODE_BY_ID.get(mode)?.venues.includes(venue);

/** Page layouts: Terminal is the dense trading look, Rack the rounded, playful one with a phone dock; Clean is Terminal
 * opened up (airy, flat, thin lines) and Arcade is Rack turned up (chunky outlines, hard shadows, poster type). */
export const LAYOUTS = Object.freeze([
  Object.freeze({ id: 'terminal', label: 'Terminal', note: 'Dense and sharp: a trading terminal.' }),
  Object.freeze({ id: 'rack', label: 'Rack', note: 'Rounded and playful, with a dock on phones.' }),
  Object.freeze({ id: 'clean', label: 'Clean', note: 'Airy and quiet: flat cards, thin lines.' }),
  Object.freeze({ id: 'arcade', label: 'Arcade', note: 'Loud: chunky outlines and hard shadows.' }),
]);
/** The stylesheets a layout adds on top of tenant.css (Arcade builds on Rack). */
export const LAYOUT_STYLES = Object.freeze({ terminal: Object.freeze([]), rack: Object.freeze(['tenant-rack.css']), clean: Object.freeze(['tenant-clean.css']), arcade: Object.freeze(['tenant-rack.css', 'tenant-arcade.css']) });
/** Fonts: a heading and a body face, all served by the launchpad itself (public/fonts). 'layout' keeps the layout's own. */
export const FONTS = Object.freeze([
  Object.freeze({ id: 'layout', label: 'Layout default', heading: '', body: '' }),
  Object.freeze({ id: 'grotesk', label: 'Grotesk', heading: 'Pad Bricolage', body: 'Pad Inter' }),
  Object.freeze({ id: 'clean', label: 'Clean', heading: 'Pad Inter', body: 'Pad Inter' }),
  Object.freeze({ id: 'rounded', label: 'Rounded', heading: 'Pad Fredoka', body: 'Pad Fredoka' }),
  Object.freeze({ id: 'poster', label: 'Poster', heading: 'Pad Lilita', body: 'Pad Fredoka' }),
  Object.freeze({ id: 'mono', label: 'Mono', heading: 'Pad Geist Mono', body: 'Pad Inter' }),
]);
export const FONT_IDS = Object.freeze(FONTS.map(font => font.id));
/** Corners: how round cards, buttons and fields are ('layout' keeps the layout's own). */
export const CORNERS = Object.freeze([
  Object.freeze({ id: 'layout', label: 'Layout default' }), Object.freeze({ id: 'round', label: 'Round' }), Object.freeze({ id: 'soft', label: 'Soft' }), Object.freeze({ id: 'sharp', label: 'Sharp' }),
]);
export const CORNER_IDS = Object.freeze(CORNERS.map(corner => corner.id));
/** Page backgrounds, drawn in the accent colour behind everything. */
export const BACKGROUNDS = Object.freeze([
  Object.freeze({ id: 'plain', label: 'Plain' }), Object.freeze({ id: 'dots', label: 'Dots' }), Object.freeze({ id: 'grid', label: 'Grid' }), Object.freeze({ id: 'glow', label: 'Glow' }), Object.freeze({ id: 'stars', label: 'Stars' }),
]);
export const BACKGROUND_IDS = Object.freeze(BACKGROUNDS.map(background => background.id));
/** The launchpad's hero banner (optional, brand/hero.jpg at this size), shown on top of the home page. */
export const HERO_SIZE = Object.freeze({ width: 1600, height: 560 });
/**
 * Features a launchpad owner switches on (v1.1). Each is off in a launchpad file that predates it.
 *   tickerLock   a ticker or name cannot be launched again for 3 days, nor while that coin is established; lookalike
 *                tickers and copied images are allowed but flagged on the coin page
 *   bundleCheck  early buyers are traced back to their funders a minute after launch and the linked ones flagged
 *   registry     every launch numbered, the first 100 marked Founding, a Launches page and a Stats page
 *   summit       one coin in the spotlight each day, drawn at random with odds weighted by market cap, volume and age
 *   takeover     holders of 0.5% or more of a coin can ask for a new logo, banner, links and description; the owner approves
 */
export const FEATURES = Object.freeze([
  Object.freeze({ id: 'tickerLock', label: 'Ticker lock', group: 'protection', note: 'A ticker or name can’t be launched again for 3 days, nor while that coin is active. Lookalikes and copied images are flagged.' }),
  Object.freeze({ id: 'bundleCheck', label: 'Bundle check', group: 'protection', note: 'Shortly after launch, early buyers are traced to the wallets that funded them; ones linked to the creator are flagged on the coin page.' }),
  Object.freeze({ id: 'registry', label: 'Registry & stats', group: 'community', note: 'Every launch numbered (the first 100 are Founding), a Launches page and a Stats page.' }),
  Object.freeze({ id: 'summit', label: 'Summit', group: 'community', note: 'One coin in the spotlight each day, drawn with odds weighted by market cap, volume and age.' }),
  Object.freeze({ id: 'takeover', label: 'Community takeover', group: 'community', note: 'Holders of 0.5% or more of a coin can ask for a new logo, banner, links and description. You approve.' }),
]);
export const FEATURE_IDS = Object.freeze(FEATURES.map(feature => feature.id));
export const LAYOUT_IDS = Object.freeze(LAYOUTS.map(layout => layout.id));
export const THEMES = Object.freeze(['dark', 'light']);

/**
 * Where a coin starts on the venues whose curve a launchpad sets (Raydium LaunchLab and Meteora DBC). Both graduate at
 * a $50,000 market cap. A launchpad offers either start or both (then the coin's creator picks); Pump.fun's curve is
 * Pump.fun's own.
 */
export const START_TIERS = Object.freeze([
  Object.freeze({ id: '20k', usd: 20000, graduationUsd: 50000, label: '$20K start', note: 'Starts at a $20,000 market cap and graduates at $50,000: a gentler curve.' }),
  Object.freeze({ id: '4k', usd: 4000, graduationUsd: 50000, label: '$4K start', note: 'Starts at a $4,000 market cap and graduates at $50,000: a steeper curve with more of the supply on it.' }),
]);
export const START_IDS = Object.freeze(START_TIERS.map(tier => tier.id));
export const START_VENUES = Object.freeze(['raydium', 'meteora']);
export const DEFAULT_STARTS = Object.freeze(['20k']);
export const startTier = id => START_TIERS.find(tier => tier.id === id) || null;
/** The tier a starting market cap in USD belongs to ('20000' → 20k), or null. */
export const startForUsd = usd => START_TIERS.find(tier => String(tier.usd) === String(usd).replace(/\.0+$/, '')) || null;

// ---- Colour ----------------------------------------------------------------------------------------------------
// The pages carry two literal ramps in their stylesheets: the accent ramp (nine purples) and the grey ramp (seventeen
// greys, black to white). A launchpad's preset maps both onto tokens with a dark and a light value, so one switch flips
// the theme (src/tenant/skin.mjs applies them). Accents used as text get their own tokens: in the light theme the pale
// shades that read on black are darkened until they read on white, while fills, borders and gradients keep the preset.
export const ACCENT_RAMP = Object.freeze(['8b5cff', '7c4dff', 'a78bff', 'b388ff', 'ddd3ff', 'c9b8ff', '6d45d9', '4b2fa0', '1a1430']);
// Status colours (up, down, warning, info and their pale variants) are the same on every preset; as text they are
// darkened on light pages like the accents (src/tenant/skin.mjs gives text uses a token, other uses stay literal).
export const STATUS_RAMP = Object.freeze(['2ee59d', 'ff4d6d', 'ffb020', '5aa9ff', 'ff8fa3', '8ff0c9', 'ff7ad9']);
export const GREY_RAMP = Object.freeze(['000000', '0b0b0c', '121214', '141416', '18181b', '1f1f23', '202024', '2a2a30', '3a3a42', '4a4a53', '5e5e67', '7a7a85', '9a9aa3', 'c9c9cf', 'e4e4e7', 'f4f4f5', 'ffffff']);
// The light theme mirrors the greys: each one's lightness (0-100) in light mode, in GREY_RAMP order. The two text greys
// below the muted one keep their dark-theme contrast on white (#5e5e67 about 3:1, #7a7a85 about 4.5:1).
const LIGHT_LIGHTNESS = Object.freeze([100, 99.2, 98, 97.6, 96, 92.7, 92, 90.4, 83.1, 76.9, 54, 45, 40, 23.5, 15.5, 7.1, 0]);

/**
 * The presets. `accent` drives the ramp; `end` is the second colour of the accent gradient; `tint` (0-1) is how much
 * of the accent's hue the greys take. Two presets carry exact ramps: Ultraviolet is the original terminal palette
 * (no recolouring at all) and Tangerine the hand-tuned orange.
 */
export const PRESETS = Object.freeze([
  Object.freeze({ id: 'ultraviolet', label: 'Ultraviolet', accent: '8B5CFF', end: 'B388FF', tint: 0 }),
  Object.freeze({ id: 'tangerine', label: 'Tangerine', accent: 'FC6602', end: 'FFA366', tint: 0.3 }),
  Object.freeze({ id: 'ocean', label: 'Ocean', accent: '2F7CF6', end: '3FC1FF', tint: 0.12 }),
  Object.freeze({ id: 'emerald', label: 'Emerald', accent: '12B76A', end: '5EE6A8', tint: 0.1 }),
  Object.freeze({ id: 'rose', label: 'Rose', accent: 'F23F7A', end: 'FF8FB5', tint: 0.12 }),
  Object.freeze({ id: 'crimson', label: 'Crimson', accent: 'E5383B', end: 'FF7A59', tint: 0.1 }),
  Object.freeze({ id: 'gold', label: 'Gold', accent: 'F2A516', end: 'FFD45C', tint: 0.18 }),
  Object.freeze({ id: 'aqua', label: 'Aqua', accent: '0BB5D6', end: '5CE1F2', tint: 0.12 }),
  Object.freeze({ id: 'lime', label: 'Lime', accent: '7CC718', end: 'C2F25A', tint: 0.08 }),
  // Volt lime.
  Object.freeze({ id: 'volt', label: 'Volt', accent: 'DFFA3E', end: 'A6EF3B', tint: 0.06 }),
]);
export const PRESET_IDS = Object.freeze(PRESETS.map(preset => preset.id));
const PRESET_BY_ID = new Map(PRESETS.map(preset => [preset.id, preset]));
export const presetById = id => PRESET_BY_ID.get(id) || null;
/** Any colour: the 'custom' preset takes the owner's accent (#RRGGBB), kept between 32% and 80% lightness so text on it
 * and around it stays readable, with a second colour 18° along the wheel and lighter. */
export const CUSTOM_PRESET = 'custom';
export function accentHex(value) {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) return '';
  return (raw.length === 3 ? raw.split('').map(c => c + c).join('') : raw).toUpperCase();
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export function hexRgb(hex) {
  const raw = String(hex).replace(/^#/, '').toLowerCase(), value = raw.length === 3 ? raw.split('').map(c => c + c).join('') : raw.slice(0, 6);
  if (!/^[0-9a-f]{6}$/.test(value)) throw new TypeError('Invalid colour.');
  return [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16));
}
export const rgbHex = rgb => rgb.map(n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();
export function rgbHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, clamp(s, 0, 1), l];
}
export function hslRgb([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
const hsl = hex => rgbHsl(hexRgb(hex));
const fromHsl = (h, s, l) => rgbHex(hslRgb([(h % 360 + 360) % 360, clamp(s, 0, 1), clamp(l, 0, 1)]));
/** Mix two colours: t = 0 gives a, t = 1 gives b. */
export const mixHex = (a, b, t) => { const x = hexRgb(a), y = hexRgb(b); return rgbHex(x.map((v, i) => v + (y[i] - v) * t)); };
/** WCAG relative luminance and contrast ratio. */
export function luminance(hex) { return hexRgb(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0); }
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const EXACT = Object.freeze({
  ultraviolet: Object.freeze({ accents: Object.fromEntries(ACCENT_RAMP.map(hex => [hex, hex.toUpperCase()])) }),
  tangerine: Object.freeze({
    accents: Object.freeze({ '8b5cff': 'FC6602', '7c4dff': 'E05600', 'a78bff': 'FF8E4A', 'b388ff': 'FFA366', 'ddd3ff': 'FFE2CC', 'c9b8ff': 'FFB27A', '6d45d9': 'C94C00', '4b2fa0': '7A3300', '1a1430': '2A1A0A' }),
    greys: Object.freeze({ '000000': ['0A0806', 'FFFFFF'], '0b0b0c': ['0E0B08', 'FFFDFB'], '121214': ['15110C', 'FFF9F5'], '141416': ['17120D', 'FFF8F3'], '18181b': ['1E1710', 'FFF3EB'], '1f1f23': ['261D13', 'FBEADF'], '202024': ['281E14', 'FAE8DC'], '2a2a30': ['33271B', 'F5DECE'], '3a3a42': ['3F3022', 'EDCFBB'], '4a4a53': ['4E3C2A', 'E2BFA6'], '5e5e67': ['785E42', 'B08660'], '7a7a85': ['8A7257', 'A0764F'], '9a9aa3': ['B39A80', '8A6B48'], 'c9c9cf': ['E6D8C8', '4F3B29'], 'e4e4e7': ['F3E8DC', '35251A'], 'f4f4f5': ['FFF7EE', '1B1109'], 'ffffff': ['FFFFFF', '000000'] }),
  }),
});

function accentRamp(preset) {
  const [h, s, l] = hsl(preset.accent), soft = l + (1 - l) * 0.28, [eh, es] = hsl(preset.end || preset.accent);
  return {
    '8b5cff': preset.accent.toUpperCase(),
    '7c4dff': fromHsl(h, s, l - 0.04),
    'a78bff': fromHsl(h, s, soft),
    'b388ff': preset.end ? preset.end.toUpperCase() : fromHsl(eh + 14, es, soft),
    'ddd3ff': fromHsl(h, Math.max(s, 0.6), 0.91),
    'c9b8ff': fromHsl(h, Math.max(s, 0.6), 0.86),
    '6d45d9': fromHsl(h, s * 0.66, l * 0.82),
    '4b2fa0': fromHsl(h, s * 0.55, l * 0.59),
    '1a1430': fromHsl(h, s * 0.41, 0.13),
  };
}
function greyRamp(preset) {
  const [h] = hsl(preset.accent), t = clamp(Number(preset.tint) || 0, 0, 1);
  const tinted = lightness => { const grey = fromHsl(0, 0, lightness), hue = fromHsl(h, 1, lightness); return t ? mixHex(grey, hue, t) : grey; };
  return Object.fromEntries(GREY_RAMP.map((hex, index) => {
    const [, , l] = hsl(hex);
    return [hex, [!t || index === 0 || index === GREY_RAMP.length - 1 ? hex.toUpperCase() : tinted(l), tinted(LIGHT_LIGHTNESS[index] / 100)]];
  }));
}

// The contrast each accent shade needs on white when it is text in the light theme (WCAG: 4.5 body text, 3 large
// text and accents; the palest shade is the dark theme's brightest highlight, so it becomes the darkest).
const LIGHT_TEXT_CONTRAST = Object.freeze({ '8b5cff': 3, '7c4dff': 3, 'a78bff': 4.5, 'b388ff': 4.5, 'ddd3ff': 7, 'c9b8ff': 5.5, '6d45d9': 4.5, '4b2fa0': 4.5, '1a1430': 4.5 });
/** A colour darkened (lightness only, same hue) until it reaches `ratio` against white. */
export function readableOnWhite(hex, ratio) {
  const [h, s, l] = hsl(hex);
  let value = String(hex).replace(/^#/, '').toUpperCase(), lightness = l;
  while (contrast(value, 'FFFFFF') < ratio && lightness > 0) { lightness = Math.max(0, lightness - 0.01); value = fromHsl(h, s, lightness); }
  return value;
}
/**
 * The light theme's accents. `text`: every shade as text on a light page. `surface`: fills, borders and gradients keep
 * the preset, except the soft shades (outlines, glows and text through shared properties such as --acc-soft), which
 * take their readable value, and the dark selected-row tint, which becomes a pale tint of the accent.
 */
function lightAccents(accents) {
  const [h, s] = hsl(accents['8b5cff']);
  return {
    text: Object.fromEntries(ACCENT_RAMP.map(hex => [hex, readableOnWhite(accents[hex], LIGHT_TEXT_CONTRAST[hex])])),
    surface: { ...Object.fromEntries(ACCENT_RAMP.map(hex => [hex, accents[hex]])), ...Object.fromEntries(['a78bff', 'b388ff', 'c9b8ff'].map(hex => [hex, readableOnWhite(accents[hex], LIGHT_TEXT_CONTRAST[hex])])), '1a1430': fromHsl(h, Math.max(s, 0.55), 0.95) },
  };
}

/**
 * A preset's full palette: the accent ramp (Launchpad hex → new hex) with its light-theme text and surface values, the
 * greys (Launchpad hex → [dark, light]), the accent tokens the skin defines, and the ink that reads on the accent.
 */
export function customPreset(accent) {
  const hex = accentHex(accent) || PRESETS[0].accent, [h, s, l] = hsl(hex), base = fromHsl(h, s, clamp(l, 0.32, 0.8)), [bh, bs, bl] = hsl(base);
  return Object.freeze({ id: CUSTOM_PRESET, label: 'Custom', accent: base, end: fromHsl(bh + 18, Math.min(1, bs * 1.05 + 0.04), Math.min(0.86, bl + (1 - bl) * 0.35)), tint: bs < 0.08 ? 0 : 0.1 });
}
export function presetPalette(id, customAccent) {
  const preset = id === CUSTOM_PRESET ? customPreset(customAccent) : presetById(id) || PRESETS[0], exact = EXACT[preset.id] || {};
  const accents = exact.accents || accentRamp(preset), greys = exact.greys || greyRamp(preset), light = lightAccents(accents);
  const accent = accents['8b5cff'], ink = contrast(accent, '121214') >= contrast(accent, 'FFFFFF') ? '121214' : 'FFFFFF';
  return Object.freeze({
    id: preset.id, label: preset.label, accent, strong: accents['7c4dff'], soft: accents['a78bff'], end: accents['b388ff'], cream: accents['ddd3ff'],
    selText: accents['c9b8ff'], mauve: accents['6d45d9'], deep: accents['4b2fa0'], selBg: accents['1a1430'], ink,
    identity: preset.id === 'ultraviolet', accents: Object.freeze({ ...accents }), greys: Object.freeze({ ...greys }),
    lightText: Object.freeze(light.text), lightSurface: Object.freeze(light.surface), statusLightText: STATUS_LIGHT_TEXT,
  });
}
const STATUS_LIGHT_TEXT = Object.freeze(Object.fromEntries(STATUS_RAMP.map(hex => [hex, readableOnWhite(hex, 4.5)])));

// ---- A launchpad's settings ------------------------------------------------------------------------------------
// Short names that would collide with a hosting platform's own addresses or read as an official venue.
export const RESERVED_SLUGS = Object.freeze(['www', 'app', 'api', 'admin', 'operator', 'launch', 'launcher', 'build', 'new', 'order', 'orders', 'status', 'docs', 'help', 'support', 'terms', 'privacy', 'mail', 'email', 'smtp', 'ftp', 'ns1', 'ns2', 'cdn', 'static', 'assets', 'media', 'img', 'dev', 'test', 'staging', 'beta', 'demo', 'root', 'pump', 'pumpfun', 'raydium', 'meteora', 'solana', 'phantom', 'jupiter', 'dexscreener']);
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .'&!_-]{0,22}[A-Za-z0-9!.]$/;
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,22})[a-z0-9]$/;
/** A name as typed → a suggested address ("Moon Pad!" → "moon-pad"). */
export function slugFor(name) { return String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, ''); }
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
/** An X profile (a handle or its link) → its https://x.com/<handle> link, or '' when empty; throws on anything else. */
export function xLink(value) {
  const text = String(value || '').trim(); if (!text) return '';
  const handle = text.replace(/^@/, '').replace(/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\//i, '').replace(/[/?#].*$/, '');
  if (!HANDLE.test(handle)) throw new TypeError('Enter an X handle like @yourpad or its link.');
  return 'https://x.com/' + handle;
}
/** A Telegram group or channel (a handle or its link) → https://t.me/<name>, or ''. */
export function telegramLink(value) {
  const text = String(value || '').trim(); if (!text) return '';
  const name = text.replace(/^@/, '').replace(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\//i, '').replace(/[/?#].*$/, '');
  if (!/^[A-Za-z0-9_]{4,32}$/.test(name) && !/^\+[A-Za-z0-9_-]{8,40}$/.test(name)) throw new TypeError('Enter a Telegram link like t.me/yourpad.');
  return 'https://t.me/' + name;
}
/** A website: an https address without credentials, at most 200 characters, or ''. */
export function websiteLink(value) {
  const text = String(value || '').trim(); if (!text) return '';
  let url; try { url = new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text); } catch { throw new TypeError('Enter a website address like https://yourpad.xyz.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !/\./.test(url.hostname) || url.href.length > 200) throw new TypeError('Enter a website address like https://yourpad.xyz.');
  return url.href;
}
const fail = message => { throw new TypeError(message); };

/**
 * The settings a launchpad is built with, checked and normalised (tenant.json, and any form or service that writes
 * one, pass through here). `capabilities.agents` says whether AI agents can be offered,
 * `capabilities.hooks` whether transfer hooks can.
 */
export function normalizeTenantSettings(input, { capabilities = {}, retired = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Settings are missing.');
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  if (!NAME_PATTERN.test(name)) fail('Name your launchpad: 2–24 letters, numbers, spaces or . \' & ! _ -');
  const slug = String(input.slug ?? '').trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug) || slug.includes('--')) fail('The address must be 3–24 lowercase letters, numbers or single hyphens, and start and end with a letter or number.');
  if (RESERVED_SLUGS.includes(slug)) fail('That address is reserved. Pick another.');
  const tagline = String(input.tagline ?? '').trim().replace(/\s+/g, ' ');
  if (tagline.length > 80 || /[<>]/.test(tagline)) fail('Keep the tagline under 80 characters, without < or >.');
  const layout = LAYOUT_IDS.includes(input.layout) ? input.layout : fail('Pick a layout.');
  const preset = PRESET_IDS.includes(input.preset) || input.preset === CUSTOM_PRESET ? input.preset : fail('Pick a colour preset.');
  const accent = preset === CUSTOM_PRESET ? accentHex(input.accent) || fail('Pick your colour (a hex code like #7C4DFF).') : '';
  const theme = THEMES.includes(input.theme ?? 'dark') ? (input.theme ?? 'dark') : fail('Pick dark or light.');
  const venues = [...new Set(Array.isArray(input.venues) ? input.venues : [])];
  if (!venues.length) fail('Pick at least one venue.');
  for (const venue of venues) if (!VENUE_IDS.includes(venue)) fail('Unknown venue.');
  const modes = [...new Set(Array.isArray(input.modes) ? input.modes : [])].filter(mode => !(retired && RETIRED_MODES.includes(mode)));
  if (!modes.length) fail('Pick at least one launch mode.');
  for (const mode of modes) {
    const entry = modeById(mode); if (!entry) fail('Unknown launch mode.');
    if (entry.needs && capabilities[entry.needs] !== true) fail(`${entry.label} is not available on this server yet.`);
  }
  for (const venue of venues) if (!modes.some(mode => modeOnVenue(mode, venue))) fail(`${VENUES.find(row => row.id === venue).label} has none of the launch modes you picked. Add one it supports, or drop the venue.`);
  for (const mode of modes) if (!venues.some(venue => modeOnVenue(mode, venue))) fail(`${modeById(mode).label} runs on ${modeById(mode).venues.map(id => VENUES.find(row => row.id === id).label).join(' or ')} only. Add that venue, or drop the mode.`);
  const hooks = input.hooks === true;
  if (hooks && !venues.includes('meteora')) fail('Transfer hooks run on Meteora coins only. Add Meteora, or turn hooks off.');
  if (hooks && capabilities.hooks !== true) fail('Transfer hooks are not available on this server yet.');
  // Starts: for each venue that sets its own curve, the tiers offered (an older file without any keeps the $20K start).
  const rawStarts = input.starts && typeof input.starts === 'object' && !Array.isArray(input.starts) ? input.starts : {}, starts = {};
  for (const venue of START_VENUES.filter(id => venues.includes(id))) {
    const picked = rawStarts[venue] === undefined ? [...DEFAULT_STARTS] : Array.isArray(rawStarts[venue]) ? [...new Set(rawStarts[venue])] : fail('Pick the starts your launchpad offers.');
    for (const id of picked) if (!START_IDS.includes(id)) fail('Unknown start.');
    if (!picked.length) fail(`Pick at least one start for ${VENUES.find(row => row.id === venue).label}: $4K, $20K or both.`);
    starts[venue] = START_IDS.filter(id => picked.includes(id));
  }
  const links = input.links && typeof input.links === 'object' ? input.links : {};
  // Look options and features: absent in a launchpad file that predates them (then the defaults).
  const rawLook = input.look && typeof input.look === 'object' && !Array.isArray(input.look) ? input.look : {};
  const pick = (value, ids, fallback, message) => value === undefined ? fallback : ids.includes(value) ? value : fail(message);
  const look = {
    font: pick(rawLook.font, FONT_IDS, 'layout', 'Pick a font.'), corners: pick(rawLook.corners, CORNER_IDS, 'layout', 'Pick a corner style.'),
    background: pick(rawLook.background, BACKGROUND_IDS, 'plain', 'Pick a background.'), hero: rawLook.hero === true,
  };
  const rawFeatures = input.features && typeof input.features === 'object' && !Array.isArray(input.features) ? input.features : {};
  for (const key of Object.keys(rawFeatures)) if (!FEATURE_IDS.includes(key) && !retired) fail('Unknown feature.');
  const features = Object.fromEntries(FEATURE_IDS.map(id => [id, rawFeatures[id] === true]));
  return {
    name, slug, tagline, layout, preset, accent, theme, look, features,
    venues: VENUE_IDS.filter(id => venues.includes(id)), modes: MODE_IDS.filter(id => modes.includes(id)), hooks, starts,
    links: { x: xLink(links.x), telegram: telegramLink(links.telegram), website: websiteLink(links.website) },
    poweredBy: input.poweredBy !== false,
  };
}
