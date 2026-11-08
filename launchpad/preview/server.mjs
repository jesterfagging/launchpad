#!/usr/bin/env node
// Launchpad preview harness: serves the real public/ frontend with mocked /api/*.
//   PORT=4173 MOCK_SESSION=anon|user|admin node server.mjs
// Per-request overrides: cookie `mock-session=<mode>` or `?mockSession=<mode>`
// on any page URL (which also sets the cookie for that browser).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SOURCE_ROOT, QUOTE_LOGO_PATHS } from './src-public.mjs';
import { handleApi } from './mocks/api.mjs';
import { avatarPng } from './mocks/util.mjs';

const PORT = Number(process.env.PORT || 4173), PUBLIC = join(SOURCE_ROOT, 'public'), MODES = ['anon', 'user', 'admin'];
// v71.43: like src/account-app.mjs, pages are served as a host without Robinhood Chain (<body data-robinhood="off">) unless
// PREVIEW_ROBINHOOD=1 (the real server reads LAUNCHPAD_ROBINHOOD_ENABLED).
const ROBINHOOD_ON = process.env.PREVIEW_ROBINHOOD === '1', ROBINHOOD_MARK = /(<body\b[^>]*\bdata-robinhood=")on(")/;
// White-label: PREVIEW_PRODUCT=tenant serves every page as a launchpad does (LAUNCHPAD_PRODUCT=tenant with LAUNCHPAD_TENANT_FILE set;
// run with the offline shim: node --import <shim>/register.mjs server.mjs).
const TENANT_ON = process.env.PREVIEW_PRODUCT === 'tenant';
let padFeatures = null;
const tenantModules = TENANT_ON ? { config: await import(pathToFileURL(join(SOURCE_ROOT, 'src/tenant/config.mjs')).href), skin: await import(pathToFileURL(join(SOURCE_ROOT, 'src/tenant/skin.mjs')).href) } : null;

if (tenantModules) {
  const tenant = tenantModules.config.tenantConfig();
  if (tenant && Object.values(tenant.features || {}).some(Boolean)) {
    const { createPadFeatures } = await import(pathToFileURL(join(SOURCE_ROOT, 'src/tenant/pad.mjs')).href);
    const { coins: mockCoins } = await import('./mocks/data.mjs');
    const discovery = { inventory: async () => {}, records: new Map(), catalogue: () => ({ coins: mockCoins().map(c => ({ ...c, image: c.image, valueUsd: undefined, marketCapUsd: c.marketCapUsd ?? c.fdvUsd ?? null, stage: c.stage || (c.curveStatus === 'migrated' ? 'graduated' : 'new') })) }) };
    padFeatures = createPadFeatures({ config: tenant, discovery, dir: join(tenant.dir, 'data'), rpc: async () => { throw new Error('No RPC in the preview harness.'); }, host: 'preview', log: line => console.log(line) });
    padFeatures.start();
    // Preview only: bundle check results for the first coins, so the pages show every state (the harness has no RPC).
    setTimeout(() => { const list = Object.values(padFeatures.state.registry.coins).sort((a, b) => a.no - b.no); list.slice(0, 6).forEach((entry, i) => { padFeatures.state.bundles[entry.mint] = i === 2 ? { status: 'checked', buyers: 9, linked: [{ wallet: 'Bun1dLe5jKq2wQ7hT9xZcV3nM8pR4sD6fG2hJ5kL7mN', reason: 'funded by the creator', holdsPct: 2.4 }, { wallet: 'Fund3rC9vB2nX7mQ4wE8rT1yU6iO5pA3sD9fG2hJ4kL', reason: 'shares a funder with other early buyers', holdsPct: 0.7 }], linkedHoldPct: 3.1, at: Date.now() } : { status: 'checked', buyers: 5 + i, linked: [], linkedHoldPct: 0, at: Date.now() }; }); }, 2500);
  }
}const tenant = tenantModules ? tenantModules.config.tenantConfig() : null;
const tenantSkin = tenant ? tenantModules.skin.createTenantSkin(tenant, { publicUrl: process.env.LAUNCHPAD_PUBLIC_URL || 'https://preview.launchpad.test' }) : null;
const readPage = async name => { const bytes = await readFile(join(PUBLIC, name));
  if (tenantSkin) { if (tenantModules.skin.recolouredFile(name)) return Buffer.from(tenantSkin.recolourStylesheet(bytes.toString('utf8'))); if (tenantModules.skin.tokenFile(name)) return Buffer.from(bytes.toString('utf8') + tenantSkin.tokensCss()); if (!name.endsWith('.html')) return bytes; let page = bytes.toString('utf8'); if (!ROBINHOOD_ON) page = page.replace(ROBINHOOD_MARK, '$1off$2'); return Buffer.from(tenantSkin.rebrandPage(page)); } if (!name.endsWith('.html')) return bytes; let text = bytes.toString('utf8'); if (!ROBINHOOD_ON) text = text.replace(ROBINHOOD_MARK, '$1off$2'); return Buffer.from(text); };
