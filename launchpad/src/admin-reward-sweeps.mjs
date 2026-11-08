import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {acquireProcessLock} from './process-lock.mjs';
import {isCurrentLaunch} from '../public/launchpad-model.mjs';
import {quoteLabel} from '../public/quote-identity.mjs';
import {rewardInventoryRecoveryDueAt} from './launchpad-inventory-recovery.mjs';

const NAME='admin-reward-sweeps',ID=/^[a-f0-9]{32}$/;
const ACTIVE=new Set(['queued','running']),PENDING=new Set(['queued','waiting','processing']);
const STATES=['queued','waiting','processing','completed','partial','blocked','failed','skipped'];
const MANUAL_ACTIVE=new Set(['queued','processing','waiting','blocked']);
const fail=(message,statusCode=409)=>{throw Object.assign(Error(message),{statusCode});};
const clean=(value,max=500)=>typeof value==='string'?value.replace(/(?:https?|wss?):\/\/\S+/gi,'[provider]').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,max):'';
const raw=value=>typeof value==='string'&&/^(?:0|[1-9]\d{0,29})$/.test(value)?value:null;
const childId=(parent,account,launch)=>createHash('sha256').update(`${NAME}:${parent}:${account}:${launch}`).digest('hex').slice(0,32);
const counts=items=>Object.fromEntries(STATES.map(state=>[state,items.filter(item=>item.state===state).length]));
const fields=['remainingBaseUnits','remainingQuoteUnits','distributedQuoteUnits'];
const itemView=item=>({accountId:item.accountId,launchId:item.launchId,mint:item.mint,name:item.name,symbol:item.symbol,route:item.route,quoteMint:item.quoteMint,quoteSymbol:item.quoteSymbol,quoteDecimals:item.quoteDecimals,
  state:item.state,stage:clean(item.stage,24),reason:clean(item.reason),manualRequestId:item.manualRequestId||null,
  ...Object.fromEntries(fields.map(key=>[key,raw(item[key])])),nextCheckAt:item.nextCheckAt||null});
const view=job=>job?{requestId:job.requestId,state:job.state,createdAt:job.createdAt,updatedAt:job.updatedAt,reason:clean(job.reason),discovered:job.discovered===true,scannedLaunches:job.scannedLaunches||0,counts:counts(job.items),items:job.items.map(itemView)}:null;
const scopeReason=l=>!isCurrentLaunch(l?.input)?'This route does not support a managed sell-and-distribute sweep.':
  !l.curve||!Number.isSafeInteger(l.authorizedAt)||l.authorizedAt<=0||!['live','paused','error','pending','awaiting_signature'].includes(l.state)?'This launch is not verified live for reward processing.':'';

function balances(l,request){
  const tax=raw(request?.remainingTaxBaseUnits),base=raw(request?.remainingBaseUnits);
  // LAUNCHPAD's configured burn policy deliberately excludes base from the sell
  // snapshot. Show its current remaining earned credit, never the zero sell
  // budget or an old pre-burn snapshot as the wallet's remaining balance.
  const remainingBaseUnits=raw(request?.reservedForBurnBaseUnits)!==null?raw(l.credits?.base):tax!==null&&base!==null?(BigInt(tax)+BigInt(base)).toString():raw(l.credits?.base);
  const terminal=request&&!MANUAL_ACTIVE.has(request.state);
  const distributed=raw(request?.distributedQuoteUnits)??(request?.requestId&&request.requestId===l.cycle?.manualHolderDistributionRequest?raw(l.cycle.distributedQuoteUnits):null);
  return {remainingBaseUnits,remainingQuoteUnits:terminal?raw(request.remainingQuoteUnits):raw(l.credits?.quote),distributedQuoteUnits:distributed};
}

