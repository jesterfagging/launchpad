import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import {
  createStaticAsset, createStaticSite, staticCacheControl, withScriptHashes, inlineScriptHash, staticImportSpecifiers,
  resolveStaticPath, staticModuleGraph, absolutePathLiterals, literalSpellings, rewriteCssUrls, preloadLinks, preloadLinkHeader, staticAssetVaries,
  STATIC_IMMUTABLE, STATIC_REVALIDATE, STATIC_MEDIA,
} from '../src/static-assets.mjs';

const POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY='; connect-src 'self'; img-src 'self' data:; frame-src https://dexscreener.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const importMapOf = html => { const match = /<script type="importmap">([^<]*)<\/script>/.exec(html); return match && { text: match[1], map: JSON.parse(match[1]).imports }; };
const attributes = (html, pattern) => [...html.matchAll(pattern)].map(match => match[1]);

function fixtureSite(overrides = {}) {
  const files = {
    'page.html': '<!doctype html><html><head><meta charset="utf-8"><title>T</title><link rel="icon" href="/icon.svg?v=53"><link rel="stylesheet" href="/theme.css?v=7"><link id="pinned" rel="stylesheet" href="/pinned.css?v=52"><link id="stale" rel="stylesheet" href="/stale.css?v=1"><link rel="stylesheet" href="/ambiguous.css?v=1"><link rel="preload" href="/fonts/f.woff2?v=4.1" as="font" type="font/woff2" crossorigin><link rel="preload" href="/logo.png" as="image"><script type="module" src="/page.js"></script><script type="module" src="/motion.mjs?v=1"></script></head><body><a href="/theme.css">raw link</a><a href="/other">page</a><img src="/logo.png"><img src="/icon.svg?v=53"><img src="/logo.png?x=1"><script type="module" src="/private.mjs"></script></body></html>',
    'other.html': '<!doctype html><html><head><script type="importmap">{"imports":{}}</script><script type="module" src="/page.js"></script></head><body></body></html>',
    'theme.css': "@font-face{font-family:F;src:url('/fonts/f.woff2?v=4.1') format('woff2')}.a{background:url(/logo.png)}.b{background:url(\"/icon.svg?v=53\")}.c{background:url(data:image/png;base64,AAAA)}.d{filter:url(#x)}@import url('/pinned.css');",
    'pinned.css': '.p{color:red}', 'stale.css': '.s{color:blue}', 'ambiguous.css': '.m{color:green}',
    'page.js': "import { a } from './lib/a.mjs';\nimport {\n  b,\n  c as d\n} from \"/lib/b.mjs\";\nimport './side.mjs';\nexport * from './lib/c.mjs';\nconst later = () => import('./lazy.mjs'); console.log(import.meta.url, a, d);",
    'lib/a.mjs': "import { b } from './b.mjs'; export const a = b + '/icon.svg?v=53';",
    'lib/b.mjs': "import '../page.js'; export const b = 1, c = 2;",
    'lib/c.mjs': 'export const c = 3;',
    'side.mjs': "const s = document.createElement('link'); s.href = '/pinned.css?v=52'; if (!document.getElementById('stale')) s.href = '/stale.css?v=2'; const m = ['/ambiguous.css?v=2', '/ambiguous.css?v=3']; document.querySelector('link[href*=\"/theme.css\"]');",
    'lazy.mjs': "import { b } from './lib/b.mjs'; export default b;",
    'motion.mjs': 'export {};',
    'private.mjs': "import { a } from './lib/a.mjs'; export default a;",
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'logo.png': 'PNGDATA', 'fonts/f.woff2': 'wOF2DATA',
    ...overrides,
  };
  const assets = new Map([['/', ['page.html', 'text/html']], ['/other', ['other.html', 'text/html']], ['/theme.css', ['theme.css', 'text/css']], ['/pinned.css', ['pinned.css', 'text/css']], ['/stale.css', ['stale.css', 'text/css']], ['/ambiguous.css', ['ambiguous.css', 'text/css']],
    ...['page.js', 'lib/a.mjs', 'lib/b.mjs', 'lib/c.mjs', 'side.mjs', 'lazy.mjs', 'motion.mjs', 'private.mjs'].map(name => ['/' + name, [name, 'text/javascript']]),
    ['/icon.svg', ['icon.svg', 'image/svg+xml']], ['/logo.png', ['logo.png', 'image/png']], ['/fonts/f.woff2', ['fonts/f.woff2', 'font/woff2']]]);
  const reads = [];
  const site = createStaticSite({ assets, exclude: new Set(['/private.mjs']), read: async name => { reads.push(name); if (!(name in files)) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return Buffer.from(files[name]); } });
  return { site, files, reads };
}
const versionOf = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

