import {deriveDbcPoolAddress,deriveDbcTokenVaultAddress,deriveDbcPoolAuthority,deriveDammV2TokenVaultAddress,deriveDammV2PoolAuthority} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { PublicKey } from '@solana/web3.js';
import { unpackAccount, unpackMint, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { formatUnits } from 'viem';
import { ray } from './launchpad-chain.mjs';
import { PublicRefreshQueue } from './public-refresh-queue.mjs';
import { addresses as dammPumpAddresses } from './damm-pump-client.mjs';
import { coinAddresses as pumpClassicAddresses } from './pump-classic/instructions.mjs';

const TTL=60_000,RETRY=10_000,STALE_TTL=15*60_000,MAX_SCAN=10_000;
const tokenProgram=owner=>[TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(program=>program.equals(owner));
const invalid=()=>{throw Error('Invalid holder snapshot');};
const unavailable=mint=>({mint,available:false,stale:false,holders:[],at:null,refreshMs:RETRY,note:'Holder balances are temporarily unavailable. The site’s public Solana RPC must support token account reads; try again shortly.'});

// Match the actual token-account address AND its authority. A random off-curve
// wallet is not evidence of an LP. These PDAs also work before DEX indexing.
export function holderLpVaults(mint,launch){
  const result=new Map();
  try{
    if(launch?.keys?.mint?.address!==mint.toBase58()||launch.input?.network!=='mainnet-beta')return result;
    if(launch.input.route==='damm-pump'){
      const a=dammPumpAddresses({programId:launch.review.publicProgramId,mint,quoteMint:launch.input.quoteMint,quoteTokenProgram:launch.review.quoteProgram});
      if(a.authority.toBase58()!==launch.keys.wallet.address||a.authority.toBase58()!==launch.review.custodyAuthority||a.state.toBase58()!==launch.review.stateAddress||a.dammPool.toBase58()!==launch.curve)return result;
      result.set(a.baseAta.toBase58(),{authority:a.authority.toBase58(),lpType:'curve'});
      result.set(a.dammBaseVault.toBase58(),{authority:a.dammAuthority.toBase58(),lpType:'curve'});
      if(launch.review.poolId){const pool=new PublicKey(launch.review.poolId);result.set(getAssociatedTokenAddressSync(mint,pool,true,TOKEN_PROGRAM_ID).toBase58(),{authority:pool.toBase58(),lpType:'pool'});}
      return result;
    }
    if(launch.input.route==='pumpswap'){
      const authority=new PublicKey(launch.review.custodyAuthority);
      if(authority.toBase58()!==launch.keys.wallet.address)return result;
      result.set(getAssociatedTokenAddressSync(mint,authority,true,TOKEN_PROGRAM_ID).toBase58(),{authority:authority.toBase58(),lpType:'curve'});
      if(launch.review.poolId){const pool=new PublicKey(launch.review.poolId);result.set(getAssociatedTokenAddressSync(mint,pool,true,TOKEN_PROGRAM_ID).toBase58(),{authority:pool.toBase58(),lpType:'pool'});}
      return result;
    }
    if(launch.input.route==='pump-classic'){
      // Native Pump.fun: the bonding curve keeps the unsold supply in its own Token-2022 account; after graduation the
      // canonical PumpSwap pool's base vault holds it. Both derive from the mint (and the pair), as the coin's record does.
      const curve=pumpClassicAddresses(mint.toBase58());
      if(curve.bondingCurve!==launch.curve)return result;
      result.set(curve.associatedBondingCurve,{authority:curve.bondingCurve,lpType:'curve'});
      if(launch.review?.poolId){const a=pumpClassicAddresses(mint.toBase58(),{mint:launch.input.quoteMint,program:launch.review.quoteProgram});if(launch.review.poolId===a.canonicalPool)result.set(a.poolBaseTokenAccount,{authority:a.canonicalPool,lpType:'pool'});}
      return result;
    }
    if(launch.input.route==='meteora'){
      const quote=new PublicKey(launch.input.quoteMint),config=new PublicKey(launch.review.configAddress),curve=deriveDbcPoolAddress(quote,mint,config);
      if(curve.toBase58()!==launch.curve)return result;
      result.set(deriveDbcTokenVaultAddress(curve,mint).toBase58(),{authority:deriveDbcPoolAuthority().toBase58(),lpType:'curve'});
      if(launch.review.poolId){const pool=new PublicKey(launch.review.poolId);result.set(deriveDammV2TokenVaultAddress(pool,mint).toBase58(),{authority:deriveDammV2PoolAuthority().toBase58(),lpType:'pool'});}
      return result;
    }
    if(launch.input.route!=='raydium')return result;
    const quote=new PublicKey(launch.input.quoteMint),curve=ray.getPdaLaunchpadPoolId(ray.LAUNCHPAD_PROGRAM,mint,quote).publicKey;
    if(launch.curve!==curve.toBase58())return result;
    result.set(ray.getPdaLaunchpadVaultId(ray.LAUNCHPAD_PROGRAM,curve,mint).publicKey.toBase58(),{authority:ray.getPdaLaunchpadAuth(ray.LAUNCHPAD_PROGRAM).publicKey.toBase58(),lpType:'curve'});
    if(launch.review?.cpConfigId){
      const [a,b]=[mint,quote].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));
      const pool=ray.getCpmmPdaPoolId(ray.CREATE_CPMM_POOL_PROGRAM,new PublicKey(launch.review.cpConfigId),a,b).publicKey;
      result.set(ray.getPdaVault(ray.CREATE_CPMM_POOL_PROGRAM,pool,mint).publicKey.toBase58(),{authority:ray.getPdaPoolAuthority(ray.CREATE_CPMM_POOL_PROGRAM).publicKey.toBase58(),lpType:'pool'});
    }
  }catch{ /* Incomplete legacy metadata must not hide otherwise valid holders. */ }
  return result;
}

