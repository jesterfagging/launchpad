import { PublicKey } from '@solana/web3.js';
import { isCurrentLaunch, displayUnits } from '../public/launchpad-model.mjs';
import { signer } from './launchpad-receipts.mjs';
import { quoteLabel } from '../public/quote-identity.mjs';
import { publicRewardRetry, autoRewardEnabled, rewardResumeBlocker } from './launchpad-reward-recovery.mjs';
import { launchArchiveView, setLaunchArchive } from './launchpad-archive.mjs';
import { publicRewardsWallet } from './launchpad-rewards-wallet.mjs';
import { deferredRewardSummary } from './launchpad-native-reward-debts.mjs';
import { feeRecipientRedirectUsed } from './launchpad-fee-routing.mjs';
import { publicHolderTaxBurn } from './launchpad-holder-rewards.mjs';
import { publicTaxMaintenance } from './launchpad-tax-maintenance-status.mjs';
import { MANUAL_REWARD_AUTH_ERROR } from './launchpad-manual-distribution.mjs';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const id = value => { if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) fail('Invalid account or launch ID.'); return value; };
const currentRecipient = launch => launch.input?.recipient || '';
const hasCredit = value => { try { return BigInt(value ?? '0') !== 0n; } catch { return true; } };
const manualRewardWait = launch => {
  const request=launch.manualHolderDistribution;
  return request?.version===1&&request.requestId===launch.holderDistributionAdminRequest&&['queued','processing','waiting','blocked'].includes(request.state)&&(launch.adminRewardHistory||[]).some(event=>event.requestId===request.requestId&&event.action==='distribute'&&event.actorId&&event.launchId===launch.id)&&(['Manual rewards are waiting for SOL and will retry automatically.','Manual rewards will continue after the daily gas budget resets.','Manual rewards are waiting to retry automatically.'].includes(launch.error)||request.state==='blocked'&&request.reason===MANUAL_REWARD_AUTH_ERROR&&launch.error===MANUAL_REWARD_AUTH_ERROR);
};

// No onchain creator is reassigned here. The independently held launch key
// remains the claimant; only Launchpad's verified-fee payout beneficiary changes.
// Payout gas (v71.37): what the admin sees of the sales of the pair asset for payout network costs — the count in the current cycle and today, the last note.
function payoutGasView(launch){
  const ops=(launch.operations||[]).filter(op=>op.kind==='gas-sell'),confirmed=ops.filter(op=>op.state==='confirmed'),last=confirmed.at(-1)||null;
  if(!ops.length&&!launch.payoutGasNote&&!(launch.cycle?.gasSales>0))return null;
  return {applies:launch.input?.feeMode==='holders'&&launch.input?.quoteMint!=='So11111111111111111111111111111111111111112',cycleSales:launch.cycle?.gasSales||0,confirmedSales:confirmed.length,lastSaleAt:last?.confirmedAt||null,lastSaleAmount:last?.amount||null,lastSaleReceipt:last?.receipt?.quoteDelta||null,pending:ops.some(op=>op.state==='pending'),note:typeof launch.payoutGasNote==='string'?launch.payoutGasNote.slice(0,500):''};
}
export function launchRoutingEligibility(launch, { shared = false, mainWallet = false } = {}) {
  if (feeRecipientRedirectUsed(launch)) return { allowed: false, reason: 'This coin’s one-time fee redirect has already been used.' };
  if (!isCurrentLaunch(launch.input) || !launch.curve) return { allowed: false, reason: 'A verified Solana mainnet launch is required.' };
  if (launch.keys?.wallet?.external || !launch.keys?.wallet?.secret) return { allowed: false, reason: 'The connected creator wallet controls these fees. Launchpad cannot reassign them.' };
  if (shared || mainWallet || launch.keys.wallet.address === launch.keys.payer?.address) return { allowed: false, reason: 'This launch uses a shared or personal creator wallet. Per-coin takeover is unavailable.' };
  if (launch.feeCustody !== 'relay') return { allowed: false, reason: 'This older launch has no verified exclusive fee custody. Its fee key may have been exported.' };
  if (launch.feeWalletExportedAt || launch.walletExportedAt || launch.keys.wallet.exportedAt) return { allowed: false, reason: 'The fee key was exported. Exclusive fee routing can no longer be guaranteed.' };
  if (launch.input.gotchi) return { allowed: false, reason: 'Gotchi launches are permanently paired with their Gotchi pot and cannot be redirected.' };
  if (launch.input.agent) return { allowed: false, reason: 'AI Agent launches assign their creator fees to the agent permanently. Pause the agent from the Agents section instead.' };
  if (Number(launch.input.taxBps || 0) !== 0) return { allowed: false, reason: 'Holder transfer-fee launches cannot be redirected while their holder reward obligations remain active.' };
  if (!['live', 'paused'].includes(launch.state)) return { allowed: false, reason: 'Finish or recover this launch before changing its fee recipient.' };
  if ((launch.operations || []).some(op => ['pending', 'awaiting_signature'].includes(op.state)) || launch.cycle || launch.feesRequested) return { allowed: false, reason: 'A fee claim or transaction is in progress. Finish it before changing the recipient.' };
  if (hasCredit(launch.credits?.quote) || hasCredit(launch.credits?.base)) return { allowed: false, reason: 'Existing fee credits must finish distributing before the recipient can change.' };
  return { allowed: true, reason: '' };
}

