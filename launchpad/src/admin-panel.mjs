import { requestFees } from './launchpad.mjs';
import { launchAdminRow, launchRewardAction, launchRewardAutomation, launchRewardPause } from './launchpad-admin.mjs';
import { setFeeAutomation } from './launchpad-reward-recovery.mjs';
import { signer } from './launchpad-receipts.mjs';
import { RATES } from './account-policy.mjs';
import { AdminHolderDistributions } from './admin-holder-distributions.mjs';
import { AdminRewardSweeps } from './admin-reward-sweeps.mjs';
import { queueManualHolderDistribution } from './launchpad-manual-distribution.mjs';
import { officialTaxBurnScope, publicTaxBurn, manualTaxBurnRequest } from './launchpad-tax-burn.mjs';
import { officialTaxMaintenanceEnabled } from './launchpad-tax-maintenance.mjs';
import { launchArchiveView, stoppedBeforeToken } from './launchpad-archive.mjs';
import { CLEANUP_DRAFT_AGE_MS } from './admin-cleanup.mjs';

const fail=(message,statusCode=400)=>{throw Object.assign(Error(message),{statusCode});};
const id=value=>{if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))fail('Choose a valid account, launch and request.');return value;};
const label=(value,max=500)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,max):'';
const safeFees=(value,settlement)=>({recipient:typeof value?.recipient==='string'?value.recipient:'',ready:value?.ready===true,copyPpm:Number.isInteger(value?.copyPpm)?value.copyPpm:RATES.copyPpm,sniperPpm:Number.isInteger(value?.sniperPpm)?value.sniperPpm:RATES.sniperPpm,marketPpm:Number.isInteger(value?.marketPpm)?value.marketPpm:RATES.marketPpm,settlement,description:label(value?.description,1800),liquidityDescription:label(value?.liquidityDescription,1800)});
const safeProtocol=value=>value?{recipient:label(value.recipient,44),configured:value.configured===true,autoHarvest:value.autoHarvest===true,harvestIntervalMinutes:Number.isFinite(value.harvestIntervalMinutes)?value.harvestIntervalMinutes:null,minimumHarvestUsd:Number.isFinite(value.minimumHarvestUsd)?value.minimumHarvestUsd:null,curveFeeBps:Number.isInteger(value.curveFeeBps)?value.curveFeeBps:null,curveFeePercent:Number.isFinite(value.curveFeePercent)?value.curveFeePercent:null,creationFeeSol:typeof value.creationFeeSol==='string'&&/^\d+(?:\.\d+)?$/.test(value.creationFeeSol)?value.creationFeeSol:null,updatedAt:Number.isFinite(value.updatedAt)?value.updatedAt:null,updatedBy:label(value.updatedBy,80),lpPolicy:label(value.lpPolicy,20),platformLpPercent:Number.isInteger(value.platformLpPercent)?value.platformLpPercent:null,existingLaunches:label(value.existingLaunches,40)}:null;

