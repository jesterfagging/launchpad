import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { atomicWrite } from './telegram-store.mjs';
import { DammPumpTestService } from './damm-pump-test-service.mjs';
import { DammPumpTestClientAdapter } from './damm-pump-test-chain.mjs';

const fail=message=>{throw Object.assign(Error(message),{statusCode:409});};

export function createDammPumpTestMetadataPublisher({accounts,launches,publicUrl}){
  return async({accountId,mint,name,symbol,description,image,website,twitter,telegram})=>{
    let origin;try{const url=new URL(publicUrl);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error();origin=url.origin;}catch{fail('Configure the public HTTPS address before launching a private test.');}
    try{if(new PublicKey(mint).toBase58()!==mint)throw Error();}catch{fail('Invalid private test mint.');}
    const imagePath=image||'/brand-icon.svg';
    if(image){if(!/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(image))fail('Choose an uploaded token image or leave it blank for the Launchpad icon.');await launches.ownedImage(accountId,image.split('/').at(-1));}
    const metadata={name,symbol,description:description||'Owner-only Launchpad PumpSwap graduation test.',image:origin+imagePath,external_url:website||origin,
      extensions:{...(website?{website}:{}),...(twitter?{twitter}:{}),...(telegram?{telegram}:{})},properties:{files:[{uri:origin+imagePath,type:imagePath.endsWith('.svg')?'image/svg+xml':imagePath.endsWith('.png')?'image/png':imagePath.endsWith('.jpg')?'image/jpeg':'image/webp'}],category:'image'}};
    const folder=join(accounts.dir,'token-metadata'),file=join(folder,mint+'.json'),encoded=JSON.stringify(metadata);await mkdir(folder,{recursive:true});
    let saved;try{saved=await readFile(file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(saved!==undefined&&saved!==encoded)fail('This test mint already has different published metadata.');
    if(saved===undefined){await atomicWrite(file,encoded);const directory=await open(folder,'r');try{await directory.sync();}finally{await directory.close();}}
    return origin+'/token-metadata/'+mint+'.json';
  };
}

/** Reuses offered mint compatibility and quote references, never production
 * launch/configuration stores. Tiny-price geometry is checked independently. */
export function createDammPumpTestIntegration({accounts,productionService,requireOwner,publishMetadata,rpcUrl,rpcGate,adapter:providedAdapter,now=Date.now}){
  const adapter=providedAdapter||new DammPumpTestClientAdapter({rpcUrl,rpcGate,now});
  const price=mint=>productionService.getQuotePrice(mint);
  const testPair=async pair=>{
    if(!pair?.launchReady)return pair;
    let reference;try{reference=await price(pair.mint);}catch{return {...pair,launchReady:false,supported:false,testModelVerified:false,supportReason:'A fresh quote price is needed to verify this small test pool.'};}
    try{
      const usd=Number(reference?.usd);
      if(reference?.stale||reference?.mint&&reference.mint!==pair.mint||!Number.isFinite(usd)||usd<=0||!Number.isSafeInteger(reference?.at)||reference.at>now()+5000||now()-reference.at>60000)throw Error('A fresh quote price is needed to verify this small test pool.');
      const micros=Math.round(usd*1e6);if(!Number.isSafeInteger(micros)||micros<1)throw Error('This quote price is outside the supported test range.');
      adapter.model({quoteMint:pair.mint,quoteDecimals:pair.decimals,quoteTokenProgram:pair.tokenProgram||pair.quoteTokenProgram,priceSnapshot:{quoteUsdMicros:String(micros)}});
      return {...pair,launchReady:true,testModelVerified:true};
    }catch(error){return {...pair,launchReady:false,supported:false,testModelVerified:false,supportReason:error.message||'This quote cannot represent the $50 / $100 private test pool.'};}
  };
  // Listing the admin panel must not fetch a live USD price for every offered
  // asset. Compatibility comes from the existing shared catalogue; the chosen
  // asset alone gets a fresh price and tiny-pool geometry check during prepare.
  const listPairs=async()=> (await productionService.listPairs()).map(pair=>({...pair,testModelVerified:false,testModelNotice:'The $50 / $100 pool size is checked when you review this pair.'}));
  const service=new DammPumpTestService({accounts,requireOwner,adapter,now,publishMetadata,getQuotePrice:price,listPairs,quoteEligibility:async mint=>testPair(await productionService.quoteEligibility(mint))});
  return {service,adapter,start(){service.start();},async stop(){await service.stop();}};
}
