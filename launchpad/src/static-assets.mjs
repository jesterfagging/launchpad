import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants } from 'node:zlib';

const brotli = promisify(brotliCompress), compressGzip = promisify(gzip);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = bytes => '"' + sha256(bytes) + '"';
const compressible = type => type.startsWith('text/') || ['application/javascript','application/json','image/svg+xml'].includes(type);
// Only representations that are negotiated by Accept-Encoding vary on it;
// fonts and raster images are one body for every client.
export const staticAssetVaries = type => compressible(type);
const qualities = header => {
  const result = new Map();
  if (typeof header !== 'string') return result;
  for (const part of header.slice(0, 8192).split(',')) {
    const match = /^\s*([a-z0-9!#$%&'*+.^_`|~-]+)\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/i.exec(part);
    if (!match) continue;
    const coding = match[1].toLowerCase(), quality = match[2] === undefined ? 1 : Number(match[2]);
    result.set(coding, Math.min(result.get(coding) ?? 1, quality));
  }
  return result;
};
const identityQuality = values => values.get('identity') ?? (values.get('*') === 0 ? 0 : 1);

// `version` is the content address used in `?v=` URLs. HTML and CSS assets are
// hashed after their references are rewritten, so a dependency change also
// changes every file that names it.
export function createStaticAsset(bytes, extra = {}) {
  const hash = sha256(bytes);
  return { ...extra, bytes, etag: '"' + hash + '"', version: hash.slice(0, 16), variants: new Map() };
}

// Static text is compressed once per process. The startup warm-up spends the
// highest quality on it (Brotli 11 is about 12% smaller than quality 4 on this
// site's scripts and styles); a request that arrives before its file has been
// warmed gets a quick body at once, which the warm-up then upgrades in place.
const COMPRESSION_LEVELS = { br: { fast: 5, best: 11 }, gzip: { fast: 6, best: 9 } };
const compressBytes = (bytes, encoding, level) => encoding === 'br'
  ? brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: level, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } })
  : compressGzip(bytes, { level });

// One entry per encoding: { level, task }, where `task` resolves to the body
// every request shares. An upgrade keeps serving the current body until the
// better one is ready and leaves it in place if the upgrade fails.
function encodedVariant(asset, encoding, best = false) {
  const level = COMPRESSION_LEVELS[encoding][best ? 'best' : 'fast'], entry = asset.variants.get(encoding);
  if (!entry) {
    const created = { level, task: null };
    created.task = compressBytes(asset.bytes, encoding, level).then(bytes => ({ bytes, etag: digest(bytes), encoding }));
    created.task.catch(() => { if (asset.variants.get(encoding) === created) asset.variants.delete(encoding); });
    asset.variants.set(encoding, created);
    return created.task;
  }
  if (entry.level >= level) return entry.task;
  return entry.upgrade ||= compressBytes(asset.bytes, encoding, level).then(bytes => {
    const result = { bytes, etag: digest(bytes), encoding };
    if (asset.variants.get(encoding) === entry) asset.variants.set(encoding, { level, task: Promise.resolve(result) });
    return result;
  }, () => { entry.upgrade = null; return entry.task; });
}

// Compress only public, static representations. Each encoding is built once
// asynchronously and shared by concurrent requests; no per-visitor CPU work.
export async function staticAssetRepresentation(asset, type, acceptEncoding) {
  const values = qualities(acceptEncoding), identity = identityQuality(values);
  const plain = { bytes: asset.bytes, etag: asset.etag, encoding: null };
  if (!compressible(type)) return identity > 0 ? plain : null;
  if (!acceptEncoding || asset.bytes.length < 1024 && identity > 0) return plain;
  const candidates = ['br','gzip'].map(encoding => ({ encoding, quality: values.get(encoding) ?? values.get('*') ?? 0 }))
    .filter(row => row.quality > 0).sort((a,b) => b.quality - a.quality);
  const preferred = candidates[0];
  if (!preferred) return identity > 0 ? plain : null;
  if (values.has('identity') && identity > preferred.quality) return plain;
  try {
    const result = await encodedVariant(asset, preferred.encoding);
    return result.bytes.length >= asset.bytes.length && identity > 0 ? plain : result;
  } catch (error) { if (identity > 0) return plain; throw error; }
}

