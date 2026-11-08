// A launchpad's look (LAUNCHPAD_PRODUCT=tenant). The engine's stylesheets carry an accent ramp and a grey ramp as literal
// hex colours in a few hundred places. A launchpad serves every engine stylesheet with each of them mapped onto a custom
// property whose dark and light values come from the preset, so the theme switch flips the whole page at once: greys
// become --tn-n<hex>; an accent becomes --tn-t<hex> where it colours text (color, fill, stroke and the like, or a
// custom property named for text) and --tn-a<hex> everywhere else (fills, borders, shadows, gradients). A colour with
// alpha becomes color-mix(... P%, transparent). Pages get the launchpad's words, icons and its shell.
import { ACCENT_RAMP, GREY_RAMP, STATUS_RAMP, LAYOUT_STYLES, FEATURE_IDS } from '../../public/tenant-catalog.mjs';
// Clean is Terminal opened up and Arcade is Rack turned up: the page keeps its base layout (the shell and the Rack
// stylesheet key on it) and data-style names the variant.
const LAYOUT_BASE = Object.freeze({ terminal: 'terminal', rack: 'rack', clean: 'terminal', arcade: 'rack' });
import { createTenantCopy, escapeHtml } from '../../public/tenant-copy.mjs';

const expand = hex => hex.length <= 4 ? hex.split('').map(c => c + c).join('') : hex;
const LITERAL = /#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z_-])/g;
const GREYS = new Set(GREY_RAMP), ACCENTS = new Set(ACCENT_RAMP), STATUS = new Set(STATUS_RAMP);
// A declaration (property: value) inside a rule or a block, also right after a comment; the value stops at ; { or }.
const DECLARATION = /((?:[{;]|\*\/)\s*)(--[\w-]+|-?[a-zA-Z][\w-]*)(\s*:)([^;{}]*)/g;
const TEXT_PROPERTY = /^(?:color|fill|stroke|caret-color|text-decoration-color|text-emphasis-color|-webkit-text-fill-color|-webkit-text-stroke-color)$/i;
const TEXT_VARIABLE = /^--(?:[\w-]*-)?(?:text|cream|ink|fg)(?:-[\w-]*)?$/i;
export const textProperty = property => TEXT_PROPERTY.test(property) || TEXT_VARIABLE.test(property);
export const greyToken = hex => '--tn-n' + hex;
export const accentToken = (hex, text = false) => (text ? '--tn-t' : '--tn-a') + hex;
const withAlpha = (token, alpha) => alpha ? 'color-mix(in srgb, var(' + token + ') ' + Math.round(parseInt(alpha, 16) / 255 * 1000) / 10 + '%, transparent)' : 'var(' + token + ')';
const literalParts = literal => { const value = expand(String(literal).replace(/^#/, '').toLowerCase()); return [value.slice(0, 6), value.slice(6)]; };
/** A literal grey (#121214, #fff, #00000080, #000c) as its token reference, or null when it is not on the ramp. */
export function greyReference(literal) {
  const [hex, alpha] = literalParts(literal);
  return GREYS.has(hex) ? withAlpha(greyToken(hex), alpha) : null;
}
/** A literal accent (#8b5cff, #8B5CFF80) as its text or surface token reference, or null when it is not on the ramp. */
export function accentReference(literal, text = false) {
  const [hex, alpha] = literalParts(literal);
  return ACCENTS.has(hex) ? withAlpha(accentToken(hex, text), alpha) : null;
}
/** A literal status colour used as text (#2ee59d) as its text token reference, or null. */
export function statusReference(literal) {
  const [hex, alpha] = literalParts(literal);
  return STATUS.has(hex) ? withAlpha('--tn-t' + hex, alpha) : null;
}
/** Whether the server recolours a public file: the engine's stylesheets (the launchpad's own are written with tokens). */
export const recolouredFile = name => /\.css$/.test(String(name)) && !/^tenant/.test(String(name));
export const tokenFile = name => String(name) === 'tenant.css';

export function createTenantSkin(config, { publicUrl = '' } = {}) {
  const palette = config.palette, host = (() => { try { return new URL(publicUrl).host; } catch { return ''; } })();
  // Page source is HTML: the name goes in escaped (a name may carry & or '); browser-side copy uses the plain name.
  const copy = createTenantCopy({ name: config.name, host }), pageCopy = createTenantCopy({ name: config.name, host, escape: escapeHtml });
  /** An engine stylesheet in the launchpad's colours: accents by what they colour, then every grey. */
  function recolourStylesheet(text) {
    const value = String(text).replace(DECLARATION, (match, lead, property, colon, body) => {
      const text = textProperty(property);
      return lead + property + colon + body.replace(LITERAL, literal => accentReference(literal, text) || (text && statusReference(literal)) || literal);
    });
    return value.replace(LITERAL, literal => greyReference(literal) || accentReference(literal) || literal);
  }
  /**
   * The tokens for both themes, appended to public/tenant.css by the server. They sit on the root element: the
   * engine's own :root custom properties refer to them, and a reference must resolve where it is declared.
   */
  function tokensCss() {
    const greys = Object.entries(palette.greys), ramp = Object.entries(palette.accents);
    const dark = greys.map(([hex, [value]]) => `${greyToken(hex)}: #${value};`).join(' '), light = greys.map(([hex, [, value]]) => `${greyToken(hex)}: #${value};`).join(' ');
    const accentsDark = ramp.map(([hex, value]) => `${accentToken(hex)}: #${value}; ${accentToken(hex, true)}: #${value};`).join(' ');
    const accentsLight = ramp.map(([hex]) => `${accentToken(hex)}: #${palette.lightSurface[hex]}; ${accentToken(hex, true)}: #${palette.lightText[hex]};`).join(' ');
    const status = Object.entries(palette.statusLightText), statusDark = status.map(([hex]) => `--tn-t${hex}: #${hex.toUpperCase()};`).join(' '), statusLight = status.map(([hex, value]) => `--tn-t${hex}: #${value};`).join(' ');
    const named = `--tn-acc: #${palette.accent}; --tn-acc-strong: #${palette.strong}; --tn-acc-soft: #${palette.soft}; --tn-acc-end: #${palette.end}; --tn-cream: #${palette.cream}; --tn-sel-bg: #${palette.selBg}; --tn-sel-text: #${palette.selText}; --tn-mauve: #${palette.mauve}; --tn-deep: #${palette.deep}; --tn-ink: #${palette.ink};`;
    return `\n/* The launchpad's palette (${palette.label}): named accents, then the ramps dark and light (src/tenant/skin.mjs). */\n:root { ${named} ${accentsDark} ${statusDark} ${dark} }\n:root[data-theme="light"] { ${accentsLight} ${statusLight} ${light} }\n`;
  }
  const ICON = /(<link\b[^>]*\brel="(?:icon|shortcut icon)"[^>]*\bhref=")[^"]*(")/g, TOUCH = /(<link\b[^>]*\brel="apple-touch-icon"[^>]*\bhref=")[^"]*(")/g;
  const THEME = /(<meta\b[^>]*\bname="theme-color"[^>]*\bcontent=")[^"]*(")/g, OG = /(<meta\b[^>]*\bproperty="og:image"[^>]*\bcontent=")[^"]*(")/g;
  const TEXT = />([^<]+)</g, ATTRIBUTE = /\b(aria-label|title|placeholder|alt|content)="([^"]*)"/g;
  const icon = config.logo ? '/brand/icon-64.png' : '/brand/mark.svg', touch = config.logo ? '/brand/icon-180.png' : '/brand/mark.svg', og = config.logo ? '/brand/logo-512.png' : '/brand/mark.svg';
  const background = '#' + palette.greys['0b0b0c'][config.theme === 'light' ? 1 : 0];
  const look = config.look || {};
  const attributes = {
    'data-layout': LAYOUT_BASE[config.layout] || 'terminal', 'data-style': config.layout, 'data-preset': config.preset, 'data-theme-default': config.theme, 'data-brand-name': config.name,
    'data-font': look.font || 'layout', 'data-corners': look.corners || 'layout', 'data-background': look.background || 'plain', 'data-hero': look.hero ? 'on' : 'off',
    'data-features': FEATURE_IDS.filter(id => config.features?.[id]).join(' '),
    'data-venues': config.venues.join(' '), 'data-modes': config.modes.join(' '), 'data-hooks': config.hooks ? 'on' : 'off',
    'data-starts': Object.entries(config.starts || {}).map(([venue, ids]) => venue + ':' + ids.join(',')).join(' '),
    'data-logo': config.logo ? 'on' : 'off', 'data-powered-by': config.poweredBy ? 'on' : 'off', 'data-launcher-name': config.launcher.name, 'data-launcher-url': config.launcher.url,
    'data-link-x': config.links.x, 'data-link-telegram': config.links.telegram, 'data-link-website': config.links.website, 'data-tagline': config.tagline,
  };
  const bodyAttributes = Object.entries(attributes).map(([key, value]) => ` ${key}="${escapeHtml(value)}"`).join('');
  const startsText = venue => { const ids = config.starts?.[venue]?.length ? config.starts[venue] : ['20k']; return ids.length > 1 ? 'a $20,000 or a $4,000 market cap (the creator picks)' : ids[0] === '4k' ? 'a $4,000 market cap' : 'a $20,000 market cap'; };
  const placeholders = { NAME: config.name, HOST: host || config.slug, URL: publicUrl || '', LAUNCHER: config.launcher.name, LAUNCHER_URL: config.launcher.url || '', YEAR: String(new Date().getUTCFullYear()), STARTS_RAYDIUM: startsText('raydium'), STARTS_METEORA: startsText('meteora') };
  const padOn = FEATURE_IDS.some(id => config.features?.[id]);
  const styles = ['tenant.css', ...(LAYOUT_STYLES[config.layout] || []), 'tenant-look.css', ...(padOn ? ['tenant-pad.css'] : [])].map(href => `<link rel="stylesheet" href="/${href}?v=2">`).join('');
  /** An engine page as the launchpad serves it. */
  function rebrandPage(html) {
    let text = String(html).replace(/(<body\b[^>]*\bdata-product=")launchpad(")/, (match, open, close) => open + 'tenant' + close + bodyAttributes);
    // The engine's own token badge never loads on a launchpad.
    text = text.replace(/<a\b[^>]*class="curve-price-badge"[^>]*>[\s\S]*?<\/a>/g, '').replace(/<link\b[^>]*id="curve-price-badge-styles"[^>]*>\s*/g, '');
    text = text.replace(ICON, '$1' + icon + '$2').replace(TOUCH, '$1' + touch + '$2').replace(THEME, '$1' + background + '$2').replace(OG, '$1' + og + '$2');
    text = text.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|[^]+?(?=<script\b|<style\b|$)/g, chunk => /^<(?:script|style)\b/.test(chunk) ? chunk : chunk.replace(TEXT, (match, inner) => '>' + pageCopy.rebrandCopy(inner) + '<').replace(ATTRIBUTE, (match, name, value) => name + '="' + pageCopy.rebrandCopy(value) + '"'));
    // The launchpad's own pages (docs, terms, privacy) carry placeholders.
    text = text.replace(/__(NAME|HOST|URL|LAUNCHER|LAUNCHER_URL|YEAR|STARTS_RAYDIUM|STARTS_METEORA)__/g, (match, key) => escapeHtml(placeholders[key]));
    text = text.replace(/<\/head>/, styles + '</head>');
    text = text.replace(/<\/body>/, '<script type="module" src="/tenant-shell.mjs?v=1"></script>' + (padOn ? '<script type="module" src="/tenant-pad.mjs?v=1"></script>' : '') + '</body>');
    return text;
  }
  return { recolourStylesheet, tokensCss, rebrandPage, rebrandCopy: copy.rebrandCopy, palette };
}
/** The fallback mark (no logo uploaded): the name's first letter on the accent, as SVG. */
export function markSvg(config) {
  const letter = escapeHtml((config.name.match(/[A-Za-z0-9]/) || ['P'])[0].toUpperCase()), palette = config.palette;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#${palette.accent}"/><stop offset="1" stop-color="#${palette.end}"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><text x="32" y="43" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="32" font-weight="700" fill="#${palette.ink}">${letter}</text></svg>`;
}
