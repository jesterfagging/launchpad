import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Keypair,PublicKey,ComputeBudgetProgram,TransactionMessage,VersionedTransaction,SystemProgram,SystemInstruction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,NATIVE_MINT,MintLayout,AccountLayout,getAssociatedTokenAddressSync,decodeTransferCheckedInstruction} from '@solana/spl-token';
import BN from 'bn.js';
import {protocolLiquiditySnapshot,protocolLiquidityTerms,decodeProtocolLiquidityLock,buildProtocolLiquidityClaim} from '../src/launchpad-protocol-liquidity.mjs';
import {LaunchChain,newLaunchKeys} from '../src/launchpad-chain.mjs';
import {protocolWalletView,managedProtocolWallet} from '../src/launchpad-protocol-wallet.mjs';
const ray=createRequire(import.meta.url)('@raydium-io/raydium-sdk-v2'),key=()=>Keypair.generate().publicKey,bn=value=>new BN(String(value));
const discriminator=name=>createHash('sha256').update('account:'+name).digest().subarray(0,8);
function rayAccount(layout,name,owner,patch){const data=Buffer.alloc(layout.span);layout.encode({...layout.decode(data),...patch},data);discriminator(name).copy(data);return{data,owner,executable:false,lamports:1};}
function mintAccount(decimals,program=TOKEN_PROGRAM_ID,{supply=1000000000n,authority=null}={}){const data=Buffer.alloc(MintLayout.span);MintLayout.encode({mintAuthorityOption:authority?1:0,mintAuthority:authority||PublicKey.default,supply,decimals,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},data);return{data,owner:program,executable:false,lamports:1};}
function tokenAccount(mint,owner,amount=1000000000n,program=TOKEN_PROGRAM_ID){const data=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint,owner,amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);return{data,owner:program,executable:false,lamports:1};}
function fixture({tax=0,quote=NATIVE_MINT,quoteDecimals=9,quoteProgram=TOKEN_PROGRAM_ID}={}){
 const w=key(),m=key(),q=quote,admin=key(),cpConfig=key(),p=key(),recipient=key(),nftMint=key(),program=ray.LAUNCHPAD_PROGRAM;
 const auth=ray.getPdaLaunchpadAuth(program).publicKey,platform=ray.getPdaPlatformId(program,admin).publicKey;
 const [a,b]=[m,q].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer())),baseProgram=tax?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,programA=a.equals(m)?baseProgram:quoteProgram,programB=b.equals(m)?baseProgram:quoteProgram;
 const pool=ray.getCpmmPdaPoolId(ray.CREATE_CPMM_POOL_PROGRAM,cpConfig,a,b).publicKey,lpMint=ray.getPdaLpMint(ray.CREATE_CPMM_POOL_PROGRAM,pool).publicKey,cpAuth=ray.CREATE_CPMM_POOL_AUTH;
 const vaultA=ray.getPdaVault(ray.CREATE_CPMM_POOL_PROGRAM,pool,a).publicKey,vaultB=ray.getPdaVault(ray.CREATE_CPMM_POOL_PROGRAM,pool,b).publicKey;
 const lockPda=ray.getCpLockPda(ray.LOCK_CPMM_PROGRAM,nftMint).publicKey,nftAta=getAssociatedTokenAddressSync(nftMint,w),lockVault=getAssociatedTokenAddressSync(lpMint,ray.LOCK_CPMM_AUTH,true);
 const l={feeCustody:'relay',keys:{wallet:{address:String(w)},payer:{address:String(p)},mint:{address:String(m)},platform:{address:String(admin)}},input:{quoteMint:String(q),creatorFeeBps:25,taxBps:tax},review:{quoteProgram:String(quoteProgram),quoteDecimals,cpConfigId:String(cpConfig),protocolFees:{lpPolicy:'platform_locked',platformLpPercent:75,recipient:String(recipient)}}};
 const poolFields={configId:cpConfig,poolCreator:w,mintA:a,mintB:b,mintLp:lpMint,vaultA,vaultB,mintProgramA:programA,mintProgramB:programB,lpDecimals:9,mintDecimalA:a.equals(m)?6:quoteDecimals,mintDecimalB:b.equals(m)?6:quoteDecimals,enableCreatorFee:true,lpAmount:bn(1000000000)};
 const platformFields={cpConfigId:cpConfig,platformLockNftWallet:w,platformScale:bn(750000),creatorScale:bn(0),burnScale:bn(250000),creatorFeeRate:bn(2500)};
 const values=new Map(),put=(key,value)=>values.set(String(key),value);
 const updatePool=patch=>put(pool,rayAccount(ray.CpmmPoolInfoLayout,'PoolState',ray.CREATE_CPMM_POOL_PROGRAM,{...poolFields,...patch})),updatePlatform=patch=>put(platform,rayAccount(ray.PlatformConfig,'PlatformConfig',program,{...platformFields,...patch}));updatePool({});updatePlatform({});
 put(a,mintAccount(a.equals(m)?6:quoteDecimals,programA));put(b,mintAccount(b.equals(m)?6:quoteDecimals,programB));put(lpMint,mintAccount(9,TOKEN_PROGRAM_ID,{authority:cpAuth}));put(vaultA,tokenAccount(a,cpAuth,100000000000n,programA));put(vaultB,tokenAccount(b,cpAuth,100000000000n,programB));put(lockVault,tokenAccount(lpMint,ray.LOCK_CPMM_AUTH));put(nftMint,mintAccount(0,TOKEN_PROGRAM_ID,{supply:1n}));put(nftAta,tokenAccount(nftMint,w,1n));
 const data=Buffer.alloc(256);discriminator('LockedCpLiquidityState').copy(data);data.writeBigUInt64LE(750000000n,8);pool.toBuffer().copy(data,64);nftMint.toBuffer().copy(data,96);auth.toBuffer().copy(data,128);lpMint.toBuffer().copy(data,160);put(lockPda,{owner:ray.LOCK_CPMM_PROGRAM,executable:false,lamports:1,data});
 const requests=[];let rows=[{pubkey:lockPda,account:values.get(String(lockPda))}],slot=100;
 const chain={addresses:()=>({w,m,q,p,admin,auth,platform,program}),migratedRayPool:async()=>({key:pool}),c:{getProgramAccounts:async(program,options)=>{requests.push({type:'scan',program,options});return{context:{slot:100},value:rows};},getMultipleAccountsInfoAndContext:async(keys,options)=>{requests.push({type:'snapshot',keys,options});return{context:{slot},value:keys.map(k=>values.get(String(k))||null)};}}};
 return{l,chain,values,put,updatePool,updatePlatform,requests,w,m,q,auth,platform,pool,lpMint,nftMint,nftAta,lockPda,lockVault,vaultA,vaultB,baseProgram,programA,programB,a,b,set rows(value){rows=value;},set slot(value){slot=value;}};
}