test('content versions are sha256 prefixes and only an exact non-HTML match is immutable', () => {
  const asset = createStaticAsset(Buffer.from('body{}'));
  assert.equal(asset.version, versionOf('body{}')); assert.equal(asset.etag, '"' + createHash('sha256').update('body{}').digest('hex') + '"');
  assert.equal(staticCacheControl(asset, 'text/css', asset.version), STATIC_IMMUTABLE);
  assert.equal(STATIC_IMMUTABLE, 'public, max-age=31536000, immutable'); assert.equal(STATIC_REVALIDATE, 'public, max-age=0, must-revalidate');
  for (const version of [null, '', '53', asset.version.slice(0, 15), asset.version + '0', asset.version.toUpperCase()]) assert.equal(staticCacheControl(asset, 'text/css', version), STATIC_REVALIDATE, String(version));
  assert.equal(staticCacheControl(asset, 'text/html', asset.version), STATIC_REVALIDATE);
});

test('release images and fonts without their content hash are reused for a day; text and pages always revalidate', () => {
  const asset = createStaticAsset(Buffer.from('PNGDATA'));
  assert.equal(STATIC_MEDIA, 'public, max-age=86400, stale-while-revalidate=604800');
  for (const type of ['image/png', 'image/webp', 'image/jpeg', 'image/svg+xml', 'image/x-icon', 'font/woff2']) {
    assert.equal(staticCacheControl(asset, type, asset.version), STATIC_IMMUTABLE, type);
    for (const version of [null, undefined, '', '53', 'ribbon-53', asset.version.slice(0, 15)]) assert.equal(staticCacheControl(asset, type, version), STATIC_MEDIA, `${type} ?v=${version}`);
  }
  for (const type of ['text/css', 'text/javascript', 'text/plain', 'application/json']) for (const version of [null, '53']) assert.equal(staticCacheControl(asset, type, version), STATIC_REVALIDATE, type);
  for (const version of [null, '53', asset.version]) assert.equal(staticCacheControl(asset, 'text/html', version), STATIC_REVALIDATE);
});

test('script hashes extend script-src only and leave every other directive byte-identical', () => {
  const hash = inlineScriptHash('{"imports":{}}');
  assert.equal(hash, "'sha256-" + createHash('sha256').update('{"imports":{}}').digest('base64') + "'");
  const next = withScriptHashes(POLICY, [hash]);
  assert.equal(next, POLICY.replace("script-src 'self';", `script-src 'self' ${hash};`));
  assert.deepEqual(next.split('; ').filter(part => !part.startsWith('script-src')), POLICY.split('; ').filter(part => !part.startsWith('script-src')));
  assert.equal(withScriptHashes(POLICY, []), POLICY); assert.equal(withScriptHashes("default-src 'self'", [hash]), "default-src 'self'");
});

