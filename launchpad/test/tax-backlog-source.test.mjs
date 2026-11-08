import test from 'node:test';
import assert from 'node:assert/strict';
import { TAX_CONVERSION_BACKLOG_UNITS as BURST, TAX_CONVERSION_BURST_POLICY } from '../src/launchpad-tax-conversion.mjs';
import { TAX_PROTOCOL_POLICY, taxProtocolLedger, recordTaxHarvest, recordTaxConversion, taxBacklogSource, recordMixedTaxConversion } from '../src/launchpad-tax-protocol.mjs';

const MILLION=1000000000000n;
function fixture(tax=7n*MILLION,ordinary=8n*MILLION){
  const l={input:{route:'raydium',feeMode:'holders',taxBps:300},credits:{base:ordinary.toString(),quote:'123'},operations:[]};
  l.taxProtocol=recordTaxHarvest(l,tax);l.credits.base=(tax+ordinary).toString();return l;
}
const operation=l=>({kind:'sell',amount:BURST.toString(),...taxBacklogSource(l,BURST).operationData,taxConversionPolicy:TAX_CONVERSION_BURST_POLICY});
function settle(l,op,received){
  const result=recordMixedTaxConversion(l,op,BURST,received);
  l.taxProtocol=result.ledger;l.credits.base=(BigInt(l.credits.base)-BURST).toString();l.credits.quote=(BigInt(l.credits.quote)+result.holderQuote).toString();taxProtocolLedger(l);return result;
}

test('one exact ten-million backlog transaction combines seven million tax and three million ordinary earned tokens',()=>{
  const l=fixture(),before=structuredClone(l),source=taxBacklogSource(l,BURST);
  assert.deepEqual(source,{credit:BURST.toString(),operationData:{taxProtocolPolicy:TAX_PROTOCOL_POLICY,taxSource:'mixed-earned',taxBaseUnits:(7n*MILLION).toString(),ordinaryBaseUnits:(3n*MILLION).toString()}});
  assert.deepEqual(l,before,'planning never changes balances or source attribution');
  const result=settle(l,operation(l),1000n);
  assert.equal(result.taxQuote,700n);assert.equal(result.protocolQuote,35n);assert.equal(result.holderQuote,965n);
  assert.equal(l.credits.base,(5n*MILLION).toString());assert.equal(l.credits.quote,'1088');
  assert.equal(l.taxProtocol.sourceBaseCredit,'0');assert.equal(l.taxProtocol.convertedBase,(7n*MILLION).toString());
  assert.equal(l.taxProtocol.convertedQuote,'700');assert.equal(l.taxProtocol.holderQuote,'665');assert.equal(l.taxProtocol.creditQuote,'35');
});

test('pure tax and pure ordinary sources preserve existing policies and exclude wallet surplus',()=>{
  assert.deepEqual(taxBacklogSource(fixture(12n*MILLION,3n*MILLION),BURST),{credit:BURST.toString(),operationData:{taxProtocolPolicy:TAX_PROTOCOL_POLICY,taxSource:'withheld-tax'}});
  assert.deepEqual(taxBacklogSource(fixture(0n,12n*MILLION),BURST),{credit:BURST.toString(),operationData:{}});
  const l=fixture(3n*MILLION,4n*MILLION);l.walletBalanceBase=(100n*MILLION).toString();
  assert.throws(()=>taxBacklogSource(l,BURST),/earned base tokens/);
  for(const value of [0n,MILLION,BURST-1n,BURST+1n])assert.throws(()=>taxBacklogSource(fixture(),value),/exactly ten million/);
});

test('mixed conversion floors tax proceeds and keeps every ordinary quote unit free of protocol tax',()=>{
  const l=fixture(),result=settle(l,operation(l),101n);
  assert.equal(result.taxQuote,70n);assert.equal(result.protocolQuote,3n);assert.equal(result.holderQuote,98n);
  assert.equal(l.taxProtocol.holderQuote,'67');assert.equal(l.taxProtocol.roundingRemainder,'5000');
  assert.equal(result.holderQuote+result.protocolQuote,101n);
});

