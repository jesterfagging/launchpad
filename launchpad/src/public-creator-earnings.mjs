import {PublicKey} from '@solana/web3.js';
import {SOL_MINT} from '../public/launchpad-model.mjs';

const raw=value=>typeof value==='string'&&/^(0|[1-9]\d{0,39})$/.test(value)?BigInt(value):null;
const delta=value=>typeof value==='string'&&/^-?(0|[1-9]\d{0,39})$/.test(value)?BigInt(value):null;
const address=value=>{try{return typeof value==='string'&&new PublicKey(value).toBase58()===value?value:null;}catch{return null;}};
const stamp=value=>Number.isSafeInteger(value)&&value>0?value:null;
const confirmed=op=>op?.state==='confirmed'&&typeof op.signature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(op.signature)&&Number.isSafeInteger(op.slot)&&op.slot>0;
const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const note='Per-coin recorded quote revenue across all fee recipients, not the original creator’s personal income. Uncollected vault fees and unconverted token fees are excluded.';
export function unavailableCreatorEarnings(summary,reason){return summary?{...summary,status:'unavailable',earnedRaw:null,paidRaw:null,pendingRaw:null,historyComplete:false,note:reason+' '+note}:null;}

/** Read-only aggregate from already verified journals. Never retain private
 * operations, signed bytes, keys, account IDs, RPC configuration or payee lists. */
