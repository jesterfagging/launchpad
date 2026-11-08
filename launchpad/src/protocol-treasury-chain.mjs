import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, AccountState, ExtensionType, unpackMint, unpackAccount, getExtensionTypes, getExtensionData, getDefaultAccountState, getPausableConfig, getTransferHook, getTransferFeeConfig, getAssociatedTokenAddressSync, createBurnCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import { LaunchChain, ray } from './launchpad-chain.mjs';
import { quoteConversion, buildConversion, SOL_ROUTE_ACCOUNT_BUDGETS, treasuryRouteGuardError } from './launchpad-trading-route.mjs';
import { verifySignedTransaction, transactionSize } from './providers.mjs';
import { requireValue as ok } from '../public/launchpad-model.mjs';
import { inspectMeteoraQuoteMint, meteoraTokenBadgeAddress, validMeteoraTokenBadge } from './meteora-quotes.mjs';
import { readMintTokenAccounts } from './launchpad-token-accounts.mjs';
import { PLATFORM_TOKEN_MINT } from './platform-token.mjs';

// The platform token the treasury buys back and burns (LAUNCHPAD_TOKEN_MINT; '' when the host has none).
export const PROTOCOL_TOKEN_MINT = PLATFORM_TOKEN_MINT;
const SOL = NATIVE_MINT.toBase58(), MAX_U64 = 18446744073709551615n, FEE_LIMIT = 20000n, EXTRA_COST_LIMIT = 15000000n, GAS_SOL_RESERVE = 10000000n;
const pk = value => new PublicKey(value), hash = value => createHash('sha256').update(value).digest('hex');
// A swap route is audited at confirmed state; finalized state trails it by about 32 slots (13 seconds).
// A finalized snapshot at least as new as the route waits for finalization instead of failing every time.
const FINALIZED_WAIT_ATTEMPTS=45,FINALIZED_WAIT_MS=1000;
const contextLag=error=>Number(error?.code)===-32016||/minimum context slot has not been reached/i.test(String(error?.message||''));
// A read that a moment later can succeed: an RPC or rate gate that is busy, a timeout, a node that is behind. An
// aborted request (the service is stopping) is never retried.
const aborted=error=>error?.name==='AbortError'||error?.code==='ABORT_ERR'||/^Stopped\.?$/.test(String(error?.message||''));
const transientRead=error=>!aborted(error)&&(contextLag(error)||error?.retryable===true||error?.rateLimited===true||error?.capacityLimited===true||[-32004,-32005,-32007,-32009,-32603].includes(Number(error?.code))||/\b(?:429|500|502|503|504)\b|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|deadline expired|Provider connection failed|Provider response interrupted|cooling down|capacity is busy/i.test(String(error?.message||'')));
const ordinary = new Set([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer, ExtensionType.TokenMetadata, ExtensionType.InterestBearingConfig, ExtensionType.ScaledUiAmountConfig]);
const issuer = new Set([...ordinary, ExtensionType.PermanentDelegate, ExtensionType.DefaultAccountState, ExtensionType.PausableConfig, ExtensionType.ConfidentialTransferMint, ExtensionType.TransferHook, 16]);
const supportTag = createHash('sha256').update('account:SupportMintAssociated').digest().subarray(0,8);
function quantity(value, zero=false) { ok(typeof value==='string' && (zero?/^(?:0|[1-9]\d{0,19})$/:/^[1-9]\d{0,19}$/).test(value) && BigInt(value)<=MAX_U64,'Invalid treasury raw amount.'); return BigInt(value); }
function lamports(value) { ok(Number.isSafeInteger(value)&&value>=0,'The RPC returned an invalid SOL balance.'); return BigInt(value); }
function snapshot(value,length,minimum=0) { ok(Number.isSafeInteger(value?.context?.slot)&&value.context.slot>=minimum&&Array.isArray(value.value)&&value.value.length===length,'The RPC returned an incomplete treasury snapshot.'); return value; }
function accountInfo(value) { if(!value)return null; ok(Array.isArray(value.data)&&value.data[1]==='base64','The RPC omitted treasury simulation account data.'); return {...value,owner:pk(value.owner),data:Buffer.from(value.data[0],'base64')}; }
function nativeBalance(info) { ok(info&&!info.executable&&info.owner.equals(SystemProgram.programId)&&info.data.length===0,'The treasury must be an ordinary SOL wallet.'); return lamports(info.lamports); }
function gasNativeBalance(info,optional=false) {
  if(info===null&&optional)return 0n;
  ok(info&&info.executable===false&&info.owner instanceof PublicKey&&info.owner.equals(SystemProgram.programId)&&Buffer.isBuffer(info.data)&&info.data.length===0,'Gas funding requires an ordinary SOL wallet.');return lamports(info.lamports);
}
function gasSimulationBalance(info) {
  ok(info&&Array.isArray(info.data)&&info.data.length===2&&typeof info.data[0]==='string'&&info.data[1]==='base64'&&Buffer.from(info.data[0],'base64').toString('base64')===info.data[0],'The RPC omitted valid gas funding simulation account data.');
  return gasNativeBalance(accountInfo(info));
}
function verifyGasTransfer(op,tx) {
  const message=tx.message,keys=message.staticAccountKeys,instructions=message.compiledInstructions,input=quantity(op.inputAmount),reserve=quantity(op.accounting?.minSolReserve,true),maxCost=quantity(op.accounting?.maxCostLamports),fee=quantity(op.accounting?.networkFeeLamports);
  ok(op.mint===SOL&&typeof op.recipient==='string'&&pk(op.recipient).toBase58()===op.recipient&&PublicKey.isOnCurve(pk(op.recipient).toBytes())&&op.recipient!==op.wallet,'The saved gas refill recipient or mint changed.');
  ok(input<=BigInt(Number.MAX_SAFE_INTEGER)&&reserve>=GAS_SOL_RESERVE&&maxCost<=EXTRA_COST_LIMIT&&fee<=FEE_LIMIT&&fee<=maxCost&&op.minimumOutput==='0'&&op.expectedOutput==='0'&&Array.isArray(op.accounting.monitoredAccounts)&&op.accounting.monitoredAccounts.length===0,'The saved gas refill budget changed.');
  ok(message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0&&message.header.numReadonlyUnsignedAccounts===1&&message.addressTableLookups.length===0&&keys.length===3&&String(keys[0])===op.wallet&&String(keys[1])===op.recipient&&keys[2].equals(SystemProgram.programId)&&instructions.length===1,'The saved gas refill is not the authorized native transfer.');
  const ix=instructions[0],data=Buffer.from(ix.data);
  ok(ix.programIdIndex===2&&ix.accountKeyIndexes.length===2&&ix.accountKeyIndexes[0]===0&&ix.accountKeyIndexes[1]===1&&data.length===12&&data.readUInt32LE(0)===2&&data.readBigUInt64LE(4)===input,'The saved gas refill amount or instruction changed.');
}
function parsedToken(address,info,mint,wallet,optional=false) {
  if(!info&&optional)return null;
  ok(info&&!info.executable&&info.owner.equals(mint.program),'A treasury token account has the wrong program.');
  const account=unpackAccount(address,info,mint.program);
  ok(account.mint.equals(mint.key)&&account.owner.equals(wallet)&&account.isInitialized&&!account.isFrozen&&!account.delegate&&account.delegatedAmount===0n&&!account.closeAuthority&&!account.isNative,'A treasury token account has unsafe ownership or permissions.');
  const confidential=getExtensionData(ExtensionType.ConfidentialTransferAccount,account.tlvData);
  ok(!confidential||(confidential.length===295&&confidential[262]===1),'The treasury token account does not allow ordinary transfers.');
  return account;
}
function mintInfo(key,info,support,program,bump,{official=false,meteoraRegistered=false}={}) {
  ok(info&&!info.executable&&[TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(info.owner)),'The treasury mint has an unsupported token program.');
  const mint=unpackMint(key,info,info.owner),extensions=getExtensionTypes(mint.tlvData);
  ok(mint.isInitialized&&mint.decimals<=12,'The treasury mint is not initialized.');
  const registered=support&&!support.executable&&support.owner.equals(program)&&Buffer.isBuffer(support.data)&&support.data.length===105&&support.data.subarray(0,8).equals(supportTag)&&support.data[8]===bump&&support.data.subarray(9,41).equals(key.toBuffer());
  ok(extensions.every(type=>ordinary.has(type))||(registered||meteoraRegistered&&!official)&&info.owner.equals(TOKEN_2022_PROGRAM_ID)&&extensions.every(type=>issuer.has(type)),'The treasury mint has unsupported extensions.');
  if(extensions.includes(16)) { const bytes=getExtensionData(16,mint.tlvData); ok(bytes?.length===129&&bytes[64]<=1&&extensions.filter(type=>type===16).length===1&&extensions.includes(ExtensionType.TransferFeeConfig)&&extensions.includes(ExtensionType.ConfidentialTransferMint),'The treasury mint has an invalid confidential fee configuration.'); }
  const defaults=getDefaultAccountState(mint),pause=getPausableConfig(mint),hook=getTransferHook(mint),fee=getTransferFeeConfig(mint);
  ok(!defaults||defaults.state===AccountState.Initialized,'The treasury mint creates frozen token accounts.');
  ok(!pause?.paused&&(!hook||hook.programId.equals(PublicKey.default)),'The treasury mint is paused or requires an unsupported transfer hook.');
  ok(!fee||[fee.olderTransferFee,fee.newerTransferFee].every(row=>row.transferFeeBasisPoints<10000),'The treasury mint has an unsupported transfer fee.');
  if(official)ok(key.toBase58()===PROTOCOL_TOKEN_MINT&&info.owner.equals(TOKEN_2022_PROGRAM_ID)&&mint.decimals===6&&!mint.mintAuthority&&!mint.freezeAuthority&&extensions.every(type=>[ExtensionType.TransferFeeConfig,ExtensionType.MetadataPointer,ExtensionType.TokenMetadata].includes(type)),'The official LAUNCHPAD mint differs from the reviewed token.');
  return {key,program:info.owner,mint,extensions};
}
/** The treasury's exact mint rule, for read-only pre-checks (e.g. whether a Pump.fun pair's fees can be converted). */
export { mintInfo as treasuryMintInfo };
function allKeys(tx) {
  const message=tx.transaction?.message,keys=message?.staticAccountKeys||message?.accountKeys;
  ok(Array.isArray(keys),'The finalized treasury receipt is missing account keys.');
  const base=keys.map(value=>String(value.pubkey||value));
  // Parsed RPC messages already include lookup-table keys; raw v0 messages do not.
  const result=base.length===tx.meta?.preBalances?.length?base:[...base,...(tx.meta?.loadedAddresses?.writable||[]).map(String),...(tx.meta?.loadedAddresses?.readonly||[]).map(String)];
  ok(result.length===tx.meta?.preBalances?.length&&result.length===tx.meta?.postBalances?.length&&new Set(result).size===result.length,'The finalized receipt contains incomplete account balances.');return result;
}
function tokenAmount(tx,side,wallet,mint,{ata}={}) {
  const rows=tx.meta?.[side+'TokenBalances'];ok(Array.isArray(rows),'The finalized receipt omitted token balances.');
  const keys=allKeys(tx),seen=new Set();let total=0n;
  for(const row of rows){
    ok(Number.isSafeInteger(row.accountIndex)&&row.accountIndex>=0&&row.accountIndex<keys.length&&!seen.has(row.accountIndex),'The finalized receipt contains invalid token-account indexes.');seen.add(row.accountIndex);
    if(row.owner!==wallet||row.mint!==mint||ata&&keys[row.accountIndex]!==ata)continue;
    total+=quantity(row.uiTokenAmount?.amount,true);
  }
  return total;
}
function nativeDelta(tx,wallet) { const index=allKeys(tx).indexOf(wallet);ok(index>=0&&tx.meta.preBalances?.length===tx.meta.postBalances?.length&&index<tx.meta.preBalances.length,'The finalized receipt omitted the treasury SOL balance.');return lamports(tx.meta.postBalances[index])-lamports(tx.meta.preBalances[index]); }
function revenueTransfers(tx,{sender,destination,mint,upper}) {
  const keys=allKeys(tx),message=tx.transaction.message,programs=[TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID],instructions=[...(message.compiledInstructions||message.instructions||[]),...(tx.meta.innerInstructions||[]).flatMap(row=>row.instructions||[])];
  let total=0n,count=0;
  for(const ix of instructions){
    const program=String(ix.programId||keys[ix.programIdIndex]),indexes=ix.accountKeyIndexes||ix.accounts||[],accounts=indexes.map(index=>typeof index==='number'?keys[index]:String(index)),data=ix.parsed?null:typeof ix.data==='string'?Buffer.from(bs58.decode(ix.data)):Buffer.from(ix.data||[]);
    if(mint===SOL){
      if(program!==SystemProgram.programId.toBase58())continue;
      let from,to,value;
      if(ix.parsed?.type==='transfer'){from=ix.parsed.info?.source;to=ix.parsed.info?.destination;value=lamports(ix.parsed.info?.lamports);}
      else if(data?.length===12&&data.readUInt32LE(0)===2&&accounts.length===2){[from,to]=accounts;value=data.readBigUInt64LE(4);}
      if(to!==destination)continue;ok(from===sender,'The treasury receipt mixes transfers from different senders.');total+=value;count++;continue;
    }
    const tokenProgram=programs.find(value=>value.toBase58()===program);if(!tokenProgram)continue;
    const sourceAta=getAssociatedTokenAddressSync(pk(mint),pk(sender),false,tokenProgram).toBase58(),destinationAta=getAssociatedTokenAddressSync(pk(mint),pk(destination),false,tokenProgram).toBase58();
    ok(!(ix.parsed&&['mintTo','mintToChecked'].includes(ix.parsed.type)&&ix.parsed.info?.account===destinationAta)&&!(data&&[7,14].includes(data[0])&&accounts[1]===destinationAta),'The treasury receipt mixes protocol transfers with minted tokens.');
    let from,to,authority,ixMint,value;
    if(ix.parsed){const detail=ix.parsed.info||{};if(!['transfer','transferChecked','transferCheckedWithFee'].includes(ix.parsed.type))continue;from=detail.source;to=detail.destination;authority=detail.authority||detail.owner;ixMint=detail.mint;value=quantity(detail.amount||detail.tokenAmount?.amount,true);}
    else if(data?.length===10&&data[0]===12&&accounts.length===4){[from,ixMint,to,authority]=accounts;value=data.readBigUInt64LE(1);}
    else if(data?.length===9&&data[0]===3&&accounts.length===3){[from,to,authority]=accounts;value=data.readBigUInt64LE(1);}
    else if(data?.length===19&&data[0]===26&&data[1]===1&&accounts.length===4){[from,ixMint,to,authority]=accounts;value=data.readBigUInt64LE(2);}
    if(to!==destinationAta)continue;
    ok(from===sourceAta&&authority===sender&&(!ixMint||ixMint===mint),'The treasury token receipt has a different sender, mint or authority.');total+=value;count++;
  }
  ok(count>0&&total>0n&&total<=upper,'The receipt has no matching protocol transfer within its expected amount.');return total;
}
function receiptIdentity(tx,signature) { ok(tx.transaction?.signatures?.[0]===signature&&Number.isSafeInteger(tx.slot)&&tx.slot>=0&&tx.meta&&Object.hasOwn(tx.meta,'err'),'The finalized treasury receipt is incomplete or has the wrong signature.');lamports(tx.meta.fee); }

