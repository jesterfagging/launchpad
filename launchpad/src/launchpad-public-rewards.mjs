import { receiptDeltas } from './launchpad-receipts.mjs';
import { displayUnits } from '../public/launchpad-model.mjs';
import { holderRewardDistributionStats, publicHolderRewards, publicHolderTaxBurn } from './launchpad-holder-rewards.mjs';
import { LaunchRewardsView } from './launchpad-rewards-view.mjs';
import { quoteLabel } from '../public/quote-identity.mjs';
import { dedicatedRewardsWallet } from './launchpad-rewards-wallet.mjs';
import { PublicKey } from '@solana/web3.js';
import { autoRewardEnabled } from './launchpad-reward-recovery.mjs';
import { publicTaxMaintenance } from './launchpad-tax-maintenance-status.mjs';
import { PAYCHECK_POLICY, paycheckLaunch, publicPaycheck } from './launchpad-paycheck.mjs';

const REFRESH_MS=30_000, MAX_PENDING=3, MAX_STARTS=20;
const unsigned=value=>typeof value==='string'&&/^\d{1,40}$/.test(value)?BigInt(value):null;
const signed=value=>typeof value==='string'&&/^-?\d{1,40}$/.test(value)?BigInt(value):null;
const stamp=value=>Number.isSafeInteger(value)&&value>0?value:null;
const retryStamp=value=>{const at=stamp(value);return at!==null&&at<=8640000000000000?at:null;};
const signature=value=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value);
const text=(value,max=24)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,max):'';
const amount=(value,decimals)=>value===null?null:displayUnits(value,decimals);
const walletAddress=value=>{try{return typeof value==='string'&&new PublicKey(value).toBase58()===value?value:null;}catch{return null;}};

/** Extract the public managed-service state from the complete private journal.
 * Keep only evidence needed for aggregate accounting. No recipients, account
 * identity, signed bytes, secrets, wallet balance, or private RPC is retained. */
export function publicRewardRecord(launch,chainRecord,coin) {
  if(!['holders','buyback','paycheck'].includes(coin.feeMode))return null;
  // A Paycheck coin (v71.44) is a holder-rewards launch; its public ledger is aggregate only (no wallet is named).
  const paycheck=coin.feeMode==='paycheck'&&paycheckLaunch(launch);
  const rewards=launch.rewardsWallet,hasRewardState=(coin.feeMode==='holders'||paycheck)&&['migrating','active'].includes(rewards?.status),rewardAddress=hasRewardState?walletAddress(rewards.address):null,hasRewards=hasRewardState&&rewards.version===1&&rewardAddress&&rewards.address===launch.keys?.rewards?.address&&dedicatedRewardsWallet(launch,{requireSecret:false});
  const rawOperations=Array.isArray(launch.operations)?launch.operations:[],operations=rawOperations.filter(op=>['create','launch-all','claim','tax','tax-burn','sell','gas-sell','buy','burn','payout','reward-handoff'].includes(op.kind)).map(op=>({
    kind:op.kind,state:['confirmed','pending','awaiting_signature','failed'].includes(op.state)?op.state:'unknown',signature:signature(op.signature)?op.signature:null,operationId:typeof op.operationId==='string'?op.operationId.slice(0,100):undefined,
    slot:Number.isSafeInteger(op.slot)&&op.slot>0?op.slot:null,createdAt:stamp(op.createdAt),confirmedAt:stamp(op.confirmedAt),failedAt:stamp(op.failedAt),amount:unsigned(op.amount)!==null?op.amount:null,
    holderRewardCycleId:typeof op.holderRewardCycleId==='string'?op.holderRewardCycleId.slice(0,100):undefined,
    payouts:Array.isArray(op.payouts)?op.payouts.map(row=>({amount:unsigned(row.amount)!==null?row.amount:null})):[],
    receipt:op.receipt?{quoteDelta:signed(op.receipt.quoteDelta)!==null?op.receipt.quoteDelta:null,baseDelta:signed(op.receipt.baseDelta)!==null?op.receipt.baseDelta:null}:null,
  }));
  return {...chainRecord,keys:{...chainRecord.keys,...(hasRewards?{rewards:{address:rewardAddress}}:{})},rewardsWallet:hasRewardState?{version:1,status:rewards.status,address:rewardAddress,available:!!hasRewards}:null,id:coin.mint,authorizedAt:stamp(launch.authorizedAt),createdAt:coin.createdAt,input:{...chainRecord.input,feeMode:paycheck?'holders':coin.feeMode,...(paycheck?{paycheck:{policy:PAYCHECK_POLICY}}:{}),taxBps:coin.taxBps,creatorFeeBps:coin.creatorFeeBps},...(paycheck?{paycheckView:publicPaycheck(launch,{decimals:Number.isInteger(chainRecord.review?.quoteDecimals)?chainRecord.review.quoteDecimals:9})}:{}),review:{...chainRecord.review,quoteSymbol:quoteLabel(coin.quote.mint,coin.quote.symbol),price:{usd:typeof launch.review?.price?.usd==='string'?launch.review.price.usd:''}},
    feeCustody:launch.feeCustody==='relay'&&!launch.feeWalletExportedAt&&!launch.walletExportedAt&&!launch.keys?.wallet?.exportedAt?'relay':'shared',state:['live','paused','error','launching','awaiting_signature'].includes(launch.state)?launch.state:'paused',autoFees:launch.autoFees===true,feesRequested:launch.feesRequested===true,rewardRetryAt:retryStamp(launch.rewardRetry?.at),
    automationEnabled:autoRewardEnabled(launch),taxMaintenance:publicTaxMaintenance(launch),credits:{quote:unsigned(launch.credits?.quote)!==null?launch.credits.quote:null,base:unsigned(launch.credits?.base)!==null?launch.credits.base:null},
    cycle:launch.cycle?{stage:text(launch.cycle.stage)}:null,lastCycle:stamp(launch.lastCycle),lastHolderRewardCheck:stamp(launch.lastHolderRewardCheck),lastTaxConversionAt:stamp(launch.lastTaxConversionAt),
    holderRewards:{minimumQuoteUnits:unsigned(launch.holderRewards?.minimumQuoteUnits)!==null?launch.holderRewards.minimumQuoteUnits:undefined,lastDistributionAt:stamp(launch.holderRewards?.lastDistributionAt),lastDistributionQuoteUnits:unsigned(launch.holderRewards?.lastDistributionQuoteUnits)!==null?launch.holderRewards.lastDistributionQuoteUnits:undefined},taxBurnView:publicHolderTaxBurn(launch),
    invalidConfirmedKinds:[...new Set(operations.filter(op=>!['create','launch-all'].includes(op.kind)&&op.state==='confirmed'&&(!op.signature||!op.slot||['buy','burn','payout','sell','gas-sell'].includes(op.kind)&&(unsigned(op.amount)===null||unsigned(op.amount)<=0n))).map(op=>op.kind))],
    historyComplete:operations.some(op=>['create','launch-all'].includes(op.kind)&&op.state==='confirmed'&&op.signature&&op.slot)&&launch.historyTruncated!==true&&launch.operationsTruncated!==true,operations};
}

