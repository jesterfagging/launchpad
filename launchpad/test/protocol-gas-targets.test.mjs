import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { discoverProtocolGasTargets, readMeteoraGasInventory, METEORA_GAS_NEED } from '../src/protocol-gas-targets.mjs';

const key = () => { const pair=Keypair.generate();return {address:pair.publicKey.toBase58(),secret:bs58.encode(pair.secretKey)}; };
const ACCOUNT='a'.repeat(32), OTHER='b'.repeat(32), SOURCE=key().address, USER=key().address, RECIPIENT=key().address;
function launch(mode='holders') {
  const fee=key();
  return {id:'c'.repeat(32),input:{route:'raydium',network:'mainnet-beta',feeMode:mode,recipient:RECIPIENT},feeCustody:'relay',keys:{wallet:fee,platform:{...fee},mint:key(),payer:{address:USER,external:true}},authorizedAt:100,state:'live',curve:key().address,operations:[],review:{platformFeeBps:100,protocolFees:{recipient:RECIPIENT}}};
}
function fixture(records=[launch()]) {
  const people=[{id:ACCOUNT,mainWallet:USER}],books=new Map([[ACCOUNT,{launches:records}]]),settings=new Map([[ACCOUNT,{}]]);
  const accounts={list:async()=>structuredClone(people),storeFor:id=>({read:async(name,fallback)=>structuredClone(name==='settings'?settings.get(id)??fallback:books.get(id)??fallback)})};
  const launchpad={book:async id=>structuredClone(books.get(id))};
  return {people,books,settings,accounts,launchpad,read:extra=>discoverProtocolGasTargets({accounts,launchpad,treasuryAddress:SOURCE,...extra})};
}