test('static import parsing covers every static form and ignores dynamic imports', () => {
  const { files } = fixtureSite();
  assert.deepEqual(staticImportSpecifiers(files['page.js']), ['./lib/a.mjs', '/lib/b.mjs', './side.mjs', './lib/c.mjs']);
  assert.deepEqual(staticImportSpecifiers("import x, { y } from './x.mjs'; import * as ns from \"./ns.mjs\"; export { z as w } from './z.mjs'; export * as all from './all.mjs'; const s = 'not import'; export const q = 'x';"), ['./x.mjs', './ns.mjs', './z.mjs', './all.mjs']);
  assert.equal(resolveStaticPath('./lib/a.mjs', '/page.js'), '/lib/a.mjs'); assert.equal(resolveStaticPath('../page.js', '/lib/b.mjs'), '/page.js');
  assert.equal(resolveStaticPath('/vendor/x.mjs', '/a/b.mjs'), '/vendor/x.mjs');
  for (const spec of ['bare', '//cdn.example/x.mjs', 'https://cdn.example/x.mjs', './x.mjs?v=2', './x.mjs#h', 'data:text/javascript,1']) assert.equal(resolveStaticPath(spec, '/page.js'), null, spec);
  const graph = { '/e': ['/a', '/b'], '/a': ['/c', '/e'], '/b': ['/c'], '/c': ['/a'] };
  assert.deepEqual(staticModuleGraph(['/e'], path => graph[path]), ['/a', '/b', '/c']);
  assert.deepEqual(absolutePathLiterals("x='/a.css?v=1';y=\"/b.png\";z=`/c.svg`;w='//cdn/x';v='rel.css';u=`/t${1}`"), ['/a.css?v=1', '/b.png', '/c.svg']);
  assert.deepEqual([...literalSpellings(['/a.css?v=1', '/a.css', '/b.png', '/b.png?x=1', '/c.svg#f', '/api/x'])].map(([path, set]) => [path, [...set]]), [['/a.css', ['/a.css?v=1', '/a.css']], ['/b.png', ['/b.png']], ['/api/x', ['/api/x']]]);
  assert.equal(rewriteCssUrls("a{b:url( '/x.png' )}c{d:url(/y.png)}", value => value + '?v=1'), "a{b:url('/x.png?v=1')}c{d:url(/y.png?v=1)}");
  const page = '<head><link rel="preload" href="/fonts/f.woff2?v=1" as="font" type="font/woff2" crossorigin><link rel="preload" href="/x.png" as="image"><link rel="preload" href="https://cdn.example/f.woff2" as="font" crossorigin><link rel="preload" as="font" href="/g.woff2"></head>';
  assert.deepEqual(preloadLinks(page), [{ href: '/fonts/f.woff2?v=1', as: 'font', type: 'font/woff2', crossorigin: true }, { href: '/g.woff2', as: 'font', type: null, crossorigin: false }]);
  assert.equal(preloadLinkHeader(preloadLinks(page)), '</fonts/f.woff2?v=1>; rel=preload; as=font; type=font/woff2; crossorigin, </g.woff2>; rel=preload; as=font');
  assert.equal(preloadLinkHeader([{ href: '/bad"\r\nx', as: 'font' }]), '', 'unsafe header characters are never emitted');
  assert.equal(preloadLinkHeader([]), '');
  for (const [type, varies] of [['text/html', true], ['text/css', true], ['text/javascript', true], ['image/svg+xml', true], ['font/woff2', false], ['image/png', false], ['image/x-icon', false]]) assert.equal(staticAssetVaries(type), varies, type);
});