function confirmedOperations(record) {
  const signatures=new Set(),ids=new Set(),rows=[];
  for(const op of record.operations){if(op.state!=='confirmed'||!op.signature||!op.slot||signatures.has(op.signature)||op.operationId&&ids.has(op.operationId))continue;signatures.add(op.signature);if(op.operationId)ids.add(op.operationId);rows.push(op);}
  return rows;
}

export function publicRewardSummary(record,coin,now=Date.now()) {
  const decimals=record.review.quoteDecimals;if(!Number.isInteger(decimals)||decimals<0||decimals>12)throw Error('Reward token decimals are unavailable.');
  const operations=confirmedOperations(record),pending=record.operations.filter(op=>['pending','awaiting_signature'].includes(op.state)&&!['create','launch-all'].includes(op.kind));
  const automationEnabled=record.automationEnabled??record.autoFees,enabled=automationEnabled&&record.state==='live',processing=pending.length>0||record.state==='live'&&(!!record.cycle||record.feesRequested);
  const nextRetry=retryStamp(record.rewardRetryAt),retryAt=enabled&&record.feesRequested&&nextRetry>now?nextRetry:null;
  const pendingQuote=amount(unsigned(record.credits.quote),decimals),pendingBase=amount(unsigned(record.credits.base),6);
  const activeRewards=record.rewardsWallet?.status==='active',rewardsAddress=activeRewards?walletAddress(record.rewardsWallet.address):null,rewardsAvailable=activeRewards&&record.rewardsWallet.available!==false&&record.rewardsWallet.address===record.keys?.rewards?.address&&dedicatedRewardsWallet(record,{requireSecret:false}),managed=record.feeCustody==='relay',activityAddress=activeRewards?rewardsAddress:record.keys.wallet.address;
  const paycheck=coin.feeMode==='paycheck',holderLike=coin.feeMode==='holders'||paycheck;
  const summary={mint:coin.mint,mode:coin.feeMode,enabled,status:retryAt?'retrying':processing?'processing':enabled?'enabled':'paused',retryAt,quote:{mint:coin.quote.mint,symbol:quoteLabel(coin.quote.mint,coin.quote.symbol),decimals},tokenSymbol:coin.symbol,creatorFeeBps:coin.creatorFeeBps,taxBps:coin.taxBps,asOf:null,ledgerAt:now,refreshMs:REFRESH_MS,stale:true,error:null,activityUrl:managed&&activityAddress?'https://solscan.io/account/'+activityAddress:null,wallets:managed&&holderLike?{creatorAddress:record.keys.wallet.address,rewardsAddress,status:activeRewards?rewardsAvailable?'active':'unavailable':record.rewardsWallet?.status==='migrating'?'migrating':'legacy'}:null,holder:null,buyback:null,...(paycheck?{paycheck:record.paycheckView||null}:{})};
  const shared=record.feeCustody!=='relay',unclaimedNote=shared?'This older launch shares a fee vault. Per-coin unclaimed creator fees are unavailable.':'Unclaimed creator fees cover the LaunchLab curve vault; migrated pool fees are not included.';
  if(holderLike){
    summary.taxBurn=record.taxBurnView||null;
    if(summary.taxBurn){summary.automation={enabled:automationEnabled===true,state:record.state,step:record.cycle?.stage||null};summary.taxMaintenance=record.taxMaintenance||null;}
    let schedule=null;try{schedule=publicHolderRewards(record);}catch{}
    const stats=holderRewardDistributionStats(record),complete=record.historyComplete&&!record.invalidConfirmedKinds?.includes('payout');
    summary.holder={distributedQuote:complete?stats.totalDistributedQuote:null,distributedBasis:'quote_sent',payments:complete?stats.totalPayments:null,lastDistributionAt:stats.lastDistributionAt,lastDistributionQuote:stats.lastDistributionQuote,pendingQuote,unconvertedTaxTokens:summary.taxBurn?.selected?null:pendingBase,withheldTokens:coin.taxBps?null:'0',withheldIsEstimate:true,withheldAsOf:null,withheldStale:!!coin.taxBps,unclaimedCreatorQuote:null,unclaimedScope:'curve',unclaimedShared:shared,unclaimedNote,intervalMinutes:schedule?.intervalMinutes??(paycheck?15:60),minimumUsd:schedule?.minimumUsd??(paycheck?1:100),minimumQuote:schedule?.minimumQuote??null,nextCheckAt:schedule?.nextCheckAt??null,pendingOperations:pending.length,historyComplete:complete,historyNote:complete?'Confirmed quote amounts sent to holders since this launch.':'Older distribution history is incomplete; lifetime distributed totals are unavailable.'};
  }else{
    const buys=operations.filter(op=>op.kind==='buy'),burns=operations.filter(op=>op.kind==='burn'),claims=operations.filter(op=>op.kind==='claim');
    let spent=0n,bought=0n,burned=0n,claimedQuote=0n,claimedTokens=0n,buyComplete=record.historyComplete&&!record.invalidConfirmedKinds?.includes('buy'),burnComplete=record.historyComplete&&!record.invalidConfirmedKinds?.includes('burn'),claimComplete=record.historyComplete&&!record.invalidConfirmedKinds?.includes('claim')&&!shared;
    for(const op of buys){const q=signed(op.receipt?.quoteDelta),b=signed(op.receipt?.baseDelta);if(q===null||q>=0n||b===null||b<=0n){buyComplete=false;continue;}spent-=q;bought+=b;}
    for(const op of burns){const value=unsigned(op.amount);if(value===null||value<=0n){burnComplete=false;continue;}burned+=value;}
    for(const op of claims){const q=signed(op.receipt?.quoteDelta),b=signed(op.receipt?.baseDelta);if(q===null||q<0n||b===null||b<0n){claimComplete=false;continue;}claimedQuote+=q;claimedTokens+=b;}
    const complete=buyComplete&&burnComplete&&claimComplete;
    const last=buys.reduce((latest,op)=>!latest||op.slot>latest.slot?op:latest,null);
    summary.buyback={totalQuoteSpent:buyComplete?amount(spent,decimals):null,tokensBought:buyComplete?amount(bought,6):null,tokensBurned:burnComplete?amount(burned,6):null,completedBuys:buys.length,completedBurns:burns.length,pendingOperations:pending.length,pendingQuote,pendingBurnTokens:pendingBase,totalClaimedQuote:claimComplete?amount(claimedQuote,decimals):null,totalClaimedTokens:claimComplete?amount(claimedTokens,6):null,unclaimedCreatorQuote:null,unclaimedScope:'curve',unclaimedShared:shared,unclaimedNote,lastBuybackAt:last?last.confirmedAt||last.createdAt:null,buybackPercent:100,intervalMinutes:1,historyComplete:complete,historyNote:complete?'Confirmed fee claims, purchases and burns recorded since this launch.':shared?'This older service shares its creator-fee wallet. Claimed revenue cannot be attributed to this coin; confirmed purchases and burns remain shown.':'Some older receipts do not record actual amounts. Unavailable lifetime totals are shown as unknown; purchase budgets are not treated as spending.'};
  }
  return summary;
}

