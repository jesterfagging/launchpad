import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createGotchiPage } from '../public/gotchi.js';

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const ok = value => ({ ok: true, status: 200, json: async () => value });
const NOW = 1700000000000, WALLET = 'J8WRhbSjG3NbcfRWKmVY5fqnETZZfyUR1zrt5QmM9gQP', MINT = '56rHmw6WonvGiumJRwhNPJ659x9tKhGF2utn35kYNVDV';
const race = { index: 1, status: 'open', startedAt: NOW - 3600000, durationMs: 3600000, sampleCount: 4 };
const list = () => ({ gotchis: ['fomogotchi', 'pumpgotchi'].map(id => ({ id, pot: { potUsd: 120, spendableSol: '0.8' }, race, topCoins: [], attached: 0 })), goalUsd: 10000, milestonesUsd: [2500, 5000, 10000], topHolders: 10, rules: [], funding: {}, at: NOW });

async function gotchiPage(t, search) {
  const { document } = parseHTML(await readFile(new URL('../public/gotchi.html', import.meta.url), 'utf8')), calls = [];
  const fetcher = async path => {
    calls.push(path);
    if (path === '/api/gotchi') return ok(list());
    if (path.startsWith('/api/gotchi/detail?')) return ok({ id: 'fomogotchi', pot: { potUsd: 120, spendableSol: '0.8', collected: [{ mint: MINT, symbol: 'LEMON', amount: '2500000.5' }] }, race, coins: [{ mint: MINT, venue: 'raydium', symbol: 'LEMON', graduated: true, marketCapUsd: 90000, contributed: '1234.567891', pending: '0.000000001', quoteSymbol: 'SOL' }], leaderboard: { projected: [] }, history: [], at: NOW });
    if (path === '/api/launchpad/gotchi/holdings') return ok({ wallet: WALLET, gotchis: [{ id: 'fomogotchi', name: 'Fomogotchi', settling: false, rank: 4, inTop: true, averageUsd: 930, shareOfTopPercent: 12, eligible: 30, holdings: [{ mint: MINT, symbol: 'LEMON', amount: '1240000', sampledAt: NOW - 60000 }] }], at: NOW });
    throw Error('Unexpected request ' + path);
  };
  const app = createGotchiPage({ document, window: { location: { search }, setTimeout, clearTimeout, localStorage: null }, fetcher, clock: () => NOW, setTimer: () => 1, clearTimer: () => {}, shell: () => {} });
  t.after(() => app.destroy()); await app.ready; await flush();
  return { document, app, calls, get: id => document.getElementById(id) };
}

test('an unknown Gotchi id keeps its notice visible after the list loads', async t => {
  const ui = await gotchiPage(t, '?id=nope');
  assert.equal(ui.get('gotchi-detail').hidden, true); assert.match(ui.get('gotchi-list-status').textContent, /^That Gotchi does not exist\. Here are the three that do\. Live/);
  const plain = await gotchiPage(t, ''); assert.match(plain.get('gotchi-list-status').textContent, /^Live · refreshed/);
});

test('Gotchi amounts use digit grouping and the launch link preselects that Gotchi', async t => {
  const ui = await gotchiPage(t, '?id=fomogotchi'); ui.app.setSession({ authenticated: true, token: 'csrf' }); await flush();
  assert.match(ui.get('gotchi-mine-body').textContent, /1,240,000 \$LEMON/); assert.doesNotMatch(ui.get('gotchi-mine-body').textContent, /1240000/);
  assert.match(ui.get('gotchi-coins').textContent, /1,234\.57 SOL/); assert.match(ui.get('gotchi-coins').textContent, /<0\.000001 SOL/); assert.match(ui.get('gotchi-ledger').textContent, /2,500,000\.5 LEMON awaiting conversion/);
  assert.equal(ui.get('gotchi-launch-one').getAttribute('href'), '/launchpad?gotchi=fomogotchi');
});
