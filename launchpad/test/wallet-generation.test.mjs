import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { generateWalletBatch } from '../src/wallet-generation.mjs';
import { cleanStrategy } from '../public/strategy-settings.mjs';
import { cleanRunWallets } from '../public/run-settings.mjs';
import { setWalletBudget } from '../src/telegram-strategy.mjs';
import { importWallets, defaults } from '../src/telegram-settings.mjs';
import { validateManualTrade } from '../src/manual-trades.mjs';

test('25 new wallets are unique, independently recoverable, and support all selections and budgets', async () => {
  const wallets = await generateWalletBatch(25);
  assert.equal(new Set(wallets.map(w => w.publicKey)).size, 25);
  for (const wallet of wallets) assert.equal(Keypair.fromSecretKey(bs58.decode(wallet.privateKey)).publicKey.toBase58(), wallet.publicKey);
  assert.equal(importWallets(wallets.map(w => w.privateKey).join('\n')).length, 25);
  const selected = wallets.map(w => w.publicKey);
  assert.equal(cleanRunWallets({ copy: selected, market: selected.slice(0, 5), liquidity: selected.slice(0, 10) }).copy.length, 25);
  const budgets = Object.fromEntries(wallets.map((_, i) => [i, '1']));
  assert.equal(Object.keys(cleanStrategy({ walletBudgets: budgets }).walletBudgets).length, 25);
  assert.equal(setWalletBudget({ ...defaults, wallets }, 'market', 19, '2').strategies.market.walletBudgets[19], '2');
  assert.throws(() => cleanStrategy({ walletBudgets: { 64: '1' } }), /budget/);
  assert.equal(validateManualTrade({ id: '00000000-0000-4000-8000-000000000001', side: 'sell', mint: Keypair.generate().publicKey.toBase58(), sellPercent: 100, wallets: selected }).wallets.length, 25);
});

test('batch generation rejects invalid counts and mixed imported/generated overflow without mutating existing wallets', async () => {
  const existing = await generateWalletBatch(23), snapshot = JSON.stringify(existing);
  for (const count of [0, -1, 1.5, '2', 26, NaN, Infinity]) await assert.rejects(generateWalletBatch(count, []), /whole number/);
  await assert.rejects(generateWalletBatch(3, existing), /25 Copy \/ Sniping wallets total/);
  const added = await generateWalletBatch(2, existing);
  assert.equal(added[0].label, 'Copy / Sniping 24'); assert.equal(added[1].label, 'Copy / Sniping 25');
  assert.equal(JSON.stringify(existing), snapshot);
  assert.throws(() => importWallets(added.map(w => w.privateKey).join('\n'), [...existing, added[0]]), /duplicated|25/);
});
