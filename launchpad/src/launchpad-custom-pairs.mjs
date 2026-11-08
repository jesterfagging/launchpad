import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getTransferFeeConfig } from '@solana/spl-token';
import { LAUNCH_ASSETS } from '../public/launch-assets.mjs';
import { customPairLabels } from '../public/custom-pair-fields.mjs';
import { inspectLaunchImage } from './launchpad-media.mjs';
import { atomicWrite } from './telegram-store.mjs';
import { acquireProcessLock } from './process-lock.mjs';

const NAME='launch-custom-pairs', LIMIT=500, CHECK_TTL=300000, RETRY_TTL=30000, MAX_CHECKS=4;
const fail=(message,statusCode=400)=>{throw Object.assign(Error(message),{statusCode});};
const empty=()=>({version:1,revision:0,assets:[]});
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const cacheKey=(actorId,mint)=>JSON.stringify([actorId,mint]);
const unknown=(mint,at)=>({mint,supported:null,supportReason:'Unable to verify pairing availability right now. Try again shortly.',checkedAt:at});
const unavailable=(mint,at,reason)=>({mint,supported:false,supportReason:reason,checkedAt:at});
function mintAddress(value){
  try{if(typeof value!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))throw Error();const key=new PublicKey(value);if(key.equals(PublicKey.default)||key.toBase58()!==value)throw Error();return value;}
  catch{fail('Enter the exact Solana token mint address.');}
}
function fields(input){
  if(!record(input))fail('Enter the pair details.');
  const mint=mintAddress(input.mint);let name,symbol;try{({name,symbol}=customPairLabels(input));}catch(e){fail(e.message);}
  return {mint,name,symbol};
}
function publicAsset(row,check=row.check){
  return {mint:row.mint,name:row.name,symbol:row.symbol,category:'custom',issuer:'Custom',logoPath:row.logoPath,
    supported:check?.supported??null,supportReason:check?.supportReason||'',checkedAt:check?.checkedAt??null,
    ...(Number.isInteger(check?.decimals)?{decimals:check.decimals}:{}),...(check?.tokenProgram?{tokenProgram:check.tokenProgram}:{})};
}
export async function readCustomPairs(accounts){
  const state=await accounts.hostStore?.read(NAME,null);
  if(state===null||state===undefined)return empty();
  try{
    if(!record(state)||state.version!==1||!Number.isSafeInteger(state.revision)||state.revision<0||!Array.isArray(state.assets)||state.assets.length>LIMIT)throw Error();
    const seen=new Set();
    for(const row of state.assets){
      const clean=fields({...row,ticker:row?.symbol});
      if(clean.name!==row.name||clean.symbol!==row.symbol||seen.has(clean.mint)||!/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(row.logoPath)||!record(row.check)||![true,false,null].includes(row.check.supported)||!Number.isSafeInteger(row.check.checkedAt)||row.check.checkedAt<0||typeof row.check.supportReason!=='string'||row.check.supportReason.length>240)throw Error();
      seen.add(clean.mint);
    }
  }catch{fail('The saved custom pair list could not be read. Restore its original data before adding pairs.',503);}
  return state;
}

