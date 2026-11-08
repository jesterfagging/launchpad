import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { isCurrentLaunch } from '../public/launchpad-model.mjs';
import { SOL_MINT } from '../public/launchpad-model.mjs';
import { managedProtocolWallet, protocolWalletKey, protocolWalletSelection } from './launchpad-protocol-wallet.mjs';
import { dedicatedRewardsWallet, requireManagedRewardSource } from './launchpad-rewards-wallet.mjs';

const unavailable = () => { throw Object.assign(Error('Managed gas-wallet inventory is unavailable. No refill was authorized.'), { statusCode: 503 }); };
const address = value => {
  try { return typeof value === 'string' && new PublicKey(value).toBase58() === value ? value : null; } catch { return null; }
};
const walletAddress = value => {
  const canonical = address(value);
  return canonical && PublicKey.isOnCurve(new PublicKey(canonical).toBytes()) ? canonical : null;
};
const exposed = key => !!(key?.external || key?.exportedAt || key?.exported || key?.compromised || key?.compromisedAt);
const feeExposed = launch => !!(launch.feeWalletExported || launch.walletExported || launch.feeWalletExportedAt || launch.walletExportedAt || launch.walletCompromisedAt || launch.feeWalletCompromisedAt);
const protocolExposed = launch => !!(launch.protocolWalletExportedAt || launch.protocolWalletCompromisedAt);
const platformExposed = launch => !!(launch.platformWalletExportedAt || launch.platformWalletCompromisedAt);
const rewardsExposed = launch => !!(launch.rewardsWalletExported || launch.rewardsWalletExportedAt || launch.rewardsWalletCompromisedAt);
const managedRewardsSource = launch => { try { requireManagedRewardSource(launch); return true; } catch { return false; } };
const maxUint=2n**64n-1n,needAgeMs=10*60000;
const needAmount=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=maxUint?BigInt(value):null;
const waitingForGas=launch=>launch.state==='live'&&launch.feesRequested===true&&(Object.hasOwn(launch,'feeAutomation')?launch.feeAutomation?.enabled===true:launch.autoFees===true)&&launch.error==='Automatic rewards are waiting for SOL and will retry automatically.'&&Number.isSafeInteger(launch.rewardRetry?.at)&&launch.rewardRetry.at>=0&&Number.isSafeInteger(launch.rewardRetry?.attempt)&&launch.rewardRetry.attempt>0;
function rewardFundingNeeds(launch,now){
  const hint=launch.rewardsWallet?.gasFundingNeed;
  if(!hint||hint.version!==1||hint.creatorAddress!==launch.keys?.wallet?.address||hint.rewardsAddress!==launch.keys?.rewards?.address||!Number.isSafeInteger(hint.observedAt)||hint.observedAt<0||hint.observedAt>now||now-hint.observedAt>needAgeMs)return null;
  const creator=needAmount(hint.creatorMinimumLamports),rewards=needAmount(hint.rewardsMinimumLamports),principal=needAmount(hint.creatorPrincipalReserveLamports);
  if(creator===null||rewards===null||principal===null||![0n,10000000n].includes(rewards))return null;
  const credits=launch.rewardsWallet.creatorCredits;
  let expectedPrincipal=0n;
  if(launch.input?.route==='pump'&&launch.input?.quoteMint===SOL_MINT){
    const amounts=[credits?.quote??launch.credits?.quote??'0',credits?.protocolQuote??launch.taxProtocol?.creditQuote??'0',launch.protocolCredit||'0'].map(needAmount);
    if(amounts.some(value=>value===null))return null;
    expectedPrincipal=amounts.reduce((sum,value)=>sum+value,0n);
  }
  if(principal!==expectedPrincipal||creator!==0n&&(creator<principal+10000000n||creator>principal+50000000n))return null;
  return {creator:{version:1,minimumLamports:creator.toString(),principalReserveLamports:principal.toString(),observedAt:hint.observedAt},rewards:{version:1,minimumLamports:rewards.toString(),principalReserveLamports:'0',observedAt:hint.observedAt}};
}

function matchingSigner(key) {
  if (!walletAddress(key?.address) || typeof key.secret !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(key.secret)) return false;
  let bytes, pair;
  try {
    bytes = bs58.decode(key.secret);
    if (bytes.length !== 64) return false;
    pair = Keypair.fromSecretKey(bytes);
    return pair.publicKey.toBase58() === key.address;
  } catch { return false; }
  finally { bytes?.fill(0); pair?.secretKey.fill(0); }
}

export const METEORA_GAS_NEED = Object.freeze({ policy:'meteora-operations-v1', minimumLamports:'100000000', targetLamports:'120000000', principalReserveLamports:'0' });
function matchingMeteoraSigner(key) {
  if (!walletAddress(key?.address) || exposed(key) || typeof key.secretBase64 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(key.secretBase64)) return false;
  let bytes, pair;
  try { bytes=Buffer.from(key.secretBase64,'base64');if(bytes.length!==64||bytes.toString('base64')!==key.secretBase64)return false;pair=Keypair.fromSecretKey(Uint8Array.from(bytes));return pair.publicKey.toBase58()===key.address; }
  catch { return false; } finally { bytes?.fill(0);pair?.secretKey.fill(0); }
}

