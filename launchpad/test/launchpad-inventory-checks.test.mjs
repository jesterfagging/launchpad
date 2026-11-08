import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {AccountLayout,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync,decodeTransferCheckedInstruction} from '@solana/spl-token';
import {LaunchChain,newLaunchKeys} from '../src/launchpad-chain.mjs';
import {provisionRewardsWallet,rewardHandoffPlan,TAX_BURN_MINT,TAX_BURN_WALLET} from '../src/launchpad-rewards-wallet.mjs';
import {recordTaxHarvest,recordTaxConversion,TAX_PROTOCOL_POLICY} from '../src/launchpad-tax-protocol.mjs';
const pk=value=>new PublicKey(value),address=()=>newLaunchKeys().wallet.address;
const HANDOFF_ERROR='The creator rewards token account cannot cover its saved credits.';
function account(mint,owner,amount,{program=TOKEN_PROGRAM_ID,state=1}={}){
 const data=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint:pk(mint),owner:pk(owner),amount:BigInt(amount),delegateOption:0,delegate:PublicKey.default,state,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
 return {owner:program,data,lamports:2039280,executable:false};
}
function fixture({quoteDecimals=8}={}){
 const l={id:'a'.repeat(32),feeCustody:'relay',keys:{...newLaunchKeys(),payer:newLaunchKeys().wallet},input:{route:'raydium',network:'mainnet-beta',quoteMint:address(),feeMode:'holders',taxBps:100},review:{quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals},credits:{base:'20',quote:'30'},operations:[{kind:'tax',state:'confirmed',slot:100},{kind:'claim',state:'confirmed',slot:120},{kind:'payout',state:'pending-unrelated',slot:9999}]};
 l.taxProtocol=recordTaxHarvest(l,10n);l.taxProtocol=recordTaxConversion(l,{amount:'10',taxSource:'withheld-tax',taxProtocolPolicy:TAX_PROTOCOL_POLICY},10n,100n).ledger;
 provisionRewardsWallet(l,1);const source=pk(l.keys.wallet.address),base=getAssociatedTokenAddressSync(pk(l.keys.mint.address),source,false,TOKEN_2022_PROGRAM_ID),quote=getAssociatedTokenAddressSync(pk(l.input.quoteMint),source);
 const accounts=new Map([[String(base),account(l.keys.mint.address,source,20,{program:TOKEN_2022_PROGRAM_ID})],[String(quote),account(l.input.quoteMint,source,35)]]);let slot=120;const calls=[];
 const c=new LaunchChain({network:'mainnet-beta',connection:{getAccountInfoAndContext:async(key,options)=>{calls.push({address:String(key),options});return {context:{slot},value:accounts.get(String(key))??null};}}});
 c.mintInfo=async mint=>({key:pk(mint),program:String(mint)===l.keys.mint.address?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,mint:{decimals:String(mint)===l.keys.mint.address?6:quoteDecimals}});
 return {l,c,source,base,quote,accounts,calls,setSlot(value){slot=value;}};
}
test('handoff inventory uses latest confirmed receipt fence and rejects ignored stale context before checking old balances',async()=>{
 const h=fixture();h.setSlot(119);h.accounts.set(String(h.base),account(h.l.keys.mint.address,h.source,0,{program:TOKEN_2022_PROGRAM_ID}));const before=structuredClone(h.l);
 await assert.rejects(h.c.rewardHandoffInstructions(h.l,rewardHandoffPlan(h.l)),error=>error.code==='REWARD_ACCOUNT_SCAN_RETRY'&&/fresh finalized context/.test(error.message));
 assert.deepEqual(h.calls[0].options,{commitment:'finalized',minContextSlot:120});assert.deepEqual(h.l,before);
});
test('fresh revalidation checks both base and combined holder/protocol quote credits for non-SOL quotes without changing state',async()=>{
 const h=fixture(),before=structuredClone(h.l),result=await h.c.revalidateRewardInventory(h.l,{error:HANDOFF_ERROR});assert.deepEqual(result,{slot:120});assert.deepEqual(h.l,before);assert.equal(h.calls.length,2);assert(h.calls.every(call=>call.options.minContextSlot===120));
 const instructions=await h.c.rewardHandoffInstructions(h.l,rewardHandoffPlan(h.l)),base=decodeTransferCheckedInstruction(instructions[1],TOKEN_2022_PROGRAM_ID),quote=decodeTransferCheckedInstruction(instructions[3]);assert.equal(base.data.amount,20n);assert.equal(base.data.decimals,6);assert.equal(quote.data.amount,35n);assert.equal(quote.data.decimals,8);assert.equal(instructions.rewardHandoffBalanceSlot,120);
});
test('fresh missing, wrong-program, wrong-owner, wrong-mint, frozen, uninitialized and genuinely insufficient source accounts remain hard stops',async()=>{
 for(const kind of ['missing','program','owner','mint','frozen','uninitialized','short-base','short-quote']){
  const h=fixture();if(kind==='missing')h.accounts.delete(String(h.base));else if(kind==='short-quote')h.accounts.set(String(h.quote),account(h.l.input.quoteMint,h.source,34));else h.accounts.set(String(h.base),account(kind==='mint'?address():h.l.keys.mint.address,kind==='owner'?address():h.source,kind==='short-base'?19:20,{program:kind==='program'?TOKEN_PROGRAM_ID:TOKEN_2022_PROGRAM_ID,state:kind==='frozen'?2:kind==='uninitialized'?0:1}));const before=structuredClone(h.l);
  await assert.rejects(h.c.revalidateRewardInventory(h.l,{error:HANDOFF_ERROR}),error=>error.code!=='REWARD_ACCOUNT_SCAN_RETRY');assert.deepEqual(h.l,before,kind);
 }
});
test('read-only recovery refuses unknown errors, unsettled operations and invalid custody or mint metadata',async()=>{
 for(const kind of ['unknown','pending','external','exported','decimals','quote-program']){
  const h=fixture();if(kind==='pending')h.l.operations.push({state:'pending',kind:'claim'});if(kind==='external')h.l.keys.wallet.external=true;if(kind==='exported')h.l.keys.rewards.exported=true;
  if(kind==='decimals'||kind==='quote-program')h.c.mintInfo=async mint=>({key:pk(mint),program:kind==='quote-program'?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,mint:{decimals:kind==='decimals'?5:6}});
  await assert.rejects(h.c.revalidateRewardInventory(h.l,{error:kind==='unknown'?HANDOFF_ERROR+' retry':HANDOFF_ERROR}));
 }
});
test('the same finalized inventory guard protects official burn ATA without accepting stale or frozen balances',async()=>{
 const h=fixture(),mint=pk(TAX_BURN_MINT),owner=pk(TAX_BURN_WALLET),ata=getAssociatedTokenAddressSync(mint,owner,false,TOKEN_2022_PROGRAM_ID),options={program:TOKEN_2022_PROGRAM_ID,mint,owner,amount:10n,missing:'Missing burn account.',error:'LAUNCHPAD tax burn exceeds its verified rewards-wallet inventory.'};
 h.accounts.set(String(ata),account(mint,owner,10,{program:TOKEN_2022_PROGRAM_ID}));assert.deepEqual(await h.c.rewardInventoryAccount(h.l,ata,options),{slot:120});
 h.setSlot(119);await assert.rejects(h.c.rewardInventoryAccount(h.l,ata,options),e=>e.code==='REWARD_ACCOUNT_SCAN_RETRY');h.setSlot(120);
 for(const change of [{amount:9,state:1},{amount:10,state:2}]){h.accounts.set(String(ata),account(mint,owner,change.amount,{program:TOKEN_2022_PROGRAM_ID,state:change.state}));await assert.rejects(h.c.rewardInventoryAccount(h.l,ata,options),e=>e.message===options.error&&e.code!=='REWARD_ACCOUNT_SCAN_RETRY');}
});
