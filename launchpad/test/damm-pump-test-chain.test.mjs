import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { Keypair } from '@solana/web3.js';
import { SwapMode, getInitialConcentratedLiquidityPoolInformation } from '@meteora-ag/cp-amm-sdk';
import { DammPumpTestClientAdapter } from '../src/damm-pump-test-chain.mjs';
import { DammPumpClientAdapter } from '../src/damm-pump-chain.mjs';
import { verifyDammPumpTestDeployment } from '../src/damm-pump-test-deployment-service.mjs';

const bn = x => new BN(String(x));
function fixture(decimals = 9, usdMicros = '100000000', progress = 0n) {
  const adapter = new DammPumpTestClientAdapter({connection:{}});
  const launch = {quoteDecimals:decimals,priceSnapshot:{quoteUsdMicros:usdMicros}};
  const model = adapter.model(launch), min = BigInt(model.sqrtMinPrice), max = BigInt(model.sqrtMaxPrice);
  const current = min + (max-min)*progress/10000n;
  const initial = getInitialConcentratedLiquidityPoolInformation(bn(min),bn(max),bn(current),bn(model.liquidity));
  const fee = adapter.cp._program.coder.types.encode('podAlignedFeeTimeScheduler', {
    cliffFeeNumerator:bn(12500000),numberOfPeriod:0,periodFrequency:bn(0),
    reductionFactor:bn(0),baseFeeMode:0,padding:Array(5).fill(0),
  });
  const pool = {tokenAMint:Keypair.generate().publicKey,tokenBMint:Keypair.generate().publicKey,
    sqrtMinPrice:bn(min),sqrtMaxPrice:bn(max),sqrtPrice:bn(current),liquidity:bn(model.liquidity),
    tokenAAmount:initial.tokenAAmount,tokenBAmount:initial.tokenBAmount,collectFeeMode:1,
    poolStatus:0,activationType:0,activationPoint:bn(0),feeVersion:0,
    poolFees:{baseFee:{baseFeeInfo:{data:[...fee]}},dynamicFee:{initialized:0},
      protocolFeePercent:20,referralFeePercent:0,compoundingFeeBps:0,initSqrtPrice:bn(min)}};
  const state = {phase:0,sqrtMaxPrice:model.sqrtMaxPrice};
  const snapshot = {state,slot:100,addresses:{quoteMint:pool.tokenBMint},pool};
  adapter.rawState = async()=>snapshot;
  adapter.dammSnapshot = async(_config,_launch,commitment,slot)=>{assert.equal(commitment,'finalized');assert.equal(slot,100);return snapshot;};
  return {adapter,launch,model,pool,state};
}

test('admin adapter binds the isolated deployment and $50/$100 economics',()=>{
  const f=fixture();assert.equal(f.adapter.deploymentVerifier,verifyDammPumpTestDeployment);
  assert.equal(f.model.startUsd,'50');assert.equal(f.model.graduationUsd,'100');
  const production=new DammPumpClientAdapter({connection:{}}).model(f.launch);
  assert.equal(production.startUsd,'20000');assert.equal(production.graduationUsd,'50000');
  assert.notEqual(f.model.liquidity,production.liquidity);
});

test('remaining buy reaches endpoint using actual SDK fee and partial-fill math across quotes and progress',async()=>{
  for(const [decimals,usd] of [[9,'100000000'],[6,'1000000'],[8,'100000000000'],[6,'250125000']]){
    for(const progress of [0n,5000n,9999n]){
      const f=fixture(decimals,usd,progress),budget=await f.adapter.buyToGraduationRaw({},f.launch);
      const quote=f.adapter.cp.getQuote2({inputTokenMint:f.pool.tokenBMint,slippage:0,currentPoint:bn(100),
        poolState:f.pool,tokenADecimal:6,tokenBDecimal:decimals,hasReferral:false,
        swapMode:SwapMode.PartialFill,amountIn:bn(budget)});
      assert.equal(quote.nextSqrtPrice.toString(),f.model.sqrtMaxPrice);
      assert.ok(BigInt(quote.includedFeeInputAmount.toString())<=BigInt(budget));
      assert.ok(quote.outputAmount.gtn(0));assert.ok(quote.amountLeft.gtn(0));
    }
  }
});

test('already migrated, bonded or absent launches do not propose another buy',async()=>{
  const f=fixture();f.state.phase=2;assert.equal(await f.adapter.buyToGraduationRaw({},f.launch),null);
  f.state.phase=0;f.pool.sqrtPrice=bn(f.model.sqrtMaxPrice);assert.equal(await f.adapter.buyToGraduationRaw({},f.launch),null);
  f.adapter.rawState=async()=>({state:null});assert.equal(await f.adapter.buyToGraduationRaw({},f.launch),null);
});

test('a quote that does not reach the endpoint or exceeds the budget fails closed',async()=>{
  const f=fixture();f.adapter.cp.getQuote2=()=>({nextSqrtPrice:bn(1),includedFeeInputAmount:bn(1),outputAmount:bn(1)});
  await assert.rejects(f.adapter.buyToGraduationRaw({},f.launch),/could not be verified/);
  f.adapter.cp.getQuote2=()=>({nextSqrtPrice:bn(f.model.sqrtMaxPrice),includedFeeInputAmount:bn(1n<<64n),outputAmount:bn(1)});
  await assert.rejects(f.adapter.buyToGraduationRaw({},f.launch),/could not be verified/);
});

test('every admin wallet review clearly overrides public launch labels',async()=>{
  const adapter=new DammPumpTestClientAdapter({connection:{getSlot:async()=>100},deploymentVerifier:async()=>({chainEnabled:true}),venueVerifier:async()=>({})});
  adapter.prepareLookupTable=async()=>({action:'configure',review:{networkFeeLamports:'5000'}});
  const result=await adapter.prepare({}, {action:'configure',launch:{quoteDecimals:9,priceSnapshot:{quoteUsdMicros:'100000000'}},wallet:'owner'});
  assert.equal(result.review.initialFdvUsd,50);assert.equal(result.review.graduationFdvUsd,100);
  assert.equal(result.review.adminTest,true);assert.equal(result.review.networkFeeLamports,'5000');assert.equal(result.review.graduationFeeNumerator,'322369073');assert.equal(BigInt(result.review.estimatedGrossQuoteRaw),BigInt(result.review.estimatedGraduationFeeRaw)+BigInt(result.review.estimatedLpQuoteRaw));
});