// HTTP enforces the MFA-verified session, CSRF, rate limit and fresh password /
// authenticator proof. The service independently checks current administrator
// role + MFA before reads and immediately before a queued financial action.
export class AdminPanel {
  constructor({accounts,launchpad,launchAdmin,policy,robinhoodPolicy=null,protocolFees=null,toolkit=true,now=Date.now}={}){Object.assign(this,{accounts,launchpad,launchAdmin,policy,robinhoodPolicy,protocolFees,toolkit:toolkit===true,now});this.holderDistributions=new AdminHolderDistributions({accounts,launchpad,launchAdmin,now});this.rewardSweeps=new AdminRewardSweeps({accounts,launchpad,launchAdmin,now,launchAction:(actor,input)=>this.launchAction(actor,input)});}
  readHolderDistributions(actorId){return this.holderDistributions.read(actorId);}
  distributeAllHolders(actorId,input,context){return this.holderDistributions.enqueue(actorId,input,context);}
  readRewardSweeps(actorId){return this.rewardSweeps.read(actorId);}
  distributeAllRewardSweeps(actorId,input,context){return this.rewardSweeps.enqueue(actorId,input,context);}
  start(){this.holderDistributions.start();this.rewardSweeps.start();}
  close(){return Promise.all([this.holderDistributions.close(),this.rewardSweeps.close()]);}
  async overview(actorId){
    await this.launchAdmin.requireAdmin(actorId);
    const [users,inventory,solana,robinhoodSaved,protocol]=await Promise.all([this.accounts.list(),this.launchAdmin.inventory(undefined,actorId),this.toolkit?this.policy.get(actorId):null,this.toolkit&&this.robinhoodPolicy?this.accounts.hostStore.read('robinhood-fee-policy',{}):null,this.protocolFees?.read(actorId)||null]);
    const counts={accounts:users.length,launches:inventory.launches.length,holderLaunches:0,buybackLaunches:0,creatorLaunches:0,gotchiLaunches:0,activeServices:0,pausedServices:0};
    for(const {launch} of inventory.launches){const key=launch.input?.gotchi?'gotchiLaunches':{holders:'holderLaunches',buyback:'buybackLaunches',creator:'creatorLaunches'}[launch.input?.feeMode];if(key)counts[key]++;if(launch.curve&&['holders','buyback'].includes(launch.input?.feeMode)){if(launch.state==='live'&&launch.autoFees)counts.activeServices++;else counts.pausedServices++;}}
    // Reading the dashboard must not create a Robinhood wallet. The regular
    // account-policy.get method initializes wallets, so inspect host policy only.
    const adapter=this.toolkit?this.robinhoodPolicy?.adapterAddress?.()||'':'';
    const robinhood=this.toolkit&&this.robinhoodPolicy?safeFees({...RATES,recipient:robinhoodSaved?.recipient||'',ready:!!robinhoodSaved?.recipient&&robinhoodSaved.verified===true&&!!adapter,description:'Fees settle in Robinhood ETH. Cashback is a share of the Launchpad fee collected.',liquidityDescription:'LP automatic adjustments: 0.005%, 0.015%, or 0.025% of fresh position value, by pool fee tier up to 0.05%, up to 0.30%, or higher. Initial deposits, manual withdrawals, fee claims and reinvesting earned fees have no Launchpad management fee. Network and pool swap fees still apply.'},'eth'):null;
    const attention=await this.attention(actorId,{inventory,protocol:safeProtocol(protocol),solana:this.toolkit?safeFees(solana,'sol'):null});
    await this.launchAdmin.requireAdmin(actorId);
    return {at:this.now(),counts,attention,...(this.toolkit?{fees:{solana:safeFees(solana,'sol'),robinhood}}:{}),protocolFees:safeProtocol(protocol),capabilities:{manualHolderRewards:true,manualBuyback:true,creatorFeeRouting:true,...(this.toolkit?{cashback:true,feeRecipients:true,sessionDiagnostics:true}:{}),administratorLaunch:true}};
  }
  /**
   * The "Needs you" inbox: counts of things only an operator can move along, each with the admin page that
   * handles it. Optional services (Pump.fun, the vanity pool) are read best-effort and never fail the overview.
   */
  async attention(actorId,{inventory,protocol=null,solana=null}={}){
    const items=[],add=(code,count,label,detail,hash,tone='warn')=>{if(Number(count)>0)items.push({code,count:Number(count),label,detail,hash,tone});};
    let failed=0,unfinished=0,paused=0,blocked=0;
    for(const {launch,adminRow} of inventory?.launches||[]){
      const row=adminRow,state=row?.state||launch?.state;
      if(row){if(row.route!=='pump-classic'&&['failed','error'].includes(state)&&!row.listArchived)failed++;continue;}
      if(!launch)continue;
      const view=launchArchiveView(launch);
      if(['failed','error'].includes(state)&&!view.listArchived)failed++;
      else if(state==='draft'&&!view.listArchived&&stoppedBeforeToken(launch)&&this.now()-(launch.createdAt||0)>CLEANUP_DRAFT_AGE_MS)unfinished++;
      if(launch.curve&&['holders','buyback'].includes(launch.input?.feeMode)&&!view.listArchived){
        if(launchRewardAutomation(launch,{...inventory.context(launch),ownerMatch:false}).needed)paused++;
        if(launch.manualHolderDistribution?.state==='blocked'||launch.heldSolDistribution?.state==='blocked')blocked++;
      }
    }
    let pump={refunds:0,strategiesPaused:0,payoutsBlocked:0,stuck:0,failed:0};
    try{if(typeof this.launchAdmin?.pumpClassic?.adminAttention==='function')pump={...pump,...(await this.launchAdmin.pumpClassic.adminAttention(actorId))};}catch{/* Pump.fun unavailable: no alert */}
    add('failed-launches',failed+pump.failed+pump.stuck+unfinished,'Failed or unfinished launches','Launches that stopped before finishing. Archive the settled ones or refund the rest from Cleanup.','#tokens/cleanup');
    add('refunds-waiting',pump.refunds,'Refunds waiting','Pump.fun launches whose SOL or pair refund has not settled yet.','#tokens/cleanup?kind=refund');
    add('payouts-blocked',blocked+pump.payoutsBlocked,'Blocked payouts','Holder payouts that stopped and need a decision.','#tokens/launches?filter=attention','bad');
    add('rewards-paused',paused,'Reward services paused','Coins whose automatic rewards are paused or need attention.','#tokens/launches?filter=attention');
    add('strategies-paused',pump.strategiesPaused,'Strategies paused','Pump.fun Market Maker or Liquidity Manager strategies that are paused.','#tokens/pump-fun?state=attention');
    if(protocol&&protocol.configured!==true)add('fee-recipient',1,'Protocol fee wallet not verified','Set and verify the launchpad fee recipient before collecting fees.','#revenue/fees','bad');
    if(solana&&solana.ready!==true)add('toolkit-fees',1,'Toolkit fee wallet needs setup','The trading toolkit has no verified Solana fee collection wallet.','#revenue/toolkit');
    try{
      const vanity=this.launchpad?.vanity;
      if(vanity&&typeof vanity.load==='function'&&typeof vanity.snapshot==='function'){
        const view=vanity.snapshot(await vanity.load(),{pool:{limit:1},used:{limit:1}});
        if(Array.isArray(view.low)&&view.low.length)add('vanity-low',view.low.length,'Vanity addresses running low',`Fewer than ${view.lowWater} addresses are left for ${view.low.map(v=>view.labels?.[v]||v).join(', ')} launches.`,'#tokens/vanity');
      }
    }catch{/* no pool yet, or the store is closed: nothing to report */}
    return items;
  }
  async launchAction(actorId,{accountId,id:launchId,action,reason='',requestId}={}){
    await this.launchAdmin.requireAdmin(actorId);id(accountId);id(launchId);id(requestId);
    if(action==='burn-tax')return this.burnCollectedTax(actorId,{accountId,launchId,requestId});
    if(!['distribute','buyback','resume-rewards','pause-rewards'].includes(action))fail('Choose Distribute rewards, Run buyback, Pause automatic rewards or Resume rewards.');
    if(typeof reason!=='string'||reason.length>500||reason.trim()&&reason.trim().length<5)fail('Use a reason between 5 and 500 characters.');
    const purpose=label(reason).trim()|| (action==='pause-rewards'?'Automatic rewards paused from the admin panel.':action==='resume-rewards'?'Automatic rewards resumed from the admin panel.':action==='distribute'?'Manual holder distribution requested from the admin panel.':'Manual buyback and burn requested from the admin panel.');
    const result=await this.launchpad.locked(accountId,async book=>{
      const actor=await this.launchAdmin.requireAdmin(actorId),account=await this.accounts.get(accountId);
      if(!account)fail('The launch account was not found.',404);
      const launch=this.launchpad.find(book,launchId),inventory=await this.launchAdmin.inventory({accountId,book}),context={...inventory.context(launch),ownerMatch:accountId===actorId};
      const previous=(launch.adminRewardHistory||[]).find(event=>event.requestId===requestId);
      if(previous){
        if(previous.actorId!==actorId||previous.action!==action)fail('This request ID was already used for another action.',409);
        await this.launchAdmin.requireAdmin(actorId);
        return {status:'already_requested',requestId,launch:launchAdminRow(account,launch,context),message:'This request was already recorded. Its saved transactions will continue to be reconciled.'};
      }
      if(!['pause-rewards','distribute'].includes(action)&&['queued','processing'].includes(launch.heldSolDistribution?.state))fail('A held-SOL holder distribution is in progress. Wait for its saved transactions to settle.',409);
      const eligibility=action==='pause-rewards'?launchRewardPause(launch):action==='resume-rewards'?launchRewardAutomation(launch,context):launchRewardAction(launch,context);
      if(!eligibility.allowed)fail(eligibility.reason,409);
      if(!['resume-rewards','pause-rewards'].includes(action)&&eligibility.kind!==action)fail('The reward mode changed. Refresh the launch before continuing.',409);
      let key;
      if(action!=='pause-rewards')try{key=signer(launch.keys.wallet.secret);if(key.publicKey.toBase58()!==launch.keys.wallet.address)throw Error();}catch{fail('The managed service signer is unavailable. Restore the launch data before retrying.',409);}finally{key?.secretKey.fill(0);}
      await this.launchAdmin.requireAdmin(actorId);
      // The admin API records intent only. The worker reconciles saved
      // receipts and applies earned-credit, liquidity and network-cost checks.
      const manual=launch.manualHolderDistribution;
      if(action==='distribute'&&['queued','processing','waiting','blocked'].includes(manual?.state)){
        if(manual.state==='blocked')queueManualHolderDistribution(launch,manual.requestId,this.now());
        // Remember the retry identity as well, so a lost response cannot create
        // another sweep after the original request finishes.
        launch.adminRewardHistory=[...(launch.adminRewardHistory||[]),{at:this.now(),actorId,actor:actor.username,accountId,launchId,requestId,action,reason:purpose,status:'already_requested',coalescedRequestId:manual.requestId}];
        await this.launchpad.save(accountId,book);
        return {status:'already_requested',requestId:manual.requestId,launch:launchAdminRow(account,launch,context),message:'This coin already has a saved sell-and-distribute request. It will continue from its saved step after pending transactions settle.'};
      }
      if(action==='pause-rewards'){
        // Persist a deliberate opt-out. The worker still reconciles saved
        // signatures, and any unsent held-SOL allocations remain exact debts.
        setFeeAutomation(launch,false,this.now(),'admin');launch.feesRequested=false;
        if(['queued','processing'].includes(launch.heldSolDistribution?.state))launch.heldSolDistribution.cancelRequested=true;
        if(['queued','processing','waiting','blocked'].includes(manual?.state)){manual.state='blocked';manual.pausedByAdmin=true;manual.reason='Paused by administrator. Use Distribute now to continue this saved request.';}
        // Never replace an accounting/integrity error with a resumable message.
        if(!launch.error)launch.error='Fee service paused. Pending receipts will still be reconciled.';
      }else if(action==='resume-rewards'){
        // Restore automation without turning this into a threshold-bypassing
        // manual distribution. Keep every signed byte, credit, payout index,
        // gas reservation and tax cooldown for the existing worker to verify.
        setFeeAutomation(launch,true,this.now(),'admin');delete launch.retry;
        launch.state=launch.operations.some(op=>op.state==='awaiting_signature')?'awaiting_signature':'live';
        launch.feesRequested=true;launch.error='';
      }else if(action!=='distribute')requestFees(launch);
      if(action==='distribute')launch.holderDistributionAdminRequest=requestId;
      if(action==='buyback'){launch.buybackAdminRequest=requestId;if(launch.cycle)launch.cycle.restartAfterCompletion=true;}
      const event={at:this.now(),actorId,actor:actor.username,accountId,launchId,requestId,action,...(action==='buyback'?{operationIndex:launch.operations.length}:{}),reason:purpose,status:action==='pause-rewards'?'paused':action==='resume-rewards'?'resumed':eligibility.busy?'processing':'queued'};
      launch.adminRewardHistory=[...(launch.adminRewardHistory||[]),event];
      if(action==='distribute')queueManualHolderDistribution(launch,requestId,this.now());
      await this.launchpad.save(accountId,book);
      return {status:event.status,requestId,launch:launchAdminRow(account,launch,context),message:action==='pause-rewards'?'Automatic rewards paused. Already signed transactions will still be checked; unsent rewards and balances remain reserved.':action==='resume-rewards'?'Automatic rewards enabled. Any saved transaction is checked first; distribution minimums, tax-sale limits and network-cost limits remain in effect.':action==='distribute'?'Sell-and-distribute request saved. Pending work finishes first, then eligible reward tokens convert into the quote asset in successive guarded clips and available rewards distribute without the automatic minimum. Configured tax burns, owed rewards and gas reserves remain protected.':'Buyback and burn requested. Only this launch’s earned fee credit can be used.'};
    });
    this.launchpad.known.add(accountId);this.launchpad.kick(accountId);
    return result;
  }
  /**
   * v71.24: the official LAUNCHPAD launch keeps its collected transfer tax unless the
   * server opts in to automatic burns. This records the owner's one-time request
   * to burn all of it; the worker burns it with its next tax check (about a
   * minute) after any saved transaction settles, with the usual receipt checks.
   */
  async burnCollectedTax(actorId,{accountId,launchId,requestId}){
    const result=await this.launchpad.locked(accountId,async book=>{
      const actor=await this.launchAdmin.requireAdmin(actorId),account=await this.accounts.get(accountId);
      if(!account)fail('The launch account was not found.',404);
      const launch=this.launchpad.find(book,launchId),inventory=await this.launchAdmin.inventory({accountId,book}),context={...inventory.context(launch),ownerMatch:accountId===actorId};
      const previous=(launch.adminRewardHistory||[]).find(event=>event.requestId===requestId);
      if(previous){if(previous.actorId!==actorId||previous.action!=='burn-tax')fail('This request ID was already used for another action.',409);return {status:'already_requested',requestId,launch:launchAdminRow(account,launch,context),message:'This burn request was already recorded.'};}
      let tax=null;try{tax=officialTaxBurnScope(launch)?publicTaxBurn(launch):null;}catch{tax=null;}
      if(!tax?.selected)fail('Only the official LAUNCHPAD launch keeps collected tax for burning.',409);
      if(!tax.enabled)fail('Collected-tax burning is switched off on this server (LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED).',409);
      if(tax.automatic)fail('Collected tax already burns automatically on this server.',409);
      if(tax.paused)fail('Tax burns are paused by the initial-inventory approval on this server (LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED). Nothing can be burned until it is enabled.',409);
      if(manualTaxBurnRequest(launch))fail('A burn of the collected tax is already requested. It runs with the next tax check.',409);
      if(!(BigInt(tax.pendingTaxBase||'0')>0n||tax.initialInventory?.status==='authorized'))fail('There is no collected tax to burn yet.',409);
      if(!officialTaxMaintenanceEnabled(launch))fail('The burn runs with this coin’s automatic tax checks. Resume its rewards (and let any wallet handoff finish) first.',409);
      launch.taxBurnRequest={version:1,requestId,actorId,at:this.now()};
      launch.adminRewardHistory=[...(launch.adminRewardHistory||[]),{at:this.now(),actorId,actor:actor.username,accountId,launchId,requestId,action:'burn-tax',reason:'Burn the collected transfer tax from the admin panel.',status:'queued'}];
      await this.launchpad.save(accountId,book);
      return {status:'queued',requestId,launch:launchAdminRow(account,launch,context),message:'Burn request saved. Launchpad burns the collected tax from the rewards wallet with its next tax check, after any saved transaction settles.'};
    });
    this.launchpad.known.add(accountId);this.launchpad.kick(accountId);
    return result;
  }
}
