import {isCurrentLaunch,requireValue as ok} from '../public/launchpad-model.mjs';
import {autoRewardEnabled} from './launchpad-reward-recovery.mjs';
import {requireManagedRewardSource,rewardsCreatorCredits,TAX_BURN_MINT,TAX_BURN_WALLET} from './launchpad-rewards-wallet.mjs';
import {nativeRewardDebtState} from './launchpad-native-reward-debts.mjs';
import {manualHolderDistribution} from './launchpad-manual-distribution.mjs';
import {savedAtaPayoutFailure} from './launchpad-ata-recovery.mjs';

export const REWARD_INVENTORY_RECHECK_MS=60000;
const errors=new Set([
  'LAUNCHPAD tax burn exceeds its verified rewards-wallet inventory.',
  'The creator rewards token account cannot cover its saved credits.',
]);
const time=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000;

// Recheck only the exact stopped inventory or saved ATA payout batch. A fresh
// successful read-only simulation can establish that the old payout failure
// is gone; its custom error number alone never authorizes another transaction.
function recoveryError(l,now){
  if(!time(now)||!time(now+REWARD_INVENTORY_RECHECK_MS)||!l||!['paused','error'].includes(l.state)||
    l.input?.feeMode!=='holders'||!isCurrentLaunch(l.input)||!l.curve||
    !time(l.authorizedAt)||l.authorizedAt===0||l.authorizedAt>now||!autoRewardEnabled(l)||
    !Array.isArray(l.operations)||l.operations.some(op=>['pending','awaiting_signature'].includes(op.state))||
    ['queued','processing'].includes(l.heldSolDistribution?.state))return '';
  if(!errors.has(l.error)&&!savedAtaPayoutFailure(l))return '';
  if(l.error==='LAUNCHPAD tax burn exceeds its verified rewards-wallet inventory.'&&
    (l.keys?.mint?.address!==TAX_BURN_MINT||l.keys?.rewards?.address!==TAX_BURN_WALLET))return '';
  try{
    requireManagedRewardSource(l);rewardsCreatorCredits(l);nativeRewardDebtState(l);
    const request=manualHolderDistribution(l);
    if(request&&(request.pausedByAdmin||request.state==='blocked'&&request.reason!==l.error))return '';
  }catch{return '';}
  return l.error;
}

function validAttempt(value,error,now){
  return value?.version===1&&value.error===error&&time(value.lastAttemptAt)&&value.lastAttemptAt<=now&&
    time(value.nextCheckAt)&&value.nextCheckAt===value.lastAttemptAt+REWARD_INVENTORY_RECHECK_MS&&
    Number.isSafeInteger(value.attempt)&&value.attempt>=1&&value.attempt<=1000000;
}

export function rewardInventoryRecoveryDueAt(l,now){
  const error=recoveryError(l,now);if(!error)return Infinity;
  return validAttempt(l.rewardInventoryRecovery,error,now)?l.rewardInventoryRecovery.nextCheckAt:now;
}

export async function recoverRewardInventory(l,{now,read,persist,closed=()=>false}){
  if(rewardInventoryRecoveryDueAt(l,now)>now)return false;
  const error=l.error,previous=l.rewardInventoryRecovery;
  const attempt=validAttempt(previous,error,now)?Math.min(previous.attempt+1,1000000):1;
  l.rewardInventoryRecovery={version:1,error,attempt,lastAttemptAt:now,nextCheckAt:now+REWARD_INVENTORY_RECHECK_MS};
  await persist(); // Durable backoff precedes every read, including restarts.
  let evidence;
  try{evidence=await read(structuredClone(l),{error});}catch{return false;}
  if(closed()||recoveryError(l,now)!==error)return false;
  const confirmedSlot=l.operations.reduce((slot,op)=>op.state==='confirmed'&&Number.isSafeInteger(op.slot)?Math.max(slot,op.slot):slot,1);
  if(!Number.isSafeInteger(evidence?.slot)||evidence.slot<confirmedSlot)return false;
  const before=structuredClone(l);
  try{
    const request=manualHolderDistribution(l);
    if(request?.state==='blocked'){
      ok(request.reason===error&&!request.pausedByAdmin,'The manual reward pause changed.');
      request.state=l.cycle?'processing':'queued';delete request.reason;
    }
    if(l.rewardRetry?.reason===error)delete l.rewardRetry;
    if(l.taxMaintenance?.retry?.reason===error){
      if(l.taxMaintenance.nextAt===l.taxMaintenance.retry.at)l.taxMaintenance.nextAt=now;
      delete l.taxMaintenance.retry;
    }
    l.state='live';l.autoFees=true;l.feesRequested=true;l.error='';
    l.rewardInventoryRecovery={...l.rewardInventoryRecovery,verifiedAt:now,verifiedSlot:evidence.slot};
    await persist();return true;
  }catch(error){
    for(const key of Object.keys(l))delete l[key];Object.assign(l,before);throw error;
  }
}
