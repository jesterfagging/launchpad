import { createHash, createPublicKey, verify, randomUUID, randomBytes } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { verifySignedTransaction } from './providers.mjs';
import { staticWalletChange, verifyWalletGuardProgram as verifyGuardProgramOnChain, simulateWalletChangedTransaction } from './wallet-guard-program.mjs';
import { publicPumpVisible, publicPumpLive, pumpAdminRow, setPumpArchive } from './pump-public-moderation.mjs';

export const PUMP_PUBLIC_SOL = 'So11111111111111111111111111111111111111112';
export const PUMP_PUBLIC_TREASURY = 'HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF';
// Retirement only applies to new launches. Saved receipts, trading, fee
// collection and graduation for existing Pump coins keep running.
export const PUMP_NEW_LAUNCHES_ENABLED = false;
export const PUMP_PUBLIC_DEFAULTS = Object.freeze({ initialFdvUsd: 20000, graduationFdvUsd: 50000, graduationFeeBps: 2885, tradeFeeBps: 100, creatorFeeBps: 50, totalTradeFeeBps: 150, tokenDecimals: 6, supply: '1000000000', lpPolicy: 'All received LP is burned in the graduation transaction.', creatorFees: true, postGradCreatorFeeBps: 0, holderRewards: false });
const STORE = 'pump-public', TERMINAL = new Set(['finalized', 'failed', 'expired', 'cancelled']);
const MIN_RELAYER_BALANCE = 1000000n;
const hash = value => createHash('sha256').update(value).digest('hex');
const safe = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item));
const fail = (message, statusCode = 400) => { throw Object.assign(Error(message), { statusCode }); };
const empty = () => ({ schemaVersion: 1, config: null, relayer: null, launches: [], operations: [], enabled: false, migrationCursor: 0 });
const object = (input, keys) => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) fail('Unsupported PumpSwap input.'); };
function address(value) { try { if (typeof value !== 'string' || new PublicKey(value).toBase58() !== value) throw Error(); return value; } catch { fail('Invalid Solana address.'); } }
function amount(value, optional = false) { if (optional && value === undefined) return '0'; if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > (1n << 64n) - 1n) fail('Invalid token amount.'); return value; }
function label(value, max, name, optional = false) { if (optional && value === undefined) return ''; if (typeof value !== 'string' || value !== value.trim() || Buffer.byteLength(value) > max || /[\x00-\x1f\x7f]/.test(value) || (!optional && !value)) fail(`Invalid ${name}.`); return value; }
function signed(value) { if (typeof value !== 'string' || value.length > 1800) fail('A wallet-signed transaction is required.'); const bytes = Buffer.from(value, 'base64'); if (bytes.length > 1232 || bytes.toString('base64') !== value) fail('Invalid wallet-signed transaction.'); return bytes; }

/** Verify the user's signature before adding the narrowly scoped platform signature. */
export function verifyPublicWalletTransaction(encoded, bundle, wallet, relayer) {
  let tx, prepared;
  try {
    tx = VersionedTransaction.deserialize(signed(encoded)); prepared = VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction, 'base64'));
    // Phantom/Solflare may set a bounded priority fee/compute limit or append
    // Lighthouse assertions; every reviewed instruction must still match.
    if (tx.version !== 0 || tx.message.addressTableLookups.length) throw Error();
    staticWalletChange(tx, bundle.unsignedTransaction);
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map(k => k.toBase58());
    const expected = bundle.needsRelayer ? [wallet, relayer] : [wallet];
    if (signers.length !== expected.length || signers[0] !== wallet || expected.some(k => !signers.includes(k))) throw Error();
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(wallet).toBuffer()]), format: 'der', type: 'spki' });
    if (!verify(null, tx.message.serialize(), key, tx.signatures[0])) throw Error();
    if (bundle.needsRelayer && tx.signatures[signers.indexOf(relayer)].some(Boolean)) throw Error();
    return tx;
  } catch { throw Object.assign(Error('The wallet changed the reviewed transaction or did not sign it. Nothing was submitted. Approve this step again.'),{statusCode:400,code:'WALLET_TRANSACTION_REJECTED'}); }
}

