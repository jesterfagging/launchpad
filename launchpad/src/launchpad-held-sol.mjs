import {isCurrentLaunch,SOL_MINT} from '../public/launchpad-model.mjs';
import {dedicatedRewardsWallet,rewardsCreatorCredits,requireManagedRewardSource} from './launchpad-rewards-wallet.mjs';
import {nativeRewardDebtState} from './launchpad-native-reward-debts.mjs';

export const heldSolActive=l=>['queued','processing'].includes(l?.heldSolDistribution?.state);
const pauseMessage='Fee service paused. Pending receipts will still be reconciled.';
export const HELD_SOL_BUSY='A saved operation or reward cycle is already in progress.';
export function heldSolScopeReason(l){
  if(!isCurrentLaunch(l?.input)||l.input.route!=='raydium'||l.input.feeMode!=='holders'||l.input.quoteMint!==SOL_MINT)return 'Only SOL-paired Raydium holder rewards are eligible.';
  if(l.input.gotchi)return 'Gotchi launches route their rewards to the Gotchi pot, not to holders.';
  if(!l.curve||!l.authorizedAt||!['live','paused'].includes(l.state)||l.recovery)return 'The launch is not ready for a holder payout.';
  return '';
}
export function heldSolWaitReason(l){
  if((l.operations||[]).some(op=>op.state==='awaiting_signature'))return 'Waiting for the saved wallet signature. Complete or cancel it in this coin’s controls; this request will check again automatically.';
  if((l.operations||[]).some(op=>op.state==='pending'))return 'Waiting for the saved transaction to confirm. This request will continue automatically afterward.';
  if(l.rewardRetry||l.retry)return 'Waiting for the saved reward retry. Check this coin’s retry reason and service gas; this request will check again automatically.';
  if(l.state==='paused'||l.error)return 'The existing reward cycle is paused. Review this coin’s service error and use Resume rewards; this distribution request remains queued.';
  return 'Waiting for the existing reward cycle to finish. This request will check the remaining SOL reward credit automatically.';
}
export function heldSolEligibility(l,{mint}={}){
  const scope=heldSolScopeReason(l);if(scope)return scope;
  if(l.keys?.wallet?.address===l.keys?.payer?.address)return 'A personal creator wallet is not eligible for bulk managed payouts.';
  if(mint!==undefined&&l.keys?.mint?.address!==mint)return 'The launch mint changed. Refresh the token list.';
  if(l.cycle||l.feesRequested||(l.operations||[]).some(op=>['pending','awaiting_signature'].includes(op.state))||heldSolActive(l))return HELD_SOL_BUSY;
  if(l.error&&l.error!==pauseMessage||l.rewardRetry||l.retry||l.protocolFeesRequested||l.brandingRequested)return 'Resolve the saved service issue before starting this payout.';
  try{
    requireManagedRewardSource(l);
    if(l.rewardsWallet?.status!=='active'||!dedicatedRewardsWallet(l))return 'The dedicated rewards wallet is not ready.';
    if(Object.values(rewardsCreatorCredits(l)).some(value=>BigInt(value)!==0n))return 'Reward custody migration must finish before this payout.';
    nativeRewardDebtState(l);
    if(BigInt(l.credits.quote)<=0n)return 'No confirmed SOL reward credit is available.';
  }catch{return 'The reward custody or earned-credit ledger needs review.';}
  return '';
}
export function heldSolView(request){
  if(!request)return {state:'skipped',reason:'No matching distribution request was recorded.'};
  const result={state:request.state,reason:request.reason||'',requestId:request.requestId,amountLamports:request.amountLamports};
  for(const key of ['paidLamports','remainingLamports','deferredLamports','deferredWallets','createdAt','completedAt'])if(request[key]!==undefined)result[key]=request[key];
  return result;
}
export function heldSolFailureReason(error){
  if(error?.code==='REWARD_GAS_BUDGET')return 'The daily reward network-cost budget is used. Try again after midnight UTC; unpaid rewards remain reserved.';
  if(['REWARD_NATIVE_FUNDS','REWARD_SOL_REQUIRED','REWARD_RENT_REQUIRED'].includes(error?.code)||/insufficientfundsforrent|insufficientfundsforfee|insufficient (?:SOL|lamports)|insufficient funds for (?:rent|fee)/i.test(String(error?.message||'')))return 'The rewards wallet needs SOL for network fees or account rent. Unpaid rewards remain reserved.';
  if(error?.message==='Administrator access with two-factor authentication is required.')return 'Administrator authorization is no longer valid. Unpaid rewards remain reserved.';
  if(['ECONNRESET','ETIMEDOUT','ECONNABORTED','EAI_AGAIN','ENETUNREACH','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT','LAUNCH_SIMULATION_BLOCKHASH','LAUNCH_BLOCKHASH_EXPIRED','REWARD_ACCOUNT_SCAN_RETRY'].includes(error?.code)||[408,429,500,502,503,504,-32016].includes(Number(error?.status||error?.statusCode||error?.code)))return 'The RPC was temporarily unavailable before submission. Try again; unpaid rewards remain reserved.';
  return 'The payout could not be prepared safely. Unpaid reward credits remain reserved.';
}
