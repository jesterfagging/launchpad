import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { units,decimal,chooseAmount,validateConfig,detectSwap,tokenBalances,swapEvidence,ladderTarget,ladderAmount,parseWallet,SOL,JUPITER,PUMP,LAUNCHLAB } from '../src/core.mjs';
import { lead,mint,quote,key1,swap,token,config } from './fixtures.mjs';

test('exact integer amounts, precision limits, and distinct decimal counts',()=>{
  assert.equal(units('.05'),50000000n);assert.equal(units('1.000000001'),1000000001n);assert.equal(units('1.25',6),1250000n);
  assert.equal(decimal(1000000001n),'1.000000001');assert.equal(decimal(0n),'0');
  for(const input of ['NaN','Infinity','-1','1e-9','0.0000000001'])assert.throws(()=>units(input));
  assert.throws(()=>units('18446744073709551616',0));
});
test('custom RPC overrides Helius, and standard streams can derive their own URL',()=>{
  const c=validateConfig(config({rpcUrl:'https://custom-rpc.example/key',wsUrl:'wss://custom-stream.example/key'}));
  assert.equal(c.rpcUrl,'https://custom-rpc.example/key');assert.equal(c.wsUrl,'wss://custom-stream.example/key');
  const generic=validateConfig(config({heliusKey:'',rpcUrl:'https://rpc.example/key',streamMode:'logs'}));assert.equal(generic.wsUrl,'wss://rpc.example/key');
  const logs=validateConfig(config({rpcUrl:'https://rpc.example/key',streamMode:'logs',fastPumpLogs:true}));assert.equal(logs.wsUrl,'wss://rpc.example/key');assert.equal(logs.fastPumpLogs,true);
  const full=validateConfig(config({rpcUrl:'https://rpc.example/key',streamMode:'helius'}));assert.equal(full.wsUrl,'wss://mainnet.helius-rpc.com/?api-key=dummy-test-key');
});
test('duplicate wallets, lead/follower loops, invalid manual fees and provider minima rejected',()=>{
  assert.throws(()=>validateConfig(config({wallets:[key1,key1]})),/unique/);
  assert.throws(()=>validateConfig(config({leads:[key1.publicKey.toBase58()]})),/also be a lead/);
  assert.throws(()=>validateConfig(config({heliusSol:'0.0001',senderTier:'max'})),/0.001/);
  assert.throws(()=>validateConfig(config({jitoSol:'0.000000001'})),/0.000001/);
  assert.throws(()=>validateConfig(config({heliusSol:'0.001',prioritySol:'0'})),/nonzero/);
});
test('public address cannot be mistaken for a private seed; errors exclude key material',()=>{
  const row={privateKey:key1.publicKey.toBase58()};assert.throws(()=>parseWallet(row,0,'live'),e=>!e.message.includes(key1.publicKey.toBase58()));assert.equal(row.privateKey,'');
  const seed={privateKey:'seed:'+bs58.encode(key1.secretKey.slice(0,32))};assert.equal(parseWallet(seed,0,'live').publicKey,key1.publicKey.toBase58());
});
test('random and custom sizes respect token units and boundaries',()=>{
  for(let i=0;i<100;i++){const amount=chooseAmount({amountMode:'random',randomMin:'0.01',randomMax:'0.02'},{},8);assert(amount>=1000000n&&amount<=2000000n);}
  assert.equal(chooseAmount({amountMode:'custom'},{amount:'1.234567'},6),1234567n);
});
test('buys and partial sells are distinguished from native fees/rent',()=>{
  const buy=detectSwap(swap(),lead,new Set([JUPITER]));assert.equal(buy.inputMint,SOL);assert.equal(buy.outputMint,mint);
  const sell=detectSwap(swap({input:mint,output:SOL,before:1000n,sold:250n}),lead,new Set([JUPITER]));assert.equal(sell.sellNumerator,250n);assert.equal(sell.sellDenominator,1000n);
  const spl=detectSwap(swap({input:quote,output:mint}),lead,new Set([JUPITER]));assert.equal(spl.inputMint,quote);
});
test('transfers, liquidity operations, failed trades, unsigned leads and spoofed logs are ignored',()=>{
  const plain=swap();plain.meta.logMessages=[];assert.equal(detectSwap(plain,lead,new Set([JUPITER])),null);
  const lp=swap();lp.meta.logMessages[1]='Program log: Instruction: AddLiquidity';assert.equal(detectSwap(lp,lead,new Set([JUPITER])),null);
  const failed=swap();failed.meta.err={InstructionError:[1,'fail']};assert.equal(detectSwap(failed,lead,new Set([JUPITER])),null);
  const unsigned=swap();unsigned.transaction.message.accountKeys[0].signer=false;assert.equal(detectSwap(unsigned,lead,new Set([JUPITER])),null);
  const spoof=swap();spoof.meta.logMessages=[`Program ${mint} invoke [1]`,'Program log: Instruction: Swap',`Program ${mint} success`];assert.equal(swapEvidence(spoof,new Set([JUPITER])),false);
});
test('balance reconciliation sums accounts and handles closed Token-2022 accounts',()=>{
  const tx=swap();tx.meta.preTokenBalances=[token(lead,mint,900,6,2),token(lead,mint,100,6,4)];tx.meta.postTokenBalances=[token(lead,mint,400,6,2)];
  const b=tokenBalances(tx,lead)[0];assert.equal(b.pre,1000n);assert.equal(b.post,400n);assert.equal(b.delta,-600n);
});
test('ambiguous multi-output transactions fail closed',()=>{
  const tx=swap();tx.meta.postTokenBalances.push(token(lead,quote,10,6,4));assert.equal(detectSwap(tx,lead,new Set([JUPITER])),null);
});
test('arbitrary quote mint is recovered from actual Pump V2 instruction accounts',()=>{
  const accounts=Array(27).fill(lead);accounts[1]=mint;accounts[2]=quote;accounts[10]=key1.publicKey.toBase58();
  const data=bs58.encode(createHash('sha256').update('global:buy_v2').digest().subarray(0,8));
  const tx=swap({input:quote,output:mint,program:PUMP,instructions:[{programId:PUMP,accounts,data}]});
  const s=detectSwap(tx,lead,new Set([PUMP]));assert.equal(s.venue.quoteMint,quote);assert.equal(s.venue.baseMint,mint);assert.equal(s.venue.type,'pump');
});
test('LaunchLab token/quote pairs are detected without symbol assumptions',()=>{
  const accounts=Array(18).fill(lead);accounts[9]=mint;accounts[10]=quote;accounts[4]=key1.publicKey.toBase58();
  const data=bs58.encode(createHash('sha256').update('global:buy_exact_in').digest().subarray(0,8));
  const s=detectSwap(swap({input:quote,output:mint,program:LAUNCHLAB,instructions:[{programId:LAUNCHLAB,accounts,data}]}),lead,new Set([LAUNCHLAB]));assert.equal(s.venue.type,'launchlab');assert.equal(s.venue.quoteMint,quote);
});
test('a SOL-funded launch buy can leave quote-token change without looking like two buys',()=>{
  const accounts=Array(27).fill(lead);accounts[1]=mint;accounts[2]=quote;accounts[10]=key1.publicKey.toBase58();
  const data=bs58.encode(createHash('sha256').update('global:buy_v2').digest().subarray(0,8));
  const tx=swap({program:PUMP,instructions:[{programId:PUMP,accounts,data}]});
  tx.meta.postTokenBalances.push(token(lead,quote,25,8,4));
  const s=detectSwap(tx,lead,new Set([PUMP]));assert.equal(s.inputMint,SOL);assert.equal(s.outputMint,mint);assert.equal(s.venue.quoteMint,quote);assert.equal(s.quoteDecimals,8);
});
test('ladders are additive, exact once by level, and never substitute FDV for market cap',()=>{
  const c={sellMode:'percent',percentStep:25,marketPollMs:2000};const lot={entryPrice:1,lastLevel:0};
  assert.equal(ladderTarget(lot,{price:1.75,receivedAt:Date.now()},c),3);assert.equal(ladderAmount('1000',25,3),579n);
  assert.equal(ladderTarget(lot,{price:0.9,receivedAt:Date.now()},c),0);
  assert.equal(ladderTarget(lot,{price:2,receivedAt:Date.now()-20000},c),0);
  assert.equal(ladderTarget({entryMarketCap:100000},{marketCap:null,fdv:500000,receivedAt:Date.now()},{sellMode:'marketcap',marketcapStep:10000,marketPollMs:2000}),0);
});
