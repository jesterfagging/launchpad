// White-label launchpads (LAUNCHPAD_PRODUCT=tenant): the shared catalogue and its validator, the presets, the skin (stylesheets,
// pages), the launchpad settings file and the launch gate every venue asks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeTenantSettings, presetPalette, PRESETS, GREY_RAMP, ACCENT_RAMP, MODES, START_TIERS, startForUsd, slugFor, xLink, telegramLink, websiteLink, modeOnVenue, contrast } from '../public/tenant-catalog.mjs';
import { createTenantCopy } from '../public/tenant-copy.mjs';
import { createTenantSkin, greyReference, accentReference, recolouredFile, markSvg } from '../src/tenant/skin.mjs';
import { tenantConfig, platformShare, resetTenantConfig } from '../src/tenant/config.mjs';
import { requireTenantLaunch, raydiumMode, allowedStarts } from '../src/tenant/gate.mjs';
import { allowedMode, readTenant, navItems } from '../public/tenant-shell.mjs';

const base = { name: 'Moon Pad', slug: 'moon-pad', layout: 'rack', preset: 'ocean', venues: ['raydium', 'pump-classic'], modes: ['creator', 'holders', 'diamond_hands'] };

test('the validator normalises a launchpad and refuses what cannot run', () => {
  const settings = normalizeTenantSettings({ ...base, venues: ['raydium', 'pump-classic', 'raydium'], links: { x: '@moonpad', telegram: 't.me/moonpadfun', website: 'moonpad.xyz' } });
  assert.deepEqual(settings.venues, ['pump-classic', 'raydium'], 'catalogue order, no duplicates');
  assert.deepEqual(settings.links, { x: 'https://x.com/moonpad', telegram: 'https://t.me/moonpadfun', website: 'https://moonpad.xyz/' });
  assert.equal(settings.theme, 'dark'); assert.equal(settings.poweredBy, true); assert.equal(settings.hooks, false);
  const refuse = (patch, pattern, options) => assert.throws(() => normalizeTenantSettings({ ...base, ...patch }, options), pattern);
  refuse({ name: 'X' }, /Name your launchpad/);
  refuse({ name: '<b>Pad</b>' }, /Name your launchpad/); 
  assert.equal(normalizeTenantSettings({ ...base, name: 'Moon Launchpad' }).name, 'Moon Launchpad', 'a name may hold the brand word: rewriting keeps it');
  assert.equal(normalizeTenantSettings({ ...base, slug: 'Moon' }).slug, 'moon', 'an address is lowercased'); refuse({ slug: 'ab' }, /address/); refuse({ slug: 'moon pad' }, /address/); refuse({ slug: 'moon--pad' }, /address/); refuse({ slug: '-moon' }, /address/);
  refuse({ slug: 'admin' }, /reserved/);
  refuse({ venues: [] }, /at least one venue/); refuse({ venues: ['robinhood'] }, /Unknown venue/);
  refuse({ modes: ['paycheck'] }, /Unknown launch mode/);
  refuse({ venues: ['meteora'], modes: ['diamond_hands'] }, /Meteora has none of the launch modes/);
  refuse({ venues: ['raydium'], modes: ['creator', 'earned'] }, /Earned runs on Pump\.fun only/);
  // Gotchi and AI Agent are not offered on launchpads; an older settings file that names them still loads without them.
  refuse({ modes: ['creator', 'agent'] }, /Unknown launch mode/); refuse({ modes: ['creator', 'gotchi'] }, /Unknown launch mode/);
  assert.deepEqual(normalizeTenantSettings({ ...base, modes: ['creator', 'gotchi', 'agent'] }, { retired: true }).modes, ['creator']);
  assert.deepEqual(MODES.map(mode => mode.id), ['creator', 'holders', 'diamond_hands', 'earned', 'insured', 'market_maker', 'lp_manager']);
  assert.ok(MODES.every(mode => !mode.needs), 'every mode runs on the RPC and Jupiter keys alone');
  assert.deepEqual(MODES.filter(mode => mode.venues.length === 3).map(mode => mode.id), ['creator', 'holders'], 'Raydium and Meteora run Creator and Holders; Pump.fun runs every mode');
  // Starts: Raydium and Meteora offer $20K, $4K or both (an older file keeps $20K); Pump.fun's curve is its own.
  assert.deepEqual(normalizeTenantSettings(base).starts, { raydium: ['20k'] });
  assert.deepEqual(normalizeTenantSettings({ ...base, venues: ['raydium', 'meteora', 'pump-classic'], starts: { raydium: ['4k', '20k', '4k'], meteora: ['4k'], 'pump-classic': ['4k'] } }).starts, { raydium: ['20k', '4k'], meteora: ['4k'] });
  refuse({ starts: { raydium: [] } }, /at least one start for Raydium/); refuse({ starts: { raydium: ['69k'] } }, /Unknown start/); refuse({ starts: { raydium: '4k' } }, /starts your launchpad offers/);
  assert.equal(startForUsd('4000').id, '4k'); assert.equal(startForUsd(20000).id, '20k'); assert.equal(startForUsd('5000'), null);
  assert.ok(START_TIERS.every(tier => tier.graduationUsd === 50000));
  refuse({ hooks: true }, /Meteora coins only/);
  refuse({ venues: ['meteora'], modes: ['creator'], hooks: true }, /not available on this server/);
  assert.equal(normalizeTenantSettings({ ...base, venues: ['meteora'], modes: ['creator'], hooks: true }, { capabilities: { hooks: true } }).hooks, true);
  refuse({ tagline: 'x'.repeat(81) }, /tagline/); refuse({ tagline: '<script>' }, /tagline/);
  refuse({ links: { x: 'https://evil.com/a' } }, /X handle/); refuse({ links: { website: 'http://moonpad.xyz' } }, /website/);
  assert.equal(slugFor('Moon Pad!! Pro'), 'moon-pad-pro'); assert.equal(slugFor('  ***  '), '');
  assert.equal(xLink(''), ''); assert.equal(xLink('https://twitter.com/abc_1?s=2'), 'https://x.com/abc_1'); assert.equal(telegramLink('@pad_chat'), 'https://t.me/pad_chat'); assert.equal(websiteLink('https://pad.xyz/about'), 'https://pad.xyz/about');
  assert.equal(modeOnVenue('earned', 'pump-classic'), true); assert.equal(modeOnVenue('earned', 'raydium'), false);
});