// Only the global managed signer pays Meteora operating gas. Creator claim
// balances stay in their own token ATAs; no earned principal is native SOL in
// this target. Return addresses and a fixed policy only, never private records.
export async function readMeteoraGasInventory(accounts,{maxLaunches=100000,now=Date.now()}={}) {
  let data;try{data=await accounts.hostStore?.read('meteora-launches',null);}catch{unavailable();}
  if(data===null||data===undefined)return {target:null,sourceExclusions:[],targetExclusions:[]};
  if(data?.schemaVersion!==1||!Array.isArray(data.launches)||data.launches.length>maxLaunches||!Array.isArray(data.operations)||typeof data.enabled!=='boolean')unavailable();
  const sources=new Set(),denied=new Set(),add=(set,value)=>{const valid=address(value);if(valid)set.add(valid);};
  for(const value of [data.authority?.address,data.config?.authority,data.config?.treasury])add(sources,value);
  add(denied,data.config?.treasury);
  let registered=false;
  for(const launch of data.launches){
    if(!launch||typeof launch!=='object'||Array.isArray(launch))unavailable();
    for(const value of [launch.creatorWallet,launch.creatorRecipient,launch.creatorAuthority,launch.treasury,launch.mint,launch.configAddress,...Object.values(launch.keys||{}).map(k=>k?.address)]){add(sources,value);add(denied,value);}
    add(sources,launch.partnerAuthority);
    if(exposed(launch)||launch.authorityExportedAt||launch.authorityCompromisedAt)add(denied,launch.partnerAuthority);
    if(['trading','bonded','migrated'].includes(launch.status)&&Number.isSafeInteger(launch.finalizedAt)&&launch.finalizedAt>0&&launch.finalizedAt<=now&&address(launch.mint)&&address(launch.dbcPoolId)&&launch.partnerAuthority===data.authority?.address&&launch.creatorAuthority===launch.keys?.creator?.address&&matchingMeteoraSigner(launch.keys.creator))registered=true;
  }
  const authority=data.authority;
  const eligible=registered&&data.config?.authority===authority?.address&&walletAddress(data.config?.treasury)&&matchingMeteoraSigner(authority)&&!data.authorityExportedAt&&!data.authorityCompromisedAt&&!denied.has(authority.address);
  if(!eligible)add(denied,authority?.address);
  return {target:eligible?{address:authority.address,roles:['meteora'],fundingNeed:{version:1,...METEORA_GAS_NEED,observedAt:now}}:null,sourceExclusions:[...sources],targetExclusions:[...denied]};
}

