import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey,Keypair,TransactionMessage,ComputeBudgetProgram,SystemProgram} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync,createBurnCheckedInstruction,createTransferCheckedInstruction} from '@solana/spl-token';
import bs58 from 'bs58';
import {taxBurnReceipt,validateTaxBurnInstructions} from '../src/launchpad-receipts.mjs';
import {TAX_BURN_MINT,TAX_BURN_WALLET,TAX_BURN_POLICY,TAX_BURN_INITIAL_AMOUNT,TAX_BURN_INITIAL_POLICY,TAX_BURN_INITIAL_LEGACY_AMOUNT,TAX_BURN_INITIAL_LEGACY_POLICY,TAX_BURN_INITIAL_PREVIOUS_AMOUNT,TAX_BURN_INITIAL_PREVIOUS_POLICY,rewardsWalletSelection,requireTaxBurnWallet} from '../src/launchpad-rewards-wallet.mjs';
import {LaunchChain} from '../src/launchpad-chain.mjs';
import {SOL_MINT,USDC_MINT} from '../public/launchpad-model.mjs';

const pk=value=>new PublicKey(value),random=()=>Keypair.generate().publicKey.toBase58();
function fixture(){
  const launch={keys:{mint:{address:TAX_BURN_MINT},wallet:{address:random()},rewards:{address:TAX_BURN_WALLET}},input:{network:'mainnet-beta',route:'raydium',feeMode:'holders',quoteMint:SOL_MINT,taxBps:200},rewardsWallet:{version:1,status:'active',address:TAX_BURN_WALLET},review:{quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:9}};
  const operation={kind:'tax-burn',amount:'10',taxBurnPolicy:TAX_BURN_POLICY,taxSource:'withheld-tax',signature:bs58.encode(Buffer.alloc(64,7)),rewardsWallet:{version:1,source:'rewards',signerSource:'rewards',address:TAX_BURN_WALLET}};
  const ata=getAssociatedTokenAddressSync(pk(TAX_BURN_MINT),pk(TAX_BURN_WALLET),false,TOKEN_2022_PROGRAM_ID);
  const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:200000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}),createBurnCheckedInstruction(ata,pk(TAX_BURN_MINT),pk(TAX_BURN_WALLET),10n,6,[],TOKEN_2022_PROGRAM_ID)];
  const message=new TransactionMessage({payerKey:pk(TAX_BURN_WALLET),recentBlockhash:random(),instructions}).compileToV0Message();
  const index=message.staticAccountKeys.findIndex(key=>key.equals(ata)),balance=amount=>({accountIndex:index,mint:TAX_BURN_MINT,owner:TAX_BURN_WALLET,programId:TOKEN_2022_PROGRAM_ID.toBase58(),uiTokenAmount:{amount,decimals:6}});
  const tx={slot:123,transaction:{signatures:[operation.signature],message},meta:{err:null,fee:7000,preBalances:message.staticAccountKeys.map((_,i)=>i===0?10000000:2039280),postBalances:message.staticAccountKeys.map((_,i)=>i===0?9993000:2039280),preTokenBalances:[balance('123456')],postTokenBalances:[balance('123446')],loadedAddresses:{writable:[],readonly:[]},innerInstructions:[]}};
  return {launch,operation,ata,instructions,tx};
}

test('an exact finalized LAUNCHPAD tax burn proves token destruction and only charges its network fee',()=>{
  const {launch,operation,instructions,tx,ata}=fixture();
  assert.deepEqual(validateTaxBurnInstructions(launch,operation,instructions),{amount:10n,ata:ata.toBase58()});
  assert.deepEqual(taxBurnReceipt(tx,launch,operation),{base:-10n,quote:0n,burnedBase:10n,networkFee:7000n,gasAndRent:7000n});
  assert.deepEqual(validateTaxBurnInstructions(launch,operation,[instructions[2]]),{amount:10n,ata:ata.toBase58()});
});

