import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {Keypair,PublicKey,SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {NATIVE_MINT,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {ProtocolTreasuryChain} from '../src/protocol-treasury-chain.mjs';

const SOL=NATIVE_MINT.toBase58(),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const native=lamports=>({owner:SystemProgram.programId,data:Buffer.alloc(0),lamports:Number(lamports),executable:false});
const wire=value=>value===null?null:{...value,owner:String(value.owner),data:[value.data.toString('base64'),'base64']};
function fixture({missingRecipient=false}={}) {
  const signer=Keypair.generate(),target=Keypair.generate().publicKey,blockhash=Keypair.generate().publicKey.toBase58();
  const wallet={address:String(signer.publicKey),secret:bs58.encode(signer.secretKey)},recipient=String(target);
  const h={signer,wallet,target,recipient,blockhash,source:native(100000000),destination:missingRecipient?null:native(1000000),amount:2000000n,fee:5000,slot:1000,simSlot:1001,reads:[],simulations:[],sent:[],finalReceipt:null,status:null};
  const account=key=>String(key)===wallet.address?h.source:String(key)===recipient?h.destination:null;
  const connection={
    getMultipleAccountsInfoAndContext:async(keys,options)=>{h.reads.push({keys:keys.map(String),options});return{context:{slot:h.slot},value:keys.map(account)};},
    getLatestBlockhash:async()=>({blockhash,lastValidBlockHeight:1200}),
    getFeeForMessage:async()=>({context:{slot:1000},value:h.fee}),
    simulateTransaction:async(tx,options)=>{
      assert(tx.signatures.every(value=>value.every(byte=>byte===0)),'Simulation occurs before signing');h.simulations.push({tx,options});
      const accounts=[wire(native(h.source.lamports-Number(h.amount)-h.fee)),wire(native((h.destination?.lamports||0)+Number(h.amount)))];
      if(h.changeSimulation)h.changeSimulation(accounts);
      return{context:{slot:h.simSlot},value:{err:h.simError||null,accounts}};
    },
    sendRawTransaction:async(bytes,options)=>{h.sent.push({bytes:Buffer.from(bytes),options});return bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]);},
    getSignatureStatuses:async()=>({context:{slot:1500},value:[h.status]}),
    getTransaction:async()=>h.finalReceipt,
    getBlockHeight:async()=>1300,
    getEpochInfo:async()=>({blockHeight:1300,absoluteSlot:1500}),
    getFirstAvailableBlock:async()=>1,
    isBlockhashValid:async()=>({context:{slot:1500},value:false}),
  };
  h.chain=new ProtocolTreasuryChain({connection,now:()=>2000,sleep:async()=>{},routes:{quoteConversion:()=>assert.fail('Gas refills cannot swap tokens'),buildConversion:()=>assert.fail('Gas refills cannot use routed instructions')}});
  h.prepare=(extra={})=>h.chain.prepare({kind:'gas-refill',wallet,mint:SOL,recipient,amount:h.amount.toString(),minSolReserve:'10000000',maxNetworkCostLamports:'5000000',...extra});
  h.receipt=(op,{failed=false}={})=>{
    const signed=VersionedTransaction.deserialize(Buffer.from(op.raw,'base64')),keys=signed.message.staticAccountKeys.map(String),pre=keys.map(address=>account(address)?.lamports??1),post=[...pre];
    post[keys.indexOf(wallet.address)]-=h.fee+(failed?0:Number(h.amount));if(!failed)post[keys.indexOf(recipient)]+=Number(h.amount);
    h.finalReceipt={slot:1002,transaction:{signatures:[op.signature],message:signed.message},meta:{err:failed?{InstructionError:[0,{Custom:1}]}:null,fee:h.fee,preBalances:pre,postBalances:post,preTokenBalances:[],postTokenBalances:[],innerInstructions:[],loadedAddresses:{writable:[],readonly:[]}}};return h.finalReceipt;
  };
  return h;
}

test('gas balances use one finalized bounded account batch and return exact requested order including unfunded wallets',async()=>{
  const h=fixture(),empty=String(Keypair.generate().publicKey),addresses=[h.wallet.address,h.recipient,empty];
  assert.deepEqual(await h.chain.gasBalances(addresses),{slot:1000,balances:[{address:h.wallet.address,lamports:'100000000'},{address:h.recipient,lamports:'1000000'},{address:empty,lamports:'0'}]});
  assert.deepEqual(h.reads,[{keys:addresses,options:{commitment:'finalized'}}]);assert.equal(h.sent.length,0);assert.equal(h.simulations.length,0);
});

