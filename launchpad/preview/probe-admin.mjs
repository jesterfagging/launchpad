import { chromium } from 'playwright'; // npm i -D playwright && npx playwright install chromium
const browser = await chromium.launch(); const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
await context.addCookies([{ name: 'mock-session', value: 'admin', url: 'http://127.0.0.1:4173' }]);
const page = await context.newPage(); await page.goto('http://127.0.0.1:4173/admin#admin-agents', { waitUntil: 'load' }); await page.waitForTimeout(3500);
const info = await page.evaluate(() => { const facts = document.querySelector('[data-agent] .admin-gas-facts'); const first = facts?.firstElementChild; const cs = first && getComputedStyle(first); const strong = first?.querySelector('strong'); const ss = strong && getComputedStyle(strong); return { count: facts?.children.length, html: first?.outerHTML, display: cs?.display, color: cs?.color, opacity: cs?.opacity, visibility: cs?.visibility, height: first?.getBoundingClientRect().height, strongColor: ss?.color, strongFont: ss?.fontSize, bg: cs?.backgroundImage?.slice(0, 60) }; });
console.log(info); await browser.close();
