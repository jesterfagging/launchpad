import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { isCurrentLaunch } from '../public/launchpad-model.mjs';
import { LaunchProtocolFees } from './launchpad-protocol-fees.mjs';
import { brandName, publicOrigin } from './brand.mjs';
import { tenantConfig, brandFile } from './tenant/config.mjs';

/**
 * The platform attribution a new launch carries onchain (LaunchLab platform config) and in its metadata: the platform's
 * name (LAUNCHPAD_BRAND_NAME, "Launchpad" by default), its public address (LAUNCHPAD_PUBLIC_URL) and the logo published
 * there. A white-label launchpad (LAUNCHPAD_PRODUCT=tenant) carries its own name and logo. Without a public address the
 * attribution carries the name alone.
 */
export function platformBrand(env = process.env) {
  const tenant = tenantConfig(env), web = publicOrigin(env);
  if (tenant) return Object.freeze({ version: 'tenant-v1-' + tenant.slug, name: tenant.name, web, img: web ? web + (tenant.logo ? '/brand/logo-512.png' : '/brand/mark.svg') : '' });
  return Object.freeze({ version: 'brand-v1', name: brandName(env), web, img: web ? web + '/brand-avatar.png' : '' });
}
/** True when a recorded attribution names the platform as it is configured now (the image may be its uploaded copy). */
export function currentPlatformBrand(value, env = process.env) {
  const brand = platformBrand(env);
  return !!value && value.version === brand.version && value.name === brand.name && value.web === brand.web;
}
/** The logo file uploaded as a launch's platform image: the launchpad's own on a white-label launchpad, Launchpad's elsewhere. */
export function platformLogoFile(env = process.env) {
  if (!tenantConfig(env)) return fileURLToPath(new URL('../public/brand-icon.png', import.meta.url));
  return brandFile('logo-512.png', env);
}
// Queued updates keep their reviewed target when the logo's uploaded copy changes; a renamed or moved platform needs a
// new review.
export function validPlatformBrandTarget(target, env = process.env){
  const brand=platformBrand(env);
  return currentPlatformBrand(target,env)&&(target.img===brand.img||/^https:\/\/gateway\.irys\.xyz\/[A-Za-z0-9_-]{32,44}$/.test(target.img));
}
const fail=(message,statusCode=400)=>{throw Object.assign(Error(message),{statusCode});};
const validId=value=>{if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))fail('Invalid account or launch ID.');return value;};
const validRequest=value=>typeof value==='string'&&/^[a-f0-9-]{16,64}$/.test(value);
const pending=launch=>(launch.operations||[]).find(op=>op.kind==='platform-brand-update'&&op.state==='pending');
export function platformBrandEligibility(launch,{shared=false,personal=false}={}){
  const reject=reason=>({allowed:false,reason}),wallet=launch.keys?.wallet,admin=launch.keys?.platform||wallet;
  if(!isCurrentLaunch(launch.input)||!launch.curve||!launch.authorizedAt)return reject('A verified live Solana launch is required.');
  if(launch.feeCustody!=='relay'||!wallet?.secret||wallet.external||!admin?.secret||admin.external)return reject('This launch requires its dedicated platform administrator signing key.');
  if(shared||personal||wallet.address===launch.keys?.payer?.address)return reject('Shared or personal platform keys cannot be updated here.');
  if(launch.feeWalletExportedAt||launch.walletExportedAt||wallet.exportedAt||admin.exportedAt)return reject('An exported platform key cannot be updated here.');
  // A saved rewards cycle or queued fee request is not a transaction in flight.
  // Platform work runs at a receipt boundary without discarding that reward work.
  if(launch.brandingRequested||launch.protocolFeesRequested||(launch.operations||[]).some(op=>['pending','awaiting_signature'].includes(op.state)))return reject('Wait for the current platform or rewards transaction to finish.');
  return {allowed:true,reason:''};
}
function publicBrand(value){return value?{version:value.version,name:value.name,web:value.web,img:value.img}:null;}

