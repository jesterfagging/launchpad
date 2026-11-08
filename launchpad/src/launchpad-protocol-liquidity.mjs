import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackAccount,unpackMint,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import BN from 'bn.js';
import {effectiveCreatorFeeRate} from '../public/creator-fee-schedule.mjs';
import {managedProtocolWallet,protocolWalletKey} from './launchpad-protocol-wallet.mjs';
const ray=createRequire(import.meta.url)('@raydium-io/raydium-sdk-v2');
const fail=message=>{throw Object.assign(Error(message),{statusCode:400});};
const ok=(value,message)=>{if(!value)fail(message);};

/** Capture allocation only when a new launch is reviewed. Missing historical
 * policy always means the original 100% burn; no implicit legacy migration. */
export function protocolLiquiditySnapshot(policy={}) {
  const lpPolicy=policy?.lpPolicy??'burn';
  ok(['burn','platform_locked'].includes(lpPolicy),'Choose a valid post-graduation liquidity policy.');
  if(lpPolicy==='burn')return{lpPolicy,platformLpPercent:0};
  const platformLpPercent=policy.platformLpPercent??75;
  ok(Number.isInteger(platformLpPercent)&&platformLpPercent>=1&&platformLpPercent<=100,'The platform LP share must be a whole percentage from 1 to 100.');
  return{lpPolicy,platformLpPercent};
}

export function protocolLiquidityTerms(policy={}) {
  const value=protocolLiquiditySnapshot(policy),locked=value.platformLpPercent,burn=100-locked;
  return{...value,burnLpPercent:burn,platformScale:String(locked*10000),creatorScale:'0',burnScale:String(burn*10000),
    description:locked?`${locked}% of migration LP is permanently locked; ${burn}% is burned. Creator fees remain separately claimable.`:'100% of migration LP is burned; creator fees remain separately claimable'};
}

const U64_MAX='18446744073709551615';
const lockDiscriminator=createHash('sha256').update('account:LockedCpLiquidityState').digest().subarray(0,8);
const same=(a,b)=>a?.equals?.(b)===true;
function decode(account,program,layout,name){
  ok(account&&!account.executable&&same(account.owner,program)&&account.data.length>=layout.span,`The ${name} account is invalid.`);
  ok(account.data.subarray(0,8).equals(createHash('sha256').update('account:'+name).digest().subarray(0,8)),`The ${name} discriminator is invalid.`);
  return layout.decode(account.data);
}

/** Official Raydium locking CPI layout: states.rs LockedCpLiquidityState.
 * The owner field is the original liquidity owner, not the current NFT holder. */
export function decodeProtocolLiquidityLock(address,account){
  ok(account&&!account.executable&&same(account.owner,ray.LOCK_CPMM_PROGRAM)&&account.data.length===256,'The platform LP lock account is invalid.');
  const data=account.data;ok(data.subarray(0,8).equals(lockDiscriminator),'The platform LP lock discriminator is invalid.');
  const value={address:new PublicKey(address),lockedLpAmount:data.readBigUInt64LE(8),claimedLpAmount:data.readBigUInt64LE(16),unclaimedLpAmount:data.readBigUInt64LE(24),pool:new PublicKey(data.subarray(64,96)),nftMint:new PublicKey(data.subarray(96,128)),lockedOwner:new PublicKey(data.subarray(128,160)),lpMint:new PublicKey(data.subarray(160,192))};
  ok(same(value.address,ray.getCpLockPda(ray.LOCK_CPMM_PROGRAM,value.nftMint).publicKey),'The platform LP lock address is invalid.');
  return value;
}

/** Build only a fee harvest, never an LP withdrawal. Raydium's documented
 * collect_cp_fees argument is u64::MAX; the locker calculates the fee portion
 * onchain and retains permanently locked principal. No price/API estimate is
 * used to authorize a withdrawal. The collector must journal and confirm this
 * operation before crediting its actual base/quote deltas or forwarding them. */
