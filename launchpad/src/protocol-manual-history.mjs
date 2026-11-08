// Buybacks and burns of the platform token made by hand before the automatic treasury ran (optional). The operator
// lists them in a JSON file named by LAUNCHPAD_MANUAL_HISTORY_FILE:
//   { "wallet": "<the treasury wallet>", "rows": [{ "kind": "buy" | "burn", "signature", "slot", "confirmedAt" (ms),
//     "inputAmount", "outputAmount", "funding"?: "external-contribution" }] }
// and checks each against its finalized mainnet receipt first. These public facts are analytics only: they never
// credit revenue, allocate a budget, import a signer, or trigger a transaction. Acquisition is the net token amount
// received after transfer tax; SOL inputs exclude network fees and rent. External contributions are burned tokens, not
// protocol purchases: their acquisition cost is unknown and they never increase the tokens bought or SOL spent.
import { readFileSync } from 'node:fs';
import { launchpadEnv } from './brand-env.mjs';
import { PLATFORM_TOKEN_MINT } from './platform-token.mjs';

function manualHistory(file = launchpadEnv('MANUAL_HISTORY_FILE')) {
  if (!file || !PLATFORM_TOKEN_MINT) return { wallet: '', rows: [] };
  const data = JSON.parse(readFileSync(file, 'utf8')), amount = value => typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value);
  const valid = row => row && ['buy', 'burn'].includes(row.kind) && typeof row.signature === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(row.signature)
    && Number.isSafeInteger(row.slot) && row.slot > 0 && Number.isSafeInteger(row.confirmedAt) && row.confirmedAt > 0 && amount(row.inputAmount) && amount(row.outputAmount)
    && (row.funding === undefined || row.funding === 'external-contribution');
  if (typeof data?.wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(data.wallet) || !Array.isArray(data.rows) || !data.rows.every(valid)) throw new Error('LAUNCHPAD_MANUAL_HISTORY_FILE is not a valid manual history.');
  return { wallet: data.wallet, rows: data.rows.map(({ kind, funding, signature, slot, confirmedAt, inputAmount, outputAmount }) => ({ kind, ...(funding ? { funding } : {}), signature, slot, confirmedAt, inputAmount, outputAmount })) };
}
const loaded = manualHistory();
export const MANUAL_PROTOCOL_WALLET = loaded.wallet;
export const MANUAL_PROTOCOL_MINT = PLATFORM_TOKEN_MINT;
export const MANUAL_PROTOCOL_HISTORY = Object.freeze(loaded.rows.map(row=>Object.freeze({...row,source:'manual',wallet:MANUAL_PROTOCOL_WALLET,mint:MANUAL_PROTOCOL_MINT,commitment:'finalized',curveDecimals:6})));