test('liquidity settings retain historical 100% burn and explicitly snapshot new platform shares',()=>{
 assert.deepEqual(protocolLiquiditySnapshot(),{lpPolicy:'burn',platformLpPercent:0});assert.equal(protocolLiquidityTerms().burnScale,'1000000');
 const policy={lpPolicy:'platform_locked'},snapshot=protocolLiquiditySnapshot(policy),terms=protocolLiquidityTerms(snapshot);assert.equal(snapshot.platformLpPercent,75);assert.equal(terms.platformScale,'750000');assert.equal(terms.creatorScale,'0');assert.equal(terms.burnScale,'250000');assert.match(terms.description,/75% of migration LP is permanently locked; 25% is burned/);assert.equal(policy.platformLpPercent,undefined);
 for(const platformLpPercent of [0,101,-1,1.5,'75',NaN])assert.throws(()=>protocolLiquidityTerms({lpPolicy:'platform_locked',platformLpPercent}),/whole percentage/);
 assert.throws(()=>protocolLiquidityTerms({lpPolicy:'maybe'}),/valid post-graduation/);assert.equal(protocolLiquidityTerms({lpPolicy:'platform_locked',platformLpPercent:100}).burnScale,'0');
});

test('legacy burned LP and tokens still on the curve never query or claim a locked position',async()=>{
 const h=fixture();h.l.review.protocolFees.lpPolicy='burn';assert.deepEqual(await buildProtocolLiquidityClaim({},h.l),[]);h.l.review.protocolFees.lpPolicy='platform_locked';h.chain.migratedRayPool=async()=>null;assert.deepEqual(await buildProtocolLiquidityClaim(h.chain,h.l),[]);assert.equal(h.requests.length,0);
});

