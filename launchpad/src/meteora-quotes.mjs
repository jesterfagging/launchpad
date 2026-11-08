import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT_2022, unpackMint,
  ExtensionType, getExtensionTypes, getTransferFeeConfig, getTransferHook,
  getDefaultAccountState, getPausableConfig, getScaledUiAmountConfig, AccountState,
} from '@solana/spl-token';
import { associatedTokenAccountSize } from './launchpad-token-account-size.mjs';
import { dexQuotePrice } from './launchpad-quote-price.mjs';
import { METEORA_EXTRA_ASSETS, METEORA_RAW_PRICE_MINTS } from '../public/meteora-extra-assets.mjs';

export const METEORA_DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
const BADGE_DISCRIMINATOR=Buffer.from([116,219,204,229,249,116,255,150]);
const SOL='So11111111111111111111111111111111111111112',USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RETIRED=new Set(['PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh','PreC1KtJ1sBPPqaeeqL6Qb15GTLCYVvyYEwxhdfTwfx']);
const METADATA=new Set([ExtensionType.MetadataPointer,ExtensionType.TokenMetadata]);
const INTEGRATED=new Set([...METADATA,ExtensionType.TransferFeeConfig,16,ExtensionType.GroupPointer,ExtensionType.TokenGroup,ExtensionType.GroupMemberPointer,ExtensionType.TokenGroupMember,ExtensionType.MintCloseAuthority,ExtensionType.DefaultAccountState,ExtensionType.ConfidentialTransferMint,ExtensionType.InterestBearingConfig,ExtensionType.PermanentDelegate,ExtensionType.TransferHook,ExtensionType.ScaledUiAmountConfig,ExtensionType.PausableConfig]);
const text=(v,n=160)=>typeof v==='string'?v.trim().slice(0,n):'';
const key=value=>{const p=new PublicKey(value);if(typeof value==='string'&&p.toBase58()!==value)throw Error('Invalid mint.');return p;};
const failure=(code,supportReason,extra={})=>({supported:false,launchReady:false,code,supportReason,...extra});
const unknown=()=>({supported:null,launchReady:false,code:'verification_pending',supportReason:'Availability has not been verified yet.'});
const verificationBusy=(mint,code='verification_busy')=>({...unknown(),mint,code,retryable:true,retryAfter:2,supportReason:code==='verification_cancelled'?'Pair checking was interrupted. Please try again.':'Pair checks are in progress. Please try again shortly.'});
const unset=value=>!value||new PublicKey(value).equals(PublicKey.default);

export function meteoraTokenBadgeAddress(mint){return PublicKey.findProgramAddressSync([Buffer.from('token_badge'),key(mint).toBuffer()],METEORA_DBC_PROGRAM)[0];}
export function validMeteoraTokenBadge(mint,account){
  try{return !!account&&!account.executable&&account.owner.equals(METEORA_DBC_PROGRAM)&&account.data.length===168&&account.data.subarray(0,8).equals(BADGE_DISCRIMINATOR)&&new PublicKey(account.data.subarray(8,40)).equals(key(mint));}catch{return false;}
}

/** Match the DBC quote mint rules, then reject transfer behavior unsupported by
 * this integration. Badges authorize mint validation; they do not make active
 * hooks, frozen token accounts, or non-transferable mints tradeable. */
