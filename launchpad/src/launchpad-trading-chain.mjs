import { randomUUID, createHash } from 'node:crypto';
import { PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, ACCOUNT_SIZE, AccountState, unpackMint, unpackAccount, getExtensionTypes, getExtensionData, ExtensionType, getDefaultAccountState, getPausableConfig, getTransferHook, getTransferFeeConfig, getEpochFee, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createInitializeAccount3Instruction, createCloseAccountInstruction } from '@solana/spl-token';
import BN from 'bn.js';
import bs58 from 'bs58';
import { LaunchChain, ray, decodeRay, signer, launchSimulationError } from './launchpad-chain.mjs';
import { units, displayUnits, requireValue as ok } from '../public/launchpad-model.mjs';
import { quoteConversion, buildConversion, SOL_ROUTE_ACCOUNT_BUDGETS } from './launchpad-trading-route.mjs';
import { verifySignedTransaction } from './providers.mjs';
import { quoteLabel } from '../public/quote-identity.mjs';
import { associatedTokenAccountSize } from './launchpad-token-account-size.mjs';
import { pumpAmmBalances, quotePumpAmm, preparePumpAmm } from './pump-public-amm.mjs';

const pk = value => new PublicKey(value), bn = value => new BN(String(value)), zero = () => bn(0);
const MAX_U64 = 18446744073709551615n, FEE_BUDGET = 19000n, QUOTE_TTL = 30000;
// Token-2022 extension 16 is ConfidentialTransferFeeConfig. The pinned SPL JS
// client leaves it out of its enum/account-size mapper. It is mint-only and
// governs optional confidential fees, not the public transfers used here.
const CONFIDENTIAL_TRANSFER_FEE_CONFIG = 16;
const supported = new Set([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer, ExtensionType.TokenMetadata, ExtensionType.InterestBearingConfig, ExtensionType.ScaledUiAmountConfig]);
// Some Raydium-approved equity quote assets carry issuer controls. They still
// support ordinary transfers while unpaused, unfrozen, and without an active
// transfer-hook program. Do not extend this exception to launch base tokens or
// use registration as blanket approval for unknown transfer behavior.
const registeredQuoteExtensions = new Set([...supported, ExtensionType.PermanentDelegate, ExtensionType.DefaultAccountState, ExtensionType.PausableConfig, ExtensionType.ConfidentialTransferMint, ExtensionType.TransferHook, CONFIDENTIAL_TRANSFER_FEE_CONFIG]);
const supportMintDiscriminator = createHash('sha256').update('account:SupportMintAssociated').digest().subarray(0,8);
function registeredQuote(key, account, program, bump) {
  return Boolean(account && !account.executable && account.owner.equals(program) && Buffer.isBuffer(account.data) && account.data.length===105 && account.data.subarray(0,8).equals(supportMintDiscriminator) && account.data[8]===bump && account.data.subarray(9,41).equals(key.toBuffer()));
}
const identity = launch => createHash('sha256').update(JSON.stringify([launch.keys.mint.address, launch.keys.wallet.address, (launch.keys.platform || launch.keys.wallet).address, launch.input.quoteMint, launch.review.configId, launch.review.cpConfigId, launch.input.taxBps || 0])).digest('hex');
const walletKey = value => { const key=pk(value); ok(PublicKey.isOnCurve(key.toBytes()), 'Choose a Solana wallet to trade.'); return key; };
function mintInfo(key, account, quoteRegistration=false) {
  ok(account && !account.executable && [TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(account.owner)), 'A trading mint has the wrong token program.');
  const mint=unpackMint(key,account,account.owner), extensions=getExtensionTypes(mint.tlvData);
  ok(mint.isInitialized && mint.decimals<=12, 'A trading mint is not initialized or has unsupported decimals.');
  if(!extensions.every(type=>supported.has(type))) {
    ok(quoteRegistration && account.owner.equals(TOKEN_2022_PROGRAM_ID) && extensions.every(type=>registeredQuoteExtensions.has(type)), 'This mint has unsupported token extensions.');
    if(extensions.includes(CONFIDENTIAL_TRANSFER_FEE_CONFIG)) {
      const confidentialFee=getExtensionData(CONFIDENTIAL_TRANSFER_FEE_CONFIG,mint.tlvData);
      // The onchain struct is 32 + 32 + 1 + 64 bytes and requires both the
      // ordinary fee config and confidential mint config. Never infer this
      // behavior from an arbitrary unknown extension or registry entry.
      ok(confidentialFee?.length===129 && confidentialFee[64]<=1 && extensions.filter(type=>type===CONFIDENTIAL_TRANSFER_FEE_CONFIG).length===1 && extensions.includes(ExtensionType.TransferFeeConfig) && extensions.includes(ExtensionType.ConfidentialTransferMint), 'The paired asset has an invalid confidential transfer fee configuration.');
    }
    const defaults=getDefaultAccountState(mint),pause=getPausableConfig(mint),hook=getTransferHook(mint);
    ok(!defaults || defaults.state===AccountState.Initialized, 'The paired asset requires frozen token accounts and cannot be traded here.');
    ok(!pause?.paused, 'The paired asset is paused by its issuer. Try again when transfers resume.');
    ok(!hook || hook.programId.equals(PublicKey.default), 'The paired asset has an active transfer hook that is not supported.');
  }
  return {key,program:account.owner,mint,extensions};
}
function tradingAccountLen(info) {
  return associatedTokenAccountSize(info);
}
function tokenAccount(key, info, mint, owner, optional=false) {
  if(!info && optional)return null;
  ok(info && !info.executable, 'A trading token account is unavailable.');
  const account=unpackAccount(key,info,mint.program);
  ok(account.isInitialized && !account.isFrozen && account.mint.equals(mint.key) && account.owner.equals(owner), 'A trading token account has an invalid mint, owner, or frozen state.');
  // ConfidentialTransferMint only adds optional confidential balances. We use
  // public transfers exclusively; an account may explicitly disable receiving
  // those. Token-2022's 295-byte ConfidentialTransferAccount stores
  // allow_non_confidential_credits at byte 262 (after the encrypted balances).
  const confidential=getExtensionData(ExtensionType.ConfidentialTransferAccount,account.tlvData);
  ok(!confidential || (confidential.length===295 && confidential[262]===1), 'A trading token account does not allow ordinary token transfers.');
  return account;
}
function activeFee(mint, epoch) {
  const fee=getTransferFeeConfig(mint.mint);
  if(!fee)return undefined;
  const schedule=getEpochFee(fee,BigInt(epoch));
  ok(schedule.transferFeeBasisPoints<10000, 'This mint has an unsupported transfer fee.');
  // The pinned SDK infers epochs from slot/432000. Pin both schedules to the
  // RPC's actual epoch so a pending Token-2022 fee cannot activate early.
  return {...fee,olderTransferFee:schedule,newerTransferFee:schedule};
}
function composeTradeInstructions(side,route,paired) {
  const ordered=route?(side==='buy'?[...route.instructions,...paired]:[...paired,...route.instructions]):paired;
  const seen=new Set(),instructions=ordered.filter(ix=>{
    // A route and the paired leg can each ensure the same destination ATA.
    // Only exact duplicate idempotent ATA instructions are redundant. Keep
    // every transfer, approval, close, swap and differently flagged creation.
    if(!ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)||ix.data.length!==1||ix.data[0]!==1)return true;
    const key=ix.data.toString('hex')+':'+ix.keys.map(meta=>[meta.pubkey.toBase58(),meta.isSigner,meta.isWritable].join(',')).join(';');
    if(seen.has(key))return false;seen.add(key);return true;
  });
  if(route?.lookupTables)instructions.lookupTables=route.lookupTables;
  return instructions;
}

