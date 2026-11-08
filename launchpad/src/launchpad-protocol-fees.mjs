import { PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import {newLaunchKeys,signer} from './launchpad-receipts.mjs';
import { join } from 'node:path';
import { acquireProcessLock } from './process-lock.mjs';
import { isCurrentLaunch, displayUnits, units } from '../public/launchpad-model.mjs';
import { quoteLabel } from '../public/quote-identity.mjs';
import { protocolLiquiditySnapshot } from './launchpad-protocol-liquidity.mjs';
import {effectiveCreatorFeeRate} from '../public/creator-fee-schedule.mjs';
import {PROTOCOL_POLICY_VERSION,protocolPolicyTarget,currentProtocolPolicy} from './launchpad-policy-upgrade.mjs';
import {protocolWalletSelection,managedProtocolWallet,separatePlatformWallet,dedicatedProtocolWallet,legacyProtocolUpgrade} from './launchpad-protocol-wallet.mjs';
import {hasTransferTax,taxProtocolLedger,TAX_PROTOCOL_POLICY,TAX_PROTOCOL_SHARE_BPS} from './launchpad-tax-protocol.mjs';
import {publicHolderTaxBurn} from './launchpad-holder-rewards.mjs';

export const PLATFORM_FEE_BPS = 100;
export const PLATFORM_FEE_RATE = '10000'; // LaunchLab fee denominator: 1,000,000.
const fail=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode});};
const validId=value=>{if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))fail('Invalid account or launch ID.');return value;};
const validRequestId=value=>{if(typeof value!=='string'||!/^[a-f0-9-]{16,64}$/.test(value))fail('A unique claim request ID is required.');return value;};
const validMeteoraId=value=>{if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))fail('Invalid Meteora launch ID.');return value;};
const mintAddress=value=>{try{if(typeof value!=='string'||new PublicKey(value).toBase58()!==value)throw Error();return value;}catch{fail('Invalid launch mint.');}};
const claimAllDigest=(...parts)=>createHash('sha256').update(JSON.stringify(['protocol-claim-all-v1',...parts])).digest('hex');
const wallet=value=>{try{const p=new PublicKey(typeof value==='string'?value.trim():'');if(!PublicKey.isOnCurve(p.toBytes()))throw Error();return p.toBase58();}catch{fail('Enter a valid Solana wallet for protocol revenue.');}};
// Future launches always use the current platform allocation, including hosts
// that saved an explicit burn policy in an earlier build. Historical onchain
// launch snapshots still retain their original LP terms.
export const NEW_LAUNCH_LIQUIDITY=Object.freeze({lpPolicy:'platform_locked',platformLpPercent:75});
const currentLiquidity=()=>({...NEW_LAUNCH_LIQUIDITY});
const policyView=value=>({recipient:value?.recipient||'',curveFeeBps:PLATFORM_FEE_BPS,curveFeePercent:1,taxRevenueShareBps:500,creationFeeSol:value?.creationFeeSol||'0',autoHarvest:value?.autoHarvest!==false,harvestIntervalMinutes:60,minimumHarvestUsd:5,lpHarvestIntervalSeconds:60,lpMinimumHarvestUsd:0,configured:!!value?.recipient,updatedAt:value?.updatedAt||null,updatedBy:value?.updatedBy||null,...currentLiquidity(value),existingLaunches:'explicit activation required'});
export const protocolFeeSnapshot=p=>({recipient:p.recipient,curveFeeBps:PLATFORM_FEE_BPS,creationFeeSol:p.creationFeeSol||'0',autoHarvest:p.autoHarvest!==false,...protocolLiquiditySnapshot(p)});

