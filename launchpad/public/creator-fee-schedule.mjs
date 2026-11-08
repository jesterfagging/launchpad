// Raydium LaunchLab permits at most 5,000 parts per million (0.50%).
// New taxed holder reviews use zero curve creator fees; other modes use 0.5%.
// Historical records retain their confirmed rate
// until an explicit, receipt-verified policy upgrade succeeds.
export const CREATOR_FEE_POLICY = 'flat-0.5-v2';
export const CREATOR_FEE_RATE_PPM = 5000;
export const HOLDER_CREATOR_FEE_POLICY = 'taxed-holders-0-v3';
export function creatorFeeForLaunch(input={}) {
  return input.feeMode==='holders'&&Number.isInteger(input.taxBps)&&input.taxBps>0
    ? {policy:HOLDER_CREATOR_FEE_POLICY,ratePpm:0,ratePercent:0}
    : {policy:CREATOR_FEE_POLICY,ratePpm:CREATOR_FEE_RATE_PPM,ratePercent:0.5};
}
export const CREATOR_FEE_MAX_PPM = 5000;
// Retain these exports for a browser with an older cached launch page. There
// these helpers retain the flat creator/buyback rate without price tiers.
export const CREATOR_FEE_TIERS = Object.freeze([Object.freeze({fromSol:0,toSol:null,ratePpm:CREATOR_FEE_RATE_PPM})]);
export const creatorFeeForSol = () => ({policy:CREATOR_FEE_POLICY,ratePpm:CREATOR_FEE_RATE_PPM,ratePercent:0.5});
export const creatorFeeForUsd = creatorFeeForSol;
export const creatorFeeForQuote = creatorFeeForSol;
export function validCreatorFeeRate(value) {return Number.isSafeInteger(value)&&value>=0&&value<=CREATOR_FEE_MAX_PPM;}
export function effectiveCreatorFeeRate(launch) {
  const confirmed=launch.creatorFees?.ratePpm,reviewed=launch.review?.creatorFeeRatePpm;
  const value=confirmed??reviewed??Number(launch.input?.creatorFeeBps)*100;
  if(!validCreatorFeeRate(value))throw Error('Invalid creator fee rate.');return value;
}