test('every preset is a full palette: nine accents, seventeen greys for both themes, readable ink', () => {
  const hex = /^[0-9A-F]{6}$/;
  for (const preset of PRESETS) {
    const palette = presetPalette(preset.id);
    assert.deepEqual(Object.keys(palette.accents).sort(), [...ACCENT_RAMP].sort(), preset.id); assert.deepEqual(Object.keys(palette.greys).sort(), [...GREY_RAMP].sort(), preset.id);
    for (const value of Object.values(palette.accents)) assert.match(value, hex, preset.id);
    for (const [dark, light] of Object.values(palette.greys)) { assert.match(dark, hex, preset.id); assert.match(light, hex, preset.id); }
    assert.ok(contrast(palette.accent, palette.ink) >= 4, `${preset.id} ink contrast`);
    assert.equal(palette.greys['0b0b0c'][1].startsWith('F'), true, `${preset.id} light page background`);
  }
  assert.equal(presetPalette('ultraviolet').identity, true); assert.equal(presetPalette('ultraviolet').greys['121214'][0], '121214', 'Ultraviolet keeps the original greys in dark mode');
  assert.equal(presetPalette('tangerine').accents['8b5cff'], 'FC6602'); assert.deepEqual(presetPalette('tangerine').greys['121214'], ['15110C', 'FFF9F5']);
  assert.equal(presetPalette('nope').id, 'ultraviolet', 'an unknown preset falls back');
});

