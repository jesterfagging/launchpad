import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Keypair,PublicKey,SystemProgram,TransactionInstruction} from '@solana/web3.js';
import {AccountLayout,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {LaunchChain} from '../src/launchpad-chain.mjs';
import {Launchpad} from '../src/launchpad.mjs';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {JUPITER} from '../src/core.mjs';
import {SOL_MINT,launchInput,newLaunchCurvePolicy} from '../public/launchpad-model.mjs';

const wire=ix=>({programId:ix.programId.toBase58(),accounts:ix.keys.map(({pubkey,...key})=>({...key,pubkey:pubkey.toBase58()})),data:Buffer.from(ix.data).toString('base64')});
const failureLogs=(program=JUPITER,code=6001)=>[`Program ${program} invoke [1]`,`Program ${program} failed: custom program error: 0x${code.toString(16)}`];

// Real launch instruction assembly, v0 serialization and launch journal; only
// network reads are fixtures. A six-instruction provider route places Jupiter
// at instruction 8, matching the reported position without assuming its code.
async function harness(t,{stage='setup'}={}){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-funding-retry-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const payer=Keypair.generate(),quote=Keypair.generate().publicKey,keys=newLaunchKeys();keys.platform=keys.wallet;keys.payer={address:payer.publicKey.toBase58(),external:true};
  let clock=Date.now(),fails=1,logs=failureLogs(),custom=6001,quoteChange=null;
  const launch={id:'a'.repeat(32),keys,executionPlan:'compact-v3',input:launchInput({name:'Retry',symbol:'TRY',quoteMint:quote.toBase58(),feeMode:'creator',walletMode:'external',externalWallet:keys.payer.address,devBuySol:'0.01'}),review:{quoteProgram:TOKEN_PROGRAM_ID.toBase58(),minimumSol:'0.07325889',platformRent:'15000000',serviceReserve:'0',storageWalletRent:'890880',devBuy:{gross:'1000000',net:'1000000',maxQuote:'100000',solBudget:'10000000'}},storage:{budget:'0'},state:'launching',phase:stage,authorizedAt:clock,createdAt:clock,operations:stage==='quote-fund'?[{kind:'platform',state:'confirmed',signature:'already-confirmed',createdAt:clock}]:[],gas:{day:new Date(clock).toISOString().slice(0,10),reserved:'0'},credits:{quote:'0',base:'0'},autoFees:false};
  // Setup starts with a current unsigned review; quote funding resumes a paid legacy launch.
  if(stage==='setup'){const curvePolicy=newLaunchCurvePolicy(launch.input);Object.assign(launch.input,curvePolicy);Object.assign(launch.review,curvePolicy);}
  const policy={recipient:Keypair.generate().publicKey.toBase58(),curveFeeBps:100,creationFeeSol:'0',autoHarvest:true,lpPolicy:'platform_locked',platformLpPercent:75};launch.input.protocolFees=structuredClone(policy);launch.review.protocolFees=structuredClone(policy);launch.review.platformFeeBps=100;launch.feeCustody='relay';
  let book={version:1,launches:[launch]};const requests=[],simulations=[],sends=[];
  const token=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint:quote,owner:payer.publicKey,amount:100000n,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},token);
  const chain=new LaunchChain({network:'mainnet-beta',sleep:async()=>{},connection:{
    getBalance:async()=>1000000000,
    getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1000}),
    getBlockHeight:async()=>100,
    getMultipleAccountsInfoAndContext:async()=>({context:{slot:100},value:[{owner:SystemProgram.programId,lamports:1000000000},null]}),
    simulateTransaction:async(tx,config)=>{
      simulations.push(tx);assert.equal(config.sigVerify,false);
      const index=tx.message.compiledInstructions.findIndex(ix=>tx.message.staticAccountKeys[ix.programIdIndex].toBase58()===JUPITER);
      if(fails-->0)return{value:{err:{InstructionError:[index,{Custom:custom}]},logs}};
      return{context:{slot:101},value:{err:null,unitsConsumed:100000,accounts:[{owner:SystemProgram.programId.toBase58(),lamports:stage==='quote-fund'?990000000:975000000},{owner:TOKEN_PROGRAM_ID.toBase58(),lamports:2039280,data:[token.toString('base64'),'base64']}]}};
    },
    sendRawTransaction:async bytes=>{sends.push(bytes);throw Error('Unexpected broadcast');},
  },fetcher:async url=>{
    const query=Object.fromEntries(new URL(url).searchParams);requests.push(query);
    const setupInstructions=Array.from({length:5},()=>wire(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:payer.publicKey,lamports:0})));
    const swapInstruction=wire(new TransactionInstruction({programId:new PublicKey(JUPITER),keys:[{pubkey:payer.publicKey,isSigner:true,isWritable:true}],data:Buffer.from([requests.length])}));
    return new Response(JSON.stringify({inputMint:SOL_MINT,outputMint:quote.toBase58(),inAmount:'10000000',swapMode:'ExactIn',otherAmountThreshold:'100000',slippageBps:100,priceImpactPct:'.001',setupInstructions,swapInstruction,...quoteChange}));
  }});chain.jupiterGate={acquire:async()=>{},cooldown:()=>{}};
  const accounts={dir,hostStore:{read:async(key,fallback)=>key==='launch-protocol-fees'?policy:fallback},get:async()=>({mainWallet:keys.payer.address}),storeFor:()=>({dir,read:async(key,fallback)=>key==='launchpad'?structuredClone(book):fallback,write:async(key,value)=>{if(key==='launchpad')book=structuredClone(value);}})};
  const manager=new Launchpad(accounts,null,{chainFactory:()=>chain,now:()=>clock});manager.kick=()=>{};t.after(()=>manager.close());
  return{chain,manager,requests,simulations,sends,get launch(){return book.launches[0];},get now(){return clock;},set fails(n){fails=n;},set logs(value){logs=value;},set custom(value){custom=value;},set quoteChange(value){quoteChange=value;},due(){clock=book.launches[0].retry.at;}};
}

