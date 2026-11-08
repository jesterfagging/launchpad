import { requireValue as ok } from '../public/launchpad-model.mjs';
import { officialTaxBurnScope, officialTaxBurnConfigured } from './launchpad-tax-burn.mjs';
import { autoRewardEnabled, scheduleRewardRetry } from './launchpad-reward-recovery.mjs';
import { TAX_PROTOCOL_POLICY } from './launchpad-tax-protocol.mjs';

export const TAX_MAINTENANCE_POLICY = 'official-token-tax-maintenance-v1';
export const TAX_MAINTENANCE_INTERVAL_MS = 60_000;
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;

// Only the already-enabled official policy receives an independent schedule.
// A user pause, unresolved signed operation or unfinished wallet handoff never
// grants permission for another transaction.
export function officialTaxMaintenanceEnabled(launch) {
  return officialTaxBurnScope(launch) && officialTaxBurnConfigured() && autoRewardEnabled(launch) &&
    launch.state === 'live' && !!launch.curve && !!launch.authorizedAt &&
    launch.rewardsWallet?.status === 'active' &&
    ['base', 'quote', 'protocolQuote', 'taxBase'].every(key => launch.rewardsWallet.creatorCredits?.[key] === '0') &&
    !['queued', 'processing'].includes(launch.heldSolDistribution?.state);
}

export function officialTaxMaintenanceAt(launch) {
  if (!officialTaxMaintenanceEnabled(launch) || launch.operations.some(op => ['pending', 'awaiting_signature'].includes(op.state))) return Infinity;
  return validTime(launch.taxMaintenance?.nextAt) ? launch.taxMaintenance.nextAt : 0;
}

export function beginOfficialTaxMaintenance(launch, now) {
  ok(validTime(now) && officialTaxMaintenanceAt(launch) <= now, 'Official LAUNCHPAD tax maintenance is not due.');
  const previous = launch.taxMaintenance;
  ok(!previous || previous.version === 1 && validTime(previous.nextAt), 'Invalid official LAUNCHPAD tax maintenance schedule.');
  launch.taxMaintenance = { ...previous, version: 1, lastAttemptAt: now, nextAt: now + TAX_MAINTENANCE_INTERVAL_MS };
}

// The saved marker distinguishes an independent tax receipt from older tax
// operations whose confirmation advances a reward cycle. Runtime gates do not
// invalidate already-signed receipts.
export function officialTaxMaintenanceOperation(launch, operation) {
  if (operation?.taxMaintenancePolicy === undefined) return false;
  ok(operation.taxMaintenancePolicy === TAX_MAINTENANCE_POLICY && officialTaxBurnScope(launch) &&
    ['tax', 'tax-burn'].includes(operation.kind) && operation.rewardsWallet?.source === 'rewards' &&
    operation.rewardsWallet.address === launch.rewardsWallet.address &&
    operation.rewardsWallet.signerSource === (operation.kind === 'tax' ? 'wallet' : 'rewards') &&
    (operation.kind !== 'tax' || operation.taxProtocolPolicy === TAX_PROTOCOL_POLICY),
  'Invalid official LAUNCHPAD tax maintenance operation.');
  return true;
}

export function completeOfficialTaxMaintenance(launch, operation, now, collectedBase = 0n) {
  ok(officialTaxMaintenanceOperation(launch, operation) && validTime(now), 'Invalid official LAUNCHPAD tax maintenance receipt.');
  launch.taxMaintenance = { version: 1, lastAttemptAt: launch.taxMaintenance?.lastAttemptAt ?? now,
    lastCompletedAt: now, nextAt: now + (operation.kind === 'tax' && collectedBase > 0n ? 1_000 : TAX_MAINTENANCE_INTERVAL_MS) };
}

export function retryOfficialTaxMaintenance(launch, error, now) {
  // Reuse the established funding/RPC/gas-budget classification on a private
  // copy. Its retry decision must not enable automation, clear a holder retry,
  // or replace the saved SOL payout cycle on the actual launch.
  if (!autoRewardEnabled(launch)) return false;
  const copy = { ...launch, rewardRetry: launch.taxMaintenance?.retry };
  if (!scheduleRewardRetry(copy, error, now)) return false;
  launch.taxMaintenance = { ...launch.taxMaintenance, version: 1, nextAt: copy.rewardRetry.at, retry: copy.rewardRetry };
  return true;
}