test('the skin recolours stylesheets: accents and greys to theme tokens by what they colour, alpha kept', () => {
  const config = { ...normalizeTenantSettings(base), palette: presetPalette('ocean'), logo: true, launcher: { name: 'Example Platform', url: 'https://platform.example' } };
  const skin = createTenantSkin(config, { publicUrl: 'https://moon-pad.pads.example' });
  const css = skin.recolourStylesheet('a{color:#8b5cff;background:#121214;border-color:#8B5CFF80;box-shadow:0 0 0 1px #00000080;outline-color:#fff;fill:#123456}');
  assert.equal(css, 'a{color:var(--tn-t8b5cff);background:var(--tn-n121214);border-color:color-mix(in srgb, var(--tn-a8b5cff) 50.2%, transparent);box-shadow:0 0 0 1px color-mix(in srgb, var(--tn-n000000) 50.2%, transparent);outline-color:var(--tn-nffffff);fill:#123456}');
  // Text colours get the text tokens (including custom properties named for text); gradients, fills and the rest the surface ones.
  assert.equal(skin.recolourStylesheet(':root{--acc:#8b5cff;--sel-text:#c9b8ff}@media (max-width:640px){.x:hover{background:linear-gradient(105deg,#ddd3ff,#a78bff 58%,#8b5cff);color:#1a1430}}b{background:url(data:image/png;base64,AAAA);-webkit-text-fill-color:#ddd3ff}'),
    ':root{--acc:var(--tn-a8b5cff);--sel-text:var(--tn-tc9b8ff)}@media (max-width:640px){.x:hover{background:linear-gradient(105deg,var(--tn-addd3ff),var(--tn-aa78bff) 58%,var(--tn-a8b5cff));color:var(--tn-t1a1430)}}b{background:url(data:image/png;base64,AAAA);-webkit-text-fill-color:var(--tn-tddd3ff)}');
  assert.equal(skin.recolourStylesheet('a{color:#2ee59d;background:#2ee59d1a;border-color:#ff4d6d}'), 'a{color:var(--tn-t2ee59d);background:#2ee59d1a;border-color:#ff4d6d}', 'status colours change only as text');
  assert.equal(greyReference('#000c'), 'color-mix(in srgb, var(--tn-n000000) 80%, transparent)'); assert.equal(greyReference('#123456'), null);
  assert.equal(accentReference('#DDD3FF14', true), 'color-mix(in srgb, var(--tn-tddd3ff) 7.8%, transparent)'); assert.equal(accentReference('#8b5cf'), null);
  // The tokens live on the root element (the engine's :root properties refer to them); light flips greys and text accents.
  const tokens = skin.tokensCss(), palette = presetPalette('ocean');
  assert.match(tokens, /:root \{ --tn-acc: #2F7CF6;[^}]*--tn-a8b5cff: #2F7CF6; --tn-t8b5cff: #2F7CF6;[^}]*--tn-n000000: #000000;/);
  assert.match(tokens, new RegExp(':root\\[data-theme="light"\\] \\{[^}]*--tn-tddd3ff: #' + palette.lightText.ddd3ff + ';[^}]*--tn-a1a1430: #' + palette.lightSurface['1a1430'] + ';[^}]*--tn-n000000: #FFFFFF;[^}]*--tn-nffffff: #000000;'));
  assert.match(tokens, /:root \{[^}]*--tn-t2ee59d: #2EE59D;/); assert.match(tokens, /:root\[data-theme="light"\] \{[^}]*--tn-t2ee59d: #[0-9A-F]{6};/);
  for (const value of Object.values(palette.statusLightText)) assert.ok(contrast(value, 'FFFFFF') >= 4.5, value + ' reads on white');
  for (const preset of PRESETS) { const { lightText, lightSurface, accents } = presetPalette(preset.id); for (const hex of ['a78bff', 'ddd3ff', 'c9b8ff', '6d45d9']) assert.ok(contrast(lightText[hex], 'FFFFFF') >= 4.5, preset.id + ' ' + hex + ' reads on white'); assert.ok(contrast(lightSurface['1a1430'], 'FFFFFF') < 1.3, preset.id + ' selected tint is pale'); assert.equal(lightSurface['8b5cff'], accents['8b5cff'], 'fills keep the preset'); assert.equal(lightSurface.a78bff, lightText.a78bff, 'soft shades take their readable value'); }
  assert.equal(recolouredFile('curve-theme.css'), true); assert.equal(recolouredFile('tenant.css'), false); assert.equal(recolouredFile('explore.js'), false);
  const violet = createTenantSkin({ ...config, preset: 'ultraviolet', palette: presetPalette('ultraviolet') }, {});
  assert.equal(violet.recolourStylesheet('a{color:#8b5cff;background:#121214}'), 'a{color:var(--tn-t8b5cff);background:var(--tn-n121214)}');
  assert.match(violet.tokensCss(), /:root \{[^}]*--tn-t8b5cff: #8B5CFF;/, 'Ultraviolet keeps the original accents in the dark theme');
});

test('look options: layouts keep their base, custom colours, fonts, corners, backgrounds, hero and features reach the page', () => {
  const settings = normalizeTenantSettings({ ...base, layout: 'arcade', preset: 'custom', accent: '#ff3366', look: { font: 'poster', corners: 'sharp', background: 'stars', hero: true }, features: { tickerLock: true, summit: true } });
  assert.equal(settings.accent, 'FF3366'); assert.deepEqual(settings.look, { font: 'poster', corners: 'sharp', background: 'stars', hero: true });
  assert.deepEqual(settings.features, { tickerLock: true, bundleCheck: false, registry: false, summit: true, takeover: false });
  assert.throws(() => normalizeTenantSettings({ ...base, preset: 'custom', accent: 'nope' }), /Pick your colour/);
  assert.throws(() => normalizeTenantSettings({ ...base, look: { font: 'comic' } }), /Pick a font/);
  assert.throws(() => normalizeTenantSettings({ ...base, features: { gambling: true } }), /Unknown feature/);
  const palette = presetPalette('custom', settings.accent); assert.equal(palette.id, 'custom'); assert.equal(palette.accent, 'FF3366');
  assert.equal(presetPalette('custom', '000000').accent, '525252', 'a custom colour is kept readable');
  const skin = createTenantSkin({ ...settings, palette, logo: true, launcher: { name: 'Example Platform', url: '' } }, {});
  const out = skin.rebrandPage('<html><head></head><body data-product="launchpad"></body></html>');
  assert.match(out, /data-layout="rack" data-style="arcade" data-preset="custom"/); assert.match(out, /data-font="poster" data-corners="sharp" data-background="stars" data-hero="on" data-features="tickerLock summit"/);
  assert.match(out, /href="\/tenant-rack\.css\?v=2"><link rel="stylesheet" href="\/tenant-arcade\.css\?v=2"><link rel="stylesheet" href="\/tenant-look\.css\?v=2">/);
  const clean = createTenantSkin({ ...normalizeTenantSettings({ ...base, layout: 'clean' }), palette: presetPalette('ocean'), logo: true, launcher: { name: 'Example Platform', url: '' } }, {}).rebrandPage('<html><head></head><body data-product="launchpad"></body></html>');
  assert.match(clean, /data-layout="terminal" data-style="clean"/); assert.match(clean, /tenant\.css\?v=2"><link rel="stylesheet" href="\/tenant-clean\.css\?v=2"><link rel="stylesheet" href="\/tenant-look\.css\?v=2">/);
  // The feature code reaches a page only when a feature is on.
  assert.match(out, /href="\/tenant-pad\.css\?v=2">/); assert.match(out, /<script type="module" src="\/tenant-pad\.mjs\?v=1"><\/script><\/body>/);
  assert.doesNotMatch(clean, /tenant-pad/, 'no feature on: no feature code'); assert.match(clean, /data-features=""/);
  assert.deepEqual(navItems({ features: ['registry', 'summit'], modes: ['creator'] }).map(([key]) => key), ['explore', 'launch', 'launches', 'summit', 'mine', 'docs']);
  assert.deepEqual(navItems({ features: ['takeover'], modes: ['creator'] }).map(([key]) => key), ['explore', 'launch', 'mine', 'docs']);
  // The docs page explains each feature, and its CSS shows only the ones that are on.
  const docs = readFileSync(new URL('../public/tenant-docs.html', import.meta.url), 'utf8'), css = readFileSync(new URL('../public/tenant.css', import.meta.url), 'utf8');
  assert.match(docs, /id="features" data-tn-feature="any"/); for (const id of ['registry', 'tickerLock', 'bundleCheck', 'summit', 'takeover']) { assert.match(docs, new RegExp(`<p data-tn-feature="${id}">`)); assert.match(css, new RegExp(`:not\\(\\[data-features~="${id}"\\]\\) \\.tn-doc \\[data-tn-feature="${id}"\\]`)); }
  // The bonding stage is never shown in words that read as the engine's name.
  const copy = createTenantCopy({ name: 'Moon Pad' }); assert.equal(copy.rebrandCopy('On the curve'), 'Bonding'); assert.equal(copy.rebrandCopy('Active on the curve'), 'Active while bonding');
});

test('pages carry the launchpad: its name, settings, icons and shell; never the engine brand or its badge', () => {
  const config = { ...normalizeTenantSettings({ ...base, name: "Rock & Roll's", slug: 'rock-roll', tagline: 'Loud coins', preset: 'rose' }), palette: presetPalette('rose'), logo: false, launcher: { name: 'Example Platform', url: 'https://platform.example' } };
  const skin = createTenantSkin(config, { publicUrl: 'https://rock-roll.pads.example' });
  const page = `<!doctype html><html><head><title>Launchpad — Discover coins</title><link rel="icon" href="/brand-icon.svg?v=54"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="theme-color" content="#000000"><link id="curve-price-badge-styles" rel="stylesheet" href="/curve-price-badge.css"></head><body data-robinhood="on" data-product="launchpad" class="relay-terminal"><header><a class="brand" href="/" aria-label="Launchpad home">x</a><a class="curve-price-badge" href="/coin?mint=7ioe"><span>$LAUNCHPAD</span></a></header><p>LAUNCHPAD / EXPLORE</p><p>Launch on Launchpad. The bonding curve and $LAUNCHPAD stay.</p><p>© __YEAR__ __NAME__ · __HOST__</p><script>const Launchpad=1;</script></body></html>`;
  const out = skin.rebrandPage(page);
  assert.match(out, /<body data-robinhood="on" data-product="tenant" data-layout="rack" data-style="rack" data-preset="rose" data-theme-default="dark" data-brand-name="Rock &amp; Roll&#39;s"/);
  assert.match(out, /data-font="layout" data-corners="layout" data-background="plain" data-hero="off" data-features=""/, 'an older launchpad file gets the default look and no features');
  assert.match(out, /data-venues="pump-classic raydium" data-modes="creator holders diamond_hands" data-hooks="off" data-starts="raydium:20k" data-logo="off" data-powered-by="on"/);
  assert.match(out, /<title>Rock &amp; Roll&#39;s — Discover coins<\/title>/); assert.match(out, /aria-label="Rock &amp; Roll&#39;s home"/);
  assert.match(out, /<p>ROCK &amp; ROLL&#39;S \/ EXPLORE<\/p>/); assert.match(out, /Launch on Rock &amp; Roll&#39;s\. The bonding curve and \$LAUNCHPAD stay\.<\/p>/);
  assert.match(out, /© \d{4} Rock &amp; Roll&#39;s · rock-roll\.pads\.example/);
  assert.doesNotMatch(out, /curve-price-badge/i); assert.match(out, /<script>const Launchpad=1;<\/script>/, 'scripts are left alone');
  assert.match(out, /rel="icon" href="\/brand\/mark\.svg"/); assert.match(out, /<link rel="stylesheet" href="\/tenant\.css\?v=2"><link rel="stylesheet" href="\/tenant-rack\.css\?v=2"><link rel="stylesheet" href="\/tenant-look\.css\?v=2"><\/head>/);
  assert.match(out, /<script type="module" src="\/tenant-shell\.mjs\?v=1"><\/script><\/body>/);
  assert.match(markSvg(config), /<svg[^>]*>.*>R<\/text><\/svg>$/);
  const copy = createTenantCopy({ name: 'Moon Pad' });
  assert.equal(copy.rebrandCopy('Configure Launchpad’s launchpad fee wallet'), 'Configure Moon Pad’s launchpad fee wallet'); assert.equal(copy.needsRebrand('Bonding Curve and the curve'), false);
  assert.equal(copy.rebrandCopy(copy.rebrandCopy('Launchpad home')), 'Moon Pad home', 'a rewrite never matches again');
});

test('the settings file, the platform share and the launch gate', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tenant-config-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'tenant.json'); await mkdir(join(dir, 'brand'));
  await writeFile(file, JSON.stringify({ version: 1, ...base, venues: ['raydium', 'meteora'], modes: ['creator', 'holders', 'agent'], hooks: true, starts: { raydium: ['20k', '4k'], meteora: ['4k'] }, launcher: { name: 'Example Platform', url: 'https://platform.example/' } }));
  const env = { LAUNCHPAD_PRODUCT: 'tenant', LAUNCHPAD_TENANT_FILE: file, LAUNCHPAD_PLATFORM_SHARE_WALLET: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' };
  resetTenantConfig(); t.after(resetTenantConfig);
  const config = tenantConfig(env);
  assert.equal(config.name, 'Moon Pad'); assert.deepEqual(config.modes, ['creator', 'holders'], 'a retired mode (AI Agent) in an older file is dropped'); assert.equal(config.hooks, false, 'hooks hide without a hook program');
  assert.deepEqual(config.starts, { raydium: ['20k', '4k'], meteora: ['4k'] }); assert.deepEqual(allowedStarts('meteora', env), ['4k']); assert.deepEqual(allowedStarts('meteora', {}), ['20k'], 'elsewhere: the $20K start');
  assert.equal(config.logo, false); assert.deepEqual(config.launcher, { name: 'Example Platform', url: 'https://platform.example' });
  assert.deepEqual(platformShare(env), { wallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', bps: 1000, minimumLamports: '50000000' });
  assert.throws(() => platformShare({ ...env, LAUNCHPAD_PLATFORM_SHARE_BPS: '9000' }), /1–5000/); assert.equal(platformShare({}), null);
  assert.equal(tenantConfig({}), null, 'other products have no launchpad settings');
  requireTenantLaunch({ venue: 'raydium', mode: 'holders' }, env);
  assert.throws(() => requireTenantLaunch({ venue: 'pump-classic', mode: 'creator' }, env), err => err.statusCode === 403 && /does not launch on Pump\.fun/.test(err.message));
  assert.throws(() => requireTenantLaunch({ venue: 'raydium', mode: 'gotchi' }, env), /Gotchi launches are not offered/);
  assert.throws(() => requireTenantLaunch({ venue: 'raydium', mode: 'paycheck' }, env), /Paycheck launches are not offered/);
  assert.throws(() => requireTenantLaunch({ venue: 'meteora', mode: 'creator', hooks: true }, env), /Transfer hook rules are not offered/);
  requireTenantLaunch({ venue: 'raydium', mode: 'creator', start: '4k' }, env); requireTenantLaunch({ venue: 'meteora', mode: 'holders', start: '4k' }, env);
  assert.throws(() => requireTenantLaunch({ venue: 'meteora', mode: 'holders', start: '20k' }, env), err => err.statusCode === 403 && /does not offer the \$20K start on Meteora\. Pick \$4K start/.test(err.message));
  assert.throws(() => requireTenantLaunch({ venue: 'meteora', mode: 'creator', start: '4k' }, {}), /not offered here/, 'the $4K start exists only where a launchpad offers it');
  requireTenantLaunch({ venue: 'meteora', mode: 'creator', start: '20k' }, {});
  requireTenantLaunch({ venue: 'pump-classic', mode: 'earned' }, {}); // any other product: no gate
  assert.equal(raydiumMode({ feeMode: 'holders', gotchiId: 'g1' }), 'gotchi'); assert.equal(raydiumMode({ feeMode: 'holders', paycheck: { policy: 'x' } }), 'paycheck'); assert.equal(raydiumMode({ feeMode: 'creator', agentRequest: {} }), 'agent'); assert.equal(raydiumMode({ feeMode: 'creator' }), 'creator');
  await writeFile(file, JSON.stringify({ version: 1, ...base, slug: 'admin' })); resetTenantConfig();
  assert.throws(() => tenantConfig(env), /reserved/, 'a bad settings file stops the host');
});

test('the browser shell keeps the launch form on the launchpad’s modes', () => {
  const body = { dataset: { brandName: 'Moon Pad', layout: 'rack', venues: 'pump-classic raydium', modes: 'holders diamond_hands', hooks: 'off', logo: 'on', poweredBy: 'off', launcherName: 'Example Platform', launcherUrl: 'https://platform.example', linkX: 'https://x.com/moon', linkTelegram: 'javascript:alert(1)' } };
  const tenant = readTenant(body);
  assert.equal(tenant.poweredBy, false); assert.equal(tenant.links.x, 'https://x.com/moon'); assert.equal(tenant.links.telegram, '', 'only real links are used');
  assert.equal(allowedMode(tenant, 'raydium', 'creator', ['creator', 'holders', 'diamond_hands']), 'holders');
  assert.equal(allowedMode(tenant, 'pump-classic', 'diamond_hands', ['creator', 'holders', 'diamond_hands']), 'diamond_hands');
  assert.equal(allowedMode(tenant, 'raydium', 'diamond_hands', ['creator', 'diamond_hands']), null);
  assert.deepEqual(navItems(tenant).map(([key]) => key), ['explore', 'launch', 'mine', 'docs']);
});
