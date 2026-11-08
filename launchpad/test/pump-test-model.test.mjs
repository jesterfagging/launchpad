import test from 'node:test';
import assert from 'node:assert/strict';
import {previewPumpTestModel,createPumpTestSimulation,simulatePumpTestTrade,simulatePumpTestMigration,donatePumpTestQuote,assertPumpTestConservation} from '../src/pump-test-model.mjs';

const cfg = (graduationFeeBps=2885, tradeFeeBps=100, extra={}) => ({graduationFeeBps,tradeFeeBps,solUsdMicros:'150000000',...extra});
const ceiling = (a,b) => (a+b-1n)/b;
const u64=(1n<<64n)-1n;
const near=(actual,expected,tolerance=0.001)=>assert.ok(Math.abs(Number(actual)-expected)<=tolerance, `${actual} differs from ${expected}`);
const graduate = state => simulatePumpTestTrade(state,{side:'buy',amount:u64}).state;

for (const [fee,quote,cut,lp] of [[0,19371.294336,0,38742.588672],[1000,20152.036478,2015.203648,36273.665660],[2000,20998.355975,4199.671195,33597.369560],[2885,21808.930105,6291.876335,31034.107539],[3000,21918.876403,6575.662921,30686.426964]]) {
  test(`calibrates $20k/$50k targets and economics at ${fee} bps graduation fee`,()=>{
    const p=previewPumpTestModel(cfg(fee));
    near(p.actualStartingFdvUsd,20000); near(p.actualCurveEndFdvUsd,50000); near(p.actualPoolOpeningFdvUsd,50000);
    near(p.grossQuoteUsd,quote,0.02);near(p.graduationFeeUsd,cut,0.02);near(p.totalLpUsd,lp,0.04);
    assert.equal(BigInt(p.grossQuoteRaw),BigInt(p.graduationFeeRaw)+BigInt(p.netQuoteRaw));
    assert.equal(BigInt(p.totalSupplyRaw),BigInt(p.tokensSoldAtGraduationRaw)+BigInt(p.tokensForPoolRaw));
    assert.equal(p.totalSupplyTokens,'1000000000');assert.equal(p.tokenDecimals,6);
    assert.equal(p.execution,'model-only');assert.equal(p.lpBurnVerified,false);assert.doesNotThrow(()=>JSON.stringify(p));
  });
}

test('explicit fee configuration rejects absent, noninteger, negative and oversized values',()=>{
  for(const value of [undefined,null,NaN,Infinity,-1,3001,1.2,'2885',Number.MAX_SAFE_INTEGER]) assert.throws(()=>previewPumpTestModel({...cfg(),graduationFeeBps:value}));
  for(const value of [undefined,null,NaN,Infinity,-1,301,0.1,'100']) assert.throws(()=>previewPumpTestModel({...cfg(),tradeFeeBps:value}));
  assert.throws(()=>previewPumpTestModel({solUsdMicros:'150000000'}));
});

test('prices, decimals and unbounded parsing fail closed',()=>{
  for(const value of [0,'0',-1,'-1','1e9','01','0.1',NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'9'.repeat(10000),'1000000000000001']) assert.throws(()=>previewPumpTestModel({...cfg(),solUsdMicros:value}));
  for(const quoteDecimals of [-1,19,0.1,NaN,'9']) assert.throws(()=>previewPumpTestModel({...cfg(),quoteDecimals}));
  assert.throws(()=>previewPumpTestModel({...cfg(),quoteUsdMicros:'1'}),/Conflicting/);
  assert.throws(()=>previewPumpTestModel({...cfg(),quoteSymbol:'\u0000'}));
  assert.throws(()=>previewPumpTestModel({...cfg(),quoteMint:'0'.repeat(44)}));
  assert.throws(()=>previewPumpTestModel({graduationFeeBps:0,tradeFeeBps:0,quoteDecimals:18,quoteUsdMicros:'1',quoteSymbol:'LOW'}),/range/);
  assert.throws(()=>previewPumpTestModel({graduationFeeBps:0,tradeFeeBps:0,quoteDecimals:0,quoteUsdMicros:'1000000000000000',quoteSymbol:'HIGH'}));
});