export function inspectMeteoraQuoteMint(mintAddress,account,{epoch,tokenBadge}={}){
  let mint,program,parsed,extensions;
  try{
    mint=key(mintAddress);program=account?.owner;
    if(!account||account.executable||![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(program)))return failure('invalid_mint','This address is not an initialized Solana token mint.');
    parsed=unpackMint(mint,account,program);
    if(!parsed.isInitialized||!Number.isInteger(parsed.decimals)||parsed.decimals<0||parsed.decimals>12)return failure('invalid_mint','This mint’s decimals or initialization are not supported.');
    extensions=program.equals(TOKEN_2022_PROGRAM_ID)?getExtensionTypes(parsed.tlvData):[];
    associatedTokenAccountSize({program,mint:parsed});
  }catch{return failure('invalid_mint','This address is not a valid Solana token mint.');}
  const info={mint:mint.toBase58(),decimals:parsed.decimals,tokenProgram:program.toBase58(),extensions,extensionNames:extensions.map(e=>ExtensionType[e]||(e===16?'ConfidentialTransferFeeConfig':`Extension ${e}`)),requiresTokenBadge:false};
  if(mint.equals(NATIVE_MINT_2022))return failure('native_token_2022','Use the standard wrapped SOL mint for this pair.',info);
  if(RETIRED.has(info.mint))return failure('retired_asset','The issuer has retired this asset for new launches.',info);
  if(program.equals(TOKEN_PROGRAM_ID))return {supported:true,launchReady:false,code:'mint_compatible',supportReason:'',...info};
  try{
    const fee=getTransferFeeConfig(parsed);
    if(fee){
      if(!Number.isSafeInteger(epoch)||epoch<0)return {...unknown(),...info,code:'epoch_unavailable',supportReason:'The current Solana epoch could not be verified.'};
      // The launch adapter validates both stored schedules before accepting
      // funds. Keep catalogue eligibility identical, including expired fees.
      if([fee.olderTransferFee,fee.newerTransferFee].some(f=>f.transferFeeBasisPoints!==0))return failure('quote_transfer_fee','Both stored transfer-tax schedules must be zero for this Meteora pair.',info);
    }
    if(extensions.includes(ExtensionType.NonTransferable))return failure('non_transferable','This asset cannot be transferred into a liquidity pool.',info);
    const hook=getTransferHook(parsed);
    if(hook&&!unset(hook.programId))return failure('active_transfer_hook','This asset’s active transfer hook is not supported throughout DBC and DAMM v2 trading.',info);
    if(hook&&!unset(hook.authority))info.transferHookAuthorityRetained=true;
    const state=getDefaultAccountState(parsed);
    if(state&&state.state!==AccountState.Initialized)return failure('default_frozen','New token accounts are frozen for this asset.',info);
    const pause=getPausableConfig(parsed);
    if(pause?.paused)return failure('paused_mint','Transfers for this asset are currently paused.',info);
    if(extensions.some(e=>!INTEGRATED.has(e)))return failure('unverified_extension','This mint has token extensions that have not been validated for Launchpad’s Meteora integration.',info);
  }catch{return failure('invalid_extensions','This mint’s token extensions could not be decoded safely.',info);}
  info.requiresTokenBadge=extensions.some(e=>!METADATA.has(e));
  if(info.requiresTokenBadge){
    if(!validMeteoraTokenBadge(mint,tokenBadge))return failure('dbc_badge_missing','Meteora has not approved this quote mint’s extensions for DBC.',info);
    info.tokenBadge=meteoraTokenBadgeAddress(mint).toBase58();
  }
  return {supported:true,launchReady:false,code:'mint_compatible',supportReason:'',...info};
}

function cleanAsset(row){
  try{
    const mint=key(row?.mint).toBase58(),name=text(row.name,100),symbol=text(row.symbol,24);
    if(!name||!symbol||mint===PublicKey.default.toBase58()||RETIRED.has(mint)||row.retired===true||row.isTradingHalted===true)return null;
    const value={mint,name,symbol,issuer:text(row.issuer,80),category:text(row.category,24)||'custom'};
    for(const property of ['source','logoPath','launchpadOrigin'])if(typeof row[property]==='string')value[property]=text(row[property],512);
    if(row.originVerified===true)value.originVerified=true;
    return value;
  }catch{return null;}
}

/** Read-only eligibility cache. Every positive result requires fresh mint,
 * badge, migration configuration, and mint-specific raw-unit price evidence.
 * Providers are injected so RPC/Jupiter quotas and account context stay shared
 * with the host. No issuer URL or arbitrary user URL is fetched here. */