test('harvest is bound to the launch migration Fee Key and emits only fee collection into exact host ATAs',async()=>{
 const h=fixture(),before=JSON.stringify(h.l),ixs=await buildProtocolLiquidityClaim(h.chain,h.l);assert.equal(ixs.length,3);assert(ixs.slice(0,2).every(ix=>ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)));
 const collect=ixs[2];assert(collect.programId.equals(ray.LOCK_CPMM_PROGRAM));assert.deepEqual([...collect.data.subarray(0,8)],[8,30,51,199,209,184,247,133]);assert.equal(collect.data.readBigUInt64LE(8),18446744073709551615n);
 assert(collect.keys[1].pubkey.equals(h.w));assert(collect.keys[1].isSigner);assert(collect.keys[2].pubkey.equals(h.nftAta));assert(collect.keys[3].pubkey.equals(h.lockPda));assert(collect.keys[6].pubkey.equals(h.pool));assert(collect.keys[7].pubkey.equals(h.lpMint));
 assert(collect.keys[8].pubkey.equals(getAssociatedTokenAddressSync(h.a,h.w,false,h.programA)));assert(collect.keys[9].pubkey.equals(getAssociatedTokenAddressSync(h.b,h.w,false,h.programB)));assert(collect.keys[14].pubkey.equals(h.lockVault));
 assert.equal(JSON.stringify(h.l),before,'building never credits balances or rewrites saved terms');assert.equal(h.requests[0].options.commitment,'finalized');assert.deepEqual(h.requests[0].options.filters,[{dataSize:256},{memcmp:{offset:64,bytes:String(h.pool)}},{memcmp:{offset:128,bytes:String(h.auth)}}]);assert.equal(h.requests[1].options.minContextSlot,100);
});

test('Token-2022 base fees use their own canonical ATA without unwrapping or swapping quote fees',async()=>{
 const h=fixture({tax:300}),ixs=await buildProtocolLiquidityClaim(h.chain,h.l),baseAta=getAssociatedTokenAddressSync(h.m,h.w,false,TOKEN_2022_PROGRAM_ID),quoteAta=getAssociatedTokenAddressSync(h.q,h.w);
 assert(ixs[2].keys.some(k=>k.pubkey.equals(baseAta)));assert(ixs[2].keys.some(k=>k.pubkey.equals(quoteAta)));assert.equal(ixs.filter(ix=>ix.programId.equals(TOKEN_PROGRAM_ID)||ix.programId.equals(TOKEN_2022_PROGRAM_ID)).length,0,'no transfer, sale, burn or WSOL close instructions are added');
});

test('all launched fee modes collect locked LP through the selected signer and pay both assets only to treasury',async()=>{
 for(const feeMode of ['creator','holders','buyback'])for(const quote of [
  {quote:NATIVE_MINT,quoteDecimals:9,quoteProgram:TOKEN_PROGRAM_ID},
  {quote:key(),quoteDecimals:6,quoteProgram:TOKEN_PROGRAM_ID},
  {quote:key(),quoteDecimals:8,quoteProgram:TOKEN_2022_PROGRAM_ID},
 ]){
  const h=fixture({...quote,tax:feeMode==='holders'?200:0}),wallet=newLaunchKeys().wallet,owner=new PublicKey(wallet.address),rewards=key(),treasury=new PublicKey(h.l.review.protocolFees.recipient);
  h.l.input.feeMode=feeMode;h.l.keys.protocol=wallet;h.l.keys.rewards={address:String(rewards)};h.l.protocolFeeWallet={source:'protocol',address:wallet.address};
  h.l.credits={base:'101',quote:'103'};h.l.cycle={stage:'payout',index:2,payouts:[{owner:String(rewards),amount:'103'}]};
  h.updatePlatform({platformLockNftWallet:owner});const nftAta=getAssociatedTokenAddressSync(h.nftMint,owner);h.put(nftAta,tokenAccount(h.nftMint,owner,1n));h.values.delete(String(h.nftAta));
  const before=structuredClone(h.l),ixs=await buildProtocolLiquidityClaim(h.chain,h.l),claim=ixs.at(-1);
  assert(claim.keys[1].pubkey.equals(owner));assert(claim.keys[1].isSigner);assert(claim.keys[2].pubkey.equals(nftAta));
  assert(claim.keys[8].pubkey.equals(getAssociatedTokenAddressSync(h.a,owner,false,h.programA)));assert(claim.keys[9].pubkey.equals(getAssociatedTokenAddressSync(h.b,owner,false,h.programB)));
  assert(!claim.keys.some(item=>item.pubkey.equals(rewards)),'LP collection never credits the rewards wallet');
  const chain=new LaunchChain({network:'mainnet-beta',connection:{getAccountInfo:async address=>h.values.get(String(address))||null,getMinimumBalanceForRentExemption:async()=>2039280}});
  const payout=await chain.protocolPayoutInstructions(h.l,{quote:'7',base:'11'}),base=decodeTransferCheckedInstruction(payout.at(-1),h.baseProgram);
  assert(base.keys.owner.pubkey.equals(owner));assert(base.keys.destination.pubkey.equals(getAssociatedTokenAddressSync(h.m,treasury,false,h.baseProgram)));assert.equal(base.data.amount,11n);
  if(h.q.equals(NATIVE_MINT)){
   const transfers=payout.filter(ix=>ix.programId.equals(SystemProgram.programId)&&SystemInstruction.decodeInstructionType(ix)==='Transfer').map(ix=>SystemInstruction.decodeTransfer(ix));
   assert.equal(transfers.length,1);assert(transfers[0].fromPubkey.equals(owner));assert(transfers[0].toPubkey.equals(treasury));assert.equal(transfers[0].lamports,7n);
  }else{
   const quoteTransfer=decodeTransferCheckedInstruction(payout[1],quote.quoteProgram);
   assert(quoteTransfer.keys.owner.pubkey.equals(owner));assert(quoteTransfer.keys.destination.pubkey.equals(getAssociatedTokenAddressSync(h.q,treasury,false,quote.quoteProgram)));assert.equal(quoteTransfer.data.amount,7n);assert.equal(quoteTransfer.data.decimals,quote.quoteDecimals);
  }
  assert.deepEqual(h.l,before,'LP collection leaves holder/buyback credits and saved cycle untouched');
  h.updatePool({poolCreator:owner});await assert.rejects(buildProtocolLiquidityClaim(h.chain,h.l),/pool identity differs/);
 }
});