/** A public adapter around the existing verified read-only reward balances.
 * Share the host chain; the underlying viewer cannot close or sign through it. */
export class PublicLaunchRewards {
  constructor({chainFor,now=Date.now,view}={}){
    this.now=now;this.chainFor=chainFor;this.closed=false;this.starts=[];this.pending=new Map();this.cache=new Map();this.receiptCache=new Map();this.historyPending=new Map();this.historyStarts=[];this.view=view||new LaunchRewardsView({now,chainFor:async()=>{const chain=await chainFor();return {c:chain.c};}});
  }
  async recoverHistory(record){
    // Historical reads never modify earned credit or submit/replay transactions.
    if(record.input.feeMode!=='buyback'||!this.chainFor)return record;
    const key=record.keys.mint.address;
    if(this.historyPending.has(key))await this.historyPending.get(key);
    else {
      const job=(async()=>{
        const missing=record.operations.filter(op=>op.state==='confirmed'&&['buy','claim'].includes(op.kind)&&op.signature&&op.slot&&(!op.receipt||signed(op.receipt.quoteDelta)===null||signed(op.receipt.baseDelta)===null)&&!((this.receiptCache.get(key+':'+op.signature)?.until||0)>this.now())).slice(0,2);
        if(!missing.length)return;
        this.historyStarts=this.historyStarts.filter(at=>at>this.now()-60_000);
        if(this.historyPending.size>=MAX_PENDING||this.historyStarts.length>=MAX_STARTS)return;
        this.historyStarts.push(this.now());
        const chain=await this.chainFor();if(typeof chain?.receipt!=='function')return;
        for(const op of missing){
          const cacheKey=key+':'+op.signature;
          this.receiptCache.set(cacheKey,{until:this.now()+60_000});
          while(this.receiptCache.size>1000)this.receiptCache.delete(this.receiptCache.keys().next().value);
          try{
            const tx=await chain.receipt(op);
            if(!tx||tx.meta?.err||tx.slot!==op.slot||tx.transaction?.signatures?.[0]!==op.signature)continue;
            const delta=receiptDeltas(tx,record);
            if(op.kind==='buy'&&(delta.quote>=0n||delta.base<=0n||unsigned(op.amount)===null||-delta.quote>BigInt(op.amount)))continue;
            if(op.kind==='claim'&&(delta.quote<0n||delta.base<0n))continue;
            this.receiptCache.set(cacheKey,{until:Infinity,receipt:{quoteDelta:String(delta.quote),baseDelta:String(delta.base)}});
          }catch{} // Missing/pruned history stays unknown; retry at a bounded rate.
          while(this.receiptCache.size>1000)this.receiptCache.delete(this.receiptCache.keys().next().value);
        }
      })().catch(()=>{}).finally(()=>this.historyPending.delete(key));
      this.historyPending.set(key,job);await job;
    }
    return {...record,operations:record.operations.map(op=>({...op,receipt:op.receipt&&signed(op.receipt.quoteDelta)!==null&&signed(op.receipt.baseDelta)!==null?op.receipt:this.receiptCache.get(key+':'+op.signature)?.receipt||op.receipt}))};
  }
  async read(record,coin){
    if(this.closed)throw Object.assign(Error('Public reward statistics are restarting.'),{statusCode:503});
    record=await this.recoverHistory(record);
    const result=publicRewardSummary(record,coin,this.now()),section=result.holder||result.buyback,key=[coin.mint,record.keys.wallet.address,record.rewardsWallet?.status,record.rewardsWallet?.address,record.rewardsWallet?.available].join(':');
    // This adapter uses an internal public namespace, not an account ID. The
    // buyback balance reader needs the same vault/mint checks as holder mode;
    // its synthetic holder policy is never returned or used for transactions.
    const readRecord={...record,input:{...record.input,feeMode:'holders'},holderRewards:{...record.holderRewards,minimumQuoteUnits:record.holderRewards.minimumQuoteUnits||'1'},credits:{quote:record.credits.quote||'0',base:record.credits.base||'0'}};
    const now=this.now();this.starts=this.starts.filter(at=>at>now-60_000);
    let cached=this.cache.get(key),value,pool;
    if(this.pending.has(key))cached=await this.pending.get(key);
    else if(cached?.until>now){}
    else if(this.pending.size>=MAX_PENDING||this.starts.length>=MAX_STARTS){result.error='Reward balances are refreshing. Please try again shortly.';return result;}
    else {
      this.starts.push(now);
      const job=(async()=>{
        const [balance,poolRead]=await Promise.allSettled([this.view.read('public-discovery',readRecord),(async()=>{
          const chain=await this.chainFor?.();if(!chain?.migratedRayPool)return null;
          const migrated=await chain.migratedRayPool(record);if(!migrated)return null;
          const p=migrated.pool,base=coin.mint,quote=coin.quote.mint,a=p.mintA.toBase58(),b=p.mintB.toBase58();
          if(!([a,b].includes(base)&&[a,b].includes(quote))||p.poolCreator.toBase58()!==record.keys.wallet.address)throw Error('Mismatched migrated reward pool.');
          const qa=unsigned((a===quote?p.creatorFeesMintA:p.creatorFeesMintB).toString()),ba=unsigned((a===base?p.creatorFeesMintA:p.creatorFeesMintB).toString());
          if(qa===null||ba===null)throw Error('Invalid migrated reward fees.');
          return {quote:amount(qa,record.review.quoteDecimals),base:amount(ba,6),asOf:this.now()};
        })()]);
        const next={until:this.now()+REFRESH_MS,value:balance.status==='fulfilled'?balance.value:null,pool:poolRead.status==='fulfilled'?poolRead.value:null};this.cache.delete(key);this.cache.set(key,next);while(this.cache.size>100)this.cache.delete(this.cache.keys().next().value);return next;
      })().finally(()=>this.pending.delete(key));this.pending.set(key,job);cached=await job;
    }
    value=cached?.value;pool=cached?.pool;
    if(value?.mint!==coin.mint){result.error='Reward balances are temporarily unavailable.';return result;}
    result.quote.symbol=quoteLabel(coin.quote.mint,value.wallet?.quoteSymbol,coin.quote.symbol);
    result.asOf=stamp(value.asOf);result.stale=value.stale!==false;result.error=result.stale?'Reward balances are temporarily unavailable. Last observed amounts may be shown.':null;
    section.unclaimedCurveQuote=section.unclaimedShared?null:typeof value.unclaimedCreatorQuote==='string'&&/^\d+(?:\.\d+)?$/.test(value.unclaimedCreatorQuote)?value.unclaimedCreatorQuote:null;
    section.unclaimedPoolQuote=pool?.quote??null;section.unclaimedBaseTokens=pool?.base??null;
    section.unclaimedScope=pool?'curve_and_pool':'curve';
    section.unclaimedCreatorQuote=section.unclaimedCurveQuote;
    if(pool&&section.unclaimedCurveQuote!==null){const toRaw=value=>{const [a,b='']=value.split('.');return BigInt(a)*10n**BigInt(record.review.quoteDecimals)+BigInt(b.padEnd(record.review.quoteDecimals,'0'));};section.unclaimedCreatorQuote=amount(toRaw(section.unclaimedCurveQuote)+toRaw(pool.quote),record.review.quoteDecimals);}
    if(pool&&!section.unclaimedShared)section.unclaimedNote='Unclaimed creator fees include the curve vault and migrated pool counters. They become earned reward credit after collection confirms.';
    if(!pool&&coin.curveStatus==='migrated'){
      section.unclaimedCreatorQuote=null;section.unclaimedPoolPending=true;
      section.unclaimedNote=section.unclaimedShared?section.unclaimedNote+' The graduated pool fee counters are also temporarily unavailable.':'This token has graduated. Its pool fee counters are temporarily unavailable, so total unclaimed creator fees are unknown.';
      result.stale=true;result.error='Graduated pool fee balances are temporarily unavailable.';
    }
    if(result.holder){const tax=value.taxes;section.withheldTokens=typeof tax?.withheldTokens==='string'&&/^\d+(?:\.\d+)?$/.test(tax.withheldTokens)?tax.withheldTokens:coin.taxBps?null:'0';section.withheldAsOf=stamp(tax?.asOf);section.withheldStale=tax?.stale!==false;}
    return result;
  }
  async close(){this.closed=true;await Promise.allSettled([...this.pending.values(),...this.historyPending.values()]);await this.view.close?.();this.pending.clear();this.cache.clear();this.receiptCache.clear();this.historyPending.clear();}
}