function snapshot(response, length, minimum=0) {
  ok(Number.isSafeInteger(response?.context?.slot) && response.context.slot>=minimum && Array.isArray(response.value) && response.value.length===length, 'The RPC returned an incomplete trading snapshot.');
  return response;
}

/** Only direct, locally constructed Raydium trades for a saved Launchpad launch.
 * The trader never replaces the launch creator when deriving fee vaults. */
export class LaunchTradingChain extends LaunchChain {
  #intents = new WeakMap();
  #solIntents = new WeakMap();
  #routeBudgetHints = new Map();
  constructor(options={}) { super(options); this.tradeRoutes=options.tradeRoutes||{quoteConversion,buildConversion}; }

  rememberRouteBudget(key,budget) {
    // This bounded hint stores no quote, wallet, amount, balance or transaction.
    // It only avoids repeating recently oversized route searches on a retry.
    if(!SOL_ROUTE_ACCOUNT_BUDGETS.includes(budget))return;
    this.#routeBudgetHints.delete(key);
    this.#routeBudgetHints.set(key,{budget,expiresAt:Date.now()+120000});
    if(this.#routeBudgetHints.size>128)this.#routeBudgetHints.delete(this.#routeBudgetHints.keys().next().value);
  }

  async tradingState(launch) {
    ok(launch.input?.network==='mainnet-beta' && launch.input?.route==='raydium', 'Token trading requires a Raydium launch on Solana mainnet.');
    const a=this.addresses(launch), configKey=pk(launch.review.configId), cpConfigKey=pk(launch.review.cpConfigId);
    ok(!launch.curve || launch.curve===a.pool.toBase58(), 'The saved curve does not match this token.');
    const [cpA,cpB]=[a.m,a.q].sort((x,y)=>Buffer.compare(x.toBuffer(),y.toBuffer()));
    const cp=ray.getCpmmPdaPoolId(this.ids.CREATE_CPMM_POOL_PROGRAM,cpConfigKey,cpA,cpB).publicKey;
    const curveVA=ray.getPdaLaunchpadVaultId(a.program,a.pool,a.m).publicKey,curveVB=ray.getPdaLaunchpadVaultId(a.program,a.pool,a.q).publicKey;
    const cpVA=ray.getPdaVault(this.ids.CREATE_CPMM_POOL_PROGRAM,cp,cpA).publicKey,cpVB=ray.getPdaVault(this.ids.CREATE_CPMM_POOL_PROGRAM,cp,cpB).publicKey;
    const quoteSupport=ray.getPdaMintExAccountCp(this.ids.CREATE_CPMM_POOL_PROGRAM,a.q);
    const keys=[a.pool,a.m,a.q,configKey,a.platform,curveVA,curveVB,cp,cpConfigKey,cpVA,cpVB,quoteSupport.publicKey];
    const [response,epoch]=await Promise.all([this.c.getMultipleAccountsInfoAndContext(keys,{commitment:'confirmed'}),this.c.getEpochInfo('confirmed')]);
    snapshot(response,keys.length);ok(Number.isSafeInteger(epoch?.epoch) && epoch.epoch>=0,'The current transfer-fee epoch is unavailable.');
    const [curveAccount,baseAccount,quoteAccount,configAccount,platformAccount,curveA,curveB,cpAccount,cpConfigAccount,cpVaultA,cpVaultB,quoteSupportAccount]=response.value;
    for(const account of [curveAccount,configAccount,platformAccount,cpAccount,cpConfigAccount])ok(!account?.executable,'A trading configuration is executable.');
    const p=decodeRay(curveAccount,a.program,ray.LaunchpadPool,'PoolState'),cfg=decodeRay(configAccount,a.program,ray.LaunchpadConfig,'GlobalConfig'),plat=decodeRay(platformAccount,a.program,ray.PlatformConfig,'PlatformConfig');
    ok(p.mintA.equals(a.m)&&p.mintB.equals(a.q)&&p.configId.equals(configKey)&&p.platformId.equals(a.platform)&&p.creator.equals(a.w),'The curve belongs to a different launch.');
    ok(p.bump===ray.getPdaLaunchpadAuth(a.program).nonce&&cfg.curveType===0&&cfg.mintB.equals(a.q)&&ray.getPdaLaunchpadConfigId(a.program,a.q,cfg.curveType,cfg.index).publicKey.equals(configKey),'The curve configuration does not match this pair.');
    ok(p.vaultA.equals(curveVA)&&p.vaultB.equals(curveVB),'The curve vault addresses do not match this pair.');
    ok(['supply','totalSellA','totalFundRaisingB','virtualA','virtualB'].every((field,i)=>p[field].toString()===String(launch.review[['supply','sell','raise','virtualBase','virtualQuote'][i]])),'The curve terms differ from this launch.');
    ok([0,1,2].includes(p.status)&&p.migrateType===1,'Unsupported curve migration state.');
    ok(plat.cpConfigId.equals(cpConfigKey)&&plat.platformClaimFeeWallet.equals(a.w),'The platform migration or fee authority does not match this launch.');
    const base=mintInfo(a.m,baseAccount),quote=mintInfo(a.q,quoteAccount,registeredQuote(a.q,quoteSupportAccount,this.ids.CREATE_CPMM_POOL_PROGRAM,quoteSupport.nonce));
    ok(base.mint.decimals===6&&!base.mint.mintAuthority&&!base.mint.freezeAuthority&&base.mint.supply<=BigInt(p.supply.toString()),'The token supply, decimals or authorities differ from this launch.');
    ok(base.program.equals(launch.input.taxBps?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID)&&quote.program.toBase58()===launch.review.quoteProgram&&quote.mint.decimals===launch.review.quoteDecimals,'The trading token programs or decimals differ from this launch.');
    ok(p.mintDecimalsA===base.mint.decimals&&p.mintDecimalsB===quote.mint.decimals&&p.mintProgramFlag===((base.program.equals(TOKEN_2022_PROGRAM_ID)?1:0)|(quote.program.equals(TOKEN_2022_PROGRAM_ID)?2:0)),'The curve token programs do not match its mints.');
    this.transferTax(launch,base);
    const common={...a,base,quote,baseFee:activeFee(base,epoch.epoch),quoteFee:activeFee(quote,epoch.epoch),slot:response.context.slot,epoch:epoch.epoch};
    if(p.status===0){
      ok(!cpAccount,'An AMM pool appeared before graduation. Refresh this market.');
      ok(p.virtualA.gt(p.realA)&&p.virtualB.gtn(0)&&p.realA.lte(p.totalSellA),'The curve reserves are invalid.');
      const va=tokenAccount(curveVA,curveA,base,a.auth),vb=tokenAccount(curveVB,curveB,quote,a.auth);
      ok(va.amount>0n&&vb.amount>=BigInt(p.realB.toString()),'The curve vault liquidity is unavailable.');
      const fee=cfg.tradeFeeRate.add(plat.feeRate).add(plat.creatorFeeRate);ok(!fee.isNeg()&&fee.ltn(1000000),'The curve fee rate is invalid.');
      return {...common,market:'curve',marketKey:a.pool,state:p,config:cfg,platformState:plat};
    }
    ok(p.status===2&&cpAccount,'This coin is graduating. Trading resumes when its pool is ready.');
    const c=decodeRay(cpAccount,this.ids.CREATE_CPMM_POOL_PROGRAM,ray.CpmmPoolInfoLayout,'PoolState'),cc=decodeRay(cpConfigAccount,this.ids.CREATE_CPMM_POOL_PROGRAM,ray.CpmmConfigInfoLayout,'AmmConfig');
    const cpAuth=ray.getPdaPoolAuthority(this.ids.CREATE_CPMM_POOL_PROGRAM);
    ok(c.configId.equals(cpConfigKey)&&ray.getCpmmPdaAmmConfigId(this.ids.CREATE_CPMM_POOL_PROGRAM,cc.index).publicKey.equals(cpConfigKey)&&c.poolCreator.equals(a.w),'The graduated pool configuration or creator differs from this launch.');
    ok(c.mintA.equals(cpA)&&c.mintB.equals(cpB)&&c.vaultA.equals(cpVA)&&c.vaultB.equals(cpVB)&&c.observationId.equals(ray.getPdaObservationId(this.ids.CREATE_CPMM_POOL_PROGRAM,cp).publicKey)&&c.mintLp.equals(ray.getPdaLpMint(this.ids.CREATE_CPMM_POOL_PROGRAM,cp).publicKey)&&c.bump===cpAuth.nonce,'The graduated pool mints, vaults or authority are invalid.');
    ok(!(c.status&4)&&c.openTime.lte(bn(Math.floor(Date.now()/1000))),'Trading is not open for this pool.');
    const mintA=c.mintA.equals(base.key)?base:quote,mintB=c.mintB.equals(base.key)?base:quote;
    ok(c.mintProgramA.equals(mintA.program)&&c.mintProgramB.equals(mintB.program)&&c.mintDecimalA===mintA.mint.decimals&&c.mintDecimalB===mintB.mint.decimals&&[0,1,2].includes(c.feeOn),'The graduated pool token programs or fees are invalid.');
    const va=tokenAccount(cpVA,cpVaultA,mintA,cpAuth.publicKey),vb=tokenAccount(cpVB,cpVaultB,mintB,cpAuth.publicKey);
    const reserveA=bn(va.amount).sub(c.protocolFeesMintA).sub(c.fundFeesMintA).sub(c.creatorFeesMintA),reserveB=bn(vb.amount).sub(c.protocolFeesMintB).sub(c.fundFeesMintB).sub(c.creatorFeesMintB);
    ok(reserveA.gtn(0)&&reserveB.gtn(0)&&cc.tradeFeeRate.add(c.enableCreatorFee?cc.creatorFeeRate:zero()).ltn(1000000),'The graduated pool has insufficient liquidity or invalid fees.');
    return {...common,market:'cpmm',marketKey:cp,state:c,config:cc,reserveA,reserveB,cpAuth:cpAuth.publicKey};
  }

  async balances(state,wallet) {
    const trader=walletKey(wallet),baseAta=getAssociatedTokenAddressSync(state.m,trader,false,state.base.program),quoteAta=getAssociatedTokenAddressSync(state.q,trader,false,state.quote.program);
    const response=snapshot(await this.c.getMultipleAccountsInfoAndContext([trader,baseAta,quoteAta],{commitment:'confirmed',minContextSlot:state.slot}),3,state.slot);
    const [nativeAccount,ba,qa]=response.value;
    ok(!nativeAccount||(!nativeAccount.executable&&nativeAccount.owner.equals(SystemProgram.programId)&&Number.isSafeInteger(nativeAccount.lamports)&&nativeAccount.lamports>=0),'The trading wallet has an invalid native account.');
    const base=tokenAccount(baseAta,ba,state.base,trader,true),quote=tokenAccount(quoteAta,qa,state.quote,trader,true);
    return {trader,baseAta,quoteAta,base,quote,native:BigInt(nativeAccount?.lamports||0),slot:response.context.slot};
  }

  async walletBalances(launch,{wallet}) {
    if(launch.input?.route==='pumpswap')return pumpAmmBalances(this,launch,{wallet});
    const state=await this.tradingState(launch),b=await this.balances(state,wallet),native=state.q.equals(NATIVE_MINT);
    return {nativeBalanceLamports:b.native.toString(),baseBalanceRaw:(b.base?.amount||0n).toString(),baseDecimals:state.base.mint.decimals,quoteBalanceRaw:(native?b.native:b.quote?.amount||0n).toString(),quoteDecimals:state.quote.mint.decimals,baseSymbol:String(launch.input.symbol||'Token'),quoteSymbol:native?'SOL':quoteLabel(launch.input.quoteMint,launch.review.quoteSymbol),slot:b.slot};
  }

  async quotePaired(launch,{wallet,side,amount,slippageBps=100}, fundingCredit) {
    ok(['buy','sell'].includes(side),'Choose Buy or Sell.');
    ok(Number.isInteger(slippageBps)&&slippageBps>=0&&slippageBps<=10000,'Slippage must be between 0% and 100%, in increments of 0.01%.');
    ok(typeof amount==='string'&&amount.length<=48&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount),'Enter a positive token amount.');
    const state=await this.tradingState(launch),b=await this.balances(state,wallet),input=side==='buy'?state.quote:state.base,output=side==='buy'?state.base:state.quote,raw=units(amount,input.mint.decimals);
    ok(raw>0n&&raw<=MAX_U64,'The amount is outside the supported token range.');
    const native=state.q.equals(NATIVE_MINT),available=side==='buy'?(fundingCredit!==undefined?BigInt(fundingCredit):native?b.native:b.quote?.amount||0n):b.base?.amount||0n;
    ok(available>=raw,`Insufficient ${side==='buy'?(native?'SOL':quoteLabel(state.q.toBase58(),launch.review.quoteSymbol)):launch.input.symbol||'token'} balance.`);
    let out;
    if(state.market==='curve'){
      const args={poolInfo:state.state,protocolFeeRate:state.config.tradeFeeRate,platformFeeRate:state.platformState.feeRate,creatorFeeRate:state.platformState.creatorFeeRate,shareFeeRate:zero(),curveType:0,transferFeeConfigA:state.baseFee,transferFeeConfigB:state.quoteFee,slot:state.slot};
      const calc=side==='buy'?ray.Launchpad.buyExactIn({...args,amountB:bn(raw)}):ray.Launchpad.sellExactIn({...args,amountA:bn(raw)});
      // Exact-input orders at the graduation boundary can spend less. Require
      // the user to review a smaller amount instead of misstating the debit.
      if(side==='buy')ok(calc.amountB.eq(bn(raw)),'This buy exceeds the remaining curve allocation. Enter a smaller amount.');
      out=side==='buy'?calc.amountA.amount.sub(calc.amountA.fee||zero()):calc.amountB;
      if(side==='sell')ok(out.lte(state.state.realB),'The curve has insufficient quote liquidity for this sale.');
    }else{
      const isA=state.state.mintA.equals(input.key),inFee=side==='buy'?state.quoteFee:state.baseFee,outFee=side==='buy'?state.baseFee:state.quoteFee;
      const net=ray.getTransferAmountFeeFromPre(bn(raw),inFee,state.slot);
      const calc=ray.CurveCalculator.swapBaseInput(net.amount.sub(net.fee||zero()),isA?state.reserveA:state.reserveB,isA?state.reserveB:state.reserveA,state.config.tradeFeeRate,state.state.enableCreatorFee?state.config.creatorFeeRate:zero(),state.config.protocolFeeRate,state.config.fundFeeRate,state.state.feeOn===0||state.state.feeOn===(isA?1:2));
      const netOut=ray.getTransferAmountFeeFromPre(calc.outputAmount,outFee,state.slot);out=netOut.amount.sub(netOut.fee||zero());
    }
    const minimum=out.muln(10000-slippageBps).divn(10000);ok(out.gtn(0)&&(minimum.gtn(0)||slippageBps===10000)&&out.lte(bn(MAX_U64)),'This trade is too small after fees.');
    let rent=0n;const sizes=[];
    if(!b.base)sizes.push(tradingAccountLen(state.base));
    if(native)sizes.push(ACCOUNT_SIZE);else if(!b.quote)sizes.push(tradingAccountLen(state.quote));
    for(const size of sizes){const value=await this.c.getMinimumBalanceForRentExemption(size);ok(Number.isSafeInteger(value)&&value>=0,'The RPC returned an invalid rent estimate.');rent+=BigInt(value);}
    ok(b.native>=FEE_BUDGET+rent+(native&&side==='buy'?raw:0n),'Insufficient SOL for this trade and token-account/network costs.');
    const quoteSymbol=native?'SOL':quoteLabel(state.q.toBase58(),launch.review.quoteSymbol),baseSymbol=String(launch.input.symbol||'Token');
    const result=Object.freeze({wallet:b.trader.toBase58(),side,amount,amountRaw:raw.toString(),inputMint:input.key.toBase58(),outputMint:output.key.toBase58(),inputSymbol:side==='buy'?quoteSymbol:baseSymbol,outputSymbol:side==='buy'?baseSymbol:quoteSymbol,inputDecimals:input.mint.decimals,outputDecimals:output.mint.decimals,expectedOutputRaw:out.toString(),minimumOutputRaw:minimum.toString(),expectedOutput:displayUnits(out.toString(),output.mint.decimals),minimumOutput:displayUnits(minimum.toString(),output.mint.decimals),slippageBps,slot:b.slot,expiresAt:Date.now()+QUOTE_TTL,balanceRaw:available.toString(),nativeBalanceLamports:b.native.toString(),market:state.market,pool:state.marketKey.toBase58(),networkFeeLamports:FEE_BUDGET.toString(),rentLamports:rent.toString()});
    this.#intents.set(result,{identity:identity(launch),state,b,raw,native});return result;
  }