test('supports generic quote arithmetic without claiming asset eligibility',()=>{
  for(const [quoteSymbol,quoteDecimals,quoteUsdMicros] of [['USDC',6,'1000000'],['MEME',6,'123'],['STOCK',8,'130000000'],['X',12,'150000000000']]) {
    const p=previewPumpTestModel({graduationFeeBps:2885,tradeFeeBps:100,quoteSymbol,quoteDecimals,quoteUsdMicros});
    near(p.totalLpUsd,31034.107539,0.001);assert.equal(p.quoteSymbol,quoteSymbol);assert.equal(p.solUsdMicros,undefined);
    const state=simulatePumpTestMigration(graduate(createPumpTestSimulation({graduationFeeBps:2885,tradeFeeBps:100,quoteSymbol,quoteDecimals,quoteUsdMicros}))).state;
    assert.equal(assertPumpTestConservation(state),true);
  }
});

test('buy charges fee once and sell removes gross reserve debit exactly once',()=>{
  let state=createPumpTestSimulation(cfg(2000,200),{rentQuoteRaw:'1234'});
  const buy=simulatePumpTestTrade(state,{side:'buy',amount:'1000000000'});state=buy.state;
  assert.equal(buy.result.feeQuoteRaw,'20000000');assert.equal(state.accountedQuoteRaw,'980000000');
  const sell=simulatePumpTestTrade(state,{side:'sell',amount:state.tokensSoldRaw});state=sell.state;
  assert.equal(BigInt(sell.result.reserveDebitQuoteRaw),BigInt(sell.result.paidQuoteRaw)+BigInt(sell.result.feeQuoteRaw));
  assert.equal(state.tokensSoldRaw,'0');assert.ok(BigInt(state.totalSellPaidQuoteRaw)<BigInt(state.totalBuyGrossQuoteRaw));
  assert.equal(state.custodyQuoteRaw,(1234n+BigInt(state.accountedQuoteRaw)).toString());
  assert.equal(assertPumpTestConservation(state),true);
});

test('final buy caps sold allocation, quotes minimum payment and refunds excess',()=>{
  const state=createPumpTestSimulation(cfg()),p=previewPumpTestModel(cfg());
  const net=BigInt(p.grossQuoteRaw),gross=ceiling(net*10000n,9900n);
  const buy=simulatePumpTestTrade(state,{side:'buy',amount:gross+1234567n});
  assert.equal(buy.state.status,'ready');assert.equal(buy.result.refundQuoteRaw,'1234567');
  assert.equal(buy.result.chargedQuoteRaw,gross.toString());assert.equal(buy.result.tokensOutRaw,p.tokensSoldAtGraduationRaw);
  assert.equal(buy.state.accountedQuoteRaw,net.toString());assert.equal(buy.state.custodyBaseRaw,p.tokensForPoolRaw);
  assert.throws(()=>simulatePumpTestTrade(buy.state,{side:'buy',amount:1n}),/finished/);
  const reopened=simulatePumpTestTrade(buy.state,{side:'sell',amount:BigInt(buy.state.tokensSoldRaw)/10n}).state;
  assert.equal(reopened.status,'bonding');
  assert.throws(()=>simulatePumpTestMigration(reopened),/not reached/);
  assert.equal(simulatePumpTestMigration(graduate(reopened)).state.status,'migrated');
  const prior=simulatePumpTestTrade(state,{side:'buy',amount:gross-1n});assert.equal(prior.state.status,'bonding');
});

test('migration uses ledger quote, excludes donations/rent and never charges twice',()=>{
  let state=createPumpTestSimulation(cfg(),{rentQuoteRaw:'2000000'});
  state=donatePumpTestQuote(state,'999999999999999');
  assert.throws(()=>simulatePumpTestMigration(state),/not reached/);
  state=graduate(state);const expected=ceiling(BigInt(state.accountedQuoteRaw)*2885n,10000n);
  const first=simulatePumpTestMigration(state);assert.equal(first.alreadyMigrated,false);
  assert.equal(first.state.graduationFeeRaw,expected.toString());assert.equal(first.state.accountedQuoteRaw,'0');
  assert.equal(first.state.custodyQuoteRaw,'1000000001999999');assert.equal(first.state.lpBurnVerified,false);
  const second=simulatePumpTestMigration(first.state);assert.equal(second.alreadyMigrated,true);assert.equal(second.state,first.state);
  assert.equal(assertPumpTestConservation(first.state),true);
});

