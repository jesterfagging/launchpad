// Quick DOM probe: node probe.mjs <path> --session=admin --hash=tokens --eval=<js returning value>
import { chromium } from 'playwright'; // npm i -D playwright && npx playwright install chromium
const args = process.argv.slice(2), flags = {}, positional = [];
for (const arg of args) { const m = /^--([a-z-]+)(?:=(.*))?$/i.exec(arg); if (!m) positional.push(arg); else flags[m[1]] = m[2] ?? true; }
const base = 'http://127.0.0.1:4173', hash = flags.hash ? '#' + String(flags.hash).replace(/^#/, '') : '';
const browser = await chromium.launch();
const mobile = !!flags.mobile;
const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-US', timezoneId: 'UTC' } : { viewport: { width: Number(flags.w || 1440), height: Number(flags.h || 900) }, locale: 'en-US', timezoneId: 'UTC' });
await context.addCookies([{ name: 'mock-session', value: flags.session || 'admin', url: base }]);
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base + positional[0] + hash, { waitUntil: 'load' });
try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
await page.waitForTimeout(Number(flags.wait ?? 1200));
const result = await page.evaluate(String(flags.eval || 'document.title'));
console.log(JSON.stringify(result, null, 1));
if (errors.length) console.log('ERRORS', errors);
await browser.close();
