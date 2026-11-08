import {Keypair,PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {SOL_MINT,requireValue as ok} from '../public/launchpad-model.mjs';
import {taxProtocolLedger,recordTaxHandoffLoss} from './launchpad-tax-protocol.mjs';
import { PLATFORM_TOKEN_MINT, PLATFORM_TOKEN_BURN_WALLET } from './platform-token.mjs';

export const REWARDS_WALLET_VERSION=1;
// The platform token (LAUNCHPAD_TOKEN_MINT) and its launch's dedicated rewards wallet (LAUNCHPAD_TOKEN_BURN_WALLET);
// '' without them, which keeps the tax-burn features off.
export const TAX_BURN_MINT=PLATFORM_TOKEN_MINT;
export const TAX_BURN_WALLET=PLATFORM_TOKEN_BURN_WALLET;
export const TAX_BURN_POLICY='official-token-tax-burn-v1';
// The one-time burn of the inventory the token's rewards wallet held at launch (LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED), in
// base units: set it to your launch's exact inventory before enabling. The previous and legacy values below only keep
// approvals saved under earlier policies valid.
export const TAX_BURN_INITIAL_AMOUNT='50000000000000';
export const TAX_BURN_INITIAL_POLICY='official-token-initial-inventory-v3';
export const TAX_BURN_INITIAL_PREVIOUS_AMOUNT='48765432109876';
export const TAX_BURN_INITIAL_PREVIOUS_POLICY='official-token-initial-inventory-v2';
// The original approval remains valid only for its exact saved amount. Never
// rewrite a signed journal or reinterpret a completed v1 burn as a new approval.
export const TAX_BURN_INITIAL_LEGACY_AMOUNT='41234567890123';
export const TAX_BURN_INITIAL_LEGACY_POLICY='official-token-initial-inventory-v1';
export const validInitialTaxBurnApproval=(policy,amount)=>
  policy===TAX_BURN_INITIAL_POLICY&&amount===TAX_BURN_INITIAL_AMOUNT||
  policy===TAX_BURN_INITIAL_PREVIOUS_POLICY&&amount===TAX_BURN_INITIAL_PREVIOUS_AMOUNT||
  policy===TAX_BURN_INITIAL_LEGACY_POLICY&&amount===TAX_BURN_INITIAL_LEGACY_AMOUNT;
// 'gas-sell' (v71.37): the payout gas sale, signed by the dedicated rewards wallet like a payout.
const walletKinds=new Set(['tax','sell','payout','tax-protocol-payout','tax-burn','gas-sell']);
const publicKey=address=>{try{const key=new PublicKey(address);return key.toBase58()===address&&PublicKey.isOnCurve(key.toBytes());}catch{return false;}};
const matchingSecret=key=>{let bytes;try{bytes=bs58.decode(key.secret);return bytes.length===64&&Keypair.fromSecretKey(bytes).publicKey.toBase58()===key.address;}catch{return false;}finally{bytes?.fill(0);}};
const validKey=(key,{requireSecret=true}={})=>!!(key?.address&&publicKey(key.address)&&(!requireSecret||matchingSecret(key))&&!key.external&&!key.exported&&!key.exportedAt&&!key.compromised&&!key.compromisedAt);
const amount=value=>{ok(typeof value==='string'&&/^\d+$/.test(value),'Invalid reward wallet credit ledger.');return BigInt(value);};
export function dedicatedRewardsWallet(l,{requireSecret=true}={}){
  const key=l.keys?.rewards;
  return !!(validKey(key,{requireSecret})&&!l.rewardsWalletExported&&!l.rewardsWalletExportedAt&&!l.rewardsWalletCompromisedAt&&!['wallet','payer','platform','protocol','mint'].some(role=>l.keys?.[role]?.address===key.address));
}
export function rewardsReceiptWallet(l){
  const address=l.keys?.rewards?.address||l.rewardsWallet?.address;
  return !!(publicKey(address)&&(!l.rewardsWallet||l.rewardsWallet.address===address)&&!['wallet','payer','platform','protocol','mint'].some(role=>l.keys?.[role]?.address===address));
}
// A tax burn is a distinct operation, pinned to the official mint and its
// existing execution wallet. Receipt recovery never depends on a feature flag
// or a still-present secret; new signing still requires exclusive custody.
export function requireTaxBurnWallet(l,{receipt=false}={}){
  ok(l.input?.network==='mainnet-beta'&&l.input.route==='raydium'&&l.input.feeMode==='holders'&&l.input.quoteMint===SOL_MINT&&Number.isInteger(l.input.taxBps)&&l.input.taxBps>0&&l.keys?.mint?.address===TAX_BURN_MINT,'Tax burns are restricted to the official LAUNCHPAD holder-rewards launch.');
  ok((l.keys?.rewards?.address||l.rewardsWallet?.address)===TAX_BURN_WALLET&&l.rewardsWallet?.address===TAX_BURN_WALLET&&(receipt?rewardsReceiptWallet(l):l.rewardsWallet.status==='active'&&dedicatedRewardsWallet(l)),'The official LAUNCHPAD rewards wallet is unavailable for tax burning.');
  return TAX_BURN_WALLET;
}
export function rewardsWalletSelection(l,{operation,kind,receipt=false}={}){
  const taxBurn=(operation?.kind||kind)==='tax-burn';
  if(taxBurn)requireTaxBurnWallet(l,{receipt});
  // A previously signed operation always owns its historical role. Activating
  // the new wallet must never redirect reconciliation of old creator receipts.
  if(operation!==undefined){
    const value=operation?.rewardsWallet;
    if(value===undefined){ok(!taxBurn,'A tax burn requires its saved dedicated rewards wallet.');return {version:1,source:'wallet',address:l.keys.wallet.address,signerSource:'wallet'};}
    ok(value?.version===1&&['wallet','rewards'].includes(value.source)&&['wallet','rewards'].includes(value.signerSource),'Invalid saved rewards wallet selection.');
    if(taxBurn)ok(value.source==='rewards'&&value.signerSource==='rewards'&&value.address===TAX_BURN_WALLET,'A tax burn must use the official dedicated rewards wallet.');
    ok(value.source==='rewards'?l.input.feeMode==='holders'&&walletKinds.has(operation.kind)&&value.signerSource===(operation.kind==='tax'?'wallet':'rewards'):value.signerSource==='wallet','The saved rewards wallet role does not match this operation.');
    rewardsWalletKey(l,value,{receipt});rewardsWalletKey(l,value,{signer:true,receipt});
    return {...value};
  }
  const active=l.input?.feeMode==='holders'&&l.rewardsWallet?.status==='active'&&walletKinds.has(kind);
  if(active){ok(l.rewardsWallet.version===1&&l.rewardsWallet.address===l.keys.rewards?.address&&dedicatedRewardsWallet(l),'The dedicated rewards wallet is unavailable.');return {version:1,source:'rewards',address:l.keys.rewards.address,signerSource:kind==='tax'?'wallet':'rewards'};}
  return {version:1,source:'wallet',address:l.keys.wallet.address,signerSource:'wallet'};
}
export function rewardsWalletKey(l,selection,{signer=false,receipt=false}={}){
  ok(selection?.version===1&&['wallet','rewards'].includes(selection.source)&&['wallet','rewards'].includes(selection.signerSource),'Invalid rewards wallet selection.');
  const source=signer?selection.signerSource:selection.source,key=l.keys?.[source]||(receipt&&source==='rewards'?{address:l.rewardsWallet?.address}:null);
  ok(key?.address&&(signer||key.address===selection.address),'The saved rewards wallet no longer matches its key.');
  if(source==='rewards')ok(receipt?rewardsReceiptWallet(l):dedicatedRewardsWallet(l),'The dedicated rewards wallet is unavailable.');
  return key;
}
export const rewardsWalletView=(l,selection=rewardsWalletSelection(l),options={})=>({...l,keys:{...l.keys,wallet:rewardsWalletKey(l,selection,options)}});
export function requireManagedRewardSource(l){
  const address=l.keys.wallet.address,aliases=Object.values(l.keys).filter(key=>key?.address===address),aliasedPlatform=l.keys.platform?.address===address;
  ok(l.feeCustody==='relay'&&validKey(l.keys.wallet)&&aliases.every(key=>!key.external&&!key.exported&&!key.exportedAt&&!key.compromised&&!key.compromisedAt)&&!l.feeWalletExported&&!l.walletExported&&!l.feeWalletExportedAt&&!l.walletExportedAt&&!l.walletCompromisedAt&&!l.feeWalletCompromisedAt&&!(aliasedPlatform&&(l.platformWalletExportedAt||l.platformWalletCompromisedAt)),'The original rewards custodian is unavailable or exported. Restore verified custody before moving reward funds.');
}
export function provisionRewardsWallet(l,now=Date.now()){
  ok(l.input.feeMode==='holders','Only holder rewards use a dedicated rewards wallet.');
  requireManagedRewardSource(l);
  if(!l.keys.rewards){const key=Keypair.generate();try{l.keys.rewards={address:key.publicKey.toBase58(),secret:bs58.encode(key.secretKey)};}finally{key.secretKey.fill(0);}}
  ok(dedicatedRewardsWallet(l),'The dedicated rewards wallet is unavailable.');
  if(!l.rewardsWallet){
    const tax=taxProtocolLedger(l);
    l.rewardsWallet={version:1,status:'migrating',address:l.keys.rewards.address,createdAt:now,creatorCredits:{base:l.credits.base,quote:l.credits.quote,protocolQuote:tax.creditQuote,taxBase:tax.sourceBaseCredit}};
  }
  rewardsCreatorCredits(l);
  return l.rewardsWallet;
}
export function rewardsCreatorCredits(l,{receipt=false}={}){
  const state=l.rewardsWallet;
  ok(state?.version===1&&['migrating','active'].includes(state.status)&&state.address===(l.keys.rewards?.address||state.address)&&(receipt?rewardsReceiptWallet(l):dedicatedRewardsWallet(l)),'Invalid dedicated rewards wallet state.');
  const c=state.creatorCredits;ok(c&&typeof c==='object','Missing reward wallet credit ledger.');
  const n=Object.fromEntries(['base','quote','protocolQuote','taxBase'].map(k=>[k,amount(c[k])])),tax=taxProtocolLedger(l);
  ok(n.base<=BigInt(l.credits.base)&&n.quote<=BigInt(l.credits.quote)&&n.protocolQuote<=BigInt(tax.creditQuote)&&n.taxBase<=BigInt(tax.sourceBaseCredit)&&n.taxBase<=n.base,'Reward wallet source credit exceeds its accounted balance.');
  return {...c};
}
export function rewardHandoffPlan(l,{gasLamports='0',receipt=false}={}){
  if(!receipt)requireManagedRewardSource(l);const c=rewardsCreatorCredits(l,{receipt});amount(gasLamports);
  ok(BigInt(gasLamports)<=10000000n,'Reward wallet funding exceeds its bounded initial gas reserve.');
  return {version:1,sourceAddress:l.keys.wallet.address,destinationAddress:l.keys.rewards?.address||l.rewardsWallet.address,baseUnits:c.base,quoteUnits:(BigInt(c.quote)+BigInt(c.protocolQuote)).toString(),holderQuoteUnits:c.quote,protocolQuoteUnits:c.protocolQuote,taxBaseUnits:c.taxBase,gasLamports};
}
export function recordRewardHandoff(l,op,receipt,now=Date.now()){
  const plan=op.rewardHandoff,expected=rewardHandoffPlan(l,{gasLamports:plan?.gasLamports,receipt:true});
  ok(plan?.version===1&&Object.keys(expected).every(k=>plan[k]===expected[k]),'Reward handoff differs from its saved credit allocation.');
  const baseDebit=BigInt(receipt.baseDebit),baseCredit=BigInt(receipt.baseCredit),quoteDebit=BigInt(receipt.quoteDebit),quoteCredit=BigInt(receipt.quoteCredit);
  ok(baseDebit===BigInt(plan.baseUnits)&&quoteDebit===BigInt(plan.quoteUnits)&&baseCredit>=0n&&baseCredit<=baseDebit&&quoteCredit>=0n&&quoteCredit<=quoteDebit,'Reward handoff receipt differs from its earned inventory.');
  const netTaxBase=baseDebit?baseCredit*BigInt(plan.taxBaseUnits)/baseDebit:0n,netProtocol=quoteDebit?quoteCredit*BigInt(plan.protocolQuoteUnits)/quoteDebit:0n;
  const taxLoss=BigInt(plan.taxBaseUnits)-netTaxBase,protocolLoss=BigInt(plan.protocolQuoteUnits)-netProtocol,baseLoss=baseDebit-baseCredit,quoteLoss=quoteDebit-quoteCredit;
  const tax=recordTaxHandoffLoss(l,{baseLoss:taxLoss,quoteLoss:protocolLoss});
  const credits={base:(BigInt(l.credits.base)-baseLoss).toString(),quote:(BigInt(l.credits.quote)-BigInt(plan.holderQuoteUnits)+quoteCredit-netProtocol).toString()};
  ok(BigInt(credits.base)>=0n&&BigInt(credits.quote)>=0n,'Reward handoff produced negative credits.');
  l.credits=credits;
  if(l.taxProtocol||taxLoss||protocolLoss)l.taxProtocol=tax;
  l.rewardsWallet={...l.rewardsWallet,status:'active',activatedAt:l.rewardsWallet.activatedAt||now,gasInitializedAt:l.rewardsWallet.gasInitializedAt||now,creatorCredits:{base:'0',quote:'0',protocolQuote:'0',taxBase:'0'},lastHandoff:{signature:op.signature,at:now,baseDebit:baseDebit.toString(),baseCredit:baseCredit.toString(),quoteDebit:quoteDebit.toString(),quoteCredit:quoteCredit.toString(),taxBaseLoss:taxLoss.toString(),protocolQuoteLoss:protocolLoss.toString(),gasLamports:plan.gasLamports},baseTransferLoss:(BigInt(l.rewardsWallet.baseTransferLoss||0)+baseLoss).toString(),quoteTransferLoss:(BigInt(l.rewardsWallet.quoteTransferLoss||0)+quoteLoss).toString()};
  if(l.cycle?.stage==='payout'&&!l.cycle.index){delete l.cycle.payouts;l.cycle.stage='distribute';}
  rewardsCreatorCredits(l,{receipt:true});
  return l.rewardsWallet.lastHandoff;
}
export function addCreatorRewardCredits(l,{base=0n,quote=0n,taxBase=0n}={}){
  if(!l.rewardsWallet)return;
  const c=l.rewardsWallet.creatorCredits;
  for(const [key,value]of Object.entries({base,quote,taxBase})){ok(BigInt(value)>=0n,'Creator reward credits cannot be negative.');c[key]=(amount(c[key])+BigInt(value)).toString();}
  rewardsCreatorCredits(l,{receipt:true});
}
export function publicRewardsWallet(l){
  if(l.input?.feeMode!=='holders')return null;
  return {version:1,status:l.rewardsWallet?.status||'pending',address:l.keys?.rewards?.address||null,creatorAddress:l.keys?.wallet?.address||null};
}