const DEFAULT_MODE = MODES.includes(process.env.MOCK_SESSION) ? process.env.MOCK_SESSION : 'anon';
const LOG_ALL = process.env.PREVIEW_LOG === 'all';
// PREVIEW_ASSETS=prod (default): pages and files go through the real src/static-assets.mjs
// pipeline with the real asset map from src/account-app.mjs - inline import map + its CSP
// hash, ?v=<hash> immutable URLs, modulepreload, Link header, brotli/gzip, ETag/304 - and
// files missing from the real map 404 exactly like production. PREVIEW_ASSETS=raw serves
// public/ files as they are (the pre-v71.12 behaviour; files are re-read per request).
const PROD_ASSETS = (process.env.PREVIEW_ASSETS || 'prod') !== 'raw';
let prod = null;
async function productionSite() {
  if (prod) return prod;
  const text = await readFile(join(SOURCE_ROOT, 'src/account-app.mjs'), 'utf8');
  const start = text.indexOf('const assets = new Map('), end = text.indexOf('const staticSite = createStaticSite(');
  if (start < 0 || end < 0) throw new Error('asset map not found in src/account-app.mjs');
  const block = text.slice(start, end).split('\n').filter(line => !line.startsWith('const errorText')).join('\n');
  const invariant = (ok, message) => { if (!ok) throw new Error(message); };
  const { GOTCHI_THEMES } = await import(pathToFileURL(join(SOURCE_ROOT, 'public/gotchi-catalog.mjs')).href);
  const { assets, binaryAssets, privatePumpModules } = new Function('QUOTE_LOGO_PATHS', 'invariant', 'GOTCHI_THEMES', 'tenantConfig', 'createTenantSkin', 'launchpadEnv', 'createBrandSkin', block + '\nreturn { assets, binaryAssets, privatePumpModules };')(QUOTE_LOGO_PATHS, invariant, GOTCHI_THEMES, () => tenant, () => tenantSkin, name => process.env['LAUNCHPAD_' + name], () => ({ rebrandPage: page => page, platformTokenModule: source => source }));
  const sa = await import(pathToFileURL(join(SOURCE_ROOT, 'src/static-assets.mjs')).href);
  const site = sa.createStaticSite({ assets, read: readPage, exclude: privatePumpModules });
  const csp = /const contentSecurityPolicy = "([^"]+)"/.exec(text)?.[1];
  if (!csp) throw new Error('contentSecurityPolicy not found in src/account-app.mjs');
  prod = { assets, binaryAssets, privatePumpModules, site, sa, csp };
  site.warm?.({ signal: new AbortController().signal }).catch(() => {});
  return prod;
}

// Copied verbatim from src/account-app.mjs (security headers on every response).
const SECURITY_HEADERS = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY='; connect-src 'self'; img-src 'self' data:; frame-src https://dexscreener.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
// HTML routes from the `assets` map in src/account-app.mjs (launchpad mode).
const PAGES = { '/': 'explore.html', '/explore': 'explore.html', '/coin': 'coin.html', '/gotchi': 'gotchi.html', '/analytics': 'analytics.html', '/agents': 'agents.html', '/docs': 'docs.html', '/terms': 'terms.html', '/privacy': 'privacy.html', '/launchpad': 'launchpad.html', '/wallet-account': 'wallet-account.html', '/profile': 'wallet-account.html', '/creator': 'creator.html', '/launched-tokens': 'launched-tokens.html', '/admin': 'admin.html' };
// Toolkit-only pages redirect to / when ENABLE_TOOLKIT is off (the release default).
const PRIVATE_MODULES = new Set(['/admin-damm-pump-test-ui.mjs', '/admin-damm-pump-ui.mjs', '/admin-meteora-ui.mjs', '/admin-pump-public-ui.mjs', '/admin-pump-test-ui.mjs', '/pump-launch-test-ui.mjs', '/admin-pump-deployment-ui.mjs']);
const TOOLKIT_PAGES =['/trade', '/robinhood', '/sessions', '/funding', '/tutorial', '/connections'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };

// The real server only serves files it lists explicitly. Warn when the page
// requests a public file the real asset map does not mention (it would 404).
let appSource = { at: 0, text: '' };
async function inRealAssetMap(rel) {
  try { const file = join(SOURCE_ROOT, 'src/account-app.mjs'), s = await stat(file); if (s.mtimeMs !== appSource.at) appSource = { at: s.mtimeMs, text: await readFile(file, 'utf8') }; } catch { return true; }
  if (Object.values(QUOTE_LOGO_PATHS).includes('/' + rel)) return true;
  return appSource.text.includes(`'${rel}'`) || appSource.text.includes(`'/${rel}'`) || appSource.text.includes(`'${basename(rel)}'`) || appSource.text.includes(`'${basename(rel, extname(rel))}'`);
}

const cookie = (req, name) => String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1);
async function readBody(req) { const chunks = []; for await (const c of req) chunks.push(c); const text = Buffer.concat(chunks).toString(); try { return text ? JSON.parse(text) : undefined; } catch { return text; } }

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://preview.local'), path = url.pathname;
  const queryMode = url.searchParams.get('mockSession');
  if (MODES.includes(queryMode)) res.setHeader('set-cookie', `mock-session=${queryMode}; Path=/; SameSite=Lax`);
  const mode = MODES.includes(queryMode) ? queryMode : MODES.includes(cookie(req, 'mock-session')) ? cookie(req, 'mock-session') : DEFAULT_MODE;
  const json = (code, value) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  try {
    // A launchpad's own features (src/tenant/pad.mjs) on the mock coins: the real module, with discovery from the fixtures.
    if (padFeatures && (path.startsWith('/api/pad/') || path.startsWith('/api/admin/pad/') || path.startsWith('/pad-media/'))) {
      if (path.startsWith('/pad-media/')) { const bytes = await padFeatures.mediaFile(path.split('/').at(-1)); if (!bytes) return json(404, { error: 'Not found.' }); res.writeHead(200, { 'content-type': path.endsWith('.png') ? 'image/png' : 'image/jpeg' }); return res.end(bytes); }
      const raw = req.method === 'POST' ? await readBody(req) : undefined, readJson = async () => typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
      try { const [status, value] = path.startsWith('/api/admin/') ? await padFeatures.handleAdmin(req.method, path, readJson) : await padFeatures.handlePublic(req.method, path, url.searchParams, readJson, { requestHost: req.headers.host }); return json(status, value); }
      catch (error) { return json(error.statusCode || 500, { error: error.message }); }
    }
    if (path.startsWith('/api/')) {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const result = handleApi({ method: req.method, path, params: url.searchParams, mode, body });
      if (!result) { console.log(`[UNMOCKED] ${req.method} ${path}${url.search} (session=${mode})`); return json(501, { error: 'Not mocked in the preview harness: ' + req.method + ' ' + path }); }
      if (LOG_ALL || result.status >= 500) console.log(`[api ${result.status}] ${req.method} ${path}${url.search} (session=${mode})`);
      if (result.binary) { res.writeHead(result.status, { 'content-type': result.type, 'content-length': result.binary.length }); return res.end(result.binary); }
      if (result.sse) {
        // Mirrors the agent activity stream: an initial `browser` event, then keep-alive comments.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 15000\n\n'); res.write('event: browser\ndata: ' + JSON.stringify(result.sse.browser) + '\n\n');
        const beat = setInterval(() => { if (res.writableEnded) return clearInterval(beat); res.write(': keep-alive\n\n'); }, 15000);
        req.on('close', () => clearInterval(beat)); return;
      }
      return json(result.status, result.body);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'Method not allowed.' });
    if (path === '/healthz') return json(200, { ok: true, preview: true, session: mode });
    // Token and avatar images: deterministic generated PNGs for any stored id.
    if (/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(path)) { const png = avatarPng(path); res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length }); return res.end(req.method === 'HEAD' ? undefined : png); }
    // v71.40: Robinhood pair badges served by the host from its logo cache (a generated mark per address here).
    if (/^\/robinhood-pairs\/logo\/0x[0-9a-fA-F]{40}$/.test(path)) { const png = avatarPng(path.toLowerCase()); res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'public, max-age=86400' }); return res.end(req.method === 'HEAD' ? undefined : png); }
    if (TOOLKIT_PAGES.includes(path)) { res.writeHead(303, { location: '/' }); return res.end(); }
    const userPage = /^\/user\/([a-z0-9_][a-z0-9_-]{2,31})\/?$/i.exec(path);
    if (path === '/creator' || userPage) {
      const username = (userPage?.[1] || url.searchParams.get('username') || '').trim().toLowerCase();
      if (/^[a-z0-9_][a-z0-9_-]{2,31}$/.test(username) && path !== '/user/' + encodeURIComponent(username)) { res.writeHead(308, { location: '/user/' + encodeURIComponent(username) }); return res.end(); }
    }
    if (path.startsWith('/user/') && !userPage) return json(404, { error: 'Creator not found.' });
    // A launchpad's brand art (src/account-app.mjs /brand/*): its PNGs, or the generated mark.
    if (tenant && (path.startsWith('/brand/') || ['/brand-icon.svg', '/brand-logo.svg', '/brand-icon.png', '/brand-avatar.png', '/brand-avatar.jpg'].includes(path))) {
      const name = path.startsWith('/brand/') ? path.slice(7) : 'icon-180.png', file = tenantModules.config.brandFile(name);
      if (name === 'mark.svg' || !file) { const svg = Buffer.from(tenantModules.skin.markSvg(tenant)); res.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': svg.length }); return res.end(svg); }
      const png = await readFile(file); res.writeHead(200, { 'content-type': name.endsWith('.jpg') ? 'image/jpeg' : 'image/png', 'content-length': png.length }); return res.end(png);
    }
    if (tenant && ['/analytics', '/tutorial', '/robinhood', ...(tenant.modes.includes('gotchi') ? [] : ['/gotchi']), ...(tenant.modes.includes('agent') ? [] : ['/agents'])].includes(path)) return json(404, { error: 'Not found.' });
    // src/account-app.mjs privatePumpModules: only an MFA admin owner session may load these.
    if (PRIVATE_MODULES.has(path) && mode !== 'admin') return json(mode === 'anon' ? 401 : 403, mode === 'anon' ? { error: 'Sign in to continue.' } : { error: 'Administrator access required.' });
    if (PROD_ASSETS) {
      // Mirrors the static branch of src/account-app.mjs.
      const { assets, binaryAssets, site, sa, csp } = await productionSite();
      const pageAsset = userPage ? assets.get('/creator') : assets.get(path);
      if (!pageAsset) { console.log(`[404 not in real asset map] ${path}`); return json(404, { error: 'Not found.' }); }
      if (!(req.method === 'GET' || req.method === 'HEAD' && binaryAssets.has(path))) return json(405, { error: 'Method not allowed.' });
      const [name, type] = pageAsset;
      const item = await site.asset(name), value = await sa.staticAssetRepresentation(item, type, req.headers['accept-encoding']);
      if (sa.staticAssetVaries(type)) res.setHeader('vary', 'Accept-Encoding');
      if (!value) { res.writeHead(406, { 'content-length': 0 }); return res.end(); }
      res.setHeader('content-security-policy', item.scriptHashes?.length ? sa.withScriptHashes(csp, item.scriptHashes) : csp);
      if (item.linkHeader) res.setHeader('link', item.linkHeader);
      res.setHeader('etag', value.etag); res.setHeader('cache-control', sa.staticCacheControl(item, type, url.searchParams.get('v')));
      if (value.encoding) res.setHeader('content-encoding', value.encoding);
      if (sa.staticAssetMatches(req.headers['if-none-match'], value.etag)) { res.writeHead(304); return res.end(); }
      res.writeHead(200, { 'content-type': type.startsWith('text/') ? `${type}; charset=utf-8` : type, 'content-length': value.bytes.length });
      return res.end(req.method === 'HEAD' ? undefined : value.bytes);
    }
    let rel = userPage ? 'creator.html' : PAGES[path];
    if (!rel) {
      rel = normalize(decodeURIComponent(path)).replace(/^\/+/, '');
      if (rel.startsWith('..') || rel.includes('\0') || rel.endsWith('.html')) return json(404, { error: 'Not found.' });
      if (!(await inRealAssetMap(rel))) console.log(`[NOT-IN-REAL-ASSET-MAP] ${path} — src/account-app.mjs would return 404 for this file`);
    }
    let bytes; try { bytes = await readPage(rel); } catch { console.log(`[404] ${path}`); return json(404, { error: 'Not found.' }); }
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream', 'content-length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch (error) { console.error('[preview error]', req.method, path, error); if (!res.headersSent) json(500, { error: 'Preview harness error: ' + error.message }); }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Launchpad preview on http://127.0.0.1:${PORT}  (source: ${SOURCE_ROOT}, default session: ${DEFAULT_MODE}, assets: ${PROD_ASSETS ? 'production pipeline' : 'raw files'})`));
