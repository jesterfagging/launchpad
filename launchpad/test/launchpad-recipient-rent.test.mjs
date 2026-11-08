import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey,SystemProgram,SystemInstruction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {LaunchChain,newLaunchKeys} from '../src/launchpad-chain.mjs';
import {SOL_MINT,USDC_MINT} from '../public/launchpad-model.mjs';
import {inspectNativeRewardRecipients} from '../src/launchpad-recipient-rent.mjs';

const address=()=>Keypair.generate().publicKey.toBase58();
const account=(lamports=1000000,size=0)=>({lamports,data:Buffer.alloc(size),owner:SystemProgram.programId,executable:false});
const row=(amount='10000')=>({owner:address(),amount});
function harness({rows=[row(),row(),row()],accounts=rows.map(()=>account()),simulationError=null,snapshot,simulationContext=true,feeMode='holders',quoteMint=SOL_MINT}={}){
  const l={id:'a'.repeat(32),keys:newLaunchKeys(),feeCustody:'relay',input:{route:'raydium',network:'mainnet-beta',quoteMint,feeMode,taxBps:feeMode==='holders'?200:0},review:{quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:quoteMint===SOL_MINT?9:6},credits:{quote:'100000000',base:'0'}};
  const reads=[],rents=[],simulations=[];
  const c=new LaunchChain({network:'mainnet-beta',connection:{
    getMultipleAccountsInfoAndContext:async(keys,config)=>{reads.push({keys:keys.map(String),config});return snapshot??{context:{slot:123},value:accounts};},
    getMinimumBalanceForRentExemption:async(size,commitment)=>{rents.push({size,commitment});return size===0?900000:2100000;},
    getLatestBlockhash:async()=>({blockhash:address(),lastValidBlockHeight:1000}),
    simulateTransaction:async(tx,config)=>{simulations.push({tx,config});return{...(simulationContext?{context:{slot:124}}:{}),value:{err:simulationError,unitsConsumed:60000}};},
  }});
  return{l,c,rows,reads,rents,simulations};
}

test('an empty third holder is deferred by exact allocation while funded holders are not marked',async()=>{
  const h=harness({accounts:[account(),account(),null]});
  await assert.rejects(h.c.payoutInstructions(h.l,h.rows),error=>error.code==='REWARD_RECIPIENT_RENT'&&assert.deepEqual(error.payouts,[h.rows[2]])===undefined);
  assert.deepEqual(h.reads,[{keys:h.rows.map(x=>x.owner),config:{commitment:'finalized'}}]);
  assert.deepEqual(h.rents,[{size:0,commitment:'finalized'}]);assert.equal(h.simulations.length,0);
});

test('exact rent threshold is payable and successful native transfers keep every amount and owner',async()=>{
  const h=harness({accounts:[null,account(500000),account(1000000)],rows:[row('900000'),row('400000'),row('1')]});
  const instructions=await h.c.payoutInstructions(h.l,h.rows);
  assert.deepEqual(instructions.slice(-3).map(ix=>{const transfer=SystemInstruction.decodeTransfer(ix);return{owner:transfer.toPubkey.toBase58(),amount:String(transfer.lamports)};}),h.rows);
  assert.equal(instructions.holderPayoutRentCheck.slot,123);
  assert(Object.isFrozen(instructions.holderPayoutRentCheck));assert(Object.isFrozen(instructions.holderPayoutRentCheck.payouts));
  assert.throws(()=>{instructions.holderPayoutRentCheck.payouts[0].amount='999';},TypeError);
  assert.throws(()=>{instructions.holderPayoutRentCheck={slot:1};},TypeError);
  await h.c.prepare(h.l,instructions,[],false,{operation:{kind:'payout'}});
  assert.equal(h.simulations[0].config.commitment,'finalized');assert.equal(h.simulations[0].config.minContextSlot,123);
});

test('nonempty below-rent accounts also defer, using their actual data length',async()=>{
  const h=harness({accounts:[account(100000),account(2000000,80),account()],rows:[row('1'),row('99999'),row('1')]});
  await assert.rejects(h.c.payoutInstructions(h.l,h.rows),error=>error.code==='REWARD_RECIPIENT_RENT'&&assert.deepEqual(error.payouts,h.rows.slice(0,2))===undefined);
  assert.deepEqual(h.rents,[{size:0,commitment:'finalized'},{size:80,commitment:'finalized'}]);
});

