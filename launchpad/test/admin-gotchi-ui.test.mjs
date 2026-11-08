// Admin → Tokens → Gotchi Mode: owner-only race controls. These tests cover what the snapshot shows
// (today's gas, collected assets in whole tokens, readable retries and settlement) and page polling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createAdminGotchi } from '../public/admin-gotchi-ui.mjs';

const OWNER = { id: 'owner', role: 'admin', mfaEnabled: true }, NOW = Date.UTC(2026, 9, 3, 12, 0, 0), USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', VAULT = '9J7iw6jVxqPoiBMXWsWRNAsgFT9qkkkVHyAS26euwoBq', WINNER = 'So11111111111111111111111111111111111111112';
const gotchi = (patch = {}) => ({ id: 'fomogotchi', name: 'Fomo', vault: VAULT, flags: {}, pot: { potUsd: 120, realizedSol: '1', spendableSol: '0.9', frozenSol: '0', networkSpentSol: '0.01' }, race: { index: 2, status: 'buying', sampleCount: 4, settlement: { winner: { mint: WINNER }, winners: [{}, {}], potSol: '2', buySol: '1', buyRemainingLamports: '500000000', index: 1, payouts: [{}, {}, {}] } }, gas: { day: '2026-10-03', used: '5000000', reserved: '0' }, retry: { ['convert:' + USDC]: { attempts: 3, nextAttemptAt: NOW + 60000, error: 'Jupiter has no route for this pair right now.' }, buy: { attempts: 1, error: 'Slippage limit reached.' } }, assets: [{ mint: USDC, symbol: 'USDC', decimals: 6, received: '41200000', credit: '41200000', converted: '0' }], coins: [], history: [], ...patch });
const snapshot = (patch = {}) => ({ version: 1, enabled: true, at: NOW, gotchis: [gotchi()], controls: [], policy: { goalUsd: 1000, topHolders: 10, gasReserveLamports: '20000000', dailyNetworkLimitLamports: '100000000' }, ...patch });
function page({ respond = async () => snapshot(), clock = () => NOW } = {}) {
  const { document } = parseHTML('<html><body></body></html>'); Object.defineProperty(document, 'hidden', { value: false, writable: true });
  const calls = [], timers = new Map(); let id = 0, active = true;
  const ui = createAdminGotchi({ document, getAccount: () => OWNER, isActive: () => active, api: async (path, body) => { calls.push({ path, body }); return respond(path, body); }, security: { authorize: async () => ({ password: 'pw', code: '123456' }) }, setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimer: key => timers.delete(key), clock });
  document.body.append(ui.element);
  return { ui, document, calls, timers, active: value => { active = value; }, card: () => ui.element.querySelector('[data-gotchi="fomogotchi"]') };
}

test('gas today counts only spending recorded on the snapshot day', async () => {
  const today = page(); await today.ui.load(); assert.match(today.card().textContent, /Gas today0\.005 SOL/); today.ui.destroy();
  const earlier = page({ respond: async () => snapshot({ gotchis: [gotchi({ gas: { day: '2026-10-02', used: '75000000', reserved: '0' } })] }) }); await earlier.ui.load();
  assert.match(earlier.card().textContent, /Gas today0 SOL/); assert.doesNotMatch(earlier.card().textContent, /Gas today0\.075/); earlier.ui.destroy();
});

test('collected assets use their decimals, retries and settlement read clearly, and dates carry the year', async () => {
  const p = page(); await p.ui.load(); const text = p.card().textContent;
  assert.match(text, /41\.2 USDC awaiting conversion/); assert.doesNotMatch(text, /raw units/);
  assert.match(text, /Conversion of USDC: Jupiter has no route for this pair right now\. · attempts 3 · next /); assert.match(text, /Winner buy: Slippage limit reached\./); assert.doesNotMatch(text, new RegExp('convert:' + USDC));
  assert.match(text, /buy 1 SOL · remaining to buy 0\.5 SOL/);
  assert.match(p.ui.element.querySelector('#admin-gotchi-status').textContent, /Snapshot .*2026/); p.ui.destroy();
});

test('returning to the page reuses a fresh snapshot and restarts polling; a stale one is read again', async () => {
  let now = NOW; const p = page({ clock: () => now }); await p.ui.load(); assert.equal(p.calls.length, 1);
  p.active(false); p.ui.pause(); assert.equal(p.timers.size, 0);
  p.active(true); await p.ui.show(); assert.equal(p.calls.length, 1, 'fresh data is reused'); assert.equal(p.timers.size, 1, 'polling resumes');
  p.ui.pause(); now += 31000; await p.ui.show(); assert.equal(p.calls.length, 2, 'stale data is read again'); p.ui.destroy();
});
