import {PublicKey,SystemProgram} from '@solana/web3.js';
import {createRequire} from 'node:module';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackMint,unpackAccount,getAssociatedTokenAddressSync,getTransferFeeConfig,getTransferFeeAmount} from '@solana/spl-token';
import {displayUnits,isCurrentLaunch,requireValue as ok} from '../public/launchpad-model.mjs';
import {publicHolderRewards} from './launchpad-holder-rewards.mjs';
import {quoteLabel} from '../public/quote-identity.mjs';
import {QuoteMetadataResolver} from './launchpad-quote-metadata.mjs';
import {readMintTokenAccounts} from './launchpad-token-accounts.mjs';
import {dedicatedRewardsWallet,publicRewardsWallet} from './launchpad-rewards-wallet.mjs';
const ray=createRequire(import.meta.url)('@raydium-io/raydium-sdk-v2');

const REFRESH_MS=30000,MAX_ENTRIES=100,MAX_PENDING=10;
const unavailable='Reward balances are temporarily unavailable. Showing the last verified balances when available.';
const taxUnavailable='Unclaimed transfer fees could not be refreshed. Showing the last observed amount when available.';
const amount=value=>{ok(typeof value==='string'&&/^\d{1,40}$/.test(value),'The saved reward balance is invalid.');return BigInt(value);};
const tokenProgram=value=>{const program=new PublicKey(value);ok([TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(program)),'Unsupported reward token program.');return program;};
const rewardOwner=l=>{
  if(l.rewardsWallet?.status!=='active')return l.keys.wallet.address;
  ok(l.rewardsWallet.version===1&&l.rewardsWallet.available!==false&&l.rewardsWallet.address===l.keys?.rewards?.address&&dedicatedRewardsWallet(l,{requireSecret:false}),'The dedicated rewards wallet could not be verified.');
  return l.keys.rewards.address;
};