export async function launchProtocolPolicy(accounts,{required=true}={}){
  const value=await accounts.hostStore?.read('launch-protocol-fees',null);
  if(!value?.recipient){if(required)fail('Configure Launchpad’s launchpad fee wallet in the Admin panel before creating a new coin.',503);return policyView(null);}
  if(required){const toolkit=await accounts.hostStore.read('fee-policy',{});if(value.recipient===toolkit.recipient)fail('Configure a separate launchpad fee wallet in the Admin panel before creating a new coin.',503);}
  return {...policyView(value),recipient:wallet(value.recipient),recipientScope:value.recipientScope==='launchpad'?'launchpad':'legacy'};
}
const platformKey=l=>l.keys.platform||l.keys.wallet;
const compromisedPlatform=l=>{const key=platformKey(l);return !!(key?.compromised||key?.compromisedAt||l.platformWalletCompromisedAt||(key?.address===l.keys.wallet.address&&l.walletCompromisedAt));};
const exclusiveLegacyPlatform=(l,context={})=>!l.keys.protocol&&separatePlatformWallet(l)&&!context.platformShared&&!context.platformKeyShared&&!context.platformPersonal&&!compromisedPlatform(l);
const rewardKinds=new Set(['claim','tax','tax-burn','sell','gas-sell','buy','burn','payout','tax-protocol-payout','reward-handoff']);
const operationView=({kind,state,signature,createdAt})=>({kind,state,signature,createdAt});
function protocolRetryView(retry){
  if(!Number.isSafeInteger(retry?.at)||retry.at<0||retry.at>8640000000000000||!Number.isSafeInteger(retry.attempt)||retry.attempt<1||typeof retry.kind!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(retry.kind))return null;
  const reason=typeof retry.reason==='string'?retry.reason.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi,'[provider]').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,300):'';
  return {at:retry.at,kind:retry.kind,attempt:retry.attempt,reason};
}

export function protocolFeeEligibility(l,{activate=false,shared=false,personal=false,platformShared=shared,platformKeyShared=shared,platformPersonal=personal,protocolShared=shared,protocolPersonal=personal,proposedProtocolShared=false,proposedProtocolPersonal=false,ownerMatch=false}={}){
  if(!isCurrentLaunch(l.input)||!l.curve||!l.authorizedAt)return {allowed:false,reason:'A verified live Solana launch is required.'};
  if(!activate&&(l.review?.platformFeeBps!==PLATFORM_FEE_BPS||!l.review?.protocolFees?.recipient))return {allowed:false,reason:'This launch predates Launchpad’s onchain 1% platform fee.'};
  if(activate&&currentProtocolPolicy(l))return {allowed:false,reason:'This launch already uses 75% locked LP and the current creator-fee policy for its reward mode.'};
  if(activate&&![0,PLATFORM_FEE_BPS].includes(l.review?.platformFeeBps||0))return {allowed:false,reason:'This launch has an unsupported platform fee.'};
  if(activate&&l.creatorFees?.status==='graduated')return {allowed:false,reason:'A graduated launch cannot change its migration allocation.'};
  const legacy=activate&&legacyProtocolUpgrade(l),adminKey=platformKey(l);
  if(activate&&platformShared)return {allowed:false,reason:'This platform configuration is shared by multiple live launches. Its policy cannot be upgraded for only this coin.'};
  if(activate&&compromisedPlatform(l))return {allowed:false,reason:'The original platform administrator is marked as compromised. Resolve its signing authority before upgrading.'};
  if(legacy){
    if(adminKey?.external)return {allowed:false,reason:'The original platform administrator is held by an external wallet. This upgrade requires its wallet signature.'};
    if(!adminKey?.secret)return {allowed:false,reason:'The original platform administrator key is missing from this launch record. Restore its original encrypted launch data before upgrading.'};
    if(!exclusiveLegacyPlatform(l,{platformShared,platformKeyShared,platformPersonal})){
      if(!ownerMatch)return {allowed:false,reason:'Sign in as the launch owner with administrator access to assign a new protocol fee wallet. This legacy administrator is not a separate, unexported platform wallet.'};
      if(proposedProtocolShared||proposedProtocolPersonal)return {allowed:false,reason:'The saved protocol fee wallet is shared or personal. Restore its dedicated signing wallet before upgrading.'};
      if(l.keys.protocol&&!dedicatedProtocolWallet(l))return {allowed:false,reason:'The saved protocol fee signer is unavailable, exported or no longer separate. Restore its original encrypted launch data before retrying.'};
    }
  }else{
    if(!managedProtocolWallet(l))return {allowed:false,reason:'A dedicated Launchpad protocol fee signer is required.'};
    if(protocolShared||protocolPersonal)return {allowed:false,reason:'Shared or personal fee keys cannot manage protocol revenue.'};
  }
  if(activate&&!(l.keys.platform||l.keys.wallet).secret)return {allowed:false,reason:'The platform administrator signing key is unavailable.'};
  if(activate&&adminKey?.external)return {allowed:false,reason:'The original platform administrator is held by an external wallet. This upgrade requires its wallet signature.'};
  if(activate&&!legacy&&(adminKey?.exportedAt||l.platformWalletExportedAt))return {allowed:false,reason:'The platform administrator key was exported. This launch requires an unexported managed administrator for its policy upgrade.'};
  // Successful launch recovery retains its audit record as "not-needed" after
  // verifyLaunch confirms the onchain curve. That record is not ongoing setup
  // recovery. Keep all other recovery states and pending transactions blocked.
  if(activate&&l.recovery&&l.recovery.status!=='not-needed')return {allowed:false,reason:'Launch setup recovery must verify that this launch succeeded before its policy can be upgraded.'};
  const unsettled=(l.operations||[]).filter(o=>['pending','awaiting_signature'].includes(o.state));
  const blocking=unsettled.find(o=>!rewardKinds.has(o.kind))||unsettled[0];
  const waitingForOperation=!activate&&blocking&&rewardKinds.has(blocking.kind)?operationView(blocking):null;
  if(blocking&&!waitingForOperation){
    const {kind,state,signature,createdAt}=blocking;
    return {allowed:false,reason:`The saved ${String(kind||'launch').replaceAll('-',' ')} transaction is ${state==='awaiting_signature'?'waiting for a wallet signature. Complete or cancel that request before activating or collecting fees.':'awaiting confirmation. Launchpad is checking its saved signature before activating or collecting fees.'}`,blockingOperation:{kind,state,signature,createdAt}};
  }
  if(l.protocolFeesRequested)return {allowed:false,reason:'A protocol operation is already queued. Refresh to check its progress.',...(waitingForOperation?{waitingForOperation}:{})};
  if(l.brandingRequested)return {allowed:false,reason:'Wait for the queued platform branding update to finish.'};
  // Protocol actions run at the next transaction boundary without resetting
  // reward bookkeeping or held credit. A request can wait durably behind a
  // reward transaction; queueing never signs, cancels or skips that work.
  return {allowed:true,reason:'',...(waitingForOperation?{waitingForOperation}:{})};
}