test('fee harvest fits a Solana transaction without a second signer or lookup table',async()=>{
 const h=fixture({tax:300}),instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:600000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}),...await buildProtocolLiquidityClaim(h.chain,h.l)];
 const tx=new VersionedTransaction(new TransactionMessage({payerKey:h.w,recentBlockhash:PublicKey.default.toBase58(),instructions}).compileToV0Message());assert.equal(tx.message.header.numRequiredSignatures,1);assert(tx.serialize().length<=1232,'locked LP collection must fit the wire limit');
});

test('confirmed dynamic creator rates are accepted while unconfirmed or mismatched rates fail closed',async()=>{
 const h=fixture();h.l.review.creatorFeeRatePpm=2500;h.l.creatorFees={ratePpm:4500};h.updatePlatform({creatorFeeRate:bn(4500)});assert.equal((await buildProtocolLiquidityClaim(h.chain,h.l)).length,3);h.updatePlatform({creatorFeeRate:bn(2500)});await assert.rejects(buildProtocolLiquidityClaim(h.chain,h.l),/creator-fee stream/);
});

test('policy, pool, vault, mint and fee-key custody substitutions are rejected',async()=>{
 const cases=[
  h=>{h.l.feeCustody='legacy';},
  h=>{h.l.keys.wallet.exportedAt=1;},
  h=>{h.updatePlatform({platformLockNftWallet:key()});},
  h=>{h.updatePlatform({platformScale:bn(250000),burnScale:bn(750000)});},
  h=>{h.updatePool({configId:key()});},
  h=>{h.updatePool({poolCreator:key()});},
  h=>{h.updatePool({enableCreatorFee:false});},
  h=>{h.updatePlatform({cpConfigId:key()});},
  h=>{h.l.review.protocolFees.recipient=String(h.w);},
  h=>{h.updatePool({vaultA:key()});},
  h=>{h.updatePool({mintProgramA:key()});},
  h=>{h.put(h.vaultA,tokenAccount(h.a,key(),1n,h.programA));},
  h=>{h.put(h.lpMint,mintAccount(9,TOKEN_PROGRAM_ID,{authority:key()}));},
  h=>{h.put(h.nftMint,mintAccount(0,TOKEN_PROGRAM_ID,{supply:2n}));},
  h=>{h.put(h.nftAta,tokenAccount(h.nftMint,key(),1n));},
  h=>{h.put(h.nftAta,tokenAccount(h.nftMint,h.w,0n));},
  h=>{h.put(h.nftAta,null);},
  h=>{h.slot=99;},
 ];
 for(const mutate of cases){const h=fixture();mutate(h);await assert.rejects(buildProtocolLiquidityClaim(h.chain,h.l));}
});