test('pages get one import map and byte-identical versioned URLs for scripts, preloads and imports', async () => {
  const { site, files } = fixtureSite(), page = await site.asset('page.html'), html = page.bytes.toString();
  const { text, map } = importMapOf(html);
  assert.deepEqual(page.scriptHashes, [inlineScriptHash(text)]);
  assert.match(html, /^<!doctype html><html><head><meta charset="utf-8"><script type="importmap">/, 'import map is the first script, after the charset');
  assert.equal(html.indexOf('<script type="importmap">'), html.indexOf('<script'));
  // Every public module is mapped to its own content version; the private module is not.
  assert.deepEqual(Object.keys(map), ['/lazy.mjs', '/lib/a.mjs', '/lib/b.mjs', '/lib/c.mjs', '/motion.mjs', '/page.js', '/side.mjs']);
  for (const [path, url] of Object.entries(map)) assert.equal(url, path + '?v=' + versionOf(files[path.slice(1)]));
  // Entry scripts use the map's exact URLs; the private module script is untouched.
  assert.deepEqual(attributes(html, /<script type="module" src="([^"]+)"/g), [map['/page.js'], map['/motion.mjs'], '/private.mjs']);
  // Static graph (BFS, without entries or dynamic imports) is preloaded with the same URLs.
  const preloads = attributes(html, /<link rel="modulepreload" href="([^"]+)">/g);
  assert.deepEqual(preloads, ['/lib/a.mjs', '/lib/b.mjs', '/side.mjs', '/lib/c.mjs'].map(path => map[path]));
  assert(html.indexOf('modulepreload') < html.indexOf('<title>'));
});

