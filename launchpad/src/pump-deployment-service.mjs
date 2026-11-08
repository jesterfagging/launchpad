/** Owner-wallet deployment workflow. No private keys or server signing. */
import {readFile,open,mkdir,rename,lstat,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,createPublicKey,verify as verifySignature,randomUUID} from 'node:crypto';
import {Connection,VersionedTransaction,PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {launchpadEnv} from './brand-env.mjs';
import {PUMP_TEST_DEPLOYMENT_POLICY,inspectPumpTestDeployment,buildPumpTestDeploymentBatch} from './pump-test-deployment.mjs';
import {createSeededBinding,pendingConfig,verifyBinding,readOnlyRpc} from './pump-test-binding.mjs';

const APP=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const FINAL=new Set(['finalized','failed','state-confirmed','resumable-write']);
const MAX_BATCH=25,MAX_TX_BYTES=1232,MAX_JOURNAL_BYTES=8*1024*1024,MAX_BATCHES=500;
const fail=(message,statusCode=400)=>{throw Object.assign(Error(message),{statusCode});};
const assert=(ok,message,statusCode)=>{if(!ok)fail(message,statusCode);};
const hash=x=>createHash('sha256').update(x).digest('hex');
const decimal=x=>typeof x==='string'&&/^(0|[1-9]\d{0,19})$/.test(x);
const cleanKeys=(input,allowed)=>{assert(input&&typeof input==='object'&&!Array.isArray(input),'An input object is required.');assert(Object.keys(input).every(k=>allowed.includes(k)),'Unexpected deployment input.');};
const tokenHash=context=>{assert(typeof context?.sessionToken==='string'&&context.sessionToken.length>=16&&context.sessionToken.length<=4096,'A current authenticated session is required.',403);return hash(context.sessionToken);};
const txBytes=s=>{assert(typeof s==='string'&&s.length<=1644&&s.length>0&&s.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(s),'Invalid serialized wallet transaction.');const raw=Buffer.from(s,'base64');assert(raw.length<=MAX_TX_BYTES&&raw.toString('base64')===s,'Invalid transaction encoding or size.');return raw;};
async function concurrent(items,limit,fn){let index=0;await Promise.all(Array.from({length:Math.min(items.length,limit)},async()=>{while(index<items.length){const i=index++;await fn(items[i],i);}}));}
function unsigned(s,operator){
  let tx;try{const raw=txBytes(s);tx=VersionedTransaction.deserialize(raw);assert(Buffer.from(tx.serialize()).equals(raw),'Noncanonical deployment transaction.');}catch{fail('Invalid deployment transaction.');}
  assert(tx.version===0&&tx.message.addressTableLookups.length===0&&tx.message.header.numRequiredSignatures===1&&tx.signatures.length===1&&tx.message.staticAccountKeys[0].toBase58()===operator,'Deployment requires exactly the pinned owner wallet.');
  return tx;
}
function signedAgainst(s,record,operator){
  const tx=unsigned(s,operator),expected=unsigned(record.transaction,operator),message=Buffer.from(tx.message.serialize());
  assert(message.equals(Buffer.from(expected.message.serialize())),'The wallet changed the reviewed deployment message.');
  assert(expected.signatures.every(sig=>sig.every(byte=>byte===0)),'Reviewed deployment transaction must be unsigned.');
  const signature=Buffer.from(tx.signatures[0]);
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(operator).toBuffer()]),format:'der',type:'spki'});
  assert(signature.length===64&&verifySignature(null,message,key,signature),'Invalid owner wallet signature.');
  return {signedTransaction:s,signature:bs58.encode(signature)};
}
async function regularBytes(path,max){
  let handle;try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();assert(info.isFile()&&info.size<=max,'Invalid private deployment file.',503);return await handle.readFile();}finally{await handle?.close();}
}
async function readJson(path,max=MAX_JOURNAL_BYTES){try{return JSON.parse(String(await regularBytes(path,max)));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function atomicJson(path,value){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const prior=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});assert(!prior||prior.isFile()&&!prior.isSymbolicLink(),'Unsafe private deployment file.');
  const temporary=path+'.'+randomUUID()+'.tmp',handle=await open(temporary,'wx',0o600);
  try{
    try{const bytes=JSON.stringify(value,null,2)+'\n';assert(Buffer.byteLength(bytes)<=MAX_JOURNAL_BYTES,'Private deployment journal capacity reached.',409);await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    await rename(temporary,path);const dir=await open(dirname(path),'r');try{await dir.sync();}finally{await dir.close();}
  }finally{await unlink(temporary).catch(()=>{});}
}
function validateJournal(value,policy){
  if(value===null)return {schemaVersion:1,operator:policy.operator,binarySha256:policy.binarySha256,batches:[]};
  assert(value.schemaVersion===1&&value.operator===policy.operator&&value.binarySha256===policy.binarySha256&&Array.isArray(value.batches)&&value.batches.length<=MAX_BATCHES,'Deployment journal identity or format is invalid.',409);
  for(const batch of value.batches){
    assert(typeof batch.planId==='string'&&/^[a-f0-9-]{36}$/.test(batch.planId)&&typeof batch.accountId==='string'&&/^[a-f0-9]{64}$/.test(batch.sessionHash)&&Number.isSafeInteger(batch.lastValidBlockHeight)&&batch.lastValidBlockHeight>=0&&Array.isArray(batch.transactions)&&batch.transactions.length>=1&&batch.transactions.length<=MAX_BATCH,'Deployment journal batch is invalid.',409);
    for(const record of batch.transactions){
      const tx=unsigned(record.transaction,policy.operator);assert(tx.message.recentBlockhash===batch.blockhash,'Deployment journal blockhash differs.',409);
      if(record.signedTransaction){const checked=signedAgainst(record.signedTransaction,record,policy.operator);assert(checked.signature===record.signature,'Deployment journal signature differs.',409);}
    }
  }
  return value;
}
function batchView(batch){return batch?{planId:batch.planId,stage:batch.stage,state:batch.state,transactions:batch.transactions.map(t=>({id:t.id,kind:t.kind,chunkIndex:t.chunkIndex,state:t.state,signature:t.signature||null})),lastValidBlockHeight:batch.lastValidBlockHeight}:null;}
function settled(batch){return batch&&batch.transactions.every(t=>FINAL.has(t.state));}
function preparedView(batch,operator){return {planId:batch.planId,stage:batch.stage,state:batch.state,operator,pendingSignatures:batch.transactions.map(t=>({transaction:t.transaction,wallet:operator,transactionId:t.id})),maxWalletDebitLamports:batch.maxWalletDebitLamports,totalNetworkFeeLamports:batch.totalNetworkFeeLamports,lastValidBlockHeight:batch.lastValidBlockHeight};}

export class PumpDeploymentService {
  constructor({accounts,requireOwner,connection,rpcUrl=launchpadEnv('PUMP_TEST_RPC_URL')||launchpadEnv('PUBLIC_RPC_URL')||'https://api.mainnet-beta.solana.com',dataDir=accounts?.dir,
    binaryPath=join(APP,'private/pump-owner-test/curve_pump_test_OWNER_REQUIRES_REVIEW.so'),manifestPath=join(APP,'private/pump-owner-test/owner-build-unbound.json'),
    planner={policy:PUMP_TEST_DEPLOYMENT_POLICY,inspect:inspectPumpTestDeployment,build:buildPumpTestDeploymentBatch},loadBinary=()=>regularBytes(binaryPath,2*1024*1024),bindDeployment,bindingRpc,now=Date.now}={}){
    assert(typeof requireOwner==='function'&&typeof dataDir==='string'&&dataDir.length>0,'Owner deployment service needs an account store and owner guard.',503);
    let url;try{url=new URL(rpcUrl);}catch{fail('Private deployment RPC is not configured.',503);}assert(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash,'Private deployment RPC must use HTTPS.',503);
    Object.assign(this,{accounts,requireOwner,planner,loadBinary,manifestPath,now,rpcUrl,bindingRpc});
    this.connection=connection||new Connection(rpcUrl,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:async(url,options)=>fetch(url,{...options,signal:options?.signal?AbortSignal.any([options.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)})});
    this.dir=join(resolve(dataDir),'pump-owner-test');this.journalPath=join(this.dir,'deployment-journal.json');this.configPath=join(resolve(dataDir),'pump-test-config.json');
    this.bindDeployment=bindDeployment||((inspection,binary,authorize)=>this.writeVerifiedConfig(inspection,binary,authorize));
  }
  async auth(session,context){await this.requireOwner(session);assert(typeof context?.authorize==='function','Fresh owner authorization is required.',403);await context.authorize();tokenHash(context);}
  async directory(){await mkdir(this.dir,{recursive:true,mode:0o700});const info=await lstat(this.dir);assert(info.isDirectory()&&!info.isSymbolicLink()&&(info.mode&0o077)===0,'Deployment journal directory must be private.',503);}
  async locked(fn){
    await this.directory();const path=join(this.dir,'deployment.lock');let handle;
    try{handle=await open(path,'wx',0o600);}catch(e){if(e.code==='EEXIST')fail('Deployment is locked by another operation. If the service crashed, stop the service before manually clearing its private deployment lock.',409);throw e;}
    // No stale-PID deletion: a lock surviving a crash requires explicit offline recovery.
    try{await handle.writeFile(JSON.stringify({pid:process.pid,createdAt:this.now()}));await handle.sync();return await fn();}
    finally{await handle.close();await unlink(path);}
  }
  async journal(){return validateJournal(await readJson(this.journalPath),this.planner.policy);}
  async material(){const binary=Buffer.from(await this.loadBinary());assert(binary.length===this.planner.policy.binaryLength&&hash(binary)===this.planner.policy.binarySha256,'Private deployment binary differs from the reviewed build.',503);return binary;}
  async inspect(binary){try{return await this.planner.inspect({connection:this.connection,binary});}catch(e){if(e.statusCode)throw e;fail('Deployment account verification could not complete. Refresh status before continuing.',503);}}
  async readStatus(journal,inspection){
    const batch=journal.batches.at(-1),pending=batch&&!settled(batch)&&batch.state!=='expired-unsigned';
    return {enabled:true,ownerOnly:true,network:'mainnet-beta',operator:this.planner.policy.operator,treasury:this.planner.policy.treasury,programId:inspection.identities.programId,buffer:inspection.identities.buffer,
      stage:inspection.stage,uploadedChunks:inspection.chunks.completed,totalChunks:inspection.chunks.total,estimatedRentLamports:inspection.rent.remainingRentLamports,rent:inspection.rent,
      pendingBatch:pending?batchView(batch):null,canPrepare:inspection.stage!=='deployed'&&!pending,canReconcile:!!pending&&batch.state!=='prepared',verifiedDeployment:inspection.verifiedDeployment||null,
      notice:'Only your wallet signs deployment transactions. Missing receipts remain unresolved until finalized evidence proves their outcome.'};
  }
  async status(session,context){
    await this.auth(session,context);const binary=await this.material(),inspection=await this.inspect(binary);await this.auth(session,context);
    return this.locked(async()=>{const journal=await this.journal();if(inspection.stage==='deployed'){await this.auth(session,context);await this.bindDeployment(inspection,binary,()=>this.auth(session,context));}return this.readStatus(journal,inspection);});
  }
  async prepare(session,input={},context){
    cleanKeys(input,['wallet']);await this.auth(session,context);if(input.wallet!==undefined)assert(input.wallet===this.planner.policy.operator,'Connect the pinned deployment owner wallet.');
    return this.locked(async()=>{
      const journal=await this.journal(),last=journal.batches.at(-1),ownerHash=tokenHash(context);
      if(last&&!settled(last)&&last.state!=='expired-unsigned'){
        if(last.state==='prepared'){
          const height=await this.connection.getBlockHeight('finalized');
          if(height<=last.lastValidBlockHeight){assert(last.accountId===session.account.id&&last.sessionHash===ownerHash,'This plan belongs to a different authenticated session. Wait for its unsigned blockhash to expire.',409);await this.auth(session,context);return preparedView(last,this.planner.policy.operator);}
          last.state='expired-unsigned';await atomicJson(this.journalPath,journal);
        }else fail('A deployment batch is unresolved. Reconcile it before preparing another.',409);
      }
      assert(journal.batches.length<MAX_BATCHES,'Deployment journal batch limit reached; review it before continuing.',409);
      const binary=await this.material(),inspection=await this.inspect(binary);assert(inspection.stage!=='deployed','The pinned program is already deployed.',409);
      const latest=await this.connection.getLatestBlockhash('finalized');assert(typeof latest.blockhash==='string'&&Number.isSafeInteger(latest.lastValidBlockHeight),'Invalid deployment blockhash.',503);
      const plan=this.planner.build({binary,inspection,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,maxTransactions:MAX_BATCH});
      assert(plan&&plan.stage===inspection.stage&&Array.isArray(plan.transactions)&&plan.transactions.length>0&&plan.transactions.length<=MAX_BATCH,'Invalid deployment batch.',503);
      let totalFees=0n;
      const records=plan.transactions.map(t=>{const tx=unsigned(t.transactionBase64,this.planner.policy.operator);assert(tx.signatures.every(sig=>sig.every(byte=>byte===0)),'Planner returned a signed transaction.',503);return {id:t.id,kind:t.kind,...(t.chunkIndex===undefined?{}:{chunkIndex:t.chunkIndex}),transaction:t.transactionBase64,state:'prepared'};});
      await concurrent(records,3,async record=>{
        const tx=unsigned(record.transaction,this.planner.policy.operator),fee=await this.connection.getFeeForMessage(tx.message,'finalized');
        assert(Number.isSafeInteger(fee.value)&&fee.value>=0&&fee.value<=10000000,'The deployment network fee is unavailable or outside the reviewed cap.',503);totalFees+=BigInt(fee.value);
        const result=await this.connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:false,commitment:'confirmed'});assert(result?.value&&result.value.err===null,'A deployment transaction did not pass simulation. No wallet signature was requested.',409);
      });
      assert(decimal(String(plan.maxWalletDebitLamports)),'Invalid deployment rent estimate.',503);const total=BigInt(plan.maxWalletDebitLamports)+totalFees;
      assert(total<=3100000000n,'Deployment exceeds the reviewed 3.1 SOL single-batch limit.',409);
      const balance=await this.connection.getBalance(new PublicKey(this.planner.policy.operator),'confirmed');assert(Number.isSafeInteger(balance)&&BigInt(balance)>=total,'The owner wallet needs more SOL for the reviewed deployment rent and fees.',409);
      await this.auth(session,context);
      const batch={planId:randomUUID(),accountId:session.account.id,sessionHash:ownerHash,stage:plan.stage,state:'prepared',createdAt:this.now(),blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,
        maxWalletDebitLamports:total.toString(),totalNetworkFeeLamports:totalFees.toString(),transactions:records};
      journal.batches.push(batch);await atomicJson(this.journalPath,journal);return preparedView(batch,this.planner.policy.operator);
    });
  }
  async submit(session,input,context){
    cleanKeys(input,['planId','signedTransactions']);await this.auth(session,context);assert(typeof input.planId==='string'&&Array.isArray(input.signedTransactions)&&input.signedTransactions.length>=1&&input.signedTransactions.length<=MAX_BATCH,'Invalid signed deployment batch.');
    return this.locked(async()=>{
      const journal=await this.journal(),batch=journal.batches.at(-1);assert(batch&&batch.planId===input.planId,'This deployment plan is no longer current.',409);
      assert(batch.accountId===session.account.id&&batch.sessionHash===tokenHash(context),'Deployment plan belongs to a different authenticated session.',403);
      assert(input.signedTransactions.length===batch.transactions.length,'Wallet must sign exactly the reviewed transaction count.');
      const signatures=input.signedTransactions.map((s,i)=>signedAgainst(s,batch.transactions[i],this.planner.policy.operator));
      if(batch.state!=='prepared'){
        assert(batch.transactions.every((t,i)=>t.signature===signatures[i].signature),'Submitted signatures differ from the saved batch.',409);
        return {state:batch.state,batch:batchView(batch),resubmitted:false};
      }
      assert(await this.connection.getBlockHeight('finalized')<=batch.lastValidBlockHeight,'Unsigned deployment plan has expired. Prepare a new plan.',409);
      const inspection=await this.inspect(await this.material());assert(inspection.stage===batch.stage,'Deployment state changed after preparation. Refresh and reconcile.',409);
      await this.auth(session,context);
      // Every exact signed byte and signature is durable BEFORE any RPC send.
      batch.state='submitting';batch.transactions.forEach((record,i)=>Object.assign(record,signatures[i],{state:'signed-not-submitted'}));await atomicJson(this.journalPath,journal);
      let persist=Promise.resolve();const save=()=>{persist=persist.then(()=>atomicJson(this.journalPath,journal));return persist;};
      await concurrent(batch.transactions,3,async record=>{
        try{
          await this.auth(session,context);record.state='submission-started';await save();
          await this.auth(session,context);
          const result=await this.connection.sendRawTransaction(txBytes(record.signedTransaction),{skipPreflight:false,maxRetries:0,preflightCommitment:'confirmed'});
          assert(result===record.signature,'RPC returned a different transaction signature.',503);record.state='submitted';record.submittedAt=this.now();
        }catch{record.state='submission-unknown';record.notice='Submission outcome must be reconciled; this transaction will not be sent automatically again.';}
        await save();
      });
      batch.state='pending';await save();await this.auth(session,context);return {state:batch.state,batch:batchView(batch),resubmitted:false};
    });
  }
  async reconcile(session,input={},context){
    cleanKeys(input,['planId']);await this.auth(session,context);
    return this.locked(async()=>{
      const journal=await this.journal(),batch=journal.batches.at(-1),binary=await this.material();
      if(!batch){const inspection=await this.inspect(binary);return {state:'idle',...await this.readStatus(journal,inspection)};}
      if(input.planId!==undefined)assert(input.planId===batch.planId,'This deployment batch is no longer current.',409);
      if(batch.state==='prepared'){
        if(await this.connection.getBlockHeight('finalized')>batch.lastValidBlockHeight){batch.state='expired-unsigned';await atomicJson(this.journalPath,journal);}
      }else if(!settled(batch)){
        const signed=batch.transactions.filter(t=>t.signature&&!FINAL.has(t.state));
        const statuses=await this.connection.getSignatureStatuses(signed.map(t=>t.signature),{searchTransactionHistory:true});
        assert(statuses&&Array.isArray(statuses.value)&&statuses.value.length===signed.length,'Deployment receipt check is unavailable.',503);
        const height=await this.connection.getBlockHeight('finalized'),expired=height>batch.lastValidBlockHeight;
        const inspection=expired?await this.inspect(binary):null;
        await concurrent(signed,3,async(record,i)=>{
          const status=statuses.value[i];
          if(status?.confirmationStatus==='finalized'){
            record.state=status.err?'failed':'finalized';record.receiptSlot=status.slot;record.finalizedAt=this.now();return;
          }
          if(status){record.state='pending';return;}
          if(!expired){record.state='pending';return;}
          const receipt=await this.connection.getTransaction(record.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
          if(receipt){assert(receipt.meta&&Object.hasOwn(receipt.meta,'err')&&receipt.transaction?.signatures?.[0]===record.signature,'Finalized receipt does not match the saved signature.',503);record.state=receipt.meta.err?'failed':'finalized';record.receiptSlot=receipt.slot;record.finalizedAt=this.now();return;}
          // Missing receipt alone NEVER authorizes another rent-funded creation.
          // Exact finalized account bytes can prove idempotent progress instead.
          const wrote=record.kind==='write-buffer'||record.kind==='write';
          if(inspection.stage==='deployed'||record.kind==='create-buffer'&&['write-buffer','deploy-program'].includes(inspection.stage)||wrote&&['write-buffer','deploy-program'].includes(inspection.stage)&&!inspection.chunks.pendingIndices.includes(record.chunkIndex)){
            record.state='state-confirmed';record.evidence='Finalized account identity, authority and exact expected bytes verified after blockhash expiry.';
          }else if(wrote&&inspection.stage==='write-buffer'&&inspection.chunks.pendingIndices.includes(record.chunkIndex)){
            record.state='resumable-write';record.evidence='Expired blockhash and validated finalized buffer; this exact idempotent byte range remains unwritten. A fresh owner-approved plan may write it.';
          }else{record.state='expired-unconfirmed';record.notice='Expired transaction has no receipt or conclusive finalized account proof. Rent-funded creation will not be replayed.';}
        });
        batch.state=settled(batch)?(batch.transactions.some(t=>t.state==='resumable-write')?'resumable':'complete'):'pending';
        await this.auth(session,context);await atomicJson(this.journalPath,journal);
      }
      const inspection=await this.inspect(binary);await this.auth(session,context);
      if(inspection.stage==='deployed')await this.bindDeployment(inspection,binary,()=>this.auth(session,context));
      return {state:batch.state,batch:batchView(batch),...await this.readStatus(journal,inspection)};
    });
  }
  async writeVerifiedConfig(inspection,binary,authorize){
    assert(inspection.stage==='deployed'&&inspection.verifiedDeployment,'Deployment has not been verified.',409);
    const manifest=await readJson(this.manifestPath,128*1024);assert(manifest,'Reviewed owner build manifest is missing.',503);
    const binding=await createSeededBinding({manifest,cluster:'mainnet-beta',PublicKey});
    const checked=await verifyBinding({binding,programId:inspection.identities.programId,binary,rpc:this.bindingRpc||readOnlyRpc(this.rpcUrl),PublicKey});
    const proof=checked.verification,proofPath=join(this.dir,'verified-build-manifest.json');
    assert(proof.binarySha256===this.planner.policy.binarySha256&&proof.operator===this.planner.policy.operator&&proof.treasury===this.planner.policy.treasury&&proof.programId===inspection.identities.programId,'Final deployment identity differs.',409);
    await authorize();
    const existing=await readJson(this.configPath,128*1024);
    if(existing){assert(existing.operator===proof.operator&&existing.treasury===proof.treasury&&existing.programId===proof.programId&&existing.expectedProgramSha256===proof.binarySha256&&String(existing.expectedDeploymentSlot)===proof.deploymentSlot&&existing.expectedUpgradeAuthority===proof.upgradeAuthority,'Existing funded-test configuration differs; it was not overwritten.',409);return;}
    const config={...pendingConfig(binding,proofPath),rpcUrl:this.rpcUrl,migrationRentLamports:'20000000',expectedDeploymentSlot:proof.deploymentSlot,expectedUpgradeAuthority:proof.upgradeAuthority};
    await atomicJson(proofPath,checked.manifest);await atomicJson(join(this.dir,'deployment-verification.json'),proof);await authorize();await atomicJson(this.configPath,config);
  }
}
