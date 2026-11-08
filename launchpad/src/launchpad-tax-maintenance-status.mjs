import { publicRewardRetry } from './launchpad-reward-recovery.mjs';

const stamp=value=>Number.isSafeInteger(value)&&value>0&&value<=8640000000000000?value:null;

// A read-only allowlist: public views expose timing, while administrator views
// also expose the sanitized retry reason needed to identify funding blockers.
export function publicTaxMaintenance(launch,{includeReason=false}={}){
  const value=launch.taxMaintenance;if(value?.version!==1)return null;
  const retry=publicRewardRetry({rewardRetry:value.retry});
  return {nextAt:stamp(value.nextAt),lastAttemptAt:stamp(value.lastAttemptAt),lastCompletedAt:stamp(value.lastCompletedAt),retry:retry?{at:retry.at,attempt:retry.attempt,kind:retry.kind,...(includeReason?{reason:retry.reason}:{})}:null};
}