export function launchRewardAction(launch, { shared=false, mainWallet=false, ownerMatch=false }={}) {
  const kind=launch.input?.feeMode==='holders'?'distribute':launch.input?.feeMode==='buyback'?'buyback':null;
  let reason='';
  if(!kind)reason='This launch sends its fees to the creator.';
  else if(kind!=='distribute'&&['queued','processing'].includes(launch.heldSolDistribution?.state))reason='A held-SOL holder distribution is in progress. Wait for its saved transactions to settle.';
  else if(!isCurrentLaunch(launch.input)||!launch.curve||!launch.authorizedAt)reason='The launch must be verified live before its reward service can run.';
  else if(launch.keys?.wallet?.external||!launch.keys?.wallet?.secret)reason='This launch requires its connected wallet to approve the transaction.';
  else if(!ownerMatch&&(shared||mainWallet||launch.keys.wallet.address===launch.keys.payer?.address||launch.feeCustody!=='relay'))reason='This launch uses a shared or personal wallet. Manage its fees from the owner account.';
  else if(!ownerMatch&&(launch.feeWalletExportedAt||launch.walletExportedAt||launch.keys.wallet.exportedAt))reason='The service wallet key was exported. Manage its fees from the owner account.';
  else if(!['live','paused','error','pending','awaiting_signature'].includes(launch.state))reason='Finish the launch before running its reward service.';
  else if((launch.operations||[]).some(op=>['pending','awaiting_signature'].includes(op.state)&&!['claim','tax','tax-burn','sell','gas-sell','buy','burn','payout','tax-protocol-payout','reward-handoff'].includes(op.kind)))reason='The launch transaction is still being confirmed.';
  if(!reason&&kind==='distribute'&&!manualRewardWait(launch))reason=rewardResumeBlocker(launch);
  const busy=!!launch.cycle||!!launch.feesRequested||['queued','processing'].includes(launch.heldSolDistribution?.state)||(launch.operations||[]).some(op=>['pending','awaiting_signature'].includes(op.state));
  return {kind,allowed:!reason,reason,busy:!reason&&busy,autoFees:launch.autoFees===true};
}
export function launchRewardAutomation(launch,context){
  const action=launchRewardAction(launch,context),enabled=autoRewardEnabled(launch);
  const operation=pendingOperation(launch),pending=!!operation;
  const needed=!!action.kind&&(!enabled||['paused','error'].includes(launch.state)||!!launch.rewardRetry||!!launch.error);
  const reason=action.reason||(launch.manualHolderDistribution?.state==='blocked'?'Use Distribute now to continue this saved manual reward sweep.':'')||(['queued','processing'].includes(launch.heldSolDistribution?.state)?'A held-SOL holder distribution is in progress. Wait for its saved transactions to settle.':'')||(manualRewardWait(launch)?'':rewardResumeBlocker(launch));
  const pause=launchRewardPause(launch);
  const status=operation?.state==='awaiting_signature'?'awaiting_signature':operation?'confirming':!enabled?'paused':['paused','error'].includes(launch.state)||reason?'blocked':launch.rewardRetry?'retrying':launch.cycle||launch.feesRequested?'working':'enabled';
  return {allowed:!reason,enabled,status,reason,pending,needed,pauseAllowed:pause.allowed,pauseReason:pause.reason,pauseNeeded:enabled||launch.feesRequested===true||['queued','processing','waiting'].includes(launch.manualHolderDistribution?.state)||['queued','processing'].includes(launch.heldSolDistribution?.state)};
}
// Stopping new service work requires no signing key and must remain available
// during retries, pending receipts, migration or a held-SOL payout batch.
export function launchRewardPause(launch){
  let reason='';
  if(!['holders','buyback'].includes(launch.input?.feeMode))reason='This launch does not run a managed reward service.';
  else if(!isCurrentLaunch(launch.input)||!launch.curve||!launch.authorizedAt)reason='A confirmed Solana mainnet reward launch is required.';
  else if(['draft','failed','archived','stopping'].includes(launch.state))reason='This launch does not have an active reward service to pause.';
  return {allowed:!reason,reason};
}
const creditAmount=(value,decimals)=>{try{if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isInteger(decimals)||decimals<0||decimals>18)return null;return displayUnits(value,decimals);}catch{return null;}};
function pendingOperation(launch) {
  const operations = Array.isArray(launch.operations) ? launch.operations : [];
  // Wallet approval blocks the worker before it reconciles the first signed
  // pending receipt. Expose only that active step, never transaction bytes.
  const operation = operations.find(op => op.state === 'awaiting_signature') || operations.find(op => op.state === 'pending');
  if (!operation) return null;
  return {
    kind: typeof operation.kind === 'string' ? operation.kind.slice(0, 64) : '',
    state: operation.state,
    signature: typeof operation.signature === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(operation.signature) ? operation.signature : '',
    createdAt: Number.isSafeInteger(operation.createdAt) && operation.createdAt >= 0 && operation.createdAt <= 8640000000000000 ? operation.createdAt : null,
    reason: typeof operation.receiptNote === 'string' ? operation.receiptNote.slice(0, 300) : '',
  };
}

