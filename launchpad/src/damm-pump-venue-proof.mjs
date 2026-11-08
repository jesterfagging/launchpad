/** Read-only identity gate for the actual venue ELFs exercised by offline VM tests. */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const MAX_TTL = 300_000;
const caches = new WeakMap(), running = new WeakMap();
export const DAMM_PUMP_VENUE_PROOFS = Object.freeze([
  {name:'DAMM v2',programId:'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',programData:'AUh8bm2XsMfex3KjYGcM3G4uBqUNSDw6HEhWaWMYnyPH',deploymentSlot:'445230614',bytes:2174352,sha256:'4d5b920baebc090f89b2e8796a3452ed067c9667a143058c96a312f2c1e6848b'},
  {name:'PumpSwap',programId:'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',programData:'6naEzKeUuFh1Jeeu51NXQgr5qkXgXtc9WKNct4xynVJc',deploymentSlot:'446462733',bytes:10485715,sha256:'feb2ec72199f35999bbfd26ada811a37d297464ab265c78593b2d4717d7d42b5'},
  {name:'Pump fees',programId:'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',programData:'75Uu23mqWBb8LM8vDppqC1mQAnCcBuLXhVaDezVMQLRw',deploymentSlot:'446465969',bytes:948944,sha256:'4a6e66093305f8a7cb9ca6e4f47c7de726b590dd2be0d5413ce408feba27c8a5'},
].map(Object.freeze));
const ensure = (condition, detail) => { if (!condition) throw Object.assign(Error(`${detail} The venue changed or could not be verified against the reviewed executable. New launches and graduation are waiting for compatibility review.`),{statusCode:409,code:'DAMM_VENUE_PROOF'}); };
const owner = account => account?.owner?.toBase58?.();
const bytes = account => Buffer.from(account?.data||[]);
const slot = (response, minimum=0) => { ensure(Number.isSafeInteger(response?.context?.slot)&&response.context.slot>=minimum&&Array.isArray(response.value),'The venue RPC snapshot is outdated.'); return response.context.slot; };

async function headers(connection, minimum=0) {
  const keys=DAMM_PUMP_VENUE_PROOFS.flatMap(p=>[new PublicKey(p.programId),new PublicKey(p.programData)]);
  const response=await connection.getMultipleAccountsInfoAndContext(keys,{commitment:'finalized',minContextSlot:minimum,dataSlice:{offset:0,length:45}});
  const observed=slot(response,minimum);ensure(response.value.length===keys.length,'The venue account response is incomplete.');
  const identities=[];
  for(let i=0;i<DAMM_PUMP_VENUE_PROOFS.length;i++) {
    const proof=DAMM_PUMP_VENUE_PROOFS[i],program=response.value[i*2],data=response.value[i*2+1],p=bytes(program),d=bytes(data);
    ensure(owner(program)===LOADER&&program.executable===true&&p.length===36&&p.readUInt32LE(0)===2&&new PublicKey(p.subarray(4,36)).toBase58()===proof.programData,`${proof.name} program identity differs.`);
    ensure(owner(data)===LOADER&&data.executable===false&&d.length===45&&d.readUInt32LE(0)===3&&d.readBigUInt64LE(4).toString()===proof.deploymentSlot&&[0,1].includes(d[12]),`${proof.name} deployment differs.`);
    identities.push(d.toString('hex'));
  }
  return {slot:observed,identities};
}

async function verify(connection, now, ttl) {
  ensure(await connection.getGenesisHash()===MAINNET,'The venue RPC is not Solana mainnet.');
  const cached=caches.get(connection),current=await headers(connection,cached?.slot||0),time=now();
  ensure(Number.isFinite(time),'The venue verification clock is invalid.');
  if(cached&&time>=cached.at&&time-cached.at<ttl&&current.identities.every((x,i)=>x===cached.identities[i]))return {verified:true,slot:current.slot,verifiedAt:cached.at,cached:true};
  // Full ProgramData responses are base64-encoded by RPC. Together these
  // reviewed executables exceed the transport's 16 MiB response limit, while
  // each individual account fits. Keep the shared transport limit intact.
  let observed=current.slot;
  for(let i=0;i<DAMM_PUMP_VENUE_PROOFS.length;i++) {
    const proof=DAMM_PUMP_VENUE_PROOFS[i];
    const response=await connection.getMultipleAccountsInfoAndContext([new PublicKey(proof.programData)],{commitment:'finalized',minContextSlot:observed});
    observed=slot(response,observed);ensure(response.value.length===1,'The venue executable response is incomplete.');
    const account=response.value[0],data=bytes(account);
    ensure(owner(account)===LOADER&&account.executable===false&&data.length===45+proof.bytes&&data.subarray(0,45).toString('hex')===current.identities[i]&&createHash('sha256').update(data.subarray(45)).digest('hex')===proof.sha256,`${proof.name} executable differs.`);
  }
  const after=await headers(connection,observed);
  ensure(after.identities.every((x,i)=>x===current.identities[i]),'A venue changed during verification.');
  caches.set(connection,{at:time,slot:after.slot,identities:after.identities});
  return {verified:true,slot:after.slot,verifiedAt:time,cached:false};
}

/** Coalesces concurrent checks; every check re-reads finalized loader headers. */
export async function verifyDammPumpVenues({connection,now=Date.now,cacheTtlMs=MAX_TTL}) {
  ensure(connection&&typeof connection==='object'&&typeof now==='function','The venue connection is unavailable.');
  ensure(Number.isInteger(cacheTtlMs)&&cacheTtlMs>=0&&cacheTtlMs<=MAX_TTL,'The venue cache lifetime is invalid.');
  if(running.has(connection))return running.get(connection);
  const pending=verify(connection,now,cacheTtlMs).catch(error=>{caches.delete(connection);if(error?.code==='DAMM_VENUE_PROOF')throw error;throw Object.assign(Error('The venue RPC verification is temporarily unavailable. Try again shortly; compatibility checks will run again before a launch or graduation.'),{statusCode:503,code:'DAMM_VENUE_RPC',retryable:true});}).finally(()=>running.delete(connection));
  running.set(connection,pending);return pending;
}
