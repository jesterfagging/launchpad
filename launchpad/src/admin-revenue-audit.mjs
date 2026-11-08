import {NEW_LAUNCH_LIQUIDITY} from './launchpad-protocol-fees.mjs';
import { PublicKey } from '@solana/web3.js';
import { isCurrentLaunch } from '../public/launchpad-model.mjs';
import { protocolTreasurySources } from './protocol-treasury.mjs';
import { protocolLiquiditySnapshot } from './launchpad-protocol-liquidity.mjs';
import { managedProtocolWallet, protocolWalletSelection } from './launchpad-protocol-wallet.mjs';
import { taxProtocolLedger, TAX_PROTOCOL_SHARE_BPS } from './launchpad-tax-protocol.mjs';

const fail=(message,statusCode=503)=>{throw Object.assign(Error(message),{statusCode});};
const address=value=>{try{return typeof value==='string'&&new PublicKey(value).toBase58()===value?value:'';}catch{return '';}};
const text=(value,max=100)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,max):'';
const amount=value=>typeof value==='string'&&/^\d{1,40}$/.test(value)?BigInt(value).toString():null;
const quantity=value=>amount(value??'0');
const signature=value=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)?value:'';
const id=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value)?value:'';
const timestamp=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000?value:null;
const decimals=value=>Number.isInteger(value)&&value>=0&&value<=18?value:null;
const feeBps=value=>value===undefined?0:Number.isInteger(value)&&value>=0&&value<=10000?value:null;
const operationKinds=new Set(['storage-credit','storage-fund','platform','platform-setup','quote-fund','create','setup','launch-all','claim','tax','tax-burn','sell','gas-sell','buy','burn','payout','tax-protocol-payout','protocol-enable','protocol-claim','protocol-lp-claim','protocol-payout','protocol-lp-payout','platform-brand-update','creator-fee-update','convert','withdraw']);
const operation=op=>op?{kind:operationKinds.has(op.kind)?op.kind:'unknown',signature:signature(op.signature),state:['pending','awaiting_signature','queued'].includes(op.state)?op.state:'unknown',createdAt:timestamp(op.createdAt)}:null;
const creationFee=value=>typeof value==='string'&&/^(?:0|0\.\d{1,9})$/.test(value)&&Number(value)<=.1?value:null;

/** Read-only accounting view. These are saved, reconciled journal receipts,
 * not an independent live blockchain audit or proof that all fees were swept.
 * Every exported field is allowlisted; no keys, raw transactions or user
 * settings are returned to the browser or included in its JSON download. */
