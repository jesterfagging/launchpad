import {requireValue as ok} from '../public/launchpad-model.mjs';

// The fee recipient and platform administrator are different roles. Legacy
// upgrades may provision a new recipient without changing the original admin
// or creator identity. Only the recipient is used for later collection.
export const protocolWalletSelection=launch=>launch.protocolFeeWallet||{source:'wallet',address:launch.keys.wallet.address};
export function protocolWalletKey(launch,selection=protocolWalletSelection(launch)){
  ok(selection&&['wallet','platform','protocol'].includes(selection.source),'The protocol wallet selection is invalid.');
  const key=launch.keys?.[selection.source];
  ok(key?.address&&key.address===selection.address,'The saved protocol wallet no longer matches its signing key.');
  return key;
}
export const protocolWalletView=(launch,selection=protocolWalletSelection(launch))=>({...launch,keys:{...launch.keys,wallet:protocolWalletKey(launch,selection)}});
const compromised=key=>!!(key?.compromised||key?.compromisedAt);
export function dedicatedProtocolWallet(launch,{requireSecret=true}={}){
  const key=launch.keys?.protocol;
  return !!(key?.address&&(!requireSecret||key.secret)&&!key.external&&!key.exportedAt&&!compromised(key)&&!launch.protocolWalletExportedAt&&!['wallet','platform','payer'].some(role=>launch.keys?.[role]?.address===key.address));
}

export function separatePlatformWallet(launch,{requireSecret=true}={}){
  const key=launch.keys?.platform;
  return !!(key?.address&&(!requireSecret||key.secret)&&!key.external&&!key.exportedAt&&!compromised(key)&&!launch.platformWalletCompromisedAt&&!launch.platformWalletExportedAt&&key.address!==launch.keys.wallet.address&&key.address!==launch.keys.payer?.address);
}
export function managedProtocolWallet(launch,{requireSecret=true}={}){
  try{
    const selection=protocolWalletSelection(launch),key=protocolWalletKey(launch,selection);
    if(selection.source==='protocol')return dedicatedProtocolWallet(launch,{requireSecret});
    if(selection.source==='platform')return separatePlatformWallet(launch,{requireSecret});
    return !!(launch.feeCustody==='relay'&&(!requireSecret||key.secret)&&!key.external&&!key.exportedAt&&!compromised(key)&&!launch.feeWalletExportedAt&&!launch.walletExportedAt&&key.address!==launch.keys.payer?.address);
  }catch{return false;}
}
export function legacyProtocolUpgrade(launch){
  try{
    return launch.feeCustody!=='relay'&&!launch.protocolFeeWallet&&!(launch.review?.platformFeeBps||0)&&['protocolCredit','protocolBaseCredit','protocolClaimed','protocolBaseClaimed','protocolPaid','protocolBasePaid'].every(key=>BigInt(launch[key]||'0')===0n);
  }catch{return false;}
}
export function protocolActivationWallet(launch,target){
  const current=protocolWalletSelection(launch),selection=target?.protocolFeeWallet||current;
  protocolWalletKey(launch,selection);
  if(selection.source==='protocol'){
    ok(dedicatedProtocolWallet(launch,{requireSecret:false}),'The upgrade requires its saved, separate protocol fee wallet.');
    const admin=launch.keys.platform||launch.keys.wallet;
    ok(!admin.external&&!compromised(admin)&&!launch.platformWalletCompromisedAt&&!(admin.address===launch.keys.wallet.address&&launch.walletCompromisedAt),'The original platform administrator is unavailable for this upgrade.');
    ok(current.source==='protocol'&&current.address===selection.address||legacyProtocolUpgrade(launch),'This launch cannot move its existing protocol credits to another wallet.');
  }else if(selection.source==='platform'){
    ok(separatePlatformWallet(launch,{requireSecret:false}),'The protocol upgrade requires a separate, unexported platform administrator.');
    ok(current.source==='platform'&&current.address===selection.address||legacyProtocolUpgrade(launch),'This launch cannot move its existing protocol credits to another wallet.');
  }else ok(launch.feeCustody==='relay'&&selection.address===current.address,'This legacy launch needs its separate platform administrator for protocol fees.');
  return selection;
}

// Activation is paid and signed by the old administrator; a newly assigned
// recipient need not hold SOL or appear in the transaction account keys.
export function protocolActivationSigner(launch,target){
  const selection=protocolActivationWallet(launch,target);
  if(selection.source!=='protocol')return selection;
  const source=launch.keys.platform?'platform':'wallet';
  return {source,address:launch.keys[source].address};
}
