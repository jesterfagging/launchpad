#!/usr/bin/env node
/** Dedicated owner microtest client. Nothing executes on import; no server routes. */
import {readFile,writeFile,open,mkdir,rename,stat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,createPublicKey,verify as verifyEd25519} from 'node:crypto';
import {PublicKey,Keypair,SystemProgram,Transaction,TransactionInstruction,ComputeBudgetProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,NATIVE_MINT,getAssociatedTokenAddressSync,createInitializeMint2Instruction,createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {previewPumpTestModel} from '../src/pump-test-model.mjs';
import {PUMP_TEST_PAIR_PROVENANCE} from '../src/pump-test-pairs.mjs';
import {PINS as OWNER_PINS,OWNER as PINNED_OWNER,TREASURY as PINNED_TREASURY,SEEDED_PROGRAM} from '../src/pump-test-binding.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const PUMP=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const GLOBAL=new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const LOADER='BPFLoaderUpgradeab1e11111111111111111111111';
const FIXTURES=new Set([99,71,41,42].map(seed=>Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey.toBase58()));
const GENESIS=Object.freeze({'mainnet-beta':'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','devnet':'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'});
const SUPPLY=1000000000000000n,VB=1372346627033820n,CAP=758614557685785n;
const MAX_PRINCIPAL=3000000000n,MAX_RENT=100000000n,MAX_TOTAL=3300000000n;
const METHODS=new Set(['getGenesisHash','getAccountInfo','getBalance','getLatestBlockhash','getMinimumBalanceForRentExemption','getFeeForMessage','getBlockHeight','simulateTransaction','getSignatureStatuses','getTransaction','sendTransaction']);
const fail=(ok,message)=>{if(!ok)throw Error(message);};
export const sha256=data=>createHash('sha256').update(data).digest('hex');
const bigint=(v,label)=>{fail(typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v),`${label} must be a decimal integer string.`);const n=BigInt(v);fail(n<2n**64n,`${label} exceeds u64.`);return n;};
const ceil=(n,d)=>(n+d-1n)/d;
const encode=(op,...values)=>{const b=Buffer.alloc(1+values.length*8);b[0]=op;values.forEach((v,i)=>b.writeBigUInt64LE(v,1+i*8));return b;};
const pk=s=>new PublicKey(s),meta=(key,writable=false,signer=false)=>({pubkey:key,isWritable:writable,isSigner:signer});
const snapshot=account=>account&&Object.hasOwn(account,'value')?account.value:account;
const dataOf=account=>Buffer.from(account.data[0],'base64');
function safeError(e){return String(e?.message||'Private test failed.').replace(/https?:\/\/\S+/g,'[RPC endpoint]').slice(0,700);}

export function validateConfig(input,{now=Date.now(),requirePrice=false}={}){
  const c=structuredClone(input);fail(c&&c.schemaVersion===1,'Unsupported private-test configuration.');
  fail(Object.hasOwn(GENESIS,c.cluster),'Choose explicit mainnet-beta or devnet cluster.');
  const u=new URL(c.rpcUrl);fail(u.protocol==='https:'&&!u.username&&!u.password,'RPC must be an HTTPS URL without embedded username/password.');
  for(const name of ['operator','treasury','programId']){fail(typeof c[name]==='string'&&pk(c[name]).toBase58()===c[name],`Invalid ${name} public key.`);fail(!FIXTURES.has(c[name]),`${name} cannot use a public fixture key.`);}
  fail(PublicKey.isOnCurve(pk(c.operator).toBytes()),'Operator must be a wallet public key.');
  fail(new Set([c.operator,c.treasury,c.programId]).size===3,'Operator, treasury and program must be distinct.');
  fail(c.programId!==PUMP.toBase58()&&c.programId!==TOKEN_PROGRAM_ID.toBase58()&&c.programId!==TOKEN_2022_PROGRAM_ID.toBase58(),'Invalid custody program.');
  fail(typeof c.expectedProgramSha256==='string'&&/^[a-f0-9]{64}$/.test(c.expectedProgramSha256),'Pin the reviewed owner-test binary SHA-256.');
  bigint(c.expectedDeploymentSlot,'Deployment slot');
  fail(c.expectedUpgradeAuthority===null||c.expectedUpgradeAuthority===c.operator,'Upgrade authority must be the operator or revoked.');
  fail(typeof c.buildManifest==='string'&&c.buildManifest.length>0,'Owner-test build manifest is required.');
  fail(typeof c.mintSeed==='string'&&/^[a-zA-Z0-9_-]{1,32}$/.test(c.mintSeed),'Mint seed must be 1–32 ASCII letters, digits, underscores or dashes.');
  fail(c.graduationFeeBps===2885&&c.tradeFeeBps===100,'Owner microtest requires 28.85% graduation and 1% trade fees.');
  const rent=bigint(c.migrationRentLamports,'Migration rent budget');fail(rent>=20000000n&&rent<=MAX_RENT,'Migration rent must be 0.02–0.1 SOL.');
  const max=bigint(c.maxWalletSpendLamports,'Wallet spend limit');fail(max>0n&&max<=MAX_TOTAL,'Wallet spend limit must not exceed 3.3 SOL.');
  fail(Number.isInteger(c.computeUnitLimit)&&c.computeUnitLimit>=300000&&c.computeUnitLimit<=1400000,'Invalid compute unit limit.');
  fail(Number.isInteger(c.computeUnitPriceMicroLamports)&&c.computeUnitPriceMicroLamports>=0&&c.computeUnitPriceMicroLamports<=100000,'Priority fee exceeds the private-test cap.');
  if(requirePrice){const at=Date.parse(c.priceObservedAt);fail(Number.isFinite(at)&&at<=now&&now-at<=300000,'SOL/USD snapshot must be no more than 5 minutes old.');
    const model=previewPumpTestModel({preset:'micro-test',quoteUsdMicros:c.solUsdMicros,graduationFeeBps:2885,tradeFeeBps:100});
    fail(BigInt(model.virtualBaseRaw)===VB&&BigInt(model.tokensSoldAtGraduationRaw)===CAP,'Model and reviewed program constants differ.');
    fail(BigInt(model.grossQuoteRaw)<=MAX_PRINCIPAL,'This SOL/USD snapshot would exceed the 3 SOL principal cap.');
  }
  return c;
}

