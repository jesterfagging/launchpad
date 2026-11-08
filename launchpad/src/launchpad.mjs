import { assertRaydiumLaunchRequest } from './launch-destination.mjs';
import { launchpadEnv } from './brand-env.mjs';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { atomicWrite } from './telegram-store.mjs';
import { LaunchCustomPairs } from './launchpad-custom-pairs.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import { launchInput, requireNewLaunchTax, newLaunchCurvePolicy, weightedRewards, requireValue as ok, units, displayUnits, SOL_MINT, isCurrentLaunch, LAUNCH_CURVE_POLICY_4K } from '../public/launchpad-model.mjs';
import { startTier } from '../public/tenant-catalog.mjs';
import { LaunchQuoteCatalogue, launchQuoteAvailability } from './launchpad-quotes.mjs';
import { revalidateLaunchQuotes } from './launchpad-quote-readiness.mjs';
import { inspectLaunchImage, LaunchMetadataStorage } from './launchpad-media.mjs';
import { newLaunchKeys, signer, receiptDeltas, rewardHandoffReceipt, taxBurnReceipt } from './launchpad-receipts.mjs';
import { VANITY_LIMITS } from './vanity-pool.mjs';
const VANITY_LOST='This launch’s reserved address is no longer available because the draft waited too long. Start the launch again from a new review.';
import { creationFeeExpectation, creationFeeReceipt } from './launchpad-creation-receipt.mjs';
import { LaunchMarketFeed } from './launchpad-market-feed.mjs';
import { feeCycleDueAt, holderRewardPolicy, currentHolderRewardMinimum, HOLDER_REWARD_POLICY, HOLDER_REWARD_MINIMUM_USD, holderRewardMinimumUsd, paycheckPayoutThreshold, referenceRewardMinimum, publicHolderRewards, holderRewardCheckDueAt, taxConversionDueAt, automaticTaxBacklog } from './launchpad-holder-rewards.mjs';
import { PAYCHECK_POLICY, paycheckLaunch, paycheckLedger, paycheckLedgerTotal, planPaycheckCycle, paycheckBatchAttribution, recordPaycheckPayout } from './launchpad-paycheck.mjs';
import { TAX_CONVERSION_MAX_UNITS, TAX_CONVERSION_BACKLOG_UNITS, TAX_CONVERSION_BURST_POLICY } from './launchpad-tax-conversion.mjs';
import { TAX_PROTOCOL_POLICY, hasTransferTax, taxProtocolLedger, taxProtocolTreasury, recordTaxHarvest, taxConversionSource, taxBacklogSource, recordTaxConversion, recordMixedTaxConversion, recordTaxProtocolPayout } from './launchpad-tax-protocol.mjs';
import { officialTaxBurnSelected, officialTaxBurnEnabled, selectOfficialTaxBurn, initialTaxBurnPending, taxBurnPlan, requireTaxBurnPlan, recordTaxBurn, manualTaxBurnRequest } from './launchpad-tax-burn.mjs';
import { TAX_MAINTENANCE_POLICY, officialTaxMaintenanceEnabled, officialTaxMaintenanceAt, beginOfficialTaxMaintenance, officialTaxMaintenanceOperation, completeOfficialTaxMaintenance, retryOfficialTaxMaintenance } from './launchpad-tax-maintenance.mjs';
import { LaunchRewardsView } from './launchpad-rewards-view.mjs';
import { personalRewardReceipt } from './personal-rewards.mjs';
import { launchProtocolPolicy, protocolFeeSnapshot } from './launchpad-protocol-fees.mjs';
import { protocolRetryAt, retryProtocolCollection } from './launchpad-protocol-recovery.mjs';
import { creatorFeeForLaunch, effectiveCreatorFeeRate } from '../public/creator-fee-schedule.mjs';
import {protocolLiquidityTerms} from './launchpad-protocol-liquidity.mjs';
import {validProtocolPolicyTarget} from './launchpad-policy-upgrade.mjs';
import {protocolWalletSelection,protocolWalletView,protocolActivationSigner,managedProtocolWallet} from './launchpad-protocol-wallet.mjs';
import {ensureFeeAutomation,setFeeAutomation,autoRewardEnabled,scheduleRewardRetry,clearRewardRetry,publicRewardRetry} from './launchpad-reward-recovery.mjs';
import {rewardInventoryRecoveryDueAt,recoverRewardInventory} from './launchpad-inventory-recovery.mjs';
import {rewardsWalletSelection,publicRewardsWallet,provisionRewardsWallet,rewardsCreatorCredits,rewardHandoffPlan,recordRewardHandoff,addCreatorRewardCredits,requireManagedRewardSource} from './launchpad-rewards-wallet.mjs';
import {nativeHolderRewards,nativeRewardDebtState,deferNativeRewardPayouts,queueNativeRewardPayouts,resetNativeRewardAllocation,settleNativeRewardPayout} from './launchpad-native-reward-debts.mjs';
import {manualHolderDistribution,manualHolderAuthorizer,MANUAL_REWARD_AUTH_ERROR,manualHolderCycle,startManualHolderCycle,snapshotManualHolderBase,manualHolderConversionSource,settleManualHolderConversion,retryManualHolderDistribution,finishManualHolderDistribution} from './launchpad-manual-distribution.mjs';
import {heldSolActive,heldSolEligibility,heldSolView,heldSolFailureReason,HELD_SOL_BUSY,heldSolWaitReason} from './launchpad-held-sol.mjs';
import { platformBrand } from './launchpad-branding.mjs';
import { requireTenantLaunch, raydiumMode, allowedStarts } from './tenant/gate.mjs';
import { padCheck } from './tenant/pad.mjs';
import { PLATFORM_TOKEN_MINT } from './platform-token.mjs';
import { beginLaunchRecovery, recoveryDue, recoveryWakeAt, recoverFailedLaunch, publicRecovery } from './launchpad-recovery-service.mjs';
import { LaunchPreparationQueue, launchPreparationBusy } from './launchpad-preparation-queue.mjs';
import { launchArchiveView, setLaunchArchive, stoppedBeforeToken } from './launchpad-archive.mjs';
import { creatorFeeRedirectStatus } from './launchpad-fee-routing.mjs';
import { gotchiLaunch, gotchiPayoutMinimum, gotchiPayoutRows } from './gotchi-launches.mjs';
import { agentLaunch, validAgentAttachment } from './agent/launches.mjs';
import { quoteLabel } from '../public/quote-identity.mjs';
const cleanError=e=>String(e?.message||e).replace(/(?:https?|wss?):\/\/\S+/g,'[provider]').slice(0,500);
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const initialKinds = new Set(['storage-credit','storage-fund','platform','platform-setup','quote-fund','create','setup','launch-all']);
// Payout gas (v71.37): a holder payout on a pair asset other than SOL needs SOL for recipient token-account rent and fees, which the
// dedicated rewards wallet never receives on its own. When the payout simulation reports the missing SOL, Launchpad sells a little of the
// rewards for it (`gas-sell`): the shortfall plus headroom, with a margin for the route, at most a fifth of the rewards waiting, at
// most three sales per cycle and six in any 24 hours. Beyond those limits the ordinary "waiting for SOL" retry and alert apply.
export const PAYOUT_GAS_HEADROOM_LAMPORTS=2000000n, PAYOUT_GAS_MARGIN_BPS=2500n, PAYOUT_GAS_DEFAULT_SHORTFALL_LAMPORTS=3000000n, PAYOUT_GAS_MAX_SHARE_DIVISOR=5n, PAYOUT_GAS_ATTEMPTS=3, PAYOUT_GAS_SALES_PER_DAY=6;
const compactLaunch = l => ['compact-v2','compact-v3'].includes(l.executionPlan);
const protocolCollectionAt=l=>Math.min(l.protocolNextHarvestAt||(l.authorizedAt||l.createdAt)+3600000,l.review.protocolFees?.lpPolicy==='platform_locked'?(l.protocolNextLpHarvestAt||(l.authorizedAt||l.createdAt)+60000):Infinity);
const protocolFeesDue=(l,now)=>!!l.curve&&now>=protocolRetryAt(l)&&(l.protocolFeesRequested||['live','paused','error'].includes(l.state)&&l.review.protocolFees?.autoHarvest&&now>=protocolCollectionAt(l));
const publicReview = review => { const {storageSol,...visible}=review; const fees=units(review.minimumSol)-BigInt(review.devBuy?.solBudget||0);return {...visible,launchFeesSol:displayUnits(fees>0n?fees:0n)}; };
const externalCreator = l => !!l.keys.wallet.external && l.input.feeMode === 'creator';
const legacyHolderSale = (l, op) => l.input.feeMode === 'holders' && op?.kind === 'sell' && !['paced-v1',TAX_CONVERSION_BURST_POLICY].includes(op.taxConversionPolicy);
// Payout gas (v71.37) applies to holder rewards paid in a pair asset other than SOL from the dedicated rewards wallet.
const payoutGasSaleApplies=l=>l.input.feeMode==='holders'&&l.input.quoteMint!==SOL_MINT&&l.rewardsWallet?.status==='active'&&l.cycle?.stage==='payout';
// After a gas sale the rewards waiting are smaller: the unpaid rows of the cycle shrink in proportion so their sum stays within the
// credit; rows already paid (before `index`) are never touched, and a row that rounds to nothing leaves the cycle.
function shrinkPayoutsToCredit(l,creditQuote=BigInt(l.credits.quote)){
  const rows=l.cycle?.payouts;if(!Array.isArray(rows))return;
  const index=l.cycle.index||0,rest=rows.slice(index),total=rest.reduce((n,row)=>n+BigInt(row.amount),0n),credit=BigInt(creditQuote);
  if(total<=credit||total===0n)return;
  const shrunk=rest.map(row=>({...row,amount:(BigInt(row.amount)*credit/total).toString()})).filter(row=>BigInt(row.amount)>0n);
  l.cycle.payouts=[...rows.slice(0,index),...shrunk];l.cycle.payoutGasShrunk=(l.cycle.payoutGasShrunk||0)+1;
}
const rewardOperation=(l,op)=>!!op&&(l.input.feeMode==='holders'?['claim','tax','tax-burn','sell','gas-sell','payout','tax-protocol-payout','reward-handoff']:l.input.feeMode==='buyback'?['claim','buy','burn']:[]).includes(op.kind);
const protocolOperation=op=>!!op&&['protocol-enable','protocol-claim','protocol-lp-claim','protocol-payout','protocol-lp-payout'].includes(op.kind);
const storageAllowance = (input, budget, review) => BigInt(budget) ? (input.walletMode === 'external' ? 50000n+BigInt(review.storageWalletRent||'0') : 25000n) : 0n;
const extraSetupAllowance = (l) => l.executionPlan==='compact-v3' && (l.splitPlatformSetup || BigInt(l.storage?.budget||0)>0n || BigInt(l.review.devBuy?.gross||0)>0n) ? 25000n+(BigInt(l.storage?.budget||0)>0n?0n:BigInt(l.review.storageWalletRent||0)) : 0n;
const transientLaunchError = e => e?.retryable===true || [e?.code,e?.statusCode,e?.status,e?.response?.status,e?.cause?.status].some(value=>[-32016,408,429,502,503,504].includes(Number(value))) || [e?.code,e?.cause?.code].some(value=>['ECONNRESET','ETIMEDOUT','ECONNABORTED','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(value)) || e?.name==='TimeoutError' || /minimum context slot|HTTP (?:408|429|502|503|504)|ECONNRESET|ETIMEDOUT|ECONNABORTED|timeout of \d+ms exceeded|fetch failed|socket hang up/i.test(String(e?.message||e));
const MAX_PREPARED_REVIEWS=1200,MAX_PREPARED_REVIEW_BYTES=384*1024,MAX_OWNER_REVIEWS=8;
// Per-account bounds: saved Raydium launches that count (and a hard total), new images per 30 days and in total.
const SAVED_LAUNCH_LIMIT=100,SAVED_LAUNCH_TOTAL=250,IMAGE_WINDOW_MS=30*86400000,IMAGE_WINDOW_LIMIT=100,IMAGE_TOTAL_LIMIT=2000;
const pendingSignature = l => { const op = l.operations.find(x=>x.state==='awaiting_signature'&&!legacyHolderSale(l,x)); return op ? {operationId:op.operationId,kind:op.kind,transaction:op.unsignedRaw,wallet:op.externalSigner} : null; };
function walletOperationSigners(l,op,required){
  // Only the same mint/platform keys that signed this launch step may approve
  // an assertion-augmented message. Reward/trade requests receive no such keys.
  ok(l.operations.includes(op)&&op.state==='awaiting_signature'&&l.state==='awaiting_signature'&&l.authorizedAt&&!l.curve&&!l.recovery&&l.phase===op.kind,'This saved launch step cannot be co-signed.');
  const payer=l.keys.payer||l.keys.wallet;
  ok(payer.external===true&&payer.address===op.externalSigner&&!payer.secret,'The saved launch payer does not match its wallet request.');
  const selected=[];
  if(['create','launch-all'].includes(op.kind))selected.push(l.keys.mint);
  if((['platform','launch-all'].includes(op.kind)||op.kind==='setup'&&l.executionPlan!=='compact-v3')&&l.keys.platform&&l.keys.platform.address!==payer.address)selected.push(l.keys.platform);
  const addresses=selected.map(key=>key?.address);
  ok(Array.isArray(required)&&required.length>0&&new Set(required).size===required.length&&addresses.length===required.length&&new Set(addresses).size===addresses.length&&addresses.every(address=>required.includes(address)),'This saved launch step has an invalid Launchpad signer set.');
  const signers=[];
  try{
    for(const key of selected){
      ok(key?.secret&&!key.external,'The saved Launchpad signer is unavailable.');
      const secretKey=bs58.decode(key.secret);
      try{const publicKey=Keypair.fromSecretKey(secretKey).publicKey;ok(publicKey.toBase58()===key.address,'The saved Launchpad signer does not match its address.');signers.push({publicKey,secretKey});}
      catch(error){secretKey.fill(0);throw error;}
    }
    return signers;
  }catch(error){for(const value of signers)value.secretKey.fill(0);throw error;}
}
const hasSavedLaunchTransaction=l=>l.operations.some(o=>o.signature||['pending','confirmed','awaiting_signature'].includes(o.state));
const requireAvailableNewLaunchMode=input=>{if(input.feeMode==='buyback')throw Object.assign(Error('Agent buyback launches are no longer available. Choose Creator Fees or Holder Rewards for a new launch.'),{code:'LAUNCH_MODE_RETIRED',statusCode:409});
  // Paycheck's split buys and burns the platform token, so a host without one (LAUNCHPAD_TOKEN_MINT) does not offer it.
  if(raydiumMode(input)==='paycheck'&&!PLATFORM_TOKEN_MINT)throw Object.assign(Error('Paycheck launches are not offered here. Choose another launch option.'),{code:'LAUNCH_MODE_UNAVAILABLE',statusCode:409});
  // A white-label launchpad (LAUNCHPAD_PRODUCT=tenant) offers only the venues, launch modes and starts its owner picked (src/tenant/gate.mjs).
  requireTenantLaunch({venue:'raydium',mode:raydiumMode(input),...(input.curvePolicy===LAUNCH_CURVE_POLICY_4K?{start:'4k'}:{})});
  // A launchpad with the ticker lock refuses a ticker or name launched here in the last 3 days or still active (src/tenant/pad.mjs).
  padCheck({name:input.name,symbol:input.symbol});};
const canReprepare = l => !l.recovery && !l.curve && ['draft','error'].includes(l.state) && !hasSavedLaunchTransaction(l);
const safeId=x=>{ok(/^[a-f0-9]{32}$/.test(x||''),'Invalid launch ID.');return x;};
const confirmedCreationAwaitingVerification = l => !l.curve&&!l.recovery&&l.state==='launching'&&l.phase==='verify'&&l.operations.some(op=>['create','launch-all'].includes(op.kind)&&op.state==='confirmed');
// LaunchLab shares pre-graduation fees by creator wallet and quote mint.
// The UI must not imply that this vault is a balance for just one coin.
const feeScope = l => [l.input.network,l.keys.wallet.address,l.input.quoteMint].join(':');
const activeFeeOperation = l => l.operations.find(op=>!initialKinds.has(op.kind)&&['pending','awaiting_signature'].includes(op.state));
const adminBuyback = l => !!l.buybackAdminRequest && (l.adminRewardHistory||[]).some(event=>event.action==='buyback'&&event.requestId===l.buybackAdminRequest&&event.actorId&&event.launchId===l.id);
const adminHolderDistribution = l => !!l.holderDistributionAdminRequest && (l.adminRewardHistory||[]).some(event=>event.action==='distribute'&&event.requestId===l.holderDistributionAdminRequest&&event.actorId&&event.launchId===l.id);
function settleFailedFeeReserve(l,op,tx){
  // A failed transaction spends its network fee, not its preparation/rent
  // allowance. Keep that full allowance unless the finalized receipt proves
  // the exact fee debit from the saved payer. This never changes reward credit.
  try{
    if(initialKinds.has(op.kind)||Object.hasOwn(op,'failedNetworkCostLamports')||!/^\d+$/.test(op.reserve||'')||BigInt(op.reserve)===0n||!Number.isSafeInteger(op.createdAt)||op.createdAt<0)return false;
    const meta=tx?.meta,message=tx?.transaction?.message;
    if(!meta?.err||tx.confirmationStatus!==undefined&&tx.confirmationStatus!=='finalized'||!Number.isSafeInteger(tx.slot)||tx.slot<=0||tx.transaction.signatures?.[0]!==op.signature||!Number.isSafeInteger(meta.fee)||meta.fee<0)return;
    const view=protocolOperation(op)?protocolWalletView(l,op.protocolFeeWallet||{source:'wallet',address:l.keys.wallet.address}):l;
    const selection=rewardsWalletSelection(view,{operation:op,receipt:true}),payer=view.keys[selection.signerSource]?.address;
    const keys=[...(message?.staticAccountKeys||message?.accountKeys||[]),...(meta.loadedAddresses?.writable||[]),...(meta.loadedAddresses?.readonly||[])].map(key=>String(key.pubkey||key));
    if(!payer||keys[0]!==payer||new Set(keys).size!==keys.length||!Array.isArray(meta.preBalances)||!Array.isArray(meta.postBalances)||meta.preBalances.length!==keys.length||meta.postBalances.length!==keys.length)return;
    for(let index=0;index<keys.length;index++){
      const before=meta.preBalances[index],after=meta.postBalances[index];
      if(!Number.isSafeInteger(before)||before<0||!Number.isSafeInteger(after)||after<0||BigInt(before)-BigInt(after)!==(index===0?BigInt(meta.fee):0n))return;
    }
    if(l.gas.day!==new Date(op.createdAt).toISOString().slice(0,10)||!/^\d+$/.test(l.gas.reserved)||BigInt(l.gas.reserved)<BigInt(op.reserve))return;
    l.gas.reserved=(BigInt(l.gas.reserved)-BigInt(op.reserve)+BigInt(meta.fee)).toString();
    op.failedNetworkCostLamports=String(meta.fee);
    return true;
  }catch{/* An unverifiable fee retains its conservative saved reservation. */}
  return false;
}
const failedFeeRepairCandidates=(l,now)=>autoRewardEnabled(l)&&['live','paused'].includes(l.state)&&!l.operations.some(op=>['pending','awaiting_signature'].includes(op.state))&&l.rewardRetry?.kind==='gas-budget'&&l.error==='Automatic rewards will continue after the daily gas budget resets.'&&l.gas?.day===new Date(now).toISOString().slice(0,10)?l.operations.filter(op=>op.state==='failed'&&!initialKinds.has(op.kind)&&!Object.hasOwn(op,'failedNetworkCostLamports')&&/^\d+$/.test(op.reserve||'')&&BigInt(op.reserve)>0n&&Number.isSafeInteger(op.createdAt)&&op.createdAt>=0&&op.createdAt<=8640000000000000&&new Date(op.createdAt).toISOString().slice(0,10)===l.gas.day):[];
function rewardGasFundingNeed(l,funding,now){
  const need=funding?.gasFundingNeed,read=value=>{ok(typeof value==='string'&&/^\d{1,20}$/.test(value)&&BigInt(value)<=18446744073709551615n,'Invalid reward gas funding requirement.');return BigInt(value);};
  ok(need?.version===1&&need.creatorAddress===l.keys.wallet.address&&need.rewardsAddress===l.keys.rewards.address&&Number.isSafeInteger(now)&&now>=0,'The reward gas funding identities are invalid.');
  const creator=read(need.creatorMinimumLamports),rewards=read(need.rewardsMinimumLamports),principal=read(need.creatorPrincipalReserveLamports),credit=rewardsCreatorCredits(l);
  const expectedPrincipal=l.input.route==='pump'&&l.input.quoteMint===SOL_MINT?BigInt(credit.quote)+BigInt(credit.protocolQuote)+BigInt(l.protocolCredit||'0'):0n;
  ok(principal===expectedPrincipal&&(creator===0n||creator>=principal&&creator<=principal+50000000n)&&(rewards===0n||rewards===10000000n),'The reward gas funding requirement exceeds its verified operational reserve.');
  return {version:1,creatorAddress:need.creatorAddress,rewardsAddress:need.rewardsAddress,creatorMinimumLamports:creator.toString(),rewardsMinimumLamports:rewards.toString(),creatorPrincipalReserveLamports:principal.toString(),observedAt:now};
}
export function creatorFeeStatus(l){
  const reason=!isCurrentLaunch(l.input)?'This earlier launch is archived.':l.input.feeMode!=='creator'?'These fees fund the selected holder rewards or buyback service.':!l.curve||!l.authorizedAt?'Creator fees are available after the launch is confirmed.':l.operations.some(op=>initialKinds.has(op.kind)&&['pending','awaiting_signature'].includes(op.state))?'The launch transaction is still being confirmed.':'';
  const op=activeFeeOperation(l),busy=!!op||!!l.feesRequested;
  const status=reason?'unavailable':op?.state==='awaiting_signature'?'awaiting_signature':op?.state==='pending'?'pending':l.feesRequested?(l.cycle?'processing':'queued'):['paused','error'].includes(l.state)?'paused':'ready';
  return {available:!reason,busy:!reason&&busy,status,reason,wallet:l.keys.wallet.address,recipient:l.input.recipient||l.keys.wallet.address,requiresSignature:!!l.keys.wallet.external,scope:l.feeCustody==='relay'?'coin':'wallet_quote'};
}
export function requestFees(l){
  ok(isCurrentLaunch(l.input),'This earlier launch is archived. Use its original build to manage it.');
  ok(l.curve&&l.authorizedAt,'The launch must be verified live before processing fees.');
  ok(!l.operations.some(op=>initialKinds.has(op.kind)&&['pending','awaiting_signature'].includes(op.state)),'The launch transaction is still being confirmed.');
  // Retrying an interrupted fee cycle resumes its saved step. In-flight bytes
  // and wallet requests remain untouched, so repeated clicks cannot claim twice.
  const op=activeFeeOperation(l);delete l.retry;clearRewardRetry(l);if(op)delete op.receiptCheckAfter;
  l.state=op?.state==='awaiting_signature'?'awaiting_signature':'live';
  l.feesRequested=true;l.manualFeesRequested=true;if(l.cycle)l.cycle.manual=true;if(!op)l.error='';
}
export function publicLaunch(l){return{...launchArchiveView(l),id:l.id,canReprepare:canReprepare(l),canReuseDraft:!!l.recovery&&!l.curve&&l.state==='failed'&&l.recovery.status==='complete',recovery:publicRecovery(l),executionPlan:l.executionPlan,walletMode:l.input.walletMode||'default',pendingSignature:l.recovery&&!l.curve?null:pendingSignature(l),archived:!isCurrentLaunch(l.input),input:l.input,review:publicReview(l.review),creatorFees:l.creatorFees?{policy:l.creatorFees.policy,ratePpm:l.creatorFees.ratePpm,status:l.creatorFees.status,checkedAt:l.creatorFees.checkedAt,nextAt:l.creatorFees.nextAt,confirmedAt:l.creatorFees.confirmedAt}:null,reviewHash:l.reviewHash,reviewExpires:l.reviewExpires,wallet:l.keys.wallet.address,developerWallet:(l.keys.payer||l.keys.wallet).address,managedFees:l.input.feeMode!=='creator',gotchi:gotchiLaunch(l)?{id:l.input.gotchi.id,theme:l.input.gotchi.theme,vault:l.input.gotchi.vault,href:'/gotchi?id='+l.input.gotchi.id}:null,agent:agentLaunch(l)?{id:l.input.agent.id,wallet:l.input.agent.wallet,model:l.input.agent.model,capabilities:l.input.agent.capabilities,policyHash:l.input.agent.policyHash,href:'/coin?mint='+l.keys.mint.address+'#agent'}:null,feeCustody:l.feeCustody||'creator',feeClaim:creatorFeeStatus(l),feeRedirect:creatorFeeRedirectStatus(l),lastFeeClaim:l.lastFeeClaim||null,holderRewards:publicHolderRewards(l),rewardsWallet:publicRewardsWallet(l),mint:l.keys.mint.address,uri:l.uri,state:l.state,phase:l.phase,error:l.error||'',retry:l.retry?{attempt:l.retry.attempt,at:l.retry.at}:null,rewardRetry:publicRewardRetry(l),createdAt:l.createdAt,curve:l.curve||null,autoFees:l.autoFees,feesRequested:!!l.feesRequested,lastCycle:l.lastCycle||0,credits:l.credits,cycle:l.cycle?{stage:l.cycle.stage,snapshotSlot:l.cycle.slot,recipients:l.cycle.payouts?.length||0,paid:l.cycle.index||0}:null,gas:l.gas,operations:l.operations.slice(-50).map(({signature,kind,state,createdAt,error})=>({signature,kind,state,createdAt,error})),feeService:externalCreator(l)?'Creator fees belong to your connected wallet. Approve fee claims in that wallet.':l.input.feeMode==='creator'?(l.feeCustody==='relay'?'Launchpad claims this coin’s creator fees and sends them to the receiving wallet. Launchpad controls the dedicated fee wallet.':'Creator fees are claimed into your default Launchpad wallet.'):'Launchpad-managed service. The Launchpad operator controls the fee wallet; distributions and buybacks are onchain, not an immutable routing contract.'};}
export class Launchpad {
  constructor(accounts,runtimes,{publicUrl='',chainFactory,metadataStorage,quoteCatalogue,preparationQueue,now=Date.now,walletOnly=false}={}){this.accounts=accounts;this.runtimes=runtimes;this.publicUrl=publicUrl;this.chainFactory=chainFactory;this.walletOnly=walletOnly;this.metadataStorage=metadataStorage||new LaunchMetadataStorage();this.quoteCatalogue=quoteCatalogue||new LaunchQuoteCatalogue();this.quoteChecks=new Map();this.buyEstimates=new Map();this.pendingEstimates=new Map();this.preparedLaunches=new Map();this.pendingPreparations=new Map();this.preparationQueue=preparationQueue||new LaunchPreparationQueue();this.now=now;this.queues=new Map();this.jobs=new Map();this.known=new Set();this.wakeAt=new Map();this.requested=new Set();this.closed=false;}
  requireConnectedPayer(launch){ok(!this.walletOnly||(launch.keys.payer||launch.keys.wallet)?.external===true,'This older launch uses a stored account wallet. Pending transactions can still be checked. Connect your wallet to create a new launch.');}
  async book(id){return await this.accounts.storeFor(id).read('launchpad',{version:1,launches:[]});}
  async save(id,book){
    const store=this.accounts.storeFor(id);await store.write('launchpad',book);
    // The underlying encrypted writer fsyncs the file before renaming it.
    // Held-SOL authorization, signed bytes and receipt settlement also need
    // the rename durable before any broadcast or subsequent batch.
    if(book.launches.some(l=>l.heldSolDistribution||l.taxBurn||l.operations?.some(op=>op.kind==='tax-burn'&&op.state==='pending'))){
      ok(typeof store.dir==='string'&&store.dir.length>0,'The holder payout journal directory is unavailable.');
      const directory=await open(store.dir,'r');try{await directory.sync();}finally{await directory.close();}
    }
  }
  async locked(id,fn){const job=(this.queues.get(id)||Promise.resolve()).catch(()=>{}).then(async()=>{const store=this.accounts.storeFor(id);await mkdir(store.dir,{recursive:true});const release=await acquireProcessLock(join(store.dir,'launchpad.lock'));try{return await fn(await this.book(id));}finally{await release();}});this.queues.set(id,job);try{return await job;}finally{if(this.queues.get(id)===job)this.queues.delete(id);}}
  async chain(id,network){if(this.chainFactory)return this.chainFactory(id,network);const {LaunchChain}=await import('./launchpad-chain.mjs');const {settings}=await this.runtimes.readSettings(id);if((await this.accounts.get?.(id))?.authType==='wallet')settings.rpcUrl=launchpadEnv('PUBLIC_RPC_URL')||'';const rpcUrl=network==='mainnet-beta'?(settings.rpcUrl||(settings.heliusKey?`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(settings.heliusKey)}`:undefined)):undefined;const c=new LaunchChain({network,rpcUrl,rpcGate:this.runtimes.rpcGate,rpcScope:id,rpcRequestsPerSecond:settings.rpcRequestsPerSecond,jupiterKey:settings.jupiterKey||''});try{return await c.init();}catch(e){c.close?.();throw e;}}
  async read(id){this.known.add(id);const b=await this.book(id);if(b.launches.some(l=>recoveryDue(l,this.now())))this.kick(id);const account=await this.accounts.get(id);return{developerWallet:account.mainWallet,launches:b.launches.map(publicLaunch).reverse()};}
  async archive(id,launchId,{archived}={}){
    safeId(id);safeId(launchId);
    if(typeof archived!=='boolean')throw Object.assign(new Error('Choose whether to archive or restore this request.'),{statusCode:400});
    const requireOwner=async()=>{const account=await this.accounts.get(id);if(!account)throw Object.assign(new Error('The launch account was not found.'),{statusCode:404});if(account.banned)throw Object.assign(new Error('This account is banned from Launchpad.'),{statusCode:403});};
    await requireOwner();
    return this.locked(id,async book=>{
      const launch=this.find(book,launchId);
      await requireOwner();
      if(setLaunchArchive(launch,{archived,actorId:id,at:this.now()}))await this.save(id,book);
      return publicLaunch(launch);
    });
  }
  async marketLaunch(id,launchId){
    const l=this.find(await this.book(id),launchId);
    ok(isCurrentLaunch(l.input)&&l.curve,'This launch does not have a verified mainnet curve yet.');
    return l;
  }
  async market(id,launchId){
    // Resolve ownership on every request, even when market data is cached.
    const l=await this.marketLaunch(id,launchId);
    this.marketFeed ||= new LaunchMarketFeed({storeFor:account=>this.accounts.storeFor(account),chainFor:(account,network)=>this.chain(account,network),now:this.now});
    return this.marketFeed.read(id,l);
  }
  async marketTradeContext(id,launchId){
    const l=await this.marketLaunch(id,launchId);
    return {launch:{id:l.id,mint:l.keys.mint.address,curve:l.curve,input:{route:l.input.route,network:l.input.network,quoteMint:l.input.quoteMint,name:l.input.name,symbol:l.input.symbol}},snapshot:this.marketFeed?.peek(id,l.id)||null};
  }
  async rewards(id,launchId){
    // Recheck ownership and policy before touching the account-scoped cache.
    const l=this.find(await this.book(id),launchId);
    ok(isCurrentLaunch(l.input)&&l.input.feeMode==='holders'&&l.authorizedAt&&(l.curve||l.operations.some(op=>['create','launch-all'].includes(op.kind)&&op.state==='confirmed')),'Holder rewards are available after the holder-reward launch is confirmed.');
    this.rewardsView ||= new LaunchRewardsView({chainFor:(account,network)=>this.chain(account,network),now:this.now});
    return this.rewardsView.read(id,l);
  }
  async quotes(id) {
    const catalogue = await this.quoteCatalogue.read(); let supported;
    const cached = this.quoteChecks.get(id);
    if (cached && this.now()-cached.at < 60000) supported = cached.mints;
    else {
      this.pendingQuoteChecks ||= new Map();
      let pending=this.pendingQuoteChecks.get(id);
      if(!pending){pending=(async()=>{let c;try{c=await this.chain(id,'mainnet-beta');const mints=await c.approvedQuotes();if(!Array.isArray(mints))throw Error('Invalid quote availability.');this.quoteChecks.set(id,{at:this.now(),mints});return mints;}catch{return null;}finally{c?.close?.();}})().finally(()=>this.pendingQuoteChecks.delete(id));this.pendingQuoteChecks.set(id,pending);}
      supported=await pending;
    }
    this.customPairs ||= new LaunchCustomPairs({accounts:this.accounts,launchpad:this,now:this.now});
    const [assets,custom]=await Promise.all([
      revalidateLaunchQuotes(id,catalogue.assets.map(a=>launchQuoteAvailability(a,supported)),this.customPairs),
      this.customPairs.publicAssets(id,catalogue,supported),
    ]);
    return {...catalogue,assets:[...assets,...custom]};
  }
  async requireNewLaunchProtocol(l){
    if(!l.curve&&!hasSavedLaunchTransaction(l))requireAvailableNewLaunchMode(l.input);
    const needsReview=message=>{throw Object.assign(Error(message),{code:'LAUNCH_POLICY_REVIEW_REQUIRED',statusCode:409});};
    if(!l.curve&&!hasSavedLaunchTransaction(l)){
      const curvePolicy=newLaunchCurvePolicy(l.input);
      if(![l.input,l.review].every(snapshot=>Object.entries(curvePolicy).every(([key,value])=>snapshot?.[key]===value)))needsReview('The launch curve policy changed. Refresh and review the updated launch before approving.');
    }
    let policy;
    try{policy=protocolFeeSnapshot(await launchProtocolPolicy(this.accounts));}
    catch(error){if([400,503].includes(error?.statusCode))error.code='LAUNCH_POLICY_REVIEW_REQUIRED';throw error;}
    if(!(l.review.platformFeeBps===100&&[l.input.protocolFees,l.review.protocolFees].every(snapshot=>snapshot&&Object.entries(policy).every(([key,value])=>snapshot[key]===value))))needsReview('The launch protocol policy changed. Refresh and review the launch before approving.');
    if(!managedProtocolWallet(l))needsReview('This older draft needs a dedicated protocol fee wallet. Reuse its details to prepare a new launch.');
  }
  async newLaunchInput(id,raw,{adminLaunch=false}={}){
    assertRaydiumLaunchRequest(raw);
    // This option is supplied only by authenticated administrator routes, never
    // by raw request fields. Recheck the account before preparing any keys.
    if(adminLaunch){const account=await this.accounts.get(id);ok(account?.role==='admin'&&account.mfaEnabled,'Administrator access with two-factor authentication is required for an adjustable starting market cap.');}
    const input=launchInput({...raw,creatorFeePercent:'0.50'},{marketCapPolicy:adminLaunch?'admin':'public',publicStarts:allowedStarts('raydium').map(id=>startTier(id).usd)});
    requireAvailableNewLaunchMode(input);
    if(input.gotchiId){
      // The pairing is resolved server-side and copied verbatim into the
      // immutable launch input. It contains no timestamp so repeated reviews
      // of the same request hash identically.
      ok(typeof this.gotchiTarget==='function','Gotchi launches are not available on this host.');
      const target=await this.gotchiTarget(input.gotchiId);
      ok(target&&target.id===input.gotchiId&&typeof target.vault==='string'&&PublicKey.isOnCurve(new PublicKey(target.vault).toBytes()),'This Gotchi is not accepting launches right now.');
      input.gotchi={version:1,id:target.id,theme:String(target.theme||target.id),vault:target.vault};
    }
    if(input.agentRequest){
      // The agent, its managed wallet and the frozen policy hash are resolved
      // server-side from the normalized settings and copied verbatim into the
      // immutable input, so repeated reviews of one request hash identically.
      ok(typeof this.agentTarget==='function','AI Agent launches are not available on this host.');
      const target=await this.agentTarget(input.agentRequest,{accountId:id,venue:'raydium'});
      ok(validAgentAttachment(target)&&PublicKey.isOnCurve(new PublicKey(target.wallet).toBytes()),'AI Agent launches are not accepting new coins right now.');
      input.agent={version:1,mode:target.mode,id:target.id,wallet:target.wallet,policyHash:target.policyHash,policyVersion:target.policyVersion,capabilities:target.capabilities,model:target.model};
    }
    const creatorFee=creatorFeeForLaunch(input);input.creatorFeeBps=creatorFee.ratePpm/100;input.creatorFeePolicy=creatorFee.policy;
    input.platformBrandVersion=platformBrand().version;
    const policy=await launchProtocolPolicy(this.accounts);
    input.protocolFees=protocolFeeSnapshot(policy);
    return input;
  }
  async estimate(id,raw,options={}) {
    assertRaydiumLaunchRequest(raw);
    // Quotes need neither a wallet nor an uploaded image. They never create a
    // launch, sign a transaction, or reserve funds.
    const input=await this.newLaunchInput(id,{name:'Estimate',symbol:'EST',feeMode:raw.feeMode==='agent'?'creator':(raw.feeMode||'creator'),...(raw.gotchiId!==undefined?{gotchiId:raw.gotchiId}:{}),quoteMint:raw.quoteMint,targetUsd:raw.targetUsd,creatorFeePercent:raw.creatorFeePercent,taxPercent:raw.taxPercent,devBuySol:raw.devBuySol??'0'},options);
    new PublicKey(input.quoteMint);
    if(!BigInt(input.devBuyLamports))return {gross:'0',net:'0',maxQuote:'0',solBudget:'0',asOf:this.now()};
    const key=id+':'+digest(input),cached=this.buyEstimates.get(key);
    if(cached&&this.now()-cached.asOf<15000)return structuredClone(cached);
    if(this.pendingEstimates.has(key))return structuredClone(await this.pendingEstimates.get(key));
    if(this.pendingEstimates.size>=20)throw launchPreparationBusy('Token estimates are busy. Retrying shortly.');
    const task=this.preparationQueue.run(id,async()=>{const c=await this.chain(id,'mainnet-beta');try{const review=await c.preview(input);const value={...review.devBuy,asOf:this.now()};this.buyEstimates.set(key,value);while(this.buyEstimates.size>100)this.buyEstimates.delete(this.buyEstimates.keys().next().value);return value;}finally{c.close?.();}},{priority:'estimate'});
    this.pendingEstimates.set(key,task);
    try{return structuredClone(await task);}finally{this.pendingEstimates.delete(key);}
  }
  async uploadImage(id, encoded) {
    const image=inspectLaunchImage(encoded);
    return this.locked(id,async()=>{
      const store=this.accounts.storeFor(id),images=await store.read('launch-images',{ids:[]});
      // Coin images and profile pictures share one ownership list. New images are limited per rolling
      // 30 days (entries saved before upload times were recorded do not count) and by a hard total, so a
      // long-time creator is never locked out for good. Nothing is removed: live coins keep their images.
      if(!images.ids.includes(image.id)){
        const now=this.now(),added=images.added&&typeof images.added==='object'&&!Array.isArray(images.added)?images.added:{};
        const recent=images.ids.filter(saved=>Number.isSafeInteger(added[saved])&&now-added[saved]<IMAGE_WINDOW_MS).length;
        ok(recent<IMAGE_WINDOW_LIMIT,'This account has uploaded 100 new images in the last 30 days. Reuse an earlier image or try again later.');
        ok(images.ids.length<IMAGE_TOTAL_LIMIT,'This account has reached its image upload limit.');
      }
      const folder=join(this.accounts.dir,'token-images');await mkdir(folder,{recursive:true});
      const path=join(folder,image.id);let existing;
      try{existing=await readFile(path);}catch(e){if(e.code!=='ENOENT')throw e;}
      // Publish only complete bytes. Concurrent identical uploads may replace
      // the same path safely; interrupted legacy files are repaired on retry.
      if(!existing?.equals(image.bytes))await atomicWrite(path,image.bytes);
      if(!images.ids.includes(image.id)){images.ids.push(image.id);images.added={...(images.added&&typeof images.added==='object'&&!Array.isArray(images.added)?images.added:{}),[image.id]:this.now()};await store.write('launch-images',images);}
      return {imageId:image.id,url:'/token-images/'+image.id,width:image.width,height:image.height};
    });
  }
  async image(imageId) {
    ok(/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(imageId),'Invalid token image.');
    const bytes=await readFile(join(this.accounts.dir,'token-images',imageId));
    ok(createHash('sha256').update(bytes).digest('hex')===imageId.split('.')[0],'Token image is incomplete. Upload it again before launching.');
    return {bytes,type:imageId.endsWith('.jpg')?'image/jpeg':imageId.endsWith('.png')?'image/png':'image/webp'};
  }
  async ownedImage(id,imageId) {
    const images=await this.accounts.storeFor(id).read('launch-images',{ids:[]});
    ok(images.ids.includes(imageId),'Upload a token image before reviewing your launch.');
    return this.image(imageId);
  }
  async normalized(id,raw,options={}){
    const input=await this.newLaunchInput(id,raw,options);new PublicKey(input.quoteMint);
    ok(!this.walletOnly||input.walletMode==='external','Connect your wallet to launch. Stored account wallets are disabled.');
    const identity=await this.accounts.get(id);ok(!identity?.banned,'This account is banned from Launchpad.');
    if(identity?.authType==='wallet')ok(input.walletMode==='external'&&input.externalWallet===identity.mainWallet,'Connect the wallet used to sign in before launching.');
    let payer;
    if(input.walletMode==='external'){
      const key=new PublicKey(input.externalWallet);
      ok(PublicKey.isOnCurve(key.toBytes()),'Connect a valid Solana wallet.');payer={address:key.toBase58(),external:true};
    }else{
      const account=await this.accounts.get(id),saved=await this.accounts.storeFor(id).read('main-wallet');
      ok(saved?.publicKey===account.mainWallet&&signer(saved.privateKey).publicKey.toBase58()===account.mainWallet,'Your default Solana wallet is unavailable. Restore the account wallet before launching.');
      payer={address:account.mainWallet,secret:saved.privateKey};
    }
    await this.accounts.assertWalletAllowed?.(payer.address);
    // An AI Agent launch assigns the creator entitlement to the agent wallet.
    // A Paycheck launch (v71.44) pays its creator share to the launch creator's wallet, like creator fees.
    input.recipient=input.agent?input.agent.wallet:input.feeMode==='creator'||paycheckLaunch({input})?payer.address:'';
    const requestId=String(raw.requestId||'');ok(!requestId||/^[a-f0-9-]{36}$/.test(requestId),'Invalid review request.');
    return {input,payer,inputHash:digest(input),requestId};
  }
  async buildDraft(id,{input,payer,inputHash,requestId}){
    requireAvailableNewLaunchMode(input);
    const image=await this.ownedImage(id,input.imageId),chain=await this.chain(id,input.network),launchId=randomBytes(16).toString('hex');
    let vanity=null;
    try{
      // A separate fee authority keeps each coin's rewards isolated, including
      // when the developer pays and buys from a connected wallet.
      const review=await chain.preview({...input,feeCustody:'relay'}),keys=newLaunchKeys();keys.payer=payer;keys.platform=keys.wallet;
      // The coin's address comes from the operator's vanity pool while one is
      // left. The review, then the created draft, hold it on a lease; it is used
      // up only when the launch's first transaction is signed (commitVanity), and
      // returns to the pool if the review expires or the draft is never signed.
      vanity=await this.reserveVanity(launchId,input,id);if(vanity?.address)keys.mint={address:vanity.address,secret:vanity.secret};
      const holderRewards=holderRewardPolicy(input,review);
      const media=await this.metadataStorage.prepare(input,keys,image,{publicUrl:this.publicUrl});input.image=media.imageUrl;
      review.platformBrand={...platformBrand(),img:media.storage.platformImage||platformBrand().img};
      const launch={id:launchId,requestId,inputHash,input,keys,review,feeCustody:'relay',createdAt:this.now(),state:'draft',executionPlan:payer.external?'compact-v3':undefined,phase:BigInt(media.storage.budget)>0n?(payer.external?'setup':'storage-fund'):'metadata',storage:media.storage,uri:media.uri,operations:[],credits:{quote:'0',base:'0'},autoFees:false,gas:{day:new Date(this.now()).toISOString().slice(0,10),reserved:'0'},publicOrigin:this.publicUrl};
      if(holderRewards){launch.holderRewards=holderRewards;provisionRewardsWallet(launch,this.now());}
      review.storageSol=displayUnits(media.storage.budget);
      review.minimumSol=displayUnits(units(review.minimumSol)+BigInt(media.storage.budget)+storageAllowance(input,media.storage.budget,review)+extraSetupAllowance(launch));
      ok(launch.uri.length<=200,'The generated metadata address is too long.');
      if(payer.external){const prior=extraSetupAllowance(launch),plan=await chain.preflightWalletSize?.(launch);review.minimumSol=displayUnits(units(review.minimumSol)+extraSetupAllowance(launch)-prior);if(plan){review.approvals=plan.transactions;review.setupLamports=plan.setupLamports;}}
      launch.reviewExpires=this.now()+180000;launch.reviewHash=digest([launch.id,input,review,launch.uri]);
      return {launch,metadata:media.metadata,vanity:vanity?.address||null,vanityMissed:vanity?.missed===true};
    }catch(error){this.releaseVanity(launchId,vanity?.address);throw error;}
    finally{chain.close?.();}
  }
  // Reviews are prepared while the creator edits the form, so each account
  // holds at most one vanity address: a newer review releases the previous one
  // first (creating from the older review still works while that address is free).
  async reserveVanity(launchId,input,accountId){
    if(!this.vanity||input.network!=='mainnet-beta')return null;
    this.vanityHolds||=new Map();const previous=this.vanityHolds.get(accountId);
    try{
      if(previous&&previous.launchId!==launchId){this.vanityHolds.delete(accountId);await this.vanity.release({venue:'raydium',ref:previous.launchId,address:previous.address}).catch(()=>{});}
      // An account holds at most two addresses in created drafts that have not signed yet (each for an hour); more drafts launch on random addresses.
      const book=await this.book(accountId),now=this.now();
      if(book.launches.filter(l=>l.vanity?.address&&!l.vanity.committed&&now-(l.vanity.heldAt??l.createdAt)<VANITY_LIMITS.draftLeaseMs).length>=2)return null;
      const picked=await this.vanity.reserve({venue:'raydium',ref:launchId,exclude:address=>book.launches.some(l=>l.keys?.mint?.address===address)});if(picked)this.vanityHolds.set(accountId,{launchId,address:picked.address});return picked||{missed:true};
    }catch{return null;}
  }
  /** A cached review becomes the account's held review again (after an undo in the form); false when its address went to another launch. */
  async rehold(accountId,value){
    if(!value.vanity||!this.vanity)return true;
    this.vanityHolds||=new Map();const current=this.vanityHolds.get(accountId);if(current?.launchId===value.launch.id)return true;
    if(current){this.vanityHolds.delete(accountId);await this.vanity.release({venue:'raydium',ref:current.launchId,address:current.address}).catch(()=>{});}
    const held=await this.vanity.claim({venue:'raydium',ref:value.launch.id,address:value.vanity}).catch(()=>false);if(held)this.vanityHolds.set(accountId,{launchId:value.launch.id,address:value.vanity});return held;
  }
  /**
   * Before Launchpad signs anything with the mint key (create, launch-all), and when
   * a draft is authorized or refreshed: the draft's vanity lease is renewed for
   * an hour, so mint-signed bytes always expire long before the address could
   * go to another launch. A draft that lost its address stops here.
   */
  async holdVanity(l){
    const v=l.vanity;if(!v?.address||v.committed||!this.vanity)return;
    ok(await this.vanity.claim({venue:'raydium',ref:l.id,address:v.address,ttlMs:VANITY_LIMITS.draftLeaseMs}),VANITY_LOST);v.heldAt=this.now();
  }
  /** Before a launch's first transaction is journaled: its vanity address is recorded as used (or a launch without one is reported). */
  async commitVanity(id,l){
    const v=l.vanity;if(!v||!this.vanity||v.committed||v.noted)return;
    if(v.missed){await this.vanity.noteFallback({venue:'raydium',ref:l.id}).catch(()=>{});v.noted=true;return;}
    try{await this.vanity.commit({venue:'raydium',ref:l.id,address:v.address,launch:{name:l.input.name,symbol:l.input.symbol,accountId:id}});}
    catch(error){ok(error?.code!=='VANITY_TAKEN',VANITY_LOST);throw error;}
    v.committed=true;
  }
  releaseVanity(launchId,address){
    if(!this.vanity||!address)return;
    for(const [account,hold] of this.vanityHolds||[])if(hold.launchId===launchId)this.vanityHolds.delete(account);
    this.vanity.release({venue:'raydium',ref:launchId,address}).catch(()=>{});
  }
  // A review holding a vanity address does not reveal it until the launch is
  // created: unused pool addresses stay private.
  reviewView(value){const view={...publicLaunch(value.launch),prepareId:value.launch.id};if(value.vanity){view.mint=null;if(view.agent)view.agent={...view.agent,href:null};}return view;}
  async prepare(id,raw,options={}){
    const normalized=await this.normalized(id,raw,options),key=id+':'+normalized.inputHash;
    for(const [cacheKey,value]of this.preparedLaunches)if(value.launch.reviewExpires<=this.now()){this.preparedLaunches.delete(cacheKey);this.releaseVanity(value.launch.id,value.vanity);}
    const cached=[...this.preparedLaunches.values()].find(x=>x.owner===id&&x.launch.inputHash===normalized.inputHash);
    if(cached&&cached.launch.reviewExpires>this.now()+15000){if(await this.rehold(id,cached))return this.reviewView(cached);this.preparedLaunches.delete(id+':'+cached.launch.id);}
    if(this.pendingPreparations.has(key))return this.pendingPreparations.get(key);
    if(this.preparedLaunches.size+this.pendingPreparations.size>=MAX_PREPARED_REVIEWS)throw launchPreparationBusy();
    const ownerReviews=[...this.preparedLaunches.values()].filter(value=>value.owner===id).length;
    const ownerPending=[...this.pendingPreparations.keys()].filter(value=>value.startsWith(id+':')).length;
    if(ownerReviews+ownerPending>=MAX_OWNER_REVIEWS)throw launchPreparationBusy('You have several recent launch reviews. Finish a review or retry shortly.');
    const task=this.preparationQueue.run(id,async()=>{
      // Queued requests must not retain stale wallet/ban/protocol settings.
      const current=await this.normalized(id,raw,options);
      ok(current.inputHash===normalized.inputHash&&current.payer.address===normalized.payer.address,'Your launch settings changed while waiting. Review them again.');
      const value=await this.buildDraft(id,current);
      try{ok(!this.closed,'Launchpad is stopping. Reopen the launch when it restarts.');value.owner=id;
        ok(Buffer.byteLength(JSON.stringify(value))<=MAX_PREPARED_REVIEW_BYTES,'This launch review is too large. Choose a smaller coin image.');}
      catch(error){this.releaseVanity(value.launch.id,value.vanity);throw error;}
      this.preparedLaunches.set(id+':'+value.launch.id,value);
      return this.reviewView(value);
    });
    this.pendingPreparations.set(key,task);try{return await task;}finally{this.pendingPreparations.delete(key);}
  }
  async create(id,raw,options={}){
    const normalized=await this.normalized(id,raw,options);
    if(!raw.prepareId){
      // Older clients can create without the separate prepare endpoint. They
      // must still use the same admission/deduplication as every new review.
      // Do not hold the account's durable transaction lock while queued.
      const existing=normalized.requestId?await this.locked(id,async book=>{
        const launch=book.launches.find(l=>l.requestId===normalized.requestId);
        if(!launch)return null;
        ok(launch.inputHash===normalized.inputHash,'This review request was already used for different launch details.');return publicLaunch(launch);
      }):null;
      if(existing)return existing;
      const prepared=await this.prepare(id,raw,options);
      return this.create(id,{...raw,prepareId:prepared.prepareId},options);
    }
    return this.locked(id,async book=>{
      const {inputHash,requestId}=normalized;
      if(requestId){const existing=book.launches.find(l=>l.requestId===requestId);if(existing){ok(existing.inputHash===inputHash,'This review request was already used for different launch details.');return publicLaunch(existing);}}
      // Requests that stopped before creating a token (failed or abandoned drafts with nothing pending)
      // do not use the 100-launch allowance; a hard total still bounds the book. Nothing is deleted.
      ok(book.launches.filter(saved=>!stoppedBeforeToken(saved)).length<SAVED_LAUNCH_LIMIT&&book.launches.length<SAVED_LAUNCH_TOTAL,'This account has reached its saved launch limit.');
      let value;
      if(raw.prepareId){
        const prepareId=safeId(raw.prepareId),existing=book.launches.find(l=>l.id===prepareId);
        if(existing){ok(existing.inputHash===inputHash,'Launch details changed. Prepare the updated launch first.');return publicLaunch(existing);}
        value=this.preparedLaunches.get(id+':'+prepareId);
        ok(value&&value.owner===id&&value.launch.inputHash===inputHash,'Launch details changed or preparation expired. Prepare the launch again.');
        ok(value.launch.reviewExpires>this.now(),'The launch quote expired. Prepare it again before creating.');
        await this.ownedImage(id,value.launch.input.imageId);
      }
      const launch=structuredClone(value.launch);launch.requestId=requestId;
      // The created draft keeps the review's vanity address on an hour's lease;
      // it is used up when the launch's first transaction is signed.
      if(value.vanity){const held=await this.vanity.claim({venue:'raydium',ref:launch.id,address:value.vanity,ttlMs:VANITY_LIMITS.draftLeaseMs}).catch(()=>false);if(!held){this.preparedLaunches.delete(id+':'+launch.id);ok(false,'This launch review expired. Prepare the launch again.');}launch.vanity={address:value.vanity,committed:false,heldAt:this.now()};if(this.vanityHolds?.get(id)?.launchId===launch.id)this.vanityHolds.delete(id);}
      else if(value.vanityMissed)launch.vanity={missed:true};
      const path=join(this.accounts.dir,'token-metadata');await mkdir(path,{recursive:true});await atomicWrite(join(path,`${launch.keys.mint.address}.json`),JSON.stringify(value.metadata));
      book.launches.push(launch);await this.save(id,book);this.preparedLaunches.delete(id+':'+launch.id);this.known.add(id);return publicLaunch(launch);
    });
  }
  async metadata(mint){ok(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)||/^0x[0-9a-fA-F]{40}$/.test(mint),'Invalid mint.');return JSON.parse(await readFile(join(this.accounts.dir,'token-metadata',`${mint}.json`),'utf8'));}
  async refresh(id,launchId){
    safeId(launchId);this.pendingRefreshes ||= new Map();const key=id+':'+launchId;
    if(this.pendingRefreshes.has(key))return this.pendingRefreshes.get(key);
    const task=this.preparationQueue.run(id,()=>this.locked(id,async b=>{
    const l=this.find(b,launchId);ok(isCurrentLaunch(l.input),'This earlier launch is archived. Use its original build to manage it.');
    this.requireConnectedPayer(l);
    ok(canReprepare(l),'Only a launch without a submitted transaction can be prepared again.');
    await this.holdVanity(l);
    requireAvailableNewLaunchMode(l.input);
    requireNewLaunchTax(l.input);
    const policy=protocolFeeSnapshot(await launchProtocolPolicy(this.accounts));
    const c=await this.chain(id,l.input.network);
    try{
      const originalBrand=l.review.platformBrand,creatorFee=creatorFeeForLaunch(l.input);
      l.input.creatorFeeBps=creatorFee.ratePpm/100;l.input.creatorFeePolicy=creatorFee.policy;
      l.input.protocolFees=policy;Object.assign(l.input,newLaunchCurvePolicy(l.input));
      l.review=await c.preview({...l.input,feeCustody:l.feeCustody});if(originalBrand)l.review.platformBrand=originalBrand;if(l.keys.payer?.external)l.executionPlan='compact-v3';
      if(l.storage){l.review.storageSol=displayUnits(l.storage.budget);l.review.minimumSol=displayUnits(units(l.review.minimumSol)+BigInt(l.storage.budget)+storageAllowance(l.input,l.storage.budget,l.review)+extraSetupAllowance(l));}
      if(l.keys.payer?.external){const prior=extraSetupAllowance(l),plan=await c.preflightWalletSize?.(l);l.review.minimumSol=displayUnits(units(l.review.minimumSol)+extraSetupAllowance(l)-prior);if(plan){l.review.approvals=plan.transactions;l.review.setupLamports=plan.setupLamports;}}
      l.state='draft';l.phase=BigInt(l.storage?.budget||0)>0n?(l.keys.payer?.external?'setup':'storage-fund'):'metadata';l.error='';l.autoFees=false;
      // Metadata preparation adds image after normalized() hashes input.
      // Recompute that same hash shape when an unpaid draft changes policy.
      const normalizedInput={...newLaunchCurvePolicy(l.input),...l.input};delete normalizedInput.image;l.inputHash=digest(normalizedInput);
      delete l.retry;delete l.authorizedAt;l.reviewExpires=this.now()+180000;l.reviewHash=digest([l.id,l.input,l.review,l.uri]);await this.save(id,b);return publicLaunch(l);
    }finally{c.close?.();}
    }),{priority:'resume'});
    this.pendingRefreshes.set(key,task);try{return await task;}finally{this.pendingRefreshes.delete(key);}
  }
  find(book,id){const l=book.launches.find(x=>x.id===safeId(id));ok(l,'Launch was not found in this account.');return l;}
  async requireHeldSolAdmin(actorId){
    const actor=await this.accounts.get(safeId(actorId));
    ok(actor?.role==='admin'&&actor.mfaEnabled===true&&!actor.banned,'Administrator access with two-factor authentication is required.');
    return actor;
  }
  async requireManualHolderAdmin(l,requestId){
    const request=manualHolderDistribution(l);
    ok(request&&request.state!=='blocked'&&request.requestId===requestId,'The saved manual reward authorization changed.');
    const actor=await this.accounts.get(safeId(manualHolderAuthorizer(l,requestId)));
    ok(actor?.role==='admin'&&actor.mfaEnabled===true&&!actor.banned,MANUAL_REWARD_AUTH_ERROR);
  }
  async queueHeldSolDistribution(actorId,{accountId,id,mint,requestId}={}){
    safeId(accountId);safeId(id);safeId(requestId);await this.requireHeldSolAdmin(actorId);
    const result=await this.locked(accountId,async b=>{
      await this.requireHeldSolAdmin(actorId);const l=b.launches.find(row=>row.id===id);
      if(!l)return {state:'skipped',reason:'The launch no longer exists.'};
      const prior=l.heldSolDistribution?.requestId===requestId?l.heldSolDistribution:(l.heldSolDistributionHistory||[]).find(row=>row.requestId===requestId);
      if(prior){ok(prior.actorId===actorId,'This distribution request belongs to a different administrator.');return heldSolView(prior);}
      const owner=await this.accounts.get(accountId);
      const reason=owner?.mainWallet===l.keys?.rewards?.address?'The rewards wallet must be separate from the account sign-in wallet.':heldSolEligibility(l,{mint});
      // The parent durably owns this waiting intent. Do not write a terminal
      // child result, replace the existing cycle, or prepare another payout.
      if(reason===HELD_SOL_BUSY)return {state:'waiting',reason:heldSolWaitReason(l)};
      if((l.heldSolDistributionHistory||[]).length>=10000)return {state:'skipped',reason:'Distribution request history needs archival review.'};
      if(reason){const skipped={version:1,requestId,actorId,state:'skipped',reason,createdAt:this.now(),completedAt:this.now()};l.heldSolDistributionHistory=[...(l.heldSolDistributionHistory||[]),skipped];await this.save(accountId,b);return heldSolView(skipped);}
      const request={version:1,requestId,actorId,state:'queued',reason:'Queued to distribute confirmed SOL reward credits.',amountLamports:l.credits.quote,createdAt:this.now(),operationIndex:l.operations.length,previous:{state:l.state,error:l.error||'',feesRequested:l.feesRequested===true}};
      l.heldSolDistribution=request;
      l.cycle={stage:'distribute',index:0,id:randomBytes(16).toString('hex'),createdAt:this.now(),manual:true,heldSolDistributionRequest:requestId,holderRewardPolicy:HOLDER_REWARD_POLICY};
      l.adminRewardHistory=[...(l.adminRewardHistory||[]),{action:'distribute-held-sol',requestId,actorId,launchId:l.id,at:this.now(),status:'queued'}];
      await this.requireHeldSolAdmin(actorId);await this.save(accountId,b);return heldSolView(request);
    });
    if(result.state==='queued'||result.state==='processing'){this.known.add(accountId);this.kick(accountId);}return result;
  }
  async heldSolDistributionStatus({accountId,id,requestId}={}){
    safeId(accountId);safeId(id);safeId(requestId);const b=await this.book(accountId),l=b.launches.find(row=>row.id===id);
    if(!l)return {state:'skipped',reason:'The launch no longer exists.'};
    const request=l.heldSolDistribution?.requestId===requestId?l.heldSolDistribution:(l.heldSolDistributionHistory||[]).find(row=>row.requestId===requestId);
    return request?heldSolView(request):null;
  }
  async finishHeldSolDistribution(id,b,l,state,reason){
    const request=l.heldSolDistribution;
    ok(heldSolActive(l)&&l.cycle?.heldSolDistributionRequest===request.requestId&&!l.operations.some(op=>['pending','awaiting_signature'].includes(op.state)),'A saved distribution transaction must reconcile before closing this request.');
    const before=structuredClone(l);
    try{
    const unpaid=nativeRewardDebtState(l).unpaid;
    if(unpaid.length)deferNativeRewardPayouts(l,unpaid,unpaid);
    const paid=l.operations.slice(request.operationIndex).filter(op=>op.kind==='payout'&&op.heldSolDistributionRequest===request.requestId&&op.state==='confirmed').reduce((sum,op)=>sum+BigInt(op.amount),0n);
    const debt=nativeRewardDebtState(l),deferred=debt.owed.reduce((sum,row)=>sum+BigInt(row.amount),0n);
    if(paid>0n)l.holderRewards={...l.holderRewards,lastDistributionAt:l.cycle.lastPayoutAt,lastDistributionQuoteUnits:paid.toString()};
    request.state=state;request.reason=reason;request.paidLamports=paid.toString();request.remainingLamports=l.credits.quote;request.deferredLamports=deferred.toString();request.deferredWallets=debt.owed.length;request.completedAt=this.now();
    if(state==='completed'&&BigInt(l.credits.quote)>0n)request.reason='Payout batches finished; unpaid or rounding amounts remain reserved in reward credits.';
    l.state=request.previous.state;l.error=request.previous.error;l.feesRequested=request.previous.feesRequested;l.cycle=null;
    if(request.cancelRequested){l.error='Fee service paused. Pending receipts will still be reconciled.';l.feesRequested=false;}
    delete l.rewardRetry;
    const queuedSweep=manualHolderDistribution(l);if(queuedSweep&&queuedSweep.state!=='blocked'){l.state='live';l.feesRequested=true;}
    l.heldSolDistributionHistory=[...(l.heldSolDistributionHistory||[]),structuredClone(request)];
    const event=(l.adminRewardHistory||[]).find(row=>row.requestId===request.requestId&&row.action==='distribute-held-sol');if(event){event.status=state;event.completedAt=this.now();}
    await this.save(id,b);
    }catch(error){for(const key of Object.keys(l))delete l[key];Object.assign(l,before);throw error;}
  }
  async advanceHeldSolDistribution(id,b,l,c){
    const request=l.heldSolDistribution;
    ok(heldSolActive(l)&&l.cycle?.heldSolDistributionRequest===request.requestId,'The saved distribution request does not match its payout cycle.');
    await this.requireHeldSolAdmin(request.actorId);requireManagedRewardSource(l);
    ok(nativeHolderRewards(l)&&l.rewardsWallet?.status==='active'&&Object.values(rewardsCreatorCredits(l)).every(value=>BigInt(value)===0n),'The held-SOL reward wallet is unavailable.');
    if(request.cancelRequested){await this.finishHeldSolDistribution(id,b,l,'failed','Payout request cancelled; unpaid rewards remain reserved.');return;}
    request.state='processing';request.reason='Distributing saved SOL reward credits in verified batches.';await this.save(id,b);
    // A Paycheck launch (v71.44) distributes through its ledger (every accrued share and pending split, then the rest), never by a plain re-weighting.
    if(l.cycle.stage==='distribute')await (paycheckLaunch(l)?this.allocatePaycheckRewards(id,b,l,c,true):this.allocateNativeHolderRewards(id,b,l,c,true));
    if(l.cycle.stage==='payout'){
      const batch=l.cycle.payouts.slice(l.cycle.index,l.cycle.index+3);
      if(batch.length){
        const amount=batch.reduce((sum,row)=>sum+BigInt(row.amount),0n).toString();ok(BigInt(amount)<=BigInt(l.credits.quote),'Payout exceeds earned fee credit.');
        const count=l.operations.length;
        try{await this.send(id,b,l,c,'payout',await c.payoutInstructions(l,batch,{operation:{kind:'payout',rewardsWallet:rewardsWalletSelection(l,{kind:'payout'})}}),{amount,payouts:batch,reserve:String(1000000+batch.length*3000000),operationData:{heldSolDistributionRequest:request.requestId,...(paycheckLaunch(l)&&l.cycle.paycheck?.policy===PAYCHECK_POLICY?{paycheck:paycheckBatchAttribution(l.cycle.paycheck,batch)}:{})}});}
        catch(error){if(error?.code!=='REWARD_RECIPIENT_RENT'||l.operations.length!==count||l.operations.some(op=>['pending','awaiting_signature'].includes(op.state)))throw error;await this.saveNativeRewardAllocation(id,b,l,()=>deferNativeRewardPayouts(l,batch,error.payouts));}
        return;
      }
      l.cycle.stage='done';
    }
    if(l.cycle.stage==='done')await this.finishHeldSolDistribution(id,b,l,'completed','Confirmed SOL reward payout batches completed.');
  }
  async action(id,launchId,action,body={}){const result=await this.locked(id,async b=>{const l=this.find(b,launchId);
    ok(isCurrentLaunch(l.input)||action==='pause','This earlier launch is archived. Use its original build to manage it.');
    ok(!heldSolActive(l)||action==='pause','A saved holder payout must finish before another reward action.');
    if(heldSolActive(l)&&action==='pause')l.heldSolDistribution.cancelRequested=true;
    if(['launch','resume'].includes(action))ok(!l.recovery||!!l.curve,'This launch was stopped for setup recovery. Use its saved details to create a new launch after recovery completes.');
    if(['launch','resume'].includes(action)&&!l.curve&&!hasSavedLaunchTransaction(l))requireAvailableNewLaunchMode(l.input);
    if(action==='launch'){
      if(['launching','live','pending','awaiting_signature'].includes(l.state))return publicLaunch(l);
      this.requireConnectedPayer(l);
      ok(l.state==='draft','Use Resume to continue an interrupted launch.');ok(body.reviewHash===l.reviewHash&&this.now()<=l.reviewExpires,'The launch review expired or changed. Refresh and review it again.');ok(body.confirm===true,'Review and confirm the onchain launch.');
      requireNewLaunchTax(l.input);
      const creatorFee=creatorFeeForLaunch(l.input);ok(l.input.creatorFeePolicy===creatorFee.policy&&effectiveCreatorFeeRate(l)===creatorFee.ratePpm,'The creator-fee policy changed. Refresh and review the launch before approving.');
      await this.requireNewLaunchProtocol(l);
      await this.holdVanity(l);
      delete l.retry;l.state='launching';l.authorizedAt=this.now();l.lastLaunchActivityAt=this.now();l.autoFees=l.input.autoFees&&!externalCreator(l);setFeeAutomation(l,l.autoFees,this.now(),'launch');l.error='';
    }else if(action==='pause'){l.autoFees=false;setFeeAutomation(l,false,this.now());l.feesRequested=false;l.error='Fee service paused. Pending receipts will still be reconciled.';}
    else if(action==='resume'){if(!l.curve&&!hasSavedLaunchTransaction(l)){await this.requireNewLaunchProtocol(l);await this.holdVanity(l);}if(!l.curve&&!l.operations.some(op=>op.state==='pending'))this.requireConnectedPayer(l);delete l.retry;l.lastLaunchActivityAt=this.now();ok(l.authorizedAt,'This launch has not been confirmed.');l.error='';l.state=pendingSignature(l)?'awaiting_signature':l.curve?'live':'launching';l.autoFees=(l.curve?(typeof body.autoFees==='boolean'?body.autoFees:(l.feeAutomation?.enabled??l.autoFees)):l.input.autoFees)&&!externalCreator(l);setFeeAutomation(l,l.autoFees,this.now());l.feesRequested=!!l.curve;}
    else if(action==='fees'){if(l.input.feeMode==='holders')throw Object.assign(Error('Manual holder distributions are available only in the admin panel.'),{statusCode:403});requestFees(l);}
    else if(action==='holder-distribute')throw Object.assign(Error('Manual holder distributions are available only in the admin panel.'),{statusCode:403});
    else if(action==='rewards-settings')throw Object.assign(Error('Automatic holder rewards have a fixed $100 minimum. Creators cannot change it.'),{statusCode:403});
    else throw Error('Unknown launchpad action.');await this.save(id,b);return publicLaunch(l);});this.known.add(id);if(action!=='rewards-settings')this.kick(id);return result;}
  async claimAll(id){
    const result=await this.locked(id,async b=>{
      const queued=[],active=[],skipped=[];
      for(const l of b.launches){
        const status=creatorFeeStatus(l);
        if(!status.available){skipped.push({id:l.id,reason:status.reason});continue;}
        (status.busy?active:queued).push(l.id);requestFees(l);
      }
      if(queued.length||active.length)await this.save(id,b);
      return {queued,active,skipped,launches:b.launches.map(publicLaunch).reverse()};
    });
    this.known.add(id);if(result.queued.length||result.active.length)this.kick(id);return result;
  }
  async signature(id,launchId,operationId){
    let expired=false;
    const result=await this.locked(id,async b=>{
      const l=this.find(b,launchId),op=l.operations.find(x=>x.operationId===operationId);
      ok((!l.recovery||!!l.curve)&&l.authorizedAt&&isCurrentLaunch(l.input)&&op?.state==='awaiting_signature','This wallet request is no longer active. Refresh the launch.');
      ok(!legacyHolderSale(l,op),'This earlier conversion request is disabled. Refresh to use paced tax conversions.');
      const c=await this.chain(id,l.input.network);
      try{
        if(await c.c.getBlockHeight('finalized')>op.lastValidBlockHeight){
          op.state='expired';delete op.unsignedRaw;delete op.messageHash;op.needsSignature=false;
          l.gas.reserved=(BigInt(l.gas.reserved)>BigInt(op.reserve||'0')?BigInt(l.gas.reserved)-BigInt(op.reserve||'0'):0n).toString();
          l.state=l.curve?'live':'launching';l.feesRequested=!!l.curve;l.error='Preparing a fresh wallet request.';expired=true;
          await this.save(id,b);
        }
        return publicLaunch(l);
      }finally{c.close?.();}
    });
    if(expired)this.kick(id);
    return result;
  }
  async sign(id,launchId,operationId,transaction){
    const result=await this.locked(id,async b=>{
      const l=this.find(b,launchId),op=l.operations.find(x=>x.operationId===operationId);
      ok(l.authorizedAt&&isCurrentLaunch(l.input)&&op,'This wallet request was not found.');
      ok(!l.recovery||!!l.curve,'This wallet request is no longer active. The launch has stopped.');
      ok(!legacyHolderSale(l,op),'This earlier conversion request is disabled. Refresh to use paced tax conversions.');
      // Idempotent browser retries never create or broadcast a replacement.
      if(op.state==='pending'||op.state==='confirmed')return publicLaunch(l);
      ok(op.state==='awaiting_signature'&&l.state==='awaiting_signature','This wallet request is no longer active. Refresh the launch.');
      const c=await this.chain(id,l.input.network);
      try{
        const signed=await c.acceptSigned(op,transaction,{resolveAdditionalSigners:required=>walletOperationSigners(l,op,required)});
        if(initialKinds.has(op.kind))await this.commitVanity(id,l);
        Object.assign(op,signed);delete op.unsignedRaw;delete op.messageHash;
        l.state=l.curve?'live':'launching';l.error='';delete l.retry;
        await this.save(id,b);
        if(!this.closed){try{await c.broadcast(op);}catch{l.error='Submission response unavailable. Launchpad is checking the saved signature; it will not create a second transaction.';await this.save(id,b);}}
        return publicLaunch(l);
      }finally{c.close?.();}
    });
    this.known.add(id);this.kick(id);return result;
  }
  async balance(id,launchId){const l=this.find(await this.book(id),launchId),c=await this.chain(id,l.input.network);try{return{wallet:(l.keys.payer||l.keys.wallet).address,sol:displayUnits(await c.c.getBalance(new PublicKey((l.keys.payer||l.keys.wallet).address)),9),minimumSol:l.review.minimumSol};}finally{c.close?.();}}
  async exportWallet(id,launchId){const l=this.find(await this.book(id),launchId);ok(l.feeCustody!=='relay','This wallet manages platform rewards. Its signing key cannot be exported. Your developer wallet remains yours.');ok(l.keys.wallet.secret&&!l.keys.wallet.external,'Connected wallet keys are held by your wallet and cannot be exported from Launchpad.');return{network:l.input.network,publicKey:l.keys.wallet.address,privateKey:l.keys.wallet.secret};}
  start(){if(this.timer)return;this.timer=setInterval(()=>{for(const id of this.known)if((this.wakeAt.get(id)||0)<=this.now())this.kick(id);},1000);this.timer.unref();Promise.resolve().then(()=>this.accounts.list?.()||[]).then(rows=>{for(const a of rows)this.known.add(a.id);}).catch(()=>{});}
  async close(){this.closed=true;this.preparationQueue.close();clearInterval(this.timer);this.quoteCatalogue.close?.();await Promise.allSettled([...this.jobs.values(),...this.pendingEstimates.values(),...this.pendingPreparations.values(),...(this.pendingRefreshes?.values()||[]),...(this.pendingQuoteChecks?.values()||[]),this.marketFeed?.close(),this.rewardsView?.close(),this.customPairs?.close()]);this.preparedLaunches.clear();}
  kick(id){
    if(this.closed)return;if(this.jobs.has(id)){this.requested.add(id);return;}
    let progressed=false;
    const job=this.process(id).then(value=>{progressed=!!value;}).catch(()=>{}).finally(()=>{
      this.jobs.delete(id);
      // Move directly from a confirmed receipt to the next phase. A receipt
      // that is still pending does not spin or generate another transaction.
      const requested=this.requested.delete(id);if((progressed||requested)&&!this.closed)setTimeout(()=>this.kick(id),0).unref();
    });this.jobs.set(id,job);
  }
  async process(id){return this.locked(id,async b=>{
    let progressed=false,failedFeeChecks=0;
    // Confirm already-submitted transactions first, then continue authorized
    // launches before periodic fee work. Sort a copy so saved launch order and
    // every per-account/per-operation serialization rule remain unchanged.
    const priority=l=>l.operations.some(op=>op.state==='pending')?0:!l.curve&&l.authorizedAt&&l.state==='launching'?1:l.recovery&&!l.curve?2:3;
    for(const l of [...b.launches].sort((a,b)=>priority(a)-priority(b))){
      if(this.closed)break;
      if(!isCurrentLaunch(l.input)){
        if(l.autoFees||l.feesRequested||l.state==='launching'){l.autoFees=false;l.feesRequested=false;l.state='archived';l.error='This earlier launch is archived. Your wallet backup and transaction history remain available.';await this.save(id,b);}continue;
      }
      if(l.recovery&&!l.curve||!confirmedCreationAwaitingVerification(l)&&recoveryDue(l,this.now())){
        if(recoveryDue(l,this.now())){
          if(beginLaunchRecovery(l,this.now()))await this.save(id,b);
          let recoveryChain;
          try{recoveryChain=await this.chain(id,l.input.network);await recoverFailedLaunch({launch:l,chain:recoveryChain,persist:()=>this.save(id,b),now:this.now(),closed:()=>this.closed});}
          catch(e){l.recovery.status='blocked';l.recovery.reason=cleanError(e);l.recovery.nextAt=this.now()+60000;await this.save(id,b);}
          finally{recoveryChain?.close?.();}
        }
        continue;
      }
      const heldOperation=heldSolActive(l)?l.operations.find(op=>['pending','awaiting_signature'].includes(op.state)):null;
      if(heldSolActive(l)&&l.operations.some(op=>op.state==='awaiting_signature'))continue;
      const heldProtocolBoundary=heldOperation?heldOperation.state==='pending'&&protocolOperation(heldOperation):protocolFeesDue(l,this.now());
      if(heldSolActive(l)&&!heldProtocolBoundary){
        const request=l.heldSolDistribution,pending=l.operations.find(op=>op.state==='pending');
        if(request.nextAttemptAt>this.now()||pending?.receiptCheckAfter>this.now())continue;
        let c;
        try{
          c=await this.chain(id,l.input.network);
          if(pending){
            ok(pending.kind==='payout'&&pending.heldSolDistributionRequest===request.requestId,'A different saved transaction blocks this distribution.');
            // A previous directory sync may have failed after rename. Make
            // these exact saved bytes durable before reconcile can resend.
            await this.save(id,b);
            await this.reconcile(id,b,l,c,pending);
            if(['failed','expired'].includes(pending.state))await this.finishHeldSolDistribution(id,b,l,'failed','The saved payout failed or expired; unpaid rewards remain reserved.');
          }else await this.advanceHeldSolDistribution(id,b,l,c);
        }catch(error){
          if(l.operations.some(op=>['pending','awaiting_signature'].includes(op.state))){l.heldSolDistribution.reason='Checking the saved payout transaction before preparing another batch.';l.heldSolDistribution.nextAttemptAt=this.now()+15000;await this.save(id,b);}
          else if(heldSolActive(l))await this.finishHeldSolDistribution(id,b,l,'failed',heldSolFailureReason(error));
        }finally{c?.close?.();}
        continue;
      }
      if(!heldSolActive(l)&&ensureFeeAutomation(l,this.now()))await this.save(id,b);
      if(rewardInventoryRecoveryDueAt(l,this.now())<=this.now()){
        let inventoryChain;
        try{
          await recoverRewardInventory(l,{now:this.now(),persist:()=>this.save(id,b),closed:()=>this.closed,
            read:async(launch,options)=>{
              inventoryChain=await this.chain(id,l.input.network);
              return inventoryChain.revalidateRewardInventory(launch,options);
            }});
        }finally{inventoryChain?.close?.();}
      }
      // Earlier builds retained the full allowance after an onchain failure.
      // Repair only a currently blocked, opted-in gas day, one verified receipt
      // per account pass. Unavailable receipts cannot erase a reserved cost.
      const failedFee=failedFeeChecks<1&&failedFeeRepairCandidates(l,this.now()).find(op=>!(op.failedFeeCheckAfter>this.now()));
      if(failedFee){
        failedFeeChecks++;failedFee.failedFeeCheckAfter=this.now()+60000;await this.save(id,b);let feeChain;
        try{
          feeChain=await this.chain(id,l.input.network);const failedReceipt=await feeChain.receipt(failedFee);
          if(failedReceipt&&settleFailedFeeReserve(l,failedFee,failedReceipt)&&BigInt(l.gas.reserved)+10000000n<=BigInt(l.input.dailyGasLamports)){
            clearRewardRetry(l);l.state='live';l.autoFees=true;l.feesRequested=true;l.error='';
          }
        }catch{/* Retain the allowance and check this exact receipt later. */}
        finally{feeChain?.close?.();}
        await this.save(id,b);
      }
      const oldRequests=l.operations.filter(op=>op.state==='awaiting_signature'&&legacyHolderSale(l,op));
      if(oldRequests.length){
        for(const op of oldRequests){op.state='cancelled';op.needsSignature=false;op.error='Replaced by paced tax conversions.';delete op.unsignedRaw;delete op.messageHash;l.gas.reserved=(BigInt(l.gas.reserved)>BigInt(op.reserve||0)?BigInt(l.gas.reserved)-BigInt(op.reserve||0):0n).toString();}
        if(l.cycle)l.cycle.stage='route';
        if(l.state==='awaiting_signature'&&!l.operations.some(op=>op.state==='awaiting_signature'))l.state=l.curve?'live':'launching';
        await this.save(id,b);
      }
      if(l.operations.some(x=>x.state==='awaiting_signature')||l.retry?.at>this.now())continue;
      const pending=l.operations.find(x=>x.state==='pending');
      if(pending?.receiptCheckAfter>this.now())continue;
      const due=l.curve&&l.state==='live'&&!(l.rewardRetry?.at>this.now())&&(l.feesRequested||l.autoFees&&this.now()>=feeCycleDueAt(l));
      const taxMaintenanceDue=officialTaxMaintenanceAt(l)<=this.now();
      const brandingDue=!heldSolActive(l)&&l.curve&&l.brandingRequested&&!l.protocolFeesRequested;
      // A saved unsigned reward cycle does not own protocol revenue. At this
      // transaction boundary, collect its separate credits without changing the
      // reward snapshot or retry. Pending receipts still reconcile first below.
      const protocolDue=protocolFeesDue(l,this.now());
      if(!pending&&l.state!=='launching'&&!due&&!protocolDue&&!brandingDue&&!taxMaintenanceDue)continue;
      // Two coins using the same creator vault must not prepare claims from
      // the same balance while the first transaction still awaits a receipt.
      if(!pending&&(due||taxMaintenanceDue)&&!protocolDue&&!brandingDue&&b.launches.some(other=>other!==l&&feeScope(other)===feeScope(l)&&activeFeeOperation(other)))continue;
      const before=[l.state,l.phase,l.operations.length,pending?.state].join(':');let c;
      try{
        c=await this.chain(id,l.input.network);
        if(pending)await this.reconcile(id,b,l,c,pending);
        else if(l.state==='launching')await this.advanceLaunch(id,b,l,c);
        else if(brandingDue)await this.advancePlatformBrand(id,b,l,c);
        else if(protocolDue)await this.advanceProtocolFees(id,b,l,c);
        else if(taxMaintenanceDue)await this.advanceOfficialTaxMaintenance(id,b,l,c);
        else await this.advanceFees(id,b,l,c);
        if(l.retry){delete l.retry;if(['Your connection is catching up. Launchpad will continue automatically.','The pairing-asset price moved. Launchpad is refreshing the route within your original budget.'].includes(l.error))l.error='';await this.save(id,b);}
        if(before!==[l.state,l.phase,l.operations.length,pending?.state].join(':')&&l.state==='launching')progressed=true;
      }catch(e){
        if(pending?.kind==='platform-brand-update'||brandingDue&&!pending){l.brandingError=cleanError(e);if(!pending)l.brandingRequested=false;await this.save(id,b);continue;}
        if(pending?.kind==='creator-fee-update'){l.creatorFeeError=cleanError(e);await this.save(id,b);continue;}
        if(pending?.kind.startsWith('protocol-')||protocolDue&&!pending){
          if(retryProtocolCollection(l,e,this.now())){if(pending)pending.receiptCheckAfter=l.protocolRetry.at;}
          else {l.protocolError=cleanError(e);if(!pending)l.protocolFeesRequested=false;delete l.protocolRetry;}
          await this.save(id,b);continue;
        }
        if(pending?.taxMaintenancePolicy===TAX_MAINTENANCE_POLICY||taxMaintenanceDue&&!pending){
          if(retryOfficialTaxMaintenance(l,e,this.now())){
            if(pending)pending.receiptCheckAfter=l.taxMaintenance.nextAt;
          }else{
            // Unknown or semantic failures remain reviewable hard stops. They
            // cannot fall through to a broader ordinary reward retry policy.
            l.error=cleanError(e);l.state='paused';l.feesRequested=false;
          }
          await this.save(id,b);continue;
        }
        const signedPending=l.operations.some(x=>x.state==='pending');
        if(!l.curve&&l.phase==='verify'&&l.operations.some(op=>['create','launch-all'].includes(op.kind)&&op.state==='confirmed')&&e?.code==='LAUNCH_VERIFICATION_PENDING'){
          const attempt=(l.retry?.attempt||0)+1;
          l.retry={attempt,at:this.now()+(attempt>8?60000:Math.min(8000,1000*2**Math.min(attempt-1,3)))};
          l.state='launching';l.error='Your token was created onchain. Launchpad is waiting for a consistent RPC snapshot to finish verification.';
          await this.save(id,b);continue;
        }
        if(!l.curve&&l.authorizedAt&&transientLaunchError(e)){
          const attempt=(l.retry?.attempt||0)+1;
          if(attempt<8||signedPending){
            l.retry={attempt,at:this.now()+Math.min(8000,1000*2**Math.min(attempt-1,3))};
            l.error=['LAUNCH_FUNDING_SLIPPAGE','LAUNCH_FUNDING_PRICE_MOVED'].includes(e?.code)?'The pairing-asset price moved. Launchpad is refreshing the route within your original budget.':'Your connection is catching up. Launchpad will continue automatically.';
            if(!signedPending)l.state='launching';
            await this.save(id,b);continue;
          }
        }
        delete l.retry;
        if(retryManualHolderDistribution(l,e,this.now())||autoRewardEnabled(l)&&scheduleRewardRetry(l,e,this.now())){
          if(pending)pending.receiptCheckAfter=l.rewardRetry.at;
          await this.save(id,b);continue;
        }
        l.error=cleanError(e);clearRewardRetry(l);l.autoFees=autoRewardEnabled(l);l.feesRequested=false;
        if(manualHolderDistribution(l)){l.manualHolderDistribution.state='blocked';l.manualHolderDistribution.reason=l.error;}
        if(!signedPending)l.state=l.curve?'paused':'error';await this.save(id,b);
      }finally{c?.close?.();}
    }
    let next=Infinity;
    for(const l of b.launches){
      if(!isCurrentLaunch(l.input))continue;
      next=Math.min(next,rewardInventoryRecoveryDueAt(l,this.now()));
      for(const op of failedFeeRepairCandidates(l,this.now()))next=Math.min(next,Math.max(this.now()+1000,op.failedFeeCheckAfter||0));
      if(heldSolActive(l)){
        if(l.operations.some(op=>op.state==='awaiting_signature'))continue;
        const pending=l.operations.find(op=>op.state==='pending'),unsettled=l.operations.some(op=>['pending','awaiting_signature'].includes(op.state));
        next=Math.min(next,Math.max(this.now()+1000,protocolOperation(pending)?0:l.heldSolDistribution.nextAttemptAt||0,pending?.receiptCheckAfter||0));
        if(!unsettled&&l.protocolFeesRequested)next=Math.min(next,Math.max(this.now()+1000,protocolRetryAt(l)));
        if(!unsettled&&['live','paused','error'].includes(l.state)&&l.review.protocolFees?.autoHarvest)next=Math.min(next,Math.max(this.now()+1000,protocolCollectionAt(l),protocolRetryAt(l)));
        continue;
      }
      if(!l.curve&&!confirmedCreationAwaitingVerification(l))next=Math.min(next,recoveryWakeAt(l,this.now()));
      if(l.recovery&&!l.curve||l.operations.some(o=>o.state==='awaiting_signature'))continue;
      if(l.operations.some(o=>o.state==='pending')||l.state==='launching')next=Math.min(next,l.retry?.at||l.operations.find(o=>o.state==='pending')?.receiptCheckAfter||this.now()+1000);
      else if(l.curve&&l.brandingRequested)next=Math.min(next,this.now()+1000);
      else {
        if(l.curve&&l.protocolFeesRequested)next=Math.min(next,Math.max(this.now()+1000,protocolRetryAt(l)));
        if(l.curve&&l.state==='live'&&(l.feesRequested||l.autoFees))next=Math.min(next,l.rewardRetry?.at>this.now()?l.rewardRetry.at:l.feesRequested?this.now()+1000:Math.max(this.now()+1000,feeCycleDueAt(l)));
      }
      if(l.curve&&!l.operations.some(o=>['pending','awaiting_signature'].includes(o.state))&&['live','paused','error'].includes(l.state)&&l.review.protocolFees?.autoHarvest)next=Math.min(next,Math.max(this.now()+1000,protocolCollectionAt(l),protocolRetryAt(l)));
      next=Math.min(next,Math.max(this.now()+1000,officialTaxMaintenanceAt(l)));
    }
    this.wakeAt.set(id,next);
    return progressed;
  });}
  // Kept for older integrations. Existing coins change only through the explicit policy upgrade.
  async refreshCreatorFee(){return {status:'deferred',reason:'explicit_policy_upgrade_required'};}
  // Payout gas (v71.37): the payout simulation said the rewards wallet lacks `error.fundingShortfallLamports` of SOL. Sell a little of
  // the rewards for it and let the next pass try the payout again; rewards too small to pay for their own delivery stay reserved.
  async sellForPayoutGas(id,b,l,c,error){
    const selection=rewardsWalletSelection(l,{kind:'gas-sell'});
    if(error.fundingWallet&&error.fundingWallet!==selection.address)throw error;
    const sales=l.cycle.gasSales||0,today=l.operations.filter(op=>op.kind==='gas-sell'&&op.state!=='failed'&&op.createdAt>this.now()-24*3600000).length;
    if(sales>=PAYOUT_GAS_ATTEMPTS||today>=PAYOUT_GAS_SALES_PER_DAY)throw Object.assign(Error(`${error.message} Launchpad already sold rewards for network costs ${sales} time${sales===1?'':'s'} in this cycle and ${today} in the last 24 hours; add SOL to the rewards wallet or wait for the limit to pass.`),{code:'REWARD_NATIVE_FUNDS',retryable:true,fundingWallet:error.fundingWallet});
    // The simulation names the first missing rent only. Size the sale for the whole cycle when the chain can say how many of the
    // unpaid recipients still lack a token account for the pair asset (one sale instead of one per batch); otherwise, or when that
    // would take more than a fifth of the rewards, cover the reported shortfall alone so the current batch can go out.
    const shortfall=BigInt(error.fundingShortfallLamports||'0')||PAYOUT_GAS_DEFAULT_SHORTFALL_LAMPORTS,unpaid=l.cycle.payouts.slice(l.cycle.index),credit=BigInt(l.credits.quote);
    let cycleNeed=null;try{cycleNeed=typeof c.payoutRecipientRentLamports==='function'?await c.payoutRecipientRentLamports(l,unpaid):null;}catch{cycleNeed=null;}
    const whole=cycleNeed&&/^\d+$/.test(String(cycleNeed.lamports))?BigInt(cycleNeed.lamports):0n,minimal=shortfall+PAYOUT_GAS_HEADROOM_LAMPORTS;
    const targets=[...new Set([whole>shortfall?whole+PAYOUT_GAS_HEADROOM_LAMPORTS:minimal,minimal])];
    let target=null,sell=0n,sizing='';
    for(const candidate of targets){
      const need=await c.payoutGasSaleAmount(l,candidate.toString()),amount=need+need*PAYOUT_GAS_MARGIN_BPS/10000n;
      target=candidate;sell=amount;sizing=candidate===minimal?'shortfall':'cycle';
      if(amount>0n&&amount*PAYOUT_GAS_MAX_SHARE_DIVISOR<=credit)break;
    }
    if(sell<=0n||sell*PAYOUT_GAS_MAX_SHARE_DIVISOR>credit){
      // Delivery would eat more than a fifth of the rewards: keep them for a bigger payout instead of spending them on rent.
      l.payoutGasNote=`The rewards waiting are too small to pay for the holders’ new token accounts and network fees (${displayUnits(target,9)} SOL needed, about ${displayUnits(sell,l.review.quoteDecimals)} of ${displayUnits(credit,l.review.quoteDecimals)} ${quoteLabel(l.input.quoteMint,l.review.quoteSymbol,l.input.quoteSymbol)}). They stay reserved for the next payout.`;
      l.cycle.stage='done';delete l.cycle.payouts;l.cycle.index=0;await this.save(id,b);return;
    }
    const payoutGas={shortfallLamports:shortfall.toString(),targetLamports:target.toString(),sizing,...(cycleNeed?{recipients:cycleNeed.recipients,missingAccounts:cycleNeed.missing}:{})};
    const instructions=await c.payoutGasSaleInstructions(l,sell.toString(),{operation:{kind:'gas-sell',rewardsWallet:selection,payoutGas}});
    delete l.payoutGasNote;
    await this.send(id,b,l,c,'gas-sell',instructions,{amount:sell.toString(),reserve:'3000000',operationData:{payoutGas:{...payoutGas,expectedLamports:instructions.payoutGas?.expectedLamports||'0',minimumLamports:instructions.payoutGas?.minimumLamports||'0'}}});
  }
  async send(id,b,l,c,kind,instructions,{amount='0',payouts=[],extra=[],reserve='5000000',operationData={}}={}){
    if(!instructions.length)return false;
    if(initialKinds.has(kind))await this.holdVanity(l);
    if(initialKinds.has(kind))this.requireConnectedPayer(l);
    const creationFeeExpected=creationFeeExpectation(l,kind);
    if(creationFeeExpected)operationData={...operationData,creationFeeExpected};
    if(kind==='tax-burn')requireTaxBurnPlan(l,{...operationData,kind,amount});
    if(operationData.taxMaintenancePolicy!==undefined){
      ok(officialTaxMaintenanceEnabled(l)&&!l.operations.some(op=>['pending','awaiting_signature'].includes(op.state)),'Official LAUNCHPAD tax maintenance is not available.');
      officialTaxMaintenanceOperation(l,{...operationData,kind,...(kind==='tax'?{taxProtocolPolicy:TAX_PROTOCOL_POLICY}:{}),rewardsWallet:rewardsWalletSelection(l,{kind})});
    }
    if(kind==='sell'&&l.input.feeMode==='holders')ok(!officialTaxBurnSelected(l),'Collected LAUNCHPAD taxes are reserved for burning; new sales are disabled.');
    if(kind==='sell'&&l.input.feeMode==='holders'){
      const burst=operationData.taxConversionPolicy===TAX_CONVERSION_BURST_POLICY;
      ok(operationData.taxConversionPolicy===undefined||['paced-v1',TAX_CONVERSION_BURST_POLICY].includes(operationData.taxConversionPolicy),'Unknown tax conversion policy.');
      ok(l.cycle?.taxConversionAttempted===true&&BigInt(amount)>0n&&BigInt(amount)<=BigInt(l.credits.base)&&(burst?automaticTaxBacklog(l)&&!manualHolderCycle(l)&&BigInt(amount)===TAX_CONVERSION_BACKLOG_UNITS:BigInt(amount)<=TAX_CONVERSION_MAX_UNITS),'Tax conversion exceeds its paced earned-token budget.');
      if(burst){
        const source=taxBacklogSource(l,TAX_CONVERSION_BACKLOG_UNITS);
        ok(source.credit===amount&&['taxSource','taxProtocolPolicy','taxBaseUnits','ordinaryBaseUnits'].every(key=>source.operationData[key]===operationData[key]),'The backlog sale differs from its isolated saved source credits.');
      }else ok(operationData.taxSource!=='mixed-earned','Mixed reward inventory requires an exact authorized backlog sale.');
    }
    if(kind==='sell'&&operationData.manualHolderDistributionRequest!==undefined){
      const request=manualHolderCycle(l),source=manualHolderConversionSource(l);
      ok(request?.state!=='blocked'&&request?.requestId===operationData.manualHolderDistributionRequest&&source.operationData.taxSource===operationData.taxSource&&BigInt(amount)<=BigInt(source.credit),'Manual reward sale exceeds its authorized saved source budget.');
    }
    if(kind==='sell'&&operationData.taxSource==='mixed-earned')await taxProtocolTreasury(this.accounts,l);
    if(kind==='sell'&&operationData.taxSource==='withheld-tax'){
      ok(operationData.taxProtocolPolicy===TAX_PROTOCOL_POLICY&&BigInt(amount)<=BigInt(taxProtocolLedger(l).sourceBaseCredit),'Tax conversion exceeds its isolated transfer-tax credit.');
      await taxProtocolTreasury(this.accounts,l);
    }
    if(kind==='tax'){
      // Resolve before signing a harvest. A missing/separate-wallet policy
      // cannot silently redirect this new fee to the toolkit or creator.
      const recipient=await taxProtocolTreasury(this.accounts,l);
      operationData={...operationData,taxProtocolPolicy:TAX_PROTOCOL_POLICY,taxProtocolRecipient:recipient};
    }
    if(kind==='gas-sell')ok(payoutGasSaleApplies(l)&&BigInt(amount)>0n&&BigInt(amount)*PAYOUT_GAS_MAX_SHARE_DIVISOR<=BigInt(l.credits.quote)&&/^[1-9]\d*$/.test(String(operationData.payoutGas?.shortfallLamports||''))&&(l.cycle.gasSales||0)<PAYOUT_GAS_ATTEMPTS,'The payout gas sale exceeds its budget.');
    if(kind==='tax-protocol-payout')ok(BigInt(amount)>0n&&BigInt(amount)<=BigInt(taxProtocolLedger(l).creditQuote)&&operationData.taxProtocolPolicy===TAX_PROTOCOL_POLICY&&payouts.length===1&&payouts[0].owner===operationData.taxProtocolRecipient&&payouts[0].amount===amount,'Tax payout exceeds its reserved protocol credit.');
    const feeWork=!initialKinds.has(kind),day=new Date(this.now()).toISOString().slice(0,10);
    if(l.gas.day!==day)l.gas={day,reserved:'0'};
    if(feeWork&&BigInt(l.gas.reserved)+BigInt(reserve)>BigInt(l.input.dailyGasLamports))throw Object.assign(Error('The daily reward network-cost budget is used. The next budget starts at midnight UTC.'),{code:'REWARD_GAS_BUDGET'});
    let signingLaunch=l;
    if(kind.startsWith('protocol-')){
      const selection=kind==='protocol-enable'&&l.protocolActivation?.upgradeVersion!==undefined?protocolActivationSigner(l,l.protocolActivation):protocolWalletSelection(l);
      operationData={...operationData,protocolFeeWallet:{...selection}};signingLaunch=protocolWalletView(l,selection);
    }
    if(l.input.feeMode==='holders'&&['claim','tax','reward-handoff'].includes(kind))requireManagedRewardSource(l);
    if(l.input.feeMode==='holders'&&rewardOperation(l,{kind})){operationData={...operationData,rewardsWallet:rewardsWalletSelection(l,{kind})};}
    // Every newly signed step of a saved manual sweep needs a current actor,
    // including claims, custody handoffs and an older payout it is finishing.
    // Separate held-SOL and periodic LAUNCHPAD maintenance retain their own guards.
    const manual=rewardOperation(l,{kind})&&!operationData.heldSolDistributionRequest&&!operationData.taxMaintenancePolicy?manualHolderDistribution(l):null;
    if(manual){
      ok(operationData.manualHolderDistributionRequest===undefined||operationData.manualHolderDistributionRequest===manual.requestId,'The saved manual reward authorization changed.');
      // Authorization also covers a pre-existing automatic cycle, whose sale
      // must keep its original receipt accounting instead of a manual budget.
      await this.requireManualHolderAdmin(l,manual.requestId);
    }
    if(operationData.heldSolDistributionRequest){ok(kind==='payout'&&heldSolActive(l)&&l.heldSolDistribution.requestId===operationData.heldSolDistributionRequest,'Invalid held-SOL payout authorization.');await this.requireHeldSolAdmin(l.heldSolDistribution.actorId);}
    const op={...operationData,...await c.prepare(signingLaunch,instructions,extra,feeWork?false:kind,{operation:{...operationData,kind,amount}}),operationId:randomBytes(16).toString('hex'),kind,amount,payouts,reserve:feeWork?reserve:'0'};
    if(manual)await this.requireManualHolderAdmin(l,manual.requestId);
    if(operationData.heldSolDistributionRequest)await this.requireHeldSolAdmin(l.heldSolDistribution.actorId);
    ok(!op.signature||!l.operations.some(prior=>prior.signature===op.signature),'This transaction signature is already saved. Wait for a fresh blockhash before retrying.');
    if(kind==='payout'&&l.input.feeMode==='holders')op.holderRewardCycleId=l.cycle?.id;
    if(kind==='sell'&&l.input.feeMode==='holders')op.taxConversionPolicy=operationData.taxConversionPolicy||'paced-v1';
    if(this.closed)return false;
    if(initialKinds.has(kind)&&!op.needsSignature)await this.commitVanity(id,l);
    // Durable signed bytes precede every broadcast. A timeout never authorizes a
    // fresh transaction; only this exact signature may be sent again.
    l.operations.push(op);if(op.needsSignature){l.state='awaiting_signature';l.error='';}if(feeWork)l.gas.reserved=(BigInt(l.gas.reserved)+BigInt(reserve)).toString();await this.save(id,b);
    if(this.closed||op.needsSignature)return true;
    try{await c.broadcast(op);}catch{l[kind.startsWith('protocol-')?'protocolError':kind==='platform-brand-update'?'brandingError':'error']='Submission response unavailable. Launchpad is checking the saved signature; it will not create a second transaction.';await this.save(id,b);}return true;
  }
  async checkExpiredReward(id,b,l,c,op){
    const holderSale=l.input.feeMode==='holders'&&op.kind==='sell';
    const protocol=protocolOperation(op);
    const taxMaintenance=officialTaxMaintenanceOperation(l,op);
    if(!l.curve||!rewardOperation(l,op)&&!protocol||typeof c.pendingTransactionState!=='function')return false;
    const result=await c.pendingTransactionState(op);
    op.receiptCheckAfter=this.now()+10000;
    if(result.state!=='expired'){
      delete op.expiryCheck;op.receiptNote=result.reason||'Waiting for a verified transaction outcome.';
      await this.save(id,b);return false;
    }
    const prior=op.expiryCheck,checkpoint=result.checkpoint;
    if(result.signature!==op.signature||!Number.isSafeInteger(checkpoint?.slot)||!Number.isSafeInteger(checkpoint?.height)||checkpoint.height<=op.lastValidBlockHeight)return false;
    // Two checks must agree across advancing finalized checkpoints. No retry
    // is signed here. Enabled reward services continue after backoff; explicit
    // pauses stay paused. Unknown/pruned/stale history always remains pending.
    if(!prior||prior.signature!==op.signature||this.now()-prior.at<10000||checkpoint.slot<=prior.slot||checkpoint.height<=prior.height){
      op.expiryCheck={signature:op.signature,at:this.now(),...checkpoint};
      op.receiptNote='The transaction appears expired. Checking a second finalized checkpoint before allowing a retry.';
      await this.save(id,b);return false;
    }
    op.state='expired';op.expiredAt=this.now();op.expiryProof={first:prior,second:{...checkpoint,at:this.now()},historyFromSlot:result.historyFromSlot};
    op.error='Expired blockhash; signature absent from retained transaction history at two finalized checkpoints.';
    delete op.raw;delete op.receiptCheckAfter;delete op.receiptNote;
    if(l.gas.day===new Date(op.createdAt).toISOString().slice(0,10))l.gas.reserved=(BigInt(l.gas.reserved)>BigInt(op.reserve||0)?BigInt(l.gas.reserved)-BigInt(op.reserve||0):0n).toString();
    if(protocol){
      // A proven non-landing protocol transaction consumes no earned credit.
      // Resume only its existing authorized step, leaving creator/holder work
      // and its explicit pause preference untouched. Unknown history never
      // reaches this branch and cannot authorize replacement signed bytes.
      l.protocolClaimStage=op.kind==='protocol-enable'?'activate':op.kind==='protocol-claim'?'claim':op.kind==='protocol-lp-claim'?'lp':'payout';
      if(op.kind==='protocol-enable'&&op.protocolPolicy)l.protocolActivation=structuredClone(op.protocolPolicy);
      l.protocolFeesRequested=true;
      l.protocolError='The saved protocol transaction expired without landing. Launchpad will retry its saved step.';
      await this.save(id,b);return true;
    }
    if(taxMaintenance){
      retryOfficialTaxMaintenance(l,Object.assign(Error('The saved LAUNCHPAD tax transaction expired without landing.'),{code:'REWARD_TRANSACTION_EXPIRED'}),this.now());
      await this.save(id,b);return true;
    }
    l.state='paused';l.autoFees=autoRewardEnabled(l);l.feesRequested=false;
    if(holderSale){
      // No trade landed: preserve both reward ledgers and the saved holder
      // snapshot. Skip another sale in this cycle, including on manual resume.
      if(l.cycle){l.cycle.stage=manualHolderCycle(l)?'route':'tax-protocol';l.cycle.taxConversionAttempted=!manualHolderCycle(l);}
      l.lastTaxConversionAt=this.now();
      l.error='The earlier tax conversion expired without landing. Reward balances are unchanged. You can now upgrade the protocol policy or manually resume holder rewards.';
    }else{
      l.error=`The saved ${op.kind} transaction expired without landing. Its signature remains in history. Resume rewards to continue the saved step.`;
    }
    const retryError=Object.assign(Error('The saved reward transaction expired without landing. Continuing the saved reward cycle.'),{code:'REWARD_TRANSACTION_EXPIRED'});
    if(!retryManualHolderDistribution(l,retryError,this.now()))scheduleRewardRetry(l,retryError,this.now());
    await this.save(id,b);return true;
  }
  async reconcile(id,b,l,c,op){if(op.state!=='pending')return;const taxMaintenance=officialTaxMaintenanceOperation(l,op);ok(!l.operations.some(prior=>prior!==op&&prior.state==='confirmed'&&prior.signature===op.signature),'This transaction receipt was already applied to another operation.');if(l.curve&&rewardOperation(l,op)&&this.now()-op.createdAt>180000)op.receiptCheckAfter=this.now()+10000;const observedBefore=op.observedSignatureStatus,tx=await c.receipt(op);if(op.observedSignatureStatus!==observedBefore)await this.save(id,b);if(!tx){
      if(legacyHolderSale(l,op)){
        // A missing receipt can still mean an unfinalized transaction. Keep
        // reconciling its exact signature, but never resend an old bulk sale.
        if(this.now()-op.createdAt>180000&&await this.checkExpiredReward(id,b,l,c,op))return;
        l.error='An earlier tax conversion is awaiting its receipt. Launchpad will check it without submitting the old sale again.';
        if(this.now()-op.createdAt>180000){l.autoFees=autoRewardEnabled(l);l.feesRequested=l.autoFees||!!manualHolderDistribution(l)&&l.manualHolderDistribution.state!=='blocked';if(l.feesRequested)l.state='live';}
        await this.save(id,b);return;
      }
      if(this.now()-op.createdAt>180000){if(await this.checkExpiredReward(id,b,l,c,op))return;if(op.kind==='platform-brand-update'){l.brandingError='Platform branding receipt is unresolved. Launchpad will keep checking its saved signature.';await this.save(id,b);return;}if(op.kind==='creator-fee-update'){l.creatorFeeError='Creator fee update receipt is unresolved. Launchpad will keep checking the saved signature.';await this.save(id,b);return;}if(op.kind.startsWith('protocol-')){l.protocolError='Protocol fee receipt is still unresolved. Launchpad will keep checking its saved signature.';await this.save(id,b);return;}l.autoFees=autoRewardEnabled(l);l.feesRequested=l.autoFees||!!manualHolderDistribution(l)&&l.manualHolderDistribution.state!=='blocked';l.error=l.feesRequested?'Waiting for the saved reward transaction. Rewards will continue automatically once its outcome is verified.':'Transaction receipt is still unresolved. Automatic work is paused while Launchpad checks the saved signature.';l.state=l.curve?(l.feesRequested?'live':'paused'):l.state;await this.save(id,b);return;}
      if(!this.closed&&this.now()-(op.lastBroadcast||op.createdAt)>15000&&await c.c.getBlockHeight('finalized')<=op.lastValidBlockHeight){op.lastBroadcast=this.now();await this.save(id,b);await c.broadcast(op).catch(()=>{});}return;
    }
    if(tx.meta?.err)settleFailedFeeReserve(l,op,tx);
    if(tx.meta?.err&&taxMaintenance){
      op.state='failed';op.failedAt=this.now();op.error=JSON.stringify(tx.meta.err);delete op.raw;
      retryOfficialTaxMaintenance(l,Object.assign(Error('The saved LAUNCHPAD tax transaction failed onchain.'),{code:'REWARD_TRANSACTION_FAILED'}),this.now());
      await this.save(id,b);return;
    }
    if(tx.meta?.err){op.state='failed';op.failedAt=this.now();op.error=JSON.stringify(tx.meta.err);delete op.raw;if(op.kind==='platform-brand-update'){l.brandingRequested=false;l.brandingError='The onchain branding update failed. The previous platform branding remains active.';await this.save(id,b);return;}if(op.kind==='creator-fee-update'){l.creatorFeeError='Creator fee update failed onchain. The last confirmed fee is unchanged.';l.creatorFees={...l.creatorFees,nextAt:this.now()+60000};await this.save(id,b);return;}if(op.kind.startsWith('protocol-')){l.protocolFeesRequested=false;l.protocolError='Protocol fee transaction failed onchain. Review its receipt before retrying.';await this.save(id,b);return;}if(op.kind==='sell'&&l.input.feeMode==='holders'){l.lastTaxConversionAt=this.now();if(l.cycle){l.cycle.stage=manualHolderCycle(l)?'route':'tax-protocol';l.cycle.taxConversionAttempted=!manualHolderCycle(l);}}l.error=l.curve?`${op.kind} failed onchain. Fees are paused. Resume to retry this step.`:`${op.kind} failed onchain. Launchpad will stop this attempt and recover unused setup SOL.`;l.state=l.curve?'paused':'error';l.autoFees=autoRewardEnabled(l);l.feesRequested=false;if(rewardOperation(l,op)){const retryError=Object.assign(Error('The reward transaction failed onchain. Its saved step will be prepared again using current chain state.'),{code:'REWARD_TRANSACTION_FAILED'});if(!retryManualHolderDistribution(l,retryError,this.now()))scheduleRewardRetry(l,retryError,this.now());}await this.save(id,b);return;}
    const beforeApply=structuredClone(l),operationIndex=l.operations.indexOf(op);
    try{
    const initial=initialKinds.has(op.kind);
    const receiptLaunch=op.kind.startsWith('protocol-')?protocolWalletView(l,op.protocolFeeWallet||{source:'wallet',address:l.keys.wallet.address}):l;
    const handoff=op.kind==='reward-handoff'?rewardHandoffReceipt(tx,l,op):null;
    const delta=initial?{gasAndRent:0n}:handoff?{quote:0n,base:0n,gasAndRent:handoff.gasAndRent}:op.kind==='tax-burn'?taxBurnReceipt(tx,l,op):receiptDeltas(tx,receiptLaunch,{operation:op,selfPayout:op.kind==='payout'&&l.input.quoteMint===SOL_MINT?(op.payouts||[]).filter(x=>x.owner===l.keys.wallet.address).reduce((n,x)=>n+BigInt(x.amount),0n):0n});
    if(initial){
      const payer=(l.keys.payer||l.keys.wallet).address;
      const received=mint=>{const sum=rows=>(rows||[]).filter(x=>x.owner===payer&&x.mint===mint).reduce((n,x)=>n+BigInt(x.uiTokenAmount.amount),0n);return sum(tx.meta.postTokenBalances)-sum(tx.meta.preTokenBalances);};
      if(op.kind==='quote-fund'||op.kind==='setup'&&BigInt(l.review.devBuy?.gross||0)>0n)ok(received(l.input.quoteMint)>=BigInt(l.review.devBuy.maxQuote),'Pairing-asset purchase did not deliver the reviewed amount. Check the receipt before resuming.');
      if(['create','launch-all'].includes(op.kind)&&BigInt(l.review.devBuy?.gross||0)>0n){const amount=received(l.keys.mint.address);ok(amount===BigInt(l.review.devBuy.net),'The developer buy receipt differs from the reviewed amount.');}
      if(['create','launch-all'].includes(op.kind)&&op.creationFeeExpected)op.creationFeeReceipt=creationFeeReceipt(tx,op.creationFeeExpected);
    }
    if(op.kind==='reward-handoff'){
      if(nativeHolderRewards(l)&&l.cycle?.stage==='payout'&&!l.cycle.index)resetNativeRewardAllocation(l);
      op.rewardHandoffReceipt=recordRewardHandoff(l,op,handoff,this.now());delete l.rewardsWallet.gasFundingNeed;
      if(nativeHolderRewards(l))nativeRewardDebtState(l);
    }
    else if(op.kind==='setup')l.phase=l.executionPlan==='compact-v3'?'platform-setup':BigInt(l.storage?.budget||0)>0n?'storage-fund':'create';
    else if(op.kind==='platform-setup')l.phase=BigInt(l.storage?.budget||0)>0n?'storage-fund':'create';
    else if(op.kind==='storage-credit')l.phase='storage-fund';
    else if(op.kind==='storage-fund')l.phase='metadata';
    else if(op.kind==='platform')l.phase=(l.input.quoteMint!==SOL_MINT||l.keys.payer?.external)&&BigInt(l.review.devBuy?.gross||0)>0n?'quote-fund':'create';
    else if(op.kind==='quote-fund')l.phase='create';
    else if(op.kind==='create'||op.kind==='launch-all')l.phase='verify';
    else if(op.kind==='platform-brand-update'){
      ok(delta.quote===0n&&delta.base===0n,'Platform branding unexpectedly moved tokens.');
      await c.verifyPlatformBrandUpdate(l,op.brandDecision,tx.slot);
      l.platformBrand={...op.brandDecision.target,signature:op.signature,updatedAt:this.now()};l.brandingRequested=false;l.brandingError='';delete l.brandingUpdate;
    }else if(op.kind==='creator-fee-update'){
      ok(delta.quote===0n&&delta.base===0n,'Creator fee update unexpectedly moved tokens.');
      await c.verifyCreatorFeeUpdate(l,op.creatorFeeDecision,tx.slot);
      l.creatorFees={...op.creatorFeeDecision,status:'active',ratePpm:op.creatorFeeDecision.ratePpm,signature:op.signature,confirmedAt:this.now()};l.creatorFeeError='';
    }else if(op.kind==='protocol-enable'){
      ok(delta.quote===0n&&delta.base===0n,'Protocol activation unexpectedly moved tokens.');
      const target=op.protocolPolicy||l.protocolActivation;
      if(target?.upgradeVersion!==undefined)ok(validProtocolPolicyTarget(target,l),'The saved protocol policy target is invalid.');
      await c.verifyProtocolActivation(l,tx.slot,target);
      if(target?.upgradeVersion!==undefined){
        const previous={protocolFeeWallet:{...protocolWalletSelection(l)},platformFeeBps:l.review.platformFeeBps||0,protocolFees:structuredClone(l.review.protocolFees||null),lp:l.review.lp,creatorFeeRatePpm:effectiveCreatorFeeRate(l),creatorFeePolicy:l.creatorFees?.policy||l.review.creatorFeePolicy||null};
        l.protocolPolicyUpgrades=[...(l.protocolPolicyUpgrades||[]),{at:this.now(),signature:op.signature,slot:tx.slot,previous,target:structuredClone(target)}];
        l.creatorFees={policy:target.creatorFeePolicy,ratePpm:target.creatorFeeRatePpm,status:'active',signature:op.signature,confirmedAt:this.now()};l.creatorFeeError='';
        l.review.lp=protocolLiquidityTerms(target).description;
        if(target.protocolFeeWallet)l.protocolFeeWallet={...target.protocolFeeWallet};
      }
      l.review.platformFeeBps=100;l.review.protocolFees=protocolFeeSnapshot(target);l.protocolEnabledAt=this.now();delete l.protocolActivation;l.protocolFeesRequested=false;l.protocolClaimStage='done';l.protocolError='';
    }else if(op.kind==='protocol-claim'||op.kind==='protocol-lp-claim'){
      ok(delta.quote>=0n&&(op.kind==='protocol-lp-claim'?delta.base>=0n:delta.base===0n),'Protocol claim produced unexpected token movements.');
      l.protocolCredit=(BigInt(l.protocolCredit||'0')+delta.quote).toString();l.protocolClaimed=(BigInt(l.protocolClaimed||'0')+delta.quote).toString();
      if(op.kind==='protocol-lp-claim'){l.protocolBaseCredit=(BigInt(l.protocolBaseCredit||'0')+delta.base).toString();l.protocolBaseClaimed=(BigInt(l.protocolBaseClaimed||'0')+delta.base).toString();l.protocolClaimStage='payout';}
      else l.protocolClaimStage=l.review.protocolFees.lpPolicy==='platform_locked'?'lp':'payout';
    }else if(op.kind==='protocol-payout'){
      ok(delta.quote===-BigInt(op.amount)&&delta.base===0n&&BigInt(l.protocolCredit||'0')>=BigInt(op.amount),'Protocol payout differs from its confirmed fee credit.');
      l.protocolCredit=(BigInt(l.protocolCredit)-BigInt(op.amount)).toString();l.protocolPaid=(BigInt(l.protocolPaid||'0')+BigInt(op.amount)).toString();l.protocolFeesRequested=false;l.protocolClaimStage='done';l.protocolError='';
    }else if(op.kind==='protocol-lp-payout'){
      ok(delta.quote===-BigInt(op.amount)&&delta.base===-BigInt(op.baseAmount)&&BigInt(l.protocolCredit||'0')>=BigInt(op.amount)&&BigInt(l.protocolBaseCredit||'0')>=BigInt(op.baseAmount),'Protocol LP payout differs from its confirmed fee credit.');
      l.protocolCredit=(BigInt(l.protocolCredit||'0')-BigInt(op.amount)).toString();l.protocolBaseCredit=(BigInt(l.protocolBaseCredit||'0')-BigInt(op.baseAmount)).toString();l.protocolPaid=(BigInt(l.protocolPaid||'0')+BigInt(op.amount)).toString();l.protocolBasePaid=(BigInt(l.protocolBasePaid||'0')+BigInt(op.baseAmount)).toString();l.protocolFeesRequested=false;l.protocolClaimStage='done';l.protocolError='';
    }else if(op.kind==='tax-protocol-payout'){
      l.taxProtocol=recordTaxProtocolPayout(l,op,delta);
      l.cycle.stage='distribute';
    }else {
      let q=BigInt(l.credits.quote),a=BigInt(l.credits.base);
      if(op.kind==='claim'){ok(delta.quote>=0n&&delta.base>=0n,'Fee claim produced unexpected debits.');q+=delta.quote;a+=delta.base;l.cycle.claimedQuote=(BigInt(l.cycle.claimedQuote||0)+delta.quote).toString();l.cycle.claimedBase=(BigInt(l.cycle.claimedBase||0)+delta.base).toString();l.cycle.stage=l.input.taxBps?'tax':'route';}
      if(op.kind==='tax'){
        ok(delta.base>=0n&&delta.quote===0n,'Tax claim produced unexpected token movements.');
        // Pending harvests prepared by earlier builds preserve their existing
        // holder allocation; only the new explicitly saved policy is charged.
        if(op.taxProtocolPolicy===TAX_PROTOCOL_POLICY)l.taxProtocol=recordTaxHarvest(l,delta.base);
        a+=delta.base;if(!taxMaintenance)l.cycle.stage='route';
      }
      if(op.kind==='tax-burn'){
        const burned=recordTaxBurn(l,op,delta,this.now());
        l.taxProtocol=burned.ledger;l.taxBurn=burned.policy;op.taxBurnReceipt=burned.receipt;delete l.taxBurnRequest;
        a+=delta.base;if(!taxMaintenance)l.cycle.stage='tax-protocol';
      }
      if(op.kind==='sell'){
        ok(delta.base<0n&&-delta.base<=BigInt(op.amount)&&-delta.base<=a&&delta.quote>0n,'Tax conversion receipt differs from its authorized budget.');
        if(op.taxConversionPolicy===TAX_CONVERSION_BURST_POLICY)ok(BigInt(op.amount)===TAX_CONVERSION_BACKLOG_UNITS&&-delta.base===TAX_CONVERSION_BACKLOG_UNITS,'The backlog conversion receipt differs from its exact authorized 10,000,000-token sale.');
        if(['withheld-tax','mixed-earned'].includes(op.taxSource)){
          const split=op.taxSource==='mixed-earned'?recordMixedTaxConversion(l,op,-delta.base,delta.quote):recordTaxConversion(l,op,-delta.base,delta.quote);l.taxProtocol=split.ledger;q+=split.holderQuote;
          op.taxProtocolReceipt={policy:TAX_PROTOCOL_POLICY,baseUnits:(split.taxBase??-delta.base).toString(),quoteUnits:(split.taxQuote??delta.quote).toString(),protocolQuoteUnits:split.protocolQuote.toString(),holderQuoteUnits:(split.taxQuote===undefined?split.holderQuote:split.taxQuote-split.protocolQuote).toString(),...(op.taxSource==='mixed-earned'?{source:'mixed-earned',ordinaryBaseUnits:op.ordinaryBaseUnits,ordinaryQuoteUnits:split.ordinaryQuote.toString()}: {})};
        }else{
          ok(-delta.base<=a-BigInt(taxProtocolLedger(l).sourceBaseCredit),'This sale would consume reserved transfer-tax source credit.');q+=delta.quote;
        }
        const manualSale=settleManualHolderConversion(l,op,-delta.base);
        a+=delta.base;const backlog=automaticTaxBacklog({...l,credits:{...l.credits,base:a.toString()}});l.cycle.stage=manualSale||backlog?'route':'tax-protocol';if(manualSale||backlog)l.cycle.taxConversionAttempted=false;if(l.input.feeMode==='holders')l.lastTaxConversionAt=this.now();
      }
      if(op.kind==='buy'){ok(delta.quote<0n&&-delta.quote<=BigInt(op.amount)&&delta.base>0n,'Buyback receipt differs from its earned-fee budget.');q+=delta.quote;a+=delta.base;l.cycle.stage='burn';}
      if(op.kind==='gas-sell'){
        // The sale spent at most its budget of the pair asset and touched no coin; the SOL it bought is the wallet's own gas now.
        ok(delta.quote<0n&&-delta.quote<=BigInt(op.amount)&&delta.base===0n,'Payout gas sale receipt differs from its budget.');
        q+=delta.quote;l.cycle.gasSales=(l.cycle.gasSales||0)+1;l.cycle.lastGasSaleAt=this.now();l.cycle.stage='payout';
        shrinkPayoutsToCredit(l,q);
      }
      if(op.kind==='burn'){ok(delta.base===-BigInt(op.amount),'Burn receipt amount mismatch.');a+=delta.base;l.cycle.stage='done';}
      if(op.kind==='payout'){ok(delta.quote===-BigInt(op.amount),'Payout receipt differs from its earned-fee budget.');settleNativeRewardPayout(l,op.payouts);q-=BigInt(op.amount);l.cycle.index+=op.payouts.length;if(l.input.feeMode==='holders'){l.cycle.distributedQuoteUnits=(BigInt(l.cycle.distributedQuoteUnits||0)+BigInt(op.amount)).toString();l.cycle.lastPayoutAt=this.now();}if(op.paycheck?.policy===PAYCHECK_POLICY&&paycheckLaunch(l))l.paycheck=recordPaycheckPayout(paycheckLedger(l),op.paycheck);}
      ok(q>=0n&&a>=0n,'Fee-credit invariant failed.');l.credits={quote:q.toString(),base:a.toString()};
      if(nativeHolderRewards(l))nativeRewardDebtState(l);
      if(l.input.feeMode==='holders'&&l.rewardsWallet&&rewardsWalletSelection(l,{operation:op,receipt:true}).source==='wallet'){
        if(op.kind==='claim')addCreatorRewardCredits(l,{base:delta.base,quote:delta.quote});
        if(op.kind==='tax')addCreatorRewardCredits(l,{base:delta.base,taxBase:op.taxProtocolPolicy===TAX_PROTOCOL_POLICY?delta.base:0n});
      }
    }
    if(BigInt(op.reserve||'0')>0n){const spent=BigInt(l.gas.reserved)-BigInt(op.reserve)+delta.gasAndRent;l.gas.reserved=(spent>0n?spent:0n).toString();}
    // Keep the validated actual amounts for read-only reward reporting. The
    // requested amount is only a swap budget and is not a receipt total.
    if(!initial)op.receipt={quoteDelta:delta.quote.toString(),baseDelta:delta.base.toString()};
    // Analytics cannot interrupt payment reconciliation. Missing recipient
    // metadata leaves this payment incomplete in personal history.
    if(op.kind==='payout'){try{const receipt=personalRewardReceipt(l,op,tx);if(receipt)op.personalRewardReceipt=receipt;}catch{}}
    if(taxMaintenance)completeOfficialTaxMaintenance(l,op,this.now(),op.kind==='tax'?delta.base:0n);
    else if(rewardOperation(l,op)){clearRewardRetry(l);const request=manualHolderDistribution(l);if(autoRewardEnabled(l)||request&&request.state!=='blocked'){l.state='live';l.autoFees=autoRewardEnabled(l);l.feesRequested=true;}}
    op.state='confirmed';op.slot=tx.slot;op.confirmedAt=this.now();delete op.raw;delete op.receiptCheckAfter;delete op.receiptNote;delete op.expiryCheck;if(op.kind.startsWith('protocol-')){l.protocolError='';delete l.protocolRetry;}else if(op.kind==='platform-brand-update')l.brandingError='';else if(!taxMaintenance)l.error='';await this.save(id,b);
    }catch(error){
      // Receipt validation is all-or-nothing. The outer worker may persist its
      // error, but must never persist half-applied money with a pending receipt.
      const savedOperation=beforeApply.operations[operationIndex];
      for(const key of Object.keys(op))delete op[key];Object.assign(op,savedOperation);beforeApply.operations[operationIndex]=op;
      for(const key of Object.keys(l))delete l[key];Object.assign(l,beforeApply);throw error;
    }
  }
  async advanceLaunch(id,b,l,c){
    // Previously signed or funded launches keep their reviewed terms. An old
    // authorized draft with no saved transaction must re-review the current
    // policy before it can incur its first setup cost.
    if(!hasSavedLaunchTransaction(l)){
      try{await this.requireNewLaunchProtocol(l);}catch(error){
        if(!['LAUNCH_POLICY_REVIEW_REQUIRED','LAUNCH_MODE_RETIRED'].includes(error?.code))throw error;
        l.state='draft';l.reviewExpires=0;l.error=cleanError(error);l.autoFees=false;l.feesRequested=false;
        setFeeAutomation(l,false,this.now(),'policy-review');delete l.authorizedAt;delete l.retry;
        await this.save(id,b);return;
      }
    }
    if(l.phase!=='verify')this.requireConnectedPayer(l);
    if(l.phase==='metadata'){if(await this.metadataStorage.upload(l,()=>this.save(id,b),()=>this.closed)){l.phase=compactLaunch(l)?(l.operations.some(o=>o.kind==='setup'&&o.state==='confirmed')?'create':l.splitPlatformSetup||BigInt(l.review.devBuy?.gross||0)>0n?'setup':'launch-all'):'platform';await this.save(id,b);}else return;if(this.closed)return;}
    if(l.phase==='verify'){const result=await c.verifyLaunch(l);l.curve=result.curve;l.state='live';l.lastCycle=this.now();l.error='';await this.save(id,b);return;}
    if(initialKinds.has(l.phase)){
      const payer=['storage-fund','platform-setup'].includes(l.phase)&&l.keys.payer?.external?l.keys.platform:l.keys.payer||l.keys.wallet,remaining=(l.phase==='quote-fund'||l.phase==='create'&&l.input.quoteMint===SOL_MINT&&!l.keys.payer?.external)?BigInt(l.review.devBuy?.solBudget||0):0n;
      const needed=['setup','launch-all'].includes(l.phase)?units(l.review.minimumSol):l.phase==='platform-setup'?BigInt(l.review.platformRent||0)+BigInt(l.review.storageWalletRent||0)+25000n:l.phase==='storage-fund'?BigInt(l.storage.budget)+25000n+(l.keys.payer?.external?BigInt(l.review.storageWalletRent||'0'):0n):l.phase==='storage-credit'?BigInt(l.storage.budget)+50000n+BigInt(l.review.storageWalletRent||'0'):remaining+(l.phase==='platform'?BigInt(l.review.platformRent||0)+BigInt(l.review.serviceReserve||0):0n)+10000000n;
      ok(BigInt(await c.c.getBalance(new PublicKey(payer.address)))>=needed,l.phase==='storage-fund'&&l.keys.payer?.external?'Launch setup funding is not confirmed yet. Check the previous transaction before resuming.':`Add SOL to your ${l.keys.payer?.external?'connected':'default Solana'} wallet for this launch, then Resume.`);

      if(l.phase==='create'||l.phase==='launch-all')await c.preflightLaunch?.(l);
      const extra=[];if(l.phase==='create'||l.phase==='launch-all')extra.push(signer(l.keys.mint.secret));if((['platform','launch-all'].includes(l.phase)||l.phase==='setup'&&l.executionPlan!=='compact-v3')&&l.keys.platform&&l.keys.platform.address!==payer.address)extra.push(signer(l.keys.platform.secret));await this.send(id,b,l,c,l.phase,await c.launchInstructions(l,l.phase),{extra});
    }
  }
  async advancePlatformBrand(id,b,l,c){
    const decision=l.brandingUpdate;ok(decision?.target,'The platform branding update is missing.');
    const instructions=await c.platformBrandUpdateInstructions(l,decision),admin=l.keys.platform||l.keys.wallet,extra=admin.address!==l.keys.wallet.address?[signer(admin.secret)]:[];
    try{await this.send(id,b,l,c,'platform-brand-update',instructions,{extra,operationData:{brandDecision:decision}});}finally{for(const key of extra)key.secretKey.fill(0);}
  }
  async advanceProtocolFees(id,b,l,c){
    if(l.protocolClaimStage==='activate'){
      const selection=l.protocolActivation?.upgradeVersion!==undefined?protocolActivationSigner(l,l.protocolActivation):protocolWalletSelection(l);
      if((selection.source==='platform'||l.protocolActivation?.protocolFeeWallet?.source==='protocol')&&c.c.getBalance){
        const balance=await c.c.getBalance(new PublicKey(selection.address),'finalized');
        ok(balance>=50000,`Add SOL to the upgrade gas wallet ${selection.address}, then retry the policy upgrade. ${l.protocolActivation?.protocolFeeWallet?.source==='protocol'?'0.01 SOL provides an upgrade reserve. The new protocol wallet needs its own SOL for later fee collection.':'0.01 SOL provides a reserve for the upgrade and subsequent fee collection.'}`);
      }
      const instructions=await c.protocolActivationInstructions(l),admin=l.keys.platform||l.keys.wallet,extra=admin.address!==selection.address?[signer(admin.secret)]:[];
      try{await this.send(id,b,l,c,'protocol-enable',instructions,{extra,operationData:{protocolPolicy:structuredClone(l.protocolActivation)}});}finally{for(const key of extra)key.secretKey.fill(0);}return;
    }
    ok(l.review.platformFeeBps===100&&l.review.protocolFees?.recipient&&managedProtocolWallet(l),'This launch has no managed protocol fee policy.');
    const automatic=!l.protocolFeesRequested;
    if(automatic){
      const curveDue=this.now()>=(l.protocolNextHarvestAt||(l.authorizedAt||l.createdAt)+3600000);
      l.protocolAutomaticCycle=true;if(curveDue)l.protocolNextHarvestAt=this.now()+3600000;
      if(l.review.protocolFees.lpPolicy==='platform_locked')l.protocolNextLpHarvestAt=this.now()+60000;
      l.protocolClaimStage=BigInt(l.protocolCredit||'0')>0n||BigInt(l.protocolBaseCredit||'0')>0n?'payout':curveDue?'claim':'lp';await this.save(id,b);
    }
    if(l.protocolClaimStage==='claim'){
      const instructions=await c.claimInstructions(l,automatic?'protocol-auto':'protocol');
      if(instructions.length){l.protocolFeesRequested=true;if(await this.send(id,b,l,c,'protocol-claim',instructions))return;}
      l.protocolClaimStage=l.review.protocolFees.lpPolicy==='platform_locked'?'lp':'payout';
    }
    if(l.protocolClaimStage==='lp'){
      l.protocolNextLpHarvestAt=this.now()+60000;await this.save(id,b);
      try{const instructions=await c.protocolLiquidityInstructions(l,{automatic:!!l.protocolAutomaticCycle});if(instructions.length){l.protocolFeesRequested=true;if(await this.send(id,b,l,c,'protocol-lp-claim',instructions))return;}}
      catch(error){if(error.code!=='PROTOCOL_HARVEST_DEFERRED')throw error;}
      l.protocolClaimStage='payout';
    }
    const credit=BigInt(l.protocolCredit||'0'),base=BigInt(l.protocolBaseCredit||'0');
    const treasury=credit>0n||base>0n?await launchProtocolPolicy(this.accounts,{required:false}):null;
    const recipient=treasury?.recipientScope==='launchpad'?treasury.recipient:l.review.protocolFees.recipient;
    if(base>0n){
      const instructions=await c.protocolPayoutInstructions(l,{quote:credit.toString(),base:base.toString(),recipient});
      if(await this.send(id,b,l,c,'protocol-lp-payout',instructions,{amount:credit.toString(),operationData:{baseAmount:base.toString(),protocolRecipient:recipient}}))return;
    }else if(credit>0n){
      const payouts=[{owner:recipient,amount:credit.toString()}];
      if(await this.send(id,b,l,c,'protocol-payout',await c.payoutInstructions(protocolWalletView(l),payouts,{operation:{kind:'protocol-payout'}}),{amount:credit.toString(),payouts}))return;
    }
    l.protocolFeesRequested=false;l.protocolClaimStage='done';delete l.protocolRetry;l.protocolError='';await this.save(id,b);
  }
  async refreshHolderMinimum(l,c){
    try{
      let reference=l.holderRewards?.priceReference;
      try{currentHolderRewardMinimum(l,reference,this.now());}catch{reference=await c.holderRewardReference(l);}
      const minimum=currentHolderRewardMinimum(l,reference,this.now());
      l.holderRewards={...l.holderRewards,policy:paycheckLaunch(l)?PAYCHECK_POLICY:HOLDER_REWARD_POLICY,minimumUsd:holderRewardMinimumUsd(l),minimumQuoteUnits:minimum.toString(),priceReference:reference,thresholdNote:''};
      return minimum;
    }catch{
      l.holderRewards={...l.holderRewards,policy:paycheckLaunch(l)?PAYCHECK_POLICY:HOLDER_REWARD_POLICY,minimumUsd:holderRewardMinimumUsd(l),thresholdNote:`Waiting for a fresh quote price to check the $${holderRewardMinimumUsd(l)} reward minimum.`};
      return null;
    }
  }
  async saveNativeRewardAllocation(id,b,l,change){
    const cycle=structuredClone(l.cycle),debts=l.nativeRewardDebts===undefined?undefined:structuredClone(l.nativeRewardDebts),paycheck=l.paycheck===undefined?undefined:structuredClone(l.paycheck);
    try{change();nativeRewardDebtState(l);await this.save(id,b);}
    catch(error){l.cycle=cycle;if(debts===undefined)delete l.nativeRewardDebts;else l.nativeRewardDebts=debts;if(paycheck===undefined)delete l.paycheck;else l.paycheck=paycheck;throw error;}
  }
  // Paycheck (v71.44): the distribute stage of a Paycheck launch. New credit is split (holders 50%, $LAUNCHPAD buy-and-burn
  // 35%, Launchpad 10%, creator 5%), holders accrue pro rata to a fresh snapshot, sellers forfeit, and every amount at
  // $0.50 (creator, treasury and holders alike, merged per wallet) becomes a payout row next to any owed native debt.
  async allocatePaycheckRewards(id,b,l,c,override){
    ok(nativeHolderRewards(l),'Paycheck launches pair with SOL only.');
    if(l.cycle.payouts!==undefined){nativeRewardDebtState(l);l.cycle.stage='payout';return;}
    const state=nativeRewardDebtState(l),due=override||this.now()>=holderRewardCheckDueAt(l);
    // Owed native debts from an earlier payout are paid even when nothing else is due or the quote price is unavailable.
    const debtsOnly=async()=>{if(!state.owed.length){l.cycle.stage='done';return;}await this.saveNativeRewardAllocation(id,b,l,()=>{queueNativeRewardPayouts(l,[]);l.cycle.holderRewardPolicy=PAYCHECK_POLICY;l.cycle.nativeRewardDebtOnly=true;l.cycle.stage='payout';});};
    if(!due)return debtsOnly();
    l.cycle.holderRewardChecked=true;
    const ledger=paycheckLedger(l),owedToLedger=paycheckLedgerTotal(ledger),credit=BigInt(l.credits.quote);
    ok(state.reserved+owedToLedger<=credit,'The Paycheck ledger exceeds the earned fee credit.');
    // The threshold needs a fresh quote price; without one this check waits (the saved note says so) and nothing new moves.
    const minimum=await this.refreshHolderMinimum(l,c);
    if(minimum===null)return debtsOnly();
    let protocol;try{protocol=await taxProtocolTreasury(this.accounts,l);}catch(error){throw Object.assign(Error('Paycheck needs the separate Launchpad protocol fee wallet (Admin → Settings → Protocol fees) before it can pay the Launchpad and buy-and-burn shares. '+cleanError(error)),{code:'PAYCHECK_TREASURY'});}
    const threshold=paycheckPayoutThreshold(l),creator=l.input.recipient;
    ok(typeof creator==='string'&&creator&&creator!==l.keys.wallet.address&&creator!==l.keys.rewards?.address,'The Paycheck creator wallet is unavailable.');
    const pool=credit-state.reserved-owedToLedger;
    const snapshot=pool>0n||override?await c.holderSnapshot(l):null;
    const plan=planPaycheckCycle({ledger,pool,rows:snapshot?.rows??null,threshold,recipients:{creator,protocol},owedOwners:state.owed.map(row=>row.owner),override,now:this.now(),slot:snapshot?.slot??null});
    await this.saveNativeRewardAllocation(id,b,l,()=>{
      queueNativeRewardPayouts(l,plan.payouts);
      l.paycheck=plan.ledger;
      l.cycle.holderRewardPolicy=PAYCHECK_POLICY;l.cycle.nativeRewardDebtOnly=!plan.payouts.length;l.cycle.paycheck={...plan.attribution,...plan.cycle};
      if(snapshot){l.cycle.slot=snapshot.slot;l.cycle.eligibleBalance=plan.cycle.eligibleBalance;}
      l.cycle.holderMinimumQuoteUnits=threshold.toString();
      l.cycle.stage='payout';
    });
  }
  async allocateNativeHolderRewards(id,b,l,c,override){
    // v55 saved the recipient array before changing the stage. A restart in
    // that window must reuse its durable allocation rather than reweight it.
    if(l.cycle.payouts!==undefined){nativeRewardDebtState(l);l.cycle.stage='payout';return;}
    const gotchi=gotchiLaunch(l),state=nativeRewardDebtState(l),due=override||this.now()>=holderRewardCheckDueAt(l);
    const minimum=due?(override?0n:gotchi?gotchiPayoutMinimum(l):await this.refreshHolderMinimum(l,c)):null;
    if(due)l.cycle.holderRewardChecked=true;
    const available=BigInt(l.credits.quote)-state.reserved,newAllocation=minimum!==null&&available>0n&&available>=minimum;
    let snapshot=null,distribution=null,fresh=[];
    // A Gotchi launch pays its whole available credit to the Gotchi vault; no
    // holder snapshot is taken because holders are rewarded by the race itself.
    if(newAllocation&&gotchi)fresh=gotchiPayoutRows(l,available);
    else if(newAllocation){
      snapshot=await c.holderSnapshot(l);
      distribution=weightedRewards(available,snapshot.rows,1n);
      const recipientMinimum=override?1n:referenceRewardMinimum(l.review,1n),owedOwners=new Set(state.owed.map(row=>row.owner));
      // A holder's old dust can grow with their exact new share. Unallocated
      // dust for owners without a debt retains the existing minimum policy.
      fresh=distribution.payouts.filter(row=>BigInt(row.amount)>=recipientMinimum||owedOwners.has(row.owner));
    }
    if(state.owed.length||newAllocation){
      await this.saveNativeRewardAllocation(id,b,l,()=>{
        queueNativeRewardPayouts(l,fresh);
        l.cycle.holderRewardPolicy=HOLDER_REWARD_POLICY;l.cycle.nativeRewardDebtOnly=!newAllocation;
        if(snapshot){l.cycle.slot=snapshot.slot;l.cycle.eligibleBalance=distribution.eligibleBalance;l.cycle.holderMinimumQuoteUnits=minimum.toString();}
        l.cycle.stage='payout';
      });
    }else l.cycle.stage='done';
  }
  async advanceRewardsWallet(id,b,l,c){
    if(l.input.feeMode!=='holders')return false;
    // Finish only the already-built, partly-paid recipient batch using its old
    // wallet. A migration must not discard its index or pay its first rows again.
    if(!l.rewardsWallet&&l.cycle?.stage==='payout'&&l.cycle.index>0)return false;
    if(l.operations.some(op=>['pending','awaiting_signature'].includes(op.state)))return true;
    if(!l.rewardsWallet){provisionRewardsWallet(l,this.now());await this.save(id,b);}
    const credit=rewardsCreatorCredits(l),hasCredit=Object.values(credit).some(value=>BigInt(value)>0n);
    if(l.rewardsWallet.status==='active'&&!hasCredit){if(l.rewardsWallet.gasFundingNeed){delete l.rewardsWallet.gasFundingNeed;await this.save(id,b);}return false;}
    ok(typeof c.rewardHandoffInstructions==='function'&&typeof c.rewardsGasFundingPlan==='function','The reward-wallet migration service is unavailable.');
    // Even an initialized rewards wallet can need creator-paid ATA rent for a
    // later claim. The planner separates those costs from initial gas seeding.
    const funding=await c.rewardsGasFundingPlan(l);
    if(funding.ready!==true){
      l.rewardsWallet.gasFundingNeed=rewardGasFundingNeed(l,funding,this.now());
      // The gas worker reads the encrypted launch journal. Persist its exact
      // verified minima before entering the ordinary funding retry/backoff.
      await this.save(id,b);
      throw Object.assign(Error(funding.reason||'The separate rewards wallet needs SOL before reward processing can continue.'),{code:'REWARD_SOL_REQUIRED'});
    }
    if(l.rewardsWallet.gasFundingNeed){delete l.rewardsWallet.gasFundingNeed;await this.save(id,b);}
    const plan=rewardHandoffPlan(l,funding);
    if(!hasCredit&&BigInt(plan.gasLamports)===0n){l.rewardsWallet.status='active';l.rewardsWallet.activatedAt??=this.now();l.rewardsWallet.gasInitializedAt??=this.now();await this.save(id,b);return false;}
    const instructions=await c.rewardHandoffInstructions(l,plan);ok(instructions.length>0,'The reward-wallet handoff did not produce a transaction.');
    return this.send(id,b,l,c,'reward-handoff',instructions,{operationData:{rewardHandoff:plan}});
  }
  async advanceOfficialTaxMaintenance(id,b,l,c){
    beginOfficialTaxMaintenance(l,this.now());
    selectOfficialTaxBurn(l,this.now());
    // Persist the attempt before RPC scans or simulation. Repeated worker
    // ticks/restarts cannot turn an unavailable scan into an unbounded loop.
    await this.save(id,b);
    // v71.24: without LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN the tax is only collected; it burns when the owner asks (Burn collected tax now).
    const plan=officialTaxBurnEnabled(l)?taxBurnPlan(l):{amount:'0',operationData:{}},maintenance={taxMaintenancePolicy:TAX_MAINTENANCE_POLICY};
    if(BigInt(plan.amount)===0n&&manualTaxBurnRequest(l)){delete l.taxBurnRequest;await this.save(id,b);}
    if(BigInt(plan.amount)>0n){
      const operation={kind:'tax-burn',...plan.operationData,...maintenance,amount:plan.amount,rewardsWallet:rewardsWalletSelection(l,{kind:'tax-burn'})};
      await this.send(id,b,l,c,'tax-burn',await c.burnInstructions(l,plan.amount,{kind:'tax-burn',operation}),{...plan,operationData:{...plan.operationData,...maintenance}});
    }else{
      const operation={kind:'tax',rewardsWallet:rewardsWalletSelection(l,{kind:'tax'})};
      const instructions=await c.claimInstructions(l,'tax',{operation});
      if(!instructions.length){delete l.taxMaintenance.retry;await this.save(id,b);return;}
      await this.send(id,b,l,c,'tax',instructions,{operationData:maintenance});
    }
  }
  async advanceFees(id,b,l,c){
    const manualRequest=manualHolderDistribution(l);
    if(manualRequest?.state==='blocked'){l.state='paused';l.feesRequested=false;await this.save(id,b);return;}
    l.feesRequested=true;
    if(selectOfficialTaxBurn(l,this.now()))await this.save(id,b);
    if(nativeHolderRewards(l))nativeRewardDebtState(l);
    if(await this.advanceRewardsWallet(id,b,l,c))return;
    const separateTaxMaintenance=officialTaxMaintenanceEnabled(l);
    startManualHolderCycle(l,this.now());
    if(!l.cycle)l.cycle={stage:'claim',index:0,createdAt:this.now(),manual:!!l.manualFeesRequested};
    const holder=l.input.feeMode==='holders',override=holder&&adminHolderDistribution(l),buybackOverride=l.input.feeMode==='buyback'&&adminBuyback(l);
    if(holder){
      l.lastHolderRewardCheck??=l.lastCycle||l.authorizedAt||l.createdAt||this.now();l.cycle.id??=randomBytes(16).toString('hex');
      // Recheck unsigned legacy batches. A distribution already paying holders
      // finishes its saved unpaid recipients instead of stranding a partial batch.
      if(l.cycle.stage==='payout'&&!l.cycle.index&&l.cycle.holderRewardPolicy!==(paycheckLaunch(l)?PAYCHECK_POLICY:HOLDER_REWARD_POLICY)){if(nativeHolderRewards(l))resetNativeRewardAllocation(l);else{delete l.cycle.payouts;l.cycle.stage='distribute';}}
    }
    // Already-held, explicitly approved inventory does not depend on a new
    // potentially expensive harvest. Finish saved payouts and pending receipts
    // normally; only a still-unsigned collection step may be skipped here.
    if(initialTaxBurnPending(l)&&officialTaxBurnEnabled(l)&&['claim','tax'].includes(l.cycle.stage))l.cycle.stage='route';
    const stage=l.cycle.stage;
    if(stage==='claim'||stage==='tax'){
      const minimum=stage==='claim'&&holder&&!override?await this.refreshHolderMinimum(l,c):0n;
      const instructions=minimum===null||stage==='tax'&&separateTaxMaintenance?[]:await c.claimInstructions(l,stage==='tax'?'tax':holder&&!override?'holder-auto':'creator',{operation:{kind:stage,rewardsWallet:rewardsWalletSelection(l,{kind:stage})}});
      if(await this.send(id,b,l,c,stage,instructions))return;l.cycle.stage=stage==='claim'&&l.input.taxBps?'tax':'route';
    }
    if(l.cycle.stage==='route'){
      const sweep=snapshotManualHolderBase(l,this.now(),{burnOnly:officialTaxBurnSelected(l)});
      if(sweep)await this.save(id,b);
      if(officialTaxBurnSelected(l)){
        // Burn only receipt-attributed collected tax. Mixed legacy inventory,
        // wallet deposits and ordinary base-token fee credit remain reserved.
        // Existing quote credit, owed holders and protocol proceeds continue.
        if(officialTaxBurnEnabled(l)&&!separateTaxMaintenance){
          const plan=taxBurnPlan(l);
          if(BigInt(plan.amount)>0n){
            const operation={kind:'tax-burn',...plan.operationData,amount:plan.amount,rewardsWallet:rewardsWalletSelection(l,{kind:'tax-burn'})};
            if(await this.send(id,b,l,c,'tax-burn',await c.burnInstructions(l,plan.amount,{kind:'tax-burn',operation}),plan))return;
          }
        }
      }else if(sweep){
        const source=manualHolderConversionSource(l);
        if(BigInt(source.credit)>0n){
          l.cycle.taxConversionAttempted=true;l.lastTaxConversionAt=this.now();sweep.state='processing';sweep.phase='convert';await this.save(id,b);
          try{
            if(source.operationData.taxSource)await taxProtocolTreasury(this.accounts,l);
            const plan=await c.taxConversionPlan(l,source.credit),amount=BigInt(plan.amount);
            if(plan.waiting===true)throw Object.assign(Error(plan.reason||'Reward conversion is waiting for pool liquidity.'),{code:'REWARD_MARKET_WAIT'});
            ok(amount>=0n&&amount<=TAX_CONVERSION_MAX_UNITS&&amount<=BigInt(source.credit),'Tax conversion exceeds its paced earned-token budget.');
            delete l.taxConversionNote;
            if(amount>0n){
              const instructions=await c.swapFeeInstructions(l,'sell',amount.toString(),{operation:{kind:'sell',rewardsWallet:rewardsWalletSelection(l,{kind:'sell'})}});
              ok(instructions.length>0,'The manual reward conversion did not produce an executable transaction.');
              if(await this.send(id,b,l,c,'sell',instructions,{amount:amount.toString(),operationData:source.operationData}))return;
            }
          }catch(error){
            if(error?.code!=='TAX_CONVERSION_DEFERRED')throw error;
            if(error.message!=='Tax conversion is too small after fees and will be checked again later.')throw Object.assign(Error(cleanError(error)),{code:'REWARD_MARKET_WAIT'});
          }
          sweep.reason='The remaining token amount cannot currently produce an executable guarded swap; it remains reserved.';
          if(source.operationData.taxSource&&BigInt(sweep.remainingBaseUnits)>0n){sweep.skipTaxConversion=true;l.cycle.taxConversionAttempted=false;await this.save(id,b);return;}

        }
      }else if(l.input.feeMode==='holders'&&BigInt(l.credits.base)>0n&&!l.cycle.taxConversionAttempted&&this.now()>=taxConversionDueAt(l)){
        // Automatic backlogs use the same bounded clip and receipt ledger.
        // Their retry gate remains durable even while the normal timer is waived.
        const backlog=automaticTaxBacklog(l);
        l.cycle.taxConversionAttempted=true;l.lastTaxConversionAt=this.now();await this.save(id,b);
        try{
          const source=backlog?taxBacklogSource(l,TAX_CONVERSION_BACKLOG_UNITS):taxConversionSource(l);
          const burst=backlog,policy=burst?TAX_CONVERSION_BURST_POLICY:'paced-v1';
          if(source.operationData.taxSource)await taxProtocolTreasury(this.accounts,l);
          const plan=await c.taxConversionPlan(l,burst?TAX_CONVERSION_BACKLOG_UNITS.toString():source.credit,{policy}),amount=BigInt(plan.amount);
          ok(amount>=0n&&amount<=(burst?TAX_CONVERSION_BACKLOG_UNITS:TAX_CONVERSION_MAX_UNITS)&&amount<=BigInt(source.credit),'Tax conversion exceeds its paced earned-token budget.');
          if(backlog&&(plan.waiting===true||amount===0n||burst&&amount!==TAX_CONVERSION_BACKLOG_UNITS))throw Object.assign(Error(plan.reason||(burst?'The full 10,000,000-token backlog sale is waiting for sufficient liquidity within its price-impact limit.':'The reward backlog is waiting for an executable guarded conversion.')),{code:'REWARD_MARKET_WAIT'});
          delete l.taxConversionNote;
          const operationData={...source.operationData,...(burst?{taxConversionPolicy:policy}:{})};
          if(amount>0n&&await this.send(id,b,l,c,'sell',await c.swapFeeInstructions(l,'sell',amount.toString(),{operation:{...operationData,kind:'sell',rewardsWallet:rewardsWalletSelection(l,{kind:'sell'})}}),{amount:amount.toString(),operationData}))return;
        }catch(e){
          if(backlog){
            l.cycle.taxConversionAttempted=false;
            if(e?.code==='TAX_CONVERSION_DEFERRED')throw Object.assign(Error(cleanError(e)),{code:'REWARD_MARKET_WAIT'});
            throw e;
          }
          if(e?.code!=='TAX_CONVERSION_DEFERRED')throw e;
          l.taxConversionNote=cleanError(e);
        }
      }
      l.cycle.stage='tax-protocol';
    }
    if(l.cycle.stage==='tax-protocol'){
      const credit=BigInt(taxProtocolLedger(l).creditQuote);
      if(credit>0n){
        ok(hasTransferTax(l),'Transfer-tax protocol credit belongs only to tax tokens.');
        const recipient=await taxProtocolTreasury(this.accounts,l),amount=credit.toString(),payouts=[{owner:recipient,amount}];
        if(await this.send(id,b,l,c,'tax-protocol-payout',await c.payoutInstructions(l,payouts,{operation:{kind:'tax-protocol-payout',rewardsWallet:rewardsWalletSelection(l,{kind:'tax-protocol-payout'})}}),{amount,payouts,operationData:{taxProtocolPolicy:TAX_PROTOCOL_POLICY,taxProtocolRecipient:recipient}}))return;
      }
      l.cycle.stage='distribute';
    }
    if(l.cycle.stage==='distribute'&&manualHolderCycle(l))l.manualHolderDistribution.phase='payout';
    if(l.cycle.stage==='distribute'&&paycheckLaunch(l))await this.allocatePaycheckRewards(id,b,l,c,override);
    else if(l.cycle.stage==='distribute'&&nativeHolderRewards(l))await this.allocateNativeHolderRewards(id,b,l,c,override);
    if(l.cycle.stage==='distribute'){
      if(l.input.feeMode==='holders'){
        if(!override&&this.now()<holderRewardCheckDueAt(l))l.cycle.stage='done';
        else l.cycle.holderRewardChecked=true;
      }
      const gotchi=gotchiLaunch(l);
      const credit=BigInt(l.credits.quote),minimum=buybackOverride?0n:holder?(override?0n:l.cycle.stage==='done'?null:gotchi?gotchiPayoutMinimum(l):await this.refreshHolderMinimum(l,c)):10n**BigInt(l.review.quoteDecimals)*100000000n/units(l.review.price.usd,8); // Other fee modes keep their existing batching floor.
      // A creator's SPL fees are already delivered to their own wallet.
      // Do not keep an IOU that could later spend tokens they withdrew, and do
      // not apply the managed-service $1 batching floor to explicit claims.
      if(l.input.feeMode==='creator'&&l.input.recipient===l.keys.wallet.address){
        l.credits.base='0';
        if(l.input.quoteMint!==SOL_MINT){l.credits.quote='0';l.cycle.stage='done';}
      }
      if(l.cycle.stage==='done'){}
      else if(credit===0n||minimum===null||!(buybackOverride||l.input.feeMode==='creator'&&l.cycle.manual)&&credit<minimum)l.cycle.stage=l.input.feeMode==='buyback'&&BigInt(l.credits.base)>0n?'burn':'done';
      else if(l.input.feeMode==='buyback'){await this.send(id,b,l,c,'buy',await c.swapFeeInstructions(l,'buy',credit),{amount:credit.toString()});return;}
      else {if(!l.cycle.payouts){if(l.input.feeMode==='creator')l.cycle.payouts=[{owner:l.input.recipient,amount:credit.toString()}];else if(gotchi){l.cycle.payouts=gotchiPayoutRows(l,credit);l.cycle.holderRewardPolicy=HOLDER_REWARD_POLICY;l.cycle.holderMinimumQuoteUnits=minimum.toString();}else{const snapshot=await c.holderSnapshot(l),distribution=weightedRewards(credit,snapshot.rows,override?1n:referenceRewardMinimum(l.review,1n));l.cycle.slot=snapshot.slot;l.cycle.eligibleBalance=distribution.eligibleBalance;l.cycle.payouts=distribution.payouts;l.cycle.holderRewardPolicy=HOLDER_REWARD_POLICY;l.cycle.holderMinimumQuoteUnits=minimum.toString();}await this.save(id,b);}l.cycle.stage='payout';}
    }
    if(l.cycle.stage==='payout'){
      if(l.input.feeMode==='holders'&&!l.cycle.nativeRewardDebtOnly)l.cycle.holderRewardChecked=true;
      const batch=l.cycle.payouts.slice(l.cycle.index,l.cycle.index+3);
      if(batch.length){
        const amount=batch.reduce((n,x)=>n+BigInt(x.amount),0n).toString();ok(BigInt(amount)<=BigInt(l.credits.quote),'Payout exceeds earned fee credit.');
        const operationCount=l.operations.length;
        const paycheck=paycheckLaunch(l)&&l.cycle.paycheck?.policy===PAYCHECK_POLICY?{paycheck:paycheckBatchAttribution(l.cycle.paycheck,batch)}:{};
        try{await this.send(id,b,l,c,'payout',await c.payoutInstructions(l,batch,{operation:{kind:'payout',rewardsWallet:rewardsWalletSelection(l,{kind:'payout'})}}),{amount,payouts:batch,reserve:String(1000000+batch.length*3000000),operationData:paycheck});}
        catch(error){
          if(error?.code==='REWARD_NATIVE_FUNDS'&&payoutGasSaleApplies(l)&&l.operations.length===operationCount&&!l.operations.some(op=>['pending','awaiting_signature'].includes(op.state))){await this.sellForPayoutGas(id,b,l,c,error);return;}
          if(error?.code!=='REWARD_RECIPIENT_RENT'||!nativeHolderRewards(l)||l.operations.length!==operationCount||l.operations.some(op=>['pending','awaiting_signature'].includes(op.state)))throw error;
          await this.saveNativeRewardAllocation(id,b,l,()=>deferNativeRewardPayouts(l,batch,error.payouts));
        }
        return;
      }
      l.cycle.stage='done';
    }
    if(l.cycle.stage==='burn'){if(BigInt(l.credits.base)>0n){await this.send(id,b,l,c,'burn',await c.burnInstructions(l,l.credits.base),{amount:l.credits.base});return;}l.cycle.stage='done';}
    if(l.cycle.stage==='done'&&buybackOverride&&l.cycle.restartAfterCompletion){l.cycle={stage:'claim',index:0,createdAt:this.now(),manual:true};await this.save(id,b);return this.advanceFees(id,b,l,c);}
    if(l.cycle.stage==='done'&&buybackOverride){const event=(l.adminRewardHistory||[]).find(e=>e.requestId===l.buybackAdminRequest);if(event){event.status=l.operations.slice(event.operationIndex||0).some(op=>['buy','burn'].includes(op.kind)&&op.state==='confirmed')?'completed':'no_funds';event.completedAt=this.now();}}
    if(l.cycle.stage==='done'&&manualHolderDistribution(l)&&!manualHolderCycle(l)){
      // An older allocation owns its recipient snapshot. Finish that exact
      // cycle first, then harvest once and snapshot this manual request.
      if(l.cycle.holderRewardChecked)l.lastHolderRewardCheck=this.now();
      if(BigInt(l.cycle.distributedQuoteUnits||0)>0n)l.holderRewards={...l.holderRewards,lastDistributionAt:l.cycle.lastPayoutAt,lastDistributionQuoteUnits:l.cycle.distributedQuoteUnits};
      l.lastRewardSnapshot=l.cycle.slot||l.lastRewardSnapshot;l.cycle=null;startManualHolderCycle(l,this.now());await this.save(id,b);return;
    }
    if(l.cycle.stage==='done')finishManualHolderDistribution(l,this.now());
    if(l.cycle.stage==='done'){if(l.input.feeMode==='holders'&&l.cycle.holderRewardChecked)l.lastHolderRewardCheck=this.now();if(l.input.feeMode==='holders'&&BigInt(l.cycle.distributedQuoteUnits||0)>0n){l.holderRewards={...l.holderRewards,lastDistributionAt:l.cycle.lastPayoutAt,lastDistributionQuoteUnits:l.cycle.distributedQuoteUnits};}l.lastCycle=this.now();l.lastFeeClaim={at:this.now(),result:BigInt(l.cycle.claimedQuote||0)||BigInt(l.cycle.claimedBase||0)||l.cycle.payouts?.length?'claimed':'empty',quote:l.cycle.claimedQuote||'0',base:l.cycle.claimedBase||'0',scope:l.feeCustody==='relay'?'coin':'wallet_quote'};l.lastRewardSnapshot=l.cycle.slot||l.lastRewardSnapshot;l.cycle=null;l.feesRequested=false;clearRewardRetry(l);l.error='';delete l.manualFeesRequested;delete l.forceHolderDistribution;delete l.holderDistributionAdminRequest;delete l.buybackAdminRequest;}
    await this.save(id,b);
  }
}