test('styles, fonts and images are versioned unless a script builds the same URL', async () => {
  const { site } = fixtureSite(), html = (await site.asset('page.html')).bytes.toString(), css = (await site.asset('theme.css')).bytes.toString();
  const font = '/fonts/f.woff2?v=' + versionOf('wOF2DATA'), logo = '/logo.png?v=' + versionOf('PNGDATA');
  assert.match(html, new RegExp(`<link rel="preload" href="${font.replace(/[?.]/g, '\\$&')}" as="font" type="font/woff2" crossorigin>`));
  assert.match(css, new RegExp(`src:url\\('${font.replace(/[?.]/g, '\\$&')}'\\)`), 'font preload and @font-face name the identical URL');
  assert.match(css, new RegExp(`url\\(${logo.replace(/[?.]/g, '\\$&')}\\)`));
  assert.match(html, new RegExp(`<link rel="stylesheet" href="/theme\\.css\\?v=${versionOf(css)}">`), 'CSS is hashed after its own rewrite');
  // JS also uses '/icon.svg?v=53' and '/pinned.css?v=52': those spellings never change.
  assert.equal((html.match(/\/icon\.svg\?v=53/g) || []).length, 2); assert.match(css, /url\("\/icon\.svg\?v=53"\)/);
  assert.match(html, /<link id="pinned" rel="stylesheet" href="\/pinned\.css\?v=52">/);
  // A page whose manual spelling lags the script's adopts the script's one URL; two script spellings leave it alone.
  assert.match(html, /<link id="stale" rel="stylesheet" href="\/stale\.css\?v=2">/); assert.doesNotMatch(html, /stale\.css\?v=1/);
  assert.match(html, /<link rel="stylesheet" href="\/ambiguous\.css\?v=1">/);
  // A bare path inside a script (here a selector fragment) does not pin: theme.css above is content-versioned.
  // The font preload is also announced as a Link header with the identical URL; images are not.
  assert.equal((await site.asset('page.html')).linkHeader, `<${font}>; rel=preload; as=font; type=font/woff2; crossorigin`);
  assert.match(html, new RegExp(`<link rel="preload" href="${logo.replace(/[?.]/g, '\\$&')}" as="image">`));
  assert.equal((await site.asset('other.html')).linkHeader, '');
  // Links, foreign queries, data URIs, fragments and CSS imports stay as written.
  assert.match(html, /<a href="\/theme\.css">raw link<\/a><a href="\/other">page<\/a>/); assert.match(html, /<img src="\/logo\.png\?x=1">/);
  assert.match(html, new RegExp(`<img src="${logo.replace(/[?.]/g, '\\$&')}">`));
  assert.match(css, /url\(data:image\/png;base64,AAAA\)/); assert.match(css, /url\(#x\)/); assert.match(css, /@import url\('\/pinned\.css'\)/);
});

test('content addressing propagates and pages with their own import map are served as written', async () => {
  const before = await fixtureSite().site.asset('page.html'), after = await fixtureSite({ 'fonts/f.woff2': 'wOF2CHANGED' }).site.asset('page.html');
  assert.notEqual(before.etag, after.etag, 'a font change re-versions theme.css and therefore the page');
  assert.equal(importMapOf(before.bytes.toString()).text, importMapOf(after.bytes.toString()).text);
  const changedModule = await fixtureSite({ 'lib/c.mjs': 'export const c = 4;' }).site.asset('page.html');
  assert.notEqual(importMapOf(changedModule.bytes.toString()).text, importMapOf(before.bytes.toString()).text);
  const { site, files } = fixtureSite(), other = await site.asset('other.html');
  assert.equal(other.bytes.toString(), files['other.html']); assert.deepEqual(other.scriptHashes, []);
  assert.equal((await site.asset('lib/a.mjs')).bytes.toString(), files['lib/a.mjs'], 'modules are served byte-for-byte');
});

test('an unreadable module is left unversioned everywhere instead of failing the page', async () => {
  const { site } = fixtureSite({ 'lib/c.mjs': undefined });
  const html = (await site.asset('page.html')).bytes.toString(), { map } = importMapOf(html);
  assert.equal(map['/lib/c.mjs'], undefined); assert.doesNotMatch(html, /lib\/c\.mjs/);
});

test('warming builds pages and compressed variants once and can be aborted', async () => {
  const { site } = fixtureSite({ 'page.js': fixtureSite().files['page.js'] + '\n// ' + 'x'.repeat(4000) });
  await site.warm();
  const page = await site.asset('page.js'); assert.deepEqual([...page.variants.keys()].sort(), ['br', 'gzip']);
  const controller = new AbortController(); controller.abort();
  const aborted = fixtureSite(); await aborted.site.warm({ signal: controller.signal });
  assert.equal((await aborted.site.asset('page.js')).variants.size, 0);
});

// The real release: every page the server builds must keep router templates,
// script/preload/import-map URLs and pinned spellings consistent.
test('real public pages: one URL per module and router templates still match', async () => {
  const root = new URL('../public/', import.meta.url), app = await readFile(new URL('../src/account-app.mjs', import.meta.url), 'utf8');
  const privateModules = new Set(JSON.parse(/privatePumpModules = new Set\((\[[^\]]+\])\)/.exec(app)[1].replace(/'/g, '"')));
  const names = (await readdir(root)).filter(name => /\.(m?js|css|html)$/.test(name));
  const vendor = (await readdir(new URL('vendor/', root))).filter(name => name.endsWith('.mjs')).map(name => 'vendor/' + name);
  const assets = new Map([...names, ...vendor].map(name => ['/' + name, [name, name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'text/javascript']]));
  assets.set('/fonts/InterVariable.woff2', ['fonts/InterVariable.woff2', 'font/woff2']);
  for (const name of ['BricolageGrotesque-Bold.woff', 'BricolageGrotesque-Regular.woff', 'GeistMono-Regular.woff', 'GeistMono-Bold.woff']) assets.set('/fonts/' + name, ['fonts/' + name, 'font/woff']);
  for (const name of ['brand-icon.svg', 'brand-icon.png', 'favicon.ico', 'apple-touch-icon.png', 'solana-chain.svg', 'robinhood-chain.svg', 'pair-origin-pump.png', 'pair-origin-stonk.png']) assets.set('/' + name, [name, name.endsWith('.svg') ? 'image/svg+xml' : 'image/png']);
  const site = createStaticSite({ assets, read: name => readFile(new URL(name, root)), exclude: privateModules });
  const { publicRoute } = await import('../public/navigation.mjs');
  const literals = new Set(); for (const name of [...names, ...vendor].filter(name => /\.m?js$/.test(name))) for (const value of absolutePathLiterals(await readFile(new URL(name, root), 'utf8'))) literals.add(value);
  const spellings = literalSpellings(literals);
  let checked = 0;
  for (const name of names.filter(name => name.endsWith('.html'))) {
    const source = await readFile(new URL(name, root), 'utf8'), html = (await site.asset(name)).bytes.toString(), parsed = importMapOf(html);
    if (!/<head\b/i.test(source)) continue;
    assert(parsed, name + ' has an import map');
    const { map } = parsed, urls = new Set(Object.values(map));
    for (const path of privateModules) assert.equal(map[path], undefined, name + ' must not map ' + path);
    for (const src of attributes(html, /<script[^>]*\bsrc="([^"]+)"/g)) {
      const path = src.split('?')[0];
      if (map[path]) assert.equal(src, map[path], `${name}: ${src} must equal its import-map target`);
    }
    for (const href of attributes(html, /<link rel="modulepreload" href="([^"]+)">/g)) assert(urls.has(href), `${name}: preload ${href} must be an import-map target`);
    // Every versioned non-module URL is a hash of the current file; pinned JS spellings never change.
    for (const url of attributes(html, /(?:href|src)="(\/[^"]+\?v=[0-9a-f]{16})"/g)) assert(urls.has(url) || assets.has(url.split('?')[0]), url);
    for (const value of attributes(source, /<(?:link|img)\b[^>]*(?:href|src)="(\/[^"]+)"/g)) {
      if (literals.has(value)) { assert(html.includes(`"${value}"`), `${name}: pinned ${value} must be kept`); continue; }
      // A manual `?v=` that lags the one explicit spelling in page scripts adopts it (explore-search.css?v=49 → ?v=50).
      const explicit = [...spellings.get(value.split('?')[0]) || []].filter(spelling => spelling.includes('?'));
      if (explicit.length === 1 && value.includes('?v=')) assert(html.includes(`"${explicit[0]}"`) && !html.includes(`"${value}"`), `${name}: ${value} must adopt ${explicit[0]}`);
    }
    // The shared theme is named by scripts only as a selector fragment and stays content-versioned.
    if (source.includes('/curve-theme.css')) assert.match(html, /href="\/curve-theme\.css\?v=[0-9a-f]{16}"/, name + ': curve-theme.css is content-versioned');
    // v71.43: the three preloaded faces (Inter, the display face, the mono face), content-versioned, in page order.
    const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+)" as="font" type="([^"]+)" crossorigin>/g)].map(m => `<${m[1]}>; rel=preload; as=font; type=${m[2]}; crossorigin`);
    for (const [, href] of html.matchAll(/<link rel="preload" href="([^"]+)" as="font"/g)) assert.match(href, /\?v=[0-9a-f]{16}$/, name + ': font preload ' + href + ' is content-versioned');
    assert.equal((await site.asset(name)).linkHeader, preloads.join(', '), name + ' Link header');
    // The client router accepts the rewritten template for its page.
    const route = publicRoute(name === 'explore.html' ? '/' : '/' + name.replace(/\.html$/, ''));
    if (route && route.template !== '/' || name === 'explore.html') {
      assert(attributes(html, /<script type="module" src="([^"]+)"/g).some(src => src.startsWith(route.module)), `${name}: router needs script[src^="${route.module}"]`);
    }
    checked++;
  }
  assert(checked >= 10, 'checked the public page shells');
  // The theme's font face and the pages' font preload name the same URL.
  const theme = (await site.asset('curve-theme.css')).bytes.toString(), explore = (await site.asset('explore.html')).bytes.toString();
  const font = /url\('(\/fonts\/InterVariable\.woff2[^']*)'\)/.exec(theme)[1];
  assert.match(font, /\?v=[0-9a-f]{16}$/); assert(explore.includes(`<link rel="preload" href="${font}"`), 'font preload matches @font-face');
});
