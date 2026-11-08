import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { verifySignedTransaction } from './providers.mjs';
import { staticWalletChange, verifyWalletGuardProgram as verifyGuardProgramOnChain, simulateWalletChangedTransaction } from './wallet-guard-program.mjs';
import { weightedRewards, displayUnits, agentLaunchRequest } from '../public/launchpad-model.mjs';
import { validAgentAttachment } from './agent/launches.mjs';
import { rewardAnalyticsRecord, holderRewardJournalAudit, publicRewardAnalytics } from './public-reward-analytics.mjs';
import { mergeHolderRewardPayouts } from './meteora-rewards.mjs';
import { pumpArchiveView, setPumpArchive } from './pump-public-moderation.mjs';
import { meteoraFeeShares, meteoraPolicy } from './meteora-policy.mjs';
import { GOTCHI_METEORA_POLICY, validGotchiId } from '../public/gotchi-catalog.mjs';
import { VANITY_LIMITS } from './vanity-pool.mjs';
import { coinText, coinLink } from './pump-classic/coin-text.mjs';
import { HOOK_LIMITS, HOOK_ROUTES, HOOK_APP_SETTINGS, hookLaunchRequest, hookRuleById, describeHookRule, hookAppTradeNote, parseHookAppMark, describeHookAppMark, hookRuleByApp } from '../public/hook-catalog.mjs';
import { basketLaunchRequest, basketShares, describeBasket, BASKET_LIMITS } from '../public/basket-catalog.mjs';
import { requireTenantLaunch } from './tenant/gate.mjs';
import { padCheck } from './tenant/pad.mjs';

/** LAUNCHPAD_HOOK_PROGRAM_ID (v71.28): the deployed Launchpad transfer hook program. Unset or empty = transfer hook rules are off. */
export function meteoraHookProgramId(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  try { if (new PublicKey(text).toBase58() !== text) throw Error(); } catch { throw new Error('LAUNCHPAD_HOOK_PROGRAM_ID must be the base58 address of the deployed Launchpad transfer hook program.'); }
  return text;
}
/** LAUNCHPAD_HOOK_FOMO_MARK / LAUNCHPAD_HOOK_PUMP_APP_MARK (v71.36): how the hook program recognises the outside app an app-only rule locks
 *  pool trades to while the coin is on the curve — `signer:<wallet>` (the app's co-signer), `program:<id>` (a program the app
 *  invokes) or `program:<id>:account:<slot>` (the program invoked with that account slot filled, such as a router's commission
 *  slot). Unset or empty = that rule is not offered on this host. Never a built-in default: the owner names the mark. An already
 *  parsed mark ({ kind, key, index }) is accepted as is. */
export function meteoraHookAppMark(value, setting = 'LAUNCHPAD_HOOK_FOMO_MARK') {
  const mark = value && typeof value === 'object' ? value : parseHookAppMark(value, setting);
  if (!mark) return null;
  const kind = mark.kind === 'signer' || mark.kind === 'program' || mark.kind === 'program-account' ? mark.kind : null, index = kind === 'program-account' ? Number(mark.index) : 0;
  if (!kind || !Number.isInteger(index) || index < 0 || index > 63) throw new Error(`${setting} must be program:<program id>, signer:<wallet>, or program:<program id>:account:<slot>.`);
  const key = typeof mark.key === 'string' ? mark.key.trim() : '';
  try { if (new PublicKey(key).toBase58() !== key) throw Error(); } catch { throw new Error(`${setting}: ${key || 'the key'} is not a base58 Solana address.`); }
  return Object.freeze({ kind, key, index });
}
/** The app-only marks as the service keeps them: { fomo, pumpApp }, each { kind, key, index } or null. */
export function meteoraHookApps(value) {
  const given = value && typeof value === 'object' ? value : {};
  return Object.freeze(Object.fromEntries(Object.entries(HOOK_APP_SETTINGS).map(([app, setting]) => [app, meteoraHookAppMark(given[app] ?? null, setting)])));
}
// The hook summary carried by every view of a hooked launch (coin rows, My Tokens, operation receipts), contract v2: the rules in
// plain words (public/hook-catalog.mjs), the route ('any' = trades anywhere, 'curve' = Launchpad route only while on the curve) with its
// sentence, the gate token, the blocklist size, the tithe recipient, whether the rules run now (`active`: live on the curve) or have
// ended (`ended`: Meteora removes the hook at graduation), and the allowlist as recorded from changes submitted through Launchpad.
// Explore and coin-detail rows keep the public subset (src/launchpad-explore.mjs hookRowView). The mint authority is revoked at
// creation (Meteora's Immutable option), so nothing about it is reported.
function hookView(l) {
  const h = l?.hook; if (!h || !Array.isArray(h.rules) || !h.rules.length) return null;
  const rules = h.rules.map(r => { const item = hookRuleById(r.id); let text = ''; try { text = describeHookRule(r.id, r.settings); } catch { /* a rule the catalogue no longer knows is listed by name only */ } return { id: r.id, name: item?.name || r.id, text }; });
  const allowlist = Array.isArray(h.allowlist) ? h.allowlist.filter(w => typeof w === 'string') : [];
  const route = h.route === 'curve' ? 'curve' : h.route === 'app' ? 'app' : 'any', blocklist = Array.isArray(h.blocklist) ? h.blocklist.filter(w => typeof w === 'string') : [], ended = l.status === 'migrated';
  // An app-only coin (v71.35/v71.36, route 'app'): the app, its name and the mark frozen on the record; Launchpad's Buy and Sell are off
  // for it until graduation (`curveTrading` false with the sentence the coin page shows and the server refuses a trade with).
  const mark = h.appMark && typeof h.appMark === 'object' ? { kind: h.appMark.kind, key: h.appMark.key, index: h.appMark.index || 0 } : null;
  const app = route === 'app' ? { app: h.app || null, appName: h.appName || '', appMark: mark, appMarkText: mark ? describeHookAppMark(mark, h.appName || 'the app') : null } : { app: null, appName: '', appMark: null, appMarkText: null };
  return { version: h.version || 2, rules, route, routeName: HOOK_ROUTES[route].name, routeText: HOOK_ROUTES[route].text, ...app, curveTrading: route !== 'app' || ended, tradeNote: route === 'app' && !ended ? hookAppTradeNote(h.appName) : null, gateMint: h.gateMint || null, blocklistCount: h.needsBlocklist ? blocklist.length : 0, titheRecipient: h.titheRecipient || null, active: ['trading', 'bonded'].includes(l.status) && !!l.finalizedAt, ended, program: h.program || null, needsWalletState: h.needsWalletState === true, hasAllowlist: rules.some(r => r.id === 'allowlist'), hasBlocklist: h.needsBlocklist === true, allowlist, allowlistCount: allowlist.length, allowlistUpdatedAt: h.allowlistUpdatedAt || null };
}
// Reward baskets (v71.33): the public shape of a basket launch's assets (pair asset first) and its per-asset reward ledger.
function basketView(l){const b=l?.basket;if(!b||!Array.isArray(b.assets)||b.assets.length<2)return null;return {version:b.version||1,shares:'equal',count:b.assets.length,assets:b.assets.map(a=>({mint:a.mint,symbol:a.symbol,decimals:a.decimals})),description:describeBasket(b.assets.map(a=>a.symbol))};}
function basketRewardRows(l){
  if(!basketView(l))return null;const ledger=l.ledger||{};
  return l.basket.assets.map((a,i)=>{const row=i===0?{credit:ledger.creatorCredit||'0',paid:ledger.creatorPaid||'0'}:(ledger.basket?.[a.mint]||{credit:'0',paid:'0',converted:'0',payments:0});return {mint:a.mint,symbol:a.symbol,decimals:a.decimals,pendingRaw:row.credit||'0',pending:displayUnits(row.credit||'0',a.decimals),distributedRaw:row.paid||'0',distributed:displayUnits(row.paid||'0',a.decimals),...(i>0?{convertedRaw:row.converted||'0',payments:row.payments||0}:{})};});
}
const basketRounds=l=>(l.rewards?.rounds||[]).slice(-5).map(r=>({id:r.id,at:r.at,assets:(r.assets||[]).map(a=>({mint:a.mint,symbol:a.symbol,decimals:a.decimals,amountRaw:a.amountRaw,amount:displayUnits(a.amountRaw,a.decimals),recipients:a.recipients})),skipped:(r.skipped||[]).map(x=>({mint:x.mint,note:x.note}))}));
// An allowlist change lists base58 wallets, at most HOOK_LIMITS.allowlistBatch (20) per transaction; absent = no change of that kind.
function walletList(value) { if (value === undefined) return []; if (!Array.isArray(value) || value.length > HOOK_LIMITS.allowlistBatch) fail(`List at most ${HOOK_LIMITS.allowlistBatch} wallets.`); return value.map(address); }

const VANITY_DRAFT_LEASE_MS = VANITY_LIMITS.draftLeaseMs;
// A draft that took a vanity address and never signed anything (no configuration, no signed transaction, no AI Agent bound to its
// address): once its lease has lapsed and the pool hands the address to a new draft, the abandoned draft is retired with its
// unsigned requests. Nothing about it exists onchain.
const abandonedVanityDraft = (l, operations) => l.status === 'draft' && !!l.vanity?.address && l.vanity.address === l.mint && !l.vanity.committed && !l.configSignature && !l.agent && !operations.some(o => o.mint === l.mint && (o.signature || o.signedTransaction || o.walletSignedTransaction || !['cancelled', 'expired', 'awaiting_signature'].includes(o.state)));
function retireAbandonedDraft(data, mint) {
  const stale = data.launches.find(l => l.mint === mint && abandonedVanityDraft(l, data.operations)); if (!stale) return;
  data.launches = data.launches.filter(l => l !== stale); data.operations = data.operations.filter(o => o.mint !== mint);
}

export const METEORA_DEFAULTS = Object.freeze({ initialFdvUsd: 20000, graduationFdvUsd: 50000, tradeFeeBps: 188, creatorSharePercent: 33, partnerSharePercent: 67, tokenDecimals: 6, supply: '1000000000', migrationFeePercentage: 0, creatorFees: true, holderRewards: true, automaticFeeMinimumUsd: 1, transferTaxBps: 0, lpPolicy: '100% permanently locked; fee rights remain claimable.' });
const STORE = 'meteora-launches', TERMINAL = new Set(['finalized', 'failed', 'expired', 'cancelled']);
const LIVE = new Set(['trading', 'bonded', 'migrated']);
const AUTOMATIC = new Set(['creator-claim','partner-claim','payout','partner-payout','migrate','basket-convert']);
const MAX_U64 = (1n << 64n) - 1n, MIN_GAS = 30000000n, REWARD_INTERVAL = 3600000;
const hash = value => createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value, (_, x) => typeof x === 'bigint' ? String(x) : x));
const fail = (message, statusCode = 400) => { throw Object.assign(Error(message), {statusCode}); };
const empty = () => ({schemaVersion:1, enabled:false, config:null, authority:null, launches:[], operations:[], cursor:0});
function object(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail('Unsupported Meteora input.'); }
function address(value) { try { if (typeof value !== 'string' || new PublicKey(value).toBase58() !== value) throw Error(); return value; } catch { fail('Invalid Solana address.'); } }
function amount(value = '0') { if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > MAX_U64) fail('Invalid token amount.'); return value; }
function label(value, max, name, optional = false) { if (optional && value === undefined) return ''; if (typeof value !== 'string' || value !== value.trim() || Buffer.byteLength(value) > max || /[\x00-\x1f\x7f]/.test(value) || !optional && !value) fail(`Invalid ${name}.`); return value; }
function encodedTransaction(value) { if (typeof value !== 'string' || value.length > 1800) fail('A wallet-signed transaction is required.'); const bytes = Buffer.from(value,'base64'); if (!bytes.length || bytes.length > 1232 || bytes.toString('base64') !== value) fail('Invalid wallet-signed transaction.'); return bytes; }
function keyRecord() { const key = Keypair.generate(); try { return {address:key.publicKey.toBase58(),secretBase64:Buffer.from(key.secretKey).toString('base64')}; } finally { key.secretKey.fill(0); } }
function keyFrom(record) { let bytes; try { bytes = Buffer.from(record.secretBase64,'base64'); const key = Keypair.fromSecretKey(Uint8Array.from(bytes)); if (key.publicKey.toBase58() !== record.address) { key.secretKey.fill(0); throw Error(); } return key; } catch { fail('The original encrypted Meteora fee signer must be restored.',503); } finally { bytes?.fill(0); } }
const freshPrice = (price,mint,now) => !!price && (!price.mint || price.mint === mint) && Number.isFinite(Number(price.usd)) && Number(price.usd)>0 && Number.isSafeInteger(price.at) && price.at<=now+5000 && now-price.at<=60000 && price.stale!==true;
const configHash = data => hash(JSON.stringify(data.config));
const live = launch => LIVE.has(launch.status) && !!launch.finalizedAt;
const blocksWorker = op => !TERMINAL.has(op.state) && (op.state!=='awaiting_signature'||['creator-claim','payout'].includes(op.action));
const payoutSum = rows => rows.reduce((sum,row)=>sum+BigInt(amount(row.amount)),0n);
const heldSolMismatch = message => { throw Object.assign(Error(message),{statusCode:409,code:'HELD_SOL_INTEGRITY'}); };
const NATIVE_QUOTE = 'So11111111111111111111111111111111111111112';
const heldSolActive = launch => ['queued','processing'].includes(launch.heldSolDistribution?.status);
const protocolCollectionActive = launch => ['queued','processing'].includes(launch.protocolCollection?.status);
const protocolCollectionView = request => ({status:request.status,reason:request.reason||'',requestId:request.requestId,retryAt:request.retryAt||null});
// The adapter's own sentence for a gas shortfall of the managed wallet (code METEORA_GAS, v71.34) names the amount and the step; it carries no
// RPC detail, so it is the one worker error kept verbatim for the administrator. Everything else stays the generic retry note.
const gasShortfallReason = error => error?.code==='METEORA_GAS'&&typeof error.message==='string'&&error.message.length<=400&&!/https?:\/\//i.test(error.message)?error.message+' Automatic retry scheduled.':null;
const heldSolView = request => ({state:request.status,reason:request.reason||'',amountLamports:request.amountLamports||'0',...(request.paidLamports!==undefined?{paidLamports:request.paidLamports,deferredLamports:request.deferredLamports}:{} ),...(request.remainingLamports!==undefined?{remainingLamports:request.remainingLamports}:{})});
function finishHeldSolDistribution(launch, cycle, now) {
  const request=launch.heldSolDistribution;
  if(!cycle?.heldSolRequestId||request?.requestId!==cycle.heldSolRequestId||!heldSolActive(launch))return;
  request.status='completed';request.completedAt=now;request.paidLamports=(BigInt(launch.ledger.creatorPaid||'0')-BigInt(request.creatorPaidBefore||'0')).toString();request.deferredLamports=payoutSum(launch.rewards.debts||[]).toString();request.reason=launch.rewards.debts?.length?'Distribution completed; blocked recipients remain owed their saved rewards.':'Held SOL rewards distributed.';
  request.remainingLamports=launch.ledger.creatorCredit||'0';
  delete request.retryAt;
  launch.heldSolDistributionHistory=[...(launch.heldSolDistributionHistory||[]),copy(request)];
}
function abortHeldSolDistribution(launch, now) {
  const request=launch.heldSolDistribution,cycle=launch.rewards.cycle;
  if(cycle){
    if(cycle.heldSolRequestId!==request.requestId||!Number.isSafeInteger(cycle.index)||cycle.index<0||cycle.index>cycle.payouts.length)fail('The saved distribution cycle could not be safely reserved.',409);
    const debts=mergeHolderRewardPayouts(launch.rewards.debts||[],cycle.payouts.slice(cycle.index));
    if(payoutSum(debts)>BigInt(amount(launch.ledger.creatorCredit)))fail('Reserved holder obligations exceed the saved reward credit.',409);
    launch.rewards.debts=debts;delete launch.rewards.cycle;
  }
  request.status='failed';request.completedAt=now;request.reason='Administrator access changed. Unpaid holder rewards remain reserved.';delete request.retryAt;
  request.paidLamports=(BigInt(launch.ledger.creatorPaid||'0')-BigInt(request.creatorPaidBefore||'0')).toString();request.deferredLamports=payoutSum(launch.rewards.debts||[]).toString();
  request.remainingLamports=launch.ledger.creatorCredit||'0';
  launch.heldSolDistributionHistory=[...(launch.heldSolDistributionHistory||[]),copy(request)];
}
function payoutPartition(requested,bundle) {
  const ready=bundle.payout?.recipients||requested,deferred=(bundle.deferredPayouts||[]).map(({owner,amount})=>({owner,amount}));
  const expected=new Map(requested.map(row=>[row.owner,row.amount]));
  if(!Array.isArray(ready)||!Array.isArray(deferred)||ready.length+deferred.length!==expected.size)fail('The payout plan does not preserve its saved obligations.',502);
  for(const row of [...ready,...deferred]){if(expected.get(row.owner)!==row.amount)fail('The payout plan changed a saved obligation.',502);expected.delete(row.owner);}
  if(expected.size||bundle.payout?.quoteDebitRaw!==undefined&&BigInt(amount(bundle.payout.quoteDebitRaw))!==payoutSum(ready))fail('The payout plan changed its saved budget.',502);
  return {ready:copy(ready),deferred};
}
function rewardMinimum(price, decimals, usd = 100n) {
  const match=String(price).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if(!match)fail('The quote price reference is invalid.',502);
  const exponent=Number(match[3]||0)-(match[2]||'').length;
  if(Math.abs(exponent)>100)fail('The quote price reference is outside supported bounds.',502);
  let numerator=BigInt(match[1]+(match[2]||'')),denominator=1n;
  if(exponent<0)denominator=10n**BigInt(-exponent);else numerator*=10n**BigInt(exponent);
  if(numerator<=0n)fail('The quote price reference must be positive.',502);
  return (usd*10n**BigInt(decimals)*denominator+numerator-1n)/numerator;
}