export function publicCreatorEarnings(launch,coin,{now=Date.now()}={}){
  if(coin.feeMode!=='creator')return null;
  const pump=coin.platform==='pumpswap',meteora=coin.platform==='meteora',decimals=meteora?launch.quoteDecimals:pump?9:launch.review?.quoteDecimals;
  const summary={status:'unavailable',scope:'coin',quote:{mint:coin.quote.mint,symbol:coin.quote.symbol,decimals:Number.isInteger(decimals)&&decimals>=0&&decimals<=18?decimals:null},earnedRaw:null,paidRaw:null,pendingRaw:null,recipient:address(meteora?launch.creatorRecipient:pump?launch.creatorWallet:launch.input?.recipient),at:null,historyComplete:false,refreshMs:30000,note};
  if(summary.quote.decimals===null)return unavailableCreatorEarnings(summary,'Quote-token precision is unavailable.');
  if(meteora){
    const saved=launch.creatorRewards,paid=raw(saved?.totalPaidRaw),pending=raw(saved?.pendingRaw),earned=raw(saved?.totalClaimedRaw),at=stamp(saved?.at);
    summary.at=at&&at<=now?at:null;summary.paidRaw=paid?.toString()??null;summary.pendingRaw=pending?.toString()??null;summary.earnedRaw=earned?.toString()??null;
    summary.historyComplete=saved?.historyComplete===true;summary.status=summary.historyComplete&&[paid,pending,earned].every(value=>value!==null)?'available':[paid,pending,earned].some(value=>value!==null)?'partial':'unavailable';
    summary.note='Verified creator quote fees collected from this Meteora launch. Unclaimed DBC and DAMM v2 fees are excluded. Locked liquidity can continue earning after graduation; its share changes if other liquidity is added.';
    return summary;
  }
  if(pump){
    const paid=raw(launch.creatorFeesPaid),pending=raw(launch.creatorFeesPending),at=stamp(launch.creatorFeesAt);
    summary.at=at&&at<=now?at:null;
    // These counters are updated only from finalized public-program state.
    if(paid!==null)summary.paidRaw=paid.toString();if(pending!==null)summary.pendingRaw=pending.toString();
    if(paid!==null&&pending!==null){summary.earnedRaw=(paid+pending).toString();summary.historyComplete=true;summary.status='available';}else if(paid!==null||pending!==null)summary.status='partial';
    summary.note='Per-coin creator fees from the last saved finalized bonding-curve counters. Pending fees are paid automatically. PumpSwap pool trades do not generate creator fees.'+(summary.at===null?' The counter observation time is unavailable.':'');return summary;
  }
  const wallet=launch.keys?.wallet;
  if(launch.feeCustody!=='relay'||!address(wallet?.address)||wallet.external||wallet.exportedAt||wallet.compromised||wallet.compromisedAt||launch.feeWalletExportedAt||launch.walletExportedAt||launch.walletCompromisedAt||wallet.address===launch.keys?.payer?.address)return unavailableCreatorEarnings(summary,'This fee wallet does not provide complete per-coin accounting.');
  if(Number(launch.input?.taxBps||0)!==0)return unavailableCreatorEarnings(summary,'Creator fees cannot be separated from this older transfer-tax ledger.');
  const ops=Array.isArray(launch.operations)?launch.operations:[];
  let complete=Array.isArray(launch.operations)&&launch.historyTruncated!==true&&launch.operationsTruncated!==true&&ops.some(op=>['create','launch-all'].includes(op.kind)&&confirmed(op));
  const unique=new Map(),ids=new Map();
  for(const op of ops){
    if(op.state!=='confirmed'||!['claim','sell','payout'].includes(op.kind))continue;
    if(!confirmed(op)){complete=false;continue;}
    const fingerprint=JSON.stringify([op.kind,op.receipt?.quoteDelta,op.receipt?.baseDelta,op.amount,op.payouts,op.personalRewardReceipt]);
    if(unique.has(op.signature)){if(unique.get(op.signature).fingerprint!==fingerprint)complete=false;continue;}
    if(op.operationId&&ids.has(op.operationId)&&ids.get(op.operationId)!==op.signature){complete=false;continue;}
    if(op.operationId)ids.set(op.operationId,op.signature);unique.set(op.signature,{op,fingerprint});
  }
  let earned=0n,paid=0n;
  for(const {op}of unique.values()){
    const q=delta(op.receipt?.quoteDelta),b=delta(op.receipt?.baseDelta),at=stamp(op.confirmedAt)||stamp(op.createdAt);if(at&&at<=now)summary.at=Math.max(summary.at||0,at);
    if(op.kind==='claim'){if(q===null||q<0n||b===null||b<0n){complete=false;continue;}earned+=q;}
    else if(op.kind==='sell'){if(q===null||q<=0n||b===null||b>=0n){complete=false;continue;}earned+=q;}
    else{
      const amount=raw(op.amount),payouts=op.payouts;
      if(amount===null||amount<=0n||q!==-amount||b!==0n||!Array.isArray(payouts)||!payouts.length||payouts.length>1000){complete=false;continue;}
      const owners=new Set();let sent=0n,received=0n,valid=true;
      for(const payout of payouts){const owner=address(payout?.owner),units=raw(payout?.amount);if(!owner||units===null||units<=0n||owners.has(owner)){valid=false;break;}owners.add(owner);sent+=units;
        if(coin.quote.mint===SOL_MINT||launch.review?.quoteProgram===TOKEN_PROGRAM)received+=units;
        else{const receipt=op.personalRewardReceipt,row=receipt?.payments?.filter(value=>value.wallet===owner);const net=row?.length===1?raw(row[0].amountUnits):null;
          if(receipt?.version!==1||receipt.mint!==coin.quote.mint||receipt.decimals!==decimals||receipt.signature!==op.signature||receipt.slot!==op.slot||receipt.payments.length!==payouts.length||net===null||net>units||raw(row[0].amountSentUnits)!==units){valid=false;break;}received+=net;}
      }
      if(!valid||sent!==amount){complete=false;continue;}paid+=received;
    }
  }
  const pending=raw(launch.credits?.quote);summary.pendingRaw=pending?.toString()??null;
  if(complete){summary.earnedRaw=earned.toString();summary.paidRaw=paid.toString();summary.historyComplete=true;}
  summary.status=complete&&pending!==null?'available':summary.pendingRaw!==null||complete?'partial':'unavailable';
  if(!complete)summary.note='Some historical receipts are missing or ambiguous; lifetime totals are unavailable. '+note;
  if(summary.at===null){const at=stamp(launch.lastCycle);summary.at=at&&at<=now?at:null;}
  return summary;
}
