import {PublicKey} from '@solana/web3.js';
import {SOL_MINT} from '../public/launchpad-model.mjs';
const raw=value=>typeof value==='string'&&/^(0|[1-9]\d{0,19})$/.test(value)&&BigInt(value)<(1n<<64n)?BigInt(value):null;
const signature=value=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value);
const address=value=>{try{return typeof value==='string'&&new PublicKey(value).toBase58()===value?value:null;}catch{return null;}};
const wallet=value=>{const key=address(value);return key&&PublicKey.isOnCurve(new PublicKey(key).toBytes())?key:null;};
const stamp=value=>Number.isSafeInteger(value)&&value>0?value:null;
/** Sanitized candidate receipts only. Treasury independently verifies every
 * finalized onchain transfer before allocating it; claims into service custody
 * are never treated as treasury payments. No keys or signed bytes leave here. */
export function meteoraTreasurySources(book){
  if(book?.schemaVersion!==1||!Array.isArray(book.launches)||!Array.isArray(book.operations))throw Error('Meteora revenue history is unavailable.');
  const launches=new Map(book.launches.map(row=>[row.mint,row])),sources=[];
  for(const op of book.operations){
    if(op?.state!=='finalized'||!['partner-payout','initialize'].includes(op.action)||!signature(op.signature)||!stamp(op.result?.slot)||!stamp(op.finalizedAt))continue;
    const launch=launches.get(op.mint);if(!launch||!address(launch.mint))continue;
    const common={signature:op.signature,slot:op.result.slot,at:op.finalizedAt,launchMint:launch.mint};
    if(op.action==='initialize'){
      const receipt=op.result?.creationFeeReceipt,fee=launch.creationFee,value=raw(receipt?.amount),source=wallet(launch.creatorWallet),destination=wallet(fee?.recipient);
      if(!source||!destination||source===destination||receipt?.mint!==SOL_MINT||receipt.decimals!==9||receipt.selfPayment===true||value===null||value<=0n||String(value)!==fee?.lamports||receipt.recipient!==destination||op.wallet!==source)continue;
      sources.push({...common,kind:'creation',mint:SOL_MINT,decimals:9,symbol:'SOL',amount:String(value),wallet:destination,sourceWallet:source});continue;
    }
    const value=raw(op.result?.payout?.quoteDebitRaw),destination=wallet(op.protocolRecipient??launch.treasury),source=wallet(launch.partnerAuthority),mint=address(launch.quoteMint),decimals=launch.quoteDecimals;
    const expected=op.payouts,received=op.result?.payout?.recipients;
    if(!destination||!source||destination===source||!mint||!Number.isInteger(decimals)||decimals<0||decimals>18||value===null||value<=0n||op.wallet!==source||!Array.isArray(expected)||expected.length!==1||!Array.isArray(received)||received.length!==1)continue;
    if(expected[0]?.owner!==destination||received[0]?.owner!==destination||raw(expected[0]?.amount)!==value||raw(received[0]?.amount)!==value)continue;
    sources.push({...common,kind:'meteora-partner-payout',mint,decimals,symbol:String(launch.quoteSymbol||'').replace(/[\x00-\x1f\x7f]/g,'').slice(0,30),amount:String(value),wallet:destination,sourceWallet:source});
  }
  return sources;
}

// Analytics has a stricter coverage contract than treasury candidate discovery.
// Missing history downgrades totals; ledger counters never become earnings.
// The existing treasurySources path and financial source semantics stay intact.
export function meteoraRevenueAnalyticsSources(book){
  if(book?.schemaVersion!==1||!Array.isArray(book.launches)||!Array.isArray(book.operations))throw Error('Meteora revenue history is unavailable.');
  let complete=book.historyTruncated!==true&&book.operationsTruncated!==true;
  const launches=new Map(),sources=[],seen=new Map(),paid=new Map(),created=new Set();
  for(const launch of book.launches){
    if(!launch||!address(launch.mint)){complete=false;continue;}
    if(launch.historyTruncated===true||launch.operationsTruncated===true)complete=false;
    const prior=launches.get(launch.mint);if(prior&&JSON.stringify([prior.creatorWallet,prior.partnerAuthority,prior.treasury,prior.quoteMint,prior.quoteDecimals,prior.creationFee,prior.ledger?.partnerPaid])!==JSON.stringify([launch.creatorWallet,launch.partnerAuthority,launch.treasury,launch.quoteMint,launch.quoteDecimals,launch.creationFee,launch.ledger?.partnerPaid]))complete=false;
    launches.set(launch.mint,launch);
  }
  for(const op of book.operations){
    if(op?.state!=='finalized'||!['partner-payout','initialize'].includes(op.action))continue;
    const launch=launches.get(op.mint);if(!launch){complete=false;continue;}
    // Apply the exact same receipt validation as candidate discovery, once per
    // operation. Suppressed zero/self creation fees are not missing revenue.
    const rows=meteoraTreasurySources({schemaVersion:1,launches:[launch],operations:[op]});
    if(!rows.length){
      const fee=launch.creationFee,own=wallet(launch.creatorWallet),recipient=wallet(fee?.recipient),zeroOrSelf=op.action==='initialize'&&(raw(fee?.lamports)===0n||own&&recipient===own);
      if(!zeroOrSelf)complete=false;
      continue;
    }
    for(const source of rows){
      sources.push(source);const key=source.signature+':'+source.kind;
      const prior=seen.get(key);
      if(prior){if(['mint','decimals','amount','wallet','sourceWallet','launchMint'].some(field=>prior[field]!==source[field]))complete=false;continue;}
      seen.set(key,source);
      if(source.kind==='creation')created.add(source.launchMint);
      else paid.set(source.launchMint,(paid.get(source.launchMint)||0n)+BigInt(source.amount));
    }
  }
  for(const launch of launches.values()){
    if(launch.ledger?.partnerPaid!==undefined){const total=raw(launch.ledger.partnerPaid);if(total===null||total>(paid.get(launch.mint)||0n))complete=false;}
    if(stamp(launch.finalizedAt)&&!created.has(launch.mint)){
      const fee=launch.creationFee,own=wallet(launch.creatorWallet),recipient=wallet(fee?.recipient);
      if(raw(fee?.lamports)!==0n&&!(own&&recipient===own))complete=false;
    }
  }
  return {sources,complete};
}
