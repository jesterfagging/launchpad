import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeTradeFailure } from '../src/trade-errors.mjs';
import { PUMP, SOL, JUPITER } from '../src/core.mjs';

const fixture=JSON.parse(readFileSync(new URL('./pump-slippage-fixture.json',import.meta.url)));
const order={kind:'buy',amount:'50000000',venue:{type:'pump',quoteMint:SOL},executionLimits:{slippageBps:200}};

test('the actual failed Pump buy reports exact cap, required amount, fees and configured slippage',()=>{
  const report=describeTradeFailure(order,fixture.error,fixture);
  assert.match(report.message,/slippage limit hit/);assert.match(report.message,/0.05041827 SOL; cap 0.05 SOL/);
  assert.match(report.message,/No tokens bought/);
  assert.equal(report.details.failure.name,'TooMuchSolRequired');assert.equal(report.details.failure.slippageBps,200);
  assert.equal(report.details.failure.feeLamports,1003871);assert.equal(report.details.failure.quoteCapRaw,'50000000');
  assert.equal(report.details.failure.quoteRequiredRaw,'50418270');assert.equal(report.details.failure.programId,PUMP);
});

test('failure reporting never interprets another program, spoofed Anchor logs or missing data as Pump slippage',()=>{
  const other=structuredClone(fixture);other.transaction.message.instructions[3].programId=JUPITER;
  const spoof=structuredClone(fixture);spoof.meta.logMessages=spoof.meta.logMessages.map(l=>l.replaceAll(PUMP,JUPITER));
  const missing=structuredClone(fixture);delete missing.meta.logMessages;
  const mismatch=structuredClone(fixture);mismatch.meta.err=null;
  for(const tx of [undefined,other,spoof,missing,mismatch]) {
    const report=describeTradeFailure(order,fixture.error,tx);
    assert.equal(report.details.failure.name,null);assert.match(report.message,/failed on chain/);
    assert.equal(report.details.failure.quoteRequiredRaw,undefined);
  }
});

test('Pump sell slippage retains the position and non-SOL failures never label quote units as SOL',()=>{
  const sell=structuredClone(fixture);sell.error=sell.meta.err={InstructionError:[3,{Custom:6003}]};
  sell.meta.logMessages=sell.meta.logMessages.map(l=>l.replaceAll('TooMuchSolRequired','TooLittleSolReceived').replaceAll('6002','6003').replaceAll('0x1772','0x1773'));
  assert.match(describeTradeFailure({...order,kind:'sell'},sell.error,sell).message,/Position remains open/);
  const nonSol=describeTradeFailure({...order,venue:{type:'pump',quoteMint:JUPITER}},fixture.error,fixture);
  assert.match(nonSol.message,/slippage limit hit/);assert(!nonSol.message.includes('0.05 SOL'));assert.equal(nonSol.details.failure.quoteMint,undefined);
});