const displayedCreatorFee=launch=>{try{return effectiveCreatorFeeRate(launch);}catch{return null;}};

const serviceWalletManaged=(l,{shared=false,personal=false,protocolShared=shared,protocolPersonal=personal}={})=>managedProtocolWallet(l)&&!protocolShared&&!protocolPersonal;

function serviceWallet(l,context){
  const legacy=legacyProtocolUpgrade(l),separate=legacy&&exclusiveLegacyPlatform(l,context);
  const fresh=legacy&&!separate&&context.ownerMatch&&!context.platformShared&&!compromisedPlatform(l)&&platformKey(l)?.secret&&!platformKey(l).external;
  const upgrade=!!(separate||fresh),target=l.protocolActivation?.protocolFeeWallet;
  return {address:upgrade?platformKey(l).address:protocolWalletSelection(l).address,managed:separate||serviceWalletManaged(l,context),upgrade,separateProtocol:!!fresh,protocolAddress:target?.source==='protocol'?target.address:l.protocolFeeWallet?.address||''};
}

const protocolGas=(l,now)=>{const limit=BigInt(l.input.dailyGasLamports||'0'),reserved=l.gas?.day===new Date(now).toISOString().slice(0,10)?BigInt(l.gas.reserved||'0'):0n;return {initialReserveSol:displayUnits(l.review.serviceReserve||'0'),dailyBudgetSol:displayUnits(limit),reservedTodaySol:displayUnits(reserved),remainingTodaySol:displayUnits(limit>reserved?limit-reserved:0n),balanceSol:null};};