test('gas balance reads reject invalid addresses, unsafe native accounts and incomplete finalized snapshots',async()=>{
  const h=fixture(),pda=String(PublicKey.findProgramAddressSync([Buffer.from('gas-target')],TOKEN_PROGRAM_ID)[0]);
  for(const addresses of [[],[h.wallet.address,h.wallet.address],[pda],['bad'],[h.target],Array.from({length:101},()=>String(Keypair.generate().publicKey))])await assert.rejects(h.chain.gasBalances(addresses));
  assert.equal(h.reads.length,0);
  for(const mutate of [value=>{value.owner=TOKEN_PROGRAM_ID;},value=>{value.data=Buffer.from([1]);},value=>{value.executable=true;},value=>{delete value.executable;},value=>{value.lamports=-1;},value=>{value.lamports=Number.MAX_SAFE_INTEGER+1;},value=>{value.lamports=1.1;}]){
    h.destination=native(1000000);mutate(h.destination);await assert.rejects(h.chain.gasBalances([h.wallet.address,h.recipient]));
  }
  for(const result of [{context:{slot:0},value:[native(1)]},{context:{slot:1000},value:[]},{context:{slot:1000},value:[undefined]},{context:{slot:1000},value:[native(1),native(1)]}]){
    h.chain.c.getMultipleAccountsInfoAndContext=async()=>result;await assert.rejects(h.chain.gasBalances([h.wallet.address]));
  }
});

test('gas refill signs one exact native transfer only after both simulated balances and reserve are verified',async()=>{
  const h=fixture(),op=await h.prepare(),signed=VersionedTransaction.deserialize(Buffer.from(op.raw,'base64'));
  assert.equal(op.kind,'gas-refill');assert.equal(op.mint,SOL);assert.equal(op.recipient,h.recipient);assert.equal(op.inputAmount,'2000000');assert.equal(op.accounting.minSolReserve,'10000000');assert.equal(op.accounting.networkFeeLamports,'5000');assert.equal(h.sent.length,0);
  assert.equal(signed.message.compiledInstructions.length,1);const instruction=signed.message.compiledInstructions[0];assert.equal(Buffer.from(instruction.data).readBigUInt64LE(4),2000000n);assert(signed.message.staticAccountKeys[instruction.programIdIndex].equals(SystemProgram.programId));
  assert.deepEqual(h.simulations[0].options,{sigVerify:false,commitment:'finalized',minContextSlot:1000,accounts:{encoding:'base64',addresses:[h.wallet.address,h.recipient]}});
  assert(!JSON.stringify(op).includes(h.wallet.secret));
  await h.chain.broadcast(op);assert.deepEqual(h.sent[0].bytes,Buffer.from(op.raw,'base64'));assert.deepEqual(h.sent[0].options,{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:1001});
  h.receipt(op);const result=await h.chain.receipt(op);assert.equal(result.state,'confirmed');assert.equal(result.recipient,h.recipient);assert.equal(result.mint,SOL);assert.equal(result.inputAmount,'2000000');assert.equal(result.solDelta,'-2005000');assert.equal(result.actualSolCostLamports,'5000');
});

test('an unfunded on-curve native destination can receive a verified gas refill',async()=>{
  const h=fixture({missingRecipient:true});const op=await h.prepare();assert.equal(op.recipient,h.recipient);assert.equal(h.simulations.length,1);assert.equal(h.sent.length,0);
});

test('fresh preparation rejects a recipient funded since discovery or a changed balance that would exceed the target',async()=>{
  for(const [balance,amount] of [[5000000,15000000n],[20000000,1000000n],[4000000,17000000n]]){
    const h=fixture();h.destination=native(balance);h.amount=amount;await assert.rejects(h.prepare(),/already funded or its balance changed/);assert.equal(h.simulations.length,0);assert.equal(h.sent.length,0);
  }
  const h=fixture();h.destination=native(4000000);h.amount=16000000n;assert.equal((await h.prepare()).inputAmount,'16000000');
});

test('gas preparation rejects unsafe destinations, incorrect signer and unsupported source budgets',async()=>{
  for(const mutate of [h=>{h.destination={...native(1000),owner:TOKEN_PROGRAM_ID};},h=>{h.destination={...native(1000),data:Buffer.from([1])};},h=>{h.destination={...native(1000),executable:true};},h=>{h.destination=undefined;},h=>{h.source=null;}]){
    const h=fixture();mutate(h);await assert.rejects(h.prepare());assert.equal(h.sent.length,0);assert.equal(h.simulations.length,0);
  }
  for(const extra of [{amount:'0'},{amount:'9007199254740992'},{amount:'-1'},{mint:String(Keypair.generate().publicKey)},{minSolReserve:'9999999'},{maxNetworkCostLamports:'4999'},{maxNetworkCostLamports:'15000001'}]){
    const h=fixture();await assert.rejects(h.prepare(extra));assert.equal(h.sent.length,0);
  }
  const h=fixture();await assert.rejects(h.prepare({recipient:h.wallet.address}));await assert.rejects(h.prepare({wallet:{...h.wallet,secret:bs58.encode(Keypair.generate().secretKey)}}),/signer does not match/);
  for(const fee of [0,20001]){const h=fixture();h.fee=fee;await assert.rejects(h.prepare(),/network fee/);assert.equal(h.simulations.length,0);}
});