test('locker provenance cannot use donated positions, another pool, forged owner, discriminator or PDA',async()=>{
 for(const mutate of [data=>key().toBuffer().copy(data,64),data=>key().toBuffer().copy(data,128),data=>key().toBuffer().copy(data,160),data=>{data[0]^=1;}]){const h=fixture(),account=h.values.get(String(h.lockPda));mutate(account.data);await assert.rejects(buildProtocolLiquidityClaim(h.chain,h.l));}
 const h=fixture(),account=h.values.get(String(h.lockPda));assert.throws(()=>decodeProtocolLiquidityLock(key(),account),/address/);assert.throws(()=>decodeProtocolLiquidityLock(h.lockPda,{...account,owner:TOKEN_PROGRAM_ID}),/account/);assert.throws(()=>decodeProtocolLiquidityLock(h.lockPda,{...account,executable:true}),/account/);
 h.rows=Array(5).fill({pubkey:h.lockPda,account});await assert.rejects(buildProtocolLiquidityClaim(h.chain,h.l),/lookup/);
});

test('missing or changed migration lock records never fall back to an arbitrary wallet NFT',async()=>{
 const h=fixture();h.rows=[];await assert.rejects(buildProtocolLiquidityClaim(h.chain,h.l),/not been found/);
 const next=fixture();next.rows=[{pubkey:next.lockPda,account:next.values.get(String(next.lockPda))},{pubkey:next.lockPda,account:next.values.get(String(next.lockPda))}];await assert.rejects(buildProtocolLiquidityClaim(next.chain,next.l),/Duplicate/);
});

test('legacy LP Fee Key can belong to the platform signer while CPMM creator fees retain the original creator',async()=>{
  const h=fixture(),owner=new PublicKey(h.l.keys.platform.address);delete h.l.feeCustody;h.l.keys.payer=h.l.keys.wallet;h.l.walletExportedAt=1;h.l.protocolFeeWallet={source:'platform',address:String(owner)};
  h.updatePlatform({platformLockNftWallet:owner});const nftAta=getAssociatedTokenAddressSync(h.nftMint,owner);h.put(nftAta,tokenAccount(h.nftMint,owner,1n));h.values.delete(String(h.nftAta));
  const ixs=await buildProtocolLiquidityClaim(h.chain,h.l);assert.equal(ixs.length,3);assert(ixs[2].keys[1].pubkey.equals(owner));assert(ixs[2].keys[2].pubkey.equals(nftAta));assert(ixs[2].keys[8].pubkey.equals(getAssociatedTokenAddressSync(h.a,owner,false,h.programA)));assert(ixs[2].keys[9].pubkey.equals(getAssociatedTokenAddressSync(h.b,owner,false,h.programB)));
  h.updatePool({poolCreator:owner});await assert.rejects(buildProtocolLiquidityClaim(h.chain,h.l),/pool identity differs/);
  h.updatePool({});h.l.keys.platform.exportedAt=1;await assert.rejects(buildProtocolLiquidityClaim(h.chain,h.l),/dedicated Launchpad/);
});

