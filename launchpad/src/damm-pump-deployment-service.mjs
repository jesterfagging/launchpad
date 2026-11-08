/** Public program deployment and configuration. Only the owner's wallet signs.
 * This reuses the proven durable deployment journal and exact-message verifier.
 * Loader setup, global configuration, and public availability are separate gates.
 */
import {readFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PublicKey,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import {PumpDeploymentService} from './pump-deployment-service.mjs';
import {createDammPumpDeploymentProofCache} from './damm-pump-deployment-proof-cache.mjs';
import {DAMM_PUMP_DEPLOYMENT_POLICY,inspectDammPumpDeployment,buildDammPumpDeploymentBatch,validateDammPumpDeploymentBinary} from './damm-pump-deployment.mjs';
import {launchpadEnv} from './brand-env.mjs';

const APP=resolve(dirname(fileURLToPath(import.meta.url)),'..'),P=DAMM_PUMP_DEPLOYMENT_POLICY;
export const DAMM_PUMP_BINARY_PATH=join(APP,'private/damm-pump/curve_damm_pump.so');
const PUBLIC_PROGRAM=new PublicKey(P.programId),ADMIN=new PublicKey(P.operator);
export const DAMM_PUMP_CONFIG_ADDRESS=PublicKey.findProgramAddressSync([Buffer.from('config')],PUBLIC_PROGRAM)[0].toBase58();
const CONFIG=new PublicKey(DAMM_PUMP_CONFIG_ADDRESS);
// The upgradeable loader changes its deployment slot on every executable upgrade.
// Cache exact ELF verification only; configuration and loader headers are read each time.
const fail=(message,statusCode=409)=>{throw Object.assign(Error(message),{statusCode});};
const assert=(condition,message,statusCode)=>{if(!condition)fail(message,statusCode);};
const defaultBinary=async()=>validateDammPumpDeploymentBinary(await readFile(DAMM_PUMP_BINARY_PATH));
const integer=(n,label)=>{assert(Number.isSafeInteger(n)&&n>=0,`Invalid ${label}.`,503);return n;};
const publicKey=value=>{try{const key=new PublicKey(value);assert(typeof value==='string'&&key.toBase58()===value&&PublicKey.isOnCurve(key.toBytes())&&![P.operator,P.treasury].includes(value),'A valid managed relayer public key is required.',503);return key;}catch{fail('A valid managed relayer public key is required.',503);}};
const finalBatch=batch=>batch&&batch.transactions.every(t=>['finalized','failed','state-confirmed','resumable-write'].includes(t.state));
const deploymentProofs=createDammPumpDeploymentProofCache({inspect:inspectDammPumpDeployment,loadBinary:defaultBinary,
  verifyNetwork:async connection=>assert(await connection.getGenesisHash()===P.genesisHash,'Deployment RPC is not Solana mainnet-beta.',409)});
const inspectDeployment=args=>deploymentProofs.get(args);

async function readGlobal(connection,inspection,relayer){
  publicKey(relayer);
  // One finalized snapshot binds enablement and recipients to the same loader
  // identity. Every caller reads afresh. Retry one out-of-order RPC response at
  // the newest observed slot; never return an older cached enablement decision.
  let snapshot;
  for(let attempt=0;attempt<2;attempt++){
    const minimum=deploymentProofs.minimumSlot(connection,inspection.observationSlot);
    snapshot=await connection.getMultipleAccountsInfoAndContext([CONFIG,PUBLIC_PROGRAM,new PublicKey(P.programData)],{commitment:'finalized',minContextSlot:minimum,dataSlice:{offset:0,length:128}});
    integer(snapshot?.context?.slot,'configuration observation slot');
    assert(Array.isArray(snapshot.value)&&snapshot.value.length===3,'Configuration observation is incomplete.',503);
    const latest=deploymentProofs.minimumSlot(connection,inspection.observationSlot);
    if(snapshot.context.slot<latest&&attempt===0)continue;
    assert(snapshot.context.slot>=latest,'Configuration observation predates the verified program.',503);
    break;
  }
  const [configuration,program,data]=snapshot.value,pb=Buffer.from(program?.data||[]),db=Buffer.from(data?.data||[]).subarray(0,45);
  assert(program?.owner?.toBase58()===P.loader&&program.executable===true&&pb.length===36&&pb.readUInt32LE(0)===2&&new PublicKey(pb.subarray(4)).toBase58()===P.programData,'Public program identity changed during verification.',409);
  assert(data?.owner?.toBase58()===P.loader&&data.executable===false&&db.length===45&&db.readUInt32LE(0)===3&&db.readBigUInt64LE(4).toString()===inspection.verifiedDeployment.deploymentSlot&&db[12]===1&&new PublicKey(db.subarray(13,45)).toBase58()===P.operator,'Public program changed during configuration verification.',409);
  deploymentProofs.observe(connection,snapshot.context.slot);
  const observation={context:snapshot.context,value:configuration};
  if(!observation.value)return {configured:false,chainEnabled:false,configAddress:DAMM_PUMP_CONFIG_ADDRESS,relayer,finalizedObservationSlot:observation.context.slot};
  const a=observation.value,b=Buffer.from(a.data||[]);
  if(a.owner?.equals(SystemProgram.programId)&&a.executable===false&&b.length===0)return {configured:false,chainEnabled:false,configAddress:DAMM_PUMP_CONFIG_ADDRESS,relayer,prefundedLamports:integer(a.lamports,'configuration prefunding'),finalizedObservationSlot:observation.context.slot};
  assert(a.owner?.equals(PUBLIC_PROGRAM)&&a.executable===false&&b.length===128&&b.subarray(0,8).equals(Buffer.from('CRVPCFG1'))&&b[8]===1&&(b[9]===0||b[9]===1),'Public configuration account differs from the reviewed program.',409);
  assert(new PublicKey(b.subarray(16,48)).toBase58()===P.operator&&new PublicKey(b.subarray(48,80)).toBase58()===P.treasury&&new PublicKey(b.subarray(80,112)).toBase58()===relayer,'Public configuration owner, treasury, or relayer differs.',409);
  return {configured:true,chainEnabled:b[9]===1,configAddress:DAMM_PUMP_CONFIG_ADDRESS,relayer,finalizedObservationSlot:observation.context.slot};
}
function binding(inspection,global){
  const proof=inspection.verifiedDeployment;
  assert(inspection.stage==='deployed'&&proof&&global.configured,'Public program and configuration are not finalized.',409);
  return {schemaVersion:1,cluster:'mainnet-beta',programId:P.programId,expectedProgramSha256:P.binarySha256,expectedDeploymentSlot:proof.deploymentSlot,
    expectedUpgradeAuthority:P.operator,treasury:P.treasury,relayer:global.relayer,verifiedAt:Date.now(),enabled:false};
}
function sameBinding(a,b){return a&&['schemaVersion','cluster','programId','expectedProgramSha256','expectedDeploymentSlot','expectedUpgradeAuthority','treasury','relayer'].every(k=>String(a[k])===String(b[k]));}

/** Read-only runtime gate: rejects changed ELF, slot, authority, or config recipients. */
export async function verifyDammPumpDeployment({connection,config,binary}){
  assert(connection&&config,'Public deployment configuration is missing.',503);
  assert(config.schemaVersion===1&&config.cluster==='mainnet-beta'&&config.programId===P.programId&&config.expectedProgramSha256===P.binarySha256&&config.expectedUpgradeAuthority===P.operator&&config.treasury===P.treasury,'Public deployment pins differ from this release.',409);
  if(binary)validateDammPumpDeploymentBinary(binary);
  const inspection=await inspectDeployment({connection,binary});
  assert(inspection.stage==='deployed','The public launch program is not deployed.',409);
  assert(String(config.expectedDeploymentSlot)===inspection.verifiedDeployment.deploymentSlot,'Public deployment slot changed; review the new build before enabling.',409);
  const global=await readGlobal(connection,inspection,config.relayer);
  assert(global.configured,'The public launch program is not configured.',409);
  return {...binding(inspection,global),...global};
}

class PublicJournal extends PumpDeploymentService{
  constructor(options,{target=null,configuration=false}={}){
    const {ensureRelayer,installDeployment,deploymentConfig=async()=>null,...base}=options;
    assert(typeof ensureRelayer==='function'&&typeof installDeployment==='function','Public setup needs managed relayer and verified configuration storage.',503);
    const loadBinary=base.loadBinary||defaultBinary;
    super({...base,rpcUrl:base.rpcUrl||launchpadEnv('DAMM_PUMP_RPC_URL')||launchpadEnv('PUBLIC_RPC_URL')||'https://api.mainnet-beta.solana.com',binaryPath:DAMM_PUMP_BINARY_PATH,loadBinary,
      planner:{policy:P,inspect:inspectDeployment,build:buildDammPumpDeploymentBatch},bindDeployment:async()=>{}});
    this.dir=join(resolve(base.dataDir||base.accounts?.dir),'damm-pump-deployment',configuration?'configuration':'loader');
    this.journalPath=join(this.dir,'deployment-journal.json');
    this.ensureRelayer=ensureRelayer;this.installDeployment=installDeployment;this.deploymentConfig=deploymentConfig;this.target=target;this.configuration=configuration;
    if(configuration)this.planner={policy:P,inspect:args=>this.configurationInspection(args),build:args=>this.configurationBatch(args)};
    this.bindDeployment=(inspection,binary,authorize)=>this.bindPublic(inspection,binary,authorize);
  }
  async global(inspection){const {address}=await this.ensureRelayer();return readGlobal(this.connection,inspection,address);}
  async configurationInspection({connection,binary}){
    const loader=await inspectDeployment({connection,binary});
    assert(loader.stage==='deployed','Deploy and verify the public contract before configuring it.',409);
    const global=await this.global(loader),target=this.target===null?false:this.target;
    const complete=global.configured&&(this.target===null||global.chainEnabled===target);
    const rent=global.configured?0:Math.max(0,integer(await connection.getMinimumBalanceForRentExemption(128,'finalized'),'configuration rent')-(global.prefundedLamports||0));
    const inspection={...loader,stage:complete?'deployed':target?'configure-enabled':'configure-disabled',global,loader,configurationRentLamports:String(rent),target,
      rent:{...loader.rent,remainingRentLamports:String(rent)},verifiedDeployment:complete?loader.verifiedDeployment:null};
    this.configurationSnapshot=inspection;return inspection;
  }
  configurationBatch({inspection,blockhash,lastValidBlockHeight}){
    assert(this.configurationSnapshot===inspection&&inspection.stage!=='deployed','Configuration requires a fresh verified inspection.',409);
    const relayer=publicKey(inspection.global.relayer),enabled=inspection.target;
    const instruction=new TransactionInstruction({programId:PUBLIC_PROGRAM,keys:[{pubkey:ADMIN,isSigner:true,isWritable:true},{pubkey:CONFIG,isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}],data:Buffer.concat([Buffer.from([4]),relayer.toBuffer(),Buffer.from([enabled?1:0])])});
    const message=new TransactionMessage({payerKey:ADMIN,recentBlockhash:blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:100000}),instruction]}).compileToV0Message();
    const tx=new VersionedTransaction(message);
    return {stage:inspection.stage,transactions:[{id:inspection.stage,kind:inspection.stage,transactionBase64:Buffer.from(tx.serialize()).toString('base64')}],maxWalletDebitLamports:inspection.configurationRentLamports,lastValidBlockHeight};
  }
  async readStatus(journal,inspection){
    const base=await super.readStatus(journal,inspection);
    const global=this.configuration?inspection.global:inspection.stage==='deployed'?await this.global(inspection):null;
    return {...base,publicSetup:true,configuration:this.configuration,...global,...(this.configuration?{canPrepare:!base.pendingBatch||base.pendingBatch.state==='prepared'}:{}),
      notice:this.configuration?'Your wallet approves the fixed treasury, graduation wallet, and launch activation. Public launches open when the controller is enabled and the graduation wallet has gas.':'One-time PumpSwap launch controller deployment. The current network rent is shown above.'};
  }
  async bindPublic(inspection,binary,authorize){
    const loader=inspection.loader||inspection;
    if(loader.stage!=='deployed')return;
    const global=inspection.global||await this.global(loader);
    if(!global.configured)return;
    // Re-read finalized bytecode/config immediately before installing the binding.
    const proposed=binding(loader,global);
    const checked=await verifyDammPumpDeployment({connection:this.connection,config:proposed,binary});
    await authorize();
    const current=await this.deploymentConfig();
    if(current){assert(sameBinding(current,proposed),'Existing public deployment binding differs; it was not overwritten.',409);return checked;}
    await authorize();await this.installDeployment(proposed);return checked;
  }
}