test('only public verified managed fee, reward and active protocol roles are returned',async()=>{
  const records=['creator','holders','buyback'].map(launch),before=structuredClone(records),h=fixture(records),result=await h.read();
  assert.equal(result.targets.length,3);
  for(const record of records){const row=result.targets.find(t=>t.address===record.keys.wallet.address);assert.deepEqual(row.roles,record.input.feeMode==='creator'?['fees','protocol']:['protocol','rewards']);assert.deepEqual(Object.keys(row),['address','roles']);}
  assert.deepEqual(records,before);
  const output=JSON.stringify(result);for(const record of records)for(const signer of Object.values(record.keys))if(signer.secret)assert(!output.includes(signer.secret));
  assert(!output.includes(ACCOUNT));assert(!output.includes(USER));assert(!output.includes(RECIPIENT));
});
test('one signer shared by managed launches and roles is funded only once',async()=>{
  const first=launch('creator'),second=launch('holders');second.keys.wallet={...first.keys.wallet};second.keys.platform={...first.keys.wallet};
  assert.deepEqual((await fixture([first,second]).read()).targets,[{address:first.keys.wallet.address,roles:['fees','protocol','rewards']}]);
});
test('a proven exclusively managed historical self-payer remains eligible',async()=>{
  const record=launch();record.keys.payer={...record.keys.wallet};
  assert.deepEqual((await fixture([record]).read()).targets,[{address:record.keys.wallet.address,roles:['rewards']}]);
});
test('unknown legacy custody, exported keys, external wallets and compromised aliases never become targets',async()=>{
  const changes=[l=>delete l.feeCustody,l=>{l.feeCustody='creator';},l=>{l.keys.wallet.external=true;},l=>{l.keys.wallet.exportedAt=1;},l=>{l.keys.wallet.exported=true;},l=>{l.keys.wallet.compromisedAt=1;},l=>{l.keys.wallet.compromised=true;},l=>{l.walletExportedAt=1;},l=>{l.feeWalletExportedAt=1;},l=>{l.walletCompromisedAt=1;},l=>{l.feeWalletCompromisedAt=1;},l=>{l.keys.platform.exportedAt=1;},l=>{l.platformWalletExportedAt=1;}];
  for(const change of changes){const record=launch();change(record);assert.deepEqual((await fixture([record]).read()).targets,[]);}
});
test('missing, malformed and mismatched secrets cannot prove platform custody',async()=>{
  for(const change of [l=>delete l.keys.wallet.secret,l=>{l.keys.wallet.secret='not a private key';},l=>{l.keys.wallet.secret=bs58.encode(new Uint8Array(32));},l=>{l.keys.wallet.secret=key().secret;}]){
    const record=launch();change(record);assert.deepEqual((await fixture([record]).read()).targets,[]);
  }
});
test('personal account wallets, user settings wallets and receiving wallets are excluded across the inventory',async()=>{
  for(const location of ['mainWallet','signInWallet','cashbackWallet','settings','recipient','externalWallet','protocolRecipient']){
    const record=launch(),other=launch(),h=fixture([record,other]),target=record.keys.wallet.address;
    h.people.push({id:OTHER,mainWallet:key().address});h.books.set(OTHER,{launches:[]});
    if(location==='settings')h.settings.set(OTHER,{wallets:[{publicKey:target}]});
    else if(location==='recipient')other.input.recipient=target;
    else if(location==='externalWallet')other.input.externalWallet=target;
    else if(location==='protocolRecipient')other.review.protocolFees.recipient=target;
    else h.people[1][location]=target;
    assert(!(await h.read()).targets.some(row=>row.address===target),location);
  }
});
test('an exposed or unproven wallet in another launch cannot be admitted by a clean alias',async()=>{
  for(const reverse of [false,true])for(const role of ['wallet','payer','platform']){
    const record=launch(),other=launch();other.keys[role]={...record.keys.wallet};
    if(role==='wallet')delete other.feeCustody;else other.keys[role].external=true;
    const rows=reverse?[other,record]:[record,other];assert(!(await fixture(rows).read()).targets.some(row=>row.address===record.keys.wallet.address));
  }
});
test('only the selected separate managed protocol wallet is allowed for a legacy launch',async()=>{
  for(const role of ['platform','protocol']){
    const record=launch();delete record.feeCustody;record.keys.wallet.exportedAt=1;record.keys[role]=key();record.protocolFeeWallet={source:role,address:record.keys[role].address};
    assert.deepEqual((await fixture([record]).read()).targets,[{address:record.keys[role].address,roles:['protocol']}]);
  }
});
test('selected protocol signer must match its saved address and remain unexported and separate',async()=>{
  for(const change of [l=>{l.keys.protocol.external=true;},l=>{l.keys.protocol.exportedAt=1;},l=>{l.protocolWalletExportedAt=1;},l=>{l.protocolWalletCompromisedAt=1;},l=>{l.keys.protocol.compromised=true;},l=>{l.keys.protocol.secret=key().secret;},l=>{l.protocolFeeWallet.address=key().address;},l=>{l.review.platformFeeBps=0;}]){
    const record=launch();delete record.feeCustody;record.keys.protocol=key();record.protocolFeeWallet={source:'protocol',address:record.keys.protocol.address};change(record);
    assert.deepEqual((await fixture([record]).read()).targets,[]);
  }
});
test('unselected platform administrators and unfinished or unsupported launches are never prefunded',async()=>{
  const record=launch();record.keys.platform=key();assert(!(await fixture([record]).read()).targets.some(row=>row.address===record.keys.platform.address));
  for(const change of [l=>delete l.authorizedAt,l=>delete l.curve,l=>{l.curve='unverified';},l=>{l.input.network='devnet';},l=>{l.input.route='pump';},l=>{l.state='draft';},l=>{l.state='launching';},l=>{l.operations=[{kind:'create',state:'pending'}];},l=>{l.operations=[{kind:'launch-all',state:'awaiting_signature'}];},l=>delete l.operations]){
    const row=launch();change(row);assert.deepEqual((await fixture([row]).read()).targets,[]);
  }
});
test('source, treasury and explicit excluded addresses cannot appear in targets',async()=>{
  const record=launch(),h=fixture([record]);assert.deepEqual((await h.read({treasuryAddress:record.keys.wallet.address})).targets,[]);
  assert.deepEqual((await h.read({excludeAddresses:[record.keys.wallet.address]})).targets,[]);
});
test('unreadable or malformed inventory fails closed with a fixed message and no partial allowlist',async()=>{
  const changes=[h=>{h.accounts.list=async()=>{throw Error('PRIVATE_KEY');};},h=>{h.launchpad.book=async()=>{throw Error('PRIVATE_KEY');};},h=>{h.accounts.storeFor=()=>({read:async()=>{throw Error('PRIVATE_KEY');}});},h=>h.books.set(ACCOUNT,{launches:[launch(),null]}),h=>h.books.set(ACCOUNT,{}),h=>h.settings.set(ACCOUNT,{wallets:{}}),h=>h.people.push({...h.people[0]})];
  for(const change of changes){const h=fixture();change(h);await assert.rejects(h.read(),error=>error.statusCode===503&&error.message==='Managed gas-wallet inventory is unavailable. No refill was authorized.');}
  for(const limits of [{maxAccounts:0},{maxLaunches:0},{maxSettingsWallets:0}]){const h=fixture();h.settings.set(ACCOUNT,{wallets:[{publicKey:USER}]});await assert.rejects(h.read(limits),{statusCode:503});}
});
test('eligibility is freshly derived after later export or user-wallet changes',async()=>{
  const record=launch(),h=fixture([record]);assert.equal((await h.read()).targets.length,1);record.walletExportedAt=100;
  assert.deepEqual((await h.read()).targets,[]);delete record.walletExportedAt;h.people[0].signInWallet=record.keys.wallet.address;assert.deepEqual((await h.read()).targets,[]);
});