export class MeteoraQuoteCatalogue{
  constructor({catalogue,customAssets=async()=>[],extraAssets=METEORA_EXTRA_ASSETS,connection,getConnection,price,priceBatch,migrationCheck,curveCheck,now=Date.now,ttl=21600000,priceTtl=60000,retryTtl=30000,maxConcurrent=4,maxWaiting=120,waitMs=12000,contextKey=()=> 'shared',store}={}){
    Object.assign(this,{catalogue,customAssets,extraAssets,connection,getConnection,price,priceBatch,migrationCheck,curveCheck,now,ttl,priceTtl,retryTtl,maxConcurrent,maxWaiting,waitMs,contextKey,store});
    this.checks=new Map();this.proofOrders=new Map();this.nextProofOrder=0;this.pending=new Map();this.waiting=[];this.activeChecks=0;this.foregroundStarts=0;this.closed=false;this.cataloguePending=null;this.sweep=null;this.lastComplete=null;this.sweepPending=null;this.initialized=null;
  }
  async assets(context={}){
    const source=await this.catalogue?.read?.()||{assets:[]};
    const custom=await this.customAssets(context);const map=new Map();
    for(const row of [...(source.assets||[]),...(Array.isArray(custom)?custom:custom?.assets||[]),...this.extraAssets]){const a=cleanAsset(row);if(a&&!map.has(a.mint))map.set(a.mint,a);}
    return [...map.values()];
  }
  cacheKey(mint,context){return `${this.contextKey(context)}:${mint}`;}
  current(mint,context={}){
    const row=this.checks.get(this.cacheKey(mint,context));
    if(!row||this.now()-row.checkedAt>=(row.supported===null?this.retryTtl:this.ttl))return {...unknown(),mint,checkedAt:row?.checkedAt??null};
    return {...row};
  }
  finishWaiting(task,code='verification_busy'){
    const index=this.waiting.indexOf(task);if(index<0)return;
    this.waiting.splice(index,1);clearTimeout(task.timer);
    if(this.pending.get(task.key)===task)this.pending.delete(task.key);
    task.resolve(verificationBusy(task.mint,code));
  }
  drainChecks(){
    while(!this.closed&&this.activeChecks<this.maxConcurrent&&this.waiting.length){
      const foreground=this.waiting.findIndex(task=>!task.background),background=this.waiting.findIndex(task=>task.background);
      const index=background>=0&&(foreground<0||this.foregroundStarts>=4)?background:foreground>=0?foreground:0;
      const task=this.waiting.splice(index,1)[0];clearTimeout(task.timer);task.started=true;this.activeChecks++;
      this.foregroundStarts=task.background||background<0?0:this.foregroundStarts+1;
      const finish=()=>{if(this.pending.get(task.key)===task)this.pending.delete(task.key);this.activeChecks--;this.drainChecks();};
      Promise.resolve().then(task.run).then(result=>{finish();task.resolve(result);},error=>{finish();task.reject(error);});
    }
  }
  async waitForCheck(task,signal){
    if(signal?.aborted)return verificationBusy(task.mint,'verification_cancelled');
    task.waiters++;let abort;
    try{
      if(!signal)return await task.promise;
      return await Promise.race([task.promise,new Promise(resolve=>{
        abort=()=>resolve(verificationBusy(task.mint,'verification_cancelled'));
        signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      })]);
    }finally{
      signal?.removeEventListener('abort',abort);task.waiters--;
      if(!task.waiters&&!task.started){this.finishWaiting(task,'verification_cancelled');this.drainChecks();}
    }
  }
  async status(mint,{context={},fresh=false,asset,mintEvidence,background=false,signal}={}){
    try{mint=key(mint).toBase58();}catch{return {...failure('invalid_mint','Enter an exact Solana mint address.'),checkedAt:this.now()};}
    const id=this.cacheKey(mint,context),cached=this.current(mint,context);
    if(!fresh&&cached.code!=='verification_pending')return cached;
    if(this.closed||signal?.aborted)return verificationBusy(mint,'verification_cancelled');
    const jobKey=id+(background?':sweep':':live');let task=this.pending.get(jobKey);
    // A queued sweep can become a fresh foreground check. A running sweep may
    // use earlier bulk evidence, so live callers share a separate fresh check.
    if(!task&&!background){
      const sweep=this.pending.get(id+':sweep');
      if(sweep&&!sweep.started){this.pending.delete(sweep.key);sweep.key=jobKey;sweep.background=false;sweep.mintEvidence=undefined;this.pending.set(jobKey,sweep);task=sweep;}
    }
    if(task)return this.waitForCheck(task,signal);
    if(this.activeChecks>=this.maxConcurrent&&this.waiting.length>=this.maxWaiting)return verificationBusy(mint);
    task={key:jobKey,mint,background,mintEvidence,started:false,waiters:0,timer:null};
    task.promise=new Promise((resolve,reject)=>{task.resolve=resolve;task.reject=reject;});
    task.run=async()=>{
      const mintEvidence=task.mintEvidence,proofOrder=mintEvidence?.proofOrder??++this.nextProofOrder;
      const result=await (async()=>{
      try{
        asset ||= (await this.assets(context)).find(a=>a.mint===mint);
        if(!asset)return failure('not_catalogued','This asset has not been added to Launchpad’s pair catalogue.');
        const connection=this.getConnection?await this.getConnection(context):this.connection;
        if(!connection)return {...unknown(),code:'rpc_unavailable',supportReason:'The Solana connection is unavailable.'};
        const [account,epoch]=mintEvidence?[mintEvidence.account,{epoch:mintEvidence.epoch}]:await Promise.all([connection.getAccountInfo(key(mint),'confirmed'),connection.getEpochInfo('confirmed')]);
        let check=inspectMeteoraQuoteMint(mint,account,{epoch:epoch?.epoch});
        if(check.code==='dbc_badge_missing'){
          const tokenBadge=mintEvidence?mintEvidence.tokenBadge:await connection.getAccountInfo(meteoraTokenBadgeAddress(mint),'confirmed');
          check=inspectMeteoraQuoteMint(mint,account,{epoch:epoch?.epoch,tokenBadge});
        }
        if(check.supported!==true)return check;
        const migration=await this.migrationCheck?.(check,context);
        if(migration?.supported!==true)return {...check,...failure('migration_unverified','Meteora’s DAMM v2 migration configuration could not be verified for this pair.')};
        const bulk=mintEvidence?.batchPrice;
        if(bulk?.temporarilyUnavailable)return {...unknown(),...check,supported:null,code:'price_check_unavailable',supportReason:'Live pricing checks are temporarily unavailable.'};
        const result=bulk!==undefined&&!bulk?.requiresRawPrice?bulk:await this.price?.(asset,{key:key(mint),program:account.owner,mint:unpackMint(key(mint),account,account.owner),extensions:check.extensions},context);
        const usd=Number(result?.usd),at=Number(result?.at);
        if(!Number.isFinite(usd)||usd<1e-8||usd>=1e9||!Number.isSafeInteger(at)||at>this.now()+5000||this.now()-at>(mintEvidence?Math.max(this.priceTtl,900000):this.priceTtl))return {...check,...failure('price_unavailable','A fresh USD price and conversion route are not available for this asset.')};
        try{
          if(typeof this.curveCheck!=='function')throw Error('Launchpad builder missing.');
          const curve=await this.curveCheck({quoteUsd:usd,quoteDecimals:check.decimals},context);
          if(curve===false||curve?.supported===false)throw Error('Launchpad builder rejected quote.');
        }catch{return {...check,...failure('curve_configuration_unavailable','This asset’s current price or decimals cannot support Launchpad’s Meteora launch configuration.')};}
        return {...check,supported:true,launchReady:true,code:'ready',supportReason:'',price:{usd:String(result.usd),at,source:text(result.source,80)},migrationConfig:text(migration.config,64)};
      }catch{return {...unknown(),code:'verification_unavailable',supportReason:'Live pairing checks are temporarily unavailable. Please try again shortly.'};}
      })();
      const check={...result,mint,checkedAt:this.now()};
      // Bulk sweep evidence can finish after a newer live proof. It must not
      // replace that proof or renew old evidence with a later completion time.
      if(proofOrder>=(this.proofOrders.get(id)||0)){this.checks.set(id,check);this.proofOrders.set(id,proofOrder);}
      while(this.checks.size>5000){const oldest=this.checks.keys().next().value;this.checks.delete(oldest);this.proofOrders.delete(oldest);}
      return {...check};
    };
    this.pending.set(jobKey,task);this.waiting.push(task);
    task.timer=setTimeout(()=>{this.finishWaiting(task);this.drainChecks();},this.waitMs);task.timer.unref?.();
    const result=this.waitForCheck(task,signal);this.drainChecks();return result;
  }

