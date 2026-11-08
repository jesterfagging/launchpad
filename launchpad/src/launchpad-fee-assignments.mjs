import { PublicKey } from '@solana/web3.js';
import { creatorFeeStatus, requestFees, publicLaunch } from './launchpad.mjs';
import { creatorFeeRedirectStatus, originalFeeCreatorWallet } from './launchpad-fee-routing.mjs';
import { signer } from './launchpad-receipts.mjs';
import { displayUnits, isCurrentLaunch } from '../public/launchpad-model.mjs';
import { quoteLabel } from '../public/quote-identity.mjs';

const fail=(message,statusCode=403)=>{throw Object.assign(Error(message),{statusCode});};
const id=value=>{if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))fail('Invalid fee assignment.',400);return value;};
const address=value=>{try{const key=new PublicKey(value);return typeof value==='string'&&PublicKey.isOnCurve(key.toBytes())?key.toBase58():null;}catch{return null;}};
const text=(value,max=100)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,max):'';
const feeKinds=new Set(['claim','payout']);
const amount=value=>typeof value==='string'&&/^\d{1,20}$/.test(value)?value:'0';
const eligible=(launch,scope)=>{
  if(!isCurrentLaunch(launch.input)||!launch.authorizedAt||!launch.curve||launch.input.feeMode!=='creator'||Number(launch.input.taxBps)!==0)return false;
  const key=launch.keys?.wallet;
  return !!(launch.feeCustody==='relay'&&key?.secret&&!key.external&&!key.exportedAt&&!key.compromised&&!key.compromisedAt&&!launch.feeWalletExportedAt&&!launch.walletExportedAt&&!launch.walletCompromisedAt&&key.address!==launch.keys.payer?.address&&!scope.shared&&!scope.personal);
};

