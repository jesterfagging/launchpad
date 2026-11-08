import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireProcessLock } from './process-lock.mjs';
import { heldSolScopeReason } from './launchpad-held-sol.mjs';
import { SOL_MINT } from '../public/launchpad-model.mjs';

const NAME='admin-holder-distributions';
const ACTIVE=new Set(['queued','running']);
const CHILD=new Set(['queued','waiting','processing','completed','skipped','failed']);
const PENDING=new Set(['queued','waiting','processing']);
const ID=/^[a-f0-9]{32}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=(message,statusCode=409)=>{throw Object.assign(Error(message),{statusCode});};
const text=(value,max=240)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,max):'';
const raw=value=>typeof value==='string'&&/^\d{1,30}$/.test(value)?value:undefined;
const childId=(parent,account,launch)=>createHash('sha256').update(`${parent}:${account}:${launch}`).digest('hex').slice(0,32);
const counts=items=>{const out={queued:0,waiting:0,processing:0,completed:0,skipped:0,failed:0};for(const item of items)out[item.state]++;return out;};
const itemView=item=>({accountId:item.accountId,launchId:item.launchId,mint:item.mint,name:item.name,symbol:item.symbol,route:item.route,state:item.state,reason:text(item.reason),...Object.fromEntries(['amountLamports','paidLamports','deferredLamports','remainingLamports'].filter(key=>raw(item[key])!==undefined).map(key=>[key,item[key]]))});
const view=job=>job?{requestId:job.requestId,state:job.state,createdAt:job.createdAt,updatedAt:job.updatedAt,reason:text(job.reason),discovered:job.discovered===true,scannedLaunches:job.scannedLaunches||0,excludedCount:job.excludedCount||0,excludedReasons:(job.excludedReasons||[]).map(row=>({reason:text(row.reason),count:row.count})),counts:counts(job.items),items:job.items.map(itemView)}:null;

const PUMP_CLASSIC_ID=/^[a-f0-9]{24}$/;
function inventoryExclusion(launch,route){
  // Pump.fun Holders coins (v71.24): SOL-paired coins pay SOL here; a coin on another pair pays in its pair asset through Sell & distribute all.
  if(route==='pump-classic')return launch.state!=='created'?'The launch is not ready for a holder payout.':launch.input?.quoteMint!==SOL_MINT?'The reward asset is not SOL.':'';
  if(!['raydium','meteora'].includes(route))return 'This launch route does not support SOL holder distribution.';
  if(launch.input?.quoteMint!==SOL_MINT)return 'The reward asset is not SOL.';
  if(route==='raydium'){
    const scope=heldSolScopeReason(launch);if(scope)return scope;
    const busy=launch.cycle||launch.feesRequested||(launch.operations||[]).some(op=>['pending','awaiting_signature'].includes(op.state));
    if(!busy&&raw(launch.credits?.quote)!==undefined&&BigInt(launch.credits.quote)===0n)return 'No confirmed SOL reward credit is available.';
  }else if(launch.heldSolInventory){
    if(!launch.heldSolInventory.live)return 'The launch is not ready for a holder payout.';
    if(!launch.heldSolInventory.busy&&raw(launch.heldSolInventory.credit)!==undefined&&BigInt(launch.heldSolInventory.credit)===0n)return 'No confirmed SOL reward credit is available.';
  }
  return '';
}

