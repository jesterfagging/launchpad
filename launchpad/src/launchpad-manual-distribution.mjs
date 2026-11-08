import {requireValue as ok} from '../public/launchpad-model.mjs';
import {taxProtocolLedger,TAX_PROTOCOL_POLICY} from './launchpad-tax-protocol.mjs';
import {autoRewardEnabled,scheduleRewardRetry,clearRewardRetry} from './launchpad-reward-recovery.mjs';

const activeStates=new Set(['queued','processing','waiting','blocked']);
const audit=(l,id)=>(l.adminRewardHistory||[]).find(row=>row.action==='distribute'&&row.requestId===id&&row.actorId&&row.launchId===l.id);
export const MANUAL_REWARD_AUTH_ERROR='The administrator who authorized this manual reward sweep no longer has access. Use Distribute now from a current administrator to continue.';
export function manualHolderAuthorizer(l,requestId){
  // A new audited Distribute action may explicitly continue the same saved
  // sweep. Replaying an older HTTP request cannot replace that authorization.
  return [...(l.adminRewardHistory||[])].reverse().find(row=>row.action==='distribute'&&row.launchId===l.id&&row.actorId&&(row.requestId===requestId||row.coalescedRequestId===requestId))?.actorId;
}
const units=value=>{ok(typeof value==='string'&&/^\d+$/.test(value),'Invalid manual reward sweep accounting.');return BigInt(value);};
export function manualHolderDistribution(l){
  const request=l.manualHolderDistribution;
  if(!request||!activeStates.has(request.state))return null;
  ok(request.version===1&&request.requestId===l.holderDistributionAdminRequest&&audit(l,request.requestId),'Manual reward sweep authorization does not match its saved request.');
  return request;
}
export function queueManualHolderDistribution(l,requestId,now){
  ok(l.input.feeMode==='holders'&&l.curve&&l.authorizedAt&&audit(l,requestId)&&l.holderDistributionAdminRequest===requestId,'Manual reward sweep requires an authorized administrator request.');
  const prior=manualHolderDistribution(l);
  if(prior){
    ok(prior.requestId===requestId,'A manual reward sweep is already queued.');
    if(prior.state!=='blocked')return prior;
    prior.state='queued';delete prior.reason;delete prior.pausedByAdmin;
  }else l.manualHolderDistribution={version:1,requestId,state:'queued',phase:l.cycle?'existing':'collect',createdAt:now,previousState:l.state,operationIndex:l.operations.length};
  const pending=l.operations.find(op=>['pending','awaiting_signature'].includes(op.state));
  if(pending)delete pending.receiptCheckAfter;
  l.state=pending?.state==='awaiting_signature'?'awaiting_signature':'live';
  l.feesRequested=true;l.manualFeesRequested=true;l.error='';delete l.retry;clearRewardRetry(l);
  return l.manualHolderDistribution;
}
export function startManualHolderCycle(l,now){
  const request=manualHolderDistribution(l);
  if(!request||request.state==='blocked'||l.cycle)return false;
  request.state='processing';request.phase='collect';
  l.cycle={stage:'claim',index:0,createdAt:now,manual:true,manualHolderDistributionRequest:request.requestId};
  return true;
}
export function manualHolderCycle(l){
  const request=manualHolderDistribution(l);
  return request&&l.cycle?.manualHolderDistributionRequest===request.requestId?request:null;
}
export function snapshotManualHolderBase(l,now,{burnOnly=false}={}){
  const request=manualHolderCycle(l);if(!request)return null;
  if(request.snapshotAt===undefined){
    const tax=burnOnly?0n:units(taxProtocolLedger(l).sourceBaseCredit),base=burnOnly?0n:units(l.credits.base);
    if(burnOnly)request.reservedForBurnBaseUnits=l.credits.base;
    ok(tax<=base,'Manual reward tax credit exceeds earned base credit.');
    Object.assign(request,{snapshotAt:now,initialBaseUnits:base.toString(),remainingTaxBaseUnits:tax.toString(),remainingBaseUnits:(base-tax).toString(),soldBaseUnits:'0',phase:'convert'});
  }
  return request;
}
export function manualHolderConversionSource(l){
  const request=manualHolderCycle(l);ok(request?.snapshotAt!==undefined,'The manual reward sweep has no saved balance snapshot.');
  const tax=units(request.remainingTaxBaseUnits),ordinary=units(request.remainingBaseUnits),ledgerTax=units(taxProtocolLedger(l).sourceBaseCredit),base=units(l.credits.base);
  ok(tax<=ledgerTax&&ordinary<=base-ledgerTax,'Manual reward sweep exceeds its earned source credit.');
  return tax>0n&&!request.skipTaxConversion?{credit:tax.toString(),operationData:{taxProtocolPolicy:TAX_PROTOCOL_POLICY,taxSource:'withheld-tax',manualHolderDistributionRequest:request.requestId}}:{credit:ordinary.toString(),operationData:{manualHolderDistributionRequest:request.requestId}};
}
export function settleManualHolderConversion(l,op,spent){
  if(op.manualHolderDistributionRequest===undefined)return false;
  const request=manualHolderCycle(l);
  ok(request&&request.requestId===op.manualHolderDistributionRequest&&request.snapshotAt!==undefined,'Manual reward conversion receipt does not match its saved request.');
  const field=op.taxSource==='withheld-tax'?'remainingTaxBaseUnits':'remainingBaseUnits',amount=BigInt(spent),remaining=units(request[field]);
  ok(amount>0n&&amount<=remaining,'Manual reward conversion exceeds its saved source budget.');
  request[field]=(remaining-amount).toString();request.soldBaseUnits=(units(request.soldBaseUnits)+amount).toString();if(request.state!=='blocked'){request.state='processing';request.phase='convert';delete request.reason;}
  return true;
}
export function retryManualHolderDistribution(l,error,now){
  const request=manualHolderDistribution(l);if(!request||request.state==='blocked')return false;
  // A one-off administrative request can retry without changing the saved
  // automation preference. Reuse the same strict failure classifier on a copy.
  const copy={...l,feeAutomation:{enabled:true},autoFees:true};
  if(!scheduleRewardRetry(copy,error,now))return false;
  l.rewardRetry=copy.rewardRetry;l.state='live';l.autoFees=autoRewardEnabled(l);l.feesRequested=true;
  request.state='waiting';request.reason=copy.rewardRetry.reason;
  l.error=copy.rewardRetry.kind==='funding'?'Manual rewards are waiting for SOL and will retry automatically.':copy.rewardRetry.kind==='gas-budget'?'Manual rewards will continue after the daily gas budget resets.':'Manual rewards are waiting to retry automatically.';
  return true;
}
export function finishManualHolderDistribution(l,now){
  const request=manualHolderCycle(l);if(!request)return false;
  const remainder=units(request.remainingTaxBaseUnits||'0')+units(request.remainingBaseUnits||'0');
  request.state=remainder>0n||units(l.credits.quote)>0n?'partial':'completed';request.phase='done';request.completedAt=now;
  request.remainingQuoteUnits=l.credits.quote;request.distributedQuoteUnits=l.cycle.distributedQuoteUnits||'0';
  request.reason=remainder>0n?(request.reason||'The remaining token amount cannot currently produce an executable guarded swap; it remains reserved.'):
    units(l.credits.quote)>0n?(l.cycle.eligibleBalance==='0'&&!l.cycle.payouts?.length&&!l.nativeRewardDebts?.payouts?.length?'No eligible holders were found. The remaining quote rewards stay reserved.':'Unpaid or rounding amounts remain reserved in reward credits.'):'Confirmed reward conversions and payout batches completed.';
  const event=audit(l,request.requestId);event.status=request.state;event.completedAt=now;
  return true;
}