test('verified Jupiter setup slippage refreshes the route before signing without spending or discarding the launch',async t=>{
  const h=await harness(t),review=structuredClone(h.launch.review),keys=structuredClone(h.launch.keys);
  await h.manager.process('owner');
  assert.equal(h.launch.state,'launching');assert.equal(h.launch.retry.attempt,1);assert.match(h.launch.error,/refreshing the route within your original budget/);assert.equal(h.launch.recovery,undefined);
  assert.equal(h.launch.operations.length,0);assert.equal(h.sends.length,0);assert.equal(h.simulations.length,1);
  const tx=h.simulations[0];assert.equal(tx.message.staticAccountKeys[tx.message.compiledInstructions[8].programIdIndex].toBase58(),JUPITER);
  await h.manager.process('owner');assert.equal(h.requests.length,1,'polling cannot bypass the cooldown');
  h.due();await h.manager.process('owner');
  assert.equal(h.launch.state,'awaiting_signature');assert.equal(h.launch.retry,undefined);assert.equal(h.launch.error,'');assert.equal(h.launch.operations.length,1);assert.equal(h.launch.operations[0].kind,'setup');assert.equal(h.launch.operations[0].state,'awaiting_signature');
  assert.equal(h.requests.length,2);assert.deepEqual(h.requests[0],h.requests[1]);assert.deepEqual(h.launch.review,review);assert.deepEqual(h.launch.keys,keys);assert.equal(h.sends.length,0);
  assert.notDeepEqual(h.simulations[0].message.serialize(),h.simulations[1].message.serialize(),'fetch and simulate a fresh route, never repeat a stale quote');
});

