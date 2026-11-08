import { createHash, createPublicKey, verify, randomUUID, randomBytes } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { verifySignedTransaction } from './providers.mjs';
import { publicPumpVisible, publicPumpLive, pumpAdminRow, setPumpArchive } from './pump-public-moderation.mjs';
import { createDammPumpGraduationWatcher } from './damm-pump-graduation-watcher.mjs';
import { validateWalletMessage } from './launchpad-wallet-guards.mjs';

export const DAMM_PUMP_SOL = 'So11111111111111111111111111111111111111112';
export const DAMM_PUMP_TREASURY = 'HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF';
export const DAMM_PUMP_CAPABILITIES = Object.freeze({ creatorFees:false, holderRewards:false, transferTax:false, protocolFees:true });
export const DAMM_PUMP_DEFAULTS = Object.freeze({ initialFdvUsd:20000, graduationFdvUsd:50000, graduationFeeBps:0, tradeFeeBps:125, creatorFeeBps:0, totalTradeFeeBps:125, tokenDecimals:6, supply:'1000000000', lpPolicy:'All received PumpSwap LP is burned in the graduation transaction.', creatorFees:false, postGradCreatorFeeBps:0, holderRewards:false });
const STORE = 'damm-pump', TERMINAL = new Set(['finalized', 'failed', 'expired', 'cancelled']);
const LAUNCH_ACTIONS = new Set(['configure', 'fund-quote', 'prepare-buy', 'initialize']);
const LAUNCH_PREPARATIONS = new Set(['configure', 'fund-quote', 'prepare-buy']);
const unsignedReview = op => op?.state === 'awaiting_signature' && !op.signedTransaction && !op.walletSignedTransaction && !op.signature;
const needsQuoteFunding = launch => launch?.fundingMode === 'sol' && launch.quoteMint !== DAMM_PUMP_SOL;
const canPrepareNativeBuy = launch => launch?.status === 'draft' && launch.setupStatus === 'finalized' && launch.lookupTables?.length > 0 && launch.quoteMint === DAMM_PUMP_SOL && launch.quoteTokenProgram === TOKEN_PROGRAM_ID.toBase58() && launch.quoteDecimals === 9 && BigInt(amount(launch.firstBuyRaw || '0')) > 0n;
const fingerprint = value => hash(JSON.stringify(value));
// Graduation pays new PumpSwap account rent as well as transaction fees.
const MIN_RELAYER_BALANCE = 30000000n;
const MAX_GRADUATION_FINISH_SOL = 250000000n;
const MIN_AUTOMATIC_FEE_USD = 20, REBROADCAST_INTERVAL_MS = 15000;
const hash = value => createHash('sha256').update(value).digest('hex');
const safe = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item));
function shareInFlight(pending,key,work) {
  let task=pending.get(key);
  if(!task){task=Promise.resolve().then(work).finally(()=>{if(pending.get(key)===task)pending.delete(key);});pending.set(key,task);}
  return task;
}
const fail = (message, statusCode = 400) => { throw Object.assign(Error(message), { statusCode }); };
const empty = () => ({ schemaVersion: 1, config: null, relayer: null, launches: [], operations: [], enabled: false, migrationCursor: 0 });
const object = (input, keys) => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) fail('Unsupported PumpSwap launch input.'); };
function address(value) { try { if (typeof value !== 'string' || new PublicKey(value).toBase58() !== value) throw Error(); return value; } catch { fail('Invalid Solana address.'); } }
function amount(value, optional = false) { if (optional && value === undefined) return '0'; if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > (1n << 64n) - 1n) fail('Invalid token amount.'); return value; }
function checkedFundingPlan(plan, launch) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('The SOL funding plan is unavailable. Review the launch again.', 409);
  const output = Object.fromEntries(['solLamports','firstBuyRaw','expectedRaw','minimumRaw'].map(key => [key,amount(plan[key])]));
  const budget = BigInt(launch.firstBuySolLamports), minimum = BigInt(output.minimumRaw);
  if (output.solLamports !== (budget > 0n ? String(budget) : '100000') || minimum < (budget > 0n ? 2n : 1n) || minimum > BigInt(output.expectedRaw) || output.firstBuyRaw !== (budget > 0n ? String(minimum - 1n) : '0')) fail('The SOL funding plan differs from the reviewed launch budget.', 409);
  return output;
}
function checkedGraduationFinishQuote(plan,launch) {
  if(!plan||launch.quoteMint!==DAMM_PUMP_SOL||launch.quoteDecimals!==9||launch.quoteTokenProgram!==TOKEN_PROGRAM_ID.toBase58()||plan.quoteMint!==DAMM_PUMP_SOL||plan.quoteDecimals!==9)fail('Automatic graduation finishing supports native SOL pairs only.',409);
  const output=Object.fromEntries(['amountRaw','maxAmountRaw','maxFinishSolLamports','expectedSpendRaw','remainingQuoteRaw','expectedQuoteRaw'].map(key=>[key,amount(plan[key])]));
  if(output.amountRaw!==String(MAX_GRADUATION_FINISH_SOL)||output.maxAmountRaw!==output.amountRaw||output.maxFinishSolLamports!==output.amountRaw||BigInt(output.expectedSpendRaw)<=0n||BigInt(output.expectedSpendRaw)>MAX_GRADUATION_FINISH_SOL||BigInt(output.remainingQuoteRaw)<=0n||BigInt(output.remainingQuoteRaw)>BigInt(output.expectedSpendRaw)||BigInt(output.expectedQuoteRaw)<=0n||!Number.isSafeInteger(plan.slot)||plan.slot<0)fail('The automatic graduation quote exceeds its fixed 0.25 SOL buy limit.',409);
  return {...output,quoteMint:DAMM_PUMP_SOL,quoteDecimals:9,slot:plan.slot};
}
function label(value, max, name, optional = false) { if (optional && value === undefined) return ''; if (typeof value !== 'string' || value !== value.trim() || Buffer.byteLength(value) > max || /[\x00-\x1f\x7f]/.test(value) || (!optional && !value)) fail(`Invalid ${name}.`); return value; }
function signed(value) { if (typeof value !== 'string' || value.length > 1800) fail('A wallet-signed transaction is required.'); const bytes = Buffer.from(value, 'base64'); if (bytes.length > 1232 || bytes.toString('base64') !== value) fail('Invalid wallet-signed transaction.'); return bytes; }

function validLookupSnapshot(tx,bundle) {
  const lookups=tx.message.addressTableLookups||[],snapshots=bundle.addressLookupTables||bundle.lookupTables||[];
  if(!lookups.length)return true;
  if(!Array.isArray(snapshots)||lookups.length>snapshots.length)return false;
  const unique=new Set();
  return lookups.every(lookup=>{
    const key=lookup.accountKey.toBase58(),row=snapshots.find(item=>(item.address||item.key)===key);
    if(unique.has(key)||!row||!Array.isArray(row.addresses)||!row.addresses.length)return false;unique.add(key);
    try{for(const value of row.addresses)address(value);}catch{return false;}
    const used=[...lookup.writableIndexes,...lookup.readonlyIndexes];
    return used.length===new Set(used).size&&used.every(index=>Number.isInteger(index)&&index>=0&&index<row.addresses.length);
  });
}

/** Existing snapshot addresses are independently verified on chain before submit.
 * Equivalent account recompiles, the pinned Lighthouse assertion suffix and the
 * wallet's own bounded priority fee/compute limit (Phantom, Solflare) are
 * compatible; original ordered instructions, account permissions, amounts and
 * blockhash stay identical. No wallet-selected lookup table is accepted. */
export function validateDammPumpWalletMessage(tx, bundle) {
  const prepared = VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction, 'base64'));
  if (tx.version !== 0 || prepared.version !== 0 || !validLookupSnapshot(prepared,bundle) || !validLookupSnapshot(tx,bundle)) throw Object.assign(Error('lookup review mismatch'),{walletValidationReason:'lookup review mismatch'});
  const required = new Set([...prepared.message.addressTableLookups,...tx.message.addressTableLookups].map(row=>row.accountKey.toBase58()));
  const tables = (bundle.addressLookupTables||bundle.lookupTables||[]).filter(row=>required.has(row.address||row.key)).map(row=>({key:new PublicKey(row.address||row.key),state:{addresses:row.addresses.map(value=>new PublicKey(value))}}));
  return validateWalletMessage(prepared.message,tx.message,{resolvedTables:tables,allowEquivalentRecompile:true,allowComputeBudget:true});
}

/** Verify the user's signature before adding the narrowly scoped platform signature. */
export function verifyPublicWalletTransaction(encoded, bundle, wallet, relayer, { action = bundle.action } = {}) {
  let reason = 'invalid wallet transaction';
  try {
    const bytes=signed(encoded),tx=VersionedTransaction.deserialize(bytes);
    if (!Buffer.from(tx.serialize()).equals(bytes)) throw Error();
    reason='reviewed instructions changed';validateDammPumpWalletMessage(tx,bundle);
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map(k => k.toBase58());
    const expected = bundle.needsRelayer ? [wallet, relayer] : [wallet];
    reason='wallet signer changed';
    if (signers.length !== expected.length || signers[0] !== wallet || expected.some(k => !signers.includes(k))) throw Error();
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(wallet).toBuffer()]), format: 'der', type: 'spki' });
    reason='wallet signature missing or invalid';
    if (!verify(null, tx.message.serialize(), key, tx.signatures[0])) throw Error();
    reason='unexpected platform signature';
    if (bundle.needsRelayer && tx.signatures[signers.indexOf(relayer)].some(Boolean)) throw Error();
    return tx;
  } catch (error) {
    // This code is emitted only before journal/sign/send. It allows the browser
    // to discard a definitively rejected packet, retaining the saved launch.
    const detail=error.walletValidationReason||reason;
    const diagnostic=typeof error.walletValidationDetail==='string'&&error.walletValidationDetail.length<=100&&/^[a-z0-9 >;-]+$/.test(error.walletValidationDetail)?error.walletValidationDetail:'';
    const stage=['configure','prepare-buy','fund-quote','initialize','buy','sell','migrate','protocol-fees'].includes(action)?action:'wallet';
    throw Object.assign(Error(`The wallet changed the reviewed transaction or did not sign it (${detail}). ${diagnostic?`[${stage}: ${diagnostic}] `:''}Nothing was submitted. Approve this launch step again.`),{statusCode:400,code:'WALLET_TRANSACTION_REJECTED',walletValidationReason:detail,...(diagnostic?{walletValidationDetail:diagnostic,walletValidationAction:stage}:{})});
  }
}