// Tax revenue is a separate ledger from platform and locked-LP income. Show
// recorded provenance, not an estimate from balances or the token's tax rate.
function taxRevenueView(l){
  const eligible=hasTransferTax(l),amounts={harvestedBase:null,unconvertedBase:null,convertedQuote:null,holderQuote:null,accruedQuote:null,pendingQuote:null,paidQuote:null};
  const payouts=(l.operations||[]).filter(op=>op.kind==='tax-protocol-payout');
  const operations=payouts.slice(-20).map(op=>{
    let recipient='',amount=null;
    try{recipient=wallet(op.taxProtocolRecipient);}catch{}
    try{if(typeof op.amount==='string'&&/^\d+$/.test(op.amount))amount=displayUnits(op.amount,l.review.quoteDecimals);}catch{}
    return {kind:op.kind,state:op.state,signature:op.signature,createdAt:op.createdAt,confirmedAt:op.confirmedAt,recipient,amount};
  });
  const lastPayoutAt=payouts.reduce((last,op)=>op.state==='confirmed'&&Number.isSafeInteger(op.confirmedAt)&&op.confirmedAt>0?Math.max(last||0,op.confirmedAt):last,null);
  const taxBurn=publicHolderTaxBurn(l);
  const view={eligible,policy:TAX_PROTOCOL_POLICY,shareBps:TAX_PROTOCOL_SHARE_BPS,...(taxBurn?.selected?{currentShareBps:0,taxBurn}:{}),recorded:!!l.taxProtocol,status:eligible?'no_recorded_proceeds':'not_applicable',error:'',...amounts,lastPayoutAt,operations};
  if(!eligible)return view;
  try{
    const ledger=taxProtocolLedger(l),quote=key=>displayUnits(ledger[key],l.review.quoteDecimals);
    Object.assign(view,{harvestedBase:displayUnits(ledger.harvestedBase,6),unconvertedBase:displayUnits(ledger.sourceBaseCredit,6),convertedQuote:quote('convertedQuote'),holderQuote:quote('holderQuote'),accruedQuote:quote('accruedQuote'),pendingQuote:quote('creditQuote'),paidQuote:quote('paidQuote')});
    view.status=payouts.some(op=>['pending','awaiting_signature'].includes(op.state))?'pending_receipt':BigInt(ledger.creditQuote)>0n?'awaiting_payout':taxBurn?.selected?taxBurn.enabled&&!taxBurn.paused&&l.autoFees===true&&l.state==='live'?taxBurn.manual?'tax_burn_manual':'tax_burn_enabled':'tax_burn_paused':BigInt(ledger.sourceBaseCredit)>0n?'awaiting_conversion':view.recorded?'current':'no_recorded_proceeds';
  }catch{
    Object.assign(view,amounts,{status:'invalid_ledger',error:'Transfer-tax accounting needs review. Totals are unavailable until its saved record is verified.'});
  }
  return view;
}