export function buildAdminRevenueAudit({rows=[],savedPolicy=null,savedTreasury=null,additionalSources=[],now=Date.now()}={}){
  const issues=[],coins=[],records=Array.isArray(rows)?rows:[],launches=records.map(row=>row?.launch).filter(l=>isCurrentLaunch(l?.input));
  const historyIssue=()=>{if(!issues.some(issue=>issue.code==='invalid_revenue_history'))issues.push({code:'invalid_revenue_history',scope:'history'});};
  if(!Array.isArray(rows)||records.some(row=>!row?.launch||typeof row.launch!=='object'||Array.isArray(row.launch)))historyIssue();
  const recipient=address(savedPolicy?.recipient),fee=creationFee(savedPolicy?.creationFeeSol??'0');
  // Report the effective future-launch policy; old host LP choices no longer
  // override it. Individual historical coins retain their saved terms below.
  const liquidity={...NEW_LAUNCH_LIQUIDITY};
  const policy={configured:!!recipient,recipient,creationFeeSol:fee,curveFeeBps:100,taxRevenueShareBps:TAX_PROTOCOL_SHARE_BPS,autoHarvest:savedPolicy?.autoHarvest!==false,...liquidity};
  if(!recipient)issues.push({code:'recipient_unconfigured',scope:'policy'});
  if(fee===null)issues.push({code:'invalid_creation_fee',scope:'policy'});
  if(!policy.autoHarvest)issues.push({code:'automatic_collection_disabled',scope:'policy'});
  const treasuryAddress=address(savedTreasury?.wallet?.address);
  const treasury={configured:!!treasuryAddress,enabled:savedTreasury?.enabled===true,address:treasuryAddress,recipientMatches:!!treasuryAddress&&recipient===treasuryAddress,previousRecipients:[...new Set((Array.isArray(savedTreasury?.previousRecipients)?savedTreasury.previousRecipients:[]).map(address).filter(Boolean))],pending:operation(savedTreasury?.pending)};
  if(!treasury.configured)issues.push({code:'treasury_unconfigured',scope:'treasury'});
  else if(!treasury.enabled)issues.push({code:'treasury_automation_disabled',scope:'treasury'});
  if(treasury.enabled&&!treasury.recipientMatches)issues.push({code:'treasury_recipient_mismatch',scope:'treasury'});
  let untrackedCreationReceipts=0,pendingOperations=0,legacyLaunches=0;
  for(const row of records){
    const {accountId,launch:l}=row||{};
    if(!isCurrentLaunch(l?.input))continue;
    const ops=Array.isArray(l.operations)?l.operations:[],created=ops.some(op=>['create','launch-all'].includes(op?.kind)&&op.state==='confirmed');
    if(l.operations!==undefined&&!Array.isArray(l.operations))historyIssue();
    if(!l.curve&&!created)continue;
    const coinIssues=[],pending=ops.filter(op=>['pending','awaiting_signature'].includes(op?.state)).map(operation);
    pendingOperations+=pending.length;
    if(pending.length)coinIssues.push('pending_transaction');
    if(timestamp(now)!==null&&pending.some(op=>op.state==='pending'&&op.createdAt!==null&&now-op.createdAt>180000))coinIssues.push('receipt_waiting');
    const platformFeeBps=feeBps(l.review?.platformFeeBps),taxBps=feeBps(l.input?.taxBps);
    if(platformFeeBps===null||taxBps===null)coinIssues.push('invalid_fee_policy');
    if(platformFeeBps!==null&&platformFeeBps!==100){legacyLaunches++;coinIssues.push('legacy_protocol_policy');}
    let protocolWallet='',managed=false,lpPolicy=null;
    try{protocolWallet=address(protocolWalletSelection(l).address);managed=managedProtocolWallet(l);}catch{}
    try{lpPolicy=protocolLiquiditySnapshot(l.review?.protocolFees).lpPolicy;}catch{}
    if(!managed)coinIssues.push('protocol_signer_unavailable');
    if(lpPolicy==='burn')coinIssues.push('legacy_burned_lp');
    else if(!lpPolicy)coinIssues.push('invalid_lp_policy');
    const autoHarvest=l.review?.protocolFees?.autoHarvest===true;
    if(!autoHarvest)coinIssues.push('automatic_collection_disabled');
    if(l.protocolError)coinIssues.push('collection_needs_attention');
    const protocolCredit=quantity(l.protocolCredit),protocolBaseCredit=quantity(l.protocolBaseCredit);
    let taxProtocolCredit=null,taxSourceBaseCredit=null;
    try{
      // Bound stored numbers before the shared ledger validator constructs BigInts.
      if(l.taxProtocol&&(['harvestedBase','sourceBaseCredit','convertedBase','convertedQuote','holderQuote','accruedQuote','creditQuote','paidQuote','roundingRemainder'].some(key=>amount(l.taxProtocol[key])===null)||amount(l.credits?.base)===null))throw Error();
      const ledger=taxProtocolLedger(l);taxProtocolCredit=quantity(ledger.creditQuote);taxSourceBaseCredit=quantity(ledger.sourceBaseCredit);
      if(taxProtocolCredit===null||taxSourceBaseCredit===null)throw Error();
    }catch{taxProtocolCredit=null;taxSourceBaseCredit=null;coinIssues.push('invalid_tax_ledger');}
    if(protocolCredit===null||protocolBaseCredit===null)coinIssues.push('invalid_protocol_ledger');
    if([protocolCredit,protocolBaseCredit,taxProtocolCredit].some(value=>value!==null&&BigInt(value)>0n))coinIssues.push('collected_awaiting_forward');
    if(taxSourceBaseCredit!==null&&BigInt(taxSourceBaseCredit)>0n)coinIssues.push('tax_conversion_pending');
    const creationOps=ops.filter(op=>['create','launch-all'].includes(op?.kind)&&op.state==='confirmed');
    const reviewedCreationFee=creationFee(l.review?.protocolFees?.creationFeeSol);
    const missing=creationOps.filter(op=>!op.creationFeeReceipt&&(reviewedCreationFee===null||Number(reviewedCreationFee)>0)).length;
    untrackedCreationReceipts+=missing;if(missing)coinIssues.push('creation_history_untracked');
    coins.push({id:id(l.id),accountId:id(accountId),name:text(l.input?.name),symbol:text(l.input?.symbol,30),mint:address(l.keys?.mint?.address),quoteMint:address(l.input?.quoteMint),quoteSymbol:text(l.review?.quoteSymbol||l.input?.quoteSymbol,30),quoteDecimals:decimals(l.review?.quoteDecimals),baseDecimals:6,platformFeeBps,protocolWallet,recipient:savedPolicy?.recipientScope==='launchpad'?recipient:address(l.review?.protocolFees?.recipient),autoHarvest,lpPolicy,taxBps,protocolCredit,protocolBaseCredit,taxProtocolCredit,taxSourceBaseCredit,pending,issues:coinIssues});
  }
  let sources=[];try{sources=protocolTreasurySources(launches,additionalSources);}catch{
    historyIssue();
    // Preserve other retained receipts when an individual saved operation is corrupt.
    // The shared source builder still performs final deduplication and attribution.
    const recoverable=launches.map(launch=>({...launch,operations:(Array.isArray(launch.operations)?launch.operations:[]).filter(op=>{try{protocolTreasurySources([{...launch,operations:[op]}]);return true;}catch{return false;}})}));
    sources=protocolTreasurySources(recoverable,additionalSources);
  }
  const transfers=sources.filter(source=>{if(signature(source.signature))return true;historyIssue();return false;}).map(source=>({signature:signature(source.signature),mint:address(source.mint),amount:quantity(source.amount),recipient:address(source.wallet),sourceWallet:address(source.sourceWallet),decimals:decimals(source.decimals),symbol:text(source.symbol,30),kind:source.kind,currentRecipient:!!recipient&&source.wallet===recipient}));
  const groups=new Map();for(const transfer of transfers){
    const key=JSON.stringify([transfer.mint,transfer.recipient,transfer.kind,transfer.decimals]);
    let group=groups.get(key);if(!group){group={mint:transfer.mint,symbol:transfer.symbol,decimals:transfer.decimals,recipient:transfer.recipient,kind:transfer.kind,amount:'0',receipts:0,currentRecipient:transfer.currentRecipient};groups.set(key,group);}
    group.amount=(BigInt(group.amount)+BigInt(transfer.amount)).toString();group.receipts++;
  }
  const previous=transfers.filter(source=>!source.currentRecipient).length;
  if(previous)issues.push({code:'previous_recipient_history',scope:'history',count:previous});
  if(untrackedCreationReceipts)issues.push({code:'creation_history_untracked',scope:'history',count:untrackedCreationReceipts});
  return{version:1,generatedAt:timestamp(now),evidence:'saved-records',liveChainVerified:false,policy,treasury,summary:{launches:coins.length,meteoraReceipts:transfers.filter(row=>row.kind==='meteora-partner-payout').length,legacyLaunches,pendingOperations,untrackedCreationReceipts,attentionCount:issues.length+coins.filter(coin=>coin.issues.length).length},totals:[...groups.values()],transfers,coins,issues};
}

