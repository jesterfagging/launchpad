// Starts (white-label launchpads): Raydium and Meteora coins can start at $20,000 or $4,000; both graduate at $50,000.
// The launch model picks the curve policy from the start, public launches accept only the starts the host offers,
// and the curve math holds on the real SDKs and the real SOL LaunchLab limits (skipped where the SDKs are not installed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launchInput, newLaunchCurvePolicy, LAUNCH_CURVE_POLICY, LAUNCH_CURVE_POLICY_4K } from '../public/launchpad-model.mjs';

const raw = { name: 'Moon', symbol: 'MOON', feeMode: 'creator', quoteMint: 'So11111111111111111111111111111111111111112', creatorFeePercent: '0.50', devBuySol: '0' };

test('the start picks the Raydium curve policy: $20K keeps 2.5x, $4K graduates at $50K', () => {
  assert.deepEqual(newLaunchCurvePolicy({ targetUsd: '20000' }), { curvePolicy: LAUNCH_CURVE_POLICY, graduationTargetUsd: '50000' });
  assert.deepEqual(newLaunchCurvePolicy({ targetUsd: '4000' }), { curvePolicy: LAUNCH_CURVE_POLICY_4K, graduationTargetUsd: '50000' });
  assert.deepEqual(newLaunchCurvePolicy({ targetUsd: '40000' }), { curvePolicy: LAUNCH_CURVE_POLICY, graduationTargetUsd: '100000' }, 'administrator starts keep the 2.5x model');
});

test('public launches take only the starts the host offers', () => {
  assert.equal(launchInput({ ...raw, targetUsd: '20000' }, { marketCapPolicy: 'public' }).targetUsd, '20000');
  assert.throws(() => launchInput({ ...raw, targetUsd: '4000' }, { marketCapPolicy: 'public' }), /start at a \$20,000 market cap/);
  const both = { marketCapPolicy: 'public', publicStarts: [20000, 4000] };
  const low = launchInput({ ...raw, targetUsd: '4000' }, both);
  assert.equal(low.targetUsd, '4000'); assert.equal(low.curvePolicy, LAUNCH_CURVE_POLICY_4K); assert.equal(low.graduationTargetUsd, '50000');
  assert.throws(() => launchInput({ ...raw, targetUsd: '5000' }, both), /Choose a starting market cap: \$20,000 or \$4,000/);
  assert.throws(() => launchInput({ ...raw, targetUsd: '20000' }, { marketCapPolicy: 'public', publicStarts: [4000] }), /start at a \$4,000 market cap/);
  assert.throws(() => launchInput({ ...raw, targetUsd: '4000' }, { marketCapPolicy: 'admin' }), /between \$20,000 and \$100,000/, 'administrators keep their own range');
});

test('the $4K curve fits the real SOL LaunchLab limits and graduates at $50K', async t => {
  let curve, ray;
  try { ({ rayCurveAtGraduationTarget: curve } = await import('../src/launchpad-curve-target.mjs')); ray = (await import('node:module')).createRequire(import.meta.url)('@raydium-io/raydium-sdk-v2'); }
  catch { t.skip('the Raydium SDK is not installed here'); return; }
  const fixture = JSON.parse(readFileSync(new URL('./launchpad-accounts.json', import.meta.url)));
  const sol = ray.LaunchpadConfig.decode(Buffer.from(fixture.rayConfig.account.data[0], 'base64'));
  assert.equal(sol.minMigrateRateA.toString(), '150000'); assert.equal(sol.minFundRaisingB.toString(), '24000000000');
  for (const usd of ['40', '100', '150', '250', '400']) {
    const result = curve(sol, 9, usd, '4000', '50000');
    assert.ok(Math.abs(Number(result.actualUsd) - 4000) < 0.01, usd); assert.ok(Math.abs(Number(result.graduationUsd) - 50000) < 0.01, usd);
    const sold = Number(result.sell) / Number(result.supply), k = Math.sqrt(50000 / 4000);
    assert.ok(Math.abs(sold - k / (1 + k)) < 1e-9, 'about 78% of the supply is sold on the curve');
    assert.ok(1 - sold >= 0.15, 'the rest clears the 15% migration minimum');
  }
});

test('a Meteora launch records its start in its policy; the curve builds for both starts', async t => {
  let policy;
  try { policy = await import('../src/meteora-policy.mjs'); } catch { t.skip('the Meteora SDK is not installed here'); return; }
  assert.equal(policy.meteoraPolicy({}).initialFdvUsd, 20000, 'a launch without a start is a $20K launch');
  assert.equal(policy.meteoraPolicy({ migrationFeePercentage: 0, initialFdvUsd: 4000 }).initialFdvUsd, 4000);
  assert.equal(policy.meteoraPolicy({ preset: 'gotchi-1pct-v1', initialFdvUsd: 4000 }).tradingFeeBps, 252, 'a fee preset keeps its numbers');
  assert.throws(() => policy.meteoraPolicy({ initialFdvUsd: 5000 }), /Unknown Meteora starting market cap/);
  for (const usd of [40, 150, 250]) for (const initialFdvUsd of [20000, 4000]) {
    const config = policy.meteoraCurveConfig({ quoteUsd: usd, quoteDecimals: 9, policy: { migrationFeePercentage: 0, initialFdvUsd } });
    assert.ok(config && config.curve?.length, `${initialFdvUsd} at $${usd}`);
  }
});