test('gas simulation rejects changed amount, source debit, ownership, encoding, stale slot and reserve loss',async()=>{
  for(const change of [
    accounts=>accounts[0].lamports++,accounts=>accounts[1].lamports++,accounts=>accounts[1].lamports--,
    accounts=>{accounts[1].owner=String(TOKEN_PROGRAM_ID);},accounts=>{accounts[1].data=['AQ==','base64'];},accounts=>{accounts[1].data=['!!!','base64'];},accounts=>{accounts[1].executable=true;},accounts=>{accounts[1]=null;},
  ]){const h=fixture();h.changeSimulation=change;await assert.rejects(h.prepare());assert.equal(h.sent.length,0);}
  const low=fixture();low.source=native(12000000);await assert.rejects(low.prepare(),/protected reserve/);
  const stale=fixture();stale.simSlot=999;await assert.rejects(stale.prepare());assert.equal(stale.sent.length,0);
  const failed=fixture();failed.simError={InstructionError:[0,1]};await assert.rejects(failed.prepare(),/simulation failed/);
});

test('gas refill metadata must match the signed native instruction before broadcasting',async()=>{
  const h=fixture(),op=await h.prepare();
  for(const change of [{recipient:String(Keypair.generate().publicKey)},{inputAmount:'2000001'},{mint:String(Keypair.generate().publicKey)},{minimumOutput:'1'},{raw:op.raw+'A'},{rawHash:'f'.repeat(64)},{signature:bs58.encode(Buffer.alloc(64))},{blockhash:String(Keypair.generate().publicKey)},{wallet:String(Keypair.generate().publicKey)},{accounting:{...op.accounting,minSolReserve:'0'}},{accounting:{...op.accounting,networkFeeLamports:'20001'}},{accounting:{...op.accounting,monitoredAccounts:[h.recipient]}}])await assert.rejects(h.chain.broadcast({...op,...change}));
  // Even a newly valid signature/hash cannot hide extra native transfers.
  const message=new TransactionMessage({payerKey:h.signer.publicKey,recentBlockhash:op.blockhash,instructions:[SystemProgram.transfer({fromPubkey:h.signer.publicKey,toPubkey:h.target,lamports:Number(h.amount)}),SystemProgram.transfer({fromPubkey:h.signer.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1})]}).compileToV0Message(),tx=new VersionedTransaction(message);tx.sign([h.signer]);const bytes=Buffer.from(tx.serialize());
  await assert.rejects(h.chain.broadcast({...op,raw:bytes.toString('base64'),rawHash:digest(bytes),signature:bs58.encode(tx.signatures[0])}),/authorized native transfer/);assert.equal(h.sent.length,0);
});

test('finalized gas receipts require exact native movements and reject changes to unrelated balances or tokens',async()=>{
  for(const mutate of [
    receipt=>receipt.meta.postBalances[0]++,receipt=>receipt.meta.postBalances[1]++,receipt=>receipt.meta.postBalances[2]++,
    receipt=>{receipt.meta.preTokenBalances=[{accountIndex:1}];},receipt=>{receipt.meta.postTokenBalances=[{accountIndex:1}];},receipt=>{receipt.meta.innerInstructions=[{index:0,instructions:[]}];},
    receipt=>{receipt.meta.fee=20001;receipt.meta.postBalances[0]-=15001;},receipt=>{receipt.transaction.message.recentBlockhash=String(Keypair.generate().publicKey);},
  ]){
    const h=fixture(),op=await h.prepare(),receipt=h.receipt(op);mutate(receipt);await assert.rejects(h.chain.receipt(op));
  }
  const h=fixture(),op=await h.prepare();h.receipt(op);await assert.rejects(h.chain.receipt(op,String(Keypair.generate().publicKey)),/another wallet/);
});

test('failed gas receipts debit only the fee and leave every recipient balance unchanged',async()=>{
  const h=fixture(),op=await h.prepare();h.receipt(op,{failed:true});const result=await h.chain.receipt(op);assert.equal(result.state,'failed');assert.equal(result.actualSolCostLamports,'5000');assert.equal(result.solDelta,'-5000');assert.equal(result.recipient,h.recipient);
  for(const index of [0,1,2]){const receipt=h.receipt(op,{failed:true});receipt.meta.postBalances[index]--;await assert.rejects(h.chain.receipt(op));}
  const receipt=h.receipt(op,{failed:true});receipt.meta.preBalances[0]=10000001;receipt.meta.postBalances[0]=9995001;const belowReserve=await h.chain.receipt(op);assert.equal(belowReserve.state,'failed');assert.equal(belowReserve.actualSolCostLamports,'5000');
});

test('gas refills retain saved-signature finality and expiry checks without replacement broadcasts',async()=>{
  const h=fixture(),op=await h.prepare();assert.equal(await h.chain.receipt(op),null);
  h.receipt(op);h.status={confirmationStatus:'confirmed',slot:1002};assert.equal(await h.chain.receipt(op),null);assert.equal((await h.chain.state(op)).state,'pending');
  h.status={confirmationStatus:'finalized',slot:1002};assert.equal((await h.chain.receipt(op)).state,'confirmed');
  const fresh=fixture(),unseen=await fresh.prepare();assert.equal((await fresh.chain.state(unseen)).state,'expired');fresh.chain.c.getFirstAvailableBlock=async()=>1002;assert.equal((await fresh.chain.state(unseen)).state,'unknown');
  assert.equal(h.sent.length,0);assert.equal(fresh.sent.length,0);
});