test('receipt recovery remains possible after disabling policy, removing keys or exporting custody; new signing stays blocked',()=>{
  const {launch,operation,tx}=fixture();
  launch.taxBurn={enabled:false};launch.rewardsWallet.status='paused';launch.keys.rewards.exportedAt=1;
  assert.equal(taxBurnReceipt(tx,launch,operation).burnedBase,10n);
  delete launch.keys.rewards;
  assert.equal(taxBurnReceipt(tx,launch,operation).burnedBase,10n);
  assert.throws(()=>requireTaxBurnWallet(launch),/wallet is unavailable/);
  assert.throws(()=>rewardsWalletSelection(launch,{operation}),/wallet is unavailable/);
});

test('official mint, launch type, quote asset and saved wallet cannot be redirected',()=>{
  const changes=[
    h=>{h.launch.keys.mint.address=random();},h=>{h.launch.input.network='devnet';},h=>{h.launch.input.route='pump';},h=>{h.launch.input.feeMode='creator';},h=>{h.launch.input.taxBps=0;},h=>{h.launch.input.quoteMint=USDC_MINT;},
    h=>{h.launch.keys.rewards.address=random();},h=>{h.launch.rewardsWallet.address=random();},
    h=>{delete h.operation.rewardsWallet;},h=>{h.operation.rewardsWallet.source='wallet';h.operation.rewardsWallet.signerSource='wallet';h.operation.rewardsWallet.address=h.launch.keys.wallet.address;},
    h=>{h.operation.rewardsWallet.signerSource='wallet';},h=>{h.operation.rewardsWallet.address=random();},
    h=>{h.operation.kind='burn';},h=>{h.operation.taxSource='unattributed';},h=>{h.operation.taxBurnPolicy='other-policy';}
  ];
  for(const change of changes){const h=fixture();change(h);assert.throws(()=>taxBurnReceipt(h.tx,h.launch,h.operation));}
});

test('tax burns require positive exact raw u64 amounts, never estimates or current wallet balance sweeps',()=>{
  for(const amount of ['0','-1','1.5','1e1','01','18446744073709551616',10,null,undefined,'11']){
    const h=fixture();h.operation.amount=amount;assert.throws(()=>validateTaxBurnInstructions(h.launch,h.operation,h.instructions));
  }
});

test('transfers, swaps, unchecked burns, extra burns and altered burn accounts are rejected even if a token debit matches',()=>{
  const changes=[
    h=>{h.instructions[2]=createTransferCheckedInstruction(h.ata,pk(TAX_BURN_MINT),pk(random()),pk(TAX_BURN_WALLET),10n,6,[],TOKEN_2022_PROGRAM_ID);},
    h=>{h.instructions[2].data[0]=8;},h=>{h.instructions[2].data[9]=9;},h=>{h.instructions[2].data.writeBigUInt64LE(11n,1);},h=>{h.instructions[2].programId=TOKEN_PROGRAM_ID;},
    h=>{h.instructions[2].keys[0].pubkey=pk(random());},h=>{h.instructions[2].keys[1].pubkey=pk(random());},h=>{h.instructions[2].keys[2].pubkey=pk(random());},
    h=>{h.instructions[2].keys[0].isWritable=false;},h=>{h.instructions[2].keys[1].isWritable=false;},h=>{h.instructions[2].keys[2].isSigner=false;},
    h=>{h.instructions=[h.instructions[2],h.instructions[2]];},
    h=>{h.instructions=[h.instructions[2],SystemProgram.transfer({fromPubkey:pk(TAX_BURN_WALLET),toPubkey:pk(random()),lamports:1})];},
    h=>{h.instructions[0]=ComputeBudgetProgram.setComputeUnitLimit({units:1400001});},h=>{h.instructions[1]=ComputeBudgetProgram.setComputeUnitPrice({microLamports:10001});},
    h=>{h.instructions[0]=h.instructions[1];},h=>{h.instructions[0]=ComputeBudgetProgram.requestHeapFrame({bytes:32768});}
  ];
  for(const change of changes){const h=fixture();change(h);assert.throws(()=>validateTaxBurnInstructions(h.launch,h.operation,h.instructions));}
});

