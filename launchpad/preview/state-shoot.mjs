#!/usr/bin/env node
// Screenshot a preview page in headless Chromium and report problems.
//   node shoot.mjs <path> [out.png] [--w=1440] [--h=900] [--full] [--mobile]
//        [--session=anon|user|admin] [--wait=1500] [--hash=#revenue]
//        [--click=<css>]... [--selector=<css>] [--eval=<js>] [--type=<text>] [--split=1600]
//        [--locale=en-US] [--tz=UTC] [--dpr=1] [--no-dex-stub] [--warnings] [--base=http://127.0.0.1:4173]
// Assumes server.mjs is already running. Exit code 1 when page errors, CSP
// violations or unexpected failed requests were seen (2 on navigation failure).
import { chromium } from 'playwright'; // npm i -D playwright && npx playwright install chromium
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), flags = {}, clicks = [], positional = [];
for (const arg of args) {
  const m = /^--([a-z-]+)(?:=(.*))?$/i.exec(arg);
  if (!m) positional.push(arg); else if (m[1] === 'click') clicks.push(m[2]); else flags[m[1]] = m[2] ?? true;
}
if (!positional[0] || flags.help) { console.log('usage: node shoot.mjs <path> [out.png] [--w=1440] [--h=900] [--full] [--mobile] [--session=admin] [--wait=1500] [--hash=#revenue] [--click=<css>]... [--selector=<css>]'); process.exit(positional[0] ? 0 : 2); }
const base = (flags.base || process.env.PREVIEW_URL || `http://127.0.0.1:${process.env.PORT || 4173}`).replace(/\/$/, '');
const target = positional[0].startsWith('http') ? positional[0] : base + (positional[0].startsWith('/') ? '' : '/') + positional[0];
const hash = flags.hash ? (String(flags.hash).startsWith('#') ? flags.hash : '#' + flags.hash) : '';
const url = target + hash, mobile = !!flags.mobile, session = flags.session || 'anon', wait = Number(flags.wait ?? 1500);
const slug = (positional[0].replace(/^https?:\/\/[^/]+/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home') + (hash ? '-' + hash.slice(1) : '') + (session !== 'anon' ? '-' + session : '') + (mobile ? '-mobile' : '');
const out = resolve(positional[1] || join(here, 'shots', slug + '.png'));

const browser = await chromium.launch();
const locale = { locale: flags.locale || 'en-US', timezoneId: flags.tz || 'UTC' }; // headless default here is 'en-US@posix', which breaks Intl/lightweight-charts
const context = await browser.newContext(mobile
  ? { viewport: { width: Number(flags.w || 390), height: Number(flags.h || 844) }, deviceScaleFactor: Number(flags.dpr || 2), ...locale, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }
  : { ...locale, viewport: { width: Number(flags.w || 1440), height: Number(flags.h || 900) }, deviceScaleFactor: Number(flags.dpr || 1) });
await context.addCookies([{ name: 'mock-session', value: session, url: base }]);
const page = await context.newPage();
// The sandbox has no route to dexscreener.com; stand in a neutral placeholder so
// graduated-coin layouts are not judged on a blank white iframe (--no-dex-stub to disable).
if (!flags['no-dex-stub']) await page.route('https://dexscreener.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#131722;color:#787b86;font:14px system-ui">DEX Screener chart embed (stubbed by preview harness)</body>' }));
// --route=<substring>:<delay|fail|empty|coins0|hold> applies to same-origin API requests whose URL contains the substring.
const routes = [];
for (const raw of String(flags.route || '').split(';').filter(Boolean)) { const [match, mode] = raw.split(':'); routes.push({ match, mode }); }
if (routes.length) await page.route(url => url.href.startsWith(base) && routes.some(r => url.href.includes(r.match)), async route => {
  const rule = routes.find(r => route.request().url().includes(r.match));
  if (rule.mode === 'hold') return; // never answer
  if (rule.mode === 'delay') { await new Promise(r => setTimeout(r, 4000)); return route.continue(); }
  if (rule.mode === 'fail') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporarily unavailable', retryAfterMs: 60000 }) });
  if (rule.mode === 'grow') { const res = await route.fetch(); const json = await res.json(); rule.count = (rule.count || 0) + 1; if (rule.count > 1 && Array.isArray(json.trades) && json.trades.length) { const base = json.trades[0], extra = Array.from({ length: 3 }, (_, i) => ({ ...base, side: i % 2 ? 'sell' : 'buy', time: Math.floor(Date.now() / 1000) - i * 7, signature: (base.signature.slice(0, -6) + String(rule.count * 10 + i).padStart(6, '1')).replace(/0/g, '1') })); json.trades = [...extra, ...json.trades]; } return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) }); }
  if (rule.mode === 'empty') { const res = await route.fetch(); const json = await res.json(); for (const k of ['coins','users','trades','holders']) if (Array.isArray(json[k])) json[k] = []; json.total = 0; json.counts = { all: 0, new: 0, moving: 0, graduated: 0 }; json.nextOffset = null; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) }); }
  return route.continue();
});
if (flags.init) await page.addInitScript(String(flags.init));
const consoleErrors = [], warnings = [], pageErrors = [], failed = [], httpErrors = [], csp = [];
await page.exposeFunction('__previewCsp', v => csp.push(v));
await page.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', e => {
    window.__previewCsp?.(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'}${e.sourceFile ? ` at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}` : ''}${e.sample ? ` sample="${e.sample}"` : ''}`);
  }, true);
});
page.on('console', msg => { const text = msg.text(), loc = msg.location(); const line = `${text}${loc?.url ? `  (${loc.url.replace(base, '')}:${loc.lineNumber})` : ''}`; if (msg.type() === 'error') consoleErrors.push(line); else if (msg.type() === 'warning') warnings.push(line); });
page.on('pageerror', error => pageErrors.push(error.stack || String(error)));
page.on('requestfailed', req => { const reason = req.failure()?.errorText || 'failed'; if (reason !== 'net::ERR_ABORTED') failed.push(`${req.method()} ${req.url().replace(base, '')} — ${reason}`); });
page.on('response', res => { if (res.status() >= 400 && res.url().startsWith(base)) httpErrors.push(`${res.status()} ${res.request().method()} ${res.url().replace(base, '')}`); });