export class AdminRevenueAudit{
  constructor({accounts,launchpad,meteoraSources=null,now=Date.now,maxAccounts=10000,maxRecords=200000}={}){Object.assign(this,{accounts,launchpad,meteoraSources,now,maxAccounts,maxRecords});}
  async requireAdmin(actorId){const actor=await this.accounts.get(actorId);if(!actor||actor.role!=='admin'||actor.mfaEnabled!==true||actor.banned)fail('Administrator access with two-factor authentication is required.',403);}
  async read(actorId){
    await this.requireAdmin(actorId);
    const [savedPolicy,savedTreasury,accounts]=await Promise.all([this.accounts.hostStore.read('launch-protocol-fees',null),this.accounts.hostStore.read('protocol-treasury',null),this.accounts.list()]);
    if(!Array.isArray(accounts))fail('Saved account history could not be read.');
    if(accounts.length>this.maxAccounts)fail('Revenue history exceeds its account scan limit.');
    const rows=[];let count=0;
    for(const account of accounts){
      if(!account||typeof account.id!=='string')fail('Saved account history could not be read.');
      const book=this.launchpad?.book?await this.launchpad.book(account.id):await this.accounts.storeFor(account.id).read('launchpad',{launches:[]});
      if(!Array.isArray(book?.launches))fail('Saved launch history could not be read.');
      for(const launch of book.launches){count+=1+(Array.isArray(launch?.operations)?launch.operations.length:0);if(count>this.maxRecords)fail('Revenue history exceeds its record scan limit.');rows.push({accountId:account.id,launch});}
    }
    const additionalSources=typeof this.meteoraSources==='function'?await this.meteoraSources():[];if(!Array.isArray(additionalSources)||additionalSources.length>this.maxRecords)fail('Meteora revenue history exceeds its scan limit.');
    const result=buildAdminRevenueAudit({rows,savedPolicy,savedTreasury,additionalSources,now:this.now()});
    await this.requireAdmin(actorId);return result;
  }
}
