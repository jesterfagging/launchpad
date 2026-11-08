import { requireValue as ok, SOL_MINT } from '../public/launchpad-model.mjs';
import { taxProtocolLedger } from './launchpad-tax-protocol.mjs';
import { TAX_BURN_MINT, TAX_BURN_WALLET, TAX_BURN_POLICY, TAX_BURN_INITIAL_AMOUNT, TAX_BURN_INITIAL_POLICY, validInitialTaxBurnApproval } from './launchpad-rewards-wallet.mjs';

// Owner-selected policy for the official mint only. No launch mode, immutable
// transfer-tax rate, existing SOL obligation or prior revenue is reclassified.
export { TAX_BURN_MINT, TAX_BURN_WALLET, TAX_BURN_POLICY, TAX_BURN_INITIAL_AMOUNT, TAX_BURN_INITIAL_POLICY };
const amount=value=>{ok(typeof value==='string'&&/^\d+$/.test(value),'Invalid collected-tax burn amount.');return BigInt(value);};
export const officialTaxBurnScope=l=>l?.input?.network==='mainnet-beta'&&l.input.route==='raydium'&&l.input.feeMode==='holders'&&Number(l.input.taxBps)>0&&l.input.quoteMint===SOL_MINT&&l.keys?.mint?.address===TAX_BURN_MINT&&(l.keys?.rewards?.address||l.rewardsWallet?.address)===TAX_BURN_WALLET;
export const officialTaxBurnConfigured=()=>process.env.LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED==='true';
// v71.24: collected tax burns automatically only when the owner opts in with
// LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN=true. Otherwise it is still collected into the
// official rewards wallet (never sold) and kept there until the owner burns it
// with Admin → Tokens → Token management → Burn collected tax now, a one-time request per burn.
export const officialTaxAutoBurnConfigured=()=>process.env.LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN==='true';
const BURN_REQUEST_ID=/^[a-f0-9]{32}$/;
export function manualTaxBurnRequest(l){const value=l?.taxBurnRequest;return value&&value.version===1&&BURN_REQUEST_ID.test(value.requestId||'')&&Number.isSafeInteger(value.at)&&value.at>=0?value:null;}
export const officialInitialBurnConfigured=()=>process.env.LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED==='true';
function initialInventory(l){
  const value=l.taxBurn?.initialInventory;
  if(!value)return null;
  ok(value.version===1&&validInitialTaxBurnApproval(value.policy,value.approvedBase)&&['authorized','burned'].includes(value.status),'Invalid initial LAUNCHPAD inventory burn authorization.');
  const tracked=amount(value.trackedBurnedBase),legacy=amount(value.legacyBurnedBase);
  ok(value.status==='authorized'?tracked===0n&&legacy===0n:tracked+legacy===BigInt(value.approvedBase)&&Number.isSafeInteger(value.completedAt)&&value.completedAt>=0&&typeof value.signature==='string'&&value.signature.length>0,'Invalid initial LAUNCHPAD inventory burn receipt.');
  return value;
}
function savedPolicy(l){
  if(!l.taxBurn)return false;
  ok(officialTaxBurnScope(l)&&l.taxBurn.policy===TAX_BURN_POLICY&&Number.isSafeInteger(l.taxBurn.selectedAt)&&l.taxBurn.selectedAt>=0&&Number.isSafeInteger(l.taxBurn.burnCount)&&l.taxBurn.burnCount>=0,'Invalid official LAUNCHPAD tax-burn policy.');
  initialInventory(l);return true;
}
// Turning a gate off pauses NEW burns; it must never silently resume sales.
// Already signed operations reconcile without consulting either runtime flag.
export function officialTaxBurnSelected(l){return savedPolicy(l)||officialTaxBurnScope(l)&&officialTaxBurnConfigured();}
export function officialTaxBurnEnabled(l){return officialTaxBurnSelected(l)&&officialTaxBurnConfigured()&&(officialTaxAutoBurnConfigured()||!!manualTaxBurnRequest(l));}
export function selectOfficialTaxBurn(l,now=Date.now()){
  const saved=savedPolicy(l);
  if(!officialTaxBurnScope(l)||!officialTaxBurnConfigured())return false;
  ok(Number.isSafeInteger(now)&&now>=0,'Invalid tax-burn policy time.');taxProtocolLedger(l);
  let changed=false;
  if(!saved){l.taxBurn={policy:TAX_BURN_POLICY,selectedAt:now,burnCount:0,lastBurnAt:null,lastBurnSignature:null};changed=true;}
  if(officialInitialBurnConfigured()&&!l.taxBurn.initialInventory){
    // Never reinterpret later accruals as the already-approved original balance.
    ok(l.taxBurn.burnCount===0&&!l.operations?.some(op=>op.kind==='tax-burn'&&['pending','awaiting_signature','confirmed'].includes(op.state)),'Initial LAUNCHPAD inventory authorization cannot be enabled after another tax burn. Review the original inventory before proceeding.');
    l.taxBurn.initialInventory={version:1,policy:TAX_BURN_INITIAL_POLICY,approvedBase:TAX_BURN_INITIAL_AMOUNT,status:'authorized',trackedBurnedBase:'0',legacyBurnedBase:'0',completedAt:null,signature:null};changed=true;
  }
  const initial=initialInventory(l);
  // An earlier valid approval that never reached an operation may adopt the owner's new
  // exact amount. Any saved burn operation (including failed/unsigned records)
  // pins the old approval until reconciled; completed initial burns never reset.
  if(officialInitialBurnConfigured()&&initial&&initial.policy!==TAX_BURN_INITIAL_POLICY&&initial.status==='authorized'&&l.taxBurn.burnCount===0&&!l.operations?.some(op=>op.kind==='tax-burn')){
    l.taxBurn.initialInventory={...initial,policy:TAX_BURN_INITIAL_POLICY,approvedBase:TAX_BURN_INITIAL_AMOUNT,replaces:{policy:initial.policy,approvedBase:initial.approvedBase,revisedAt:now}};changed=true;
  }
  return changed;
}
export function initialTaxBurnPending(l){return savedPolicy(l)&&initialInventory(l)?.status==='authorized';}
export function taxBurnPlan(l){
  ok(savedPolicy(l)&&officialTaxBurnEnabled(l),'Official LAUNCHPAD collected-tax burning is not enabled.');
  const state=l.rewardsWallet;
  ok(state?.version===1&&state.status==='active'&&state.address===TAX_BURN_WALLET&&['base','quote','protocolQuote','taxBase'].every(k=>amount(state.creatorCredits?.[k])===0n),'Collected-tax burning requires the active dedicated rewards wallet with no pending creator handoff.');
  const ledger=taxProtocolLedger(l),credit=amount(ledger.sourceBaseCredit),initial=initialInventory(l);
  if(initial?.status==='authorized'){
    // An initial authorization held while paused blocks newer burns too, so the
    // exact original amount cannot accidentally be counted a second time later.
    if(!officialInitialBurnConfigured())return {amount:'0',operationData:{}};
    const target=BigInt(initial.approvedBase),base=amount(l.credits.base);
    ok(base>=target,'The approved initial LAUNCHPAD inventory is no longer fully accounted for. No partial burn was prepared; reconcile the changed balance.');
    const tracked=credit<target?credit:target;
    return {amount:initial.approvedBase,operationData:{taxBurnPolicy:TAX_BURN_POLICY,taxSource:'approved-initial-inventory',initialBurnPolicy:initial.policy,initialTaxBase:tracked.toString(),initialLegacyBase:(target-tracked).toString()}};
  }
  ok(credit<=18446744073709551615n,'Collected-tax burn exceeds token amount limits.');
  return {amount:credit.toString(),operationData:{taxBurnPolicy:TAX_BURN_POLICY,taxSource:'withheld-tax'}};
}
export function requireTaxBurnPlan(l,op){
  const plan=taxBurnPlan(l),value=amount(op.amount);
  ok(op.kind==='tax-burn'&&value>0n&&value<=BigInt(plan.amount)&&Object.entries(plan.operationData).every(([key,expected])=>op[key]===expected),'Collected-tax burn exceeds its verified source authorization.');
  if(op.taxSource==='approved-initial-inventory')ok(op.amount===plan.amount,'The initial LAUNCHPAD burn must match its exact approved inventory.');
  return plan;
}
export function recordTaxBurn(l,op,delta,now=Date.now()){
  ok(savedPolicy(l)&&officialTaxBurnScope(l)&&op.kind==='tax-burn'&&op.taxBurnPolicy===TAX_BURN_POLICY&&['withheld-tax','approved-initial-inventory'].includes(op.taxSource),'The receipt is not an authorized official LAUNCHPAD tax burn.');
  const value=amount(op.amount),ledger=taxProtocolLedger(l),initial=initialInventory(l);
  ok(value>0n&&value<=18446744073709551615n&&delta.base===-value&&delta.quote===0n,'Collected-tax burn differs from its verified source credit.');
  let tracked=value,legacy=0n,policy={...l.taxBurn};
  if(op.taxSource==='approved-initial-inventory'){
    tracked=amount(op.initialTaxBase);legacy=amount(op.initialLegacyBase);
    ok(initial?.status==='authorized'&&op.initialBurnPolicy===initial.policy&&op.amount===initial.approvedBase&&tracked+legacy===value&&legacy<=BigInt(l.credits.base)-BigInt(ledger.sourceBaseCredit),'The initial LAUNCHPAD burn differs from its one-time inventory authorization.');
    policy.initialInventory={...initial,status:'burned',trackedBurnedBase:tracked.toString(),legacyBurnedBase:legacy.toString(),completedAt:now,signature:op.signature};
  }else ok(initial?.status!=='authorized','New tax burns must wait for the approved initial inventory.');
  ok(tracked<=BigInt(ledger.sourceBaseCredit),'Collected-tax burn exceeds its confirmed tax source.');
  ok(Number.isSafeInteger(now)&&now>=0&&typeof op.signature==='string'&&op.signature.length>0&&l.taxBurn.burnCount<Number.MAX_SAFE_INTEGER,'Invalid collected-tax burn receipt metadata.');
  ledger.sourceBaseCredit=(BigInt(ledger.sourceBaseCredit)-tracked).toString();ledger.burnedBase=(BigInt(ledger.burnedBase)+tracked).toString();
  policy={...policy,burnCount:policy.burnCount+1,lastBurnAt:now,lastBurnSignature:op.signature};
  return {ledger,policy,receipt:{policy:TAX_BURN_POLICY,mint:TAX_BURN_MINT,wallet:TAX_BURN_WALLET,baseUnits:value.toString(),trackedTaxBaseUnits:tracked.toString(),approvedLegacyBaseUnits:legacy.toString(),source:op.taxSource}};
}
export function publicTaxBurn(l){
  if(!officialTaxBurnScope(l)&&!l?.taxBurn)return null;
  // enabled: the burn policy is active (tax is collected and never sold). automatic: it also burns by itself;
  // manual: it is kept for the owner's Burn collected tax now (manualRequested once asked).
  const selected=officialTaxBurnSelected(l),enabled=selected&&officialTaxBurnConfigured(),automatic=enabled&&officialTaxAutoBurnConfigured(),ledger=taxProtocolLedger(l),initial=initialInventory(l),legacy=initial?.legacyBurnedBase||'0';
  return {policy:TAX_BURN_POLICY,selected,enabled,automatic,manual:enabled&&!automatic,manualRequested:!!manualTaxBurnRequest(l),paused:selected&&(!enabled||initial?.status==='authorized'&&!officialInitialBurnConfigured()),burnedBase:(BigInt(ledger.burnedBase)+BigInt(legacy)).toString(),trackedBurnedBase:ledger.burnedBase,approvedLegacyBurnedBase:legacy,burnCount:l.taxBurn?.burnCount||0,lastBurnSignature:l.taxBurn?.lastBurnSignature||null,lastBurnAt:l.taxBurn?.lastBurnAt||null,pendingTaxBase:ledger.sourceBaseCredit,unattributedBase:(BigInt(l.credits.base)-BigInt(ledger.sourceBaseCredit)).toString(),initialInventory:initial?{approvedBase:initial.approvedBase,status:initial.status,completedAt:initial.completedAt,signature:initial.signature}:null};
}