// Only public token accounts are read. Snapshots and in-flight reads are shared
// across viewers. The fallback scans ONE mint under its verified token program;
// it never enumerates the entire token program or asks viewers for credentials.
export class PublicCoinHolders {
  constructor({chain,now=Date.now,waitMs=8000,requestsPerMinute=30}){Object.assign(this,{chain,now});this.waitMs=Math.min(8000,Math.max(1,waitMs));this.cache=new Map();this.pending=new Map();this.queue=new PublicRefreshQueue({concurrency:2,perMinute:Math.max(1,Math.min(600,requestsPerMinute)),now});this.scanStarts=[];this.closed=false;}
  staleOrUnavailable(mint,old){
    return old?.value?.available&&this.now()-old.value.at<STALE_TTL
      ?{...old.value,stale:true,refreshMs:RETRY,note:'Showing the last verified holder balances while the public RPC recovers. '+old.value.note.replace(/^Showing the last verified holder balances while the public RPC recovers\. /,'')}
      :unavailable(mint);
  }
  refreshing(mint,old){const value=this.staleOrUnavailable(mint,old);return {...value,refreshing:true,note:value.available?value.note:'Holder balances are loading. Updates will appear automatically.'};}
  async wait(job,mint,old){
    let timer;
    try{return await Promise.race([job,new Promise(resolve=>{timer=setTimeout(()=>resolve(this.refreshing(mint,old)),this.waitMs);})]);}
    finally{clearTimeout(timer);}
  }
  async read(mint,launch){
    this.queue.drain();
    const key=new PublicKey(mint),old=this.cache.get(mint);
    if(old&&old.until>this.now())return old.value;
    if(this.pending.has(mint)){const job=this.pending.get(mint),previous=this.refreshing(mint,old);return previous.available||!job.started?previous:this.wait(job,mint,old);}
    if(this.closed)return this.staleOrUnavailable(mint,old);
    const scheduled=this.queue.run(()=>this.collect(key,launch));
    if(!scheduled)return this.staleOrUnavailable(mint,old);
    const job=scheduled.catch(()=>this.staleOrUnavailable(mint,old)).then(value=>{
      if(!this.closed){this.cache.delete(mint);this.cache.set(mint,{value,until:this.now()+(value.available&&!value.stale?TTL:RETRY)});while(this.cache.size>1000)this.cache.delete(this.cache.keys().next().value);}
      return value;
    }).finally(()=>this.pending.delete(mint));Object.defineProperty(job,'started',{get:()=>scheduled.started});this.pending.set(mint,job);
    // Show verified cached balances immediately while their queued refresh runs.
    const previous=this.staleOrUnavailable(mint,old);
    if(previous.available||!scheduled.started)return this.refreshing(mint,old);
    return this.wait(job,mint,old);
  }
  async scan(c,mint,program){
    this.scanStarts=this.scanStarts.filter(at=>at>this.now()-60_000);
    if(this.scanStarts.length>=6)throw Error('Holder fallback is busy');
    this.scanStarts.push(this.now());
    const filters=[{memcmp:{offset:0,bytes:mint.toBase58()}},...(program.equals(TOKEN_PROGRAM_ID)?[{dataSize:165}]:[])];
    // Keep the token header + Token-2022 account type, not extensions/metadata.
    // The guarded transport additionally caps every RPC response at 16 MiB and
    // applies its timeout. A large mint is rejected rather than truncated and
    // presented as a misleading top-holder list.
    const rows=await c.getProgramAccounts(program,{commitment:'confirmed',filters,dataSlice:{offset:0,length:166}});
    if(!Array.isArray(rows)||rows.length>MAX_SCAN)invalid();
    return rows.map(row=>{
      const info=row.account,data=info?.data;
      if(!info||info.executable||!info.owner.equals(program)||!Buffer.isBuffer(data)||data.length<165||data.length>166||program.equals(TOKEN_PROGRAM_ID)&&data.length!==165||program.equals(TOKEN_2022_PROGRAM_ID)&&data.length===166&&data[165]!==2||!data.subarray(0,32).equals(mint.toBuffer())||![1,2].includes(data[108]))invalid();
      return {address:new PublicKey(row.pubkey),owner:new PublicKey(data.subarray(32,64)),amount:data.readBigUInt64LE(64)};
    });
  }
  async collect(mint,launch){
    const c=(await this.chain()).c;
    const [mintResult,largestResult]=await Promise.allSettled([c.getAccountInfo(mint,'confirmed'),c.getTokenLargestAccounts(mint,'confirmed')]);
    if(mintResult.status!=='fulfilled')throw mintResult.reason;
    const info=mintResult.value;
    if(!info||info.executable||!tokenProgram(info.owner))invalid();
    const mintState=unpackMint(mint,info,info.owner);
    if(!mintState.isInitialized||mintState.decimals<0||mintState.decimals>18)invalid();
    let accounts;
    if(largestResult.status==='fulfilled'){
      const largest=largestResult.value;
      if(!Array.isArray(largest?.value)||largest.value.length>20)invalid();
      const addresses=largest.value.map(row=>new PublicKey(row.address));
      if(new Set(addresses.map(key=>key.toBase58())).size!==addresses.length)invalid();
      const infos=addresses.length?await c.getMultipleAccountsInfo(addresses,'confirmed'):[];
      if(!Array.isArray(infos)||infos.length!==addresses.length)invalid();
      accounts=infos.flatMap((accountInfo,index)=>{
        if(!accountInfo)return [];
        if(accountInfo.executable||!accountInfo.owner.equals(info.owner))invalid();
        const account=unpackAccount(addresses[index],accountInfo,info.owner);
        if(!account.mint.equals(mint)||!account.isInitialized)invalid();
        return [account];
      });
    }else{
      accounts=await this.scan(c,mint,info.owner);
    }
    const total=mintState.supply,decimals=mintState.decimals,vaults=holderLpVaults(mint,launch),seen=new Set();
    let listed=0n;
    for(const account of accounts){const address=account.address.toBase58();if(seen.has(address))invalid();seen.add(address);listed+=account.amount;}
    if(listed>total)invalid();
    const holders=accounts.filter(account=>account.amount>0n).sort((a,b)=>a.amount===b.amount?0:a.amount>b.amount?-1:1).slice(0,20).map(account=>{
      const wallet=account.owner.toBase58(),tokenAccount=account.address.toBase58(),lp=vaults.get(tokenAccount),isLp=lp?.authority===wallet;
      return {wallet,tokenAccount,amount:formatUnits(account.amount,decimals),percent:total>0n?Number(account.amount*100000000n/total)/1000000:null,isLp,lpType:isLp?lp.lpType:null};
    });
    return {mint:mint.toBase58(),available:true,stale:false,holders,at:this.now(),refreshMs:TTL,note:'Largest 20 token accounts, including verified LP vaults. One wallet can own multiple accounts; this is not a complete holder count.'};
  }
  async close(){this.closed=true;this.queue.close();await Promise.allSettled(this.pending.values());this.cache.clear();}
}
