import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { acquireProcessLock } from './process-lock.mjs';
import { isCurrentLaunch, SOL_MINT, units } from '../public/launchpad-model.mjs';
import { protocolWalletSelection } from './launchpad-protocol-wallet.mjs';
import { includeManualProtocolHistory } from './protocol-manual-history.mjs';
import { PAYCHECK_POLICY, paycheckLaunch } from './launchpad-paycheck.mjs';
import { PLATFORM_TOKEN_MINT } from './platform-token.mjs';

// The platform token the treasury buys back and burns (LAUNCHPAD_TOKEN_MINT). Without one, all revenue stays in SOL.
export const LAUNCHPAD_TREASURY_MINT=PLATFORM_TOKEN_MINT;
export const TREASURY_POLICY=Object.freeze({buybackBps:5000,slippageBps:100,maxPriceImpactPercent:2,minimumBuyLamports:'1000000',gasReserveLamports:'10000000',dailyNetworkLimitLamports:'20000000',maximumOperationCostLamports:'5000000'});
const NAME='protocol-treasury',MAX=2n**64n-1n;
const BALANCE_REFRESH_MS=60000;
const unknownBalance=(address,status=address?'unavailable':'unconfigured')=>({status,address:address||'',lamports:null,observedAt:null,slot:null,commitment:'finalized'});
const fail=(message,statusCode=400)=>{throw Object.assign(Error(message),{statusCode});};
const uint=value=>{if(typeof value!=='string'||!/^\d{1,20}$/.test(value)||BigInt(value)>MAX)fail('Invalid treasury amount.');return BigInt(value);};
const optionalUint=value=>{try{return uint(value);}catch{return null;}};
const delta=value=>{try{if(typeof value!=='string'||!/^[-]?\d{1,20}$/.test(value))return null;return BigInt(value);}catch{return null;}};
const address=value=>{try{if(typeof value!=='string')throw Error();return new PublicKey(value).toBase58();}catch{fail('Enter a valid Solana address.');}};
const walletAddress=value=>{const key=new PublicKey(address(value));if(!PublicKey.isOnCurve(key.toBytes()))fail('Enter a valid Solana wallet.');return key.toBase58();};
const reason=value=>{if(typeof value!=='string'||value.trim().length<5||value.trim().length>500)fail('Enter a reason between 5 and 500 characters.');return value.trim();};
const idFor=({signature,mint,wallet})=>createHash('sha256').update(JSON.stringify([signature,mint,wallet])).digest('hex');
const day=now=>new Date(now).toISOString().slice(0,10);
const min=(a,b)=>a<b?a:b;
const max=(a,b)=>a>b?a:b;
const routingErrors=Object.freeze({
  SOL_ROUTE_AUTH:'Jupiter could not authorize treasury routing. Check the configured Jupiter API key.',
  SOL_ROUTE_RATE_LIMITED:'Jupiter is rate limiting treasury routing. The saved allocation will retry automatically.',
  SOL_ROUTE_NOT_FOUND:'Jupiter has no route for this treasury swap amount right now. The saved allocation will retry automatically.',
  SOL_ROUTE_NETWORK:'The treasury could not reach Jupiter. The saved allocation will retry automatically.',
  SOL_ROUTE_TIMEOUT:'The treasury routing request timed out. The saved allocation will retry automatically.',
  SOL_ROUTE_PROVIDER_UNAVAILABLE:'Jupiter is temporarily unavailable for treasury routing. The saved allocation will retry automatically.',
  SOL_ROUTE_INVALID_RESPONSE:'Jupiter returned an unreadable treasury route. The saved allocation will retry automatically.',
});
const safeError=error=>error?.treasuryPublic===true?String(error.message).slice(0,220):Object.hasOwn(routingErrors,error?.code)?routingErrors[error.code]:'Treasury processing is waiting for a verified route, balance or transaction receipt. It will retry automatically.';
const retryView=record=>record?{attempts:Number.isSafeInteger(record.attempts)&&record.attempts>0?record.attempts:0,nextAttemptAt:Number.isSafeInteger(record.nextAttemptAt)&&record.nextAttemptAt>0?record.nextAttemptAt:null,reason:typeof record.error==='string'?record.error.slice(0,220):''}:null;
const publicFailure=message=>Object.assign(Error(message),{treasuryPublic:true});
const empty=()=>({version:1,enabled:false,wallet:null,operatorId:null,previousRecipients:[],assets:{},seen:{},external:{},sourceRetry:{},configurationHistory:[],history:[],withdrawals:{},withdrawal:null,pending:null,totals:{receivedSol:'0',convertedSol:'0',buybackAvailable:'0',retainedSol:'0',buybackSpent:'0',curveBought:'0',curveBurned:'0',burnAvailable:'0',networkSpent:'0',externalGasSpent:'0',withdrawnSol:'0'},carry:0,gas:{day:'',used:'0',reserved:'0'},error:'',updatedAt:null});
const add=(object,key,n)=>{object[key]=(BigInt(object[key]||'0')+n).toString();};
const sourceKey=source=>idFor({signature:source.signature,mint:source.mint,wallet:source.wallet});
const validSignature=value=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(value);
const retry=(record,now,message)=>{record.attempts=(record.attempts||0)+1;record.nextAttemptAt=now+Math.min(3600000,15000*2**Math.min(record.attempts-1,8));record.error=message;};
const opView=op=>op?Object.fromEntries(['kind','signature','state','createdAt','confirmedAt','inputAmount','outputAmount','recipient','error'].filter(k=>op[k]!==undefined).map(k=>[k,op[k]])):null;
const signerOrigin=state=>!state.wallet?'unconfigured':state.wallet.origin==='owner-provided'?'owner-provided':'server-generated';
const pristineForSigner=state=>!state.wallet&&!state.enabled&&!state.operatorId&&!state.activation&&!state.pending&&!state.withdrawal&&!state.carry&&!state.previousRecipients.length&&!state.history.length&&Object.values(state.totals).every(value=>uint(value)===0n)&&uint(state.gas.used)===0n&&uint(state.gas.reserved)===0n&&['assets','seen','external','sourceRetry','withdrawals'].every(key=>Object.keys(state[key]||{}).length===0)&&(state.configurationHistory||[]).every(row=>row.enabled===false&&!row.action);
/** Ledger helpers shared with product modes: exact arithmetic, retry backoff and public errors. */
export const treasuryInternals=Object.freeze({uint,add,retry,safeError,publicFailure,min,max,day});
function importedSigner(secretKey){
  let bytes;
  try{
    if(typeof secretKey==='string'){
      const text=secretKey.trim();if(!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(text))throw Error();bytes=bs58.decode(text);
    }else if(secretKey instanceof Uint8Array)bytes=new Uint8Array(secretKey);
    else throw Error();
    if(bytes.length!==64)throw Error();
    const key=Keypair.fromSecretKey(bytes);
    return {address:key.publicKey.toBase58(),secret:bs58.encode(bytes)};
  }catch{fail('Enter a valid 64-byte Solana private key for the dedicated treasury wallet.');}
  finally{bytes?.fill(0);}
}