const withRewards=(record=launch(),status='active')=>{record.keys.rewards=key();record.rewardsWallet={version:1,status,address:record.keys.rewards.address};return record;};
test('only live automatic funding waits prioritize already-eligible creator and rewards wallets',async()=>{
  const record=withRewards();Object.assign(record,{autoFees:true,feeAutomation:{enabled:true},feesRequested:true,error:'Automatic rewards are waiting for SOL and will retry automatically.',rewardRetry:{at:1000,attempt:1,kind:'funding'}});
  assert((await fixture([record]).read()).targets.every(row=>row.fundingPriority===true));
  for(const change of [l=>{l.feeAutomation.enabled=false;},l=>{l.state='paused';},l=>{l.feesRequested=false;},l=>{l.error='other error';},l=>{l.rewardRetry.attempt=0;}]){const copy=structuredClone(record);change(copy);assert((await fixture([copy]).read()).targets.every(row=>row.fundingPriority===undefined));}
  record.keys.rewards.exported=true;assert(!(await fixture([record]).read()).targets.some(row=>row.address===record.keys.rewards.address));
});
test('dedicated holder execution wallets and original collection wallets are both refill targets',async()=>{
  for(const status of ['migrating','active']){
    const record=withRewards(launch(),status),before=structuredClone(record),result=await fixture([record]).read();
    assert.equal(result.targets.length,2);assert.deepEqual(result.targets.find(row=>row.address===record.keys.rewards.address),{address:record.keys.rewards.address,roles:['rewards']});
    assert.deepEqual(result.targets.find(row=>row.address===record.keys.wallet.address).roles,['protocol','rewards']);assert.deepEqual(record,before);assert(!JSON.stringify(result).includes(record.keys.rewards.secret));
  }
});
test('dedicated reward targets fail closed for invalid custody, state, signer and local aliases',async()=>{
  const changes=[l=>delete l.rewardsWallet,l=>{l.rewardsWallet.status='pending';},l=>{l.rewardsWallet.version=2;},l=>{l.rewardsWallet.address=key().address;},l=>{l.input.feeMode='creator';},l=>{l.keys.rewards.external=true;},l=>{l.keys.rewards.exported=true;},l=>{l.keys.rewards.exportedAt=1;},l=>{l.keys.rewards.compromised=true;},l=>{l.rewardsWalletExportedAt=1;},l=>{l.rewardsWalletCompromisedAt=1;},l=>delete l.keys.rewards.secret,l=>{l.keys.rewards.secret=key().secret;},l=>{l.feeCustody='creator';},l=>{l.keys.payer={...l.keys.rewards};},l=>{l.keys.protocol={...l.keys.rewards};}];
  for(const change of changes){const record=withRewards(),target=record.keys.rewards.address;change(record);assert(!(await fixture([record]).read()).targets.some(row=>row.address===target));}
});
test('a reward signer exposed or used personally anywhere cannot be rescued by another clean alias',async()=>{
  for(const reverse of [false,true])for(const marker of ['exported','unknown','personal']){
    const first=withRewards(),other=withRewards();other.keys.rewards={...first.keys.rewards};other.rewardsWallet.address=first.keys.rewards.address;
    if(marker==='exported')other.keys.rewards.exported=true;
    if(marker==='unknown')delete other.rewardsWallet;
    const h=fixture(reverse?[other,first]:[first,other]);if(marker==='personal')h.people[0].signInWallet=first.keys.rewards.address;
    assert(!(await h.read()).targets.some(row=>row.address===first.keys.rewards.address));
  }
});
test('duplicate managed reward recipients are funded once and later exposure removes eligibility',async()=>{
  const first=withRewards(),second=withRewards();second.keys.rewards={...first.keys.rewards};second.rewardsWallet.address=first.keys.rewards.address;
  const h=fixture([first,second]);assert.equal((await h.read()).targets.filter(row=>row.address===first.keys.rewards.address).length,1);
  first.rewardsWalletCompromisedAt=1;assert(!(await h.read()).targets.some(row=>row.address===first.keys.rewards.address));
});
test('reward targets require verified source custody and reject exposed original platform aliases',async()=>{
  for(const change of [l=>{l.keys.wallet.secret=key().secret;},l=>{l.keys.platform.exported=true;},l=>{l.platformWalletCompromisedAt=1;},l=>{l.walletExported=true;},l=>{l.rewardsWalletExported=true;}]){
    const record=withRewards(),target=record.keys.rewards.address;change(record);assert(!(await fixture([record]).read()).targets.some(row=>row.address===target));
  }
});