/** The service journals this adapter's signed bytes before broadcast. No method
 * infers protocol revenue from a wallet balance: every credit needs an exact,
 * finalized, expected source receipt. The signer is used only after simulation. */
export class ProtocolTreasuryChain extends LaunchChain {
  constructor(options={}) {
    super({...options,network:options.network||'mainnet-beta'});this.now=options.now||Date.now;this.routes=options.routes||{quoteConversion,buildConversion};
    // Mints the treasury may burn besides the official token (set by a product mode); they pass the ordinary mint rule,
    // never the official-token rule.
    this.burnMints=new Set((options.burnMints||[]).filter(value=>typeof value==='string'));
    const fetcher=this.fetcher;
    // Route results intentionally expose no provider internals. Check the
    // original JSON within this adapter, without changing user-trade slippage.
    this.fetcher=async(url,config)=>{
      const response=await fetcher(url,config);
      if(!String(url).startsWith('https://api.jup.ag/swap/v2/build?')||!response.ok)return response;
      const body=await response.json();
      const impact=body?.priceImpactPct;
      const validImpact=(typeof impact==='number'||typeof impact==='string'&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(impact))&&Number.isFinite(Number(impact));
      if(!validImpact)throw treasuryRouteGuardError('TREASURY_INVALID_IMPACT');
      // Subclasses may tighten the guard per operation (AI Agent settlement
      // uses 50 bps); the protocol treasury keeps its 2% / 100 bps defaults.
      if(Math.abs(Number(impact))>(this.routeGuard?.maxImpact??.02))throw treasuryRouteGuardError('TREASURY_PRICE_IMPACT');
      if(body.slippageBps!==(this.routeGuard?.slippageBps??100))throw treasuryRouteGuardError('TREASURY_SLIPPAGE_LIMIT');
      return {ok:response.ok,status:response.status,headers:response.headers,json:async()=>body};
    };
  }
  async gasBalances(addresses) {
    ok(Array.isArray(addresses)&&addresses.length>0&&addresses.length<=100&&new Set(addresses).size===addresses.length,'Gas balance requests require one to one hundred distinct wallets.');
    const keys=addresses.map(address=>{ok(typeof address==='string','Invalid gas funding wallet.');const key=pk(address);ok(key.toBase58()===address&&PublicKey.isOnCurve(key.toBytes()),'Invalid gas funding wallet.');return key;});
    const result=snapshot(await this.c.getMultipleAccountsInfoAndContext(keys,{commitment:'finalized'}),keys.length,1);
    return {slot:result.context.slot,balances:addresses.map((address,index)=>({address,lamports:gasNativeBalance(result.value[index],true).toString()}))};
  }
  /**
   * Finalized accounts at or after `minimum`. The route was audited at confirmed
   * state, so the snapshot waits (bounded) for finalization to reach that slot,
   * and rides out a briefly busy RPC the same way. An RPC still behind or busy
   * afterwards fails with its last error, which callers treat as a wait.
   */
  async finalizedSnapshot(keys,minimum) {
    for(let attempt=0;;attempt++){
      let result=null,lag=null;
      try{result=await this.c.getMultipleAccountsInfoAndContext(keys,{commitment:'finalized',minContextSlot:minimum});}
      catch(error){if(!transientRead(error))throw error;lag=error;}
      if(result&&!(Number.isSafeInteger(result?.context?.slot)&&result.context.slot<minimum))return snapshot(result,keys.length,minimum);
      if(attempt>=FINALIZED_WAIT_ATTEMPTS)throw lag||Object.assign(Error('Minimum context slot has not been reached'),{code:-32016});
      await this.sleep(FINALIZED_WAIT_MS);
    }
  }
  async prepare(request) {
    let oversized;
    for(const routeAccountBudget of ['convert','buy','acquire'].includes(request?.kind)?SOL_ROUTE_ACCOUNT_BUDGETS:[32]){
      try{return await this.prepareOnce({...request,routeAccountBudget});}
      catch(error){if(error?.code==='TREASURY_ROUTE_TOO_LARGE'){oversized=error;continue;}if(oversized&&error?.code==='SOL_ROUTE_NOT_FOUND')continue;throw error;}
    }
    throw oversized;
  }
  async readOperationMint(kind,key,owner) {
    const support=ray.getPdaMintExAccountCp(this.ids.CREATE_CPMM_POOL_PROGRAM,key);
    let first=snapshot(await this.c.getMultipleAccountsInfoAndContext([key,support.publicKey,owner],{commitment:'finalized'}),3);
    try { return {first,info:mintInfo(key,first.value[0],first.value[1],this.ids.CREATE_CPMM_POOL_PROGRAM,support.nonce,{official:!['convert','acquire'].includes(kind)&&!(kind==='burn'&&this.burnMints.has(key.toBase58()))})}; }
    catch(error) {
      // Meteora revenue can include issuer-controlled stocks which Raydium has
      // not registered. Only conversion may use this independent DBC proof;
      // the official LAUNCHPAD purchase/burn allowlist is never widened.
      if(!['convert','acquire'].includes(kind)||error?.message!=='The treasury mint has unsupported extensions.')throw error;
      const badge=meteoraTokenBadgeAddress(key);
      first=snapshot(await this.c.getMultipleAccountsInfoAndContext([key,badge,owner],{commitment:'finalized',minContextSlot:first.context.slot}),3,first.context.slot);
      ok(validMeteoraTokenBadge(key,first.value[1]),'The treasury mint has unsupported extensions or lacks a valid Meteora quote badge.');
      const epoch=await this.c.getEpochInfo({commitment:'finalized',minContextSlot:first.context.slot});
      ok(Number.isSafeInteger(epoch?.epoch)&&epoch.epoch>=0&&Number.isSafeInteger(epoch?.absoluteSlot)&&epoch.absoluteSlot>=first.context.slot,'The RPC omitted the finalized treasury mint epoch.');
      const inspected=inspectMeteoraQuoteMint(key,first.value[0],{epoch:epoch.epoch,tokenBadge:first.value[1]});
      ok(inspected.supported===true&&validMeteoraTokenBadge(key,first.value[1]),'The treasury mint has unsupported extensions or lacks a valid Meteora quote badge.');
      return {first,info:mintInfo(key,first.value[0],null,this.ids.CREATE_CPMM_POOL_PROGRAM,support.nonce,{meteoraRegistered:true})};
    }
  }
  async prepareOnce({kind,wallet,mint,amount,minSolReserve='0',maxNetworkCostLamports='5000000',recipient,routeAccountBudget=32,priorityMicroLamports,feeLimitLamports}) {
    if(kind==='withdraw'||kind==='gas-refill')return this.prepareWithdrawal({kind,wallet,mint,amount,minSolReserve,maxNetworkCostLamports,recipient});
    if(kind==='airdrop')return this.prepareAirdrop({wallet,mint,amount,recipients:recipient,minSolReserve,maxNetworkCostLamports});
    const maxCost=quantity(maxNetworkCostLamports);ok(maxCost<=EXTRA_COST_LIMIT,'The treasury network-cost limit is too large.');
    // A caller may raise the priority price (and the network-fee limit with it) so a time-sensitive swap lands; both stay within the operation's cost limit.
    const custom=priorityMicroLamports!==undefined||feeLimitLamports!==undefined,price=custom?priorityMicroLamports:10000,feeLimit=custom?quantity(String(feeLimitLamports)):FEE_LIMIT;
    if(custom)ok(Number.isSafeInteger(price)&&price>=0&&price<=2000000&&feeLimit<=maxCost&&feeLimit<=EXTRA_COST_LIMIT,'The treasury priority settings are invalid.');
    // `acquire` buys an arbitrary Launchpad-launched mint (Gotchi prize purchases);
    // `buy` remains limited to the official LAUNCHPAD token.
    ok(['convert','buy','burn','acquire'].includes(kind),'Unknown treasury operation.');
    const owner=pk(wallet?.address),input=quantity(amount),reserve=quantity(minSolReserve,true);
    ok(PublicKey.isOnCurve(owner.toBytes())&&typeof wallet?.secret==='string'&&wallet.secret.length>0,'A managed treasury signer is required.');
    const key=pk(mint),buying=kind==='buy'||kind==='acquire';ok(['convert','acquire'].includes(kind)?mint!==SOL:kind==='burn'&&this.burnMints.has(mint)?true:mint===PROTOCOL_TOKEN_MINT,'The treasury operation uses the wrong mint.');
    const {first,info}=await this.readOperationMint(kind,key,owner),ata=getAssociatedTokenAddressSync(key,owner,false,info.program);
    let before=snapshot(await this.c.getMultipleAccountsInfoAndContext([owner,ata],{commitment:'finalized',minContextSlot:first.context.slot}),2,first.context.slot);
    let native=nativeBalance(before.value[0]),token=parsedToken(ata,before.value[1],info,owner,buying),balance=token?.amount||0n;
    ok(buying||balance>=input,'The credited treasury tokens are no longer available.');
    let instructions,route=null,quote=null,minimum=0n,expected=0n;
    if(kind==='burn')instructions=[createBurnCheckedInstruction(ata,key,owner,input,info.mint.decimals,[],info.program)];
    else {
      quote=await this.routes.quoteConversion(this,{inputMint:buying?SOL:mint,outputMint:buying?mint:SOL,inputProgram:buying?TOKEN_PROGRAM_ID:info.program,outputProgram:buying?info.program:TOKEN_PROGRAM_ID,amountRaw:amount,slippageBps:this.routeGuard?.slippageBps??100,wallet:wallet.address,maxAccounts:routeAccountBudget});
      minimum=quantity(quote.minimumRaw);expected=quantity(quote.expectedRaw);ok(minimum<=expected,'Invalid treasury route minimum.');
      route=await this.routes.buildConversion(this,quote);instructions=route.instructions;
    }
    ok(Array.isArray(instructions)&&instructions.length>0&&instructions.length<=24&&instructions.every(ix=>ix.keys.every(meta=>!meta.isSigner||meta.pubkey.equals(owner))),'The treasury transaction includes an unauthorized signer.');
    const extras=route?.monitoredAccounts||[];ok(Array.isArray(extras)&&extras.length<=32,'The treasury route has too many intermediate accounts.');
    const monitored=[],seen=new Set([wallet.address,ata.toBase58()]);
    for(const row of extras){ok(!seen.has(row.address),'Duplicate treasury route account.');seen.add(row.address);quantity(row.minimumAmountRaw,true);lamports(row.minimumLamports);monitored.push({...row,key:pk(row.address),info:{key:pk(row.mint),program:pk(row.program)}});}
    const compile=recentBlockhash=>new TransactionMessage({payerKey:owner,recentBlockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:price}),...instructions]}).compileToV0Message(route?.lookupTables||[]);
    // The size does not depend on the blockhash: a route too large for one transaction is refused before waiting for finalization.
    if(transactionSize(compile(PublicKey.default.toBase58()))>1232)throw Object.assign(Error('The treasury route is too large for one atomic transaction.'),{code:'TREASURY_ROUTE_TOO_LARGE'});
    before=await this.finalizedSnapshot([owner,ata,...monitored.map(row=>row.key)],Math.max(before.context.slot,quote?.slot||0));
    native=nativeBalance(before.value[0]);token=parsedToken(ata,before.value[1],info,owner,buying);balance=token?.amount||0n;ok(buying||balance>=input,'The credited treasury tokens are no longer available.');
    for(let i=0;i<monitored.length;i++)if(before.value[i+2]){const row=monitored[i],value=before.value[i+2],account=parsedToken(row.key,value,row.info,owner);row.minimumAmountRaw=(account.amount>BigInt(row.minimumAmountRaw)?account.amount:BigInt(row.minimumAmountRaw)).toString();row.minimumLamports=Math.max(row.minimumLamports,Number(lamports(value.lamports)));}
    const block=await this.c.getLatestBlockhash('finalized');ok(Number.isSafeInteger(block.lastValidBlockHeight)&&block.lastValidBlockHeight>=151,'The RPC omitted treasury transaction expiry.');
    const message=compile(block.blockhash);
    ok(message.header.numRequiredSignatures===1,'The treasury route requires another signer.');
    if(transactionSize(message)>1232)throw Object.assign(Error('The treasury route is too large for one atomic transaction.'),{code:'TREASURY_ROUTE_TOO_LARGE'});
    const feeResult=await this.c.getFeeForMessage(message,'finalized'),fee=lamports(feeResult?.value);ok(fee>0n&&fee<=feeLimit,'The treasury network fee exceeds its limit.');
    const tx=new VersionedTransaction(message),addresses=[wallet.address,ata.toBase58(),...monitored.map(row=>row.address),...(kind==='burn'?[mint]:[])],minSlot=Math.max(first.context.slot,before.context.slot,quote?.slot||0);
    const sim=await this.simulatePrepared(tx,{sigVerify:false,commitment:'finalized',minContextSlot:minSlot,accounts:{encoding:'base64',addresses}},block.lastValidBlockHeight);
    ok(!sim.value?.err,`Treasury simulation failed: ${JSON.stringify(sim.value?.err)}.`);
    ok(Number.isSafeInteger(sim.context?.slot)&&sim.context.slot>=minSlot&&Array.isArray(sim.value.accounts)&&sim.value.accounts.length===addresses.length,'The RPC omitted treasury simulation balances.');
    const afterNative=nativeBalance(accountInfo(sim.value.accounts[0])),afterInfo=accountInfo(sim.value.accounts[1]),afterToken=parsedToken(ata,afterInfo,info,owner),afterAmount=afterToken.amount;
    if(before.value[1])ok(lamports(afterInfo.lamports)>=lamports(before.value[1].lamports),'The treasury route would withdraw token-account rent.');
    for(let i=0;i<monitored.length;i++){const row=monitored[i],value=accountInfo(sim.value.accounts[i+2]),after=parsedToken(row.key,value,row.info,owner);ok(after.amount>=BigInt(row.minimumAmountRaw)&&lamports(value.lamports)>=BigInt(row.minimumLamports),'The treasury route would spend an unrelated token balance or its rent.');}
    const rentSpent=sim.value.accounts.slice(1,2+monitored.length).reduce((sum,value,index)=>{const after=lamports(value?.lamports||0),prior=lamports(before.value[index+1]?.lamports||0);return sum+(after>prior?after-prior:0n);},0n);
    const networkCost=fee+rentSpent;ok(networkCost<=maxCost,'The treasury network and rent cost exceeds its operation limit.');
    const cost=buying?native-afterNative-input:kind==='burn'?native-afterNative:networkCost;
    if(buying)ok(afterAmount-balance>=minimum&&cost>=0n&&cost<=maxCost,'The treasury purchase exceeds its input budget or fails to deliver the minimum tokens.');
    else if(kind==='convert')ok(balance-afterAmount===input&&afterNative-native>=minimum-maxCost&&afterNative>native,'The treasury conversion spends a different amount or produces no net SOL.');
    else {ok(balance-afterAmount===input&&cost===fee,'The treasury burn changed a different balance or network fee.');const afterMint=unpackMint(key,accountInfo(sim.value.accounts.at(-1)),info.program);ok(info.mint.supply-afterMint.supply===input,'The treasury burn did not reduce the official LAUNCHPAD supply.');}
    ok(afterNative>=reserve,'The treasury operation would use its minimum SOL reserve.');
    const secret=bs58.decode(wallet.secret);let bytes;
    try { const signer={publicKey:Keypair.fromSecretKey(secret).publicKey,secretKey:secret};ok(signer.publicKey.equals(owner),'The treasury signer does not match its wallet.');tx.sign([signer]);bytes=Buffer.from(tx.serialize());verifySignedTransaction(bytes,wallet.address); }
    finally {secret.fill(0);}
    return {kind,mint,wallet:wallet.address,inputAmount:amount,minimumOutput:minimum.toString(),expectedOutput:expected.toString(),signature:bs58.encode(tx.signatures[0]),raw:bytes.toString('base64'),rawHash:hash(bytes),...block,preparedSlot:sim.context.slot,createdAt:this.now(),accounting:{maxCostLamports:maxCost.toString(),rentSpentLamports:rentSpent.toString(),monitoredAccounts:[ata.toBase58(),...monitored.map(row=>row.address)],ata:ata.toBase58(),program:info.program.toBase58(),decimals:info.mint.decimals,minSolReserve:reserve.toString(),networkFeeLamports:fee.toString(),beforeSol:native.toString(),beforeTokens:balance.toString(),simulatedSolDelta:(afterNative-native).toString(),simulatedTokenDelta:(afterAmount-balance).toString()}};
  }
  async prepareWithdrawal({kind='withdraw',wallet,mint,amount,recipient,minSolReserve,maxNetworkCostLamports}) {
    const owner=pk(wallet?.address),to=pk(recipient),input=quantity(amount),reserve=quantity(minSolReserve,true),maxCost=quantity(maxNetworkCostLamports);
    ok(kind==='withdraw'||kind==='gas-refill','Unknown native treasury operation.');
    ok(mint===SOL&&PublicKey.isOnCurve(owner.toBytes())&&PublicKey.isOnCurve(to.toBytes())&&!owner.equals(to)&&typeof wallet?.secret==='string','The retained SOL withdrawal has an invalid wallet.');
    ok(input<=BigInt(Number.MAX_SAFE_INTEGER)&&maxCost<=EXTRA_COST_LIMIT,'The retained SOL withdrawal exceeds its supported range.');
    if(kind==='gas-refill')ok(reserve>=GAS_SOL_RESERVE,'Gas refills must preserve at least 0.01 SOL in the funding wallet.');
    const before=snapshot(await this.c.getMultipleAccountsInfoAndContext([owner,to],{commitment:'finalized'}),2,kind==='gas-refill'?1:0),balance=kind==='gas-refill'?gasNativeBalance(before.value[0]):nativeBalance(before.value[0]),recipientBefore=kind==='gas-refill'?gasNativeBalance(before.value[1],true):before.value[1]?nativeBalance(before.value[1]):0n;
    if(kind==='gas-refill')ok(recipientBefore<5000000n&&recipientBefore+input<=20000000n,'The gas recipient is already funded or its balance changed before this refill.');
    const block=await this.c.getLatestBlockhash('finalized');ok(Number.isSafeInteger(block.lastValidBlockHeight)&&block.lastValidBlockHeight>=151,'The RPC omitted treasury transaction expiry.');
    const message=new TransactionMessage({payerKey:owner,recentBlockhash:block.blockhash,instructions:[SystemProgram.transfer({fromPubkey:owner,toPubkey:to,lamports:Number(input)})]}).compileToV0Message(),tx=new VersionedTransaction(message);
    const fee=lamports((await this.c.getFeeForMessage(message,'finalized'))?.value);ok(fee>0n&&fee<=FEE_LIMIT&&fee<=maxCost,'The withdrawal network fee exceeds its limit.');
    const sim=await this.simulatePrepared(tx,{sigVerify:false,commitment:'finalized',minContextSlot:before.context.slot,accounts:{encoding:'base64',addresses:[wallet.address,recipient]}},block.lastValidBlockHeight);
    ok(!sim.value?.err&&Number.isSafeInteger(sim.context?.slot)&&sim.context.slot>=before.context.slot&&sim.value.accounts?.length===2,'The retained SOL withdrawal simulation failed.');
    const after=kind==='gas-refill'?gasSimulationBalance(sim.value.accounts[0]):nativeBalance(accountInfo(sim.value.accounts[0])),recipientAfter=kind==='gas-refill'?gasSimulationBalance(sim.value.accounts[1]):nativeBalance(accountInfo(sim.value.accounts[1]));
    ok(balance-after===input+fee&&recipientAfter-recipientBefore===input&&after>=reserve,'The withdrawal would exceed its retained SOL or protected reserve.');
    const secret=bs58.decode(wallet.secret);let raw;
    try {const publicKey=Keypair.fromSecretKey(secret).publicKey;ok(publicKey.equals(owner),'The treasury signer does not match its wallet.');tx.sign([{publicKey,secretKey:secret}]);raw=Buffer.from(tx.serialize());verifySignedTransaction(raw,wallet.address);}finally{secret.fill(0);}
    return {kind,mint,wallet:wallet.address,recipient,inputAmount:amount,minimumOutput:'0',expectedOutput:'0',signature:bs58.encode(tx.signatures[0]),raw:raw.toString('base64'),rawHash:hash(raw),...block,preparedSlot:sim.context.slot,createdAt:this.now(),accounting:{maxCostLamports:maxCost.toString(),monitoredAccounts:[],minSolReserve:reserve.toString(),networkFeeLamports:fee.toString(),beforeSol:balance.toString()}};
  }
  /**
   * Airdrop batch: transferChecked of `mint` from the treasury wallet to each recipient's associated token account
   * (created idempotently when missing; the rent is network cost under the operation's limit). `amount` is the batch total
   * and must equal the sum of the recipients' amounts. Simulated against finalized state and verified like every other
   * treasury transaction: the source loses exactly the total, each recipient gains exactly its share, nothing else moves.
   */
  async prepareAirdrop({wallet,mint,amount,recipients,minSolReserve='0',maxNetworkCostLamports='5000000'}) {
    const owner=pk(wallet?.address),input=quantity(amount),reserve=quantity(minSolReserve,true),maxCost=quantity(maxNetworkCostLamports);
    ok(PublicKey.isOnCurve(owner.toBytes())&&typeof wallet?.secret==='string'&&wallet.secret.length>0,'A managed treasury signer is required.');
    ok(Array.isArray(recipients)&&recipients.length>=1&&recipients.length<=12&&maxCost<=EXTRA_COST_LIMIT,'An airdrop batch names one to twelve recipients.');
    const rows=recipients.map(row=>{const to=pk(row?.owner),share=quantity(String(row?.amount));ok(PublicKey.isOnCurve(to.toBytes())&&!to.equals(owner)&&share>0n,'An airdrop recipient is invalid.');return {owner:to,amount:share};});
    ok(new Set(rows.map(row=>row.owner.toBase58())).size===rows.length&&rows.reduce((sum,row)=>sum+row.amount,0n)===input,'The airdrop batch total does not match its recipients.');
    const key=pk(mint),{first,info}=await this.readOperationMint('convert',key,owner),program=info.program,source=getAssociatedTokenAddressSync(key,owner,false,program);
    const targets=rows.map(row=>({...row,ata:getAssociatedTokenAddressSync(key,row.owner,true,program)}));
    const before=snapshot(await this.c.getMultipleAccountsInfoAndContext([owner,source,...targets.map(row=>row.ata)],{commitment:'finalized',minContextSlot:first.context.slot}),2+targets.length,first.context.slot);
    const native=nativeBalance(before.value[0]),held=parsedToken(source,before.value[1],info,owner);ok(held.amount>=input,'The treasury does not hold the airdrop batch total.');
    const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:60000+70000*targets.length}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000})];
    for(const [i,row] of targets.entries()){if(!before.value[i+2])instructions.push(createAssociatedTokenAccountIdempotentInstruction(owner,row.ata,row.owner,key,program));else parsedToken(row.ata,before.value[i+2],info,row.owner);instructions.push(createTransferCheckedInstruction(source,key,row.ata,owner,row.amount,info.mint.decimals,[],program));}
    const block=await this.c.getLatestBlockhash('finalized');ok(Number.isSafeInteger(block.lastValidBlockHeight)&&block.lastValidBlockHeight>=151,'The RPC omitted treasury transaction expiry.');
    const message=new TransactionMessage({payerKey:owner,recentBlockhash:block.blockhash,instructions}).compileToV0Message();
    ok(message.header.numRequiredSignatures===1,'The airdrop requires another signer.');ok(transactionSize(message)<=1232,'The airdrop batch is too large for one transaction.');
    const feeResult=await this.c.getFeeForMessage(message,'finalized'),fee=lamports(feeResult?.value);ok(fee>0n&&fee<=FEE_LIMIT,'The airdrop network fee exceeds its limit.');
    const tx=new VersionedTransaction(message),addresses=[wallet.address,source.toBase58(),...targets.map(row=>row.ata.toBase58())];
    const sim=await this.simulatePrepared(tx,{sigVerify:false,commitment:'finalized',minContextSlot:before.context.slot,accounts:{encoding:'base64',addresses}},block.lastValidBlockHeight);
    ok(!sim.value?.err,`Airdrop simulation failed: ${JSON.stringify(sim.value?.err)}.`);
    ok(Number.isSafeInteger(sim.context?.slot)&&sim.context.slot>=before.context.slot&&Array.isArray(sim.value.accounts)&&sim.value.accounts.length===addresses.length,'The RPC omitted airdrop simulation balances.');
    const afterNative=nativeBalance(accountInfo(sim.value.accounts[0])),afterSource=parsedToken(source,accountInfo(sim.value.accounts[1]),info,owner);
    ok(held.amount-afterSource.amount===input,'The airdrop simulation moved a different total.');
    let rentSpent=0n;
    for(const [i,row] of targets.entries()){const value=accountInfo(sim.value.accounts[i+2]),after=parsedToken(row.ata,value,info,row.owner),prior=before.value[i+2]?parsedToken(row.ata,before.value[i+2],info,row.owner).amount:0n;ok(after.amount-prior===row.amount,'An airdrop recipient would receive a different amount.');const priorLamports=lamports(before.value[i+2]?.lamports||0);const diff=lamports(value.lamports)-priorLamports;if(diff>0n)rentSpent+=diff;}
    const cost=native-afterNative;ok(cost===fee+rentSpent&&cost<=maxCost,'The airdrop network and rent cost exceeds its limit.');ok(afterNative>=reserve,'The airdrop would use the treasury SOL reserve.');
    const secret=bs58.decode(wallet.secret);let bytes;
    try { const signer={publicKey:Keypair.fromSecretKey(secret).publicKey,secretKey:secret};ok(signer.publicKey.equals(owner),'The treasury signer does not match its wallet.');tx.sign([signer]);bytes=Buffer.from(tx.serialize());verifySignedTransaction(bytes,wallet.address); }
    finally {secret.fill(0);}
    return {kind:'airdrop',mint,wallet:wallet.address,inputAmount:amount,minimumOutput:'0',expectedOutput:'0',signature:bs58.encode(tx.signatures[0]),raw:bytes.toString('base64'),rawHash:hash(bytes),...block,preparedSlot:sim.context.slot,createdAt:this.now(),accounting:{maxCostLamports:maxCost.toString(),monitoredAccounts:[],minSolReserve:reserve.toString(),networkFeeLamports:fee.toString(),rentLamports:rentSpent.toString(),ata:source.toBase58(),decimals:info.mint.decimals,recipients:targets.map(row=>({owner:row.owner.toBase58(),ata:row.ata.toBase58(),amount:row.amount.toString()}))}};
  }
  /**
   * Holder snapshot: every holder of one mint (complete finalized scan, aggregated by owner). Program-owned
   * (off-curve) holders such as pools and bonding curves, frozen accounts and the exclusion set never count.
   */
  async mintHolders({mint,exclude=[]}) {
    const key=pk(mint),info=await this.c.getAccountInfo(key,{commitment:'finalized'});
    ok(info&&!info.executable&&[TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(info.owner)),'The holder scan mint has an unsupported token program.');
    const program=info.owner,excluded=new Set(exclude),response=await readMintTokenAccounts(this,program,key),balances=new Map();
    for(const row of response.value){const account=unpackAccount(row.pubkey,row.account,program),holder=account.owner.toBase58();if(!account.amount||account.isFrozen||excluded.has(holder)||!PublicKey.isOnCurve(account.owner.toBytes()))continue;balances.set(holder,(balances.get(holder)||0n)+account.amount);}
    return {mint,program:program.toBase58(),slot:response.context.slot,scanned:response.value.length,rows:[...balances].map(([owner,amount])=>({owner,amount:amount.toString()}))};
  }
  verifyOperation(op) {
    ok(op&&typeof op.raw==='string'&&op.raw.length<=1644&&typeof op.wallet==='string','Invalid saved treasury transaction.');
    const bytes=Buffer.from(op.raw,'base64');ok(bytes.toString('base64')===op.raw&&hash(bytes)===op.rawHash,'The saved treasury transaction bytes changed.');
    const tx=VersionedTransaction.deserialize(bytes),identity=verifySignedTransaction(bytes,op.wallet);
    ok(tx.version===0&&identity.signature===op.signature&&tx.message.recentBlockhash===op.blockhash&&Number.isSafeInteger(op.lastValidBlockHeight),'The saved treasury transaction identity changed.');
    if(op.kind==='gas-refill')verifyGasTransfer(op,tx);return {bytes,tx};
  }
  async broadcast(op) {const {bytes}=this.verifyOperation(op);const result=await this.c.sendRawTransaction(bytes,{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:op.preparedSlot});ok(result===op.signature,'The RPC returned a different treasury signature.');return result;}
  async state(op) {this.verifyOperation(op);return this.pendingTransactionState(op);}
  async receipt(op,walletAddress=op?.wallet) {
    const {tx:signed}=this.verifyOperation(op);ok(walletAddress===op.wallet,'The treasury receipt belongs to another wallet.');
    const tx=await super.receipt(op);if(!tx)return null;receiptIdentity(tx,op.signature);
    ok(Buffer.from(tx.transaction.message.serialize()).equals(Buffer.from(signed.message.serialize())),'The finalized treasury transaction differs from its saved message.');
    const delta=nativeDelta(tx,walletAddress),fee=lamports(tx.meta.fee),failed=tx.meta.err!==null;
    const nativeTransfer=['withdraw','gas-refill'].includes(op.kind),pre=nativeTransfer?0n:tokenAmount(tx,'pre',walletAddress,op.mint,{ata:op.accounting.ata}),post=nativeTransfer?0n:tokenAmount(tx,'post',walletAddress,op.mint,{ata:op.accounting.ata}),tokenDelta=post-pre,input=quantity(op.inputAmount),minimum=quantity(op.minimumOutput,true),maxCost=quantity(op.accounting.maxCostLamports);
    const keys=allKeys(tx);const rentSpent=(op.accounting.monitoredAccounts||[]).reduce((sum,address)=>{const index=keys.indexOf(address);ok(index>=0,'The receipt omitted a monitored treasury account.');const diff=lamports(tx.meta.postBalances[index])-lamports(tx.meta.preBalances[index]);return sum+(diff>0n?diff:0n);},0n);
    ok(fee+rentSpent<=maxCost,'The finalized treasury network cost exceeds its reserved amount.');
    const result={state:failed?'failed':'confirmed',signature:op.signature,slot:tx.slot,feeLamports:fee.toString(),inputAmount:op.inputAmount,outputAmount:'0',solDelta:delta.toString(),tokenDelta:tokenDelta.toString(),actualSolCostLamports:'0',outputDecimals:op.kind==='buy'?6:op.kind==='acquire'?op.accounting.decimals:9,error:failed?tx.meta.err:null};
    if(op.kind==='gas-refill'){
      ok(fee>0n&&fee<=FEE_LIMIT&&Array.isArray(tx.meta.preTokenBalances)&&tx.meta.preTokenBalances.length===0&&Array.isArray(tx.meta.postTokenBalances)&&tx.meta.postTokenBalances.length===0&&(tx.meta.innerInstructions||[]).length===0,'The gas refill receipt contains unexpected fees or token movements.');
      for(const address of keys)if(address!==op.wallet&&address!==op.recipient)ok(nativeDelta(tx,address)===0n,'The gas refill receipt changed an unrelated SOL balance.');
      ok(nativeDelta(tx,op.recipient)===(failed?0n:input),'The gas refill receipt changed a different recipient amount.');
      if(!failed)ok(lamports(tx.meta.postBalances[keys.indexOf(walletAddress)])>=quantity(op.accounting.minSolReserve,true),'The finalized gas funding balance fell below its reserve.');
      result.recipient=op.recipient;result.mint=op.mint;
    }
    if(failed){ok(tokenDelta===0n&&delta===-fee,'A failed treasury receipt changed unexpected balances.');result.actualSolCostLamports=fee.toString();return result;}
    if(op.kind==='convert'){ok(tokenDelta===-input&&delta>0n&&delta>=minimum-maxCost,'The finalized conversion differs from its authorized input or minimum output.');result.outputAmount=delta.toString();result.actualSolCostLamports=(fee+rentSpent).toString();}
    else if(op.kind==='buy'||op.kind==='acquire'){const cost=-delta-input;ok(tokenDelta>=minimum&&cost>=0n&&cost<=maxCost,'The finalized buy differs from its authorized input or minimum output.');result.outputAmount=tokenDelta.toString();result.actualSolCostLamports=cost.toString();}
    else if(nativeTransfer){const cost=-delta-input;ok(nativeDelta(tx,op.recipient)===input&&cost===fee,'The finalized withdrawal differs from its authorized payout.');result.actualSolCostLamports=fee.toString();}
    else if(op.kind==='airdrop'){
      const rows=op.accounting.recipients;ok(Array.isArray(rows)&&rows.length>0&&tokenDelta===-input,'The finalized airdrop moved a different total.');
      let rent=0n;for(const row of rows){const got=tokenAmount(tx,'post',row.owner,op.mint,{ata:row.ata})-tokenAmount(tx,'pre',row.owner,op.mint,{ata:row.ata});ok(got===quantity(row.amount),'A finalized airdrop recipient received a different amount.');const index=keys.indexOf(row.ata);if(index>=0){const diff=lamports(tx.meta.postBalances[index])-lamports(tx.meta.preBalances[index]);if(diff>0n)rent+=diff;}}
      ok(-delta===fee+rent&&fee+rent<=maxCost,'The finalized airdrop cost differs from its reserved network cost.');result.actualSolCostLamports=(fee+rent).toString();result.recipients=rows.map(row=>({owner:row.owner,amount:row.amount}));
    }
    else {ok(op.kind==='burn'&&tokenDelta===-input&&delta===-fee,'The finalized burn differs from its authorized token amount.');result.actualSolCostLamports=fee.toString();}
    const index=allKeys(tx).indexOf(walletAddress);ok(lamports(tx.meta.postBalances[index])>=quantity(op.accounting.minSolReserve,true),'The finalized treasury balance fell below its reserve.');
    return result;
  }
  async incomingReceipt(source,{wallet}) {
    const destination=typeof wallet==='string'?wallet:wallet?.address,sender=source?.sourceWallet,mint=source?.mint,upper=quantity(source?.amount);
    pk(destination);pk(sender);pk(mint);ok(destination!==sender&&typeof source.signature==='string','Invalid treasury revenue source.');
    const tx=await super.receipt({signature:source.signature});if(!tx)return null;receiptIdentity(tx,source.signature);ok(tx.meta.err===null,'The revenue transfer failed onchain.');
    const keys=allKeys(tx),message=tx.transaction.message,signerIndex=keys.indexOf(sender);ok(signerIndex>=0&&signerIndex<message.header.numRequiredSignatures,'The expected revenue sender did not sign this transaction.');
    const transferred=revenueTransfers(tx,{sender,destination,mint,upper});
    const received=mint===SOL?nativeDelta(tx,destination):tokenAmount(tx,'post',destination,mint)-tokenAmount(tx,'pre',destination,mint);
    const debit=mint===SOL?-nativeDelta(tx,sender):tokenAmount(tx,'pre',sender,mint)-tokenAmount(tx,'post',sender,mint);
    const sourceDebit=mint===SOL?transferred:debit;
    ok(received>0n&&received<=transferred&&sourceDebit>=received&&sourceDebit<=upper&&(mint!==SOL||received===transferred),'The finalized transfer does not match the expected protocol revenue.');
    return {id:`${source.signature}:${mint}:${destination}`,signature:source.signature,mint,wallet:destination,sourceWallet:sender,receivedAmount:received.toString(),sourceDebitAmount:sourceDebit.toString(),transferredAmount:transferred.toString(),slot:tx.slot};
  }
}