test('receipt validation rejects forged token evidence, additional SOL movement, hidden programs and unfinalized failures',()=>{
  const changes=[
    h=>{h.tx.meta.err={InstructionError:[2,{Custom:1}]};},h=>{h.tx.confirmationStatus='confirmed';},h=>{delete h.tx.slot;},h=>{h.tx.transaction.signatures[0]='different';},h=>{h.tx.transaction.signatures.push('extra');},
    h=>{h.tx.transaction.message.staticAccountKeys[0]=pk(random());},h=>{h.tx.transaction.message.header.numRequiredSignatures=2;},h=>{h.tx.transaction.message.header.numReadonlySignedAccounts=1;},
    h=>{h.tx.transaction.message.compiledInstructions[2].data[0]=12;},h=>{h.tx.transaction.message.compiledInstructions[2].data[9]=9;},h=>{h.tx.transaction.message.compiledInstructions[2].accountKeyIndexes[0]=0;},
    h=>{h.tx.meta.postTokenBalances[0].uiTokenAmount.amount='123445';},h=>{h.tx.meta.postTokenBalances[0].uiTokenAmount.decimals=9;},h=>{h.tx.meta.preTokenBalances[0].owner=random();},h=>{h.tx.meta.preTokenBalances[0].programId=TOKEN_PROGRAM_ID.toBase58();},
    h=>{h.tx.meta.postTokenBalances=[];},h=>{h.tx.meta.preTokenBalances.push({...h.tx.meta.preTokenBalances[0]});},h=>{h.tx.meta.postTokenBalances.push({...h.tx.meta.postTokenBalances[0],mint:SOL_MINT});},
    h=>{h.tx.meta.postBalances[0]--;},h=>{h.tx.meta.postBalances[1]++;},h=>{h.tx.meta.fee=-1;},
    h=>{h.tx.meta.loadedAddresses.writable.push(pk(random()));},h=>{h.tx.transaction.message.addressTableLookups.push({accountKey:pk(random()),writableIndexes:[0],readonlyIndexes:[]});},
    h=>{h.tx.meta.innerInstructions=[{index:2,instructions:[{programIdIndex:0,accounts:[],data:'1'}]}];}
  ];
  for(const change of changes){const h=fixture();change(h);assert.throws(()=>taxBurnReceipt(h.tx,h.launch,h.operation));}
});

test('legacy raw transaction instruction encoding also verifies exact burn evidence',()=>{
  const h=fixture(),message=h.tx.transaction.message;
  h.tx.transaction.message={header:message.header,accountKeys:message.staticAccountKeys,instructions:message.compiledInstructions.map(ix=>({programIdIndex:ix.programIdIndex,accounts:ix.accountKeyIndexes,data:bs58.encode(ix.data)}))};
  assert.equal(taxBurnReceipt(h.tx,h.launch,h.operation).burnedBase,10n);
});

test('preparation rejects an altered operation before reading signer secrets or making RPC requests',async()=>{
  let calls=0;
  const c=new LaunchChain({network:'mainnet-beta',connection:{getLatestBlockhash:async()=>{calls++;throw Error('Unexpected RPC call');}}});
  const h=fixture();h.instructions[2].data[0]=12;
  await assert.rejects(c.prepare(h.launch,h.instructions,[],false,{operation:h.operation}),/checked-burn/);
  assert.equal(calls,0);
  const good=fixture();
  await assert.rejects(c.prepare(good.launch,good.instructions,[],false,{operation:good.operation}),/wallet is unavailable/);
  await assert.rejects(c.prepare(good.launch,good.instructions,[Keypair.generate()],false,{operation:good.operation}),/other signers/);
  await assert.rejects(c.burnInstructions(good.launch,'11',{operation:good.operation,kind:'tax-burn'}),/saved operation amount/);
  assert.equal(calls,0);
});


