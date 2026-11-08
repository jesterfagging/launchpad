import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Keypair,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {PumpPublicService,PUMP_PUBLIC_TREASURY} from '../src/pump-public-service.mjs';
import {LaunchpadAdmin} from '../src/launchpad-admin.mjs';
import {AdminPanel} from '../src/admin-panel.mjs';
import {AdminVolume} from '../src/admin-volume.mjs';

const ADMIN='a'.repeat(32),OWNER='b'.repeat(32),OTHER='c'.repeat(32),NOW=1790600000000;
const key=()=>Keypair.generate().publicKey.toBase58();
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-pump-moderation-')),wallet=Keypair.generate(),mint=key(),program=Keypair.generate().publicKey;
  const people=new Map([[ADMIN,{id:ADMIN,username:'administrator',role:'admin',mfaEnabled:true,mainWallet:key()}],[OWNER,{id:OWNER,username:'originalcreator',role:'user',mainWallet:wallet.publicKey.toBase58()}],[OTHER,{id:OTHER,username:'other',role:'user',mainWallet:key()}]]);
  let db={schemaVersion:1,config:{programId:program.toBase58(),treasury:PUMP_PUBLIC_TREASURY,cluster:'mainnet-beta',relayer:key()},relayer:{address:'',secretBase64:'PRIVATE_RELAYER_SECRET'},enabled:true,migrationCursor:0,launches:[{id:randomUUID(),mint,name:'COFFEECAT',symbol:'COFFEE',creatorId:OWNER,creatorWallet:wallet.publicKey.toBase58(),status:'trading',createdAt:NOW-1000,custodyAuthority:key(),stateAddress:key(),publicProgramId:program.toBase58(),priceSnapshot:{usd:'150',solUsdMicros:'150000000',at:NOW},metadataUri:'https://example.test/metadata',creatorFeesPending:'100',creatorFeesPaid:'200',privateSecret:'PRIVATE_LAUNCH_SECRET'}],operations:[{id:randomUUID(),mint,action:'initialize',state:'finalized',ownerId:OWNER,signature:'2'.repeat(88),signedTransaction:'PRIVATE_SIGNED_WIRE',bundle:{privateSecret:'PRIVATE_BUNDLE'}}]};db.relayer.address=db.config.relayer;
  const observations={reads:0,writes:0,prepared:0,sent:0},accounts={dir,get:async id=>structuredClone(people.get(id)),list:async()=>structuredClone([...people.values()]),hostStore:{read:async()=>{observations.reads++;return structuredClone(db);},write:async(_n,value)=>{observations.writes++;db=structuredClone(value);}}};
  const adapter={verifyDeployment:async()=>({enabled:true}),balance:async()=>'10000000',prepare:async()=>{observations.prepared++;const instruction=new TransactionInstruction({programId:program,keys:[{pubkey:wallet.publicKey,isSigner:true,isWritable:true}],data:Buffer.from([2])}),tx=new VersionedTransaction(new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:key(),instructions:[instruction]}).compileToV0Message());return {unsignedTransaction:Buffer.from(tx.serialize()).toString('base64'),needsRelayer:false,review:{},preparedAt:NOW};},send:async()=>{observations.sent++;throw Error('No broadcasts in moderation test');}};
  const service=new PumpPublicService({accounts,adapter,now:()=>NOW});service.closed=true;
  const launches={book:async()=>({launches:[]})},admin=new LaunchpadAdmin({accounts,launchpad:launches,pumpPublic:service,now:()=>NOW});
  const body=extra=>({route:'pumpswap',accountId:OWNER,id:db.launches[0].id,mint,hidden:true,reason:'Hidden from public discovery after review.',...extra});
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return{service,accounts,people,admin,launches,observations,body,wallet,get db(){return db;},get launch(){return db.launches[0];}};
}