/** Mandatory application gate: config cannot select an arbitrary operator, build or custody program. */
export async function verifyWebConfigBinding(c,{configDir=process.cwd(),read=readFile}={}){
  validateConfig(c);fail(c.operator===PINNED_OWNER&&c.treasury===PINNED_TREASURY&&c.programId===SEEDED_PROGRAM.programId,'Web test configuration differs from the authorized owner deployment.');
  fail(c.expectedProgramSha256===OWNER_PINS.binarySha256,'Web test binary differs from the shipped reviewed owner build.');
  const m=JSON.parse(await read(resolve(configDir,c.buildManifest),'utf8'));
  fail(m.schemaVersion===1&&m.feature==='owner-test'&&m.fixtureKeys===false&&m.bound===true&&m.deployed===true&&m.operator===c.operator&&m.treasury===c.treasury&&m.programId===c.programId,'Web test manifest is not a verified owner deployment.');
  for(const key of ['binarySha256','sourceSha256','cargoLockSha256','buildScriptSha256'])fail(m[key]===OWNER_PINS[key],'Web test manifest differs from reviewed build pins.');
  fail(m.preset==='micro-test'&&m.graduationFeeBps===2885&&m.tradeFeeBps===100&&m.maximumPrincipalLamports==='3000000000'&&m.maximumMigrationRentLamports==='100000000','Web test policy differs.');
  const b=m.binding,v=m.verification;fail(b?.cluster===c.cluster&&b.genesisHash===GENESIS[c.cluster]&&b.operator===c.operator&&b.treasury===c.treasury&&b.clientSha256===OWNER_PINS.clientSha256&&JSON.stringify(b.seededProgram)===JSON.stringify(SEEDED_PROGRAM),'Web test deployment binding differs.');
  fail(v?.readOnly===true&&v.cluster===c.cluster&&v.genesisHash===GENESIS[c.cluster]&&v.programId===c.programId&&v.operator===c.operator&&v.treasury===c.treasury&&v.binarySha256===OWNER_PINS.binarySha256&&v.deploymentSlot===c.expectedDeploymentSlot&&v.upgradeAuthority===c.expectedUpgradeAuthority,'Web test deployment verification differs.');
  const binary=await read(resolve(ROOT,'private/pump-owner-test/curve_pump_test_OWNER_REQUIRES_REVIEW.so'));fail(binary.length===m.binaryLength&&sha256(binary)===OWNER_PINS.binarySha256,'Shipped owner program bytes differ.');
  for(const [pin,path]of [['sourceSha256','src/lib.rs'],['cargoLockSha256','Cargo.lock'],['buildScriptSha256','build.rs']])fail(sha256(await read(resolve(ROOT,'contracts/curve-pump-test',path)))===OWNER_PINS[pin],'Shipped owner source differs.');
  fail(sha256(await read(resolve(ROOT,'scripts/pump-private-test.mjs')))===OWNER_PINS.clientSha256,'Shipped owner transaction client differs.');
  return {operator:c.operator,treasury:c.treasury,programId:c.programId,binarySha256:OWNER_PINS.binarySha256,cluster:c.cluster};
}