// Builds (or upgrades to) the best-compressed body of a text asset; used by the warm-up.
export function warmStaticAssetEncoding(asset, type, encoding) {
  if (!compressible(type) || asset.bytes.length < 1024 || !Object.hasOwn(COMPRESSION_LEVELS, encoding)) return Promise.resolve(null);
  return encodedVariant(asset, encoding, true);
}

export function staticAssetMatches(ifNoneMatch, etag) {
  return typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some(value => {
    const tag = value.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  });
}

// ---------------------------------------------------------------------------
// Content-addressed URLs
//
// Pages name their CSS, images, fonts and entry modules as `/file?v=<hash>`.
// A URL whose `v` equals the current content hash can be cached immutably; any
// other spelling (old hash, manual `?v=53`, none) is still served, but with
// revalidation. Modules are additionally addressed through an import map so a
// static `import './x.mjs'`, a dynamic `import('/x.mjs')`, a modulepreload hint
// and a `<script src>` all resolve to one byte-identical URL: a module (and the
// singletons it holds) is never instantiated twice under two URLs.
// ---------------------------------------------------------------------------

export const STATIC_IMMUTABLE = 'public, max-age=31536000, immutable';
export const STATIC_REVALIDATE = 'public, max-age=0, must-revalidate';
// Images and fonts requested without their current content hash (quote logos and
// Gotchi layers built by scripts, `?v=53` brand marks) are release media: reused
// for a day, then revalidated with their ETag, in the background for a week.
// Pages, scripts and styles keep revalidating on every use, so a release never
// runs old code or styles against new pages.
export const STATIC_MEDIA = 'public, max-age=86400, stale-while-revalidate=604800';
const ORIGIN = 'http://static.invalid';
const staticMedia = type => typeof type === 'string' && /^(?:image|font)\//.test(type);

export function staticCacheControl(asset, type, requestedVersion) {
  if (type === 'text/html') return STATIC_REVALIDATE;
  if (typeof requestedVersion === 'string' && !!asset?.version && requestedVersion === asset.version) return STATIC_IMMUTABLE;
  return staticMedia(type) ? STATIC_MEDIA : STATIC_REVALIDATE;
}

// Adds hash sources to script-src only; every other directive is unchanged.
export function withScriptHashes(policy, hashes = []) {
  if (!hashes.length) return policy;
  let found = false;
  const next = policy.replace(/(^|;)(\s*)script-src\b([^;]*)/i, (_, start, space, sources) => { found = true; return `${start}${space}script-src${sources.replace(/\s+$/, '')} ${hashes.join(' ')}`; });
  return found ? next : policy;
}

export const inlineScriptHash = text => "'sha256-" + createHash('sha256').update(text, 'utf8').digest('base64') + "'";