  async tradeInstructions(intent,minimumOutputRaw=intent.minimumOutputRaw) {
    const plan=this.#intents.get(intent);ok(plan,'The trade quote is unavailable. Review a fresh quote.');
    const {state:s,b,raw,native}=plan,ixs=[],cleanup=[];let aa=b.baseAta,bb=b.quoteAta;
    if(!b.base)ixs.push(createAssociatedTokenAccountIdempotentInstruction(b.trader,aa,b.trader,s.m,s.base.program));
    if(native){
      const seed=randomUUID().replaceAll('-','');bb=await PublicKey.createWithSeed(b.trader,seed,TOKEN_PROGRAM_ID);
      const rent=await this.c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),lamports=BigInt(rent)+(intent.side==='buy'?raw:0n);
      ok(lamports<=BigInt(Number.MAX_SAFE_INTEGER),'This SOL amount is too large.');
      ixs.push(SystemProgram.createAccountWithSeed({fromPubkey:b.trader,basePubkey:b.trader,seed,newAccountPubkey:bb,lamports:Number(lamports),space:ACCOUNT_SIZE,programId:TOKEN_PROGRAM_ID}),createInitializeAccount3Instruction(bb,NATIVE_MINT,b.trader));
      cleanup.push(createCloseAccountInstruction(bb,b.trader,b.trader));
    }else if(!b.quote)ixs.push(createAssociatedTokenAccountIdempotentInstruction(b.trader,bb,b.trader,s.q,s.quote.program));
    const side=intent.side,min=bn(minimumOutputRaw);
    if(s.market==='curve'){
      const f=side==='buy'?ray.buyExactInInstruction:ray.sellExactInInstruction;
      // s.w is the ORIGINAL creator. It must never be replaced with the trader.
      ixs.push(f(s.program,b.trader,s.auth,s.state.configId,s.platform,s.pool,aa,bb,s.state.vaultA,s.state.vaultB,s.m,s.q,s.base.program,s.quote.program,ray.getPdaPlatformVault(s.program,s.platform,s.q).publicKey,ray.getPdaCreatorVault(s.program,s.w,s.q).publicKey,bn(raw),min,zero()));
    }else{
      const input=side==='buy'?s.quote:s.base,output=side==='buy'?s.base:s.quote,isA=s.state.mintA.equals(input.key);
      ixs.push(ray.makeSwapCpmmBaseInInstruction(this.ids.CREATE_CPMM_POOL_PROGRAM,b.trader,s.cpAuth,s.state.configId,s.marketKey,side==='buy'?bb:aa,side==='buy'?aa:bb,isA?s.state.vaultA:s.state.vaultB,isA?s.state.vaultB:s.state.vaultA,input.program,output.program,input.key,output.key,s.state.observationId,bn(raw),min));
    }
    return [...ixs,...cleanup];
  }

  async quote(launch,request,{maxAccounts=32,checkSize=true}={}) {
    if(launch.input?.route==='pumpswap')return quotePumpAmm(this,launch,request);
    const budgets=SOL_ROUTE_ACCOUNT_BUDGETS,start=budgets.indexOf(maxAccounts);
    ok(start>=0,'The SOL route account budget is unsupported.');
    const hintKey=`${launch.input?.network}:${launch.input?.quoteMint}:${request.side}`;
    let hint=checkSize&&maxAccounts===32?this.#routeBudgetHints.get(hintKey):null;
    if(hint?.expiresAt<=Date.now()){this.#routeBudgetHints.delete(hintKey);hint=null;}
    const candidates=budgets.slice(start),ordered=hint?[hint.budget,...candidates.filter(budget=>budget!==hint.budget)]:candidates;
    let packetError,noRouteError;
    for(const [index,budget] of ordered.entries()){
      let candidate;
      try{candidate=await this.quoteCandidate(launch,request,{maxAccounts:budget});}
      catch(error){
        if((packetError||hint)&&error?.code==='SOL_ROUTE_NOT_FOUND'){noRouteError=error;continue;}
        throw error;
      }
      const plan=this.#solIntents.get(candidate);
      if(!checkSize||!plan.conversion)return candidate;
      // Select a route that fits before publishing its price to the user.
      // Building a v0 message is read-only: no simulation, signing, submission,
      // or lookup-table creation happens during this quote preflight.
      const pairInstructions=await this.tradeInstructions(plan.paired),route=await this.tradeRoutes.buildConversion(this,plan.conversion);
      const instructions=composeTradeInstructions(candidate.side,route,pairInstructions);
      try{
        await this.walletMessage(pk(candidate.wallet),PublicKey.default.toBase58(),instructions,1400000,'trade');
        this.rememberRouteBudget(hintKey,budget);return candidate;
      }
      catch(error){
        this.#solIntents.delete(candidate);this.#intents.delete(plan.paired);
        if(error?.code!=='LAUNCH_TRANSACTION_TOO_LARGE')throw error;
        packetError=error;
        this.rememberRouteBudget(hintKey,ordered[index+1]);
      }
    }
    // A smaller account budget can have no route at all. Keep the actual
    // packet-size diagnosis instead of replacing it with that provider 400.
    throw packetError||noRouteError;
  }

  async quoteCandidate(launch,{wallet,side,amount,slippageBps=100},{maxAccounts=32}={}) {
    ok(Number.isInteger(slippageBps)&&slippageBps>=0&&slippageBps<=10000,'Slippage must be between 0% and 100%, in increments of 0.01%.');
    ok(['buy','sell'].includes(side),'Choose Buy or Sell.');
    const trader=walletKey(wallet),state=await this.tradingState(launch);
    if(state.q.equals(NATIVE_MINT)) {
      const paired=await this.quotePaired(launch,{wallet,side,amount,slippageBps});
      this.#solIntents.set(paired,{identity:identity(launch),paired});return paired;
    }
    // Fund the second exact-input leg only from a positive guaranteed first-leg
    // output. Allocate the remaining tolerance multiplicatively; at 100% the
    // final leg deliberately has minimum 0, while the intermediary stays funded.
    const firstSlippage=Math.floor(slippageBps/2),lastSlippage=Math.floor((slippageBps-firstSlippage)*10000/(10000-firstSlippage));
    let conversion,paired,raw;
    if(side==='buy'){
      ok(typeof amount==='string'&&amount.length<=48&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount),'Enter a positive SOL amount.');
      raw=units(amount,9);ok(raw>0n&&raw<=MAX_U64,'The SOL amount is outside the supported range.');
      conversion=await this.tradeRoutes.quoteConversion(this,{inputMint:NATIVE_MINT.toBase58(),outputMint:state.q.toBase58(),inputProgram:TOKEN_PROGRAM_ID.toBase58(),outputProgram:state.quote.program.toBase58(),amountRaw:raw.toString(),slippageBps:firstSlippage,wallet:trader.toBase58(),maxAccounts});
      paired=await this.quotePaired(launch,{wallet,side,amount:displayUnits(conversion.minimumRaw,state.quote.mint.decimals),slippageBps:lastSlippage},conversion.minimumRaw);
    } else {
      paired=await this.quotePaired(launch,{wallet,side,amount,slippageBps:firstSlippage});raw=BigInt(paired.amountRaw);
      conversion=await this.tradeRoutes.quoteConversion(this,{inputMint:state.q.toBase58(),outputMint:NATIVE_MINT.toBase58(),inputProgram:state.quote.program.toBase58(),outputProgram:TOKEN_PROGRAM_ID.toBase58(),amountRaw:paired.minimumOutputRaw,slippageBps:lastSlippage,wallet:trader.toBase58(),maxAccounts});
    }
    const b=this.#intents.get(paired).b,rent=BigInt(paired.rentLamports)+BigInt(conversion.rentLamports||'0'),nativeCost=FEE_BUDGET+rent+(side==='buy'?raw:0n);
    ok(b.native>=nativeCost,'Insufficient SOL for the trade and token-account/network costs.');
    const result=Object.freeze({...paired,amount,amountRaw:raw.toString(),inputMint:side==='buy'?NATIVE_MINT.toBase58():state.m.toBase58(),outputMint:side==='buy'?state.m.toBase58():NATIVE_MINT.toBase58(),inputSymbol:side==='buy'?'SOL':paired.inputSymbol,outputSymbol:side==='buy'?paired.outputSymbol:'SOL',inputDecimals:side==='buy'?9:paired.inputDecimals,outputDecimals:side==='buy'?paired.outputDecimals:9,expectedOutputRaw:side==='buy'?paired.expectedOutputRaw:conversion.expectedRaw,minimumOutputRaw:side==='buy'?paired.minimumOutputRaw:conversion.minimumRaw,expectedOutput:side==='buy'?paired.expectedOutput:displayUnits(conversion.expectedRaw,9),minimumOutput:side==='buy'?paired.minimumOutput:displayUnits(conversion.minimumRaw,9),slippageBps,slot:Math.max(paired.slot,conversion.slot||0),balanceRaw:side==='buy'?b.native.toString():paired.balanceRaw,rentLamports:rent.toString(),expiresAt:Math.min(paired.expiresAt,conversion.expiresAt),residualQuotePossible:true,quoteSymbol:quoteLabel(state.q.toBase58(),launch.review.quoteSymbol),warning:'This trade converts through the paired asset. Any unused paired assets remain in your wallet.'});
    this.#solIntents.set(result,{identity:identity(launch),paired,conversion,accountBudget:maxAccounts});return result;
  }

  async verifyTradeSimulation(intent,operation,instructions,monitoredAccounts=[]) {
    const plan=this.#solIntents.get(intent),p=this.#intents.get(plan.paired),{state:s,b}=p;
    ok(Array.isArray(monitoredAccounts)&&monitoredAccounts.length<=32,'The SOL route returned too many wallet accounts to verify.');
    const primary=new Set([b.trader,b.baseAta,b.quoteAta].map(key=>key.toBase58())),extras=[];
    for(const row of monitoredAccounts){
      const key=pk(row.address);ok(!primary.has(key.toBase58())&&!extras.some(other=>other.address===row.address)&&/^(?:0|[1-9]\d*)$/.test(row.minimumAmountRaw)&&Number.isSafeInteger(row.minimumLamports)&&row.minimumLamports>=0,'The SOL route wallet-account audit is invalid.');
      extras.push({...row,key,mint:{key:pk(row.mint),program:pk(row.program)}});
    }
    const tx=VersionedTransaction.deserialize(Buffer.from(operation.unsignedRaw,'base64'));
    const sim=await this.simulatePrepared(tx,{sigVerify:false,commitment:'confirmed',minContextSlot:Math.max(b.slot,intent.slot),accounts:{encoding:'base64',addresses:[b.trader.toBase58(),b.baseAta.toBase58(),b.quoteAta.toBase58(),...extras.map(row=>row.address)]}},operation.lastValidBlockHeight);
    if(sim.value.err)throw launchSimulationError(tx,sim.value,'trade');
    const values=sim.value.accounts;ok(Array.isArray(values)&&values.length===3+extras.length,'The RPC omitted trading simulation balances.');
    const native=values[0];ok(native&&!native.executable&&native.owner===SystemProgram.programId.toBase58()&&Number.isSafeInteger(native.lamports)&&native.lamports>=0,'The RPC omitted the wallet simulation balance.');
    const decode=(index,key,mint)=>values[index]?tokenAccount(key,{...values[index],owner:pk(values[index].owner),data:Buffer.from(values[index].data[0],'base64')},mint,b.trader):null;
    const base=decode(1,b.baseAta,s.base),quote=decode(2,b.quoteAta,s.quote),beforeBase=b.base?.amount||0n,beforeQuote=b.quote?.amount||0n,afterBase=base?.amount||0n,afterQuote=quote?.amount||0n;
    ok(afterQuote>=beforeQuote,'The conversion would spend an existing paired-asset balance. Nothing was submitted.');
    for(const [before,after] of [[b.base,base],[b.quote,quote]]){
      if(before)ok(after&&String(before.delegate||'')===String(after.delegate||'')&&String(before.closeAuthority||'')===String(after.closeAuthority||'')&&before.delegatedAmount===after.delegatedAmount,'The conversion would change token-account permissions. Nothing was submitted.');
      else if(after)ok(!after.delegate&&!after.closeAuthority&&after.delegatedAmount===0n,'The conversion assigned permissions on a new token account. Nothing was submitted.');
    }
    for(let i=0;i<extras.length;i++){
      const row=extras[i],after=decode(i+3,row.key,row.mint),info=values[i+3];
      ok(after&&!after.delegate&&!after.closeAuthority&&after.delegatedAmount===0n&&!after.isNative&&after.rentExemptReserve===null&&after.amount>=BigInt(row.minimumAmountRaw)&&Number.isSafeInteger(info.lamports)&&info.lamports>=row.minimumLamports,'The conversion changed an intermediate wallet account or its permissions. Nothing was submitted.');
    }
    const cost=BigInt(intent.networkFeeLamports)+BigInt(intent.rentLamports),afterNative=BigInt(native.lamports),minimum=BigInt(intent.minimumOutputRaw),amount=BigInt(intent.amountRaw);
    if(intent.side==='buy'){
      ok(afterBase-beforeBase>=minimum,'The trade does not deliver the reviewed minimum tokens. Nothing was submitted.');
      ok(b.native-afterNative<=amount+cost,'The trade exceeds the reviewed SOL spend. Nothing was submitted.');
    }else{
      ok(beforeBase-afterBase===amount,'The trade spends a different token amount than reviewed. Nothing was submitted.');
      ok(afterNative-b.native+cost>=minimum,'The trade does not deliver the reviewed minimum SOL. Nothing was submitted.');
    }
    ok(Number.isSafeInteger(sim.context?.slot)&&sim.context.slot>=Math.max(b.slot,intent.slot),'The RPC omitted the trading simulation context.');
    return sim.context.slot;
  }

  async prepareTrade(launch,intent,{external,secret,authorize}={}) {
    if(launch.input?.route==='pumpswap')return preparePumpAmm(this,launch,intent,{external,secret,authorize});
    const plan=this.#solIntents.get(intent);ok(plan&&plan.identity===identity(launch)&&intent.expiresAt>Date.now(),'The trade quote expired. Review a fresh quote.');
    ok(typeof external==='boolean'&&(external?!secret:typeof secret==='string'&&secret.length>0),'The selected trading wallet cannot sign this trade.');
    // Only a packet-size failure permits a new route. Each smaller provider
    // account budget gets a fresh exact-input quote and must still meet the
    // user's original minimum output and maximum setup cost. Nothing has been
    // signed or submitted while these bounded attempts run.
    const budgets=plan.conversion?SOL_ROUTE_ACCOUNT_BUDGETS.filter(budget=>budget<=(plan.accountBudget||32)):[32];
    let fresh,current,instructions,route,op,packetError;
    for(let index=0;index<budgets.length;index++){
      try{fresh=await this.quote(launch,{wallet:intent.wallet,side:intent.side,amount:intent.amount,slippageBps:intent.slippageBps},{maxAccounts:budgets[index],checkSize:false});}
      catch(error){if(packetError&&error?.code==='SOL_ROUTE_NOT_FOUND')continue;throw error;}
      ok(fresh.market===intent.market&&fresh.pool===intent.pool&&BigInt(fresh.minimumOutputRaw)>=BigInt(intent.minimumOutputRaw),'The price or market moved beyond your reviewed minimum. Review a new quote.');
      ok(BigInt(fresh.networkFeeLamports)+BigInt(fresh.rentLamports)<=BigInt(intent.networkFeeLamports)+BigInt(intent.rentLamports),'The transaction setup cost increased. Review a new quote.');
      current=this.#solIntents.get(fresh);
      const pairInstructions=await this.tradeInstructions(current.paired);
      route=current.conversion?await this.tradeRoutes.buildConversion(this,current.conversion):null;
      instructions=composeTradeInstructions(intent.side,route,pairInstructions);
      // Build and simulate unsigned for both modes. Only the selected account
      // key signs, after the final session/ban/ownership authorization.
      const selected={address:intent.wallet,external:true};
      try{op=await this.prepare({...launch,keys:{...launch.keys,wallet:selected,payer:selected}},instructions,[],'trade',{minContextSlot:fresh.slot});}
      catch(error){
        if(error?.code!=='LAUNCH_TRANSACTION_TOO_LARGE'||!route)throw error;
        packetError=error;
        this.#solIntents.delete(fresh);this.#intents.delete(current.paired);
        continue;
      }
      break;
    }
    if(!op)throw packetError;
    const simulatedSlot=await this.verifyTradeSimulation(fresh,op,instructions,route?.monitoredAccounts||[]);
    if(Number.isSafeInteger(simulatedSlot))op.preparedSlot=Math.max(op.preparedSlot||0,simulatedSlot);
    if(authorize)await authorize();
    let prepared=op;
    if(!external){
      const key=signer(secret);ok(key.publicKey.toBase58()===intent.wallet,'The account default signer does not match the reviewed wallet.');
      const tx=VersionedTransaction.deserialize(Buffer.from(op.unsignedRaw,'base64'));ok(tx.version===0,'Only atomic v0 trades are supported.');tx.sign([key]);
      const raw=Buffer.from(tx.serialize());verifySignedTransaction(raw,intent.wallet);
      const {unsignedRaw,messageHash,externalSigner,needsSignature,...validity}=op;
      prepared={...validity,state:'pending',signature:bs58.encode(tx.signatures[0]),raw:raw.toString('base64')};
    }
    this.#solIntents.delete(intent);this.#solIntents.delete(fresh);this.#intents.delete(plan.paired);this.#intents.delete(current.paired);
    return {...prepared,trade:{wallet:intent.wallet,side:intent.side,inputMint:intent.inputMint,outputMint:intent.outputMint,amountRaw:intent.amountRaw,minimumOutputRaw:fresh.minimumOutputRaw,market:intent.market,pool:intent.pool}};
  }

  async broadcast(op,{deadline,authorize}={}) {
    ok(!op.needsSignature&&op.signature&&op.raw,'The trade still needs a wallet signature. Nothing was submitted.');
    ok(authorize===undefined||typeof authorize==='function','The trade authorization callback is invalid.');
    const checkDeadline=()=>ok(deadline===undefined||Number.isFinite(deadline)&&deadline>Date.now(),'Trade submission deadline expired. Nothing was submitted.');
    const beforeSend=async()=>{checkDeadline();if(authorize)await authorize();checkDeadline();};
    checkDeadline();
    return this.withRpcContext({deadline,authorizeBeforeSend:beforeSend},async()=>{
      // Injected RPC connections do not use LaunchChain's transport hook. They
      // still need authorization; the real transport repeats it after pacing.
      await beforeSend();
      const signature=await this.c.sendRawTransaction(Buffer.from(op.raw,'base64'),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0,...(Number.isSafeInteger(op.preparedSlot)?{minContextSlot:op.preparedSlot}:{})});
      ok(signature===op.signature,'RPC returned a different transaction signature.');
    });
  }

  verifyBroadcastOperation(op,wallet) {
    const failure='The saved trade identity could not be verified. Nothing was submitted.';
    ok(op&&!op.needsSignature&&typeof wallet==='string'&&wallet.length>0&&typeof op.raw==='string'&&op.raw.length>0&&op.raw.length<=1644&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(op.raw),failure);
    const bytes=Buffer.from(op.raw,'base64');
    ok(bytes.length<=1232&&bytes.toString('base64')===op.raw&&/^[a-f0-9]{64}$/.test(op.broadcastRawHash||'')&&createHash('sha256').update(bytes).digest('hex')===op.broadcastRawHash,failure);
    let tx;try{tx=VersionedTransaction.deserialize(bytes);}catch{throw Error(failure);}
    ok(tx.version===0&&Buffer.from(tx.serialize()).equals(bytes)&&tx.message.recentBlockhash===op.blockhash,failure);
    const verified=verifySignedTransaction(bytes,wallet);
    ok(verified.signature===op.signature,failure);
    return true;
  }

  /** One history lookup per 100 distinct signatures. Individual outcomes stay
   * unresolved until the exact finalized transaction receipt is available. */
  async receiptBatch(operations,{maxReceiptReads=operations?.length}={}) {
    ok(Array.isArray(operations),'Trade receipt checks require an operation list.');
    ok(Number.isInteger(maxReceiptReads)&&maxReceiptReads>=0&&maxReceiptReads<=1000,'The trade receipt read limit must be between 0 and 1000.');
    let remainingReads=maxReceiptReads;
    const results=operations.map(operation=>({operation,receipt:null,error:null})),groups=new Map();
    for(const result of results){
      try{
        const signature=result.operation?.signature;
        ok(typeof signature==='string'&&signature.length>0&&signature.length<=88,'Invalid saved trade signature.');
        const bytes=bs58.decode(signature);
        ok(bytes.length===64&&bytes.some(byte=>byte!==0)&&bs58.encode(bytes)===signature,'Invalid saved trade signature.');
        if(!groups.has(signature))groups.set(signature,{signature,results:[]});
        groups.get(signature).results.push(result);
      }catch(error){result.error=error;}
    }
    const observed=(group,status)=>{
      const rank={unknown:0,processed:1,confirmed:2,finalized:3};
      const next={confirmationStatus:Object.hasOwn(rank,status?.confirmationStatus)?status.confirmationStatus:'unknown',slot:Number.isSafeInteger(status?.slot)&&status.slot>=0?status.slot:null};
      for(const {operation} of group.results){
        const previous=operation.observedSignatureStatus;
        if(!previous||(rank[next.confirmationStatus]??0)>=(rank[previous.confirmationStatus]??0))operation.observedSignatureStatus={...next};
      }
    };
    const distinct=[...groups.values()];
    for(let start=0;start<distinct.length;start+=100){
      const batch=distinct.slice(start,start+100),lookups=[];
      try{
        const response=await this.c.getSignatureStatuses(batch.map(group=>group.signature),{searchTransactionHistory:true});
        ok(Number.isSafeInteger(response?.context?.slot)&&response.context.slot>=0&&Array.isArray(response.value)&&response.value.length===batch.length,'The RPC returned an incomplete trade status batch.');
        for(let index=0;index<batch.length;index++){
          const group=batch[index],status=response.value[index];
          if(status!==null){
            // A positive observation is retained even if the provider later
            // returns malformed data, a cache miss, or an archival RPC error.
            observed(group,status);
            if(!status||typeof status!=='object'||!Number.isSafeInteger(status.slot)||status.slot<0){
              for(const result of group.results)result.error=Error('The RPC returned an invalid trade status.');
              continue;
            }
            if(status.confirmationStatus!=='finalized')continue;
          }
          if(remainingReads>0){lookups.push(group);remainingReads--;}
        }
      }catch(error){for(const group of batch)for(const result of group.results)result.error=error;continue;}
      let cursor=0;
      const read=async()=>{
        while(cursor<lookups.length){
          const group=lookups[cursor++];
          try{
            const receipt=await this.c.getTransaction(group.signature,{commitment:'finalized',maxSupportedTransactionVersion:1});
            if(!receipt)continue;
            ok(receipt.transaction?.signatures?.[0]===group.signature,'Receipt signature mismatch.');
            observed(group,{confirmationStatus:'finalized',slot:receipt.slot});
            ok(Number.isSafeInteger(receipt.slot)&&receipt.slot>=0&&receipt.meta&&Object.hasOwn(receipt.meta,'err'),'The RPC returned an incomplete trade receipt.');
            for(const result of group.results)result.receipt=receipt;
          }catch(error){for(const result of group.results)result.error=error;}
        }
      };
      await Promise.all(Array.from({length:Math.min(2,lookups.length)},read));
    }
    return results;
  }
}
