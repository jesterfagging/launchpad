// Compatibility shim for integrations from the retired market-cap fee schedule.
// v33 never starts a tier worker or queues a rate change from a price observation.
// Pending historical receipts are still reconciled by Launchpad.
export const CREATOR_FEE_CHECK_MS=60_000;
export const creatorFeeEligible=()=>false;
export const creatorFeeDecision=()=>({status:'deferred',reason:'explicit_policy_upgrade_required'});
export class LaunchCreatorFees {
  start(){}
  async tick(){}
  async close(){}
}