export function createRpc(config,{fetcher=fetch}={}){
  return async(method,params=[])=>{fail(METHODS.has(method),'RPC method is not allowed by this client.');
    const response=await fetcher(config.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(25000)});
    fail(response.ok,`RPC returned HTTP ${response.status}.`);const body=await response.json();fail(!body.error,`RPC rejected ${method}: ${body.error?.code??'unknown'}.`);return body.result;
  };
}
const account=async(rpc,address)=>snapshot(await rpc('getAccountInfo',[String(address),{encoding:'base64',commitment:'finalized'}]));
export async function deriveAddresses(c,poolIndex=0){
  fail(Number.isInteger(poolIndex)&&poolIndex>=0&&poolIndex<=65535,'Pool index must be an integer from 0 to 65535.');
  const operator=pk(c.operator),program=pk(c.programId),treasury=pk(c.treasury),mint=await PublicKey.createWithSeed(operator,c.mintSeed,TOKEN_PROGRAM_ID);
  const state=PublicKey.findProgramAddressSync([Buffer.from('curve'),mint.toBuffer()],program)[0],authority=PublicKey.findProgramAddressSync([Buffer.from('vault'),mint.toBuffer()],program)[0];
  const ix=Buffer.alloc(2);ix.writeUInt16LE(poolIndex);
  const pool=PublicKey.findProgramAddressSync([Buffer.from('pool'),ix,authority.toBuffer(),mint.toBuffer(),NATIVE_MINT.toBuffer()],PUMP)[0];
  const lpMint=PublicKey.findProgramAddressSync([Buffer.from('pool_lp_mint'),pool.toBuffer()],PUMP)[0];
  const ata=(mint,owner,t=TOKEN_PROGRAM_ID)=>getAssociatedTokenAddressSync(mint,owner,true,t);
  return{operator,program,treasury,mint,state,authority,baseAta:ata(mint,authority),operatorAta:ata(mint,operator),pool,lpMint,authorityWsol:ata(NATIVE_MINT,authority),authorityLp:ata(lpMint,authority,TOKEN_2022_PROGRAM_ID),poolBase:ata(mint,pool),poolQuote:ata(NATIVE_MINT,pool),event:PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],PUMP)[0]};
}
export function decodeState(a,c,addresses){
  if(!a)return null;fail(a.owner===c.programId,'Launchpad state is not owned by the pinned program.');const d=dataOf(a);
  fail(d.length===256&&d.subarray(0,8).toString()==='CRVPTEST','Invalid curve state.');
  const key=p=>new PublicKey(d.subarray(p,p+32)).toBase58(),n=p=>d.readBigUInt64LE(p);
  fail(key(16)===c.operator&&key(48)===c.treasury&&key(80)===addresses.mint.toBase58(),'Launchpad identity does not match configuration.');
  const s={phase:d[8],virtualBase:n(112),virtualQuote:n(120),cap:n(128),sold:n(136),quote:n(144),rentFloor:n(152),graduationFeeBps:n(160),tradeFeeBps:n(168),initialVirtualBase:n(176),initialVirtualQuote:n(184),burnedLp:n(192),graduationPaid:n(200),pool:key(208),poolIndex:d.readUInt16LE(240)};
  fail(s.initialVirtualBase===VB&&s.cap===CAP&&s.graduationFeeBps===2885n&&s.tradeFeeBps===100n&&s.quote<=MAX_PRINCIPAL,'Launchpad policy differs from the private microtest.');return s;
}
export async function verifyDeployment(c,rpc,{read=readFile,configDir=process.cwd(),operation}={}){
  fail(await rpc('getGenesisHash')===GENESIS[c.cluster],'RPC genesis does not match the explicitly selected network.');
  const manifest=JSON.parse(await read(resolve(configDir,c.buildManifest),'utf8'));
  fail(manifest.schemaVersion===1&&manifest.feature==='owner-test'&&manifest.fixtureKeys===false,'Reviewed owner-test build manifest required; fixture builds are forbidden.');
  fail(manifest.operator===c.operator&&manifest.programId===c.programId&&manifest.binarySha256===c.expectedProgramSha256,'Manifest identity or binary pin differs from configuration.');
  const source=await read(resolve(ROOT,'contracts/curve-pump-test/src/lib.rs')),lock=await read(resolve(ROOT,'contracts/curve-pump-test/Cargo.lock')),build=await read(resolve(ROOT,'contracts/curve-pump-test/build.rs'));
  fail(sha256(source)===manifest.sourceSha256&&sha256(lock)===manifest.cargoLockSha256&&sha256(build)===manifest.buildScriptSha256,'Manifest does not match the reviewed local contract source and lockfile.');
  fail(Number.isSafeInteger(manifest.binaryLength)&&manifest.binaryLength>0&&manifest.binaryLength<=10*1024*1024,'Invalid manifest binary length.');
  const program=await account(rpc,c.programId);fail(program?.executable&&program.owner===LOADER,'Pinned custody program is not deployed under the upgradeable loader.');
  const pd=dataOf(program);fail(pd.length===36&&pd.readUInt32LE(0)===2,'Invalid program account header.');
  const programData=new PublicKey(pd.subarray(4,36)).toBase58(),deployed=await account(rpc,programData);fail(deployed?.owner===LOADER,'ProgramData owner mismatch.');
  const bytes=dataOf(deployed);fail(bytes.length>=45+manifest.binaryLength&&bytes.readUInt32LE(0)===3,'Invalid ProgramData layout.');
  fail(bytes.readBigUInt64LE(4)===BigInt(c.expectedDeploymentSlot),'Deployment slot changed. Re-review the deployed program.');
  const authority=bytes[12]===0?null:bytes[12]===1?new PublicKey(bytes.subarray(13,45)).toBase58():'invalid';fail(authority===c.expectedUpgradeAuthority,'Upgrade authority changed.');
  fail(sha256(bytes.subarray(45,45+manifest.binaryLength))===c.expectedProgramSha256&&!bytes.subarray(45+manifest.binaryLength).some(Boolean),'Deployed program binary does not match the reviewed owner-test build.');
  // Current PumpSwap program must also match the exact binary exercised locally.
  if(operation==='sell-recovery'||operation==='receipt-reconciliation')return{programData,programSha256:c.expectedProgramSha256,deploymentSlot:c.expectedDeploymentSlot,pumpCheck:operation==='sell-recovery'?'skipped-for-pre-migration-redemption':'skipped-for-receipt-reconciliation',genesis:GENESIS[c.cluster]};
  const pump=await account(rpc,PUMP);fail(pump?.executable&&pump.owner===LOADER,'PumpSwap program is unavailable.');const pp=dataOf(pump);
  fail(pp.length===36&&pp.readUInt32LE(0)===2,'Invalid PumpSwap program header.');const pumpData=await account(rpc,new PublicKey(pp.subarray(4,36)));fail(pumpData?.owner===LOADER,'PumpSwap ProgramData owner mismatch.');
  const pumpBytes=dataOf(pumpData);fail(pumpBytes.readUInt32LE(0)===3&&sha256(pumpBytes.subarray(45))===PUMP_TEST_PAIR_PROVENANCE.programSha256,'PumpSwap changed since local compatibility testing; revalidate before funding.');
  return{programData,programSha256:c.expectedProgramSha256,deploymentSlot:c.expectedDeploymentSlot,pumpProgramSha256:PUMP_TEST_PAIR_PROVENANCE.programSha256,genesis:GENESIS[c.cluster]};
}
export async function buildOperation(c,rpc,command,{poolIndex=0}={}){
  fail(['initialize','buy-to-bond','sell-recovery','migrate'].includes(command),'Unknown operation.');
  const a=await deriveAddresses(c,poolIndex),s=decodeState(await account(rpc,a.state),c,a),ix=[];let walletDebit=0n,details={};
  const rent=async size=>{const n=await rpc('getMinimumBalanceForRentExemption',[size,{commitment:'finalized'}]);fail(Number.isSafeInteger(n)&&n>=0,'Invalid rent response.');return BigInt(n);};
  const instruction=(keys,data)=>new TransactionInstruction({programId:a.program,keys,data});
  if(command==='initialize'){
    validateConfig(c,{requirePrice:true});fail(!s&&!await account(rpc,a.mint),'Mint or curve already exists; initialization cannot repeat.');
    const model=previewPumpTestModel({preset:'micro-test',quoteUsdMicros:c.solUsdMicros,graduationFeeBps:2885,tradeFeeBps:100});
    const mintRent=await rent(82),stateRent=await rent(256),ataRent=await rent(165),floor=await rent(0),budget=BigInt(c.migrationRentLamports);
    walletDebit=mintRent+stateRent+ataRent+floor+budget;
    ix.push(SystemProgram.createAccountWithSeed({fromPubkey:a.operator,basePubkey:a.operator,seed:c.mintSeed,newAccountPubkey:a.mint,lamports:Number(mintRent),space:82,programId:TOKEN_PROGRAM_ID}),createInitializeMint2Instruction(a.mint,6,a.authority,null,TOKEN_PROGRAM_ID));
    ix.push(instruction([meta(a.operator,true,true),meta(a.state,true),meta(a.authority,true),meta(a.mint,true),meta(a.baseAta,true),meta(a.treasury),meta(SystemProgram.programId),meta(TOKEN_PROGRAM_ID),meta(ASSOCIATED_TOKEN_PROGRAM_ID)],encode(0,VB,BigInt(model.virtualQuoteRaw),CAP,budget,2885n,100n)));
    details={model,migrationRentLamports:budget.toString(),startingFdvUsd:'100',graduationFdvUsd:'500'};
  }else{
    fail(s,'Launchpad has not been initialized.');
    if(command==='buy-to-bond'||command==='sell-recovery'){
      fail(s.phase===0||(command==='sell-recovery'&&s.phase===1),'Launchpad is not in the required trading phase.');
      const owned=await account(rpc,a.operatorAta);if(!owned){fail(command==='buy-to-bond','Operator token account is missing.');ix.push(createAssociatedTokenAccountIdempotentInstruction(a.operator,a.operatorAta,a.operator,a.mint,TOKEN_PROGRAM_ID));walletDebit+=await rent(165);}
      let input,min;
      if(command==='buy-to-bond'){
        const remaining=s.cap-s.sold;fail(remaining>0n,'Launchpad is already bonded.');const net=ceil(s.virtualQuote*remaining,s.virtualBase-remaining);
        input=ceil(net*10000n,9900n);min=remaining;fail(s.quote+net<=MAX_PRINCIPAL,'Purchase exceeds 3 SOL principal cap.');walletDebit+=input;
        details={maxInputLamports:input.toString(),minimumTokenAtoms:min.toString(),curvePrincipalAfter:s.quote+net};
      }else{
        fail(owned?.owner===TOKEN_PROGRAM_ID.toBase58(),'Invalid operator token account.');const d=dataOf(owned);fail(d.length===165&&new PublicKey(d.subarray(0,32)).equals(a.mint)&&new PublicKey(d.subarray(32,64)).equals(a.operator),'Operator token account identity mismatch.');
        input=d.readBigUInt64LE(64);fail(input>0n&&input<=s.sold,'No eligible held supply to redeem.');const gross=s.virtualQuote*input/(s.virtualBase+input);fail(gross<=s.quote,'Insufficient accounted principal for recovery.');const net=gross-ceil(gross*100n,10000n);min=net*9950n/10000n;fail(min>0n,'Recovery output too small.');details={sellTokenAtoms:input.toString(),minimumLamports:min.toString(),estimatedLamports:net.toString(),notice:'Trading fees, rent and transaction fees are not refunded. Post-migration sales must use the AMM.'};
      }
      ix.push(instruction([meta(a.operator,true,true),meta(a.state,true),meta(a.authority,true),meta(a.mint),meta(a.baseAta,true),meta(a.operatorAta,true),meta(a.treasury,true),meta(SystemProgram.programId),meta(TOKEN_PROGRAM_ID)],encode(command==='buy-to-bond'?1:2,input,min)));
    }else{
      fail(s.phase===1&&s.sold===s.cap&&s.quote>0n,'Migration requires a fully bonded, unmigrated curve.');
      for(const key of [a.pool,a.lpMint,a.authorityLp])fail(!await account(rpc,key),'Pool index is already occupied. Choose another index and prepare again; do not retry a pending signature with a different index.');
      for(const key of [a.poolBase,a.poolQuote]){const x=await account(rpc,key);if(x){fail(x.owner===TOKEN_PROGRAM_ID.toBase58()&&dataOf(x).length>=165&&dataOf(x).readBigUInt64LE(64)===0n,'Destination reserve is occupied or contains a donation. Choose another pool index.');}}
      const authority=await account(rpc,a.authority);fail(authority&&BigInt(authority.lamports)>=s.quote+s.rentFloor+20000000n,'Vault migration subsidy is below 0.02 SOL; stop and inspect before funding further.');
      const data=Buffer.alloc(3);data[0]=3;data.writeUInt16LE(poolIndex,1);
      const keys=[a.operator,a.state,a.authority,a.mint,a.baseAta,a.treasury,GLOBAL,a.pool,NATIVE_MINT,a.lpMint,a.authorityWsol,a.authorityLp,a.poolBase,a.poolQuote,SystemProgram.programId,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,a.event,PUMP];
      ix.push(instruction(keys.map((key,i)=>meta(key,[0,1,2,4,5,7,9,10,11,12,13].includes(i),i===0)),data));
      const fee=ceil(s.quote*2885n,10000n);details={poolIndex,quoteBefore:s.quote.toString(),graduationFeeLamports:fee.toString(),poolQuoteLamports:(s.quote-fee).toString(),poolBaseAtoms:(SUPPLY-s.sold).toString(),lpPolicy:'Burn every LP token received in the same transaction.'};
    }
  }
  fail(walletDebit<=BigInt(c.maxWalletSpendLamports),'This operation exceeds the configured wallet spend cap.');
  return {addresses:a,state:s,instructions:ix,walletDebit,details:JSON.parse(JSON.stringify(details,(_,v)=>typeof v==='bigint'?v.toString():v))};
}
export async function prepare(c,rpc,command,{poolIndex=0,configDir=process.cwd(),read=readFile,blockhash,transactionVersion='legacy'}={}){
  validateConfig(c,{requirePrice:command==='initialize'});const deployment=await verifyDeployment(c,rpc,{configDir,read,operation:command});const plan=await buildOperation(c,rpc,command,{poolIndex});
  const latest=blockhash|| (await rpc('getLatestBlockhash',[{commitment:'finalized'}])).value;
  fail(typeof latest.blockhash==='string'&&Number.isSafeInteger(latest.lastValidBlockHeight),'Invalid blockhash response.');
  const height=await rpc('getBlockHeight',[{commitment:'finalized'}]);fail(height<=latest.lastValidBlockHeight,'Prepared transaction expired. Do not refresh a transaction with an unresolved signature.');
  fail(transactionVersion==='legacy'||transactionVersion===0,'Only legacy or v0 transaction formats are allowed.');
  const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:c.computeUnitLimit}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:c.computeUnitPriceMicroLamports}),...plan.instructions];
  const message=new TransactionMessage({payerKey:plan.addresses.operator,recentBlockhash:latest.blockhash,instructions});
  const tx=transactionVersion===0?new VersionedTransaction(message.compileToV0Message()):new Transaction({feePayer:plan.addresses.operator,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight}).add(...instructions);
  const messageBytes=transactionVersion===0?Buffer.from(tx.message.serialize()):tx.serializeMessage();
  const feeResponse=await rpc('getFeeForMessage',[messageBytes.toString('base64'),{commitment:'finalized'}]);fail(Number.isSafeInteger(feeResponse.value)&&feeResponse.value>=0,'Unable to price transaction fee.');
  const balance=(await rpc('getBalance',[c.operator,{commitment:'finalized'}])).value;fail(Number.isSafeInteger(balance),'Invalid wallet balance.');
  const total=plan.walletDebit+BigInt(feeResponse.value);fail(total<=BigInt(c.maxWalletSpendLamports),'Operation plus network fee exceeds wallet spend cap.');fail(BigInt(balance)>=total+1000000n,'Operator lacks budget plus 0.001 SOL gas reserve.');
  const raw=transactionVersion===0?Buffer.from(tx.serialize()):tx.serialize({requireAllSignatures:false,verifySignatures:false});fail(raw.length<=1232,'Transaction exceeds Solana packet size.');
  const simulation=await rpc('simulateTransaction',[raw.toString('base64'),{encoding:'base64',sigVerify:false,commitment:'finalized'}]);fail(simulation?.value&&simulation.value.err===null,'Simulation failed. No transaction has been signed or submitted.');
  return {schemaVersion:1,kind:'curve-owner-private-test',transactionVersion,command,poolIndex,cluster:c.cluster,operator:c.operator,treasury:c.treasury,programId:c.programId,configSha256:sha256(JSON.stringify(c)),deployment,blockhash:latest,addresses:Object.fromEntries(Object.entries(plan.addresses).map(([k,v])=>[k,v.toBase58()])),details:plan.details,maxWalletDebitLamports:total.toString(),walletBalanceLamports:String(balance),simulatedAt:new Date().toISOString(),computeUnits:simulation.value.unitsConsumed??null,unsignedTransaction:raw.toString('base64'),transactionSha256:sha256(raw)};
}

