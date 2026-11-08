// Pump.fun pairs walkthrough (v71.19) with a fake Wallet Standard wallet (no signing reaches a network).
import { chromium } from 'playwright'; // npm i -D playwright && npx playwright install chromium
import { deflateSync } from 'node:zlib';
const base = 'http://127.0.0.1:' + (process.env.PORT || 4173), out = process.argv[2] || 'shots/pc-dialog.png', mode = process.argv[3] || 'market_maker', mobile = process.argv.includes('--mobile');
const session = await (await fetch(base + '/api/session', { headers: { cookie: 'mock-session=user' } })).json();
const wallet = session.account.mainWallet;
// 64×64 solid PNG for the image upload.
const crc = buf => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const b of buf) x = t[(x ^ b) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2;
const raw = Buffer.alloc(64 * (1 + 64 * 3)); for (let y = 0; y < 64; y++) { raw[y * 193] = 0; for (let x = 0; x < 64; x++) { raw.set([235, 181 - y, 138 + x], y * 193 + 1 + x * 3); } }
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const browser = await chromium.launch();
const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-US', timezoneId: 'UTC' } : { viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezoneId: 'UTC' });
await context.addCookies([{ name: 'mock-session', value: 'user', url: base }]);
const page = await context.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(address => {
  const account = { address, publicKey: new Uint8Array(32), chains: ['solana:mainnet'], features: ['solana:signTransaction', 'solana:signMessage'] };
  const wallet = { version: '1.0.0', name: 'Preview Wallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=', chains: ['solana:mainnet'], accounts: [],
    features: { 'standard:connect': { version: '1.0.0', async connect() { wallet.accounts = [account]; return { accounts: wallet.accounts }; } }, 'standard:events': { version: '1.0.0', on() { return () => {}; } }, 'standard:disconnect': { version: '1.0.0', async disconnect() { wallet.accounts = []; } },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: [0], async signTransaction(input) { return [{ signedTransaction: input.transaction }]; } },
      'solana:signMessage': { version: '1.0.0', async signMessage(input) { return [{ signedMessage: input.message, signature: new Uint8Array(64) }]; } } } };
  window.addEventListener('wallet-standard:app-ready', event => event.detail.register(wallet));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: api => api.register(wallet) }));
}, wallet);
await page.goto(base + '/launchpad', { waitUntil: 'load' }); await page.waitForTimeout(1500);
await page.click('[data-launch-venue=pump-classic]'); await page.waitForTimeout(1200);
await page.fill('input[name=name]', 'Orbit Garden'); await page.fill('input[name=symbol]', 'ORBIT');
await page.setInputFiles('#launch-image', { name: 'orbit.png', mimeType: 'image/png', buffer: png }); await page.waitForTimeout(800);
await page.click('#launch-connect'); await page.waitForTimeout(300); await page.click('#launch-wallet-options button'); await page.waitForTimeout(800);
const pair = process.argv[3] || 'USDC';
if (pair === 'USDC') { await page.click('[data-pair=USDC]'); await page.waitForTimeout(400); }
else {
  await page.click('#launch-asset-open'); await page.waitForTimeout(600);
  await page.screenshot({ path: out.replace('.png', '-picker.png'), fullPage: false });
  await page.click('#launch-asset-results button:not([disabled]) >> nth=0'); await page.waitForTimeout(400);
}
await page.click('label:has(input[value=' + (process.argv[4] || 'creator') + '])'); await page.waitForTimeout(300);
await page.screenshot({ path: out.replace('.png', '-form.png'), fullPage: false });
console.log('pair note:', await page.textContent('#launch-pair-note'), '| fee note:', await page.textContent('#launch-fee-note'), '| launch disabled:', await page.isDisabled('#launch-open'));
await page.click('#launch-open'); await page.waitForTimeout(800);
if (await page.isVisible('#launch-pump-classic-fee')) { const options = await page.$$eval('#launch-pump-classic-fee option', o => o.map(x => x.textContent)); console.log('creator fee options:', options.join(', ')); await page.selectOption('#launch-pump-classic-fee', '250'); }
await page.fill('#launch-pump-classic-buy', pair === 'USDC' ? '25' : '2');
await page.screenshot({ path: out.replace('.png', '-inputs.png'), fullPage: false });
await page.click('#launch-pump-classic-operation button.primary'); await page.waitForTimeout(1200);
await page.screenshot({ path: out, fullPage: false });
console.log('review:', (await page.textContent('#launch-pump-classic-operation')).replace(/\s+/g, ' ').slice(0, 700));
console.log(out, errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
