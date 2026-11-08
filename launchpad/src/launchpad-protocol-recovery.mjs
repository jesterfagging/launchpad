import { classifyRewardFailure } from './launchpad-reward-recovery.mjs';
import { managedProtocolWallet } from './launchpad-protocol-wallet.mjs';

const validTime=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000;
const stages=new Set(['claim','lp','payout']);
export const protocolRetryAt=launch=>validTime(launch.protocolRetry?.at)?launch.protocolRetry.at:0;

// A protocol collection has its own authorization, stages and retry clock.
// Never turn it into holder automation or discard a saved signed transaction.
export function retryProtocolCollection(launch,error,now){
  if(!validTime(now)||!launch.curve||!launch.authorizedAt||!managedProtocolWallet(launch)||
    !stages.has(launch.protocolClaimStage)||!(launch.protocolFeesRequested||launch.review?.protocolFees?.autoHarvest))return false;
  const kind=classifyRewardFailure(error);
  if(!['funding','network','gas-budget'].includes(kind))return false;
  const prior=launch.protocolRetry?.attempt;
  const attempt=Math.min(1000000,(Number.isSafeInteger(prior)&&prior>0?prior:0)+1);
  const delay=kind==='funding'?60000:Math.min(15*60000,15000*2**Math.min(attempt-1,6));
  const at=kind==='gas-budget'?(Math.floor(now/86400000)+1)*86400000+1000:now+delay;
  if(!validTime(at))return false;
  const reason=String(error?.message||error||'Collection will retry.').replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi,'[provider]').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,300);
  launch.protocolRetry={at,attempt,kind,reason};
  launch.protocolFeesRequested=true;
  launch.protocolError=kind==='funding'?'Protocol fee collection is waiting for SOL and will retry automatically.':kind==='gas-budget'?'Protocol fee collection will continue after the daily gas budget resets.':'Protocol fee collection is waiting for the RPC and will retry automatically.';
  return true;
}