/** Wallet may add only its signature; all other signatures are server-side.
 * Phantom/Solflare may also set their own bounded priority fee/compute limit
 * and append Lighthouse assertions. Substituted accounts, instruction
 * mutations, blockhash changes and lookup tables are still rejected. */
export function verifyMeteoraWalletTransaction(encoded, bundle, wallet) {
  let reason = '';
  try {
    const tx = VersionedTransaction.deserialize(encodedTransaction(encoded));
    const prepared = VersionedTransaction.deserialize(encodedTransaction(bundle.unsignedTransaction));
    if (tx.version!==0 || prepared.version!==0 || tx.message.addressTableLookups.length) throw Error();
    try { staticWalletChange(tx, bundle.unsignedTransaction); } catch (error) { reason = error.walletValidationReason || ''; throw error; }
    const signers = tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).map(k=>k.toBase58());
    if (signers[0]!==wallet || !Array.isArray(bundle.requiredSigners) || signers.length!==bundle.requiredSigners.length || signers.some((key,i)=>key!==bundle.requiredSigners[i])) throw Error();
    const key = createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(wallet).toBuffer()]),format:'der',type:'spki'});
    if (!verify(null,tx.message.serialize(),key,tx.signatures[0]) || tx.signatures.slice(1).some(sig=>sig.some(Boolean))) throw Error();
    return tx;
  } catch { throw Object.assign(Error(`The wallet changed the transaction or did not sign it${reason?` (${reason})`:''}. Nothing was submitted.`),{statusCode:400,code:'WALLET_TRANSACTION_REJECTED'}); }
}

/** Native DBC owns reserves. Only claim rights and payout inventory use managed
 * keys. Every signed wire payload is durably encrypted before RPC broadcast. */