test('fresh protocol LP wallet signs harvests and exact asset payouts while the original creator keeps CPMM creator fees',async()=>{
  const h=fixture({tax:300}),wallet=newLaunchKeys().wallet,owner=new PublicKey(wallet.address);
  delete h.l.feeCustody;h.l.keys.protocol=wallet;h.l.protocolFeeWallet={source:'protocol',address:wallet.address};
  // The old administrator may also be the user's funding wallet. Its export
  // history does not turn the new, separate protocol recipient into that wallet.
  h.l.keys.payer=h.l.keys.platform;h.l.keys.platform.exportedAt=1;h.l.walletExportedAt=1;
  h.l.creatorFees={ratePpm:5000};h.updatePlatform({platformLockNftWallet:owner,creatorFeeRate:bn(5000)});
  h.updatePool({creatorFeesMintA:bn(3),creatorFeesMintB:bn(5)});
  const nftAta=getAssociatedTokenAddressSync(h.nftMint,owner),baseAta=getAssociatedTokenAddressSync(h.m,owner,false,TOKEN_2022_PROGRAM_ID),quoteAta=getAssociatedTokenAddressSync(h.q,owner);
  h.put(nftAta,tokenAccount(h.nftMint,owner,1n));h.values.delete(String(h.nftAta));
  h.put(baseAta,tokenAccount(h.m,owner,10n,TOKEN_2022_PROGRAM_ID));h.put(quoteAta,tokenAccount(h.q,owner,20n));
  const chain=new LaunchChain({network:'mainnet-beta',connection:{...h.chain.c,getAccountInfo:async address=>h.values.get(String(address))||null,getLatestBlockhash:async()=>({blockhash:String(key()),lastValidBlockHeight:100}),getMinimumBalanceForRentExemption:async()=>2039280}});
  chain.simulatePrepared=async(_tx,options)=>{
    if(options.accounts){
      assert.deepEqual(options.accounts.addresses,[String(quoteAta),String(baseAta)]);
      const accounts=[tokenAccount(h.q,owner,23n),tokenAccount(h.m,owner,15n,TOKEN_2022_PROGRAM_ID)].map(account=>({...account,owner:String(account.owner),data:[account.data.toString('base64'),'base64']}));
      return {context:{slot:100},value:{err:null,unitsConsumed:10000,accounts}};
    }
    return {context:{slot:100},value:{err:null,unitsConsumed:10000}};
  };
  const before=structuredClone(h.l);assert.equal(managedProtocolWallet(h.l),true);
  const harvest=await chain.protocolLiquidityInstructions(h.l,{automatic:true});assert.equal(harvest.protocolHarvestMinimum,true);assert.equal(harvest.length,3);
  assert(harvest[2].keys[1].pubkey.equals(owner));assert(harvest[2].keys[2].pubkey.equals(nftAta));
  assert(harvest[2].keys[8].pubkey.equals(getAssociatedTokenAddressSync(h.a,owner,false,h.programA)));assert(harvest[2].keys[9].pubkey.equals(getAssociatedTokenAddressSync(h.b,owner,false,h.programB)));
  const prepared=await chain.prepare(protocolWalletView(h.l),harvest),signed=VersionedTransaction.deserialize(Buffer.from(prepared.raw,'base64'));
  assert.equal(signed.message.staticAccountKeys[0].toBase58(),wallet.address);assert.equal(signed.message.header.numRequiredSignatures,1);assert(signed.signatures[0].some(byte=>byte!==0));
  const creator=await chain.claimInstructions(h.l,'creator');assert.equal(creator.length,3);assert(creator.at(-1).keys.filter(item=>item.isSigner).every(item=>item.pubkey.equals(h.w)));
  for(const mint of [{key:h.a,program:h.programA},{key:h.b,program:h.programB}])assert(creator.at(-1).keys.some(item=>item.pubkey.equals(getAssociatedTokenAddressSync(mint.key,h.w,false,mint.program))));
  const payout=await chain.protocolPayoutInstructions(h.l,{quote:'3',base:'5'}),base=decodeTransferCheckedInstruction(payout.at(-1),TOKEN_2022_PROGRAM_ID),treasury=new PublicKey(h.l.review.protocolFees.recipient);
  assert(base.keys.owner.pubkey.equals(owner));assert(base.keys.source.pubkey.equals(baseAta));assert(base.keys.destination.pubkey.equals(getAssociatedTokenAddressSync(h.m,treasury,false,TOKEN_2022_PROGRAM_ID)));assert.equal(base.data.amount,5n);
  const sol=payout.filter(ix=>ix.programId.equals(SystemProgram.programId)&&SystemInstruction.decodeInstructionType(ix)==='Transfer').map(ix=>SystemInstruction.decodeTransfer(ix));
  assert.equal(sol.length,1);assert(sol[0].fromPubkey.equals(owner));assert(sol[0].toPubkey.equals(treasury));assert.equal(sol[0].lamports,3n);
  const payoutTx=VersionedTransaction.deserialize(Buffer.from((await chain.prepare(protocolWalletView(h.l),payout)).raw,'base64'));
  assert.equal(payoutTx.message.staticAccountKeys[0].toBase58(),wallet.address);assert.equal(payoutTx.message.header.numRequiredSignatures,1);assert.deepEqual(h.l,before);
  h.updatePool({poolCreator:owner});await assert.rejects(chain.protocolLiquidityInstructions(h.l),/creator-fee policy|pool identity differs/);
});