export async function reconcileReceipt(c,rpc,journal){
  await verifyJournal(journal,c);
  fail(journal.operator===c.operator&&journal.programId===c.programId,'Journal identity mismatch.');
  const status=(await rpc('getSignatureStatuses',[[journal.signature],{searchTransactionHistory:true}])).value?.[0];
  if(status?.err&&status.confirmationStatus==='finalized')return {state:'failed',signature:journal.signature,error:'Onchain transaction failed; no automatic replacement is created.'};
  if(!status||status.confirmationStatus!=='finalized'){
    const height=await rpc('getBlockHeight',[{commitment:'finalized'}]);return {state:height>journal.blockhash.lastValidBlockHeight?'expired-unconfirmed':'pending',signature:journal.signature,notice:'No fresh transaction will be generated automatically.'};
  }
  const receipt=await rpc('getTransaction',[journal.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]);
  fail(receipt?.meta&&receipt.meta.err===null,'Finalized receipt is unavailable or failed.');
  const wire=await rpc('getTransaction',[journal.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
  fail(wire?.meta?.err===null&&Array.isArray(wire.transaction)&&wire.transaction[0]===journal.signedTransaction,'Receipt transaction differs from the journaled signed bytes.');
  const a=await deriveAddresses(c,journal.poolIndex),s=decodeState(await account(rpc,a.state),c,a);
  fail(s,'Finalized curve state is unavailable.');
  if(journal.command==='migrate'){
    fail(s.phase===2&&s.pool===a.pool.toBase58()&&s.poolIndex===journal.poolIndex&&s.burnedLp>0n,'Migration receipt does not match saved pool/burn state.');
    const mint=await account(rpc,a.lpMint),ata=await account(rpc,a.authorityLp);
    fail(mint?.owner===TOKEN_2022_PROGRAM_ID.toBase58()&&ata?.owner===TOKEN_2022_PROGRAM_ID.toBase58(),'LP accounts have unexpected owners.');
    const md=dataOf(mint),ad=dataOf(ata);fail(md.length>=82&&ad.length>=165&&new PublicKey(ad.subarray(0,32)).equals(a.lpMint)&&new PublicKey(ad.subarray(32,64)).equals(a.authority),'Wrong LP mint or authority.');
    const keys=receipt.transaction.message.accountKeys.map(x=>typeof x==='string'?x:x.pubkey),lpIndex=keys.indexOf(a.authorityLp.toBase58());
    const post=receipt.meta.postTokenBalances?.find(x=>x.accountIndex===lpIndex&&x.mint===a.lpMint.toBase58());
    fail(lpIndex>=0&&post?.owner===a.authority.toBase58()&&post.uiTokenAmount?.amount==='0','Receipt does not show zero owned LP after the burn.');
    const instructions=(receipt.meta.innerInstructions||[]).flatMap(x=>x.instructions||[]);
    const amount=i=>i.parsed?.info?.amount??i.parsed?.info?.tokenAmount?.amount;
    const burns=instructions.filter(i=>String(i.programId)===TOKEN_2022_PROGRAM_ID.toBase58()&&['burn','burnChecked'].includes(i.parsed?.type)&&i.parsed.info.mint===a.lpMint.toBase58()&&i.parsed.info.authority===a.authority.toBase58());
    const mints=instructions.filter(i=>String(i.programId)===TOKEN_2022_PROGRAM_ID.toBase58()&&['mintTo','mintToChecked'].includes(i.parsed?.type)&&i.parsed.info.mint===a.lpMint.toBase58());
    fail(burns.length===1&&BigInt(amount(burns[0]))===s.burnedLp,'Finalized receipt does not prove the expected LP burn.');
    const issued=mints.reduce((sum,i)=>sum+BigInt(amount(i)),0n);fail(issued===s.burnedLp,'LP mint issuance and burn amount differ.');
    return {state:'finalized',signature:journal.signature,phase:s.phase,pool:s.pool,lpMint:a.lpMint.toBase58(),issuedLpAtoms:issued.toString(),burnedLpAtoms:s.burnedLp.toString(),issuedMinusBurnedLpAtoms:'0',authorityLpBalanceAtReceipt:'0',lpMintSupplyAtCheck:md.readBigUInt64LE(36).toString(),authorityLpBalanceAtCheck:ad.readBigUInt64LE(64).toString(),graduationPaidLamports:s.graduationPaid.toString()};
  }
  if(journal.command==='initialize'){const mint=await account(rpc,a.mint),d=dataOf(mint);fail(mint.owner===TOKEN_PROGRAM_ID.toBase58()&&d.length===82&&d.readBigUInt64LE(36)===SUPPLY&&d.readUInt32LE(0)===0&&d.readUInt32LE(46)===0,'Mint supply or revoked authority check failed.');}
  return {state:'finalized',signature:journal.signature,phase:s.phase,soldAtoms:s.sold.toString(),quoteLamports:s.quote.toString()};
}
/** Decode only self-contained, single-operator transactions. Address lookup tables are forbidden. */
export function inspectTransaction(encoded,operator,{requireSignature=false}={}){
  fail(typeof encoded==='string'&&encoded.length>0&&encoded.length<=1800,'Invalid transaction encoding.');
  const raw=Buffer.from(encoded,'base64');fail(raw.length<=1232&&raw.toString('base64')===encoded,'Transaction must use canonical base64 within the packet limit.');
  const tx=VersionedTransaction.deserialize(raw),message=tx.message;
  fail(tx.signatures.length===1&&message.header.numRequiredSignatures===1,'Only the pinned operator may sign.');
  fail(message.version==='legacy'||message.version===0,'Unsupported transaction version.');
  fail(message.version==='legacy'||message.addressTableLookups.length===0,'Address lookup tables are not permitted.');
  const decoded=TransactionMessage.decompile(message);fail(decoded.payerKey.toBase58()===operator,'Transaction fee payer differs from the pinned operator.');
  fail(Buffer.from(tx.serialize()).equals(raw),'Noncanonical transaction bytes.');
  const messageBytes=Buffer.from(message.serialize()),signature=Buffer.from(tx.signatures[0]);
  if(requireSignature){const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),pk(operator).toBuffer()]),format:'der',type:'spki'});fail(verifyEd25519(null,messageBytes,key,signature),'Operator transaction signature is invalid.');}
  else fail(!signature.some(Boolean),'Prepared transaction must be unsigned.');
  return {tx,messageBytes,signature,instructions:decoded.instructions,recentBlockhash:decoded.recentBlockhash,version:message.version};
}
export async function verifyJournal(journal,c){
  fail(journal?.signedTransaction&&journal.unsignedTransaction,'Journal is missing transaction evidence.');
  fail(journal.cluster===c.cluster&&journal.operator===c.operator&&journal.treasury===c.treasury&&journal.programId===c.programId&&journal.configSha256===sha256(JSON.stringify(c)),'Journal configuration binding differs.');
  const signed=inspectTransaction(journal.signedTransaction,c.operator,{requireSignature:true}),unsigned=inspectTransaction(journal.unsignedTransaction,c.operator);
  fail(signed.messageBytes.equals(unsigned.messageBytes)&&sha256(Buffer.from(journal.unsignedTransaction,'base64'))===journal.transactionSha256,'Journal signed and reviewed messages differ.');
  fail(signed.recentBlockhash===journal.blockhash?.blockhash,'Journal blockhash differs.');
  const {default:bs58}=await import('bs58');fail(bs58.encode(signed.signature)===journal.signature,'Journal signature differs from signed transaction.');
  const operations=signed.instructions.filter(x=>x.programId.toBase58()===c.programId),codes={'initialize':0,'buy-to-bond':1,'sell-recovery':2,'migrate':3};
  fail(operations.length===1&&operations[0].data[0]===codes[journal.command],'Journal operation does not match its transaction.');
  const a=await deriveAddresses(c,journal.poolIndex),keys=operations[0].keys;
  fail(keys[0]?.pubkey.equals(a.operator)&&keys[0].isSigner&&keys[1]?.pubkey.equals(a.state)&&keys[2]?.pubkey.equals(a.authority)&&keys[3]?.pubkey.equals(a.mint),'Journal curve accounts differ from configuration.');
  const treasuryIndex=journal.command==='buy-to-bond'||journal.command==='sell-recovery'?6:5;fail(keys[treasuryIndex]?.pubkey.equals(a.treasury),'Journal treasury differs.');
  if(journal.command==='migrate')fail(operations[0].data.length===3&&operations[0].data.readUInt16LE(1)===journal.poolIndex&&keys[7]?.pubkey.equals(a.pool),'Journal pool index differs.');
  return true;
}

