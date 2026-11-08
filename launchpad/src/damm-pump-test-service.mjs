import { PublicKey } from '@solana/web3.js';
import { DammPumpService, DAMM_PUMP_DEFAULTS, DAMM_PUMP_TREASURY } from './damm-pump-service.mjs';
import { DAMM_PUMP_FEE_DEFAULTS } from './damm-pump-fee-chain.mjs';
import { monitorAllowed } from './session-diagnostics.mjs';

export const DAMM_PUMP_TEST_OWNER = '7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS';
export const DAMM_PUMP_TEST_DEFAULTS = Object.freeze({...DAMM_PUMP_FEE_DEFAULTS,initialFdvUsd:50,graduationFdvUsd:100});
const fail=(message,statusCode=403)=>{throw Object.assign(Error(message),{statusCode});};
const json=value=>JSON.parse(JSON.stringify(value,(_,item)=>typeof item==='bigint'?String(item):item));

/** Same transaction lifecycle, separate controller binding, relayer and encrypted
 * history. Request bodies cannot select this service or change its economics. */
export class DammPumpTestService extends DammPumpService {
  constructor(options){
    // The owner-only private test route stays available after public launches closed.
    super({...options,newLaunchesEnabled:true,getCreationFee:async()=>({lamports:'0',recipient:DAMM_PUMP_TREASURY})});
    this.storeName='damm-pump-test';this.defaults=DAMM_PUMP_TEST_DEFAULTS;
  }
  async authorize(session,context,wallet=null){
    if(!context?.sessionToken||typeof context.authorize!=='function')fail('A current owner session is required.');
    const current=await context.authorize();
    if(!current?.account?.id||current.account.id!==session?.account?.id)fail('The owner session changed. Sign in again.');
    if(!monitorAllowed(current)||current.account.banned)fail('Private PumpSwap testing requires an administrator with two-factor authentication.');
    if(typeof this.requireOwner!=='function')fail('The platform owner has not been configured.');
    await this.requireOwner(current);
    // A password + MFA owner session may connect this signing wallet without
    // changing the account's sign-in wallet. Exact transaction signatures still
    // prove control of the one controller-authorized creator wallet.
    if(wallet&&wallet!==DAMM_PUMP_TEST_OWNER)fail('Connect the fixed owner wallet for this private PumpSwap test.');
    return current;
  }
  async ownerStatus(session,context){
    const status=await super.ownerStatus(session,context);await this.authorize(session,context);
    return {...status,adminTest:true,private:true,network:'mainnet-beta',ownerWallet:DAMM_PUMP_TEST_OWNER,creationFeeLamports:'0',defaults:this.defaults,label:'Private PumpSwap test: $50 start / $100 graduation'};
  }
  publicLaunch(launch){const value=super.publicLaunch(launch);return value?{...value,adminTest:true,private:true,platform:'damm-pump-test',launchMode:'damm-pump-test',image:value.image||'/brand-icon.svg'}:null;}
  async listAccount(session,context){await this.authorize(session,context);const result=await super.listAccount(session);await this.authorize(session,context);return result;}
  // Defense in depth: this store is never a public discovery or revenue source.
  async publicList(){return [];}
  async analyticsList(){return [];}
  async publicDetail(){return null;}
  async analyticsTrades(){return {trades:[],complete:false};}
  async market(session,input,context){
    await this.authorize(session,context);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='mint'))fail('Choose a saved private test token.',400);
    let mint;try{mint=new PublicKey(input.mint).toBase58();if(mint!==input.mint)throw Error();}catch{fail('Choose a valid private test token mint.',400);}
    const data=await this.load(),launch=data.launches.find(row=>row.mint===mint&&row.creatorId===session.account.id&&row.creatorWallet===DAMM_PUMP_TEST_OWNER);
    if(!launch)fail('Private test token not found.',404);
    const config=this.configForLaunch(data,launch);
    const market=launch.status==='draft'?null:await this.adapter.marketSnapshot(config,launch,await this.getQuotePrice(launch.quoteMint,launch).catch(()=>null));
    const state=launch.status==='draft'?null:await this.adapter.state(config,launch);
    const migration=state?.phase==='migrated'?{baseMigratedRaw:state.baseMigrated,quoteMigratedRaw:state.quoteMigrated,burnedLpRaw:state.burnedLp,poolId:state.poolId||state.pool,quoteUsdMicros:state.quoteUsdMicros,graduationFeeRaw:state.graduationFeePaidRaw,grossQuoteRaw:state.expectedQuote}:null;
    const buyToGraduationRaw=state&&state.phase==='trading'&&typeof this.adapter.buyToGraduationRaw==='function'?await this.adapter.buyToGraduationRaw(config,launch):null;
    await this.authorize(session,context);
    return {adminTest:true,launch:this.publicLaunch(launch),market,migration,buyToGraduationRaw,priceReference:launch.priceSnapshot?json(launch.priceSnapshot):null,burnReceipt:launch.burnReceipt?json(launch.burnReceipt):null,migrationSignature:launch.migrationSignature||null,operations:data.operations.filter(op=>op.mint===mint&&(op.ownerId===session.account.id||op.ownerId===null)).slice(-100).map(op=>this.publicOperation(op,launch))};
  }
}