  async initialize(){
    if(this.initialized)return this.initialized;
    this.initialized=(async()=>{
      try{
        const saved=await this.store?.read?.('meteora-quote-checks',null);
        if(saved?.version!==1||!Array.isArray(saved.checks)||saved.checks.length>10000||!saved.sweep?.complete||!Number.isSafeInteger(saved.sweep.at)||this.now()-saved.sweep.at>=this.ttl)return;
        for(const row of saved.checks){
          if(typeof row?.cacheKey!=='string'||row.cacheKey.length>160||![true,false,null].includes(row.check?.supported)||!Number.isSafeInteger(row.check.checkedAt))throw Error('Invalid quote cache.');
          key(row.check.mint);
          if(row.check.supported===true&&(!row.check.launchReady||!(Number(row.check.price?.usd)>0)||!Number.isSafeInteger(row.check.price?.at)||!Number.isInteger(row.check.decimals)||!Number.isSafeInteger(row.check.checkedAt)||typeof row.check.migrationConfig!=='string'))throw Error('Incomplete quote cache.');
        }
        for(const row of saved.checks)this.checks.set(row.cacheKey,row.check);
        this.sweep=saved.sweep;this.lastComplete=saved.sweep;
      }catch{this.checks.clear();this.sweep=null;this.lastComplete=null;}
    })();return this.initialized;
  }
  fingerprint(assets){return createHash('sha256').update(assets.map(a=>a.mint).sort().join('\n')).digest('hex');}
  async sweepStatus(context={}){
    await this.initialize();const assets=await this.assets(context),fingerprint=this.fingerprint(assets);
    const proof=this.lastComplete;const ready=proof?.complete===true&&proof.contextKey===this.contextKey(context)&&proof.fingerprint===fingerprint&&this.now()-proof.at<this.ttl;
    return {ready,running:!!this.sweepPending,total:assets.length,checked:ready?assets.length:this.sweep?.checked||0,checkedAt:this.sweep?.at||null,counts:this.sweep?.counts||null};
  }
  startSweep(options={}){
    if(!this.sweepPending&&!this.closed)this.sweepPending=this.runSweep(options).finally(()=>{this.sweepPending=null;});
    return this.sweepPending;
  }
  fullSweep(options={}){return this.startSweep(options);}
  async runSweep({context={},force=false,onProgress}={}){
    await this.initialize();const status=await this.sweepStatus(context);if(status.ready&&!force)return status;
    const assets=(await this.assets(context)).sort((a,b)=>(a.mint===SOL?-2:a.mint===USDC?-1:0)-(b.mint===SOL?-2:b.mint===USDC?-1:0));
    const connection=this.getConnection?await this.getConnection(context):this.connection;
    if(!connection)throw Error('The Solana connection is unavailable.');
    const proofOrder=++this.nextProofOrder;
    const epoch=(await connection.getEpochInfo('confirmed')).epoch,accounts=new Map(),badges=new Map();
    this.sweep={complete:false,contextKey:this.contextKey(context),fingerprint:this.fingerprint(assets),at:this.now(),checked:0,total:assets.length};
    // 100 is Solana's documented getMultipleAccounts limit. Read each mint
    // once and request badge PDAs only for mints that actually need one.
    for(let offset=0;offset<assets.length;offset+=100){
      if(this.closed)throw Error('Quote checks stopped.');
      const batch=assets.slice(offset,offset+100),values=await connection.getMultipleAccountsInfo(batch.map(a=>key(a.mint)),'confirmed');
      if(!Array.isArray(values)||values.length!==batch.length)throw Error('Incomplete mint response.');
      batch.forEach((a,i)=>accounts.set(a.mint,values[i]));
    }
    const badgeMints=assets.filter(a=>inspectMeteoraQuoteMint(a.mint,accounts.get(a.mint),{epoch}).code==='dbc_badge_missing');
    for(let offset=0;offset<badgeMints.length;offset+=100){
      if(this.closed)throw Error('Quote checks stopped.');
      const batch=badgeMints.slice(offset,offset+100),values=await connection.getMultipleAccountsInfo(batch.map(a=>meteoraTokenBadgeAddress(a.mint)),'confirmed');
      if(!Array.isArray(values)||values.length!==batch.length)throw Error('Incomplete badge response.');
      batch.forEach((a,i)=>badges.set(a.mint,values[i]));
    }
    const compatible=assets.filter(a=>inspectMeteoraQuoteMint(a.mint,accounts.get(a.mint),{epoch,tokenBadge:badges.get(a.mint)}).supported===true);
    const batchPrices=this.priceBatch?await this.priceBatch(compatible,accounts,context):null;
    for(let offset=0;offset<assets.length;offset+=this.maxConcurrent){
      if(this.closed)throw Error('Quote checks stopped.');
      const batch=assets.slice(offset,offset+this.maxConcurrent);
      const results=await Promise.all(batch.map(asset=>this.status(asset.mint,{context,asset,fresh:true,background:true,mintEvidence:{proofOrder,account:accounts.get(asset.mint),epoch,tokenBadge:badges.get(asset.mint),...(batchPrices?.has(asset.mint)?{batchPrice:batchPrices.get(asset.mint)}:{})}})));
      if(results.some(result=>result.retryable))throw Object.assign(Error('Meteora pair checking is waiting for capacity.'),{retryable:true,code:'verification_busy'});
      this.sweep.checked+=batch.length;
      await onProgress?.({checked:this.sweep.checked,total:assets.length});
    }
    const checks=assets.map(a=>this.checks.get(this.cacheKey(a.mint,context))||unknown());
    // Transient failures are an explicit unavailable result; they never become
    // a positive pair. A completed scan is distinct from every asset passing.
    this.sweep={...this.sweep,complete:true,at:this.now(),counts:{catalogued:assets.length,available:checks.filter(a=>a.supported===true).length,pending:checks.filter(a=>a.supported===null).length,unavailable:checks.filter(a=>a.supported===false).length}};
    this.lastComplete=this.sweep;
    await this.store?.write?.('meteora-quote-checks',{version:1,sweep:this.sweep,checks:[...this.checks].map(([cacheKey,check])=>({cacheKey,check}))});
    return this.sweepStatus(context);
  }
  async list({context={},includeUnavailable=false}={}){
    await this.initialize();const status=await this.sweepStatus(context),assets=await this.assets(context);
    const all=assets.map(asset=>({...asset,...this.current(asset.mint,context),venue:'meteora',feeModes:['creator','holders','gotchi']}));
    const available=all.filter(a=>a.supported===true&&a.launchReady===true);
    return {...status,assets:includeUnavailable?all:this.lastComplete?.complete&&this.lastComplete.contextKey===this.contextKey(context)&&this.now()-this.lastComplete.at<this.ttl?available:[],counts:{catalogued:all.length,available:available.length,pending:all.filter(a=>a.supported===null).length,unavailable:all.filter(a=>a.supported===false).length},source:'Launchpad catalogue + verified issuers; live Meteora mint, price and migration checks'};
  }
  async warm(options={}){return this.fullSweep(options);}
  async close(){this.closed=true;for(const task of [...this.waiting])this.finishWaiting(task,'verification_cancelled');await Promise.allSettled([this.sweepPending,...[...this.pending.values()].map(task=>task.promise)].filter(Boolean));this.checks.clear();this.proofOrders.clear();}
}