test('a legacy quote-funding retry preserves already confirmed setup and needs a new user signature',async t=>{
  const h=await harness(t,{stage:'quote-fund'});assert.equal(h.launch.input.curvePolicy,undefined);assert.equal(h.launch.review.curvePolicy,undefined);await h.manager.process('owner');h.due();await h.manager.process('owner');
  assert.equal(h.launch.operations[0].signature,'already-confirmed');assert.equal(h.launch.operations[0].state,'confirmed');assert.deepEqual(h.launch.operations.map(op=>op.kind),['platform','quote-fund']);assert.equal(h.launch.state,'awaiting_signature');assert.equal(h.sends.length,0);
});

test('repeated verified slippage is bounded and retains the original recovery path after exhaustion',async t=>{
  const h=await harness(t);h.fails=20;
  for(let attempt=1;attempt<=8;attempt++){
    await h.manager.process('owner');assert.equal(h.requests.length,attempt);assert.equal(h.launch.operations.length,0);assert.equal(h.sends.length,0);
    if(attempt<8){assert.equal(h.launch.retry.attempt,attempt);assert.equal(h.launch.recovery,undefined);h.due();}
  }
  assert.equal(h.launch.state,'error');assert.equal(h.launch.retry,undefined);assert.match(h.launch.error,/1% price limit/);
  await h.manager.process('owner');assert(h.launch.recovery,'exhausted launches use the existing explicit stopped-launch recovery');assert.equal(h.requests.length,8);assert.equal(h.sends.length,0);
});

test('a changed market quote retries within the original threshold, never changing budget or slippage',async t=>{
  const h=await harness(t);h.fails=0;h.quoteChange={otherAmountThreshold:'99999'};
  await h.manager.process('owner');assert.equal(h.launch.state,'launching');assert.equal(h.launch.operations.length,0);assert.equal(h.simulations.length,0);
  h.quoteChange=null;h.due();await h.manager.process('owner');assert.equal(h.launch.state,'awaiting_signature');
  assert.equal(h.requests.length,2);assert.deepEqual(h.requests[0],h.requests[1]);assert.equal(h.requests[1].amount,'10000000');assert.equal(h.requests[1].slippageBps,'100');assert.equal(h.launch.review.devBuy.maxQuote,'100000');assert.equal(h.sends.length,0);
});

test('6001 from another program, a nested DEX, missing logs or another error never receives the Jupiter retry classification',async t=>{
  const dex=Keypair.generate().publicKey.toBase58();
  for(const logs of [undefined,[],failureLogs(dex),[...failureLogs(dex),...failureLogs()],[`Program ${dex} failed: invalid program argument`,...failureLogs()],failureLogs(JUPITER,6002)]){
    const h=await harness(t);h.logs=logs;await h.manager.process('owner');
    assert.equal(h.launch.state,'error');assert.equal(h.launch.retry,undefined);assert.match(h.launch.error,/during setup \(instruction 8, program JUP6/);assert.equal(h.sends.length,0);
  }
  const h=await harness(t);h.custom=6002;await h.manager.process('owner');assert.equal(h.launch.retry,undefined);assert.equal(h.launch.state,'error');
  const other=await harness(t);const instruction=new TransactionInstruction({programId:new PublicKey(dex),keys:[],data:Buffer.alloc(0)});
  other.chain.c.simulateTransaction=async()=>({value:{err:{InstructionError:[2,{Custom:6001}]},logs:failureLogs()}});
  await assert.rejects(other.chain.prepare(other.launch,[instruction],[],'setup'),e=>!e.retryable&&e.message.includes(dex));
});

test('invalid route parameters are rejected immediately rather than retried as market movement',async t=>{
  for(const quoteChange of [{slippageBps:-1},{slippageBps:101},{otherAmountThreshold:'not-a-number'},{priceImpactPct:'.03'},{inAmount:'10000001'},{outputMint:SOL_MINT}]){
    const h=await harness(t);h.quoteChange=quoteChange;await h.manager.process('owner');assert.equal(h.launch.state,'error');assert.equal(h.launch.retry,undefined);assert.equal(h.simulations.length,0);assert.equal(h.launch.operations.length,0);assert.equal(h.sends.length,0);
  }
});