/** Constructor is cheap; no key generation or RPC occurs until owner-authorized calls.
 * configuration mirrors status/prepare/submit/reconcile; prepare adds {enabled:boolean}.
 */
export class DammPumpDeploymentService{
  constructor(options){this.loader=new PublicJournal(options);this.options={...options,connection:this.loader.connection};this.configuration={status:(...a)=>this.configStatus(...a),prepare:(...a)=>this.configPrepare(...a),submit:(...a)=>this.configSubmit(...a),reconcile:(...a)=>this.configReconcile(...a)};}
  status(...args){return this.loader.status(...args);}
  prepare(...args){return this.loader.prepare(...args);}
  submit(...args){return this.loader.submit(...args);}
  reconcile(...args){return this.loader.reconcile(...args);}
  async configService(session,context,target){
    const service=new PublicJournal(this.options,{configuration:true,target:target??null});
    await service.auth(session,context);
    const last=(await service.journal()).batches.at(-1);
    if(target===undefined&&last&&!finalBatch(last)&&last.state!=='expired-unsigned')service.target=last.stage==='configure-enabled';
    return {service,last};
  }
  async configStatus(session,context){const {service}=await this.configService(session,context);return service.status(session,context);}
  async configPrepare(session,input,context){
    assert(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>['wallet','enabled'].includes(k))&&typeof input.enabled==='boolean','Configuration needs an explicit enabled choice.',400);
    const {service,last}=await this.configService(session,context,input.enabled);
    if(last?.state==='prepared'&&await service.connection.getBlockHeight('finalized')>last.lastValidBlockHeight){await service.reconcile(session,{planId:last.planId},context);last.state='expired-unsigned';}
    if(last&&!finalBatch(last)&&last.state!=='expired-unsigned')assert(last.stage===(input.enabled?'configure-enabled':'configure-disabled'),'Reconcile the prior configuration action before choosing a different setting.',409);
    const plan=await service.prepare(session,input.wallet===undefined?{}:{wallet:input.wallet},context);
    assert(plan.stage===(input.enabled?'configure-enabled':'configure-disabled'),'Another configuration review is pending. Refresh before approving.',409);
    return plan;
  }
  async configSubmit(session,input,context){const {service}=await this.configService(session,context);return service.submit(session,input,context);}
  async configReconcile(session,input,context){const {service}=await this.configService(session,context);return service.reconcile(session,input,context);}
}