// Specifiers of static `import … from '…'`, `import '…'` and `export … from '…'`
// statements. Dynamic import() is deliberately excluded: those modules load
// on demand. A false positive inside a comment or string only adds a hint.
const STATIC_IMPORT = /(?:^|[^\w$.])(?:import|export)\s*(?:(?:[\w$]+\s*,?\s*)?(?:\*\s*as\s+[\w$]+|\*|\{[^}]*\})?\s*from\s*)?(['"])([.\/\w@][^'"\r\n]*)\1/g;
export function staticImportSpecifiers(source) {
  return [...String(source).matchAll(STATIC_IMPORT)].map(match => match[2]);
}

// Resolves a same-origin, query-free specifier to a URL path. Anything else
// (packages, other origins, `?query` spellings) is never remapped.
export function resolveStaticPath(specifier, fromPath = '/') {
  if (typeof specifier !== 'string' || !/^(?:\.{1,2}\/|\/(?!\/))/.test(specifier)) return null;
  let url; try { url = new URL(specifier, ORIGIN + fromPath); } catch { return null; }
  return url.origin === ORIGIN && !url.search && !url.hash ? url.pathname : null;
}

// Breadth-first static import graph of the entry modules, excluding the
// entries themselves. `importsOf(path)` returns resolved paths (or null).
export function staticModuleGraph(entries, importsOf) {
  const seen = new Set(entries), order = [], queue = [...entries];
  while (queue.length) {
    for (const next of importsOf(queue.shift()) || []) {
      if (seen.has(next)) continue;
      seen.add(next); order.push(next); queue.push(next);
    }
  }
  return order;
}

// Quoted absolute-path string literals in JavaScript (e.g. '/brand-icon.svg?v=53').
// Pages adopt the spelling of any CSS/image URL their scripts also build, so
// the browser never downloads one file under two URLs.
export function absolutePathLiterals(source) {
  return [...String(source).matchAll(/(['"`])(\/(?!\/)[^'"`\s\\<>]*)\1/g)].map(match => match[2]).filter(value => !value.includes('${'));
}

// Groups literal URLs by pathname: `/x.css?v=50` and `/x.css` both describe `/x.css`.
export function literalSpellings(values) {
  const byPath = new Map();
  for (const value of values) {
    let url; try { url = new URL(value, ORIGIN); } catch { continue; }
    if (url.origin !== ORIGIN || url.hash || [...url.searchParams.keys()].some(key => key !== 'v')) continue;
    (byPath.get(url.pathname) || byPath.set(url.pathname, new Set()).get(url.pathname)).add(value);
  }
  return byPath;
}

// Preload hints a page carries as <link rel="preload"> (fonts only: they are
// the one resource every page needs that nothing else can discover early).
export function preloadLinks(html) {
  return htmlReferences(html).filter(row => row.tag === 'link' && /\brel\s*=\s*["']?preload\b/i.test(row.element) && /\bas\s*=\s*["']?font\b/i.test(row.element) && /^\/(?!\/)/.test(row.value))
    .map(row => ({ href: row.value, as: 'font', type: /\btype\s*=\s*["']?([\w/+.-]+)/i.exec(row.element)?.[1] || null, crossorigin: /\bcrossorigin\b/i.test(row.element) }));
}

// `Link` header value for those hints, so the fetch starts before the body parses.
export function preloadLinkHeader(links = []) {
  return links.filter(link => /^\/[\w./?=&%-]+$/.test(link.href))
    .map(link => `<${link.href}>; rel=preload; as=${link.as}${link.type ? `; type=${link.type}` : ''}${link.crossorigin ? '; crossorigin' : ''}`).join(', ');
}

const attributeValue = /(\s(?:src|href)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
const referenceTag = /<(script|link|img|source)\b[^>]*>/gi;
const cssUrl = /url\(\s*(?:(['"])([^'"]*)\1|([^'")\s]+))\s*\)/gi;
const escapeAttribute = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const decodeAttribute = value => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// Rewrites local references in an HTML document. `resolve(url, {tag, attribute})`
// returns the replacement URL or null to leave the reference unchanged.
// `head` (optional) is inserted at the start of <head>, after <meta charset>.
// Without a <head> to carry `head`, the document is returned unchanged.
export function rewriteHtmlReferences(html, resolve, head = '') {
  if (head && !/<head\b[^>]*>/i.test(String(html))) return String(html);
  let output = String(html).replace(referenceTag, tag => {
    const name = tag.slice(1).split(/[\s>/]/)[0].toLowerCase();
    return tag.replace(attributeValue, (whole, prefix, double, single) => {
      if (name === 'script' && !/^\s*src/i.test(prefix) || name === 'link' && !/^\s*href/i.test(prefix) || ['img','source'].includes(name) && !/^\s*src/i.test(prefix)) return whole;
      const value = decodeAttribute(double ?? single), next = resolve(value, { tag: name, attribute: name === 'link' ? 'href' : 'src', element: tag });
      return typeof next === 'string' && next !== value ? `${prefix}"${escapeAttribute(next)}"` : whole;
    });
  });
  if (head) {
    const opening = /<head\b[^>]*>(\s*<meta\s+charset\s*=\s*["']?[\w-]+["']?\s*\/?>)?/i.exec(output);
    if (!opening) return output;
    const at = opening.index + opening[0].length;
    output = output.slice(0, at) + head + output.slice(at);
  }
  return output;
}

export function htmlReferences(html) {
  const values = [];
  rewriteHtmlReferences(html, (value, context) => { values.push({ value, ...context }); return null; });
  return values;
}

export function moduleScriptSources(html) {
  return htmlReferences(html).filter(row => row.tag === 'script' && /\btype\s*=\s*["']?module\b/i.test(row.element)).map(row => row.value);
}

export function rewriteCssUrls(css, resolve) {
  return String(css).replace(cssUrl, (whole, quote, quoted, bare) => {
    const value = quoted ?? bare, next = resolve(value);
    if (typeof next !== 'string' || next === value) return whole;
    const q = quote || '';
    return `url(${q}${next}${q})`;
  });
}

export function cssUrls(css) {
  const values = [];
  rewriteCssUrls(css, value => { values.push(value); return null; });
  return values;
}

function memo(map, key, create) {
  if (!map.has(key)) map.set(key, Promise.resolve().then(create).catch(error => { map.delete(key); throw error; }));
  return map.get(key);
}

// Builds content-addressed representations of the public files a server
// publishes. `assets` maps URL paths to [file, type]; `read(file)` returns its
// bytes. Paths in `exclude` (private, authenticated modules) are never mapped,
// preloaded or rewritten and keep their existing serving behaviour.
export function createStaticSite({ assets, read, exclude = new Set() }) {
  const raws = new Map(), built = new Map(), typeOf = new Map(), pathOf = new Map();
  for (const [path, [file, type]] of assets) {
    if (!typeOf.has(file)) typeOf.set(file, type);
    if (!exclude.has(path) && type !== 'text/html' && !pathOf.has(file)) pathOf.set(file, path);
  }
  const raw = file => memo(raws, file, () => read(file));
  const publicEntry = path => { const entry = assets.get(path); return entry && !exclude.has(path) ? entry : null; };
  const moduleEntries = () => [...assets].filter(([path, [, type]]) => type === 'text/javascript' && !exclude.has(path));
  let moduleTask, literalTask;

  // Every public module path → its versioned URL, plus each module's static imports.
  const modules = () => moduleTask ||= (async () => {
    const rows = await Promise.all(moduleEntries().map(async ([path, [file]]) => {
      try { const item = await asset(file); return [path, item]; } catch { return null; }
    }));
    const urls = new Map(), imports = new Map();
    for (const row of rows) if (row) urls.set(row[0], row[0] + '?v=' + row[1].version);
    for (const row of rows) if (row) {
      const source = row[1].bytes.toString('utf8');
      imports.set(row[0], [...new Set(staticImportSpecifiers(source).map(spec => resolveStaticPath(spec, row[0])).filter(path => urls.has(path)))]);
      await new Promise(resolve => setImmediate(resolve));
    }
    const table = Object.fromEntries([...urls].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const json = JSON.stringify({ imports: table }).replace(/</g, '\\u003c');
    return { urls, imports, json, hash: inlineScriptHash(json) };
  })();

  // String literals of every script the server can hand out, private ones
  // included, grouped by the pathname they name.
  const literals = () => literalTask ||= (async () => {
    const values = new Set();
    for (const [, [file, type]] of assets) {
      if (type !== 'text/javascript') continue;
      try { for (const value of absolutePathLiterals((await raw(file)).toString('utf8'))) values.add(value); } catch { /* unreadable files are simply not scanned */ }
    }
    return literalSpellings(values);
  })();

  // Versioned URL for a non-module reference found in HTML (from='html') or CSS.
  // A URL that page scripts also spell out is kept as the scripts spell it (a
  // script may insert or compare that exact string), so one file is never
  // fetched twice: an exact match stays, and a page whose manual `?v=` lags a
  // script's single explicit `?v=` adopts the script's. A bare path inside a
  // script (often a selector fragment such as `[href*="/x.css"]`) pins nothing.
  async function versionedReference(value, from, base = '/') {
    if (from === 'html' && !/^\/(?!\/)/.test(value)) return null;
    let url; try { url = new URL(value, ORIGIN + base); } catch { return null; }
    if (url.origin !== ORIGIN || url.hash || [...url.searchParams.keys()].some(key => key !== 'v')) return null;
    const entry = publicEntry(url.pathname);
    if (!entry || ['text/html','text/javascript'].includes(entry[1]) || from === 'css' && entry[1] === 'text/css') return null;
    const spellings = (await literals()).get(url.pathname) || new Set();
    if (spellings.has(value)) return null;
    const explicit = [...spellings].filter(spelling => spelling.includes('?'));
    if (explicit.length) return explicit.length === 1 ? explicit[0] : null;
    try { return url.pathname + '?v=' + (await asset(entry[0])).version; } catch { return null; }
  }

  async function renderCss(source, file) {
    const base = pathOf.get(file) || '/' + file, resolved = new Map();
    for (const value of new Set(cssUrls(source))) resolved.set(value, await versionedReference(value, 'css', base));
    return rewriteCssUrls(source, value => resolved.get(value));
  }

  async function renderHtml(source) {
    // A page with its own import map (or no <head>) is served exactly as written.
    if (!/<head\b[^>]*>/i.test(source) || /<script\b[^>]*\btype\s*=\s*["']?importmap/i.test(source)) return { html: source, scriptHashes: [] };
    const graph = await modules(), references = htmlReferences(source), resolved = new Map();
    const moduleUrl = value => { const path = /^\/(?!\/)/.test(value) ? resolveStaticPath(value.replace(/\?v=[^&#]*$/, '')) : null; return path && graph.urls.get(path) || null; };
    for (const { value, tag } of references) {
      if (resolved.has(value)) continue;
      const module = moduleUrl(value);
      resolved.set(value, module || (tag === 'script' ? null : await versionedReference(value, 'html')));
    }
    const entries = [...new Set(moduleScriptSources(source).map(value => moduleUrl(value) && resolveStaticPath(value.replace(/\?v=[^&#]*$/, ''))).filter(Boolean))];
    const preload = staticModuleGraph(entries, path => graph.imports.get(path)).map(path => `<link rel="modulepreload" href="${escapeAttribute(graph.urls.get(path))}">`).join('');
    const head = `<script type="importmap">${graph.json}</script>${preload}`;
    const html = rewriteHtmlReferences(source, value => resolved.get(value), head);
    return { html, scriptHashes: html === source ? [] : [graph.hash] };
  }

  const asset = file => memo(built, file, async () => {
    const type = typeOf.get(file), bytes = await raw(file);
    if (type === 'text/css') return createStaticAsset(Buffer.from(await renderCss(bytes.toString('utf8'), file)));
    if (type === 'text/html') {
      const { html, scriptHashes } = await renderHtml(bytes.toString('utf8'));
      // The page's own font preload, repeated as a Link header: the same URL,
      // requested as soon as the response headers arrive.
      return createStaticAsset(Buffer.from(html), { scriptHashes, linkHeader: preloadLinkHeader(preloadLinks(html)) });
    }
    return createStaticAsset(bytes);
  });

  // Builds pages, import map and compressed variants ahead of the first
  // visitor, one file at a time so request handling keeps priority. Bodies are
  // built (or upgraded) at the best compression level: this runs once per process.
  let warming = null;
  function warm({ signal } = {}) {
    if (warming) return warming;
    warming = (async () => {
      const files = [...new Map([...assets].filter(([path, [, type]]) => !exclude.has(path) && compressible(type)).map(([, [file, type]]) => [file, type]))];
      files.sort(([, a], [, b]) => (a === 'text/html' ? 0 : 1) - (b === 'text/html' ? 0 : 1));
      for (const [file, type] of files) {
        if (signal?.aborted) break;
        try {
          const item = await asset(file);
          for (const encoding of ['br','gzip']) { if (signal?.aborted) break; await warmStaticAssetEncoding(item, type, encoding); }
        } catch { /* missing files fail on request exactly as before */ }
        await new Promise(resolve => setImmediate(resolve));
      }
    })().finally(() => { if (signal?.aborted) warming = null; });
    return warming;
  }

  return { asset, modules, warm, versionedReference };
}