// HTTP verifies the MFA session, CSRF and fresh security proof for save. This
// service also rechecks current admin authority immediately before persistence.
// All chain calls are reads through the application's configured mainnet client.
export class LaunchCustomPairs {
  constructor({accounts,launchpad,now=Date.now}={}){Object.assign(this,{accounts,launchpad,now});this.cache=new Map();this.pending=new Map();this.closed=false;}
  async requireAdmin(id){const actor=await this.accounts.get(id);if(!actor||actor.role!=='admin'||actor.mfaEnabled!==true||actor.banned)fail('Administrator access with two-factor authentication is required.',403);return actor;}
  async catalogue(){return this.launchpad.quoteCatalogue.read();}
  async duplicate(mint,state,catalogue){return LAUNCH_ASSETS.some(a=>a.mint===mint)||catalogue.assets.some(a=>a.mint===mint)||state.assets.some(a=>a.mint===mint);}
  async read(actorId){
    await this.requireAdmin(actorId);const state=await readCustomPairs(this.accounts);
    const checked=row=>this.cache.get(cacheKey(actorId,row.mint))?.check||row.check;
    const stale=state.assets.filter(row=>{const check=checked(row);return this.now()-check.checkedAt>=(check.supported===null?RETRY_TTL:CHECK_TTL);}).sort((a,b)=>checked(a).checkedAt-checked(b).checkedAt).slice(0,MAX_CHECKS);
    await Promise.all(stale.map(row=>this.verify(actorId,row.mint)));
    const assets=state.assets.map(row=>publicAsset(row,this.current(row,actorId)));
    await this.requireAdmin(actorId);return {revision:state.revision,assets};
  }
  current(row,actorId){
    const cached=this.cache.get(cacheKey(actorId,row.mint)),check=cached?.check||row.check;
    return check&&this.now()-check.checkedAt<(check.supported===null?RETRY_TTL:CHECK_TTL)?check:unknown(row.mint,check?.checkedAt??null);
  }
  remember(key,check){this.cache.delete(key);this.cache.set(key,{check});while(this.cache.size>LIMIT)this.cache.delete(this.cache.keys().next().value);return check;}
  async verify(actorId,mint,{fresh=false}={}){
    if(this.closed)return unknown(mint,this.now());
    const key=cacheKey(actorId,mint),cached=this.cache.get(key)?.check;
    if(!fresh&&cached&&this.now()-cached.checkedAt<(cached.supported===null?RETRY_TTL:CHECK_TTL))return cached;
    if(this.pending.has(key))return this.pending.get(key);
    if(this.pending.size>=MAX_CHECKS)return unknown(mint,this.now());
    const task=(async()=>{
      let chain;
      try{
        chain=await this.launchpad.chain(actorId,'mainnet-beta');
        const run=async()=>{
          const info=await chain.mintInfo(mint);
          if(!info?.key?.equals(new PublicKey(mint))||![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(info.program))||!info.mint?.isInitialized||!Number.isInteger(info.mint.decimals)||info.mint.decimals<0||info.mint.decimals>12)fail('This address is not a supported initialized Solana token mint.');
          const details={decimals:info.mint.decimals,tokenProgram:info.program.toBase58()};
          const tax=getTransferFeeConfig(info.mint);
          if(tax&&[tax.olderTransferFee,tax.newerTransferFee].some(f=>f.transferFeeBasisPoints>=10000))return {...unavailable(mint,this.now(),'This mint has a 100% transfer fee and cannot be used as a pairing asset.'),...details};
          const approved=await chain.approvedQuotes();
          if(!Array.isArray(approved))throw Error('Invalid quote configuration list.');
          if(!approved.includes(mint))return {...unavailable(mint,this.now(),'Raydium has no bonding-curve launch configuration for this token yet.'),...details};
          // Use the same price, extension, migration and curve-fit checks as an
          // actual launch, with no purchase, image upload, keys or transaction.
          const input=await this.launchpad.newLaunchInput(actorId,{name:'Pair check',symbol:'PAIR',quoteMint:mint,feeMode:'creator',devBuySol:'0'});
          const preview=await chain.preview(input);
          if(preview?.quoteProgram!==details.tokenProgram||preview?.quoteDecimals!==details.decimals||!(Number(preview?.price?.usd)>0))throw Error('Invalid quote preview.');
          return {mint,supported:true,supportReason:'',checkedAt:this.now(),...details};
        };
        return await (chain.withRpcContext?chain.withRpcContext({workload:'custom-pair-check',deadline:Date.now()+15000},run):run());
      }catch(error){
        if(['Quote mint was not found on this Solana network.','Unsupported quote mint.','This address is not a supported initialized Solana token mint.'].includes(error.message))return {...unavailable(mint,this.now(),'This address is not a supported initialized Solana token mint.'),invalidMint:true};
        if(error.message==='This quote cannot migrate to Raydium CPMM: its Token-2022 extensions are not registered.')return unavailable(mint,this.now(),'This token’s extensions are not approved for Raydium pool migration.');
        // Provider messages can include private RPC URLs. Never relay them or
        // treat a timeout, missing price or malformed config as positive proof.
        return unknown(mint,this.now());
      }finally{chain?.close?.();}
    })().then(check=>this.remember(key,check)).finally(()=>this.pending.delete(key));
    this.pending.set(key,task);return task;
  }
  async previewMint(actorId,{mint}={}){
    await this.requireAdmin(actorId);mint=mintAddress(mint);
    const [state,catalogue,check]=await Promise.all([readCustomPairs(this.accounts),this.catalogue(),this.verify(actorId,mint,{fresh:true})]);
    await this.requireAdmin(actorId);
    if(check.invalidMint)fail('Enter a valid initialized Solana token mint.');
    const {invalidMint,...publicCheck}=check;
    return {...publicCheck,alreadyListed:await this.duplicate(mint,state,catalogue)};
  }
  async save(actorId,input={}){
    await this.requireAdmin(actorId);const asset=fields(input),image=inspectLaunchImage(input.image);
    if(!Number.isSafeInteger(input.revision)||input.revision<0)fail('Refresh the pair list before saving.',409);
    const release=await acquireProcessLock(join(this.accounts.dir,'launch-custom-pairs.lock'));
    try{
      await this.requireAdmin(actorId);const state=await readCustomPairs(this.accounts),catalogue=await this.catalogue();
      if(state.revision!==input.revision)fail('The pair list changed. Refresh it before saving.',409);
      if(await this.duplicate(asset.mint,state,catalogue))fail('This mint is already in the pair catalogue.',409);
      if(state.assets.length>=LIMIT)fail('The custom pair list has reached its 500-pair limit.',409);
      const check=await this.verify(actorId,asset.mint,{fresh:true});
      if(check.invalidMint)fail('This address is not a supported initialized Solana token mint.');
      if(check.supported===null)fail('Unable to verify this pair right now. Try again shortly; nothing was added.',503);
      const actor=await this.requireAdmin(actorId),folder=join(this.accounts.dir,'token-images');await mkdir(folder,{recursive:true});
      const path=join(folder,image.id);let saved;try{saved=await readFile(path);}catch(e){if(e.code!=='ENOENT')throw e;}
      if(!saved?.equals(image.bytes))await atomicWrite(path,image.bytes);
      // Auth may have changed while the image write awaited the filesystem.
      await this.requireAdmin(actorId);
      const row={...asset,logoPath:'/token-images/'+image.id,check,createdAt:this.now(),createdBy:actor.id||actorId};
      state.assets.push(row);state.revision++;await this.accounts.hostStore.write(NAME,state);
      return {revision:state.revision,asset:publicAsset(row)};
    }finally{await release();}
  }
  async publicAssets(actorId,catalogue,approvedMints){
    const state=await readCustomPairs(this.accounts),known=new Set(catalogue.assets.map(a=>a.mint));
    const rows=state.assets.filter(row=>!known.has(row.mint));
    if(!rows.length)return [];
    // At most four stale curated mints are checked per request. Coalesce within
    // an account: its configured RPC must never poison another viewer's cache.
    // No request fetches metadata or previews every discovered mint.
    if(Array.isArray(approvedMints)){
      const stale=rows.filter(row=>{
        if(!approvedMints.includes(row.mint))return false;
        const check=this.cache.get(cacheKey(actorId,row.mint))?.check||row.check;
        return !check||this.now()-check.checkedAt>=(check.supported===null?RETRY_TTL:CHECK_TTL)||check.supported===false&&check.supportReason.startsWith('Raydium has no bonding-curve');
      }).sort((a,b)=>(this.cache.get(cacheKey(actorId,a.mint))?.check?.checkedAt||a.check.checkedAt)-(this.cache.get(cacheKey(actorId,b.mint))?.check?.checkedAt||b.check.checkedAt)).slice(0,MAX_CHECKS);
      await Promise.all(stale.map(row=>this.verify(actorId,row.mint,{fresh:true})));
    }
    return rows.map(row=>{
      let check=this.current(row,actorId);
      if(!Array.isArray(approvedMints))check=unknown(row.mint,this.now());
      else if(!approvedMints.includes(row.mint))check=unavailable(row.mint,this.now(),'Raydium has no bonding-curve launch configuration for this token yet.');
      return publicAsset(row,check);
    });
  }
  async close(){this.closed=true;await Promise.allSettled([...this.pending.values()]);this.cache.clear();}
}