// The caller resolves account ownership before every read. Only public account
// data is queried here; wallet balances never become spendable reward credit.
export class LaunchRewardsView {
  constructor({chainFor,now=Date.now}={}){this.chainFor=chainFor;this.now=now;this.entries=new Map();this.closed=false;this.quoteMetadata=new QuoteMetadataResolver({now});}
  async read(accountId,l){
    ok(!this.closed,'The rewards viewer is restarting.');
    const created=l.curve||l.operations?.some(op=>['create','launch-all'].includes(op.kind)&&op.state==='confirmed'&&op.signature&&Number.isSafeInteger(op.slot)&&op.slot>0);
    ok(typeof accountId==='string'&&accountId&&isCurrentLaunch(l.input)&&l.input.feeMode==='holders'&&created&&l.authorizedAt,'Holder rewards are available for a confirmed holder-reward launch.');
    const key=JSON.stringify([accountId,l.id]),identity=JSON.stringify([l.keys.wallet.address,rewardOwner(l),l.keys.mint.address,l.input.quoteMint,l.review.quoteProgram,l.review.quoteDecimals,!!l.input.taxBps]);
    let entry=this.entries.get(key);
    if(entry&&entry.identity!==identity){this.entries.delete(key);entry=null;}
    if(!entry){
      entry={identity,next:0,value:null,pending:null,error:null};this.entries.set(key,entry);
      while(this.entries.size>MAX_ENTRIES){const victim=[...this.entries.keys()].find(k=>k!==key&&!this.entries.get(k).pending);if(!victim)break;this.entries.delete(victim);}
    }
    if(entry.pending)await entry.pending;
    else if(this.now()>=entry.next){
      if([...this.entries.values()].filter(e=>e.pending).length>=MAX_PENDING)entry.error='Reward balance checks are busy. Please try again shortly.';
      else {entry.pending=this.update(accountId,l,entry);try{await entry.pending;}finally{entry.pending=null;}}
    }
    return this.view(l,entry);
  }
  view(l,e){
    const schedule=publicHolderRewards(l),value=e.value,tax=e.taxValue,decimals=l.review.quoteDecimals;
    schedule.quoteSymbol=quoteLabel(l.input.quoteMint,value?.quoteSymbol,l.review.quoteSymbol);
    ok(Number.isInteger(decimals)&&decimals>=0&&decimals<=12,'Unsupported reward token decimals.');
    return {
      launchId:l.id,mint:l.keys.mint.address,asOf:value?.asOf??null,slot:value?.slot??null,
      stale:!!e.error||!value||this.now()-value.asOf>REFRESH_MS,error:e.error,refreshMs:REFRESH_MS,
      unclaimedCreatorQuote:value?.creatorQuote??null,unclaimedCreatorScope:'curve',unclaimedCreatorShared:l.feeCustody!=='relay',
      wallet:{address:rewardOwner(l),role:rewardOwner(l)===l.keys.wallet.address?'creator_collection':'reward_conversion',quoteBalance:value?.quoteBalance??null,quoteSymbol:schedule.quoteSymbol,unconvertedTaxTokens:value?.baseBalance??null,nativeSol:value?.nativeSol??null},
      rewardsWallet:publicRewardsWallet(l),
      creatorWallet:rewardOwner(l)!==l.keys.wallet.address?{address:l.keys.wallet.address,quoteBalance:value?.creatorQuoteBalance??null,unconvertedTaxTokens:value?.creatorBaseBalance??null,nativeSol:value?.creatorNativeSol??null}:null,
      earned:{quote:displayUnits(amount(l.credits?.quote||'0'),decimals),unconvertedTaxTokens:schedule.taxBurn?.selected?null:displayUnits(amount(l.credits?.base||'0'),6),taxBurn:schedule.taxBurn},
      totals:{distributedQuote:schedule.totalDistributedQuote||'0',payments:schedule.totalPayments||0,lastDistributionAt:schedule.lastDistributionAt||null,lastDistributionQuote:schedule.lastDistributionQuote??null},
      taxes:{withheldTokens:tax?.withheldTokens??(l.input.taxBps?null:'0'),mintWithheldTokens:value?.mintWithheldTokens??null,accountWithheldTokens:tax?.accountWithheldTokens??null,accountsScanned:tax?.accountsScanned??null,asOf:tax?.asOf??null,slot:tax?.slot??null,stale:!!l.input.taxBps&&(!!e.taxError||!!e.error||!tax||this.now()-tax.asOf>REFRESH_MS),error:e.taxError||(l.input.taxBps&&e.error?taxUnavailable:null),availableAfterGraduation:!!l.input.taxBps&&value?.taxClaimable===false,claimableNow:value?.taxClaimable??null,note:l.input.taxBps?'Observed transfer fees withheld in the mint and token accounts. '+(schedule.taxBurn?.selected?'Verified collected-tax credits and the separately approved one-time initial inventory can be burned. Other wallet balances are not automatically treated as tax. ':'Balances can change during collection; only confirmed earned credits can be distributed. ')+(value?.taxClaimable?'The original collection wallet holds withdrawal authority.':'Collection waits until the original collection wallet has withdrawal authority.'):'This coin has no token transfer fee.'},
      schedule,
    };
  }
  async update(accountId,l,e){
    let chain;
    try{
      const creator=new PublicKey(l.keys.wallet.address),w=new PublicKey(rewardOwner(l)),separate=!w.equals(creator),m=new PublicKey(l.keys.mint.address),q=new PublicKey(l.input.quoteMint),qp=tokenProgram(l.review.quoteProgram),bp=l.input.taxBps?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID;
      const quoteAta=getAssociatedTokenAddressSync(q,w,false,qp),baseAta=getAssociatedTokenAddressSync(m,w,false,bp);
      const creatorQuoteAta=getAssociatedTokenAddressSync(q,creator,false,qp),creatorBaseAta=getAssociatedTokenAddressSync(m,creator,false,bp);
      const creatorVault=ray.getPdaCreatorVault(ray.LAUNCHPAD_PROGRAM,creator,q).publicKey,creatorVaultAuthority=ray.getPdaCreatorFeeVaultAuth(ray.LAUNCHPAD_PROGRAM).publicKey;
      chain=await this.chainFor(accountId,l.input.network);
      let taxAccounts=null;e.taxError=null;
      if(l.input.taxBps){
        try{
          const scan=await readMintTokenAccounts(chain,bp,m,{minContextSlot:e.taxValue?.slot||0});
          ok(Number.isSafeInteger(scan?.context?.slot)&&scan.context.slot>0&&scan.context.slot>=(e.taxValue?.slot||0)&&Array.isArray(scan.value)&&scan.value.length<=50000,'The transfer-fee scan is incomplete or too large.');
          let withheld=0n;const seen=new Set();
          for(const row of scan.value){const address=new PublicKey(row.pubkey).toBase58();ok(!seen.has(address),'Duplicate transfer-fee account.');seen.add(address);const account=unpackAccount(new PublicKey(address),row.account,bp);ok(account.mint.equals(m),'The transfer-fee mint differs.');withheld+=getTransferFeeAmount(account)?.withheldAmount||0n;}
          taxAccounts={slot:scan.context.slot,withheld,count:scan.value.length};
        }catch{e.taxError=taxUnavailable;}
      }
      const minSlot=Math.max(e.value?.slot||0,taxAccounts?.slot||0);
      const snapshot=await chain.c.getMultipleAccountsInfoAndContext([w,q,m,quoteAta,baseAta,creatorVault,...(separate?[creator,creatorQuoteAta,creatorBaseAta]:[])],{commitment:'finalized',...(minSlot?{minContextSlot:minSlot}:{})});
      ok(Number.isSafeInteger(snapshot?.context?.slot)&&snapshot.context.slot>0&&snapshot.context.slot>=minSlot&&Array.isArray(snapshot.value)&&snapshot.value.length===(separate?9:6),'The finalized reward snapshot could not be verified.');
      const [walletAccount,quoteMintAccount,baseMintAccount,quoteAccount,baseAccount,creatorVaultAccount,creatorAccount,creatorQuoteAccount,creatorBaseAccount]=snapshot.value;
      const quoteMint=unpackMint(q,quoteMintAccount,qp),baseMint=unpackMint(m,baseMintAccount,bp);
      ok(quoteMint.isInitialized&&quoteMint.decimals===l.review.quoteDecimals&&baseMint.isInitialized&&baseMint.decimals===6,'The reward mints differ from the launch.');
      const balance=(address,account,mint,program,owner=w)=>{
        if(!account)return 0n;
        const token=unpackAccount(address,account,program);
        ok(token.isInitialized&&token.owner.equals(owner)&&token.mint.equals(mint),'The reward account differs from the launch.');
        return token.amount;
      };
      const quoteBalance=balance(quoteAta,quoteAccount,q,qp),baseBalance=balance(baseAta,baseAccount,m,bp);
      let creatorQuote=0n;
      if(creatorVaultAccount){const vault=unpackAccount(creatorVault,creatorVaultAccount,qp);ok(vault.isInitialized&&vault.owner.equals(creatorVaultAuthority)&&vault.mint.equals(q),'The curve fee vault differs from the launch.');creatorQuote=vault.amount;}
      for(const account of [walletAccount,creatorAccount])if(account)ok(account.owner.equals(SystemProgram.programId)&&!account.executable&&account.data.length===0&&Number.isSafeInteger(account.lamports)&&account.lamports>=0,'The fee wallet balance could not be verified.');
      const tax=getTransferFeeConfig(baseMint);
      ok(!l.input.taxBps||tax,'The configured transfer fee was not found.');
      const identity=await this.quoteMetadata.read(chain.c,l.input.quoteMint,{mintAccount:quoteMintAccount,fallbackSymbol:l.review.quoteSymbol});
      e.value={asOf:this.now(),slot:snapshot.context.slot,quoteSymbol:identity.symbol,quoteBalance:displayUnits(quoteBalance,l.review.quoteDecimals),creatorQuote:displayUnits(creatorQuote,l.review.quoteDecimals),baseBalance:displayUnits(baseBalance,6),nativeSol:displayUnits(BigInt(walletAccount?.lamports||0)),...(separate?{creatorQuoteBalance:displayUnits(balance(creatorQuoteAta,creatorQuoteAccount,q,qp,creator),l.review.quoteDecimals),creatorBaseBalance:displayUnits(balance(creatorBaseAta,creatorBaseAccount,m,bp,creator),6),creatorNativeSol:displayUnits(BigInt(creatorAccount?.lamports||0))}:{}),mintWithheldTokens:tax?displayUnits(tax.withheldAmount,6):'0',taxClaimable:tax?!!tax.withdrawWithheldAuthority?.equals(creator):false};
      if(taxAccounts)e.taxValue={asOf:this.now(),slot:taxAccounts.slot,withheldTokens:displayUnits(taxAccounts.withheld+tax.withheldAmount,6),accountWithheldTokens:displayUnits(taxAccounts.withheld,6),accountsScanned:taxAccounts.count};
      e.error=null;
    }catch{e.error=unavailable;}
    finally{e.next=this.now()+REFRESH_MS;chain?.close?.();}
  }
  async close(){this.closed=true;await Promise.allSettled([...this.entries.values()].map(e=>e.pending).filter(Boolean));await this.quoteMetadata.close();this.entries.clear();}
}