// This separate durable parent queues only the existing audited per-coin
// manual action. It has no signer, exchange, ledger-reset or payout logic.
export class AdminRewardSweeps {
  constructor({accounts,launchpad,launchAdmin,launchAction,now=Date.now,intervalMs=2000,batchSize=4,maxTargets=10000,maxRequests=10000}={}){
    Object.assign(this,{accounts,launchpad,launchAdmin,launchAction,now,intervalMs,batchSize,maxTargets,maxRequests});this.closed=false;this.running=null;this.timer=null;
  }
  async locked(fn){const release=await acquireProcessLock(join(this.accounts.dir,`${NAME}.lock`));try{return await fn();}finally{await release();}}
  async index(){const value=await this.accounts.hostStore.read(NAME,null);if(value===null)return{version:1,latest:null,requests:{}};
    if(value.version!==1||!value.requests||typeof value.requests!=='object'||Array.isArray(value.requests)||value.latest!==null&&!ID.test(value.latest))fail('Saved reward sweep index needs operator review.');return value;}
  async job(id){if(!ID.test(id))fail('Saved reward sweep identity is invalid.');const job=await this.accounts.hostStore.read(`${NAME}-${id}`,null);
    if(!job||job.version!==1||job.requestId!==id||!ID.test(job.actorId)||!Array.isArray(job.items)||!['queued','running','completed','blocked'].includes(job.state)||job.items.some(row=>!STATES.includes(row.state)))fail('Saved reward sweep journal needs operator review.');return job;}
  async write(name,value){await this.accounts.hostStore.write(name,value);if(this.accounts.hostStore.dir){const dir=await open(this.accounts.hostStore.dir,'r');try{await dir.sync();}finally{await dir.close();}}}
  async save(job){job.updatedAt=this.now();await this.write(`${NAME}-${job.requestId}`,job);}
  async read(actorId){await this.launchAdmin.requireAdmin(actorId);const index=await this.index(),job=index.latest?await this.job(index.latest):null;await this.launchAdmin.requireAdmin(actorId);return{job:view(job)};}
  async enqueue(actorId,{requestId}={},context={}){
    await this.launchAdmin.requireAdmin(actorId);if(!ID.test(requestId||''))fail('Choose a valid reward sweep request ID.',400);
    const result=await this.locked(async()=>{
      await context.authorize?.();await this.launchAdmin.requireAdmin(actorId);const index=await this.index(),prior=index.requests[requestId];
      if(prior){if(prior.actorId!==actorId)fail('This request ID belongs to another administrator.');return{job:view(await this.job(prior.jobId)),alreadyRequested:true};}
      if(Object.keys(index.requests).length>=this.maxRequests)fail('The reward sweep request journal is full. No retained requests were discarded.');
      const current=index.latest?await this.job(index.latest):null;
      if(current&&ACTIVE.has(current.state)){
        index.requests[requestId]={actorId,jobId:current.requestId};await context.authorize?.();await this.launchAdmin.requireAdmin(actorId);await this.write(NAME,index);
        return{job:view(current),alreadyRequested:true};
      }
      const job={version:1,requestId,actorId,state:'queued',createdAt:this.now(),updatedAt:this.now(),discovered:false,scannedLaunches:0,cursor:0,items:[],reason:''};
      await context.authorize?.();await this.launchAdmin.requireAdmin(actorId);await this.save(job);
      await context.authorize?.();await this.launchAdmin.requireAdmin(actorId);index.latest=requestId;index.requests[requestId]={actorId,jobId:requestId};await this.write(NAME,index);
      return{job:view(job),alreadyRequested:false};
    });this.kick();return result;
  }
  async change(id,fn){return this.locked(async()=>{const job=await this.job(id);if(!ACTIVE.has(job.state))return job;await fn(job);await this.save(job);return job;});}
  async discover(job){
    let inventory;
    try{await this.launchAdmin.requireAdmin(job.actorId);inventory=await this.launchAdmin.inventory(undefined,job.actorId);await this.launchAdmin.requireAdmin(job.actorId);if(!Array.isArray(inventory?.launches))throw Error();}
    catch{await this.change(job.requestId,current=>{current.state='blocked';current.reason='Launch inventory or administrator authorization is unavailable. Nothing was queued.';});return;}
    const items=[],seen=new Set();let invalid=false;
    for(const {account,launch:l} of inventory.launches){
      if(l?.input?.feeMode!=='holders')continue;
      const accountId=account?.id,launchId=l.id,route=l.input.route||'';
      if(!ID.test(accountId||'')||route==='raydium'&&!ID.test(launchId||'')){invalid=true;break;}
      const identity=`${route}:${accountId}:${launchId}`;if(seen.has(identity))continue;seen.add(identity);
      // Pump.fun Holders coins (v71.24) are paid by the Pump.fun service in their pair asset; any live one is queued.
      const reason=route==='pump-classic'?(l.state==='created'?'':'This coin is not live.'):scopeReason(l),quoteDecimals=Number.isInteger(l.review?.quoteDecimals)&&l.review.quoteDecimals>=0&&l.review.quoteDecimals<=18?l.review.quoteDecimals:null;
      items.push({accountId,launchId:clean(launchId,80),mint:clean(l.keys?.mint?.address,44),name:clean(l.input.name,80),symbol:clean(l.input.symbol,32),route:clean(route,24),quoteMint:clean(l.input.quoteMint,44),quoteSymbol:quoteLabel(l.input.quoteMint,l.review?.quoteSymbol,l.input.quoteSymbol),quoteDecimals,
        requestId:childId(job.requestId,accountId,identity),attempted:false,state:reason?'skipped':'queued',reason,stage:clean(l.cycle?.stage,24),...balances(l)});
    }
    await this.change(job.requestId,current=>{
      current.scannedLaunches=inventory.launches.length;
      if(invalid||items.length>this.maxTargets){current.state='blocked';current.reason=invalid?'Launch inventory contains an invalid identity. Nothing was queued.':`Inventory exceeds ${this.maxTargets} holder launches. Nothing was queued; the inventory was not truncated.`;return;}
      current.items=items;current.discovered=true;current.state=items.some(item=>PENDING.has(item.state))?'running':'completed';
      if(!items.length)current.reason='No holder-reward launches were found.';
    });
  }
  async launch(item){const book=await this.launchpad.book(item.accountId);if(!Array.isArray(book?.launches))throw Error('Launch journal is unavailable.');const l=book.launches.find(row=>row.id===item.launchId);
    if(!l)return null;if(l.keys?.mint?.address!==item.mint)fail('The saved launch mint changed. Review this sweep.');return l;}
  recoverable(l){return Number.isFinite(rewardInventoryRecoveryDueAt(l,this.now()));}
  waitingInventory(item,l){
    const since=Number.isSafeInteger(item.inventoryWaitStartedAt)?item.inventoryWaitStartedAt:this.now();
    return{state:this.now()-since<120000?'waiting':'blocked',reason:clean(l.error),inventoryWaitStartedAt:since,...balances(l),stage:clean(l.cycle?.stage,24)};
  }
  savedStatus(item,l){
    const event=(l.adminRewardHistory||[]).find(row=>row.requestId===item.requestId&&row.action==='distribute');
    const requestId=item.manualRequestId||event?.coalescedRequestId||event?.requestId;
    if(!requestId)return null;
    const request=l.manualHolderDistribution;
    if(!request||request.requestId!==requestId)return{state:'blocked',manualRequestId:requestId,reason:'The saved sweep result is no longer retained. Review this coin’s request history; no replacement sweep was created.',...balances(l)};
    let state=request.state,reason=clean(request.reason||l.error);
    const data={manualRequestId:requestId,...balances(l,request),stage:clean(l.cycle?.stage||request.phase,24)};
    if(state==='blocked')return this.recoverable(l)&&!request.pausedByAdmin?{...data,...this.waitingInventory(item,l)}:{...data,state:'blocked',reason:clean(l.error||request.reason)||'This saved sweep needs review.'};
    if(state==='completed'&&(BigInt(raw(data.remainingBaseUnits)||'0')>0n||BigInt(raw(data.remainingQuoteUnits)||'0')>0n))state='partial';
    if(state==='partial'&&raw(request.reservedForBurnBaseUnits)!==null&&BigInt(raw(data.remainingBaseUnits)||'0')>0n)reason='Base rewards remain reserved under the configured LAUNCHPAD tax-burn policy; this sweep did not sell them. '+reason;
    if(state==='no_funds')state='completed';
    if(state==='cancelled')state='blocked';
    if(!STATES.includes(state))return{...data,state:'blocked',reason:'The saved sweep state needs review.'};
    const pending=(l.operations||[]).find(op=>['pending','awaiting_signature'].includes(op.state));
    if(PENDING.has(state)&&pending)reason=pending.state==='awaiting_signature'?'Waiting for the saved wallet signature.':'Checking the saved transaction before any new reward work.';
    if(state==='partial'&&!reason)reason='Some earned rewards remain reserved; no balances were cleared.';
    return{...data,state,reason};
  }
  /** A Pump.fun Holders coin: the Pump.fun service records the payout (collect, sell only for account costs, pay in the pair asset) and reports it. */
  async pumpClassicResult(job,item){
    const service=this.launchAdmin?.pumpClassic,input={launchId:item.launchId,mint:item.mint,requestId:item.requestId};
    if(typeof service?.queueRewardSweep!=='function'||typeof service?.rewardSweepStatus!=='function')return{state:'skipped',reason:'Pump.fun holder payouts are unavailable on this host.'};
    let result=item.attempted?await service.rewardSweepStatus(input):null;
    if(!result||result.state==='missing'){
      try{await this.launchAdmin.requireAdmin(job.actorId);}catch{return{state:'skipped',reason:'Administrator authorization was revoked before this sweep was queued.'};}
      await this.change(job.requestId,current=>{const saved=current.items.find(row=>row.requestId===item.requestId);saved.attempted=true;saved.state='processing';saved.reason='Recording this coin’s holder payout.';});
      result=await service.queueRewardSweep(job.actorId,input);
    }
    return result&&STATES.includes(result.state)?result:{state:'waiting',reason:'Waiting to reconcile this coin’s saved holder payout. No replacement request was created.'};
  }
  async processItem(job,item){
    let result,l;
    if(item.route==='pump-classic'){
      try{result=await this.pumpClassicResult(job,item);}catch(error){result=error?.statusCode===409?{state:'blocked',reason:clean(error.message)}:{state:'waiting',reason:'The Pump.fun payout service is busy. This coin is checked again shortly; no replacement request was created.'};}
      await this.change(job.requestId,current=>{
        const saved=current.items.find(row=>row.requestId===item.requestId);saved.state=result.state;saved.reason=clean(result.reason);
        for(const key of [...fields,'stage'])if(result[key]!==undefined)saved[key]=result[key];
        if(PENDING.has(result.state))saved.nextCheckAt=this.now()+15000;else delete saved.nextCheckAt;
      });
      return;
    }
    try{
      l=await this.launch(item);
      if(!l)result={state:'skipped',reason:'The launch no longer exists.'};
      else result=this.savedStatus(item,l);
      if(!result){
        try{await this.launchAdmin.requireAdmin(job.actorId);}catch{result={state:'skipped',reason:'Administrator authorization was revoked before this sweep was queued.',...balances(l)};}
      }
      if(!result&&this.recoverable(l))result=this.waitingInventory(item,l);
      if(!result){
        const scope=scopeReason(l);if(scope)result={state:'skipped',reason:scope,...balances(l)};
      }
      if(!result){
        await this.change(job.requestId,current=>{const saved=current.items.find(row=>row.requestId===item.requestId);saved.attempted=true;saved.state='processing';saved.reason='Recording this coin’s sell-and-distribute request.';});
        // Recheck immediately before the existing action's own custody and
        // authorization checks. The deterministic request ID survives a crash.
        try{await this.launchAdmin.requireAdmin(job.actorId);}catch{result={state:'skipped',reason:'Administrator authorization was revoked before this sweep was queued.',...balances(l)};}
        try{if(!result)await this.launchAction(job.actorId,{accountId:item.accountId,id:item.launchId,action:'distribute',requestId:item.requestId,reason:'Sell and distribute all available holder rewards from the administrator bulk sweep.'});}
        catch(error){
          l=await this.launch(item);result=l?this.savedStatus(item,l):null;
          if(!result)result=l&&this.recoverable(l)?this.waitingInventory(item,l):{state:'blocked',reason:clean(l?.error||error?.message)||'The reward request needs review.',...balances(l||{})};
        }
        if(!result){l=await this.launch(item);result=l?this.savedStatus(item,l):null;if(!result)result={state:'waiting',reason:'Checking the durable manual request before retrying the same identity.',...balances(l||{})};}
      }
    }catch(error){result=error?.statusCode===409?{state:'blocked',reason:clean(error.message)}:{state:'waiting',reason:'The saved reward journal is temporarily unavailable. No replacement request was created.'};}
    await this.change(job.requestId,current=>{
      const saved=current.items.find(row=>row.requestId===item.requestId);saved.state=result.state;saved.reason=clean(result.reason);
      for(const key of [...fields,'stage','manualRequestId','inventoryWaitStartedAt'])if(result[key]!==undefined)saved[key]=result[key];
      if(PENDING.has(result.state))saved.nextCheckAt=this.now()+15000;else delete saved.nextCheckAt;
    });
  }
  async process(){
    if(this.closed||!this.accounts.hostStore)return;const release=await acquireProcessLock(join(this.accounts.dir,`${NAME}-worker.lock`),0);
    try{
      const index=await this.index();if(!index.latest)return;const job=await this.job(index.latest);if(!ACTIVE.has(job.state))return;
      if(!job.discovered){await this.discover(job);return;}
      const selected=[];for(let n=0;n<job.items.length&&selected.length<this.batchSize;n++){const index=(job.cursor+n)%job.items.length,item=job.items[index];if(PENDING.has(item.state)&&!(item.nextCheckAt>this.now()))selected.push({index,item});}
      for(const {index,item}of selected){if(this.closed)break;await this.processItem(job,item);await this.change(job.requestId,current=>{current.cursor=(index+1)%current.items.length;});}
      await this.change(job.requestId,current=>{if(current.items.every(item=>!PENDING.has(item.state))){current.state='completed';current.reason=current.items.some(item=>['failed','blocked','partial'].includes(item.state))?'Sweep finished with reserved balances or blocked coins. Review each coin’s exact result.':'All available sweep results are recorded. Assets are reported separately; no balances were reset.';}});
    }finally{await release();}
  }
  kick(){if(this.closed||this.running||!this.accounts.hostStore)return this.running;this.running=Promise.resolve().then(()=>this.process()).catch(()=>{}).finally(()=>{this.running=null;});return this.running;}
  start(){if(this.closed||this.timer||!this.accounts.hostStore)return;this.timer=setInterval(()=>this.kick(),this.intervalMs);this.timer.unref?.();this.kick();}
  async close(){this.closed=true;clearInterval(this.timer);this.timer=null;await this.running;}
}