test('one quote unit can produce zero tax proceeds without a phantom fee or broken ledger',()=>{
  const l=fixture(),result=settle(l,operation(l),1n);
  assert.equal(result.taxQuote,0n);assert.equal(result.protocolQuote,0n);assert.equal(result.holderQuote,1n);
  assert.equal(l.taxProtocol.convertedQuote,'0');assert.equal(l.taxProtocol.convertedBase,(7n*MILLION).toString());
  assert.equal(l.taxProtocol.roundingRemainder,'0');
});

test('mixed tax share preserves cumulative fee rounding from prior pure tax receipts',()=>{
  const l=fixture();
  const earlier={amount:'1',taxProtocolPolicy:TAX_PROTOCOL_POLICY,taxSource:'withheld-tax'};
  const prior=recordTaxConversion(l,earlier,1n,19n);l.taxProtocol=prior.ledger;l.credits.base=(BigInt(l.credits.base)-1n).toString();
  assert.equal(l.taxProtocol.roundingRemainder,'9500');
  const result=settle(l,operation(l),2n);
  assert.equal(result.taxQuote,1n);assert.equal(result.protocolQuote,1n);assert.equal(result.holderQuote,1n);
  assert.equal(l.taxProtocol.convertedQuote,'20');assert.equal(l.taxProtocol.accruedQuote,'1');assert.equal(l.taxProtocol.roundingRemainder,'0');
});

test('altered source parts, overdraws, partial spends and inflated receipts fail without changing credits',()=>{
  const cases=[
    op=>({...op,taxBaseUnits:(6n*MILLION).toString(),ordinaryBaseUnits:(4n*MILLION).toString()}),
    op=>({...op,taxBaseUnits:(8n*MILLION).toString(),ordinaryBaseUnits:(2n*MILLION).toString()}),
    op=>({...op,ordinaryBaseUnits:(4n*MILLION).toString()}),
    op=>({...op,taxBaseUnits:'0',ordinaryBaseUnits:BURST.toString()}),
    op=>({...op,amount:(BURST+1n).toString()}),
    op=>({...op,taxBaseUnits:'-1'}),
  ];
  for(const alter of cases){const l=fixture(),before=structuredClone(l);assert.throws(()=>recordMixedTaxConversion(l,alter(operation(l)),BURST,1000n));assert.deepEqual(l,before);}
  for(const [spent,received] of [[BURST-1n,1000n],[BURST+1n,1000n],[BURST,0n],[BURST,-1n]]){
    const l=fixture(),before=structuredClone(l);assert.throws(()=>recordMixedTaxConversion(l,operation(l),spent,received));assert.deepEqual(l,before);
  }
  const l=fixture(),op=operation(l);l.credits.base=(9n*MILLION).toString();const before=structuredClone(l);
  assert.throws(()=>recordMixedTaxConversion(l,op,BURST,1000n),/earned base tokens/);assert.deepEqual(l,before);
});

test('restart receipts require the exact saved burst and tax policies, never reinterpret old sales',()=>{
  const l=fixture(),op=JSON.parse(JSON.stringify(operation(l))),restored=structuredClone(l);
  assert.equal(recordMixedTaxConversion(restored,op,BURST,1000n).protocolQuote,35n);
  for(const patch of [{taxConversionPolicy:undefined},{taxConversionPolicy:'paced-v1'},{taxProtocolPolicy:undefined},{taxProtocolPolicy:'other'},{taxSource:'withheld-tax'}, {taxSource:undefined}]){
    const before=structuredClone(l);assert.throws(()=>recordMixedTaxConversion(l,{...op,...patch},BURST,1000n),/authorized mixed/);assert.deepEqual(l,before);
  }
  const wrongMode=fixture();wrongMode.input.feeMode='creator';assert.throws(()=>recordMixedTaxConversion(wrongMode,op,BURST,1000n),/authorized mixed/);
});