test('zero fees are genuinely zero for buys, sells and migration',()=>{
  let state=createPumpTestSimulation(cfg(0,0));
  state=simulatePumpTestTrade(state,{side:'buy',amount:'1000000000'}).state;
  state=simulatePumpTestTrade(state,{side:'sell',amount:BigInt(state.tokensSoldRaw)/2n}).state;
  state=simulatePumpTestMigration(graduate(state)).state;
  assert.equal(state.tradeFeesQuoteRaw,'0');assert.equal(state.graduationFeeRaw,'0');
});

test('configuration and states are immutable and forged states are rejected',()=>{
  const input=cfg(),state=createPumpTestSimulation(input);input.graduationFeeBps=0;
  assert.equal(state.config.graduationFeeBps,2885);assert.ok(Object.isFrozen(state));assert.ok(Object.isFrozen(state.config));
  assert.throws(()=>{state.config.graduationFeeBps=0;},TypeError);
  assert.throws(()=>{state.accountedQuoteRaw='1';},TypeError);
  assert.throws(()=>simulatePumpTestTrade({...state},{side:'buy',amount:'1'}),/Unrecognized/);
  assert.throws(()=>simulatePumpTestMigration({...state,status:'ready'}),/Unrecognized/);
});

test('rejects oversells, subunit trades and ledger/custody overflow',()=>{
  const state=createPumpTestSimulation(cfg());
  assert.throws(()=>simulatePumpTestTrade(state,{side:'sell',amount:1n}),/more tokens/);
  assert.throws(()=>simulatePumpTestTrade(state,{side:'buy',amount:0n}),/positive/);
  assert.throws(()=>simulatePumpTestTrade(state,{side:'buy',amount:1n}),/too small/);
  assert.throws(()=>simulatePumpTestTrade(state,{side:'buy',amount:u64+1n}),/range/);
  assert.throws(()=>simulatePumpTestTrade(state,{side:'unknown',amount:2n}),/side/);
  const full=donatePumpTestQuote(state,u64);
  assert.throws(()=>donatePumpTestQuote(full,1n),/u64/);
  assert.throws(()=>simulatePumpTestTrade(full,{side:'buy',amount:'1000000000'}),/u64/);
  assert.equal(state.accountedQuoteRaw,'0');
});

test('deterministic randomized trade sequences preserve all ledgers and integer bounds',()=>{
  let seed=0x14b59c11;
  const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let scenario=0;scenario<120;scenario++) {
    const preset=scenario % 2 === 0 ? 'standard' : 'micro-test';
    const graduationFeeBps=rand()%3001,tradeFeeBps=rand()%301;
    const quoteDecimals=[6,9,12][rand()%3],quoteUsdMicros=String(1000000+rand()%99000000);
    let state=createPumpTestSimulation({preset,graduationFeeBps,tradeFeeBps,quoteDecimals,quoteUsdMicros,quoteSymbol:'TEST'}, {rentQuoteRaw:'123456'});
    state=donatePumpTestQuote(state,String(rand()));
    for(let i=0;i<100 && state.status==='bonding';i++) {
      const vb=BigInt(state.virtualBaseRaw),vq=BigInt(state.virtualQuoteRaw),k=vb*vq;
      const sold=BigInt(state.tokensSoldRaw);
      const sell=sold>1000000n && rand()%3===0;
      const amount=sell?sold*BigInt(1+rand()%90)/100n:BigInt(10**quoteDecimals)*BigInt(1+rand()%100)/100n;
      const attempt=simulatePumpTestTrade(state,{side:sell?'sell':'buy',amount});state=attempt.state;
      assert.equal(assertPumpTestConservation(state),true);
      assert.ok(BigInt(state.virtualBaseRaw)*BigInt(state.virtualQuoteRaw)>=k);
      for(const [key,value] of Object.entries(state)) if(typeof value==='string' && /^\d+$/.test(value)) assert.ok(BigInt(value)<=u64, key);
    }
    if(state.status==='bonding') state=graduate(state);
    state=simulatePumpTestMigration(state).state;assert.equal(assertPumpTestConservation(state),true);
  }
});