test('malformed recipient snapshots fail closed without claiming any holder is unpayable',async()=>{
  for(const snapshot of [
    {value:[null,null,null]},
    {context:{slot:0},value:[null,null,null]},
    {context:{slot:1},value:[null,null]},
    {context:{slot:1},value:[null,null,undefined]},
    {context:{slot:1},value:[null,null,{...account(),lamports:NaN}]},
    {context:{slot:1},value:[null,null,{...account(),data:undefined}]},
    {context:{slot:1},value:[null,null,{...account(),owner:undefined}]},
    {context:{slot:1},value:[null,null,{...account(),executable:undefined}]},
  ]){
    const h=harness({snapshot});
    await assert.rejects(h.c.payoutInstructions(h.l,h.rows),error=>error.code==='REWARD_RECIPIENT_SNAPSHOT'&&!error.payouts);
    assert.equal(h.simulations.length,0);
  }
});

test('RPC and rent-query failures preserve their normal errors rather than deferring recipients',async()=>{
  const recipient=row(),payer=address(),rpcError=Object.assign(Error('RPC 429 rate limit'),{status:429});
  await assert.rejects(inspectNativeRewardRecipients({getMultipleAccountsInfoAndContext:async()=>{throw rpcError;}},[recipient],payer),error=>error===rpcError);
  for(const value of [undefined,-1,NaN,1.25,'900000']){
    await assert.rejects(inspectNativeRewardRecipients({getMultipleAccountsInfoAndContext:async()=>({context:{slot:1},value:[null]}),getMinimumBalanceForRentExemption:async()=>value},[recipient],payer),error=>error.code==='REWARD_RECIPIENT_SNAPSHOT'&&!error.payouts);
  }
});

test('invalid amounts and duplicate rows cannot silently create a different allocation',async()=>{
  const payer=address(),r=row();
  for(const payouts of [[r,r],[{...r,amount:'0'}],[{...r,amount:'-1'}],[{...r,amount:1}],[{...r,amount:'18446744073709551616'}]])await assert.rejects(inspectNativeRewardRecipients({},payouts,payer),/Invalid holder payout amount|Duplicate holder payout recipient/);
  assert.equal(await inspectNativeRewardRecipients({},[{owner:payer,amount:'1'}],payer),null);
});

test('the real v0 account index 5 identifies the third holder after a balance changes before simulation',async()=>{
  const h=harness({simulationError:{InsufficientFundsForRent:{account_index:5}}}),instructions=await h.c.payoutInstructions(h.l,h.rows);
  await assert.rejects(h.c.prepare(h.l,instructions,[],false,{operation:{kind:'payout'}}),error=>error.code==='REWARD_RECIPIENT_RENT'&&assert.deepEqual(error.payouts,[h.rows[2]])===undefined);
  assert.equal(h.simulations[0].tx.message.staticAccountKeys[5].toBase58(),h.rows[2].owner);
  assert.equal(h.simulations[0].config.minContextSlot,123);
});

test('sender, temporary WSOL, source WSOL and program rent errors are never mistaken for a holder',async()=>{
  for(const index of [0,1,2,6,99]){
    const h=harness({simulationError:{InsufficientFundsForRent:{account_index:index}}}),instructions=await h.c.payoutInstructions(h.l,h.rows);
    await assert.rejects(h.c.prepare(h.l,instructions,[],false,{operation:{kind:'payout'}}),error=>!error.payouts&&error.code!=='REWARD_RECIPIENT_RENT'&&/InsufficientFundsForRent/.test(error.message));
  }
});

test('a simulation without the required context cannot defer a recipient or authorize a payout',async()=>{
  const h=harness({simulationContext:false,simulationError:{InsufficientFundsForRent:{account_index:5}}}),instructions=await h.c.payoutInstructions(h.l,h.rows);
  await assert.rejects(h.c.prepare(h.l,instructions,[],false,{operation:{kind:'payout'}}),error=>!error.payouts&&/simulation context/.test(error.message));
});

test('creator, protocol and SPL reward payouts retain their existing instruction path',async()=>{
  for(const options of [{feeMode:'creator'},{feeMode:'holders',quoteMint:USDC_MINT},{feeMode:'holders',kind:'tax-protocol-payout'}]){
    const h=harness(options),kind=options.kind||'payout';
    const instructions=await h.c.payoutInstructions(h.l,h.rows,{kind,operation:{kind}});
    assert.equal(h.reads.length,0);assert.equal(instructions.holderPayoutRentCheck,undefined);
    await h.c.prepare(h.l,instructions,[],false,{operation:{kind}});
    assert.equal(h.simulations[0].config.minContextSlot,undefined);
  }
});