// A recorded gross payout is only a ceiling. Finalized destination receipts
// establish spendable net revenue, including Token-2022 transfer deductions.
export function protocolTreasurySources(launches,additionalSources=[]){
  const found=new Map();
  const put=source=>{try{if(!validSignature(source.signature)||uint(source.amount)<=0n)return;source.mint=address(source.mint);source.wallet=walletAddress(source.wallet);source.sourceWallet=walletAddress(source.sourceWallet);if(source.wallet===source.sourceWallet)return;if(!Number.isInteger(source.decimals)||source.decimals<0||source.decimals>18)return;source.symbol=String(source.symbol||'').replace(/[\x00-\x1f\x7f]/g,'').slice(0,30);const key=sourceKey(source),prior=found.get(key);if(prior){if(prior.sourceWallet!==source.sourceWallet){prior.conflicting=true;return;}prior.amount=min(uint(prior.amount),uint(source.amount)).toString();}else found.set(key,source);}catch{}};
  for(const launch of launches){
    if(!isCurrentLaunch(launch?.input))continue;
    for(const op of launch.operations||[]){
      if(op?.state!=='confirmed')continue;
      if(['create','launch-all'].includes(op.kind)){
        const receipt=op.creationFeeReceipt;
        if(receipt?.mint===SOL_MINT&&receipt.decimals===9&&!receipt.selfPayment)put({signature:op.signature,mint:SOL_MINT,amount:receipt.amount,wallet:receipt.recipient,sourceWallet:(launch.keys?.payer||launch.keys?.wallet)?.address,decimals:9,symbol:'SOL',kind:'creation'});
        continue;
      }
      // Paycheck (v71.44): the Launchpad and buy-and-burn shares travel in a holder payout batch. The op records the treasury row;
      // the burn share is marked so the treasury allocates all of it to buybacks (the Launchpad share follows the treasury policy).
      if(op.kind==='payout'&&op.paycheck?.policy===PAYCHECK_POLICY&&paycheckLaunch(launch)){
        const protocolUnits=optionalUint(op.paycheck.protocolUnits),burnUnits=optionalUint(op.paycheck.burnUnits),row=(op.payouts||[]).find(entry=>entry?.owner===op.paycheck.protocolRecipient);
        if(protocolUnits===null||protocolUnits<=0n||burnUnits===null||burnUnits>protocolUnits||!row||optionalUint(row.amount)!==protocolUnits)continue;
        const signer=op.rewardsWallet?.source==='rewards'&&op.rewardsWallet.signerSource==='rewards'?op.rewardsWallet.address:launch.keys?.wallet?.address;
        const quoteDelta=delta(op.receipt?.quoteDelta);if(quoteDelta===null||quoteDelta>-protocolUnits)continue;
        put({signature:op.signature,mint:launch.input.quoteMint,amount:protocolUnits.toString(),wallet:op.paycheck.protocolRecipient,sourceWallet:signer,decimals:launch.review?.quoteDecimals,symbol:launch.review?.quoteSymbol||launch.input.quoteSymbol,kind:'paycheck-protocol',buybackUnits:burnUnits.toString()});
        continue;
      }
      if(!['protocol-payout','protocol-lp-payout','tax-protocol-payout'].includes(op.kind))continue;
      const quote=delta(op.receipt?.quoteDelta),base=delta(op.receipt?.baseDelta);
      if(quote===null||base===null||quote>0n||base>0n||op.kind!=='protocol-lp-payout'&&base!==0n)continue;
      const destination=op.kind==='protocol-lp-payout'?op.protocolRecipient:op.kind==='tax-protocol-payout'?op.taxProtocolRecipient:op.payouts?.length===1?op.payouts[0].owner:null;
      const source=op.kind==='tax-protocol-payout'?launch.keys?.wallet?.address:(op.protocolFeeWallet||protocolWalletSelection(launch)).address;
      if(quote<0n&&optionalUint(op.amount)===-quote)put({signature:op.signature,mint:launch.input.quoteMint,amount:(-quote).toString(),wallet:destination,sourceWallet:source,decimals:launch.review?.quoteDecimals,symbol:launch.review?.quoteSymbol||launch.input.quoteSymbol,kind:op.kind});
      if(op.kind==='protocol-lp-payout'&&base<0n&&optionalUint(op.baseAmount)===-base)put({signature:op.signature,mint:launch.keys?.mint?.address,amount:(-base).toString(),wallet:destination,sourceWallet:source,decimals:6,symbol:launch.input.symbol,kind:op.kind});
    }
  }
  for(const source of additionalSources)if(['creation','meteora-partner-payout','pump-classic-protocol','agent-protocol-share'].includes(source?.kind))put({...source});
  return [...found.values()].filter(row=>!row.conflicting);
}