for (const preset of ['standard','micro-test']) test(`${preset}: splitting trades cannot create quote from a buy/sell roundtrip`,()=>{
  let state=createPumpTestSimulation(cfg(1000,0,{preset}));
  for(let i=0;i<1000;i++) state=simulatePumpTestTrade(state,{side:'buy',amount:preset === 'standard'?'1234567':'1234'}).state;
  while(BigInt(state.tokensSoldRaw)>0n) {
    const outstanding=BigInt(state.tokensSoldRaw),chunk=outstanding>1000000000n?1000000000n:outstanding;
    state=simulatePumpTestTrade(state,{side:'sell',amount:chunk}).state;
  }
  assert.ok(BigInt(state.totalSellPaidQuoteRaw)<=BigInt(state.totalBuyGrossQuoteRaw));
  assert.equal(assertPumpTestConservation(state),true);
});

test('ordinary buys also refund quote rounding dust instead of overcharging',()=>{
  const state=createPumpTestSimulation({graduationFeeBps:2885,tradeFeeBps:100,quoteUsdMicros:'10000000000',quoteDecimals:18,quoteSymbol:'HIGH'});
  const buy=simulatePumpTestTrade(state,{side:'buy',amount:'1000000000000000'});
  assert.equal(buy.state.status,'bonding');assert.equal(buy.result.refundQuoteRaw,'1723');
  const output=BigInt(buy.result.tokensOutRaw),vb=BigInt(state.virtualBaseRaw),vq=BigInt(state.virtualQuoteRaw);
  const charged=BigInt(buy.result.chargedQuoteRaw),priorNet=(charged-1n)*9900n/10000n;
  assert.ok(vb*priorNet/(vq+priorNet)<output);
  assert.equal(assertPumpTestConservation(buy.state),true);
});


test('supports bounded Unicode ticker metadata without ASCII-only filtering',()=>{
  for(const quoteSymbol of ['熊猫','🟥🟩','LMAO!']) {
    const p=previewPumpTestModel({...cfg(),quoteSymbol});assert.equal(p.quoteSymbol,quoteSymbol);
  }
  for(const quoteSymbol of ['','　','x'.repeat(33),'A\nB','A\u007fB']) assert.throws(()=>previewPumpTestModel({...cfg(),quoteSymbol}));
});


test('micro-test preset fixes $100 start and $500 graduation independently of standard',()=>{
  for(const graduationFeeBps of [0,1000,2000,2885,3000]) {
    const p=previewPumpTestModel(cfg(graduationFeeBps,100,{preset:'micro-test'}));
    assert.equal(p.preset,'micro-test');assert.equal(p.startingFdvUsd,'100.000000');assert.equal(p.graduationFdvUsd,'500.000000');
    near(p.actualStartingFdvUsd,100,0.0001);near(p.actualPoolOpeningFdvUsd,500,0.0005);
    const f=graduationFeeBps/10000,raise=500/(1+Math.sqrt(5)-f);
    near(p.grossQuoteUsd,raise,0.000001);near(p.totalLpUsd,2*raise*(1-f),0.000003);
    const state=simulatePumpTestMigration(graduate(createPumpTestSimulation(cfg(graduationFeeBps,100,{preset:'micro-test'})))).state;
    assert.equal(state.graduationFeeRaw,p.graduationFeeRaw);assert.equal(assertPumpTestConservation(state),true);
  }
  const p=previewPumpTestModel(cfg());assert.equal(p.preset,'standard');assert.equal(p.startingFdvUsd,'20000.000000');
});

test('preset input rejects arbitrary targets and unsupported preset names',()=>{
  for(const preset of ['mainnet','custom',{},1,'__proto__']) assert.throws(()=>previewPumpTestModel({...cfg(),preset}),/Preset/);
  for(const key of ['startingFdvUsd','graduationFdvUsd','startUsd','graduationUsd']) assert.throws(()=>previewPumpTestModel({...cfg(),[key]:'1'}),/Arbitrary/);
});
