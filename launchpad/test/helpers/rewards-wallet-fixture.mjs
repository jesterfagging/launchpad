import {PublicKey} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {newLaunchKeys} from '../../src/launchpad-receipts.mjs';

// Policy/recovery fixtures begin after the separately tested migration. Every
// earned credit in these fixtures belongs to the dedicated execution wallet.
export function activeRewardsFixture(launch,now){
  launch.review.quoteProgram=TOKEN_PROGRAM_ID.toBase58();
  if(launch.input.feeMode==='holders'){
    launch.keys.rewards=newLaunchKeys().wallet;
    launch.rewardsWallet={version:1,status:'active',address:launch.keys.rewards.address,createdAt:now,activatedAt:now,gasInitializedAt:now,creatorCredits:{base:'0',quote:'0',protocolQuote:'0',taxBase:'0'}};
  }
  return launch;
}

export function rewardFixtureReceipt(launch,{quote=0n,base=0n,err=null,operation=launch.operations.find(op=>op.state==='pending')}={}){
  const role=operation?.rewardsWallet??{source:'wallet',signerSource:'wallet'},owner=launch.keys[role.source].address,payer=launch.keys[role.signerSource].address;
  const keys=[payer,...(owner===payer?[]:[owner])],row=(mint,amount,index)=>({accountIndex:index,owner,mint,uiTokenAmount:{amount:String(amount)}}),balance=10000000000000n;
  return {slot:100,transaction:{message:{accountKeys:keys.map(key=>new PublicKey(key))}},meta:{err,fee:5000,preBalances:keys.map(()=>100000000),postBalances:keys.map((_,index)=>index===0?99995000:100000000),preTokenBalances:[row(launch.input.quoteMint,balance,keys.length),row(launch.keys.mint.address,balance,keys.length+1)],postTokenBalances:[row(launch.input.quoteMint,balance+BigInt(quote),keys.length),row(launch.keys.mint.address,balance+BigInt(base),keys.length+1)]}};
}

// A handoff is a real signed journal operation with both exact source debits
// and destination credits, not a shortcut that edits ownership in the fixture.
export function rewardFixtureHandoffReceipt(launch,operation,{baseCredit,quoteCredit,gasLamports,err=null}={}){
  const plan=operation.rewardHandoff,source=plan.sourceAddress,destination=plan.destinationAddress,baseProgram=launch.input.taxBps?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,quoteProgram=new PublicKey(launch.review.quoteProgram);
  const ata=(mint,owner,program)=>getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(owner),false,program).toBase58();
  const keys=[source,destination,ata(launch.keys.mint.address,source,baseProgram),ata(launch.keys.mint.address,destination,baseProgram),ata(launch.input.quoteMint,source,quoteProgram),ata(launch.input.quoteMint,destination,quoteProgram)];
  const balance=10000000000000n,row=(index,owner,mint,amount)=>({accountIndex:index,owner,mint,uiTokenAmount:{amount:String(amount)}}),base=BigInt(plan.baseUnits),quote=BigInt(plan.quoteUnits),gas=Number(gasLamports??plan.gasLamports);
  const preTokenBalances=[row(2,source,launch.keys.mint.address,balance),row(3,destination,launch.keys.mint.address,0n),row(4,source,launch.input.quoteMint,balance),row(5,destination,launch.input.quoteMint,0n)];
  const postTokenBalances=[row(2,source,launch.keys.mint.address,balance-base),row(3,destination,launch.keys.mint.address,baseCredit??base),row(4,source,launch.input.quoteMint,balance-quote),row(5,destination,launch.input.quoteMint,quoteCredit??quote)];
  return {slot:101,transaction:{message:{accountKeys:keys.map(key=>new PublicKey(key))}},meta:{err,fee:5000,preBalances:[100000000,100000000,1,1,1,1],postBalances:[99995000-gas,100000000+gas,1,1,1,1],preTokenBalances,postTokenBalances}};
}

export const rewardHandoffTx=rewardFixtureHandoffReceipt;