// The managed projection has already validated its ledger. Only its public
// history is inspected here, and any conflicting identity fails closed. A
// manual receipt already represented in the managed total contributes zero.
export function includeManualProtocolHistory(managed,now=Date.now(),knownReceipts){
  const rows=MANUAL_PROTOCOL_HISTORY.filter(row=>row.confirmedAt<=now);
  if(!rows.length)return managed;
  const operationKey=row=>row.signature+':'+row.kind;
  const contributions=new Map(rows.filter(row=>row.funding==='external-contribution').map(row=>[operationKey(row),row]));
  const contributionTotal=[...contributions.values()].reduce((sum,row)=>sum+BigInt(row.inputAmount),0n);
  const raw=knownReceipts!==undefined,receipts=knownReceipts??managed.history??[];
  const quantity=value=>typeof value==='string'&&/^(0|[1-9]\d{0,19})$/.test(value)&&BigInt(value)<=18446744073709551615n;
  // Raw financial history must satisfy the same confirmed-receipt conditions
  // as the managed public projection. In particular a missing state or bad
  // timestamp cannot suppress a purchase absent from the managed totals.
  const represented=row=>row&&(!raw||row.state==='confirmed')&&['buy','burn'].includes(row.kind)&&Number.isSafeInteger(row.confirmedAt)&&row.confirmedAt>0&&row.confirmedAt<=now+5000&&quantity(row.inputAmount)&&quantity(row.outputAmount)&&BigInt(row.inputAmount)>0n&&(row.kind!=='buy'||BigInt(row.outputAmount)>0n);
  const seen=new Map((managed.status==='available'&&Array.isArray(receipts)?receipts:[]).filter(represented).map(row=>[operationKey(row),row]));
  const unavailable=()=>({...managed,status:'unavailable',complete:false,solSpent:null,curveBought:null,curveBurned:null,history:[],note:'Conflicting buyback receipt records need reconciliation.'});
  if(managed.status==='available'){
    // A verified external contribution must not excuse inconsistent automated
    // accounting. Its allowance applies only to the pinned contribution below.
    if(managed.curveBought!==null&&managed.curveBurned!==null&&(!quantity(managed.curveBought)||!quantity(managed.curveBurned)||BigInt(managed.curveBurned)>BigInt(managed.curveBought)))return unavailable();
    let retainedSpent=0n,retainedBought=0n,retainedBurned=0n;
    for(const row of seen.values())if(row.kind==='buy'){retainedSpent+=BigInt(row.inputAmount);retainedBought+=BigInt(row.outputAmount);}else retainedBurned+=BigInt(row.inputAmount);
    if(!quantity(managed.solSpent)||retainedSpent>BigInt(managed.solSpent)||managed.curveBought!==null&&(!quantity(managed.curveBought)||retainedBought>BigInt(managed.curveBought))||managed.curveBurned!==null&&(!quantity(managed.curveBurned)||retainedBurned>BigInt(managed.curveBurned)))return unavailable();
  }
  let spent=0n,bought=0n,burned=0n,contributed=0n;
  const unique=[];
  for(const row of rows){
    const prior=seen.get(operationKey(row));
    if(prior){
      if(prior.kind!==row.kind||prior.inputAmount!==row.inputAmount||prior.outputAmount!==row.outputAmount){
        return unavailable();
      }
      continue;
    }
    unique.push({...row});
    if(row.kind==='buy'){spent+=BigInt(row.inputAmount);bought+=BigInt(row.outputAmount);}else{
      burned+=BigInt(row.inputAmount);
      if(row.funding==='external-contribution')contributed+=BigInt(row.inputAmount);
    }
  }
  const noManaged=managed.status==='unconfigured',validManaged=managed.status==='available';
  const nativeKnown=noManaged||validManaged&&managed.solSpent!==null;
  const tokenKnown=noManaged||validManaged&&(managed.curveDecimals===6||managed.solSpent==='0');
  const complete=(noManaged||validManaged&&managed.complete!==false)&&nativeKnown&&tokenKnown;
  const sum=(value,extra,known)=>known?(BigInt(value||'0')+extra).toString():extra.toString();
  const result={...managed,status:complete?'available':'partial',complete,curveDecimals:6,
    solSpent:sum(managed.solSpent,spent,nativeKnown),curveBought:sum(managed.curveBought,bought,tokenKnown),curveBurned:sum(managed.curveBurned,burned,tokenKnown),
    managedStatus:managed.status,manualIncluded:true,manualSolSpent:spent.toString(),manualCurveBought:bought.toString(),manualCurveBurned:burned.toString(),manualContributionBurned:contributionTotal.toString(),
    amountsAreSubtotals:!nativeKnown||!tokenKnown,updatedAt:Math.max(managed.updatedAt||0,...rows.map(row=>row.confirmedAt)),
    evidence:'saved-confirmed-receipts-and-verified-manual-history',
    history:[...(managed.history||[]).map(row=>contributions.has(operationKey(row))?{...row,source:'manual',funding:'external-contribution'}:row),...unique].sort((a,b)=>b.confirmedAt-a.confirmedAt).slice(0,20),
    note:'Recorded automatic and verified manual protocol buybacks and burns. Burns include verified tokens contributed to the treasury without a recorded protocol purchase cost. Contributions do not increase LAUNCHPAD bought or SOL spent. Manual activity does not credit the automatic spending budget. Amounts exclude network fees and rent; acquired LAUNCHPAD is net of transfer tax.',
  };
  return BigInt(result.curveBurned)>BigInt(result.curveBought)+contributed?unavailable():result;
}