/** Full-catalogue read-only price pass. One public index request covers up to
 * 30 exact mints. A missing market stays unavailable; do not spend thousands
 * of Jupiter requests probing empty issuer mints when opening the menu.
 * Indexed scaled/interest-bearing mints must use the injected raw quote path. */
export async function readMeteoraQuotePrices(assets,mintAccounts,{fetcher=fetch,now=Date.now,onProgress}={}){
  const result=new Map(),rawCandidates=new Set(METEORA_RAW_PRICE_MINTS);
  for(let offset=0;offset<assets.length;offset+=30){
    const batch=assets.slice(offset,offset+30);
    try{
      const response=await fetcher(`https://api.dexscreener.com/tokens/v1/solana/${batch.map(a=>key(a.mint).toBase58()).join(',')}`,{signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error('Market index unavailable.');
      const text=await response.text();if(text.length>8000000)throw Error('Market index response too large.');
      const pairs=JSON.parse(text);if(!Array.isArray(pairs))throw Error('Invalid market index.');
      for(const asset of batch){
        const usd=dexQuotePrice(pairs,asset.mint);
        if(usd===null){result.set(asset.mint,rawCandidates.has(asset.mint)?{requiresRawPrice:true}:null);continue;}
        const account=mintAccounts.get(asset.mint),mint=unpackMint(key(asset.mint),account,account.owner),extensions=account.owner.equals(TOKEN_2022_PROGRAM_ID)?getExtensionTypes(mint.tlvData):[],scale=getScaledUiAmountConfig(mint);
        const raw=extensions.includes(ExtensionType.InterestBearingConfig)||scale&&(scale.multiplier!==1||scale.newMultiplier!==1);
        result.set(asset.mint,raw?{requiresRawPrice:true}:{usd:usd.toFixed(8),at:now(),source:'Live market reference'});
      }
    }catch{for(const asset of batch)result.set(asset.mint,{temporarilyUnavailable:true});}
    await onProgress?.({checked:Math.min(offset+30,assets.length),total:assets.length});
  }
  return result;
}