// This is a read-only allowlist, not a source of signing keys or a transaction
// builder. Call again before preparing a refill: earlier snapshots cannot prove
// that a wallet is still exclusively managed by the platform.
export async function discoverProtocolGasTargets({ accounts, launchpad, treasuryAddress, excludeAddresses = [], maxAccounts = 10000, maxLaunches = 100000, maxSettingsWallets = 100000, now=Date.now() } = {}) {
  if (!Number.isSafeInteger(now)||now<0||!walletAddress(treasuryAddress) || !Array.isArray(excludeAddresses) || excludeAddresses.some(value => !address(value))) unavailable();
  const denied = new Set([treasuryAddress, ...excludeAddresses]), launches = [], identities = new Set();
  const deny = value => { const key = address(value); if (key) denied.add(key); };
  let people, settingsWallets = 0;
  try {
    people = await accounts.list();
    if (!Array.isArray(people) || people.length > maxAccounts) unavailable();
    for (const person of people) {
      if (!person || typeof person.id !== 'string' || !person.id || identities.has(person.id)) unavailable();
      identities.add(person.id);
      for (const key of [person.mainWallet, person.signInWallet, person.cashbackWallet]) deny(key);
    }
    for (let index = 0; index < people.length; index += 8) {
      const rows = await Promise.all(people.slice(index, index + 8).map(async person => {
        const store = accounts.storeFor(person.id);
        const [book, settings] = await Promise.all([launchpad?.book ? launchpad.book(person.id) : store.read('launchpad', { launches: [] }), store.read('settings', {})]);
        if (!book || !Array.isArray(book.launches) || !settings || typeof settings !== 'object' || Array.isArray(settings) || settings.wallets !== undefined && !Array.isArray(settings.wallets)) unavailable();
        return { book, settings };
      }));
      for (const { book, settings } of rows) {
        for (const key of settings.wallets || []) {
          if (!key || typeof key !== 'object') unavailable();
          if (++settingsWallets > maxSettingsWallets) unavailable();
          deny(key.publicKey);
        }
        for (const launch of book.launches) {
          if (!launch || typeof launch !== 'object' || Array.isArray(launch)) unavailable();
          launches.push(launch);
          if (launches.length > maxLaunches) unavailable();
        }
      }
    }
  } catch { unavailable(); }

  const meteora=await readMeteoraGasInventory(accounts,{maxLaunches,now});
  for(const value of meteora.targetExclusions)deny(value);
  const candidates = new Map(),fundingNeeds=new Map(),fundingWaits=new Set();
  const add = (key, role,need,waiting=false) => {
    if (!matchingSigner(key)) { deny(key?.address); return; }
    let roles = candidates.get(key.address);
    if (!roles) { roles = new Set(); candidates.set(key.address, roles); }
    roles.add(role);
    if(waiting)fundingWaits.add(key.address);
    if(need){const previous=fundingNeeds.get(key.address);fundingNeeds.set(key.address,previous?{version:1,minimumLamports:(BigInt(previous.minimumLamports)>BigInt(need.minimumLamports)?previous.minimumLamports:need.minimumLamports),principalReserveLamports:(BigInt(previous.principalReserveLamports)>BigInt(need.principalReserveLamports)?previous.principalReserveLamports:need.principalReserveLamports),observedAt:Math.min(previous.observedAt,need.observedAt)}:need);}
  };
  for (const launch of launches) {
    const keys = launch.keys || {}, fee = keys.wallet;
    // Exposure in any journal wins over a clean-looking alias elsewhere.
    for (const [role, key] of Object.entries(keys)) {
      if (exposed(key) || role === 'wallet' && feeExposed(launch) || role === 'platform' && platformExposed(launch) || role === 'protocol' && protocolExposed(launch) || role === 'rewards' && rewardsExposed(launch)) deny(key?.address);
    }
    for (const key of [keys.mint?.address, launch.input?.externalWallet, launch.input?.recipient, launch.review?.protocolFees?.recipient]) deny(key);
    // Older creator wallets could have been exported without an audit flag.
    // Possessing their secret does not establish exclusive protocol custody.
    const managedFee = launch.feeCustody === 'relay' && fee?.secret && !exposed(fee) && !feeExposed(launch);
    if (!managedFee) deny(fee?.address);
    const rewardsState=launch.rewardsWallet,managedRewards=managedFee&&launch.input?.feeMode==='holders'&&rewardsState?.version===1&&['migrating','active'].includes(rewardsState.status)&&rewardsState.address===keys.rewards?.address&&managedRewardsSource(launch)&&dedicatedRewardsWallet(launch)&&!exposed(keys.rewards)&&!rewardsExposed(launch);
    if(keys.rewards&&!managedRewards)deny(keys.rewards.address);
    const payer = keys.payer;
    // Some older exclusively managed fee wallets also paid their own launch.
    // Only that same proven managed alias can remain a refill candidate.
    if (payer && !(managedFee && payer.address === fee.address && !exposed(payer) && matchingSigner(payer))) deny(payer.address);
    const live = isCurrentLaunch(launch.input) && Number.isSafeInteger(launch.authorizedAt) && launch.authorizedAt > 0 && address(launch.curve) && address(keys.mint?.address) && ['live', 'paused', 'error', 'pending', 'awaiting_signature'].includes(launch.state);
    if (!live || !Array.isArray(launch.operations) || launch.operations.some(op => ['create', 'launch-all', 'setup', 'platform', 'platform-setup'].includes(op?.kind) && ['pending', 'awaiting_signature'].includes(op.state))) continue;
    const needs=managedRewards?rewardFundingNeeds(launch,now):null;
    const waiting=waitingForGas(launch);
    if (managedFee && ['creator', 'holders', 'buyback'].includes(launch.input.feeMode)) add(fee, launch.input.feeMode === 'creator' ? 'fees' : 'rewards',needs?.creator,waiting);
    // The creator still pays collection/authority fees. The separate rewards
    // signer pays only its conversion and distribution operations.
    if(managedRewards)add(keys.rewards,'rewards',needs?.rewards,waiting);
    if (launch.review?.platformFeeBps === 100 && walletAddress(launch.review?.protocolFees?.recipient) && managedProtocolWallet(launch)) {
      const selection = protocolWalletSelection(launch);
      if (selection.source === 'protocol' && protocolExposed(launch) || selection.source === 'platform' && platformExposed(launch) || selection.source === 'wallet' && feeExposed(launch)) continue;
      const protocolWaiting=launch.protocolFeesRequested===true&&launch.protocolRetry?.kind==='funding'&&Number.isSafeInteger(launch.protocolRetry.at)&&launch.protocolRetry.at>=0&&Number.isSafeInteger(launch.protocolRetry.attempt)&&launch.protocolRetry.attempt>0;
      add(protocolWalletKey(launch, selection), 'protocol',null,protocolWaiting);
    }
  }
  // A shared alias with another launch's operational signer is not this
  // dedicated Meteora authority, even if both records contain valid secrets.
  if(meteora.target){if(candidates.has(meteora.target.address))deny(meteora.target.address);else{candidates.set(meteora.target.address,new Set(['meteora']));fundingNeeds.set(meteora.target.address,meteora.target.fundingNeed);}}
  return { targets: [...candidates].filter(([key]) => !denied.has(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, roles]) => ({ address: key, roles: [...roles].sort(),...(fundingNeeds.has(key)?{fundingNeed:fundingNeeds.get(key)}:{}),...(fundingWaits.has(key)?{fundingPriority:true}:{}) })) };
}