const settle = async () => { try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {} if (wait > 0) await page.waitForTimeout(wait); };
let status = 0;
try {
  const response = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  status = response?.status() ?? 0;
  if (flags.early) await page.waitForTimeout(Number(flags.early)); else await settle();
  if (flags.eval) { try { await page.evaluate(String(flags.eval)); } catch (error) { pageErrors.push('--eval failed: ' + error.message.split('\n')[0]); } await settle(); }
  for (const selector of clicks) {
    try { await page.click(selector, { timeout: 8000 }); } catch (error) { pageErrors.push(`--click=${selector} failed: ${error.message.split('\n')[0]}`); }
    if (flags['click-wait']) await page.waitForTimeout(Number(flags['click-wait'])); else await settle();
  }
  if (flags.type) { await page.keyboard.type(String(flags.type), { delay: 30 }); await settle(); }
  for (const key of String(flags.key || '').split(',').filter(Boolean)) { await page.keyboard.press(key); await page.waitForTimeout(250); }
  if (flags.hover) { try { await page.hover(String(flags.hover), { timeout: 8000 }); } catch (error) { pageErrors.push(`--hover=${flags.hover} failed: ${error.message.split('\n')[0]}`); } await page.waitForTimeout(Number(flags['hover-wait'] || 900)); }
  // Full-page captures with sticky headers look wrong if the page was scrolled by a click.
  // Discovery copy: scroll through the page like a reader so scroll-triggered reveals run, then return to the top.
  if ((flags.full || flags.split) && !flags['no-scroll']) { const h = await page.evaluate(() => document.documentElement.scrollHeight), vh = page.viewportSize().height; for (let y = 0; y < h; y += Math.round(vh * .7)) { await page.evaluate(v => window.scrollTo(0, v), y); await page.waitForTimeout(120); } await page.waitForTimeout(900); }
  if (flags.full || flags.split) { await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); }); await page.waitForTimeout(flags.full ? 700 : 150); }
  await mkdir(dirname(out), { recursive: true });
  if (flags.selector) await page.locator(flags.selector).first().screenshot({ path: out });
  else await page.screenshot({ path: out, fullPage: !!flags.full });
  // --split=1600: also write out-1.png, out-2.png… slices of the full page (easier to inspect tall pages).
  if (flags.split) {
    const step = Number(flags.split) || 1600, width = page.viewportSize().width, height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0, i = 1; y < height; y += step, i++) await page.screenshot({ path: out.replace(/\.png$/, `-${i}.png`), fullPage: true, clip: { x: 0, y, width, height: Math.min(step, height - y) } });
  }
} catch (error) {
  console.log(`NAVIGATION FAILED: ${error.message}`); await browser.close(); process.exit(2);
}
const title = await page.title(), finalUrl = page.url().replace(base, '');
await browser.close();

const section = (label, rows) => { if (rows.length) { console.log(`\n${label} (${rows.length}):`); for (const row of [...new Set(rows)]) console.log('  - ' + row.split('\n').slice(0, 6).join('\n    ')); } };
console.log(`${url}  →  ${out}`);
console.log(`HTTP ${status} · title "${title}" · final ${finalUrl} · session=${session}${mobile ? ' · mobile' : ''}`);
section('CSP violations', csp);
section('Page errors', pageErrors);
section('Console errors', consoleErrors.filter(line => !/Content Security Policy|Failed to load resource/.test(line) || /Content Security Policy/.test(line) && !csp.length));
section('HTTP errors (same origin)', httpErrors);
section('Failed requests', failed);
if (flags.warnings) section('Console warnings', warnings);
if (!csp.length && !pageErrors.length && !consoleErrors.length && !failed.length) console.log('No CSP violations, page errors, console errors or failed requests.');
process.exit(csp.length || pageErrors.length ? 1 : 0);
