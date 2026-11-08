import { LAUNCH_ASSETS } from '../public/launch-assets.mjs';
import { launchpadEnv } from './brand-env.mjs';
import { monitorAllowed } from './session-diagnostics.mjs';
import { readCustomPairs } from './launchpad-custom-pairs.mjs';
import { buildPumpTestPairCatalogue } from './pump-test-pairs.mjs';
import { previewPumpTestModel } from './pump-test-model.mjs';

const SOL = 'So11111111111111111111111111111111111111112';
const fail = (message, statusCode=400) => { throw Object.assign(new Error(message), {statusCode}); };
const limits = Object.freeze({graduationFeeBps:{min:2885,max:2885},tradeFeeBps:{min:0,max:300}});
const flags = Object.freeze({enabled:true,mode:'local-test',network:'none',fundedLaunchEnabled:false,publicLaunchEnabled:false});
const verification = Object.freeze({model:'tested',custody:'tested',migration:'tested',lpBurn:'tested',poolCompatibility:'tested',independentAudit:'pending'});
const blockers = Object.freeze([
  'This calculator is a simulation. Separate owner-only funded controls require a verified deployment and an explicit wallet approval for each action.',
  'The private funded test requires the pinned operator wallet, a matching program build and a verified deployment. Installing this update alone does not deploy or fund a program.',
  'Local custody, migration and burn checks passed. They do not constitute a professional audit; public release requires further independent review.',
  'Other pairs have exact-mint local PumpSwap compatibility evidence only. Custom bonding custody for those quote tokens is not implemented.',
  'Quote prices are manual assumptions. Production needs validated pricing, current mint checks and transaction simulation.'
]);
const integer = (value,name,max) => {
  if(typeof value==='string' && /^(0|[1-9]\d{0,3})$/.test(value)) value=Number(value);
  if(!Number.isSafeInteger(value)||value<0||value>max)fail(`${name} must be a whole number from 0 to ${max} basis points.`);
  return value;
};

// A read-only service: receives no runtime, signer, RPC, transaction sender or
// launch mutation dependency. Access policy is separate from the reusable UI.
// There is intentionally no environment flag that enables funded/public mode.
export class PumpTestService {
  constructor({accounts,ownerId=launchpadEnv('PUMP_TEST_OWNER_ID')||'',assets=LAUNCH_ASSETS}) {
    this.accounts=accounts; this.ownerId=ownerId; this.assets=assets;
  }
  async requireOwner(session) {
    if(!monitorAllowed(session)||session.account.banned)fail('Private owner testing requires an administrator session with two-factor verification.',403);
    const admins=(await this.accounts.list()).filter(account=>account.role==='admin'&&!account.banned);
    const owner=this.ownerId ? admins.find(account=>account.id===this.ownerId) : admins.length===1 ? admins[0] : null;
    // A verified administrator who is not the configured owner: an owner-only feature, not lost access.
    if(!owner||owner.id!==session.account.id||!owner.mfaEnabled)throw Object.assign(new Error('This test mode is available only to the configured platform owner.'),{statusCode:403,code:'OWNER_ONLY'});
    return owner;
  }
  async read(session) {
    await this.requireOwner(session);
    return {...flags,access:'owner-only',scope:'local arithmetic preview and offline program research',limits,verification,blockers};
  }
  async pairs(session) {
    await this.requireOwner(session);
    const custom=this.accounts.hostStore ? await readCustomPairs(this.accounts) : {assets:[]};
    const unique=new Map(this.assets.map(asset=>[asset.mint,asset]));
    for(const asset of custom.assets)if(!unique.has(asset.mint))unique.set(asset.mint,asset);
    const result=buildPumpTestPairCatalogue({assets:[...unique.values()].map(asset=>({...asset,id:asset.mint}))});
    await this.requireOwner(session);
    return {...result,...flags};
  }
  async preview(session,input) {
    await this.requireOwner(session);
    if(!input||typeof input!=='object'||Array.isArray(input))fail('A preview input is required.');
    const allowed=new Set(['quoteId','quoteUsdMicros','solUsdMicros','graduationFeeBps','tradeFeeBps','preset']);
    if(Object.keys(input).some(key=>!allowed.has(key)))fail('Unexpected preview input. No account, authority or transaction settings can be supplied.');
    const quoteId=input.quoteId??SOL;
    if(typeof quoteId!=='string'||quoteId.length>44)fail('Invalid quote asset.');
    const catalogue=await this.pairs(session),pair=catalogue.pairs.find(asset=>asset.id===quoteId);
    if(!pair?.testSelectable||!pair.poolCompatible)fail('This exact mint is not verified for the private PumpSwap preview.');
    if(input.solUsdMicros!==undefined&&quoteId!==SOL)fail('SOL price can only be used with the SOL quote asset.');
    if(input.solUsdMicros!==undefined&&input.quoteUsdMicros!==undefined&&input.solUsdMicros!==input.quoteUsdMicros)fail('Conflicting price assumptions.');
    const price=input.quoteUsdMicros??input.solUsdMicros;
    if(typeof price!=='string'||!/^[1-9]\d{0,12}$/.test(price)||BigInt(price)>1000000000000n)fail('Enter a positive quote/USD assumption up to $1,000,000, in integer millionths.');
    if(integer(input.graduationFeeBps,'Graduation fee',3000)!==2885)fail('The selected graduation fee is 28.85% (2885 basis points).');
    let model;
    try { model=previewPumpTestModel({preset:input.preset??'standard',
      graduationFeeBps:integer(input.graduationFeeBps,'Graduation fee',3000),
      tradeFeeBps:integer(input.tradeFeeBps,'Trading fee',300),
      quoteUsdMicros:price,quoteDecimals:pair.decimals,quoteSymbol:pair.symbol,quoteMint:pair.mint
    }); } catch(error) { fail(error.message); }
    await this.requireOwner(session);
    const raw=model.tokensForPoolRaw.padStart(7,'0');
    return {...flags,preset:model.preset,startingFdvUsd:model.startingFdvUsd,graduationFdvUsd:model.graduationFdvUsd,verification,blockers,quote:{id:pair.id,mint:pair.mint,symbol:pair.symbol,decimals:pair.decimals},
      estimate:{quoteCollectedUsd:model.grossQuoteUsd,graduationFeeUsd:model.graduationFeeUsd,lpQuoteUsd:model.quoteInPoolUsd,
        lpTokenValueUsd:model.tokensInPoolUsd,lpTotalUsd:model.totalLpUsd,poolOpeningFdvUsd:model.actualPoolOpeningFdvUsd,
        lpQuoteAmount:model.netQuote,lpTokenAmount:raw.slice(0,-6)+'.'+raw.slice(-6),quoteSymbol:pair.symbol,
        ...(quoteId===SOL?{lpQuoteSol:model.netQuote}:{}),assumption:model.assumption},model};
  }
}