export async function buildProtocolLiquidityClaim(chain,launch){
  const terms=protocolLiquidityTerms(launch.review?.protocolFees);
  if(terms.lpPolicy==='burn')return[];
  ok(managedProtocolWallet(launch,{requireSecret:false}),'Platform LP fees require the dedicated Launchpad signing wallet.');
  const {w:creator,m,q,auth,platform,program}=chain.addresses(launch),w=new PublicKey(protocolWalletKey(launch).address);
  let recipient;try{recipient=new PublicKey(launch.review.protocolFees.recipient);}catch{fail('The platform LP treasury recipient is invalid.');}
  ok(PublicKey.isOnCurve(recipient.toBytes())&&!recipient.equals(w),'The platform LP treasury recipient is invalid.');
  const migrated=await chain.migratedRayPool(launch);if(!migrated)return[];
  const [mintA,mintB]=[m,q].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer())),cpProgram=ray.CREATE_CPMM_POOL_PROGRAM;
  const pool=ray.getCpmmPdaPoolId(cpProgram,new PublicKey(launch.review.cpConfigId),mintA,mintB).publicKey;
  ok(same(migrated.key,pool),'The migrated LP pool differs from this launch.');
  const lpMint=ray.getPdaLpMint(cpProgram,pool).publicKey,cpAuth=ray.getPdaPoolAuthority(cpProgram).publicKey;
  const vaultA=ray.getPdaVault(cpProgram,pool,mintA).publicKey,vaultB=ray.getPdaVault(cpProgram,pool,mintB).publicKey;
  const lockVault=getAssociatedTokenAddressSync(lpMint,ray.LOCK_CPMM_AUTH,true,TOKEN_PROGRAM_ID);
  const scan=await chain.c.getProgramAccounts(ray.LOCK_CPMM_PROGRAM,{commitment:'finalized',withContext:true,filters:[{dataSize:256},{memcmp:{offset:64,bytes:pool.toBase58()}},{memcmp:{offset:128,bytes:auth.toBase58()}}]});
  ok(Number.isSafeInteger(scan?.context?.slot)&&scan.context.slot>0&&Array.isArray(scan.value)&&scan.value.length<=4,'The platform Fee Key lookup could not be verified.');
  const seen=new Set(),locks=scan.value.map(row=>{const lock=decodeProtocolLiquidityLock(row.pubkey,row.account);ok(!seen.has(lock.address.toBase58()),'Duplicate platform LP lock.');seen.add(lock.address.toBase58());ok(same(lock.pool,pool)&&same(lock.lpMint,lpMint)&&same(lock.lockedOwner,auth),'The platform LP lock does not belong to this migration.');return lock;});
  ok(locks.length>0,'The platform Fee Key has not been found after graduation. Retry when migration is confirmed.');
  const nftAccounts=locks.map(lock=>getAssociatedTokenAddressSync(lock.nftMint,w,false,TOKEN_PROGRAM_ID));
  const keys=[pool,platform,mintA,mintB,lpMint,vaultA,vaultB,lockVault,...locks.flatMap((lock,i)=>[lock.address,lock.nftMint,nftAccounts[i]])];
  const snapshot=await chain.c.getMultipleAccountsInfoAndContext(keys,{commitment:'finalized',minContextSlot:scan.context.slot});
  ok(Number.isSafeInteger(snapshot?.context?.slot)&&snapshot.context.slot>=scan.context.slot&&Array.isArray(snapshot.value)&&snapshot.value.length===keys.length,'The platform LP snapshot could not be verified.');
  const [poolAccount,platformAccount,mintAAccount,mintBAccount,lpMintAccount,vaultAAccount,vaultBAccount,lockVaultAccount]=snapshot.value;
  const state=decode(poolAccount,cpProgram,ray.CpmmPoolInfoLayout,'PoolState'),platformState=decode(platformAccount,program,ray.PlatformConfig,'PlatformConfig');
  ok(same(state.configId,new PublicKey(launch.review.cpConfigId))&&same(state.poolCreator,creator)&&state.enableCreatorFee&&same(state.mintA,mintA)&&same(state.mintB,mintB)&&same(state.mintLp,lpMint)&&same(state.vaultA,vaultA)&&same(state.vaultB,vaultB),'The platform LP pool identity differs from this launch.');
  ok(same(platformState.cpConfigId,state.configId)&&same(platformState.platformLockNftWallet,w)&&platformState.platformScale.toString()===terms.platformScale&&platformState.creatorScale.toString()===terms.creatorScale&&platformState.burnScale.toString()===terms.burnScale,'The platform LP allocation differs from the reviewed launch.');
  ok(platformState.creatorFeeRate.toString()===String(effectiveCreatorFeeRate(launch)),'The creator-fee stream differs from the reviewed launch.');
  const baseProgram=launch.input.taxBps?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,quoteProgram=new PublicKey(launch.review.quoteProgram);
  ok([TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>same(quoteProgram,p)),'The quote token program is unsupported.');
  const tokenProgramA=same(mintA,m)?baseProgram:quoteProgram,tokenProgramB=same(mintB,m)?baseProgram:quoteProgram;
  ok(same(state.mintProgramA,tokenProgramA)&&same(state.mintProgramB,tokenProgramB),'The LP pool token programs differ from this launch.');
  const a=unpackMint(mintA,mintAAccount,tokenProgramA),b=unpackMint(mintB,mintBAccount,tokenProgramB),lp=unpackMint(lpMint,lpMintAccount,TOKEN_PROGRAM_ID);
  ok(a.isInitialized&&b.isInitialized&&lp.isInitialized&&a.decimals===(same(mintA,m)?6:launch.review.quoteDecimals)&&b.decimals===(same(mintB,m)?6:launch.review.quoteDecimals)&&lp.decimals===state.lpDecimals&&same(lp.mintAuthority,cpAuth),'The LP pool mints differ from this launch.');
  const verifyVault=(key,account,mint,program,owner)=>{const value=unpackAccount(key,account,program);ok(value.isInitialized&&!value.isFrozen&&same(value.mint,mint)&&same(value.owner,owner),'A platform LP vault is invalid.');return value;};
  verifyVault(vaultA,vaultAAccount,mintA,tokenProgramA,cpAuth);verifyVault(vaultB,vaultBAccount,mintB,tokenProgramB,cpAuth);verifyVault(lockVault,lockVaultAccount,lpMint,TOKEN_PROGRAM_ID,ray.LOCK_CPMM_AUTH);
  const owned=[];
  for(let i=0;i<locks.length;i++){
    const [lockAccount,nftMintAccount,nftAccount]=snapshot.value.slice(8+i*3,11+i*3),lock=decodeProtocolLiquidityLock(locks[i].address,lockAccount);
    ok(same(lock.pool,pool)&&same(lock.nftMint,locks[i].nftMint)&&same(lock.lpMint,lpMint)&&same(lock.lockedOwner,auth)&&lock.lockedLpAmount>0n,'The platform Fee Key lock changed.');
    if(!nftAccount)continue;
    const nft=unpackMint(lock.nftMint,nftMintAccount,TOKEN_PROGRAM_ID),holding=unpackAccount(nftAccounts[i],nftAccount,TOKEN_PROGRAM_ID);
    ok(nft.isInitialized&&nft.decimals===0&&nft.supply===1n&&holding.isInitialized&&!holding.isFrozen&&same(holding.mint,lock.nftMint)&&same(holding.owner,w)&&holding.amount===1n,'The platform Fee Key is not held by the dedicated Launchpad wallet.');
    owned.push({...lock,nftAccount:nftAccounts[i]});
  }
  ok(owned.length===1,'Exactly one platform migration Fee Key must be held by the dedicated Launchpad wallet.');
  const lock=owned[0],userVaultA=getAssociatedTokenAddressSync(mintA,w,false,tokenProgramA),userVaultB=getAssociatedTokenAddressSync(mintB,w,false,tokenProgramB);
  return[createAssociatedTokenAccountIdempotentInstruction(w,userVaultA,w,mintA,tokenProgramA),createAssociatedTokenAccountIdempotentInstruction(w,userVaultB,w,mintB,tokenProgramB),ray.collectCpFeeInstruction({programId:ray.LOCK_CPMM_PROGRAM,nftOwner:w,auth:ray.LOCK_CPMM_AUTH,nftMint:lock.nftMint,nftAccount:lock.nftAccount,lockPda:lock.address,poolId:pool,mintLp:lpMint,userVaultA,userVaultB,poolVaultA:vaultA,poolVaultB:vaultB,mintA,mintB,lockLpVault:lockVault,lpFeeAmount:new BN(U64_MAX),cpmmProgram:cpProgram,cpmmAuthProgram:cpAuth})];
}