export class MeteoraService {
  constructor({accounts,requireOwner,adapter,getQuotePrice,getTreasury,getCreationFee=async()=>({lamports:'0',recipient:await getTreasury()}),publishMetadata,quoteEligibility,listPairs=async()=>[],pairReadiness=async()=>({complete:false}),gotchiTarget=null,agentTarget=null,hookProgramId=null,hookApps=null,now=Date.now,intervalMs=15000,verifyWalletTransaction=verifyMeteoraWalletTransaction}) {
    Object.assign(this,{accounts,requireOwner,adapter,getQuotePrice,getTreasury,getCreationFee,publishMetadata,quoteEligibility,listPairs,pairReadiness,gotchiTarget,agentTarget,now,intervalMs,verifyWalletTransaction});
    // Transfer hook rules (v71.28) switch on when the host sets LAUNCHPAD_HOOK_PROGRAM_ID (account-app.mjs assigns it after construction).
    this.hookProgramId=meteoraHookProgramId(hookProgramId);
    // App-only rules (v71.36) switch on per app when the host names the app's mark (LAUNCHPAD_HOOK_FOMO_MARK, LAUNCHPAD_HOOK_PUMP_APP_MARK;
    // account-app.mjs assigns them after construction). A launch freezes the mark it was created with on its record.
    this.hookApps=meteoraHookApps(hookApps);
    this.queue=Promise.resolve();this.timer=null;this.running=null;this.closed=false;
  }
  async load() { const d=await this.accounts.hostStore.read(STORE,empty()); if(d?.schemaVersion!==1 || !Array.isArray(d.launches) || !Array.isArray(d.operations) || typeof d.enabled!=='boolean') fail('Meteora history is unavailable. Restore the original encrypted data.',503);return d; }
  async save(data) { await this.accounts.hostStore.write(STORE,data);const dir=await open(this.accounts.dir,'r');try{await dir.sync();}finally{await dir.close();} }
  async locked(fn) {
    const previous=this.queue;let release;this.queue=new Promise(done=>{release=done;});await previous;let child;
    try {
      if(process.platform!=='linux')fail('Meteora hosting requires the Linux VPS journal lock.',503);
      await mkdir(this.accounts.dir,{recursive:true,mode:0o700});const path=resolve(this.accounts.dir,'meteora.flock');const file=await open(path,'a',0o600);await file.close();
      child=spawn('flock',['--nonblock','--exclusive',path,'sh','-c','printf R; cat >/dev/null'],{stdio:['pipe','pipe','ignore']});child.stdin.on('error',()=>{});
      await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',()=>reject(Object.assign(Error('Another Launchpad process is committing a Meteora operation. Retry shortly.'),{statusCode:409})));child.stdout.once('data',done);});
      return await fn();
    } finally {if(child?.pid){const done=new Promise(resolve=>child.once('close',resolve));child.stdin.end();if(child.exitCode===null&&child.signalCode===null)await done;}release();}
  }
  async authorize(session,context,wallet=null,owner=false) {
    if(!context?.sessionToken||typeof context.authorize!=='function')fail('Sign in again to continue.',403);
    const current=await context.authorize();if(!current?.account?.id||current.account.id!==session?.account?.id)fail('The signed-in account changed.',403);
    if(owner)await this.requireOwner(current);if(wallet&&(!current.walletVerified||current.walletAddress!==wallet))fail('Sign in with the wallet approving this transaction.',403);return current;
  }
  async setup(session,input={},context) {
    object(input,[]);await this.authorize(session,context,null,true);
    const percent=0;
    const treasury=address(await this.getTreasury());
    return this.locked(async()=>{const data=await this.load();await this.authorize(session,context,null,true);data.authority ||= {...keyRecord(),createdAt:this.now()};
      // Future settings never rewrite a launch's immutable config or a receipt.
      if(!data.config||data.config.treasury!==treasury||data.config.migrationFeePercentage!==percent){data.config={...METEORA_DEFAULTS,treasury,migrationFeePercentage:percent,authority:data.authority.address,createdAt:this.now()};data.enabled=false;}
      await this.save(data);return {configured:true,publicEnabled:data.enabled,authority:data.authority.address,treasury,migrationFeePercentage:percent};});
  }
  async readiness(data,{display=false}={}) {
    if(!data.config||!data.authority)return {ready:false,blockers:['Set up the managed Meteora fee and migration wallet.']};
    if(data.config.authority!==data.authority.address)return {ready:false,blockers:['The managed Meteora authority does not match the saved configuration.']};
    if(data.config.treasury!==address(await this.getTreasury()))return {ready:false,blockers:['The saved Meteora treasury differs from the current protocol wallet. Update the owner configuration before opening new launches.']};
    const required=['prepareLaunch','prepareTrade','prepareCreatorClaim','preparePartnerClaim','prepareMigration','preparePayout','holderSnapshot','state','send','reconcile','readiness'];
    if(required.some(name=>typeof this.adapter?.[name]!=='function'))return {ready:false,blockers:['Meteora lifecycle, fee collection and reward support must be installed before activation.']};
    const check=async()=>{const result=await this.adapter.readiness({treasury:data.config.treasury,authority:data.authority.address,migrationFeePercentage:data.config.migrationFeePercentage,hookProgramId:this.hookProgramId||null});return {...result,ready:result?.ready===true,blockers:Array.isArray(result?.blockers)?result.blockers:[]};};
    // Public browsing shares a short snapshot. Authorization and treasury
    // binding above still run on every call; preparation, activation and signing
    // keep their fresh readiness checks and never consume this display cache.
    if(!display)return check();
    const key=configHash(data)+':'+data.authority.address;
    let entry=this.displayReadiness;
    if(entry?.key===key){if(entry.promise)return copy(await entry.promise);if(entry.expiresAt>this.now())return copy(entry.result);}
    entry={key};this.displayReadiness=entry;
    entry.promise=Promise.resolve().then(check).then(result=>{entry.result=copy(result);entry.expiresAt=this.now()+(result.ready?5000:1000);return result;}).catch(error=>{if(this.displayReadiness===entry)this.displayReadiness=null;throw error;}).finally(()=>{entry.promise=null;});
    return copy(await entry.promise);
  }
  async binding(data,{newLaunch=false,ownerPreview=false}={}) {
    if(!data.config||!data.authority||data.config.authority!==data.authority.address)fail('Meteora launch settings are not configured.',409);
    if(newLaunch){if(!data.enabled&&!ownerPreview)fail('New Meteora launches are not enabled.',409);const result=await this.readiness(data);if(!result.ready)fail(result.blockers?.[0]||'Meteora launch prerequisites are not ready.',409);}
    return data.config;
  }
  /** The mark an app-only rule locks trades to on this host ('fomo' | 'pumpApp'): { kind, key, index }, or null when the owner has not named it. */
  hookAppMark(app){const apps=this.hookApps||{};const value=apps[app];return value&&typeof value==='object'&&typeof value.key==='string'&&value.key?{kind:value.kind,key:value.key,index:value.index||0}:null;}
  /** { fomo, pumpApp } for the launch page and the readiness check: the mark with its sentence when that rule is offered, else null. Hooks off = every app null. */
  hookAppsView(){const on=!!this.hookProgramId;return Object.fromEntries(Object.keys(HOOK_APP_SETTINGS).map(app=>{const mark=on?this.hookAppMark(app):null;return [app,mark?{...mark,text:describeHookAppMark(mark,hookRuleByApp(app)?.appName||app)}:null];}));}
  async publicStatus(session,context) {
    const data=await this.load();let status={ready:false,blockers:[]},ownerPreview=false;
    try{status=await this.readiness(data,{display:true});}catch{status={ready:false,blockers:['Meteora launch checks are waiting for an RPC response.']};}
    if(status.ready&&!data.enabled&&session&&context)try{await this.authorize(session,context,null,true);ownerPreview=true;}catch{}
    const publicEnabled=!!(data.enabled&&status.ready),available=publicEnabled||ownerPreview;const pairSummary=await this.pairReadiness();
    const pairs=available?await this.listPairs():[];
    // Transfer hook rules: offered when the host names a hook program and the chain does not say it is undeployed (an unanswered
    // RPC read keeps the section visible; a hooked launch verifies the program again before any transaction is prepared).
    const hookProgramExecutable=this.hookProgramId?(status.hookProgram?.executable??null):null,hooksEnabled=!!this.hookProgramId&&hookProgramExecutable!==false;
    return {available,publicEnabled,ownerPreview,configured:!!data.config,pairSummary,defaults:{...METEORA_DEFAULTS,migrationFeePercentage:data.config?.migrationFeePercentage??0},pairs,blockers:status.blockers||[],hooksEnabled,hookProgramId:this.hookProgramId||null,hookProgramExecutable,hookApps:this.hookAppsView(),basketsEnabled:this.basketsAvailable(),basketLimits:{maxAssets:BASKET_LIMITS.maxAssets,maxExtras:BASKET_LIMITS.maxExtras}};
  }
  async ownerStatus(session,context) {
    await this.authorize(session,context,null,true);const data=await this.load();let ready;try{ready=await this.readiness(data);}catch{ready={ready:false,blockers:['Meteora readiness checks are waiting for an RPC response.']};}
    return {...await this.publicStatus(session,context),...ready,launchesEnabled:data.enabled,canEnable:ready.ready===true,authority:data.authority?.address||null,treasury:data.config?.treasury||null,minimumBalanceLamports:String(ready.minimumBalanceLamports||MIN_GAS),recommendedBalanceLamports:'100000000',migrations:data.launches.filter(l=>l.status==='bonded').map(l=>({mint:l.mint,retry:l.retry||null})),feeModeDescription:'Creator fees or quote-asset rewards funded by the creator fee share. No token transfer tax.'};
  }
  async setEnabled(session,input,context) {
    object(input,['enabled']);if(typeof input.enabled!=='boolean')fail('Choose whether new Meteora launches are enabled.');await this.authorize(session,context,null,true);
    return this.locked(async()=>{const data=await this.load();if(input.enabled){const result=await this.readiness(data);if(!result.ready)fail(result.blockers[0]||'Meteora prerequisites are not ready.',409);const summary=await this.pairReadiness();if(summary.complete!==true)fail('Finish checking the full Meteora quote catalogue before enabling launches.',409);const pairs=await this.listPairs();if(!pairs.some(pair=>pair.launchReady===true))fail('No quote pair has passed Meteora launch checks.',409);}await this.authorize(session,context,null,true);data.enabled=input.enabled;data.ownerChoice=input.enabled;await this.save(data);return{publicEnabled:data.enabled};});
  }
  // A white-label launchpad (LAUNCHPAD_PRODUCT=tenant, src/tenant/bootstrap.mjs) is set up by the server on its first start, exactly as the
  // owner's "Set up" button would: a managed authority wallet and the configuration bound to the launchpad's treasury.
  async systemSetup() {
    const treasury=address(await this.getTreasury());
    return this.locked(async()=>{const data=await this.load();data.authority ||= {...keyRecord(),createdAt:this.now()};
      if(!data.config||data.config.treasury!==treasury||data.config.migrationFeePercentage!==0){data.config={...METEORA_DEFAULTS,treasury,migrationFeePercentage:0,authority:data.authority.address,createdAt:this.now()};data.enabled=false;}
      await this.save(data);return {authority:data.authority.address,publicEnabled:data.enabled};});
  }
  // ... and switched on by the server once the same checks the owner's "Enable" runs pass (the authority funded, the
  // catalogue complete, a launch-ready pair), unless the owner switched public launches off themselves.
  async systemEnable() {
    return this.locked(async()=>{const data=await this.load();if(data.enabled||data.ownerChoice===false||!data.config)return {publicEnabled:data.enabled};
      const result=await this.readiness(data);if(!result.ready)return {publicEnabled:false,blockers:result.blockers};
      const summary=await this.pairReadiness();if(summary.complete!==true)return {publicEnabled:false};
      const pairs=await this.listPairs();if(!pairs.some(pair=>pair.launchReady===true))return {publicEnabled:false};
      data.enabled=true;await this.save(data);return {publicEnabled:true};});
  }
  publicLaunch(l) {
    if(!l)return null;const ledger=l.ledger||{creatorClaimed:'0',creatorPaid:'0',creatorCredit:'0',partnerPaid:'0'};
    const decimals=l.quoteDecimals??9,rewards=l.rewards||{},shares=meteoraFeeShares(l.policy||{});
    return {...METEORA_DEFAULTS,initialFdvUsd:meteoraPolicy(l.policy||{}).initialFdvUsd,tradeFeeBps:shares.totalTradeFeeBps,creatorSharePercent:shares.creatorSharePercent,partnerSharePercent:shares.partnerSharePercent,id:l.id,mint:l.mint,name:l.name,symbol:l.symbol,description:l.description,image:l.image,website:l.website,twitter:l.twitter,telegram:l.telegram,creatorWallet:l.creatorWallet,creatorId:l.creatorId,createdAt:l.createdAt,finalizedAt:l.finalizedAt||null,confirmedAt:l.finalizedAt||null,confirmationStatus:l.finalizedAt?'finalized':null,status:l.status,poolId:l.poolId||null,dbcPoolId:l.dbcPoolId||null,configAddress:l.configAddress,metadataUri:l.metadataUri,priceSnapshot:l.priceSnapshot,platform:'meteora',route:'meteora',launchMode:'meteora',quoteMint:l.quoteMint,quoteSymbol:l.quoteSymbol,quoteDecimals:decimals,feeMode:l.feeMode,creatorRecipient:l.creatorRecipient,creatorFeesPending:ledger.creatorCredit,creatorFeesPaid:ledger.creatorPaid,creatorRewards:{pendingRaw:ledger.creatorCredit,totalClaimedRaw:ledger.creatorClaimed,totalPaidRaw:ledger.creatorPaid,quoteSymbol:l.quoteSymbol,quoteDecimals:decimals,at:l.updatedAt||l.finalizedAt||null,historyComplete:!!l.finalizedAt},feeRedirect:{used:!!l.redirectedAt,canRedirect:l.feeMode==='creator'&&!l.redirectedAt,recipient:l.creatorRecipient},holderRewards:l.feeMode==='holders'?{pendingQuote:displayUnits(ledger.creatorCredit,decimals),totalDistributedQuote:displayUnits(ledger.creatorPaid,decimals),totalPayments:rewards.totalPayments||0,walletsPaid:(rewards.paidWallets||[]).length,nextCheckAt:rewards.nextCheckAt||null,minimumUsd:100,quoteSymbol:l.quoteSymbol,retry:l.retry||null,...(basketView(l)?{basket:basketRewardRows(l),rounds:basketRounds(l),stage:rewards.cycle?.stage||null}:{})}:null,basket:basketView(l),rewardsWallet:{address:l.creatorAuthority,status:l.finalizedAt?'active':'pending'},migrationSignature:l.migrationSignature||null,retry:l.retry||null,hidden:l.moderation?.hidden===true,archived:l.listArchive?.archived===true,baseDecimals:6,quoteProgram:l.quoteProgram,totalTradeFeeBps:shares.totalTradeFeeBps,creatorFeeBps:shares.creatorFeeBps,migrationFeePercentage:0,gotchi:l.gotchi?{id:l.gotchi.id,theme:l.gotchi.theme,vault:l.gotchi.vault,attachedAt:l.gotchi.attachedAt||l.createdAt}:null,agent:l.agent?{id:l.agent.id,wallet:l.agent.wallet,model:l.agent.model,capabilities:l.agent.capabilities,policyHash:l.agent.policyHash,href:'/coin?mint='+l.mint+'#agent'}:null,feePreset:l.policy?.preset||null,migratedAt:l.migratedAt||null,hook:hookView(l)};
  }
  /** Public read (GET /api/launchpad/meteora/hook-allowlist?mint=) → { wallets, source, ... }. The chain is authoritative: the
   * AllowEntry accounts under the hook program decide what a transfer may do, so `wallets` is read from chain (adapter
   * hookAllowlistOnChain, cached briefly per coin) whenever the RPC answers (`source: 'chain'`). Otherwise it falls back to the list
   * recorded from changes submitted and finalized through Launchpad (`source: 'curve'`; `recorded` always carries that list), which
   * cannot see entries added or removed through another app. */
  async hookAllowlist(mint){
    const l=(await this.load()).launches.find(l=>l.mint===address(mint)&&live(l));if(!l)fail('Coin not found.',404);const view=hookView(l);
    const recorded=view?.allowlist||[];let wallets=recorded,source=view?'curve':'none';
    if(view?.hasAllowlist&&typeof this.adapter.hookAllowlistOnChain==='function'){
      this.allowlistCache||=new Map();const cached=this.allowlistCache.get(l.mint);
      if(cached&&cached.at>this.now()-15000)({wallets,source}=cached);
      else try{const read=await this.adapter.hookAllowlistOnChain(l);if(Array.isArray(read)){wallets=read.map(address);source='chain';this.allowlistCache.set(l.mint,{wallets,source,at:this.now()});}}catch{}
    }
    return {mint:l.mint,hooked:!!view,hasAllowlist:view?.hasAllowlist===true,program:view?.program||null,configPda:l.hook?.configPda||null,active:view?.active===true,ended:view?.ended===true,wallets,count:wallets.length,source,recorded,updatedAt:view?.allowlistUpdatedAt||null,note:'The chain is authoritative: the hook program’s AllowEntry accounts decide; `recorded` lists the changes submitted through Launchpad.'};
  }
  /** Public read (GET /api/launchpad/meteora/hook-blocklist?mint=) → { wallets, count, source, ... }. The BlockList account under the
   * hook program is authoritative and sealed by the first trade; it is read from chain (adapter hookBlocklistOnChain, cached briefly per
   * coin) whenever the RPC answers (`source: 'chain'`), otherwise the list frozen on the launch record at creation is served
   * (`source: 'curve'`; `recorded` always carries it). */
  async hookBlocklist(mint){
    const l=(await this.load()).launches.find(l=>l.mint===address(mint)&&live(l));if(!l)fail('Coin not found.',404);const view=hookView(l);
    const recorded=view?.hasBlocklist&&Array.isArray(l.hook.blocklist)?l.hook.blocklist.filter(w=>typeof w==='string'):[];let wallets=recorded,source=view?'curve':'none';
    if(view?.hasBlocklist&&typeof this.adapter.hookBlocklistOnChain==='function'){
      this.blocklistCache||=new Map();const cached=this.blocklistCache.get(l.mint);
      if(cached&&cached.at>this.now()-15000)({wallets,source}=cached);
      else try{const read=await this.adapter.hookBlocklistOnChain(l);if(Array.isArray(read)){wallets=read.map(address);source='chain';this.blocklistCache.set(l.mint,{wallets,source,at:this.now()});}}catch{}
    }
    return {mint:l.mint,hooked:!!view,hasBlocklist:view?.hasBlocklist===true,program:view?.program||null,blocklistPda:l.hook?.blocklistPda||null,active:view?.active===true,ended:view?.ended===true,wallets,count:wallets.length,source,recorded,note:'The chain is authoritative: the hook program’s BlockList account decides and is sealed by the first trade; `recorded` is the list written at launch.'};
  }
  async publicList(){return (await this.load()).launches.filter(l=>live(l)&&!l.moderation?.hidden&&!l.listArchive?.archived).map(l=>this.publicLaunch(l));}
  async analyticsList(){return (await this.load()).launches.filter(live).map(l=>this.publicLaunch(l));}
  async publicDetail(mint){return this.publicLaunch((await this.load()).launches.find(l=>l.mint===mint&&live(l)));}
  async listAccount(session){return (await this.load()).launches.filter(l=>l.creatorId===session?.account?.id||session?.walletVerified&&session.walletAddress===l.creatorRecipient).map(l=>{const view=this.publicLaunch(l);view.feeRedirect.canRedirect &&= l.creatorId===session?.account?.id&&session?.walletVerified&&session.walletAddress===l.creatorWallet;return view;});}
  publicOperation(op){return {id:op.id,action:op.action,wallet:op.wallet,mint:op.mint,state:op.state,expiresAt:op.expiresAt||null,signature:op.signature||null,review:op.review,...(op.state==='awaiting_signature'?{transaction:op.bundle.unsignedTransaction}:{}),...(op.result?{result:op.result}:{})};}
  response(data,op){const l=data.launches.find(l=>l.mint===op.mint);return {operation:this.publicOperation(op),launch:this.publicLaunch(l),...(op.action==='configure'&&op.state==='finalized'&&l?.status==='configured'?{nextAction:'initialize'}:{})};}
  async operations(session,context){await this.authorize(session,context);const data=await this.load();return {operations:data.operations.filter(op=>op.ownerId===session.account.id&&(!TERMINAL.has(op.state)||op.action==='configure'&&op.state==='finalized'&&data.launches.some(l=>l.mint===op.mint&&l.status==='configured'))).map(op=>({...this.publicOperation(op),...(op.action==='configure'&&op.state==='finalized'?{nextAction:'initialize'}:{})}))};}
  async wallet(session,input,context){object(input,['mint','expectedWallet']);const wallet=address(input.expectedWallet);await this.authorize(session,context,wallet);const launch=(await this.load()).launches.find(l=>l.mint===address(input.mint)&&live(l));if(!launch)fail('Coin not found.',404);return this.adapter.wallet(launch,wallet);}
  async eligibility(mint){if(typeof this.quoteEligibility!=='function')fail('Quote eligibility validation is unavailable.',503);const result=await this.quoteEligibility(mint);if(result?.retryable===true)throw Object.assign(Error(result.supportReason||result.reason||'Pair verification is busy. Retry this saved launch shortly.'),{statusCode:503,retryable:true,retryAfter:2,code:result.code||'verification_busy'});if(!result||result.launchReady!==true||result.mint!==mint)fail(result?.supportReason||result?.reason||'This quote asset has not passed Meteora launch checks.',409);if(!Number.isInteger(result.decimals)||result.decimals<0||result.decimals>18)fail('The quote mint decimals are invalid.',409);return result;}
  /** Reward baskets need the adapter's Jupiter route builder and route check. */
  basketsAvailable(){try{return typeof this.adapter?.basketsAvailable==='function'&&this.adapter.basketsAvailable()===true&&typeof this.adapter.basketRouteCheck==='function'&&typeof this.adapter.prepareBasketConversion==='function';}catch{return false;}}
  validateBundle(bundle,wallet,launch,data){
    let tx;try{tx=VersionedTransaction.deserialize(encodedTransaction(bundle.unsignedTransaction));}catch{fail('The prepared transaction is invalid.',409);}
    const signers=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).map(k=>k.toBase58());
    const allowed=new Set([wallet,data.authority.address,...Object.values(launch.keys).map(key=>key.address)]);
    if(tx.version!==0||tx.message.addressTableLookups.length&&bundle.action!=='basket-convert'||tx.signatures.some(sig=>sig.some(Boolean))||signers[0]!==wallet||signers.some(k=>!allowed.has(k))||new Set(signers).size!==signers.length||!Array.isArray(bundle.requiredSigners)||signers.length!==bundle.requiredSigners.length||signers.some((k,i)=>k!==bundle.requiredSigners[i]))fail('The prepared transaction has unexpected signers.',409);
    if(!Number.isSafeInteger(bundle.lastValidBlockHeight)||bundle.lastValidBlockHeight<=0)fail('A bounded transaction expiry is required.',409);
    return tx;
  }
  async prepare(session,input,context){
    // A new launch takes its coin address from the operator's vanity pool while
    // one is left. The draft holds it on a lease; it is used up only when the
    // draft's first transaction is signed (submit), returns to the pool if the
    // draft is never saved, and lapses if the draft is never signed.
    const hold={vanity:null};
    try{return await this.prepareWith(session,input,context,hold);}
    catch(error){if(hold.vanity)await this.vanity?.release({venue:'meteora',ref:hold.vanity.ref,address:hold.vanity.address}).catch(()=>{});throw error;}
  }
  async reserveVanity(launchId,exclude){if(!this.vanity)return null;try{const picked=await this.vanity.reserve({venue:'meteora',ref:launchId,ttlMs:VANITY_DRAFT_LEASE_MS,exclude});return picked?{...picked,ref:launchId}:{missed:true};}catch{return null;}}
  /** Before a draft's first transaction is journaled: its vanity address is recorded as used (or a launch without one is reported). */
  async commitVanity(launch){
    const v=launch.vanity;if(!v||!this.vanity||v.committed||v.noted)return;
    if(v.missed){await this.vanity.noteFallback({venue:'meteora',ref:launch.id}).catch(()=>{});v.noted=true;return;}
    try{await this.vanity.commit({venue:'meteora',ref:launch.id,address:v.address,launch:{name:launch.name,symbol:launch.symbol,accountId:launch.creatorId}});}
    catch(error){if(error?.code==='VANITY_TAKEN')fail('This launch’s reserved address is no longer available because the draft waited too long. Start a new launch.',409);throw error;}
    v.committed=true;
  }
  async prepareWith(session,input,context,hold){
    object(input,['action','expectedWallet','mint','quoteMint','feeMode','gotchiId','agent','hook','basket','add','remove','name','symbol','description','image','website','twitter','telegram','amountRaw','slippageBps','start']);
    if(!['initialize','buy','sell','claim','hook-allow'].includes(input.action))fail('Choose a launch, buy, sell, creator fee claim or allowlist change.');
    if(input.hook!==undefined&&input.action!=='initialize')fail('Transfer hook rules are chosen when a coin is launched.');
    if(input.basket!==undefined&&input.action!=='initialize')fail('A reward basket is chosen when a coin is launched.');
    if((input.add!==undefined||input.remove!==undefined)&&input.action!=='hook-allow')fail('Allowlist changes use the hook-allow action.');
    if(input.action==='hook-allow'&&(input.amountRaw!==undefined||input.slippageBps!==undefined||!input.mint))fail('An allowlist change names the coin and the wallets to add or remove.');
    const wallet=address(input.expectedWallet),current=await this.authorize(session,context,wallet),quantity=amount(input.amountRaw),slippageBps=input.slippageBps??100;
    if(!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>10000)fail('Slippage must be between 0% and 100%.');
    if(['buy','sell'].includes(input.action)&&quantity==='0')fail('Enter an amount greater than zero.');
    // Allowlist changes (hooked coins with the Allowlist rule): at most 20 distinct wallets per transaction, creator wallet only.
    const allowAdd=walletList(input.add),allowRemove=walletList(input.remove);
    if(input.action==='hook-allow'){const all=[...allowAdd,...allowRemove];if(!all.length)fail('Add or remove at least one wallet.');if(all.length>HOOK_LIMITS.allowlistBatch)fail(`Change at most ${HOOK_LIMITS.allowlistBatch} wallets per transaction.`);if(new Set(all).size!==all.length)fail('A wallet is listed twice.');}
    const data=await this.load(),ownerPreview=input.action==='initialize'&&!data.enabled;if(ownerPreview)await this.authorize(session,context,wallet,true);await this.binding(data,{newLaunch:input.action==='initialize',ownerPreview});
    let launch,created=false,renewedAt=null;
    if(input.action==='initialize'&&!input.mint){
      const quote=await this.eligibility(address(input.quoteMint)),price=await this.getQuotePrice(quote.mint);if(!freshPrice(price,quote.mint,this.now()))fail('A fresh quote/USD price is required before creating the bonding curve.',409);
      const feeMode=input.feeMode||'creator';if(!['creator','holders','gotchi','agent'].includes(feeMode))fail('Choose creator fees, holder rewards, a Gotchi or an AI Agent.');
      // The starting market cap: $20,000 unless the host offers the $4,000 start (a white-label launchpad's choice); both graduate at $50,000.
      const start=input.start===undefined?'20k':input.start;if(!['20k','4k'].includes(start))fail('Choose the $4K or the $20K start.');
      // A white-label launchpad (LAUNCHPAD_PRODUCT=tenant) offers only the venues, launch modes, hooks and starts its owner picked.
      requireTenantLaunch({venue:'meteora',mode:feeMode,hooks:input.hook!==undefined&&input.hook!==null,start});
      padCheck({name:input.name,symbol:input.symbol});
      // Transfer hook rules (v71.28, contract v2): the creator's choice is validated by the shared catalogue and frozen on the launch
      // record as the plan (public/hook-catalog.mjs hookLaunchRequest: rules with their numbers, gate token, blocklist, tithe recipient,
      // route and the needs… flags). Hooks combine with creator fees, holder rewards and Gotchi pots. An AI Agent coin is refused: the
      // agent's treasury wallet trades through the pool and would have to be registered with, or exempted from, every rule the creator
      // chose. The first buy is refused because it is a transfer the rules would judge.
      let hook=null;
      if(input.hook!==undefined){
        if(input.hook&&typeof input.hook==='object'&&!Array.isArray(input.hook))object(input.hook,['rules','gateMint','blocklist','titheRecipient']);
        let plan=null;try{plan=hookLaunchRequest(input.hook);}catch(error){fail(error.message,error.statusCode||400);}
        if(plan){
          if(!this.hookProgramId)fail('Transfer hook rules are not enabled on this host.',503);
          // An app-only rule (v71.36) needs the app's mark named by the host owner; the mark is frozen on the record with the rule.
          let appOnly={};
          if(plan.route==='app'){const mark=this.hookAppMark(plan.app);if(!mark)fail(`${plan.appName}-only is not enabled on this host: the owner has not named the ${plan.appName} app’s mark (${HOOK_APP_SETTINGS[plan.app]||'its setting'}).`,503);if(mark.key===this.hookProgramId)fail(`${plan.appName}-only: the app’s mark cannot be the hook program itself. Check ${HOOK_APP_SETTINGS[plan.app]}.`,503);appOnly={appMark:mark};}
          if(feeMode==='agent')fail('AI Agent launches cannot carry transfer hook rules: the agent’s treasury wallet trades through the pool and would need registering with or exempting from every rule. Choose creator fees, holder rewards or a Gotchi for a hooked coin.');
          if(quantity!=='0')fail('A hooked coin’s first buy is a separate trade after launch.');
          if(typeof this.adapter.hookAddresses!=='function'||typeof this.adapter.hookGateMint!=='function')fail('Transfer hook support is not installed on this host.',503);
          // Holder-gated: the gate token's decimals (the rule's minimum is written in base units) and token program are read from chain once.
          let gate=null;
          if(plan.gateMint){try{gate=await this.adapter.hookGateMint(plan.gateMint);}catch(error){fail(`Holder-gated: ${error?.message||'the gate token mint could not be read.'}`);}if(!gate||gate.mint!==plan.gateMint||!Number.isInteger(gate.decimals)||gate.decimals<0||gate.decimals>18)fail('Holder-gated: the gate token mint was not found on chain.');address(gate.program);}
          hook={...plan,...appOnly,gateDecimals:gate?gate.decimals:0,gateTokenProgram:gate?gate.program:null};
        }
      }
      // A Gotchi launch routes its creator allocation to the Gotchi vault under the
      // frozen 1% preset. The pairing and vault are copied into the launch record
      // once; later catalogue changes never move a coin or its fees.
      let gotchi=null,policy=null;
      if(feeMode==='gotchi'){if(!validGotchiId(input.gotchiId))fail('Choose a Gotchi to pair your coin with.');if(typeof this.gotchiTarget!=='function')fail('Gotchi launches are not available on this host.',503);const target=await this.gotchiTarget(input.gotchiId);if(!target||target.id!==input.gotchiId||address(target.vault)!==target.vault||!PublicKey.isOnCurve(new PublicKey(target.vault).toBytes()))fail('This Gotchi is not accepting launches right now.',409);gotchi={version:1,id:target.id,theme:target.theme||target.id,vault:target.vault,attachedAt:this.now()};policy={...GOTCHI_METEORA_POLICY};meteoraPolicy(policy);}
      else if(input.gotchiId!==undefined)fail('A Gotchi pairing requires the Gotchi reward option.');
      // The $4,000 start is frozen into the launch's policy with any fee preset; the curve and every later check read it from there.
      if(start==='4k'){policy={...(policy||{migrationFeePercentage:0}),initialFdvUsd:4000};meteoraPolicy(policy);}

      // An AI Agent launch keeps the standard fee policy; its creator allocation
      // is assigned to the agent's managed wallet and frozen under the policy hash.
      let agent=null;
      if(feeMode==='agent'){if(quote.mint!==NATIVE_QUOTE)fail('AI Agent launches pair with SOL only.');let request;try{request=agentLaunchRequest({...(input.agent||{}),venue:'meteora'});}catch(error){fail(error.message);}if(typeof this.agentTarget!=='function')fail('AI Agent launches are not available on this host.',503);const target=await this.agentTarget(request,{accountId:current.account.id,venue:'meteora'});if(!validAgentAttachment(target)||address(target.wallet)!==target.wallet||!PublicKey.isOnCurve(new PublicKey(target.wallet).toBytes()))fail('AI Agent launches are not accepting new coins right now.',409);agent={version:1,mode:target.mode,id:target.id,wallet:target.wallet,policyHash:target.policyHash,policyVersion:target.policyVersion,capabilities:target.capabilities,model:target.model,attachedAt:this.now()};}
      else if(input.agent!==undefined)fail('Agent settings require the AI Agent launch option.');
      // Reward baskets (v71.33): a holder-rewards launch may name up to two more reward assets next to its pair asset. Each must be a
      // verified Meteora pair (the same launchReady proof as the pair asset: mint rules, badge, fresh price) and reachable from the pair
      // asset through a Jupiter route within the 2% impact guard for a $50 slice (the largest share of a $100 round). The basket is
      // frozen on the launch record with each asset's mint, symbol, decimals and token program; nothing about it changes afterwards.
      let basket=null;
      if(input.basket!==undefined){
        let plan=null;try{plan=basketLaunchRequest(input.basket,{quoteMint:quote.mint});}catch(error){fail(error.message,error.statusCode||400);}
        if(plan){
          if(feeMode!=='holders')fail('A reward basket is for holder rewards. Choose Holders, or remove the basket.');
          if(!this.basketsAvailable())fail('Reward baskets are not available on this host.',503);
          const assets=[{mint:quote.mint,symbol:quote.symbol,decimals:quote.decimals,program:quote.program||quote.tokenProgram||null}];
          const probe=rewardMinimum(price.usd,quote.decimals,50n).toString();
          for(const mint of plan.extras){
            const extra=await this.eligibility(mint),extraPrice=await this.getQuotePrice(mint);
            if(!freshPrice(extraPrice,mint,this.now()))fail(`A fresh USD price is required for ${extra.symbol||'this basket asset'} before it can join a reward basket.`,409);
            try{await this.adapter.basketRouteCheck({inputMint:quote.mint,outputMint:mint,amountRaw:probe});}catch(error){fail(`${extra.symbol||mint} cannot join the basket: ${error?.message||'no conversion route is available.'}`,409);}
            assets.push({mint,symbol:extra.symbol,decimals:extra.decimals,program:extra.program||extra.tokenProgram||null,...(extra.tokenBadge?{tokenBadge:extra.tokenBadge}:{})});
          }
          basket={version:plan.version,assets,shares:'equal',createdAt:this.now()};
        }
      }
      const launchId=randomUUID(),keys={mint:keyRecord(),config:keyRecord(),creator:keyRecord(),positionOne:keyRecord(),positionTwo:keyRecord()},name=coinText(input.name,{field:'coin name',max:32,bytes:true,required:true}),symbol=coinText(input.symbol,{field:'ticker',max:10,bytes:true,required:true}),description=coinText(input.description,{field:'description',max:1000,bytes:true}),image=label(input.image,500,'image',true),website=coinLink(input.website,'website'),twitter=coinLink(input.twitter,'twitter'),telegram=coinLink(input.telegram,'telegram');
      // Text is trimmed onto one line within the onchain metadata's byte limits; "@handle" links become profile links (pump-classic/coin-text.mjs).
      if(data.operations.some(op=>op.ownerId===current.account.id&&op.wallet===wallet&&!TERMINAL.has(op.state)&&!(op.state==='awaiting_signature'&&op.expiresAt<=this.now())))fail('Check your saved transaction before preparing another.',409);
      // At most two unsigned drafts per account hold addresses. An address that another draft still names is never given to this
      // one, except the address of an abandoned draft that never signed anything: that draft is retired when the address moves.
      const unsigned=data.launches.filter(l=>l.creatorId===current.account.id&&l.vanity?.address&&!l.vanity.committed&&this.now()-(l.vanity.heldAt??l.createdAt)<VANITY_DRAFT_LEASE_MS).length;
      const named=new Set();for(const l of data.launches)if(!abandonedVanityDraft(l,data.operations))named.add(l.mint);
      const picked=unsigned>=2?null:await this.reserveVanity(launchId,address=>named.has(address));
      hold.vanity=picked?.address?picked:null;if(hold.vanity)keys.mint={address:hold.vanity.address,secretBase64:Buffer.from(bs58.decode(hold.vanity.secret)).toString('base64')};
      if(hook){
        // Derived once from the coin's final address and frozen: the hook program, its PDAs (config, extra-account metas and, for a
        // blocklist coin, the BlockList), the four exempt keys in the program's order (creator wallet, Launchpad's partner authority, the
        // leftover receiver — the partner authority on every Launchpad launch — and the DAMM v2 pool authority, the graduation transfer's
        // destination owner, so no wallet cap can ever block graduation) and the venue (the pool's base vault; the hook never tests a
        // venue's own owner). Nothing else is ever exempt; prepareLaunch re-derives and compares. swapBaseAmount is recorded when the
        // hook-setup receipt finalizes (the adapter reads it from the curve configuration created in stage 1).
        const addresses=await this.adapter.hookAddresses({mint:keys.mint.address,quoteMint:quote.mint,configAddress:keys.config.address,program:this.hookProgramId});
        for(const key of ['configPda','extraMetasPda','dammPoolAuthority','baseVault',...(hook.needsBlocklist?['blocklistPda']:[])])address(addresses?.[key]);
        hook={...hook,version:2,program:this.hookProgramId,configPda:addresses.configPda,extraMetasPda:addresses.extraMetasPda,blocklistPda:hook.needsBlocklist?addresses.blocklistPda:null,exempt:[wallet,data.authority.address,data.authority.address,addresses.dammPoolAuthority],venue:addresses.baseVault,tokenType:'token2022',createdWithHook:true,allowlist:[],createdAt:this.now()};
      }
      const metadataUri=await this.publishMetadata({accountId:current.account.id,mint:keys.mint.address,name,symbol,description,image,website,twitter,telegram,...(hold.vanity?{replace:true}:{})});
      const creationFee=await this.getCreationFee();amount(creationFee?.lamports);address(creationFee?.recipient);if(creationFee.recipient!==data.config.treasury)fail('The creation fee recipient differs from the verified protocol treasury.',409);if(BigInt(creationFee.lamports)>100000000n)fail('The creation fee exceeds the launch limit.',409);
      launch={id:launchId,...(hold.vanity?{vanity:{address:hold.vanity.address,committed:false,heldAt:this.now()}}:picked?.missed?{vanity:{missed:true}}:{}),mint:keys.mint.address,configAddress:keys.config.address,creatorAuthority:keys.creator.address,partnerAuthority:data.authority.address,migrationPositionMints:[keys.positionOne.address,keys.positionTwo.address],keys,name,symbol,description,image,website,twitter,telegram,metadataUri,creatorWallet:wallet,creatorRecipient:gotchi?gotchi.vault:agent?agent.wallet:wallet,creatorId:current.account.id,...(gotchi?{gotchi,policy}:policy?{policy}:{}),...(agent?{agent}:{}),...(hook?{hook}:{}),...(basket?{basket}:{}),quoteMint:quote.mint,quoteSymbol:quote.symbol,quoteDecimals:quote.decimals,quoteProgram:quote.program||quote.tokenProgram,tokenBadge:quote.tokenBadge,feeMode,status:'draft',createdAt:this.now(),priceSnapshot:{usd:String(price.usd),at:price.at,source:price.source||'Live quote/USD reference'},creationFee:copy(creationFee),firstBuyRaw:quantity,slippageBps,treasury:data.config.treasury,migrationFeePercentage:data.config.migrationFeePercentage,ledger:{creatorCredit:'0',creatorClaimed:'0',creatorPaid:'0',partnerPaid:'0',partnerCredit:'0',partnerClaimed:'0',...(basket?{basket:Object.fromEntries(basket.assets.slice(1).map(a=>[a.mint,{credit:'0',paid:'0',converted:'0',payments:0}]))}:{})},rewards:{nextCheckAt:this.now()+REWARD_INTERVAL,totalPayments:0,paidWallets:[],...(basket?{basketDebts:{},rounds:[]}:{})}};created=true;
    }else{
      const mint=address(input.mint);launch=data.launches.find(l=>l.mint===mint);if(!launch)fail('Meteora launch not found.',404);
      if(input.action==='initialize')requireTenantLaunch({venue:'meteora',mode:launch.feeMode,hooks:!!launch.hook,start:launch.policy?.initialFdvUsd===4000?'4k':'20k'});
      if(input.action==='initialize'){if(launch.creatorId!==current.account.id||launch.creatorWallet!==wallet||!['draft','configured','error'].includes(launch.status)||launch.finalizedAt)fail('This launch cannot be resumed by this wallet.',403);if(launch.treasury!==data.config.treasury||launch.creationFee?.recipient!==data.config.treasury)fail('This saved launch has a different treasury. It cannot be resumed under the current protocol fee settings.',409);if(input.hook!==undefined)fail('Transfer hook rules are chosen when a launch is created and cannot change afterwards.');if(input.basket!==undefined){let plan=null;try{plan=basketLaunchRequest(input.basket,{quoteMint:launch.quoteMint});}catch(error){fail(error.message,error.statusCode||400);}const saved=(launch.basket?.assets||[]).slice(1).map(a=>a.mint);if(JSON.stringify(plan?.extras||[])!==JSON.stringify(saved))fail('This saved launch was created with a different reward basket, which cannot change. Resume it with the same basket, or start a new launch.',409);}if(launch.hook&&(!this.hookProgramId||launch.hook.program!==this.hookProgramId))fail('This hooked launch was created for a different transfer hook program. It cannot be resumed on this host.',409);if(launch.hook&&launch.hook.version!==2)fail('This hooked draft was created by an earlier version of the transfer hook rules. Start a new launch.',409);if(launch.hook?.route==='app'&&!(launch.hook.appMark&&typeof launch.hook.appMark==='object'&&launch.hook.appMark.key))fail('This app-only draft has no app mark recorded. Start a new launch.',409);await this.eligibility(launch.quoteMint);}
      else if(!live(launch))fail('This coin is not available for trading or fee claims.',409);
      if(input.action==='claim'&&(launch.feeMode!=='creator'||wallet!==launch.creatorRecipient))fail('Only the assigned creator fee recipient can claim these fees.',403);
      if(input.action==='hook-allow'){
        if(launch.creatorId!==current.account.id||launch.creatorWallet!==wallet)fail('Only this coin’s creator can change its allowlist.',403);
        if(!launch.hook)fail('This coin has no transfer hook rules.',409);if(!launch.hook.rules.some(rule=>rule.id==='allowlist'))fail('This coin has no allowlist rule.',409);
        if(launch.status==='migrated')fail('This coin has graduated; its transfer hook rules have ended.',409);
        if((launch.hook.allowlist||[]).length+allowAdd.length>HOOK_LIMITS.allowlistTotal)fail(`The allowlist holds at most ${HOOK_LIMITS.allowlistTotal} wallets.`,409);
        if(typeof this.adapter.prepareHookAllowlist!=='function')fail('Transfer hook support is not installed on this host.',503);
      }
      if(input.action==='initialize'&&launch.vanity?.address&&!launch.vanity.committed&&this.vanity){
        // A draft that has not signed anything yet holds its address on a lease: renew it, and restore the address's metadata.
        if(!(await this.vanity.claim({venue:'meteora',ref:launch.id,address:launch.vanity.address,ttlMs:VANITY_DRAFT_LEASE_MS})))fail('This launch’s reserved address is no longer available because the draft waited too long. Start a new launch.',409);
        renewedAt=this.now();
        await this.publishMetadata({accountId:launch.creatorId,mint:launch.mint,name:launch.name,symbol:launch.symbol,description:launch.description,image:launch.image,website:launch.website,twitter:launch.twitter,telegram:launch.telegram,replace:true});
      }
    }
    const pending=data.operations.find(op=>op.ownerId===current.account.id&&op.wallet===wallet&&!TERMINAL.has(op.state)&&!(op.state==='awaiting_signature'&&op.expiresAt<=this.now()));if(pending)fail('Check your saved transaction before preparing another.',409);
    let bundle,manualPayout=null,directCreatorPayment=false;
    if(input.action==='initialize')bundle=await this.adapter.prepareLaunch({wallet,launch,configAddress:launch.configAddress,mint:launch.mint,creator:launch.creatorAuthority,partner:launch.partnerAuthority,quote:{mint:launch.quoteMint,decimals:launch.quoteDecimals,program:launch.quoteProgram,symbol:launch.quoteSymbol,tokenBadge:launch.tokenBadge},quoteUsd:launch.priceSnapshot.usd,firstBuyRaw:launch.firstBuyRaw,slippageBps:launch.slippageBps,creationFee:launch.creationFee});
    else if(input.action==='claim'){if(BigInt(launch.ledger.creatorCredit)>0n){manualPayout=[{owner:launch.creatorRecipient,amount:launch.ledger.creatorCredit}];bundle=await this.adapter.preparePayout({wallet,launch,source:launch.creatorAuthority,payouts:manualPayout});const parts=payoutPartition(manualPayout,bundle);if(parts.deferred.length||!parts.ready.length)fail('The fee recipient cannot receive this payout yet.',409);}else{directCreatorPayment=true;bundle=await this.adapter.prepareCreatorClaim({wallet,launch,receiver:launch.creatorRecipient});}}
    else if(input.action==='hook-allow'){bundle=await this.adapter.prepareHookAllowlist({wallet,launch,add:allowAdd,remove:allowRemove});if(bundle?.action!=='hook-allow')fail('Unexpected allowlist transaction.',409);}
    else{
      // An app-only coin (v71.35) trades only through its app while it is on the curve (v71.36: the transaction must carry the app's mark): Launchpad never builds a trade for it before graduation.
      if(launch.hook?.route==='app'&&launch.status!=='migrated')fail(hookAppTradeNote(launch.hook.appName),409);
      bundle=await this.adapter.prepareTrade({wallet,launch,side:input.action,amountRaw:quantity,slippageBps});
    }
    const action=input.action==='initialize'?bundle.action:input.action==='claim'?(manualPayout?'payout':'creator-claim'):input.action;
    if(input.action==='initialize'&&!['configure','initialize'].includes(action))fail('Unexpected Meteora launch stage.',409);
    if(action==='initialize'&&!launch.configSignature)fail('The bonding curve configuration must finalize first.',409);
    const tx=this.validateBundle(bundle,wallet,launch,data);
    const op={id:randomUUID(),ownerId:current.account.id,sessionHash:hash(context.sessionToken),wallet,action,mint:launch.mint,state:'awaiting_signature',createdAt:this.now(),expiresAt:this.now()+120000,configFingerprint:configHash(data),ownerPreview,bundle:copy(bundle),messageHash:hash(tx.message.serialize()),...(manualPayout?{payouts:manualPayout}:{}),...(directCreatorPayment?{directCreatorPayment:true}:{}),...(input.action==='hook-allow'?{hookAllowlist:{add:allowAdd,remove:allowRemove}}:{}),review:{...copy(bundle.review||{}),...METEORA_DEFAULTS,...(()=>{const shares=meteoraFeeShares(launch.policy||{});return {tradeFeeBps:shares.totalTradeFeeBps,creatorSharePercent:shares.creatorSharePercent,partnerSharePercent:shares.partnerSharePercent,...(launch.gotchi?{gotchi:{id:launch.gotchi.id,theme:launch.gotchi.theme,vault:launch.gotchi.vault},feePreset:launch.policy?.preset||null}:{}),...(launch.agent?{agent:{id:launch.agent.id,wallet:launch.agent.wallet,model:launch.agent.model,capabilities:launch.agent.capabilities,policyHash:launch.agent.policyHash}}:{}),...(launch.hook?(()=>{const view=hookView(launch)||{rules:[],route:'any',blocklistCount:0};return {hook:{rules:view.rules,route:view.route,...(view.route==='app'?{app:view.app,appName:view.appName,appMark:view.appMark}:{}),gateMint:launch.hook.gateMint||null,titheRecipient:launch.hook.titheRecipient||null,blocklistCount:view.blocklistCount,program:launch.hook.program}};})():{}),...(basketView(launch)?{basket:basketView(launch)}:{})};})(),migrationFeePercentage:launch.migrationFeePercentage,quoteMint:launch.quoteMint,quoteSymbol:launch.quoteSymbol,quoteDecimals:launch.quoteDecimals,firstBuyRaw:launch.firstBuyRaw,configurationCreated:!!launch.configSignature,feeMode:launch.feeMode,quoteUsd:launch.priceSnapshot.usd,treasury:launch.treasury}};
    await this.authorize(session,context,wallet,ownerPreview);
    return this.locked(async()=>{const fresh=await this.load();if(configHash(fresh)!==op.configFingerprint)fail('Launch settings changed. Prepare the launch again.',409);for(const prior of fresh.operations.filter(o=>o.ownerId===current.account.id&&o.wallet===wallet&&!TERMINAL.has(o.state))){if(prior.state==='awaiting_signature'&&prior.expiresAt<=this.now())prior.state='cancelled';else fail('Check your saved transaction before preparing another.',409);}if(created){retireAbandonedDraft(fresh,launch.mint);if(fresh.launches.some(l=>l.mint===launch.mint))fail('This launch address is already used by another draft. Prepare the launch again.',409);fresh.launches.push(launch);}else{const record=fresh.launches.find(l=>l.id===launch.id);if(renewedAt&&record?.vanity)record.vanity.heldAt=renewedAt;}if(!created&&fresh.operations.some(o=>o.mint===launch.mint&&!TERMINAL.has(o.state)&&(o.state!=='awaiting_signature'||input.action==='claim'&&['creator-claim','payout'].includes(o.action))))fail('This coin has an unsettled transaction. Check its receipt first.',409);fresh.operations.push(op);await this.save(fresh);return this.response(fresh,op);});
  }
  async cancel(session,input,context){object(input,['operationId']);await this.authorize(session,context);return this.locked(async()=>{const data=await this.load(),op=data.operations.find(o=>o.id===input.operationId&&o.ownerId===session.account.id);if(!op)fail('Saved transaction not found.',404);if(op.state!=='awaiting_signature')fail('Signed transactions must be reconciled, not cancelled.',409);op.state='cancelled';await this.save(data);return this.response(data,op);});}
  sign(tx,data,launch){const signers=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).map(k=>k.toBase58()),records=[data.authority,...Object.values(launch.keys)];for(let i=0;i<signers.length;i++){if(tx.signatures[i].some(Boolean))continue;const record=records.find(key=>key.address===signers[i]);if(!record)fail('The managed transaction signer is unavailable.',503);const key=keyFrom(record);try{tx.sign([key]);}finally{key.secretKey.fill(0);}}const bytes=Buffer.from(tx.serialize());verifySignedTransaction(bytes,signers[0],signers.slice(1));return {signedTransaction:bytes.toString('base64'),signature:bs58.encode(tx.signatures[0])};}
  async submit(session,input,context){
    object(input,['operationId','signedTransaction']);encodedTransaction(input.signedTransaction);await this.authorize(session,context);const snapshot=await this.load(),previous=snapshot.operations.find(o=>o.id===input.operationId);
    if(!previous||previous.ownerId!==session.account.id||previous.sessionHash!==hash(context.sessionToken))fail('This transaction belongs to another session.',403);
    await this.authorize(session,context,previous.wallet,previous.ownerPreview);
    if(previous.walletSignedTransaction&&previous.walletSignedTransaction!==input.signedTransaction)fail('Only the original signed transaction can be checked again.',409);
    if(TERMINAL.has(previous.state))return this.response(snapshot,previous);if(previous.state!=='awaiting_signature')return this.reconcile(session,{operationId:previous.id},context);
    if(previous.expiresAt<=this.now()||configHash(snapshot)!==previous.configFingerprint)fail('The transaction expired or its settings changed. Prepare again.',409);
    const tx=this.verifyWalletTransaction(input.signedTransaction,previous.bundle,previous.wallet);
    await this.binding(snapshot,{newLaunch:['configure','initialize'].includes(previous.action),ownerPreview:previous.ownerPreview});
    await this.verifyWalletChange(tx,previous);
    const saved=await this.locked(async()=>{const data=await this.load(),op=data.operations.find(o=>o.id===previous.id),launch=data.launches.find(l=>l.mint===op.mint);if(op.state!=='awaiting_signature')return null;if(configHash(data)!==op.configFingerprint||op.expiresAt<=this.now())fail('The transaction expired or changed.',409);await this.authorize(session,context,op.wallet,op.ownerPreview);if(['configure','initialize'].includes(op.action)&&!data.enabled&&!op.ownerPreview)fail('New Meteora launches were disabled.',409);if(['creator-claim','payout'].includes(op.action)&&op.wallet!==launch.creatorRecipient)fail('The fee recipient changed. Prepare a new claim.',409);if(['configure','initialize'].includes(op.action))await this.commitVanity(launch);Object.assign(op,this.sign(tx,data,launch),{walletSignedTransaction:input.signedTransaction,state:'journaled',sentAt:this.now()});await this.save(data);return op;});
    if(!saved)return this.reconcile(session,{operationId:previous.id},context);await this.authorize(session,context,previous.wallet,previous.ownerPreview);const result=await this.broadcast(saved);this.kick();return result;
  }
  /** A wallet-changed packet (priority fee, Lighthouse assertions) gets the same
   * immutable-guard proof and complete sigVerify simulation as other launch
   * paths before any managed key signs the journaled copy. */
  async verifyWalletChange(tx,previous){
    let change;try{change=staticWalletChange(tx,previous.bundle.unsignedTransaction);}catch{fail('The wallet changed the transaction or did not sign it. Nothing was submitted.');}
    if(!change.changed)return change;
    const guardCheck=this.adapter.verifyWalletGuardProgram?.bind(this.adapter)||(this.adapter.connection?()=>verifyGuardProgramOnChain(this.adapter.connection):null);
    const simulate=this.adapter.simulateWalletTransaction?.bind(this.adapter)||(this.adapter.connection?candidate=>simulateWalletChangedTransaction(this.adapter.connection,candidate):null);
    if(!simulate||change.guardCount&&!guardCheck)fail('Wallet safety verification is temporarily unavailable. Keep this launch open and retry.',503);
    if(change.guardCount)await guardCheck();
    const data=await this.load(),launch=data.launches.find(l=>l.mint===previous.mint),candidate=VersionedTransaction.deserialize(tx.serialize());
    if(!launch)fail('Saved launch not found.',404);
    this.sign(candidate,data,launch);
    await simulate(candidate);
    return change;
  }
  async broadcast(op){let sent=false;try{sent=await this.adapter.send(op.signedTransaction)===op.signature;}catch{}return this.locked(async()=>{const data=await this.load(),saved=data.operations.find(o=>o.id===op.id);if(saved&&!TERMINAL.has(saved.state)){saved.state=sent?'submitted':'pending';saved.lastBroadcastAt=this.now();}await this.save(data);return saved?this.response(data,saved):null;});}
  applyReceipt(data,op,result){
    if(!['pending','finalized','failed','expired'].includes(result?.state))fail('A finalized Meteora receipt is required.',502);
    if(TERMINAL.has(op.state))return;const launch=data.launches.find(l=>l.mint===op.mint);if(!launch)fail('Receipt launch missing.',503);
    if(result.state==='finalized'){
      if(!Number.isSafeInteger(result.slot)||result.slot<=0)fail('Receipt does not contain a finalized slot.',502);
      if(op.protocolRequestId&&(!['partner-claim','partner-payout'].includes(op.action)||launch.protocolCollection?.requestId!==op.protocolRequestId))fail('Protocol receipt differs from its saved collection request.',502);
      // A hooked launch has a third stage between the curve configuration and the pool: the hook setup (its accounts), prepared by the
      // adapter as `configure`-kind bundles flagged `hookSetup` so the launch flow continues unchanged — the first step writes the
      // config and the metas list (its signature and the curve's swapBaseAmount are kept on the hook record), every further step a chunk
      // of blocklist wallets (their signatures and the chain's count are kept too). The curve configuration's own signature is never
      // overwritten.
      if(op.action==='configure'){
        if(op.bundle?.hookSetup){
          if(!launch.hook)fail('The transfer hook setup receipt has no hooked launch.',502);const step=op.bundle.hookSetupStep||{kind:'setup'},proof=result.hookSetup||{};
          if(step.kind==='blocklist'){launch.hook.blocklistSignatures=[...(launch.hook.blocklistSignatures||[]),{signature:op.signature,slot:result.slot,step:step.step,wallets:Array.isArray(step.wallets)?step.wallets.length:0}];}
          else{launch.hook.setupSignature=op.signature;launch.hook.setupSlot=result.slot;if(proof.swapBaseAmount!==undefined)launch.hook.swapBaseAmount=amount(String(proof.swapBaseAmount));}
          if(Number.isInteger(proof.blocklistCount))launch.hook.blocklistCount=proof.blocklistCount;
          launch.hook.setupComplete=proof.complete===true;
        }
        else launch.configSignature=op.signature;
        launch.status='configured';
      }
      else if(op.action==='initialize'){if(!LIVE.has(result.phase)||!result.poolId&&!result.dbcPoolId)fail('Finalized DBC pool could not be verified.',502);launch.status=result.phase;launch.dbcPoolId=result.dbcPoolId||result.poolId;launch.poolId=result.poolId;launch.finalizedAt||=this.now();}
      else if(op.action==='migrate'){if(result.phase!=='migrated'||!result.poolId||result.lpLocked!==true)fail('The finalized locked migration position could not be verified.',502);launch.status='migrated';launch.migratedAt||=this.now();launch.poolId=result.poolId;launch.migrationSignature=op.signature;launch.position=result.position?copy(result.position):launch.position;}
      else if(op.action==='hook-allow'){
        // The recorded allowlist follows the exact change this signed transaction carried; the chain remains authoritative.
        const change=op.hookAllowlist;if(!launch.hook||!change||!Array.isArray(change.add)||!Array.isArray(change.remove))fail('The allowlist receipt is missing its saved change.',502);
        const set=new Set(launch.hook.allowlist||[]);for(const w of change.add)set.add(w);for(const w of change.remove)set.delete(w);
        launch.hook.allowlist=[...set];launch.hook.allowlistUpdatedAt=this.now();launch.hook.allowlistChanges=[...(launch.hook.allowlistChanges||[]).slice(-49),{add:[...change.add],remove:[...change.remove],signature:op.signature,slot:result.slot,at:this.now()}];this.allowlistCache?.delete(launch.mint);
      }
      else if(op.action==='basket-convert'){
        // Reward baskets: the finalized conversion moves exactly the leg's pair-asset input out of the creator credit and the
        // received basket asset into that asset's ledger; the leg is done and, once every leg is, the round allocates.
        const cycle=launch.rewards.cycle,leg=cycle?.basket&&cycle.id===op.cycleId?cycle.legs?.[op.legIndex]:null,conversion=result.conversion;
        if(!leg||leg.state!=='converting'||!conversion||conversion.outputMint!==leg.mint||conversion.inputMint!==launch.quoteMint||amount(conversion.inputRaw)!==leg.inputRaw)fail('Basket conversion receipt differs from its saved leg.',502);
        const spent=BigInt(amount(conversion.inputRaw)),received=BigInt(amount(conversion.outputRaw));if(BigInt(launch.ledger.creatorCredit)<spent)fail('Basket conversion exceeds verified fee credit.',502);
        launch.ledger.creatorCredit=(BigInt(launch.ledger.creatorCredit)-spent).toString();launch.ledger.basket||={};
        const row=launch.ledger.basket[leg.mint]||={credit:'0',paid:'0',converted:'0',payments:0};row.credit=(BigInt(row.credit||'0')+received).toString();row.converted=(BigInt(row.converted||'0')+received).toString();
        leg.state='done';leg.outputRaw=String(received);leg.signature=op.signature;
        if(!cycle.legs.some(l=>['queued','converting'].includes(l.state)))cycle.stage='allocate';
      }
      else if(['creator-claim','partner-claim','migration-fee'].includes(op.action)){
        const field=op.action==='creator-claim'?'creatorQuoteRaw':op.action==='partner-claim'?'partnerQuoteRaw':'migrationQuoteRaw',raw=amount(result.fees?.[field]);
        if(result.fees?.[field]===undefined)fail('The finalized fee credit could not be verified.',502);
        if(op.action==='creator-claim'){launch.lastCreatorClaimAt=this.now();if(op.directCreatorPayment)launch.ledger.creatorPaid=(BigInt(launch.ledger.creatorPaid)+BigInt(raw)).toString();else launch.ledger.creatorCredit=(BigInt(launch.ledger.creatorCredit)+BigInt(raw)).toString();launch.ledger.creatorClaimed=(BigInt(launch.ledger.creatorClaimed)+BigInt(raw)).toString();}
        else if(op.action==='partner-claim'){launch.lastPartnerClaimAt=this.now();launch.ledger.partnerCredit=(BigInt(launch.ledger.partnerCredit||'0')+BigInt(raw)).toString();launch.ledger.partnerClaimed=(BigInt(launch.ledger.partnerClaimed||'0')+BigInt(raw)).toString();}
        else launch.ledger.migrationPaid=(BigInt(launch.ledger.migrationPaid||'0')+BigInt(raw)).toString();
      }else if(['payout','partner-payout'].includes(op.action)){
        const expected=op.payouts.reduce((sum,row)=>sum+BigInt(row.amount),0n),debit=amount(result.payout?.quoteDebitRaw);
        // A basket asset's payout (op.assetMint, an extra asset) settles against that asset's own ledger; everything else against the pair asset's.
        const extra=op.action==='payout'&&op.assetMint&&op.assetMint!==launch.quoteMint?op.assetMint:null;
        if(extra&&(result.payout?.mint!==extra||!launch.basket?.assets?.some(a=>a.mint===extra)))fail('Basket payout receipt names a different asset.',502);
        const row=extra?(launch.ledger.basket?.[extra]||null):null;
        const creditKey=op.action==='partner-payout'?'partnerCredit':'creatorCredit',paidKey=op.action==='partner-payout'?'partnerPaid':'creatorPaid',credited=extra?BigInt(row?.credit||'0'):BigInt(launch.ledger[creditKey]||'0');
        if(result.payout?.quoteDebitRaw===undefined||BigInt(debit)!==expected||hash(JSON.stringify(result.payout?.recipients))!==hash(JSON.stringify(op.payouts))||credited<expected||extra&&!row)fail('Reward payout receipt differs from its saved allocation.',502);
        if(extra){row.credit=(BigInt(row.credit||'0')-expected).toString();row.paid=(BigInt(row.paid||'0')+expected).toString();row.payments=(row.payments||0)+op.payouts.length;}
        else{launch.ledger[creditKey]=(BigInt(launch.ledger[creditKey]||'0')-expected).toString();launch.ledger[paidKey]=(BigInt(launch.ledger[paidKey]||'0')+expected).toString();}
        if(op.action==='payout'&&launch.feeMode==='holders'){
          const cycle=launch.rewards.cycle;
          launch.rewards.totalPayments+=op.payouts.length;launch.rewards.paidWallets=[...new Set([...launch.rewards.paidWallets,...op.payouts.map(p=>p.owner)])];
          if(cycle?.basket)this.advanceBasketCycle(launch,{cycleId:op.cycleId,cycleIndex:op.cycleIndex,assetMint:op.assetMint,count:op.cycleCount??op.payouts.length,deferred:op.deferredPayouts||[]},this.now());
          else{if(!cycle||cycle.id!==op.cycleId||cycle.index!==op.cycleIndex)fail('Holder payout cycle differs from its receipt.',502);cycle.index+=op.cycleCount??op.payouts.length;launch.rewards.debts=mergeHolderRewardPayouts(launch.rewards.debts||[],op.deferredPayouts||[]);if(cycle.index>=cycle.payouts.length){launch.rewards.lastDistributionAt=this.now();launch.rewards.nextCheckAt=this.now()+REWARD_INTERVAL;finishHeldSolDistribution(launch,cycle,this.now());delete launch.rewards.cycle;}}
        }
      }
      if(result.trade){op.trade=copy(result.trade);op.finalizedAt=this.now();}
      launch.updatedAt=this.now();if(!['partner-claim','partner-payout'].includes(op.action))launch.retry=null;
      if(op.protocolRequestId){const request=launch.protocolCollection;request.reason='';delete request.retryAt;if(op.action==='partner-claim')request.stage='payout';else{request.status='completed';request.completedAt=this.now();}}
    }else if(['failed','expired'].includes(result.state)&&['configure','initialize'].includes(op.action)&&!launch.finalizedAt){launch.status=launch.configSignature?'configured':'error';}
    else if(['failed','expired'].includes(result.state)&&op.action==='basket-convert'){const cycle=launch.rewards.cycle,leg=cycle?.basket&&cycle.id===op.cycleId?cycle.legs?.[op.legIndex]:null;if(leg&&leg.state==='converting')this.failBasketLeg(leg,'The conversion transaction did not complete.');}
    if(['failed','expired'].includes(result.state)&&op.protocolRequestId&&launch.protocolCollection?.requestId===op.protocolRequestId){const request=launch.protocolCollection;request.attempt=(request.attempt||0)+1;request.retryAt=this.now()+Math.min(300000,15000*2**Math.min(request.attempt,5));request.reason='The protocol transaction did not complete. Its saved collection will retry.';}
    op.state=result.state;op.result=copy(result);if(result.state==='finalized')op.finalizedAt=this.now();
  }
  async receipt(op){const snapshot=await this.load(),launch=snapshot.launches.find(l=>l.mint===op.mint),result=await this.adapter.reconcile(op,launch);return this.locked(async()=>{const data=await this.load(),saved=data.operations.find(o=>o.id===op.id);if(!saved||TERMINAL.has(saved.state))return saved?this.response(data,saved):null;if(saved.signature!==op.signature)fail('Saved receipt changed.',409);this.applyReceipt(data,saved,result);await this.save(data);return this.response(data,saved);});}
  async reconcile(session,input,context){object(input,['operationId']);await this.authorize(session,context);const data=await this.load(),op=data.operations.find(o=>o.id===input.operationId&&o.ownerId===session.account.id);if(!op)fail('Saved transaction not found.',404);if(op.state==='awaiting_signature'||TERMINAL.has(op.state))return this.response(data,op);const result=await this.receipt(op);await this.authorize(session,context);return result;}
  async rerouteCreator(session,input,context){object(input,['mint','recipient']);const mint=address(input.mint),recipient=address(input.recipient);if(!PublicKey.isOnCurve(new PublicKey(recipient).toBytes()))fail('The fee recipient must be a wallet address.');const current=await this.authorize(session,context);return this.locked(async()=>{const data=await this.load(),l=data.launches.find(l=>l.mint===mint);if(!l||l.creatorId!==current.account.id||l.feeMode!=='creator'||!live(l))fail('Only this coin’s original creator may redirect fees.',403);await this.authorize(session,context,l.creatorWallet);if(l.redirectedAt)fail('Creator fees have already been redirected once.',409);if(recipient===l.creatorRecipient)fail('Choose a different receiving wallet.');if([data.authority.address,...Object.values(l.keys).map(key=>key.address)].includes(recipient))fail('Choose your receiving wallet, not a managed fee or migration wallet.');if(data.operations.some(o=>o.mint===mint&&!TERMINAL.has(o.state)&&['creator-claim','payout'].includes(o.action)))fail('Wait for the current fee transaction to settle before redirecting.',409);l.creatorRecipient=recipient;l.redirectedAt=this.now();l.redirectedBy=current.account.id;await this.save(data);return {launch:this.publicLaunch(l)};});}
  async treasurySources(){const {meteoraTreasurySources}=await import('./meteora-revenue-records.mjs');return meteoraTreasurySources(await this.load());}
  /** Gotchi contributions: finalized creator payouts whose recipient is the
   * launch's saved vault. Native SOL leaves the gas payer after the unwrap; a
   * quote token leaves the creator authority's token account. */
  async gotchiSources(){
    const data=await this.load(),rows=[];
    for(const l of data.launches){
      if(!l.gotchi?.vault||l.feeMode!=='gotchi')continue;
      for(const op of data.operations){
        if(op.mint!==l.mint||op.action!=='payout'||op.state!=='finalized'||!Array.isArray(op.payouts))continue;
        for(const row of op.payouts){
          if(row.owner!==l.gotchi.vault)continue;
          try{amount(row.amount);}catch{continue;}
          rows.push({kind:'meteora-gotchi-payout',gotchiId:l.gotchi.id,launchMint:l.mint,venue:'meteora',signature:op.signature,mint:l.quoteMint,amount:row.amount,wallet:row.owner,sourceWallet:l.quoteMint===NATIVE_QUOTE?op.wallet:l.creatorAuthority,decimals:l.quoteDecimals,symbol:l.quoteSymbol,at:op.finalizedAt||op.createdAt||null});
        }
      }
    }
    return rows;
  }
  /** Finalized creator payouts whose recipient is the launch's saved agent wallet. */
  async agentSources(){
    const data=await this.load(),rows=[];
    for(const l of data.launches){
      if(!l.agent?.wallet||l.feeMode!=='agent')continue;
      for(const op of data.operations){
        if(op.mint!==l.mint||op.action!=='payout'||op.state!=='finalized'||!Array.isArray(op.payouts))continue;
        op.payouts.forEach((row,index)=>{
          if(row.owner!==l.agent.wallet)return;
          try{amount(row.amount);}catch{return;}
          rows.push({kind:'meteora-agent-payout',agentId:l.agent.id,launchMint:l.mint,venue:'meteora',signature:op.signature,allocation:`${l.mint}:${index}`,mint:l.quoteMint,amount:row.amount,wallet:row.owner,sourceWallet:l.quoteMint===NATIVE_QUOTE?op.wallet:l.creatorAuthority,decimals:l.quoteDecimals,at:op.finalizedAt||op.createdAt||null});
        });
      }
    }
    return rows;
  }
  /** Public, non-secret identity of every AI Agent Meteora coin (including drafts, so a failed launch is observed). */
  async agentLaunches(){
    const data=await this.load();
    return data.launches.filter(l=>l.agent?.wallet&&l.feeMode==='agent').map(l=>({venue:'meteora',mint:l.mint,launchId:l.id,accountId:l.creatorId,name:l.name,symbol:l.symbol,image:l.image||null,agent:{...l.agent},creatorWallet:l.creatorWallet,status:l.status,live:live(l),created:!!l.finalizedAt,createdAt:l.finalizedAt||l.createdAt,authorizedAt:l.finalizedAt||null,failed:['error','cancelled','expired'].includes(l.status)&&!l.finalizedAt,feeCustody:'relay',feeWallet:l.creatorAuthority,quoteMint:l.quoteMint,quoteDecimals:l.quoteDecimals,custody:[l.creatorAuthority,l.partnerAuthority,l.dbcPoolId,l.poolId].filter(Boolean),hidden:l.moderation?.hidden===true,archived:l.listArchive?.archived===true,paidRaw:l.ledger?.creatorPaid||'0',pendingRaw:l.ledger?.creatorCredit||'0',graduated:l.status==='migrated',redirected:!!l.redirectedAt}));
  }
  /** Public, non-secret identity of every Gotchi-paired Meteora coin. */
  async gotchiLaunches(){
    const data=await this.load();
    return data.launches.filter(l=>l.gotchi?.vault&&l.feeMode==='gotchi'&&live(l)).map(l=>({venue:'meteora',mint:l.mint,name:l.name,symbol:l.symbol,image:l.image||null,gotchi:{id:l.gotchi.id,theme:l.gotchi.theme,vault:l.gotchi.vault,attachedAt:l.gotchi.attachedAt||l.createdAt},status:l.status,graduated:l.status==='migrated',graduatedAt:l.status==='migrated'?l.migratedAt||null:null,createdAt:l.createdAt,finalizedAt:l.finalizedAt||null,quoteMint:l.quoteMint,quoteDecimals:l.quoteDecimals,quoteSymbol:l.quoteSymbol,baseDecimals:6,hidden:l.moderation?.hidden===true,archived:l.listArchive?.archived===true,custody:[l.creatorAuthority,l.partnerAuthority,l.dbcPoolId,l.poolId].filter(Boolean),contributedRaw:l.ledger?.creatorPaid||'0',pendingRaw:l.ledger?.creatorCredit||'0'}));
  }
  async analyticsRevenueSources(){const {meteoraRevenueAnalyticsSources}=await import('./meteora-revenue-records.mjs');return meteoraRevenueAnalyticsSources(await this.load());}
  async marketSnapshot(mint){const l=(await this.load()).launches.find(l=>l.mint===mint&&live(l));if(!l)return null;return this.adapter.marketSnapshot(l,await this.getQuotePrice(l.quoteMint).catch(()=>null));}
  async analyticsTrades(mint){return {trades:(await this.load()).operations.filter(o=>o.mint===mint&&o.state==='finalized'&&o.trade).map(o=>({...o.trade,signature:o.signature,wallet:o.wallet,at:o.finalizedAt})),complete:false};}
  async trades(mint){return (await this.analyticsTrades(mint)).trades.slice(-200).reverse();}
  async publicRewards(mint){
    const data=await this.load(),l=data.launches.find(l=>l.mint===mint&&live(l));if(!l)return null;
    const processing=data.operations.some(op=>op.mint===mint&&!TERMINAL.has(op.state)&&AUTOMATIC.has(op.action)),ledger=l.ledger;
    return {mint,mode:l.feeMode,quote:{mint:l.quoteMint,symbol:l.quoteSymbol},enabled:true,status:l.retry?'retrying':processing?'processing':'ready',taxBps:0,retryAt:l.retry?.at||null,asOf:this.now(),basket:basketView(l),holder:l.feeMode==='holders'?{distributedQuote:displayUnits(ledger.creatorPaid,l.quoteDecimals),pendingQuote:displayUnits(ledger.creatorCredit,l.quoteDecimals),payments:l.rewards.totalPayments,unclaimedCreatorQuote:null,unclaimedScope:'curve_and_pool',intervalMinutes:60,historyComplete:true,lastDistributionAt:l.rewards.lastDistributionAt||null,...(basketView(l)?{basket:basketRewardRows(l),rounds:basketRounds(l),stage:l.rewards.cycle?.stage||null}:{})}:null,creatorRewards:l.feeMode==='creator'?{totalPaidRaw:ledger.creatorPaid,totalClaimedRaw:ledger.creatorClaimed,pendingRaw:ledger.creatorCredit,at:l.updatedAt||l.finalizedAt,historyComplete:true}:null,gotchi:l.feeMode==='gotchi'&&l.gotchi?{id:l.gotchi.id,theme:l.gotchi.theme,vault:l.gotchi.vault,contributedRaw:ledger.creatorPaid,pendingRaw:ledger.creatorCredit,quoteDecimals:l.quoteDecimals,quoteSymbol:l.quoteSymbol,feePreset:l.policy?.preset||null,at:l.updatedAt||l.finalizedAt}:null,agent:l.feeMode==='agent'&&l.agent?{id:l.agent.id,wallet:l.agent.wallet,paidRaw:ledger.creatorPaid,pendingRaw:ledger.creatorCredit,quoteDecimals:l.quoteDecimals,quoteSymbol:l.quoteSymbol,at:l.updatedAt||l.finalizedAt}:null};
  }
  async analyticsRewardRecords(){
    const data=await this.load();return data.launches.filter(l=>live(l)&&l.feeMode==='holders').map(l=>{
      const operations=data.operations.filter(op=>op.mint===l.mint&&op.state==='finalized'&&['initialize','payout'].includes(op.action)&&(!op.assetMint||op.assetMint===l.quoteMint)).map(op=>({kind:op.action==='initialize'?'create':'payout',state:'confirmed',signature:op.signature,slot:op.result.slot,operationId:op.id,createdAt:op.createdAt,confirmedAt:op.finalizedAt,amount:op.action==='payout'?op.result.payout.quoteDebitRaw:'0',payouts:op.payouts||[],receipt:op.action==='payout'?{quoteDelta:'-'+op.result.payout.quoteDebitRaw,baseDelta:'0'}:null}));
      const fact=rewardAnalyticsRecord({input:{feeMode:'holders',quoteMint:l.quoteMint},keys:{mint:{address:l.mint}},review:{quoteDecimals:l.quoteDecimals,quoteSymbol:l.quoteSymbol},operations,historyTruncated:data.historyTruncated===true||data.operationsTruncated===true||l.historyTruncated===true||l.operationsTruncated===true},{mint:l.mint,quote:{mint:l.quoteMint,symbol:l.quoteSymbol}});
      // Saved cumulative counters prove missing retained receipts; they never
      // add payouts or recipients. Reuse the public reducers' exact decisions.
      const audit=holderRewardJournalAudit([fact],{maxDetails:0})[0],holders=publicRewardAnalytics([fact],{now:this.now()}).holders;
      if(l.ledger?.creatorPaid!==undefined){try{if(BigInt(amount(l.ledger.creatorPaid))>BigInt(audit?.countedQuoteUnits||'0'))fact.historyComplete=false;}catch{fact.historyComplete=false;}}
      if(l.rewards?.totalPayments!==undefined&&(!Number.isSafeInteger(l.rewards.totalPayments)||l.rewards.totalPayments<0||l.rewards.totalPayments>holders.observedPayments))fact.historyComplete=false;
      if(l.rewards?.paidWallets!==undefined){const rows=l.rewards.paidWallets;if(!Array.isArray(rows)||rows.some(owner=>{try{return address(owner)!==owner;}catch{return true;}})||new Set(rows).size>(holders.observedUniqueWallets||0))fact.historyComplete=false;}
      return fact;
    });
  }
  async requireAdmin(id){const a=typeof id==='string'?await this.accounts.get(id):null;if(!a||a.role!=='admin'||a.banned||!a.mfaEnabled)throw Object.assign(Error('Administrator access with two-factor authentication is required.'),{statusCode:403,code:'ADMIN_ACCESS_REQUIRED'});return a;}
  async protocolInventoryRows(actorId){
    await this.requireAdmin(actorId);const data=await this.load();if(!data.launches.some(live))return [];const recipient=address(await this.getTreasury());
    return data.launches.filter(live).map(l=>{
      const operations=data.operations.filter(op=>op.mint===l.mint&&['partner-claim','partner-payout'].includes(op.action)),pending=data.operations.find(op=>op.mint===l.mint&&blocksWorker(op));
      const requested=protocolCollectionActive(l),managed=!!data.authority?.secretBase64&&data.authority.address===l.partnerAuthority;
      const waitingForOperation=pending?{kind:pending.action,state:pending.state==='awaiting_signature'?'awaiting_signature':'pending',signature:pending.signature,createdAt:pending.createdAt}:null;
      return {route:'meteora',accountId:l.creatorId,id:l.id,name:l.name,symbol:l.symbol,mint:l.mint,quoteMint:l.quoteMint,quoteSymbol:l.quoteSymbol,feeWallet:l.partnerAuthority,creatorFeeWallet:l.creatorAuthority,serviceWalletManaged:managed,serviceWalletForUpgrade:false,platformFeeBps:0,policyCurrent:true,recipient,eligibility:{allowed:managed&&!requested,reason:!managed?'Restore the original encrypted Meteora protocol signer.':requested?'Protocol collection is already queued.':'',...(waitingForOperation?{waitingForOperation}:{})},activation:{allowed:false,reason:'Meteora protocol fees are already configured.'},waitingForOperation,requested,pending:operations.some(op=>!TERMINAL.has(op.state)),error:l.protocolCollection?.reason||'',protocolRetry:requested&&l.protocolCollection.retryAt?{at:l.protocolCollection.retryAt,attempt:l.protocolCollection.attempt||1,kind:'protocol',reason:l.protocolCollection.reason||''}:null,collecting:displayUnits(l.ledger.partnerCredit||'0',l.quoteDecimals),claimed:displayUnits(l.ledger.partnerClaimed||'0',l.quoteDecimals),paid:displayUnits(l.ledger.partnerPaid||'0',l.quoteDecimals),collectingBase:'0',claimedBase:'0',paidBase:'0',lpPolicy:{lpPolicy:'platform_locked',platformLpPercent:67},operations:operations.slice(-20).map(op=>({kind:op.action,state:op.state==='finalized'?'confirmed':op.state,signature:op.signature,createdAt:op.createdAt,confirmedAt:op.finalizedAt}))};
    });
  }
  async collectProtocolFees(actorId,input){
    object(input,['accountId','id','mint','requestId']);if(!/^[a-f0-9-]{16,64}$/.test(input.requestId||''))fail('A unique protocol collection request ID is required.');
    await this.requireAdmin(actorId);address(await this.getTreasury());
    const result=await this.locked(async()=>{
      const data=await this.load(),l=this.adminLaunch(data,input);await this.requireAdmin(actorId);
      const prior=[l.protocolCollection,...(l.protocolCollectionHistory||[])].find(request=>request?.requestId===input.requestId);
      if(prior){if(prior.actorId!==actorId)fail('This collection request belongs to another administrator.',403);return {alreadyRequested:true,...protocolCollectionView(prior)};}
      if(!live(l)||!data.authority?.secretBase64||data.authority.address!==l.partnerAuthority)return {skipped:true,reason:'A live Meteora launch and its original managed protocol signer are required.'};
      if(protocolCollectionActive(l)){const current=l.protocolCollection;l.protocolCollectionHistory=[...(l.protocolCollectionHistory||[]),{requestId:input.requestId,actorId,status:'already_requested',linkedRequestId:current.requestId,createdAt:this.now(),reason:'Protocol collection was already queued.'}];await this.save(data);return {alreadyRequested:true,...protocolCollectionView(current)};}
      if(l.protocolCollection)l.protocolCollectionHistory=[...(l.protocolCollectionHistory||[]),copy(l.protocolCollection)];
      l.protocolCollection={requestId:input.requestId,actorId,status:'queued',stage:'claim',createdAt:this.now(),reason:''};
      await this.save(data);return {queued:true,...protocolCollectionView(l.protocolCollection)};
    });
    this.kick();return result;
  }
  async processProtocolCollection(launch){
    const request=launch.protocolCollection;if(!protocolCollectionActive(launch)||request.retryAt>this.now())return;
    await this.requireAdmin(request.actorId);if(!live(launch))fail('Protocol collection requires a verified live Meteora launch.',409);
    const options={protocolRequestId:request.requestId};
    if(request.stage==='claim'){
      const state=await this.adapter.state(launch);if(!state)fail('Meteora fee state is unavailable.',503);
      if(BigInt(amount(state.partnerFeesPending||'0'))>0n){await this.automatic(launch.mint,'partner-claim',(d,l)=>this.adapter.preparePartnerClaim({wallet:d.authority.address,launch:l,receiver:l.partnerAuthority}),options);return;}
    }else if(request.stage!=='payout')fail('The saved protocol collection stage is invalid.',409);
    const credit=amount(launch.ledger.partnerCredit||'0');
    if(BigInt(credit)>0n){const payouts=[{owner:address(await this.getTreasury()),amount:credit}];await this.automatic(launch.mint,'partner-payout',(d,l)=>this.adapter.preparePayout({wallet:d.authority.address,launch:l,source:l.partnerAuthority,role:'partner',payouts}),{...options,payouts});return;}
    await this.locked(async()=>{const data=await this.load(),l=data.launches.find(row=>row.mint===launch.mint);if(!l||l.protocolCollection?.requestId!==request.requestId||data.operations.some(op=>op.mint===l.mint&&blocksWorker(op)))return;await this.requireAdmin(request.actorId);l.protocolCollection.status='completed';l.protocolCollection.completedAt=this.now();l.protocolCollection.reason='';await this.save(data);});
  }
  adminRow(l,data,account={}){
    const pending=data.operations.find(op=>op.mint===l.mint&&!TERMINAL.has(op.state)),reason='Meteora fee routing and reward recovery use the Meteora controls. Raydium actions do not apply.';
    return {route:'meteora',platform:'meteora',accountId:l.creatorId,username:account.username||'',id:l.id,mint:l.mint,network:'mainnet-beta',name:l.name,symbol:l.symbol,state:l.status,createdAt:l.createdAt,...pumpArchiveView(l,data.operations),quoteMint:l.quoteMint,quoteSymbol:l.quoteSymbol,recipient:l.creatorRecipient,feeMode:l.feeMode,feeCustody:'relay',feeWallet:l.creatorAuthority,rewardsWallet:l.feeMode==='holders'?{address:l.creatorAuthority,status:'active'}:null,eligibility:{allowed:false,reason},rewardsAction:{kind:null,allowed:false,reason,busy:!!pending,autoFees:true},rewardsAutomation:{allowed:false,enabled:true,reason,pending:!!pending,needed:false},serviceError:'',serviceStage:l.rewards?.cycle?'payout':'',pendingOperation:pending?{kind:pending.action,state:pending.state,signature:pending.signature||'',createdAt:pending.createdAt,reason:''}:null,rewardRetry:l.retry||null,deferredRewards:{wallets:(l.rewards?.debts||[]).length+Object.values(l.rewards?.basketDebts||{}).reduce((n,rows)=>n+(rows?.length||0),0),amount:displayUnits(payoutSum(l.rewards?.debts||[]),l.quoteDecimals)},credits:{quote:displayUnits(l.ledger.creatorCredit,l.quoteDecimals),base:'0',...(basketView(l)?{basket:basketRewardRows(l).slice(1).map(row=>({mint:row.mint,symbol:row.symbol,pending:row.pending}))}:{})},basket:basketView(l),rewardHistory:[],history:[]};
  }
  async adminInventory(actorId){await this.requireAdmin(actorId);const data=await this.load(),people=await this.accounts.list(),byId=new Map(people.map(a=>[a.id,a]));return data.launches.map(l=>{const account={id:l.creatorId,username:byId.get(l.creatorId)?.username||''};return {account,adminRow:this.adminRow(l,data,account),launch:{id:l.id,createdAt:l.createdAt,state:l.status,curve:l.dbcPoolId||null,heldSolInventory:{live:live(l)&&l.quoteDecimals===9&&!l.basket,credit:l.ledger?.creatorCredit,busy:heldSolActive(l)||!!l.rewards?.cycle||data.operations.some(op=>op.mint===l.mint&&blocksWorker(op))},input:{route:'meteora',network:'mainnet-beta',name:l.name,symbol:l.symbol,recipient:l.creatorRecipient,feeMode:l.feeMode,quoteMint:l.quoteMint},keys:{mint:{address:l.mint},wallet:{address:l.creatorAuthority}},moderation:{hidden:l.moderation?.hidden===true},listArchive:{archived:l.listArchive?.archived===true}}};});}
  adminLaunch(data,input){const l=data.launches.find(l=>l.id===input.id&&l.mint===input.mint&&l.creatorId===input.accountId);if(!l)fail('Meteora launch not found.',404);return l;}
  async adminVisibility(actorId,input){await this.requireAdmin(actorId);if(typeof input.hidden!=='boolean'||typeof input.reason!=='string'||input.reason.trim().length<5||input.reason.length>500)fail('Provide a visibility action and reason (5–500 characters).');return this.locked(async()=>{const data=await this.load(),l=this.adminLaunch(data,input);await this.requireAdmin(actorId);l.moderation={hidden:input.hidden,reason:input.reason.trim(),actorId,at:this.now()};l.moderationHistory=[...(l.moderationHistory||[]),l.moderation];await this.save(data);return {route:'meteora',mint:l.mint,id:l.id,hidden:input.hidden};});}
  async adminArchive(actorId,input){await this.requireAdmin(actorId);if(typeof input.archived!=='boolean')fail('Choose archive or restore.');return this.locked(async()=>{const data=await this.load(),l=this.adminLaunch(data,input);await this.requireAdmin(actorId);if(setPumpArchive(l,data.operations,{archived:input.archived,actorId,at:this.now()}))await this.save(data);return {route:'meteora',launch:this.adminRow(l,data,await this.accounts.get(l.creatorId)||{})};});}
  async queueHeldSolDistribution(actorId,input){
    object(input,['accountId','id','mint','requestId']);if(!/^[a-f0-9]{32}$/.test(input.requestId||''))fail('A saved distribution request is required.');
    await this.requireAdmin(actorId);
    return this.locked(async()=>{
      const data=await this.load(),l=this.adminLaunch(data,input);await this.requireAdmin(actorId);
      const saved=[l.heldSolDistribution,...(l.heldSolDistributionHistory||[])].find(row=>row?.requestId===input.requestId);if(saved){if(saved.actorId!==actorId)fail('The saved distribution belongs to another administrator.',403);return heldSolView(saved);}
      let reason='';
      if(!live(l)||l.feeMode!=='holders'||l.quoteMint!==NATIVE_QUOTE||l.quoteDecimals!==9||l.basket)reason=l.basket?'Reward-basket launches distribute on their own schedule; a manual held-SOL distribution does not apply.':'Only live holder rewards with SOL as the reward asset are included.';
      else if(heldSolActive(l)||l.rewards?.cycle||data.operations.some(op=>op.mint===l.mint&&blocksWorker(op))){
        const operation=data.operations.find(op=>op.mint===l.mint&&blocksWorker(op));
        // Keep the parent intent waiting without replacing a saved transaction
        // or writing a terminal child history entry for this exact request ID.
        return {state:'waiting',reason:operation?.state==='awaiting_signature'?'Waiting for the saved wallet signature. Complete or cancel it in this coin’s controls; this request will check again automatically.':operation?'Waiting for the saved transaction to confirm. This request will continue automatically afterward.':l.retry?'Waiting for the existing reward retry. Review this coin’s retry reason and service gas; this request will check again automatically.':'Waiting for the existing reward cycle to finish. This request will check the remaining SOL reward credit automatically.'};
      }
      else if(l.retry)reason='Resolve the existing Meteora reward retry before starting a manual distribution.';
      const credit=BigInt(amount(l.ledger?.creatorCredit||'0'));
      if(!reason&&credit===0n)reason='No verified held SOL reward credit is available.';
      const request={requestId:input.requestId,actorId,status:reason?'skipped':'queued',reason,amountLamports:reason?'0':String(credit),createdAt:this.now(),previousState:l.status,creatorPaidBefore:l.ledger?.creatorPaid||'0'};
      if(reason){request.completedAt=this.now();l.heldSolDistributionHistory=[...(l.heldSolDistributionHistory||[]),request];}
      else l.heldSolDistribution=request;
      await this.save(data);return heldSolView(request);
    });
  }
  async heldSolDistributionStatus({accountId,id,requestId}){
    const data=await this.load(),l=data.launches.find(row=>row.id===id&&row.creatorId===accountId),request=l&&[l.heldSolDistribution,...(l.heldSolDistributionHistory||[])].find(row=>row?.requestId===requestId);
    return request?heldSolView(request):l?null:{state:'skipped',reason:'The saved Meteora launch was not found.',amountLamports:'0'};
  }
  start(){if(this.timer)return;this.closed=false;this.timer=setInterval(()=>this.kick(),this.intervalMs);this.timer.unref?.();this.kick();}
  async stop(){this.closed=true;clearInterval(this.timer);this.timer=null;await(this.running||Promise.resolve());this.adapter.close?.();}
  kick(){if(this.closed||this.running)return;this.running=this.tick().catch(()=>{}).finally(()=>{this.running=null;});}
  async tick(){
    let data=await this.load();if(!data.config||!data.authority)return;
    if(data.operations.some(o=>o.state==='awaiting_signature'&&o.expiresAt<=this.now())){await this.locked(async()=>{const fresh=await this.load();for(const op of fresh.operations)if(op.state==='awaiting_signature'&&op.expiresAt<=this.now())op.state='cancelled';await this.save(fresh);});data=await this.load();}
    const pending=data.operations.filter(o=>o.state!=='awaiting_signature'&&!TERMINAL.has(o.state)).slice(0,12);
    for(let i=0;i<pending.length;i+=3)await Promise.allSettled(pending.slice(i,i+3).map(async op=>{const result=await this.receipt(op);if(result?.operation.state==='pending'&&this.now()-(op.lastBroadcastAt||0)>30000)await this.broadcast(op);}));
    data=await this.load();const candidates=data.launches.filter(live);const start=(data.cursor||0)%Math.max(1,candidates.length),batch=[];for(let n=0;n<Math.min(12,candidates.length);n++)batch.push(candidates[(start+n)%candidates.length]);
    await this.locked(async()=>{const fresh=await this.load();fresh.cursor=start+batch.length;await this.save(fresh);});
    for(let i=0;i<batch.length;i+=3)await Promise.allSettled(batch.slice(i,i+3).map(l=>this.processLaunch(l.mint)));
  }
  async automatic(mint,action,prepare,{payouts,cycleId,cycleIndex,protocolRequestId,assetMint,legIndex}={}){
    if(!AUTOMATIC.has(action))fail('Unsupported automatic Meteora action.',409);const snapshot=await this.load(),launch=snapshot.launches.find(l=>l.mint===mint);if(!launch||!live(launch)||snapshot.operations.some(o=>o.mint===mint&&blocksWorker(o)))return null;
    const partner=['partner-claim','partner-payout'].includes(action),manualProtocol=partner&&protocolRequestId!==undefined;
    if(manualProtocol){if(!protocolCollectionActive(launch)||launch.protocolCollection.requestId!==protocolRequestId)fail('The saved protocol collection request changed.',409);await this.requireAdmin(launch.protocolCollection.actorId);}
    if(heldSolActive(launch)&&action!=='payout'&&!manualProtocol)return null;
    const protocolRecipient=partner?address(await this.getTreasury()):null;
    if(partner&&(protocolRecipient===launch.partnerAuthority||!PublicKey.isOnCurve(new PublicKey(protocolRecipient).toBytes())))fail('The protocol treasury must be a separate receiving wallet.',409);
    if(action==='partner-payout'&&(!Array.isArray(payouts)||payouts.length!==1||payouts[0].owner!==protocolRecipient||payouts[0].amount!==launch.ledger.partnerCredit))fail('The protocol payout must preserve its exact credit and current treasury.',409);
    const bundle=await prepare(snapshot,partner?{...launch,treasury:protocolRecipient}:launch);if(!bundle)return null;
    const partition=payouts?payoutPartition(payouts,bundle):null;
    if(partition&&!partition.ready.length){
      if(action==='partner-payout'||launch.feeMode!=='holders')fail('The fee recipient cannot currently receive the payout. It will retry automatically.',409);
      await this.locked(async()=>{const data=await this.load(),current=data.launches.find(l=>l.mint===mint),cycle=current?.rewards.cycle;if(!cycle||cycle.id!==cycleId||data.operations.some(o=>o.mint===mint&&blocksWorker(o)))return;
        if(cycle.basket){const asset=cycle.assets?.[cycle.assetIndex];if(!asset||asset.mint!==assetMint||asset.index!==cycleIndex)return;current.retry=null;this.advanceBasketCycle(current,{cycleId,cycleIndex,assetMint,count:payouts.length,deferred:partition.deferred},this.now());}
        else{if(cycle.index!==cycleIndex)return;current.retry=null;current.rewards.debts=mergeHolderRewardPayouts(current.rewards.debts||[],partition.deferred);cycle.index+=payouts.length;if(cycle.index>=cycle.payouts.length){finishHeldSolDistribution(current,cycle,this.now());delete current.rewards.cycle;current.rewards.nextCheckAt=this.now()+REWARD_INTERVAL;}}
        await this.save(data);});return null;
    }
    const tx=this.validateBundle(bundle,snapshot.authority.address,launch,snapshot);
    const saved=await this.locked(async()=>{const data=await this.load(),current=data.launches.find(l=>l.mint===mint);if(!current||data.operations.some(o=>o.mint===mint&&blocksWorker(o)))return null;if(current.creatorRecipient!==launch.creatorRecipient||JSON.stringify(current.rewards?.cycle)!==JSON.stringify(launch.rewards?.cycle)||current.ledger.creatorCredit!==launch.ledger.creatorCredit||current.ledger.partnerCredit!==launch.ledger.partnerCredit||JSON.stringify(current.heldSolDistribution)!==JSON.stringify(launch.heldSolDistribution))fail('Fee allocation changed during preparation.',409);if(partner&&address(await this.getTreasury())!==protocolRecipient)fail('The protocol treasury changed during preparation.',409);if(manualProtocol){if(!protocolCollectionActive(current)||current.protocolCollection.requestId!==protocolRequestId)fail('The saved protocol collection request changed.',409);await this.requireAdmin(current.protocolCollection.actorId);}if(heldSolActive(current)&&!manualProtocol){await this.requireAdmin(current.heldSolDistribution.actorId);if(action!=='payout'||current.rewards.cycle?.heldSolRequestId!==current.heldSolDistribution.requestId)fail('Only this request’s saved holder payouts may be signed.',409);}const op={id:randomUUID(),action,mint,wallet:data.authority.address,ownerId:null,state:'journaled',createdAt:this.now(),bundle:copy(bundle),...(action==='partner-payout'?{protocolRecipient}:{}),...(manualProtocol?{protocolRequestId}:{}),...(payouts?{payouts:partition.ready,deferredPayouts:partition.deferred,cycleCount:payouts.length,cycleId,cycleIndex,...(assetMint?{assetMint}:{})}:{}),...(action==='basket-convert'?{cycleId,legIndex,conversion:copy(bundle.conversion)}:{}),...this.sign(tx,data,current)};
        if(action==='basket-convert'){const leg=current.rewards.cycle?.basket&&current.rewards.cycle.id===cycleId?current.rewards.cycle.legs?.[legIndex]:null;if(!leg||leg.state!=='queued'||!bundle.conversion||bundle.conversion.outputMint!==leg.mint||bundle.conversion.inputRaw!==leg.inputRaw)fail('The basket conversion leg changed during preparation.',409);leg.state='converting';leg.operationId=op.id;leg.attempts=(leg.attempts||0)+1;}
        data.operations.push(op);if(manualProtocol){current.protocolCollection.status='processing';current.protocolCollection.reason='';delete current.protocolCollection.retryAt;}await this.save(data);return op;});
    if(saved)await this.broadcast(saved);return saved;
  }
  async processHeldSolDistribution(launch){
    const request=launch.heldSolDistribution,mint=launch.mint;
    await this.requireAdmin(request.actorId);
    if(request.retryAt>this.now())return;
    if(!live(launch)||launch.feeMode!=='holders'||launch.quoteMint!==NATIVE_QUOTE||launch.quoteDecimals!==9||launch.basket)heldSolMismatch('The held SOL distribution no longer matches its saved launch.');
    const cycle=launch.rewards.cycle;
    if(cycle){
      if(cycle.heldSolRequestId!==request.requestId||!Array.isArray(cycle.payouts)||!Number.isSafeInteger(cycle.index)||cycle.index<0||cycle.index>=cycle.payouts.length)heldSolMismatch('The saved payout cycle differs from this distribution.');
      const payouts=cycle.payouts.slice(cycle.index,cycle.index+3);
      if(payouts.length)await this.automatic(mint,'payout',(d,l)=>this.adapter.preparePayout({wallet:d.authority.address,launch:l,source:l.creatorAuthority,payouts}),{payouts,cycleId:cycle.id,cycleIndex:cycle.index});
      return;
    }
    const credit=BigInt(amount(launch.ledger.creatorCredit)),budget=BigInt(amount(request.amountLamports)),debts=launch.rewards.debts||[],reserved=payoutSum(debts);
    if(!budget||credit<budget||reserved>budget)heldSolMismatch('Held SOL reward credit differs from the saved distribution budget.');
    let fresh=[],slot=launch.rewards.lastSnapshotSlot||0;
    if(budget>reserved){
      const holders=await this.adapter.holderSnapshot(launch);
      if(!Number.isSafeInteger(holders?.slot)||holders.slot<=0||holders.complete!==true||!Array.isArray(holders.rows)||holders.rows.length>50000)fail('A complete finalized holder snapshot is required.',502);
      const excluded=new Set([launch.creatorAuthority,launch.partnerAuthority,launch.dbcPoolId,launch.poolId]);
      for(const row of holders.rows){address(row.owner);amount(row.amount);if(!PublicKey.isOnCurve(new PublicKey(row.owner).toBytes())||excluded.has(row.owner))fail('Holder snapshot contains an ineligible account.',502);}
      fresh=weightedRewards(budget-reserved,holders.rows,1n).payouts;slot=holders.slot;
    }
    const payouts=mergeHolderRewardPayouts(debts,fresh);
    await this.locked(async()=>{
      const data=await this.load(),l=data.launches.find(row=>row.mint===mint);
      if(!l||JSON.stringify(l.heldSolDistribution)!==JSON.stringify(request)||l.rewards.cycle||l.ledger.creatorCredit!==String(credit)||JSON.stringify(l.rewards.debts||[])!==JSON.stringify(debts)||data.operations.some(op=>op.mint===mint&&blocksWorker(op)))return;
      await this.requireAdmin(l.heldSolDistribution.actorId);
      if(payouts.length){l.rewards.cycle={id:randomUUID(),heldSolRequestId:request.requestId,slot,amount:String(budget),payouts,index:0,createdAt:this.now()};l.rewards.debts=[];l.rewards.lastSnapshotSlot=slot;l.heldSolDistribution.status='processing';l.heldSolDistribution.reason='Distributing the saved held SOL reward credit.';}
      else{l.heldSolDistribution.status='skipped';l.heldSolDistribution.reason='No eligible holder allocation is available; the SOL reward credit is retained.';l.heldSolDistribution.completedAt=this.now();l.heldSolDistributionHistory=[...(l.heldSolDistributionHistory||[]),copy(l.heldSolDistribution)];}
      await this.save(data);
    });
  }
  /** A conversion leg that could not be prepared or did not land: one more attempt, or, past the limit, the share stays in the pair asset. */
  failBasketLeg(leg,reason){leg.note=String(reason||'').slice(0,200);leg.state=(leg.attempts||0)>=BASKET_LIMITS.conversionAttempts?'skipped':'queued';delete leg.operationId;}
  /** Payout bookkeeping of a basket round: the current asset advances by `count` recipients, deferred recipients become that asset's
   * saved debt, the next asset starts when one is done, the round closes when every asset is. */
  advanceBasketCycle(launch,{cycleId,cycleIndex,assetMint,count,deferred=[]},now){
    const cycle=launch.rewards.cycle;if(!cycle?.basket||cycle.id!==cycleId||cycle.stage!=='payout')fail('Holder payout cycle differs from its receipt.',502);
    const asset=cycle.assets?.[cycle.assetIndex];if(!asset||asset.mint!==assetMint||asset.index!==cycleIndex)fail('Holder payout cycle differs from its receipt.',502);
    asset.index+=count;
    if(deferred.length){if(asset.mint===launch.quoteMint)launch.rewards.debts=mergeHolderRewardPayouts(launch.rewards.debts||[],deferred);else{launch.rewards.basketDebts||={};launch.rewards.basketDebts[asset.mint]=mergeHolderRewardPayouts(launch.rewards.basketDebts[asset.mint]||[],deferred);}}
    if(asset.index>=asset.payouts.length){cycle.assetIndex+=1;if(cycle.assetIndex>=cycle.assets.length)this.finishBasketCycle(launch,now);}
  }
  finishBasketCycle(launch,now){
    const cycle=launch.rewards.cycle||{};launch.rewards.lastDistributionAt=now;launch.rewards.nextCheckAt=now+REWARD_INTERVAL;
    const round={id:cycle.id,at:now,assets:(cycle.assets||[]).map(a=>({mint:a.mint,symbol:a.symbol,decimals:a.decimals,amountRaw:a.amount,recipients:a.payouts.length})),skipped:(cycle.legs||[]).filter(l=>l.state==='skipped'&&BigInt(l.inputRaw||'0')>0n).map(l=>({mint:l.mint,inputRaw:l.inputRaw,note:l.note||'no conversion route'}))};
    launch.rewards.rounds=[...(launch.rewards.rounds||[]).slice(-19),round];delete launch.rewards.cycle;
  }
  /** Reward baskets (v71.33): the holder-reward round of a basket launch. No round → when due and at least $100 of the pair asset
   * is ready (or saved debts wait), the available credit is split equally across the basket and a round starts. Stage `convert`:
   * one Jupiter conversion per extra asset (pair asset → asset), one operation at a time, each exact and settled from its finalized
   * receipt; a conversion that cannot be prepared or does not land is retried up to the limit, then its share stays in the pair
   * asset. Stage `allocate`: one finalized holder snapshot, pro-rata payouts per asset (saved debts first). Stage `payout`: three
   * recipients per transaction, asset by asset. Then the round closes and the next check is an hour away. */
  async processBasketRewards(launch){
    const mint=launch.mint,credit=BigInt(amount(launch.ledger.creatorCredit)),cycle=launch.rewards.cycle,assets=launch.basket.assets;
    if(!cycle){
      if(launch.rewards.nextCheckAt>this.now())return;
      const price=await this.getQuotePrice(launch.quoteMint);if(!freshPrice(price,launch.quoteMint,this.now()))fail('Fresh quote price required for holder rewards.',409);
      const minimum=rewardMinimum(price.usd,launch.quoteDecimals),debts=launch.rewards.debts||[],basketDebts=launch.rewards.basketDebts||{},reserved=payoutSum(debts);
      if(reserved>credit)fail('Reserved holder rewards exceed verified fee credit.',503);
      const available=credit-reserved,anyDebt=debts.length>0||Object.values(basketDebts).some(rows=>Array.isArray(rows)&&rows.length>0);
      const leftover=assets.slice(1).some(a=>BigInt(amount(launch.ledger.basket?.[a.mint]?.credit||'0'))-payoutSum(basketDebts[a.mint]||[])>0n);
      if(available<minimum&&!anyDebt&&!leftover){await this.locked(async()=>{const d=await this.load(),l=d.launches.find(l=>l.mint===mint);if(!l||heldSolActive(l))return;l.rewards.nextCheckAt=this.now()+REWARD_INTERVAL;await this.save(d);});return;}
      const shares=available>=minimum?basketShares(available,assets.length):assets.map(()=>0n);
      const legs=assets.slice(1).map((asset,i)=>({mint:asset.mint,inputRaw:shares[i+1].toString(),state:shares[i+1]>0n?'queued':'skipped',attempts:0,outputRaw:'0',note:shares[i+1]>0n?'':'nothing to convert this round'}));
      await this.locked(async()=>{const d=await this.load(),l=d.launches.find(l=>l.mint===mint);if(!l||heldSolActive(l)||l.ledger.creatorCredit!==String(credit)||l.rewards.cycle||JSON.stringify(l.rewards.debts||[])!==JSON.stringify(debts))return;l.rewards.nextCheckAt=this.now()+REWARD_INTERVAL;l.rewards.cycle={id:randomUUID(),basket:true,stage:legs.some(leg=>leg.state==='queued')?'convert':'allocate',mainRaw:shares[0].toString(),legs,createdAt:this.now()};await this.save(d);});
      return;
    }
    if(!cycle.basket)fail('A basket launch has a plain reward cycle.',503);
    if(cycle.stage==='convert'){
      const index=cycle.legs.findIndex(leg=>leg.state==='queued');
      if(index<0){await this.locked(async()=>{const d=await this.load(),l=d.launches.find(l=>l.mint===mint),c=l?.rewards.cycle;if(!c||c.id!==cycle.id||c.stage!=='convert'||c.legs.some(leg=>['queued','converting'].includes(leg.state)))return;c.stage='allocate';await this.save(d);});return;}
      const leg=cycle.legs[index],asset=assets.find(a=>a.mint===leg.mint);if(!asset)fail('The basket leg names an asset the launch does not hold.',503);
      try{await this.automatic(mint,'basket-convert',(d,l)=>this.adapter.prepareBasketConversion({wallet:d.authority.address,launch:l,asset,inputRaw:leg.inputRaw}),{cycleId:cycle.id,legIndex:index});}
      catch(error){
        // The route or its guard refused, or the chain could not be read: count the attempt (the share stays in the pair asset past the limit), then back off like any other reward failure.
        await this.locked(async()=>{const d=await this.load(),l=d.launches.find(l=>l.mint===mint),c=l?.rewards.cycle,row=c?.id===cycle.id?c.legs?.[index]:null;if(!row||row.state!=='queued')return;row.attempts=(row.attempts||0)+1;this.failBasketLeg(row,error?.message);await this.save(d);}).catch(()=>{});
        throw error;
      }
      return;
    }
    if(cycle.stage==='allocate'){
      const debts=launch.rewards.debts||[],basketDebts=launch.rewards.basketDebts||{},skippedRaw=cycle.legs.filter(l=>l.state==='skipped').reduce((n,l)=>n+BigInt(amount(l.inputRaw||'0')),0n);
      const amounts=assets.map((a,i)=>i===0?BigInt(amount(cycle.mainRaw||'0'))+skippedRaw:BigInt(amount(launch.ledger.basket?.[a.mint]?.credit||'0'))-payoutSum(basketDebts[a.mint]||[]));
      if(amounts[0]+payoutSum(debts)>credit)fail('Reserved holder rewards exceed verified fee credit.',503);
      if(amounts.some(x=>x<0n))fail('Reserved basket rewards exceed verified credit.',503);
      let rows=null,slot=launch.rewards.lastSnapshotSlot||0;
      if(amounts.some(x=>x>0n)){const holders=await this.adapter.holderSnapshot(launch);if(!Number.isSafeInteger(holders?.slot)||holders.slot<=0||holders.complete!==true||!Array.isArray(holders.rows)||holders.rows.length>50000)fail('A complete finalized holder snapshot is required.',502);
        const excluded=new Set([launch.creatorAuthority,launch.partnerAuthority,launch.dbcPoolId,launch.poolId]);for(const row of holders.rows){address(row.owner);amount(row.amount);if(!PublicKey.isOnCurve(new PublicKey(row.owner).toBytes())||excluded.has(row.owner))fail('Holder snapshot contains an ineligible account.',502);}
        rows=holders.rows;slot=holders.slot;}
      const plans=assets.map((a,i)=>{const fresh=rows&&amounts[i]>0n?weightedRewards(amounts[i],rows,1n).payouts:[];const payouts=mergeHolderRewardPayouts(i===0?debts:(basketDebts[a.mint]||[]),fresh);return {mint:a.mint,symbol:a.symbol,decimals:a.decimals,program:a.program||null,amount:amounts[i].toString(),payouts,index:0};}).filter(plan=>plan.payouts.length);
      await this.locked(async()=>{const d=await this.load(),l=d.launches.find(l=>l.mint===mint),c=l?.rewards.cycle;if(!l||heldSolActive(l)||!c||c.id!==cycle.id||c.stage!=='allocate'||l.ledger.creatorCredit!==String(credit)||JSON.stringify(l.rewards.debts||[])!==JSON.stringify(debts)||JSON.stringify(l.rewards.basketDebts||{})!==JSON.stringify(basketDebts))return;l.rewards.lastSnapshotSlot=slot;if(!plans.length)this.finishBasketCycle(l,this.now());else{c.stage='payout';c.slot=slot;c.assets=plans;c.assetIndex=0;l.rewards.debts=[];l.rewards.basketDebts={};}await this.save(d);});
      return;
    }
    if(cycle.stage==='payout'){
      const asset=cycle.assets?.[cycle.assetIndex];
      if(!asset){await this.locked(async()=>{const d=await this.load(),l=d.launches.find(l=>l.mint===mint),c=l?.rewards.cycle;if(!c||c.id!==cycle.id||c.stage!=='payout'||c.assets?.[c.assetIndex])return;this.finishBasketCycle(l,this.now());await this.save(d);});return;}
      const payouts=asset.payouts.slice(asset.index,asset.index+3),extra=asset.mint!==launch.quoteMint?{mint:asset.mint,symbol:asset.symbol,decimals:asset.decimals,program:asset.program}:null;
      if(payouts.length)await this.automatic(mint,'payout',(d,l)=>this.adapter.preparePayout({wallet:d.authority.address,launch:l,source:l.creatorAuthority,payouts,...(extra?{asset:extra}:{})}),{payouts,cycleId:cycle.id,cycleIndex:asset.index,assetMint:asset.mint});
      return;
    }
    fail('The saved basket reward round has an unknown stage.',503);
  }
  async processLaunch(mint){
    const snapshot=await this.load(),launch=snapshot.launches.find(l=>l.mint===mint);if(!launch||this.closed||!protocolCollectionActive(launch)&&launch.retry?.at>this.now()||snapshot.operations.some(o=>o.mint===mint&&blocksWorker(o)))return;
    try{
      if(protocolCollectionActive(launch)){await this.processProtocolCollection(launch);return;}
      // This owner-requested pass spends only previously verified creator credit.
      // It never collects fees, migrates pools, or includes the protocol balance.
      if(heldSolActive(launch)){await this.processHeldSolDistribution(launch);return;}
      if(launch.rewards?.cycle?.heldSolRequestId)return;
      const state=await this.adapter.state(launch);if(!state)return;
      if(state.phase==='migrated'&&launch.status!=='migrated'){
        if(state.lpLocked!==true||!state.poolId)fail('External migration must be verified before fee claims.',502);
        await this.locked(async()=>{const d=await this.load(),l=d.launches.find(l=>l.mint===mint);l.status='migrated';l.migratedAt||=this.now();l.poolId=state.poolId;if(state.position)l.position=copy(state.position);await this.save(d);});
      }
      if(state.phase==='bonded'&&launch.status!=='migrated'){await this.automatic(mint,'migrate',(d,l)=>this.adapter.prepareMigration({wallet:d.authority.address,launch:l}));return;}
      const credit=BigInt(launch.ledger.creatorCredit),partnerCredit=BigInt(launch.ledger.partnerCredit||'0');
      let automaticMinimum=null;
      try{const price=await this.getQuotePrice(launch.quoteMint);if(freshPrice(price,launch.quoteMint,this.now()))automaticMinimum=rewardMinimum(price.usd,launch.quoteDecimals,1n);}catch{}
      const creatorPayout=['creator','gotchi','agent'].includes(launch.feeMode)&&automaticMinimum!==null&&credit>=automaticMinimum;
      const holderPayout=launch.feeMode==='holders'&&credit>0n&&(launch.rewards.cycle||launch.rewards.nextCheckAt<=this.now());
      const partnerPayout=automaticMinimum!==null&&partnerCredit>=automaticMinimum;
      // A protocol claim is earned inventory, not a treasury receipt. Transfer
      // its exact credit through the managed authority to preserve the existing
      // treasury deposit proofs and unwrap only that amount of native SOL.
      if(partnerPayout){const payouts=[{owner:address(await this.getTreasury()),amount:String(partnerCredit)}];await this.automatic(mint,'partner-payout',(d,l)=>this.adapter.preparePayout({wallet:d.authority.address,launch:l,source:l.partnerAuthority,role:'partner',payouts}),{payouts});return;}
      if(automaticMinimum!==null){
        const candidates=[['partner',launch.lastPartnerClaimAt||0,state.partnerFeesPending],['creator',launch.lastCreatorClaimAt||0,state.creatorFeesPending]].filter(([role,at,value])=>!creatorPayout&&(role==='partner'||!holderPayout)&&this.now()-at>=60000&&BigInt(amount(value||'0'))>=automaticMinimum).sort((a,b)=>a[1]-b[1]);
        if(candidates.length){const role=candidates[0][0];await this.automatic(mint,role+'-claim',(d,l)=>role==='partner'?this.adapter.preparePartnerClaim({wallet:d.authority.address,launch:l,receiver:l.partnerAuthority}):this.adapter.prepareCreatorClaim({wallet:d.authority.address,launch:l,receiver:l.creatorAuthority}));return;}
      }
      if(launch.feeMode==='holders'&&launch.basket){await this.processBasketRewards(launch);return;}
      if(!credit)return;
      if(['creator','gotchi','agent'].includes(launch.feeMode)){if(launch.feeMode==='gotchi'&&launch.creatorRecipient!==launch.gotchi?.vault)fail('The Gotchi launch recipient differs from its saved vault.',409);if(launch.feeMode==='agent'&&launch.creatorRecipient!==launch.agent?.wallet)fail('The AI Agent launch recipient differs from its saved agent wallet.',409);if(creatorPayout){const payouts=[{owner:launch.creatorRecipient,amount:String(credit)}];await this.automatic(mint,'payout',(d,l)=>this.adapter.preparePayout({wallet:d.authority.address,launch:l,source:l.creatorAuthority,payouts}),{payouts});}return;}
      if(!launch.rewards.cycle){
        if(launch.rewards.nextCheckAt>this.now())return;
        const price=await this.getQuotePrice(launch.quoteMint);if(!freshPrice(price,launch.quoteMint,this.now()))fail('Fresh quote price required for holder rewards.',409);
        const minimum=rewardMinimum(price.usd,launch.quoteDecimals),debts=launch.rewards.debts||[],reserved=payoutSum(debts);
        if(reserved>credit)fail('Reserved holder rewards exceed verified fee credit.',503);
        const available=credit-reserved;
        if(available<minimum&&!debts.length){await this.locked(async()=>{const d=await this.load(),l=d.launches.find(l=>l.mint===mint);if(!l||heldSolActive(l))return;l.rewards.nextCheckAt=this.now()+REWARD_INTERVAL;await this.save(d);});return;}
        let fresh=[],slot=launch.rewards.lastSnapshotSlot||0;
        if(available>=minimum){const holders=await this.adapter.holderSnapshot(launch);if(!Number.isSafeInteger(holders?.slot)||holders.slot<=0||holders.complete!==true||!Array.isArray(holders.rows)||holders.rows.length>50000)fail('A complete finalized holder snapshot is required.',502);
          const excluded=new Set([launch.creatorAuthority,launch.partnerAuthority,launch.dbcPoolId,launch.poolId]);for(const row of holders.rows){address(row.owner);amount(row.amount);if(!PublicKey.isOnCurve(new PublicKey(row.owner).toBytes())||excluded.has(row.owner))fail('Holder snapshot contains an ineligible account.',502);}
          fresh=weightedRewards(available,holders.rows,1n).payouts;slot=holders.slot;}
        const allocations=mergeHolderRewardPayouts(debts,fresh);
        await this.locked(async()=>{const d=await this.load(),l=d.launches.find(l=>l.mint===mint);if(!l||heldSolActive(l)||l.ledger.creatorCredit!==String(credit)||l.rewards.cycle||JSON.stringify(l.rewards.debts||[])!==JSON.stringify(debts))return;l.rewards.nextCheckAt=this.now()+REWARD_INTERVAL;l.rewards.lastSnapshotSlot=slot;if(allocations.length){l.rewards.cycle={id:randomUUID(),slot,amount:String(credit),payouts:allocations,index:0,createdAt:this.now()};l.rewards.debts=[];}await this.save(d);});return;
      }
      const cycle=launch.rewards.cycle,payouts=cycle.payouts.slice(cycle.index,cycle.index+3);
      if(payouts.length)await this.automatic(mint,'payout',(d,l)=>this.adapter.preparePayout({wallet:d.authority.address,launch:l,source:l.creatorAuthority,payouts}),{payouts,cycleId:cycle.id,cycleIndex:cycle.index});
    }catch(error){
      // Never persist raw RPC exceptions, which may embed credential-bearing URLs.
      await this.locked(async()=>{const d=await this.load(),l=d.launches.find(l=>l.mint===mint);if(!l)return;if(protocolCollectionActive(l)){const request=l.protocolCollection;if(error?.code==='ADMIN_ACCESS_REQUIRED'){request.status='failed';request.reason='Administrator access changed. Request protocol collection again from an active administrator.';}else{request.attempt=(request.attempt||0)+1;request.retryAt=this.now()+Math.min(300000,15000*2**Math.min(request.attempt,5));request.reason='Protocol collection is waiting for verified chain data or service gas and will retry.';}}else if(heldSolActive(l)&&error?.code==='ADMIN_ACCESS_REQUIRED'){if(!d.operations.some(op=>op.mint===mint&&blocksWorker(op)))abortHeldSolDistribution(l,this.now());}else if(heldSolActive(l)&&error?.code==='HELD_SOL_INTEGRITY'){if(!d.operations.some(op=>op.mint===mint&&blocksWorker(op))){const request=l.heldSolDistribution;request.status='failed';request.completedAt=this.now();request.reason='Held SOL distribution requires administrator review. Saved balances and payout obligations were left unchanged.';delete request.retryAt;l.heldSolDistributionHistory=[...(l.heldSolDistributionHistory||[]),copy(request)];}}else if(heldSolActive(l)){const request=l.heldSolDistribution;request.attempt=(request.attempt||0)+1;request.retryAt=this.now()+Math.min(300000,15000*2**Math.min(request.attempt,5));request.reason='Held SOL distribution is waiting for a verified RPC response or reward gas; the saved request will retry.';}else{const attempt=(l.retry?.attempt||0)+1;l.retry={attempt,at:this.now()+Math.min(300000,15000*2**Math.min(attempt,5)),reason:gasShortfallReason(error)||'Waiting for a verified RPC response or migration/reward gas. Automatic retry scheduled.'};}await this.save(d);}).catch(()=>{});
    }
  }
}