// The parent records intent only. Existing route workers own signer access,
// current custody checks, earned SOL credits, gas limits and receipt journals.
// Worker and journal locks are separate so slow inventory/RPC never blocks HTTP.
export class AdminHolderDistributions {
  constructor({accounts,launchpad,launchAdmin,now=Date.now,intervalMs=2000,batchSize=4,maxTargets=10000,maxRequests=10000}={}) {
    Object.assign(this,{accounts,launchpad,launchAdmin,now,intervalMs,batchSize,maxTargets,maxRequests});
    this.closed=false;this.running=null;this.timer=null;
  }
  async locked(fn){const release=await acquireProcessLock(join(this.accounts.dir,`${NAME}.lock`));try{return await fn();}finally{await release();}}
  async index(){const state=await this.accounts.hostStore.read(NAME,null);if(state===null)return {version:1,latest:null,requests:{}};if(state.version!==1||!state.requests||typeof state.requests!=='object'||Array.isArray(state.requests)||state.latest!==null&&!ID.test(state.latest))fail('Saved holder distribution queue needs operator review.');return state;}
  async job(id){if(!ID.test(id))fail('Saved holder distribution ID is invalid.');const job=await this.accounts.hostStore.read(`${NAME}-${id}`,null);if(!job||job.version!==1||job.requestId!==id||!Array.isArray(job.items)||!['queued','running','completed','blocked'].includes(job.state)||job.items.some(item=>!CHILD.has(item.state)))fail('Saved holder distribution job needs operator review.');return job;}
  async write(name,value){await this.accounts.hostStore.write(name,value);if(this.accounts.hostStore.dir){const dir=await open(this.accounts.hostStore.dir,'r');try{await dir.sync();}finally{await dir.close();}}}
  async save(job){job.updatedAt=this.now();await this.write(`${NAME}-${job.requestId}`,job);}
  async read(actorId){await this.launchAdmin.requireAdmin(actorId);const state=await this.index(),job=state.latest?await this.job(state.latest):null;await this.launchAdmin.requireAdmin(actorId);return {job:view(job)};}
  async enqueue(actorId,{requestId}={},context={}){
    await this.launchAdmin.requireAdmin(actorId);
    if(typeof requestId!=='string'||!ID.test(requestId))fail('Choose a valid distribution request ID.',400);
    const result=await this.locked(async()=>{
      await this.launchAdmin.requireAdmin(actorId);await context.authorize?.();
      const state=await this.index(),previous=state.requests[requestId];
      if(previous){if(previous.actorId!==actorId)fail('This request ID belongs to another administrator.');return {job:view(await this.job(previous.jobId)),alreadyRequested:true};}
      if(Object.keys(state.requests).length>=this.maxRequests)fail('The distribution request journal is full. Operator maintenance is required; no requests were discarded.');
      const current=state.latest?await this.job(state.latest):null;
      if(current&&ACTIVE.has(current.state)){
        state.requests[requestId]={actorId,jobId:current.requestId};
        await context.authorize?.();await this.launchAdmin.requireAdmin(actorId);await this.write(NAME,state);
        return {job:view(current),alreadyRequested:true};
      }
      // Save the recoverable job before making it discoverable. A crash between
      // these writes leaves no child requests and the same POST safely resumes.
      const job={version:1,requestId,actorId,state:'queued',createdAt:this.now(),updatedAt:this.now(),discovered:false,scannedLaunches:0,items:[],cursor:0,reason:''};
      await context.authorize?.();await this.launchAdmin.requireAdmin(actorId);await this.save(job);
      await context.authorize?.();await this.launchAdmin.requireAdmin(actorId);
      state.latest=requestId;state.requests[requestId]={actorId,jobId:requestId};await this.write(NAME,state);
      return {job:view(job),alreadyRequested:false};
    });
    this.kick();return result;
  }
  service(item){return item.route==='raydium'?this.launchpad:item.route==='meteora'?this.launchAdmin.meteora:item.route==='pump-classic'?this.launchAdmin.pumpClassic:null;}
  async change(id,fn){return this.locked(async()=>{const job=await this.job(id);if(!ACTIVE.has(job.state))return job;await fn(job);await this.save(job);return job;});}
  async discover(job){
    let inventory;
    try{await this.launchAdmin.requireAdmin(job.actorId);inventory=await this.launchAdmin.inventory(undefined,job.actorId);await this.launchAdmin.requireAdmin(job.actorId);}
    catch{await this.change(job.requestId,current=>{current.state='blocked';current.reason='Launch inventory or administrator authorization is unavailable. Nothing was queued.';});return;}
    const targets=[],seen=new Set(),excluded=new Map();let invalid=false;
    for(const {account,launch} of inventory.launches){
      if(launch.input?.feeMode!=='holders')continue;
      const accountId=account?.id,launchId=launch.id,route=launch.input?.route||'raydium';
      if(!ID.test(accountId)||!(route==='meteora'?UUID.test(launchId):route==='pump-classic'?PUMP_CLASSIC_ID.test(launchId):ID.test(launchId))){invalid=true;break;}
      const key=`${route}:${accountId}:${launchId}`;if(seen.has(key))continue;seen.add(key);
      const exclusion=inventoryExclusion(launch,route);if(exclusion){excluded.set(exclusion,(excluded.get(exclusion)||0)+1);continue;}
      const supported=['raydium','meteora','pump-classic'].includes(route);
      const custody=route==='raydium'?inventory.context?.(launch):null;
      const unsafeScope=!!(custody?.shared||custody?.mainWallet||launch.walletExportedAt||launch.feeWalletExportedAt||launch.keys?.wallet?.exportedAt);
      targets.push({accountId,launchId,mint:text(launch.keys?.mint?.address,44),name:text(launch.input?.name,80),symbol:text(launch.input?.symbol,32),route:text(route,24),requestId:childId(job.requestId,accountId,`${route}:${launchId}`),attempted:false,state:supported&&!unsafeScope?'queued':'skipped',reason:!supported?'This launch route does not support held-SOL distribution.':unsafeScope?'Shared, personal or exported service custody requires individual review.':''});
    }
    await this.change(job.requestId,current=>{
      current.scannedLaunches=inventory.launches.length;
      if(invalid||targets.length>this.maxTargets){current.state='blocked';current.reason=invalid?'Launch inventory contains an invalid identity. Nothing was queued.':`The inventory exceeds ${this.maxTargets} holder launches. Nothing was queued; the inventory was not truncated.`;return;}
      current.excludedReasons=[...excluded].map(([reason,count])=>({reason,count}));current.excludedCount=current.excludedReasons.reduce((sum,row)=>sum+row.count,0);
      current.items=targets;current.discovered=true;current.state=targets.some(item=>item.state==='queued')?'running':'completed';
      if(!targets.length)current.reason='No eligible SOL holder rewards are available for this run.';
    });
  }
  async processItem(job,item){
    const service=this.service(item),input={accountId:item.accountId,id:item.launchId,mint:item.mint,requestId:item.requestId};
    let result;
    if(!service?.queueHeldSolDistribution||!service?.heldSolDistributionStatus)result=item.attempted?{state:'processing',reason:'Waiting for the launch service to reconcile its saved distribution.'}:{state:'skipped',reason:'This launch route is unavailable for held-SOL distribution.'};
    else try{
      // Persist BEFORE asking the worker. On uncertain outcome, inspect its
      // durable child journal and retry only this exact deterministic ID.
      if(item.attempted)result=await service.heldSolDistributionStatus(input);
      if(!result||result.state==='missing'){
        try{await this.launchAdmin.requireAdmin(job.actorId);}catch{result={state:'skipped',reason:'Administrator authorization was revoked before this launch was queued.'};}
        if(!result||result.state==='missing'){
          await this.change(job.requestId,current=>{const saved=current.items.find(row=>row.requestId===item.requestId);saved.attempted=true;saved.state='processing';saved.reason='Checking held SOL rewards.';});
          result=await service.queueHeldSolDistribution(job.actorId,input);
          if(['meteora','pump-classic'].includes(item.route)&&['queued','processing'].includes(result?.state))service.kick?.();
        }
      }
      if(!result||!CHILD.has(result.state))throw Error('Invalid child status');
    }catch{result={state:'processing',reason:'Waiting to reconcile the saved distribution request. No replacement request was created.'};}
    await this.change(job.requestId,current=>{
      const saved=current.items.find(row=>row.requestId===item.requestId);saved.state=result.state;saved.reason=text(result.reason);
      if(result.state==='waiting')saved.nextCheckAt=this.now()+15000;else delete saved.nextCheckAt;
      for(const key of ['amountLamports','paidLamports','deferredLamports','remainingLamports'])if(raw(result[key])!==undefined)saved[key]=result[key];
    });
  }
  async process(){
    if(this.closed||!this.accounts.hostStore)return;
    const release=await acquireProcessLock(join(this.accounts.dir,`${NAME}-worker.lock`),0);
    try{
      const state=await this.index();if(!state.latest)return;let job=await this.job(state.latest);if(!ACTIVE.has(job.state))return;
      if(!job.discovered){await this.discover(job);return;}
      const selected=[];for(let n=0;n<job.items.length&&selected.length<this.batchSize;n++){const index=(job.cursor+n)%job.items.length,item=job.items[index];if(PENDING.has(item.state)&&!(item.nextCheckAt>this.now()))selected.push({index,item});}
      for(const {index,item} of selected){if(this.closed)break;await this.processItem(job,item);await this.change(job.requestId,current=>{current.cursor=(index+1)%current.items.length;});}
      await this.change(job.requestId,current=>{if(current.items.every(item=>!PENDING.has(item.state))){current.state='completed';current.reason=current.items.some(item=>item.state==='failed')?'Finished with failures. Review the launch results.':current.items.some(item=>item.state==='skipped')?'Finished. Some launches need review or have no remaining reward credit.':'All distribution requests settled. Review each result for any reserved holder payments.';}});
    }finally{await release();}
  }
  kick(){if(this.closed||this.running||!this.accounts.hostStore)return this.running;this.running=Promise.resolve().then(()=>this.process()).catch(()=>{}).finally(()=>{this.running=null;});return this.running;}
  start(){if(this.timer||this.closed||!this.accounts.hostStore)return;this.timer=setInterval(()=>this.kick(),this.intervalMs);this.timer.unref?.();this.kick();}
  async close(){this.closed=true;clearInterval(this.timer);await this.running;}
}
