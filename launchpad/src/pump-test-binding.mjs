#!/usr/bin/env node
/** Read-only chain verification and local config binding. No keys, signing or deployment. */
import {readFile,open,mkdir,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const HERE=dirname(fileURLToPath(import.meta.url)),BUNDLE=resolve(HERE,'..');
export const OWNER='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS';
export const TREASURY='HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF';
export const SEEDED_PROGRAM=Object.freeze({base:OWNER,seed:'launchpad-program-5',owner:'BPFLoaderUpgradeab1e11111111111111111111111',programId:'4SG2WEqAqnt6orNUqcEZdVYoKJQAFT3VLvEdKi7uAYqm'});
export const GENESIS=Object.freeze({'mainnet-beta':'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','devnet':'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'});
export const PINS=Object.freeze({
  binarySha256:'369b562857a6e7ca1e91e3cefef128885419488b1f7a951a3324d24934a47114',
  sourceSha256:'89f71660c41c868d5ca31b5decbc86dad1cd9772681b2b2178787289b00c5594',
  cargoLockSha256:'37bbcf587dacd85294dd479e3eba942ab23afe4de2c4ed0a815ddffa68665b4b',
  buildScriptSha256:'fc4c59719b3a1d1d9a09451b801b0f374960b5323cfae2002a09cbb015c2bb63',
  clientSha256:'b2fdf2e6287e2aabcc19b64661b26c7e5f2d75daccc10350c9d1cc803178522e',
});
const LOADER='BPFLoaderUpgradeab1e11111111111111111111111',BINARY_FILE='artifacts/curve_pump_test_OWNER_REQUIRES_REVIEW.so';
const ensure=(ok,message)=>{if(!ok)throw Error(message);};
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=bytes=>{try{return JSON.parse(String(bytes));}catch{throw Error('Invalid local JSON configuration.');}};
export function rpcUrl(value){let u;try{u=new URL(value);}catch{throw Error('RPC URL is invalid.');}ensure(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash,'Use an HTTPS RPC URL without embedded user/password or a fragment.');return value;}
function publicKey(value,PublicKey,label){try{ensure(typeof value==='string'&&new PublicKey(value).toBase58()===value,`Invalid ${label}.`);return new PublicKey(value);}catch{throw Error(`Invalid ${label}.`);}}
export function validateProgramId(value,PublicKey){const key=publicKey(value,PublicKey,'program public ID');ensure(PublicKey.isOnCurve(key.toBytes()),'The locally generated program public ID must be on-curve.');ensure(![OWNER,TREASURY,LOADER,'11111111111111111111111111111111','pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA','TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(value),'Program public ID must be a new distinct deployment identity.');return key;}
function verifyManifestPolicy(m){
 ensure(m?.schemaVersion===1&&m.feature==='owner-test'&&m.fixtureKeys===false,'Only the reviewed real-owner build is accepted.');
 ensure(m.operator===OWNER&&m.treasury===TREASURY,'Owner/treasury identity differs from the authorized build.');
 for(const key of ['binarySha256','sourceSha256','cargoLockSha256','buildScriptSha256'])ensure(m[key]===PINS[key],`Reviewed ${key} pin differs.`);
 ensure(/^[a-f0-9]{64}$/.test(PINS.binarySha256),'The owner binary has not been sealed into this helper.');
 ensure(m.binaryFile===BINARY_FILE&&Number.isSafeInteger(m.binaryLength)&&m.binaryLength>0&&m.binaryLength<10*1024*1024,'Invalid owner binary metadata.');
 ensure(m.preset==='micro-test'&&m.graduationFeeBps===2885&&m.tradeFeeBps===100&&m.maximumPrincipalLamports==='3000000000'&&m.maximumMigrationRentLamports==='100000000','Private microtest policy differs.');
}
export async function inspectLocalMaterial({clientRoot,bundleRoot=BUNDLE,read=readFile}){
 const manifest=json(await read(resolve(bundleRoot,'owner-build-unbound.json')));verifyManifestPolicy(manifest);
 ensure(manifest.programId===null&&manifest.bound===false&&manifest.deployed===false,'Package build manifest must remain unbound and undeployed.');
 const binary=await read(resolve(bundleRoot,BINARY_FILE));ensure(binary.length===manifest.binaryLength&&hash(binary)===PINS.binarySha256,'Packaged owner binary does not match its reviewed pin.');
 const files=[['sourceSha256','src/lib.rs'],['cargoLockSha256','Cargo.lock'],['buildScriptSha256','build.rs']];
 for(const [pin,path]of files)ensure(hash(await read(resolve(clientRoot,'contracts/curve-pump-test',path)))===PINS[pin],`Extracted runner ${path} differs from reviewed source.`);
 ensure(hash(await read(resolve(clientRoot,'scripts/pump-private-test.mjs')))===PINS.clientSha256,'Install the corrected owner-bundle client into the extracted runner scripts folder first.');
 return {manifest,binary};
}
export function createBinding({manifest,programId,cluster,PublicKey,now=new Date().toISOString()}){
 verifyManifestPolicy(manifest);ensure(manifest.programId===null&&manifest.bound===false&&manifest.deployed===false,'Input must be the original unbound owner manifest.');
 validateProgramId(programId,PublicKey);ensure(Object.hasOwn(GENESIS,cluster),'Select mainnet-beta or devnet explicitly.');
 return {...manifest,programId,bound:true,deployed:false,binding:{schemaVersion:1,cluster,genesisHash:GENESIS[cluster],operator:OWNER,treasury:TREASURY,boundAt:now,clientSha256:PINS.clientSha256}};
}
export async function createSeededBinding({manifest,cluster,PublicKey,now=new Date().toISOString()}){
 verifyManifestPolicy(manifest);ensure(manifest.programId===null&&manifest.bound===false&&manifest.deployed===false,'Input must be the original unbound owner manifest.');ensure(Object.hasOwn(GENESIS,cluster),'Select mainnet-beta or devnet explicitly.');
 const programId=(await PublicKey.createWithSeed(new PublicKey(SEEDED_PROGRAM.base),SEEDED_PROGRAM.seed,new PublicKey(SEEDED_PROGRAM.owner))).toBase58();ensure(programId===SEEDED_PROGRAM.programId,'Seeded program derivation differs.');
 return {...manifest,programId,bound:true,deployed:false,binding:{schemaVersion:1,cluster,genesisHash:GENESIS[cluster],operator:OWNER,treasury:TREASURY,boundAt:now,clientSha256:PINS.clientSha256,seededProgram:{...SEEDED_PROGRAM}}};
}
async function verifyProgramIdentity(binding,PublicKey){
 const proof=binding.binding?.seededProgram;
 if(!proof)return validateProgramId(binding.programId,PublicKey);
 ensure(JSON.stringify(proof)===JSON.stringify(SEEDED_PROGRAM),'Seeded program proof differs from the fixed owner derivation.');
 ensure(binding.programId===SEEDED_PROGRAM.programId&&(await PublicKey.createWithSeed(new PublicKey(OWNER),SEEDED_PROGRAM.seed,new PublicKey(LOADER))).toBase58()===binding.programId,'Program public ID differs from its pinned owner seed.');return new PublicKey(binding.programId);
}
export function pendingConfig(binding,manifestPath){
 return {schemaVersion:1,cluster:binding.binding.cluster,rpcUrl:binding.binding.cluster==='mainnet-beta'?'https://api.mainnet-beta.solana.com':'https://api.devnet.solana.com',operator:OWNER,treasury:TREASURY,programId:binding.programId,expectedProgramSha256:PINS.binarySha256,expectedDeploymentSlot:null,expectedUpgradeAuthority:OWNER,buildManifest:manifestPath,mintSeed:'curve-owner-micro-001',graduationFeeBps:2885,tradeFeeBps:100,migrationRentLamports:'100000000',maxWalletSpendLamports:'3300000000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:1000,solUsdMicros:null,priceObservedAt:null};
}
export function readOnlyRpc(url,{fetcher=fetch}={}){
 rpcUrl(url);return async(method,params=[])=>{
  ensure(['getGenesisHash','getAccountInfo'].includes(method),'Only read-only genesis/account RPC methods are allowed.');
  let response,body;try{response=await fetcher(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(25000)});body=await response.json();}catch{throw Error(`Read-only RPC ${method} failed; endpoint details withheld.`);}
  ensure(response.ok&&!body.error,`Read-only RPC ${method} was rejected; endpoint details withheld.`);return body.result;
 };
}
function accountBytes(result,label){
 ensure(result&&Number.isSafeInteger(result.context?.slot)&&result.context.slot>=0&&result.value,`${label} is missing or has no finalized context.`);
 const a=result.value;ensure(Array.isArray(a.data)&&a.data[1]==='base64'&&typeof a.data[0]==='string',`${label} has invalid account data.`);return {account:a,bytes:Buffer.from(a.data[0],'base64'),slot:result.context.slot};
}
export async function verifyBinding({binding,programId,binary,rpc,PublicKey,now=new Date().toISOString()}){
 verifyManifestPolicy(binding);ensure(binding.bound===true&&binding.deployed===false&&binding.programId===programId,'Verify requires the exact prebound public program ID.');
 await verifyProgramIdentity(binding,PublicKey);const b=binding.binding;
 ensure(b?.schemaVersion===1&&b.operator===OWNER&&b.treasury===TREASURY&&b.clientSha256===PINS.clientSha256&&Object.hasOwn(GENESIS,b.cluster)&&b.genesisHash===GENESIS[b.cluster],'Binding metadata or genesis identity differs.');
 ensure(binary.length===binding.binaryLength&&hash(binary)===PINS.binarySha256,'Local owner binary differs.');
 ensure(await rpc('getGenesisHash')===GENESIS[b.cluster],'RPC returned the wrong full genesis hash; truncated chain IDs are not accepted.');
 const fetchAccount=(key,minContextSlot,header=false)=>rpc('getAccountInfo',[key,{encoding:'base64',commitment:'finalized',...(minContextSlot===undefined?{}:{minContextSlot}),...(header?{dataSlice:{offset:0,length:45}}:{})}]);
 const p=accountBytes(await fetchAccount(programId),'Program');ensure(p.account.owner===LOADER&&p.account.executable===true&&p.bytes.length===36&&p.bytes.readUInt32LE(0)===2,'Program is not a valid deployed upgradeable program.');
 const programData=new PublicKey(p.bytes.subarray(4,36)).toBase58(),expected=PublicKey.findProgramAddressSync([new PublicKey(programId).toBuffer()],new PublicKey(LOADER))[0].toBase58();ensure(programData===expected,'ProgramData address is not the canonical loader PDA.');
 const d=accountBytes(await fetchAccount(programData,p.slot),'ProgramData');ensure(d.slot>=p.slot,'ProgramData observation predates Program.');ensure(d.account.owner===LOADER&&d.account.executable===false&&d.bytes.length>=45+binary.length&&d.bytes.readUInt32LE(0)===3,'Invalid deployed ProgramData.');
 const deployedSlot=d.bytes.readBigUInt64LE(4);ensure(deployedSlot<=BigInt(d.slot),'Deployment slot is newer than the finalized observation.');
 const authority=d.bytes[12]===0?null:d.bytes[12]===1?new PublicKey(d.bytes.subarray(13,45)).toBase58():'invalid';ensure(authority===null||authority===OWNER,'Upgrade authority is neither the pinned owner nor revoked.');
 ensure(d.bytes.subarray(45,45+binary.length).equals(binary)&&!d.bytes.subarray(45+binary.length).some(Boolean),'Deployed bytes differ from the reviewed owner binary.');
 const check=accountBytes(await fetchAccount(programData,d.slot,true),'ProgramData recheck');ensure(check.slot>=d.slot,'ProgramData recheck predates first observation.');ensure(check.account.owner===LOADER&&check.bytes.equals(d.bytes.subarray(0,45)),'Deployment header changed while verifying.');
 const programCheck=accountBytes(await fetchAccount(programId,check.slot),'Program recheck');ensure(programCheck.slot>=check.slot,'Program recheck predates ProgramData.');ensure(programCheck.account.owner===LOADER&&programCheck.account.executable===true&&programCheck.bytes.equals(p.bytes),'Program identity changed while verifying.');
 const verified={verifiedAt:now,cluster:b.cluster,genesisHash:GENESIS[b.cluster],programId,programData,operator:OWNER,treasury:TREASURY,binarySha256:PINS.binarySha256,binaryLength:binary.length,deploymentSlot:deployedSlot.toString(),upgradeAuthority:authority,finalizedObservationSlot:programCheck.slot,readOnly:true,signed:false,submitted:false};
 return {manifest:{...binding,deployed:true,verification:verified},verification:verified};
}
export async function writeExclusiveJson(path,value){
 await mkdir(dirname(path),{recursive:true,mode:0o700});const file=await open(path,'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
}
function parseArgs(argv){const command=argv[0],allowed=new Set(['client-root','out-dir','program-id','cluster','binding','rpc-url-file']);const options={command};ensure(['bind','verify'].includes(command),'Use bind or verify; neither command signs or submits.');for(let i=1;i<argv.length;i+=2){const name=argv[i]?.slice(2);ensure(argv[i]?.startsWith('--')&&allowed.has(name)&&argv[i+1]&&!Object.hasOwn(options,name),'Invalid or repeated helper argument.');options[name]=argv[i+1];}return options;}
export async function main(argv=process.argv.slice(2)){
 const args=parseArgs(argv);ensure(args['client-root']&&args['out-dir']&&args['program-id'],'Supply --client-root, --out-dir and your locally generated --program-id PUBLIC ID.');
 const clientRoot=resolve(args['client-root']),out=resolve(args['out-dir']),require=createRequire(resolve(clientRoot,'package.json')),{PublicKey}=require('@solana/web3.js');
 const {manifest,binary}=await inspectLocalMaterial({clientRoot});const boundPath=resolve(out,'owner-build-bound.json'),finalManifest=resolve(out,'owner-build-manifest.json');
 if(args.command==='bind'){
  ensure(args.cluster&&!args.binding&&!args['rpc-url-file'],'bind requires an explicit --cluster and no RPC/binding input.');
  const binding=createBinding({manifest,programId:args['program-id'],cluster:args.cluster,PublicKey});
  await writeExclusiveJson(boundPath,binding);await writeExclusiveJson(resolve(out,'config.pending.json'),pendingConfig(binding,finalManifest));
  return {bound:true,deploymentVerified:false,operator:OWNER,treasury:TREASURY,programId:binding.programId,bindingFile:boundPath,notice:'Local public-ID binding only. Pending config cannot execute. No network calls or funds moved.'};
 }
 ensure(args.binding&&!args.cluster,'verify requires --binding; its cluster is already pinned.');
 const binding=json(await readFile(resolve(args.binding)));let url=binding.binding?.cluster==='mainnet-beta'?'https://api.mainnet-beta.solana.com':'https://api.devnet.solana.com';
 if(args['rpc-url-file']){const file=resolve(args['rpc-url-file']),info=await stat(file);ensure(info.isFile(),'RPC URL file is not a regular file.');if(process.platform!=='win32')ensure((info.mode&0o077)===0,'RPC credential file permissions must be 0600.');url=(await readFile(file,'utf8')).trim();}
 const verified=await verifyBinding({binding,programId:args['program-id'],binary,rpc:readOnlyRpc(url),PublicKey});
 const config={...pendingConfig(binding,finalManifest),rpcUrl:url,expectedDeploymentSlot:verified.verification.deploymentSlot,expectedUpgradeAuthority:verified.verification.upgradeAuthority};
 // Config is written last; existing files are never overwritten or silently rebound.
 await writeExclusiveJson(finalManifest,verified.manifest);await writeExclusiveJson(resolve(out,'deployment-verification.json'),verified.verification);await writeExclusiveJson(resolve(out,'config.json'),config);
 return {...verified.verification,manifestFile:finalManifest,configFile:resolve(out,'config.json'),notice:'Deployment verified read-only. SOL/USD input and the existing client checks still precede any separately requested test transaction.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(x=>process.stdout.write(JSON.stringify(x,null,2)+'\n')).catch(e=>{process.stderr.write(String(e.message||'Configuration failed.').replace(/https?:\/\/\S+/g,'[redacted RPC]').slice(0,500)+'\n');process.exitCode=1;});