/** Caller holds an exclusive per-mint lock. Browser bundles must come from trusted server storage. */
async function submitPrepared({config:c,rpc,bundle,sign,expectedSignedTransaction,journalStore,configDir=process.cwd(),read=readFile,acknowledgement,beforeSend=async()=>{}}){
  fail(acknowledgement==='I_ACCEPT_REAL_SOL_PRIVATE_TEST','Execution requires the exact real-SOL acknowledgement.');validateConfig(c);
  fail(bundle?.schemaVersion===1&&bundle.kind==='curve-owner-private-test'&&bundle.configSha256===sha256(JSON.stringify(c)),'Prepared bundle differs from configuration.');
  fail(sha256(Buffer.from(bundle.unsignedTransaction,'base64'))===bundle.transactionSha256,'Prepared transaction checksum differs.');
  const reviewed=inspectTransaction(bundle.unsignedTransaction,c.operator);
  const history=await journalStore.read()||{schemaVersion:1,entries:[]};fail(history.schemaVersion===1&&Array.isArray(history.entries),'Invalid journal.');
  const latest=history.entries.at(-1);
  if(latest&&!['finalized','failed'].includes(latest.state)){
    fail(latest.transactionSha256===bundle.transactionSha256,'An unresolved transaction blocks new operations. Reconcile it first.');
    await verifyJournal(latest,c);fail(inspectTransaction(latest.signedTransaction,c.operator,{requireSignature:true}).messageBytes.equals(reviewed.messageBytes),'Journal signed message differs from the prepared transaction.');
    if(expectedSignedTransaction!==undefined)fail(expectedSignedTransaction===latest.signedTransaction,'Pending retries must use the identical signed transaction.');
    await verifyDeployment(c,rpc,{read,configDir,operation:'receipt-reconciliation'});const result=await reconcileReceipt(c,rpc,latest);Object.assign(latest,result);await journalStore.write(history);
    if(result.state!=='pending')return result;
    await verifyDeployment(c,rpc,{read,configDir,operation:latest.command});await beforeSend();
    const sig=await rpc('sendTransaction',[latest.signedTransaction,{encoding:'base64',skipPreflight:false,maxRetries:0,preflightCommitment:'finalized'}]);fail(sig===latest.signature,'RPC returned an unexpected signature.');
    return {state:'submitted',signature:sig,notice:'Same signed transaction resubmitted. Run reconcile before any new operation.'};
  }
  const rebuilt=await prepare(c,rpc,bundle.command,{poolIndex:bundle.poolIndex,configDir,read,blockhash:bundle.blockhash,transactionVersion:reviewed.version});
  fail(rebuilt.unsignedTransaction===bundle.unsignedTransaction,'Account state or instructions changed. Prepare again after reconciling any previous signature.');
  const encoded=await sign(bundle.unsignedTransaction),signed=inspectTransaction(encoded,c.operator,{requireSignature:true});
  fail(signed.messageBytes.equals(reviewed.messageBytes),'Wallet changed the reviewed transaction message.');
  const {default:bs58}=await import('bs58');const signature=bs58.encode(signed.signature);
  const entry={...bundle,state:'prepared-for-send',signature,signedTransaction:encoded,journaledAt:new Date().toISOString()};await verifyJournal(entry,c);
  history.entries.push(entry);await journalStore.write(history);
  // An authorization change after signing must still prevent broadcast. Saved bytes remain reconcilable.
  await beforeSend();
  try{const returned=await rpc('sendTransaction',[entry.signedTransaction,{encoding:'base64',skipPreflight:false,maxRetries:0,preflightCommitment:'finalized'}]);fail(returned===signature,'RPC returned an unexpected signature.');entry.state='submitted';entry.sentAt=new Date().toISOString();await journalStore.write(history);return {state:'submitted',signature,notice:'Run reconcile; do not prepare the next operation until finalized.'};}
  catch(e){entry.state='submission-unknown';entry.lastError=safeError(e);await journalStore.write(history);throw Error(`Submission outcome unknown. Reconcile saved signature ${signature} before any new operation.`);}
}
/** Wallet-app path: no secret key input. Requires a trusted server-side bundle and per-mint lock. */
export async function submitSignedPlan({signedTransaction,...options}){
  const {config:c,bundle}=options;
  const signed=inspectTransaction(signedTransaction,c.operator,{requireSignature:true}),reviewed=inspectTransaction(bundle.unsignedTransaction,c.operator);
  fail(signed.messageBytes.equals(reviewed.messageBytes),'Wallet changed the reviewed transaction message.');
  return submitPrepared({...options,expectedSignedTransaction:signedTransaction,sign:async()=>signedTransaction});
}
/** Explicit local keyfile command; browser/server handlers must use submitSignedPlan instead. */
export async function executePrepared({keypairBytes,...options}){
  return submitPrepared({...options,sign:async encoded=>{
    fail(Array.isArray(keypairBytes)&&keypairBytes.length===64&&keypairBytes.every(x=>Number.isInteger(x)&&x>=0&&x<=255),'Keyfile must contain a 64-byte Solana keypair array.');
    const signer=Keypair.fromSecretKey(Uint8Array.from(keypairBytes));fail(signer.publicKey.toBase58()===options.config.operator,'Dedicated keyfile does not match the pinned operator.');
    const tx=VersionedTransaction.deserialize(Buffer.from(encoded,'base64'));tx.sign([signer]);return Buffer.from(tx.serialize()).toString('base64');
  }});
}
export async function atomicJson(path,value){
  await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=`${path}.${process.pid}.tmp`;
  const file=await open(temp,'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
  await rename(temp,path);const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
}
function parseArgs(argv){const out={command:argv[0]||'status'};for(let i=1;i<argv.length;i++){fail(argv[i].startsWith('--')&&i+1<argv.length,'Flags require a value.');out[argv[i].slice(2)]=argv[++i];}return out;}
export async function main(argv=process.argv.slice(2)){
  const args=parseArgs(argv);fail(args.config,'Use --config /absolute/path/config.json. Nothing runs without an explicit config.');
  const configPath=resolve(args.config),configDir=dirname(configPath),c=validateConfig(JSON.parse(await readFile(configPath,'utf8'))),rpc=createRpc(c);
  const a=await deriveAddresses(c,Number(args['pool-index']||0));
  const journalPath=resolve(configDir,'journal',`${c.operator}-${a.mint.toBase58()}.json`);
  const journalStore={read:async()=>{try{return JSON.parse(await readFile(journalPath,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}},write:v=>atomicJson(journalPath,v)};
  let result;
  if(args.command==='status'||args.command==='preview'){
    const deployment=await verifyDeployment(c,rpc,{configDir});const state=decodeState(await account(rpc,a.state),c,a),balance=(await rpc('getBalance',[c.operator,{commitment:'finalized'}])).value;
    result={readOnly:true,deployment,operator:c.operator,treasury:c.treasury,mint:a.mint.toBase58(),state,walletBalanceLamports:String(balance),journalPath};
    if(args.command==='preview'){validateConfig(c,{requirePrice:true});result.model=previewPumpTestModel({preset:'micro-test',quoteUsdMicros:c.solUsdMicros,graduationFeeBps:2885,tradeFeeBps:100});}
  }else if(args.command==='prepare'){
    fail(args.operation&&args.out,'prepare requires --operation and --out.');const previous=(await journalStore.read())?.entries?.at(-1);fail(!previous||['failed','finalized'].includes(previous.state),'An unresolved transaction blocks preparation; run reconcile.');
    result=await prepare(c,rpc,args.operation,{poolIndex:Number(args['pool-index']||0),configDir});await atomicJson(resolve(args.out),result);result={preparedFile:resolve(args.out),command:result.command,details:result.details,maxWalletDebitLamports:result.maxWalletDebitLamports,expiresAtBlockHeight:result.blockhash.lastValidBlockHeight,notice:'Unsigned. No funds moved. Review then invoke execute explicitly.'};
  }else if(args.command==='execute'||args.command==='reconcile'){
    await mkdir(dirname(journalPath),{recursive:true,mode:0o700});const lockPath=journalPath+'.lock',lock=await open(lockPath,'wx',0o600);
    try{
      if(args.command==='reconcile'){
        const history=await journalStore.read(),latest=history?.entries?.at(-1);fail(latest,'No transaction is journaled.');await verifyDeployment(c,rpc,{configDir,operation:'receipt-reconciliation'});result=await reconcileReceipt(c,rpc,latest);Object.assign(latest,result);await journalStore.write(history);
      }else{
        fail(args.ack==='I_ACCEPT_REAL_SOL_PRIVATE_TEST','Execution requires the exact real-SOL acknowledgement.');
        fail(args.plan&&args.keypair,'execute requires --plan and --keypair.');
        const keypath=resolve(args.keypair),info=await stat(keypath);fail(info.isFile(),'Keypair path is not a regular file.');if(process.platform!=='win32')fail((info.mode&0o077)===0,'Keyfile permissions must be 0600; do not make it public.');
        const bundle=JSON.parse(await readFile(resolve(args.plan),'utf8')),keypairBytes=JSON.parse(await readFile(keypath,'utf8'));
        try{result=await executePrepared({config:c,rpc,bundle,keypairBytes,journalStore,configDir,acknowledgement:args.ack});}finally{if(Array.isArray(keypairBytes))keypairBytes.fill(0);}
      }
    }finally{await lock.close();const {unlink}=await import('node:fs/promises');await unlink(lockPath);}
  }else throw Error('Commands: status, preview, prepare, execute, reconcile.');
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().then(result=>process.stdout.write(JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n')).catch(error=>{process.stderr.write(safeError(error)+'\n');process.exitCode=1;});
}
