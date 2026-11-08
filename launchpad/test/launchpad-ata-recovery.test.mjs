import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey,SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {ASSOCIATED_TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {LaunchChain,launchSimulationError,newLaunchKeys} from '../src/launchpad-chain.mjs';
import {savedAtaPayoutFailure,ataFundingSimulationFailure} from '../src/launchpad-ata-recovery.mjs';
import {activeRewardsFixture} from './helpers/rewards-wallet-fixture.mjs';
const key=()=>Keypair.generate().publicKey,ATA=ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),SYSTEM=SystemProgram.programId.toBase58();
const savedError=index=>`Onchain simulation failed during fee processing (instruction ${index}, program ${ATA}): {"InstructionError":[${index},{"Custom":1}]}.`;
const proof=()=>[`Program ${ATA} invoke [1]`,`Program ${TOKEN_2022_PROGRAM_ID} invoke [2]`,`Program ${TOKEN_2022_PROGRAM_ID} success`,`Program ${SYSTEM} invoke [2]`,'Transfer: insufficient lamports 865280, need 1559560',`Program ${SYSTEM} failed: custom program error: 0x1`,`Program ${ATA} failed: custom program error: 0x1`];
function simulation(){const payer=key(),feePayer=key(),owner=key(),mint=key(),ata=getAssociatedTokenAddressSync(mint,owner,false,TOKEN_2022_PROGRAM_ID),instruction=createAssociatedTokenAccountIdempotentInstruction(payer,ata,owner,mint,TOKEN_2022_PROGRAM_ID);const tx=new VersionedTransaction(new TransactionMessage({payerKey:feePayer,recentBlockhash:key().toBase58(),instructions:[instruction]}).compileToV0Message());return {payer,feePayer,instruction,tx,result:{err:{InstructionError:[0,{Custom:1}]},logs:proof()}};}
function fixture(){
 const l=activeRewardsFixture({id:'a'.repeat(32),keys:{...newLaunchKeys(),payer:newLaunchKeys().wallet},feeCustody:'relay',input:{network:'mainnet-beta',route:'raydium',feeMode:'holders',taxBps:200,quoteMint:'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB'},review:{quoteProgram:TOKEN_2022_PROGRAM_ID.toBase58(),quoteDecimals:8},credits:{quote:'600',base:'87000000000000'},operations:[{state:'confirmed',kind:'payout',slot:200}],cycle:{stage:'payout',index:1,payouts:[{owner:key().toBase58(),amount:'999'},...['100','200','300'].map(amount=>({owner:key().toBase58(),amount}))]},error:savedError(4)},1);
 l.review.quoteProgram=TOKEN_2022_PROGRAM_ID.toBase58();const seen=[];let result={context:{slot:201},value:{err:null}},metadata={program:TOKEN_2022_PROGRAM_ID,decimals:8};
 const c=new LaunchChain({network:'mainnet-beta',connection:{getLatestBlockhash:async()=>({blockhash:key().toBase58(),lastValidBlockHeight:500}),getBlockHeight:async()=>300,simulateTransaction:async(tx,config)=>{seen.push({tx,config});return structuredClone(result);}}});
 c.mintInfo=async mint=>({key:new PublicKey(mint),program:metadata.program,mint:{decimals:metadata.decimals,isInitialized:true}});c.sleep=async()=>{};c.prepare=async()=>{throw Error('Read-only recovery must not prepare or sign');};c.broadcast=async()=>{throw Error('Read-only recovery must not broadcast');};
 return {l,c,seen,setResult(value){result=value;},setMetadata(value){metadata=value;}};
}
test('proven nested System rent shortfall identifies ATA funding wallet rather than transaction payer',()=>{
 const h=simulation(),failure=ataFundingSimulationFailure(h.tx,h.result);assert.equal(failure.fundingWallet,h.payer.toBase58());assert.equal(failure.fundingShortfallLamports,'694280');const error=launchSimulationError(h.tx,h.result,false);assert.equal(error.code,'REWARD_NATIVE_FUNDS');assert.equal(error.fundingWallet,h.payer.toBase58());assert.notEqual(error.fundingWallet,h.feePayer.toBase58());assert.match(error.message,/0\.00069428 SOL/);
});
test('ATA custom1 without exact System callstack, actual shortfall, matching PDA and signer stays unclassified',()=>{
 for(const change of [
  h=>{h.result.logs=[];},h=>{h.result.logs=h.result.logs.slice(1);},h=>{h.result.logs.pop();},
  h=>{h.result.logs=h.result.logs.map(line=>line.replaceAll(SYSTEM,TOKEN_PROGRAM_ID.toBase58()));},
  h=>{h.result.logs=h.result.logs.map(line=>line.startsWith('Transfer:')?'Program log: '+line:line);},
  h=>{h.result.logs=h.result.logs.map(line=>line.replace('need 1559560','need 100'));},
  h=>{h.result.logs=h.result.logs.map(line=>line.includes(`${SYSTEM} failed`)?line.replace('0x1','0x2'):line);},
  h=>{const ix=h.tx.message.compiledInstructions[0];h.tx.message.staticAccountKeys[ix.accountKeyIndexes[1]]=key();},
  h=>{const ix=h.tx.message.compiledInstructions[0];h.tx.message.staticAccountKeys[ix.accountKeyIndexes[2]]=key();},
  h=>{const ix=h.tx.message.compiledInstructions[0];h.tx.message.staticAccountKeys[ix.accountKeyIndexes[4]]=key();},
  h=>{const ix=h.tx.message.compiledInstructions[0];h.tx.message.staticAccountKeys[ix.accountKeyIndexes[5]]=key();},
  h=>{h.tx.message.header.numRequiredSignatures=0;},
  h=>{h.result.logs=[`Program ${ATA} invoke [1]`,`Program ${SYSTEM} invoke [2]`,'Transfer: insufficient lamports 1, need 2',`Program ${SYSTEM} success`,`Program ${SYSTEM} invoke [2]`,`Program ${SYSTEM} failed: custom program error: 0x1`,`Program ${ATA} failed: custom program error: 0x1`];},
 ]){const h=simulation();change(h);assert.equal(ataFundingSimulationFailure(h.tx,h.result),null);assert.equal(launchSimulationError(h.tx,h.result,false).code,undefined);}
});
test('saved ATA matcher accepts only exact failure index and an unchanged affordable remaining SPL payout batch',()=>{
 const h=fixture(),matched=savedAtaPayoutFailure(h.l);assert.equal(matched.instructionIndex,4);assert.equal(matched.rowIndex,1);assert.deepEqual(matched.payouts.map(row=>row.amount),['100','200','300']);
 for(const change of [l=>{l.error=savedError(3);},l=>{l.error=savedError(4).replace('[4,','[2,');},l=>{l.error+=' Extra';},l=>{l.cycle.stage='route';},l=>{l.cycle.index=3;},l=>{l.credits.quote='599';},l=>{l.cycle.payouts[2].amount='01';},l=>{l.cycle.payouts[2].owner=l.cycle.payouts[1].owner;},l=>{l.input.quoteMint='So11111111111111111111111111111111111111112';}]){const l=structuredClone(h.l);change(l);assert.equal(savedAtaPayoutFailure(l),null);}
});
test('TSLAx recovery simulates exact unpaid eight-decimal batch unsigned at confirmed receipt fence and never mutates launch',async()=>{
 const h=fixture(),before=structuredClone(h.l);assert.deepEqual(await h.c.revalidateRewardInventory(h.l,{error:h.l.error}),{slot:201});assert.deepEqual(h.l,before);assert.equal(h.seen.length,1);const {tx,config}=h.seen[0];assert.deepEqual(config,{sigVerify:false,commitment:'finalized',minContextSlot:200});assert(tx.signatures.every(signature=>signature.every(byte=>byte===0)));assert.equal(tx.message.staticAccountKeys[0].toBase58(),h.l.keys.rewards.address);assert.equal(tx.message.compiledInstructions.length,8);
 for(let n=0;n<3;n++){const ata=tx.message.compiledInstructions[2+n*2],transfer=tx.message.compiledInstructions[3+n*2];assert.equal(tx.message.staticAccountKeys[ata.programIdIndex].toBase58(),ATA);assert.equal(Buffer.from(transfer.data).readBigUInt64LE(1),BigInt([100,200,300][n]));assert.equal(transfer.data[9],8);}
});
test('failed, absent or stale simulations and changed quote metadata cannot clear a saved ATA failure',async()=>{
 for(const mode of ['failed','missing','stale','no-value','decimals','program','pending']){
  const h=fixture();if(mode==='failed')h.setResult({context:{slot:201},value:{err:{InstructionError:[4,{Custom:1}]},logs:proof()}});if(mode==='missing')h.setResult({context:{},value:{err:null}});if(mode==='stale')h.setResult({context:{slot:199},value:{err:null}});if(mode==='no-value')h.setResult({context:{slot:201}});if(mode==='decimals')h.setMetadata({program:TOKEN_2022_PROGRAM_ID,decimals:6});if(mode==='program')h.setMetadata({program:TOKEN_PROGRAM_ID,decimals:8});if(mode==='pending')h.l.operations.push({kind:'payout',state:'pending'});const before=structuredClone(h.l);await assert.rejects(h.c.revalidateRewardInventory(h.l,{error:h.l.error}));assert.deepEqual(h.l,before,mode);assert(h.seen.every(({tx})=>tx.signatures.every(signature=>signature.every(byte=>byte===0))));
 }
});
