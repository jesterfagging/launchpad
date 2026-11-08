import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { dammPumpRevenueAnalyticsSources } from '../src/damm-pump-revenue.mjs';
import { DAMM_PUMP_FEE_DEPLOYMENT_POLICY as POLICY } from '../src/damm-pump-fee-deployment.mjs';
import { AdminRevenue } from '../src/admin-revenue.mjs';
import { publicRevenueAnalytics } from '../src/public-revenue-analytics.mjs';

const SOL = 'So11111111111111111111111111111111111111112', key = () => Keypair.generate().publicKey.toBase58(), sig = n => bs58.encode(Buffer.alloc(64, n));
function fixture() {
  const creator = Keypair.generate(), mint = key();
  const launch = { mint, creatorWallet: creator.publicKey.toBase58(), quoteMint: SOL, quoteDecimals: 9, quoteSymbol: 'SOL', finalizedAt: 1000, publicProgramId: POLICY.programId, status: 'migrated', creationFee: { lamports: '10000000', recipient: POLICY.treasury }, protocolFeesPaidRaw: '20000000' };
  const table = { key: new PublicKey(key()), state: { addresses: [new PublicKey(POLICY.treasury)] } };
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: creator.publicKey, recentBlockhash: key(), instructions: [SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: new PublicKey(POLICY.treasury), lamports: 10000000n })] }).compileToV0Message([table])); tx.sign([creator]);
  const initialize = { mint, action: 'initialize', wallet: launch.creatorWallet, state: 'finalized', signature: bs58.encode(tx.signatures[0]), signedTransaction: Buffer.from(tx.serialize()).toString('base64'), bundle: { addressLookupTables: [{ address: table.key.toBase58(), addresses: table.state.addresses.map(String) }] } }; initialize.result = { state: 'finalized', signature: initialize.signature, slot: 10 };
  const protocol = { mint, action: 'protocol-fees', state: 'finalized', signature: sig(2), result: { state: 'finalized', signature: sig(2), slot: 20, protocolFee: { quoteRaw: '20000000', recipient: POLICY.treasury } } };
  const migrate = { mint, action: 'migrate', state: 'finalized', signature: sig(3), result: { state: 'finalized', signature: sig(3), slot: 30, phase: 'migrated', graduationFee: { verified: true, signature: sig(3), quoteMint: SOL, amountRaw: '322369073', recipient: POLICY.treasury }, graduationFeeRaw: '322369073', grossQuoteRaw: '1000000000', poolQuoteRaw: '677630927' } };
  return { book: { schemaVersion: 1, launches: [launch], operations: [initialize, protocol, migrate] }, launch, initialize, protocol, migrate };
}

test('finalized signed ALT creation transfer, collected fees and exact graduation receipt count once without secrets', () => {
  const f = fixture(), original = structuredClone(f.book); f.book.operations.push(structuredClone(f.protocol), structuredClone(f.migrate));
  const result = dammPumpRevenueAnalyticsSources(f.book);
  assert.equal(result.complete, true); assert.equal(result.creationComplete, true);
  assert.deepEqual(result.sources.map(row => [row.kind, row.amount]), [['creation', '10000000'], ['protocol-fees', '20000000'], ['graduation', '322369073']]);
  assert(!JSON.stringify(result).includes(f.initialize.signedTransaction)); assert.deepEqual(f.book.launches, original.launches);
});

test('creation budgets, missing ALT data, wrong signature or missing wire never become earned revenue', () => {
  for (const change of [f => delete f.initialize.signedTransaction, f => delete f.initialize.bundle.addressLookupTables, f => { f.initialize.signature = f.initialize.result.signature = sig(9); }, f => { f.launch.creationFee.lamports = '999999999'; }, f => { f.launch.creationFee.recipient = key(); }]) {
    const f = fixture(); change(f); const result = dammPumpRevenueAnalyticsSources(f.book);
    assert.equal(result.creationComplete, false); assert.equal(result.sources.some(row => row.kind === 'creation'), false);
  }
});

