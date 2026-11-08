// The admin revenue report lists Pump.fun platform-share receipts in the asset
// received: SOL for SOL coins and the pair asset for coins on other Pump.fun
// pairs (v71.19). Invalid rows never become revenue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminRevenue } from '../src/admin-revenue.mjs';

const SOL = 'So11111111111111111111111111111111111111112', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', TREASURY = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const sig = n => String(n).repeat(88).slice(0, 88);
function report(sources) {
  const accounts = { list: async () => [], hostStore: { read: async () => ({ recipient: TREASURY, recipientScope: 'launchpad', creationFeeSol: '0.01' }) } };
  return new AdminRevenue({ accounts, toolkit: false, launchpad: {}, pumpClassicRevenueSources: async () => ({ complete: true, sources }), now: () => Date.UTC(2026, 9, 2) }).snapshot();
}

test('Pump.fun platform-share receipts are reported per asset received', async () => {
  const result = await report([
    { kind: 'platform-share', signature: sig(1), eventIndex: 0, wallet: 'W1', amount: '5000000', mint: SOL, decimals: 9, symbol: 'SOL' },
    { kind: 'platform-share', signature: sig(2), eventIndex: 0, wallet: 'W2', amount: '2500000', mint: USDC, decimals: 6, symbol: 'USDC' },
    { kind: 'platform-share', signature: sig(2), eventIndex: 0, wallet: 'W2', amount: '2500000', mint: USDC, decimals: 6, symbol: 'USDC' },
  ]);
  const product = result.products.find(row => row.id === 'pump-classic');
  assert.equal(product.status, 'available');
  const totals = Object.fromEntries(product.totals.map(row => [row.mint, [row.grossAmount, row.decimals, row.symbol]]));
  assert.deepEqual(totals[SOL], ['5000000', 9, 'SOL']);
  assert.deepEqual(totals[USDC], ['2500000', 6, 'USDC'], 'a duplicate leg is counted once');
});

test('a malformed Pump.fun receipt makes the history unavailable instead of becoming revenue', async () => {
  for (const bad of [{ mint: USDC, decimals: 99 }, { mint: 'not a mint', decimals: 6 }, { mint: SOL, decimals: 6 }, { amount: '0' }]) {
    const result = await report([{ kind: 'platform-share', signature: sig(3), eventIndex: 0, wallet: 'W3', amount: '10', mint: USDC, decimals: 6, symbol: 'USDC', ...bad }]);
    const product = result.products.find(row => row.id === 'pump-classic');
    assert.notEqual(product.status, 'available', JSON.stringify(bad)); assert.match(product.note, /could not be read completely/);
  }
});
