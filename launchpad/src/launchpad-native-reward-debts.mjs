import {PublicKey} from '@solana/web3.js';
import {SOL_MINT,requireValue as ok} from '../public/launchpad-model.mjs';

const MAX_UNITS=18446744073709551615n;
export const nativeHolderRewards=l=>l.input?.feeMode==='holders'&&l.input.quoteMint===SOL_MINT;
const units=value=>{ok(typeof value==='string'&&/^(?:0|[1-9]\d{0,19})$/.test(value)&&BigInt(value)<=MAX_UNITS,'Invalid reserved native reward amount.');return BigInt(value);};
const total=rows=>rows.reduce((sum,row)=>sum+units(row.amount),0n);
function rows(value){
  ok(Array.isArray(value),'Invalid reserved native reward recipients.');
  const seen=new Set();
  return value.map(row=>{
    let key;try{key=new PublicKey(row?.owner);}catch{}
    ok(key&&key.toBase58()===row.owner&&PublicKey.isOnCurve(key.toBytes())&&!seen.has(row.owner)&&units(row.amount)>0n,'Invalid or duplicate reserved native reward recipient.');
    seen.add(row.owner);return {owner:row.owner,amount:row.amount};
  });
}
const merge=(left,right)=>{
  const map=new Map(left.map(row=>[row.owner,units(row.amount)]));
  for(const row of right)map.set(row.owner,(map.get(row.owner)||0n)+units(row.amount));
  return [...map].sort(([a],[b])=>a.localeCompare(b)).map(([owner,amount])=>{ok(amount<=MAX_UNITS,'Reserved native reward exceeds token limits.');return {owner,amount:amount.toString()};});
};
const sameRows=(a,b)=>a.length===b.length&&a.every((row,index)=>row.owner===b[index].owner&&row.amount===b[index].amount);

// Owed amounts remain inside credits.quote. Moving an obligation into a saved
// payout queue changes its location only; it never changes earned or paid totals.
export function nativeRewardDebtState(l){
  if(!nativeHolderRewards(l)){ok(!l.nativeRewardDebts&&!l.cycle?.nativeRewardDebts,'Native reward debt belongs only to SOL holder rewards.');return {owed:[],queued:[],unpaid:[],reserved:0n};}
  const ledger=l.nativeRewardDebts;
  ok(!ledger||ledger.version===1,'Unsupported native reward debt version.');
  const owed=ledger?rows(ledger.payouts):[],cycle=l.cycle;
  let unpaid=[];
  if(cycle?.payouts!==undefined){
    const payouts=rows(cycle.payouts);
    ok(Number.isSafeInteger(cycle.index)&&cycle.index>=0&&cycle.index<=payouts.length,'Invalid saved native reward payout index.');
    unpaid=payouts.slice(cycle.index);
  }
  const queued=cycle?.nativeRewardDebts?rows(cycle.nativeRewardDebts):[],byOwner=new Map(unpaid.map(row=>[row.owner,units(row.amount)]));
  ok(queued.every(row=>byOwner.has(row.owner)&&units(row.amount)<=byOwner.get(row.owner)),'Reserved native reward is missing from its saved payout.');
  const owedOwners=new Set(owed.map(row=>row.owner));
  ok(unpaid.every(row=>!owedOwners.has(row.owner)),'Native reward obligation is queued twice.');
  const reserved=total(owed);
  ok(reserved+total(unpaid)<=units(l.credits.quote),'Reserved native rewards exceed earned quote credit.');
  return {owed,queued,unpaid,reserved};
}

export function deferNativeRewardPayouts(l,batch,rejected){
  ok(nativeHolderRewards(l)&&l.cycle?.stage==='payout'&&!l.operations.some(op=>['pending','awaiting_signature'].includes(op.state)),'A signed or unavailable native reward payout cannot be deferred.');
  const state=nativeRewardDebtState(l),requested=rows(batch),blocked=rows(rejected);
  ok(requested.length>0&&blocked.length>0&&sameRows(requested,state.unpaid.slice(0,requested.length)),'The deferred native reward batch differs from its saved recipients.');
  const requestedByOwner=new Map(requested.map(row=>[row.owner,row.amount]));
  ok(blocked.every(row=>requestedByOwner.get(row.owner)===row.amount),'The deferred native reward differs from its reviewed amount.');
  const owners=new Set(blocked.map(row=>row.owner));
  const nextOwed=merge(state.owed,blocked),nextUnpaid=state.unpaid.filter(row=>!owners.has(row.owner));
  // Preserve every confirmed prefix row and its index. Deferring is not paying.
  l.nativeRewardDebts={version:1,payouts:nextOwed};
  l.cycle.payouts=[...l.cycle.payouts.slice(0,l.cycle.index),...nextUnpaid];
  l.cycle.nativeRewardDebts=state.queued.filter(row=>!owners.has(row.owner));
  nativeRewardDebtState(l);
}

export function queueNativeRewardPayouts(l,fresh){
  ok(nativeHolderRewards(l)&&l.cycle?.stage==='distribute'&&l.cycle.payouts===undefined,'Native reward allocations already have a saved payout queue.');
  const state=nativeRewardDebtState(l),newRows=rows(fresh);
  ok(state.reserved+total(newRows)<=units(l.credits.quote),'New native rewards would spend an owed holder allocation.');
  l.cycle.payouts=merge(state.owed,newRows);l.cycle.index=0;
  l.cycle.nativeRewardDebts=state.owed;
  l.nativeRewardDebts={version:1,payouts:[]};
  nativeRewardDebtState(l);
}

// Existing unsigned-snapshot resets may reallocate fresh rewards, but cannot
// forget a prior holder's debt when that holder has since sold their tokens.
export function resetNativeRewardAllocation(l){
  ok(nativeHolderRewards(l)&&l.cycle&&!l.cycle.index,'Only an entirely unpaid native reward allocation can be rebuilt.');
  const state=nativeRewardDebtState(l);
  l.nativeRewardDebts={version:1,payouts:merge(state.owed,state.queued)};
  delete l.cycle.payouts;delete l.cycle.nativeRewardDebts;delete l.cycle.nativeRewardDebtOnly;l.cycle.stage='distribute';
  nativeRewardDebtState(l);
}

export function settleNativeRewardPayout(l,payouts){
  if(!nativeHolderRewards(l))return;
  const state=nativeRewardDebtState(l),paid=rows(payouts);
  ok(paid.length>0&&sameRows(paid,state.unpaid.slice(0,paid.length)),'Confirmed native rewards differ from the saved unpaid recipients.');
  const owners=new Set(paid.map(row=>row.owner));
  if(l.cycle.nativeRewardDebts)l.cycle.nativeRewardDebts=state.queued.filter(row=>!owners.has(row.owner));
}

export function deferredRewardSummary(l){
  try{const state=nativeRewardDebtState(l),combined=merge(state.owed,state.queued);return {wallets:combined.length,amountUnits:total(combined).toString()};}catch{return null;}
}
