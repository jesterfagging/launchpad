// Validates the frozen Gotchi fee presets against the installed SDKs without
// touching the network: the Meteora 2.52% preset must build and validate a
// bonding-curve configuration for SOL and USDC quotes, and the Raydium Gotchi
// launch model must normalise to the documented 1% transfer tax. Run with:
//   node scripts/check-gotchi-policy.mjs
import { meteoraCurveConfig, meteoraFeeNumerator, meteoraFeeShares, meteoraPolicy } from '../src/meteora-policy.mjs';
import { GOTCHI_METEORA_POLICY, GOTCHI_RAYDIUM_TAX_BPS, GOTCHI_THEMES, gotchiFundingSummary } from '../public/gotchi-catalog.mjs';
import { launchInput } from '../public/launchpad-model.mjs';

const check = (condition, message) => { if (!condition) { console.error('FAIL ' + message); process.exitCode = 1; } else console.log('ok   ' + message); };

const policy = meteoraPolicy(GOTCHI_METEORA_POLICY);
check(policy.tradingFeeBps === 252 && policy.creatorSharePercent === 50 && policy.partnerSharePercent === 50 && policy.migrationFeePercentage === 0, 'Gotchi Meteora preset resolves to 2.52% / 50-50 with no graduation fee');
check(meteoraFeeNumerator(GOTCHI_METEORA_POLICY) === '25200000', 'Gotchi Meteora fee numerator is 25,200,000 / 1e9');
const shares = meteoraFeeShares(GOTCHI_METEORA_POLICY);
check(shares.creatorFeeBps === 100.8 && shares.partnerFeeBps === 100.8, 'Gotchi pot and protocol each receive 1.008% of Meteora volume');
for (const [label, quoteUsd, quoteDecimals] of [['SOL', 150, 9], ['SOL (low price)', 20, 9], ['SOL (high price)', 1200, 9], ['USDC', 1, 6]]) {
  try { const params = meteoraCurveConfig({ quoteUsd, quoteDecimals, policy: GOTCHI_METEORA_POLICY }); check(params && Array.isArray(params.curve) && params.curve.length > 0, `Meteora SDK validates the Gotchi curve configuration for ${label}`); }
  catch (error) { check(false, `Meteora SDK validates the Gotchi curve configuration for ${label}: ${error.message}`); }
}
let rejected = false; try { meteoraPolicy({ tradingFeeBps: 300 }); } catch { rejected = true; } check(rejected, 'Ad-hoc Meteora fee overrides are rejected');
rejected = false; try { meteoraPolicy({ preset: 'gotchi-1pct-v1', creatorSharePercent: 60 }); } catch { rejected = true; } check(rejected, 'Preset values cannot be altered after review');

const raydium = launchInput({ name: 'Check', symbol: 'CHK', feeMode: 'gotchi', gotchiId: GOTCHI_THEMES[0].id, targetUsd: '20000', devBuySol: '0' }, { marketCapPolicy: 'public' });
check(raydium.feeMode === 'holders' && raydium.taxBps === GOTCHI_RAYDIUM_TAX_BPS && raydium.gotchiId === GOTCHI_THEMES[0].id, 'Raydium Gotchi launches normalise to taxed holder rewards at 1%');
rejected = false; try { launchInput({ name: 'Check', symbol: 'CHK', feeMode: 'gotchi', gotchiId: GOTCHI_THEMES[0].id, taxPercent: '2', targetUsd: '20000', devBuySol: '0' }, { marketCapPolicy: 'public' }); } catch { rejected = true; } check(rejected, 'A Gotchi launch cannot choose a different transfer tax');
rejected = false; try { launchInput({ name: 'Check', symbol: 'CHK', feeMode: 'holders', gotchiId: GOTCHI_THEMES[0].id, taxPercent: '2', targetUsd: '20000', devBuySol: '0' }, { marketCapPolicy: 'public' }); } catch { rejected = true; } check(rejected, 'A Gotchi pairing requires the Gotchi reward option');
const raydiumFunding = gotchiFundingSummary('raydium'), meteoraFunding = gotchiFundingSummary('meteora');
check(raydiumFunding.transferTaxPercent === 1 && Math.abs(meteoraFunding.potPercent - 1.008) < 1e-9 && Math.abs(meteoraFunding.protocolPercent - 1.008) < 1e-9, 'Funding summaries disclose a 1% tax (Raydium) and 1.008% pot / 1.008% protocol (Meteora)');
console.log(process.exitCode ? 'Gotchi policy check failed.' : 'Gotchi policy check passed.');