function dammAdminRow(account,launch,operations) {
  const row=pumpAdminRow(account,launch,operations),reason='This launch has no creator or holder reward allocation. DAMM position fees belong to the fixed protocol treasury.';
  return {...row,route:'damm-pump',platform:'damm-pump',quoteMint:launch.quoteMint,quoteSymbol:launch.quoteSymbol,feeMode:'none',eligibility:{allowed:false,reason},rewardsAction:{kind:null,allowed:false,reason,busy:false,autoFees:false},rewardsAutomation:{allowed:false,enabled:false,reason,pending:false,needed:false}};
}

/** All secrets and signed wire bytes are in the existing encrypted host store. */
// v71.18: the Meteora → PumpSwap route is closed to new public launches (Pump.fun
// Classic replaces it). Existing coins keep trading, collecting and graduating,
// and paid unfinished drafts can still be completed through ?venue=damm-pump.
export const DAMM_PUMP_NEW_LAUNCHES_ENABLED = false;
export const DAMM_PUMP_CLOSED_REASON = 'New Meteora → PumpSwap launches are closed. Launch on Pump.fun, Raydium or Meteora. Existing coins keep trading, and unfinished paid launches can still be completed.';
export class DammPumpService {
  constructor({ accounts, requireOwner, adapter, getQuotePrice, quoteEligibility, listPairs = async () => [], getCreationFee = async () => ({lamports:'0',recipient:DAMM_PUMP_TREASURY}), publishMetadata, now = Date.now, intervalMs = 15000, verifyWalletTransaction = verifyPublicWalletTransaction, graduationWatcherFactory = createDammPumpGraduationWatcher, newLaunchesEnabled = DAMM_PUMP_NEW_LAUNCHES_ENABLED }) {
    Object.assign(this, { accounts, requireOwner, adapter, getQuotePrice, quoteEligibility, listPairs, getCreationFee, publishMetadata, now, intervalMs, verifyWalletTransaction,graduationWatcherFactory,newLaunchesEnabled }); this.timer = null; this.running = null; this.closed = false; this.commitQueue = Promise.resolve();this.storeName=STORE;this.defaults=DAMM_PUMP_DEFAULTS;this.deploymentChecks=new Map();this.receiptChecks=new Map();this.graduationHints=new Set();this.graduationHintAttempts=new Map();this.graduationHintTimer=null;this.tickRequested=false;this.graduationWatcher=null;
  }
  async load() {const data=await this.accounts.hostStore.read(this.storeName,empty());if(data?.schemaVersion!==1||!Array.isArray(data.launches)||!Array.isArray(data.operations))fail('PumpSwap launch history is unavailable. Restore its original encrypted data.',503);return data;}
  async save(data) {await this.accounts.hostStore.write(this.storeName,data);const directory=await open(this.accounts.dir,'r');try{await directory.sync();}finally{await directory.close();}}
  async locked(fn) {
    const previous = this.commitQueue; let resolveQueue; this.commitQueue = new Promise(done => { resolveQueue = done; }); await previous;
    let child;
    try {
      await mkdir(this.accounts.dir, { recursive: true, mode: 0o700 });
      // The kernel releases this advisory lock when the pipe closes, including
      // a host crash. No PID guessing, stale-file deletion or manual reset.
      if (process.platform !== 'linux') fail('Public custody hosting requires the Linux VPS lock service.', 503);
      const path = resolve(this.accounts.dir, this.storeName+'.flock'); const file = await open(path, 'a', 0o600); await file.close();
      child = spawn('flock', ['--nonblock', '--exclusive', path, 'sh', '-c', 'printf R; cat >/dev/null'], { stdio: ['pipe','pipe','ignore'] }); child.stdin.on('error',()=>{});
      await new Promise((done,reject) => { child.once('error',reject); child.once('exit',()=>reject(Object.assign(Error('Another Launchpad process is committing a public launch. Retry shortly.'),{statusCode:409}))); child.stdout.once('data',()=>done()); });
      return await fn();
    } finally { if (child?.pid) { const ended = new Promise(done => child.once('close',done)); child.stdin.end(); if (child.exitCode === null && child.signalCode === null) await ended; } resolveQueue(); }
  }
  async authorize(session, context, wallet = null, owner = false) {
    if (!context?.sessionToken || typeof context.authorize !== 'function') fail('Sign in again to continue.', 403);
    const current = await context.authorize();
    if (!current?.account?.id || current.account.id !== session?.account?.id) fail('The signed-in account changed.', 403);
    if (owner) await this.requireOwner(current);
    if (wallet && (!current.walletVerified || current.walletAddress !== wallet)) fail('Sign in with the wallet that is reviewing this transaction.', 403);
    return current;
  }
  async ensureRelayer() { return this.locked(async () => { const data = await this.load(); if (!data.relayer) { const key = Keypair.generate(); try { data.relayer = { address: key.publicKey.toBase58(), secretBase64: Buffer.from(key.secretKey).toString('base64'), createdAt: this.now() }; await this.save(data); } finally { key.secretKey.fill(0); } } return { address: data.relayer.address }; }); }
  async deploymentConfig() { return (await this.load()).config; }
  configForLaunch(data, launch) {
    if (!launch) fail('The saved launch controller configuration is unavailable.',409);
    const registered=[data.config,...Object.values(data.controllerConfigs||{})].filter(Boolean);
    const bound=data.launchBindings?.[launch.mint],snapshot=launch.controllerConfig;
    if(bound&&snapshot&&bound!==fingerprint(snapshot))fail('The saved launch controller configuration changed.',409);
    const wanted=snapshot?fingerprint(snapshot):bound;
    const config=wanted?registered.find(row=>fingerprint(row)===wanted):data.config;
    // Legacy rows are assigned an external immutable binding on replacement.
    // Their original launch fingerprint and every saved wire byte stay intact.
    if(!config||!launch.publicProgramId||config.programId!==launch.publicProgramId)fail('The deployment configuration changed. Restore this launch’s original controller binding.',409);
    return config;
  }
  configForOperation(data, op) {
    const config=this.configForLaunch(data,data.launches.find(row=>row.mint===op.mint));
    if(op.configFingerprint!==fingerprint(config))fail('The deployment configuration changed. Restore the saved transaction’s original controller.',409);
    return config;
  }
  launchTerms(config) { return safe(this.adapter.launchTerms?.(config)||{policyVersion:'damm-pump-20k-50k-v1',defaults:this.defaults}); }
  launchDefaults(launch) { return launch?.launchDefaults||this.launchTerms({programId:launch?.publicProgramId}).defaults; }
  async installDeployment(config) { return this.locked(async () => {
    const data=await this.load();
    if(!data.relayer||config.relayer!==data.relayer.address||config.treasury!==DAMM_PUMP_TREASURY||config.cluster!=='mainnet-beta')fail('The public deployment does not match the managed relayer and treasury.',409);
    await this.adapter.verifyDeployment(config,{allowDisabled:true});
    const same=data.config&&['schemaVersion','cluster','programId','expectedProgramSha256','expectedDeploymentSlot','expectedUpgradeAuthority','treasury','relayer'].every(k=>String(data.config[k])===String(config[k]));
    if(!same){
      if(data.config){
        data.controllerConfigs||={};data.launchBindings||={};
        // Bind before switching primary config. Never reprice old launches or
        // mutate their reviewed records simply because a new program is ready.
        for(const launch of data.launches){const original=this.configForLaunch(data,launch);data.launchBindings[launch.mint]??=fingerprint(original);data.controllerConfigs[fingerprint(original)]??=safe(original);}
        data.controllerConfigs[fingerprint(data.config)]??=safe(data.config);
        if(config.programId!==data.config.programId)for(const launch of data.launches){
          const spent=launch.setupStatus==='finalized'||launch.fundingStatus==='finalized'||data.operations.some(op=>op.mint===launch.mint&&(op.signedTransaction||op.signature));
          if(launch.status==='draft'&&!spent){launch.status='cancelled';launch.cancelledAt=this.now();launch.cancellationReason='Start a new launch review with the current controller.';for(const op of data.operations)if(op.mint===launch.mint&&op.state==='awaiting_signature')op.state='cancelled';}
        }
      }
      data.config=safe(config);data.enabled=false;
    }
    await this.save(data);return {configured:true,publicEnabled:data.enabled};
  }); }
  async binding(data, { newLaunch=false, launching=false, launch=null, operation=null }={}) {
    const config=operation?this.configForOperation(data,operation):launch?this.configForLaunch(data,launch):data.config;
    if(!config||!data.relayer||config.relayer!==data.relayer.address||config.treasury!==DAMM_PUMP_TREASURY)fail('PumpSwap launch controller is not configured.',409);
    if(newLaunch&&this.adapter.supportsNewLaunch?.(config)===false)fail('New PumpSwap launches are waiting for the current launch controller setup.',409);
    const launchGate=newLaunch||launching;
    const options={allowDisabled:!launchGate,recovery:!launchGate};
    // Concurrent visitors and receipt polls can share an identical proof while
    // it is running. Settled proofs are never reused; balances stay separate.
    const verified=safe(await shareInFlight(this.deploymentChecks,fingerprint([config,options]),()=>this.adapter.verifyDeployment(config,options)));
    if(launchGate&&!verified.enabled)fail('New PumpSwap launches are disabled on chain.',409);
    if(launchGate&&BigInt(await this.adapter.balance(config,data.relayer.address))<MIN_RELAYER_BALANCE)fail('New launches are waiting for graduation gas funding.',409);
    return verified;
  }
  async publicStatus() {
    if(!this.newLaunchesEnabled){const data=await this.load();return {available:false,publicEnabled:false,newLaunchesClosed:true,configured:!!data.config,defaults:this.launchTerms(data.config).defaults,capabilities:DAMM_PUMP_CAPABILITIES,fees:{tradeFeeBps:125,protocolFeeBps:100,creatorFeeBps:0,holderRewards:false,description:'1.25% DAMM trading fee before graduation; approximately 1% goes to Launchpad after Meteora’s share. No transfer tax.'},pairs:[],blockers:[DAMM_PUMP_CLOSED_REASON]};}
    const data=await this.load();let ready=false,blockers=[];
    if(data.config)try{await this.binding(data,{newLaunch:true});ready=true;}catch{blockers=['PumpSwap launches are waiting for current controller setup, verification, enablement, or graduation gas.'];}
    else blockers=['PumpSwap launch setup is not complete yet.'];
    const pairs=await this.listPairs();
    return {available:ready,publicEnabled:ready,configured:!!data.config,defaults:this.launchTerms(data.config).defaults,capabilities:DAMM_PUMP_CAPABILITIES,fees:{tradeFeeBps:125,protocolFeeBps:100,creatorFeeBps:0,holderRewards:false,description:'1.25% DAMM trading fee before graduation; approximately 1% goes to Launchpad after Meteora’s share. No transfer tax.'},pairs,blockers};
  }
  async setup(session,input,context) {object(input,[]);await this.authorize(session,context,null,true);return this.ensureRelayer();}
  async setEnabled(session,input,context) {object(input,['enabled']);await this.authorize(session,context,null,true);fail('Use the wallet-signed controller configuration to change public launch availability.',409);}
  async ownerStatus(session,context) {
    await this.authorize(session,context,null,true);
    const data=await this.load(),status=await this.publicStatus();let balanceLamports=null;
    if(data.config&&data.relayer)try{balanceLamports=await this.adapter.balance(data.config,data.relayer.address);}catch{}
    return {...status,ready:status.available,canEnable:false,programId:data.config?.programId||null,relayer:data.relayer?.address||null,relayerBalanceLamports:balanceLamports,relayerMinimumBalanceLamports:MIN_RELAYER_BALANCE.toString(),recommendedBalanceLamports:'50000000',treasury:DAMM_PUMP_TREASURY,config:data.config?{programId:data.config.programId,verifiedAt:data.config.verifiedAt,expectedDeploymentSlot:data.config.expectedDeploymentSlot}:null,migrations:data.launches.filter(l=>l.status==='bonded').map(l=>({mint:l.mint,retryAt:l.retryAt||null,notice:l.migrationNotice||null}))};
  }
  async requireAdmin(actorId){
    if(typeof actorId!=='string'||!/^[a-f0-9]{32}$/.test(actorId))fail('Administrator access required.',403);
    const actor=await this.accounts.get(actorId);
    if(!actor||actor.role!=='admin'||actor.banned||!actor.mfaEnabled)fail('Administrator access with two-factor authentication is required.',403);
    return actor;
  }
  async adminInventory(actorId){
    await this.requireAdmin(actorId);
    const [data,people]=await Promise.all([this.load(),this.accounts.list()]),byId=new Map(people.map(account=>[account.id,account]));
    const rows=data.launches.map(launch=>{
      const account=byId.get(launch.creatorId)||{id:launch.creatorId,username:''},adminRow=dammAdminRow(account,launch,data.operations);
      return {account:{id:account.id,username:account.username},adminRow,launch:{id:launch.id,createdAt:launch.createdAt,state:launch.status,curve:launch.stateAddress||null,input:{route:'damm-pump',network:'mainnet-beta',name:launch.name,symbol:launch.symbol,recipient:launch.creatorWallet,feeMode:'none',quoteMint:launch.quoteMint},keys:{mint:{address:launch.mint},wallet:{address:launch.custodyAuthority}},moderation:{hidden:launch.moderation?.hidden===true},listArchive:{archived:launch.listArchive?.archived===true}}};
    });
    await this.requireAdmin(actorId);return rows;
  }
  adminLaunch(data,{accountId,id,mint}){
    if(typeof accountId!=='string'||!/^[a-f0-9]{32}$/.test(accountId)||typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))fail('Choose a valid Pump launch.');
    address(mint);
    const launch=data.launches.find(row=>row.id===id&&row.mint===mint&&row.creatorId===accountId);
    if(!launch)fail('The Pump launch was not found.',404);return launch;
  }
  async adminVisibility(actorId,input={}){
    await this.requireAdmin(actorId);
    if(typeof input.hidden!=='boolean'||typeof input.reason!=='string'||input.reason.trim().length<5||input.reason.length>500)fail('Provide a visibility action and a reason (5–500 characters).');
    return this.locked(async()=>{
      const data=await this.load(),launch=this.adminLaunch(data,input);
      await this.requireAdmin(actorId);
      const event={hidden:input.hidden,reason:input.reason.trim(),actorId,at:this.now()};launch.moderation=event;launch.moderationHistory=[...(launch.moderationHistory||[]),event];
      await this.save(data);return {route:'damm-pump',id:launch.id,mint:launch.mint,hidden:input.hidden};
    });
  }
  async adminArchive(actorId,input={}){
    await this.requireAdmin(actorId);if(typeof input.archived!=='boolean')fail('Choose whether to archive or restore this request.');
    return this.locked(async()=>{
      const data=await this.load(),launch=this.adminLaunch(data,input),account=await this.accounts.get(launch.creatorId);
      await this.requireAdmin(actorId);
      if(setPumpArchive(launch,data.operations,{archived:input.archived,actorId,at:this.now()}))await this.save(data);
      return {route:'damm-pump',launch:dammAdminRow(account,launch,data.operations)};
    });
  }
  publicLaunch(launch) { if (!launch) return null; const { mint, name, symbol, description, image, website, twitter, telegram, creatorWallet, creatorId, createdAt, confirmedAt, finalizedAt, confirmationStatus, status, poolId, custodyAuthority, stateAddress, publicProgramId, metadataUri, priceSnapshot, migrationSignature, creatorFeesPending, creatorFeesPaid, creatorFeesAt } = launch; return { id: launch.id, hidden:launch.moderation?.hidden===true, archived:launch.listArchive?.archived===true, mint, name, symbol, description, image, website, twitter, telegram, creatorWallet, creatorId, createdAt, confirmedAt, finalizedAt, confirmationStatus, status, poolId, custodyAuthority, stateAddress, publicProgramId, metadataUri, priceSnapshot, migrationSignature, creatorFeesPending, creatorFeesPaid, creatorFeesAt, platform:'damm-pump', launchMode:'damm-pump', quoteMint:launch.quoteMint, quoteDecimals:launch.quoteDecimals, quoteTokenProgram:launch.quoteTokenProgram, quoteProgram:launch.quoteTokenProgram, quoteSymbol:launch.quoteSymbol, quoteName:launch.quoteName, quoteCategory:launch.quoteCategory, dammPoolId:launch.dammPoolId,migrationNotice:launch.migrationNotice||null, feePolicyVersion:launch.feePolicyVersion||this.launchTerms({programId:launch.publicProgramId}).policyVersion,...this.launchDefaults(launch) }; }
  async publicList() { return (await this.load()).launches.filter(publicPumpVisible).map(l => this.publicLaunch(l)); }
  // Financial history retains confirmed coins after discovery moderation, as
  // the existing Raydium reports do. These rows carry public fields only.
  async analyticsList() { return (await this.load()).launches.filter(publicPumpLive).map(l => this.publicLaunch(l)); }
  // Moderation removes discovery placement, never the onchain custody or a
  // holder's direct coin access. Private accounts also retain their full book.
  async publicDetail(mint) { return this.publicLaunch((await this.load()).launches.find(l => l.mint === mint&&publicPumpLive(l))) || null; }
  async listAccount(session) { return (await this.load()).launches.filter(l => l.creatorId === session.account.id).map(l => this.publicLaunch(l)); }
  async operations(session,context) {
    await this.authorize(session,context);
    return this.locked(async()=>{
      const data=await this.load();let changed=false;
      for(const op of data.operations)if(op.ownerId===session.account.id&&unsignedReview(op)&&(op.expiresAt<=this.now()||op.sessionHash!==hash(context.sessionToken))){op.state=op.expiresAt<=this.now()?'expired':'cancelled';changed=true;}
      if(changed)await this.save(data);
      const active=data.operations.filter(o=>o.ownerId===session.account.id&&!TERMINAL.has(o.state));
      const resumed=[];
      for(const launch of data.launches.filter(l=>l.creatorId===session.account.id&&l.status==='draft'&&l.setupStatus==='finalized')){
        if(active.some(o=>o.mint===launch.mint))continue;
        const predecessor=data.operations.filter(o=>o.ownerId===session.account.id&&o.mint===launch.mint&&LAUNCH_PREPARATIONS.has(o.action)&&o.state==='finalized').at(-1);
        if(predecessor)resumed.push(predecessor);
      }
      await this.authorize(session,context);
      return {operations:[...active,...resumed].map(o=>this.publicOperation(o,data.launches.find(l=>l.mint===o.mint)))};
    });
  }
  async wallet(session, input, context) { object(input, ['mint','expectedWallet']); address(input.mint); const wallet = address(input.expectedWallet); await this.authorize(session, context, wallet); const data = await this.load(), launch = data.launches.find(l => l.mint === input.mint && l.status !== 'draft'); if (!launch) fail('Coin not found.', 404); return this.adapter.wallet(this.configForLaunch(data,launch), launch, wallet); }
  publicOperation(op, launch) {
    const nextAction=op.state==='finalized'&&launch?.status==='draft'&&LAUNCH_PREPARATIONS.has(op.action)?'initialize':null;
    return { id: op.id, action: op.action, wallet: op.wallet, mint: op.mint, state: op.state, expiresAt: op.expiresAt, signature: op.signature || null, review: op.review, ...(op.state === 'awaiting_signature' ? { transaction: op.bundle.unsignedTransaction } : {}), ...(op.result ? {result:op.result}:{}),...(nextAction?{nextAction}:{}) };
  }
  response(data, op) { const launch=data.launches.find(l=>l.mint===op.mint);return { operation: this.publicOperation(op,launch), launch: this.publicLaunch(launch) }; }
  assertLaunchReview(data,op) {
    if(!LAUNCH_ACTIONS.has(op.action))return;
    const launch=data.launches.find(l=>l.mint===op.mint&&l.creatorId===op.ownerId&&l.creatorWallet===op.wallet&&l.status==='draft');
    if(!launch||op.launchFingerprint&&fingerprint(launch)!==op.launchFingerprint)fail('The saved launch changed. Continue from its latest saved review.',409);
    if(op.action==='configure'){if(launch.setupStatus==='finalized')fail('This launch configuration is already complete.',409);return;}
    if(launch.setupStatus!=='finalized'||!launch.lookupTables?.length)fail('Complete the saved launch configuration first.',409);
    if(op.action==='fund-quote'&&(!needsQuoteFunding(launch)||launch.fundingStatus==='finalized'))fail('This launch does not need another quote funding transaction.',409);
    if(op.action==='prepare-buy'&&(!canPrepareNativeBuy(launch)||op.review?.firstBuyRaw!==launch.firstBuyRaw||op.bundle.atomicQuoteFunding===true||op.bundle.fundingPlan))fail('This saved launch does not permit native SOL account preparation.',409);
    if(op.action==='initialize'&&needsQuoteFunding(launch)&&launch.fundingStatus!=='finalized'&&op.bundle.atomicQuoteFunding!==true)fail('The saved launch is missing its reviewed SOL conversion.',409);
    if(needsQuoteFunding(launch)&&op.bundle.fundingPlan&&fingerprint(checkedFundingPlan(op.bundle.fundingPlan,launch))!==fingerprint(checkedFundingPlan(launch.fundingPlan,launch)))fail('The saved SOL conversion plan changed. Review this launch again.',409);
  }
  async prepare(session, input, context) {
    object(input, ['action', 'expectedWallet', 'mint', 'name', 'symbol', 'description', 'image', 'website', 'twitter', 'telegram', 'amountRaw', 'slippageBps', 'quoteMint', 'firstBuySolLamports']);
    if (!['configure','fund-quote','initialize','buy','sell'].includes(input.action)) fail('Choose a launch, buy, or sell action.');
    if(input.action==='initialize'&&!input.mint)input={...input,action:'configure'};
    if(input.action==='configure'&&!this.newLaunchesEnabled)fail(DAMM_PUMP_CLOSED_REASON,409);
    const wallet = address(input.expectedWallet); await this.authorize(session, context, wallet);
    if(input.firstBuySolLamports!==undefined){amount(input.firstBuySolLamports);if(!LAUNCH_ACTIONS.has(input.action)||input.amountRaw!==undefined)fail('Choose one launch funding amount.');}
    let quantity = amount(input.amountRaw, LAUNCH_ACTIONS.has(input.action));
    let slippageBps = input.slippageBps ?? 100;
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10000) fail('Slippage must be between 0% and 100%.');
    if (!LAUNCH_ACTIONS.has(input.action) && BigInt(quantity) === 0n) fail('Enter an amount greater than zero.');
    {
      const data=await this.load();if(input.action==='configure')await this.binding(data,{newLaunch:true});
      const pending = data.operations.find(o => o.ownerId === session.account.id && o.wallet === wallet && !TERMINAL.has(o.state));
      if (pending) { if (pending.state === 'awaiting_signature' && pending.expiresAt <= this.now()) pending.state = 'cancelled'; else fail('Check your saved transaction before preparing another.', 409); }
      let launch, previousLaunchFingerprint;
      if(input.action==='configure') {
        const name = label(input.name, 32, 'coin name'), symbol = label(input.symbol, 10, 'ticker'), description = label(input.description, 1000, 'description', true), image = label(input.image, 500, 'image', true), website = label(input.website, 200, 'website', true), twitter = label(input.twitter, 200, 'Twitter', true), telegram = label(input.telegram, 200, 'Telegram', true);
        if ([website,twitter,telegram].some(link => link && !/^https:\/\//.test(link))) fail('Use an HTTPS website address.');
        const quoteMint=address(input.quoteMint),quote=await this.quoteEligibility(quoteMint);
        if(!quote||quote.mint!==quoteMint||quote.launchReady!==true)fail(quote?.supportReason||'This pair is not compatible with both DAMM and PumpSwap.',409);
        const quoteTokenProgram=address(quote.tokenProgram||quote.quoteTokenProgram),quoteDecimals=quote.decimals;
        if(!Number.isInteger(quoteDecimals)||quoteDecimals<0||quoteDecimals>18)fail('Unsupported quote decimals.',409);
        const price=await this.getQuotePrice(quoteMint,quote);
        const usd=Number(price?.usd),observedAt=price?.at;
        if(!price||price.stale===true||price.mint&&price.mint!==quoteMint||!Number.isFinite(usd)||usd<=0||usd>=1e9||!Number.isSafeInteger(observedAt)||observedAt>this.now()+5000||this.now()-observedAt>60000||!Number.isSafeInteger(Math.round(usd*1e6))||Math.round(usd*1e6)<1)fail('A fresh USD price for this quote asset is required. Try again shortly.',409);
        const mintSeed = input.firstBuySolLamports!==undefined?`c${randomBytes(12).toString('base64url')}`:`mint-${randomBytes(12).toString('hex')}`, mint = await this.adapter.deriveMint(wallet, mintSeed);
        const metadataUri = await this.publishMetadata({ accountId: session.account.id, mint, name, symbol, description, image, website, twitter, telegram });
        const terms=this.launchTerms(data.config);
        launch = { id: randomUUID(), mint, mintSeed, name, symbol, description, image, website, twitter, telegram, metadataUri, creatorWallet: wallet, creatorId: session.account.id, publicProgramId: data.config.programId, controllerConfig:safe(data.config),feePolicyVersion:terms.policyVersion,launchDefaults:terms.defaults,createdAt: this.now(), status:'draft',firstBuyRaw:quantity,firstBuySlippageBps:slippageBps, quoteMint,quoteTokenProgram,quoteDecimals,quoteSymbol:quote.symbol,quoteName:quote.name,quoteCategory:quote.category,priceSnapshot:{mint:quoteMint,usd:String(price.usd),at:price.at,source:price.source||'Live quote/USD reference',quoteUsdMicros:String(Math.round(usd*1e6))} };
        if(input.firstBuySolLamports!==undefined){launch.fundingMode='sol';launch.firstBuySolLamports=input.firstBuySolLamports;quantity=quoteMint===DAMM_PUMP_SOL?input.firstBuySolLamports:'0';launch.firstBuyRaw=quantity;}
        const creationFee = await this.getCreationFee(); amount(creationFee?.lamports); address(creationFee?.recipient); if(BigInt(creationFee.lamports)>100000000n)fail('The configured creation fee exceeds the platform limit.',409); launch.creationFee = {lamports:creationFee.lamports,recipient:creationFee.recipient};
      } else if(['fund-quote','initialize'].includes(input.action)) {
        address(input.mint);launch=safe(data.launches.find(l=>l.mint===input.mint&&l.creatorId===session.account.id&&l.creatorWallet===wallet&&l.status==='draft')||null);
        if(!launch||launch.setupStatus!=='finalized'||!launch.lookupTables?.length)fail('Complete the saved launch configuration before initializing this token.',409);
        previousLaunchFingerprint=fingerprint(launch);
        if(input.action==='fund-quote'&&(!needsQuoteFunding(launch)||launch.fundingStatus==='finalized'))fail('This launch does not need another quote funding transaction.',409);
        if(input.action==='fund-quote'&&launch.fundingFallback!==true)fail('Continue the saved launch to review its combined SOL conversion and initialization.',409);
        if(input.firstBuySolLamports!==undefined&&input.firstBuySolLamports!==launch.firstBuySolLamports)fail('The saved SOL launch budget cannot be changed. Continue its original review.',409);
        if(launch.fundingMode==='sol'){
          if(input.amountRaw!==undefined&&input.amountRaw!==launch.firstBuyRaw)fail('The saved first buy cannot be changed after reviewing SOL funding.',409);
          if(input.slippageBps!==undefined&&input.slippageBps!==launch.firstBuySlippageBps)fail('The saved SOL funding slippage cannot be changed.',409);
          quantity=amount(launch.firstBuyRaw||'0');
          if(needsQuoteFunding(launch)){const plan=checkedFundingPlan(launch.fundingPlan,launch);if(launch.fundingStatus==='finalized'?BigInt(quantity)>BigInt(plan.firstBuyRaw):plan.firstBuyRaw!==quantity)fail('The saved first buy differs from its SOL funding plan.',409);}
          else if(quantity!==launch.firstBuySolLamports)fail('The saved SOL first buy differs from its budget.',409);
        }else if(input.amountRaw===undefined)quantity=amount(launch.firstBuyRaw||'0');
        if(input.slippageBps===undefined)slippageBps=launch.firstBuySlippageBps??100;
        if(['name','symbol','description','image','website','twitter','telegram','quoteMint'].some(key=>input[key]!==undefined&&input[key]!==launch[key]))fail('This configured launch has different metadata or quote assets. Use its original saved review.',409);
        const quote=await this.quoteEligibility(launch.quoteMint);
        if(!quote?.launchReady||(quote.tokenProgram||quote.quoteTokenProgram)!==launch.quoteTokenProgram||quote.decimals!==launch.quoteDecimals)fail('This configured pair no longer passes launch compatibility checks.',409);
        const price=await this.getQuotePrice(launch.quoteMint,quote),usd=Number(price?.usd);
        if(!price||price.stale===true||price.mint&&price.mint!==launch.quoteMint||!Number.isFinite(usd)||usd<=0||usd>=1e9||!Number.isSafeInteger(price.at)||price.at>this.now()+5000||this.now()-price.at>60000||!Number.isSafeInteger(Math.round(usd*1e6))||Math.round(usd*1e6)<1)fail('A fresh USD price for this quote asset is required. Try again shortly.',409);
        launch.priceSnapshot={mint:launch.quoteMint,usd:String(price.usd),at:price.at,source:price.source||'Live quote/USD reference',quoteUsdMicros:String(Math.round(usd*1e6))};
      } else { address(input.mint); launch = data.launches.find(l => l.mint === input.mint && ['trading','bonded','migrated'].includes(l.status)); if (!launch) fail('This bonding curve is unavailable. Graduated coins trade through their PumpSwap pool.', 409); }
      const config=this.configForLaunch(data,launch);if(input.action!=='configure')await this.binding(data,{launch,launching:LAUNCH_ACTIONS.has(input.action)});
      const bundle = await this.adapter.prepare(config, { action: input.action, wallet, launch, amountRaw: quantity, slippageBps, relayer: data.relayer.address, now: this.now() });
      const action=bundle.action||input.action;
      const fundingFallback=input.action==='initialize'&&action==='fund-quote'&&needsQuoteFunding(launch)&&launch.fundingStatus!=='finalized';
      const nativeBuyPreparation=input.action==='initialize'&&action==='prepare-buy'&&canPrepareNativeBuy(launch);
      if(action!==input.action&&!fundingFallback&&!nativeBuyPreparation)fail('The prepared transaction changed the requested launch action.',409);
      if(bundle.atomicGraduation!==undefined&&bundle.atomicGraduation!==false&&(bundle.atomicGraduation!==true||action!=='buy'||bundle.atomicQuoteFunding===true||bundle.fundingPlan))fail('Only the requested buy may include its reviewed graduation.',409);
      if(action==='prepare-buy'){
        if(quantity!==launch.firstBuyRaw||bundle.review?.firstBuyRaw!==quantity||bundle.amountRaw!==undefined&&bundle.amountRaw!==quantity||bundle.atomicQuoteFunding===true||bundle.fundingPlan)fail('Native SOL account preparation cannot change the saved first buy or convert funds.',409);
        const tables=bundle.lookupTables||bundle.addressLookupTables;
        if(tables&&fingerprint(tables)!==fingerprint(launch.lookupTables))fail('Native SOL account preparation changed the saved lookup table.',409);
        amount(bundle.review?.maxWalletDebitLamports);
      }
      if(action==='fund-quote')launch.fundingFallback=true;
      if(input.action==='initialize'&&needsQuoteFunding(launch)&&launch.fundingStatus!=='finalized'&&action!=='fund-quote'&&bundle.atomicQuoteFunding!==true)fail('The prepared launch omitted its SOL conversion.',409);
      if(launch.fundingStatus==='finalized'&&bundle.atomicQuoteFunding===true)fail('The prepared launch would convert SOL twice.',409);
      if(action==='initialize'&&needsQuoteFunding(launch)&&launch.fundingStatus==='finalized'){
        const reviewed=amount(bundle.review?.firstBuyRaw);
        if(BigInt(reviewed)>BigInt(quantity)||BigInt(reviewed)>BigInt(launch.fundingPlan.firstBuyRaw)||bundle.amountRaw!==undefined&&bundle.amountRaw!==reviewed)fail('The funded launch review increased or changed its saved first buy.',409);
        // A fresh quote/USD reference can reduce the permitted first buy. Keep
        // the already-paid conversion receipt and budget intact; surplus quote
        // stays in its owner's wallet and the next signature reviews this buy.
        launch.firstBuyRaw=reviewed;quantity=reviewed;
      }
      const tx = VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction,'base64'));
      if(tx.message.addressTableLookups.length){if(!validLookupSnapshot(tx,bundle)||typeof this.adapter.verifyLookupTables!=='function')fail('The reviewed lookup table proof is unavailable.',409);await this.adapter.verifyLookupTables(config,bundle,launch);}
      if (tx.version !== 0 || tx.message.staticAccountKeys[0]?.toBase58() !== wallet || tx.signatures.some(s => s.some(Boolean)) || tx.message.header.numRequiredSignatures !== (action === 'initialize' ? 2 : 1) || !!bundle.needsRelayer !== (action === 'initialize')) fail('The prepared transaction has unexpected signers.', 409);
      if(['configure','initialize'].includes(action)) { launch.custodyAuthority = bundle.addresses?.authority || bundle.addresses?.vault; launch.stateAddress=bundle.addresses?.state; launch.dammPoolId=bundle.addresses?.dammPool||bundle.addresses?.pool; if(!launch.custodyAuthority||!launch.stateAddress||!launch.dammPoolId)fail('Prepared launch is missing verified custody addresses.',409); }
      if(needsQuoteFunding(launch)&&(['configure','fund-quote'].includes(action)||bundle.atomicQuoteFunding===true)){launch.fundingPlan=checkedFundingPlan(bundle.fundingPlan,launch);launch.firstBuyRaw=launch.fundingPlan.firstBuyRaw;quantity=launch.firstBuyRaw;}
      if(input.action==='configure'){launch.lookupSetupDebitLamports=bundle.review?.maxWalletDebitLamports;launch.lookupSetupRentLamports=bundle.review?.lookupTableRentLamports;launch.lookupTables=safe(bundle.lookupTables||bundle.addressLookupTables||[]);if(!launch.lookupTables.length)fail('Launch configuration omitted its expected frozen lookup table.',409);}
      const op = { id: randomUUID(), ownerId: session.account.id, sessionHash: hash(context.sessionToken), wallet, action, mint: launch.mint, state: 'awaiting_signature', createdAt: this.now(), expiresAt: Math.min(this.now() + 120000, (bundle.preparedAt || this.now()) + 120000), configFingerprint: fingerprint(config), ...(LAUNCH_ACTIONS.has(input.action)?{launchFingerprint:fingerprint(launch)}:{}), bundle: safe(bundle), review: { ...safe(bundle.review || bundle.details || {}), ...this.launchDefaults(launch), feePolicyVersion:launch.feePolicyVersion||this.launchTerms(config).policyVersion, configurationCreated:action!=='configure'&&LAUNCH_ACTIONS.has(action),firstBuyRaw:launch.fundingMode==='sol'?launch.firstBuyRaw:bundle.review?.firstBuyRaw||quantity,...(launch.fundingMode==='sol'?{fundingMode:'sol',firstBuySolLamports:launch.firstBuySolLamports,...(launch.fundingPlan?{quoteFundingInLamports:launch.fundingPlan.solLamports,quoteFundingExpectedRaw:launch.fundingPlan.expectedRaw,quoteFundingMinRaw:launch.fundingPlan.minimumRaw}:{}),quoteFundingComplete:launch.fundingStatus==='finalized'}:{}),...(launch.lookupSetupRentLamports?{setupRentLamports:launch.lookupSetupRentLamports}:{}),...(action==='initialize'&&launch.lookupSetupDebitLamports&&bundle.review?.maxWalletDebitLamports?{totalLaunchMaxDebitLamports:String(BigInt(launch.lookupSetupDebitLamports)+BigInt(launch.quoteFundingDebitLamports||'0')+BigInt(launch.nativeBuySetupDebitLamports||'0')+BigInt(bundle.review.maxWalletDebitLamports))}:{}), quoteMint:launch.quoteMint,quoteDecimals:launch.quoteDecimals,quoteSymbol:launch.quoteSymbol,quoteUsd:launch.priceSnapshot.usd, priceObservedAt: launch.priceSnapshot.at, custodyAuthority: launch.custodyAuthority, treasury: DAMM_PUMP_TREASURY }, messageHash: hash(tx.message.serialize()) };
      await this.authorize(session, context, wallet);
      return this.locked(async () => {
        const fresh = await this.load();
        const currentConfig=input.action==='configure'?fresh.config:this.configForLaunch(fresh,fresh.launches.find(row=>row.mint===launch.mint));
        if (fingerprint(currentConfig) !== op.configFingerprint) fail('Deployment changed during preparation. Review again.', 409);
        for (const previous of fresh.operations.filter(o => o.ownerId === session.account.id && o.wallet === wallet && !TERMINAL.has(o.state))) {
          if (previous.state === 'awaiting_signature' && previous.expiresAt <= this.now()) previous.state = 'cancelled';
          else fail('Check your saved transaction before preparing another.', 409);
        }
        await this.authorize(session,context,wallet);
        if(input.action==='configure')fresh.launches.push(launch);else if(['fund-quote','initialize'].includes(input.action)){const index=fresh.launches.findIndex(l=>l.mint===launch.mint&&l.creatorId===session.account.id&&l.status==='draft');if(index<0||fingerprint(fresh.launches[index])!==previousLaunchFingerprint)fail('This configured token changed while preparing its next launch step.',409);fresh.launches[index]=launch;}
        fresh.operations.push(op); await this.save(fresh); return this.response(fresh, op);
      });
    }
  }
  async cancel(session, input, context) { object(input, ['operationId']); await this.authorize(session, context); return this.locked(async () => { const data = await this.load(), op = data.operations.find(o => o.id === input.operationId && o.ownerId === session.account.id); if (!op) fail('Saved review not found.', 404); if (op.state !== 'awaiting_signature') fail('A signed or submitted transaction cannot be cancelled. Check its receipt.', 409); op.state = 'cancelled'; await this.save(data); return this.response(data, op); }); }
  signer(data) { let bytes; try { bytes = Buffer.from(data.relayer.secretBase64, 'base64'); const key = Keypair.fromSecretKey(Uint8Array.from(bytes)); if (key.publicKey.toBase58() !== data.relayer.address) { key.secretKey.fill(0); throw Error(); } return key; } catch { fail('The encrypted graduation signer needs recovery from its original backup.', 503); } finally { bytes?.fill(0); } }
  async submit(session, input, context) {
    object(input,['operationId','signedTransaction']); signed(input.signedTransaction); await this.authorize(session,context);
    const snapshot=await this.load(), previous=snapshot.operations.find(o=>o.id===input.operationId);
    if(!previous||previous.ownerId!==session.account.id||previous.sessionHash!==hash(context.sessionToken))fail('This reviewed transaction belongs to another session.',403);
    await this.authorize(session,context,previous.wallet);
    if(previous.walletSignedTransaction&&previous.walletSignedTransaction!==input.signedTransaction)fail('Only the original signed transaction may be checked again.',409);
    if(TERMINAL.has(previous.state))return this.response(snapshot,previous);
    if(previous.state!=='awaiting_signature')return this.reconcile(session,{operationId:previous.id},context);
    if(previous.expiresAt<=this.now())fail('This review expired. Prepare a fresh review.',409);
    const config=this.configForOperation(snapshot,previous);
    this.assertLaunchReview(snapshot,previous);
    await this.binding(snapshot,{operation:previous,newLaunch:previous.action==='configure',launching:LAUNCH_ACTIONS.has(previous.action)});
    const reviewedHasLookups=VersionedTransaction.deserialize(Buffer.from(previous.bundle.unsignedTransaction,'base64')).message.addressTableLookups.length>0;
    if(reviewedHasLookups){if(typeof this.adapter.verifyLookupTables!=='function')fail('Lookup table verification is unavailable.',409);await this.adapter.verifyLookupTables(config,previous.bundle,snapshot.launches.find(l=>l.mint===previous.mint));}
    let tx,guardCount,messageChanged;
    try{
      tx=this.verifyWalletTransaction(input.signedTransaction,previous.bundle,previous.wallet,snapshot.relayer.address,{action:previous.action});
      ({guardCount,changed:messageChanged}=validateDammPumpWalletMessage(tx,previous.bundle));
      // A wallet may use a saved, previously unused table while recompiling.
      // Resolve only saved snapshots, and verify their chain contents before
      // adding a platform signature even when the reviewed layout was static.
      if(!reviewedHasLookups&&tx.message.addressTableLookups.length){if(typeof this.adapter.verifyLookupTables!=='function')fail('Lookup table verification is unavailable.',409);await this.adapter.verifyLookupTables(config,previous.bundle,snapshot.launches.find(l=>l.mint===previous.mint));}
      if(messageChanged){
        if(typeof this.adapter.simulateWalletGuardTransaction!=='function'||guardCount&&typeof this.adapter.verifyWalletGuardProgram!=='function')throw Object.assign(Error('Wallet safety verification is temporarily unavailable. Keep this launch open and retry.'),{statusCode:503,code:'DAMM_WALLET_GUARD_RPC'});
        if(guardCount)await this.adapter.verifyWalletGuardProgram();
        if(previous.bundle.needsRelayer){const key=this.signer(snapshot);try{tx.sign([key]);}finally{key.secretKey.fill(0);}}
        verifySignedTransaction(Buffer.from(tx.serialize()),previous.wallet,previous.bundle.needsRelayer?[snapshot.relayer.address]:[]);
        await this.adapter.simulateWalletGuardTransaction(tx,previous.bundle);
      }
    }catch(error){
      if(error.code==='WALLET_TRANSACTION_REJECTED'){
        // Another identical request may have committed while this RPC simulation
        // was in flight. Never label an already journaled operation unsent.
        const committed=await this.locked(async()=>{
          const data=await this.load(),current=data.operations.find(o=>o.id===previous.id);
          await this.authorize(session,context,previous.wallet);
          return !!(current&&(current.signedTransaction||current.walletSignedTransaction||current.signature));
        });
        if(committed)return this.reconcile(session,{operationId:previous.id},context);
      }
      throw error;
    }
    const saved=await this.locked(async()=>{
      const data=await this.load(),op=data.operations.find(o=>o.id===previous.id);
      if(op.state!=='awaiting_signature')return null;
      const savedConfig=this.configForOperation(data,op);
      if(fingerprint(savedConfig)!==fingerprint(config)||op.expiresAt<=this.now())fail('The transaction review changed or expired.',409);
      await this.authorize(session,context,op.wallet);
      this.assertLaunchReview(data,op);
      if(op.bundle.needsRelayer&&!messageChanged){const key=this.signer(data);try{tx.sign([key]);}finally{key.secretKey.fill(0);}}
      const bytes=Buffer.from(tx.serialize());verifySignedTransaction(bytes,op.wallet,op.bundle.needsRelayer?[data.relayer.address]:[]);
      op.signedTransaction=bytes.toString('base64');op.walletSignedTransaction=input.signedTransaction;op.signature=bs58.encode(tx.signatures[0]);op.state='journaled';op.sentAt=this.now();op.lastBroadcastAttemptAt=this.now();if(guardCount)op.walletGuardCount=guardCount;if(messageChanged)op.walletMessageChanged=true;
      await this.save(data);return {op,config:savedConfig};
    });
    if(!saved)return this.reconcile(session,{operationId:previous.id},context);
    await this.authorize(session,context,previous.wallet);await this.binding(await this.load(),{operation:saved.op,launching:['fund-quote','prepare-buy'].includes(saved.op.action)});
    const response=await this.markBroadcast(saved.op.id,saved.config,saved.op.signedTransaction,saved.op.signature);this.kick();return response;
  }
  async reconcile(session,input,context){
    object(input,['operationId']);await this.authorize(session,context);
    let data=await this.load(),op=data.operations.find(o=>o.id===input.operationId);
    if(!op||op.ownerId!==session.account.id)fail('Saved transaction not found.',404);
    if(unsignedReview(op)&&op.expiresAt<=this.now()){
      // A submission can journal its signed wire after our first read. Recheck
      // under the same commit lock before expiring an unsigned review only.
      ({data,op}=await this.locked(async()=>{
        const data=await this.load(),op=data.operations.find(o=>o.id===input.operationId);
        if(!op||op.ownerId!==session.account.id)fail('Saved transaction not found.',404);
        await this.authorize(session,context);
        if(unsignedReview(op)&&op.expiresAt<=this.now()){op.state='expired';await this.save(data);}
        return {data,op};
      }));
    }
    if(op.state==='awaiting_signature'||TERMINAL.has(op.state))return this.response(data,op);
    const response=await this.receiptOutsideLock(data,op);await this.authorize(session,context);return response;
  }
  async reconcileSaved(data, op) {
    const launch = data.launches.find(l => l.mint === op.mint);
    await this.binding(data,{operation:op});
    const result = await this.adapter.reconcile(this.configForOperation(data,op), op, launch);
    this.applyReceipt(data, op, result);
  }
  applyFundingReceipt(launch,op,result) {
    if(!launch||!needsQuoteFunding(launch)||!(launch.status==='draft'||op.action==='initialize'&&launch.confirmationStatus==='confirmed')||launch.setupStatus!=='finalized')fail('The finalized SOL conversion does not match its saved launch.',502);
    const plan=checkedFundingPlan(op.bundle.fundingPlan,launch);
    if(fingerprint(plan)!==fingerprint(checkedFundingPlan(launch.fundingPlan,launch))||!result.funding||Object.keys(plan).some(key=>result.funding[key]!==plan[key])||BigInt(amount(result.funding.receivedRaw))<BigInt(plan.minimumRaw))fail('The finalized SOL conversion differs from the saved funding plan.',502);
    if(launch.fundingStatus==='finalized'&&launch.fundingSignature!==op.signature)fail('This launch already has a finalized SOL conversion.',502);
    launch.fundingStatus='finalized';launch.fundingSignature=op.signature;launch.fundingReceipt=safe(result.funding);if(op.action==='fund-quote')launch.quoteFundingDebitLamports=amount(op.review?.maxWalletDebitLamports);launch.firstBuyRaw=plan.firstBuyRaw;launch.updatedAt=this.now();
  }
  assertAtomicGraduationReceipt(launch,op,result) {
    const raw=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=(1n<<64n)-1n;
    const a=op.bundle.addresses,terms=this.launchDefaults(launch);
    if(op.action!=='buy'||result.phase!=='migrated'||!op.signature||result.signature!==op.signature||!a?.pool||result.poolId!==a.pool||!a.lpMint||result.lpMint!==a.lpMint||!raw(result.issuedLpAtoms)||BigInt(result.issuedLpAtoms)===0n||result.burnedLpAtoms!==result.issuedLpAtoms||result.retainedLpAtoms!=='0'||result.trade?.side!=='buy')fail('The finalized buy does not prove its reviewed atomic graduation.',502);
    if(BigInt(terms.graduationFeeNumerator||'0')>0n){
      const fee=result.graduationFee;
      if(fee?.verified!==true||fee.signature!==op.signature||fee.recipient!==DAMM_PUMP_TREASURY||fee.quoteMint!==launch.quoteMint||!raw(fee.amountRaw)||BigInt(fee.amountRaw)===0n||result.graduationFeeRaw!==fee.amountRaw||!raw(result.grossQuoteRaw)||!raw(result.poolQuoteRaw)||BigInt(fee.amountRaw)!==BigInt(result.grossQuoteRaw)*BigInt(terms.graduationFeeNumerator)/BigInt(terms.graduationFeeDenominator)||BigInt(result.poolQuoteRaw)+BigInt(fee.amountRaw)!==BigInt(result.grossQuoteRaw))fail('The finalized buy does not prove its reviewed graduation fee.',502);
    }
  }
  applyReceipt(data, op, result) {
    const launch = data.launches.find(l => l.mint === op.mint);
    if (!['pending', 'confirmed', 'finalized', 'failed', 'expired'].includes(result?.state)) fail('Transaction receipt is unavailable.', 502);
    if(result.observedSignatureStatus){
      const rank={unknown:0,processed:1,confirmed:2,finalized:3},next=result.observedSignatureStatus;
      if(!Object.hasOwn(rank,next.confirmationStatus)||next.slot!==null&&(!Number.isSafeInteger(next.slot)||next.slot<0))fail('The saved signature observation is invalid.',502);
      if(!op.observedSignatureStatus||rank[next.confirmationStatus]>=rank[op.observedSignatureStatus.confirmationStatus])op.observedSignatureStatus=safe(next);
    }
    if(result.state==='expired'&&op.observedSignatureStatus)fail('A previously observed signature must be reconciled before retrying.',502);
    if(op.purpose==='graduation-finish'){
      const plan=checkedGraduationFinishQuote(op.finishPlan,launch);
      if(op.action!=='buy'||op.ownerId!==null||op.wallet!==data.relayer.address||op.bundle.atomicGraduation!==true||op.bundle.amountRaw!==plan.amountRaw||op.bundle.trade?.input!==plan.amountRaw)fail('The saved automatic graduation differs from its fixed wallet and buy budget.',502);
      if(result.state==='finalized'&&(BigInt(amount(result.trade?.quoteRaw))<=0n||BigInt(result.trade.quoteRaw)>MAX_GRADUATION_FINISH_SOL))fail('The automatic graduation receipt exceeds its fixed 0.25 SOL buy limit.',502);
    }
    if(op.action==='configure') {
      if(result.state==='confirmed')fail('Launch configuration requires a finalized frozen lookup table.',502);
      op.state=result.state;op.result=safe(result);
      if(result.state==='finalized') {
        const tables=result.lookupTables||op.bundle.lookupTables||op.bundle.addressLookupTables;
        if(!Array.isArray(tables)||!tables.length||JSON.stringify(tables)!==JSON.stringify(launch.lookupTables))fail('The finalized lookup table differs from the saved configuration.',502);
        launch.setupStatus='finalized';launch.setupSignature=op.signature;launch.lookupTables=safe(tables);launch.updatedAt=this.now();
      }
      return;
    }
    if(op.action==='fund-quote') {
      if(result.state==='confirmed')fail('SOL conversion requires a finalized wallet receipt.',502);
      if(result.state==='finalized'){
        this.applyFundingReceipt(launch,op,result);
      }
      op.state=result.state;op.result=safe(result);return;
    }
    if(op.action==='prepare-buy') {
      if(result.state==='confirmed')fail('Native SOL account preparation requires a finalized wallet receipt.',502);
      if(result.state==='finalized'){
        const expectedAccount=getAssociatedTokenAddressSync(new PublicKey(DAMM_PUMP_SOL),new PublicKey(launch.creatorWallet)).toBase58();
        if(!canPrepareNativeBuy(launch)||result.nextAction!=='initialize'||result.nativeBuyAccount!==expectedAccount)fail('The finalized native SOL account differs from the saved launch.',502);
        if(launch.nativeBuySetupSignature!==op.signature)launch.nativeBuySetupDebitLamports=String(BigInt(launch.nativeBuySetupDebitLamports||'0')+BigInt(amount(op.review?.maxWalletDebitLamports)));
        launch.nativeBuySetupStatus='finalized';launch.nativeBuySetupSignature=op.signature;launch.updatedAt=this.now();
      }
      op.state=result.state;op.result=safe(result);return;
    }
    if (result.state === 'confirmed' && op.action !== 'initialize') fail('Only initialization supports early confirmation.', 502);
    // A later chain state can already be migrated when an ordinary buy settles.
    // Attribute the migration to this buy only when its own saved packet and
    // finalized LP/fee receipt both prove the combined operation.
    if(result.state==='finalized'&&op.bundle.atomicGraduation===true)this.assertAtomicGraduationReceipt(launch,op,result);
    // Concurrent RPC calls may return an older pending view after confirmation.
    if (op.state === 'confirmed' && result.state === 'pending') return;
    op.state = result.state; op.result = safe(result);
    if (result.state === 'confirmed') {
      if (!['trading', 'bonded', 'migrated'].includes(result.phase)) fail('The confirmed launch state could not be verified.', 502);
      if (!launch.finalizedAt) {
        launch.status = result.phase; launch.confirmedAt ||= this.now();
        launch.confirmationStatus = 'confirmed'; launch.updatedAt = this.now();
      }
    }
    if (['failed','expired'].includes(result.state) && op.action === 'initialize' && !launch.finalizedAt) {
      launch.status=launch.setupStatus==='finalized'?'draft':'error'; launch.confirmationStatus=result.state;
    }
    if (result.state === 'finalized') {
      const phase = result.phase; if (!['trading', 'bonded', 'migrated'].includes(phase)) fail('Transaction state could not be verified.', 502);
      if(op.action==='initialize'&&op.bundle.atomicQuoteFunding===true)this.applyFundingReceipt(launch,op,result);
      if (launch.status !== 'migrated') launch.status = phase; launch.finalizedAt ||= this.now(); launch.confirmationStatus = 'finalized'; launch.updatedAt = this.now();
      if(result.poolId)launch.poolId=result.poolId; if(result.dammPoolId)launch.dammPoolId=result.dammPoolId;
      if (result.creatorFeesPending !== undefined) launch.creatorFeesPending=result.creatorFeesPending;
      if (result.creatorFeesPaid !== undefined) launch.creatorFeesPaid=result.creatorFeesPaid;
      if (result.creatorFeesPending !== undefined && result.creatorFeesPaid !== undefined) launch.creatorFeesAt=this.now();
      if(op.action==='protocol-fees'){launch.protocolFeesLastSignature=op.signature;launch.protocolFeesCollectedAt=this.now();if(phase==='migrated')launch.protocolFeeCollectionComplete=true;launch.protocolFeesPaidRaw=String(BigInt(launch.protocolFeesPaidRaw||'0')+BigInt(result.protocolFee?.quoteRaw||'0'));launch.nextFeeCheckAt=this.now()+3600000;}
      if (op.action === 'migrate'||op.action==='buy'&&op.bundle.atomicGraduation===true) { launch.migrationSignature = op.signature; launch.burnReceipt = safe(result); launch.migrationNotice = null; }
      if (result.trade) { op.trade = safe(result.trade); op.finalizedAt = this.now(); }
    }
  }
  async marketSnapshot(mint) { const data = await this.load(), launch = data.launches.find(l => l.mint === mint && l.status !== 'draft'); if (!launch) return null; return this.adapter.marketSnapshot(this.configForLaunch(data,launch), launch, await this.getQuotePrice(launch.quoteMint,launch).catch(() => null)); }
  async analyticsTrades(mint) { return { trades: (await this.load()).operations.filter(o => o.mint === mint && o.state === 'finalized' && o.trade).map(o => ({ ...o.trade, signature: o.signature, wallet: o.wallet, at: o.finalizedAt, side: o.trade.side })), complete: false }; }
  async trades(mint) { return (await this.analyticsTrades(mint)).trades.slice(-200).reverse(); }
  start() { if (this.timer) return; this.closed = false;this.graduationWatcher=this.graduationWatcherFactory?.({adapter:this.adapter,onHint:hint=>this.queueGraduationHint(hint),maxInputRaw:String(MAX_GRADUATION_FINISH_SOL)})||null; this.timer = setInterval(() => this.kick(), this.intervalMs); this.timer.unref?.(); this.kick(); }
  async stop() { this.closed = true; clearInterval(this.timer); this.timer = null;clearTimeout(this.graduationHintTimer);this.graduationHintTimer=null;this.graduationHints.clear();this.graduationHintAttempts.clear();this.tickRequested=false; await (this.running || Promise.resolve());await this.graduationWatcher?.close();this.graduationWatcher=null; this.adapter.close?.(); }
  queueGraduationHint({mint}={}) {if(this.closed||typeof mint!=='string')return;this.graduationHints.add(mint);this.kick({hintOnly:true});}
  kick({hintOnly=false}={}) {
    if(this.closed)return;if(!hintOnly)this.tickRequested=true;if(this.running)return;
    this.running=this.drainGraduationWork().catch(()=>{}).finally(()=>{this.running=null;if(this.closed)return;if(this.tickRequested)this.kick();else this.scheduleGraduationHints();});
  }
  scheduleGraduationHints(){
    if(this.closed||!this.graduationHints.size)return;
    const due=Math.min(...[...this.graduationHints].map(mint=>(this.graduationHintAttempts.get(mint)||0)+1000)),delay=Math.max(0,due-this.now());
    if(this.graduationHintTimer)clearTimeout(this.graduationHintTimer);
    this.graduationHintTimer=setTimeout(()=>{this.graduationHintTimer=null;this.kick({hintOnly:true});},delay);this.graduationHintTimer.unref?.();
  }
  async drainGraduationWork(){
    while(!this.closed&&(this.tickRequested||this.graduationHints.size)){
      if(this.graduationHints.size){
        const mints=[...this.graduationHints].filter(mint=>this.now()-(this.graduationHintAttempts.get(mint)||0)>=1000);if(!mints.length&&!this.tickRequested)break;
        for(const mint of mints){this.graduationHints.delete(mint);this.graduationHintAttempts.set(mint,this.now());}
        const data=await this.load(),launches=mints.map(mint=>data.launches.find(l=>l.mint===mint&&l.confirmationStatus==='finalized'&&['trading','bonded'].includes(l.status)&&l.quoteMint===DAMM_PUMP_SOL)).filter(Boolean);
        // A new pool update may supersede a routine retry delay. Pending signed
        // transactions still win, and every attempt rechecks the live endpoint.
        for(let offset=0;offset<launches.length;offset+=3)await Promise.allSettled(launches.slice(offset,offset+3).map(launch=>this.graduateCandidate(data,{...launch,retryAt:0})));
      }
      if(this.tickRequested&&!this.closed){this.tickRequested=false;await this.tick().catch(()=>{});}
    }
  }
  syncGraduationWatcher(data){
    if(!this.graduationWatcher)return;const rows=[];
    for(const launch of data.launches)if(launch.confirmationStatus==='finalized'&&['trading','bonded'].includes(launch.status)&&launch.quoteMint===DAMM_PUMP_SOL)try{rows.push({launch,config:this.configForLaunch(data,launch)});}catch{}
    Promise.resolve().then(()=>this.graduationWatcher?.sync(rows)).catch(()=>{});
  }
  async receiptOutsideLock(snapshot, op) {
    const config=this.configForOperation(snapshot,op),launch=snapshot.launches.find(l=>l.mint===op.mint);
    const key=fingerprint([this.storeName,config,op.id,op.ownerId,op.wallet,op.mint,op.action,op.signature,op.signedTransaction,op.bundle,launch]);
    // The worker and browser may poll the same signed operation together. Share
    // its receipt and commit, but never share across changed wire or bindings.
    return safe(await shareInFlight(this.receiptChecks,key,async()=>{
      await this.binding(snapshot,{operation:op});
      const result = await this.adapter.reconcile(config, op, launch);
      const response = await this.locked(async () => {
        const data = await this.load(), current = data.operations.find(o => o.id === op.id);
        if (!current || TERMINAL.has(current.state)) return current ? this.response(data,current) : null;
        if (current.signature !== op.signature || fingerprint(this.configForOperation(data,current)) !== fingerprint(config)) fail('Saved transaction changed during reconciliation.', 409);
        this.applyReceipt(data,current,result); await this.save(data); return this.response(data,current);
      });
      if(result.state==='pending'&&result.canRebroadcast===true&&response?.operation?.state==='pending')return await this.rebroadcastSaved(op.id)||response;
      return response;
    }));
  }
  async rebroadcastSaved(operationId) {
    const snapshot=await this.load(),op=snapshot.operations.find(o=>o.id===operationId);
    if(!op||TERMINAL.has(op.state)||op.state==='confirmed'||!op.signedTransaction||this.now()-(op.lastBroadcastAttemptAt||op.sentAt||op.createdAt)<REBROADCAST_INTERVAL_MS)return null;
    const config=this.configForOperation(snapshot,op);await this.binding(snapshot,{operation:op,launching:['fund-quote','prepare-buy'].includes(op.action)});
    const bytes=signed(op.signedTransaction),tx=VersionedTransaction.deserialize(bytes);
    let guardCount,messageChanged;try{({guardCount,changed:messageChanged}=validateDammPumpWalletMessage(tx,op.bundle));}catch{fail('The saved transaction no longer matches its original review.',409);}
    if(guardCount!==(op.walletGuardCount||0)||messageChanged!==(op.walletMessageChanged===true||(op.walletGuardCount||0)>0)||bs58.encode(tx.signatures[0])!==op.signature)fail('The saved transaction no longer matches its original review.',409);
    verifySignedTransaction(bytes,op.wallet,op.bundle.needsRelayer?[snapshot.relayer.address]:[]);
    if(guardCount)await this.adapter.verifyWalletGuardProgram();
    if(tx.message.addressTableLookups.length||VersionedTransaction.deserialize(Buffer.from(op.bundle.unsignedTransaction,'base64')).message.addressTableLookups.length){if(typeof this.adapter.verifyLookupTables!=='function')fail('Lookup table verification is unavailable.',409);await this.adapter.verifyLookupTables(config,op.bundle,snapshot.launches.find(l=>l.mint===op.mint));}
    const ready=await this.locked(async()=>{
      const data=await this.load(),current=data.operations.find(o=>o.id===op.id);
      if(!current||TERMINAL.has(current.state)||current.state==='confirmed'||current.signature!==op.signature||current.signedTransaction!==op.signedTransaction||this.now()-(current.lastBroadcastAttemptAt||current.sentAt||current.createdAt)<REBROADCAST_INTERVAL_MS)return false;
      if(fingerprint(this.configForOperation(data,current))!==fingerprint(config))fail('The saved controller configuration changed.',409);
      current.lastBroadcastAttemptAt=this.now();await this.save(data);return true;
    });
    return ready?this.markBroadcast(op.id,config,op.signedTransaction,op.signature):null;
  }
  async markBroadcast(operationId, config, encoded, signature) {
    let sent = false;
    try { sent = await this.adapter.send(config, encoded) === signature; } catch {}
    return this.locked(async () => {
      const fresh = await this.load(), saved = fresh.operations.find(o => o.id === operationId);
      if (saved && !TERMINAL.has(saved.state) && saved.state !== 'confirmed') saved.state = sent ? 'submitted' : 'pending';
      await this.save(fresh); return saved ? this.response(fresh,saved) : null;
    });
  }
  async tick() {
    let data = await this.load(); if (!data.relayer) return;
    this.syncGraduationWatcher(data);
    // RPC work occurs outside the journal lock. Readers/traders are not blocked
    // by a slow graduation scan or a provider's delayed receipt response.
    const pending = data.operations.filter(o => o.state !== 'awaiting_signature' && !TERMINAL.has(o.state)).slice(0,12);
    for (let offset=0;offset<pending.length;offset+=3) await Promise.allSettled(pending.slice(offset,offset+3).map(op => this.receiptOutsideLock(data,op)));
    data = await this.load();
    const candidates = data.launches.filter(l => l.confirmationStatus !== 'confirmed' && (l.status==='trading'||l.status==='bonded'||l.status==='migrated'&&!l.protocolFeeCollectionComplete&&!(l.nextFeeCheckAt>this.now())));
    const start = data.migrationCursor % Math.max(1,candidates.length), batch = [];
    for (let n=0;n<Math.min(20,candidates.length);n++) batch.push(candidates[(start+n)%candidates.length]);
    await this.locked(async () => { const fresh=await this.load();fresh.migrationCursor=start+20;await this.save(fresh); });
    for (let offset=0;offset<batch.length;offset+=3) await Promise.allSettled(batch.slice(offset,offset+3).map(launch => this.graduateCandidate(data,launch)));
  }
  async automaticTransaction(snapshot,launch,action,{authorize,confirmedEndpoint=false,finishQuote=null}={}) {
    const feeCollection=action==='protocol-fees',finishing=action==='buy'&&finishQuote!==null;
    if(!['migrate','protocol-fees'].includes(action)&&!finishing)fail('Unsupported automatic transaction.',409);
    const finishPlan=finishing?checkedGraduationFinishQuote(finishQuote,launch):null;
    if(snapshot.operations.some(o=>o.mint===launch.mint&&!TERMINAL.has(o.state)&&o.state!=='awaiting_signature'))return {state:'pending'};
    const config=this.configForLaunch(snapshot,launch);await this.binding(snapshot,{launch});
    const balance=feeCollection||finishing?BigInt(await this.adapter.balance(config,snapshot.relayer.address)):null;
    if((feeCollection||finishing)&&balance<=MIN_RELAYER_BALANCE)return {state:'skipped',notice:finishing?'Automatic graduation is waiting for SOL above the 0.03 SOL gas reserve.':'Protocol collection is waiting for gas above the graduation reserve.'};
    const bundle=await this.adapter.prepare(config,{action,wallet:snapshot.relayer.address,relayer:snapshot.relayer.address,launch,now:this.now(),...(finishing?{amountRaw:finishPlan.amountRaw,slippageBps:100}:{})});
    if(finishing){
      if(bundle.action!=='buy'||bundle.atomicGraduation!==true||bundle.needsRelayer||bundle.atomicQuoteFunding||bundle.fundingPlan||bundle.amountRaw!==finishPlan.amountRaw||bundle.trade?.input!==finishPlan.amountRaw||bundle.review?.maxQuoteDebitRaw!==finishPlan.amountRaw||BigInt(amount(bundle.review?.expectedQuoteDebitRaw))<=0n||BigInt(bundle.review.expectedQuoteDebitRaw)>MAX_GRADUATION_FINISH_SOL||bundle.trade?.charged!==bundle.review.expectedQuoteDebitRaw)fail('Automatic finishing requires one bounded atomic buy and graduation.',409);
    }
    await this.binding(snapshot,{launch});
    const debit=feeCollection||finishing?BigInt(amount(bundle.review?.maxWalletDebitLamports)):0n;
    if((feeCollection||finishing)&&balance-debit<MIN_RELAYER_BALANCE)return {state:'skipped',notice:finishing?'Automatic graduation is waiting for its reviewed buy and account costs plus the 0.03 SOL gas reserve.':'Protocol collection would use the reserved graduation gas.'};
    const prepared=VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction,'base64'));
    if(prepared.message.addressTableLookups.length){if(!validLookupSnapshot(prepared,bundle)||typeof this.adapter.verifyLookupTables!=='function')fail('Automatic transaction lookup table proof is unavailable.',409);await this.adapter.verifyLookupTables(config,bundle,launch);}
    if(authorize)await authorize();
    const saved=await this.locked(async()=>{
      const data=await this.load(),record=data.launches.find(l=>l.mint===launch.mint);
      if(!record||record.status==='migrated'&&!feeCollection)return {state:'skipped'};
      if(data.operations.some(o=>o.mint===launch.mint&&!TERMINAL.has(o.state)&&o.state!=='awaiting_signature'))return {state:'pending'};
      if(fingerprint(this.configForLaunch(data,record))!==fingerprint(config))fail('Deployment changed before the automatic transaction.',409);
      if(feeCollection||finishing){
        const reserved=data.operations.filter(o=>o.wallet===data.relayer.address&&!TERMINAL.has(o.state)&&o.state!=='awaiting_signature').reduce((sum,o)=>sum+BigInt(amount(o.bundle?.review?.maxWalletDebitLamports)),0n);
        // Another operation may have finalized during simulation, removing its
        // reservation while already spending SOL. Refresh inside the journal
        // lock so that freed reservations cannot reuse that older balance.
        const currentBalance=finishing?BigInt(amount(await this.adapter.balance(config,data.relayer.address))):balance,spendableBalance=currentBalance<balance?currentBalance:balance;
        if(spendableBalance-debit-reserved<MIN_RELAYER_BALANCE)return {state:'skipped',notice:finishing?'Automatic graduation is waiting for SOL not reserved by other saved transactions or the 0.03 SOL gas reserve.':'Protocol collection is preserving gas for saved transactions and graduation.'};
      }
      if(authorize)await authorize();
      const tx=VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction,'base64'));
      if(tx.version!==0||tx.signatures.some(signature=>signature.some(Boolean))||tx.message.header.numRequiredSignatures!==1||tx.message.staticAccountKeys[0].toBase58()!==data.relayer.address)fail('Unexpected automatic transaction signer.',409);
      const key=this.signer(data);try{tx.sign([key]);}finally{key.secretKey.fill(0);}
      const encoded=Buffer.from(tx.serialize()).toString('base64');verifySignedTransaction(Buffer.from(encoded,'base64'),data.relayer.address);
      const op={id:randomUUID(),action,mint:launch.mint,wallet:data.relayer.address,ownerId:null,...(finishing?{purpose:'graduation-finish',finishPlan:safe(finishPlan)}:{}),state:'journaled',createdAt:this.now(),lastBroadcastAttemptAt:this.now(),bundle:safe(bundle),signedTransaction:encoded,signature:bs58.encode(tx.signatures[0]),configFingerprint:fingerprint(config)};
      data.operations.push(op);if(!feeCollection){if(!confirmedEndpoint&&!finishing)record.status='bonded';record.migrationNotice=finishing?'The final buy and graduation are submitted; waiting for their finalized receipt.':'Graduation submitted; waiting for its finalized receipt.';}record.retryAt=this.now()+15000;
      await this.save(data);return {state:'requested',op};
    });
    if(saved.op)await this.markBroadcast(saved.op.id,config,saved.op.signedTransaction,saved.op.signature);
    return {state:saved.state,...(saved.notice?{notice:saved.notice}:{}),...(saved.op?{operationId:saved.op.id,mint:launch.mint,signature:saved.op.signature}:{})};
  }
  async claimFees(session,input,context) {
    object(input,[]);const authorize=()=>this.authorize(session,context,null,true);await authorize();
    const data=await this.load();
    const candidates=data.launches.filter(l=>['trading','bonded','migrated'].includes(l.status)&&l.confirmationStatus!=='confirmed');
    const start=(data.manualFeeCursor||0)%Math.max(1,candidates.length),batch=[];
    for(let i=0;i<Math.min(20,candidates.length);i++)batch.push(candidates[(start+i)%candidates.length]);
    const result={scanned:batch.length,total:candidates.length,requested:0,skipped:0,pending:0,notices:[],operations:[]};
    for(const launch of batch){
      await authorize();const snapshot=await this.load();
      if(snapshot.operations.some(o=>o.mint===launch.mint&&!TERMINAL.has(o.state)&&o.state!=='awaiting_signature')){result.pending++;continue;}
      try{
        const config=this.configForLaunch(snapshot,launch);await this.binding(snapshot,{launch});
        const current=await this.adapter.state(config,launch);
        if(!current||current.phase==='bonded'||BigInt(await this.adapter.pendingProtocolFees(config,launch))===0n){result.skipped++;continue;}
        const outcome=await this.automaticTransaction(snapshot,launch,'protocol-fees',{authorize});
        result[outcome.state==='requested'?'requested':outcome.state==='pending'?'pending':'skipped']++;
        if(outcome.operationId)result.operations.push({mint:launch.mint,operationId:outcome.operationId,signature:outcome.signature});
        if(outcome.notice)result.notices.push({mint:launch.mint,notice:outcome.notice});
      }catch(error){
        await authorize();result.skipped++;result.notices.push({mint:launch.mint,notice:error?.code==='DAMM_VENUE_PROOF'?error.message:'This protocol claim is waiting for verified chain data or relayer gas.'});
      }
    }
    await authorize();await this.locked(async()=>{const fresh=await this.load();fresh.manualFeeCursor=start+batch.length;await this.save(fresh);});
    this.kick();return result;
  }
  async graduateCandidate(snapshot, launch) {
    if (launch.retryAt > this.now() || this.closed || launch.confirmationStatus === 'confirmed') return;
    if(snapshot.operations.some(o=>o.mint===launch.mint&&!TERMINAL.has(o.state)&&o.state!=='awaiting_signature'))return;
    try {
      const config=this.configForLaunch(snapshot,launch);await this.binding(snapshot,{launch});
      const current=await this.adapter.state(config,launch); if (!current) return;
      // A confirmed endpoint may safely trigger a simulated migration, but it
      // is only a scheduling hint. The signed journal and finalized receipt
      // remain authoritative.
      const confirmedEndpoint=current.phase==='trading'&&typeof this.adapter.graduationReady==='function'&&await this.adapter.graduationReady(config,launch)===true;
      if(current.phase==='trading'&&!confirmedEndpoint&&launch.quoteMint===DAMM_PUMP_SOL&&typeof this.adapter.graduationFinishQuote==='function'){
        const finishQuote=await this.adapter.graduationFinishQuote(config,launch,snapshot.relayer.address);
        if(finishQuote){
          const outcome=await this.automaticTransaction(snapshot,launch,'buy',{finishQuote});
          if(outcome.notice)await this.locked(async()=>{const data=await this.load(),record=data.launches.find(l=>l.mint===launch.mint);if(record&&record.status!=='migrated'){record.migrationNotice=outcome.notice;record.retryAt=this.now()+30000;await this.save(data);}});
          return;
        }
      }
      let feeCollection=false;
      if(current.phase!=='bonded'&&!confirmedEndpoint&&typeof this.adapter.feesReady==='function'&&!(launch.nextFeeCheckAt>this.now())) {
        const quote=await this.getQuotePrice(launch.quoteMint,launch).catch(()=>null);
        feeCollection=await this.adapter.feesReady(config,launch,current,{quote,minimumUsd:MIN_AUTOMATIC_FEE_USD});
        await this.locked(async()=>{const data=await this.load(),row=data.launches.find(l=>l.mint===launch.mint);if(row){row.nextFeeCheckAt=this.now()+3600000;await this.save(data);}});
      }
      if (!feeCollection && current.phase!=='bonded'&&!confirmedEndpoint) {
        if (current.phase!==launch.status) await this.locked(async()=>{const data=await this.load(),saved=data.launches.find(l=>l.mint===launch.mint);if(saved&&saved.status!=='migrated'){saved.status=current.phase;if(current.poolId)saved.poolId=current.poolId;await this.save(data);}});
        return;
      }
      await this.automaticTransaction(snapshot,launch,feeCollection?'protocol-fees':'migrate',{confirmedEndpoint});
    }catch(error){
      await this.locked(async()=>{const data=await this.load(),record=data.launches.find(l=>l.mint===launch.mint);if(record&&record.status!=='migrated'){record.migrationNotice=error?.code==='DAMM_VENUE_PROOF'?error.message:'Graduation is waiting for a verified RPC response or relayer gas. It will retry automatically.';record.retryAt=this.now()+30000;await this.save(data);}}).catch(()=>{});
    }
  }
}