const fundingHint=(record,now=Date.UTC(2026,8,28))=>({version:1,creatorAddress:record.keys.wallet.address,rewardsAddress:record.keys.rewards.address,creatorMinimumLamports:'14128560',rewardsMinimumLamports:'10000000',creatorPrincipalReserveLamports:'0',observedAt:now});
test('fresh server reward requirements attach only to their exact verified managed wallets',async()=>{
  const record=withRewards(),now=Date.UTC(2026,8,28);record.rewardsWallet.gasFundingNeed=fundingHint(record,now);const before=structuredClone(record),result=await fixture([record]).read({now});
  assert.deepEqual(result.targets.find(row=>row.address===record.keys.wallet.address).fundingNeed,{version:1,minimumLamports:'14128560',principalReserveLamports:'0',observedAt:now});
  assert.deepEqual(result.targets.find(row=>row.address===record.keys.rewards.address).fundingNeed,{version:1,minimumLamports:'10000000',principalReserveLamports:'0',observedAt:now});assert.deepEqual(record,before);
});
test('stale, future, oversized and mismatched reward requirements cannot raise refill limits',async()=>{
  const now=Date.UTC(2026,8,28),patches=[{version:2},{observedAt:now-600001},{observedAt:now+1},{observedAt:'today'},{creatorAddress:USER},{rewardsAddress:RECIPIENT},{creatorMinimumLamports:'50000001'},{creatorMinimumLamports:'-1'},{creatorMinimumLamports:'1000000'},{creatorMinimumLamports:'014128560'},{rewardsMinimumLamports:'20000000'},{creatorPrincipalReserveLamports:'1'}];
  for(const patch of patches){const record=withRewards();record.rewardsWallet.gasFundingNeed={...fundingHint(record,now),...patch};const result=await fixture([record]).read({now});assert.equal(result.targets.length,2);assert(result.targets.every(row=>row.fundingNeed===undefined),JSON.stringify(patch));}
});
test('valid funding hints never admit exposed or personal reward destinations',async()=>{
  const now=Date.UTC(2026,8,28),record=withRewards();record.rewardsWallet.gasFundingNeed=fundingHint(record,now);const h=fixture([record]);h.people[0].signInWallet=record.keys.rewards.address;assert(!(await h.read({now})).targets.some(row=>row.address===record.keys.rewards.address));
  record.keys.rewards.exported=true;const result=await h.read({now});assert(result.targets.every(row=>row.fundingNeed===undefined));
});