function initialFixture(amount=TAX_BURN_INITIAL_AMOUNT,policy=TAX_BURN_INITIAL_POLICY){
  const h=fixture();
  Object.assign(h.operation,{amount,taxSource:'approved-initial-inventory',initialBurnPolicy:policy,initialTaxBase:'60000000000000',initialLegacyBase:(BigInt(amount)-60000000000000n).toString()});
  h.instructions[2].data.writeBigUInt64LE(BigInt(amount),1);
  h.tx.transaction.message.compiledInstructions[2].data=h.instructions[2].data;
  h.tx.meta.preTokenBalances[0].uiTokenAmount.amount='80000000000000';
  h.tx.meta.postTokenBalances[0].uiTokenAmount.amount=(80000000000000n-BigInt(amount)).toString();
  return h;
}

test('the separately approved initial inventory burns exactly its pinned amount and tracked allocation',()=>{
  const h=initialFixture();
  assert.equal(validateTaxBurnInstructions(h.launch,h.operation,h.instructions).amount,50000000000000n);
  assert.equal(taxBurnReceipt(h.tx,h.launch,h.operation).burnedBase,50000000000000n);
  // The source account may contain later accruals; only the approved amount is
  // destroyed. Receipt accounting does not sweep the remaining tokens.
  assert.equal(h.tx.meta.postTokenBalances[0].uiTokenAmount.amount,'2050200000000');
  const changes=[
    h=>{h.operation.amount='50000000000001';},h=>{h.operation.initialBurnPolicy='other';},h=>{delete h.operation.initialTaxBase;},h=>{h.operation.initialLegacyBase='0';},h=>{h.operation.initialTaxBase='-1';},h=>{h.operation.initialTaxBase='01';}
  ];
  for(const change of changes){const changed=initialFixture();change(changed);assert.throws(()=>taxBurnReceipt(changed.tx,changed.launch,changed.operation));}
});

test('previously saved v1 burn receipts remain exact and cannot use the revised v3 amount',()=>{
  const h=initialFixture(TAX_BURN_INITIAL_LEGACY_AMOUNT,TAX_BURN_INITIAL_LEGACY_POLICY);
  assert.equal(taxBurnReceipt(h.tx,h.launch,h.operation).burnedBase,41234567890123n);
  for(const [amount,policy] of [[TAX_BURN_INITIAL_AMOUNT,TAX_BURN_INITIAL_LEGACY_POLICY],[TAX_BURN_INITIAL_LEGACY_AMOUNT,TAX_BURN_INITIAL_POLICY]]){
    const crossed=initialFixture(amount,policy);
    assert.throws(()=>taxBurnReceipt(crossed.tx,crossed.launch,crossed.operation),/exact approved inventory/);
  }
});

test('initial inventory signing requires its own finalized balance checkpoint before accessing custody',async()=>{
  const h=initialFixture();let calls=0;
  const c=new LaunchChain({network:'mainnet-beta',connection:{getLatestBlockhash:async()=>{calls++;throw Error('Unexpected RPC call');}}});
  await assert.rejects(c.prepare(h.launch,h.instructions,[],false,{operation:h.operation}),/finalized inventory snapshot/);
  h.instructions.taxBurnBalanceSlot=123;
  await assert.rejects(c.prepare(h.launch,h.instructions,[],false,{operation:h.operation}),/wallet is unavailable/);
  assert.equal(calls,0);
});


test('all historical authorization policies accept only their own exact amount',()=>{
  const approvals=[[TAX_BURN_INITIAL_LEGACY_POLICY,TAX_BURN_INITIAL_LEGACY_AMOUNT],[TAX_BURN_INITIAL_PREVIOUS_POLICY,TAX_BURN_INITIAL_PREVIOUS_AMOUNT],[TAX_BURN_INITIAL_POLICY,TAX_BURN_INITIAL_AMOUNT]];
  for(const [policy,approved] of approvals)for(const [,amount] of approvals){
    const h=initialFixture(amount,policy);
    if(amount===approved)assert.equal(taxBurnReceipt(h.tx,h.launch,h.operation).burnedBase,BigInt(approved));
    else assert.throws(()=>taxBurnReceipt(h.tx,h.launch,h.operation),/exact approved inventory/);
  }
});