function manualDistributionView(launch) {
  const request=launch.manualHolderDistribution;
  if(!request||request.version!==1||typeof request.requestId!=='string'||!/^[a-f0-9]{32}$/.test(request.requestId)||!['queued','processing','waiting','blocked','completed','partial','cancelled','no_funds'].includes(request.state))return null;
  let remainingBase=null;try{if(/^\d+$/.test(request.remainingBaseUnits)&&/^\d+$/.test(request.remainingTaxBaseUnits))remainingBase=displayUnits((BigInt(request.remainingBaseUnits)+BigInt(request.remainingTaxBaseUnits)).toString(),6);}catch{}
  return {requestId:request.requestId,state:request.state,phase:['existing','collect','convert','payout','distribute','done'].includes(request.phase)?request.phase:'',reason:typeof request.reason==='string'?request.reason.slice(0,300):'',remainingBase,remainingQuote:creditAmount(request.remainingQuoteUnits,launch.review?.quoteDecimals),distributedQuote:creditAmount(request.distributedQuoteUnits,launch.review?.quoteDecimals)};
}

export function launchAdminRow(account, launch, context) {
  const deferred=deferredRewardSummary(launch);
  return {
    accountId: account.id, username: account.username, id: launch.id, network: isCurrentLaunch(launch.input) ? 'mainnet-beta' : '',
    ...launchArchiveView(launch),
    name: launch.input?.name || '', symbol: launch.input?.symbol || '', mint: launch.keys?.mint?.address || '',
    quoteMint: launch.input?.quoteMint || '', quoteSymbol: quoteLabel(launch.input?.quoteMint,launch.review?.quoteSymbol,launch.input?.quoteSymbol),
    recipient: currentRecipient(launch), feeMode: launch.input?.gotchi ? 'gotchi' : launch.input?.paycheck?.policy === 'paycheck-v1' ? 'paycheck' : launch.input?.feeMode || '', gotchi: launch.input?.gotchi ? { id: launch.input.gotchi.id, theme: launch.input.gotchi.theme, vault: launch.input.gotchi.vault } : null, feeCustody: launch.feeCustody || 'legacy',
    feeWallet: launch.keys?.wallet?.address || '', rewardsWallet:publicRewardsWallet(launch), taxBurn:publicHolderTaxBurn(launch), state: launch.state, createdAt: launch.createdAt,
    eligibility: launchRoutingEligibility(launch, context),
    serviceError:typeof launch.error==='string'?launch.error.slice(0,500):'',serviceStage:launch.cycle?.stage||'',payoutGas:payoutGasView(launch),pendingOperation:pendingOperation(launch),rewardRetry:publicRewardRetry(launch),taxMaintenance:publicTaxMaintenance(launch,{includeReason:true}),
    deferredRewards:deferred===null?{unavailable:true}:{wallets:deferred.wallets,amount:displayUnits(deferred.amountUnits,9)},
    manualHolderDistribution:manualDistributionView(launch),
    rewardsAction:launchRewardAction(launch,context),rewardsAutomation:launchRewardAutomation(launch,context),credits:{quote:creditAmount(launch.credits?.quote,launch.review?.quoteDecimals),base:creditAmount(launch.credits?.base,6)},
    rewardHistory:(launch.adminRewardHistory||[]).slice(-20).map(event=>({at:event.at,actor:event.actor,action:event.action,reason:event.reason,status:event.status})).reverse(),
    history: (launch.feeRecipientHistory || []).slice(-20).map(event => ({
      at: event.at, actorId: event.actorId, actor: event.actor, from: event.from, to: event.to,
      fromMode: event.fromMode, toMode: event.toMode, reason: event.reason,
    })).reverse(),
  };
}