test('Admin Tokens inventory includes COFFEECAT Pump coin with original creator and no custody secrets',async t=>{
  const h=await fixture(t),page=await h.admin.list(ADMIN,{search:'COFFEECAT'}),row=page.launches[0];
  assert.equal(page.total,1);assert.equal(row.route,'pumpswap');assert.equal(row.username,'originalcreator');assert.equal(row.mint,h.launch.mint);assert.equal(row.hidden,false);assert.equal(row.eligibility.allowed,false);assert.equal(row.rewardsAction.allowed,false);assert.equal(row.canArchive,false);
  assert.deepEqual(page.counts,{active:1,archived:0});assert.doesNotMatch(JSON.stringify(page),/PRIVATE_|secretBase64|signedTransaction|bundle|mintSeed/);
  const panel=new AdminPanel({accounts:h.accounts,launchpad:h.launches,launchAdmin:h.admin,toolkit:false});const overview=await panel.overview(ADMIN);assert.equal(overview.counts.launches,1);assert.equal(overview.counts.creatorLaunches,1);
});

test('only current active MFA administrators may inspect or change Pump moderation',async t=>{
  const h=await fixture(t);
  for(const actor of [OWNER,OTHER]){await assert.rejects(h.service.adminInventory(actor),{statusCode:403});await assert.rejects(h.service.adminVisibility(actor,h.body()),{statusCode:403});await assert.rejects(h.service.adminArchive(actor,h.body({archived:true})),{statusCode:403});}
  assert.equal(h.observations.reads,0);assert.equal(h.observations.writes,0);
  h.people.get(ADMIN).mfaEnabled=false;await assert.rejects(h.admin.list(ADMIN),{statusCode:403});await assert.rejects(h.service.adminVisibility(ADMIN,h.body()),{statusCode:403});
  h.people.get(ADMIN).mfaEnabled=true;h.people.get(ADMIN).banned=true;await assert.rejects(h.service.adminVisibility(ADMIN,h.body()),{statusCode:403});
});

test('hiding persists, moves Pump to admin archive, and removes public lists without changing chain custody',async t=>{
  const h=await fixture(t),before=structuredClone(h.db),result=await h.service.adminVisibility(ADMIN,h.body());
  assert.deepEqual(result,{route:'pumpswap',id:h.launch.id,mint:h.launch.mint,hidden:true});assert.equal((await h.service.publicList()).length,0);
  assert.equal((await h.service.analyticsList()).length,1);assert.equal((await h.service.analyticsList())[0].hidden,true);
  assert.equal((await h.service.publicDetail(h.launch.mint)).hidden,true);assert.equal((await h.service.listAccount({account:{id:OWNER}}))[0].hidden,true);
  const restarted=new PumpPublicService({accounts:h.accounts,now:()=>NOW});assert.equal((await restarted.publicList()).length,0);assert.equal((await restarted.adminInventory(ADMIN))[0].adminRow.hidden,true);
  assert.equal((await h.admin.list(ADMIN)).total,0);const archived=await h.admin.list(ADMIN,{view:'archived'});assert.equal(archived.total,1);assert.equal(archived.launches[0].id,h.launch.id);assert.deepEqual(archived.counts,{active:0,archived:1});
  assert.deepEqual(h.db.operations,before.operations);assert.deepEqual(h.db.config,before.config);assert.deepEqual(h.db.relayer,before.relayer);assert.equal(h.launch.status,'trading');assert.equal(h.launch.creatorWallet,before.launches[0].creatorWallet);assert.equal(h.launch.creatorFeesPaid,'200');assert.equal(h.observations.prepared,0);assert.equal(h.observations.sent,0);
  const publicText=JSON.stringify([await restarted.publicDetail(h.launch.mint),await restarted.adminInventory(ADMIN)]);assert.doesNotMatch(publicText,/PRIVATE_|moderationHistory|Hidden from public discovery after review/);
  await h.service.adminVisibility(ADMIN,h.body({hidden:false,reason:'Visibility restored after review.'}));assert.equal((await h.service.publicList()).length,1);assert.equal(h.launch.moderationHistory.length,2);
});