// The protocol vault is distinct from the creator vault. Only confirmed
// protocol-claim receipts create spendable protocol credit; wallet balances,
// donations and holder reward credits never become protocol revenue.
export class LaunchProtocolFees {
  constructor({accounts,launchpad,meteora=null,now=Date.now}){this.accounts=accounts;this.launchpad=launchpad;this.meteora=meteora;this.now=now;}
  async requireAdmin(actorId){const actor=await this.accounts.get(validId(actorId));if(actor?.role!=='admin'||!actor.mfaEnabled||actor.banned)fail('Administrator access with two-factor authentication is required.',403);return actor;}
  async read(actorId){await this.requireAdmin(actorId);const result=await launchProtocolPolicy(this.accounts,{required:false});await this.requireAdmin(actorId);return result;}
  async configure(actorId,{recipient,expectedRecipient,reason,creationFeeSol,autoHarvest,lpPolicy,platformLpPercent}={}){
    await this.requireAdmin(actorId);const destination=wallet(recipient);
    if(typeof expectedRecipient!=='string')fail('Refresh protocol fee settings before saving.');
    if(typeof reason!=='string'||reason.trim().length<5||reason.trim().length>500)fail('Enter a reason between 5 and 500 characters.');
    const release=await acquireProcessLock(join(this.accounts.dir,'fee-recipients.lock'));
    try{const prior=await launchProtocolPolicy(this.accounts,{required:false});if(prior.recipient!==expectedRecipient)fail('The protocol fee wallet changed. Refresh before saving.',409);
      const treasury=await this.accounts.hostStore.read('protocol-treasury',null);
      if(treasury?.wallet?.address&&(treasury.enabled||treasury.activation||treasury.pending)&&destination!==treasury.wallet.address)fail('Pause treasury automation and wait for its pending transaction before changing the receiving wallet.',409);
      const toolkit=await this.accounts.hostStore.read('fee-policy',{});if(toolkit.recipient===destination)fail('Use a different wallet for launchpad fees. This address is the toolkit fee wallet.');
      const gasFunding=await this.accounts.hostStore.read('protocol-gas-funding',null);if(gasFunding?.wallet?.address===destination)fail('Use a separate wallet for launchpad fees; this address funds service gas.',409);
      const creationFee=units(creationFeeSol??prior.creationFeeSol,9,'Creation fee');if(creationFee>100000000n)fail('Creation fees cannot exceed 0.1 SOL.');
      autoHarvest=autoHarvest??prior.autoHarvest;if(typeof autoHarvest!=='boolean')fail('Choose whether automatic protocol fee collection is enabled.');
      if(lpPolicy!==undefined&&lpPolicy!=='platform_locked'||platformLpPercent!==undefined&&platformLpPercent!==75)fail('New launches require 75% permanently locked platform LP and 25% burned. Refresh the Admin panel before saving.',409);
      const liquidity=currentLiquidity();
      const actor=await this.requireAdmin(actorId),saved=await this.accounts.hostStore.read('launch-protocol-fees',{});
      const event={at:this.now(),actorId,actor:actor.username,from:prior.recipient,to:destination,fromCreationFeeSol:prior.creationFeeSol,toCreationFeeSol:displayUnits(creationFee),fromAutoHarvest:prior.autoHarvest,toAutoHarvest:autoHarvest,fromLiquidity:protocolLiquiditySnapshot(prior),toLiquidity:liquidity,reason:reason.trim()};
      await this.requireAdmin(actorId);
      const value={...saved,recipient:destination,recipientScope:'launchpad',creationFeeSol:displayUnits(creationFee),autoHarvest,...liquidity,liquidityPolicyVersion:1,updatedAt:event.at,updatedBy:actor.username,history:[...(saved.history||[]),event]};
      await this.accounts.hostStore.write('launch-protocol-fees',value);
      return {policy:policyView(value),audit:event};
    }finally{await release();}
  }
  async inventory(override,actorId){
    const policy=await launchProtocolPolicy(this.accounts,{required:false}),rows=[],uses=new Map(),platformCurves=new Map(),owners=new Map(),accounts=await this.accounts.list(),personal=new Set(accounts.map(a=>a.mainWallet));
    const add=(map,address,identity)=>{if(!address)return;const set=map.get(address)||new Set();set.add(identity);map.set(address,set);};
    for(const account of accounts){
      const book=override?.accountId===account.id?override.book:await this.launchpad.book(account.id);
      for(const l of book.launches||[]){
        rows.push({account,l});owners.set(l,account.id);
        const identity=l.curve?'curve:'+l.curve:'record:'+account.id+':'+l.id;
        for(const address of new Set(['wallet','payer','platform','protocol'].map(role=>l.keys[role]?.address).filter(Boolean)))add(uses,address,identity);
        if(l.curve)add(platformCurves,platformKey(l)?.address,l.curve);
      }
    }
    return {rows,context:l=>{
      const wallet=l.keys.wallet.address,platform=(l.keys.platform||l.keys.wallet).address,protocol=protocolWalletSelection(l).address;
      const shared=address=>(uses.get(address)?.size||0)>1,fresh=protocolWalletSelection(l).source==='protocol';
      return {ownerMatch:owners.get(l)===actorId,protocolRecipient:policy.recipientScope==='launchpad'?policy.recipient:null,shared:shared(wallet)||shared(platform),personal:personal.has(wallet)||personal.has(platform),platformShared:(platformCurves.get(platform)?.size||0)>1,platformKeyShared:shared(platform),platformPersonal:personal.has(platform),protocolShared:shared(protocol)||!fresh&&shared(platform),protocolPersonal:personal.has(protocol)||!fresh&&personal.has(platform),proposedProtocolShared:shared(l.keys.protocol?.address),proposedProtocolPersonal:personal.has(l.keys.protocol?.address)};
    }};
  }
  row(account,l,context={}){const wallet=serviceWallet(l,context),operations=(l.operations||[]).filter(o=>o.kind.startsWith('protocol-')),eligibility=protocolFeeEligibility(l,context);return {accountId:account.id,id:l.id,name:l.input.name,symbol:l.input.symbol,mint:l.keys.mint.address,quoteMint:l.input.quoteMint,quoteSymbol:quoteLabel(l.input.quoteMint,l.review.quoteSymbol,l.input.quoteSymbol),feeWallet:wallet.address,creatorFeeWallet:l.keys.wallet.address,serviceWalletManaged:wallet.managed,serviceWalletForUpgrade:wallet.upgrade,separateProtocolWalletForUpgrade:wallet.separateProtocol,protocolFeeWalletAddress:wallet.protocolAddress,gas:{...protocolGas(l,this.now()),...(wallet.upgrade||['platform','protocol'].includes(l.protocolFeeWallet?.source)?{initialReserveSol:'0'}:{})},platformFeeBps:l.review.platformFeeBps||0,policyCurrent:currentProtocolPolicy(l),policyTarget:protocolPolicyTarget(l),creatorFeeRatePpm:displayedCreatorFee(l),recipient:context.protocolRecipient||l.review.protocolFees?.recipient||'',eligibility,waitingForOperation:eligibility.waitingForOperation||null,protocolRetry:protocolRetryView(l.protocolRetry),activation:protocolFeeEligibility(l,{...context,activate:true}),requested:!!l.protocolFeesRequested,error:l.protocolError||'',pending:operations.some(o=>o.state==='pending'),collecting:displayUnits(l.protocolCredit||'0',l.review.quoteDecimals),claimed:displayUnits(l.protocolClaimed||'0',l.review.quoteDecimals),paid:displayUnits(l.protocolPaid||'0',l.review.quoteDecimals),collectingBase:displayUnits(l.protocolBaseCredit||'0',6),claimedBase:displayUnits(l.protocolBaseClaimed||'0',6),paidBase:displayUnits(l.protocolBasePaid||'0',6),lpPolicy:protocolLiquiditySnapshot(l.review.protocolFees),taxRevenue:taxRevenueView(l),operations:operations.slice(-20).map(({kind,state,signature,createdAt,confirmedAt,error})=>({kind,state,signature,createdAt,confirmedAt,error}))};}
  async coins(actorId){await this.requireAdmin(actorId);const {rows,context}=await this.inventory(undefined,actorId),meteoraRows=this.meteora?await this.meteora.protocolInventoryRows(actorId):[];await this.requireAdmin(actorId);return {coins:[...rows.filter(({l})=>isCurrentLaunch(l.input)&&l.curve).map(({account,l})=>this.row(account,l,context(l))),...meteoraRows]};}
  async activate(actorId,body){return this.request(actorId,body,true);}
  async claim(actorId,body){
    if(body?.route!=='meteora')return this.request(actorId,body,false,{collectFresh:true});
    await this.requireAdmin(actorId);validId(body.accountId);validMeteoraId(body.id);mintAddress(body.mint);validRequestId(body.requestId);
    if(typeof body.reason!=='string'||body.reason.trim().length<5||body.reason.trim().length>500)fail('Enter a claim reason between 5 and 500 characters.');
    if(!this.meteora)fail('Meteora protocol collection is unavailable.',503);
    const result=await this.meteora.collectProtocolFees(actorId,{accountId:body.accountId,id:body.id,mint:body.mint,requestId:body.requestId});
    await this.requireAdmin(actorId);if(result.skipped)fail(result.reason||'Meteora protocol collection is unavailable for this launch.',409);return result;
  }
  async claimAll(actorId,{requestId}={}){
    await this.requireAdmin(actorId);validRequestId(requestId);
    // Freeze the scope before queueing any coin. The manifest and each coin's
    // existing claim audit survive a lost HTTP response or process restart.
    // A retry cannot silently include launches created after the original click.
    const name=`protocol-claim-all-${claimAllDigest(requestId)}`;
    const release=await acquireProcessLock(join(this.accounts.dir,`${name}.lock`));
    try{
      await this.requireAdmin(actorId);
      let batch=await this.accounts.hostStore.read(name,null);
      if(batch){
        if(batch.actorId!==actorId||batch.requestId!==requestId)fail('This collection request ID was already used by another administrator.',409);
        if(batch.version!==1||!Array.isArray(batch.coins))fail('The saved collection request could not be read. Restore its original encrypted record before retrying.',503);
      }else{
        const {rows}=await this.inventory(undefined,actorId),candidates=[],seen=new Set();
        for(const {account,l} of rows){
          if(!isCurrentLaunch(l.input)||!l.curve)continue;
          const identity=`${validId(account.id)}:${validId(l.id)}`;if(seen.has(identity))continue;seen.add(identity);
          candidates.push({accountId:account.id,id:l.id,name:l.input.name,symbol:l.input.symbol,curve:l.curve,mintKey:mintAddress(l.keys.mint.address)});
        }
        if(this.meteora)for(const row of await this.meteora.protocolInventoryRows(actorId)){
          const accountId=validId(row.accountId),id=validMeteoraId(row.id),mint=mintAddress(row.mint),identity=`meteora:${accountId}:${id}`;
          if(seen.has(identity))continue;seen.add(identity);
          candidates.push({route:'meteora',accountId,id,mint,name:row.name,symbol:row.symbol,curve:'meteora:'+mint,mintKey:mint});
        }
        candidates.sort((a,b)=>a.accountId.localeCompare(b.accountId)||a.id.localeCompare(b.id));
        // Duplicate records may share the same actual onchain pool. Always use
        // the same canonical record; selecting an eligible alias when it is busy
        // would let overlapping batches queue that pool twice.
        const curves=new Set(),mints=new Set(),coins=candidates.map(({curve,mintKey,...coin})=>{
          if(curves.has(curve)||mints.has(mintKey))return {...coin,skipReason:'This onchain pool is already represented by another saved launch in this collection.'};
          curves.add(curve);mints.add(mintKey);return coin;
        });
        batch={version:1,requestId,actorId,createdAt:this.now(),coins};
        await this.requireAdmin(actorId);await this.accounts.hostStore.write(name,batch);
      }
      const result={requestId,queued:[],alreadyRequested:[],skipped:[],failed:[]};
      for(const target of batch.coins){
        await this.requireAdmin(actorId);
        const {skipReason,...coin}=target;
        if(skipReason){result.skipped.push({...coin,reason:skipReason});continue;}
        try{
          let reply;
          if(coin.route==='meteora'){
            if(!this.meteora)fail('Meteora protocol collection is unavailable.',503);
            reply=await this.meteora.collectProtocolFees(actorId,{accountId:validId(coin.accountId),id:validMeteoraId(coin.id),mint:mintAddress(coin.mint),requestId:claimAllDigest(requestId,'meteora',coin.accountId,coin.id,coin.mint)});
          }else{
            if(coin.route!==undefined&&coin.route!=='raydium')fail('The saved collection route is invalid.',503);
            reply=await this.request(actorId,{accountId:coin.accountId,id:coin.id,requestId:claimAllDigest(requestId,coin.accountId,coin.id),reason:'Collect all protocol fees'},false,{skipIneligible:true,collectFresh:true,batchRequestId:requestId});
          }
          if(reply.skipped)result.skipped.push({...coin,reason:reply.reason});
          else result[reply.alreadyRequested?'alreadyRequested':'queued'].push(coin);
        }catch(error){
          if(error.statusCode===401||error.statusCode===403)throw error;
          // A write may have reached disk before its caller failed. Keep this
          // distinct from a known ineligible coin, and require the same batch
          // ID on retry so its durable audit resolves that uncertain outcome.
          result.failed.push({...coin,uncertain:true,reason:'Could not confirm that this collection was queued. Retry this request to check its saved status.'});
        }
      }
      await this.requireAdmin(actorId);return result;
    }finally{await release();}
  }
  async request(actorId,{accountId,id,launchId,requestId,reason,policyVersion}={},activate=false,{skipIneligible=false,collectFresh=false,batchRequestId}={}){
    await this.requireAdmin(actorId);validId(accountId);const lid=validId(id||launchId);
    validRequestId(requestId);
    if(typeof reason!=='string'||reason.trim().length<5||reason.trim().length>500)fail('Enter a claim reason between 5 and 500 characters.');
    const result=await this.launchpad.locked(accountId,async b=>{const actor=await this.requireAdmin(actorId),account=await this.accounts.get(accountId),l=this.launchpad.find(b,lid);
      const {context}=await this.inventory({accountId,book:b},actorId),scope=context(l),prior=(l.protocolClaimRequests||[]).find(r=>r.requestId===requestId);
      if(prior){if(prior.actorId!==actorId||prior.activate!==activate)fail('This request ID was already used for a different operation.',409);await this.requireAdmin(actorId);return {coin:this.row(account,l,scope),alreadyRequested:true};}
      const eligibility=protocolFeeEligibility(l,{...scope,activate});if(!eligibility.allowed){
        if(skipIneligible){await this.requireAdmin(actorId);return {skipped:true,reason:eligibility.reason};}
        fail(eligibility.reason,409);
      }
      if(activate){
        if(policyVersion!==PROTOCOL_POLICY_VERSION)fail('Refresh the Admin panel and review the 75% locked LP and reward-mode creator fee upgrade before submitting.',409);
        const policy=await launchProtocolPolicy(this.accounts);if([l.keys.wallet.address,l.keys.platform?.address].includes(policy.recipient))fail('Use an external treasury wallet as the protocol recipient.');
        let selection=l.protocolFeeWallet?{...l.protocolFeeWallet}:null;
        if(legacyProtocolUpgrade(l)){
          if(exclusiveLegacyPlatform(l,scope))selection={source:'platform',address:l.keys.platform.address};
          else{
            // Generate once inside the encrypted book lock. Retries retain this
            // recipient and cannot replace a wallet which may already be funded.
            if(!l.keys.protocol)l.keys.protocol={...newLaunchKeys().wallet,createdAt:this.now(),purpose:'protocol-fees'};
            const key=l.keys.protocol;let signingKey;
            try{signingKey=signer(key.secret);if(signingKey.publicKey.toBase58()!==key.address||key.external||key.exportedAt||l.protocolWalletExportedAt||key.compromised||key.compromisedAt||['wallet','payer','platform'].some(role=>l.keys[role]?.address===key.address))throw Error();}
            catch{fail('The dedicated protocol fee signer is unavailable. Restore its original encrypted launch data before retrying.',409);}
            finally{signingKey?.secretKey.fill(0);}
            if(policy.recipient===key.address)fail('Use an external treasury wallet as the protocol recipient.');
            selection={source:'protocol',address:key.address};
          }
        }
        l.protocolActivation={...protocolFeeSnapshot(policy),...protocolPolicyTarget(l),creationFeeSol:l.review.protocolFees?.creationFeeSol||'0',...(selection?{protocolFeeWallet:selection}:{})};
      }
      await this.requireAdmin(actorId);
      // An explicit collection visits the curve and locked LP vaults before paying
      // saved credit, so one click also collects any newly accrued protocol fees.
      l.protocolFeesRequested=true;l.protocolAutomaticCycle=false;l.protocolError='';delete l.protocolRetry;l.protocolClaimStage=activate?'activate':!collectFresh&&(BigInt(l.protocolCredit||'0')>0n||BigInt(l.protocolBaseCredit||'0')>0n)?'payout':'claim';
      l.protocolClaimRequests=[...(l.protocolClaimRequests||[]),{requestId,at:this.now(),actorId,actor:actor.username,activate,reason:reason.trim(),...(batchRequestId?{batchRequestId}:{})}];
      await this.launchpad.save(accountId,b);return {coin:this.row(account,l,scope),alreadyRequested:false};
    });if(!result.skipped){this.launchpad.known.add(accountId);this.launchpad.kick(accountId);}return result;
  }
}