// A fee beneficiary receives a private, bounded claim capability only. Launch
// records, public creator attribution and every management API remain owned by
// the original account. No external wallet or server secret is returned here.
export class LaunchFeeAssignments {
  constructor({accounts,launchpad,now=Date.now,maxAccounts=10000,maxLaunches=100000}={}){Object.assign(this,{accounts,launchpad,now,maxAccounts,maxLaunches});}
  async identity(actorId,context,{optional=false,creator=false}={}){
    const signIn=creator?'Sign in with the original creator wallet to redirect fees.':'Sign in with the receiving wallet to claim assigned fees.';
    if(typeof context?.authorize!=='function')fail(signIn);
    const session=await context.authorize();
    if(!session||session.account?.id!==actorId)fail('Sign in again before checking assigned fees.',401);
    if(session.authMethod!=='wallet'||session.walletVerified!==true||!address(session.walletAddress)){if(optional)return null;fail(signIn);}
    const account=await this.accounts.get(actorId),bound=account?.authType==='wallet'?account.mainWallet:account?.signInWallet;
    if(!account||account.banned||bound!==session.walletAddress)fail('The receiving wallet session changed. Sign in again.',401);
    return {wallet:session.walletAddress,account};
  }
  async inventory(override){
    const accounts=await this.accounts.list();if(accounts.length>this.maxAccounts)fail('Assigned fee history is temporarily unavailable.',503);
    const rows=[],uses=new Map(),personal=new Set(accounts.flatMap(account=>[account.mainWallet,account.signInWallet].filter(Boolean)));
    for(let i=0;i<accounts.length;i+=8){const batch=accounts.slice(i,i+8),books=await Promise.all(batch.map(account=>override?.accountId===account.id?override.book:this.launchpad.book(account.id)));
      books.forEach((book,index)=>{for(const launch of book.launches||[]){rows.push({account:batch[index],launch});if(rows.length>this.maxLaunches)fail('Assigned fee history is temporarily unavailable.',503);for(const wallet of new Set(Object.values(launch.keys||{}).map(key=>key?.address).filter(Boolean)))uses.set(wallet,(uses.get(wallet)||0)+1);}});
    }
    return {rows,scope:launch=>({shared:(uses.get(launch.keys?.wallet?.address)||0)>1,personal:personal.has(launch.keys?.wallet?.address)})};
  }
  row(account,launch,scope){
    const status=creatorFeeStatus(launch),allowed=eligible(launch,scope),decimals=Number.isInteger(launch.review?.quoteDecimals)&&launch.review.quoteDecimals>=0&&launch.review.quoteDecimals<=18?launch.review.quoteDecimals:0,raw=amount(launch.credits?.quote),image=launch.input.imageId;
    const claim=allowed?{available:status.available,busy:status.busy,status:status.status,reason:status.reason}:{available:false,busy:false,status:'unavailable',reason:'This fee assignment is not available for a recipient claim.'};
    return {ownerAccountId:account.id,id:launch.id,mint:launch.keys.mint.address,name:text(launch.input.name),symbol:text(launch.input.symbol,24),image:typeof image==='string'&&/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(image)?'/token-images/'+image:null,quote:{mint:launch.input.quoteMint,symbol:quoteLabel(launch.input.quoteMint,launch.review?.quoteSymbol,launch.input.quoteSymbol),decimals},recipient:launch.input.recipient,creator:typeof account.username==='string'&&/^[a-z0-9_][a-z0-9_-]{2,31}$/.test(account.username)?{username:account.username}:null,claim,collectedAmount:raw,collectedDisplay:displayUnits(raw,decimals),lastCycle:Number.isSafeInteger(launch.lastCycle)?launch.lastCycle:0,lastClaimAt:Number.isSafeInteger(launch.lastFeeClaim?.at)?launch.lastFeeClaim.at:null,lastClaimResult:['claimed','empty'].includes(launch.lastFeeClaim?.result)?launch.lastFeeClaim.result:null,operations:(launch.operations||[]).filter(op=>feeKinds.has(op.kind)).slice(-10).map(op=>({kind:op.kind,state:['pending','confirmed','failed','expired','awaiting_signature'].includes(op.state)?op.state:'pending',signature:typeof op.signature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(op.signature)?op.signature:null,createdAt:Number.isSafeInteger(op.createdAt)?op.createdAt:null,confirmedAt:Number.isSafeInteger(op.confirmedAt)?op.confirmedAt:null}))};
  }
  async list(actorId,context){
    const identity=await this.identity(actorId,context,{optional:true});if(!identity)return {wallet:null,assignments:[],requiresWalletSignIn:true,refreshMs:5000};
    const {rows,scope}=await this.inventory(),assignments=[];
    for(const {account,launch} of rows){if(account.id===actorId||launch.input?.recipient!==identity.wallet||launch.input?.feeMode!=='creator'||Number(launch.input?.taxBps)!==0||!launch.curve||!launch.authorizedAt)continue;assignments.push(this.row(account,launch,scope(launch)));}
    const current=await this.identity(actorId,context);if(current.wallet!==identity.wallet)fail('The receiving wallet session changed. Sign in again.',401);
    return {wallet:identity.wallet,assignments,requiresWalletSignIn:false,refreshMs:5000};
  }
  async redirect(actorId,{id:launchId,recipient,expectedRecipient,requestId}={},context){
    id(actorId);id(launchId);
    if(typeof requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId))fail('A unique redirect request ID is required.',400);
    const destination=address(typeof recipient==='string'?recipient.trim():recipient);
    if(!destination)fail('Enter a valid Solana wallet address for the recipient.',400);
    if(typeof expectedRecipient!=='string')fail('Refresh the launch before redirecting its fees.',400);
    const initial=await this.identity(actorId,context,{creator:true});
    return this.launchpad.locked(actorId,async book=>{
      const identity=await this.identity(actorId,context,{creator:true}),launch=book.launches?.find(row=>row.id===launchId);
      if(identity.wallet!==initial.wallet)fail('The creator wallet session changed. Sign in again.',401);
      if(!launch||originalFeeCreatorWallet(launch)!==identity.wallet)fail('Only the original creator wallet can redirect this coin’s fees.');
      const prior=launch.feeRecipientRedirect;
      if(prior?.requestId===requestId){
        if(prior.actorId!==actorId||prior.originalWallet!==identity.wallet||prior.to!==destination||launch.input.recipient!==destination)fail('This redirect request was already used.',409);
        return {launch:publicLaunch(launch),alreadyRedirected:true};
      }
      const {scope}=await this.inventory({accountId:actorId,book}),status=creatorFeeRedirectStatus(launch,scope(launch));
      if(!status.allowed)fail(status.reason,409);
      if(launch.input.recipient!==expectedRecipient)fail('The fee recipient changed. Refresh before trying again.',409);
      if(destination===expectedRecipient)fail('This wallet already receives the creator fees.',400);
      if(Object.values(launch.keys||{}).some(key=>key?.address===destination))fail('Choose a recipient outside this coin’s launch wallets.',400);
      let key;try{key=signer(launch.keys.wallet.secret);if(key.publicKey.toBase58()!==launch.keys.wallet.address)throw Error();}catch{fail('The stored fee signer is unavailable. Restore the launch data before redirecting fees.',409);}finally{key?.secretKey.fill(0);}
      const current=await this.identity(actorId,context,{creator:true});
      if(current.wallet!==initial.wallet||originalFeeCreatorWallet(launch)!==current.wallet)fail('The creator wallet session changed. Sign in again.',401);
      const audit={at:this.now(),actorId,actor:current.account.username,from:launch.input.recipient,to:destination,fromMode:'creator',toMode:'creator',reason:'One-time redirect authorized by the original creator wallet.'};
      launch.feeRecipientRedirect={version:1,requestId,actorId,originalWallet:current.wallet,from:audit.from,to:destination,at:audit.at};
      launch.feeRecipientRedirectedAt=audit.at;
      launch.feeRecipientHistory=[...(launch.feeRecipientHistory||[]),audit];
      launch.input.recipient=destination;
      await this.launchpad.save(actorId,book);
      return {launch:publicLaunch(launch),alreadyRedirected:false};
    });
  }
  async claim(actorId,{ownerAccountId,id:launchId,requestId}={},context){
    id(ownerAccountId);id(launchId);if(typeof requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId))fail('A unique claim request ID is required.',400);
    const initial=await this.identity(actorId,context);
    if(!await this.accounts.get(ownerAccountId))fail('This fee assignment is no longer available.');
    const result=await this.launchpad.locked(ownerAccountId,async book=>{
      const identity=await this.identity(actorId,context);if(identity.wallet!==initial.wallet)fail('The receiving wallet session changed. Sign in again.',401);
      const account=await this.accounts.get(ownerAccountId),launch=book.launches?.find(row=>row.id===launchId);
      // The same generic denial protects other accounts' private launch IDs.
      if(!account||!launch||launch.input?.recipient!==identity.wallet)fail('This fee assignment is no longer available.');
      const {scope}=await this.inventory({accountId:ownerAccountId,book});if(!eligible(launch,scope(launch))||!creatorFeeStatus(launch).available)fail('This fee assignment is not available for a recipient claim.');
      const prior=(launch.recipientFeeClaims||[]).find(row=>row.requestId===requestId);
      if(prior&&(prior.accountId!==actorId||prior.wallet!==identity.wallet))fail('This claim request was already used.',409);
      const alreadyRequested=!!prior||creatorFeeStatus(launch).busy;
      const current=await this.identity(actorId,context);if(current.wallet!==identity.wallet||launch.input.recipient!==current.wallet)fail('This fee assignment is no longer available.');
      if(!prior){requestFees(launch);launch.recipientFeeClaims=[...(launch.recipientFeeClaims||[]),{requestId,accountId:actorId,wallet:current.wallet,at:this.now()}].slice(-1000);await this.launchpad.save(ownerAccountId,book);}
      return {assignment:this.row(account,launch,scope(launch)),alreadyRequested};
    });
    this.launchpad.known.add(ownerAccountId);this.launchpad.kick(ownerAccountId);return result;
  }
}