export class ProtocolTreasury {
  // `policy` holds the network-cost limits and the buyback split; a product mode may supply its own.
  constructor({accounts,launchpad,chainFactory,meteoraSources=null,now=Date.now,intervalMs=15000,maxSourcesPerTick=8,maxAccounts=10000,maxRecords=200000,balanceTimeoutMs=8000,policy=TREASURY_POLICY}={}){Object.assign(this,{accounts,launchpad,chainFactory,meteoraSources,now,intervalMs,maxSourcesPerTick,maxAccounts,maxRecords,balanceTimeoutMs,policy});this.running=null;this.timer=null;this.closed=false;this.balanceCache=null;this.balanceRead=null;}
  async requireAdmin(id){const actor=await this.accounts.get(id);if(!actor||actor.role!=='admin'||!actor.mfaEnabled||actor.banned)fail('Administrator access with two-factor authentication is required.',403);return actor;}
  async load(){
    const state=await this.accounts.hostStore?.read(NAME,null);if(state===null||state===undefined)return empty();
    if(state.version!==1||!state.totals||!state.assets||!state.seen||!state.external||!state.withdrawals||!Array.isArray(state.previousRecipients)||!Array.isArray(state.history))fail('The encrypted treasury ledger could not be read. Restore its original data before continuing.',503);
    for(const key of Object.keys(empty().totals))uint(state.totals[key]);for(const value of Object.values(state.external))uint(value);for(const row of Object.values(state.assets)){address(row.mint);for(const key of ['received','credit','converted'])uint(row[key]);}uint(state.gas?.used);uint(state.gas?.reserved);
    if(![0,1].includes(state.carry))fail('The treasury rounding ledger is invalid.',503);
    if(state.wallet){try{const bytes=bs58.decode(state.wallet.secret);try{if(Keypair.fromSecretKey(bytes).publicKey.toBase58()!==state.wallet.address)throw Error();}finally{bytes.fill(0);}}catch{fail('The encrypted treasury signing key does not match its wallet. Restore its original data.',503);}}
    return state;
  }
  async save(state){state.updatedAt=this.now();try{await this.accounts.hostStore.write(NAME,state);}catch(error){error.treasuryStorageFailure=true;throw error;}}
  async locked(fn,{fee=false}={}){const releaseFee=fee?await acquireProcessLock(join(this.accounts.dir,'fee-recipients.lock')):null;let release;try{release=await acquireProcessLock(join(this.accounts.dir,'protocol-treasury.lock'));return await fn();}finally{await release?.();await releaseFee?.();}}
  availableRetained(state){return max(0n,uint(state.totals.retainedSol)-BigInt(this.policy.gasReserveLamports)-BigInt(this.policy.maximumOperationCostLamports)-(state.withdrawal?uint(state.withdrawal.amount):0n)-(state.pending?uint(state.pending.reservedCost):0n));}
  async view(state){const policy=await this.accounts.hostStore?.read('launch-protocol-fees',{});const known=new Map(Object.values(state.assets).map(row=>[row.mint,row]));if(state.wallet){const {launches}=await this.launchRows();for(const source of await this.sources(launches))if(source.wallet===state.wallet.address||state.previousRecipients.includes(source.wallet))if(!known.has(source.mint))known.set(source.mint,source);}return {version:1,configured:!!state.wallet,enabled:state.enabled===true,signerOrigin:signerOrigin(state),ownerControlled:signerOrigin(state)==='owner-provided',address:state.wallet?.address||'',walletBalance:this.cachedWalletBalance(state.wallet?.address||''),recordedBuybackTotals:this.recordedBuybackTotals(state),recipient:policy?.recipient||'',expectedRecipient:policy?.recipient||'',activationPending:!!state.activation,previousRecipients:[...state.previousRecipients],curveMint:LAUNCHPAD_TREASURY_MINT,curveDecimals:state.curveDecimals??null,policy:{...this.policy},totals:{...state.totals},availableRetainedSol:this.availableRetained(state).toString(),assets:Object.values(state.assets).map(({mint,decimals,symbol,received,credit,converted,error,nextAttemptAt})=>({mint,decimals,symbol,received,credit,converted,error:error||'',nextAttemptAt:nextAttemptAt||null})),recognitionAssets:[...known.values()].map(({mint,decimals,symbol})=>({mint,decimals,symbol})),pending:opView(state.pending),pendingWithdrawal:state.withdrawal?{requestId:state.withdrawal.requestId,amount:state.withdrawal.amount,recipient:state.withdrawal.recipient,createdAt:state.withdrawal.createdAt}:null,history:state.history.slice(-100).map(opView),buyRetry:retryView(state.buyRetry),burnRetry:retryView(state.burnRetry),error:state.error||'',updatedAt:state.updatedAt};}
  recordedBuybackTotals(state){
    const history=state.history.filter(row=>row?.state==='confirmed'&&['buy','burn'].includes(row.kind)).map(row=>Object.fromEntries(['kind','signature','state','inputAmount','outputAmount','confirmedAt'].map(key=>[key,row[key]])));
    return includeManualProtocolHistory({status:state.wallet?'available':'unconfigured',complete:true,curveDecimals:state.curveDecimals??null,solSpent:state.totals.buybackSpent,curveBought:state.totals.curveBought,curveBurned:state.totals.curveBurned,updatedAt:state.updatedAt,history},this.now(),history);
  }
  cachedWalletBalance(wallet){const cached=this.balanceCache;return cached?.value.address===wallet&&cached.nextReadAt>this.now()?{...cached.value}:unknownBalance(wallet);}
  async readWalletBalance(actorId,wallet){
    if(!wallet||this.closed)return unknownBalance(wallet);
    if(this.balanceCache?.value.address===wallet&&this.balanceCache.nextReadAt>this.now())return this.cachedWalletBalance(wallet);
    // All admin views share one bounded read. A timed-out RPC is not permission
    // to start overlapping requests; timeout closes its dedicated read chain.
    if(this.balanceRead)return this.balanceRead.address===wallet?this.balanceRead.response:unknownBalance(wallet);
    const read={address:wallet,chain:null,response:null,timedOut:false,chainClosed:false};this.balanceRead=read;
    read.close=async()=>{if(read.chain&&!read.chainClosed){read.chainClosed=true;await read.chain.close?.();}};
    const work=(async()=>{try{
      await this.requireAdmin(actorId);
      read.chain=await this.chainFactory({operatorId:actorId,address:wallet});
      if(this.closed||read.timedOut)throw Error();
      const snapshot=await read.chain.gasBalances([wallet]),row=snapshot?.balances?.[0];
      if(!Number.isSafeInteger(snapshot?.slot)||snapshot.slot<0||!Array.isArray(snapshot.balances)||snapshot.balances.length!==1||row?.address!==wallet||optionalUint(row?.lamports)===null)throw Error();
      return{status:'available',address:wallet,lamports:row.lamports,observedAt:this.now(),slot:snapshot.slot,commitment:'finalized'};
    }finally{await read.close();}})();
    let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{read.timedOut=true;void read.close().catch(()=>{});reject(Error());},Math.max(10,Math.min(8000,this.balanceTimeoutMs)));});
    read.response=Promise.race([work,timeout]).catch(()=>unknownBalance(wallet)).then(value=>{
      if(this.closed)return unknownBalance(wallet);
      this.balanceCache={value,nextReadAt:this.now()+BALANCE_REFRESH_MS};return{...value};
    }).finally(()=>clearTimeout(timer));
    work.then(()=>{if(this.balanceRead===read)this.balanceRead=null;},()=>{if(this.balanceRead===read)this.balanceRead=null;});
    return read.response;
  }
  async read(actorId){await this.requireAdmin(actorId);const state=await this.load(),result=await this.view(state);result.walletBalance=await this.readWalletBalance(actorId,state.wallet?.address||'');await this.requireAdmin(actorId);return result;}
  async sources(launches){
    const extra=typeof this.meteoraSources==='function'?await this.meteoraSources():[];if(!Array.isArray(extra)||extra.length>this.maxRecords)throw publicFailure('Meteora treasury history exceeds its scan limit.');
    // Pump.fun Classic platform-share sweeps and AI Agent platform-share remittances
    // are signed transfers from per-coin Launchpad wallets; each is verified like any source.
    const more=[];for(const read of [this.pumpClassicSources,this.agentShareSources])if(typeof read==='function'){const rows=await read();if(!Array.isArray(rows)||rows.length>this.maxRecords)throw publicFailure('Platform-share history exceeds its scan limit.');more.push(...rows);}
    return protocolTreasurySources(launches,[...extra,...more]);
  }
  async launchRows(){const accounts=await this.accounts.list();if(accounts.length>this.maxAccounts)throw publicFailure('Treasury source history exceeds its scan limit.');const launches=[];let count=0;for(const account of accounts){const book=this.launchpad?.book?await this.launchpad.book(account.id):await this.accounts.storeFor(account.id).read('launchpad',{launches:[]});for(const launch of book?.launches||[]){count+=1+(launch.operations?.length||0);if(count>this.maxRecords)throw publicFailure('Treasury source history exceeds its scan limit.');launches.push(launch);}}return {accounts,launches};}
  async assertSeparate(destination){
    const rows=await this.launchRows(),{accounts,launches}=rows,toolkit=await this.accounts.hostStore.read('fee-policy',{});
    const gasFunding=await this.accounts.hostStore.read('protocol-gas-funding',null);
    if(gasFunding?.wallet?.address===destination)fail('The treasury wallet must be separate from the service gas wallet.',409);
    if(toolkit.recipient===destination||accounts.some(a=>[a.mainWallet,a.signInWallet,a.cashbackWallet].includes(destination))||launches.some(l=>l.input?.recipient===destination||Object.values(l.keys||{}).some(k=>k?.address===destination)))fail('The treasury wallet must be separate from user, creator, service and toolkit wallets.',409);
    for(const account of accounts){const settings=await this.accounts.storeFor(account.id).read('settings',{});if(Array.isArray(settings?.wallets)&&settings.wallets.some(wallet=>wallet?.publicKey===destination))fail('The treasury wallet must be separate from user, creator, service and toolkit wallets.',409);}
    return rows;
  }
  async assertUnusedDestination(state,destination,policy,launches){
    const recipients=new Set([policy.recipient,...state.previousRecipients,...(policy.history||[]).flatMap(row=>[row.from,row.to])]);
    if(recipients.has(destination)||(await this.sources(launches)).some(source=>source.wallet===destination))fail('Use a new dedicated wallet that has not received protocol revenue before. Existing revenue can be transferred and verified after activation.',409);
  }
  // This is called only by the authenticated local setup utility. Private keys
  // never enter an HTTP request or a browser form, and setup never enables work.
  async installSigner(actorId,{secretKey,expectedAddress,expectedRecipient,reason:why}={}){
    await this.requireAdmin(actorId);expectedAddress=walletAddress(expectedAddress);why=reason(why);
    if(typeof expectedRecipient!=='string')fail('Refresh the protocol recipient before setting up the treasury.');
    const imported=importedSigner(secretKey);if(imported.address!==expectedAddress)fail('The private key does not match the treasury address you confirmed.');
    return this.locked(async()=>{
      const actor=await this.requireAdmin(actorId),state=await this.load(),policy=await this.accounts.hostStore.read('launch-protocol-fees',{});
      if((policy.recipient||'')!==expectedRecipient)fail('The protocol recipient changed. Refresh before setting up the treasury.',409);
      if(state.wallet){
        if(state.wallet.address!==imported.address)fail('A treasury wallet is already configured. This setup cannot replace it or reset its ledger.',409);
        await this.requireAdmin(actorId);return this.view(state);
      }
      if(!pristineForSigner(state))fail('The treasury has existing activity or accounting. Restore and review its original ledger before setting up a wallet.',409);
      const {launches}=await this.assertSeparate(imported.address);await this.assertUnusedDestination(state,imported.address,policy,launches);
      const at=this.now();state.wallet={...imported,origin:'owner-provided',importedAt:at,importedBy:actorId};
      state.configurationHistory.push({action:'install-signer',actorId,actor:actor.username,address:imported.address,reason:why,at});state.error='';
      await this.requireAdmin(actorId);await this.save(state);return this.view(state);
    },{fee:true});
  }
  async finishActivation(state){
    if(!state.activation)return;
    const intent=state.activation;await this.requireAdmin(intent.actorId);await this.assertSeparate(state.wallet.address);
    const saved=await this.accounts.hostStore.read('launch-protocol-fees',{}),recipient=saved.recipient||'';
    if(recipient!==intent.from&&recipient!==state.wallet.address)throw publicFailure('The protocol recipient changed during activation. Review treasury settings before continuing.');
    if(recipient!==state.wallet.address){await this.requireAdmin(intent.actorId);await this.accounts.hostStore.write('launch-protocol-fees',{...saved,recipient:state.wallet.address,recipientScope:'launchpad',updatedAt:this.now(),updatedBy:intent.actor,history:[...(saved.history||[]),{at:intent.at,actorId:intent.actorId,actor:intent.actor,from:intent.from,to:state.wallet.address,reason:intent.reason,treasuryAutomation:true}]});}
    state.enabled=true;state.operatorId=intent.actorId;if(state.wallet.origin==='owner-provided'&&state.wallet.activatedAt===undefined)state.wallet.activatedAt=intent.at;state.configurationHistory.push({...intent,enabled:true});delete state.activation;state.error='';await this.save(state);
  }
  async configure(actorId,{enabled,expectedRecipient,expectedTreasuryAddress,reason:why}={}){
    await this.requireAdmin(actorId);if(typeof enabled!=='boolean'||typeof expectedRecipient!=='string')fail('Refresh treasury settings before saving.');why=reason(why);
    const result=await this.locked(async()=>{const actor=await this.requireAdmin(actorId),state=await this.load(),policy=await this.accounts.hostStore.read('launch-protocol-fees',{});if((policy.recipient||'')!==expectedRecipient)fail('The protocol recipient changed. Refresh before saving.',409);
      if(!enabled){state.enabled=false;delete state.activation;state.configurationHistory.push({actorId,actor:actor.username,enabled:false,reason:why,at:this.now()});await this.requireAdmin(actorId);await this.save(state);return this.view(state);}
      if(!state.wallet)fail('Set up your dedicated treasury wallet on the VPS before enabling automatic buybacks.',409);
      if(expectedTreasuryAddress!==state.wallet.address)fail('The treasury wallet changed or was not reviewed. Refresh and confirm its address before enabling.',409);
      const {launches}=await this.assertSeparate(state.wallet.address);if(state.wallet.origin==='owner-provided'&&state.wallet.activatedAt===undefined)await this.assertUnusedDestination(state,state.wallet.address,policy,launches);if(expectedRecipient&&expectedRecipient!==state.wallet.address&&!state.previousRecipients.includes(expectedRecipient))state.previousRecipients.push(expectedRecipient);
      state.activation={from:expectedRecipient,to:state.wallet.address,actorId,actor:actor.username,reason:why,at:this.now()};await this.requireAdmin(actorId);await this.save(state);await this.finishActivation(state);return this.view(state);
    },{fee:true});this.kick();return result;
  }
  async asset(state,source){let row=state.assets[source.mint];if(row&&(row.decimals!==source.decimals))throw publicFailure('Recorded treasury token precision does not match.');if(!row)row=state.assets[source.mint]={mint:source.mint,decimals:source.decimals,symbol:source.symbol||'',received:'0',credit:'0',converted:'0',error:'',nextAttemptAt:0};return row;}
  // Received SOL is split by the treasury policy (half to buybacks, with a one-lamport carry so the halves stay exact over time).
  // A source can mark part of itself as dedicated buyback money (the Paycheck burn share): that part goes to buybacks whole.
  allocateSol(state,amount,{converted=false,dedicatedBuyback='0'}={}){const n=uint(String(amount));
    // Without a platform token there is nothing to buy back: every lamport is retained.
    if(!LAUNCHPAD_TREASURY_MINT){add(state.totals,'receivedSol',n);if(converted)add(state.totals,'convertedSol',n);add(state.totals,'retainedSol',n);return;}
    const dedicated=min(n,uint(String(dedicatedBuyback))),rest=n-dedicated,combined=rest+BigInt(state.carry),half=combined/2n;state.carry=Number(combined%2n);add(state.totals,'receivedSol',n);if(converted)add(state.totals,'convertedSol',n);add(state.totals,'buybackAvailable',dedicated+half);add(state.totals,'retainedSol',rest-half);}
  async credit(state,source,receipt,{external=false}={}){
    const id=sourceKey(source);if(state.seen[id])return false;
    if(receipt.signature!==source.signature||receipt.mint!==source.mint||receipt.wallet!==source.wallet||receipt.sourceWallet!==source.sourceWallet||!Number.isSafeInteger(receipt.slot)||receipt.slot<0)throw publicFailure('Treasury receipt identity could not be verified.');
    const amount=uint(receipt.receivedAmount);if(amount<=0n||amount>uint(source.amount))throw publicFailure('Treasury receipt exceeds its recorded revenue.');
    const asset=await this.asset(state,source);state.seen[id]={signature:source.signature,mint:source.mint,wallet:source.wallet,amount:amount.toString(),slot:receipt.slot,at:this.now(),external};
    if(external){const key=`${source.wallet}:${source.mint}`;state.external[key]=(BigInt(state.external[key]||'0')+amount).toString();}
    else {add(asset,'received',amount);if(source.mint===SOL_MINT)this.allocateSol(state,amount,{dedicatedBuyback:source.kind==='paycheck-protocol'&&optionalUint(source.buybackUnits)!==null?source.buybackUnits:'0'});else add(asset,'credit',amount);}
    delete state.sourceRetry[id];return true;
  }
  async discover(state,chain,{onlyKnown=false}={}){const {launches}=await this.launchRows(),sources=await this.sources(launches);let checked=0;for(const source of sources){if(source.wallet!==state.wallet.address&&!state.previousRecipients.includes(source.wallet))continue;await this.asset(state,source);if(onlyKnown)continue;const id=sourceKey(source);if(state.seen[id]||(state.sourceRetry[id]?.nextAttemptAt||0)>this.now())continue;if(checked++>=this.maxSourcesPerTick)continue;try{const receipt=await chain.incomingReceipt(source,{wallet:source.wallet});if(!receipt){const row=state.sourceRetry[id]||={};retry(row,this.now(),'Waiting for a finalized protocol receipt.');continue;}await this.credit(state,source,receipt,{external:source.wallet!==state.wallet.address});}catch(error){retry(state.sourceRetry[id]||={},this.now(),safeError(error));}}
    await this.save(state);return sources;
  }
  async recognizeRevenue(actorId,{signature,mint,amount,reason:why}={}){
    await this.requireAdmin(actorId);if(!validSignature(signature))fail('Enter the transfer transaction signature.');mint=address(mint);why=reason(why);if(amount!==undefined&&uint(amount)===0n)fail('Revenue must be greater than zero.');
    const result=await this.locked(async()=>{const state=await this.load();if(!state.wallet)fail('Enable the managed treasury before recognizing transferred revenue.');await this.requireAdmin(actorId);const chain=await this.chainFactory({operatorId:actorId,address:state.wallet.address});try{await this.discover(state,chain);const id=sourceKey({signature,mint,wallet:state.wallet.address});if(state.seen[id])return this.view(state);const asset=state.assets[mint];if(!asset)fail('This asset has no recorded protocol revenue.');let match;
        for(const prior of state.previousRecipients){const key=`${prior}:${mint}`,available=BigInt(state.external[key]||'0');if(available<=0n)continue;const ceiling=amount===undefined?available:uint(amount);if(ceiling>available)continue;const source={signature,mint,wallet:state.wallet.address,sourceWallet:prior,amount:ceiling.toString(),decimals:asset.decimals,symbol:asset.symbol};try{const receipt=await chain.incomingReceipt(source,{wallet:state.wallet.address});if(receipt){match={source,receipt,key};break;}}catch{}}
        if(!match)fail('A finalized transfer from the previous protocol wallet, covered by its verified revenue history, is required. If its history is still checking, try again shortly.');await this.requireAdmin(actorId);const consumed=uint(match.receipt.sourceDebitAmount);if(consumed<uint(match.receipt.receivedAmount)||consumed>uint(match.source.amount))throw publicFailure('The transfer source amount exceeds verified prior revenue.');await this.credit(state,match.source,match.receipt);state.external[match.key]=(BigInt(state.external[match.key])-consumed).toString();state.configurationHistory.push({actorId,reason:why,signature,mint,action:'recognize-revenue',amount:match.receipt.receivedAmount,at:this.now()});await this.save(state);return this.view(state);
      }finally{await chain.close?.();}});this.kick();return result;
  }
  async withdrawRetained(actorId,{amountSol,recipient,reason:why,requestId}={}){
    await this.requireAdmin(actorId);recipient=walletAddress(recipient);why=reason(why);if(typeof requestId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(requestId)||requestId.length>80)fail('A unique withdrawal request ID is required.');const amount=units(amountSol,9,'Withdrawal amount').toString();if(uint(amount)===0n)fail('Withdrawal amount must be greater than zero.');
    const result=await this.locked(async()=>{const state=await this.load();if(!state.wallet)fail('Configure the managed treasury first.');if(recipient===state.wallet.address)fail('Choose a different receiving wallet.');const existing=state.withdrawals[requestId];if(existing){if(existing.actorId!==actorId||existing.amount!==amount||existing.recipient!==recipient)fail('This withdrawal request ID was already used.',409);return this.view(state);}if(state.withdrawal)fail('A retained-revenue withdrawal is already queued.',409);if(state.pending)fail('Wait for the saved treasury transaction to confirm before requesting a withdrawal.',409);if(uint(amount)>this.availableRetained(state))fail('The amount exceeds retained revenue available after buybacks and the gas reserve.');await this.requireAdmin(actorId);const request={requestId,actorId,amount,recipient,reason:why,createdAt:this.now(),state:'queued'};state.withdrawals[requestId]=request;state.withdrawal={...request};await this.save(state);return this.view(state);});this.kick();return result;
  }
  gasDay(state){if(state.gas.day!==day(this.now()))state.gas={day:day(this.now()),used:'0',reserved:'0'};}
  // SOL the wallet must keep for other obligations while an operation runs (the buyback allocation, less what a buy spends).
  solObligation(state,kind,amount,extra={}){void extra;return uint(state.totals.buybackAvailable)-(kind==='buy'?uint(amount):0n);}
  async prepare(state,chain,kind,mint,amount,extra={}){
    if(state.pending)throw publicFailure('A saved treasury transaction must finish before another is prepared.');
    this.gasDay(state);const cap=BigInt(this.policy.maximumOperationCostLamports);if(uint(state.gas.used)+uint(state.gas.reserved)+cap>BigInt(this.policy.dailyNetworkLimitLamports))throw publicFailure('The daily treasury network-cost limit is used. Processing resumes after midnight UTC.');
    const obligation=this.solObligation(state,kind,amount,extra),minSolReserve=(obligation+BigInt(this.policy.gasReserveLamports)).toString();
    await this.requireAdmin(extra.actorId||state.operatorId);const prepared=await chain.prepare({kind,wallet:{...state.wallet},mint,amount,minSolReserve,maxNetworkCostLamports:cap.toString(),...(extra.recipient?{recipient:extra.recipient}:{})});
    if(this.closed)return false;
    if(!prepared||prepared.kind!==kind||prepared.wallet!==state.wallet.address||prepared.mint!==mint||prepared.inputAmount!==amount||!validSignature(prepared.signature)||typeof prepared.raw!=='string'||!prepared.raw||prepared.rawHash!==createHash('sha256').update(Buffer.from(prepared.raw,'base64')).digest('hex'))throw publicFailure('The prepared treasury transaction could not be verified.');
    if(state.history.some(op=>op.signature===prepared.signature))throw publicFailure('Waiting for a fresh treasury transaction blockhash.');
    await this.requireAdmin(extra.actorId||state.operatorId);state.pending={...prepared,state:'pending',createdAt:this.now(),reservedCost:cap.toString(),reservedDay:state.gas.day,attempts:0,...(extra.requestId?{requestId:extra.requestId}:{}),...(extra.tag?{tag:extra.tag}:{})};add(state.gas,'reserved',cap);state.error='';await this.save(state);
    if(!this.closed)await this.broadcast(state,chain);return true;
  }
  async broadcast(state,chain){const op=state.pending;if(!op||this.closed)return;op.attempts=(op.attempts||0)+1;op.lastBroadcastAt=this.now();await this.save(state);try{await chain.broadcast(op);op.error='';}catch{op.error='Submission response unavailable. Launchpad is checking the saved transaction.';}await this.save(state);}
  spendCost(state,op,cost,{netConversion=false}={}){this.gasDay(state);if(op.reservedDay===state.gas.day)state.gas.reserved=max(0n,uint(state.gas.reserved)-uint(op.reservedCost)).toString();add(state.gas,'used',cost);add(state.totals,'networkSpent',cost);if(!netConversion){const retained=uint(state.totals.retainedSol),paid=min(retained,cost);add(state.totals,'retainedSol',-paid);if(cost>paid)add(state.totals,'externalGasSpent',cost-paid);}}
  // A product mode settles the operations it tagged (returns true); everything else follows the Launchpad accounting below.
  settle(){return false;}
  async finish(original,receipt){
    const state=structuredClone(original),op=state.pending;if(!op||receipt.signature!==op.signature||!['confirmed','failed','expired'].includes(receipt.state))throw publicFailure('Treasury confirmation does not match the saved transaction.');
    const input=uint(op.inputAmount),cost=receipt.state==='expired'?0n:uint(receipt.actualSolCostLamports||receipt.feeLamports||'0');
    if(receipt.state==='confirmed'){
      if(uint(receipt.inputAmount)!==input)throw publicFailure('The confirmed treasury input differs from its saved budget.');const output=uint(receipt.outputAmount||'0');
      if(this.settle(state,op,receipt,{input,output})){}
      else if(op.kind==='convert'){const asset=state.assets[op.mint];if(!asset||uint(asset.credit)<input||output===0n)throw publicFailure('The conversion receipt differs from recorded revenue.');add(asset,'credit',-input);add(asset,'converted',input);asset.error='';asset.nextAttemptAt=0;asset.attempts=0;this.allocateSol(state,output,{converted:true});}
      else if(op.kind==='buy'){if(uint(state.totals.buybackAvailable)<input||output===0n)throw publicFailure('The buyback receipt differs from its allocated budget.');add(state.totals,'buybackAvailable',-input);add(state.totals,'buybackSpent',input);add(state.totals,'curveBought',output);add(state.totals,'burnAvailable',output);state.buyRetry=null;if(Number.isInteger(receipt.outputDecimals))state.curveDecimals=receipt.outputDecimals;}
      else if(op.kind==='burn'){if(uint(state.totals.burnAvailable)<input)throw publicFailure('The burn receipt exceeds purchased Launchpad tokens.');add(state.totals,'burnAvailable',-input);add(state.totals,'curveBurned',input);state.burnRetry=null;}
      else if(op.kind==='withdraw'){if(!state.withdrawal||state.withdrawal.requestId!==op.requestId||uint(state.totals.retainedSol)<input)throw publicFailure('The withdrawal differs from its saved request.');add(state.totals,'retainedSol',-input);add(state.totals,'withdrawnSol',input);state.withdrawals[op.requestId]={...state.withdrawal,state:'confirmed',signature:op.signature};state.withdrawal=null;}
      else throw publicFailure('Unknown saved treasury operation.');
    }else{
      if(this.settle(state,op,receipt,{input,output:0n})){}
      else if(op.kind==='convert')retry(state.assets[op.mint],this.now(),'The previous conversion did not complete. A fresh route will be checked.');
      else if(op.kind==='buy')retry(state.buyRetry||={},this.now(),'The previous buyback did not complete. A fresh route will be checked.');
      else if(op.kind==='burn')retry(state.burnRetry||={},this.now(),'The previous burn did not complete. Its purchased tokens remain reserved.');
      else if(op.kind==='withdraw'){state.withdrawals[op.requestId]={...state.withdrawal,state:receipt.state,signature:op.signature};state.withdrawal=null;}
    }
    this.spendCost(state,op,cost,{netConversion:op.kind==='convert'&&receipt.state==='confirmed'});state.history.push({...opView(op),state:receipt.state,inputAmount:receipt.inputAmount||op.inputAmount,outputAmount:receipt.outputAmount||'0',confirmedAt:this.now(),...(receipt.state==='confirmed'?{}:{error:'The transaction failed or expired without completing.'})});state.history=state.history.slice(-500);state.pending=null;state.error='';await this.save(state);Object.assign(original,state);
  }
  async reconcile(state,chain){
    const op=state.pending;if(!op)return false;if((op.nextCheckAt||0)>this.now())return true;op.nextCheckAt=this.now()+10000;await this.save(state);
    try {
      const receipt=await chain.receipt(op,state.wallet.address);if(receipt){await this.finish(state,receipt);return true;}
      const status=await chain.state(op);
      if(status?.state==='expired'){
        const checkpoint=status.checkpoint,previous=op.expiryCheck;
        if(status.signature!==op.signature||!Number.isSafeInteger(checkpoint?.slot)||!Number.isSafeInteger(checkpoint?.height)||checkpoint.height<=op.lastValidBlockHeight||!Number.isSafeInteger(status.historyFromSlot)||status.historyFromSlot>op.preparedSlot){delete op.expiryCheck;op.error='Waiting for complete retained transaction history before a retry.';}
        else if(previous&&previous.signature===op.signature&&this.now()-previous.at>=10000&&checkpoint.slot>previous.slot&&checkpoint.height>previous.height){op.expiryProof={first:previous,second:{...checkpoint,at:this.now()},historyFromSlot:status.historyFromSlot};await this.finish(state,{state:'expired',signature:op.signature});return true;}
        else {op.expiryCheck={signature:op.signature,at:this.now(),...checkpoint};op.error='Checking a second finalized checkpoint before allowing a fresh transaction.';}
      }else {delete op.expiryCheck;if(state.enabled&&status?.state==='pending'&&(op.attempts||0)<4&&this.now()-(op.lastBroadcastAt||0)>=20000)await this.broadcast(state,chain);}
      return true;
    }finally{if(state.pending)await this.save(state);}
  }
  async recoverActivation(){const snapshot=await this.load();if(!snapshot.activation)return;await this.locked(async()=>{const state=await this.load();if(state.activation)await this.finishActivation(state);},{fee:true});}
  async process(){
    if(this.closed||!this.accounts.hostStore)return;
    try{await this.recoverActivation();}catch(error){if(error.treasuryStorageFailure)throw error;await this.locked(async()=>{const state=await this.load();if(state.activation){state.error='Treasury activation is waiting for an authorized administrator to review its saved settings.';await this.save(state);}});}return this.locked(async()=>{const state=await this.load();if(!state.wallet||!state.enabled&&!state.pending&&!state.withdrawal)return;let chain;try{chain=await this.chainFactory({operatorId:state.withdrawal?.actorId||state.operatorId,address:state.wallet.address});if(await this.reconcile(state,chain))return;
      if(state.activation||!state.enabled&&!state.withdrawal)return;
      if(state.withdrawal){const request=state.withdrawal;await this.requireAdmin(request.actorId);await this.prepare(state,chain,'withdraw',SOL_MINT,request.amount,{recipient:request.recipient,requestId:request.requestId,actorId:request.actorId});return;}
      await this.requireAdmin(state.operatorId);const policy=await this.accounts.hostStore.read('launch-protocol-fees',{});if(policy.recipient!==state.wallet.address)throw publicFailure('The protocol recipient no longer matches the treasury. Review settings before continuing.');
      await this.discover(state,chain);
      await this.work(state,chain);
    }catch(error){if(error.treasuryStorageFailure)throw error;state.error=safeError(error);await this.save(state);}finally{await chain?.close?.();}});
  }
  // One tick of policy work after revenue discovery: burn bought Launchpad, buy with the allocation, convert other revenue to SOL.
  // At most one transaction is prepared per tick. A product mode replaces this with its own sequence.
  async work(state,chain){
    if(LAUNCHPAD_TREASURY_MINT&&uint(state.totals.burnAvailable)>0n&&(state.burnRetry?.nextAttemptAt||0)<=this.now()){try{await this.prepare(state,chain,'burn',LAUNCHPAD_TREASURY_MINT,state.totals.burnAvailable);return;}catch(error){if(error.treasuryStorageFailure)throw error;if(state.pending){state.error=safeError(error);await this.save(state);return;}retry(state.burnRetry||={},this.now(),safeError(error));state.error=safeError(error);await this.save(state);}}
    if(LAUNCHPAD_TREASURY_MINT&&uint(state.totals.buybackAvailable)>=BigInt(this.policy.minimumBuyLamports)&&(state.buyRetry?.nextAttemptAt||0)<=this.now()){try{await this.prepare(state,chain,'buy',LAUNCHPAD_TREASURY_MINT,state.totals.buybackAvailable);return;}catch(error){if(error.treasuryStorageFailure)throw error;if(state.pending){state.error=safeError(error);await this.save(state);return;}retry(state.buyRetry||={},this.now(),safeError(error));state.error=safeError(error);await this.save(state);}}
    await this.convertAssets(state,chain);
  }
  // Convert every credited non-SOL asset (one per tick) to SOL; `skip` leaves out mints a product mode keeps.
  async convertAssets(state,chain,skip=new Set()){
    for(const asset of Object.values(state.assets).sort((a,b)=>(a.lastAttemptAt||0)-(b.lastAttemptAt||0)||a.mint.localeCompare(b.mint))){if(asset.mint===SOL_MINT||skip.has(asset.mint)||uint(asset.credit)===0n||(asset.nextAttemptAt||0)>this.now())continue;try{asset.lastAttemptAt=this.now();await this.prepare(state,chain,'convert',asset.mint,asset.credit);return true;}catch(error){if(error.treasuryStorageFailure)throw error;if(state.pending){state.error=safeError(error);await this.save(state);return true;}retry(asset,this.now(),safeError(error));await this.save(state);}}
    return false;
  }
  kick(){if(this.closed||this.running||!this.accounts.hostStore)return this.running;this.running=this.process().catch(()=>{}).finally(()=>{this.running=null;});return this.running;}
  start(){if(this.timer||this.closed||!this.accounts.hostStore)return;this.timer=setInterval(()=>this.kick(),this.intervalMs);this.timer.unref?.();this.kick();}
  async close(){this.closed=true;clearInterval(this.timer);this.timer=null;await this.running;}
}