test('pending, confirmed-only, failed and wrong-destination fee receipts cannot increase the total', () => {
  for (const change of [f => { f.protocol.state = 'pending'; }, f => { f.protocol.result.state = 'confirmed'; }, f => { f.protocol.result.signature = sig(4); }, f => { f.protocol.result.protocolFee.recipient = key(); }]) {
    const f = fixture(); change(f); const result = dammPumpRevenueAnalyticsSources(f.book);
    assert.equal(result.complete, false); assert.equal(result.sources.some(row => row.kind === 'protocol-fees'), false);
  }
});

test('wrong fee math, mint or receipt signature and an unverified migration remain incomplete', () => {
  for (const change of [f => { f.migrate.result.graduationFee.verified = false; }, f => { f.migrate.result.poolQuoteRaw = '1'; }, f => { f.migrate.result.graduationFee.quoteMint = key(); }, f => { f.migrate.result.graduationFee.signature = sig(4); }, f => { f.migrate.result.phase = 'trading'; }]) {
    const f = fixture(); change(f); const result = dammPumpRevenueAnalyticsSources(f.book);
    assert.equal(result.complete, false); assert.equal(result.sources.some(row => row.kind === 'graduation'), false);
  }
});

test('atomic buy graduation counts the same proven graduation fee', () => {
  const f = fixture(); f.migrate.action = 'buy'; f.migrate.bundle = { atomicGraduation: true };
  assert.equal(dammPumpRevenueAnalyticsSources(f.book).sources.find(row => row.kind === 'graduation').amount, '322369073');
  delete f.migrate.bundle.atomicGraduation; assert.equal(dammPumpRevenueAnalyticsSources(f.book).complete, false);
});

test('conflicting duplicates are removed and missing retained operations downgrade coverage', () => {
  const f = fixture(), duplicate = structuredClone(f.protocol); duplicate.result.protocolFee.quoteRaw = '30000000'; f.book.operations.push(duplicate);
  const result = dammPumpRevenueAnalyticsSources(f.book); assert.equal(result.complete, false); assert(!result.sources.some(row => row.kind === 'protocol-fees'));
  const g = fixture(); g.book.operations = []; const missing = dammPumpRevenueAnalyticsSources(g.book); assert.equal(missing.complete, false); assert.equal(missing.creationComplete, false); assert.deepEqual(missing.sources, []);
});

test('legacy zero-graduation controllers and zero/self creation fees are not invented as income', () => {
  const f = fixture(); f.launch.publicProgramId = key(); f.launch.creationFee.lamports = '0'; delete f.migrate.result.graduationFee; f.migrate.result.graduationFeeRaw = '0';
  const result = dammPumpRevenueAnalyticsSources(f.book); assert.equal(result.complete, true); assert.equal(result.creationComplete, true); assert.deepEqual(result.sources.map(row => row.kind), ['protocol-fees']);
  f.launch.creatorWallet = f.initialize.wallet = POLICY.treasury; f.launch.creationFee.lamports = '10000000'; assert.equal(dammPumpRevenueAnalyticsSources(f.book).creationComplete, true);
});

test('production projection flows through admin and public totals without counting missing history as complete zero', async () => {
  const f = fixture(), treasury = POLICY.treasury, now = Date.now();
  const accounts = { list: async () => [], hostStore: { read: async () => ({ recipient: treasury, recipientScope: 'launchpad', creationFeeSol: '0.01' }) } };
  const service = new AdminRevenue({ accounts, toolkit: false, launchpad: {}, dammPumpRevenueSources: async () => dammPumpRevenueAnalyticsSources(f.book), now: () => now });
  const report = await service.snapshot(), product = report.products.find(row => row.id === 'damm-pump');
  assert.equal(product.totals[0].grossAmount, '342369073'); assert.equal(report.products.find(row => row.id === 'creation').totals[0].grossAmount, '10000000');
  const result = publicRevenueAnalytics(report, { now, pricesByMint: new Map([[SOL, { mint: SOL, at: now, usd: 100 }]]) });
  assert.equal(result.complete, true); assert.equal(result.totalUsdEstimate, 35.2369073); assert(result.coverage.sources.includes('damm-pump'));
  f.book.operations = []; const incomplete = publicRevenueAnalytics(await service.snapshot(), { now }); assert.equal(incomplete.complete, false); assert.equal(incomplete.totalUsdEstimate, null); assert.equal(incomplete.pricedUsdEstimate, null);
});
