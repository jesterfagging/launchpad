const LIVE=new Set(['trading','bonded','migrated']);
const SETTLED=new Set(['finalized','failed','expired','cancelled']);
const text=(value,max=300)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,max):'';
const time=value=>Number.isSafeInteger(value)&&value>=0?value:null;

export function publicPumpVisible(launch){return LIVE.has(launch.status)&&launch.moderation?.hidden!==true&&launch.listArchive?.archived!==true;}
export function publicPumpLive(launch){return LIVE.has(launch.status);}
export function pumpArchiveView(launch,operations=[]){
  const hidden=launch.moderation?.hidden===true,manuallyArchived=launch.listArchive?.archived===true,listArchived=hidden||manuallyArchived;
  const created=LIVE.has(launch.status)||operations.some(op=>op.mint===launch.mint&&op.action==='initialize'&&['confirmed','finalized'].includes(op.state));
  const pending=operations.some(op=>op.mint===launch.mint&&!SETTLED.has(op.state));
  const archiveReason=hidden?'This coin is hidden from public lists. An administrator can restore its visibility.':manuallyArchived?'This request is in Archived tokens.':created?'This token was created. Live tokens can be hidden from public lists by an administrator.':pending?'Wait for the launch transaction or wallet request to finish before archiving it.':'';
  return {hidden,manuallyArchived,listArchived,canArchive:!listArchived&&!created&&!pending,canRestore:manuallyArchived&&!hidden,archiveReason,archiveAt:time(manuallyArchived?launch.listArchive?.at:hidden?launch.moderation?.at:null)};
}

// A field-by-field administrator projection. Never include the public-custody
// journal, configuration, relayer key, transaction bytes or arbitrary reviews.
export function pumpAdminRow(account,launch,operations=[]){
  const view=pumpArchiveView(launch,operations),pending=operations.find(op=>op.mint===launch.mint&&!SETTLED.has(op.state));
  const unavailable='This Pump launch uses its onchain creator recipient. Raydium fee routing and reward actions do not apply.';
  return {route:'pumpswap',platform:'pumpswap',accountId:launch.creatorId,username:text(account?.username,32),id:launch.id,mint:launch.mint,network:'mainnet-beta',name:text(launch.name,100),symbol:text(launch.symbol,24),createdAt:time(launch.createdAt),state:launch.status,...view,
    quoteMint:'So11111111111111111111111111111111111111112',quoteSymbol:'SOL',recipient:launch.creatorWallet,feeMode:'creator',feeCustody:'program',feeWallet:launch.custodyAuthority||'',rewardsWallet:null,
    eligibility:{allowed:false,reason:unavailable},rewardsAction:{kind:null,allowed:false,reason:unavailable,busy:false,autoFees:false},rewardsAutomation:{allowed:false,enabled:false,reason:unavailable,pending:false,needed:false},
    serviceError:'',serviceStage:'',pendingOperation:pending?{kind:pending.action,state:pending.state,signature:typeof pending.signature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(pending.signature)?pending.signature:'',createdAt:time(pending.createdAt),reason:''}:null,rewardRetry:null,deferredRewards:{wallets:0,amount:'0'},credits:{quote:null,base:null},rewardHistory:[],history:[]};
}

export function setPumpArchive(launch,operations,{archived,actorId,at}){
  const view=pumpArchiveView(launch,operations);
  if(view.manuallyArchived===archived&&!view.hidden)return false;
  if(archived?!view.canArchive:!view.canRestore)throw Object.assign(Error(view.archiveReason||'Refresh this request before changing its archive status.'),{statusCode:409});
  const event={archived,actorId,at};launch.listArchive=event;launch.listArchiveHistory=[...(launch.listArchiveHistory||[]),event];return true;
}