// Only mutable LaunchLab platform attribution is updated. This service never
// rewrites a creator's token name, ticker, image, immutable metadata, signed
// storage item, launch review, transaction bytes or fee policy.
export class LaunchBranding {
  constructor({accounts,launchpad,now=Date.now}){this.accounts=accounts;this.launchpad=launchpad;this.now=now;this.authority=new LaunchProtocolFees({accounts,launchpad,now});}
  async target(rows){
    let hash;try{hash=createHash('sha256').update(await readFile(new URL('../public/brand-icon.png',import.meta.url))).digest('hex');}catch{}
    if(hash)for(const {l}of rows){const brand=l.review?.platformBrand,storage=l.storage;
      if(!currentPlatformBrand(brand)||storage?.platformLogoSha256!==hash||storage.platformImage!==brand.img)continue;
      const uploaded=(storage.items||[]).find(item=>item.state==='uploaded'&&brand.img==='https://gateway.irys.xyz/'+item.id);
      if(uploaded)return {...platformBrand(),img:brand.img};
    }
    return {...platformBrand()};
  }
  row(account,launch,context){const op=pending(launch);return {accountId:account.id,id:launch.id,name:launch.input.name,symbol:launch.input.symbol,mint:launch.keys.mint.address,feeWallet:launch.keys.wallet.address,currentBrand:publicBrand(launch.platformBrand||launch.review?.platformBrand),status:op?'pending':launch.brandingRequested?'queued':currentPlatformBrand(launch.platformBrand||launch.review?.platformBrand)?'updated':'legacy',eligibility:platformBrandEligibility(launch,context),error:launch.brandingError||'',updatedAt:launch.platformBrand?.updatedAt||null,signature:launch.platformBrand?.signature||op?.signature||null};}
  async list(actorId){await this.authority.requireAdmin(actorId);const {rows,context}=await this.authority.inventory(),brand=await this.target(rows);await this.authority.requireAdmin(actorId);return {brand,requiresPublishedLogo:!!brand.web&&brand.img.startsWith(brand.web+'/'),coins:rows.filter(({l})=>isCurrentLaunch(l.input)&&l.curve).map(({account,l})=>this.row(account,l,context(l)))};}
  async update(actorId,{accountId,id,launchId,requestId,reason,confirmPublishedLogo}={}){
    await this.authority.requireAdmin(actorId);validId(accountId);const lid=validId(id||launchId);
    if(!validRequest(requestId))fail('A unique branding request ID is required.');
    if(typeof reason!=='string'||reason.trim().length<5||reason.trim().length>500)fail('Enter a branding update reason between 5 and 500 characters.');
    const result=await this.launchpad.locked(accountId,async book=>{
      const actor=await this.authority.requireAdmin(actorId),account=await this.accounts.get(accountId),launch=this.launchpad.find(book,lid),{rows,context}=await this.authority.inventory({accountId,book});
      const scope=context(launch),prior=(launch.brandingRequests||[]).find(row=>row.requestId===requestId);
      if(prior){if(prior.actorId!==actorId)fail('This request ID belongs to another administrator.',409);await this.authority.requireAdmin(actorId);return {coin:this.row(account,launch,scope),alreadyRequested:true};}
      const eligible=platformBrandEligibility(launch,scope);if(!eligible.allowed)fail(eligible.reason,409);
      const brand=await this.target(rows);
      if(brand.web&&brand.img.startsWith(brand.web+'/')&&confirmPublishedLogo!==true)fail('Publish '+new URL(brand.web).host+' and its logo before applying this onchain branding update.');
      await this.authority.requireAdmin(actorId);
      launch.brandingUpdate={target:brand};launch.brandingRequested=true;launch.brandingError='';
      launch.brandingRequests=[...(launch.brandingRequests||[]),{requestId,actorId,actor:actor.username,at:this.now(),reason:reason.trim(),target:publicBrand(brand)}];
      await this.launchpad.save(accountId,book);return {coin:this.row(account,launch,scope),alreadyRequested:false};
    });this.launchpad.known.add(accountId);this.launchpad.kick(accountId);return result;
  }
}