const meteoraKey=()=>{const pair=Keypair.generate();return {address:pair.publicKey.toBase58(),secretBase64:Buffer.from(pair.secretKey).toString('base64')};};
function meteoraFixture(){
  const h=fixture([]),authority=meteoraKey(),creator=meteoraKey(),now=Date.UTC(2026,8,29);
  const data={schemaVersion:1,enabled:false,authority,config:{authority:authority.address,treasury:RECIPIENT},operations:[],launches:[{mint:key().address,dbcPoolId:key().address,status:'trading',finalizedAt:now-1000,partnerAuthority:authority.address,creatorAuthority:creator.address,creatorWallet:USER,creatorRecipient:USER,treasury:RECIPIENT,keys:{creator,mint:meteoraKey(),config:meteoraKey()}}]};
  h.accounts.hostStore={read:async(name,fallback)=>name==='meteora-launches'?structuredClone(data):fallback};
  return {...h,data,authority,creator,now,read:extra=>h.read({now,...extra})};
}
test('Meteora admits only its proven global gas authority, never creator fee balances or private keys',async()=>{
  const h=meteoraFixture(),before=structuredClone(h.data),result=await h.read();
  assert.deepEqual(result.targets,[{address:h.authority.address,roles:['meteora'],fundingNeed:{version:1,...METEORA_GAS_NEED,observedAt:h.now}}]);
  assert.deepEqual(h.data,before);assert(!JSON.stringify(result).includes(h.authority.secretBase64));assert(!JSON.stringify(result).includes(h.creator.secretBase64));
  const inventory=await readMeteoraGasInventory(h.accounts,{now:h.now});assert(inventory.sourceExclusions.includes(h.authority.address));assert(inventory.sourceExclusions.includes(h.creator.address));assert(!inventory.targetExclusions.includes(h.authority.address));
});
test('Meteora requires a registered finalized launch and freshly matching unexposed authority',async()=>{
  const changes=[h=>h.data.launches=[],h=>h.data.launches[0].status='draft',h=>delete h.data.launches[0].finalizedAt,h=>h.data.launches[0].finalizedAt=h.now+1,h=>delete h.data.launches[0].dbcPoolId,h=>h.data.launches[0].partnerAuthority=key().address,h=>h.data.config.authority=key().address,h=>h.data.authority.secretBase64=meteoraKey().secretBase64,h=>h.data.authority.secretBase64+='\n',h=>h.data.authority.external=true,h=>h.data.authority.exportedAt=1,h=>h.data.authority.compromised=true,h=>h.data.authorityExportedAt=1,h=>h.data.authorityCompromisedAt=1,h=>h.data.launches[0].keys.creator.exported=true];
  for(const change of changes){const h=meteoraFixture();change(h);assert.deepEqual((await h.read()).targets,[]);}
});
test('Meteora source, treasury, personal, creator and other managed signer collisions are never refilled',async()=>{
  const changes=[h=>h.data.config.treasury=h.authority.address,h=>h.data.launches[0].creatorRecipient=h.authority.address,h=>h.data.launches[0].creatorWallet=h.authority.address,h=>h.data.launches[0].keys.config={...h.authority},h=>h.people[0].signInWallet=h.authority.address,h=>h.settings.set(ACCOUNT,{wallets:[{publicKey:h.authority.address}]}),h=>{const l=launch();l.keys.wallet={address:h.authority.address,secret:bs58.encode(Buffer.from(h.authority.secretBase64,'base64'))};l.keys.platform={...l.keys.wallet};h.books.set(ACCOUNT,{launches:[l]});}];
  for(const change of changes){const h=meteoraFixture();change(h);assert(!(await h.read()).targets.some(row=>row.address===h.authority.address));}
  const h=meteoraFixture();assert.deepEqual((await h.read({treasuryAddress:h.authority.address})).targets,[]);assert.deepEqual((await h.read({excludeAddresses:[h.authority.address]})).targets,[]);
});
test('unreadable Meteora inventory cannot return a partial gas allowlist',async()=>{
  const h=meteoraFixture();h.accounts.hostStore.read=async()=>{throw Error('private payload');};await assert.rejects(h.read(),{statusCode:503});
  for(const patch of [{schemaVersion:2},{launches:{}},{launches:[null]},{operations:null}]){const h=meteoraFixture();Object.assign(h.data,patch);await assert.rejects(h.read(),{statusCode:503});}
});

test('manual protocol funding waits prioritize only the selected eligible signer even with rewards paused',async()=>{
  const record=launch('creator');record.state='paused';record.autoFees=false;record.feeAutomation={enabled:false};record.keys.protocol=key();record.protocolFeeWallet={source:'protocol',address:record.keys.protocol.address};record.protocolFeesRequested=true;record.protocolRetry={at:1000,attempt:1,kind:'funding'};
  let rows=(await fixture([record]).read()).targets;assert.equal(rows.find(row=>row.address===record.keys.protocol.address).fundingPriority,true);assert.equal(rows.find(row=>row.address===record.keys.wallet.address).fundingPriority,undefined);
  record.keys.protocol.exportedAt=1;rows=(await fixture([record]).read()).targets;assert(!rows.some(row=>row.address===record.keys.protocol.address));
});