/** All secrets and signed wire bytes are in the existing encrypted host store. */
export class PumpPublicService {
  constructor({ accounts, requireOwner, adapter, getSolUsdPrice, getCreationFee = async () => ({lamports:'0',recipient:PUMP_PUBLIC_TREASURY}), publishMetadata, now = Date.now, intervalMs = 15000, verifyWalletTransaction = verifyPublicWalletTransaction }) {
    Object.assign(this, { accounts, requireOwner, adapter, getSolUsdPrice, getCreationFee, publishMetadata, now, intervalMs, verifyWalletTransaction }); this.timer = null; this.running = null; this.closed = false; this.commitQueue = Promise.resolve();
  }
  async load() { const data = await this.accounts.hostStore.read(STORE, empty()); if (data?.schemaVersion !== 1 || !Array.isArray(data.launches) || !Array.isArray(data.operations) || typeof data.enabled !== 'boolean') fail('PumpSwap launch history is unavailable. Restore its original encrypted data.', 503); return data; }
  async save(data) { await this.accounts.hostStore.write(STORE, data); const directory = await open(this.accounts.dir, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  async locked(fn) {
    const previous = this.commitQueue; let resolveQueue; this.commitQueue = new Promise(done => { resolveQueue = done; }); await previous;
    let child;
    try {
      await mkdir(this.accounts.dir, { recursive: true, mode: 0o700 });
      // The kernel releases this advisory lock when the pipe closes, including
      // a host crash. No PID guessing, stale-file deletion or manual reset.
      if (process.platform !== 'linux') fail('Public custody hosting requires the Linux VPS lock service.', 503);
      const path = resolve(this.accounts.dir, 'pump-public.flock'); const file = await open(path, 'a', 0o600); await file.close();
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
  async installDeployment(config) { return this.locked(async () => { const data = await this.load(); if (!data.relayer || config.relayer !== data.relayer.address || config.treasury !== PUMP_PUBLIC_TREASURY || config.cluster !== 'mainnet-beta') fail('The public deployment does not match the managed relayer and treasury.', 409); if (data.config && data.launches.some(l => l.status !== 'draft') && config.programId !== data.config.programId) fail('Existing public launches are bound to their original program.', 409); await this.adapter.verifyDeployment(config, { allowDisabled: true }); const same = data.config && ['schemaVersion','cluster','programId','expectedProgramSha256','expectedDeploymentSlot','expectedUpgradeAuthority','treasury','relayer'].every(k => String(data.config[k]) === String(config[k])); if (!same) { data.config = safe(config); data.enabled = false; } await this.save(data); return { configured: true, publicEnabled: data.enabled }; }); }
  async binding(data, { newLaunch = false, ownerPreview = false } = {}) {
    if (!data.config || !data.relayer || data.config.relayer !== data.relayer.address || data.config.treasury !== PUMP_PUBLIC_TREASURY) fail('Public PumpSwap deployment is not configured.', 409);
    const verified = await this.adapter.verifyDeployment(data.config, { allowDisabled: !newLaunch, recovery: !newLaunch });
    if (newLaunch && ((!data.enabled && !ownerPreview) || !verified.enabled)) fail('New PumpSwap launches are not enabled.', 409);
    if (newLaunch && BigInt(await this.adapter.balance(data.config,data.relayer.address)) < MIN_RELAYER_BALANCE) fail('New PumpSwap launches are waiting for graduation gas funding.', 409);
    return verified;
  }
  async setEnabled(session, input, context) { object(input, ['enabled']); if (input.enabled && !PUMP_NEW_LAUNCHES_ENABLED) fail('New PumpSwap launches are paused in this release.',409); if (typeof input.enabled !== 'boolean') fail('Choose whether new public launches are enabled.'); await this.authorize(session, context, null, true); return this.locked(async () => { const data = await this.load(); if (input.enabled) { const verified = await this.binding(data); if (!verified.enabled) fail('Approve the on-chain public launch configuration first.', 409); if(BigInt(await this.adapter.balance(data.config,data.relayer.address))<MIN_RELAYER_BALANCE)fail('Fund the graduation relayer with at least 0.001 SOL before enabling public launches.',409); } await this.authorize(session, context, null, true); data.enabled = input.enabled; await this.save(data); return { publicEnabled: data.enabled }; }); }
  async setup(session, input, context) { object(input, []); await this.authorize(session, context, null, true); return this.ensureRelayer(); }
  async ownerStatus(session, context) { await this.authorize(session, context, null, true); const data = await this.load(), status = await this.publicStatus(session,context); let balanceLamports = null, canEnable = false; if (data.relayer && data.config) try { balanceLamports = await this.adapter.balance(data.config, data.relayer.address); canEnable = PUMP_NEW_LAUNCHES_ENABLED && (await this.binding(data)).enabled === true && BigInt(balanceLamports) >= MIN_RELAYER_BALANCE; } catch {} return { ...status, ready: canEnable, canEnable, programId: data.config?.programId || null, relayer: data.relayer?.address || null, relayerBalanceLamports: balanceLamports, relayerMinimumBalanceLamports: MIN_RELAYER_BALANCE.toString(), recommendedBalanceLamports: '30000000', treasury: PUMP_PUBLIC_TREASURY, config: data.config ? { programId: data.config.programId, verifiedAt: data.config.verifiedAt, expectedDeploymentSlot: data.config.expectedDeploymentSlot } : null, migrations: data.launches.filter(l => l.status === 'bonded').map(l => ({ mint: l.mint, retryAt: l.retryAt || null, notice: l.migrationNotice || null })) }; }
  async publicStatus(session, context) {
    if (!PUMP_NEW_LAUNCHES_ENABLED) return { available:false, publicEnabled:false, ownerPreview:false, configured:!!(await this.load()).config, newLaunchesHidden:true, defaults:PUMP_PUBLIC_DEFAULTS, pairs:[], blockers:['New PumpSwap launches are paused. Existing coins remain accessible.'] };
    const data=await this.load();let ready=false,ownerPreview=false,blockers=[];
    if(data.config)try{const verified=await this.binding(data);ready=verified.enabled&&BigInt(await this.adapter.balance(data.config,data.relayer.address))>=MIN_RELAYER_BALANCE;}catch{blockers=['PumpSwap launches are temporarily unavailable while deployment checks complete.'];}
    else blockers=['PumpSwap public deployment is not configured.'];
    if(ready&&!data.enabled&&session&&context)try{await this.authorize(session,context,null,true);ownerPreview=true;}catch{}
    const publicEnabled=ready&&data.enabled,available=publicEnabled||ownerPreview;
    return {available,publicEnabled,ownerPreview,configured:!!data.config,defaults:PUMP_PUBLIC_DEFAULTS,pairs:available?[{mint:PUMP_PUBLIC_SOL,symbol:'SOL',name:'Solana',decimals:9,supported:true,launchReady:true}]:[],blockers};
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
      const account=byId.get(launch.creatorId)||{id:launch.creatorId,username:''},adminRow=pumpAdminRow(account,launch,data.operations);
      return {account:{id:account.id,username:account.username},adminRow,launch:{id:launch.id,createdAt:launch.createdAt,state:launch.status,curve:launch.stateAddress||null,input:{route:'pumpswap',network:'mainnet-beta',name:launch.name,symbol:launch.symbol,recipient:launch.creatorWallet,feeMode:'creator',quoteMint:PUMP_PUBLIC_SOL},keys:{mint:{address:launch.mint},wallet:{address:launch.custodyAuthority}},moderation:{hidden:launch.moderation?.hidden===true},listArchive:{archived:launch.listArchive?.archived===true}}};
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
      await this.save(data);return {route:'pumpswap',id:launch.id,mint:launch.mint,hidden:input.hidden};
    });
  }
  async adminArchive(actorId,input={}){
    await this.requireAdmin(actorId);if(typeof input.archived!=='boolean')fail('Choose whether to archive or restore this request.');
    return this.locked(async()=>{
      const data=await this.load(),launch=this.adminLaunch(data,input),account=await this.accounts.get(launch.creatorId);
      await this.requireAdmin(actorId);
      if(setPumpArchive(launch,data.operations,{archived:input.archived,actorId,at:this.now()}))await this.save(data);
      return {route:'pumpswap',launch:pumpAdminRow(account,launch,data.operations)};
    });
  }
  publicLaunch(launch) { if (!launch) return null; const { mint, name, symbol, description, image, website, twitter, telegram, creatorWallet, creatorId, createdAt, confirmedAt, finalizedAt, confirmationStatus, status, poolId, custodyAuthority, stateAddress, publicProgramId, metadataUri, priceSnapshot, migrationSignature, creatorFeesPending, creatorFeesPaid, creatorFeesAt } = launch; return { id: launch.id, hidden:launch.moderation?.hidden===true, archived:launch.listArchive?.archived===true, mint, name, symbol, description, image, website, twitter, telegram, creatorWallet, creatorId, createdAt, confirmedAt, finalizedAt, confirmationStatus, status, poolId, custodyAuthority, stateAddress, publicProgramId, metadataUri, priceSnapshot, migrationSignature, creatorFeesPending, creatorFeesPaid, creatorFeesAt, platform: 'pumpswap', launchMode: 'pumpswap', quoteMint: PUMP_PUBLIC_SOL, ...PUMP_PUBLIC_DEFAULTS }; }
  async publicList() { return (await this.load()).launches.filter(publicPumpVisible).map(l => this.publicLaunch(l)); }
  // Financial history retains confirmed coins after discovery moderation, as
  // the existing Raydium reports do. These rows carry public fields only.
  async analyticsList() { return (await this.load()).launches.filter(publicPumpLive).map(l => this.publicLaunch(l)); }
  // Moderation removes discovery placement, never the onchain custody or a
  // holder's direct coin access. Private accounts also retain their full book.
  async publicDetail(mint) { return this.publicLaunch((await this.load()).launches.find(l => l.mint === mint&&publicPumpLive(l))) || null; }
  async listAccount(session) { return (await this.load()).launches.filter(l => l.creatorId === session.account.id).map(l => this.publicLaunch(l)); }
  async operations(session, context) { await this.authorize(session, context); return { operations: (await this.load()).operations.filter(o => o.ownerId === session.account.id && !TERMINAL.has(o.state)).map(o => this.publicOperation(o)) }; }
  async wallet(session, input, context) { object(input, ['mint','expectedWallet']); address(input.mint); const wallet = address(input.expectedWallet); await this.authorize(session, context, wallet); const data = await this.load(), launch = data.launches.find(l => l.mint === input.mint && l.status !== 'draft'); if (!launch) fail('Coin not found.', 404); return this.adapter.wallet(data.config, launch, wallet); }
  publicOperation(op) { return { id: op.id, action: op.action, wallet: op.wallet, mint: op.mint, state: op.state, expiresAt: op.expiresAt, signature: op.signature || null, review: op.review, ...(op.state === 'awaiting_signature' ? { transaction: op.bundle.unsignedTransaction } : {}), ...(op.result ? { result: op.result } : {}) }; }
  response(data, op) { return { operation: this.publicOperation(op), launch: this.publicLaunch(data.launches.find(l => l.mint === op.mint)) }; }
  async prepare(session, input, context) {
    object(input, ['action', 'expectedWallet', 'mint', 'name', 'symbol', 'description', 'image', 'website', 'twitter', 'telegram', 'amountRaw', 'slippageBps']);
    if (!['initialize', 'buy', 'sell'].includes(input.action)) fail('Choose a launch, buy, or sell action.');
    if (input.action === 'initialize' && !PUMP_NEW_LAUNCHES_ENABLED) fail('New PumpSwap launches are paused. Choose Raydium or Meteora.', 409);
    const wallet = address(input.expectedWallet); await this.authorize(session, context, wallet);
    const quantity = amount(input.amountRaw, input.action === 'initialize');
    const slippageBps = input.slippageBps ?? 100;
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10000) fail('Slippage must be between 0% and 100%.');
    if (input.action !== 'initialize' && BigInt(quantity) === 0n) fail('Enter an amount greater than zero.');
    {
      const data = await this.load(), ownerPreview = input.action === 'initialize' && !data.enabled; if(ownerPreview)await this.authorize(session,context,wallet,true); await this.binding(data, { newLaunch: input.action === 'initialize', ownerPreview });
      const pending = data.operations.find(o => o.ownerId === session.account.id && o.wallet === wallet && !TERMINAL.has(o.state));
      if (pending) { if (pending.state === 'awaiting_signature' && pending.expiresAt <= this.now()) pending.state = 'cancelled'; else fail('Check your saved transaction before preparing another.', 409); }
      let launch;
      if (input.action === 'initialize') {
        const name = label(input.name, 32, 'coin name'), symbol = label(input.symbol, 10, 'ticker'), description = label(input.description, 1000, 'description', true), image = label(input.image, 500, 'image', true), website = label(input.website, 200, 'website', true), twitter = label(input.twitter, 200, 'Twitter', true), telegram = label(input.telegram, 200, 'Telegram', true);
        if ([website,twitter,telegram].some(link => link && !/^https:\/\//.test(link))) fail('Use an HTTPS website address.');
        const price = await this.getSolUsdPrice();
        if (!price || !Number.isFinite(Number(price.usd)) || Number(price.usd) < 1 || Number(price.usd) > 100000 || !Number.isSafeInteger(price.at) || price.at > this.now() + 5000 || this.now() - price.at > 60000) fail('A fresh SOL/USD price is required. Try again shortly.', 409);
        const mintSeed = `mint-${randomBytes(12).toString('hex')}`, mint = await this.adapter.deriveMint(wallet, mintSeed);
        const metadataUri = await this.publishMetadata({ accountId: session.account.id, mint, name, symbol, description, image, website, twitter, telegram });
        launch = { id: randomUUID(), mint, mintSeed, name, symbol, description, image, website, twitter, telegram, metadataUri, creatorWallet: wallet, creatorId: session.account.id, publicProgramId: data.config.programId, createdAt: this.now(), status: 'draft', priceSnapshot: { usd: String(price.usd), at: price.at, source: price.source || 'Live SOL/USD reference', solUsdMicros: String(Math.round(Number(price.usd) * 1e6)) } };
        const creationFee = await this.getCreationFee(); amount(creationFee?.lamports); address(creationFee?.recipient); if(BigInt(creationFee.lamports)>100000000n)fail('The configured creation fee exceeds the platform limit.',409); launch.creationFee = {lamports:creationFee.lamports,recipient:creationFee.recipient};
      } else { address(input.mint); launch = data.launches.find(l => l.mint === input.mint && ['trading', 'bonded'].includes(l.status)); if (!launch) fail('This bonding curve is unavailable. Graduated coins trade through their PumpSwap pool.', 409); }
      const bundle = await this.adapter.prepare(data.config, { action: input.action, wallet, launch, amountRaw: quantity, slippageBps, relayer: data.relayer.address, now: this.now() });
      const tx = VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction, 'base64'));
      if (tx.version !== 0 || tx.message.staticAccountKeys[0]?.toBase58() !== wallet || tx.signatures.some(s => s.some(Boolean)) || tx.message.header.numRequiredSignatures !== (input.action === 'initialize' ? 2 : 1)) fail('The prepared transaction has unexpected signers.', 409);
      if (input.action === 'initialize') { launch.custodyAuthority = bundle.addresses?.authority || bundle.addresses?.vault; launch.stateAddress = bundle.addresses?.state; }
      const op = { id: randomUUID(), ownerId: session.account.id, sessionHash: hash(context.sessionToken), wallet, action: input.action, ownerPreview, mint: launch.mint, state: 'awaiting_signature', createdAt: this.now(), expiresAt: Math.min(this.now() + 120000, (bundle.preparedAt || this.now()) + 120000), configFingerprint: hash(JSON.stringify(data.config)), bundle: safe(bundle), review: { ...safe(bundle.review || bundle.details || {}), ...PUMP_PUBLIC_DEFAULTS, quoteMint: PUMP_PUBLIC_SOL, solUsd: launch.priceSnapshot.usd, priceObservedAt: launch.priceSnapshot.at, custodyAuthority: launch.custodyAuthority, treasury: PUMP_PUBLIC_TREASURY }, messageHash: hash(tx.message.serialize()) };
      await this.authorize(session, context, wallet);
      return this.locked(async () => {
        const fresh = await this.load();
        if (hash(JSON.stringify(fresh.config)) !== op.configFingerprint) fail('Deployment changed during preparation. Review again.', 409);
        for (const previous of fresh.operations.filter(o => o.ownerId === session.account.id && o.wallet === wallet && !TERMINAL.has(o.state))) {
          if (previous.state === 'awaiting_signature' && previous.expiresAt <= this.now()) previous.state = 'cancelled';
          else fail('Check your saved transaction before preparing another.', 409);
        }
        if (input.action === 'initialize') fresh.launches.push(launch);
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
    await this.authorize(session,context,previous.wallet,previous.ownerPreview===true);
    if(previous.walletSignedTransaction&&previous.walletSignedTransaction!==input.signedTransaction)fail('Only the original signed transaction may be checked again.',409);
    if(TERMINAL.has(previous.state))return this.response(snapshot,previous);
    if(previous.state!=='awaiting_signature')return this.reconcile(session,{operationId:previous.id},context);
    if(previous.action==='initialize'&&!PUMP_NEW_LAUNCHES_ENABLED)fail('New PumpSwap launches are paused. This unsigned launch can be cancelled.',409);
    if(previous.expiresAt<=this.now())fail('This review expired. Prepare a fresh review.',409);
    if(previous.configFingerprint!==hash(JSON.stringify(snapshot.config)))fail('The deployment configuration changed. Review again.',409);
    await this.binding(snapshot,{newLaunch:previous.action==='initialize',ownerPreview:previous.ownerPreview===true});
    const tx=this.verifyWalletTransaction(input.signedTransaction,previous.bundle,previous.wallet,snapshot.relayer.address);
    let change;try{change=staticWalletChange(tx,previous.bundle.unsignedTransaction);}catch{throw Object.assign(Error('The wallet changed the reviewed transaction or did not sign it. Nothing was submitted. Approve this step again.'),{statusCode:400,code:'WALLET_TRANSACTION_REJECTED'});}
    if(change.changed){
      // Same immutable-guard proof and complete sigVerify simulation as the
      // other launch paths before the journaled copy is co-signed.
      const connection=this.adapter.connection;
      if(!connection&&(typeof this.adapter.simulateWalletTransaction!=='function'||change.guardCount&&typeof this.adapter.verifyWalletGuardProgram!=='function'))fail('Wallet safety verification is temporarily unavailable. Keep this step open and retry.',503);
      if(change.guardCount)await(this.adapter.verifyWalletGuardProgram?this.adapter.verifyWalletGuardProgram():verifyGuardProgramOnChain(connection));
      const candidate=VersionedTransaction.deserialize(tx.serialize());
      if(previous.bundle.needsRelayer){const key=this.signer(snapshot);try{candidate.sign([key]);}finally{key.secretKey.fill(0);}}
      await(this.adapter.simulateWalletTransaction?this.adapter.simulateWalletTransaction(candidate):simulateWalletChangedTransaction(connection,candidate));
    }
    const saved=await this.locked(async()=>{
      const data=await this.load(),op=data.operations.find(o=>o.id===previous.id);
      if(op.state!=='awaiting_signature')return null;
      if(op.configFingerprint!==hash(JSON.stringify(data.config))||op.expiresAt<=this.now())fail('The transaction review changed or expired.',409);
      if(op.action==='initialize'&&!data.enabled&&!op.ownerPreview)fail('New launches were disabled. Nothing was submitted.',409);
      await this.authorize(session,context,op.wallet,op.ownerPreview===true);
      if(op.bundle.needsRelayer){const key=this.signer(data);try{tx.sign([key]);}finally{key.secretKey.fill(0);}}
      const bytes=Buffer.from(tx.serialize());verifySignedTransaction(bytes,op.wallet,op.bundle.needsRelayer?[data.relayer.address]:[]);
      op.signedTransaction=bytes.toString('base64');op.walletSignedTransaction=input.signedTransaction;op.signature=bs58.encode(tx.signatures[0]);op.state='journaled';op.sentAt=this.now();
      await this.save(data);return {op,config:data.config};
    });
    if(!saved)return this.reconcile(session,{operationId:previous.id},context);
    await this.authorize(session,context,previous.wallet,previous.ownerPreview===true);await this.binding(await this.load(),{newLaunch:previous.action==='initialize',ownerPreview:previous.ownerPreview===true});
    const response=await this.markBroadcast(saved.op.id,saved.config,saved.op.signedTransaction,saved.op.signature);this.kick();return response;
  }
  async reconcile(session,input,context){
    object(input,['operationId']);await this.authorize(session,context);
    const data=await this.load(),op=data.operations.find(o=>o.id===input.operationId);
    if(!op||op.ownerId!==session.account.id)fail('Saved transaction not found.',404);
    if(op.state==='awaiting_signature'||TERMINAL.has(op.state))return this.response(data,op);
    await this.binding(data);const response=await this.receiptOutsideLock(data,op);await this.authorize(session,context);return response;
  }
  async reconcileSaved(data, op) {
    const launch = data.launches.find(l => l.mint === op.mint);
    const result = await this.adapter.reconcile(data.config, op, launch);
    this.applyReceipt(data, op, result);
  }
  applyReceipt(data, op, result) {
    const launch = data.launches.find(l => l.mint === op.mint);
    if (!['pending', 'confirmed', 'finalized', 'failed', 'expired'].includes(result?.state)) fail('Transaction receipt is unavailable.', 502);
    if (result.state === 'confirmed' && op.action !== 'initialize') fail('Only initialization supports early confirmation.', 502);
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
      launch.status = 'error'; launch.confirmationStatus = result.state;
    }
    if (result.state === 'finalized') {
      const phase = result.phase; if (!['trading', 'bonded', 'migrated'].includes(phase)) fail('Transaction state could not be verified.', 502);
      if (launch.status !== 'migrated') launch.status = phase; launch.finalizedAt ||= this.now(); launch.confirmationStatus = 'finalized'; launch.updatedAt = this.now();
      if (result.poolId) launch.poolId = result.poolId;
      if (result.creatorFeesPending !== undefined) launch.creatorFeesPending=result.creatorFeesPending;
      if (result.creatorFeesPaid !== undefined) launch.creatorFeesPaid=result.creatorFeesPaid;
      if (result.creatorFeesPending !== undefined && result.creatorFeesPaid !== undefined) launch.creatorFeesAt=this.now();
      if (op.action === 'migrate') { launch.migrationSignature = op.signature; launch.burnReceipt = safe(result); launch.migrationNotice = null; }
      if (result.trade) { op.trade = safe(result.trade); op.finalizedAt = this.now(); }
    }
  }
  async marketSnapshot(mint) { const data = await this.load(), launch = data.launches.find(l => l.mint === mint && l.status !== 'draft'); if (!launch || !data.config) return null; return this.adapter.marketSnapshot(data.config, launch, await this.getSolUsdPrice().catch(() => null)); }
  async analyticsTrades(mint) { return { trades: (await this.load()).operations.filter(o => o.mint === mint && o.state === 'finalized' && o.trade).map(o => ({ ...o.trade, signature: o.signature, wallet: o.wallet, at: o.finalizedAt, side: o.trade.side })), complete: false }; }
  async trades(mint) { return (await this.analyticsTrades(mint)).trades.slice(-200).reverse(); }
  start() { if (this.timer) return; this.closed = false; this.timer = setInterval(() => this.kick(), this.intervalMs); this.timer.unref?.(); this.kick(); }
  async stop() { this.closed = true; clearInterval(this.timer); this.timer = null; await (this.running || Promise.resolve()); this.adapter.close?.(); }
  kick() { if (this.closed || this.running) return; this.running = this.tick().catch(() => {}).finally(() => { this.running = null; }); }
  async receiptOutsideLock(snapshot, op) {
    const result = await this.adapter.reconcile(snapshot.config, op, snapshot.launches.find(l => l.mint === op.mint));
    return this.locked(async () => {
      const data = await this.load(), current = data.operations.find(o => o.id === op.id);
      if (!current || TERMINAL.has(current.state)) return current ? this.response(data,current) : null;
      if (current.signature !== op.signature || hash(JSON.stringify(data.config)) !== hash(JSON.stringify(snapshot.config))) fail('Saved transaction changed during reconciliation.', 409);
      this.applyReceipt(data,current,result); await this.save(data); return this.response(data,current);
    });
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
    let data = await this.load(); if (!data.config || !data.relayer) return; await this.binding(data);
    // RPC work occurs outside the journal lock. Readers/traders are not blocked
    // by a slow graduation scan or a provider's delayed receipt response.
    const pending = data.operations.filter(o => o.state !== 'awaiting_signature' && !TERMINAL.has(o.state)).slice(0,12);
    for (let offset=0;offset<pending.length;offset+=3) await Promise.allSettled(pending.slice(offset,offset+3).map(op => this.receiptOutsideLock(data,op)));
    data = await this.load();
    const candidates = data.launches.filter(l => l.confirmationStatus !== 'confirmed' && (l.status === 'trading' || l.status === 'bonded' || BigInt(l.creatorFeesPending||'0') > 0n));
    const start = data.migrationCursor % Math.max(1,candidates.length), batch = [];
    for (let n=0;n<Math.min(20,candidates.length);n++) batch.push(candidates[(start+n)%candidates.length]);
    await this.locked(async () => { const fresh=await this.load();fresh.migrationCursor=start+20;await this.save(fresh); });
    for (let offset=0;offset<batch.length;offset+=3) await Promise.allSettled(batch.slice(offset,offset+3).map(launch => this.graduateCandidate(data,launch)));
  }
  async graduateCandidate(snapshot, launch) {
    if (launch.retryAt > this.now() || this.closed || launch.confirmationStatus === 'confirmed') return;
    try {
      const current=await this.adapter.state(snapshot.config,launch); if (!current) return;
      const pending=String(current.creatorFeesPending||'0');
      if(pending!==String(launch.creatorFeesPending??'')||String(current.creatorFeesPaid??'')!==String(launch.creatorFeesPaid??''))await this.locked(async()=>{const data=await this.load(),row=data.launches.find(l=>l.mint===launch.mint);if(row){row.creatorFeesPending=pending;row.creatorFeesPaid=current.creatorFeesPaid;row.creatorFeesAt=this.now();await this.save(data);}});
      const creatorPayout=BigInt(pending)>0n && await this.adapter.creatorFeesReady(snapshot.config,launch,current);
      if (!creatorPayout && current.phase!=='bonded') {
        if (current.phase!==launch.status) await this.locked(async()=>{const data=await this.load(),saved=data.launches.find(l=>l.mint===launch.mint);if(saved&&saved.status!=='migrated'){saved.status=current.phase;if(current.poolId)saved.poolId=current.poolId;await this.save(data);}});
        return;
      }
      if (snapshot.operations.some(o=>o.mint===launch.mint&&!TERMINAL.has(o.state)&&o.state!=='awaiting_signature')) return;
      const automaticAction=creatorPayout?'creator-fees':'migrate';
      const bundle=await this.adapter.prepare(snapshot.config,{action:automaticAction,wallet:snapshot.relayer.address,relayer:snapshot.relayer.address,launch,now:this.now()});
      await this.binding(snapshot);
      const saved=await this.locked(async()=>{
        const data=await this.load(),record=data.launches.find(l=>l.mint===launch.mint);
        if (!record||record.status==='migrated'&&!creatorPayout||data.operations.some(o=>o.mint===launch.mint&&!TERMINAL.has(o.state)&&o.state!=='awaiting_signature')) return null;
        if (hash(JSON.stringify(data.config))!==hash(JSON.stringify(snapshot.config))) fail('Deployment changed before graduation.',409);
        const tx=VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction,'base64'));
        if(tx.message.header.numRequiredSignatures!==1||tx.message.staticAccountKeys[0].toBase58()!==data.relayer.address)fail('Unexpected migration signer.',409);
        const key=this.signer(data);try{tx.sign([key]);}finally{key.secretKey.fill(0);}
        const encoded=Buffer.from(tx.serialize()).toString('base64');verifySignedTransaction(Buffer.from(encoded,'base64'),data.relayer.address);
        const op={id:randomUUID(),action:automaticAction,mint:launch.mint,wallet:data.relayer.address,ownerId:null,state:'journaled',createdAt:this.now(),bundle:safe(bundle),signedTransaction:encoded,signature:bs58.encode(tx.signatures[0]),configFingerprint:hash(JSON.stringify(data.config))};
        data.operations.push(op);if(!creatorPayout){record.status='bonded';record.migrationNotice='Graduation submitted; waiting for its finalized receipt.';}record.retryAt=this.now()+15000;
        await this.save(data);return op;
      });
      if(saved)await this.markBroadcast(saved.id,snapshot.config,saved.signedTransaction,saved.signature);
    }catch{
      await this.locked(async()=>{const data=await this.load(),record=data.launches.find(l=>l.mint===launch.mint);if(record&&record.status!=='migrated'){record.migrationNotice='Graduation is waiting for a verified RPC response or relayer gas. It will retry automatically.';record.retryAt=this.now()+30000;await this.save(data);}}).catch(()=>{});
    }
  }
}
