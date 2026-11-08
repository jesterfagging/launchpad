// Drive a real evolution through the character controller (not just data-stage):
// the page creates characters via createGotchiCharacter; we re-create one in a
// scratch container so setStage() runs its animation, and capture frames.
import { chromium } from 'playwright'; // npm i -D playwright && npx playwright install chromium
const id = process.argv[2] || 'pumpgotchi', from = Number(process.argv[3] || 1), to = Number(process.argv[4] || 2);
const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 700, height: 520 } });
const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://127.0.0.1:4173/gotchi?id=' + id, { waitUntil: 'networkidle' });
await page.evaluate(async ({ id, from }) => {
  const mod = await import('/gotchi-character.mjs');
  document.body.innerHTML = '<div id="stage" style="width:700px;height:520px;display:grid;place-items:center;background:#121020"></div>';
  const character = mod.createGotchiCharacter({ document, window, theme: id, stage: from, size: 'page', interactive: true });
  character.element.style.setProperty('--gotchi-figure-height', '380px');
  document.getElementById('stage').append(character.element); window.__character = character;
}, { id, from });
await page.waitForTimeout(600);
await page.evaluate(to => window.__character.setStage(to), to);
const frames = [];
for (const [i, ms] of [150, 500, 650, 700, 1200].entries()) { await page.waitForTimeout(ms); const file = `shots/evolve-${id}-${from}-${to}-${i}.png`; await page.screenshot({ path: file }); frames.push(file); }
const stage = await page.evaluate(() => ({ stage: window.__character.stage, mood: window.__character.element.dataset.mood, expression: window.__character.element.dataset.expression, label: window.__character.element.getAttribute('aria-label') }));
console.log(JSON.stringify({ frames, stage, errors }));
await browser.close();