test('wrong mint, launch ID, creator account and malformed visibility cannot mutate another coin',async t=>{
  const h=await fixture(t),before=structuredClone(h.db);
  for(const extra of [{mint:key()},{id:randomUUID()},{accountId:OTHER},{mint:undefined},{id:'../private'},{hidden:'true'},{reason:'no'}])await assert.rejects(h.service.adminVisibility(ADMIN,h.body(extra)));
  assert.deepEqual(h.db,before);assert.equal(h.observations.writes,0);
});

test('hiding changes discovery placement while retaining confirmed Pump financial history',async t=>{
  const h=await fixture(t);await h.service.adminVisibility(ADMIN,h.body());
  h.db.launches.push({...structuredClone(h.launch),id:randomUUID(),mint:key(),status:'draft'},{...structuredClone(h.launch),id:randomUUID(),mint:key(),status:'failed'});
  const volume=new AdminVolume({accounts:{...h.accounts,storeFor:()=>({read:async()=>({launches:[]})})},explore:{pumpPublic:h.service},now:()=>NOW});t.after(()=>volume.close());
  await volume.inventory();assert.equal(volume.records.length,1);assert.equal(volume.records[0].hidden,true);assert.equal(volume.launchFacts.length,1);assert.equal((await h.service.analyticsList()).length,1);assert.equal((await h.service.publicList()).length,0);
});

test('administrator revocation during read prevents both inventory disclosure and mutation commit',async t=>{
  const h=await fixture(t),list=h.accounts.list;h.accounts.list=async()=>{const rows=await list();h.people.get(ADMIN).role='user';return rows;};await assert.rejects(h.service.adminInventory(ADMIN),{statusCode:403});
  h.people.get(ADMIN).role='admin';const load=h.service.load.bind(h.service);h.service.load=async()=>{const data=await load();h.people.get(ADMIN).mfaEnabled=false;return data;};await assert.rejects(h.service.adminVisibility(ADMIN,h.body()),{statusCode:403});assert.equal(h.observations.writes,0);
});

test('archive organizes stopped drafts only, retaining pending and created Pump launches',async t=>{
  const h=await fixture(t);await assert.rejects(h.service.adminArchive(ADMIN,h.body({archived:true})),/created/);
  h.launch.status='draft';h.db.operations[0].state='awaiting_signature';await assert.rejects(h.service.adminArchive(ADMIN,h.body({archived:true})),/Wait/);
  h.db.operations[0].state='expired';const result=await h.service.adminArchive(ADMIN,h.body({archived:true}));assert.equal(result.route,'pumpswap');assert.equal(result.launch.manuallyArchived,true);assert.equal(result.launch.canRestore,true);assert.equal((await h.admin.list(ADMIN,{view:'archived'})).total,1);
  await h.service.adminArchive(ADMIN,h.body({archived:false}));assert.equal(h.launch.listArchive.archived,false);assert.equal(h.launch.listArchiveHistory.length,2);assert.equal(h.db.operations[0].state,'expired');
  await h.service.adminVisibility(ADMIN,h.body());await assert.rejects(h.service.adminArchive(ADMIN,h.body({archived:false})),/hidden/);
});

test('hiding preserves a holder’s direct sell preparation without broadcasting or un-hiding',async t=>{
  const h=await fixture(t);await h.service.adminVisibility(ADMIN,h.body());
  const session={account:{id:OWNER},walletVerified:true,walletAddress:h.wallet.publicKey.toBase58()},context={sessionToken:'verified-owner-session',authorize:async()=>session};
  const prepared=await h.service.prepare(session,{action:'sell',mint:h.launch.mint,expectedWallet:session.walletAddress,amountRaw:'1000'},context);
  assert.equal(prepared.operation.action,'sell');assert.equal(prepared.operation.state,'awaiting_signature');assert.equal(h.observations.prepared,1);assert.equal(h.observations.sent,0);assert.equal(h.launch.moderation.hidden,true);assert.equal(h.launch.status,'trading');assert.equal((await h.service.publicList()).length,0);
});
