/** Unsigned owner deployment of the isolated future public fee launch program.
 * All chain access is read-only. This module has no signing or send method.
 * Buffer creation/authority binding and program creation/deployment are atomic.
 */
import { createHash } from 'node:crypto';
import {
  PublicKey, SystemProgram, TransactionInstruction, ComputeBudgetProgram,
  TransactionMessage, VersionedTransaction, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY,
} from '@solana/web3.js';

export const DAMM_PUMP_FEE_DEPLOYMENT_POLICY = Object.freeze({
  operator: '7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',
  treasury: 'HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF',
  binarySha256: '0e0337bdc95d5a77175f317766ccee9ce5a4f35a0e2ec594239266f012a729dd',
  binaryLength: 229376,
  programSeed: 'launchpad-program-3',
  bufferSeed: 'launchpad-buffer-3',
  programId: '5F4tt5fQwSR9ymzx5KiYL4Q2Ln8FJxbMfbXD1HhMgUrw',
  buffer: '78bmNEEvSsAHCgSNmsVNYM3JpAWLw1y6K4qrxabBCDw2',
  programData: 'GxZuLjDyHZhDG7vft5uh6UMJfF7pG4a8PZQtEZYcKwTo',
  loader: 'BPFLoaderUpgradeab1e11111111111111111111111',
  genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  cluster: 'mainnet-beta',
  chunkBytes: 900,
  maxBatch: 25,
  maxRetainedRentLamports: '3000000000',
});
const P = DAMM_PUMP_FEE_DEPLOYMENT_POLICY;
const OP = new PublicKey(P.operator), LOADER = new PublicKey(P.loader);
const PROGRAM = new PublicKey(P.programId), BUFFER = new PublicKey(P.buffer), DATA = new PublicKey(P.programData);
const TOTAL_CHUNKS = Math.ceil(P.binaryLength / P.chunkBytes);
const snapshots = new WeakMap();
const fail = message => { throw new Error(message); };
const ensure = (condition, message) => { if (!condition) fail(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const freeze = value => { if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; };
const identities = () => ({operator:P.operator,treasury:P.treasury,programId:P.programId,programData:P.programData,buffer:P.buffer});
const integer = (value, label) => { ensure(Number.isSafeInteger(value) && value >= 0, `Invalid ${label}.`); return BigInt(value); };
const meta = (pubkey, isWritable=false, isSigner=false) => ({pubkey,isWritable,isSigner});
const u32 = value => { const b=Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const u64 = value => { const b=Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const loaderIx = (data,keys) => new TransactionInstruction({programId:LOADER,data,keys});

export async function deriveDammPumpFeeDeployment() {
  ensure((await PublicKey.createWithSeed(OP,P.programSeed,LOADER)).equals(PROGRAM), 'Program seed derivation differs.');
  ensure((await PublicKey.createWithSeed(OP,P.bufferSeed,LOADER)).equals(BUFFER), 'Buffer seed derivation differs.');
  ensure(PublicKey.findProgramAddressSync([PROGRAM.toBuffer()],LOADER)[0].equals(DATA), 'ProgramData derivation differs.');
  return freeze(identities());
}

export function validateDammPumpFeeDeploymentBinary(binary) {
  ensure(Buffer.isBuffer(binary) || binary instanceof Uint8Array, 'Fee launch program binary bytes are required.');
  const copy=Buffer.from(binary);
  ensure(copy.length===P.binaryLength && copy.subarray(0,4).equals(Buffer.from([127,69,76,70])) && hash(copy)===P.binarySha256,
    'Fee launch program binary differs from the exact reviewed build.');
  return copy;
}

function account(account, label) {
  ensure(account && account.owner && typeof account.owner.equals==='function' && account.owner.equals(LOADER), `${label} is occupied by an unexpected owner; deployment stopped.`);
  ensure(Buffer.isBuffer(account.data) || account.data instanceof Uint8Array, `${label} has invalid bytes.`);
  return Buffer.from(account.data);
}
function inspectBuffer(a,binary) {
  const b=account(a,'Upload buffer');
  ensure(a.executable===false && b.length===37+P.binaryLength && b.readUInt32LE(0)===1 && b[4]===1 && b.subarray(5,37).equals(OP.toBuffer()), 'Upload buffer length, state, or authority differs.');
  const pending=[];
  for(let i=0;i<TOTAL_CHUNKS;i++) {
    const offset=i*P.chunkBytes, actual=b.subarray(37+offset,37+Math.min(offset+P.chunkBytes,P.binaryLength));
    const expected=binary.subarray(offset,offset+P.chunkBytes);
    if(actual.equals(expected)) continue;
    ensure(!actual.some(Boolean), `Upload buffer chunk ${i} contains unexpected bytes; deployment stopped.`);
    pending.push(i);
  }
  return {pending,balance:integer(a.lamports,'upload buffer balance')};
}
function inspectProgram(program,programData,binary,observationSlot) {
  const p=account(program,'Program'), d=account(programData,'ProgramData');
  ensure(program.executable===true && p.length===36 && p.readUInt32LE(0)===2 && p.subarray(4).equals(DATA.toBuffer()), 'Occupied program is not the expected executable.');
  ensure(programData.executable===false && d.length>=45+P.binaryLength && d.readUInt32LE(0)===3 && d[12]===1 && d.subarray(13,45).equals(OP.toBuffer()), 'ProgramData state or upgrade authority differs.');
  ensure(d.subarray(45,45+P.binaryLength).equals(binary) && !d.subarray(45+P.binaryLength).some(Boolean), 'Deployed program bytes differ from the reviewed fee launch program binary.');
  const slot=d.readBigUInt64LE(4);
  ensure(slot<=BigInt(Number.MAX_SAFE_INTEGER) && (observationSlot===null || slot<=BigInt(observationSlot)), 'Deployment slot is invalid or not finalized.');
  return {programId:P.programId,programData:P.programData,slot:Number(slot),deploymentSlot:slot.toString(),upgradeAuthority:P.operator,binarySha256:P.binarySha256};
}

/** Read finalized state and current rent. An occupied foreign destination is never overwritten.
 * The returned object is JSON-safe; build batches from this original in-process object only.
 */
export async function inspectDammPumpFeeDeployment({connection,binary}) {
  const code=validateDammPumpFeeDeploymentBinary(binary);
  await deriveDammPumpFeeDeployment();
  ensure(connection && await connection.getGenesisHash()===P.genesisHash, 'Deployment RPC is not Solana mainnet-beta.');
  const keys=[PROGRAM,DATA,BUFFER];
  let values, observationSlot=null;
  if(typeof connection.getMultipleAccountsInfoAndContext==='function') {
    const result=await connection.getMultipleAccountsInfoAndContext(keys,{commitment:'finalized'});
    integer(result?.context?.slot,'finalized observation slot'); observationSlot=result.context.slot; values=result.value;
  } else {
    // Test/injected clients may expose the standard non-context API only.
    values=await connection.getMultipleAccountsInfo(keys,{commitment:'finalized'});
  }
  ensure(Array.isArray(values)&&values.length===3, 'Invalid deployment account snapshot.');
  const [program,programData,buffer]=values;
  const [bufferRent,programRent,dataRent]=await Promise.all([
    connection.getMinimumBalanceForRentExemption(37+P.binaryLength,'finalized'),
    connection.getMinimumBalanceForRentExemption(36,'finalized'),
    connection.getMinimumBalanceForRentExemption(45+P.binaryLength,'finalized'),
  ]);
  const br=integer(bufferRent,'buffer rent'), pr=integer(programRent,'program rent'), dr=integer(dataRent,'ProgramData rent');
  ensure(br>0n && pr>0n && dr>0n && pr+dr<=BigInt(P.maxRetainedRentLamports) && br<=BigInt(P.maxRetainedRentLamports), 'Deployment rent exceeds the reviewed 3 SOL limit or is invalid.');
  let stage, pending=[], balance=0n, verifiedDeployment=null;
  if(program) {
    ensure(programData, 'Occupied program has no ProgramData; deployment stopped.');
    verifiedDeployment=inspectProgram(program,programData,code,observationSlot); stage='deployed';
    // A later unsolicited buffer account cannot invalidate an already verified deployment.
  } else {
    ensure(!programData, 'ProgramData destination is occupied; deployment stopped.');
    if(buffer) { const checked=inspectBuffer(buffer,code); pending=checked.pending; balance=checked.balance; stage=pending.length?'write-buffer':'deploy-program'; }
    else { pending=Array.from({length:TOTAL_CHUNKS},(_,i)=>i); stage='create-buffer'; }
  }
  const finalDebit=pr+(dr>balance?dr-balance:0n);
  const remaining=stage==='deployed'?0n:stage==='create-buffer'?pr+dr:finalDebit;
  const result=freeze({
    schemaVersion:1,stage,identities:identities(),...identities(),cluster:P.cluster,genesisHash:P.genesisHash,
    binarySha256:P.binarySha256,binaryLength:P.binaryLength,observationSlot,
    chunks:{total:TOTAL_CHUNKS,completed:stage==='deployed'?TOTAL_CHUNKS:TOTAL_CHUNKS-pending.length,pendingIndices:pending},
    uploadedChunks:stage==='deployed'?TOTAL_CHUNKS:TOTAL_CHUNKS-pending.length,totalChunks:TOTAL_CHUNKS,
    rent:{bufferLamports:br.toString(),programLamports:pr.toString(),programDataLamports:dr.toString(),retainedLamports:(pr+dr).toString(),remainingRentLamports:remaining.toString()},
    bufferLamports:balance.toString(),verifiedDeployment,
  });
  snapshots.set(result,{stage,pending:[...pending],bufferRent,programRent,finalDebit,binaryHash:hash(code)});
  return result;
}

/** Pure construction. No wallet, signature, priority fee, arbitrary destination, or send call. */
export function buildDammPumpFeeDeploymentBatch({binary,inspection,blockhash,lastValidBlockHeight,maxTransactions=P.maxBatch}) {
  const code=validateDammPumpFeeDeploymentBinary(binary), state=snapshots.get(inspection);
  ensure(state && state.binaryHash===P.binarySha256, 'Prepare requires a fresh in-process verified deployment inspection.');
  ensure(typeof blockhash==='string' && new PublicKey(blockhash).toBase58()===blockhash, 'A valid recent blockhash is required.');
  integer(lastValidBlockHeight,'last valid block height');
  ensure(Number.isInteger(maxTransactions)&&maxTransactions>=1&&maxTransactions<=P.maxBatch, 'Deployment batch size must be 1–25.');
  const transactions=[];
  function add(id,kind,instructions,units,cost,extra={}) {
    const msg=new TransactionMessage({payerKey:OP,recentBlockhash:blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units}),...instructions]}).compileToV0Message();
    ensure(msg.header.numRequiredSignatures===1 && msg.staticAccountKeys[0].equals(OP), 'Deployment must require only the pinned operator signature.');
    const tx=new VersionedTransaction(msg), raw=Buffer.from(tx.serialize());
    ensure(raw.length<=1232,'Deployment transaction exceeds Solana packet size.');
    transactions.push({id,kind,...extra,transactionBase64:raw.toString('base64'),unsignedMessageBase64:Buffer.from(msg.serialize()).toString('base64'),serializedBytes:raw.length,estimatedRentLamports:cost.toString(),maxWalletDebitLamports:cost.toString(),blockhash,lastValidBlockHeight});
  }
  if(state.stage==='create-buffer') {
    add('create-buffer','create-buffer',[
      SystemProgram.createAccountWithSeed({fromPubkey:OP,newAccountPubkey:BUFFER,basePubkey:OP,seed:P.bufferSeed,lamports:state.bufferRent,space:37+P.binaryLength,programId:LOADER}),
      loaderIx(u32(0),[meta(BUFFER,true),meta(OP)]),
    ],100000,BigInt(state.bufferRent));
  } else if(state.stage==='write-buffer') {
    for(const index of state.pending.slice(0,maxTransactions)) {
      const offset=index*P.chunkBytes, chunk=code.subarray(offset,offset+P.chunkBytes);
      add(`write:${index}`,'write-buffer',[loaderIx(Buffer.concat([u32(1),u32(offset),u64(chunk.length),chunk]),[meta(BUFFER,true),meta(OP,false,true)])],50000,0n,{chunkIndex:index,offset,dataLength:chunk.length});
    }
  } else if(state.stage==='deploy-program') {
    add('deploy-program','deploy-program',[
      SystemProgram.createAccountWithSeed({fromPubkey:OP,newAccountPubkey:PROGRAM,basePubkey:OP,seed:P.programSeed,lamports:state.programRent,space:36,programId:LOADER}),
      loaderIx(Buffer.concat([u32(2),u64(P.binaryLength)]),[meta(OP,true,true),meta(DATA,true),meta(PROGRAM,true),meta(BUFFER,true),meta(SYSVAR_RENT_PUBKEY),meta(SYSVAR_CLOCK_PUBKEY),meta(SystemProgram.programId),meta(OP,false,true)]),
    ],1400000,state.finalDebit);
  } else ensure(state.stage==='deployed','Unknown deployment stage.');
  return freeze({schemaVersion:1,stage:state.stage,identities:identities(),transactions,maxWalletDebitLamports:transactions.reduce((sum,t)=>sum+BigInt(t.maxWalletDebitLamports),0n).toString(),networkFeesIncluded:false,binarySha256:P.binarySha256,blockhash,lastValidBlockHeight});
}
