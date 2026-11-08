/** Offline bridge to the unmodified production trade/ALT/atomic-graduation builders. */
import {readFileSync} from 'node:fs';
import {PublicKey, AddressLookupTableAccount} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {SwapMode} from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import {DammPumpFeeClientAdapter} from '../../../src/damm-pump-fee-chain.mjs';

const input=JSON.parse(readFileSync(0,'utf8')),pk=value=>new PublicKey(value);
const enc=ix=>({program:String(ix.programId),data:ix.data.toString('base64'),keys:ix.keys.map(k=>({key:String(k.pubkey),writable:k.isWritable,signer:k.isSigner}))});
const account=key=>{const a=input.accounts?.[String(key)];return a?{...a,owner:pk(a.owner),data:Buffer.from(a.data,'base64')}:null;};
let table;
const connection={
 getAccountInfo:async key=>account(key),
 getAccountInfoAndContext:async key=>({context:{slot:input.slot},value:account(key)}),
 getMultipleAccountsInfo:async keys=>keys.map(account),
 getMinimumBalanceForRentExemption:async()=>input.nativeRent,
 getAddressLookupTable:async()=>({context:{slot:input.slot},value:table}),
};
const adapter=new DammPumpFeeClientAdapter({connection,randomPoolIndex:()=>0,venueVerifier:async()=>({verified:true}),now:()=>input.now*1000});
const config={programId:input.programId,relayer:input.relayer};
const launch={...input,creatorWallet:input.creator,publicProgramId:input.programId,priceSnapshot:{quoteUsdMicros:input.quoteUsdMicros}};
const addresses=adapter.launchAddresses(config,launch),model=adapter.model(launch);
if(input.operation==='add-position'){
 const pos=await adapter.cp.buildCreatePositionInstruction({owner:pk(input.wallet),payer:pk(input.wallet),pool:addresses.dammPool,positionNft:pk(input.positionNft)});
 const add=await adapter.cp.buildAddLiquidityInstruction({pool:addresses.dammPool,position:pos.position,positionNftAccount:pos.positionNftAccount,owner:pk(input.wallet),tokenAAccount:pk(input.userBase),tokenBAccount:pk(input.userQuote),tokenAMint:addresses.mint,tokenBMint:addresses.quoteMint,tokenAVault:addresses.dammBaseVault,tokenBVault:addresses.dammQuoteVault,tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:addresses.quoteTokenProgram,liquidityDelta:new BN(input.liquidityDelta),tokenAAmountThreshold:new BN('18446744073709551615'),tokenBAmountThreshold:new BN('18446744073709551615')});
 process.stdout.write(JSON.stringify({instructions:[enc(pos.ix),enc(add)]}));
}else if(input.operation==='finish-plan'){
 process.stdout.write(JSON.stringify(await adapter.graduationFinishQuote(config,launch)));
}else if(input.operation==='quote'){
 const snapshot=await adapter.dammSnapshot(config,launch);
 const q=adapter.cp.getQuote2({inputTokenMint:addresses.quoteMint,slippage:0,currentPoint:new BN(snapshot.pool.activationType===0?input.slot:input.now),poolState:snapshot.pool,tokenADecimal:6,tokenBDecimal:input.quoteDecimals,hasReferral:false,swapMode:SwapMode.PartialFill,amountIn:new BN(input.amountRaw)});
 process.stdout.write(JSON.stringify({charged:q.includedFeeInputAmount.toString(),output:q.outputAmount.toString(),nextSqrtPrice:q.nextSqrtPrice.toString()}));
}else{
 // Only RPC is substituted: raw-state validation, pool validation, the frozen
 // launch lookup table checks and all transaction construction are production.
 const quoteCompatibility=await adapter.verifyQuote(launch);
 const built=await adapter.dammTrade(config,launch,input.wallet,'buy',BigInt(input.amountRaw),100);
 const grad=await adapter.atomicGraduation(config,launch,input.wallet,built.trade);
 const lookupAddresses=await adapter.lookupAddresses(config,launch);
 table=new AddressLookupTableAccount({key:pk(input.lookupTableKey),state:{deactivationSlot:18446744073709551615n,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,authority:undefined,addresses:lookupAddresses}});
 launch.lookupTables=[{address:String(table.key),addresses:lookupAddresses.map(String)}];
 const instructions=[...built.instructions,...(grad?[grad.instruction]:[])];
 const tx=await adapter.buildTransaction(config,launch,input.wallet,instructions,grad?'buy-graduate':'buy',{blockhash:input.blockhash});
 process.stdout.write(JSON.stringify({wire:Buffer.from(tx.serialize()).toString('base64'),packetBytes:tx.serialize().length,lookupTable:launch.lookupTables[0],instructions:instructions.map(enc),trade:built.trade,quoteCompatibility,graduation:grad?{poolIndex:grad.poolIndex,review:grad.review}:null,model}));
}