export class LaunchpadAdmin {
  constructor({ launchpad, accounts, pumpPublic = null, meteora = null, now = Date.now }) { this.launchpad = launchpad; this.accounts = accounts; this.pumpPublic=pumpPublic; this.meteora=meteora; this.now = now; }
  async requireAdmin(actorId) {
    const actor = await this.accounts.get(id(actorId));
    if (actor?.role !== 'admin' || actor.banned) fail('Administrator access required.', 403);
    if (!actor.mfaEnabled) fail('Enable two-factor authentication before using administration.', 403);
    return actor;
  }
  async inventory(override, actorId) {
    const accounts = await this.accounts.list(), launches = [], counts = new Map(), mainWallets = new Set(accounts.map(a => a.mainWallet));
    // Bounded concurrency avoids a large burst of file reads on a busy host.
    for (let index = 0; index < accounts.length; index += 8) {
      const batch = accounts.slice(index, index + 8);
      const books = await Promise.all(batch.map(a => override?.accountId === a.id ? override.book : this.launchpad.book(a.id)));
      books.forEach((book, n) => {
        for (const launch of book.launches || []) {
          launches.push({ account: batch[n], launch });
          const wallet = launch.keys?.wallet?.address;
          if (wallet) counts.set(wallet, (counts.get(wallet) || 0) + 1);
        }
      });
    }
    if(actorId&&this.pumpPublic?.adminInventory)launches.push(...await this.pumpPublic.adminInventory(actorId));
    if(actorId&&this.dammPump?.adminInventory)launches.push(...await this.dammPump.adminInventory(actorId));
    if(actorId&&this.meteora?.adminInventory)launches.push(...await this.meteora.adminInventory(actorId));
    if(actorId&&this.pumpClassic?.adminInventory)launches.push(...await this.pumpClassic.adminInventory(actorId));
    if(actorId&&this.robinhoodLaunch?.adminInventory)launches.push(...await this.robinhoodLaunch.adminInventory(actorId));
    return { launches, context: launch => ({ shared: counts.get(launch.keys?.wallet?.address) > 1, mainWallet: mainWallets.has(launch.keys?.wallet?.address) }) };
  }
  async visibility(actorId,{accountId:ownerId,id:launchId,hidden,reason}={}){
    await this.requireAdmin(actorId);id(ownerId);id(launchId);
    if(typeof hidden!=='boolean'||typeof reason!=='string'||reason.trim().length<5||reason.length>500)fail('Provide a visibility action and a reason (5–500 characters).');
    return this.launchpad.locked(ownerId,async book=>{
      await this.requireAdmin(actorId);const launch=this.launchpad.find(book,launchId);
      const event={hidden,reason:reason.trim(),actorId,at:this.now()};launch.moderation=event;
      launch.moderationHistory=[...(launch.moderationHistory||[]),event];await this.launchpad.save(ownerId,book);
      return {hidden,id:launchId};
    });
  }
  async archive(actorId,{accountId:ownerId,id:launchId,archived}={}){
    await this.requireAdmin(actorId);id(ownerId);id(launchId);
    if(typeof archived!=='boolean')fail('Choose whether to archive or restore this request.');
    return this.launchpad.locked(ownerId,async book=>{
      const account=await this.accounts.get(ownerId);
      if(!account)fail('The launch account was not found.',404);
      const launch=this.launchpad.find(book,launchId),{context}=await this.inventory({accountId:ownerId,book});
      await this.requireAdmin(actorId);
      if(setLaunchArchive(launch,{archived,actorId,at:this.now()}))await this.launchpad.save(ownerId,book);
      return {launch:launchAdminRow(account,launch,{...context(launch),ownerMatch:ownerId===actorId})};
    });
  }
  async list(actorId, { search = '', offset = 0, limit = 20, eligibleOnly = false, view = 'active' } = {}) {
    await this.requireAdmin(actorId);
    if (typeof search !== 'string' || search.length > 128) fail('Search must be 128 characters or fewer.');
    if(!['active','archived','all'].includes(view))fail('Choose an active or archived launch view.');
    offset = Number(offset); limit = Number(limit);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) fail('Invalid launch page.');
    const { launches, context } = await this.inventory(undefined,actorId), query = search.trim().toLowerCase();
    const matched = launches.filter(({ account, launch, adminRow }) => (!query || [account.username, account.id, launch.id, launch.input?.name, launch.input?.symbol, launch.keys?.mint?.address, currentRecipient(launch)].some(value => String(value || '').toLowerCase().includes(query))) && (!(eligibleOnly === true || eligibleOnly === 'true') || (adminRow?.eligibility||launchRoutingEligibility(launch, context(launch))).allowed));
    const counts={active:0,archived:0};for(const {launch,adminRow} of matched)counts[(adminRow||launchArchiveView(launch)).listArchived?'archived':'active']++;
    const filtered=matched.filter(({launch,adminRow})=>view==='all'||(adminRow||launchArchiveView(launch)).listArchived===(view==='archived'));
    filtered.sort((a, b) => (b.launch.createdAt || 0) - (a.launch.createdAt || 0) || a.launch.id.localeCompare(b.launch.id));
    await this.requireAdmin(actorId);
    return { launches: filtered.slice(offset, offset + limit).map(({ account, launch, adminRow }) => adminRow||launchAdminRow(account, launch, {...context(launch),ownerMatch:account.id===actorId})), total: filtered.length, counts, view, offset, limit, nextOffset: offset + limit < filtered.length ? offset + limit : null };
  }
  async update(actorId, { accountId, id: launchId, recipient, expectedRecipient, reason, expectedMode } = {}) {
    await this.requireAdmin(actorId); id(accountId); id(launchId);
    if (typeof expectedRecipient !== 'string') fail('Refresh the launch before changing its fee recipient.');
    if (typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 500) fail('Enter a takeover reason between 5 and 500 characters.');
    let address;
    try { address = new PublicKey(typeof recipient === 'string' ? recipient.trim() : ''); if (!PublicKey.isOnCurve(address.toBytes())) throw Error(); } catch { fail('Enter a valid Solana wallet address for the recipient.'); }
    const destination = address.toBase58();
    return this.launchpad.locked(accountId, async book => {
      const actor = await this.requireAdmin(actorId), account = await this.accounts.get(accountId);
      if (!account) fail('The launch account was not found.', 404);
      const launch = this.launchpad.find(book, launchId), { context } = await this.inventory({ accountId, book });
      const eligibility = launchRoutingEligibility(launch, context(launch));
      if (!eligibility.allowed) fail(eligibility.reason, 409);
      if (currentRecipient(launch) !== expectedRecipient || expectedMode !== undefined && expectedMode !== launch.input.feeMode) fail('The fee recipient changed. Refresh before trying again.', 409);
      if (destination === launch.keys.wallet.address || destination === launch.keys.mint.address) fail('Choose the community recipient wallet, not an internal launch address.');
      if (destination === expectedRecipient && launch.input.feeMode === 'creator') fail('This wallet already receives the creator fees.');
      let key;
      try { key = signer(launch.keys.wallet.secret); if (key.publicKey.toBase58() !== launch.keys.wallet.address) throw Error(); } catch { fail('The stored fee signer is unavailable. Restore the launch data before changing its recipient.', 409); } finally { key?.secretKey.fill(0); }
      // Recheck role after all asynchronous reads and immediately before commit.
      await this.requireAdmin(actorId);
      const audit = { at: this.now(), actorId, actor: actor.username, from: currentRecipient(launch), to: destination, fromMode: launch.input.feeMode, toMode: 'creator', reason: reason.trim() };
      launch.feeRecipientHistory = [...(launch.feeRecipientHistory || []), audit];
      launch.feeRecipientRedirectedAt = audit.at;
      launch.input.recipient = destination; launch.input.feeMode = 'creator';
      await this.launchpad.save(accountId, book);
      return { launch: launchAdminRow(account, launch, {...context(launch),ownerMatch:account.id===actorId}), audit };
    });
  }
}
